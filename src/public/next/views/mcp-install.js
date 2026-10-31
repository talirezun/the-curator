// Settings › MCP bridge › 5 "Tools on this Mac" › "My Curator in your tools"
// (v3.85.0) — the status check and the one-click install, the words.
//
// DOM-FREE AT IMPORT (the setup-machine.js / setup-step.js rule):
// scripts/test-next-mcp-install.js imports these builders in plain Node.
// settings.js owns the state, the listeners and what happens on a click; this
// file owns what is SAID, and the four small request functions at the bottom
// (the only code here that touches the network, and only when called).
//
// WHAT THE PANEL MAY DO. The app may write ANOTHER tool's config file only to
// add, update or remove its OWN `my-curator` entry — on a click, after a
// preview of the exact entry, with a copy of the original kept. The status
// check itself is read-only. Nothing in this file fires a request on its own:
// every request function is called from a click handler (or the one status
// read when the section loads), never from a render.
//
// THE RULES THIS FILE CARRIES
//   · a status tag is GREYSCALE — a shape, never a colour (colour is a
//     domain's; the `mcpi-st-*` rules draw dots in --text-2 / --text-3 only);
//   · a refusal reason, a preview's entry text and every result line are
//     rendered OPEN — nothing a person must read sits behind a chevron;
//   · explanations live in the block's ⓘ (explainers.js), never inline;
//   · every path, tool name and server name is escaped.

import { renderOverview } from '../shared/overview.js';
import { ageWordsFor } from '../shared/age-ticker.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const isStr = (v) => typeof v === 'string' && v.length > 0;

// ── the vocabulary ─────────────────────────────────────────────────────────

/** One word per status (contract §1). Frozen; an unknown status reads as copy-only. */
export const STATUS_WORDS = Object.freeze({
  connected: 'connected',
  'needs-update': 'needs an update',
  'not-installed': 'can be added',
  'cant-read': 'can’t read',
  manual: 'copy only',
});
export const STATUSES = Object.freeze(Object.keys(STATUS_WORDS));

/** The statuses whose row is ticked by default (contract §1). */
export const DEFAULT_TICKED = Object.freeze(['needs-update', 'not-installed']);

const normStatus = (s) => (Object.hasOwn(STATUS_WORDS, s) ? s : 'manual');

/** v3.86.0 — on Windows only Claude Desktop can be written; every other tool is copy-only. */
export const WINDOWS_INSTALLABLE = Object.freeze(['claude-desktop']);
/** The small greyscale label on the one Windows row that can be installed. */
export const WINDOWS_NEW_LABEL = 'New on Windows — tell us if it works';
/** Said OPEN after Claude Desktop is changed on Windows. */
export const WINDOWS_RESTART_LINE = 'Quit Claude Desktop fully (system tray → Quit), reopen it, then press Check again';

/** Whether a click may write this tool's file on this platform ('' / darwin / linux: the status decides). */
function writableHere(tool, platform) {
  return platform !== 'win32' || (!!tool && WINDOWS_INSTALLABLE.includes(tool.id));
}

/** The tools whose row offers a checkbox: the ones a click may write to. */
export function isInstallable(tool, platform) {
  return !!tool && (tool.status === 'needs-update' || tool.status === 'not-installed') && tool.installer === 'file'
    && writableHere(tool, platform);
}

/** A tool's status as this platform shows it: a Windows row that cannot be written reads "copy only". */
function effStatus(tool, platform) {
  const s = normStatus(tool && tool.status);
  return (s === 'needs-update' || s === 'not-installed') && !writableHere(tool, platform) ? 'manual' : s;
}

/** `{connected, needsUpdate, canAdd, cantRead, manual}` over a status payload's tools. Pure. */
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

/**
 * "My Curator in your tools — 2 connected · 1 needs an update · 1 can be added".
 * Zero counts are left out; nothing to say says so.
 */
export function overviewLine(tools, platform) {
  const c = countStatuses(tools, platform);
  const parts = [];
  if (c.connected) parts.push(c.connected + ' connected');
  if (c.needsUpdate) parts.push(c.needsUpdate + (c.needsUpdate === 1 ? ' needs an update' : ' need an update'));
  if (c.canAdd) parts.push(c.canAdd + ' can be added');
  if (c.cantRead) parts.push(c.cantRead + ' can’t be read');
  if (c.manual) parts.push(c.manual + ' copy only');
  return 'My Curator in your tools — ' + (parts.length ? parts.join(' · ') : 'no tool found on this ' + (platform === 'win32' ? 'PC' : 'Mac'));
}

/** Which tool ids start ticked. `overrides` (id → boolean) are the person's own ticks. Pure. */
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

/** The Install button's label and whether it is disabled. */
export function installButtonState(status, ticks, busy) {
  const data = status && status.data;
  const tools = data && Array.isArray(data.tools) ? data.tools : [];
  const n = tickedIds(tools, ticks, data && data.platform).length;
  const writable = !!(data && data.writable);
  return {
    n,
    label: n > 1 ? 'Install for me (' + n + ' tools)' : 'Install for me',
    disabled: !writable || n === 0 || !!busy,
  };
}

// ── tags ───────────────────────────────────────────────────────────────────

/** A greyscale status tag: the word, and a dot whose SHAPE (not colour) differs. */
export function statusTag(status) {
  const s = normStatus(status);
  return '<span class="mcpi-st mcpi-st-' + s + '" data-mcpi-status="' + s + '">' + escapeHtml(STATUS_WORDS[s]) + '</span>';
}

function newOnWindowsTag(tool, platform) {
  return platform === 'win32' && tool && WINDOWS_INSTALLABLE.includes(tool.id) && tool.installer === 'file'
    ? '<span class="mcpi-note mcpi-new" data-mcpi-new-windows>' + escapeHtml(WINDOWS_NEW_LABEL) + '</span>' : '';
}

function runningTag(tool) {
  const r = tool && tool.running;
  return r && r.checked === true && r.running === true
    ? '<span class="mcpi-st mcpi-st-running" data-mcpi-running>running</span>' : '';
}

function usedNote(tool, now = Date.now()) {
  if (!tool || !isStr(tool.usedAt)) return '';
  const words = ageWordsFor(tool.usedAt, now, 'used');
  if (!words) return '';
  return '<span class="mcpi-note" data-age-at="' + escapeHtml(tool.usedAt) + '" data-age-prefix="used" data-age-text>'
    + escapeHtml(words) + '</span>';
}

const btnP = (act, label, extra = '') => '<button type="button" class="btn btn-primary btn-xs" data-mcpi-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';
const btnS = (act, label, extra = '') => '<button type="button" class="btn btn-secondary btn-xs" data-mcpi-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';
const btnG = (act, label, extra = '') => '<button type="button" class="btn btn-ghost btn-xs" data-mcpi-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';

// ── the overview card + the two buttons ────────────────────────────────────

/**
 * ONE overview (rule 1) — three readings and the two buttons under it. The
 * sentence is also the card's accessible summary. `busy` is 'plan' | 'apply' |
 * 'status' | null.
 */
export function renderInstallOverview(status, ticks, busy) {
  const data = status && status.data;
  if (!data) return '';
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const c = countStatuses(tools, data.platform);
  const card = renderOverview({
    id: 'settings-mcpi-overview',
    eyebrow: 'MY CURATOR IN YOUR TOOLS',
    minTrack: 130,
    cards: [
      { label: 'CONNECTED', value: String(c.connected) },
      { label: 'NEEDS AN UPDATE', value: String(c.needsUpdate) },
      { label: 'CAN BE ADDED', value: String(c.canAdd) },
    ],
  });
  const b = installButtonState(status, ticks, busy);
  const installLabel = busy === 'plan' ? 'Preparing…' : b.label;
  return '<div class="mcpi-overview">'
    + '<p class="visually-hidden" role="status">' + escapeHtml(overviewLine(tools, data.platform)) + '</p>'
    + card
    + '<div class="mcpi-buttons">'
    + '<button type="button" class="btn btn-primary" id="mcpi-install-btn" data-mcpi-act="install"' + (b.disabled ? ' disabled' : '') + '>' + escapeHtml(installLabel) + '</button>'
    + '<button type="button" class="btn btn-secondary" data-mcpi-act="copy-myself">Copy it myself</button>'
    + '</div>'
    + (data.writable ? (data.platform === 'win32' ? windowsLine() : '') : nonMacLine(data))
    + '</div>';
}

/** Said OPEN whenever one-click install is not available on this computer. */
export function nonMacLine(data) {
  const p = data && isStr(data.platform) ? data.platform : '';
  if (p === 'win32') {
    return '<p class="mcpi-line" data-mcpi-nonmac>One-click install on Windows is not available right now — copy the entry for each tool instead.</p>';
  }
  const where = p && p !== 'darwin' ? ' on ' + (p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p) : '';
  return '<p class="mcpi-line" data-mcpi-nonmac>One-click install works on a Mac in this version' + escapeHtml(where)
    + ' — copy the entry for each tool instead.</p>';
}

/** Said OPEN on Windows when install works: one tool only. */
export function windowsLine() {
  return '<p class="mcpi-line" data-mcpi-windows>On Windows, one-click install covers Claude Desktop only — copy the entry for each other tool.</p>';
}

// ── tool rows ──────────────────────────────────────────────────────────────

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
    return { text: whole, whole: true, file: null, line: 'Add this to the tool’s own MCP config file.' };
  }
  if (exists === false) return { text: whole, whole: true, file, line: 'Save as ' + file };
  if (inner && key) return { text: inner, whole: false, file, line: 'Paste into ' + file + ' inside "' + key + '"' };
  return { text: whole, whole: true, file, line: 'Add this to ' + file };
}

/** An escaped path that may wrap only after a slash or a backslash (Windows). */
function wbrPath(p) { return escapeHtml(p).replace(/[\/\\]/g, '$&<wbr>'); }

/**
 * The reason a row is copy-only, in words. `config_not_found` and
 * `config_ambiguous` (v3.86.0) are said for a person; any other reason is the
 * backend's own message. Candidate files come from the reason, else the row's files.
 */
export function reasonWords(tool) {
  const r = tool && tool.reason;
  const code = r && typeof r === 'object' ? r.code : '';
  const names = (list) => (Array.isArray(list) ? list : []).map((x) => (isStr(x) ? x : x && (x.display || x.file))).filter(isStr);
  if (code === 'config_not_found') return 'Open Claude Desktop once, then press Check again';
  if (code === 'config_ambiguous') {
    const c = names(r.candidates).length ? names(r.candidates) : names(tool.files);
    return 'Claude Desktop has more than one config file' + (c.length ? ': ' + c.join(' · ') : '')
      + ' — nothing was changed. Add the entry to the one it uses.';
  }
  return reasonText(r);
}

function fileLines(tool) {
  const files = Array.isArray(tool.files) ? tool.files : [];
  if (!files.length) return '';
  return files.map((f) => '<span class="mcpi-path mono">' + wbrPath(f && (f.display || f.file) || '') + '</span>').join('');
}

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
 * One tool's row. Checkbox · label · file(s) · status tag · running tag · used
 * note, then the actions, then — OPEN — the reason a tool can't be read and
 * the restart hint.
 */
export function renderToolRow(tool, ctx = {}) {
  const platform = ctx.platform;
  const status = effStatus(tool, platform);
  const ticks = ctx.ticks || {};
  const id = String(tool.id || '');
  const installable = isInstallable(tool, platform) && ctx.writable !== false;
  const canWrite = tool.installer === 'file' && ctx.writable !== false && writableHere(tool, platform);
  const ticked = installable && defaultTicks([tool], ticks, platform)[id] === true;
  const label = '<span class="mcpi-name">' + escapeHtml(tool.label || id) + '</span>';
  const head = installable
    ? '<label class="mcpi-pick"><input type="checkbox" class="cur-check cur-check-sm" data-mcpi-tick="' + escapeHtml(id) + '"' + (ticked ? ' checked' : '')
      + ' aria-label="' + escapeHtml('Include ' + (tool.label || id) + ' in the install') + '">' + label + '</label>'
    : '<span class="mcpi-pick">' + label + '</span>';
  const tid = ' data-tool="' + escapeHtml(id) + '"';
  const acts = [];
  const plan = status !== 'connected' && ctx.data ? copyPlanFor(id, ctx.data, ctx.machineFiles) : null;
  const snippet = !!plan;
  if (status === 'connected' && canWrite) acts.push(btnG('remove', 'Remove', tid));
  if (tool.restorable === true && canWrite) acts.push(btnG('restore', 'Restore original', tid));
  if (status === 'cant-read') {
    // Reveal is `open -R` (macOS only): never a dead button on Windows or Linux.
    const p = isStr(platform) && platform !== 'darwin' ? '' : revealPathFor(tool, ctx.paths);
    if (p) acts.push(btnG('reveal', 'Reveal', ' data-path="' + escapeHtml(p) + '"'));
  }
  if ((status === 'manual' || status === 'cant-read' || status === 'not-installed' || status === 'needs-update') && snippet) {
    acts.push(btnG('copy', 'Copy', tid));
  }
  const reason = reasonWords(tool) ? '<p class="mcpi-reason" data-mcpi-reason>' + escapeHtml(reasonWords(tool)) + '</p>' : '';
  const copyLine = plan ? '<p class="mcpi-copyline" data-mcpi-copyline>' + wbrPath(plan.line) + '</p>' : '';
  const hint = isStr(tool.restartHint) && tool.running && tool.running.running === true
    ? '<p class="mcpi-hint">' + escapeHtml(tool.restartHint) + '</p>' : '';
  const extra = isStr(tool.note) ? '<p class="mcpi-hint">' + escapeHtml(tool.note) + '</p>' : '';
  return '<div class="mcpi-row mcpi-row-' + status + '" data-mcpi-tool="' + escapeHtml(id) + '">'
    + '<div class="mcpi-l1">' + head
    + '<span class="mcpi-tags">' + statusTag(status) + runningTag(tool) + usedNote(tool, ctx.now) + (ctx.writable !== false ? newOnWindowsTag(tool, platform) : '') + '</span>'
    + '<span class="mcpi-acts">' + acts.join('') + '</span></div>'
    + (fileLines(tool) ? '<div class="mcpi-files">' + fileLines(tool) + '</div>' : '')
    + reason + copyLine + hint + extra
    + '</div>';
}

/** The rows and the "Not found on this Mac (N)" fold. */
export function renderToolRows(status, ctx = {}) {
  const data = status && status.data;
  if (!data) return '';
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const c2 = { ...ctx, writable: data.writable, data, platform: data.platform };
  const rows = tools.map((t) => renderToolRow(t, c2)).join('');
  const nf = Array.isArray(data.notFound) ? data.notFound : [];
  const open = ctx.folds && ctx.folds['mcpi-notfound'];
  const snippets = data.manualSnippets || {};
  const fold = nf.length
    ? '<details class="settings-setup-fold mcpi-notfound" data-setup-fold="mcpi-notfound"' + (open ? ' open' : '') + '>'
      + '<summary class="settings-setup-summary"><span class="settings-setup-name">Not found on this Mac (' + nf.length + ')</span></summary>'
      + '<div class="mcpi-nf-body">' + nf.map((t) => '<div class="mcpi-row mcpi-row-nf" data-mcpi-tool="' + escapeHtml(t.id) + '">'
        + '<div class="mcpi-l1"><span class="mcpi-pick"><span class="mcpi-name">' + escapeHtml(t.label || t.id) + '</span></span>'
        + '<span class="mcpi-acts">' + (isStr(snippets[t.id]) ? btnG('copy', 'Copy', ' data-tool="' + escapeHtml(t.id) + '"') : '') + '</span></div>'
        + (() => { const pl = copyPlanFor(t.id, data, ctx.machineFiles); return pl ? '<p class="mcpi-copyline" data-mcpi-copyline>' + wbrPath(pl.line) + '</p>' : ''; })()
        + '</div>').join('') + '</div></details>'
    : '';
  const none = !tools.length && !nf.length ? '<p class="mcpi-line">No agent tool was found on this Mac.</p>' : '';
  return '<div class="mcpi-rows" id="mcpi-rows">' + rows + '</div>' + fold + none;
}

// ── the preview ────────────────────────────────────────────────────────────

const PLAN_TITLE = Object.freeze({ install: 'Plan ready — nothing written yet', remove: 'Plan ready — nothing written yet', restore: 'Plan ready — nothing written yet' });
const ITEM_VERB = Object.freeze({ add: 'Add to', update: 'Update in', remove: 'Remove from', restore: 'Restore', none: 'No change in' });

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

function planItem(item, action, tool) {
  const label = escapeHtml(item.label || item.id || '');
  const file = '<span class="mono">' + escapeHtml(item.file || '') + '</span>';
  if (item.refused) {
    return '<div class="mcpi-plan-item mcpi-plan-refused" data-mcpi-plan-item="' + escapeHtml(item.id) + '">'
      + '<div class="mcpi-plan-head"><strong>' + label + '</strong> — not changed</div>'
      + '<p class="mcpi-line">' + escapeHtml(item.refused.message || item.refused.reason || 'This file was left as it is.') + '</p></div>';
  }
  const entry = isStr(item.entryText)
    ? '<div class="mcpi-plan-cap">' + (action === 'remove' ? 'This entry is removed:' : action === 'restore' ? 'After the restore its My Curator entry reads:' : 'The entry written:') + '</div>'
      + '<pre class="mcpi-entry" data-mcpi-entry>' + escapeHtml(item.entryText) + '</pre>' : '';
  const restoreLine = action === 'restore' ? '<p class="mcpi-line" data-mcpi-restore-from>' + escapeHtml(restoreWords(item)) + '</p>' : '';
  const absent = item.basis === 'absent';
  const placeholder = isStr(item.backupWillBe) && item.backupWillBe.includes(BACKUP_AT_APPLY);
  // The backend names the copy by a literal placeholder (the time is known only at apply). Said for a person.
  const dated = placeholder ? wbrPath(item.backupWillBe.replace(BACKUP_AT_APPLY, '…')).replace(/<wbr>/g, '') : '';
  const keeps = absent
    ? '<p class="mcpi-line">This file does not exist yet — it is created, so there is no original to keep.</p>'
    : (placeholder
      ? '<p class="mcpi-line" data-mcpi-backup>' + (action === 'restore'
        ? 'Your current file is kept as a new dated copy first.'
        : 'A dated copy of the current file is kept beside it (<span class="mono">' + dated + '</span>).') + '</p>'
      : (isStr(item.backupWillBe) ? '<p class="mcpi-line">' + (action === 'restore' ? 'Your current file is kept as a new copy first: ' : 'A new copy of the current file is kept beside it as ')
        + '<span class="mono">' + wbrPath(item.backupWillBe).replace(/<wbr>/g, '') + '</span>.</p>'
        : (action === 'restore' ? '<p class="mcpi-line">Your current file is kept as a new copy first.</p>' : '')));
  const running = tool && tool.running && tool.running.running === true;
  const quit = running && item.id === 'claude-desktop'
    ? '<p class="mcpi-line mcpi-quit" data-mcpi-quit>' + escapeHtml((item.label || 'Claude Desktop') + ' is running. Quit it first for the safest install — it rewrites its own file.') + '</p>'
    : (running ? '<p class="mcpi-line">' + escapeHtml((item.label || item.id) + ' is running — it needs a restart to pick this up.') + '</p>' : '');
  return '<div class="mcpi-plan-item" data-mcpi-plan-item="' + escapeHtml(item.id) + '">'
    + '<div class="mcpi-plan-head"><strong>' + label + '</strong> — ' + escapeHtml(itemVerb(item, action)) + ' ' + file + '</div>'
    + restoreLine + entry
    + (action === 'restore' ? '' : '<p class="mcpi-line">' + escapeHtml(preservedLine(item.preserved)) + '</p>')
    + keeps + quit
    + '</div>';
}

/** The preview card — the exact entry, the preserved servers' names, the backup. Apply · Cancel. */
export function renderPlanCard(plan, tools, busy) {
  if (!plan || !Array.isArray(plan.items)) return '';
  const action = ['install', 'remove', 'restore'].includes(plan.action) ? plan.action : 'install';
  const byId = {};
  for (const t of Array.isArray(tools) ? tools : []) if (t && t.id) byId[t.id] = t;
  const doable = plan.items.filter((i) => !i.refused).length;
  const applyWord = action === 'remove' ? 'Remove' : action === 'restore' ? 'Restore' : 'Apply';
  const applyLabel = busy === 'apply' ? 'Writing…' : applyWord;
  return '<div class="dm-plan-card mcpi-plan" data-mcpi-plan role="region" aria-label="Plan">'
    + '<div class="dm-plan-title">' + PLAN_TITLE[action] + '</div>'
    + plan.items.map((i) => planItem(i, action, byId[i.id])).join('')
    + '<div class="dm-plan-actions">'
    + '<button type="button" class="btn btn-primary" data-mcpi-act="apply"' + (doable === 0 || busy ? ' disabled' : '') + '>' + escapeHtml(applyLabel) + '</button>'
    + '<button type="button" class="btn btn-ghost" data-mcpi-act="cancel"' + (busy === 'apply' ? ' disabled' : '') + '>Cancel</button>'
    + '</div></div>';
}

// ── results ────────────────────────────────────────────────────────────────

const RESULT_VERB = Object.freeze({
  install: { written: 'added to', created: 'created', unchanged: 'already up to date in' },
  update: { written: 'updated in', created: 'created', unchanged: 'already up to date in' },
  remove: { written: 'removed from', created: 'removed from', unchanged: 'was not in' },
  restore: { written: 'original put back in', created: 'original put back in', unchanged: 'already the original in' },
});

function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

/**
 * One line per result, ALWAYS visible: "Cursor — added to ~/.cursor/mcp.json ·
 * original kept · quit and reopen Cursor". `planItems` (id+file → plan item)
 * tell an add from an update; the action is the plan's.
 */
export function resultLine(r, action, planItems) {
  const label = escapeHtml(r.label || r.id || '');
  const file = '<span class="mono">' + escapeHtml(r.file || '') + '</span>';
  const outcome = ['written', 'created', 'unchanged', 'refused'].includes(r.outcome) ? r.outcome : 'refused';
  if (outcome === 'refused') {
    return '<div class="mcpi-result mcpi-result-refused" data-mcpi-result="refused"><strong>' + label + '</strong> — not changed'
      + (isStr(r.message) ? ': ' + escapeHtml(r.message) : (isStr(r.reason) ? ': ' + escapeHtml(r.reason) : ''))
      + ' <span class="mcpi-hint-inline">Nothing was written to ' + file + '.</span></div>';
  }
  const item = (Array.isArray(planItems) ? planItems : []).find((i) => i && i.id === r.id && (!r.file || i.file === r.file));
  const kind = action === 'install' && item && item.action === 'update' ? 'update' : action;
  const verbs = RESULT_VERB[kind] || RESULT_VERB.install;
  const bits = [escapeHtml(verbs[outcome]) + ' ' + file];
  if (outcome === 'created') bits[0] = escapeHtml(verbs.created) + ' ' + file + ' with the My Curator entry';
  if (isStr(r.backup)) bits.push('original kept');
  else if (outcome === 'created') bits.push('no original to keep');
  if (isStr(r.restart) && outcome !== 'unchanged') bits.push(escapeHtml(lowerFirst(r.restart)));
  return '<div class="mcpi-result mcpi-result-' + outcome + '" data-mcpi-result="' + outcome + '"><strong>' + label + '</strong> — '
    + bits.join(' · ') + '</div>';
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

/** The results block: every line, the restart line, and Check again. Never folded. */
export function renderResults(res, tools, platform) {
  if (!res || !Array.isArray(res.items)) return '';
  const lines = res.items.map((r) => resultLine(r, res.action || 'install', res.planItems)).join('');
  const rs = restartLine(res.items, tools, platform);
  const win = platform === 'win32' && res.items.some((r) => r && r.id === 'claude-desktop' && (r.outcome === 'written' || r.outcome === 'created'));
  return '<div class="mcpi-results" data-mcpi-results role="status">'
    + lines
    + (rs ? '<p class="mcpi-line mcpi-restart" data-mcpi-restart>' + escapeHtml(rs) + '</p>' : '')
    + (win ? '<p class="mcpi-line mcpi-restart" data-mcpi-restart-windows>' + escapeHtml(WINDOWS_RESTART_LINE) + '</p>' : '')
    + '<div class="mcpi-result-acts">' + (win ? btnP : btnS)('check-again', 'Check again') + btnG('dismiss', 'Dismiss') + '</div>'
    + '</div>';
}

// ── the panel ──────────────────────────────────────────────────────────────

/**
 * The whole "My Curator in your tools" panel for block 5.
 * `st` = `{status:{data,error,loading}, ticks, plan, results, busy, error, copied, folds, paths}`.
 */
export function renderInstallPanel(st) {
  const s = st || {};
  const status = s.status || null;
  const data = status && status.data;
  if (!data) {
    if (status && status.error) {
      return '<p class="settings-inline-error" role="alert">Could not check your tools: ' + escapeHtml(status.error) + '</p>';
    }
    return '<p class="cur-setup-hint" aria-busy="true">Checking your tools…</p>';
  }
  const tools = Array.isArray(data.tools) ? data.tools : [];
  const err = isStr(s.error) ? '<p class="settings-inline-error" role="alert" data-mcpi-error>' + escapeHtml(s.error) + '</p>' : '';
  const stale = status.error ? '<p class="settings-inline-error" role="alert">Could not re-check: ' + escapeHtml(status.error) + '</p>' : '';
  return '<div class="mcpi-panel" id="mcpi-panel" data-mcpi-panel>'
    + renderInstallOverview(status, s.ticks, s.busy)
    + err + stale
    + (s.plan ? renderPlanCard(s.plan, tools, s.busy) : '')
    + renderResults(s.results, tools, data.platform)
    + (isStr(s.copied) ? '<p class="mcpi-line" role="status">' + escapeHtml(s.copied) + '</p>' : '')
    + renderToolRows(status, { ticks: s.ticks, folds: s.folds, paths: s.paths, machineFiles: s.machineFiles })
    + '</div>';
}

// ── the door from elsewhere ────────────────────────────────────────────────

/**
 * Scroll to the "My Curator in your tools" panel and mark one tool's row
 * (default Claude Desktop) — the single target Settings block 1 and the MCP
 * wizard point at, so there is ONE installer. Writes and requests nothing.
 * Falls back to the panel, then to block 5, while the status is still loading.
 * Returns the element it scrolled to, or null.
 */
export function focusInstallPanel(toolId = 'claude-desktop', doc = globalThis.document) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  const safe = String(toolId).replace(/[^A-Za-z0-9_-]/g, '');
  const row = doc.querySelector('[data-mcpi-tool="' + safe + '"]');
  const target = row || doc.getElementById('mcpi-panel') || doc.querySelector('.settings-block-mcp-tools');
  if (!target) return null;
  if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (row && row.classList) {
    row.classList.add('mcpi-flash');
    if (typeof setTimeout === 'function') setTimeout(() => row.classList.remove('mcpi-flash'), 2400);
    const f = row.querySelector('input, button');
    if (f && typeof f.focus === 'function') { try { f.focus({ preventScroll: true }); } catch { /* not focusable */ } }
  }
  return target;
}

// ── requests (the only network code; every one is called from a click) ─────

async function readJson(res) {
  const ct = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '').toLowerCase();
  if (ct.includes('text/html')) return { ok: false, code: 'stale', message: 'This version of The Curator can’t install into tools yet — update the app.' };
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
