/**
 * src/brain/duplicate-checks.js — what "Find duplicate pages" remembers.
 *
 * WHY. A scan checked the top N candidate pairs and forgot every answer, so on
 * a large domain it re-judged (and re-billed) nearly the same pairs for ever.
 * Measured on a 3,407-page domain: 36,333 candidates, 500 per scan, 460 of the
 * next scan's 500 already judged.
 *
 * IT IS A CACHE. One JSON file per domain at paths.js getDuplicateChecksDir(),
 * in the user-data dir, OUTSIDE domains/ — so it is never synced, and the wiki
 * stays untouched by a scan ("AI Health is READ-ONLY"). Losing or corrupting it
 * costs money, never data: every read here degrades to "nothing checked yet"
 * and nothing here throws on a bad file.
 *
 * WHAT MAKES AN ANSWER APPLY: the same two pages (folder + slug, either order),
 * the same provider + model, the same instructions to the model, and the same
 * two openings the model actually read. Change any of them and the pair is
 * checked again.
 *
 * WHAT ALSO LIVES HERE: the deterministic spelling-variant test. Batch merge
 * DELETES pages, so its eligibility cannot depend on anything a model said
 * alone, and the view never carries a second copy of the rule — the server
 * sends the verdict of this function on each pair.
 *
 * Reachable from mcp/: nothing here may write to stdout.
 */
import { createHash } from 'crypto';
import { readFile, mkdir, rm } from 'fs/promises';
import path from 'path';
import { getDuplicateChecksDir } from './paths.js';
import { writeFileAtomic } from './atomic-write.js';

const FORMAT = 1;
const FIRST_PARA_MAX = 500; // per-page opening sent to the model

/**
 * Whether a page name can be previewed, merged and linked to. Real pages are
 * named claude-opus-4.6, talirezun.com and foo_bar, so this says what a name may
 * NOT be rather than listing what it may: nothing that can leave its folder (a
 * slash, a backslash, "..", a leading dot, a control character), and nothing a
 * [[wikilink]] cannot carry (| [ ] #, or a space at either end), because a merge
 * has to repoint links to it. The path is still resolved inside the wiki after
 * this (resolveInsideWiki). The candidate list uses the same test, so a pair that
 * could never merge is never offered.
 */
export function isMergeableSlug(slug) {
  if (typeof slug !== 'string' || slug.length === 0 || slug.length > 240) return false;
  if (slug !== slug.trim() || slug.startsWith('.') || slug.includes('..')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[/\\|[\]#\u0000-\u001f\u007f]/.test(slug);
}

/** The opening of a page: what the model reads, and so what an answer is bound to. */
export function pageOpening(content) {
  let body = String(content);
  if (body.startsWith('---')) {
    const closeIdx = body.indexOf('\n---', 3);
    if (closeIdx !== -1) body = body.slice(closeIdx + 4).trimStart();
  }
  body = body.replace(/^#\s+.*\n/, '').trimStart();
  return body.slice(0, FIRST_PARA_MAX).replace(/\s+/g, ' ').trim();
}

/**
 * Order-insensitive identity of a pair. FOLDERS ARE PART OF IT: entities/x and
 * concepts/x are different pages, so a slug pair alone would apply one page's
 * answer to another.
 */
export function pairKey(folderA, slugA, folderB, slugB) {
  const a = folderA + '/' + slugA;
  const b = folderB + '/' + slugB;
  return a < b ? a + '||' + b : b + '||' + a;
}

/** sha256 of both openings, in the key's own order, so A/B and B/A agree. */
export function openingsHash(folderA, slugA, openingA, folderB, slugB, openingB) {
  const aFirst = (folderA + '/' + slugA) < (folderB + '/' + slugB);
  const [x, y] = aFirst ? [openingA, openingB] : [openingB, openingA];
  return createHash('sha256').update(String(x)).update('\0').update(String(y)).digest('hex');
}

function fileFor(domain) {
  const name = encodeURIComponent(String(domain));
  // encodeURIComponent leaves dots alone; "." and ".." are the only names that
  // could still leave the folder. Domains are validated long before this.
  if (!name || name === '.' || name === '..') return null;
  return path.join(getDuplicateChecksDir(), name + '.json');
}

/** Every remembered answer for a domain, as a Map. A missing or bad file is an empty Map. */
export async function loadDuplicateChecks(domain) {
  const file = fileFor(domain);
  if (!file) return new Map();
  let raw;
  try { raw = await readFile(file, 'utf8'); } catch { return new Map(); }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.format !== FORMAT || !parsed.pairs || typeof parsed.pairs !== 'object' || Array.isArray(parsed.pairs)) {
      return new Map();
    }
    const out = new Map();
    for (const [key, rec] of Object.entries(parsed.pairs)) {
      if (isUsableRecord(rec)) out.set(key, rec);
    }
    return out;
  } catch {
    return new Map();
  }
}

function isUsableRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (typeof rec.openings !== 'string' || typeof rec.model !== 'string') return false;
  if (rec.verdict === 'no') return true;
  return rec.verdict === 'yes'
    && typeof rec.keep === 'string' && typeof rec.remove === 'string'
    && (rec.confidence === 'high' || rec.confidence === 'medium');
}

/**
 * Add answers to the domain's file, atomically. RE-READS first, so a scan in
 * another process (the MCP beside the app) keeps what it saved — the only way
 * two writers lose anything is by saving in the same few milliseconds, and that
 * costs one re-check. Never throws: a scan must not fail because a cache could
 * not be written. Returns whether it saved.
 */
export async function saveDuplicateChecks(domain, newRecords) {
  const file = fileFor(domain);
  if (!file || !newRecords || newRecords.size === 0) return false;
  try {
    const all = await loadDuplicateChecks(domain);
    for (const [key, rec] of newRecords) all.set(key, rec);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify({ format: FORMAT, pairs: Object.fromEntries(all) }) + '\n');
    return true;
  } catch (err) {
    process.stderr.write(`[duplicate-checks] could not save ${domain}: ${err && err.message}\n`);
    return false;
  }
}

/** Forget this domain's answers, and only this domain's. Dismissals live in the wiki and are untouched. */
export async function forgetDuplicateChecks(domain) {
  const file = fileFor(domain);
  if (!file) return;
  await rm(file, { force: true });
}

/**
 * The comparison key for a name: lower-case, separators gone — EXCEPT a
 * separator between two digits, which is kept as a mark. `gpt-4-1` and `gpt-41`
 * are different products that only look alike without it, while `gpt-4-1` and
 * `gpt_4_1` are still the same spelling.
 */
function nameKey(slug) {
  return String(slug).toLowerCase()
    .replace(/(\d)[-_\s]+(?=\d)/g, '$1|')
    .replace(/[-_\s]+/g, '');
}

/** Whether `longer` is the plural of `shorter` by a final s / es. Deliberately narrow: it can open a page-deleting batch. */
function isPluralOf(longer, shorter) {
  if (/\d$/.test(shorter)) return false; // iphone-14 / iphone-14s
  if (longer === shorter + 's') {
    return shorter.length >= 4 && !shorter.endsWith('s'); // new / news, clas / class
  }
  if (longer === shorter + 'es') {
    return shorter.length >= 3 && /(s|x|z|ch|sh|o)$/.test(shorter); // class / classes, not cas / cases
  }
  return false;
}

/**
 * The spelling-variant test: the same name apart from separators and case,
 * optionally differing by a final plural on the last token.
 *   hand-off / handoff, e-mail / email, neural-network / neural-networks → true
 *   gemini / gemini-3-flash, context / contextual-outcomes, gpt-4-1 / gpt-41 → false
 * It says the NAMES match, not that the pages do: batch eligibility also needs
 * a high-confidence answer about the pages' text.
 */
export function isSpellingVariant(slugA, slugB) {
  if (slugA === slugB) return false;
  const a = nameKey(slugA);
  const b = nameKey(slugB);
  if (!a || !b) return false;
  return a === b || isPluralOf(a, b) || isPluralOf(b, a);
}

/**
 * What the app itself can say about two page NAMES, computed here and sent with
 * every pair so no view carries a copy of the rule. It replaces a model's opinion
 * of itself on screen; it is not a merge gate (batch eligibility is
 * isSpellingVariant plus a remembered answer).
 *   'spelling-variant'  the same name apart from separators, case, a narrow plural
 *   'version-differs'   the same words with different numbers in them:
 *                       claude-opus-4.6 / claude-opus-4.7, gpt-4-1 / gpt-41, gemini / gemini-3
 *   'different-names'   everything else, including iphone-14 / iphone-14s and gpt-4 / gpt-4o,
 *                       whose letters differ
 * The words are compared after removing digits and separators; an empty remainder
 * (2024 / 2025) says nothing about the words, so it is 'different-names'.
 */
export function nameRelation(slugA, slugB) {
  if (isSpellingVariant(slugA, slugB)) return 'spelling-variant';
  const parts = (slug) => {
    const s = String(slug).toLowerCase();
    return { words: s.replace(/[\d\W_]+/g, ''), numbers: (s.match(/\d+/g) || []).map((d) => d.replace(/^0+(?=\d)/, '')).join('.') };
  };
  const a = parts(slugA);
  const b = parts(slugB);
  return a.words && a.words === b.words && a.numbers !== b.numbers ? 'version-differs' : 'different-names';
}

/**
 * Index pairs of spelling variants among `slugs`, in linear time. Both candidate
 * passes usually find these anyway; this makes sure they are always candidates.
 */
export function spellingVariantIndexPairs(slugs) {
  const byKey = new Map();
  slugs.forEach((slug, i) => {
    const k = nameKey(slug);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const out = [];
  slugs.forEach((slug, i) => {
    const k = nameKey(slug);
    for (const form of [k, k + 's', k + 'es']) {
      for (const j of byKey.get(form) || []) {
        if (j !== i && (form !== k || j > i) && isSpellingVariant(slug, slugs[j])) out.push([Math.min(i, j), Math.max(i, j)]);
      }
    }
  });
  return out;
}

/**
 * Index pairs where a short single-word slug of 3+ letters equals the initials
 * of a multi-word slug (rag / retrieval-augmented-generation), in linear time.
 * Initials are tried with and without the small words: world-of-warcraft
 * answers to wow, and bank-of-new-york-mellon to bnym as well as bonym.
 */
export function acronymIndexPairs(slugs, stopwords) {
  const byInitials = new Map();
  const add = (initials, i) => {
    if (initials.length < 3 || !/^[a-z]+$/.test(initials)) return;
    if (!byInitials.has(initials)) byInitials.set(initials, new Set());
    byInitials.get(initials).add(i);
  };
  slugs.forEach((slug, i) => {
    const tokens = String(slug).toLowerCase().split(/[-_\s]+/).filter(Boolean);
    if (tokens.length < 3) return;
    add(tokens.map((t) => t[0]).join(''), i);
    const content = tokens.filter((t) => !stopwords.has(t));
    if (content.length !== tokens.length) add(content.map((t) => t[0]).join(''), i);
  });
  const out = [];
  slugs.forEach((slug, i) => {
    const s = String(slug).toLowerCase();
    if (!/^[a-z]{3,}$/.test(s)) return;
    for (const j of byInitials.get(s) || []) out.push([Math.min(i, j), Math.max(i, j)]);
  });
  return out;
}
