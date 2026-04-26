/**
 * compile_to_wiki — v2.5.2 MCP write tool
 *
 * The primary write tool: turns conversation findings into permanent wiki
 * pages. Reuses the same writePage → syncSummaryEntities → mergeIntoIndex
 * pipeline as the in-app Compile feature (v2.5.0). The MCP imports those
 * functions directly — no parallel write logic.
 *
 * What this tool does NOT do:
 *  - Write outside the user's domains folder (path-traversal guarded by
 *    isValidSlug + the storage adapter's resolveInsideBase).
 *  - Touch index.md / log.md / CLAUDE.md (refused below).
 *  - Run for free on a hallucinated 50-page output (per-call + per-page caps).
 *  - Re-run on the same content silently (the v2.5.0 file-existence guard
 *    inherits via shared module — same conversation/title/date is refused
 *    with a clear message).
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import {
  readSchema,
  readIndex,
  wikiPath,
  writePage,
  appendLog,
  syncSummaryEntities,
} from '../../src/brain/files.js';
import { generateText } from '../../src/brain/llm.js';
import { getDefaultDomain } from '../../src/brain/config.js';
import { resolveDomainArg } from '../util.js';

// Hard caps — defense against runaway LLM output. Generous enough to never
// bite a real compile; small enough that a confused or malicious model can't
// trash the wiki in one tool call.
const MAX_PAGE_BYTES   = 50 * 1024;  // 50 KB per page (generous; real pages are 1–10 KB)
const MAX_PAGES        = 10;          // total pages per compile_to_wiki call
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 60_000;    // generous; covers very rich research summaries

// Slugs we never let be overwritten via MCP — these are app-managed.
const REFUSED_SLUGS = new Set(['index', 'log']);
const REFUSED_FILES = new Set(['index.md', 'log.md', 'CLAUDE.md']);

export const compileToWikiDefinition = {
  name: 'compile_to_wiki',
  description:
    "Save what the user has learned in this conversation to their second brain — the persistent markdown wiki managed by The Curator. " +
    "Use this when the user asks you to 'save what we discussed', 'add this to my wiki', 'update my second brain', 'compile our findings', " +
    "'store these notes', 'put this in my Curator', or any phrasing that means 'persist this knowledge'. " +
    "Writes a summary page plus any new entity/concept pages that emerged. Existing pages are merged additively (bullet sections grow), never overwritten. " +
    "Returns the list of created and updated pages with byte counts so you can show the user what changed. " +
    "Refuses with a clear message if the EXACT same title + content was already compiled today (the slug is a hash of title+content+date — same inputs map to the same file). Two compiles with the same title but different content on the same day produce different files; an unchanged re-compile is refused. " +
    "If the user did not specify a domain, call list_domains first OR check the configured default domain. " +
    "Pass dry_run: true on the first call to preview what will be written, present the plan to the user, then call again with dry_run: false to commit. " +
    "" +
    "GROUNDING WIKILINKS (v2.5.5+): every [[wikilink]] you write MUST reference either (a) an existing page in the wiki, or (b) a page you are creating in this same call's additional_pages. " +
    "Inventing links to pages that do not exist creates broken links the user has to fix later. Before composing the summary, call get_index for the target domain to see which slugs already exist, then write [[slug]] links that reference those exact slugs. " +
    "If a concept comes up that does NOT have an existing page, your options are: (1) add it to additional_pages so it gets created, or (2) write the term as plain text without [[brackets]]. " +
    "The response includes a `links` field with `resolved`, `normalized` (variant slugs auto-fixed), and `broken` counts so you can verify your work and decide whether to retry. " +
    "Use broken_link_policy='refuse' on fresh / new domains to have the call fail loudly if any link is broken — you'll get a sample of valid slugs back to retry with.",
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: "Target domain slug (e.g. 'articles', 'business'). If omitted, the configured default domain is used; if no default is set, an error is returned.",
      },
      title: {
        type: 'string',
        description: "Human-readable title for this compilation. Becomes the summary page slug (with date and short hash appended for uniqueness). Example: 'Brainstorm: AI in Enterprise'.",
      },
      summary_content: {
        type: 'string',
        description:
          "Full markdown content for the summary page. Should follow the wiki convention: '## Key Takeaways' (bullet list of conclusions), " +
          "'## Concepts Introduced or Referenced' (bullets with [[wikilinks]]), '## Entities Mentioned' (bullets with [[wikilinks]]), '## Notes' (free prose if needed). " +
          "Do NOT include YAML frontmatter — the app injects it automatically. Keep [[wikilinks]] to bare slugs (no folder prefix) except for [[summaries/...]].",
      },
      additional_pages: {
        type: 'array',
        description: "Optional. Entity or concept pages that emerged from the conversation and should be created or updated. Each must have path starting with 'entities/' or 'concepts/' and end in '.md'. Existing pages are merged additively (bullet sections accumulate, never replaced).",
        items: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: "Relative path, e.g. 'concepts/llm-deployment-strategies.md'" },
            content: { type: 'string', description: "Full markdown content (no YAML frontmatter)" },
          },
          required: ['path', 'content'],
        },
      },
      dry_run: {
        type: 'boolean',
        description: "If true, validate the input and return the planned changes WITHOUT writing anything. Use this on the first call to preview, then call again with dry_run: false to commit.",
        default: false,
      },
      broken_link_policy: {
        type: 'string',
        enum: ['keep', 'strip', 'refuse'],
        default: 'keep',
        description:
          "How to handle [[wikilinks]] that don't resolve to any existing page (and aren't being created in this same call). " +
          "'keep' (default) writes the link as-is and reports it in the response so you can decide. " +
          "'strip' removes the [[brackets]] so the prose reads naturally and no broken link lands on disk (lossy — you lose the link intent). " +
          "'refuse' aborts the whole compile if ANY broken link is found, returning the broken list + a sample of valid slugs so you can retry. Recommended for fresh / empty domains.",
      },
    },
    required: ['title', 'summary_content'],
  },
};

function slugify(title) {
  return String(title || 'compilation')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '') || 'compilation';
}

function shortHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 4);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Lightweight validator for additional_pages paths. Mirrors writePage's own
// folder normalisation but rejects malformed inputs at the tool boundary so
// errors are surfaced cleanly to Claude instead of silently rewritten.
function validateAdditionalPath(p) {
  if (typeof p !== 'string' || !p) return 'path must be a non-empty string';
  if (p.includes('..') || p.startsWith('/')) return 'path must be relative and inside the wiki';
  if (!p.endsWith('.md')) return 'path must end in .md';
  const parts = p.split('/');
  if (parts.length !== 2) return 'path must be exactly <folder>/<slug>.md';
  const [folder, file] = parts;
  if (folder !== 'entities' && folder !== 'concepts') {
    return "folder must be 'entities/' or 'concepts/' (summaries/ is reserved for the auto-generated summary page)";
  }
  const slug = file.slice(0, -3);
  if (REFUSED_SLUGS.has(slug) || REFUSED_FILES.has(file)) return 'path targets a reserved file';
  if (!/^[a-z0-9][a-z0-9\-]*$/i.test(slug)) return `slug "${slug}" must be lowercase alphanumeric with hyphens`;
  return null;
}

// Programmatic index merge — same logic as src/brain/compile.js, kept here to
// keep the MCP tool fully self-contained without exporting compile.js's
// private helper (the in-app compile route's mergeIntoIndex is not exported
// publicly). If we ever extract it, the MCP tool should switch to the shared
// import — for now this is a deliberate small duplication.
function mergeIntoIndex(existingIndex, writeRecords) {
  const mentioned = new Set();
  const wikiLinkRe = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
  let m;
  while ((m = wikiLinkRe.exec(existingIndex)) !== null) {
    mentioned.add(m[1].split('/').pop());
  }
  const cellSafe = (s) => String(s || '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  const newRows = [];
  for (const entry of writeRecords) {
    if (!entry || !entry.record || entry.record.status !== 'created') continue;
    const canon = entry.record.canonPath;
    const slug = canon.replace(/\.md$/, '').split('/').pop();
    if (mentioned.has(slug)) continue;
    const folder = canon.split('/')[0];
    const type = folder === 'entities' ? 'entity' : folder === 'concepts' ? 'concept' : 'summary';
    const linkSlug = folder === 'summaries' ? `summaries/${slug}` : slug;
    const summary = cellSafe(entry.summaryHint);
    newRows.push(`| [[${linkSlug}]] | ${type} | ${summary} |`);
  }
  if (newRows.length === 0) return null;
  const lines = existingIndex.split('\n');
  let lastTableLine = -1;
  for (let i = 0; i < lines.length; i++) if (/^\|/.test(lines[i])) lastTableLine = i;
  if (lastTableLine >= 0) {
    lines.splice(lastTableLine + 1, 0, ...newRows);
    return lines.join('\n');
  }
  return existingIndex.trimEnd() + `\n\n## New pages\n\n| Page | Type | Summary |\n|---|---|---|\n${newRows.join('\n')}\n`;
}

// Build a human-readable one-line "report" Claude can render in chat without
// composing it from the structured changes array.
function buildReport(domain, changes, dryRun) {
  const created   = changes.filter(c => c.status === 'created').length;
  const updated   = changes.filter(c => c.status === 'updated').length;
  const unchanged = changes.filter(c => c.status === 'unchanged').length;
  const lead = dryRun ? 'Plan (dry run)' : 'Compiled';
  const parts = [];
  if (created)   parts.push(`${created} new page${created === 1 ? '' : 's'}`);
  if (updated)   parts.push(`${updated} updated`);
  if (unchanged) parts.push(`${unchanged} unchanged`);
  if (!parts.length) parts.push('no changes');
  return `${lead} → '${domain}': ${parts.join(', ')}.`;
}

// ── Link grounding (v2.5.5+) ────────────────────────────────────────────────
//
// compile_to_wiki gets called with content the LLM composed BLIND — it doesn't
// know which slugs already exist in the target domain. Without grounding,
// Claude invents `[[machine-learning-fundamentals]]` and similar speculative
// links that don't resolve, producing dozens of broken links per compile on
// fresh domains.
//
// We mirror the Pass A/B/C normalisation that writePage already runs at
// write-time (src/brain/files.js step 5c) — but apply it BEFORE writePage so
// we can also REPORT what couldn't be resolved (broken). writePage's own
// pass then runs on our pre-resolved content as a no-op.
//
// Why duplicate the logic instead of importing? writePage runs per-page and
// only knows the on-disk inventory. Our pre-pass also needs to know the
// paths being CREATED in the same compile (so internal cross-references work
// — e.g. the summary references concepts/foo.md while concepts/foo.md is
// being created in additional_pages). Pulling that into writePage would
// over-couple the in-app ingest path, which doesn't have this concern.

const TITLE_PREFIX_RE = /^(dr|mr|mrs|ms|prof|sir|lord|lady)-/;
const ARTICLE_PREFIX_RE = /^(the|a|an)-/;

/**
 * Read existing slugs from disk and union with the slugs being created in
 * THIS compile call. Returns sets and a prefix-tolerant lookup map suitable
 * for tryResolveLink().
 */
async function buildSlugInventory(wikiDir, newPages) {
  const list = async (dir) => {
    try { return (await readdir(dir)).filter(f => f.endsWith('.md')); }
    catch { return []; }
  };
  const entityFiles  = await list(path.join(wikiDir, 'entities'));
  const conceptFiles = await list(path.join(wikiDir, 'concepts'));
  const summaryFiles = await list(path.join(wikiDir, 'summaries'));

  const entitySlugs  = new Set(entityFiles.map(f => f.slice(0, -3)));
  const conceptSlugs = new Set(conceptFiles.map(f => f.slice(0, -3)));
  const summarySlugs = new Set(summaryFiles.map(f => f.slice(0, -3)));

  // Slugs being created in this compile — folder taken from the path's
  // first segment so cross-references work even when the file doesn't
  // exist on disk yet.
  for (const p of newPages || []) {
    if (typeof p?.path !== 'string') continue;
    const slug = path.basename(p.path, '.md');
    if (p.path.startsWith('entities/'))       entitySlugs.add(slug);
    else if (p.path.startsWith('concepts/'))  conceptSlugs.add(slug);
    else if (p.path.startsWith('summaries/')) summarySlugs.add(slug);
  }

  // Prefix-tolerant lookup (Pass C): article prefix stripped + hyphens removed
  const allSlugsMap = new Map();
  const addToMap = (slugs, summaryFolder) => {
    for (const s of slugs) {
      const key = s.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
      if (!allSlugsMap.has(key)) {
        allSlugsMap.set(key, summaryFolder ? { folder: 'summaries', slug: s } : { folder: null, slug: s });
      }
    }
  };
  addToMap(entitySlugs, false);
  addToMap(conceptSlugs, false);
  addToMap(summarySlugs, true);

  return { entitySlugs, conceptSlugs, summarySlugs, allSlugsMap };
}

/**
 * Resolve a single bare slug (folder prefix already stripped by caller)
 * against the inventory. Returns:
 *   { action: 'kept',       canonical: <same slug> }       — slug exists as-is
 *   { action: 'normalized', canonical: <normalised>, reason } — variant matched
 *   { action: 'broken',     canonical: null }              — no match found
 */
function tryResolveLink(slug, inventory) {
  const { entitySlugs, conceptSlugs, allSlugsMap } = inventory;

  // Already canonical?
  if (entitySlugs.has(slug) || conceptSlugs.has(slug)) {
    return { action: 'kept', canonical: slug };
  }

  // Pass A: title-prefix strip
  const stripped = slug.replace(TITLE_PREFIX_RE, '');
  if (stripped !== slug && (entitySlugs.has(stripped) || conceptSlugs.has(stripped))) {
    return { action: 'normalized', canonical: stripped, reason: 'title-prefix' };
  }

  // Pass B: hyphen-normalised match against entities and concepts
  const norm = slug.replace(/-/g, '').toLowerCase();
  for (const s of entitySlugs) {
    if (s.replace(/-/g, '').toLowerCase() === norm) {
      return { action: 'normalized', canonical: s, reason: 'hyphen-variant' };
    }
  }
  for (const s of conceptSlugs) {
    if (s.replace(/-/g, '').toLowerCase() === norm) {
      return { action: 'normalized', canonical: s, reason: 'hyphen-variant' };
    }
  }

  // Pass C: prefix-tolerant lookup (article + hyphen stripped)
  const normKey = slug.replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
  const hit = allSlugsMap.get(normKey);
  if (hit) {
    const target = hit.folder ? `${hit.folder}/${hit.slug}` : hit.slug;
    return { action: 'normalized', canonical: target, reason: 'prefix-tolerant' };
  }

  return { action: 'broken', canonical: null };
}

/**
 * Walk every [[wikilink]] in `content` and resolve it against the inventory.
 *
 * Handles:
 *   [[bare-slug]], [[summaries/foo]] (folder-prefixed), [[slug|alias]],
 *   `[[ slug ]]` (whitespace inside brackets).
 *
 * Returns the (possibly-rewritten) content plus stats so the caller can build
 * the v2.5.5 `links` response field and decide on `broken_link_policy`.
 *
 * Policy options:
 *   'keep'    — write broken links as-is, surface in the response
 *   'strip'   — replace `[[X]]` with the human-readable text (hyphens → spaces)
 *               so the prose still reads naturally but no broken link lands on disk
 *   'refuse'  — caller checks broken.length > 0 and aborts the entire compile
 */
function resolveLinksInContent(content, inventory, policy) {
  const broken = [];
  const normalized = [];
  let kept = 0;

  const newContent = content.replace(/\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g, (match, rawTarget, alias) => {
    let target = rawTarget.trim();
    let folderPrefix = '';
    if (target.includes('/')) {
      const idx = target.indexOf('/');
      folderPrefix = target.slice(0, idx + 1);
      target = target.slice(idx + 1);
    }

    const r = tryResolveLink(target, inventory);

    if (r.action === 'kept') {
      kept++;
      // If the source link had a wrong folder prefix (e.g. [[summaries/foo]]
      // pointing at entities/foo), strip the wrong prefix so the link
      // actually resolves in Obsidian. Mirrors writePage step 5b's strip of
      // entities/ and concepts/ prefixes — but here we have folder context
      // from inventory, so we can also fix mismatched [[summaries/...]]
      // pointing at an entity or concept.
      if (folderPrefix && folderPrefix !== 'summaries/') {
        // Source had entities/ or concepts/ — writePage step 5b will strip
        // it downstream. We could pre-strip here, but leave it to writePage
        // to keep this module focused on resolution-not-rewrite.
        return match;
      }
      if (folderPrefix === 'summaries/') {
        // Source said [[summaries/X]] but X resolved to an entity or
        // concept (not a summary). Drop the wrong prefix.
        return `[[${r.canonical}${alias || ''}]]`;
      }
      return match;
    }
    if (r.action === 'normalized') {
      normalized.push({ from: rawTarget.trim(), to: r.canonical, reason: r.reason });
      // r.canonical may itself include a folder (Pass C summary hit). Otherwise
      // preserve whatever folder prefix the source link had.
      const newTarget = r.canonical.includes('/') ? r.canonical : (folderPrefix + r.canonical);
      return `[[${newTarget}${alias || ''}]]`;
    }

    // Broken
    broken.push(rawTarget.trim());
    if (policy === 'strip') {
      // Drop brackets, render the text human-readably (hyphens → spaces).
      // Aliased links keep their alias text instead of the slug for nicer prose.
      const fallback = (alias ? alias.slice(1).trim() : target).replace(/-/g, ' ');
      return fallback;
    }
    return match; // keep / refuse — leave the link literal in content
  });

  return { content: newContent, kept, normalized, broken };
}

/**
 * Deduplicate broken links across the per-page results so the response
 * doesn't list the same `[[X]]` 5 times if a page references it 5 times.
 * Preserves first-seen file location for context.
 */
function dedupeBroken(brokenList) {
  const seen = new Map();
  for (const b of brokenList) {
    if (!seen.has(b.link)) seen.set(b.link, b);
  }
  return [...seen.values()];
}

export async function compileToWikiHandler(args, storage) {
  // ── 1. Validate inputs ─────────────────────────────────────────────────────
  const { title, summary_content, additional_pages } = args || {};
  const dry_run = !!args?.dry_run;
  const linkPolicy = args?.broken_link_policy || 'keep';
  if (!['keep', 'strip', 'refuse'].includes(linkPolicy)) {
    return { ok: false, error: `broken_link_policy must be 'keep', 'strip', or 'refuse'; got '${linkPolicy}'` };
  }

  const resolved = await resolveDomainArg(args, storage, getDefaultDomain);
  if (resolved.error) return { ok: false, error: resolved.error };
  const domain = resolved.value;

  if (typeof title !== 'string' || !title.trim()) {
    return { ok: false, error: 'title is required and must be a non-empty string' };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `title exceeds max length (${MAX_TITLE_LENGTH})` };
  }
  if (typeof summary_content !== 'string' || !summary_content.trim()) {
    return { ok: false, error: 'summary_content is required and must be a non-empty string' };
  }
  if (Buffer.byteLength(summary_content, 'utf8') > MAX_PAGE_BYTES) {
    return { ok: false, error: `summary_content exceeds per-page cap (${MAX_PAGE_BYTES} bytes)` };
  }
  if (summary_content.length > MAX_SUMMARY_LENGTH) {
    return { ok: false, error: `summary_content exceeds max length (${MAX_SUMMARY_LENGTH} chars)` };
  }

  // additional_pages — optional, validated per-item
  const extra = Array.isArray(additional_pages) ? additional_pages : [];
  if (extra.length + 1 > MAX_PAGES) {
    return { ok: false, error: `Too many pages: ${extra.length + 1} requested, max ${MAX_PAGES} per call.` };
  }
  for (let i = 0; i < extra.length; i++) {
    const p = extra[i];
    if (!p || typeof p !== 'object') return { ok: false, error: `additional_pages[${i}] must be an object` };
    const pathErr = validateAdditionalPath(p.path);
    if (pathErr) return { ok: false, error: `additional_pages[${i}].path: ${pathErr}` };
    if (typeof p.content !== 'string' || !p.content.trim()) {
      return { ok: false, error: `additional_pages[${i}].content must be a non-empty string` };
    }
    if (Buffer.byteLength(p.content, 'utf8') > MAX_PAGE_BYTES) {
      return { ok: false, error: `additional_pages[${i}].content exceeds per-page cap (${MAX_PAGE_BYTES} bytes)` };
    }
  }

  // ── 2. Compute deterministic summary slug (idempotent on re-compile) ──────
  const today = todayISO();
  const corpus = `${title}\n${summary_content}\n` + extra.map(p => `${p.path}\n${p.content}`).join('\n');
  const summarySlug = `${slugify(title)}-${today}-${shortHash(corpus)}`;
  const summaryPath = `summaries/${summarySlug}.md`;
  const wikiDir = wikiPath(domain);
  const summaryFullPath = path.join(wikiDir, summaryPath);

  if (existsSync(summaryFullPath) && !dry_run) {
    return {
      ok: false,
      error: `Already compiled to ${summaryPath}. Same content + title + date detected. Either change the title, extend the conversation with new findings, or delete that file in the wiki to start over.`,
    };
  }

  // ── 2.5. Pre-write link grounding (v2.5.5+) ──────────────────────────────
  //
  // Resolve every [[wikilink]] in the summary + each additional page against
  // the union of (existing slugs on disk, slugs being created in this call).
  // - kept       — link already points to a real slug
  // - normalized — variant slug matched a real one (e.g. dr-foo → foo)
  // - broken     — no match; will be reported / stripped / refused per policy
  //
  // We do this BEFORE writePage so writePage's own Pass A/B/C runs as a no-op
  // on the already-resolved content, AND so we can refuse / report the
  // unresolved cases. Without this pre-pass, fresh domains routinely
  // accumulate dozens of broken links per compile.
  const allInputPages = [
    { path: summaryPath, content: summary_content },
    ...extra,
  ];
  const inventory = await buildSlugInventory(wikiDir, allInputPages);

  const resolvedPages = [];
  let totalKept = 0;
  const allNormalized = [];
  const allBrokenRaw = [];
  for (const p of allInputPages) {
    const r = resolveLinksInContent(p.content, inventory, linkPolicy);
    resolvedPages.push({ path: p.path, content: r.content });
    totalKept += r.kept;
    for (const n of r.normalized) allNormalized.push({ in: p.path, ...n });
    for (const link of r.broken) allBrokenRaw.push({ in: p.path, link });
  }
  const allBroken = dedupeBroken(allBrokenRaw);
  const linkStats = {
    total: totalKept + allNormalized.length + allBrokenRaw.length,
    resolved: totalKept,
    normalized: allNormalized.length,
    broken: allBroken,
    broken_count: allBroken.length,
    policy: linkPolicy,
  };

  // Refuse mode: bail BEFORE writing. Hand Claude a sample of valid slugs so
  // the retry loop is fast on big wikis.
  if (linkPolicy === 'refuse' && allBroken.length > 0) {
    const validSlugsSample = [
      ...[...inventory.entitySlugs].sort().slice(0, 30),
      ...[...inventory.conceptSlugs].sort().slice(0, 30),
    ];
    return {
      ok: false,
      error: `${allBroken.length} broken wikilink${allBroken.length === 1 ? '' : 's'} detected with broken_link_policy='refuse'. Either change those links to existing slugs, add the missing pages to additional_pages, or call again with broken_link_policy='keep'.`,
      links: linkStats,
      valid_slugs_sample: validSlugsSample,
    };
  }

  // ── 3. Dry-run: simulate the writes without touching disk ─────────────────
  if (dry_run) {
    const planned = resolvedPages.map(p => ({
      path: p.path,
      status: p.path === summaryPath
        ? 'created'
        : (existsSync(path.join(wikiDir, p.path)) ? 'updated' : 'created'),
      bytes: Buffer.byteLength(p.content, 'utf8'),
    }));
    const brokenSuffix = allBroken.length
      ? ` ⚠️ ${allBroken.length} broken link${allBroken.length === 1 ? '' : 's'} would land in the wiki (see \`links.broken\`).`
      : '';
    return {
      ok: true,
      dry_run: true,
      domain,
      title,
      summary_path: summaryPath,
      planned_pages: planned,
      links: linkStats,
      report: `Plan (dry run) → '${domain}': would write ${planned.length} page${planned.length === 1 ? '' : 's'} (${planned.filter(p => p.status === 'created').length} new, ${planned.filter(p => p.status === 'updated').length} updated).${brokenSuffix} Call again with dry_run: false to commit.`,
    };
  }

  // ── 4. Real write: pages → syncSummaryEntities → index → log → audit ──────
  // Use the link-resolved content (normalized variants applied; brokens
  // either preserved or stripped per policy).
  const resolvedSummary = resolvedPages.find(p => p.path === summaryPath)?.content ?? summary_content;
  const resolvedExtra = resolvedPages.filter(p => p.path !== summaryPath);

  const writeRecords = [];

  // 4a. Summary page
  const summaryRecord = await writePage(domain, summaryPath, resolvedSummary);
  if (summaryRecord) {
    writeRecords.push({
      originalPath: summaryPath,
      record: summaryRecord,
      summaryHint: title.slice(0, 160),
    });
  } else {
    return { ok: false, error: 'Failed to write summary page (writePage returned null)' };
  }

  // 4b. Additional pages
  for (const p of resolvedExtra) {
    const rec = await writePage(domain, p.path, p.content);
    if (rec) {
      writeRecords.push({
        originalPath: p.path,
        record: rec,
        // Use the first non-empty line of the content (after the heading) as
        // the index summary — small heuristic, keeps index rows informative.
        summaryHint: extractFirstSentence(p.content),
      });
    }
  }

  // 4c. Sync summary backlinks (entities mentioned → backlink to summary)
  const canonicalPaths = writeRecords.map(w => w.record.canonPath);
  const summaryCanon = canonicalPaths.find(p => p.startsWith('summaries/'));
  if (summaryCanon) {
    await syncSummaryEntities(domain, summaryCanon, canonicalPaths);
  }

  // 4d. Programmatic index merge (no LLM call — same approach as v2.5.0 compile)
  const existingIndex = await readIndex(domain);
  const mergedIndex = mergeIntoIndex(existingIndex, writeRecords);
  if (mergedIndex) {
    const indexRecord = await writePage(domain, 'index.md', mergedIndex);
    if (indexRecord) writeRecords.push({ originalPath: 'index.md', record: indexRecord });
  }

  // 4e. Append to log
  const pageList = canonicalPaths.map(p => `  - ${p}`).join('\n');
  const logEntry = `## [${today}] mcp:compile_to_wiki | ${title}\nPages created or updated:\n${pageList}\n`;
  try { await appendLog(domain, logEntry); } catch (err) { console.error('[compile_to_wiki] appendLog failed:', err.message); }

  // 4f. Audit log (machine-private, gitignored). Includes link stats so the
  //     user can later trace which compiles introduced broken links.
  try {
    await storage.appendToWriteAudit(domain, {
      ts: new Date().toISOString(),
      tool: 'compile_to_wiki',
      title,
      summary_path: summaryCanon || summaryPath,
      paths: writeRecords.map(w => w.record.canonPath),
      bytes: writeRecords.reduce((sum, w) => sum + (w.record.bytesAfter || 0), 0),
      links: {
        resolved: linkStats.resolved,
        normalized: linkStats.normalized,
        broken: linkStats.broken_count,
        policy: linkPolicy,
      },
    });
  } catch { /* best-effort */ }

  // ── 5. Build response ─────────────────────────────────────────────────────
  const changes = writeRecords.map(w => ({
    canonPath:       w.record.canonPath,
    status:          w.record.status,
    bytesBefore:     w.record.bytesBefore,
    bytesAfter:      w.record.bytesAfter,
    sectionsChanged: w.record.sectionsChanged || [],
    bulletsAdded:    w.record.bulletsAdded || 0,
  }));

  // Link analysis is the most actionable signal in the response — make it
  // easy for Claude to spot broken links and propose follow-ups.
  const baseReport = buildReport(domain, changes, false);
  const linkSuffix =
    allBroken.length === 0
      ? (allNormalized.length ? ` All ${linkStats.total} wikilinks resolved (${allNormalized.length} auto-normalised from variants).` : '')
      : linkPolicy === 'strip'
        ? ` ${allBroken.length} broken link${allBroken.length === 1 ? '' : 's'} stripped (rendered as plain text). See \`links.broken\` for what was dropped.`
        : ` ⚠️ ${allBroken.length} broken link${allBroken.length === 1 ? '' : 's'} written as-is. See \`links.broken\` — consider adding those pages to additional_pages on a follow-up call, or use broken_link_policy='strip' / 'refuse'.`;

  return {
    ok: true,
    domain,
    title,
    summary_path: summaryCanon || summaryPath,
    pages_written: canonicalPaths,
    changes,
    links: linkStats,
    report: baseReport + linkSuffix,
    next:
      allBroken.length > 0
        ? 'Review `links.broken`. To add the missing pages, call compile_to_wiki again with `additional_pages` covering those slugs.'
        : 'Use get_node or get_summary to read any of the pages back, or scan_wiki_health to check for any issues introduced.',
  };
}

function extractFirstSentence(content) {
  // Strip the leading heading (# Title) and any blank lines, take the first
  // sentence-ish chunk for the index summary cell.
  const stripped = content
    .split('\n')
    .filter(l => !l.startsWith('# ') && l.trim())
    .join(' ');
  const firstSentence = stripped.split(/[.!?]/)[0] || stripped;
  return firstSentence.replace(/[*_`#\[\]]/g, '').slice(0, 160).trim();
}
