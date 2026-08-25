#!/usr/bin/env node
/**
 * Offline battle test for src/brain/wiki-read.js — the per-page wiki reader
 * that backs GET /api/wiki/:domain/page (the citation-chip reader panel's
 * data source).
 *
 * Covers:
 *   1. Reading a single page (frontmatter, title, body) without touching the
 *      rest of the domain.
 *   2. Backlinks — computed with EXACTLY the same "does this [[link]] point
 *      here" rule health.js's scanWiki() uses (bare links resolve only
 *      against entities/concepts; summaries always need the folder prefix;
 *      a non-canonical folder-prefixed link to an entity/concept still
 *      counts, matching health.js's own quirk).
 *   3. Error cases: unknown domain, unknown page, no-frontmatter page,
 *      zero-backlink (orphan) page, read-only shared-* mirror (reads must
 *      still work).
 *   4. Path-traversal defenses at both layers (normaliseRequestedPath +
 *      resolveInsideWiki), at least three distinct attack shapes.
 *   5. Backlink cache invalidation — add a page, edit a page in place — both
 *      must be reflected on the next read (correctness over staleness).
 *   6. SYMLINK ESCAPE (v3.2.0 audit H1) — proven with REAL symlinks, not
 *      string fixtures: a symlinked file, a symlinked directory, and a
 *      dangling symlink must all be refused, while a symlink pointing back
 *      INSIDE the wiki stays allowed (§8).
 *   6b. EVERY destructive entry point in health.js, enumerated rather than
 *      sampled (§8b). The previous round fixed the handler its report named
 *      and left three more escaping plus one unvalidated arbitrary read,
 *      while §8 stayed green throughout — because §8 only ever exercised
 *      fixCrossFolderDupe. §8b drives every export against real symlinks and
 *      byte-snapshots every file outside the wiki.
 *   6c. The gate is STRUCTURAL, not remembered (§8c): health.js may not
 *      regain any way to build a filesystem path outside wikiFile(). Read
 *      §8c's own comment before trusting it — it documents which of its
 *      checks were measured to fire and which were removed for being
 *      theatre.
 *   7. Backlink-cache freeze (v3.2.0 audit H5) — a file with an mtime ahead
 *      of the clock must not pin the signature; three shapes that the old
 *      {count, maxMtimeMs} signature missed entirely.
 *   8. health.js link-resolution parity for NESTED pages (v3.2.0 audit M4) —
 *      asserted against real scanWiki() output, not against a comment.
 *   9. Case-insensitive filesystems (v3.2.0 audit M5) — a mis-cased request
 *      must still yield the on-disk slug and its real backlinks.
 *  10. Non-canonical backlink sources (v3.2.0 audit L2) — labelled, never a
 *      blank row.
 *
 * Isolated via __setDomainsDirOverride (never process.env.DOMAINS_PATH — see
 * CLAUDE.md's "Active Development Decisions": the env var loses to a
 * configured domainsPath and would silently no-op on a real install).
 *
 * Run with:  node scripts/test-wiki-page.js
 * Exit code 0 if all green; non-zero on any failure.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync,
  symlinkSync, existsSync, statSync, readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { fileURLToPath } from 'url';

import { __setDomainsDirOverride } from '../src/brain/config.js';
import { isDomainReadonly } from '../src/brain/files.js';
import * as healthModule from '../src/brain/health.js';
import {
  fixIssue, scanWiki, fixAllSafe, countLinksToSlug,
  previewSemanticDuplicateMerge, applyOrphanRescue, applyBrokenLinkFixes,
  fixSemanticDuplicatesBatch, findSemanticCandidatePairs,
} from '../src/brain/health.js';
import {
  getWikiPage,
  getBacklinks,
  normaliseRequestedPath,
  resolveInsideWiki,
  canonicalRelPath,
  linkPointsToPage,
  parseFrontmatter,
  deriveTitle,
  __clearWikiReadCache,
} from '../src/brain/wiki-read.js';

// ── Harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err || 'assertion failed'); }
async function assertThrowsStatus(fn, expectedStatus, label) {
  try {
    await fn();
    bad(label, `expected a throw with status ${expectedStatus}, got none`);
  } catch (err) {
    if (err && err.status === expectedStatus) ok(label);
    else bad(label, `threw, but status was ${err && err.status} (message: ${err && err.message})`);
  }
}
function section(name) { console.log(`\n── ${name} ──`); }

// ── Source-scanning helpers for section 8c ───────────────────────────────
//
// These exist because there is no JS parser in this repo's dependency set
// (checked: no acorn, no espree), so the guard has to read the source itself.
// This codebase has been bitten HARD by exactly that — v3.1.0's null-safety
// scanner desynced on a nested template literal and on a regex containing
// backticks, saw 78 of 90 declarations, and reported every assertion green
// with a real blank-page bug present.
//
// READ THIS BEFORE TRUSTING THE PAIRING. The obvious response — run a clever
// lexer and a dumb scanner and treat their disagreement as the safety net —
// was BUILT AND THEN MEASURED, and it does not work here. I corrupted
// `stripCommentsAndStrings` four ways (disabled block comments, line comments,
// strings, regex literals) and the two scanners agreed every single time,
// because health.js's prose quotes code inside backticks, which one blanker or
// the other swallows either way. So the disagreement check is NOT the
// protection; it is shipped as a cheap second opinion and labelled as one.
//
// The actual protection is that `fsCallLinesPerLine` — the one section 8c's
// assertions are built on — holds NO cross-line state. There is nothing to
// desync. Its two assumptions (block-comment lines start with `*`; no template
// literal spans lines) are ASSERTED directly in 8c rather than hoped for, and
// both assertions were verified to fail when violated.
//
// `stripCommentsAndStrings` / `fsCallLinesLexed` are kept only for that second
// opinion. Nothing load-bearing may be built on them.

// Filesystem primitives health.js can reach. Kept in one place so the lexed
// scan, the per-line scan and the assertion all measure the same thing.
const FS_PRIMS = [
  'readFile', 'writeFile', 'writeFileAtomic', 'readdir', 'rm', 'existsSync',
  'injectSingleBacklink', 'injectRelatedLink',
  'unlink', 'lstat', 'mkdir', 'rename', 'appendFile', 'copyFile', 'open', 'stat',
];

/**
 * Blank every comment, string literal, template literal and regex literal,
 * replacing each with the SAME NUMBER of characters (spaces, newlines kept)
 * so byte offsets and line numbers are preserved. Section 8c asserts that
 * length-preservation directly — a blanker that shifts offsets would make
 * every line number it reports a lie.
 *
 * Regex-vs-division is decided by the previous significant token, the standard
 * heuristic. It is NOT assumed correct: 8c cross-checks the result.
 */
function stripCommentsAndStrings(src) {
  const out = new Array(src.length);
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out[k] = src[k] === '\n' ? '\n' : ' ';
  };
  let i = 0;
  let prevSig = '';                 // last significant char of real code
  let prevWord = '';                // last identifier/keyword of real code
  const REGEX_OK_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|',
                                   '?', '{', '}', ';', '+', '-', '*', '%', '~',
                                   '^', '<', '>', '\n']);
  const REGEX_OK_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of',
                                  'new', 'delete', 'void', 'throw', 'case',
                                  'do', 'else', 'yield', 'await']);
  while (i < src.length) {
    const c = src[i];
    // Line comment
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i); if (j < 0) j = src.length;
      blank(i, j); i = j; continue;
    }
    // Block comment
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2;
      blank(i, j); i = j; continue;
    }
    // String / template literal (templates: blank the whole literal including
    // any ${...}; nothing this guard cares about lives inside one).
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; let j = i + 1; let depth = 0;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (quote === '`' && src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (quote === '`' && depth > 0 && src[j] === '}') { depth--; j++; continue; }
        if (depth === 0 && src[j] === quote) { j++; break; }
        if (quote !== '`' && src[j] === '\n') break;   // unterminated — bail safely
        j++;
      }
      blank(i, j); i = j; prevSig = 'x'; prevWord = ''; continue;
    }
    // Regex literal
    if (c === '/' && (REGEX_OK_BEFORE.has(prevSig) || REGEX_OK_WORDS.has(prevWord))) {
      let j = i + 1, inClass = false, closed = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                 // not a regex after all
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; closed = true; break; }
        j++;
      }
      if (closed) {
        while (j < src.length && /[a-z]/.test(src[j])) j++;   // flags
        blank(i, j); i = j; prevSig = 'x'; prevWord = ''; continue;
      }
    }
    out[i] = c;
    if (!/\s/.test(c)) { prevSig = c; prevWord = /[\w$]/.test(c) ? prevWord + c : ''; }
    else if (c === '\n') { prevSig = '\n'; prevWord = ''; }
    else prevWord = prevWord;
    i++;
  }
  return out.join('');
}

/** Text of the first argument of the call whose '(' is at `openIdx`. */
function firstArgumentText(code, openIdx) {
  let depth = 0;
  const start = openIdx + 1;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return code.slice(start, i).trim();
    } else if (c === ',' && depth === 1) return code.slice(start, i).trim();
  }
  return null;
}

/** CLEVER scan: fs-primitive call sites found in whole-file-lexed source. */
function fsCallLinesLexed(code) {
  const hits = new Set();
  for (const prim of FS_PRIMS) {
    const re = new RegExp(`\\b${prim}\\s*\\(`, 'g');
    for (const m of code.matchAll(re)) {
      hits.add(`${code.slice(0, m.index).split('\n').length}:${prim}`);
    }
  }
  return hits;
}

/**
 * DUMB scan: the independent second measurement. Per-line, ZERO cross-line
 * state — it cannot desync, because there is nothing to carry. Strips a
 * trailing `//`, skips lines that are visibly comment body, and blanks quoted
 * spans within the single line.
 */
function fsCallLinesPerLine(src) {
  const hits = new Set();
  const lines = src.split('\n');
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
    const cut = line.indexOf('//');
    if (cut >= 0) line = line.slice(0, cut);
    // blank quoted spans on this line only
    line = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, (m) => ' '.repeat(m.length));
    for (const prim of FS_PRIMS) {
      if (new RegExp(`\\b${prim}\\s*\\(`).test(line)) hits.add(`${n + 1}:${prim}`);
    }
  }
  return hits;
}

const work = mkdtempSync(path.join(tmpdir(), 'wiki-page-test-'));
const domainsDir = path.join(work, 'domains');

function wikiDirFor(domain) {
  return path.join(domainsDir, domain, 'wiki');
}
function writePageFile(domain, relPath, content) {
  const abs = path.join(wikiDirFor(domain), relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

try {
  __setDomainsDirOverride(domainsDir);

  // ── Fixture domain: "articles" ─────────────────────────────────────────
  // entities/tali-rezun.md   — links to concepts/curator.md and
  //                             summaries/my-article.md (correct [[summaries/x]] form)
  // concepts/curator.md      — links back to tali-rezun via a BARE link
  // summaries/my-article.md — links to tali-rezun via a BARE link (entities mentioned)
  // entities/via-prefix.md  — links to tali-rezun via the NON-canonical
  //                             `[[entities/tali-rezun]]` folder-prefixed form —
  //                             health.js counts this as an existing link
  //                             (flagged separately as a style issue, but not
  //                             broken) — backlinks must match that exactly.
  // entities/bare-to-summary.md — links to the SUMMARY via a BARE
  //                             `[[my-article]]` (no summaries/ prefix) — per
  //                             wiki convention this must NOT resolve, so it
  //                             must NOT appear as a backlink of the summary.
  // entities/unrelated.md   — links to nothing relevant; must never appear.
  // entities/orphan.md      — no incoming links at all.

  writePageFile('articles', 'entities/tali-rezun.md',
    '---\ntags: [type/entity]\n---\n' +
    '# Tali Rezun\n\n## Related\n- [[curator]]\n- [[summaries/my-article]]\n');

  writePageFile('articles', 'concepts/curator.md',
    '---\ntags: [type/concept]\n---\n' +
    '# The Curator\n\n## Related\n- [[tali-rezun]]\n');

  writePageFile('articles', 'summaries/my-article.md',
    '---\ntags: [type/summary]\nsource: my-article.pdf\n---\n' +
    '# My Article\n\n## Entities Mentioned\n- [[tali-rezun]]\n');

  writePageFile('articles', 'entities/via-prefix.md',
    '---\ntags: [type/entity]\n---\n' +
    '# Via Prefix\n\nSee also [[entities/tali-rezun]] for background.\n');

  writePageFile('articles', 'entities/bare-to-summary.md',
    '---\ntags: [type/entity]\n---\n' +
    '# Bare To Summary\n\nThis wrongly writes [[my-article]] without the summaries/ prefix.\n');

  writePageFile('articles', 'entities/unrelated.md',
    '---\ntags: [type/entity]\n---\n' +
    '# Unrelated\n\nNo links to anyone relevant here, just [[unrelated-2]].\n');
  writePageFile('articles', 'entities/unrelated-2.md',
    '---\ntags: [type/entity]\n---\n# Unrelated 2\n');

  writePageFile('articles', 'entities/orphan.md',
    '---\ntags: [type/entity]\n---\n# Orphan\n\nNothing links here.\n');

  // A page with NO frontmatter at all (hand-crafted, bypassing writePage).
  writePageFile('articles', 'concepts/no-frontmatter.md',
    '# No Frontmatter\n\nJust prose, no YAML block, and a link to [[orphan]].\n');

  // App-managed root files — must be excluded from both the page-read
  // surface (folder check) and the backlink scan (index.md/log.md).
  writeFileSync(path.join(wikiDirFor('articles'), 'index.md'), '# Index\n\n[[tali-rezun]]\n');
  writeFileSync(path.join(wikiDirFor('articles'), 'log.md'), '## [2026-01-01]\ningested something\n');

  // ── 1. Single-page read ─────────────────────────────────────────────────
  section('1. Single-page read');
  {
    const page = await getWikiPage('articles', 'entities/tali-rezun.md');
    assert(page.domain === 'articles', 'domain echoed');
    assert(page.path === 'entities/tali-rezun.md', 'path echoed');
    assert(page.folder === 'entities', 'folder resolved');
    assert(page.slug === 'tali-rezun', 'slug resolved');
    assert(page.title === 'Tali Rezun', `title from first heading (got "${page.title}")`);
    assert(page.type === 'entity', 'type falls back to folder-derived value');
    assert(Array.isArray(page.frontmatter.tags) && page.frontmatter.tags.includes('type/entity'), 'frontmatter.tags parsed');
    assert(page.body.includes('## Related'), 'body is the raw markdown body (frontmatter stripped)');
    assert(!page.body.startsWith('---'), 'frontmatter block not leaked into body');
  }

  // Path without .md extension is accepted.
  {
    const page = await getWikiPage('articles', 'entities/tali-rezun');
    assert(page.slug === 'tali-rezun', 'extension-less path accepted');
  }

  // Summary page uses the summaries/ convention.
  {
    const page = await getWikiPage('articles', 'summaries/my-article.md');
    assert(page.folder === 'summaries', 'summary folder resolved');
    assert(page.type === 'summary', 'summary type resolved');
    assert(page.frontmatter.source === 'my-article.pdf', 'summary source field parsed');
  }

  // ── 2. No-frontmatter page ───────────────────────────────────────────────
  section('2. Page with no frontmatter');
  {
    const page = await getWikiPage('articles', 'concepts/no-frontmatter.md');
    assert(Object.keys(page.frontmatter).length === 0, 'frontmatter is an empty object, not a throw');
    assert(page.title === 'No Frontmatter', 'title still derives from the first heading');
    assert(page.body.includes('Just prose'), 'body is the whole raw content when there is no frontmatter block');
  }

  // ── 3. Backlinks — parity with health.js's link-resolution rules ───────
  section('3. Backlinks (health.js parity)');
  {
    const talBacklinks = await getBacklinks('articles', 'entities', 'tali-rezun');
    const paths = talBacklinks.map(b => b.path).sort();
    assert(paths.includes('concepts/curator.md'), 'bare [[tali-rezun]] link counted as a backlink');
    assert(paths.includes('summaries/my-article.md'), 'summary linking bare [[tali-rezun]] counted');
    assert(paths.includes('entities/via-prefix.md'),
      'non-canonical [[entities/tali-rezun]] folder-prefixed link STILL counts (matches health.js\'s own quirk)');
    assert(!paths.includes('entities/unrelated.md'), 'unrelated page is not a backlink');
    assert(!paths.includes('index.md') && !paths.includes('log.md'), 'index.md/log.md excluded from the scan entirely');
    const curatorEntry = talBacklinks.find(b => b.path === 'concepts/curator.md');
    assert(curatorEntry && curatorEntry.title === 'The Curator', 'backlink entries carry the source page\'s title');
    assert(curatorEntry && curatorEntry.folder === 'concepts', 'backlink entries carry the source page\'s folder');
  }

  {
    // The convention asymmetry: bare links resolve to entities/concepts only.
    const summaryBacklinks = await getBacklinks('articles', 'summaries', 'my-article');
    const paths = summaryBacklinks.map(b => b.path);
    assert(paths.includes('entities/tali-rezun.md'), 'correct [[summaries/my-article]] form counted');
    assert(!paths.includes('entities/bare-to-summary.md'),
      'BARE [[my-article]] (missing the summaries/ prefix) must NOT resolve to the summary — matches health.js exactly');
  }

  {
    const orphanBacklinks = await getBacklinks('articles', 'entities', 'orphan');
    // orphan.md itself has no incoming [[orphan]] link EXCEPT the hand-crafted
    // no-frontmatter concept page, which deliberately links to it.
    const paths = orphanBacklinks.map(b => b.path);
    assert(paths.includes('concepts/no-frontmatter.md'), 'a page with no frontmatter can still be a valid backlink SOURCE');
  }

  {
    const unrelated2Backlinks = await getBacklinks('articles', 'entities', 'unrelated-2');
    assert(unrelated2Backlinks.length === 1 && unrelated2Backlinks[0].path === 'entities/unrelated.md',
      'a genuinely single-backlink page returns exactly that one entry');
  }

  {
    const page = await getWikiPage('articles', 'entities/orphan.md');
    // via getWikiPage, orphan.md DOES have a backlink from the no-frontmatter page.
    assert(page.backlinks.length >= 1, 'getWikiPage() surfaces backlinks inline with the page');
  }

  // Truly zero-backlink page.
  writePageFile('articles', 'entities/truly-alone.md', '---\ntags: [type/entity]\n---\n# Truly Alone\n');
  {
    const page = await getWikiPage('articles', 'entities/truly-alone.md');
    assert(Array.isArray(page.backlinks) && page.backlinks.length === 0, 'a page with zero backlinks returns an empty array, not null/undefined');
  }

  // linkPointsToPage direct unit checks (the resolver health.js parity hinges on).
  assert(linkPointsToPage('tali-rezun', 'entities', 'tali-rezun') === true, 'linkPointsToPage: bare match');
  assert(linkPointsToPage('tali-rezun', 'summaries', 'tali-rezun') === false, 'linkPointsToPage: bare never matches summaries');
  assert(linkPointsToPage('summaries/foo', 'summaries', 'foo') === true, 'linkPointsToPage: prefixed exact match');
  assert(linkPointsToPage('summaries/foo', 'entities', 'foo') === false, 'linkPointsToPage: prefixed folder mismatch rejected');
  assert(linkPointsToPage('entities/foo', 'entities', 'foo') === true, 'linkPointsToPage: non-canonical entities/ prefix still resolves');

  // ── 4. Error cases ───────────────────────────────────────────────────────
  section('4. Error cases');
  await assertThrowsStatus(() => getWikiPage('does-not-exist', 'entities/foo.md'), 404, 'unknown domain → 404');
  await assertThrowsStatus(() => getWikiPage('articles', 'entities/nope-not-a-real-page.md'), 404, 'unknown page → 404');
  await assertThrowsStatus(() => getWikiPage('articles', undefined), 400, 'missing path → 400');
  await assertThrowsStatus(() => getWikiPage('articles', ''), 400, 'empty path → 400');
  await assertThrowsStatus(() => getWikiPage('articles', 'log.md'), 400, 'index.md/log.md are not readable pages via this endpoint (400)');
  await assertThrowsStatus(() => getWikiPage('articles', 'not-a-canonical-folder/foo.md'), 400, 'non-canonical folder → 400');

  // ── 5. Read-only shared-* mirror: reads must still work ─────────────────
  section('5. Read-only mirror domain');
  {
    const mirrorDomainDir = path.join(domainsDir, 'shared-cohort');
    mkdirSync(mirrorDomainDir, { recursive: true });
    writeFileSync(path.join(mirrorDomainDir, 'CLAUDE.md'), '---\nreadonly: true\n---\n# Shared cohort mirror\n');
    writePageFile('shared-cohort', 'entities/collective-fact.md',
      '---\ntags: [type/entity]\n---\n# Collective Fact\n\nSynthesised from contributors.\n');

    const isRO = await isDomainReadonly('shared-cohort');
    assert(isRO === true, 'isDomainReadonly correctly identifies the mirror');

    const page = await getWikiPage('shared-cohort', 'entities/collective-fact.md');
    assert(page.title === 'Collective Fact', 'reading a page on a read-only mirror succeeds (only writes are refused elsewhere)');
  }

  // ── 6. Path traversal (>= 3 distinct attack shapes) ─────────────────────
  section('6. Path traversal defenses');

  assert(normaliseRequestedPath('../../../etc/passwd') === null, 'traversal #1: leading ../ segments rejected by normaliseRequestedPath');
  assert(normaliseRequestedPath('/etc/passwd') === null, 'traversal #2: absolute unix path rejected by normaliseRequestedPath');
  assert(normaliseRequestedPath('entities/../../../outside.md') === null, 'traversal #3: embedded ../ segment rejected by normaliseRequestedPath');
  assert(normaliseRequestedPath('C:\\Windows\\System32') === null, 'traversal #4: windows drive-letter / backslash form rejected');
  assert(normaliseRequestedPath('entities/foo\0.md') === null, 'traversal #5: embedded NUL byte rejected');
  assert(normaliseRequestedPath('entities/foo\u001f.md') === null, 'traversal #5b: other control characters (U+001F) rejected too');
  assert(normaliseRequestedPath('entities/foo\n.md') === null, 'traversal #5c: embedded newline rejected');

  // Source hygiene, and a real reviewability problem rather than a style
  // nit: that control-character class used to be written with the RAW
  // bytes, NUL included, which made git classify this file as BINARY. Its
  // diffs rendered as "Bin 16851 -> 30986 bytes" and plain grep skipped it
  // — on the file that holds the path-traversal and symlink guards, i.e.
  // the file most in need of being reviewable. Assert the bytes stay
  // escaped so it cannot silently regress.
  {
    const src = readFileSync(new URL('../src/brain/wiki-read.js', import.meta.url), 'utf8');
    assert(!src.includes('\u0000'), 'source hygiene: wiki-read.js contains no raw NUL byte (git would treat it as binary and hide every diff)');
    // Tab / LF / CR are legitimate; everything else in C0 is not.
    assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(src),
      'source hygiene: no other raw control bytes in wiki-read.js either (tab/LF/CR excepted)');
  }

  // Defense-in-depth: resolveInsideWiki must independently refuse escape
  // even if a caller bypassed normaliseRequestedPath entirely (the module
  // docblock's "do not rely on validation happening upstream" requirement).
  {
    const wikiDir = wikiDirFor('articles');
    assert(resolveInsideWiki(wikiDir, '../../../etc/passwd') === null, 'traversal #6: resolveInsideWiki independently refuses ../ escape');
    assert(resolveInsideWiki(wikiDir, '/etc/passwd') === null, 'traversal #7: resolveInsideWiki independently refuses absolute paths');
    assert(resolveInsideWiki(wikiDir, 'entities/tali-rezun.md') !== null, 'resolveInsideWiki still accepts a genuine in-bounds path');
  }

  await assertThrowsStatus(() => getWikiPage('articles', '../../../etc/passwd'), 400, 'end-to-end: getWikiPage refuses a traversal payload with 400, not a filesystem error');
  await assertThrowsStatus(() => getWikiPage('articles', '/etc/passwd'), 400, 'end-to-end: absolute-path payload refused with 400');

  // ── 7. Cache invalidation — correctness over staleness ──────────────────
  section('7. Backlink cache invalidation');
  {
    // Baseline: fresh page, no backlinks yet.
    writePageFile('articles', 'concepts/freshly-added.md', '---\ntags: [type/concept]\n---\n# Freshly Added\n');
    __clearWikiReadCache('articles');
    let backlinks = await getBacklinks('articles', 'concepts', 'freshly-added');
    assert(backlinks.length === 0, 'new page starts with zero backlinks (cache primed)');

    // Add a NEW page linking to it — file COUNT changes, must be picked up
    // without any manual cache-clear (this is the real-world "just ingested
    // something" case the module docblock calls out).
    writePageFile('articles', 'entities/newly-linking.md',
      '---\ntags: [type/entity]\n---\n# Newly Linking\n\nSee [[freshly-added]].\n');
    backlinks = await getBacklinks('articles', 'concepts', 'freshly-added');
    assert(backlinks.some(b => b.path === 'entities/newly-linking.md'),
      'adding a new linking page is picked up on the very next read (no stale cache)');

    // Edit an EXISTING file in place (same file count, content changes) —
    // remove the link. Force the mtime forward explicitly so the test does
    // not depend on filesystem mtime clock granularity.
    const abs = path.join(wikiDirFor('articles'), 'entities/newly-linking.md');
    writeFileSync(abs, '---\ntags: [type/entity]\n---\n# Newly Linking\n\nNo longer links to anything.\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(abs, future, future);

    backlinks = await getBacklinks('articles', 'concepts', 'freshly-added');
    assert(!backlinks.some(b => b.path === 'entities/newly-linking.md'),
      'editing an existing page IN PLACE (file count unchanged) still invalidates the cache via mtime');
  }

  // ── 8. H1 — symlink escape (REAL symlinks on disk) ──────────────────────
  //
  // The pre-v3.2.0 guard was purely lexical: path.resolve + path.relative,
  // no realpath, no lstat. It refused a path whose STRING escaped and said
  // nothing about what the path POINTED AT. Reproduced by the audit as a
  // 200 serving outside content.
  section('8. H1 — symlink escape (real symlinks)');
  {
    // An "outside the wiki" tree, and a second domain used as the victim so
    // nothing in this test can touch anything beyond the tempdir.
    const outsideDir = path.join(work, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'secret.md');
    // The outside file deliberately CONTAINS a link to a real in-wiki page.
    // Without that, "the symlink is not indexed as a backlink source" would
    // pass trivially whether or not the walk skips symlinks — a false green.
    // With it, indexing the symlink shows up immediately as a phantom
    // backlink sourced from outside the wiki.
    writeFileSync(outsideFile,
      '# Secret\n\nSENSITIVE_OUTSIDE_WIKI_CONTENT, mentioning [[tali-rezun]].\n', 'utf8');

    const wikiDir = wikiDirFor('articles');

    // 8a. Symlinked FILE inside a canonical folder.
    const leak = path.join(wikiDir, 'entities', 'leak.md');
    symlinkSync(outsideFile, leak);
    assert(existsSync(leak), 'fixture: symlinked page is present and resolves on disk (the OS would serve it)');
    assert(readFileSync(leak, 'utf8').includes('SENSITIVE_OUTSIDE_WIKI_CONTENT'),
      'fixture: reading the symlink directly DOES yield the outside file (so a refusal below is a real defense, not a broken fixture)');

    assert(resolveInsideWiki(wikiDir, 'entities/leak.md') === null,
      'H1 #1: resolveInsideWiki refuses a symlinked FILE that points outside the wiki');
    await assertThrowsStatus(() => getWikiPage('articles', 'entities/leak.md'), 400,
      'H1 #2: getWikiPage refuses the symlinked page with 400 instead of serving outside content');

    // 8b. Symlinked DIRECTORY — the audit showed this escapes wholesale.
    const symDirDomainWiki = wikiDirFor('symdir');
    mkdirSync(path.join(symDirDomainWiki, 'entities'), { recursive: true });
    mkdirSync(path.join(path.dirname(symDirDomainWiki)), { recursive: true });
    writeFileSync(path.join(path.dirname(symDirDomainWiki), 'CLAUDE.md'), '# Domain: Symdir\n', 'utf8');
    // wiki/concepts is a symlink to the outside tree.
    symlinkSync(outsideDir, path.join(symDirDomainWiki, 'concepts'));
    assert(existsSync(path.join(symDirDomainWiki, 'concepts', 'secret.md')),
      'fixture: the symlinked DIRECTORY genuinely exposes an outside .md at an in-bounds path');

    assert(resolveInsideWiki(symDirDomainWiki, 'concepts/secret.md') === null,
      'H1 #3: resolveInsideWiki refuses a path that reaches outside through a symlinked DIRECTORY');
    await assertThrowsStatus(() => getWikiPage('symdir', 'concepts/secret.md'), 400,
      'H1 #4: getWikiPage refuses a page reached through a symlinked directory');

    // 8c. Dangling symlink — must refuse, and must NOT throw a raw fs error.
    const dangling = path.join(wikiDir, 'entities', 'dangling.md');
    symlinkSync(path.join(outsideDir, 'does-not-exist.md'), dangling);
    let danglingThrew = false;
    try { resolveInsideWiki(wikiDir, 'entities/dangling.md'); }
    catch { danglingThrew = true; }
    assert(!danglingThrew, 'H1 #5: a dangling symlink does not make resolveInsideWiki throw');
    assert(resolveInsideWiki(wikiDir, 'entities/dangling.md') === null,
      'H1 #6: a dangling symlink is REFUSED (containment cannot be proven → refuse)');

    // 8d. A symlink pointing back INSIDE the wiki is legitimate and allowed.
    const insideAlias = path.join(wikiDir, 'entities', 'alias-inside.md');
    symlinkSync(path.join(wikiDir, 'entities', 'tali-rezun.md'), insideAlias);
    assert(resolveInsideWiki(wikiDir, 'entities/alias-inside.md') !== null,
      'H1 #7: a symlink whose target resolves back INSIDE the wiki is still allowed (not an escape)');

    // 8e. Genuine in-bounds paths keep working (no over-refusal).
    assert(resolveInsideWiki(wikiDir, 'entities/tali-rezun.md') !== null,
      'H1 #8: an ordinary in-bounds path is unaffected');
    assert(resolveInsideWiki(wikiDir, 'entities/does-not-exist-yet.md') !== null,
      'H1 #9: a path that does not exist yet is still allowed (fresh-write targets must resolve)');
    assert(resolveInsideWiki(symDirDomainWiki, 'concepts/brand-new.md') === null,
      'H1 #10: a NOT-YET-EXISTING path under a symlinked directory is refused (ancestor walk, not just leaf lstat)');

    // 8f. The symlinked page must not leak into the backlink index either.
    const allBacklinks = await getBacklinks('articles', 'entities', 'tali-rezun');
    assert(!allBacklinks.some(b => b.path.includes('leak.md')),
      'H1 #11: a symlinked .md is not indexed as a backlink source (no outside title/link harvesting)');

    // 8g. DESTRUCTIVE side — health.js's fix handlers share the same guard.
    // fixCrossFolderDupe rm()s issue.remove; through a symlinked directory
    // that lands on a REAL outside file.
    const victim = path.join(outsideDir, 'victim.md');
    writeFileSync(victim, '# Victim\n\nMust survive.\n', 'utf8');
    writeFileSync(path.join(symDirDomainWiki, 'entities', 'keeper.md'), '# Keeper\n\n## Key Facts\n- a\n', 'utf8');
    const result = await fixIssue('symdir', 'crossFolderDupes', {
      keep: 'entities/keeper.md',
      remove: 'concepts/victim.md',   // resolves outside via the symlinked dir
    });
    assert(result.fixed === 0, 'H1 #12: health.js refuses a cross-folder "fix" whose remove path escapes via a symlinked directory');
    assert(existsSync(victim), 'H1 #13: the real file outside the wiki was NOT deleted (destructive path is guarded too)');
    assert(readFileSync(victim, 'utf8').includes('Must survive'), 'H1 #14: the outside file is byte-intact, not truncated');
  }

  // ── 8b. H1 — EVERY destructive entry point, not just the reported one ────
  //
  // The previous round fixed the handler the report named and left three
  // more escaping (`fixSemanticDuplicate`, `fixOrphanLink`,
  // `applyOrphanRescue`) plus one unvalidated arbitrary read
  // (`previewSemanticDuplicateMerge`) — while adding a docblock asserting
  // that every handler was gated. Section 8 above would have stayed green
  // through all four, because it only ever exercised fixCrossFolderDupe.
  //
  // So this section is driven by an ENUMERATION rather than by a hand-picked
  // example: one fixture, and a case per exported way to reach the
  // filesystem. §8c below then fails the build if a NEW export appears that
  // is not classified here, so "we fixed the ones we were told about" cannot
  // be the shape of the next fix either.
  section('8b. H1 — every destructive entry point is gated (enumerated, not sampled)');
  {
    // Fixture: a domain whose concepts/ AND entities/ are both symlinks out.
    // Two symlinked folders because the handlers differ in which folder they
    // touch — fixHyphenVariant is entities/-only, fixSemanticDuplicate and
    // fixOrphanLink read both — and a fixture that only symlinks one of them
    // silently skips whichever handler doesn't use it. That is exactly how
    // the previous round's probes passed while reverted: the fixture never
    // reached the code path.
    const outside = path.join(work, 'outside-all');
    mkdirSync(outside, { recursive: true });
    const secret = path.join(work, 'TOP-SECRET.md');
    writeFileSync(secret, '# Top Secret\n' + 'sensitive-line\n'.repeat(40), 'utf8');

    const OUT = {
      keeper:  path.join(outside, 'keeper.md'),
      dupe:    path.join(outside, 'dupe.md'),
      victim:  path.join(outside, 'victim.md'),
      linksrc: path.join(outside, 'linksrc.md'),
    };
    writeFileSync(OUT.keeper,  '# Keeper\n\n## Key Facts\n- keeper fact\n', 'utf8');
    writeFileSync(OUT.dupe,    '# Dupe\n\n## Key Facts\n- dupe fact\n', 'utf8');
    writeFileSync(OUT.victim,  '# Victim\n\n## Related\n- untouched\n', 'utf8');
    writeFileSync(OUT.linksrc, '# Link Source\n\nMentions [[dupe]] and [[legacy-name]].\n', 'utf8');

    // Domain A: concepts/ is the symlink; entities/ is real.
    const aWiki = wikiDirFor('escape-a');
    mkdirSync(path.join(aWiki, 'entities'), { recursive: true });
    mkdirSync(path.join(aWiki, 'summaries'), { recursive: true });
    writeFileSync(path.join(domainsDir, 'escape-a', 'CLAUDE.md'), '# Domain: Escape A\n', 'utf8');
    symlinkSync(outside, path.join(aWiki, 'concepts'));
    writeFileSync(path.join(aWiki, 'entities', 'orph.md'), '# Orph\n', 'utf8');
    writeFileSync(path.join(aWiki, 'entities', 'inside-keeper.md'), '# Inside Keeper\n\n## Key Facts\n- x\n', 'utf8');
    // A symlinked .md LEAF inside a REAL folder. This is a different escape
    // shape from the symlinked FOLDER above, and it is the one that reaches
    // walkMdFiles's per-leaf containment check — the code path that drives
    // every domain-wide link rewrite. Without this file in the fixture, that
    // check is unreachable and a test asserting it would pass while reverted.
    symlinkSync(OUT.linksrc, path.join(aWiki, 'entities', 'leaked-leaf.md'));

    // Domain B: entities/ is the symlink — reaches the entities-only handler.
    const bWiki = wikiDirFor('escape-b');
    mkdirSync(path.join(bWiki, 'concepts'), { recursive: true });
    mkdirSync(path.join(bWiki, 'summaries'), { recursive: true });
    writeFileSync(path.join(domainsDir, 'escape-b', 'CLAUDE.md'), '# Domain: Escape B\n', 'utf8');
    symlinkSync(outside, path.join(bWiki, 'entities'));

    // Snapshot every outside file; any byte change or disappearance is a leak.
    const snapshot = () => Object.fromEntries(
      Object.entries(OUT).map(([k, p]) => [k, existsSync(p) ? readFileSync(p, 'utf8') : null])
    );
    const before = snapshot();
    const unchanged = (label) => {
      const now = snapshot();
      const broken = Object.keys(OUT).filter(k => now[k] !== before[k]);
      assert(broken.length === 0, label,
        broken.length ? `outside files mutated or deleted: ${broken.join(', ')}` : undefined);
    };

    // ── Case 1: fixSemanticDuplicate — rm() through a symlinked folder ────
    const r1 = await fixIssue('escape-a', 'semanticDupe', {
      keepSlug: 'keeper', keepFolder: 'concepts',
      removeSlug: 'dupe', removeFolder: 'concepts',
    });
    assert(r1.fixed === 0, 'H1 #15: fixIssue(semanticDupe) refuses a pair reached through a symlinked folder');
    assert(existsSync(OUT.dupe), 'H1 #16: the outside file semanticDupe would have rm()d still exists');
    unchanged('H1 #17: no outside file was mutated by the refused semanticDupe merge');

    // ── Case 2: fixSemanticDuplicatesBatch — the bulk path over the same ──
    const r2 = await fixSemanticDuplicatesBatch('escape-a', [
      { keepSlug: 'keeper', keepFolder: 'concepts', removeSlug: 'dupe', removeFolder: 'concepts' },
    ]);
    assert((r2.merged || 0) === 0, 'H1 #18: the BATCH merge path refuses the same escaping pair (not just the single-pair path)');
    assert(existsSync(OUT.dupe), 'H1 #19: the outside file survives the batch path too');

    // ── Case 3: fixOrphanLink — write through a symlinked folder ──────────
    const r3 = await fixIssue('escape-a', 'orphanLink', {
      orphanSlug: 'orph', targetSlug: 'victim', description: 'INJECTED-BY-TEST',
    });
    assert(r3.fixed === 0, 'H1 #20: fixIssue(orphanLink) refuses a target reached through a symlinked folder');
    unchanged('H1 #21: the outside file orphanLink would have written into is byte-intact');

    // ── Case 4: applyOrphanRescue — the bulk write path ───────────────────
    const r4 = await applyOrphanRescue('escape-a', [
      { orphanSlug: 'orph', target: 'victim', description: 'BULK-INJECTED-BY-TEST' },
    ]);
    assert(r4.rescued === 0, 'H1 #22: applyOrphanRescue refuses an escaping target (bulk path, separate code from fixOrphanLink)');
    unchanged('H1 #23: no outside file was written by the refused bulk orphan rescue');

    // ── Case 5: previewSemanticDuplicateMerge — arbitrary READ, no symlink
    // needed. `issue` is the raw POST body of /semantic-dupes/preview and had
    // NO validation at all, so a plain "../../.." returned 4 KB of any file.
    let leaked = null, refused = false;
    try {
      const p = await previewSemanticDuplicateMerge('escape-a', {
        keepSlug: 'TOP-SECRET', keepFolder: '../../..',
        removeSlug: 'inside-keeper', removeFolder: 'entities',
      });
      leaked = p && p.mergedPreview;
    } catch { refused = true; }
    assert(refused, 'H1 #24: previewSemanticDuplicateMerge REFUSES a traversing keepFolder (was: returned file contents)');
    assert(!leaked || !leaked.includes('sensitive-line'),
      'H1 #25: no bytes of the outside file reached the caller');
    // …and the same refusal via a symlinked folder, which is the other shape.
    let symRefused = false;
    try { await previewSemanticDuplicateMerge('escape-a', {
      keepSlug: 'keeper', keepFolder: 'concepts', removeSlug: 'dupe', removeFolder: 'concepts' }); }
    catch { symRefused = true; }
    assert(symRefused, 'H1 #26: preview also refuses a pair reached through a symlinked folder');

    // ── Case 5b: the folder ALLOW-LIST is a separate guarantee from
    // containment. `summaries/foo.md` is perfectly inside the wiki, so the
    // gate says yes; a semantic-duplicate merge must still refuse it, because
    // merging summaries deletes a source-of-record page. Discovered while
    // revert-testing: reverting the allow-list alone left the suite GREEN,
    // because the containment gate happened to catch the traversal case too.
    writeFileSync(path.join(aWiki, 'summaries', 's-one.md'), '# S1\n', 'utf8');
    writeFileSync(path.join(aWiki, 'summaries', 's-two.md'), '# S2\n', 'utf8');
    const rSum = await fixIssue('escape-a', 'semanticDupe', {
      keepSlug: 's-one', keepFolder: 'summaries', removeSlug: 's-two', removeFolder: 'summaries',
    });
    assert(rSum.fixed === 0, 'H1 #26b: a semanticDupe merge of two SUMMARIES is refused (in-bounds, but not an allowed folder)');
    assert(existsSync(path.join(aWiki, 'summaries', 's-two.md')),
      'H1 #26c: …and the summary page it would have deleted is still on disk');
    let sumPreviewRefused = false;
    try { await previewSemanticDuplicateMerge('escape-a', {
      keepSlug: 's-one', keepFolder: 'summaries', removeSlug: 's-two', removeFolder: 'summaries' }); }
    catch { sumPreviewRefused = true; }
    assert(sumPreviewRefused,
      'H1 #26d: preview refuses it too — preview and apply now share ONE definition of a valid pair, so they cannot drift again');
    // Both SIDES of the pair are allow-listed independently. Found by
    // revert-testing: with only the symmetric summaries/summaries case above,
    // deleting EITHER of the two allow-list lines left the suite green,
    // because the surviving one still caught it.
    const rKeepSum = await fixIssue('escape-a', 'semanticDupe', {
      keepSlug: 's-one', keepFolder: 'summaries', removeSlug: 'inside-keeper', removeFolder: 'entities',
    });
    assert(rKeepSum.fixed === 0, 'H1 #26f: a summaries page is refused as the KEEP side');
    const rRemSum = await fixIssue('escape-a', 'semanticDupe', {
      keepSlug: 'inside-keeper', keepFolder: 'entities', removeSlug: 's-one', removeFolder: 'summaries',
    });
    assert(rRemSum.fixed === 0, 'H1 #26g: a summaries page is refused as the REMOVE side');
    assert(existsSync(path.join(aWiki, 'summaries', 's-one.md')),
      'H1 #26h: …and it is still on disk after both attempts');

    // ── Case 5c: walkMdFiles's symlinked-LEAF check (see fixture above) ───
    const leafLinks = await countLinksToSlug('escape-a', 'dupe');
    assert(leafLinks.files === 0,
      'H1 #26e: a symlinked .md leaf inside a REAL folder is not walked — its outside content is not scanned');

    // ── Case 6: fixHyphenVariant — entities/-only, so it needs domain B ───
    const r6 = await fixIssue('escape-b', 'hyphenVariants', {
      suggestedSlug: 'keeper', files: ['keeper', 'dupe'],
    });
    assert(r6.fixed === 0, 'H1 #27: fixHyphenVariant refuses when entities/ itself is a symlink out');
    assert(existsSync(OUT.dupe), 'H1 #28: the outside file fixHyphenVariant would have rm()d still exists');

    // ── Case 7: the three link-rewriting handlers write via issue.sourceFile
    for (const [type, issue] of [
      ['brokenLinks',       { sourceFile: 'concepts/linksrc.md', linkText: 'legacy-name', suggestedTarget: 'orph' }],
      ['folderPrefixLinks', { sourceFile: 'concepts/linksrc.md' }],
      ['missingBacklinks',  { entity: 'concepts/victim.md', summary: 'concepts/linksrc.md', summarySlug: 'linksrc' }],
    ]) {
      const r = await fixIssue('escape-a', type, issue);
      assert(r.fixed === 0, `H1 #29(${type}): refuses a sourceFile that resolves outside the wiki`);
    }
    unchanged('H1 #30: none of the three link-rewriting handlers wrote to an outside file');

    // ── Case 8: fixAllSafe — the one-click button that runs all of them ───
    const r8 = await fixAllSafe('escape-a');
    assert(typeof r8.fixed === 'number', 'H1 #31: fixAllSafe completes on a domain with a symlinked folder instead of throwing');
    unchanged('H1 #32: the "Fix N safe issues" one-click pass touched nothing outside the wiki');

    // ── Case 9: applyBrokenLinkFixes — its file set comes from walkMdFiles
    const r9 = await applyBrokenLinkFixes('escape-a', [{ linkText: 'dupe', action: 'strip' }]);
    assert(typeof r9.filesChanged === 'number', 'H1 #33: applyBrokenLinkFixes completes');
    unchanged('H1 #34: the domain-wide link rewrite never wrote through the symlinked folder');

    // ── Case 10: M4 — the READ side agrees with the write side ────────────
    // Before this fix, scanWiki listed the outside pages as this domain's own
    // (its inventory was a plain readdir on the symlinked folder) while every
    // fix silently no-opped on them and getWikiPage 400'd. Same rule now.
    const scan = await scanWiki('escape-a');
    const scanJson = JSON.stringify(scan);
    assert(!scanJson.includes('"dupe"') && !scanJson.includes('dupe.md'),
      'M4 #1: scanWiki does not list pages that live outside the wiki through a symlinked folder');
    assert(existsSync(path.join(aWiki, 'concepts', 'dupe.md')),
      'M4 #2: …and the fixture is real — the OS still resolves that in-bounds path to the outside file');
    const links = await countLinksToSlug('escape-a', 'dupe');
    assert(links.files === 0, 'M4 #3: countLinksToSlug does not scan through the symlinked folder either');
    await assertThrowsStatus(() => getWikiPage('escape-a', 'concepts/dupe.md'), 400,
      'M4 #4: getWikiPage still refuses it — reader and scanner now agree');
    let msg = '';
    try { await getWikiPage('escape-a', 'concepts/dupe.md'); } catch (e) { msg = e.message; }
    assert(/symlink/i.test(msg) && /outside/i.test(msg),
      'M4 #5: the refusal explains WHAT is wrong (a symlink leaving the wiki), not a bare "Invalid page path"');
    assert(msg.length > 60, 'M4 #6: …and it is actionable prose, not a two-word error');

    unchanged('H1 #35: FINAL — after every destructive entry point was exercised, every outside file is byte-identical');
    assert(readFileSync(secret, 'utf8').includes('sensitive-line'), 'H1 #36: the out-of-tree secret file is untouched');
  }

  // ── 8c. H1 — the gate is STRUCTURAL, not remembered ──────────────────────
  //
  // Sections 8/8b prove the handlers that exist today are gated. They cannot
  // prove the NEXT handler will be. This does: it reads health.js's source
  // and fails if the module regains any way to build a filesystem path that
  // does not pass through wikiFile().
  //
  // Deliberately dumb and syntactic, as the independent cross-check to 8b's
  // behavioural fixtures — the two fail for different reasons, so a fixture
  // that silently stops reaching a code path (the previous round's failure
  // mode) cannot make both green.
  section('8c. H1 — the containment gate is unbypassable by construction');
  {
    const healthSrc = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'brain', 'health.js'),
      'utf8'
    );
    // Blank out comments and string/template literals so prose ABOUT the rule
    // (this file's own docblocks quote `path.join(wikiDir, …)`) is never
    // mistaken for code that breaks it.
    const code = stripCommentsAndStrings(healthSrc);
    assert(code.length === healthSrc.length,
      '8c #0: the source blanker preserves offsets, so any line number it reports is real');

    // ── WHY THE PRIMARY MEASUREMENT IS THE DUMB ONE ─────────────────────
    //
    // There is no JS parser in this repo's dependencies, so this guard has to
    // read the source itself — and a source scanner that goes silently blind
    // is a documented failure mode here (v3.1.0: a null-safety scanner
    // desynced on a nested template literal, saw 78 of 90 declarations, and
    // reported every assertion green with a real bug present).
    //
    // I built a whole-file lexer AND a per-line scanner and tried to make the
    // disagreement between them the safety net. It is not one: I corrupted the
    // lexer four ways (disabled block comments, line comments, strings, regex
    // literals) and the two scanners agreed every time, because health.js's
    // prose happens to quote code inside backticks, which one blanker or the
    // other swallows regardless. A tripwire that cannot be made to fire is
    // theatre, so it is not shipped as one.
    //
    // What ships instead: the PER-LINE scanner is the primary measurement.
    // It holds NO cross-line state, so there is nothing to desync — the entire
    // class of bug above is unreachable by construction rather than detected
    // after the fact. Its two assumptions are narrow, and are asserted
    // directly below rather than hoped for. The lexer is kept only as a second
    // opinion; if it disagrees, that is reported, but nothing load-bearing
    // rests on it.
    //
    // The genuinely independent check on all of this is section 8b, which is
    // behavioural: real symlinks, real syscalls, and a byte-level snapshot of
    // every file outside the wiki. 8b and 8c fail for entirely different
    // reasons, which is the property that matters.

    // Precondition 1: every block-comment interior line starts with `*`, so a
    // per-line scan can recognise comment body without tracking state.
    const srcLines = healthSrc.split('\n');
    let inBlock = false;
    const strayCommentLines = [];
    for (let n = 0; n < srcLines.length; n++) {
      const t = srcLines[n].trim();
      if (!inBlock && t.startsWith('/*')) { inBlock = !t.includes('*/'); continue; }
      if (inBlock) {
        if (!t.startsWith('*')) strayCommentLines.push(n + 1);
        if (t.includes('*/')) inBlock = false;
      }
    }
    assert(strayCommentLines.length === 0,
      '8c #0a: PRECONDITION — every block-comment line in health.js starts with `*`, so the per-line scanner can tell comment from code',
      `lines that do not: ${strayCommentLines.join(', ')} — fix the comment style, or this guard is measuring the wrong thing`);

    // The comment classifier itself — validated by precondition 1 above, and
    // used by both precondition 2 and every assertion further down.
    const isCommentLine = (line) => {
      const t = line.trim();
      return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
    };

    // Precondition 2: no multi-line template literal in CODE — the other thing
    // a stateless per-line scan cannot see across. Scoped to code lines
    // because prose is already excluded by precondition 1, and a docblock
    // legitimately wraps a backtick-quoted snippet across two lines.
    const oddBacktickLines = [];
    for (let n = 0; n < srcLines.length; n++) {
      if (isCommentLine(srcLines[n])) continue;
      const ticks = (srcLines[n].match(/(?<!\\)`/g) || []).length;
      if (ticks % 2 !== 0) oddBacktickLines.push(n + 1);
    }
    assert(oddBacktickLines.length === 0,
      '8c #0b: PRECONDITION — no template literal in health.js spans lines, so nothing passes the scanner uncounted',
      `unbalanced backticks on code line(s): ${oddBacktickLines.join(', ')}`);

    // Anti-vacuity: the scanner must actually be finding the filesystem calls.
    // A scanner that matches nothing satisfies every "must not appear" test.
    const fsSites = fsCallLinesPerLine(healthSrc);
    assert(fsSites.size >= 25,
      '8c #0c: ANTI-VACUITY — the per-line scan finds health.js\'s filesystem call sites (a scanner matching nothing would pass everything below)',
      `found only ${fsSites.size}`);

    // Second opinion only — reported, not relied upon (see the note above).
    const lexed = fsCallLinesLexed(code);
    const disagree = [...new Set([
      ...[...lexed].filter(x => !fsSites.has(x)),
      ...[...fsSites].filter(x => !lexed.has(x)),
    ])].sort();
    assert(disagree.length === 0,
      '8c #0d: second opinion — the whole-file lexer agrees with the per-line scan on every call site',
      `disagreements: ${disagree.join(', ')}`);

    // Code lines only, per-line, stateless — the primary view of the source.
    const codeLines = srcLines.map((line) => {
      if (isCommentLine(line)) return '';
      const cut = line.indexOf('//');
      const l = cut >= 0 ? line.slice(0, cut) : line;
      return l.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, (m) => ' '.repeat(m.length));
    });

    // (a) resolveInsideWiki is reached ONLY through wikiFile.
    const gateCalls = codeLines.filter(l => /\bresolveInsideWiki\s*\(/.test(l));
    assert(gateCalls.length === 1,
      '8c #1: resolveInsideWiki is called exactly once in health.js — inside wikiFile',
      `found ${gateCalls.length} call sites`);

    // (b) Exactly one path.join in executable code: walkMdFiles's
    //     path.join(dir, e.name), where `dir` is already contained. Any other
    //     is a new way to build an absolute path outside the gate.
    const joins = [];
    codeLines.forEach((l, n) => {
      for (const m of l.matchAll(/path\.join\s*\(([^)]*)\)/g)) joins.push({ line: n + 1, args: m[1].trim() });
    });
    assert(joins.length === 1 && joins[0].args === 'dir, e.name',
      '8c #2: health.js contains exactly one path.join — the documented, contained one in walkMdFiles',
      `found: ${JSON.stringify(joins)}`);

    // (c) path.resolve is only ever used to COMPARE two already-gated paths.
    let resolveSites = 0;
    codeLines.forEach((l, n) => {
      if (!/path\.resolve\s*\(/.test(l)) return;
      resolveSites++;
      assert(l.includes('==='),
        `8c #3: path.resolve on line ${n + 1} is a comparison, not a path being built`, l.trim());
    });
    assert(resolveSites > 0, '8c #3b: …and path.resolve sites were actually found (not a vacuous pass)');

    // (d) No string concatenation onto the wiki root — the obvious way to
    //     rebuild an escaping path while satisfying (b) and (c).
    const joined = codeLines.join('\n');
    assert(!/wikiDir\s*\+/.test(joined) && !/\$\{\s*wikiDir\s*\}/.test(healthSrc),
      '8c #4: no path is built by concatenating onto wikiDir');

    // (e) PROVENANCE. Every filesystem call passes a bare identifier, and
    //     every declaration of that identifier produces its path from an
    //     allow-listed source. This is the load-bearing check, and it is the
    //     manual enumeration argument mechanised: a path reaching a syscall
    //     must first have been NAMED, and naming it is where provenance is
    //     checked.
    //
    //     It replaces an earlier version that only looked for `wikiDir +` and
    //     `${wikiDir}` BY NAME. An auditor defeated that in one line:
    //
    //         const base = wikiDir;                                  // alias
    //         const target = base + '/' + issue.folder + '/' + …;    // walks past
    //         await rm(target);
    //
    //     Reproduced here, in the shape that actually matters — a PRIVATE
    //     handler, since every fix handler in this module is private, so the
    //     export-surface pin (#7) does not see it. Checking the DECLARATION
    //     instead makes the alias irrelevant: `target`'s own initialiser is a
    //     concatenation, which is not an allow-listed producer, so it fails
    //     whatever the left-hand side was called.
    const IDENT = /^[A-Za-z_$][\w$]*$/;
    const inlineArgs = [];
    const fsArgNames = new Set();
    let checked = 0;
    for (const prim of FS_PRIMS) {
      const re = new RegExp(`\\b${prim}\\s*\\(`, 'g');
      for (const m of joined.matchAll(re)) {
        const open = m.index + m[0].length - 1;
        const arg = firstArgumentText(joined, open);
        if (arg === null) continue;                 // a declaration, not a call
        checked++;
        if (IDENT.test(arg)) fsArgNames.add(arg);
        else inlineArgs.push(`${prim}(${arg.slice(0, 60)}) at line ${joined.slice(0, m.index).split('\n').length}`);
      }
    }
    assert(checked >= 40, '8c #5: the scanner actually found the filesystem call sites (independent sanity check, not a vacuous pass)',
      `only ${checked} call sites matched — the scanner is looking at the wrong thing`);
    assert(inlineArgs.length === 0,
      '8c #6: every filesystem call in health.js takes a NAMED path, never an inline expression',
      inlineArgs.join('; '));
    assert(fsArgNames.size >= 8,
      '8c #6b: …and those names were actually collected (guards #6c below against passing vacuously)',
      `collected ${fsArgNames.size}`);

    // The ONLY expressions allowed to produce a path in this module.
    // `at(` is fixOrphanLink's local helper, which returns wikiFile()'s result
    // — pinned separately below so the allow-list cannot be widened by
    // redefining it. `path.join(dir, e.name)` is walkMdFiles's single
    // contained join, already pinned by #2.
    const PRODUCER = /^(?:wikiFile\(|wikiPath\(|at\(|path\.join\(dir, e\.name\))/;

    // PRODUCER alone only checks a PREFIX, and a prefix test is not a
    // provenance test: `wikiFile(...) || issue.sourceFile` and
    // `wikiFile(...) ? wikiFile(...) : issue.sourceFile` both start with a
    // producer and both hand an attacker-controlled path to the syscall.
    // Both bypassed an earlier draft of this check — found by attacking my own
    // fix rather than re-running the one shape I had been shown.
    //
    // So an initialiser is split into its branches at `||`, `??` and `?:`
    // (depth-0 only), and EVERY branch must be a producer call that consumes
    // the entire branch, or a literal that cannot be a path. `at(…) || at(…)`
    // in fixOrphanLink is exactly why branches are allowed at all.
    const splitBranches = (rhs) => {
      const parts = []; let depth = 0, cur = '';
      for (let i = 0; i < rhs.length; i++) {
        const c = rhs[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        if (depth === 0) {
          if ((c === '|' && rhs[i + 1] === '|') || (c === '?' && rhs[i + 1] === '?')) {
            parts.push(cur); cur = ''; i++; continue;
          }
          if (c === '?' || c === ':') { parts.push(cur); cur = ''; continue; }
        }
        cur += c;
      }
      parts.push(cur);
      return parts.map(x => x.trim()).filter(Boolean);
    };
    const isCompleteProducerCall = (expr) => {
      if (!PRODUCER.test(expr)) return false;
      const open = expr.indexOf('(');
      let depth = 0;
      for (let i = open; i < expr.length; i++) {
        if (expr[i] === '(') depth++;
        else if (expr[i] === ')') { depth--; if (depth === 0) return i === expr.length - 1; }
      }
      return false;
    };
    // true only if every branch is safe AND at least one really produces a path
    const producerOk = (rhs) => {
      const branches = splitBranches(rhs);
      if (!branches.length) return false;
      let any = false;
      for (const b of branches) {
        if (isCompleteProducerCall(b)) { any = true; continue; }
        if (NOT_A_PATH.test(b)) continue;
        return false;
      }
      return any;
    };
    // Arrays whose ELEMENTS are already contained — walkMdFiles gates its own
    // symlinked leaves, so `for (const full of allFiles)` is safe.
    const ITERABLE_PRODUCER = /^(?:await\s+)?walkMdFiles\(/;
    // Initialisers that are obviously not paths at all (same name reused for
    // an unrelated local — e.g. `let p = 0` inside the Jaro-Winkler loop).
    const NOT_A_PATH = /^(?:-?\d+(?:\.\d+)?|''|""|``|\[\]|\{\}|null|true|false|new (?:Map|Set)\(\))$/;
    // Parameters that receive an already-verified path from their caller.
    const VERIFIED_PARAMS = new Set(['wikiDir', 'rootDir', 'dir']);

    // ── Classify EVERY binding of every name that reaches a syscall ───────
    //
    // An earlier version of this check inspected only `const|let|var NAME =`
    // declarations. An auditor defeated it in two lines:
    //
    //     let full = wikiFile(wikiDir, issue.sourceFile);
    //     if (!full) full = issue.sourceFile;   // bare reassignment, unseen
    //
    // …and `fixIssue` then rewrote a file outside the wiki while all 206
    // assertions passed. It also never saw `for (const full of …)`, which is
    // how `full` is ACTUALLY bound in three of this module's loops — so the
    // one binding form the shipping code relies on most was unchecked.
    //
    // The design lesson is not "add reassignments". It is that an allow-list
    // of binding forms silently permits every form it forgot. So this now
    // classifies every binding shape it knows AND fails on any `NAME =` it
    // could not classify — unknown shapes are red, not quietly allowed.
    const bindingsOf = (name) => {
      const b = [];
      const esc = name.replace(/[$]/g, '\\$');
      codeLines.forEach((l, n) => {
        const ln = n + 1;
        if (!new RegExp(`\\b${esc}\\b`).test(l)) return;
        let m;
        if (new RegExp(`catch\\s*\\(\\s*${esc}\\s*\\)`).test(l)) { b.push({ kind: 'catch', ln }); return; }
        if ((m = l.match(new RegExp(`for\\s*\\(\\s*(?:const|let|var)\\s+${esc}\\s+(?:of|in)\\s+([^)]+)\\)`)))) {
          b.push({ kind: 'iterate', src: m[1].trim(), ln }); return;
        }
        if ((m = l.match(new RegExp(`^\\s*(?:const|let|var)\\s+${esc}\\s*=\\s*(.+?);?\\s*$`)))) {
          b.push({ kind: 'decl', rhs: m[1].trim(), ln }); return;
        }
        if ((m = l.match(/^\s*(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(.+?);?\s*$/))
            && new RegExp(`\\b${esc}\\b`).test(m[1])) {
          b.push({ kind: 'destructure', src: m[2].trim(), ln }); return;
        }
        // Destructuring ASSIGNMENT (no declarator) — never allowed.
        if (!/^\s*(?:const|let|var)\b/.test(l)
            && new RegExp(`[{\\[][^}\\]]*\\b${esc}\\b[^}\\]]*[}\\]]\\s*=(?!=)`).test(l)) {
          b.push({ kind: 'destructure-assign', ln }); return;
        }
        if (new RegExp(`\\b${esc}\\s*(?:\\+=|-=|\\*=|/=|\\|\\|=|\\?\\?=|&&=)`).test(l)) {
          b.push({ kind: 'compound', ln }); return;
        }
        // Function / arrow parameter lists only (never a plain call site).
        const pm = l.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+[\w$]*\s*\(([^)]*)\)/)
                || l.match(/^\s*(?:const|let|var)\s+[\w$]*\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/)
                || l.match(/\(([^)]*)\)\s*=>\s*\{?\s*$/);
        if (pm && pm[1].split(',').map(x => x.trim().split('=')[0].trim()).includes(name)) {
          b.push({ kind: 'param', ln }); return;
        }
        // Bare reassignment.
        if ((m = l.match(new RegExp(`(?:^|[;{})\\s])${esc}\\s*=(?!=)\\s*(.+?);?\\s*$`)))
            && !/^\s*(?:const|let|var)\b/.test(l)) {
          b.push({ kind: 'assign', rhs: m[1].trim(), ln }); return;
        }
        // Anything else that puts this name immediately before a single `=`
        // is a binding shape this checker does not understand.
        if (new RegExp(`\\b${esc}\\s*=(?!=)`).test(l)) { b.push({ kind: 'UNCLASSIFIED', ln, text: l.trim() }); }
      });
      return b;
    };

    const declsByName = new Map();
    codeLines.forEach((l, n) => {
      const d = l.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+?);?\s*$/);
      if (d) {
        if (!declsByName.has(d[1])) declsByName.set(d[1], []);
        declsByName.get(d[1]).push({ rhs: d[2].trim(), line: n + 1 });
      }
    });
    const declaredFrom = (name, re) => (declsByName.get(name) || []).some(x => re.test(x.rhs));

    // Two distinct failure modes, reported differently because the remedy
    // differs. The guard is name-scoped, not scope-aware (no JS parser in this
    // repo), so it cannot tell a path named `target` from the SLUG named
    // `target` in applyBrokenLinkFixes. It therefore refuses any name that is
    // BOTH — which is a false positive for a perfectly-gated new handler that
    // happens to reuse a name, and is deliberately the safe direction: the
    // build fails, nothing ships ungated, and the fix is a rename. The message
    // has to say that, or the next person to hit it will weaken the guard
    // instead of renaming a variable.
    const badProvenance = [];
    const nameCollisions = [];
    for (const name of fsArgNames) {
      const bindings = bindingsOf(name);
      if (bindings.length === 0) { badProvenance.push(`${name}: no binding found anywhere`); continue; }
      let sawProducer = false;
      const before = badProvenance.length;
      for (const b of bindings) {
        switch (b.kind) {
          case 'decl':
          case 'assign':
            if (producerOk(b.rhs)) { sawProducer = true; break; }
            if (NOT_A_PATH.test(b.rhs)) break;
            badProvenance.push(`line ${b.ln}: ${b.kind} ${name} = ${b.rhs.slice(0, 55)}`);
            break;
          case 'iterate':
            if (declaredFrom(b.src, ITERABLE_PRODUCER)) { sawProducer = true; break; }
            badProvenance.push(`line ${b.ln}: for (${name} of ${b.src.slice(0, 40)}) — elements not from walkMdFiles()`);
            break;
          case 'destructure':
            if (declaredFrom(b.src, /^resolveSemanticDupePair\(/)) { sawProducer = true; break; }
            badProvenance.push(`line ${b.ln}: ${name} destructured from ${b.src.slice(0, 40)}`);
            break;
          case 'param':
            if (VERIFIED_PARAMS.has(name)) { sawProducer = true; break; }
            badProvenance.push(`line ${b.ln}: ${name} is a function parameter but not in VERIFIED_PARAMS`);
            break;
          default:
            badProvenance.push(`line ${b.ln}: ${name} bound by ${b.kind}${b.text ? ` — ${b.text.slice(0, 45)}` : ''}`);
        }
      }
      if (!sawProducer) badProvenance.push(`${name}: no binding produces a gated path`);
      // Producer AND non-producer bindings of one name: ambiguous to a
      // name-scoped guard. Re-file those as a collision, with the remedy.
      if (sawProducer && badProvenance.length > before) {
        nameCollisions.push(...badProvenance.splice(before).map(x => x));
        nameCollisions.push(`  ↳ "${name}" is used BOTH for a gated path and for something else in health.js.`
          + ` This guard is name-scoped, so it cannot tell them apart — rename one of them`
          + ` (this is why fixOrphanLink's helper binds \`abs\`, not \`p\`).`);
      }
    }
    assert(badProvenance.length === 0,
      '8c #6c: PROVENANCE — every binding of every path that reaches a syscall comes from wikiFile()/wikiPath(), never from concatenation, interpolation, aliasing, reassignment, or an unrecognised shape',
      badProvenance.join(' | '));
    assert(nameCollisions.length === 0,
      '8c #6c-a: …and no name is used for both a gated path and a non-path (the guard is name-scoped; see the message for the remedy)',
      nameCollisions.join(' | '));

    // Anti-vacuity for the classifier itself: it must be finding real bindings,
    // and must recognise the forms health.js actually uses today.
    const kinds = new Set();
    for (const name of fsArgNames) for (const b of bindingsOf(name)) kinds.add(b.kind);
    assert(kinds.has('decl') && kinds.has('iterate') && kinds.has('param') && kinds.has('destructure'),
      '8c #6c-b: …and the classifier recognises all four binding forms health.js actually uses (decl, for-of, param, destructure)',
      `saw: ${[...kinds].join(', ')}`);

    // The allow-list trusts `at(` — pin what it is, so widening the allow-list
    // requires changing this assertion too.
    assert(/const at = \(folder, slug\) => \{\s*\n\s*const abs = wikiFile\(/.test(healthSrc),
      '8c #6d: fixOrphanLink\'s `at()` helper still resolves through wikiFile — the one indirection the allow-list permits');

    // No re-importing fs under another name, and no aliasing a primitive.
    assert(!/\bimport\s*\(/.test(joined),
      '8c #6e: health.js performs no dynamic import (a second handle on fs would sidestep every check above)');
    const aliased = FS_PRIMS.filter(prim =>
      new RegExp(`(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*${prim}\\s*[;,\\n]`).test(joined));
    assert(aliased.length === 0,
      '8c #6f: no filesystem primitive is bound to another name (which would hide its call sites from #6)',
      aliased.join(', '));

    // (f) The export surface is pinned. A new exported function is a new way
    //     in, and this fails until whoever adds it classifies it in 8b above.
    //
    //     `listMd` (added when GET /api/wiki/:domain/list was built on top
    //     of it, so the browse-list inventory and scanWiki() cannot silently
    //     diverge on what "a page" is — see scripts/test-wiki-list.js) needs
    //     NO §8b case: it only calls `readdir` and resolves through
    //     `wikiFile` — no write/rm/unlink anywhere in it — matching the
    //     existing precedent for the other read-only exports already in this
    //     list (`countLinksToSlug`, `findSemanticCandidatePairs`,
    //     `previewSemanticDuplicateMerge`, `scanWiki`), none of which carry
    //     an §8b case either.
    const exports = Object.keys(healthModule).sort();
    const KNOWN = [
      'AUTO_FIXABLE', 'SEMANTIC_DUPE_DEFAULT_CAP', 'SEMANTIC_DUPE_MAX_DOMAIN_PAGES',
      'applyBrokenLinkFixes', 'applyOrphanRescue', 'countLinksToSlug',
      'findSemanticCandidatePairs', 'fixAllSafe', 'fixIssue', 'fixSemanticDuplicatesBatch',
      'listMd', 'previewSemanticDuplicateMerge', 'scanWiki',
    ].sort();
    assert(JSON.stringify(exports) === JSON.stringify(KNOWN),
      '8c #7: health.js\'s export surface is unchanged — a NEW export must be added to section 8b\'s enumeration and to this list',
      `got ${JSON.stringify(exports)}`);

    // (g) …and every fix type the router will dispatch is exercised above.
    const covered = new Set(['brokenLinks', 'folderPrefixLinks', 'crossFolderDupes',
                             'hyphenVariants', 'missingBacklinks', 'orphanLink', 'semanticDupe']);
    const uncovered = [...healthModule.AUTO_FIXABLE].filter(t => !covered.has(t));
    assert(uncovered.length === 0,
      '8c #8: every AUTO_FIXABLE type has an escape case in section 8/8b',
      `uncovered: ${uncovered.join(', ')}`);
  }

  // ── 8d. POSITIVE PATH — every mutating export must SUCCEED on valid input
  //
  // Why this section exists, in one sentence: sections 8/8b assert that these
  // functions REFUSE bad input, and a `ReferenceError` is a refusal.
  //
  // Concretely — `previewSemanticDuplicateMerge` shipped in this very release
  // throwing `ReferenceError: removeSlug is not defined` on EVERY valid pair,
  // and all five of its tests passed, because all five fed it invalid input
  // and asserted a throw via `catch { refused = true }`. The route returned
  // HTTP 500. Preview is the destructive-merge SAFETY GATE (v2.4.5: the Merge
  // button stays disabled until a preview succeeds), so the reviewed path was
  // broken while the un-gated "Merge all N" bulk path still deleted files — a
  // safety inversion, shipped green.
  //
  // The hole was structural, not a one-off: an audit of the OFFLINE manifest
  // found that health.js's ENTIRE mutation surface had negative-only coverage.
  // The suites that do exercise it positively (test-beta15/16/17-production)
  // are all LIVE — they need API keys and never run in `npm test`. So a
  // refactor could break every Health fix in the app and CI would stay green.
  //
  // Every export below is now asserted to actually DO ITS JOB. All offline,
  // all deterministic, no LLM.
  section('8d. POSITIVE PATH — the mutating surface actually works on valid input');
  {
    // Fresh, self-contained domain per case: these fixes rewrite links across
    // a whole domain, so sharing one fixture would let cases mask each other.
    let seq = 0;
    const mk = (files) => {
      const name = `happy${++seq}`;
      const w = wikiDirFor(name);
      for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(w, f), { recursive: true });
      writeFileSync(path.join(domainsDir, name, 'CLAUDE.md'), `# Domain: Happy ${seq}\n`, 'utf8');
      for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(w, rel), body, 'utf8');
      return { name, w, read: (rel) => readFileSync(path.join(w, rel), 'utf8') };
    };

    // ── previewSemanticDuplicateMerge — THE regression this section is for ──
    {
      const d = mk({
        'concepts/openai.md':  '# OpenAI\n\n## Key Facts\n- founded 2015\n',
        'concepts/open-ai.md': '# Open AI\n\n## Key Facts\n- makes GPT\n',
        'summaries/s1.md':     '# S1\n\nUses [[open-ai]] and [[open-ai|OA]].\n',
        'entities/e1.md':      '# E1\n\nSee [[open-ai]].\n',
      });
      let prev = null, threw = null;
      try {
        prev = await previewSemanticDuplicateMerge(d.name, {
          keepSlug: 'openai', keepFolder: 'concepts', removeSlug: 'open-ai', removeFolder: 'concepts',
        });
      } catch (e) { threw = e; }
      assert(!threw, '8d #1: previewSemanticDuplicateMerge RETURNS on a valid pair — it threw ReferenceError on every valid input when this section was written',
        threw && `${threw.constructor.name}: ${threw.message}`);
      assert(prev && prev.keepPath === 'concepts/openai.md' && prev.removePath === 'concepts/open-ai.md',
        '8d #2: …with the keep/remove paths the UI shows');
      assert(prev && prev.affectedCount === 2,
        '8d #3: …the right number of files whose links would be rewritten', prev && `got ${prev.affectedCount}`);
      assert(prev && prev.totalLinksRewritten === 3,
        '8d #4: …counting BOTH plain and aliased links (3 across 2 files)', prev && `got ${prev.totalLinksRewritten}`);
      const paths = prev ? prev.affectedFiles.map(f => f.path).sort() : [];
      assert(JSON.stringify(paths) === JSON.stringify(['entities/e1.md', 'summaries/s1.md']),
        '8d #5: …and names exactly the affected files', JSON.stringify(paths));
      assert(prev && prev.mergedPreview.includes('founded 2015') && prev.mergedPreview.includes('makes GPT'),
        '8d #6: …and the merged preview carries facts from BOTH pages (this is what the user reviews before deleting one)');
      assert(prev && prev.mergedLength > 0, '8d #7: …with a real merged length');
    }

    // ── fixSemanticDuplicate + the batch path actually merge and delete ─────
    {
      const d = mk({
        'concepts/openai.md':  '# OpenAI\n\n## Key Facts\n- founded 2015\n',
        'concepts/open-ai.md': '# Open AI\n\n## Key Facts\n- makes GPT\n',
        'summaries/s1.md':     '# S1\n\nUses [[open-ai]] and [[open-ai|OA]].\n',
      });
      const r = await fixIssue(d.name, 'semanticDupe', {
        keepSlug: 'openai', keepFolder: 'concepts', removeSlug: 'open-ai', removeFolder: 'concepts',
      });
      assert(r.fixed === 1, '8d #8: fixIssue(semanticDupe) MERGES a genuine duplicate');
      assert(!existsSync(path.join(d.w, 'concepts/open-ai.md')), '8d #9: …the duplicate file is deleted');
      assert(d.read('concepts/openai.md').includes('makes GPT'), '8d #10: …its facts survive in the kept page');
      assert(d.read('summaries/s1.md').includes('[[openai]]') && !d.read('summaries/s1.md').includes('[[open-ai]]'),
        '8d #11: …and inbound links are repointed to the canonical slug');
      assert(d.read('summaries/s1.md').includes('[[openai|OA]]'), '8d #12: …preserving alias labels');
    }
    {
      const d = mk({
        'concepts/a-one.md': '# A One\n\n## Key Facts\n- x\n',
        'concepts/aone.md':  '# AOne\n\n## Key Facts\n- y\n',
      });
      const r = await fixSemanticDuplicatesBatch(d.name, [
        { keepSlug: 'a-one', keepFolder: 'concepts', removeSlug: 'aone', removeFolder: 'concepts' },
      ]);
      assert(r.merged === 1, '8d #13: fixSemanticDuplicatesBatch merges a valid pair (the "Merge all N" bulk path)', JSON.stringify(r));
      assert(!existsSync(path.join(d.w, 'concepts/aone.md')), '8d #14: …and really deletes the duplicate');
    }

    // ── findSemanticCandidatePairs — had ZERO coverage in any suite ─────────
    {
      const d = mk({
        'concepts/openai.md':  '# OpenAI\n',
        'concepts/open-ai.md': '# Open AI\n',
        'concepts/zebra.md':   '# Zebra\n',
      });
      const res = await findSemanticCandidatePairs(d.name);
      assert(res.pageCount === 3, '8d #15: findSemanticCandidatePairs counts the pages it considered', `got ${res.pageCount}`);
      const hit = res.pairs.some(p =>
        [p.slugA, p.slugB].sort().join('|') === ['open-ai', 'openai'].sort().join('|'));
      assert(hit, '8d #16: …and surfaces the near-duplicate pair (this export had no test anywhere before)',
        JSON.stringify(res.pairs));
    }

    // ── the deterministic fix handlers, one valid case each ────────────────
    {
      const d = mk({ 'concepts/rag.md': '# RAG\n', 'entities/e.md': '# E\n\nSee [[r-a-g]].\n' });
      const scan = await scanWiki(d.name);
      const issue = scan.brokenLinks.find(b => b.linkText === 'r-a-g');
      assert(!!issue && issue.suggestedTarget === 'rag',
        '8d #17: scanWiki finds a broken link AND suggests the right target', JSON.stringify(issue));
      const r = await fixIssue(d.name, 'brokenLinks', issue);
      assert(r.fixed === 1 && d.read('entities/e.md').includes('[[rag]]'),
        '8d #18: fixIssue(brokenLinks) rewrites it to the suggested target');
    }
    {
      const d = mk({ 'concepts/rag.md': '# RAG\n', 'entities/e.md': '# E\n\nSee [[concepts/rag]].\n' });
      const scan = await scanWiki(d.name);
      assert(scan.folderPrefixLinks.length === 1, '8d #19: scanWiki finds a folder-prefixed link');
      const r = await fixIssue(d.name, 'folderPrefixLinks', scan.folderPrefixLinks[0]);
      assert(r.fixed === 1 && d.read('entities/e.md').includes('[[rag]]') && !d.read('entities/e.md').includes('[[concepts/rag]]'),
        '8d #20: fixIssue(folderPrefixLinks) strips the folder prefix');
    }
    {
      const d = mk({
        'entities/google.md': '# Google\n\n## Key Facts\n- entity fact\n',
        'concepts/google.md': '# Google\n\n## Key Facts\n- concept fact\n',
      });
      const scan = await scanWiki(d.name);
      assert(scan.crossFolderDupes.length === 1, '8d #21: scanWiki finds a cross-folder duplicate');
      const r = await fixIssue(d.name, 'crossFolderDupes', scan.crossFolderDupes[0]);
      assert(r.fixed === 1, '8d #22: fixIssue(crossFolderDupes) merges them');
      assert(!existsSync(path.join(d.w, 'concepts/google.md')), '8d #23: …removing the concepts/ copy');
      assert(d.read('entities/google.md').includes('concept fact'), '8d #24: …and keeping its facts');
    }
    {
      const d = mk({
        'entities/tali-rezun.md':     '# Tali Rezun\n\n## Key Facts\n- canonical\n',
        'entities/dr.-tali-rezun.md': '# Dr Tali Rezun\n\n## Key Facts\n- variant fact\n',
      });
      const scan = await scanWiki(d.name);
      assert(scan.hyphenVariants.length === 1, '8d #25: scanWiki groups an honorific hyphen variant');
      const r = await fixIssue(d.name, 'hyphenVariants', scan.hyphenVariants[0]);
      assert(r.fixed === 1, '8d #26: fixIssue(hyphenVariants) merges the variant into the canonical slug');
      assert(!existsSync(path.join(d.w, 'entities/dr.-tali-rezun.md')), '8d #27: …deleting the variant file');
      assert(d.read('entities/tali-rezun.md').includes('variant fact'), '8d #28: …and keeping its facts');
    }
    {
      const d = mk({
        'entities/openai.md': '# OpenAI\n\n## Related\n- [[rag]]\n',
        'concepts/rag.md':    '# RAG\n',
        'summaries/s1.md':    '# S1\n\n## Entities Mentioned\n- [[openai]]\n',
      });
      const scan = await scanWiki(d.name);
      assert(scan.missingBacklinks.length === 1, '8d #29: scanWiki finds a summary whose entity lacks the backlink');
      const r = await fixIssue(d.name, 'missingBacklinks', scan.missingBacklinks[0]);
      assert(r.fixed === 1 && d.read('entities/openai.md').includes('[[summaries/s1]]'),
        '8d #30: fixIssue(missingBacklinks) injects the backlink into the entity');
    }
    {
      const d = mk({ 'entities/lonely.md': '# Lonely\n', 'concepts/home.md': '# Home\n\n## Related\n- [[x]]\n' });
      const r = await fixIssue(d.name, 'orphanLink', { orphanSlug: 'lonely', targetSlug: 'home', description: 'a rescued orphan' });
      assert(r.fixed === 1, '8d #31: fixIssue(orphanLink) links an orphan from a real page');
      assert(d.read('concepts/home.md').includes('[[lonely]]') && d.read('concepts/home.md').includes('a rescued orphan'),
        '8d #32: …writing the wikilink AND the description into Related');
    }

    // ── the bulk apply paths ───────────────────────────────────────────────
    {
      const d = mk({ 'entities/lonely.md': '# Lonely\n', 'concepts/home.md': '# Home\n\n## Related\n- [[x]]\n' });
      const r = await applyOrphanRescue(d.name, [{ orphanSlug: 'lonely', target: 'home', description: 'bulk rescue' }]);
      assert(r.rescued === 1 && r.skipped === 0, '8d #33: applyOrphanRescue rescues a valid orphan', JSON.stringify(r));
      assert(d.read('concepts/home.md').includes('[[lonely]]'), '8d #34: …and the link is on disk');
    }
    {
      const d = mk({
        'concepts/rag.md': '# RAG\n',
        'entities/e.md':   '# E\n\nSee [[r-a-g]] and [[ghost]] and [[ghost|Ghosty]].\n',
      });
      const r = await applyBrokenLinkFixes(d.name, [
        { linkText: 'r-a-g', action: 'retarget', target: 'rag' },
        { linkText: 'ghost', action: 'strip' },
      ]);
      const body = d.read('entities/e.md');
      assert(r.retargeted === 1, '8d #35: applyBrokenLinkFixes retargets a resolvable link', JSON.stringify(r));
      assert(r.stripped === 2, '8d #36: …and strips the unresolvable ones', JSON.stringify(r));
      assert(r.filesChanged === 1 && r.occurrencesReplaced === 3, '8d #37: …reporting real file/occurrence counts', JSON.stringify(r));
      assert(body.includes('[[rag]]'), '8d #38: …the retarget landed');
      assert(!body.includes('[[ghost') && body.includes('Ghosty'), '8d #39: …and stripping keeps the readable alias label');
    }
    {
      const d = mk({
        'entities/google.md': '# Google\n\n## Key Facts\n- a\n',
        'concepts/google.md': '# Google\n\n## Key Facts\n- b\n',
        'concepts/rag.md':    '# RAG\n',
        'entities/e.md':      '# E\n\nSee [[concepts/rag]].\n',
      });
      const r = await fixAllSafe(d.name);
      assert(r.fixed >= 2, '8d #40: fixAllSafe ("Fix N safe issues") actually fixes multiple types in one pass', JSON.stringify(r.byType));
      assert(!existsSync(path.join(d.w, 'concepts/google.md')), '8d #41: …the cross-folder dupe is gone');
      assert(d.read('entities/e.md').includes('[[rag]]'), '8d #42: …and the folder-prefix link is normalised');
    }
    {
      const d = mk({
        'concepts/rag.md': '# RAG\n',
        'entities/a.md':   '# A\n\n[[rag]] and [[rag|R]]\n',
        'entities/b.md':   '# B\n\n[[concepts/rag]]\n',
      });
      const c = await countLinksToSlug(d.name, 'rag');
      assert(c.files === 2 && c.links === 3,
        '8d #43: countLinksToSlug counts real inbound links across files and link forms', JSON.stringify(c));
    }

    // ── scanWiki on a clean wiki reports clean (no phantom issues) ─────────
    {
      const d = mk({
        'entities/a.md':   '# A\n\nSee [[b]].\n',
        'concepts/b.md':   '# B\n\nSee [[a]].\n',
      });
      const scan = await scanWiki(d.name);
      assert(scan.brokenLinks.length === 0 && scan.crossFolderDupes.length === 0
        && scan.hyphenVariants.length === 0 && scan.folderPrefixLinks.length === 0,
        '8d #44: a clean wiki scans clean — the gate does not invent issues on ordinary pages',
        JSON.stringify(scan.counts));
      assert(scan.orphans.length === 0,
        '8d #45: …and two mutually-linked pages are not reported as orphans', JSON.stringify(scan.orphans));
      assert(scan.counts.entities === 1 && scan.counts.concepts === 1,
        '8d #46: …while the inventory still SEES both pages (a gate that hid them would also pass every "no issues" test above)',
        JSON.stringify(scan.counts));
    }
  }

  // ── 9. H5 — backlink cache must not freeze ──────────────────────────────
  //
  // Old signature was {count, maxMtimeMs}. A max is a ratchet: one file with
  // an mtime ahead of the clock pins it forever, so every later write
  // compares `< max` and — with no TTL by design — the index never rebuilds
  // for the life of the process.
  section('9. H5 — cache signature cannot be pinned by a future mtime');
  {
    const dom = 'h5';
    mkdirSync(path.join(domainsDir, dom), { recursive: true });
    writeFileSync(path.join(domainsDir, dom, 'CLAUDE.md'), '# Domain: H5\n', 'utf8');
    writePageFile(dom, 'concepts/target.md', '---\ntags: [type/concept]\n---\n# Target\n');
    writePageFile(dom, 'entities/source.md', '---\ntags: [type/entity]\n---\n# Source\n\nNo link yet.\n');

    // A file whose mtime is FAR in the future — exactly what one
    // out-of-sync device, `cp -p`, `rsync -a`, a tar extract, or an NTP
    // step-back leaves behind.
    const poisoned = path.join(wikiDirFor(dom), 'entities/poisoned.md');
    writePageFile(dom, 'entities/poisoned.md', '---\ntags: [type/entity]\n---\n# Poisoned\n');
    const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    utimesSync(poisoned, farFuture, farFuture);

    __clearWikiReadCache(dom);
    let bl = await getBacklinks(dom, 'concepts', 'target');
    assert(bl.length === 0, 'H5 #1: baseline — target has no backlinks yet (cache primed WITH the future-dated file present)');

    // Now edit an EXISTING file in place, with a NORMAL (present) mtime —
    // file count unchanged, and its mtime is far BELOW the poisoned max.
    const src = path.join(wikiDirFor(dom), 'entities/source.md');
    writeFileSync(src, '---\ntags: [type/entity]\n---\n# Source\n\nNow links to [[target]].\n', 'utf8');
    const now = new Date();
    utimesSync(src, now, now);

    bl = await getBacklinks(dom, 'concepts', 'target');
    assert(bl.some(b => b.path === 'entities/source.md'),
      'H5 #2: an edit whose mtime is BELOW the future-dated file still invalidates the cache (a max would have frozen the index permanently)');

    // Same-mtime rewrite: content changes, timestamp forced back to exactly
    // what it was. Only the size moves.
    const before = statSync(src);
    writeFileSync(src, '---\ntags: [type/entity]\n---\n# Source\n\nLink removed entirely, and padded.\n' + 'x'.repeat(500), 'utf8');
    utimesSync(src, before.atime, before.mtime);
    assert(statSync(src).mtimeMs === before.mtimeMs, 'H5 #3: fixture — mtime really is unchanged after the rewrite');

    bl = await getBacklinks(dom, 'concepts', 'target');
    assert(!bl.some(b => b.path === 'entities/source.md'),
      'H5 #4: a same-mtime rewrite is detected via total size (count and mtime sum both unchanged)');

    // Count-preserving add+delete where the new file inherits the deleted
    // file's exact mtime (what `cp -p` does).
    const doomed = path.join(wikiDirFor(dom), 'entities/doomed.md');
    writePageFile(dom, 'entities/doomed.md', '---\ntags: [type/entity]\n---\n# Doomed\n');
    utimesSync(doomed, now, now);
    __clearWikiReadCache(dom);
    await getBacklinks(dom, 'concepts', 'target');   // prime with doomed present
    rmSync(doomed);
    const replacement = path.join(wikiDirFor(dom), 'entities/replacement.md');
    writeFileSync(replacement, '---\ntags: [type/entity]\n---\n# Replacement\n\nLinks [[target]].\n', 'utf8');
    utimesSync(replacement, now, now);   // same mtime as the file it replaced

    bl = await getBacklinks(dom, 'concepts', 'target');
    assert(bl.some(b => b.path === 'entities/replacement.md'),
      'H5 #5: a count-preserving add+delete with identical mtimes is still detected');
  }

  // ── 10. M4 — nested pages: agree with health.js, don't just claim to ────
  section('10. M4 — nested-page parity with health.js');
  {
    const dom = 'nested';
    mkdirSync(path.join(domainsDir, dom), { recursive: true });
    writeFileSync(path.join(domainsDir, dom, 'CLAUDE.md'), '# Domain: Nested\n', 'utf8');
    // A page one level deeper than the app's flat model allows.
    writePageFile(dom, 'entities/companies/nested-corp.md',
      '---\ntags: [type/entity]\n---\n# Nested Corp\n');
    // ...and a normal page that links to it three times.
    writePageFile(dom, 'concepts/mentions.md',
      '---\ntags: [type/concept]\n---\n# Mentions\n\n' +
      'See [[nested-corp]], and [[nested-corp]] again, plus [[entities/nested-corp]].\n');

    const report = await scanWiki(dom);
    const brokenToNested = report.brokenLinks.filter(b => b.linkText.includes('nested-corp'));
    assert(brokenToNested.length === 3,
      `M4 #1: health.js reports every [[nested-corp]] link as BROKEN (got ${brokenToNested.length}) — a nested file is not a link target it can resolve`);

    __clearWikiReadCache(dom);
    const page = await getWikiPage(dom, 'entities/companies/nested-corp.md');
    assert(page.title === 'Nested Corp', 'M4 #2: the nested page is still READABLE (it exists; the user can see it in Obsidian)');
    assert(page.resolvableTarget === false, 'M4 #3: it is flagged as not a resolvable link target');
    assert(page.backlinks.length === 0,
      'M4 #4: it reports ZERO backlinks — agreeing with health.js instead of showing links health.js calls broken');

    // The depth-1 case is unaffected: same wiki, same link syntax.
    writePageFile(dom, 'entities/flat-corp.md', '---\ntags: [type/entity]\n---\n# Flat Corp\n');
    writePageFile(dom, 'concepts/mentions-flat.md',
      '---\ntags: [type/concept]\n---\n# Mentions Flat\n\nSee [[flat-corp]].\n');
    const flat = await getWikiPage(dom, 'entities/flat-corp.md');
    assert(flat.resolvableTarget === true, 'M4 #5: an ordinary depth-1 page IS a resolvable target');
    assert(flat.backlinks.some(b => b.path === 'concepts/mentions-flat.md'),
      'M4 #6: ...and its backlinks still work exactly as before (no regression)');
  }

  // ── 11. M5 — case-insensitive filesystems ───────────────────────────────
  section('11. M5 — mis-cased request resolves to the on-disk identity');
  {
    // Deterministic on EVERY filesystem: the on-disk name really is mixed
    // case with an uppercase extension, so the slug must come from the file,
    // not from a naive lowercase-suffix strip.
    writePageFile('articles', 'entities/Odd-Name.MD', '---\ntags: [type/entity]\n---\n# Odd Name\n');
    writePageFile('articles', 'concepts/points-at-odd.md',
      '---\ntags: [type/concept]\n---\n# Points At Odd\n\nSee [[Odd-Name]].\n');
    __clearWikiReadCache('articles');
    {
      const page = await getWikiPage('articles', 'entities/Odd-Name.MD');
      assert(page.slug === 'Odd-Name', `M5 #1: an uppercase .MD extension is stripped from the slug (got "${page.slug}")`);
      assert(page.backlinks.some(b => b.path === 'concepts/points-at-odd.md'),
        'M5 #2: ...so its backlinks resolve (a slug of "Odd-Name.MD" would match nothing)');
    }

    // The case-insensitive-filesystem half only runs where that's true
    // (macOS/Windows default). On a case-sensitive FS a mis-cased path
    // simply does not exist and 404s, which is also correct — so this is
    // skipped rather than failed.
    const probe = path.join(wikiDirFor('articles'), 'entities', 'TALI-REZUN.md');
    const fsIsCaseInsensitive = existsSync(probe);
    if (fsIsCaseInsensitive) {
      const lower = await getWikiPage('articles', 'entities/tali-rezun.md');
      const upper = await getWikiPage('articles', 'entities/TALI-REZUN.md');
      assert(upper.slug === 'tali-rezun', `M5 #3: a mis-cased request yields the ON-DISK slug (got "${upper.slug}")`);
      assert(upper.path === 'entities/tali-rezun.md', `M5 #4: the returned path is the on-disk path (got "${upper.path}")`);
      assert(upper.backlinks.length === lower.backlinks.length && upper.backlinks.length > 0,
        `M5 #5: a mis-cased request returns the SAME backlinks as the exact one (${upper.backlinks.length} vs ${lower.backlinks.length}) — this returned 0 before the fix`);
      const mixedFolder = await getWikiPage('articles', 'Entities/tali-rezun.md');
      assert(mixedFolder.folder === 'entities' && mixedFolder.backlinks.length === lower.backlinks.length,
        'M5 #6: a mis-cased FOLDER also resolves to the canonical folder with real backlinks');
    } else {
      ok('M5 #3–#6 skipped: filesystem is case-sensitive, where a mis-cased path correctly 404s instead');
    }

    // canonicalRelPath's own contract.
    const wikiDir = wikiDirFor('articles');
    assert(canonicalRelPath(wikiDir, path.join(wikiDir, 'entities', 'tali-rezun.md')) === 'entities/tali-rezun.md',
      'M5 #7: canonicalRelPath returns a wiki-relative, forward-slashed path');
    assert(canonicalRelPath(wikiDir, path.join(work, 'outside', 'secret.md')) === null,
      'M5 #8: canonicalRelPath refuses a path outside the wiki');
    assert(canonicalRelPath(wikiDir, path.join(wikiDir, 'entities', 'no-such-file.md')) === null,
      'M5 #9: canonicalRelPath returns null (not a throw) for a non-existent file');
  }

  // ── 12. L2 — non-canonical backlink sources are labelled, not blank ─────
  section('12. L2 — a non-canonical source is a labelled backlink row');
  {
    // A stray note at the wiki root — e.g. what Obsidian creates when the
    // vault root IS the wiki dir, which is the documented setup.
    writeFileSync(path.join(wikiDirFor('articles'), 'stray-note.md'),
      '# My Scratch Note\n\nThinking about [[truly-alone]].\n', 'utf8');
    __clearWikiReadCache('articles');
    const bl = await getBacklinks('articles', 'entities', 'truly-alone');
    const stray = bl.find(b => b.path === 'stray-note.md');
    assert(!!stray, 'L2 #1: a non-canonical file is still counted as a link SOURCE (health.js scans it too)');
    assert(stray && typeof stray.title === 'string' && stray.title === 'My Scratch Note',
      `L2 #2: it carries a real title instead of null (the UI renders title || slug — two nulls made a blank row)`);
    assert(stray && stray.slug === 'stray-note', 'L2 #3: it carries a slug instead of null');
    assert(stray && stray.readable === false,
      'L2 #4: it is flagged unreadable, so a caller knows the row cannot be opened (getWikiPage 400s on it)');
    const normal = bl.length > 1 ? bl.find(b => b.path !== 'stray-note.md') : null;
    if (normal) assert(normal.readable === true, 'L2 #5: an ordinary canonical source is still flagged readable');
    else ok('L2 #5 n/a: no other source links to this page');
  }

} catch (err) {
  bad('unexpected throw during test run', err.stack || err.message || err);
} finally {
  __setDomainsDirOverride(null);
  __clearWikiReadCache();
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  for (const { label, err } of failures) console.log(`  ✗ ${label}${err ? ` — ${err}` : ''}`);
  process.exit(1);
}
console.log('\nAll wiki-page tests green.');
process.exit(0);
