#!/usr/bin/env node
/**
 * ── ADOPTION: Agent memory and Ingest render through shared/text.js ─────────
 *
 * scripts/test-next-text-system.js proves the five roles are correct and
 * single-source. It does NOT prove anything USES them — and that is the gap
 * this file exists for.
 *
 * A COMPONENT THAT SHIPS UNUSED IS THIS REPO'S NAMED FAILURE SHAPE. v3.16.0
 * found `fetchOpenRouterCatalogue`, `openRouterRecordToSpec` and
 * `setOpenRouterCatalogue` "all built, tested and documented in v3.15.0 and
 * invoked from NOWHERE in production", which is why a public README promised
 * hundreds of models while nothing populated the list. Every one of those had
 * a passing suite. So the precedent followed here is test-next-cost-honesty.js,
 * which pins the IMPORT SITE of shared/format-usd.js in each consuming view
 * rather than trusting that a shared module is reached.
 *
 * ── WHAT IS ENFORCED ───────────────────────────────────────────────────────
 *
 *   §1  IMPORT SITES. Both views import from shared/text.js, by exact line.
 *   §2  REACHED. Every imported name has real call sites — an import that is
 *       never called is dead weight that a `grep` for the import would pass.
 *   §3  NO LOCAL RE-GROWTH. Neither view has re-invented the roles it adopted:
 *       the specific classes retired here do not come back.
 *   §4  BEHAVIOURAL — the real memory render functions, executed, asserted on
 *       OUTPUT. A source scan cannot tell a rendered element from a mentioned
 *       one; §4 runs the shipped code.
 *   §5  BEHAVIOURAL — the real ingest render functions, same rule, including
 *       the two properties that carry money: a warning on the spending surface
 *       is never inside a fold, and the accepted-formats line is DERIVED.
 *   §6  CSS HYGIENE in the two adopted stylesheets: no frozen px font-size, no
 *       undefined custom property, and the sub-floor text token is not used as
 *       a body-prose colour.
 *   §7  READ-ONLY. The memory view still has no write affordance.
 *   §8  POSITIVE CONTROLS — every detector in this file is shown to fire.
 *
 * ── WHAT IS NOT ENFORCED, named rather than implied away ───────────────────
 *
 *   · No assertion here measures REAL RENDERING, layout or contrast. Contrast
 *     was measured in a browser during the change and the numbers are in the
 *     report; nothing in Node re-derives them, so a token re-point that lowers
 *     contrast is invisible to this file.
 *   · §3's scans are NAME-scoped. A retired role re-grown under a DIFFERENT
 *     class name evades them — the same limit shared/text.js's own suite
 *     records for its no-local-copy scan, and the reason §2 asserts reach
 *     rather than only absence.
 *   · §2 counts call sites in stripped source. A call inside a string literal
 *     would be counted; nothing in these two views constructs a call that way.
 *   · The two views' OTHER text classes are untouched and unasserted. This is
 *     an adoption pass, not a sweep.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, functionSource, callSiteCount } from './test-helpers/source-scan.js';

// Executable in Node BY DESIGN: shared/text.js takes no imports, precisely so
// a suite can run it rather than scan it. Anything importing next/app.js
// throws `ReferenceError: document is not defined` at module scope.
import {
  renderDescription, renderStatus, renderReadout, renderReadoutGroup, renderExplainer,
} from '../src/public/next/shared/text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEXT = join(__dirname, '..', 'src', 'public', 'next');
const read = (rel) => readFileSync(join(NEXT, rel), 'utf8');

const memSrc = read('views/memory.js');
const ingSrc = read('views/ingest.js');
const memCss = read('views/memory.css');
const ingCss = read('views/ingest.css');
const memCode = stripComments(memSrc);
const ingCode = stripComments(ingSrc);

let passed = 0, failed = 0;
function ok(label, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra ? `\n      ${String(extra).slice(0, 400)}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// A stripped source that came back empty would make every scan below pass
// vacuously — the exact shape source-scan.js exists to stop.
ok('memory.js stripped source is sane (the scans below are not vacuous)',
  memCode.length > 20000 && memCode.includes('function renderSidebar('), memCode.length);
ok('ingest.js stripped source is sane', ingCode.length > 20000 && ingCode.includes('function renderMain('), ingCode.length);

// ═══════════════════════════════════════════════════════════════════════════
section('§1  IMPORT SITES — the shared module is reached, not re-implemented');
// ═══════════════════════════════════════════════════════════════════════════
// Pinned as a LINE, the way test-next-cost-honesty.js pins format-usd.js in
// domains.js and ingest.js. A bare "does the filename appear" scan is
// satisfied by a comment mentioning it.

const IMPORT_RE = /^import \{[^}]+\} from '\.\.\/shared\/text\.js';$/m;
ok('memory.js imports from ../shared/text.js', IMPORT_RE.test(memCode));
ok('ingest.js imports from ../shared/text.js', IMPORT_RE.test(ingCode));

const memImports = (memCode.match(/import \{([^}]+)\} from '\.\.\/shared\/text\.js';/) || [, ''])[1]
  .split(',').map((s) => s.trim()).filter(Boolean);
const ingImports = (ingCode.match(/import \{([^}]+)\} from '\.\.\/shared\/text\.js';/) || [, ''])[1]
  .split(',').map((s) => s.trim()).filter(Boolean);
ok('memory.js imports at least three of the five roles', memImports.length >= 3, memImports.join(','));
ok('ingest.js imports at least two of the five roles', ingImports.length >= 2, ingImports.join(','));

// ═══════════════════════════════════════════════════════════════════════════
section('§2  REACHED — every import has real call sites');
// ═══════════════════════════════════════════════════════════════════════════
// THE ASSERTION THAT ACTUALLY CLOSES THE v3.16.0 SHAPE. An import with no
// caller is exactly the state `fetchOpenRouterCatalogue` shipped in, and §1
// alone would pass over it. callSiteCount subtracts declarations, so the
// import itself is not miscounted as a use.

for (const name of memImports) {
  const n = callSiteCount(memSrc, name);
  ok(`memory.js CALLS ${name} (${n} site${n === 1 ? '' : 's'})`, n > 0, `${n} call sites`);
}
for (const name of ingImports) {
  const n = callSiteCount(ingSrc, name);
  ok(`ingest.js CALLS ${name} (${n} site${n === 1 ? '' : 's'})`, n > 0, `${n} call sites`);
}

// The two named asks, pinned to the FUNCTION that must contain them, so a
// call somewhere else in the file cannot satisfy them.
ok('memory.js: the About fold is the shared explainer (renderExplainer inside renderAbout)',
  callSiteCount(memSrc, 'renderExplainer', { within: 'renderAbout' }) > 0);
ok('memory.js: the sidebar error is a STATUS, not a hint (renderStatus inside renderSidebar)',
  callSiteCount(memSrc, 'renderStatus', { within: 'renderSidebar' }) > 0);
ok('memory.js: the journal count is a READOUT (renderReadout inside renderJournal)',
  callSiteCount(memSrc, 'renderReadout', { within: 'renderJournal' }) > 0);
ok('memory.js: the handoff provenance is a READOUT (renderReadout inside renderHandoff)',
  callSiteCount(memSrc, 'renderReadout', { within: 'renderHandoff' }) > 0);
// EXPIRED CLAIM, REPLACED — the assertion was right and its premise is gone.
// It pinned a renderDescription call inside ingest's renderMain, i.e. a
// paragraph rendered under the <h1>. That paragraph is DELETED: every clause of
// it was already on screen in the drop zone below. The header now goes through
// renderViewHeader, which has no parameter that can render prose there. So the
// claim is inverted rather than deleted: renderMain must reach the header
// component, and must NOT reach the description role.
ok('ingest.js: renderMain builds its header with renderViewHeader',
  callSiteCount(ingSrc, 'renderViewHeader', { within: 'renderMain' }) > 0);
ok('ingest.js: renderMain paints NO description — the header has no slot for one',
  callSiteCount(ingSrc, 'renderDescription', { within: 'renderMain' }) === 0);
ok('ingest.js: the sidebar hint moved behind the info mark, not into a floating hint div',
  callSiteCount(ingSrc, 'renderViewHeader', { within: 'renderSidebar' }) > 0);
ok('ingest.js: the cost estimate is a READOUT GROUP (inside renderQueueEstimate)',
  callSiteCount(ingSrc, 'renderReadoutGroup', { within: 'renderQueueEstimate' }) > 0);

// ═══════════════════════════════════════════════════════════════════════════
section('§3  NO LOCAL RE-GROWTH — the retired roles do not come back');
// ═══════════════════════════════════════════════════════════════════════════
// NAME-scoped, and that limit is stated in the header rather than implied
// away. It catches the realistic regression — someone reinstating the class
// that was there — not a determined rename.

const RETIRED_MEM = ['mem-quiet', 'mem-inline-error', 'mem-error-text', 'mem-doc-empty-body', 'mem-doc-who'];
for (const cls of RETIRED_MEM) {
  ok(`memory.js no longer emits .${cls}`, !new RegExp(`class="[^"]*\\b${cls}\\b`).test(memCode));
  ok(`memory.css no longer defines .${cls}`, !new RegExp(`^\\.${cls}[\\s{,:]`, 'm').test(stripComments(memCss)));
}
ok('ingest.js no longer borrows settings.css’s .settings-inline-error',
  !/settings-inline-error/.test(ingCode));
ok('ingest.css no longer carries its copy of that rule',
  !/^\.settings-inline-error[\s{,:]/m.test(stripComments(ingCss)));

// The description role replaced .view-body's DESCRIPTION meaning in ingest.
// Its LOADING meaning survives — shared/loading-gate.js defaults to that class
// — so the assertion is about where it appears, not that it is gone.
{
  const rm = functionSource(ingCode, 'renderMain');
  ok('ingest.js renderMain no longer paints a .view-body description',
    rm !== null && !/class="view-body"/.test(rm), rm && rm.slice(0, 200));
  ok('...while .view-body SURVIVES elsewhere as the loading-placeholder role it shares with loading-gate.js',
    /class="view-body"/.test(ingCode));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  BEHAVIOURAL — the real memory renderers, asserted on OUTPUT');
// ═══════════════════════════════════════════════════════════════════════════
// Lifted and EXECUTED with every collaborator injected, the same technique
// test-next-memory-view.js uses. A source scan cannot distinguish an element
// that renders from one that is merely mentioned.

function lift(names, src, label) {
  const bodies = names.map((n) => {
    const b = functionSource(src, n);
    if (b === null) throw new Error(`lift: ${n} not found in ${label} — the scan would pass vacuously`);
    return b.replace(/^export\s+/, '');
  }).join('\n');
  return bodies + '\nreturn { ' + names.join(', ') + ' };';
}

function memRenderers(stateObj) {
  // `effectiveSave` joins the list because renderHandoff now reads the save
  // time through it: the shipped field `current.savedAt` is filesystem mtime,
  // which git rewrites on checkout, so the byline was dating every synced
  // handoff to the moment of the pull. It falls back to mtime when no journal
  // entry carried a time, which is what the fixtures below exercise.
  const body = lift(['formatAge', 'effectiveSave', 'splitHandoffPreamble', 'renderHandoff',
    'renderJournal', 'renderBrief', 'renderAbout'], memSrc, 'memory.js');
  return new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'gatedLoader', 'loadGate',
    'JOURNAL_PAGE', 'JOURNAL_MORE',
    'renderDescription', 'renderStatus', 'renderReadout', 'renderExplainer', body)(
    stateObj, (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    () => '<svg></svg>', (s) => '<p>' + s + '</p>', () => '<div class="loader"></div>', null, 10, 50,
    renderDescription, renderStatus, renderReadout, renderExplainer);
}

const baseDetail = {
  scope: 'main', machine: 'mac-1', machineIsThisMachine: true, machines: [{ machine: 'mac-1', ageSeconds: 60 }],
  current: { present: true, text: '# T\n\n> A headline\n\n## Where things stand\n\nBody.\n',
    savedAt: new Date(Date.now() - 7200_000).toISOString(), truncated: false, sanitisedOnRead: false },
  journal: { returned: 3, total: 3, totalUnknown: false,
    entries: [{ at: '2026-08-28T10:00:00.000Z', harness: 'claude-code', model: 'opus-5', headline: 'H', rejections: [] }] },
};
const baseState = {
  activeProject: 'projects', scope: 'main', machine: 'mac-1', detail: baseDetail,
  detailLoading: false, journalLimit: 10, openFolds: {},
  projectRead: { scopes: [{ scope: 'main' }], brief: { present: false } },
};

{
  const R = memRenderers(baseState);
  const about = R.renderAbout();

  // THE FOUR PROPERTIES THE EXPLAINER MUST KEEP.
  ok('About renders a NATIVE <details> (keyboard + AT support come free)', /<details\b/.test(about), about.slice(0, 160));
  ok('About is DEFAULT CLOSED — needed once, then never again', !/<details[^>]*\sopen[\s>]/.test(about), about.slice(0, 160));
  ok('About uses the SHARED explainer, not a re-implemented fold',
    /class="tx-explainer"/.test(about) && !/mem-fold-summary/.test(about), about.slice(0, 200));
  ok('About still carries an identity the open-fold memory can key on',
    /data-tx-explainer="about"/.test(about), about.slice(0, 200));
  ok('About renders NO warning box — it explains a mechanism and carries no caution',
    !/tx-status/.test(about));

  // ...and it re-opens when the user has opened it, which is the whole point
  // of tracking the fold at all.
  const opened = memRenderers({ ...baseState, openFolds: { about: true } }).renderAbout();
  ok('About re-opens when the user has opened it before', /<details[^>]*\sopen[\s>]/.test(opened), opened.slice(0, 160));

  // The handoff's provenance is an instrument.
  const h = R.renderHandoff();
  ok('the handoff renders a READOUT for when it was saved', /class="tx-readout"/.test(h), h.slice(0, 300));
  ok('...with the age as the VALUE', /class="tx-readout-value">2 hr ago</.test(h), h.slice(0, 400));
  ok('...and harness + model as its PROVENANCE',
    /class="tx-readout-prov">claude-code · opus-5</.test(h), h.slice(0, 500));
  ok('...and the exact ISO stamp is still reachable on hover',
    new RegExp('title="' + baseDetail.current.savedAt + '"').test(h), h.slice(0, 300));

  // ABSENT IS NOT ZERO — the component's most load-bearing rule, at the site
  // where this view could most easily have broken it.
  const noProv = memRenderers({
    ...baseState,
    detail: { ...baseDetail, current: { ...baseDetail.current, savedAt: null }, journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } },
  }).renderHandoff();
  ok('no save time and no journal entry renders NO readout at all — never "unknown", never a dash',
    !/tx-readout/.test(noProv) && !/unknown/i.test(noProv), noProv.slice(0, 300));

  // Each fact still shown when only the OTHER is missing: consolidating two
  // elements into one instrument must not be able to drop one of them.
  const onlyWho = memRenderers({
    ...baseState,
    detail: { ...baseDetail, current: { ...baseDetail.current, savedAt: null } },
  }).renderHandoff();
  ok('with no save time but a known author, the AUTHOR is still stated',
    /tx-readout-value">claude-code · opus-5</.test(onlyWho), onlyWho.slice(0, 400));
  const onlyWhen = memRenderers({
    ...baseState,
    detail: { ...baseDetail, journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } },
  }).renderHandoff();
  ok('with a save time but no known author, the TIME is still stated',
    /tx-readout-value">2 hr ago</.test(onlyWhen) && !/tx-readout-prov/.test(onlyWhen), onlyWhen.slice(0, 400));

  // The journal count is a figure, not a sentence — and the framing prose
  // beside it is a description, so the two no longer share a voice.
  const j = R.renderJournal();
  ok('the journal count renders as a READOUT figure', /class="tx-readout-value">3</.test(j), j.slice(-500));
  ok('the journal framing renders as a DESCRIPTION', /class="tx-desc"/.test(j), j.slice(0, 500));
  ok('an explanation and a measurement no longer share one class',
    !/mem-quiet/.test(j), j.slice(0, 300));

  // An unknown total must still not print the tail length as if it were one.
  const unknown = memRenderers({
    ...baseState,
    detail: { ...baseDetail, journal: { returned: 2, total: null, totalUnknown: true, totalUnknownReason: 'journal is huge', entries: baseDetail.journal.entries } },
  }).renderJournal();
  ok('an unknown journal total still says UNKNOWN in the readout provenance',
    /tx-readout-prov[^<]*>[^<]*unknown/i.test(unknown), unknown.slice(-500));
  ok('...and still does NOT print the tail length as the total', !/>2 saves recorded/.test(unknown));

  // The brief's "not written" prose is a description, not a fourth grey.
  const brief = R.renderBrief(baseState.projectRead, false);
  ok('the "no standing brief" prose renders as a DESCRIPTION', /class="tx-desc"/.test(brief), brief.slice(0, 300));
}

// ESCAPING, through the real path. The component escapes internally; this
// proves the view did not opt into raw HTML where a value flows through.
{
  const XSS = '<img src=x onerror=alert(1)>';
  const R = memRenderers({
    ...baseState,
    detail: { ...baseDetail,
      current: { ...baseDetail.current, present: false },
      journal: { returned: 1, total: 1, totalUnknown: false, entries: [{ at: null, harness: XSS, model: XSS, headline: XSS, rejections: [] }] } },
    projectRead: { scopes: [], brief: { present: false } },
  });
  const out = R.renderHandoff() + R.renderJournal();
  ok('the hostile fixture produced markup (not an empty string)', out.length > 300, out.length);
  ok('no raw <img> survives anywhere in the adopted output', !/<img\s/i.test(out), out.slice(0, 300));
}

// The store's own message reaches the screen through the description role —
// the v3.17.1 defect was this sentence being dropped entirely.
{
  const noHandoff = memRenderers({
    ...baseState,
    detail: { ...baseDetail, current: { present: false }, message: 'STORE-SAYS-SO' },
  }).renderHandoff();
  ok('the store’s own "nothing here" sentence is rendered, in the description role',
    /class="tx-desc"[^>]*>[^<]*STORE-SAYS-SO/.test(noHandoff), noHandoff.slice(0, 300));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  BEHAVIOURAL — the real ingest renderers, including the money ones');
// ═══════════════════════════════════════════════════════════════════════════

function ingRenderers(stateObj) {
  const body =
    functionSource(ingSrc, 'renderQueueEstimate').replace(/^export\s+/, '') + '\n' +
    functionSource(ingSrc, 'renderQueuePausedBanner').replace(/^export\s+/, '') + '\n' +
    'return { renderQueueEstimate, renderQueuePausedBanner };';
  return new Function('state', 'escapeHtml', 'icon',
    'resolveEstimateFileList', 'renderQueueRejectedItem', 'renderQueueFileListItem',
    'formatQueueBytes', 'formatUsdRange', 'formatTokenRange', 'pausedReasonCopy',
    'renderStatus', 'renderReadoutGroup', body)(
    stateObj, (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    () => '<svg></svg>',
    (est, sel) => sel, () => '<li>r</li>', () => '<li>f</li>',
    (b) => b + ' B', (lo, hi) => '$' + lo + ' – $' + hi, (lo, hi) => lo + '–' + hi,
    (r) => ({ title: 'Paused — ' + r, body: 'Recoverable. Resume when ready.' }),
    renderStatus, renderReadoutGroup);
}

{
  const est = {
    files: { count: 2, totalBytes: 2048, rejected: [] },
    provider: 'gemini', model: 'flash-lite',
    estimate: { usdLow: 0.01, usdHigh: 0.05, inputTokensLow: 1, inputTokensHigh: 2,
      outputTokensLow: 3, outputTokensHigh: 4, basis: 'measured against an empty domain' },
    warnings: ['This batch is large.', 'One file is a scanned PDF.'],
  };
  const R = ingRenderers({ selectedFiles: [{ name: 'a' }, { name: 'b' }], queueBudgetInput: '', queueOverwriteInput: false, queueSubmitting: false });
  const out = R.renderQueueEstimate(est);

  ok('the cost estimate renders as a READOUT GROUP', /class="tx-readout-group"/.test(out), out.slice(0, 400));
  ok('...with the cost as a figure', /tx-readout-value">\$0\.01 – \$0\.05</.test(out), out.slice(0, 900));
  ok('...and the estimator’s basis as PROVENANCE on the cost it qualifies',
    /tx-readout-prov">measured against an empty domain</.test(out), out.slice(0, 900));

  // THE MONEY INVARIANT. v3.16.1: "a warning behind a click is not a warning."
  ok('an estimator warning renders as a STATUS box', /class="tx-status tx-status-attention"/.test(out), out.slice(0, 600));
  ok('...and is NOT inside any fold — there is no <details> on this surface at all',
    !/<details/.test(out), out.slice(0, 400));
  ok('...and both warning lines survive',
    /This batch is large\./.test(out) && /One file is a scanned PDF\./.test(out), out.slice(0, 900));

  // ABSENT IS NOT ZERO on the spending surface: no basis, no provenance line.
  const noBasis = R.renderQueueEstimate({ ...est, estimate: { ...est.estimate, basis: null }, warnings: [] });
  ok('no basis renders NO provenance line — never "—", never a fabricated one',
    !/tx-readout-prov/.test(noBasis), noBasis.slice(0, 800));
  ok('no warnings renders NO status box', !/tx-status/.test(noBasis), noBasis.slice(0, 400));

  // A pause is recoverable, so it is `attention` and never `danger`.
  const paused = R.renderQueuePausedBanner({ pausedReason: 'rate_limit', pausedMessage: 'retry in 60s' });
  ok('a paused batch renders a STATUS box', /class="tx-status/.test(paused), paused);
  ok('...toned ATTENTION, not danger — every pause reason is recoverable',
    /tx-status-attention/.test(paused) && !/tx-status-danger/.test(paused), paused);
  ok('...and the server’s own pause message survives (it names what to act on)',
    /retry in 60s/.test(paused), paused);
  const noMsg = R.renderQueuePausedBanner({ pausedReason: 'budget' });
  ok('...while an absent pause message adds nothing', /Resume when ready\.<\/div>/.test(noMsg), noMsg);
}

// THE DERIVED FORMATS LINE — and its premise expired with the sentence it
// served. The rule it encoded ("never replace a derived value with a typed
// one") is intact and still asserted; what changed is that renderMain no longer
// states the formats AT ALL. The sentence that typed them was deleted because
// the drop zone directly beneath it already showed the same derived list, and
// the second derivation that fed it went with it — an unread computation over
// the very constant this block exists to protect.
//
// So the assertion is inverted, not dropped: renderMain must type no extension
// (the original rule, still binding) AND must not re-grow a second derivation
// (the duplication that made the sentence a liability in the first place).
{
  const rm = functionSource(ingCode, 'renderMain');
  ok('renderMain types NO extension out — the never-hand-maintain-a-derived-fact rule, unchanged',
    rm !== null && !/'\.pdf'|'\.md'|'\.txt'/.test(rm), rm && rm.slice(0, 300));
  ok('...and carries NO second derivation of the list either: exactly one reader below',
    rm !== null && !/ALLOWED_EXT/.test(rm), rm && rm.slice(0, 300));
  // The drop zone must KEEP its own inline derivation: test-next-ingest-view.js
  // asserts `ALLOWED_EXT ... .map(` inside that function, so hoisting a shared
  // builder out of it would defeat the guard that stops it regressing.
  const dz = functionSource(ingCode, 'renderDropZoneHtml');
  ok('the drop zone still derives its own list inline (its own guard depends on it)',
    dz !== null && /ALLOWED_EXT[\s\S]{0,40}\.map\(/.test(dz));
  // ONE constant, and only one.
  const decls = (ingCode.match(/const ALLOWED_EXT\s*=/g) || []).length;
  ok('ALLOWED_EXT is declared exactly ONCE — two readers, no second copy of the fact',
    decls === 1, `${decls} declarations`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  CSS hygiene in the two adopted stylesheets');
// ═══════════════════════════════════════════════════════════════════════════

for (const [name, css] of [['memory.css', memCss], ['ingest.css', ingCss]]) {
  const px = [...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => m[0]);
  ok(`${name}: NO frozen px font-size — --font-scale multiplies the --text-* ramp, ` +
     `so a px literal silently freezes at 1x while everything around it grows ` +
     `(found: ${px.join(', ') || 'none'})`, px.length === 0);

  const sizes = [...css.matchAll(/font-size:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
  ok(`${name}: every font-size reads a --text-* ramp token (${sizes.length} declarations)`,
     sizes.length > 0 && sizes.every((s) => /^--text-/.test(s)),
     sizes.filter((s) => !/^--text-/.test(s)).join(','));

  ok(`${name}: --text-dim is NOT referenced — it does not exist, and an undefined ` +
     `custom property fails SILENTLY at computed-value time (v3.0.12 shipped invisible text)`,
     !/var\(--text-dim\)/.test(css));

  ok(`${name}: no \`tx-\` selector — shared/text.js owns the type AND geometry of its ` +
     `roles, and a view may only place them`, !/\.tx-[a-z]/.test(css));
}

// Every var() resolves. An undefined one is invisible until someone reads the
// rendered page — which is exactly how --text-dim shipped.
{
  const tokenCss = ['color', 'space', 'shape', 'typography', 'motion']
    .map((n) => read('tokens/' + n + '.css')).join('\n');
  const shell = read('shell.css');
  for (const [name, css] of [['memory.css', memCss], ['ingest.css', ingCss]]) {
    const defined = new Set([...(tokenCss + shell + css).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
    const undef = [...new Set(used)].filter((v) => !defined.has(v));
    ok(`${name}: every var() resolves to a real token (undefined: ${undef.join(', ') || 'none'})`,
       undef.length === 0);
  }
}

// THE SUB-FLOOR TOKEN, retired for body prose BY CONSTRUCTION rather than by
// a colour sweep. memory.css's own comments measure --text-3 at 3.87–4.38
// across every surface in the file, against a 4.5:1 AA floor.
//
// ── THIS GUARD HAD GONE VACUOUS, AND THAT IS WORTH RECORDING ─────────────
// It read every rule in memory.css carrying `color: var(--text-3)` and asserted
//     hits.every((sel) => /mem-row-quiet|mem-j-rej/.test(sel))
// Both of those selectors have since been removed from memory.css, and so has
// every other --text-3 declaration in it. `hits` is therefore EMPTY, and
// `[].every(...)` is TRUE — so the assertion passed while checking nothing, and
// the allow-list was a stale exemption matching no selector at all. A guard that
// cannot fail is this repo's single most recurring defect, and it had BOTH of
// its known shapes at once: the vacuous-`.every()` shape and the
// exemption-matching-nothing shape.
//
// Rewritten with a real corpus and an assertion that bites:
//  1. It scans ingest.css TOO. That file was never scanned, and it holds the
//     ONE legitimate --text-3 declaration in this pass's two files — so
//     extending the sweep both gives the detector something to find and makes
//     the exemption below a measured judgement rather than a leftover.
//  2. memory.css is held to a COUNT of zero, not to `.every()`. A count cannot
//     go vacuously true.
//  3. The exemption is NAMED, carries its measured value, and is asserted
//     PRESENT — a survivor that silently disappears is as much a regression as
//     a new failure, and asserting it proves this is a FLOOR rule rather than a
//     blanket ban on the token.
//  4. The rule-splitting regex drops the `^`/`m` anchoring the old one used,
//     and anchors the property so `color:` cannot match the tail of another
//     property name. Both parsers were run over both real files and agree
//     today (90 and 134 rules), so nothing was being missed on disk — but on
//     synthetic inputs the old form was wrong in three measured ways, each
//     covered by a control in §8: a rule that is not first on its line
//     returned NOTHING; a rule inside @media reported its selector as
//     `@media (…)`, so an exemption match against it was meaningless; and
//     `border-color: var(--text-3)` FALSELY matched, which would flag a
//     non-text component that clears its own 3:1 floor at 4.15-4.38.
/** Every rule declaring `color: var(--text-3)`, as its selector text. Hoisted to
 *  module scope so §8's positive controls can drive THIS function rather than a
 *  look-alike regex — a control over a copy proves the copy works, not the guard. */
function text3AsColor(css) {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , decls]) => /(?:^|;)\s*color\s*:\s*var\(--text-3\)/.test(decls))
    .map(([, sel]) => sel.trim().replace(/\s+/g, ' '));
}
// Exempt ONLY where the element's content is a graphic, so WCAG 1.4.11's 3:1
// floor governs instead of 4.5:1. Hand-maintained judgement, stated as such.
const NON_TEXT_EXEMPT = { 'ingest.css': ['.ing-queue-file-remove'] };

{
  const CSS_FILES = [['memory.css', memCss], ['ingest.css', ingCss]];
  const offenders = [];
  for (const [name, css] of CSS_FILES) {
    const allowed = NON_TEXT_EXEMPT[name] || [];
    for (const sel of text3AsColor(css)) if (!allowed.includes(sel)) offenders.push(`${name} { ${sel} }`);
  }
  ok('memory.css AND ingest.css: --text-3 is not a TEXT colour anywhere. The adopted description role is ' +
     '--text-2 (8.34 dark / 7.26 light), so the retirement is a consequence of adoption, not a separate ' +
     're-colouring. Non-exempt uses found: ' + (offenders.join(' | ') || 'none'),
     offenders.length === 0, offenders.join(' | '));

  const memHits = text3AsColor(memCss);
  ok('memory.css specifically carries ZERO --text-3 colour declarations — asserted as a COUNT (' +
     memHits.length + '), not as `hits.every(...)`, which was TRUE on the empty list this file now produces ' +
     'and is how this guard came to pass while checking nothing. Found: ' + (memHits.join(' | ') || 'none'),
     memHits.length === 0, memHits.join(' | '));

  const ingHits = text3AsColor(ingCss);
  ok('ingest.css KEEPS exactly its one exempt use, .ing-queue-file-remove — a button whose only content is ' +
     'icon(\'x\'), so its meaning lives in aria-label and it is a GRAPHIC at 4.33 dark / 3.87 light, over the ' +
     '3:1 non-text floor and under a 4.5 text floor that does not apply to it. Asserted PRESENT, not merely ' +
     'tolerated: this is a floor rule, not a ban on the token, and a survivor that silently disappears is as ' +
     'much a regression as a new failure. Found: ' + (ingHits.join(' | ') || 'none'),
     ingHits.length === 1 && ingHits[0] === '.ing-queue-file-remove', ingHits.join(' | '));

  // The exemption is only honest while that button really carries no words. If
  // it ever gains a text label, 4.5:1 starts applying and the exemption must go.
  ok('...and that exemption is still justified: the .ing-queue-file-remove button in ingest.js renders ONLY ' +
     'an icon() call, with its meaning in aria-label — so no sentence is being painted at 3.87:1. If it ever ' +
     'gains a text label the 4.5 floor applies and this exemption must be removed, not widened.',
     /class="ing-queue-file-remove"[^>]*aria-label="Remove /.test(ingCode)
       && /class="ing-queue-file-remove"[\s\S]{0,220}?'\s*\+\s*icon\('x'/.test(ingCode));

  // FINDING 2, adopted where the component's MARKUP could not be: three
  // assertions in test-next-memory-view.js pin the class name `mem-badge-attn`,
  // so the badges stay bespoke and take the component's measured reasoning
  // instead — tone in the tint and the border, label at a legible token.
  const strippedMem = stripComments(memCss);
  ok('memory.css: no badge paints a status colour as its TEXT ' +
     '(--attention-text on --attention-tint measures 3.21:1 in the light theme)',
     !/\.mem-badge-[a-z]+\s*\{[^}]*color:\s*var\(--(attention|success|danger)-text\)/.test(strippedMem),
     (strippedMem.match(/\.mem-badge-[a-z]+\s*\{[^}]*\}/g) || []).join('\n'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  READ-ONLY — the memory view is still not a second writer');
// ═══════════════════════════════════════════════════════════════════════════
// The store has exactly ONE writer (an agent, over MCP) and its whole
// per-machine layout is safe BECAUSE of that. Nothing in this pass may have
// added an edit affordance, and the adopted roles render no control.

ok('memory.js issues no mutating HTTP method',
  !/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(memCode),
  (memCode.match(/method:\s*'[A-Z]+'/g) || []).join(','));
ok('memory.js renders no <textarea>, no contenteditable, no <form>',
  !/<textarea|contenteditable|<form\b/i.test(memCode));
ok('the read-only notice is still stated UNFOLDED in the sidebar, not tucked into the explainer',
  /Read-only here\. Agents write this through MCP\./.test(memCode) &&
  !new RegExp('Read-only here[\\s\\S]{0,80}renderExplainer').test(memCode));

// ═══════════════════════════════════════════════════════════════════════════
section('§8  POSITIVE CONTROLS — every detector above is shown to FIRE');
// ═══════════════════════════════════════════════════════════════════════════
// A detector that cannot go red is a comment. Each control below reproduces
// the exact defect its assertion guards, on a synthetic input.

ok('CONTROL: the import-site regex REJECTS a file with no such import',
  !IMPORT_RE.test("import { x } from '../shared/other.js';"));
ok('CONTROL: the import-site regex ACCEPTS the real shape',
  IMPORT_RE.test("import { renderDescription } from '../shared/text.js';"));
ok('CONTROL: callSiteCount reports 0 for an imported-but-never-called name',
  callSiteCount("import { neverUsed } from '../shared/text.js';\nfunction f() { return 1; }", 'neverUsed') === 0);
ok('CONTROL: callSiteCount reports >0 once it IS called',
  callSiteCount("import { used } from '../shared/text.js';\nfunction f() { return used('x'); }", 'used') > 0);
ok('CONTROL: the px-font-size detector fires on a planted literal',
  [...'.a { font-size: 13px; }'.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].length === 1);
ok('CONTROL: the tx-selector detector fires on a planted override',
  /\.tx-[a-z]/.test('.mem-doc .tx-readout-value { font-size: var(--text-sm); }'));
// ── The --text-3 detector, driven through the REAL text3AsColor() ────────
// The control this replaces re-implemented the regex inline, so it proved a
// COPY worked and could not have caught the actual defect: the assertion above
// it was `hits.every(...)` over an EMPTY list, which is true whatever the
// detector does. These drive the shipped function and the shipped exemption.
ok('CONTROL: the --text-3 detector FIRES on a planted rule (real text3AsColor)',
  text3AsColor('.mem-planted { color: var(--text-3); }').length === 1);
ok('CONTROL: ...and returns the SELECTOR, so an exemption can be matched against it',
  text3AsColor('.mem-planted { color: var(--text-3); }')[0] === '.mem-planted');
ok('CONTROL: ...and does NOT fire on a passing token, so it is not simply always-true',
  text3AsColor('.mem-planted { color: var(--text-2); }').length === 0);
ok('CONTROL: ...nor on --text-3 used as a BACKGROUND, which is a non-text component at a 3:1 floor',
  text3AsColor('.mem-dot { background: var(--text-3); }').length === 0);
ok('CONTROL: ...nor on a rule that exists only inside a comment — memory.css\'s own notes QUOTE the ' +
   'retired token while explaining why it went, so a raw scan reads a comment and reports the opposite',
  text3AsColor('/* .mem-planted { color: var(--text-3); } */').length === 0);
ok('CONTROL: ...and DOES fire on a rule nested in an @media block, reporting the RULE\'s selector. The ' +
   'previous `^`-anchored regex also fired here, but reported the selector as `@media (min-width: 900px)` — ' +
   'so any exemption match against it was meaningless',
  text3AsColor('@media (min-width: 900px) { .mem-planted { color: var(--text-3); } }')[0] === '.mem-planted');
ok('CONTROL: ...and DOES fire on a rule that is not first on its line, which the previous `^`-anchored, ' +
   'line-scoped regex returned NOTHING for — measured, not assumed',
  text3AsColor('.other { color: red; } .mem-planted { color: var(--text-3); }').length === 1);
ok('CONTROL: ...and does NOT fire on `border-color` or `text-decoration-color`, which the previous regex ' +
   'FALSELY matched (its `color:` had no start anchor, so it hit the tail of `border-color:`). Those are ' +
   'non-text components at a 3:1 floor, which --text-3 clears at 4.15-4.38.',
  text3AsColor('.a { border-color: var(--text-3); }').length === 0
    && text3AsColor('.b { text-decoration-color: var(--text-3); }').length === 0);
ok('CONTROL: the EXEMPTION is real — .ing-queue-file-remove is allowed and an unlisted selector is not, ' +
   'so the sweep above cannot pass by exempting everything',
  (NON_TEXT_EXEMPT['ingest.css'] || []).includes('.ing-queue-file-remove')
    && !(NON_TEXT_EXEMPT['ingest.css'] || []).includes('.ing-queue-file-name')
    && !NON_TEXT_EXEMPT['memory.css']);
ok('CONTROL: THE VACUITY SHAPE ITSELF — `[].every(fn)` is TRUE, which is exactly why the old assertion ' +
   'passed while memory.css contained no --text-3 at all; the replacement is a === 0 count, which cannot',
  [].every(() => false) === true && text3AsColor('.a { color: var(--text-2); }').length === 0);
ok('CONTROL: the status-colour-as-badge-text detector fires on the shape it forbids',
  /\.mem-badge-[a-z]+\s*\{[^}]*color:\s*var\(--(attention|success|danger)-text\)/
    .test('.mem-badge-attn { background: var(--attention-tint); color: var(--attention-text); }'));
ok('CONTROL: the mutating-method detector fires on a planted write',
  /method:\s*'(POST|PUT|PATCH|DELETE)'/i.test("fetch(u, { method: 'POST' })"));
ok('CONTROL: renderExplainer really does put a warning OUTSIDE the fold',
  (() => {
    const h = renderExplainer({ summary: 's', body: 'b', warning: 'W' });
    return h.indexOf('tx-status') < h.indexOf('<details') && h.indexOf('tx-status') !== -1;
  })());
ok('CONTROL: renderReadout really does omit an absent provenance',
  !/tx-readout-prov/.test(renderReadout({ label: 'L', value: '1' })));
ok('CONTROL: the "no <details> on the estimate" detector fires when one is planted',
  /<details/.test('<div>' + renderExplainer({ summary: 's', body: 'b' }) + '</div>'));

// ── ADOPTION IS ENFORCED AT THE CALL SITE, NOT AT THE IMPORT ──────────────
//
// ADDED AFTER A MUTATION PROVED THIS SUITE COULD NOT FAIL. Reverting
// memory.js's sidebar description from `renderDescription(...)` to a raw
// `<div class="sidebar-hint">` — the exact regression the component exists to
// prevent — left this file GREEN at 98/0. The mutation was confirmed applied by
// reading the file back off disk (0 renderDescription call sites, 1 raw-div
// reversion) and restored by copy.
//
// The gap was named on handover by the component's own author: the suites prove
// the renderers are SINGLE-SOURCE but not that any view USES them. An `import`
// statement is satisfied by a file that never invokes what it imported, so an
// import-presence check is not an adoption check.
//
// Hence two layers. A COUNT, so a view cannot quietly stop calling a renderer
// at all; and a NAMED SITE, because a count alone stays green while any single
// site regresses — which is precisely what the mutation did.
{
  const ingSrc = read('views/ingest.js');
  for (const [label, src, fns] of [
    ['memory.js', memSrc, ['renderDescription', 'renderStatus', 'renderReadout', 'renderExplainer']],
    // renderDescription is NO LONGER in ingest's list, and that is the point of
    // this release rather than a coverage loss: its single call site was the
    // paragraph under the <h1>. renderViewHeader replaces it as the adopted
    // role, and renderStatus (already used for every failure box) keeps the
    // count honest about the roles this view really does reach.
    ['ingest.js', ingSrc, ['renderViewHeader', 'renderStatus']],
  ]) {
    ok(`${label} imports the ONE text system`, /from '\.\.\/shared\/text\.js'/.test(src));
    for (const fn of fns) {
      const n = callSiteCount(src, fn);
      ok(`${label} actually CALLS ${fn}() — an unused import is an unadopted component`, n > 0, `${n} call sites`);
    }
  }
  // NAMED SITES for the header, so a count cannot mask a single view slipping
  // a paragraph back under its title. Both were literally that paragraph.
  ok('ingest.js centre: the header is the component, and the deleted sentence has not returned',
    /renderViewHeader\(\{ eyebrow: 'the way material gets in', title: 'Ingest' \}\)/.test(stripComments(ingSrc))
    && !/Drop in a ' \+ accepts/.test(stripComments(ingSrc)));
  ok('ingest.js sidebar: the hint is the header\u2019s info, not a .sidebar-hint div',
    /renderViewHeader\(\{ variant: 'sidebar', title: 'Ingest', info: hint/.test(stripComments(ingSrc))
    && !/class="sidebar-hint">' \+ hint/.test(stripComments(ingSrc)));

  // The exact site the mutation reverted, named so a count cannot mask it.
  //
  // INVERTED, NOT DELETED. This pair used to require that memory's sidebar
  // sentence go through renderDescription — which was right while a paragraph
  // under the title was the best available shape, and became the thing to
  // prevent the moment renderViewHeader existed. v3.20.0's whole lesson is that
  // renderDescription under an <h1> preserves the defect and changes only the
  // wording, so an assertion pinning that arrangement now pins the defect.
  // Deleting it would lose the mutation's lesson; inverting keeps it pointed at
  // the same site, in the same file, one step further on.
  ok('the Agent-memory sidebar is the header COMPONENT, not a title plus a paragraph',
    /renderViewHeader\(\{\s*variant: 'sidebar',\s*title: 'Agent memory',/.test(stripComments(memSrc)));
  ok('and the sentence has NOT returned as a paragraph under that title, in EITHER shape',
    !/class="sidebar-hint">The working brief/.test(stripComments(memSrc))
    && !/renderDescription\(\s*'The working brief your agents leave/.test(stripComments(memSrc)));
}

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
