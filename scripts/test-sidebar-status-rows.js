/**
 * test-sidebar-status-rows.js — OFFLINE guards for the ONE status-row anatomy
 * the two domain-listing sidebars now share:
 *
 *     name · key figure · freshness mark + relative age · last event
 *
 * Ingest's DESTINATION rows and Domains' KNOWLEDGE rows. Before this release
 * they read "3445 pages · last write 2026-09-16" and "Articles · 3,421 pages"
 * — one made the reader subtract a date from today, the other said nothing at
 * all about when the number last moved. The Curator is meant to be MISSION
 * CONTROL, including for the people with no menubar widget.
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────
 * Four things can regress silently here, and each has a section:
 *
 *   §1  THE PARSER. `readLogLatest` reads the newest `## [date] kind | title`
 *       heading out of wiki/log.md. Its selection rule is the one
 *       v3.0.1-beta.10 exists to protect (scan every heading, take the max —
 *       never "read the tail"), and its output now reaches a screen, so a
 *       title carrying `|` or `<b>` is untrusted input on a wire.
 *
 *   §2  THE CACHE. The date and the entry come from ONE mtime+size-keyed
 *       read. Two getters over two caches would be two reads per poll of a
 *       POLLED endpoint, and — worse — two reads of one file can DISAGREE.
 *       Measured under a patched `fs`, in a child process, because an ESM
 *       named import is bound at link time and an in-process patch counts
 *       nothing (the same trap scripts/test-domain-stats.js records).
 *
 *   §3  THE LADDERS. `formatDayAge` (words) and `dayFreshnessStep` (the dot)
 *       must be cut on the SAME bands, or a dot says "today" beside words
 *       that say "1 week ago" — the v3.34.0 class. And `formatAge` in
 *       shared/age.js must not drift from the copy in views/memory.js.
 *
 *   §4/§5  THE ROWS THEMSELVES, rendered. The real renderers are executed
 *       against stubs and the emitted HTML is read: the dot class must match
 *       what `dayFreshnessTier` independently says, the age must be the
 *       words `formatDayAge` independently says, a title carrying markup
 *       must arrive escaped, and no row may carry a hover-only `title=`.
 *
 *   §6  THE TWO CSS LADDERS ARE GONE, and this section now guards their
 *       ABSENCE. `.ing-fresh-*` and `.dm-fresh-*` were byte-identical modulo
 *       their prefix, and this section used to assert that identity — a guard
 *       against a duplication rather than a reason for one, and recorded as
 *       KNOWN AND UNFIXED in v3.54.0. Both are deleted; the rules live in
 *       shared/freshness.css, which owns the `fresh-` prefix outright, and
 *       the ASSERTION IS INVERTED to guard the fix rather than deleted. The
 *       scale itself — tiers, tokens and measured contrast — is
 *       scripts/test-freshness-scale.js's subject, not this suite's.
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────
 *  - Nothing here renders in a browser. Dot colours, contrast and the
 *    two-line meta's clipping were measured in a real browser in both themes
 *    and are not re-derived offline; a hand-rolled cascade resolver is the
 *    decorative-guard shape this repo keeps hitting.
 *  - §6 scans RULE TEXT for the retired prefixes. It proves the two copies
 *    are gone and that the shared sheet carries the shape; it does NOT prove
 *    the shared rules are reached at runtime, or that the cascade resolves
 *    the way the arithmetic assumes.
 *  - The parser's grammar covers the two headings ingest.js and compile.js
 *    write. A Shared Brain pull's log line has no `##` and is deliberately
 *    not matched — it never was.
 */

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log('\n' + t); }

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Comments stripped before any CSS scan. Load-bearing here: the two view
 *  stylesheets now carry PROSE explaining that their private `.ing-fresh-*` /
 *  `.dm-fresh-*` ladders were deleted and where the rules went, and that prose
 *  names the classes. A raw scan would read the explanation and report the
 *  opposite of the truth — the exact shape test-next-contrast-ratchet.js
 *  records for its own stripper. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Extract `function NAME(` by brace-matching, skipping strings, template
 *  literals, regexes and comments. Returns null when not found — every caller
 *  turns that into a LOUD failure rather than a quiet `undefined`. */
function extractFunction(src, name) {
  const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index;
  let i = src.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0, inStr = null, inTpl = false, inLine = false, inBlock = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (inTpl) { if (c === '\\') { i++; continue; } if (c === '`') inTpl = false; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTpl = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const filesUrl = pathToFileURL(path.join(ROOT, 'src/brain/files.js')).href;
const ageUrl = pathToFileURL(path.join(ROOT, 'src/public/next/shared/age.js')).href;

const brain = await import(filesUrl);
const ageMod = await import(ageUrl);
const { __readLogLatest: readLogLatest } = brain;
const { formatAge, formatDayAge, dayFreshnessStep, dayFreshnessTier, freshnessDotHtml,
  clockGlyph } = ageMod;
// ── THE REAL KIT, NOT A STUB (v3.65.0) ────────────────────────────────────
// §8 lifts `renderSidebar` out of views/domains.js and EXECUTES it. Since
// that function builds its head, its group and its rows through
// shared/sidebar.js, those names are FREE IDENTIFIERS inside the lifted
// body — and a module-level import is NOT visible there, so a call to one is
// a ReferenceError: a suite that CRASHES rather than asserts. They are
// injected through the sandbox's constructor, and they are the REAL functions
// rather than stubs, which is what keeps every assertion below an assertion
// about the SHIPPED component.
//
// `identityDotClass` JOINED THEM IN v3.65.1. views/domains.js used to own a
// second copy of the kit's mapping (`domainDotClass` -> `dm-row-dot-N`); one
// mapping and one palette now serve every surface that names a domain, so the
// lifted body calls the kit's function and this suite injects it.
const sidebarKit = await import(
  pathToFileURL(path.join(ROOT, 'src/public/next/shared/sidebar.js')).href);
const { renderSidebarHead, renderSidebarGroup, renderSidebarRow,
  identitySlotClass } = sidebarKit;
// v3.76.0: views paint a domain's RECORDED slot through `identitySlotClass`;
// the position-keyed `identityDotClass` is no longer called by any view.

// ═══════════════════════════════════════════════════════════════════════════
section('§0  Positive control — everything this suite needs really loaded');
ok(typeof readLogLatest === 'function', 'files.js exports the log parser under its test name');
ok(typeof formatDayAge === 'function' && typeof dayFreshnessStep === 'function' &&
   typeof dayFreshnessTier === 'function' &&
   typeof freshnessDotHtml === 'function' && typeof clockGlyph === 'function',
  'shared/age.js exports the day ladder, the step, the TIER, the dot and the glyph');
ok(extractFunction('function nope(){}', 'notThere') === null,
  'CONTROL — the extractor returns null for a function that does not exist');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  The log parser — the newest entry, its kind and its title');
{
  const log = [
    '# Log',
    '',
    '## [2026-01-04] ingest | The oldest source',
    'Pages created or updated:',
    '  - entities/a.md',
    '',
    '## [2026-09-14] ingest | The Curator — Product Overview',
    'Pages created or updated:',
    '  - entities/b.md',
    '',
    '## [2026-05-02] compile | A middle thread',
    '',
  ].join('\n');

  eq(readLogLatest(log),
    { date: '2026-09-14', kind: 'ingest', title: 'The Curator — Product Overview' },
    'the NEWEST entry wins, even when it is not the last one in the file — ' +
    'the v3.0.1-beta.10 guarantee, carried into the richer parse');

  // The beta.10 defect, restated as a live check: a first-match parser would
  // answer the January entry here.
  ok(readLogLatest(log).date !== '2026-01-04',
    '…and specifically NOT the first heading, which is what a `match` without `g` returned');

  eq(readLogLatest('## [2026-03-01] compile | Pricing thread\n'),
    { date: '2026-03-01', kind: 'compile', title: 'Pricing thread' },
    'a COMPILE entry reports kind "compile" — src/brain/compile.js writes that word, ' +
    'and a domain that is only ever compiled into must not be described as ingested');

  eq(readLogLatest('## [2026-03-01] ingest\n'),
    { date: '2026-03-01', kind: 'ingest', title: null },
    'a heading with no `| title` yields title null — absent, never an empty string');

  eq(readLogLatest('## [2026-03-01]\n'),
    { date: '2026-03-01', kind: null, title: null },
    'a bare date heading yields BOTH null — the renderer then uses a neutral verb');

  eq(readLogLatest('## [2026-03-01] synthesize | x\n'),
    { date: '2026-03-01', kind: null, title: 'x' },
    'an UNRECOGNISED kind word is refused, not passed through — the consumer turns ' +
    'a kind into a user-facing verb and inventing one is a fabrication');

  // TIES. appendLog only ever appends, so two entries on one day means the
  // second one happened second.
  eq(readLogLatest('## [2026-03-01] ingest | first\n## [2026-03-01] compile | second\n'),
    { date: '2026-03-01', kind: 'compile', title: 'second' },
    'a same-date tie takes the LATER occurrence in the file — appendLog appends');

  eq(readLogLatest('no headings at all\n'), null, 'a log with no entry is null');
  eq(readLogLatest(''), null, 'an empty log is null');

  // A Shared Brain pull writes `[date] Shared Brain pull from …` with NO
  // `##`. It never matched the old parser and must not start matching now.
  eq(readLogLatest('[2026-04-04] Shared Brain pull from "cohort": 3 new.\n'), null,
    'a Shared Brain pull line is NOT an entry — it carries no `##`, and widening ' +
    'the grammar in a rendering release would change what the date MEANS');

  // ── SANITISATION. The title comes out of a file an LLM helped write. ──
  const dirty = readLogLatest('## [2026-03-01] ingest | A <b>bold</b> | claim\twith\ttabs\n');
  ok(!/[<>|]/.test(dirty.title),
    'a title carrying `<`, `>` or `|` arrives with none of them — `|` is the heading\'s ' +
    'own separator and `<>` is markup on a surface that renders text');
  ok(!/\t/.test(dirty.title) && !/\s\s/.test(dirty.title),
    '…and control characters and runs of whitespace collapse to single spaces');
  ok(dirty.title.includes('bold') && dirty.title.includes('claim'),
    '…while the WORDS survive: this is a narrowing, not a deletion');

  const long = readLogLatest('## [2026-03-01] ingest | ' + 'x'.repeat(400) + '\n');
  ok(long.title.length <= 120,
    `a 400-character title is capped (got ${long.title.length}) — nothing upstream bounds it ` +
    'and it lands in a fixed-width row');
  ok(long.title.endsWith('…'),
    '…and the cut is VISIBLE (an ellipsis), not silent');

  eq(readLogLatest('## [2026-03-01] ingest |    \n').title, null,
    'a title that is only whitespace is null — absent renders as absent');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  ONE cached read serves BOTH getters, and a changed log is re-read');
{
  // WHY A CHILD PROCESS. files.js does `import { stat, readFile } from
  // 'fs/promises'`; an ESM named export is bound at LINK time, so patching
  // fs.promises from here — after files.js is loaded — counts nothing and
  // every assertion would read 0. scripts/test-domain-stats.js records
  // measuring exactly that vacuous pass. The patch has to be installed
  // before the first import of fs/promises, which needs a fresh process.
  const tmp = mkdtempSync(path.join(tmpdir(), 'curator-statusrow-'));
  try {
    const logPath = path.join(tmp, 'log.md');
    writeFileSync(logPath, '## [2026-02-02] ingest | First\n', 'utf8');
    const probePath = path.join(tmp, 'probe.mjs');
    writeFileSync(probePath, `
import fs from 'node:fs';
const realRead = fs.promises.readFile;
let reads = 0;
fs.promises.readFile = async function (p, ...rest) {
  if (String(p).endsWith('log.md')) reads++;
  return realRead.call(this, p, ...rest);
};
const m = await import(${JSON.stringify(filesUrl)});
const LOG = ${JSON.stringify(logPath)};
const out = {};
out.firstEntry = await m.__lastIngestEntry(LOG);
out.readsAfterFirst = reads;
// The SECOND call is a different getter over the same path. One cache, so
// this must cost nothing.
out.secondDate = await m.__lastIngestDate(LOG);
out.readsAfterSecond = reads;
out.thirdEntry = await m.__lastIngestEntry(LOG);
out.readsAfterThird = reads;
// Now change the file. Different length AND a later mtime.
fs.writeFileSync(LOG, '## [2026-02-02] ingest | First\\n## [2026-06-06] compile | Second thread\\n', 'utf8');
out.afterRewrite = await m.__lastIngestEntry(LOG);
out.readsAfterRewrite = reads;
// A missing log is null and is NEVER remembered as null — the file appears
// after the first ingest.
out.missing = await m.__lastIngestEntry(${JSON.stringify(path.join(tmp, 'nope.md'))});
// An explicit clear must force a fresh read of an unchanged file.
m.__clearLastIngestDateCache();
out.afterClear = await m.__lastIngestEntry(LOG);
out.readsAfterClear = reads;
console.log(JSON.stringify(out));
`, 'utf8');
    const probe = spawnSync(process.execPath, [probePath], { encoding: 'utf8' });
    let r = null;
    try { r = JSON.parse((probe.stdout || '').trim().split('\n').pop()); } catch { /* reported */ }
    ok(r && r.firstEntry, 'CONTROL — the probe ran and produced counts (a probe that fails must not pass silently)',
      `stdout=${JSON.stringify((probe.stdout || '').slice(0, 300))} stderr=${JSON.stringify((probe.stderr || '').slice(0, 400))}`);
    if (r && r.firstEntry) {
      eq(r.firstEntry, { date: '2026-02-02', kind: 'ingest', title: 'First' },
        'the cached getter returns the parsed entry');
      eq(r.readsAfterFirst, 1, 'a cold call reads the log exactly once');
      eq(r.secondDate, '2026-02-02',
        'the DATE getter still returns a plain YYYY-MM-DD string — a published field ' +
        'whose shape scripts/test-beta10-fixes.js and test-domain-stats.js both pin');
      eq(r.readsAfterSecond, 1,
        'and it costs ZERO further reads — ONE cache, two getters. Two caches would be two ' +
        'reads per poll of a polled endpoint, and two reads of one file can DISAGREE');
      eq(r.readsAfterThird, 1, 'a repeat call on an unchanged file also reads nothing');
      eq(r.afterRewrite, { date: '2026-06-06', kind: 'compile', title: 'Second thread' },
        'a CHANGED log is re-read and the newer entry surfaces — a cache that never ' +
        'refreshes turns a polled endpoint into one that lies');
      eq(r.readsAfterRewrite, 2, '…at the cost of exactly one more read');
      eq(r.missing, null, 'a missing log.md is null, not a throw');
      eq(r.afterClear, { date: '2026-06-06', kind: 'compile', title: 'Second thread' },
        '__clearLastIngestDateCache still clears EVERYTHING — the entry as well as the date');
      eq(r.readsAfterClear, 3, '…proven by the fresh read it forces on an unchanged file');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  getDomainStats puts the kind and the title on the wire, sanitised');
{
  const tmp = mkdtempSync(path.join(tmpdir(), 'curator-statusrow-dom-'));
  try {
    const { __setDomainsDirOverride } = await import(pathToFileURL(path.join(ROOT, 'src/brain/config.js')).href);
    __setDomainsDirOverride(tmp);
    const mk = (slug, logText) => {
      mkdirSync(path.join(tmp, slug, 'wiki'), { recursive: true });
      mkdirSync(path.join(tmp, slug, 'conversations'), { recursive: true });
      writeFileSync(path.join(tmp, slug, 'CLAUDE.md'), '# Domain: ' + slug + '\n', 'utf8');
      if (logText !== null) writeFileSync(path.join(tmp, slug, 'wiki', 'log.md'), logText, 'utf8');
    };
    mk('withingest', '# Log\n\n## [2026-01-01] ingest | Older\n\n## [2026-08-27] ingest | A Real Source\n');
    mk('withcompile', '# Log\n\n## [2026-08-28] compile | Pricing thread\n');
    mk('dirty', '# Log\n\n## [2026-08-29] ingest | <img src=x onerror=alert(1)> and | a pipe\n');
    mk('nolog', null);

    brain.__clearLastIngestDateCache();
    const a = await brain.getDomainStats('withingest');
    eq(a.lastIngestDate, '2026-08-27', 'the existing field is unchanged');
    eq(a.lastIngestKind, 'ingest', 'lastIngestKind is additive and names the kind');
    eq(a.lastIngestTitle, 'A Real Source', 'lastIngestTitle is additive and carries the heading title');

    const b = await brain.getDomainStats('withcompile');
    eq(b.lastIngestKind, 'compile',
      'a compile-only domain reports "compile" — the fact the old date-only payload could not carry');

    const c = await brain.getDomainStats('dirty');
    ok(!/[<>|]/.test(c.lastIngestTitle),
      'the title is sanitised AT THE PRODUCER, before it reaches any renderer: ' +
      `got ${JSON.stringify(c.lastIngestTitle)}`);
    ok(c.lastIngestTitle.includes('and') && c.lastIngestTitle.includes('a pipe'),
      '…and the ordinary words are still there');

    const d = await brain.getDomainStats('nolog');
    eq([d.lastIngestDate, d.lastIngestKind, d.lastIngestTitle], [null, null, null],
      'a domain with no log reports all three as null — a consumer must render "not known", ' +
      'and never a verb guessed from the date existing');

    // Everything the old payload carried is still there. This is the field
    // that a "just add two keys" edit is most likely to drop by accident.
    for (const f of ['slug', 'displayName', 'pageCount', 'conversationCount', 'pageCounts', 'readonly']) {
      ok(f in a, `existing field "${f}" survives the addition`);
    }
    __setDomainsDirOverride(null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The two age ladders — the dot and the words cannot disagree');
{
  // A fixed clock at NOON local, so nothing here sits on a day boundary.
  const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
  const dayBefore = (n) => {
    const d = new Date(2026, 8, 17);
    d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  };

  // The matrix crosses EVERY boundary in the ladder, from both sides.
  const MATRIX = [
    [0, 'today', 3],
    [1, 'yesterday', 2],
    [2, '2 days ago', 2],
    [6, '6 days ago', 2],
    [7, '1 week ago', 1],
    [13, '1 week ago', 1],
    [14, '2 weeks ago', 1],
    [34, '4 weeks ago', 1],
    [35, '1 month ago', 0],
    [60, '2 months ago', 0],
    [364, '12 months ago', 0],
    [365, '1 year ago', 0],
    [800, '2 years ago', 0],
  ];
  for (const [days, words, step] of MATRIX) {
    const ds = dayBefore(days);
    eq(formatDayAge(ds, NOW), words, `${days} days ago reads "${words}"`);
    eq(dayFreshnessStep(ds, NOW), step, `…and sits on freshness step ${step}`);
  }

  // THE INVARIANT THIS SECTION EXISTS FOR (v3.34.0): the mark and the word
  // are cut on ONE set of bands. Asserted as a RELATION over the whole year
  // rather than only at the boundaries above, so a threshold nudged by one
  // day inside a band is still caught.
  let disagreements = [];
  for (let n = 0; n <= 400; n++) {
    const ds = dayBefore(n);
    const w = formatDayAge(ds, NOW);
    const s = dayFreshnessStep(ds, NOW);
    const expected = w === 'today' ? 3
      : (w === 'yesterday' || / days ago$/.test(w)) ? 2
      : / weeks? ago$/.test(w) ? 1 : 0;
    if (s !== expected) disagreements.push([n, w, s, expected]);
  }
  eq(disagreements, [],
    'over 401 consecutive days the dot and the words never disagree — a mark cut on its ' +
    'own threshold table is how "today" ends up beside "1 week ago"');

  // ABSENT IS NOT OLD, AND IT IS NOT FRESH.
  for (const bad of [null, undefined, '', 'not-a-date', '2026-13-01', '2026-02-31', 42, {}]) {
    eq(formatDayAge(bad, NOW), null, `formatDayAge(${JSON.stringify(bad)}) is null, never a guess`);
    eq(dayFreshnessStep(bad, NOW), null, `…and its step is null, which renders as a DASHED ring`);
  }
  ok(dayFreshnessStep(null, NOW) !== 0,
    'an UNKNOWN age is not step 0 — "we do not know" and "a month old" are different statements');

  // NEVER ROUNDED YOUNGER. A date ahead of the clock is the one case where a
  // naive implementation reports "today".
  const ahead = (() => { const d = new Date(2026, 8, 18); return '2026-09-18'; })();
  ok(formatDayAge(ahead, NOW) !== 'today',
    `a date AHEAD of the clock is not reported as today (got ${JSON.stringify(formatDayAge(ahead, NOW))}) ` +
    '— v3.34.0: an age may never be rounded younger');
  eq(dayFreshnessStep(ahead, NOW), 0, '…and it takes the quietest mark, not the brightest');

  // A zero-valued phrase would mean a gap between two bands.
  let zeroPhrases = [];
  for (let n = 0; n <= 800; n++) {
    const w = formatDayAge(dayBefore(n), NOW);
    if (/^0 /.test(w)) zeroPhrases.push([n, w]);
  }
  eq(zeroPhrases, [],
    'no input anywhere produces "0 weeks/months/years ago" — every band is continuous ' +
    'with the next, so nothing falls between two of them');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  formatAge — one vocabulary in three files, pinned');
{
  // BYTE-IDENTICAL, extracted from the real sources. shared/age.js copies
  // views/memory.js because memory.js registers a view and touches the DOM at
  // import time, so a DOM-free module cannot import it.
  const bodyOf = (rel, marker) => {
    const s = read(rel);
    const i = s.indexOf(marker);
    if (i < 0) return null;
    const rest = s.slice(i);
    const e = rest.search(/\n\}\n/);
    return e < 0 ? null : rest.slice(0, e + 2).replace(/^export\s+/, '');
  };
  const ageBody = bodyOf('src/public/next/shared/age.js', 'export function formatAge(');
  const memBody = bodyOf('src/public/next/views/memory.js', 'export function formatAge(');
  ok(!!ageBody && !!memBody, 'CONTROL — both bodies extracted (a null here would compare nothing)');
  ok(ageBody === memBody,
    'shared/age.js\'s formatAge is BYTE-IDENTICAL to views/memory.js\'s — the copy is only ' +
    'safe because it is pinned');

  // THE BRIEF FOR THIS WORK SAID THE TRAY'S COPY WAS BYTE-IDENTICAL TOO. IT
  // IS NOT: desktop/lib/tray-model.js's took a second `precision` parameter,
  // so a byte comparison there would be a permanent false red. What is still
  // true — and what scripts/test-tray-shell.js itself asserts — is that the
  // two AGREE over a matrix when the extra argument is not supplied. That is
  // the property worth having, so it is the one asserted.
  const trayMod = await import(pathToFileURL(path.join(ROOT, 'desktop/lib/tray-model.js')).href);
  const MATRIX = [
    -1, 0, 1, 59, 60, 61, 119, 3599, 3600, 86399, 86400,
    2 * 86400, 6 * 86400, 7 * 86400, 34 * 86400, 35 * 86400,
    364 * 86400, 365 * 86400, 800 * 86400,
    null, undefined, NaN, Infinity, '60', {},
  ];
  const mismatches = MATRIX.filter((v) => formatAge(v) !== trayMod.formatAge(v));
  eq(mismatches.map(String), [],
    `shared/age.js and desktop/lib/tray-model.js agree on all ${MATRIX.length} inputs — ` +
    'the tray copy carries an extra `precision` argument, so this is asserted ' +
    'behaviourally rather than by bytes');
  ok(formatAge(60) === '1 min ago' && formatAge(30) === 'just now',
    'CONTROL — the function returns real answers, so agreement means something');
  ok(formatAge(-1) === null && formatAge('x') === null,
    'CONTROL — …and it can still say "unknown", so the matrix is not all-null');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The freshness dot — one decision, ONE ladder');
{
  const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
  ok(/class="fresh-dot fresh-today"/.test(freshnessDotHtml('2026-09-17', NOW)),
    'the dot\'s class carries the TIER the shared scale decided');
  ok(/class="fresh-dot fresh-unknown"/.test(freshnessDotHtml(null, NOW)),
    'an unknown age gets the `unknown` tier, NOT `dormant` — a different kind of state, ' +
    'not a further rung on the ramp');
  ok(/aria-hidden="true"/.test(freshnessDotHtml('2026-09-17', NOW)),
    'the dot is aria-hidden — it is a redundant encoding of the age phrase beside it');
  ok(!/-fresh-s\d/.test(freshnessDotHtml('2026-09-17', NOW) + freshnessDotHtml(null, NOW)),
    'and it emits no `-s<N>` modifier at all — the numbered vocabulary was per-view and ' +
    'meant different things in different views');

  // THE TWO CSS LADDERS ARE GONE. `.ing-fresh-*` and `.dm-fresh-*` were
  // byte-identical modulo the prefix and this section used to ASSERT that
  // identity — a guard against a duplication rather than a reason for one,
  // recorded as KNOWN AND UNFIXED in v3.54.0. Both copies are deleted and the
  // rules live in shared/freshness.css, so the assertion is INVERTED: it now
  // guards the deletion, which is this project's practice for a fixed
  // tripwire. A view that re-declares a private ladder is red again.
  const ing = read('src/public/next/views/ingest.css');
  const dm = read('src/public/next/views/domains.css');
  const sharedCss = read('src/public/next/shared/freshness.css');
  ok(!/\.ing-fresh/.test(stripComments(ing)) && !/\.dm-fresh/.test(stripComments(dm)),
    'neither view stylesheet declares a private freshness ladder any more');
  ok(/\.ing-fresh/.test(ing) && /\.dm-fresh/.test(dm),
    'CONTROL — both files still MENTION the retired names, in the prose recording where the ' +
    'rules went; the assertion above is green because the comments were stripped, not ' +
    'because the scanner stopped matching');
  ok(!/\.fresh-/.test(stripComments(ing)) && !/\.fresh-/.test(stripComments(dm)),
    '…and neither redeclares the SHARED prefix either — shared/freshness.css owns `fresh-` ' +
    'outright, the same way shared/text.css owns `tx-`');
  ok(/^\.fresh-dot\s*\{/m.test(sharedCss) && /^\.fresh-unknown\s*\{/m.test(sharedCss),
    'CONTROL — the shared sheet really does carry the shape and both ends of the scale, so ' +
    'the two absence assertions above are not green because the rules vanished entirely');
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(stripComments(sharedCss)),
    'no colour LITERAL anywhere in the shared ladder — every value is a token');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  The Ingest DESTINATION row, rendered');
{
  const src = read('src/public/next/views/ingest.js');
  const NEED = ['renderSidebar', 'formatDestinationMeta', 'destinationFigureText',
    'destinationAgeText', 'formatDestinationEvent'];
  const bodies = {};
  let fatal = false;
  for (const n of NEED) {
    bodies[n] = extractFunction(src, n);
    if (!bodies[n]) { fatal = true; }
    ok(!!bodies[n], `CONTROL — extracted ${n}() from the real source`);
  }
  if (fatal) {
    console.log('\n❌ FATAL: could not lift the Ingest row renderer. Failing loudly rather ' +
      'than reporting a green run over zero comparisons.');
    process.exit(1);
  }

  const PREAMBLE = `
let captured = '';
let state = null;
function setSidebar(html) { captured = html; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function icon() { return '<svg data-kit-icon></svg>'; }
function renderViewHeader() { return '<header></header>'; }
function isFilePickerAvailable() { return true; }
function isRemoteIngestRunning() { return false; }
function isDomainWriteBusy() { return false; }
function getDomainWriteLabel() { return null; }
function unackedSettledRecords() { return []; }
// TRUE, not false: renderSidebar guards its BINDERS on this in ingest.js and
// guards its whole body on it in domains.js. A false stub would make the
// Domains renderer return before it built anything — a green run over an
// empty string, which is the vacuous-pass shape this repo keeps recording.
function isCurrentMount() { return true; }
function selectDomain() {}
function refreshDomainStats() { return Promise.resolve(); }
let queueJobId = null;
const myMountToken = 1;
const document = { getElementById() { return null; }, querySelectorAll() { return []; } };
`;
  // identityDotClass is injected here too (v3.65.1): the DESTINATION row now
  // carries the domain's identity dot, from the same mapping and the same
  // palette the Domains rail uses — this list is still a SECOND
  // implementation of the row anatomy (re-pointing it at renderSidebarRow is
  // a separate adoption with its own suites), but the dot on it is the kit's.
  const make = new Function('formatDayAge', 'freshnessDotHtml', 'clockGlyph',
    'identitySlotClass',
    PREAMBLE + NEED.map((n) => bodies[n]).join('\n\n') +
    '\nreturn { run: (s) => { state = s; renderSidebar(2); return captured; } };');
  const api = make(formatDayAge, freshnessDotHtml, clockGlyph, identitySlotClass);

  const NOW_DAY = (() => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  })();
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  };

  const html = api.run({
    domains: [
      { slug: 'today', displayName: 'Today Domain', pageCount: 3445, lastIngestDate: NOW_DAY,
        lastIngestKind: 'ingest', lastIngestTitle: 'The Curator — Product Overview', identitySlot: 8 },
      { slug: 'three', displayName: 'Three Days', pageCount: 96, lastIngestDate: daysAgo(3),
        lastIngestKind: 'compile', lastIngestTitle: 'A <b>bold</b> thread', identitySlot: 2 },
      { slug: 'six', displayName: 'Six Weeks', pageCount: 12, lastIngestDate: daysAgo(42),
        lastIngestKind: 'ingest', lastIngestTitle: 'Old source', identitySlot: 11 },
      { slug: 'never', displayName: 'Never Written', pageCount: 0, lastIngestDate: null,
        lastIngestKind: null, lastIngestTitle: null, identitySlot: 5 },
    ],
    domain: 'today', submitting: false, queueJob: null, queueModeActive: false,
    runningDomains: [], remote: {},
  });
  ok(html.length > 0, 'CONTROL — renderSidebar produced markup');

  const rowOf = (slug) => {
    const i = html.indexOf('data-dest-slug="' + slug + '"');
    if (i < 0) return '';
    const start = html.lastIndexOf('<button', i);
    const end = html.indexOf('</button>', i);
    return html.slice(start, end + 9);
  };

  // The dot class must be the one dayFreshnessTier independently says — an
  // INDEPENDENT recomputation, not a re-read of what the row emitted.
  for (const [slug, date] of [['today', NOW_DAY], ['three', daysAgo(3)], ['six', daysAgo(42)]]) {
    const tier = dayFreshnessTier(date, Date.now());
    ok(rowOf(slug).includes('fresh-dot fresh-' + tier),
      `the "${slug}" row carries fresh-dot fresh-${tier}, matching what the scale independently decides`);
    ok(rowOf(slug).includes(formatDayAge(date, Date.now())),
      `…and the relative age "${formatDayAge(date, Date.now())}" in visible text`);
  }
  ok(rowOf('never').includes('fresh-dot fresh-unknown') && rowOf('never').includes('nothing written yet'),
    'a domain with no log reads "nothing written yet" with the DASHED ring — never a guessed date');
  ok(!rowOf('never').includes('ing-dest-event'),
    '…and carries NO event line, so its row is one line of meta rather than one plus a blank');

  // ── THE IDENTITY DOT (v3.65.1, decision 7) ──────────────────────────────
  // CONTINUITY BY IDENTITY: a destination row here and that domain's row on
  // the Domains rail must be the SAME colour, because they are the same
  // domain. Since v3.76.0 the slot is the domain's RECORDED one
  // (`identitySlot` on its stats row), and the fixture's slots are chosen so
  // that no row's slot equals its position — a row coloured by ANY position
  // fails (mutation M12), and a row with no dot at all fails (mutation M11).
  {
    const SLUGS = ['today', 'three', 'six', 'never'];
    const RECORDED = [8, 2, 11, 5];
    SLUGS.forEach((slug, i) => {
      const want = identitySlotClass(RECORDED[i]);
      const row = rowOf(slug);
      const m = /<span class="(cur-sb-dot[^"]*)"><\/span>/.exec(row);
      ok(!!m, `the "${slug}" destination row carries the kit's identity dot`, row.slice(0, 140));
      if (m) {
        const tokens = m[1].split(/\s+/);
        ok(tokens.includes('cur-sb-dot') && tokens.includes(want),
          `…and it is slot ${want.replace('cur-sb-dot-', '')} — the domain's RECORDED slot, not its position`,
          m[1]);
      }
    });
    // CONTROL: four DIFFERENT slots, so an assertion that passed by every row
    // carrying the same class would be visible.
    const seen = SLUGS.map((slug) => (/<span class="cur-sb-dot[^"]*cur-sb-dot-(\d+)"/.exec(rowOf(slug)) || [])[1]);
    eq(new Set(seen.filter(Boolean)).size, 4,
      'CONTROL — the four rows take four different slots, so "the right slot" is a reading');
  }

  ok(rowOf('today').includes('3,445 pages'),
    'the key figure is locale-grouped — 3445 reads as an id');
  ok(rowOf('today').includes('Ingested · The Curator — Product Overview'),
    'the last EVENT names the verb and the source');
  ok(rowOf('three').includes('Compiled ·'),
    'a COMPILE row says Compiled, not Ingested — the whole reason the kind is carried');
  ok(rowOf('three').includes('&lt;b&gt;') && !rowOf('three').includes('<b>bold</b>'),
    'a title carrying markup arrives ESCAPED — the server narrows it too, and this is the second layer');
  ok(rowOf('today').includes('<svg') && rowOf('today').includes('viewBox="0 0 24 24"'),
    'the clock glyph is emitted beside the age');
  ok(rowOf('today').includes('(' + NOW_DAY + ')'),
    'the ABSOLUTE date is still on the row — it moved into the accessible name, it was not dropped');
  ok(rowOf('today').includes('visually-hidden'),
    '…carried by the shell\'s clip-rect utility, so it reaches a screen reader without being drawn');
  ok(!/\stitle="/.test(html),
    'NO row carries a `title=`: a tooltip is hover-only, so keyboard and touch users would lose ' +
    'the date entirely — this view\'s ceiling in test-next-title-affordances.js is ZERO');

  // The live/settled markers must survive: they are separate facts.
  const liveHtml = api.run({
    domains: [{ slug: 'today', displayName: 'Today Domain', pageCount: 5, lastIngestDate: NOW_DAY,
      lastIngestKind: 'ingest', lastIngestTitle: 'x' }],
    domain: 'today', submitting: false, queueJob: null, queueModeActive: false,
    runningDomains: ['today'], remote: {},
  });
  ok(liveHtml.includes('Ingesting'),
    'the live marker survives the new anatomy — it is a THIRD fact, not a restatement of the age');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  The Domains KNOWLEDGE row, rendered');
{
  const src = read('src/public/next/views/domains.js');
  // `knowledgeFolderBtn` is LIFTED rather than stubbed since v3.65.0: it
  // returns the secondary action's DESCRIPTOR now, not a `<button>`, and a
  // stub returning markup would silently prove the head renders a string this
  // view no longer produces.
  // `domainDotClass` LEFT THIS LIST in v3.65.1 — views/domains.js no longer
  // defines it; the kit's `identityDotClass` is injected below instead.
  const NEED = ['renderSidebar', 'domainLastEventText', 'knowledgeFolderBtn', 'domainHealthBadgeHtml'];
  const bodies = {};
  let fatal = false;
  for (const n of NEED) {
    bodies[n] = extractFunction(src, n);
    if (!bodies[n]) fatal = true;
    ok(!!bodies[n], `CONTROL — extracted ${n}() from the real source`);
  }
  if (fatal) {
    console.log('\n❌ FATAL: could not lift the Domains row renderer.');
    process.exit(1);
  }

  const PREAMBLE = `
let captured = '';
let state = null;
function setSidebar(html) { captured = html; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function icon() { return '<svg data-kit-icon></svg>'; }
function gatedLoader() { return '<loader/>'; }
function renderStatus(o) { return '<div>' + escapeHtml(o && o.title || '') + '</div>'; }
function bindSidebarButtons() {}
function openLifecycle() {}
function selectDomain() {}
function onChooseKnowledgeFolder() { return Promise.resolve(); }
function reportAsyncActionFailure() {}
// See the note on the same stub in §7: FALSE makes this renderer return
// before it builds a single row.
function isCurrentMount() { return true; }
let loadGate = {};
const myMountToken = 1;
const document = { getElementById() { return null; }, querySelectorAll() { return []; } };
`;
  const make = new Function('formatDayAge', 'freshnessDotHtml', 'clockGlyph',
    'renderSidebarHead', 'renderSidebarGroup', 'renderSidebarRow', 'identitySlotClass', 'formatAge',
    PREAMBLE + NEED.map((n) => bodies[n]).join('\n\n') +
    '\nreturn { run: (s) => { state = s; renderSidebar(2); return captured; } };');
  const api = make(formatDayAge, freshnessDotHtml, clockGlyph,
    renderSidebarHead, renderSidebarGroup, renderSidebarRow, identitySlotClass, formatAge);

  const today = (() => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  })();
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  };

  const html = api.run({
    loaded: true, loadError: null, activeSlug: 'articles',
    readonlySet: new Set(), healthSummary: { articles: 4 },
    domains: [
      { slug: 'articles', displayName: 'Articles', pageCount: 3421, lastIngestDate: today,
        lastIngestKind: 'ingest', lastIngestTitle: 'A <b>fresh</b> source', identitySlot: 9 },
      { slug: 'business', displayName: 'Business', pageCount: 96, lastIngestDate: daysAgo(42),
        lastIngestKind: 'compile', lastIngestTitle: 'Pricing thread', identitySlot: 2 },
      { slug: 'fresh', displayName: 'Brand New', pageCount: 0, lastIngestDate: null,
        lastIngestKind: null, lastIngestTitle: null, identitySlot: 3 },
    ],
  });
  ok(html.length > 0, 'CONTROL — renderSidebar produced markup');

  const rowOf = (slug) => {
    const i = html.indexOf('data-domain-slug="' + slug + '"');
    if (i < 0) return '';
    const start = html.lastIndexOf('<button', i);
    const end = html.indexOf('</button>', i);
    return html.slice(start, end + 9);
  };

  for (const [slug, date] of [['articles', today], ['business', daysAgo(42)]]) {
    const tier = dayFreshnessTier(date, Date.now());
    ok(rowOf(slug).includes('fresh-dot fresh-' + tier),
      `the "${slug}" row carries fresh-dot fresh-${tier}, matching what the scale independently decides`);
    ok(rowOf(slug).includes(formatDayAge(date, Date.now())),
      `…and the relative age "${formatDayAge(date, Date.now())}" in visible text`);
  }
  ok(rowOf('articles').includes('3,421 pages'), 'the key figure is unchanged and still locale-grouped');
  ok(rowOf('articles').includes('Ingested ·'), 'the event line names the verb');
  ok(rowOf('business').includes('Compiled · Pricing thread'),
    'a compile-only domain says Compiled — the fact the old row could not carry at all');
  ok(rowOf('articles').includes('&lt;b&gt;') && !rowOf('articles').includes('<b>fresh</b>'),
    'a title carrying markup arrives escaped');
  ok(rowOf('fresh').includes('fresh-dot fresh-unknown') && rowOf('fresh').includes('nothing written yet'),
    'a brand-new domain reads "nothing written yet" with the dashed ring');
  ok(!rowOf('fresh').includes('dm-row-event'), '…and carries no event line');
  ok(rowOf('articles').includes('(' + today + ')') && rowOf('articles').includes('visually-hidden'),
    'the absolute date is kept, in the accessible name');
  ok(!/\stitle="/.test(html),
    'no row carries a hover-only `title=` — this file\'s ceiling is ONE (the Flip button) and ' +
    'the sidebar must not spend it');

  // THE THREE MARKS ARE THREE FACTS. The identity dot and the health dot are
  // separate readings and folding any of them together would make one dot
  // answer questions it cannot.
  // v3.65.1: the identity slot is the KIT's class now (`cur-sb-dot-1`), with
  // `dm-row-dot-1` riding beside it as an alias exactly as the other nine
  // `dm-` tokens do. Asserted as a SET naming ONE slot rather than as an
  // adjacent pair — the pair was an accident of concatenation order, and a
  // pin on it would fail on a change that moved nothing a user can see.
  {
    const cls = /<span class="([^"]*cur-sb-dot[^"]*)"><\/span>/.exec(rowOf('articles'));
    const tokens = cls ? cls[1].split(/\s+/) : [];
    // v3.76.0: articles is FIRST in the list but its recorded slot is 9, so a
    // row painted by position (slot 1) fails here.
    ok(tokens.includes('cur-sb-dot') && tokens.includes('dm-row-dot')
       && tokens.includes('cur-sb-dot-9') && tokens.includes('dm-row-dot-9'),
      '★ the domain IDENTITY dot survives: the kit glyph and the domain\'s RECORDED slot (9, not its position 1), and the host alias for both',
      tokens.join(' '));
    ok(tokens.filter((t) => /-dot-\d+$/.test(t)).every((t) => t.endsWith('-9')),
      '...and every slot token on it names the SAME slot — two names, one colour');
  }
  ok(rowOf('articles').includes('dm-row-attn'),
    'and so does the ATTENTION dot — open health issues is a different question from freshness');
  ok(rowOf('articles').includes('4 open health issue'),
    '…with its count still in the row\'s accessible name');

  // ── §8c THE HEALTH MARK HAS THREE STATES, NOT TWO (v3.76.0) ───────────
  // Before: issues -> a dot; anything else -> nothing, so a domain nobody had
  // scanned read exactly like a clean one. Now NOT CHECKED has its own hollow
  // ring and words, and "no issues" is said only with a scan result in hand.
  ok(rowOf('business').includes('dm-row-unscanned-dot') && !rowOf('business').includes('dm-row-attn'),
    '★ a domain with NO scan result wears the hollow NOT-CHECKED ring, never the issues dot', rowOf('business').slice(-400));
  ok(rowOf('business').includes('Health not checked yet') && rowOf('business').includes('run a scan'),
    '★ …and says so in its accessible name: "Health not checked yet — open this domain to run a scan"');
  ok(!/No open health issues/.test(rowOf('business')),
    '★ …and NEVER "no issues" without a scan result');
  ok(!rowOf('articles').includes('dm-row-unscanned-dot'),
    'a SCANNED domain carries no not-checked ring');
  const scannedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const h2 = api.run({
    loaded: true, loadError: null, activeSlug: 'fresh', healthLoading: true,
    readonlySet: new Set(),
    healthSummary: { articles: { count: 0, scannedAt }, business: { count: 2, scannedAt } },
    domains: [
      { slug: 'articles', displayName: 'Articles', pageCount: 3, lastIngestDate: today, identitySlot: 1 },
      { slug: 'business', displayName: 'Business', pageCount: 3, lastIngestDate: today, identitySlot: 2 },
      { slug: 'fresh', displayName: 'Fresh', pageCount: 0, lastIngestDate: null, identitySlot: 3 },
    ],
  });
  const rowOf2 = (slug) => {
    const i = h2.indexOf('data-domain-slug="' + slug + '"');
    return i < 0 ? '' : h2.slice(h2.lastIndexOf('<button', i), h2.indexOf('</button>', i) + 9);
  };
  ok(!rowOf2('articles').includes('dm-row-attn') && !rowOf2('articles').includes('dm-row-unscanned-dot')
    && rowOf2('articles').includes('No open health issues, checked 5 min ago'),
    '★ a scanned CLEAN domain: no glyph, and "No open health issues, checked 5 min ago" — the scan\'s age', rowOf2('articles').slice(-300));
  ok(rowOf2('business').includes('dm-row-attn') && rowOf2('business').includes('2 open health issues, checked 5 min ago'),
    '★ a scanned domain WITH issues: the dot, the count and the scan\'s age', rowOf2('business').slice(-300));
  ok(rowOf2('fresh').includes('dm-row-unscanned-dot') && rowOf2('fresh').includes('Health check running'),
    'the OPEN domain whose scan is running says "Health check running" beside the same hollow ring', rowOf2('fresh').slice(-300));
}

// ════════════════════════════════════════════════════════════════════════
section('§8b  THE ADOPTION IS INERT — byte-identical modulo three normalisations');
// ════════════════════════════════════════════════════════════════════════
//
// THE ACCEPTANCE TEST FOR v3.65.0's SIDEBAR PACKAGE IS THAT THIS SIDEBAR DOES
// NOT MOVE. It is the reference design — the maintainer's own words against
// the Context one, *"I suggest we go with the Domains design, which is more
// polished"* — so Context and Settings adopt it and this page gains nothing
// visible at all.
//
// A component whose OWN classes carry the rules has to emit those classes, so
// literal byte-identity is not achievable and was never the right ask (the
// v3.64.2 overview precedent settled this the same way). What IS asserted is
// byte-identity after exactly THREE normalisations, each of which is then
// proved INERT rather than assumed:
//
//   1. the `cur-sb-*` tokens added beside each host token — proved by: every
//      class the reference wrote is still written, IN THE SAME ORDER, and
//      every added token is on the kit's own prefix;
//   2. `type="button"` — proved by: no attribute other than `type` differs on
//      any element, and `type` lands on <button>s only, always with the value
//      `button`. (A <button> outside a form defaults to `type="submit"`;
//      there is no form. The overview card's tiles already write it.)
//   3. the KNOWLEDGE eyebrow's inline `style="margin-top:10px"` becoming
//      `.cur-sb-group-head` — the one declaration in this sidebar no
//      stylesheet and no [data-theme] block could ever reach. Same value,
//      10px, now in shared/sidebar.css.
//
// The REFERENCE is not transcribed: it is the pre-adoption `renderSidebar`,
// lifted out of git and executed against the same fixture, so this comparison
// cannot quietly become a comparison of the new output with itself.
{
  // ── THE REFERENCE, FROZEN ─────────────────────────────────────────────
  // v3.64.2's `knowledgeFolderBtn` + `renderSidebar`, VERBATIM apart from
  // their comments, which were stripped because the corpus is here to be
  // EXECUTED and not read. It was produced by lifting the two functions out of
  // git and printing them, never transcribed by hand.
  //
  // WHY IT IS FROZEN HERE RATHER THAN READ FROM A GIT REF. `git show HEAD~1`
  // was the first cut and is a trap: the moment a second commit lands on this
  // branch, HEAD~1 is the ADOPTED file and every assertion below compares the
  // new output with itself — green, vacuous, and impossible to notice. A
  // frozen copy cannot silently become the thing it is checking.
  //
  // IT IS ALSO THE RECORD of what this sidebar looked like the day it became
  // a component, which is the thing a future "let us simplify the kit" pass
  // has to be measured against.
  const REF_V3642 = `
function knowledgeFolderBtn() {
  return (
    '<button class="btn btn-secondary dm-kb-btn" id="dm-kb-choose-btn"' +
      (state.kbBusy ? ' disabled' : '') + '>' +
      icon('folder', 13) + ' ' + (state.kbBusy ? 'Waiting for the folder picker…' : 'Use existing folder') +
    '</button>'
  );
}

function renderSidebar(token) {
  if (!isCurrentMount(token)) return;
  const newBtn =
    '<button class="btn btn-primary dm-new-btn" id="dm-new-domain-btn">' + icon('grid', 13) + ' New domain</button>' +
    knowledgeFolderBtn();
  if (!state.loaded) {
    setSidebar('<div class="sidebar-title">Domains</div>' + newBtn + gatedLoader(loadGate, 'Loading…', 'sidebar-hint'), token);
    bindSidebarButtons();
    return;
  }
  if (state.loadError) {
    setSidebar(
      '<div class="sidebar-title">Domains</div>' + newBtn +
      '<div class="dm-sidebar-status">' +
        renderStatus({ state: 'danger', title: 'Could not load domains', detail: state.loadError }) +
      '</div>',
      token
    );
    bindSidebarButtons();
    return;
  }
  if (state.domains.length === 0) {
    setSidebar(
      '<div class="sidebar-title">Domains</div>' + newBtn +
      '<div class="cur-eyebrow" style="margin-top:10px">KNOWLEDGE</div>' +
      '<div class="sidebar-note">No domains yet. A domain is one compounding wiki — create your first one above.</div>',
      token
    );
    bindSidebarButtons();
    return;
  }
  const now = Date.now();
  const rows = state.domains.map((d, i) => {
    const readonly = state.readonlySet.has(d.slug);
    const active = d.slug === state.activeSlug;
    const issueCount = state.healthSummary[d.slug];
    const attention = typeof issueCount === 'number' && issueCount > 0;
    const pagesText = typeof d.pageCount === 'number'
      ? d.pageCount.toLocaleString() + ' page' + (d.pageCount === 1 ? '' : 's')
      : '— pages';
    const age = formatDayAge(d.lastIngestDate, now);
    const lastEvent = domainLastEventText(d);
    return (
      '<button class="dm-row' + (active ? ' active' : '') + '" data-domain-slug="' + escapeHtml(d.slug) + '">' +
        '<span class="dm-row-dot ' + domainDotClass(i) + '"></span>' +
        '<span class="dm-row-main">' +
          '<span class="dm-row-name">' + escapeHtml(d.displayName || d.slug) + '</span>' +
          '<span class="dm-row-meta">' +
            '<span class="dm-row-figure">' + pagesText + '</span>' +
            '<span class="dm-row-sep" aria-hidden="true">·</span>' +
            freshnessDotHtml(d.lastIngestDate, now) +
            clockGlyph(12) +
            '<span class="dm-row-age">' + escapeHtml(age || 'nothing written yet') + '</span>' +
            (d.lastIngestDate
              ? '<span class="visually-hidden"> (' + escapeHtml(d.lastIngestDate) + ')</span>'
              : '') +
          '</span>' +
          (lastEvent ? '<span class="dm-row-event">' + escapeHtml(lastEvent) + '</span>' : '') +
        '</span>' +
        (readonly
          ? '<span class="dm-row-mirror">RO</span>' +
            '<span class="visually-hidden">Read-only Shared Brain mirror</span>'
          : '') +
        (attention
          ? '<span class="dm-row-attn"></span>' +
            '<span class="visually-hidden">' + issueCount + ' open health issue' +
              (issueCount === 1 ? '' : 's') + '</span>'
          : '') +
      '</button>'
    );
  }).join('');
  setSidebar(
    '<div class="sidebar-title">Domains</div>' + newBtn +
    '<div class="cur-eyebrow" style="margin-top:10px">KNOWLEDGE</div>' +
    '<div class="dm-row-list">' + rows + '</div>',
    token
  );
  bindSidebarButtons();
  document.querySelectorAll('.dm-row[data-domain-slug]').forEach((btn) => {
    btn.addEventListener('click', () => selectDomain(btn.dataset.domainSlug));
  });
}
`;
  {
    const NOW = read('src/public/next/views/domains.js');
    const REF = REF_V3642;
    const PRE2 = `
let captured = '';
let state = null;
function setSidebar(html) { captured = html; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function icon(n, sz) { return '<svg data-icon="' + n + '" width="' + sz + '"></svg>'; }
function gatedLoader() { return '<loader/>'; }
function renderStatus(o) { return '<div>' + escapeHtml(o && o.title || '') + '</div>'; }
function bindSidebarButtons() {}
function selectDomain() {}
// THE FROZEN REFERENCE CARRIES ITS OWN FROZEN HELPER (v3.65.1).
// domainDotClass was lifted from the LIVE views/domains.js and shared by both
// arms while it still existed there. It does not any more -- one mapping,
// identityDotClass, serves every surface that names a domain -- so the
// v3.64.2 reference below, which is frozen source and must keep producing
// exactly what v3.64.2 produced, gets a frozen copy of the function IT
// called. A helper only the reference uses belongs to the reference; lifting
// one from the live file was always a way for the two arms to move together
// and cancel out.
// (NO BACKTICKS IN THIS BLOCK: it sits inside a template literal.)
function domainDotClass(index) { return 'dm-row-dot-' + ((index % 6) + 1); }
function isCurrentMount() { return true; }
let loadGate = {};
const myMountToken = 1;
const document = { getElementById() { return null; }, querySelectorAll() { return []; } };
`;
    // The REFERENCE carries its own `renderSidebar` and `knowledgeFolderBtn`;
    // the two pure helpers they share are lifted from the LIVE file in both
    // arms, because neither changed in this adoption and a second frozen copy
    // of `domainLastEventText` would be a second thing to keep in step.
    const LIFT = ['renderSidebar', 'knowledgeFolderBtn'];
    const SHARED_FNS = ['domainLastEventText', 'domainHealthBadgeHtml'];
    const build = (src, kit) => {
      const body = PRE2 + SHARED_FNS.map((n) => extractFunction(NOW, n)).join('\n\n') + '\n\n'
        + LIFT.map((n) => extractFunction(src, n)).join('\n\n') +
        '\nreturn { run: (s) => { state = s; renderSidebar(2); return captured; } };';
      return kit
        ? new Function('formatDayAge', 'freshnessDotHtml', 'clockGlyph',
            'renderSidebarHead', 'renderSidebarGroup', 'renderSidebarRow',
            'identitySlotClass', 'formatAge', body)(
            formatDayAge, freshnessDotHtml, clockGlyph,
            renderSidebarHead, renderSidebarGroup, renderSidebarRow, identitySlotClass, formatAge)
        : new Function('formatDayAge', 'freshnessDotHtml', 'clockGlyph', 'formatAge', body)(
            formatDayAge, freshnessDotHtml, clockGlyph, formatAge);
    };
    const refApi = build(REF, false);
    const nowApi = build(NOW, true);
    const today = (() => { const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
        '-' + String(d.getDate()).padStart(2, '0'); })();
    const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
        '-' + String(d.getDate()).padStart(2, '0'); };
    const st = (over) => ({
      loaded: true, loadError: null, activeSlug: 'articles', kbBusy: false,
      readonlySet: new Set(['mirror']), healthSummary: { articles: 4, business: 0 },
      // v3.76.0: the recorded slots EQUAL the positions here, because the
      // frozen reference paints by position (`index % 6`) — this section
      // proves the kit adoption moved nothing, not the identity rule (that is
      // §8's and test-next-domain-dots.js's).
      domains: [
        { slug: 'articles', displayName: 'Articles', pageCount: 3421, lastIngestDate: today,
          lastIngestKind: 'ingest', lastIngestTitle: 'A <b>fresh</b> source', identitySlot: 1 },
        { slug: 'business', displayName: 'Business', pageCount: 96, lastIngestDate: daysAgo(42),
          lastIngestKind: 'compile', lastIngestTitle: 'Pricing thread', identitySlot: 2 },
        { slug: 'mirror', displayName: 'Shared Mirror', pageCount: 1, lastIngestDate: daysAgo(3),
          lastIngestKind: null, lastIngestTitle: null, identitySlot: 3 },
        { slug: 'fresh', displayName: 'Brand New', pageCount: 0, lastIngestDate: null,
          lastIngestKind: null, lastIngestTitle: null, identitySlot: 4 },
      ],
      ...over,
    });
    // ALL FOUR BRANCHES, because the head is emitted by every one of them and
    // a comparison of the row branch alone would say nothing about the other
    // three — which is where a loader, an error and an empty-state sentence
    // live.
    const BRANCHES = [
      ['rows', st()],
      ['empty', st({ domains: [], activeSlug: null })],
      ['loading', st({ loaded: false, kbBusy: true, domains: [] })],
      ['load error', st({ loadError: 'nope', domains: [] })],
    ];
    // v3.76.0 — A FOURTH, NAMED NORMALISATION: the health mark's two new
    // states (NOT CHECKED: a hollow ring + words; CLEAN: words only). They are
    // a deliberate addition AFTER the adoption this section freezes, so they
    // are stripped here and asserted on their own below and in §8c — and the
    // strip is proved to remove nothing else (the CONTROLs after the loop).
    const stripHealth = (h) => h
      .replace(/<span class="dm-row-unscanned-dot" aria-hidden="true"><\/span>/g, '')
      .replace(/<span class="visually-hidden">(?:Health not checked yet[^<]*|Health check running|No open health issues[^<]*)<\/span>/g, '');
    const normalise = (h) => stripHealth(h)
      .replace(/cur-sb-[a-z0-9-]+ ?/g, '')
      .replace(/ type="button"/g, '')
      .replace(/<div class="cur-eyebrow" style="margin-top:10px">/g, '<div class="cur-eyebrow">');
    const sha = (x) => createHash('sha256').update(x).digest('hex').slice(0, 16);
    for (const [name, s0] of BRANCHES) {
      const a = normalise(refApi.run(s0));
      const b = normalise(nowApi.run(s0));
      ok(a === b,
        `the ${name} branch is BYTE-IDENTICAL to the pre-adoption sidebar after the three ` +
        `normalisations (${sha(a)})`,
        a === b ? '' : (() => {
          let i = 0; while (i < a.length && a[i] === b[i]) i++;
          return 'first difference at ' + i + '\n  was: ' + JSON.stringify(a.slice(i - 60, i + 120)) +
                 '\n  now: ' + JSON.stringify(b.slice(i - 60, i + 120));
        })());
    }
    // ANTI-VACUITY: the normaliser must not be able to make ANY two strings
    // equal. If it could, all four assertions above would pass on a sidebar
    // that had been rewritten from scratch.
    ok(normalise('<button class="cur-sb-row dm-row">x</button>')
       !== normalise('<button class="cur-sb-row dm-row">y</button>'),
      'CONTROL — the normaliser strips only the three named things: two rows differing in '
      + 'their TEXT are still different after it');
    ok(normalise('<span class="cur-sb-age dm-row-age">a</span>')
       === '<span class="dm-row-age">a</span>',
      'CONTROL — …and it really does strip a kit token, so the four assertions are not passing '
      + 'because it strips nothing');

    // ── NORMALISATION 1 IS INERT: the host's tokens survive, in order ────
    ok(stripHealth('<span class="visually-hidden">4 open health issues</span><span class="dm-row-attn"></span>')
       === '<span class="visually-hidden">4 open health issues</span><span class="dm-row-attn"></span>',
      'CONTROL — the v3.76.0 health strip leaves the ISSUES state (the reference\'s own) untouched');
    ok(stripHealth(nowApi.run(st())) !== nowApi.run(st()),
      'CONTROL — …and it really does remove the new states from this fixture (mirror and fresh are unchecked, business is clean)');
    const nowRows = stripHealth(nowApi.run(st()));
    const refRows = refApi.run(st());
    const classesOf = (h) => [...h.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
    const refCls = classesOf(refRows);
    const nowCls = classesOf(nowRows);
    eq(nowCls.length, refCls.length, 'the same number of class attributes is written');
    const orderOk = [];
    const addedOk = [];
    for (let i = 0; i < Math.min(refCls.length, nowCls.length); i++) {
      const was = refCls[i].split(/\s+/).filter(Boolean);
      const has = nowCls[i].split(/\s+/).filter(Boolean);
      // every reference token is still there, in the same relative order
      let k = -1; let inOrder = true;
      for (const t of was) { const at = has.indexOf(t, k + 1); if (at < 0) { inOrder = false; break; } k = at; }
      orderOk.push(inOrder ? null : `#${i}: "${refCls[i]}" -> "${nowCls[i]}"`);
      const added = has.filter((t) => !was.includes(t));
      const bad = added.filter((t) => !/^cur-sb-/.test(t));
      addedOk.push(bad.length ? `#${i}: ${bad.join(' ')}` : null);
    }
    ok(orderOk.every((x) => x === null),
      'every class the reference wrote is still written, IN THE SAME ORDER',
      orderOk.filter(Boolean).join(' | '));
    ok(addedOk.every((x) => x === null),
      '…and every token the adoption ADDED is on the kit\'s own `cur-sb-` prefix, so no '
      + 'foreign name reached this sidebar',
      addedOk.filter(Boolean).join(' | '));

    // ── NORMALISATION 2 IS INERT: `type` lands on buttons only ─────────
    const types = [...nowRows.matchAll(/<(\w+)([^>]*?)\stype="([^"]*)"/g)];
    ok(types.length > 0, 'CONTROL — the adoption really does write `type=` somewhere');
    ok(types.every((m) => m[1] === 'button' && m[3] === 'button'),
      '…and it lands on <button> only, always with the value `button` — a <button> outside a '
      + 'form defaults to type="submit", and there is no form on this screen',
      types.map((m) => m[1] + '/' + m[3]).join(', '));
    const attrsOf = (h) => [...h.matchAll(/\s([a-z-]+)=/g)].map((m) => m[1]);
    const refAttrs = new Set(attrsOf(refRows));
    const newAttrs = [...new Set(attrsOf(nowRows))].filter((a) => !refAttrs.has(a));
    ok(newAttrs.length === 0 || (newAttrs.length === 1 && newAttrs[0] === 'type'),
      '…and `type` is the ONLY attribute name the adoption introduced',
      newAttrs.join(', '));

    // ── NORMALISATION 3 IS INERT: the inline margin became a rule, same value
    // EVERY BRANCH, not just the rows one. A first cut read only `nowRows`,
    // and was GREEN when the inline style came back on the EMPTY branch's
    // head — which is a different code path (the kit refuses to render a
    // group head over no rows, correctly, so that branch writes its own) and
    // the one a user with no domains yet actually sees. The normaliser
    // rewrites the inline form, so the byte-identity assertions above cannot
    // see it either: that is exactly what a normalisation is allowed to hide
    // and why each one is proved inert on its own.
    const inlineLeft = BRANCHES
      .filter(([, s0]) => /style="margin-top:10px"/.test(nowApi.run(s0)))
      .map(([n]) => n);
    ok(inlineLeft.length === 0,
      'the KNOWLEDGE eyebrow\'s inline margin is gone from EVERY branch\'s markup',
      inlineLeft.join(', '));
    ok(BRANCHES.some(([, s0]) => /style="margin-top:10px"/.test(refApi.run(s0))),
      'CONTROL — the reference really did write it, so the assertion above is a change and not '
      + 'a property the sidebar always had');
    const sbCss = read('src/public/next/shared/sidebar.css');
    ok(/\.cur-sb-group-head\s*\{[^}]*margin-top:\s*10px/.test(sbCss),
      '…and shared/sidebar.css declares it at the SAME value — an inline style is the one '
      + 'declaration no stylesheet and no [data-theme] block can reach');
    ok(/class="cur-sb-group-head cur-eyebrow"/.test(nowRows),
      '…on the element that carried it');
  }
}

// ════════════════════════════════════════════════════════════════════════
section('§8c  THE ROW RULES MOVED — they were not copied');
// ════════════════════════════════════════════════════════════════════════
//
// While both files declared the row, both painted the same values and nothing
// on screen could move — which is exactly what lets a duplication survive a
// review. So the view's copy is DELETED, and this section is what makes that
// checkable rather than remembered.
{
  const dm = stripComments(read('src/public/next/views/domains.css'));
  const sb = stripComments(read('src/public/next/shared/sidebar.css'));
  const MOVED = ['.dm-row-list', '.dm-row', '.dm-row-main', '.dm-row-name', '.dm-row-meta',
    '.dm-row-figure', '.dm-row-sep', '.dm-row-age', '.dm-row-event'];
  const still = MOVED.filter((sel) => new RegExp(
    sel.replace('.', '\\.') + '(?![a-z0-9-])[^{}]*\\{', 'i').test(dm));
  ok(still.length === 0,
    'views/domains.css declares NONE of the nine row rules any more — the card moved, it was '
    + 'not copied', still.join(', '));
  const kitHas = ['.cur-sb-list', '.cur-sb-row', '.cur-sb-main', '.cur-sb-name', '.cur-sb-meta',
    '.cur-sb-figure', '.cur-sb-sep', '.cur-sb-age', '.cur-sb-event']
    .filter((sel) => new RegExp(sel.replace('.', '\\.') + '(?![a-z0-9-])[^{}]*\\{').test(sb));
  eq(kitHas.length, 9, 'CONTROL — and the kit declares all nine under its own names');
  // ── THE PALETTE FOLLOWED THE ROW (v3.65.1) ────────────────────────────
  // v3.65.0 left the twelve colour rules in views/domains.css, naming the
  // kit's class beside the host's, on the reading that the colour-literal
  // baseline "holds exactly two files, neither of them shared". One of those
  // two is shared/checkbox.css, so it never was two views — and leaving them
  // here had a measured cost: views/memory.css declared its own byte-identical
  // copy of the same twelve rules, and CSS has no per-view scope, so each
  // copy painted BOTH rails. One palette, one file, six slots x two themes.
  //
  // Each of the twelve is read as a RULE and required to declare a
  // background: a first cut asserted `/\.cur-sb-dot-1/` against the whole file
  // and was GREEN when slot 1's DARK rule lost its selector, because the
  // light-theme rule below still carried it.
  // `(?![0-9-])` IS LOAD-BEARING: without it `.cur-sb-dot-33` reads as slot 3
  // with a stray character, so renaming slot 3's dark rule leaves this scan
  // reporting twelve healthy rules over a file with eleven (mutation M5).
  // v3.66.0: TWELVE slots, and the per-theme value moved into TOKENS —
  // tokens/identity.css declares `--id-1` … `--id-12` once per theme, and the
  // kit's rule for each slot is written ONCE, reading its token. So the scan
  // is now "one rule per slot, painting var(--id-N)" plus "each token is
  // declared in both theme blocks", which is the same one-palette-one-place
  // property with the theme moved to where themes live.
  const dotRules = [...sb.matchAll(/([^{}]*?\.cur-sb-dot-(\d+)(?![0-9-])[^{}]*)\{([^}]*)\}/g)];
  const idCss = stripComments(read('src/public/next/tokens/identity.css'));
  const idDark = /:root\s*\{([^}]*)\}/.exec(idCss);
  const idLight = /\[data-theme="light"\]\s*\{([^}]*)\}/.exec(idCss);
  const missing = [];
  for (let n = 1; n <= 12; n++) {
    const rule = dotRules.find((m) => Number(m[2]) === n && !/\[data-theme/.test(m[1]));
    if (!rule) { missing.push(`slot ${n}: no rule`); continue; }
    if (!new RegExp(`background\\s*:\\s*var\\(--id-${n}\\)`).test(rule[3])) missing.push(`slot ${n}: does not paint var(--id-${n})`);
    for (const [theme, block] of [['dark', idDark], ['light', idLight]]) {
      if (!block || !new RegExp(`--id-${n}\\s*:\\s*#[0-9A-Fa-f]{6}`).test(block[1])) missing.push(`slot ${n} ${theme}: --id-${n} not declared`);
    }
  }
  ok(missing.length === 0,
    'all twelve identity slots are painted by shared/sidebar.css from one token each '
    + '(tokens/identity.css, both themes), beside the glyph they paint — so the Domains rail, '
    + 'the Context rail, Chat\'s domain chips and Ingest\'s destination rows take one colour '
    + 'from one place',
    missing.join(' | '));
  ok(dotRules.length >= 12,
    `CONTROL — the scan really found the twelve rules (${dotRules.length}), so "nothing missing" `
    + 'is a reading rather than a regex that stopped matching');
  ok(!/\.dm-row-dot-\d\b[^{}]*\{/.test(dm),
    '...and views/domains.css declares NO identity-slot rule of its own — `dm-row-dot-N` is a '
    + 'markup alias the kit emits and nothing paints');
  ok(/\.dm-row-mirror\s*\{/.test(dm) && /\.dm-row-attn\s*\{/.test(dm),
    '…the two BADGES do stay, being this view\'s own markup in the kit\'s trusted slot');
  ok(/\.cur-sb-dot-1\s*\{[^}]*background/.test(sb) && !/\.fresh-/.test(sb),
    'CONTROL — the kit declares the identity COLOUR now and still NO `.fresh-` rule; it owns the '
    + 'dot\'s shape and nothing about which colour or which state it carries');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('❌ FAILURES');
  process.exit(1);
}
console.log('✅ All sidebar status-row assertions green');
