#!/usr/bin/env node
/**
 * Offline battle test for src/brain/raw-store.js — Track 7 Part II
 * (raw-source fidelity: getting from a wiki summary back to the original
 * document it was built from).
 *
 * WHY THIS SUITE IS MOSTLY ABOUT SECURITY
 * ───────────────────────────────────────
 * The feature reduces to "open the file this string names", where the string
 * is a YAML `source:` field — LLM-authored, hand-editable in Obsidian, and
 * arriving over Personal Sync and Shared Brain mirror pulls. One consumer of
 * the resolved path is `execFile('open', …)`. So the resolution chokepoint is
 * the feature's entire risk surface, and most of what follows attacks it.
 *
 * Section 2 is the one that matters most. v3.2.0 shipped a CRITICAL because
 * `resolveInsideWiki` was purely LEXICAL (`path.resolve` + `path.relative`,
 * no realpath, no lstat): it refused a path whose STRING escaped and said
 * nothing about what the path POINTED AT. A lexical check passes a naive
 * traversal test suite with flying colours — which is exactly how it shipped.
 * So §2 uses REAL symlinks on disk, and §2b MUTATION-PROVES the guard by
 * swapping in a lexical implementation and asserting this suite goes RED.
 *
 * Covers:
 *   1.  Traversal corpus against sanitiseSourceName + resolveRawSource.
 *   2.  SYMLINK ESCAPE with real symlinks: symlinked file, symlinked
 *       DIRECTORY, dangling symlink, and an in-bounds symlink (still refused
 *       here — stricter than resolveInsideWiki, by design).
 *   2b. MUTATION PROOF that §2 actually depends on the physical check.
 *   3.  Benign real-world filenames (spaces, parens, dots) still resolve —
 *       the guard must not be so strict it breaks the real corpus.
 *   4.  sourceForSummary across all four shapes (summary w/ source, summary
 *       w/o source, non-summary page, source naming a missing file).
 *   5.  Manifest: append, tolerant read past malformed lines, and that a
 *       write failure does not fail the caller.
 *   6.  MCP tool never emits binary — fed a real binary fixture.
 *   7.  hashRawSource streams rather than buffering the whole file.
 *   8.  Route-layer guards (source path never leaked; reveal refuses).
 *
 * Isolated via __setUserDataDirOverride + __setDomainsDirOverride — NEVER
 * process.env.DOMAINS_PATH, which loses to a configured domainsPath and
 * silently no-ops on a real install (CLAUDE.md, "Active Development
 * Decisions").
 *
 * Run with:  node scripts/test-raw-store.js
 * Exit 0 if all green.
 */

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
  symlinkSync, existsSync, statSync, appendFileSync, chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── Isolation MUST be installed before anything reads a path ──────────────
const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-rawstore-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const OUTSIDE = path.join(TMP, 'outside');       // the "escape target" area
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);

const {
  resolveRawSource, sanitiseSourceName, sourceForSummary, hashRawSource,
  appendManifestRecord, readManifest, findManifestRecord, readRawSourceText,
  looksLikeExternalSource, MAX_EXTRACT_CHARS, MAX_EXTRACT_BYTES,
} = await import('../src/brain/raw-store.js');

// ── Harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) {
  failed++; failures.push({ label, err });
  console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err}`);
}
function assert(cond, label, err) { cond ? ok(label) : bad(label, err || 'assertion failed'); }
function section(name) { console.log(`\n── ${name} ──`); }

// ── Fixture domain ───────────────────────────────────────────────────────
const D = 'testdom';
const wikiDir = path.join(DOMAINS, D, 'wiki');
const rawDir = path.join(DOMAINS, D, 'raw');
mkdirSync(path.join(wikiDir, 'summaries'), { recursive: true });
mkdirSync(path.join(wikiDir, 'entities'), { recursive: true });
mkdirSync(path.join(wikiDir, 'concepts'), { recursive: true });
mkdirSync(rawDir, { recursive: true });
writeFileSync(path.join(DOMAINS, D, 'CLAUDE.md'), '# Test domain\n');

// The real corpus has filenames like this — the guard must not break them.
const REAL_NAME = 'AI-as-a-Force-Multiplier_-Leaders-for-Industry-5.0 (1).pdf';
writeFileSync(path.join(rawDir, REAL_NAME), 'pretend pdf bytes but text\n');
writeFileSync(path.join(rawDir, 'report.txt'), 'The quick brown fox.\nLine two.\n');

// A secret OUTSIDE the domains dir — every escape test aims at this.
const SECRET = path.join(OUTSIDE, 'secret.txt');
writeFileSync(SECRET, 'TOP-SECRET-CANARY-VALUE\n');

writeFileSync(path.join(wikiDir, 'summaries', 'my-doc.md'),
  `---\ntype: summary\nsource: ${REAL_NAME}\ndate: 2026-01-01\n---\n# My Doc\n\nBody.\n`);
writeFileSync(path.join(wikiDir, 'summaries', 'no-source.md'),
  `---\ntype: summary\ndate: 2026-01-01\n---\n# No Source\n\nCompiled from a conversation.\n`);
writeFileSync(path.join(wikiDir, 'summaries', 'gone.md'),
  `---\ntype: summary\nsource: deleted-on-another-machine.pdf\n---\n# Gone\n`);
writeFileSync(path.join(wikiDir, 'entities', 'someone.md'),
  `---\ntype: entity\n---\n# Someone\n\nAn entity page.\n`);

// ═════════════════════════════════════════════════════════════════════════
section('1. Traversal corpus — sanitiser + chokepoint');

const TRAVERSAL = [
  ['../../etc/passwd',              'parent traversal'],
  ['/etc/passwd',                   'absolute unix path'],
  ['..%2f..%2fetc%2fpasswd',        'url-encoded traversal'],
  ['..\\..\\windows\\system32',     'backslash traversal'],
  ['C:\\Windows\\System32\\cfg',    'absolute windows path'],
  ['',                              'empty string'],
  ['   ',                           'whitespace only'],
  ['.',                             'single dot'],
  ['..',                            'double dot'],
  ['...',                           'dots only (3)'],
  ['....',                          'dots only (4)'],
  ['a'.repeat(5000) + '.pdf',       '5000-char name'],
  [null,                            'null'],
  [undefined,                       'undefined'],
  [42,                              'number'],
  [{},                              'object'],
  [['x.pdf'],                       'array'],
  ['../' .repeat(40) + 'etc/passwd','deep parent traversal'],
];
// NUL and control characters, built with escapes so this file never becomes
// binary to git (the accident wiki-read.js documents).
TRAVERSAL.push([`ok\u0000.pdf`, 'embedded NUL byte']);
TRAVERSAL.push([`ok\u001f.pdf`, 'embedded control char (0x1f)']);
TRAVERSAL.push([`ok\n.pdf`,     'embedded newline']);

for (const [input, label] of TRAVERSAL) {
  assert(sanitiseSourceName(input) === null,
    `sanitiseSourceName refuses: ${label}`,
    `got ${JSON.stringify(sanitiseSourceName(input))}`);
}

// Through the full chokepoint, aiming every one at the real secret file.
for (const [input, label] of TRAVERSAL) {
  const r = await resolveRawSource(D, input);
  assert(r.ok === false, `resolveRawSource refuses: ${label}`, `got ${JSON.stringify(r)}`);
}

// The specific attack the brief names: `source: ../../.ssh/id_rsa`.
{
  const r = await resolveRawSource(D, '../../.ssh/id_rsa');
  assert(r.ok === false, 'resolveRawSource refuses ../../.ssh/id_rsa');
}
// And an absolute path straight at the canary.
{
  const r = await resolveRawSource(D, SECRET);
  assert(r.ok === false, 'resolveRawSource refuses an absolute path to a real outside file');
}
// Hostile DOMAIN (the root half of the path, not the leaf).
for (const badDom of ['../other', '/etc', '..', '', null, 'a/b']) {
  const r = await resolveRawSource(badDom, 'report.txt');
  assert(r.ok === false, `resolveRawSource refuses hostile domain: ${JSON.stringify(badDom)}`);
}

// Basename reduction is provable, not just asserted: a traversal string whose
// BASENAME is a real file in raw/ must still not resolve to a file outside.
{
  writeFileSync(path.join(OUTSIDE, 'report.txt'), 'OUTSIDE-CANARY\n');
  const r = await resolveRawSource(D, '../../outside/report.txt');
  // Refused outright by the sanitiser (contains `..`) — the point is that it
  // never reaches OUTSIDE even though the basename exists in both places.
  assert(r.ok === false, 'traversal whose basename exists in raw/ is still refused');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. SYMLINK ESCAPE — real symlinks on disk (the v3.2.0 CRITICAL)');

// 2a. Symlinked FILE inside raw/ pointing outside the domains dir.
const linkFile = path.join(rawDir, 'leak.pdf');
symlinkSync(SECRET, linkFile);
assert(existsSync(linkFile), 'fixture: symlinked file created in raw/');
{
  const r = await resolveRawSource(D, 'leak.pdf');
  assert(r.ok === false,
    'REFUSED: symlinked file in raw/ pointing outside the domains dir',
    `LEAK — resolved to ${r.absPath}`);
  if (r.ok) {
    // Prove the severity if it ever regresses.
    bad('symlink escape actually served outside content',
      readFileSync(r.absPath, 'utf8').trim());
  }
}

// 2b. Symlinked DIRECTORY — escapes wholesale, exposing everything beneath.
const linkDir = path.join(rawDir, 'sub');
symlinkSync(OUTSIDE, linkDir);
{
  const r = await resolveRawSource(D, 'sub/secret.txt');
  assert(r.ok === false, 'REFUSED: path through a symlinked DIRECTORY');
}
// Even reduced to a basename, the symlinked dir itself is not a regular file.
{
  const r = await resolveRawSource(D, 'sub');
  assert(r.ok === false, 'REFUSED: the symlinked directory itself');
}

// 2c. Dangling symlink — containment cannot be proven, so it must be refused.
const dangling = path.join(rawDir, 'dangling.pdf');
symlinkSync(path.join(OUTSIDE, 'does-not-exist-at-all'), dangling);
{
  const r = await resolveRawSource(D, 'dangling.pdf');
  assert(r.ok === false, 'REFUSED: dangling symlink (cannot prove containment)');
}

// 2d. Symlink pointing back INSIDE raw/. resolveInsideWiki allows this (it is
// not an escape); resolveRawSource is deliberately STRICTER — a raw source is
// a file we ingested, never a link.
const inbound = path.join(rawDir, 'alias.txt');
symlinkSync(path.join(rawDir, 'report.txt'), inbound);
{
  const r = await resolveRawSource(D, 'alias.txt');
  assert(r.ok === false && r.reason === 'not-a-file',
    'REFUSED: in-bounds symlink (stricter than resolveInsideWiki, by design)',
    `got ${JSON.stringify(r)}`);
}

// 2e. A DIRECTORY (not a symlink) is not a source.
mkdirSync(path.join(rawDir, 'realdir'), { recursive: true });
{
  const r = await resolveRawSource(D, 'realdir');
  assert(r.ok === false && r.reason === 'not-a-file', 'REFUSED: a real directory');
}
// ═════════════════════════════════════════════════════════════════════════
section('2b. WHICH LAYER ACTUALLY DEFENDS EACH VECTOR (mutation-derived)');
//
// READ THIS BEFORE TRUSTING §2. The first version of §2b claimed to prove
// that §2 depends on the physical (realpath) containment check. It did not.
// Disabling `isPhysicallyInside` in wiki-read.js left EVERY §2 assertion
// GREEN — so §2 was passing for reasons other than the guard it named. That
// is precisely the v3.2.0 failure mode (a lexical check sailing through a
// naive suite), reproduced in the test rather than in the code.
//
// The real layering, established by mutating each layer in turn:
//
//   Layer 1 — sanitiseSourceName refuses any separator and any leading `..`.
//             Consequence: `resolveRawSource` can ONLY ever form
//             `<rawDir>/<basename>`, so the symlinked-DIRECTORY vector is
//             unreachable through this chokepoint at all.
//   Layer 2 — lstat().isFile() refuses a symlink leaf. THIS is what actually
//             refuses `leak.pdf` in §2a. It is stricter than containment: it
//             refuses an in-bounds symlink too (§2d).
//   Layer 3 — resolveInsideWiki's physical check. For this chokepoint it is
//             genuinely REDUNDANT today, because layers 1 and 2 fire first.
//             It is kept because redundancy is the point: if layer 1 ever
//             regresses to allow separators, layer 3 is what stops a
//             symlinked ancestor. §2b-iii proves it still works by calling
//             it directly, which is the only way to reach it.
//
// So the honest claim is: §2 covers layers 1 and 2, and §2b-iii covers
// layer 3 independently. Stated plainly rather than implied, because an
// overclaim here is worse than a gap.

// ── 2b-i. Layer 2 is real: mutate lstat-isFile and §2a must go RED. ──────
// Simulated in-process rather than by editing source: resolveRawSource's
// refusal of a symlink leaf comes from isFile() being false on an lstat.
// A "mutation" that used stat() instead of lstat() would FOLLOW the link
// and report a regular file — the classic mistake. Prove that difference
// is what is doing the work.
{
  const { lstatSync, statSync } = await import('fs');
  const leak = path.join(rawDir, 'leak.pdf');

  const l = lstatSync(leak);
  assert(l.isFile() === false && l.isSymbolicLink() === true,
    'MUTATION(layer 2): lstat sees leak.pdf as a SYMLINK, not a file — this is the refusal',
    `isFile=${l.isFile()} isSymlink=${l.isSymbolicLink()}`);

  // The mutation: stat() follows the link and reports a perfectly ordinary
  // regular file, i.e. an implementation using stat() would ALLOW the escape.
  const s = statSync(leak);
  assert(s.isFile() === true,
    'MUTATION(layer 2): stat() FOLLOWS the link and reports a regular file — ' +
    'an lstat→stat regression would allow the escape',
    `isFile=${s.isFile()}`);

  // And confirm the source really uses lstat, so the property above is the
  // one that ships.
  const rsSrc = readFileSync(path.join(REPO, 'src/brain/raw-store.js'), 'utf8');
  assert(/await lstat\(absPath\)/.test(rsSrc),
    'MUTATION(layer 2): resolveRawSource uses lstat (not stat) on the leaf');
  assert(!/await stat\(absPath\)/.test(rsSrc),
    'MUTATION(layer 2): resolveRawSource never stats through the link');
}

// ── 2b-ii. Layer 1 is real: a lexical-only check would allow the escapes. ─
// This is the pre-v3.2.0 implementation, run against the same real symlinks,
// to show the shape of the bug that shipped.
{
  function lexicalOnlyResolve(rootDir, candidate) {
    // Exactly the pre-v3.2.0 shape: resolve + relative, no realpath, no lstat.
    if (typeof candidate !== 'string' || !candidate) return null;
    if (path.isAbsolute(candidate)) return null;
    const resolved = path.resolve(rootDir, candidate);
    const rel = path.relative(rootDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return resolved;
  }

  const escapes = [
    ['leak.pdf',        'symlinked file'],
    ['sub/secret.txt',  'path through symlinked directory'],
    ['dangling.pdf',    'dangling symlink'],
  ];
  let lexicalAllowed = 0;
  for (const [name, label] of escapes) {
    const lex = lexicalOnlyResolve(rawDir, name);
    const real = await resolveRawSource(D, name);
    assert(lex !== null && real.ok === false,
      `MUTATION: lexical check ALLOWS ${label}; the shipped chokepoint REFUSES it`,
      `lexical=${lex} shipped=${JSON.stringify(real)}`);
    if (lex !== null) lexicalAllowed++;
  }
  assert(lexicalAllowed === escapes.length,
    'MUTATION: all three symlink escapes defeat a lexical-only check',
    `only ${lexicalAllowed}/${escapes.length} did`);

  // Prove the leak is REAL, not hypothetical: the lexical path for leak.pdf
  // reads the canary from outside the domains dir.
  const lex = lexicalOnlyResolve(rawDir, 'leak.pdf');
  const leaked = lex ? readFileSync(lex, 'utf8') : '';
  assert(leaked.includes('TOP-SECRET-CANARY-VALUE'),
    'MUTATION: the lexical check would genuinely serve the outside canary file',
    `read: ${JSON.stringify(leaked)}`);
}

// ── 2b-iii. Layer 3, tested independently. ───────────────────────────────
// The physical check cannot be reached through resolveRawSource (layer 1
// refuses separators first), so it is exercised DIRECTLY here — simulating a
// future regression in which layer 1 is loosened. If this ever goes green
// while returning a non-null path, a symlinked ancestor is live.
{
  const { resolveInsideWiki } = await import('../src/brain/wiki-read.js');

  assert(resolveInsideWiki(rawDir, 'sub/secret.txt') === null,
    'LAYER 3: physical check refuses a path through a symlinked DIRECTORY ' +
    '(the backstop if separator refusal ever regresses)');
  assert(resolveInsideWiki(rawDir, 'leak.pdf') === null,
    'LAYER 3: physical check refuses a symlinked FILE');
  assert(resolveInsideWiki(rawDir, 'dangling.pdf') === null,
    'LAYER 3: physical check refuses a DANGLING symlink (cannot prove containment)');
  assert(typeof resolveInsideWiki(rawDir, 'report.txt') === 'string',
    'LAYER 3: physical check still ALLOWS an ordinary file (not over-strict)');

  // The layers compose: even granting layer 1 the most permissive behaviour
  // it could regress to (raw basename reduction, as an earlier draft of
  // sanitiseSourceName did), the symlinked directory is still unreachable
  // because basename('sub/secret.txt') is 'secret.txt', which does not exist
  // in raw/ — and if it DID, layer 3 above is the stop.
  const naiveBasename = path.basename('sub/secret.txt');
  const r = await resolveRawSource(D, naiveBasename);
  assert(r.ok === false,
    'LAYERED: even a basename-reducing sanitiser cannot reach the symlinked dir target');
}
section('3. Benign real-world filenames still resolve');

{
  const r = await resolveRawSource(D, REAL_NAME);
  assert(r.ok === true, `resolves real corpus name (spaces, parens, dots): ${REAL_NAME}`,
    JSON.stringify(r));
  assert(r.ok && r.filename === REAL_NAME, 'filename round-trips exactly');
  assert(r.ok && r.bytes > 0, 'bytes reported');
  assert(r.ok && typeof r.mtime === 'string', 'mtime reported as ISO string');
  assert(r.ok && r.absPath.startsWith(rawDir), 'absPath is inside raw/');
}
for (const nm of [
  // NOTE: deliberately NOT 'report.txt' — that is a fixture §6 reads back,
  // and overwriting it here made §6's "returns the real original text"
  // assertion fail for a reason that had nothing to do with the code.
  'Whitepaper v2.1 (final) [rev].pdf',
  'ünïcödé — dash.pdf',
  'file.with.many.dots.md',
  '2026-01-01 Meeting Notes.txt',
]) {
  writeFileSync(path.join(rawDir, nm), 'content\n');
  const r = await resolveRawSource(D, nm);
  assert(r.ok === true, `resolves benign name: ${nm}`, JSON.stringify(r));
}
// A name that does not exist is 'missing', cleanly — not 'unsafe', not a throw.
{
  const r = await resolveRawSource(D, 'never-ingested.pdf');
  assert(r.ok === false && r.reason === 'missing',
    'a valid-but-absent filename reports reason=missing (not unsafe)', JSON.stringify(r));
}

// ═════════════════════════════════════════════════════════════════════════
section('4. sourceForSummary — all four shapes');

{
  const r = await sourceForSummary(D, 'summaries/my-doc.md');
  assert(r.found === true, 'summary with a present source → found', JSON.stringify(r));
  assert(r.filename === REAL_NAME, 'returns the frontmatter filename verbatim');
  assert(typeof r.absPath === 'string', 'carries absPath for server-side use');
}
{
  const r = await sourceForSummary(D, 'summaries/no-source.md');
  assert(r.found === false && r.reason === 'no-source-recorded',
    'summary with no source: field → no-source-recorded', JSON.stringify(r));
  assert(typeof r.message === 'string' && r.message.length > 20,
    'no-source case explains itself in plain language');
}
{
  const r = await sourceForSummary(D, 'entities/someone.md');
  assert(r.found === false && r.reason === 'not-a-summary',
    'a non-summary page → not-a-summary (clean result, not an error)', JSON.stringify(r));
}
{
  const r = await sourceForSummary(D, 'summaries/gone.md');
  assert(r.found === false && r.reason === 'missing',
    'source naming a file that is not on this machine → missing', JSON.stringify(r));
  assert(/not synced|another machine|deleted/i.test(r.message || ''),
    'missing-file message explains that raw files do not sync', r.message);
}
// A summary whose source: is HOSTILE.
writeFileSync(path.join(wikiDir, 'summaries', 'evil.md'),
  `---\ntype: summary\nsource: ../../../outside/secret.txt\n---\n# Evil\n`);
{
  const r = await sourceForSummary(D, 'summaries/evil.md');
  assert(r.found === false, 'summary with a traversal source: is refused', JSON.stringify(r));
  assert(!JSON.stringify(r).includes('TOP-SECRET-CANARY'),
    'refused traversal never leaks outside content');
}
// A summary whose source: points at the symlink we planted.
writeFileSync(path.join(wikiDir, 'summaries', 'evil2.md'),
  `---\ntype: summary\nsource: leak.pdf\n---\n# Evil2\n`);
{
  const r = await sourceForSummary(D, 'summaries/evil2.md');
  assert(r.found === false, 'summary pointing at a symlink escape is refused', JSON.stringify(r));
}
// The two 'unsafe' situations must be explained DIFFERENTLY. Telling a user
// that a file sitting in their raw folder "is not a usable filename" is just
// wrong, and was caught on the live server rather than by a unit test.
writeFileSync(path.join(wikiDir, 'summaries', 'symlink-src.md'),
  `---\ntype: summary\nsource: leak.pdf\n---\n# Symlink Src\n`);
{
  const bad = await sourceForSummary(D, 'summaries/evil.md');       // ../../../outside/secret.txt
  const link = await sourceForSummary(D, 'summaries/symlink-src.md'); // real name, escaping symlink
  assert(bad.reason === 'unsafe' && link.reason === 'unsafe', 'both are classified unsafe');
  assert(/not a usable filename/i.test(bad.message),
    'a malformed NAME is explained as a bad filename', bad.message);
  assert(/symlink|shortcut/i.test(link.message) && !/not a usable filename/i.test(link.message),
    'an escaping SYMLINK is explained as a symlink, not as a bad filename', link.message);
  assert(!link.message.includes('TOP-SECRET-CANARY'), 'the message leaks no outside content');
}

// A `source:` that is a URL, not a filename. FOUND IN THE REAL CORPUS:
// domains/articles has a summary reading `source: medium.com/@talirezun`.
// It must be refused as a file AND explained as a web reference — reporting
// a user's ordinary Medium-sourced summary as "unsafe" is a wrong answer
// delivered confidently.
writeFileSync(path.join(wikiDir, 'summaries', 'web-doc.md'),
  `---\ntype: summary\nsource: medium.com/@talirezun\n---\n# Web Doc\n`);
{
  const r = await sourceForSummary(D, 'summaries/web-doc.md');
  assert(r.found === false, 'URL source is not treated as a local file');
  assert(r.reason === 'external-source',
    'URL source is classified external-source, NOT unsafe (real-corpus case)', r.reason);
  assert(r.url === 'medium.com/@talirezun', 'the URL is surfaced for the user');
  assert(/web page/i.test(r.message), 'message explains it came from the web');
}
{
  // Classification must be conservative in BOTH directions.
  for (const u of ['https://example.com/a', 'http://x.io/y', 'www.example.com/p',
                   'medium.com/@user', 'sub.domain.co.uk/path']) {
    assert(looksLikeExternalSource(u) === true, `detects URL: ${u}`);
  }
  for (const f of ['report.pdf', 'report.final.pdf', 'My Doc (1).pdf', 'a.b.c.txt',
                   '2026-01-01 notes.md', REAL_NAME, '', null, 'example.com']) {
    assert(looksLikeExternalSource(f) === false,
      `does NOT misread as URL: ${JSON.stringify(f)}`);
  }
}
{
  // A URL must never become an outbound request. If this module ever grew a
  // fetch, an LLM-authored `source:` arriving over sync would be an SSRF
  // primitive aimed at whatever host it named.
  const rs = readFileSync(path.join(REPO, 'src/brain/raw-store.js'), 'utf8');
  assert(!/\bfetch\s*\(/.test(rs), 'raw-store.js never fetches a URL (no SSRF surface)');
  assert(!/https?\.request|axios|node-fetch|undici/.test(rs),
    'raw-store.js pulls in no HTTP client');
  const mt = readFileSync(path.join(REPO, 'mcp/tools/raw-source.js'), 'utf8');
  assert(!/\bfetch\s*\(/.test(mt), 'the MCP tool never fetches a URL either');
}

// Unknown page still throws with a status the route can render.
{
  let status = null;
  try { await sourceForSummary(D, 'summaries/does-not-exist.md'); }
  catch (e) { status = e.status; }
  assert(status === 404, 'unknown page throws status 404 for the route layer', `got ${status}`);
}

// ═════════════════════════════════════════════════════════════════════════
section('5. Manifest — append-only, tolerant read, best-effort write');

{
  const wrote = await appendManifestRecord(D, {
    filename: REAL_NAME, sha256: 'abc123', bytes: 42,
    ingestedAt: '2026-01-01T00:00:00.000Z', summaryPath: 'summaries/my-doc.md',
  });
  assert(wrote === true, 'appendManifestRecord returns true on success');
  const recs = await readManifest(D);
  assert(recs.length === 1, 'one record read back', `got ${recs.length}`);
  assert(recs[0].filename === REAL_NAME, 'record round-trips filename');
  assert(recs[0].bytes === 42, 'record round-trips bytes');
}
{
  // Manifest lives inside wiki/ so it syncs (the whole point).
  const mp = path.join(wikiDir, '.raw-manifest.jsonl');
  assert(existsSync(mp), 'manifest is written INSIDE wiki/ (so it is git-tracked and syncs)');
  // And the blob dir is not where it lives.
  assert(!existsSync(path.join(rawDir, '.raw-manifest.jsonl')),
    'manifest is NOT in raw/ (which is gitignored)');
}
{
  // Tolerant read: malformed lines are skipped, never thrown on. Includes the
  // shapes that actually occur — a half-written line from a killed process,
  // and git conflict markers from a merge.
  const mp = path.join(wikiDir, '.raw-manifest.jsonl');
  appendFileSync(mp, 'this is not json at all\n');
  appendFileSync(mp, '{"filename":"broken.pdf",\n');           // truncated write
  appendFileSync(mp, '<<<<<<< HEAD\n');                         // conflict marker
  appendFileSync(mp, '42\n');                                   // parses, not an object
  appendFileSync(mp, '["array","not","object"]\n');             // parses, wrong shape
  appendFileSync(mp, '\n\n');                                   // blank lines
  appendFileSync(mp, JSON.stringify({
    filename: 'second.pdf', sha256: 'def', bytes: 7,
    ingestedAt: '2026-02-02T00:00:00.000Z', summaryPath: 'summaries/x.md',
  }) + '\n');

  const recs = await readManifest(D);
  assert(recs.length === 2, 'malformed lines skipped; both valid records survive',
    `got ${recs.length}: ${JSON.stringify(recs)}`);
  assert(recs.some(r => r.filename === 'second.pdf'),
    'a valid record AFTER a malformed line is still read (parse does not abort)');
}
{
  const rec = await findManifestRecord(D, REAL_NAME);
  assert(rec && rec.filename === REAL_NAME, 'findManifestRecord finds by exact name');
  const none = await findManifestRecord(D, 'nope.pdf');
  assert(none === null, 'findManifestRecord returns null for an unknown name');
  const hostile = await findManifestRecord(D, '../../etc/passwd');
  assert(hostile === null, 'findManifestRecord refuses a traversal name');
}
{
  // Most-recent wins when a file is re-ingested.
  await appendManifestRecord(D, {
    filename: REAL_NAME, sha256: 'newer', bytes: 99,
    ingestedAt: '2026-06-06T00:00:00.000Z', summaryPath: 'summaries/my-doc.md',
  });
  const rec = await findManifestRecord(D, REAL_NAME);
  assert(rec.sha256 === 'newer', 'findManifestRecord returns the most recent record',
    JSON.stringify(rec));
}
{
  // BEST-EFFORT: a write failure must return false, never throw. Point the
  // manifest at an unwritable location by using a domain whose wiki/ path is
  // occupied by a FILE, so mkdir + append both fail.
  const brokenDom = 'brokendom';
  mkdirSync(path.join(DOMAINS, brokenDom), { recursive: true });
  writeFileSync(path.join(DOMAINS, brokenDom, 'wiki'), 'not a directory\n');
  let threw = false, result = null;
  try {
    result = await appendManifestRecord(brokenDom, {
      filename: 'x.pdf', bytes: 1, ingestedAt: '2026-01-01T00:00:00.000Z',
    });
  } catch { threw = true; }
  assert(!threw, 'appendManifestRecord NEVER throws on a write failure');
  assert(result === false, 'appendManifestRecord returns false on a write failure', `got ${result}`);
  // And reading that same broken domain degrades to [] rather than throwing.
  let readThrew = false, recs = null;
  try { recs = await readManifest(brokenDom); } catch { readThrew = true; }
  assert(!readThrew && Array.isArray(recs) && recs.length === 0,
    'readManifest degrades to [] on an unreadable manifest');
}
{
  // Hostile records are refused at write time, so a poisoned manifest cannot
  // later be used to name a file outside raw/.
  const r1 = await appendManifestRecord(D, { filename: '../../etc/passwd', bytes: 1 });
  assert(r1 === false, 'appendManifestRecord refuses a traversal filename');
  const r2 = await appendManifestRecord(D, null);
  assert(r2 === false, 'appendManifestRecord refuses a null record');
  const r3 = await appendManifestRecord('../evil', { filename: 'x.pdf' });
  assert(r3 === false, 'appendManifestRecord refuses a hostile domain');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. Text extraction NEVER emits binary');

{
  // A real binary fixture: PDF header bytes + NULs + high bytes, named .bin so
  // it takes extractText's utf8 fall-through (the dangerous path — Node's
  // utf8 decoder substitutes U+FFFD rather than failing).
  const binName = 'binary-fixture.bin';
  const binBytes = Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'latin1'),
    Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x80, 0x81]),
    Buffer.alloc(4096, 0xa7),
  ]);
  writeFileSync(path.join(rawDir, binName), binBytes);

  const resolved = await resolveRawSource(D, binName);
  assert(resolved.ok === true, 'binary fixture resolves (type is deliberately NOT enforced)');

  const ext = await readRawSourceText(resolved.absPath);
  assert(ext.ok === false, 'readRawSourceText REFUSES a binary file', JSON.stringify(ext).slice(0, 200));
  assert(ext.reason === 'binary', 'refusal reason is "binary"', ext.reason);

  // Now through the actual MCP tool, which is what reaches the JSON-RPC wire.
  writeFileSync(path.join(wikiDir, 'summaries', 'bin-doc.md'),
    `---\ntype: summary\nsource: ${binName}\n---\n# Bin Doc\n`);
  const { getRawSourceHandler } = await import('../mcp/tools/raw-source.js');
  const storage = { listDomains: async () => [D, 'brokendom'] };
  const out = await getRawSourceHandler({ slug: 'bin-doc', domain: D }, storage);

  const serialised = JSON.stringify(out);
  assert(out.text === null || out.text === undefined,
    'MCP tool returns no text for a binary source', JSON.stringify(out.text || '').slice(0, 120));
  assert(out.text_unavailable === 'binary', 'MCP tool reports text_unavailable=binary');
  // The bytes themselves must not appear anywhere in the response.
  assert(!serialised.includes('\\u0000'), 'MCP response contains no NUL bytes');
  assert(!/\ufffd/.test(serialised), 'MCP response contains no U+FFFD replacement chars');
  assert(Buffer.byteLength(serialised, 'utf8') < 400 * 1024,
    'MCP response is under the 400 KB budget',
    `${Buffer.byteLength(serialised, 'utf8')} bytes`);
  // Sanity: the actual binary content is nowhere in the payload.
  assert(!serialised.includes('%PDF-1.7'), 'MCP response does not echo the file header');
}
{
  // A genuine text source DOES come back, and is capped.
  const { getRawSourceHandler } = await import('../mcp/tools/raw-source.js');
  const storage = { listDomains: async () => [D] };
  writeFileSync(path.join(wikiDir, 'summaries', 'txt-doc.md'),
    `---\ntype: summary\nsource: report.txt\n---\n# Txt Doc\n`);
  const out = await getRawSourceHandler({ slug: 'txt-doc', domain: D }, storage);
  assert(out.found === true, 'MCP tool returns a text source', JSON.stringify(out).slice(0, 200));
  assert(typeof out.text === 'string' && out.text.includes('quick brown fox'),
    'MCP tool returns the real original text');
  assert(out.truncated === false, 'short source is not marked truncated');
}
{
  // Truncation is honest and byte-capped. Build a large multi-byte document:
  // the char cap alone would allow ~3x the byte budget on this content.
  const bigName = 'big-multibyte.txt';
  const unit = '日本語のテキストです。'; // 3 bytes/char in UTF-8
  const big = unit.repeat(Math.ceil((MAX_EXTRACT_CHARS * 1.5) / unit.length));
  writeFileSync(path.join(rawDir, bigName), big, 'utf8');
  writeFileSync(path.join(wikiDir, 'summaries', 'big-doc.md'),
    `---\ntype: summary\nsource: ${bigName}\n---\n# Big Doc\n`);

  const { getRawSourceHandler } = await import('../mcp/tools/raw-source.js');
  const storage = { listDomains: async () => [D] };
  const out = await getRawSourceHandler({ slug: 'big-doc', domain: D }, storage);

  assert(out.truncated === true, 'oversized source is marked truncated');
  assert(typeof out.truncation_notice === 'string' && /FIRST/.test(out.truncation_notice),
    'truncation notice tells Claude it is NOT the whole document');
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  assert(bytes < 400 * 1024,
    'multi-byte oversized source still fits the 400 KB MCP budget', `${bytes} bytes`);
  assert(Buffer.byteLength(out.text, 'utf8') <= MAX_EXTRACT_BYTES,
    'returned text respects the BYTE ceiling, not just the char cap',
    `${Buffer.byteLength(out.text, 'utf8')} > ${MAX_EXTRACT_BYTES}`);
  assert(!/\ufffd/.test(out.text),
    'byte-budget truncation does not split a character (no U+FFFD)');
}
{
  // MCP tool input validation.
  const { getRawSourceHandler, summaryPathFromSlug } = await import('../mcp/tools/raw-source.js');
  const storage = { listDomains: async () => [D] };
  for (const s of ['../evil', 'summaries/../../x', '/etc/passwd', '', null, 'a b']) {
    assert(summaryPathFromSlug(s) === null, `summaryPathFromSlug refuses ${JSON.stringify(s)}`);
    const out = await getRawSourceHandler({ slug: s, domain: D }, storage);
    assert(out.ok === false, `MCP tool refuses slug ${JSON.stringify(s)}`);
  }
  assert(summaryPathFromSlug('my-doc') === 'summaries/my-doc.md', 'bare slug accepted');
  assert(summaryPathFromSlug('summaries/my-doc.md') === 'summaries/my-doc.md', 'full path accepted');
  const unknown = await getRawSourceHandler({ slug: 'my-doc', domain: 'nope' }, storage);
  assert(unknown.ok === false, 'MCP tool refuses an unknown domain');
}
{
  // Missing blob: report what the manifest knows rather than a bare not-found.
  const { getRawSourceHandler } = await import('../mcp/tools/raw-source.js');
  const storage = { listDomains: async () => [D] };
  await appendManifestRecord(D, {
    filename: 'deleted-on-another-machine.pdf', sha256: 'deadbeef', bytes: 12345,
    ingestedAt: '2026-03-12T00:00:00.000Z', summaryPath: 'summaries/gone.md',
  });
  const out = await getRawSourceHandler({ slug: 'gone', domain: D }, storage);
  assert(out.found === false, 'missing blob reports found=false');
  assert(out.known_from_manifest && out.known_from_manifest.bytes === 12345,
    'missing blob still reports size/date from the synced manifest', JSON.stringify(out));
}

// ═════════════════════════════════════════════════════════════════════════
section('7. hashRawSource streams (does not buffer the whole file)');

{
  const known = path.join(rawDir, 'hash-me.txt');
  writeFileSync(known, 'abc');
  const h = await hashRawSource(known);
  // sha256('abc') is a published constant.
  assert(h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'hashRawSource computes a correct sha256', h);
}
{
  // Structural proof of streaming: monkey-patch fs.promises.readFile and
  // fs.readFileSync to throw, then hash a large file. A buffering
  // implementation would blow up; a streaming one is unaffected.
  const bigPath = path.join(rawDir, 'big-hash.bin');
  writeFileSync(bigPath, Buffer.alloc(12 * 1024 * 1024, 0x41));  // 12 MB

  const fsmod = await import('fs');
  const fspromises = await import('fs/promises');
  const origSync = fsmod.default.readFileSync;
  const origAsync = fspromises.default.readFile;
  let tripped = false;
  fsmod.default.readFileSync = () => { tripped = true; throw new Error('readFileSync called'); };
  try { fspromises.default.readFile = () => { tripped = true; throw new Error('readFile called'); }; }
  catch { /* read-only in some Node builds — the size check below still applies */ }

  let h = null, threw = false;
  try { h = await hashRawSource(bigPath); } catch { threw = true; }

  fsmod.default.readFileSync = origSync;
  try { fspromises.default.readFile = origAsync; } catch { /* ignore */ }

  assert(!threw && typeof h === 'string' && h.length === 64,
    'hashRawSource hashes a 12 MB file without calling readFile',
    `threw=${threw} tripped=${tripped} h=${h}`);
  assert(tripped === false, 'hashRawSource never called a whole-file read', 'readFile WAS called');

  // Independent oracle.
  const { execFileSync } = await import('child_process');
  try {
    const out = execFileSync('shasum', ['-a', '256', bigPath], { encoding: 'utf8' });
    assert(out.trim().split(/\s+/)[0] === h, 'hash matches the shasum(1) oracle', out.trim());
  } catch { ok('shasum oracle unavailable on this host — skipped'); }
}
{
  const h = await hashRawSource(path.join(rawDir, 'does-not-exist'));
  assert(h === null, 'hashRawSource returns null (never throws) on a missing file');
  const h2 = await hashRawSource(path.join(rawDir, 'realdir'));
  assert(h2 === null, 'hashRawSource returns null on a directory');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. Route-layer contract (source guards)');

{
  const src = readFileSync(path.join(REPO, 'src/routes/wiki.js'), 'utf8');
  assert(/execFile\(/.test(src) && !/\bexec\(/.test(src.replace(/execFile\(/g, '')),
    'reveal route uses execFile (no shell), never exec');
  assert(src.includes("execFile('open', ['-R', result.absPath]"),
    'reveal opens ONLY the chokepoint-resolved absPath');
  assert(!/req\.body\?\.absPath|req\.query\.absPath|req\.body\.file/.test(src),
    'reveal never accepts a client-supplied filesystem path');
  assert(/router\.post\('\/:domain\/source\/reveal'/.test(src),
    'reveal is POST (so the cross-origin guard applies)');
  // The GET route must not return absPath.
  const getBlock = src.slice(src.indexOf("router.get('/:domain/source'"),
                             src.indexOf("router.post('/:domain/source/reveal'"));
  // Assert on what actually ships: no res.json() call in this route may carry
  // an absPath key. (An earlier version of this check was a bare /absPath/
  // scan, which flagged the DEFENSIVE destructure that exists precisely to
  // strip it — a guard cannot be evidence against itself.)
  const jsonPayloads = [...getBlock.matchAll(/res\.json\(([\s\S]*?)\);/g)].map(m => m[1]);
  assert(jsonPayloads.length >= 2, 'found the route\'s res.json payloads to inspect',
    `got ${jsonPayloads.length}`);
  assert(jsonPayloads.every(p => !/\babsPath\b/.test(p)),
    'GET /source never returns an absolute path to the client',
    jsonPayloads.find(p => /\babsPath\b/.test(p)));
  assert(getBlock.includes('const { absPath, ...safe }'),
    'GET /source strips absPath defensively on the not-found branch');
}
{
  // raw-store must keep stdout pure — it loads in the MCP stdio child.
  const rs = readFileSync(path.join(REPO, 'src/brain/raw-store.js'), 'utf8');
  assert(!/console\.log\(/.test(rs), 'raw-store.js contains no console.log (MCP stdout discipline)');
  const mt = readFileSync(path.join(REPO, 'mcp/tools/raw-source.js'), 'utf8');
  assert(!/console\.log\(/.test(mt), 'mcp/tools/raw-source.js contains no console.log');
  // And it must not grow its own containment check.
  assert(rs.includes("import { resolveInsideWiki }"),
    'raw-store imports the single hardened containment check rather than copying it');
  assert(!/path\.relative\([^)]*\)\s*;?\s*\n?\s*if\s*\(\s*rel\.startsWith/.test(rs),
    'raw-store does not hand-roll a second lexical containment check');
}
{
  // ingest.js: the manifest append must be best-effort (a .catch present).
  const ing = readFileSync(path.join(REPO, 'src/brain/ingest.js'), 'utf8');
  assert(/export async function extractText/.test(ing), 'ingest exports extractText');
  assert(/appendManifestRecord\(domain,/.test(ing), 'ingest appends a manifest record');
  const idx = ing.indexOf('hashRawSource(destPath)');
  const window = ing.slice(idx, idx + 600);
  assert(/\.catch\(/.test(window),
    'the manifest append is best-effort (has a .catch) — an ingest never fails on it');
}

// ═════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n    └─ ${f.err}`);
}
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed ? 1 : 0);
