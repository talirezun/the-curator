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

const NEEDED = ['formatDestinationMeta', 'isFilePickerAvailable', 'selectDomain', 'renderSidebar', 'renderDropZoneHtml', 'loadDomains'];
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

const assignRe = /state\.domain\s*=/g;
const writers = [];
let am;
while ((am = assignRe.exec(js)) !== null) {
  writers.push(enclosingFunctionName(js, am.index) || '(module scope / unknown)');
}
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
const ALLOWED_WRITERS = new Set([
  'selectDomain', 'freshState', 'loadDomains', 'applyQueueJobSnapshot', 'checkActiveQueueJob',
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

const selectListener = /domainSelect\.addEventListener\('change',\s*\(e\)\s*=>\s*selectDomain\(/;
ok(selectListener.test(js), 'the <select> change handler routes through selectDomain');
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

ok(/readonlyDomains/.test(bodies.loadDomains) && /!readonly\.has\(d\.slug\)/.test(bodies.loadDomains),
  'loadDomains still filters readonlyDomains out — one filter feeds BOTH the ' +
  '<select> and the new sidebar list, so a mirror cannot appear in either');

// ── §8 — the stats fields reach a consumer (the dead-data guard) ────────
console.log('\n§ 8  pageCount / lastIngestDate are parsed AND consumed');

ok(/pageCount:/.test(bodies.loadDomains) && /lastIngestDate:/.test(bodies.loadDomains),
  'loadDomains keeps pageCount and lastIngestDate off the wire');
ok(/formatDestinationMeta\(/.test(bodies.renderSidebar),
  'renderSidebar CONSUMES them — this repo\'s recurring defect is a producer ' +
  'doing honest work and the layer above throwing the answer away');
ok(/d\.pageCount/.test(bodies.formatDestinationMeta) && /d\.lastIngestDate/.test(bodies.formatDestinationMeta),
  'formatDestinationMeta reads both fields by name');

// ── §9 — the select's chrome ────────────────────────────────────────────
console.log('\n§ 9  The <select> chevron is CSS-drawn and follows the theme');

ok(/select\.ing-select\s*\{[^}]*appearance:\s*none/.test(css),
  'appearance: none is applied to the select');
ok(/select\.ing-select\s*\{[^}]*-webkit-appearance:\s*none/.test(css),
  '-webkit-appearance is present too (Safari still needs the prefix)');
ok(/select\.ing-select\s*\{/.test(css),
  'the rule is TYPE-QUALIFIED as `select.ing-select`');
ok(!/^\s*\.ing-select\s*\{[^}]*appearance:/m.test(css),
  'the unqualified .ing-select rule does NOT set appearance — .ing-select is ' +
  'shared with the batch confirm gate\'s <input type="number"> budget field, ' +
  'and an unqualified rule would strip that input\'s spinner too');

const chevron = /\.ing-select-wrap::after\s*\{([\s\S]*?)\}/.exec(css);
ok(!!chevron, 'a ::after chevron rule exists on the wrapper');
if (chevron) {
  ok(/border-right:[^;]*var\(--text-2\)/.test(chevron[1]) &&
     /border-bottom:[^;]*var\(--text-2\)/.test(chevron[1]),
    'the chevron is two rotated BORDERS taking a theme token');
  ok(/rotate\(45deg\)/.test(chevron[1]), 'rotated 45deg into a chevron');
  ok(!/url\(/.test(chevron[1]),
    'NOT a background-image data URI — a data URI carries its own colour, so ' +
    'it cannot follow the theme and would need one copy per theme');
  ok(/pointer-events:\s*none/.test(chevron[1]),
    'pointer-events: none so the click still reaches the select');
}
ok(/\.ing-select-wrap\s*\{[^}]*position:\s*relative/.test(css),
  'the wrapper is positioned so the chevron can anchor to it');
ok(/OPEN dropdown list is\s*\n?\s*drawn by the OS/.test(css) ||
   /OPEN dropdown list is[\s\S]{0,80}OS/.test(css),
  'the stylesheet STATES that the open dropdown list stays OS-drawn and CSS ' +
  'cannot reach it, rather than implying the problem away');
ok(!/base-select/.test(css.replace(/Chromium-only today[\s\S]{0,60}/, '')) ||
   /Chromium-only/.test(css),
  'if appearance: base-select is mentioned at all, it is recorded as the ' +
  'Chromium-only option that was NOT taken');

// Every select in this view must be inside the wrapper, or it has no chevron.
const selectTags = js.match(/<select class="ing-select"/g) || [];
const wrapOpen = js.match(/<span class="ing-select-wrap">/g) || [];
ok(selectTags.length >= 2, 'both selects (single-file form + confirm gate) are present');
ok(wrapOpen.length === selectTags.length,
  'EVERY .ing-select select is wrapped in .ing-select-wrap (' + selectTags.length +
  ' selects, ' + wrapOpen.length + ' wrappers) — an unwrapped one silently loses ' +
  'its chevron while still having appearance: none, i.e. no affordance at all');

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

// ── Summary ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ /next Ingest view assertions green');
else console.log('❌ ' + failed + ' assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
