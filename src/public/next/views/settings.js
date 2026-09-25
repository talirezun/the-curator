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
// picker (only changes the MCP server's OWN fallback for FUTURE tool
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
  preserveMainScroll, resetMainScroll, revealInMain,
  currentFontScale, fontScaleOptions, setFontScale,
  consumeSettingsSection,
} from '../app.js';
// Overlay, not a view — same relationship views/shared.js has with
// views/shared-brain-wizard.js. It is opened from the MCP section's CTA and
// closed unconditionally by this view's teardown, so navigating away can
// never leave it mounted behind the next view.
import { renderListboxHtml, mountListbox, closeAllListboxes } from '../shared/listbox.js';
// MCP_GUIDE_URL is DECLARED THERE and is not imported here. Block ①'s link
// lives in its ⓘ: since v3.71.1 that is the `settings.mcp-connect` explainer's
// guide card (the user guide's "MCP bridge — connect a client", which links on
// to the MCP guide the wizard opens via `settings.mcp-bridge`).
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
// v3.72.1 — ONE price-per-1M formatter app-wide: the exact one Chat's model
// menu uses. formatUsdHonest stays for amounts spent (it rounds to cents).
import { formatPricePerM } from '../shared/model-row.js';
import { formatModelSummary } from '../shared/model-summary.js';
// ── THE AI JOBS, AS DATA (v3.67.0) ────────────────────────────────────────
// Block 2 ("Your AI model") derives its lede and its "Used by · N jobs" row
// from the registry, never from a hand list: adding a job to AI_JOBS moves the
// number on this screen. System check's run line is the shared kit's.
//
// WHY renderBuildBlock READS IT THROUGH A `typeof` GUARD. Five suites lift
// renderBuildBlock by brace-matching and execute it with an explicit list of
// injected collaborators; a module-level import is not visible inside a lifted
// body, so a bare `buildLaneJobs()` there would be a ReferenceError in the
// three that are not this package's (rule 10). `typeof` on an undeclared name
// does not throw, so those suites render the block without the row, and the
// two that own this block inject the REAL function and assert the row. In the
// browser the static import below always binds, so the guard is always true
// (test-next-providers-page.js pins the import AND drives the real rows).
import { buildLaneJobs } from '../shared/ai-jobs.js';
import { renderRunsOn, aiActionDisabledAttrs } from '../shared/ai-run.js';
// The ONE text system in /next (shared/text.js). This view was the largest
// carrier of the defect renderViewHeader removes: ~3,620 characters of static
// prose, a paragraph of it directly under the <h1> of four of the five
// sections. The header component has no parameter that can put it back.
// `renderReadout` was ALSO imported here, for the tool map's two session
// readings; v3.65.0 moved those into the monitor below, so this file takes the
// header alone. The readout keeps its name, its contract and its nine other
// call sites — the monitor emits its own line rather than re-laying-out one,
// because `.tx-readout` is a COLUMN (label above value) and no stylesheet but
// shared/text.css may declare a `.tx-` rule to turn it into a row.
import { renderViewHeader } from '../shared/text.js';
// G5 (v3.71.0, COPY.md §3): `general` was the one section with no entry in
// SECTION_INFO — Settings is where setup starts, and nothing said "begin in
// Providers & keys". Adds exactly that one entry; every other section keeps
// its own hand-written prose (P4 owns only SECTION_INFO.general).
import { explainerHtml, explainerMark } from '../shared/explainer.js';
// ── THE SIDEBAR, AND IT IS THE DOMAINS SIDEBAR ───────────────────────────
// Settings had the app's third answer to "a title, some actions, and a list
// you select from": rows 48.8px tall against Domains' 63.8, no action in the
// head at all (Updates sat in the FOOTER, beside the version string), and a
// selection drawn as a 2px violet `::before` bar that nothing else in the app
// used. The maintainer's words: *"the same goes for the Settings sidebar:
// follow the Domains pattern — use the Updates button, put it on top in the
// same design as Domains ... we don't need this line, it is a completely other
// design which got in during development."*
//
// `alias: 'settings'` keeps `settings-nav-list` / `settings-nav-row` /
// `row-label` / `row-hint` on the SAME elements, because this file's own click
// binder (`wireGlobalListeners`) and four suites address them by name.
import { renderSidebarHead, renderSidebarGroup, renderSidebarRow, identitySlotClass, domainIdentityClass } from '../shared/sidebar.js';
// ── THE DEPTH BAR'S IDENTITY TONE (v3.66.0) ───────────────────────────────
// The Vault folder's per-domain page bars take each domain's OWN colour, from
// the same palette and the same mapping as the identity dot beside them
// (design rule 5) — `depthIdentitySlotClass(slot)` and `identitySlotClass(slot)`
// both take the domain's RECORDED slot (v3.76.0), so there is no second
// mapping to drift.
import { depthIdentitySlotClass } from '../shared/depth-bar.js';
// ── THE MONITOR, for every LIVE-STATE reading on this screen ─────────────
// The bridge's connection strip, its stale-bridge warning, the self-test
// outcome and the two session readings were four hand-built treatments of one
// idea — *"these cards show specific data, the data that is changing ... it's
// really hard to understand that this is like a monitor into the specific data
// and changing state ... we are looking for a unified design AND a
// distinguished design."* views/sync.js's status card was a fifth, and was a
// near-byte copy of the first. One component now, and `views/sync.js` makes
// the same call shape.
import { renderMonitor } from '../shared/monitor.js';
// (v3.71.1: no direct docs-links import any more — every "Read more" on this
// screen is the guide card inside an explainer, keyed in shared/explainers.js.)
// The ONE age vocabulary and the ONE freshness scale (shared/age.js +
// shared/freshness.css). The tool map paints a dot and a WORD beside it, and
// the reason both come from here rather than from a table of this view's own
// is written at the top of age.js: a second threshold table is how a mark
// comes to say "today" while the words next to it say "1 week ago".
import { formatAge, freshnessTier } from '../shared/age.js';
// The design system's own progress component. REUSED rather than replaced by a
// new linear bar: it refuses to fill a phase that reports nothing, it carries
// the liveness cue during a long download, and its reduced-motion behaviour is
// already the deliberate one (rotation dropped, a 2.6s breath substituted).
// See renderInAppUpdate() for the full argument.
import { progressRingHtml } from '../shared/progress-ring.js';
// The update's phase vocabulary, ring mapping and byte formatting. Shared with
// `views/update-window.js` — the small window the menu-bar update path opens —
// so the two surfaces cannot word one operation differently. See that module's
// header for why it exists at all.
import {
  UPDATE_RING_STAGES, UPDATE_PHASE_COPY,
  updateRingPosition, updateProgressSublabel,
} from '../shared/update-phases.js';

/**
 * The sidebar's rows, IN ORDER — and the order is the whole content of this
 * array, so it is worth saying what it is ordered BY.
 *
 * ── REORDERED v3.49.0, on a power user's report ──────────────────────────
 * It ran General → Providers → MCP → Health → Knowledge base, which was the
 * order the sections happened to be built in. The complaint was that
 * Software update — the one thing a user comes back to Settings for again
 * and again — sat at the bottom of the screen. The rule now is HOW OFTEN a
 * person returns to it, with the two that are "set once and forget" last:
 *
 *   General          — the app itself, and Software update is its FIRST
 *                      block (see renderGeneral, which says why).
 *   Providers & keys — the AI, and the bill. Changed whenever a key or a
 *                      model changes.
 *   Knowledge base   — where the wiki lives. Read often when something looks
 *                      missing; moved UP from last for that reason.
 *   MCP bridge       — set up once per client, then left alone.
 *   Health & scan limits — cost ceilings, touched only when a scan refuses.
 *
 * THERE IS NO "Software update" ROW, and that is deliberate rather than an
 * omission: it is a multi-state panel with progress, errors, a restart and
 * its own recovery disclosure, it shares `state.version` and the install-mode
 * capability with the rest of General, and the sidebar footer's "Updates"
 * button already lands on it. Giving it a row would split General for a
 * panel that is already the first thing General shows.
 *
 * `freshState()` and onEnter's prefetch both read `SETTINGS_SECTIONS[0][0]`,
 * so the landing section follows this array and cannot drift from it —
 * pinned by scripts/test-next-settings-default-section.js.
 */
const SETTINGS_SECTIONS = [
  ['general',   'General',              'Software update, appearance'],
  ['providers', 'Providers & keys',     'Gemini, Anthropic, OpenRouter'], // v3.72.1 (audit F14): no local provider exists yet
  ['storage',   'Knowledge base',       'Vault folder, GitHub token'],
  ['mcp',       'MCP bridge',           'My Curator, default write domain'],
  ['health',    'Health & scan limits', 'Cost ceilings, candidate pairs'],
];

const SECTION_TITLES = Object.fromEntries(SETTINGS_SECTIONS.map(([id, label]) => [id, label]));

/**
 * What each section IS, in one place, behind the header's info mark.
 *
 * Every string here used to be a `<p class="view-body">` rendered as the first
 * thing inside its section body — i.e. a paragraph directly under the <h1>, on
 * four of the five sections. They are RELOCATED rather than cut: each explains
 * a model the screen below it does not (which of two jobs a key serves; that
 * the MCP bridge runs without the app; that a ceiling REFUSES rather than
 * truncates; that the folder is an Obsidian vault).
 *
 * `general` USED to be deliberately absent (every other section's copy hint
 * text sitting beside its own control, in-context labelling rather than a
 * view description) — G5 (v3.71.0, COPY.md §3) closes that gap: Settings is
 * where setup starts, and nothing on the section a user lands on first said
 * "begin in Providers & keys". Its entry is assigned separately, just below
 * this literal, rather than written inline in it: the literal below is pure
 * data (every other value a plain string), which `scripts/test-next-view-
 * header.js` §8 relies on to `eval` it standalone for the html-entry grid
 * check — a call to the shared `explainerHtml` inside the literal would make
 * that isolated eval throw on a free identifier it never injects.
 *
 * NOTHING THAT WARNS OR COSTS BELONGS HERE. The cross-write banner, the
 * fallback-model banner (a silent change to what the user is billed) and every
 * inline error stay in the body, unfolded, exactly where they were.
 */
const SECTION_INFO = Object.freeze({
  // v3.71.1: every section's ⓘ is a KEY into shared/explainers.js, never
  // prose — a section cannot carry a panel that is not an explainer. The
  // MCP entry's old tool count is gone (count tools from mcp/tools/index.js,
  // never from prose), and Health's entry also replaces its one block's ⓘ.
  general: 'settings.general',
  providers: 'settings.providers',
  mcp: 'settings.mcp',
  health: 'settings.health',
  storage: 'settings.storage',
});

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
// Dots for the three active providers read `--prov-*`, the SAME custom
// properties views/chat.css's model picker uses for its provider markers
// (both defined once, in shell.css — see the comment there). Before v3.24.3
// this table hand-picked its own colours (`--type-entity`/`--type-summary`/
// `--accent`) and diverged from chat.css's choices without anyone deciding
// it should: Anthropic rendered amber here (the "human attention required"
// status colour, `--type-summary`) and green in the chat model menu — same
// provider, two colours, on a screen a user visits back-to-back. Read
// shell.css for why amber is specifically wrong for a provider identity
// marker. `local` keeps `--text-faint` deliberately: it is not an active
// provider (see `available: false` below), so it is not part of the
// provider-family palette and has never needed a dedicated hue.
// ── `canQualify` — WHO HAS A "test it on my wiki" ROUTE ──────────────────
// A column rather than an `id === 'openrouter'` test at the call site, which is
// the rule this file states twice in its own words ("A LOOKUP, NEVER
// `p.id === 'openrouter'`", "the v3.10.1 rule … it is what lets a second
// provider with a fetchable catalogue land here with one added line") and then
// broke once, in renderModelOption. It answers exactly one question: does
// `POST /api/config/openrouter/qualify` exist for this provider — i.e. can a
// user promote one of its unmeasured models into the build lane by measuring it?
// Today only OpenRouter, because only OpenRouter ships an unmeasured catalogue;
// Gemini and Anthropic offer hand-measured tables where there is nothing for a
// user to measure. Absent ⇒ false ⇒ no button, which is the fail-safe direction:
// the server would refuse a qualify call for any other provider anyway, and an
// offered button whose only outcome is a 400 is worse than no button.
// ⚠ `available` MUST STAY THE LAST FIELD ON EVERY ROW.
// scripts/test-next-provider-colors-and-badge.js parses this table out of the
// SOURCE with a regex anchored on `available: (true|false)\s*\}`, so a field
// added after it makes that suite parse ZERO rows and fail with "found 0"
// rather than with anything naming the cause. Found the hard way when
// `canQualify` was first appended.
const PROVIDER_ROWS = [
  { id: 'gemini',     name: 'Gemini',      dot: 'var(--prov-gemini)',     canQualify: false, vendor: 'Google',                    available: true  },
  { id: 'anthropic',  name: 'Anthropic',   dot: 'var(--prov-anthropic)',  canQualify: false, vendor: 'Anthropic',                 available: true  },
  { id: 'openrouter', name: 'OpenRouter',  dot: 'var(--prov-openrouter)', canQualify: true,  vendor: 'One key onto many vendors', available: true  },
  { id: 'local',      name: 'Local model', dot: 'var(--text-faint)',      canQualify: false, vendor: 'Not built yet',             available: false },
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
  if (check.error) return { kind: 'error', message: String(check.error), style: updateStyleOf(check) };

  if (versionInfo && versionInfo.restartRequired) {
    return { kind: 'restart-required', running: versionInfo.version, onDisk: versionInfo.onDiskVersion,
      style: updateStyleOf(check) };
  }

  // THE FORK. `download-installer` cannot reuse the arm below, and not for
  // cosmetic reasons: that arm's "available" verdict ends in a button that
  // POSTs /api/config/update, which a packaged build answers 501 to. Its
  // "local-ahead" copy tells the reader to push their unpushed work, which is
  // nonsense to someone who installed a DMG. Same question, different app.
  if (updateStyleOf(check) === 'download-installer') return classifyInstallerUpdate(check);

  const cmp = compareSemver(check.current, check.latest);
  if (cmp > 0) {
    return { kind: 'local-ahead', current: check.current, latest: check.latest, style: 'git-pull' };
  }
  if (!check.updateAvailable) {
    return { kind: 'current', current: check.current, style: 'git-pull' };
  }
  return {
    kind: 'available',
    style: 'git-pull',
    current: check.current,
    latest: check.latest,
    localCommit: check.localCommit || null,
    remoteCommit: check.remoteCommit || null,
    // false when the versions match and only the commits differ — the label
    // has to read "v3.9.0 (abc → def)", not "v3.9.0 → v3.9.0".
    versionsDiffer: cmp < 0,
  };
}

/**
 * Which update mechanism a payload describes.
 *
 * ABSENT MEANS `git-pull`, deliberately. The repo arm of
 * `GET /api/config/update-check` is byte-identical to what it has always
 * returned — no field was added to it — so a missing `updateStyle` is the
 * normal, unchanged, overwhelmingly common case rather than an unknown. The
 * install's real capability is separately observable on `GET /api/version`
 * (`capabilities.updateStyle`); this function reads only what the CHECK said,
 * so the verdict describes the payload in hand and can never disagree with it.
 */
function updateStyleOf(check) {
  return (check && check.updateStyle === 'download-installer') ? 'download-installer' : 'git-pull';
}

/**
 * The `download-installer` verdicts. FOUR outcomes, and none of them shares
 * wording with another — this repo's rule that a fact and its ABSENCE are
 * never the same value:
 *
 *   no-release        nothing installable has been published yet
 *   unknown-version   a build exists; its version cannot be compared with ours
 *   local-ahead       we are newer than anything published
 *   current           we are on the newest installable build
 *   available         a newer installable build exists — here is its page
 *
 * The server has already decided all of this (it is the only side that can:
 * it read the release list). This function does NOT recompute the comparison
 * from `current`/`latest`, because a second, independent verdict on the client
 * is how a UI comes to contradict its own API. The git arm above recomputes
 * because it historically had to — the route used to get local-ahead wrong.
 */
function classifyInstallerUpdate(check) {
  const base = {
    style: 'download-installer',
    current: check.current,
    latest: check.latest || null,
    releaseUrl: typeof check.releaseUrl === 'string' ? check.releaseUrl : null,
    releasesPageUrl: typeof check.releasesPageUrl === 'string' ? check.releasesPageUrl : null,
    releaseName: typeof check.releaseName === 'string' ? check.releaseName : null,
    prerelease: check.prerelease === true,
  };
  if (check.noInstallableRelease) return { ...base, kind: 'no-release' };
  if (check.comparable === false) return { ...base, kind: 'unknown-version' };
  if (check.localAhead) return { ...base, kind: 'local-ahead' };
  if (!check.updateAvailable) return { ...base, kind: 'current' };
  return { ...base, kind: 'available' };
}

// ── The in-app updater: the decisions, as pure functions ─────────────────
// DOM-free and fetch-free for the same reason classifyUpdate() above is —
// scripts/test-update-in-app.js executes these directly rather than asserting
// on the shape of the markup that renders them.
//
// ── WHAT THE UPDATER IS AND WHY THIS EXISTS ──────────────────────────────
// A packaged install used to be told an update exists and handed a link to
// the download page; the maintainer did that by hand once and called it
// "terrible". The engine that downloads, verifies, stages, swaps and
// relaunches lives in the desktop shell; `POST /api/config/update` streams its
// progress and `POST /api/config/update/apply` finishes the job. This half
// turns that stream into something a person can read.

/** The five phases, the ring's segment names, the per-phase sentences, the
 *  ring-position mapping and the byte formatting all MOVED to
 *  `shared/update-phases.js` in v3.41.0, and are imported at the top of this
 *  file. They were moved rather than copied because the menu-bar updater
 *  window now draws the same ring from the same job record: a second copy of
 *  this vocabulary is the two-surfaces drift v3.36.0 is a whole release about.
 *  `updatesAreBusy` below stays here — it reads this view's own state. */

/**
 * Is the Software-update block busy enough that "Check for updates" must be
 * disabled?
 *
 * A pure function of the two states rather than an expression inside
 * `renderGeneral`, so it can be driven directly — an expression buried in a
 * 100-line render function is only reachable by rendering the whole section,
 * which is how a call site comes to be untested. Found by mutation: replacing
 * the in-app half with `false` was invisible until this existed.
 *
 * The in-app half matters for the same reason the git half does: re-checking
 * mid-install races the very process being replaced, and a fresh verdict drawn
 * over a live progress ring is a UI contradicting itself. `staged` and
 * `install-failed` are deliberately NOT busy — both are resting states where
 * re-checking is a reasonable thing to want.
 */
function updatesAreBusy(s, inApp) {
  const st = s || {};
  const gitBusy = !!st.updateChecking || st.updatePhase === 'applying' || st.updatePhase === 'restarting';
  const appBusy = !!inApp && (inApp.phase === 'streaming' || inApp.phase === 'relaunching');
  return gitBusy || appBusy;
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
    section: SETTINGS_SECTIONS[0][0], // the default IS whichever section is drawn first
    // One-shot: the sidebar's click handler sets it, the next renderMain reads
    // it and clears it, and a `content-reveal` class is put on the section body
    // for that one paint. FALSE on a fresh mount on purpose — arriving at
    // Settings is already animated by the shell's view-enter (app.js's
    // playViewEnter), and two enter animations on one paint is a stutter.
    sectionJustChanged: false,

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
    // Is the "Every model, by provider" reference shelf expanded? Same reason
    // as modelPickerOpen one level up: render() replaces the section wholesale,
    // so a native <details open> would be discarded on the next repaint — and
    // this section repaints on things the user did not do (the cross-view write
    // gate fires whenever an ingest starts or finishes anywhere). A shelf that
    // snapped shut mid-read, for no visible reason, would look like a bug.
    modelShelfOpen: false,
    // Block 2's "Used by" fold (v3.67.0). Closed on every mount.
    usedByOpen: false,
    // Block 2's `Change…` disclosure — the build-lane list. State-backed for
    // the same reason the shelf is: this section repaints on things the user
    // did not do, so a native <details open> would snap shut mid-read. It is
    // ALSO forced open by renderBuildList whenever a refusal or an in-flight
    // write belongs to a row inside it, and that override is deliberately not
    // written back here — a forced-open disclosure is a temporary state of the
    // page, not a preference the user expressed.
    buildListOpen: false,
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
    // Is a provider's "Chat only" LANE FOLD expanded? Keyed by provider id.
    //
    // Same reason as modelRowOpen one level up, and it was missing — which was
    // measured, not inferred: with 193 chat-only models the fold is where every
    // "Test on my wiki" button lives, so pressing one re-rendered the section,
    // the fold snapped shut, and the confirm panel the press exists to produce
    // rendered INSIDE a collapsed disclosure. The row's own `<details>` was
    // already forced open for exactly that reason (see renderModelOption); the
    // fold WRAPPING it was not, so the protection stopped one level short.
    // Browser-measured at 1280x900: Start/Cancel 1803px outside the scrollable
    // area, `#main.scrollTop` clamped 4691 -> 2880 as the document shrank, and
    // the row the user pressed no longer on screen at all.
    modelLaneOpen: {},
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
    // WHICH ROW the `build` refusal above belongs to, as '<provider>::<modelId>',
    // or '' when no row owns it (an unknown-provider refusal, which never
    // reached a row).
    //
    // IT EXISTS SO THE MESSAGE CAN BE RENDERED WHERE THE CLICK HAPPENED. The
    // build list is one cross-provider list ~19 rows long; the refusal used to
    // render once, at the TOP of the block, and a row chosen from below the fold
    // therefore announced its refusal off-screen — browser-measured at 1280x900
    // with a real ingest holding the write lock: the alert landed at y = -135,
    // -436 and -678 for three successively lower rows, the app did not scroll
    // (585 -> 585), the clicked button still read "Use this", and focus was on
    // <body>. That is v3.9.0's shape exactly, on a screen where the retry it
    // invites is a refused WRITE the user is choosing to be billed for.
    //
    // A KEY, NOT A BOOLEAN, because the message must follow the row and not
    // merely "the last click": the list re-renders on the cross-view write gate,
    // so the row that owns a message has to be identifiable after a repaint
    // nobody asked for. renderBuildBlock renders the block-level copy ONLY when
    // no candidate row matches, so the same refusal is never announced twice.
    modelPickErrorAt: '',
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
    // ── "Check model availability" (POST /api/config/models/check) ─────────
    // A READ. It asks a provider what it currently lists and reports the
    // answer; it writes nothing, so it has its own busy field rather than
    // borrowing keysBusy — the same reason keyTestBusy exists, and the reason
    // this control is not gated on the cross-view write lock.
    modelCheckBusy: null,
    // The last verdict per provider: {provider, checkedAt, source, chosen,
    // liveMissing, listedCount, error?}. Per provider, never one shared
    // object, so a verdict about one provider cannot be rendered against
    // another — the rule keyTest, catalogueSync and modelPickError all follow.
    modelCheck: {},
    modelCheckError: {},
    // Block 4's shortlist fold. Recorded, never re-rendered from — see the
    // <details> contract in wireProviderListeners.
    worthTestingOpen: false,
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
    // The elapsed clock's interval id, or null. It exists because the FIRST run
    // has no ETA to project from — `etaMs` is computed from runs that have
    // happened — and the slowest measured call is 382 s, so without it the
    // panel carries no number at all for up to six minutes. Cleared through
    // `stopQualifyClock` at every exit AND by the tick itself when the mount
    // has moved on.
    qualifyTickId: null,
    // Which browse-table rows have their evidence open, by model id. Recorded
    // rather than re-derived: render() replaces the section wholesale, so a
    // native `<details open>` is discarded on every repaint — and this table
    // repaints on a keystroke in the search box.
    browseRowOpen: {},

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
    defaultDomainError: null,

    // ── The tool map (block ③) ───────────────────────────────────────────
    // GET /api/mcp/usage. A SEPARATE field from `state.mcp` and a separately
    // tolerated failure: the bridge's own status must still render when the
    // call log cannot be read, because "which client is connected" is the
    // question this section exists for and the map is an observation about it.
    mcpUsage: null,
    mcpUsageError: null,
    // What the last payload PAINTS, as one comparable string. The 30s
    // revalidate repaints the block body only when this moves — see
    // usageSignature, which names the fields rather than stringifying the
    // whole envelope, so a field nobody draws cannot cost a repaint.
    mcpUsageSig: null,
    // ── "Test all N tools" (block ③'s control) ───────────────────────────
    // POST /api/mcp/exercise. Its OUTCOME is state rather than DOM, because
    // the 30 s revalidate replaces the block body and a result held only in
    // the markup would vanish at the next tick — which is the one tick that
    // is certain to fire right after a run, since the run moved the payload.
    mcpExercise: null,       // { ok, ranAt, durationMs, results, covered, missing }
    // ── ④ Across projects (v3.66.0) ──────────────────────────────────────
    // GET /api/mcp/usage?include=projects → `{byProject, byProjectWindow,
    // savePulse}`. Its OWN field, and read ONCE per section load, never by the
    // 30 s revalidate: the `include=projects` half walks the working-state
    // store and every usage log, which is why the route makes it opt-in, and a
    // 30-day reading does not move in 30 seconds.
    mcpProjects: null,
    mcpProjectsError: null,
    mcpExerciseBusy: false,
    mcpExerciseError: null,

    // Health & scan limits
    aiHealth: null,          // { costCeilingTokens, semanticDupeMaxPairs }
    aiHealthError: null,     // section FAILED TO LOAD — renderHealthLimits shows this INSTEAD of the form
    aiHealthSaving: false,
    aiHealthSaved: false,
    scanLimitsValidationError: null, // client-side "fix your input" error — rendered INSIDE the (still-visible) form; deliberately a separate field from aiHealthError, which replaces the whole form
    costCeilingInput: '',
    maxPairsInput: '',

    // Knowledge base
    // NOTE: `config` is shared with General — GET /api/config carries the
    // domains path AND `backgroundMode`/`backgroundModes`. One endpoint, one
    // cache, so the two sections cannot render different values for it.
    config: null,            // { domainsPath, domainsPathSource, backgroundMode, backgroundModes }
    configError: null,
    // Knowledge base → Vault folder → "Domains in this folder" (v3.66.0).
    // GET /api/domains/stats, in listDomains() order — which IS the install's
    // domain index the identity dot keys on. Rides loadConfig like ghToken.
    vaultDomains: null,      // [{slug, displayName, pageCount, index}]
    vaultDomainsError: null,
    pickingFolder: false,
    pathCopyFeedback: null,

    // Knowledge base → GitHub read-only token (v3.65.2). `ghToken` is the
    // route's STATUS — `{present, last4, kind}` — and never a value; the
    // typed value lives only in `ghTokenValue` while the input row is open,
    // and is set on the DOM as a live `.value` property, never as a `value=`
    // attribute (the provider rows' MEDIUM-2 rule). `ghTokenLoadError` means
    // the status could not be read; `ghTokenActionError` means one save or
    // disconnect failed and the block stays on screen.
    ghToken: null,
    ghTokenLoadError: null,
    ghTokenEditing: false,
    ghTokenValue: '',
    ghTokenBusy: null,        // 'save' | 'disconnect' | null
    ghTokenActionError: null,
    ghTokenRepo: '',          // the Test's repository field — not a secret
    ghTokenTestBusy: false,
    ghTokenTest: null,        // the test route's answer, verbatim

    // General → Menu bar. Kept apart from `configError` on purpose: that
    // field means "the section could not load"; these mean "this one save
    // failed", and the control stays on screen showing the mode still in
    // force rather than being replaced by an error.
    backgroundModeSaving: false,
    backgroundModeError: null,
  };
}

let state = freshState();

// Same discipline as chat.js/domains.js/sync.js — see the file-header
// comment above. Read fresh inside a handler invoked SYNCHRONOUSLY by a
// real click (safe: nothing can re-mount between the click firing and
// that line running); captured as a local BEFORE any await in every async
// function, and threaded through rather than re-derived afterward.
let myMountToken = 0;

// ── THE TOOL MAP'S AGE CLOCK ──────────────────────────────────────────────
// One second, because the map's freshest reading is "just now" and a widget
// that says "just now" for five minutes is not a widget. It costs one
// `Date.parse` per painted reading per second and asks the server nothing —
// the NETWORK cost is the separate, thirty-second revalidate. Conflating the
// two is how views/memory.js records the age clock nearly being lost.
const MCP_AGE_TICK_MS = 1000;
let ageTimer = null;

// Delay-gated loading indicator for this view's section loads. Built in
// onEnter, cancelled in the teardown. See shared/loading-gate.js.
//
// SCOPE, stated rather than implied: this gate enforces the DELAY half
// only. The four section loaders below each commit their state AND call
// render() themselves (they are also called directly by the save flows,
// which must repaint immediately), so a result landing between 200 ms and
// 600 ms paints through the min-visible clamp rather than waiting it out.
//
// ── THE MEASUREMENT THAT USED TO STAND HERE WAS WRONG, AND IT MATTERED ───
// This paragraph read "all four section loads were measured at ~2.9 ms — two
// orders of magnitude under the 200 ms threshold — so the loader never
// appears here at all". Three of the four still are: `/api/config`, 2.9 ms;
// `/api/health/ai-settings`, 3.2 ms; `/api/mcp/config` + `/api/config/
// default-domain`, 4.9 ms (in a browser, isolated install). The fourth,
// `/api/config/api-keys`, is **277 ms** on an install with three saved keys
// and a synced OpenRouter catalogue — 181 KB of JSON composed from 198 offers
// — so on Providers & keys the loader DID appear, flashed for ~80 ms, and the
// clamp gap above WAS reached on every first visit. That is the maintainer's
// "especially Providers & keys comes with delay", measured.
//
// It is answered by warming the data before the click (prefetchOtherSections)
// rather than by tightening this gate: a loader shown for less time is still
// a loader, and the honest fix for 277 ms is on the server. The gap is still
// real and still untested; it is named in the NOT ENFORCED block of
// scripts/test-next-loading-gate.js — whose copy of the "~2-3 ms" claim
// carries the same error and is not this change's file to correct.
let loadGate = null;

// Unsubscribe function for this mount's write-gate subscription (see
// onWriteGateChange in app.js) — released in teardown. Same discipline as
// views/ingest.js and views/sync.js: a torn-down mount must stop reacting
// to gate changes.
let unsubscribeWriteGate = null;

// ── The in-app update, which OUTLIVES THE MOUNT ON PURPOSE ───────────────
//
// Everything else in this view lives in `state`, which is reassigned wholesale
// on every onEnter — leave Settings and come back and it is gone. That is the
// right rule for a typed key or an open confirm panel, and the WRONG rule for
// a 140 MB download.
//
// THE DECISION, stated so it is not "fixed" back into `state` later:
//
//   Navigating away does NOT cancel the download. The server keeps going (its
//   stream deliberately has no `req.on('close')` cancel — see the header block
//   in src/routes/config.js), and this object keeps reading it, so coming back
//   to Settings shows the live progress immediately rather than an idle panel
//   over a running job. Silently binning a nearly-finished download because
//   somebody clicked Chat is the outcome this shape exists to prevent.
//
//   A hidden download with no way back to it is the opposite failure, and is
//   prevented by the SERVER holding the job: `GET /api/config/update-progress`
//   re-finds it after a full page reload, when this object is gone too.
//
//   THE HONEST GAP, reported rather than papered over: while the user is on
//   another view there is no indicator anywhere, because a shell-level badge
//   would have to live in src/public/next/app.js, which this change does not
//   own. The download is findable in one click (Settings → General); it is not
//   ambient.
//
// Shape: null when idle, otherwise
//   { phase: 'streaming'|'staged'|'relaunching'|'install-failed',
//     job:   { phase, receivedBytes, totalBytes, percent } | null,
//     version: string|null,
//     failure: { reason, error, hint } | null,
//     restartHint: boolean }
let inAppUpdate = null;

// Whether a desktop updater engine is attached to the running server, and
// whether we have asked. `null` = not asked yet; it gates the difference
// between offering a button that installs and the link that has always opened
// the download page, so a build with no engine keeps EXACTLY the pre-existing
// behaviour rather than being offered an action that would 501.
let updaterAttached = null;

/** Re-render whichever mount is current, if any. The in-app update flow is
 *  mount-INDEPENDENT (above), so it cannot capture a token the way every other
 *  action here does; it asks the shell instead. When no Settings mount is
 *  showing, this is a no-op and the state it would have drawn is picked up by
 *  the next render. */
function renderIfSettingsMounted() {
  if (isCurrentMount(myMountToken)) render(myMountToken);
}

registerView('settings', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
    // A door on another view asked to land on one section (v3.65.2 — the
    // Documents GitHub panel's "Add one in Settings"). Consumed ONCE, here,
    // before the first paint; an id this view does not know is ignored and
    // the default section stands. The request is self-clearing in app.js, so
    // the next plain visit to Settings lands where it always has.
    const askedSection = consumeSettingsSection();
    if (askedSection && Object.prototype.hasOwnProperty.call(SECTION_TITLES, askedSection)) {
      state.section = askedSection;
    }
    // Per-mount caches, cleared HERE rather than in the teardown: a teardown
    // that has to run for the next mount to be correct is a teardown one
    // handleMountFailure away from being skipped. See each declaration.
    sectionLoads = new Map();
    lastSidebarHtml = null;
    lastMainHtml = null;
    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    // ── THE TOOL MAP'S TWO TIMERS, ARMED HERE AND DISARMED IN THE TEARDOWN ──
    // ONE arm site and one disarm site each, which is the only shape a reader
    // can check at a glance (views/memory.js states the same rule about its
    // own clock). The age clock writes `textContent` into named nodes and is a
    // no-op on every section that carries none; the revalidate is a setTimeout
    // chain that ends itself the moment this mount stops being current.
    if (typeof setInterval === 'function') ageTimer = setInterval(tickMcpAges, MCP_AGE_TICK_MS);
    scheduleUsagePoll(mountToken);
    render(mountToken);
    loadVersion(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));       // cheap, always shown in the sidebar footer
    ensureSectionData(SETTINGS_SECTIONS[0][0], mountToken)                                   // default section — fetched immediately
      .catch((err) => reportAsyncMountFailure(mountToken, err))
      // …and the other four warmed in idle time, so the first click on
      // Providers & keys does not pay its 277 ms fetch. Chained AFTER the
      // landing section's own load rather than started beside it, so the
      // section the user is looking at is never queued behind four it is not.
      // See prefetchOtherSections for the measurement this answers.
      .then(() => { if (isCurrentMount(mountToken)) prefetchOtherSections(mountToken); });
    // A REQUESTED section other than the default gets its own gated load, so
    // it does not wait for the idle prefetch. Joined by loader identity in
    // startSectionLoad, so Knowledge base (which shares General's loadConfig)
    // makes no second request.
    if (state.section !== SETTINGS_SECTIONS[0][0]) {
      ensureSectionData(state.section, myMountToken).catch((err) => reportAsyncMountFailure(mountToken, err));
    }

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
      state.ghTokenValue = '';
      // The picker menus are <body> children, so a rail navigation does not
      // remove them with the view. The component self-closes when its trigger
      // leaves the document (setMain replaces #view-root's child on the next
      // mount), so this is the deliberate SECOND layer — a teardown that
      // depends on a repaint happening is not a teardown.
      closeAllListboxes();
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
      // The same rule for the tool map's two: an age clock left armed would go
      // on walking a DOM that belongs to whatever mounted next, once a second,
      // for the life of the page — and the revalidate would keep FETCHING for
      // a view nobody is looking at, which is worse than a wasted tick.
      if (ageTimer !== null) {
        if (typeof clearInterval === 'function') clearInterval(ageTimer);
        ageTimer = null;
      }
      stopUsagePoll();
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

// v3.71.1: this view's local `infoMark` and its TX_INFO_GLYPH copy are
// GONE. Every ⓘ here is `explainerMark` (shared/explainer.js), which is
// shared/text.js's renderInfoMark — ONE mark, one glyph, one listener.

// The "Going back to an earlier version" mark renders `settings.update-recovery`
// (a git checkout) or `settings.update-recovery-installer` (a packaged
// install) — chosen by install mode in renderGeneral. v3.71.1 moved the
// measured caveats this file used to carry (a --depth 1 clone has no tags on
// disk, so the fetch step is required; not every build is tagged; the data
// is ignored by git) to the guide's "Going back to an earlier version".

/**
 * How THIS INSTALL receives updates, from the capability record that rides
 * along on `GET /api/version`. Used for the copy that has to be right BEFORE
 * any check has run; the verdict itself uses `updateStyleOf(check)`, which
 * describes the payload in hand.
 *
 * Unknown resolves to `git-pull` — the same fail-safe direction as the server's
 * own install-mode detection, and the case that covers every existing browser
 * user plus any moment before `/api/version` has answered.
 */
function installUpdateStyle() {
  const caps = state.version && state.version.capabilities;
  return (caps && caps.updateStyle === 'download-installer') ? 'download-installer' : 'git-pull';
}

// ── Data loading (fetch-on-first-visit-to-section, cached in state) ─────

/**
 * Which loader a section still needs, or `null` when its data is already in
 * `state`.
 *
 * ONE TABLE, READ BY BOTH THE CLICK PATH AND THE IDLE PREFETCH, because the
 * two must agree about what "already loaded" means. A second list written out
 * in the prefetch would be free to fall behind this one, and the failure would
 * be silent in the direction that matters: a section the prefetch thinks is
 * warm but the click path re-fetches.
 *
 * General reads the SAME `GET /api/config` Knowledge base does — one endpoint,
 * one cached `state.config`, so entering one section warms the other and
 * neither can render a value the other has already moved past.
 */
function sectionLoaderFor(section) {
  if (section === 'providers') return state.keys === null ? loadKeys : null;
  if (section === 'mcp') return state.mcp === null ? loadMcp : null;
  if (section === 'health') return state.aiHealth === null ? loadAiHealth : null;
  if (section === 'storage') return state.config === null ? loadConfig : null;
  if (section === 'general') return state.config === null ? loadConfig : null;
  return null;
}

/**
 * The in-flight load per section, so the click path and the idle prefetch
 * cannot both fire the same request.
 *
 * MEASURED, NOT HYPOTHETICAL. `GET /api/config/api-keys` answers in **277 ms**
 * on an install with three saved keys and a synced OpenRouter catalogue (198
 * offers, 181 KB of JSON) — see the header note on the prefetch below. That is
 * long enough for a user to reach Providers & keys while the prefetch started
 * on Settings entry is still in the air, and a second request would then pay
 * the whole 277 ms again AND race the first one's state write.
 *
 * Keyed by section rather than by loader so the map reads as "what is this
 * section waiting for"; two sections sharing `loadConfig` share the entry via
 * the loader identity check below.
 *
 * RESET ON EVERY onEnter. A promise created under a dead mount resolves into
 * `isCurrentMount` guards and writes nothing, so re-using it for a NEW mount
 * would leave that mount with no data and nothing in flight.
 */
let sectionLoads = new Map();

/**
 * Start (or join) the load a section needs. Returns a promise, or `null` when
 * there is nothing to load.
 *
 * DELIBERATELY NOT GATED. `gate.begin()` is the caller's business: the click
 * path wants the delay-gated loader, and a background prefetch must never be
 * able to paint a loader over the section the user is actually reading.
 */
function startSectionLoad(section, token) {
  const loader = sectionLoaderFor(section);
  if (!loader) return null;
  // Joined by LOADER identity, not by section name: `general` and `storage`
  // share `loadConfig`, and two requests for one endpoint is the thing this
  // map exists to stop.
  for (const rec of sectionLoads.values()) {
    if (rec.loader === loader) return rec.promise;
  }
  const promise = loader(token).finally(() => {
    const rec = sectionLoads.get(section);
    if (rec && rec.promise === promise) sectionLoads.delete(section);
  });
  sectionLoads.set(section, { loader, promise });
  return promise;
}

async function ensureSectionData(section, token) {
  const load = startSectionLoad(section, token);
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
    await load;
  } finally {
    settleGate(gate, () => { if (isCurrentMount(token)) render(token); });
  }
}

/**
 * ── WARM THE OTHER FOUR SECTIONS IN IDLE TIME ──────────────────────────────
 *
 * THE COMPLAINT THIS ANSWERS, and the measurement behind it. The maintainer
 * reported that switching between the five Settings sections "comes with
 * delay — especially Providers & keys". Measured in a real browser against an
 * isolated install carrying three saved keys and a 197-entry OpenRouter
 * catalogue, a COLD click on Providers & keys painted:
 *
 *     t+0.5 ms    an empty section body (state.keys is still null)
 *     t+203 ms    the delay-gated loader appears (the gate's 200 ms threshold)
 *     t+283 ms    the real section, 251 KB of HTML, 217 table rows
 *
 * i.e. **283 ms of nothing, with an 80 ms loader flash in the middle**, on
 * every first visit. The WARM render of the very same section — the same 251
 * KB, the same 3,479 nodes — costs 9.7 ms of script and paints inside one
 * frame. So the delay was never the rendering. It was one fetch.
 *
 * THE FETCH IS NOT CHEAP, AND THE COMMENT THAT SAID IT WAS IS NOW CORRECTED.
 * `loadGate`'s declaration above used to state that "all four section loads
 * were measured at ~2.9 ms — two orders of magnitude under the 200 ms
 * threshold — so the loader never appears here at all". Three of the four
 * still are (2.9 / 3.2 / 4.9 ms, measured). `GET /api/config/api-keys` is
 * **277 ms**, because it composes 198 OpenRouter offers and asks llm.js about
 * each one. That measurement is why the loader DOES appear, and why it is
 * worth moving the wait somewhere the user is not watching.
 *
 * WHY PREFETCH RATHER THAN MAKE THE RENDER CHEAPER. The render is already
 * under a frame; there is nothing there to win. The honest fix for the 277 ms
 * is on the server (see this session's report — `isOfferableModel` rebuilds,
 * sorts and freezes the whole merged catalogue on every call, and the route
 * calls it ~600 times), and that file is not this one's to change. Warming the
 * data while the user reads the landing section removes the wait from the
 * click either way, and keeps working if the server is fixed.
 *
 * ── THE RULES THIS FOLLOWS ─────────────────────────────────────────────────
 *   · ONE SECTION AT A TIME, each in its own idle callback, so five requests
 *     never land as a burst against a single-threaded local server while the
 *     user is trying to interact with the section in front of them.
 *   · THE MOUNT TOKEN IS CHECKED BEFORE EVERY STEP. Leaving Settings stops the
 *     queue; it does not merely discard the results.
 *   · NO GATE. A background load must not be able to paint a loader.
 *   · IT SKIPS THE SECTION BEING SHOWN, whose own load onEnter already started
 *     through `ensureSectionData` — and joins it through `startSectionLoad`
 *     rather than racing it if the user has moved on in the meantime.
 *   · `requestIdleCallback` where it exists, `setTimeout` where it does not.
 *     Safari has shipped rIC only recently and Electron's version follows
 *     Chromium, so the fallback is not dead code on every platform.
 */
function prefetchOtherSections(token) {
  const queue = SETTINGS_SECTIONS.map(([id]) => id).filter((id) => id !== state.section);
  const idle = (fn) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
    else setTimeout(fn, 120);
  };
  const step = () => {
    if (!isCurrentMount(token)) return;
    while (queue.length) {
      const section = queue.shift();
      const load = startSectionLoad(section, token);
      // Nothing to fetch for this one (another section's loader already
      // warmed it) — keep walking rather than burning an idle slot on it.
      if (!load) continue;
      load.then(() => { if (isCurrentMount(token)) idle(step); },
        () => { if (isCurrentMount(token)) idle(step); });
      return;
    }
  };
  idle(step);
}

async function loadVersion(token) {
  try {
    const res = await fetch('/api/version');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.version = data;
    render(token);
    // Packaged installs only, and only once per mount. Two facts come back:
    // whether a desktop updater engine is attached (which decides whether the
    // "Update available" card offers a button or the download link), and any
    // job already in flight — which is how a page RELOADED mid-download finds
    // its way back to it. A browser install never issues this request.
    if (installUpdateStyle() === 'download-installer') {
      await probeInAppUpdate();
    }
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
    // THE THIRD REQUEST CANNOT FAIL THE OTHER TWO. `fetchMcpUsage` resolves to
    // a verdict and never rejects, so an install whose bridge has never been
    // called — or one running a server too old to answer this route at all —
    // still renders blocks ① and ②. The alternative (a third `fetch` in this
    // array) would put the whole section behind `state.mcpError` the first
    // time the route 404s, which is the v3.0.17 "one consumer drops the
    // section" shape with the blast radius pointed at the wrong block.
    // ④'s reading is started here and NOT awaited: it walks the store and
    // every usage log, and blocks ①–③ must not wait for it. It renders itself
    // when it lands, and a failure is its own state (never state.mcpError).
    loadAcrossProjects(token);
    const [cfgRes, ddRes, usage] = await Promise.all([
      fetch('/api/mcp/config'),
      fetch('/api/config/default-domain'),
      fetchMcpUsage(),
    ]);
    const cfg = await cfgRes.json();
    const dd = await ddRes.json();
    if (!isCurrentMount(token)) return;
    state.mcp = cfg;
    state.defaultDomainInfo = dd;
    state.mcpError = null;
    applyUsageVerdict(usage);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.mcpError = err.message || 'Could not load MCP status.';
  }
  if (isCurrentMount(token)) render(token);
}

/**
 * GET /api/mcp/usage, as a VERDICT rather than as a throw.
 *
 * `{ok: true, data}` or `{ok: false, error}` — never a rejection, so every
 * caller (the section load, the 30s revalidate) can be written without a
 * try/catch and cannot accidentally take the whole section down with it.
 *
 * THE SHAPE IS CHECKED, not assumed. A missing route on a server that serves
 * the SPA fallback answers 200 with `index.html`, which `res.json()` rejects
 * on — but a future route answering `{}` would not, and `data.tools.map` on
 * an absent array is the blank-screen class this view's own header warns
 * about. `Array.isArray(data.tools)` is the whole contract the renderer needs.
 */
async function fetchMcpUsage() {
  try {
    const res = await fetch('/api/mcp/usage');
    if (!res.ok) return { ok: false, error: 'The bridge could not read its own call log.' };
    const data = await res.json();
    if (!data || typeof data !== 'object' || !Array.isArray(data.tools)) {
      return { ok: false, error: 'The bridge could not read its own call log.' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message || 'The bridge could not read its own call log.' };
  }
}

/** Commit a verdict to state. Split out so the load path and the revalidate
 *  path cannot disagree about which fields a failure leaves behind — the
 *  last good payload is KEPT on a failed refresh (a map that empties itself
 *  because one poll missed is worse than a map one poll stale). */
function applyUsageVerdict(verdict) {
  if (verdict && verdict.ok) {
    state.mcpUsage = verdict.data;
    state.mcpUsageSig = usageSignature(verdict.data);
    state.mcpUsageError = null;
    return true;
  }
  state.mcpUsageError = (verdict && verdict.error) || 'The bridge could not read its own call log.';
  return false;
}

/**
 * ④ ACROSS PROJECTS — GET /api/mcp/usage?include=projects, once per load.
 *
 * Never throws. The payload's shape is CHECKED: an older server ignores the
 * parameter and answers without `byProject`, which is "this server cannot say",
 * never "no projects" — so an absent array is an error state, not an empty list.
 */
async function loadAcrossProjects(token, opts) {
  const bodyOnly = !!(opts && opts.bodyOnly);
  let next = null, err = null;
  try {
    const res = await fetch('/api/mcp/usage?include=projects');
    const data = res.ok ? await res.json() : null;
    if (data && Array.isArray(data.byProject) && data.byProjectWindow
        && typeof data.byProjectWindow === 'object') {
      next = { byProject: data.byProject, window: data.byProjectWindow,
        savePulse: data.savePulse && typeof data.savePulse === 'object' ? data.savePulse : null };
    } else {
      err = 'This server does not report connections per project.';
    }
  } catch (e) {
    err = (e && e.message) || 'Could not read the connections per project.';
  }
  if (!isCurrentMount(token)) return;
  // A failed background refresh keeps the reading it already has: an error
  // painted over good figures would be the poll inventing an outage.
  if (bodyOnly && !next && state.mcpProjects) return;
  state.mcpProjects = next;
  state.mcpProjectsError = next ? null : err;
  if (!bodyOnly) { render(token); return; }
  // v3.72.1 (truth audit F9): the 30 s poll's repaint — block ④'s BODY only,
  // exactly as block ③'s tool map is repainted, so an open ⓘ or fold stays.
  if (state.section !== 'mcp') return;
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const body = document.querySelector(ACROSS_PROJECTS_BODY_SEL);
  if (body) body.innerHTML = renderAcrossProjectsBody();
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
  // The GitHub read-token status rides THIS load rather than a loader of its
  // own: General and Knowledge base share loadConfig by loader identity (see
  // startSectionLoad), so a separate storage loader would either re-fetch
  // /api/config or need a second join rule. The status request is started in
  // parallel and can never fail this load — its failure is its own state.
  const tokenLoad = loadGhTokenStatus(token);
  // The Vault folder's "Domains in this folder" monitor (v3.66.0) rides this
  // load the same way and for the same reason; its failure is its own state.
  const domainsLoad = loadVaultDomains(token);
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
  await tokenLoad;
  await domainsLoad;
  if (isCurrentMount(token)) render(token);
}

/**
 * GET /api/domains/stats → state.vaultDomains. Never throws.
 *
 * THE INDEX IS THE ROUTE'S ORDER, recorded BEFORE any sort as a tie-break.
 * The COLOUR is `identitySlot`, the domain's recorded slot (v3.76.0) — never
 * the index. A domain whose stats failed keeps its row with `pageCount: null`
 * (the route returns `{slug, error}`), because a reading that could not be
 * taken is not a zero.
 */
async function loadVaultDomains(token) {
  let rows = null, err = null;
  try {
    const res = await fetch('/api/domains/stats');
    const data = res.ok ? await res.json() : null;
    if (data && Array.isArray(data.domains)) {
      rows = data.domains.map((d, index) => ({
        slug: d && typeof d.slug === 'string' ? d.slug : null,
        displayName: d && typeof d.displayName === 'string' && d.displayName ? d.displayName : null,
        pageCount: d && Number.isInteger(d.pageCount) && d.pageCount >= 0 ? d.pageCount : null,
        identitySlot: d && Number.isInteger(d.identitySlot) ? d.identitySlot : null,
        index,
      })).filter((d) => d.slug);
    } else {
      err = 'Could not read the domains in this folder.';
    }
  } catch (e) {
    err = (e && e.message) || 'Could not read the domains in this folder.';
  }
  if (!isCurrentMount(token)) return;
  state.vaultDomains = rows;
  state.vaultDomainsError = rows ? null : err;
}

/** GET /api/config/github-read-token → state.ghToken. Never throws. */
async function loadGhTokenStatus(token) {
  try {
    const res = await fetch('/api/config/github-read-token');
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!isCurrentMount(token)) return;
    if (!res.ok || !data || data.ok !== true) throw new Error('unreadable');
    state.ghToken = {
      present: data.present === true,
      last4: typeof data.last4 === 'string' ? data.last4 : null,
      kind: data.kind === 'fine-grained' || data.kind === 'classic' ? data.kind : null,
    };
    state.ghTokenLoadError = null;
  } catch {
    if (!isCurrentMount(token)) return;
    state.ghTokenLoadError = 'Could not read whether a GitHub token is saved.';
  }
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
// ── The render -> wire handoff for shared listboxes ──────────────────────
// Every renderer that emits a listbox pushes the SAME cfg object it rendered
// from onto this array; wireGlobalListeners hydrates from it. Rebuilding the
// cfg at wiring time would be two descriptions of one control, free to
// disagree about its options — this repo's most reliable failure shape, and
// the reason there is a handoff at all rather than a second derivation.
//
// Cleared at the top of renderMain, so a section that emits no picker leaves
// nothing behind for the wiring pass to mount.
const pendingListboxes = [];

/**
 * ── WHAT IS OPEN RIGHT NOW, READ OFF THE DOM ───────────────────────────────
 *
 * MEASURED IN THE REAL APP, not inferred from the report. The maintainer saw
 * three things close by themselves while a "Test on my wiki" run streamed, and
 * they have TWO different causes — one deterministic, one a race — which is why
 * this is a capture/restore pair rather than another `state.somethingOpen`.
 *
 *   1. THE ⓘ FOLDS LOSE EVERY TIME, DETERMINISTICALLY. Their open state lives
 *      ONLY in the DOM: shared/text.js's one delegated listener flips
 *      `panel.hidden` and the button's `aria-expanded`, and writes nothing
 *      anywhere else. renderMain() re-emits every panel with `hidden` and every
 *      button with `aria-expanded="false"`, so a render CANNOT preserve them.
 *      Measured in the browser at 1280x900: fold open -> press "Test on my
 *      wiki" (one render) -> `aria-expanded` "true" -> "false", `hidden` false
 *      -> true. One render is enough; a run emits one per SSE frame plus one a
 *      second from the elapsed clock.
 *
 *   2. THE `<details>` ARE STATE-BACKED AND STILL LOSE A RACE. `open` is
 *      recorded by a `toggle` listener, and the HTML spec QUEUES that event
 *      rather than firing it synchronously. So a render landing in the gap
 *      between the click and the toggle task rebuilds the element from state
 *      that has not been written yet, and the disclosure snaps shut. Measured:
 *      click a `[data-model-row]` summary, force a render in the SAME task ->
 *      `open` false. It comes back on the NEXT render (the queued toggle does
 *      run, on the detached node), which is why this reads as flicker rather
 *      than as loss — and why it is only visible while something is
 *      re-rendering once a second.
 *
 * THE DOM IS THE MORE RECENT TRUTH, and that is the whole idea. The browser
 * applied the user's click synchronously; `state` is one queued task behind.
 * Capturing from the live DOM immediately before the swap therefore beats
 * reading the same state the renderer just read, and closes (2) as well as (1).
 *
 * RESTORE ONLY OPENS, NEVER CLOSES. Several renderers FORCE a disclosure open —
 * the build list while a refusal or a write belongs to a row inside it, a model
 * row while it is the one being measured — and a restore that also closed
 * things would fight them, re-creating the v3.9.x "confirm rendered inside a
 * collapsed disclosure" shape. A stray open disclosure is visible and one click
 * from being closed; a disclosure that snapped shut is the defect being fixed.
 *
 * KEYED ON THE `data-*` HOOKS THE ELEMENTS ALREADY CARRY, composed and sorted,
 * rather than on a hand-maintained list of attribute names. A list is a second
 * description of the page that is free to fall behind it: a `<details>` added
 * later and forgotten would silently go back to snapping shut, with nothing
 * failing. A `<details>` with no `data-` hook at all cannot be keyed and is
 * skipped — which is why `.catalogue-funnel` was given one.
 */
function render(token) {
  preserveMainScroll(() => {
    // ── EVERYTHING THIS NEEDS IS INLINE, AND THAT IS A CONSTRAINT ─────────
    // `render` is EXECUTED, not scanned, by scripts/test-next-settings-scroll-
    // and-scale.js: it is lifted out of this file with `extractFunction` and
    // called with four spies for `preserveMainScroll`, `renderSidebar`,
    // `renderMain` and `wireGlobalListeners`. In that sandbox any other free
    // identifier is a ReferenceError — a CRASH rather than a failing assertion,
    // the v3.11.0 FN_NAMES shape this file names twice elsewhere. So the
    // capture/restore lives here rather than in two module-level helpers, and
    // the `typeof document` guards are what let the same code run under Node
    // with no DOM at all. In a browser both are always taken.
    const doc = (typeof document === 'undefined') ? null : document;
    const foldKey = (el) => {
      const parts = [];
      for (const a of el.attributes) {
        if (a.name.indexOf('data-') === 0) parts.push(a.name + '=' + a.value);
      }
      if (!parts.length) return '';
      parts.sort();
      return parts.join('&');
    };

    // Taken BEFORE the swap, off the LIVE DOM. Setting `open` back on below
    // queues a `toggle`, and wireGlobalListeners runs in this same task, so the
    // listener is attached long before that task fires and DOES write `true`
    // into state. That is the repair, not a side effect: in race (2) above, the
    // state is the thing that was stale. An element the renderer already
    // emitted open is untouched — no attribute change, no event.
    const before = doc ? doc.getElementById('view-root') : null;
    const openFolds = new Set();
    const openInfos = new Set();
    if (before) {
      before.querySelectorAll('details[open]').forEach((el) => {
        const key = foldKey(el);
        if (key) openFolds.add(key);
      });
      before.querySelectorAll('[data-tx-info][aria-expanded="true"]').forEach((btn) => {
        const id = btn.getAttribute('data-tx-info');
        if (id) openInfos.add(id);
      });
    }

    // ── ONE PAINT, OR NONE ─────────────────────────────────────────────────
    // Both halves report whether they actually replaced their DOM (`false`
    // means "the HTML was byte-identical to what is already on screen, so
    // nothing was touched" — see renderSidebar/renderMain). Two rules follow,
    // and they are the whole of the change:
    //
    //   1. IF NEITHER PAINTED, RETURN. The capture/restore below exists to put
    //      back what an innerHTML replacement destroys; with no replacement
    //      there is nothing to put back, and the open folds, the open ⓘ
    //      panels, the caret, the focus ring and an open listbox menu are all
    //      still exactly where the user left them — kept rather than restored,
    //      which is strictly stronger. Re-wiring here would be a DEFECT, not a
    //      no-op: wireGlobalListeners calls addEventListener on whatever is in
    //      the document, and the nodes are the same ones it wired last time,
    //      so every handler would fire twice.
    //
    //   2. IF ONE PAINTED AND THE OTHER DID NOT, PAINT THE OTHER TOO. Same
    //      reason, from the other side: wireGlobalListeners wires the sidebar
    //      AND the section body in one pass, so a re-wire after replacing only
    //      one of them double-binds the other. Forcing the second write keeps
    //      "either both are fresh nodes or nothing moved" true, which is the
    //      property the wiring has always relied on. It costs one more string
    //      build of whichever half is smaller.
    //
    // WHY THIS EXISTS. `render()` has ~40 call sites and repaints the section
    // wholesale; on Providers & keys that is 251 KB of HTML and 3,479 nodes.
    // Measured in a browser: building the string costs 1.8 ms, and parsing it
    // plus re-wiring costs another 7.9 ms — so a render that changes NOTHING
    // was costing ~8 ms and a full loss of DOM state. Entering Settings fired
    // four renders (mount, version, config, gate settle), of which two painted
    // identical HTML; a cold Providers entry fired three renders of the same
    // 251 KB. This makes the redundant ones free.
    const sidebarPainted = renderSidebar(token) !== false;
    const mainPainted = renderMain(token, sidebarPainted) !== false;
    if (!sidebarPainted && !mainPainted) return;
    if (!sidebarPainted) renderSidebar(token, true);

    const after = doc ? doc.getElementById('view-root') : null;
    if (after && openFolds.size) {
      after.querySelectorAll('details').forEach((el) => {
        const key = foldKey(el);
        if (key && openFolds.has(key)) el.open = true;
      });
    }
    if (after && openInfos.size) {
      after.querySelectorAll('[data-tx-info]').forEach((btn) => {
        const id = btn.getAttribute('data-tx-info');
        if (!id || !openInfos.has(id)) return;
        const panel = doc.getElementById(id);
        // Both halves or neither: shared/text.js's delegated listener reads
        // `aria-expanded` to decide what the NEXT click does, so a panel shown
        // with its button still saying "false" would take two clicks to close.
        if (!panel) return;
        panel.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
      });
    }

    wireGlobalListeners();
  });
}

/**
 * The HTML each surface last WROTE, so a render that would write the same
 * string again can skip the write. See render()'s "ONE PAINT, OR NONE" block
 * for the argument and the measurements.
 *
 * NULLED ON EVERY onEnter, and that is what makes comparing a remembered
 * string to the live DOM sound: the only way `#view-root` can hold something
 * other than what this view last wrote is a different view having mounted, and
 * a different view mounting means a new mount token and a fresh onEnter. (Every
 * render here is already behind `isCurrentMount`, and `setMain`/`setSidebar`
 * refuse a stale token on top of that.)
 */
let lastSidebarHtml = null;
let lastMainHtml = null;

/**
 * @param {number} token  this mount's token
 * @param {boolean} [force]  write even when the HTML is unchanged — used by
 *   render() to keep the two surfaces painting as one. See its comment.
 * @returns {boolean} false when nothing was written.
 */
function renderSidebar(token, force) {
  // ONE ROW COMPONENT, three hosts. `name` is the section, `event` is the
  // hint — the SAME third-line slot Domains' "Ingested · <title>" occupies,
  // which is why Settings passes no dot, no figure and no age: those slots are
  // omitted, not re-purposed. See shared/sidebar.js.
  const rows = SETTINGS_SECTIONS.map(([id, label, hint]) => renderSidebarRow({
    alias: 'settings',
    name: label,
    event: hint,
    active: state.section === id,
    data: { section: id },
  })).join('');

  const versionLabel = state.version
    ? 'The Curator v' + escapeHtml(state.version.version) +
      (state.version.restartRequired ? ' <span class="settings-restart-flag" title="Files were updated but the running app hasn\'t restarted yet">restart</span>' : '')
    : 'The Curator';

  const html =
    '<div class="settings-sidebar-shell">' +
      // UPDATES IS THE TOP SECONDARY, in the slot Domains gives "Use existing
      // folder" (R6). There is no PRIMARY: the primary slot means "create the
      // kind of thing this list holds", and a settings section is not created.
      // The version string stays at the foot ALONE — it is a reading, not an
      // action, and it was only ever in the footer's button row because the
      // head had nothing in it.
      renderSidebarHead({
        title: 'Settings',
        secondary: { label: 'Updates', id: 'settings-updates-btn' },
      }) +
      // NO EYEBROW: Domains' KNOWLEDGE names what its list holds among other
      // possible lists. This sidebar has exactly one list and the title above
      // it already names it, so a caption would be a label for the whole
      // screen printed twice.
      renderSidebarGroup({ alias: 'settings', rowsHtml: rows }) +
      '<div class="settings-sidebar-footer">' +
        '<span class="mono settings-version">' + versionLabel + '</span>' +
      '</div>' +
    '</div>';
  if (force !== true && html === lastSidebarHtml) return false;
  lastSidebarHtml = html;
  setSidebar(html, token);
  return true;
}

/**
 * @param {number} token  this mount's token
 * @param {boolean} [force]  see renderSidebar
 * @returns {boolean} false when nothing was written.
 */
function renderMain(token, force) {
  // See pendingListboxes. Cleared BEFORE the section body is built, because
  // building it is what fills the array.
  pendingListboxes.length = 0;
  const title = SECTION_TITLES[state.section] || 'Settings';
  let body;
  if (state.section === 'general') body = renderGeneral();
  else if (state.section === 'providers') body = renderProviders();
  // Block ④ Across projects (v3.66.0) is composed HERE, beside renderMcp, for
  // the reason the token block below is: suites lift renderMcp into sandboxes,
  // and a new free identifier inside a lifted body is a crash there.
  else if (state.section === 'mcp') body = renderMcp() + (state.mcp ? renderAcrossProjects() : '');
  else if (state.section === 'health') body = renderHealthLimits();
  // The GitHub read-only token block (v3.65.2) is composed HERE, at the call
  // site, rather than inside renderStorage: scripts/test-next-settings-sections
  // lifts renderStorage alone into a sandbox, and a new free identifier inside
  // a lifted body is a crash there, not an assertion (the v3.64.0 lesson).
  // The Vault folder's "Domains in this folder" monitor (v3.66.0) is passed IN
  // as an argument for the same reason: it belongs inside that block's body.
  else body = renderStorage(state.config ? renderVaultDomains() : '') +
    (state.config ? renderGithubReadToken() : '');

  const infoKey = SECTION_INFO[state.section];
  const html =
    renderViewHeader({
      eyebrow: 'configuration',
      title,
      info: infoKey ? explainerHtml(infoKey) : null,
      infoHtml: true,
    }) +
    // ── THE SECTION BODY IS ITS OWN ELEMENT, AND IT IS THIS VIEW'S ──────────
    // A bare `display: block` wrapper (views/settings.css), so it changes
    // nothing about layout: the header keeps its own 22px bottom margin and
    // the blocks inside keep the `.settings-job-block + .settings-job-block`
    // adjacency that supplies the 24 | 1 | 24 rhythm — they are still siblings.
    // It exists so the section-change reveal below has something OF THIS
    // VIEW'S to animate. The alternative was `.main-inner`, which belongs to
    // the shell and is the containing block for everything in the column; a
    // transform there is the hazard scripts/test-next-view-enter-motion.js
    // records for `#main`, and it is not this file's element to take that risk
    // with.
    '<div class="settings-view-body" id="settings-view-body">' + body + '</div>';

  // ── THE SECTION-CHANGE REVEAL ────────────────────────────────────────────
  // CONSUMED HERE, and consumed whether or not it is used, because it is a
  // one-shot: the flag is set by the sidebar's click handler and must not
  // survive into the next render, which is an IN-SECTION repaint (a keystroke
  // in the model search box, a key saved, a poll landing) and must not animate.
  // Reading it before the early return below is what makes that true even on a
  // render that paints nothing.
  const reveal = state.sectionJustChanged === true;
  state.sectionJustChanged = false;

  if (force !== true && !reveal && html === lastMainHtml) return false;
  lastMainHtml = html;
  setMain(html, token);
  // ── APPLIED TO THE NODE, NOT BAKED INTO THE STRING ───────────────────────
  // A `content-reveal` class inside the HTML would make the section-change
  // render and the very next in-section render differ by exactly that class,
  // so the next repaint — a poll, a gate settle, a keystroke — would replace
  // 251 KB of DOM for nothing AND cut the animation off mid-flight. Added
  // afterwards instead, which is also how app.js's own `playViewEnter` does it
  // for the shell's two containers. `.content-reveal` itself belongs to
  // tokens/motion.css; where it is absent this is inert.
  if (reveal && typeof document !== 'undefined') {
    const host = document.getElementById('settings-view-body');
    if (host) host.classList.add('content-reveal');
  }
  return true;
}

// ── General ──────────────────────────────────────────────────────────────
//
// ── FOUR BLOCKS, AND NOT ONE OF THEM IS A STEP (v3.54.0) ─────────────────
//
// This section used to be four `.settings-field-block`s in a flex column,
// each opening with a paragraph of 29 to 58 words, sitting in a `gap: 24px`
// container with nothing between them but that gap. The maintainer's verdict
// on the same shape one screen over (Providers & keys, v3.53.0) was "a sea of
// information"; the remedy there was the block — a rule, a bold title, a lede
// of at most twenty visible words, and everything longer behind the ⓘ or
// deleted outright. This is that remedy applied here, through the SAME
// `settingsBlock` helper rather than a second look-alike.
//
// EVERY BLOCK PASSES `null` FOR THE NUMERAL. Providers & keys reads top to
// bottom as a sequence and its numerals are part of what it is saying.
// Software update, Appearance, System check and Setup guide are four
// unrelated facilities you visit in whatever order you need them; numbering
// them would claim an order this page does not have. `settingsBlock(null, …)`
// also zeroes the 32px indent that exists only to clear a numeral.
//
// THE CONCATENATION IS BARE, with no `.settings-section` wrapper. That
// wrapper was `display: flex; gap: 24px`, and the blocks now carry their own
// `24 | 1px | 24` rhythm through `.settings-job-block + .settings-job-block`
// — keeping both would have stacked a 24px flex gap on top of a 24px margin
// and produced 73px between blocks. `renderProviders` concatenates bare for
// exactly this reason; this now matches it.
//
// WHAT DID NOT MOVE BEHIND A FOLD. The menu bar's failure-mode paragraph
// ("If the icon does not appear…") stays visible whenever the icon is on, and
// so does the per-mode consequence line. v3.16.1's rule: a warning behind a
// click is not a warning, and this one exists precisely because macOS gives
// an app no way to tell the user WHICH of three things ate its icon.

function renderGeneral() {
  const dark = currentTheme() === 'dark';
  // Re-checking mid-install would race the very process being replaced.
  const updatesBusy = updatesAreBusy(state, inAppUpdate);
  const installerMode = installUpdateStyle() === 'download-installer';
  const recovery = explainerMark('settings-update-recovery-info',
    installerMode ? 'settings.update-recovery-installer' : 'settings.update-recovery');
  const quick = state.quick;
  const summary = quick && !quick.error
    ? quick.summary
    : null;

  // ── SOFTWARE UPDATE COMES FIRST (v3.49.0) ──────────────────────────────
  // Reported by a power user: the update panel "sits last". It is the block a
  // user returns to most — Appearance, Text size and Menu bar are set once
  // and never touched again — so it opens the section. The sidebar footer's
  // "Updates" button lands here, and that landing is now at the top of the
  // section it lands on, which is what it always implied.
  //
  // THREE LEDES, ONE PER INSTALL MODE, because the sentence has to be right
  // BEFORE the button is pressed and therefore reads the install's own
  // capability rather than a check result that does not exist yet. Each is
  // the first clause of the paragraph it replaces; the rest is under the ⓘ.
  //
  // ONE CLAUSE EACH (v3.58.0). They were 15 / 18 / 16 words, because each
  // carried a second sentence saying the user's data is left alone. That
  // sentence is REASSURANCE — it is not a warning, a cost or the outcome of
  // something pressed, so it is not on the v3.16.1 never-fold list — and it
  // answers "what does this do to my wiki?", which is a question about the
  // MECHANISM. So it opens the ⓘ instead, where it is one sentence for all
  // three modes rather than three near-copies of itself.
  const updateLede = installerMode
    ? (updaterAttached === true
      ? 'Installs the newest build here, over this copy.'
      : 'Finds the newest build and opens its download page; you run the installer.')
    : 'Installs the published version over this copy.';


  const updateBody =
    '<div class="settings-field-block" id="block-updates">' +
      // The recovery mark keeps its own id, its own installer/git fork and its
      // own panel — scripts/test-release-channel.js pins all three. What it
      // loses is the "Software update" label it used to hang off, which is now
      // the block's <h2>; hanging it there twice would be the "names itself
      // twice" defect v3.50.0 recorded on Wiki health. It gets a sub-label
      // naming its own subject instead.
      '<div class="settings-label-row settings-subrow">' +
        '<span class="settings-field-label">Going back to an earlier version</span>' + recovery.btn +
      '</div>' +
      recovery.panel +
      '<div class="settings-btn-row">' +
        '<button type="button" class="btn btn-secondary" id="btn-check-updates"' + (updatesBusy ? ' disabled' : '') + '>' +
          (state.updateChecking ? 'Checking…' : 'Check for updates') +
        '</button>' +
      '</div>' +
      renderUpdateStatus() +
    '</div>';

  // ── THE INSET GROUPED LIST, AND WHY THESE THREE ARE ONE GROUP ──────────
  // A stack of label+control pairs with a gap between them is a FORM; a
  // rounded card whose rows are separated by a hairline inset to the label's
  // own x-offset is a macOS settings group. The separator says "these rows
  // belong to each other and the ones below do not", which a gap cannot say.
  //
  // These three and no others. Appearance, Text size and Menu bar are all
  // "how the app presents itself on this machine", all instant and
  // reversible, and none of them spends money or writes to disk.
  //
  // The rows keep .settings-field-block wholesale, so every id, every data-*
  // hook and every test selector is byte-identical; the group only adds the
  // card, the padding and the separators around them. What the rows LOST is
  // their paragraphs: 55 words under Text size and 58 under Menu bar, now one
  // measured line each, with the reasoning under this block's own ⓘ.
  const appearanceLede = 'Theme, text size and the menu bar icon. Saved in this browser.';

  const appearanceBody =
    '<div class="cur-group cur-group-fields">' +
      // Appearance. The label sits in a `.cur-group-label` column and the
      // control to its right — the kit's row axis. See the note in
      // views/settings.css on why the stacked axis was reverted.
      '<div class="settings-field-block">' +
        '<div class="cur-group-label">' +
          '<span class="settings-field-label">Appearance</span>' +
        '</div>' +
        '<div class="theme-segmented" role="group" aria-label="Theme">' +
          '<button type="button" class="theme-seg-btn' + (dark ? ' active' : '') + '" data-theme-choice="dark">Dark</button>' +
          '<button type="button" class="theme-seg-btn' + (!dark ? ' active' : '') + '" data-theme-choice="light">Light</button>' +
        '</div>' +
      '</div>' +

      // Text size. Same KIND of setting as Appearance — how the app looks on
      // this screen — and the same segmented control for the same reason.
      //
      // NO SEPARATE PREVIEW, deliberately: the change applies to the whole app
      // in the same frame, including to this control and the label above it,
      // so the app IS the preview.
      renderTextSize() +

      // Menu bar. Same KIND of setting — where the app puts itself on this
      // machine.
      renderBackgroundMode() +
    '</div>';

  // ── SYSTEM CHECK ───────────────────────────────────────────────────────
  // The lede states the three things a user weighs before pressing it: what
  // it looks at, that it is free, and that it does not touch their content.
  // WHAT IT COSTS STAYS ON THE BUTTON, never in the fold — the paid action
  // carries its own price in its own label, which is v3.16.1's rule and the
  // reason `.btn-ai` exists.
  const checkLede = 'Confirms the app is set up. Free, instant, never reads your wiki.';

  const checkBody =
    '<div class="settings-field-block">' +
      '<div class="settings-btn-row">' +
        '<button type="button" class="btn btn-secondary" id="btn-run-quick-check"' + (state.quickLoading ? ' disabled' : '') + '>' +
          (state.quickLoading ? 'Scanning…' : 'Run system check') +
        '</button>' +
        // `.btn-ai` — the shell's own tier-4 "spends money" variant, replacing
        // a settings.css-local look-alike (`.btn-ai-cost`) that painted the
        // same tint under a second name. One taxonomy, one class.
        //
        // v3.67.0: the price is no longer a literal typed into the label. It
        // is the shared run line, directly under this row, rendered from the
        // server's own `liveCheck.runsOn` (the same describeRun() every AI
        // route answers with) once it has been read — by a system check or by
        // this button's first press. It rides on `state` as ready HTML, and
        // the disabled attributes likewise, because renderGeneral is lifted
        // and executed by two suites with an explicit collaborator list
        // (rule 10). With no provider key the button is DISABLED, never
        // hidden, and described by the no-key line.
        '<button type="button" class="btn btn-ai" id="btn-verify-ai"' + (state.liveVerifyAttrs || '') + '>' +
          icon('star', 13) + ' Verify AI connection' +
        '</button>' +
      '</div>' +
      (state.liveRunsOnHtml ? '<div class="settings-verify-runs-on">' + state.liveRunsOnHtml + '</div>' : '') +

      (state.liveConfirmOpen ? renderLiveConfirm() : '') +
      (state.live ? renderLiveResult() : '') +

      (summary ? renderQuickSummary(quick) : '') +
      (quick && quick.error ? '<div class="settings-inline-error">' + escapeHtml(quick.error) + '</div>' : '') +
    '</div>';

  // ── SETUP GUIDE (D-C) ──────────────────────────────────────────────────
  // The first-run panel is dismissible, so it needs exactly one place it can
  // be found again — and exactly one `openOnboardingPanel()` call site, which
  // scripts/test-next-onboarding.js counts.
  const guideLede = 'Re-opens the first-run checklist: AI key, first domain, first source.';

  const guideBody =
    '<div class="settings-btn-row">' +
      '<button type="button" class="btn btn-secondary" id="btn-show-setup-guide">Show setup guide</button>' +
    '</div>';

  return (
    settingsBlock(null, 'updates', 'Software update', updateLede, updateBody, 'settings.update') +
    settingsBlock(null, 'appearance', 'Appearance', appearanceLede, appearanceBody, 'settings.appearance') +
    settingsBlock(null, 'system-check', 'System check', checkLede, checkBody, 'settings.system-check') +
    // Setup guide: NO ⓘ (v3.71.1, cut) — its lede already says what the one
    // button does; the rest ("dismissing is never permanent") is in the guide.
    settingsBlock(null, 'setup-guide', 'Setup guide', guideLede, guideBody, null)
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
      '<div class="cur-group-label">' +
        '<span class="settings-field-label">Text size</span>' +
        // ONE LINE, and the rest under the Appearance block's ⓘ. This was 55
        // words in the row itself — the trade, the zoom caveat, the persistence
        // note — which is a paragraph of reading beside a control you operate
        // by looking at the result. What survives is the only part that helps
        // you choose: which direction each option goes.
        '<p class="settings-hint-text">Larger is easier to read; smaller fits more.</p>' +
      '</div>' +
      '<div class="theme-segmented fs-segmented" role="group" aria-label="Text size">' + buttons + '</div>' +
    '</div>'
  );
}

/**
 * Menu bar — the app's background mode.
 *
 * ── LABELLED AROUND THE USER'S QUESTION, NOT THE CONFIG KEY'S ─────────────
 * The stored field is `backgroundMode` and its values are `window` / `tray` /
 * `tray-only`, because that is what the desktop shell has to decide. The
 * thing the user is looking for in Settings is *"do I get a menu bar icon"*,
 * so the control says Off / On / On, and hide the Dock icon. Same field, and
 * the label answers the question that brought them here.
 *
 * ── THE OPTIONS COME FROM THE SERVER, THE LABELS FROM HERE ────────────────
 * `backgroundModes` rides along on `GET /api/config`, so this control offers
 * exactly what this build's `BACKGROUND_MODES` table defines and can never
 * present an option the POST would refuse. The labels are local because they
 * are copy, not data — and a mode this build has no copy for renders under
 * its own id rather than being dropped, so a newer server can never make an
 * option silently disappear from the picker.
 *
 * ── THE WARNING IS IN THE COPY DELIBERATELY ───────────────────────────────
 * There are three separate ways a new menu bar icon silently fails to appear
 * on a modern Mac — pushed off the edge behind the notch, filed away by a
 * menu bar organiser, or withheld by the OS menu-bar-items permission — and
 * macOS gives an app NO way to find out which happened. So the setting says
 * so itself. A feature that looks broken with no explanation is worse than
 * one that names its own failure mode up front.
 *
 * ── IT SAYS WHERE IT APPLIES, RATHER THAN HIDING ITSELF ───────────────────
 * A browser install has no menu bar presence at all. The control is still
 * rendered, and says so: gating it would mean picking a proxy signal for
 * "packaged" — `updateStyle` is the only one this view has — and using an
 * UPDATE capability to decide a MENU BAR question is a category error that
 * would read as fact to the next person. Honest copy costs one sentence.
 *
 * ── NO `title=` ON THE SEGMENTS, AND A RATCHET IS WHY ─────────────────────
 * The first draft put each option's consequence in a `title=` tooltip, the
 * same shape renderTextSize() uses. `scripts/test-next-title-affordances.js`
 * went red on it — settings.js was already AT its hover-only ceiling — and
 * the ratchet was right rather than merely in the way: a tooltip is hover-only
 * and reaches nobody on a keyboard or a touch screen, and the consequence
 * being described here ("The Curator leaves the Dock") is the one a user most
 * needs to read BEFORE clicking.
 *
 * So the ACTIVE mode's consequence is rendered as visible text under the
 * control instead. That is strictly better than the tooltip it replaced: it
 * is reachable by everyone, and it puts the sentence in front of the user at
 * the moment it applies to them rather than only when they hover the option
 * they have not chosen.
 */
const BACKGROUND_MODE_LABELS = {
  window:      ['Off',                    'No menu bar icon. The Dock icon and the window behave exactly as they do now.'],
  tray:        ['On',                     'A menu bar icon showing what your agents have just saved, alongside the Dock icon.'],
  'tray-only': ['On, hide the Dock icon', 'Menu bar only. The Curator leaves the Dock — reopen the window from the menu bar icon.'],
};

function renderBackgroundMode() {
  const cfg = state.config;
  const modes = (cfg && Array.isArray(cfg.backgroundModes) && cfg.backgroundModes.length)
    ? cfg.backgroundModes
    : null;
  // Before the one GET lands there is nothing honest to mark as active, so the
  // block renders its label and hint with no control rather than a control
  // with a guessed selection.
  const active = cfg && typeof cfg.backgroundMode === 'string' ? cfg.backgroundMode : null;

  // ── THE SHAPE IS CHOSEN FROM THE SERVER'S OWN MODE LIST ─────────────────
  // macOS draws a facility you turn on as a SWITCH, and a dependent choice
  // that only exists once it is on as a CHECKBOX underneath. It draws a
  // segmented control for N peer MODES. This control is both at once: "is
  // there a menu bar icon" is a facility, and "hide the Dock icon" is a
  // dependent choice — which is exactly why three peer segments read oddly,
  // with one option ("On, hide the Dock icon") carrying a sentence while its
  // neighbours carry a word.
  //
  // The switch/checkbox pair is used ONLY when the server offers exactly the
  // three modes this file has copy for. Any other list — a build that adds a
  // mode, or removes one — falls back to the segmented control, which can
  // render N options honestly. The alternative, hardcoding the pair, would
  // make an unknown mode unreachable and invisible, which is the shape this
  // repo keeps recording as "a feature that looks built and does nothing".
  //
  // EVERY CONTROL STILL CARRIES data-background-mode WITH A REAL SERVER MODE
  // ID, so wireGlobalListeners' `querySelectorAll('[data-background-mode]')`
  // -> POST(dataset.backgroundMode) is UNCHANGED. Each control only decides
  // WHICH id it sends. That is what makes this a rendering change rather
  // than a protocol change.
  const PAIR_MODES = ['window', 'tray', 'tray-only'];
  const usePair = !!modes && modes.length === PAIR_MODES.length
    && PAIR_MODES.every((m) => modes.indexOf(m) !== -1);

  const buttons = (!usePair && modes) ? modes.map((id) => {
    const [label] = BACKGROUND_MODE_LABELS[id] || [id];
    const on = id === active;
    return (
      '<button type="button" class="theme-seg-btn bgmode-seg-btn' + (on ? ' active' : '') + '"' +
        ' data-background-mode="' + escapeHtml(id) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '"' +
        (state.backgroundModeSaving ? ' disabled' : '') + '>' + escapeHtml(label) + '</button>'
    );
  }).join('') : '';

  // The switch sends the mode it will move TO, never the one it is in.
  // Turning ON returns to 'tray' rather than to whichever on-mode was last
  // used, because this render has no memory of that and guessing 'tray-only'
  // would silently take a user's Dock icon away on a plain toggle.
  const on = active !== null && active !== 'window';
  const hideDock = active === 'tray-only';
  const pair = usePair && active !== null
    ? '<div class="cur-switch-row">' +
        '<span class="settings-field-label" id="bgmode-switch-label">Show the menu bar icon</span>' +
        '<button type="button" role="switch" class="cur-switch"' +
          ' aria-checked="' + (on ? 'true' : 'false') + '"' +
          ' aria-labelledby="bgmode-switch-label"' +
          ' data-background-mode="' + (on ? 'window' : 'tray') + '"' +
          (state.backgroundModeSaving ? ' disabled' : '') + '>' +
          '<span class="cur-switch-knob"></span>' +
        '</button>' +
      '</div>' +
      // A CHECKBOX and not a second switch: it states a fact about the icon
      // that is now on, rather than turning a second facility on. It is
      // disabled rather than hidden while the switch is off — hiding it would
      // make the row's height jump on every toggle, and a user who has never
      // turned the icon on would never learn the option exists.
      '<label class="cur-switch-sub">' +
        '<input type="checkbox" class="cur-check cur-check-sm"' +
          ' data-background-mode="' + (hideDock ? 'tray' : 'tray-only') + '"' +
          (hideDock ? ' checked' : '') +
          (!on || state.backgroundModeSaving ? ' disabled' : '') + '>' +
        '<span>Hide the Dock icon while it is showing</span>' +
      '</label>'
    : '';

  // What the CHOSEN option actually does, in visible text. A mode this build
  // has no copy for contributes nothing rather than an empty paragraph.
  const chosen = active && BACKGROUND_MODE_LABELS[active] ? BACKGROUND_MODE_LABELS[active][1] : null;

  return (
    '<div class="settings-field-block" id="block-background-mode">' +
      '<span class="settings-field-label">Menu bar</span>' +
      // ONE LINE, and the rest under the Appearance block's ⓘ, which is where
      // the 58-word version went: what the icon shows, why it is off by
      // default, and that a browser install has no menu bar presence. The row
      // keeps what a user needs to decide with — what it is for, and where it
      // works. THE FAILURE-MODE PARAGRAPH BELOW IS NOT PART OF THAT MOVE and
      // stays visible; see the docblock above.
      '<p class="settings-hint-text">Shows what your agents just saved. Mac app only.</p>' +
      pair +
      (buttons
        ? '<div class="theme-segmented bgmode-segmented" role="group" aria-label="Menu bar">' + buttons + '</div>'
        : '') +
      (state.backgroundModeError
        ? '<div class="settings-inline-error">' + escapeHtml(state.backgroundModeError) + '</div>'
        : '') +
      (chosen ? '<p class="settings-hint-text">' + escapeHtml(chosen) + '</p>' : '') +
      // A NOTE, not a hint, and never a fold. It names three ways the feature
      // silently fails with nothing on screen to say so, which is the one
      // class v3.16.1 forbids putting behind a click. `.settings-fail-note`
      // gives it a left rule so it reads as an aside about the thing that was
      // just turned on rather than as more of the same grey prose.
      (active && active !== 'window'
        ? '<p class="settings-hint-text settings-fail-note">If the icon does not appear: it can be pushed off the edge ' +
          'behind the notch on a narrow screen, filed into a hidden section by a menu bar organiser ' +
          'such as Bartender or Ice, or withheld by the menu bar items permission in System Settings ' +
          '→ Privacy &amp; Security. macOS gives an app no way to tell which, so check all three.</p>'
        : '') +
    '</div>'
  );
}

// The apply half of the flow OWNS the panel while it is running — an
// install in progress must never be redrawn as a stale "Update available"
// banner underneath the process replacing itself.
function renderUpdateStatus() {
  // The in-app updater owns the panel outright while it is running, for the
  // same reason the git flow does below: a live install must never be redrawn
  // as a stale "Update available" banner underneath the process replacing
  // itself. It is checked FIRST because it is the only one of the two that can
  // still be running after a navigate-away and a return.
  if (inAppUpdate) return renderInAppUpdate();

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

  if (v.style === 'download-installer') {
    // The two facts this function must NOT read for itself. It is extracted by
    // brace-matching and executed standalone by scripts/test-update-installer.js
    // §8c, so a module-level free variable inside it is a ReferenceError in the
    // suite rather than a wrong answer in the app — and, more importantly, a
    // render function that reaches outside its arguments for state is one that
    // cannot be reasoned about from its call site. Called with NO second
    // argument (the pre-existing suite's shape), both flags read false and the
    // function returns exactly what it returned before this change.
    return renderInstallerUpdateStatus(v, { canInstall: updaterAttached === true, busy: crossWriteBusy() });
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
  // WHY THE REASON IS VISIBLE AND NOT A TOOLTIP. It used to be
  // `title="Wait for the running ingest or sync to finish"` on the button —
  // and the button is `disabled` at exactly the moment that string exists, so
  // it was removed from the tab order and the only way to read it was to hover
  // it with a mouse. box()'s `warningText` slot renders it as text, in the same
  // card, for everyone. Same rule as renderCrossWriteBanner directly above.
  const updBusy = crossWriteBusy();
  return box('upd-attention', 'Update available', label,
    updBusy ? 'Wait for the running ingest or sync to finish before installing.' : null,
    'Installing replaces the app’s program files and restarts it. Your knowledge base, keys and sync settings are untouched.',
    '<button type="button" class="btn btn-primary btn-xs" id="btn-apply-update"' + (updBusy ? ' disabled' : '') + '>Install update</button>');
}


/**
 * The whole in-app update flow, as one status box.
 *
 * FIVE STATES, and no two of them say the same thing:
 *
 *   streaming       the ring, one sentence per phase, real bytes while
 *                   downloading
 *   staged          downloaded and verified, NOTHING REPLACED YET, one
 *                   button to finish
 *   relaunching     the swap is happening; this page reloads itself
 *   install-failed  a named reason, what was NOT changed, and two ways out
 *
 * WHY THE RING AND NOT A LINEAR BAR. The linear bar this app used to have was
 * deliberately removed (see views/ingest.css) in favour of
 * shared/progress-ring.js, which is the design system's own progress
 * component. Reusing it buys three things that matter here and would each have
 * to be re-decided for a new bar: the outer ring refuses to fill for a phase
 * that reports nothing; the inner orbit is the liveness cue during the long
 * silent minutes of a download; and its `prefers-reduced-motion` behaviour is
 * already the deliberate one — it drops the ROTATION and substitutes a 2.6s
 * opacity breath, keeping a liveness signal rather than freezing the only
 * moving thing on screen. A download is exactly the class the ingest ring's
 * exception was written for, so it inherits the same answer, and this change
 * adds NO new animation anywhere.
 */
function renderInAppUpdate() {
  const u = inAppUpdate;
  // The releases page, from whatever the SERVER last said it was — the failure
  // body carries it, and so does the check. Never a literal in this file: a URL
  // hardcoded on the client is a second copy of a fact the route already owns,
  // and it would go on rendering a link to the wrong place after the route
  // moved. When neither source has one, no link is rendered rather than a
  // guessed one.
  const page = (u.failure && typeof u.failure.releasesPageUrl === 'string' && u.failure.releasesPageUrl)
    || (state.updateCheck && typeof state.updateCheck.releasesPageUrl === 'string' && state.updateCheck.releasesPageUrl)
    || null;
  const releasesLink = (label) => (page
    ? '<a class="btn btn-secondary btn-xs" href="' + escapeHtml(page) +
      '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a>'
    : '');

  if (u.phase === 'install-failed') {
    const f = u.failure || {};
    // `f.error` is the sentence the ENGINE wrote for this reason, relayed by
    // the route. The reason CODE is deliberately not rendered: a slug beside a
    // sentence is an internal identifier shown to a person, which is the
    // v3.31.0 defect this release exists to undo. It stays on the wire for
    // branching and for logs.
    return box('upd-bad', 'Update didn’t finish',
      escapeHtml(f.error || 'The update stopped before it finished, and nothing was replaced.'),
      null,
      f.hint || null,
      '<button type="button" class="btn btn-primary btn-xs" id="btn-inapp-retry">Try again</button>' +
      releasesLink('Open the download page'));
  }

  if (u.phase === 'staged') {
    // NOT "installed", and not "done". The bundle is verified and sitting
    // beside the running app; the swap has not happened. This state is
    // reachable two ways — the finish step was refused because a write was in
    // flight, or the page was reloaded mid-download — and in both cases the
    // honest sentence is the same one.
    const f = u.failure;
    return box('upd-attention',
      'Update ready to install',
      (u.version ? 'v' + escapeHtml(String(u.version)) + ' has been' : 'The update has been') +
        ' downloaded and checked. The Curator hasn’t changed yet — finishing takes a few seconds and restarts the app.' +
        (u.warning ? '<span class="upd-detail">' + escapeHtml(String(u.warning)) + '</span>' : ''),
      f ? f.error : null,
      'Your knowledge base, API keys and sync settings are untouched.',
      '<button type="button" class="btn btn-primary btn-xs" id="btn-inapp-finish">Restart and finish</button>');
  }

  if (u.phase === 'relaunching') {
    // "No warning to click through" is MEASURED, not hopeful: a DMG stamped by
    // a browser download yields a quarantined app, while the same DMG fetched
    // by the app's own `fetch()` yields an unquarantined one — so there is no
    // Gatekeeper prompt and no Privacy & Security detour. Saying it is worth a
    // line, because that detour is most of the difference from the manual
    // flow this release replaces.
    return box('', 'Restarting',
      'The new version is in place. Waiting for The Curator to come back, then this page reloads itself — ' +
        'with no security warning to click through.',
      null,
      u.restartHint
        ? 'The app hasn’t answered yet. If it doesn’t come back on its own, open The Curator again from your Applications folder.'
        : null);
  }

  // streaming
  const job = u.job || { phase: 'resolving' };
  const copy = UPDATE_PHASE_COPY[job.phase] || UPDATE_PHASE_COPY.resolving;
  const pos = updateRingPosition(job);
  const sub = updateProgressSublabel(job);
  const ring = progressRingHtml({
    stages: UPDATE_RING_STAGES,
    stage: pos.stage,
    stageProgress: pos.stageProgress,
    size: 48,
    tone: 'accent',
    label: copy.headline + '…',
    sublabel: sub || '',
    // 'stage' rather than 'value': the centre says "2/5", which is the one
    // number a five-segment ring can carry without competing with the byte
    // figures on the sublabel line. Two different percentages on one control
    // is how a display comes to contradict itself.
    center: 'stage',
  });
  return box('',
    copy.headline,
    '<div class="upd-progress">' + ring + '</div>' +
      '<span class="upd-detail">' + escapeHtml(copy.body) + '</span>',
    null,
    'Don’t quit The Curator until it finishes.');
}

/**
 * The `download-installer` half of the status box.
 *
 * ── WHY A LINK AND NOT A BUTTON ────────────────────────────────────────────
 *
 * There is no button here that starts anything, because the app cannot start
 * anything: it has no signed updater, so it can only say what exists and open
 * the page. An `<a target="_blank" rel="noopener noreferrer">` is the honest
 * control for that — it looks like what it does, the middle-click and
 * copy-link affordances a user expects from a link keep working, and in the
 * packaged app `desktop/main.js`'s `setWindowOpenHandler` turns it into
 * `shell.openExternal`, i.e. the user's own browser rather than a second
 * Electron window with no chrome.
 *
 * ── WHY THE PRE-RELEASE FLAG IS SHOWN AND NOT HIDDEN ───────────────────────
 *
 * The server picks the newest release that actually carries an installer,
 * pre-release or not — measured, because the ONLY release carrying a DMG today
 * is flagged pre-release, so filtering them out makes the whole feature answer
 * "you are ahead of the published version" forever. Offering a pre-release
 * without saying so would be the dishonest half of that trade, so it is said.
 *
 * No new CSS variant, no new modal, no new tone: this reuses `box()` and the
 * same three `.upd-status` variants the git arm uses.
 */
function renderInstallerUpdateStatus(v, ui) {
  const ver = (s) => 'v' + escapeHtml(String(s));
  const page = v.releaseUrl || v.releasesPageUrl;
  const link = (label, cls) => (page
    ? '<a class="btn ' + cls + ' btn-xs" href="' + escapeHtml(page) + '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(label) + '</a>'
    : null);

  if (v.kind === 'no-release') {
    // NOT "up to date" and NOT "we couldn't check" — a third fact, with its
    // own sentence, because collapsing it into either would be a lie.
    return box('', 'No installable release published yet',
      'You’re running ' + ver(v.current) + '. There is no downloadable build on the releases page to compare it with.',
      null, null, link('Open the releases page', 'btn-secondary'));
  }

  if (v.kind === 'unknown-version') {
    return box('upd-attention', 'Couldn’t compare versions',
      'You’re running ' + ver(v.current) + '. The published build is tagged ' +
        escapeHtml(String(v.latest || 'something this app can’t read')) +
        ', which isn’t a version number this app can compare — so it can’t tell you whether it’s newer.',
      null, 'Open the release page and compare by hand.',
      link('Open the release page', 'btn-secondary'));
  }

  if (v.kind === 'local-ahead') {
    return box('upd-good', 'This copy is newer than the published one',
      'You’re running ' + ver(v.current) + '; the newest downloadable build is ' + ver(v.latest) +
        '. There is nothing to install.',
      null, null, link('Open the release page', 'btn-secondary'));
  }

  if (v.kind === 'current') {
    return box('upd-good', 'You’re up to date',
      'Running ' + ver(v.current) + ' — the newest downloadable build.' +
        (v.prerelease ? ' It is published as a pre-release.' : ''));
  }

  // available — and this is the ONE arm that forks on whether a desktop
  // updater engine is attached to the running server.
  //
  // WHY THE FORK IS ON A MEASURED FACT AND NOT ON HOPE. `updaterAttached`
  // comes from GET /api/config/update-progress, which asks the hook registry
  // live. Without it the only way to find out would be to show the button,
  // POST, and read a 501 back — i.e. advertise an action this build cannot
  // perform, which is precisely the defect v3.31.0 was written to fix wearing
  // the opposite hat. `null` (not asked yet, or the probe failed) takes the
  // LINK arm: that is the behaviour every packaged build has shipped with, so
  // the unknown case degrades to the one that has always worked.
  const canInstallHere = !!(ui && ui.canInstall);
  const busyNow = !!(ui && ui.busy);
  const versions = ver(v.current) + ' → ' + ver(v.latest) +
    (v.releaseName ? '<span class="upd-detail">' + escapeHtml(v.releaseName) + '</span>' : '');
  const pre = v.prerelease
    ? 'This build is published as a pre-release. It is the newest one with an installer.'
    : null;

  if (!canInstallHere) {
    return box('upd-attention', 'Update available', versions, pre,
      'The Curator can’t install this for itself. The release page has the download — open it, ' +
        'run the installer, and it replaces this copy. Your knowledge base, keys and sync settings are untouched.',
      link('Open the download page', 'btn-primary'));
  }

  // The reason is rendered as TEXT and not as a `title=` on the disabled
  // button: a disabled control is out of the tab order, so a tooltip on it is
  // reachable only by hovering with a mouse. Same rule the git arm records
  // directly above.
  return box('upd-attention', 'Update available', versions,
    busyNow
      ? 'Wait for the running ingest or sync to finish before installing.'
      : pre,
    'The Curator downloads this itself, checks it, and restarts into the new version. ' +
      'Your knowledge base, API keys and sync settings are untouched.',
    '<button type="button" class="btn btn-primary btn-xs" id="btn-inapp-install"' +
      (busyNow ? ' disabled' : '') + '>Download and install</button>' +
    link('Open the download page', 'btn-secondary'));
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
  // v3.72.1 (truth audit F8): the rows are a snapshot. They say WHEN, and
  // once a key, the active provider or the build model changes they say that
  // they predate it, instead of naming the old model as if it were current.
  const t = Number.isFinite(quick.checkedAtMs) ? new Date(quick.checkedAtMs) : null;
  const two = (n) => (n < 10 ? '0' + n : String(n));
  if (t) parts.push('checked ' + two(t.getHours()) + ':' + two(t.getMinutes()));
  const staleHtml = quick.stale === true
    ? '<div class="check-summary-line">Checked before your last provider, key or model change — run the check again for current results.</div>'
    : '';
  return (
    '<div class="settings-check-results">' +
      '<div class="check-summary-line mono">' + escapeHtml(parts.join(' · ') || 'No checks ran.') + '</div>' +
      staleHtml +
      rows +
    '</div>'
  );
}

/**
 * The System check's confirm. v3.67.0: its FIRST line is the shared run line
 * (the model, the tokens, the cost, from the server), replacing the hardcoded
 * "$0.0001" — a price typed into the view was a second opinion about a money
 * fact, and it stayed "$0.0001" whatever model the call actually ran on.
 *
 * Until the run line has been read (`state.liveRunsOn === undefined`) the
 * confirm says so and its button waits: a spend gate whose price is still in
 * flight is not yet a gate. A server that answers with no run line at all
 * (`null`, a pre-v3.67.0 backend) leaves the button live with the sentence
 * that makes no price claim. With no key, the button is disabled.
 */
function renderLiveConfirm() {
  const ro = state.liveRunsOn;
  const pending = ro === undefined;
  const line = ro ? renderRunsOn(ro, { inSettings: true, id: 'settings-verify-confirm-runs-on' }) : '';
  const blocked = !!(ro && ro.needsKey === true);
  return (
    '<div class="cost-confirm" role="group" aria-label="Confirm AI connection test">' +
      icon('alertTriangle', 14) +
      // A <div>, not the <span> it was: the run line is a block (<p>), and a
      // paragraph inside a span is not valid markup.
      '<div class="cost-confirm-text">' + line +
      (pending ? 'Reading which model runs this check… ' : '') +
      'This makes one real API call to your active provider to confirm it responds. ' +
      'Nothing else is read or written.</div>' +
      '<div class="cost-confirm-actions">' +
        '<button type="button" class="btn btn-primary btn-xs" id="btn-verify-ai-confirm"' +
          (state.liveLoading || pending ? ' disabled' : (blocked ? aiActionDisabledAttrs(ro, 'settings-verify-confirm-runs-on') : '')) + '>' +
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
//
// ── THE SCREEN IS ORGANISED BY JOB, NOT BY PROVIDER ─────────────────────────
//
// THE REPORT. "I don't know how to add additional models to the chat… it's
// really hard to distinguish between model families… it is truly hard to get
// your head around which model does what, which is appropriate for what, how to
// set the models. This is truly complicated."
//
// THE DIAGNOSIS. There are genuinely TWO JOBS here and, until this change, the
// screen never named either of them:
//
//   BUILDING THE WIKI — ingest, Health scans and Compile. ONE model does all
//     three; there is no second knob (see renderModelPickerScope's docblock for
//     why an override on the other two is not merely unused but INEXPRESSIBLE).
//     It has to be a model somebody measured against the real ingest prompt,
//     because a model that quietly emits JSON the parser cannot repair writes
//     broken pages while looking fine.
//   ANSWERING QUESTIONS — chat. Any model can do it. Nothing is at risk but the
//     cost of one answer, and the choice is per message, in the composer.
//
// EVERY CONFUSING ARTEFACT ON THE OLD SCREEN FOLLOWED FROM THAT SPLIT BEING
// INVISIBLE. The `chat only — not for ingest` badge, `never measured here`,
// "Test on my wiki", the two admission standards — each of them was CORRECT and
// each of them explained a piece of MACHINERY instead of stating the CHOICE. So
// the machinery is not deleted; it is put underneath a sentence that says what
// the user is actually deciding.
//
// THE ORDER IS THE ARGUMENT, and it is deliberately not the old one:
//
//   1. THE BUILD MODEL — one choice, one list, across every connected provider.
//      Provider is a LABEL on a row here, not the structure of the page.
//   2. CHAT — a statement and a pointer, never a second picker. Duplicating the
//      composer's control here would recreate exactly the "which one of these
//      am I setting?" question this change exists to remove.
//   3. CONNECTIONS — the keys. Below the two jobs, because a key is plumbing:
//      you touch it once and then you are choosing models for the rest of the
//      product's life.
//   4. EVERY MODEL, BY PROVIDER — the reference shelf. The full catalogue with
//      search, and the one path from "nobody has measured this" into the build
//      list. Folded, because it answers a question most users never ask.
//
// WHAT IS DELIBERATELY NOT HIDDEN. Nothing is removed from the catalogue and no
// measured warning moves behind a click. A model's ABSENCE from the build list
// is now the message that it cannot build a wiki — which is why the per-row
// `chat only — not for ingest` badge could go: it was true of 194 of ~199 rows,
// and a flag on 97% of a list carries no information (the finding v3.16.1
// recorded about the caution flag, one level up).

/**
 * ── ONE VOCABULARY: WHO MEASURED THIS MODEL FOR THIS JOB ────────────────────
 *
 * A row used to mix six vocabularies — `caution`, `chat only — not for ingest`,
 * `never measured here`, `out-performed`, `thinks`, `free` — three of which were
 * different ways of saying something about measurement. This is the one that
 * remains, and it has exactly three values because `measuredBy` on the wire has
 * exactly three (llm.js's `measurementProvenance`: 'curator' / 'user' / null).
 *
 * IT IS NOT A QUALITY SCORE, and the copy is written so it cannot be read as
 * one. `not measured` means UNMEASURED, never BAD: `z-ai/glm-5.3-flash` is
 * hand-measured AND carries a caution, while a fetched entry may be excellent
 * and simply unprobed. What a model actually costs, and what we actually found,
 * are the other two facts on the row and neither is folded away.
 *
 * `curator` and `user` STAY APART, and that is the whole reason the build lane
 * grew a third state rather than widening `suitability`: "we measured this
 * across documents, against its siblings" and "you ran nine of these on one
 * document, on one day" are different epistemic claims. Collapsing them would
 * badge a nine-run local probe identically to a multi-document measurement.
 */
const MEASUREMENT_CHIPS = Object.freeze({
  curator: Object.freeze({
    key: 'curator',
    label: 'measured by The Curator',
    cls: 'model-measured-curator',
    title: 'The Curator ran this model against its real ingest planning prompt, on real prose, ' +
      'across documents. The price and the limits on this row are things we observed.',
  }),
  user: Object.freeze({
    key: 'user',
    label: 'measured on your wiki',
    cls: 'model-measured-user',
    title: 'You measured this model yourself, on your own pages. What you ran, on which wiki and ' +
      'when is inside the row. That is a screen, not a guarantee.',
  }),
  none: Object.freeze({
    key: 'none',
    label: 'not measured',
    cls: 'model-measured-none',
    title: 'Nobody has run this model against The Curator’s ingest prompt. That says nothing ' +
      'about whether it is good — only that we cannot tell you how it would build a wiki.',
  }),
});

/**
 * The chip for one row.
 *
 * `measuredBy` is READ OFF THE WIRE where the route sends it, so this file owns
 * no second copy of the rule. The lane fallback fires only when the field is
 * genuinely ABSENT (an older backend that predates it) — never when it is an
 * explicit `null`, which is the route saying "nobody measured this". Those two
 * are different facts and collapsing them would report every Gemini and
 * Anthropic model as unmeasured against a backend that simply does not send the
 * field yet.
 */
function measurementChip(m, lane) {
  const v = (m && typeof m === 'object') ? m.measuredBy : undefined;
  if (v === 'curator') return MEASUREMENT_CHIPS.curator;
  if (v === 'user') return MEASUREMENT_CHIPS.user;
  if (v === undefined) {
    // ── ONLY *ONE* LANE MEANS NOBODY LOOKED ────────────────────────────
    // Three of the four lanes are measurements, and the first draft of this
    // fallback got that wrong — it mapped everything except the two BUILD
    // lanes to "not measured", which badged `gemini-3.5-flash-lite` as
    // unmeasured. That model has NINE live runs behind it and is chat-only
    // precisely BECAUSE of what they found (2 of 9 returned JSON neither the
    // parser nor the repair pass could fix). "We measured it and it cannot do
    // this job" and "nobody has looked" are different claims, and printing the
    // second over the first deletes the evidence for the verdict.
    //
    // CHAT_UNMEASURED is the one lane whose definition IS the absence of a
    // measurement (`jsonRaw === null`, which llm.js permits only on a
    // chat-only entry, exactly so a null can never be read as `false`).
    if (lane === MODEL_LANES.BUILD_LOCAL) return MEASUREMENT_CHIPS.user;
    if (lane === MODEL_LANES.BUILD_MEASURED || lane === MODEL_LANES.CHAT_UNFIT) {
      return MEASUREMENT_CHIPS.curator;
    }
  }
  return MEASUREMENT_CHIPS.none;
}

/** The rendered chip. Kept next to the table so the two cannot drift. */
function renderMeasurementChip(m, lane) {
  const c = measurementChip(m, lane);
  return '<span class="model-badge model-measured ' + escapeHtml(c.cls) + '" title="' +
    escapeHtml(c.title) + '">' + escapeHtml(c.label) + '</span>';
}

/**
 * Does this provider have a key SAVED IN SETTINGS?
 *
 * The v3.0.13 rule, in one place instead of the three inline lookup tables this
 * file used to carry. Null-prototype for the reason renderProviderRow's own
 * table states: on a plain literal `['constructor']` is TRUTHY, so an inherited
 * name would read as "keyed" — the opposite of the fail-safe direction. An id
 * absent from the table reads as NO KEY, which hides a section rather than
 * offering one that cannot work.
 */
function providerHasSavedKey(id, k) {
  if (!k) return false;
  const HAS_KEY_BY_PROVIDER = Object.assign(Object.create(null), {
    gemini: k.hasGeminiKey,
    anthropic: k.hasAnthropicKey,
    openrouter: k.hasOpenrouterKey,
  });
  return !!HAS_KEY_BY_PROVIDER[id];
}

/**
 * The qualification records, indexed by model id, on a NULL-PROTOTYPE object.
 *
 * Lifted out of renderModelPicker so the build block and the browse shelf read
 * the SAME index rather than each building one — two hand-maintained copies of
 * a lookup is how one row came to claim both lanes (see modelLaneOf).
 * Null-prototype because an OpenRouter id is a third party's string: on a plain
 * literal a model called `constructor` would resolve a FUNCTION where a record
 * belongs (the v3.0.9 shape).
 */
function qualIndex(k) {
  const quals = Object.create(null);
  const list = (k && Array.isArray(k.qualifications)) ? k.qualifications : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r && typeof r.modelId === 'string') quals[r.modelId] = r;
  }
  return quals;
}

/**
 * `k.buildModel`, normalised — or null when the payload cannot answer.
 *
 * READ, NEVER RE-DERIVED. The route computes this off the very resolution
 * ingest, Health and Compile use, so it cannot disagree with them; a client-side
 * re-derivation would be a second copy of the precedence ladder and would be the
 * copy that rots. Every field is validated against the values the route
 * documents, and an unrecognised `source` becomes null rather than being
 * defaulted to 'default' — inventing a provenance on a spending surface is worse
 * than admitting we were not told.
 */
function buildModelFacts(k) {
  const b = (k && k.buildModel && typeof k.buildModel === 'object') ? k.buildModel : null;
  if (!b) return null;
  const provider = typeof b.provider === 'string' ? b.provider : '';
  const model = typeof b.model === 'string' ? b.model : '';
  if (!provider || !model) return null;
  const source = (b.source === 'env' || b.source === 'selected' || b.source === 'default')
    ? b.source : null;
  return {
    provider,
    model,
    source,
    // `=== true`, not truthiness: the route sends a real boolean, so anything
    // else is a wire anomaly and must not be read as "your pick is in force".
    honoured: b.selectedHonoured === true,
    measuredBy: (b.measuredBy === 'curator' || b.measuredBy === 'user') ? b.measuredBy : null,
    // The same three-valued read `buildLaneFacts` applies to `build`. Carried
    // on the LEGACY object too, because a payload can ship one and not the
    // other and a banner that only works on the newer shape would be silent on
    // exactly the installs most likely to be running a retired model.
    liveMissing: b.liveMissing === true ? true : (b.liveMissing === false ? false : null),
  };
}

/**
 * ── PINS THAT GOVERN NOTHING ────────────────────────────────────────────────
 *
 * `POST /api-keys/model` — still live, and still the surface for going back to
 * the app default — stores a pin PER PROVIDER without touching which provider is
 * active. Only the ACTIVE provider's pin reaches ingest, so a pin under any
 * other provider is INERT: the user chose a model, the screen agreed, and
 * nothing obeys it. `docs/user-guide.md` calls that the likeliest user-facing
 * surprise in the whole router.
 *
 * The new build-model route cannot CREATE this state (it names provider and
 * model together and applies both), but it cannot un-create the ones already on
 * disk either, and the old route is still reachable. So it is SURFACED rather
 * than assumed away.
 *
 * Derived from the payload — `selectedModels` against `activeProvider` — never
 * from a provider id, so a fourth provider is covered with no edit here.
 */
function inertPins(k) {
  const out = [];
  if (!k || !k.selectedModels || typeof k.selectedModels !== 'object') return out;
  const active = typeof k.activeProvider === 'string' ? k.activeProvider : '';
  for (const p of PROVIDER_ROWS) {
    if (!p.available || p.id === active) continue;
    if (!Object.hasOwn(k.selectedModels, p.id)) continue;
    const pin = k.selectedModels[p.id];
    if (typeof pin === 'string' && pin) out.push({ provider: p.id, name: p.name, model: pin });
  }
  return out;
}

/**
 * Every model that can build the wiki right now, across every connected
 * provider, in delivered (cheapest-first-per-provider) order.
 *
 * ── LANE FROM THE SHARED PREDICATE, NEVER A SECOND TEST ────────────────────
 * `modelLaneOf` + `laneBuildsWiki` are the same pair the browse shelf, the row
 * badges and the pick control read, and they mirror `isBuildLaneModel` — the
 * server's own gate — disjunct for disjunct. So a row can appear in this list
 * only if the route would accept it as a pin, and the "offer no control that is
 * guaranteed to be refused" rule holds by construction rather than by care.
 *
 * KEY-GATED per provider, the v3.0.13 rule, as a second layer over the route's
 * own gating (a provider with no SAVED key serialises `offerable: []`).
 *
 * `index` is the model's position in its OWN provider's delivered list, carried
 * through only so a caller can reason about it. It is NOT used to badge a
 * cheapest row here — see renderBuildList.
 */
function buildCandidates(k) {
  const out = [];
  if (!k) return out;
  const quals = qualIndex(k);
  for (const p of PROVIDER_ROWS) {
    if (!p.available || !providerHasSavedKey(p.id, k)) continue;
    const list = (k.offerable && Array.isArray(k.offerable[p.id])) ? k.offerable[p.id] : [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
      const qual = Object.hasOwn(quals, m.id) ? quals[m.id] : null;
      const lane = modelLaneOf(m, qual);
      if (!laneBuildsWiki(lane)) continue;
      out.push({ p, m, index: i, lane, qual });
    }
  }
  return out;
}

/** How many models a provider offers for CHAT — i.e. all of them. */
function chatModelCount(k) {
  let n = 0;
  if (!k) return n;
  for (const p of PROVIDER_ROWS) {
    if (!p.available || !providerHasSavedKey(p.id, k)) continue;
    const list = (k.offerable && Array.isArray(k.offerable[p.id])) ? k.offerable[p.id] : [];
    n += list.length;
  }
  return n;
}

/**
 * ── IS THIS PROVIDER CONNECTED? ────────────────────────────────────────────
 *
 * The route gains a per-provider `connected` boolean, which is the fact block 1
 * renders as a word. It is READ, never re-derived, for the same reason
 * `buildModelFacts` is: the server owns what "connected" means (a saved key
 * today; a reachable base URL the day a local runtime lands) and a second
 * client-side definition would be the copy that rots.
 *
 * THE DEGRADED PATH IS NOT AN ERROR. A backend that predates the field sends
 * nothing, and `providerHasSavedKey` answers the same question from the same
 * payload — it is what every surface on this screen used before. So an older
 * backend renders correctly rather than reporting every provider as
 * disconnected, which is the failure mode that would make the page useless
 * against exactly the install least able to diagnose it.
 */
function providerConnected(p, k) {
  const id = (p && typeof p.id === 'string') ? p.id : '';
  const c = (k && k.connected && typeof k.connected === 'object') ? k.connected : null;
  if (c && Object.hasOwn(c, id)) return c[id] === true;
  return providerHasSavedKey(id, k);
}

/**
 * ── HAS THE PROVIDER WITHDRAWN THIS ONE MODEL? true | false | null ──────────
 *
 * Read off `liveMissingByModel`, the route's per-model map, keyed by provider
 * then by model id. It is the SAME producer behind `build.liveMissing` and
 * behind the `cheapestMeasured` exclusion, so a row's chip, the banner above it
 * and the cheapest-measured sentence cannot come to disagree about one model —
 * which is exactly what they did before this existed: the banner said
 * `minimax/minimax-m3:free` was gone while the sentence two lines below
 * recommended it as the cheapest thing connected and the picker offered it.
 *
 * THREE VALUES, AND THE THIRD IS THE ONE WITH THE RULE ON IT. `true` means the
 * provider's own live list does not carry it. `false` means it does. ANYTHING
 * ELSE — an absent map (an older backend), an absent provider, an absent id, a
 * wire anomaly — is `null`, and a null must render NOTHING. A chip saying a
 * model has been withdrawn because nobody has run a check is worse than no chip:
 * it sends the user to change a model that is fine, on a screen about money.
 * Read as two explicit identity tests for the reason `buildLaneFacts` states at
 * length: a truthiness read collapses unknown into "present" (silently
 * reassuring), a `!= null` read collapses a wire anomaly into "gone" (silently
 * alarming), and both collapses have shipped in this file.
 */
function modelLiveMissing(k, provider, modelId) {
  const map = (k && k.liveMissingByModel && typeof k.liveMissingByModel === 'object')
    ? k.liveMissingByModel : null;
  if (!map || typeof provider !== 'string' || typeof modelId !== 'string') return null;
  if (!Object.hasOwn(map, provider)) return null;
  const forProvider = map[provider];
  if (!forProvider || typeof forProvider !== 'object') return null;
  if (!Object.hasOwn(forProvider, modelId)) return null;
  const v = forProvider[modelId];
  return v === true ? true : (v === false ? false : null);
}

/**
 * The withdrawn-model chip, or ''. ONE builder, three surfaces (the block-2
 * picker row, the block-4 table's name cell, and the block-4 lane cell), so the
 * three cannot word the same fact differently.
 *
 * IT IS A WARNING AND IT IS NEVER FOLDED — the same rule the fallback banner and
 * the free-model caution already carry on this page, and for the same reason: a
 * warning you have to open something to discover is not a warning (v3.16.1). It
 * NAMES THE PROVIDER, because "no longer offered" with no subject reads as a
 * Curator decision rather than the vendor's.
 */
function renderGoneChip(providerName) {
  const who = (typeof providerName === 'string' && providerName) ? providerName : 'the provider';
  // CO-CLASSED ON `model-badge-flag`, which is the page's EXISTING warning
  // treatment (the attention tint behind "out-performed" and "failed on your
  // wiki"), so this chip reads as a warning on both themes without a new colour
  // being invented for it. `model-badge-gone` carries no styling of its own
  // today and is the stable hook a suite addresses and a later CSS pass would
  // use — it is not a second source of appearance.
  //
  // ── AND IT CARRIES NO `title=` ─────────────────────────────────────────
  // A first cut put the consequence ("ingest refuses to start with it, nothing
  // is re-pinned") in a tooltip, which pushed settings.js over the hover-only
  // ceiling scripts/test-next-title-affordances.js keeps — correctly, and the
  // right answer was to obey the rule rather than raise the ceiling. The FACT
  // is already the chip's visible text, the CONSEQUENCE is already the banner's
  // unfolded sub-line one block up, and a tooltip does not exist on touch. A
  // third copy reachable only by hovering would add nothing a user can rely on.
  return '<span class="model-badge model-badge-flag model-badge-gone">' +
    'no longer offered by ' + escapeHtml(who) + '</span>';
}


/**
 * ── THE BUILD LANE, AS ONE RECORD ──────────────────────────────────────────
 *
 * Prefers the route's new `build` object and degrades to the older
 * `buildModel` + `offerable` pair, so this block renders the same page against
 * both. Every field is validated: an unrecognised `source` becomes null rather
 * than being defaulted, because inventing a provenance on a spending surface is
 * worse than admitting we were not told (the rule `buildModelFacts` already
 * states, applied to the wider record).
 *
 * `source` has FIVE user-visible outcomes and only four values, because
 * `selected` splits on whether the pick is actually in force. That split is the
 * one this screen exists to make: "you chose this" and "you chose something and
 * it is not what is running" are different facts, and the second one is the
 * only one with an action attached.
 */
function buildLaneFacts(k) {
  const raw = (k && k.build && typeof k.build === 'object') ? k.build : null;
  const legacy = buildModelFacts(k);
  if (!raw) {
    if (!legacy) {
      // ── THE THIRD DEGRADATION, AND IT IS THE ONE THAT MATTERS MOST ──────
      // `build` is new and `buildModel` is only one release older. A backend
      // that predates BOTH still resolves a provider and a model perfectly
      // well, and telling that user "nothing builds your wiki" would be a false
      // statement about a working install — the exact failure this block exists
      // to remove, arriving through a different door. `activeModelLine` reads
      // the OLDEST pair (`activeProvider` + `activeModel`), which is the same
      // value from the same resolution the newer fields derive from, so it
      // cannot contradict them; it just carries less, and `source: null` makes
      // the copy claim correspondingly less.
      const a = activeModelLine(k);
      if (!a || !a.show) return null;
      return {
        provider: (k && typeof k.activeProvider === 'string') ? k.activeProvider : '',
        model: a.model,
        source: null,
        honoured: true,
        measuredBy: null,
        priceIn: null,
        priceOut: null,
        // Explicit, so every arm returns the same shape. `false` is the
        // fail-safe value: a degraded payload must never claim a model is free.
        free: false,
        outlineNote: '',
        thinks: false,
        cheapest: null,
        // An older backend cannot have been asked. NULL, never false: "not
        // gone" and "we never looked" are different facts, and only one of them
        // is the one the banner must stay silent for BOTH ways round.
        liveMissing: null,
        degraded: true,
      };
    }
    return {
      provider: legacy.provider,
      model: legacy.model,
      source: legacy.source,
      honoured: legacy.honoured,
      measuredBy: legacy.measuredBy,
      priceIn: null,
      priceOut: null,
      free: false,
      outlineNote: '',
      thinks: false,
      cheapest: null,
      liveMissing: legacy.liveMissing,
    };
  }
  const provider = typeof raw.provider === 'string' ? raw.provider : '';
  const model = typeof raw.model === 'string' ? raw.model : '';
  // A `build` record naming no model is not a record. Fall back to the older
  // pair rather than rendering a headline with an empty name in it.
  if (!provider || !model) {
    return legacy ? {
      provider: legacy.provider, model: legacy.model, source: legacy.source,
      honoured: legacy.honoured, measuredBy: legacy.measuredBy,
      priceIn: null, priceOut: null, free: false, outlineNote: '', thinks: false, cheapest: null,
      liveMissing: legacy.liveMissing,
    } : null;
  }
  const SOURCES = ['default', 'selected', 'env', 'fallback'];
  const source = SOURCES.includes(raw.source) ? raw.source : null;
  const f = (raw.facts && typeof raw.facts === 'object') ? raw.facts : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const ch = (raw.cheapestMeasured && typeof raw.cheapestMeasured === 'object')
    ? raw.cheapestMeasured : null;
  return {
    provider,
    model,
    source,
    // `=== true`, never truthiness — the route sends a real boolean and
    // anything else is a wire anomaly that must not read as "your pick is in
    // force". An ABSENT field reads as honoured, because a payload that names
    // a model and says nothing about a pin is describing a model that is
    // running.
    //
    // THERE IS NO `source === 'fallback' ? false` SPECIAL CASE, and its
    // absence is deliberate. It was written, and a mutation flipping it to
    // `true` came back GREEN: nothing on the fallback path reads `honoured` —
    // both the copy and the warn treatment branch on the SOURCE — so it was a
    // field agreeing with another field, which is the two-descriptions-of-one-
    // fact shape this file keeps recording. `honoured` now means exactly
    // `selectedHonoured` and nothing else.
    honoured: Object.hasOwn(raw, 'selectedHonoured') ? raw.selectedHonoured === true : true,
    measuredBy: (f.measured === 'curator' || f.measured === 'user') ? f.measured
      : (f.measured === true ? 'curator' : null),
    priceIn: num(f.priceIn),
    priceOut: num(f.priceOut),
    // `=== true`, never truthiness. A free model's prices are BOTH null, and so
    // are an unpriced model's — this is the only thing that separates them, so
    // an absent field must read as "not known to be free" and render the blank,
    // never as free. Rendering a paid model as free is the one direction of
    // this mistake a user pays for.
    free: f.free === true,
    outlineNote: typeof f.outlineNote === 'string' ? f.outlineNote : '',
    thinks: f.thinks === true,
    // ── THREE-VALUED, AND THE THIRD VALUE IS THE ONE THAT MATTERS ────────
    // `true` = the provider's own live list does not carry this model.
    // `false` = it does. ANYTHING ELSE — absent, null, a string, an older
    // backend — is UNKNOWN, and unknown must never render as gone. Read as
    // two explicit identity tests rather than `!!raw.liveMissing`, because a
    // truthiness read collapses unknown into `false` (silently reassuring) and
    // a `!= null` read would collapse a wire anomaly into `true` (silently
    // alarming). Both collapses have shipped in this file's history.
    liveMissing: raw.liveMissing === true ? true : (raw.liveMissing === false ? false : null),
    cheapest: (ch && typeof ch.model === 'string' && ch.model) ? {
      model: ch.model,
      provider: typeof ch.provider === 'string' ? ch.provider : '',
      priceIn: num(ch.priceIn),
      priceOut: num(ch.priceOut),
      free: ch.free === true,
      // `same` is READ. Comparing ids here would be a second opinion about a
      // money fact — the very comparator renderBuildList's docblock refuses —
      // so an absent flag degrades to "we were not told", which renders the
      // line without the swap offer rather than claiming a difference.
      same: ch.same === true,
    } : null,
  };
}

/**
 * ── THE FACET COUNTS ───────────────────────────────────────────────────────
 *
 * `catalogueCounts {total, canBuild, measured, free, batchHidden}` is
 * server-computed, and it has to be: `batchHidden` counts ids the eligibility
 * filter REMOVED, so nothing the client can see could ever recount it. A facet
 * whose count the client invented would be a filter promising rows it cannot
 * deliver.
 *
 * The degraded path counts only what the client genuinely holds — the offerable
 * rows — and reports `batchHidden` as null, which renders NO clause rather than
 * a zero. "None were hidden" and "we were not told how many were hidden" are
 * different facts and a `0` would assert the first.
 */
function catalogueCountsOf(k) {
  const c = (k && k.catalogueCounts && typeof k.catalogueCounts === 'object') ? k.catalogueCounts : null;
  const int = (v) => (Number.isInteger(v) && v >= 0) ? v : null;
  if (c) {
    return {
      total: int(c.total) === null ? chatModelCount(k) : c.total,
      canBuild: int(c.canBuild),
      measured: int(c.measured),
      free: int(c.free),
      batchHidden: int(c.batchHidden),
    };
  }
  let measured = 0;
  let free = 0;
  for (const row of allCatalogueRows(k)) {
    if (isCuratorMeasured(row.m) || row.qual) measured++;
    if (row.m && row.m.free === true) free++;
  }
  return {
    total: chatModelCount(k),
    canBuild: buildCandidates(k).length,
    measured,
    free,
    batchHidden: null,
  };
}

/**
 * Every model on the page, flattened across providers, each row carrying the
 * provider it is served by and the lane it is in.
 *
 * ONE WALK, SHARED BY THE TABLE, THE COUNTS AND THE SHELF. `buildCandidates`
 * already does exactly this for the build lane, and a second walk with its own
 * lane test is how the four expressions `modelLaneOf` replaced came to
 * disagree. This is that walk with the lane filter removed.
 */
function allCatalogueRows(k) {
  const out = [];
  if (!k) return out;
  const quals = qualIndex(k);
  for (const p of PROVIDER_ROWS) {
    if (!p.available || !providerHasSavedKey(p.id, k)) continue;
    const list = (k.offerable && Array.isArray(k.offerable[p.id])) ? k.offerable[p.id] : [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
      const qual = Object.hasOwn(quals, m.id) ? quals[m.id] : null;
      out.push({ p, m, index: i, lane: modelLaneOf(m, qual), qual });
    }
  }
  return out;
}

/**
 * What chat starts on, and how many models it can reach.
 *
 * READ from `chat {startsOn {model, provider}, count}`, degrading to the pair
 * this screen has always had — `activeProvider` + `models[activeProvider]` — for
 * the same reason `renderBuildCurrent` degrades: a backend that predates the
 * field still resolves a perfectly good starting model, and telling that user
 * "no models are available" would be a false statement about a working install.
 */
function chatStartFacts(k) {
  const c = (k && k.chat && typeof k.chat === 'object') ? k.chat : null;
  const count = (c && Number.isInteger(c.count) && c.count >= 0) ? c.count : chatModelCount(k);
  const s = (c && c.startsOn && typeof c.startsOn === 'object') ? c.startsOn : null;
  let provider = (s && typeof s.provider === 'string') ? s.provider : '';
  let model = (s && typeof s.model === 'string') ? s.model : '';
  if (!model) {
    provider = (k && typeof k.activeProvider === 'string') ? k.activeProvider : '';
    model = (k && k.models && typeof k.models[provider] === 'string') ? k.models[provider] : '';
  }
  return { provider, model, count };
}

/**
 * ── THE BROWSE TABLE'S FILTER SCOPE ────────────────────────────────────────
 *
 * `modelFilterFor` is keyed by provider because the per-provider catalogues
 * each carry their own bar. Block 4's table is ACROSS providers, so it needs a
 * key no provider can ever have. Two underscores at each end is not a provider
 * id under any naming scheme the route emits, and `isValidProvider`-style
 * checks elsewhere would reject it — which is the point: a collision here would
 * make one bar silently drive two lists.
 */
const ALL_MODELS_SCOPE = '__all__';

/**
 * The build lane's working set, in tokens.
 *
 * DERIVED FROM THE APP'S OWN BUDGETS, not inherited from a parity rule: ingest
 * caps a source at 80,000 characters and adds the index and the slug inventory
 * (~341,005 characters ≈ 85K tokens on a mature domain), and Phase 1 asks for
 * `MULTI_PHASE_OUTLINE_TOKENS` = 24,576 back. ~110,000 is that sum. It is used
 * here for ONE purpose — saying which unmeasured models could physically hold
 * the job — and never as a gate: the server owns eligibility, and a client-side
 * gate would be a second copy of a rule that decides what a user may spend
 * their own key on.
 */
const BUILD_WORKING_SET_TOKENS = 110000;

// ── CONTIGUOUS, AND LABELLED WITH WHAT THEY MEASURE (v3.72.1, audit F6) ──
// The bands read "Under $0.20 · $0.20–$1 · $3 and up" and NO predicate took an
// input price between $1 and $3 — Sonnet 5 ($2), the Gemini Flash models after
// their promotion ($1.50) and many synced OpenRouter models sat in no band, so
// the band counts did not add up to the total and "a mid-priced model" could
// not be found. Every edge is now shared by exactly two neighbours (`<` on one
// side, `>=` on the other), so any positive input price lands in exactly one
// band; test-next-providers-page.js walks a price grid across every edge to
// prove it. The group is labelled "Input price per 1M tokens" where it renders.
const MODEL_PRICE_BANDS = [
  ['any', 'Any price', null],
  ['free', 'Free', (m) => m && m.free === true],
  ['lt20', 'Under $0.20', (m) => typeof m.input === 'number' && m.input > 0 && m.input < 0.2],
  ['mid', '$0.20–$1', (m) => typeof m.input === 'number' && m.input >= 0.2 && m.input < 1],
  ['upper', '$1–$3', (m) => typeof m.input === 'number' && m.input >= 1 && m.input < 3],
  ['high', '$3 and up', (m) => typeof m.input === 'number' && m.input >= 3],
];

const MODEL_LANE_FACETS = [
  ['all', 'All'],
  ['build', 'Can build'],
  ['measured', 'Measured'],
  ['free', 'Free'],
];

/** Does this row pass the lane facet? Reads the SHARED lane predicate, never a second test. */
function browseLanePass(row, lane) {
  if (lane === 'build') return laneBuildsWiki(row.lane);
  if (lane === 'measured') return isCuratorMeasured(row.m) || !!row.qual;
  if (lane === 'free') return row.m && row.m.free === true;
  return true;
}

function browseBandPass(m, band) {
  for (const [id, , pred] of MODEL_PRICE_BANDS) {
    if (id !== band) continue;
    return pred ? !!pred(m) : true;
  }
  return true;
}

/**
 * The rows block 4 will actually draw, after every facet.
 *
 * ONE FILTER FUNCTION, and the counts on the facet buttons are computed by
 * calling it with that one axis relaxed — so a count can never promise rows the
 * table would not deliver. A hand-written count beside a hand-written filter is
 * two descriptions of one rule, and this file already records where that goes.
 */
function browseFilter(rows, f) {
  const q = typeof f.q === 'string' ? f.q.trim().toLowerCase() : '';
  return rows.filter((row) => {
    if (!browseLanePass(row, f.lane)) return false;
    if (!browseBandPass(row.m, f.band)) return false;
    if (f.provider && row.p.id !== f.provider) return false;
    if (q && !modelSearchText(row.m).includes(q)) return false;
    return true;
  });
}

/**
 * ── "WORTH TESTING FOR THIS JOB" — A FILTER WITH A SENTENCE, NOT A RANKING ──
 *
 * v3.16.1 refused a most-capable sort on evidence: price, parameter size,
 * release date and vendor each pointed the wrong way, and one model that passed
 * every metadata filter returned zero usable outlines in nine runs. So this is
 * not a ranking and must never become one. Every entry is here because of a
 * FACT already on its row, it says which fact, and the order is the catalogue's
 * own delivered order rather than any score.
 *
 * THE THREE FACTS, and nothing else:
 *   · it is not already in the build lane (there is nothing to test);
 *   · its published context clears the build job's working set;
 *   · its published input price is at or below what the build model costs now.
 *
 * The audit's fourth criterion — "declares no retirement date" — is DELIBERATELY
 * absent: no retirement field reaches this view, and asserting the absence of a
 * date we were never sent would be inventing a fact. It ships when the wire
 * carries it.
 *
 * Capped at five, because a shortlist of twenty is a list.
 */
function worthTestingRows(rows, b) {
  const nowIn = (b && typeof b.priceIn === 'number' && Number.isFinite(b.priceIn)) ? b.priceIn : null;
  const out = [];
  for (const row of rows) {
    if (out.length >= 5) break;
    const m = row.m;
    if (!m || laneBuildsWiki(row.lane)) continue;
    const ctx = (typeof m.contextLength === 'number' && Number.isFinite(m.contextLength))
      ? m.contextLength : null;
    if (ctx === null || ctx < BUILD_WORKING_SET_TOKENS) continue;
    const inp = (typeof m.input === 'number' && Number.isFinite(m.input)) ? m.input : null;
    if (inp === null) continue;
    if (nowIn !== null && inp > nowIn) continue;
    // ── THE `why` NAMES ONLY THE COMPARISON THAT WAS ACTUALLY MADE ────────
    // It used to fall through to "…at or below what you pay now" whenever the
    // row was not strictly cheaper — INCLUDING when `nowIn` is null, i.e. when
    // no price was published for the build model and no comparison happened at
    // all. That is a claim about a test that did not run, on a spending
    // surface. Three arms now, one per state of the comparison.
    const why = (nowIn === null)
      ? 'no price is published for the model building your wiki, so there was nothing to compare'
      : (inp < nowIn
          ? 'cheaper on input than the model building your wiki now'
          : 'the same input price you pay now');
    out.push({ row, why });
  }
  return out;
}

/**
 * ── THE SHORTLIST, AS A TABLE BEHIND A CLOSED DISCLOSURE ───────────────────
 *
 * It was five `<li>`s of 33 words each, 29 of which were IDENTICAL across every
 * row — the same finding v3.16.1 recorded one level up: a sentence that appears
 * on every row carries no information, and five copies of it read as a wall.
 * The shared part is now ONE rule line above the table; the per-row cell says
 * only the thing that DIFFERS, which is the comparison that put that row here.
 *
 * CLOSED BY DEFAULT because it is an invitation to spend time and money, not a
 * warning — and the summary carries the COUNT, so the fact that there is
 * something here survives the fold.
 *
 * NO SORT, and that is the same refusal `worthTestingRows`'s own docblock makes:
 * the rows arrive in the catalogue's delivered order and are rendered in it. A
 * cheapest-first pass here would turn a filter with a sentence attached into a
 * ranking, which is the thing v3.16.1 measured to be unsupportable.
 */
function renderWorthTesting(rowsAll, b, pickDisabled) {
  const worth = worthTestingRows(rowsAll, b);
  const openAttr = state.worthTestingOpen === true ? ' open' : '';
  const head =
    '<summary class="browse-worth-summary">' +
      icon('chevronRight', 12) +
      '<b>Worth testing for this job</b>' +
      '<span class="mono browse-worth-count">' + escapeHtml(String(worth.length)) + '</span>' +
    '</summary>';

  if (!worth.length) {
    // VERBATIM, both sentences. It is the honest empty state — the shortlist is
    // a filter, and a filter that matches nothing has to say so rather than
    // vanish, or its absence reads as a feature that failed to load.
    return '<details class="browse-worth" data-worth-testing="1"' + openAttr + '>' + head +
      '<div class="browse-worth-body">' +
      '<p>Nothing on your synced list stands out on facts alone for this job. Every model ' +
      'stays reachable in the list above.</p></div></details>';
  }

  const rows = worth.map(({ row, why }) => {
    const m = row.m;
    const provRow = PROVIDER_ROWS.find((r) => r.id === row.p.id);
    const measuring = !!(state.qualify && state.qualify.modelId === m.id);
    // The button is offered ONLY where the server would accept the run — the
    // same `canQualify` table renderModelOption reads, never `p.id ===
    // 'openrouter'`. A provider without it gets the reason where the button
    // would be, because a control whose only outcome is a refusal is worse than
    // no control (this file's own rule, applied one surface over).
    const act = (provRow && provRow.canQualify === true)
      ? '<button type="button" class="btn btn-secondary btn-xs model-qualify-btn"' +
          ' data-qualify-model="' + escapeHtml(String(m.id)) + '"' +
          (measuring || pickDisabled ? ' disabled' : '') + '>' +
          (row.qual ? 'Test again on my wiki' : 'Test on my wiki') + '</button>'
      : '<span class="browse-unmeasured">no self-test on ' + escapeHtml(row.p.name) + '</span>';
    // ── A DIFFERENT ATTRIBUTE FROM THE TABLE'S, DELIBERATELY ─────────────
    // Every row here is ALSO a row of the table above: the shortlist is a
    // filter over it, not a second population. Reusing `data-model-id` would
    // make one model appear twice under the attribute that answers "is this
    // model on the page", and the duplicate check that proves the per-provider
    // lists are gone would then have to special-case its own shortlist — a
    // guard with an exception for the thing most likely to reintroduce the bug.
    return '<tr data-worth-model="' + escapeHtml(String(m.id == null ? '' : m.id)) + '">' +
      '<td class="browse-name"><b>' + escapeHtml(m.label || m.id) + '</b>' +
        '<small>' + escapeHtml(row.p.name) + ' · ' + escapeHtml(m.id) + '</small></td>' +
      '<td class="browse-num mono">' + escapeHtml(formatPricePerM(m.input) || '—') + '</td>' +
      '<td class="browse-num mono">' + escapeHtml(formatPricePerM(m.output) || '—') + '</td>' +
      '<td class="browse-num mono">' + escapeHtml(formatTokenCount(m.contextLength) || '—') + '</td>' +
      '<td class="browse-worth-why">' + escapeHtml(why) + '</td>' +
      '<td>' + act + '</td>' +
    '</tr>';
  }).join('');

  return (
    '<details class="browse-worth" data-worth-testing="1"' + openAttr + '>' + head +
      '<div class="browse-worth-body">' +
        // ONE RULE LINE, replacing the clause that was on all five rows.
        '<p class="browse-worth-rule">Every model here is on your list, has never been measured ' +
        'against the ingest prompt, and publishes a context window that clears what ingest needs. ' +
        'In the catalogue’s own order — this is a filter with a sentence attached, never a ranking.</p>' +
        '<div class="browse-table-wrap"><table class="browse-table browse-worth-table">' +
          '<thead><tr>' +
            '<th>Model</th>' +
            '<th class="browse-num">In /1M</th>' +
            '<th class="browse-num">Out /1M</th>' +
            '<th class="browse-num">Context</th>' +
            '<th>Why it’s here</th>' +
            '<th>Measure it</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table></div>' +
      '</div>' +
    '</details>'
  );
}

/**
 * ── BLOCK 4's TABLE ────────────────────────────────────────────────────────
 *
 * A TABLE, not a list of cards, and that is the whole argument: at 200+ rows the
 * only question anyone asks here is comparative, and a comparison needs columns.
 * The three numeric columns carry `tabular-nums` — without it a price column is
 * not a column, it is a ragged stack of digits.
 */
function renderModelBrowse(k, counts, f, rowsAll, crossBusy) {
  const shown = browseFilter(rowsAll, f);
  const b = buildLaneFacts(k);

  // ── FACET COUNTS: EACH AXIS COUNTED WITH ITSELF RELAXED ────────────────
  // A count that showed the filtered total would read 0 on every button but
  // the selected one, which is the opposite of what a facet count is for: it
  // exists so a filter that would empty the list says so BEFORE it is clicked.
  const laneCount = (id) => browseFilter(rowsAll, Object.assign({}, f, { lane: id })).length;
  const bandCount = (id) => browseFilter(rowsAll, Object.assign({}, f, { band: id })).length;

  const laneSeg = MODEL_LANE_FACETS.map(([id, label]) => {
    // The server's own counts where it sent them and the facet is unfiltered —
    // `batchHidden` proves the client cannot recount this catalogue, because
    // the rows it names were removed before the payload was built.
    const n = laneCount(id);
    // `.theme-seg-btn` is the kit's segmented chip, reused wholesale rather
    // than copied — it is the same control doing the same job, and this file
    // already records what a second copy of a segment style costs (two
    // declarations at identical specificity, one of them silently inert).
    // `aria-pressed` AND the `active` class: the class is what the kit styles,
    // the attribute is what a screen reader reads, and neither substitutes for
    // the other.
    return '<button type="button" class="theme-seg-btn' + (f.lane === id ? ' active' : '') +
      '" data-browse-lane="' + escapeHtml(id) + '"' +
      ' aria-pressed="' + (f.lane === id ? 'true' : 'false') + '">' + escapeHtml(label) +
      '<span class="mono browse-seg-n">' + escapeHtml(String(n)) + '</span></button>';
  }).join('');

  const bandSeg = MODEL_PRICE_BANDS.map(([id, label]) => (
    '<button type="button" class="theme-seg-btn' + (f.band === id ? ' active' : '') +
      '" data-browse-band="' + escapeHtml(id) + '"' +
      ' aria-pressed="' + (f.band === id ? 'true' : 'false') + '">' + escapeHtml(label) +
      (id === 'any' ? '' : '<span class="mono browse-seg-n">' +
        escapeHtml(String(bandCount(id))) + '</span>') + '</button>'
  )).join('');

  // The provider popup and the sort popup — the shared listbox, one cfg each,
  // rendered here and mounted from pendingListboxes.
  const provCfg = {
    id: 'browse-provider-lb',
    ariaLabel: 'Filter by provider',
    value: f.provider || '',
    triggerClass: 'browse-pop',
    minWidth: 200,
    options: [{ value: '', label: 'Every provider' }].concat(
      PROVIDER_ROWS.filter((p) => p.available && providerHasSavedKey(p.id, k))
        .map((p) => ({ value: p.id, label: p.name }))),
    onChange: (value) => { setModelFilter(ALL_MODELS_SCOPE, { provider: String(value) }); render(myMountToken); },
  };
  pendingListboxes.push(provCfg);

  const sortCfg = {
    id: 'browse-sort-lb',
    ariaLabel: 'Sort models',
    value: f.sort,
    triggerClass: 'browse-pop',
    minWidth: 210,
    options: MODEL_SORT_OPTIONS.map(([value, label]) => ({ value, label })),
    onChange: (value) => { setModelFilter(ALL_MODELS_SCOPE, { sort: value }); render(myMountToken); },
  };
  pendingListboxes.push(sortCfg);

  // ── SORTED BY THE ONE SORTER, THEN MAPPED BACK TO ROWS ─────────────────
  // `orderModels` is the shelf's own sorter and takes model entries, so the two
  // surfaces cannot rank the same catalogue differently. Mapping back through a
  // BUCKET rather than a one-to-one Map is load-bearing: two providers can
  // legitimately serve the same entry, and a Map keyed on the entry would drop
  // the second row silently — a model vanishing when you change the ordering is
  // the "broken picker" reading `orderModels` itself refuses to produce.
  const ordered = orderModels(shown.map((r) => r.m), f.sort);
  const bucket = new Map();
  for (const row of shown) {
    const arr = bucket.get(row.m);
    if (arr) arr.push(row); else bucket.set(row.m, [row]);
  }
  const orderedRows = [];
  for (const m of ordered) {
    const arr = bucket.get(m);
    if (arr && arr.length) orderedRows.push(arr.shift());
  }

  const activeProvider = (k && typeof k.activeProvider === 'string') ? k.activeProvider : '';
  const defaultId = (b && typeof b.model === 'string') ? b.model : '';
  const busyId = typeof state.modelPickBusy === 'string' ? state.modelPickBusy : '';
  const pickDisabled = !!crossBusy || busyId !== '';
  // Read off the wire, with the same floor renderModelPicker used. It is the
  // number the panel PRINTS ("only 3 of the 9 runs needed"), so a local default
  // that drifted from the server's would be a false claim about a bar.
  const minRuns = Number.isFinite(k && k.minRunsToQualify) ? k.minRunsToQualify : 9;

  // ── THE BUILD-LANE CHIP ─────────────────────────────────────────────────
  //
  // FUNCTION-LOCAL, and that is deliberate — the same rule `renderQualifyPanel`
  // states for its own `QUALIFY_ABORT_REASONS`: NO NEW MODULE-LEVEL IDENTIFIER
  // enters the sandboxes that several suites build by extraction, because a
  // missing binding there is a CRASH rather than a failing assertion (the
  // v3.11.0 FN_NAMES shape). This function is the only surface that renders the
  // chip — block 2's list deliberately does not (see renderModelOption) — so
  // there is no second caller a shared builder would serve.
  //
  // TWO STRENGTHS, ONE VOCABULARY. `builds` means this model MAY build the
  // wiki; `building now` means it IS the one doing it. They are facts about
  // different numbers of rows — many, and exactly one — and one marker for both
  // would lose the thing a reader scanning this table is looking for.
  //
  // NOT A RECOMMENDATION AND NOT A RANKING: it states the eligibility the
  // server decides (`isBuildLaneModel`, mirrored by `laneBuildsWiki`). Price
  // plays no part — v3.16.0, price is a fact and never a gate — so a free model
  // and a dear one in the same lane wear the identical chip.
  //
  // IT IS NOT REDUNDANT WITH THE LANE CELL, because of `.browse-table-wrap
  // { overflow-x: auto }`: the lane cell is the LAST of five columns and
  // scrolls out of view in a narrow main column, which is the case the wrap
  // exists for. The name cell is the first and is always on screen. The chip is
  // where the fact survives; the cell is where the control is.
  const laneChip = (isNow) => (isNow === true
    ? '<span class="model-badge model-badge-lane model-badge-lane-now">building now</span>'
    : '<span class="model-badge model-badge-lane">builds</span>');

  const body = orderedRows.map(({ p, m, lane, qual }) => {
    const inUse = p.id === activeProvider && m.id === defaultId;
    const canBuild = laneBuildsWiki(lane);
    // ── THE SAME VERDICT THE BLOCK-2 PICKER READS, FROM THE SAME PRODUCER ───
    // This table was the third surface still offering a withdrawn model as if
    // nothing were wrong: the row for `minimax/minimax-m3:free` rendered
    // "Building your wiki" with no hint it is gone, on the same screen as a
    // banner saying so. `=== true` only — a null verdict renders nothing, for
    // the reason modelLiveMissing states.
    const gone = modelLiveMissing(k, p.id, m.id) === true;
    let laneCell;
    if (inUse) {
      // The lane cell states WHAT IS RUNNING, so on a withdrawn id it has to
      // state both halves: this is still the pinned build model (nothing is
      // re-pinned for you) AND it no longer exists. Dropping either half is a
      // different false sentence.
      laneCell = '<span class="browse-inuse">Building your wiki' +
        (gone ? ' — no longer offered' : '') + '</span>';
    } else if (canBuild && gone) {
      // A build-lane row the provider has withdrawn: the control is withheld
      // and REPLACED BY ITS REASON, never rendered disabled with the reason in
      // a tooltip only. This page's own rule (v3.16.1, and the `mlist-row`
      // comment one block up): a tooltip does not exist on touch, and it is the
      // one sentence explaining a control the user has just found unusable.
      laneCell = '<span class="browse-chatonly">not available to pick</span>';
    } else if (canBuild) {
      laneCell = '<button type="button" class="btn btn-secondary btn-xs"' +
        ' data-build-model="' + escapeHtml(m.id) + '" data-build-provider="' + escapeHtml(p.id) + '"' +
        (pickDisabled ? ' disabled' : '') + '>Use for building</button>';
    } else {
      // NEVER "cannot build". `jsonRaw === null` means UNMEASURED, and llm.js
      // records in as many words that unmeasured must never become a rejection
      // signal. The two absences are drawn apart here for the same reason
      // `measurementChip` refuses to collapse them.
      //
      // —— AND "NOT MEASURED YET" IS NOW A DOOR, NOT A DEAD END ——————————
      // The nine-run probe lived on the per-provider list, i.e. on the copy of
      // this table that has been removed — so the ONE path from "nobody has
      // measured this" into the build lane had no home. It belongs here: this
      // is the row that states the refusal, so it is the row that must offer
      // the way past it.
      //
      // Offered ONLY on the exact shape the server's own gate accepts —
      // CHAT_UNMEASURED on a provider whose `canQualify` is true — because a
      // model WE measured and found unfit (gemini-3.5-flash-lite, `jsonRaw:
      // false`) would get a refusal and nothing else, and a control whose only
      // outcome is a refusal is worse than no control. A TABLE LOOKUP, never
      // `p.id === 'openrouter'`: a fourth provider with a fetchable, unmeasured
      // catalogue would otherwise be silently stuck at "chat only" with nothing
      // on screen saying why.
      const provRow = PROVIDER_ROWS.find((r) => r.id === p.id);
      const canMeasure = !!(provRow && provRow.canQualify === true)
        && lane === MODEL_LANES.CHAT_UNMEASURED;
      const measuring = !!(state.qualify && state.qualify.modelId === m.id);
      const measureBtn = canMeasure
        ? '<button type="button" class="btn btn-secondary btn-xs model-qualify-btn"' +
            ' data-qualify-model="' + escapeHtml(String(m.id)) + '"' +
            (measuring || pickDisabled ? ' disabled' : '') + '>' +
            escapeHtml(qual ? 'Test again on my wiki' : 'Test on my wiki') + '</button>'
        : '';
      laneCell = ((isCuratorMeasured(m) || qual)
        ? '<span class="browse-chatonly">chat only — measured</span>'
        : '<span class="browse-unmeasured">not measured yet</span>') + measureBtn;
    }
    const ctx = formatTokenCount(m.contextLength);

    // —— THE EVIDENCE, IN AN EXPANDABLE ROW UNDER THE ROW IT BELONGS TO —————
    // A <details> cannot span table rows, so the disclosure is a BUTTON in the
    // name cell plus a second <tr> the renderer emits when it is open. The
    // state is recorded rather than left to the DOM for the reason every other
    // fold on this page records it: render() replaces the section wholesale and
    // this table repaints on a keystroke in the search box.
    //
    // FORCED OPEN WHILE THIS ROW IS BEING MEASURED, and that arm is not
    // optional: pressing Test re-renders, so without it the confirm panel the
    // press exists to produce would render inside a collapsed row and the press
    // would appear to do nothing — the v3.8.0 shape this repo has shipped once.
    const noteText = lane === MODEL_LANES.BUILD_LOCAL
      ? withoutLaneClaim(m.note)
      : (typeof m.note === 'string' ? m.note : '');
    const qualHtml = renderQualification(qual, minRuns, qualBaselineFor(k, p.id)) +
      ((state.qualify && state.qualify.modelId === m.id)
        // `defaultId` is what is building the wiki right now, so the done
        // panel can report that state instead of offering to set it again.
        ? renderQualifyPanel(state.qualify, minRuns, defaultId) : '');
    // v3.72.1 (audit F4): when the price was checked and the model measured.
    const asOfText = priceAsOfText(m);
    const hasDetail = !!(noteText.trim() || qualHtml || asOfText);
    const detailOpen = hasDetail &&
      (state.browseRowOpen[m.id] === true || !!(state.qualify && state.qualify.modelId === m.id));
    const expander = hasDetail
      ? '<button type="button" class="browse-detail-btn" data-browse-detail="' +
          escapeHtml(String(m.id)) + '" aria-expanded="' + (detailOpen ? 'true' : 'false') + '"' +
          ' aria-label="' + escapeHtml((detailOpen ? 'Hide' : 'Show') + ' what was measured about ' +
            (m.label || m.id)) + '">' + icon('chevronRight', 11) + '</button>'
      : '';
    const detailRow = detailOpen
      ? '<tr class="browse-detail" data-browse-detail-row="' + escapeHtml(String(m.id)) + '">' +
          '<td colspan="5">' +
            (asOfText ? '<p class="model-price-asof">' + escapeHtml(asOfText) + '</p>' : '') +
            (noteText.trim() ? '<p class="model-note">' + escapeHtml(noteText) + '</p>' : '') +
            qualHtml +
          '</td>' +
        '</tr>'
      : '';
    // ── THE ROW IS ADDRESSABLE BY MODEL ID ─────────────────────────────
    // The same attribute `renderModelOption`'s `<li>` carries, so "is this
    // model on the page at all?" is one question with one answer across both
    // surfaces. It is also what makes the duplicate check possible: with the
    // per-provider lists gone, no id may appear twice INSIDE this block, and an
    // attribute that exists on only one of the two renderings could not say so.
    // ── THE LANE, ON THE ROW ITSELF ────────────────────────────────────
    // THE MAINTAINER'S THIRD REPORT: in a 200-row table the rows that can
    // build the wiki looked exactly like the rows that cannot, and the only
    // tell was whether the last cell held a button — i.e. you had to read
    // across the whole row to learn the one thing the table is sorted and
    // filtered by. A coloured left rule and one chip carry it at a glance.
    //
    // DERIVED FROM `lane`, THE SAME PREDICATE THE CONTROL IS. `canBuild` is
    // `laneBuildsWiki(lane)`, which mirrors the server's own `isBuildLaneModel`
    // — so the marker and the button cannot come to disagree about a row, which
    // is exactly the drift this file records for the badge, the note and the
    // control before `lane` was resolved once.
    //
    // PRICE NEVER TOUCHES THIS. v3.16.0's rule: price is a fact, never a gate.
    // The rule and the chip say what a model may be used FOR, and a free model
    // and a dear one in the same lane are drawn identically.
    //
    // `data-lane` IS THE MARKER; the classes are the paint. A test asserting
    // "every build row and no chat row" needs one attribute, not a reading of
    // the class list.
    const inUseAttr = inUse ? ' data-build-current="1"' : '';
    return '<tr data-model-id="' + escapeHtml(String(m.id == null ? '' : m.id)) + '"' +
      (canBuild ? ' data-lane="build" class="browse-row-builds' + (inUse ? ' browse-row-inuse' : '') + '"'
                : '') + inUseAttr + '>' +
      '<td class="browse-name">' + expander + '<b>' + escapeHtml(m.label || m.id) + '</b>' +
        // ONE builder, shared with the block-2 picker row, so the two surfaces
        // cannot word one fact differently — the drift this file already
        // records for `dominated` / "out-performed".
        (canBuild ? laneChip(inUse) : '') +
        (gone ? renderGoneChip(p.name) : '') +
        '<small>' + escapeHtml(p.name) + ' · ' + escapeHtml(m.id) + '</small>' +
        // v3.72.1 (audit F3): a warning, so on the row, never behind the chevron.
        (livePriceText(m) ? '<small class="model-price-live" role="note">' + escapeHtml(livePriceText(m)) + '</small>' : '') +
        '</td>' +
      '<td class="browse-num mono">' + escapeHtml(formatPricePerM(m.input) || '—') + '</td>' +
      '<td class="browse-num mono">' + escapeHtml(formatPricePerM(m.output) || '—') + '</td>' +
      '<td class="browse-num mono">' + escapeHtml(ctx || '—') + '</td>' +
      '<td>' + laneCell + '</td>' +
    '</tr>' + detailRow;
  }).join('');

  // ── THE COUNT LINE, INCLUDING WHAT IS NOT ON IT ────────────────────────
  // `batchHidden` names ids the eligibility filter removed because they answer
  // 404 on every synchronous call. Stating the number is the difference between
  // a catalogue that is smaller than the vendor's and a catalogue that is
  // silently partial — and v3.42.0 records what silence there cost: 26% of the
  // picker was dead rows nobody could see were dead. A NULL is not a zero: an
  // older backend that never sent the field renders no clause at all.
  const hidden = (Number.isInteger(counts.batchHidden) && counts.batchHidden > 0)
    ? ' · ' + String(counts.batchHidden) + ' batch-only ids hidden — they answer 404 on every call'
    : '';
  const countLine = (orderedRows.length === rowsAll.length
    ? String(rowsAll.length) + ' models'
    : 'Showing ' + String(orderedRows.length) + ' of ' + String(rowsAll.length)) + hidden;

  // ── THE LIVE PROBE PANEL LIVES IN ITS ROW — AND THIS IS THE ONE GAP ─────
  // Every row that can be measured renders the panel inside its own expandable
  // detail row, which is where the press happened. The one case that leaves is
  // a model being measured that the CURRENT FILTER has removed from the table:
  // press Test, narrow the search, and the panel would vanish mid-run with a
  // live stream still attached to it. So the block-level host stays, and it
  // renders ONLY when the qualifying model is not among the drawn rows — never
  // as a second copy, which would put two `id="qualify-confirm"` on one page and
  // make revealInMain scroll to whichever came first.
  const qualifyingId = state.qualify ? state.qualify.modelId : null;
  const qualifyingDrawn = !!qualifyingId && orderedRows.some(({ m }) => m && m.id === qualifyingId);
  const worthHtml = renderWorthTesting(rowsAll, b, pickDisabled) +
    ((state.qualify && !qualifyingDrawn)
      ? '<div class="browse-qualify-host" id="browse-qualify-host">' +
          '<p class="browse-qualify-orphan">A measurement is running on <code class="mono">' +
          escapeHtml(String(qualifyingId)) + '</code>, which the filters above have removed from ' +
          'the table.</p>' +
          renderQualifyPanel(state.qualify, minRuns, defaultId) +
        '</div>'
      : '');

  const empty = orderedRows.length === 0
    ? '<div class="model-filter-empty"><p>No model matches these filters.</p>' +
      '<button type="button" class="btn btn-secondary btn-xs" data-model-filter-clear="' +
        escapeHtml(ALL_MODELS_SCOPE) + '">Clear filters</button></div>'
    : '';

  return (
    '<div class="browse-facets">' +
      '<span class="theme-segmented browse-seg" role="group" aria-label="Model lane">' + laneSeg + '</span>' +
      '<span class="browse-seg-caption">Input price per 1M tokens</span>' +
      '<span class="theme-segmented browse-seg" role="group" aria-label="Input price per 1M tokens">' + bandSeg + '</span>' +
      '<input type="search" class="model-filter-q browse-q" data-model-filter-q="' +
        escapeHtml(ALL_MODELS_SCOPE) + '" placeholder="Search name or id"' +
        ' aria-label="Search models by name or id" value="' + escapeHtml(f.q) + '">' +
      renderListboxHtml(provCfg) +
      renderListboxHtml(sortCfg) +
    '</div>' +
    '<p class="mono browse-count">' + escapeHtml(countLine) + '</p>' +
    (orderedRows.length
      ? '<div class="browse-table-wrap"><table class="browse-table">' +
          '<thead><tr>' +
            '<th>Model</th>' +
            '<th class="browse-num">In /1M</th>' +
            '<th class="browse-num">Out /1M</th>' +
            '<th class="browse-num">Context</th>' +
            '<th>Build lane</th>' +
          '</tr></thead>' +
          '<tbody>' + body + '</tbody>' +
        '</table></div>'
      : empty) +
    worthHtml +
    // ── THE FOOTER IS ONE SENTENCE AND NO CONTROLS ─────────────────────────
    // `Open Model Lab` navigated NOWHERE — it opened every provider's <details>
    // and scrolled, i.e. a scroll dressed as a destination, and the thing it
    // scrolled to no longer exists. `Refresh catalogue` was the SAME action as
    // the per-provider control under a second name, through the same
    // `data-sync-catalogue` hook and the same route; one action under two names
    // is worse than two actions, because the second name implies a second thing
    // to learn. It lives once now, in the Model lists group, named after the
    // provider it refreshes.
    //
    // THE SENTENCE ITSELF IS NEVER FOLDED. It is the rule that stops this table
    // reading as a gate on what a user may spend their own key on, and v3.16.0
    // states it in as many words: price is a displayed FACT, never a quality
    // gate. A rule behind a click is not a rule.
    '<div class="browse-foot">' +
      '<span class="browse-foot-t">Nothing here is hidden from chat. A model only leaves the ' +
      'build lane by failing a measurement, never by price.</span>' +
      '<span class="browse-foot-sp"></span>' +
    '</div>'
  );
}


/**
 * ── ONE NUMBERED BLOCK ─────────────────────────────────────────────────────
 *
 * The page is FOUR blocks read top to bottom, and the number is part of the
 * argument rather than decoration: block 1 is the only one that can do anything
 * on a fresh install, and every block below it is present and honestly empty
 * until it can. Hiding an empty block would silently lose a step and the page
 * would stop reading as a sequence — which is exactly what the old order
 * (build → chat → Connections → shelf) asked a user to do: choose a model
 * before they own a key.
 *
 * The heading stays `<h2 class="settings-job-title">`: the sidebar's own
 * `<h1>` names the section, so a second `h1` here would be a competing document
 * title, and scripts/test-next-model-picker.js indexes the page order off this
 * exact markup.
 *
 * ── THE LEDE IS ONE SENTENCE, AND THE REST IS BEHIND THE ⓘ ─────────────────
 * The maintainer's verdict on this page was "a sea of information": four
 * ledes totalling ~130 words, read before a single control. So each block now
 * states ONE sentence — the fact a reader needs to know what the block is for
 * — and folds the argument behind the shared `[data-tx-info]` mark that
 * domains.js's section headers already use (v3.50.0). ONE mark per block, and
 * its panel is a SIBLING of the lede INSIDE this wrapper, so the fold and the
 * thing it explains cannot be separated by a repaint or by a later edit that
 * moves one of them.
 *
 * `infoKey` is a key into shared/explainers.js (v3.71.1), rendered by the
 * shared explainer kit; null renders no mark at all. The panel therefore
 * never contains a control but the guide link, and never carries a warning,
 * a cost or an outcome — those stay in the block's own body, unfolded.
 *
 * `num` MAY BE null, and a null is a statement rather than a missing value.
 * The numerals on Providers & keys are an argument: that page reads top to
 * bottom as a sequence. A section that is merely a section — General's
 * Software update, Appearance, System check — is not step 1 of anything, and
 * a numeral there would claim an order the page does not have. A null renders
 * no `.settings-block-num` AND adds `settings-block-unnumbered`, which zeroes
 * the 32px indent that exists only to clear a numeral; without that the prose
 * would hang inside a heading with nothing to its left. Every caller that
 * passes a number is byte-identical to before.
 *
 * `noticeHtml` is rendered ABOVE the heading and INSIDE this wrapper. Block 2
 * is the only caller: a banner about the build model belongs to block 2 and to
 * nothing else, and putting it BETWEEN two blocks would belong to neither AND
 * break the `.settings-job-block + .settings-job-block` adjacency that is now
 * the page's only source of block-to-block spacing.
 */
function settingsBlock(num, id, title, ledeHtml, bodyHtml, infoKey, noticeHtml) {
  // v3.71.1: the 6th argument is an EXPLAINER KEY (shared/explainers.js) or
  // null — never prose — so no block can carry a panel that is not an
  // explainer. The panel id is unchanged: `settings-block-info-<id>`.
  const info = infoKey
    ? explainerMark('settings-block-info-' + id, infoKey)
    : { btn: '', panel: '' };
  // `== null` on purpose — undefined from a 6-argument call and an explicit
  // null both mean "this block is not a step". A falsy test would swallow 0,
  // and while no block is numbered 0 today, a numbering scheme silently
  // losing one of its values is the kind of thing nobody finds twice.
  const numbered = num != null;
  return (
    '<div class="settings-job-block settings-block settings-block-' + escapeHtml(id) + '' +
      (numbered ? '' : ' settings-block-unnumbered') + '">' +
      (noticeHtml || '') +
      '<div class="settings-block-hd">' +
        (numbered
          ? '<span class="settings-block-num" aria-hidden="true">' + escapeHtml(String(num)) + '</span>'
          : '') +
        '<h2 class="settings-job-title">' + escapeHtml(title) + '</h2>' +
      '</div>' +
      (ledeHtml
        ? '<p class="settings-job-lede settings-block-lede">' + ledeHtml + info.btn + '</p>' +
          (info.panel ? '<div class="settings-block-info">' + info.panel + '</div>' : '')
        : '') +
      '<div class="settings-block-body">' + bodyHtml + '</div>' +
    '</div>'
  );
}

/**
 * ── BLOCK 1 · CONNECT A PROVIDER ───────────────────────────────────────────
 *
 * The only block that can act on a fresh install, so it leads — and only on a
 * fresh install does it say so. The bold **Start here.** is dropped the moment
 * ANY provider is connected and the rest of the sentence is byte-identical, so
 * the lede does not become a different sentence the second time you read it.
 *
 * ── THE LOCAL MODEL IS A FOOTNOTE, NOT A ROW ───────────────────────────────
 * It used to be a permanently disabled row carrying a disabled `Replace`, a
 * "not available" key field and a "not available in this build" state cell:
 * four controls' worth of chrome for a thing that cannot be done. The sentence
 * says the same fact and adds the part the row could not — that it is not
 * missing from YOUR install, it does not exist yet — which is the difference
 * between a broken install and an unbuilt feature.
 *
 * `renderProviderRow` still renders that arm (`available: false`) and
 * scripts/test-next-provider-rows.js still executes it; it is simply not called
 * from here. Nothing about that function changed for the unavailable case.
 */
function renderConnectBlock(k, crossBusy) {
  const rows = PROVIDER_ROWS
    .filter((p) => p.available)
    .map((p) => renderProviderRow(p, k, crossBusy, { allowSetActive: false }))
    .join('');
  const anyKey = PROVIDER_ROWS.some((p) => p.available && providerConnected(p, k));

  // ── ONE SENTENCE VISIBLE, THE REST BEHIND THE ⓘ ────────────────────────
  // The second half — where the call goes — is reassurance, not instruction:
  // nobody needs it to press Add key, and everybody who wants it knows to look
  // for it. It is the whole sentence, unchanged, one click away. The
  // **Start here.** prefix still drops the moment ANY provider is connected,
  // so the visible lede does not become a different sentence on a second read.
  const lede =
    (anyKey ? '' : '<strong>Start here.</strong> ') +
    'One key per provider — connect as many as you like.';

  const body =
    // Directly above the key rows, because it exists to explain why the row the
    // user just saved did not become the one that builds the wiki.
    renderActivationNotice(state.keysActivationNotice) +
    '<div class="cur-group provider-row-list">' + rows + '</div>' +
    // A LOCAL MODEL, AS A SENTENCE. See the docblock.
    '<p class="settings-block-footnote">A <strong>local model</strong> — Ollama, LM Studio, ' +
    'llama.cpp — will connect here once there is a base-URL setting to point it at. It is not ' +
    'missing from your install; it does not exist yet.</p>' +
    // VERBATIM. Three facts, no adjectives, answering the question a
    // credentials screen actually raises.
    '<div class="settings-note-row">' +
      icon('lockAlt', 15) +
      '<span>Keys live in <code class="mono">.curator-config.json</code> at 0600 on this machine. Never committed, ' +
      'never sent anywhere except the provider you call.</span>' +
    '</div>';

  return settingsBlock(1, 'connect', 'Connect a provider', lede, body, 'settings.connect');
}

/**
 * ── BLOCK 4 · ALL MODELS ───────────────────────────────────────────────────
 *
 * Collapsed, because it answers "show me everything", which most users never
 * ask. Inside it is the faceted browse table — one row per model across every
 * connected provider, with the price columns in tabular numerals so a column of
 * prices reads as a column — then the "Worth testing" shelf, then the two
 * catalogue actions, then the per-provider catalogues that host the nine-run
 * Model Lab flow.
 *
 * IT IS ALSO THE BUILD PICKER IN BUILD MODE. `Change…` in block 2 opens this
 * disclosure with the "Can build" facet on, and every build-lane row here
 * carries the same `data-build-model` control block 2's own list does — one
 * endpoint, one handler, two entry points into the same list. What it is NOT is
 * a second place to decide about CHAT: that control is in the composer, and
 * this page says so once, in block 3.
 */
function renderAllModelsBlock(k, crossBusy) {
  const counts = catalogueCountsOf(k);
  const f = modelFilterFor(ALL_MODELS_SCOPE);
  const rowsAll = allCatalogueRows(k);

  const body = (counts.total === 0)
    ? '<div class="settings-empty-card">' +
        '<b>Nothing to browse yet.</b>' +
        '<span>Connect a provider above and its whole catalogue appears here, with search, ' +
        'filters and what each model costs.</span>' +
      '</div>'
    : renderModelBrowse(k, counts, f, rowsAll, crossBusy) +
      // ── ONE LIST, NOT ONE LIST PER PROVIDER ────────────────────────────
      // This used to be `renderCatalogueSync` + `renderModelPicker` per
      // provider: a SECOND copy of the table above, with a second search box, a
      // second sort and rows whose only "control" was the sentence
      // `can build — choose above`. The table survives because it is the one
      // that can actually be used — cross-provider, with the working pick
      // control, price bands and context — and docs/user-guide.md has stated
      // the principle ("one list, not one list per provider") since v3.45.0
      // while the screen did the opposite.
      //
      // What the per-provider cards genuinely owned was the REFRESH, and that
      // is what stays: one row per connected provider, saying how many models
      // it contributes and when that list was last checked, with one control.
      renderModelListsGroup(k, crossBusy);

  const lede = 'The full catalogue for every provider you have connected, with search and filters.';

  const shelf =
    '<details class="settings-shelf"' + (state.modelShelfOpen === true ? ' open' : '') +
      ' data-model-shelf="1">' +
      '<summary class="settings-shelf-summary">' +
        icon('chevronRight', 12) +
        '<span class="settings-shelf-title">Every model, all providers</span>' +
        '<span class="mono settings-shelf-count">' +
          escapeHtml(counts.total === 0 ? 'nothing connected yet' : '· ' + String(counts.total)) +
        '</span>' +
      '</summary>' +
      '<div class="settings-shelf-body">' + body + '</div>' +
    '</details>';

  return settingsBlock(4, 'all', 'All models', lede, shelf, 'settings.all-models');
}

/**
 * ── "MODEL LISTS" — ONE ROW PER CONNECTED PROVIDER ─────────────────────────
 *
 * The maintainer could not tell the two refresh controls apart, and he was
 * right not to be able to: `Refresh catalogue` in block 4's footer and
 * `Refresh model list` on the OpenRouter card carried the SAME
 * `data-sync-catalogue` hook and posted to the SAME route. One action under two
 * names is worse than two actions, because the second name implies a second
 * thing to understand. There is now ONE control per provider and it NAMES the
 * provider, so "which list does this refresh?" is answered by the button.
 *
 * TWO KINDS OF LIST, AND THE ROW SAYS WHICH IT IS:
 *   · a FETCHED catalogue (OpenRouter today) — a public list The Curator pulls
 *     and re-admits through its own filter. Refreshable, and the row carries
 *     when it was last refreshed, how many loaded, and the funnel.
 *   · a MEASURED list (Gemini, Anthropic) — hand-typed entries, each one run
 *     against the real ingest prompt. There is nothing to refresh; what a user
 *     can ask is whether the provider still OFFERS the model in force, which is
 *     what `POST /api/config/models/check` answers.
 *
 * Both kinds are decided by a null-prototype LOOKUP, never `p.id ===
 * 'openrouter'` — the comparison this file forbids by name twice, and the shape
 * that once rendered one provider's masked key beside another's name (v3.10.1).
 * A fourth provider with a fetchable catalogue lands here with one added line.
 */
function renderModelListsGroup(k, crossBusy) {
  if (!k) return '';
  const rows = PROVIDER_ROWS
    .filter((p) => p.available && providerHasSavedKey(p.id, k))
    .map((p) => renderModelListRow(p, k, crossBusy))
    .filter(Boolean)
    .join('');
  if (!rows) return '';
  return (
    '<div class="settings-model-lists" id="settings-model-lists">' +
      '<p class="cur-group-title">Model lists</p>' +
      '<div class="cur-group">' + rows + '</div>' +
    '</div>'
  );
}

/** Which providers publish a catalogue The Curator can refetch. */
const CATALOGUE_SYNC_PROVIDERS = Object.assign(Object.create(null), { openrouter: true });

/**
 * One provider's row in the Model lists group.
 *
 * THE LANE PILL IS AN IDENTITY TEST against this row's own id, so it is
 * symmetric for any provider and a third cannot fall into another's arm. The
 * words changed with it: `active provider` and `chat` were developer
 * vocabulary for two facts a user cares about — which key is being billed for
 * the wiki, and which is only ever billed a question at a time.
 */
function renderModelListRow(p, k, crossBusy) {
  if (!p || !p.available || !k) return '';
  const list = (k.offerable && Array.isArray(k.offerable[p.id])) ? k.offerable[p.id] : null;
  const canSync = CATALOGUE_SYNC_PROVIDERS[p.id] === true;

  const isActive = !!(k.activeProvider && k.activeProvider === p.id);
  const pill = isActive
    ? '<span class="mlist-lane mlist-lane-live">builds your wiki</span>'
    : '<span class="mlist-lane mlist-lane-idle">chat only</span>';

  // A NULL list is "the server told us nothing about this provider" (an older
  // backend, a truncated payload); an EMPTY array is "it told us there are
  // none". Only the second is a number worth printing — the same two-absences
  // rule renderModelPicker applied, kept rather than inherited by accident.
  const countTxt = list ? String(list.length) + (list.length === 1 ? ' model' : ' models') : '';

  const facts = [];
  if (countTxt) facts.push(countTxt);

  let control;
  let extra = '';
  if (canSync) {
    const META_BY_PROVIDER = Object.assign(Object.create(null), { openrouter: k.openrouterCatalogue });
    const meta = (META_BY_PROVIDER[p.id] && typeof META_BY_PROVIDER[p.id] === 'object')
      ? META_BY_PROVIDER[p.id] : null;
    const last = (state.catalogueSync && typeof state.catalogueSync[p.id] === 'object' && state.catalogueSync[p.id])
      ? state.catalogueSync[p.id] : null;
    const when = formatSyncedAt(meta && meta.syncedAt) || (last ? formatSyncedAt(last.syncedAt) : '');
    const loadedCount = (meta && typeof meta.count === 'number' && Number.isFinite(meta.count))
      ? meta.count : null;
    const notLoaded = !!(meta && meta.loaded === false);
    const isStale = !!(meta && meta.stale === true && meta.reason === 'stale');

    // THE STATUS LINE IS ON THE SAME ROW AS THE BUTTON, always. v3.15.2's own
    // finding: a refusal painted where the user is not looking reads as "my
    // click didn't register". The same holds for a freshness claim — "Last
    // refreshed" only means anything beside the thing that refreshes.
    if (notLoaded) facts.push('no list fetched yet');
    else if (when) facts.push('Last refreshed ' + when + (isStale ? ' — more than a day ago' : ''));
    else if (last) facts.push('refreshed, but no usable time came with it');
    else facts.push('not refreshed yet');
    // ── "0 loaded" IS NOT A MEASUREMENT, IT IS THE ABSENCE OF ONE ────────
    // FOUND BY RENDERING IT. On a fresh install the row read "no list fetched
    // yet · 0 loaded" — two clauses for one fact, the second of them asserting
    // a count of a list that was never fetched. `loaded` is suppressed on the
    // not-loaded branch and on a zero for the same reason `batchHidden`
    // suppresses a null: a zero states that we looked and found none, which is
    // exactly what did not happen here.
    if (!notLoaded && loadedCount !== null && loadedCount > 0) {
      facts.push(formatTokenCount(loadedCount) + ' loaded');
    }

    const busy = state.catalogueSyncBusy === p.id;
    const disabled = busy || !!crossBusy || state.catalogueSyncBusy !== null;
    // ── WHY THE BUTTON IS GREY, AS A VISIBLE LINE ──────────────────────
    // The card this replaced carried the reason in a `title=` on the button.
    // A tooltip is hover-only: it does not exist on touch, and it is the one
    // sentence explaining a control the user has just found disabled.
    // scripts/test-next-title-affordances.js keeps a ceiling on exactly that
    // shape, and rather than spend one of its allowance this states the reason
    // where the row already has room for a sentence.
    if (crossBusy && !busy) {
      facts.push(crossWriteTitle('refreshing the model list mid-run could pull the model that run is using.'));
    }
    control =
      '<button type="button" class="btn btn-secondary btn-xs catalogue-sync-btn"' +
        ' data-sync-catalogue="' + escapeHtml(String(p.id)) + '"' +
        (disabled ? ' disabled' : '') + '>' +
        // BYTE-IDENTICAL busy label. `Refreshing…` is pinned by
        // scripts/test-next-providers-page.js and by the maintainer's muscle
        // memory alike; only the resting label names the provider.
        (busy ? 'Refreshing…' : 'Refresh ' + p.name + ' model list') +
      '</button>';

    extra = renderCatalogueSyncDetail(p, k, last);
  } else {
    facts.push('the list The Curator has measured');
    // ── "NOT CHECKED YET" IS A DIFFERENT FACT FROM "WE CANNOT TELL" ──────
    // The route does not PERSIST a Gemini/Anthropic verdict, so after every
    // restart this row genuinely has no answer — and the difference between
    // "nobody has asked" and "we asked and could not find out" is exactly the
    // distinction `liveMissing`'s third value exists for. Said here, once, so
    // the blank beside the button does not read as a permanent unknown.
    if (!(state.modelCheck && state.modelCheck[p.id])
      && !(state.modelCheckError && state.modelCheckError[p.id])) {
      facts.push('not checked since this app started');
    }
    const busy = state.modelCheckBusy === p.id;
    // NOT gated on crossBusy, and for the same reason `Test this key` is not:
    // this request WRITES NOTHING. It asks the provider what it currently
    // lists. Disabling a read-only diagnostic during a long ingest removes the
    // tool at the exact moment somebody is asking "is the model the problem?".
    control =
      '<button type="button" class="btn btn-secondary btn-xs"' +
        ' data-check-models="' + escapeHtml(String(p.id)) + '"' +
        (busy ? ' disabled' : '') + '>' +
        (busy ? 'Checking…' : 'Check ' + p.name + ' model availability') +
      '</button>';
  }

  const verdict = renderModelCheckResult(p);

  return (
    '<div class="cur-group-row mlist-row" data-model-list="' + escapeHtml(String(p.id)) + '">' +
      '<span class="cur-group-label">' +
        '<b>' + escapeHtml(p.name) + pill + '</b>' +
        (facts.length ? '<span>' + escapeHtml(facts.join(' · ')) + '</span>' : '') +
      '</span>' +
      '<span class="cur-group-control mlist-act">' + control + verdict + '</span>' +
    '</div>' +
    extra
  );
}

/**
 * The `POST /api/config/models/check` verdict, rendered BESIDE THE BUTTON THAT
 * PRODUCED IT.
 *
 * THREE OUTCOMES AND THREE SENTENCES, and `liveMissing` is read `=== true` /
 * `=== false` rather than for truthiness: the route sends three values and the
 * third is "we could not tell". An unknown must never render as either answer —
 * reporting "not listed" from a request that failed would send a user off to
 * change a model that is fine, and reporting "listed" would hide a real one.
 */
function renderModelCheckResult(p) {
  if (!p) return '';
  const err = (state.modelCheckError && typeof state.modelCheckError[p.id] === 'string')
    ? state.modelCheckError[p.id] : '';
  if (err) {
    // ── THE ROUTE'S OWN SENTENCE, RENDERED WHERE THE CLICK HAPPENED ──────
    // `POST /api/config/models/check` answers 400 with a written sentence for
    // the one refusal a user can act on — "No gemini key is saved in Settings
    // — connect one before checking its model list." It is rendered HERE,
    // beside the button, and never as a page-level error: v3.6.0's finding is
    // that a refusal painted where the user is not looking reads as "my click
    // didn't register", and the observed next action is a retry. The prefix is
    // dropped when the server already wrote a whole sentence, because
    // "Could not check — No gemini key is saved…" is two openings for one
    // message.
    const whole = /^[A-Z]/.test(err) && /[.!?]$/.test(err.trim());
    return '<span class="mlist-verdict mlist-verdict-warn" role="status">' +
      escapeHtml(whole ? err : 'Could not check — ' + err) + '</span>';
  }
  const r = (state.modelCheck && typeof state.modelCheck[p.id] === 'object' && state.modelCheck[p.id])
    ? state.modelCheck[p.id] : null;
  if (!r) return '';
  if (typeof r.error === 'string' && r.error) {
    return '<span class="mlist-verdict mlist-verdict-warn" role="status">' +
      escapeHtml('Could not check — ' + r.error) + '</span>';
  }
  // "just now" only for a live answer. A cached verdict says WHEN, because the
  // whole value of this control is the freshness of the answer and claiming a
  // cache read happened "just now" would be the one false word on the row.
  const when = (r.source === 'cache')
    ? ('checked ' + (formatSyncedAt(r.checkedAt) || 'earlier'))
    : 'checked just now';
  const chosen = (typeof r.chosen === 'string' && r.chosen) ? r.chosen : '';
  if (r.liveMissing === false) {
    return '<span class="mlist-verdict" role="status">' +
      escapeHtml(when + ' — ' + (chosen ? chosen + ' is listed' : 'your model is listed')) + '</span>';
  }
  if (r.liveMissing === true) {
    return '<span class="mlist-verdict mlist-verdict-warn" role="status">' +
      escapeHtml(when + ' — ' + (chosen ? chosen : 'your model') + ' is not listed by ' + p.name) +
      '</span>';
  }
  return '<span class="mlist-verdict mlist-verdict-warn" role="status">' +
    escapeHtml(when + ' — ' + p.name + ' did not say either way, so nothing is claimed') + '</span>';
}

/**
 * Everything one refresh REPORTED, under the row that performed it.
 *
 * MOVED, NOT REWRITTEN. The funnel, the per-rule counts, the session-only
 * warning and the refusal all came off `renderCatalogueSync` verbatim; what
 * changed is that they now sit in a stacked row of the same group instead of a
 * card of their own, so the only spacing on this screen is the kit's.
 *
 * THE LANE SENTENCE IS SPLIT, AND THE SPLIT IS THE POINT. It was 73 words and
 * it carries ONE fact a user must not miss — a fetched model arrives chat only.
 * That fact is a visible line. The reason (a price is published, a capability
 * is not) and the way in (measure it yourself) fold, because they explain the
 * line rather than add to it.
 */
function renderCatalogueSyncDetail(p, k, last) {
  if (!p || !k) return '';

  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const counts = [];
  if (last) {
    const t = num(last.total), e = num(last.eligible), a = num(last.admitted), r = num(last.refused);
    if (t !== null) counts.push(formatTokenCount(t) + ' listed by ' + p.name);
    if (e !== null) counts.push(formatTokenCount(e) + ' met our requirements');
    if (a !== null) counts.push(formatTokenCount(a) + ' added here');
    const sup = num(last.superseded);
    if (sup !== null && sup > 0) counts.push(formatTokenCount(sup) + ' already measured');
    if (r !== null && r > 0) counts.push(formatTokenCount(r) + ' refused');
  }
  const countsHtml = counts.length
    ? '<span class="mono catalogue-sync-counts">' + escapeHtml(counts.join(' · ')) + '</span>'
    : '';

  // Rendered ONLY on an explicit `false`: "we were not told" must not become
  // "it failed". VERBATIM — it is the sentence that stops a user wondering why
  // their model disappeared after a restart, and it is NEVER folded.
  const sessionOnly = (last && last.persisted === false)
    ? '<span class="catalogue-sync-note catalogue-sync-warn">These models are loaded for this ' +
      'session only — The Curator could not save the list, so a restart will lose them. ' +
      'Refresh again after restarting.</span>'
    : '';

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
    // The `data-` hook is what makes this fold survive a re-render: render()'s
    // capture/restore pair keys on the composed data-attributes an element
    // already carries, and a <details> with none of them cannot be keyed. This
    // was the one live disclosure on the page with no hook at all.
    ? '<details class="catalogue-funnel" data-catalogue-funnel="' + escapeHtml(String(p && p.id ? p.id : '')) + '">' +
        '<summary class="catalogue-funnel-summary">Why models were left out</summary>' +
        '<ul class="catalogue-funnel-list">' + funnelRows + '</ul>' +
      '</details>'
    : '';

  const errText = (state.catalogueSyncError && typeof state.catalogueSyncError[p.id] === 'string')
    ? state.catalogueSyncError[p.id]
    : '';
  const errHtml = errText
    ? '<div class="settings-inline-error catalogue-sync-error" role="alert">' + escapeHtml(errText) + '</div>'
    : '';

  const laneInfo = explainerMark('settings-fetched-lane-info-' + p.id, 'settings.fetched-models');

  const body =
    '<span class="catalogue-sync-note">Fetched models arrive <strong>chat only</strong> — they have ' +
    'never been measured against The Curator’s ingest prompt.' + laneInfo.btn + '</span>' +
    laneInfo.panel +
    countsHtml + sessionOnly + funnelHtml + errHtml;

  return '<div class="cur-group-row cur-group-row-stack mlist-detail">' + body + '</div>';
}

/**
 * ── THE BUILD MODEL IS GONE ────────────────────────────────────────────────
 *
 * `liveMissing` is THREE-VALUED on the wire and is read as such here:
 *
 *   true   the provider's own live list does not contain the model in force.
 *          Every ingest, Health scan and Compile from now on asks for a model
 *          that is not there, so this is a banner, not a footnote.
 *   false  it is listed. Nothing to say.
 *   null   we could not find out — no key, the check has never run, the request
 *          failed. AN UNKNOWN MUST NOT READ AS GONE: sending a user to change a
 *          working model because we could not reach a list endpoint is a worse
 *          outcome than saying nothing, and it is the direction this repo has
 *          got wrong before (a fact and its ABSENCE collapsed into one value,
 *          v3.16.0).
 *
 * It is rendered INSIDE block 2 and above its heading — see settingsBlock's
 * `noticeHtml`. It is not a `<details>` and carries no fold: a banner about
 * what is being billed is the fallback banner's own rule, one screen up.
 */
function modelGoneFacts(k) {
  const b = buildLaneFacts(k);
  if (!b || b.liveMissing !== true) return null;
  return {
    provider: b.provider,
    providerLabel: providerLabel(b.provider) || b.provider,
    model: b.model,
    name: buildModelDisplayName(k, b) || b.model,
  };
}

function renderModelGoneBanner(k) {
  const g = modelGoneFacts(k);
  if (!g) return '';
  return (
    '<div class="provider-gone-banner" role="alert">' +
      icon('alertTriangle', 15) +
      '<div class="provider-gone-body">' +
        '<span class="provider-gone-headline"><strong>' + escapeHtml(g.name) + '</strong> is no ' +
          'longer offered by ' + escapeHtml(g.providerLabel) + ' — pick another build model.</span>' +
        // ── WHAT THIS SENTENCE USED TO SAY, AND WHY IT WAS FALSE ───────────
        // "The Curator falls back rather than failing, and a fallback is not
        // always cheaper." That was written before the pre-spend gate existed
        // and shipped one release after it: `POST /api/ingest` and the batch
        // queue REFUSE on a positive `missing` verdict, before the first paid
        // call, with `code: 'MODEL_GONE'` (src/routes/ingest.js,
        // src/brain/ingest-queue.js). Telling a user a run will quietly
        // continue on something else, when it will not start at all, is the
        // one direction of this mistake they cannot plan around.
        //
        // ── AND WHY THE REPLACEMENT STOPS WHERE IT DOES ────────────────────
        // The obvious rewrite — "chat, Compile and Health scans fail with this
        // message until you pick another model" — is true of the model this
        // release was built for and NOT true in general. Those three carry no
        // pre-spend gate at all; what happens on the call is the provider's
        // answer, and `callLLM` treats the shapes differently: an OpenRouter
        // refusal is tagged `curatorDeterministic` and throws, and a FREE head
        // has every paid rung withheld (`fallbackRungsFor`) so it has nowhere
        // to go — but a PAID Gemini or Anthropic id that 404s is `model-retired`
        // and still walks FALLBACK_CHAINS, which is documented and deliberate.
        // So the clause claims only what holds on every path: there is no gate,
        // and the pin does not move. `docs/model-lifecycle.md` § "Why there is
        // no automatic re-pin" is the source for the second half.
        '<span class="provider-gone-sub">Ingest and the batch queue refuse to start with ' +
          '<code class="mono">' + escapeHtml(g.model) + '</code> before spending anything. ' +
          'Chat, Compile and Health scans carry no such gate — they go on asking for it on every ' +
          'run. Nothing is re-pinned for you either way: this stays your build model until you ' +
          'change it here.</span>' +
        '<span class="provider-gone-action">' +
          '<button type="button" class="btn btn-secondary btn-xs" data-model-gone-pick="' +
            escapeHtml(g.provider) + '">Pick another build model</button>' +
        '</span>' +
      '</div>' +
    '</div>'
  );
}

function renderProviders() {
  if (state.keysError) {
    // CUT. This was a second, shorter copy of SECTION_INFO.providers rendered
    // only on the error path — and on that path the useful thing is the error,
    // not a restatement of the section's premise. The premise is one click away
    // on the header's info mark, on this branch as on every other.
    return '<div class="settings-inline-error">' + escapeHtml(state.keysError) + '</div>';
  }
  if (!state.keys) {
    return gatedLoader(loadGate, 'Loading provider status…');
  }
  const k = state.keys;
  // Cross-view write gate (see file-header comment): a write in flight
  // anywhere depends on getProviderInfo() resolving consistently for the
  // rest of its run — Save/Disconnect/the build pick can change that mid-write.
  const crossBusy = crossWriteBusy();

  return (
    renderCrossWriteBanner('wait for it to finish before changing keys or the model that builds your wiki — it may be mid-call.') +
    (state.keysActionError ? '<div class="settings-inline-error">' + escapeHtml(state.keysActionError) + '</div>' : '') +
    // Deliberately ABOVE everything and never behind a disclosure: a fallback
    // is a silent change to what the user is billed.
    renderFallbackBanner(k.fallback) +
    // ── 1 ── the only block that can act on a fresh install
    renderConnectBlock(k, crossBusy) +
    // ── 2 ── what the money is spent on
    renderBuildBlock(k, crossBusy) +
    // ── 3 ── a statement and a pointer, never a second picker
    renderChatBlock(k) +
    // ── 4 ── the catalogue, folded
    renderAllModelsBlock(k, crossBusy)
  );
}

/**
 * ── THE THREE IDS THAT MAKE A REFUSAL REACHABLE ────────────────────────────
 *
 * `revealInMain` and `preserveMainScroll` both address the DOM by id, because
 * a node cannot survive the innerHTML replacement a render performs. These are
 * the three that have to be addressable after one.
 *
 * BUILD_PICK_ERROR_ID IS RENDERED IN AT MOST ONE PLACE AT A TIME. Two sites can
 * emit it — the row that owns the refusal, and renderBuildBlock's fallback for a
 * refusal no row owns — and renderBuildBlock decides between them, never both.
 * That keeps the id unique AND means one `role="alert"` is announced once.
 */
const BUILD_PICK_ERROR_ID = 'build-pick-error';
const QUALIFY_CONFIRM_ID = 'qualify-confirm';

/**
 * The id of one row's build-pick button.
 *
 * Read back with getElementById ONLY. A model id is a third party's string —
 * `z-ai/glm-4.7`, `minimax/minimax-m3:free` — so it carries `/` and `:`, which
 * are CSS combinators and would have to be escaped for querySelector.
 * getElementById takes the string verbatim, and the ids are unique because the
 * build list holds one row per (provider, model) pair.
 */
function buildPickButtonId(provider, modelId) {
  return 'build-pick::' + String(provider == null ? '' : provider) +
    '::' + String(modelId == null ? '' : modelId);
}

/**
 * ── BLOCK 2 · WHAT BUILDS YOUR WIKI ────────────────────────────────────────
 *
 * ONE CHOICE, ONE CONTROL, ACROSS PROVIDERS. Provider is a label on a row here.
 * `POST /api/config/api-keys/build-model` names provider AND model together and
 * applies both, so choosing a model from a different provider is one act rather
 * than "pin a model, then remember to activate its provider" — the two-step that
 * produced the inert pins this block also has to report.
 *
 * IT LEADS WITH WHAT IS TRUE RIGHT NOW, not with the list. "Which model does
 * what" is unanswerable from a catalogue; it is answered by one line naming the
 * model in force, where it came from, and who measured it.
 *
 * ── THE LIST IS BEHIND A DISCLOSURE, AND THE DISCLOSURE IS FORCED OPEN ─────
 * The popup is the everyday control; `Change…` reveals the full list, which is
 * where each candidate's price, measurement chip and Model-Lab entry live. The
 * markup is emitted whether or not it is open, so a refusal that belongs to a
 * ROW is in the document — and the disclosure is forced open whenever there is
 * a refusal or a write in flight, because v3.9.x already recorded that a confirm
 * rendered inside a collapsed disclosure is no confirm.
 */
function renderBuildBlock(k, crossBusy) {
  const cands = buildCandidates(k);
  const busyId = typeof state.modelPickBusy === 'string' ? state.modelPickBusy : '';
  const pickDisabled = !!crossBusy || busyId !== '';

  const errText = (state.modelPickError && typeof state.modelPickError.build === 'string')
    ? state.modelPickError.build : '';
  // ── THE REFUSAL GOES TO THE ROW THAT PRODUCED IT ───────────────────────
  // A user picks a model from a list ~19 rows long; rendering every refusal
  // at the TOP of the block put it off-screen for every row below the fold
  // (measured: y = -678 for the last one, with no scroll and no signal at the
  // click site). So the owning row renders it, and this block-level copy is
  // the FALLBACK for a refusal no row can render — an unknown provider, or a
  // model that has since left the list. Never both: one refusal, one alert.
  const errAt = (typeof state.modelPickErrorAt === 'string') ? state.modelPickErrorAt : '';
  const ownedByRow = !!(errText && errAt &&
    cands.some(({ p, m }) => p && m && (p.id + '::' + m.id) === errAt));
  const errHtml = (errText && !ownedByRow)
    ? '<div id="' + BUILD_PICK_ERROR_ID + '" class="settings-inline-error model-pick-error" role="alert">' +
      escapeHtml(errText) + '</div>'
    : '';

  const b = buildLaneFacts(k);

  // ── THE POPUP IS THE CONTROL, AND IT IS A REAL LISTBOX ─────────────────
  // shared/listbox.js, adopted here for the third time in this file. Not a
  // a native popup element: the house rule (and scripts/test-next-listbox.js's
  // whole-tree scan, which reds on the literal appearing even inside a comment)
  // is that no OS-drawn surface is left in these controls, and a native popup
  // could not carry the provider group and the price that make a row of this
  // list legible. ONE cfg object, rendered here and mounted
  // from `pendingListboxes` — never described twice.
  //
  // OFFERED ONLY WHEN IT LEADS SOMEWHERE. With one candidate (or none) a popup
  // is a control whose every use is a no-op, so the name renders as a
  // STATEMENT instead. The rule the composer's "Browse all" row already
  // follows: never offer an affordance that opens the thing already on screen.
  let popupHtml = '';
  if (b && cands.length > 1) {
    const cfg = {
      id: 'build-model-lb',
      ariaLabel: 'The model that builds your wiki',
      value: b.provider + '::' + b.model,
      disabled: pickDisabled,
      triggerClass: 'build-model-popup',
      minWidth: 320,
      options: cands.map(({ p, m }) => ({
        value: p.id + '::' + m.id,
        label: m.label || m.id,
        group: p.name,
        typeahead: (m.label || '') + ' ' + m.id,
        html: '<span class="lb-opt-label">' + escapeHtml(m.label || m.id) + '</span>' +
          '<span class="lb-opt-detail build-lb-id">' + escapeHtml(m.id) + '</span>' +
          '<span class="mono build-lb-price">' +
            escapeHtml(formatModelPrice(m.input, m.output) || 'price not published') + '</span>',
      })),
      onChange: (value) => {
        // Split at the FIRST separator only: a model id is a third party's
        // string and can contain anything, but a provider id cannot contain
        // `:` — so the left half is unforgeable. An unparseable value does
        // nothing rather than guessing, which is the same contract
        // parseModelOptionValue states in chat.js.
        const at = String(value).indexOf('::');
        if (at <= 0) return;
        onPickBuildModel(String(value).slice(0, at), String(value).slice(at + 2), myMountToken);
      },
    };
    pendingListboxes.push(cfg);
    popupHtml = renderListboxHtml(cfg);
  }

  // ── ONE EMPTY STATEMENT, NOT TWO ───────────────────────────────────────
  // With no model and no candidates, `renderBuildCurrent` already renders the
  // empty card that names the action — connect something, or measure something.
  // `renderBuildList`'s own empty sentence then landed directly underneath it
  // saying the same thing in different words, which reads as two problems.
  // Found by rendering the page, not by reading it. The list still renders its
  // empty sentence in the state that is genuinely different: a model IS
  // building the wiki and there is nothing else to switch to.
  const listHtml = (b || cands.length > 0)
    ? renderBuildList(cands, k, pickDisabled, !!crossBusy, busyId,
        ownedByRow ? errAt : '', ownedByRow ? errText : '')
    : '';

  // ── USED BY · N JOBS (v3.67.0) ─────────────────────────────────────────
  // One row per build-lane job, straight from AI_JOBS (buildLaneJobs(); see
  // the import's comment for the `typeof` guard). A STATIC description, not
  // live state, so it is a table in a fold row rather than a monitor (rule 4
  // covers live readings only), and it is closed by default: it answers "what
  // else does this choice move?", which is worth one click, not a screen.
  // `data-used-by` is the hook render() keys the open state on, and the
  // `toggle` listener in wireGlobalListeners writes it back to state.
  const jobs = typeof buildLaneJobs === 'function' ? buildLaneJobs() : [];
  const usedByHtml = jobs.length === 0 ? '' : (
    '<details class="settings-usedby" data-used-by="1"' + (state.usedByOpen === true ? ' open' : '') + '>' +
      '<summary class="settings-usedby-summary">' +
        icon('chevronRight', 12) +
        '<span class="settings-usedby-title">Used by</span>' +
        '<span class="mono settings-usedby-count">' +
          escapeHtml(jobs.length + (jobs.length === 1 ? ' job' : ' jobs')) + '</span>' +
      '</summary>' +
      '<div class="settings-usedby-body">' +
        '<table class="settings-usedby-table">' +
          '<caption class="visually-hidden">The jobs that run on your AI model</caption>' +
          '<thead><tr><th scope="col">Job</th><th scope="col">Started from</th>' +
            '<th scope="col">Cost shown</th></tr></thead>' +
          '<tbody>' + jobs.map((j) =>
            '<tr data-ai-job="' + escapeHtml(String(j.id)) + '">' +
              '<th scope="row">' + escapeHtml(String(j.label)) + '</th>' +
              '<td>' + escapeHtml(String(j.startedFrom)) + '</td>' +
              // A future version is not something the app shows today: a
              // `costShown` that is annotated with one ("after (v3.67.1)",
              // Shared Brain's row in AI_JOBS) reads what is TRUE today —
              // "not yet". View-level only; the registry's copy is J's.
              '<td class="mono">' + escapeHtml(/\(v\d+\.\d+(\.\d+)?\)/.test(String(j.costShown))
                ? 'not yet' : String(j.costShown)) + '</td>' +
            '</tr>').join('') +
          '</tbody>' +
        '</table>' +
        '<p class="settings-usedby-foot">Chat is separate: any connected model, per message, in the composer.</p>' +
      '</div>' +
    '</details>'
  );

  const body =
    renderBuildCurrent(k, pickDisabled, { popupHtml }) +
    errHtml +
    listHtml +
    usedByHtml;

  // ── THE LEDE NAMES EVERY JOB THE MODEL RUNS, DERIVED (v3.67.0) ─────────
  // Through v3.66.x it read "Ingest, Health scans and Compile all run on this
  // one model" — three of the six jobs that actually do. A user who switched
  // to a dearer model "to make chat better" was not told that Shared Brain
  // synthesis now bills it too. The nouns are the registry's rows, spoken:
  // each id maps to the word a sentence wants, a job with no entry here is
  // spoken by its own label (so a NEW job appears in the sentence without an
  // edit), and System check is the one deliberate omission — a one-call
  // connectivity check builds nothing and is not a thing a user runs "on" a
  // model; it is still counted and listed under Used by.
  const LEDE_NOUNS = {
    'ingest': 'ingest', 'compile': 'compile', 'wiki-health': 'wiki health',
    'shared-brain': 'Shared Brain', 'reading-plan': 'reading plans', 'system-check': null,
  };
  const nouns = jobs.map((j) => (Object.prototype.hasOwnProperty.call(LEDE_NOUNS, j.id)
    ? LEDE_NOUNS[j.id] : String(j.label).toLowerCase())).filter(Boolean);
  const spoken = nouns.length > 1
    ? nouns.slice(0, -1).join(', ') + ' and ' + nouns[nouns.length - 1]
    : (nouns[0] || '');
  const lede = spoken
    ? 'Every AI job runs on this one model: ' + escapeHtml(spoken) + '.'
    : 'Every AI job runs on this one model.';

  // The id stays 'build' (anchors, suites and the info-button id key on it);
  // only the title moved, the maintainer's Q2 (v3.67.0).
  return settingsBlock(2, 'build', 'Your AI model', lede, body, 'settings.build',
    renderModelGoneBanner(k));
}

/**
 * The headline: what builds the wiki right now, and why that model.
 *
 * ── `source` IS THE FACT THE OLD SCREEN COULD NOT STATE ────────────────────
 * "using gemini-2.5-flash-lite" cannot tell a user whether that is THEIRS
 * (pinned, and it will stay) or OURS (a default, and a release may move them) or
 * their SHELL's (`LLM_MODEL`, which outranks anything they click here). Those
 * are four different answers to "am I in control of this" once a fallback is
 * counted, and the route reports which one applies rather than leaving it to be
 * inferred.
 *
 * ── AND IT NAMES INERTNESS PLAINLY RATHER THAN PRETENDING IT CANNOT HAPPEN ──
 * Two distinct shapes, both real:
 *   · `source: 'selected'` with `selectedHonoured: false` (or `source:
 *     'fallback'`) — the user's pin is on the provider that builds and the
 *     engine still refused it (a stale id, a model pulled after a bad probe, a
 *     chat-only id pinned before that gate existed).
 *   · a pin under a NON-active provider — `inertPins`. The new route cannot
 *     create one; the old route still can, and the ones already on disk are
 *     still there.
 * Silence on either is the dead-data shape this repo keeps re-finding, in the
 * direction the user notices least: a choice nobody obeys, with no symptom.
 *
 * ── THE ID IS NOT IN MONOSPACE, AND THAT IS THE POINT OF THE BLOCK ─────────
 * A model has a NAME a person reads and an ID a machine reads. The old line put
 * the id in `<code class="mono">` and had no name at all, so the one thing on
 * the screen naming what the money is spent on was a vendor slug. The name now
 * leads in the text face; the id sits under it at `--text-2`, still selectable,
 * still exact. `formatModelPrice` keeps tabular numerals because a price is
 * digits that have to align with the ones in block 4.
 *
 * `opts` is trailing and defaulted: called with two arguments this renders the
 * same card with a STATEMENT where the popup would be, which is exactly the
 * one-candidate case, so the two-argument shape is a real state and not a test
 * affordance.
 */
function renderBuildCurrent(k, pickDisabled, opts) {
  const o = opts || {};
  const b = buildLaneFacts(k);
  if (!b) {
    // ── TWO DIFFERENT ABSENCES, AND ONLY ONE OF THEM IS "NOTHING BUILDS" ──
    // A keyed provider that offers nothing measured is a DIFFERENT state from
    // no key at all, and the two need different actions: one is "connect
    // something", the other is "measure something". Collapsing them tells a
    // user with a working key to go and get a key.
    const anyKey = PROVIDER_ROWS.some((p) => p.available && providerConnected(p, k));
    if (anyKey) {
      return '<div class="build-current build-current-none build-current-warn" role="status">' +
        '<span class="build-current-head">Your key works, and nothing behind it has been ' +
        'measured for building a wiki.</span>' +
        '<span class="build-current-why">Ingest, Health scans and Compile have no model to run ' +
        'on. Open <strong>All models</strong> and measure one on your own pages, or connect ' +
        'another provider.</span>' +
        '</div>';
    }
    return '<div class="build-current build-current-none" role="status">' +
      '<span class="build-current-head">Nothing builds your wiki yet.</span>' +
      '<span class="build-current-why">Connect a provider above. The Curator will start on the ' +
      'cheapest model it has measured for that provider, and you can change it here at any time.' +
      '</span>' +
      '</div>';
  }

  const name = providerLabel(b.provider) || b.provider;
  // ── "measured for the build lane", NOT "measured by The Curator" (v3.67.0) ──
  // The chip on THIS card is the claim about the model every AI job runs on,
  // and the evidence behind it is one job's: the ingest planning prompt, nine
  // runs per model. Compile, Wiki health, Shared Brain and the reading plan
  // inherit that lane measurement — the same kind of structured-output task,
  // never measured one by one — so the honest words are "for the build lane".
  // Only the curator arm is re-worded, and only here: the per-row chips in the
  // list below keep MEASUREMENT_CHIPS verbatim, and "measured on your wiki" /
  // "not measured" are already exact claims.
  const chipBase = measurementChip({ measuredBy: b.measuredBy }, null);
  const chip = chipBase.key === 'curator'
    ? { key: 'curator', label: 'measured for the build lane', cls: chipBase.cls,
        title: 'Measured on the ingest prompt, 9 runs; the other jobs are the same kind of ' +
          'structured-output task.' }
    : chipBase;
  const modelName = buildModelDisplayName(k, b);

  let why;
  if (b.source === 'env') {
    why = 'Set by <code class="mono">LLM_MODEL</code> in the environment this app was started from. ' +
      'That overrides anything chosen here, so a choice below will not take effect until it is unset.';
  } else if (b.source === 'selected' && b.honoured) {
    why = 'You chose this one, so app updates will not move you off it.';
  } else if (b.source === 'selected' || b.source === 'fallback') {
    // ── THE HEDGE IS SPLIT INTO ITS TWO REAL CAUSES ──────────────────────
    // It read "(it may no longer be offered, or may never have been measured
    // for this job)" — a parenthesis naming both possibilities because nothing
    // on the wire distinguished them. One of them IS distinguishable, and from
    // data already in hand: the pin is `selectedModels[provider]`, and the
    // catalogue for that provider is in the same payload. A pin PRESENT in the
    // catalogue but outside the build lane was refused for the lane; a pin
    // ABSENT from it is not on offer at all.
    //
    // DELIBERATELY NOT `build.liveMissing`. That field describes the model IN
    // FORCE — which on this branch is the FALLBACK, and is by definition still
    // offered. Attributing the running model's verdict to the refused pin would
    // be the wrong-subject error this file records twice; the banner above the
    // block is where `liveMissing` belongs, because that one IS about the model
    // in force. Where the pin cannot be resolved at all, the ORIGINAL hedge is
    // kept verbatim rather than guessing.
    const pin = (k && k.selectedModels && typeof k.selectedModels[b.provider] === 'string')
      ? k.selectedModels[b.provider] : '';
    const pinList = (k && k.offerable && Array.isArray(k.offerable[b.provider]))
      ? k.offerable[b.provider] : null;
    const pinEntry = (pin && pinList)
      ? pinList.find((m) => m && typeof m === 'object' && m.id === pin) || null
      : null;
    let cause;
    if (pin && pinList && !pinEntry) {
      cause = escapeHtml(name) + ' no longer offers <code class="mono">' + escapeHtml(pin) +
        '</code>';
    } else if (pinEntry && !laneBuildsWiki(modelLaneOf(pinEntry, qualIndex(k)[pin] || null))) {
      cause = '<code class="mono">' + escapeHtml(pin) + '</code> has never been measured for ' +
        'building a wiki — it is offered for chat only';
    } else {
      cause = 'it may no longer be offered, or may never have been measured for this job';
    }
    why = 'You chose a model, and it is <strong>not the one running</strong> — The Curator refused it ' +
      'on read (' + cause + ') and fell back to the model named above. Choose again to fix it.';
  } else if (b.source === 'default') {
    why = 'Nobody has chosen one, so this follows the app default and can change when The Curator updates.';
  } else if (b.degraded) {
    // The oldest payload: a real model, resolved by the real chain, with no
    // provenance attached. Claim exactly that and nothing more.
    why = 'This is what ingest, Health scans and Compile run on.';
  } else {
    // An unrecognised `source`. Say nothing rather than pick one of the four —
    // a fabricated provenance on a spending surface is worse than a gap.
    why = '';
  }

  // The ONLY way back to "follow the app default". Picking the default model by
  // hand PINS it, which is a different state, so the control is offered only
  // when there is a pin to clear and never renders as a no-op.
  const clear = (b.source === 'selected')
    ? ' <button type="button" class="btn btn-secondary btn-xs model-pick-clear"' +
        ' data-pick-clear="' + escapeHtml(b.provider) + '"' + (pickDisabled ? ' disabled' : '') +
        '>Follow the app default</button>'
    : '';

  const inert = inertPins(k).map((pin) =>
    '<span class="build-current-inert">You also chose <code class="mono">' + escapeHtml(pin.model) +
    '</code> under <strong>' + escapeHtml(pin.name) + '</strong>. It governs nothing while ' +
    escapeHtml(name) + ' builds your wiki. Choosing it in the list below would switch to ' +
    escapeHtml(pin.name) + ' and make it take over.</span>').join('');

  const warn = ((b.source === 'selected' && !b.honoured) || b.source === 'fallback')
    ? ' build-current-warn' : '';

  // ── THE CHIP'S MEANING IS NO LONGER HOVER-ONLY ────────────────────────
  // The chip's explanation (`chip.title`) was a `title=` on a <span>. A span
  // is not focusable, so that string was unreachable by keyboard and did not
  // exist at all on touch — and it is the only place the badge's meaning is
  // stated on this block. It now sits behind a real focusable button.
  //
  // ONE instance, so ONE control: this is the single build-lane readout at the
  // top of the section. renderMeasurementChip renders the same chip once per
  // model row (up to ~192 of them on a synced OpenRouter catalogue) and is
  // deliberately NOT converted — 192 extra tab stops would be a worse defect
  // than the one being fixed.
  // v3.71.1: ONE static explainer whose table names all three badges, so the
  // panel reads true whichever badge is showing; the badge itself is the state.
  const chipInfo = explainerMark('settings-build-chip-info', 'settings.measured');

  // ── THREE FACT CHIPS, AND NO CONTEXT CHIP ──────────────────────────────
  // Price, the measured finding, and who measured it. CONTEXT IS DELIBERATELY
  // ABSENT: `contextLength` is null on every hand-typed static entry — i.e. on
  // every model that can actually be the build model today — so a context chip
  // would be blank or invented on exactly the rows that matter. It ships when
  // those entries carry the field, not before.
  // FREE IS RENDERED AS THE WORD, NEVER AS $0.00 AND NEVER AS A BLANK.
  // The route sends null prices for a free model — free has no per-token figure
  // to quote — so `formatModelPrice` correctly returns '' and, before the `free`
  // flag existed, a free build model showed NO price chip at all: identical to a
  // model whose price nobody has published. Two different facts, one rendering.
  // `$0.00` is the other wrong answer: it states a per-token rate that does not
  // exist, and this repo has shipped that exact figure before (v3.3.1).
  const price = formatModelPrice(b.priceIn, b.priceOut);
  const priceChip = b.free ? 'free — this model bills nothing'
    : (price ? price + ' per 1M tokens' : '');
  // v3.72.1 (audit F3/F4): the same dated provenance and live-list warning
  // the rows carry, read off the build model's own offer entry.
  const bEntry = ((k && k.offerable && Array.isArray(k.offerable[b.provider])) ? k.offerable[b.provider] : [])
    .find((e) => e && e.id === b.model) || null;
  const bAsOf = priceAsOfText(bEntry);
  const bLive = livePriceText(bEntry);
  const facts =
    (priceChip ? '<span class="build-fact build-fact-num mono">' + escapeHtml(priceChip) + '</span>' : '') +
    (bAsOf ? '<span class="build-fact">' + escapeHtml(bAsOf) + '</span>' : '') +
    (bLive ? '<span class="build-fact model-price-live" role="note">' + escapeHtml(bLive) + '</span>' : '') +
    (b.outlineNote ? '<span class="build-fact">' + escapeHtml(b.outlineNote) + '</span>' : '') +
    '<span class="build-fact build-fact-measured">' + escapeHtml(chip.label) + '</span>';

  // ── CHEAPEST MEASURED — A FACT, NEVER A RECOMMENDATION ─────────────────
  // Server-derived, and that is not a detail: a client-side cross-provider
  // price comparator would be a second opinion about a money fact, and would
  // have to decide what `null` means for a free model. The words are "cheapest
  // measured", never "best" or "recommended", because only the first is
  // something we can show our working for.
  let cheapest = '';
  // ── THE SECOND LAYER, AND IT IS DELIBERATELY REDUNDANT ──────────────────
  // The route now EXCLUDES a `missing` candidate from `cheapestMeasured`
  // (pickCheapestMeasuredBuild's `isMissing`), so a payload from this build
  // cannot reach here naming a withdrawn model at all. This guard is for the
  // one that can: a server that predates the exclusion, which is precisely the
  // install most likely to be sitting on a retired id. The defect it closes is
  // not cosmetic — the screen carried a banner saying "minimax/minimax-m3:free
  // is no longer offered" directly above a sentence reading "that is MiniMax M3
  // (free) — the one you are already using", which is two contradictory
  // statements about one model in one block.
  //
  // It is scoped to the SAME-MODEL arm on purpose. A cheapest row that is a
  // DIFFERENT model carries its own chip and its own disabled control one list
  // down, and suppressing the offer as well would leave the user with a banner,
  // no recommendation and no route out.
  const cheapestIsGone = !!b.cheapest && b.liveMissing === true
    && b.cheapest.model === b.model && b.cheapest.provider === b.provider;
  if (b.cheapest && !cheapestIsGone) {
    const cName = buildModelDisplayName(k, b.cheapest) || b.cheapest.model;
    if (b.cheapest.same) {
      cheapest = '<div class="build-cheapest"><span class="build-cheapest-tag">Cheapest measured</span>' +
        '<span>For the keys you have connected, that is <strong>' + escapeHtml(cName) +
        '</strong> — the one you are already using.</span></div>';
    } else {
      // Same free/unpriced split as the chip above, on both halves of the
      // comparison: the row being offered, and the model being paid for now.
      const cPrice = b.cheapest.free ? 'free' : formatModelPrice(b.cheapest.priceIn, b.cheapest.priceOut);
      const cPriceLabel = b.cheapest.free ? 'free' : (cPrice ? cPrice + ' per 1M' : '');
      const vs = b.free ? ', against the free model you are running now'
        : (price ? ', against the ' + price + ' you are paying now' : '');
      cheapest = '<div class="build-cheapest"><span class="build-cheapest-tag">Cheapest measured</span>' +
        '<span>For the keys you have connected, that is <strong>' + escapeHtml(cName) + '</strong>' +
        (cPriceLabel ? ' — <span class="mono">' + escapeHtml(cPriceLabel) + '</span>' : '') +
        escapeHtml(vs) + '. ' +
        '<button type="button" class="btn btn-secondary btn-xs" data-build-model="' +
          escapeHtml(b.cheapest.model) + '" data-build-provider="' + escapeHtml(b.cheapest.provider) +
          '"' + (pickDisabled ? ' disabled' : '') + '>Use it</button></span></div>';
    }
  }

  // The popup, or — with nothing to switch to — the name as a statement.
  const head = o.popupHtml
    ? '<span class="build-current-popup">' + o.popupHtml + '</span>'
    : '<span class="build-current-name">' + escapeHtml(modelName) + '</span>';

  // ── THERE IS NO SEPARATE `Change…` BUTTON ──────────────────────────────
  // The list below is a `<details>` and its `<summary>` IS the Change
  // affordance. A button beside the popup plus a summary under it would be two
  // controls opening one disclosure, with the button owing an `aria-expanded`
  // the summary already provides natively — the shape v3.0.1-beta.18 records
  // as the reason interactive controls do not get nested here.
  return (
    '<div class="build-current' + warn + '" role="status">' +
      '<div class="build-current-top">' + head + '</div>' +
      '<span class="build-current-head">' +
        '<span class="build-current-provider">' + escapeHtml(name) + '</span>' +
        '<span class="build-current-model">' + escapeHtml(b.model) + '</span>' +
        chipInfo.btn +
      '</span>' +
      chipInfo.panel +
      '<div class="build-facts">' + facts + '</div>' +
      (why ? '<span class="build-current-why">' + why + clear + '</span>'
           : (clear ? '<span class="build-current-why">' + clear + '</span>' : '')) +
      inert +
      cheapest +
    '</div>'
  );
}

/**
 * The model's own NAME, looked up in the catalogue the payload already carries.
 *
 * A model id is not a name — `upstage/solar-pro4` is what a machine routes on
 * and `Solar Pro 4` is what a person recognises — and this block's whole
 * argument is that the name leads. Degrades to the id when the catalogue holds
 * no entry for it, which is the honest answer: showing a blank or a guessed
 * prettification of a vendor slug would be inventing a name.
 */
function buildModelDisplayName(k, b) {
  if (!b || typeof b.model !== 'string' || !b.model) return '';
  const list = (k && k.offerable && Array.isArray(k.offerable[b.provider])) ? k.offerable[b.provider] : [];
  for (const m of list) {
    if (m && typeof m === 'object' && m.id === b.model && typeof m.label === 'string' && m.label) {
      return m.label;
    }
  }
  return b.model;
}

/**
 * The choice: every build-lane model, across providers, cheapest-first within
 * each provider — behind a `Change…` disclosure.
 *
 * ── NO `cheapest` BADGE HERE, AND THAT IS A REFUSAL RATHER THAN AN OMISSION ─
 * The route ships each provider's catalogue cheapest-first, so "index 0 is the
 * cheapest" is true PER PROVIDER. Concatenated, three providers produce three
 * index-0 rows — three `cheapest` badges, at most one of which could be true, on
 * the one screen whose purpose is comparing spend. The block-level "cheapest
 * measured" line replaces all three with ONE server-computed claim.
 *
 * ── THE DISCLOSURE IS FORCED OPEN WHEN SOMETHING IS HAPPENING IN IT ────────
 * A refusal or an in-flight write belongs to a ROW, and a row inside a closed
 * `<details>` is not on screen. v3.9.x recorded that shape once already, as a
 * confirm panel rendered into a collapsed disclosure.
 */
function renderBuildList(cands, k, pickDisabled, crossBusy, busyId, errorAt, errorText) {
  if (cands.length === 0) {
    return '<p class="settings-job-empty">No connected provider currently offers a model that has been ' +
      'measured for building a wiki. Connect a provider above, or open <strong>All models</strong> ' +
      'and test one on your own pages.</p>';
  }

  const defaultId = (k && k.buildModel && typeof k.buildModel.model === 'string')
    ? k.buildModel.model : '';
  const activeProvider = (k && typeof k.activeProvider === 'string') ? k.activeProvider : '';

  const items = cands.map(({ p, m, index, lane, qual }) => renderModelOption(m, index, defaultId, {
    provider: p.id,
    providerName: p.name,
    providerDot: p.dot,
    // "in use" must mean THIS provider's model, not merely a matching id: two
    // providers could in principle offer the same id string, and badging both
    // would claim two models are building one wiki.
    isInUse: p.id === activeProvider && m.id === defaultId,
    // The build choice is made through the ATOMIC route, so a row here can
    // never leave a pin stranded under a provider that is not active.
    buildChoice: true,
    showCheapest: false,
    selectedId: '',
    busyId, pickDisabled, crossBusy,
    quals: qual ? Object.assign(Object.create(null), { [m.id]: qual }) : Object.create(null),
    qualify: state.qualify,
    minRuns: Number.isFinite(k && k.minRunsToQualify) ? k.minRunsToQualify : 9,
    lane,
    // The refusal for THIS row, or ''. Matched on provider AND model, for the
    // same reason `isInUse` is: two providers can offer the same id string,
    // and a refusal shown against the wrong provider's row is worse than one
    // shown nowhere — it names a model the user did not click.
    pickError: (errorText && errorAt === p.id + '::' + m.id) ? errorText : '',
    // Same source as the shelf's — `getDefaultModel(<provider>)` off the wire.
    // Per row, because this list mixes providers and a baseline from another
    // provider would compare two things that never run the same job.
    baseline: qualBaselineFor(k, p.id),
    // ── THE WITHDRAWN VERDICT, PASSED RATHER THAN LOOKED UP ───────────────
    // `renderModelOption` can resolve this itself from `state.keys`, and does
    // for the callers that render outside this list. It is passed HERE for the
    // same reason `lane` is passed here: this function already holds `k`, so
    // reading the module's mutable `state` back out of it would be a second
    // route to one fact — and this list is the one the suite drives with an
    // explicit payload rather than through a render cycle.
    liveMissing: modelLiveMissing(k, p.id, m.id),
  })).join('');

  // Forced open while a refusal or a write belongs to a row inside it.
  const forceOpen = !!errorText || (typeof busyId === 'string' && busyId !== '');
  const open = (state.buildListOpen === true || forceOpen) ? ' open' : '';

  return (
    '<details class="build-change" id="settings-build-list"' + open + ' data-build-list="1">' +
      '<summary class="build-change-summary">' +
        '<span class="build-change-title">Change\u2026 <span class="build-change-sub">every model that can build your wiki</span></span>' +
        '<span class="mono build-list-count">' + escapeHtml(String(cands.length)) +
          // v3.67.0: "for the build lane", the card chip's words — the list
          // is every model measured on the ingest prompt, which every AI job
          // inherits; "this job" stopped naming one thing when block 2
          // became "Your AI model".
          ' measured for the build lane</span>' +
      '</summary>' +
      '<ul class="model-list build-list">' + items + '</ul>' +
    '</details>'
  );
}

/**
 * ── BLOCK 3: CHAT ──────────────────────────────────────────────────────────
 *
 * A STATEMENT AND A POINTER. Never a second picker.
 *
 * The composer already owns this control, and it owns it for a reason: the
 * choice is per message, so it belongs beside the message. A duplicate here
 * would put two controls on one setting and immediately reopen the question this
 * whole restructure exists to close — "which of these two am I actually
 * setting?" — with the added trap that the Settings copy would be the stale one,
 * because chat's is sticky per browser and this screen has no idea which
 * conversation you are in.
 *
 * WHAT IT DOES ADD IS A READOUT, WHICH IS NOT A CONTROL. "Starts on" answers a
 * question the composer cannot: which model a NEW conversation opens on, before
 * anyone has picked anything. It carries no button, no `data-` write hook and no
 * listbox, and the suite asserts exactly that.
 */
function renderChatBlock(k) {
  const c = chatStartFacts(k);
  let body;
  if (c.count === 0) {
    body = '<div class="settings-empty-card">' +
      '<b>No models are available to chat yet.</b>' +
      '<span>Connect a provider above. Chat will then be able to use every model that key reaches.</span>' +
      '</div>';
  } else {
    const label = buildModelDisplayName(k, { provider: c.provider, model: c.model }) || c.model;
    const prov = providerLabel(c.provider) || c.provider;
    body =
      '<div class="chat-start-row">' +
        '<span class="chat-start-k">Starts on</span>' +
        '<span class="chat-start-v">' + escapeHtml(label) +
          (c.model ? '<small>' + escapeHtml((prov ? prov + ' · ' : '') + c.model) + '</small>' : '') +
        '</span>' +
        '<span class="chat-start-sp"></span>' +
        '<span class="chat-start-k">' + escapeHtml(String(c.count)) + ' models available</span>' +
      '</div>' +
      // Favourites are INERT here. The composer owns the star, and a star that
      // could be set in two places would be two writers on one localStorage
      // key — the shape this file already refuses for the chat model itself.
      '<p class="settings-block-footnote">Star a model in the composer and it appears at the top ' +
      'of that menu, above everything else you have connected.</p>';
  }

  // ONE CLAUSE, AND IT IS THE POINTER (v3.58.0). At 16 words this was a
  // capability statement joined to an instruction. The instruction is the half
  // a reader acts on — it says where the control is, and therefore why this
  // block has none — so it is what stays visible; "any model you have
  // connected" survives inside it rather than as a sentence of its own.
  const lede = 'Pick <strong>any</strong> model you have connected — per message, in the composer.';

  return settingsBlock(3, 'chat', 'Chat', lede, body, 'settings.chat');
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

/**
 * One connection row.
 *
 * ── THE STATUS IS TWO PLAIN WORDS, IN THE TEXT FACE ────────────────────────
 * It used to be one of three MONOSPACE words — `active` / `configured` /
 * `not set` — of which only one was about the credential at all. `active` was
 * about which provider builds the wiki, which is block 2's whole subject, and
 * putting it on the credential row is what made two screens' worth of state
 * look like one row's. `configured` and `not set` are the same fact in
 * developer vocabulary. So: **Connected** with a tick, or **Not connected**,
 * in the text face, because these are words a person reads and not literals a
 * machine emits.
 *
 * ── AND `Set active` IS OFF BY DEFAULT ON THIS PAGE ────────────────────────
 * Option B: the build lane moves in block 2 and nowhere else, so the page does
 * not offer a second control that changes what the user is billed for from a
 * row whose subject is a key. `opts.allowSetActive` defaults to TRUE — the
 * degraded case is real and has to stay reachable (a build block with nothing
 * to offer cannot move the lane, and `POST /api-keys/active` is then the only
 * path) — and `renderConnectBlock` passes `false`. Defaulting the other way
 * would make the escape hatch the thing you have to remember to ask for.
 */
function renderProviderRow(p, k, crossBusy, opts) {
  const rowOpts = opts || {};
  const allowSetActive = rowOpts.allowSetActive !== false;
  if (!p.available) {
    return (
      '<div class="provider-row provider-row-unavailable">' +
        '<span class="provider-dot" style="background:' + p.dot + '"></span>' +
        '<span class="provider-name-block">' +
          '<span class="provider-name">' + escapeHtml(p.name) + '</span>' +
          '<span class="provider-vendor">' + escapeHtml(p.vendor || p.name) + '</span>' +
        '</span>' +
        '<code class="provider-key-field mono provider-key-empty">not available</code>' +
        '<span class="mono provider-state provider-state-muted">not available in this build</span>' +
        // No `title=` on this button: it is `disabled` (so not focusable, so
        // the tooltip was mouse-only) and it said "Not available in this
        // build", which is the visible <span> on the line above, verbatim.
        '<button type="button" class="btn btn-secondary btn-xs" disabled>Replace</button>' +
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
  const isActive = k.activeProvider === p.id;
  const isReplacing = state.replacing === p.id;
  const isBusy = state.keysBusy === p.id;

  // ── CONNECTED / NOT CONNECTED — the pill, in plain words ───────────────
  // `providerConnected` reads the route's own boolean where it sends one and
  // degrades to the saved-key test, so this row cannot disagree with the rest
  // of the page about what a connection is. The TICK is reinforcement on top of
  // the word, never a replacement for it: a colour-blind or icon-blind reader
  // still has "Connected" spelled out, which is the same rule the retired
  // `active` icon followed.
  const connected = providerConnected(p, k);
  const stateText = connected ? 'Connected' : 'Not connected';
  const stateClass = connected ? 'provider-pill-on' : 'provider-pill-off';
  const stateIcon = connected ? '<span class="provider-state-icon" aria-hidden="true">' + icon('checkAlt', 11) + '</span>' : '';

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
  if (allowSetActive && hasKey && !isActive && !canBuild) {
    // The long form used to be a `title=` on this <span> — non-focusable, so
    // keyboard-invisible and absent entirely on touch, and it is the ONLY
    // place the reason is written. It is now behind a real button. The short
    // form stays visible, because the fact that the control is missing has to
    // be legible without any interaction at all.
    // v3.71.1: the ⓘ that used to follow this is CUT — its text was a state
    // and a refusal, which an explainer may not carry, and the visible short
    // form below already states the fact. (No app caller reaches this
    // branch: renderConnectBlock passes allowSetActive: false.)
    extraActions.push(
      '<span class="mono provider-state provider-state-muted">no models yet — cannot be active</span>'
    );
  }
  if (allowSetActive && hasKey && !isActive && canBuild) {
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
      '<code class="provider-key-field mono' + (hasKeyField ? '' : ' provider-key-empty') + '">' + escapeHtml(hasKeyField || 'No key') + '</code>' +
      '<span class="provider-pill ' + stateClass + '">' + stateIcon + stateText + '</span>' +
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
        '<button type="button" class="btn btn-' + (hasKeyField ? 'secondary' : 'primary') + ' btn-xs" data-replace="' + p.id + '"' + (isBusy ? ' disabled' : '') + '>' + (hasKeyField ? 'Replace key' : 'Add key') + '</button>' +
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
        // ── WHO THE KEY IS FOR, NOT WHICH MODEL IT DEFAULTS TO ────────────
        // This line used to carry `models[p.id]` — the provider's default
        // model id, in monospace. That is block 2's subject, stated there once
        // with its price and its provenance, and repeating a bare id here made
        // three rows look like three build lanes. What a CREDENTIAL row owes
        // the reader is whose credential it is, so the line is the vendor.
        // `p.vendor` falls back to the provider's own name rather than to the
        // model id: a missing label must not resurrect the thing being removed.
        '<span class="provider-vendor">' + escapeHtml(p.vendor || p.name) + '</span>' +
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
//
// ── `MODEL_SUITABILITY_BADGES` IS GONE, AND IT IS A DELETION, NOT A MOVE ───
// It held two labels and both have stopped being labels:
//
//   'chat-only' -> 'chat only — not for ingest'. True of 194 of ~199 rows once
//     the live catalogue landed. A flag on 97% of a list carries no
//     information — the finding v3.16.1 recorded about the caution flag, one
//     level up. What replaced it is STRUCTURAL: a model's absence from the
//     build list is the claim, and the shelf's lane heading states it once for
//     the group instead of ~194 times per screen.
//   'caution' -> 'caution'. It printed the WORD beside a line that already
//     opened with the REASON: `cautionReason` is the first clause of
//     `formatModelSummary`, unfolded, and `defineOfferableModel` REFUSES to
//     build a flagged entry without one. The badge was a label for text sitting
//     directly beneath it. The visual signal it bought is kept by styling that
//     line (`model-row-derived-warn`), which is strictly more information.
//
// The underlying `suitability` FIELD is untouched: it is enforced at two layers
// server-side, it is what `modelLaneOf` reads, and suites pin it. Only these
// two display strings are gone, and the const with them — a table nothing reads
// is the dead-data shape this file's own comments keep naming.

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

/** One model's price per 1M tokens, as billed RIGHT NOW, EXACT. Returns ''
 *  when either figure is missing, so a half-priced row renders no price at all
 *  rather than an authoritative-looking half-truth.
 *
 *  v3.72.1: through `formatPricePerM` (shared/model-row.js), the formatter
 *  Chat's model menu uses — never `formatUsdHonest`, which rounds to cents and
 *  is for AMOUNTS spent, not RATES. It printed GLM 5.3 Flash's $0.075 as
 *  "$0.08" and Granite's $0.017 as "$0.02" here while Chat printed them
 *  exactly: one price, two figures, one app. */
function formatModelPrice(input, output) {
  const inStr = formatPricePerM(input);
  const outStr = formatPricePerM(output);
  if (!inStr || !outStr) return '';
  return inStr + ' in · ' + outStr + ' out';
}

/**
 * ── WHEN A HAND-TYPED PRICE AND MEASUREMENT WERE TAKEN (v3.72.1, audit F4) ──
 *
 * "price checked 25 Sep 2026 · measured 26 Aug 2026", from the entry's own
 * `priceAsOf` / `measuredOn` (llm.js PRICE_VERIFIED_ON / MEASURED_ON). A
 * code-time snapshot rendered with no date reads as current forever; these
 * two dates are what make it a statement about a moment. '' for a fetched
 * entry, which carries neither — its price is as old as the catalogue sync,
 * which the Model lists row already dates.
 */
function priceAsOfText(m) {
  if (!m || typeof m !== 'object') return '';
  const parts = [];
  if (typeof m.priceAsOf === 'string' && m.priceAsOf && m.free !== true) {
    parts.push('price checked ' + formatIsoDay(m.priceAsOf));
  }
  if (typeof m.measuredOn === 'string' && m.measuredOn) {
    parts.push('measured ' + formatIsoDay(m.measuredOn));
  }
  return parts.join(' · ');
}

/**
 * ── THE PROVIDER'S LIVE LIST DISAGREES WITH THE CHECKED PRICE (audit F3) ───
 *
 * One sentence, or '' when there is nothing to say. `livePriceDiffers` is
 * three-valued and only `true` speaks: null means NOT COMPARED (no sync yet),
 * which must never render as "matches". A warning, so it renders on the row
 * itself, never behind a chevron (v3.16.1).
 *
 * The two directions are worded differently because llm.js prices them
 * differently: a HIGHER live figure is what estimates now use (never quote
 * below what the provider publishes); a LOWER one is shown but not used, since
 * a headline may not be the endpoint that answers — it enters the price only
 * from a bill.
 */
function livePriceText(m) {
  if (!m || m.livePriceDiffers !== true || !m.livePrice || typeof m.livePrice !== 'object') return '';
  const live = formatModelPrice(m.livePrice.input, m.livePrice.output);
  if (!live) return '';
  const who = providerLabel(m.provider) || 'The provider';
  const when = formatSyncedAt(m.livePrice.listedAt);
  const higher = (typeof m.standardInput === 'number' && m.livePrice.input > m.standardInput) ||
    (typeof m.standardOutput === 'number' && m.livePrice.output > m.standardOutput);
  return who + ' now lists ' + live + (when ? ' (synced ' + when + ')' : '') +
    (higher
      ? ' — above the checked price, so estimates use the higher of each.'
      : ' — below the checked price, which estimates keep until a bill confirms the lower one.');
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

  // ── THE CATALOGUE MUST NEVER BE SILENTLY PARTIAL ───────────────────────
  // The maintainer's report — "the models sometimes show and sometimes do not"
  // — had exactly one cause: this list can be ABSENT, STALE or FAILED, and none
  // of those said so where the consequence lands. `getOpenRouterCatalogueMeta`
  // now reports `loaded`, `stale`, `reason`, `count` and `maxAgeMs`, and the
  // freshness THRESHOLD stays server-side: re-deriving "older than a day" here
  // would be a second copy of a rule, and the client half is the one that rots.
  //
  // `loaded` is read rather than inferred from `count > 0`, because "the
  // catalogue is absent" and "it is present and holds nothing" are different
  // facts and a consumer that infers the first from a zero will misreport the
  // second the day it becomes reachable.
  const loadedCount = (meta && typeof meta.count === 'number' && Number.isFinite(meta.count))
    ? meta.count : null;
  const notLoaded = !!(meta && meta.loaded === false);
  const isStale = !!(meta && meta.stale === true && meta.reason === 'stale');

  let statusLine;
  if (notLoaded) {
    // The state that produced the complaint. Say what is missing, what is still
    // there, and what to do — never a bare silence that reads as "this provider
    // has nothing", which is a lie about capability.
    statusLine = '<strong>No model list has been fetched from ' + escapeHtml(p.name) + ' yet.</strong> ' +
      'Only the models The Curator has measured itself are listed. Refresh to fetch the rest — ' +
      'it is a free, public request and costs no tokens.';
  } else if (isStale && when) {
    statusLine = 'Last refreshed <strong>' + escapeHtml(when) + '</strong> — more than a day ago, so ' +
      'this list <strong>may be out of date</strong>. ' + escapeHtml(p.name) + ' adds and retires ' +
      'models most weeks. Refresh to be sure.' +
      (loadedCount !== null ? ' <span class="mono">' + escapeHtml(formatTokenCount(loadedCount) + ' loaded') + '</span>' : '');
  } else if (when) {
    statusLine = 'Last refreshed <strong>' + escapeHtml(when) + '</strong>.' +
      (loadedCount !== null ? ' <span class="mono">' + escapeHtml(formatTokenCount(loadedCount) + ' loaded') + '</span>' : '');
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
    // The `data-` hook is what makes this fold survive a re-render: render()'s
    // capture/restore pair keys on the composed data-attributes an element
    // already carries, and a <details> with none of them cannot be keyed. This
    // was the one live disclosure on the page with no hook at all.
    ? '<details class="catalogue-funnel" data-catalogue-funnel="' + escapeHtml(String(p && p.id ? p.id : '')) + '">' +
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
      '<span class="catalogue-sync-note">Fetched models arrive <strong>chat only</strong>. ' +
      'They have never been measured against The Curator’s ingest prompt, so they cannot build ' +
      'your wiki — ' + escapeHtml(p.name) + ' tells us what a model costs; only a real run can ' +
      'measure whether it does our job. <strong>Want one of them to build your wiki?</strong> Open its ' +
      'row below and check it on your own material first — that is the only way in, and it is ' +
      'yours to run.</span>' +
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

  // ── THIS PARAGRAPH NO LONGER MAKES THE LANE CLAIM ──────────────────────
  // It used to open "This model builds your wiki" / "This model does not build
  // your wiki", once per provider — and that repetition IS the framing being
  // removed. Every section looked equally in force; only the ACTIVE provider's
  // pin ever reached ingest; and the maintainer hit exactly that, pinning a
  // model under one provider with the other active and having to ask which one
  // his next ingest would use.
  //
  // The claim is now made ONCE, at the top of the screen, by renderBuildCurrent
  // — which has the payload to say more than this ever could: whether the model
  // is a pin or a default, whether `LLM_MODEL` is overriding both, and whether
  // a stored pin was refused on read. Here the section is a CATALOGUE, so the
  // paragraph says what the catalogue is, names which provider is active so the
  // relationship is still legible, and stops.
  //
  // The chain is unchanged and still worth stating, because it is why there is
  // only one claim to make: ingest, Health scans and Compile all call
  // `generateText` with NO override, so each resolves getProviderInfo() ->
  // getActiveProvider() -> defaultModelFor(provider) -> applyModelOverride(...).
  // The governing pair is (ACTIVE provider, that provider's pin) — and on
  // health-ai.js and compile.js an override is not merely unused, it is
  // INEXPRESSIBLE (their `generateText` calls are four- and five-argument; the
  // provider/model live in argument SIX). There is no second knob to look for.
  const lane = s.isActive
    ? 'Every model ' + self + ' offers, with what each one costs. ' + self + ' is the ' +
      '<strong>active provider</strong>, so ' + idCode + ' is what builds your wiki — chosen at the ' +
      'top of this screen, not here. Everything listed below is available in <strong>chat</strong>, ' +
      'which you pick per message in the composer.'
    : 'Every model ' + self + ' offers, with what each one costs. ' + other + ' is the ' +
      '<strong>active provider</strong> right now, so nothing here builds your wiki today — choosing ' +
      'one of these at the top of this screen would switch to ' + self + ' and make it take over. ' +
      'Everything listed below is available in <strong>chat</strong>, which you pick per message in ' +
      'the composer.';

  // ── WHAT MOVED OUT OF THIS PARAGRAPH, AND WHERE IT WENT ────────────────
  // The pinned-vs-default sentence and the "Follow the app default" button both
  // live in renderBuildCurrent now. They moved rather than disappeared, and the
  // move is the point: there is ONE build model, so there is one place to say
  // whether it is pinned and one control to un-pin it. Repeating either per
  // provider is what made three sections look equally live.
  //
  // `selectedId` and `pickDisabled` stay in the signature. They are what those
  // two surfaces were derived from, so a caller that stops passing them would
  // be a caller that has lost track of what it is rendering — and the shape is
  // pinned by assertions.

  return (
    '<p class="model-picker-scope">' + lane +
    ' Prices are per 1M tokens, as billed today.</p>'
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

  // The v3.0.13 saved-key gate, now through the one shared helper. It is
  // null-prototype for the reason that helper's docblock states: on a plain
  // literal `['constructor']` is truthy, so the gate would PASS for an
  // inherited name — the opposite of the fail-safe direction this docblock
  // promises. A further provider (a local runtime) adds ONE line there and one
  // entry to PROVIDER_ROWS; nothing else in this file needs to change.
  if (!providerHasSavedKey(p.id, k)) return '';

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
  const quals = qualIndex(k);
  const ctx = {
    provider: p.id, selectedId, busyId, pickDisabled, crossBusy: !!crossBusy,
    quals,
    qualify: state.qualify,
    minRuns: Number.isFinite(k && k.minRunsToQualify) ? k.minRunsToQualify : 9,
    // ── THIS LIST IS REFERENCE, NOT A CONTROL SURFACE ───────────────────
    // Every model is still shown, in both lanes, with search — so "I know I
    // want Kimi" still works, which is the reason the filter exists. What is
    // NOT here is the pick control: the ONE model that builds the wiki is
    // chosen once, at the top of the screen, through the atomic route that
    // names provider and model together. Two controls writing the same setting
    // through two endpoints — one of which can leave the choice inert — is the
    // confusion this restructure removes, not a convenience.
    //
    // UNCONDITIONAL, deliberately. It was briefly a parameter; that left the
    // old per-provider copy as a branch production could never reach, with
    // assertions still driving it — a guard that cannot fail, over dead code.
    readOnlyList: true,
    // Only the ACTIVE provider's section may badge a row `in use` — see
    // renderModelOption's isDefault. A non-active provider's default is what it
    // WOULD use, which is not the same claim and must not read like one.
    inUseId: (k.activeProvider === p.id) ? defaultId : '',
    // ── THE `cheapest` BADGE IS AN IDENTITY, NOT A POSITION ─────────────
    // It used to be `index === 0` of the list actually rendered — which is the
    // list AFTER `filterModels` and AFTER `orderModels`. So under *Most
    // expensive first* the DEAREST row was badged `cheapest`, and under any
    // search the cheapest SURVIVING row was badged as cheapest overall. A false
    // price claim on a spending surface, reachable the moment a synced
    // catalogue makes the filter bar appear (12 rows).
    //
    // Derived here from the UNFILTERED, UNSORTED delivered list, whose
    // cheapest-first ordering is established server-side in
    // `listOfferableModels` and asserted upstream — so the badge names one
    // specific model and keeps naming it wherever that row lands. Sorting by
    // price descending now puts the badge on the LAST row, which is the honest
    // answer; filtering the cheapest model out removes the badge entirely
    // rather than promoting the runner-up into a claim it cannot support.
    //
    // `renderBuildList` still passes `showCheapest: false` and passes no
    // cheapestId — that list is a CONCATENATION of per-provider lists, where no
    // single row is cheapest overall. Both guards are kept: one names the
    // model, the other names the list where no model qualifies.
    cheapestId: (Array.isArray(list) && list.length && list[0] && typeof list[0].id === 'string')
      ? list[0].id : '',
    // The id `getDefaultModel(<provider>)` resolved to, served as
    // `models[provider]`. renderQualification quotes its measured latency as a
    // scale marker beside the user's own result — see qualBaselineFor for
    // why this is looked up rather than typed into the sentence.
    baseline: qualBaselineFor(k, p.id),
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
  // On the shelf the marker states what THIS list is, because the lane claim
  // now belongs to the build block at the top of the screen and must be made in
  // exactly one place. Off the shelf it is unchanged.
  // The marker states which provider is ACTIVE — a fact about this row that is
  // still worth a glance — but no longer claims that this SECTION is where the
  // wiki's model is set, because it is not. That claim is made once, in the
  // build block, where it can also say why.
  const scopeBadge = isActive
    ? '<span class="model-picker-lane model-picker-lane-live">active provider</span>'
    : '<span class="model-picker-lane model-picker-lane-idle">chat</span>';

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
 * ── THE INDEX PASSED DOWN IS THE ORIGINAL ONE, AND IS NO LONGER LOAD-BEARING
 * It used to be: `renderModelOption` badged `index === 0` as the cheapest, so
 * re-numbering per group would have produced two "cheapest" markers, one of
 * them false. That badge is now decided by IDENTITY against `ctx.cheapestId`,
 * computed from the delivered list before any filter or sort — because
 * position-in-the-rendered-list was ALSO wrong under "Most expensive first",
 * which no amount of careful index-passing could fix. The original position is
 * still carried rather than renumbered, so nothing downstream that reads it
 * silently changes meaning; no badge depends on it.
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
    // ── THE THREE AXES BLOCK 4's TABLE ADDS ────────────────────────────────
    // Read here rather than in a second reader, so the per-provider bars and
    // the cross-provider table share one normaliser. The per-provider bars
    // never SET these, so they read their defaults and render byte-identically
    // — which is what keeps §22e's "exactly three controls" assertion true of
    // the bar it was written about.
    //
    // Each is validated against the values THIS file defines, never trusted
    // from state: `state.modelFilter` is a plain in-memory object, but a stored
    // value that no longer matches a facet id would otherwise filter every row
    // out and read as an empty catalogue.
    lane: (f && MODEL_LANE_FACETS.some(([id]) => id === f.lane)) ? f.lane : 'all',
    band: (f && MODEL_PRICE_BANDS.some(([id]) => id === f.band)) ? f.band : 'any',
    provider: (f && typeof f.provider === 'string'
      && PROVIDER_ROWS.some((p) => p.id === f.provider)) ? f.provider : '',
  };
}

/**
 * ── THE BAR: one obvious input, and everything else small ─────────────────
 *
 * Search is the primary control and gets the width. The sort is the shared
 * listbox and the measured filter a checkbox, both compact — six filter chips
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
 * sort key, and it stays one. Two more rows in the picker that already
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
// The sort control's options, in display order. A TABLE rather than four
// inline calls: the labels are read by the picker AND the keys are read by
// MODEL_SORT_UNRANKED_LABEL, and a list that exists once cannot fall out of
// step with itself.
const MODEL_SORT_OPTIONS = [
  ['cheapest', 'Cheapest first'],
  ['dearest', 'Most expensive first'],
  ['newest', 'Newest first'],
  ['largest-context', 'Largest context first'],
];

function renderModelFilterBar(provider, f, shown, total, unranked) {
  const pid = escapeHtml(String(provider));
  // ONE cfg object, rendered here and hydrated by wireGlobalListeners from
  // pendingListboxes — never described twice. The id is provider-scoped
  // because this bar is rendered once per provider and two controls sharing
  // an id would make aria-controls and aria-activedescendant ambiguous.
  const sortCfg = {
    id: 'model-filter-sort-' + String(provider),
    ariaLabel: 'Sort models',
    value: f.sort,
    triggerClass: 'model-filter-sort',
    minWidth: 200,
    options: MODEL_SORT_OPTIONS.map(([value, label]) => ({ value, label })),
    onChange: (value) => {
      setModelFilter(String(provider), { sort: value });
      render(myMountToken);
    },
  };
  pendingListboxes.push(sortCfg);
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
      // The shared listbox (shared/listbox.js). `.model-filter-sort` now
      // sizes the TRIGGER; the menu is a <body> child and takes its width
      // from the trigger's rect, so this row's flex sizing cannot squeeze
      // the open list the way it constrained the closed select.
      renderListboxHtml(sortCfg) +
      '<label class="model-filter-measured">' +
        '<input type="checkbox" class="cur-check cur-check-sm" data-model-filter-measured="' + pid + '"' +
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
      '<span class="model-badge model-measured model-measured-user">measured on your wiki</span>, ' +
      'with what you ran, on which wiki and when inside the row.';

  const buildHtml =
    head('model-lane-head-build', 'Can build your wiki', buildNote, build.length) +
    ul(build);

  // ── ONE SENTENCE FOR THE WHOLE GROUP, INSTEAD OF A BADGE ON EVERY ROW ──
  // This is where `chat only — not for ingest` used to be repeated ~194 times.
  // The lane heading states it once for the group; the per-row chip says only
  // WHO measured the model, which is the fact that differs between rows.
  const chatNote =
    'These cannot run ingest, Health scans or Compile. Some we measured and found unfit for that ' +
    'job; the rest nobody has measured against it at all, and are marked ' +
    '<span class="model-badge model-measured model-measured-none">not measured</span> — the provider ' +
    'tells us what they cost, not whether they can do the job. All of them stay fully usable in chat, ' +
    'which you pick per message in the composer.';

  const chatBody = head('model-lane-head-chat', 'Chat only', chatNote, chat.length) + ul(chat);

  // ── THE FOLD MUST SURVIVE A REPAINT, AND MUST OPEN FOR A MEASUREMENT ──
  // Two independent arms, exactly as renderModelOption's row `<details>` has:
  //
  //  · WHAT THE USER OPENED. render() replaces the section wholesale, so a
  //    native `<details open>` is discarded on every repaint — and this section
  //    repaints on a keystroke in the search box, on the sort, and on the
  //    cross-view write gate firing because an ingest started somewhere else.
  //  · THE ROW BEING MEASURED. Every "Test on my wiki" button lives in here
  //    (193 of them on a synced OpenRouter catalogue), and pressing one
  //    re-renders — so without this arm the confirm panel that press exists to
  //    produce renders inside a COLLAPSED disclosure and the press appears to
  //    do nothing. That is the v3.8.0 shape renderModelOption's own docblock
  //    describes, and it was still live one level up: the row was forced open
  //    inside a fold that had just snapped shut around it.
  //
  // The forced arm is not redundant with the recorded one. The recorded one is
  // dropped on every mount (freshState), so a qualification still in flight
  // when the user leaves and returns would otherwise come back invisible.
  const laneKey = String(ctx && ctx.provider != null ? ctx.provider : '');
  const qualifyingId = ctx && ctx.qualify ? ctx.qualify.modelId : null;
  const laneOpen = (state.modelLaneOpen && state.modelLaneOpen[laneKey] === true) ||
    (!!qualifyingId && chat.some((x) => x.m && x.m.id === qualifyingId));

  // No control anywhere in this <summary> — see renderModelPicker's own note
  // on the v3.0.1-beta.18 hazard. It is text and a disclosure marker only.
  const chatHtml = chat.length > CHAT_LANE_COLLAPSE_AT
    ? '<details class="model-lane-fold" data-model-lane="' + escapeHtml(laneKey) + '"' +
        (laneOpen ? ' open' : '') + '>' +
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
 *  · THE BASELINE IS LOOKED UP BY MODEL ID, and vanishes rather than going
 *    stale. See qualBaselineFor below.
 */
/**
 * The scale marker the qualification panel prints beside the user's own
 * result: one model's MEASURED median seconds per outline call, and whether
 * that model is the one building the wiki right now. Null when there is
 * nothing measured to quote.
 *
 * ── v3.72.1: ONE SOURCE, AND THE RIGHT MODEL (truth audit F1, F2) ─────────
 * This panel read a second, hand-kept table (`MEASURED_CALL_SECONDS`: solar-pro4
 * 53, glm-5.3-flash 289, glm-4.7 38, …) — MEANS, while the row summary one line
 * away read `medianLatencyMs` from llm.js's MEASURED_LATENCY_MS (48, 188, and
 * glm-4.7 deliberately absent because its runs were fast FAILURES). One
 * measurement, two statistics, two numbers for the same model on one screen.
 * The table is gone; the figure is the offer entry's own `medianLatencyMs`,
 * already on the wire, and it is labelled "median".
 *
 * And it named OpenRouter's per-provider default (`models.openrouter`) as the
 * model "which builds your wiki today" — true only when OpenRouter is the
 * build provider. `buildsNow` compares against `build` (what ingest, Health and
 * Compile actually resolve), and the clause is only printed when it is true.
 */
function qualBaselineFor(k, providerId) {
  if (!k || typeof providerId !== 'string') return null;
  const id = (k.models && typeof k.models[providerId] === 'string') ? k.models[providerId] : '';
  if (!id) return null;
  const list = (k.offerable && Array.isArray(k.offerable[providerId])) ? k.offerable[providerId] : [];
  const entry = list.find((m) => m && m.id === id) || null;
  const ms = entry && Number.isFinite(entry.medianLatencyMs) && entry.medianLatencyMs > 0
    ? entry.medianLatencyMs : null;
  if (ms === null) return null;
  const b = k.build && typeof k.build === 'object' ? k.build : null;
  return {
    id,
    providerName: providerLabel(providerId) || providerId,
    medianMs: ms,
    buildsNow: !!(b && b.provider === providerId && b.model === id),
    measuredOn: entry && typeof entry.measuredOn === 'string' ? entry.measuredOn : '',
  };
}
function renderQualification(qual, minRuns, baseline) {
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
    // ── THE BASELINE IS LOOKED UP, NOT TYPED ──────────────────────────────
    // `baseline` comes from `qualBaselineFor` — the provider default's OWN
    // measured median off the offer entry, never a second table, and a
    // "builds your wiki today" clause only when the build model really is it.
    // No measured figure, no clause: no baseline is a smaller loss than a
    // confident wrong one. The user's figure is a MEAN of their runs and the
    // marker is a MEDIAN of ours, and both say so.
    const bl = (baseline && typeof baseline === 'object' && Number.isFinite(baseline.medianMs)) ? baseline : null;
    lines.push('mean ' + formatDuration(qual.latencyMs.mean) + ' per call' +
      (bl === null ? ''
        : ' (' + bl.id + (bl.buildsNow ? ', which builds your wiki today,' : ', ' + bl.providerName + '\'s default,') +
          ' took a median ' + formatDuration(bl.medianMs) + ' per call when measured' +
          (bl.measuredOn ? ' on ' + formatIsoDay(bl.measuredOn) : '') + ')'));
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
function renderQualifyPanel(q, minRuns, buildNow) {
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
      // The id is what revealInMain scrolls to. A confirm whose Start button is
      // off-screen is the same defect as an off-screen refusal, on a control
      // that can start a run measured in TENS OF MINUTES.
      '<div id="' + QUALIFY_CONFIRM_ID + '" class="model-qual model-qual-confirm">' +
        // ── THE BRIDGE, NAMED BY ITS OUTCOME ────────────────────────────
        // The old heading ("Measure this model against your wiki?") described
        // the mechanism. What the user is deciding is whether to let this model
        // build their wiki, and the answer is "not until somebody has watched
        // it try". Every honest fact below is unchanged and none is softened:
        // the real run count, the real prompt size, the measured duration
        // range, the cost, that it writes nothing, and — in renderQualification
        // — that a clean result is a screen and not a certificate.
        '<p class="model-qual-head">Want this model to build your wiki? Let’s check it on your own ' +
          'material first.</p>' +
        '<p class="model-qual-facts">It will run The Curator’s real ingest planning prompt ' +
          escapeHtml(String(e.runs || minRuns)) + ' times against your <code class="mono">' +
          escapeHtml(String(e.domain || '')) + '</code> wiki (' +
          // THOUSANDS-SEPARATED, through the same helper that renders
          // "230,400 max output" two lines up the same panel. It was the one
          // raw number on a screen whose other figures are all formatted, and
          // "78481" is measurably harder to size at a glance than "78,481".
          // formatTokenCount returns '' for a missing/NaN value, so the
          // fallback keeps the previous "0" exactly — the VALUE is untouched,
          // only its presentation.
          escapeHtml(formatTokenCount(e.promptChars) || '0') +
            ' characters per run, built from your own index and ' +
          'page list) and report exactly what came back. <strong>It writes nothing</strong> — no pages, ' +
          'no edits — and you can stop it at any point. If nothing goes wrong it joins the list of ' +
          'models that can build your wiki; a single clean run is not the same as the multi-document ' +
          'measurement behind the models we ship, and it is labelled differently.</p>' +
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
          // GHOST: Cancel is tier 3 everywhere else on this page (the key
          // replace row's Cancel is already btn-ghost btn-xs), and a Cancel
          // at the same weight as the rest of the row competes with Start.
          '<button type="button" class="btn btn-ghost btn-xs" id="qualify-cancel" data-qualify-cancel="1">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }
  if (q.phase === 'running') {
    // ── THE RUN IN FLIGHT, NOT THE RUNS COMPLETED ───────────────────────
    // THE MAINTAINER'S SCREENSHOT. This read `Run ${done} of ${total}` where
    // `done` is `q.runs.length` — the number of run frames that have ARRIVED.
    // Before the first one settles that is ZERO, so a probe whose slowest
    // measured call is 382 s displayed **"Run 0 of 9"** for up to six minutes,
    // on the one panel whose entire job is saying that something is happening.
    // The `start` frame has carried `{modelId, domain, runs, promptChars}`
    // since the feature shipped and the client discarded it.
    //
    // The run in flight is `done + 1`, clamped: on the last frame before the
    // stream closes `done` equals `total`, and "Run 10 of 9" would be a new
    // wrong number in place of the old one.
    const runs = q.runs || [];
    const done = runs.length;
    // The START frame's own count first: it is the number the SERVER is
    // actually running, and the estimate is what the user was quoted. They
    // agree today; if they ever disagree, the truth is what is running.
    const total = (Number.isFinite(q.total) && q.total > 0) ? q.total
      : ((q.estimate && q.estimate.runs) || minRuns);
    const inFlight = Math.min(done + 1, total);
    const last = done ? runs[done - 1] : null;
    const eta = last && Number.isFinite(last.etaMs) ? formatDuration(last.etaMs) : null;

    // ── AN ELAPSED CLOCK, BECAUSE THE FIRST RUN HAS NO ETA ──────────────
    // `etaMs` is a projection from runs that have happened, so before run 1
    // there is nothing to project from and the panel would otherwise carry no
    // number at all. v3.16.1 recorded the identical complaint about chat —
    // "we had measured its speed and never told him" — and the answer there
    // was the same: show the clock, and claim nothing about how long it will
    // take. No animation.
    const elapsed = Number.isFinite(q.startedAt)
      ? formatDuration(Date.now() - q.startedAt) : null;

    // The adapter's per-call ceiling, on the ONE line where it answers a
    // question the user is actually asking. It bounds the wait, which a
    // projection cannot do before the first run has landed. Rendered only when
    // the server sent it — an absent ceiling prints no clause rather than a
    // guessed one.
    const ceiling = Number.isFinite(q.callTimeoutMs) ? formatDuration(q.callTimeoutMs) : null;
    // ── THE SAME SENTENCE, IN THREE PIECES ──────────────────────────────
    // The words a user reads are BYTE-IDENTICAL to the single string this used
    // to build (`head`, below, is still it, and is still what goes into the
    // element's text). It is split so the one part that changes every second —
    // the elapsed clock — can be written on its own by the 1 s tick in
    // onQualifyGo, with `textContent`, instead of that tick calling `render()`
    // and repainting the entire section once a second. v3.53.1 recorded what a
    // 1 s full re-render costs on this very page (folds and disclosures
    // closing under the user mid-run); v3.54.0 wrote the rule down: a clock
    // writes textContent to a targeted node and never calls render().
    //
    // `data-qualify-clock="elapsed"` IS BOTH THE ADDRESS AND THE PERMISSION,
    // and it is an attribute rather than an id for two reasons. It is what the
    // tick looks the node up BY, so there is no second name to keep in step
    // (and no new module-level identifier entering the sandboxes several
    // suites build by extraction — the FUNCTION-LOCAL rule this file states at
    // `laneChip` and `QUALIFY_ABORT_REASONS`). And once a run has landed the
    // middle clause becomes the ETA — a projection from measured runs, not a
    // clock — so a tick that overwrote it would replace a better number with a
    // worse one every second; the attribute is emitted ONLY when the clause is
    // the clock, so the tick cannot reach the ETA at all.
    const elapsedClause = elapsed ? ' ' + elapsed + ' so far' : '';
    const midIsClock = (done === 0 || !eta);
    const headPre = done === 0
      ? 'Run 1 of ' + total + ' — waiting for the model…'
      : 'Run ' + inFlight + ' of ' + total + '…';
    const headMid = midIsClock ? elapsedClause : ' about ' + eta + ' left';
    const headPost = (done === 0 && ceiling) ? ' (it gives up after ' + ceiling + ')' : '';
    // NO SPAN AT ALL ON THE ETA ARM, rather than a bare one. A `<span>` with
    // no attribute would be an element that exists for nothing, and the two
    // arms' output is then BYTE-IDENTICAL to what this function produced
    // before the split — verified by executing both versions over a 32-render
    // fixture matrix: 18 renders identical, and the 14 that differ are the
    // clock arm, differing only by this element, with identical text.
    const headHtml = escapeHtml(headPre) +
      (midIsClock
        ? '<span data-qualify-clock="elapsed">' + escapeHtml(headMid) + '</span>'
        : escapeHtml(headMid)) +
      escapeHtml(headPost);

    // ── A FAILED RUN NAMES WHAT THE PROVIDER SAID ───────────────────────
    // `errorMessage` is on the run record and was not on the frame, so the
    // panel could say a run had FAILED and never what it failed with — a
    // wrong key, a 402, a model the router has withdrawn all read identically.
    // Rendered for the most recent failure only: a rate limit produces a run
    // of them and nine copies of one sentence is the wall this release is
    // removing elsewhere.
    const failed = runs.filter((r) => r && typeof r.errorMessage === 'string' && r.errorMessage);
    const lastFail = failed.length ? failed[failed.length - 1] : null;
    const failHtml = lastFail
      ? '<p class="model-qual-fail">Run ' + escapeHtml(String(lastFail.run)) + ' of ' +
          escapeHtml(String(lastFail.of || total)) + ' failed: ' +
          escapeHtml(lastFail.errorMessage) +
          (failed.length > 1 ? ' (' + escapeHtml(String(failed.length)) + ' runs have failed)' : '') +
        '</p>' +
        '<p class="model-qual-fail-act">' +
          '<button type="button" class="btn btn-secondary btn-xs" data-qualify-pick-another="1">' +
          'Pick a different model</button></p>'
      : '';

    return (
      '<div class="model-qual model-qual-running">' +
        // `headHtml` is the sentence this used to build as one escaped string,
        // with one <span> put around the clock clause. Its TEXT is unchanged
        // character for character, and every interpolated value still goes
        // through escapeHtml — the three pieces are concatenated as markup,
        // never interpolated into an attribute.
        '<p class="model-qual-head">' + headHtml + '</p>' +
        failHtml +
        '<p class="mono model-qual-facts">' +
          escapeHtml(runs.map(r =>
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
  // ── THE RUN FINISHED, AND THE PANEL SAYS SO ───────────────────────────────
  // THE MAINTAINER'S SECOND REPORT. Nine runs ended and nothing said they had:
  // `state.qualify` was set to null on the `stored` frame, the panel vanished,
  // and the only evidence was a lane cell changing to "Use for building"
  // somewhere in a 200-row table. The screen now states the outcome where the
  // user has been watching, and — when the model passed — carries the lane
  // control itself, so the next act is one click away instead of a search.
  //
  // THE EXISTING SUMMARY IS NOT REPLACED. `renderQualification` renders the
  // stored record's counts, pages, latency and cost immediately above this
  // panel (the `stored` frame is followed by a `loadKeys`, which brings the
  // record back in `qualifications`). This adds the VERDICT and the action; it
  // does not restate the evidence.
  if (q.phase === 'done') {
    // ── WHAT THE FINISHED RUN MEANS, AS FACTS ───────────────────────────
    // FUNCTION-LOCAL for the reason `QUALIFY_ABORT_REASONS` below is: no new
    // module-level identifier enters the sandboxes several suites build by
    // extraction, where a missing binding is a CRASH rather than a failing
    // assertion (the v3.11.0 FN_NAMES shape). It is fully drivable through this
    // renderer, which every one of those manifests already lists.
    //
    // `qualifies` COMES FROM THE SERVER AND IS NEVER RE-DERIVED. The route
    // recomputes it through `isLocallyQualified` — the same gate
    // `POST /api-keys/build-model` applies — so a second client-side rule would
    // be free to offer a button the pin route then refuses. The counts decide
    // only how a FAILURE is worded, never whether it is one.
    const d = (() => {
      const num = (v) => (Number.isFinite(v) ? v : 0);
      const rec = (q.record && typeof q.record === 'object') ? q.record : {};
      const counts = (rec.counts && typeof rec.counts === 'object') ? rec.counts : {};
      const frames = Array.isArray(q.runs) ? q.runs : [];
      const floor = Number.isFinite(minRuns) ? minRuns : 9;

      const completed = Number.isFinite(rec.runsCompleted) ? rec.runsCompleted : frames.length;
      const total = (Number.isFinite(q.total) && q.total > 0)
        ? q.total
        : (Number.isFinite(rec.minRunsToQualify) ? rec.minRunsToQualify : floor);

      // A clean run is one of the two PARSE classes that produced a usable
      // plan. Anything else — unrepairable, parsed-but-unusable, a call that
      // never returned — is a run that did not do the job, which is what the
      // headline counts. Derived from the RECORD where it has counts, and from
      // the frames only when it does not: an older backend that sends a record
      // without `counts` must still produce a number, not a silent zero.
      const clean = num(counts.raw) + num(counts.repaired);
      const failed = Object.keys(counts).length
        ? Math.max(0, completed - clean)
        : frames.filter((r) => !(r && r.outcome === 'COMPLETED' && r.usable === true)).length;

      const qualifies = q.qualifies === true;
      // `provider` IS READ OFF THE RECORD, AND ITS ABSENCE WITHHOLDS THE
      // BUTTON. `POST /api-keys/build-model` names provider AND model together;
      // a guessed provider would pin a model under a key the user is not using.
      // Under-offering costs one click in block 2; a wrong pin moves the bill.
      const provider = (typeof rec.provider === 'string' && rec.provider) ? rec.provider : '';
      const modelId = (typeof q.modelId === 'string') ? q.modelId : '';

      let headline;
      let reason = '';
      if (qualifies) {
        headline = 'Done — no defect found in ' + completed +
          ' runs. This model can now build your wiki.';
      } else if (rec.outcome === 'NOT_MEASURED') {
        // NOT a failure of the model, and it must not be counted as one: a rate
        // limit is a fact about a shared upstream queue. The same distinction
        // llm.js and renderQualification both make in as many words.
        headline = 'Done — nothing was measured; it stays chat-only.';
        reason = 'The provider rate-limited the run, which says nothing about the model. ' +
          'Try again later.';
      } else if (failed > 0) {
        headline = 'Done — ' + failed + ' of ' + total + ' runs failed; it stays chat-only.';
        reason = num(counts.unrepairable)
          ? num(counts.unrepairable) + ' returned JSON that could not be repaired.'
          : num(counts.unusable)
            ? num(counts.unusable) + ' returned JSON with no usable page list.'
            : 'Those runs did not return a plan this app could use.';
      } else {
        // Clean, and still short of the bar — say WHICH, rather than letting a
        // clean result read as a refusal for an unstated reason.
        headline = 'Done — no defect found, but it stays chat-only.';
        reason = 'Only ' + completed + ' of the ' + total +
          ' runs needed before a model can build your wiki were completed.';
      }
      return { qualifies, completed, total, failed, headline, reason, provider, modelId };
    })();
    // The same control block 4's table renders, byte for byte in its two data
    // attributes — one route, `POST /api-keys/build-model`, which names
    // provider and model together and so cannot strand a pin under a provider
    // that is not active. Withheld when the record carried no provider (see
    // qualifyDoneFacts) and when this model is ALREADY what builds the wiki,
    // because a control whose only outcome is rewriting the value it has is
    // this file's named invitation-to-a-no-op.
    const alreadyBuilding = typeof buildNow === 'string' && buildNow !== '' && buildNow === d.modelId;
    const act = (d.qualifies && d.provider && d.modelId && !alreadyBuilding)
      // SECONDARY, not primary, and that is the taxonomy in shell.css being
      // applied rather than a preference: the block 4 table and the "Cheapest
      // measured" line render the byte-identical control as btn-secondary, so
      // one screen was painting the same action two different weights
      // depending on which surface you reached it from. This is also the
      // v3.53.1 known-and-unfixed "a freshly passed row offers the build
      // control twice" — the duplication is still there, but the two copies
      // no longer disagree about how important it is.
      ? '<button type="button" class="btn btn-secondary btn-xs"' +
          ' data-build-model="' + escapeHtml(d.modelId) + '"' +
          ' data-build-provider="' + escapeHtml(d.provider) + '">Use for building</button>'
      : (alreadyBuilding ? '<span class="model-pick-state">Building your wiki</span>' : '');
    return (
      '<div class="model-qual ' + (d.qualifies ? 'model-qual-clean' : 'model-qual-short') +
        '" id="qualify-done" role="status">' +
        '<p class="model-qual-head">' + escapeHtml(d.headline) + '</p>' +
        (d.reason ? '<p class="model-qual-caveat">' + escapeHtml(d.reason) + '</p>' : '') +
        '<div class="model-qual-actions">' + act +
          // Dismiss goes through the SAME handler Cancel on the confirm panel
          // uses — one way to clear `state.qualify`, so a second path cannot
          // leave the clock or the abort controller behind.
          '<button type="button" class="btn btn-ghost btn-xs" data-qualify-cancel="1">Close</button>' +
        '</div>' +
      '</div>'
    );
  }

  // ── STOPPED BY THE SERVER'S OWN CIRCUIT BREAKER ───────────────────────────
  // The `done` frame can carry an `aborted` class — the probe gave up after a
  // run of reasoning burn, of exhausted budgets, or of rate limits. Without
  // this arm the panel stayed on "Run N of 9…" until the `stored` frame
  // cleared it, which on the rate-limit class is a wait with no end in sight.
  //
  // WHAT IS CLAIMED IS EXACTLY WHAT THE CLASS SUPPORTS, and the three are NOT
  // the same claim. A rate limit is a fact about the QUEUE — free ids draw on a
  // shared upstream pool — and llm.js records in as many words that it is
  // neither a defect nor a pass, so that arm says the run was not recorded
  // against the model. The two burn classes ARE observations about the model
  // and ARE stored, so that arm does not pretend otherwise. The brief for this
  // change said "not recorded against the model" for all three; it is true of
  // one, and saying it of the other two would be a reassurance the record
  // contradicts.
  if (q.phase === 'stopped') {
    // FUNCTION-LOCAL and null-prototype, exactly like renderCatalogueSync's
    // SYNC_BY_PROVIDER and renderProviderRow's KEY_TEST_BY_PROVIDER, and for
    // the same three reasons: an unrecognised class fails safe (the fact with
    // no explanation), an inherited name like `constructor` cannot resolve
    // truthy, and NO NEW MODULE-LEVEL IDENTIFIER enters the sandboxes that
    // three suites build by extraction — where a missing binding is a CRASH
    // rather than a failing assertion (the v3.11.0 FN_NAMES shape).
    const QUALIFY_ABORT_REASONS = Object.assign(Object.create(null), {
      ABORTED_REASONING_BURN: 'the model spent its whole output budget on hidden reasoning, ' +
        'several runs in a row',
      ABORTED_BUDGET_EXHAUSTION: 'the model ran out of output budget several runs in a row',
      NOT_MEASURED_RATE_LIMITED: 'the provider rate-limited the run',
    });
    const why = QUALIFY_ABORT_REASONS[q.aborted] || null;
    const recorded = q.aborted === 'NOT_MEASURED_RATE_LIMITED'
      ? 'Nothing was recorded against the model — a rate limit is a fact about the queue, not about ' +
        'the model.'
      : 'What ran was recorded, and it is a finding about this model on your wiki.';
    return (
      '<div class="model-qual model-qual-short">' +
        '<p class="model-qual-head">' + escapeHtml('Stopped after run ' +
          String(Number.isFinite(q.stoppedAfter) ? q.stoppedAfter : (q.runs || []).length) +
          (why ? ': ' + why : '.')) + '</p>' +
        '<p class="model-qual-caveat">' + escapeHtml(recorded) + '</p>' +
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

  // "In use" defaults to a plain id match (every existing caller), but the
  // cross-provider build list overrides it: two providers can in principle
  // offer the same id string, and badging both would claim two models are
  // building one wiki.
  // ── "IN USE" MUST MEAN ONE MODEL ON THE WHOLE PAGE ────────────────────
  // MEASURED IN A BROWSER, not reasoned about: the first cut rendered FOUR
  // `in use` badges at once — one in the build list plus one per provider on
  // the shelf, because each section badged its OWN default. That was the old
  // per-section semantics and it was defensible while provider WAS the
  // structure. Beside a block stating that ONE model builds the wiki, four
  // claims of "in use" is the contradiction this screen exists to remove.
  //
  // Three ways to answer, in falling specificity, so a caller says exactly as
  // much as it knows:
  //   `isInUse`  a boolean the caller resolved per row — the build list, which
  //              must also compare PROVIDER (two providers could offer the same
  //              id string, and badging both would claim two models build one
  //              wiki).
  //   `inUseId`  the id genuinely in force, or '' for "nothing here is". The
  //              shelf passes '' for every non-active provider.
  //   neither    the original behaviour, byte-identical: badge the model this
  //              provider would use. Every direct-render caller keeps it.
  const isDefault = typeof c.isInUse === 'boolean'
    ? c.isInUse
    : (typeof c.inUseId === 'string'
        ? (!!c.inUseId && m.id === c.inUseId)
        : !!(defaultId && m.id === defaultId));

  // ── THE LANE, RESOLVED ONCE FOR THE WHOLE ROW ────────────────────────
  // Every claim below about what this model may be used FOR reads `lane`.
  // Nothing here re-tests `suitability` or `jsonRaw` for a lane purpose, and
  // nothing re-derives "is it locally qualified" — that is what let the badge,
  // the note and the control drift into contradicting each other. See
  // modelLaneOf.
  //
  // `c.lane` is an OPTIONAL pre-resolved value from a caller that has already
  // run the same predicate over the same record (the build list, which had to
  // partition on it to build itself). It is a reuse, not a second opinion: the
  // fallback below is the identical call, so passing it or omitting it produces
  // the same lane for the same inputs.
  const qual = qualificationFor(c, m);
  const lane = c.lane || modelLaneOf(m, qual);
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
  // The provider, as a LABEL on the row. Rendered only where the list mixes
  // providers (the build choice) — inside a per-provider section it would
  // repeat the section heading on every row.
  if (c.providerName) {
    badges.push('<span class="model-provider-chip">' +
      (c.providerDot ? '<span class="provider-dot" style="background:' + c.providerDot + '"></span>' : '') +
      escapeHtml(c.providerName) + '</span>');
  }
  if (isDefault) badges.push('<span class="model-badge model-badge-default">in use</span>');
  if (isSelected) badges.push('<span class="model-badge model-badge-chosen">your choice</span>');
  // ── BY IDENTITY, NEVER BY POSITION ─────────────────────────────────────
  // `c.cheapestId` is computed from the DELIVERED list, before any filter or
  // sort — see where it is set. The old `index === 0` test read the position in
  // the list being RENDERED, so "Most expensive first" badged the dearest row
  // as cheapest. `showCheapest: false` still suppresses it where no row in the
  // list can be cheapest overall (see renderBuildList: a concatenation of
  // per-provider lists cannot carry this badge honestly, and re-sorting to
  // recover it was refused).
  if (c.showCheapest !== false && c.cheapestId && m.id === c.cheapestId) {
    badges.push('<span class="model-badge model-badge-cheapest">cheapest</span>');
  }

  // ── THE ONE MEASUREMENT VOCABULARY ─────────────────────────────────────
  // Three states, one chip, from the wire's own `measuredBy`. It REPLACES
  // three separate badges that all said something about measurement in
  // different words — `chat only — not for ingest`, `never measured here` and
  // `you measured this on your wiki`.
  //
  // WHY `chat only — not for ingest` IS GONE ENTIRELY. It was true of 194 of
  // ~199 rows once the live catalogue landed: a flag on 97% of a list carries
  // no information, which is the finding v3.16.1 recorded about the caution
  // flag one level up. What replaces it is STRUCTURAL — a model's ABSENCE from
  // the build list above is the statement that it cannot build a wiki, and the
  // shelf's own lane heading says it once for the whole group instead of ~194
  // times. The underlying `suitability` field is UNTOUCHED: it is enforced at
  // two layers server-side and pinned by suites; only this label is dropped.
  badges.push(renderMeasurementChip(m, lane));

  // ── THE PROVIDER HAS WITHDRAWN IT ──────────────────────────────────────
  // Read per row off `liveMissingByModel`, the same producer that excludes a
  // withdrawn id from `cheapestMeasured` and that drives the banner above this
  // block — so a row cannot be offered here while the banner says it is gone,
  // which is exactly the contradiction this chip was added to close.
  //
  // `=== true` ONLY. A null verdict (nobody checked, the check failed, an older
  // backend) renders NOTHING: unknown must never read as gone. That is not a
  // style rule, it is the fail-safe direction on a spending surface.
  //
  // A chip, never a fold, and never folded into the measurement chip beside it:
  // "nobody measured this" and "the provider no longer lists this" are different
  // claims with different actions, and collapsing two facts into one marker is
  // the shape this file's own badge comments refuse three times over.
  const goneHere = c.liveMissing === true
    || (c.liveMissing === undefined && modelLiveMissing(state.keys, c.provider, m.id) === true);
  if (goneHere) badges.push(renderGoneChip(c.providerName || providerLabel(c.provider) || ''));

  // KEPT, and it is the one measured fact with no other home. `dominated`
  // means a SAME-PRICED sibling measured better on every axis we recorded
  // (claude-opus-4-5 against claude-opus-5) — a comparative claim that
  // `formatModelSummary` deliberately excludes, and that both this surface and
  // the composer render with this same word. Dropping it here would delete a
  // measured comparison from the one screen built for comparing, and would
  // make the two pickers disagree about one model.
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
  // A record that found a DEFECT is the single most valuable thing this feature
  // produces — `z-ai/glm-4.7` returned unrepairable JSON in 9 of 9 runs while
  // passing every structural filter the app has — so it is badged on the row
  // itself, not folded away behind the expand with the rest of the evidence.
  // It is NOT the same claim as the measurement chip: the chip says who looked,
  // this says what they found.
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
  // v3.72.1 (audit F3/F4): the live-list disagreement, on the row, and the
  // dates the price and the measurement were taken.
  const liveText = livePriceText(m);
  const liveHtml = liveText ? '<span class="model-price-live" role="note">' + escapeHtml(liveText) + '</span>' : '';
  const asOf = priceAsOfText(m);
  const asOfHtml = asOf ? '<span class="model-price-asof">' + escapeHtml(asOf) + '</span>' : '';

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
  // ── THE DONE PANEL IS NOT RENDERED HERE, AND THAT IS NOT AN OVERSIGHT ────
  // A model that PASSES its probe moves into the build lane, so the instant
  // `loadKeys` lands it appears in block 2's list as well — and this renderer
  // is block 2's row. Without the phase guard the completion notice, and the
  // "Use for building" button with it, would render TWICE on one page, in two
  // different blocks. It belongs to block 4's table, which is where the press
  // happened and where the user has been watching; that row is forced open
  // while `state.qualify` names its model, so it is on screen.
  const qualHtml = renderQualification(qual, c.minRuns, c.baseline) +
    ((c.qualify && c.qualify.modelId === m.id && c.qualify.phase !== 'done')
      ? renderQualifyPanel(c.qualify, c.minRuns) : '');

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
  //
  // THE WARNING TREATMENT REPLACES THE `caution` BADGE, and is strictly more
  // information than it was. That badge printed the WORD "caution" beside a
  // line that already began with the REASON — `cautionReason` is the first
  // clause of this summary, by construction, and `defineOfferableModel` refuses
  // to build a flagged entry without one. So the badge was a label for text
  // sitting unfolded directly beneath it. What a badge bought was the visual
  // signal that a row is flagged; that is kept by styling THIS line rather than
  // by adding a second element saying less. The rule v3.16.1 set — a warning
  // behind a click is not a warning — still holds: this line is in the
  // <summary>, never in the fold.
  const derived = formatModelSummary(m);
  const flagged = !!(typeof m.cautionReason === 'string' && m.cautionReason.trim());
  const derivedHtml = derived
    ? '<span class="model-row-line model-row-derived' + (flagged ? ' model-row-derived-warn' : '') +
      '">' + (flagged ? icon('alertTriangle', 12) : '') + escapeHtml(derived) + '</span>'
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
    '<span class="model-row-line model-row-cost">' + priceHtml + riseHtml + asOfHtml + '</span>' +
    liveHtml
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
  if (goneHere && !isSelected) {
    // ── NO CONTROL WHOSE ONLY OUTCOME IS A MODEL THAT CANNOT RUN ───────────
    // Ordered FIRST, ahead of every lane and pick arm below, because the
    // question it answers ("does this id still exist?") comes before any
    // question about what the id is good FOR. A model the provider has
    // withdrawn can still be lane-eligible, still measured, still cheapest —
    // every one of those facts is about a model that is gone.
    //
    // DISABLED RATHER THAN HIDDEN, and the reason rides on the control instead
    // of only in a tooltip: `POST /api-keys/build-model` deliberately WARNS and
    // never REFUSES on a `missing` verdict (docs/model-lifecycle.md, "Why there
    // is no automatic re-pin" — our list can be stale and a user who knows their
    // model works must not be locked out of their own picker). So this is the
    // screen's judgement, not the route's, and it must show its working: the
    // chip above states the fact and this states the consequence.
    //
    // `isSelected` is excluded above for the same reason the arm below it is:
    // the row the user has already pinned reports its state rather than offering
    // a write that would rewrite the value it has.
    control = '<span class="model-pick-state model-pick-state-gone">not available to pick</span>';
  } else if (isSelected) {
    // No button at all on the model already pinned. A control whose only
    // outcome is re-writing the value it already has invites a click that
    // does nothing, and — while a write is running — a click that is refused
    // for no reason the user can act on.
    control = '<span class="model-pick-state">Selected</span>';
  } else if (c.buildChoice === true && isDefault) {
    // Same rule one axis over, and it only arises on the cross-provider build
    // list: the row that is ALREADY building the wiki gets no button, because
    // the only thing clicking it could do is rewrite the value it has. The
    // build list deliberately passes no `selectedId` — "your choice" is
    // reported once, in the headline above, where the distinction between a
    // pin and a default can actually be explained — so without this arm the
    // in-use row would offer a guaranteed no-op.
    control = '<span class="model-pick-state">Building your wiki</span>';
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
    //
    // ── THE BRIDGE, LABELLED AS ONE ───────────────────────────────────────
    // This is the ONLY path from "nobody has measured this" into the list that
    // builds the wiki, and on the old screen it read as an obscure technical
    // action sitting beside a refusal. The refusal is still stated — it is the
    // reason the bridge exists — but the button now says what it is FOR rather
    // than what it does mechanically. Every honest fact about the run lives in
    // the confirm panel it opens (renderQualifyPanel): the real run count, the
    // real character size of the prompt, the measured duration range, that it
    // is cancellable, and that it writes nothing.
    // ── A TABLE LOOKUP, NEVER `c.provider === 'openrouter'` ───────────────
    // This site was the bare comparison the same file forbids twice by name.
    // It is not merely stylistic: a fourth provider with a fetchable, unmeasured
    // catalogue would silently get NO route into the build lane — every one of
    // its rows permanently stuck at "chat only" with no way for the user to
    // change that, and nothing on screen saying why. `.find()` over the table
    // means an unknown id resolves to `undefined` and the button is withheld,
    // which is the same fail-safe direction the bare test had.
    const provRow = PROVIDER_ROWS.find((r) => r.id === c.provider);
    const canMeasure = !!(provRow && provRow.canQualify === true)
      && lane === MODEL_LANES.CHAT_UNMEASURED;
    const measuring = !!(c.qualify && c.qualify.modelId === m.id);
    const measureBtn = canMeasure
      ? '<button type="button" class="btn btn-secondary btn-xs model-qualify-btn"' +
          ' data-qualify-model="' + idAttr + '"' +
          (measuring || c.pickDisabled ? ' disabled' : '') +
          ' title="' + escapeHtml('Run The Curator’s real ingest planning prompt against your own pages ' +
            'and report exactly what came back. It writes nothing and you can stop it at any point.') + '"' +
          '>' + escapeHtml(qual ? 'Test again on my wiki' : 'Test on my wiki') + '</button>'
      : '';
    control = '<span class="model-pick-state model-pick-state-chat"' +
      ' title="' + escapeHtml('Nobody has measured this model against The Curator’s ingest prompt, so it ' +
        'cannot be the model that builds your wiki. It is fully usable in chat, which you pick per ' +
        'message in the composer.') +
      '">chat only</span>' + measureBtn;
  } else if (c.readOnlyList === true) {
    // ── UNREACHABLE FROM THE SHIPPING PAGE, AND THE REASON MATTERS ────────
    //
    // READ THIS BEFORE "FIXING" ANYTHING HERE. The comment that used to sit in
    // this branch argued that a build-lane row on the per-provider shelf must
    // NOT carry a pick button, because the only one available to it wrote
    // through `POST /api-keys/model` — the OLDER, per-provider route, which
    // pins a model without activating its provider and so can leave a click
    // looking like it worked while governing nothing. That argument was about
    // a ROUTE, not about a control, and it was correct: with only that endpoint
    // in hand, a sentence pointing elsewhere really was better than a button.
    //
    // It is no longer the situation. `POST /api-keys/build-model` names
    // provider and model TOGETHER and applies both, and block 4's table already
    // carries it on every build-lane row (`data-build-model` +
    // `data-build-provider`). So the row the maintainer complained about —
    // "rows that can build must be choosable there" — is choosable, through a
    // route that cannot strand a pin.
    //
    // What is left is this branch, and it is now UNREACHABLE from the page:
    // `renderModelPicker` is the only caller that sets `readOnlyList`, and
    // `renderAllModelsBlock` no longer calls it. The correct next step is to
    // delete both, and that is NOT done here — see the release notes: doing so
    // reds ~126 assertion sites in scripts/test-next-model-picker.js, many of
    // which reach `renderModelOption`'s price, escaping and badge behaviour
    // THROUGH the picker, and deleting them carelessly would delete real
    // coverage of a renderer that still ships.
    //
    // THE ONE THING THIS COMMENT EXISTS TO PREVENT: do not read
    // `can build — choose above` as evidence that the per-provider list should
    // come back. It is the sentence that replaced a control, on a surface that
    // no longer exists, under a route that no longer has to be avoided.
    control = '<span class="model-pick-state model-pick-state-elsewhere"' +
      ' title="' + escapeHtml('This model can build your wiki. The choice is made once, at the top of ' +
        'this screen, so that it always applies — a per-provider pin can end up governing nothing.') +
      '">can build — choose above</span>';
  } else {
    const label = isPending ? 'Saving…' : 'Use this';
    const disabledAttr = (c.pickDisabled || isPending) ? ' disabled' : '';
    const titleAttr = (c.crossBusy && !isPending)
      ? ' title="' + escapeHtml(crossWriteTitle('changing the model mid-run would plan on one model and write on another, and would invalidate the prompt cache.')) + '"'
      : '';
    // ── TWO ROUTES, AND THE ATOMIC ONE IS THE ONLY WAY TO CHOOSE ──────────
    // `data-build-model` posts to /api-keys/build-model, which names PROVIDER
    // AND MODEL together and applies both — so a choice made here can never
    // land as a pin under a provider that is not active (the inert state
    // renderBuildCurrent has to report for the pins already on disk). It is
    // what the build list renders and it is the only pick control that ships.
    //
    // `data-pick-model` is the older per-provider route. It is retained for a
    // caller that passes no `buildChoice`, because `onPickModel` is still live:
    // it owns the CLEAR path ("Follow the app default"), which the build-model
    // route deliberately has no arm for — "clear the one build model" has no
    // meaning, since something must build the wiki. Keeping both shapes in one
    // function is what stops the two payloads drifting apart.
    control = c.buildChoice === true
      // The id is what focus comes back TO after a refusal. preserveMainScroll
      // restores focus by id and cannot help here — the FIRST render of this
      // pair disables the button ("Saving…"), so focus has already fallen to
      // <body> by the time the refusal arrives, and only an explicit focus on
      // the re-enabled control returns the keyboard user to where they were.
      ? '<button type="button" class="btn btn-secondary btn-xs model-pick-btn"' +
          ' id="' + escapeHtml(buildPickButtonId(c.provider, m.id)) + '"' +
          ' data-build-model="' + idAttr + '"' +
          ' data-build-provider="' + escapeHtml(String(c.provider === undefined || c.provider === null ? '' : c.provider)) + '"' +
          disabledAttr + titleAttr + '>' + escapeHtml(label) + '</button>'
      : '<button type="button" class="btn btn-secondary btn-xs model-pick-btn"' +
          ' data-pick-model="' + idAttr + '"' +
          ' data-pick-provider="' + escapeHtml(String(c.provider === undefined || c.provider === null ? '' : c.provider)) + '"' +
          disabledAttr + titleAttr + '>' + escapeHtml(label) + '</button>';
  }

  // ── THE REFUSAL, IN THE ROW THE USER CLICKED ───────────────────────────
  // Last child of the <li> and full-width (settings.css gives .model-option
  // `flex-wrap: wrap`), so it sits directly beneath the button that produced
  // it. That placement IS the fix: a message adjacent to the control cannot be
  // off-screen while the control is on screen, which is a structural guarantee
  // rather than a scroll that has to fire correctly. The scroll in
  // onPickBuildModel is the second layer, for a row at the very bottom edge.
  //
  // `role="alert"` is retained verbatim — the wording and the semantics were
  // never the defect; only the position was. This is the one place it renders
  // for a row-owned refusal (see renderBuildBlock), so it is announced once.
  const pickErrorHtml = (typeof c.pickError === 'string' && c.pickError)
    ? '<div id="' + BUILD_PICK_ERROR_ID +
      '" class="settings-inline-error model-pick-error model-pick-error-row" role="alert">' +
      escapeHtml(c.pickError) + '</div>'
    : '';

  // ── THE LANE, ON THE ROW ITSELF ──────────────────────────────────────────
  // The same marker block 4's table carries, from the same predicate
  // (`laneBuildsWiki(lane)`), so a row can never be marked in one list and not
  // the other. In block 2 EVERY row is a build candidate, which is why there is
  // a rule and an attribute here but no `builds` chip: a flag on 100% of a list
  // carries no information — v3.16.1's finding, which removed a badge that was
  // true of 194 of ~199 rows. What the rule buys in a list where all rows
  // qualify is the same thing it buys in the mixed table: the lane is legible
  // without reading across to the control.
  //
  // `data-build-current` marks the ONE row in force. It is deliberately a
  // separate attribute from `model-option-default`'s class, because that class
  // is the paint (a success border and tint) and this is the fact — a suite
  // asking "which row is building the wiki" should not have to read a colour.
  const laneAttr = buildsWiki ? ' data-lane="build"' : '';
  const currentAttr = (buildsWiki && isDefault) ? ' data-build-current="1"' : '';
  return (
    '<li class="model-option' + (isDefault ? ' model-option-default' : '') +
      (buildsWiki ? ' model-option-builds' : '') +
      (isSelected ? ' model-option-chosen' : '') +
      (pickErrorHtml ? ' model-option-refused' : '') +
      '" data-model-id="' + idAttr + '"' + laneAttr + currentAttr + '>' +
      '<div class="model-option-main">' + inner + '</div>' +
      '<div class="model-option-pick">' + control + '</div>' +
      pickErrorHtml +
    '</li>'
  );
}

// ── MCP bridge ────────────────────────────────────────────────────────────

/**
 * Pure derivation of the connection pill from GET /api/mcp/config's payload.
 * Split out of renderMcp() so it can be extracted and driven standalone by
 * scripts/test-next-ui-polish.js — same reasoning as PROVIDER_ROWS/
 * renderProviderRow living apart from the DOM-touching code around them.
 *
 * A corrupt claude_desktop_config.json is its OWN state, not "not
 * connected": src/routes/mcp.js computes installed/stale inside its
 * `!parseError` branch, so both come back false for a file it could not
 * parse — reporting that as "Not connected" would be asserting something we
 * do not know. The wizard's blocked panel is where this is explained and
 * where the whole-file payload is withheld; here it only has to stop
 * claiming a status it cannot have.
 */
function deriveMcpStatus(m) {
  const unreadable = m.claude_config_parse_error === true;
  const connected = !unreadable && m.installed === true && m.stale !== true;
  // THE TONE, NOT A CLASS LIST (v3.65.0). This returned
  // `'status-pill status-pill-ok'` — two class names that no longer resolve
  // anywhere in /next, because the pill and its card are a monitor now
  // (shared/monitor.js, M7). A pure derivation returning a dead selector is
  // the rot this file has a dozen comments about, so it derives the STATE
  // WORD'S TONE instead and the kit owns what that looks like.
  //
  // `quiet` for "Not connected" rather than `warn`: a bridge nobody has set
  // up yet is not a fault, and an amber gutter on a fresh install would be
  // the app reporting a problem it invented. `danger` is reserved for the one
  // case the app genuinely cannot read — a config file it could not parse.
  const pillTone = unreadable ? 'danger' : (connected ? 'ok' : 'quiet');
  // v3.72.1 (truth audit F13): 'Configured', not 'Connected'. `connected`
  // here means only that Claude Desktop's config file holds today's launch
  // line — not that any client has connected, and v3.64.0 measured a live
  // bridge serving old code under a "Connected" pill. The word states what
  // was checked; the tool map below states what agents actually called.
  const pillLabel = unreadable
    ? 'Config unreadable'
    : (connected ? 'Configured' : (m.installed ? 'Needs re-connect' : 'Not connected'));
  const wizardLabel = unreadable
    ? 'Fix the config file'
    : (connected ? 'Re-run setup' : (m.installed ? 'Re-connect' : 'Set up Claude Desktop'));
  return { unreadable, connected, pillTone, pillLabel, wizardLabel };
}

/**
 * THE BRIDGE THAT IS STILL RUNNING YESTERDAY'S CODE (v3.64.0).
 *
 * A third thing this screen can be wrong about, and until now the only one it
 * could not see at all. `installed`/`stale` are about the launch line SAVED in
 * a client's config; the self-test is about a bridge spawned FRESH, half a
 * second ago. Neither says anything about the long-lived child process the
 * client actually has open — and that process keeps running the code it was
 * started with until its client is restarted.
 *
 * Measured on the maintainer's Mac, 2026-09-20: a bridge alive since 2026-09-18
 * across five in-app updates, serving 22 tools (pre-v3.59.0 — no
 * `get_project_context`, no `save_foundation`) to Claude Desktop while the
 * files on disk were v3.63.0. The pill read Connected. The self-test passed.
 * Both were true, and the user's agent was still missing two tools.
 *
 * The app cannot fix it: the process's parent is the client, not The Curator,
 * so nothing here may signal it and nothing here does. The only honest move is
 * to name the fact and the remedy, and `src/routes/mcp.js` supplies the
 * remedy SENTENCE in the payload rather than this file authoring a second copy
 * of it — the same rule `agent-instructions.js` follows for text a model
 * reads, applied to text a user acts on.
 *
 * Returns null when there is nothing to say, which is every one of:
 *   - the route did not look (`checked: false`) — "we did not look" is NOT
 *     "there is none", and a note that conflated them would be the exact
 *     defect this reading exists to prevent;
 *   - it looked and every running bridge postdates the current code;
 *   - the payload predates this release and carries no such field.
 */
function deriveStaleBridgeNote(m, now = Date.now()) {
  const bp = m && m.bridge_processes;
  if (!bp || bp.checked !== true || !Array.isArray(bp.stale) || !bp.stale.length) return null;
  const n = bp.stale.length;
  const oldest = bp.stale[0];
  const secs = Number.isFinite(oldest && oldest.ageMs)
    ? Math.max(0, Math.round(oldest.ageMs / 1000))
    : ageSecondsOf(oldest && oldest.startedAt, now);
  const age = formatAge(secs);
  return {
    count: n,
    ageWords: age,
    text: (n === 1
      ? 'One bridge process is still running from before this version'
      : n + ' bridge processes are still running from before this version')
      + (age ? ' — the oldest started ' + age : '')
      + (n === 1
        ? '. It was launched by an MCP client and keeps serving the tools it started with, so an '
          + 'update to The Curator does not reach it.'
        : '. They were launched by MCP clients and keep serving the tools they started with, so an '
          + 'update to The Curator does not reach them.'),
    remedy: typeof m.bridge_stale_remedy === 'string' ? m.bridge_stale_remedy : null,
  };
}

/**
 * Defect 2 fix — the pill and the self-test result answer DIFFERENT
 * questions, and nothing on screen used to say so.
 *
 * `stale` (src/routes/mcp.js) is a strict equality check on the launch
 * command Claude Desktop actually has SAVED on disk, in its own config
 * file, against the command The Curator would generate today. It goes true
 * when the knowledge folder moved, when the app itself moved, or when the
 * Node binary path changed (an nvm/Homebrew upgrade) — none of which touch
 * anything the self-test spawns.
 *
 * The self-test (POST /api/mcp/self-test, see that handler's own comment)
 * never reads Claude Desktop's saved file at all. It always spawns
 * `buildCuratorEntry(getDomainsDir())` — the CORRECT, freshly computed
 * command — on purpose, so a self-test failure can never be "your saved
 * file happens to be wrong" (that was the pre-v3.6.1 bug: spawning a
 * path-less command gave a green pass against the wrong folder). That
 * means a self-test can be green — the bridge software genuinely works
 * with today's settings — while the pill is still "Needs re-connect" —
 * Claude Desktop is still launching the OLD command until the user re-runs
 * setup. Both are true; they are not in tension. Only the combination is
 * worth a note, so this returns false in the far more common case where
 * the two already agree (including: no self-test run yet, or the self-test
 * itself failed — that failure gets its own card and no note here would
 * add anything but noise).
 */
function shouldShowMcpStaleNote(status, m, selfTest) {
  return !status.unreadable && m.installed === true && m.stale === true &&
    !!selfTest && selfTest.ok === true;
}

/**
 * ── TWO NUMBERED BLOCKS, BECAUSE THEY REALLY ARE STEPS ─────────────────────
 *
 * The numerals are not decoration and they are not applied to every block in
 * this file (Health and Knowledge base below take none — see
 * `.settings-block-unnumbered` in views/settings.css). They are an ARGUMENT:
 * you connect a client, and THEN — once something is calling write tools —
 * the question of which domain an unqualified "my wiki" means can arise at
 * all. Reading ② before ① is reading the answer to a question you have not
 * asked yet.
 *
 * Everything here used to be a bare concatenation of a status card, a
 * paragraph, a button row and a `.settings-field-block` carrying
 * `style="margin-top:22px"` — a hand-picked number that existed because
 * nothing else on the screen supplied a rhythm. `settingsBlock` supplies one
 * (24 | hairline | 24, pinned by scripts/test-next-model-gone-ui.js), so the
 * inline style is DELETED rather than converted to a token.
 *
 * ── WHAT IS VISIBLE, AND WHAT IS NOT ───────────────────────────────────────
 * The visible lede names the three clients docs/mcp-user-guide.md names and
 * carries the guide link, because that is the sentence a newcomer needs in
 * order to know this is a standard rather than a Claude integration. The
 * ChatGPT exclusion, the transport, and the "the app need not be running"
 * fact are all TRUE and all still rendered — behind the ⓘ, because none of
 * them is needed in order to press the button underneath.
 *
 * The self-test result, the stale note and the inline error are NOT folded
 * and must never be: two of them are outcomes of something the user just
 * did, and the third is a warning. Explanations fold; findings do not.
 */
function renderMcp() {
  if (state.mcpError) {
    return '<div class="settings-inline-error">' + escapeHtml(state.mcpError) + '</div>';
  }
  if (!state.mcp) {
    return gatedLoader(loadGate, 'Loading MCP status…');
  }
  const m = state.mcp;
  const status = deriveMcpStatus(m);
  const { pillTone, pillLabel, wizardLabel } = status;

  const selfTestHtml = state.selfTest ? renderSelfTestResult() : '';
  const snippetHtml = state.configSnippetOpen && state.configSnippet
    ? '<pre class="mcp-config-snippet mono">' + escapeHtml(JSON.stringify(state.configSnippet, null, 2)) + '</pre>'
    : '';
  const staleNoteHtml = shouldShowMcpStaleNote(status, m, state.selfTest)
    ? '<div class="settings-mcp-stale-note" role="status">' +
        icon('alertTriangle', 15) +
        '<span>This confirms the bridge software itself works with your current ' +
        'settings — it does not check what Claude Desktop has saved. That saved ' +
        'copy is out of date (your knowledge folder, the app, or Node itself has ' +
        'moved since you last connected), so Claude Desktop is still launching the ' +
        'old one. Click <strong>' + escapeHtml(wizardLabel) + '</strong> above to ' +
        'update it — nothing else here needs fixing.</span>' +
      '</div>'
    : '';

  const domains = (state.defaultDomainInfo && state.defaultDomainInfo.domains) || [];
  const defaultDomain = state.defaultDomainInfo ? state.defaultDomainInfo.defaultDomain : null;
  // ONE cfg, rendered below and hydrated from pendingListboxes — never
  // described twice. The empty-string value is a real, selectable option
  // (not a placeholder): "no default" is a decision the user makes, and it
  // has to be reachable BACK to after setting one.
  const defaultDomainCfg = {
    id: 'select-default-domain',
    ariaLabel: 'Default domain for MCP writes',
    value: defaultDomain || '',
    disabled: !!state.defaultDomainSaving,
    triggerClass: 'settings-select mono',
    minWidth: 280,
    options: [{ value: '', label: '— none (require an explicit domain) —', typeahead: 'none' }]
      .concat(domains.map((d) => ({ value: d, label: d }))),
    onChange: (value) => onSaveDefaultDomain(value, myMountToken),
  };
  pendingListboxes.push(defaultDomainCfg);

  // ── ① CONNECT A CLIENT ───────────────────────────────────────────────────
  //
  // WHICH CLIENTS THIS ACTUALLY WORKS WITH (v3.49.0, re-cut here).
  // Reported by a power user: every string on this screen and in the wizard
  // said "Claude Desktop", so a newcomer could not tell whether the bridge is
  // a Claude integration or a standard they can point anything at. It is the
  // latter — a stdio JSON-RPC server, spawned as a local process — and the
  // honest limit is the TRANSPORT, not the vendor.
  //
  // THE THREE CLIENTS NAMED HERE ARE THE THREE docs/mcp-user-guide.md NAMES,
  // and no others: a settings screen is not the place to guess at another
  // company's roadmap. scripts/test-next-mcp-wizard.js §11 checks each name
  // against the real markdown, so this list cannot drift from what the docs
  // can back.
  //
  // THE LINK IS IN THE FOLD: block ①'s ⓘ is the `settings.mcp-connect`
  // explainer, whose guide card is the one docs link this block carries.
  //
  // "that runs" → "running" is the one word that got the sentence to 13. The
  // claim, the three client names and the ChatGPT exclusion in the fold are
  // untouched — scripts/test-next-mcp-wizard.js §11 checks each name against
  // docs/mcp-user-guide.md itself, so this list still cannot drift.
  const connectLede =
    'Works with any MCP client running local servers: Claude Desktop, Claude Code, Cursor.';

  // ── M7 + M8 — THE BRIDGE MONITOR ─────────────────────────────────
  //
  // This was a `.settings-status-card` holding a pill and one `<code>` line,
  // and views/sync.js held a near-byte copy of the same shape. It is a LIVE
  // READING — is a client connected, to which server, over which folder — so
  // it is a monitor (shared/monitor.js), and sync.js now makes the same call.
  // *"These cards show specific data, the data that is changing ... it's
  // really hard to understand that this is like a monitor into the specific
  // data and changing state."*
  //
  // THE TONE COMES FROM `deriveMcpStatus`, which is where the pill's whole
  // derivation already lived and is the reason that function is separable and
  // driven standalone by four suites. See its own comment for why "Not
  // connected" is `quiet` and not `warn`.
  //
  // M8 — THE STALE-BRIDGE NOTE IS A `loud` ENTRY INSIDE THIS MONITOR, not a
  // line and not a separate card underneath. It qualifies the state word
  // directly: "Connected" is true, and what is connected is running older
  // code. v3.16.1 is why it is `loud` — a warning is never collapsed in with
  // the readings — and `renderMonitor` builds `loud` from a different array
  // into a different container, so no later edit can demote it to a line.
  //
  // THE REMEDY SENTENCE STILL COMES FROM THE ROUTE, VERBATIM, and the view
  // still never authors a second copy: `deriveStaleBridgeNote` returns
  // `remedy: null` when the payload carries none. `strongText` is ESCAPED by
  // the component, because its one producer is a payload and a payload is
  // data. scripts/test-mcp-stale-bridge.js §7 holds all of that.
  const bridgeNote = deriveStaleBridgeNote(m);

  const connectBody =
    renderMonitor({
      id: 'mcp-bridge-monitor',
      label: 'MCP bridge connection',
      head: { stateWord: pillLabel, tone: pillTone },
      lines: [
        { key: 'client', value: 'Claude Desktop' },
        { key: 'server', value: m.mcp_server_name },
        { key: 'domains', value: m.domains_dir },
      ],
      loud: bridgeNote
        ? [{ tone: 'warn', text: bridgeNote.text, strongText: bridgeNote.remedy || '' }]
        : [],
    }) +
    // Body-level buttons, so md (32px): the SIZE is the container's decision,
    // per the taxonomy comment above `.btn` in shell.css. Exactly one primary
    // — the wizard is the single action that completes this block. Self-test
    // and View config are secondary (they inspect rather than complete), and
    // Copy is ghost: it neither completes nor inspects, it hands you a string.
    '<div class="settings-btn-row">' +
      '<button type="button" class="btn btn-primary" id="btn-mcp-wizard">' + escapeHtml(wizardLabel) + '</button>' +
      '<button type="button" class="btn btn-secondary" id="btn-mcp-self-test"' + (state.selfTestLoading ? ' disabled' : '') + '>' +
        (state.selfTestLoading ? 'Testing…' : 'Run self-test') +
      '</button>' +
      '<button type="button" class="btn btn-secondary" id="btn-mcp-view-config">' + (state.configSnippetOpen ? 'Hide config' : 'View config') + '</button>' +
      '<button type="button" class="btn btn-ghost" id="btn-mcp-copy-snippet">' + icon('copy', 13) + ' Copy snippet' + (state.copyFeedback ? ' — ' + escapeHtml(state.copyFeedback) : '') + '</button>' +
    '</div>' +
    selfTestHtml +
    staleNoteHtml +
    snippetHtml;

  // ── ② DEFAULT DOMAIN FOR MCP WRITES ──────────────────────────────────────
  // The listbox is the whole body. The paragraph that used to sit above it
  // stated the rule and then its inverse in the same breath; the rule is the
  // lede, and the inverse — which is the interesting half, because it is the
  // safer setting and nobody would guess why — is the fold.
  const domainLede = 'Used when a client says “my wiki” without naming a domain.';

  const domainBody =
    // The shared listbox (shared/listbox.js). No wrapper: the component draws
    // its own indicator INSIDE the trigger, so there is nothing left to
    // position a chevron against.
    renderListboxHtml(defaultDomainCfg) +
    (state.defaultDomainSaving ? '<span class="mono settings-saving-note">saving…</span>' : '') +
    // v3.72.1 (truth audit F11): a refused save says so, here, beside the
    // control — never through state.mcpError, which blanks the whole section.
    (state.defaultDomainError ? '<div class="settings-inline-error" role="alert">' + escapeHtml(state.defaultDomainError) + '</div>' : '') +
    // THE CONSEQUENCE IS ON THE PAGE (v3.71.1; it was only in the ⓘ): a
    // write aimed at the wrong domain is a real, quiet mistake.
    '<p class="settings-block-footnote">' + escapeHtml(MCP_DOMAIN_CONSEQUENCE) + '</p>';

  return (
    settingsBlock(1, 'mcp-connect', 'Connect a client', connectLede, connectBody, 'settings.mcp-connect', '') +
    settingsBlock(2, 'mcp-domain', 'Default domain for MCP writes', domainLede, domainBody, 'settings.mcp-domain', '') +
    // ── ③ THE TOOL MAP ─────────────────────────────────────────────────────
    // THIRD, AND NUMBERED, BECAUSE THE SEQUENCE IS STILL AN ARGUMENT: you
    // connect a client, you decide where an unqualified write lands, and only
    // THEN is there anything to observe. A map above either of those would be
    // an empty grid on every fresh install.
    renderToolMap()
  );
}

function renderSelfTestResult() {
  const r = state.selfTest;
  // ── M9 — THE OUTCOME OF A LIVE PROBE IS A MONITOR ────────────────────
  // This was three `.check-row`s in a `.settings-check-results` — the shape
  // System Check's own results use, and that surface KEEPS it: a checklist of
  // pass/fail rows is a different thing from a reading of one live probe. What
  // this block reports is a state that changes under you (did the bridge
  // answer, with how many tools, over how many domains), so it joins the one
  // instrument. `head.stateWord` is the outcome itself.
  if (!r.ok) {
    return renderMonitor({
      label: 'Bridge self-test',
      head: { stateWord: 'Self-test failed', tone: 'danger' },
      // THE SERVER'S OWN MESSAGE IS `loud`, NOT A LINE. It is the outcome of
      // something the user just pressed and the only thing on screen they can
      // act on; v3.16.1 keeps it unfolded and in its own tone.
      lines: [],
      loud: [{ tone: 'danger',
               text: r.error || 'The bridge did not respond as expected.' }],
    });
  }
  const names = (r.tool_names || []).slice(0, 6).join(', ') + ((r.tool_names || []).length > 6 ? ', …' : '');
  const domainsNote = Array.isArray(r.domains) ? r.domains.length + ' domain(s) visible' : 'no domains found yet';
  // WHAT A GREEN PASS DOES NOT COVER (v3.64.0). This spawned a NEW child a
  // moment ago; the tool count above is that child's. A bridge a client has
  // had open since before the last update is a different process running
  // different code, and saying "N tools" without qualifying it is how a user
  // concludes their agent must be able to see all N. The row is added only
  // when the route actually found one — never as a standing disclaimer.
  //
  // IT IS A `loud` ENTRY NOW, for the reason it was a `check-warn` row before:
  // it QUALIFIES the pass, so it must not be readable as one more reading.
  const bridge = state.mcp ? deriveStaleBridgeNote(state.mcp) : null;
  const bridgeLoud = bridge
    ? [{ tone: 'warn',
         text: '…but not the one already open. This spawned a fresh bridge. '
          + (bridge.count === 1
            ? 'A bridge your client already had open started before this version'
            : bridge.count + ' bridges your client already had open started before this version')
          + (bridge.ageWords ? ' (the oldest ' + bridge.ageWords + ')' : '')
          + (bridge.count === 1 ? ' and still offers' : ' and still offer')
          + ' the older tool list.' }]
    : [];
  return renderMonitor({
    label: 'Bridge self-test',
    head: { stateWord: 'Bridge responds', tone: 'ok' },
    lines: [
      { key: 'tools', value: String(r.tool_count), sub: names },
      { key: 'domains', value: domainsNote },
    ],
    loud: bridgeLoud,
  });
}


// ══ BLOCK ③ — THE TOOL MAP ═══════════════════════════════════════════════
//
// ── WHY A MAP AND NOT A LOG ───────────────────────────────────────────────
//
// The bridge is the app's most powerful surface and its least visible: 22-odd
// tools, all of them used from another window, and until now this screen said
// nothing whatever about them. A LOG — "get_node 12:04, search_wiki 12:04,
// save_working_state 12:41" — would answer a question nobody has. What a
// person actually wants to know is a SHAPE: did the session start by reading
// the project's context, did it save before it stopped, what has ever written
// anything, and which of these tools has this install never touched at all.
// So the surface is a map of the whole catalogue with a freshness reading on
// each tile, not a tail of the file.
//
// ── NEVER SAY "NEVER" ─────────────────────────────────────────────────────
//
// A tool with no line in the log has not "never been used". The log began at
// some point — it is rotated, and it did not exist before this release — so
// the only true statement is "not used since this log began", with the log's
// own age printed beside it so the reader can weigh it. This is the same rule
// working-state.js applies to an absent age: a fact and its ABSENCE must never
// share a presentation.

/** How often the map re-asks the server while the section is on screen. */
const USAGE_POLL_MS = 30000;

/**
 * The ONE element either repaint is allowed to replace.
 *
 * A const rather than the string written twice: two callers now paint this
 * body — the 30 s revalidate and the "Test all N tools" run — and a selector
 * typed in two places is a selector that can come to mean two elements.
 */
const TOOL_MAP_BODY_SEL = '.settings-block-mcp-tool-map .settings-block-body';
const ACROSS_PROJECTS_BODY_SEL = '.settings-block-mcp-across .settings-block-body';

/**
 * The revalidate timer's handle, in an OBJECT rather than in a bare `let`.
 *
 * Not defensiveness and not style: `scripts/test-next-mcp-tool-map.js` lifts
 * `scheduleUsagePoll`/`stopUsagePoll` out of this file and EXECUTES them
 * against a fake clock, and a function extracted on its own cannot carry a
 * module-level `let` with it. A one-field object can be injected by name, so
 * the assignments the suite is asserting about are the real ones.
 */
const usagePoll = { timer: null };

/**
 * What the map PAINTS, as one comparable string.
 *
 * Named fields rather than `JSON.stringify(data)`: the envelope carries
 * `logBytes`, which moves on every single call, and a byte count nothing on
 * screen displays must not be able to cost a repaint. The signature is
 * therefore exactly the fields a tile, the group counts and the session strip
 * read — change one of those and the block repaints; change anything else and
 * it does not.
 */
/** The two stamps block ④'s figures move with: the last save and the last
 *  session start. v3.72.1 (audit F9). */
function acrossProjectsStamp(data) {
  const s = data && data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
  return String(s.lastSaveAt || '') + '|' + String(s.lastBootstrapAt || '');
}

function usageSignature(data) {
  if (!data || typeof data !== 'object') return 'none';
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const s = data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
  return JSON.stringify([
    data.present === true,
    data.logStartedAt || null,
    s.lastBootstrapAt || null,
    s.lastSaveAt || null,
    tools.map((t) => [t && t.name, t && t.group, t && t.mutates === true,
      t && t.purpose, t && t.lastUsedAt, t && t.lastOk,
      t && t.count7d, t && t.countTotal, t && t.refusedTotal,
      // v3.66.0 — PAINTED (the busiest-tools monitor is drawn from it), so it
      // belongs here: a week of agent calls that moved only this must repaint.
      t && t.count7dAgent,
      // v3.61.0 — PAINTED (it is the tile's marker), so it belongs here: a
      // run that only changed whose reading a tile shows must still repaint.
      // `selfTestTotal` is deliberately NOT here: the envelope carries it and
      // nothing on this screen draws it, and a field nobody draws must not be
      // able to cost a repaint — the rule this projection exists for.
      t && t.lastVia]),
  ]);
}

/** Whole seconds between an ISO stamp and now, or null when it is not a date.
 *  Clamped at zero: a stamp from a machine whose clock is ahead is not a
 *  negative age, and `formatAge` refuses one anyway. */
function ageSecondsOf(iso, now) {
  const t = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

/**
 * The age of a stamp, as a dot and the words beside it, inside one element
 * carrying the tick hook.
 *
 * THE DOT AND THE WORD ARE CUT ON THE SAME BANDS, because both come from
 * shared/age.js — `freshnessTier` reads its boundaries off `formatAge`'s own
 * ladder. That is the whole reason this view does not own a threshold table.
 *
 * `data-mcp-age-at` is what `tickMcpAges` walks; `.mcp-age-words` is the one
 * element it writes into. The dot's CLASS is deliberately not re-derived by
 * the tick: a tier boundary is exactly where the payload signature moves
 * anyway on the next revalidate, and a clock that rewrote classes would be one
 * step away from being a render.
 *
 * `markerWord` (v3.61.0) puts a word INSIDE the reading, before the age and
 * separated by a "·" — "self-test · 2 min". Inside rather than beside it
 * because the word qualifies THIS reading and nothing else on the line, and
 * `.mcp-tool-meta` is a wrapping flex row whose items are separated by a gap:
 * a third sibling would read as a third fact. The clock still writes only
 * `.mcp-age-words`, so a tick cannot erase the marker.
 */
function ageMarkHtml(iso, now, extraClass, markerWord) {
  const secs = ageSecondsOf(iso, now);
  const words = secs === null ? null : formatAge(secs);
  const tier = secs === null ? 'unknown' : freshnessTier(secs);
  const marker = markerWord
    ? '<span class="mcp-via-mark">' + escapeHtml(markerWord) + '</span>' +
      '<span class="mcp-via-sep" aria-hidden="true">·</span>'
    : '';
  return (
    '<span class="mcp-age' + (extraClass ? ' ' + extraClass : '') + '"' +
      (words ? ' data-mcp-age-at="' + escapeHtml(iso) + '"' : '') + '>' +
      '<span class="fresh-dot fresh-' + tier + '" aria-hidden="true"></span>' +
      marker +
      '<span class="mcp-age-words">' + escapeHtml(words || 'unknown') + '</span>' +
    '</span>'
  );
}

/**
 * ONE TILE.
 *
 * The chip is on the MUTATORS ONLY, and that is the v3.53.1 rule rather than a
 * preference: a flag carried by 100% of a list carries nothing. Six or seven
 * of twenty-four is a minority, and it is the minority a reader deciding what
 * to let an agent do actually needs.
 *
 * A tile is NOT a button and takes no press family: there is nothing to press.
 * The map is a reading.
 */
function renderToolTile(t, logStartedAt, now) {
  const name = typeof t.name === 'string' ? t.name : '(unnamed)';
  const purpose = typeof t.purpose === 'string' ? t.purpose : '';
  const used = typeof t.lastUsedAt === 'string' && t.lastUsedAt;
  const uses = Number.isFinite(t.count7d) ? t.count7d : 0;
  const chip = t.mutates === true
    ? '<span class="mcp-writes-chip">writes</span>' : '';
  // NOT USED IS NOT NEVER USED. The log's own start age is printed beside the
  // phrase, because "not used since this log began" means nothing without it —
  // a log that began four minutes ago says nothing about a user's habits.
  // ── WHOSE READING THIS IS ───────────────────────────────────────────────
  // A tile lit by the user's own "Test all N tools" run must never be read as
  // agent use — that is the whole reason the log carries `via`. The marker is
  // on the READING, so it is impossible to see the age without it. Absent
  // `lastVia` means an MCP client and nothing more specific: no marker, rather
  // than a word like "agent" that the log cannot support.
  const viaWord = t.lastVia === 'self-test' ? 'self-test' : null;
  const meta = used
    ? ageMarkHtml(t.lastUsedAt, now, null, viaWord) +
      '<span class="mcp-tool-uses">' + escapeHtml(uses + (uses === 1 ? ' use' : ' uses') + ' · 7 days') + '</span>'
    // ── THE UNUSED READING IS ONE SENTENCE, AND IT WRAPS AS ONE ────────────
    // FOUND BY LOOKING at the rendered grid: with the phrase and the age as
    // two siblings the 220px column broke the line after the separator, so a
    // tile ended with a dangling "·" and opened the next line with a dot and a
    // date. Built here as the mark followed by ONE text run instead, with the
    // "· <age>" clause held together by `white-space: nowrap` — so the break,
    // when it comes, falls inside the sentence where a reader expects one.
    : '<span class="mcp-age mcp-age-unused"' +
        (logStartedAt ? ' data-mcp-age-at="' + escapeHtml(logStartedAt) + '"' : '') + '>' +
        '<span class="fresh-dot fresh-unknown" aria-hidden="true"></span>' +
        '<span class="mcp-tool-unused-words">not used since this log began' +
          '<span class="mcp-age-tail"> · <span class="mcp-age-words">' +
            escapeHtml(formatAge(ageSecondsOf(logStartedAt, now)) || 'unknown') +
          '</span></span>' +
        '</span>' +
      '</span>';
  return (
    '<div class="mcp-tool-tile' + (used ? '' : ' mcp-tool-unused') + '">' +
      '<div class="mcp-tool-hd">' +
        '<code class="mono mcp-tool-name">' + escapeHtml(name) + '</code>' + chip +
      '</div>' +
      (purpose ? '<p class="mcp-tool-purpose">' + escapeHtml(purpose) + '</p>' : '') +
      '<div class="mcp-tool-meta">' + meta + '</div>' +
    '</div>'
  );
}

/** One group — the caption names it and counts it, the tiles fill the row. */
function renderToolGroup(label, tools, logStartedAt, now) {
  if (!tools.length) return '';
  return (
    '<div class="mcp-tool-group">' +
      '<div class="mcp-group-eyebrow">' + escapeHtml(label + ' · ' + tools.length + ' tools') + '</div>' +
      '<div class="mcp-tool-grid">' +
        tools.map((t) => renderToolTile(t, logStartedAt, now)).join('') +
      '</div>' +
    '</div>'
  );
}

/**
 * M10 — THE TWO SESSION READINGS, AS ONE MONITOR.
 *
 * They are the map's headline and they are not a tile: "when did a session
 * last bootstrap" and "when did one last save" are the two questions the whole
 * tier exists to answer, and a reader should not have to find two particular
 * tiles among twenty-four to answer them.
 *
 * This was two `renderReadout`s in a flex strip — the app's THIRD treatment of
 * a live reading, beside the bridge's status card and the capture block on the
 * Context view. It is the same thing all three were: a reading of changing
 * state, which is a monitor (shared/monitor.js).
 *
 * ── THE AGE HOOK RIDES IN `markHtml`, AND THAT IS DELIBERATE ────────────
 * `tickMcpAges` re-words every age on this block once a second without a
 * render, by walking `[data-mcp-age-at]` and writing `textContent` into ONE
 * named child. A monitor LINE carries no data attribute of its own — the
 * component takes none, and giving it one would be inventing a hook in a
 * shared kit for a single caller. `markHtml` is its one TRUSTED field, so the
 * hook and the words it owns are composed HERE, by the view that owns the
 * clock, and `value` is left empty because the mark IS the reading. The
 * alternative was two one-line monitors (a hook per block) or dropping the
 * tick and living with the 30s revalidate; the first draws two instruments
 * where there is one reading, and the second silently loses a live clock.
 */
function renderSessionStrip(sessions, now) {
  const s = sessions && typeof sessions === 'object' ? sessions : {};
  const reading = (key, iso) => {
    const secs = ageSecondsOf(iso, now);
    const words = secs === null ? null : formatAge(secs);
    // NOT a blank and not "never": the same rule the tiles keep. An absent
    // reading takes no hook either, because there is no stamp to recount.
    if (!words) return { key, value: 'none since this log began' };
    return {
      key,
      value: '',
      markHtml: '<span class="mcp-session-reading" data-mcp-age-at="' + escapeHtml(iso) + '">' +
        '<span class="mcp-age-words">' + escapeHtml(words) + '</span></span>',
    };
  };
  return '<div class="mcp-session-strip">' + renderMonitor({
    label: 'Bridge sessions',
    lines: [
      reading('Last session start', s.lastBootstrapAt),
      reading('Last save', s.lastSaveAt),
    ],
  }) + '</div>';
}

/**
 * THE RUNNER — "Test all N tools", its one-line note, and its outcome.
 *
 * ── N IS READ, NEVER TYPED ─────────────────────────────────────────────────
 * From `state.mcpUsage.tools.length`, which IS the catalogue (the route maps
 * one row per `TOOL_CATALOGUE` entry, used or not). A literal here would be a
 * third list of the same tools, after `mcp/tools/index.js` and
 * `mcp/tools/catalogue.js` — and CLAUDE.md records twice that the number in
 * prose is the copy that goes stale.
 *
 * ── THE SENTENCE IS A `.tx-note`, NOT A SECOND LEDE ────────────────────────
 * The block already has its lede, and §3 of docs/design-system-source.md
 * allows a block one: a heading, at most one lede, the ⓘ, and the body. This
 * sentence qualifies the CONTROL directly, which is exactly what `.tx-note` is
 * for, and it is one line by that component's contract — 12 visible words,
 * under the 13-word ceiling a lede would have had to meet anyway.
 *
 * ── THE OUTCOME IS NEVER FOLDED ────────────────────────────────────────────
 * v3.16.1's never-fold list names "the outcome of something the user just
 * pressed" outright. It is a plain reading on the page: how many answered, how
 * many refused, how long it took — and, when something did not answer, the
 * tools BY NAME, because "23 of 24" without the name is a reading nobody can
 * act on.
 */
function renderExerciseRunner(toolCount) {
  const n = Number.isFinite(toolCount) && toolCount > 0 ? toolCount : null;
  if (!n) return '';
  const busy = state.mcpExerciseBusy === true;
  const label = busy ? 'Testing…' : 'Test all ' + n + ' tools';
  const control =
    '<div class="settings-btn-row mcp-runner-row">' +
      '<button type="button" class="btn btn-secondary" id="btn-mcp-exercise"' +
        (busy ? ' disabled' : '') + '>' + escapeHtml(label) + '</button>' +
    '</div>' +
    // 12 words: Runs / every / tool / against / a / throwaway / copy / nothing
    // / of / yours / is / touched.
    '<p class="tx-note mcp-runner-note">Runs every tool against a throwaway ' +
      'copy — nothing of yours is touched.</p>';
  return control + renderExerciseOutcome();
}

/** The outcome line. Empty until a run has happened on this page. */
function renderExerciseOutcome() {
  if (state.mcpExerciseError) {
    return '<div class="settings-inline-error mcp-runner-outcome">' +
      escapeHtml(state.mcpExerciseError) + '</div>';
  }
  const r = state.mcpExercise;
  if (!r || !Array.isArray(r.results)) return '';
  const total = r.results.length;
  const answered = r.results.filter((x) => x && (x.ok === true || x.refused === true)).length;
  const refused = r.results.filter((x) => x && x.refused === true).length;
  const secs = Number.isFinite(r.durationMs) ? (r.durationMs / 1000).toFixed(1) : '?';
  const failed = r.results.filter((x) => x && x.ok !== true && x.refused !== true)
    .map((x) => x.tool).filter((x) => typeof x === 'string');
  // The refusals are NAMED too, with their reason, when there are any: a
  // refusal is a legitimate answer from a tool and the reason is the useful
  // half. (`scan_semantic_duplicates` refuses its cost estimate on an install
  // with no provider key, which is a fact about the install, not a fault.)
  const refusedRows = r.results.filter((x) => x && x.refused === true);
  const headline = escapeHtml(answered + ' of ' + total + ' answered · ' +
    refused + ' refused · ' + secs + ' s');
  const parts = ['<div class="mcp-runner-line"><strong>' + headline + '</strong></div>'];
  if (failed.length) {
    parts.push('<div class="mcp-runner-line mcp-runner-bad">' +
      escapeHtml('No answer from: ' + failed.join(', ')) + '</div>');
  }
  for (const row of refusedRows) {
    parts.push('<div class="mcp-runner-line">' +
      '<code class="mono">' + escapeHtml(row.tool) + '</code> refused — ' +
      escapeHtml(row.note || 'no reason given') + '</div>');
  }
  const cls = failed.length ? ' mcp-runner-outcome-bad' : '';
  return '<div class="mcp-runner-outcome' + cls + '" role="status">' + parts.join('') + '</div>';
}

/**
 * The block's BODY, and it is its own function because the 30s revalidate
 * repaints exactly this and nothing else. A repaint that had to go through
 * `render()` would replace the whole column — closing every ⓘ, every
 * `<details>` and the user's focus — once every thirty seconds, which is the
 * v3.53.1 defect with a slower clock.
 *
 * THE RUNNER IS FIRST AND IT IS IN EVERY ARM that has a tool count, INCLUDING
 * the empty one: a fresh install's map is twenty-four dashed rings, and the
 * button is the only thing on the screen that can do anything about that.
 */
function renderToolMapBody(now) {
  const at = typeof now === 'number' ? now : Date.now();
  if (state.mcpUsageError && !state.mcpUsage) {
    return '<div class="settings-inline-error">' + escapeHtml(state.mcpUsageError) + '</div>';
  }
  const u = state.mcpUsage;
  if (!u) return gatedLoader(loadGate, 'Loading the tool map…');
  const tools = Array.isArray(u.tools) ? u.tools : [];
  const runner = renderExerciseRunner(tools.length);
  const anyUsed = tools.some((t) => typeof t.lastUsedAt === 'string' && t.lastUsedAt);
  if (!u.present || !anyUsed) {
    return runner + '<p class="mcp-map-empty">No calls recorded yet. The map fills as your ' +
      'agents use the bridge.</p>';
  }
  const reads = tools.filter((t) => t.group !== 'write');
  const writes = tools.filter((t) => t.group === 'write');

  // ── THE BUSIEST TOOLS THIS WEEK (v3.66.0, placement P7) ─────────────────
  // A monitor of the tools AGENTS called most in 7 days, each count with a
  // depth bar against the busiest one — a column of peers, the named
  // denominator (design rule 6). The tiles below stay as they are: a grid of
  // cards has no numeric column to anchor a bar to (v3.65.1's own refusal).
  //
  // `count7dAgent`, never `count7d`: the latter counts this page's own "Test
  // all N tools" run, one call on every tool, so a bar drawn from it would
  // show a tie across all twenty-four for a week after one press. A server
  // that does not send the field (older than v3.66.0) gets NO monitor — an
  // absent reading is not a column of zeros. Inlined rather than a helper:
  // suites lift this function into sandboxes, and a new free identifier in a
  // lifted body is a crash there.
  //
  // NEVER RED (max, not budget). Tools at 0 are omitted and counted in words.
  const agentCounted = tools.filter((t) => Number.isInteger(t && t.count7dAgent) && t.count7dAgent >= 0);
  let busiestHtml = '';
  if (tools.length && agentCounted.length === tools.length) {
    const called = agentCounted.filter((t) => t.count7dAgent > 0)
      .sort((a, b) => (b.count7dAgent - a.count7dAgent)
        || String(a.name).localeCompare(String(b.name)));
    const shown = called.slice(0, 8);
    const busiest = shown.length ? shown[0].count7dAgent : 0;
    const notCalled = tools.length - called.length;
    const moreCalled = called.length - shown.length;
    const noteParts = [];
    if (moreCalled > 0) noteParts.push(moreCalled + ' more ' + (moreCalled === 1 ? 'tool' : 'tools') + ' called less');
    if (notCalled > 0) noteParts.push(notCalled + ' ' + (notCalled === 1 ? 'tool' : 'tools') + ' not called by an agent this week');
    // Captioned like the READ / WRITE groups below it, because the caption
    // is what says whose calls these are: a tile's "18 uses · 7 days" counts
    // a test run, this column does not, and the two must not read as a
    // disagreement.
    busiestHtml = '<div class="mcp-busiest">' +
      '<div class="mcp-group-eyebrow">BUSIEST · 7 DAYS · AGENTS ONLY</div>' + renderMonitor({
      label: 'Busiest tools, last 7 days, agents only',
      lines: shown.map((t) => ({
        key: String(t.name),
        value: t.count7dAgent,
        depth: { amount: t.count7dAgent, max: busiest,
          label: t.count7dAgent === busiest
            ? t.count7dAgent + ' calls — the busiest tool this week'
            : t.count7dAgent + ' of ' + busiest + ' calls, the busiest tool this week' },
      })),
      note: shown.length
        ? (noteParts.length ? noteParts.join(' · ') + '.' : '')
        : 'No agent called a tool in the last 7 days. Test runs from this page are not counted.',
    }) + '</div>';
  }
  return (
    runner +
    renderSessionStrip(u.sessions, at) +
    busiestHtml +
    renderToolGroup('READ', reads, u.logStartedAt, at) +
    renderToolGroup('WRITE', writes, u.logStartedAt, at)
  );
}

/** Block ③ itself. */
function renderToolMap() {
  const lede = 'What your agents used, and when — kept on this machine only.';
  // ── THE FILENAME IS PLAIN TEXT, NOT A `<code>` ─────────────────────────
  // FOUND BY OPENING THE FOLD: `.tx-vh-panel` is a one-column GRID (its own
  // comment says WHY — `renderInfoMark` emits its prose as a BARE TEXT NODE,
  // and a grid is what can lay one out without a wrapper. The track itself
  // used to carry the MEASURE, which is what this line said; v3.65.0 made it
  // `minmax(0, 1fr)`, so the prose now takes the card and the card takes the
  // column — the grid stayed, the cap went), and CSS wraps each contiguous run
  // of text in an ANONYMOUS grid item. An inline element inside it therefore becomes a row of its own: the
  // filename sat on its own line and the sentence resumed underneath with a
  // leading comma. So the name is written as text, and the sentence is built
  // so nothing depends on it being set apart. The trailing link is the one
  // element here, and it is SUPPOSED to take its own row.
  // ── THE NUMBER AND THE FIELD LIST ARE A CONTRACT (corrected v3.63.0) ───
  // This sentence said "under 200 bytes" and named four fields. Both became
  // FALSE the moment the log grew `sid`, `project` and its session line: the
  // ceiling is MAX_LINE_BYTES in src/brain/mcp-usage.js and it is 300. The app
  // telling a user a number is a contract, so it moves when the number does.
  //
  // WRITTEN OUT RATHER THAN IMPORTED, and the reason is a real constraint, not
  // laziness: `src/brain/mcp-usage.js` imports `crypto`, `fs/promises` and
  // `./paths.js`, so it cannot be loaded in a browser — and `GET
  // /api/mcp/usage`, which is the only payload this block has, does not carry
  // the ceiling either (the capture route added for the memory view does, but
  // that route is per project and this block is app-wide). The literal is
  // therefore pinned against the module's own export by
  // scripts/test-next-capture-meter.js §5, which fails the day MAX_LINE_BYTES
  // moves and this sentence does not.
  return settingsBlock(3, 'mcp-tool-map', 'Tool map', lede, renderToolMapBody(), 'settings.mcp-tool-map', '');
}

/**
 * ── BLOCK ④ · ACROSS PROJECTS (v3.66.0, placement P8) ─────────────────────
 *
 * THE APP TWIN OF THE MENUBAR WIDGET'S PER-PROJECT BARS (the parity rule: no
 * widget-only fact — a Windows or Linux user has no widget). One monitor line
 * per project: the project's DOMAIN identity dot, `domain / project`, the
 * sessions that SAVED a handoff in 30 days with a depth bar against the
 * busiest project (a column of peers — `byProjectWindow.busiestSaved`, the
 * named denominator), and how many sessions there were under it. Then the
 * widget pulse strip's fact: saves in the last 7 days.
 *
 * ZERO-SESSION PROJECTS ARE SHOWN, AS 0, DIMMED — a project whose agents never
 * saved is the one a reader most needs to find, and hiding it would make the
 * list read as "every project saves". They sort last (the route's own order)
 * and their figure takes --text-2 via `.settings-id-idle`.
 *
 * ABSENT IS NOT ZERO: with no usage log on this computer the route sends
 * `sessions: null` on every row, and this block draws no row at all and says
 * so, rather than a column of zeros.
 *
 * NEVER RED: `max`, never `budget` — being the busiest project is not a fault.
 *
 * The identity slot is `state.defaultDomainInfo.identity` (v3.76.0 — each
 * domain's RECORDED slot, the one every other surface paints from). A row
 * whose domain this install does not hold gets NO dot — never a guessed one
 * (v3.65.3's own rule for an unindexed domain).
 */
const ACROSS_PROJECTS_MAX_ROWS = 12;
function renderAcrossProjects() {
  // v3.72.1 (truth audit F6/F10): no window length in the lede. It read "last
  // 30 days" — typed, while the route sends the window it counted over
  // (`byProjectWindow.windowDays`). The body states the window from the
  // payload, and the lede stays true whatever that window is.
  // v3.74.0 (D5): CONNECTIONS. The figure counts MCP bridge processes — one
  // per Claude Code session, but ONE for many Claude Desktop conversations —
  // so "sessions" over-claimed; the ⓘ says what a connection is.
  const lede = 'Which projects’ agent connections saved a handoff.';
  return settingsBlock(4, 'mcp-across', 'Across projects', lede, renderAcrossProjectsBody(), 'settings.mcp-across', '');
}

/**
 * The window a payload counted over, as words: "last 30 days". From the
 * route's own figures (`byProjectWindow.windowDays`, `savePulse.windowSeconds`),
 * never typed; '' when the payload does not say, so a caller drops the
 * clause rather than inventing one. v3.72.1 (audit F10).
 */
function windowDaysWords(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  const d = Math.round(days * 100) / 100;
  return 'last ' + (d === 1 ? 'day' : d + ' days');
}

/**
 * THE WINDOW THE USAGE LOG REALLY COVERS, as words (v3.74.0, D5).
 *
 * The route asks for 30 days; a log that began five days ago cannot support
 * that. When `windowCovered === false` this says the span the log does cover
 * and the day it begins — "last 5 days — the log begins 20 Sep" — from the
 * route's `captureWindowFacts` (the widget's own derivation). Otherwise it is
 * `windowDaysWords` of the window asked for. '' when neither is known.
 */
function logWindowWords(w) {
  const win = w && typeof w === 'object' ? w : {};
  const begins = typeof win.logStartsAt === 'string' ? Date.parse(win.logStartsAt) : NaN;
  if (win.windowCovered === false && Number.isFinite(begins)
      && Number.isFinite(win.windowDaysCovered)) {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = new Date(begins);
    const days = Math.round(win.windowDaysCovered);
    return (days < 1 ? 'under a day' : 'last ' + (days === 1 ? 'day' : days + ' days'))
      + ' — the log begins ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
  }
  return windowDaysWords(win.windowDays);
}

function renderAcrossProjectsBody() {
  let body;
  const P = state.mcpProjects;
  if (!P) {
    body = '<p class="mcp-map-empty">' + escapeHtml(state.mcpProjectsError || 'Reading the usage logs…') + '</p>';
  } else {
    const w = P.window || {};
    const capWindow = logWindowWords(w);
    const busiest = Number.isInteger(w.busiestSaved) && w.busiestSaved > 0 ? w.busiestSaved : 0;
    const measured = w.logPresent === true
      ? P.byProject.filter((r) => r && Number.isInteger(r.sessions) && Number.isInteger(r.sessionsSaved))
      : [];
    const shown = measured.slice(0, ACROSS_PROJECTS_MAX_ROWS);
    // v3.74.0 — THE BAR'S SCALE, NAMED AS A COMPARISON. A row's own figure is
    // "N of its M connections saved"; the bar is scaled to the busiest
    // project, and that project is NAMED, so "2 of 6 …, the busiest project"
    // can no longer read as if this row were the busiest.
    const top = measured.find((r) => r.sessionsSaved === busiest) || null;
    const busiestName = top && typeof top.project === 'string' && top.project ? top.project : 'the busiest project';
    const lines = shown.map((r) => {
      const dotCls = typeof r.domain === 'string'
        ? domainIdentityClass(state.defaultDomainInfo && state.defaultDomainInfo.identity, r.domain) : '';
      const name = typeof r.project === 'string' && r.project ? r.project : '(unnamed)';
      const key = typeof r.domain === 'string' && r.domain && r.domain !== name
        ? r.domain + ' / ' + name : name;
      const idle = r.sessions === 0;
      const sub = (idle ? (capWindow ? 'no connection, ' + capWindow : 'no connection')
        : r.sessions + (r.sessions === 1 ? ' connection' : ' connections')) +
        (r.inStore === false ? ' · not in this folder' : '');
      return {
        key,
        value: r.sessionsSaved,
        markHtml: '<span class="settings-id-mark' + (idle ? ' settings-id-idle' : '') + '">' +
          (dotCls ? '<span class="cur-sb-dot ' + dotCls + '" aria-hidden="true"></span>' : '') +
          '</span>',
        sub,
        depth: r.sessionsSaved > 0 && busiest > 0
          ? { amount: r.sessionsSaved, max: busiest,
              label: r.sessionsSaved === busiest
                ? r.sessionsSaved + ' of ' + r.sessions + ' connections saved — the busiest project'
                : r.sessionsSaved + ' of ' + r.sessions + ' connections saved · bar scaled to '
                  + busiestName + '’s ' + busiest }
          : undefined,
      };
    });
    const pulse = P.savePulse;
    if (pulse && Number.isInteger(pulse.events)) {
      const pw = windowDaysWords(Number.isFinite(pulse.windowSeconds) ? pulse.windowSeconds / 86400 : NaN);
      // A store younger than the window has not been observed for all of it,
      // so "saves, last 7 days: 3" would claim a week nobody watched. Say
      // where the record begins instead (`coversWholeWindow === false`).
      const since = pulse.coversWholeWindow === false && typeof pulse.oldestEventAt === 'string'
        ? formatSyncedAt(pulse.oldestEventAt) : '';
      const key = 'saves' + (pw ? ', ' + pw : '') +
        (pulse.coversWholeWindow === false ? (since ? ' (records begin ' + since + ')' : ' (records do not cover it all)') : '');
      lines.push({ key, value: (pulse.lowerBound ? 'at least ' : '') + pulse.events });
      // ── SAVES BY TOOL (v3.74.0, the parity rule) ────────────────────────
      // The widget's "Saves by tool": the same pulse, one lane per tool
      // (normalised by the data layer, so one tool typed two ways is one
      // line). A count is "at least" whenever any journal was read only from
      // its tail (`byToolFloor`); a tool with no save in the window reads
      // "none" and says the day it was LAST SEEN in what was read — never
      // "last save", which a tail cannot promise.
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const seen = (iso) => {
        const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
        if (!Number.isFinite(t)) return '';
        const d = new Date(t);
        return d.getDate() + ' ' + MONTHS[d.getMonth()];
      };
      for (const t of Array.isArray(pulse.byTool) ? pulse.byTool : []) {
        if (!t || typeof t.label !== 'string' || !t.label || !Number.isInteger(t.events)) continue;
        lines.push({
          key: 'by ' + t.label,
          value: t.events === 0 ? 'none'
            : (pulse.byToolFloor === true || pulse.lowerBound ? 'at least ' : '') + t.events,
          sub: t.events === 0 && seen(t.lastSeenAt) ? 'last seen ' + seen(t.lastSeenAt) : '',
        });
      }
      if (Number.isInteger(pulse.eventsWithoutTool) && pulse.eventsWithoutTool > 0) {
        lines.push({ key: 'named no tool', value: pulse.eventsWithoutTool });
      }
    }
    const notes = [];
    // THE WINDOW, VISIBLE (v3.74.0, D5). The monitor's label is its accessible
    // name, not a line on screen, so a busy row's "7 connections" had no
    // window beside it at all. Said once, first, in the same words.
    if (w.logPresent === true && measured.length && capWindow) {
      notes.push('Counted over the ' + capWindow + '.');
    }
    if (pulse && pulse.byToolFloor === true && typeof pulse.byToolNote === 'string' && pulse.byToolNote) {
      notes.push(pulse.byToolNote);
    }
    if (w.logPresent !== true) {
      notes.push('No usage log on this computer yet — connections appear here once an agent uses the bridge.');
    } else if (!measured.length) {
      notes.push('No project in this folder has a saved handoff yet.');
    }
    if (measured.length > shown.length) {
      const more = measured.length - shown.length;
      notes.push(more + ' more ' + (more === 1 ? 'project' : 'projects') + ' with fewer saves.');
    }
    if (shown.some((r) => r.sharedName)) {
      notes.push('Projects that share a name share one reading.');
    }
    body = '<div class="mcp-across">' + renderMonitor({
      label: 'Connections that saved, per project' + (capWindow ? ', ' + capWindow : ''),
      lines,
      note: notes.join(' '),
    }) + '</div>';
  }
  return body;
}

/**
 * ── KNOWLEDGE BASE › VAULT FOLDER › DOMAINS IN THIS FOLDER (v3.66.0, P8) ──
 *
 * The app twin of the widget's per-domain page bars. One line per domain: its
 * identity dot, its folder name, its page count with a bar against the
 * LARGEST domain in the folder — and the bar takes the domain's OWN colour
 * (`depthIdentitySlotClass`), the one place a depth bar wears identity, because
 * here each row IS a domain (design rule 6's identity tone).
 *
 * `pageCount` is getDomainStats' own figure — the same function the widget's
 * `domains[]` reads — so the two can never state a different number. A domain
 * whose stats could not be read says so in words and draws no bar; a domain
 * with 0 pages prints 0 and draws no bar.
 */
function renderVaultDomains() {
  const rows = state.vaultDomains;
  if (!Array.isArray(rows)) {
    return state.vaultDomainsError
      ? '<p class="settings-vault-note">' + escapeHtml(state.vaultDomainsError) + '</p>' : '';
  }
  if (!rows.length) return '';
  const largest = rows.reduce((m, d) => Math.max(m, Number.isInteger(d.pageCount) ? d.pageCount : 0), 0);
  const ordered = rows.slice().sort((a, b) =>
    ((Number.isInteger(b.pageCount) ? b.pageCount : -1) - (Number.isInteger(a.pageCount) ? a.pageCount : -1))
    || (a.index - b.index));
  return '<div class="settings-vault-domains">' +
    '<div class="settings-vault-eyebrow">DOMAINS IN THIS FOLDER</div>' +
    renderMonitor({
      label: 'Domains in this folder, pages each',
      lines: ordered.map((d) => {
        const n = d.pageCount;
        return {
          key: d.slug,
          markHtml: '<span class="settings-id-mark">' +
            (identitySlotClass(d.identitySlot)
              ? '<span class="cur-sb-dot ' + identitySlotClass(d.identitySlot) + '" aria-hidden="true"></span>' : '') +
            '</span>',
          value: Number.isInteger(n) ? n : 'not read',
          sub: Number.isInteger(n) ? (n === 1 ? 'page' : 'pages') : '',
          depth: Number.isInteger(n) && n > 0 && largest > 0
            ? { amount: n, max: largest, toneClass: depthIdentitySlotClass(d.identitySlot) || undefined,
                label: n === largest ? n + ' pages — the largest domain in this folder'
                  : n + ' of ' + largest + ' pages, the largest domain in this folder' }
            : undefined,
        };
      }),
    }) + '</div>';
}

/**
 * THE AGE CLOCK FOR THIS BLOCK, and it is not a render.
 *
 * Byte-for-byte the shape views/memory.js uses (see its `tickAges`): walk the
 * elements carrying the hook, write `textContent` into ONE named child, write
 * only when the words actually changed. It must never call `render()` —
 * settings.js shipped a 1s `render()` tick once and v3.53.1 records what it
 * cost: every ⓘ panel and every `<details>` on the section closed itself while
 * the user was reading.
 *
 * ONE NAMED TARGET, never `el.textContent`: every hooked element on this block
 * carries a `.mcp-age-words` span this view owns — a tool tile's meta line
 * writes one directly, and the session monitor's two lines compose one inside
 * the `markHtml` they hand the kit (see renderSessionStrip for why the hook
 * lives there). Writing the wrapper's own text would delete the caption beside
 * it. It WAS two targets: `.tx-readout-value` was the first, back when the
 * session strip painted through shared/text.js's readout, and that branch went
 * with the strip in v3.65.0 rather than being left as a selector matching
 * nothing.
 */
function tickMcpAges() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
  const now = Date.now();
  const nodes = document.querySelectorAll('[data-mcp-age-at]');
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const at = el.getAttribute('data-mcp-age-at');
    const t = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) continue;
    const words = formatAge(Math.max(0, Math.round((now - t) / 1000)));
    if (words === null) continue;
    const target = el.querySelector('.mcp-age-words');
    if (target && target.textContent !== words) target.textContent = words;
  }
}

/**
 * The 30s revalidate, and what it is allowed to repaint.
 *
 * ONE BLOCK BODY, and only when the signature moved. An agent working in
 * another window is the whole reason this poll exists — the map would
 * otherwise be as old as the last time the user changed sections — but a
 * re-render of the column every thirty seconds would shut every fold on the
 * page for a reading nobody is watching. So the payload is compared first, the
 * body is replaced second, and `#view-root` is never touched.
 *
 * When the block is NOT in the document (the user is on another section) the
 * state is still updated and nothing is painted: the next `render()` reads the
 * fresh payload, which is the same answer one frame later.
 */
async function refreshMcpUsage(token) {
  const verdict = await fetchMcpUsage();
  if (!isCurrentMount(token)) return;
  const sig = verdict.ok ? usageSignature(verdict.data) : null;
  // NOTHING MOVED, NOTHING REPAINTS — not even the error, which is unchanged.
  if (verdict.ok && sig === state.mcpUsageSig) return;
  // v3.72.1 (truth audit F9): block ④ (Across projects) counts the same saves
  // and sessions, and was read once per section entry — so while an agent
  // saved, block ③'s `save_working_state` tile moved and block ④ did not: two
  // readings of one fact disagreeing on one screen. When the save or session
  // stamp moved, ④ is re-read on the same tick.
  const sessionsMoved = verdict.ok && acrossProjectsStamp(verdict.data) !== acrossProjectsStamp(state.mcpUsage);
  applyUsageVerdict(verdict);
  if (sessionsMoved && state.mcpProjects) loadAcrossProjects(token, { bodyOnly: true }).catch(() => {});
  if (state.section !== 'mcp') return;
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const body = document.querySelector(TOOL_MAP_BODY_SEL);
  if (!body) return;
  body.innerHTML = renderToolMapBody();
  // THE REPAINT REPLACED THE BUTTON, so its listener went with it. Re-bound
  // here rather than delegated from the document: a delegated handler would
  // outlive the view, and `wireMcpListeners` is already the one place this
  // section binds from — this is the same call, on the one element the
  // revalidate can destroy.
  wireExerciseControl(token);
}

/** Bind (or re-bind) block ③'s run control. Idempotent by construction: the
 *  element is new every time the body is painted, so there is nothing to
 *  unbind. A no-op when the control is not on screen. */
function wireExerciseControl(token) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
  const btn = document.getElementById('btn-mcp-exercise');
  if (btn) btn.addEventListener('click', () => onMcpExercise(token));
}

/** Arm the revalidate. A setTimeout CHAIN, not setInterval: a slow answer must
 *  delay the next request rather than stack one behind it — the rule
 *  views/memory.js's poll records. */
function scheduleUsagePoll(token) {
  stopUsagePoll();
  if (typeof setTimeout !== 'function') return;
  usagePoll.timer = setTimeout(() => {
    usagePoll.timer = null;
    // A DEAD MOUNT ENDS THE CHAIN. Without this the poll would keep fetching
    // for a view nobody is looking at, for the life of the page.
    if (!isCurrentMount(token)) return;
    refreshMcpUsage(token).catch(() => {}).then(() => {
      if (isCurrentMount(token)) scheduleUsagePoll(token);
    });
  }, USAGE_POLL_MS);
}

/** Disarm it. Called by the teardown, and by `scheduleUsagePoll` itself so
 *  there is exactly one armed timer however many times it is called. */
function stopUsagePoll() {
  if (usagePoll.timer !== null) {
    if (typeof clearTimeout === 'function') clearTimeout(usagePoll.timer);
    usagePoll.timer = null;
  }
}

// ── Health & scan limits ──────────────────────────────────────────────────

/**
 * ── ONE BLOCK, NO NUMERAL, AND TWO FIELDS IN A CARD ────────────────────────
 *
 * Unnumbered on purpose: `settingsBlock(null, …)` renders no numeral and no
 * 32px indent (see `.settings-block-unnumbered`). A numeral is a claim that
 * something comes first, and this section is one thing — there is no step 2
 * for it to be step 1 of.
 *
 * ── WHY THE SAVE BUTTON STOPPED SITTING FLUSH AGAINST THE LAST FIELD ───────
 * Before this change the two fields were bare `.settings-field-block`s and
 * the Save button was the next sibling in the same flex column, at the
 * column's own `gap`. Measured in the running app that came out at 12px
 * between the second field's hint line and the top of the button — close
 * enough that the button read as part of the field rather than as the action
 * for both of them. Putting the fields inside a `.cur-group.cur-group-fields`
 * card (the same kit card General's Appearance rows use) gives them an edge
 * of their own, and `.settings-btn-row`'s own margin then lands the button
 * clear of it.
 *
 * ── WHAT IS NOT FOLDED ─────────────────────────────────────────────────────
 * The per-field hints state the DEFAULT for the input they sit under, which
 * is in-context labelling rather than a description — one line, under the
 * thing it explains. The validation error is a finding, so it is never
 * folded. The section's own model ("a ceiling REFUSES, it does not
 * truncate") is in the header's ⓘ, where it already was.
 */
const SCAN_LIMIT_REFUSAL = 'A scan estimates its cost first, and does not start when the estimate is over the ceiling.';
const MCP_DOMAIN_CONSEQUENCE = 'Left unset, a write waits for the agent to name a domain. ' +
  'A write aimed at the wrong domain lands in that wiki and is hard to spot afterwards.';

/**
 * The cost-ceiling hint, from the route's own figures (v3.72.1, audit F7 /
 * tray F4): the default is config.js's DEFAULT_AI_HEALTH as served
 * (`defaults`), and its price is `defaultRunsOn` — describeHealthRun on the
 * model that builds the wiki now, the pricing the scan's confirm uses. Each
 * half is dropped, never guessed, when the route did not send it.
 */
function scanCeilingHint(ai) {
  const lead = 'Estimated input and output tokens together.';
  const d = ai && ai.defaults && Number.isInteger(ai.defaults.costCeilingTokens) ? ai.defaults.costCeilingTokens : null;
  if (d === null) return lead;
  const ro = ai.defaultRunsOn && typeof ai.defaultRunsOn === 'object' ? ai.defaultRunsOn : null;
  let price = '';
  if (ro && ro.needsKey !== true && typeof ro.modelLabel === 'string' && ro.modelLabel) {
    if (ro.free === true) price = ' — free on ' + ro.modelLabel + ', the model that builds your wiki';
    else if (typeof ro.usdHigh === 'number' && Number.isFinite(ro.usdHigh)) {
      price = ' — ≈ ' + formatUsdHonest(ro.usdHigh) + ' on ' + ro.modelLabel + ', the model that builds your wiki';
    } else price = ' — ' + ro.modelLabel + ' publishes no price, so no cost is shown';
  }
  return lead + ' Default ' + formatTokenCount(d) + price + '.';
}

function renderHealthLimits() {
  if (state.aiHealthError) {
    return '<div class="settings-inline-error">' + escapeHtml(state.aiHealthError) + '</div>';
  }
  if (!state.aiHealth) {
    return gatedLoader(loadGate, 'Loading scan limits…');
  }

  // v3.72.1 (truth audit F7): the lede said "Used by Health → Ask AI scans",
  // but the ceiling governs ONE of them — the semantic-duplicate scan
  // (routes/health.js and mcp/tools/health.js read it). The broken-link and
  // orphan-rescue plans carry their own fixed ceilings in health-ai.js. The
  // shared explainer already said "AI duplicate scan"; now the lede does too.
  const lede = 'Caps what one AI duplicate scan may cost.';

  const body =
    // The two fields as rows of the kit's inset group — the same card and the
    // same label-left/control-right axis General's Appearance rows use. Each
    // row keeps `.settings-field-block` wholesale, so every id and every test
    // selector is byte-identical; the card only adds the edge, the padding and
    // the hairline between them.
    '<div class="cur-group cur-group-fields">' +
      '<div class="settings-field-block">' +
        '<div class="cur-group-label">' +
          '<span class="settings-field-label">Cost ceiling per scan</span>' +
          // v3.72.1 (audit F7 / tray F4): this read "Default 50,000 tokens ≈
          // $0.01 on Gemini Flash Lite" — a SECOND copy of config.js's
          // DEFAULT_AI_HEALTH, and a dollar figure true for one model only (on
          // Flash Lite 3.1 or Haiku 4.5 the same tokens cost several times it),
          // while the scan runs on whatever builds the wiki. Both halves now
          // come off the route: the default IS the constant, and its price is
          // the scan's own run-line pricing on the model in force.
          '<span class="settings-hint-text">' + escapeHtml(scanCeilingHint(state.aiHealth)) + '</span>' +
        '</div>' +
        '<div class="settings-input-suffix"><input type="number" min="1" class="mono settings-number-input" id="input-cost-ceiling" value="' + escapeHtml(state.costCeilingInput) + '"><span class="mono suffix">tokens</span></div>' +
      '</div>' +
      '<div class="settings-field-block">' +
        '<div class="cur-group-label">' +
          '<span class="settings-field-label">Maximum candidate pairs per scan</span>' +
          '<span class="settings-hint-text">' + escapeHtml('After local pre-filtering, only the top N pairs by similarity are sent to the model.' +
            (state.aiHealth && state.aiHealth.defaults && Number.isInteger(state.aiHealth.defaults.semanticDupeMaxPairs)
              ? ' Default ' + formatTokenCount(state.aiHealth.defaults.semanticDupeMaxPairs) + '.' : '')) + '</span>' +
        '</div>' +
        '<div class="settings-input-suffix"><input type="number" min="1" class="mono settings-number-input" id="input-max-pairs" value="' + escapeHtml(state.maxPairsInput) + '"></div>' +
      '</div>' +
    '</div>' +
    // THE REFUSAL IS ON THE PAGE (v3.71.1): it lived only inside ⓘs, and a
    // refusal behind a click is not a statement anyone reads (v3.16.1).
    '<p class="settings-block-footnote">' + escapeHtml(SCAN_LIMIT_REFUSAL) + '</p>' +
    (state.scanLimitsValidationError ? '<div class="settings-inline-error">' + escapeHtml(state.scanLimitsValidationError) + '</div>' : '') +
    // One action, so one primary, at body level and therefore md.
    '<div class="settings-btn-row">' +
      '<button type="button" class="btn btn-primary" id="btn-save-scan-limits"' + (state.aiHealthSaving ? ' disabled' : '') + '>' +
        (state.aiHealthSaving ? 'Saving…' : 'Save scan limits') +
      '</button>' +
      (state.aiHealthSaved ? '<span class="mono settings-saved-note">' + icon('checkAlt', 12) + ' saved</span>' : '') +
    '</div>';

  // NO block ⓘ (v3.71.1): the section header's `settings.health` explainer
  // says what this, the section's only block, would have said.
  return settingsBlock(null, 'health-limits', 'Semantic-duplicate scan limits', lede, body, null, '');
}

// ── Knowledge base ────────────────────────────────────────────────────────

/**
 * ── ONE UNNUMBERED BLOCK ───────────────────────────────────────────────────
 *
 * The cross-write banner goes in `settingsBlock`'s NOTICE slot, which renders
 * above the heading and outside the ⓘ entirely — the same slot block 2 of
 * Providers uses for the retired-model banner, and for the same reason. It is
 * a data warning: changing this folder mid-write sends that write's remaining
 * pages into the new folder, since every write resolves the path fresh, per
 * call, and nothing caches it. A warning is never foldable.
 *
 * The one-line note under the path row is the opposite case — it is the
 * reassurance that makes the primary button safe to press, so it stays
 * visible, one line, directly under the thing it is about.
 */
function renderStorage(domainsMonitorHtml) {
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

  const lede = 'The folder every domain lives in. Point Obsidian at it as a vault.';

  const body =
    // Row-level buttons, so `btn-xs`: the SIZE is the container's decision.
    // One primary (Choose folder is the action that completes the block) and
    // one ghost — "Copy" is a clipboard read, which is the ghost case exactly.
    '<div class="storage-path-row">' +
      '<code class="mono storage-path">' + escapeHtml(state.config.domainsPath) + '</code>' +
      '<button type="button" class="btn btn-primary btn-xs" id="btn-choose-folder"' + (chooseDisabled ? ' disabled' : '') + chooseTitle + '>' +
        (state.pickingFolder ? 'Waiting for Finder…' : 'Choose folder') +
      '</button>' +
      // "Copy" is a clipboard-only read — deliberately not gated (see file-header comment).
      '<button type="button" class="btn btn-ghost btn-xs" id="btn-copy-path">Copy' + (state.pathCopyFeedback ? ' — ' + escapeHtml(state.pathCopyFeedback) : '') + '</button>' +
    '</div>' +
    '<div class="settings-note-row">' +
      icon('folder', 15) +
      '<span>Moving this folder loses nothing; the graph is picked up as-is.</span>' +
    '</div>' +
    // v3.66.0: "Domains in this folder", composed by the caller (see renderMain).
    (typeof domainsMonitorHtml === 'string' ? domainsMonitorHtml : '');

  return settingsBlock(null, 'storage-folder', 'Vault folder', lede, body, 'settings.vault-folder',
    renderCrossWriteBanner('wait for it to finish before changing the knowledge base folder.'));
}

/**
 * ── THE GITHUB READ-ONLY TOKEN (v3.65.2) ───────────────────────────────────
 *
 * The field the Documents "Mirror from GitHub" panel has pointed at since
 * v3.63.0 and nobody had built. It is the PROVIDER ROW's anatomy, reused
 * rather than redrawn — name block, a status well, a pill, the actions at the
 * right; "Add token"/"Replace token" swaps in the same password row with Save
 * and Cancel — because a credential is a credential and this screen already
 * has one way to hold one.
 *
 * WHAT NEVER REACHES THE MARKUP: the value. The status well reads the route's
 * `{present, last4, kind}`; the password input carries no `value=` and gets
 * the typed text as a live DOM property in wireStorageListeners.
 *
 * WHAT NEVER GOES BEHIND THE ⓘ: the classic-token caution (a warning — v3.16.1),
 * a failed save or disconnect, and the Test's outcome, which is a MONITOR.
 */
function renderGithubReadToken() {
  const st = state.ghToken;
  const present = !!(st && st.present);
  const busy = state.ghTokenBusy;
  const kindWord = st && st.kind ? st.kind : null;

  const lede = 'Lets a project\u2019s Documents mirror from a GitHub repository, read-only.';

  let bodyHtml;
  if (state.ghTokenLoadError && !st) {
    bodyHtml = '<div class="settings-inline-error">' + escapeHtml(state.ghTokenLoadError) + '</div>';
  } else {
    const statusText = present
      ? 'Saved \u00b7 ends in \u2026' + (st.last4 || '????') + (kindWord ? ' \u00b7 ' + kindWord : '')
      : 'No token saved';
    let fieldHtml;
    if (state.ghTokenEditing) {
      fieldHtml =
        '<div class="provider-replace-row">' +
          '<input type="password" class="provider-replace-input mono" id="gh-token-input"' +
            ' placeholder="Paste a github_pat_\u2026 token" autocomplete="off" spellcheck="false"' +
            ' aria-label="GitHub read-only token">' +
          '<button type="button" class="btn btn-primary btn-xs" id="gh-token-save"' + (busy ? ' disabled' : '') + '>' +
            (busy === 'save' ? 'Saving\u2026' : 'Save') + '</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" id="gh-token-cancel"' + (busy ? ' disabled' : '') + '>Cancel</button>' +
        '</div>';
    } else {
      fieldHtml =
        '<code class="provider-key-field mono' + (present ? '' : ' provider-key-empty') + '" id="gh-token-status">' +
          escapeHtml(statusText) + '</code>' +
        '<span class="provider-pill ' + (present ? 'provider-pill-on' : 'provider-pill-off') + '">' +
          (present ? '<span class="provider-state-icon" aria-hidden="true">' + icon('checkAlt', 11) + '</span>Saved' : 'Not saved') +
        '</span>' +
        '<div class="provider-row-actions">' +
          (present
            ? '<button type="button" class="btn btn-ghost btn-xs" id="gh-token-disconnect"' + (busy ? ' disabled' : '') + '>' +
                (busy === 'disconnect' ? 'Disconnecting\u2026' : 'Disconnect') + '</button>'
            : '') +
          '<button type="button" class="btn btn-' + (present ? 'secondary' : 'primary') + ' btn-xs" id="gh-token-edit"' +
            (busy ? ' disabled' : '') + '>' + (present ? 'Replace token' : 'Add token') + '</button>' +
        '</div>';
    }
    // TEST — only when a token is saved: with none there is nothing to test,
    // and a disabled control would need a reason sentence the status well
    // already says. It is the CARD'S SECOND ROW, on the first row's anatomy
    // (label block left, control right) — not a bare field under the card,
    // which was a second anatomy beside the card's own (orchestrator's screen
    // review, v3.65.2). Its outcome is a monitor INSIDE the same card.
    const testRow = present
      ? '<div class="provider-row gh-token-test-row" data-gh-token-test-row>' +
          '<span class="provider-name-block">' +
            '<span class="provider-name">Test</span>' +
            '<span class="provider-vendor">One read of a repository</span>' +
          '</span>' +
          '<div class="provider-replace-row">' +
            '<input type="text" class="provider-replace-input mono" id="gh-token-repo"' +
              ' placeholder="owner/repo" autocomplete="off" spellcheck="false"' +
              ' aria-label="Repository to test the token against">' +
            '<button type="button" class="btn btn-secondary btn-xs" id="gh-token-test"' +
              (state.ghTokenTestBusy ? ' disabled' : '') + '>' +
              (state.ghTokenTestBusy ? 'Testing\u2026' : 'Test') + '</button>' +
          '</div>' +
        '</div>'
      : '';
    const testResult = present ? renderGithubTokenTest(state.ghTokenTest) : '';

    const row =
      '<div class="provider-row-list cur-group">' +
        '<div class="provider-row" data-gh-token-row>' +
          '<span class="provider-name-block">' +
            '<span class="provider-name">GitHub</span>' +
            '<span class="provider-vendor">Read-only token</span>' +
          '</span>' +
          fieldHtml +
        '</div>' +
        testRow +
        (testResult ? '<div class="gh-token-test-result">' + testResult + '</div>' : '') +
      '</div>';

    // A CLASSIC token saves — it works — but the caution is a WARNING, so it
    // is unfolded, in the body, every time the saved token is one.
    const caution = present && st.kind === 'classic'
      ? '<div class="settings-note-row settings-note-row-warn" data-gh-token-caution>' +
          icon('alertTriangle', 15) +
          '<span>This is a classic token. With the <code class="mono">repo</code> scope it can read every ' +
          'repository this account owns, not only the one you mirror. A fine-grained, read-only token ' +
          'is safer \u2014 the \u24d8 above says how to make one.</span>' +
        '</div>'
      : '';

    const actionError = state.ghTokenActionError
      ? '<div class="settings-inline-error" role="alert">' + escapeHtml(state.ghTokenActionError) + '</div>'
      : '';

    bodyHtml = row + caution + actionError;
  }

  return settingsBlock(null, 'storage-github-token', 'GitHub read-only token', lede, bodyHtml, 'settings.github-token', '');
}

/**
 * The Test's outcome, as a MONITOR (standing rule 4): the outcome of a live
 * probe is a reading of state, the same instrument the MCP self-test uses.
 * A failure's own message is `loud` — it is what the user can act on, and it
 * names the token's SOURCE (the route guarantees it never carries the value).
 */
function renderGithubTokenTest(r) {
  if (!r || typeof r !== 'object') return '';
  if (r.ok === true) {
    return renderMonitor({
      label: 'GitHub token test',
      head: { stateWord: 'Token reads this repository', tone: 'ok' },
      lines: [
        { key: 'repository', value: String(r.repo || '') },
        { key: 'ref', value: String(r.ref || '') },
        { key: 'commit', value: String(r.sha || '').slice(0, 7) },
      ],
    });
  }
  return renderMonitor({
    label: 'GitHub token test',
    head: { stateWord: 'Test failed', tone: 'danger' },
    lines: r.repo ? [{ key: 'repository', value: String(r.repo) }] : [],
    loud: [{ tone: 'danger', text: String(r.message || 'The test did not complete.') }],
  });
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
      // ONE-SHOT, CONSUMED BY THE NEXT render() — see renderMain. Set HERE, at
      // the only place a section actually changes, rather than derived inside
      // the renderer by comparing to a remembered section: this view renders
      // from ~40 call sites and a "did it change" comparison would also fire
      // on the first render of a mount, which `navigate()` already animates
      // through the shell's own view-enter. Two animations on one paint is
      // the stutter scripts/test-next-view-enter-motion.js exists to stop.
      state.sectionJustChanged = true;
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

  // Hydrate every listbox this render emitted, from the cfg objects that
  // produced the markup. Runs BEFORE the per-section wiring so a section
  // handler can rely on the control being live.
  //
  // Settings re-renders WHOLESALE (setMain replaces innerHTML), so the
  // previous mount's trigger elements are already gone by the time this
  // runs. The component's menu is a <body> child and would therefore
  // OUTLIVE that repaint as a detached-trigger orphan — its own rAF loop
  // closes it within a frame of the trigger leaving the document, and
  // closeAllListboxes() below is the belt to that's braces.
  closeAllListboxes();
  for (const cfg of pendingListboxes) mountListbox(cfg);

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
  // Menu bar. Scoped by the presence of data-background-mode for the same
  // reason the two above are: these buttons reuse .theme-seg-btn for its look.
  document.querySelectorAll('[data-background-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onSetBackgroundMode(btn.dataset.backgroundMode, myMountToken).catch(reportAsyncActionFailure);
    });
  });

  const runBtn = document.getElementById('btn-run-quick-check');
  if (runBtn) runBtn.addEventListener('click', () => onRunQuickCheck(myMountToken));
  const verifyBtn = document.getElementById('btn-verify-ai');
  if (verifyBtn) verifyBtn.addEventListener('click', () => { openLiveConfirm(myMountToken); });
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

  // The in-app updater's three. NO MOUNT TOKEN is passed, and that is not an
  // oversight — see the `inAppUpdate` declaration: the work outlives the mount
  // on purpose, so a captured token would be the wrong thing to gate it on.
  const inappBtn = document.getElementById('btn-inapp-install');
  if (inappBtn) inappBtn.addEventListener('click', () => onInstallInApp().catch(reportAsyncActionFailure));
  const finishBtn = document.getElementById('btn-inapp-finish');
  if (finishBtn) finishBtn.addEventListener('click', () => finishInAppUpdate().catch(reportAsyncActionFailure));
  const retryBtn = document.getElementById('btn-inapp-retry');
  if (retryBtn) retryBtn.addEventListener('click', () => onRetryInApp().catch(reportAsyncActionFailure));
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
  // The "Chat only" lane fold, same contract again — record, never re-render.
  // It is the fold every "Test on my wiki" button lives inside, so losing its
  // state made a press render its own confirm panel into a collapsed
  // disclosure. See renderModelLanes.
  document.querySelectorAll('[data-model-lane]').forEach((el) => {
    el.addEventListener('toggle', () => {
      if (el.open) state.modelLaneOpen[el.dataset.modelLane] = true;
      else delete state.modelLaneOpen[el.dataset.modelLane];
    });
  });
  // Block 2's `Change…` disclosure — record, never re-render. Same contract as
  // every other <details> here: the element has already applied the change, so
  // repainting would throw away the DOM the user is looking at.
  document.querySelectorAll('[data-build-list]').forEach((el) => {
    el.addEventListener('toggle', () => { state.buildListOpen = !!el.open; });
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
  // The sort control is the shared listbox now — mounted from
  // pendingListboxes in wireGlobalListeners, with its onChange built beside
  // the markup in renderModelFilterBar. There is no [data-model-filter-sort]
  // element left to delegate to.
  document.querySelectorAll('[data-model-filter-measured]').forEach((el) => {
    el.addEventListener('change', () => {
      setModelFilter(el.dataset.modelFilterMeasured, { measuredOnly: !!el.checked });
      render(myMountToken);
    });
  });
  document.querySelectorAll('[data-model-filter-clear]').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Clears every axis, not just the search text: the empty state can be
      // caused by one facet alone, and a "Clear filters" button that leaves one
      // filter applied is the control that looks broken. The three block-4 axes
      // are cleared here too — one clear for one bar, whichever bar it is,
      // because the alternative is a second handler that has to be kept in step
      // with which scope owns which axis.
      setModelFilter(btn.dataset.modelFilterClear,
        { q: '', measuredOnly: false, lane: 'all', band: 'any', provider: '' });
      render(myMountToken);
    });
  });
  // ── BLOCK 4's SEGMENTED FACETS ─────────────────────────────────────────
  // Two attributes rather than one delegated handler with a mode string: they
  // set different axes, and this file already records why a single dispatcher
  // keyed on a string is one typo away from the wrong write.
  document.querySelectorAll('[data-browse-lane]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setModelFilter(ALL_MODELS_SCOPE, { lane: btn.dataset.browseLane });
      render(myMountToken);
    });
  });
  document.querySelectorAll('[data-browse-band]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setModelFilter(ALL_MODELS_SCOPE, { band: btn.dataset.browseBand });
      render(myMountToken);
    });
  });
  // -- THE ROW'S EVIDENCE ------------------------------------------------
  // A <details> cannot span two table rows, so this is a button plus a second
  // <tr> the renderer emits -- which means it DOES re-render, unlike every
  // native disclosure on this page. Recorded first, so the repaint draws the
  // state the user just asked for.
  document.querySelectorAll('[data-browse-detail]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.browseDetail;
      if (state.browseRowOpen[id] === true) delete state.browseRowOpen[id];
      else state.browseRowOpen[id] = true;
      render(myMountToken);
    });
  });
  // The way out of a model that keeps failing its probe: open the list of the
  // models that are already measured. Same destination as the retired-model
  // banner's button, because it is the same question -- which model should
  // build the wiki -- and this page answers it in exactly one place.
  document.querySelectorAll('[data-qualify-pick-another]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.buildListOpen = true;
      render(myMountToken);
      revealInMain('settings-build-list');
    });
  });
  // ── THE MODEL LISTS GROUP ──────────────────────────────────────────────
  // `Open Model Lab` is gone with the per-provider cards it scrolled to. What
  // replaces it is not a second scroll: the shortlist that used to send people
  // there now carries the Test control itself.
  document.querySelectorAll('[data-check-models]').forEach((btn) => {
    btn.addEventListener('click', () => onCheckModels(btn.dataset.checkModels, myMountToken));
  });
  // Block 4's shortlist fold — record, never re-render. Same contract as every
  // other <details> on this page: the element has already applied the change,
  // so repainting here would throw away the DOM the user is looking at.
  document.querySelectorAll('[data-worth-testing]').forEach((el) => {
    el.addEventListener('toggle', () => { state.worthTestingOpen = !!el.open; });
  });
  // ── THE WAY OUT OF A RETIRED BUILD MODEL ───────────────────────────────
  // The banner's only job is to get the user to the one control that fixes it,
  // so the button OPENS block 2's list and puts the keyboard on the first
  // alternative from the SAME provider — staying on the provider the user is
  // already paying for, rather than silently proposing a switch that moves the
  // bill. Focus is taken AFTER the repaint and BY ID, because the node the
  // click came from does not survive it (preserveMainScroll's own rule).
  document.querySelectorAll('[data-model-gone-pick]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.modelGonePick || '';
      state.buildListOpen = true;
      render(myMountToken);
      // ── THE LIST FIRST, THE ROW SECOND ─────────────────────────────────
      // FOUND BY CLICKING IT. The first draft resolved a candidate, asked for
      // its pick button BY ID, and did nothing at all when that returned null —
      // which is the COMMON case, not an edge one: the first candidate of the
      // provider being complained about is usually the model already in force,
      // and that row deliberately carries a `<span>Building your wiki</span>`
      // rather than a button. So the list opened 1,242px below the fold and the
      // press looked like it had done nothing. That is the v3.8.0 shape the
      // qualify panel already has a comment about, reached through a new door.
      //
      // Now the LIST is revealed unconditionally — that alone makes the press
      // legible — and focus is a bonus taken only when a real, focusable
      // alternative exists. Candidates already in force are skipped, because
      // "pick another" that lands on the one you have is not another.
      revealInMain('settings-build-list');
      const inForce = (state.keys && state.keys.build && typeof state.keys.build.model === 'string')
        ? state.keys.build.model : '';
      const cands = buildCandidates(state.keys)
        .filter(({ p, m }) => p && m && m.id !== inForce);
      const ranked = cands.filter(({ p }) => p.id === provider).concat(
        cands.filter(({ p }) => p.id !== provider));
      for (const { p, m } of ranked) {
        const el = document.getElementById(buildPickButtonId(p.id, m.id));
        if (!el) continue;
        if (typeof el.scrollIntoView === 'function') {
          try { el.scrollIntoView({ block: 'center' }); } catch { /* jsdom / older engines */ }
        }
        if (typeof el.focus === 'function') el.focus();
        break;
      }
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
  // The build choice — a DIFFERENT endpoint, so a different attribute pair
  // rather than a mode flag on the one above. Two controls that write different
  // things through one dispatcher keyed on a string is one typo away from the
  // wrong write, and this one can move the active provider.
  document.querySelectorAll('[data-build-model]').forEach((btn) => {
    btn.addEventListener('click', () =>
      onPickBuildModel(btn.dataset.buildProvider, btn.dataset.buildModel, myMountToken));
  });
  // The reference shelf. Record, never re-render — <details> has already
  // applied the change, so repainting here would throw away the DOM the user is
  // looking at. Same contract as the per-provider pickers and the model rows.
  document.querySelectorAll('[data-model-shelf]').forEach((el) => {
    el.addEventListener('toggle', () => { state.modelShelfOpen = !!el.open; });
  });
  // Block 2's "Used by" fold (v3.67.0): state-backed for the modelShelfOpen
  // reason — this section repaints on things the user did not do.
  document.querySelectorAll('[data-used-by]').forEach((el) => {
    el.addEventListener('toggle', () => { state.usedByOpen = !!el.open; });
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
  // Block ③'s run control. Also re-bound by the 30 s revalidate, which
  // replaces the body this button lives in.
  wireExerciseControl(myMountToken);
  // The default-domain picker is the shared listbox now — mounted from
  // pendingListboxes in wireGlobalListeners, with its onChange built beside
  // the markup in renderMcp(). Nothing to wire here.
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

  // ── GitHub read-only token ──────────────────────────────────────────────
  const editBtn = document.getElementById('gh-token-edit');
  if (editBtn) editBtn.addEventListener('click', () => {
    state.ghTokenEditing = true;
    state.ghTokenValue = '';
    state.ghTokenActionError = null;
    render(myMountToken);
    const el = document.getElementById('gh-token-input');
    if (el && typeof el.focus === 'function') el.focus();
  });
  const input = document.getElementById('gh-token-input');
  if (input) {
    // A live PROPERTY, never a `value=` attribute — see renderGithubReadToken.
    input.value = state.ghTokenValue || '';
    input.addEventListener('input', (e) => { state.ghTokenValue = e.target.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSaveGhToken(myMountToken); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelGhTokenEdit(); }
    });
  }
  const saveBtn = document.getElementById('gh-token-save');
  if (saveBtn) saveBtn.addEventListener('click', () => onSaveGhToken(myMountToken));
  const cancelBtn = document.getElementById('gh-token-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => cancelGhTokenEdit());
  const discBtn = document.getElementById('gh-token-disconnect');
  if (discBtn) discBtn.addEventListener('click', () => onDisconnectGhToken(myMountToken));
  const repo = document.getElementById('gh-token-repo');
  if (repo) {
    repo.value = state.ghTokenRepo || '';
    repo.addEventListener('input', (e) => { state.ghTokenRepo = e.target.value; });
    repo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onTestGhToken(myMountToken); }
    });
  }
  const testBtn = document.getElementById('gh-token-test');
  if (testBtn) testBtn.addEventListener('click', () => onTestGhToken(myMountToken));
}

function cancelGhTokenEdit() {
  state.ghTokenEditing = false;
  state.ghTokenValue = '';          // a typed-but-cancelled secret does not linger
  state.ghTokenActionError = null;
  render(myMountToken);
}

/** Read a JSON body defensively — a proxy's HTML page must yield a sentence. */
async function readJsonSafely(res) {
  try { return await res.json(); } catch { return null; }
}

async function onSaveGhToken(token) {
  // The LIVE DOM value first (autofill can set `.value` without an `input`
  // event), exactly as onSaveKey does.
  const input = document.getElementById('gh-token-input');
  const value = ((input ? input.value : state.ghTokenValue) || '').trim();
  if (!value || state.ghTokenBusy) return;
  state.ghTokenBusy = 'save';
  state.ghTokenActionError = null;
  render(token);
  try {
    const res = await fetch('/api/config/github-read-token', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: value }),
    });
    const data = await readJsonSafely(res);
    if (!isCurrentMount(token)) return;
    if (!res.ok || !data || data.ok !== true) {
      throw new Error((data && typeof data.message === 'string' && data.message)
        // A 409 from guardConcurrent carries `error`, not `message`.
        || (data && typeof data.error === 'string' && data.error) || 'The token could not be saved.');
    }
    state.ghToken = { present: data.present === true, last4: data.last4 || null, kind: data.kind || null };
    state.ghTokenEditing = false;
    state.ghTokenValue = '';        // never lingers past a successful save
    state.ghTokenTest = null;       // a verdict about the PREVIOUS token is not about this one
    state.ghTokenBusy = null;
    render(token);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.ghTokenBusy = null;
    state.ghTokenActionError = err.message || 'The token could not be saved.';
    render(token);
  }
}

async function onDisconnectGhToken(token) {
  if (state.ghTokenBusy) return;
  state.ghTokenBusy = 'disconnect';
  state.ghTokenActionError = null;
  render(token);
  try {
    const res = await fetch('/api/config/github-read-token', { method: 'DELETE' });
    const data = await readJsonSafely(res);
    if (!isCurrentMount(token)) return;
    if (!res.ok || !data || data.ok !== true) {
      throw new Error((data && typeof data.message === 'string' && data.message)
        // A 409 from guardConcurrent carries `error`, not `message`.
        || (data && typeof data.error === 'string' && data.error) || 'The token could not be removed.');
    }
    state.ghToken = { present: false, last4: null, kind: null };
    state.ghTokenTest = null;
    state.ghTokenBusy = null;
    render(token);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.ghTokenBusy = null;
    state.ghTokenActionError = err.message || 'The token could not be removed.';
    render(token);
  }
}

async function onTestGhToken(token) {
  const repoEl = document.getElementById('gh-token-repo');
  const remote = ((repoEl ? repoEl.value : state.ghTokenRepo) || '').trim();
  state.ghTokenRepo = remote;
  if (state.ghTokenTestBusy) return;
  if (!remote) {
    state.ghTokenTest = { ok: false, message: 'Name a repository the token can read, as owner/repo.' };
    render(token);
    return;
  }
  state.ghTokenTestBusy = true;
  // Cleared BEFORE the request: a stale green under a spinner is a lie for
  // as long as the request takes (onTestKey's rule).
  state.ghTokenTest = null;
  render(token);
  let result;
  try {
    const res = await fetch('/api/config/github-read-token/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote }),
    });
    const data = await readJsonSafely(res);
    result = data && typeof data === 'object'
      ? data
      : { ok: false, message: 'The server returned a response this screen could not read (HTTP ' + res.status + ').' };
  } catch {
    result = { ok: false, message: 'Could not reach The Curator\u2019s own server to run the test.' };
  }
  if (!isCurrentMount(token)) return;
  state.ghTokenTestBusy = false;
  state.ghTokenTest = result;
  render(token);
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
  // A second, independent refusal for the installer path. The `#btn-apply-update`
  // element is never emitted there (renderInstallerUpdateStatus emits an <a>),
  // so this is unreachable through the UI — which is exactly why it is here:
  // the work below POSTs /api/config/update, a packaged build answers that
  // 501, and the user would see "Update failed" with a capability string in it
  // for having clicked something that should not have existed.
  if (v.style !== 'git-pull') return Promise.resolve();
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
function pollForRestart(token, onGiveUp) {
  const started = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - started > 30000) {
      clearInterval(timer);
      // The in-app updater passes its own give-up handler because its banner
      // is mount-INDEPENDENT and must not be gated on `isCurrentMount` — the
      // relaunch can legitimately be running while the user sits on another
      // view. The default arm below is the git flow's, byte-for-byte.
      if (typeof onGiveUp === 'function') { onGiveUp(); return; }
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


// ── The in-app updater: the actions ──────────────────────────────────────
//
// EVERY FUNCTION BELOW IS MOUNT-INDEPENDENT. None of them takes a mount token
// and none of them calls `isCurrentMount` to decide whether to keep working —
// only whether to repaint. That is the whole navigate-away decision, expressed
// in code: the work is the server's, the panel is a view of it, and leaving the
// view stops the drawing and nothing else. See `inAppUpdate`'s declaration for
// the argument and for the honest gap it leaves.

/**
 * Ask the server what the updater is doing. Cheap: in-memory, no lock, no
 * filesystem, no network on the server side.
 *
 * Called once per Settings mount on a packaged install — which is how a FULL
 * PAGE RELOAD mid-download finds its way back to the running job, since
 * `inAppUpdate` died with the page. A browser install never calls it at all.
 */
async function probeInAppUpdate() {
  try {
    const res = await fetch('/api/config/update-progress');
    const data = await res.json();
    if (!data || data.ok !== true) return;
    updaterAttached = data.updaterAttached === true;
    const job = data.job;
    // Adopt the server's job ONLY when this page is not already tracking one.
    // A live stream in this tab is strictly better information than a
    // snapshot, and overwriting it with one would make the ring jump
    // backwards on every re-entry.
    if (!inAppUpdate && job) {
      if (job.state === 'running' || job.state === 'applying') {
        // Running, but NOT streamed to this page — this tab has no reader for
        // it (it was reloaded). Show it, and let the poll below pick up the
        // ending. Deliberately does NOT start a second POST: that would be a
        // second download.
        inAppUpdate = { phase: 'streaming', job, version: job.version || null, failure: null, restartHint: false };
        pollInAppUpdate();
      } else if (job.state === 'staged') {
        inAppUpdate = {
          phase: 'staged', job: null, version: job.version || null, warning: job.warning || null,
          failure: job.error ? { reason: job.reason, error: job.error, hint: job.hint } : null,
          restartHint: false,
        };
      } else if (job.state === 'failed') {
        inAppUpdate = {
          phase: 'install-failed', job: null, version: null,
          failure: { reason: job.reason, error: job.error, hint: job.hint },
          restartHint: false,
        };
      }
    }
    renderIfSettingsMounted();
  } catch { /* the panel simply shows the ordinary check result — not worth an error box */ }
}

/**
 * The re-attached case: this page is watching a download it did not start (it
 * was reloaded mid-flight), so it has no stream. Poll the same read-only
 * endpoint the mount probe uses.
 *
 * 1.5 s, matching the restart poller's order of magnitude. It stops on any
 * terminal state and on any error, so it cannot outlive what it describes.
 */
function pollInAppUpdate() {
  const timer = setInterval(async () => {
    if (!inAppUpdate || inAppUpdate.phase !== 'streaming') { clearInterval(timer); return; }
    try {
      const res = await fetch('/api/config/update-progress', { cache: 'no-store' });
      const data = await res.json();
      const job = data && data.job;
      if (!job) { clearInterval(timer); inAppUpdate = null; renderIfSettingsMounted(); return; }
      if (job.state === 'running' || job.state === 'applying') {
        inAppUpdate.job = job;
      } else if (job.state === 'staged') {
        clearInterval(timer);
        inAppUpdate = { phase: 'staged', job: null, version: job.version || null, warning: job.warning || null, failure: null, restartHint: false };
      } else {
        clearInterval(timer);
        inAppUpdate = {
          phase: 'install-failed', job: null, version: null,
          failure: { reason: job.reason, error: job.error, hint: job.hint }, restartHint: false,
        };
      }
      renderIfSettingsMounted();
    } catch {
      clearInterval(timer);
    }
  }, 1500);
}

/**
 * The button. One confirm, then the whole thing runs to a restart.
 *
 * The dialog is `shared/confirm.js` — the same five-modal set the rest of the
 * app uses, not a sixth shape. Tone is `danger` for the same reason the git
 * flow's is: it ends in the app restarting under the user.
 *
 * WHAT THE DIALOG DELIBERATELY DOES NOT SAY is a download size. Nobody knows it
 * until the server has asked; quoting one here would be a number invented for
 * reassurance, which is the failure this project names as a fact and its
 * absence sharing a presentation. The real size appears the moment it is
 * measured, on the progress line.
 */
function onInstallInApp() {
  const v = classifyUpdate(state.updateCheck, state.version);
  if (v.kind !== 'available' || v.style !== 'download-installer') return Promise.resolve();
  if (updaterAttached !== true) return Promise.resolve();
  return confirmThen({
    title: 'Download and install this update?',
    message: 'v' + v.current + ' → v' + v.latest,
    detail: 'The Curator downloads the new version, checks it arrived complete and unaltered, then restarts ' +
      'into it — with no security warning to click through. Nothing is replaced until that check passes, so ' +
      'a failed download leaves this copy working. Your knowledge base, API keys and sync settings are untouched.',
    confirmLabel: 'Download and install',
    cancelLabel: 'Not now',
    tone: 'danger',
    onConfirm: () => runInAppUpdate(),
  });
}

/**
 * Stream `POST /api/config/update` and, when it reaches `staged`, finish.
 *
 * ── WHY IT AUTO-CONTINUES TO THE RESTART ─────────────────────────────────
 *
 * Because that is what the user asked for at the confirm dialog — "and then
 * the app restarts and that's it" — and because stopping to ask again after
 * the only long part is over is ceremony, not consent.
 *
 * It is safe to do so even if they have wandered off, and the safety is the
 * SERVER'S, not a guess made here: `POST /update/apply` re-checks
 * `hasActiveWrites()` at the moment of the swap. So an ingest started during
 * the download is not truncated — the finish is refused, this lands in the
 * `staged` state, and the panel says the update is downloaded and one button
 * away. That is the entire disagreement between "restart under them" and
 * "leave it hanging", resolved by the one participant that can actually see
 * whether a write is in flight.
 */
async function runInAppUpdate() {
  inAppUpdate = { phase: 'streaming', job: { phase: 'resolving' }, version: null, failure: null, restartHint: false };
  renderIfSettingsMounted();

  let res;
  try {
    res = await fetch('/api/config/update', { method: 'POST' });
  } catch (err) {
    return failInApp({ reason: 'offline', error: 'The Curator couldn’t reach its own server to start the update. Nothing was replaced.' });
  }

  if (!res.ok || !res.body) {
    // Every refusal on this route is plain JSON sent BEFORE any SSE header, so
    // it is readable here in full — the 409s (a write in flight, an update
    // already running) and the 501 (no updater engine attached) all land here
    // with a `reason` and a sentence already written for a person.
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return failInApp({
      reason: (data && data.reason) || 'unknown',
      error: (data && data.error) || ('The update could not start (HTTP ' + res.status + ').'),
      hint: data && data.hint,
      releasesPageUrl: data && data.releasesPageUrl,
    });
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let staged = false;
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
        let payload = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) payload += line.slice(5).trim();
        }
        if (!payload) continue;
        let ev = null;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (type === 'progress') {
          if (inAppUpdate && inAppUpdate.phase === 'streaming') {
            inAppUpdate.job = {
              phase: ev.phase, receivedBytes: ev.receivedBytes,
              totalBytes: ev.totalBytes, percent: ev.percent,
            };
            renderIfSettingsMounted();
          }
        } else if (type === 'staged') {
          staged = true;
          inAppUpdate = { phase: 'staged', job: null, version: ev.version || null, warning: ev.warning || null, failure: null, restartHint: false };
          renderIfSettingsMounted();
        } else if (type === 'error') {
          return failInApp(ev);
        }
      }
    }
  } catch (err) {
    return failInApp({ reason: 'interrupted' });
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }

  // The stream ended with no `staged` and no `error`: the server hung up
  // mid-download. Reported as its own thing rather than left on a ring that
  // will never move again — a progress display frozen forever is the exact
  // "my click didn't register" shape this app has already been reported for.
  if (!staged) {
    return failInApp({ reason: 'interrupted' });
  }
  await finishInAppUpdate();
}

/**
 * Swap the staged bundle in and restart. Also the `#btn-inapp-finish` button's
 * handler, so the manual and the automatic paths are literally the same code.
 */
async function finishInAppUpdate() {
  if (!inAppUpdate || inAppUpdate.phase !== 'staged') return;
  const version = inAppUpdate.version;
  const warning = inAppUpdate.warning || null;
  inAppUpdate = { phase: 'relaunching', job: null, version, warning, failure: null, restartHint: false };
  renderIfSettingsMounted();

  let res = null;
  try {
    res = await fetch('/api/config/update/apply', { method: 'POST' });
  } catch {
    // The process going away mid-request is the SUCCESS case here — the swap
    // happened and the server relaunched under us. `/api/restart` is treated
    // the same way by the git flow, and for the same reason. Fall through to
    // the poller, which is the thing that can actually tell the difference:
    // the app comes back, or it does not and the hint appears.
    pollForRestart(0, () => {
      if (inAppUpdate && inAppUpdate.phase === 'relaunching') {
        inAppUpdate.restartHint = true;
        renderIfSettingsMounted();
      }
    });
    return;
  }

  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    // Back to `staged`, NOT to a dead end: the verified bundle is still on
    // disk, so the honest state is "downloaded, not yet installed" and the
    // button that finishes it is still the right one to offer. The server
    // holds the same view — its own job record goes back to `staged` too.
    inAppUpdate = {
      phase: 'staged', job: null, version, warning,
      failure: {
        reason: (data && data.reason) || 'install-failed',
        error: (data && data.error) || ('The update could not be installed (HTTP ' + res.status + ').'),
        hint: data && data.hint,
        releasesPageUrl: data && data.releasesPageUrl,
      },
      restartHint: false,
    };
    renderIfSettingsMounted();
    return;
  }

  pollForRestart(0, () => {
    if (inAppUpdate && inAppUpdate.phase === 'relaunching') {
      inAppUpdate.restartHint = true;
      renderIfSettingsMounted();
    }
  });
}

/** One place that turns any named failure into the failed panel, so no arm can
 *  invent its own wording or forget the reason code. */
function failInApp(ev) {
  inAppUpdate = {
    phase: 'install-failed', job: null, version: null,
    failure: {
      reason: (ev && ev.reason) || 'unknown',
      error: (ev && ev.error) || 'The update stopped before it finished, and nothing was replaced — this copy of The Curator still works.',
      hint: ev && ev.hint,
      releasesPageUrl: ev && ev.releasesPageUrl,
    },
    restartHint: false,
  };
  renderIfSettingsMounted();
}

/** "Try again" on the failed panel. Clears the failure and re-runs from the
 *  top — no second confirm, because the user has already agreed to this exact
 *  operation and the button they just pressed says what it does. */
function onRetryInApp() {
  inAppUpdate = null;
  return runInAppUpdate();
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

/**
 * Record the System check's run line (v3.67.0) from a /api/diagnostics/quick
 * answer's `liveCheck.runsOn`. `null` means "the server sent none" (an older
 * backend), which is distinct from `undefined`, "not read yet". The HTML and
 * the button's attributes are composed HERE, outside renderGeneral, because
 * that renderer is lifted by two suites (see its button's comment).
 */
/**
 * v3.72.1 (truth audit F8): a key save, a disconnect, an active-provider
 * switch or a build-model pick changes what the System check would report and
 * which model the Verify confirm names. Called on the success path of each, so
 * the next confirm re-reads and the old result rows say they predate it.
 */
function markSystemCheckStale() {
  state.liveRunsOn = undefined;
  state.liveRunsOnHtml = '';
  state.liveVerifyAttrs = '';
  if (state.quick && !state.quick.error) state.quick = Object.assign({}, state.quick, { stale: true });
}

function setLiveRunsOn(data) {
  const ro = (data && data.liveCheck && data.liveCheck.runsOn && typeof data.liveCheck.runsOn === 'object')
    ? data.liveCheck.runsOn : null;
  state.liveRunsOn = ro;
  state.liveRunsOnHtml = ro ? renderRunsOn(ro, { inSettings: true, id: 'settings-verify-runs-on' }) : '';
  state.liveVerifyAttrs = ro ? aiActionDisabledAttrs(ro, 'settings-verify-runs-on') : '';
}

/**
 * The Verify button. Opens the confirm at once, and — the first time — reads
 * the run line from the free, local /api/diagnostics/quick (the same answer a
 * system check gets), so the confirm states the model and the cost before
 * anything is spent. The system check's own results are NOT shown by this
 * read: only its `liveCheck` is kept.
 */
async function openLiveConfirm(token) {
  state.liveConfirmOpen = true;
  state.live = null;
  // v3.72.1 (truth audit F8): ALWAYS re-read. The line was fetched once per
  // mount and Settings stays one mount across sections, so after a build-model
  // switch in Providers the confirm named the OLD model and price. The read is
  // free and local; `undefined` renders the not-yet-read state meanwhile.
  state.liveRunsOn = undefined;
  state.liveRunsOnHtml = '';
  state.liveVerifyAttrs = '';
  render(token);
  try {
    const res = await fetch('/api/diagnostics/quick');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    setLiveRunsOn(data);
  } catch {
    if (!isCurrentMount(token)) return;
    setLiveRunsOn(null);
  }
  render(token);
}

async function onRunQuickCheck(token) {
  state.quickLoading = true;
  render(token);
  try {
    const res = await fetch('/api/diagnostics/quick');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    state.quick = data.error ? { error: data.error } : Object.assign({}, data, { checkedAtMs: Date.now(), stale: false });
    if (!data.error) setLiveRunsOn(data);
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
    markSystemCheckStale();
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
    markSystemCheckStale();
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
    markSystemCheckStale();
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
    // SECOND LAYER, not the first. renderModelLanes now keeps the fold open and
    // renderModelOption forces the row open, so the panel is in the flow where
    // the user clicked; this only covers a row pressed near the bottom edge,
    // where a ~290px panel would still push Start past the fold. It reveals the
    // panel's TOP rather than its buttons: a confirm is read from the first
    // line, and revealInMain moves nothing when it already fits.
    revealInMain(QUALIFY_CONFIRM_ID);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.qualify = { modelId, phase: 'error', runs: [], error: (err && err.message) || 'Could not work out the cost.' };
    render(token);
  }
}

/** Close the panel without spending anything. */
function onQualifyDismiss(token) {
  stopQualifyClock();
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
  stopQualifyClock();
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
/**
 * Stop the elapsed clock.
 *
 * ONE PLACE, called from every exit — settled, stopped, errored, abandoned —
 * because an interval whose clear is written at each call site is an interval
 * that survives the call site somebody forgets. It is also cleared by the tick
 * ITSELF when the mount has moved on, so a user who navigates away mid-probe
 * cannot leave a timer re-rendering a section that is gone.
 */
function stopQualifyClock() {
  if (state.qualifyTickId != null) {
    try { clearInterval(state.qualifyTickId); } catch { /* already gone */ }
    state.qualifyTickId = null;
  }
}

async function onQualifyGo(modelId, token) {
  const controller = new AbortController();
  state.qualifyAbort = controller;
  // `startedAt` is stamped HERE — before the request, not on the first frame —
  // because the wait this clock exists to explain BEGINS here: the slowest
  // measured call is 382 s, and every second of it was previously spent with
  // the panel reading "Run 0 of 9". See renderQualifyPanel's running arm.
  state.qualify = Object.assign({}, state.qualify, {
    modelId, phase: 'running', runs: [], error: null,
    startedAt: Date.now(), total: null, aborted: null, stoppedAfter: null,
  });
  stopQualifyClock();
  // ── THE CLOCK WRITES ONE NODE'S TEXT. IT DOES NOT RE-RENDER. ─────────────
  //
  // THIS TICK USED TO CALL `render(token)`, once a second, for as long as a
  // measurement ran — which on the slowest measured model is 382 s per call
  // and nine calls. On Providers & keys a render rebuilds and re-parses the
  // whole section: 251 KB of HTML and 3,479 nodes, measured, ~8 ms of parse
  // and re-wiring per tick. The cost is not the milliseconds. It is that every
  // node on the screen is destroyed and recreated once a second underneath
  // somebody who is watching a run: v3.53.1 is the release that had to add a
  // capture/restore for open disclosures and ⓘ panels precisely BECAUSE of
  // this tick, and its own KNOWN AND UNFIXED note records that a close lost to
  // that race still flickers for one render. v3.54.0 then wrote the rule down
  // — a clock writes `textContent` to a targeted node and never calls
  // render() — and this was the one clock in this file still breaking it.
  //
  // WHAT THE USER READS IS UNCHANGED. renderQualifyPanel's running arm emits
  // the same sentence it always did with a <span data-qualify-clock="elapsed">
  // around the clock clause, and this writes that span's text with the same
  // `formatDuration(Date.now() - startedAt)` the renderer uses. Everything
  // else on that panel — the run counter, the outcome strip, a failed run's
  // message — changes only when a FRAME ARRIVES, and the stream handler
  // already renders on each one.
  //
  // THE SPAN CAN BE ABSENT, and that is not a failure to repair: it is absent
  // exactly when the panel is not on screen (its row filtered out of the
  // table, the shelf closed), i.e. when there is no clock for anyone to read.
  // The next real render paints the correct elapsed value.
  state.qualifyTickId = setInterval(() => {
    // The mount check lives INSIDE the tick, so the timer stops itself rather
    // than relying on a teardown that this view does not have.
    if (!isCurrentMount(token) || !state.qualify || state.qualify.phase !== 'running') {
      stopQualifyClock();
      return;
    }
    if (typeof document === 'undefined') return;
    const el = document.querySelector('[data-qualify-clock="elapsed"]');
    if (!el || !Number.isFinite(state.qualify.startedAt)) return;
    el.textContent = ' ' + formatDuration(Date.now() - state.qualify.startedAt) + ' so far';
  }, 1000);
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
          if (type === 'start') {
            // ── THE FRAME THE CLIENT USED TO THROW AWAY ────────────────
            // It has always carried `{modelId, domain, runs, promptChars,
            // sourceName, minRunsToQualify}` and nothing read it, so the panel
            // could not name the run in flight until the FIRST one settled —
            // up to 382 s of "Run 0 of 9". Only `runs` is stored, because only
            // `runs` says something the confirm did not already say, and
            // storing a field nothing renders is the dead-data shape this repo
            // keeps re-finding.
            state.qualify = Object.assign({}, state.qualify, {
              total: Number.isFinite(ev.runs) && ev.runs > 0 ? ev.runs : null,
              // The adapter's per-call ceiling. Worth one clause on the waiting
              // line and nothing more: it bounds how long "waiting for the
              // model" can possibly last, which is the one thing a user staring
              // at an unmoving panel actually wants to know. Stored only
              // because it is RENDERED — `deadlineMs`, `promptChars` and
              // `sourceName` are on the same frame and are not, because the
              // confirm panel already said them.
              callTimeoutMs: Number.isFinite(ev.callTimeoutMs) && ev.callTimeoutMs > 0
                ? ev.callTimeoutMs : null,
            });
            render(token);
          } else if (type === 'run') {
            state.qualify = Object.assign({}, state.qualify, {
              runs: (state.qualify && state.qualify.runs ? state.qualify.runs : []).concat([ev]),
            });
            render(token);
          } else if (type === 'done') {
            // ── THE SERVER GAVE UP, AND SAYS WHY ───────────────────────
            // `aborted` names the circuit breaker that fired. Read off the
            // frame FIRST and off the record second: the contract puts it on
            // the frame, and `record.aborted` has carried the same value since
            // the probe shipped — so reading both means this works against the
            // build that sends it and the build that does not, and cannot
            // disagree with itself when both are present.
            const aborted = (typeof ev.aborted === 'string' && ev.aborted)
              ? ev.aborted
              : ((ev.record && typeof ev.record.aborted === 'string') ? ev.record.aborted : null);
            if (aborted) {
              stopQualifyClock();
              state.qualify = Object.assign({}, state.qualify, {
                phase: 'stopped',
                aborted,
                stoppedAfter: (state.qualify && state.qualify.runs) ? state.qualify.runs.length : 0,
              });
              render(token);
            }
            // A `done` with no abort is the ordinary end of a run and the
            // `stored` frame is one line behind it; rendering anything here
            // would be a state the user sees for a few milliseconds.
          } else if (type === 'stored') {
            state.qualifyAbort = null;
            stopQualifyClock();
            // ── THE RUN ENDED, AND THE SCREEN NOW SAYS SO ──────────────────
            // This was `state.qualify = null`, so nine runs and up to 57
            // minutes ended with the panel simply VANISHING: the row's lane
            // cell changed to "Use for building" somewhere in a 200-row table
            // and nothing anywhere said the thing the user had been watching
            // was finished. The panel stays, in a `done` phase, until the user
            // dismisses it — see renderQualifyPanel's done arm.
            //
            // `qualifies` is read off the FRAME, which the route recomputes
            // through `isLocallyQualified` — the same gate the pin route uses —
            // so the button this panel offers cannot disagree with the server
            // about whether the pin will be accepted.
            state.qualify = Object.assign({}, state.qualify, {
              phase: 'done',
              record: (ev.record && typeof ev.record === 'object') ? ev.record : null,
              stored: (ev.stored && typeof ev.stored === 'object') ? ev.stored : null,
              qualifies: ev.qualifies === true,
              error: null,
            });
            // Refetch rather than trusting the stream's echo: `loadKeys` picks
            // up `qualifications` AND `models[provider]`, i.e. what llm.js will
            // now actually resolve. Reporting the request instead of the
            // outcome is this repo's named M3b shape.
            await loadKeys(token);
            return;
          } else if (type === 'error') {
            state.qualifyAbort = null;
            stopQualifyClock();
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
    stopQualifyClock();
    // Guarded on `running` SPECIFICALLY, and that now matters: a `done` frame
    // carrying an abort has already moved the panel to `stopped` and said WHY,
    // so replacing it here with the generic "stopped before it finished" would
    // overwrite the real reason with a vaguer one.
    if (state.qualify && state.qualify.phase === 'running') {
      state.qualify = { modelId, phase: 'error', runs: [], error: 'The test stopped before it finished. Nothing was recorded.' };
      render(token);
    }
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.qualifyAbort = null;
    stopQualifyClock();
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
 * ── CHOOSING THE ONE MODEL THAT BUILDS THE WIKI ────────────────────────────
 *
 * `POST /api/config/api-keys/build-model` names PROVIDER AND MODEL together and
 * applies both, so — unlike `onPickModel`, which this does NOT replace — it
 * cannot produce a pin that governs nothing. That is the whole reason it exists
 * and the whole reason the build list posts here.
 *
 * THE NOT-OPTIMISTIC RULE IS IDENTICAL, and it matters more here, because this
 * request can also move the ACTIVE PROVIDER: nothing is written into
 * `state.keys`, the rendered choice moves only after `loadKeys()` has re-read
 * the server's own answer, and that answer is not necessarily the id just sent
 * — the route reports `inert: true` when the pin landed and the provider did
 * not move. A picker claiming a model is in force while the wire still says
 * otherwise is this repo's named dead-data shape on the one screen where it
 * costs money.
 *
 * `onPickModel` is left alone and still owns the CLEAR path ("Follow the app
 * default"), because the build-model route has no clearing arm by design —
 * "clear the one build model" has no meaning, since something must build the
 * wiki.
 */
async function onPickBuildModel(provider, modelId, token) {
  // Refuse rather than guess, exactly as onPickModel and onSaveKey do.
  // Null-prototype: on a plain literal `KNOWN['constructor']` is truthy, so an
  // inherited name would skip this refusal and POST under a provider the server
  // does not know.
  const KNOWN = Object.assign(Object.create(null), {
    gemini: true, anthropic: true, openrouter: true,
  });
  const model = typeof modelId === 'string' ? modelId : '';
  if (!KNOWN[provider] || !model) {
    state.modelPickError = Object.assign({}, state.modelPickError, {
      build: 'Cannot choose a model for an unknown provider.',
    });
    // No row owns this one — the click never came from a rendered candidate —
    // so renderBuildBlock's block-level fallback is the only place it can go.
    state.modelPickErrorAt = '';
    render(token);
    revealInMain(BUILD_PICK_ERROR_ID);
    return;
  }
  // Same key shape as onPickModel's, so renderModelOption's `isPending` test
  // needs no second form to understand.
  state.modelPickBusy = provider + '::' + model;
  state.modelPickError = Object.assign({}, state.modelPickError, { build: '' });
  state.modelPickErrorAt = '';
  render(token);
  try {
    const res = await fetch('/api/config/api-keys/build-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    if (!res.ok) {
      // Read the body defensively: a 409 from a proxy, or any non-JSON
      // response, must still produce a legible refusal rather than an
      // "Unexpected token '<'" — the class this repo has fixed twice.
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      const message = modelPickErrorMessage(res.status, data);
      if (!isCurrentMount(token)) return;
      state.modelPickBusy = null;
      state.modelPickError = Object.assign({}, state.modelPickError, { build: message });
      state.modelPickErrorAt = provider + '::' + model;
      render(token);
      revealPickRefusal(provider, model);
      return;
    }
    // The route reports the OUTCOME rather than echoing the request, so an
    // `inert: true` body means the pin landed and the provider did not move —
    // not an error, but not what was asked for either, and silence would be the
    // dead-data shape. Read defensively: a body we cannot parse is not a claim
    // that anything went wrong.
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    markSystemCheckStale();
    if (!isCurrentMount(token)) return;
    state.modelPickBusy = null;
    const inert = !!(body && body.inert === true);
    state.modelPickError = Object.assign({}, state.modelPickError, {
      build: inert
        ? 'Saved, but it is not building your wiki yet — The Curator could not switch to that ' +
          'provider. Check that its key is still connected below, then try again.'
        : '',
    });
    // An inert save is a statement ABOUT THAT ROW, so it is anchored to it and
    // revealed the same way a refusal is. A clean success owns no row.
    state.modelPickErrorAt = inert ? provider + '::' + model : '';
    // The ONLY place the rendered choice moves. Refetching (rather than
    // trusting the POST's echo) also picks up what llm.js will now actually
    // resolve, which the headline claims to show.
    await loadKeys(token);
    if (inert) revealPickRefusal(provider, model);
  } catch (err) {
    if (isCurrentMount(token)) {
      state.modelPickBusy = null;
      state.modelPickError = Object.assign({}, state.modelPickError, {
        build: modelPickErrorMessage(0, { error: err && err.message }),
      });
      state.modelPickErrorAt = provider + '::' + model;
      render(token);
      revealPickRefusal(provider, model);
    }
  }
}

/**
 * Put a build-pick refusal in front of the user, and the cursor back on the
 * control they pressed.
 *
 * THE SECOND LAYER, NOT THE FIRST. The message is already rendered INSIDE the
 * row (see renderModelOption), so it is adjacent to the button by construction;
 * this only covers the case where that row sits at the very bottom edge and the
 * message lands a few pixels past it, plus renderBuildBlock's block-level
 * fallback for a refusal no row owns. `revealInMain` moves nothing when the
 * element is already fully visible, so the common case is a no-op and the page
 * does not jolt.
 *
 * FOCUS IS RESTORED EXPLICITLY, and preserveMainScroll cannot do it for us: the
 * first of this handler's two renders DISABLES the button, so focus has already
 * fallen to <body> before the refusal arrives, and there is nothing left for a
 * by-id restore to capture. `preventScroll` because the position was just
 * decided on the line above — letting the browser scroll the button into view
 * would undo it.
 *
 * Every step is optional and independently guarded: a row whose control is not
 * a button (an inert save re-badges it "Building your wiki") simply keeps focus
 * where it is, rather than throwing.
 */
function revealPickRefusal(provider, model) {
  revealInMain(BUILD_PICK_ERROR_ID);
  if (typeof document === 'undefined') return;
  const btn = document.getElementById(buildPickButtonId(provider, model));
  if (btn && typeof btn.focus === 'function' && !btn.disabled) {
    try { btn.focus({ preventScroll: true }); } catch { /* not focusable in this state */ }
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

/**
 * ── "IS MY MODEL STILL THERE?" — POST /api/config/models/check ─────────────
 *
 * A READ that spends nothing: it asks the provider for its own list and reports
 * whether the model in force is on it. It writes no config and no wiki page, so
 * — like `Test this key` — it is NOT gated on the cross-view write lock. A
 * read-only diagnostic disabled during a long ingest is missing at the exact
 * moment somebody is asking whether the model is the problem.
 *
 * THE VERDICT IS STORED AS SENT, FIELD BY FIELD, WITH NO DEFAULTING.
 * `liveMissing` in particular is stored exactly as it arrives, including
 * `undefined`: the renderer distinguishes three values, and a `|| false` here
 * would collapse "we could not tell" into "it is listed" — the reassuring
 * direction, and therefore the dangerous one.
 *
 * `KNOWN` is null-prototype for the reason every other refuse-rather-than-guess
 * table in this file is: on a plain literal `KNOWN['constructor']` is truthy, so
 * an inherited name would skip the refusal and POST a provider the server does
 * not know.
 */
async function onCheckModels(provider, token) {
  const KNOWN = Object.create(null);
  for (const p of PROVIDER_ROWS) if (p.available) KNOWN[p.id] = true;
  if (!KNOWN[provider]) {
    state.modelCheckError = Object.assign({}, state.modelCheckError, {
      [provider]: 'that provider is not one The Curator can ask.',
    });
    render(token);
    return;
  }
  state.modelCheckBusy = provider;
  // Clear THIS provider's stale refusal BEFORE the request: a refusal from a
  // previous attempt sitting beside a spinner reads as the outcome of the
  // attempt now running (v3.6.0's finding, applied to a new control).
  state.modelCheckError = Object.assign({}, state.modelCheckError, { [provider]: '' });
  render(token);
  try {
    const res = await fetch('/api/config/models/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    // Read the body defensively and never inside a throw — a proxy's HTML 502
    // must still produce a legible sentence rather than "Unexpected token '<'".
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!isCurrentMount(token)) return;
    state.modelCheckBusy = null;
    if (!res.ok) {
      state.modelCheckError = Object.assign({}, state.modelCheckError, {
        [provider]: (data && typeof data.error === 'string' && data.error)
          ? data.error
          : ('the request was refused (HTTP ' + res.status + ').'),
      });
      render(token);
      return;
    }
    state.modelCheck = Object.assign({}, state.modelCheck, {
      [provider]: (data && typeof data === 'object') ? {
        provider: data.provider,
        checkedAt: data.checkedAt,
        source: data.source,
        chosen: data.chosen,
        liveMissing: data.liveMissing,
        listedCount: data.listedCount,
        error: data.error,
      } : {},
    });
    render(token);
    // Refetch, because a check that finds the model missing is exactly the
    // event the banner above block 2 exists for — and that banner reads
    // `build.liveMissing` off the payload, not off this verdict. Reporting the
    // REQUEST instead of the resolved state is this repo's named M3b shape.
    await loadKeys(token);
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.modelCheckBusy = null;
    state.modelCheckError = Object.assign({}, state.modelCheckError, {
      [provider]: (err && err.message) ? err.message : 'the request did not complete.',
    });
    render(token);
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

/**
 * "Test all N tools" — POST /api/mcp/exercise, then repaint the map.
 *
 * ── WHY THIS DOES NOT CALL `render()` ──────────────────────────────────────
 * It paints through `renderToolMapBody` twice (once for the busy state, once
 * for the outcome) and lets `refreshMcpUsage` do the third. A `render()` here
 * would shut every ⓘ and every `<details>` on the section — including the
 * privacy fold this block's own copy invites the user to open — which is
 * v3.53.1 exactly.
 *
 * ── THE ORDER MATTERS ─────────────────────────────────────────────────────
 * The run's lines are already on disk by the time the response lands, so the
 * usage refresh AFTER it is what lights the tiles; it is forced rather than
 * left to the 30 s tick, because a user who just pressed a button will not
 * wait thirty seconds to see whether it did anything. The signature has moved
 * (every tool's `lastUsedAt` and `lastVia` just changed), so that refresh
 * repaints the body once, and the outcome held in `state.mcpExercise` is
 * re-rendered with it.
 */
async function onMcpExercise(token) {
  if (state.mcpExerciseBusy) return;
  state.mcpExerciseBusy = true;
  state.mcpExerciseError = null;
  state.mcpExercise = null;
  paintToolMapBody();
  try {
    const res = await fetch('/api/mcp/exercise', { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!isCurrentMount(token)) return;
    if (!res.ok || !data) {
      state.mcpExerciseError = (data && data.error)
        || 'The self-test run did not complete. The bridge may not be reachable from here.';
    } else if (!Array.isArray(data.results)) {
      state.mcpExerciseError = data.error || 'The self-test run returned nothing to show.';
    } else {
      state.mcpExercise = data;
      // `missing` is the driver's own honesty field: a tool in the catalogue
      // the run has no case for. It must be empty, and a suite reds when it is
      // not — but if one ever reaches a user, the user is told rather than
      // shown "23 of 24" with no explanation of the twenty-fourth.
      if (Array.isArray(data.missing) && data.missing.length) {
        state.mcpExerciseError = 'This build has no test case for: ' + data.missing.join(', ');
      }
    }
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.mcpExerciseError = err.message || 'The self-test run did not complete.';
  } finally {
    if (isCurrentMount(token)) {
      state.mcpExerciseBusy = false;
      paintToolMapBody();
      // The run just moved every row in the log, so this repaints once more
      // with the real readings and the new markers.
      refreshMcpUsage(token).catch(() => {});
    }
  }
}

/** Repaint block ③'s body from state, and nothing else. The shared half of
 *  the revalidate's DOM write, so a run and a tick cannot disagree about which
 *  element is replaced or about re-binding the control inside it. */
function paintToolMapBody() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const body = document.querySelector(TOOL_MAP_BODY_SEL);
  if (!body) return;
  body.innerHTML = renderToolMapBody();
  wireExerciseControl(myMountToken);
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

/**
 * Menu bar — record the mode.
 *
 * THE STATE ALWAYS COMES BACK FROM THE SERVER, never from the button that was
 * clicked. The server is the only thing that knows what is in the file, and
 * `setBackgroundMode()` REFUSES an unrecognised value rather than coercing it
 * — so optimistically marking the clicked button active would be exactly how
 * this screen comes to assert something false about the user's own choice.
 * On both the success and the refusal path the body carries the mode still in
 * force, and that is what gets rendered.
 */
async function onSetBackgroundMode(mode, token) {
  const cfg = state.config;
  if (!cfg || cfg.backgroundMode === mode) return;   // already there — nothing to save
  state.backgroundModeSaving = true;
  state.backgroundModeError = null;
  render(token);
  try {
    const res = await fetch('/api/config/background-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backgroundMode: mode }),
    });
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    // Present on BOTH the 200 and the 400, deliberately (see the route).
    if (state.config && typeof data.backgroundMode === 'string') {
      state.config.backgroundMode = data.backgroundMode;
      if (Array.isArray(data.backgroundModes)) state.config.backgroundModes = data.backgroundModes;
    }
    if (!res.ok) state.backgroundModeError = data.error || 'Could not change the menu bar setting.';
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.backgroundModeError = err.message || 'Could not change the menu bar setting.';
  }
  if (!isCurrentMount(token)) return;
  state.backgroundModeSaving = false;
  render(token);
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
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!isCurrentMount(token)) return;
    if (res.ok && data && Object.hasOwn(data, 'defaultDomain')) {
      if (state.defaultDomainInfo) state.defaultDomainInfo.defaultDomain = data.defaultDomain;
      state.defaultDomainError = null;
    } else {
      // v3.72.1 (truth audit F11): this wrote `data.defaultDomain` — undefined
      // on a 400 — into the selector, which then read "unset" while the server
      // kept the previous value. Now the old value stays, the refusal is shown,
      // and the domain list is re-read (the likely cause is a domain renamed or
      // deleted since the list loaded).
      state.defaultDomainError = (data && typeof data.error === 'string' && data.error)
        ? data.error : 'The default domain was not saved.';
      try {
        const again = await fetch('/api/config/default-domain');
        const dd = again.ok ? await again.json() : null;
        if (isCurrentMount(token) && dd && typeof dd === 'object') state.defaultDomainInfo = dd;
      } catch { /* keep what is on screen */ }
    }
  } catch (err) {
    if (isCurrentMount(token)) state.defaultDomainError = err.message || 'The default domain was not saved.';
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
