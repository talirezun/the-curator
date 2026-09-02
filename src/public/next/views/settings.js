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
} from '../app.js';
// Overlay, not a view — same relationship views/shared.js has with
// views/shared-brain-wizard.js. It is opened from the MCP section's CTA and
// closed unconditionally by this view's teardown, so navigating away can
// never leave it mounted behind the next view.
import { renderListboxHtml, mountListbox, closeAllListboxes } from '../shared/listbox.js';
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
// The ONE text system in /next (shared/text.js). This view was the largest
// carrier of the defect renderViewHeader removes: ~3,620 characters of static
// prose, a paragraph of it directly under the <h1> of four of the five
// sections. The header component has no parameter that can put it back.
import { renderViewHeader } from '../shared/text.js';
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

const SETTINGS_SECTIONS = [
  ['general',   'General',              'Appearance, updates'],
  ['providers', 'Providers & keys',     'Gemini, Anthropic, OpenRouter, local'],
  ['mcp',       'MCP bridge',           'My Curator, default write domain'],
  ['health',    'Health & scan limits', 'Cost ceilings, candidate pairs'],
  ['storage',   'Knowledge base',       'Vault folder, Obsidian'],
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
 * `general` is deliberately absent, so that section renders NO mark. Its copy
 * is per-control hint text sitting beside the control it describes, which is
 * in-context labelling and not a view description.
 *
 * NOTHING THAT WARNS OR COSTS BELONGS HERE. The cross-write banner, the
 * fallback-model banner (a silent change to what the user is billed) and every
 * inline error stay in the body, unfolded, exactly where they were.
 */
const SECTION_INFO = {
  providers: {
    html: true,
    // UPDATED with the four-block page: the old text said "there are two jobs
    // here", which was true of the previous layout and is now one number short
    // of what the reader sees numbered down the page in front of them.
    text: 'Four steps, in order. <strong>Connect a provider</strong>, then choose the <strong>one '
        + 'model that builds your wiki</strong> — ingest, Health scans and Compile all share it, '
        + 'and it has to be one somebody has measured doing that job. <strong>Chat</strong> can '
        + 'use anything you have connected and you pick it per message, in the composer. The last '
        + 'block is the whole catalogue, for looking things up.',
  },
  mcp: {
    html: true,
    text: 'Exposes your graph to any MCP client — twenty tools: fifteen that read your wiki, '
        + 'and five that write to it (compiling a conversation into pages, saving an agent\u2019s '
        + 'working state, and fixing health issues) without leaving Claude. Write tools refuse '
        + 'on <code class="mono">shared-*</code> mirrors by design. The Curator does not need '
        + 'to be running: the bridge is a separate process the client launches on demand.',
  },
  health: {
    text: 'Cost ceilings for the AI scans that run from a domain\u2019s health panel. A scan '
        + 'refuses to start when its estimate exceeds the ceiling — raise it if a scan will '
        + 'not run on a large wiki.',
  },
  storage: {
    html: true,
    text: 'Every domain is a folder of plain markdown here. This folder is also your Obsidian '
        + 'vault — open it with <em>Open folder as vault</em>.',
  },
};

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
    // NOTE: `config` is shared with General — GET /api/config carries the
    // domains path AND `backgroundMode`/`backgroundModes`. One endpoint, one
    // cache, so the two sections cannot render different values for it.
    config: null,            // { domainsPath, domainsPathSource, backgroundMode, backgroundModes }
    configError: null,
    pickingFolder: false,
    pathCopyFeedback: null,

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
    loadGate = createLoadingGate({
      onChange: () => { if (isCurrentMount(mountToken)) render(mountToken); },
    });
    render(mountToken);
    loadVersion(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));       // cheap, always shown in the sidebar footer
    ensureSectionData(SETTINGS_SECTIONS[0][0], mountToken).catch((err) => reportAsyncMountFailure(mountToken, err)); // default section — prefetch immediately

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

// ── THE INFO MARK, USED OUTSIDE A VIEW HEADER ───────────────────────────
//
// THE DEFECT THIS REMOVES. This app carries explanatory strings that exist
// ONLY in a `title=` on a NON-FOCUSABLE <span>. That is hover-only: a
// keyboard user never reaches it, and on touch there is no hover at all, so
// the information does not exist. v3.20.0 counted 11 such strings and left
// them; v3.22.0 built the fix for view headers and recorded the rest as
// still open. This is that fix, applied to two of them.
//
// IT IS THE SHARED COMPONENT'S CONTRACT, NOT A SECOND PATTERN. shared/
// text.js installs ONE delegated document listener at module scope, and that
// listener is keyed on `[data-tx-info]` + getElementById — it is not coupled
// to renderViewHeader in any way. So emitting the same two elements here
// inherits, for free and with nothing to bind per view: toggle on click,
// Escape closes AND returns focus to the button, outside-click dismisses,
// click-inside does not, one panel open at a time. `.tx-vh-info` and
// `.tx-vh-panel` are likewise unscoped in text.css, so no stylesheet changes.
// settings.js already imports renderViewHeader from that module, so the
// listener is guaranteed installed before any of this renders.
//
// WHY NOT ADD THIS TO shared/text.js. It belongs there and should move there.
// It is local today because that file is being edited concurrently by another
// workstream converting the header sites in the other views, and a shared
// module is the worst place to take a merge conflict. The duplication is ONE
// glyph constant, and the suite pins it byte-identical to text.js's INFO_GLYPH
// so the two cannot drift while they are apart.
//
// THE BUTTON KEEPS ITS OWN `title=`. That is not the defect: it is a real
// <button>, so it is focusable, and its accessible name comes from aria-label.
// The tooltip is a mouse-only convenience ON TOP OF a keyboard-reachable
// control, which is the opposite of a tooltip that IS the only carrier.
//
// WHAT MUST NEVER GO IN `info`: warnings, costs, spend figures,
// irreversibility. v3.16.1's rule — a warning behind a click is not a warning.
// Everything routed through here is neutral explanation of a visible label.
const TX_INFO_GLYPH =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';

/**
 * @param {string} id     stable DOM id for the panel (the button gets id + '-btn')
 * @param {string} label  accessible name, e.g. 'About the build lane'
 * @param {string} info   the prose that used to live in a title=
 * @returns {{btn: string, panel: string}} two fragments; the caller places each
 *   where its own layout wants them, because a panel is a block and the mark
 *   is inline. They are only ever emitted together.
 */
function infoMark(id, label, info) {
  const text = typeof info === 'string' ? info.trim() : '';
  if (!id || !text) return { btn: '', panel: '' };
  const name = label || 'More information';
  return {
    btn:
      '<button type="button" class="tx-vh-info" id="' + escapeHtml(id) + '-btn"' +
        ' data-tx-info="' + escapeHtml(id) + '"' +
        ' aria-expanded="false" aria-controls="' + escapeHtml(id) + '"' +
        ' aria-label="' + escapeHtml(name) + '" title="' + escapeHtml(name) + '">' +
        TX_INFO_GLYPH +
      '</button>',
    panel:
      '<div class="tx-vh-panel" id="' + escapeHtml(id) + '" role="group"' +
        ' aria-label="' + escapeHtml(name) + '" hidden>' + escapeHtml(text) + '</div>',
  };
}

/**
 * The escape hatch, behind the Software-update info mark.
 *
 * ── EVERY SENTENCE HERE WAS RUN BEFORE IT WAS WRITTEN ──────────────────────
 * This project has a recorded history of shipping revert promises nobody
 * checked: v3.9.1 found "anything can be reverted from the Sync tab" at EIGHT
 * sites for a feature that has never existed, and v3.24.0 cut a "so nothing is
 * lost" line that was false twice over. So each clause below maps to something
 * measured against a clone made the way install.sh makes one
 * (`git clone --depth 1`):
 *
 *   "updating only moves forward"   — updateHandler runs fetch + reset --hard
 *                                     and nothing else; no route in this app
 *                                     exposes a revert.
 *   "the tags are not on disk"      — that clone has 1 commit and 0 tags, and
 *                                     `git checkout <tag>` fails with
 *                                     "pathspec did not match". `git fetch
 *                                     origin main` does NOT deepen it or bring
 *                                     tags, so this step is REQUIRED, not
 *                                     belt-and-braces.
 *   the two commands                — `git fetch --depth 1 origin tag X` then
 *                                     `git checkout X` landed the real
 *                                     historical tree (package.json version
 *                                     matched the tag).
 *   "your data is untouched"        — domains/*, .curator-config.json and
 *                                     .sync-config.json are all in .gitignore,
 *                                     so neither command can reach them.
 *   "checking again brings you back"— from that detached HEAD, the app's OWN
 *                                     two update commands returned the tree to
 *                                     the published version.
 *
 * ── WHY NO VERSION NUMBER APPEARS IN THIS STRING ───────────────────────────
 * Not every release is tagged. When this was written the newest tag on origin
 * was FOUR releases behind the running version, so "go back to the previous
 * version" would have been simply false, and any example tag baked in here
 * goes stale the moment one is pushed. The GitHub tag list is named as the
 * authority instead, which cannot rot.
 */
const UPDATE_RECOVERY_INFO =
  'Updating only moves forward — it replaces this copy with the published version, and there is no ' +
  'in-app way to undo a release. Going back is a Terminal step and it does work. The installer clones ' +
  'with --depth 1, so the version tags are not on disk yet: from the app folder (~/the-curator by ' +
  'default) run "git fetch --depth 1 origin tag VERSION", then "git checkout VERSION", then ' +
  '"npm install", where VERSION is a tag name from github.com/talirezun/the-curator/tags. That page is ' +
  'the authority on what can be recovered — not every build is tagged, so the newest tag can be ' +
  'several releases behind this copy. Your knowledge base, API keys and sync settings are ignored by ' +
  'git and are not touched. Checking for updates again puts this copy back on the published version.';

/**
 * The same panel for a packaged install, where every sentence above is false:
 * there is no app folder, no checkout, and `git` is not how this copy got here.
 *
 * IT PROMISES NOTHING IT CANNOT SHOW. This project has a recorded history of
 * revert copy describing a path that does not exist — v3.9.1 found "anything
 * can be reverted from the Sync tab" at eight sites for a feature that has
 * never shipped. So this does NOT say "you can go back to the previous
 * version": at the time of writing exactly ONE release carries an installer,
 * so there is nothing older to reinstall. It says how to find out, which stays
 * true whether that list has one entry or twenty.
 */
const UPDATE_RECOVERY_INFO_INSTALLER =
  'This copy was installed from a downloaded file, so The Curator never replaces its own program ' +
  'files — updating means downloading the new installer and running it, and it replaces this copy in ' +
  'place. Going back means installing an older build the same way, and only releases that actually ' +
  'carry a download can be reinstalled: check github.com/talirezun/the-curator/releases to see which ' +
  'ones do before relying on it. Your knowledge base, API keys and sync settings are stored outside ' +
  'the app and are untouched by installing, reinstalling or deleting it.';

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

async function ensureSectionData(section, token) {
  let load = null;
  if (section === 'providers' && state.keys === null) load = loadKeys;
  else if (section === 'mcp' && state.mcp === null) load = loadMcp;
  else if (section === 'health' && state.aiHealth === null) load = loadAiHealth;
  // General reads the SAME `GET /api/config` Knowledge base does — one
  // endpoint, one cached `state.config`, so entering one section warms the
  // other and neither can render a value the other has already moved past.
  else if (section === 'storage' && state.config === null) load = loadConfig;
  else if (section === 'general' && state.config === null) load = loadConfig;
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
  // See pendingListboxes. Cleared BEFORE the section body is built, because
  // building it is what fills the array.
  pendingListboxes.length = 0;
  const title = SECTION_TITLES[state.section] || 'Settings';
  let body;
  if (state.section === 'general') body = renderGeneral();
  else if (state.section === 'providers') body = renderProviders();
  else if (state.section === 'mcp') body = renderMcp();
  else if (state.section === 'health') body = renderHealthLimits();
  else body = renderStorage();

  const info = SECTION_INFO[state.section];
  setMain(
    renderViewHeader({
      eyebrow: 'configuration',
      title,
      info: info ? info.text : null,
      infoHtml: !!(info && info.html),
    }) +
    body,
    token
  );
}

// ── General ──────────────────────────────────────────────────────────────

function renderGeneral() {
  const dark = currentTheme() === 'dark';
  // Re-checking mid-install would race the very process being replaced.
  const updatesBusy = updatesAreBusy(state, inAppUpdate);
  const installerMode = installUpdateStyle() === 'download-installer';
  const recovery = infoMark('settings-update-recovery-info', 'How to go back to an earlier version',
    installerMode ? UPDATE_RECOVERY_INFO_INSTALLER : UPDATE_RECOVERY_INFO);
  const quick = state.quick;
  const summary = quick && !quick.error
    ? quick.summary
    : null;

  return (
    '<div class="settings-section" id="section-general">' +
      // ── THE INSET GROUPED LIST, AND WHY THESE THREE ARE ONE GROUP ────────
      // A stack of label+control pairs with a gap between them is a FORM; a
      // rounded card whose rows are separated by a hairline inset to the
      // label's own x-offset is a macOS settings group. The difference is not
      // decoration: the separator says "these rows belong to each other and
      // the ones below do not", which a gap cannot say.
      //
      // These three and no others. Appearance, Text size and Menu bar are all
      // "how the app presents itself on this machine", they are all instant
      // and reversible, and none of them spends money or writes to disk.
      // System check and Software update are BELOW the group on purpose —
      // each is a multi-state panel with progress, errors and its own result
      // surface, and a row in a grouped list cannot hold one honestly.
      //
      // The rows keep .settings-field-block wholesale, so every id, every
      // data-* hook and every test selector is byte-identical; the group only
      // adds the card, the padding and the separators around them.
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

      // Text size. Sits directly under Appearance because it is the same
      // KIND of setting — how the app looks on this screen — and it uses the
      // same segmented control for the same reason.
      //
      // NO SEPARATE PREVIEW, deliberately: the change applies to the whole
      // app in the same frame, including to this control and the label above
      // it, so the app IS the preview. A row of sample text next to it would
      // be a second thing to read that says less than the real one.
      renderTextSize() +

      // Menu bar. Sits with Appearance and Text size because it is the same
      // KIND of setting — where the app puts itself on this machine — and it
      // uses the same segmented control for the same reason.
      renderBackgroundMode() +
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
        '<span class="settings-field-label settings-label-row">Software update' + recovery.btn + '</span>' +
        // The hint has to be right BEFORE the button is clicked, so it reads
        // the install's own capability rather than a check result that does
        // not exist yet. The git sentence ("installing replaces The Curator's
        // own program files and restarts it") is not merely irrelevant to a
        // packaged install — it describes something that build refuses to do.
        (installerMode
          ? (updaterAttached === true
            ? '<p class="settings-hint-text">Compares this copy with the newest downloadable build, and installs it here — ' +
              'it downloads, checks the file, then restarts into the new version. Your knowledge base, API keys and ' +
              'sync settings are never touched.</p>'
            : '<p class="settings-hint-text">Compares this copy with the newest downloadable build. ' +
              'The Curator can’t install an update for itself — it tells you one exists and opens the ' +
              'download page, and you run the installer. Your knowledge base, API keys and sync settings ' +
              'are never touched.</p>')
          : '<p class="settings-hint-text">Compares this copy with the published version. Installing replaces The Curator’s own ' +
            'program files and restarts it — your knowledge base, API keys and sync settings are never touched.</p>') +
        recovery.panel +
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
      '<div class="cur-group-label">' +
        '<span class="settings-field-label">Text size</span>' +
        '<p class="settings-hint-text">Scales every piece of text in the app. Larger is easier to read; ' +
        'smaller fits more on screen. Icons, controls and the layout keep their size, so this trades ' +
        'density for legibility rather than zooming the whole window — your browser’s own zoom still ' +
        'does that. Saved in this browser, and it applies straight away.</p>' +
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
      '<p class="settings-hint-text">Puts a small icon in the Mac menu bar showing what your coding ' +
      'agents have just saved, so you can glance at it without opening the app. Off by default — ' +
      'until an agent has written something there is nothing for it to show. This applies to the Mac ' +
      'app; a browser install has no menu bar presence.</p>' +
      pair +
      (buttons
        ? '<div class="theme-segmented bgmode-segmented" role="group" aria-label="Menu bar">' + buttons + '</div>'
        : '') +
      (state.backgroundModeError
        ? '<div class="settings-inline-error">' + escapeHtml(state.backgroundModeError) + '</div>'
        : '') +
      (chosen ? '<p class="settings-hint-text">' + escapeHtml(chosen) + '</p>' : '') +
      (active && active !== 'window'
        ? '<p class="settings-hint-text">If the icon does not appear: it can be pushed off the edge ' +
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
        outlineNote: '',
        thinks: false,
        cheapest: null,
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
      outlineNote: '',
      thinks: false,
      cheapest: null,
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
      priceIn: null, priceOut: null, outlineNote: '', thinks: false, cheapest: null,
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
    outlineNote: typeof f.outlineNote === 'string' ? f.outlineNote : '',
    thinks: f.thinks === true,
    cheapest: (ch && typeof ch.model === 'string' && ch.model) ? {
      model: ch.model,
      provider: typeof ch.provider === 'string' ? ch.provider : '',
      priceIn: num(ch.priceIn),
      priceOut: num(ch.priceOut),
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

const MODEL_PRICE_BANDS = [
  ['any', 'Any price', null],
  ['free', 'Free', (m) => m && m.free === true],
  ['lt20', 'Under $0.20', (m) => typeof m.input === 'number' && m.input > 0 && m.input < 0.2],
  ['mid', '$0.20–$1', (m) => typeof m.input === 'number' && m.input >= 0.2 && m.input <= 1],
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
    const why = (nowIn !== null && inp < nowIn)
      ? 'cheaper on input than the model building your wiki now, and its published context clears ' +
        'the working set ingest needs.'
      : 'its published context clears the working set ingest needs, at or below what you pay now.';
    out.push({ row, why });
  }
  return out;
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

  const body = orderedRows.map(({ p, m, lane, qual }) => {
    const inUse = p.id === activeProvider && m.id === defaultId;
    const canBuild = laneBuildsWiki(lane);
    let laneCell;
    if (inUse) {
      laneCell = '<span class="browse-inuse">Building your wiki</span>';
    } else if (canBuild) {
      laneCell = '<button type="button" class="btn btn-secondary btn-xs"' +
        ' data-build-model="' + escapeHtml(m.id) + '" data-build-provider="' + escapeHtml(p.id) + '"' +
        (pickDisabled ? ' disabled' : '') + '>Use for building</button>';
    } else {
      // NEVER "cannot build". `jsonRaw === null` means UNMEASURED, and llm.js
      // records in as many words that unmeasured must never become a rejection
      // signal. The two absences are drawn apart here for the same reason
      // `measurementChip` refuses to collapse them.
      laneCell = (isCuratorMeasured(m) || qual)
        ? '<span class="browse-chatonly">chat only — measured</span>'
        : '<span class="browse-unmeasured">not measured yet</span>';
    }
    const ctx = formatTokenCount(m.contextLength);
    return '<tr>' +
      '<td class="browse-name"><b>' + escapeHtml(m.label || m.id) + '</b>' +
        '<small>' + escapeHtml(p.name) + ' · ' + escapeHtml(m.id) + '</small></td>' +
      '<td class="browse-num mono">' + escapeHtml(formatUsdHonest(m.input) || '—') + '</td>' +
      '<td class="browse-num mono">' + escapeHtml(formatUsdHonest(m.output) || '—') + '</td>' +
      '<td class="browse-num mono">' + escapeHtml(ctx || '—') + '</td>' +
      '<td>' + laneCell + '</td>' +
    '</tr>';
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

  const worth = worthTestingRows(rowsAll, b);
  const worthHtml =
    '<div class="browse-worth">' +
      '<b>Worth testing for this job</b>' +
      (worth.length
        ? '<ul>' + worth.map(({ row, why }) =>
            '<li><strong>' + escapeHtml(row.m.label || row.m.id) + '</strong> — ' + escapeHtml(why) +
            ' Nobody has measured it against the ingest prompt.</li>').join('') + '</ul>'
        : '<p>Nothing on your synced list stands out on facts alone for this job. Every model ' +
          'stays reachable in the list above.</p>') +
    '</div>';

  const empty = orderedRows.length === 0
    ? '<div class="model-filter-empty"><p>No model matches these filters.</p>' +
      '<button type="button" class="btn btn-secondary btn-xs" data-model-filter-clear="' +
        escapeHtml(ALL_MODELS_SCOPE) + '">Clear filters</button></div>'
    : '';

  return (
    '<div class="browse-facets">' +
      '<span class="theme-segmented browse-seg" role="group" aria-label="Model lane">' + laneSeg + '</span>' +
      '<span class="theme-segmented browse-seg" role="group" aria-label="Input price band">' + bandSeg + '</span>' +
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
    '<div class="browse-foot">' +
      '<span class="browse-foot-t">Nothing here is hidden from chat. A model only leaves the ' +
      'build lane by failing a measurement, never by price.</span>' +
      '<span class="browse-foot-sp"></span>' +
      '<button type="button" class="btn btn-secondary btn-xs" data-open-model-lab="1">Open Model Lab</button>' +
      // ── ONE REFRESH CONTROL, AND ITS STATUS STAYS WHERE IT IS ──────────
      // The same `data-sync-catalogue` hook the per-provider control carries,
      // so one delegated handler and one 409-guarded route serve both. It is
      // rendered here only for a provider that HAS a fetchable catalogue and a
      // saved key, from the same table `renderCatalogueSync` reads — never
      // `p.id === 'openrouter'`, the comparison this file forbids twice. The
      // refusal, the funnel and the "synced at" line stay on that control,
      // because a status that follows the button would then exist twice.
      refreshCatalogueButton(k, crossBusy) +
    '</div>'
  );
}

/**
 * The block-4 footer's refresh control, or '' when no connected provider has a
 * catalogue that can be refetched.
 *
 * DERIVED FROM THE SAME TWO FACTS `renderCatalogueSync` uses — a provider that
 * publishes a catalogue, and a SAVED key — so a second provider gaining a
 * catalogue reaches both surfaces with one added line and neither can offer a
 * control the route would refuse.
 */
function refreshCatalogueButton(k, crossBusy) {
  const SYNC_BY_PROVIDER = Object.assign(Object.create(null), { openrouter: true });
  const p = PROVIDER_ROWS.find((x) =>
    x.available && SYNC_BY_PROVIDER[x.id] === true && providerHasSavedKey(x.id, k));
  if (!p) return '';
  const busy = state.catalogueSyncBusy === p.id;
  const disabled = busy || !!crossBusy || state.catalogueSyncBusy !== null;
  return '<button type="button" class="btn btn-ghost btn-xs" data-sync-catalogue="' +
    escapeHtml(String(p.id)) + '"' + (disabled ? ' disabled' : '') + '>' +
    (busy ? 'Refreshing…' : 'Refresh catalogue') + '</button>';
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
 */
function settingsBlock(num, id, title, ledeHtml, bodyHtml) {
  return (
    '<div class="settings-job-block settings-block settings-block-' + escapeHtml(id) + '">' +
      '<div class="settings-block-hd">' +
        '<span class="settings-block-num" aria-hidden="true">' + escapeHtml(String(num)) + '</span>' +
        '<h2 class="settings-job-title">' + escapeHtml(title) + '</h2>' +
      '</div>' +
      (ledeHtml ? '<p class="settings-job-lede settings-block-lede">' + ledeHtml + '</p>' : '') +
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

  const lede =
    (anyKey ? '' : '<strong>Start here.</strong> ') +
    'One key per provider — connect as many as you like. The Curator calls the provider directly ' +
    'with your key; nothing goes through us.';

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

  return settingsBlock(1, 'connect', 'Connect a provider', lede, body);
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
      // The per-provider catalogues, unchanged. They carry the per-model
      // disclosure with the whole measured note, and the "Test on my wiki"
      // nine-run flow the Model Lab entry above points at.
      '<div class="settings-model-lab" id="settings-model-lab">' +
        PROVIDER_ROWS.map((p) =>
          renderCatalogueSync(p, k, crossBusy) +
          renderModelPicker(p, k, state.modelPickerOpen[p.id] === true, crossBusy)).join('') +
      '</div>';

  const lede = 'The full catalogue for every provider you have connected, with search and filters. ' +
    'Everything here is available in <strong>chat</strong>; the ones that can also build your wiki ' +
    'are marked, and can be chosen from here or from block 2.';

  const shelf =
    '<details class="settings-shelf"' + (state.modelShelfOpen === true ? ' open' : '') +
      ' data-model-shelf="1">' +
      '<summary class="settings-shelf-summary">' +
        icon('chevronRight', 12) +
        '<span class="settings-shelf-title">Browse every model</span>' +
        '<span class="mono settings-shelf-count">' +
          escapeHtml(counts.total === 0 ? 'nothing connected yet' : String(counts.total) + ' in total') +
        '</span>' +
      '</summary>' +
      '<div class="settings-shelf-body">' + body + '</div>' +
    '</details>';

  return settingsBlock(4, 'all', 'All models', lede, shelf);
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

  const body =
    renderBuildCurrent(k, pickDisabled, { popupHtml }) +
    errHtml +
    listHtml;

  // ── THE LEDE CARRIES THE *WHY ONE MODEL*, AND THE ONE CONSEQUENCE ──────
  // "They always share one" is not a flourish: without it a reader looks for a
  // per-feature override, and v3.14.0 recorded that such an override is
  // INEXPRESSIBLE at four call sites (health-ai.js and compile.js call
  // `generateText` with four and five arguments; the provider/model pair lives
  // in argument six). The second sentence names the consequence a cross-
  // provider choice has — the active provider, and therefore the key being
  // billed, moves with it — which is the one place the word "active" still
  // earns its keep now that the connection rows no longer carry it.
  const lede = '<strong>Ingest, Health scans and Compile all run on this one model.</strong> ' +
    'They always share one, and there is nothing separate to set for each of them — one model ' +
    'keeps the ingest prompt cache warm and keeps one bill to read. Choosing a model from another ' +
    'provider makes that provider the active one, so the bill moves with it.';

  return settingsBlock(2, 'build', 'What builds your wiki', lede, body);
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
  const chip = measurementChip({ measuredBy: b.measuredBy }, null);
  const modelName = buildModelDisplayName(k, b);

  let why;
  if (b.source === 'env') {
    why = 'Set by <code class="mono">LLM_MODEL</code> in the environment this app was started from. ' +
      'That overrides anything chosen here, so a choice below will not take effect until it is unset.';
  } else if (b.source === 'selected' && b.honoured) {
    why = 'You chose this one, so app updates will not move you off it.';
  } else if (b.source === 'selected' || b.source === 'fallback') {
    why = 'You chose a model, and it is <strong>not the one running</strong> — The Curator refused it ' +
      'on read (it may no longer be offered, or may never have been measured for this job) and fell ' +
      'back to the model named above. Choose again to fix it.';
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
  const chipInfo = infoMark('settings-build-chip-info', 'About the ' + chip.label + ' badge', chip.title);

  // ── THREE FACT CHIPS, AND NO CONTEXT CHIP ──────────────────────────────
  // Price, the measured finding, and who measured it. CONTEXT IS DELIBERATELY
  // ABSENT: `contextLength` is null on every hand-typed static entry — i.e. on
  // every model that can actually be the build model today — so a context chip
  // would be blank or invented on exactly the rows that matter. It ships when
  // those entries carry the field, not before.
  const price = formatModelPrice(b.priceIn, b.priceOut);
  const facts =
    (price ? '<span class="build-fact build-fact-num mono">' + escapeHtml(price + ' per 1M tokens') + '</span>' : '') +
    (b.outlineNote ? '<span class="build-fact">' + escapeHtml(b.outlineNote) + '</span>' : '') +
    '<span class="build-fact build-fact-measured">' + escapeHtml(chip.label) + '</span>';

  // ── CHEAPEST MEASURED — A FACT, NEVER A RECOMMENDATION ─────────────────
  // Server-derived, and that is not a detail: a client-side cross-provider
  // price comparator would be a second opinion about a money fact, and would
  // have to decide what `null` means for a free model. The words are "cheapest
  // measured", never "best" or "recommended", because only the first is
  // something we can show our working for.
  let cheapest = '';
  if (b.cheapest) {
    const cName = buildModelDisplayName(k, b.cheapest) || b.cheapest.model;
    if (b.cheapest.same) {
      cheapest = '<div class="build-cheapest"><span class="build-cheapest-tag">Cheapest measured</span>' +
        '<span>For the keys you have connected, that is <strong>' + escapeHtml(cName) +
        '</strong> — the one you are already using.</span></div>';
    } else {
      const cPrice = formatModelPrice(b.cheapest.priceIn, b.cheapest.priceOut);
      const vs = price ? ', against the ' + price + ' you are paying now' : '';
      cheapest = '<div class="build-cheapest"><span class="build-cheapest-tag">Cheapest measured</span>' +
        '<span>For the keys you have connected, that is <strong>' + escapeHtml(cName) + '</strong>' +
        (cPrice ? ' — <span class="mono">' + escapeHtml(cPrice + ' per 1M') + '</span>' : '') +
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
    baselineModelId: (k && k.models && typeof k.models[p.id] === 'string') ? k.models[p.id] : '',
  })).join('');

  // Forced open while a refusal or a write belongs to a row inside it.
  const forceOpen = !!errorText || (typeof busyId === 'string' && busyId !== '');
  const open = (state.buildListOpen === true || forceOpen) ? ' open' : '';

  return (
    '<details class="build-change"' + open + ' data-build-list="1">' +
      '<summary class="build-change-summary">' +
        '<span class="build-change-title">Change\u2026 <span class="build-change-sub">every model that can build your wiki</span></span>' +
        '<span class="mono build-list-count">' + escapeHtml(String(cands.length)) +
          ' measured for this job</span>' +
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

  const lede = 'Chat can use <strong>any</strong> model you have connected, including the ones that ' +
    'cannot build a wiki — nothing is at stake in an answer but the cost of that answer. ' +
    '<strong>You choose it per message, in the composer</strong>, next to Send. It never touches ' +
    'what builds your wiki, so there is no second control for it here.';

  return settingsBlock(3, 'chat', 'Chat', lede, body);
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
    const noModels = infoMark(
      'settings-nomodels-info-' + p.id,
      'Why ' + p.name + ' cannot be active',
      p.name + ' has no models available in this build yet, so it cannot run ingest, Health scans or Compile. Your key is saved and this will change on its own once models are available.');
    extraActions.push(
      '<span class="mono provider-state provider-state-muted">no models yet — cannot be active</span>' +
      noModels.btn + noModels.panel
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
    // scale marker beside the user's own result — see MEASURED_CALL_SECONDS for
    // why this is looked up rather than typed into the sentence.
    baselineModelId: (k.models && typeof k.models[p.id] === 'string') ? k.models[p.id] : '',
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
 *    stale. See MEASURED_CALL_SECONDS below.
 */
/**
 * Mean seconds per outline call, by EXACT model id, from the live measurement
 * pass recorded in `src/brain/openrouter-qualify.js`'s
 * `QUALIFY_OBSERVED_CALL_SECONDS` docblock (2026-08-27, nine runs apiece
 * against the real ingest outline prompt).
 *
 * ── WHY A TABLE AND NOT A CONSTANT ────────────────────────────────────────
 * The one figure this panel needs — 53 s — used to be typed into the sentence
 * that quotes it, with nothing tying it to the model it describes. A bump of
 * `DEFAULTS.openrouter` would have left the panel confidently attributing one
 * model's timing to another. Keyed by id, a bump either finds a measured value
 * or finds nothing, and finding nothing removes the clause.
 *
 * ── WHAT IT MUST NOT BECOME ───────────────────────────────────────────────
 * A RANKING. These are means from one session, on one corpus, over hosts that
 * change; the panel prints one of them as a scale marker beside the user's own
 * fresh measurement and draws no conclusion. Never sort by it, never label an
 * entry fast or slow, and never add an unmeasured id with an estimate — an
 * absent id is the honest state and the code handles it.
 *
 * ⚠ ADDING A MODEL HERE IS A CLAIM THAT SOMEBODY TIMED IT. If a future default
 * is not in this list, leave it out; the sentence disappears and the user loses
 * a comparison rather than being handed a false one.
 */
const MEASURED_CALL_SECONDS = {
  'upstage/solar-pro4': 53,
  'z-ai/glm-4.7': 38,
  'z-ai/glm-5.3-flash': 289,
  'deepseek/deepseek-v4-flash-0731': 382,
};

/**
 * The measured mean for a model id, or null.
 *
 * Own-property check, not truthiness: `MEASURED_CALL_SECONDS['constructor']`
 * resolves to a FUNCTION through the prototype chain, and a model id is a third
 * party's string (v3.0.9's `normalizeResponseStyle` shape, and the same reason
 * `qualIndex` builds a null-prototype object).
 */
function measuredCallSeconds(modelId) {
  if (typeof modelId !== 'string' || !modelId) return null;
  if (!Object.prototype.hasOwnProperty.call(MEASURED_CALL_SECONDS, modelId)) return null;
  const v = MEASURED_CALL_SECONDS[modelId];
  return Number.isFinite(v) ? v : null;
}
function renderQualification(qual, minRuns, baselineModelId) {
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
    // This read `'(the model this app ships averages about 53 s)'` — a literal
    // untied to anything, in the one panel whose stated discipline is never
    // stating an unmeasured figure. 53 s is `upstage/solar-pro4`'s measured mean.
    // The moment `DEFAULTS.openrouter` is bumped, that sentence describes a
    // model the app no longer ships, and nothing anywhere would have said so.
    //
    // Now it is keyed on the id the server resolved (`getDefaultModel(provider)`,
    // delivered as `models[provider]`) and looked up in MEASURED_CALL_SECONDS.
    // A bump therefore either changes the number or — for a model nobody has
    // timed — DROPS THE CLAUSE, which is the fail-safe direction: no baseline
    // is a smaller loss than a confident wrong one. The model is NAMED, because
    // an anonymous "the model this app ships" is unfalsifiable to a reader.
    const baseSecs = measuredCallSeconds(baselineModelId);
    lines.push('mean ' + formatDuration(qual.latencyMs.mean) + ' per call' +
      (baseSecs === null ? ''
        : ' (' + baselineModelId + ', which builds your wiki today, averages about '
          + baseSecs + ' s)'));
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
  const qualHtml = renderQualification(qual, c.minRuns, c.baselineModelId) +
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
    // ── REFERENCE, NOT A CONTROL SURFACE ──────────────────────────────────
    // A build-lane row on the shelf. It CAN build the wiki, so the chat-only
    // refusal above would be a false statement — but the choice is made once,
    // in the build block, through the atomic route that names provider and
    // model together. Offering a second button here that writes the same
    // setting through the OLDER endpoint would reinstate exactly the inert-pin
    // state renderBuildCurrent has to report: that route pins per provider
    // without activating it, so a click here could look like it worked and
    // govern nothing.
    //
    // So the row states where the control is instead of carrying a duplicate.
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

  return (
    '<li class="model-option' + (isDefault ? ' model-option-default' : '') +
      (isSelected ? ' model-option-chosen' : '') +
      (pickErrorHtml ? ' model-option-refused' : '') +
      '" data-model-id="' + idAttr + '">' +
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
  const pillClass = connected ? 'status-pill status-pill-ok' : 'status-pill status-pill-muted';
  const pillLabel = unreadable
    ? 'Config unreadable'
    : (connected ? 'Connected' : (m.installed ? 'Needs re-connect' : 'Not connected'));
  const wizardLabel = unreadable
    ? 'Fix the config file'
    : (connected ? 'Re-run setup' : (m.installed ? 'Re-connect' : 'Set up Claude Desktop'));
  return { unreadable, connected, pillClass, pillLabel, wizardLabel };
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

function renderMcp() {
  if (state.mcpError) {
    return '<div class="settings-inline-error">' + escapeHtml(state.mcpError) + '</div>';
  }
  if (!state.mcp) {
    return gatedLoader(loadGate, 'Loading MCP status…');
  }
  const m = state.mcp;
  const status = deriveMcpStatus(m);
  const { pillClass, pillLabel, wizardLabel } = status;

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
    // Description moved to SECTION_INFO.mcp. The tool counts moved WITH it
    // verbatim; scripts/test-next-mcp-wizard.js pins them against the real
    // table, so the numbers still have exactly one reader and one guard.
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
    snippetHtml +
    '<div class="settings-field-block" style="margin-top:22px">' +
      '<span class="settings-field-label">Default domain for MCP writes</span>' +
      '<p class="settings-hint-text">When a client calls a write tool and the user says “my wiki” without naming a ' +
      'domain, this one is used. Leave unset to force the model to always name a domain.</p>' +
      // The shared listbox (shared/listbox.js). No wrapper: the component
      // draws its own indicator INSIDE the trigger, so there is nothing left
      // to position a chevron against.
      renderListboxHtml(defaultDomainCfg) +
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
    // Description moved to SECTION_INFO.health. The two per-field hints below
    // stay where they are: each states a DEFAULT for the input it sits under,
    // which is in-context labelling, not a view description.
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
    // Description moved to SECTION_INFO.storage. The cross-write banner stays
    // unfolded — changing this folder mid-write scatters a run's remaining
    // pages into the new one, which is a data warning, not an explanation.
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
  // ── OPEN MODEL LAB ─────────────────────────────────────────────────────
  // The nine-run flow lives on the per-provider catalogue rows, so "opening the
  // lab" is opening those. It expands every provider that HAS a catalogue (the
  // saved-key gate renderModelPicker itself applies), opens the shelf so they
  // are on screen at all, and then scrolls — reveal AFTER the repaint, by id,
  // because the node the click came from does not survive it.
  document.querySelectorAll('[data-open-model-lab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.modelShelfOpen = true;
      for (const p of PROVIDER_ROWS) {
        if (p.available && providerHasSavedKey(p.id, state.keys)) state.modelPickerOpen[p.id] = true;
      }
      render(myMountToken);
      const el = document.getElementById('settings-model-lab');
      if (el && typeof el.scrollIntoView === 'function') {
        try { el.scrollIntoView({ block: 'start' }); } catch { /* jsdom / older engines */ }
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
