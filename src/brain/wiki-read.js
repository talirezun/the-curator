/**
 * src/brain/wiki-read.js
 *
 * Read-only, single-page wiki access for the app's HTTP surface.
 *
 * Why this exists: `GET /api/wiki/:domain` (src/routes/wiki.js, pre-existing)
 * returns EVERY page in the domain with full content — 14 MB on the real
 * `articles` domain. The redesigned chat UI's citation-chip reader needs to
 * open exactly one page (title, frontmatter, body) plus its backlinks
 * (every page that links to it), without paying for the rest of the domain.
 *
 * Graph-logic sharing decision (see CLAUDE.md "Active workstream" context /
 * task brief): `mcp/graph.js` already parses frontmatter, [[wikilinks]], and
 * backlinks for the MCP server. This module deliberately does NOT import
 * from `mcp/`. It IS imported under `mcp/` as of v3.40.0 — `mcp/storage/local.js`
 * imports `resolveInsideWiki` from here, specifically to reuse this module's
 * symlink-aware path guard rather than keep a second hand-maintained copy —
 * so the stdout-purity obligation below is not theoretical: the MCP server
 * runs as a stdio JSON-RPC child process where a stray `console.log`
 * (or any surprise transitive import) corrupts the protocol stream (see the
 * v2.5.3 "MCP stdout pollution" fix in CLAUDE.md). This module and everything
 * it imports must stay stdout-silent for exactly that reason. The frontmatter parser below is
 * intentionally a close mirror of mcp/graph.js's `parseFrontmatter` (same
 * bracket-tags convention, same key:value shape) so the two independent
 * readers agree on what a page's metadata means — see the module docblock
 * comment above `parseFrontmatter` for the parity note.
 *
 * Link-resolution parity: backlinks here use EXACTLY the same "does this
 * [[link]] point at that page" rule that src/brain/health.js's scanWiki()
 * uses to decide whether a link is broken (see `linkPointsToPage` below).
 * Two independently-implemented resolvers would eventually disagree, and
 * the disagreement would surface as "the app says this link is broken but
 * the reader shows it working" — so this module is intentionally NOT more
 * clever than health.js: bare `[[slug]]` links resolve only against
 * entities/ and concepts/ (never summaries/, which always needs the
 * `summaries/` prefix per wiki convention), and `[[folder/slug]]` links
 * resolve only on an EXACT folder+slug match. The hyphen/title-prefix fuzzy
 * matching Pass A/B/C in files.js and health.js's `normKey()` is used ONLY
 * to *suggest fixes* for broken links — it is deliberately not used to
 * decide whether a link "exists" for backlink purposes, matching health.js.
 *
 * That parity claim is precise, and it used to be an overclaim (v3.2.0
 * audit finding M4). health.js builds its slug sets with a SHALLOW readdir
 * (`listMd`) but scans link SOURCES recursively (`walkMdFiles`), so a page
 * at `entities/companies/nested-corp.md` is a link source health.js reads,
 * yet NOT a link target health.js can resolve — every `[[nested-corp]]` in
 * the wiki is reported broken by the Health tab. This module derived a
 * target slug from the basename at ANY depth, so the reader happily showed
 * backlinks for a page whose inbound links Health calls broken. The two
 * now agree by construction: a *link target* is exactly a depth-1 file in a
 * canonical folder (`<entities|concepts|summaries>/<slug>.md`), which is
 * also the only shape writePage can produce (it FLATTENS nested paths — see
 * the v3.0.16 entry in CLAUDE.md). A nested file can still be OPENED by
 * this reader (it exists, the user can see it in Obsidian), and it
 * truthfully reports ZERO backlinks, because no link in the wiki resolves
 * to it as far as the rest of the app is concerned. Link SOURCES stay
 * recursive, matching health.js's `walkMdFiles`.
 *
 * Read-only: this module never writes to the wiki. The single write path is
 * `writePage` in files.js — nothing here calls it, and nothing here should.
 *
 * MCP-process note (v3.2.0): `resolveInsideWiki` below is now THE path
 * chokepoint for health.js too — health.js imports it instead of keeping a
 * second, separately-hardened copy (the audit found exactly the drift that
 * predicts: the write side had a symlink defense, the read side did not).
 * health.js IS imported by `mcp/tools/health.js`, so this module is now
 * transitively loaded in the MCP stdio child process. It therefore MUST
 * keep stdout pure — no `console.log` anywhere in this file, ever (use
 * `console.error`; see the v2.5.3 "MCP stdout pollution" fix in CLAUDE.md).
 * It still does not import anything from `mcp/`.
 */
import { readFile, readdir, stat } from 'fs/promises';
import { existsSync, lstatSync, realpathSync } from 'fs';
import path from 'path';
import { wikiPath } from './files.js';
// listWikiInventory() below reuses health.js's listMd — the SAME gated,
// symlink-aware directory listing scanWiki() uses to build its page
// inventory — rather than a third hand-rolled readdir. See listWikiInventory's
// own docblock for why importing (not copying) it is load-bearing here, the
// same way health.js imports resolveInsideWiki from THIS file rather than
// keeping a second copy (the v3.2.0 CRITICAL was exactly two hand-maintained
// copies of a path guard drifting apart).
//
// This makes health.js <-> wiki-read.js a circular import. That is safe here
// because both symbols crossing the cycle (`resolveInsideWiki` below,
// `listMd` in health.js) are `function`/`export function` DECLARATIONS, which
// are hoisted and bound during ES module instantiation — before either
// module's body executes — so it does not matter which module Node happens
// to load first. Neither module calls the other's export at module-eval
// time (only from inside request-handled async functions), which is the
// property that must hold for that to stay true; do not add a top-level call
// across this boundary.
import { listMd } from './health.js';

const CANONICAL_FOLDERS = new Set(['entities', 'concepts', 'summaries']);

// Same regex health.js's scanWiki() uses to find [[wikilinks]] in a page body
// (excludes anchors after `#` and an optional `|alias`). Keeping this
// byte-identical to health.js is load-bearing for the parity guarantee above.
const LINK_RE = /\[\[([^\]|#\n]+?)(\|[^\]]+)?\]\]/g;

// ─────────────────────────────────────────────────────────────────────────
// Path safety — THE single chokepoint for "is this path inside the wiki?".
// health.js imports this function rather than keeping its own copy (see the
// MCP note in the module docblock). The page path is client-supplied (a
// query param on the read side, an LLM-authored issue object on health.js's
// fix side); callers must not assume upstream validation already happened.
//
// Two independent checks, both required:
//
//   1. LEXICAL — `path.resolve` + `path.relative`, refusing absolute inputs
//      and anything whose resolved STRING lands outside wikiDir. This is
//      what the function did before v3.2.0.
//
//   2. PHYSICAL — realpath-based containment. The lexical check refuses a
//      path that *reads* like an escape; it says nothing about what the
//      path POINTS AT. A symlink at `wiki/entities/leak.md` →
//      `/anywhere/secret.md` has a perfectly in-bounds string and served
//      the outside file with a 200 (v3.2.0 audit finding H1, reproduced);
//      a symlinked DIRECTORY escaped wholesale, exposing every readable
//      `.md` beneath it — and, through health.js's fix handlers, exposing
//      real outside files to `rm()` and `writeFileAtomic()`.
//
// This asymmetry was already understood on the WRITE side: atomic-write.js
// lstats a target and refuses to write through a symlink, and
// sharedbrain.js lstats before writing a mirror page. The read side simply
// never got the same treatment. This makes it symmetric.
//
// Reachable without any local attacker: git materialises mode-120000
// entries, so a symlink arrives through a Personal Sync pull, a Shared
// Brain mirror pull, a restored or third-party wiki, or a user symlinking
// folders into their Obsidian vault (a documented workflow).
//
// Deliberate behaviours:
//   • A symlink whose target resolves BACK INSIDE the wiki is allowed —
//     it is not an escape, and refusing it would break a legitimate
//     in-wiki alias.
//   • A DANGLING symlink is refused, not opened and not thrown on. Its
//     realpath cannot be established, so containment cannot be proven, and
//     "cannot prove" must mean "refuse" for a security check. (A write
//     through it would also replace the link with a regular file.)
//   • A path that does not exist YET is still checked, by resolving the
//     deepest existing ancestor — otherwise a fresh write into a symlinked
//     directory would sail through.
//   • Any realpath failure (permissions, races, exotic filesystems) is
//     caught and treated as "not provably contained" → refuse. Nothing
//     here throws; callers get `null` exactly as they did before.
//   • If wikiDir ITSELF cannot be realpath'd, it does not exist, so nothing
//     can exist inside it either — the lexical result stands and the fs
//     call the caller makes next fails on its own merits. (This also keeps
//     macOS's /var → /private/var symlink from producing spurious
//     refusals when a domain has no wiki/ folder at all.)
// ─────────────────────────────────────────────────────────────────────────

// Bounds the ancestor walk below. A wiki path is 2–3 segments deep; 64 is
// "impossible in practice" while still guaranteeing termination.
const MAX_ANCESTOR_ASCENT = 64;

function realpathOrNull(p) {
  // realpathSync.native (not the JS implementation) — it delegates to the
  // platform realpath(3), which additionally returns the TRUE ON-DISK CASE
  // on case-insensitive filesystems. canonicalRelPath() below depends on
  // that; the JS variant preserves the caller's casing and would not fix
  // the case-mismatch bug (v3.2.0 audit finding M5).
  try { return realpathSync.native(p); } catch { return null; }
}

function relIsInside(realRoot, candidate) {
  if (candidate === realRoot) return true;
  const rel = path.relative(realRoot, candidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Is `resolved` (already lexically inside `rootDir`) ALSO physically inside
 * it once every symlink on the way is followed? Never throws.
 */
function isPhysicallyInside(rootDir, resolved) {
  const realRoot = realpathOrNull(rootDir);
  if (!realRoot) return true;   // root absent — see the docblock's last bullet

  // Leaf is itself a symlink: it must resolve, and resolve inside.
  let leaf = null;
  try { leaf = lstatSync(resolved); } catch { /* leaf absent — handled below */ }
  if (leaf && leaf.isSymbolicLink()) {
    const realLeaf = realpathOrNull(resolved);
    if (!realLeaf) return false;            // dangling → cannot prove → refuse
    return relIsInside(realRoot, realLeaf);
  }

  // Otherwise realpath the deepest ancestor that exists and re-attach the
  // not-yet-existing tail, so symlinked ANCESTOR directories are caught for
  // paths that don't exist yet.
  let probe = resolved;
  const tail = [];
  for (let i = 0; i <= MAX_ANCESTOR_ASCENT; i++) {
    const real = realpathOrNull(probe);
    if (real) {
      return relIsInside(realRoot, tail.length ? path.join(real, ...tail) : real);
    }
    const parent = path.dirname(probe);
    if (parent === probe) return false;     // hit the filesystem root
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  return false;
}

export function resolveInsideWiki(wikiDir, candidate) {
  if (typeof candidate !== 'string' || !candidate) return null;
  if (path.isAbsolute(candidate)) return null;
  const resolved = path.resolve(wikiDir, candidate);
  const rel = path.relative(wikiDir, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!isPhysicallyInside(wikiDir, resolved)) return null;
  return resolved;
}

/**
 * The page's path as it ACTUALLY exists on disk, relative to wikiDir and
 * with forward slashes — or null if that can't be established.
 *
 * Exists because of v3.2.0 audit finding M5: on a case-insensitive
 * filesystem (every default macOS install, and Windows) a request for
 * `entities/TALI-REZUN.md` reads the file fine, but every downstream
 * identity derived from the REQUEST string — the slug, and therefore the
 * backlink lookup — carried the caller's casing. The page opened with a
 * confident "0 backlinks" on an entity that has ~50. Chat citations are
 * LLM-emitted text and models routinely alter case, so this is the normal
 * path, not an edge case.
 *
 * realpath(3) hands back the true on-disk spelling, so identity is taken
 * from the filesystem rather than from user input. On a case-SENSITIVE
 * filesystem a mis-cased request simply doesn't exist and 404s earlier —
 * also correct.
 */
export function canonicalRelPath(wikiDir, absPath) {
  const realRoot = realpathOrNull(wikiDir);
  const real = realpathOrNull(absPath);
  if (!realRoot || !real) return null;
  const rel = path.relative(realRoot, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Normalise a client-supplied page path before it ever reaches
 * resolveInsideWiki(). Rejects the shapes that are unambiguously hostile
 * (absolute paths, `..`/`.` segments, control characters, backslashes)
 * up front so resolveInsideWiki is a backstop, not the only line of
 * defense. Returns null for anything invalid.
 *
 * Accepts paths with or without the trailing `.md` (the app's citation
 * chips and readWikiPages() both hand out paths WITH `.md`, e.g.
 * "entities/tali-rezun.md" — but query-string ergonomics shouldn't require it).
 */
export function normaliseRequestedPath(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Escape sequences, NOT the raw bytes this line used to contain. A
  // literal NUL in the source made git classify this entire file as
  // BINARY — `git diff` reported "Bin 16851 -> 30986 bytes" instead of a
  // reviewable patch, and plain `grep` skipped it without -a — on the one
  // file that carries the path-traversal and symlink guards. Identical
  // character class (U+0000–U+001F), now readable, greppable and diffable.
  if (/[\u0000-\u001f]/.test(trimmed)) return null;   // control chars / null bytes
  if (trimmed.includes('\\')) return null;             // no backslashes
  if (path.isAbsolute(trimmed)) return null;            // no absolute paths (unix or drive-letter)
  if (/^[a-zA-Z]:/.test(trimmed)) return null;          // defensive: windows drive-letter form
  if (trimmed.split('/').some(seg => seg === '..' || seg === '.')) return null;
  let p = trimmed;
  if (!p.toLowerCase().endsWith('.md')) p += '.md';
  return p;
}

function folderOf(relPath) {
  const seg = relPath.split('/')[0];
  return CANONICAL_FOLDERS.has(seg) ? seg : null;
}

function slugOf(relPath) {
  const base = relPath.split('/').pop();
  // Case-insensitive extension strip: a file genuinely named `Foo.MD` on
  // disk used to yield the slug "Foo.MD" (line 91 lowercased for the
  // endsWith test, this one did not) — v3.2.0 audit finding M5.
  return /\.md$/i.test(base) ? base.slice(0, -3) : base;
}

/**
 * Is this relative path a *link target* the rest of the app can resolve?
 *
 * Exactly health.js's rule, and the only shape writePage produces: a file
 * directly inside one of the three canonical folders — `entities/x.md`,
 * never `entities/companies/x.md` (health.js's slug sets come from a
 * shallow `listMd`, so a nested file is a link source it reads but not a
 * target it can resolve). See the parity paragraph in the module docblock.
 */
function isResolvableTargetPath(relPath) {
  const parts = relPath.split('/');
  return parts.length === 2 && CANONICAL_FOLDERS.has(parts[0]) && /\.md$/i.test(parts[1]);
}

/**
 * Parse a wiki page's YAML frontmatter block.
 *
 * Deliberately a small, dependency-free regex parser — no YAML library.
 * Structurally mirrors mcp/graph.js's parseFrontmatter (same bracketed
 * `tags: [a, b, c]` convention, same "one key: value per line" shape) so
 * that reading the same page through the app and through the MCP produces
 * the same tags/type/source metadata. Duplicated rather than imported —
 * see the module docblock's graph-sharing note.
 */
export function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return { frontmatter: {}, body: content || '' };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: content };

  const yaml = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, '');
  const fm = {};

  for (const line of yaml.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();

    if (key === 'tags') {
      const inner = value.replace(/^\[|\]$/g, '');
      const raw = inner.split(',').map(s => s.trim()).filter(Boolean);
      fm.tags = [...new Set(raw)];
    } else {
      fm[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter: fm, body };
}

/**
 * Derive a page's display title: an explicit frontmatter `title` (not part
 * of the Curator's normal write path, but harmless to honour if present),
 * else the first `# Heading` line in the body (the convention every wiki
 * page actually follows — see health-ai.js's firstParagraph()), else a
 * humanised form of the slug as a last resort.
 */
export function deriveTitle(frontmatter, body, slug) {
  if (frontmatter && typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }
  const m = body.match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].trim();
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Does raw [[link]] target `raw` point at the page identified by
 * (targetFolder, targetSlug)? EXACTLY mirrors health.js's scanWiki() "exists"
 * check (see the module docblock's link-resolution-parity note):
 *   - "folder/slug" form: exact folder + exact slug match only.
 *   - bare "slug" form: resolves ONLY against entities/ and concepts/ pages
 *     (never summaries/ — those always need the folder prefix by convention).
 * No hyphen/title-prefix fuzzy matching — that's a broken-link *suggestion*
 * feature in health.js, not part of what makes a link "exist".
 */
export function linkPointsToPage(raw, targetFolder, targetSlug) {
  if (raw.includes('/')) {
    const parts = raw.split('/');
    const folder = parts[0];
    const slug = parts[1];
    return folder === targetFolder && slug === targetSlug;
  }
  if (targetFolder !== 'entities' && targetFolder !== 'concepts') return false;
  return raw === targetSlug;
}

async function walkAllMdFiles(rootDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // Dirents reflect lstat, so a symlinked directory reports
      // isDirectory() === false and is never recursed into — but a
      // symlinked .md FILE would previously be read and indexed like any
      // other page, quietly pulling an outside file's title and links into
      // the backlink index. Same refusal as resolveInsideWiki's (H1), and
      // consistent with the write side: atomic-write.js refuses to write
      // through a symlink, so a symlinked page is not a shape this app can
      // ever have produced.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full);
      else if (/\.md$/i.test(e.name)) out.push(full);
    }
  }
  if (existsSync(rootDir)) await walk(rootDir);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Backlink index cache.
//
// Backlinks inherently require a domain-wide scan (some other page's body
// might link here), which is the one part of this module that can't be
// "read one file" cheap. Correctness is the priority (a stale backlink list
// right after an ingest would be a real, confusing bug), so invalidation is
// signature-based rather than time-based:
//
//   1. On every request, compute a CHEAP signature: a recursive readdir +
//      stat() over every .md file in the domain's wiki/ (no readFile — cost
//      scales with page COUNT, not content size, which matters on domains
//      with a 14 MB wiki). The signature is
//      {count, sumMtimeMs, sumSizeBytes}.
//   2. If it matches the cached signature, reuse the cached parsed-link
//      index — no content re-read at all.
//   3. If it differs, do the expensive pass once: read every file, extract
//      [[links]] + title, and cache the result under the freshly-computed
//      signature.
//
// Why SUMS and not a max (v3.2.0 audit finding H5). The original signature
// was {count, maxMtimeMs}, and a max is a RATCHET: one file whose mtime is
// ahead of the wall clock pins maxMtimeMs at that value forever, so every
// subsequent legitimate write compares `< max`, the signature never moves,
// and — because the deliberate design has no TTL — the index stays frozen
// for the entire life of the (long-running) app process, with no recovery
// short of a restart. That is not exotic: iCloud/Dropbox/Obsidian Sync with
// one device ahead, `rsync -a`, `cp -p`, `tar -x`, Time Machine restores,
// and an NTP step-back all produce future or preserved mtimes. A sum has no
// ratchet — any file's mtime changing in EITHER direction changes the sum —
// and costs exactly the same syscalls.
//
// sumSizeBytes comes free from the same stat() and closes the cases a
// count+mtime signature still missed: a same-mtime rewrite (edits landing
// inside filesystem mtime granularity) and a count-preserving add+delete of
// files whose mtimes happen to coincide (`cp -p` again).
//
// Honest limits — this is a heuristic, not a content hash. It cannot see a
// change that preserves the file count AND the total mtime AND the total
// byte size simultaneously (e.g. swapping two equal-length bodies with
// identical timestamps). A TTL was considered as a floor for that residue
// and deliberately rejected: it would impose a periodic full re-read of
// every page on every domain — the exact cost this cache exists to avoid —
// to insure against a case with no known real-world trigger, while doing
// nothing the sums don't already do for the cases that DO occur. The
// failure mode that mattered was "frozen permanently, no recovery"; sums
// remove it outright, because the very next write of any kind moves them.
//
// This remains stronger than the MCP graph cache's file-count-only
// invalidation (mcp/graph.js) — file count alone misses "re-ingest edited
// an existing page's Related section". MCP's cache doesn't need more:
// Claude Desktop spawns a fresh process per session, so within-session
// edits are rare. This app process is long-running (ingests happen against
// the SAME running process the reader panel queries), so a cache that only
// invalidated on file count would go stale in exactly the case that matters
// most: "I just ingested something, do this page's backlinks reflect it?"
//
// index.md and log.md are excluded from both the signature and the parsed
// index — they aren't wiki pages (mirrors health.js's scanWiki(), which
// skips them from its link scan for the same reason), and excluding them
// means a bare `appendLog()` write (which touches log.md on every ingest)
// doesn't force a full backlink rebuild on its own.
// ─────────────────────────────────────────────────────────────────────────
const backlinkCache = new Map(); // domain → { signature: {count, sumMtimeMs, sumSizeBytes}, entries: [...] }

function isAppManagedRootFile(relPath) {
  return relPath === 'index.md' || relPath === 'log.md';
}

function sameSignature(a, b) {
  return !!a && !!b
    && a.count === b.count
    && a.sumMtimeMs === b.sumMtimeMs
    && a.sumSizeBytes === b.sumSizeBytes;
}

async function computeCheapSignature(wikiDir) {
  const absFiles = await walkAllMdFiles(wikiDir);
  let count = 0;
  let sumMtimeMs = 0;
  let sumSizeBytes = 0;
  for (const abs of absFiles) {
    const relPath = path.relative(wikiDir, abs);
    if (isAppManagedRootFile(relPath)) continue;
    let s;
    try { s = await stat(abs); } catch { continue; }
    count += 1;
    sumMtimeMs += s.mtimeMs;
    sumSizeBytes += s.size;
  }
  return { count, sumMtimeMs, sumSizeBytes };
}

async function buildLinkIndex(wikiDir) {
  const absFiles = await walkAllMdFiles(wikiDir);
  let count = 0;
  let sumMtimeMs = 0;
  let sumSizeBytes = 0;
  const entries = [];
  for (const abs of absFiles) {
    const relPath = path.relative(wikiDir, abs);
    if (isAppManagedRootFile(relPath)) continue;

    let s;
    try { s = await stat(abs); } catch { continue; }
    count += 1;
    sumMtimeMs += s.mtimeMs;
    sumSizeBytes += s.size;

    let content;
    try { content = await readFile(abs, 'utf8'); } catch { continue; }

    const folder = folderOf(relPath);        // null if the file lives outside the 3 canonical folders
    // Slug + title are derived for EVERY source file, canonical or not.
    // Previously both were null for a non-canonical file (a stray note at
    // wiki/ root, say), and since the reader panel renders
    // `title || slug`, such a backlink arrived as a blank, clickable row
    // that 400s when clicked — v3.2.0 audit finding L2. These files are
    // genuine link sources (health.js scans them too), so the answer is to
    // LABEL them, not to drop them. `readable` tells a caller whether the
    // row can actually be opened through getWikiPage().
    const slug = slugOf(relPath);
    const { frontmatter, body } = parseFrontmatter(content);
    const title = deriveTitle(frontmatter, body, slug);

    const links = [];
    LINK_RE.lastIndex = 0;
    let m;
    while ((m = LINK_RE.exec(content)) !== null) {
      links.push(m[1].trim());
    }

    entries.push({ relPath, folder, slug, title, links, readable: folder !== null });
  }
  return { signature: { count, sumMtimeMs, sumSizeBytes }, entries };
}

async function getOrBuildIndex(domain, wikiDir) {
  const cheapSig = await computeCheapSignature(wikiDir);
  const cached = backlinkCache.get(domain);
  if (cached && sameSignature(cached.signature, cheapSig)) return cached;
  const built = await buildLinkIndex(wikiDir);
  backlinkCache.set(domain, built);
  return built;
}

/**
 * Test-only cache reset. Production code never needs this — the signature
 * check already invalidates correctly on any real content change. Exposed
 * so tests can force a rebuild without depending on filesystem mtime
 * granularity (see scripts/test-wiki-page.js).
 */
export function __clearWikiReadCache(domain) {
  if (domain) backlinkCache.delete(domain);
  else backlinkCache.clear();
}

/**
 * Every page in `domain` whose body contains a [[link]] resolving to the
 * page identified by (targetFolder, targetSlug), per linkPointsToPage()'s
 * rules. Returns [{path, folder, slug, title, readable}, ...], sorted by
 * path for a stable UI order.
 *
 * Link SOURCES are recursive (any .md under wiki/, matching health.js's
 * walkMdFiles) — including files outside the three canonical folders, which
 * carry `readable: false` because getWikiPage() can't open them. Link
 * TARGETS are not this function's business: the caller decides whether
 * (targetFolder, targetSlug) is a resolvable target at all — see
 * getWikiPage's use of isResolvableTargetPath().
 */
export async function getBacklinks(domain, targetFolder, targetSlug) {
  const wikiDir = wikiPath(domain);
  const idx = await getOrBuildIndex(domain, wikiDir);
  const out = [];
  for (const entry of idx.entries) {
    if (entry.links.some(raw => linkPointsToPage(raw, targetFolder, targetSlug))) {
      out.push({
        path: entry.relPath,
        folder: entry.folder,
        slug: entry.slug,
        title: entry.title,
        readable: entry.readable,
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Read one wiki page plus its backlinks — the data the citation-chip reader
 * panel needs. Throws an Error with `.status` set (404/400) on any failure;
 * callers (src/routes/wiki.js) map that straight onto the HTTP response,
 * matching the convention used by src/routes/health.js.
 *
 * @param {string} domain
 * @param {string} requestedPath  client-supplied page path, e.g.
 *   "entities/tali-rezun.md" or "summaries/some-article" (extension optional)
 */
export async function getWikiPage(domain, requestedPath) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) {
    const err = new Error(`No wiki found for domain: ${domain}`);
    err.status = 404;
    throw err;
  }

  const normalised = normaliseRequestedPath(requestedPath);
  if (!normalised) {
    const err = new Error('Missing or invalid page path');
    err.status = 400;
    throw err;
  }

  // Folder pre-check is case-TOLERANT: on a case-insensitive filesystem the
  // read below would succeed for "Entities/x.md" anyway, and refusing it
  // here purely on spelling would be an arbitrary 400 for a page that
  // exists. The authoritative folder is re-derived from the on-disk path
  // after the read (see canonicalRelPath). On a case-sensitive filesystem
  // the mis-cased path simply doesn't exist and 404s below.
  if (!CANONICAL_FOLDERS.has(normalised.split('/')[0].toLowerCase())) {
    const err = new Error(
      `Invalid page path: "${requestedPath}" must be inside entities/, concepts/, or summaries/`
    );
    err.status = 400;
    throw err;
  }

  // Only the PHYSICAL half of resolveInsideWiki can still fail here — every
  // lexical escape (absolute path, `..`, backslash, control char) was already
  // refused by normaliseRequestedPath above. So reaching this branch means
  // exactly one thing: the page, or a folder on the way to it, is a symlink
  // that leaves the wiki (or dangles).
  //
  // It used to throw a bare "Invalid page path" (v3.2.0 audit finding M4).
  // That read as "you typed the path wrong" for a path the user had just
  // clicked from a citation chip, and it was the visible half of the app
  // contradicting itself: the Health tab listed the page, the reader refused
  // it, and Health's own fixes silently no-opped on it. The scan side now
  // excludes escaping paths from its inventory (health.js listMd/walkMdFiles),
  // so the two agree — and this message says what is actually wrong and what
  // to do about it, rather than blaming the input.
  const absPath = resolveInsideWiki(wikiDir, normalised);
  if (!absPath) {
    const err = new Error(
      `"${normalised}" is a symlink (or sits under a symlinked folder) that points outside ` +
      `this domain's wiki folder, so The Curator won't open it — a page it cannot contain is a ` +
      `page it cannot safely edit or delete. Replace it with a real file inside wiki/, or point ` +
      `your Obsidian vault at the wiki folder instead of symlinking pages into it.`
    );
    err.status = 400;
    err.code = 'WIKI_PATH_ESCAPES';
    throw err;
  }

  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch {
    const err = new Error(`Page not found: ${normalised}`);
    err.status = 404;
    throw err;
  }

  // Identity comes from the filesystem, not from the request string — see
  // canonicalRelPath's docblock (audit M5: a mis-cased request produced a
  // mis-cased slug and therefore zero backlinks on a heavily-linked page).
  const canonical = canonicalRelPath(wikiDir, absPath) || normalised;

  const folder = folderOf(canonical);
  if (!folder) {
    // Only reachable if realpath was unavailable AND the request's folder
    // was mis-cased on a case-insensitive filesystem. Refuse rather than
    // invent a folder — `type` and the backlink lookup both hang off it.
    const err = new Error(
      `Invalid page path: "${requestedPath}" must be inside entities/, concepts/, or summaries/`
    );
    err.status = 400;
    throw err;
  }

  const slug = slugOf(canonical);
  const { frontmatter, body } = parseFrontmatter(raw);
  const title = deriveTitle(frontmatter, body, slug);
  const type = frontmatter.type
    || (folder === 'entities' ? 'entity' : folder === 'concepts' ? 'concept' : 'summary');

  // A nested page (entities/companies/x.md) is readable but is NOT a link
  // target the rest of the app can resolve, so it has no backlinks — by
  // definition, not by omission. Reporting the basename's backlinks here
  // would contradict the Health tab, which calls every one of those links
  // broken. See the parity paragraph in the module docblock.
  const resolvableTarget = isResolvableTargetPath(canonical);
  const backlinks = resolvableTarget ? await getBacklinks(domain, folder, slug) : [];

  return {
    domain,
    path: canonical,
    folder,
    slug,
    title,
    type,
    frontmatter,
    body,
    backlinks,
    // Additive (v3.2.0): false for a nested page, whose empty `backlinks`
    // means "nothing in this wiki can link here", not "nothing does".
    resolvableTarget,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// listWikiInventory — the wiki-browse listing endpoint's data source.
//
// `/next` has no wiki-browse surface at all. The two existing reads are the
// wrong shape for it: `GET /:domain` (readWikiPages, src/routes/wiki.js)
// reads the FULL CONTENT of every page — 14 MB on the real `articles`
// domain — and `getWikiPage` above opens exactly one already-known page.
// Populating a browse list needs neither: it needs to enumerate what pages
// EXIST, cheaply, so the client can filter/search in memory and fetch full
// content only for whatever the user actually opens.
//
// THE LOAD-BEARING DECISION: this is built from `listMd` (imported from
// health.js, see the import comment above), not a fresh `readdir`. A naive
// readdir would list pages `getWikiPage` can refuse to open — a symlink
// escaping the wiki, a directory literally named `x.md`, a dangling
// symlinked leaf — and the two would silently disagree about what "a page
// of this wiki" means, the exact way scanWiki() and getWikiPage() disagreed
// before v3.2.0 (audit finding M4, documented in listMd's own docblock in
// health.js). `listMd` is also EXACTLY the shape `isResolvableTargetPath`
// requires (a depth-1 file directly inside one canonical folder) — the same
// invariant getWikiPage's backlink resolution depends on — so every entry
// this function returns is, by construction, openable via GET :domain/page.
//
// ENFORCED contract:
//   - Every entry is `{slug, folder, path, title}`. `path` is the exact
//     string GET /:domain/page's `path` query param expects (folder/slug.md,
//     no leading slash) — the same convention readWikiPages() and chat
//     citations already use elsewhere in the app.
//   - `title` is derived from the SLUG ONLY — never from file content or
//     frontmatter. This function performs ZERO `readFile` calls; cost scales
//     with page COUNT (one readdir per canonical folder), not with wiki size,
//     which is the entire reason it can return ~3,300 entries in one call
//     instead of the 14 MB `GET /:domain` returns.
//   - Capped at MAX_LIST_ENTRIES (20,000) with `truncated: true` when the
//     domain has more. `total` always reports the real (uncapped) count —
//     computing it costs nothing extra, since `listMd` already returned
//     every filename before the slice.
//
// NOT ENFORCED — known, accepted trade-off (do not "fix" this by adding a
// content read here):
//   - A page whose REAL title (an explicit frontmatter `title:`, or the
//     first `# Heading` in the body — see `deriveTitle` above) differs from
//     a humanised form of its slug will show the SLUG-DERIVED label in this
//     list. Its real title is correct the instant it's opened via
//     GET /:domain/page, which DOES read the file. This is intentional, not
//     an oversight: reading file content here to get "real" titles
//     reinstates the exact 14 MB-response problem this endpoint exists to
//     avoid. If real titles in the browse list are ever wanted, that needs a
//     separately-costed mechanism (e.g. a title-only cache built once and
//     invalidated the way the backlink index above is, or a client-side
//     cache populated as pages get opened) — never a body read inside this
//     function.
// ─────────────────────────────────────────────────────────────────────────

const LIST_FOLDERS = ['entities', 'concepts', 'summaries'];
// Exported so scripts/test-wiki-list.js can prove the real cap boundary
// (MAX_LIST_ENTRIES vs MAX_LIST_ENTRIES + 1 real files on disk) instead of
// hardcoding 20000 twice and hoping the two numbers never drift apart.
export const MAX_LIST_ENTRIES = 20000;

/**
 * Humanise a slug into a display label using ONLY the slug string — no file
 * read. Intentionally duplicates deriveTitle()'s last-resort branch (line
 * ~334 above) rather than importing/sharing it: that branch is a one-line
 * pure string transform with no path-safety or parity stakes, unlike
 * resolveInsideWiki/listMd — a second copy of a one-liner carries none of
 * the drift risk a second path guard would, so it isn't worth the coupling.
 */
function titleFromSlug(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Cheap, readdir-only inventory of every page in `domain`'s wiki — see the
 * block comment above for the full contract. Throws an Error with `.status`
 * set (404) if the domain has no wiki, matching getWikiPage's convention.
 */
export async function listWikiInventory(domain) {
  const wikiDir = wikiPath(domain);
  if (!existsSync(wikiDir)) {
    const err = new Error(`No wiki found for domain: ${domain}`);
    err.status = 404;
    throw err;
  }

  const entries = [];
  for (const folder of LIST_FOLDERS) {
    const filenames = await listMd(wikiDir, folder);
    for (const filename of filenames) {
      const slug = filename.slice(0, -3); // listMd only ever returns names ending in ".md"
      entries.push({
        slug,
        folder,
        path: `${folder}/${filename}`,
        title: titleFromSlug(slug),
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  const total = entries.length;
  const truncated = total > MAX_LIST_ENTRIES;
  return {
    domain,
    entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries,
    count: Math.min(total, MAX_LIST_ENTRIES),
    total,
    truncated,
  };
}
