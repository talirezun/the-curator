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
  preserveMainScroll, resetMainScroll,
  currentFontScale, fontScaleOptions, setFontScale,
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
import { formatModelSummary } from '../shared/model-summary.js';

const SETTINGS_SECTIONS = [
  ['general',   'General',              'Appearance, updates'],
  ['providers', 'Providers & keys',     'Gemini, Anthropic, OpenRouter, local'],
  ['mcp',       'MCP bridge',           'My Curator, default write domain'],
  ['health',    'Health & scan limits', 'Cost ceilings, candidate pairs'],
  ['storage',   'Knowledge base',       'Vault folder, Obsidian'],
];

const SECTION_TITLES = Object.fromEntries(SETTINGS_SECTIONS.map(([id, label]) => [id, label]));

// ── Provider display metadata — 3 of these actually run. The remaining one
// is rendered clearly inert (see honesty note above). ────────────────────
//
// v3.15.0: OPENAI WAS REMOVED, NOT FLIPPED. It shipped as a permanently
// disabled row reading "not available in this build" — a promise of a
// provider nobody was building. The maintainer has ruled OpenAI out, so the
// honest thing is to stop advertising it rather than leave a row implying it
// is queued. OpenRouter reaches most OpenAI models anyway, which is a large
// part of why it is the one that landed.
//
// `local` STAYS inert: the OpenRouter adapter is OpenAI-wire-compatible, so
// the same adapter serves a local runtime (Ollama, llama.cpp, LM Studio) once
// there is a base-URL setting to point it at. That row is a real slot with a
// real path to being filled, not a placeholder.
const PROVIDER_ROWS = [
  { id: 'gemini',     name: 'Gemini',      dot: 'var(--type-entity)',  available: true  },
  { id: 'anthropic',  name: 'Anthropic',   dot: 'var(--type-summary)', available: true  },
  { id: 'openrouter', name: 'OpenRouter',  dot: 'var(--accent)',       available: true  },
  { id: 'local',      name: 'Local model', dot: 'var(--text-faint)',   available: false },
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

// Brand capitalisation, deliberately NOT derived from the field names. The
// wire carries `hasOpenrouterKey` / `openrouterApiKey` with a lowercase r,
// because those are mechanical `has<Provider>Key` derivations of the id — but
// the company writes it OpenRouter, and a credentials screen that renders a
// vendor's name wrong is a small, avoidable credibility cost. The id stays
// `openrouter` everywhere it is a key; only the human-readable string differs.
function providerLabel(id) {
  if (id === 'gemini') return 'Gemini';
  if (id === 'anthropic') return 'Anthropic';
  if (id === 'openrouter') return 'OpenRouter';
  return (typeof id === 'string' && id) ? id : null;
}

/**
 * ── Why the Active row did not move ───────────────────────────────────────
 *
 * `POST /api/config/api-keys` returns `skippedActivation` — a usually-empty
 * array of `{ provider, reason }` naming keys that were SAVED but did NOT
 * become active. Until this was written, `grep -rn "skippedActivation"
 * src/public/` returned ZERO hits: computed in brain/config.js, gated in
 * routes/config.js, serialised on the wire, and read by nobody. That is this
 * repo's named dead-data shape, and the fifth instance of it (v3.6.1 finding
 * 5; v3.9.0 findings 7 and 17; v3.9.1 finding 9).
 *
 * It is not cosmetic. Saving a key normally makes that provider active
 * ("last-saved-wins", v2.4.2). A provider with no build-lane model cannot be
 * activated — doing so threw on the next ingest, Health scan and Compile with
 * NOTHING on screen saying why, which is the v3.15.0 P0 the refusal exists to
 * prevent. The design deliberately chose "annoying but visible" over "silently
 * broken". With no reader it degrades to annoying and UNEXPLAINED: the user
 * saves a key, the Active row does not move, and nothing accounts for it —
 * which reads as the app ignoring the click, i.e. most of the way back to the
 * defect.
 *
 * REASON-DRIVEN, NOT PROVIDER-DRIVEN. There is no `id === 'openrouter'`
 * anywhere below, deliberately: the render-half of exactly that shape is the
 * v3.10.1 defect (a binary provider ternary that showed one provider's
 * credential state under another provider's name). A fourth provider must
 * inherit this surface without anyone editing it.
 *
 * An UNKNOWN reason code renders the FACT and omits the why, rather than
 * defaulting into the one explanation we happen to know today — same fail-safe
 * direction as providerLabel above, which echoes an unrecognised id instead of
 * substituting another provider's name.
 */
const ACTIVATION_SKIP_REASONS = Object.assign(Object.create(null), {
  // The backend's own words for this code are "that provider has no build-lane
  // model yet". Rendered in the user's terms — no model id, no date, and no
  // claim about price, rate limits or what the provider can do elsewhere,
  // because none of that is what the field reports.
  no_build_model: 'it has no model available for building your wiki yet',
});

/**
 * ABSENT is not EMPTY, and the difference is load-bearing.
 *
 *   `[]`      the server TOLD US nothing was skipped -> we may be silent with
 *             confidence.
 *   absent    the server told us NOTHING — an older backend, or a body we
 *             could not parse. Concluding "nothing was skipped" from silence
 *             invents a fact we were never given.
 *
 * Returns an array (possibly empty) when the field was actually reported, and
 * `null` when it was not. A non-array value counts as not reported: we were
 * sent something, but nothing we can read.
 */
function readSkippedActivation(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Object.hasOwn(payload, 'skippedActivation')) return null;
  const v = payload.skippedActivation;
  if (!Array.isArray(v)) return null;
  return v.filter((e) => e && typeof e === 'object');
}

/**
 * The whole decision, as one pure function — DOM-free and fetch-free, for the
 * same reason classifyUpdate() above is.
 *
 *   savedProvider  the provider whose key this save carried
 *   payload        the parsed POST response, or null if it could not be read
 *
 * Three outcomes:
 *   silent      say nothing.
 *   skipped     the server named what it skipped. Explain it.
 *   unreported  the field was absent AND the response's own `activeProvider`
 *               shows the row did not move. State the fact, claim no reason.
 *
 * The `unreported` arm is gated on POSITIVE evidence of non-activation, never
 * on the absence of evidence: if `activeProvider` could not be read either, we
 * know nothing about the outcome and therefore say nothing. Announcing "it did
 * not become active" off an unparseable body would be the same invented fact in
 * the other direction.
 */
function classifyActivationOutcome(payload, savedProvider) {
  const skipped = readSkippedActivation(payload);
  if (skipped === null) {
    const after = payload && typeof payload.activeProvider === 'string' ? payload.activeProvider : null;
    return (after && savedProvider && after !== savedProvider)
      ? { kind: 'unreported', provider: savedProvider }
      : { kind: 'silent' };
  }
  return skipped.length ? { kind: 'skipped', entries: skipped } : { kind: 'silent' };
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
    // Which INDIVIDUAL model rows are expanded, by model id. Same reason as
    // modelPickerOpen above, one level down, and it was missing.
    //
    // MEASURED, not assumed. A row's `<details>` used to derive `open` solely
    // from "is this the model being qualified", so every OTHER expanded row
    // snapped shut on every repaint — and this list repaints on a keystroke
    // in the search box, on the sort, on the measured-only toggle, on a key
    // save, and on the cross-view write gate firing because an ingest started
    // somewhere else. That is the reported "it throws me back up the page":
    // rows collapsing makes the document SHORTER, and a shorter document is
    // the one condition under which the browser clamps the scroll container.
    // (Browser-measured: an innerHTML swap alone does NOT move scrollTop while
    // the offset still fits — so preserving the offset cannot fix this on its
    // own, and the fold state is the actual root cause.)
    modelRowOpen: {},
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
    // Per-provider model filter, SESSION ONLY. Reset by freshState on every
    // onEnter and written to no storage — a filter that survived a reload would
    // make a user's next visit mysteriously show a subset of their models.
    modelFilter: {},
    // ── "Test this key" (v3.15.0, OpenRouter only) ────────────────────────
    // Which provider's key check is in flight, or null. Separate from
    // `keysBusy` on purpose: keysBusy gates the MUTATING controls (save,
    // disconnect, set-active) and a read-only key check must not disable
    // them, nor be disabled by the cross-view write gate. Nothing is written
    // by this request — not to config, not to the wiki — so there is nothing
    // for a concurrent ingest to be protected from.
    keyTestBusy: null,
    // ── Catalogue sync (v3.15.2, OpenRouter only) ─────────────────────────
    // Which provider's catalogue refresh is in flight, or null. A SEPARATE
    // field from keysBusy and keyTestBusy, for the same reason those two are
    // separate from each other: they gate different controls, and one shared
    // "busy" would disable a button for a request that has nothing to do
    // with it.
    catalogueSyncBusy: null,
    // The last SUCCESSFUL sync, keyed by provider:
    // { syncedAt, total, eligible, admitted, refused }. Written ONLY on the
    // success path. Per provider rather than one shared object so a result
    // under one provider can never be read as belonging to another — the
    // same rule modelPickError and keyTest already follow.
    catalogueSync: {},
    // A sync refusal, keyed by provider. Rendered with role="alert" directly
    // beneath the button that produced it, which is the surface the user was
    // looking at. v3.6.0's finding: a refusal rendered where the user is not
    // looking reads as "my click didn't register", and the observed next
    // action is a retry.
    catalogueSyncError: {},
    // The last verdict, keyed by provider: { <provider>: <route payload> }.
    // Held per provider rather than as one shared object so a result under
    // one provider cannot be read as belonging to another — the same reason
    // modelPickError is a map. Cleared on mount with the rest of state, so a
    // verdict never outlives the key it was about across a navigate-away.
    keyTest: {},
    keys: null,             // GET /api/config/api-keys response
    keysError: null,        // the section FAILED TO LOAD — renderProviders shows this INSTEAD of the list (state.keys is also null in this case, so there's nothing to show anyway)
    keysActionError: null,  // a save/disconnect/set-active ACTION failed — rendered INLINE, list stays visible (found live while verifying MEDIUM-1: reusing keysError here hid the entire provider list — including the Cancel button — behind a bare error message the instant a save failed)
    // The last save SUCCEEDED but the Active row did not move — the
    // classifyActivationOutcome() verdict, or null. Deliberately NOT reusing
    // keysActionError: this is not a failure, and rendering it in the danger
    // style would tell a user whose key saved fine that something broke.
    // Cleared at the START of every key action, so a notice can never outlive
    // the save it explains — and reset with the rest of state on every
    // onEnter, so it cannot survive a navigate-away either.
    keysActivationNotice: null,
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

    // ── ON-WIKI MODEL QUALIFICATION ────────────────────────────────────────
    // One panel at a time, keyed by model id. `phase` is the only thing that
    // decides what renders, so there is no combination of flags that can show
    // a confirm and a progress bar at once.
    //   'estimating' -> asking the server what a run would cost
    //   'confirm'    -> the estimate is on screen, nothing has been spent
    //   'running'    -> the SSE stream is live; Stop is the only control
    //   'done'       -> the record is in; the panel shows what was observed
    qualify: null,          // {modelId, phase, estimate, runs:[], record, stored, qualifies, error}
    // The live AbortController for a running probe. Aborting it closes the SSE
    // connection, which is what the server reads as the cancel — there is no
    // separate cancel endpoint and therefore no run id to get wrong.
    qualifyAbort: null,

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

/**
 * THE ONE re-render chokepoint for this view — roughly forty call sites
 * reach it, from every section.
 *
 * IT PRESERVES READING POSITION, AND THE FIX IS HERE RATHER THAN AT THE TWO
 * HANDLERS THAT WERE REPORTED. The report was "Test on my wiki throws me
 * back to the top, and so does Start". Those two handlers are not special:
 * setMain() replaces #view-root wholesale, `.main` is the scroll container,
 * so EVERY render() from a scrolled position did this — saving a key,
 * disconnecting a provider, activating one, expanding a model row, running
 * the system check, opening the live-cost confirm. Two of those are further
 * down the page than the qualify panel is. Patching the two reported
 * handlers would have closed the report and left the class open, which is
 * this repo's most-recorded failure shape, so this wraps the chokepoint.
 *
 * The counterpart is in wireGlobalListeners(): a SECTION CHANGE explicitly
 * resets to the top, because that is a new destination and preserving an
 * offset into it would drop the user into the middle of a page they have
 * not seen.
 *
 * The fold state was never the problem and is untouched — state.modelPickerOpen
 * already survived every one of these renders correctly. The section stayed
 * open the whole time; it was simply scrolled off the top of the viewport,
 * which is indistinguishable from having been closed.
 */
function render(token) {
  preserveMainScroll(() => {
    renderSidebar(token);
    renderMain(token);
    wireGlobalListeners();
  });
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

      // Text size. Sits directly under Appearance because it is the same
      // KIND of setting — how the app looks on this screen — and it uses the
      // same segmented control for the same reason.
      //
      // NO SEPARATE PREVIEW, deliberately: the change applies to the whole
      // app in the same frame, including to this control and the label above
      // it, so the app IS the preview. A row of sample text next to it would
      // be a second thing to read that says less than the real one.
      renderTextSize() +

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

/**
 * Text size — one app-wide scale over the type ramp.
 *
 * The presets and their numbers live in app.js (fontScaleOptions), NOT here:
 * this view renders whatever the shell offers, so adding or re-tuning a
 * preset is one edit in one file and cannot leave a control listing an
 * option the shell does not know. The hint under each name is the trade
 * being made, in the user's terms — this setting exists to spend screen
 * space on legibility, and saying which direction each option goes is the
 * whole point of naming them rather than showing percentages.
 *
 * `currentFontScale()` is the shell's, not a local copy, so the active
 * marking is right on the first render after a reload with no extra load.
 */
function renderTextSize() {
  const active = currentFontScale();
  const buttons = fontScaleOptions().map(([id, label, hint]) => (
    '<button type="button" class="theme-seg-btn fs-seg-btn' + (id === active ? ' active' : '') + '"' +
      ' data-font-scale="' + escapeHtml(id) + '"' +
      ' aria-pressed="' + (id === active ? 'true' : 'false') + '"' +
      ' title="' + escapeHtml(hint) + '">' + escapeHtml(label) + '</button>'
  )).join('');

  return (
    '<div class="settings-field-block">' +
      '<span class="settings-field-label">Text size</span>' +
      '<p class="settings-hint-text">Scales every piece of text in the app. Larger is easier to read; ' +
      'smaller fits more on screen. Icons, controls and the layout keep their size, so this trades ' +
      'density for legibility rather than zooming the whole window — your browser’s own zoom still ' +
      'does that. Saved in this browser, and it applies straight away.</p>' +
      '<div class="theme-segmented fs-segmented" role="group" aria-label="Text size">' + buttons + '</div>' +
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
    return '<p class="view-body">At least one key is required. One provider is <strong>active</strong>: its model builds your ' +
      'wiki (ingest, Health scans and Compile). Every provider with a key stays available in the chat model picker.</p>' +
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
  // The catalogue-refresh control sits BETWEEN the row and the picker, as a
  // SIBLING of the picker's <details> — never inside its <summary>. That is
  // the v3.13.0 structural fix rather than the v3.0.1-beta.18 workaround: an
  // interactive control inside a <summary> toggles its own section when
  // clicked, and the answer there was preventDefault + stopPropagation, two
  // calls a later edit can drop. A sibling has no propagation path to
  // suppress, so there is nothing to forget.
  //
  // It is also OUTSIDE the collapsed picker deliberately. The picker is
  // collapsed by default, so a Sync button inside its body would be
  // unreachable until the user expanded a list they have no reason to expand
  // — and the refusal it can produce would land inside a section that may not
  // be open at all.
  const rows = PROVIDER_ROWS.map((p) =>
    renderProviderRow(p, k, crossBusy) +
    renderCatalogueSync(p, k, crossBusy) +
    renderModelPicker(p, k, state.modelPickerOpen[p.id] === true, crossBusy)).join('');

  return (
    '<p class="view-body">At least one key is required. One provider is <strong>active</strong>: its model builds your ' +
    'wiki (ingest, Health scans and Compile). Every provider with a key stays available in the chat model picker.</p>' +
    renderCrossWriteBanner('wait for it to finish before changing keys or the active provider — it may be mid-call.') +
    (state.keysActionError ? '<div class="settings-inline-error">' + escapeHtml(state.keysActionError) + '</div>' : '') +
    // Deliberately ABOVE the provider list and never behind a disclosure:
    // a fallback is a silent change to what the user is billed, so it has
    // to be unmissable on the section that owns providers.
    renderFallbackBanner(k.fallback) +
    // Directly above the Active line, because it exists to explain why that
    // line reads what it reads. Below the fallback banner, which is a money
    // warning and keeps the top slot.
    renderActivationNotice(state.keysActivationNotice) +
    renderActiveModelLine(k) +
    '<div class="provider-row-list">' + rows + '</div>' +
    '<div class="settings-note-row">' +
      icon('lockAlt', 15) +
      '<span>Keys live in <code class="mono">.curator-config.json</code> at 0600 on this machine. Never committed, ' +
      'never sent anywhere except the provider you call.</span>' +
    '</div>'
  );
}

/**
 * The `skippedActivation` surface — see classifyActivationOutcome above for
 * why it exists and why it is reason-driven rather than provider-driven.
 *
 * Leads with "Key saved" in both arms, because that is the part a user will
 * otherwise doubt: they typed a secret, pressed Save, and the screen did not
 * change in the way they expected. Telling them what DID happen comes before
 * telling them what did not.
 *
 * Every interpolated value — provider id and reason code alike — arrives over
 * the wire and goes through escapeHtml. The ids are ours today, but "the
 * payload is trustworthy" is not a property this function can verify, which is
 * the same rule renderFallbackBanner below states for itself.
 */
function renderActivationNotice(verdict) {
  if (!verdict || verdict.kind === 'silent') return '';

  let body;
  if (verdict.kind === 'unreported') {
    const name = providerLabel(verdict.provider);
    body = '<span>Your key was saved, but ' + (name ? '<strong>' + escapeHtml(name) + '</strong>' : 'that provider') +
      ' did not become the active provider, and this build did not report why. ' +
      'The provider marked Active is unchanged.</span>';
  } else {
    const lines = verdict.entries.map((e) => {
      const name = providerLabel(e.provider);
      const who = name ? '<strong>' + escapeHtml(name) + '</strong>' : 'That provider';
      // An unrecognised reason code renders the FACT with no explanation
      // rather than borrowing the one we happen to know — an invented "why"
      // on a credentials screen is worse than an acknowledged gap.
      const why = ACTIVATION_SKIP_REASONS[e.reason];
      return '<span>' + who + ' did not become the active provider' +
        (why ? ', because ' + escapeHtml(why) : '') + '. ' +
        'Ingest, Health scans and Compile keep running on the provider marked Active.</span>';
    }).join('');
    body = '<span><strong>Your key was saved</strong> — nothing was lost.</span>' + lines;
  }

  return '<div class="settings-activation-note">' + icon('alertTriangle', 15) +
    '<div class="settings-activation-note-body">' + body + '</div></div>';
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
  //
  // NULL-PROTOTYPE, and that is not tidiness. `p.id` is a string index into
  // this object, and on a plain object literal `KEY_INFO_BY_PROVIDER['constructor']`
  // returns Object.prototype's constructor — TRUTHY — so the `|| {}` guard
  // below would never fire and `keyInfo.field`/`.has` would read `undefined`
  // off a function. Harmless today because every id comes from the hardcoded
  // PROVIDER_ROWS table, but "fails SAFE for any id not in this table" is the
  // property the comment above CLAIMS, and on a plain literal that claim is
  // false for inherited names. chat.js's PROVIDER_LABELS and config.js's own
  // provider maps already use this form; this brings the credential surface
  // into line with them rather than leaving the weakest one on the screen
  // that hands out secrets.
  const KEY_INFO_BY_PROVIDER = Object.assign(Object.create(null), {
    gemini: { field: k.geminiApiKey, has: k.hasGeminiKey },
    anthropic: { field: k.anthropicApiKey, has: k.hasAnthropicKey },
    // v3.15.0. Note the wire field is `hasOpenrouterKey` — lowercase r —
    // because the route derives it mechanically from the provider id. It is
    // NOT `hasOpenRouterKey`; reading the wrong one resolves to `undefined`,
    // which fails safe as "not set" and would be invisible except that the
    // row would never show a saved key.
    openrouter: { field: k.openrouterApiKey, has: k.hasOpenrouterKey },
  });
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

  // ── "Test this key" — which providers can actually be tested ────────────
  // A LOOKUP, function-local, exactly like KEY_INFO_BY_PROVIDER above and for
  // the same two reasons: an id absent from it fails safe (no control), and
  // keeping it inside this function means no new module-level identifier
  // enters the sandbox that scripts/test-next-provider-rows.js builds by
  // extracting this function alone — a missing binding there is a CRASH, not
  // a failing assertion (the v3.11.0 FN_NAMES shape).
  //
  // WHY IT IS NOT EVERY PROVIDER. `POST /api/config/api-keys/validate` 400s
  // on anything but `openrouter`, and that is not an oversight: OpenRouter
  // publishes `GET /api/v1/key`, an authenticated endpoint that returns the
  // key's own limits and spends ZERO tokens. Gemini and Anthropic have no
  // equivalent, so the only way to check their keys is to make a real
  // (billable) call — which is what Settings' System Check already offers,
  // deliberately behind a cost-confirm. Offering an identical-looking
  // "Test this key" button beside all three, where one is free and two cost
  // money, would be the worse design. This table follows the route; when the
  // route learns another provider, add it here.
  const KEY_TEST_BY_PROVIDER = Object.assign(Object.create(null), {
    openrouter: true,
  });
  const canTestKey = KEY_TEST_BY_PROVIDER[p.id] === true;
  const testBusy = state.keyTestBusy === p.id;

  // ── A PROVIDER WITH NO DEFAULT MODEL CANNOT BE THE ACTIVE ONE ───────────
  // MEASURED, not assumed. With an OpenRouter-keyed config marked active,
  // `getProviderInfo()` THROWS ("No model is configured for OpenRouter"),
  // and it is the single producer of the provider/model pair that every
  // `generateText` call resolves — so ingest, Health scans and Compile all
  // fail. Offering a one-click "Set active" that breaks three features, on a
  // row whose state cell cheerfully reads "configured", is the worst control
  // on this screen.
  //
  // The test is `models[p.id]` — a PAYLOAD fact (null exactly when
  // DEFAULTS[provider] is null, i.e. when nothing has been measured for that
  // provider) — never `p.id === 'openrouter'`. A future provider in the same
  // position is covered with no edit here, and the day OpenRouter gains a
  // measured default the button appears on its own.
  //
  // Hiding a control is not a guarantee — it only stops the common case, so
  // the durable fix lives on the WRITE path, not in this render. It is there:
  // `setApiKeys` activates a newly-saved provider only if an injected
  // `canActivate` predicate affirms it can serve the build lane, and an ABSENT
  // predicate does not activate at all. `POST /api-keys/active` refuses with a
  // 400 carrying `reason: 'no_build_model'`.
  //
  // HISTORY, kept because the reasoning still governs this render: an earlier
  // draft of this comment said "saving an OpenRouter key sets it active
  // server-side without any click here". That was TRUE when it was written and
  // was a P0 — a working Gemini install broke silently on saving a second key,
  // because `getProviderInfo()` threw and the route swallowed it in a catch
  // commented "no key configured yet" while a key WAS configured. It is FALSE
  // now, and was verified false over real HTTP in the same release that wrote
  // it: the save returns `activeProvider: 'gemini'` with
  // `skippedActivation: [{ provider: 'openrouter', reason: 'no_build_model' }]`.
  // Do not restore the old claim; do not delete the render-side gate either —
  // two layers is the point.
  const canBuild = !!(k.models && typeof k.models[p.id] === 'string' && k.models[p.id]);

  const extraActions = [];
  // A keyed provider with NO resolvable model gets NO "Set active" button — see
  // `canBuild` above. That refusal is correct (activating it would hand ingest,
  // Health and Compile a provider with nothing to run them on — the v3.15.0 P0),
  // but ON ITS OWN IT IS SILENT: the maintainer saw the button present on two
  // providers, absent on the third, and had to ask why. A hidden control with no
  // stated reason reads as a missing feature, not as a safeguard. So say it where
  // the button would have been. Derived from `canBuild`, never from a provider id.
  if (hasKey && !isActive && !canBuild) {
    extraActions.push(
      '<span class="mono provider-state provider-state-muted" title="' +
      escapeHtml(p.name + ' has no models available in this build yet, so it cannot run ingest, Health scans or Compile. Your key is saved and this will change on its own once models are available.') +
      '">no models yet — cannot be active</span>'
    );
  }
  if (hasKey && !isActive && canBuild) {
    extraActions.push('<button type="button" class="btn btn-ghost btn-xs" data-set-active="' + p.id + '"' + (mutateDisabled ? ' disabled' : '') + crossTitleAttr + '>Set active</button>');
  }
  if (hasKey && canTestKey) {
    // Deliberately NOT gated on `crossBusy`. Every other control here is a
    // WRITE — a save or an active-provider switch lands in the config that
    // getProviderInfo() re-reads on every call, so one arriving mid-ingest
    // can change what the rest of that run costs. This request writes
    // nothing: it asks OpenRouter about a key we already hold and renders
    // the answer. Disabling a read-only diagnostic during a long ingest
    // would remove the tool at precisely the moment someone is most likely
    // to be asking "is my key the problem?".
    extraActions.push('<button type="button" class="btn btn-ghost btn-xs" data-test-key="' + p.id + '"' +
      (testBusy ? ' disabled' : '') + '>' + (testBusy ? 'Testing…' : 'Test this key') + '</button>');
  }
  if (hasKey) {
    extraActions.push('<button type="button" class="btn btn-ghost btn-xs" data-disconnect="' + p.id + '"' + (mutateDisabled ? ' disabled' : '') + crossTitleAttr + '>Disconnect</button>');
  }

  // ── The verdict, as three genuinely different states ────────────────────
  // `valid` is TRI-STATE on the wire: true / false / null. `null` means the
  // check could not be completed — rate-limited, OpenRouter 5xx, unreadable
  // body, or unreachable network. Collapsing that into "invalid" would tell
  // a user their key is bad when what actually happened is that we could not
  // ask, and the observed cost of that is someone revoking and regenerating
  // a perfectly good credential. So: pass / fail / could-not-check, never
  // two states.
  //
  // NUMBERS ARE RENDERED ONLY WHEN PRESENT. OpenRouter returns `limit: null`
  // to mean NO CAP; printing that as "0" would read as "exhausted", which is
  // the opposite fact. Same rule as v3.14.0's cost line: reported or absent,
  // never inferred. `typeof === 'number'` rather than truthiness, so a
  // genuine remaining balance of 0 — which IS exhausted — still prints.
  let testHtml = '';
  const tr = (state.keyTest && state.keyTest[p.id]) || null;
  if (canTestKey && tr && typeof tr === 'object') {
    const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
    const usd = (v) => '$' + (Math.round(v * 10000) / 10000);
    const facts = [];
    if (tr.isFreeTier === true) facts.push('free tier');
    else if (tr.isFreeTier === false) facts.push('paid tier');
    const used = num(tr.usage), lim = num(tr.limit), rem = num(tr.limitRemaining);
    if (used !== null) facts.push('used ' + usd(used));
    if (lim !== null) facts.push('limit ' + usd(lim));
    // `limit === null` is OpenRouter's "no cap on this key". Say so rather
    // than staying silent, because "no limit shown" and "no limit" look
    // identical on screen and only one of them is reassuring.
    //
    // NOT on the no_credits verdict, though — found by reading the rendered
    // output rather than the code. There, "no spending cap on this key" sits
    // directly beside the headline "Key accepted, but it cannot spend", and
    // the two read as contradicting each other. Both are true (there is no
    // CAP; there is no BALANCE) but the distinction is not worth making on a
    // line whose only job is reassurance, and the warning underneath already
    // states the real constraint.
    else if (tr.valid === true && tr.reason !== 'no_credits') facts.push('no spending cap on this key');
    if (rem !== null) facts.push(usd(rem) + ' remaining');

    let cls, head, detail;
    if (tr.valid === true && tr.reason === 'no_credits') {
      cls = 'provider-keytest-warn';
      // The route's own `warning` names the real condition (a negative
      // balance 402s even on free models). Used verbatim where present: it
      // is more specific than anything this view could compose.
      head = 'Key accepted, but it cannot spend';
      detail = typeof tr.warning === 'string' && tr.warning.trim() ? tr.warning.trim() : '';
    } else if (tr.valid === true) {
      cls = 'provider-keytest-ok';
      // "The key works" — NOT "OpenRouter works", and not "your setup
      // works". GET /api/v1/key authenticates the CREDENTIAL; it says
      // nothing about whether any particular model will serve a request.
      // The Curator sends `allow_fallbacks: false`, so a perfectly valid key
      // can still get a 503 when no provider meets the routing requirements.
      // A green tick that implied otherwise would send someone hunting for a
      // key problem that does not exist.
      head = 'Key accepted by OpenRouter';
      detail = 'This confirms the credential only. It does not check that any particular model ' +
        'will accept a request — The Curator asks for an exact model and never lets OpenRouter ' +
        'substitute one, so an individual model can still be unavailable.';
    } else if (tr.valid === false) {
      cls = 'provider-keytest-fail';
      head = 'OpenRouter rejected this key';
      detail = typeof tr.error === 'string' && tr.error.trim() ? tr.error.trim() : '';
    } else {
      cls = 'provider-keytest-unknown';
      head = 'Could not check this key';
      detail = (typeof tr.error === 'string' && tr.error.trim() ? tr.error.trim() + ' ' : '') +
        'This says nothing about whether the key is good — only that the check did not complete.';
    }

    testHtml = (
      '<div class="provider-keytest ' + cls + '" role="status" data-keytest="' + escapeHtml(String(p.id)) + '">' +
        '<span class="provider-keytest-head">' + escapeHtml(head) + '</span>' +
        (facts.length ? '<span class="mono provider-keytest-facts">' + escapeHtml(facts.join(' · ')) + '</span>' : '') +
        (detail ? '<span class="provider-keytest-detail">' + escapeHtml(detail) + '</span>' : '') +
      '</div>'
    );
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
        // This button only opens the input row locally — no network call — so it's deliberately NOT gated (see file-header comment).
        //
        // The LABEL is derived from whether a key exists, and that is a fix, not
        // decoration. The field beside it is a static <code> display, never an
        // input — you cannot type into it until this button swaps in the real
        // password field. That was invisible while every shipping provider
        // always had a key, because "Replace" reads as a sensible action on a
        // key you can see. OpenRouter is the first provider that starts EMPTY,
        // and the maintainer reported exactly the predictable outcome: he tried
        // to click and paste into the "Not set" box, and nothing happened —
        // because the only way in was a button labelled as if there were
        // something to replace. Derived from `hasKeyField`, so a fourth
        // provider needs no edit here.
        '<button type="button" class="btn btn-' + (hasKeyField ? 'secondary' : 'primary') + ' btn-xs" data-replace="' + p.id + '"' + (isBusy ? ' disabled' : '') + '>' + (hasKeyField ? 'Replace' : 'Add key') + '</button>' +
      '</div>'
    );
  }

  // The verdict is a SIBLING of the row, not a child of it. `.provider-row`
  // is a single-line flex strip sized for controls; folding a two-sentence
  // explanation into it would either clip the explanation or stretch every
  // other provider's row to match. Emitting it after the row also leaves the
  // row's own markup byte-identical when no test has been run, which is the
  // overwhelmingly common case and the one every existing assertion about
  // this function covers.
  return (
    '<div class="provider-row' + (isReplacing ? ' provider-row-replacing' : '') + '">' +
      '<span class="provider-dot" style="background:' + p.dot + '"></span>' +
      '<span class="provider-name-block">' +
        '<span class="provider-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="mono provider-model">' + escapeHtml(model) + '</span>' +
      '</span>' +
      fieldHtml +
    '</div>' +
    testHtml
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

/**
 * ── THE ONE PLACE A ROW'S LANE IS DECIDED ──────────────────────────────
 *
 * A model's LANE answers the only question this screen exists to answer: does
 * this model build my wiki? It has FOUR states, not two, because "can build"
 * and "measured by whom" are different facts that must stay visibly apart.
 *
 *   BUILD_MEASURED   hand-measured by The Curator across documents and shipped
 *                    in the static table (`suitability !== 'chat-only'`).
 *   BUILD_LOCAL      the USER measured it on their OWN wiki and it passed. It
 *                    still reports `suitability: 'chat-only'` on the wire —
 *                    deliberately; see the route's `qualifications` docblock —
 *                    so this state exists only by joining the record onto the
 *                    catalogue entry.
 *   CHAT_UNFIT       WE measured it and it failed (`jsonRaw` is a boolean).
 *   CHAT_UNMEASURED  nobody has measured it against our ingest prompt
 *                    (`jsonRaw === null`, legal only on a chat-only entry).
 *
 * ── WHY THIS FUNCTION EXISTS AT ALL ───────────────────────────────
 * FOUR independent expressions used to answer this question and only ONE of
 * them — the pick control — carried the `&& !locallyQualified` the other three
 * lacked. Observed live, and surviving a full reload: one row said, at once,
 *
 *     in use · your choice · you measured this on your wiki
 *     chat only — not for ingest
 *     note: "…never measured against The Curator's ingest prompt, so nothing
 *            here says how it would build a wiki."
 *
 * about the model that was building that user's wiki at that moment. On a
 * SPENDING surface whose entire purpose is saying what builds the wiki and
 * what it costs, a row that claims both leaves the question unanswerable. A
 * label disagreeing with its own behaviour is this repo's most reliable
 * early-warning shape (v3.13.1 found four docblocks doing it inside one file).
 *
 * THE DRIFT WAS THE BUG, NOT THE WORDING. So the lane is derived ONCE, here,
 * and the lane grouping, the chat-only badge, the note and the pick control
 * all read it. They can no longer come apart, because there is nothing left
 * for them to come apart from.
 *
 * MIRRORS `isBuildLaneModel` IN llm.js, WHICH REMAINS THE AUTHORITY. That is
 * two disjuncts — `suitability !== 'chat-only'` OR `isLocallyQualified` — and
 * this is the same two, with the second READ OFF THE WIRE rather than
 * recomputed: the route computes `qualifies` server-side from that very
 * predicate precisely so the client never owns a second copy of a
 * money-relevant rule. The four-way split adds only the DISPLAY distinctions
 * llm.js has no reason to carry.
 *
 * A NON-OBJECT RESOLVES TO BUILD_MEASURED, deliberately rather than
 * fail-closed: it keeps `renderModelLanes`' partition byte-identical for a
 * malformed entry, and `renderModelOption` early-returns on one before it can
 * render anything. Neither direction has a user-visible consequence; leaving
 * the partition unchanged does.
 */
const MODEL_LANES = Object.freeze({
  BUILD_MEASURED: 'build-measured',
  BUILD_LOCAL: 'build-local',
  CHAT_UNFIT: 'chat-unfit',
  CHAT_UNMEASURED: 'chat-unmeasured',
});

/** The qualification record for one model, or null.
 *
 *  Read through `Object.hasOwn` against the null-prototype map
 *  `renderModelPicker` builds, so an id of `constructor` or `__proto__` cannot
 *  resolve through the prototype chain and hand a row a function where a
 *  record should be (the v3.0.9 shape — an OpenRouter id is a third party's
 *  string, not ours). Shared by every lane decision so two call sites cannot
 *  disagree about WHICH record a row is being judged against. */
function qualificationFor(ctx, m) {
  const quals = (ctx && ctx.quals) || null;
  const id = m && m.id;
  if (!quals || typeof id !== 'string') return null;
  return Object.hasOwn(quals, id) ? quals[id] : null;
}

/** The lane. See MODEL_LANES.
 *
 *  `qualifies` is tested with `=== true`, not for truthiness: the route sends a
 *  real boolean computed from `isLocallyQualified`, so anything else is a wire
 *  anomaly and must not promote a model into the lane that spends money. */
function modelLaneOf(m, qual) {
  if (!m || typeof m !== 'object' || m.suitability !== 'chat-only') {
    return MODEL_LANES.BUILD_MEASURED;
  }
  if (qual && qual.qualifies === true) return MODEL_LANES.BUILD_LOCAL;
  return m.jsonRaw === null ? MODEL_LANES.CHAT_UNMEASURED : MODEL_LANES.CHAT_UNFIT;
}

/** Does this lane build the wiki? The one predicate behind the lane grouping,
 *  the chat-only badge and the pick control — the three surfaces that used to
 *  hold three separate opinions. */
function laneBuildsWiki(lane) {
  return lane === MODEL_LANES.BUILD_MEASURED || lane === MODEL_LANES.BUILD_LOCAL;
}

/** Split on a period followed by whitespace or end-of-string.
 *
 *  Hand-rolled rather than a lookbehind regex so it carries no assumption
 *  about the engine, and deliberately dumb: these notes are generated prose
 *  with no decimals and no abbreviations. */
function splitSentences(text) {
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    buf += text[i];
    if (text[i] === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * A catalogue note with any sentence making an overturned LANE claim removed.
 *
 * A fetched OpenRouter entry's note ends with "Chat only — never measured
 * against The Curator's ingest prompt, so nothing here says how it would build
 * a wiki." That is TRUE when written and FALSE the moment the user measures the
 * model on their own wiki — at which point the row carried a passing
 * measurement and a denial that any measurement existed, three lines apart.
 *
 * SURGICAL, NOT A BLANKET SUPPRESSION. The same note carries facts a local run
 * does not touch and a spender needs: that a free id is gated by the account's
 * data policy and some ids are refused account-wide, and that a model spends
 * hidden reasoning tokens BILLED AS OUTPUT. Dropping the whole note to remove
 * one sentence would trade a contradiction for a money omission.
 *
 * ── NOT ENFORCED, named rather than implied away ─────────────────────
 * The markers duplicate wording that lives in `src/brain/openrouter-adapter.js`,
 * which this browser module cannot import. A reword there would silently stop
 * this filter firing. That drift is converted into a TEST FAILURE rather than
 * left to chance: the picker suite mints a note through the REAL adapter path
 * and asserts, as a POSITIVE CONTROL, that the unfiltered note DOES contain a
 * marker — so a reword goes red here instead of re-shipping the contradiction.
 *
 * It deliberately does NOT strip a note that argues for chat-only on PRICE
 * grounds (`tiered: true` — "its published rate CHANGES above a prompt-size
 * threshold"). No tiered model is admitted today, and that sentence is a live
 * warning about money rather than a claim about measurement, so deleting it
 * would be the worse trade.
 */
function withoutLaneClaim(note) {
  if (typeof note !== 'string' || !note) return '';
  const MARKERS = ['never measured against', 'nothing here says how it would build'];
  const kept = splitSentences(note).filter((sentence) => {
    const t = sentence.toLowerCase();
    for (let i = 0; i < MARKERS.length; i++) if (t.includes(MARKERS[i])) return false;
    return true;
  });
  return kept.join(' ').trim();
}

/**
 * How many chat-only models it takes before that group folds behind a
 * disclosure. See renderModelLanes.
 *
 * DERIVED FROM LAYOUT, not from a provider. A model row is ~46px unexpanded,
 * so eight of them is roughly one screen inside the picker's own scroll
 * region — the point past which the group stops being a list you skim and
 * starts being one that buries whatever follows it. Below it, folding costs a
 * click and hides nothing worth hiding. It is not a capability threshold and
 * must never become one: what a model may be used for is decided by
 * `suitability`, never by how many of its neighbours there are.
 */
const CHAT_LANE_COLLAPSE_AT = 8;

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
 * An ISO INSTANT (a full timestamp, e.g. '2026-08-28T14:32:11.004Z') as
 * '28 Aug 2026, 14:32' in the VIEWER'S OWN ZONE. Returns '' on anything it
 * cannot parse, so a caller renders no timestamp rather than a raw ISO string
 * — a machine-readable instant printed at a user is not a date, it is a leak
 * of the wire format.
 *
 * ── WHY THIS CONVERTS TO LOCAL TIME AND formatIsoDay DELIBERATELY DOES NOT ──
 * Stated here because the two functions sit next to each other and look like
 * they disagree, and the next reader will otherwise "fix" one to match.
 * `formatIsoDay` receives a DATE-ONLY string ('2027-01-01') naming the day a
 * PRICE changes. That day is the same day everywhere; running it through
 * `new Date()` reads it as UTC midnight and then re-renders it in the
 * viewer's zone, so anyone west of Greenwich is told the rise lands on 31 Dec
 * — an off-by-one lie about money. This function receives an INSTANT, which
 * is a real point in time with a zone attached, and "when did this last
 * refresh" is a question about the user's own clock. Converting is correct
 * here and wrong there.
 *
 * Composed by hand from the local components rather than via
 * `toLocaleString`, for the same reason `formatTokenCount` avoids it: the
 * output must not change shape under a different locale, and this string sits
 * beside counts where a locale-swapped separator reads as a different number.
 */
function formatSyncedAt(iso) {
  if (typeof iso !== 'string' || !iso.trim()) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const two = (n) => (n < 10 ? '0' + n : String(n));
  return String(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() +
    ', ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

/**
 * ── THE CATALOGUE REFRESH CONTROL ────────────────────────────────────────
 *
 * Some providers publish a live model catalogue that MOVES — OpenRouter lists
 * hundreds of models and its free tier churns monthly — so the set a user can
 * reach is not a constant this app can ship. This is the control that fetches
 * it, and everything it renders exists to keep one distinction visible:
 *
 *   MEASURED BY US   models hand-probed against this repo's real ingest
 *                    outline prompt. These may build a wiki.
 *   FROM THE PROVIDER'S CATALOGUE
 *                    models admitted at runtime from a public listing. The
 *                    provider tells us what they COST; nobody has measured
 *                    whether they can do our JOB. Chat only.
 *
 * The second group can never reach the build lane, and that is STRUCTURAL,
 * not a promise made here: `defineOfferableModel` refuses a runtime-admitted
 * entry that declares anything but `suitability: 'chat-only'`, and
 * `POST /api/config/api-keys/model` refuses to pin a chat-only model as the
 * build model. This render is the third layer — it does not offer the control
 * at all — so a user never clicks something that comes back a 400.
 *
 * ── WHICH PROVIDERS GET IT: A LOOKUP, NEVER `p.id === 'openrouter'` ───────
 * Function-local and null-prototype, exactly like renderProviderRow's
 * KEY_TEST_BY_PROVIDER and for the same three reasons: an id absent from it
 * fails safe (no control at all), an inherited name like 'constructor' cannot
 * resolve truthy, and no new module-level identifier enters the sandbox that
 * scripts/test-next-model-picker.js builds by extraction — where a missing
 * binding is a CRASH rather than a failing assertion (the v3.11.0 FN_NAMES
 * shape). `POST /api/config/openrouter/sync` is the only such route today;
 * when a second provider grows one, add a line here.
 *
 * ── GATED ON THE SAVED KEY, second layer ─────────────────────────────────
 * The route requires a saved OpenRouter key, so a control offered without one
 * could only ever produce a refusal. Same config-scoped gate as
 * renderModelPicker (v3.0.13's rule), read from the payload's has-key flag.
 */
function renderCatalogueSync(p, k, crossBusy) {
  if (!p || !p.available || !k) return '';

  const SYNC_BY_PROVIDER = Object.assign(Object.create(null), { openrouter: true });
  if (SYNC_BY_PROVIDER[p.id] !== true) return '';

  const HAS_KEY_BY_PROVIDER = Object.assign(Object.create(null), {
    gemini: k.hasGeminiKey,
    anthropic: k.hasAnthropicKey,
    openrouter: k.hasOpenrouterKey,
  });
  if (!HAS_KEY_BY_PROVIDER[p.id]) return '';

  const busy = state.catalogueSyncBusy === p.id;
  // Gated on crossBusy for the same reason the model pick is: the route
  // carries guardConcurrent and 409s while any write is running, because
  // replacing the catalogue mid-run can pull the model an in-flight job is
  // resolving. The 409 is the real guarantee; this is the layer that stops
  // the common case ever producing one.
  const disabled = busy || !!crossBusy || state.catalogueSyncBusy !== null;
  const crossTitleAttr = (crossBusy && !busy)
    ? ' title="' + escapeHtml(crossWriteTitle('refreshing the model list mid-run could pull the model that run is using.')) + '"'
    : '';

  // ── WHEN THIS LIST WAS FETCHED — ONE SOURCE OF TRUTH, THE SERVER'S ─────
  // `GET /api/config/api-keys` carries `openrouterCatalogue: {syncedAt,
  // source, count}`, and the catalogue is persisted to disk and re-admitted
  // at boot — so that timestamp survives a browser reload AND an app restart.
  // It is therefore the PRIMARY source here, not the sync response held in
  // `state`: after a successful refresh `loadKeys` refetches anyway, so both
  // carry the same instant, and preferring the payload means there is exactly
  // one answer to "when" rather than two that can drift. The session record
  // is kept only for the COUNTS and the FUNNEL, which the payload does not
  // carry and which describe one particular refresh rather than the list.
  //
  // Read through a null-prototype lookup keyed by provider id, never
  // `p.id === 'openrouter'` — the v3.10.1 rule, and it is what lets a second
  // provider with a fetchable catalogue land here with one added line.
  const META_BY_PROVIDER = Object.assign(Object.create(null), {
    openrouter: k.openrouterCatalogue,
  });
  const meta = (META_BY_PROVIDER[p.id] && typeof META_BY_PROVIDER[p.id] === 'object')
    ? META_BY_PROVIDER[p.id] : null;

  const last = (state.catalogueSync && typeof state.catalogueSync[p.id] === 'object' && state.catalogueSync[p.id])
    ? state.catalogueSync[p.id] : null;

  // DEGRADED PATH, kept because it fails in the safe direction. An older
  // backend sends no meta at all; a fetched model is then identified by being
  // chat-only AND carrying `jsonRaw: null`, which llm.js documents as NOT
  // MEASURED and permits only on a chat-only entry (a hand-measured chat-only
  // model carries a BOOLEAN — gemini-3.5-flash-lite is `false`). The residual
  // gap is named rather than implied away: a future hand-typed chat-only
  // entry that omitted jsonRaw would read as fetched. That direction
  // UNDER-claims freshness and prompts a refresh, which is why the test is
  // written round this way.
  const list = (k.offerable && Array.isArray(k.offerable[p.id])) ? k.offerable[p.id] : [];
  const hasFetched = meta
    ? (typeof meta.count === 'number' && meta.count > 0)
    : list.some((m) => m && typeof m === 'object' &&
        m.suitability === 'chat-only' && m.jsonRaw === null);

  // The server's instant wins; the session's is the fallback for a backend
  // that does not report one.
  const when = formatSyncedAt(meta && meta.syncedAt) ||
    (last ? formatSyncedAt(last.syncedAt) : '');

  let statusLine;
  if (when) {
    statusLine = 'Last refreshed <strong>' + escapeHtml(when) + '</strong>.';
  } else if (last || hasFetched) {
    // A refresh has demonstrably happened — either this session, or the list
    // carries fetched models — but no usable instant came with it. Say that,
    // rather than inventing a time or claiming it never happened. Both would
    // be false, and the second is the one that makes a stale list look fresh.
    statusLine = 'This list includes models fetched from ' + escapeHtml(p.name) +
      '’s catalogue, but no usable time came with it — so it may be out of date. ' +
      'Refresh if you want to be sure.';
  } else {
    statusLine = 'Not refreshed yet. Only the models measured by The Curator are listed.';
  }

  // ── SESSION-ONLY IS A FACT THE USER ACTS ON ────────────────────────────
  // `persisted: false` means the refresh succeeded over the network but could
  // not be written to disk, so the models work now and vanish on the next
  // restart. Silence there would leave someone wondering why their model
  // disappeared. Rendered ONLY on an explicit `false`, never on an absent
  // field: "we were not told" must not become "it failed".
  const sessionOnly = (last && last.persisted === false)
    ? '<span class="catalogue-sync-note catalogue-sync-warn">These models are loaded for this ' +
      'session only — The Curator could not save the list, so a restart will lose them. ' +
      'Refresh again after restarting.</span>'
    : '';

  // Counts are rendered ONLY where reported, one by one — the same rule the
  // key-check verdict follows. A missing figure prints nothing rather than a
  // zero, because "0 refused" and "we were not told how many were refused"
  // are different facts and only one of them is reassuring.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const counts = [];
  if (last) {
    const t = num(last.total), e = num(last.eligible), a = num(last.admitted), r = num(last.refused);
    if (t !== null) counts.push(formatTokenCount(t) + ' listed by ' + p.name);
    if (e !== null) counts.push(formatTokenCount(e) + ' met our requirements');
    if (a !== null) counts.push(formatTokenCount(a) + ' added here');
    // Models the provider lists that we had ALREADY hand-measured, so the
    // fetched copy was dropped in favour of the measured one. Reported so the
    // arithmetic on screen adds up — without it a user can only conclude that
    // The Curator refused its own defaults.
    const sup = num(last.superseded);
    if (sup !== null && sup > 0) counts.push(formatTokenCount(sup) + ' already measured');
    if (r !== null && r > 0) counts.push(formatTokenCount(r) + ' refused');
  }
  const countsHtml = counts.length
    ? '<span class="mono catalogue-sync-counts">' + escapeHtml(counts.join(' · ')) + '</span>'
    : '';

  // The per-rule funnel, when the route sent one. Behind a disclosure because
  // it is up to a dozen rows of detail nobody needs on the common path — and
  // it contains NO CONTROL, so the summary carries no interactive element and
  // the beta.18 hazard cannot apply to it either.
  const funnel = (last && Array.isArray(last.funnel)) ? last.funnel : [];
  const funnelRows = funnel.map((f) => {
    if (!f || typeof f !== 'object') return '';
    const before = num(f.before), after = num(f.after);
    const dropped = (before !== null && after !== null) ? before - after : null;
    return '<li><span class="catalogue-funnel-rule">' + escapeHtml(String(f.rule ?? '')) + '</span>' +
      (dropped !== null
        ? '<span class="mono catalogue-funnel-count">' + escapeHtml(formatTokenCount(dropped) +
            ' removed · ' + formatTokenCount(after) + ' left') + '</span>'
        : '') +
      '</li>';
  }).join('');
  const funnelHtml = funnelRows
    ? '<details class="catalogue-funnel">' +
        '<summary class="catalogue-funnel-summary">Why models were left out</summary>' +
        '<ul class="catalogue-funnel-list">' + funnelRows + '</ul>' +
      '</details>'
    : '';

  const errText = (state.catalogueSyncError && typeof state.catalogueSyncError[p.id] === 'string')
    ? state.catalogueSyncError[p.id]
    : '';
  // role="alert", and rendered directly beneath the button that produced it.
  // v3.6.0: a refusal painted somewhere the user was not looking read as "my
  // click didn't register", and the observed next action was a retry.
  const errHtml = errText
    ? '<div class="settings-inline-error catalogue-sync-error" role="alert">' + escapeHtml(errText) + '</div>'
    : '';

  return (
    '<div class="catalogue-sync" data-catalogue-sync="' + escapeHtml(String(p.id)) + '">' +
      '<div class="catalogue-sync-head">' +
        '<span class="catalogue-sync-status">' + statusLine + '</span>' +
        '<button type="button" class="btn btn-secondary btn-xs catalogue-sync-btn"' +
          ' data-sync-catalogue="' + escapeHtml(String(p.id)) + '"' +
          (disabled ? ' disabled' : '') + crossTitleAttr + '>' +
          (busy ? 'Refreshing…' : 'Refresh model list') +
        '</button>' +
      '</div>' +
      countsHtml +
      // Said once, here, rather than on every fetched row. It is the whole
      // point of the control and it must not be discoverable only by
      // expanding something.
      '<span class="catalogue-sync-note">Fetched models are <strong>chat only</strong>. ' +
      'They have never been measured against The Curator’s ingest prompt, so they cannot build ' +
      'your wiki — ' + escapeHtml(p.name) + ' tells us what a model costs; only we can measure ' +
      'whether it does our job.</span>' +
      sessionOnly +
      funnelHtml +
      errHtml +
    '</div>'
  );
}

/**
 * The honesty line at the top of every model list. See the block comment
 * above for why it says what it says. `defaultId` is the model this provider
 * actually runs today (`k.models[provider]`, i.e. llm.js's getDefaultModel).
 *
 * ── WHY THE FIRST SENTENCE IS ABOUT THE ACTIVE PROVIDER ────────────────────
 * The maintainer hit this himself: he pinned a model under one provider, had
 * the OTHER provider active, and asked whether his next ingest would use the
 * model he had just picked. It would not. Every section on this screen looked
 * equally in force, and only the ACTIVE provider's pin reaches ingest.
 *
 * The chain, verified rather than assumed: ingest, Health scans and Compile
 * all call `generateText` with NO override, so each resolves
 * getProviderInfo() -> getActiveProvider() -> defaultModelFor(provider) ->
 * applyModelOverride(provider, DEFAULTS[provider], storedSelection(provider)).
 * The governing pair is therefore (ACTIVE provider, that provider's pin).
 *
 * ── AND WHY IT IS ONE LANE, NOT THREE FEATURES ─────────────────────────────
 * Naming ingest, Health and Compile as three things invites the reader to ask
 * which of them they could set separately. None of them. It is not a missing
 * feature, it is the shape of the code: `generateText`'s provider/model live
 * in its SIXTH argument (`opts`), and every one of health-ai.js's five calls
 * is FOUR-argument while compile.js's is five — so on those two surfaces an
 * override is not merely unused, it is INEXPRESSIBLE. ingest.js does pass an
 * opts object but carries only `{onUsage, signal}`. One model builds the
 * wiki; there is no second knob to look for.
 *
 * So the copy leads with the lane ("this model builds your wiki") and keeps
 * the three names as the parenthetical that answers "does this affect my
 * Health scan?" — demoted, never dropped. Chat is stated as the separate
 * lane it genuinely is: the only surface that passes a per-call override.
 *
 * `isActive` and `activeLabel` come from the caller, which computes them as
 * `k.activeProvider === p.id` — an identity test against the row's own id,
 * never a two-armed `p.id === 'gemini' ? … : …` (see §28's class invariant
 * and the v3.10.1 finding that shape caused).
 */
function renderModelPickerScope(defaultId, selectedId, provider, pickDisabled, scope) {
  const s = scope || {};
  const idCode = defaultId ? '<code class="mono">' + escapeHtml(defaultId) + '</code>' : 'this model';

  // Names the active provider when we can, and degrades to "the active
  // provider" when activeProvider is absent or unknown rather than inventing
  // one. providerLabel echoes an unknown id back and never substitutes a
  // different provider's identity (v3.10.1), so the worst case is vaguer
  // wording, never a wrong attribution.
  const other = s.activeLabel ? escapeHtml(s.activeLabel) : 'the active provider';
  const self = s.providerLabel ? escapeHtml(s.providerLabel) : 'this provider';

  const lane = s.isActive
    ? '<strong>This model builds your wiki.</strong> Ingest, Health scans and Compile all run on ' +
      idCode + ' — they always share one model, so there is nothing separate to set. ' +
      'Chat is the one place you choose per message, and choosing there does not change this.'
    : '<strong>This model does not build your wiki.</strong> Ingest, Health scans and Compile all run on ' +
      other + ', the active provider. Make ' + self + ' active and this choice takes over all three. ' +
      'Until then chat can still use ' + idCode + ' any time you pick it in the composer.';

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

  // Tinted amber only on the ACTIVE section. The inactive one is a plain
  // recessed note: amber there would read as a warning about a provider that
  // is simply not selected, and would give both sections the same visual
  // weight — which is the confusion being fixed.
  const cls = s.isActive ? 'model-picker-scope model-picker-scope-live' : 'model-picker-scope';

  return (
    '<p class="' + cls + '">' + lane + pinned +
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

  // Null-prototype for the same reason KEY_INFO_BY_PROVIDER above is: on a
  // plain literal `HAS_KEY_BY_PROVIDER['constructor']` is truthy, so the gate
  // below would PASS for an inherited name — the opposite of the fail-safe
  // direction this docblock promises.
  const HAS_KEY_BY_PROVIDER = Object.assign(Object.create(null), {
    gemini: k.hasGeminiKey,
    anthropic: k.hasAnthropicKey,
    // v3.15.0 — OpenRouter. A further provider (a local runtime) adds ONE
    // line here and one entry to PROVIDER_ROWS. Nothing else in this file
    // needs to change: the section, its header and its list are all derived
    // from the catalogue the route sends for that id.
    openrouter: k.hasOpenrouterKey,
  });
  if (!HAS_KEY_BY_PROVIDER[p.id]) return '';

  // TWO DIFFERENT ABSENCES, and only one of them is a fact worth rendering.
  //   `offerable[p.id]` is an ARRAY  — the server TOLD us this provider's
  //                                    catalogue. An empty one is information.
  //   `offerable` absent / not an array for this id — the server told us
  //                                    NOTHING (an older backend that predates
  //                                    the catalogue, a truncated payload).
  // Saying "there are no models for this provider" in the second case would
  // assert something we never learned, so it stays silent and the section
  // simply does not appear — the pre-catalogue behaviour, degrading cleanly.
  const hasCatalogue = !!(k.offerable && typeof k.offerable === 'object'
    && Array.isArray(k.offerable[p.id]));
  const list = hasCatalogue ? k.offerable[p.id] : [];
  if (!hasCatalogue) return '';

  // ── AN EMPTY CATALOGUE UNDER A SAVED KEY IS A STATE, NOT A NON-EVENT ────
  // This used to `return ''`, which was correct while every keyed provider
  // always shipped a catalogue: the only way to reach it was a provider with
  // no key, and that is already handled one line above. v3.15.0 makes it
  // reachable in the normal course of use — OpenRouter's `offerable` is `[]`
  // for this release, because no OpenRouter route has been measured against
  // the real ingest outline prompt and this project does not offer a model
  // for a job it has not been measured doing (docs/model-lifecycle.md).
  //
  // Rendering NOTHING there is the failure this repo keeps re-finding under
  // new names: the user saves a key, the screen does not change, and there is
  // no way to tell "working, nothing to choose yet" from "my key did not
  // save". Say it instead.
  //
  // The two arms are DERIVED FROM THE PAYLOAD, never from `p.id === 'openrouter'`.
  // A binary test on a provider id is the exact shape that made this file
  // render Anthropic's masked key beside another provider's name (v3.10.1),
  // and it would also be wrong on its own terms: what distinguishes the two
  // cases is whether the provider has a DEFAULT MODEL at all, and that is a
  // fact on the wire. `models[p.id]` is null only when DEFAULTS[provider] is
  // null — i.e. when nothing is pinned because nothing is measured. Any
  // future provider that lands in that state gets the right sentence with no
  // edit here, and a keyed Gemini that somehow arrives with an empty
  // catalogue gets the anomaly sentence rather than a claim about
  // measurement that would be false for it.
  const defaultId = (k.models && typeof k.models[p.id] === 'string') ? k.models[p.id] : '';
  if (list.length === 0) return renderEmptyModelPicker(p, defaultId);


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
  // Qualifications arrive as a flat array keyed by model id. Indexed into a
  // NULL-PROTOTYPE object rather than a plain literal so a model id of
  // `constructor` or `__proto__` cannot resolve through the prototype chain and
  // hand a row a function where a record should be — the v3.0.9 shape, and an
  // OpenRouter id is a third party's string, not ours.
  const quals = Object.create(null);
  const qualList = (k && Array.isArray(k.qualifications)) ? k.qualifications : [];
  for (let i = 0; i < qualList.length; i++) {
    const r = qualList[i];
    if (r && typeof r.modelId === 'string') quals[r.modelId] = r;
  }
  const ctx = {
    provider: p.id, selectedId, busyId, pickDisabled, crossBusy: !!crossBusy,
    quals,
    qualify: state.qualify,
    minRuns: Number.isFinite(k && k.minRunsToQualify) ? k.minRunsToQualify : 9,
  };
  // ── FILTER, THEN RENDER ────────────────────────────────────────────────
  // Applied to the DELIVERED list, so the lane grouping and every row below it
  // sees exactly the models that survived. `orderModels` reverses rather than
  // re-sorts — see its docblock for why a client-side price comparator would be
  // both a second opinion and an arithmetic bug on free models.
  const filter = modelFilterFor(p.id);
  const visible = orderModels(filterModels(list, filter), filter.sort);
  const filterActive = !!filter.q || filter.measuredOnly;
  // The bar appears only where it earns its pixels. Below the threshold the
  // whole list fits on screen and a search box is furniture; it stays rendered
  // whenever a filter is ACTIVE, so a user who narrowed a long list and is now
  // looking at three rows still has the control that got them there.
  const filterHtml = (list.length >= MODEL_FILTER_MIN_ROWS || filterActive)
    ? renderModelFilterBar(p.id, filter, visible.length, list.length,
        // Counted over what is VISIBLE, not over the whole catalogue: the number
        // has to describe the list the user is looking at, or it explains a
        // block of rows that a search has already removed.
        countUnrankedForSort(visible, filter.sort))
    : '';
  const items = visible.length === 0
    ? renderModelFilterEmpty(p.id, filter)
    : renderModelLanes(visible, defaultId, ctx);

  // ── THE FREE-ROUTING OPEN QUESTION, said once per list ─────────────────
  // Rendered whenever ANY listed model bills nothing — derived from `m.free`,
  // the catalogue's own single authority on that (never a price of zero and
  // never a `:free` suffix; see renderModelOption). It therefore appears on
  // any provider that ever ships a free model, with no edit here.
  //
  // WHAT IT DOES NOT SAY. It does not claim free routing trains on your data,
  // and it does not claim it doesn't. No field in any of OpenRouter's three
  // endpoints answers the question, so both claims would be inventions — and
  // on a privacy question an invented reassurance is the worse of the two.
  // The one measured fact is stated because it is checkable and because it
  // rules out the obvious workaround.
  const freeNote = list.some((m) => m && typeof m === 'object' && m.free === true)
    ? '<p class="model-picker-scope model-picker-free-note">' +
      '<strong>About the free models.</strong> They bill nothing and you can pick one at any time. ' +
      'Whether free routing permits training on the text you send is an <strong>open question</strong> — ' +
      'no field in the provider’s API answers it, so The Curator does not tell you either way. ' +
      'The one thing we have measured: the request flag that forbids data collection is accepted on ' +
      'paid models and rejected on free ones, so you cannot combine the two. If that matters for your ' +
      'sources, use a paid model.</p>'
    : '';

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

  // ── THE LANE MARKER, ON THE COLLAPSED HEADER ───────────────────────────
  // These sections are collapsed by default, so for most users the summary
  // is the ONLY thing they will read. The fact that decides what an ingest
  // costs therefore cannot live behind the expand — that is exactly how the
  // maintainer came to pin a model under one provider and expect his next
  // ingest to use it. The body carries the full sentence; this carries the
  // one-glance answer.
  //
  // Identity test against this row's own id, so it is symmetric for any
  // provider and a third one cannot fall into another's arm.
  const isActive = !!(k.activeProvider && k.activeProvider === p.id);
  const scopeBadge = isActive
    ? '<span class="model-picker-lane model-picker-lane-live">builds your wiki</span>'
    : '<span class="model-picker-lane model-picker-lane-idle">not active — chat can still use it</span>';

  return (
    '<details class="model-picker"' + (isOpen === true ? ' open' : '') +
      ' data-model-picker="' + escapeHtml(p.id) + '">' +
      '<summary class="model-picker-summary">' +
        icon('chevronRight', 12) +
        '<span class="model-picker-title">' + escapeHtml(p.name) + '</span>' +
        scopeBadge +
        current +
        chosen +
        '<span class="mono model-picker-count">' + escapeHtml(String(list.length)) + ' models</span>' +
      '</summary>' +
      '<div class="model-picker-body">' +
        renderModelPickerScope(defaultId, selectedId, p.id, pickDisabled, {
          isActive,
          providerLabel: p.name,
          activeLabel: providerLabel(k.activeProvider),
        }) +
        errHtml +
        freeNote +
        // INSIDE the body, never the <summary> — an interactive control in a
        // <summary> toggles its own section on click (v3.0.1-beta.18), and the
        // structural fix is to keep controls out rather than suppress the event.
        filterHtml +
        items +
      '</div>' +
    '</details>'
  );
}

/**
 * The list body: one flat `<ul>`, or two lane-labelled groups.
 *
 * ── WHY GROUP AT ALL ─────────────────────────────────────────────────────
 * A provider whose catalogue is fetched at runtime can list ~190 models, of
 * which a handful build the wiki and the rest are chat only. Flat, the three
 * that answer "what runs my ingest?" are lost among the ones that cannot, and
 * the question this whole screen exists to answer becomes the hardest one on
 * it. Grouping puts the lane — the fact that decides what a model may be used
 * FOR — above the rows instead of on each of them.
 *
 * ── THE RULE IS DERIVED, NOT KEYED ON A PROVIDER ─────────────────────────
 * Group when the list contains BOTH lanes; render flat when it contains only
 * one. So a catalogue of seven build-lane models renders exactly as it did
 * before this function existed (no headings, one <ul>), and a provider id
 * appears nowhere in the decision. `suitability === 'chat-only'` is the same
 * field `isBuildLaneAllowed` reads server-side, so the two cannot disagree
 * about which group a model belongs in.
 *
 * ── THE INDEX PASSED DOWN IS THE ORIGINAL ONE ────────────────────────────
 * Load-bearing. `renderModelOption` badges `index === 0` as the cheapest, and
 * that claim is true only of the DELIVERED order (the route ships
 * cheapest-first). Re-numbering per group would badge the first row of each
 * group as cheapest — two "cheapest" markers, one of them false, on a screen
 * whose purpose is comparing spend. Pairs carry the original position.
 *
 * ── AND THE COLLAPSE IS ABOUT LENGTH, NOT ABOUT LANE ─────────────────────
 * The chat group folds into a <details> only when it is long enough to bury
 * what follows it. Below the threshold it renders open, because a disclosure
 * hiding four rows costs a click and buys nothing. The build group is NEVER
 * folded: it is the shortest and the most consequential.
 */
/**
 * ── THE FILTER: a pure decision core, and the reason it is pure ────────────
 *
 * A synced OpenRouter catalogue is ~190 models. Grouping alone does not answer
 * "I know I want Kimi" — the maintainer asked for a filter, and the honest
 * answer is mostly SEARCH.
 *
 * These three functions decide WHAT is shown and IN WHAT ORDER, and nothing
 * else: no DOM, no state, no fetch. That is the v3.11.0 loading-gate shape
 * (`shouldShowLoader` / `settleDelayMs`) and it exists so the two rules below
 * can be driven exhaustively offline rather than inspected through markup.
 */

/** Everything a search should match: the id, the label, and the vendor prefix. */
function modelSearchText(m) {
  if (!m || typeof m !== 'object') return '';
  const id = typeof m.id === 'string' ? m.id : '';
  const label = typeof m.label === 'string' ? m.label : '';
  // The vendor is already inside the id (`moonshotai/kimi-k2-0905`), so typing a
  // vendor works with no vendor field and no 49-entry dropdown. A separate
  // vendor control would be a second way to do what one input already does.
  return (id + ' ' + label).toLowerCase();
}

/**
 * Has THE CURATOR measured this model against its real ingest prompt?
 *
 * `jsonRaw` is llm.js's own marker and its docblock is explicit: a boolean means
 * measured, `null` means NOT measured and is legal only on a chat-only entry.
 * So this is reading a field for what it means, never inferring provenance.
 *
 * DELIBERATELY EXCLUDES a model the USER qualified on their own wiki. That is a
 * real measurement and it is badged as such on the row, but "we measured this
 * across documents and against its siblings" and "you ran nine of these on one
 * document last Tuesday" are different claims, and a filter named "Measured by
 * The Curator" must not quietly answer the second question.
 */
function isCuratorMeasured(m) {
  return !!m && typeof m === 'object' && typeof m.jsonRaw === 'boolean';
}

/**
 * The visible subset. Absent fields are never treated as a match or a miss by
 * accident: a model with no label still matches on its id, and `measuredOnly`
 * reads the marker rather than guessing from price, size, vendor or recency.
 */
function filterModels(list, f) {
  const rows = Array.isArray(list) ? list : [];
  const q = (f && typeof f.q === 'string' ? f.q : '').trim().toLowerCase();
  const measuredOnly = !!(f && f.measuredOnly);
  return rows.filter((m) => {
    if (measuredOnly && !isCuratorMeasured(m)) return false;
    if (!q) return true;
    // Every whitespace-separated term must match, so "kimi 0905" narrows rather
    // than widening — the behaviour a user expects from a search box.
    return q.split(/\s+/).every((t) => modelSearchText(m).includes(t));
  });
}

/**
 * ── ORDER: the delivered order, or its exact reverse. NEVER a comparator ──
 *
 * THIS IS THE WHOLE DESIGN AND IT IS NOT LAZINESS. The route ships this list
 * cheapest-first and that ordering is asserted server-side against the real
 * price table, promotions resolved. Writing a client-side price comparator here
 * would create a SECOND opinion about which model is cheapest — and it would be
 * a wrong one, twice over:
 *
 *   · A FREE model's price is `null` BY DESIGN (membership, never 0 — a truthy
 *     zero re-arms v3.3.0's inert budget cap). `null - 5` coerces to `0 - 5`, so
 *     a naive comparator ranks free as cheapest by ARITHMETIC ACCIDENT rather
 *     than because it is free. It happens to look right in the cheapest view and
 *     is wrong in the dearest one, where free would sort to the top.
 *   · A promoted price expires. The server resolves that at read time; a
 *     client-side comparator would sort on whichever figure it happened to hold.
 *
 * Reversing a total order someone else computed introduces no opinion at all,
 * and there is no arithmetic to get wrong: free lands last in the dearest view
 * because it was first in the cheapest one, which is the correct answer arrived
 * at without ever touching a null.
 */
const MODEL_SORTS = Object.freeze(['cheapest', 'dearest', 'newest', 'largest-context']);

/**
 * ── THE TWO SORTS THAT DO NEED A COMPARATOR, AND WHAT THEY REFUSE TO INVENT ──
 *
 * Price is a total order the server already computed, so it is reversed and
 * never re-derived (above). Recency and size are not: nobody has ordered the
 * list by them, so these two comparators are the only arithmetic in this file —
 * and both are on a field that is legitimately ABSENT for a large share of rows.
 *
 * ABSENT IS NOT ZERO, AND THIS IS THE WHOLE DIFFICULTY. `null` becomes `0` in
 * arithmetic, so a plain `b.createdUnixSec - a.createdUnixSec` files every model
 * with no published date at 1970-01-01 and ranks it dead last — confidently,
 * silently, and looking exactly like a real answer. Defaulting the other way
 * (`|| Date.now()`) is worse: it puts the undated models FIRST in a view called
 * "Newest". Both are a fabricated value presented as a measurement, which is the
 * fact-vs-absence class this repo has now shipped eight separate bugs from.
 *
 * SO A MODEL WITH NO KEY IS NOT RANKED AT ALL. `orderModels` partitions: rows
 * that carry the fact are sorted by it, descending; rows that do not keep their
 * delivered (cheapest-first) order and follow as a contiguous block, and the
 * filter bar's existing count states how many they are. Nothing is hidden — a
 * user searching for a model still finds it — and nothing is given a number
 * nobody published.
 *
 * WHICH ROWS THOSE ARE, MEASURED rather than assumed: every entry fetched from
 * OpenRouter's catalogue carries both facts (191 of 191 admitted specs on the
 * live catalogue), and every HAND-MEASURED entry — all 14 Gemini and Anthropic
 * models and all 5 static OpenRouter ones — carries neither, because a table of
 * things we measured is not a release calendar. The unranked block is therefore
 * the models The Curator measured itself, which is a coherent group rather than
 * a scattering of holes.
 *
 * NO `maxOutput` SUBSTITUTION. It is the OUTPUT ceiling and the context window
 * is the INPUT side: across the 374 live models publishing both, output is
 * strictly smaller in 374 of 374 cases. It is present on every row, so using it
 * would make the unranked block vanish and the sort look complete — a filled-in
 * column of the wrong fact, which is the proxy-for-a-measurement move this
 * architecture refuses.
 */
const MODEL_SORT_KEYS = Object.freeze({
  newest: 'createdUnixSec',
  'largest-context': 'contextLength',
});

/**
 * How many rows this sort cannot rank, so the bar can say so. Zero for the
 * price sorts, which rank everything.
 */
const MODEL_SORT_UNRANKED_LABEL = Object.freeze({
  newest: 'with no release date',
  'largest-context': 'with no context size',
});

/**
 * The sort key, or `null` when this model does not carry it.
 *
 * `Object.hasOwn`, never a bare index: a sort value of `__proto__` or
 * `constructor` resolves through the prototype chain and would hand this a
 * function where a field name belongs — the v3.0.9 shape. The value itself must
 * be a finite POSITIVE number: 0 is what OpenRouter publishes for an unknown
 * context window and what a milliseconds/seconds mix-up produces for a date, and
 * neither is a measurement.
 */
function modelSortKey(m, sort) {
  if (!m || typeof m !== 'object') return null;
  if (typeof sort !== 'string' || !Object.hasOwn(MODEL_SORT_KEYS, sort)) return null;
  const v = m[MODEL_SORT_KEYS[sort]];
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : null;
}

/** Rows this sort has to leave unranked — what the bar reports. */
function countUnrankedForSort(list, sort) {
  if (typeof sort !== 'string' || !Object.hasOwn(MODEL_SORT_KEYS, sort)) return 0;
  const rows = Array.isArray(list) ? list : [];
  let n = 0;
  for (let i = 0; i < rows.length; i++) if (modelSortKey(rows[i], sort) === null) n++;
  return n;
}
/**
 * Below this, the list fits and a filter bar is furniture. Above it, hunting
 * begins. Gemini ships 7 and Anthropic 7; a synced OpenRouter catalogue is ~190.
 */
const MODEL_FILTER_MIN_ROWS = 12;
function orderModels(list, sort) {
  const rows = Array.isArray(list) ? list.slice() : [];
  if (sort === 'dearest') return rows.reverse();
  // 'cheapest' AND any unrecognised value: the delivered order, untouched.
  if (typeof sort !== 'string' || !Object.hasOwn(MODEL_SORT_KEYS, sort)) return rows;

  // Partition FIRST, so no comparator ever sees a null. The unranked keep their
  // delivered order and trail as one block; they are never dropped, because a
  // sort is not a filter and a model that vanishes when you change the ordering
  // reads as a broken picker.
  const ranked = [], unranked = [];
  for (let i = 0; i < rows.length; i++) {
    (modelSortKey(rows[i], sort) === null ? unranked : ranked).push(rows[i]);
  }
  // ── WHY THE PARTITION, WHEN A NAIVE COMPARATOR MEASURES THE SAME ────────
  // Stated because it would otherwise look like an over-elaboration a later
  // edit could "simplify". MEASURED: a naive `(b[f] || 0) - (a[f] || 0)` emits a
  // BYTE-IDENTICAL id sequence to this partition, for both fields — because no
  // legal key can be <= 0 (defineOfferableModel refuses a 0 date and a 0 context
  // window, verified), so a coerced null always lands exactly where an unranked
  // row belongs anyway. The equivalence is therefore CONDITIONAL on those two
  // guards, not a property of the comparator. The partition is kept because it
  // is the same predicate `countUnrankedForSort` uses, so the bar's "12 with no
  // release date" and the order it describes can never disagree; and because the
  // naive form is one character from `|| Date.now()`, which is NOT equivalent
  // (measured: it puts every undated model at the top of "Newest") and which
  // nothing about a comparator's shape would warn you about.
  //
  // Descending — "Newest" and "Largest" both mean biggest-first. Array.prototype
  // .sort is stable (ES2019), so ties keep the delivered cheapest-first order
  // rather than an arbitrary one.
  ranked.sort((a, b) => modelSortKey(b, sort) - modelSortKey(a, sort));
  return ranked.concat(unranked);
}

/**
 * Merge one axis of a provider's filter, leaving the others alone.
 *
 * Null-prototype container so a provider id of `__proto__` or `constructor`
 * cannot write through the prototype chain — the v3.0.9 shape, and these ids
 * are ours rather than a third party's, which is exactly the assumption that
 * stops holding when a fourth provider is added.
 */
function setModelFilter(provider, patch) {
  if (typeof provider !== 'string' || !provider) return;
  if (!state.modelFilter || Object.getPrototypeOf(state.modelFilter) !== null) {
    state.modelFilter = Object.assign(Object.create(null), state.modelFilter || {});
  }
  const cur = modelFilterFor(provider);
  state.modelFilter[provider] = Object.assign({}, cur, patch || {});
}

/** Quote a provider id for use inside an attribute selector. */
function cssEscapeAttr(v) {
  return String(v === undefined || v === null ? '' : v).replace(/["\\]/g, '\\$&');
}

/** This provider's session filter. Never persisted — see renderModelFilterBar. */
function modelFilterFor(provider) {
  const all = state.modelFilter && typeof state.modelFilter === 'object' ? state.modelFilter : null;
  const f = all && Object.hasOwn(all, provider) ? all[provider] : null;
  return {
    q: f && typeof f.q === 'string' ? f.q : '',
    sort: f && MODEL_SORTS.includes(f.sort) ? f.sort : 'cheapest',
    measuredOnly: !!(f && f.measuredOnly),
  };
}

/**
 * ── THE BAR: one obvious input, and everything else small ─────────────────
 *
 * Search is the primary control and gets the width. The sort is a native
 * <select> and the measured filter a checkbox, both compact — six filter chips
 * above a list is not an improvement on a long list, and a control panel that
 * out-weighs the thing it controls is the clutter it was meant to solve.
 *
 * NO VENDOR CONTROL, DELIBERATELY: the vendor is inside the id, so the search
 * box already does it.
 *
 * "NEWEST" AND "LARGEST CONTEXT" ARE OPTIONS IN THE EXISTING SORT, NOT NEW
 * CONTROLS. They were previously absent for a real reason — the record-to-spec
 * mapper carried neither `created` nor `context_length` onto the wire, so the
 * only fields present were price and `maxOutput`, and `maxOutput` is the OUTPUT
 * ceiling, a different fact whose substitution would be the
 * proxy-for-a-measurement move this architecture refuses. The mapper now carries
 * both (`createdUnixSec`, `contextLength`), read from the CONSERVATIVE context
 * field, so the two sorts rank a published fact rather than a stand-in.
 *
 * THEY ADD NO PIXELS TO A ROW. A collapsed row shows what a CHOICE needs —
 * which model, what it costs, any warning. A release date is not that; it is a
 * sort key, and it stays one. Two <option>s inside the <select> that already
 * exists is the whole surface: the bar still carries exactly three controls, and
 * an assertion in test-next-model-picker.js §22e holds it to that.
 *
 * WHAT THE COUNT SAYS. A model with no published date cannot be ranked by date,
 * so it is not ranked at all — it trails in delivered order and the count states
 * how many. See `orderModels` for why the alternatives (1970, or now) are both a
 * fabricated value wearing the clothes of a measurement.
 *
 * NOTHING HERE IS PERSISTED. A filter is a per-session convenience; storing it
 * would make a user's next visit mysteriously show a subset of their models.
 *
 * IT LIVES IN THE SECTION BODY, never in a <summary>. An interactive control
 * inside a <summary> toggles its own section on click (v3.0.1-beta.18), and the
 * structural fix is to keep controls out of it rather than to suppress the
 * event — a suppression a later edit can drop.
 */
function renderModelFilterBar(provider, f, shown, total, unranked) {
  const pid = escapeHtml(String(provider));
  const opt = (v, label) => '<option value="' + v + '"' +
    (f.sort === v ? ' selected' : '') + '>' + label + '</option>';
  // ── THE ROWS THIS SORT COULD NOT RANK, STATED ────────────────────────────
  // Only ever a positive integer, and only for a sort that has an absence to
  // report. Reusing the count span rather than adding an element is the
  // restraint: it is one clause on a line that already exists, and it appears
  // only while the sort it explains is selected.
  const n = Number.isInteger(unranked) && unranked > 0 ? unranked : 0;
  const why = (typeof f.sort === 'string' && Object.hasOwn(MODEL_SORT_UNRANKED_LABEL, f.sort))
    ? MODEL_SORT_UNRANKED_LABEL[f.sort] : '';
  const unrankedNote = (n > 0 && why) ? ' · ' + String(n) + ' ' + why : '';
  return (
    '<div class="model-filter">' +
      '<input type="search" class="model-filter-q" data-model-filter-q="' + pid + '"' +
        ' placeholder="Search models…" aria-label="Search models"' +
        ' value="' + escapeHtml(f.q) + '">' +
      // Wrapper carries the CSS-drawn chevron — see .settings-select-wrap.
      // It is the flex item now, so the sizing that was on the select
      // (`flex: 0 0 auto`) moves to it; a wrapper left at the default
      // `min-width: auto` would refuse to shrink and push the row wide.
      '<span class="settings-select-wrap model-filter-sort-wrap">' +
        '<select class="model-filter-sort" data-model-filter-sort="' + pid + '" aria-label="Sort models">' +
          opt('cheapest', 'Cheapest first') + opt('dearest', 'Most expensive first') +
          opt('newest', 'Newest first') + opt('largest-context', 'Largest context first') +
        '</select>' +
      '</span>' +
      '<label class="model-filter-measured">' +
        '<input type="checkbox" data-model-filter-measured="' + pid + '"' +
          (f.measuredOnly ? ' checked' : '') + '>' +
        'Measured by The Curator' +
      '</label>' +
      // The count is the feedback that the controls did something. It is also
      // what makes an empty result legible rather than alarming.
      '<span class="mono model-filter-count">' +
        escapeHtml((shown === total ? String(total) + ' models'
                                    : String(shown) + ' of ' + String(total)) + unrankedNote) +
      '</span>' +
    '</div>'
  );
}

/**
 * The empty result.
 *
 * A filtered list that matches nothing must SAY SO and offer the way back. An
 * unexplained empty list reads as "the feature is broken" — this repo has
 * shipped that exact misreading before, and the fix is a sentence and a button,
 * not a cleverer layout. The button is a sibling of nothing interactive and
 * carries the provider id, so one delegated handler clears one provider.
 */
function renderModelFilterEmpty(provider, f) {
  const what = f.measuredOnly && f.q
    ? 'No model matches “' + escapeHtml(f.q) + '” among the ones The Curator has measured.'
    : (f.measuredOnly
        ? 'The Curator has not measured any model for this provider yet.'
        : 'No model matches “' + escapeHtml(f.q) + '”.');
  return (
    '<div class="model-filter-empty">' +
      '<p>' + what + '</p>' +
      '<button type="button" class="btn btn-secondary btn-xs" data-model-filter-clear="' +
        escapeHtml(String(provider)) + '">Clear filters</button>' +
    '</div>'
  );
}

function renderModelLanes(list, defaultId, ctx) {
  // ── ONE LANE DECISION PER MODEL, FROM THE SHARED PREDICATE ────────────
  // Never a second `suitability === 'chat-only'` test here. This is the site
  // that used to disagree with the pick control: a model the user had
  // qualified — and which the app was ingesting with — was filed under a
  // heading whose note reads "These cannot run ingest, Health scans or
  // Compile." See modelLaneOf.
  const pairs = list.map((m, index) => ({ m, index, lane: modelLaneOf(m, qualificationFor(ctx, m)) }));
  const chat = pairs.filter((x) => !laneBuildsWiki(x.lane));
  const build = pairs.filter((x) => laneBuildsWiki(x.lane));
  const localBuild = build.filter((x) => x.lane === MODEL_LANES.BUILD_LOCAL);

  const ul = (items) => '<ul class="model-list">' +
    items.map((x) => renderModelOption(x.m, x.index, defaultId, ctx)).join('') + '</ul>';

  // One lane present (either one) — render exactly what this function
  // replaced. No heading, no group, byte-identical to the pre-grouping shape.
  if (chat.length === 0 || build.length === 0) return ul(pairs);

  const head = (cls, title, note, n) =>
    '<div class="model-lane-head ' + cls + '">' +
      '<span class="model-lane-title">' + title + '</span>' +
      '<span class="mono model-lane-count">' + escapeHtml(String(n)) + '</span>' +
    '</div>' +
    '<p class="model-lane-note">' + note + '</p>';

  // ── TWO PROVENANCES, ONE LANE, AND THE NOTE SAYS WHICH ────────────────
  // Every model in this group can run ingest, Health scans and Compile. They
  // did not all arrive the same way, and that difference is the entire reason
  // the build lane grew a THIRD state rather than widening `suitability`:
  // "we measured this across documents, against its siblings" and "you ran
  // nine of these on one document, on one day" are different epistemic claims.
  // Asserting the first over a row that only holds the second would be the
  // same conflation this split exists to prevent, moved up one level — so the
  // heading's claim ("can build your wiki", true of both) stays, and the note
  // stops claiming WE measured them all the moment one of them is the user's.
  const buildNote = localBuild.length === 0
    ? 'Measured by The Curator against its real ingest prompt. Any of these can run ingest, ' +
      'Health scans and Compile — the price and the limits beside each one are things we observed.'
    : 'Any of these can run ingest, Health scans and Compile. Most were measured by The Curator ' +
      'against its real ingest prompt; ' +
      (localBuild.length === 1 ? 'one is' : escapeHtml(String(localBuild.length)) + ' are') +
      ' here because <strong>you</strong> measured ' +
      (localBuild.length === 1 ? 'it' : 'them') + ' on your own wiki — badged ' +
      '<span class="model-badge model-badge-local">you measured this on your wiki</span>, ' +
      'with what you ran, on which wiki and when inside the row.';

  const buildHtml =
    head('model-lane-head-build', 'Can build your wiki', buildNote, build.length) +
    ul(build);

  const chatNote =
    'These cannot run ingest, Health scans or Compile. Some were measured and found unfit for that ' +
    'job; the rest have never been measured against it at all and are marked ' +
    '<span class="model-badge model-badge-unmeasured">never measured here</span> — the provider ' +
    'tells us what they cost, not whether they can do the job. All of them stay fully usable in chat, ' +
    'which you pick per message in the composer.';

  const chatBody = head('model-lane-head-chat', 'Chat only', chatNote, chat.length) + ul(chat);

  // No control anywhere in this <summary> — see renderModelPicker's own note
  // on the v3.0.1-beta.18 hazard. It is text and a disclosure marker only.
  const chatHtml = chat.length > CHAT_LANE_COLLAPSE_AT
    ? '<details class="model-lane-fold">' +
        '<summary class="model-lane-fold-summary">' +
          icon('chevronRight', 12) +
          '<span class="model-lane-title">Chat only</span>' +
          '<span class="mono model-lane-count">' + escapeHtml(String(chat.length)) + ' models</span>' +
        '</summary>' +
        '<div class="model-lane-fold-body">' + chatBody + '</div>' +
      '</details>'
    : chatBody;

  return buildHtml + chatHtml;
}

/**
 * The catalogue section for a KEYED provider that has no models to list.
 *
 * Reached only from renderModelPicker's `list.length === 0` arm, i.e. the key
 * is saved and the route still sent an empty `offerable` array. See that call
 * site for why this is a rendered state rather than a silent ''.
 *
 * TWO ARMS, BOTH TRUE STATEMENTS, chosen on `defaultId` (a payload fact) and
 * never on the provider id:
 *
 *   no default model  — nothing is pinned because nothing has been measured
 *                       for this provider. This is OpenRouter in v3.15.0 and
 *                       it is the DESIGNED state, so it must not read as an
 *                       error. It says what the key is good for today (chat
 *                       is not yet wired to it either, so it says neither),
 *                       and what would have to happen for models to appear.
 *   has a default     — an anomaly: the engine has a model for this provider
 *                       but the catalogue arrived empty. Name the model still
 *                       in force so the user knows what is running, and do
 *                       NOT guess at a cause we cannot see from here.
 *
 * NOT a <details>. There is nothing to expand into, and a disclosure that
 * opens onto one sentence is a control that punishes curiosity. The header of
 * a real picker answers "what am I running"; this answers it directly.
 *
 * NO PROMISE OF A DATE, and no "coming soon". This project has shipped 27
 * consecutive "previews" straight to production; a version number here would
 * be a commitment the person reading it cannot check. "Once measured" is the
 * actual condition and it is verifiable in the docs.
 */
function renderEmptyModelPicker(p, defaultId) {
  if (!p) return '';
  const name = escapeHtml(p.name || p.id || 'This provider');

  const body = defaultId
    ? 'No model list is available for ' + name + ' right now. Ingest, Health scans and Compile ' +
      'still run on <code class="mono">' + escapeHtml(defaultId) + '</code>, the model already in force — ' +
      'nothing has changed about what you are billed. Reload Settings to try again.'
    : 'Your key is saved, and there are no models to choose yet. The Curator only offers a model ' +
      'once it has been measured against a real ingest, so that the price and the limits beside it ' +
      'are things we have observed rather than copied from a spec sheet. ' +
      name + ' models arrive here as that measurement lands. ' +
      // Stated plainly rather than left to be discovered. Until this provider
      // has a model, it cannot build the wiki — which is why its row offers
      // no "Set active" button (see renderProviderRow's canBuild).
      '<strong>Until then ' + name + ' cannot build your wiki</strong> — ingest, Health scans and ' +
      'Compile need a measured model, so they keep running on the provider that has one.';

  return (
    '<div class="model-picker model-picker-empty" data-model-picker-empty="' + escapeHtml(String(p.id || '')) + '">' +
      '<div class="model-picker-summary model-picker-empty-head">' +
        '<span class="model-picker-title">' + name + '</span>' +
        '<span class="model-picker-lane model-picker-lane-idle">no models listed yet</span>' +
      '</div>' +
      '<p class="model-picker-scope model-picker-empty-body">' + body + '</p>' +
    '</div>'
  );
}

/** ms -> "6 min" / "57 min" / "40 s". Never a false precision. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.round(ms / 1000);
  if (sec < 90) return sec + ' s';
  return Math.round(sec / 60) + ' min';
}

/**
 * A measurement the USER made, rendered as FACTS and never as a verdict.
 *
 * ── THE RULES THIS FUNCTION EXISTS TO OBEY ────────────────────────────────
 *  · NEVER the word "verified", and never "passed". The strongest thing that
 *    may appear is "no defect found in N runs", and it is always accompanied
 *    by the run count and by the rule-of-three caveat — nine clean runs are
 *    consistent with a true failure rate up to ~33% at 95% confidence, so a
 *    clean result is a SCREEN, not a certificate.
 *  · NEVER a comparison. No "better than", no ranking, no recommendation:
 *    those are the comparative judgements `docs/model-lifecycle.md` says a
 *    machine cannot honestly write, and nothing here writes one.
 *  · ALWAYS the scope — WHICH wiki and WHEN. An OpenRouter id routes over
 *    upstream hosts that change, so a measurement is a statement about a
 *    moment and a corpus. Dropping the stamp would turn it into a claim about
 *    the model, which it is not.
 *  · `repaired` is reported and is NOT a failure. The shipping Anthropic
 *    default fences its JSON 3 times out of 3 and depends entirely on the
 *    repair path; only `unrepairable` and `unusable` are defects.
 *  · LATENCY IS A HEADLINE FACT, not a footnote, and it is never a reason to
 *    reject. Measured across candidates: 38 s to 382 s per call, against ~53 s
 *    for the model this app ships. A user comparing those numbers can judge
 *    whether a 40-call ingest is worth it; an automatic rejection on a
 *    transient upstream slowdown would permanently disqualify a good model.
 */
function renderQualification(qual, minRuns) {
  if (!qual || typeof qual !== 'object') return '';
  const c = qual.counts || {};
  const num = v => (Number.isFinite(v) ? v : 0);
  const completed = num(qual.runsCompleted);

  const lines = [];
  lines.push(num(c.raw) + ' raw · ' + num(c.repaired) + ' repaired · ' +
    num(c.unrepairable) + ' unrepairable · ' + num(c.unusable) + ' parsed but unusable');
  if (qual.pages && Number.isFinite(qual.pages.median)) {
    lines.push('median ' + qual.pages.median + ' pages planned' +
      (Number.isFinite(qual.pages.min) && Number.isFinite(qual.pages.max)
        ? ' (range ' + qual.pages.min + '-' + qual.pages.max + ')' : ''));
  }
  if (qual.latencyMs && Number.isFinite(qual.latencyMs.mean)) {
    // Named against the shipping default so the number means something without
    // this function having to make a comparative CLAIM about it.
    lines.push('mean ' + formatDuration(qual.latencyMs.mean) + ' per call' +
      ' (the model this app ships averages about 53 s)');
  }
  // MONEY IS TRI-STATE. A missing figure renders as nothing at all — never as
  // $0.00, which is the v3.15.0 defect where a fact and its absence were the
  // same value. `spendUsd === 0` with runs completed is a REAL zero (a free
  // model) and says so.
  if (Number.isFinite(qual.spendUsd)) {
    // formatUsdHonest, never a local toFixed: this app has ONE money formatter
    // (shared/format-usd.js, imported and never copied) precisely so a non-zero
    // cost can never render as $0.0000. A second hand-rolled formatter is the
    // v3.9.0 defect, and an existing class invariant in the picker suite catches
    // it — which is how this line was found.
    lines.push(qual.spendUsd === 0
      ? 'cost nothing'
      : 'cost ' + formatUsdHonest(qual.spendUsd) +
        (qual.spendIsLowerBound ? ' (a floor — some runs were served from an upstream cache)' : '') +
        (qual.spendComplete === false ? ' (a floor — not every run reported a cost)' : ''));
  }

  let headline;
  let cls;
  if (qual.outcome === 'NO_DEFECT_FOUND' && qual.qualifies) {
    headline = 'No defect found in ' + completed + ' runs on your "' + qual.domain + '" wiki.';
    cls = 'model-qual-clean';
  } else if (qual.outcome === 'NO_DEFECT_FOUND') {
    // Clean, but short of the bar — say WHICH, rather than letting a clean
    // result look like a refusal for an unstated reason.
    headline = 'No defect found, but only ' + completed + ' of the ' + minRuns +
      ' runs needed before a model can build your wiki.';
    cls = 'model-qual-short';
  } else if (qual.outcome === 'DEFECT_OBSERVED') {
    headline = 'Failed on your "' + qual.domain + '" wiki: ' +
      (num(c.unrepairable) ? num(c.unrepairable) + ' of ' + completed + ' runs returned JSON that could not be repaired'
        : num(c.unusable) ? num(c.unusable) + ' of ' + completed + ' runs returned JSON with no usable page list'
        : 'the run could not be completed') +
      (qual.aborted ? ' — stopped early' : '') + '.';
    cls = 'model-qual-defect';
  } else {
    // NOT_MEASURED. A rate limit is NOT a defect and NOT a pass, and the
    // difference matters: free ids draw on a shared upstream pool, so this is a
    // fact about the queue rather than about the model.
    headline = 'Not measured — the provider rate-limited the run, which says nothing about the model.';
    cls = 'model-qual-unmeasured';
  }

  // ── THE CAVEAT IS PART OF THE RESULT, NOT A FOOTNOTE ─────────────────────
  // Rendered on screen rather than left in a comment, because the number this
  // panel shows is exactly the number a user would otherwise over-read.
  const caveat = (qual.outcome === 'NO_DEFECT_FOUND')
    ? '<p class="model-qual-caveat">This is a screen, not a guarantee: ' + completed +
      ' clean runs are still consistent with a failure rate as high as about ' +
      Math.round(300 / Math.max(1, completed)) + '% . It also describes this wiki at this moment — ' +
      'the model routes over upstream hosts that can change.</p>'
    : '';

  const stale = qual.stillOffered === false
    ? '<p class="model-qual-caveat">This model is no longer in your synced model list, so the ' +
      'measurement no longer applies. It is kept here rather than deleted, because you paid for it.</p>'
    : '';

  const measuredWhen = formatSyncedAt(qual.measuredAt);

  return (
    '<div class="model-qual ' + cls + '">' +
      '<p class="model-qual-head">' + escapeHtml(headline) + '</p>' +
      '<p class="mono model-qual-facts">' + escapeHtml(lines.join(' · ')) + '</p>' +
      '<p class="model-qual-stamp">Measured against <code class="mono">' + escapeHtml(String(qual.domain || '')) +
        '</code>' + (qual.sourceName ? ' using <code class="mono">' + escapeHtml(qual.sourceName) + '</code>' : '') +
        // ── AN INSTANT, THROUGH THE INSTANT FORMATTER ──────────────────
        // `measuredAt` is `new Date(now()).toISOString()` — a point in time,
        // not a calendar day — so `formatIsoDay` (which matches YYYY-MM-DD and
        // returns its input untouched otherwise) rendered a raw
        // `2026-08-28T09:58:37.225Z` at the user, beside a catalogue date that
        // reads "28 Aug 2026, 12:01". formatSyncedAt is that same helper, not a
        // second hand-rolled formatter: this app has one date function per KIND
        // of value, and "when did this happen" is the instant kind. Guarded on
        // the FORMATTED value, because formatSyncedAt returns '' on unparseable
        // input and ' on .' would be worse than saying nothing.
        (measuredWhen ? ' on ' + escapeHtml(measuredWhen) : '') + '.</p>' +
      caveat + stale +
    '</div>'
  );
}

/**
 * The live panel: the cost/time confirm, the running probe, or the outcome.
 *
 * ── TIME LEADS THE CONFIRM, AND MONEY FOLLOWS ─────────────────────────────
 * Nine runs cost roughly $0.08-$0.38 and take anywhere from ~6 minutes to
 * ~57, because measured per-call latency spans 38 s to 382 s. Money is not the
 * binding constraint here; a user quoted only a price will start a run they
 * cannot afford in the only currency that matters. The range is honest about
 * being a range — we cannot predict a specific model's speed until we measure
 * it, which is the whole point — and the moment run 1 lands the panel switches
 * to a projection derived from that actual measurement.
 */
function renderQualifyPanel(q, minRuns) {
  if (!q) return '';
  if (q.error) {
    return '<div class="model-qual model-qual-defect"><p class="model-qual-head">' +
      escapeHtml(q.error) + '</p></div>';
  }
  if (q.phase === 'estimating') {
    return '<div class="model-qual"><p class="model-qual-head">Working out what this would cost…</p></div>';
  }
  if (q.phase === 'confirm') {
    const e = q.estimate || {};
    const t = e.time || {};
    const cost = e.cost || {};
    const costLine = cost.kind === 'free'
      ? 'It costs nothing — this model is free.'
      : cost.kind === 'priced'
        ? 'About ' + formatUsdHonest(Number(cost.usd)) + ' — ' + escapeHtml(String(cost.note || ''))
        // NEVER $0.00 for an unpriced model. "We have no price" and "it is
        // free" are different facts and this is the one that must not be
        // rendered as a number.
        : 'The cost cannot be estimated — no price is published for this model.';
    return (
      '<div class="model-qual model-qual-confirm">' +
        '<p class="model-qual-head">Measure this model against your wiki?</p>' +
        '<p class="model-qual-facts">It will run the real ingest planning prompt ' +
          escapeHtml(String(e.runs || minRuns)) + ' times against your <code class="mono">' +
          escapeHtml(String(e.domain || '')) + '</code> wiki (' +
          escapeHtml(String(e.promptChars || 0)) + ' characters per run, built from your own index and ' +
          'page list) and report exactly what came back. It writes nothing.</p>' +
        '<p class="model-qual-time"><strong>Time: roughly ' +
          escapeHtml(String(Math.round((t.fastestSeconds || 0) / 60))) + ' to ' +
          escapeHtml(String(Math.round((t.slowestSeconds || 0) / 60))) + ' minutes.</strong> ' +
          escapeHtml(String(t.note || '')) + '</p>' +
        '<p class="model-qual-cost">' + costLine + '</p>' +
        (q.estimate && q.estimate.existing
          // Same instant-vs-day rule as renderQualification's stamp above: an
          // ISO instant through formatIsoDay renders raw at the user. Fixed
          // here in the same change rather than left as the one surviving
          // instance of a class — that is this repo's named
          // guard-applied-to-an-instance shape.
          ? '<p class="model-qual-caveat">You already measured this model' +
            (formatSyncedAt(q.estimate.existing.measuredAt)
              ? ' on ' + escapeHtml(formatSyncedAt(q.estimate.existing.measuredAt)) : '') +
            '. Running again replaces that result.</p>'
          : '') +
        // The ids are what preserveMainScroll() restores focus BY — the node
        // itself cannot survive innerHTML replacement, and this panel
        // re-renders on every phase change and on every completed run. Only
        // one qualification panel can exist at a time (state.qualify is a
        // single object, not a per-model map), so these are unique.
        '<div class="model-qual-actions">' +
          '<button type="button" class="btn btn-primary btn-xs" id="qualify-go" data-qualify-go="' +
            escapeHtml(String(q.modelId)) + '">Start</button>' +
          '<button type="button" class="btn btn-secondary btn-xs" id="qualify-cancel" data-qualify-cancel="1">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }
  if (q.phase === 'running') {
    const done = (q.runs || []).length;
    const total = (q.estimate && q.estimate.runs) || minRuns;
    const last = done ? q.runs[done - 1] : null;
    const eta = last && Number.isFinite(last.etaMs) ? formatDuration(last.etaMs) : null;
    return (
      '<div class="model-qual model-qual-running">' +
        '<p class="model-qual-head">Run ' + escapeHtml(String(done)) + ' of ' +
          escapeHtml(String(total)) + '…' +
          // A projection from the runs that have ACTUALLY happened, which
          // replaces the pre-run range as soon as there is any evidence.
          (eta ? ' about ' + escapeHtml(eta) + ' left' : '') + '</p>' +
        '<p class="mono model-qual-facts">' +
          escapeHtml((q.runs || []).map(r =>
            r.outcome === 'COMPLETED'
              ? (r.usable ? r.parseClass + '/' + r.pageCount + 'p' : (r.parseClass || '?') + '/UNUSABLE')
              : r.outcome).join('  ')) +
        '</p>' +
        '<div class="model-qual-actions">' +
          // Re-rendered once per completed run (each can take minutes), so
          // without a stable id a keyboard user loses focus repeatedly while
          // watching it. See the ids on the confirm panel's buttons above.
          '<button type="button" class="btn btn-secondary btn-xs" id="qualify-stop" data-qualify-stop="1">Stop</button>' +
        '</div>' +
      '</div>'
    );
  }
  return '';
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

  // ── THE LANE, RESOLVED ONCE FOR THE WHOLE ROW ────────────────────────
  // Every claim below about what this model may be used FOR reads `lane`.
  // Nothing here re-tests `suitability` or `jsonRaw` for a lane purpose, and
  // nothing re-derives "is it locally qualified" — that is what let the badge,
  // the note and the control drift into contradicting each other. See
  // modelLaneOf.
  const qual = qualificationFor(c, m);
  const lane = modelLaneOf(m, qual);
  const buildsWiki = laneBuildsWiki(lane);
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
  // `chat-only` is a LANE claim, so it is derived from `lane` and never read
  // straight off `suitability` — that direct read is precisely what stamped
  // "chat only — not for ingest" on a model the user had qualified and the app
  // was running ingest with. Every OTHER suitability value ('caution') is an
  // independent axis about quality rather than lane, and is read as before.
  const suitabilityBadge = m.suitability === 'chat-only'
    ? (buildsWiki ? '' : MODEL_SUITABILITY_BADGES['chat-only'])
    : MODEL_SUITABILITY_BADGES[m.suitability];
  if (suitabilityBadge) {
    badges.push('<span class="model-badge model-badge-flag">' + escapeHtml(suitabilityBadge) + '</span>');
  }
  if (m.dominated) {
    badges.push('<span class="model-badge model-badge-flag">out-performed</span>');
  }
  // ── "WE MEASURED IT AND IT FAILED" vs "WE HAVE NEVER MEASURED IT" ───────
  // Both are chat-only and the badge above says so for both, but they are
  // different claims and a user weighing a model deserves to know which one
  // they are reading. `jsonRaw === null` is llm.js's own documented marker
  // for NOT MEASURED — legal only on a chat-only entry, precisely so a null
  // can never be read as `false` ("measured bad"). Every hand-measured entry
  // carries a boolean (gemini-3.5-flash-lite is `false`, with nine live runs
  // behind it), while a runtime-admitted entry cannot carry one, because
  // nobody ran the probe.
  //
  // WHY THIS IS A MEASUREMENT TEST AND NOT A PROVENANCE TEST. There is no
  // field on the wire that says "this entry was fetched" — `defineOfferableModel`
  // does not put `dynamic` on the frozen entry. Asserting provenance would
  // therefore be an inference; asserting measurement is just reading the field
  // for what its own docblock says it means. It also stays true if the two
  // ever come apart: a hand-typed chat-only entry that omitted `jsonRaw` would
  // be badged unmeasured, which it would BE.
  // ── THE THIRD CLAIM, AND IT MUST NEVER LOOK LIKE THE FIRST ─────────────
  // A model the USER measured on their OWN wiki carries a badge of its own,
  // never the hand-measured vocabulary. "We measured this across documents and
  // against its siblings" and "you ran nine of these last Tuesday" are
  // different epistemic claims, and the whole reason the build lane grew a
  // THIRD state rather than widening `suitability` is so this screen can keep
  // them apart. A locally-qualified model still reports `suitability:
  // 'chat-only'` on the wire; only this badge and the control below change.
  if (lane === MODEL_LANES.BUILD_LOCAL) {
    badges.push('<span class="model-badge model-badge-local">you measured this on your wiki</span>');
  } else if (lane === MODEL_LANES.CHAT_UNMEASURED) {
    badges.push('<span class="model-badge model-badge-unmeasured">never measured here</span>');
  }
  // A record that found a DEFECT is the single most valuable thing this feature
  // produces — `z-ai/glm-4.7` returned unrepairable JSON in 9 of 9 runs while
  // passing every structural filter the app has — so it is badged on the row
  // itself, not folded away behind the expand with the rest of the evidence.
  if (qual && !qual.qualifies && qual.outcome === 'DEFECT_OBSERVED') {
    badges.push('<span class="model-badge model-badge-flag">failed on your wiki</span>');
  }

  // ── FREE is a REPORTED fact, checked ahead of the price fields ──────────
  // `m.free === true` is llm.js's own catalogue fact that this model bills
  // nothing (see FREE_MODELS in src/brain/llm.js) — a free model's
  // `input`/`output` are `null` BY DESIGN, never `0`, precisely so nothing
  // downstream can mistake "known to be free" for a truthy zero (the
  // v3.3.0 shape, where `{input:0,output:0}` made a budget cap inert).
  // `formatModelPrice` therefore correctly renders '' for a free model too
  // (it only ever sees the null price, never the flag) — so branching on
  // `m.free` is the ONLY way to tell "known to be free" apart from "price
  // unknown", which is a DIFFERENT fact and must go on rendering as blank
  // rather than being read as free. Never branch on a price of zero, a
  // provider id, or an id substring like ":free" — see llm.js's own
  // FREE_MODELS docblock for why a `:free` suffix is not a safe test (a
  // router id and two audio models are zero-priced but not actually free).
  // A fourth provider's free tier inherits this with no edit here.
  const price = formatModelPrice(m.input, m.output);
  const priceHtml = m.free === true
    ? '<span class="mono model-price">free</span>'
    : (price
        ? '<span class="mono model-price">' + escapeHtml(price) +
            '<span class="model-price-unit"> /1M tokens</span></span>'
        : '');

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

  // ── THE NOTE, MINUS ANY LANE CLAIM THIS ROW'S OWN EVIDENCE OVERTURNS ──
  // Notes are shown VERBATIM everywhere else, and that rule stands: only the
  // BUILD_LOCAL row filters, and it removes only the sentence saying nobody has
  // measured this model for ingest — which the measurement rendered directly
  // beneath it disproves. Every other fact in the note (free-tier data-policy
  // gating, hidden reasoning tokens billed as output) is money-relevant, is
  // untouched by a local run, and survives. See withoutLaneClaim.
  const noteText = lane === MODEL_LANES.BUILD_LOCAL
    ? withoutLaneClaim(m.note)
    : (typeof m.note === 'string' ? m.note : '');
  const noteHtml = noteText.trim()
    ? '<p class="model-note">' + escapeHtml(noteText) + '</p>'
    : '';

  // The user's own measurement, and the live panel if this is the row being
  // measured right now. Both live in the row BODY (behind the expand) except
  // while a probe is running, which renderModelOption's caller forces open.
  const qualHtml = renderQualification(qual, c.minRuns) +
    ((c.qualify && c.qualify.modelId === m.id) ? renderQualifyPanel(c.qualify, c.minRuns) : '');

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
  // ── THE COLLAPSED ROW MUST STAND ON ITS OWN ─────────────────────────────
  // The note is folded, so a row that showed only a badge would state a verdict
  // ('caution', 'out-performed') with its reason one click away — and a warning
  // you have to open something to discover is not a warning. This derived line
  // is what closes that: its first clause is `cautionReason`, which
  // `defineOfferableModel` REQUIRES for any flagged model, so the reason is
  // always unfolded. The rest is measured coverage and speed, read from
  // structured fields and omitted where nothing was measured.
  //
  // SHARED WITH THE COMPOSER, NOT COPIED. Both pickers import the same builder
  // (shared/model-summary.js), so the two surfaces cannot come to describe one
  // model differently — the drift that put 'dominated' on one screen and
  // 'out-performed' on the other, and that this file's own badge comment can
  // only ask the next editor to avoid.
  //
  // NOT FILTERED FOR A LOCALLY-QUALIFIED ROW, unlike `noteHtml` above.
  // `withoutLaneClaim` removes only the sentence saying nobody has measured this
  // model for ingest, which a local run disproves. `cautionReason` never makes a
  // lane claim: it records what WE measured (gemini-3.5-flash-lite returned
  // unrepairable JSON in 2 of 9 ingest runs), which stays true however many runs
  // the user does on their own wiki.
  const derived = formatModelSummary(m);
  const derivedHtml = derived
    ? '<span class="model-row-line model-row-derived">' + escapeHtml(derived) + '</span>'
    : '';
  // Declared HERE, above its FIRST use. It was previously declared further
  // down, next to the Test button — and adding a second use above that
  // point (the row's data-model-row) put the earlier use in the const's
  // temporal dead zone: a ReferenceError at render time that `node --check`
  // cannot see, because it is a runtime error and not a syntax error.
  const idAttr = escapeHtml(String(m.id === undefined || m.id === null ? '' : m.id));
  const expandable = factsHtml || noteHtml || qualHtml;
  const summaryInner = (
    '<span class="model-row-line">' +
      icon('chevronRight', 11) +
      '<span class="model-name">' + escapeHtml(m.label || m.id || '') + '</span>' +
      '<code class="mono model-id">' + escapeHtml(m.id || '') + '</code>' +
      badges.join('') +
    '</span>' +
    derivedHtml +
    '<span class="model-row-line model-row-cost">' + priceHtml + riseHtml + '</span>'
  );

  const inner = expandable
    // ── THE PANEL MUST BE VISIBLE WHERE THE USER CLICKED ─────────────────
    // The Test button is a SIBLING of this <details> (see the control block
    // below for why it has to be), so without forcing the row open the confirm,
    // the progress and the result would all render inside a collapsed
    // disclosure — a click that appears to do nothing. That is the v3.8.0 shape
    // this repo has already shipped once, where a refusal rendered behind an
    // overlay and the user read it as "my click didn't register" and clicked
    // again. Forced open only while THIS row is the one being measured.
    // OPEN IF THE USER OPENED IT, **OR** IF THIS IS THE ROW BEING MEASURED.
    // The two are independent and the forced arm must stay: a qualification
    // the user started from the button (a SIBLING of this disclosure) has to
    // be visible even on a row they never expanded.
    ? '<details class="model-row" data-model-row="' + idAttr + '"' +
        (((c.qualify && c.qualify.modelId === m.id) || state.modelRowOpen[m.id] === true) ? ' open' : '') + '>' +
        '<summary class="model-row-summary">' + summaryInner + '</summary>' +
        '<div class="model-row-body">' + factsHtml + noteHtml + qualHtml + '</div>' +
      '</details>'
    // No evidence to show — render the same row WITHOUT a disclosure rather
    // than an expander that opens onto nothing.
    : '<div class="model-row model-row-flat">' + summaryInner + '</div>';
  // NOTE: `expandable` above includes qualHtml, so the flat arm is only ever
  // reached when there is no qualification to show. Stated rather than assumed,
  // because a later edit that drops qualHtml from `expandable` would silently
  // render a measurement nowhere — this repo's named dead-data shape.

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
  const isPending = !!(c.busyId && c.busyId === c.provider + '::' + m.id);
  let control;
  if (isSelected) {
    // No button at all on the model already pinned. A control whose only
    // outcome is re-writing the value it already has invites a click that
    // does nothing, and — while a write is running — a click that is refused
    // for no reason the user can act on.
    control = '<span class="model-pick-state">Selected</span>';
  } else if (!buildsWiki) {
    // ── NO BUILD CONTROL ON A MODEL THE SERVER WILL REFUSE ─────────────────
    // This button pins the model that builds the wiki, and
    // `POST /api/config/api-keys/model` 400s on a chat-only id
    // (isBuildLaneAllowed). Rendering the button anyway would offer a control
    // whose only possible outcome is a refusal — which is worse than no
    // control, because the refusal reads as the picker being broken rather
    // than as the rule it is. So the row states the rule where the button
    // would have been, and names where the model IS usable.
    //
    // Derived from `lane` — which mirrors `isBuildLaneModel`, the server's own
    // gate, disjunct for disjunct — so the two cannot drift into disagreeing
    // about a given model. This branch is where the `&& !locallyQualified` used
    // to live ALONE: it was correct here and absent from the badge, the note
    // and the lane grouping, which is how one row came to claim both lanes.
    //
    // ORDERED AFTER `isSelected` deliberately. A chat-only id can no longer
    // be written as a pin, but a selection stored before that gate existed
    // would still arrive on the wire, and reporting a stored fact is never a
    // lie — llm.js re-checks at read time, so such a pin does not govern
    // anything. Hiding it would hide the only evidence it is there.
    // ── THE WAY OUT, WHERE THE DEAD END USED TO BE ────────────────────────
    // A row that only ever says "no" is where a user gives up. For an
    // OpenRouter model NOBODY HAS MEASURED (`jsonRaw === null`) there is now a
    // real answer: measure it against this wiki. The button is offered ONLY on
    // that exact shape, because the server's gate is the same shape — a model
    // WE measured and found unfit (`gemini-3.5-flash-lite`, jsonRaw false)
    // stays a dead end, and offering a button whose only outcome is a refusal
    // is worse than offering none.
    const canMeasure = c.provider === 'openrouter' && lane === MODEL_LANES.CHAT_UNMEASURED;
    const measuring = !!(c.qualify && c.qualify.modelId === m.id);
    const measureBtn = canMeasure
      ? '<button type="button" class="btn btn-secondary btn-xs model-qualify-btn"' +
          ' data-qualify-model="' + idAttr + '"' +
          (measuring || c.pickDisabled ? ' disabled' : '') +
          '>' + escapeHtml(qual ? 'Test again' : 'Test on my wiki') + '</button>'
      : '';
    control = '<span class="model-pick-state model-pick-state-chat"' +
      ' title="' + escapeHtml('This model has not been measured for ingest, Health scans or Compile, ' +
        'so it cannot be set as the model that builds your wiki. Pick it per message in the chat composer instead.') +
      '">chat only</span>' + measureBtn;
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
    '<p class="view-body">Exposes your graph to any MCP client — twenty tools: fifteen that read your wiki, ' +
    'and five that write to it (compiling a conversation into pages, saving an agent\'s working state, and fixing health issues) without leaving ' +
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
      // The wrapper is required, not decorative: it is what the CSS-drawn
      // chevron is positioned against, now that `appearance: none` has
      // removed the UA's own indicator. See .settings-select-wrap in
      // settings.css for what is replaced and what stays native.
      '<span class="settings-select-wrap">' +
        '<select class="settings-select mono" id="select-default-domain"' + (state.defaultDomainSaving ? ' disabled' : '') + '>' + options + '</select>' +
      '</span>' +
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
      // THE ONE PLACE THAT DOES NOT PRESERVE SCROLL, and the reason
      // render() preserves everywhere else rather than resetting: this is
      // the only transition to a DIFFERENT destination. Carrying an offset
      // from Providers (a very long section) into Health (a short one)
      // would land the user mid-page in something they have never seen, or
      // be clamped to a bottom that means nothing to them. Ordered AFTER
      // render() because render() restores the old offset first.
      resetMainScroll();
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
  // Scoped by the presence of data-theme-choice rather than by class: the
  // text-size buttons reuse .theme-seg-btn for its look, and a bare
  // `.theme-seg-btn` selector would bind the theme handler to them too —
  // `requestTheme(undefined)` then falls through to the light branch, so
  // picking a text size would silently switch the theme.
  document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
    btn.addEventListener('click', () => requestTheme(btn.dataset.themeChoice));
  });

  // Text size. setFontScale applies AND persists, and normalises anything
  // it does not recognise, so a hand-edited data attribute cannot get a
  // junk value into the CSS custom property. render() afterwards re-marks
  // the active button — and because render() preserves scroll position,
  // choosing a size does not move the page out from under the control that
  // was just clicked, which at the largest setting it otherwise would.
  document.querySelectorAll('[data-font-scale]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setFontScale(btn.dataset.fontScale);
      render(myMountToken);
    });
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
  // Individual model rows, same contract one level down: record, never
  // re-render (see the note above — repainting here would throw away the DOM
  // the user is looking at). Recorded so the next repaint, which the user did
  // not ask for, does not close what they opened.
  document.querySelectorAll('[data-model-row]').forEach((el) => {
    el.addEventListener('toggle', () => {
      if (el.open) state.modelRowOpen[el.dataset.modelRow] = true;
      else delete state.modelRowOpen[el.dataset.modelRow];
    });
  });
  // ── THE FILTER CONTROLS ────────────────────────────────────────────────
  // `input`, not `change`, so the list narrows as you type — the whole point of
  // a search box at 190 rows.
  //
  // FOCUS IS RESTORED BY ID AFTER THE RE-RENDER. render() replaces the subtree,
  // so the element the user is typing into is destroyed on every keystroke and
  // focus would fall to <body>. Restoring by SELECTOR rather than by holding the
  // node is the only thing that works, because the captured node cannot survive
  // the replacement — the v3.8.0 lesson, where an a11y defect was reachable only
  // on the accessible path. The caret is restored too, so typing mid-string
  // does not jump to the end.
  document.querySelectorAll('[data-model-filter-q]').forEach((el) => {
    el.addEventListener('input', () => {
      const pid = el.dataset.modelFilterQ;
      const caret = el.selectionStart;
      setModelFilter(pid, { q: el.value });
      render(myMountToken);
      const again = document.querySelector('[data-model-filter-q="' + cssEscapeAttr(pid) + '"]');
      if (again) {
        again.focus();
        try { again.setSelectionRange(caret, caret); } catch { /* not all inputs support it */ }
      }
    });
  });
  document.querySelectorAll('[data-model-filter-sort]').forEach((el) => {
    el.addEventListener('change', () => {
      setModelFilter(el.dataset.modelFilterSort, { sort: el.value });
      render(myMountToken);
    });
  });
  document.querySelectorAll('[data-model-filter-measured]').forEach((el) => {
    el.addEventListener('change', () => {
      setModelFilter(el.dataset.modelFilterMeasured, { measuredOnly: !!el.checked });
      render(myMountToken);
    });
  });
  document.querySelectorAll('[data-model-filter-clear]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Clears every axis, not just the search text: the empty state can be
      // caused by the checkbox alone, and a "Clear filters" button that leaves
      // one filter applied is the control that looks broken.
      setModelFilter(btn.dataset.modelFilterClear, { q: '', measuredOnly: false });
      render(myMountToken);
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
  document.querySelectorAll('[data-test-key]').forEach((btn) => {
    btn.addEventListener('click', () => onTestKey(btn.dataset.testKey, myMountToken));
  });
  document.querySelectorAll('[data-sync-catalogue]').forEach((btn) => {
    btn.addEventListener('click', () => onSyncCatalogue(btn.dataset.syncCatalogue, myMountToken));
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
  // ── THE PROBE CONTROLS ────────────────────────────────────────────────────
  // Four separate attributes rather than one delegated handler with a mode
  // string: each control does a materially different thing (spend nothing /
  // spend / abandon / abort a live run), and a single dispatcher keyed on a
  // string is one typo away from Start behaving like Cancel.
  document.querySelectorAll('[data-qualify-model]').forEach((btn) => {
    btn.addEventListener('click', () => onQualifyEstimate(btn.dataset.qualifyModel, myMountToken));
  });
  document.querySelectorAll('[data-qualify-go]').forEach((btn) => {
    btn.addEventListener('click', () => onQualifyGo(btn.dataset.qualifyGo, myMountToken));
  });
  document.querySelectorAll('[data-qualify-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => onQualifyDismiss(myMountToken));
  });
  document.querySelectorAll('[data-qualify-stop]').forEach((btn) => {
    btn.addEventListener('click', () => onQualifyStop(myMountToken));
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
  // Cleared at the START of every key action, never only on the paths that
  // could set it: a notice explaining the LAST save must not still be on
  // screen next to the result of a different one. Disconnect and Set-active
  // both move the Active row, which is the exact thing the notice narrates.
  state.keysActivationNotice = null;
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
    //
    // NULL-PROTOTYPE. On a plain object literal
    // `SAVE_BODY_KEY_BY_PROVIDER['constructor']` returns a FUNCTION, which is
    // truthy — so the refusal below would not fire and `{ [bodyKey]: value }`
    // would POST the user's key under a garbage field name. Not reachable
    // today (provider comes off a button rendered from PROVIDER_ROWS), but
    // "an id absent from this table REFUSES to save" is the safety property
    // this comment asserts, and on a plain literal it is false for inherited
    // names. On the one screen where users hand us secrets, the guard should
    // be true as written rather than true only for the inputs we happen to
    // produce.
    const SAVE_BODY_KEY_BY_PROVIDER = Object.assign(Object.create(null), {
      gemini: 'geminiApiKey',
      anthropic: 'anthropicApiKey',
      // v3.15.0. Until this line existed, saving an OpenRouter key REFUSED
      // outright rather than guessing a field — which is the v3.10.1 fix
      // working exactly as designed, and is why adding the provider row
      // without this line could not have silently written into
      // `anthropicApiKey`. Keep that property for the next provider: add the
      // row and this entry together, or not at all.
      openrouter: 'openrouterApiKey',
    });
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
    // The SAVE HAS SUCCEEDED by this point. Everything below is about
    // explaining the outcome, so an unreadable body must never be re-thrown as
    // a failed save — that would report a lost key the server actually stored,
    // which is worse than the silence this whole change exists to remove. An
    // unparseable body simply means we were told nothing, which
    // classifyActivationOutcome handles as its own case.
    let payload = null;
    try { payload = await res.json(); } catch { /* told nothing — see above */ }
    if (!isCurrentMount(token)) return;
    // Read from the POST's OWN response, not from state after the refetch
    // below: the verdict and the activeProvider it is judged against then come
    // from the same reply, so no concurrent write landing between the two
    // requests can make them disagree.
    const verdict = classifyActivationOutcome(payload, provider);
    state.keysActivationNotice = verdict.kind === 'silent' ? null : verdict;
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
  // Cleared at the START of every key action, never only on the paths that
  // could set it: a notice explaining the LAST save must not still be on
  // screen next to the result of a different one. Disconnect and Set-active
  // both move the Active row, which is the exact thing the notice narrates.
  state.keysActivationNotice = null;
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
  // Cleared at the START of every key action, never only on the paths that
  // could set it: a notice explaining the LAST save must not still be on
  // screen next to the result of a different one. Disconnect and Set-active
  // both move the Active row, which is the exact thing the notice narrates.
  state.keysActivationNotice = null;
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
 * Ask the server to check a saved key against the provider, and render the
 * verdict. READ-ONLY: nothing is written anywhere by this path.
 *
 * ── WHAT IS DELIBERATELY NOT SENT ────────────────────────────────────────
 * The route accepts an optional `apiKey` so an UNSAVED key can be checked
 * before committing it. This view does not use that arm, and the omission is
 * a choice rather than an oversight: it would add a second frontend request
 * shape that carries a raw credential in a JSON body, for the sake of saving
 * one click on a key that is about to be saved anyway. The existing rule on
 * this screen is that a secret leaves the field exactly once, on Save, and
 * never lingers in state afterwards (see state.replaceValue's comment). One
 * credential-carrying request is easier to keep honest than two.
 *
 * ── WHY THE VERDICT IS NOT DERIVED HERE ──────────────────────────────────
 * The whole payload is stored verbatim and read by the renderer. Classifying
 * it here would put a second opinion about `valid` in the frontend, and the
 * server's classification is the STRUCTURAL one — it keys off the numeric
 * HTTP status, which OpenRouter also echoes in `error.code`. Re-deriving it
 * from message text is precisely the substring-matching mistake this repo
 * made once before, when a `/\b429\b/` test matched its own error message's
 * "429 characters".
 *
 * A transport failure is recorded as the SAME `valid: null` shape the route
 * uses for its own could-not-check outcomes, so the renderer has one contract
 * and there is no fourth state that only exists when the fetch itself broke.
 */
async function onTestKey(provider, token) {
  state.keyTestBusy = provider;
  // Clear only THIS provider's previous verdict, and clear it before the
  // request rather than after: a stale "Key accepted" sitting under a
  // spinner, while a key that has since been revoked is being re-checked, is
  // a reassuring lie for as long as the request takes.
  state.keyTest = Object.assign({}, state.keyTest, { [provider]: null });
  render(token);
  let payload;
  try {
    const res = await fetch('/api/config/api-keys/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    // Read defensively and NEVER inside a throw — a non-JSON body (a proxy's
    // HTML error page) must produce a legible verdict, not an "Unexpected
    // token '<'". Same class this repo has fixed twice (v2.3.3, v3.6.0).
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (data && typeof data === 'object' && (res.ok || typeof data.valid !== 'undefined')) {
      payload = data;
    } else {
      payload = {
        valid: null,
        reason: 'bad_response',
        error: (data && typeof data.error === 'string' && data.error.trim())
          ? data.error.trim()
          : 'The server returned a response we could not read (HTTP ' + res.status + ').',
      };
    }
  } catch {
    payload = {
      valid: null,
      reason: 'unreachable',
      error: 'Could not reach The Curator’s own server to run the check.',
    };
  }
  if (!isCurrentMount(token)) return;
  state.keyTestBusy = null;
  state.keyTest = Object.assign({}, state.keyTest, { [provider]: payload });
  render(token);
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
/**
 * Step 1 of two: ask what a run would cost. FREE — no network call to the
 * provider, no LLM, no spend. Nothing is measured until the user presses Start.
 *
 * CONFIRM-BEFORE-SPEND is this app's established pattern (Health scans and the
 * ingest queue both do it) and it is more load-bearing here than in either,
 * because the cost that hurts is measured in minutes rather than cents.
 */
async function onQualifyEstimate(modelId, token) {
  if (typeof modelId !== 'string' || !modelId) return;
  // Opening the provider section is not cosmetic: the panel renders inside it,
  // and a confirm the user cannot see is the same as no confirm.
  state.modelPickerOpen.openrouter = true;
  state.qualify = { modelId, phase: 'estimating', runs: [] };
  render(token);
  try {
    const res = await fetch('/api/config/openrouter/qualify/estimate?model=' +
      encodeURIComponent(modelId));
    // Defensive body read: a 409 from a proxy, or any non-JSON response, must
    // still produce a legible message rather than "Unexpected token '<'" — the
    // class this repo has fixed twice (v2.3.3, v3.6.0).
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!isCurrentMount(token)) return;
    if (!res.ok) {
      state.qualify = { modelId, phase: 'error', runs: [], error: (data && data.error) || ('Could not work out the cost (HTTP ' + res.status + ').') };
    } else {
      state.qualify = { modelId, phase: 'confirm', runs: [], estimate: data };
    }
    render(token);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.qualify = { modelId, phase: 'error', runs: [], error: (err && err.message) || 'Could not work out the cost.' };
    render(token);
  }
}

/** Close the panel without spending anything. */
function onQualifyDismiss(token) {
  state.qualify = null;
  render(token);
}

/**
 * Stop a running probe.
 *
 * Aborting the fetch closes the SSE connection, and the SERVER reads that close
 * as the cancel — there is no separate cancel endpoint and therefore no run id
 * that could be got wrong or land on somebody else's run. A cancelled run is
 * NOT stored: it measured nothing conclusive, and persisting it would overwrite
 * a real earlier measurement with a stub.
 */
function onQualifyStop(token) {
  if (state.qualifyAbort) {
    try { state.qualifyAbort.abort(); } catch { /* already settled */ }
  }
  state.qualifyAbort = null;
  state.qualify = null;
  render(token);
}

/**
 * Step 2 of two: run the probe and stream the result.
 *
 * The panel updates per run rather than only at the end, because a run can take
 * the better part of an hour and a progress bar that only moves once is
 * indistinguishable from a hang — the report this app has already had about
 * Phase 1 of ingest.
 */
async function onQualifyGo(modelId, token) {
  const controller = new AbortController();
  state.qualifyAbort = controller;
  state.qualify = Object.assign({}, state.qualify, { modelId, phase: 'running', runs: [], error: null });
  render(token);

  try {
    const res = await fetch('/api/config/openrouter/qualify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (!isCurrentMount(token)) return;
      state.qualifyAbort = null;
      state.qualify = { modelId, phase: 'error', runs: [], error: (data && data.error) || ('The test could not start (HTTP ' + res.status + ').') };
      render(token);
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let type = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let ev = null;
          try { ev = JSON.parse(data); } catch { continue; }
          if (!isCurrentMount(token)) return;
          if (type === 'run') {
            state.qualify = Object.assign({}, state.qualify, {
              runs: (state.qualify && state.qualify.runs ? state.qualify.runs : []).concat([ev]),
            });
            render(token);
          } else if (type === 'stored') {
            state.qualifyAbort = null;
            state.qualify = null;
            // Refetch rather than trusting the stream's echo: `loadKeys` picks
            // up `qualifications` AND `models[provider]`, i.e. what llm.js will
            // now actually resolve. Reporting the request instead of the
            // outcome is this repo's named M3b shape.
            await loadKeys(token);
            return;
          } else if (type === 'error') {
            state.qualifyAbort = null;
            state.qualify = { modelId, phase: 'error', runs: [], error: ev.error || 'The test failed.' };
            render(token);
            return;
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    // The stream ended without a `stored` frame — the server hung up mid-run.
    if (!isCurrentMount(token)) return;
    state.qualifyAbort = null;
    if (state.qualify && state.qualify.phase === 'running') {
      state.qualify = { modelId, phase: 'error', runs: [], error: 'The test stopped before it finished. Nothing was recorded.' };
      render(token);
    }
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.qualifyAbort = null;
    // An abort is the USER stopping the run, not a failure — onQualifyStop has
    // already cleared the panel, so saying anything here would be reporting an
    // error for something that worked.
    if (err && (err.name === 'AbortError')) return;
    state.qualify = { modelId, phase: 'error', runs: [], error: (err && err.message) || 'The test failed.' };
    render(token);
  }
}

async function onPickModel(provider, modelId, token) {
  // Same refuse-rather-than-guess rule as onSaveKey's SAVE_BODY_KEY_BY_PROVIDER:
  // an id we do not recognise must not be POSTed. Under-writing is
  // recoverable; writing a selection into some other provider's slot is not
  // noticed until that provider starts billing differently.
  // Null-prototype: `KNOWN['constructor']` on a plain literal is truthy, so
  // the refusal below would be skipped for an inherited name and a model
  // selection would be POSTed under a provider the server does not know.
  const KNOWN = Object.assign(Object.create(null), {
    gemini: true,
    anthropic: true,
    // v3.15.0. Listed even though OpenRouter's catalogue is empty this
    // release and therefore renders no "Use this" button to reach this code:
    // the alternative is a table that disagrees with PROVIDER_ROWS, and a
    // provider that is savable but not choosable is a discrepancy the next
    // reader has to re-derive. The server is the real gate either way — it
    // refuses a model that is not offerable, so an empty catalogue means
    // every id is refused there regardless of what this table says.
    openrouter: true,
  });
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

/**
 * Compose the user-facing refusal for a failed catalogue refresh.
 *
 * Same shape and the same reasoning as `modelPickErrorMessage`: the route's
 * own message names the running operation, which is better information than
 * anything this file could compose, so it is used verbatim where present —
 * but it stops short of the fact the user most needs, which is that NOTHING
 * CHANGED. A refusal that only says "try again later" leaves them unsure
 * whether the list they are looking at is now half-updated, and the observed
 * consequence of an ambiguous refusal is a retry (v3.6.0).
 *
 * The fallbacks exist because a 409 can also arrive from a proxy or with a
 * non-JSON body, and a blank error box is the invisible-refusal failure again
 * in a smaller font.
 */
function catalogueSyncErrorMessage(status, data) {
  const fromServer = (data && typeof data.error === 'string' && data.error.trim())
    ? data.error.trim()
    : '';
  const isConflict = status === 409 || (data && data.conflict === 'write_in_progress');
  if (isConflict) {
    const base = fromServer ||
      'Cannot refresh the model list while a write operation is running.';
    return base + ' The model list was NOT changed — it is exactly as it was. ' +
      'Refreshing mid-run could pull the model that run is using.';
  }
  // ── EVERY ARM SAYS WHETHER THE LIST MOVED, not only the 409 ────────────
  // `modelPickErrorMessage` returns a non-conflict server message verbatim
  // and stops there, and that is defensible for a single pick: the row still
  // visibly shows the old selection, so "did it apply?" is answered on screen.
  // It is NOT defensible here. This control replaces a whole list, so the
  // first question on ANY failure — a 500, a rate limit, a dropped connection
  // — is "is the list I am looking at now half-updated?". Leaving that to
  // inference is the ambiguous-refusal shape whose observed consequence is a
  // retry (v3.6.0), and a retry here is another full catalogue fetch.
  //
  // The server's own wording still LEADS, because it is more specific than
  // anything this file could compose; the fact is appended, never substituted.
  const lead = fromServer || 'Could not refresh the model list.';
  const punctuated = /[.!?]$/.test(lead) ? lead : lead + '.';
  return punctuated + ' The model list is unchanged.';
}

/**
 * Refresh one provider's runtime model catalogue.
 *
 * THE INVARIANT, and it is the same one `onPickModel` holds: the rendered
 * list moves ONLY on the success path. There is no optimistic write into
 * `state.keys` anywhere below, and every failure path leaves it untouched, so
 * the previous list is still exactly what renders. That matters more here
 * than it does for a single pick, because the failure mode of getting it
 * wrong is an EMPTY list — and an empty list reads as "this provider has no
 * models available", which is a lie about capability rather than a missing
 * update.
 *
 * `loadKeys` is the only thing that moves it: the newly-admitted models
 * arrive on `GET /api/config/api-keys`'s `offerable` payload, not on this
 * response, so the response's counts are a REPORT and the refetch is the
 * update. Trusting the counts to describe the list would be two sources for
 * one fact.
 */
async function onSyncCatalogue(provider, token) {
  // Refuse rather than guess, exactly as onPickModel and onSaveKey do. Null
  // prototype: `KNOWN['constructor']` on a plain literal is truthy, so an
  // inherited name would skip the refusal below and POST to a route built for
  // a provider the server does not know.
  const KNOWN = Object.assign(Object.create(null), { openrouter: true });
  if (!KNOWN[provider]) {
    state.catalogueSyncError = Object.assign({}, state.catalogueSyncError, {
      [provider]: 'That provider does not publish a model list The Curator can refresh.',
    });
    render(token);
    return;
  }
  state.catalogueSyncBusy = provider;
  // Clear only THIS provider's stale refusal, and clear it BEFORE the
  // request: a refusal from a previous attempt sitting under a spinner reads
  // as the outcome of the attempt now running.
  state.catalogueSyncError = Object.assign({}, state.catalogueSyncError, { [provider]: '' });
  render(token);
  try {
    const res = await fetch('/api/config/openrouter/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    // Read the body defensively and NEVER inside a throw — a 409 from a proxy
    // or any non-JSON response must still produce a legible refusal rather
    // than an "Unexpected token '<'". The class this repo has fixed twice
    // (v2.3.3, v3.6.0).
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const message = catalogueSyncErrorMessage(res.status, data);
      if (!isCurrentMount(token)) return;
      state.catalogueSyncBusy = null;
      state.catalogueSyncError = Object.assign({}, state.catalogueSyncError, { [provider]: message });
      render(token);
      return;
    }
    if (!isCurrentMount(token)) return;
    state.catalogueSyncBusy = null;
    // Stored as WHAT THE SERVER SAID, field by field, with no defaulting. A
    // missing count stays missing so the renderer can decline to print it —
    // coercing an absent figure to 0 would turn "we were not told" into
    // "none", which is the fact-vs-its-absence collapse this release exists
    // to stop repeating.
    state.catalogueSync = Object.assign({}, state.catalogueSync, {
      [provider]: (data && typeof data === 'object') ? {
        syncedAt: data.syncedAt,
        total: data.total,
        eligible: data.eligible,
        admitted: data.admitted,
        refused: data.refused,
        superseded: data.superseded,
        // Stored as sent. `renderCatalogueSync` warns ONLY on an explicit
        // `false`, so an absent field stays absent and never becomes a claim
        // that saving failed.
        persisted: data.persisted,
        funnel: Array.isArray(data.funnel) ? data.funnel : null,
      } : {},
    });
    // The ONLY place the rendered list moves.
    await loadKeys(token);
  } catch (err) {
    if (isCurrentMount(token)) {
      state.catalogueSyncBusy = null;
      state.catalogueSyncError = Object.assign({}, state.catalogueSyncError, {
        [provider]: catalogueSyncErrorMessage(0, { error: err && err.message }),
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
