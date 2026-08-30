/**
 * test-next-ingest-view.js — OFFLINE guards for the /next Ingest view's
 * presentation layer: the destination sidebar, the drop zone, and the
 * domain <select>'s CSS-drawn chevron.
 *
 * ── What this suite is FOR ──────────────────────────────────────────────
 * The Ingest redesign changed three things that can each regress silently:
 *
 *   1. There are now TWO controls that pick the destination domain — the
 *      in-form <select> and the sidebar's destination rows. Two controls
 *      writing one value is this repo's named drift shape (v3.2.0's
 *      CRITICAL came from two hand-maintained copies of one guard). The
 *      structural answer is that `state.domain` has exactly ONE writer,
 *      `selectDomain`, which also carries the re-estimate-at-the-confirm-
 *      gate behaviour ported from src/public/app.js. §2 pins that; if a
 *      future edit assigns state.domain from a second site, it goes red.
 *
 *   2. The sidebar gained a "Choose files" button that reaches into the
 *      MAIN column for the hidden <input type="file">. That input is not
 *      always present, and it is rendered `disabled` while a single-file
 *      ingest is in flight — and .click() on a disabled input is a native
 *      NO-OP. A button that looks live and does nothing is worse than a
 *      disabled one. §3 EXECUTES the real predicate across every state.
 *
 *   3. The drop zone announces `role="button" tabindex="0"`. A focusable
 *      element that says "button" and then ignores Enter/Space puts a
 *      keyboard user in a stop with no exit. §4 pins the keys.
 *
 * ── Method ──────────────────────────────────────────────────────────────
 * Same two patterns the rest of this repo's frontend suites use (see
 * scripts/test-ingest-queue-frontend.js's own header): pure functions are
 * EXTRACTED BY NAME from the real source text and EXECUTED in a plain Node
 * sandbox, so they run against the current file rather than a copy; the
 * DOM-coupled builders are covered by source-level guards.
 *
 * ── The failure shape this suite must not have ──────────────────────────
 * A guard that stops reaching the thing it protects (test-frontend-null-
 * safety.js's lexer desync; check-doc-suite-counts.js's own header). So
 * §0 is a POSITIVE CONTROL that runs FIRST and FAILS LOUDLY if any
 * function it needs could not be extracted, rather than letting later
 * sections quietly compare `undefined` and pass.
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────
 *   - Nothing here renders. Contrast, layout and the absence of horizontal
 *     overflow were measured in a real browser at 1280px in both themes
 *     and are NOT re-asserted offline: a computed colour is not derivable
 *     in Node, and a hand-rolled cascade resolver adjudicating a
 *     cross-file cascade is precisely the decorative-guard shape this repo
 *     keeps hitting.
 *   - The source guards are TEXT scans. A rule moved into another
 *     stylesheet, or a listener attached via a computed event name, is
 *     invisible to them. They fail in the SAFE direction (a false red),
 *     never by silently permitting.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const JS_PATH = path.join(ROOT, 'src/public/next/views/ingest.js');
const CSS_PATH = path.join(ROOT, 'src/public/next/views/ingest.css');

const js = readFileSync(JS_PATH, 'utf8');
const css = readFileSync(CSS_PATH, 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

/** Extract `function NAME(...) { ... }` by brace-matching, ignoring braces
 *  inside strings, template literals and comments. Returns null when the
 *  function cannot be found — §0 turns that into a loud failure. */
function extractFunction(src, name) {
  const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index;
  // Walk the PARAMETER LIST first, by balancing parens. Taking the first
  // `{` after the name is wrong the moment a function destructures its
  // argument — `function f({ a, b }) {` would return `function f({ a, b }`,
  // a body that is non-null, ends in `}`, and contains none of the code the
  // assertions are about. That happened here on the first run: three
  // assertions went red against a function whose source was correct, and §0
  // reported a clean extraction. §0 now also checks the SHAPE of what came
  // back (see below) so a truncation cannot pass as a success again.
  let p = src.indexOf('(', start);
  if (p < 0) return null;
  let pd = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') pd++;
    else if (src[p] === ')') { pd--; if (pd === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i < 0) return null;
  let depth = 0;
  let inS = null;      // "'", '"', '`'
  let inLine = false;
  let inBlock = false;
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** The enclosing `function NAME(...) { ... }` body that CONTAINS a given
 *  character offset, or null. Used to answer "which function performs this
 *  assignment", which is what the single-writer invariant is really about. */
function enclosingFunctionName(src, offset) {
  const re = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  let best = null;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > offset) break;
    const body = extractFunction(src, m[1]);
    if (!body) continue;
    if (m.index <= offset && offset < m.index + body.length) best = m[1];
  }
  return best;
}

// ── §0 — POSITIVE CONTROL: the extractor still reaches its targets ───────
console.log('\n§ 0  Positive control — the extractor reaches its targets');

const NEEDED = ['formatDestinationMeta', 'isFilePickerAvailable', 'selectDomain', 'renderSidebar', 'renderDropZoneHtml', 'loadDomains',
  // The ONE builder both domain pickers render from (see §9).
  'domainListboxCfg',
  // The ONE fetch+parse both the initial load and every revalidation use, and
  // the revalidation itself (§7/§8/§12).
  'fetchDomainStats', 'refreshDomainStats'];
const bodies = {};
for (const name of NEEDED) {
  const body = extractFunction(js, name);
  bodies[name] = body;
  // Not merely "non-null": a TRUNCATED extraction is also non-null. A real
  // top-level function body ends with a `}` sitting alone at column 0, and
  // spans more than one line. Both are cheap and both fail on the
  // destructured-parameter truncation this control missed the first time.
  const wellFormed = !!body && /\n\}$/.test(body) && body.split('\n').length > 2;
  bodies[name] = wellFormed ? body : null;
  ok(wellFormed, 'extracted a WELL-FORMED body for ' + name + '() from the real source');
}
if (NEEDED.some((n) => !bodies[n])) {
  console.log('\n❌ FATAL: one or more functions could not be extracted from ' +
    'views/ingest.js. This suite cannot check anything in that state — it is ' +
    'failing loudly rather than reporting a green run over zero comparisons.');
  process.exit(1);
}
// Prove the extractor is not returning something trivially true for a name
// that does not exist — otherwise "found it" means nothing.
ok(extractFunction(js, 'thisFunctionDoesNotExistAnywhere') === null,
  'control: extractor returns null for a function that does not exist');

// ── §1 — the destination meta line: real data, never fabricated ──────────
console.log('\n§ 1  Destination meta — renders the data it has, invents nothing');

const sandbox = new Function(
  'return (() => { ' + bodies.formatDestinationMeta + ' return { formatDestinationMeta }; })()'
)();
const meta = sandbox.formatDestinationMeta;

ok(meta({ pageCount: 12, lastIngestDate: '2026-08-27' }) === '12 pages · last write 2026-08-27',
  'full data renders both facts');
ok(meta({ pageCount: 1, lastIngestDate: '2026-01-02' }) === '1 page · last write 2026-01-02',
  'singular "1 page", not "1 pages"');
ok(meta({ pageCount: 0, lastIngestDate: null }) === '0 pages · nothing written yet',
  'a genuine zero renders as zero (0 is a MEASUREMENT here, not an absence)');
ok(meta({ pageCount: null, lastIngestDate: null }) === 'page count unknown · nothing written yet',
  'an ABSENT page count says so — it is never collapsed into "0 pages"');
ok(meta({ pageCount: 4, lastIngestDate: null }) === '4 pages · nothing written yet',
  'an absent date says so — no date is ever fabricated');
ok(!/last ingest/i.test(meta({ pageCount: 4, lastIngestDate: '2026-05-01' })),
  'says "last write", NOT "last ingest": appendLog is called by conversation ' +
  'COMPILE as well as by ingest, so lastIngestDate is the last LOG entry and ' +
  '"last ingest" would be a false statement on a compile-only domain');

// ── §2 — state.domain has exactly ONE writer ────────────────────────────
console.log('\n§ 2  Two destination controls, ONE writer (the anti-drift invariant)');

// ── THE SCAN RUNS OVER CODE, NOT PROSE ──────────────────────────────────
// MEASURED: this scan used to run over the RAW file, so a DOCBLOCK that
// merely quotes `state.domain = list[0].slug` while explaining why a
// refresh path must NOT do that registered as a rogue writer at module
// scope. Root cause 1 from scripts/test-helpers/source-scan.js, arriving
// through the other door: not a comment SATISFYING a scan, a comment
// POLLUTING one. It fails loudly here, but the same blindness would let a
// commented-out assignment mask a real one in the attribution, so the scan
// is repointed at code. `jsCode` is asserted sane below before use.
const jsCode = (() => {
  const stripped = js
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  // Tripwire: over-stripping would silently shrink the population this scan
  // classifies, and an empty population passes every filter below.
  for (const needle of ['function selectDomain(slug)', 'function loadDomains(token)']) {
    if (!stripped.includes(needle)) throw new Error(`comment-strip over-reached: "${needle}" is gone`);
  }
  return stripped;
})();
const assignRe = /state\.domain\s*=/g;
const writers = [];
let am;
while ((am = assignRe.exec(jsCode)) !== null) {
  writers.push(enclosingFunctionName(jsCode, am.index) || '(module scope / unknown)');
}
// CONTROL: the strip did not simply delete the thing being counted.
ok(writers.length >= 4,
  `§2 CONTROL — the comment-stripped source still contains ${writers.length} real state.domain writes, so this scan is classifying a real population rather than an empty one`);
ok(writers.length > 0, 'found at least one state.domain assignment to classify');
// The allow-list, and why each entry is on it:
//   selectDomain            — the USER's choice; the only writer the two
//                             controls reach, which is the whole invariant.
//   loadDomains             — initial selection / clearing on a load error.
//   applyQueueJobSnapshot   — pre-existing. A live batch job's domain is
//   checkActiveQueueJob       SERVER truth, and on a cross-mount reattach it
//                             must beat whatever this mount happened to have
//                             selected. Both are guarded on the domain
//                             actually being in this mount's own list.
// Anything else — a render function, an event handler, a fetch callback —
// is a SECOND user-facing writer and is exactly what this assertion exists
// to catch. Widening this list is a decision, not a fix; record the reason
// here the way these four are recorded.
//   refreshDomainStats      — NOT a user-facing selection. It writes
//                             state.domain in exactly one branch: the
//                             currently-selected destination has DISAPPEARED
//                             from the server's own list, so leaving it
//                             selected would point the Ingest button at a
//                             domain that no longer exists. It deliberately
//                             does NOT do what loadDomains does (snap to
//                             list[0] on every load) — doing that on a refresh
//                             would silently move the user's chosen
//                             destination out from under them right before
//                             they write to it, which is why refreshing could
//                             not simply re-call loadDomains.
//   adoptDestination        — v3.24.1, and the reason is recorded here
//                             because widening this list is a decision. It
//                             spends a mount's ONE destination adoption: on a
//                             fresh mount with no user choice made, if the
//                             server says an ingest is running on a domain
//                             other than the one loadDomains snapped to, the
//                             selection moves to it. That is batch-path
//                             parity — applyQueueJobSnapshot and
//                             checkActiveQueueJob already adopt a live job's
//                             domain, guarded on the same
//                             `state.domains.some(...)` membership test — and
//                             without it a single-file ingest into any domain
//                             but list[0] is invisible on return, which is the
//                             reported defect.
//                             It is on this list as a NAMED function rather
//                             than as `refreshActivity`, which is where its
//                             call site is: allow-listing the caller would
//                             wave through any future write anywhere in that
//                             function. §14 pins that it fires at most once
//                             per mount and never after a real choice.
const ALLOWED_WRITERS = new Set([
  'selectDomain', 'freshState', 'loadDomains', 'applyQueueJobSnapshot', 'checkActiveQueueJob',
  'refreshDomainStats', 'adoptDestination',
]);
const rogue = writers.filter((w) => !ALLOWED_WRITERS.has(w));
ok(rogue.length === 0,
  'every state.domain write is in an allow-listed function ' +
  '(found: ' + [...new Set(writers)].join(', ') +
  (rogue.length ? ' — ROGUE: ' + [...new Set(rogue)].join(', ') : '') + ')');
ok(writers.includes('selectDomain'), 'selectDomain is a writer of state.domain');

ok(/startQueueSelection\s*\(/.test(bodies.selectDomain),
  'selectDomain carries the confirm-gate re-estimate, so BOTH controls get it — ' +
  'a domain change means a different index size and therefore a different cost, ' +
  'whichever control the user reached for');
ok(/state\.queueModeActive\s*&&\s*!state\.queueJob/.test(bodies.selectDomain),
  're-estimate is gated on "at the confirm gate, no job yet" — the ported condition');

// The picker is the shared listbox now, and its onChange lives in the ONE
// cfg builder both surfaces render from — so this asserts on that builder
// rather than on a listener the wiring pass used to attach.
ok(/onChange:\s*\(value\)\s*=>\s*selectDomain\(value\)/.test(js),
  'the domain picker\'s onChange routes through selectDomain');
ok(/mountListbox\(domainListboxCfg\(\)\)/.test(js),
  'and the control is hydrated from the SAME builder the markup came from — ' +
  'not from a second cfg literal that could describe different options');
ok(/btn\.dataset\.destSlug/.test(bodies.renderSidebar) && /selectDomain\(/.test(bodies.renderSidebar),
  'the sidebar destination rows route through selectDomain too');

// ── §3 — the sidebar picker button is never a dead control ──────────────
console.log('\n§ 3  "Choose files" is disabled in every state where it would no-op');

const pickerSandbox = new Function('initialState', 'initialJobId', `
  let state = initialState;
  let queueJobId = initialJobId;
  ${bodies.isFilePickerAvailable}
  return isFilePickerAvailable();
`);
const baseState = {
  loadingDomains: false, domainsError: null, domains: [{ slug: 'a' }],
  queueJob: null, submitting: false,
};
const call = (patch, jobId = null) => pickerSandbox({ ...baseState, ...patch }, jobId);

ok(call({}) === true, 'available on the idle single-file form (the input is there and enabled)');
ok(call({ loadingDomains: true }) === false, 'NOT available while domains are still loading');
ok(call({ domainsError: 'boom' }) === false, 'NOT available on a domain-load error');
ok(call({ domains: [] }) === false, 'NOT available with zero domains (no form is rendered)');
ok(call({ queueJob: { jobId: 'j1' } }) === false, 'NOT available while a batch job panel is showing');
ok(call({}, 'j2') === false, 'NOT available in the post-start / pre-first-snapshot window');
ok(call({ submitting: true }) === false,
  'NOT available while a single-file ingest is in flight — renderDropZoneHtml ' +
  'passes disabled: state.submitting, and .click() on a DISABLED input is a ' +
  'native no-op, so leaving the button enabled makes it a dead control');

ok(/id="ing-sidebar-pick-btn"/.test(bodies.renderSidebar) &&
   /isFilePickerAvailable\(\)/.test(bodies.renderSidebar),
  'renderSidebar actually consults isFilePickerAvailable for the disabled attribute');

// ── §4 — the drop zone keeps the promise its role attribute makes ───────
console.log('\n§ 4  Drop zone — announces "button", answers a button\'s keys');

ok(/role="button"/.test(bodies.renderDropZoneHtml), 'drop zone carries role="button"');
ok(/tabindex="0"/.test(bodies.renderDropZoneHtml), 'drop zone is keyboard focusable');
ok(/aria-label=/.test(bodies.renderDropZoneHtml), 'drop zone carries an accessible name');

const wire = extractFunction(js, 'wireListeners');
ok(!!wire, 'extracted wireListeners()');
const keydown = /dropZone\.addEventListener\('keydown'[\s\S]*?\}\);/.exec(wire || '');
ok(!!keydown, 'a keydown listener is attached to the drop zone');
if (keydown) {
  ok(/'Enter'/.test(keydown[0]), 'Enter opens the file picker');
  ok(/' '/.test(keydown[0]) || /'Spacebar'/.test(keydown[0]), 'Space opens the file picker');
  ok(/preventDefault\(\)/.test(keydown[0]), 'Space is preventDefault\'d so the page does not scroll');
  ok(/fileInput\.click\(\)/.test(keydown[0]), 'the key handler reaches the real file input');
}

ok(/relatedTarget/.test(wire || '') && /dropZone\.contains\(/.test(wire || ''),
  'dragleave ignores a relatedTarget INSIDE the zone — the zone now has child ' +
  'elements, and without this the drag-over state strobes while the user is ' +
  'still holding the file over the target');
ok(/const setDragActive[\s\S]{0,200}state\.dragActive === next/.test(wire || ''),
  'dragover only re-renders when the flag actually CHANGES — dragover fires ' +
  'continuously, and render() replaces the element the pointer is over');

// ── §5 — the accepted-format copy cannot outrun the validator ───────────
console.log('\n§ 5  Accepted formats are rendered FROM the validator\'s own list');

ok(/ALLOWED_EXT[\s\S]{0,40}\.map\(/.test(bodies.renderDropZoneHtml),
  'the formats line is built from ALLOWED_EXT, not typed out — so it can never ' +
  'advertise a format pickSingleFile would then refuse');
ok(!/'\.pdf'\s*\+|Accepts \.txt/.test(bodies.renderDropZoneHtml),
  'no hardcoded extension list in the drop-zone copy');
ok(/2 or more files/.test(bodies.renderDropZoneHtml),
  'the batch rule is stated on the surface where it applies');

// ── §6 — destination rows are locked while a write owns the domain ──────
console.log('\n§ 6  Destination rows lock during a write');

ok(/rowsLocked\s*=\s*state\.submitting\s*\|\|\s*!!state\.queueJob\s*\|\|\s*!!queueJobId/.test(bodies.renderSidebar),
  'rows are locked by submitting OR a live job OR the pre-snapshot window');
ok(/rowsLocked \? ' disabled' : ''/.test(bodies.renderSidebar),
  'the lock is expressed as a real `disabled` attribute, not a CSS-only hint ' +
  '(a click on a disabled <button> never fires, so this is the guarantee)');

// ── §7 — the read-only mirror exclusion survives ────────────────────────
console.log('\n§ 7  Read-only Shared Brain mirrors stay out of the destination list');

// The filter MOVED into fetchDomainStats when the revalidation path landed —
// it is not gone. That is a strengthening, not a loosening: it used to live in
// the one function that loaded destinations, and now lives in the one function
// that FETCHES them, which both the initial load and every revalidation call.
// So the assertion follows it, and gains the property that actually protects
// the invariant: neither caller may grow a second parse.
ok(/readonlyDomains/.test(bodies.fetchDomainStats) && /!readonly\.has\(d\.slug\)/.test(bodies.fetchDomainStats),
  '§7 fetchDomainStats filters readonlyDomains out — ONE filter feeds the <select>, the sidebar list, and every revalidation, so a mirror cannot appear in any of them');
for (const caller of ['loadDomains', 'refreshDomainStats']) {
  ok(/fetchDomainStats\(/.test(bodies[caller]),
    `§7 ${caller} goes through fetchDomainStats rather than issuing its own request — a second copy of the parse is how the readonly filter would come back for one path and not the other`);
  ok(!/\/api\/domains\/stats/.test(bodies[caller]),
    `§7 …and ${caller} does NOT build that request itself`);
}

// ── §8 — the stats fields reach a consumer (the dead-data guard) ────────
console.log('\n§ 8  pageCount / lastIngestDate are parsed AND consumed');

ok(/pageCount:/.test(bodies.fetchDomainStats) && /lastIngestDate:/.test(bodies.fetchDomainStats),
  '§8 fetchDomainStats keeps pageCount and lastIngestDate off the wire (moved here with the fetch — see §7)');
ok(/formatDestinationMeta\(/.test(bodies.renderSidebar),
  'renderSidebar CONSUMES them — this repo\'s recurring defect is a producer ' +
  'doing honest work and the layer above throwing the answer away');
ok(/d\.pageCount/.test(bodies.formatDestinationMeta) && /d\.lastIngestDate/.test(bodies.formatDestinationMeta),
  'formatDestinationMeta reads both fields by name');

// ── §9 — the domain picker is the shared listbox ────────────────────────
console.log('\n§ 9  The domain picker is the shared listbox, not a native <select>');

// THE POINT OF THE CHANGE. `appearance: none` + a CSS chevron got the CLOSED
// control on-design and could never reach the OPEN list, which macOS paints
// outside the document. Both pickers in this view now use the component, so
// the open menu is ours too.
// Deliberately scanned over the WHOLE file, comments included. A comment
// asserting the opposite of its own code is this repo's most reliable
// early-warning shape (v3.13.1 found four in one release), and this view had
// one describing "the in-form <select>" after the select was gone.
ok(!/<select/.test(js),
  'this view contains NO <select> at all, in markup OR in a comment — an ' +
  'OS-drawn popup would be the exact defect this change exists to remove, ' +
  'and a comment still describing one sends the next reader looking for it');
const lbRenders = js.match(/renderListboxHtml\(domainListboxCfg\(/g) || [];
ok(lbRenders.length === 2,
  'both domain pickers (single-file form + batch confirm gate) render the ' +
  'component (' + lbRenders.length + ' found)');
ok(/function domainListboxCfg\(/.test(js),
  'from ONE cfg builder — the two surfaces previously carried two ' +
  'hand-written copies of the same <option> loop, which is this repo\'s ' +
  'most reliable failure shape waiting for one of them to be edited');
const cfgBody = bodies.domainListboxCfg || '';
ok(/state\.domains\.map/.test(cfgBody),
  'the builder CONSUMES state.domains rather than re-deriving the list — so ' +
  'the read-only Shared Brain mirror exclusion is decided in exactly one ' +
  'place upstream and this control cannot reintroduce a domain the loader dropped');
ok(!/shared-/.test(cfgBody),
  'and it carries no filtering of its own that could drift from that upstream rule');

// A REAL disabled state, not a CSS lookalike. This is the requirement a
// hand-rolled menu most often fails: several of these controls lock during a
// live write, and a div that merely looks unavailable still fires its handler.
ok(/disabled:\s*!!disabled/.test(cfgBody),
  'the cfg carries a real `disabled` flag');
const lbJs = readFileSync(path.join(ROOT, 'src/public/next/shared/listbox.js'), 'utf8');
ok(/\(disabled \? ' disabled' : ''\)/.test(lbJs),
  'and the component emits the native `disabled` ATTRIBUTE on a <button> — ' +
  'so the browser refuses the click and drops it from the tab order, rather ' +
  'than a style that leaves a live handler underneath');
ok(/if \(state\.trigger\.disabled\) return;/.test(lbJs),
  'with a second, independent refusal inside open() — belt to that\'s braces');

// ── .ing-select IS NOW A SINGLE-USER CLASS, AND THE TRAP IS SHARPER ──────
// It was shared between the <select>s and the batch confirm gate's budget
// field. The selects are gone; the <input type="number"> is the only user
// left, so an unqualified `appearance: none` on it would strip that input's
// spinner and there is no longer a <select> in this view to make adding one
// look reasonable.
ok(/class="ing-select ing-queue-budget-input"/.test(js),
  'the budget field still uses .ing-select');
ok((js.match(/class="[^"]*\bing-select\b/g) || []).length === 1,
  '.ing-select has exactly ONE user in this view now — the number input');
ok(!/\.ing-select\s*\{[^}]*appearance:/.test(css),
  'the .ing-select rule does NOT set appearance — it would strip the number ' +
  'input\'s spinner, and it is the only control that rule reaches');
ok(!/select\.ing-select/.test(css),
  'and the dead `select.ing-select` type-qualified rule is gone rather than ' +
  'left behind pinning a control that no longer exists');
ok(!/ing-select-wrap/.test(css) && !/ing-select-wrap/.test(js),
  'the chevron wrapper is gone from both the stylesheet and the markup — the ' +
  'component draws its indicator inside the trigger');

// The stylesheet must not quietly claim the old trade-off was free.
ok(/UNPAID|unpaid/.test(css),
  'ingest.css records what the switch away from <select> COSTS (the OS touch ' +
  'picker) rather than implying the trade was free');

// ── §10 — the drop zone is a substantial surface ────────────────────────
console.log('\n§ 10  The drop zone is sized like the primary input surface');

const zone = /\.ing-drop-zone\s*\{([\s\S]*?)\}/.exec(css);
ok(!!zone, '.ing-drop-zone rule exists');
if (zone) {
  const mh = /min-height:\s*(\d+)px/.exec(zone[1]);
  ok(!!mh && Number(mh[1]) >= 120,
    'min-height is at least 120px (measured 190px rendered) — the pre-redesign ' +
    'zone was a 28px-padded strip carrying one line of grey text');
  ok(/border-style|dashed/.test(zone[1]), 'idle state is dashed');
}
const active = /\.ing-drop-zone-active,[\s\S]*?\{([\s\S]*?)\}/.exec(css);
ok(!!active && /border-style:\s*solid/.test(active[1]),
  'drag-over switches the border to SOLID — a difference that does not depend ' +
  'on colour alone');
ok(/Release to add/.test(bodies.renderDropZoneHtml),
  'drag-over says what letting go will DO, not just that the zone is hot');
ok(!/animation:/.test(css),
  'no `animation` anywhere in this stylesheet — motion here is a state change ' +
  'via `transition`, which inherits the tokens\' reduced-motion behaviour ' +
  'instead of needing its own escape hatch (see test-next-reduced-motion.js)');

// ── §12 — the destination sidebar revalidates ───────────────────────────
console.log('\n§ 12  The destination sidebar is not frozen at mount time');

// THE DEFECT, MEASURED: the sidebar read "Business · 59 pages" while both disk
// and GET /api/domains/stats said 96. `loadDomains` had exactly ONE call site,
// in onEnter, so state.domains was written once per mount and never again — an
// ingest could not move the number sitting beside the button that started it.
//
// A CORRECTION WORTH KEEPING: this was reported as "the batch path refreshes,
// the single-file path does not". Reading the code, NEITHER did. The batch
// panel only looks right because its own summary renders from the job snapshot
// off the wire while the sidebar beside it is equally stale. Both paths are
// asserted below; pinning only the reported one would have left the same bug
// live one panel away.
{
  const runIngest = extractFunction(js, 'runIngest');
  const applySnap = extractFunction(js, 'applyQueueJobSnapshot');
  // The destination rows are bound in renderSidebar (it re-binds after its own
  // isCurrentMount re-check), not in wireListeners.
  const wire = extractFunction(js, 'renderSidebar');
  ok(!!runIngest && !!applySnap && !!wire, '§12 sanity: the three trigger sites extracted');

  // Code, not prose — §2's own lesson, applied here from the start.
  const code = (t) => (t || '').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  ok(/refreshDomainStats\(/.test(code(runIngest)),
    '§12 the SINGLE-FILE completion path revalidates the destination stats — the reported defect');
  ok(/busyDecision === 'exit'/.test(code(applySnap)) && /refreshDomainStats\(/.test(code(applySnap)),
    '§12 the BATCH path revalidates too, on the busy->terminal EDGE so it fires once per batch rather than on every progress frame');
  ok(/refreshDomainStats\(/.test(code(wire)),
    '§12 a destination-row click revalidates — memory.js\'s revalidate-on-an-action-the-user-already-took pattern, riding a re-render that happens anyway');

  const rds = bodies.refreshDomainStats;
  // A refresh must not be able to blank a populated sidebar…
  ok(/if \(got\.error\) return;/.test(code(rds)),
    '§12 a FAILED refresh is a no-op that keeps what is on screen — unlike the initial load, where an error IS the answer. Blanking a correct sidebar because one fetch failed would be worse than the staleness');
  // …and must not silently move the user's chosen destination.
  ok(!/state\.domain = .*list\[0\]\.slug/.test(code(rds)) || /some\(\(d\) => d\.slug === state\.domain\)/.test(code(rds)),
    '§12 it does NOT snap the selection to list[0] the way loadDomains does — only clears a destination the server no longer lists');
  // The no-op guard, and the recorded reason it must see the pane it protects.
  // MEASURED, by mutation, during this section's own verification: asserting
  // merely that `destinationsSignature()` APPEARS in the body stayed GREEN when
  // the comparison was deleted and `render(token)` made unconditional — the
  // `const before = destinationsSignature()` line alone satisfied it. Root
  // cause 3 from scripts/test-helpers/source-scan.js: a function executed but
  // its DECIDING SITE never asserted. What has to be pinned is the COMPARISON
  // gating the render, not the presence of the helper.
  ok(/if \(destinationsSignature\(\) !== before\) render\(/.test(code(rds)),
    '§12 the render is GATED on the signature changing — render() replaces both panes and re-binds every listener, so an unconditional repaint would churn a staged file and focus');
  // ORDER, not presence. MEASURED by mutation: asserting only that the line
  // EXISTS stayed green when it was moved BELOW `state.domains = got.list`,
  // which makes the two signatures identical by construction — the guard then
  // suppresses EVERY repaint and the sidebar is frozen again, i.e. the original
  // defect restored behind a green suite. Offsets are compared instead.
  {
    const iBefore = code(rds).indexOf('const before = destinationsSignature();');
    const iWrite = code(rds).indexOf('state.domains = got.list;');
    ok(iBefore >= 0 && iWrite >= 0 && iBefore < iWrite,
      `§12 …and that "before" is captured BEFORE state.domains is replaced (offsets ${iBefore} < ${iWrite}); taken after, the comparison is equal by construction and the guard suppresses every repaint — the staleness defect, restored`);
  }
  ok(/refreshingDomainStats/.test(code(rds)),
    '§12 …and it is re-entrancy-guarded, so a click during an in-flight refresh cannot stack fetches');
  ok(/formatDestinationMeta\(d\)/.test(code(extractFunction(js, 'destinationsSignature'))),
    '§12 the signature is built from the RENDERED row text, so anything that changes a row changes it — memory.js: "a no-op guard that cannot see a pane is not a guard for that pane"');

  // NOT A POLL — stated and enforced. memory.js needs a timer because an agent
  // over MCP writes while you watch; nothing but this app writes a page count.
  ok(!/setInterval\(|setTimeout\(/.test(code(rds)),
    '§12 the revalidation is event-driven, not polled — every trigger rides a moment the user caused');

  // CONTROL: these regexes can fail. Without this, a typo'd helper name would
  // make every assertion above vacuous in the same direction.
  ok(!/refreshDomainStats\(/.test(code(bodies.formatDestinationMeta)),
    '§12 CONTROL — the refresh scan does NOT match an unrelated function, so the greens above are locating a real call rather than matching anything');
  ok(/refreshDomainStats\(/.test(code(js)) && (code(js).match(/refreshDomainStats\(/g) || []).length >= 4,
    `§12 CONTROL — ${(code(js).match(/refreshDomainStats\(/g) || []).length} real call/definition sites exist in code (definition + three triggers)`);
}

// ── §13 — server-backed activity: the run survives navigating away ──────
//
// THE DEFECT, restated because it decides what is worth pinning. Start a
// single-file ingest, navigate away, come back: the view showed only the
// generic "Waiting on another write in this domain" note, and when the ingest
// FINISHED it showed nothing at all. The events were never lost — this view
// deliberately does not abort its SSE fetch on navigate-away — they were
// DROPPED by the isCurrentMount gate in setProgress, because a returning mount
// has a brand-new `state`.
//
// So the fix is server-side (GET /api/ingest/activity, guarded by
// scripts/test-ingest-activity.js) and this section pins the CLIENT half:
// which of the two panes wins when both could paint, what a dismissal means,
// and that the poll cannot outlive the mount.
// -- THE SANDBOX DEPENDENCY GUARD ---------------------------------------
// This suite lifts function bodies out by a HARDCODED NAME LIST and runs them
// in a sandbox. That is the `FN_NAMES` blind spot this repo has now hit three
// times (v3.11.0's loading-gate, v3.14.0's model picker, v3.24.0's markdown
// renderer): when a lifted function grows a call to a helper the list does not
// know about, the section dies with a raw `ReferenceError` -- a CRASH, not a
// failing assertion. A crash names no expectation, aborts the run, leaves the
// tally wrong, and reads as a broken harness rather than a gap in coverage.
//
// It happened again here: `activitySignature()` gained a call to
// `unackedSettledRecords()` and 13 exploded with every later assertion unrun.
// Fixing that in 13 alone was NOT enough -- mutation M13 then crashed 14
// instead, because 14 builds its OWN sandbox over some of the same functions.
// So the guard is SHARED and both callers use it: the class, not the instance.
//
// The scan is deliberately dumb -- an identifier followed by `(` -- and errs
// toward false positives, the safe direction for a guard whose job is refusing
// to run over an incomplete sandbox. Names declared INSIDE a body (several
// define a local `const at = (r) => ...` comparator) resolve themselves,
// collected per body so a helper local to one function is not silently
// accepted as defined for another.
//
// Returns true when everything resolves. A false return MUST make the caller
// skip its sandbox: naming the problem is not enough, the section has to stop.
const SANDBOX_AMBIENT = new Set([
  'JSON', 'Array', 'Number', 'String', 'Boolean', 'Object', 'Set', 'Map',
  'Date', 'Math', 'isFinite', 'parseInt', 'parseFloat', 'if', 'for',
  'while', 'switch', 'catch', 'return', 'typeof', 'function', 'filter',
  'map', 'sort', 'join', 'includes', 'slice', 'some', 'every', 'find',
  'push', 'has', 'get', 'set', 'stringify', 'parse', 'isArray',
  'getItem', 'setItem', 'test', 'exec', 'replace', 'split', 'keys',
  'values', 'entries', 'from', 'assign', 'freeze', 'hasOwn',
]);
function sandboxDepsResolved(bodies, sandboxedNames, provides, label) {
  const stripComments = (t) => (t || '').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const provided = new Set(provides);
  const unresolved = new Set();
  for (const n of sandboxedNames) {
    const body = stripComments(bodies[n] || '');
    const local = new Set();
    const declRe = /(?:^|[^.\w$])(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
    let dm;
    while ((dm = declRe.exec(body)) !== null) local.add(dm[1]);
    const callRe = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(body)) !== null) {
      const id = cm[1];
      if (provided.has(id) || SANDBOX_AMBIENT.has(id) || local.has(id)) continue;
      unresolved.add(id + '() in ' + n + '()');
    }
  }
  ok(unresolved.size === 0,
    label + ' the sandbox supplies every function the lifted bodies CALL - a new ' +
    'helper must fail here BY NAME, never as a ReferenceError mid-section ' +
    (unresolved.size ? '(UNRESOLVED: ' + [...unresolved].join(', ') + ')' : '(all resolved)'));

  // POSITIVE CONTROL - the scan can actually see a call it does not know, so a
  // green above means "nothing unresolved", not "the scan found nothing".
  const probeRe = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  const probeHits = [];
  let pm;
  while ((pm = probeRe.exec('function f(){ return someBrandNewHelper(1) + isActivityAcked(2); }')) !== null) {
    probeHits.push(pm[1]);
  }
  ok(probeHits.includes('someBrandNewHelper'),
    label + ' CONTROL - the call scan detects an unknown helper (so the assertion above is not vacuous)');

  if (unresolved.size) {
    console.log('\n\u274c ' + label + ' will not run its sandbox over an incomplete function ' +
      'set - add the missing name(s) to the *_NEEDED list AND to the sandbox builder.');
    return false;
  }
  return true;
}

console.log('\n§13  Server-backed activity — a run survives navigating away');
{
  const code = (t) => (t || '').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const A_NEEDED = [
    'isRemoteIngestRunning', 'pendingRemoteOutcome', 'activitySignature',
    'loadAckedActivityIds', 'isActivityAcked', 'ackActivityId',
    'scheduleActivityPoll', 'stopActivityPoll', 'renderRemoteProgress',
    'renderRemoteOutcome', 'renderResultBodyHtml', 'dismissRemoteOutcome',
    'syncRemoteElapsedTimer', 'refreshActivity',
    // v3.24.2 — the SETTLED surfaces. Added here rather than sandboxed
    // separately because activitySignature() now calls unackedSettledRecords(),
    // so omitting it does not weaken a test, it CRASHES the section (see the
    // dependency guard below, which is what made that failure legible).
    'settledActivityRecords', 'unackedSettledRecords', 'settledElsewhere',
    'renderSettledElsewhere', 'dismissSettledElsewhere',
  ];
  const aBodies = {};
  let aFatal = false;
  for (const name of A_NEEDED) {
    const body = extractFunction(js, name);
    const wellFormed = !!body && /\n\}$/.test(body) && body.split('\n').length > 2;
    aBodies[name] = wellFormed ? body : null;
    ok(wellFormed, '§13 POSITIVE CONTROL — extracted a WELL-FORMED body for ' + name + '()');
    if (!wellFormed) aFatal = true;
  }


  const PROVIDES_13 = ['loadAckedActivityIds', 'isActivityAcked', 'ackActivityId',
    'isRemoteIngestRunning', 'pendingRemoteOutcome', 'activitySignature',
    'settledActivityRecords', 'unackedSettledRecords', 'settledElsewhere'];
  if (!sandboxDepsResolved(aBodies, PROVIDES_13, PROVIDES_13, '§13a-pre')) aFatal = true;

  if (aFatal) {
    console.log('\n❌ §13 cannot check anything without its targets — failing loudly ' +
      'rather than reporting a green run over zero comparisons.');
  } else {
    // The two module constants come from the SOURCE, not from a copy here: a
    // suite that re-declares the value it is checking is asserting f(x) === f(x).
    const keyM = /const ACTIVITY_ACK_KEY = '([^']+)';/.exec(js);
    const maxM = /const ACTIVITY_ACK_MAX = (\d+);/.exec(js);
    ok(!!keyM && !!maxM, '§13 the ack constants are readable from source (not re-declared here)');
    const ACK_KEY = keyM ? keyM[1] : '';
    const ACK_MAX = maxM ? Number(maxM[1]) : 0;

    // ── A sandbox carrying the real functions, a mutable `state`, and a
    //    localStorage we can break on purpose.
    function makeSandbox(storageImpl) {
      const src =
        'return (() => {' +
        `const ACTIVITY_ACK_KEY = ${JSON.stringify(ACK_KEY)};` +
        `const ACTIVITY_ACK_MAX = ${ACK_MAX};` +
        'let state = { submitting:false, progress:null, result:null, errorMessage:null, remote:null, remoteResultExpanded:false, domain:"articles", runningDomains:[], settledActivity:[], domains:[] };' +
        aBodies.loadAckedActivityIds + aBodies.isActivityAcked + aBodies.ackActivityId +
        aBodies.isRemoteIngestRunning + aBodies.pendingRemoteOutcome +
        aBodies.settledActivityRecords + aBodies.unackedSettledRecords + aBodies.settledElsewhere +
        aBodies.activitySignature +
        'return { get state(){return state;}, set state(v){state=v;}, loadAckedActivityIds, isActivityAcked, ackActivityId, isRemoteIngestRunning, pendingRemoteOutcome, activitySignature, settledActivityRecords, unackedSettledRecords, settledElsewhere };' +
        '})()';
      return new Function('window', src)({ localStorage: storageImpl });
    }


    function memStorage() {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        _map: m,
      };
    }

    const RUNNING = { id: 'id-run', status: 'running', pct: 30, message: 'Planning…', waiting: false, phaseStartedAt: 1000, filename: 'a.pdf', error: null, result: null };
    const DONE = { id: 'id-done', status: 'done', pct: 100, message: 'Done', waiting: false, phaseStartedAt: 1000, filename: 'a.pdf', error: null, result: { title: 'T', changesTotal: 2, warningsTotal: 0, changes: [], warnings: [], pagesWritten: [] } };
    const ERRORED = { ...DONE, id: 'id-err', status: 'error', error: 'It broke', result: null };

    // ── 13a  The double-render guard ───────────────────────────────────
    // Both panes CAN have something to paint at the same instant: while this
    // mount is watching its own ingest, the server's record describes the very
    // same run. Painting both would put one ingest on screen twice, on two
    // different update cadences.
    {
      const sb = makeSandbox(memStorage());
      sb.state.remote = RUNNING;
      ok(sb.isRemoteIngestRunning() === true,
        '§13a a running server record with no local ingest DOES paint (the reported defect: it used to paint nothing but a generic note)');

      sb.state.submitting = true;
      ok(sb.isRemoteIngestRunning() === false,
        '§13a …but NOT while this mount owns the run (state.submitting) — the same ingest twice, on two cadences');
      sb.state.submitting = false;

      sb.state.progress = { pct: 10 };
      ok(sb.isRemoteIngestRunning() === false,
        '§13a …nor while this mount is painting its own live SSE progress');
      sb.state.progress = null;

      sb.state.remote = DONE;
      ok(sb.isRemoteIngestRunning() === false, '§13a a SETTLED record is not "running"');
      sb.state.remote = null;
      ok(sb.isRemoteIngestRunning() === false, '§13a no record at all is not "running"');
    }

    // ── 13b  A finished run is REPORTED — the half that showed nothing ──
    {
      const sb = makeSandbox(memStorage());
      sb.state.remote = DONE;
      ok(sb.pendingRemoteOutcome() === DONE,
        '§13b a finished-while-away run IS surfaced — "the process ended, but there\'s basically no way I can know if this article was ingested"');

      sb.state.remote = ERRORED;
      ok(sb.pendingRemoteOutcome() === ERRORED, '§13b so is one that FAILED while away');

      sb.state.remote = RUNNING;
      ok(sb.pendingRemoteOutcome() === null, '§13b a still-running record is not an outcome');

      // Already showing the same event locally → the server's copy is not a
      // second one.
      sb.state.remote = DONE;
      sb.state.result = { title: 'T' };
      ok(sb.pendingRemoteOutcome() === null, '§13b suppressed when this mount already shows its OWN result');
      sb.state.result = null;
      sb.state.errorMessage = 'boom';
      ok(sb.pendingRemoteOutcome() === null, '§13b suppressed when this mount already shows its OWN error');
      sb.state.errorMessage = null;
      ok(sb.pendingRemoteOutcome() === DONE, '§13b CONTROL — and returns again once neither is showing');
    }

    // ── 13c  Dismissal is per-viewer and survives a reload ─────────────
    {
      const store = memStorage();
      const sb = makeSandbox(store);
      sb.state.remote = DONE;
      ok(sb.pendingRemoteOutcome() === DONE, '§13c setup: the outcome is pending');
      sb.ackActivityId(DONE.id);
      ok(sb.pendingRemoteOutcome() === null, '§13c dismissing hides it');
      ok(store._map.get(ACK_KEY).includes(DONE.id),
        '§13c …and it is written to storage, so F5 does not bring it back');

      // A SECOND viewer (fresh storage) has NOT seen it. That is the whole
      // reason this is per-viewer rather than server state.
      const sb2 = makeSandbox(memStorage());
      sb2.state.remote = DONE;
      ok(sb2.pendingRemoteOutcome() === DONE,
        '§13c a different BROWSER/PROFILE still sees it — dismissal is per viewer, not a fact about the ingest (localStorage is per origin AND profile, so a second TAB in the same browser shares it; the fixture models a separate profile)');

      // A DIFFERENT run is not hidden by a previous dismissal.
      const sb3 = makeSandbox(store);
      sb3.state.remote = { ...DONE, id: 'a-newer-run' };
      ok(sb3.pendingRemoteOutcome() !== null,
        '§13c dismissing one run does not hide the NEXT one');
    }

    // ── 13d  Storage that throws must FAIL BY SHOWING ──────────────────
    // v3.8.0's rule, applied: guidance/outcome reappearing is harmless;
    // silently hiding it has no visible symptom. Private mode makes every
    // localStorage call throw.
    {
      const hostile = {
        getItem() { throw new Error('SecurityError'); },
        setItem() { throw new Error('SecurityError'); },
      };
      const sb = makeSandbox(hostile);
      let threw = null;
      let acked = null;
      let list = null;
      try {
        list = sb.loadAckedActivityIds();
        acked = sb.isActivityAcked('x');
        sb.ackActivityId('x');
      } catch (err) { threw = err; }
      ok(threw === null, '§13d a throwing localStorage does not take the view down' + (threw ? ' — threw ' + threw.message : ''));
      ok(Array.isArray(list) && list.length === 0, '§13d …reads degrade to an empty list');
      ok(acked === false, '§13d …nothing reads as acknowledged');
      sb.state.remote = DONE;
      ok(sb.pendingRemoteOutcome() === DONE,
        '§13d …so the outcome is SHOWN. That is the safe direction: re-showing is noise, silently hiding a result has no symptom');
    }

    // Malformed stored JSON must not throw either.
    {
      const store = memStorage();
      store.setItem(ACK_KEY, '{not json at all');
      const sb = makeSandbox(store);
      ok(sb.loadAckedActivityIds().length === 0, '§13d malformed stored JSON degrades to empty');
      store.setItem(ACK_KEY, '{"not":"an array"}');
      const sb2 = makeSandbox(store);
      ok(sb2.loadAckedActivityIds().length === 0, '§13d a non-array value degrades to empty');
      store.setItem(ACK_KEY, '[1,2,{"a":1},"real-id"]');
      const sb3 = makeSandbox(store);
      ok(sb3.loadAckedActivityIds().join(',') === 'real-id',
        '§13d non-string entries are filtered out rather than compared against an id');
    }

    // ── 13e  The ack list is bounded ───────────────────────────────────
    {
      const store = memStorage();
      const sb = makeSandbox(store);
      for (let i = 0; i < ACK_MAX + 15; i++) sb.ackActivityId('id-' + i);
      const stored = JSON.parse(store._map.get(ACK_KEY));
      ok(stored.length === ACK_MAX, `§13e the ack list is capped at ACTIVITY_ACK_MAX (got ${stored.length}, expected ${ACK_MAX})`);
      ok(stored[0] === 'id-' + (ACK_MAX + 14), '§13e most-recent-first, so the newest dismissal is never the one evicted');
      // Re-acking an id already present must not create a duplicate.
      sb.ackActivityId(stored[3]);
      const again = JSON.parse(store._map.get(ACK_KEY));
      ok(again.filter((v) => v === stored[3]).length === 1, '§13e re-acking an id does not duplicate it');
    }

    // ── 13f  The no-op guard actually discriminates ────────────────────
    // views/memory.js's lesson, verbatim: "a no-op guard that cannot see a
    // pane is not a guard for that pane". A signature that never changes
    // suppresses every repaint; one that always changes rebuilds the panel
    // every 2 seconds and destroys the fold and the scroll position.
    {
      const sb = makeSandbox(memStorage());
      sb.state.remote = RUNNING;
      const base = sb.activitySignature();
      ok(sb.activitySignature() === base, '§13f an identical poll produces an identical signature — no repaint');

      const vary = [
        ['status', { ...RUNNING, status: 'done' }],
        ['pct', { ...RUNNING, pct: 55 }],
        ['message', { ...RUNNING, message: 'Writing wiki pages…' }],
        ['waiting', { ...RUNNING, waiting: true }],
        ['phaseStartedAt', { ...RUNNING, phaseStartedAt: 99999 }],
        ['filename', { ...RUNNING, filename: 'b.pdf' }],
        ['id', { ...RUNNING, id: 'another' }],
      ];
      for (const [field, rec] of vary) {
        sb.state.remote = rec;
        ok(sb.activitySignature() !== base, `§13f a change in ${field} changes the signature (the pane repaints)`);
      }

      // The fold state is part of what is painted, so it must be in there —
      // otherwise the next poll compares equal and slams the fold shut.
      sb.state.remote = RUNNING;
      sb.state.remoteResultExpanded = true;
      ok(sb.activitySignature() !== base,
        '§13f the unchanged-pages FOLD is in the signature — otherwise the next poll repaints it shut');

      // And a dismissal changes it, or the panel would linger until something
      // unrelated moved.
      sb.state.remoteResultExpanded = false;
      const before = sb.activitySignature();
      sb.ackActivityId(RUNNING.id);
      ok(sb.activitySignature() !== before, '§13f dismissing changes the signature');

      // CONTROL: no record at all is a distinct, cheap signature.
      //
      // INVERTED IN v3.24.1, NOT DELETED. This asserted the literal 'none'.
      // The no-record branch now also carries the running-domain set
      // ('none|posts'), because that branch is EXACTLY the reported scenario —
      // selected domain `articles`, ingest running on `posts` — so a set the
      // fast path could not see would be computed on every poll and never
      // painted. The assertion's INTENT (the empty case has a cheap signature
      // of its own, distinct from any record's) is unchanged and still pinned;
      // only the literal moved, so it is rewritten rather than dropped.
      sb.state.remote = null;
      sb.state.runningDomains = [];
      const empty = sb.activitySignature();
      ok(empty !== base && /^none/.test(empty),
        '§13f CONTROL — no record still has its own cheap signature, distinct from any record\'s');
      sb.state.runningDomains = ['posts'];
      ok(sb.activitySignature() !== empty,
        '§13f …and that fast path can STILL see a run on another domain — the branch the reported defect actually takes');
    }

    // ── 13g  Poll hygiene — the timer cannot outlive the mount ─────────
    // memory.js: an armed poll timer surviving teardown "would keep FETCHING
    // for a view nobody is looking at, for the life of the page".
    {
      const enter = extractFunction(js, 'freshState'); // presence check only
      ok(!!enter, '§13g setup: the view source is intact');

      const sched = code(aBodies.scheduleActivityPoll);
      ok(/stopActivityPoll\(\)/.test(sched),
        '§13g scheduleActivityPoll clears any previous timer before arming a new one');
      ok(/setTimeout\(/.test(sched) && !/setInterval\(/.test(sched),
        '§13g it is a setTimeout CHAIN, not setInterval — a slow refresh must delay the next one, never stack behind it');
      ok(/document\.hidden/.test(sched),
        '§13g a hidden tab reschedules WITHOUT fetching — nobody is looking, and the wake handler covers the moment they are');
      ok(/isCurrentMount\(token\)/.test(sched),
        '§13g and a fired timer re-checks the mount before doing anything');
      ok(/\.finally\(/.test(sched),
        '§13g the chain re-arms in a finally, so a failed poll does not stop the polling');

      // The teardown must stop BOTH timers and remove BOTH wake listeners.
      const enterFn = js.slice(js.indexOf("registerView('ingest'"), js.indexOf('function loadAckedActivityIds'));
      for (const needle of [
        'stopActivityPoll();',
        'stopRemoteElapsedTimer();',
        "removeEventListener('focus', activityWakeHandler)",
        "removeEventListener('visibilitychange', activityWakeHandler)",
      ]) {
        ok(enterFn.includes(needle), `§13g teardown performs: ${needle}`);
      }
      // CONTROL: that slice really does contain the teardown, so the greens
      // above are locating real code rather than matching an empty string.
      ok(enterFn.includes('return () => {') && enterFn.includes('detachQueueStream();'),
        '§13g CONTROL — the scanned slice genuinely contains the teardown');
    }

    // ── 13h  The two panels are ONE builder ────────────────────────────
    // The live outcome and the restored one describe the same event. Two
    // hand-maintained copies of one panel is this repo's named drift shape.
    {
      ok(/renderResultBodyHtml\(/.test(code(extractFunction(js, 'renderResult'))),
        '§13h the LIVE result panel is built by renderResultBodyHtml');
      ok(/renderResultBodyHtml\(/.test(code(aBodies.renderRemoteOutcome)),
        '§13h and so is the RESTORED one — one builder, not two that drift');

      // Distinct toggle ids: two controls sharing one id is invalid HTML, and
      // a click would flip whichever getElementById found first.
      ok(/'ing-unchanged-toggle'/.test(code(extractFunction(js, 'renderResult'))),
        '§13h the live panel keeps its original toggle id (that call site is byte-unchanged)');
      ok(/'ing-remote-unchanged-toggle'/.test(code(aBodies.renderRemoteOutcome)),
        '§13h and the restored panel uses a DIFFERENT one');
      ok(/toggleId/.test(code(extractFunction(js, 'renderChangeRecordsHtml'))),
        '§13h …because the builder takes the id as a parameter rather than hardcoding it');
    }

    // ── 13i  The reattached progress is the REAL one ───────────────────
    {
      const rp = code(aBodies.renderRemoteProgress);
      ok(/progressRingHtml\(/.test(rp),
        '§13i the reattached view uses the SAME ring as the live one — one ingest, one visual vocabulary');
      ok(/mapIngestPctToStage\(/.test(rp), '§13i and the same stage map');
      ok(/ringAria\(/.test(rp),
        '§13i and takes its percentage from ringAria — the same function that stamps aria-valuenow, so the number a sighted user reads and the one announced are ONE derivation (the v3.18.0 three-figure defect)');
      ok(/center: 'none'/.test(rp),
        '§13i and suppresses the centre glyph, so the stage is stated once');
      ok(/r\.waiting \? 'attention'/.test(rp),
        '§13i a retry/backoff still shows amber and still does not advance the ring');
      ok(/filename/.test(rp),
        '§13i it names the FILE — "an ingest is running" is not the question a returning user has; "is THIS article in?" is');
      ok(/ing-remote-elapsed/.test(rp),
        '§13i and carries the elapsed clock the generic note had no room for');

      // The clock ticks from the LOCALLY-anchored instant, never from the raw
      // server timestamp: subtracting a server epoch from Date.now() would
      // bake clock skew straight into a visible number.
      const rt = code(aBodies.syncRemoteElapsedTimer);
      ok(/remotePhaseStartedAtLocal/.test(rt),
        '§13i the clock ticks from the LOCALLY-anchored instant, not a raw server timestamp');
      ok(/textContent/.test(rt) && !/render\(/.test(rt),
        '§13i and it patches textContent rather than re-rendering — the same targeted-write exception the live clock already makes');
      ok(/clearInterval/.test(code(aBodies.renderRemoteProgress)) === false,
        '§13i CONTROL — the renderer does not own the timer (that is syncRemoteElapsedTimer\'s job)');

      // The conversion itself: one subtraction of two readings from the SAME
      // clock, so skew cancels.
      const ra = code(aBodies.refreshActivity);
      ok(/Date\.now\(\) - \(got\.serverNow - rec\.phaseStartedAt\)/.test(ra),
        '§13i server time is converted by ONE subtraction of two readings from the same clock — skew cancels and is never reasoned about');
      ok(/if \(got\.error\)/.test(ra),
        '§13i a failed poll keeps what is on screen rather than blanking it (memory.js\'s revalidation rule)');
    }

    // ── 13j  Dismissal costs no server call ────────────────────────────
    {
      const dm = code(aBodies.dismissRemoteOutcome);
      ok(!/fetch\(/.test(dm),
        '§13j Dismiss is UI-only — no server call, so a second tab still gets told (v3.3.1\'s batch Dismiss, same reasoning)');
      ok(/ackActivityId\(/.test(dm), '§13j it records the dismissal locally');
      ok(/render\(/.test(dm), '§13j and repaints');
    }

    // ── 13k  The busy state uses server truth, not just the client gate ─
    // app.js's write gate lives in a module variable that a page load resets,
    // so after F5 mid-ingest it reads false while the write is genuinely
    // running. Without the OR, the Ingest button would look live and the
    // press would be refused by the file lock with no warning.
    {
      const form = code(extractFunction(js, 'renderIngestForm'));
      ok(/isDomainWriteBusy\(state\.domain\) \|\| remoteRunning/.test(form),
        '§13k the Ingest button is disabled by the client gate OR the server record — the gate alone is blind after a reload');
      ok(/crossBusy && !remoteRunning/.test(form),
        '§13k and the GENERIC "a write is already running" note is replaced when we know what is actually running');
      const side = code(extractFunction(js, 'renderSidebar'));
      // NOT an identifier-presence scan. `/remoteRunning/` alone stayed GREEN
      // under a mutation that removed the OR from this very predicate, because
      // the identifier still appeared — in its own declaration. A scan
      // satisfied by the line that DECLARES the thing measures nothing.
      ok(/isDomainWriteBusy\(state\.domain\) \|\| remoteRunning/.test(side),
        '§13k the SIDEBAR busy state is also client-gate-OR-server-record');
      ok(/remoteRunning\s*\?/.test(side),
        '§13k …and it BRANCHES on it, so a known ingest gets the specific sentence rather than "a write is already running"');
      ok(/state\.remote\.filename/.test(side),
        '§13k …naming the file, which the reported screenshot did not');
      ok(/state\.remote\.message/.test(side),
        '§13k …and the phase');
    }

    // ── 13l  A domain switch clears the record ─────────────────────────
    // The record is PER DOMAIN. Showing domain A's ingest under domain B's
    // name is a correctness bug, strictly worse than a brief gap — the same
    // ordering domains.js settled on for its health report in v3.11.0.
    {
      const sd = code(extractFunction(js, 'selectDomain'));
      ok(/state\.remote = null/.test(sd), '§13l switching domain CLEARS the record immediately');
      ok(/refreshActivity\(/.test(sd), '§13l …and re-asks for the new domain\'s');
      const iClear = sd.indexOf('state.remote = null');
      const iFetch = sd.indexOf('refreshActivity(');
      ok(iClear >= 0 && iFetch >= 0 && iClear < iFetch,
        `§13l …in that order (offsets ${iClear} < ${iFetch}) — cleared BEFORE the refetch, never showing the old domain\'s run under the new name`);
      ok(/stopRemoteElapsedTimer\(\)/.test(sd), '§13l and stops the old run\'s clock');
    }

    // ── 13n  EVERY module-scope name is actually DECLARED ──────────────
    //
    // THIS SECTION EXISTS BECAUSE THE DEFECT HAPPENED. During this change an
    // edit reported success and its content did not survive: the whole
    // module-level declaration block — ACTIVITY_POLL_*, activityPollTimer,
    // activityWakeHandler, activityInFlight, remoteElapsedTimerId and
    // renderedActivitySignature — was absent while every function that USES
    // those names was present. The view then threw
    // `ReferenceError: renderedActivitySignature is not defined` on entry and
    // painted the boot-recovery card instead of the Ingest view.
    //
    // NOTHING CAUGHT IT. `node --check` passes — an undeclared identifier is
    // valid SYNTAX, it fails at RUNTIME. test-frontend-syntax.js therefore
    // sees nothing. And the sections above cannot see it either, structurally:
    // they EXTRACT functions and run them in a sandbox that supplies its own
    // declarations, so a name missing from the real module scope is supplied
    // by the harness. A suite that provides the thing it is checking for
    // cannot check for it. Only the browser found this.
    //
    // So: assert the DECLARATION exists, at column 0, in the real file.
    // Narrow and textual by design — a general undefined-variable checker
    // needs a JS parser this repo deliberately does not carry (v3.1.0's
    // null-safety lexer records how that goes). It fails in the SAFE
    // direction: a name declared in an unusual form would be a false red.
    {
      const MODULE_SCOPE_NAMES = [
        'ACTIVITY_POLL_ACTIVE_MS', 'ACTIVITY_POLL_IDLE_MS', 'ACTIVITY_ACK_KEY', 'ACTIVITY_ACK_MAX',
        'activityPollTimer', 'activityWakeHandler', 'activityInFlight',
        'remoteElapsedTimerId', 'renderedActivitySignature',
      ];
      for (const name of MODULE_SCOPE_NAMES) {
        const declared = new RegExp('^(?:let|const|var)\\s+' + name + '\\b', 'm').test(js);
        ok(declared, `§13n \`${name}\` has a module-scope declaration (an undeclared name is valid SYNTAX and throws only at runtime — node --check cannot see it)`);
      }
      // And the state fields, which live in freshState() rather than at module
      // scope. Same edit, same loss, same invisibility to an extracting suite.
      const fresh = extractFunction(js, 'freshState');
      for (const field of ['remote', 'remotePhaseStartedAtLocal', 'remoteError', 'remoteResultExpanded']) {
        ok(new RegExp('^\\s*' + field + ':', 'm').test(fresh || ''),
          `§13n freshState() initialises state.${field} — a mount must not inherit the previous one's record`);
      }
      // CONTROL: the scan can fail. Without this, a typo in the regex would
      // make every green above vacuous in the same direction.
      ok(!new RegExp('^(?:let|const|var)\\s+aNameThatIsNotDeclaredAnywhere\\b', 'm').test(js),
        '§13n CONTROL — the declaration scan reports MISSING for a name that genuinely is not declared');
    }

    // ── 13m  CONTROLS: these scans can fail ────────────────────────────
    {
      ok(!/progressRingHtml\(/.test(code(aBodies.dismissRemoteOutcome)),
        '§13m CONTROL — the render scans do NOT match an unrelated function');
      ok(!/ing-remote-elapsed/.test(code(extractFunction(js, 'renderProgress'))),
        '§13m CONTROL — the live progress panel does NOT carry the remote clock id (the two ids are genuinely distinct)');
      ok(/id="ing-elapsed"/.test(code(extractFunction(js, 'renderProgress'))),
        '§13m CONTROL — …and still carries its own, so the live path is unchanged');
    }
  }
}

// ── §14 — a running ingest is reachable whatever domain is selected ─────
//
// THE DEFECT, and it is not the one it was reported as. "I uploaded a
// document, ingested it, then switched to the memory layer and returned, and
// everything was gone. No message, no nothing." Then minutes later: "now it
// works, I don't know why." That reads as intermittent. It is not.
//
// MEASURED on the live server: GET /api/ingest/activity held TWO records —
// `posts` started 94 s earlier, and `articles` started 27 s later with the
// SAME filename. That pair is the whole sequence written down: ingest into
// `posts` -> return -> see nothing -> re-ingest, which the second time lands
// on the default domain and therefore shows. v3.24.0 worked; it was
// unreachable unless you already happened to be looking at the right domain.
//
// Two lines, each correct alone, compose into it: `loadDomains` does
// `state.domain = list[0].slug` unconditionally, and `refreshActivity` finds
// the record with `find(a => a.domain === state.domain)`.
//
// The fix has two halves and §14 pins both, because they carry different
// weight. ADOPTION (14a-14b) is batch-path parity and rescues the moment you
// walk back in. The SIDEBAR MARKERS (14c-14e) are what removes the CLASS: with
// them no running ingest can be invisible whatever is selected, so adoption
// becomes a convenience rather than the only thing between the user and a
// blank screen.
console.log('\n§14  A running ingest is reachable whatever domain is selected');
{
  const code14 = (t) => (t || '').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const B_NEEDED = [
    'pickAdoptableDestination', 'adoptDestination', 'runningActivityDomains',
    'activitySignature', 'loadAckedActivityIds', 'isActivityAcked',
    'refreshActivity', 'selectDomain', 'renderSidebar',
    // v3.24.2 — activitySignature() calls this, so §14's sandbox needs it for
    // the same reason §13's does. Two sandboxes, one dependency: the second
    // crash after fixing the first is exactly why the guard below counts.
    'unackedSettledRecords', 'settledActivityRecords',
  ];
  const bBodies = {};
  let bFatal = false;
  for (const name of B_NEEDED) {
    const body = extractFunction(js, name);
    const wellFormed = !!body && /\n\}$/.test(body) && body.split('\n').length > 2;
    bBodies[name] = wellFormed ? body : null;
    ok(wellFormed, '§14 POSITIVE CONTROL — extracted a WELL-FORMED body for ' + name + '()');
    if (!wellFormed) bFatal = true;
  }

  // §14 builds its OWN sandbox over some of the same functions, so it carries
  // the same hazard and gets the same guard. Mutation M13 proved that closing
  // it in §13 alone was closing the INSTANCE, not the class: the crash simply
  // moved here. Two sandboxes, one shared check.
  //
  // `refreshActivity` and `renderSidebar` are extracted for SOURCE SCANS in
  // this section rather than executed inside makeSandbox14, so they are not in
  // the provided/checked set — a scan does not need its callees to exist.
  const B_SANDBOXED = ['loadAckedActivityIds', 'isActivityAcked',
    'pickAdoptableDestination', 'adoptDestination', 'runningActivityDomains',
    'settledActivityRecords', 'unackedSettledRecords', 'activitySignature'];
  if (!sandboxDepsResolved(bBodies, B_SANDBOXED, B_SANDBOXED, '§14a-pre')) bFatal = true;

  if (bFatal) {
    console.log('\n❌ §14 cannot check anything without its targets — failing loudly ' +
      'rather than reporting a green run over zero comparisons.');
  } else {
    function makeSandbox14(initialState) {
      const src =
        'return (() => {' +
        "const ACTIVITY_ACK_KEY = 'k'; const ACTIVITY_ACK_MAX = 20;" +
        'let state = ' + JSON.stringify(initialState) + ';' +
        bBodies.loadAckedActivityIds + bBodies.isActivityAcked +
        bBodies.pickAdoptableDestination + bBodies.adoptDestination +
        bBodies.runningActivityDomains + bBodies.unackedSettledRecords +
        bBodies.activitySignature +
        'return { get state(){return state;}, pickAdoptableDestination, adoptDestination,' +
        ' runningActivityDomains, activitySignature, unackedSettledRecords };' +
        '})()';
      return new Function('window', src)({
        localStorage: { getItem: () => null, setItem: () => {} },
      });
    }
    const baseState = {
      domains: [{ slug: 'articles' }, { slug: 'posts' }, { slug: 'business' }],
      domain: 'articles',
      destinationAdoptionPending: true,
      runningDomains: [],
      remote: null,
      remoteResultExpanded: false,
      submitting: false, progress: null, result: null, errorMessage: null,
    };
    const run = (domain, startedAt) => ({ domain, status: 'running', startedAt, id: 'r-' + domain });
    const done = (domain, startedAt) => ({ domain, status: 'done', startedAt, id: 'd-' + domain });

    // ── 14a  Which destination a fresh mount adopts ────────────────────
    {
      const sb = makeSandbox14(baseState);
      const D = baseState.domains;
      const pick = (act, cur) => sb.pickAdoptableDestination(act, D, cur);

      ok(pick([run('posts', 1000)], 'articles') === 'posts',
        '§14a THE REPORTED CASE — an ingest running on a domain other than the one loadDomains snapped to IS adopted, so returning to the view shows it instead of a blank form');
      ok(pick([run('articles', 1000)], 'articles') === null,
        '§14a …but a run on the SELECTED domain adopts NOTHING — nothing is hidden, so moving would be pure harm. This short-circuit means an adoption only ever fires when the screen would otherwise show nothing');
      ok(pick([], 'articles') === null,
        '§14a nothing running adopts nothing');
      ok(pick([done('posts', 1000)], 'articles') === null,
        '§14a a SETTLED record is not adopted — the ingest is over, and moving the destination for a finished event is a bigger intrusion than the outcome is worth');
      ok(pick([run('secret-domain', 1000)], 'articles') === null,
        '§14a a run on a domain NOT in this mount\'s own list is refused — the SAME `state.domains.some(...)` guard applyQueueJobSnapshot has always used, kept rather than reinvented (a read-only mirror, or a domain deleted since load, has no row to select)');

      // The maintainer genuinely had two concurrent records, so the rule has
      // to be written down rather than left to Map order.
      const two = [run('posts', 1000), run('business', 5000)];
      ok(pick(two, 'articles') === 'business',
        '§14a TWO CONCURRENT RUNS — the LATEST startedAt wins: the run the user most recently caused is the best available proxy for the one they came back to look at');
      ok(pick(two.slice().reverse(), 'articles') === 'business',
        '§14a …and the answer does not depend on array order, so it cannot vary with the server Map\'s iteration order');
      // THIS CASE IS THE ONE THAT BITES, and it was missing until a mutation
      // said so. Deleting rule 1 outright left the suite GREEN at 257/0,
      // because every fixture here had the selected domain as the LATEST
      // runner — so the function's closing `best.domain === currentDomain`
      // guard returned null anyway and masked the deletion. Rule 1 only earns
      // its place when the selected domain is running AND is NOT the newest:
      // without it the user watching their own live ingest on `articles` is
      // moved to `posts` because another tab started something more recently.
      ok(pick([run('posts', 1000), run('business', 5000), run('articles', 9000)], 'articles') === null,
        '§14a rule 1 holds when the selected domain is also the newest runner');
      ok(pick([run('articles', 1000), run('posts', 9000)], 'articles') === null,
        '§14a …AND when it is the OLDEST. A user watching their own live ingest is not moved to a newer one somewhere else — the selected domain being busy means nothing is hidden, which is the entire condition an adoption exists for');

      const tie = [run('posts', 7000), run('business', 7000)];
      ok(pick(tie, 'articles') === 'business' && pick(tie.slice().reverse(), 'articles') === 'business',
        '§14a an exact startedAt TIE breaks on slug ascending, so the order is TOTAL and the answer deterministic — not "whichever the sort happened to leave first"');

      // wireNum yields null for anything non-finite, so this is a real wire shape.
      ok(pick([{ domain: 'posts', status: 'running', startedAt: null }, run('business', 10)], 'articles') === 'business',
        '§14a a record with NO startedAt (wireNum returns null for non-finite) sorts LAST rather than poisoning the comparator with NaN — a record we cannot date must not outrank one we can');
      ok(pick([{ domain: 'posts', status: 'running', startedAt: null }], 'articles') === 'posts',
        '§14a …but it is still adoptable when it is the only candidate — undateable is not unusable');
      ok(pick(null, null) === null && pick(undefined, 'articles') === null,
        '§14a defensive: a missing activity list is not a crash');
    }

    // ── 14b  Once per mount, and never over a real choice ──────────────
    // v3.23.1's rule, which this must not relax: a poll never swaps the
    // document under a reader, and a choice the user actually made is never
    // taken away. A fresh mount has made no choice — list[0] is the store's
    // own default, not an intention — so resolving it to the live run is right
    // THERE and only there.
    {
      const sb = makeSandbox14(baseState);
      ok(sb.adoptDestination([run('posts', 1000)]) === true && sb.state.domain === 'posts',
        '§14b a fresh mount spends its adoption and the destination moves');
      ok(sb.state.destinationAdoptionPending === false,
        '§14b …and the mount now owes none');
      ok(sb.adoptDestination([run('business', 9000)]) === false && sb.state.domain === 'posts',
        '§14b THE v3.23.1 RULE — a LATER fetch cannot adopt again. Fifteen seconds on, the user is reading the screen; moving their destination because a second tab started an ingest would be the worse bug. The sidebar markers serve that case instead');
    }
    {
      const sb = makeSandbox14(baseState);
      ok(sb.adoptDestination([]) === false && sb.state.destinationAdoptionPending === false,
        '§14b the flag is spent even when NOTHING was adopted — adoption is a mount-time reconciliation, not an ongoing behaviour. Leaving it armed on an empty first fetch is exactly how a later poll would start yanking the selection');
      ok(sb.adoptDestination([run('posts', 1000)]) === false && sb.state.domain === 'articles',
        '§14b …proven by driving the case: a run appearing after that first fetch does NOT move the selection');
    }
    {
      const sb = makeSandbox14({ ...baseState, destinationAdoptionPending: false, domain: 'business' });
      ok(sb.adoptDestination([run('posts', 1000)]) === false && sb.state.domain === 'business',
        '§14b a mount where the user has already chosen adopts nothing — the deliberate choice is never taken away');
    }
    ok(/state\.destinationAdoptionPending\s*=\s*false/.test(code14(bBodies.selectDomain)),
      '§14b and selectDomain is what makes that true: a real click forfeits the adoption, so a user who picks a destination before the first fetch lands does not have it moved out from under them');

    // ── 14c  Every running domain, not just the selected one ───────────
    {
      const sb = makeSandbox14(baseState);
      const rd = sb.runningActivityDomains([run('posts', 1), done('business', 2), run('articles', 3)]);
      ok(JSON.stringify(rd) === JSON.stringify(['articles', 'posts']),
        '§14c runningActivityDomains reports EVERY running domain — this is the data `state.remote` structurally cannot carry, because it holds the selected domain only');
      ok(JSON.stringify(sb.runningActivityDomains([run('posts', 1), run('articles', 2)])) ===
         JSON.stringify(sb.runningActivityDomains([run('articles', 2), run('posts', 1)])),
        '§14c …sorted, so the signature string built from it is stable under the server Map\'s iteration order rather than repainting on a reorder');
      ok(sb.runningActivityDomains([done('posts', 1)]).length === 0,
        '§14c a settled record marks nothing — the marker means "running now"');
      ok(sb.runningActivityDomains([null, { status: 'running' }, { domain: '', status: 'running' }]).length === 0,
        '§14c defensive: malformed entries produce no marker rather than an empty-slug row');
    }

    // ── 14d  The no-op guard can SEE the marker pane ───────────────────
    // memory.js's own recorded failure, quoted in this file: "a no-op guard
    // that cannot see a pane is not a guard for that pane." Without
    // runningDomains in the signature, a poll that discovers an ingest on a
    // DIFFERENT domain compares equal and never repaints — the marker would be
    // computed and never drawn, which is this repo's dead-data shape.
    {
      const sb = makeSandbox14(baseState);
      const before = sb.activitySignature();
      sb.state.runningDomains = ['posts'];
      ok(sb.activitySignature() !== before,
        '§14d discovering a run on a domain that is NOT the selected one CHANGES the signature, so the repaint that draws the marker actually happens');
      const withPosts = sb.activitySignature();
      sb.state.runningDomains = ['business', 'posts'];
      ok(sb.activitySignature() !== withPosts,
        '§14d …and a SECOND domain starting one changes it again');
      sb.state.runningDomains = ['business', 'posts'];
      ok(sb.activitySignature() === sb.activitySignature(),
        '§14d CONTROL — an unchanged set does not, so this has not been turned into an unconditional repaint');
    }

    // ── 14e  The row actually draws it, and the ordering that matters ──
    {
      const sidebar = code14(bBodies.renderSidebar);
      ok(/state\.runningDomains/.test(sidebar) && /ing-dest-live/.test(sidebar),
        '§14e the destination rows are marked FROM state.runningDomains — the dead-data guard: a set computed and never rendered is exactly the shape v3.24.0 fixed one level down');
      ok(/ing-dest-live[^>]*>Ingesting</.test(sidebar),
        '§14e the marker is TEXT inside the row <button>, so it lands in the accessible name and reaches a screen reader — not a colour or a dot (v3.23.0 found a health count on an empty span unreachable by hover, keyboard AND screen reader)');
      ok(!/ing-dest-live[^>]*aria-hidden/.test(sidebar),
        '§14e …and is NOT aria-hidden, unlike the decorative check mark beside it whose meaning is already carried by aria-current');
      ok(/isRunning\s*\?/.test(sidebar) && !/isActive\s*&&\s*isRunning|isRunning\s*&&\s*!?\s*isActive/.test(sidebar),
        '§14e it is drawn on the ACTIVE row too, not only the others — a marker that vanished the moment you clicked the row would read as the ingest having stopped');

      const ra = code14(bBodies.refreshActivity);
      const iAdopt = ra.indexOf('adoptDestination(');
      const iFind = ra.indexOf('got.activity.find');
      ok(iAdopt > -1 && iFind > -1 && iAdopt < iFind,
        `§14e adoption runs BEFORE the record lookup (offsets ${iAdopt} < ${iFind}) — that lookup is keyed on state.domain, so adopting after it would show the old domain's absent record for one more tick, i.e. the blank screen the fix is for, one poll longer`);
      ok(/adopted\s*\|\|\s*after\s*!==\s*before/.test(ra),
        '§14e an adoption repaints UNCONDITIONALLY: the signature describes the activity panes, not the selection, so it is the wrong instrument for "the destination itself moved" — the sidebar\'s active row and the form\'s picker both changed and neither is in it');
      ok(/state\.runningDomains\s*=\s*runningActivityDomains\(/.test(ra),
        '§14e the running set is recomputed on every fetch, so a run finishing clears its marker rather than leaving a permanent one');

      ok(!/state\.runningDomains\s*=/.test(code14(bBodies.selectDomain)),
        '§14e selectDomain clears state.remote but NOT state.runningDomains: `remote` would be mis-attributed under the new domain\'s name, whereas each marker names its own row and stays true. Clearing it would blink every marker off on each click');

      // The measured colour rule, not a style preference. v3.20.0: painting
      // --attention-text AS TEXT on --attention-tint measures 3.21:1 in light
      // at this size, under the 4.5 AA floor — how .model-badge-flag failed.
      const liveRule = /\.ing-dest-live\s*\{([^}]*)\}/.exec(css);
      ok(!!liveRule, '§14e the marker has a real CSS rule (a class with no rule renders as unstyled text)');
      if (liveRule) {
        ok(/color:\s*var\(--text\)/.test(liveRule[1]),
          '§14e its LABEL is --text — v3.20.0 measured --attention-text as text on --attention-tint at 3.21:1 in light, under the 4.5 AA floor');
        ok(/border:[^;]*var\(--attention-text\)/.test(liveRule[1]) && /background:\s*var\(--attention-tint\)/.test(liveRule[1]),
          '§14e …with the TONE carried by border and tint, the same pairing .ing-sidebar-busy already uses, so the sidebar speaks with one voice about one fact');
      }
      ok(!/\.ing-dest-live\s*\{[^}]*color:\s*var\(--attention-text\)/.test(css),
        '§14e CONTROL — the failing pairing is asserted ABSENT, so the fix cannot come to look unnecessary and be quietly reverted');
    }

    // ── 14g  The whole reconciliation, EXECUTED ───────────────────────
    // Not a source scan. M1 — deleting the adoptDestination CALL from
    // refreshActivity, i.e. restoring the shipped defect exactly — reddened
    // only the offset-ordering assertion above, for the incidental reason that
    // indexOf returned -1. That is v3.20.0's recorded shape: "a function
    // executed but its CALL SITE never asserted", and a guard that goes red
    // for the wrong reason is one rename away from going green over a live
    // bug. So refreshActivity itself is driven here, with its collaborators
    // stubbed, and the assertions are about what ends up on `state`.
    {
      async function drive(activity, initial) {
        const src =
          'return (async () => {' +
          'let state = ' + JSON.stringify(initial) + ';' +
          'let activityInFlight = false;' +
          'let renderedActivitySignature = null;' +
          'let renders = 0;' +
          "const ACTIVITY_ACK_KEY = 'k'; const ACTIVITY_ACK_MAX = 20;" +
          'const isCurrentMount = () => true;' +
          'const render = () => { renders++; };' +
          'const syncRemoteElapsedTimer = () => {};' +
          'const fetchActivity = async () => ({ activity: ACTIVITY, serverNow: 10000 });' +
          bBodies.loadAckedActivityIds + bBodies.isActivityAcked +
          bBodies.pickAdoptableDestination + bBodies.adoptDestination +
          bBodies.runningActivityDomains + bBodies.settledActivityRecords +
          bBodies.unackedSettledRecords + bBodies.activitySignature +
          bBodies.refreshActivity +
          'await refreshActivity(1);' +
          'return { state, renders };' +
          '})()';
        return new Function('window', 'ACTIVITY', src)(
          { localStorage: { getItem: () => null, setItem: () => {} } },
          activity
        );
      }

      // THE REPORTED SCENARIO, end to end. Two records exactly as the live
      // server held them: `posts` started 94 s before `articles`.
      const twoReal = [
        { domain: 'posts', status: 'running', startedAt: 1000, id: 'p1', pct: 12, message: 'Phase 1: planning wiki structure…', waiting: false, phaseStartedAt: 1000, filename: 'paper.pdf', error: null, result: null },
        { domain: 'articles', status: 'done', startedAt: 5000, id: 'a1', pct: 100, message: 'Done', waiting: false, phaseStartedAt: 5000, filename: 'paper.pdf', error: null, result: null },
      ];
      const fresh = () => ({
        domains: [{ slug: 'articles' }, { slug: 'posts' }],
        domain: 'articles', destinationAdoptionPending: true, runningDomains: [],
        remote: null, remotePhaseStartedAtLocal: null, remoteError: null,
        remoteResultExpanded: false, submitting: false, progress: null,
        result: null, errorMessage: null,
      });

      const r1 = await drive([twoReal[0]], fresh());
      ok(r1.state.domain === 'posts',
        '§14g EXECUTED — refreshActivity itself moves the selection to the running domain. This is the assertion M1 (deleting the call) must red for a BEHAVIOURAL reason, not because an indexOf returned -1');
      ok(r1.state.remote && r1.state.remote.domain === 'posts' && r1.state.remote.status === 'running',
        '§14g …and the record it then looks up is the ADOPTED domain\'s, so the main column paints the live ingest instead of an empty drop zone');
      ok(r1.renders >= 1, '§14g …and it repaints, so the change reaches the screen');

      const r2 = await drive(twoReal, fresh());
      ok(r2.state.domain === 'posts' && r2.state.remote.id === 'p1',
        '§14g THE REPORTED PAIR — with `articles` holding a SETTLED record and `posts` a running one, the live run wins. Before this, `articles` was selected by loadDomains and the running ingest was unreachable');
      ok(JSON.stringify(r2.state.runningDomains) === JSON.stringify(['posts']),
        '§14g …and the sidebar\'s marker set is populated from the same fetch — one request, both halves of the fix');

      const r3 = await drive([{ domain: 'articles', status: 'running', startedAt: 1000, id: 'a9', pct: 5, message: 'Saving…', waiting: false, phaseStartedAt: 1000, filename: 'x.pdf', error: null, result: null }], fresh());
      ok(r3.state.domain === 'articles',
        '§14g CONTROL — when the run IS on the selected domain nothing moves, so this is adopting on a real condition rather than reassigning unconditionally');

      const r4 = await drive([], fresh());
      ok(r4.state.domain === 'articles' && r4.state.destinationAdoptionPending === false,
        '§14g CONTROL — an empty activity list leaves the selection alone and still spends the adoption');
    }

    // ── 14f  CONTROLS: these scans can fail ────────────────────────────
    {
      ok(!/ing-dest-live/.test(code14(bBodies.refreshActivity)),
        '§14f CONTROL — the render scans do NOT match an unrelated function');
      ok(/state\.domain\s*=/.test(code14(bBodies.adoptDestination)),
        '§14f CONTROL — adoptDestination really is a state.domain writer, so §2\'s allow-list entry for it is describing a live population rather than a name that no longer writes');
    }
  }
}

// ── §15 — A run that FINISHED while you were elsewhere ──────────────────
//
// THE OTHER HALF OF THE REPORT. v3.24.1 closed the RUNNING case: come back
// mid-ingest and `adoptDestination` moves the selection, and every running
// domain marks its sidebar row. Its own commit message recorded what was left:
//
//   "this covers RUNNING only. A single-file ingest that FINISHES while you are
//    on another domain still surfaces no outcome panel, because
//    pendingRemoteOutcome is likewise keyed on the selected domain."
//
// That is the sentence the maintainer actually opened with — "the process
// ended, but there's basically no way I can know if this article was ingested
// or not" — and on Flash Lite a small ingest finishes in ~9 s, so it is the
// COMMON path, not an edge case.
//
// Two surfaces, one acknowledgement store:
//   · every unacknowledged settled domain marks its SIDEBAR row (Ingested /
//     Failed), which is what stops any finished run being unfindable;
//   · one line in the MAIN PANE names the newest and offers to go there,
//     because a marker the user may not look at is an improvement on silence
//     and not an answer to it.
//
// ADOPTION IS DELIBERATELY NOT EXTENDED HERE, and §15f pins that: a terminal
// record lives 30 minutes (TERMINAL_TTL_MS), so adopting one would yank the
// destination on every Ingest mount inside that window.
console.log('\n§15  A finished ingest is findable from any domain');
{
  const code15 = (t) => (t || '').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  const C_NEEDED = [
    'settledActivityRecords', 'unackedSettledRecords', 'settledElsewhere',
    'renderSettledElsewhere', 'dismissSettledElsewhere', 'isActivityAcked',
    'loadAckedActivityIds', 'ackActivityId', 'activitySignature',
    'renderSidebar', 'selectDomain', 'refreshActivity',
  ];
  const cBodies = {};
  let cFatal = false;
  for (const name of C_NEEDED) {
    const body = extractFunction(js, name);
    const wellFormed = !!body && /\n\}$/.test(body) && body.split('\n').length > 2;
    cBodies[name] = wellFormed ? body : null;
    ok(wellFormed, '§15 POSITIVE CONTROL — extracted a WELL-FORMED body for ' + name + '()');
    if (!wellFormed) cFatal = true;
  }

  // §15 builds TWO sandboxes of its own (makeSandbox15, and the inline one in
  // §15e2), so it takes the same shared guard. M13 found this section too,
  // after §13 and §14 were both closed — three sandboxes, one hazard, which is
  // exactly why the check is a shared function rather than three copies.
  //
  // `renderSidebar`, `selectDomain`, `refreshActivity` and
  // `dismissSettledElsewhere` are extracted for SOURCE SCANS here, never
  // executed, so they are outside the checked set.
  const C_SANDBOXED = ['loadAckedActivityIds', 'isActivityAcked', 'ackActivityId',
    'settledActivityRecords', 'unackedSettledRecords', 'settledElsewhere',
    'renderSettledElsewhere', 'activitySignature'];
  // escapeHtml is supplied by the sandbox preamble rather than lifted.
  if (!sandboxDepsResolved(cBodies, C_SANDBOXED, C_SANDBOXED.concat(['escapeHtml']), '§15a-pre')) cFatal = true;

  if (cFatal) {
    console.log('\n❌ §15 cannot check anything without its targets — failing loudly ' +
      'rather than reporting a green run over zero comparisons.');
  } else {
    // A sandbox with a REAL (breakable) acknowledgement store, so dismissal is
    // exercised through the same localStorage path production uses rather than
    // through a stub that cannot disagree with it.
    function makeSandbox15(initialState, storageImpl) {
      const src =
        'return (() => {' +
        "const ACTIVITY_ACK_KEY = 'curator-ingest-activity-ack-v1'; const ACTIVITY_ACK_MAX = 20;" +
        'let state = ' + JSON.stringify(initialState) + ';' +
        'const escapeHtml = (s) => String(s == null ? "" : s)' +
        '.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")' +
        '.replace(/"/g,"&quot;").replace(/\'/g,"&#39;");' +
        cBodies.loadAckedActivityIds + cBodies.isActivityAcked + cBodies.ackActivityId +
        cBodies.settledActivityRecords + cBodies.unackedSettledRecords +
        cBodies.settledElsewhere + cBodies.renderSettledElsewhere +
        'return { get state(){return state;}, settledActivityRecords, unackedSettledRecords,' +
        ' settledElsewhere, renderSettledElsewhere, ackActivityId, isActivityAcked };' +
        '})()';
      return new Function('window', src)({ localStorage: storageImpl });
    }
    function mem15() {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
    }
    const baseState15 = () => ({
      domains: [{ slug: 'articles', displayName: 'Articles' },
                { slug: 'posts', displayName: 'Posts' },
                { slug: 'business', displayName: 'Business' }],
      domain: 'articles', runningDomains: [], settledActivity: [],
      remote: null, remoteResultExpanded: false,
      submitting: false, progress: null, result: null, errorMessage: null,
    });

    const DONE_POSTS = { domain: 'posts', status: 'done', id: 'p-done', finishedAt: 5000, filename: 'paper.pdf' };
    const DONE_BIZ = { domain: 'business', status: 'done', id: 'b-done', finishedAt: 9000, filename: 'deck.pdf' };
    const ERR_POSTS = { domain: 'posts', status: 'error', id: 'p-err', finishedAt: 7000, filename: 'bad.pdf' };

    // ── 15a  Ordering is by finishedAt, and it is TOTAL ────────────────
    // `startedAt` would be the wrong key: the user is asking WHICH ONE
    // FINISHED, and a long run started first can finish last. Ties break on
    // domain so the answer cannot depend on the server's Map iteration order.
    {
      const sb = makeSandbox15(baseState15(), mem15());
      const out = sb.settledActivityRecords([
        { domain: 'posts', status: 'done', id: 'a', finishedAt: 1000 },
        { domain: 'business', status: 'done', id: 'b', finishedAt: 9000 },
        { domain: 'articles', status: 'done', id: 'c', finishedAt: 5000 },
      ]);
      ok(out.map((r) => r.domain).join(',') === 'business,articles,posts',
        '§15a settled records come back NEWEST-FINISHED first (got ' + out.map((r) => r.domain).join(',') + ')');

      // A run that STARTED first but finished last must sort last — this is the
      // assertion that would go red if someone "simplified" the key to startedAt.
      const byStart = sb.settledActivityRecords([
        { domain: 'slow', status: 'done', id: 'a', startedAt: 1, finishedAt: 9000 },
        { domain: 'quick', status: 'done', id: 'b', startedAt: 8000, finishedAt: 8500 },
      ]);
      ok(byStart[0].domain === 'slow',
        '§15a the LONG run that started first but finished LAST sorts first — the key is finishedAt, not startedAt');

      const ties = sb.settledActivityRecords([
        { domain: 'zeta', status: 'done', id: 'z', finishedAt: 100 },
        { domain: 'alpha', status: 'done', id: 'a', finishedAt: 100 },
      ]);
      ok(ties[0].domain === 'alpha',
        '§15a ties break on domain ASCENDING, so the order is total and the answer deterministic');

      const undated = sb.settledActivityRecords([
        { domain: 'nodate', status: 'done', id: 'n' },
        { domain: 'dated', status: 'done', id: 'd', finishedAt: 1 },
      ]);
      ok(undated[0].domain === 'dated' && undated[1].finishedAt === null,
        '§15a a record with NO finishedAt sorts LAST and stores null — it must not poison the comparator with NaN');
    }

    // ── 15b  Only settled records, and only usable ones ────────────────
    {
      const sb = makeSandbox15(baseState15(), mem15());
      const out = sb.settledActivityRecords([
        { domain: 'posts', status: 'running', id: 'r', finishedAt: null },
        { domain: 'posts', status: 'done', id: 'd', finishedAt: 1 },
        { domain: 'x', status: 'error', id: 'e', finishedAt: 2 },
        { domain: '', status: 'done', id: 'blank', finishedAt: 3 },
        { domain: 'noid', status: 'done', finishedAt: 4 },
        null,
      ]);
      const ids = out.map((r) => r.id).sort().join(',');
      ok(ids === 'd,e',
        '§15b a RUNNING record is not settled, and a record with no domain or no id is unusable (kept: ' + ids + ')');
      ok(out.every((r) => r.status === 'done' || r.status === 'error'),
        '§15b both terminal statuses survive — a FAILED run is exactly what the user asked about');
    }

    // ── 15c  The acknowledgement is read at CALL time ──────────────────
    // If the filter ran at FETCH time instead, a dismissal would not take
    // effect until the next poll landed — up to 15 s of a notice the user has
    // already put down.
    {
      const st = baseState15();
      const store = mem15();
      const sb = makeSandbox15(st, store);
      sb.state.settledActivity = sb.settledActivityRecords([DONE_POSTS, DONE_BIZ]);

      ok(sb.unackedSettledRecords().length === 2,
        '§15c both settled records start unacknowledged');
      sb.ackActivityId('b-done');
      ok(sb.unackedSettledRecords().map((r) => r.id).join(',') === 'p-done',
        '§15c acking one drops it IMMEDIATELY, with no refetch — the filter is applied at read time');
      ok(sb.state.settledActivity.length === 2,
        '§15c …and the RAW set is untouched, which is what makes that possible');
    }

    // ── 15d  "Elsewhere" means: not selected, and drawable ─────────────
    {
      const st = baseState15();
      const sb = makeSandbox15(st, mem15());
      sb.state.settledActivity = sb.settledActivityRecords([
        DONE_BIZ, DONE_POSTS,
        { domain: 'articles', status: 'done', id: 'a-done', finishedAt: 6000 },
        { domain: 'ghost', status: 'done', id: 'g-done', finishedAt: 9999 },
      ]);
      const out = sb.settledElsewhere();
      const doms = out.map((r) => r.domain).join(',');
      ok(!doms.includes('articles'),
        '§15d the SELECTED domain is excluded — renderRemoteOutcome already shows it in full, and two instruments for one fact is the shape v3.20.0 deletes');
      ok(!doms.includes('ghost'),
        '§15d a domain NOT in state.domains is excluded — "Show me" calls selectDomain, and a slug the sidebar cannot draw would strand the form');
      ok(doms === 'business,posts',
        '§15d …leaving exactly the drawable, non-selected ones, newest first (got ' + doms + ')');
    }

    // ── 15e  THE SIGNATURE MUST SEE BOTH SURFACES ──────────────────────
    // The trap v3.24.1 documented, one release later. The reported scenario —
    // selected `articles`, settled record on `posts` — leaves state.remote NULL,
    // so it takes activitySignature's `if (!r)` fast path. A settled set folded
    // in only AFTER that branch would be recomputed on every poll and NEVER
    // PAINTED: the dead-data shape, reintroduced inside its own fix.
    {
      const sigSrc = code15(cBodies.activitySignature);
      const fastPath = /if\s*\(!r\)\s*return[^;]*;/.exec(sigSrc);
      ok(!!fastPath, '§15e activitySignature still has the no-record fast path (so this check has a subject)');
      ok(!!fastPath && /settled/.test(fastPath[0]),
        '§15e the settled set is folded into the NO-RECORD fast path — the branch the reported scenario actually takes');
      const beforeFast = sigSrc.slice(0, fastPath ? fastPath.index : 0);
      ok(/const\s+settled\s*=/.test(beforeFast),
        '§15e …and it is COMPUTED before that branch, so both arms provably read the same value');
      ok(/settled,/.test(sigSrc.slice(fastPath ? fastPath.index : 0)),
        '§15e the has-record arm carries it too, so the markers repaint whatever the selected domain is doing');
    }

    // ── 15e2  …and it does so BEHAVIOURALLY, not just by shape ─────────
    {
      const st = baseState15();
      const sb15 = new Function('window', 'ACTIVITY',
        'return (() => {' +
        "const ACTIVITY_ACK_KEY = 'k'; const ACTIVITY_ACK_MAX = 20;" +
        'let state = ' + JSON.stringify(st) + ';' +
        cBodies.loadAckedActivityIds + cBodies.isActivityAcked +
        cBodies.settledActivityRecords + cBodies.unackedSettledRecords +
        cBodies.activitySignature +
        'return { get state(){return state;}, settledActivityRecords, activitySignature };' +
        '})()')({ localStorage: { getItem: () => null, setItem: () => {} } }, null);

      // state.remote stays NULL throughout — exactly the reported scenario.
      const before = sb15.activitySignature();
      sb15.state.settledActivity = sb15.settledActivityRecords([DONE_POSTS]);
      const after = sb15.activitySignature();
      ok(before !== after,
        '§15e2 with state.remote NULL, discovering a settled record CHANGES the signature — so the poll repaints and the surfaces actually appear');

      sb15.state.settledActivity = sb15.settledActivityRecords([ERR_POSTS]);
      const afterErr = sb15.activitySignature();
      ok(after !== afterErr,
        '§15e2 a DIFFERENT record changes it again — the id is in the signature, so one outcome replacing another repaints');

      // Status rides along because it picks the WORD on the row.
      const sameIdDone = sb15.settledActivityRecords([{ ...ERR_POSTS, status: 'done' }]);
      sb15.state.settledActivity = sameIdDone;
      ok(sb15.activitySignature() !== afterErr,
        '§15e2 status is in the signature too — Ingested vs Failed is a visible difference on the same id');
    }

    // ── 15f  ADOPTION IS NOT EXTENDED TO SETTLED RECORDS ───────────────
    // A terminal record lives TERMINAL_TTL_MS (30 min), so adopting one would
    // move the destination on EVERY Ingest mount inside that window —
    // including the visit where the user came to ingest something else. The
    // running case has no such problem: it ends when the work ends.
    {
      const adopt = code15(extractFunction(js, 'pickAdoptableDestination'));
      ok(/status\s*===\s*'running'/.test(adopt),
        '§15f adoption still keys on RUNNING only');
      ok(!/'done'/.test(adopt) && !/'error'/.test(adopt),
        '§15f …and considers NO terminal status — a 30-minute-lived settled record must never yank the destination');
      const adoptCaller = code15(extractFunction(js, 'adoptDestination'));
      ok(!/settled/i.test(adoptCaller),
        '§15f adoptDestination does not reach for the settled set either');
    }

    // ── 15g  The line: what it says and when it says nothing ───────────
    {
      const st = baseState15();
      const sb = makeSandbox15(st, mem15());
      ok(sb.renderSettledElsewhere() === '',
        '§15g with nothing settled elsewhere the line renders NOTHING — it cannot become chrome the user learns to ignore');

      sb.state.settledActivity = sb.settledActivityRecords([DONE_POSTS]);
      const one = sb.renderSettledElsewhere();
      ok(/An ingest finished in/.test(one) && /<strong>Posts<\/strong>/.test(one),
        '§15g it names the DOMAIN in words, by display name');
      ok(/paper\.pdf/.test(one),
        '§15g …and the filename, so the user can tell WHICH file it was');
      ok(/data-settled-show="posts"/.test(one),
        '§15g it carries a control that goes to that domain');
      ok(/data-settled-dismiss="p-done"/.test(one),
        '§15g …and one that puts it down without going anywhere');
      ok(!/and \d+ more/.test(one),
        '§15g with a single record it does NOT invent a count of others');

      // A FAILED run must not be reported in the words of a success — the
      // question asked is literally "was this ingested or not".
      sb.state.settledActivity = sb.settledActivityRecords([ERR_POSTS]);
      const bad = sb.renderSettledElsewhere();
      ok(/An ingest failed in/.test(bad) && !/An ingest finished in/.test(bad),
        '§15g a FAILED run says FAILED — reporting it as finished would answer a different question from the one asked');
      ok(/ing-settled-elsewhere failed/.test(bad),
        '§15g …and carries the danger tone as a class, not as coloured text');
    }

    // ── 15h  MULTIPLE settled records: nothing becomes unreachable ─────
    // The line can only point at one domain. That is safe ONLY because the
    // sidebar marks every one of them and dismissing the named one PROMOTES
    // the next. A line that named one while the rest were invisible would be
    // this defect with a smaller blast radius.
    {
      const st = baseState15();
      const sb = makeSandbox15(st, mem15());
      sb.state.settledActivity = sb.settledActivityRecords([DONE_POSTS, DONE_BIZ]);

      const two = sb.renderSettledElsewhere();
      ok(/<strong>Business<\/strong>/.test(two),
        '§15h the line names the NEWEST-finished of several (business at 9000 beats posts at 5000)');
      ok(/and 1 more domain/.test(two),
        '§15h …and states how many others are waiting, so the user knows the line is not the whole story');

      sb.ackActivityId('b-done');
      const promoted = sb.renderSettledElsewhere();
      ok(/<strong>Posts<\/strong>/.test(promoted),
        '§15h dismissing the named one PROMOTES the next — the line is a rotating pointer, so nothing is stranded');
      ok(!/and \d+ more/.test(promoted),
        '§15h …and the count follows it down');

      sb.ackActivityId('p-done');
      ok(sb.renderSettledElsewhere() === '',
        '§15h dismissing the last one clears the line entirely');
    }

    // ── 15i  Escaping ─────────────────────────────────────────────────
    // The filename is user-supplied and reaches innerHTML.
    {
      const st = baseState15();
      st.domains.push({ slug: 'evil', displayName: '<img src=x onerror=alert(1)>' });
      const sb = makeSandbox15(st, mem15());
      sb.state.settledActivity = sb.settledActivityRecords([
        { domain: 'evil', status: 'done', id: 'e1', finishedAt: 1, filename: '<script>alert(1)</script>.pdf' },
      ]);
      const html = sb.renderSettledElsewhere();
      ok(!/<script>/.test(html) && /&lt;script&gt;/.test(html),
        '§15i a hostile FILENAME is escaped, not executed');
      ok(!/<img src=x/.test(html) && /&lt;img/.test(html),
        '§15i a hostile DISPLAY NAME is escaped too');
    }

    // ── 15j  The sidebar marks EVERY settled domain ────────────────────
    {
      const sideSrc = code15(cBodies.renderSidebar);
      ok(/ing-dest-settled/.test(sideSrc),
        '§15j the sidebar renders a settled marker');
      ok(/Ingested/.test(sideSrc) && /Failed/.test(sideSrc),
        '§15j …with DIFFERENT words for a completed and a failed run');
      ok(/unackedSettledRecords\(\)/.test(sideSrc),
        '§15j …driven from the SAME unacknowledged set the main-pane line uses, so one dismissal clears both');
      ok(/isRunning\s*\?\s*null\s*:/.test(sideSrc),
        '§15j a domain that is running AGAIN is described as running, not settled — one row must not say two things at once');
      // The marker is TEXT inside the row <button>, so it reaches the accessible
      // name for free (v3.23.0's finding: a count on an empty span was
      // unreachable by hover, keyboard AND screen reader).
      ok(/<span class="ing-dest-settled/.test(sideSrc),
        '§15j the marker is a text span inside the row button, so it lands in the accessible name');
    }

    // ── 15k  ONE acknowledgement store, not two ────────────────────────
    // The single most likely way to break this later is to give the new line
    // its own dismissal state. Then a record dismissed in the panel would
    // still nag from the line, or vice versa.
    {
      const dis = code15(cBodies.dismissSettledElsewhere);
      ok(/ackActivityId\(/.test(dis),
        '§15k dismissing the line writes the EXISTING acknowledgement');
      ok(!/localStorage/.test(dis),
        '§15k …and does not reach for storage itself — there is one store, with one writer');
      ok(/renderedActivitySignature\s*=\s*activitySignature\(\)/.test(dis),
        '§15k …and refreshes the painted signature, so the next poll does not believe a repaint is still owed');

      // Behavioural: an ack written by the PANEL clears the sidebar/line set too.
      const st = baseState15();
      const store = mem15();
      const sb = makeSandbox15(st, store);
      sb.state.settledActivity = sb.settledActivityRecords([DONE_POSTS]);
      ok(sb.settledElsewhere().length === 1, '§15k precondition — the record is pending');
      sb.ackActivityId('p-done');   // what dismissRemoteOutcome does
      ok(sb.settledElsewhere().length === 0 && sb.unackedSettledRecords().length === 0,
        '§15k an ack written by the OUTCOME PANEL clears the line AND the sidebar marker — one store, both surfaces');
    }

    // ── 15l  Storage that throws must not blank the view ───────────────
    // Failing to READ an acknowledgement means the notice is shown again. That
    // is the safe direction, and it is the same rule v3.8.0 set for its own
    // dismissal: guidance reappearing is harmless; silently hiding an outcome
    // has no visible symptom.
    {
      const throwing = {
        getItem: () => { throw new Error('private mode'); },
        setItem: () => { throw new Error('private mode'); },
      };
      const st = baseState15();
      const sb = makeSandbox15(st, throwing);
      sb.state.settledActivity = sb.settledActivityRecords([DONE_POSTS]);
      let threw = false;
      let out = '';
      try { out = sb.renderSettledElsewhere(); } catch { threw = true; }
      ok(!threw, '§15l a storage that THROWS on read does not take the render down');
      ok(/An ingest finished in/.test(out),
        '§15l …and the outcome is SHOWN rather than hidden — failing to read an ack must fail toward telling the user');
      let threw2 = false;
      try { sb.ackActivityId('p-done'); } catch { threw2 = true; }
      ok(!threw2, '§15l a storage that THROWS on write does not take the dismissal down either');
    }

    // ── 15m  The line survives every body branch ───────────────────────
    // Put inside renderIngestForm it would vanish the moment the user entered
    // batch mode — a moment they are especially likely to be away from where
    // the last file landed.
    {
      const mainSrc = code15(extractFunction(js, 'renderMain'));
      ok(/renderSettledElsewhere\(\)/.test(mainSrc),
        '§15m renderMain renders the line');
      const setMainIdx = mainSrc.indexOf('setMain(');
      const bodyAssign = mainSrc.lastIndexOf('body =');
      ok(setMainIdx > bodyAssign,
        '§15m precondition — the call sits in the setMain composition, after every body branch has been chosen');
      ok(/renderSettledElsewhere\(\)\s*\+\s*\n?\s*body/.test(mainSrc),
        '§15m …and OUTSIDE the branch that produced `body`, so it shows over the form, the queue, the loader and the empty state alike');
      const formSrc = code15(extractFunction(js, 'renderIngestForm'));
      ok(!/renderSettledElsewhere/.test(formSrc),
        '§15m it is NOT inside the single-file form, where entering batch mode would hide it');
    }

    // ── 15n  selectDomain does not clear the settled set ───────────────
    // Every record names its own domain, so nothing in it can be
    // mis-attributed by a selection change — unlike `remote`, which would
    // render under the wrong domain's name and IS cleared.
    {
      const sel = code15(cBodies.selectDomain);
      ok(/state\.remote\s*=\s*null/.test(sel),
        '§15n selectDomain still clears `remote`, which a switch WOULD mis-attribute');
      ok(!/state\.settledActivity\s*=/.test(sel),
        '§15n …and does NOT clear settledActivity, which would blink every marker and the line off on each click');
      ok(!/state\.runningDomains\s*=/.test(sel),
        '§15n …matching the running set, which v3.24.1 left alone for the same reason');
    }

    // ── 15o  refreshActivity recomputes the set every fetch ────────────
    // So a record ageing out of the server's 30-minute TTL clears both
    // surfaces with no client-side expiry logic to get wrong.
    {
      const ra = code15(cBodies.refreshActivity);
      ok(/state\.settledActivity\s*=\s*settledActivityRecords\(got\.activity\)/.test(ra),
        '§15o refreshActivity recomputes the settled set from the server on every fetch');
      ok(!/isActivityAcked/.test(ra),
        '§15o …and stores it RAW — applying the ack here would delay a dismissal until the next poll');
    }


    // ── 15q  CONTRAST PAIRING — added because a mutation stayed GREEN ──
    // Chased, not filed. Mutation M14 repainted the settled marker's LABEL in
    // --success-text and the whole suite stayed at 341/0: §14e guards that
    // pairing for .ing-dest-live and nothing guarded the two rules this
    // release adds. That is the "function executed but its call site never
    // asserted" shape one step sideways — a rule shipped with no assertion on
    // the one property that decides whether it is legible.
    //
    // The pairing rule, measured and recorded in this file's own header:
    // --success-text is 3.79:1 in light and --attention-text 3.21:1, both under
    // the 4.5 AA floor for TEXT. So tone lives in the BORDER and the TINT
    // (3:1 non-text floor, which 3.79 and --danger-text's 4.73+ both clear) and
    // the label stays --text. Same construction as .ing-dest-live above it.
    {
      const settledRule = /\.ing-dest-settled\s*\{([^}]*)\}/.exec(css);
      ok(!!settledRule,
        '§15q the settled marker has a real CSS rule (a class with no rule renders as unstyled text — the v3.9.1 styled-but-unlinked shape)');
      if (settledRule) {
        ok(/color:\s*var\(--text\)/.test(settledRule[1]),
          '§15q its LABEL is --text — --success-text as text on --success-tint measures 3.79:1 in light, under the 4.5 AA floor');
        ok(/border:[^;]*var\(--success-text\)/.test(settledRule[1]) &&
           /background:\s*var\(--success-tint\)/.test(settledRule[1]),
          '§15q …with the TONE carried by border and tint, matching .ing-dest-live so the sidebar speaks with one voice');
      }
      const failedRule = /\.ing-dest-settled\.failed\s*\{([^}]*)\}/.exec(css);
      ok(!!failedRule && /var\(--danger-text\)/.test(failedRule[1]) && /var\(--danger-tint\)/.test(failedRule[1]),
        '§15q a FAILED run is toned differently from a successful one — the words differ, and so does the colour');
      // The boundary is load-bearing: an unanchored /color:/ also matches the
      // `border-color:` this rule legitimately sets, so the first draft of this
      // assertion failed on correct CSS. Caught by running it, not by reading it.
      ok(!failedRule || !/(?:^|[;{\s])color:\s*var\(--danger-text\)/.test(failedRule[1]),
        '§15q …without repainting the LABEL, which would reintroduce the sub-AA text pairing on the failure case');

      const lineRule = /\.ing-settled-elsewhere\s*\{([^}]*)\}/.exec(css);
      ok(!!lineRule, '§15q the main-pane line has a real CSS rule');
      if (lineRule) {
        ok(/border:[^;]*var\(--success-text\)/.test(lineRule[1]) &&
           /background:\s*var\(--success-tint\)/.test(lineRule[1]),
          '§15q …toned by border and tint, the same grammar as the markers');
        ok(!/color:\s*var\(--success-text\)/.test(lineRule[1]),
          '§15q …and never paints text in the tone colour');
      }
      const lineText = /\.ing-settled-elsewhere-text\s*\{([^}]*)\}/.exec(css);
      ok(!!lineText && /color:\s*var\(--text\)/.test(lineText[1]),
        '§15q the sentence itself is at FULL contrast — it is the one thing on screen answering "did my ingest finish"');
      ok(/\.ing-settled-elsewhere-more\s*\{[^}]*var\(--text-2\)/.test(css),
        '§15q the "and N more" count is --text-2, not --text-3 (v3.19.0 measured --text-3 at 4.38 dark / 4.00 light, under the 4.5 floor) — it is a count the user acts on');

      // CONTROLS — the failing pairings are asserted ABSENT by name, so a
      // future edit cannot quietly reintroduce them and leave the fix looking
      // unnecessary.
      ok(!/\.ing-dest-settled\s*\{[^}]*color:\s*var\(--success-text\)/.test(css),
        '§15q CONTROL — the sub-AA marker pairing is asserted ABSENT (this is exactly what M14 mutated in, and what stayed green before this block existed)');
      ok(!/\.ing-settled-elsewhere-text\s*\{[^}]*color:\s*var\(--text-3\)/.test(css),
        '§15q CONTROL — the line does not drop to --text-3 either');
      // Anti-vacuity: prove these scans can actually see a rule in this file.
      ok(/\.ing-dest-live\s*\{[^}]*color:\s*var\(--text\)/.test(css),
        '§15q CONTROL — the rule scans match a KNOWN-GOOD sibling, so a green above means "correct", not "matched nothing"');
    }

    // ── 15p  CONTROLS: these scans can fail ────────────────────────────
    {
      ok(!/ing-dest-settled/.test(code15(cBodies.refreshActivity)),
        '§15p CONTROL — the render scans do NOT match an unrelated function');
      ok(!/renderSettledElsewhere/.test(code15(cBodies.selectDomain)),
        '§15p CONTROL — the renderMain scan is not satisfied by any function that merely mentions the name');
      const st = baseState15();
      const sb = makeSandbox15(st, mem15());
      ok(sb.settledActivityRecords([]).length === 0 && sb.settledActivityRecords(null).length === 0,
        '§15p CONTROL — an empty or absent activity list yields nothing rather than throwing');
    }
  }
}

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ /next Ingest view assertions green');
else console.log('❌ ' + failed + ' assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
