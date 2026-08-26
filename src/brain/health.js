/**
 * src/brain/health.js
 *
 * Wiki Health — structural validation + repair.
 *
 * scanWiki(domain)  → pure scanner. Reads the wiki and returns a report of
 *                     structural issues: broken links, orphans, folder-prefix
 *                     violations, cross-folder duplicates, hyphen variants,
 *                     missing summary→entity backlinks.
 *
 * fixIssue(domain, type, issue?)  → applies a single repair, or all repairs
 *                                   of one type when issue is omitted.
 *
 * This module is the single source of truth used by both the /api/health
 * route and (in the future) the CLI repair scripts.
 */
import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { wikiPath, injectSingleBacklink, injectRelatedLink } from './files.js';
import { loadDismissed, filterDismissed } from './health-dismissed.js';
import { writeFileAtomic } from './atomic-write.js';
// Path chokepoint — see the comment above the fix handlers below. Imported,
// not re-implemented: this module and wiki-read.js each had their own copy,
// and only one of them ever got hardened (v3.2.0 audit finding H1).
import { resolveInsideWiki } from './wiki-read.js';
// The lexical-variant gate, IMPORTED rather than re-implemented (v3.9.1). It
// used to run only in the planner, so `applyBrokenLinkFixes` — which takes its
// plan from the client — applied whatever retarget it was handed. A second
// hand-maintained copy of a safety gate is the v3.2.0 CRITICAL, so this is the
// one implementation, reached from both sides. health-ai.js already imports
// this module, so the cycle is not new: wiki-read.js ↔ health.js has shipped
// the same shape for several releases. Nothing here runs at module scope, and
// `isLexicalVariant` is a hoisted function declaration, so neither entry order
// can observe a partially-initialised binding.
import { isLexicalVariant, buildLinkResolver } from './health-ai.js';

const ARTICLE_PREFIX_RE = /^(the|a|an)-/;
// Honorific prefixes — same set writePage's Pass A and the ingest validator
// recognise. Optional period covers the "dr.-tali-rezun" variant produced
// when the LLM preserves the dot from "Dr." (v3.0.1-beta.2). Stripping this
// in normKey lets the hyphen-variant Health pass detect `dr.-tali-rezun.md`
// and `tali-rezun.md` as the same logical entity and offer a merge.
const HONORIFIC_PREFIX_RE = /^(dr|mr|ms|mrs|prof|professor)\.?-/;

/**
 * `resolveInsideWiki(wikiDir, candidate)` — resolve a relative wiki path
 * against `wikiDir` and refuse anything that escapes that root, returning
 * the absolute path or null. It now lives in ./wiki-read.js and is IMPORTED
 * above; the implementation and its full rationale are documented there.
 *
 * Why it moved (v3.2.0): this module and wiki-read.js each carried an
 * identical, purely LEXICAL copy — `path.resolve` + `path.relative`, no
 * `realpath`, no `lstat`. Both refused a path whose STRING escaped; neither
 * checked what the path POINTED AT. That was reproduced as a read leak in
 * wiki-read.js, but the consequence HERE is strictly worse, because these
 * handlers are destructive: `fixCrossFolderDupe` calls `rm()` on
 * `issue.remove` and `fixHyphenVariant` calls `rm()` on each duplicate.
 * `rm` on a symlinked FILE only unlinks the link, but a symlinked
 * DIRECTORY inside wiki/ (e.g. wiki/concepts → /elsewhere) makes
 * `concepts/victim.md` resolve lexically in-bounds while the syscall lands
 * on a real outside file — deletion, not just disclosure. The same applies
 * to the `writeFileAtomic` calls: atomic-write.js lstats only the FINAL
 * component, so it refuses a symlinked target file but cannot see a
 * symlinked ancestor directory. Both shapes are now refused before any
 * handler touches the filesystem.
 *
 * Hardening context this replaces (v2.5.2+): the in-app Health UI feeds
 * fixIssue with scan-derived paths (always relative, always inside wiki/),
 * but the MCP fix_wiki_issue tool accepts an LLM-crafted issue object — a
 * confused or hostile model can pass `{keep: "...", remove:
 * "../../../tmp/victim"}`. Routing every issue path through this gate before
 * touching the filesystem is the requirement; only the implementation is now
 * shared instead of duplicated.
 *
 * ── WHY `wikiFile()` BELOW EXISTS, AND WHY YOU MUST USE IT ────────────────
 *
 * The sentence above used to read "Every fix handler routes its issue paths
 * through this gate". It was false when it was written, and it had been
 * false since v2.5.2. THREE destructive handlers built their paths with a
 * bare `path.join(wikiDir, folder, slug + '.md')` and never called the gate
 * at all — `fixSemanticDuplicate` (which `rm()`s a file), `fixOrphanLink`
 * and `applyOrphanRescue` (which both write into one). A fourth,
 * `previewSemanticDuplicateMerge`, took `keepFolder` straight from the
 * request body with no validation whatsoever, so a plain `"../../.."`
 * returned the contents of an arbitrary file to the caller — no symlink
 * required. All four were reproduced end-to-end before this fix.
 *
 * That is the lesson, not the four bugs: a rule enforced by "every handler
 * remembers to call the gate" decays silently, and a docblock asserting the
 * rule holds is what stops the next reviewer from checking. So the rule is
 * now structural instead of remembered:
 *
 *   `wikiFile(wikiDir, ...segments)` is the ONLY way this module turns a
 *   wiki-relative path into an absolute one. There is no remaining
 *   `path.join(wikiDir, …)` in this file.
 *
 * WHAT THE GUARD ENFORCES, AND WHAT IT DOES NOT
 *
 * Read the second list as carefully as the first. Two earlier drafts of this
 * comment overclaimed and were both falsified within a day: "every fix
 * handler routes its issue paths through this gate" (false for four years,
 * three handlers), then "a handler cannot now forget the gate" (defeated by
 * `const base = wikiDir;` + concatenation, and again by a bare reassignment
 * `if (!full) full = issue.sourceFile;`). A confident sentence here is what
 * stops the next reviewer from checking, which is the whole failure mode this
 * module's history is made of. So: limits are stated, not implied.
 *
 * ENFORCED — `scripts/test-wiki-page.js` §8c fails the build when health.js:
 *   • calls `resolveInsideWiki` anywhere but inside `wikiFile`;
 *   • gains a second `path.join`, or builds a path with `path.resolve`;
 *   • passes an inline expression to a filesystem call instead of a name;
 *   • BINDS a name that reaches a filesystem call to anything other than a
 *     complete `wikiFile()` / `wikiPath()` call — checked across every
 *     binding form: declaration, bare reassignment, compound assignment
 *     (`+=`, `||=`, `??=`), destructuring (declared or assigned), `for…of`,
 *     `catch` parameter and function parameter. A prefix is not enough:
 *     `wikiFile(…) || issue.path` and `cond ? wikiFile(…) : issue.path` are
 *     both rejected, because every branch must be a producer;
 *   • uses a binding shape the checker does not recognise — unknown shapes
 *     fail rather than being silently permitted, which is the property the
 *     two earlier drafts lacked;
 *   • binds a filesystem primitive to another name, or uses `import()`;
 *   • adds an export, or an AUTO_FIXABLE type, with no escape test.
 *
 * NOT ENFORCED — known, accepted limits:
 *   • It is NAME-SCOPED, not scope-aware: there is no JS parser in this
 *     repo's dependencies. It cannot distinguish a path named `x` from an
 *     unrelated local named `x` in another function. It is sound only because
 *     it refuses names that are bound to both — so the residual cost is a
 *     FALSE POSITIVE (a correctly-gated new handler that reuses an existing
 *     name fails the build and must rename), never a false negative. That is
 *     why the helper in `fixOrphanLink` binds `abs` and not `p`.
 *   • It is SYNTACTIC and covers ONE file. It cannot prove containment in
 *     general, and it says nothing about what another module does with a path
 *     it is handed — which is why calls into `files.js` (`injectRelatedLink`,
 *     `injectSingleBacklink`) are in the checked set: their ARGUMENT is
 *     verified here, their behaviour is not.
 *   • It cannot see through indirection it has not been told about. The
 *     allow-list permits exactly one helper (`at()`), whose body is pinned by
 *     a separate assertion so it cannot be widened by redefinition.
 *
 * Twenty-six bypass shapes were written against it and all twenty-six fail
 * the suite; the last two found (`|| fallback` and a ternary) came from
 * attacking the fix rather than re-running the one shape that was reported,
 * and one negative result should never be read as "the guard is tight".
 *
 * The independent proof is §8b, which is behavioural rather than syntactic:
 * real symlinks, real syscalls, and a byte-level snapshot of every file
 * outside the wiki across every export. §8b and §8c fail for entirely
 * different reasons, which is the property that actually matters.
 */

/**
 * Resolve `segments` (a wiki-relative path, one segment per argument)
 * against `wikiDir`, or return null if the result is not provably inside
 * the wiki — lexically OR physically. The single path constructor for this
 * module; see the block comment above.
 *
 * Returns null (never throws) so callers keep the "silent no-op on invalid
 * input" behaviour every fix handler already had.
 */
function wikiFile(wikiDir, ...segments) {
  for (const s of segments) {
    if (typeof s !== 'string' || s === '') return null;
  }
  return resolveInsideWiki(wikiDir, segments.join('/'));
}

// ── Shared helpers (mirror those in files.js / repair-wiki.js) ──────────────

function extractBulletsFromSection(content, sectionName) {
  const lines = content.split('\n');
  const bullets = [];
  let inSection = false;
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  for (const line of lines) {
    if (re.test(line))                 { inSection = true;  continue; }
    if (inSection && /^##/.test(line)) { inSection = false; }
    if (inSection && line.startsWith('- ')) bullets.push(line);
  }
  return bullets;
}

function dedupKey(line) {
  const linkMatch = line.match(/\[\[([^\]]+)\]\]/);
  if (linkMatch) return linkMatch[1].toLowerCase().trim();
  return line.toLowerCase().trim();
}

function injectBulletsIntoSection(content, sectionName, extraBullets) {
  if (!extraBullets.length) return content;
  const re = new RegExp(`^##\\s+${sectionName}\\s*$`, 'i');
  const lines = content.split('\n');
  const seen = new Set();
  let inSection = false;
  for (const line of lines) {
    if (re.test(line))                 { inSection = true;  continue; }
    if (inSection && /^##/.test(line)) { inSection = false; }
    if (inSection && line.startsWith('- ')) seen.add(dedupKey(line));
  }
  const newBullets = extraBullets.filter(b => !seen.has(dedupKey(b)));
  if (!newBullets.length) return content;

  const sectionExistsRe = new RegExp('^##\\s+' + sectionName + '\\s*$', 'im');
  if (!sectionExistsRe.test(content)) {
    return content.trimEnd() + `\n\n## ${sectionName}\n` + newBullets.join('\n') + '\n';
  }

  const result = [];
  inSection = false;
  let injected = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (re.test(line)) { inSection = true; result.push(line); continue; }
    if (inSection && /^##/.test(line) && !injected) {
      result.push(...newBullets); injected = true; inSection = false;
    }
    result.push(line);
  }
  if (inSection && !injected) result.push(...newBullets);
  return result.join('\n');
}

function mergeBulletSections(canonicalContent, duplicateContent) {
  const SECTIONS = ['Related','Key Facts','Key Ideas','Key Points',
    'Key Takeaways','Entities Mentioned','Concepts Introduced or Referenced',
    'Applications','Examples','Definition','How It Works'];
  let merged = canonicalContent;
  for (const s of SECTIONS) {
    const bullets = extractBulletsFromSection(duplicateContent, s);
    if (bullets.length) merged = injectBulletsIntoSection(merged, s, bullets);
  }
  return merged;
}

/**
 * The `.md` filenames directly inside `wiki/<folder>` — the scan's page
 * inventory for one canonical folder.
 *
 * Takes `(wikiDir, folder)` rather than a pre-joined directory so the only
 * path construction happens through `wikiFile` (see the block comment
 * above). If the folder itself is a symlink pointing outside the wiki, this
 * returns [] instead of listing whatever is over there.
 *
 * That last point is v3.2.0 audit finding M4, and it is why the app used to
 * contradict itself: with `wiki/summaries` symlinked out, `scanWiki` listed
 * the outside pages and reported issues about them, while `getWikiPage`
 * refused to open them and every Health fix silently no-opped
 * (`{fixed: 0, total: 0}`) because the fix handlers that DID call the gate
 * got null. The scan and the reader now agree on the same rule: a path that
 * is not provably inside the wiki is not a page of this wiki.
 *
 * An individual symlinked FILE is filtered the same way — allowed when it
 * points back inside the wiki (a legitimate in-wiki alias), refused when it
 * escapes or dangles.
 */
export async function listMd(wikiDir, folder) {
  const dir = wikiFile(wikiDir, folder);
  if (!dir) return [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.name.endsWith('.md')) continue;
      if (e.isDirectory()) continue;                  // a *directory* named x.md is not a page
      if (e.isSymbolicLink() && !wikiFile(wikiDir, folder, e.name)) continue;
      out.push(e.name);
    }
    return out;
  } catch { return []; }
}

function normKey(slug) {
  return slug
    .replace(HONORIFIC_PREFIX_RE, '')   // dr.-tali-rezun → tali-rezun
    .replace(ARTICLE_PREFIX_RE, '')      // the-curtain → curtain
    .replace(/-/g, '')                   // collapse remaining hyphens
    .toLowerCase();
}

/**
 * Every `.md` file under `rootDir`, recursively — the working set for the
 * domain-wide link rewrites (`fixSemanticDuplicate`, `applyBrokenLinkFixes`)
 * and for the read-only counters.
 *
 * Two containment properties, both load-bearing because callers WRITE to
 * and DELETE the paths this returns:
 *
 *   • Directories are descended only when the dirent is a real directory.
 *     A symlinked directory is never followed, so every directory reached
 *     is physically inside `rootDir` and cycles are impossible. (This was
 *     already true — `Dirent.isDirectory()` is false for a symlink — but it
 *     was incidental; it is now the stated contract.)
 *
 *   • Because of that, the only entry that can escape is a symlinked LEAF,
 *     so only symlinked leaves pay for a containment check. A symlink
 *     resolving back inside the wiki is kept; one escaping or dangling is
 *     dropped, matching `listMd` and `getWikiPage`.
 *
 * `path.join(dir, e.name)` here is NOT a gate bypass: `dir` is already a
 * verified-contained absolute path (it came from `rootDir` or from a real
 * subdirectory of one), and the escaping shape — the symlinked leaf — is
 * the one explicitly checked.
 */
async function walkMdFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      if (e.isSymbolicLink()) {
        const rel = path.relative(rootDir, full);
        if (!wikiFile(rootDir, ...rel.split(path.sep))) continue;
      }
      out.push(full);
    }
  }
  if (existsSync(rootDir)) await walk(rootDir);
  return out;
}

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Scan a domain's wiki and return a structured issue report.
 * Pure — no writes.
 */
export async function scanWiki(domain) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) {
    throw new Error(`No wiki found for domain: ${domain}`);
  }

  const entityFiles  = await listMd(wikiDir, 'entities');
  const conceptFiles = await listMd(wikiDir, 'concepts');
  const summaryFiles = await listMd(wikiDir, 'summaries');

  // Slug sets (bare filename without .md)
  const entitySlugs  = new Set(entityFiles.map(f => f.slice(0, -3)));
  const conceptSlugs = new Set(conceptFiles.map(f => f.slice(0, -3)));
  const summarySlugs = new Set(summaryFiles.map(f => f.slice(0, -3)));

  // Prefix-tolerant lookup for broken-link suggestions
  const allSlugsMap = new Map(); // normKey → { folder: null|'summaries', slug }
  for (const f of entityFiles)  allSlugsMap.set(normKey(f.slice(0,-3)), { folder: null, slug: f.slice(0,-3) });
  for (const f of conceptFiles) {
    const k = normKey(f.slice(0,-3));
    if (!allSlugsMap.has(k))    allSlugsMap.set(k, { folder: null, slug: f.slice(0,-3) });
  }
  for (const f of summaryFiles) {
    const k = normKey(f.slice(0,-3));
    if (!allSlugsMap.has(k))    allSlugsMap.set(k, { folder: 'summaries', slug: f.slice(0,-3) });
  }

  // Incoming-link map: target slug → Set of source file paths (relative to wikiDir)
  const incomingLinks = new Map();

  const brokenLinks = [];
  const folderPrefixLinks = [];

  const allFiles = await walkMdFiles(wikiDir);

  for (const full of allFiles) {
    const relPath = path.relative(wikiDir, full);
    if (relPath === 'index.md' || relPath === 'log.md') continue;

    const content = await readFile(full, 'utf8');
    const links = [...content.matchAll(/\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g)];

    for (const m of links) {
      const raw = m[1].trim();

      // Folder-prefix violations (entities/ or concepts/ — summaries/ is intentional)
      if (raw.startsWith('entities/') || raw.startsWith('concepts/')) {
        folderPrefixLinks.push({ sourceFile: relPath, linkText: raw });
      }

      // Resolve the link's target slug (for incoming-link tracking + broken detection)
      let targetSlug;
      let exists = false;

      if (raw.includes('/')) {
        // e.g. "summaries/foo" or "entities/bar"
        const [folder, slug] = raw.split('/');
        targetSlug = slug;
        if (folder === 'summaries' && summarySlugs.has(slug)) exists = true;
        else if (folder === 'entities' && entitySlugs.has(slug)) exists = true;
        else if (folder === 'concepts' && conceptSlugs.has(slug)) exists = true;
      } else {
        targetSlug = raw;
        if (entitySlugs.has(raw) || conceptSlugs.has(raw)) exists = true;
      }

      if (exists) {
        if (!incomingLinks.has(targetSlug)) incomingLinks.set(targetSlug, new Set());
        incomingLinks.get(targetSlug).add(relPath);
      } else {
        // Try suggestion via prefix-tolerant match
        const hit = allSlugsMap.get(normKey(raw.replace(/^[^/]+\//, '')));
        let suggestedTarget = null;
        if (hit) {
          suggestedTarget = hit.folder ? `${hit.folder}/${hit.slug}` : hit.slug;
          if (suggestedTarget === raw) suggestedTarget = null;
        }
        brokenLinks.push({ sourceFile: relPath, linkText: raw, suggestedTarget });
      }
    }
  }

  // Orphans: entity/concept pages with zero incoming links
  const orphans = [];
  for (const f of entityFiles) {
    const slug = f.slice(0, -3);
    if (!incomingLinks.has(slug)) orphans.push({ path: `entities/${f}`, type: 'entity', slug });
  }
  for (const f of conceptFiles) {
    const slug = f.slice(0, -3);
    if (!incomingLinks.has(slug)) orphans.push({ path: `concepts/${f}`, type: 'concept', slug });
  }

  // Cross-folder duplicates (concepts/X + entities/X where X matches hyphen-normalised)
  const entityNormMap = new Map();
  for (const f of entityFiles) entityNormMap.set(f.replace(/-/g, '').toLowerCase(), f);
  const crossFolderDupes = [];
  for (const cf of conceptFiles) {
    const norm = cf.replace(/-/g, '').toLowerCase();
    const match = entityNormMap.get(norm);
    if (match) {
      crossFolderDupes.push({ keep: `entities/${match}`, remove: `concepts/${cf}` });
    }
  }

  // Hyphen variants within entities/ — groups slugs that normalise to the same
  // key. Uses the shared normKey() (v3.0.1-beta.2: strips honorific prefix too)
  // so "dr.-tali-rezun", "dr-tali-rezun", "talirezun", and "tali-rezun" all
  // collapse to "talirezun" and surface as one variant group.
  const hyphenVariants = [];
  const seenGroups = new Set();
  for (let i = 0; i < entityFiles.length; i++) {
    const stemA = entityFiles[i].slice(0, -3);
    if (seenGroups.has(stemA)) continue;
    const group = [stemA];
    const normA = normKey(stemA);
    for (let j = i + 1; j < entityFiles.length; j++) {
      const stemB = entityFiles[j].slice(0, -3);
      if (seenGroups.has(stemB)) continue;
      const normB = normKey(stemB);
      if (normA === normB) { group.push(stemB); seenGroups.add(stemB); }
    }
    if (group.length > 1) {
      // Canonical selection (v3.0.1-beta.3): prefer slugs without an
      // honorific prefix (dr.-tali-rezun → tali-rezun); among the rest,
      // prefer the form with the most hyphens (wiki convention favors
      // readable "tali-rezun" over "talirezun"); then shortest.
      const canonical = group.slice().sort((a, b) => {
        const hasHon = (s) => HONORIFIC_PREFIX_RE.test(s) ? 1 : 0;
        const diffHon = hasHon(a) - hasHon(b);
        if (diffHon !== 0) return diffHon;       // no-honorific first
        const hy = (s) => (s.match(/-/g) || []).length;
        const diff = hy(b) - hy(a);
        return diff !== 0 ? diff : a.length - b.length;
      })[0];
      hyphenVariants.push({ files: group, suggestedSlug: canonical });
      seenGroups.add(stemA);
    }
  }

  // Missing backlinks: summary mentions entity X (in Entities Mentioned),
  // but X's Related section has no [[summaries/summarySlug]]
  const missingBacklinks = [];
  for (const sf of summaryFiles) {
    const summarySlug = sf.slice(0, -3);
    const summaryAbs = wikiFile(wikiDir, 'summaries', sf);
    if (!summaryAbs) continue;
    const summaryContent = await readFile(summaryAbs, 'utf8');
    const entityBullets = extractBulletsFromSection(summaryContent, 'Entities Mentioned');
    for (const bullet of entityBullets) {
      const m = bullet.match(/\[\[([^\]]+)\]\]/);
      if (!m) continue;
      let name = m[1].trim();
      if (name.includes('/')) name = name.split('/').pop();

      // Resolve to a file (try entities/ first, then concepts/, hyphen-normalised)
      let targetRel = null;
      if (entitySlugs.has(name))      targetRel = `entities/${name}.md`;
      else if (conceptSlugs.has(name)) targetRel = `concepts/${name}.md`;
      else {
        const norm = name.replace(/-/g, '').toLowerCase();
        for (const f of entityFiles) {
          if (f.replace(/-/g, '').toLowerCase() === norm + '.md') { targetRel = `entities/${f}`; break; }
        }
        if (!targetRel) {
          for (const f of conceptFiles) {
            if (f.replace(/-/g, '').toLowerCase() === norm + '.md') { targetRel = `concepts/${f}`; break; }
          }
        }
      }
      if (!targetRel) continue; // broken link — handled separately

      const targetAbs = wikiFile(wikiDir, targetRel);
      if (!targetAbs) continue;
      const targetContent = await readFile(targetAbs, 'utf8');
      const related = extractBulletsFromSection(targetContent, 'Related');
      const hasBacklink = related.some(b => {
        const lm = b.match(/\[\[([^\]]+)\]\]/);
        return lm && lm[1].trim() === `summaries/${summarySlug}`;
      });
      if (!hasBacklink) {
        missingBacklinks.push({ summary: `summaries/${sf}`, entity: targetRel, summarySlug });
      }
    }
  }

  // Apply persistent dismissals (v2.5.1+). Issues the user has previously
  // skipped don't re-surface in the scan. The total dismissed count surfaces
  // in `counts.dismissed` so the UI can show "12 dismissed".
  const { keys: dismissedKeys } = await loadDismissed(domain);

  const filterTypes = [
    ['brokenLinks',       brokenLinks],
    ['orphans',           orphans],
    ['folderPrefixLinks', folderPrefixLinks],
    ['crossFolderDupes',  crossFolderDupes],
    ['hyphenVariants',    hyphenVariants],
    ['missingBacklinks',  missingBacklinks],
  ];
  let totalDismissed = 0;
  const filtered = {};
  for (const [type, issues] of filterTypes) {
    const r = filterDismissed(issues, type, dismissedKeys);
    filtered[type] = r.kept;
    totalDismissed += r.dismissed;
  }

  return {
    domain,
    scannedAt: new Date().toISOString(),
    counts: {
      entities: entityFiles.length,
      concepts: conceptFiles.length,
      summaries: summaryFiles.length,
      dismissed: totalDismissed,
    },
    brokenLinks:       filtered.brokenLinks,
    orphans:           filtered.orphans,
    folderPrefixLinks: filtered.folderPrefixLinks,
    crossFolderDupes:  filtered.crossFolderDupes,
    hyphenVariants:    filtered.hyphenVariants,
    missingBacklinks:  filtered.missingBacklinks,
  };
}

// ── Fix handlers ────────────────────────────────────────────────────────────

/**
 * Auto-fixable issue types. Orphans are always review-only. brokenLinks are
 * auto-fixable per-issue only when a `suggestedTarget` is present; issues
 * without a suggestion fall through as review-only in the UI.
 */
export const AUTO_FIXABLE = new Set([
  'brokenLinks',
  'folderPrefixLinks',
  'crossFolderDupes',
  'hyphenVariants',
  'missingBacklinks',
  // orphanLink is a pseudo-type (v2.4.4+) — never emitted by scanWiki; only
  // used to route a POST /fix that carries an AI orphan suggestion through
  // fixOrphanLink. Keeps the "only fixIssue() writes" invariant intact.
  'orphanLink',
  // semanticDupe is a pseudo-type (v2.4.5+) — never emitted by scanWiki;
  // routes AI-approved semantic-duplicate merges through fixSemanticDuplicate.
  // DESTRUCTIVE: merges + rewrites links across the domain + deletes a file.
  // Phase 3 scan is a separate opt-in flow; see scanSemanticDuplicates in
  // health-ai.js.
  'semanticDupe',
]);

/**
 * The on-disk page inventory, in the exact shapes a `[[wikilink]]` uses.
 *
 * `valid` is the set of legal link targets — a bare entity/concept slug, or
 * `summaries/<slug>`. The three raw slug lists come back too, because
 * `applyBrokenLinkFixes` also needs them to rebuild the deterministic resolver.
 *
 * Built from the gated `listMd`, and shared by `fixBrokenLink` and
 * `applyBrokenLinkFixes` so "does this page exist" has ONE definition. Both
 * used to derive it separately and only one of them checked at all.
 */
async function buildTargetInventory(wikiDir) {
  const listSlugs = async (folder) => (await listMd(wikiDir, folder)).map(f => f.slice(0, -3));
  const [ents, cons, sums] = await Promise.all([listSlugs('entities'), listSlugs('concepts'), listSlugs('summaries')]);
  return { ents, cons, sums, valid: new Set([...ents, ...cons, ...sums.map(s => `summaries/${s}`)]) };
}

/**
 * Retarget one broken `[[link]]` to `issue.suggestedTarget`.
 *
 * `issue` is NOT necessarily scan-emitted: the MCP `fix_wiki_issue` tool hands
 * this an object composed by an LLM. Until v3.9.1 the only check was
 * `if (!issue.suggestedTarget)` — a truthiness test — so a model could retarget
 * links wiki-wide to a page that does not exist, manufacturing the very defect
 * the tool exists to repair. The target must now name a real page.
 *
 * It deliberately does NOT run `isLexicalVariant`. A scan-emitted
 * `suggestedTarget` comes from the scanner's own hyphen/prefix normalisation,
 * which legitimately produces pairs the lexical gate refuses (`[[e-mail]]` →
 * `email` scores Jaccard 0 — no shared token). The gate guards the AI planner's
 * free-form guesses; this path's targets are already deterministic.
 *
 * `validTargets` is an optional prebuilt inventory so the fix-all loop does not
 * re-read the three folders once per issue.
 *
 * RETURNS `{ ok, reason }`, NOT a bare boolean — see the REFUSAL REASONS block
 * above `fixIssue`. The existence check this release added was correct and its
 * signal was not: `false` for "you invented a page that does not exist" was
 * indistinguishable from `false` for "there was nothing left to change", and
 * the MCP rendered both as "the issue may already have been resolved" — telling
 * a model the wiki was fine while the broken link was still on disk.
 */
async function fixBrokenLink(wikiDir, issue, validTargets = null) {
  if (!issue.suggestedTarget) return { ok: false, reason: 'no-suggested-target' };
  const known = validTargets || (await buildTargetInventory(wikiDir)).valid;
  const wanted = String(issue.suggestedTarget).replace(/^(entities|concepts)\//, '');
  if (!known.has(wanted)) return { ok: false, reason: 'target-not-found' };
  const full = wikiFile(wikiDir, issue.sourceFile);
  if (!full || !existsSync(full)) return { ok: false, reason: 'source-file-not-found' };
  const before = await readFile(full, 'utf8');
  const esc = issue.linkText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Allow whitespace inside [[ ... ]] — the scanner trims linkText but the source
  // file may have `[[ Cline]]` or `[[Cline ]]` with stray spaces from LLM output.
  const re = new RegExp(`\\[\\[\\s*${esc}\\s*(\\|[^\\]]+)?\\]\\]`, 'g');
  const after = before.replace(re, (_m, alias) => `[[${issue.suggestedTarget}${alias || ''}]]`);
  // The ONE reason that genuinely means "already resolved": the target exists,
  // the source file exists, and the link is simply not in it any more.
  if (after === before) return { ok: false, reason: 'link-not-present' };
  await writeFileAtomic(full, after, 'utf8');
  return { ok: true, reason: null };
}

async function fixFolderPrefixLink(wikiDir, issue) {
  const full = wikiFile(wikiDir, issue.sourceFile);
  if (!full || !existsSync(full)) return false;
  let content = await readFile(full, 'utf8');
  const before = content;
  content = content.replace(/\[\[(entities|concepts)\/([^\]|#\n]+?)(\|[^\]]+)?\]\]/g,
    (_m, _folder, slug, alias) => `[[${slug}${alias || ''}]]`);
  if (content !== before) await writeFileAtomic(full, content, 'utf8');
  return content !== before;
}

/**
 * Split a scan-emitted wiki reference (`entities/foo.md`) into its folder and
 * slug. Structural validation only — exactly two segments, a canonical
 * folder, a `.md` suffix, and a slug that cannot escape or corrupt a
 * generated regex.
 *
 * Deliberately NOT character-class validated: `entities/petar-urdešić.md` and
 * `entities/snežana-ilić.md` exist in real user wikis today, and an
 * ASCII-only slug rule here would silently refuse to repoint their links
 * while the merge still deleted the file — the exact failure this whole
 * change exists to remove. The slug never becomes a path in
 * `repointInboundLinks` (it is regex-escaped into a pattern), so character
 * restrictions would buy nothing; the caller still builds every real path
 * through `wikiFile()`.
 *
 * @returns {{folder: string, slug: string}|null}
 */
function splitWikiRef(rel) {
  if (typeof rel !== 'string') return null;
  const parts = rel.split('/');
  if (parts.length !== 2) return null;
  const folder = parts[0];
  const file = parts[1];
  if (folder !== 'entities' && folder !== 'concepts' && folder !== 'summaries') return null;
  if (!file.endsWith('.md')) return null;
  const slug = file.slice(0, -3);
  if (!slug || slug.length > 200) return null;
  if (slug === '.' || slug === '..' || slug.includes('\\')) return null;
  // A newline or a link delimiter could never appear in a real `[[wikilink]]`
  // and would produce a nonsense pattern.
  if (/[\r\n\[\]|]/.test(slug)) return null;
  return { folder, slug };
}

/**
 * Repoint every inbound `[[wikilink]]` that targets a page about to be
 * DELETED, so a merge never leaves a dangling link behind.
 *
 * ── WHY THIS IS SHARED, AND WHY THERE IS A TEST THAT COUNTS `rm(` SITES ──
 *
 * Three handlers in this module delete a page after merging it into another:
 * `fixCrossFolderDupe`, `fixHyphenVariant` and `fixSemanticDuplicate`. Until
 * this function existed, only the third repointed links — it carried its own
 * inline copy of this logic ("Step 3"), and the other two simply deleted the
 * file. Measured consequences on real fixtures (all via the real `scanWiki`):
 *
 *   • hyphen variant `dr-tali-rezun` → `tali-rezun`: every `[[dr-tali-rezun]]`
 *     dangled. Reported live by a user as Health going 5 issues → 50.
 *   • cross-folder `concepts/google` → `entities/google` (slug UNCHANGED):
 *     bare `[[google]]` still resolved, but `[[concepts/google]]` did not —
 *     2 new broken links.
 *   • cross-folder `concepts/e-mail` → `entities/email`: `crossFolderDupes`
 *     matches on the hyphen-NORMALISED key, so the slug can change too —
 *     3 new broken links, including the bare form.
 *
 * Both handlers are in `AUTO_FIXABLE` and in `fixAllSafe`'s TYPES, so the
 * "Fix N safe issues" button — labelled as free, local, structural repair —
 * was orphaning links.
 *
 * The defect is not three bugs, it is ONE SHAPE: a guard that lives inside
 * one of several siblings that all perform the same destructive act. That is
 * the shape that produced this module's v3.2.0 CRITICAL (four handlers, one
 * containment gate), and copying "Step 3" into the other two would have
 * reproduced it exactly — three hand-maintained copies instead of two.
 *
 * So the rule is enforced mechanically, not remembered:
 * `scripts/test-health-merge-links.js` enumerates EVERY `await rm(` in this
 * file by brace-matching its enclosing function, and fails the build unless
 * that function calls `repointInboundLinks(` at an earlier offset. A new
 * page-deleting handler that forgets to repoint cannot ship.
 *
 * LIMIT, stated rather than implied: this makes the omission unshippable, not
 * syntactically impossible. `rm` is still called by the handlers, not by this
 * function, because moving it here would mean passing an absolute path as a
 * parameter — and `test-wiki-page.js` §8c's provenance classifier only
 * accepts a path parameter named in its VERIFIED_PARAMS set. Trading a
 * working containment guard for a marginally stronger locality guard is a bad
 * exchange; the enumeration test covers the same ground.
 *
 * @param {string} wikiDir
 * @param {Array<{folder: string, slug: string}>} retired — pages being deleted
 * @param {string} keepSlug   — the surviving page's slug
 * @param {string} keepFolder — the surviving page's folder
 * @returns {Promise<number>} number of files rewritten
 */
async function repointInboundLinks(wikiDir, retired, keepSlug, keepFolder) {
  if (!Array.isArray(retired) || typeof keepSlug !== 'string' || !keepSlug) return 0;

  // A retired page whose slug already equals the survivor's needs no link
  // rewriting — every `[[slug]]` pointing at it still resolves to the kept
  // file. The folder-PREFIXED forms still need repointing, which is why the
  // entry is kept rather than dropped; see the alternation below.
  const seen = new Set();
  const slugs = [];
  for (const r of retired) {
    if (!r || typeof r.slug !== 'string' || !r.slug) continue;
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    slugs.push(r.slug);
  }
  if (slugs.length === 0) return 0;

  // Match `[[X]]`, `[[entities/X]]`, `[[concepts/X]]`, `[[summaries/X]]`,
  // with an optional `|alias` suffix that must be preserved verbatim. The
  // closing `]]` is required immediately after the slug (modulo the padding
  // below), so `[[google-cloud]]` is never matched by a retired `google`.
  //
  // ── WHY THE PADDING ALLOWANCE IS LOAD-BEARING, NOT TIDINESS ───────────
  // scanWiki's own link scan does `m[1].trim()` (see the brokenLinks loop),
  // so `[[ dr-tali-rezun ]]` is a LIVE inbound link as far as the user's
  // Health report is concerned. Without the padding here the repoint simply
  // did not see it, and the page was deleted anyway: measured on the
  // single-type `hyphenVariants` path, broken links went 1 -> 2 with a new
  // `entities/hub.md::dr-tali-rezun` entry. It self-heals under fixAllSafe
  // ONLY because that runs `brokenLinks` last and the suggestion resolver
  // happens to recover the slug — an accident of ordering, not coverage,
  // and the exact masking already labelled at assertion 6.3.
  //
  // `[^\S\n]*` (whitespace EXCEPT newline), not `\s*`, and that is the whole
  // point: it matches precisely what the scanner can see. The scanner's slug
  // class is `[^\]|#\n]`, which admits spaces, tabs and \r but never \n — so
  // `[[foo\n]]` is NOT a link to it, and a `\s*` here would rewrite a
  // construct the scanner never counted, making the two disagree in the
  // opposite direction.
  const WS = '[^\\S\\n]*';
  const alternation = slugs
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const linkRe = new RegExp(
    `\\[\\[${WS}(?:entities/|concepts/|summaries/)?(?:${alternation})${WS}(\\|[^\\]]+)?\\]\\]`,
    'g'
  );
  // Wiki convention (CLAUDE.md): links carry no folder prefix EXCEPT
  // summaries, which live in a subfolder Obsidian needs for routing. Rewriting
  // `[[concepts/google]]` to bare `[[google]]` therefore also clears the
  // folder-prefix violation the old link carried.
  const replacement = keepFolder === 'summaries' ? `summaries/${keepSlug}` : keepSlug;

  // Pages that are about to be unlinked are skipped: writing them would be an
  // atomic temp-file + rename immediately before an `rm`.
  const doomed = [];
  for (const r of retired) {
    if (!r || typeof r.folder !== 'string' || typeof r.slug !== 'string') continue;
    const doomedAbs = wikiFile(wikiDir, r.folder, `${r.slug}.md`);
    if (doomedAbs) doomed.push(doomedAbs);
  }

  const allFiles = await walkMdFiles(wikiDir);
  let changed = 0;
  for (const full of allFiles) {
    const rel = path.relative(wikiDir, full);
    if (rel === 'index.md' || rel === 'log.md') continue;
    if (doomed.some((d) => path.resolve(d) === path.resolve(full))) continue;
    const content = await readFile(full, 'utf8');
    const rewritten = content.replace(linkRe, (_m, alias) => `[[${replacement}${alias || ''}]]`);
    if (rewritten !== content) {
      await writeFileAtomic(full, rewritten, 'utf8');
      changed++;
    }
  }
  return changed;
}

async function fixCrossFolderDupe(wikiDir, issue) {
  // Folder + slug are needed to repoint inbound links before the delete.
  // Refusing an unsplittable reference is fail-safe: nothing is merged and
  // nothing is deleted. The scan always emits `<folder>/<file>.md`; only a
  // hand-crafted MCP `fix_wiki_issue` payload can reach the null branch.
  const keepRef = splitWikiRef(issue && issue.keep);
  const removeRef = splitWikiRef(issue && issue.remove);
  if (!keepRef || !removeRef) return false;

  const keepPath = wikiFile(wikiDir, issue.keep);
  const removePath = wikiFile(wikiDir, issue.remove);
  if (!keepPath || !removePath) return false;
  if (!existsSync(keepPath) || !existsSync(removePath)) return false;

  const keepContent   = await readFile(keepPath, 'utf8');
  const removeContent = await readFile(removePath, 'utf8');

  let merged;
  if (keepContent.length >= removeContent.length) {
    merged = mergeBulletSections(keepContent, removeContent);
  } else {
    merged = mergeBulletSections(removeContent, keepContent);
    // Normalise frontmatter type to match the kept folder (entities/)
    merged = merged.replace(/^type: concept$/m, 'type: entity');
    merged = merged.replace(/type\/concept/g, 'type/entity');
  }

  // Persist the merged body FIRST: repointInboundLinks rewrites files on
  // disk, so a later write of in-memory content would clobber the kept page's
  // own repointed links.
  await writeFileAtomic(keepPath, merged, 'utf8');
  // The slug is often UNCHANGED here (concepts/google → entities/google), but
  // the folder-prefixed form `[[concepts/google]]` still dangles once the
  // concepts file is gone — measured, 2 broken links. And because
  // crossFolderDupes matches on the hyphen-NORMALISED key, the slug CAN
  // change (concepts/e-mail → entities/email), which breaks the bare form
  // too — measured, 3 broken links. Both cases are repointed here.
  await repointInboundLinks(wikiDir, [removeRef], keepRef.slug, keepRef.folder);
  await rm(removePath);
  return true;
}

async function fixHyphenVariant(wikiDir, issue) {
  // Slug regex allows alphanumerics, hyphens, AND single embedded periods —
  // the LLM occasionally produces slugs like "dr.-tali-rezun" by preserving
  // the dot from "Dr." (v3.0.1-beta.3). The explicit `..` + `/` checks below
  // close the path-traversal hole that a permissive character class would
  // otherwise open. `resolveInsideWiki` is the final chokepoint.
  const SLUG_RE = /^[a-z0-9][a-z0-9.\-]*$/i;
  const isSafeSlug = (s) =>
    typeof s === 'string' &&
    !s.includes('..') &&
    !s.includes('/') &&
    !s.includes('\\') &&
    SLUG_RE.test(s);

  const canonical = issue.suggestedSlug;
  if (!isSafeSlug(canonical)) return false;
  const canonPath = wikiFile(wikiDir, 'entities', `${canonical}.md`);
  if (!canonPath || !existsSync(canonPath)) return false;

  let canonContent = await readFile(canonPath, 'utf8');
  const retiredSlugs = [];
  for (const slug of (issue.files || [])) {
    if (slug === canonical) continue;
    if (!isSafeSlug(slug)) continue;
    const dupPath = wikiFile(wikiDir, 'entities', `${slug}.md`);
    if (!dupPath || !existsSync(dupPath)) continue;
    const dupContent = await readFile(dupPath, 'utf8');
    canonContent = mergeBulletSections(canonContent, dupContent);
    retiredSlugs.push(slug);
  }

  // Persist the merged canonical page BEFORE repointing. The merge folds the
  // duplicate's body in, and that body routinely contains links to the
  // duplicate's own slug — writing this after the repoint would reinstate
  // exactly the dangling links the repoint just removed.
  await writeFileAtomic(canonPath, canonContent, 'utf8');

  // This is the case reported live: merging `dr-tali-rezun` into
  // `tali-rezun` changes the slug, so every `[[dr-tali-rezun]]` in the domain
  // dangled — Health went from 5 issues to 50 on the user's wiki.
  const retired = retiredSlugs.map((s) => ({ folder: 'entities', slug: s }));
  await repointInboundLinks(wikiDir, retired, canonical, 'entities');

  // Deleted only after the repoint, and re-derived through wikiFile() so the
  // path handed to `rm` has the same provenance as every other path in this
  // module (see the gate docblock at the top of the file).
  for (const slug of retiredSlugs) {
    const dupAbs = wikiFile(wikiDir, 'entities', `${slug}.md`);
    if (!dupAbs || !existsSync(dupAbs)) continue;
    await rm(dupAbs);
  }
  return true;
}

/**
 * Apply an AI-proposed orphan-rescue suggestion (v2.4.4+).
 *
 * The issue carries the orphan's bare slug, the target page to link FROM,
 * and a short AI-written description for the bullet's prose. Writes
 *   `- [[orphanSlug]] — description`
 * into the target's Related section via `injectRelatedLink`.
 *
 * Defense in depth:
 *   1. `targetPath` must resolve inside wikiDir (no path traversal, and no
 *      symlink escape — the docblock claimed this before v3.2.0 while the
 *      code built the path with a bare `path.join`; see `wikiFile` above).
 *   2. The orphan slug must actually exist on disk in entities/ or concepts/.
 *   3. Target must be an entities/ or concepts/ file — never a summary
 *      (summaries are not valid orphan-rescue targets; see docs/ai-health.md).
 *
 * RETURNS `{ ok, reason }` for the same purpose as `fixBrokenLink`, and the
 * FIRST reason below is the one that matters most in practice. `scanWiki` emits
 * an orphan as `{path, type, slug}`; this handler needs `{orphanSlug,
 * targetSlug}`. A model that follows the general rule "pass the scan issue
 * through unchanged" therefore lands here with neither field, and used to get
 * `fixed: 0` rendered as "may already have been resolved" — so a whole run of
 * orphans reports clean while not one of them was touched.
 */
async function fixOrphanLink(wikiDir, issue) {
  if (!issue || !issue.orphanSlug || !issue.targetSlug) return { ok: false, reason: 'orphan-fields-missing' };

  const { orphanSlug, targetSlug } = issue;
  const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/i;
  if (!SLUG_RE.test(orphanSlug) || !SLUG_RE.test(targetSlug)) return { ok: false, reason: 'slug-shape-invalid' };

  // `abs`, not `p`: a name that reaches a syscall must be single-purpose in
  // this module. The §8c provenance guard is name-scoped, not scope-aware —
  // it cannot tell this `p` from the `p` used for a plan entry in
  // applyOrphanRescue or the `.map(p => …)` callback in
  // findSemanticCandidatePairs. Rather than teach the guard scoping (which
  // needs a parser this repo does not have), the ambiguity is removed here,
  // and §8c enforces that: any binding of a path-carrying name to a
  // non-path fails the build.
  const at = (folder, slug) => {
    const abs = wikiFile(wikiDir, folder, slug + '.md');
    return abs && existsSync(abs) ? abs : null;
  };

  // Defence 1: orphan must exist on disk (entity or concept)
  if (!at('entities', orphanSlug) && !at('concepts', orphanSlug)) return { ok: false, reason: 'orphan-not-found' };

  // Defence 2: target must exist and be an entity or concept (never a summary)
  const targetPath = at('entities', targetSlug) || at('concepts', targetSlug);
  if (!targetPath) return { ok: false, reason: 'target-not-found' };

  // Defence 3: don't link a page to itself
  if (orphanSlug === targetSlug) return { ok: false, reason: 'self-link' };

  const wrote = await injectRelatedLink(targetPath, orphanSlug, issue.description || '');
  // `injectRelatedLink` is dedup-aware, so a false here means the link was
  // already in the target's Related section — genuinely "already resolved".
  return wrote ? { ok: true, reason: null } : { ok: false, reason: 'link-already-present' };
}

async function fixMissingBacklink(wikiDir, issue) {
  // Use the entity path the scan already resolved, instead of re-running the
  // bulk injectSummaryBacklinks machinery. The bulk function re-resolves every
  // bullet in the summary's "Entities Mentioned" section and can land the
  // backlink in a hyphen-variant file (e.g. e-mail.md when the scan pointed
  // at email.md), leaving the flagged file unchanged and the issue unfixed.
  const entityPath = wikiFile(wikiDir, issue.entity);
  const summaryPath = wikiFile(wikiDir, issue.summary);
  if (!entityPath || !summaryPath) return false;
  if (!existsSync(entityPath) || !existsSync(summaryPath)) return false;

  const summaryContent = await readFile(summaryPath, 'utf8');
  const titleMatch = summaryContent.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : issue.summarySlug;

  await injectSingleBacklink(entityPath, issue.summarySlug, title);
  return true;
}

/**
 * REFUSAL REASONS — why `fixed: 0` is not one fact but several.
 *
 * The two handlers below that accept an LLM-COMPOSED issue object return
 * `{ok, reason}`; the handlers that only ever see a scan-emitted object keep
 * their bare boolean. That split is deliberate rather than half-done: a scanner
 * object is well-formed by construction, so "it did nothing" really does mean
 * "already resolved", whereas `fix_wiki_issue` hands `fixBrokenLink` a target a
 * model chose and `fixOrphanLink` a pair of slugs a model chose, and there
 * "already resolved" is one outcome among five.
 *
 * NOT ENFORCED: nothing stops a future handler being added to AUTO_FIXABLE with
 * a bare boolean and an LLM-composed issue shape. `normaliseFixOutcome` accepts
 * booleans precisely so that stays safe rather than throwing — the cost is that
 * such a handler reports `reason: null` and falls back to the generic message.
 *
 * @param {boolean|{ok: boolean, reason: string|null}} r
 */
function normaliseFixOutcome(r) {
  if (typeof r === 'boolean') return { ok: r, reason: null };
  return { ok: !!r?.ok, reason: r?.reason ?? null };
}

/**
 * Apply one fix for a specific issue object, OR all fixes of a given type
 * when `issue` is not provided.
 *
 * @param {string} domain
 * @param {string} type       — one of AUTO_FIXABLE
 * @param {object|null} issue — if null, fix all issues of this type
 * @returns {{ fixed: number, total: number, reason?: string }} `reason` is
 *   present only on the single-issue branch and only when nothing was written.
 *   It is ADDITIVE: every existing caller reads `fixed`/`total` and is
 *   unaffected (src/routes/health.js spreads the object into its JSON body,
 *   mcp/tools/health.js reads `fixed`, and the suites assert on `fixed`).
 */
export async function fixIssue(domain, type, issue = null) {
  if (!AUTO_FIXABLE.has(type)) {
    throw new Error(`Issue type "${type}" is review-only and cannot be auto-fixed.`);
  }
  const wikiDir = wikiPath(domain);

  // Fix one specific issue
  if (issue) {
    let raw = false;
    if (type === 'brokenLinks')       raw = await fixBrokenLink(wikiDir, issue);
    if (type === 'folderPrefixLinks') raw = await fixFolderPrefixLink(wikiDir, issue);
    if (type === 'crossFolderDupes')  raw = await fixCrossFolderDupe(wikiDir, issue);
    if (type === 'hyphenVariants')    raw = await fixHyphenVariant(wikiDir, issue);
    if (type === 'missingBacklinks')  raw = await fixMissingBacklink(wikiDir, issue);
    if (type === 'orphanLink')        raw = await fixOrphanLink(wikiDir, issue);
    if (type === 'semanticDupe')      raw = await fixSemanticDuplicate(wikiDir, issue);
    const { ok, reason } = normaliseFixOutcome(raw);
    return { fixed: ok ? 1 : 0, total: 1, ...(ok || !reason ? {} : { reason }) };
  }

  // Fix all of type: re-scan and apply each. For brokenLinks, only issues
  // with a suggestedTarget count toward the total — the rest are review-only.
  // `orphanLink` and `semanticDupe` have no scan-emitted issues; fix-all is
  // a no-op. Phase 3 deliberately rejects batch merges at any scale.
  if (type === 'orphanLink')   return { fixed: 0, total: 0 };
  if (type === 'semanticDupe') return { fixed: 0, total: 0 };

  const report = await scanWiki(domain);
  let issues = report[type] || [];
  if (type === 'brokenLinks') issues = issues.filter(i => i.suggestedTarget);
  // Built once for the whole loop rather than per issue — fixBrokenLink's
  // existence check would otherwise re-read three folders for every link, and
  // a mature domain reaches here with hundreds.
  const knownTargets = type === 'brokenLinks' ? (await buildTargetInventory(wikiDir)).valid : null;
  let fixed = 0;
  for (const it of issues) {
    let raw = false;
    try {
      if (type === 'brokenLinks')       raw = await fixBrokenLink(wikiDir, it, knownTargets);
      if (type === 'folderPrefixLinks') raw = await fixFolderPrefixLink(wikiDir, it);
      if (type === 'crossFolderDupes')  raw = await fixCrossFolderDupe(wikiDir, it);
      if (type === 'hyphenVariants')    raw = await fixHyphenVariant(wikiDir, it);
      if (type === 'missingBacklinks')  raw = await fixMissingBacklink(wikiDir, it);
    } catch (err) {
      console.warn(`[fixIssue] ${type} failed:`, err.message);
    }
    // MUST go through normaliseFixOutcome. `fixBrokenLink` now returns an
    // OBJECT, and `{ok: false}` is truthy — a bare `if (raw)` here would count
    // every refused link as fixed and report a clean sweep over an untouched
    // wiki. That is the same class of defect this whole change is repairing,
    // so it is pinned behaviourally in test-mcp-e2e.js §9.
    if (normaliseFixOutcome(raw).ok) fixed++;
  }
  return { fixed, total: issues.length };
}

// ── Phase 3 (v2.4.5) — Semantic near-duplicate detection ────────────────────

/**
 * Hard limit on domain size before the semantic-duplicate scan refuses.
 * At 20k pages a token-index pre-filter runs in single-digit seconds and
 * produces a manageable candidate set. Above that we ask the user to split
 * the domain — the cost of a false-positive merge across 30k pages of links
 * is too high to invite.
 */
export const SEMANTIC_DUPE_MAX_DOMAIN_PAGES = 20000;

/**
 * Default candidate-pair cap sent to the LLM. User-overridable via config
 * (Settings → AI Health cost ceiling / candidate cap).
 */
export const SEMANTIC_DUPE_DEFAULT_CAP = 500;

/**
 * How many inner comparisons the candidate pre-filter may perform between
 * yields back to the event loop.
 *
 * WHY THIS EXISTS: `findSemanticCandidatePairs` is a synchronous O(N²)
 * character-similarity sweep. Measured on a real 3,288-page domain it ran for
 * **15.0 s as a single uninterrupted block**, during which a concurrent
 * `GET /api/version` — normally 1 ms — took 13.7 s. The whole app was dead:
 * rail, badges, every view, every other request. It is reachable in ONE click
 * from the shipping UI ("✨ Find duplicate pages"). v3.2.0 removed this scan
 * from automatic view-entry for exactly that reason but never made it
 * non-blocking, so the freeze stayed one deliberate click away.
 *
 * The scan is still allowed to take ~15 s of wall clock — that is honest work
 * and the UI reports it. What it may no longer do is monopolise the loop.
 *
 * VALUE DERIVED BY MEASUREMENT, NOT BY ARITHMETIC — and the arithmetic was
 * wrong. Per-comparison cost is ~2.75 µs (5,404,428 comparisons in 14.84 s),
 * which predicts 22 ms for an 8,000-unit slice. Measured, 8,000 gave a 70.7 ms
 * worst slice: the prediction ignored GC, and this pass allocates two boolean
 * arrays per comparison (~10.8 M allocations), so collection pauses land
 * inside slices and widen them. Observed worst slice / count over 50 ms, same
 * 3,288-page corpus:
 *
 *     32,000 → 199.9 ms   (135 slices over 50 ms)
 *     16,000 → 126.9 ms   (136)
 *      8,000 →  70.7 ms   (6)
 *      4,000 →  28.5 ms p99, one 1,257 ms GC outlier
 *      2,000 →  21.3 ms   (0 over 50 ms, 0 over 30 ms, 3 consecutive runs)
 *      1,000 →  14.2 ms   (0) — 2× the yields for no user-visible gain
 *
 * 2,000 is the largest budget that put NOTHING over the 50 ms Long-Tasks
 * threshold, with 3× headroom for a slower machine. It costs ~3,090 yields
 * and no measurable wall clock: 14,923 / 15,045 / 14,936 ms against a
 * 15,040 ms pre-change baseline — run-to-run noise is larger than the effect.
 *
 * THE BUDGET IS A SCHEDULE, NEVER A SEMANTIC. Changing it must not change
 * which pairs are found or their order — the loops read only local state that
 * nothing else can touch, so a yield cannot perturb them. That invariant is
 * pinned by assertion in scripts/test-semantic-scan-yield.js, which runs the
 * same corpus at several chunk sizes and requires byte-identical output.
 */
export const SEMANTIC_SCAN_YIELD_CHUNK = 2000;

/**
 * The token-overlap pass does strictly more work per unit than the pure-JW
 * pass (`candidatePairScore` = 2× tokenizeSlug + jaroWinkler + a filter, vs a
 * single jaroWinkler), so it gets a proportionally smaller budget. Measured
 * at ~4× the per-unit cost, hence the divisor.
 */
const SEMANTIC_SCAN_TOKEN_PASS_DIVISOR = 4;

/** Hand the event loop back so queued I/O and timers can run. */
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

const STOPWORDS = new Set([
  'a','an','the','of','in','and','or','to','for','is','are','on','at',
  'by','with','from','as','it','this','that','be','was','were','has','have',
  'but','not','if','can','will','its','can','we','our','your','their',
]);

function tokenizeSlug(slug) {
  // Split on hyphen/underscore, drop tokens < 3 chars, drop stopwords, lowercase
  return slug
    .toLowerCase()
    .split(/[-_]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Jaro-Winkler similarity (0-1). Used by the pre-filter to rank candidates.
 * Inlined rather than adding a dep — the algorithm is small and stable.
 */
function jaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatch = new Array(la).fill(false);
  const bMatch = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(lb, i + matchDist + 1);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  // Winkler prefix bonus (up to 4 chars)
  let p = 0;
  const maxP = Math.min(4, la, lb);
  while (p < maxP && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

function candidatePairScore(slugA, slugB, sharedTokens) {
  // Multi-signal score (0-1).
  //   token overlap   — proportional to shared tokens
  //   JW similarity   — character-level
  //   length ratio    — penalises wildly different lengths
  const tokensA = tokenizeSlug(slugA);
  const tokensB = tokenizeSlug(slugB);
  const maxTokens = Math.max(tokensA.length, tokensB.length);
  const tokenOverlap = maxTokens > 0 ? sharedTokens / maxTokens : 0;
  const jw = jaroWinkler(slugA, slugB);
  const lenRatio = Math.min(slugA.length, slugB.length) / Math.max(slugA.length, slugB.length);
  return 0.5 * tokenOverlap + 0.35 * jw + 0.15 * lenRatio;
}

/**
 * Pre-filter: find slug pairs that *might* be semantic duplicates, using
 * token overlap + Jaro-Winkler. Scales to ~20k pages via an inverted
 * token-index (O(N·k) not O(N²)).
 *
 * Returns pairs ranked by score (highest first), capped at `maxPairs`.
 * Only pairs within entities/ or within concepts/, OR entity↔concept
 * cross-folder pairs, are considered. Summaries are excluded.
 *
 * Exact-match cross-folder duplicates (entities/X + concepts/X) are omitted
 * because they are already caught by scanWiki's crossFolderDupes branch.
 *
 * Both passes YIELD the event loop periodically (see
 * SEMANTIC_SCAN_YIELD_CHUNK). This is a scheduling change only: the pair set
 * and its ranking are byte-identical to the pre-yield implementation, because
 * every structure the loops touch (`pairMap`, `slugTokens`, `allSlugs`) is a
 * function-local that nothing outside this call can reach.
 *
 * @param {string} domain
 * @param {number} maxPairs — cap on output pairs (default 500)
 * @param {object} [opts] — TEST-ONLY seam. `opts.yieldChunk` overrides the
 *   scheduling budget so a suite can prove output is invariant across chunk
 *   sizes. Never set by production code; it cannot affect results by design,
 *   and the suite exists to keep that true.
 * @returns {Promise<{pageCount, pairs, truncated}>}
 */
export async function findSemanticCandidatePairs(domain, maxPairs = SEMANTIC_DUPE_DEFAULT_CAP, opts = {}) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  const entityFiles  = await listMd(wikiDir, 'entities');
  const conceptFiles = await listMd(wikiDir, 'concepts');

  const pageCount = entityFiles.length + conceptFiles.length;
  if (pageCount > SEMANTIC_DUPE_MAX_DOMAIN_PAGES) {
    const err = new Error(
      `Semantic-duplicate scan is capped at ${SEMANTIC_DUPE_MAX_DOMAIN_PAGES} pages; ` +
      `this domain has ${pageCount}. Consider splitting the domain.`
    );
    err.code = 'DOMAIN_TOO_LARGE';
    throw err;
  }

  // Build slug list with folder metadata
  const allSlugs = [
    ...entityFiles.map(f => ({ slug: f.slice(0, -3), folder: 'entities' })),
    ...conceptFiles.map(f => ({ slug: f.slice(0, -3), folder: 'concepts' })),
  ];

  // Inverted token index: token → list of indices in allSlugs
  const tokenIndex = new Map();
  const slugTokens = new Array(allSlugs.length);
  for (let i = 0; i < allSlugs.length; i++) {
    const toks = tokenizeSlug(allSlugs[i].slug);
    slugTokens[i] = toks;
    for (const t of toks) {
      if (!tokenIndex.has(t)) tokenIndex.set(t, []);
      tokenIndex.get(t).push(i);
    }
  }

  // Generate candidate pairs through shared tokens (bounded per-slug).
  // Only keep pairs whose score > 0.5 — below that, false-positive rate is
  // too high to burn LLM tokens on.
  const MIN_SCORE = 0.5;
  const pairMap = new Map(); // key "i|j" (i<j) → {a, b, score, shared}

  // Scheduling budget, shared across both passes so it is one continuous
  // allowance rather than two that can each individually starve the loop.
  const yieldChunk = Math.max(1, Number(opts.yieldChunk) || SEMANTIC_SCAN_YIELD_CHUNK);
  const tokenPassChunk = Math.max(1, Math.floor(yieldChunk / SEMANTIC_SCAN_TOKEN_PASS_DIVISOR));
  let work = 0;

  for (let i = 0; i < allSlugs.length; i++) {
    const toks = slugTokens[i];
    if (toks.length === 0) continue;
    const candIndices = new Set();
    for (const t of toks) {
      for (const j of tokenIndex.get(t)) {
        if (j > i) candIndices.add(j);
      }
    }
    for (const j of candIndices) {
      const shared = slugTokens[i].filter(t => slugTokens[j].includes(t)).length;
      if (shared === 0) continue;
      // Skip exact-match cross-folder (already caught by scanWiki)
      if (allSlugs[i].slug === allSlugs[j].slug) continue;
      const score = candidatePairScore(allSlugs[i].slug, allSlugs[j].slug, shared);
      if (score < MIN_SCORE) continue;
      pairMap.set(`${i}|${j}`, { i, j, score });
    }
    // Yield accounting sits OUTSIDE the inner loop, so one slug's whole
    // candidate set is processed atomically — the set is bounded by the
    // token index and is orders of magnitude smaller than the budget.
    work += candIndices.size;
    if (work >= tokenPassChunk) { work = 0; await yieldToEventLoop(); }
  }

  // Also add prefix-subsequence candidates (e.g. "rag" vs "retrieval-augmented-generation"
  // share no tokens but one is an acronym of the other — handled via JW only
  // where JW ≥ 0.8 as a secondary pass.
  //
  // This pass is 97 % of the runtime (14.8 s of 15.2 s measured on a real
  // 3,288-page domain), so it is where the yielding has to bite. The inner
  // loop is chunked against the REMAINING budget rather than restarted per
  // outer iteration: with a per-outer-iteration budget, every outer iteration
  // on a domain smaller than the chunk size would fit inside one budget and
  // the loop would never yield at all — the tail of this triangle is
  // thousands of short iterations that must still be accounted for.
  const n = allSlugs.length;
  for (let i = 0; i < n; i++) {
    const slugI = allSlugs[i].slug;
    let j = i + 1;
    while (j < n) {
      const stop = Math.min(n, j + Math.max(1, yieldChunk - work));
      const from = j;
      for (; j < stop; j++) {
        if (pairMap.has(`${i}|${j}`)) continue;
        if (slugI === allSlugs[j].slug) continue;
        const jw = jaroWinkler(slugI, allSlugs[j].slug);
        if (jw >= 0.85) {
          pairMap.set(`${i}|${j}`, { i, j, score: 0.5 * jw + 0.5 }); // bias up
        }
      }
      work += (j - from);
      if (work >= yieldChunk) { work = 0; await yieldToEventLoop(); }
    }
    // Note: outer loop capped by O(N²) only for the high-JW pass; for 20k
    // pages this is 200M ops — marginal. If it proves slow on real-world
    // data, we'll add locality-sensitive hashing. Currently acceptable.
  }

  const ranked = [...pairMap.values()].sort((a, b) => b.score - a.score);

  // Lift the ranked pairs into the public shape, then filter out any pairs the
  // user has previously dismissed (v2.5.1+). We filter BEFORE truncating so a
  // domain with many dismissals doesn't silently lose live pairs by pushing
  // them past `maxPairs`.
  const allPairs = ranked.map(p => ({
    slugA:   allSlugs[p.i].slug,
    folderA: allSlugs[p.i].folder,
    slugB:   allSlugs[p.j].slug,
    folderB: allSlugs[p.j].folder,
    score:   Number(p.score.toFixed(3)),
  }));

  const { keys: dismissedKeys } = await loadDismissed(domain);
  const filtered = filterDismissed(allPairs, 'semanticDupe', dismissedKeys);
  const livePairs = filtered.kept;
  const truncated = livePairs.length > maxPairs;
  const pairs = livePairs.slice(0, maxPairs);

  return {
    pageCount,
    pairs,
    truncated,
    totalCandidates: livePairs.length,
    dismissed: filtered.dismissed,
  };
}

/**
 * Count how many .md files in the domain contain `[[removeSlug]]` or
 * `[[folder/removeSlug]]` — used for the merge preview-diff ("14 links will
 * be rewritten"). Does not modify anything.
 */
/**
 * Validate a semanticDupe issue and resolve both pages to absolute paths, or
 * return null. Shared by `previewSemanticDuplicateMerge` and
 * `fixSemanticDuplicate`.
 *
 * It is shared BECAUSE it drifted (v3.2.0 audit): the two functions carried
 * two different ideas of what a valid pair was. `fixSemanticDuplicate` had
 * the slug regex and the entities/concepts folder allow-list;
 * `previewSemanticDuplicateMerge` had NEITHER — it checked only that the
 * four fields were truthy and then joined them straight onto wikiDir. Its
 * `issue` comes verbatim from the POST body of
 * `/api/health/:domain/semantic-dupes/preview`, so `keepFolder: "../../.."`
 * read an arbitrary file on disk and returned 4 KB of it to the caller as
 * `mergedPreview`. Reproduced before the fix; no symlink needed.
 *
 * Preview and apply must agree on what they are willing to touch, so there
 * is now exactly one definition of that.
 */
function resolveSemanticDupePair(wikiDir, issue) {
  if (!issue || typeof issue !== 'object') return null;
  const { keepSlug, keepFolder, removeSlug, removeFolder } = issue;

  // Periods are allowed inside a slug ("dr.-tali-rezun"); a leading one is
  // not, so ".." can never satisfy this.
  const SLUG_RE = /^[a-z0-9][a-z0-9.-]*$/i;
  if (typeof keepSlug !== 'string' || typeof removeSlug !== 'string') return null;
  if (!SLUG_RE.test(keepSlug) || !SLUG_RE.test(removeSlug)) return null;
  if (keepSlug.includes('/') || removeSlug.includes('/')) return null;
  if (!['entities', 'concepts'].includes(keepFolder)) return null;   // never summaries
  if (!['entities', 'concepts'].includes(removeFolder)) return null;
  if (keepSlug === removeSlug && keepFolder === removeFolder) return null;

  const keepPath = wikiFile(wikiDir, keepFolder, keepSlug + '.md');
  const removePath = wikiFile(wikiDir, removeFolder, removeSlug + '.md');
  if (!keepPath || !removePath) return null;

  return { keepSlug, keepFolder, keepPath, removeSlug, removeFolder, removePath };
}

export async function countLinksToSlug(domain, slug) {
  const wikiDir = wikiPath(domain);
  const allFiles = await walkMdFiles(wikiDir);
  const escSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[\\[(entities/|concepts/|summaries/)?${escSlug}(\\|[^\\]]+)?\\]\\]`, 'g');
  let files = 0;
  let links = 0;
  for (const full of allFiles) {
    const rel = path.relative(wikiDir, full);
    if (rel === 'index.md' || rel === 'log.md') continue;
    const content = await readFile(full, 'utf8');
    const matches = content.match(re);
    if (matches) { files++; links += matches.length; }
  }
  return { files, links };
}

/**
 * Build a human-readable diff preview for a semantic-duplicate merge.
 * Shows:
 *   - which file will be deleted
 *   - how many other files will have their links rewritten
 *   - a list of those files (capped at 50 for UI sanity)
 *   - the merged Related/Key-Facts sections that will land in the kept page
 *
 * Runs no writes. Returns a structured object the UI renders.
 */
export async function previewSemanticDuplicateMerge(domain, issue) {
  const wikiDir = wikiPath(domain);
  const resolved = resolveSemanticDupePair(wikiDir, issue);
  if (!resolved) {
    throw new Error(
      'Invalid semanticDupe issue: keep/remove must each name an entities/ or ' +
      'concepts/ page by slug, inside this domain\'s wiki folder.'
    );
  }
  // Destructure EVERY field the body below uses. `removeSlug` drives the
  // link-rewrite count further down; omitting it made this function throw
  // ReferenceError on every VALID pair, while all five tests passed invalid
  // input and asserted a throw — which a ReferenceError satisfies. The
  // positive-path assertions in test-wiki-page.js §8d exist because of that.
  const { keepPath, removePath, removeSlug } = resolved;
  if (!existsSync(keepPath) || !existsSync(removePath)) {
    throw new Error('Both pages must exist to preview a merge');
  }

  const keepContent = await readFile(keepPath, 'utf8');
  const removeContent = await readFile(removePath, 'utf8');

  // Mirror the real merge's direction logic: larger body wins as the base
  const merged = keepContent.length >= removeContent.length
    ? mergeBulletSections(keepContent, removeContent)
    : mergeBulletSections(removeContent, keepContent);

  // Count affected files for the "N links will be rewritten" message
  const affectedFiles = [];
  const allFiles = await walkMdFiles(wikiDir);
  const escSlug = removeSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[\\[(entities/|concepts/|summaries/)?${escSlug}(\\|[^\\]]+)?\\]\\]`, 'g');
  for (const full of allFiles) {
    const rel = path.relative(wikiDir, full);
    if (rel === 'index.md' || rel === 'log.md') continue;
    const content = await readFile(full, 'utf8');
    const matches = content.match(re);
    if (matches && matches.length > 0) {
      affectedFiles.push({ path: rel, linkCount: matches.length });
    }
  }

  return {
    keepPath: path.relative(wikiDir, keepPath),
    removePath: path.relative(wikiDir, removePath),
    mergedPreview: merged.slice(0, 4000), // cap for UI
    mergedLength: merged.length,
    affectedFiles: affectedFiles.slice(0, 50),
    affectedCount: affectedFiles.length,
    totalLinksRewritten: affectedFiles.reduce((s, f) => s + f.linkCount, 0),
  };
}

/**
 * Apply a semantic-duplicate merge. DESTRUCTIVE.
 *
 * Steps (ordered so a mid-operation crash leaves the wiki recoverable):
 *   1. Validate both slugs exist, distinct, not summaries, slug-regex safe.
 *   2. Read both files + merge bullet sections (larger body wins as base).
 *   3. Write the merged content to the kept file.
 *   4. Repoint every inbound link across the domain via the SHARED
 *      `repointInboundLinks` (summaries included — a summary linking to the
 *      old slug must point to the new canonical).
 *   5. Delete the removed file.
 *
 * Returns true on success, false on any validation failure (silent no-op —
 * matches the pattern used by fixOrphanLink).
 */
async function fixSemanticDuplicate(wikiDir, issue) {
  const resolved = resolveSemanticDupePair(wikiDir, issue);
  if (!resolved) return false;
  const { keepSlug, keepFolder, keepPath, removeSlug, removeFolder, removePath } = resolved;
  if (!existsSync(keepPath) || !existsSync(removePath)) return false;

  // Step 2: merge bodies
  const keepContent = await readFile(keepPath, 'utf8');
  const removeContent = await readFile(removePath, 'utf8');
  let merged = keepContent.length >= removeContent.length
    ? mergeBulletSections(keepContent, removeContent)
    : mergeBulletSections(removeContent, keepContent);

  // Normalise frontmatter type to match the kept folder
  const wantType = keepFolder === 'entities' ? 'entity' : 'concept';
  const otherType = keepFolder === 'entities' ? 'concept' : 'entity';
  merged = merged.replace(new RegExp(`^type:\\s*${otherType}$`, 'm'), `type: ${wantType}`);
  merged = merged.replace(new RegExp(`type/${otherType}`, 'g'), `type/${wantType}`);

  // Step 3: persist the merged body. This happens BEFORE the repoint (it used
  // to be interleaved with it) because repointInboundLinks writes to disk, so
  // a later write of the in-memory `merged` would clobber the kept page's own
  // repointed links.
  await writeFileAtomic(keepPath, merged, 'utf8');

  // Step 4: repoint every inbound link across the domain. This used to be an
  // inline copy of this logic, unique to this handler — the two sibling
  // handlers that also delete a page had none, which is the defect this
  // shared helper exists to close. See its docblock.
  await repointInboundLinks(
    wikiDir,
    [{ folder: removeFolder, slug: removeSlug }],
    keepSlug,
    keepFolder
  );

  // Step 5: delete the removed file
  await rm(removePath);
  return true;
}

/**
 * Batch-merge a list of semantic-duplicate pairs (v3.0.1-beta.15).
 *
 * Runs `fixSemanticDuplicate` sequentially for each pair. Sequential — NOT
 * parallel — because each merge rewrites `[[links]]` and deletes a file across
 * the entire domain; concurrent merges would race on shared files. A pair
 * whose keep/remove file was already consumed by an earlier merge in the same
 * batch is reported as `skipped` (its file no longer exists) rather than an
 * error, so chained duplicates degrade gracefully.
 *
 * Callers (the "Merge all high-confidence" button) pass an explicit, already-
 * filtered list of pairs. Each pair is still independently validated inside
 * `fixSemanticDuplicate` (slug regex, folder allowlist, existence) so a crafted
 * request cannot escape the wiki folder.
 *
 * @param {string}   domain
 * @param {object[]} pairs       [{keepSlug, keepFolder, removeSlug, removeFolder}]
 * @param {function} onProgress  ({done, total, pair, status}) => void
 * @returns {Promise<{merged:number, skipped:number, errors:number, total:number, results:object[]}>}
 */
export async function fixSemanticDuplicatesBatch(domain, pairs, onProgress = () => {}) {
  const wikiDir = wikiPath(domain);
  const list = Array.isArray(pairs) ? pairs : [];
  const total = list.length;
  const results = [];
  let merged = 0, skipped = 0, errors = 0;

  for (let i = 0; i < total; i++) {
    const pair = list[i] || {};
    let status = 'skipped';
    try {
      const ok = await fixSemanticDuplicate(wikiDir, pair);
      status = ok ? 'merged' : 'skipped';
    } catch (err) {
      status = 'error';
      console.error(`[health] Batch merge failed for "${pair.removeSlug}" → "${pair.keepSlug}": ${err.message}`);
    }
    if (status === 'merged') merged++;
    else if (status === 'error') errors++;
    else skipped++;
    results.push({ keepSlug: pair.keepSlug, removeSlug: pair.removeSlug, status });
    try { onProgress({ done: i + 1, total, pair, status }); } catch { /* progress is best-effort */ }
  }

  return { merged, skipped, errors, total, results };
}

/**
 * Apply a bulk broken-link fix plan (v3.0.1-beta.16). DESTRUCTIVE.
 *
 * `plan` is the array produced by `planBrokenLinkFixes` (health-ai.js):
 *   [{ linkText, action: 'retarget'|'strip', target?: slug }]
 *
 * For each entry, every `[[linkText]]` / `[[linkText|alias]]` occurrence across
 * the domain is either:
 *   • retarget → `[[target]]` / `[[target|alias]]`   (target re-validated on disk)
 *   • strip    → the link's display text without brackets (alias label if present,
 *                otherwise the link text) — the user's chosen behaviour for links
 *                that point at no real page.
 *
 * Walks every page ONCE and parses its wikilinks with the SAME regex the scanner
 * uses, so the keys line up exactly. `index.md` / `log.md` are skipped to match
 * the scanner (and to avoid mangling the generated index table). The plan arrives
 * from the client, so every retarget target is re-checked against the on-disk
 * slug inventory — an unknown target is dropped (no-op) rather than written.
 *
 * @returns {Promise<{retargeted, stripped, filesChanged, occurrencesReplaced, totalActions, downgraded}>}
 */
export async function applyBrokenLinkFixes(domain, plan, onProgress = () => {}) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  // Reuses the gated `listMd` rather than its own readdir: the two used to be
  // written out separately, and only one of them was containment-checked.
  const { ents, cons, sums, valid } = await buildTargetInventory(wikiDir);
  // The deterministic (free) tier's own resolver, rebuilt from the SAME
  // inventory. Its output is re-derived here rather than trusted from the
  // plan's `source` field, which arrives in the request body and can say
  // anything. See the exemption note in the loop below.
  const resolveDeterministic = buildLinkResolver(ents, cons, sums);

  // linkText → { action, target } — last entry wins on duplicate linkText.
  const actions = new Map();
  let downgraded = 0;
  for (const p of (Array.isArray(plan) ? plan : [])) {
    if (!p || typeof p !== 'object' || !p.linkText) continue;
    if (p.action === 'retarget') {
      const target = String(p.target || '').replace(/^(entities|concepts)\//, '');
      if (!target || !valid.has(target)) continue;   // drop unknown / hallucinated targets
      // Re-run the lexical-variant gate SERVER-SIDE (v3.9.1). It used to run
      // only inside planBrokenLinkFixes, and this function's plan arrives in a
      // POST body: the preview the user approved is client-side and is not the
      // thing being applied. A refused pair is DOWNGRADED to strip — never
      // silently applied, and never silently dropped, because dropping it
      // leaves a broken link the report claimed was handled.
      //
      // EXEMPTION, and it is load-bearing: the gate judges the AI's free-form
      // guesses, and it is WRONG for the deterministic tier's output. Pure
      // formatting repairs share no whole token with their target and score
      // Jaccard 0 — `[[r-a-g]]` → `rag`, `[[e-mail]]` → `email` — so gating
      // them blindly downgrades every free fix to `strip`. The first cut of
      // this change did exactly that and section 8d of test-wiki-page.js
      // caught it. The exemption is safe because it is RE-DERIVED, not
      // asserted: a client can only reach it by naming the target the
      // resolver itself produces, which is by construction the right one.
      if (resolveDeterministic(p.linkText) !== target && !isLexicalVariant(p.linkText, target)) {
        actions.set(p.linkText, { action: 'strip' });
        downgraded++;
        continue;
      }
      actions.set(p.linkText, { action: 'retarget', target });
    } else if (p.action === 'strip') {
      actions.set(p.linkText, { action: 'strip' });
    }
  }

  const totalActions = actions.size;
  if (totalActions === 0) {
    return { retargeted: 0, stripped: 0, filesChanged: 0, occurrencesReplaced: 0, totalActions: 0, downgraded };
  }

  const linkRe = /\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g;
  const allFiles = await walkMdFiles(wikiDir);
  let retargeted = 0, stripped = 0, filesChanged = 0, occurrencesReplaced = 0, processed = 0;

  for (const full of allFiles) {
    const rel = path.relative(wikiDir, full);
    if (rel === 'index.md' || rel === 'log.md') { processed++; continue; }
    const before = await readFile(full, 'utf8');
    let changedHere = 0;
    const after = before.replace(linkRe, (m0, inner, alias) => {
      const act = actions.get(inner.trim());
      if (!act) return m0;
      changedHere++;
      if (act.action === 'retarget') { retargeted++; return `[[${act.target}${alias || ''}]]`; }
      stripped++;
      // Keep readable text: the alias label if the link had one, else the link text.
      return alias ? alias.slice(1).trim() : inner.trim();
    });
    if (changedHere > 0 && after !== before) {
      await writeFileAtomic(full, after, 'utf8');
      filesChanged++;
      occurrencesReplaced += changedHere;
    }
    processed++;
    if (processed % 100 === 0) { try { onProgress({ done: processed, total: allFiles.length }); } catch { /* best-effort */ } }
  }
  try { onProgress({ done: allFiles.length, total: allFiles.length }); } catch { /* best-effort */ }

  return { retargeted, stripped, filesChanged, occurrencesReplaced, totalActions, downgraded };
}

/**
 * Apply a bulk orphan-rescue plan (v3.0.1-beta.17). DESTRUCTIVE (additive).
 *
 * `plan` is from `planOrphanRescue` (health-ai.js):
 *   [{ orphanSlug, target, description }]
 *
 * For each entry, injects `- [[orphanSlug]] — description` into the target
 * page's `## Related` section (via injectRelatedLink, which is dedup-safe and
 * creates the section if missing). The target is re-validated against the
 * on-disk entity/concept inventory; self-links and unknown targets are skipped.
 *
 * @returns {Promise<{rescued, skipped, total}>}
 */
export async function applyOrphanRescue(domain, plan, onProgress = () => {}) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) throw new Error(`No wiki found for domain: ${domain}`);

  // Reuses the gated `listMd` rather than its own readdir: the two used to be
  // written out separately, and only one of them was containment-checked.
  const listSlugs = async (d) => (await listMd(wikiDir, d)).map(f => f.slice(0, -3));
  const [ents, cons] = await Promise.all([listSlugs('entities'), listSlugs('concepts')]);
  const validEnt = new Set(ents), validCon = new Set(cons);

  // The plan arrives from the client, so EVERY field is validated before it
  // touches a page (audit H1/M2): orphanSlug must be a real on-disk slug (it
  // goes inside `[[ ]]`, so a crafted value could otherwise inject a wikilink or
  // markdown), the target must exist, and the description is stripped of
  // bracket sequences that could fabricate extra links.
  const SLUG_RE = /^[a-z0-9][a-z0-9.\-]*$/i;
  const safeSlug = (s) => typeof s === 'string' && SLUG_RE.test(s) && !s.includes('..') && !s.includes('/') && !s.includes('\\');
  const orphanExists = (slug) => validEnt.has(slug) || validCon.has(slug);

  const list = Array.isArray(plan) ? plan : [];
  const total = list.length;
  const seen = new Set();            // dedup (target, orphan) pairs — one write per pair (M1)
  let rescued = 0, skipped = 0, processed = 0;

  for (const p of list) {
    processed++;
    const target = String((p && p.target) || '').replace(/^(entities|concepts)\//, '');
    const orphanSlug = p && p.orphanSlug;
    const dedupKey = `${target}::${orphanSlug}`;
    let ok = false;
    if (
      target && orphanSlug && target !== orphanSlug &&
      safeSlug(target) && safeSlug(orphanSlug) &&
      (validEnt.has(target) || validCon.has(target)) &&   // target exists
      orphanExists(orphanSlug) &&                          // orphan exists (no phantom rescue)
      !seen.has(dedupKey)
    ) {
      seen.add(dedupKey);
      const folder = validEnt.has(target) ? 'entities' : 'concepts';
      const targetPath = wikiFile(wikiDir, folder, target + '.md');
      // Sanitise the description: collapse whitespace and remove `[[`/`]]` so it
      // can never fabricate a wikilink inside the injected bullet.
      const desc = String((p && p.description) || '').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (targetPath) {
        try { ok = await injectRelatedLink(targetPath, orphanSlug, desc); }
        catch { ok = false; }
      }
    }
    if (ok) rescued++; else skipped++;
    if (processed % 25 === 0) { try { onProgress({ done: processed, total }); } catch { /* */ } }
  }
  try { onProgress({ done: total, total }); } catch { /* */ }

  return { rescued, skipped, total };
}

/**
 * Run every deterministic (auto-fixable) structural fix type in one locked pass
 * (v3.0.1-beta.17). Powers the "Fix N safe issues" one-click button so users
 * don't have to click fix-all per type. Returns per-type and total counts.
 * Reuses fixIssue(domain, type, null) — the same chokepoint as fix-all.
 */
export async function fixAllSafe(domain) {
  const TYPES = ['crossFolderDupes', 'hyphenVariants', 'folderPrefixLinks', 'missingBacklinks', 'brokenLinks'];
  const byType = {};
  let fixed = 0, total = 0;
  for (const type of TYPES) {
    try {
      const r = await fixIssue(domain, type, null);  // brokenLinks fix-all only touches suggestedTarget rows
      byType[type] = r;
      fixed += r.fixed || 0;
      total += r.total || 0;
    } catch (err) {
      byType[type] = { fixed: 0, total: 0, error: err.message };
    }
  }
  return { fixed, total, byType };
}
