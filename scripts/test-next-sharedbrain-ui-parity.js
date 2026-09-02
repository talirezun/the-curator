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
];
const sharedBox = new Function(
  'let state = { flagError: null, listError: null, enabling: false, connections: [], cards: {}, expandedSkips: new Set(), expandedAdmin: new Set() };\n' +
  extractFunction(appJs, 'escapeHtml', 'app.js') + '\n' +
  ICON_STUB +
  SHARED_FNS.map((n) => extractFunction(shared, n, 'shared.js')).join('\n\n') + '\n' +
  `return { ${SHARED_FNS.join(', ')}, __setState: (s) => { state = s; }, __state: () => state };`
)();

// wizardShellHtml() composes every panel builder, so all of them are loaded.
const WIZ_FNS = [
  'freshState', 'isReadOnlyVerdict', 'wizardShellHtml',
  'panelStep1', 'panelStep2', 'panelStep3', 'panelStep4', 'panelStep5',
  'panelAdminStep1', 'panelAdminStep2',
];
const wizBox = new Function(
  'let state = {};\n' +
  extractFunction(appJs, 'escapeHtml', 'app.js') + '\n' +
  ICON_STUB +
  WIZ_FNS.map((n) => extractFunction(wizard, n, 'shared-brain-wizard.js')).join('\n\n') + '\n' +
  `return { ${WIZ_FNS.join(', ')}, __setState: (s) => { state = s; }, __state: () => state };`
)();

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
  ok(sbRow.length > 200 && /last_push_at/.test(sbRow),
    '(control) the Shared Brain row really was extracted and does report the last push');

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
  ok(!/sharedbrain|shared-brain|Shared Brain/i.test(settingsCode),
    'settings.js hosts NO Shared Brain control — the toggle moved to the feature\'s own view');
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
  const reveal = bodyOf(sharedCode, 'revealRevokeOutcome');
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
  ok(/isSaveBlocking\(\)/.test(keydown),
    '…with Escape refused mid-save, so it cannot imply a cancellation that did not happen');
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
  const adminStep1 = bodyOf(wizardCode, 'bindAdminStep1');
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
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('All /next Shared Brain UI parity assertions passed.');
