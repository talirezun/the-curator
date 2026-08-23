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
//   - "Check for updates" only ever calls the read-only version-compare
//     endpoint. Applying an update (git reset --hard + npm install against
//     the live app repo, then a process restart) is deliberately NOT wired
//     from this preview shell — seeing that action fire against a
//     developer's real checkout while reviewing a design is not a good
//     trade against the small UI gap. The banner says so and points at
//     the shipping app's Settings tab instead.
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
// Owns views/settings.css.

import {
  registerView, setSidebar, setMain, eyebrow, escapeHtml, icon, isCurrentMount,
  reportAsyncMountFailure, reportAsyncActionFailure,
} from '../app.js';

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

// ── Module state ─────────────────────────────────────────────────────────
// One object, reset on every onEnter so a second visit never leaks stale
// in-flight state (e.g. a confirm panel left open) from a prior visit.
function freshState() {
  return {
    section: 'providers', // matches the design prototype's default state

    // General
    version: null,          // { version, onDiskVersion, restartRequired }
    updateCheck: null,      // { current, latest, updateAvailable } | { error }
    updateChecking: false,
    quick: null,            // { checks, summary } | { error }
    quickLoading: false,
    liveConfirmOpen: false,
    live: null,             // result of /api/diagnostics/live | null
    liveLoading: false,

    // Providers & keys
    keys: null,             // GET /api/config/api-keys response
    keysError: null,        // the section FAILED TO LOAD — renderProviders shows this INSTEAD of the list (state.keys is also null in this case, so there's nothing to show anyway)
    keysActionError: null,  // a save/disconnect/set-active ACTION failed — rendered INLINE, list stays visible (found live while verifying MEDIUM-1: reusing keysError here hid the entire provider list — including the Cancel button — behind a bare error message the instant a save failed)
    replacing: null,        // provider id currently showing an input row
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

registerView('settings', {
  onEnter(mountToken) {
    state = freshState();
    myMountToken = mountToken;
    render(mountToken);
    loadVersion(mountToken).catch((err) => reportAsyncMountFailure(mountToken, err));       // cheap, always shown in the sidebar footer
    ensureSectionData('providers', mountToken).catch((err) => reportAsyncMountFailure(mountToken, err)); // default section — prefetch immediately
  },
});

// ── Data loading (fetch-on-first-visit-to-section, cached in state) ─────

async function ensureSectionData(section, token) {
  if (section === 'providers' && state.keys === null) return loadKeys(token);
  if (section === 'mcp' && state.mcp === null) return loadMcp(token);
  if (section === 'health' && state.aiHealth === null) return loadAiHealth(token);
  if (section === 'storage' && state.config === null) return loadConfig(token);
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
    return '<p class="view-body">Loading provider status…</p>';
  }
  const k = state.keys;
  const rows = PROVIDER_ROWS.map((p) => renderProviderRow(p, k)).join('');

  return (
    '<p class="view-body">At least one key is required. Saving a key makes that provider available in the chat model ' +
    'picker; the active provider is used for ingest and health scans.</p>' +
    (state.keysActionError ? '<div class="settings-inline-error">' + escapeHtml(state.keysActionError) + '</div>' : '') +
    '<div class="provider-row-list">' + rows + '</div>' +
    '<div class="settings-note-row">' +
      icon('lockAlt', 15) +
      '<span>Keys live in <code class="mono">.curator-config.json</code> at 0600 on this machine. Never committed, ' +
      'never sent anywhere except the provider you call.</span>' +
    '</div>'
  );
}

function renderProviderRow(p, k) {
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

  const hasKeyField = p.id === 'gemini' ? k.geminiApiKey : k.anthropicApiKey;
  const hasKey = p.id === 'gemini' ? k.hasGeminiKey : k.hasAnthropicKey;
  const model = (k.models && k.models[p.id]) || '—';
  const isActive = k.activeProvider === p.id;
  const isReplacing = state.replacing === p.id;
  const isBusy = state.keysBusy === p.id;

  const stateText = isActive ? 'active' : (hasKey ? 'configured' : 'not set');
  const stateClass = isActive ? 'provider-state-active' : 'provider-state-muted';

  const extraActions = [];
  if (hasKey && !isActive) {
    extraActions.push('<button type="button" class="btn btn-ghost btn-xs" data-set-active="' + p.id + '"' + (isBusy ? ' disabled' : '') + '>Set active</button>');
  }
  if (hasKey) {
    extraActions.push('<button type="button" class="btn btn-ghost btn-xs" data-disconnect="' + p.id + '"' + (isBusy ? ' disabled' : '') + '>Disconnect</button>');
  }

  let fieldHtml;
  if (isReplacing) {
    fieldHtml = (
      '<div class="provider-replace-row">' +
        '<input type="password" class="provider-replace-input mono" id="replace-input-' + p.id + '" placeholder="Paste your ' + escapeHtml(p.name) + ' API key" autocomplete="off" spellcheck="false">' +
        '<button type="button" class="btn btn-primary btn-xs" data-save-key="' + p.id + '"' + (isBusy ? ' disabled' : '') + '>' + (isBusy ? 'Saving…' : 'Save') + '</button>' +
        '<button type="button" class="btn btn-ghost btn-xs" data-cancel-replace="' + p.id + '"' + (isBusy ? ' disabled' : '') + '>Cancel</button>' +
      '</div>'
    );
  } else {
    fieldHtml = (
      '<code class="provider-key-field mono' + (hasKeyField ? '' : ' provider-key-empty') + '">' + escapeHtml(hasKeyField || 'Not set') + '</code>' +
      '<span class="mono provider-state ' + stateClass + '">' + stateText + '</span>' +
      '<div class="provider-row-actions">' +
        extraActions.join('') +
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

// ── MCP bridge ────────────────────────────────────────────────────────────

function renderMcp() {
  if (state.mcpError) {
    return '<div class="settings-inline-error">' + escapeHtml(state.mcpError) + '</div>';
  }
  if (!state.mcp) {
    return '<p class="view-body">Loading MCP status…</p>';
  }
  const m = state.mcp;
  const connected = m.installed && !m.stale;
  const pillClass = connected ? 'status-pill status-pill-ok' : 'status-pill status-pill-muted';
  const pillLabel = connected ? 'Connected' : (m.installed ? 'Needs re-connect' : 'Not connected');

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
    '<p class="view-body">Exposes your graph to any MCP client — seventeen tools, ten read and seven write. Write ' +
    'tools refuse on <code class="mono">shared-*</code> mirrors by design. The Curator does not need to be running: ' +
    'the bridge is a separate process the client launches on demand.</p>' +
    '<div class="settings-btn-row">' +
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
    return '<p class="view-body">Loading scan limits…</p>';
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
    return '<p class="view-body">Loading…</p>';
  }
  return (
    '<p class="view-body">Every domain is a folder of plain markdown here. This folder is also your Obsidian vault ' +
    '— open it with <em>Open folder as vault</em>.</p>' +
    '<div class="storage-path-row">' +
      '<code class="mono storage-path">' + escapeHtml(state.config.domainsPath) + '</code>' +
      '<button type="button" class="btn btn-primary" id="btn-choose-folder"' + (state.pickingFolder ? ' disabled' : '') + '>' +
        (state.pickingFolder ? 'Waiting for Finder…' : 'Choose folder') +
      '</button>' +
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
}

function wireProviderListeners() {
  document.querySelectorAll('[data-replace]').forEach((btn) => {
    btn.addEventListener('click', () => { state.replacing = btn.dataset.replace; render(myMountToken); focusReplaceInput(); });
  });
  document.querySelectorAll('[data-cancel-replace]').forEach((btn) => {
    btn.addEventListener('click', () => { state.replacing = null; render(myMountToken); });
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
}

function focusReplaceInput() {
  if (!state.replacing) return;
  const el = document.getElementById('replace-input-' + state.replacing);
  if (el) el.focus();
}

function wireMcpListeners() {
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

async function onCheckForUpdates(token) {
  state.updateChecking = true;
  render(token);
  try {
    const res = await fetch('/api/config/update-check');
    const data = await res.json();
    if (!isCurrentMount(token)) return;
    if (data.error) {
      state.updateCheck = { error: data.error };
    } else {
      state.updateCheck = data;
      const msg = data.updateAvailable
        ? 'Update available: v' + data.current + ' → v' + data.latest + '. Applying updates from this preview ' +
          'shell is disabled — use the shipping app’s Settings tab to install it (git reset --hard + npm install ' +
          'against your real checkout, then a restart).'
        : 'You’re on the latest version (v' + data.current + ').';
      window.alert(msg); // eslint-disable-line no-alert -- deliberately outside the redesigned inline-status pattern: this is a one-off developer-facing check, not a repeating in-flow action, and applying the update is explicitly NOT wired here (see the message text).
    }
  } catch (err) {
    if (!isCurrentMount(token)) return;
    state.updateCheck = { error: err.message };
  } finally {
    if (isCurrentMount(token)) { state.updateChecking = false; render(token); }
  }
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
  const input = document.getElementById('replace-input-' + provider);
  const value = input ? input.value.trim() : '';
  if (!value) return;
  state.keysBusy = provider;
  state.keysActionError = null;
  render(token);
  try {
    const body = provider === 'gemini' ? { geminiApiKey: value } : { anthropicApiKey: value };
    const res = await fetch('/api/config/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
    if (!isCurrentMount(token)) return;
    state.keysBusy = null;
    state.replacing = null;
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
