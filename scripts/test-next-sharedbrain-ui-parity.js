/**
 * test-next-sharedbrain-ui-parity.js — OFFLINE suite.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * v3.41.0 deleted src/public/{app.js,index.html}. Twenty-nine assertions in
 * scripts/test-sharedbrain-hardening.js read those two files — the Phase 1
 * block, the Phase 3 UI/UX block (M9–M16, H10, L12, L14, L16, L18) and the
 * Phase 4 admin block (4.1–4.5). They were removed with the shell, and the
 * removal note said plainly that whether each guarded property had a /next
 * counterpart AT ALL had not been established.
 *
 * This file establishes it. Each section names the PROPERTY the deleted
 * assertion guarded — never the identifier it happened to name, because
 * /next is a different codebase and every one of these has a different name
 * there or no name at all. Four of the twenty-nine properties are genuinely
 * ABSENT from /next; three of those are declined IN CODE with a stated
 * reason, and this file pins the refusals so a silent reversal is visible.
 *
 * WHAT THIS SUITE PROVES, AND HOW
 * ───────────────────────────────
 * EXECUTED (the real function is cut out of the real source by brace-match
 * and run in a `new Function` sandbox — the loader
 * scripts/test-next-sharedbrain-admin.js already uses):
 *   formatRelativeTime, composeDoneMessage, renderActions,
 *   renderSynthesizeConfirm, renderSkips, renderEnabled, freshState (wizard),
 *   isReadOnlyVerdict, wizardShellHtml, panelStep2, panelStep4,
 *   panelAdminStep2.
 *
 * SOURCE-GUARDED, comment-stripped and scoped to one function's body where
 * possible: the DOM-bound halves — the focus trap, the on-ENTRY link
 * population, the debounce sequence guards, the checkbox restore, the
 * write-gate registration, and the two absences that are decisions rather
 * than functions. A source guard is the weakest shape a check can take and
 * every one of them says so at its own site; they are here because the
 * subject cannot be executed without a DOM, not because it was easier.
 *
 * NOT COVERED: anything requiring a browser — that Tab actually cycles, that
 * Escape actually reaches the handler, that a re-render preserves focus.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// shared/text.js takes no imports by design, precisely so a suite can EXECUTE
// it rather than scan it (see its own "WHY IT HAS NO IMPORTS" header).
import { renderDescription } from '../src/public/next/shared/text.js';
// v3.71.1: every ⓘ in shared.js and the wizard is shared/explainer.js's
// `explainerMark` (which paints through text.js's renderInfoMark). The REAL
// kit is injected under that name — import-free and headless.
import { explainerHtml, explainerMark } from '../src/public/next/shared/explainer.js';
import { EXPLAINERS } from '../src/public/next/shared/explainers.js';
// v3.65.3: the section body is built from three kit parts, and they are the
// REAL ones here — a stub monitor would test a monitor this suite invented.
import { renderMonitor } from '../src/public/next/shared/monitor.js';
import { freshnessTier, formatAge } from '../src/public/next/shared/age.js';
import { identitySlotClass } from '../src/public/next/shared/sidebar.js';

const R = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const shared = R('src/public/next/views/shared.js');
const wizard = R('src/public/next/views/shared-brain-wizard.js');
const settings = R('src/public/next/views/settings.js');
const syncView = R('src/public/next/views/sync.js');
const ingest = R('src/public/next/views/ingest.js');
const chat = R('src/public/next/views/chat.js');
const appJs = R('src/public/next/app.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Comment stripping ───────────────────────────────────────────────────
// Every ABSENCE and PRESENCE check below runs against stripped code. These
// files argue about their own design in prose, and several of them quote
// the exact identifiers this suite asks about — `sharedbrain:${connId}`,
// `chatReadonlyDomains`, `pending_pages` — inside the comment that explains
// why they are not used. A raw-text scan would be reading the explanation
// instead of the code, which is this repo's recorded "the check stopped
// reaching what it protects" shape.
//
// Conservative on purpose: /* … */ blocks and whole-line //. End-of-line
// comments survive, because telling them from a // inside a string needs a
// real lexer, and for an absence check leaving too much in is a false
// FAILURE somebody must look at — never a false pass.
//
// THE ORDER IS LOAD-BEARING, AND THE CANARY IS WHAT FOUND IT. The copies of
// this helper elsewhere strip /* … */ FIRST. Run that way over
// src/public/next/app.js, a prose line reading `// … views/*.js — and …`
// opens a block comment that never closes until 23,148 characters later,
// swallowing `beginDomainWrite` whole — the guard would then have reported
// the gate ABSENT, or, worse for an absence check, reported a real
// identifier missing because a sentence mentioned a glob. Whole-line //
// comments therefore go FIRST; a real block comment's inner lines start
// with `*`, never `//`, so nothing is lost by doing it in this order.
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
const sharedCode = assertStrippedSane(stripComments(shared), 'shared.js',
  ['function renderActions(', 'function composeDoneMessage(', "case 'unskip':"]);
const wizardCode = assertStrippedSane(stripComments(wizard), 'shared-brain-wizard.js',
  ['function goToStep(', 'function onWizardKeydown(', 'function isReadOnlyVerdict(']);
const settingsCode = assertStrippedSane(stripComments(settings), 'settings.js',
  ['const SETTINGS_SECTIONS', 'function renderMcp(']);
const syncCode = assertStrippedSane(stripComments(syncView), 'sync.js',
  ['function renderSharedBrainRow(', 'function renderDisconnect(']);
const ingestCode = assertStrippedSane(stripComments(ingest), 'ingest.js',
  ['readonlyDomains']);
const chatCode = assertStrippedSane(stripComments(chat), 'chat.js',
  ['function renderCompileButtonHtml(']);
const appCode = assertStrippedSane(stripComments(appJs), 'app.js',
  ['export function beginDomainWrite(']);

// ── Extraction — brace-matched, parameter list skipped, loud on desync ───
function extractFunction(src, name, label) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  // The parameter list is matched FIRST: several of these take a
  // destructured argument, and a naive indexOf('{') latches onto the
  // parameter pattern and "ends" the function at the closing paren.
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
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted.replace(/^export\s+/, '');
}
/** Brace-match one function body out of source, for a SCOPED source guard. */
function bodyOf(src, name) {
  const fn = extractFunction(src, name, 'scoped');
  return fn.slice(fn.indexOf('{'));
}

// ── Sandboxes ───────────────────────────────────────────────────────────
// The REAL escapeHtml (escaping is the security-relevant part and must never
// be a stand-in) and an icon() stand-in that ECHOES its arguments, so a leak
// through icon() shows up in asserted output rather than hiding behind a
// constant.
const ICON_STUB = 'function icon(name, size) { return "<svg data-icon=\\"" + name + "\\" data-size=\\"" + size + "\\"></svg>"; }\n';

const SHARED_FNS = [
  'formatRelativeTime', 'composeDoneMessage', 'renderActions',
  'renderPushConfirm', 'renderSynthesizeConfirm', 'renderSkips', 'renderEnabled',
  // v3.58.0: the off state is now measured, not only source-scanned (§4b).
  'renderDisabled',
];
// renderDescription is the REAL export of shared/text.js, not a stub: §4 below
// asserts that the off state's CTA descriptions wear the system's own class,
// and a stub would let this file certify a class it had itself invented.
const sharedBox = new Function('renderDescription', 'explainerMark', 'formatAge',
  'let state = { flagError: null, listError: null, enabling: false, connections: [], cards: {}, expandedSkips: new Set(), expandedAdmin: new Set() };\n' +
  extractFunction(appJs, 'escapeHtml', 'app.js') + '\n' +
  ICON_STUB +
  SHARED_FNS.map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
  `return { ${SHARED_FNS.join(', ')}, __setState: (s) => { state = s; }, __state: () => state };`
)(renderDescription, explainerMark, formatAge);

/** Brace-free sibling of extractFunction: lifts a top-level `const NAME = …;`
 *  out of live source. Needed because panelStep3() now interpolates a real
 *  constant (the PAT expiry warning), and a sandbox that redeclared it here
 *  would be asserting against a copy of the copy — the exact shape this file
 *  already refuses for functions. Scans with string/bracket awareness so a
 *  ';' inside a quoted sentence cannot end the declaration early. */
function extractConst(src, name, where) {
  const m = new RegExp(`(?:^|\\n)const ${name}\\s*=`).exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('=', start) + 1;
  let depth = 0, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  const out = src.slice(start, i);
  if (!out.endsWith(';')) throw new Error(`extractConst: "${name}" did not terminate in ${where}`);
  return out;
}

// wizardShellHtml() composes every panel builder, so all of them are loaded.
const WIZ_CONSTS = ['PAT_EXPIRY_WARNING', 'ATTRIBUTION_FIXED_NOTE'];
const WIZ_FNS = [
  'freshState', 'isReadOnlyVerdict', 'wizardShellHtml',
  'panelStep1', 'panelStep2', 'panelStep3', 'panelStep4', 'panelStep5',
  'panelAdminStep1', 'panelAdminStep2',
];
const wizBox = new Function('explainerMark',
  'let state = {};\n' +
  extractFunction(appJs, 'escapeHtml', 'app.js') + '\n' +
  ICON_STUB +
  WIZ_CONSTS.map((n) => extractConst(wizard, n, 'shared-brain-wizard.js')).join('\n') + '\n' +
  WIZ_FNS.map((n) => extractFunction(wizard, n, 'shared-brain-wizard.js')).join('\n\n') + '\n' +
  `return { ${WIZ_FNS.join(', ')}, __setState: (s) => { state = s; }, __state: () => state };`
)(explainerMark);

const {
  formatRelativeTime, composeDoneMessage, renderActions,
  renderSynthesizeConfirm, renderSkips, renderEnabled,
} = sharedBox;

// ── Fixtures ────────────────────────────────────────────────────────────
function conn(over) {
  return Object.assign({
    id: 'c1', label: 'Cohort', shared_brain_slug: 'cohort', repo: 'org/cohort',
    local_domains: ['research'], read_only: false, pending_pages: 3,
    permanent_skip: {}, last_synthesis_at: null, is_admin: false,
  }, over || {});
}
function card(over) {
  return Object.assign({
    acting: null, message: null, error: null,
    pushConfirmOpen: false, synthesizeConfirmOpen: false,
    shownAdminToken: null, expandedSkips: false,
  }, over || {});
}

// ═══════════════════════════════════════════════════════════════════════
section('1. Phase 1 — the four properties the first deleted block guarded');
// ═══════════════════════════════════════════════════════════════════════
{
  // ── P1: read-only mirrors are kept OUT of the Ingest destination ──────
  // Old assertion: `appJs.includes('readonlyDomains.includes(d)')`.
  // The PROPERTY is that a shared-* mirror can never be picked as an ingest
  // destination — mirrors are read-only and an ingest into one would be
  // refused after the user paid for it.
  //
  // SOURCE-GUARDED and scoped, because the filter lives inside an async
  // fetch-and-normalise function that cannot run without a network stub.
  // The strength here is the SCOPE: it is the loader's own body, so a
  // filter moved out of it reds this.
  const loader = bodyOf(ingestCode, 'fetchDomainStats');
  ok(/readonlyDomains/.test(loader),
    'ingest: the domain loader reads the route\'s readonlyDomains list');
  ok(/\.filter\(/.test(loader) && /readonly\.has\(/.test(loader),
    '…and FILTERS the list with it, rather than only labelling the rows');
  // Anti-vacuity: the listbox must consume the filtered list, not re-derive
  // its own from the raw response. One builder, one filter.
  const cfg = bodyOf(ingestCode, 'domainListboxCfg');
  ok(/state\.domains/.test(cfg) && !/readonlyDomains/.test(cfg),
    '…and the destination listbox reads that filtered list rather than re-deriving one');

  // ── P2: every Shared Brain operation goes through a write gate ────────
  // Old assertion: a literal key `sharedbrain:${connId}`.
  // The PROPERTY is mutual exclusion against the OTHER writers of the same
  // domain — an ingest, a compile, a sync — not the spelling of the key.
  // /next keys the gate by DOMAIN instead, which is strictly stronger:
  // a per-connection key excludes a second click on the same card and
  // nothing else, while the domain key also excludes an ingest into the
  // very folder a push is reading.
  ok(/export function beginDomainWrite\(/.test(appCode),
    'app.js exports a domain write gate');
  const sseAction = bodyOf(sharedCode, 'runSseAction');
  ok(/beginDomainWrite\(/.test(sseAction),
    'shared.js: push/pull/synthesize take the gate before the request');
  ok(/domainsForAction\(/.test(sseAction),
    '…for the domains that action actually touches, derived rather than hardcoded');
  // The per-connection half of the old property survives too, as card.acting.
  ok(/card\.acting/.test(sseAction),
    '…and the per-connection single-flight flag is still taken as well');

  // ── P3: the enable control is NOT in the Sync view ────────────────────
  // Old assertion: the enable button's ID absent from the Sync tab's markup.
  // This is the half of the old pair that /next SATISFIES, and it is worth
  // asserting positively rather than assuming, because Sync does render a
  // Shared Brain row.
  const sbRow = bodyOf(syncCode, 'renderSharedBrainRow');
  ok(!/data-sb-action|btn-sb-enable|enable-flag/.test(sbRow),
    'sync: the Shared Brain row carries no enable, push, pull or synthesize control');
  ok(/This tab only reports them/.test(sbRow),
    '…and says so — it reports, it does not operate');
  // Control: the row is real and was read.
  ok(sbRow.length > 200 && /sharedBrainRowLines\(/.test(sbRow)
    && /last_contribution_at/.test(bodyOf(syncCode, 'sharedBrainRowLines')),
    '(control) the Shared Brain row really was extracted and does report the last push (v3.72.1: the contribution time, per connection)');

  // ── P4: the enable control EXISTS somewhere reachable ─────────────────
  // Old assertion: `indexHtml.includes('settings-sharedbrain-enabled')`.
  // MOVED, NOT LOST — and this is a doc divergence, not a defect. CLAUDE.md
  // still says "the Shared Brain enable toggle lives in Settings"; in /next
  // it lives on the Shared Brain view's own disabled state, argued in that
  // file's header. Settings is not a top-level home for it because /next has
  // a Shared Brain VIEW, which the old shell did not.
  //
  // What matters is that the control exists and is reachable, so assert THAT
  // by executing the disabled-state renderer.
  const enableMarkup = bodyOf(sharedCode, 'renderDisabled');
  ok(/btn-sb-enable/.test(enableMarkup),
    'shared: the enable control lives on the Shared Brain view\'s off state');
  ok(/enable-flag/.test(bodyOf(sharedCode, 'onEnableFlag')),
    '…and posts to the feature-flag endpoint');
  // v3.67.0 (package SD): Settings › Providers & keys › "Your AI model" now
  // NAMES every job its model runs, Shared Brain among them, in a lede noun
  // keyed by the AI_JOBS id. That one entry is a word in a sentence, not a
  // control; it is exempted EXACTLY (the control below proves it is there
  // once and only once), so any other mention still reds this guard.
  const SB_LEDE_NOUN = "'shared-brain': 'Shared Brain', ";
  ok(settingsCode.split(SB_LEDE_NOUN).length === 2,
    '(control) settings.js carries the Shared Brain lede noun exactly once — the only exemption below');
  ok(!/sharedbrain|shared-brain|Shared Brain/i.test(settingsCode.replace(SB_LEDE_NOUN, '')),
    'settings.js hosts NO Shared Brain control — the toggle moved to the feature\'s own view');

  // ── P4b: THE OFF STATE SAYS ONE THING, AND STILL SAYS THE REST (v3.58.0) ──
  //
  // That card carried a 49-word paragraph under its title doing a lede's job.
  // The text rule caps a lede at THIRTEEN visible words and puts the rest
  // behind the ⓘ — but "put it behind the ⓘ" and "delete it" produce the same
  // short card, and one of them silently drops the two sentences that answer
  // "is this safe?". So both halves are asserted here, EXECUTED against the
  // real renderer with the real renderInfoMark, because a source scan cannot
  // tell a sentence that is rendered from one that is merely typed.
  const off = sharedBox.renderDisabled();
  ok(/btn-sb-enable/.test(off) && /sb-enable-title/.test(off),
    '(control) renderDisabled() really rendered its title and its enable button');
  const visible = (off.match(/<p class="settings-hint-text">([\s\S]*?)<\/p>/) || [, ''])[1]
    .replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').trim()
    .split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  ok(visible.length >= 4 && visible.length <= 13,
    `the visible sentence is ${visible.length} words (4..13): "${visible.join(' ')}"`);
  // v3.71.1: the two reassurances are the `shared.enable` explainer now —
  // asserted as the panel that renders, then on what it says.
  ok(off.includes(explainerMark('sb-enable-info', 'shared.enable').panel),
    '…and the ⓘ that holds the rest IS the shared.enable explainer, rendered in the card');
  for (const kept of ['By itself it connects you to nothing', 'Nothing leaves this computer until you push']) {
    ok(off.includes(kept), `…and the reassurance "${kept}…" is still rendered, not cut`);
  }
  ok(/class="tx-vh-panel"[^>]*hidden/.test(off),
    '…inside a fold that ships CLOSED and is present in the markup, not fetched later');
}

// ═══════════════════════════════════════════════════════════════════════
section('2. Phase 3 — the fifteen properties of the second deleted block');
// ═══════════════════════════════════════════════════════════════════════
{
  // ── M12/M13: a per-connection registry whose writes reach the CURRENT
  // card in the DOM, never a captured node ──────────────────────────────
  // Old assertion: two module globals, `_sbInFlight` / `_sbLastResult`.
  // The PROPERTY is that async work started on one mount must not write into
  // a node a later mount has replaced. /next holds per-connection records in
  // `state.cards[id]` and resolves the DOM by ATTRIBUTE at write time.
  ok(/state\.cards/.test(sharedCode) && /function ensureCard\(/.test(sharedCode),
    'shared: there is a per-connection record store, keyed by connection id');
  // revealRevokeOutcome() now delegates to revealInCard(), which the
  // shown-once admin-token reveal shares — so the property lives one hop
  // down and is asserted THERE, plus the delegation itself. Asserting only
  // the wrapper would go green on a wrapper that had stopped resolving by
  // attribute at all.
  ok(/revealInCard\(connId/.test(bodyOf(sharedCode, 'revealRevokeOutcome')),
    'shared: the revoke reveal goes through the shared card-scoped lookup');
  const reveal = bodyOf(sharedCode, 'revealInCard');
  ok(/data-conn-id="' \+ connId/.test(reveal) || /data-conn-id/.test(reveal),
    '…and the DOM is resolved by data-conn-id at write time, not from a captured node');
  ok(/document\.querySelector/.test(reveal),
    '(control) the lookup really is a live document query');

  // ── M13: the done message is COMPOSED, and it prefers the server's own
  // sentence over a locally invented one ────────────────────────────────
  // EXECUTED.
  ok(composeDoneMessage('pull', { message: 'Server said so' }, 'ignored') === 'Server said so',
    'composeDoneMessage: a server-supplied message wins outright');
  const pulled = composeDoneMessage('pull', { result: { created: 2, updated: 1, unchanged: 7 } }, null);
  ok(typeof pulled === 'string' && pulled.length > 0 && /2/.test(pulled),
    '…and a pull with counts composes a sentence carrying them');
  const synth = composeDoneMessage('synthesize', { result: { pages_written: 4 } }, null);
  ok(typeof synth === 'string' && /4/.test(synth),
    '…and a synthesis reports pages written');
  ok(composeDoneMessage('pull', null, 'last frame said this') === 'last frame said this',
    '…and with no payload at all it falls back to the last stream frame, never to empty');

  // ── M11: BOTH debounced validations carry a sequence guard ────────────
  // Old assertion: `(appJs.match(/mySeq !== seq/g) || []).length >= 2`.
  // The PROPERTY is that a slow first response cannot overwrite the verdict
  // of a later, faster one. SOURCE-GUARDED: both live inside debounced
  // async handlers that need a DOM and a fetch.
  //
  // Asserted per-VALIDATION rather than by a global count, because a count
  // of two is satisfied by one validation guarded twice — which is exactly
  // how the shape of this property gets lost.
  const step1 = bodyOf(wizardCode, 'bindStep1');
  const step3 = bodyOf(wizardCode, 'bindStep3');
  ok(/mySeq !== state\.\w+Seq/.test(step1),
    'wizard: the invite-token validation carries a sequence guard');
  ok(/mySeq !== state\.\w+Seq/.test(step3),
    'wizard: the PAT validation carries its own, separately');
  ok(/\+\+state\.\w+Seq/.test(step1) && /\+\+state\.\w+Seq/.test(step3),
    '…and each bumps its own counter, so one cannot cancel the other');
  ok(/isFresh\(myGen\)/.test(step1) && /isFresh\(myGen\)/.test(step3),
    '…and each also checks the wizard generation, so a CLOSED wizard cannot be written into');

  // ── M10: step-4 checkboxes are restored from state on re-render ───────
  const populate = bodyOf(wizardCode, 'populateDomains');
  ok(/\.checked = state\.selectedDomains\.has\(/.test(populate),
    'wizard: step-4 checkboxes are restored from wizard state, not from the DOM');
  ok(/state\.selectedDomains\.delete\(/.test(populate),
    '…and a selection whose domain has disappeared is pruned rather than silently carried');
  ok(/state\.selectedDomains\.add\(/.test(populate),
    '…with the binding two-way, so the restore has something true to restore FROM');

  // ── M9: panel side effects run on ENTRY, in goToStep ──────────────────
  // The named invariant: "Wizard panel side effects (link population) belong
  // in sbWizardGoToStep (on ENTRY), not in the buttons that leave a panel."
  // A Back button is the case that breaks the other way round.
  const goToStep = bodyOf(wizardCode, 'goToStep');
  ok(/refreshStep2Links\(\)/.test(goToStep),
    'wizard: step-2 links are populated inside goToStep — on ENTRY');
  ok(/refreshPatCreateLink\(\)/.test(goToStep),
    '…and so is the step-3 link');
  ok(!/refreshStep2Links\(\)/.test(bodyOf(wizardCode, 'bindStep1')),
    '…and NOT in the button that leaves step 1, which a Back navigation never presses');

  // ── H10: the wizard saves read_only, and only on a verdict that earned it
  // EXECUTED.
  wizBox.__setState({ patValidatedRepo: 'org/cohort', validation: { kind: 'warn' },
    meta: { repo: 'org/cohort' } });
  const readOnlyFn = wizBox.isReadOnlyVerdict;
  ok(typeof readOnlyFn === 'function', 'wizard: isReadOnlyVerdict() is a real function, executed here');
  const saveBlock = bodyOf(wizardCode, 'bindStep5');
  ok(/read_only: isReadOnlyVerdict\(\)/.test(saveBlock),
    '…and the saved connection takes read_only FROM it, not from a raw form value');

  // ── L16: the wizard is a real modal with a focus trap and Escape ──────
  // EXECUTED for the markup half.
  const shell = wizBox.wizardShellHtml('join');
  ok(/role="dialog"/.test(shell) && /aria-modal="true"/.test(shell),
    'wizard: the overlay renders as role=dialog aria-modal=true');
  ok(/aria-labelledby=/.test(shell), '…and names its own label');
  const keydown = bodyOf(wizardCode, 'onWizardKeydown');
  ok(/Escape/.test(keydown), 'wizard: Escape is handled');
  ok(/Tab/.test(keydown) && /shiftKey/.test(keydown),
    '…and Tab/Shift-Tab are trapped');
  // The property is unchanged; the shape is not. Escape now asks
  // requestDismiss(), which asks dismissDecision() with isSaveBlocking() as
  // its saveInProgress arm — one function answers for Escape, the scrim, the
  // Close (x) and both Cancels, so the four cannot disagree. Both hops are
  // pinned, because asserting only the first would go green on a
  // requestDismiss() that had quietly stopped consulting the save flag.
  ok(/requestDismiss\(\)/.test(keydown),
    '…with Escape routed through the single dismiss chokepoint rather than closing directly');
  ok(/isSaveBlocking\(\)/.test(bodyOf(wizardCode, 'requestDismiss')),
    '…and that chokepoint refuses mid-save, so Escape cannot imply a cancellation that did not happen');
  ok(/aria-current', 'step'/.test(goToStep) || /aria-current["']?, ?["']step/.test(goToStep),
    'wizard: the active progress pip carries aria-current="step"');

  // ── M14: the Shared Brain pending count reaches the user ──────────────
  // ABSENT FROM THE SHELL BADGE, DECLINED IN CODE. app.js:~1360 states the
  // refusal: the badge counts git pending changes only, because adding the
  // Shared Brain number doubles the request count on every refresh. The
  // number itself is NOT lost — it is on the Shared Brain view, per
  // connection, which is where an action can be taken about it.
  //
  // Pinned in BOTH directions so a silent reversal is visible either way.
  ok(!/pending_pages/.test(appCode),
    'app.js: the shell badge does NOT fold in Shared Brain pending_pages (a stated refusal)');
  ok(/pending_pages/.test(sharedCode),
    '…and the count IS surfaced on the Shared Brain view itself, so it is not lost');
  // The Sync view reports only that Shared Brain pushes exist and when the
  // last one was — it does NOT carry the pending count either. Pinned so the
  // one surface that DOES carry it is not mistaken for three.
  ok(!/pending_pages/.test(bodyOf(syncCode, 'renderSharedBrainRow')),
    '…and the Sync row does not carry it either — the Shared Brain view is its ONE home');

  // ── M16: the never-synthesised case has its own words ─────────────────
  // EXECUTED — the exact string the deleted assertion named survives.
  ok(formatRelativeTime(null, 'never — ask your admin to run synthesis')
      === 'never — ask your admin to run synthesis',
    'formatRelativeTime: a null timestamp yields the caller\'s never-label, not a blank or an epoch');
  ok(formatRelativeTime(undefined, 'X') === 'X' && formatRelativeTime('', 'X') === 'X',
    '…for every falsy shape the API can send');
  const nonNever = formatRelativeTime(new Date().toISOString(), 'never — ask your admin');
  ok(!/never/.test(nonNever),
    '(control) a REAL timestamp does not take the never branch');
  ok(/never — ask your admin to run synthesis/.test(bodyOf(sharedCode, 'renderCard')),
    '…and the card passes exactly that label for last-synthesis');

  // ── M15: permanently-skipped pages can be re-queued ───────────────────
  // EXECUTED. Named `unskip` in /next, not `retry-skipped`.
  // /next's wire shape for permanent_skip is an ARRAY of page paths (the
  // route flattens the brain's strike map before it reaches the view). Found
  // by executing the function rather than by reading it: an object fixture
  // crashes on .filter, which is itself worth knowing about the contract.
  sharedBox.__setState({ expandedSkips: new Set() });
  const skipsHtml = renderSkips(
    conn({ permanent_skip: ['entities/a.md', 'concepts/b.md'] }),
    card());
  ok(typeof skipsHtml === 'string' && skipsHtml.length > 0,
    'renderSkips: pages that permanently failed to push are rendered at all');
  ok(/data-sb-action="unskip"/.test(skipsHtml),
    '…with an action that re-queues them');
  ok(/entities\/a\.md/.test(skipsHtml) && /concepts\/b\.md/.test(skipsHtml),
    '…and it NAMES the pages, so the user can see what was dropped');
  // Anti-vacuity: the same renderer over an EMPTY skip list must not produce
  // the same string, or every assertion above is about a constant.
  const noSkips = renderSkips(conn({ permanent_skip: [] }), card());
  ok(noSkips !== skipsHtml && !/entities\/a\.md/.test(noSkips),
    '(control) an empty skip list renders differently and names no page');
  ok(/>0<|>\s*0\s*</.test(noSkips) || /\b0 pages\b/.test(noSkips),
    '(control) …and reports zero rather than a stale count');

  // ── L12: an init failure is reported, not rendered as "no connections" ─
  ok(/state\.flagError/.test(sharedCode) && /state\.listError/.test(sharedCode),
    'shared: the feature-flag load and the connection-list load have SEPARATE error states');
  const mainRender = bodyOf(sharedCode, 'renderMain') + bodyOf(sharedCode, 'renderEnabled');
  ok(/flagError/.test(mainRender) && /listError/.test(mainRender),
    '…and both are rendered rather than collapsing into an empty list');
  ok(/btn-sb-retry-list/.test(sharedCode),
    '…with a retry, so a transient failure is not a dead end');

  // ── L14: step 4 has an inline status line ─────────────────────────────
  // EXECUTED.
  const p4 = wizBox.panelStep4();
  ok(/sbw-step4-status/.test(p4), 'wizard: step 4 carries its own inline status element');
  ok(/aria-live="polite"/.test(p4), '…announced politely, so a screen reader hears the verdict');

  // ── L18: the step-2 hint names the REPO, never a phantom admin name ────
  // EXECUTED.
  const p2 = wizBox.panelStep2();
  ok(/invite-repo/.test(p2), 'wizard: step 2 has a slot for the repository name');
  ok(/refreshStep2Links/.test(wizardCode) && /\.textContent = meta\.repo/.test(wizardCode),
    '…filled from the invite\'s own metadata');
  ok(!/admin['’]s name|the administrator's name/i.test(p2),
    '…and never claims to know an administrator\'s name');

  // ── The Compile button and read-only mirrors ──────────────────────────
  // ABSENT, DECLINED IN CODE (chat.js:~2536): the backend refuses a compile
  // into a shared-* mirror with a user-facing 400, and duplicating the
  // domain-readonly test in the view would be a second place for the two to
  // drift. Pinned in both directions: the view must NOT carry its own copy,
  // and the refusal must still be reachable on the error path.
  const compileBtn = bodyOf(chatCode, 'renderCompileButtonHtml');
  ok(!/readonly|read_only/i.test(compileBtn),
    'chat: the Compile button does NOT carry a second copy of the read-only rule (stated refusal)');
  ok(/read.?only/i.test(chatCode),
    '…and the read-only outcome is still handled, on the error path where the backend puts it');
}

// ═══════════════════════════════════════════════════════════════════════
section('3. Phase 4 — the ten admin properties of the third deleted block');
// ═══════════════════════════════════════════════════════════════════════
{
  // Five of these ten (the full-UUID revoke literal, the typed short
  // confirmation, the rotate affordance, the invite re-display, and
  // data_handling_terms at save) are already driven BEHAVIOURALLY by
  // scripts/test-next-sharedbrain-admin.js and
  // scripts/test-next-invite-and-inert.js. They are NOT re-asserted here —
  // a second copy of an assertion is a second place for it to drift. What
  // follows is the remainder, which nothing covered.

  // ── 4.1: the generated admin token is held across a Back, and only the
  // FIRST one is kept ───────────────────────────────────────────────────
  // EXECUTED for the state slot; scoped-source for the first-wins rule,
  // which lives inside a fetch handler.
  const fresh = wizBox.freshState();
  ok(Object.prototype.hasOwnProperty.call(fresh, 'generatedAdminToken'),
    'wizard: freshState() carries a slot for the generated admin token');
  ok(fresh.generatedAdminToken === null,
    '…and it starts empty, so closing the wizard cannot leak the previous cohort\'s token');
  // v3.65.3 (D4): the invite — and with it the admin token — is minted by
  // the TOKEN step's Continue (mintInvite), no longer by admin step 1.
  const adminStep1 = bodyOf(wizardCode, 'mintInvite');
  ok(/if \(!state\.generatedAdminToken/.test(adminStep1),
    '…and a regenerate after a Back keeps the FIRST token — the one the user was told to save');

  // ── 4.1: the token is displayed once, on step 2 ───────────────────────
  // EXECUTED.
  const admin2 = wizBox.panelAdminStep2();
  ok(/sbw-admin-token-block/.test(admin2),
    'wizard: step 2 has a dedicated admin-token block');
  ok(/sbw-admin-admin-token/.test(admin2),
    '…with the element the token is written into');
  ok(/only here, only once/i.test(admin2),
    '…and says in plain words that this is the only time it will be shown');
  ok(/not the invite token/i.test(admin2),
    '…and distinguishes it from the invite token, which IS re-displayable');

  // ── 4.1: the shown-once display deliberately does NOT refresh the list ─
  // This is a named invariant — "the card's shown-once token display
  // deliberately skips the post-op list refresh; don't 'fix' that by adding
  // one" — because a refresh re-reads the MASKED listing and would replace
  // the only copy of the token the user will ever see with dots.
  //
  // Asserted STRUCTURALLY: the wizard's caller-refresh callback is invoked
  // from exactly one place, and that place is the save, not the token
  // display.
  // Counted as an INVOCATION, not as a mention: the save path lifts the
  // callback into a local first (`const onSaved = state.onSaved;`) so a
  // `state.onSaved(` scan finds zero. Matching the call shape instead.
  const onSavedCalls = (wizardCode.match(/(?<![.\w])onSaved\(\)/g) || []).length;
  ok(onSavedCalls === 1,
    `wizard: the caller's refresh callback is INVOKED from exactly ONE site (found ${onSavedCalls})`);
  ok(/onSaved/.test(wizardCode),
    '(control) the scan is looking at a file that does mention the callback at all');
  ok(!/onSaved/.test(bodyOf(wizardCode, 'bindAdminStep1')),
    '…and it is NOT the admin-token generate path — a refresh there would mask the shown-once token');
  ok(/onSaved/.test(bodyOf(wizardCode, 'bindStep5')),
    '…it is the save, which is the only place a refreshed list is correct');
  // The card-side rotate has the same property.
  const rotate = bodyOf(sharedCode, 'onRotateAdminToken');
  ok(/shownAdminToken/.test(rotate),
    'shared: a rotated token is held on the card for display');
  ok(!/refreshConnections\(|loadConnections\(/.test(rotate),
    '…and the rotate path does NOT reload the list, which would mask it immediately');

  // ── 4.4: the terms default is a real default, not an empty string ─────
  ok(/data_handling_terms: meta\.data_handling_terms \|\| 'contributor_retains'/.test(wizardCode),
    'wizard: a connection saved without explicit terms records contributor_retains');
  // …and the ABSENCE of the field on a pre-v3.0.5 connection must still be
  // distinguishable from a recorded choice, or the caution disappears.
  const affordance = bodyOf(sharedCode, 'inviteAffordance');
  ok(/cautionTerms: !conn\.data_handling_terms/.test(affordance),
    '…and a connection with NO recorded terms raises a caution, rather than being assumed');
  ok(/data_handling_terms: conn\.data_handling_terms \|\| 'contributor_retains'/.test(
      bodyOf(sharedCode, 'inviteRequestBody')),
    '…while the token it re-mints still defaults, so the ABSENCE and the CHOICE stay distinguishable');
  ok(/aff\.cautionTerms/.test(bodyOf(sharedCode, 'renderInvite')),
    '…and the caution is actually RENDERED, not merely computed');

  // ── 4.5: synthesis runs only after an inline confirm ──────────────────
  // EXECUTED. Synthesis costs real money on every page it rewrites, so the
  // gate is the point; the old assertion named a `confirmed: true` wire flag
  // that /next does not send and the route never required.
  const actionsClosed = renderActions(conn({ is_admin: true }), card(), false, false, null, false);
  ok(/data-sb-action="synthesize-open"/.test(actionsClosed),
    'renderActions: the synthesise control opens a confirm, it does not run');
  ok(!/data-sb-action="synthesize-confirm"/.test(actionsClosed),
    '…and the run control is not in the DOM until the confirm is open');
  const confirmHtml = renderSynthesizeConfirm(false);
  ok(/data-sb-action="synthesize-confirm"/.test(confirmHtml) &&
     /data-sb-action="synthesize-cancel"/.test(confirmHtml),
    '…the open confirm offers both run and cancel');
  ok(/cost|spend|charge|money|\$/i.test(confirmHtml),
    '…and says what it will cost, which is why the gate exists');
  // The dispatcher must be reachable ONLY through the confirm.
  const dispatch = bodyOf(sharedCode, 'onCardButton');
  ok(/'synthesize-confirm':[\s\S]{0,200}startAction/.test(dispatch),
    'the synthesise action is started from the CONFIRM case');
  ok(!/'synthesize-open':[\s\S]{0,120}startAction/.test(dispatch),
    '…and never from the case that merely opens it');

  // ── Read-only members are Pull-only at the CARD layer ─────────────────
  // Not one of the twenty-nine, but the named invariant the twenty-nine sat
  // inside — "read_only: true connections are Pull-only end-to-end (wizard →
  // card → push/synthesize 400s → pending_pages 0); keep all four layers in
  // sync". The wizard layer is H10 above; this is the card layer, executed.
  const roActions = renderActions(conn({ read_only: true, is_admin: true }), card(), false, true, null, false);
  ok(!/data-sb-action="push/.test(roActions),
    'renderActions: a read-only member is offered NO push');
  ok(!/data-sb-action="synthesize/.test(roActions),
    '…and no synthesise');
  ok(/data-sb-action="pull"/.test(roActions),
    '…but IS offered a pull, which is the whole point of the membership');
  ok(/data-sb-action="push/.test(actionsClosed),
    '(control) a contributing member IS offered a push — the check above is not vacuous');
}

// ═══════════════════════════════════════════════════════════════════════
section('4. The OFF STATE joins the button taxonomy and the kit');
// ═══════════════════════════════════════════════════════════════════════
//
// NOT a parity property — nothing deleted with the old shell guarded this.
// It is here because this file is the one that EXECUTES renderEnabled, and the
// two things being pinned are properties of its output.
{
  sharedBox.__setState({
    flagError: null, listError: null, enabling: false,
    connections: [], cards: {}, expandedSkips: new Set(), expandedAdmin: new Set(),
  });
  const off = renderEnabled();

  // ── ONE PRIMARY ────────────────────────────────────────────────────────
  // shell.css's taxonomy: at most one `btn-primary` per card, row or panel,
  // and it is "the one action that completes the step". Both CTAs open the
  // same wizard at different steps, so both are routes and only the
  // recommended one is primary — the shape the Sync view's decision panels
  // already use. Counted, not spot-checked: a third CTA added as a primary
  // would pass any single-button assertion.
  const primaries = (off.match(/\bbtn-primary\b/g) || []).length;
  ok(primaries === 1,
    `shared off state: EXACTLY ONE btn-primary across both CTA cards (found ${primaries})`);
  ok(/id="btn-sb-join"[^>]*>|class="btn btn-primary" id="btn-sb-join"/.test(off) &&
     /btn btn-primary" id="btn-sb-join"/.test(off),
    '…and it is JOIN — the branch whose precondition (an invite token) the reader either holds or does not');
  ok(/btn btn-secondary" id="btn-sb-create"/.test(off),
    '…while "set one up" is secondary, not a second invitation competing with it');

  // ── THE DESCRIPTION IS THE SYSTEM'S ────────────────────────────────────
  // `.sb-cta-desc` was --text-sm (12px) where every other description role in
  // the app is 13px; a 16px title over a 12px line is the 4px step that made
  // these cards read as oversized. The class is asserted on the OUTPUT, so a
  // hand-rolled <p class="tx-desc"> would pass — which is fine: the class is
  // the contract, and the CSS assertion below proves nothing redefines it here.
  const descs = (off.match(/class="tx-desc"/g) || []).length;
  ok(descs === 2, `shared off state: both CTA descriptions carry tx-desc (found ${descs})`);
  ok(!/sb-cta-desc/.test(off), '…and the private 12px class is emitted nowhere');

  // (control) the fixture really produced the off state, not an error branch.
  ok(/btn-sb-join/.test(off) && /btn-sb-create/.test(off) && off.length > 300,
    '(control) renderEnabled with zero connections really rendered the two CTA cards');
}
{
  // ── THE CHROME, in the stylesheet ──────────────────────────────────────
  // A source scan, and it says so. Comment-stripped: this file's own CSS now
  // explains WHY `.sb-cta-desc` was deleted, and a raw scan would read that
  // sentence as the rule it asserts is gone — the shape v3.19.0 recorded.
  const sbCss = R('src/public/next/views/shared.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = (sel) => {
    const at = sbCss.indexOf(sel + ' {');
    if (at === -1) return null;
    const close = sbCss.indexOf('}', at);
    return close === -1 ? null : sbCss.slice(at, close);
  };
  ok(!/\.sb-cta-desc\s*[{,]/.test(sbCss),
    'shared.css declares NO .sb-cta-desc — the role belongs to shared/text.js, not to this view');
  for (const sel of ['.sb-cta-card', '.sb-enable-card', '.sb-card']) {
    const b = body(sel) || '';
    ok(/border:\s*1px solid var\(--hairline\)/.test(b),
      `${sel} takes the kit's --hairline edge, not --border (the material edge belongs to chrome that floats)`);
    ok(/box-shadow:\s*var\(--elev-1\)/.test(b),
      `${sel} takes --elev-1 — a content card in this app is a RAISED surface`);
    ok(/border-radius:\s*var\(--radius-lg\)/.test(b),
      `${sel} takes var(--radius-lg), not a px literal that drifts from the token`);
  }
  // The CTA row is a grid now, so two cards sit side by side instead of a
  // 640px column with ~870px of dead space between title and button.
  const row = body('.sb-cta-row') || '';
  ok(/display:\s*grid/.test(row) && /repeat\(auto-fit/.test(row) && !/max-width/.test(row),
    '.sb-cta-row is an uncapped auto-fit grid — two-up where the column allows, one-up where it does not');
  ok(body('.sb-cta-card') !== null && body('.thisSelectorIsInvented') === null,
    '(control) the rule reader finds a real rule and returns null for an invented one');
}

// ═══════════════════════════════════════════════════════════════════════
section('5. The HOST SEAM and the LENS (v3.64.0)');
// ═══════════════════════════════════════════════════════════════════════
//
// v3.64.0 takes Shared Brain off the rail and gives the panel a SECOND host:
// the domain page's SHARED BRAIN section. Three properties are new and all
// three are guarded here:
//
//   D-E  the seam is ADDITIVE — three fixed exports, no function moved or
//        renamed, and section mode renders no sidebar;
//   D-G  the enable toggle does NOT move. It stays renderDisabled()'s, and
//        the section renders ONE LINE AND A DOOR, never a second off-state.
//        views/domains.js joins views/settings.js in the "hosts no enable
//        control" census;
//   D-H  the LENS — which connections belong to one domain page. A
//        connection is not one-to-one with a domain in either direction, so
//        this is a real function with real cases, not a filter inline in a
//        renderer.
//
// The lens and the section renderers are EXECUTED. The seam's lifecycle is
// EXECUTED too, with its five collaborators injected as recorders — which is
// what lets "the teardown closes the wizard" be a measurement rather than a
// grep for the identifier.

// ── The lens + the section renderers, in one sandbox ────────────────────
// renderCard and gatedLoader are STUBBED to markers: renderCard reaches
// renderTokenCheck, renderActions, renderCohort and renderAdmin, and lifting
// that whole tree would make this a test of the card rather than of the
// lens. Everything the section itself decides is REAL.
const SEC_FNS = [
  'inSection', 'sectionDomain', 'mirrorDomainFor', 'sharedLensFor',
  'renderSection', 'renderSectionDoor', 'renderMirrorStrip', 'formatRelativeTime',
  // v3.65.3 — the section body's own parts, all REAL.
  'renderSectionEmpty', 'sectionDomainFacts', 'sectionDotHtml', 'sectionAgeLine', 'sectionRepoCell',
  // v3.72.1
  'ageTickAttrs',
];
const secBox = new Function('renderMonitor', 'freshnessTier', 'identitySlotClass', 'formatAge',
  'let state = {};\n' +
  'let loadGate = null;\n' +
  'let busyDomains = new Set();\n' +
  'let hostCtx = { mode: "section", el: {}, domain: "", describeDomain: (s) => ({ slot: ({ research: 7, notes: 4, "shared-cohort": 10 })[s], pages: s === "shared-cohort" ? 42 : null }) };\n' +
  extractFunction(appJs, 'escapeHtml', 'app.js') + '\n' +
  ICON_STUB +
  'function gatedLoader() { return "<div class=\\"STUB-loader\\"></div>"; }\n' +
  'function renderCard(c) { return "<div class=\\"STUB-card\\" data-conn-id=\\"" + escapeHtml(c.id) + "\\"></div>"; }\n' +
  // The contributing block is driven on its own below (§S-C); here it is a
  // marker, so the D-G census stays about the SECTION's decisions.
  'function renderSectionConnection(c, last) { return "<div class=\\"STUB-card\\" data-conn-id=\\"" + escapeHtml(c.id) + "\\"></div>" + (last ? renderSectionDoor("ghost") : ""); }\n' +
  'function ensureCard(id) { state.cards = state.cards || {}; return state.cards[id] || (state.cards[id] = { acting: null, message: null, error: false }); }\n' +
  'function isDomainWriteBusy(d) { return busyDomains.has(d); }\n' +
  'function getDomainWriteLabel() { return "pull"; }\n' +
  SEC_FNS.map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
  `return { ${SEC_FNS.join(', ')}, __setState: (s) => { state = s; }, __setDomain: (d) => { hostCtx.domain = d; },
     __setBusy: (list) => { busyDomains = new Set(list); }, __setDescribe: (fn) => { hostCtx.describeDomain = fn; } };`
)(renderMonitor, freshnessTier, identitySlotClass, formatAge);

{
  // ── D-H: the lens, EXECUTED over every shape the wire can send ────────
  const lens = secBox.sharedLensFor;
  const cA = conn({ id: 'a', shared_brain_slug: 'cohort', local_domains: ['research', 'notes'] });
  const cB = conn({ id: 'b', shared_brain_slug: 'lab', local_domains: ['lab-notes'] });

  const contributing = lens([cA, cB], 'research');
  ok(contributing.kind === 'contributing' && contributing.contributing.length === 1 &&
     contributing.contributing[0] === cA && contributing.mirrors.length === 0,
    'lens: a domain in a connection\'s local_domains is CONTRIBUTING, and only that connection comes back');
  const byNotes = lens([cA, cB], 'notes').contributing;
  ok(byNotes.length === 1 && byNotes[0].id === 'a',
    '…and a connection spanning several contributing domains answers for EACH of them');

  const mirror = lens([cA, cB], 'shared-cohort');
  ok(mirror.kind === 'mirror' && mirror.mirrors.length === 1 && mirror.mirrors[0] === cA &&
     mirror.contributing.length === 0,
    'lens: the derived shared-<slug> domain is the MIRROR of the connection that produced it');
  const labMirror = lens([cA, cB], 'shared-lab').mirrors;
  ok(labMirror.length === 1 && labMirror[0].id === 'b',
    '…derived per connection, never from a stored field');

  ok(lens([cA, cB], 'somewhere-else').kind === 'none',
    'lens: a domain in neither list is NONE — the section has an empty state of its own');

  // One domain, several connections — the direction P6 says is also not 1:1.
  const two = lens([cA, conn({ id: 'c', shared_brain_slug: 'x', local_domains: ['research'] })], 'research');
  ok(two.contributing.length === 2,
    'lens: one domain contributing to SEVERAL connections returns all of them');

  // Disjointness. Nothing in the store forbids a connection listing its own
  // mirror as a contributing domain; the buckets must still not double-count,
  // or `kind` stops being deterministic.
  const both = lens([conn({ id: 'd', shared_brain_slug: 'k', local_domains: ['shared-k'] })], 'shared-k');
  ok(both.contributing.length === 1 && both.mirrors.length === 0 && both.kind === 'contributing',
    'lens: a connection that both contributes to and mirrors one domain is counted ONCE, as contributing');

  // Totality — the lens runs on every paint of a page whose data may not
  // have arrived, so every degenerate input must answer rather than throw.
  for (const [conns, slug, why] of [
    [null, 'research', 'a null connection list'],
    [undefined, 'research', 'an absent connection list'],
    [[cA], null, 'a null slug'],
    [[cA], '', 'an empty slug'],
    [[null, 3, 'x'], 'research', 'junk entries in the list'],
    [[{ id: 'z' }], 'research', 'a connection with neither field'],
  ]) {
    let out = null, threw = false;
    try { out = lens(conns, slug); } catch { threw = true; }
    ok(!threw && out && out.kind === 'none' && out.contributing.length === 0 && out.mirrors.length === 0,
      `lens: ${why} answers NONE rather than throwing`);
  }
  // Anti-vacuity: the "none" answers above must not be how it answers
  // everything.
  ok(lens([cA], 'research').kind === 'contributing',
    '(control) …and a real pair still answers contributing, so "none" is a verdict and not a constant');
}

{
  // ── D-G: ONE DOOR, ZERO ENABLE CONTROLS, in every section state ───────
  const cA = conn({ id: 'a', shared_brain_slug: 'cohort', local_domains: ['research'],
    last_synthesis_at: null, last_pull_at: null });
  const base = { loading: false, enabled: true, flagError: null, listError: null, connections: [cA], cards: {} };
  const setup = (over, domain) => {
    secBox.__setState(Object.assign({}, base, over || {}));
    secBox.__setDomain(domain === undefined ? 'research' : domain);
    return secBox.renderSection();
  };

  const STATES = {
    loading:      () => setup({ loading: true }),
    flagError:    () => setup({ flagError: 'boom' }),
    off:          () => setup({ enabled: false }),
    listError:    () => setup({ listError: 'nope' }),
    none:         () => setup({}, 'unrelated'),
    mirror:       () => setup({}, 'shared-cohort'),
    contributing: () => setup({}),
  };
  const rendered = {};
  for (const [name, fn] of Object.entries(STATES)) rendered[name] = fn();

  // THE CENSUS, state by state. `btn-sb-enable` is the id; `enable-flag` is
  // the route. Both are asserted because a second off-state could be built
  // out of either half alone.
  for (const [name, html] of Object.entries(rendered)) {
    ok(!/btn-sb-enable/.test(html) && !/enable-flag/.test(html),
      `section ${name}: renders NO enable control — the toggle is install-level and stays on the view's own off state`);
  }
  for (const [name, html] of Object.entries(rendered)) {
    const doors = (html.match(/id="btn-sb-open-view"/g) || []).length;
    ok(doors === 1, `section ${name}: renders EXACTLY ONE door back to the full view (found ${doors})`);
  }

  // The off state specifically — D-G's sentence, and nothing more.
  ok(/Shared Brain is off on this install\./.test(rendered.off),
    'section off state: says the flag is off ON THIS INSTALL, which is the level the fact lives at');
  ok(!/STUB-card/.test(rendered.off) && !/sb-sec-mirror/.test(rendered.off),
    '…and renders no connection material it could not have loaded');
  // CONTROL, and it is the whole point of the pair: the toggle still exists,
  // in exactly one renderer, and this suite reads it there.
  ok(/btn-sb-enable/.test(sharedBox.renderDisabled()),
    '(control) renderDisabled() — the VIEW\'s own off state — still carries the one enable control');

  // Contributing vs mirror vs none.
  ok(/STUB-card/.test(rendered.contributing) && (rendered.contributing.match(/STUB-card/g) || []).length === 1,
    'section contributing: renders this domain\'s connection card, with its push/pull/synthesize controls');
  ok(!/sb-sec-mirror/.test(rendered.contributing),
    '…and no mirror strip, because this domain is not the mirror');

  ok(/sb-sec-mirror/.test(rendered.mirror) && !/STUB-card/.test(rendered.mirror),
    'section mirror: a shared-* mirror domain gets the read-only strip and NOT the operating card');
  ok(/Cohort/.test(rendered.mirror),
    '…naming the connection that produced it');
  ok(/class="cur-mon-key">synthesis<\/span><span class="cur-mon-value">never</.test(rendered.mirror),
    '…and its last synthesis, as a MONITOR line reading "never" (no fresh-dot on a time that never happened)');
  // v3.65.3 — the maintainer's decision: PULL LIVES WHERE IT WRITES. A
  // read-only member has no contributing domain, so this is the only domain
  // page their one operation can appear on. The SAME data-sb-action inside
  // the SAME .sb-card[data-conn-id] root: one mechanism, two hosts.
  ok(/data-sb-action="pull"/.test(rendered.mirror) && /class="sb-card sb-sec-conn sb-sec-mirror" data-conn-id="a"/.test(rendered.mirror),
    '…and it carries Pull, inside the .sb-card[data-conn-id] root every listener finds a connection by');
  ok(!/data-sb-action="push|data-sb-action="synthesize/.test(rendered.mirror),
    '…but NO push and NO synthesize — those act on the contributing side');

  ok(!/STUB-card/.test(rendered.none) && !/sb-sec-mirror/.test(rendered.none) &&
     /isn’t part of a Shared Brain/.test(rendered.none),
    'section none: a domain in neither list says so, rather than rendering an install-wide list');

  // Anti-vacuity: seven states, seven different strings. Without this every
  // assertion above could be about one constant with a door in it.
  const distinct = new Set(Object.values(rendered));
  ok(distinct.size === Object.keys(rendered).length,
    `(control) all ${Object.keys(rendered).length} section states render differently (got ${distinct.size})`);
  // …and the loading state really went through the gate rather than falling
  // to a branch that happens to look empty.
  ok(/STUB-loader/.test(rendered.loading),
    '(control) the loading state renders the delay-gated loader, not an empty box');
  ok(/boom/.test(rendered.flagError) && /nope/.test(rendered.listError),
    '(control) both error states render the message they were given');
  ok(/btn-sb-retry-list/.test(rendered.listError),
    '…and the list error keeps its retry, so a transient failure is not a dead end in the section either');
}

{
  // ── D-G: the census widens to views/domains.js ────────────────────────
  // views/settings.js is held to "mentions Shared Brain nowhere" (§1 P4).
  // views/domains.js cannot be: from v3.64.0 it HOSTS the section, and it
  // already names Shared Brain mirrors in six places. The property that
  // transfers is the narrow one — it hosts no ENABLE CONTROL — and that is
  // what is asserted, on the two halves such a control would need.
  const domainsSrc = R('src/public/next/views/domains.js');
  const domainsCodeLocal = assertStrippedSane(stripComments(domainsSrc), 'domains.js',
    ['function renderMain(', 'Shared Brain']);
  ok(!/btn-sb-enable/.test(domainsCodeLocal),
    'domains.js hosts NO enable control: the button id appears nowhere in it');
  ok(!/enable-flag/.test(domainsCodeLocal),
    '…and it posts to the feature-flag endpoint nowhere either');
  // The detector fires — without this the two assertions above are satisfied
  // by any string that does not happen to contain those words.
  const planted = stripComments(domainsSrc + '\nconst x = \'<button id="btn-sb-enable">\';\n');
  ok(/btn-sb-enable/.test(planted),
    '(control) the census detects a planted enable control in that same file');
  // And the section it WILL host is the one built here, not a second copy.
  ok(/mirrorDomainFor/.test(sharedCode) && !/mirrorDomainFor/.test(domainsCodeLocal),
    'the lens lives in views/shared.js; domains.js does not re-derive a mirror domain of its own');
}

{
  // ── D-E: the three fixed exports, with the signatures the host imports ─
  // The host package (D) was written against these before this file landed,
  // so the names and parameter lists are a CONTRACT, not an implementation
  // detail. A source guard, and it says so: the module cannot be imported
  // in Node (it reaches app.js, which reaches the DOM at module scope).
  for (const [sig, why] of [
    ['export function mountSharedSection(el, opts)', 'the host mounts the panel into an element it owns'],
    ['export function unmountSharedSection()', 'and takes it down on its own teardown'],
    ['export function sharedSectionBusy()', 'and asks before it re-renders (D-J)'],
    ['export function sharedLensFor(connections, domainSlug)', 'the lens is exported, so the page can ask what this domain has'],
  ]) {
    ok(sharedCode.includes(sig), `shared.js exports \`${sig}\` — ${why}`);
  }
  // Section mode renders NO sidebar: the domain page owns it.
  const renderBody = bodyOf(sharedCode, 'render');
  ok(/if \(!inSection\(\)\) renderSidebar\(token\)/.test(renderBody),
    'shared.js: render() skips the sidebar in section mode — the domain page owns that column');
  ok(/preserveMainScroll\(\(\) => \{/.test(renderBody),
    '(control) …and still goes through the one reading-position chokepoint in both modes');
  // The view's own main write and the section's go through ONE function.
  ok(!/\n\s*setMain\(/.test(bodyOf(sharedCode, 'renderMain')),
    'shared.js: renderMain writes through hostSetMain, not setMain — one chokepoint, two hosts');
  ok(/setMain\(html, token\)/.test(bodyOf(sharedCode, 'hostSetMain')),
    '…and in VIEW mode hostSetMain delegates to the shell\'s setMain unchanged');
}

{
  // ── D-E: the seam's LIFECYCLE, executed with recording collaborators ───
  // Five things the teardown must do live in stopShared(); the one that is
  // load-bearing is closeSharedBrainWizardIfOpen(), which is what stops a
  // PAT-holding overlay outliving its mount. Grepping for the identifier
  // would prove it is typed; running the teardown proves it is reached.
  const SEAM_FNS = [
    'inSection', 'hostSetMain', 'sectionDomain', 'mirrorDomainFor', 'sharedLensFor',
    'lensSummary', 'notifyHost', 'sharedSectionBusy',
    'mountSharedSection', 'unmountSharedSection', 'startShared', 'stopShared',
  ];
  function seamHarness() {
    const log = [];
    const gates = [];
    const box = new Function(
      'freshState', 'createLoadingGate', 'onWriteGateChange', 'isCurrentMount',
      'reportAsyncMountFailure', 'closeSharedBrainWizardIfOpen', 'isSharedBrainWizardOpen',
      'setMain', 'render', 'loadAll', 'log', 'subscribeAgeTicker',
      'let state = freshState();\n' +
      'let loadGate = null;\n' +
      'let unsubscribeWriteGate = null;\n' +
      'let unsubscribeAgeTicker = null;\n' +
      'let myMountToken = 0;\n' +
      extractConst(shared, 'SHELL_HOST', 'shared.js') + '\n' +
      'let hostCtx = SHELL_HOST;\n' +
      'let viewMounted = false;\n' +
      'let lastReportedBusy = false;\n' +
      'let lastReportedLens = \'\';\n' +
      SEAM_FNS.map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
      `return { ${SEAM_FNS.join(', ')}, __state: () => state, __host: () => hostCtx, __gate: () => loadGate };`
    )(
      () => ({ loading: true, enabled: false, connections: [], cards: {} }),
      () => { const g = { begun: false, cancelled: false, begin() { this.begun = true; }, cancel() { this.cancelled = true; log.push('gate.cancel'); } }; gates.push(g); log.push('gate.create'); return g; },
      () => { log.push('subscribe'); return () => log.push('unsubscribe'); },
      () => true,
      () => {},
      () => log.push('wizard.close'),
      () => false,
      (html) => log.push('setMain:' + String(html).length),
      () => log.push('render'),
      async () => { log.push('loadAll'); },
      log,
      () => { log.push('ticker.subscribe'); return () => log.push('ticker.unsubscribe'); }
    );
    return { box, log, gates };
  }

  /** The same harness with isSharedBrainWizardOpen pinned, and nothing else
   *  busy — so a true reading can only have come from the wizard. */
  function seamHarnessWithWizard(open) {
    const box = new Function(
      'freshState', 'isSharedBrainWizardOpen',
      'let state = freshState();\n' +
      'let hostCtx = { mode: "section", el: {}, domain: "d", onBusyChange: null, onLensChange: null };\n' +
      ['inSection', 'sharedSectionBusy'].map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
      'return { sharedSectionBusy };'
    )(
      () => ({ cards: { c1: { acting: null, shownAdminToken: null, inviteOpen: false, revokeOpen: false } } }),
      () => open
    );
    return box;
  }

  {
    const { box, log, gates } = seamHarness();
    const el = { innerHTML: 'previous' };
    box.mountSharedSection(el, { domain: 'research', token: 7 });
    ok(box.__host().mode === 'section' && box.__host().el === el && box.__host().domain === 'research',
      'mountSharedSection: the panel adopts the host element and the domain it was handed');
    ok(log.includes('gate.create') && log.includes('render') && log.includes('loadAll') && log.includes('subscribe'),
      '…and runs the SAME entry sequence the full-page view runs — gate, first paint, load, write-gate subscription');
    ok(gates[0].begun, '…with the delay-gated loader armed');

    // A second mount on the SAME element is a domain switch, not a remount:
    // it must not tear down an attached stream or a shown-once token.
    const before = log.length;
    box.mountSharedSection(el, { domain: 'notes', token: 7 });
    const during = log.slice(before);
    ok(box.__host().domain === 'notes',
      'mountSharedSection on the SAME element re-points the lens at the new domain');
    ok(during.includes('render') && !during.includes('gate.cancel') && !during.includes('wizard.close'),
      '…and re-renders WITHOUT tearing down — which is what lets a running push survive a domain switch');

    // v3.65.3: a different element under the SAME mount token is a
    // RE-POINT, not a remount — a cold domain switch hands the panel a new
    // host after a loading-branch paint, and a remount there wiped a
    // shown-once admin token (found in the browser).
    const elSame = { innerHTML: '' };
    const beforeS = log.length;
    const stateBefore = box.__state();
    box.mountSharedSection(elSame, { domain: 'lab', token: 7 });
    const duringS = log.slice(beforeS);
    ok(box.__host().el === elSame && box.__host().domain === 'lab',
      'mountSharedSection on a NEW element with the SAME mount token re-points onto it');
    ok(duringS.includes('render') && !duringS.includes('gate.cancel') && !duringS.includes('wizard.close')
      && !duringS.includes('gate.create') && box.__state() === stateBefore,
      '…WITHOUT a teardown or a fresh state — so a shown-once token survives a cold domain switch');

    // A different element under a NEW token IS a remount.
    const el2 = { innerHTML: '' };
    const before2 = log.length;
    box.mountSharedSection(el2, { domain: 'lab', token: 8 });
    const during2 = log.slice(before2);
    ok(during2.includes('gate.cancel') && during2.includes('unsubscribe') && during2.includes('wizard.close'),
      'mountSharedSection under a NEW mount token tears the old mount down first, wizard included');
    ok(during2.includes('gate.create') && box.__host().el === el2,
      '…and starts a fresh one on the new element');

    // Teardown.
    const before3 = log.length;
    box.unmountSharedSection();
    const during3 = log.slice(before3);
    ok(during3.includes('gate.cancel'), 'unmountSharedSection: the delay timer is cancelled — an armed timer would paint into the next view');
    ok(during3.includes('unsubscribe'), '…the cross-view write-gate subscription is released');
    ok(during3.includes('wizard.close'), '…and closeSharedBrainWizardIfOpen() is REACHED, so no PAT-holding overlay outlives the mount');
    ok(el2.innerHTML === '', '…and the host\'s element is emptied rather than left holding a dead panel');
    ok(box.__host().mode === 'view', '…and the panel is back on the shell host');
    // Idempotent: a second teardown must not run the sequence again.
    const before4 = log.length;
    box.unmountSharedSection();
    ok(log.length === before4, '…and a second unmount does nothing at all');
  }

  {
    // ── D-J: sharedSectionBusy() answers about what a host re-render would
    // DESTROY, not about what is merely happening.
    const { box } = seamHarness();
    const el = { innerHTML: '' };
    ok(box.sharedSectionBusy() === false, 'sharedSectionBusy: false before anything is mounted');
    box.mountSharedSection(el, { domain: 'research', token: 7 });
    ok(box.sharedSectionBusy() === false, '…and false on a freshly mounted, idle section');
    const cases = [
      ['acting', { acting: 'push' }, 'an SSE action is attached'],
      ['shownAdminToken', { shownAdminToken: 'sbat_x' }, 'a shown-once admin token is on screen'],
      ['invite', { inviteOpen: true, inviteToken: 'abc' }, 'an invite token is displayed'],
      ['revoke typed', { revokeOpen: true, revokeTyped: 'REVOKE-ab12' }, 'a revoke confirmation is typed'],
      ['revoke token', { revokeOpen: true, revokeTokenPresent: true }, 'a revoke admin token is in the DOM input'],
    ];
    for (const [name, card, why] of cases) {
      box.__state().cards = { c1: Object.assign({ acting: null }, card) };
      ok(box.sharedSectionBusy() === true, `sharedSectionBusy: TRUE while ${why} (${name})`);
    }
    box.__state().cards = { c1: { acting: null } };
    ok(box.sharedSectionBusy() === false,
      '(control) …and false again once none of those hold — so it is a reading, not a latch');

    // ── AN OPEN WIZARD IS BUSY, AND THE PROOF IS IN TWO HALVES ──────────
    // The overlay holds a GitHub PAT and, in admin mode, an admin token, in
    // DOM inputs the wizard deliberately never mirrors into state — and this
    // section's own teardown closes it. A host that re-rendered while it was
    // open would destroy a half-typed credential. The harness above injects
    // isSharedBrainWizardOpen as a stub, so that half proves only that
    // sharedSectionBusy CONSULTS it; the other half executes the wizard's
    // real reporter against its real `root`. Neither alone is the property.
    const wizardBusyBox = seamHarnessWithWizard(true);
    ok(wizardBusyBox.sharedSectionBusy() === true,
      'sharedSectionBusy: TRUE while the setup wizard is open, with no card busy at all');
    ok(seamHarnessWithWizard(false).sharedSectionBusy() === false,
      '(control) …and false with the same idle cards when it is closed');

    box.unmountSharedSection();
    box.__state().cards = { c1: { acting: 'push' } };
    ok(box.sharedSectionBusy() === false,
      'sharedSectionBusy: false once unmounted, even mid-operation — the flag is about the HOSTED panel');
  }

  {
    // ── The wizard's own reporter, EXECUTED against its real `root`.
    // This is the half the seam harness cannot reach: above, the stub says
    // what sharedSectionBusy does with the answer; here, the real function
    // says where the answer comes from.
    const wizBusy = new Function(
      'let root = null;\n' +
      extractFunction(wizard, 'isSharedBrainWizardOpen', 'shared-brain-wizard.js') + '\n' +
      'return { isSharedBrainWizardOpen, setRoot: (r) => { root = r; } };'
    )();
    ok(wizBusy.isSharedBrainWizardOpen() === false,
      'wizard: isSharedBrainWizardOpen() is false with no overlay mounted');
    wizBusy.setRoot({ nodeType: 1 });
    ok(wizBusy.isSharedBrainWizardOpen() === true,
      '…and TRUE once its detached subtree exists — it reads `root`, the same thing closeSharedBrainWizardIfOpen reads');
    wizBusy.setRoot(null);
    ok(wizBusy.isSharedBrainWizardOpen() === false,
      '…and false again after a close, so it is DOM presence and not a latch');
    // It must report presence and nothing else: a boolean, never a credential.
    ok(typeof wizBusy.isSharedBrainWizardOpen() === 'boolean',
      '…answering with a boolean, never with anything the overlay holds');
  }

  {
    // ── The busy callback fires on CHANGE, not on every frame. This view
    // re-renders on every SSE frame; a host that repainted on each one
    // would be the re-render storm D-J exists to prevent.
    const { box } = seamHarness();
    const seen = [];
    box.mountSharedSection({ innerHTML: '' }, { domain: 'research', token: 7, onBusyChange: (b) => seen.push(b) });
    box.notifyHost(); box.notifyHost();
    box.__state().cards = { c1: { acting: 'pull' } };
    box.notifyHost(); box.notifyHost(); box.notifyHost();
    box.__state().cards = { c1: { acting: null } };
    box.notifyHost();
    ok(JSON.stringify(seen) === JSON.stringify([true, false]),
      `onBusyChange fires once per real change, not once per render (got ${JSON.stringify(seen)})`);
  }

  {
    // ── hostSetMain: the two hosts, and the token guard on both.
    const { box, log } = seamHarness();
    const el = { innerHTML: '' };
    box.mountSharedSection(el, { domain: 'research', token: 7 });
    box.hostSetMain('<p>x</p>', 7);
    ok(el.innerHTML === '<p>x</p>', 'hostSetMain in section mode writes the host element');
    ok(!log.some((l) => l.startsWith('setMain:')), '…and never calls the shell\'s setMain while section-mounted');
    box.unmountSharedSection();
    ok(el.innerHTML === '', '(control) the teardown really emptied it');
  }
  {
    const { box, log } = seamHarness();
    // Same harness, but isCurrentMount is the one collaborator we re-point.
    const staleBox = new Function(
      'freshState', 'createLoadingGate', 'onWriteGateChange', 'isCurrentMount',
      'reportAsyncMountFailure', 'closeSharedBrainWizardIfOpen', 'isSharedBrainWizardOpen',
      'setMain', 'render', 'loadAll', 'log',
      'let state = freshState();\nlet loadGate = null;\nlet unsubscribeWriteGate = null;\nlet myMountToken = 0;\n' +
      extractConst(shared, 'SHELL_HOST', 'shared.js') + '\n' +
      'let hostCtx = { mode: "section", el: arguments[11], domain: "research", onBusyChange: null, onLensChange: null };\n' +
      'let viewMounted = false;\nlet lastReportedBusy = false;\nlet lastReportedLens = \'\';\n' +
      ['inSection', 'hostSetMain'].map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
      'return { hostSetMain };'
    );
    const el = { innerHTML: 'untouched' };
    const fn = staleBox(
      () => ({ cards: {} }), () => ({ begin() {}, cancel() {} }), () => () => {},
      () => false,           // the mount is NO LONGER current
      () => {}, () => {}, () => false, () => log.push('setMain'), () => {}, async () => {}, log, el
    );
    fn.hostSetMain('<p>late</p>', 7);
    ok(el.innerHTML === 'untouched',
      'hostSetMain refuses to write when the host\'s mount token is no longer current — a late SSE frame paints nothing');
    ok(box.__host().mode === 'view', '(control) the other harness is untouched by this one');
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('S. v3.65.3 — ④ always open: the section body, states A–E, the reading');
// ═══════════════════════════════════════════════════════════════════════
// This suite's ok() takes the CONDITION first; eq() is (actual, expected,
// label), and prints what it got — written once here, used below.
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)})`);
{
  // The contributing block, EXECUTED with the real kit parts and the REAL
  // decisions it leans on (adminAffordances, tokenCheckApplies, the two
  // confirms, the fold row). renderCohortBody / renderAdminBody are markers:
  // their contents are the full view's, pinned elsewhere.
  const C_FNS = [
    'inSection', 'sectionDomain', 'mirrorDomainFor', 'domainsForAction', 'formatRelativeTime',
    'sectionDomainFacts', 'sectionDotHtml', 'sectionAgeLine', 'sectionRepoCell', 'sectionFoldRow',
    'renderSectionDoor', 'renderSectionConnection', 'renderPushConfirm', 'renderSynthesizeConfirm',
    'tokenCheckApplies', 'adminAffordances',
    // v3.72.1
    'ageTickAttrs', 'sectionPushedLine', 'pendingReading',
  ];
  const cBox = new Function('renderMonitor', 'freshnessTier', 'identitySlotClass', 'explainerMark', 'formatAge',
    'let state = { cards: {}, expandedSecRows: new Set(), expandedAdmin: new Set() };\n' +
    'let busyDomains = new Set();\n' +
    'let hostCtx = { mode: "section", el: {}, domain: "research", describeDomain: (s) => ({ slot: ({ research: 7, notes: 4, "shared-cohort": 10 })[s], pages: null }) };\n' +
    extractFunction(appJs, 'escapeHtml', 'app.js') + '\n' + ICON_STUB +
    extractConst(shared, 'TOKEN_CHECK_READING', 'shared.js') + '\n' +
    extractConst(shared, 'TOKEN_EXPIRY_NOTE', 'shared.js') + '\n' +
    'function ensureCard(id) { return state.cards[id] || (state.cards[id] = { acting: null, message: null, error: false, tokenCheck: null, tokenChecking: false, pushConfirmOpen: false, synthesizeConfirmOpen: false, revokeOpen: false, shownAdminToken: null, adminTokenProvisioned: false }); }\n' +
    'function isDomainWriteBusy(d) { return busyDomains.has(d); }\n' +
    'function getDomainWriteLabel() { return "pull"; }\n' +
    'function renderCohortBody() { return "<div class=\\"STUB-cohort\\"></div>"; }\n' +
    'function renderAdminBody() { return "<div class=\\"STUB-admin\\"></div>"; }\n' +
    C_FNS.map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
    `return { ${C_FNS.join(', ')}, __card: (id) => ensureCard(id), __state: () => state,
       __setBusy: (l) => { busyDomains = new Set(l); } };`
  )(renderMonitor, freshnessTier, identitySlotClass, explainerMark, formatAge);

  const recent = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const c = conn({ id: 'c1', label: 'Research_Group 2026', shared_brain_slug: 'cohort', local_domains: ['research'],
    storage_type: 'github', github_repo_owner: 'acme', github_repo_name: 'cohort-brain',
    pending_pages: 50, permanent_skip: ['a.md', 'b.md', 'c.md'], last_pull_at: recent, last_push_at: null,
    has_admin_token: true, fellow_id: 'c77a791a-0000-4000-8000-000000000000' });
  const html = cBox.renderSectionConnection(c, true);

  ok(/^<div class="sb-card sb-sec-conn" data-conn-id="c1">/.test(html),
    'C: the root keeps .sb-card[data-conn-id] — wireListeners, revealInCard and the revoke gate find it');
  ok(!/sb-card-stats|sb-card-footer|sb-card-pending"/.test(html),
    'C: NO card inside the card — none of the full card\'s stat grid, pending box or footer');
  eq((html.match(/class="cur-mon"/g) || []).length, 1, 'C: ONE monitor carries every live reading');
  // v3.72.1 (F12): the words sit in a `data-age-at` span so the app's ONE
  // age clock (shared/age-ticker.js) keeps them live without a re-render.
  ok(/cur-mon-key">pulled<\/span><span class="cur-mon-value"><span class="fresh-dot fresh-[a-z]+" aria-hidden="true"><\/span><span class="sb-age" data-age-at="[^"]+" data-age-text>2 hr ago<\/span>/.test(html),
    'C: a time line carries the app\'s fresh-dot with the age in words, in a ticking span');
  ok(/cur-mon-key">pushed<\/span><span class="cur-mon-value">never</.test(html),
    'C: a time that never happened reads "never" with NO dot');
  ok(/cur-mon-key">mirror<\/span><span class="cur-mon-value"><span class="cur-sb-dot cur-sb-dot-10" aria-hidden="true"><\/span>shared-cohort/.test(html),
    'C: the mirror domain is named WITH its identity dot, keyed on its RECORDED slot, not its position (rule 5, v3.76.0)');
  ok(/cur-mon-key">contributes<\/span><span class="cur-mon-value"><span class="cur-sb-dot cur-sb-dot-7"/.test(html),
    '…and so is the contributing domain');
  // LOUD: the cost and the skips — always rendered, never behind a chevron.
  const loudPart = html.split('<div class="sb-sec-rows">')[0];
  ok(/cur-mon-loud[^"]*" role="status">50 pages ready to push — Push summarises each with your AI provider, which spends API credits/.test(loudPart),
    'C: the pending COST is a loud entry, above every fold row (v3.16.1)');
  ok(/role="status">3 pages skipped after repeated failures\. <strong>Retry them from Skipped pages below\.<\/strong>/.test(loudPart),
    'C: the skips are a loud entry too, pointing at the row that fixes them');
  // ONE action row: Push primary-ish (btn-ai, sparkles), Pull, Synthesis for an admin, the ghost door last.
  const actions = (/<div class="sb-sec-actions">([\s\S]*?)<\/div><div class="sb-sec-rows">/.exec(html) || [, ''])[1];
  ok(/^<button type="button" class="btn btn-ai" data-sb-action="push-open">/.test(actions), 'C: Push comes first, btn-ai with the sparkles (it spends)');
  ok(/data-sb-action="pull"/.test(actions) && /data-sb-action="synthesize-open"[^>]*>[^<]*<svg[^>]*><\/svg> Run synthesis</.test(actions),
    'C: then Pull, then "Run synthesis" — for an admin');
  ok(/id="btn-sb-open-view">Open Shared Brain<\/button>$/.test(actions) && /class="btn btn-ghost sb-sec-door-btn"/.test(actions),
    'C: and the door LAST, ghost, md (never xs)');
  eq((html.match(/btn-primary/g) || []).length, 0, 'C: no btn-primary competes with Push');
  // Fold rows, closed, in the design's order.
  const rows = [...html.matchAll(/<details class="sb-sec-row" data-sb-sec-row="c1:([a-z]+)"( open)?>[\s\S]*?class="sb-sec-row-label">([^<]+)<\/span><span class="sb-sec-row-meta">([^<]*)</g)]
    .map((m) => [m[1], !!m[2], m[3], m[4]]);
  eq(JSON.stringify(rows.map((r) => r[0])), JSON.stringify(['token', 'cohort', 'skips', 'admin', 'leave']),
    'C: fold rows — Access token, Cohort & sharing, Skipped pages, Admin controls, Leave');
  ok(rows.every((r) => !r[1]), 'C: every row ships CLOSED');
  // v3.71.1: the consequence left the ⓘ, so the CLOSED row's reading says it.
  eq(rows[0][3], 'not checked · expires without notice',
    'C: the token row reads "not checked · expires without notice" before any check — the consequence visible on the closed row');
  eq(rows[1][3], 'you keep copyright', 'C: the cohort row reads the data-handling terms');
  eq(rows[2][3], '3 pages', 'C: the skipped row counts');
  eq(rows[4][3], 'fellow c77a791a…', 'C: the leave row names the fellow id');
  ok(/data-sb-action="leave-confirm"/.test(html) && /Your local wiki files stay exactly as they are/.test(html),
    'C: Leave keeps its sentence, and opening the row IS the confirm step');
  // v3.71.1: the ⓘ IS the shared.token-check explainer (id unchanged); the
  // expiry CONSEQUENCE is printed visibly under it, never folded (v3.16.1).
  ok(html.includes(explainerMark('sb-sec-token-info-c1', 'shared.token-check').panel)
    && /id="sb-sec-token-info-c1" role="group" aria-label="Why check the token" hidden>/.test(html)
    && EXPLAINERS['shared.token-check'].label === 'Why check the token',
    'C: the token explanation lives in the row\'s ⓘ — the shared.token-check explainer — not inline (rule 3, D19)');
  ok(/<p class="sb-sec-line sb-token-expiry-note">When the token expires, Push and Pull stop working, and GitHub sends no warning\.<\/p>/.test(html)
    && !/sb-token-expiry-note/.test(explainerHtml('shared.token-check')),
    'C: …while what an expired token DOES is printed on the page, outside the fold');

  // A plain contributor: no synthesis, no admin row. The route has no admin
  // gate (D10) — this is who USUALLY runs it, and the full view keeps it.
  const plain = cBox.renderSectionConnection({ ...c, id: 'c2', has_admin_token: false, permanent_skip: [], pending_pages: 0 }, false);
  ok(!/synthesize-open/.test(plain), 'C: a contributor without the admin token sees no Run synthesis here');
  ok(!/data-sb-sec-row="c2:admin"/.test(plain), '…and no Admin controls row');
  ok(!/btn-sb-open-view/.test(plain), '…and a block that is not the LAST carries no door (one door per section)');
  ok(!/ready to push/.test(plain.split('cur-mon-lines')[0]) && !/cur-mon-loud/.test(plain),
    '…and with nothing pending and nothing skipped there is no loud entry at all');
  ok(/cur-mon-key">pending<\/span><span class="cur-mon-value">0 pages</.test(plain), '…while the pending LINE still reads 0');

  // A held row stays open across a render; a row opened by an ACTION too.
  cBox.__state().expandedSecRows.add('c1:cohort');
  ok(/data-sb-sec-row="c1:cohort" open>/.test(cBox.renderSectionConnection(c, true)),
    'C: a row the user opened stays open across the next render (this view re-renders on every SSE frame)');
  cBox.__card('c1').shownAdminToken = 'sbat_x';
  ok(/data-sb-sec-row="c1:admin" open>/.test(cBox.renderSectionConnection(c, true)),
    'C: a shown-once admin token forces its row open — it can never render hidden behind a chevron');
  cBox.__card('c1').shownAdminToken = null;

  // A dead token and a held write are LOUD, never folded.
  cBox.__card('c1').tokenCheck = { kind: 'rejected', message: 'GitHub rejected the stored token.' };
  cBox.__setBusy(['shared-cohort']);
  const hurt = cBox.renderSectionConnection(c, true).split('<div class="sb-sec-rows">')[0];
  ok(/cur-mon-loud cur-mon-danger" role="status">GitHub rejected the stored token\./.test(hurt) || /role="status">GitHub rejected the stored token\./.test(hurt),
    'C: a rejected token is a loud (danger) entry above the rows');
  ok(/Another write is already running for shared-cohort/.test(hurt), 'C: a held write is loud too');
  ok(/data-sb-action="pull" disabled/.test(hurt), '…and Pull is disabled while it holds the mirror');
  cBox.__setBusy([]);
  cBox.__card('c1').tokenCheck = null;
}
{
  // States A, B, E and D, through the REAL renderSection (secBox above).
  const cA = conn({ id: 'a', label: 'Cohort', shared_brain_slug: 'cohort', local_domains: ['research', 'notes'],
    storage_type: 'github', github_repo_owner: 'acme', github_repo_name: 'cohort-brain', shared_domain: 'mkt' });
  const at = (over, domain) => {
    secBox.__setState(Object.assign({ loading: false, enabled: true, flagError: null, listError: null, connections: [cA], cards: {} }, over || {}));
    secBox.__setDomain(domain);
    return secBox.renderSection();
  };
  const A = at({ enabled: false }, 'research');
  ok(/<div class="sb-sec-empty"><p class="sb-sec-line sb-sec-empty-text">Shared Brain is off on this install\. Turning it on connects you to nothing — it lets you join a cohort or set one up\.<\/p><button type="button" class="btn btn-secondary sb-sec-door-btn" id="btn-sb-open-view">/.test(A),
    'A: Quick-maintenance empty anatomy — the sentence left, the door right, secondary md');
  const B = at({}, 'lectures');
  ok(/This domain isn’t part of a Shared Brain\. Your 1 Shared Brain draws on <span class="sb-sec-dom"><span class="cur-sb-dot cur-sb-dot-7"[^>]*><\/span>research<\/span>, <span class="sb-sec-dom"><span class="cur-sb-dot cur-sb-dot-4"/.test(B),
    'B: names the domains this install\'s brains draw on, each with its identity dot');
  ok(/fixed when you join/.test(B) && !/Contribute this domain/.test(B),
    'B: says contributing domains are fixed at join — and offers no button the store cannot honour');
  // A domain the host cannot place gets NO dot — never a guessed colour
  // (found green-first by mutation: index -1 fell through to a real slot).
  eq(secBox.sectionDotHtml('nowhere'), '', 'a domain the host did not index carries no identity dot, never a guessed one');
  ok(/cur-sb-dot-7"/.test(secBox.sectionDotHtml('research')), '(control) …while one with a recorded slot does — slot 7, its own');
  const E = at({}, 'shared-gone');
  ok(/This is a Shared Brain mirror with no connection on this install, so Pull can’t refresh it\./.test(E) && !/isn’t part of/.test(E),
    'E: an orphaned shared-* mirror says so — never "not part of any Shared Brain" (D20)');
  const D = at({}, 'shared-cohort');
  ok(/cur-mon-key">pages<\/span><span class="cur-mon-value">42</.test(D), 'D: the mirror\'s monitor reads its local page count from the host');
  ok(/cur-mon-key">folder<\/span><span class="cur-mon-value">collective\/mkt\/wiki\//.test(D), 'D: …the repository folder');
  ok(/cur-mon-key">fed by<\/span><span class="cur-mon-value">research, notes/.test(D), 'D: …and what feeds it from this install');
  ok(/sb-sec-id-name"><span class="cur-sb-dot cur-sb-dot-10"/.test(D), 'D: the identity line carries THIS domain\'s own dot');
  secBox.__setBusy(['shared-cohort']);
  const Dbusy = at({}, 'shared-cohort');
  ok(/data-sb-action="pull" disabled/.test(Dbusy) && /role="status">Another write \(pull\) is already running for shared-cohort/.test(Dbusy),
    'D: a held write disables Pull and says why, loud');
  secBox.__setBusy([]);
}
{
  // The READING the host shows, and the silence while loading (D6).
  const L_FNS = ['inSection', 'sectionDomain', 'mirrorDomainFor', 'sharedLensFor', 'lensSummary', 'notifyHost', 'sharedSectionBusy'];
  const lBox = new Function('isSharedBrainWizardOpen',
    'let state = { loading: true, enabled: false, connections: [], cards: {} };\n' +
    'const seen = [];\n' +
    'let hostCtx = { mode: "section", el: {}, domain: "research", onBusyChange: null, onLensChange: (s) => seen.push(s) };\n' +
    'let lastReportedBusy = false; let lastReportedLens = "";\n' +
    L_FNS.map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
    `return { notifyHost, lensSummary, seen, __setState: (s) => { state = s; }, __setDomain: (d) => { hostCtx.domain = d; } };`
  )(() => false);
  lBox.notifyHost();
  eq(lBox.seen.length, 0, 'D6: while the panel is LOADING it reports no lens at all — never enabled:false as a reading');
  lBox.__setState({ loading: false, enabled: true, connections: [conn({ id: 'z', label: 'Cohort', local_domains: ['research'] })], cards: {} });
  lBox.notifyHost();
  eq(lBox.seen.length, 1, '…and once it has loaded it reports, once');
  eq(lBox.seen[0].label, 'Cohort', '…naming the brain, so the head can say WHICH');
  eq(lBox.seen[0].kind, 'contributing', '…as contributing');
  lBox.__setState({ loading: false, enabled: false, flagError: 'boom', connections: [], cards: {} });
  lBox.notifyHost();
  eq(lBox.seen[1] && lBox.seen[1].error, true, 'a flag that could not be read is reported as an ERROR, so the host never says "off"');
  lBox.__setState({ loading: false, enabled: true, connections: [], cards: {} });
  lBox.__setDomain('shared-gone');
  eq(lBox.lensSummary().orphan, true, 'an orphaned shared-* domain is reported as such (state E)');
}
{
  // The card's shown-once admin token: the leave guard, EXECUTED.
  const G_FNS = ['inSection', 'shownOnceTokenOnScreen', 'onSharedBeforeUnload', 'onSharedRailClick'];
  const asked = []; const navs = [];
  const gBox = new Function('confirmThen', 'navigate',
    'let state = { cards: {} }; let viewMounted = true; let hostCtx = { mode: "view" };\n' +
    extractConst(shared, 'SHOWN_TOKEN_LEAVE_QUESTION', 'shared.js') + '\n' +
    G_FNS.map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
    `return { ${G_FNS.join(', ')}, __setState: (s) => { state = s; }, __setMounted: (m) => { viewMounted = m; } };`
  )((o) => { asked.push(o); return Promise.resolve(); }, (v) => navs.push(v));
  const g = gBox;
  const ev = (railView) => ({ prevented: 0, stopped: 0, returnValue: undefined,
    target: { closest: (sel) => (railView && sel === '#rail [data-view]' ? { dataset: { view: railView } } : null) },
    preventDefault() { this.prevented++; }, stopImmediatePropagation() { this.stopped++; } });
  const e0 = ev('chat'); g.onSharedRailClick(e0);
  ok(asked.length === 0 && e0.stopped === 0, 'no token on screen: a rail click passes untouched, nobody is asked');
  g.__setState({ cards: { a: { shownAdminToken: 'sbat_x' } } });
  const e1 = ev('chat'); g.onSharedRailClick(e1);
  ok(asked.length === 1 && e1.stopped === 1 && e1.prevented === 1 && navs.length === 0,
    'a token on screen: a rail click is STOPPED and the app\'s own dialog asks (no native confirm)');
  ok(/can never be shown again/.test(asked[0].message) && asked[0].confirmLabel === 'Leave' && asked[0].cancelLabel === 'Stay',
    '…saying why, with Leave / Stay');
  asked[0].onConfirm();
  eq(navs.join(','), 'chat', '…and "Leave" performs the very navigation it stopped');
  const e3 = ev(null); g.onSharedRailClick(e3);
  ok(e3.stopped === 0 && asked.length === 1, 'a click that is not a rail destination is never asked about');
  const u1 = ev(null); g.onSharedBeforeUnload(u1);
  ok(u1.prevented === 1 && u1.returnValue === '', 'a reload with a token on screen asks the browser to confirm — with no text of its own');
  g.__setMounted(false);
  const u2 = ev(null); g.onSharedBeforeUnload(u2);
  ok(u2.prevented === 0, 'once the panel is not mounted, a stale token in memory prompts nothing');
  const e4 = ev('chat'); g.onSharedRailClick(e4);
  ok(e4.stopped === 0, '…and a rail click is not stopped either');
  ok(/window\.addEventListener\('beforeunload', onSharedBeforeUnload\)/.test(sharedCode)
    && /document\.addEventListener\('click', onSharedRailClick, true\)/.test(sharedCode),
    'both are installed — the click in the CAPTURE phase, so it runs before the rail\'s own navigate()');
}
{
  // The section's two anatomies are COPIED BY VALUE from views/domains.css
  // (a view stylesheet may not name another view's prefix). Pinned property
  // by property against the source, so neither can drift silently.
  const sCss = stripComments(R('src/public/next/views/shared.css'));
  const dCss = stripComments(R('src/public/next/views/domains.css'));
  const decls = (css, sel) => {
    const re = new RegExp('(^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    const out = {};
    for (const m of css.matchAll(re)) for (const d of m[2].split(';')) {
      const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    return out;
  };
  const pairs = [
    ['.sb-sec-empty', ['.dm-quick', ['padding', 'border-radius', 'border', 'background']]],
    ['.sb-sec-empty', ['.dm-quick-empty', ['display', 'align-items', 'justify-content', 'gap', 'flex-wrap']]],
    ['.sb-sec-row-summary', ['.dm-group-summary', ['display', 'align-items', 'gap', 'padding', 'list-style']]],
    ['.sb-sec-row-meta', ['.dm-group-meta', ['margin-left', 'min-width', 'font-size', 'color', 'text-align']]],
    ['.sb-sec-row-body', ['.dm-group-body', ['padding']]],
    ['.sb-sec-row', ['.dm-group', ['border-top']]],
  ];
  for (const [mine, [theirs, props]] of pairs) {
    const a = decls(sCss, mine), b = decls(dCss, theirs);
    for (const prop of props) {
      ok(a[prop] !== undefined && a[prop] === b[prop],
        `${mine} { ${prop} } equals ${theirs}'s (${a[prop]} vs ${b[prop]})`);
    }
  }
  ok(!/\.dm-/.test(sCss), 'views/shared.css names no .dm- selector — the anatomy is copied, not borrowed');
}
{
  // The full view's two false labels (D10, D11), fixed there too.
  ok(!/Run synthesis \(admin\)/.test(sharedCode), 'D10: "Run synthesis (admin)" is gone — the route has no admin gate');
  ok(/Usually the admin runs this\./.test(sharedCode), '…and the confirm says who usually runs it instead');
  ok(!/in the Domains tab/.test(sharedCode), 'D11: no "Domains tab" — there has been none since v3.64.0');
  ok(/router\.post\('\/:id\/synthesize', gate, async/.test(R('src/routes/sharedbrain.js')),
    '(control) the synthesize route is where D10 was checked');
}

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('All /next Shared Brain UI parity assertions passed.');
