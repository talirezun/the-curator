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
const ALLOWED_WRITERS = new Set([
  'selectDomain', 'freshState', 'loadDomains', 'applyQueueJobSnapshot', 'checkActiveQueueJob',
  'refreshDomainStats',
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

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ /next Ingest view assertions green');
else console.log('❌ ' + failed + ' assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
