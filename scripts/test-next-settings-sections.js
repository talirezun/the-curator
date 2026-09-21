#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-settings-sections.js — the block pattern, on the sections that
 *  are not Providers & keys.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THIS PINS, AND WHY IT IS NOT ALREADY PINNED ───────────────────────
 *
 * v3.53.0 rebuilt Providers & keys onto `settingsBlock(...)`: a bold title, a
 * lede of at most twenty visible words, everything longer behind a shared ⓘ
 * fold, warnings never folded, and one rhythm (24 | hairline | 24) supplied by
 * the helper rather than by a margin somebody picked. The other three sections
 * that render a body — MCP bridge, Health & scan limits, Knowledge base — were
 * left on the old shape, and this release moves them across. General followed
 * in the same release, from a parallel worktree, which is why it arrives here
 * second: the array below was written with a note saying to add it on merge.
 *
 * `scripts/test-next-model-gone-ui.js` already pins the RHYTHM (the CSS rule
 * and the wrapper's markup). What nothing pinned is that these three sections
 * USE it. A renderer that goes back to a bare `.settings-section` with 73px
 * gaps, or grows a `style="margin-top:22px"` because a body needed one more
 * pixel of air, is a silent regression to exactly the shape v3.53.0 removed —
 * the page still renders, nothing throws, and no assertion anywhere notices.
 *
 * ── THE GUARDS ─────────────────────────────────────────────────────────────
 *   G1  each renderer calls settingsBlock(), and none emits .settings-section
 *   G2  settings.js carries no inline style that positions or spaces anything
 *   G3  every lede these renderers emit is ≤ 13 visible words  (EXECUTED)
 *   G3b no loose sentence sits between a block heading and its body (EXECUTED)
 *   G4  a finding is never inside a fold: the stale note, the validation error
 *       and General's menu-bar failure-mode note all render outside every
 *       hidden container                                           (EXECUTED)
 *   G5  every <details> in this view carries a `data-` hook
 *
 * ── EXECUTED, NOT SCANNED, WHERE IT MATTERS ────────────────────────────────
 * G3 and G4 run the real renderers with injected dependencies (the technique
 * scripts/test-next-mcp-wizard.js §11 uses on renderMcp) and measure the HTML
 * a user is actually served. A source regex asking "is there a lede here" is
 * the shape CLAUDE.md records as worse than no test at all: it proves a line
 * exists and says nothing about what it does. `settingsBlock` and `infoMark`
 * are lifted REAL for the same reason — a stubbed block helper would let this
 * file assert the properties of its own stub.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { docsLinkHtml } from '../src/public/next/shared/docs-links.js';
// The tool map's real collaborators. Imported rather than stubbed for the same
// reason `settingsBlock` and `infoMark` are lifted real below: block ③ is one
// of the ledes G3 measures and one of the heading→body gaps G3b measures, and
// a stubbed age vocabulary or readout would make both assertions about this
// file's own fixtures. All three modules are DOM-free by contract.
import { formatAge, freshnessTier } from '../src/public/next/shared/age.js';
import { renderReadout } from '../src/public/next/shared/text.js';
// The REAL monitor, injected into every lifted renderer below (see run()).
import { renderMonitor } from '../src/public/next/shared/monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SETTINGS_JS = path.join(ROOT, 'src/public/next/views/settings.js');
const src = readFileSync(SETTINGS_JS, 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  [32m✓[0m ' + msg); }
  else { failed++; console.log('  [31m✗[0m ' + msg); }
}
function section(t) { console.log('\n[1m' + t + '[0m'); }

/**
 * THE RENDERER LIST, IN ONE PLACE.
 *
 * `renderGeneral` joined it once its own conversion merged. It is four
 * `settingsBlock(null, …)` blocks concatenated bare, so it is subject to every
 * guard below for exactly the reasons the other three are — and it is the one
 * of the four most likely to regress, because it is the section a design pass
 * reaches for first. It costs more harness than the others: it is a
 * COMPOSITION (two row renderers inside one grouped card) and it forks on the
 * install's update capability, so `REAL` and the dependency set below carry
 * its collaborators. The note that used to stand here — "add the string and
 * nothing else, every guard below reads this array" — understated that by a
 * dozen lines, and adding the string alone threw `ReferenceError:
 * currentTheme is not defined`.
 *
 * `renderProviders` is absent for a different reason: it does not call
 * `settingsBlock` itself, it concatenates four helpers that each do, and those
 * four are already executed by test-next-model-gone-ui.js and
 * test-next-providers-page.js.
 */
const SECTION_RENDERERS = ['renderMcp', 'renderHealthLimits', 'renderStorage', 'renderGeneral'];

// ── Extraction: brace-matched, loud on desync ─────────────────────────────
// The same matcher test-next-ui-polish.js and test-next-mcp-wizard.js use. A
// lazy `[\s\S]*?\n\}` regex stops at the first column-0 closing brace inside
// the function, which truncates silently and produces a syntax error naming
// nothing.
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in views/settings.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  let parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = source.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" did not end at a top-level brace — the matcher desynced`);
  }
  return extracted;
}

/**
 * Comments stripped before any source scan.
 *
 * Proven necessary by mutation on this very file: `<details` appears in
 * THIRTY-odd comments in settings.js explaining the disclosure contract, so a
 * bare scan for it in G5 counts prose as markup and reports failures that are
 * not real. The same rule test-next-listbox.js records for `closeAllListboxes`.
 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const code = stripComments(src);
// A stripper that over-reaches deletes the thing under test and every guard
// below passes vacuously. Pin that it did not.
for (const needle of ['function renderMcp(', 'function renderStorage(', 'settings-job-lede']) {
  if (!code.includes(needle)) throw new Error(`stripComments over-reached: "${needle}" is gone`);
}

// ── The harness: the real renderers, executed ─────────────────────────────
//
// settingsBlock + infoMark are lifted REAL. They are what paint the lede and
// the fold, so stubbing them would make G3 and G4 assertions about the stub.
// deriveMcpStatus and shouldShowMcpStaleNote are lifted real too — G4's whole
// point is that the note fires from the real decision function.
//
// renderGeneral needs more of the file than the other three do, and all of it
// is lifted REAL rather than stubbed. It concatenates `renderTextSize` and
// `renderBackgroundMode` inside one grouped card and forks its update lede on
// `installUpdateStyle`; the copy all three read lives in module-level tables.
// G4's General arm measures a sentence `renderBackgroundMode` emits, and G3
// measures ledes `settingsBlock` paints, so a stub anywhere on that path would
// turn both into assertions about this file's own fixtures. Same set, same
// reason, as scripts/test-next-settings-default-section.js §6.
//
// TX_INFO_GLYPH is the one thing NOT lifted: it arrives as a function
// parameter in `run()`, and a `const` of that name in the same body is a
// SyntaxError rather than a shadow.
function constSource(re, what) {
  const m = re.exec(code);
  if (!m) throw new Error(`constSource: "${what}" not found in views/settings.js`);
  return m[0];
}
const REAL = [
  constSource(/const UPDATE_RECOVERY_INFO =[\s\S]*?;\n/, 'UPDATE_RECOVERY_INFO'),
  constSource(/const UPDATE_RECOVERY_INFO_INSTALLER =[\s\S]*?;\n/, 'UPDATE_RECOVERY_INFO_INSTALLER'),
  constSource(/const BACKGROUND_MODE_LABELS = \{[\s\S]*?\n\};/, 'BACKGROUND_MODE_LABELS'),
  extractFunction(src, 'settingsBlock'),
  extractFunction(src, 'infoMark'),
  extractFunction(src, 'deriveMcpStatus'),
  extractFunction(src, 'shouldShowMcpStaleNote'),
  // v3.64.0. Lifted REAL for the same reason its two neighbours are: the
  // bridge-process note fires from a real decision function, and a stub would
  // make any assertion about it an assertion about this file's fixture. With
  // no `bridge_processes` on the fixture payload it correctly renders nothing,
  // which is also the arm that proves an older server's payload is survivable.
  extractFunction(src, 'deriveStaleBridgeNote'),
  extractFunction(src, 'installUpdateStyle'),
  extractFunction(src, 'renderTextSize'),
  extractFunction(src, 'renderBackgroundMode'),
  // ── BLOCK ③'s CHAIN, LIFTED REAL ───────────────────────────────────────
  // `renderMcp` calls `renderToolMap`, which calls the rest. Every one is
  // lifted rather than stubbed because G3 measures the lede block ③ paints
  // and G3b measures the gap above its body — both of which `settingsBlock`
  // emits from arguments these functions supply.
  extractFunction(src, 'ageSecondsOf'),
  extractFunction(src, 'ageMarkHtml'),
  extractFunction(src, 'renderToolTile'),
  extractFunction(src, 'renderToolGroup'),
  extractFunction(src, 'renderSessionStrip'),
  extractFunction(src, 'renderToolMapBody'),
  extractFunction(src, 'renderToolMap'),
].join('\n');

function baseState() {
  return {
    mcpError: null,
    mcp: { mcp_server_name: 'my-curator', domains_dir: '/tmp/d', installed: true, stale: false },
    selfTest: null, selfTestLoading: false, configSnippetOpen: false, configSnippet: null,
    copyFeedback: null,
    defaultDomainInfo: { domains: ['alpha', 'beta'], defaultDomain: 'alpha' },
    defaultDomainSaving: false,
    aiHealthError: null, aiHealth: { costCeilingTokens: 50000, maxPairs: 500 },
    costCeilingInput: '50000', maxPairsInput: '500',
    scanLimitsValidationError: null, aiHealthSaving: false, aiHealthSaved: false,
    configError: null,
    config: {
      domainsPath: '/Users/x/Curator Knowledge',
      // THE MENU BAR ICON IS ON. G4's General arm measures a sentence that
      // renders only in that state, and `renderBackgroundMode` draws the
      // switch/checkbox pair only when the server offers exactly these three.
      backgroundModes: ['window', 'tray', 'tray-only'], backgroundMode: 'tray',
    },
    pickingFolder: false, pathCopyFeedback: null,
    // ── General ──────────────────────────────────────────────────────────
    // No `capabilities` on the version record, so installUpdateStyle() resolves
    // to 'git-pull': the CHECKOUT install mode, which is the one every browser
    // install is in. The two packaged forks of the update lede are driven by
    // test-next-settings-default-section.js §6, which runs all three; this
    // suite measures the block SHAPE, which does not fork.
    quick: null, live: null, liveConfirmOpen: false, quickLoading: false,
    updateChecking: false, version: { version: '9.9.9' },
  };
}

function lift(name, state, over) {
  const deps = {
    state,
    escapeHtml: (x) => String(x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    icon: () => '<svg class="i"></svg>',
    TX_INFO_GLYPH: '<svg class="g"></svg>',
    docsLinkHtml,
    formatAge,
    freshnessTier,
    // THE REAL MONITOR (v3.65.0). The bridge status card, the self-test
    // result and the two session readings all render through
    // shared/monitor.js now, and a module-level import is NOT visible inside
    // a body lifted by `extractFunction` — a free `renderMonitor` there is a
    // ReferenceError, i.e. a suite that crashes instead of asserting. Injected
    // REAL rather than stubbed, because every measurement below is about the
    // markup this section actually ships.
    renderMonitor,
    gatedLoader: () => '<LOADER/>',
    loadGate: null,
    renderSelfTestResult: () =>
      '<div class="settings-check-results"><div class="check-row check-ok">Bridge responds</div></div>',
    renderListboxHtml: () => '<LISTBOX/>',
    pendingListboxes: [],
    MCP_GUIDE_URL: 'https://example.invalid/guide',
    myMountToken: 1,
    onSaveDefaultDomain: () => {},
    crossWriteBusy: () => false,
    crossWriteTitle: (c) => 'A write is in flight — ' + c,
    renderCrossWriteBanner: () => '',
    // General's collaborators that are NOT part of what is measured: the
    // browser-local preferences it reads, and the panels it delegates to.
    // Passed by name, so an unlisted one is a named ReferenceError here rather
    // than a wrong answer in the app — the §6 rule.
    currentTheme: () => 'dark',
    currentFontScale: () => 'default',
    fontScaleOptions: () => [['default', 'Default', 'The default size']],
    updatesAreBusy: () => false,
    renderUpdateStatus: () => '<div class="upd-status"></div>',
    renderQuickSummary: () => '',
    renderLiveConfirm: () => '',
    renderLiveResult: () => '',
    inAppUpdate: null,
    updaterAttached: null,
  };
  // `over` overrides injected collaborators BY NAME, so an unknown key is a
  // silent no-op rather than a new free identifier — the §6 rule, kept.
  Object.assign(deps, over || {});
  const names = Object.keys(deps);
  const fn = new Function(...names, [REAL, extractFunction(src, name), `return ${name};`].join('\n'));
  return fn(...names.map((n) => deps[n]));
}

/**
 * `run()` lifts a renderer and CALLS it with no arguments, which is what every
 * section renderer here takes. Two v3.65.0 assertions need the FUNCTION
 * instead: one to hand `renderMcp` the REAL `renderSelfTestResult` as a
 * collaborator (run()'s default stub of it is precisely what M9 replaced), and
 * one because `renderSessionStrip` takes arguments. Same sandbox, same REAL
 * bodies, one step short of the call — so `run` is now that one step.
 */
function run(name, state, over) {
  return lift(name, state, over)();
}

/**
 * THE THREE INSTALL MODES, because the update lede FORKS on them.
 *
 * `baseState()` resolves to the git-checkout mode, which is the one every
 * browser install is in — and for a long time it was the only one measured
 * here, with a comment pointing at test-next-settings-default-section.js §6 for
 * the other two. That was fine while both ceilings said twenty. It stopped
 * being fine when this file's ceiling moved to THIRTEEN and §6's stayed at
 * twenty: a packaged fork could then be 15 words and nothing would go red.
 * Proven by mutation — restoring the 15-word attached-updater lede left every
 * assertion in this file green. So the modes are measured where the ceiling is.
 */
const INSTALL_MODES = [
  ['git checkout', (s) => s, {}],
  ['packaged, updater attached',
    (s) => ({ ...s, version: { version: '9.9.9', capabilities: { updateStyle: 'download-installer' } } }),
    { updaterAttached: true }],
  ['packaged, no updater',
    (s) => ({ ...s, version: { version: '9.9.9', capabilities: { updateStyle: 'download-installer' } } }),
    { updaterAttached: false }],
];

// ═══════════════════════════════════════════════════════════════════════════
section('G1  Each section renders as settingsBlock() calls — never .settings-section');
// ═══════════════════════════════════════════════════════════════════════════
//
// `.settings-section` is the OLD wrapper: `gap: var(--space-12)` between
// children with no card, no rule and no title — which on the real page put 73px
// between a heading and the thing under it while two related controls sat 14px
// apart. Both halves are asserted, because a renderer can adopt the helper and
// keep the old wrapper around it, which is the worst of the two (the rhythm
// then reads as 24 + 73).
for (const name of SECTION_RENDERERS) {
  const body = stripComments(extractFunction(src, name));
  const calls = (body.match(/settingsBlock\(/g) || []).length;
  ok(calls >= 1, `${name}() composes its output from settingsBlock() (${calls} call(s))`);
  ok(!/class="settings-section/.test(body) && !/settings-section"/.test(body),
    `${name}() does not wrap itself in .settings-section — the block helper owns the rhythm`);
  // …AND THE SAME THING, EXECUTED. Proven necessary by mutation: an early
  // `return '<div>' + body + '</div>'` placed ABOVE the real return leaves the
  // settingsBlock call in the source, so the scan above stayed green against a
  // section that had stopped rendering a single block. A source assertion
  // proves a line exists and says nothing about what it does.
  const html = run(name, baseState());
  ok(/class="settings-job-block settings-block/.test(html),
    `${name}() really RENDERS a block wrapper — not merely a call to the helper somewhere in its source`);
  ok(!/settings-section/.test(html),
    `${name}()'s output carries no .settings-section wrapper`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('G2  No inline style positions or spaces anything in this view');
// ═══════════════════════════════════════════════════════════════════════════
//
// `renderMcp` carried `style="margin-top:22px"` — a hand-picked number that
// existed because nothing else on the screen supplied a rhythm. An inline style
// is invisible to every CSS guard this repo has (the token check, the contrast
// ratchet, the kit audit all read stylesheets), so it is the one place a
// spacing decision can be made where nothing can see it.
//
// The `.provider-dot` sites are the legitimate exception and the only one: the
// colour is DATA, from the PROVIDER_ROWS table, and a per-provider class would
// be a second table of the same fact. Asserting the two counts are EQUAL is
// what makes this a real guard rather than a list of allowed strings — a new
// inline style anywhere fails it without anyone updating an allow-list.
{
  const allInline = (code.match(/style="/g) || []).length;
  const providerDots = (code.match(/class="provider-dot" style="background:/g) || []).length;
  ok(providerDots >= 3, `CONTROL: the provider-dot colour sites are still there (${providerDots} found)`);
  ok(allInline === providerDots,
    `every inline style in views/settings.js is a provider-dot colour: ${allInline} style=" vs ${providerDots} dots`);
  const spacing = [];
  for (const m of code.matchAll(/style="([^"]*)"/g)) {
    if (/\b(margin|padding|gap|top:|left:|right:|bottom:)/.test(m[1])) spacing.push(m[1]);
  }
  ok(spacing.length === 0,
    spacing.length
      ? `inline spacing/positioning style(s): ${spacing.join(' | ')}`
      : 'no inline style carries margin, padding, gap or an offset — spacing lives in the stylesheet');
}

// ═══════════════════════════════════════════════════════════════════════════
section('G3  Every lede is at most 13 visible words  (EXECUTED)');
// ═══════════════════════════════════════════════════════════════════════════
//
// TWENTY WAS THE LINE v3.53.0 DREW and it is about reading, not about counting:
// a lede is the one sentence a user reads before deciding whether to act, and
// past roughly twenty words it stops being a sentence they read and becomes a
// paragraph they skip — which is how the 500-word block 4 that release found
// came to exist, one true sentence at a time.
//
// THIRTEEN IS THE LINE v3.58.0 DRAWS, and it is MEASURED rather than picked:
// an audit of every shipped block lede found a MEDIAN of 13 visible words, so
// thirteen is where the ledes that were written one sentence at a time already
// sit. A ceiling above the median is a ceiling that only the outliers feel,
// and it was the outliers — 18, 17, 16, 15, 14 — that carried a second clause
// each. The rule the ceiling enforces: a lede carries an INSTRUCTION, a
// CONDITION or a READING the user needs before acting; a DEFINITION never goes
// in a lede, it goes behind the ⓘ.
//
// A WORD is a whitespace-separated token carrying at least one letter or digit,
// so a bare "→" or "·" between two clauses is punctuation rather than a word.
// Tags are stripped first: the ⓘ button lives INSIDE the <p>, and its markup
// is not something anybody reads.
function ledesOf(html) {
  const out = [];
  for (const m of html.matchAll(/<p class="settings-job-lede settings-block-lede">([\s\S]*?)<\/p>/g)) {
    out.push(m[1]);
  }
  return out;
}
function visibleWords(fragment) {
  const text = fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim();
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}
{
  let total = 0;
  for (const name of SECTION_RENDERERS) {
    const html = run(name, baseState());
    ok(typeof html === 'string' && html.length > 200,
      `CONTROL: ${name}() really rendered (${html.length} chars)`);
    const ledes = ledesOf(html);
    ok(ledes.length >= 1, `${name}() emits at least one .settings-block-lede (${ledes.length})`);
    for (const l of ledes) {
      const words = visibleWords(l);
      total += 1;
      ok(words.length <= 13,
        `${name}: "${words.slice(0, 6).join(' ')}…" is ${words.length} visible words (<= 13)`);
      ok(words.length >= 4,
        `${name}: …and is a sentence, not a fragment (${words.length} words, >= 4)`);
    }
  }
  // EIGHT is what the four sections emit today: 2 + 1 + 1 + 4. Stated as a
  // floor rather than an equality so that adding a block is not a test edit,
  // but high enough that a section quietly losing its ledes cannot hide behind
  // the per-renderer ">= 1" above.
  //
  // IT IS ALSO THE CONTROL ON THE CEILING. Tightening 20 → 13 makes DELETING a
  // lede the cheapest way to pass, and a deleted lede is not a shorter lede —
  // it is a block that no longer says what it is for. This number must not
  // fall when the ceiling does.
  ok(total >= 8, `CONTROL: ${total} ledes measured across the four sections (a collapse to 0 would pass everything)`);

  // …AND THE UPDATE LEDE IN ALL THREE INSTALL MODES. See INSTALL_MODES above.
  let modeLedes = 0;
  for (const [label, shape, over] of INSTALL_MODES) {
    const html = run('renderGeneral', shape(baseState()), over);
    const ledes = ledesOf(html);
    ok(ledes.length === 4, `"${label}" renders four ledes, one per General block (${ledes.length})`);
    for (const l of ledes) {
      const words = visibleWords(l);
      modeLedes++;
      ok(words.length >= 4 && words.length <= 13,
        `"${label}": "${words.slice(0, 6).join(' ')}…" is ${words.length} visible words (4..13)`);
    }
  }
  ok(modeLedes === 12,
    `CONTROL: ${modeLedes} ledes measured across the three install modes — a mode rendering none would make the ceiling vacuous`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('G3b  No loose sentence between a block heading and its body  (EXECUTED)');
// ═══════════════════════════════════════════════════════════════════════════
//
// THE OTHER HALF OF THE RULE. G3 caps the lede; nothing capped the paragraphs
// BESIDE it. `settingsBlock` emits, in order: the heading, then at most one
// `.settings-block-lede` with the ⓘ button inside it, then at most one
// `.settings-block-info` fold, then the body. A renderer that wants one more
// sentence has exactly three honest homes for it — the lede (if it fits and is
// an instruction, a condition or a reading), the ⓘ (if it is a definition, a
// mechanism or an argument), or a `.tx-note` under the control it qualifies,
// INSIDE the body. What it must not do is concatenate a loose `<p>` between the
// heading and the body, which is the shape the whole text pass exists to
// remove and the one nothing here could see: the `<p>` renders, no assertion
// notices, and the block quietly grows a second voice.
//
// MEASURED ON THE RENDERED HTML, not on the source: `settingsBlock` is called
// with a `body` string, so a source scan cannot tell a `<p>` that lands in the
// gap from one that lands inside the body where it is legitimate.
{
  /** Remove one balanced <div …> subtree starting at `open` (an index of '<div'). */
  function dropBalancedDiv(s, open) {
    const scan = /<div\b|<\/div>/g;
    scan.lastIndex = open;
    let depth = 0, m;
    while ((m = scan.exec(s)) !== null) {
      if (m[0] === '</div>') { depth--; if (depth === 0) return s.slice(0, open) + s.slice(m.index + 6); }
      else depth++;
    }
    return s; // unbalanced — leave it, and let the assertion below report it
  }
  /** The slice between each block heading's close and its body's open. */
  function blockGaps(html) {
    const gaps = [];
    let at = 0;
    for (;;) {
      const hd = html.indexOf('class="settings-block-hd"', at);
      if (hd < 0) break;
      const h2end = html.indexOf('</h2>', hd);
      const hdClose = html.indexOf('</div>', h2end < 0 ? hd : h2end);
      const bodyAt = html.indexOf('<div class="settings-block-body">', hdClose);
      if (hdClose < 0 || bodyAt < 0) break;
      gaps.push(html.slice(hdClose + '</div>'.length, bodyAt));
      at = bodyAt + 1;
    }
    return gaps;
  }
  /** '' when a gap holds only the allowed lede + ⓘ fold; otherwise what is left over. */
  function looseInGap(gap) {
    let rest = gap.replace(/^\s*<p class="settings-job-lede settings-block-lede">[\s\S]*?<\/p>/, '');
    const info = rest.indexOf('<div class="settings-block-info">');
    if (info >= 0) rest = dropBalancedDiv(rest, info);
    return rest.trim();
  }

  let gapsSeen = 0;
  for (const name of SECTION_RENDERERS) {
    const html = run(name, baseState());
    const gaps = blockGaps(html);
    ok(gaps.length >= 1, `CONTROL: ${name}() emits ${gaps.length} heading→body gap(s) to measure`);
    gapsSeen += gaps.length;
    const loose = gaps.map(looseInGap).filter(Boolean);
    ok(loose.length === 0,
      loose.length
        ? `${name}: loose markup between a heading and its body — it is a lede, an ⓘ, a .tx-note in the body, or it is cut:\n      ${loose.map((l) => l.slice(0, 160).replace(/\n/g, ' ')).join('\n      ')}`
        : `${name}: nothing but the lede and its ⓘ fold sits between each heading and its body`);
  }
  ok(gapsSeen >= 8, `CONTROL: ${gapsSeen} gaps measured (a parser that found none would pass everything)`);

  // POSITIVE CONTROL. A detector that can never say "loose" is the same green
  // as a clean page. Inject the exact shape the rule forbids — a bare
  // paragraph after the lede, before the body — into a COPY of real output and
  // require the detector to catch it. `.settings-hint-text` is the class the
  // two Shared Brain surfaces used for precisely this, so it is the shape a
  // regression would actually take.
  {
    const clean = run('renderStorage', baseState());
    ok(looseInGap(blockGaps(clean)[0]) === '', 'CONTROL: the real block reads clean…');
    const dirty = clean.replace('<div class="settings-block-body">',
      '<p class="settings-hint-text">A sentence nobody decided to put anywhere.</p><div class="settings-block-body">');
    const caught = looseInGap(blockGaps(dirty)[0]);
    ok(caught.includes('nobody decided'),
      '…and CONFIRMED RED: an injected loose paragraph in that same gap IS reported');
  }
  // …and the ⓘ fold, which sits in the same gap legitimately, is NOT reported.
  {
    const withFold = run('renderHealthLimits', baseState());
    ok(/class="settings-block-info"/.test(withFold),
      'CONTROL: renderHealthLimits really emits an ⓘ fold in the gap under test');
    ok(looseInGap(blockGaps(withFold)[0]) === '',
      '…and the detector does not mistake that fold for a loose sentence');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('G4  A finding is never inside a fold  (EXECUTED)');
// ═══════════════════════════════════════════════════════════════════════════
//
// THE RULE THIS RELEASE APPLIES EVERYWHERE: explanations fold, findings do not.
// The MCP stale note is the outcome of a self-test the user just ran and the
// one thing telling them their client is still launching the old command; the
// scan-limit validation error is why their Save did nothing. Either one behind
// a closed disclosure is information that, for practical purposes, is not there
// — the v3.16.1 finding, restated.
//
// "Not inside a fold" is checked STRUCTURALLY rather than by eye: the marker is
// located, then every `hidden` attribute and every `.settings-block-info` /
// `.tx-vh-panel` opening tag before it is paired against its closing tag, and
// the marker must not fall inside any still-open one.
function insideHiddenContainer(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return 'ABSENT';
  // Walk the div tree up to `at`, tracking the depth at which a hidden /
  // fold-panel container opened. A naive "is `hidden` anywhere before it"
  // check would report every page with a closed fold ABOVE the marker.
  let depth = 0;
  const hiddenDepths = [];
  const tag = /<(\/?)div\b([^>]*)>/g;
  let m;
  while ((m = tag.exec(html)) && m.index < at) {
    if (m[1] === '/') {
      depth--;
      while (hiddenDepths.length && hiddenDepths[hiddenDepths.length - 1] > depth) hiddenDepths.pop();
    } else {
      depth++;
      if (/\bhidden\b/.test(m[2]) || /settings-block-info|tx-vh-panel/.test(m[2])) hiddenDepths.push(depth);
    }
  }
  return hiddenDepths.length > 0;
}
{
  const stale = baseState();
  stale.mcp = { mcp_server_name: 'my-curator', domains_dir: '/tmp/d', installed: true, stale: true,
                claude_config_parse_error: false };
  stale.selfTest = { ok: true, tool_count: 22, tool_names: ['get_index'], domains: ['alpha'] };
  const html = run('renderMcp', stale);
  ok(html.includes('settings-mcp-stale-note'),
    'renderMcp: a stale saved config plus a PASSING self-test renders the reconciliation note');
  ok(html.includes('still launching the'),
    '…with the sentence that explains the contradiction, not just a class name');
  ok(insideHiddenContainer(html, 'settings-mcp-stale-note') === false,
    '…and it is NOT inside any hidden container or ⓘ fold panel');
  ok(insideHiddenContainer(html, 'ChatGPT') !== false,
    'CONTROL: the ChatGPT sentence IS inside the fold — so the detector can tell the two apart');
}
{
  const bad = baseState();
  bad.scanLimitsValidationError = 'Cost ceiling must be a whole number above 0.';
  const html = run('renderHealthLimits', bad);
  ok(html.includes('settings-inline-error'), 'renderHealthLimits: a rejected value renders .settings-inline-error');
  ok(html.includes('must be a whole number'), '…carrying the reason, verbatim');
  ok(insideHiddenContainer(html, 'settings-inline-error') === false,
    '…and it is NOT inside any hidden container or ⓘ fold panel');
}
{
  // ── GENERAL: THE MENU BAR FAILURE-MODE NOTE ─────────────────────────
  // Three separate things can swallow a newly-enabled menu bar icon on a
  // modern Mac — the notch, a menu bar organiser, the menu bar items
  // permission — and macOS gives an app no way to find out which, so the
  // control says so itself. That is a FINDING about the thing the user just
  // switched on, not an explanation of it, and the NEUTRAL half of the same
  // control's old 58-word paragraph is precisely what moved under the
  // Appearance ⓘ when General was converted. Those two halves parted company
  // in one edit; nothing stopped the next such edit taking this half with it.
  const NEEDLE = 'If the icon does not appear';
  const html = run('renderGeneral', baseState());
  ok(html.includes(NEEDLE),
    'renderGeneral: with the menu bar icon ON, the failure-mode note is rendered');
  // NAMED, not '…and it is NOT inside a fold' like the two above it: three
  // identically-worded lines in one section mean the one that goes red cannot
  // be read without counting which of the three it was.
  ok(insideHiddenContainer(html, NEEDLE) === false,
    'renderGeneral: …and that note is NOT inside any hidden container or ⓘ fold panel');
  // Two controls, because this marker can go green for two wrong reasons: a
  // detector that never reports "inside", and a sentence that is not there at
  // all in the state being measured.
  const FOLDED = 'scales every piece of text in the app';
  ok(html.includes(FOLDED) && insideHiddenContainer(html, FOLDED) === true,
    'CONTROL: the Text size explanation IS inside the Appearance ⓘ fold — so the detector can tell the two apart');
  const off = baseState();
  off.config = { ...off.config, backgroundMode: 'window' };
  ok(!run('renderGeneral', off).includes(NEEDLE),
    'CONTROL: with the icon OFF the note is absent — so the assertion above is about the ON state, not about the string existing somewhere');

  // ── THE COMPLEMENT: WHAT MOVED INTO A FOLD IS REALLY IN IT (v3.58.0) ───
  //
  // G4 asserts that findings are NOT folded. Nothing asserted the other
  // direction, and tightening the lede ceiling to thirteen words made that
  // direction the live hazard: the cheapest way to shorten a lede is to delete
  // its second clause, and a deleted clause and a moved clause produce the same
  // short lede. The update block's second sentence — the one saying an update
  // replaces the program and not the data — was MOVED under this block's ⓘ, and
  // it is the answer to the question the button raises. Proven by mutation:
  // deleting it from `updateInfo` left every assertion in this file green.
  //
  // One mode is enough because the sentence is now mode-INDEPENDENT: it was
  // three near-copies inside the three forked ledes and is one sentence in a
  // fold that does not fork. That is the property, so assert it.
  const MOVED = 'are never touched';
  ok(html.includes(MOVED) && /replaces the program, not what it holds/.test(html),
    'renderGeneral: the "an update does not touch your data" sentence is still rendered somewhere');
  ok(insideHiddenContainer(html, MOVED) === true,
    '…in the Software update ⓘ fold — moved there, not deleted, and not loose beside the lede');
  ok((html.match(new RegExp(MOVED, 'g')) || []).length === 1,
    '…exactly once: three forked near-copies became one mode-independent sentence');
}

// ═══════════════════════════════════════════════════════════════════════════
section('G5  Every <details> in this view carries a data- hook');
// ═══════════════════════════════════════════════════════════════════════════
//
// v3.53.1 fixed the Providers screen closing its own disclosures mid-test:
// `render()` now captures which are open before the DOM swap and reopens them
// after, KEYED ON THEIR `data-*` ATTRIBUTE. A `<details>` with no hook cannot
// be keyed, so it silently opts out of the fix — which is exactly what
// `.catalogue-funnel` did, and the release notes say so. That release left the
// rule written in a COMMENT. A comment is not a guard; this is.
{
  let found = 0;
  const unhooked = [];
  for (const m of code.matchAll(/<details\b/g)) {
    found++;
    // The tag ends at the `>` that closes it, which in a concatenated string is
    // `>'` or `>"`. Take a generous window and stop at the first one.
    const window = code.slice(m.index, m.index + 400);
    const endIdx = window.search(/>['"]/);
    const tag = endIdx === -1 ? window.slice(0, 200) : window.slice(0, endIdx);
    if (!/\sdata-[a-z-]+=/.test(tag)) {
      unhooked.push(code.slice(m.index, m.index + 70).replace(/\n/g, ' '));
    }
  }
  ok(found >= 7, `CONTROL: ${found} <details> emitted in views/settings.js (a collapse to 0 would pass vacuously)`);
  ok(unhooked.length === 0,
    unhooked.length
      ? `<details> with no data- hook (render() cannot restore it after a repaint):\n      ${unhooked.join('\n      ')}`
      : 'every <details> carries a data- attribute, so render()\'s capture/restore can key on it');
}

// ═════════════════════════════════════════════════════════════
section('G6  The MCP bridge\u2019s live readings are MONITORS, and a warning is never a reading');
// ═════════════════════════════════════════════════════════════
//
// v3.65.0 (M7–M10). The status card, the stale-bridge note, the self-test
// result and the two session readings were four hand-built shapes for one
// idea; they are `renderMonitor()` calls now. What is asserted here is what a
// class name alone cannot say: that the STATE WORD is the pill’s own label and
// its tone is the one `deriveMcpStatus` derived, and — the v3.16.1 rule — that
// every warning lands OUTSIDE the line list, where it cannot be skimmed past
// as one more figure.
//
// `renderSelfTestResult` is lifted REAL for this section rather than taking
// run()’s stub, because M9 is precisely what that stub stands in for.
function linesBlockOf(html) {
  const a = html.indexOf('cur-mon-lines');
  if (a < 0) return '';
  const b = html.indexOf('</div><div class="cur-mon-loud', a);
  const c = html.indexOf('cur-mon-note', a);
  const end = [b, c].filter((x) => x > 0).sort((x, y) => x - y)[0];
  return end ? html.slice(a, end) : html.slice(a);
}

{
  const html = run('renderMcp', baseState());
  ok(html.includes('cur-mon'), 'renderMcp: the connection strip is a MONITOR, not a hand-built status card');
  ok(html.includes('cur-mon-state') && html.includes('Connected'),
    '\u2026whose head word is the pill\u2019s own label');
  ok(/cur-mon-state cur-mon-ok/.test(html),
    '\u2026carrying the tone deriveMcpStatus derived (connected \u2192 ok)');
  ok(html.includes('my-curator') && html.includes('/tmp/d'),
    '\u2026and the server name and domains folder are its lines');
  ok(!html.includes('status-pill') && !html.includes('mcp-path-line'),
    '\u2026and neither retired class name is written any more');
}
{
  const off = baseState();
  off.mcp = { mcp_server_name: 'my-curator', domains_dir: '/tmp/d', installed: false, stale: false };
  const html = run('renderMcp', off);
  ok(/cur-mon-state cur-mon-quiet/.test(html) && html.includes('Not connected'),
    'a bridge nobody has set up is QUIET, never warn \u2014 an amber mark on a fresh install '
    + 'reports a fault the app invented');
}
{
  const bad = baseState();
  bad.mcp = { mcp_server_name: 'my-curator', domains_dir: '/tmp/d', claude_config_parse_error: true };
  const html = run('renderMcp', bad);
  ok(/cur-mon-state cur-mon-danger/.test(html) && html.includes('Config unreadable'),
    '\u2026and a config the app could not PARSE is the one danger state');
}
{
  // THE STALE-BRIDGE WARNING (M8) \u2014 loud, and outside the readings.
  const st = baseState();
  st.mcp = { ...st.mcp,
    bridge_processes: { checked: true, running: 2,
      stale: [{ pid: 1, startedAt: new Date(Date.now() - 36e5).toISOString(), ageMs: 36e5 }] },
    bridge_stale_remedy: 'Restart the app that launched it.' };
  const html = run('renderMcp', st);
  ok(html.includes('cur-mon-loud'), 'the stale-bridge note is a `loud` entry inside the monitor');
  ok(html.includes('Restart the app that launched it.'),
    '\u2026carrying the remedy sentence the ROUTE supplied, verbatim');
  ok(!linesBlockOf(html).includes('still running from before this version'),
    '\u2026and it is NOT in the line list: v3.16.1 \u2014 a warning is never one more reading');
  ok(insideHiddenContainer(html, 'still running from before this version') === false,
    '\u2026nor inside any fold');
}
{
  // THE SELF-TEST OUTCOME (M9), both arms, through the REAL renderer.
  const okState = baseState();
  okState.selfTest = { ok: true, tool_count: 24, tool_names: ['get_index'], domains: ['alpha'] };
  const good = run('renderMcp', okState,
    { renderSelfTestResult: lift('renderSelfTestResult', okState) });
  ok(/cur-mon-state cur-mon-ok[^]*Bridge responds/.test(good),
    'a passing self-test is a monitor whose head word is the outcome');
  ok(good.includes('24'), '\u2026with the tool count as a reading');

  const failState = baseState();
  failState.selfTest = { ok: false, error: 'spawn ENOENT' };
  const bad = run('renderMcp', failState,
    { renderSelfTestResult: lift('renderSelfTestResult', failState) });
  ok(/cur-mon-state cur-mon-danger[^]*Self-test failed/.test(bad),
    'a failing one says so in its head word, in the danger tone');
  ok(/cur-mon-loud[^]*spawn ENOENT/.test(bad) && !linesBlockOf(bad).includes('spawn ENOENT'),
    '\u2026and the server\u2019s own message is LOUD, not a reading \u2014 it is the outcome of a press '
    + 'and the only thing on screen the user can act on');
}
{
  // THE SESSION READINGS (M10) \u2014 one monitor, and the 1s clock still reaches
  // both lines through the hook composed inside `markHtml`.
  const stamp = new Date(Date.now() - 45 * 60e3).toISOString();
  const strip = lift('renderSessionStrip', baseState())(
    { lastBootstrapAt: stamp, lastSaveAt: null }, Date.now());
  ok((strip.match(/class="cur-mon-line"/g) || []).length === 2,
    'the two session readings are TWO LINES of ONE monitor, not two blocks');
  ok(strip.includes('data-mcp-age-at="' + stamp + '"') && strip.includes('mcp-age-words'),
    '\u2026and a stamped reading carries the tick hook and the element the clock writes into');
  ok(!/data-mcp-age-at[^>]*>\s*<span class="mcp-age-words">none since/.test(strip)
     && strip.includes('none since this log began'),
    '\u2026while an absent one says so in words and takes no hook, because there is nothing to recount');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ /next Settings-section assertions FAILED'); process.exit(1); }
console.log('✅ All /next Settings-section assertions green');
