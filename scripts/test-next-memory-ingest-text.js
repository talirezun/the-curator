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
ok('ingest.js: the view description is a DESCRIPTION (renderDescription inside renderMain)',
  callSiteCount(ingSrc, 'renderDescription', { within: 'renderMain' }) > 0);
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
  const body = lift(['formatAge', 'splitHandoffPreamble', 'renderHandoff', 'renderJournal',
    'renderBrief', 'renderAbout'], memSrc, 'memory.js');
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

// THE DERIVED FORMATS LINE. The brief's rule: never replace a derived value
// with a typed one. The description used to type ".pdf, .md or .txt" three
// lines above a drop zone that derives the same list from ALLOWED_EXT.
{
  const rm = functionSource(ingCode, 'renderMain');
  ok('renderMain builds its accepted-formats list from ALLOWED_EXT',
    rm !== null && /ALLOWED_EXT[\s\S]{0,40}\.map\(/.test(rm), rm && rm.slice(0, 300));
  ok('...and does NOT type the extensions out', rm !== null && !/'\.pdf'|'\.md'|'\.txt'/.test(rm),
    rm && rm.slice(0, 300));
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
{
  const stripped = stripComments(memCss);
  const hits = [...stripped.matchAll(/^([^{}]+)\{([^}]*)\}/gm)]
    .filter(([, , decls]) => /color:\s*var\(--text-3\)/.test(decls))
    .map(([, sel]) => sel.trim().replace(/\s+/g, ' '));
  ok('memory.css: --text-3 is no longer a BODY-PROSE colour anywhere. The adopted ' +
     'description role is --text-2 (8.34 dark / 7.26 light), so the retirement is a ' +
     'consequence of adoption, not a separate re-colouring. Remaining uses: ' +
     (hits.join(' | ') || 'none'),
     hits.every((sel) => /mem-row-quiet|mem-j-rej/.test(sel)), hits.join(' | '));

  // FINDING 2, adopted where the component's MARKUP could not be: three
  // assertions in test-next-memory-view.js pin the class name `mem-badge-attn`,
  // so the badges stay bespoke and take the component's measured reasoning
  // instead — tone in the tint and the border, label at a legible token.
  ok('memory.css: no badge paints a status colour as its TEXT ' +
     '(--attention-text on --attention-tint measures 3.21:1 in the light theme)',
     !/\.mem-badge-[a-z]+\s*\{[^}]*color:\s*var\(--(attention|success|danger)-text\)/.test(stripped),
     (stripped.match(/\.mem-badge-[a-z]+\s*\{[^}]*\}/g) || []).join('\n'));
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
ok('CONTROL: the --text-3 body-prose detector fires on a planted rule',
  [...stripComments('.mem-planted { color: var(--text-3); }').matchAll(/^([^{}]+)\{([^}]*)\}/gm)]
    .filter(([, , d]) => /color:\s*var\(--text-3\)/.test(d)).length === 1);
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

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
