// View: Settings — "configuration". Too much configuration for a modal,
// so this is a real view with its own sub-navigation in the sidebar.
//
// Five sections (design spec, screen 8): General, Providers & keys, MCP
// bridge, Health & scan limits, Knowledge base. Each is a landable
// destination (own sidebar row + its own main-column render), not a
// scroll-soup — only the active section's content is in the DOM.
//
// Backend used (all pre-existing — see src/routes/config.js, mcp.js,
// diagnostics.js, health.js):
//   GET/POST /api/config/api-keys (+/disconnect, +/active)
//   GET      /api/config                       (domains path)
//   GET/POST /api/config/default-domain         (MCP default write domain)
//   POST     /api/config/pick-folder            (native folder picker)
//   GET/POST /api/health/ai-settings            (scan cost ceilings)
//   GET      /api/mcp/config /claude-config
//   POST     /api/mcp/self-test /reveal-config
//   GET      /api/diagnostics/quick
//   POST     /api/diagnostics/live              (cost-gated — see below)
//   GET      /api/version
//
// Honesty notes (see the task brief this view was built against):
//   - Only two providers actually exist (DEFAULTS = {gemini, anthropic} in
//     src/brain/llm.js). OpenAI and a local model are rendered as clearly
//     NOT AVAILABLE in this build — muted, no masked-key field that could
//     look configured, no working Replace button — never implying they work.
//   - The live AI connectivity check costs a fraction of a cent
//     (see src/brain/diagnostics.js runLiveApiCheck — one ~16-token call).
//     It is never fired on click alone: clicking shows an inline cost
//     confirmation ("$0.0001 · one tiny API call") and only THAT second,
//     explicit click reaches the network. This mirrors the shipping app's
//     System Check gate, which is the product's trust mechanism — see
//     CLAUDE.md "The cost rule is a hard requirement."
//   - Updates. This was previously check-only: the banner told the user to
//     go and install it from "the shipping app's Settings tab" instead.
//     That was correct while /next was a PREVIEW shell sitting beside the
//     real app. Cutover made it false and user-hostile — /next IS the app
//     now, and the interface it pointed at is only reachable at /old, so
//     the honest reading of the old copy was "you cannot update from here".
//     The flow is now wired end to end against the SAME routes the shipping
//     frontend uses (GET /api/config/update-check + GET /api/version, then
//     POST /api/config/update -> POST /api/restart -> poll GET /api/health
//     -> reload), with the destructive step behind the shared confirm
//     dialog. Only the presentation is new; the contract is not.
//     The three shapes the shipping flow handles and this one must not
//     drop: `restartRequired` (files on disk are newer than the running
//     process — offer a restart, do not re-pull), `partial: true` (git
//     succeeded, npm install did not — surface `warning` and restart
//     anyway), and a plain failure. Plus one the shipping flow does NOT
//     handle and this one does: the route computes `updateAvailable` as
//     `latest !== current || commitsDiffer`, so a LOCAL version AHEAD of
//     the published one (a release committed but not yet pushed — the
//     maintainer's own state) reported "Update available: v3.9.0 -> v3.8.0"
//     and a button that would roll the checkout BACKWARDS. classifyUpdate()
//     below detects that and says so instead.
//
// The icon set this view needs lives in app.js's shared ICON_BODY — see
// icon() below — there is no view-local icon table. Two of this view's
// glyphs (lock, check, sparkles→star) are visually distinct from domains.js's
// versions of the "same" icon (different proportions/composition), so they
// were promoted under distinct names (lockAlt, checkAlt, star) rather than
// merged — see the merge-rule note on app.js's ICON_BODY.
//
// MEDIUM-3 fix (re-audit, second round): this view used to guard every
// async continuation with a hand-rolled `let mounted = false` boolean
// instead of the mount-token primitive chat.js/domains.js/sync.js use
// (isCurrentMount). A boolean can only say "is SOME mount of this view
// still current" — it can't distinguish "still mounted" from "REmounted"
// (leave Settings and come back is a fresh onEnter with a NEW token, but
// `mounted` just flips false-then-true-again, indistinguishable from never
// having left). Migrated to the same token discipline as the other three
// views. `state` here is REASSIGNED WHOLESALE on every onEnter
// (`state = freshState()`), same as sync.js — so every busy-flag reset
// below is GATED on isCurrentMount(token), never unconditional: a fresh
// mount already starts clean via freshState() regardless, and an ungated
// reset from a stale mount would instead reach through the `state` closure
// variable into whatever the CURRENT mount's state object is and wrongly
// clear ITS OWN genuinely-in-flight busy flag. (This is the opposite
// gating choice from domains.js's busyKey/H2 — that `state` object is a
// single persistent instance that never gets reassigned, so IT needs an
// unconditional reset or a busy flag can get stuck forever across mounts.
// Two different state-lifetime designs need two different gating rules;
// applying one file's rule to the other file is exactly the mistake this
// migration corrected mid-session — see sync.js's matching comment.)
//
// Cross-view write gate (this session's task): unlike sync.js's four
// actions, NONE of the mutations in this file are guarded by the backend's
// write-registry (`hasActiveWrites()` / `guardConcurrent()`, src/routes/
// sync.js + health.js) — grepping src/routes/config.js confirms the only
// route there wrapped in it is POST /api/config/update (git reset --hard +
// npm install against the live app, which this shell deliberately never
// wires — see the honesty note above), not any of api-keys / api-keys/
// disconnect / api-keys/active / default-domain / pick-folder / ai-settings.
// So gating here is NOT mirroring an existing backend refusal the way
// sync.js's gate does — it is the ONLY protection against two real
// correctness risks, both traced to actual per-call (never cached) reads
// elsewhere in the backend:
//   - "Choose folder" (Knowledge base) calls POST /api/config/pick-folder,
//     which calls setDomainsDir() IMMEDIATELY on selection (src/routes/
//     config.js). Per CLAUDE.md's paths.js invariant, every write resolves
//     getDomainsDir() FRESH, per call, specifically so it can never go
//     stale mid-process — which means changing it while an ingest/health/
//     sync write is between LLM calls or between page writes sends that
//     write's REMAINING work to a different folder than where it started,
//     silently scattering one source's pages across two knowledge bases.
//   - Provider key actions (Save/Disconnect/Set active — Providers & keys)
//     mutate .curator-config.json, and getProviderInfo() (src/brain/
//     llm.js) is called fresh on EVERY LLM call, not cached — confirmed by
//     reading it directly. Disconnecting the active provider's key, or
//     switching providers, between two calls of the SAME in-flight
//     multi-phase ingest can throw an auth error partway through, or
//     silently finish that ingest's remaining pages on a different model
//     than it started with.
// Both are gated on isAnyWriteBusy() (global, not one domain) for the same
// reason sync.js's gate is: neither action is domain-scoped, so a write on
// ANY domain is a real conflict. Not gated, and why: "Replace"/"Cancel"
// (open/close the key-input row — no network call), the default-domain
// <select> (only changes the MCP server's OWN fallback for FUTURE tool
// calls missing a domain — never touches an in-flight app-initiated
// write), AI Health scan-limit Save (changes future scan cost ceilings,
// not anything currently running), MCP self-test / view-config /
// copy-snippet (read-only, or a self-contained short-lived test process),
// "Verify AI connection" / "Run system check" (read-only), "Check for
// updates" (read-only — see the honesty note above), the theme toggle
// (pure client-side UI state), and "Copy" path (clipboard only).
//
// FAIL-OPEN, not fail-closed: crossWriteBusy() below is wrapped in
// try/catch so a problem reading gate state leaves every control ENABLED
// rather than permanently disabled — there is no backend 409 acting as a
// second safety net here (see above), but a live-but-unprotected control
// the user can still retry is a far smaller failure than a Settings
// section that's silently unusable forever with no way out but a reload.
//
// Owns views/settings.css.

import {
  registerView, setSidebar, setMain, eyebrow, escapeHtml, icon, isCurrentMount,
  reportAsyncMountFailure, reportAsyncActionFailure,
  isAnyWriteBusy, getDomainWriteLabel, onWriteGateChange,
} from '../app.js';
// Overlay, not a view — same relationship views/shared.js has with
// views/shared-brain-wizard.js. It is opened from the MCP section's CTA and
// closed unconditionally by this view's teardown, so navigating away can
// never leave it mounted behind the next view.
import { openMcpWizard, closeMcpWizardIfOpen } from './mcp-wizard.js';
// D-C / ARCHITECTURE.md R7: "a tour you can never get back is worse than
// none." This is the one control that re-opens the dismissed first-run
// guidance panel.
//
// NOTE THE ASYMMETRY WITH THE WIZARD IMPORT ABOVE, WHICH IS DELIBERATE:
// there is no closeOnboardingPanelIfOpen() and this view's teardown must
// NOT close the panel. The MCP wizard is a modal owned by this view, so an
// overlay surviving a view change would be a bug. The onboarding panel is
// a SHELL-level layer whose entire purpose is to point AT other views — it
// is opened from app.js's boot() and is required to survive navigate().
import { openOnboardingPanel } from './onboarding.js';
// The in-design replacement for window.confirm — see shared/confirm.js's
// header for why it takes the ACTION rather than returning a DECISION.
// Closed unconditionally by this view's teardown, exactly like the wizard.
import { confirmThen, closeConfirmIfOpen } from '../shared/confirm.js';
import { createLoadingGate, gatedLoader, settleGate } from '../shared/loading-gate.js';
// The ONE honest USD renderer for /next — imported, never copied. Prices in
// the model list are money the user will be billed; a local formatter here
// would be a second hand-maintained copy of that rule. See format-usd.js.
import { formatUsdHonest } from '../shared/format-usd.js';

const SETTINGS_SECTIONS = [
  ['general',   'General',              'Appearance, updates'],
  ['providers', 'Providers & keys',     'Gemini, Anthropic, OpenAI, local'],
  ['mcp',       'MCP bridge',           'My Curator, default write domain'],
  ['health',    'Health & scan limits', 'Cost ceilings, candidate pairs'],
  ['storage',   'Knowledge base',       'Vault folder, Obsidian'],
];

const SECTION_TITLES = Object.fromEntries(SETTINGS_SECTIONS.map(([id, label]) => [id, label]));

// ── Provider display metadata — only 2 of these actually run. The other
// two are rendered clearly inert (see honesty note above). ──────────────
const PROVIDER_ROWS = [
  { id: 'gemini',    name: 'Gemini',    dot: 'var(--type-entity)',  available: true  },
  { id: 'anthropic', name: 'Anthropic', dot: 'var(--type-summary)', available: true  },
  { id: 'openai',    name: 'OpenAI',    dot: 'var(--text-faint)',   available: false },
  { id: 'local',     name: 'Local model', dot: 'var(--text-faint)', available: false },
];

// ── Updates: the decision, as pure functions ─────────────────────────────
// DOM-free and fetch-free on purpose, so scripts/test-next-confirm-dialog.js
// can execute them directly rather than asserting on the shape of the
// source that renders them.

/**
 * Compare two dotted version strings. Returns >0 if a is newer than b, <0
 * if older, 0 if equal OR UNCOMPARABLE.
 *
 * "Uncomparable collapses to 0" is the fail-safe direction, and it is the
 * whole reason this is not a one-liner: the only caller uses a positive
 * result to SUPPRESS the update button. Guessing "local is newer" from a
 * string it could not actually parse would hide a real, wanted update
 * behind a reassuring message. Guessing 0 merely falls through to the
 * route's own updateAvailable verdict, which is the pre-existing
 * behaviour.
 *
 * Only the numeric core is compared. A pre-release suffix (the retired
 * `3.0.1-beta.27` line) makes the cores equal and therefore returns 0 —
 * deliberately, per the paragraph above.
 */
function compareSemver(a, b) {
  const parse = (v) => {
    if (typeof v !== 'string') return null;
    const core = v.trim().split('-')[0].split('+')[0];
    const parts = core.split('.');
    if (parts.length === 0 || parts.length > 4) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    return nums.some(Number.isNaN) ? null : nums;
  };
  const av = parse(a), bv = parse(b);
  if (!av || !bv) return 0;
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] || 0, y = bv[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Turn the two read-only endpoints' payloads into exactly one thing to say.
 *
 *   check       GET /api/config/update-check  | { error } | null
 *   versionInfo GET /api/version              | null (non-critical; the
 *               shipping flow also treats a failed version read as absent)
 *
 * Order is load-bearing:
 *   1. error            — the check itself failed; nothing else is known.
 *   2. restart-required — files on disk are already newer than the running
 *                         process. Pulling AGAIN is not the fix; restarting
 *                         is. Same precedence the shipping app uses.
 *   3. local-ahead      — see this file's header. The route reports
 *                         updateAvailable for ANY version difference, in
 *                         either direction.
 *   4. current / available.
 */
function classifyUpdate(check, versionInfo) {
  if (!check) return { kind: 'idle' };
  if (check.error) return { kind: 'error', message: String(check.error) };

  if (versionInfo && versionInfo.restartRequired) {
    return { kind: 'restart-required', running: versionInfo.version, onDisk: versionInfo.onDiskVersion };
  }

  const cmp = compareSemver(check.current, check.latest);
  if (cmp > 0) {
    return { kind: 'local-ahead', current: check.current, latest: check.latest };
  }
  if (!check.updateAvailable) {
    return { kind: 'current', current: check.current };
  }
  return {
    kind: 'available',
    current: check.current,
    latest: check.latest,
    localCommit: check.localCommit || null,
    remoteCommit: check.remoteCommit || null,
    // false when the versions match and only the commits differ — the label
    // has to read "v3.9.0 (abc → def)", not "v3.9.0 → v3.9.0".
    versionsDiffer: cmp < 0,
  };
}

// ── Model lifecycle: the decision, as pure functions ─────────────────────
// DOM-free and fetch-free for the same reason classifyUpdate() above is —
// scripts/test-next-model-fallback.js executes these directly rather than
// asserting on the shape of the markup that renders them.
//
// WHY THIS EXISTS AT ALL. `GET /api/config/api-keys` returns
// `fallback: getFallbackStatus()` (src/routes/config.js) and
// `activeModel: getProviderInfo()?.model`. Until this was written, /next
// read NEITHER — `grep -rn "\.fallback\b" src/public/next/` returned zero
// hits — which is this project's named dead-data shape: a backend field
// computed, returned, and read by nobody.
//
// It is not cosmetic. The v2.4.0 model-lifecycle safety net exists because
// providers RETIRE models: when the pinned default 404s, llm.js walks
// FALLBACK_CHAINS onto the next live model and keeps working. That is a
// silent change to what the user is BILLED. v3.0.15 added the cost
// comparison precisely because every Gemini rung costs more than the
// default (2.5x input / 3.75x output on the first rung), and v3.6.0 found
// four of five Anthropic rungs dead — silently landing users on Sonnet at
// 3x Haiku's price, the exact inverse of the chain's documented promise to
// reach the cheapest still-working model. Without a surface, the user is
// billed more and sees nothing, anywhere.

function providerLabel(id) {
  if (id === 'gemini') return 'Gemini';
  if (id === 'anthropic') return 'Anthropic';
  return (typeof id === 'string' && id) ? id : null;
}

/**
 * Turn `fallback` (null | the getFallbackStatus() payload) into exactly one
 * thing to say.
 *
 * Contract, read off src/brain/llm.js getFallbackStatus():
 *   null                       — the pinned default is working. Say nothing.
 *   { provider, requestedModel, usingModel, at,
 *     costTier: 'costlier'|'similar'|'unknown',
 *     costlier: boolean }      — a fallback is in use.
 *
 * costTier is derived by compareModelCost(), which looks BOTH ids up in
 * MODEL_PRICES_USD_PER_MTOK and returns 'unknown' if either is missing.
 * Three states, three different things to say:
 *   costlier — confirmed more expensive. A money warning, plainly, because
 *              a silent 2.5x-3.75x jump on every ingest is the whole
 *              reason this banner exists.
 *   unknown  — we have no price for one of the ids. NEVER imply parity.
 *              v3.0.15 deleted a family-name heuristic for exactly this:
 *              it rated a 3.75x output jump as "same tier" because the
 *              family word ("flash-lite") is stable across generations
 *              while the price is not. Point at the provider's pricing
 *              page instead of saying nothing.
 *   similar  — confirmed same-or-cheaper. No cost line; the banner alone.
 *
 * DELIBERATE DEVIATION from the shipping banner's tier resolution. The
 * shipping code reads `fallback.costTier || (fallback.costlier ? 'costlier'
 * : 'similar')`. getFallbackStatus() always sets costTier today, so that
 * fallback arm only fires on a legacy/absent payload — and on one, mapping
 * `costlier: false` to 'similar' asserts a parity we do not know, because
 * the legacy boolean collapses 'similar' AND 'unknown' into false (llm.js
 * says so in its own comment). Anything that is not one of the three known
 * strings resolves to 'unknown' here: it is the only arm that is honest
 * about not knowing, and the fail-safe direction on a money question is to
 * warn, never to reassure.
 */
function classifyFallback(fallback) {
  if (!fallback || typeof fallback !== 'object') return { show: false };

  let costTier = fallback.costTier;
  if (costTier !== 'costlier' && costTier !== 'similar' && costTier !== 'unknown') {
    costTier = fallback.costlier === true ? 'costlier' : 'unknown';
  }

  let costNote = null;
  let costLevel = 'none';
  if (costTier === 'costlier') {
    costLevel = 'danger';
    costNote = 'This model costs more than your usual one — every ingest, compile and chat is ' +
      'billed at the higher rate until the default is restored.';
  } else if (costTier === 'unknown') {
    costLevel = 'attention';
    costNote = 'Pricing for this model is not known here and may differ from your usual one — ' +
      "check your provider's pricing page before a large ingest.";
  }

  return {
    show: true,
    provider: fallback.provider || null,
    // A provider id we do not recognise still gets a banner — the fallback
    // itself is the fact that matters — with a neutral noun rather than a
    // wrong label.
    providerLabel: providerLabel(fallback.provider) || 'Your provider',
    requestedModel: String(fallback.requestedModel || 'unknown'),
    usingModel: String(fallback.usingModel || 'unknown'),
    costTier,
    costLevel,
    costNote,
    // POST-CUTOVER ADVICE, and it is deliberately not the shipping app's
    // wording. The shipping banner says "Open Check for Updates ABOVE",
    // which is true there because its Updates control sits directly above
    // the provider badge in one long Settings tab. In /next, Settings is
    // sectioned: Updates lives in General, and Providers & keys is a
    // different landable destination — "above" would point at nothing. The
    // SUBSTANCE is still correct, and more so than before cutover: /next
    // now installs the update end to end against the same routes rather
    // than telling the user to go and do it in the shipping app.
    action: 'Check for updates in General — or the Updates button in the sidebar — to pull a ' +
      'Curator release whose default model is live again.',
  };
}

/**
 * The active-provider / resolved-model readout. `activeModel` is the model
 * getProviderInfo() resolved for THIS process; when a fallback is in play
 * it is the model actually being billed, which is why it is worth showing
 * on its own: it is an independent tell that something changed underneath
 * the user, and it had zero readers in /next before this.
 *
 * Distinct from the per-row `models[provider]` already rendered, which is
 * the CONFIGURED default for that provider (DEFAULTS in llm.js) and does
 * not move when a fallback fires.
 */
function activeModelLine(keys) {
  if (!keys || typeof keys !== 'object') return { show: false };
  const label = providerLabel(keys.activeProvider);
  if (!label) return { show: false };
  return {
    show: true,
    provider: keys.activeProvider,
    providerLabel: label,
    // No key configured -> getProviderInfo() throws -> the route sends
    // null. Say so rather than rendering an empty gap.
    model: (typeof keys.activeModel === 'string' && keys.activeModel) ? keys.activeModel : 'unknown',
  };
}

// ── Module state ─────────────────────────────────────────────────────────
// One object, reset on every onEnter so a second visit never leaks stale
// in-flight state (e.g. a confirm panel left open) from a prior visit.
function freshState() {
  return {
    section: 'providers', // matches the design prototype's default state

    // General
    version: null,          // { version, onDiskVersion, restartRequired }
    updateCheck: null,      // { current, latest, localCommit, remoteCommit, updateAvailable } | { error }
    updateChecking: false,
    // The apply half of the Updates flow. `updatePhase` is one of
    // 'idle' | 'applying' | 'restarting' | 'done' | 'failed'; it is
    // SEPARATE from updateChecking so a re-check can never silently wipe an
    // in-flight install's progress off the screen.
    updatePhase: 'idle',
    updateResult: null,     // POST /api/config/update body ({ from, to, partial?, warning? })
    updateError: null,      // string — apply/restart failure, rendered inline
    updateRestartHint: false, // the poll gave up; tell the user how to finish by hand
    quick: null,            // { checks, summary } | { error }
    quickLoading: false,
    liveConfirmOpen: false,
    live: null,             // result of /api/diagnostics/live | null
    liveLoading: false,

    // Providers & keys
    // Which provider model lists are expanded. Kept in state because
    // render() replaces the section wholesale — a native <details open>
    // attribute would be discarded on the next repaint, and this section
    // repaints on things the user did not do (the cross-view write gate
    // fires whenever an ingest starts or finishes anywhere). A list that
    // snapped shut mid-read, for no visible reason, would look like a bug.
    // Reset per mount along with the rest of this object, so leaving and
    // returning collapses it — the same rule every other transient control
    // in this view follows.
    modelPickerOpen: {},
    // The model-pick request currently in flight, as '<provider>::<modelId>'
    // ('<provider>::' when clearing back to the app default), or null.
    //
    // DELIBERATELY NOT an optimistic copy of the new selection. The rendered
    // selection is read from state.keys — i.e. from the server's own
    // `selectedModels`, refetched after the POST resolves — so a refused
    // request cannot leave the UI claiming a model is in force that the
    // engine has never been told about. A model choice is a SPENDING
    // decision: showing it as applied when the write failed is this repo's
    // named dead-data shape on the one screen where it costs money.
    modelPickBusy: null,
    // A model-pick refusal, keyed by provider: { <provider>: '<message>' }.
    // Rendered INSIDE that provider's expanded list, immediately above the
    // rows — the surface the user was looking at when they clicked, and one
    // that is guaranteed to be on screen because the list has to be open for
    // the control to be reachable at all. v3.6.0 shipped a refusal that
    // rendered somewhere the user could not see, and the observed result was
    // that they read the reset button as "my click didn't register" and
    // retried a refused write.
    modelPickError: {},
    keys: null,             // GET /api/config/api-keys response
    keysError: null,        // the section FAILED TO LOAD — renderProviders shows this INSTEAD of the list (state.keys is also null in this case, so there's nothing to show anyway)
    keysActionError: null,  // a save/disconnect/set-active ACTION failed — rendered INLINE, list stays visible (found live while verifying MEDIUM-1: reusing keysError here hid the entire provider list — including the Cancel button — behind a bare error message the instant a save failed)
    replacing: null,        // provider id currently showing an input row
    // MEDIUM-2 fix (this session): this field used to be declared and never
    // read or written — the input row rendered with no `value=` attribute
    // and nothing wrote keystrokes back into state, so it worked by
    // accident ONLY as long as nothing else ever re-rendered Settings while
    // a row was open. Subscribing this view to onWriteGateChange (below)
    // broke that: any write starting/finishing anywhere in the app now
    // re-renders Settings, and a bare re-render rebuilds the input from
    // this (previously always-empty) field — silently wiping a typed-but-
    // unsaved key. Reproduced live: paste a key mid-batch-ingest, watch it
    // vanish the instant the batch's gate event fires, cursor still in the
    // field. Fixed by making the field genuinely state-backed — see the
    // `input` listener + live `.value` restore in wireProviderListeners()
    // below, and the `focusReplaceInput`-adjacent restore on every render —
    // mirroring the pattern views/sync.js already uses for its own PAT
    // field (state.setupForm.token, never a `value=` HTML attribute).
    // Holds the value for WHICHEVER provider `state.replacing` currently
    // names — only one replace row can be open at a time, so one flat
    // field (not one per provider) is enough; it is reset to '' every time
    // a replace row opens (for a fresh provider or a re-open of the same
    // one) and every time it closes (Cancel, or a successful Save), so a
    // typed-but-unsaved secret never lingers in state longer than the
    // interaction that produced it, and never leaks a stale value across
    // providers if the user replaces one key then another. Never persisted
    // beyond this in-memory field — no localStorage/sessionStorage/URL.
    replaceValue: '',
    keysBusy: null,         // provider id currently mid-request (disables its row)

    // MCP bridge
    mcp: null,              // GET /api/mcp/config
    mcpError: null,
    selfTest: null,
    selfTestLoading: false,
    configSnippet: null,    // GET /api/mcp/claude-config (raw object)
    configSnippetOpen: false,
    copyFeedback: null,
    defaultDomainInfo: null, // { defaultDomain, domains }
    defaultDomainSaving: false,

    // Health & scan limits
    aiHealth: null,          // { costCeilingTokens, semanticDupeMaxPairs }
    aiHealthError: null,     // section FAILED TO LOAD — renderHealthLimits shows this INSTEAD of the form
    aiHealthSaving: false,
    aiHealthSaved: false,
    scanLimitsValidationError: null, // client-side "fix your input" error — rendered INSIDE the (still-visible) form; deliberately a separate field from aiHealthError, which replaces the whole form
    costCeilingInput: '',
    maxPairsInput: '',

    // Knowledge base
    config: null,            // { domainsPath, domainsPathSource }
    configError: null,
    pickingFolder: false,
    pathCopyFeedback: null,
  };
}

let state = freshState();

// Same discipline as chat.js/domains.js/sync.js — see the file-header
// comment above. Read fresh inside a handler invoked SYNCHRONOUSLY by a
// real click (safe: nothing can re-mount between the click firing and
// that line running); captured as a local BEFORE any await in every async
// function, and threaded through rather than re-derived afterward.
let myMountToken = 0;

// Delay-gated loading indicator for this view's section loads. Built in
// onEnter, cancelled in the teardown. See shared/loading-gate.js.
//
// SCOPE, stated rather than implied: this gate enforces the DELAY half
// only. The four section loaders below each commit their state AND call
// render() themselves (they are also called directly by the save flows,
// which must repaint immediately), so a result landing between 200 ms and
// 600 ms would paint through the min-visible clamp rather than waiting it
// out. That is a real gap and it is left open deliberately: all four
// section loads were measured at ~2.9 ms — two orders of magnitude under
// the 200 ms threshold — so the loader never appears here at all, and
// restructuring four loaders plus six call sites to close a window that
// does not occur is risk without benefit. Named in the NOT ENFORCED block
// of scripts/test-next-loading-gate.js so it cannot be mistaken for
// coverage.
let loadGate = null;

// Unsubscribe function for this mount's write-gate subscription (see
// onWriteGateChange in app.js) — released in teardown. Same discipline as
// views/ingest.js and views/sync.js: a torn-down mount must stop reacting
// to gate changes.
let unsubscribeWriteGate = null;

registerView('settings', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    render(mountToken);
    loadVersion(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));       // cheap, always shown in the sidebar footer
    ensureSectionData('providers', mountToken).catch((err) => reportAsyncMountFailure(mountToken, err)); // default section — prefetch immediately

    // Re-render whenever ANY domain's write-gate state changes — e.g. an
    // ingest starts/finishes on some domain while the user is sitting on
    // Settings. This view only READS the gate to decide its own
    // button/notice state; it never begins a write itself.
    unsubscribeWriteGate = onWriteGateChange(() => {
      if (isCurrentMount(mountToken)) render(mountToken);
    });

    return () => {
      // MEDIUM-2 fix: don't let a typed-but-unsaved provider key sit in
      // state after the user leaves this view — same reasoning as sync.js's
      // L2 fix for its own PAT field's teardown. `onEnter` above already
      // reassigns `state = freshState()` on the NEXT mount regardless, so
      // this isn't required for correctness on re-entry — it's the
      // unconditional backstop that ends the secret's lifetime the moment
      // the interaction that produced it ends, rather than leaving it
      // sitting in memory for however long the user is on another view.
      state.replaceValue = '';
      if (unsubscribeWriteGate) { unsubscribeWriteGate(); unsubscribeWriteGate = null; }
      // Never leave the MCP wizard's overlay mounted behind the next view —
      // the same unconditional rule views/shared.js applies to the Shared
      // Brain wizard. Safe to call when it isn't open.
      // Same unconditional rule for the shared confirm dialog — it mounts
      // on document.body, so without this an "Install this update?" left
      // open would sit over whatever view came next. Closing takes the
      // CANCEL path, so a teardown can never fire the destructive action.
      //
      // Ordered BEFORE the wizard close deliberately, and it must stay
      // that way: scripts/test-next-mcp-wizard.js pins closeMcpWizardIfOpen()
      // as the LAST statement of this teardown. The two are independent —
      // neither can be open while the other is — so there is no behavioural
      // reason to prefer either order, and keeping that existing guard
      // intact is worth more than the alphabetical tidiness of appending.
      // Timer hygiene (load-bearing): an armed delay timer that survives
      // this teardown would paint a loader into whatever view comes next.
      if (loadGate) { loadGate.cancel(); loadGate = null; }
      closeConfirmIfOpen();
      closeMcpWizardIfOpen();
    };
  },
});

// ── Cross-view write gate (see this file's header comment) ────────────────

// FAIL-OPEN: if isAnyWriteBusy() itself throws, every gated control in this
// view stays enabled rather than becoming permanently stuck disabled.
function crossWriteBusy() {
  try {
    return isAnyWriteBusy();
  } catch (err) {
    console.error('[settings] isAnyWriteBusy() failed — failing OPEN (controls stay enabled)', err);
    return false;
  }
}

// Best-effort "what's busy" for a disabled control's tooltip. Unlike
// sync.js (which always has GET /api/domains loaded), this view only has a
// domain list once the MCP section has been visited (state.defaultDomainInfo
// .domains, from GET /api/config/default-domain) — falls back to a generic
// message when that hasn't happened yet. Either way crossWriteBusy() above
// is what actually gates the control; this only affects tooltip specificity.
function activeWriteInfo() {
  try {
    const domains = (state.defaultDomainInfo && state.defaultDomainInfo.domains) || [];
    for (const d of domains) {
      const label = getDomainWriteLabel(d);
      if (label) return { domain: d, label };
    }
  } catch (err) {
    console.error('[settings] getDomainWriteLabel() failed while building a tooltip', err);
  }
  return null;
}

// `consequence` names what's specifically at risk for THIS control (folder
// vs. provider/key) — see the file-header comment for why each is real.
function crossWriteTitle(consequence) {
  const info = activeWriteInfo();
  const who = info
    ? 'A write (' + info.label + ') is running for domain "' + info.domain + '"'
    : 'A write is running in another view';
  return who + ' — ' + consequence;
}

function renderCrossWriteBanner(consequence) {
  return crossWriteBusy()
    ? '<div class="settings-write-busy-note">' + icon('alertTriangle', 13) +
      '<span>' + escapeHtml(crossWriteTitle(consequence)) + '</span></div>'
    : '';
}

// ── Data loading (fetch-on-first-visit-to-section, cached in state) ─────

async function ensureSectionData(section, token) {
  let load = null;
  if (section === 'providers' && state.keys === null) load = loadKeys;
  else if (section === 'mcp' && state.mcp === null) load = loadMcp;
  else if (section === 'health' && state.aiHealth === null) load = loadAiHealth;
  else if (section === 'storage' && state.config === null) load = loadConfig;
  if (!load) return;

  // The ONE chokepoint every section's entry load passes through, which is
  // why the gate lives here rather than being repeated in four loaders.
  // Capture the gate for THIS call. `loadGate` is module-scoped and the
  // next mount replaces it, so settling the module variable from a stale
  // in-flight load would decrement the NEXT mount's counter and hide a
  // loader that is legitimately up. A cancelled gate ignores settle(), so
  // the stale path becomes a no-op instead.
  const gate = loadGate;
  if (gate) gate.begin();
  try {
    await load(token);
  } finally {
    settleGate(gate, () => { if (isCurrentMount(token)) render(token); });
  }
}

async function loadVersion(token) {
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.version = data;
    render(token);
  } catch { /* footer just shows nothing — not worth surfacing as an error */ }
}

async function loadKeys(token) {
  try {
    const res = await fetch('/api/config/api-keys');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.keys = data;
    state.keysError = null;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.keysError = err.message || 'Could not load provider status.';
  }
  if (isCurrentMount(token)) render(token);
}

async function loadMcp(token) {
  try {
    const [cfgRes, ddRes] = await Promise.all([
      fetch('/api/mcp/config'),
      fetch('/api/config/default-domain'),
    ]);
    const cfg = await cfgRes.json();
    const dd = await ddRes.json();
    if (!isCurrentMount(token)) return;
    state.mcp = cfg;
    state.defaultDomainInfo = dd;
    state.mcpError = null;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.mcpError = err.message || 'Could not load MCP status.';
  }
  if (isCurrentMount(token)) render(token);
}

async function loadAiHealth(token) {
  try {
    const res = await fetch('/api/health/ai-settings');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.aiHealth = data;
    state.costCeilingInput = String(data.costCeilingTokens);
    state.maxPairsInput = String(data.semanticDupeMaxPairs);
    state.aiHealthError = null;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.aiHealthError = err.message || 'Could not load scan limits.';
  }
  if (isCurrentMount(token)) render(token);
}

async function loadConfig(token) {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.config = data;
    state.configError = null;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.configError = err.message || 'Could not load the knowledge base path.';
  }
  if (isCurrentMount(token)) render(token);
}

// ── Theme (General → Appearance) ─────────────────────────────────────────
//
// app.js owns theme state (localStorage 'curator-next-theme' + the
// data-theme attribute) and exposes no setter — only a rail button wired
// to its own internal toggleTheme(). Rather than duplicate that
// persistence logic here (which would desync app.js's in-memory
// state.theme from the DOM the next time the rail button is clicked),
// this view reads the CURRENT theme straight off the attribute (which
// app.js always keeps in sync — see its applyTheme() comment) and, when
// the user picks the theme that ISN'T current, simulates a click on the
// rail's own toggle button so the one real implementation runs. This is
// a pragmatic bridge, not a shared API — a `setTheme()` export on app.js
// would be the cleaner fix; flagged in this session's report.
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function requestTheme(target) {
  if (currentTheme() === target) return;
  const btn = document.getElementById('rail-theme-toggle');
  if (btn) {
    btn.click();
  } else {
    // Defensive fallback — should not happen; the rail always renders.
    document.documentElement.setAttribute('data-theme', target);
    try { localStorage.setItem('curator-next-theme', target); } catch { /* ignore */ }
  }
  render(myMountToken);
}

// ── Render ───────────────────────────────────────────────────────────────

function render(token) {
  renderSidebar(token);
  renderMain(token);
  wireGlobalListeners();
}

function renderSidebar(token) {
  const rows = SETTINGS_SECTIONS.map(([id, label, hint]) => (
    '<button type="button" class="settings-nav-row' + (state.section === id ? ' active' : '') + '" data-section="' + id + '">' +
      '<span class="row-label">' + escapeHtml(label) + '</span>' +
      '<span class="row-hint">' + escapeHtml(hint) + '</span>' +
    '</button>'
  )).join('');

  const versionLabel = state.version
    ? 'The Curator v' + escapeHtml(state.version.version) +
      (state.version.restartRequired ? ' <span class="settings-restart-flag" title="Files were updated but the running app hasn\'t restarted yet">restart</span>' : '')
    : 'The Curator';

  setSidebar(
    '<div class="settings-sidebar-shell">' +
      '<div class="sidebar-title">Settings</div>' +
      '<div class="settings-nav-list">' + rows + '</div>' +
      '<div class="settings-sidebar-footer">' +
        '<span class="mono settings-version">' + versionLabel + '</span>' +
        '<button type="button" class="btn btn-secondary btn-xs" id="settings-updates-btn">Updates</button>' +
      '</div>' +
    '</div>',
    token
  );
}

function renderMain(token) {
  const title = SECTION_TITLES[state.section] || 'Settings';
  let body;
  if (state.section === 'general') body = renderGeneral();
  else if (state.section === 'providers') body = renderProviders();
  else if (state.section === 'mcp') body = renderMcp();
  else if (state.section === 'health') body = renderHealthLimits();
  else body = renderStorage();

  setMain(
    eyebrow('configuration') +
    '<h1 class="view-title">' + escapeHtml(title) + '</h1>' +
    body,
    token
  );
}

// ── General ──────────────────────────────────────────────────────────────

function renderGeneral() {
  const dark = currentTheme() === 'dark';
  // Re-checking mid-install would race the very process being replaced.
  const updatesBusy = state.updateChecking || state.updatePhase === 'applying' || state.updatePhase === 'restarting';
  const quick = state.quick;
  const summary = quick && !quick.error
    ? quick.summary
    : null;

  return (
    '<div class="settings-section" id="section-general">' +
      // Appearance
      '<div class="settings-field-block">' +
        '<span class="settings-field-label">Appearance</span>' +
        '<div class="theme-segmented" role="group" aria-label="Theme">' +
          '<button type="button" class="theme-seg-btn' + (dark ? ' active' : '') + '" data-theme-choice="dark">Dark</button>' +
          '<button type="button" class="theme-seg-btn' + (!dark ? ' active' : '') + '" data-theme-choice="light">Light</button>' +
        '</div>' +
      '</div>' +

      // System check
      '<div class="settings-field-block">' +
        '<span class="settings-field-label">System check</span>' +
        '<p class="settings-hint-text">Confirms the app itself is set up — key, folder, credential permissions, sync. ' +
        'Free and instant, and it never reads your wiki content. To clean up wiki content, use a domain’s health panel instead.</p>' +
        '<div class="settings-btn-row">' +
          '<button type="button" class="btn btn-secondary" id="btn-run-quick-check"' + (state.quickLoading ? ' disabled' : '') + '>' +
            (state.quickLoading ? 'Scanning…' : 'Run system check') +
          '</button>' +
          '<button type="button" class="btn btn-ai-cost" id="btn-verify-ai">' +
            icon('star', 13) + ' Verify AI connection · $0.0001' +
          '</button>' +
        '</div>' +

        (state.liveConfirmOpen ? renderLiveConfirm() : '') +
        (state.live ? renderLiveResult() : '') +

        (summary ? renderQuickSummary(quick) : '') +
        (quick && quick.error ? '<div class="settings-inline-error">' + escapeHtml(quick.error) + '</div>' : '') +
      '</div>' +

      // Software update. The sidebar footer's "Updates" button lands here
      // (it switches to this section and runs the check) — a 272px footer
      // has no room for a version comparison, a partial-install warning
      // and a restart progress line, and the flow needs a surface that
      // stays put while the server is restarting under it.
      '<div class="settings-field-block" id="block-updates">' +
        '<span class="settings-field-label">Software update</span>' +
        '<p class="settings-hint-text">Compares this copy with the published version. Installing replaces The Curator’s own ' +
        'program files and restarts it — your knowledge base, API keys and sync settings are never touched.</p>' +
        '<div class="settings-btn-row">' +
          '<button type="button" class="btn btn-secondary" id="btn-check-updates"' + (updatesBusy ? ' disabled' : '') + '>' +
            (state.updateChecking ? 'Checking…' : 'Check for updates') +
          '</button>' +
        '</div>' +
        renderUpdateStatus() +
      '</div>' +

      // Setup guide (D-C). The first-run panel is dismissible, so it needs
      // exactly one place it can be found again.
      '<div class="settings-field-block">' +
        '<span class="settings-field-label">Setup guide</span>' +
        '<p class="settings-hint-text">The first-run checklist — AI key, first domain, first source. ' +
        'It appears on its own until setup is finished, and dismissing it is never permanent.</p>' +
        '<div class="settings-btn-row">' +
          '<button type="button" class="btn btn-secondary" id="btn-show-setup-guide">Show setup guide</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

// The apply half of the flow OWNS the panel while it is running — an
// install in progress must never be redrawn as a stale "Update available"
// banner underneath the process replacing itself.
function renderUpdateStatus() {
  if (state.updatePhase === 'applying') {
    return box('', 'Installing…', 'Pulling the published version and installing dependencies. This can take a minute. Don’t quit the app.');
  }
  if (state.updatePhase === 'restarting') {
    const r = state.updateResult || {};
    return box('',
      'Restarting…',
      'Update installed. Waiting for the app to come back, then this page reloads itself.' +
        (r.from && r.to ? '<span class="upd-detail upd-sha">' + escapeHtml(r.from) + ' → ' + escapeHtml(r.to) + '</span>' : ''),
      r.partial && r.warning ? r.warning : null,
      state.updateRestartHint
        ? 'The app hasn’t answered yet. If it doesn’t come back on its own, right-click the Dock icon → Quit, then re-open The Curator.'
        : null);
  }
  if (state.updatePhase === 'failed') {
    return box('upd-bad', 'Update failed', escapeHtml(state.updateError || 'Unknown error.'),
      null, 'Nothing was restarted. You can try again, or update by hand from your checkout.');
  }

  const v = classifyUpdate(state.updateCheck, state.version);

  if (v.kind === 'idle') return '';
  if (v.kind === 'error') return box('upd-bad', 'Couldn’t check for updates', escapeHtml(v.message));

  if (v.kind === 'restart-required') {
    return box('upd-attention',
      'Restart needed',
      'The files on disk are already v' + escapeHtml(String(v.onDisk)) + ', but the running app is still v' +
        escapeHtml(String(v.running)) + '. There is nothing to download — it just needs to restart.',
      null, null,
      '<button type="button" class="btn btn-primary btn-xs" id="btn-update-restart">Restart now</button>');
  }

  if (v.kind === 'local-ahead') {
    // The maintainer's own state: a release committed locally and not yet
    // pushed. The route's updateAvailable is true here purely because the
    // versions DIFFER, so the naive banner offered to "update" the checkout
    // backwards onto the older published tree. Say what is actually true.
    return box('upd-good',
      'This copy is ahead of the published version',
      'You’re running v' + escapeHtml(String(v.current)) + '; the published version is v' + escapeHtml(String(v.latest)) +
        '. There is nothing to install — installing would replace your newer files with the older published ones.',
      null,
      'If this is your own unpushed work, push it; the check will agree once it’s published.');
  }

  if (v.kind === 'current') {
    return box('upd-good', 'You’re up to date', 'Running v' + escapeHtml(String(v.current)) + '.');
  }

  const label = v.versionsDiffer
    ? 'v' + escapeHtml(String(v.current)) + ' → v' + escapeHtml(String(v.latest))
    : 'v' + escapeHtml(String(v.current)) +
      (v.localCommit && v.remoteCommit
        ? ' <span class="upd-sha">' + escapeHtml(v.localCommit) + ' → ' + escapeHtml(v.remoteCommit) + '</span>'
        : ' (newer commits published)');
  return box('upd-attention', 'Update available', label, null,
    'Installing replaces the app’s program files and restarts it. Your knowledge base, keys and sync settings are untouched.',
    '<button type="button" class="btn btn-primary btn-xs" id="btn-apply-update"' + (crossWriteBusy() ? ' disabled title="Wait for the running ingest or sync to finish"' : '') + '>Install update</button>');
}

// Small local builder — everything interpolated is either escaped at the
// call site or a server-authored string that is escaped here.
function box(cls, headline, bodyHtml, warningText, detailText, actionsHtml) {
  return (
    '<div class="upd-status' + (cls ? ' ' + cls : '') + '" role="status">' +
      '<span class="upd-headline">' + escapeHtml(headline) + '</span>' +
      '<span>' + (bodyHtml || '') + '</span>' +
      (detailText ? '<span class="upd-detail">' + escapeHtml(detailText) + '</span>' : '') +
      (warningText ? '<span class="upd-warning">' + escapeHtml(warningText) + '</span>' : '') +
      (actionsHtml ? '<div class="upd-actions">' + actionsHtml + '</div>' : '') +
    '</div>'
  );
}

function renderQuickSummary(quick) {
  const s = quick.summary;
  const parts = [];
  if (s.fail) parts.push(s.fail + ' failed');
  if (s.warn) parts.push(s.warn + ' need attention');
  if (s.ok) parts.push(s.ok + ' ok');
  if (s.info) parts.push(s.info + ' info');
  const rows = quick.checks.map((c) => {
    const cls = 'check-' + c.status;
    const glyph = c.status === 'ok' ? icon('checkAlt', 13)
      : c.status === 'fail' ? icon('x', 13)
      : c.status === 'warn' ? icon('alertTriangle', 13)
      : icon('dotRing', 11);
    return (
      '<div class="check-row ' + cls + '">' +
        '<span class="check-glyph">' + glyph + '</span>' +
        '<span class="check-label">' + escapeHtml(c.label) + '</span>' +
        '<span class="check-detail">' + escapeHtml(c.detail) + '</span>' +
      '</div>'
    );
  }).join('');
  return (
    '<div class="settings-check-results">' +
      '<div class="check-summary-line mono">' + escapeHtml(parts.join(' · ') || 'No checks ran.') + '</div>' +
      rows +
    '</div>'
  );
}

function renderLiveConfirm() {
  return (
    '<div class="cost-confirm" role="group" aria-label="Confirm AI connection test">' +
      icon('alertTriangle', 14) +
      '<span class="cost-confirm-text">This makes one real API call to your active provider to confirm it responds. ' +
      'Estimated cost: <strong>$0.0001</strong>. Nothing else is read or written.</span>' +
      '<div class="cost-confirm-actions">' +
        '<button type="button" class="btn btn-primary btn-xs" id="btn-verify-ai-confirm"' + (state.liveLoading ? ' disabled' : '') + '>' +
          (state.liveLoading ? 'Verifying…' : 'Confirm — run it') +
        '</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" id="btn-verify-ai-cancel"' + (state.liveLoading ? ' disabled' : '') + '>Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

function renderLiveResult() {
  const r = state.live;
  if (r.ok) {
    return (
      '<div class="settings-check-results">' +
        '<div class="check-row check-ok">' +
          '<span class="check-glyph">' + icon('checkAlt', 13) + '</span>' +
          '<span class="check-label">Works</span>' +
          '<span class="check-detail mono">' + escapeHtml(r.provider) + ' · ' + escapeHtml(r.model) + ' · ' + escapeHtml(String(r.latencyMs)) + ' ms' +
            (r.sample ? ' · replied "' + escapeHtml(r.sample) + '"' : '') +
          '</span>' +
        '</div>' +
      '</div>'
    );
  }
  return (
    '<div class="settings-check-results">' +
      '<div class="check-row check-fail">' +
        '<span class="check-glyph">' + icon('x', 13) + '</span>' +
        '<span class="check-label">Failed</span>' +
        '<span class="check-detail">' + escapeHtml(r.error || 'Unknown error') + '</span>' +
      '</div>' +
    '</div>'
  );
}

// ── Providers & keys ──────────────────────────────────────────────────────

function renderProviders() {
  if (state.keysError) {
    return '<p class="view-body">At least one key is required. Saving a key makes that provider available in the ' +
      'chat model picker; the active provider is used for ingest and health scans.</p>' +
      '<div class="settings-inline-error">' + escapeHtml(state.keysError) + '</div>';
  }
  if (!state.keys) {
    return gatedLoader(loadGate, 'Loading provider status…');
  }
  const k = state.keys;
  // Cross-view write gate (see file-header comment): a write in flight
  // anywhere depends on getProviderInfo() resolving consistently for the
  // rest of its run — Save/Disconnect/Set-active can change that mid-write.
  const crossBusy = crossWriteBusy();
  // Each provider's model catalogue is appended DIRECTLY AFTER its own row so
  // the prices sit under the key they are billed against. renderProviderRow
  // is left byte-identical — scripts/test-next-provider-rows.js extracts and
  // executes it, and this change must not perturb what it renders.
  const rows = PROVIDER_ROWS.map((p) => renderProviderRow(p, k, crossBusy) + renderModelPicker(p, k, state.modelPickerOpen[p.id] === true, crossBusy)).join('');

  return (
    '<p class="view-body">At least one key is required. Saving a key makes that provider available in the chat model ' +
    'picker; the active provider is used for ingest and health scans.</p>' +
    renderCrossWriteBanner('wait for it to finish before changing keys or the active provider — it may be mid-call.') +
    (state.keysActionError ? '<div class="settings-inline-error">' + escapeHtml(state.keysActionError) + '</div>' : '') +
    // Deliberately ABOVE the provider list and never behind a disclosure:
    // a fallback is a silent change to what the user is billed, so it has
    // to be unmissable on the section that owns providers.
    renderFallbackBanner(k.fallback) +
    renderActiveModelLine(k) +
    '<div class="provider-row-list">' + rows + '</div>' +
    '<div class="settings-note-row">' +
      icon('lockAlt', 15) +
      '<span>Keys live in <code class="mono">.curator-config.json</code> at 0600 on this machine. Never committed, ' +
      'never sent anywhere except the provider you call.</span>' +
    '</div>'
  );
}

// Amber callout, rendered whenever a fallback is active. Every interpolated
// value is model/provider text that originates upstream of us, so all of it
// goes through escapeHtml — the ids are ours today, but "the payload is
// trustworthy" is not a property this render function can verify.
function renderFallbackBanner(fallback) {
  const v = classifyFallback(fallback);
  if (!v.show) return '';
  const cost = v.costNote
    ? '<span class="provider-fallback-cost provider-fallback-cost-' + escapeHtml(v.costLevel) + '">' +
        escapeHtml(v.costNote) + '</span>'
    : '';
  return (
    '<div class="provider-fallback-banner" data-cost-tier="' + escapeHtml(v.costTier) + '">' +
      icon('alertTriangle', 15) +
      '<div class="provider-fallback-body">' +
        '<span class="provider-fallback-headline"><strong>Using fallback model.</strong> ' +
          escapeHtml(v.providerLabel) + '’s <code class="mono">' + escapeHtml(v.requestedModel) +
          '</code> is unavailable; currently running on <code class="mono">' +
          escapeHtml(v.usingModel) + '</code>.</span>' +
        cost +
        '<span class="provider-fallback-action">' + escapeHtml(v.action) + '</span>' +
      '</div>' +
    '</div>'
  );
}

// One line of fact: which provider is active and which model it actually
// resolved to. See activeModelLine()'s docblock for why this is not the
// same as the per-row default model.
function renderActiveModelLine(k) {
  const a = activeModelLine(k);
  if (!a.show) return '';
  return (
    '<div class="provider-active-line">' +
      '<span class="provider-active-label">Active</span>' +
      '<span class="mono provider-active-value">' + escapeHtml(a.providerLabel) + ' — ' +
        escapeHtml(a.model) + '</span>' +
    '</div>'
  );
}

function renderProviderRow(p, k, crossBusy) {
  if (!p.available) {
    return (
      '<div class="provider-row provider-row-unavailable">' +
        '<span class="provider-dot" style="background:' + p.dot + '"></span>' +
        '<span class="provider-name-block">' +
          '<span class="provider-name">' + escapeHtml(p.name) + '</span>' +
          '<span class="mono provider-model">—</span>' +
        '</span>' +
        '<code class="provider-key-field mono provider-key-empty">not available</code>' +
        '<span class="mono provider-state provider-state-muted">not available in this build</span>' +
        '<button type="button" class="btn btn-secondary btn-xs" disabled title="Not available in this build">Replace</button>' +
      '</div>'
    );
  }

  // Keyed by p.id via a lookup table, NOT a binary gemini/anthropic ternary.
  // The prior form (`p.id === 'gemini' ? A : B`) had only two arms, so ANY
  // third provider row fell into the `else` and rendered ANTHROPIC's masked
  // key + "configured"/"active" state next to that other provider's name —
  // a real misrepresentation on a credentials screen. It was latent only
  // because openai/local both have `available: false` and return early
  // above; it arms the moment a third provider is flipped available. A
  // provider id absent from this table fails SAFE (undefined reads as "no
  // key" below) rather than falling through to someone else's credentials.
  const KEY_INFO_BY_PROVIDER = {
    gemini: { field: k.geminiApiKey, has: k.hasGeminiKey },
    anthropic: { field: k.anthropicApiKey, has: k.hasAnthropicKey },
  };
  const keyInfo = KEY_INFO_BY_PROVIDER[p.id] || {};
  const hasKeyField = keyInfo.field;
  const hasKey = keyInfo.has;
  const model = (k.models && k.models[p.id]) || '—';
  const isActive = k.activeProvider === p.id;
  const isReplacing = state.replacing === p.id;
  const isBusy = state.keysBusy === p.id;

  const stateText = isActive ? 'active' : (hasKey ? 'configured' : 'not set');
  const stateClass = isActive ? 'provider-state-active' : 'provider-state-muted';

  // `isBusy` is THIS row's own in-flight request (already disables + shows
  // its own "Saving…"/etc label — not a conflict with itself). `crossBusy`
  // is a write happening somewhere ELSE. Only show the cross-write title
  // when it's the reason a control is disabled, not when the row's own
  // request already explains itself.
  const mutateDisabled = isBusy || crossBusy;
  const crossTitleAttr = (crossBusy && !isBusy)
    ? ' title="' + escapeHtml(crossWriteTitle('wait for it to finish before changing keys or the active provider — it may be mid-call.')) + '"'
    : '';

  const extraActions = [];
  if (hasKey && !isActive) {
    extraActions.push('<button type="button" class="btn btn-ghost btn-xs" data-set-active="' + p.id + '"' + (mutateDisabled ? ' disabled' : '') + crossTitleAttr + '>Set active</button>');
  }
  if (hasKey) {
    extraActions.push('<button type="button" class="btn btn-ghost btn-xs" data-disconnect="' + p.id + '"' + (mutateDisabled ? ' disabled' : '') + crossTitleAttr + '>Disconnect</button>');
  }

  let fieldHtml;
  if (isReplacing) {
    fieldHtml = (
      '<div class="provider-replace-row">' +
        // MEDIUM-2 fix: deliberately NO `value="..."` attribute here — same
        // reasoning as sync.js's L2 fix for its own PAT field (see that
        // file's renderUnconfigured() comment): an HTML `value=` attribute
        // is plain text in the markup/outerHTML regardless of `type`, so a
        // credential rendered that way is readable in DevTools' Elements
        // panel or any copied outerHTML — the on-screen dot-masking a
        // type="password" input gives you does NOT extend to its source.
        // wireProviderListeners() below sets `.value` as a live DOM
        // property immediately after this markup lands, restoring
        // whatever's in state.replaceValue WITHOUT it ever touching HTML.
        '<input type="password" class="provider-replace-input mono" id="replace-input-' + p.id + '" placeholder="Paste your ' + escapeHtml(p.name) + ' API key" autocomplete="off" spellcheck="false">' +
        '<button type="button" class="btn btn-primary btn-xs" data-save-key="' + p.id + '"' + (mutateDisabled ? ' disabled' : '') + crossTitleAttr + '>' + (isBusy ? 'Saving…' : 'Save') + '</button>' +
        // Cancel never hits the network — always enabled, even mid cross-write, so there is always a way out of the replace row.
        '<button type="button" class="btn btn-ghost btn-xs" data-cancel-replace="' + p.id + '"' + (isBusy ? ' disabled' : '') + '>Cancel</button>' +
      '</div>'
    );
  } else {
    fieldHtml = (
      '<code class="provider-key-field mono' + (hasKeyField ? '' : ' provider-key-empty') + '">' + escapeHtml(hasKeyField || 'Not set') + '</code>' +
      '<span class="mono provider-state ' + stateClass + '">' + stateText + '</span>' +
      '<div class="provider-row-actions">' +
        extraActions.join('') +
        // "Replace" only opens the input row locally — no network call — so it's deliberately NOT gated (see file-header comment).
        '<button type="button" class="btn btn-secondary btn-xs" data-replace="' + p.id + '"' + (isBusy ? ' disabled' : '') + '>Replace</button>' +
      '</div>'
    );
  }

  return (
    '<div class="provider-row' + (isReplacing ? ' provider-row-replacing' : '') + '">' +
      '<span class="provider-dot" style="background:' + p.dot + '"></span>' +
      '<span class="provider-name-block">' +
        '<span class="provider-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="mono provider-model">' + escapeHtml(model) + '</span>' +
      '</span>' +
      fieldHtml +
    '</div>'
  );
}


// ── The per-provider MODEL LIST ─────────────────────────────────────────────
//
// WHY THIS EXISTS. Until v3.12.0 The Curator ran exactly one model per
// provider — the cheapest tier — and a user who wanted more capability out of
// a large wiki, on their own key, had no way to ask and no way to see what
// asking would cost. `GET /api/config/api-keys` now carries an `offerable`
// catalogue: every model probed live against this repo's REAL ingest outline
// prompt, ordered cheapest-first, each entry carrying the MEASURED reason
// behind its verdict. This renders that catalogue.
//
// THE SPAN IS 50x ON INPUT AND 62x ON OUTPUT across the two catalogues, so a
// user choosing blind can multiply their bill without noticing. Every row
// therefore carries its own price, and the price is the LIVE `input`/`output`
// the route resolved — never `standardInput`/`standardOutput`, which are the
// post-promotion figures and are NOT what anyone is billed today. Two of the
// Gemini models are on a promotion that doubles on 2027-01-01; a promo shown
// as if it were permanent is the exact trap the backend's promotional-price
// table was built to avoid, so the rise is rendered beside the price.
//
// NOTES ARE SHOWN VERBATIM, NOT PARAPHRASED. `note` is the measured finding
// (JSON reliability, outline coverage, hidden reasoning spend, tokenizer
// premium) written upstream to be read by a user. Rewriting it into marketing
// copy would delete the only thing that makes an honest choice possible. Nor
// is any model hidden: `chat-only`, `caution` and `dominated` entries are all
// listed and LABELLED, because hiding a working model decides for someone what
// they may spend their own key on — see OFFERABLE_MODELS' docblock in llm.js.
//
// ── IT IS NOW A CONTROL, AND THE WRITE IS NEVER OPTIMISTIC ────────────────
// v3.13.0 landed the missing half of this feature: POST
// /api/config/api-keys/model persists a per-provider model pick (server-side,
// read by resolveProviderDefault on every LLM call — INGEST and HEALTH SCANS
// included, both of which the server starts on its own with no browser in the
// loop), and every non-selected row below renders a real "Use this" button
// (`data-pick-model` / `data-pick-provider`, wired to `onPickModel`).
// `renderModelPickerScope()` still carries the honesty line this section was
// built around, because the underlying hazard it guards against did not go
// away when the endpoint arrived — it only moved from "there is no control"
// to "the control must never lie while a write is in flight":
//   · `onPickModel` never writes an optimistic selection into `state.keys`.
//     The rendered "your choice" / "in use" badges move ONLY after the POST
//     resolves and `loadKeys()` has re-read the server's own answer — which
//     is not necessarily the id just sent, since a stored pick that stops
//     being offerable falls back server-side and the header must say so.
//   · A picker showing "selected: Opus 5" while the wire still confirms
//     Haiku 4.5 is billing is exactly the dead-data shape this repo keeps
//     re-finding under a new name (v3.6.1 finding 5, v3.9.0 finding 7,
//     v3.9.1 finding 9) — a selection nobody's server obeys, with no symptom
//     to notice. The two-source display (`models[p.id]` = what actually
//     runs, `selectedModels[p.id]` = what the user asked for, straight off
//     the wire) is what keeps that claim honest now that it can be acted on.
// See `renderModelPicker()` and `onPickModel()` below for the mechanics.
const MODEL_SUITABILITY_BADGES = {
  'chat-only': 'chat only — not for ingest',
  caution: 'caution',
};

/** '2027-01-01' -> '1 Jan 2027'. Parsed from the ISO COMPONENTS, never via
 *  `new Date(iso)` + toLocaleDateString: that reads the string as UTC midnight
 *  and then renders it in the viewer's zone, so anyone west of Greenwich would
 *  be told a price rises on 31 Dec 2026. An off-by-one on a price date is a
 *  small lie about money. Unparseable input returns the raw string rather than
 *  inventing a date. */
function formatIsoDay(iso) {
  if (typeof iso !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return iso;
  return String(Number(m[3])) + ' ' + MONTHS[monthIdx] + ' ' + m[1];
}

/** 128000 -> '128,000'. Grouped manually rather than with toLocaleString so
 *  the output does not change under a different locale (a German viewer would
 *  otherwise read '128.000', which in a price-adjacent list reads as a
 *  decimal). */
function formatTokenCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** One model's price, as billed RIGHT NOW. Both figures go through the shared
 *  formatUsdHonest so a non-zero cost can never render as $0.00 — see
 *  shared/format-usd.js. Returns '' when either figure is missing, so a
 *  half-priced row renders no price at all rather than an authoritative-looking
 *  half-truth. */
function formatModelPrice(input, output) {
  const inStr = formatUsdHonest(input);
  const outStr = formatUsdHonest(output);
  if (!inStr || !outStr) return '';
  return inStr + ' in · ' + outStr + ' out';
}

/**
 * The honesty line at the top of every model list. See the block comment
 * above for why it says what it says. `defaultId` is the model this provider
 * actually runs today (`k.models[provider]`, i.e. llm.js's getDefaultModel).
 */
function renderModelPickerScope(defaultId, selectedId, provider, pickDisabled) {
  const running = defaultId
    ? 'The Curator runs <code class="mono">' + escapeHtml(defaultId) + '</code> on this provider.'
    : 'The Curator runs this provider’s default model.';

  // Two genuinely different states, and conflating them is the reason this
  // sentence exists. "Following the default" means a future release can bump
  // you onto a newer model; "pinned" means it cannot. A user deciding what to
  // spend needs to know which of those they are in.
  const pinned = selectedId
    ? ' You have pinned this choice, so app updates will not move you off it.'
    : ' You have not picked one, so this follows the app default and can change when The Curator updates.';

  // The ONLY way back to "follow the default" — picking the default model by
  // hand pins it, which is a different thing. Offered only when there is
  // something to clear, so the control never appears as a no-op.
  const clear = selectedId
    // btn-secondary, not btn-ghost: a ghost button inside this tinted
    // paragraph rendered as plain prose in the browser, so the one route back
    // to the un-pinned state did not read as a control at all.
    ? ' <button type="button" class="btn btn-secondary btn-xs model-pick-clear"' +
        ' data-pick-clear="' + escapeHtml(String(provider === undefined || provider === null ? '' : provider)) + '"' +
        (pickDisabled ? ' disabled' : '') +
        '>Follow the app default</button>'
    : '';

  return (
    '<p class="model-picker-scope">' + running + pinned +
    ' Prices are per 1M tokens, as billed today.' + clear + '</p>'
  );
}

/**
 * Render one provider's model catalogue, or '' when it must not appear.
 *
 * GATED ON THE SAVED KEY, not on `.env`. A provider the user Disconnected in
 * Settings must not be pickable anywhere — that is v3.0.13's rule, and it
 * exists because a user Disconnected a key and the app went on using it. The
 * route already applies the same gate server-side (a provider with no SAVED
 * key gets `offerable: []`), so this is the second of two independent layers
 * rather than the only one.
 *
 * The gate is a LOOKUP, never `p.id === 'gemini' ? … : …`. That binary shape
 * is what made renderProviderRow render Anthropic's masked key beside a third
 * provider's name (v3.10.1); an id absent from the table resolves to
 * `undefined` here and the whole list disappears, which is the safe direction.
 * Note that scripts/test-next-provider-rows.js's class invariant is
 * FUNCTION-scoped — it extracts renderProviderRow and onSaveKey — so it could
 * not have caught the shape reappearing in a NEW function.
 * scripts/test-next-model-picker.js carries the same invariant for this one.
 */
function renderModelPicker(p, k, isOpen, crossBusy) {
  if (!p || !p.available || !k) return '';

  const HAS_KEY_BY_PROVIDER = {
    gemini: k.hasGeminiKey,
    anthropic: k.hasAnthropicKey,
    // A future provider (OpenRouter, a local runtime) adds ONE line here and
    // one entry to PROVIDER_ROWS. Nothing else in this file needs to change:
    // the section, its header and its list are all derived from the
    // catalogue the route sends for that id.
  };
  if (!HAS_KEY_BY_PROVIDER[p.id]) return '';

  const list = (k.offerable && Array.isArray(k.offerable[p.id])) ? k.offerable[p.id] : [];
  if (list.length === 0) return '';

  const defaultId = (k.models && typeof k.models[p.id] === 'string') ? k.models[p.id] : '';

  // The user's EXPLICIT stored pick, straight off the wire — never a local
  // optimistic copy. `models[p.id]` above is what the app will actually RUN
  // (already resolved through the stored pick server-side); this is what the
  // user CHOSE. They are usually the same string and are two different facts:
  // a stored id that has since stopped being offerable is reported here while
  // `models` shows the fallback the engine really uses. In that case nothing
  // in the list matches, so nothing gets badged as the choice — which is the
  // honest outcome, and the safe direction.
  const selectedId = (k.selectedModels && typeof k.selectedModels[p.id] === 'string')
    ? k.selectedModels[p.id]
    : '';

  // A pick is a config WRITE that resolveProviderDefault reads fresh on every
  // LLM call, so it must not land mid-ingest. The route refuses with 409
  // (guardConcurrent) and that refusal is the real guarantee; this is the
  // second layer, disabling the control so the common case never produces a
  // refusal at all. Same two-layer shape as the Install-update button above.
  const busyId = typeof state.modelPickBusy === 'string' ? state.modelPickBusy : '';
  const pickDisabled = !!crossBusy || busyId !== '';

  // Rendered in DELIVERED ORDER. The route ships them cheapest-first and that
  // ordering is asserted upstream; re-sorting here would create a second
  // opinion about which model is cheapest, and a picker that leads with the
  // priciest model is a cost trap.
  const ctx = { provider: p.id, selectedId, busyId, pickDisabled, crossBusy: !!crossBusy };
  const items = list.map((m, i) => renderModelOption(m, i, defaultId, ctx)).join('');

  const errText = (state.modelPickError && typeof state.modelPickError[p.id] === 'string')
    ? state.modelPickError[p.id]
    : '';
  const errHtml = errText
    ? '<div class="settings-inline-error model-pick-error" role="alert">' + escapeHtml(errText) + '</div>'
    : '';

  // THE COLLAPSED HEADER ANSWERS THE COMMON QUESTION WITHOUT AN EXPAND.
  // "What am I running on this provider?" is asked far more often than "show
  // me the whole catalogue", so the model in force is in the summary. Note
  // there is deliberately NO CONTROL in this summary — only text and the
  // disclosure marker. An interactive element inside <summary> toggles the
  // section when clicked (v3.0.1-beta.18: Health's "Fix all" needed
  // preventDefault + stopPropagation for exactly this), and a control that
  // collapses the thing it acts on is a trap not worth accepting for a row
  // that has nothing to act on yet.
  //
  // AND IT NAMES THE STORED PICK, not merely the model in force. Those read
  // the same most of the time, which is exactly why the distinction has to be
  // drawn here rather than left to inference: "using X" alone cannot tell a
  // user whether X is theirs (pinned, and it will stay X) or ours (a default,
  // and a future release may move it). The marker is the only thing on the
  // collapsed header that answers that, and it updates when the POST resolves
  // because the whole header is derived from the refetched payload.
  const current = defaultId
    ? '<span class="mono model-picker-current">using ' + escapeHtml(defaultId) + '</span>'
    : '';
  const chosen = selectedId
    ? '<span class="model-picker-chosen">your choice</span>'
    : '';

  return (
    '<details class="model-picker"' + (isOpen === true ? ' open' : '') +
      ' data-model-picker="' + escapeHtml(p.id) + '">' +
      '<summary class="model-picker-summary">' +
        icon('chevronRight', 12) +
        '<span class="model-picker-title">' + escapeHtml(p.name) + '</span>' +
        current +
        chosen +
        '<span class="mono model-picker-count">' + escapeHtml(String(list.length)) + ' models</span>' +
      '</summary>' +
      '<div class="model-picker-body">' +
        renderModelPickerScope(defaultId, selectedId, p.id, pickDisabled) +
        errHtml +
        '<ul class="model-list">' + items + '</ul>' +
      '</div>' +
    '</details>'
  );
}

/**
 * One model row. Every interpolated value originates in llm.js but arrives
 * over an HTTP response, so all of it — label, id, note, suitability — goes
 * through escapeHtml. "The payload is ours" is not a property this function
 * can verify, and `note` is multi-sentence prose: exactly the field where a
 * metacharacter is least likely to be noticed by eye.
 */
function renderModelOption(m, index, defaultId, ctx) {
  if (!m || typeof m !== 'object') return '';
  const c = ctx || {};

  const isDefault = !!(defaultId && m.id === defaultId);
  // THREE INDEPENDENT AXES, all shown at once and never collapsed into one
  // marker. "in use" is what the app runs; "your choice" is what the user
  // pinned; "cheapest" is what costs least. A user comparing spend needs to
  // see their own pick and the cheapest option in the same glance — merging
  // "in use" and "your choice" into a single badge would hide precisely the
  // question this screen exists to answer (am I paying more than I need to,
  // and did I ask for that?).
  const isSelected = !!(c.selectedId && m.id === c.selectedId);
  const badges = [];
  if (isDefault) badges.push('<span class="model-badge model-badge-default">in use</span>');
  if (isSelected) badges.push('<span class="model-badge model-badge-chosen">your choice</span>');
  if (index === 0) badges.push('<span class="model-badge model-badge-cheapest">cheapest</span>');
  // A non-'general' verdict and a `dominated` flag are INDEPENDENT axes and
  // both are shown: a model can be honestly priced and fully usable while a
  // same-priced sibling measured better (claude-opus-4-5), and that is a
  // different fact from "measured unfit for ingest".
  const suitabilityBadge = MODEL_SUITABILITY_BADGES[m.suitability];
  if (suitabilityBadge) {
    badges.push('<span class="model-badge model-badge-flag">' + escapeHtml(suitabilityBadge) + '</span>');
  }
  if (m.dominated) {
    badges.push('<span class="model-badge model-badge-flag">out-performed</span>');
  }

  const price = formatModelPrice(m.input, m.output);
  const priceHtml = price
    ? '<span class="mono model-price">' + escapeHtml(price) +
        '<span class="model-price-unit"> /1M tokens</span></span>'
    : '';

  // Only claim a rise when the live price is ACTUALLY below the standard one.
  // `promotionUntilIso` stays populated after a promotion expires, at which
  // point input/output already equal the standard figures and there is no
  // rise left to announce — saying otherwise would be a warning about a price
  // change that has already happened.
  const promoActive = !!m.promotionUntilIso &&
    (m.input !== m.standardInput || m.output !== m.standardOutput);
  const standard = promoActive ? formatModelPrice(m.standardInput, m.standardOutput) : '';
  const riseHtml = (promoActive && standard)
    ? '<span class="model-promo">rises to ' + escapeHtml(standard) +
        (m.standardPriceFromIso ? ' on ' + escapeHtml(formatIsoDay(m.standardPriceFromIso)) : '') +
        '</span>'
    : '';

  const facts = [];
  const cap = formatTokenCount(m.maxOutput);
  if (cap) facts.push(cap + ' max output');
  // Thinking tokens are billed as OUTPUT and drawn from the SAME budget as the
  // answer, so this is a cost fact, not a capability note.
  if (m.thinks) facts.push('thinks — hidden tokens billed as output');
  if (typeof m.tokenizerFactor === 'number' && m.tokenizerFactor > 1) {
    facts.push(m.tokenizerFactor.toFixed(2) + '× input tokens on the same text');
  }
  const factsHtml = facts.length
    ? '<span class="mono model-facts">' + escapeHtml(facts.join(' · ')) + '</span>'
    : '';

  const noteHtml = (typeof m.note === 'string' && m.note.trim())
    ? '<p class="model-note">' + escapeHtml(m.note) + '</p>'
    : '';

  // ── DENSITY: one row per model, its evidence one click inside ──────────
  // Fourteen models with a four-line note each measured 3,938px — 4.6
  // screens — and the maintainer's report was the scroll. So each model is
  // its own nested <details>: the row carries everything a SPENDING decision
  // needs without any expand (name, id, price billed today, the promotional
  // rise, and every badge), and the expand carries the measured evidence
  // behind those badges.
  //
  // WHAT IS DELIBERATELY NOT FOLDED AWAY: the price, the rise, and the flag
  // badges. Folding a price would defeat the entire feature; folding a badge
  // would leave the user no signal that there is anything to read. The note
  // is folded because it is the ARGUMENT for a badge already on screen, and
  // the row itself is the control that opens it — so there is no separate
  // affordance to miss and none to mis-click.
  //
  // The nested <details> lives in the OUTER section's body, never in its
  // <summary>, so the v3.0.1-beta.18 control-inside-summary hazard does not
  // apply: clicking a model row toggles that model, not its provider.
  const expandable = factsHtml || noteHtml;
  const summaryInner = (
    '<span class="model-row-line">' +
      icon('chevronRight', 11) +
      '<span class="model-name">' + escapeHtml(m.label || m.id || '') + '</span>' +
      '<code class="mono model-id">' + escapeHtml(m.id || '') + '</code>' +
      badges.join('') +
    '</span>' +
    '<span class="model-row-line model-row-cost">' + priceHtml + riseHtml + '</span>'
  );

  const inner = expandable
    ? '<details class="model-row">' +
        '<summary class="model-row-summary">' + summaryInner + '</summary>' +
        '<div class="model-row-body">' + factsHtml + noteHtml + '</div>' +
      '</details>'
    // No evidence to show — render the same row WITHOUT a disclosure rather
    // than an expander that opens onto nothing.
    : '<div class="model-row model-row-flat">' + summaryInner + '</div>';

  // ── THE CONTROL SITS OUTSIDE THE <details>, DELIBERATELY ────────────────
  // A <button> inside a <summary> toggles that <summary>'s section when
  // clicked — v3.0.1-beta.18, where Health's "Fix all" needed preventDefault
  // + stopPropagation to survive living there. Rather than accept that hazard
  // and paper over it with two event calls that a later edit can drop, the
  // pick control is a SIBLING of the row's disclosure inside the <li>. There
  // is no propagation path from it to any <summary>, so no suppression is
  // needed and none can be forgotten. It is also always visible: folding the
  // one control that spends money behind an expander would be the opposite of
  // the density trade this list already makes (evidence folds, decisions do
  // not).
  const idAttr = escapeHtml(String(m.id === undefined || m.id === null ? '' : m.id));
  const isPending = !!(c.busyId && c.busyId === c.provider + '::' + m.id);
  let control;
  if (isSelected) {
    // No button at all on the model already pinned. A control whose only
    // outcome is re-writing the value it already has invites a click that
    // does nothing, and — while a write is running — a click that is refused
    // for no reason the user can act on.
    control = '<span class="model-pick-state">Selected</span>';
  } else {
    const label = isPending ? 'Saving…' : 'Use this';
    const disabledAttr = (c.pickDisabled || isPending) ? ' disabled' : '';
    const titleAttr = (c.crossBusy && !isPending)
      ? ' title="' + escapeHtml(crossWriteTitle('changing the model mid-run would plan on one model and write on another, and would invalidate the prompt cache.')) + '"'
      : '';
    control = (
      '<button type="button" class="btn btn-secondary btn-xs model-pick-btn"' +
        ' data-pick-model="' + idAttr + '"' +
        ' data-pick-provider="' + escapeHtml(String(c.provider === undefined || c.provider === null ? '' : c.provider)) + '"' +
        disabledAttr + titleAttr + '>' + escapeHtml(label) + '</button>'
    );
  }

  return (
    '<li class="model-option' + (isDefault ? ' model-option-default' : '') +
      (isSelected ? ' model-option-chosen' : '') +
      '" data-model-id="' + idAttr + '">' +
      '<div class="model-option-main">' + inner + '</div>' +
      '<div class="model-option-pick">' + control + '</div>' +
    '</li>'
  );
}

// ── MCP bridge ────────────────────────────────────────────────────────────

function renderMcp() {
  if (state.mcpError) {
    return '<div class="settings-inline-error">' + escapeHtml(state.mcpError) + '</div>';
  }
  if (!state.mcp) {
    return gatedLoader(loadGate, 'Loading MCP status…');
  }
  const m = state.mcp;
  // A corrupt claude_desktop_config.json is its OWN state, not "not
  // connected": src/routes/mcp.js computes installed/stale inside its
  // `!parseError` branch, so both come back false for a file it could not
  // parse — reporting that as "Not connected" would be asserting something
  // we do not know. The wizard's blocked panel is where this is explained
  // and where the whole-file payload is withheld; here it only has to stop
  // claiming a status it cannot have.
  const unreadable = m.claude_config_parse_error === true;
  const connected = !unreadable && m.installed && !m.stale;
  const pillClass = connected ? 'status-pill status-pill-ok' : 'status-pill status-pill-muted';
  const pillLabel = unreadable
    ? 'Config unreadable'
    : (connected ? 'Connected' : (m.installed ? 'Needs re-connect' : 'Not connected'));
  const wizardLabel = unreadable
    ? 'Fix the config file'
    : (connected ? 'Re-run setup' : (m.installed ? 'Re-connect' : 'Set up Claude Desktop'));

  const selfTestHtml = state.selfTest ? renderSelfTestResult() : '';
  const snippetHtml = state.configSnippetOpen && state.configSnippet
    ? '<pre class="mcp-config-snippet mono">' + escapeHtml(JSON.stringify(state.configSnippet, null, 2)) + '</pre>'
    : '';

  const domains = (state.defaultDomainInfo && state.defaultDomainInfo.domains) || [];
  const defaultDomain = state.defaultDomainInfo ? state.defaultDomainInfo.defaultDomain : null;
  const options = ['<option value="">— none (require an explicit domain) —</option>']
    .concat(domains.map((d) => '<option value="' + escapeHtml(d) + '"' + (d === defaultDomain ? ' selected' : '') + '>' + escapeHtml(d) + '</option>'))
    .join('');

  return (
    '<div class="settings-status-card">' +
      '<span class="' + pillClass + '"><span class="status-pill-dot"></span>' + pillLabel + '</span>' +
      '<code class="mono mcp-path-line">Claude Desktop → ' + escapeHtml(m.mcp_server_name) + ' → ' + escapeHtml(m.domains_dir) + '</code>' +
    '</div>' +
    // Counted from mcp/tools/index.js, not from memory: 18 registered
    // tools, of which 4 mutate the wiki (the four guarded by
    // refuseIfReadonly — compile_to_wiki, fix_wiki_issue,
    // dismiss_wiki_issue, undismiss_wiki_issue). The previous copy said
    // "seventeen tools, ten read and seven write", which was wrong on all
    // three numbers and never mentioned that Claude can WRITE at all.
    // scripts/test-next-mcp-wizard.js pins these against the real table.
    '<p class="view-body">Exposes your graph to any MCP client — eighteen tools: fourteen that read your wiki, ' +
    'and four that write to it (compiling a conversation into pages, and fixing health issues) without leaving ' +
    'Claude. Write tools refuse on <code class="mono">shared-*</code> mirrors by design. The Curator does not ' +
    'need to be running: the bridge is a separate process the client launches on demand.</p>' +
    '<div class="settings-btn-row">' +
      '<button type="button" class="btn btn-primary" id="btn-mcp-wizard">' + escapeHtml(wizardLabel) + '</button>' +
      '<button type="button" class="btn btn-secondary" id="btn-mcp-self-test"' + (state.selfTestLoading ? ' disabled' : '') + '>' +
        (state.selfTestLoading ? 'Testing…' : 'Run self-test') +
      '</button>' +
      '<button type="button" class="btn btn-secondary" id="btn-mcp-view-config">' + (state.configSnippetOpen ? 'Hide config' : 'View config') + '</button>' +
      '<button type="button" class="btn btn-ghost" id="btn-mcp-copy-snippet">' + icon('copy', 13) + ' Copy snippet' + (state.copyFeedback ? ' — ' + escapeHtml(state.copyFeedback) : '') + '</button>' +
    '</div>' +
    selfTestHtml +
    snippetHtml +
    '<div class="settings-field-block" style="margin-top:22px">' +
      '<span class="settings-field-label">Default domain for MCP writes</span>' +
      '<p class="settings-hint-text">When a client calls a write tool and the user says “my wiki” without naming a ' +
      'domain, this one is used. Leave unset to force the model to always name a domain.</p>' +
      '<select class="settings-select mono" id="select-default-domain"' + (state.defaultDomainSaving ? ' disabled' : '') + '>' + options + '</select>' +
      (state.defaultDomainSaving ? '<span class="mono settings-saving-note">saving…</span>' : '') +
    '</div>'
  );
}

function renderSelfTestResult() {
  const r = state.selfTest;
  if (!r.ok) {
    return '<div class="settings-check-results"><div class="check-row check-fail">' +
      '<span class="check-glyph">' + icon('x', 13) + '</span>' +
      '<span class="check-label">Self-test failed</span>' +
      '<span class="check-detail">' + escapeHtml(r.error || 'The bridge did not respond as expected.') + '</span>' +
    '</div></div>';
  }
  const names = (r.tool_names || []).slice(0, 6).join(', ') + ((r.tool_names || []).length > 6 ? ', …' : '');
  const domainsNote = Array.isArray(r.domains) ? r.domains.length + ' domain(s) visible' : 'no domains found yet';
  return '<div class="settings-check-results"><div class="check-row check-ok">' +
    '<span class="check-glyph">' + icon('checkAlt', 13) + '</span>' +
    '<span class="check-label">Bridge responds</span>' +
    '<span class="check-detail mono">' + escapeHtml(String(r.tool_count)) + ' tools (' + escapeHtml(names) + ') · ' + escapeHtml(domainsNote) + '</span>' +
  '</div></div>';
}

// ── Health & scan limits ──────────────────────────────────────────────────

function renderHealthLimits() {
  if (state.aiHealthError) {
    return '<div class="settings-inline-error">' + escapeHtml(state.aiHealthError) + '</div>';
  }
  if (!state.aiHealth) {
    return gatedLoader(loadGate, 'Loading scan limits…');
  }
  return (
    '<p class="view-body">Cost ceilings for the AI scans that run from a domain’s health panel. A scan refuses to ' +
    'start when its estimate exceeds the ceiling — raise it if a scan will not run on a large wiki.</p>' +
    '<div class="settings-field-block">' +
      '<span class="settings-field-label">Cost ceiling per scan</span>' +
      '<div class="settings-input-suffix"><input type="number" min="1" class="mono settings-number-input" id="input-cost-ceiling" value="' + escapeHtml(state.costCeilingInput) + '"><span class="mono suffix">tokens</span></div>' +
      '<span class="settings-hint-text">Default 50,000 tokens ≈ $0.01 on Gemini Flash Lite.</span>' +
    '</div>' +
    '<div class="settings-field-block">' +
      '<span class="settings-field-label">Maximum candidate pairs per scan</span>' +
      '<div class="settings-input-suffix"><input type="number" min="1" class="mono settings-number-input" id="input-max-pairs" value="' + escapeHtml(state.maxPairsInput) + '"></div>' +
      '<span class="settings-hint-text">After local pre-filtering, only the top N pairs by similarity are sent to the model. Default 500.</span>' +
    '</div>' +
    (state.scanLimitsValidationError ? '<div class="settings-inline-error">' + escapeHtml(state.scanLimitsValidationError) + '</div>' : '') +
    '<button type="button" class="btn btn-primary" id="btn-save-scan-limits"' + (state.aiHealthSaving ? ' disabled' : '') + '>' +
      (state.aiHealthSaving ? 'Saving…' : 'Save scan limits') +
    '</button>' +
    (state.aiHealthSaved ? '<span class="mono settings-saved-note">' + icon('checkAlt', 12) + ' saved</span>' : '')
  );
}

// ── Knowledge base ────────────────────────────────────────────────────────

function renderStorage() {
  if (state.configError) {
    return '<div class="settings-inline-error">' + escapeHtml(state.configError) + '</div>';
  }
  if (!state.config) {
    return gatedLoader(loadGate, 'Loading…');
  }
  // Cross-view write gate (see file-header comment): changing the folder
  // mid-write sends that write's REMAINING pages to a different folder,
  // since every write resolves it fresh, per call, never cached.
  const crossBusy = crossWriteBusy();
  const chooseDisabled = state.pickingFolder || crossBusy;
  const chooseTitle = (crossBusy && !state.pickingFolder)
    ? ' title="' + escapeHtml(crossWriteTitle('changing the knowledge base folder mid-write can scatter its remaining pages into the new folder instead.')) + '"'
    : '';
  return (
    '<p class="view-body">Every domain is a folder of plain markdown here. This folder is also your Obsidian vault ' +
    '— open it with <em>Open folder as vault</em>.</p>' +
    renderCrossWriteBanner('wait for it to finish before changing the knowledge base folder.') +
    '<div class="storage-path-row">' +
      '<code class="mono storage-path">' + escapeHtml(state.config.domainsPath) + '</code>' +
      '<button type="button" class="btn btn-primary" id="btn-choose-folder"' + (chooseDisabled ? ' disabled' : '') + chooseTitle + '>' +
        (state.pickingFolder ? 'Waiting for Finder…' : 'Choose folder') +
      '</button>' +
      // "Copy" is a clipboard-only read — deliberately not gated (see file-header comment).
      '<button type="button" class="btn btn-secondary" id="btn-copy-path">Copy' + (state.pathCopyFeedback ? ' — ' + escapeHtml(state.pathCopyFeedback) : '') + '</button>' +
    '</div>' +
    '<div class="settings-note-row">' +
      icon('folder', 15) +
      '<span>Moving this folder does not lose anything — point The Curator at the new location and the graph is picked up as-is.</span>' +
    '</div>'
  );
}

// ── Listeners ─────────────────────────────────────────────────────────────
// Re-wired after every render() since setSidebar/setMain replace the DOM
// wholesale each call (same pattern as every other view in this shell).
// Entered synchronously by real click/change events — reading myMountToken
// fresh inside each handler body is safe (see the file-header comment).

function wireGlobalListeners() {
  document.querySelectorAll('.settings-nav-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.section = btn.dataset.section;
      render(myMountToken);
      ensureSectionData(state.section, myMountToken).catch(reportAsyncActionFailure);
    });
  });

  const updatesBtn = document.getElementById('settings-updates-btn');
  if (updatesBtn) updatesBtn.addEventListener('click', () => onCheckForUpdates(myMountToken));

  if (state.section === 'general') wireGeneralListeners();
  else if (state.section === 'providers') wireProviderListeners();
  else if (state.section === 'mcp') wireMcpListeners();
  else if (state.section === 'health') wireHealthListeners();
  else if (state.section === 'storage') wireStorageListeners();
}

function wireGeneralListeners() {
  document.querySelectorAll('.theme-seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => requestTheme(btn.dataset.themeChoice));
  });
  const runBtn = document.getElementById('btn-run-quick-check');
  if (runBtn) runBtn.addEventListener('click', () => onRunQuickCheck(myMountToken));
  const verifyBtn = document.getElementById('btn-verify-ai');
  if (verifyBtn) verifyBtn.addEventListener('click', () => { state.liveConfirmOpen = true; state.live = null; render(myMountToken); });
  const confirmBtn = document.getElementById('btn-verify-ai-confirm');
  if (confirmBtn) confirmBtn.addEventListener('click', () => onVerifyAiConfirm(myMountToken));
  const cancelBtn = document.getElementById('btn-verify-ai-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { state.liveConfirmOpen = false; render(myMountToken); });

  // D-C. No mount token needed: the panel is shell-owned, lives on
  // document.body, and is meant to survive navigating away from Settings —
  // so there is no view-scoped DOM here that could go stale.
  const guideBtn = document.getElementById('btn-show-setup-guide');
  if (guideBtn) guideBtn.addEventListener('click', () => openOnboardingPanel());

  // Updates. Every one of these three is re-bound on each render on a
  // freshly-created node, like every other binding in this file.
  const checkBtn = document.getElementById('btn-check-updates');
  if (checkBtn) checkBtn.addEventListener('click', () => onCheckForUpdates(myMountToken));
  const applyBtn = document.getElementById('btn-apply-update');
  if (applyBtn) applyBtn.addEventListener('click', () => onApplyUpdate(myMountToken).catch(reportAsyncActionFailure));
  const restartBtn = document.getElementById('btn-update-restart');
  if (restartBtn) restartBtn.addEventListener('click', () => onRestartOnly(myMountToken).catch(reportAsyncActionFailure));
}

function wireProviderListeners() {
  document.querySelectorAll('[data-replace]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.replacing = btn.dataset.replace;
      // MEDIUM-2 fix: a fresh row — whether opening a NEW provider's row or
      // re-opening the SAME one after a Cancel — never inherits whatever
      // was typed into a previously-open row. See the field's own doc
      // comment above for why a secret must not linger past its interaction.
      state.replaceValue = '';
      render(myMountToken);
      focusReplaceInput();
    });
  });
  document.querySelectorAll('[data-cancel-replace]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.replacing = null;
      state.replaceValue = ''; // MEDIUM-2 fix: don't let a typed-but-cancelled key linger in state
      render(myMountToken);
    });
  });
  document.querySelectorAll('[data-model-picker]').forEach((el) => {
    el.addEventListener('toggle', () => {
      // Deliberately NO render() call: <details> has already applied the
      // change itself, so repainting here would only throw away the DOM
      // the user is looking at. This records it for the NEXT repaint.
      if (el.open) state.modelPickerOpen[el.dataset.modelPicker] = true;
      else delete state.modelPickerOpen[el.dataset.modelPicker];
    });
  });
  document.querySelectorAll('[data-save-key]').forEach((btn) => {
    btn.addEventListener('click', () => onSaveKey(btn.dataset.saveKey, myMountToken));
  });
  document.querySelectorAll('[data-disconnect]').forEach((btn) => {
    btn.addEventListener('click', () => onDisconnect(btn.dataset.disconnect, myMountToken));
  });
  document.querySelectorAll('[data-set-active]').forEach((btn) => {
    btn.addEventListener('click', () => onSetActive(btn.dataset.setActive, myMountToken));
  });
  // The provider comes off the BUTTON, not from the enclosing section — the
  // same reason renderProviderRow keys its fields off a lookup table rather
  // than position. Both attributes are emitted together by renderModelOption,
  // so a control that carries one without the other is a bug, not an input to
  // guess around: onPickModel refuses an unknown provider outright.
  document.querySelectorAll('[data-pick-model]').forEach((btn) => {
    btn.addEventListener('click', () =>
      onPickModel(btn.dataset.pickProvider, btn.dataset.pickModel, myMountToken));
  });
  // Clearing is the SAME endpoint with an empty model — never a second write
  // path with its own idea of what "no selection" means.
  document.querySelectorAll('[data-pick-clear]').forEach((btn) => {
    btn.addEventListener('click', () => onPickModel(btn.dataset.pickClear, '', myMountToken));
  });

  // MEDIUM-2 fix: restore the live DOM `.value` from state on EVERY render
  // (mirrors sync.js's tokenInput.value restore in its own wireListeners —
  // see that file's L2 comment), and keep state in sync on every keystroke
  // via a plain 'input' listener that only writes to state, never calls
  // render() itself — a render mid-keystroke would rebuild the input node
  // and drop focus/caret for no reason, when nothing about what's ON
  // SCREEN needs to change while the user is still typing.
  if (state.replacing) {
    const input = document.getElementById('replace-input-' + state.replacing);
    if (input) {
      input.value = state.replaceValue || '';
      input.addEventListener('input', (e) => { state.replaceValue = e.target.value; });
    }
  }
}

function focusReplaceInput() {
  if (!state.replacing) return;
  const el = document.getElementById('replace-input-' + state.replacing);
  if (el) el.focus();
}

function wireMcpListeners() {
  // `myMountToken` is read here, synchronously at bind time, exactly as
  // every other binding in this file does — wireGlobalListeners() re-runs
  // after each render on freshly-created nodes, so there is nothing to
  // removeEventListener.
  //
  // onDone: state.mcp is CACHED (ensureSectionData only fetches when it is
  // null, see its guard above), so a plain re-render after the wizard has
  // changed something would redraw the PRE-setup status. Nulling it and
  // calling loadMcp() forces the refetch; loadMcp re-checks isCurrentMount
  // itself and calls render(), so this is safe even if the user navigated
  // away while the wizard was open.
  const wizardBtn = document.getElementById('btn-mcp-wizard');
  if (wizardBtn) {
    const token = myMountToken;
    wizardBtn.addEventListener('click', () => openMcpWizard({
      onDone: () => {
        if (!isCurrentMount(token)) return;
        state.mcp = null;
        state.selfTest = null;
        // Re-focus the CTA after the refresh, not before. closeWizard()
        // restores focus to the launching button and then calls this, so
        // the re-render below replaces that node underneath the focus and
        // it falls back to <body> — measured in-browser. Looking the
        // button up again after the render is the only way to land back on
        // it. (No-op when the section has moved on; the button is gone.)
        loadMcp(token)
          .then(() => {
            if (!isCurrentMount(token)) return;
            document.getElementById('btn-mcp-wizard')?.focus();
          })
          .catch(reportAsyncActionFailure);
      },
    }));
  }

  const testBtn = document.getElementById('btn-mcp-self-test');
  if (testBtn) testBtn.addEventListener('click', () => onMcpSelfTest(myMountToken));
  const viewBtn = document.getElementById('btn-mcp-view-config');
  if (viewBtn) viewBtn.addEventListener('click', () => onMcpViewConfig(myMountToken));
  const copyBtn = document.getElementById('btn-mcp-copy-snippet');
  if (copyBtn) copyBtn.addEventListener('click', () => onMcpCopySnippet(myMountToken));
  const select = document.getElementById('select-default-domain');
  if (select) select.addEventListener('change', () => onSaveDefaultDomain(select.value, myMountToken));
}

function wireHealthListeners() {
  const saveBtn = document.getElementById('btn-save-scan-limits');
  if (saveBtn) saveBtn.addEventListener('click', () => onSaveScanLimits(myMountToken));
}

function wireStorageListeners() {
  const chooseBtn = document.getElementById('btn-choose-folder');
  if (chooseBtn) chooseBtn.addEventListener('click', () => onChooseFolder(myMountToken));
  const copyBtn = document.getElementById('btn-copy-path');
  if (copyBtn) copyBtn.addEventListener('click', () => onCopyPath(myMountToken));
}

// ── Actions ───────────────────────────────────────────────────────────────
// Every action below follows the SAME gating rule (see the file-header
// comment): `state` is reassigned wholesale on every mount, so busy-flag
// resets are GATED on isCurrentMount(token), never unconditional — a
// fresh mount already starts clean via freshState(), and an ungated reset
// would instead reach into the CURRENT mount's own state object.

// The verdict is rendered INLINE in the General section's "Software
// update" block (renderUpdateStatus). It used to be a window.alert, which
// is the browser's own chrome and — worse — meant `state.updateCheck` was
// written and then read by nothing at all: dismiss the alert and the
// answer was gone.
async function onCheckForUpdates(token) {
  state.updateChecking = true;
  state.updateError = null;
  // A fresh check supersedes a finished/failed install banner, but never an
  // in-flight one (the button is disabled while applying/restarting).
  if (state.updatePhase === 'failed' || state.updatePhase === 'done') state.updatePhase = 'idle';
  state.section = 'general'; // the sidebar footer button lands here
  render(token);
  try {
    const res = await fetch('/api/config/update-check');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.updateCheck = data.error ? { error: data.error } : data;

    // Re-read the running-vs-on-disk version, exactly as the shipping flow
    // does: it takes precedence over any remote comparison (see
    // classifyUpdate), and the cached copy from onEnter can be stale by now.
    // A failure here is non-critical — classifyUpdate treats an absent
    // versionInfo as "nothing known", which is the pre-existing behaviour.
    try {
      const vr = await fetch('/api/version');
      const vd = await vr.json();
      if (!isCurrentMount(token)) return;
      if (vd && typeof vd === 'object' && !vd.error) state.version = vd;
    } catch { /* non-critical */ }
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.updateCheck = { error: err.message };
  } finally {
    if (isCurrentMount(token)) { state.updateChecking = false; render(token); }
  }
}

// ── Applying an update ───────────────────────────────────────────────────
// Destructive: POST /api/config/update runs `git fetch` + `git reset --hard
// origin/main` + `npm install` against the live checkout, and the restart
// that follows kills this server process. It therefore goes through the
// shared confirm dialog — and, structurally, the work below can only ever
// be reached from that dialog's confirm button (see shared/confirm.js).

function onApplyUpdate(token) {
  const v = classifyUpdate(state.updateCheck, state.version);
  if (v.kind !== 'available') return Promise.resolve(); // the button only renders in this state
  const label = v.versionsDiffer ? 'v' + v.current + ' → v' + v.latest : 'v' + v.current + ' (newer commits)';
  return confirmThen({
    title: 'Install this update?',
    message: label,
    detail: 'The Curator will replace its own program files with the published version, reinstall dependencies and ' +
      'restart. Your knowledge base, API keys and sync settings are untouched. Don’t quit until it finishes.',
    confirmLabel: 'Install and restart',
    cancelLabel: 'Not now',
    tone: 'danger',
    onConfirm: () => runUpdate(token),
  });
}

async function runUpdate(token) {
  if (!isCurrentMount(token)) return;
  state.updatePhase = 'applying';
  state.updateError = null;
  state.updateResult = null;
  state.updateRestartHint = false;
  render(token);

  let data = null;
  try {
    const res = await fetch('/api/config/update', { method: 'POST' });
    data = await res.json();
    // A 409 from the write-registry guard arrives here as { error, conflict }
    // — the same shape every other refusal in this app uses.
    if (!res.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + res.status);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.updatePhase = 'failed';
    state.updateError = err.message || 'Unknown error';
    render(token);
    return;
  }

  if (!isCurrentMount(token)) return;
  // `partial: true` means git succeeded and `npm install` did not — the
  // documented shape for the "npm isn't on the running app's PATH" case,
  // which the pulled update itself fixes. Restarting is the right move;
  // the warning explains why to anyone reading it. Dropping this branch
  // would present a half-applied update as a clean one.
  state.updateResult = data;
  state.updatePhase = 'restarting';
  render(token);

  try { await fetch('/api/restart', { method: 'POST' }); } catch { /* the process is going away; a dropped response is expected */ }
  pollForRestart(token);
}

// Deliberately NOT awaited by runUpdate: the server is being replaced, so
// this outlives the request that started it. It reloads the page on
// success rather than touching state, so it does not need a mount guard
// for correctness — only for the "gave up" hint it renders.
function pollForRestart(token) {
  const started = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - started > 30000) {
      clearInterval(timer);
      if (!isCurrentMount(token)) return;
      state.updateRestartHint = true;
      render(token);
      return;
    }
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.ok) {
        clearInterval(timer);
        setTimeout(() => location.reload(), 500);
      }
    } catch { /* still down — keep polling */ }
  }, 1200);
}

// The `restartRequired` branch: the files on disk are ALREADY newer than
// the running process (a manual `git reset --hard`, or an update whose
// restart didn't take). Re-pulling would be pointless work against the
// live checkout — this only restarts.
function onRestartOnly(token) {
  return confirmThen({
    title: 'Restart The Curator?',
    message: 'The app will stop and start again to pick up the newer files already on disk.',
    detail: 'Anything mid-flight — an ingest, a sync — is interrupted. Nothing is downloaded or overwritten.',
    confirmLabel: 'Restart now',
    cancelLabel: 'Not now',
    tone: 'danger',
    onConfirm: async () => {
      if (!isCurrentMount(token)) return;
      state.updatePhase = 'restarting';
      state.updateResult = null;
      state.updateRestartHint = false;
      render(token);
      try { await fetch('/api/restart', { method: 'POST' }); } catch { /* expected */ }
      pollForRestart(token);
    },
  });
}

async function onRunQuickCheck(token) {
  state.quickLoading = true;
  render(token);
  try {
    const res = await fetch('/api/diagnostics/quick');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.quick = data.error ? { error: data.error } : data;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.quick = { error: err.message };
  } finally {
    if (isCurrentMount(token)) { state.quickLoading = false; render(token); }
  }
}

async function onVerifyAiConfirm(token) {
  state.liveLoading = true;
  render(token);
  try {
    const res = await fetch('/api/diagnostics/live', { method: 'POST' });
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.live = data;
    state.liveConfirmOpen = false;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.live = { ok: false, error: err.message };
    state.liveConfirmOpen = false;
  } finally {
    if (isCurrentMount(token)) { state.liveLoading = false; render(token); }
  }
}

// MEDIUM-1 fix (re-audit, third round): all three functions below used to
// call `await loadKeys(token)` unconditionally from a `finally` block. On
// the FAILURE path that ran right after the `catch` had just set
// `state.keysError` — and loadKeys() (see its own doc comment) sets
// `state.keysError = null` as part of a normal successful refresh, so the
// reload silently erased the very error it was supposed to show. Verified
// live: 500-ing only the POST while the GET still succeeded produced no
// visible error anywhere — the replace row just closed and the field kept
// reading "Not set", with nothing telling the user the save had failed.
// This is exactly the class of failure v3.1.0's path work exists to
// surface (a read-only config file, a failed 0600 chmod, disk full).
// Fixed by only reloading on the SUCCESS path (inside the `try`, after the
// request is confirmed ok) — the failure path sets the error and renders
// directly, with no reload to immediately erase it.
async function onSaveKey(provider, token) {
  // MEDIUM-2 fix: prefer the LIVE DOM value over state — same reasoning as
  // sync.js's onConnect (see its L3 comment): a password manager or browser
  // autofill can assign an input's `.value` directly without dispatching an
  // `input` event, so state.replaceValue (which only updates via that
  // event, see wireProviderListeners above) can lag behind what's actually
  // sitting in the field. Falling back to state covers the input somehow
  // not being in the DOM. Re-sync state from whichever source won so a
  // subsequent render (the error path below, or a gate-triggered one that
  // lands mid-request) reflects reality either way.
  const input = document.getElementById('replace-input-' + provider);
  const value = ((input ? input.value : state.replaceValue) || '').trim();
  state.replaceValue = value;
  if (!value) return;
  state.keysBusy = provider;
  state.keysActionError = null;
  render(token);
  try {
    // Keyed by provider via a lookup table, NOT a binary gemini/anthropic
    // ternary — the render-side half of this exact defect shape is fixed
    // above in renderProviderRow (see its KEY_INFO_BY_PROVIDER comment).
    // Here the stakes are worse: this branch WRITES. The old form
    // (`provider === 'gemini' ? A : B`) POSTed ANY third provider's key
    // under `anthropicApiKey`, which would silently OVERWRITE the user's
    // real Anthropic credential with a key for a different service —
    // credential corruption, not just a misleading render, on the one
    // screen where users hand us secrets. An id absent from this table
    // REFUSES to save (thrown, caught below, surfaced as an error) rather
    // than guessing a field: under-saving is recoverable; writing into the
    // wrong provider's slot may go unnoticed until that other service
    // starts failing.
    const SAVE_BODY_KEY_BY_PROVIDER = { gemini: 'geminiApiKey', anthropic: 'anthropicApiKey' };
    const bodyKey = SAVE_BODY_KEY_BY_PROVIDER[provider];
    if (!bodyKey) {
      throw new Error(`Cannot save a key for provider "${provider}" — no known credential field for it.`);
    }
    const body = { [bodyKey]: value };
    const res = await fetch('/api/config/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
    if (!isCurrentMount(token)) return;
    state.keysBusy = null;
    state.replacing = null;
    state.replaceValue = ''; // MEDIUM-2 fix: never let a saved secret linger in state past a successful save
    await loadKeys(token); // re-fetch to pick up the masked value + new active/model fields
  } catch (err) {
    if (isCurrentMount(token)) {
      state.keysBusy = null;
      state.keysActionError = err.message;
      render(token);
    }
  }
}

async function onDisconnect(provider, token) {
  state.keysBusy = provider;
  state.keysActionError = null;
  render(token);
  try {
    const res = await fetch('/api/config/api-keys/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Disconnect failed');
    if (!isCurrentMount(token)) return;
    state.keysBusy = null;
    await loadKeys(token);
  } catch (err) {
    if (isCurrentMount(token)) {
      state.keysBusy = null;
      state.keysActionError = err.message;
      render(token);
    }
  }
}

async function onSetActive(provider, token) {
  state.keysBusy = provider;
  state.keysActionError = null;
  render(token);
  try {
    const res = await fetch('/api/config/api-keys/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Could not switch provider');
    if (!isCurrentMount(token)) return;
    state.keysBusy = null;
    await loadKeys(token);
  } catch (err) {
    if (isCurrentMount(token)) {
      state.keysBusy = null;
      state.keysActionError = err.message;
      render(token);
    }
  }
}

/**
 * Compose the user-facing refusal for a failed model pick.
 *
 * SPLIT OUT so the 409 wording is one string with one owner. The route's own
 * message already names the running operation ("…while a write operation is
 * running: articles (ingest)"), which is better information than anything
 * this file could invent, so it is used verbatim where present — but it stops
 * short of the fact the user most needs, which is that NOTHING CHANGED. A
 * refusal that only says "try again later" leaves them unsure whether the
 * click half-applied, and the observed consequence of an ambiguous refusal on
 * a write is a retry (v3.6.0). The fallbacks exist because a 409 can also
 * arrive from a proxy or a non-JSON body, and a blank error box is the
 * invisible-refusal failure again in a smaller font.
 */
function modelPickErrorMessage(status, data) {
  const fromServer = (data && typeof data.error === 'string' && data.error.trim())
    ? data.error.trim()
    : '';
  const isConflict = status === 409 || (data && data.conflict === 'write_in_progress');
  if (isConflict) {
    const base = fromServer ||
      'Cannot change the AI model while a write operation is running.';
    return base + ' Your model choice was NOT saved — the model is unchanged. ' +
      'Changing it mid-run would plan on one model and write on another.';
  }
  return fromServer || 'Could not save that model choice — the model is unchanged.';
}

/**
 * Persist one provider's model choice. `modelId` of '' CLEARS it.
 *
 * The invariant this function exists to hold: the UI does not show the new
 * model as in force until the server says it is. There is no optimistic
 * write into state.keys anywhere below — the only thing that moves the
 * rendered selection is loadKeys(), on the success path, after `res.ok`. On
 * every failure path state.keys is untouched, so the previous selection is
 * still what renders. That is the whole reason this is not "set it, then
 * revert on error": a revert is a second code path that can be forgotten,
 * and the window in between is a lie about money.
 */
async function onPickModel(provider, modelId, token) {
  // Same refuse-rather-than-guess rule as onSaveKey's SAVE_BODY_KEY_BY_PROVIDER:
  // an id we do not recognise must not be POSTed. Under-writing is
  // recoverable; writing a selection into some other provider's slot is not
  // noticed until that provider starts billing differently.
  const KNOWN = { gemini: true, anthropic: true };
  const model = typeof modelId === 'string' ? modelId : '';
  if (!KNOWN[provider]) {
    state.modelPickError = Object.assign({}, state.modelPickError, {
      [provider]: 'Cannot choose a model for an unknown provider.',
    });
    render(token);
    return;
  }
  state.modelPickBusy = provider + '::' + model;
  // Clear only THIS provider's stale refusal. A per-provider map rather than
  // one shared string, so a refusal on Anthropic does not silently vanish
  // because the user then clicked something under Gemini.
  state.modelPickError = Object.assign({}, state.modelPickError, { [provider]: '' });
  render(token);
  try {
    const res = await fetch('/api/config/api-keys/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    if (!res.ok) {
      // Read the body defensively: a 409 from a proxy, or any non-JSON
      // response, must still produce a legible refusal rather than an
      // "Unexpected token '<'" — the class this repo has fixed twice
      // (v2.3.3, v3.6.0) by never putting `await res.json()` inside a throw.
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      const message = modelPickErrorMessage(res.status, data);
      if (!isCurrentMount(token)) return;
      state.modelPickBusy = null;
      state.modelPickError = Object.assign({}, state.modelPickError, { [provider]: message });
      render(token);
      return;
    }
    if (!isCurrentMount(token)) return;
    state.modelPickBusy = null;
    // The ONLY place the rendered selection moves. Refetching (rather than
    // trusting the POST's echo) also picks up `models[provider]`, i.e. what
    // llm.js will now actually resolve — which is not necessarily the id we
    // just sent, and the header claims to show the truth.
    await loadKeys(token);
  } catch (err) {
    if (isCurrentMount(token)) {
      state.modelPickBusy = null;
      state.modelPickError = Object.assign({}, state.modelPickError, {
        [provider]: modelPickErrorMessage(0, { error: err && err.message }),
      });
      render(token);
    }
  }
}

async function onMcpSelfTest(token) {
  state.selfTestLoading = true;
  render(token);
  try {
    const res = await fetch('/api/mcp/self-test', { method: 'POST' });
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.selfTest = data;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.selfTest = { ok: false, error: err.message };
  } finally {
    if (isCurrentMount(token)) { state.selfTestLoading = false; render(token); }
  }
}

async function onMcpViewConfig(token) {
  if (state.configSnippetOpen) { state.configSnippetOpen = false; render(token); return; }
  try {
    const res = await fetch('/api/mcp/claude-config');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.configSnippet = data;
    state.configSnippetOpen = true;
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.mcpError = err.message;
  }
  if (isCurrentMount(token)) render(token);
}

async function onMcpCopySnippet(token) {
  try {
    const res = await fetch('/api/mcp/claude-config');
    const data = await res.json();
    const text = JSON.stringify(data, null, 2);
    await copyToClipboard(text);
    if (!isCurrentMount(token)) return;
    state.copyFeedback = 'copied';
  } catch {
    if (!isCurrentMount(token)) return;
    state.copyFeedback = 'copy failed';
  }
  if (!isCurrentMount(token)) return;
  render(token);
  setTimeout(() => { if (isCurrentMount(token)) { state.copyFeedback = null; render(token); } }, 2000);
}

async function onSaveDefaultDomain(value, token) {
  state.defaultDomainSaving = true;
  render(token);
  try {
    const res = await fetch('/api/config/default-domain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultDomain: value || null }),
    });
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    if (state.defaultDomainInfo) state.defaultDomainInfo.defaultDomain = data.defaultDomain;
  } catch (err) {
    if (isCurrentMount(token)) state.mcpError = err.message;
  } finally {
    if (isCurrentMount(token)) { state.defaultDomainSaving = false; render(token); }
  }
}

async function onSaveScanLimits(token) {
  // NIT fix (re-audit, third round): reading `.value` with no guard sent
  // `NaN` for an empty/missing field — JSON.stringify turns NaN into
  // `null`, so a blank input silently became a request to clear the
  // limit rather than a validation error the user could see and fix.
  const costInput = document.getElementById('input-cost-ceiling');
  const pairsInput = document.getElementById('input-max-pairs');
  const costCeilingTokens = costInput ? parseInt(costInput.value, 10) : NaN;
  const semanticDupeMaxPairs = pairsInput ? parseInt(pairsInput.value, 10) : NaN;
  if (!Number.isFinite(costCeilingTokens) || !Number.isFinite(semanticDupeMaxPairs)) {
    state.scanLimitsValidationError = 'Both fields are required and must be numbers.';
    render(token);
    return;
  }
  state.scanLimitsValidationError = null;
  state.aiHealthSaving = true;
  state.aiHealthSaved = false;
  render(token);
  try {
    const res = await fetch('/api/health/ai-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ costCeilingTokens, semanticDupeMaxPairs }),
    });
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.aiHealth = data;
    state.costCeilingInput = String(data.costCeilingTokens);
    state.maxPairsInput = String(data.semanticDupeMaxPairs);
    state.aiHealthSaved = true;
  } catch (err) {
    if (isCurrentMount(token)) state.aiHealthError = err.message;
  } finally {
    if (isCurrentMount(token)) { state.aiHealthSaving = false; render(token); }
  }
}

async function onChooseFolder(token) {
  // Opens a native, BLOCKING Finder dialog via osascript on the server's
  // machine. Deliberately not exercised by automated browser verification
  // for this view (see this session's report) — it's a real OS-level
  // picker, not something a headless click can drive or safely dismiss.
  state.pickingFolder = true;
  render(token);
  try {
    const res = await fetch('/api/config/pick-folder', { method: 'POST' });
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    if (data.cancelled) { /* user hit Cancel in Finder — nothing to do */ }
    else if (data.error) { state.configError = data.error; }
    else { await loadConfig(token); }
  } catch (err) {
    if (isCurrentMount(token)) state.configError = err.message;
  } finally {
    if (isCurrentMount(token)) { state.pickingFolder = false; render(token); }
  }
}

async function onCopyPath(token) {
  if (!state.config) return;
  try {
    await copyToClipboard(state.config.domainsPath);
    if (isCurrentMount(token)) state.pathCopyFeedback = 'copied';
  } catch {
    if (isCurrentMount(token)) state.pathCopyFeedback = 'copy failed';
  }
  if (!isCurrentMount(token)) return;
  render(token);
  setTimeout(() => { if (isCurrentMount(token)) { state.pathCopyFeedback = null; render(token); } }, 2000);
}

async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for contexts without the async clipboard API.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
}
