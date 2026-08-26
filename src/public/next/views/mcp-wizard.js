// My Curator MCP setup wizard — the /next shell's guided path for
// connecting the local MCP bridge to Claude Desktop.
//
// Shape follows the shipping app's three-step #mcp-wizard (copy the
// snippet → paste it into claude_desktop_config.json → restart and
// verify), and the CHROME follows views/shared-brain-wizard.js verbatim:
// this is a wizard, not a view — no registerView(), no mount token, no
// setMain(). It owns a detached subtree appended to document.body, opened
// by a button in views/settings.js's MCP section and closed by that view's
// teardown.
//
// ── What this module changes relative to the shipping wizard ────────────
// Each item below is a real defect that the shipping wizard and the
// /next MCP section both still have; this file is where they are fixed.
// Nothing here claims coverage of anything else.
//
//   1. A CORRUPT claude_desktop_config.json is a BLOCKING state, and the
//      whole-file payload is never even FETCHED in it.
//      GET /api/mcp/config has always returned `claude_config_parse_error`
//      and no frontend read it. The consequence is specific and bad:
//      GET /api/mcp/claude-full-config treats an unparseable file exactly
//      like a missing one — it returns `was_empty: true` with a `merged`
//      body containing ONLY the Curator entry. A user with three other MCP
//      servers and one stray comma was therefore shown "your file, with
//      Curator added" that was in fact "your file, replaced by Curator
//      alone", beside a Copy button. loadAll() below reads
//      claude_config_parse_error FIRST and, when it is true, routes to the
//      blocked panel and never issues the /claude-full-config request at
//      all — the destructive payload does not enter the page, rather than
//      entering it and being hidden by a render branch.
//      wholeFilePayloadAvailability() is the single gate; both of its
//      directions are asserted in scripts/test-next-mcp-wizard.js.
//
//   2. The two payloads are NAMED, and step 2's instructions follow the
//      one that was actually copied. The shipping wizard has two Copy
//      buttons carrying different JSON (step 1 = the `mcpServers` fragment,
//      step 2 = the entire merged file) with neither labelled, next to a
//      hint telling the user to choose between merging by hand and
//      replacing the file. Here the user picks the payload explicitly on
//      step 1, the button says which one it will copy, and step 2 renders
//      paste instructions for THAT payload only (state.copiedPayload).
//
//   3. A FAILED clipboard write never advances the step. The shipping
//      "Copy & Continue" catches a rejected navigator.clipboard.writeText
//      and advances anyway, landing the user on "now paste it" with an
//      empty clipboard. runCopyAndAdvance() below advances only on a
//      confirmed success and otherwise surfaces the failure and reveals
//      the payload for manual selection.
//
//   4. The stale-entry message covers all four causes. `stale` is a strict
//      equality on command+args (src/routes/mcp.js), so it fires when the
//      knowledge folder moved, when the NODE BINARY path changed (an nvm or
//      Homebrew upgrade), when the app directory moved, or when the entry
//      was hand-edited. The shipping copy names only the first.
//
//   5. Self-test failures get a next step. describeSelfTest() classifies
//      the outcome and returns concrete actions; the branch that used to
//      print "Unknown error" (POST /self-test can answer ok:false with
//      `error` undefined) is now the "started but never answered" case with
//      its own steps. stderr is child-process output and is always
//      rendered with textContent, never interpolated into HTML.
//
//   6. The v2.3.3 SPA-fallthrough trap is closed for every request this
//      module makes. src/server.js's `app.get('*')` serves index.html with
//      HTTP 200, so against a server predating these routes `res.json()`
//      throws `Unexpected token '<'`. classifyResponse() checks the
//      content-type before parsing. It deliberately does NOT treat a
//      genuine JSON 500 (POST /reveal-config's only failure shape) as
//      "restart the app" — that error is shown as itself.
//
//   7. The tool count is stated correctly and the WRITE tools are named.
//      Counted from mcp/tools/index.js: 18 tools, of which 4 mutate the
//      wiki (the four guarded by refuseIfReadonly — compile_to_wiki,
//      fix_wiki_issue, dismiss_wiki_issue, undismiss_wiki_issue). The
//      /next MCP section said "seventeen tools, ten read and seven write",
//      wrong on all three numbers. scripts/test-next-mcp-wizard.js imports
//      the real tool table and fails if these constants drift from it.
//
//   8. domains_dir_exists === false blocks setup before step 1, matching
//      the shipping landing screen's disabled CTA.
//
// ── What this module does NOT do ────────────────────────────────────────
//   - It never reads, writes, or proposes a write to the real
//     claude_desktop_config.json. Every payload it shows comes from the
//     backend; putting it in the file is always the user's own action.
//   - It does not attempt to REPAIR a corrupt config. The blocked state
//     hands the user the path and a Finder reveal, nothing more.
//   - POST /api/mcp/reveal-config is macOS-only server-side (`open -R`,
//     no platform guard — see src/routes/mcp.js). This module handles its
//     500 gracefully but does not detect the platform in advance.
//
// ── Staleness discipline (copied from shared-brain-wizard.js) ───────────
// `wizardGen` is a module-level counter, deliberately NOT part of `state`
// — `state` is wholesale replaced by freshState() on both open() and
// close(), so a guard living inside it could alias into a brand-new
// session. Bumped on open AND close; every async handler captures
// `const myGen = wizardGen` as its FIRST statement and re-checks
// isFresh(myGen) before sending a fetch and after every await.

// Only `icon` is imported. escapeHtml is deliberately NOT used anywhere in
// this file: every value that comes from the backend, the user's own config
// file, or a child process is written with textContent, so there is no
// interpolation site for it to guard. The only innerHTML in this module is
// shellHtml()/panel*() — fixed literals plus icon() — and one
// `glyph.innerHTML = icon(...)`, which is likewise a fixed internal string.
import { icon } from '../app.js';
import { createLoadingGate, settleGate } from '../shared/loading-gate.js';

// ── Facts about the bridge, pinned against mcp/tools/index.js ────────────
// Hardcoded here because the wizard must state them BEFORE any connection
// exists (there is no live tool list to read yet). The drift risk that
// creates is covered by scripts/test-next-mcp-wizard.js, which imports the
// real tool table and the real refuseIfReadonly call sites and fails if
// either number moves without this constant moving with it.
const TOOL_TOTAL = 18;
const TOOL_WRITE = 4;
const TOOL_READ = TOOL_TOTAL - TOOL_WRITE; // 14

// ── State ────────────────────────────────────────────────────────────────

function freshState() {
  return {
    phase: 'loading',      // 'loading' | 'blocked' | 'steps'
    step: 1,               // 1..3, meaningful only while phase === 'steps'
    blocker: null,         // {kind, title, body[], showReveal, showRecheck}
    status: null,          // interpretMcpConfig() result
    snippet: null,         // GET /api/mcp/claude-config (the entry fragment)
    wholeFile: null,       // GET /api/mcp/claude-full-config ({was_empty, merged})
    wholeFileError: null,  // that request failed, but the entry payload still works
    payloadChoice: 'entry',// 'entry' | 'whole'
    copiedPayload: null,   // which payload actually reached the clipboard
    selfTest: null,        // describeSelfTest() result
    selfTestBusy: false,
    revealBusy: false,
    recheckBusy: false,
    onDone: null,
    prevFocus: null,
  };
}

let state = freshState();

// Delay-gated reveal of the "Checking your setup…" panel. The status read
// was measured at ~2 ms, so the panel used to appear and vanish inside a
// single frame while collapsing the overlay. It is now hidden in the static
// markup below and revealed ONLY if the gate fires. Cancelled in
// closeWizard(). See shared/loading-gate.js.
//
// SCOPE: delay half only — loadAll() paints its own terminal phase
// (blocked / steps / failure) from several branches, so the min-visible
// clamp is not enforced here. Named in the NOT ENFORCED block of
// scripts/test-next-loading-gate.js.
let loadGate = null;
let wizardGen = 0;   // module-level, NEVER part of `state` — see the header
let root = null;

function isFresh(myGen) { return myGen === wizardGen; }
function byId(id) { return root ? root.querySelector('#' + id) : null; }
function qsa(sel) { return root ? Array.from(root.querySelectorAll(sel)) : []; }

// ═════════════════════════════════════════════════════════════════════════
// PURE LOGIC — no DOM, no fetch. Everything this wizard DECIDES lives here
// so scripts/test-next-mcp-wizard.js can drive it offline.
// ═════════════════════════════════════════════════════════════════════════

// THE single place GET /api/mcp/config's payload is interpreted.
//
// Deliberately the only function in this file that reads a raw backend
// field name, so a backend change (fields are being added to these
// responses in a parallel change; the contract is additive-only) is a
// one-line edit here rather than a hunt through render code. Every other
// function in this module consumes the normalised object it returns.
//
// Note on `installed`/`stale` when the config cannot be parsed: the route
// computes both inside its `!parseError` branch, so a corrupt file yields
// installed:false / stale:false — which is not "not connected", it is "we
// have no idea". That is why connection is reported as 'unknown' here and
// never rendered as a negative claim.
function interpretMcpConfig(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};

  const serverExists = c.mcp_server_exists === true;
  const domainsDirExists = c.domains_dir_exists === true;
  const configExists = c.claude_config_exists === true;
  const parseError = c.claude_config_parse_error === true;
  const installed = c.installed === true;
  const stale = c.stale === true;

  // Highest severity first. `null` means setup may proceed.
  let blocker = null;
  if (!serverExists) blocker = 'server-missing';
  else if (!domainsDirExists) blocker = 'domains-missing';
  else if (parseError) blocker = 'config-corrupt';

  let connection;
  if (parseError) connection = 'unknown';
  else if (installed && stale) connection = 'stale';
  else if (installed) connection = 'connected';
  else connection = 'absent';

  return {
    serverExists,
    domainsDirExists,
    configExists,
    parseError,
    connection,                       // 'connected' | 'stale' | 'absent' | 'unknown'
    blocker,                          // null when setup can proceed
    serverPath: typeof c.mcp_server_path === 'string' ? c.mcp_server_path : '',
    serverName: typeof c.mcp_server_name === 'string' ? c.mcp_server_name : 'my-curator',
    domainsDir: typeof c.domains_dir === 'string' ? c.domains_dir : '',
    nodeBinary: typeof c.node_binary === 'string' ? c.node_binary : '',
    configPath: typeof c.claude_config_path === 'string' ? c.claude_config_path : '',
  };
}

// The destructive-payload gate (defect 1). "Offered" here means BOTH
// "may be shown" and "may be requested from the server" — loadAll() calls
// this before issuing the /claude-full-config fetch, so in the refused
// case the payload never exists client-side at all.
function wholeFilePayloadAvailability(status) {
  if (!status || typeof status !== 'object') {
    return { offered: false, reason: 'We could not read the Curator’s MCP status.' };
  }
  if (status.parseError) {
    return {
      offered: false,
      reason: 'Your Claude Desktop config file exists but is not valid JSON, so The Curator cannot ' +
        'tell what is currently in it. A “whole file” replacement built from an unreadable file ' +
        'would silently drop every other MCP server you have configured.',
    };
  }
  return { offered: true, reason: null };
}

// The SECOND payload-interpretation function — this one for
// GET /api/mcp/claude-full-config. There are exactly two (one per endpoint
// that has a shape worth normalising), not one; saying otherwise would
// overclaim.
//
// This is a genuinely independent layer from wholeFilePayloadAvailability()
// above, not a restatement of it. That one reasons from /config's
// `claude_config_parse_error` and decides whether to REQUEST the payload;
// this one reasons from what /claude-full-config actually SENT and decides
// whether to USE it. Since v3.6.1 the route answers a corrupt file with
// `merge_available: false, merged: null` and a `merge_error` string — so a
// frontend that somehow got past the first gate still cannot show a
// destructive payload, and neither layer depends on the other holding.
//
// `merged` is required to be a non-null object as well as merge_available
// being not-false: a future state that set the flag but sent nothing must
// fail closed, not render an empty file as "your config".
function wholeFileUsable(status, wholeFile) {
  const gate = wholeFilePayloadAvailability(status);
  if (!gate.offered) return { usable: false, reason: gate.reason };
  if (!wholeFile || typeof wholeFile !== 'object') {
    return { usable: false, reason: 'The whole-file version could not be built.' };
  }
  if (wholeFile.merge_available === false) {
    return {
      usable: false,
      reason: typeof wholeFile.merge_error === 'string' && wholeFile.merge_error
        ? wholeFile.merge_error
        : 'The Curator could not build a whole-file version of your config.',
    };
  }
  if (!wholeFile.merged || typeof wholeFile.merged !== 'object') {
    return { usable: false, reason: 'The whole-file version came back empty.' };
  }
  return { usable: true, reason: null, wasEmpty: wholeFile.was_empty === true };
}

// v2.3.3 SPA-fallthrough guard (defect 6). Content-type decides first:
// src/server.js's `app.get('*')` returns index.html with HTTP 200, and a
// stale server answers an unknown POST with Express's HTML 404 — both are
// "your running app predates this feature", not "the request failed".
// A JSON body with a non-2xx status is a REAL error and is reported as one.
function classifyResponse(status, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html')) return 'html';
  const n = Number(status);
  if (!(n >= 200 && n < 300)) return 'http-error';
  return 'json';
}

const STALE_ROUTES_MESSAGE =
  'The Curator answered with a web page instead of data, which means the app that is running ' +
  'right now was started before this feature existed. Quit The Curator completely and reopen it, ' +
  'then try again.';

// Defect 3. The ONLY thing that decides whether a copy advances the step.
function copyOutcome(copied) {
  if (copied) {
    return { advance: true, tone: 'ok', message: 'Copied. Next: paste it into Claude Desktop’s config file.' };
  }
  return {
    advance: false,
    tone: 'error',
    message: 'Your browser refused the copy, so nothing reached your clipboard — ' +
      'you have NOT been moved on. Select the JSON above and copy it by hand (⌘C), then use “I copied it by hand”.',
  };
}

// Injected-dependency shell so the "a failed copy must not advance"
// invariant is testable with no DOM (see the suite's §3). The real
// handler passes real closures; the test passes fakes and asserts both
// directions.
async function runCopyAndAdvance({ copy, showStatus, advance, onCopied }) {
  let copied = false;
  try { copied = await copy() === true; } catch { copied = false; }
  const outcome = copyOutcome(copied);
  if (typeof showStatus === 'function') showStatus(outcome);
  if (outcome.advance) {
    if (typeof onCopied === 'function') onCopied();
    if (typeof advance === 'function') advance();
  }
  return outcome;
}

// Defect 5. Turns POST /api/mcp/self-test's body into something with a
// next step. That route NEVER returns a non-200 status and can answer
// ok:false with `error` undefined, so the "no error field at all" branch
// is the common one, not an edge case — it must never render as
// "Unknown error".
function describeSelfTest(r) {
  if (!r || typeof r !== 'object') {
    return {
      tone: 'error',
      headline: 'The self-test did not return a result we could read.',
      detail: '',
      steps: [
        'Quit The Curator completely and reopen it, then run the self-test again.',
        'If it keeps happening, the running app may be older than this screen — check Settings → Updates.',
      ],
      stderr: null,
    };
  }

  const stderr = (typeof r.stderr === 'string' && r.stderr.trim()) ? r.stderr.trim() : null;

  if (r.ok === true) {
    const count = Number(r.tool_count) || 0;
    if (count === 0) {
      return {
        tone: 'warn',
        headline: 'The bridge started, but reported no tools.',
        detail: 'It answered the handshake, so Node and the file path are fine — the tool list came back empty.',
        steps: [
          'Check Settings → Updates: a partly-applied update can leave the bridge without its tool modules.',
          'Quit The Curator completely, reopen it, and run the self-test again.',
        ],
        stderr,
      };
    }
    const domainsKnown = Array.isArray(r.domains);
    const domainCount = domainsKnown ? r.domains.length : 0;
    let detail = count + ' tools available.';
    if (domainsKnown && domainCount > 0) detail += ' ' + domainCount + ' domain' + (domainCount === 1 ? '' : 's') + ' visible.';
    else detail += ' No domains visible yet — that is expected on a brand-new install.';
    return {
      tone: 'ok',
      headline: 'The bridge works.',
      detail,
      steps: [],
      stderr,
    };
  }

  // ── Failure. Classify by what the route actually gave us. ─────────────
  const err = (typeof r.error === 'string' && r.error.trim()) ? r.error.trim() : null;

  if (err && /ENOENT|EACCES|spawn|not found|no such file/i.test(err)) {
    return {
      tone: 'error',
      headline: 'Node could not start the bridge program.',
      detail: err,
      steps: [
        'This is about The Curator’s own install, not about Claude Desktop — you can stop here and fix that first.',
        'Check Settings → Updates and let any pending update finish.',
        'If The Curator was moved or copied to a different folder, reinstall it in one place and reopen it.',
      ],
      stderr,
    };
  }

  if (stderr) {
    return {
      tone: 'error',
      headline: 'The bridge started and then failed.',
      detail: 'It printed the following while starting up:',
      steps: [
        'Read the output below — it usually names the file and line that failed.',
        'Check Settings → Updates; a failed dependency install is the usual cause.',
        'Then quit The Curator completely, reopen it, and run the self-test again.',
      ],
      stderr,
    };
  }

  return {
    tone: 'error',
    headline: 'The bridge started but never answered.',
    detail: err || 'It produced no error message and no output at all, so the handshake simply did not complete.',
    steps: [
      'Run the self-test once more — a slow first start can miss the handshake window.',
      'Quit The Curator completely (not just the browser tab) and reopen it.',
      'If it still fails, check Settings → Updates: a half-applied update leaves the bridge unable to load.',
    ],
    stderr,
  };
}

// Defect 4 — true for all four things `stale` actually detects.
const STALE_CAUSES = [
  'your knowledge folder moved',
  'The Curator itself was moved or reinstalled',
  'your Node install changed (a Homebrew or nvm upgrade changes its path)',
  'the entry was edited by hand',
];

// "a, b, c, or d" — a bare Array.join(', ') read as an unfinished list in
// the browser check.
function joinCauses(list) {
  if (list.length <= 1) return list.join('');
  if (list.length === 2) return list[0] + ' or ' + list[1];
  return list.slice(0, -1).join(', ') + ', or ' + list[list.length - 1];
}

// ── Blocked-state copy ───────────────────────────────────────────────────

function blockerFor(status) {
  if (!status || !status.blocker) return null;
  if (status.blocker === 'server-missing') {
    return {
      kind: 'server-missing',
      title: 'The bridge program is missing from this install',
      body: [
        'The Curator expects to find the MCP bridge at the path below, and it is not there. ' +
        'Claude Desktop cannot be connected until it is.',
        'This is an install problem, not a configuration one — nothing about your knowledge is affected.',
      ],
      pathLabel: 'Expected location',
      pathValue: status.serverPath,
      steps: [
        'Open Settings → Updates and let any pending update finish.',
        'If there is no update, reinstall The Curator and reopen it.',
      ],
      showReveal: false,
    };
  }
  if (status.blocker === 'domains-missing') {
    return {
      kind: 'domains-missing',
      title: 'Your knowledge folder isn’t where The Curator expects',
      body: [
        'The bridge serves whatever is in your knowledge folder, so setup cannot start until that folder ' +
        'is readable. The folder recorded in your settings does not exist right now.',
        'If you moved it, point The Curator at the new location — nothing has been lost.',
      ],
      pathLabel: 'Recorded location',
      pathValue: status.domainsDir,
      steps: [
        'Go to Settings → Knowledge base and choose the folder’s current location.',
        'If the folder is on an external drive or a synced folder, make sure it is mounted and finished syncing.',
        'Then reopen this wizard.',
      ],
      showReveal: false,
    };
  }
  // config-corrupt — the highest-severity state (defect 1).
  return {
    kind: 'config-corrupt',
    title: 'Your Claude Desktop config file can’t be read',
    body: [
      'The file below exists, but it is not valid JSON — usually a trailing comma, a missing bracket, ' +
      'or a quote that was never closed.',
      'Because it cannot be parsed, The Curator has no way to know what is already in it. Any file ' +
      'it offered you to paste would be built as if the file were empty, which would wipe out every ' +
      'other MCP server you have configured. So it is not offering one.',
      'Fix the JSON first — open the file in a text editor and correct the syntax, or rename it and let ' +
      'Claude Desktop create a fresh one — then come back here.',
    ],
    pathLabel: 'Config file',
    pathValue: status.configPath,
    steps: [
      'Open the file and fix the JSON syntax (any editor will highlight the problem line).',
      'If you would rather start over, rename it to claude_desktop_config.json.bak — Claude Desktop writes a new one, and you can copy your other servers back in afterwards.',
      'Then press “Check again” below.',
    ],
    showReveal: true,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Open / close
// ═════════════════════════════════════════════════════════════════════════

// opts.onDone(): called on close when anything the caller should re-read
// may have changed (i.e. after the wizard has run a self-test or a
// re-check). settings.js uses it to drop its cached state.mcp — that
// section caches on first visit (ensureSectionData only fetches when
// state.mcp === null), so a plain re-render after a successful setup would
// otherwise show the pre-setup status.
export function openMcpWizard(opts) {
  if (root) return;
  wizardGen += 1;
  const myGen = wizardGen;

  state = freshState();
  state.onDone = (opts && typeof opts.onDone === 'function') ? opts.onDone : null;
  state.prevFocus = document.activeElement;

  root = document.createElement('div');
  root.innerHTML = shellHtml();
  document.body.appendChild(root);

  document.addEventListener('keydown', onWizardKeydown, true);

  bindChrome();
  bindStep1();
  bindStep2();
  bindStep3();
  bindBlocked();

  // Delay-gated: the overlay chrome is already on screen, so a status read
  // that finishes in a few milliseconds shows no loading panel at all.
  loadGate = createLoadingGate({
    onChange: () => {
      if (!isFresh(myGen) || !loadGate || !loadGate.visible) return;
      showPhase('loading', myGen);
    },
  });
  loadGate.begin();
  Promise.resolve(loadAll(myGen)).finally(() => { settleGate(loadGate, () => {}); });
}

// Safe to call whether or not the wizard is open — views/settings.js's
// teardown calls it unconditionally, so an overlay never survives a view
// change (the same rule app.js's navigate() enforces for the reader).
//
// `notify: false` is LOAD-BEARING, not tidiness. app.js's navigate() runs
// the outgoing view's teardown at line ~432 and only increments mountToken
// at line ~441 — so DURING teardown the settings view's own
// isCurrentMount(token) is still TRUE. If this path fired onDone, that
// callback would pass its own guard and re-render a view that is being
// replaced one statement later. Suppressing the notification here is the
// structural fix; settings.js's isCurrentMount check is the second layer,
// and neither depends on the other being remembered.
export function closeMcpWizardIfOpen() {
  if (root) closeWizard({ notify: false });
}

function closeWizard(opts) {
  if (!root) return;
  const notify = !(opts && opts.notify === false);
  wizardGen += 1; // every in-flight handler from this session is now stale

  // No credential ever passes through this wizard, so there is no PAT-style
  // clearing to do here — but the config payloads are still user-specific
  // file contents, and root.remove() detaches nodes without clearing text.
  // Clearing the two <pre> payload nodes keeps a detached node from holding
  // a copy of the user's whole Claude Desktop config after close.
  const pre = byId('mcpw-payload-pre');
  if (pre) pre.textContent = '';

  // Timer hygiene (load-bearing): an armed delay timer that outlives this
  // overlay would call showPhase() against a detached (or re-opened) DOM.
  if (loadGate) { loadGate.cancel(); loadGate = null; }

  document.removeEventListener('keydown', onWizardKeydown, true);
  const prevFocus = state.prevFocus;
  const onDone = state.onDone;

  root.remove();
  root = null;
  state = freshState();

  if (prevFocus && typeof prevFocus.focus === 'function') {
    try { prevFocus.focus(); } catch { /* the element may be gone */ }
  }
  // Fired last, after the DOM and state are settled — the callback
  // re-renders the settings view, which must not run while this wizard's
  // node is still attached.
  // Notified on EVERY dismissal (except the teardown path above), not only
  // when the wizard "did something". Measured in-browser: the Settings MCP
  // section caches state.mcp on first visit, so after the config file
  // changed underneath it — which is the entire point of this wizard — its
  // status pill kept asserting the OLD state. An unconditional refetch of
  // two cheap local GETs is the right trade against a pill that lies.
  if (notify && onDone) { try { onDone(); } catch { /* caller's problem */ } }
}

function onWizardKeydown(e) {
  if (!root) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    closeWizard();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = qsa(
    'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const visible = focusables.filter((el) => el.offsetParent !== null);
  if (visible.length === 0) return;
  const first = visible[0];
  const last = visible[visible.length - 1];
  if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Loading
// ═════════════════════════════════════════════════════════════════════════

async function getJson(url, init) {
  const res = await fetch(url, init);
  const kind = classifyResponse(res.status, res.headers.get('content-type'));
  if (kind === 'html') {
    const e = new Error(STALE_ROUTES_MESSAGE);
    e.mcpwStaleRoutes = true;
    throw e;
  }
  if (kind === 'http-error') {
    let detail = '';
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') detail = body.error;
    } catch { /* body wasn't JSON after all — fall through to the status line */ }
    throw new Error(detail || ('The Curator answered with HTTP ' + res.status + '.'));
  }
  return res.json();
}

async function loadAll(myGen) {
  if (!isFresh(myGen)) return;
  let cfg;
  try {
    cfg = await getJson('/api/mcp/config');
  } catch (err) {
    if (!isFresh(myGen)) return;
    showLoadFailure(err, myGen);
    return;
  }
  if (!isFresh(myGen)) return;

  const status = interpretMcpConfig(cfg);
  state.status = status;

  const blocked = blockerFor(status);
  if (blocked) {
    state.blocker = blocked;
    renderBlocked();
    showPhase('blocked', myGen);
    return;
  }

  // The entry fragment is always safe to fetch — it is generated from the
  // Curator's own paths and never contains any of the user's file.
  try {
    state.snippet = await getJson('/api/mcp/claude-config');
  } catch (err) {
    if (!isFresh(myGen)) return;
    showLoadFailure(err, myGen);
    return;
  }
  if (!isFresh(myGen)) return;

  // Defect 1: the whole-file payload is REQUESTED only when the gate says
  // it may be offered. In the refused case it is never fetched, so it
  // cannot be shown by a later render bug either.
  const avail = wholeFilePayloadAvailability(status);
  if (avail.offered) {
    try {
      state.wholeFile = await getJson('/api/mcp/claude-full-config');
    } catch (err) {
      if (!isFresh(myGen)) return;
      // Not fatal: the entry payload alone completes setup.
      state.wholeFileError = err.message || 'Could not build the whole-file version.';
    }
  }
  if (!isFresh(myGen)) return;

  renderStep1();
  renderStep2();
  renderStep3();
  showPhase('steps', myGen);
  goToStep(1, myGen);
}

function showLoadFailure(err, myGen) {
  if (!isFresh(myGen)) return;
  state.blocker = err && err.mcpwStaleRoutes
    ? {
      kind: 'stale-routes',
      title: 'The Curator needs a restart',
      body: [STALE_ROUTES_MESSAGE],
      pathLabel: null,
      pathValue: '',
      steps: [
        'Quit The Curator completely — right-click its Dock icon → Quit. Closing the browser tab is not enough.',
        'Reopen it, come back to Settings → MCP bridge, and start the wizard again.',
      ],
      showReveal: false,
    }
    : {
      kind: 'load-failed',
      title: 'Could not read the MCP status',
      body: [String((err && err.message) || 'The request failed.')],
      pathLabel: null,
      pathValue: '',
      steps: ['Press “Check again”. If it keeps failing, quit The Curator completely and reopen it.'],
      showReveal: false,
    };
  renderBlocked();
  showPhase('blocked', myGen);
}

// ═════════════════════════════════════════════════════════════════════════
// Phase / step navigation
// ═════════════════════════════════════════════════════════════════════════

const PHASE_PANELS = { loading: 'loading', blocked: 'blocked' };
const STEP_PANELS = ['step-1', 'step-2', 'step-3'];
const ALL_PANELS = ['loading', 'blocked', ...STEP_PANELS];

function showPhase(phase, myGen) {
  if (!isFresh(myGen)) return;
  state.phase = phase;
  const progress = byId('mcpw-progress');
  if (progress) progress.classList.toggle('mcpw-hidden', phase !== 'steps');
  if (phase === 'steps') return; // goToStep does the rest
  for (const id of ALL_PANELS) {
    const p = byId('mcpw-panel-' + id);
    if (p) p.classList.add('mcpw-hidden');
  }
  const active = byId('mcpw-panel-' + PHASE_PANELS[phase]);
  if (active) {
    active.classList.remove('mcpw-hidden');
    focusHeading(active);
  }
}

function goToStep(n, myGen) {
  if (!isFresh(myGen)) return;
  state.step = n;
  for (const id of ALL_PANELS) {
    const p = byId('mcpw-panel-' + id);
    if (p) p.classList.add('mcpw-hidden');
  }
  const active = byId('mcpw-panel-' + STEP_PANELS[n - 1]);
  if (active) active.classList.remove('mcpw-hidden');

  // Panel content that depends on earlier choices is populated on ENTRY,
  // here — never when leaving the previous panel. (The shipping Shared
  // Brain wizard shipped that bug: step 2's link was empty on first entry.)
  if (n === 2) renderStep2();
  if (n === 3) renderStep3();

  qsa('.mcpw-pip').forEach((el) => {
    const num = Number(el.dataset.step);
    el.classList.toggle('active', num === n);
    el.classList.toggle('done', num < n);
    if (num === n) el.setAttribute('aria-current', 'step');
    else el.removeAttribute('aria-current');
  });

  if (active) focusHeading(active);
}

function focusHeading(panel) {
  const h = panel.querySelector('h3');
  if (!h) return;
  h.setAttribute('tabindex', '-1');
  h.focus({ preventScroll: false });
}

// ═════════════════════════════════════════════════════════════════════════
// Markup — every panel exists from first paint; handlers bind once.
// ═════════════════════════════════════════════════════════════════════════

function shellHtml() {
  return (
    '<div class="mcpw-scrim" id="mcpw-scrim">' +
      '<div class="mcpw-card" role="dialog" aria-modal="true" aria-labelledby="mcpw-title">' +
        '<button type="button" class="mcpw-close" id="mcpw-close" aria-label="Close">' + icon('x', 15) + '</button>' +
        '<div class="mcpw-header">' +
          '<div class="mcpw-header-icon">' + icon('cpu', 22) + '</div>' +
          '<h2 class="mcpw-title" id="mcpw-title">Connect Claude Desktop</h2>' +
          '<p class="mcpw-subtitle">Give Claude direct access to your wiki — reading it, and writing to it.</p>' +
        '</div>' +
        '<div class="mcpw-progress mcpw-hidden" id="mcpw-progress">' +
          [['1', 'Copy'], ['2', 'Paste'], ['3', 'Verify']].map(([n, label], i) => (
            (i > 0 ? '<div class="mcpw-pip-line"></div>' : '') +
            '<div class="mcpw-pip' + (n === '1' ? ' active' : '') + '" data-step="' + n + '">' +
              '<span class="mcpw-pip-num mono">' + n + '</span>' +
              '<span class="mcpw-pip-label">' + label + '</span>' +
            '</div>'
          )).join('') +
        '</div>' +
        panelLoading() +
        panelBlocked() +
        panelStep1() +
        panelStep2() +
        panelStep3() +
      '</div>' +
    '</div>'
  );
}

function panelLoading() {
  return (
    '<div id="mcpw-panel-loading" class="mcpw-panel mcpw-hidden">' +
      '<h3>Checking your setup…</h3>' +
      '<p class="mcpw-hint">Reading where the bridge lives, where your knowledge folder is, and whether ' +
      'Claude Desktop already has a config file.</p>' +
      '<div class="mcpw-actions">' +
        '<button type="button" class="btn btn-ghost" data-mcpw-action="close">Cancel</button>' +
      '</div>' +
    '</div>'
  );
}

function panelBlocked() {
  return (
    '<div id="mcpw-panel-blocked" class="mcpw-panel mcpw-hidden">' +
      '<h3 id="mcpw-blocked-title"></h3>' +
      '<div id="mcpw-blocked-body"></div>' +
      '<div class="mcpw-pathbox mcpw-hidden" id="mcpw-blocked-pathbox">' +
        '<span class="mcpw-path-label" id="mcpw-blocked-path-label"></span>' +
        '<code class="mono mcpw-path" id="mcpw-blocked-path"></code>' +
      '</div>' +
      '<div class="mcpw-checklist" id="mcpw-blocked-checklist">' +
        '<h4>What to do</h4>' +
        '<ol id="mcpw-blocked-steps"></ol>' +
      '</div>' +
      '<div class="mcpw-status mcpw-hidden" id="mcpw-blocked-status" aria-live="polite"></div>' +
      '<div class="mcpw-actions">' +
        '<button type="button" class="btn btn-ghost" data-mcpw-action="close">Close</button>' +
        '<button type="button" class="btn btn-secondary mcpw-hidden" id="mcpw-blocked-reveal">' + icon('folder', 14) + ' Show the file in Finder</button>' +
        '<button type="button" class="btn btn-primary" id="mcpw-blocked-recheck">Check again</button>' +
      '</div>' +
    '</div>'
  );
}

function panelStep1() {
  return (
    '<div id="mcpw-panel-step-1" class="mcpw-panel mcpw-hidden">' +
      '<h3>Copy the Curator entry</h3>' +
      '<div class="mcpw-note mcpw-hidden" id="mcpw-stale-note"></div>' +
      '<p class="mcpw-hint">Claude Desktop keeps its list of MCP servers in one JSON file. You need to get ' +
      'one entry into it, called <code>my-curator</code>. Pick which version to put on your clipboard — the ' +
      'next step gives you the matching instructions.</p>' +

      '<fieldset class="mcpw-choices">' +
        '<legend class="mcpw-label">What to copy</legend>' +
        '<label class="mcpw-choice">' +
          '<input type="radio" name="mcpw-payload" value="entry" checked>' +
          '<span class="mcpw-choice-text">' +
            '<strong>Just the Curator entry</strong>' +
            '<span id="mcpw-choice-entry-note">A few lines you add to the file yourself. The safe choice if you ' +
            'already use other MCP servers — nothing else in the file is touched.</span>' +
          '</span>' +
        '</label>' +
        '<label class="mcpw-choice" id="mcpw-choice-whole-label">' +
          '<input type="radio" name="mcpw-payload" value="whole">' +
          '<span class="mcpw-choice-text">' +
            '<strong id="mcpw-choice-whole-title">The whole file, with Curator added</strong>' +
            '<span id="mcpw-choice-whole-note"></span>' +
          '</span>' +
        '</label>' +
      '</fieldset>' +

      '<div class="mcpw-payload">' +
        '<div class="mcpw-payload-head">' +
          '<span class="mcpw-payload-name" id="mcpw-payload-name"></span>' +
        '</div>' +
        '<pre class="mono mcpw-pre" id="mcpw-payload-pre" tabindex="0"></pre>' +
      '</div>' +

      '<div class="mcpw-status mcpw-hidden" id="mcpw-step1-status" aria-live="polite"></div>' +

      '<div class="mcpw-actions">' +
        '<button type="button" class="btn btn-ghost" data-mcpw-action="close">Cancel</button>' +
        '<button type="button" class="btn btn-secondary mcpw-hidden" id="mcpw-manual-continue">I copied it by hand →</button>' +
        '<button type="button" class="btn btn-primary" id="mcpw-copy-continue"></button>' +
      '</div>' +
    '</div>'
  );
}

function panelStep2() {
  return (
    '<div id="mcpw-panel-step-2" class="mcpw-panel mcpw-hidden">' +
      '<h3>Paste it into Claude Desktop’s config</h3>' +
      '<div class="mcpw-clipchip" id="mcpw-clipchip"></div>' +
      '<div class="mcpw-pathbox">' +
        '<span class="mcpw-path-label">Config file</span>' +
        '<code class="mono mcpw-path" id="mcpw-config-path"></code>' +
      '</div>' +
      '<div class="mcpw-actions mcpw-actions-inline">' +
        '<button type="button" class="btn btn-secondary" id="mcpw-reveal">' + icon('folder', 14) + ' Show it in Finder</button>' +
        '<button type="button" class="btn btn-ghost" id="mcpw-copy-path">' + icon('copy', 13) + ' Copy the path</button>' +
      '</div>' +
      '<div class="mcpw-status mcpw-hidden" id="mcpw-step2-status" aria-live="polite"></div>' +
      '<div class="mcpw-checklist">' +
        '<h4 id="mcpw-paste-title">How to paste it</h4>' +
        '<ol id="mcpw-paste-steps"></ol>' +
      '</div>' +
      '<div class="mcpw-actions">' +
        '<button type="button" class="btn btn-secondary" data-mcpw-action="back-1">← Back</button>' +
        '<button type="button" class="btn btn-primary" id="mcpw-step2-next">I’ve saved the file →</button>' +
      '</div>' +
    '</div>'
  );
}

function panelStep3() {
  return (
    '<div id="mcpw-panel-step-3" class="mcpw-panel mcpw-hidden">' +
      '<h3>Restart Claude Desktop, then check it</h3>' +
      '<p class="mcpw-hint">Claude Desktop only reads that file at launch. <strong>Quit it completely</strong> ' +
      '(⌘Q, or Claude → Quit) — closing the window is not enough — then open it again.</p>' +
      '<div class="mcpw-actions mcpw-actions-inline">' +
        '<button type="button" class="btn btn-primary" id="mcpw-selftest">Test the bridge</button>' +
        '<button type="button" class="btn btn-secondary" id="mcpw-step3-recheck">Re-read the config file</button>' +
      '</div>' +
      '<p class="mcpw-hint mcpw-hint-tight">“Test the bridge” starts the Curator’s MCP program here and talks to ' +
      'it directly, so it tells you whether the bridge itself works — separately from whether Claude Desktop ' +
      'has found it. “Re-read the config file” checks what is now written in Claude Desktop’s config.</p>' +
      '<div class="mcpw-status mcpw-hidden" id="mcpw-step3-status" aria-live="polite"></div>' +
      '<div id="mcpw-selftest-result"></div>' +
      '<div class="mcpw-capabilities">' +
        '<h4>' + icon('sparkles', 13) + ' What Claude can do once this is connected</h4>' +
        '<p>' + TOOL_TOTAL + ' tools — ' + TOOL_READ + ' that read your wiki, ' + TOOL_WRITE + ' that write to it.</p>' +
        '<ul>' +
          '<li><strong>Read:</strong> search across domains, open a page, follow its links and backlinks, ' +
          'read a summary, look at the graph as a whole, and open the original file a summary was built from.</li>' +
          '<li><strong>Write:</strong> compile what you just worked out in a conversation straight into wiki ' +
          'pages, and scan and fix wiki health issues — without leaving Claude.</li>' +
        '</ul>' +
        '<p class="mcpw-capabilities-note">Write tools refuse on <code>shared-*</code> mirror domains by design, ' +
        'and every write is recorded in that domain’s local audit log.</p>' +
      '</div>' +
      '<div class="mcpw-actions">' +
        '<button type="button" class="btn btn-secondary" data-mcpw-action="back-2">← Back</button>' +
        '<button type="button" class="btn btn-primary" data-mcpw-action="close">Done</button>' +
      '</div>' +
    '</div>'
  );
}

// ═════════════════════════════════════════════════════════════════════════
// Rendering into the existing panels (never re-creating them)
// ═════════════════════════════════════════════════════════════════════════

function renderBlocked() {
  const b = state.blocker;
  if (!b) return;
  setText('mcpw-blocked-title', b.title);

  const body = byId('mcpw-blocked-body');
  if (body) {
    body.textContent = '';
    for (const para of (b.body || [])) {
      const p = document.createElement('p');
      p.className = 'mcpw-hint';
      p.textContent = para;      // backend-derived / free prose — never HTML
      body.appendChild(p);
    }
  }

  const pathbox = byId('mcpw-blocked-pathbox');
  if (pathbox) {
    const show = !!(b.pathLabel && b.pathValue);
    pathbox.classList.toggle('mcpw-hidden', !show);
    if (show) {
      setText('mcpw-blocked-path-label', b.pathLabel);
      setText('mcpw-blocked-path', b.pathValue);
    }
  }

  const stepsEl = byId('mcpw-blocked-steps');
  if (stepsEl) {
    stepsEl.textContent = '';
    for (const s of (b.steps || [])) {
      const li = document.createElement('li');
      li.textContent = s;
      stepsEl.appendChild(li);
    }
  }
  const checklist = byId('mcpw-blocked-checklist');
  if (checklist) checklist.classList.toggle('mcpw-hidden', !(b.steps && b.steps.length));

  const reveal = byId('mcpw-blocked-reveal');
  if (reveal) reveal.classList.toggle('mcpw-hidden', !b.showReveal);
}

function renderStep1() {
  const status = state.status;
  if (!status) return;

  // Defect 4 — the stale banner names every cause, not just one.
  const note = byId('mcpw-stale-note');
  if (note) {
    if (status.connection === 'stale') {
      note.textContent = 'Claude Desktop already has a “' + status.serverName + '” entry, but it points ' +
        'somewhere that no longer matches this install. That happens when ' + joinCauses(STALE_CAUSES) +
        '. Replacing that entry with the one below fixes it.';
      note.classList.remove('mcpw-hidden');
    } else if (status.connection === 'connected') {
      note.textContent = 'Claude Desktop already has a matching “' + status.serverName + '” entry. You can ' +
        'skip to step 3 and just test it.';
      note.classList.remove('mcpw-hidden');
    } else {
      note.textContent = '';
      note.classList.add('mcpw-hidden');
    }
  }

  // The whole-file choice: shown only when BOTH layers agree.
  const whole = wholeFileUsable(status, state.wholeFile);
  const wholeLabel = byId('mcpw-choice-whole-label');
  if (wholeLabel) wholeLabel.classList.toggle('mcpw-hidden', !whole.usable);
  if (!whole.usable && state.payloadChoice === 'whole') state.payloadChoice = 'entry';

  if (whole.usable) {
    const wasEmpty = whole.wasEmpty;
    setText('mcpw-choice-whole-title', wasEmpty
      ? 'The whole file (you don’t have one yet)'
      : 'The whole file, with Curator added');
    setText('mcpw-choice-whole-note', wasEmpty
      ? 'You have no config file yet, so this is the complete file to create. Nothing can be lost.'
      : 'Everything already in your file, plus Curator. You replace the file’s entire contents with this. ' +
        'Easier, but it overwrites — so only use it if the preview below really does show your other servers.');
  }

  syncPayloadRadios();
  renderPayload();
}

function syncPayloadRadios() {
  qsa('input[name="mcpw-payload"]').forEach((r) => { r.checked = (r.value === state.payloadChoice); });
}

// Re-checks wholeFileUsable() rather than trusting state.payloadChoice —
// the choice is set from a DOM radio, and the radio's visibility is a
// render concern. Anything that can put the destructive payload on the
// clipboard has to pass the same gate the render did.
function currentPayload() {
  if (state.payloadChoice === 'whole' && wholeFileUsable(state.status, state.wholeFile).usable) {
    return { kind: 'whole', label: 'the whole config file', json: state.wholeFile.merged };
  }
  return { kind: 'entry', label: 'just the Curator entry', json: state.snippet };
}

function renderPayload() {
  const p = currentPayload();
  const text = p.json ? JSON.stringify(p.json, null, 2) : '';
  const pre = byId('mcpw-payload-pre');
  if (pre) pre.textContent = text;         // JSON built from user paths — textContent only
  setText('mcpw-payload-name', p.kind === 'whole'
    ? 'Preview — your whole config file, with Curator added'
    : 'Preview — the Curator entry only');
  const btn = byId('mcpw-copy-continue');
  if (btn) {
    btn.textContent = p.kind === 'whole'
      ? 'Copy the whole file & continue →'
      : 'Copy the Curator entry & continue →';
    btn.disabled = !text;
  }
  // A fresh preview invalidates the previous copy attempt's message.
  hideStatus('mcpw-step1-status');
  const manual = byId('mcpw-manual-continue');
  if (manual) manual.classList.add('mcpw-hidden');
}

function renderStep2() {
  const status = state.status;
  setText('mcpw-config-path', status ? status.configPath : '');

  const kind = state.copiedPayload || (currentPayload().kind);
  const chip = byId('mcpw-clipchip');
  if (chip) {
    chip.textContent = state.copiedPayload
      ? 'On your clipboard: ' + (kind === 'whole' ? 'the whole config file.' : 'just the Curator entry.')
      : 'You said you copied ' + (kind === 'whole' ? 'the whole config file' : 'just the Curator entry') + ' by hand.';
    chip.classList.toggle('mcpw-clipchip-whole', kind === 'whole');
  }

  const fileExists = !!(status && status.configExists);
  setText('mcpw-paste-title', kind === 'whole'
    ? (fileExists ? 'How to replace the file' : 'How to create the file')
    : 'How to add the entry');

  let steps;
  if (kind === 'whole' && fileExists) {
    steps = [
      'Open the file below in a text editor.',
      'Select everything in it (⌘A) and paste over it (⌘V) — the copied version already contains what was there.',
      'Save the file (⌘S).',
    ];
  } else if (kind === 'whole') {
    steps = [
      'Open the folder below in Finder — if claude_desktop_config.json isn’t there, create it.',
      'Open it in a text editor and paste (⌘V). This is the complete file.',
      'Save the file (⌘S).',
    ];
  } else if (fileExists) {
    steps = [
      'Open the file below in a text editor.',
      'Find the "mcpServers": { … } block. If there isn’t one, paste the whole copied snippet at the top level of the object.',
      'If there is one, paste ONLY the "my-curator": { … } part inside it, and add a comma after the entry before it.',
      'Save the file (⌘S), and make sure the JSON is still valid — every entry but the last needs a trailing comma.',
    ];
  } else {
    steps = [
      'Open the folder below in Finder and create a file named claude_desktop_config.json.',
      'Paste (⌘V) into it — the copied snippet is already a complete, valid file on its own.',
      'Save the file (⌘S).',
    ];
  }
  const ol = byId('mcpw-paste-steps');
  if (ol) {
    ol.textContent = '';
    for (const s of steps) {
      const li = document.createElement('li');
      li.textContent = s;
      ol.appendChild(li);
    }
  }
}

function renderStep3() {
  const btn = byId('mcpw-selftest');
  if (btn) {
    btn.disabled = state.selfTestBusy;
    btn.textContent = state.selfTestBusy ? 'Testing…' : 'Test the bridge';
  }
  const recheck = byId('mcpw-step3-recheck');
  if (recheck) {
    recheck.disabled = state.recheckBusy;
    recheck.textContent = state.recheckBusy ? 'Checking…' : 'Re-read the config file';
  }
  renderSelfTest();
}

function renderSelfTest() {
  const host = byId('mcpw-selftest-result');
  if (!host) return;
  host.textContent = '';
  const d = state.selfTest;
  if (!d) return;

  const box = document.createElement('div');
  box.className = 'mcpw-result mcpw-result-' + d.tone;

  const head = document.createElement('div');
  head.className = 'mcpw-result-head';
  const glyph = document.createElement('span');
  glyph.className = 'mcpw-result-glyph';
  glyph.innerHTML = icon(d.tone === 'ok' ? 'checkAlt' : (d.tone === 'warn' ? 'alertTriangle' : 'x'), 14);
  head.appendChild(glyph);
  const headline = document.createElement('strong');
  headline.textContent = d.headline;    // fixed strings, but kept textContent for one rule, not two
  head.appendChild(headline);
  box.appendChild(head);

  if (d.detail) {
    const p = document.createElement('p');
    p.className = 'mcpw-result-detail';
    p.textContent = d.detail;           // may embed a raw error string
    box.appendChild(p);
  }

  if (d.steps && d.steps.length) {
    const ol = document.createElement('ol');
    ol.className = 'mcpw-result-steps';
    for (const s of d.steps) {
      const li = document.createElement('li');
      li.textContent = s;
      ol.appendChild(li);
    }
    box.appendChild(ol);
  }

  if (d.stderr) {
    const det = document.createElement('details');
    det.className = 'mcpw-stderr';
    const sum = document.createElement('summary');
    sum.textContent = 'Output from the bridge';
    det.appendChild(sum);
    const pre = document.createElement('pre');
    pre.className = 'mono';
    pre.textContent = d.stderr;         // child-process output — textContent, always
    det.appendChild(pre);
    box.appendChild(det);
  }

  host.appendChild(box);
}

// ── Small DOM helpers ────────────────────────────────────────────────────

function setText(id, value) {
  const el = byId(id);
  if (el) el.textContent = value == null ? '' : String(value);
}

function showStatus(id, tone, message) {
  const el = byId(id);
  if (!el) return;
  el.textContent = message;             // may carry a backend error string
  el.className = 'mcpw-status mcpw-status-' + tone;
}

function hideStatus(id) {
  const el = byId(id);
  if (!el) return;
  el.textContent = '';
  el.className = 'mcpw-status mcpw-hidden';
}

// ═════════════════════════════════════════════════════════════════════════
// Clipboard
// ═════════════════════════════════════════════════════════════════════════

// Returns true ONLY on a confirmed write. Never throws — every caller
// treats false as "nothing reached the clipboard" (defect 3).
async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'mcpw-offscreen';
    document.body.appendChild(ta);
    ta.select();
    const okFlag = document.execCommand && document.execCommand('copy');
    ta.value = '';
    ta.remove();
    return okFlag === true;
  } catch {
    return false;
  }
}

function selectPayloadForManualCopy() {
  const pre = byId('mcpw-payload-pre');
  if (!pre) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    pre.focus();
  } catch { /* selection is a convenience, never load-bearing */ }
}

// ═════════════════════════════════════════════════════════════════════════
// Handlers — all bound once, in open()
// ═════════════════════════════════════════════════════════════════════════

function bindChrome() {
  const closeBtn = byId('mcpw-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeWizard());
  const scrim = byId('mcpw-scrim');
  if (scrim) scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) closeWizard(); });
  qsa('[data-mcpw-action]').forEach((btn) => {
    const action = btn.dataset.mcpwAction;
    btn.addEventListener('click', () => {
      const myGen = wizardGen;
      if (action === 'close') closeWizard();
      else if (action === 'back-1') goToStep(1, myGen);
      else if (action === 'back-2') goToStep(2, myGen);
    });
  });
}

function bindStep1() {
  qsa('input[name="mcpw-payload"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      state.payloadChoice = radio.value === 'whole' ? 'whole' : 'entry';
      renderPayload();
    });
  });

  const copyBtn = byId('mcpw-copy-continue');
  if (copyBtn) copyBtn.addEventListener('click', () => onCopyAndContinue(wizardGen));

  const manual = byId('mcpw-manual-continue');
  if (manual) manual.addEventListener('click', () => {
    const myGen = wizardGen;
    state.copiedPayload = null;       // honest: we did NOT put it there
    goToStep(2, myGen);
  });
}

async function onCopyAndContinue(myGen) {
  if (!isFresh(myGen)) return;
  const p = currentPayload();
  const text = p.json ? JSON.stringify(p.json, null, 2) : '';
  if (!text) {
    showStatus('mcpw-step1-status', 'error', 'There is nothing to copy — reopen the wizard and try again.');
    return;
  }

  await runCopyAndAdvance({
    copy: () => copyText(text),
    showStatus: (outcome) => {
      if (!isFresh(myGen)) return;
      showStatus('mcpw-step1-status', outcome.tone, outcome.message);
      if (!outcome.advance) {
        selectPayloadForManualCopy();
        const manual = byId('mcpw-manual-continue');
        if (manual) manual.classList.remove('mcpw-hidden');
      }
    },
    onCopied: () => { if (isFresh(myGen)) state.copiedPayload = p.kind; },
    advance: () => goToStep(2, myGen),
  });
}

function bindStep2() {
  const reveal = byId('mcpw-reveal');
  if (reveal) reveal.addEventListener('click', () => onReveal(wizardGen, 'mcpw-step2-status', 'mcpw-reveal'));

  const copyPath = byId('mcpw-copy-path');
  if (copyPath) copyPath.addEventListener('click', async () => {
    const myGen = wizardGen;
    const pathValue = state.status ? state.status.configPath : '';
    const done = await copyText(pathValue);
    if (!isFresh(myGen)) return;
    if (done) showStatus('mcpw-step2-status', 'ok', 'Path copied.');
    else showStatus('mcpw-step2-status', 'error', 'Your browser refused the copy. The path is shown above — select it and copy it by hand.');
  });

  const next = byId('mcpw-step2-next');
  if (next) next.addEventListener('click', () => goToStep(3, wizardGen));
}

function bindStep3() {
  const test = byId('mcpw-selftest');
  if (test) test.addEventListener('click', () => onSelfTest(wizardGen));
  const recheck = byId('mcpw-step3-recheck');
  if (recheck) recheck.addEventListener('click', () => onRecheck(wizardGen, 'mcpw-step3-status'));
}

function bindBlocked() {
  const reveal = byId('mcpw-blocked-reveal');
  if (reveal) reveal.addEventListener('click', () => onReveal(wizardGen, 'mcpw-blocked-status', 'mcpw-blocked-reveal'));
  const recheck = byId('mcpw-blocked-recheck');
  if (recheck) recheck.addEventListener('click', () => onRecheckFromBlocked(wizardGen));
}

async function onReveal(myGen, statusId, btnId) {
  if (!isFresh(myGen) || state.revealBusy) return;
  state.revealBusy = true;
  const btn = byId(btnId);
  if (btn) btn.disabled = true;
  showStatus(statusId, 'checking', 'Opening Finder…');
  try {
    await getJson('/api/mcp/reveal-config', { method: 'POST' });
    if (!isFresh(myGen)) return;
    hideStatus(statusId);
  } catch (err) {
    if (!isFresh(myGen)) return;
    // POST /reveal-config is macOS-only server-side and answers 500 with a
    // JSON error — that is a real failure, not a "restart the app" case,
    // and classifyResponse() keeps the two apart.
    showStatus(statusId, 'error',
      (err && err.mcpwStaleRoutes)
        ? err.message
        : 'Could not open Finder (' + ((err && err.message) || 'unknown reason') + '). The path is shown above — open it yourself.');
  } finally {
    if (isFresh(myGen)) {
      state.revealBusy = false;
      const b = byId(btnId);
      if (b) b.disabled = false;
    }
  }
}

async function onSelfTest(myGen) {
  if (!isFresh(myGen) || state.selfTestBusy) return;
  state.selfTestBusy = true;
  state.selfTest = null;
  renderStep3();
  hideStatus('mcpw-step3-status');
  try {
    const body = await getJson('/api/mcp/self-test', { method: 'POST' });
    if (!isFresh(myGen)) return;
    state.selfTest = describeSelfTest(body);
  } catch (err) {
    if (!isFresh(myGen)) return;
    if (err && err.mcpwStaleRoutes) {
      state.selfTest = {
        tone: 'error',
        headline: 'The Curator needs a restart',
        detail: err.message,
        steps: [
          'Quit The Curator completely — right-click its Dock icon → Quit.',
          'Reopen it and run this test again.',
        ],
        stderr: null,
      };
    } else {
      state.selfTest = describeSelfTest(null);
      state.selfTest.detail = String((err && err.message) || '');
    }
  } finally {
    if (isFresh(myGen)) {
      state.selfTestBusy = false;
      renderStep3();
    }
  }
}

// Re-reads GET /api/mcp/config and reports what Claude Desktop's file now
// says. Deliberately does NOT re-enter loadAll(): from step 3 the user is
// mid-flow, and silently throwing them back to a blocked panel (or to
// step 1) after a successful paste would be worse than a sentence.
async function onRecheck(myGen, statusId) {
  if (!isFresh(myGen) || state.recheckBusy) return;
  state.recheckBusy = true;
  renderStep3();
  showStatus(statusId, 'checking', 'Re-reading the config file…');
  try {
    const cfg = await getJson('/api/mcp/config');
    if (!isFresh(myGen)) return;
    const s = interpretMcpConfig(cfg);
    state.status = s;
    if (s.connection === 'connected') {
      showStatus(statusId, 'ok', 'The config file now has a matching “' + s.serverName + '” entry. ' +
        'If Claude Desktop still doesn’t show the tools, quit it completely and reopen it.');
    } else if (s.connection === 'stale') {
      showStatus(statusId, 'warn', 'There is a “' + s.serverName + '” entry, but it doesn’t match this install. ' +
        'Go back to step 1, copy the entry again, and replace the old one.');
    } else if (s.connection === 'unknown') {
      showStatus(statusId, 'error', 'The config file is no longer valid JSON — the paste probably broke a comma ' +
        'or a bracket. Open it and fix the syntax, then check again.');
    } else if (!s.configExists) {
      showStatus(statusId, 'error', 'There is still no config file at that path. Make sure you saved it with the ' +
        'exact name claude_desktop_config.json.');
    } else {
      showStatus(statusId, 'error', 'The file is readable, but there is no “' + s.serverName + '” entry in it yet. ' +
        'Go back to step 2 and check the paste was saved.');
    }
  } catch (err) {
    if (!isFresh(myGen)) return;
    showStatus(statusId, 'error', String((err && err.message) || 'The check failed.'));
  } finally {
    if (isFresh(myGen)) {
      state.recheckBusy = false;
      renderStep3();
    }
  }
}

// From the BLOCKED panel the right behaviour is the opposite of step 3's:
// the whole point is to re-run the gate, so this re-enters loadAll().
async function onRecheckFromBlocked(myGen) {
  if (!isFresh(myGen) || state.recheckBusy) return;
  state.recheckBusy = true;
  const btn = byId('mcpw-blocked-recheck');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  showStatus('mcpw-blocked-status', 'checking', 'Checking again…');
  try {
    await loadAll(myGen);
  } finally {
    if (isFresh(myGen)) {
      state.recheckBusy = false;
      const b = byId('mcpw-blocked-recheck');
      if (b) { b.disabled = false; b.textContent = 'Check again'; }
      if (state.phase === 'blocked') {
        // Still blocked — say so, rather than leaving "Checking…" on screen.
        showStatus('mcpw-blocked-status', 'warn', 'Still not resolved. The details above are up to date.');
      }
    }
  }
}
