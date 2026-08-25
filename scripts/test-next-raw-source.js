/**
 * test-next-raw-source.js — OFFLINE suite for the /next reader's RAW-source
 * bar (src/public/next/app.js's "Reader RAW-source bar" block, the
 * .reader-source-* rules in views/domains.css, and the `domain` handoff in
 * views/domains.js).
 *
 * No network, no API key, no server, no browser.
 *
 * WHY THIS SUITE EXISTS. v3.5.0 shipped raw-source retrieval end to end — a
 * hardened resolver (src/brain/raw-store.js), two routes, an MCP tool, a
 * manifest — and the /next reader fetched `page.frontmatter` and read only
 * `.tags`, dropping `frontmatter.source` on the floor. The field arrived and
 * was discarded: this repo's named DEAD-DATA shape. Cutting over in that
 * state would have silently deleted an in-app feature. §7 is the guard that
 * makes the same silence impossible a second time.
 *
 * ── What this suite ACTUALLY covers ─────────────────────────────────────
 * COVERED, behaviourally (the REAL functions are extracted from the real
 * file by brace-matching and executed via `new Function`):
 *   - formatSourceBytes() across units and every defensive input.
 *   - describeRawSource() over ALL FOUR display states, driven from real
 *     GET /api/wiki/:domain/source response shapes — plus 'unsafe',
 *     'not-a-summary', and an unknown future reason, which must degrade to
 *     null rather than render a confidently-wrong bar.
 *   - renderReaderSourceHtml() for every state the classifier can produce,
 *     both directions (state -> markup, and markup -> absence of markup).
 *   - THE EXTERNAL-SOURCE CASE IS INERT: never an <a>, never an href,
 *     never any URL-bearing attribute, for an ordinary https URL, a
 *     `javascript:` URL and an attribute-breakout attempt (§4).
 *   - Escaping of a hostile filename / declared source / URL (§6).
 *   - loadReaderSource() driven against a fake fetch + fake document: which
 *     URL it requests, that a non-summary page requests NOTHING, that a
 *     superseded open cannot paint, and — the load-bearing one — that the
 *     ONLY network call made for an external-source page is to our own
 *     /source endpoint. The declared URL is never fetched (§5).
 *   - revealReaderSource() against a fake fetch: the macOS-only 501 path,
 *     the success path, and a route-level failure (§9).
 *
 * COVERED as SOURCE-LEVEL guards (stated as such, not as behaviour):
 *   - renderReader() emits the #reader-source-bar node and calls
 *     loadReaderSource() on its content path, so BOTH reader entry points
 *     (Domains browse and a Chat citation chip) inherit the bar from the
 *     shell rather than from a per-view copy (§7).
 *   - views/domains.js hands the reader a `domain` (§7).
 *   - No HTTP client of any kind exists in the pure classify/render
 *     functions (§5).
 *   - CSS: every .reader-source-* class the JS emits is defined; tokens
 *     only; no prefers-color-scheme (§10).
 *
 * NOT COVERED here (stated rather than implied):
 *   - views/chat.js. It does NOT pass `domain` today, so a citation-chip
 *     reader shows no bar. That is a ONE-LINE change in its
 *     paintReaderPage(), owned by another agent, and is reported rather
 *     than made. §7.6 pins the fact so the gap is visible, not silent.
 *   - Real rendering, real layout, real theming. Browser-verified
 *     separately; that verification is not reproducible from here.
 *   - The backend routes and src/brain/raw-store.js — covered by
 *     scripts/test-raw-store.js and scripts/test-raw-source-ui.js.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const APP_PATH = path.join(ROOT, 'src/public/next/app.js');
const appJs = readFileSync(APP_PATH, 'utf8');
const domainsJs = readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
const domainsCss = readFileSync(path.join(ROOT, 'src/public/next/views/domains.css'), 'utf8');
const chatJs = readFileSync(path.join(ROOT, 'src/public/next/views/chat.js'), 'utf8');

// ── Comment stripping for the source guards ─────────────────────────────
// Every ABSENCE check below has to run against CODE: this feature's own
// docblocks deliberately QUOTE the strings being asserted absent ("<a
// href>", "fetch", "SSRF") while explaining why they are absent. Run
// against raw text those guards would be reading a comment — the named
// failure shape "a check that stopped reaching the thing it protects".
//
// ORDER IS LOAD-BEARING and matches scripts/test-next-onboarding.js: line
// comments FIRST. app.js's prose contains `/*`-looking sequences inside //
// comments; strip blocks first and one of those opens a fake block comment
// that runs on until the next `*/`, swallowing whole functions.
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

// Sanity anchors are STRUCTURAL and deliberately exclude anything an
// assertion below also checks — an overlapping anchor turns a mutation
// into a throw before a single assertion runs, which is a red for the
// wrong reason and proves nothing.
const appCode = assertStrippedSane(stripComments(appJs), 'app.js', [
  'function describeRawSource(result) {',
  'function renderReaderSourceHtml(info) {',
  'async function loadReaderSource(domain, pagePath, epoch) {',
  'async function revealReaderSource(domain, pagePath, btn) {',
  'function renderReader() {',
]);
const domainsCode = assertStrippedSane(stripComments(domainsJs), 'domains.js', [
  'async function openWikiPageFromBrowse(path, titleHint) {',
]);
const cssCode = assertStrippedSane(stripComments(domainsCss), 'domains.css', ['.reader-source-bar {']);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extract the real functions ──────────────────────────────────────────
// Brace-matched so nested braces cannot truncate the extraction; a missing
// name THROWS rather than silently testing nothing.
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i);
  // Desync tripwire: a truncated extraction must fail LOUDLY here rather
  // than later as a confusing SyntaxError out of new Function().
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

const PURE_FNS = ['escapeHtml', 'formatSourceBytes', 'describeRawSource', 'renderReaderSourceHtml'];
const IMPURE_FNS = ['loadReaderSource', 'revealReaderSource'];

// `readerSourceSeq` is a module-level `let` in app.js; the sandbox declares
// its own so the extracted loadReaderSource() closes over something. §8
// separately asserts the real declaration still exists, so this stand-in
// cannot mask its removal.
const sandbox = new Function(
  'document', 'fetch', 'isCurrentReader',
  'let readerSourceSeq = 0;\n' +
  [...PURE_FNS, ...IMPURE_FNS]
    .map((n) => extractFunction(appJs, n).replace(/^export /, ''))
    .join('\n\n') + '\n' +
  `return { ${[...PURE_FNS, ...IMPURE_FNS].join(', ')} };`
);

// ── Fake DOM / fetch ────────────────────────────────────────────────────
function makeEl(id) {
  return {
    id,
    innerHTML: '',
    hidden: true,
    className: '',
    textContent: '',
    disabled: false,
    isConnected: true,
    _listeners: [],
    addEventListener(_t, fn) { this._listeners.push(fn); },
    remove() { this.isConnected = false; },
  };
}
function makeDoc(ids) {
  const els = {};
  for (const id of ids) els[id] = makeEl(id);
  return { els, getElementById: (id) => els[id] || null };
}
function makeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init: init || null });
    return responder(String(url), init);
  };
  fn.calls = calls;
  return fn;
}
function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Attribute checks must look INSIDE a tag. The hostile fixtures below
// deliberately contain the literal text `href="` and `onerror=`; after
// escaping those survive as TEXT, which is correct and safe — a bare
// /href=/ match would flag the escaped text and turn a passing guard into
// a red for the wrong reason. Scoping to `<...>` is what makes the check
// mean "an attribute the browser will act on".
const ATTR_IN_TAG = /<[^>]*\s(?:href|src|xlink:href|formaction|on[a-z]+)\s*=/i;
// Every element the source bar is allowed to emit. An allow-list, not a
// deny-list: a deny-list silently permits whatever it forgot.
function disallowedTags(html) {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)]
    .map((m) => m[1].toLowerCase())
    .filter((t) => t !== 'span' && t !== 'button');
}

const pure = sandbox(makeDoc([]), makeFetch(() => { throw new Error('no fetch expected'); }), () => true);
const { formatSourceBytes, describeRawSource, renderReaderSourceHtml } = pure;

// ── Real response fixtures ──────────────────────────────────────────────
// Shapes copied from src/routes/wiki.js's GET /:domain/source and
// src/brain/raw-store.js's sourceForSummary(). A drift in either shows up
// here as a classifier that returns null for a state that used to work.
const RES_FOUND = {
  ok: true, found: true, page: 'summaries/report.md',
  filename: 'Quarterly Report (final).pdf', bytes: 2516582, mtime: 1750000000000, sha256: null,
};
const RES_MISSING = {
  ok: true, found: false, reason: 'missing', page: 'summaries/report.md',
  declaredSource: 'Quarterly Report (final).pdf', manifest: null,
  message: '"Quarterly Report (final).pdf" is not in this domain\'s raw folder.',
};
const RES_EXTERNAL = {
  ok: true, found: false, reason: 'external-source', page: 'summaries/post.md',
  declaredSource: 'https://medium.com/@talirezun', url: 'https://medium.com/@talirezun',
  message: 'built from a web page',
};
const RES_NO_SOURCE = {
  ok: true, found: false, reason: 'no-source-recorded', page: 'summaries/chat.md',
  message: 'does not record a source filename',
};
const RES_NOT_A_SUMMARY = { ok: true, found: false, reason: 'not-a-summary', page: 'entities/openai.md' };
const RES_UNSAFE = { ok: true, found: false, reason: 'unsafe', page: 'summaries/x.md', declaredSource: '../../etc/passwd' };
const RES_NOT_A_FILE = { ok: true, found: false, reason: 'not-a-file', page: 'summaries/x.md', declaredSource: 'a-folder' };

// ════════════════════════════════════════════════════════════════════════
section('1. formatSourceBytes()');
{
  eq(formatSourceBytes(0), '0 B', 'zero bytes');
  eq(formatSourceBytes(512), '512 B', 'sub-KB stays in bytes');
  eq(formatSourceBytes(1024), '1.0 KB', 'exactly 1 KB');
  eq(formatSourceBytes(22179), '21.7 KB', 'a real .md source size');
  eq(formatSourceBytes(2516582), '2.4 MB', 'a real PDF size');
  eq(formatSourceBytes(-1), '', 'negative -> empty (never a bar reading "-1 B")');
  eq(formatSourceBytes(NaN), '', 'NaN -> empty');
  eq(formatSourceBytes(Infinity), '', 'Infinity -> empty');
  eq(formatSourceBytes('2000'), '', 'a numeric STRING is not a number -> empty');
  eq(formatSourceBytes(undefined), '', 'undefined -> empty');
  eq(formatSourceBytes(null), '', 'null -> empty');
}

// ════════════════════════════════════════════════════════════════════════
section('2. describeRawSource() — all four display states, from real response shapes');
{
  const f = describeRawSource(RES_FOUND);
  eq(f && f.state, 'found', 'STATE 1/4 found: classified');
  eq(f && f.filename, 'Quarterly Report (final).pdf', 'found carries the filename VERBATIM from frontmatter (the slug is lossy and must never be reversed)');
  eq(f && f.sizeText, '2.4 MB', 'found carries a human size');

  const m = describeRawSource(RES_MISSING);
  eq(m && m.state, 'missing', 'STATE 2/4 missing: classified');
  ok(m && /isn’t on this machine/.test(m.text), 'missing copy says the file is not HERE');
  ok(m && /aren’t synced/.test(m.text), 'missing copy names the REASON (raw/ is gitignored and never syncs) — this is the NORMAL case after a Sync pull, not corruption');
  ok(m && !/error|corrupt|damaged|broken|fail/i.test(m.text), 'missing copy contains no damage vocabulary');
  ok(m && m.text.includes('Quarterly Report (final).pdf'), 'missing names the file it is talking about');

  const mNoName = describeRawSource({ found: false, reason: 'missing' });
  eq(mNoName && mNoName.state, 'missing', 'missing with no declaredSource still classifies');
  ok(mNoName && !/undefined|null/.test(mNoName.text), 'missing with no declaredSource never renders the string "undefined"');

  const x = describeRawSource(RES_EXTERNAL);
  eq(x && x.state, 'external', 'STATE 3/4 external-source: classified');
  eq(x && x.url, 'https://medium.com/@talirezun', 'external carries the declared URL as data');

  const xFallback = describeRawSource({ found: false, reason: 'external-source', declaredSource: 'http://example.com/a' });
  eq(xFallback && xFallback.url, 'http://example.com/a', 'external falls back to declaredSource when `url` is absent');
  eq(describeRawSource({ found: false, reason: 'external-source' }), null, 'external with NO url at all -> null (never an empty bar)');

  const n = describeRawSource(RES_NO_SOURCE);
  eq(n && n.state, 'no-source', 'STATE 4/4 no-source-recorded: classified DISTINCTLY (not silently fallen through)');

  eq(describeRawSource(RES_NOT_A_SUMMARY), null, "'not-a-summary' -> null (entities/concepts never show a bar)");
  const u = describeRawSource(RES_UNSAFE);
  eq(u && u.state, 'unsafe', "'unsafe' -> its own state");
  eq(describeRawSource(RES_NOT_A_FILE).state, 'unsafe', "'not-a-file' -> the same unopenable state");

  eq(describeRawSource({ found: false, reason: 'some-future-reason-v4' }), null,
    'an UNKNOWN reason degrades to null — a confidently-wrong bar is worse than no bar');
  eq(describeRawSource(null), null, 'null response -> null');
  eq(describeRawSource(undefined), null, 'undefined response -> null');
  eq(describeRawSource('found'), null, 'a STRING response -> null');
  eq(describeRawSource([]), null, 'an ARRAY response -> null');
  eq(describeRawSource({ found: 'true' }), null, "found must be BOOLEAN true — the string 'true' is not found");
}

// ════════════════════════════════════════════════════════════════════════
section('3. renderReaderSourceHtml() — state -> markup, and markup -> absence');
{
  const found = renderReaderSourceHtml(describeRawSource(RES_FOUND));
  ok(found.includes('>RAW<'), 'found is labelled RAW — the real folder name, so the bar cannot be mistaken for the page being read (v3.5.1)');
  ok(found.includes('Quarterly Report (final).pdf'), 'found shows the filename');
  ok(found.includes('2.4 MB'), 'found shows the size');
  ok(found.includes('id="reader-source-reveal"'), 'found offers a Reveal action');
  ok(found.includes('Reveal in Finder'), 'the Reveal action is labelled for Finder');

  const foundNoSize = renderReaderSourceHtml({ state: 'found', filename: 'a.pdf', sizeText: '' });
  ok(!foundNoSize.includes('reader-source-size'), 'an unknown size renders NO size element rather than an empty one');
  ok(foundNoSize.includes('a.pdf'), '…while still showing the filename');

  const missing = renderReaderSourceHtml(describeRawSource(RES_MISSING));
  ok(missing.includes('>RAW<'), 'missing is labelled RAW too');
  ok(!missing.includes('reader-source-reveal'), 'missing offers NO Reveal button — there is nothing on this machine to reveal');

  const noSource = renderReaderSourceHtml(describeRawSource(RES_NO_SOURCE));
  eq(noSource, '', 'no-source renders NOTHING (recognised, and deliberately silent)');
  eq(renderReaderSourceHtml(null), '', 'null renders nothing');
  eq(renderReaderSourceHtml(undefined), '', 'undefined renders nothing');
  eq(renderReaderSourceHtml({ state: 'not-a-state-we-know' }), '', 'an unknown state renders nothing');

  const unsafe = renderReaderSourceHtml(describeRawSource(RES_UNSAFE));
  ok(unsafe.includes('can’t be opened'), 'unsafe says the recorded source cannot be opened');
  ok(!unsafe.includes('reader-source-reveal'), 'unsafe offers no Reveal button');
}

// ════════════════════════════════════════════════════════════════════════
section('4. THE EXTERNAL URL IS INERT — never a link, never fetched');
//
// frontmatter.source is LLM-authored, hand-editable in Obsidian, and
// arrives over Personal Sync and Shared Brain mirrors from other people's
// machines. v3.5.0 classifies a URL as 'external-source' and asserts NO
// HTTP CLIENT EXISTS for it in either module. Making it an <a href> hands
// a remote author a click-through inside the user's app; fetching it to
// preview would make it an SSRF primitive outright.
{
  const cases = [
    ['an ordinary https URL', 'https://medium.com/@talirezun'],
    ['a javascript: URL', 'javascript:alert(document.cookie)'],
    ['an attribute-breakout attempt', 'https://x.example/"><a href="https://evil.example">click</a>'],
    ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
  ];
  for (const [label, url] of cases) {
    const info = describeRawSource({ found: false, reason: 'external-source', url });
    eq(info && info.state, 'external', `${label}: classified external`);
    const html = renderReaderSourceHtml(info);

    // NON-VACUITY FIRST: an implementation that returned '' would pass
    // every absence check below for free.
    ok(html.length > 0, `${label}: renders something (non-vacuity guard for the checks below)`);
    ok(html.includes('reader-source-url'), `${label}: rendered through the inert-text element`);

    ok(!/<a[\s>]/i.test(html), `${label}: NO <a> element`);
    ok(!ATTR_IN_TAG.test(html), `${label}: NO href/src/event-handler attribute in any tag`);
    ok(!/<script/i.test(html), `${label}: NO <script>`);
    ok(!/<iframe/i.test(html), `${label}: NO <iframe>`);
    eq(disallowedTags(html).join(','), '', `${label}: emits only <span> (allow-list, so nothing new slips in)`);

    // The URL must survive as READABLE, ESCAPED text — the user still has
    // to be able to see where the summary came from.
    const escaped = pure.escapeHtml(url);
    ok(html.includes(escaped), `${label}: the URL is present as escaped text`);
    if (/[<>"']/.test(url)) {
      ok(!html.includes(url), `${label}: the RAW (unescaped) URL is NOT in the output`);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
section('5. No HTTP client for the source VALUE');
{
  const pureSrc = PURE_FNS.slice(1).map((n) => extractFunction(appCode, n)).join('\n');
  ok(pureSrc.length > 400, 'sanity: the pure functions were extracted from the COMMENT-STRIPPED source (a truncated extract would pass the absence checks vacuously)');
  for (const sink of ['fetch(', 'XMLHttpRequest', 'window.open', 'location.href', 'location.assign', 'navigator.sendBeacon', 'new Image', 'import(']) {
    ok(!pureSrc.includes(sink), `the classify/render functions contain no ${sink} — the source value never reaches a network sink`);
  }

  // Behavioural counterpart: drive a REAL external-source page all the way
  // through loadReaderSource and prove the only request made is to our own
  // endpoint. This cannot pass vacuously — the first assertion requires a
  // request to have happened at all.
  const doc = makeDoc(['reader-source-bar']);
  const fetchStub = makeFetch(() => jsonRes(200, RES_EXTERNAL));
  const s = sandbox(doc, fetchStub, () => true);
  await s.loadReaderSource('articles', 'summaries/post.md', 1);
  eq(fetchStub.calls.length, 1, 'exactly ONE request was made for an external-source page');
  ok(fetchStub.calls[0].url.startsWith('/api/wiki/articles/source?path='),
    `the one request goes to our own /source endpoint (got ${fetchStub.calls[0].url})`);
  ok(!fetchStub.calls.some((c) => c.url.includes('medium.com')),
    'the DECLARED URL was never requested — classification only, never a fetch (SSRF primitive avoided)');
  ok(doc.els['reader-source-bar'].innerHTML.includes('medium.com'),
    '…and it was still SHOWN to the user, as text');
}
// ════════════════════════════════════════════════════════════════════════
section('6. Escaping of hostile untrusted values');
{
  const HOSTILE = '"><img src=x onerror=alert(1)>';
  const foundHtml = renderReaderSourceHtml(describeRawSource({ found: true, filename: HOSTILE, bytes: 10 }));
  ok(foundHtml.length > 0, 'sanity: a hostile filename still renders a bar (non-vacuity)');
  ok(!foundHtml.includes(HOSTILE), 'a hostile FILENAME is not present raw');
  ok(!/<img/i.test(foundHtml), 'a hostile filename cannot inject an <img>');
  ok(!ATTR_IN_TAG.test(foundHtml), 'a hostile filename cannot inject an event-handler attribute');
  eq(disallowedTags(foundHtml).join(','), '', 'a hostile filename cannot introduce any element beyond <span>/<button>');
  ok(foundHtml.includes('&quot;&gt;&lt;img'), 'a hostile filename is HTML-escaped, not stripped (the user still sees what was recorded)');

  const missHtml = renderReaderSourceHtml(describeRawSource({ found: false, reason: 'missing', declaredSource: HOSTILE }));
  ok(!missHtml.includes(HOSTILE), 'a hostile DECLARED SOURCE is not present raw in the missing copy');
  ok(!/<img/i.test(missHtml), 'a hostile declared source cannot inject an <img> through the missing copy');
  ok(!ATTR_IN_TAG.test(missHtml), 'a hostile declared source cannot inject an attribute through the missing copy');

  const sizeHtml = renderReaderSourceHtml({ state: 'found', filename: 'a.pdf', sizeText: HOSTILE });
  ok(!sizeHtml.includes(HOSTILE), 'even the size slot is escaped');
}

// ════════════════════════════════════════════════════════════════════════
section('7. THE CLASS GUARD — the reader actually CONSUMES frontmatter.source');
//
// This is the assertion that exists because the defect was silence: the
// reader fetched page.frontmatter, read .tags, and discarded .source.
// Nothing failed; the feature was simply gone. GET /api/wiki/:domain/source
// is the ONLY consumer of frontmatter.source in the app, so "the reader
// issues that request" is what proves the field is still read.
{
  // 7.1 — behavioural: a summary page triggers the request.
  const doc = makeDoc(['reader-source-bar']);
  const f = makeFetch(() => jsonRes(200, RES_FOUND));
  const s = sandbox(doc, f, () => true);
  await s.loadReaderSource('articles', 'summaries/report.md', 3);
  eq(f.calls.length, 1, 'opening a SUMMARY page issues the source request — frontmatter.source is consumed, not discarded');
  eq(f.calls[0].url, '/api/wiki/articles/source?path=summaries%2Freport.md',
    'the request carries the domain and the page path, both URL-encoded');
  eq(doc.els['reader-source-bar'].hidden, false, 'the bar is revealed for a found source');
  ok(doc.els['reader-source-bar'].innerHTML.includes('Quarterly Report (final).pdf'), 'the bar shows the resolved filename');

  // 7.2 — the bar node itself lives in the SHELL reader, so every entry
  //       point inherits it.
  const rr = extractFunction(appCode, 'renderReader');
  ok(rr.length > 500, 'sanity: renderReader() extracted from stripped source');
  ok(rr.includes('id="reader-source-bar"'), 'renderReader() emits the #reader-source-bar node — the bar is shell-owned, not per-view');
  ok(rr.includes('loadReaderSource('), 'renderReader() calls loadReaderSource() — without this the node is inert and the field is dead data again');
  ok(/if\s*\(!p\.loading\s*&&\s*!p\.error\)\s*loadReaderSource\(/.test(rr),
    'the call is gated ONLY on "not loading / not error" — no view-specific condition can opt out of it');
  ok(rr.indexOf('loadReaderSource(') > rr.indexOf('root.innerHTML'),
    'loadReaderSource() runs AFTER the overlay is painted, so #reader-source-bar exists when the response lands');

  // 7.3 — the source bar is not duplicated into a view.
  for (const [label, src] of [['views/domains.js', domainsCode], ['views/chat.js', stripComments(chatJs)]]) {
    ok(!src.includes('/source?path='), `${label} does not fetch the source endpoint itself (one implementation, in the shell)`);
    ok(!src.includes('describeRawSource'), `${label} carries no copy of the classifier`);
  }

  // 7.4 — the one fact a view must contribute.
  const owp = extractFunction(domainsCode, 'openWikiPageFromBrowse');
  ok(/domain:\s*slug/.test(owp), 'views/domains.js hands the reader `domain` — the only fact the shell cannot derive');
  ok(owp.indexOf('const slug = state.activeSlug') < owp.indexOf('await'),
    'that domain is captured BY VALUE before the await, so a domain switch mid-fetch cannot mislabel the bar');

  // 7.5 — an entry point that supplies nothing degrades to silence, never
  //       to a wrong-domain request.
  const doc2 = makeDoc(['reader-source-bar']);
  const f2 = makeFetch(() => { throw new Error('must not fetch'); });
  const s2 = sandbox(doc2, f2, () => true);
  await s2.loadReaderSource(undefined, 'summaries/report.md', 1);
  eq(f2.calls.length, 0, 'no domain -> NO request at all (degraded, never a guess at the wrong domain)');
  eq(doc2.els['reader-source-bar'].hidden, true, 'no domain -> the bar stays hidden');

  // 7.6 — REPORTED, NOT FIXED. chat.js is owned by another agent this
  //       round. Pinning the fact here makes the gap visible instead of
  //       silent, and this assertion is expected to be UPDATED (not
  //       deleted) when that one line lands.
  const chatPaint = extractFunction(stripComments(chatJs), 'paintReaderPage');
  const chatPassesDomain = /domain:\s*state\.activeDomain/.test(chatPaint);
  ok(true, chatPassesDomain
    ? 'views/chat.js DOES pass `domain` — citation-chip readers show the RAW bar'
    : 'KNOWN GAP (reported, not fixed): views/chat.js does not pass `domain`, so a citation-chip reader shows no RAW bar. One line in paintReaderPage(); that file is owned elsewhere this round.');
}

// ════════════════════════════════════════════════════════════════════════
section('8. loadReaderSource() — request discipline');
{
  // Only summaries can record a source; everything else must cost nothing.
  for (const p of ['entities/openai.md', 'concepts/rag.md', 'index.md', '', null, undefined, 42]) {
    const f = makeFetch(() => { throw new Error('must not fetch'); });
    const s = sandbox(makeDoc(['reader-source-bar']), f, () => true);
    await s.loadReaderSource('articles', p, 1);
    eq(f.calls.length, 0, `a non-summary path (${JSON.stringify(p)}) issues no request`);
  }

  // A superseded open must not paint into the newer page's bar.
  const doc = makeDoc(['reader-source-bar']);
  const s3 = sandbox(doc, makeFetch(() => jsonRes(200, RES_FOUND)), () => false);
  await s3.loadReaderSource('articles', 'summaries/report.md', 99);
  eq(doc.els['reader-source-bar'].innerHTML, '', 'a reader closed/repainted since the request started does NOT get painted into');
  eq(doc.els['reader-source-bar'].hidden, true, '…and the bar stays hidden');

  // Two rapid opens where the STALE one resolves LAST. This is the shape
  // that actually exercises the sequence guard: both share one #reader-
  // source-bar node, so a last-write-wins test proves nothing — the
  // superseded response has to land AFTER the current one and be refused.
  // Concretely: click a backlink while the first page's source request is
  // still in flight, and without the guard the bar ends up naming the
  // PREVIOUS page's original document under the new page's title.
  //
  // `isCurrentReader` is stubbed true throughout so the epoch guard cannot
  // mask this — the sequence guard is the only thing under test here.
  const doc4 = makeDoc(['reader-source-bar']);
  let releaseStale;
  const stalePending = new Promise((r) => { releaseStale = r; });
  const s4 = sandbox(doc4, makeFetch(async (url) => {
    if (url.includes('first.md')) {
      await stalePending;
      return jsonRes(200, { ok: true, found: true, page: 'summaries/first.md', filename: 'STALE-first.pdf', bytes: 10 });
    }
    return jsonRes(200, { ok: true, found: true, page: 'summaries/second.md', filename: 'CURRENT-second.pdf', bytes: 20 });
  }), () => true);
  const stale = s4.loadReaderSource('articles', 'summaries/first.md', 1);
  const current = s4.loadReaderSource('articles', 'summaries/second.md', 1);
  await current;
  ok(doc4.els['reader-source-bar'].innerHTML.includes('CURRENT-second.pdf'),
    'sanity: the CURRENT open painted the bar (non-vacuity for the guard below)');
  releaseStale();
  await stale;
  ok(doc4.els['reader-source-bar'].innerHTML.includes('CURRENT-second.pdf'),
    'a superseded response landing LAST does not clobber the current page — the bar still names the current page\'s source');
  ok(!doc4.els['reader-source-bar'].innerHTML.includes('STALE-first.pdf'),
    '…and the previous page\'s original document is nowhere in it');

  // no-source clears the bar rather than leaving a stale one on screen.
  const doc5 = makeDoc(['reader-source-bar']);
  const s5 = sandbox(doc5, makeFetch(() => jsonRes(200, RES_NO_SOURCE)), () => true);
  doc5.els['reader-source-bar'].innerHTML = '<span>stale</span>';
  doc5.els['reader-source-bar'].hidden = false;
  await s5.loadReaderSource('articles', 'summaries/chat.md', 1);
  eq(doc5.els['reader-source-bar'].innerHTML, '', 'a no-source page CLEARS any stale bar content');
  eq(doc5.els['reader-source-bar'].hidden, true, '…and re-hides the bar');

  // Transport and route failures are silent — the page underneath is fine.
  for (const [label, responder] of [
    ['a network throw', () => { throw new Error('offline'); }],
    ['a 500', () => jsonRes(500, { error: 'boom' })],
    ['a body with ok:false', () => jsonRes(200, { ok: false, error: 'nope' })],
    ['unparseable JSON', () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })],
  ]) {
    const d = makeDoc(['reader-source-bar']);
    const s = sandbox(d, makeFetch(responder), () => true);
    let threw = false;
    try { await s.loadReaderSource('articles', 'summaries/report.md', 1); } catch { threw = true; }
    ok(!threw, `${label} does not throw out of loadReaderSource`);
    eq(d.els['reader-source-bar'].hidden, true, `${label} leaves the bar hidden (no error banner over readable content)`);
  }

  // The real module-level sequence counter still exists — the sandbox
  // declares its own, so this is what stops that stand-in masking removal.
  ok(/^let readerSourceSeq = 0;$/m.test(appCode), 'app.js still declares the module-level readerSourceSeq the sequence guard depends on');
}

// ════════════════════════════════════════════════════════════════════════
section('9. revealReaderSource() — macOS only, honestly');
{
  // Success.
  const doc = makeDoc(['reader-source-status']);
  const btn = makeEl('btn');
  const f = makeFetch(() => jsonRes(200, { ok: true, filename: 'a.pdf' }));
  const s = sandbox(doc, f, () => true);
  await s.revealReaderSource('articles', 'summaries/report.md', btn);
  eq(f.calls.length, 1, 'reveal issues exactly one request');
  eq(f.calls[0].init.method, 'POST', 'reveal is a POST — so the server cross-origin guard applies to a desktop side effect');
  eq(f.calls[0].url, '/api/wiki/articles/source/reveal', 'reveal posts to the reveal route');
  eq(JSON.parse(f.calls[0].init.body).path, 'summaries/report.md',
    'the body carries a WIKI PAGE PATH — never a filesystem path; the absolute path is derived server-side');
  eq(doc.els['reader-source-status'].textContent, 'Revealed in Finder', 'success is confirmed in the bar');
  ok(doc.els['reader-source-status'].className.includes('is-ok'), 'success is styled as success');
  eq(btn.disabled, false, 'the button is re-enabled after a successful reveal');

  // macOS-only: HTTP 501.
  const doc2 = makeDoc(['reader-source-status']);
  const btn2 = makeEl('btn');
  const s2 = sandbox(doc2, makeFetch(() => jsonRes(501, {
    ok: false,
    error: 'Revealing a file in the file manager is only supported on macOS. Open your domain\'s raw/ folder manually to find the original.',
  })), () => true);
  await s2.revealReaderSource('articles', 'summaries/report.md', btn2);
  ok(/only supported on macOS/.test(doc2.els['reader-source-status'].textContent),
    "a 501 shows the route's OWN macOS-only message, verbatim");
  ok(/raw\/ folder manually/.test(doc2.els['reader-source-status'].textContent),
    '…including the alternative it offers (open raw/ yourself)');
  eq(btn2.isConnected, false, 'the Reveal button is REMOVED on 501 — it can never work on this machine, so leaving a button that only errors is dishonest');

  // Route-level failure (e.g. the resolver refused).
  const doc3 = makeDoc(['reader-source-status']);
  const btn3 = makeEl('btn');
  const s3 = sandbox(doc3, makeFetch(() => jsonRes(404, { ok: false, reason: 'missing', error: 'not in raw/' })), () => true);
  await s3.revealReaderSource('articles', 'summaries/report.md', btn3);
  ok(doc3.els['reader-source-status'].className.includes('is-error'), 'a route refusal is shown as an error');
  ok(doc3.els['reader-source-status'].textContent.length > 0, '…with the reason, not silently');
  eq(btn3.isConnected, true, 'a recoverable failure LEAVES the button so the user can retry');
  eq(btn3.disabled, false, '…re-enabled');

  // Transport failure.
  const doc4 = makeDoc(['reader-source-status']);
  const btn4 = makeEl('btn');
  const s4 = sandbox(doc4, makeFetch(() => { throw new Error('offline'); }), () => true);
  let threw = false;
  try { await s4.revealReaderSource('articles', 'summaries/report.md', btn4); } catch { threw = true; }
  ok(!threw, 'a transport failure does not throw out of revealReaderSource');
  ok(doc4.els['reader-source-status'].className.includes('is-error'), '…it is reported in the bar');
  eq(btn4.disabled, false, '…and the button is re-enabled');

  // The route is macOS-only at the source, which is what makes the 501
  // branch reachable rather than theoretical.
  const routeSrc = readFileSync(path.join(ROOT, 'src/routes/wiki.js'), 'utf8');
  ok(/process\.platform !== 'darwin'/.test(routeSrc) && /501/.test(routeSrc),
    'src/routes/wiki.js really does answer 501 off macOS (the branch above is not hypothetical)');
}

// ════════════════════════════════════════════════════════════════════════
section('10. CSS — prefix ownership, tokens, theming');
{
  const emitted = new Set();
  for (const fn of ['renderReaderSourceHtml', 'revealReaderSource']) {
    for (const m of extractFunction(appCode, fn).matchAll(/reader-source-[a-z-]+/g)) emitted.add(m[0]);
  }
  for (const m of extractFunction(appCode, 'renderReader').matchAll(/reader-source-[a-z-]+/g)) emitted.add(m[0]);
  ok(emitted.size >= 6, `sanity: found ${emitted.size} .reader-source-* class names emitted by the JS`);
  for (const cls of emitted) {
    ok(cssCode.includes('.' + cls), `.${cls} is defined in CSS (an undefined class is invisible styling, not an error)`);
  }

  ok(!/prefers-color-scheme/.test(cssCode), 'no prefers-color-scheme in the CSS — /next themes via [data-theme] only (checked against comment-stripped source, since the file explains WHY it has none)');
  const barBlock = cssCode.slice(cssCode.indexOf('.reader-source-bar {'));
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(barBlock), 'the source-bar rules use tokens only, no hardcoded hex colours');
  ok(/var\(--surface-sunken\)/.test(barBlock) || /var\(--surface-raised\)/.test(barBlock), 'the bar sits on a token surface');

  // The inert URL must not LOOK clickable either.
  const urlRule = cssCode.slice(cssCode.indexOf('.reader-source-url {'), cssCode.indexOf('.reader-source-url {') + 400);
  ok(/text-decoration:\s*none/.test(urlRule), '.reader-source-url is not underlined — it is not a link and must not imply one');
  ok(/cursor:\s*default/.test(urlRule), '.reader-source-url uses the default cursor, not a pointer');

  // Nothing else in /next may claim this prefix.
  const shellCss = readFileSync(path.join(ROOT, 'src/public/next/shell.css'), 'utf8');
  ok(!shellCss.includes('.reader-source-'), 'shell.css carries no competing .reader-source-* rules (single owner)');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
