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
  renderDescription, renderStatus, renderReadout, renderReadoutGroup, renderExplainer, renderInfoMark,
} from '../src/public/next/shared/text.js';
// Same contract, same reason: shared/docs-links.js takes no imports and THROWS
// on an unknown key, so the About panel's link is proven to resolve rather than
// merely to have been interpolated.
import { docsLinkHtml } from '../src/public/next/shared/docs-links.js';
// v3.71.0: the header's ⓘ body is the explainer kit's `context.page`, real.
import { explainerHtml } from '../src/public/next/shared/explainer.js';
// Same contract again: shared/monitor.js takes no imports either, precisely
// so a suite can run the real component rather than a stand-in for it.
import { renderMonitor } from '../src/public/next/shared/monitor.js';
// v3.67.0 — the REAL run-line kit, injected into the lifted batch estimate
// (a module-level import in views/ingest.js is invisible inside a lifted body).
import { renderRunsOn, aiActionDisabledAttrs } from '../src/public/next/shared/ai-run.js';
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';

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
//
// EXPIRED CLAIM, INVERTED — the same treatment this file already gives ingest's
// renderMain a few lines down. It pinned `renderExplainer` inside `renderAbout`,
// i.e. that Agent memory's mechanism explanation was a <details> card appended
// to every branch of the page. That card is GONE: it was the widest element on
// the screen, under the three cards that carry state, glued to the journal above
// it with a 0px gap (.tx-explainer declares no margin), and it is read once per
// user. Its words are the header's ⓘ panel now — renderViewHeader's own
// documented home for exactly that content, and this view's fold is the pattern
// that component was generalised FROM.
//
// So the claim is inverted rather than dropped: the centre header must reach
// the header component AND carry an `info` field, and the explainer must be
// absent from the file entirely. Reverting the move reds both halves.
ok('memory.js: renderMain builds its header with renderViewHeader',
  callSiteCount(memSrc, 'renderViewHeader', { within: 'renderMain' }) > 0);
ok('memory.js: ...and that header carries the mechanism explanation as its `info`',
  /info: explainerHtml\('context\.page', \{ here: 'agent-memory' \}\)/.test(memSrc) && /infoHtml: true/.test(memSrc));
// ── THE ONE PRIMARY, TOP RIGHT (v3.65.0, §2(5)) ──────────────────────────
// The maintainer, with both headers side by side: *"The Copy agent
// instructions button should be on the top right in a violet button like Ask
// this domain — the same design pattern."* So the assertion is the PATTERN,
// not the button: the header's action slot carries exactly one `btn-primary`,
// it is this control, and it takes the md rung rather than `btn-xs` — the two
// halves of "like Ask this domain", which is `btn btn-primary dm-ask-btn`.
{
  const actions = (/actionsHtml: state\.activeProject[\s\S]{0,400}?: '',/.exec(memCode) || [''])[0];
  ok('memory.js: the header\'s action slot was found (the scan is not vacuous)',
    actions.length > 40, actions.slice(0, 120));
  ok('memory.js: exactly ONE btn-primary in the header, and it is the copy control',
    (actions.match(/btn-primary/g) || []).length === 1, actions);
  ok('...carrying the copy control\'s own id, so the pattern cannot be satisfied '
    + 'by some other button', /id="mem-copy-agent"/.test(actions), actions);
  ok('...at the md rung, like `Ask this domain`, not the btn-xs it used to be',
    !/btn-xs/.test(actions), actions);
  // AND IT REACHES THE EDGE THE SAME WAY DOMAINS DOES: one declaration, the
  // same one views/domains.css makes about `.dm-ask-btn`, because the actions
  // group is `flex: 1` precisely so a trailing primary can push itself right.
  ok('memory.css gives it `margin-left: auto`, the one line the pattern needs',
    /\.mem-ask-btn\s*\{[^}]*margin-left:\s*auto/.test(memCss),
    (/\.mem-ask-btn[^}]*\}/.exec(memCss) || [''])[0]);
}
// COMMENT-STRIPPED, and that is not a loosening. memory.js's own docblocks
// explain the move and NAME the component that used to do it ("this was a
// renderExplainer <details>"), which is exactly the history this repo wants
// kept; a scan over raw text would red on the explanation rather than on any
// live call. `memCode` is the stripped source every other scan in this file
// already uses.
ok('memory.js: the explainer component is gone — not imported, not called, not emitted',
  !/renderExplainer/.test(memCode));
ok('memory.js: the sidebar error is a STATUS, not a hint (renderStatus inside renderSidebar)',
  callSiteCount(memSrc, 'renderStatus', { within: 'renderSidebar' }) > 0);
// RE-POINTED AGAIN (v3.65.1, D3), and the v3.55.0 finding this has always
// protected is unchanged: a MEASUREMENT must not be painted as grey prose.
// What moved is which element carries it. The count was a `renderReadout`,
// then a `renderMonitor` card at the foot of the list with a floating button
// beside it — *"from another dimension"* — and it is the ROW'S OWN SUMMARY
// now, in the meta slot every other reading on this page uses. So the pin is
// that `renderJournal` composes no instrument of its own AND still emits the
// figure into the summary's meta, which is what stops this becoming "the
// count was deleted and the suite agreed".
ok('memory.js: the journal count is the ROW\'s summary, not an instrument of its own',
  callSiteCount(memSrc, 'renderMonitor', { within: 'renderJournal' }) === 0
  && /countClause/.test(memSrc) && /journalMeta =\s*\n?\s*escapeHtml\(countClause\)/.test(memSrc));
// RE-POINTED (v3.56.0), and the claim is unchanged: the handoff's provenance is
// an INSTRUMENT. What moved is where it is painted — `renderHandoff` printed the
// document on the page and is gone; `handoffReaderContent` composes the payload
// the shell's reader overlay shows. The readout is in that payload's body.
ok('memory.js: the handoff provenance is a READOUT (renderReadout inside handoffReaderContent)',
  callSiteCount(memSrc, 'renderReadout', { within: 'handoffReaderContent' }) > 0);
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
  return liftFrom([[names, src, label]]);
}

/** The same, over SEVERAL sources. A screen composed of functions from two
 *  modules has to be lifted from two modules — `freshnessStep` moved to
 *  shared/age.js when the freshness scale went app-wide, and memory.js now
 *  imports it. Stubbing it instead would let this file's text-role assertions
 *  run past a mark the shipped screen really emits, which is the thing every
 *  lift in this file exists to avoid. */
function liftFrom(groups) {
  const all = [];
  const bodies = groups.map(([names, src, label]) => names.map((n) => {
    all.push(n);
    const b = functionSource(src, n);
    if (b === null) throw new Error(`lift: ${n} not found in ${label} — the scan would pass vacuously`);
    return b.replace(/^export\s+/, '');
  }).join('\n')).join('\n');
  return bodies + '\nreturn { ' + all.join(', ') + ' };';
}

/**
 * THE HANDOFF'S MARKUP, wherever it is painted.
 *
 * v3.56.0: `renderHandoff` returned the page fragment; `handoffReaderContent`
 * returns the openReader PAYLOAD and its `bodyHtml` is the same markup, one
 * layer in. Every assertion below reads through this rather than being rewritten
 * one by one, so what each of them pins is unchanged.
 *
 * Returns '' when there is nothing to open, which is what a missing fragment
 * used to be — so an assertion that expected markup still reds.
 */
function handoffHtml(R) {
  const c = R.handoffReaderContent();
  return c ? (c.bodyHtml || '') : '';
}

function memRenderers(stateObj) {
  // `effectiveSave` joins the list because renderHandoff now reads the save
  // time through it: the shipped field `current.savedAt` is filesystem mtime,
  // which git rewrites on checkout, so the byline was dating every synced
  // handoff to the moment of the pull. It falls back to mtime when no journal
  // entry carried a time, which is what the fixtures below exercise.
  // `renderBriefEditor` joins the list because renderBrief calls it in both
  // branches (v3.48.0's standing-brief editor). It is LIFTED rather than
  // stubbed for the same reason everything else here is: a stub would let
  // this suite's text-role assertions run past markup the shipped screen
  // emits — and this file's whole subject is which text role a sentence
  // renders in.
  // `freshnessStep` joins the list because the handoff's <summary> now carries
  // the save strip's own freshness pip — the menubar widget's mark, on the web,
  // for everyone who has no menu bar — and it is cut on formatAge's unit bands
  // so the mark and the word can never contradict each other. It is lifted
  // from shared/age.js rather than from memory.js, because the freshness scale
  // went app-wide and that is where it lives now; memory.js imports it.
  // `aboutInfoHtml` (which replaced `renderAbout`) is gone in v3.71.0: the
  // header's ⓘ is the `context.page` explainer, rendered by the kit.
  const body = liftFrom([
    [['formatAge', 'effectiveSave', 'splitHandoffPreamble', 'handoffReaderContent', 'previousHandoffHtml', 'renderJournal',
      'renderBriefEditor', 'renderBrief'], memSrc, 'memory.js'],
    [['freshnessStep'], read('shared/age.js'), 'shared/age.js'],
  ]);
  return new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'gatedLoader', 'loadGate',
    'JOURNAL_PAGE', 'JOURNAL_MORE',
    // THE REAL MONITOR (v3.65.0, M4). The journal's count is one of its lines
    // now, and §4's escaping battery below runs through whatever paints it —
    // a stub would let it run past the component.
    'renderDescription', 'renderStatus', 'renderReadout', 'renderMonitor',
    'docsLinkHtml', body)(
    stateObj, (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    () => '<svg></svg>', (s) => '<p>' + s + '</p>', () => '<div class="loader"></div>', null, 10, 50,
    renderDescription, renderStatus, renderReadout, renderMonitor, docsLinkHtml);
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
  const about = explainerHtml('context.page', { here: 'agent-memory' });

  // THE PROPERTIES THE EXPLANATION MUST KEEP, NOW THAT IT IS A PANEL.
  //
  // Three of the four the fold was pinned on came from its <details> and have
  // MOVED rather than gone: the affordance is still a real, keyboard-operable
  // control and the text is still hidden on first paint — renderViewHeader
  // emits a <button> with aria-expanded / aria-controls and a `hidden` panel,
  // and scripts/test-next-view-header.js is where that component's own
  // behaviour is proven. What is asserted HERE is what this view owes: the
  // words, and the fact that they carry no caution.
  // v3.71.0: the explainer names the tiers in the screen's own words and
  // says who writes which; the tiers' definitions are step ②'s table and the
  // read-only rule's long form is the guide's (the card below opens it).
  ok('the explanation still says what the tiers are',
    /<b>the brief<\/b>/.test(about) && /<b>Handoffs<\/b>/.test(about) && /<b>Journal<\/b>/.test(about),
    about.slice(0, 200));
  ok('...and who writes which — you the brief, your agents the Handoffs and the Journal',
    /You write <b>the brief<\/b>/.test(about) && /Your agents save <b>Handoffs<\/b> and the <b>Journal<\/b>/.test(about),
    about.slice(-400));
  ok('the panel is CONTENT, not a container — the component owns the disclosure',
    !/<details\b/.test(about) && !/tx-explainer/.test(about), about.slice(0, 200));
  ok('it renders NO warning box — it explains a mechanism and carries no caution',
    !/tx-status/.test(about));
  ok('...and it ends with a real guide card from the frozen table, not a typed URL',
    /<a class="xp-guide" href="https:\/\/github\.com\/[^"]*user-guide\.md#project-context--what-the-screen-shows"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/.test(about),
    about.slice(-300));

  // AND IT IS ON THE PAGE. A panel nothing passes to the header is a panel
  // nobody can open, which a source scan for the function would not notice.
  ok('the page itself emits NO explainer card any more',
    !/tx-explainer/.test(handoffHtml(R) + R.renderJournal() + R.renderBrief(baseState.projectRead, false)));

  // The handoff's provenance is an instrument.
  const h = handoffHtml(R);
  ok('the handoff renders a READOUT for when it was saved', /class="tx-readout"/.test(h), h.slice(0, 300));
  ok('...with the age as the VALUE', /class="tx-readout-value">2 hr ago</.test(h), h.slice(0, 400));
  // WIDENED DELIBERATELY (v3.56.0): the provenance now also names the CLOCK
  // when the reading had to fall back to the file's timestamp, which this
  // fixture does (a `savedAt` and no journal time). The page's own two-clock
  // rule has always been that such a reading "says `file time` in its own
  // provenance line, in words, rather than in a tooltip" — the save strip and
  // every table cell did, and the handoff byline was the one place that did
  // not. The assertion keeps its subject: harness and model are the provenance.
  ok('...and harness + model as its PROVENANCE',
    /class="tx-readout-prov">claude-code · opus-5/.test(h), h.slice(0, 500));
  ok('...which also names the CLOCK when the reading fell back to the file time',
    /class="tx-readout-prov">[^<]*file time/.test(h), h.slice(0, 500));
  // RE-POINTED (v3.56.0). The fact is the same and it is now reachable by MORE
  // people: it was a `title=` on the fold's stamp — hover only, so invisible to
  // keyboard and to touch — and it is a `.visually-hidden` span in the reader,
  // the same promotion the work-stream table's age cell already made. memory.js's
  // `title=` allowance in test-next-header-adoption.js shrinks from 3 to 1 with
  // this, which is the direction that ratchet permits.
  ok('...and the exact ISO stamp is still reachable, as text rather than as a tooltip',
    h.includes('class="visually-hidden"') && h.includes(baseDetail.current.savedAt)
    && !/title="/.test(h), h.slice(0, 400));

  // ABSENT IS NOT ZERO — the component's most load-bearing rule, at the site
  // where this view could most easily have broken it.
  const noProvR = memRenderers({
    ...baseState,
    detail: { ...baseDetail, current: { ...baseDetail.current, savedAt: null }, journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } },
  });
  const noProv = handoffHtml(noProvR);
  // RE-POINTED AGAIN (v3.56.0), and the rule it enforces is still unchanged:
  // ABSENT IS NOT ZERO. What changed is that there is no <summary> and no pip
  // any more — the document opens in the reader — so the third assertion, which
  // pinned the dashed ring, becomes its inverse: there is no mark to decode at
  // all, and the words carry the whole fact.
  //
  // So: still no instrument (a readout states a READING, and there is none),
  // still no invented figure, and the time is still said to be unknown in
  // words. Every one of the three reds if an absent time is rendered as a
  // number.
  ok('no save time and no journal entry renders NO readout — never a figure, never a dash',
    !/tx-readout/.test(noProv), noProv.slice(0, 400));
  ok('...saying the time is unknown IN WORDS, rather than leaving a bare mark',
    /time unknown/.test(noProv), noProv.slice(0, 400));
  ok('...and no pip at all — there is no mark in the reader for a dashed ring to be',
    !/mem-save-pip/.test(noProv), noProv.slice(0, 400));

  // Each fact still shown when only the OTHER is missing: consolidating two
  // elements into one instrument must not be able to drop one of them.
  const onlyWho = handoffHtml(memRenderers({
    ...baseState,
    detail: { ...baseDetail, current: { ...baseDetail.current, savedAt: null } },
  }));
  ok('with no save time but a known author, the AUTHOR is still stated',
    /tx-readout-value">claude-code · opus-5</.test(onlyWho), onlyWho.slice(0, 400));
  const onlyWhen = handoffHtml(memRenderers({
    ...baseState,
    detail: { ...baseDetail, journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } },
  }));
  // The `!prov` half of this became false for a REASON rather than by drift —
  // see the widening above: with no author the provenance is not empty, it is
  // the clock. What the assertion is for is that the TIME survives when the
  // author does not, and that is what it now says, plus the positive form of
  // the missing author: no harness, no model.
  ok('with a save time but no known author, the TIME is still stated',
    /tx-readout-value">2 hr ago</.test(onlyWhen)
    && !/claude-code/.test(onlyWhen) && !/opus-5/.test(onlyWhen), onlyWhen.slice(0, 400));

  // The journal count is a figure, not a sentence — and the framing prose
  // beside it is a description, so the two no longer share a voice.
  const j = R.renderJournal();
  // THE ROW'S SUMMARY SINCE v3.65.1 (D3). The ROLE is unchanged — a
  // measurement rendered as a measurement rather than as grey prose, which is
  // what "an explanation and a measurement no longer share one class" below is
  // about — and the slot that carries it is the one every other row uses.
  ok('the journal count renders in the row\'s own meta slot',
    /<span class="mem-fold-meta"[^>]*>3 saves/.test(j), j.slice(0, 600));
  ok('...and renderJournal draws no instrument of its own under the list',
    !/cur-mon/.test(j) && !/mem-j-foot/.test(j), j.slice(-400));
  ok('the journal framing renders as a DESCRIPTION', /class="tx-desc"/.test(j), j.slice(0, 500));
  ok('an explanation and a measurement no longer share one class',
    !/mem-quiet/.test(j), j.slice(0, 300));

  // An unknown total must still not print the tail length as if it were one.
  const unknown = memRenderers({
    ...baseState,
    detail: { ...baseDetail, journal: { returned: 2, total: null, totalUnknown: true, totalUnknownReason: 'journal is huge', entries: baseDetail.journal.entries } },
  }).renderJournal();
  ok('an unknown journal total still says UNKNOWN in the summary\'s own clause',
    /<span class="mem-fold-meta"[^>]*>[^<]*full count unknown/i.test(unknown), unknown.slice(0, 600));
  ok('...and still does NOT print the tail length as the total',
    !/>2 saves<|2 saves ·(?! )/.test(unknown) && /2 saves shown/.test(unknown), unknown.slice(0, 600));

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
  const out = handoffHtml(R) + R.renderJournal();
  ok('the hostile fixture produced markup (not an empty string)', out.length > 300, out.length);
  ok('no raw <img> survives anywhere in the adopted output', !/<img\s/i.test(out), out.slice(0, 300));
}

// The store's own message reaches the screen through the description role —
// the v3.17.1 defect was this sentence being dropped entirely.
{
  const noHandoff = handoffHtml(memRenderers({
    ...baseState,
    detail: { ...baseDetail, current: { present: false }, message: 'STORE-SAYS-SO' },
  }));
  ok('the store’s own "nothing here" sentence is rendered, in the description role',
    /class="tx-desc"[^>]*>[^<]*STORE-SAYS-SO/.test(noHandoff), noHandoff.slice(0, 300));
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  BEHAVIOURAL — the real ingest renderers, including the money ones');
// ═══════════════════════════════════════════════════════════════════════════

// `renderConfirmGrid` is LIFTED with the renderers rather than stubbed: it is
// the function that decides which COLUMN each part of the confirm gate lands
// in, and a stub would let the estimate card and the file list collapse into
// one cell with every assertion below still green.
//
// `renderInfoMark` is the REAL export of shared/text.js, for the same reason
// escapeHtml is real here — it is the thing that decides what is HIDDEN, and
// the whole point of the caveat arm below is that one sentence is not.
function ingRenderers(stateObj) {
  const body =
    functionSource(ingSrc, 'renderConfirmGrid').replace(/^export\s+/, '') + '\n' +
    functionSource(ingSrc, 'renderQueueEstimate').replace(/^export\s+/, '') + '\n' +
    functionSource(ingSrc, 'estimateCostText').replace(/^export\s+/, '') + '\n' +
    functionSource(ingSrc, 'queuePausedCopy').replace(/^export\s+/, '') + '\n' +
    functionSource(ingSrc, 'renderQueuePausedBanner').replace(/^export\s+/, '') + '\n' +
    'return { renderQueueEstimate, renderQueuePausedBanner, renderConfirmGrid };';
  return new Function('state', 'escapeHtml', 'icon',
    'resolveEstimateFileList', 'renderQueueRejectedItem', 'renderQueueFileListItem',
    'formatQueueBytes', 'formatUsdHonest', 'formatTokenRange', 'pausedReasonCopy',
    'renderStatus', 'renderReadoutGroup', 'renderInfoMark',
    'renderRunsOn', 'aiActionDisabledAttrs', body)(
    stateObj, (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    () => '<svg></svg>',
    (est, sel) => sel, () => '<li>r</li>', () => '<li>f</li>',
    (b) => b + ' B', formatUsdHonest, (lo, hi) => lo + '–' + hi,
    (r) => ({ title: 'Paused — ' + r, body: 'Recoverable. Resume when ready.' }),
    renderStatus, renderReadoutGroup, renderInfoMark,
    renderRunsOn, aiActionDisabledAttrs);
}

{
  // THE BASIS IS NOW TWO STRINGS. `basis` is the estimator's full 140-226-word
  // account and lives behind the ⓘ; `basisLede` is the ≤20 words that stay on
  // screen, and it is what the readout's PROVENANCE slot renders. The fixture
  // carries both so the split can be asserted in both directions.
  const LEDE = 'Sized against this wiki’s real page list — about 2.6x an empty domain. ' +
    'Actual spend can land above the range.';
  const FULL_BASIS = 'Estimated for Gemini against the "x" domain. ' +
    'ONLY-IN-THE-FULL-BASIS. Both ends are estimates rather than limits.';
  const est = {
    files: { count: 2, totalBytes: 2048, rejected: [] },
    provider: 'gemini', model: 'flash-lite',
    estimate: { usdLow: 0.01, usdHigh: 0.05, inputTokensLow: 1, inputTokensHigh: 2,
      outputTokensLow: 3, outputTokensHigh: 4, basis: FULL_BASIS, basisLede: LEDE },
    warnings: ['This batch is large.', 'One file is a scanned PDF.'],
  };
  const R = ingRenderers({ selectedFiles: [{ name: 'a' }, { name: 'b' }], queueBudgetInput: '', queueOverwriteInput: false, queueSubmitting: false });
  const out = R.renderQueueEstimate(est);

  ok('the cost estimate renders as a READOUT GROUP', /class="tx-readout-group"/.test(out), out.slice(0, 400));
  // v3.72.1 (F9): through the honest formatter, marked as an estimate (≈) —
  // the run line's own form for the same two numbers.
  ok('...with the cost as a figure', /tx-readout-value">≈\$0\.01 – \$0\.05</.test(out), out.slice(0, 900));
  ok('...and the estimator’s LEDE as PROVENANCE on the cost it qualifies',
    /tx-readout-prov">Sized against this wiki/.test(out), out.slice(0, 1200));

  // ── THE MONEY INVARIANT, MEASURED RATHER THAN SPELLED ───────────────────
  // v3.16.1: "a warning behind a click is not a warning." The old form of this
  // assertion was `!/<details/`, which was TRUE OF A SURFACE THAT HAD NEVER
  // HAD A <details> and would have stayed true if the whole cost caveat had
  // been moved into an ⓘ panel — the affordance this view actually uses. It is
  // replaced by a check on WHERE the words land: strip every hidden container
  // out of the markup and the caveat must survive; the full basis must not.
  //
  // `hiddenStripped` removes any element carrying `hidden` or `tx-vh-panel`,
  // non-greedily up to the next `</div>` — which is exact for renderInfoMark's
  // panel (a single flat div of escaped text) and deliberately crude enough
  // that a NESTED fold would defeat it in the safe direction: more gets
  // stripped, so a caveat hidden inside one goes red.
  const hiddenStripped = out
    .replace(/<div[^>]*\btx-vh-panel\b[^>]*>[\s\S]*?<\/div>/g, '')
    .replace(/<[a-z]+[^>]*\bhidden\b[^>]*>[\s\S]*?<\/[a-z]+>/g, '');
  ok('an estimator warning renders as a STATUS box', /class="tx-status tx-status-attention"/.test(out), out.slice(0, 600));
  ok('...and survives the removal of every hidden container — it is not folded',
    /This batch is large\./.test(hiddenStripped) && /One file is a scanned PDF\./.test(hiddenStripped),
    hiddenStripped.slice(0, 900));
  ok('THE SPEND CAVEAT IS VISIBLE: "can land above the range" survives the same strip',
    /can land above the range/.test(hiddenStripped), hiddenStripped.slice(0, 1200));
  ok('...while the FULL basis is inside the panel, and only there',
    /ONLY-IN-THE-FULL-BASIS/.test(out) && !/ONLY-IN-THE-FULL-BASIS/.test(hiddenStripped),
    out.slice(0, 1600));
  ok('CONTROL: the hidden-stripper really removes something — it is not a no-op',
    hiddenStripped.length < out.length, `${hiddenStripped.length} vs ${out.length}`);

  // ── THE TWO COLUMNS ─────────────────────────────────────────────────────
  // The file list is what you are about to spend on; the cost card is the
  // decision. They are in different grid cells, so the Start button is no
  // longer below a 220px scrolling list with its price above it.
  const decideAt = out.indexOf('ing-confirm-col-decide');
  const listAt = out.indexOf('ing-queue-file-list');
  const cardAt = out.indexOf('ing-queue-estimate');
  ok('the confirm gate renders the two-column grid', /class="ing-confirm-grid"/.test(out) && decideAt > 0, out.slice(0, 400));
  ok('...with the FILE LIST in the input cell', listAt > 0 && listAt < decideAt, `list@${listAt} decide@${decideAt}`);
  ok('...and the COST CARD in the decide cell', cardAt > decideAt, `card@${cardAt} decide@${decideAt}`);

  // ABSENT IS NOT ZERO on the spending surface: no basis at all, no provenance.
  const noBasis = R.renderQueueEstimate({ ...est, estimate: { ...est.estimate, basis: null, basisLede: null }, warnings: [] });
  ok('no basis renders NO provenance line — never "—", never a fabricated one',
    !/tx-readout-prov/.test(noBasis), noBasis.slice(0, 800));
  ok('...and no ⓘ either, rather than a mark that opens an empty panel',
    !/tx-vh-info/.test(noBasis), noBasis.slice(0, 800));
  ok('no warnings renders NO status box', !/tx-status/.test(noBasis), noBasis.slice(0, 400));

  // A server that sends only the long form must not end up saying NOTHING
  // about how the range was reached — the degradation is verbose, never silent.
  const ledeless = R.renderQueueEstimate({ ...est, estimate: { ...est.estimate, basisLede: null }, warnings: [] });
  ok('no lede falls back to the FULL basis in the visible provenance, not to silence',
    /tx-readout-prov">Estimated for Gemini/.test(ledeless) && !/tx-vh-info/.test(ledeless),
    ledeless.slice(0, 900));

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

// ── COMMENTS ARE STRIPPED BEFORE THESE SCANS ────────────────────────────
// Correction, not a loosening, and the same one scripts/test-next-text-system.js
// already made to its own `tx-` leak detector. These are RULE assertions, and a
// raw scan cannot tell a rule from a sentence: views/ingest.css now carries a
// comment saying precisely that the panel's spacing belongs to shared/text.css
// and must NOT be reached into from here — and that comment, naming the class
// it refuses to style, reddened the guard. A guard that fires on prose teaches
// people to reword the explanation instead of fixing the code, and the next
// reader deletes the reasoning rather than the defect. Stripping can only
// remove FALSE positives: a real rule is never inside a comment. The controls
// below prove the detector still fires.
const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
{
  const probe = '.chat-x { color: red; }\n.tx-vh-panel { margin-top: 6px; }';
  ok('CONTROL: a real `.tx-` RULE is still detected after stripping',
     /\.tx-[a-z]/.test(stripCssComments(probe)));
  ok('CONTROL: ...and a comment that merely NAMES one is not',
     !/\.tx-[a-z]/.test(stripCssComments('/* `.tx-vh-panel` is text.css’s, not ours. */\n.chat-x { color: red; }')));
  ok('CONTROL: ...including a px size quoted in a comment',
     !/font-size:\s*\d/.test(stripCssComments('/* was font-size: 13px before the ramp */\n.a{font-size:var(--text-sm)}')));
}

for (const [name, rawCss] of [['memory.css', memCss], ['ingest.css', ingCss]]) {
  const css = stripCssComments(rawCss);
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
  // `base` and `material` JOIN THIS LIST, and the omission was not cosmetic:
  // tokens/material.css is where the whole material/gloss/elevation family is
  // declared (--mat-row-*, --elev-*, --hairline*, --hit-min, --numeric-
  // tabular), so a view adopting any of them was reported as referencing an
  // undefined token. The list is what this assertion asserts, and it was
  // silently short — the same shape the design-kit suite records for its own
  // file list. Enumerated rather than globbed so ADDING a token file is a
  // deliberate edit here too.
  const tokenCss = ['base', 'color', 'space', 'shape', 'typography', 'motion', 'material']
    .map((n) => read('tokens/' + n + '.css')).join('\n');
  // ── AND shared/sidebar.css + views/domains.css, FOR A STATED REASON ────
  // v3.65.0: views/memory.css painted the six IDENTITY DOT colours on the
  // sidebar kit's own class names while three of the values were declared in
  // views/domains.css — a second copy of the twelve rules, byte-identical to
  // that view's, each of them painting BOTH rails because CSS has no per-view
  // scope. v3.65.1 moved the palette and the three derived rungs into
  // shared/sidebar.css (`--id-ink-1/-2/-3`), which is why the kit joins this
  // universe; views/domains.css stays in it because `.dm-stat-value` reads
  // the same three rungs and a typo in either direction must still red.
  //
  // WHAT IS STILL GUARDED: every var() in both files must resolve, read out
  // of the real stylesheets rather than allow-listed by name.
  const shell = read('shell.css') + '\n' + read('shared/sidebar.css')
    + '\n' + read('views/domains.css');
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
section('§7  THE TIER BOUNDARY — the memory view writes tier 1 and nothing else');
// ═══════════════════════════════════════════════════════════════════════════
// UNTIL v3.48.0 this section asserted "no mutating method, no textarea, and
// the sidebar says read-only". That was the right guard for a view with no
// write path, and it is REPLACED rather than relaxed, because the property
// that matters was never "no writes" — it was WHICH FILES.
//
// Tiers 2 and 3 (the per-(work-stream, machine) handoff and its journal) have
// exactly one writer, an agent over MCP, and the per-machine layout is safe
// BECAUSE of that. Tier 1 (the standing brief) is the human's and always was;
// docs/working-state.md has said since v3.17.0 that you edit it by opening
// project.md in a text editor.
//
// So: exactly one mutating method, it is a PATCH, it goes to the projects
// endpoint, and it carries a brief and nothing else.
//
// ── v3.59.0 ADDS A SECOND, AND THE BOUNDARY IS UNMOVED ──────────────────
// Tier 0 — the canonical documents a project carries verbatim — splits on
// OWNERSHIP rather than on tier. A CURATOR-owned document is the commissioned
// agent's and this view cannot touch it; there is no route that could. A
// REPO-owned one is a MIRROR, and "Refresh from repo" is a deterministic BYTE
// COPY of a file the repository already authors — a second COPIER, not a
// second writer, and two copiers of one byte string converge rather than
// conflict (src/routes/memory.js carries the argument at the route).
//
// So the guard is widened by NAMING the second write exactly rather than by
// loosening the count: two methods, they are PATCH and POST as LITERALS, the
// POST goes to `…/foundations/refresh`, and it carries an empty body — there
// is no field for a later edit to smuggle a handoff or a document into.
//
// ── v3.61.0 ADDS THREE MORE, AND THE BOUNDARY IS STILL UNMOVED ──────────
// Tier 0 became EDITABLE by the owner, which is a fifth write and not a fourth
// tier: the property tiers 2 and 3 rest on was never "one process", it is ONE
// WRITER PER FILE and PROVENANCE THAT MATCHES. A curator-owned document has
// one writer — the owner — and the route stamps the write `authoredBy.kind:
// 'human'`, so it can never wear an agent's provenance line; the store refuses
// an ownership mismatch, so a human write is structurally incapable of landing
// on a mirror. What must stay true, and is asserted below, is that NONE of the
// five URLs names a scope, a machine or a journal.
//
//   PATCH  …/projects/:project      the standing brief (tier 1)
//   POST   …/foundations/refresh    the mirror copy — a file LIST, no bytes
//   POST   …/foundations/init       sets the ownership, ONCE
//   PUT    …/foundations/:slug      one curator-owned document, verbatim
//   DELETE …/foundations/:slug      removes one, slug as its own confirmation
//   DELETE …/foundations/:slug      v3.61.1 — the SAME route from the table
//                                   row's Remove control, because a mirrored
//                                   document can be un-mirrored without an
//                                   editor it is not allowed to have
//
// SEVEN METHOD KEYS, SIX ROUTES (v3.62.0 added the "read first" PATCH — a
// route of its own, allowed on BOTH ownerships because the flag is curator
// METADATA ABOUT a document and never part of it, so setting it on a mirror
// writes no byte of the copy). The census stays EXACT rather than becoming a
// floor — a floor lets a genuinely new write arrive in silence — so a second
// caller of an already-declared route still has to be declared, which is the
// line above. What it must not do is reach a different URL or carry a
// different body, and `test-next-memory-view.js` asserts that over EVERY
// DELETE call site rather than over the first one it finds.
{
  // EIGHT SINCE v3.65.0, over seven routes, and the eighth is step ③'s wiki
  // choice — CURATOR METADATA about the project, written to `project.json`
  // and nothing else, so tiers 1, 2 and 3 are untouched by it.
  const methods = (memCode.match(/method:\s*'[A-Z]+'/g) || []).sort();
  // v3.67.0 (package V): ELEVEN. The start-state write (`{atStart}`, replacing
  // `{readFirst}` at the same route), the reading budget (`project.json`, the
  // knowledgeDomains class), and two READS that carry a body: the session-start
  // PREVIEW and the reading-plan helper's proposal. test-next-memory-view.js §8
  // names each by URL and body.
  // v3.68.0: TWELVE. The ownership chooser's POST is gone; the two doors
  // add ONE commit POST (to `add-local`, `init`, `refresh` or `source` — the
  // URL and body are composed by shared/foundations-add.js's `buildAddCommit`,
  // pinned by test-foundations-add.js) and the "four templates" POST to init.
  // v3.70.0: FOURTEEN. The budget picker's PREVIEW (a second caller of the
  // preview READ, `{budgetBytes}`) and THIS COMPUTER's window/harness
  // (`PUT /api/config/context-window` — app settings, never project state).
  // test-next-memory-view.js §8 names both by URL and body.
  // v3.70.1: FIFTEEN. The "Documents at start" planner's PREVIEW (a third
  // caller of the preview READ, `{plan}`); its Apply reuses step ①'s PATCH.
  // v3.75.0: SIXTEEN. "Delete handoff" — `DELETE …/scopes/:scope {confirm}`,
  // the owner's removal of one work-stream to the trash;
  // test-next-memory-view.js §8 names it by URL and body.
  ok('memory.js issues exactly SIXTEEN mutating-shaped HTTP method keys',
    methods.length === 16, methods.join(','));
  ok('...and they are DELETE x3, PATCH x4, POST x7 and PUT x2, every one a LITERAL',
    methods.join(',') === "method: 'DELETE',method: 'DELETE',method: 'DELETE',method: 'PATCH',method: 'PATCH',"
      + "method: 'PATCH',method: 'PATCH',method: 'POST',method: 'POST',method: 'POST',method: 'POST',"
      + "method: 'POST',method: 'POST',method: 'POST',method: 'PUT',method: 'PUT'",
    methods.join(','));
  ok('...the reading-budget PATCH sends ONE field, to the four-segment route',
    /'\/reading\/budget'/.test(memCode)
    && /body: JSON\.stringify\(\{ readingBudgetBytes: bytes \}\)/.test(memCode));
  // THE THIRD PATCH SENDS ONE KEY TOO, and it is the same rule as the
  // `readFirst` one below: an instruction ABOUT a set of wikis, never a byte
  // of anything an agent wrote.
  ok('...the third PATCH aimed at the knowledge-domains endpoint, sending the '
    + 'whole list and nothing else',
  /'\/knowledge\/domains'/.test(memCode)
    && /body: JSON\.stringify\(\{ knowledgeDomains:/.test(memCode));
  ok('...one PATCH aimed at the PROJECTS endpoint, which reaches tier 1 only',
    /'\/api\/memory\/' \+ encodeURIComponent\(e\.domain\) \+ '\/projects\/'/.test(memCode));
  ok('...and it never sends a handoff field',
    !/nowState|nextSteps|observations|traps/.test(memCode));
  // THE OTHER PATCH SENDS ONE KEY. `text` is the document and `readFirst` is
  // metadata about it; a PATCH carrying both would be a write to a mirror's
  // bytes by another name.
  // v3.67.0: the three-state `{atStart}` replaced `{readFirst}` at the same route.
  ok('...the other PATCH aimed at ONE foundation, sending `atStart` and nothing else',
    /'\/foundations\/' \+ encodeURIComponent\(slug\)/.test(memCode)
    && /body: JSON\.stringify\(\{ atStart \}\)/.test(memCode)
    && !/body: JSON\.stringify\(\{ readFirst/.test(memCode));
  ok('...one POST aimed at the foundations REFRESH endpoint',
    /'\/foundations\/refresh'/.test(memCode));
  // THE REFRESH CARRIES A FILE LIST OR NOTHING — never a document body. That
  // is what keeps "the app is a COPIER on a mirror, never an author" true of
  // it: the paths are inside a repository the manifest already names, and the
  // bytes are the repository's. v3.59.0 shipped this route with no file list
  // at all, which is why a mirror could only be created from a test.
  // v3.69.0: the refresh names a SOURCE GROUP or nothing — `files` left with
  // the doors, whose commits go to add-local / add-remote.
  ok('...carrying at most a source group, never a file list or a document body',
    /const rootPart = one \? \{ group: one \} : \{\};/.test(memCode)
    && /body: JSON\.stringify\(rootPart\)/.test(memCode)
    && !/body: JSON\.stringify\(\{ files[^\n]*text/.test(memCode), 'the refresh body is not a group-or-nothing');
  ok('...the templates POST aimed at the foundations INIT endpoint, curator-owned and nothing else',
    /'\/foundations\/init'/.test(memCode)
    && /JSON\.stringify\(facts\.present \? \{ ownership: 'curator', rechooseEmpty: true \} : \{ ownership: 'curator' \}\)/.test(memCode));
  ok('...and the doors\' commit POSTs exactly what `buildAddCommit` composed',
    /const req = buildAddCommit\(rec, facts, domain, project\)/.test(memCode)
    && /fetch\(req\.url, \{\s*method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(req\.body\)/.test(memCode));
  ok('...the PUT and the DELETE aimed at ONE document under foundations/',
    /'\/foundations\/' \+ encodeURIComponent\(slug\)/.test(memCode));
  // THE PUT IS THE ONE WRITE THAT CARRIES BYTES, and it carries three fields:
  // the text, its title, its role. `authoredBy` is ABSENT — the route stamps
  // it — so there is no field here through which a browser could forge an
  // agent's provenance.
  // ── THE FOUNDATIONS HEAD IS A FLEX ROW, AND ITS FLOOR IS MEASURED ───────
//
// v3.61.0 replaced an absolutely-positioned control slot plus a
// `padding-right: 150px` reserve on the summary line with a wrapping flex row:
// the block needs up to THREE controls there now, and a px reserve for a
// variable number of them goes wrong SILENTLY — the summary text runs under
// the buttons and nothing in any suite can see it.
//
// THE FLOOR IS THE PART THAT WAS WRONG THE FIRST TIME, and it was found in the
// browser, not here: at `flex: 1 1 320px` the controls still fitted beside the
// fold at a 589px block, squeezing it to 328px — and the six-column mirrored
// table inside it then overflowed by 139px, scrolling horizontally where it
// had not before. The fold shrinking to its stated floor is the flexbox
// contract working as written; the floor was the mistake. 480px is the width
// below which this fold's own content stops being comfortable, so the row
// wraps under ~771px and the fold takes the whole width there.
{
  const head = /\.mem-fnd-row\s*\{([^}]*)\}/.exec(memCss);
  ok('memory.css: `.mem-fnd-row` is a flex row', !!head && /display:\s*flex/.test(head[1]),
    head ? head[1] : 'rule not found');
  // ── AND IT IS A COLUMN NOW (v3.61.1) ──────────────────────────────────
  //
  // v3.61.0 made it a WRAPPING ROW: the fold flexible at a 480px floor, the
  // controls beside it, wrapping under ~771px. The maintainer's screenshot of
  // a 25-document mirror is that design working as written and being wrong —
  // 285px of a 970px card spent permanently on two buttons, with the
  // six-column table living in 668px and scrolling horizontally at a width
  // where it did not have to. The wrap behaviour it approximated at one
  // width is now the layout at every width: the fold takes the card, the
  // controls sit on their own row under it. Measured at 1370px on a mirrored
  // project: table 668 -> 940px, overflow inside the fold 139 -> 0.
  ok('...and it is a COLUMN, so the fold takes the card and the controls sit on their own '
    + 'row rather than taking 285px of it permanently',
  !!head && /flex-direction:\s*column/.test(head[1]), head ? head[1] : '');
  ok('...with no wrap needed, because there is nothing beside the fold to wrap',
    !!head && !/flex-wrap:\s*wrap/.test(head[1]), head ? head[1] : '');
  ok('...and the 150px reserve on the summary line is GONE — a px reserve for a '
    + 'variable control count is a literal that fails silently',
  !/\.mem-fnd-row\s*>\s*\.mem-fold\s*>\s*\.mem-fold-summary\s*\{[^}]*padding-right:\s*150px/
    .test(memCss));
  ok('...and so is the absolutely-positioned single slot',
    !/\.mem-fnd-refresh\s*\{[^}]*position:\s*absolute/.test(memCss));
  {
    const fold = /\.mem-fnd-row\s*>\s*\.mem-fold\s*\{([^}]*)\}/.exec(memCss);
    // THE FLEX BASIS IS GONE WITH THE ARRANGEMENT THAT NEEDED IT (v3.61.1).
    // 480px was the floor below which the fold's own content stopped being
    // comfortable while something sat beside it; nothing sits beside it now,
    // so a basis would only be a width the fold is not allowed to be.
    ok('the fold no longer carries a flex basis, because nothing competes with it for the '
      + 'card\'s width', !!fold && !/flex:\s*1\s+1\s+\d+px/.test(fold[1]),
    fold ? fold[1] : 'no rule');
    ok('...but `min-width: 0` STAYS — a flex item\'s automatic minimum is its content, and '
      + 'the fold holds a table wide enough to push past the card without it',
    !!fold && /min-width:\s*0/.test(fold[1]), fold ? fold[1] : '');
  }
  ok('the control row collapses when it is empty, so a state with no controls '
    + 'pays no gap for them',
  /\.mem-fnd-head-controls:empty\s*\{[^}]*display:\s*none/.test(memCss));
}

// ── SCANNED IN THE REQUEST BODIES, NOT IN THE WHOLE FILE ──────────────
  // The original form of this assertion forbade `authoredBy` ANYWHERE in the
  // view, which went red the moment the curator-owned table started READING
  // that field to say "written by you" / "written by an agent" — a read of a
  // fact the server computed, which is the opposite of the hazard. A guard
  // that fires on the right word in the wrong place is a guard that gets
  // relaxed, so it is narrowed to the thing it is actually about: nothing this
  // view SENDS may carry a provenance field.
  ok('...the PUT sending exactly text, title and role, and no provenance field',
    /body: JSON\.stringify\(\{ text: e\.text \|\| '', title: e\.title \|\| '', role: e\.role \|\| 'other' \}\)/.test(memCode));
  {
    const bodies = memCode.match(/body:\s*JSON\.stringify\(([\s\S]*?)\)\,?\n/g) || [];
    ok('CONTROL: the body scan found every write this view makes', bodies.length >= 4,
      bodies.length + ' request bodies');
    const forged = bodies.filter((b) => /authoredBy|commissioned_by_owner|instructedBy/.test(b));
    ok('...and NONE of them carries a provenance field a browser could forge',
      forged.length === 0, JSON.stringify(forged));
    // AND THE READ SIDE IS ALLOWED, explicitly: the State column asks
    // `authoredBy.kind` whether a curator-owned document was written by the
    // owner or by an agent they commissioned, which is a fact the STORE
    // stamped and the row's only variable.
    // v3.69.0: the READ moved with the row's word into
    // shared/foundations-sources.js (`keptWord`), which the view imports.
    ok('CONTROL: the view does read the stamped provenance, which is why the '
      + 'scan above is scoped to bodies',
    /d\.authoredBy && d\.authoredBy\.kind/.test(memCode)
      || /const a = doc && doc\.authoredBy;[\s\S]{0,80}a\.kind === 'human'/.test(
        readFileSync(new URL('../src/public/next/shared/foundations-sources.js', import.meta.url), 'utf8')));
  }
  ok('...and the DELETE sending the slug as its own typed confirmation, which the route re-checks',
    /body: JSON\.stringify\(\{ confirm: slug \}\)/.test(memCode));
  ok('...and NOT ONE of the five names a scope, a machine or a journal',
    !/foundations\/[^']*scope|projects\/[^']*machine/.test(memCode));
  ok('memory.js never calls the tier 2/3 write tool by name',
    !/saveWorkingState/.test(memCode));
}
// TWO editable controls, and each is NAMED. `contenteditable` and `<form>`
// stay forbidden outright: neither is needed for a textarea, and both are how
// an edit affordance arrives somewhere nobody was looking.
//
// THE COUNT IS EXACT AND IS NOT A FLOOR. Two fields on this screen means the
// standing brief (tier 1, the human's) and one canonical document (tier 0,
// curator-owned, the owner's). A THIRD would be a surface nobody declared, and
// the one thing it could plausibly be is a handoff editor — which is precisely
// what tiers 2 and 3 may never grow here.
{
  const textareas = (memCode.match(/<textarea/gi) || []);
  ok('memory.js renders exactly two <textarea>s', textareas.length === 2, 'found ' + textareas.length);
  ok('...and they are the standing-brief editor and the foundation editor, by id',
    /id="mem-brief-text"/.test(memCode) && /id="mem-fnd-text"/.test(memCode));
  ok('...and neither belongs to a work-stream handoff or a journal',
    !/id="mem-(current|handoff|journal|scope)-text"/.test(memCode));
  ok('memory.js still renders no contenteditable and no <form>',
    !/contenteditable|<form\b/i.test(memCode));
}
// RE-POINTED, and the property under test is narrowed HONESTLY rather than
// quietly. It was: the "who writes what" split must be stated unfolded, in the
// sidebar foot, never inside the explainer. The foot card is gone — a lock
// glyph and a sentence under the project list, belonging to nothing — and the
// sentence is the second line of the rail's own ⓘ panel.
//
// SO THE CLAIM IS WEAKER, AND SAYING SO IS THE POINT: the fact is now behind a
// click. It is behind a REAL control (a <button> with aria-expanded, Escape to
// close, focus returned) rather than inside a disclosure whose summary is a
// line of prose, and it sits beside the only other sentence describing what
// this screen is — one mark, one panel, one voice. What is still pinned is that
// the sentence exists, that it is the rail header's `info` and not a floating
// block, and that the block has not come back.
// RE-POINTED AGAIN (v3.65.0, R2), and again the property is narrowed
// honestly rather than quietly. The RAIL'S OWN ⓘ is gone — the maintainer:
// *"we have an information icon in the Project context sidebar which should
// not be here, because we have another one on the right side beside Copy
// agent instructions — we definitely don't need it in this small section"* —
// and `renderSidebarHead` takes no `info` option at all, so the affordance
// cannot come back by a caller forgetting. The SENTENCE did not go with it:
// it is a paragraph of `aboutInfoHtml`, the MAIN header's panel, which is the
// one panel on this screen that describes what it is and who writes it.
// v3.71.0: the split is the `context.page` explainer's two points now, and
// the MAIN header is handed that explainer (asserted above).
{
  const about = explainerHtml('context.page', { here: 'agent-memory' });
  ok('the split is stated in the MAIN header\u2019s \u24d8 — you write the brief, agents save Handoffs',
    /You write <b>the brief<\/b>/.test(about) && /Your agents save <b>Handoffs<\/b>/.test(about));
  ok('...as the MAIN header\u2019s info panel, not as a paragraph beside it',
    /info: explainerHtml\('context\.page'/.test(memCode));
}
ok('...and the rail offers NO \u24d8 of its own any more — the component has no such option',
  !/variant: 'sidebar'/.test(memCode) && /renderSidebarHead\(\{/.test(memCode));
ok('...and the floating foot card it replaces has not come back',
  !/mem-sidebar-foot/.test(memCode));

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
    // `renderExplainer` LEFT this list, and — exactly as with ingest's
    // renderDescription below — that is the point of the release rather than a
    // coverage loss. Its single call site was the "How this works" <details>
    // card at the foot of every branch of the page; renderViewHeader's `info`
    // panel replaces it, and `renderViewHeader` joins the list in its place so
    // the count stays honest about the roles this view really does reach.
    ['memory.js', memSrc, ['renderDescription', 'renderStatus', 'renderReadout', 'renderViewHeader']],
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
  // v3.71.1: the centre header gained the `ingest.page` explainer as its ⓘ;
  // the sidebar header lost its ⓘ entirely (the standing rule: no ⓘ on a
  // sidebar title) — its hint merged into that explainer.
  ok('ingest.js centre: the header is the component, and the deleted sentence has not returned',
    /renderViewHeader\(\{\s*eyebrow: 'the way material gets in', title: 'Ingest',\s*info: explainerHtml\('ingest\.page'\), infoHtml: true,\s*\}\)/.test(stripComments(ingSrc))
    && !/Drop in a ' \+ accepts/.test(stripComments(ingSrc)));
  ok('ingest.js sidebar: the header carries no ⓘ, and no .sidebar-hint div brought the hint back',
    /renderViewHeader\(\{ variant: 'sidebar', title: 'Ingest' \}\)/.test(stripComments(ingSrc))
    && !/class="sidebar-hint"/.test(stripComments(ingSrc)));

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
  // RE-POINTED ONE STEP FURTHER ON (v3.65.0, R2), for the reason the comment
  // above gives about the previous re-pointing: the SHAPE under test moved
  // again, from a title plus a paragraph, to the header component, to the
  // SIDEBAR component — which is the one that carries the two action slots
  // and offers no ⓘ at all. Pinning the header component here now would pin
  // the shape this release removes, exactly as pinning renderDescription
  // would have in v3.20.0. Both halves are asserted so "adopted" cannot be
  // satisfied by having dropped the old call without making the new one.
  ok('the Project-context sidebar is the SIDEBAR component, not the view header',
    /renderSidebarHead\(\{\s*title: 'Project context',/.test(stripComments(memSrc))
    && !/variant: 'sidebar'/.test(stripComments(memSrc)));
  ok('...and it passes a PRIMARY and a SECONDARY, which is what made the two '
    + 'ghost buttons buttons again',
    /primary: \{\s*label: '\+ New project'/.test(stripComments(memSrc))
    && /secondary: \{\s*label: 'Refresh'/.test(stripComments(memSrc)));
  ok('and the sentence has NOT returned as a paragraph under that title, in EITHER shape',
    !/class="sidebar-hint">The working brief/.test(stripComments(memSrc))
    && !/renderDescription\(\s*'The working brief your agents leave/.test(stripComments(memSrc)));
}

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
