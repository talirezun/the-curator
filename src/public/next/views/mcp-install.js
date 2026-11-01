// Settings › MCP bridge › ① "Agent apps" (v3.88.0; rebuilt on the section kit
// in v3.89.0) — one fold row per agent app, the Next step card, the one-click
// install's preview and results, and the words for all of it.
//
// DOM-FREE AT IMPORT (the setup-machine.js / setup-step.js rule):
// scripts/test-next-mcp-install.js imports these builders in plain Node.
// settings.js owns the state, the listeners and what happens on a click; this
// file owns what is SAID, and the small request functions at the bottom (the
// only code here that touches the network, and only when called).
//
// WHAT THE PANEL MAY DO. The app may write ANOTHER app's config file only to
// add, update or remove its OWN `my-curator` entry — on a click, after a
// preview of the exact entry, with a copy of the original kept. The status
// check itself is read-only; Check entry (v3.89.0) starts the command an
// app's entry names, under the server's vetting rule, and writes nothing.
// Nothing in this file fires a request on its own: every request function is
// called from a click handler (or the one status read when the section
// loads), never from a render.
//
// THE WORD (v3.88.0, the owner's decision 1): a harness is an "agent app".
// "tool" means one of the bridge's MCP tools and nothing else on screen.
// On-disk names, payload fields and ids (`tools`, `data-mcpi-tool`) do not
// change.
//
// ONE ROW PER AGENT APP, ONE VERDICT PER APP (v3.88.0). Three readings feed a
// row — the install status (GET /api/mcp/install/status), the machine reading
// (GET /api/setup/machine: files, skills, hooks) and the open bridges (GET
// /api/mcp/config `bridge_processes`) — each through ONE adapter below, so a
// payload shape is read in exactly one place.
//
// THE PAGE CONTRACT (v3.89.0, scripts/test-next-page-contract.js) — this file
// draws ONLY with the section kit (shared/section.js) and shared/text.js:
//   · an app is a FOLD ROW: label · a "N to fix" pill · its one reading;
//     its body (closed by default) is the evidence and the row's own actions;
//   · a FAULT WITH ACTIONS is the ONE tinted Next step card at the top of ①,
//     never a warning behind a chevron; the plan and the results take that
//     card's place while they are on screen;
//   · an outcome or error with no action is `renderStatus`, unfolded;
//   · an older bridge serving the SAME tool list is one quiet line, never a
//     warning (the owner's decision 3);
//   · mono only for a path, inside a fold item — never inside a sentence;
//   · explanations live in the section's ⓘ (explainers.js), never inline;
//   · every path, app name and server name is escaped.

import { ageWordsFor } from '../shared/age-ticker.js';
import { machineWord as platformMachineWord } from '../shared/platform.js';
import { renderStatus, renderDescription } from '../shared/text.js';
import { renderFoldRows, renderFoldRow, renderFoldItem, renderActionCard, renderStatusLine, renderFoldLine } from '../shared/section.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const isStr = (v) => typeof v === 'string' && v.length > 0;

/** "PC" on Windows, "Mac" on macOS, "computer" elsewhere — shared/platform.js's words. */
export function machineWord(platform) { return platformMachineWord(platform); }

// ── the vocabulary ─────────────────────────────────────────────────────────

/**
 * One word per install status. Frozen; an unknown status reads as not connected.
 * `manual` is "not connected" (v3.88.0): "copy only" described the installer,
 * not the app's state.
 */
export const STATUS_WORDS = Object.freeze({
  connected: 'connected',
  'needs-update': 'needs an update',
  'not-installed': 'can be added',
  'cant-read': 'can’t read',
  manual: 'not connected',
});
export const STATUSES = Object.freeze(Object.keys(STATUS_WORDS));

/** The statuses whose row is ticked by default (contract §1). */
export const DEFAULT_TICKED = Object.freeze(['needs-update', 'not-installed']);

const normStatus = (s) => (Object.hasOwn(STATUS_WORDS, s) ? s : 'manual');

/** v3.86.0 — on Windows only Claude Desktop can be written; every other app is copy-only. */
export const WINDOWS_INSTALLABLE = Object.freeze(['claude-desktop']);
/** The small greyscale label on the one Windows row that can be installed. */
export const WINDOWS_NEW_LABEL = 'New on Windows — tell us if it works';
/** Said OPEN after Claude Desktop is changed on Windows. */
export const WINDOWS_RESTART_LINE = 'Quit Claude Desktop fully (system tray → Quit), reopen it, then press Check again';

/** Whether a click may write this app's file on this platform ('' / darwin / linux: the status decides). */
function writableHere(tool, platform) {
  return platform !== 'win32' || (!!tool && WINDOWS_INSTALLABLE.includes(tool.id));
}

/** The apps whose row offers a checkbox: the ones a click may write to. */
export function isInstallable(tool, platform) {
  return !!tool && (tool.status === 'needs-update' || tool.status === 'not-installed') && tool.installer === 'file'
    && writableHere(tool, platform);
}

/** An app's status as this platform shows it: a Windows row that cannot be written reads "not connected". */
function effStatus(tool, platform) {
  const s = normStatus(tool && tool.status);
  return (s === 'needs-update' || s === 'not-installed') && !writableHere(tool, platform) ? 'manual' : s;
}

/** `{connected, needsUpdate, canAdd, cantRead, manual}` over a status payload's apps. Pure. */
export function countStatuses(tools, platform) {
  const c = { connected: 0, needsUpdate: 0, canAdd: 0, cantRead: 0, manual: 0 };
  for (const t of Array.isArray(tools) ? tools : []) {
    const s = effStatus(t, platform);
    if (s === 'connected') c.connected++;
    else if (s === 'needs-update') c.needsUpdate++;
    else if (s === 'not-installed') c.canAdd++;
    else if (s === 'cant-read') c.cantRead++;
    else c.manual++;
  }
  return c;
}

/** Which app ids start ticked. `overrides` (id → boolean) are the person's own ticks. Pure. */
export function defaultTicks(tools, overrides, platform) {
  const out = {};
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || !isStr(t.id) || !isInstallable(t, platform)) continue;
    out[t.id] = Object.hasOwn(ov, t.id) ? ov[t.id] === true : DEFAULT_TICKED.includes(t.status);
  }
  return out;
}

/** The ids the Install button would send, in the payload's order. */
export function tickedIds(tools, overrides, platform) {
  const ticks = defaultTicks(tools, overrides, platform);
  return (Array.isArray(tools) ? tools : []).filter((t) => t && ticks[t.id] === true).map((t) => t.id);
}

/**
 * The Install button's label and whether it is disabled. When nothing on a
 * computer that CAN write needs installing, the label says so — "Nothing to
 * install" (v3.88.0, truth audit T7: a disabled primary button with no word).
 */
export function installButtonState(status, ticks, busy) {
  const data = status && status.data;
  const tools = data && Array.isArray(data.tools) ? data.tools : [];
  const n = tickedIds(tools, ticks, data && data.platform).length;
  const writable = !!(data && data.writable);
  const anyInstallable = tools.some((t) => isInstallable(t, data && data.platform));
  const disabled = !writable || n === 0 || !!busy;
  // The backend's words for a disabled button win (BE amendment 1 §B, `install.disabledText`).
  const said = data && data.install && typeof data.install === 'object' && isStr(data.install.disabledText) ? data.install.disabledText : '';
  return {
    n,
    label: n > 1 ? 'Install for me (' + n + ' apps)'
      : (disabled && !busy && said && !anyInstallable ? said
        : (writable && !anyInstallable ? 'Nothing to install' : 'Install for me')),
    disabled,
  };
}

// ── the three adapters — ONE function per data source ──────────────────────

/** "10:01" when the stamp is today on this clock, else "31 Oct". '' when it cannot be read. */
export function clockWords(iso, now = Date.now()) {
  const t = isStr(iso) ? new Date(iso) : null;
  if (!t || !Number.isFinite(t.getTime())) return '';
  const n = new Date(now);
  const pad = (x) => String(x).padStart(2, '0');
  if (t.toDateString() === n.toDateString()) return pad(t.getHours()) + ':' + pad(t.getMinutes());
  return t.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getMonth()];
}

const BRIDGE_TOOLS = new Set(['same', 'changed', 'unknown']);

/**
 * ADAPTER 1 — the bridges open right now, from GET /api/mcp/config's
 * `bridge_processes`. The ONLY function in the app that reads that field.
 *
 * Returns `{checked, reason, running, list}`; each entry is
 * `{pid, appId, appLabel, version, startedAt, tools: 'same'|'changed'|'unknown',
 *   missing: [MCP tool names], remedy}`.
 *
 *   · `checked: false` — the app did not look. Never read as "none open".
 *   · A payload older than v3.88.0 lists only `stale` processes, with no app
 *     and no tool comparison: each reads `tools: 'unknown'`, `appId: null` —
 *     the honest reading of a bridge whose tool list nobody recorded.
 *   · `remedy` is the PAYLOAD's sentence (per process, else the route's one
 *     sentence) — the view never authors the quit step.
 */
export function adaptBridges(cfg) {
  const bp = cfg && cfg.bridge_processes;
  if (!bp || typeof bp !== 'object' || bp.checked !== true) {
    return { checked: false, reason: bp && isStr(bp.reason) ? bp.reason : null, running: null, list: [] };
  }
  // v3.88.0 (BE amendment 1 §A): `bridges[]` is every open bridge with its
  // parent app, its tool comparison (by hash, never by mtime) and the
  // backend's own `notice`. An older payload has only `stale[]`, whose entries
  // carry no app and no comparison, and the route's one remedy sentence.
  const modern = Array.isArray(bp.bridges);
  const fallbackRemedy = modern ? '' : (isStr(cfg.bridge_stale_remedy) ? cfg.bridge_stale_remedy : '');
  const src = modern ? bp.bridges : (Array.isArray(bp.stale) ? bp.stale : []);
  const list = src.filter((p) => p && typeof p === 'object').map((p) => {
    const app = p.app && typeof p.app === 'object' ? p.app : null;
    const appId = app && isStr(app.id) ? app.id : null;
    const appLabel = app && isStr(app.label) ? app.label : null;
    const tools = p.tools === 'different' ? 'changed' : (BRIDGE_TOOLS.has(p.tools) ? p.tools : 'unknown');
    return {
      pid: Number.isInteger(p.pid) ? p.pid : null,
      appId, appLabel,
      version: isStr(p.version) ? p.version : null,
      startedAt: isStr(p.startedAt) ? p.startedAt : null,
      tools,
      // The backend decides what is worth saying; an older payload's stale
      // entries are "can't tell", softly.
      notice: NOTICES.has(p.notice) ? p.notice : (modern ? noticeFor(tools) : 'soft'),
      missing: Array.isArray(p.missing) ? p.missing.filter(isStr) : [],
      remedy: isStr(p.remedy) ? p.remedy : fallbackRemedy,
    };
  });
  const cur = bp.current && typeof bp.current === 'object' ? bp.current : {};
  return {
    checked: true, reason: null, running: Number.isInteger(bp.running) ? bp.running : list.length, list,
    current: { version: isStr(cur.version) ? cur.version : null, toolCount: Number.isInteger(cur.toolCount) ? cur.toolCount : null },
  };
}

const NOTICES = new Set(['warn', 'soft', 'quiet', 'none']);
function noticeFor(tools) { return tools === 'changed' ? 'warn' : tools === 'unknown' ? 'soft' : 'quiet'; }

/**
 * An install-status row's own `bridges` summary (BE amendment 1 §B) as the
 * same fact shape `adaptBridges` gives one bridge. null when there is none.
 */
export function rowBridgeFact(b) {
  if (!b || typeof b !== 'object') return null;
  const tools = b.tools === 'different' ? 'changed' : (BRIDGE_TOOLS.has(b.tools) ? b.tools : 'unknown');
  return {
    pid: null, appId: null, appLabel: null,
    version: isStr(b.version) ? b.version : null,
    startedAt: isStr(b.oldestStartedAt) ? b.oldestStartedAt : null,
    tools, notice: NOTICES.has(b.notice) ? b.notice : noticeFor(tools),
    missing: Array.isArray(b.missing) ? b.missing.filter(isStr) : [],
    remedy: isStr(b.remedy) ? b.remedy : '',
    count: Number.isInteger(b.count) ? b.count : null,
    toolCount: Number.isInteger(b.toolCount) ? b.toolCount : null,
  };
}

/**
 * ADAPTER 2 — the machine reading, GET /api/setup/machine `{data, error, loading}`.
 * `{byId, harnesses, home, version, install, checkedAt, skillsShipped,
 * copyEntries}`, or null before it lands. `home` is the home folder as the
 * payload itself shows it (a file's absolute path beside its "~/…" display),
 * so a path elsewhere on the page can be shortened the same way — never guessed.
 */
export function adaptMachine(m) {
  const d = m && m.data;
  if (!d || !Array.isArray(d.harnesses)) return null;
  const byId = {};
  let home = '';
  for (const h of d.harnesses) {
    if (!h || !isStr(h.id)) continue;
    byId[h.id] = h;
    for (const f of Array.isArray(h.files) ? h.files : []) {
      if (!home && f && isStr(f.file) && isStr(f.display) && f.display.startsWith('~/')
          && f.file.endsWith(f.display.slice(1)) && f.file.length > f.display.length - 1) {
        home = f.file.slice(0, f.file.length - (f.display.length - 1));
      }
    }
  }
  return {
    byId, harnesses: d.harnesses.filter((h) => h && isStr(h.id)), home,
    version: isStr(d.version) ? d.version : null,
    install: isStr(d.install) ? d.install : null,
    checkedAt: isStr(d.checkedAt) ? d.checkedAt : null,
    skillsShipped: d.skillsShipped === true,
    copyEntries: d.copyEntries && typeof d.copyEntries === 'object' ? d.copyEntries : {},
    raw: d,
  };
}

/** `/Users/x/second-brain` → `~/second-brain` when the machine reading named the home. */
export function tildePath(p, home) {
  if (!isStr(p)) return '';
  const h = isStr(home) ? home.replace(/[/\\]$/, '') : '';
  if (!h) return p;
  return p === h ? '~' : (p.startsWith(h + '/') ? '~' + p.slice(h.length) : p);
}

/**
 * ADAPTER 3 — one app's install-status row, with the relation "this app
 * reaches My Curator through ANOTHER app's entry" (Claude Code inside the
 * Claude app reads Claude Desktop's file — truth audit T2). The payload's own
 * `connectedVia` wins; otherwise it is read from the machine reading: the
 * app's bridge cell is ok only through a `readAlso` file, and that file is the
 * OWN file of another app on the reading.
 */
export function adaptInstallTool(t, machine) {
  const tool = t && typeof t === 'object' ? t : {};
  let via = null;
  const cv = tool.connectedVia;
  const labelOf = (id) => (machine && machine.byId[id] && machine.byId[id].label) || id;
  if (cv && typeof cv === 'object' && isStr(cv.id)) via = { id: cv.id, label: isStr(cv.label) ? cv.label : labelOf(cv.id), text: isStr(cv.text) ? cv.text : null };
  else if (isStr(cv)) via = { id: cv, label: labelOf(cv) };
  else if (machine && machine.byId[tool.id]) {
    const h = machine.byId[tool.id];
    if (h.bridge && h.bridge.state === 'ok' && h.bridge.via === 'readAlso') {
      const f = (h.files || []).find((x) => x && x.via === 'readAlso' && x.named);
      const owner = f && machine.harnesses.find((o) => o.id !== h.id
        && (o.files || []).some((x) => x && x.via !== 'readAlso' && x.file === f.file));
      via = owner ? { id: owner.id, label: owner.label || owner.id } : { id: null, label: 'another app' };
    }
  }
  return { ...tool, via };
}

// ── words ─────────────────────────────────────────────────────────────────

/** The reading of an app that reaches My Curator through another app's entry. */
export function viaWord(tool) {
  const v = tool && tool.via;
  if (!v) return '';
  return 'through ' + (v.id === 'claude-desktop' ? 'Claude Desktop' : (v.label || 'another app'));
}

const btnG = (act, label, extra = '') => '<button type="button" class="btn btn-ghost btn-xs" data-mcpi-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';

// ── copying an entry by hand ───────────────────────────────────────────────

/** A refusal reason as one sentence: the status sends `{code, message}`; older shapes send a string. */
export function reasonText(r) {
  if (isStr(r)) return r;
  return r && isStr(r.message) ? r.message : '';
}

/**
 * What Copy puts on the clipboard for one tool, and the line that says what to
 * do with it. Pure. `data` is the status payload (its `tools` and
 * `manualSnippets`); `machineFiles` (id → [{display, file, present}]) names
 * the files of a tool the status read could not (copy-only rows).
 *
 *   · the tool's file does not exist yet → the WHOLE small document, "Save as <file>";
 *   · the file exists, JSON → ONLY the my-curator entry, "Paste into <file> inside "<key>"";
 *   · any other format (TOML, YAML…) → the snippet as the tool writes it, "Add this to <file>".
 */
export function copyPlanFor(id, data, machineFiles) {
  const snippets = data && data.manualSnippets && typeof data.manualSnippets === 'object' ? data.manualSnippets : {};
  const whole = isStr(snippets[id]) ? snippets[id] : '';
  if (!whole) return null;
  const tool = (data && Array.isArray(data.tools) ? data.tools : []).find((t) => t && t.id === id);
  let file = null; let exists = null;
  const own = tool && Array.isArray(tool.files) ? tool.files.filter((f) => f && isStr(f.display)) : [];
  if (own.length) { file = own[0].display; exists = own[0].state !== 'missing'; }
  else {
    const mf = machineFiles && Array.isArray(machineFiles[id]) ? machineFiles[id].filter((f) => f && isStr(f.display)) : [];
    const pick = mf.find((f) => f.present) || mf[0];
    if (pick) { file = pick.display; exists = pick.present === true; }
  }
  let key = null; let inner = null;
  try {
    const doc = JSON.parse(whole);
    const top = doc && typeof doc === 'object' && !Array.isArray(doc) ? Object.keys(doc)[0] : null;
    const group = top ? doc[top] : null;
    const name = group && typeof group === 'object' && !Array.isArray(group) ? Object.keys(group)[0] : null;
    if (top && name) { key = top; inner = JSON.stringify({ [name]: group[name] }, null, 2).replace(/^\{\n?/, '').replace(/\n?\}$/, '').replace(/^ {2}/gm, ''); }
  } catch { /* not JSON: copied as the tool writes it */ }
  if (!file) {
    return { text: whole, whole: true, file: null, line: 'Add this to the app’s own MCP config file.' };
  }
  if (exists === false) return { text: whole, whole: true, file, line: 'Save as ' + file };
  if (inner && key) return { text: inner, whole: false, file, line: 'Paste into ' + file + ' inside "' + key + '"' };
  return { text: whole, whole: true, file, line: 'Add this to ' + file };
}



/**
 * The reason an app is not connected, in words. `config_not_found` and
 * `config_ambiguous` (v3.86.0) are said for a person; any other reason is the
 * backend's own message. Candidate files come from the reason, else the row's files.
 */
export function reasonWords(tool) {
  const r = tool && tool.reason;
  const code = r && typeof r === 'object' ? r.code : '';
  const names = (list) => (Array.isArray(list) ? list : []).map((x) => (isStr(x) ? x : x && (x.display || x.file))).filter(isStr);
  if (code === 'config_not_found') return 'Open Claude Desktop once, then press Check again';
  if (code === 'config_ambiguous') {
    const live = (Array.isArray(tool.candidates) ? tool.candidates : []).filter((x) => x && x.live);
    const c = names(r.candidates).length ? names(r.candidates) : names(live).length ? names(live) : names(tool.files);
    return 'Claude Desktop has more than one config file' + (c.length ? ': ' + c.join(' · ') : '')
      + ' — nothing was changed. Add the entry to the one it uses.';
  }
  return reasonText(r);
}

/** The installer codes whose sentence the row's own copy line replaces (v3.88.0). */
const INSTALLER_REASONS = new Set(['installer_cli', 'installer_manual']);


/** The absolute path to reveal for a file's display path, or '' (the status read does not send it). */
function revealPathFor(tool, paths) {
  const files = Array.isArray(tool.files) ? tool.files : [];
  const map = paths && typeof paths === 'object' ? paths : {};
  for (const f of files) {
    if (f && isStr(f.file)) return f.file;
    if (f && isStr(f.display) && isStr(map[f.display])) return map[f.display];
  }
  return '';
}

/**
 * Windows only (v3.86.0 audit): the backend REFUSES to write Claude Desktop's
 * file while it runs (`app_running`), so the row says so before anyone clicks.
 * macOS keeps its warn-and-allow lines unchanged.
 */
export const APP_RUNNING_WORDS = 'Claude Desktop is running. Quit Claude Desktop fully (system tray → Quit), then press Install for me.';
/** Windows only: Claude Desktop is running, so Install for me is refused until it is quit. */
function appRunningHere(tool, platform) {
  const r = tool && tool.running;
  return platform === 'win32' && !!tool && tool.id === 'claude-desktop' && !!r && r.checked === true && r.running === true;
}

// ── the warnings a row can carry ───────────────────────────────────────────

/** Reveal is `open -R` (macOS only): never a dead button on Windows or Linux. */
const canReveal = (platform) => !isStr(platform) || platform === 'darwin';

/**
 * The open bridges of ONE app, reduced to the one fact worth saying.
 * changed > unknown > same; within a kind, the oldest. Pure.
 */
export function bridgeFactFor(appId, bridges) {
  const list = bridges && Array.isArray(bridges.list) ? bridges.list.filter((b) => b.appId && b.appId === appId) : [];
  if (!list.length) return null;
  const rank = { warn: 0, soft: 1, quiet: 2, none: 3 };
  return list.slice().sort((a, b) => ((rank[a.notice] ?? 3) - (rank[b.notice] ?? 3))
    || String(a.startedAt || '').localeCompare(String(b.startedAt || '')))[0];
}

/**
 * The STALE-BRIDGE RULE (v3.88.0, the owner's decision 3), as data. Pure.
 *   · tools changed → a WARNING, naming what is missing, with the payload's quit step;
 *   · unknown (no tool list recorded) → ONE soft warning, "can't tell";
 *   · same tools on an older version → one QUIET line, never a warning;
 *   · same tools, same version → nothing.
 * Returns `{warn?: {...}, quiet?: string, tag?: string}`.
 */
export function bridgeRowFact(label, fact, current = {}, now = Date.now()) {
  if (!fact) return {};
  const at = clockWords(fact.startedAt, now);
  const v = fact.version;
  // The backend's `notice` decides (BE amendment 1 §A); without one it is
  // derived from the comparison the same way.
  const notice = NOTICES.has(fact.notice) ? fact.notice : noticeFor(fact.tools);
  if (notice === 'none') return {};
  if (notice === 'warn') {
    const lacks = fact.missing.length ? ' — it lacks ' + fact.missing.join(' and ') + '.'
      : ' — its tool list differs from this version’s.';
    return {
      tag: 'restart needed',
      warn: { kind: 'bridge', tone: 'warn', text: label + ' is still using ' + (v ? 'My Curator ' + v : 'an older My Curator')
        + (at ? ', opened at ' + at : '') + lacks, strong: fact.remedy || '' },
    };
  }
  if (notice === 'soft') {
    return {
      warn: { kind: 'bridge-unknown', tone: 'quiet', soft: true, text: label + ' has had My Curator open'
        + (at ? ' since ' + at : '') + ', from before this version, so The Curator can’t tell whether its tools changed.'
        + (fact.remedy ? ' If its agent is missing a tool: ' + fact.remedy : '') },
    };
  }
  // quiet: the same tools, an older (or unrecorded) version. Never a warning.
  if (v && isStr(current.version) && v === current.version) return {};
  const tc = Number.isInteger(fact.toolCount) ? fact.toolCount : current.toolCount;
  const n = Number.isInteger(tc) ? 'the same ' + tc + ' tools' : 'the same tools';
  const cv = isStr(current.version) ? current.version : 'this version';
  return { quiet: 'Running ' + (v ? 'My Curator ' + v : 'an older My Curator') + (at ? ' since ' + at : '') + ' — ' + n + ' as ' + cv
    + '. It moves to ' + cv + ' the next time you quit ' + label + '.' };
}

/**
 * The machine reading's faults for one app, as warnings with their own
 * buttons. The payload's own to-fix items win when it sends them (`toFix`:
 * `{kind, text, detail, fixes:[{kind, label, path?, skill?}]}`, setup-check's
 * `item()` shape — the same sentence Context › Setup prints); otherwise they
 * are read from the cells. Pure.
 */
export function machineWarnings(h, ctx = {}) {
  if (!h) return [];
  const label = h.label || h.id;
  const out = [];
  if (Array.isArray(h.toFix) && h.toFix.length) {
    for (const it of h.toFix) {
      if (!it || !isStr(it.text)) continue;
      out.push({ kind: isStr(it.kind) ? it.kind : 'setup', tone: 'warn', text: it.text, strong: isStr(it.detail) ? it.detail : '',
        acts: (Array.isArray(it.fixes) ? it.fixes : []).map((f) => fixAct(f, ctx)).filter(Boolean) });
    }
    return out;
  }
  const s = h.skills || {};
  if (s.state === 'fix') {
    for (const x of Array.isArray(s.installed) ? s.installed : []) {
      if (!x || x.match !== false) continue;
      const nd = (x.differs || []).length; const nm = (x.missing || []).length;
      const how = [nd ? nd + (nd === 1 ? ' file differs' : ' files differ') : '', nm ? nm + (nm === 1 ? ' file missing' : ' files missing') : ''].filter(Boolean).join(', ');
      const name = isStr(x.skill) ? x.skill : 'my-curator';
      out.push({ kind: 'skill', tone: 'warn',
        text: 'Its ' + name + ' skill is older than this app’s copy' + (how ? ' (' + how + ').' : '.'),
        strong: 'Download it, replace ' + (x.dirDisplay || x.dir || 'the skill folder') + ' with it, then start a new ' + label + ' session.',
        acts: [fixAct({ kind: 'download-skill', skill: name }, ctx), x.dir ? fixAct({ kind: 'reveal', path: x.dir, label: 'Reveal folder' }, ctx) : null].filter(Boolean) });
    }
  }
  if (h.hooks && h.hooks.state === 'fix') {
    out.push({ kind: 'hooks', tone: 'warn', text: 'Its Curator hooks need attention: ' + (h.hooks.word || 'see the files below') + '.', strong: '', acts: [] });
  }
  if (ctx.status === 'connected' && h.bridge && h.bridge.state === 'fix') {
    out.push({ kind: 'bridge-file', tone: 'warn', text: 'Its MCP entry needs attention: ' + (h.bridge.word || 'see the files below') + '.', strong: '', acts: [] });
  }
  return out;
}

/** One fix button. Download is a plain link to this app's own copy; Reveal is macOS only. */
function fixAct(f, ctx) {
  if (!f || typeof f !== 'object') return null;
  const kind = f.kind;
  if (kind === 'download-skill' || kind === 'downloadSkill') {
    // Only this app's own zip route — a payload `href` elsewhere is never followed.
    const skill = isStr(f.skill) ? f.skill.replace(/[^A-Za-z0-9_-]/g, '') : 'my-curator';
    return '<a class="btn btn-secondary btn-xs" href="/api/setup/skills/' + skill + '.zip" download data-mcpi-download="' + skill + '">'
      + escapeHtml(isStr(f.label) && !/^Download$/i.test(f.label) ? f.label : 'Download ' + skill + '.zip') + '</a>';
  }
  if (kind === 'reveal' && isStr(f.path) && canReveal(ctx.platform)) {
    return '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="reveal" data-path="' + escapeHtml(f.path) + '">'
      + escapeHtml(isStr(f.label) ? f.label.replace(/^Reveal the folder$/, 'Reveal folder') : 'Reveal') + '</button>';
  }
  return null;
}

// ── one row per agent app ──────────────────────────────────────────────────

/**
 * Everything one row says, as data. Pure — the overview counts it and
 * `appFoldRow` / `nextStepCard` draw it, so the three can never disagree.
 *
 * `ctx`: `{platform, writable, ticks, data (status payload), machine (adaptMachine),
 * bridges (adaptBridges), paths, machineFiles, current: {version, toolCount}, now}`.
 *
 * Verdict flags (one app, one verdict per row): `connected` — the app has a
 * working entry (its own, or another app's it reads); `fix` — something on
 * this row needs the person (an entry to update, a file that can't be read, an
 * outdated skill, a bridge whose tools changed); otherwise not connected.
 *
 * v3.89.0 — `warnings` carry the FIX (shown in the Next step card, never
 * behind a chevron); `quiet` are plain sentences for the row's own body
 * (`{kind, text}`), never markup.
 */
export function appRowModel(rawTool, ctx = {}) {
  const machine = ctx.machine || null;
  const tool = adaptInstallTool(rawTool, machine);
  const platform = ctx.platform;
  const status = effStatus(tool, platform);
  const via = status === 'manual' && tool.via ? tool.via : null;
  const id = String(tool.id || '');
  const label = tool.label || id;
  const h = machine && machine.byId[id] ? machine.byId[id] : null;
  const installable = isInstallable(tool, platform) && ctx.writable !== false;
  const canWrite = tool.installer === 'file' && ctx.writable !== false && writableHere(tool, platform);
  const ticked = installable && defaultTicks([tool], ctx.ticks || {}, platform)[id] === true;
  const plan = status !== 'connected' && ctx.data ? copyPlanFor(id, ctx.data, ctx.machineFiles) : null;

  const warnings = [];
  const quiet = [];
  // The install status's own reason. A fault (can't read, needs an update —
  // v3.88.1's launch_file_missing among them) is a warning; the Windows
  // file-finding reasons are quiet facts; the installer sentences ("has its
  // own command…") are replaced by the copy line below.
  const reason = reasonWords(tool);
  const code = tool.reason && typeof tool.reason === 'object' ? tool.reason.code : '';
  if (reason && (status === 'cant-read' || status === 'needs-update')) {
    const p = status === 'cant-read' && canReveal(platform) ? revealPathFor(tool, ctx.paths) : '';
    warnings.push({ kind: 'entry', code: code || '', tone: 'warn', severity: 'fix', text: reason,
      acts: p ? [btnG('reveal', 'Reveal', ' data-path="' + escapeHtml(p) + '"')] : [],
      install: status === 'needs-update' && installable });
  } else if (reason && !INSTALLER_REASONS.has(code) && !(isStr(tool.reason) && status === 'manual' && plan)) {
    quiet.push({ kind: 'reason', text: reason });
  }

  // The open bridge, once, on THIS app's row.
  // The row's own `bridges` summary (BE amendment 1 §B) wins; else the config's list.
  const fact = rowBridgeFact(tool.bridges) || bridgeFactFor(id, ctx.bridges);
  const bfact = bridgeRowFact(label, fact, ctx.current || {}, ctx.now);
  if (bfact.warn && !bfact.warn.soft) warnings.push({ ...bfact.warn, severity: 'fix', acts: [] });
  // A bridge whose tools nobody recorded is a SOFT reading, not a fix: it is
  // said in the row's meta ("open since before this version") and in its body.
  if (bfact.warn && bfact.warn.soft) quiet.push({ kind: 'bridge-unknown', text: bfact.warn.text });
  if (bfact.quiet) quiet.push({ kind: 'bridge-same', text: bfact.quiet });

  // The skill-staleness line: the payload's `skill` (setup-check's own
  // sentences and fix list) wins; else it is read from the machine cells.
  const mw = [];
  const sk = tool.skill && typeof tool.skill === 'object' && isStr(tool.skill.text) ? tool.skill : null;
  if (sk) {
    mw.push({ kind: 'skill', tone: 'warn', text: sk.text, strong: isStr(sk.detail) ? sk.detail : '',
      acts: (Array.isArray(sk.fixes) ? sk.fixes : []).map((f) => fixAct(f, { platform })).filter(Boolean) });
  }
  // The machine reading's other faults (hooks, an entry the status called fine).
  for (const w of machineWarnings(h, { platform, status })) if (!(sk && w.kind === 'skill')) mw.push(w);
  // A Setup-check bridge fix the install status does not carry (BE amendment 2
  // `setupFix`, e.g. a copy-only app whose launch line points at a missing
  // file). The backend counts it in TO FIX, so the row says it.
  if (tool.setupFix && typeof tool.setupFix === 'object' && !mw.some((w) => w.kind === 'bridge-file')) {
    mw.push({ kind: 'bridge-file', tone: 'warn', text: 'Its MCP entry needs attention: ' + (isStr(tool.setupFix.word) ? tool.setupFix.word : 'see the files below') + '.', strong: '', acts: [] });
  }
  for (const w of mw) warnings.push({ ...w, severity: 'fix' });

  // Quiet lines: how an unconnected app gets its entry.
  let copy = null;
  if (via) {
    quiet.push({ kind: 'via', text: isStr(via.text) ? via.text : 'Uses ' + via.label + '’s entry.' });
    if (plan) copy = { ...plan, note: id === 'claude-code' ? 'for claude in a terminal' : 'to give it its own entry' };
  } else if (plan) {
    const uwe = tool.usedWithoutEntry && typeof tool.usedWithoutEntry === 'object' && isStr(tool.usedWithoutEntry.text)
      ? tool.usedWithoutEntry.text : '';
    const usedElsewhere = !uwe && status === 'manual' && isStr(tool.usedAt) && h && !(h.files || []).some((f) => f && f.named);
    const used = usedElsewhere ? ageWordsFor(tool.usedAt, ctx.now || Date.now(), '') : '';
    const usedText = uwe || (used ? 'No entry in your user settings — the use ' + used + ' came from another file.' : '');
    if (usedText) quiet.push({ kind: 'used-elsewhere', text: usedText });
    copy = { ...plan, note: status === 'manual' && tool.installer === 'cli' ? 'one-click comes in a later version' : '' };
  }
  // The safe-install hint, only where an install is about to happen.
  const hint = isStr(tool.restartHint) && ticked && tool.running && tool.running.running === true && !appRunningHere(tool, platform)
    ? tool.restartHint : '';

  const fixN = Number.isInteger(tool.toFix) && tool.toFix > 0 ? tool.toFix : warnings.filter((w) => w.severity === 'fix').length;
  const connected = status === 'connected' || !!via;
  // The backend's row `verdict` decides "to fix" when it is sent (one rule for
  // the rows and the overview); an older payload falls back to the warnings.
  const fix = isStr(tool.verdict) ? tool.verdict === 'to-fix'
    : status === 'needs-update' || status === 'cant-read' || warnings.some((w) => w.severity === 'fix');
  return { tool, id, label, status, via, h, installable, canWrite, ticked, plan, copy, warnings, quiet, fixN: fix ? Math.max(1, fixN) : 0,
    hint, appRunning: appRunningHere(tool, platform), bridgeTag: bfact.tag || '', bridgeSoft: !!(bfact.warn && bfact.warn.soft),
    connected, fix, platform };
}

/**
 * `{connected, fix, notConnected}` — the overview's three cards. Pure.
 * THE SOURCE IS THE BACKEND: when the status payload carries `counts`
 * (v3.88.0), those numbers are rendered as sent; only an older payload is
 * counted here, from the row models, by the same rule the route uses.
 */
export function countsFor(data, models) {
  const c = data && data.counts;
  const n = (v) => Number.isInteger(v) && v >= 0;
  if (c && n(c.connected) && n(c.toFix) && n(c.notConnected)) {
    return { connected: c.connected, fix: c.toFix, notConnected: c.notConnected };
  }
  return countVerdicts(models);
}

/** `{connected, fix, notConnected}` over row models (the fallback). Pure. */
export function countVerdicts(models) {
  const c = { connected: 0, fix: 0, notConnected: 0 };
  for (const m of Array.isArray(models) ? models : []) {
    if (m.connected) c.connected++;
    if (m.fix) c.fix++;
    if (!m.connected && !m.fix) c.notConnected++;
  }
  return c;
}

/** The row models for a status payload (and the machine and bridge readings). */
export function appRowModels(status, ctx = {}) {
  const data = status && status.data;
  if (!data) return [];
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const c2 = { ...ctx, writable: data.writable, data, platform: data.platform };
  return tools.map((t) => appRowModel(t, c2));
}

/**
 * "My Curator in your agent apps — 3 connected · 1 to fix · 2 not connected".
 * Zero counts are left out; nothing to say says so. The overview cards'
 * accessible summary.
 */
export function overviewLine(tools, platform, ctx = {}) {
  const models = (Array.isArray(tools) ? tools : []).map((t) => appRowModel(t, { ...ctx, platform }));
  const c = countsFor(ctx.data, models);
  const parts = [];
  if (c.connected) parts.push(c.connected + ' connected');
  if (c.fix) parts.push(c.fix + ' to fix');
  if (c.notConnected) parts.push(c.notConnected + ' not connected');
  return 'My Curator in your agent apps — ' + (parts.length ? parts.join(' · ') : 'no agent app found on this ' + machineWord(platform));
}

/** Put attributes on the FIRST tag of a kit fragment (the kit takes no data-attributes). */
function withAttrs(html, attrs) {
  return attrs ? String(html).replace(/^(<[a-z]+[^>]*)>/, (_, open) => open + attrs + '>') : html;
}

function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

// ── the words on the page (v3.90.0, the copy deck) ─────────────────────────
//
// v3.90.0 rewrote everything below this line from the orchestrator's copy
// deck (Settings › MCP bridge, approved by the owner 2026-11-01). The deck's
// principles, which scripts/test-next-page-contract.js and
// scripts/e2e-mcp-bridge.mjs check on the rendered page:
//   · every line says WHAT a thing is or WHAT TO DO — no mechanism words
//     (bridge, entry, launcher, session line, journal, signature, stdio,
//     MCP server) on screen;
//   · per app, ONE sentence and at most one button; everything else is under
//     that app's "Details" fold;
//   · every action is a real button (the shared secondary button; Remove is
//     the danger one); no ALL-CAPS outside the overview; mono only for paths
//     and tool names; long text wraps inside its card.
// "AI app" is the person's word for a harness; "tool" is one of My Curator's
// tools; "skill" is an instruction file for an AI app.

/** The four words an app's fold row says on its right. */
export const APP_STATE_WORDS = Object.freeze({
  connected: 'connected',
  attention: 'needs attention',
  'not-connected': 'not connected',
  'cant-read': 'can’t read its settings',
});

/** "⌘Q …" (macOS) / "right-click …" (Windows) — how to quit an app completely. '' elsewhere. */
export function quitHowWords(platform) {
  if (platform === 'darwin') return ' (⌘Q — closing the window is not enough)';
  if (platform === 'win32') return ' (right-click its icon by the clock → Quit)';
  return '';
}

/** One app's state, as a key of APP_STATE_WORDS. Pure. */
export function appStateKey(m) {
  if (m.status === 'cant-read') return 'cant-read';
  if (m.fix) return 'attention';
  if (m.connected) return 'connected';
  return 'not-connected';
}

const strong = (s) => '<strong>' + escapeHtml(s) + '</strong>';
const btnS = (act, label, extra = '') => '<button type="button" class="btn btn-secondary btn-xs" data-mcpi-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';
const btnDanger = (act, label, extra = '') => '<button type="button" class="btn btn-danger btn-xs" data-mcpi-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';
const showFileBtn = (p, label = 'Show the file') => '<button type="button" class="btn btn-secondary btn-xs" data-setup-act="reveal" data-path="' + escapeHtml(p) + '">' + escapeHtml(label) + '</button>';

/** A skill's own download — a link to this app's own copy, styled as the secondary button. */
export function skillDownloadLink(skill, label) {
  const s = String(skill || '').replace(/[^A-Za-z0-9_-]/g, '') || 'my-curator';
  return '<a class="btn btn-secondary btn-xs" href="/api/setup/skills/' + s + '.zip" download data-mcpi-download="' + s + '">'
    + escapeHtml(label || 'Download ' + s + '.zip') + '</a>';
}

/** The skills an app has OUT OF DATE (older than this version's copy), by name. Pure. */
export function outdatedSkills(m) {
  const sk = m.tool && m.tool.skill && typeof m.tool.skill === 'object' ? m.tool.skill : null;
  if (sk && sk.reason === 'outdated' && Array.isArray(sk.skills)) return [...new Set(sk.skills.filter(isStr))];
  if (sk && sk.reason && sk.reason !== 'outdated') return [];
  const inst = m.h && m.h.skills && Array.isArray(m.h.skills.installed) ? m.h.skills.installed : [];
  return [...new Set(inst.filter((x) => x && x.match === false && isStr(x.skill)).map((x) => x.skill))];
}

/**
 * Why an app's connection is out of date, as the deck's tail clause:
 * " — it points at {path}, which is no longer on this Mac" ·
 * " — it uses a different knowledge folder" · " — it was set up by an older
 * version" · '' when nothing says which.
 */
export function outOfDateReason(m) {
  const r = m.tool && m.tool.reason && typeof m.tool.reason === 'object' ? m.tool.reason : null;
  if (r && r.code === 'launch_file_missing') {
    // The payload's `missing` (v3.88.1); an older one names the path only in its sentence.
    const said = isStr(r.message) ? /points at (.+?), which is no longer/.exec(r.message) : null;
    const p = Array.isArray(r.missing) && isStr(r.missing[0]) ? r.missing[0] : (said ? said[1] : '');
    if (p) return ' — it points at ' + p + ', which is no longer on this ' + machineWord(m.platform);
  }
  const files = m.h && Array.isArray(m.h.files) ? m.h.files : [];
  if (files.some((f) => f && f.named && f.otherFolder)) return ' — it uses a different knowledge folder';
  const own = Array.isArray(m.tool && m.tool.files) ? m.tool.files : [];
  if (own.some((f) => f && f.state === 'differs')) return ' — it was set up by an older version';
  return '';
}

/** "{App}'s connection is out of date{ reason}." — bold, as the deck writes it. */
function outOfDateHtml(m) {
  return strong(m.label + '’s connection is out of date' + outOfDateReason(m) + '.');
}

/** The deck's sentence for a file The Curator can't read. */
function cantReadText(m) {
  const r = reasonWords(m.tool);
  const why = r ? lowerFirst(r).replace(/\.$/, '') : 'it could not be read';
  return 'The Curator can’t read ' + m.label + '’s settings file (' + why + '), so it won’t change it.';
}

/** An age in words ("2 hr ago"), ticking with the shared clock; '' when unreadable. */
function ageHtml(iso, now) {
  const w = isStr(iso) ? ageWordsFor(iso, now || Date.now(), '') : '';
  if (!w) return '';
  return '<span data-age-at="' + escapeHtml(iso) + '" data-age-text>' + escapeHtml(w) + '</span>';
}

/** The newest of two ISO stamps (either may be missing). */
function newest(a, b) {
  const ta = isStr(a) ? Date.parse(a) : NaN;
  const tb = isStr(b) ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta)) return Number.isFinite(tb) ? b : null;
  if (!Number.isFinite(tb)) return a;
  return ta >= tb ? a : b;
}

/**
 * A Test connection outcome (POST /api/mcp/install/check-entry) as the deck's
 * words: `{ok, html}`, or null while nothing was pressed.
 */
export function testResultWords(label, c, platform) {
  if (!c || c.busy) return null;
  if (isStr(c.error)) return { ok: false, text: 'Doesn’t start: ' + c.error.replace(/\.$/, '') + '.' };
  const r = c.result;
  if (!r || typeof r !== 'object') return null;
  const list = Array.isArray(r.results) ? r.results : [];
  const refused = 'The Curator only tests its own setup line; this one points at something else, so it was not run.';
  if (!list.length) return { ok: false, text: refused };
  if (list.every((x) => x && x.starts === true)) {
    const n = list[0].toolCount;
    return { ok: true, text: 'Works — My Curator starts the way ' + label + ' starts it and answers with all '
      + (Number.isInteger(n) ? n : 'its') + ' tools.' };
  }
  const bad = list.find((x) => !(x && x.starts === true)) || {};
  if (bad.ran === false && bad.code === 'launch_file_missing') {
    const p = isStr(bad.path) ? bad.path : '';
    return { ok: false, text: 'Doesn’t start: ' + (p ? 'it points at ' + p + ', which is no longer on this ' + machineWord(platform) : 'a file it needs is no longer there') + '.' };
  }
  if (bad.ran === false) return { ok: false, text: refused };
  return { ok: false, text: 'Doesn’t start: ' + lowerFirst(String(bad.message || 'it did not answer as My Curator').replace(/\.$/, '')) + '.' };
}

/**
 * The app's DEFAULT VIEW — one sentence, at most one button — and the extra
 * lines the deck adds under it (an older connection still open, a tool list
 * that changed, an out-of-date skill). `{text|html, acts, extras: [html]}`.
 */
export function appDefaultView(m, ctx = {}) {
  const now = ctx.now || Date.now();
  const t = m.tool;
  const tid = ' data-tool="' + escapeHtml(m.id) + '"';
  const check = ctx.checks && ctx.checks[m.id] ? ctx.checks[m.id] : null;
  const testBtn = t.checkEntry === true
    ? btnS('check-entry', 'Test connection', tid + (ctx.checkBusy ? ' disabled' : '')) : '';
  const copyBtn = m.copy ? btnS('copy', 'Copy the setup text', tid) : '';
  let html;
  let acts = '';
  if (m.status === 'cant-read') {
    html = escapeHtml(cantReadText(m));
    const p = canReveal(m.platform) ? revealPathFor(t, ctx.paths) : '';
    acts = (ctx.data && ctx.data.manualSnippets && isStr(ctx.data.manualSnippets[m.id]) ? btnS('copy', 'Copy the setup text', tid) : '')
      + (p ? showFileBtn(p) : '');
  } else if (m.status === 'needs-update') {
    html = outOfDateHtml(m);
  } else if (m.status === 'not-installed' && m.installable) {
    html = escapeHtml('Not connected yet. Tick it in Next step and press Install for me.');
  } else if (!m.connected) {
    const plan = m.copy || m.plan;
    const key = plan && !plan.whole && /inside "([^"]+)"/.test(plan.line) ? plan.line.match(/inside "([^"]+)"/)[1] : '';
    html = escapeHtml(m.label + ' can’t be set up automatically yet. Copy the setup text and paste it into '
      + (plan && plan.file ? plan.file : 'its settings file') + (key ? ', inside "' + key + '"' : '') + '.');
    acts = copyBtn;
  } else {
    // Connected — its own line, or another app's (Claude Code through Claude Desktop's).
    const head = m.via ? 'Connected through ' + (m.via.id === 'claude-desktop' ? 'Claude Desktop' : (m.via.label || 'another app')) + '’s settings.' : 'Connected.';
    const res = testResultWords(m.label, check, m.platform);
    const started = isStr(t.lastStartedAt) && Number.isFinite(Date.parse(t.lastStartedAt)) ? t.lastStartedAt : null;
    const written = isStr(t.entryWrittenAt) && Number.isFinite(Date.parse(t.entryWrittenAt)) ? t.entryWrittenAt : null;
    const used = newest(started, isStr(t.usedAt) ? t.usedAt : null);
    let tail = '';
    if (res) tail = ' ' + escapeHtml(res.text);
    else if (!m.via && written && (!started || Date.parse(started) < Date.parse(written))) {
      tail = ' ' + escapeHtml(m.label + ' hasn’t used My Curator since it was set up ') + ageHtml(written, now)
        + escapeHtml(' — quit and reopen ' + m.label + ' if it doesn’t show up.');
    } else if (used && ageHtml(used, now)) {
      tail = ' ' + escapeHtml(m.label + ' last used My Curator ') + ageHtml(used, now) + '.';
    }
    html = escapeHtml(head) + tail;
    acts = testBtn;
  }
  // The extra lines. A tool list that changed is said in bold; an older
  // connection the app can't compare is said once, plainly; the same tools on
  // an older version say nothing (the owner's decision 3).
  const extras = [];
  const fact = rowBridgeFact(t.bridges) || bridgeFactFor(m.id, ctx.bridges);
  const notice = fact ? (NOTICES.has(fact.notice) ? fact.notice : noticeFor(fact.tools)) : 'none';
  if (notice === 'warn') {
    extras.push(strong(m.label + ' is still using the previous version of My Curator. Quit ' + m.label + ' completely and open it again.'));
  } else if (notice === 'soft') {
    const at = clockWords(fact.startedAt, now);
    extras.push(escapeHtml(m.label + ' has been open since ' + (at || 'earlier') + ', from before The Curator updated. If My Curator seems to be missing something there, quit '
      + m.label + ' completely and open it again.'));
  }
  for (const s of outdatedSkills(m)) extras.push(escapeHtml('Its ' + s + ' skill is out of date — see Skills below.'));
  return { html, acts, extras };
}

/** A fold item with its words FIRST and a mono path after them. Kit classes only. */
function itemTextFirst(textHtml, path, actionHtml) {
  return '<div class="cur-fold-item cur-fold-item-wrap">'
    + '<span class="cur-fold-item-meta">' + textHtml + '</span>'
    + (isStr(path) ? '<span class="mono cur-fold-item-main">' + escapeHtml(path) + '</span>' : '')
    + (actionHtml || '') + '</div>';
}

/**
 * The files an app's Details shows: ONLY the ones that exist, plus the one
 * Install for me would create. `[{path, words, reveal}]`. Pure.
 *   has The Curator's line · no Curator line · not there yet · not used on this computer
 */
export function detailFiles(m) {
  const out = [];
  const seen = new Set();
  const machineFiles = m.h && Array.isArray(m.h.files) ? m.h.files : null;
  const anyNamed = (machineFiles || []).some((f) => f && f.named);
  if (machineFiles) {
    for (const f of machineFiles) {
      if (!f || !isStr(f.file)) continue;
      const bad = isStr(f.status) && f.status !== 'ok' && f.status !== 'missing';
      if (!f.present && !bad) continue;
      const words = f.named ? 'has The Curator’s line'
        : bad && anyNamed ? 'not used on this computer'
          : 'no Curator line';
      out.push({ path: f.display || f.file, words, reveal: f.file });
      seen.add(f.file);
    }
  } else {
    for (const f of Array.isArray(m.tool.files) ? m.tool.files : []) {
      if (!f || f.state === 'missing' || !(isStr(f.display) || isStr(f.file))) continue;
      out.push({ path: f.display || f.file, words: f.state === 'connected' || f.state === 'differs' ? 'has The Curator’s line' : 'no Curator line',
        reveal: isStr(f.file) ? f.file : null });
      if (isStr(f.file)) seen.add(f.file);
    }
  }
  // The one file Install for me would create (none of the app's own exist yet).
  if (m.installable) {
    const create = (Array.isArray(m.tool.files) ? m.tool.files : []).find((f) => f && f.state === 'missing' && f.action === 'add' && !seen.has(f.file));
    if (create && !out.length) out.push({ path: create.display || create.file, words: 'not there yet', reveal: null });
  }
  return out;
}

/** The app's "Details" fold body: the settings files, Remove / Restore, automatic saves. */
export function appDetailsHtml(m, ctx = {}) {
  const tid = ' data-tool="' + escapeHtml(m.id) + '"';
  const rows = [];
  const files = detailFiles(m);
  if (files.length) {
    rows.push(renderFoldLine({ text: 'Settings file', quiet: true }));
    for (const f of files) {
      rows.push(withAttrs(renderFoldItem({ main: f.path, meta: f.words, hostClass: 'cur-fold-item-wrap',
        actionHtml: f.reveal && canReveal(m.platform) ? showFileBtn(f.reveal) : '' }), ' data-mcpi-file'));
    }
  }
  if (m.status === 'connected' && m.canWrite) {
    rows.push(withAttrs(renderFoldLine({ text: 'Remove The Curator from ' + m.label, actionHtml: btnDanger('remove', 'Remove', tid) }), ' data-mcpi-undo="remove"'));
  }
  if (m.tool.restorable === true && m.canWrite) {
    rows.push(withAttrs(renderFoldLine({ text: 'Put back the original settings file', actionHtml: btnS('restore', 'Restore original', tid) }), ' data-mcpi-undo="restore"'));
  }
  const k = m.h && m.h.hooks && typeof m.h.hooks === 'object' ? m.h.hooks : null;
  if (k && k.format && k.format !== 'none') {
    const present = (Array.isArray(k.files) ? k.files : []).filter((f) => f && f.present);
    const on = present.some((f) => f.ours);
    const file = (present.find((f) => f.ours) || present[0] || null);
    rows.push(withAttrs(renderFoldLine({ quiet: true,
      text: 'Automatic saves: ' + (on ? 'on' : 'off') + '. When on, ' + m.label + ' saves a handoff by itself when a session ends.',
      actionHtml: file && isStr(file.file) && canReveal(m.platform) ? showFileBtn(file.file) : '' }), ' data-mcpi-hooks'));
  }
  return rows.join('');
}

/** One AI app as a fold row: its name · its state word, over its default view and its Details. */
export function appFoldRow(m, ctx = {}) {
  const key = 'app-' + m.id;
  const v = appDefaultView(m, ctx);
  const body = [withAttrs(renderFoldLine({ textHtml: v.html, actionHtml: v.acts }), ' data-mcpi-default')];
  for (const x of v.extras) body.push(withAttrs(renderFoldLine({ textHtml: x }), ' data-mcpi-extra'));
  const details = appDetailsHtml(m, ctx);
  if (details) {
    const dk = 'app-details-' + m.id;
    body.push(renderFoldRows(withAttrs(renderFoldRow({ key: dk, label: 'Details', open: !!(ctx.folds && ctx.folds[dk]), bodyHtml: details }), ' data-mcpi-details')));
  }
  return withAttrs(renderFoldRow({
    key,
    label: m.label,
    meta: APP_STATE_WORDS[appStateKey(m)],
    open: !!(ctx.folds && ctx.folds[key]),
    bodyHtml: body.join(''),
  }), ' data-mcpi-tool="' + escapeHtml(m.id) + '" data-mcpi-status="' + escapeHtml(m.via ? 'via' : m.status) + '"');
}

/** "Not on this Mac (n)" — closed; one line naming the apps. */
export function notFoundFoldRow(data, ctx = {}) {
  const nf = Array.isArray(data && data.notFound) ? data.notFound.filter((t) => t && isStr(t.id)) : [];
  if (!nf.length) return '';
  const names = nf.map((t) => t.label || t.id).join(', ');
  return renderFoldRow({ key: 'mcpi-notfound', label: 'Not on this ' + machineWord(data.platform) + ' (' + nf.length + ')',
    open: !!(ctx.folds && ctx.folds['mcpi-notfound']),
    bodyHtml: renderFoldLine({ text: names + '. If you install one of these, press Check again.' }) });
}

// ── the Next step card ─────────────────────────────────────────────────────

/**
 * What needs the person, one item per line: `[{key, id, html, actsHtml}]`.
 * Pure. The deck's three kinds (an out-of-date skill, an app not connected
 * yet, a connection out of date), plus the faults the deck words elsewhere
 * (a tool list that changed, a settings file The Curator can't read).
 */
export function nextStepItems(models) {
  const items = [];
  for (const m of models) {
    if (m.status === 'cant-read') {
      items.push({ key: 'cant-read', id: m.id, html: escapeHtml(cantReadText(m)) });
    } else if (m.status === 'needs-update' && m.installable) {
      items.push({ key: 'out-of-date', id: m.id, html: outOfDateHtml(m) });
    } else if (m.status === 'not-installed' && m.installable) {
      items.push({ key: 'not-connected', id: m.id, html: strong(m.label + ' isn’t connected yet.') });
    } else if (m.status === 'needs-update' || (m.tool.setupFix && typeof m.tool.setupFix === 'object')) {
      items.push({ key: 'out-of-date', id: m.id, html: outOfDateHtml(m) });
    }
    const fact = rowBridgeFact(m.tool.bridges);
    if (fact && (NOTICES.has(fact.notice) ? fact.notice : noticeFor(fact.tools)) === 'warn') {
      items.push({ key: 'tools-changed', id: m.id, html: strong(m.label + ' is still using the previous version of My Curator. Quit ' + m.label + ' completely and open it again.') });
    }
    for (const s of outdatedSkills(m)) {
      items.push({ key: 'skill', id: m.id, skill: s,
        html: strong(m.label + '’s ' + s + ' skill is out of date.') + escapeHtml(' Download the new version and replace the old one — see Skills below.'),
        actsHtml: skillDownloadLink(s, 'Download ' + s) });
    }
  }
  return items;
}

/** The Install for me button's state, in the deck's words. */
export function installChipState(models, data, ticks, busy) {
  const b = installButtonState({ data }, ticks, busy);
  const any = models.some((m) => m.installable);
  return { disabled: b.disabled || !!busy, label: data && data.writable && !any ? 'Already set up' : 'Install for me', n: b.n };
}

/**
 * THE NEXT STEP CARD — only when something needs doing: each item as one
 * line (+ its button), then Install for me and Copy the setup text, the ticks,
 * and the safety line last. Nothing to do → "Everything is connected." when
 * every app found is connected, and nothing at all otherwise.
 */
export function nextStepCard(models, data, st = {}) {
  const items = nextStepItems(models);
  if (!items.length) {
    const allConnected = models.length > 0 && models.every((m) => m.connected);
    return allConnected ? withAttrs(renderStatusLine(strong('Everything is connected.'), '', { textIsHtml: true }), ' data-mcpi-all-connected') : '';
  }
  const s = installChipState(models, data, st.ticks, st.busy);
  // Copy the setup text copies it for the first ticked app (else the first
  // item's app with a setup text), so the person can paste it themselves.
  const snippets = data && data.manualSnippets && typeof data.manualSnippets === 'object' ? data.manualSnippets : {};
  const firstTicked = models.find((m) => m.installable && m.ticked && isStr(snippets[m.id]));
  const firstItem = items.find((it) => isStr(snippets[it.id]));
  const copyFor = firstTicked ? firstTicked.id : (firstItem ? firstItem.id : '');
  const chips = '<button type="button" class="btn btn-primary btn-xs cur-action-chip" id="mcpi-install-btn" data-mcpi-act="install"'
    + (s.disabled ? ' disabled' : '') + '><span class="cur-action-label">' + escapeHtml(s.label) + '</span></button>'
    + '<button type="button" class="btn btn-secondary btn-xs cur-action-chip" data-mcpi-act="copy-myself"' + (copyFor ? ' data-tool="' + escapeHtml(copyFor) + '"' : '')
    + '><span class="cur-action-label">Copy the setup text</span></button>';
  const lines = items.map((it) => withAttrs(renderFoldLine({ textHtml: it.html, actionHtml: it.actsHtml || '' }),
    ' data-mcpi-item="' + escapeHtml(it.key) + '" data-tool="' + escapeHtml(it.id) + '"')).join('');
  const extra = [];
  for (const m of models) if (m.appRunning) extra.push('<p data-mcpi-app-running>' + escapeHtml(APP_RUNNING_WORDS) + '</p>');
  if (data.platform === 'win32' && models.some((m) => m.installable && WINDOWS_INSTALLABLE.includes(m.id))) {
    extra.push('<p data-mcpi-new-windows>' + escapeHtml(WINDOWS_NEW_LABEL) + '</p>');
  }
  const installables = models.filter((m) => m.installable);
  const picks = installables.length
    ? '<div class="cur-action-picks" role="group" aria-label="Install into">' + installables.map((m) => '<label class="cur-action-pick">'
      + '<input type="checkbox" class="cur-check cur-check-sm" data-mcpi-tick="' + escapeHtml(m.id) + '"' + (m.ticked ? ' checked' : '')
      + ' aria-label="' + escapeHtml('Include ' + m.label + ' in Install for me') + '">' + escapeHtml(m.label) + '</label>').join('') + '</div>'
    : '';
  return withAttrs(renderActionCard({
    eyebrow: 'Next step · ' + items.length + ' to do',
    eyebrowCase: 'sentence',
    runHtml: lines + extra.join('') + '<div class="cur-action-chips">' + chips + '</div>' + picks,
    footnoteHtml: renderDescription('Install for me changes only The Curator’s own line in each app’s settings file. It shows you the change first and keeps a backup.'),
  }), ' id="mcpi-next-step" data-mcpi-next');
}

// ── the preview ────────────────────────────────────────────────────────────

/** The backend's literal stand-in for the apply time in a copy's name (never shown as-is). */
export const BACKUP_AT_APPLY = '<UTC time of apply>';

/** "31 Oct, 09:58" in the reader's own clock, or '' when the stamp can't be read. */
export function keptOnWords(iso) {
  const t = isStr(iso) ? new Date(iso) : null;
  if (!t || !Number.isFinite(t.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getMonth()];
  return t.getDate() + ' ' + mon + ', ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
}

/** "Your other connections stay as they are: a, b." — '' when there are none. */
export function preservedLine(names) {
  const list = Array.isArray(names) ? names.filter(isStr) : [];
  return list.length ? 'Your other connections stay as they are: ' + list.join(', ') + '.' : '';
}

/** A backup's file name, with the apply-time stand-in shown as "…". */
export function backupName(p) {
  if (!isStr(p)) return '';
  const base = p.split(/[\\/]/).pop() || p;
  return base.replace(BACKUP_AT_APPLY, '…');
}

/** "✓ Cursor is set up. Quit Cursor completely and open it again to use My Curator." and its kin. Pure. */
export function resultHtml(r, action, platform) {
  const label = r.label || r.id || '';
  const outcome = ['written', 'created', 'unchanged', 'refused'].includes(r.outcome) ? r.outcome : 'refused';
  if (outcome === 'refused') {
    const why = isStr(r.message) ? r.message : isStr(r.reason) ? r.reason : 'it was left as it is';
    return { ok: false, html: '✗ ' + strong(label) + escapeHtml(' was not changed: ' + lowerFirst(why).replace(/\.$/, '') + '.') };
  }
  const quit = strong('Quit ' + label + ' completely and open it again');
  if (action === 'remove' || action === 'restore') {
    const what = action === 'remove' ? 'Remove The Curator from ' + label : 'Put back the original settings file';
    return { ok: true, html: '✓ ' + strong(label) + escapeHtml(' — ' + what + '. ') + (outcome === 'unchanged' ? '' : quit + '.') };
  }
  if (outcome === 'unchanged') return { ok: true, html: '✓ ' + strong(label) + escapeHtml(' is set up.') };
  return { ok: true, html: '✓ ' + strong(label) + escapeHtml(' is set up. ') + quit + escapeHtml(' to use My Curator.' + quitHowWords(platform)) };
}

/** One planned file, in the deck's words. */
function planItem(item, action) {
  const label = item.label || item.id || '';
  const tid = ' data-tool="' + escapeHtml(item.id || '') + '"';
  if (item.refused) {
    const why = item.refused.message || item.refused.reason || 'it was left as it is';
    return withAttrs(renderFoldLine({ textHtml: '✗ ' + strong(label) + escapeHtml(' was not changed: ' + lowerFirst(String(why)).replace(/\.$/, '') + '.'),
      actionHtml: btnS('copy', 'Copy the setup text', tid) }), ' data-mcpi-plan-item="' + escapeHtml(item.id) + '" data-mcpi-plan-refused');
  }
  const parts = [withAttrs(itemTextFirst(strong(label) + ' —', item.file || ''), ' data-mcpi-plan-item="' + escapeHtml(item.id) + '"')];
  if (action === 'restore') parts.push('<p data-mcpi-restore-from>Put back the original settings file</p>');
  if (action === 'install' && isStr(item.entryText)) {
    parts.push('<p>Adds:</p>');
    parts.push('<pre class="mono cur-action-entry" data-mcpi-entry>' + escapeHtml(item.entryText) + '</pre>');
  }
  const kept = action === 'restore' ? '' : preservedLine(item.preserved);
  if (kept) parts.push('<p data-mcpi-preserved>' + escapeHtml(kept) + '</p>');
  if (item.basis !== 'absent' && isStr(item.backupWillBe)) parts.push('<p data-mcpi-backup>' + escapeHtml('Backup: ' + backupName(item.backupWillBe)) + '</p>');
  return parts.join('');
}

/** The preview — "Check the change · nothing written yet": per file, then Apply · Cancel. */
export function renderPlanCard(plan, tools, busy) {
  if (!plan || !Array.isArray(plan.items)) return '';
  const action = ['install', 'remove', 'restore'].includes(plan.action) ? plan.action : 'install';
  const doable = plan.items.filter((i) => !i.refused).length;
  const chips = '<button type="button" class="btn btn-primary btn-xs cur-action-chip" data-mcpi-act="apply"' + (doable === 0 || busy ? ' disabled' : '') + '>'
    + '<span class="cur-action-label">Apply</span></button>'
    + '<button type="button" class="btn btn-secondary btn-xs cur-action-chip" data-mcpi-act="cancel"' + (busy === 'apply' ? ' disabled' : '') + '>'
    + '<span class="cur-action-label">Cancel</span></button>';
  return withAttrs(renderActionCard({
    eyebrow: 'Check the change · nothing written yet',
    eyebrowCase: 'sentence',
    runHtml: plan.items.map((i) => planItem(i, action)).join('') + '<div class="cur-action-chips">' + chips + '</div>',
  }), ' id="mcpi-next-step" data-mcpi-plan role="region" aria-label="Check the change"');
}

/** The results: one line per file (a failure carries Copy the setup text), then Check again. */
export function renderResults(res, tools, platform) {
  if (!res || !Array.isArray(res.items)) return '';
  const action = res.action || 'install';
  const lines = res.items.map((r) => {
    const w = resultHtml(r, action, platform);
    const tid = ' data-tool="' + escapeHtml(r.id || '') + '"';
    return withAttrs(renderFoldLine({ textHtml: w.html, actionHtml: w.ok ? '' : btnS('copy', 'Copy the setup text', tid) }),
      ' data-mcpi-result="' + (w.ok ? 'ok' : 'refused') + '"');
  }).join('');
  return withAttrs(renderActionCard({
    eyebrow: '',
    eyebrowCase: 'sentence',
    runHtml: lines + '<div class="cur-action-chips"><button type="button" class="btn btn-secondary btn-xs cur-action-chip" data-mcpi-act="check-again">'
      + '<span class="cur-action-label">Check again</span></button></div>',
  }), ' id="mcpi-next-step" data-mcpi-results role="status"');
}

// ── the ① card's body ──────────────────────────────────────────────────────

/**
 * Section ① "Your AI apps", after its control row: an error or a copy
 * confirmation (each `renderStatus`, never folded), then the Next step card
 * (or the preview, or the results), then one fold row per AI app and the
 * "Not on this Mac" row.
 */
export function renderAgentApps(st) {
  const s = st || {};
  const status = s.status || null;
  const data = status && status.data;
  if (!data) {
    if (status && status.error) return renderStatus({ state: 'danger', title: 'Could not check your AI apps', detail: status.error });
    return renderStatus({ state: 'neutral', title: 'Checking your AI apps…' });
  }
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const ctx = { ticks: s.ticks, folds: s.folds, paths: s.paths, machineFiles: s.machineFiles, data,
    machine: s.machine || null, bridges: s.bridges || null, current: s.current || {}, now: s.now,
    checkBusy: s.checkBusy || null, checks: s.checks || {} };
  const models = appRowModels(status, ctx);
  const out = [];
  if (isStr(s.error)) out.push(withAttrs(renderStatus({ state: 'danger', title: s.error }), ' data-mcpi-error'));
  if (status.error) out.push(renderStatus({ state: 'danger', title: 'Could not check again', detail: status.error }));
  if (isStr(s.copied)) out.push(withAttrs(renderStatus({ state: 'success', title: s.copied }), ' data-mcpi-copied'));
  const notes = out.splice(0, out.length);
  if (notes.length) out.push('<div class="cur-card-notes">' + notes.join('') + '</div>');
  out.push(s.plan ? renderPlanCard(s.plan, tools, s.busy)
    : s.results ? renderResults(s.results, tools, data.platform)
      : nextStepCard(models, data, { ticks: s.ticks, busy: s.busy }));
  const rows = models.map((m) => appFoldRow(m, ctx)).join('') + notFoundFoldRow(data, ctx);
  if (rows) out.push(withAttrs(renderFoldRows(rows), ' id="mcpi-rows"'));
  else out.push(renderStatus({ state: 'neutral', title: 'No AI app was found on this ' + machineWord(data.platform) + '.' }));
  return out.join('');
}

// ── ② Skills ───────────────────────────────────────────────────────────────

/** What each skill teaches, in the deck's words. */
export const SKILL_WORDS = Object.freeze({
  'my-curator': 'how to read and write your knowledge',
  // A template key: scripts/test-ui-state.js reads every quoted `curator-*`
  // string in /next as a browser-storage key, and this is a skill's name.
  [`curator-continuity`]: 'how to save and resume work between sessions',
});
const SKILL_STATE_WORDS = Object.freeze({ current: 'up to date', outdated: 'out of date', 'not-installed': 'not installed' });

/**
 * Section ② "Skills": one fold row per skill — its download, then one line
 * per AI app that uses skills. `machine` is adaptMachine's reading (its
 * `raw.skills`, GET /api/setup/machine v3.90.0); `folds` the open state.
 */
export function renderSkills(machine, opts = {}) {
  if (!machine) return renderStatus({ state: 'neutral', title: 'Checking your AI apps…' });
  const list = Array.isArray(machine.raw && machine.raw.skills) ? machine.raw.skills : [];
  const platform = opts.platform;
  const rows = list.filter((s) => s && isStr(s.skill)).map((s) => {
    const apps = Array.isArray(s.apps) ? s.apps.filter((a) => a && isStr(a.label)) : [];
    const checkable = apps.filter((a) => a.kind === 'folder');
    const upToDate = checkable.filter((a) => a.state === 'current').length;
    const body = [];
    if (machine.skillsShipped) body.push(withAttrs(renderFoldLine({ text: '', actionHtml: skillDownloadLink(s.skill) }), ' data-mcpi-skill-download'));
    for (const a of apps) {
      if (a.kind === 'account') {
        body.push(withAttrs(renderFoldLine({ text: a.label + ' — upload it in Claude: Customize → Skills. The Curator can’t see your Claude account, so it can’t tell whether your copy is current.' }),
          ' data-mcpi-skill-app="' + escapeHtml(a.id || '') + '"'));
        continue;
      }
      const word = SKILL_STATE_WORDS[a.state] || '';
      const path = isStr(a.dirDisplay) ? a.dirDisplay : (isStr(a.dir) ? a.dir : '');
      const show = isStr(a.dir) && canReveal(platform) ? showFileBtn(a.dir, 'Show the folder') : '';
      body.push(withAttrs(itemTextFirst(escapeHtml(a.label + (word ? ' — ' + word : '')), path || null, show),
        ' data-mcpi-skill-app="' + escapeHtml(a.id || '') + '" data-mcpi-skill-state="' + escapeHtml(a.state || '') + '"'));
      if (a.state === 'outdated') {
        body.push(renderFoldLine({ quiet: true, text: 'Replace the folder with the downloaded one, then start a new ' + a.label + ' session.' }));
      }
    }
    const key = 'skill-' + s.skill;
    return withAttrs(renderFoldRow({
      key,
      labelHtml: '<span class="mono">' + escapeHtml(s.skill) + '</span>' + escapeHtml(SKILL_WORDS[s.skill] ? ' — ' + SKILL_WORDS[s.skill] : ''),
      label: s.skill,
      meta: checkable.length ? upToDate + ' of ' + checkable.length + (checkable.length === 1 ? ' app' : ' apps') + ' up to date' : undefined,
      open: !!(opts.folds && opts.folds[key]),
      bodyHtml: body.join(''),
    }), ' data-mcpi-skill="' + escapeHtml(s.skill) + '"');
  }).join('');
  return rows ? renderFoldRows(rows) : renderStatus({ state: 'neutral', title: 'This copy of The Curator carries no skills.' });
}

// ── requests (the only network code; every one is called from a click) ─────

async function readJson(res) {
  const ct = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '').toLowerCase();
  if (ct.includes('text/html')) return { ok: false, code: 'stale', message: 'This version of The Curator can’t install into AI apps yet — update the app.' };
  let j = null;
  try { j = await res.json(); } catch { /* not JSON */ }
  if (res.ok && j) return { ok: true, data: j };
  const code = j && (j.code || (j.error && j.error.code) || j.reason) || 'http_' + res.status;
  const message = (j && (typeof j.error === 'string' ? j.error : j.error && j.error.message || j.message)) || 'HTTP ' + res.status;
  return { ok: false, code: String(code), message: String(message) };
}

async function call(url, body) {
  try {
    const res = body === undefined
      ? await fetch(url)
      : await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await readJson(res);
  } catch (e) {
    return { ok: false, code: 'network', message: (e && e.message) || 'The request failed.' };
  }
}

/** GET /api/mcp/install/status — read-only. */
export function fetchInstallStatus() {
  return call('/api/mcp/install/status').then((r) => (r.ok && !Array.isArray(r.data.tools)
    ? { ok: false, code: 'shape', message: 'The server answered in an unexpected shape.' } : r));
}
/** POST /api/mcp/install/plan — writes nothing. */
export function requestPlan(action, ids) {
  return call('/api/mcp/install/plan', { action, ids }).then((r) => (r.ok && !Array.isArray(r.data.items)
    ? { ok: false, code: 'shape', message: 'The server answered in an unexpected shape.' } : r));
}
/** POST /api/mcp/install/check-entry (v3.89.0) — starts this app's own entry; writes nothing. Click only. */
export function requestCheckEntry(id) {
  return call('/api/mcp/install/check-entry', { id }).then((r) => (r.ok && !Array.isArray(r.data.results)
    ? { ok: false, code: 'shape', message: 'The server answered in an unexpected shape.' } : r));
}
/** POST /api/mcp/install/apply — the only call that writes. Click only. */
export function requestApply(token) {
  return call('/api/mcp/install/apply', { token }).then((r) => (r.ok && !Array.isArray(r.data.results)
    ? { ok: false, code: 'shape', message: 'The server answered in an unexpected shape.' } : r));
}

/** A person's sentence for a failed request. Pure. */
export function failureWords(r) {
  const code = r && r.code;
  if (code === 'platform_unsupported') return 'Install for me isn’t available on this computer yet. Copy the setup text instead.';
  if (code === 'busy') return 'Another install is still running. Wait a moment, then try again.';
  if (code === 'stale') return r.message;
  if (code === 'network') return 'Could not reach The Curator. Nothing was changed.';
  return (r && r.message ? r.message : 'The request failed.') + ' Nothing was changed.';
}
