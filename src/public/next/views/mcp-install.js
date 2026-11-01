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
import { renderFoldRows, renderFoldRow, renderFoldItem, renderActionCard, renderStatusLine } from '../shared/section.js';
import { appDetailItems } from './setup-machine.js';

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

// ── the row, drawn with the section kit (v3.89.0) ──────────────────────────

/** Put attributes on the FIRST tag of a kit fragment (the kit takes no data-attributes). */
function withAttrs(html, attrs) {
  return attrs ? String(html).replace(/^(<[a-z]+[^>]*)>/, (_, open) => open + attrs + '>') : html;
}

/** "used 6 hr ago", ticking (shared/age-ticker.js), or ''. */
function usedHtml(tool, now) {
  if (!tool || !isStr(tool.usedAt)) return '';
  const words = ageWordsFor(tool.usedAt, now || Date.now(), 'used');
  if (!words) return '';
  return '<span data-age-at="' + escapeHtml(tool.usedAt) + '" data-age-prefix="used" data-age-text>' + escapeHtml(words) + '</span>';
}

/**
 * The fold row's one-line reading: "connected · running · used 6 hr ago",
 * "through Claude Desktop · used 17 min ago", "needs an update", "not
 * connected · last used 5 weeks ago". HTML (the age ticks). Pure.
 */
export function appMetaHtml(m, now) {
  const t = m.tool;
  const bits = [escapeHtml(m.via ? viaWord(m) : STATUS_WORDS[m.status])];
  const r = t.running;
  if (r && r.checked === true && r.running === true) bits.push('running');
  if (m.bridgeSoft) bits.push('open since before this version');
  const used = usedHtml(t, now);
  if (used) bits.push(m.connected ? used : used.replace('>used ', '>last used '));
  return bits.join(' · ');
}

/** "31 Oct, 09:58"-style day words for a stamp (keptOnWords without the time when not today). */
function sinceWords(iso, now) {
  const age = ageWordsFor(iso, now || Date.now(), '');
  return age || keptOnWords(iso);
}

/**
 * THE PER-APP HEALTH LINE (v3.89.0) — from the usage log's session lines,
 * which carry the client since v3.88.0, and the install manifest:
 *   "Claude Desktop last started it 2 hr ago", or
 *   "Claude Desktop hasn't started My Curator since the entry was written 2 hr ago"
 * when no session of that app has been seen since The Curator wrote the
 * entry. '' when there is nothing honest to say. Pure.
 */
export function healthWords(m, now = Date.now()) {
  if (!m.connected && m.status !== 'needs-update') return '';
  const t = m.tool;
  const started = isStr(t.lastStartedAt) && Number.isFinite(Date.parse(t.lastStartedAt)) ? t.lastStartedAt : null;
  const written = isStr(t.entryWrittenAt) && Number.isFinite(Date.parse(t.entryWrittenAt)) ? t.entryWrittenAt : null;
  if (written && (!started || Date.parse(started) < Date.parse(written))) {
    return m.label + ' hasn’t started My Curator since the entry was written ' + sinceWords(written, now);
  }
  if (started) return m.label + ' last started it ' + sinceWords(started, now);
  return '';
}

/** One copy line as a fold item: the file (mono), what to do with the entry, Copy entry. */
function copyItem(m, plan) {
  const tid = ' data-tool="' + escapeHtml(m.id) + '"';
  const how = !plan.file ? 'add it to the app’s own MCP config file'
    : plan.whole && /^Save as /.test(plan.line) ? 'save the copied text as this new file'
      : !plan.whole && /inside "([^"]+)"/.test(plan.line) ? 'paste it inside "' + plan.line.match(/inside "([^"]+)"/)[1] + '"'
        : 'add it to this file';
  return withAttrs(renderFoldItem({
    main: plan.file || undefined,
    meta: how + (plan.note ? ' — ' + plan.note : ''),
    actionHtml: btnG('copy', 'Copy entry', tid),
  }), ' data-mcpi-copyline');
}

/**
 * The row's body — the evidence and the row's own actions, CLOSED by default:
 * the health line with Check entry, the copy line, the quiet facts, the files
 * / skills / hooks the check read, the Antigravity note, Remove / Restore.
 */
export function appBodyHtml(m, ctx = {}) {
  const tid = ' data-tool="' + escapeHtml(m.id) + '"';
  const items = [];
  const health = healthWords(m, ctx.now);
  const checkBtn = m.tool.checkEntry === true
    ? btnG('check-entry', ctx.checkBusy === m.id ? 'Checking…' : 'Check entry', tid + (ctx.checkBusy ? ' disabled' : '')) : '';
  if (health || checkBtn) {
    items.push(withAttrs(renderFoldItem({ meta: health || 'Start the command in its entry, as ' + m.label + ' would', actionHtml: checkBtn }), ' data-mcpi-health'));
  }
  if (m.copy) items.push(copyItem(m, m.copy));
  for (const q of m.quiet) items.push(withAttrs(renderFoldItem({ meta: q.text }), ' data-mcpi-quiet="' + escapeHtml(q.kind) + '"'));
  // The evidence: the machine reading when there is one, else the status's files.
  const ev = m.h ? appDetailItems(m.h, ctx.machine ? ctx.machine.raw : null, { platform: m.platform })
    : (Array.isArray(m.tool.files) ? m.tool.files : []).map((f) => ({ main: f && (f.display || f.file) || '', meta: FILE_STATE_WORDS[f && f.state] || '' }));
  for (const it of ev) {
    const act = it.reveal && canReveal(m.platform)
      ? '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="reveal" data-path="' + escapeHtml(it.reveal) + '">Reveal</button>'
      : (it.actionHtml || '');
    items.push(renderFoldItem({ main: it.main, meta: it.meta, actionHtml: act }));
  }
  if (isStr(m.tool.note)) items.push(renderFoldItem({ meta: m.tool.note }));
  const acts = [];
  if (m.status === 'connected' && m.canWrite) acts.push(btnG('remove', 'Remove from ' + m.label, tid));
  if (m.tool.restorable === true && m.canWrite) acts.push(btnG('restore', 'Restore original', tid));
  if (acts.length) {
    items.push(withAttrs(renderFoldItem({
      meta: m.tool.restorable === true ? 'Undo what The Curator wrote here' : 'Take only the my-curator entry out',
      actionHtml: acts.join(''),
    }), ' data-mcpi-undo'));
  }
  return items.join('');
}

/** What the status's own file states read as, when there is no machine reading. */
const FILE_STATE_WORDS = Object.freeze({
  connected: 'has the my-curator entry', differs: 'has an older my-curator entry', 'no-entry': 'no my-curator entry',
  missing: 'not there yet', 'cant-read': 'can’t be read',
});

/** One app as a fold row: label · "N to fix" pill · its reading, over its body. */
export function appFoldRow(m, ctx = {}) {
  const key = 'app-' + m.id;
  return withAttrs(renderFoldRow({
    key,
    label: m.label,
    pill: m.fix ? m.fixN + ' to fix' : undefined,
    metaHtml: appMetaHtml(m, ctx.now),
    open: !!(ctx.folds && ctx.folds[key]),
    bodyHtml: appBodyHtml(m, ctx),
  }), ' data-mcpi-tool="' + escapeHtml(m.id) + '" data-mcpi-status="' + escapeHtml(m.via ? 'via' : m.status) + '"');
}

/** "Not on this Mac" — one fold row with a count, one copy line per app. */
export function notFoundFoldRow(data, ctx = {}) {
  const nf = Array.isArray(data && data.notFound) ? data.notFound.filter((t) => t && isStr(t.id)) : [];
  if (!nf.length) return '';
  const snippets = (data && data.manualSnippets) || {};
  const body = nf.map((t) => {
    const pl = copyPlanFor(t.id, data, ctx.machineFiles);
    const label = t.label || t.id;
    return withAttrs(renderFoldItem({
      meta: label + (pl ? ' — ' + lowerFirst(pl.line.replace(/\.$/, '')) : ''),
      actionHtml: isStr(snippets[t.id]) ? btnG('copy', 'Copy entry', ' data-tool="' + escapeHtml(t.id) + '"') : '',
    }), ' data-mcpi-tool="' + escapeHtml(t.id) + '" data-mcpi-copyline');
  }).join('');
  return renderFoldRow({ key: 'mcpi-notfound', label: 'Not on this ' + machineWord(data.platform), pill: nf.length,
    open: !!(ctx.folds && ctx.folds['mcpi-notfound']), bodyHtml: body });
}

// ── the Next step card (v3.89.0) ───────────────────────────────────────────

/** Said whenever one-click install is not available on this computer. Words only. */
export function nonMacLine(data) {
  const p = data && isStr(data.platform) ? data.platform : '';
  if (p === 'win32') return 'One-click install on Windows is not available right now — copy the entry for each agent app instead.';
  const where = p && p !== 'darwin' ? ' on ' + (p === 'linux' ? 'Linux' : p) : '';
  return 'One-click install works on a Mac in this version' + where + ' — copy the entry for each agent app instead.';
}

/** Said on Windows when install works: one app only. Words only. */
export function windowsLine() {
  return 'On Windows, one-click install covers Claude Desktop only — copy the entry for each other agent app.';
}

/** The Install chip — the page's one primary action. */
function installChip(b, busy, data) {
  const n = b.n;
  const label = busy === 'plan' ? 'Preparing…' : (n > 1 ? 'Install for me' : b.label.replace(/ \(\d+ apps\)$/, ''));
  const cost = busy === 'plan' ? '' : n === 1 ? '1 app · previewed first' : n > 1 ? n + ' apps · previewed first'
    : (data && data.install && isStr(data.install.disabledText) ? lowerFirst(data.install.disabledText) : 'nothing to add');
  const lab = label === 'Nothing to install' || /^Copy-only/.test(label) || label === 'Can’t install here' ? 'Install for me' : label;
  return '<button type="button" class="btn btn-primary btn-xs cur-action-chip" id="mcpi-install-btn" data-mcpi-act="install"'
    + (b.disabled ? ' disabled' : '') + '>'
    + '<span class="cur-action-label">' + escapeHtml(lab) + '</span>'
    + (cost ? '<span class="cur-action-cost">' + escapeHtml(cost) + '</span>' : '') + '</button>';
}

/** A fix action as a chip: Download is a link to this app's own copy, Reveal a button. */
function fixChip(actHtml, appLabel) {
  // fixAct's markup, re-dressed as a chip with the app in the cost slot.
  const cost = '<span class="cur-action-cost">for ' + escapeHtml(appLabel) + '</span>';
  return String(actHtml)
    .replace(/class="btn btn-(?:secondary|ghost) btn-xs"/, 'class="btn btn-secondary btn-xs cur-action-chip"')
    .replace(/>([^<]*)<\/(a|button)>$/, (_, txt, tag) => '><span class="cur-action-label">' + txt + '</span>' + cost + '</' + tag + '>');
}

/**
 * THE ONE OBVIOUS NEXT ACTION (PROPOSAL §3): whatever needs the person, in
 * ONE tinted card at the top of ① — the fixes as chips with their app in the
 * cost slot, Install for me (disabled, never hidden) with its consequence,
 * Copy an entry myself; the sentences in the run line; the safety promise as
 * its footnote. When nothing needs the person and nothing can be installed,
 * the one-line status card instead. `st` as renderAgentApps'.
 */
export function nextStepCard(models, data, st = {}) {
  const fixes = [];
  for (const m of models) for (const w of m.warnings) if (w.severity === 'fix') fixes.push({ m, w });
  const b = installButtonState({ data }, st.ticks, st.busy);
  const installables = models.filter((m) => m.installable);
  const manual = models.some((m) => !m.connected && m.copy) || (Array.isArray(data.notFound) && data.notFound.length > 0);
  if (!fixes.length && !installables.length && data.writable) {
    return renderStatusLine('Every agent app The Curator can install into on this ' + machineWord(data.platform) + ' is connected.',
      manual ? '<button type="button" class="btn btn-secondary btn-xs" data-mcpi-act="copy-myself">Copy an entry myself</button>' : '');
  }
  const chips = [];
  for (const { m, w } of fixes) for (const a of w.acts || []) chips.push(fixChip(a, m.label));
  chips.push(installChip(b, st.busy, data));
  chips.push('<button type="button" class="btn btn-secondary btn-xs cur-action-chip" data-mcpi-act="copy-myself"><span class="cur-action-label">Copy an entry myself</span></button>');
  const run = [];
  for (const { m, w } of fixes) {
    const text = (w.kind === 'entry' ? m.label + ': ' + w.text : w.text.replace(/^Its /, m.label + '’s '))
      + (isStr(w.strong) ? ' ' + w.strong : '') + (w.install ? ' Install for me rewrites it.' : '');
    run.push('<p data-mcpi-warn="' + escapeHtml(w.kind || 'warn') + '"' + (w.code ? ' data-mcpi-reason="' + escapeHtml(w.code) + '"' : '') + '>' + escapeHtml(text) + '</p>');
  }
  for (const m of models) {
    if (m.appRunning) run.push('<p data-mcpi-app-running>' + escapeHtml(APP_RUNNING_WORDS) + '</p>');
    else if (m.hint) run.push('<p data-mcpi-hint="' + escapeHtml(m.id) + '">' + escapeHtml(m.hint) + '</p>');
  }
  if (!data.writable) run.push('<p data-mcpi-nonmac>' + escapeHtml(nonMacLine(data)) + '</p>');
  else if (data.platform === 'win32') {
    run.push('<p data-mcpi-windows>' + escapeHtml(windowsLine()) + '</p>');
    if (installables.some((m) => WINDOWS_INSTALLABLE.includes(m.id))) run.push('<p data-mcpi-new-windows>' + escapeHtml(WINDOWS_NEW_LABEL) + '</p>');
  }
  const picks = installables.length
    ? '<div class="cur-action-picks" role="group" aria-label="Install into">' + installables.map((m) => '<label class="cur-action-pick">'
      + '<input type="checkbox" class="cur-check cur-check-sm" data-mcpi-tick="' + escapeHtml(m.id) + '"' + (m.ticked ? ' checked' : '')
      + ' aria-label="' + escapeHtml('Include ' + m.label + ' in the install') + '">' + escapeHtml(m.label) + '</label>').join('') + '</div>'
    : '';
  return withAttrs(renderActionCard({
    eyebrow: fixes.length ? 'NEXT STEP · ' + fixes.length + ' TO FIX' : 'CONNECT',
    chipsHtml: chips.join(''),
    runHtml: run.join('') + picks,
    footnoteHtml: renderDescription('Install for me writes only the my-curator entry, after a preview, and keeps a copy of the file first. The check itself only reads.'),
  }), ' id="mcpi-next-step" data-mcpi-next');
}

// ── the preview ────────────────────────────────────────────────────────────

const PLAN_TITLE = 'PLAN READY · NOTHING WRITTEN YET';
const ITEM_VERB = Object.freeze({ add: 'add the entry to', update: 'update the entry in', remove: 'remove the entry from', restore: 'put back the original of', none: 'no change in' });

function itemVerb(item, action) {
  if (action === 'remove') return ITEM_VERB.remove;
  if (action === 'restore') return ITEM_VERB.restore;
  const a = isStr(item.action) ? item.action : 'add';
  return ITEM_VERB[a] || ITEM_VERB.add;
}

/** The "Your N other servers stay unchanged: a, b" line. */
export function preservedLine(names) {
  const list = Array.isArray(names) ? names.filter(isStr) : [];
  if (!list.length) return 'No other servers are in this file.';
  return 'Your ' + (list.length === 1 ? '1 other server stays' : list.length + ' other servers stay') + ' unchanged: ' + list.join(', ') + '.';
}

/** "31 Oct, 09:58" in the reader's own clock, or '' when the stamp can't be read. */
export function keptOnWords(iso) {
  const t = isStr(iso) ? new Date(iso) : null;
  if (!t || !Number.isFinite(t.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getMonth()];
  return t.getDate() + ' ' + mon + ', ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
}

/** Which copy goes back, and when it was kept. Falls back gracefully on an older server. */
export function restoreWords(item) {
  const when = keptOnWords(item.restoreFromAt);
  const name = isStr(item.restoreFrom) ? item.restoreFrom : '';
  if (when && name) return 'Puts back the copy kept on ' + when + ' (' + name + ').';
  if (when) return 'Puts back the copy kept on ' + when + '.';
  if (name) return 'Puts back the copy ' + name + '.';
  return 'Puts back the copy kept earlier.';
}

/** The backend's literal stand-in for the apply time in a copy's name (never shown as-is). */
export const BACKUP_AT_APPLY = '<UTC time of apply>';

/** One planned file: what happens to it, the exact entry, what is kept. */
function planItem(item, action, tool) {
  const label = item.label || item.id || '';
  if (item.refused) {
    return withAttrs(renderFoldItem({ main: item.file || undefined,
      meta: label + ' — not changed: ' + (item.refused.message || item.refused.reason || 'this file was left as it is.') }),
    ' data-mcpi-plan-item="' + escapeHtml(item.id) + '" data-mcpi-plan-refused');
  }
  const head = withAttrs(renderFoldItem({ main: item.file || '', meta: label + ' — ' + itemVerb(item, action) + ' this file' }),
    ' data-mcpi-plan-item="' + escapeHtml(item.id) + '"');
  const parts = [head];
  if (action === 'restore') parts.push('<p data-mcpi-restore-from>' + escapeHtml(restoreWords(item)) + '</p>');
  if (isStr(item.entryText)) {
    parts.push('<p>' + escapeHtml(action === 'remove' ? 'This entry is removed:' : action === 'restore' ? 'After the restore its My Curator entry reads:' : 'The entry written:') + '</p>');
    parts.push('<pre class="mono cur-action-entry" data-mcpi-entry>' + escapeHtml(item.entryText) + '</pre>');
  }
  if (action !== 'restore') parts.push('<p data-mcpi-preserved>' + escapeHtml(preservedLine(item.preserved)) + '</p>');
  const absent = item.basis === 'absent';
  const placeholder = isStr(item.backupWillBe) && item.backupWillBe.includes(BACKUP_AT_APPLY);
  if (absent) parts.push('<p>This file does not exist yet — it is created, so there is no original to keep.</p>');
  else if (placeholder) {
    parts.push(withAttrs(renderFoldItem({ main: item.backupWillBe.replace(BACKUP_AT_APPLY, '…'),
      meta: action === 'restore' ? 'your current file, kept as a new dated copy first' : 'a dated copy of the current file, kept beside it first' }), ' data-mcpi-backup'));
  } else if (isStr(item.backupWillBe)) {
    parts.push(withAttrs(renderFoldItem({ main: item.backupWillBe,
      meta: action === 'restore' ? 'your current file, kept as a new copy first' : 'a new copy of the current file, kept beside it first' }), ' data-mcpi-backup'));
  } else if (action === 'restore') parts.push('<p>Your current file is kept as a new copy first.</p>');
  const running = tool && tool.running && tool.running.running === true;
  if (running && item.id === 'claude-desktop') {
    parts.push('<p data-mcpi-quit>' + escapeHtml((label || 'Claude Desktop') + ' is running. Quit it first for the safest install — it rewrites its own file.') + '</p>');
  } else if (running) parts.push('<p>' + escapeHtml(label + ' is running — it needs a restart to pick this up.') + '</p>');
  return parts.join('');
}

/** The preview — the exact entry, the preserved servers' names, the backup. Apply · Cancel. An action card. */
export function renderPlanCard(plan, tools, busy) {
  if (!plan || !Array.isArray(plan.items)) return '';
  const action = ['install', 'remove', 'restore'].includes(plan.action) ? plan.action : 'install';
  const byId = {};
  for (const t of Array.isArray(tools) ? tools : []) if (t && t.id) byId[t.id] = t;
  const doable = plan.items.filter((i) => !i.refused).length;
  const applyWord = action === 'remove' ? 'Remove' : action === 'restore' ? 'Restore' : 'Apply';
  const applyLabel = busy === 'apply' ? 'Writing…' : applyWord;
  const chips = '<button type="button" class="btn btn-primary btn-xs cur-action-chip" data-mcpi-act="apply"' + (doable === 0 || busy ? ' disabled' : '') + '>'
    + '<span class="cur-action-label">' + escapeHtml(applyLabel) + '</span>'
    + (doable ? '<span class="cur-action-cost">' + escapeHtml(doable === 1 ? '1 file' : doable + ' files') + '</span>' : '') + '</button>'
    + '<button type="button" class="btn btn-secondary btn-xs cur-action-chip" data-mcpi-act="cancel"' + (busy === 'apply' ? ' disabled' : '') + '>'
    + '<span class="cur-action-label">Cancel</span></button>';
  return withAttrs(renderActionCard({
    eyebrow: PLAN_TITLE,
    chipsHtml: chips,
    runHtml: plan.items.map((i) => planItem(i, action, byId[i.id])).join(''),
    footnoteHtml: renderDescription('Only the my-curator entry changes. Nothing is written until you press ' + applyWord + '.'),
  }), ' id="mcpi-next-step" data-mcpi-plan role="region" aria-label="Plan"');
}

// ── results ────────────────────────────────────────────────────────────────

const RESULT_VERB = Object.freeze({
  install: { written: 'added', created: 'created with the My Curator entry', unchanged: 'already up to date' },
  update: { written: 'updated', created: 'created with the My Curator entry', unchanged: 'already up to date' },
  remove: { written: 'entry removed', created: 'entry removed', unchanged: 'had no entry' },
  restore: { written: 'original put back', created: 'original put back', unchanged: 'already the original' },
});

function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

/**
 * One result as data: `{outcome, file, text}` — "Claude Desktop — added ·
 * original kept · quit and reopen Claude Desktop". `planItems` (id+file →
 * plan item) tell an add from an update; the action is the plan's. Pure.
 */
export function resultWords(r, action, planItems) {
  const label = r.label || r.id || '';
  const outcome = ['written', 'created', 'unchanged', 'refused'].includes(r.outcome) ? r.outcome : 'refused';
  if (outcome === 'refused') {
    return { outcome, file: r.file || '', text: label + ' — not changed'
      + (isStr(r.message) ? ': ' + r.message : (isStr(r.reason) ? ': ' + r.reason : '')) + ' Nothing was written to this file.' };
  }
  const item = (Array.isArray(planItems) ? planItems : []).find((i) => i && i.id === r.id && (!r.file || i.file === r.file));
  const kind = action === 'install' && item && item.action === 'update' ? 'update' : action;
  const verbs = RESULT_VERB[kind] || RESULT_VERB.install;
  const bits = [verbs[outcome]];
  if (isStr(r.backup)) bits.push('original kept');
  else if (outcome === 'created') bits.push('no original to keep');
  if (isStr(r.restart) && outcome !== 'unchanged') bits.push(lowerFirst(r.restart));
  return { outcome, file: r.file || '', text: label + ' — ' + bits.join(' · ') };
}

/** Back-compat name: one result as a fold item. */
export function resultLine(r, action, planItems) {
  const w = resultWords(r, action, planItems);
  return withAttrs(renderFoldItem({ main: w.file || undefined, meta: w.text }), ' data-mcpi-result="' + w.outcome + '"');
}

/** The restart sentence: names the running tools that were changed. '' when none. */
export function restartLine(results, tools, platform) {
  const running = new Set((Array.isArray(tools) ? tools : []).filter((t) => t && t.running && t.running.running === true
    && !(platform === 'win32' && t.id === 'claude-desktop')).map((t) => t.id));
  const names = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (r && (r.outcome === 'written' || r.outcome === 'created') && running.has(r.id) && !names.includes(r.label || r.id)) names.push(r.label || r.id);
  }
  if (!names.length) return '';
  return names.join(', ') + (names.length === 1 ? ' is' : ' are') + ' running — restart '
    + (names.length === 1 ? 'it' : 'them') + ' to load My Curator.';
}

/** The results: every line, the restart line, Check again · Dismiss. Never folded. An action card. */
export function renderResults(res, tools, platform) {
  if (!res || !Array.isArray(res.items)) return '';
  const lines = res.items.map((r) => resultLine(r, res.action || 'install', res.planItems)).join('');
  const rs = restartLine(res.items, tools, platform);
  const win = platform === 'win32' && res.items.some((r) => r && r.id === 'claude-desktop' && (r.outcome === 'written' || r.outcome === 'created'));
  const any = res.items.some((r) => r && (r.outcome === 'written' || r.outcome === 'created'));
  const chips = '<button type="button" class="btn btn-' + (any ? 'primary' : 'secondary') + ' btn-xs cur-action-chip" data-mcpi-act="check-again">'
    + '<span class="cur-action-label">Check again</span>'
    + (any ? '<span class="cur-action-cost">reads the files back</span>' : '') + '</button>'
    + '<button type="button" class="btn btn-secondary btn-xs cur-action-chip" data-mcpi-act="dismiss"><span class="cur-action-label">Dismiss</span></button>';
  return withAttrs(renderActionCard({
    eyebrow: any ? 'DONE · RESTART THE APP TO LOAD IT' : 'NOTHING WAS WRITTEN',
    chipsHtml: chips,
    runHtml: lines
      + (rs ? '<p data-mcpi-restart>' + escapeHtml(rs) + '</p>' : '')
      + (win ? '<p data-mcpi-restart-windows>' + escapeHtml(WINDOWS_RESTART_LINE) + '</p>' : ''),
  }), ' id="mcpi-next-step" data-mcpi-results role="status"');
}

// ── the ① card's body ──────────────────────────────────────────────────────

/**
 * Section ① "Agent apps", after its control row: the statuses (an error, a
 * copy, a Check entry outcome — each `renderStatus`, never folded), then ONE
 * action card (Next step, the plan, or the results), then one fold row per
 * app and the "Not on this Mac" row.
 * `st` = `{status:{data,error,loading}, ticks, plan, results, busy, error,
 * copied, folds, paths, machineFiles, machine, bridges, current, now,
 * checks: {id: {busy, result, error}}, checkBusy}`.
 */
export function renderAgentApps(st) {
  const s = st || {};
  const status = s.status || null;
  const data = status && status.data;
  if (!data) {
    if (status && status.error) return renderStatus({ state: 'danger', title: 'Could not check your agent apps', detail: status.error });
    return renderStatus({ state: 'neutral', title: 'Checking your agent apps…' });
  }
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const ctx = { ticks: s.ticks, folds: s.folds, paths: s.paths, machineFiles: s.machineFiles,
    machine: s.machine || null, bridges: s.bridges || null, current: s.current || {}, now: s.now, checkBusy: s.checkBusy || null };
  const models = appRowModels(status, ctx);
  const out = [];
  if (isStr(s.error)) out.push(withAttrs(renderStatus({ state: 'danger', title: s.error }), ' data-mcpi-error'));
  if (status.error) out.push(renderStatus({ state: 'danger', title: 'Could not re-check', detail: status.error }));
  if (isStr(s.copied)) out.push(withAttrs(renderStatus({ state: 'success', title: s.copied }), ' data-mcpi-copied'));
  for (const [id, c] of Object.entries(s.checks || {})) {
    const m = models.find((x) => x.id === id);
    const html = checkStatusHtml(m ? m.label : id, c);
    if (html) out.push(html);
  }
  const notes = out.splice(0, out.length);
  if (notes.length) out.push('<div class="cur-card-notes">' + notes.join('') + '</div>');
  out.push(s.plan ? renderPlanCard(s.plan, tools, s.busy)
    : s.results ? renderResults(s.results, tools, data.platform)
      : nextStepCard(models, data, { ticks: s.ticks, busy: s.busy }));
  const rows = models.map((m) => appFoldRow(m, ctx)).join('') + notFoundFoldRow(data, ctx);
  if (rows) out.push(withAttrs(renderFoldRows(rows), ' id="mcpi-rows"'));
  else out.push(renderStatus({ state: 'neutral', title: 'No agent app was found on this ' + machineWord(data.platform) + '.' }));
  return out.join('');
}

/**
 * A Check entry outcome as a status (v3.89.0): "Claude Desktop's entry
 * starts · 24 tools", or what stopped it in plain words. Never folded.
 */
export function checkStatusHtml(label, c) {
  if (!c) return '';
  const attr = (k) => ' data-mcpi-check="' + k + '"';
  if (c.busy) return withAttrs(renderStatus({ state: 'neutral', title: 'Starting ' + label + '’s entry…' }), attr('busy'));
  if (isStr(c.error)) return withAttrs(renderStatus({ state: 'danger', title: 'Could not check ' + label + '’s entry', detail: c.error }), attr('error'));
  const r = c.result;
  if (!r || typeof r !== 'object') return '';
  const list = Array.isArray(r.results) ? r.results : [];
  if (!list.length) return withAttrs(renderStatus({ state: 'attention', title: r.message || label + ' has no entry to start.' }), attr('none'));
  const ok = list.every((x) => x && x.starts === true);
  if (ok) {
    const n = list[0].toolCount;
    const files = [...new Set(list.map((x) => x.file).filter(isStr))];
    return withAttrs(renderStatus({ state: 'success', title: label + '’s entry starts' + (Number.isInteger(n) ? ' · ' + n + (n === 1 ? ' tool' : ' tools') : ''),
      detail: 'Started exactly as ' + label + ' starts it, from ' + files.join(' and ') + '.' }), attr('starts'));
  }
  const bad = list.filter((x) => !(x && x.starts === true));
  const notRun = bad.every((x) => x.ran === false);
  const detail = bad.map((x) => (x.file ? x.file + ': ' : '') + (x.message || 'it did not answer as My Curator.')).join(' ');
  return withAttrs(renderStatus({ state: notRun ? 'attention' : 'danger',
    title: notRun ? label + '’s entry was not started' : label + '’s entry does not start', detail }), attr(notRun ? 'refused' : 'fails'));
}

// ── requests (the only network code; every one is called from a click) ─────

async function readJson(res) {
  const ct = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '').toLowerCase();
  if (ct.includes('text/html')) return { ok: false, code: 'stale', message: 'This version of The Curator can’t install into agent apps yet — update the app.' };
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
  if (code === 'platform_unsupported') return 'One-click install works on a Mac in this version. Copy the entry instead.';
  if (code === 'busy') return 'Another install is still running. Wait a moment, then try again.';
  if (code === 'stale') return r.message;
  if (code === 'network') return 'Could not reach The Curator. Nothing was changed.';
  return (r && r.message ? r.message : 'The request failed.') + ' Nothing was changed.';
}
