// Context › project › step 5 "Setup" (v3.77.0; rebuilt v3.78.0) — the words
// and the markup.
//
// DOM-FREE AT IMPORT, the ws-delete.js / chat-list.js rule: an offline suite
// imports the REAL builders in plain Node (scripts/test-next-setup-step.js)
// instead of lifting them out of memory.js by brace-matching. memory.js owns
// the state, the requests and the listeners; this module owns what the step
// SAYS. It imports nothing that touches a DOM — the "+ Add an agent app" listbox is
// rendered by memory.js from `setupToolPickerCfg` and handed in as a string.
//
// ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
// A project worked on by several agent tools, on several computers, works
// only while a list of preconditions holds (the user guide's §13d checklist).
// This step shows which of them is false RIGHT NOW, on this computer, and the
// one safe action for each: copy, reveal, use a folder, or Sync now.
//
// ── THE v3.78.0 SHAPE (the maintainer's approved design, 2026-09-28) ───────
// · NO SUMMARY CARD. Nothing shows when nothing is wrong. Every to-fix item is
//   ONE loud note line — step ④'s `.tx-note.mem-ss-note` — with its own fix
//   button(s) beside it, above every fold (a warning never sits behind a
//   chevron, v3.16.1). A repository that is not set is one quiet note naming
//   what did not get checked, with "Use <folder>" when exactly one was found.
// · "+ Add an agent app" is the SHARED listbox (step ③'s "+ Add a domain"), groups
//   "Known agent apps" / "Other", its last row "Custom agent app…".
// · Three folds, each the Handoffs table's parts (`.mem-ws-table`,
//   `.mem-ws-row`, `.mem-ws-mine`, `.mem-ws-count`): Tools, Repository on
//   this computer, Computers. A tool row opens the tool's full evidence in the
//   right-hand READER (the standing rule: detail pages open in the reader).
// · Computers are PHYSICAL: installs on one Mac are one row (the payload's
//   `physical[]`), their install names on a secondary line.
//
// ── THE SIX DESIGN RULES, HERE ─────────────────────────────────────────────
//  1 one overview card — the SETUP tile is a card of the project's overview
//    (memory.js renderLayerStrip, whose inlined words equal `setupTile`).
//  2 one heading rule — `memStep({num: 5, title: 'Setup'})` in memory.js.
//  3 the step-body rule — notes, then fold rows; the explanation is the ⓘ
//    (`context.setup`). Every to-fix line is outside every fold.
//  4 the monitor — none: the step has no live-state summary any more; each
//    to-fix line is a note with its action, which is what the monitor's loud
//    entry was standing in for.
//  5 continuity by identity — a TOOL and a COMPUTER carry no identity colour.
//    The dot on a row is the freshness dot (the TIME channel), never a domain's.
//  6 the depth bar — none: nothing here is a share.
//
// ── DEGRADES ON A v3.77.0 SERVER ───────────────────────────────────────────
// Every v3.78.0 field is optional here: no `physical` → computers are grouped
// from `computers[].thisMachine`; no `status`/`parts`/`evidence` on a tool →
// they are derived from the v3.77.0 cells; no `repoCandidates` → the reachable
// `repoSuggestions`; no `group` on `addable` → one "Known agent apps" group and no
// "Custom agent app…" row (the old server would refuse the custom PUT).

import { ageWordsFor } from '../shared/age-ticker.js';
import { freshnessTier } from '../shared/age.js';
// v3.80.0: the "+ Add an agent app" rows are the composer's model rows' anatomy
// (import-free, DOM-free — the suite still imports this module in Node).
import { listRowBodyHtml } from '../shared/model-row.js';
import { machineWord as thisMachine, browserPlatform } from '../shared/platform.js';
import { shortMachineNames } from '../shared/machine-name.js';
// v3.99.2 plain-language errors.
import { userMessageFrom, renderErrorDetail, errorDetailHtml } from '../shared/net.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// app.js's `icon()` bodies, byte-for-byte, so a note here draws the same
// glyph step ④'s notes do without importing the shell.
const SVG = (body, px) => '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" '
  + 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
const ICON_TRI = SVG('<path d="M12 9v3.6M12 16.6h.01"/><path d="M10.4 3.6 2.2 18a1.8 1.8 0 0 0 1.55 2.7h16.5A1.8 1.8 0 0 0 21.8 18L13.6 3.6a1.8 1.8 0 0 0-3.2 0z"/>', 13);
const ICON_CIRC = SVG('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>', 13);
const ICON_TRASH = SVG('<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.7 12.4a1.5 1.5 0 0 0 1.5 1.4h6.6a1.5 1.5 0 0 0 1.5-1.4l.7-12.4"/>', 13);
const ICON_CHEV ='<svg class="icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const SETUP_JUMP = 'context-setup';

/** Re-fetch on focus / visibility only when the reading is older than this (contract §7). */
export const SETUP_RECHECK_AFTER_MS = 10000;

/** The custom-tool name rule, the route's own (contract §5). */
export const CUSTOM_TOOL_RE = /^[A-Za-z0-9 ._-]{1,40}$/;

/** The listbox value of the "Custom agent app…" row. */
export const CUSTOM_TOOL_VALUE = '__custom';

/** A ticking age, with its words already written (age-ticker keeps them current). */
export function ageSpan(iso, prefix, cls = '') {
  const words = ageWordsFor(iso, Date.now(), prefix || null) || (prefix || '');
  return '<span' + (cls ? ' class="' + cls + '"' : '') + ' data-age-at="' + escapeHtml(iso) + '"'
    + (prefix ? ' data-age-prefix="' + escapeHtml(prefix) + '"' : '') + ' data-age-text>' + escapeHtml(words) + '</span>';
}

/** State word → the class that inks it (shared/setup-check.css owns the classes). */
export function stateClass(st) {
  return {
    ok: 'cur-setup-st-ok',
    fix: 'cur-setup-st-fix',
    'cant-check': 'cur-setup-st-q',
    'not-checked': 'cur-setup-st-q',
    unmeasured: 'cur-setup-st-q',
    none: 'cur-setup-st-none',
  }[st] || 'cur-setup-st-none';
}

const st = (state, word) => '<span class="cur-setup-st ' + stateClass(state) + '">' + escapeHtml(word) + '</span>';
const isStr = (x) => typeof x === 'string' && x.length > 0;
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

/** True when the last reading is old enough that a focus should re-read. Pure. */
export function setupCheckIsStale(data, now = Date.now(), afterMs = SETUP_RECHECK_AFTER_MS) {
  const at = data && Date.parse(data.checkedAt);
  if (!Number.isFinite(at)) return true;
  return now - at > afterMs;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPUTERS — one row per PHYSICAL computer
// ═══════════════════════════════════════════════════════════════════════════

function installOf(r) {
  const names = Array.isArray(r.names) ? r.names.filter(isStr) : [];
  const primary = isStr(r.primary) ? r.primary : (isStr(r.machine) ? r.machine : (names[0] || '—'));
  const aliases = Array.isArray(r.aliases) ? r.aliases.filter(isStr)
    : names.filter((n) => n !== primary);
  return {
    primary,
    aliases,
    kind: r.installKind === 'app' || r.installKind === 'source' ? r.installKind : null,
    thisComputer: r.thisComputer === true || r.thisMachine === true,
    tools: Array.isArray(r.tools) ? r.tools.filter(isStr) : [],
    at: isStr(r.newestSaveAt) ? r.newestSaveAt : (isStr(r.newestAt) ? r.newestAt : null),
    curator: isStr(r.curatorVersion) ? r.curatorVersion : (isStr(r.curator) ? r.curator : null),
    waiting: Number.isInteger(r.waiting) ? r.waiting : 0,
    // v3.79.0 (contract §C): each tool's saves from this install, for the
    // Computers reader. Absent on a v3.78.0 server — the reader falls back to
    // `tools` and the newest save.
    saves: Array.isArray(r.saves) ? r.saves.filter((x) => x && isStr(x.at) && (isStr(x.tool) || isStr(x.label))) : [],
  };
}

function groupOf(installs, thisComputer) {
  const sorted = [...installs].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const newest = sorted[0] || null;
  const tools = [...new Set(sorted.flatMap((i) => i.tools))].sort();
  return {
    thisComputer,
    name: newest ? newest.primary : '—',
    installs: sorted,
    tools,
    at: newest && newest.at ? newest.at : null,
    curator: (sorted.find((i) => i.at === (newest && newest.at) && i.curator) || sorted.find((i) => i.curator) || {}).curator || null,
    waiting: sorted.reduce((n, i) => n + i.waiting, 0),
  };
}

/**
 * One entry per PHYSICAL computer. v3.78.0 sends `physical[]`; a v3.77.0
 * server sends only `computers[]`, one per machine NAME, with `thisMachine`
 * set for every name this computer saves under — so every name of THIS
 * computer is one group and every other name is its own. Pure.
 */
export function physicalOf(data) {
  if (!data) return [];
  let out;
  if (Array.isArray(data.physical) && data.physical.length) {
    out = data.physical
      .filter((g) => g && Array.isArray(g.installs))
      .map((g) => groupOf(g.installs.filter(Boolean).map(installOf), g.thisComputer === true))
      .sort((a, b) => (b.thisComputer - a.thisComputer) || ((Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)));
  } else {
    const rows = (Array.isArray(data.computers) ? data.computers : []).filter(Boolean).map(installOf);
    const here = rows.filter((r) => r.thisComputer);
    out = here.length ? [groupOf(here, true)] : [];
    for (const r of rows.filter((x) => !x.thisComputer)) out.push(groupOf([r], false));
  }
  // v4.2.0 fix (e2e A, confusion 7): a computer is NAMED, never shown by
  // its raw folder id — `name` is the display name (the menu-bar widget's
  // host part), `id` the folder name it came from.
  const names = machineNamesOf(data);
  for (const g of out) {
    g.id = g.name;
    g.name = names.get(g.name) || g.name;
    for (const i of g.installs) i.display = names.get(i.primary) || i.primary;
  }
  return out;
}

/**
 * Every machine this payload names (each install's names, each harness's
 * last save), as one Map raw id → display name — computed over them all so
 * two computers sharing a host part get a short tag apart. Pure.
 */
export function machineNamesOf(data) {
  const all = [];
  for (const g of (data && Array.isArray(data.physical) ? data.physical : [])) {
    for (const i of (g && Array.isArray(g.installs) ? g.installs : [])) {
      if (i && Array.isArray(i.names)) all.push(...i.names.filter(isStr));
      if (i && isStr(i.primary)) all.push(i.primary);
    }
  }
  for (const c of (data && Array.isArray(data.computers) ? data.computers : [])) {
    if (c && Array.isArray(c.names)) all.push(...c.names.filter(isStr));
    if (c && isStr(c.primary)) all.push(c.primary);
    if (c && isStr(c.machine)) all.push(c.machine);
  }
  for (const t of (data && Array.isArray(data.tools) ? data.tools : [])) if (t && t.saved && isStr(t.saved.machine)) all.push(t.saved.machine);
  return shortMachineNames(all);
}

/** One machine's display name in this payload (raw id in, name out). Pure. */
function machineName(id, data) {
  if (!isStr(id)) return id;
  return machineNamesOf(data).get(id) || id;
}

/** How many physical computers, and how many installs among them. Pure. */
export function computerCounts(data) {
  const groups = physicalOf(data);
  const installs = groups.reduce((n, g) => n + g.installs.length, 0);
  return { computers: groups.length, installs };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE OVERVIEW TILE
// ═══════════════════════════════════════════════════════════════════════════

/** The overview tile's facts, from the route payload (or null). Pure. */
export function setupTile(data) {
  if (!data || !data.ok) return { value: 'not checked', sub: null, warn: false };
  const n = Array.isArray(data.toFix) ? data.toFix.length : 0;
  const tools = (data.tools || []).map((t) => t && t.label).filter(isStr);
  const comps = computerCounts(data).computers;
  // THE REPOSITORY CHECKS RAN only when a folder is set AND is on this
  // computer. Without them "ready" would be a claim about checks that never
  // ran (v3.77.0 screen review).
  const repoChecked = !!(data.repo && data.repo.exists !== false);
  const sub = [
    tools.length ? tools.join(' · ') : 'no agent harness yet',
    comps ? plural(comps, 'computer') : null,
  ].filter(Boolean).join(' · ');
  if (n) return { value: n + ' to fix', sub, warn: true };
  if (!repoChecked) return { value: 'repository not set', sub, warn: false };
  return { value: 'ready', sub, warn: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════════════════════════════════

const Q_STATES = ['cant-check', 'not-checked', 'unmeasured'];

/** The four parts on this computer: MCP · skills · block · hooks. Pure. */
export function toolParts(t) {
  const p = t && t.parts && typeof t.parts === 'object' ? t.parts : null;
  const one = (cell, dflt) => (cell && typeof cell === 'object'
    ? { state: isStr(cell.state) ? cell.state : 'none', word: isStr(cell.word) ? cell.word : dflt }
    : { state: 'none', word: dflt });
  return {
    mcp: one(p ? p.mcp : t && t.bridge, 'not read'),
    skills: one(p ? p.skills : t && t.skills, 'not read'),
    block: one(p ? p.block : t && t.block, 'not read'),
    hooks: one(p ? p.hooks : t && t.hooks, 'not wired'),
  };
}

/** How many to-fix lines name this tool. */
function fixCountFor(t, data) {
  return (Array.isArray(data && data.toFix) ? data.toFix : []).filter((f) => f && f.tool === t.id).length;
}

/**
 * The STATUS column: ready / N to fix / partly checked / no save from here.
 * The server's `status` when it sends one; derived from the v3.77.0 cells
 * otherwise. Pure.
 */
export function toolStatus(t, data) {
  const n = fixCountFor(t, data);
  let s = ['ready', 'to-fix', 'partly', 'no-save'].includes(t && t.status) ? t.status : null;
  if (!s) {
    const parts = toolParts(t);
    if (n || Object.values(parts).some((x) => x.state === 'fix')) s = 'to-fix';
    else if (!(t.saved && t.saved.at && t.saved.thisMachine)) s = 'no-save';
    else if ([parts.mcp, parts.skills, parts.block].some((x) => Q_STATES.includes(x.state))) s = 'partly';
    else s = 'ready';
  }
  if (s === 'to-fix') return { status: s, word: n ? n + ' to fix' : 'to fix', state: 'fix' };
  if (s === 'partly') return { status: s, word: 'partly checked', state: 'not-checked' };
  if (s === 'no-save') return { status: s, word: 'no save from here', state: 'none' };
  return { status: s, word: 'ready', state: 'ok' };
}

/** One part mark: the part's name, the state as the dot; the word only when it is a to-fix. */
function partMark(name, cell) {
  const fix = cell.state === 'fix';
  return '<span class="cur-setup-st ' + stateClass(cell.state) + '">' + escapeHtml(name)
    + (fix ? ': ' + escapeHtml(cell.word) : '<span class="visually-hidden"> ' + escapeHtml(cell.word) + '</span>')
    + '</span>';
}

function freshDot(iso) {
  const at = Date.parse(iso);
  const tier = Number.isFinite(at) ? freshnessTier(Math.max(0, (Date.now() - at) / 1000)) : 'unknown';
  return '<span class="fresh-dot fresh-' + tier + '" aria-hidden="true"></span>';
}

function toolRow(t, data) {
  const s = toolStatus(t, data);
  const parts = toolParts(t);
  const saved = t.saved && t.saved.at ? t.saved : null;
  // v4.2 (audit bug 3): the WHOLE row opens the harness — memory.js binds
  // `data-setup-row` to press the row's own button, as the Handoffs rows do.
  return '<tr class="mem-ws-row mem-setup-row" data-setup-row="mem-setup-tool-' + escapeHtml(t.id) + '">'
    + '<td class="mem-ws-cell-name"><button type="button" class="mem-ws-open" id="mem-setup-tool-' + escapeHtml(t.id) + '"'
      + ' data-setup-act="tool-open" data-tool="' + escapeHtml(t.id) + '"'
      + ' aria-label="' + escapeHtml('Open the setup steps for ' + t.label) + '">'
      // v4.2 integration: no leading dot. A harness row's ONE dot is its
      // status mark (`st`, design rule 7's tone mark), so a row can never show
      // a "just saved" green beside "Not on this computer"; when it last saved
      // is said in words (the age column, the row's second line).
      + '<span class="mem-ws-slug">' + escapeHtml(t.label) + '</span>'
    + '</button></td>'
    // v4.2 (audit bug 4): a harness that still needs something says where
    // its steps are, on the row, so they can be found again after the reader closes.
    + '<td class="mem-setup-cell-status">' + st(s.state, s.word)
      + (s.status === 'ready' ? '' : '<span class="mem-setup-row-door">'
        + btnG('tool-open', 'Open setup steps', ' data-tool="' + escapeHtml(t.id) + '"') + '</span>') + '</td>'
    + '<td class="mem-ws-cell-age">' + (saved ? ageSpan(saved.at, null) : '—') + '</td>'
    + '<td class="mem-ws-cell-machine">' + (saved && isStr(saved.machine)
      ? '<span class="mem-ws-machine">' + escapeHtml(machineName(saved.machine, data)) + '</span>'
        + (saved.thisMachine ? '<span class="mem-ws-mine">this computer</span>' : '')
      : '—') + '</td>'
    + '<td class="mem-setup-cell-parts"><span class="mem-setup-parts">'
      + partMark('MCP', parts.mcp) + partMark('skills', parts.skills)
      + partMark('block', parts.block) + partMark('hooks', parts.hooks)
    + '</span></td>'
    // v3.80.0 — THE HANDOFFS ROW'S TRASH (shared/row-action.css: a neutral
    // ghost icon, visible at rest, never red), only on a row Remove would
    // actually take away. No confirm: it stops a CHECK on this computer and
    // deletes nothing — the menu adds it back.
    + '<td class="mem-ws-cell-act">' + (removableOf(t).ok
      ? '<button type="button" class="row-act mem-setup-del" id="mem-setup-del-' + escapeHtml(t.id) + '"'
        + ' data-setup-act="remove-tool" data-tool="' + escapeHtml(t.id) + '"'
        + ' aria-label="' + escapeHtml('Remove ' + t.label + ' from this computer’s list') + '">' + ICON_TRASH + '</button>'
      : '') + '</td>'
    + '</tr>';
}

/**
 * CAN THIS ROW BE TAKEN OFF THIS COMPUTER'S LIST? (v3.80.0) The payload's
 * `removable` when sent: a tool that has SAVED this project stays (its saves
 * are the record) and one whose MCP settings here name The Curator stays (the
 * check found it; nobody added it). A v3.79.0 server sends no `removable`:
 * then only a custom tool the owner added, which that server could remove. Pure.
 */
export function removableOf(t) {
  if (!t) return { ok: false, why: null };
  if (t.removable && typeof t.removable === 'object') {
    return { ok: t.removable.ok === true, why: isStr(t.removable.why) ? t.removable.why : null };
  }
  if (t.custom === true && t.userAdded !== false && !(t.saved && t.saved.at)) return { ok: true, why: null };
  return { ok: false, why: t.saved && t.saved.at ? 'saved' : null };
}

/** The Tools fold's count line: how its parts travel, and what "ready" takes, in one sentence each. */
export const TOOLS_COUNT_LINE = 'A harness is ready once it is connected here, reads the agent instructions and has saved this project from this computer — press a row for its setup steps.';

function toolsTable(data) {
  const tools = (data.tools || []).filter((t) => t && isStr(t.id));
  if (!tools.length) {
    return '<p class="mem-setup-empty">No agent harness has saved to this project or is set up on this computer.</p>';
  }
  return '<div class="mem-ws-wrap mem-setup-wrap"><table class="mem-ws-table mem-setup-table">'
    + '<thead><tr><th scope="col">Harness</th><th scope="col">Status</th><th scope="col">Last saved</th>'
    + '<th scope="col">Saved from</th><th scope="col">On this computer</th>'
    + '<th scope="col" class="mem-ws-cell-act"><span class="visually-hidden">Actions</span></th></tr></thead>'
    + '<tbody>' + tools.map((t) => toolRow(t, data)).join('') + '</tbody></table></div>'
    + '<div class="mem-ws-count">' + escapeHtml(TRAVELS_LINES['setup-tools']) + ' ' + escapeHtml(TOOLS_COUNT_LINE) + '</div>';
}

function toolsMeta(data) {
  const tools = (data.tools || []).filter(Boolean);
  const fixN = tools.filter((t) => toolStatus(t, data).status === 'to-fix').length;
  return [plural(tools.length, 'agent harness', 'agent harnesses'), fixN ? fixN + ' to fix' : null].filter(Boolean).join(' · ');
}

// ═══════════════════════════════════════════════════════════════════════════
// THE "+ Add an agent app" PICKER — a cfg for the shared listbox
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHERE A TOOL'S MCP SETTINGS LIVE, SHORT (v3.80.0): the FOLDER, never the
 * file and never three of them — "~/.codex" for "~/.codex/config.toml". A file
 * straight under home stays the file ("~/.claude.json"); a long folder keeps
 * its first and last segment ("~/Library/…/Claude"). The full paths belong in
 * the tool's reader, where its setup guide names the exact file. Pure.
 */
export function shortConfigPlace(p) {
  if (!isStr(p)) return null;
  const segs = p.replace(/\/+$/, '').split('/');
  if (segs.length <= 2) return p;
  const dir = segs.slice(0, -1);
  const joined = dir.join('/');
  if (joined.length <= 24 || dir.length <= 2) return joined;
  return dir[0] + '/' + dir[1] + '/…/' + dir[dir.length - 1];
}

/** "AGENTS.md", "AGENTS.md and GEMINI.md", ".rules, AGENTS.md, CLAUDE.md". Pure. */
function fileList(names) {
  const n = (Array.isArray(names) ? names : []).filter(isStr);
  if (n.length <= 2) return n.join(' and ');
  return n.join(', ');
}

/**
 * One menu row's second line, as its facts: "reads AGENTS.md", "MCP config
 * in ~/.codex". A v3.79.0 server sends neither `reads` nor `configPaths`:
 * its `detail` is then the line, as it was. Pure.
 */
export function toolMenuMeta(a) {
  if (!a) return [];
  const hasFacts = Array.isArray(a.reads) || Array.isArray(a.configPaths);
  if (!hasFacts) return isStr(a.detail) ? [a.detail] : [];
  const reads = Array.isArray(a.reads) ? a.reads.filter(isStr) : [];
  const place = a.measured === false ? null : shortConfigPlace((a.configPaths || []).find(isStr));
  return [
    reads.length ? 'reads ' + fileList(reads) : 'reads no instruction file',
    place ? 'MCP config in ' + place : null,
  ].filter(Boolean);
}

/** The menu's foot, the model menu's `.mr-foot` line. */
export const TOOL_MENU_FOOT = 'Adds it to this list so Setup can guide you through it on this computer.';

/** The gloss "agent harness" carries the first time a screen says it (owner, 2026-11-26). */
export const HARNESS_GLOSS = 'the app your agent runs in — Claude Code, Codex, Cursor, Antigravity…';

/** "Claude Code and Antigravity are already on the list." — said in the menu foot, so a missing name is explained. Pure. */
export function alreadyListedLine(data) {
  const names = ((data && data.tools) || []).map((t) => t && t.label).filter(isStr);
  if (!names.length) return '';
  const list = names.length <= 2 ? names.join(' and ') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return list + (names.length === 1 ? ' is' : ' are') + ' already on the list.';
}

/**
 * ONE cfg, for both `renderListboxHtml` and `mountListbox` (memory.js calls
 * both with it). Groups "Known agent apps" / "Other"; "Custom agent app…" is an ACTION
 * row (it opens a name field and never becomes the control's value). A
 * v3.77.0 server sends no groups and no custom row: every option is a known
 * tool and there is no custom row to offer.
 *
 * v3.80.0 — THE COMPOSER'S MODEL MENU'S ROWS AND SURFACE. Same listbox, same
 * row body (`listRowBodyHtml`, shared/model-row.js: the name, a short fact at
 * the right, a muted second line), same menu class (`lb-rich mr-menu`: 360–
 * 420 px, never full-bleed) and the same `.mr-foot` foot line. The old plain
 * rows were the listbox's label + a mono `detail` pinned right with no width
 * cap, so the menu ran the width of the window. Pure.
 */
export function setupToolPickerCfg(data, busy = false) {
  const addable = Array.isArray(data && data.addable) ? data.addable.filter((a) => a && isStr(a.id)) : [];
  const known = addable.filter((a) => a.id !== CUSTOM_TOOL_VALUE && a.group !== 'other');
  const other = addable.filter((a) => a.id !== CUSTOM_TOOL_VALUE && a.group === 'other');
  const custom = addable.find((a) => a.id === CUSTOM_TOOL_VALUE) || null;
  const opt = (a, group) => {
    const label = isStr(a.label) ? a.label : a.id;
    const meta = toolMenuMeta(a);
    const fact = a.measured === false ? 'not measured' : '';
    return {
      value: a.id,
      label,
      group,
      detail: [...meta, fact].filter(Boolean).join(' · '),
      html: listRowBodyHtml({ title: label, fact, meta }),
    };
  };
  const options = [...known.map((a) => opt(a, 'Known harnesses')), ...other.map((a) => opt(a, 'Other'))];
  if (custom) {
    // v4.2 vocabulary: the row says what it adds, whatever an older server calls it.
    const label = 'Another harness…';
    const meta = ['any other harness that speaks MCP', 'you name it'];
    options.push({ value: CUSTOM_TOOL_VALUE, label, group: 'Other', action: true,
      detail: meta.join(' · '), html: listRowBodyHtml({ title: label, meta }) });
  }
  return {
    id: 'mem-setup-add',
    value: null,
    placeholder: '+ Add an agent harness',
    triggerText: busy ? 'Adding…' : '+ Add an agent harness',
    ariaLabel: 'Add an agent harness to check on this computer',
    disabled: busy === true || options.length === 0,
    triggerClass: 'btn btn-secondary btn-xs',
    menuClass: 'lb-rich mr-menu',
    minWidth: 360,
    footHtml: '<p class="mr-foot">' + escapeHtml([TOOL_MENU_FOOT, alreadyListedLine(data)].filter(Boolean).join(' ')) + '</p>',
    actionValues: custom ? [CUSTOM_TOOL_VALUE] : [],
    options,
  };
}

/** The custom name's refusal, or null. The route's rule, said first here. Pure. */
export function customToolNameError(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'Type the harness’s name.';
  if (n.length > 40) return 'A harness name is at most 40 characters.';
  if (!CUSTOM_TOOL_RE.test(n)) return 'Use letters, digits, spaces, dots, dashes and underscores only.';
  return null;
}

// Exported (phase 2): the Projects page's Agents tab draws the custom-harness field.
export function customField(ui) {
  if (!ui.customOpen) return '';
  return '<div class="mem-setup-path-row mem-setup-custom">'
    + '<label class="visually-hidden" for="mem-setup-custom-input">The harness’s name</label>'
    + '<input type="text" id="mem-setup-custom-input" class="mem-setup-input" spellcheck="false" autocomplete="off" maxlength="40"'
      + ' placeholder="The harness’s name, e.g. My Harness" value="' + escapeHtml(ui.customDraft || '') + '">'
    + '<button type="button" class="btn btn-secondary btn-xs" data-setup-act="add-custom">Add</button>'
    + '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="custom-cancel">Cancel</button>'
    + '</div>'
    + (ui.customError ? '<p class="mem-setup-err" role="alert">' + escapeHtml(ui.customError) + '</p>' + errorDetailHtml(ui.customError) : '');
}

// ═══════════════════════════════════════════════════════════════════════════
// THE TO-FIX NOTES — one loud line each, with its own fix
// ═══════════════════════════════════════════════════════════════════════════

// v4.1.2 (audit W9): Reveal is `open -R`, macOS only (the v3.86.0 rule, and
// Settings › MCP bridge already hides it). Off macOS a Reveal is never drawn,
// so no dead button; an unknown platform keeps it (the route still answers).
export function revealAvailable() { const p = browserPlatform(); return !p || p === 'darwin'; }
const btn2 = (act, label, extra = '') => (act === 'reveal' && !revealAvailable() ? '' : '<button type="button" class="btn btn-secondary btn-xs" data-setup-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>');
const btnG = (act, label, extra = '') => (act === 'reveal' && !revealAvailable() ? '' : '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>');
const ZIPS = '<a class="btn btn-ghost btn-xs" href="/api/setup/skills/my-curator.zip" download>my-curator.zip</a>'
  + '<a class="btn btn-ghost btn-xs" href="/api/setup/skills/curator-continuity.zip" download>curator-continuity.zip</a>';
// The tools whose config file The Curator can write (v3.85.0, macOS) — the link
// is a door to the installer, which says whether this computer can use it.
const INSTALL_TOOLS = ['claude-desktop', 'cursor', 'antigravity'];
const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop();
// Only this app's own skill downloads are ever linked (a payload href is data).
const SKILL_HREF_RE = /^\/api\/setup\/skills\/[a-z0-9-]+\.zip$/;
const SKILL_NAME_RE = /^[a-z0-9-]{1,60}$/;

/**
 * v3.79.0 (contract §A, amendment 1): a to-fix item carries `fixes[]`, its
 * buttons in order, each with its own LABEL — the label says what the press
 * does ("Copy the git command that commits and pushes it", never "Copy
 * command"). A v3.78.0 server sends one `fix`; it is read as a one-entry list
 * and given the label its kind implies. Pure.
 */
export function fixListOf(f) {
  if (f && Array.isArray(f.fixes)) return f.fixes.filter((x) => x && isStr(x.kind));
  return f && f.fix && isStr(f.fix.kind) ? [f.fix] : [];
}

/** One button for one fix entry, or '' when the entry cannot be acted on here. */
function fixButton(fx, f, repo, primary) {
  const b = primary ? btn2 : btnG;
  // A label from an older server that still names v3.87's "Tools on this Mac" block reads as the door that exists now.
  const label = (dflt) => (isStr(fx.label) && !/^Open Tools on this /.test(fx.label) ? fx.label : dflt);
  switch (fx.kind) {
    case 'copy-block':
      // One name for one thing (v4.2): the header's "Copy agent instructions".
      return b('copy-block', fx.label === 'Copy instructions' ? 'Copy agent instructions' : label('Copy agent instructions'));
    case 'copy-marker':
      return b('copy-marker', label('Copy marker line'));
    case 'copy-command': {
      if (!isStr(fx.command)) return '';
      const where = isStr(fx.cwdDisplay) ? fx.cwdDisplay
        : (repo && isStr(repo.display) ? repo.display : (repo && isStr(repo.path) ? repo.path : ''));
      return b('copy-command', label('Copy the git command'), ' data-cmd="' + escapeHtml(fx.command) + '"'
        + (where ? ' data-cwd="' + escapeHtml(where) + '"' : ''));
    }
    case 'copy-snippet': {
      const tool = isStr(fx.tool) ? fx.tool : f.tool;
      return isStr(tool) ? b('copy-snippet', label('Copy MCP entry'), ' data-tool="' + escapeHtml(tool) + '"') : '';
    }
    case 'download-skill': {
      const href = isStr(fx.href) && SKILL_HREF_RE.test(fx.href) ? fx.href
        : (isStr(fx.skill) && SKILL_NAME_RE.test(fx.skill) ? '/api/setup/skills/' + fx.skill + '.zip' : null);
      if (!href) return '';
      // v4.2 (audit bug 5): the button names the OUTCOME, not the file.
      const skillName = baseName(href).replace(/\.zip$/, '');
      const word = !isStr(fx.label) || /^Download .*\.zip$/.test(fx.label) ? 'Get the new ' + skillName + ' skill (.zip)' : fx.label;
      return '<a class="btn ' + (primary ? 'btn-secondary' : 'btn-ghost') + ' btn-xs" href="' + escapeHtml(href) + '" download>'
        + escapeHtml(word) + '</a>';
    }
    case 'sync':
      return b('sync', label('Sync now'));
    case 'change-repo':
      return b('change-repo', label('Change folder'));
    case 'choose-folder':
      return b('choose-repo', label('Choose the folder'));
    case 'settings':
      return b('settings', label('Open Settings › MCP bridge'));
    case 'recheck':
      // One verb (phase 2): an older server's "Re-check" label reads Check again.
      return b('check', fx.label === 'Re-check' ? 'Check again' : label('Check again'));
    case 'skills':
      // v3.78.0's one "skills" fix: the settings door and both downloads.
      return b('settings', label('Open Settings › MCP bridge')) + ZIPS;
    case 'reveal': {
      if (isStr(fx.path)) return b('reveal', label('Reveal ' + baseName(fx.path)), ' data-path="' + escapeHtml(fx.path) + '"');
      const name = isStr(fx.reveal) ? fx.reveal : f.file;
      if (isStr(name) && repo && isStr(repo.path)) {
        return b('reveal', label('Reveal ' + name), ' data-path="' + escapeHtml(repo.path.replace(/\/+$/, '') + '/' + name) + '"');
      }
      return '';
    }
    default:
      return '';
  }
}

/** The buttons one to-fix item carries, in the payload's order. Pure. */
export function fixButtons(f, repo) {
  const out = [];
  fixListOf(f).forEach((fx, i) => {
    const html = fixButton(fx, f || {}, repo, i === 0);
    if (html) out.push(html);
  });
  // A v3.78.0 `fix` (no `fixes[]`) could name a file to reveal beside its
  // copy, and a tool's file reveal came with the settings door: kept, so an
  // older server's items still carry every action they did.
  if (f && !Array.isArray(f.fixes) && f.fix) {
    const fix = f.fix;
    if (fix.kind !== 'reveal' && isStr(fix.reveal) && repo && isStr(repo.path)) {
      out.push(btnG('reveal', 'Reveal ' + fix.reveal, ' data-path="' + escapeHtml(repo.path.replace(/\/+$/, '') + '/' + fix.reveal) + '"'));
    }
    if (fix.kind === 'reveal' && isStr(f.tool) && isStr(fix.path)) out.push(btnG('settings', 'Open Settings › MCP bridge'));
  }
  // v3.85.0: a bridge line for a tool The Curator can write for opens the one
  // installer (Settings › MCP bridge › Tools on this Mac) — no second writer
  // here. Said only where the line already offers the entry to copy.
  if (f && INSTALL_TOOLS.includes(f.tool) && fixListOf(f).some((x) => x.kind === 'copy-snippet')) {
    out.push(btnG('settings', 'Install for me'));
  }
  return out.join('');
}

/** Escaped text, with every `~/…` path set in mono. */
function withPaths(text) {
  return escapeHtml(text).replace(/(~\/[^\s]*[^\s.,;:!?)”])/g, '<span class="mem-setup-inline-path">$1</span>');
}

/**
 * ONE NOTE, TWO LINES (v3.79.0, contract §A): line 1 is what is wrong,
 * naming the file, the computer or the date; line 2 is why it matters and
 * what to do. Never glued into one run-on sentence. `line2Html` may be ''.
 */
function noteHtml(iconSvg, line1Html, line2Html, buttonsHtml, cls = '', attrs = '') {
  return '<div class="tx-note mem-ss-note mem-setup-note' + (cls ? ' ' + cls : '') + '"' + attrs + '>' + iconSvg
    + '<span class="mem-setup-note-text"><span class="mem-setup-note-l1">' + line1Html + '</span>'
    + (line2Html ? '<span class="mem-setup-note-l2">' + line2Html + '</span>' : '') + '</span>'
    + (buttonsHtml ? '<span class="mem-k-doors mem-setup-note-acts">' + buttonsHtml + '</span>' : '')
    + '</div>';
}

/**
 * WHAT A SKILL IS (v4.2, audit bug 5): the outdated-skill fix said "download
 * the .zip" without saying what a skill is or why an old one matters. Said
 * wherever a skill is asked for: the to-fix line and step 2 of the guide.
 */
export const SKILL_GLOSS = 'Skills are short instruction packs a harness loads when a task calls for them: '
  + 'my-curator teaches it how to read and write your wiki, curator-continuity when to save a handoff. '
  + 'A skill never updates itself, so an old copy can miss a rule added since.';

/** A to-fix item's line 2, with the skill gloss in front of a skills item's own words. Pure. */
function fixDetailHtml(f) {
  const own = isStr(f.detail) ? withPaths(f.detail) : '';
  if (f.kind !== 'skills') return own;
  return escapeHtml(SKILL_GLOSS) + (own ? ' ' + own : '');
}

/** The to-fix item's harness, when it names one that is on the list. */
function harnessOfItem(f, data) {
  return f && isStr(f.tool) ? ((data && data.tools) || []).find((t) => t && t.id === f.tool) || null : null;
}

/**
 * One to-fix item as a note. Pure. `withSteps`: a note about one harness, on
 * the PAGE, carries a door to that harness's setup steps (v4.2, audit bug 4:
 * the reader shows the same fix in context, and nothing led back to it).
 */
function fixNote(f, data, attrs = '', withSteps = false) {
  const t = withSteps ? harnessOfItem(f, data) : null;
  const key = t ? stepKeyOfItem(f) : null;
  const steps = t ? btnG('tool-open', 'Show its setup steps', ' data-tool="' + escapeHtml(t.id) + '"'
    + (key ? ' data-step="' + key + '"' : '')) : '';
  return noteHtml(ICON_TRI, withPaths(String(f.text || '')), fixDetailHtml(f),
    fixButtons(f, data && data.repo) + steps, 'mem-setup-fix-note', attrs);
}

/** Every to-fix item as one loud note with its own fix (Pro, and the page's project-wide lines). Pure. */
export function toFixNotes(data, only = null) {
  const toFix = Array.isArray(data && data.toFix) ? data.toFix.filter(Boolean) : [];
  return toFix.map((f, i) => (only && !only(f) ? '' : fixNote(f, data, ' data-setup-fix="' + i + '"', true))).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// HOW EACH PART REACHES ANOTHER COMPUTER (v3.79.0, contract §B)
// ═══════════════════════════════════════════════════════════════════════════
// Two sync channels, and one that is not a channel at all. GREYSCALE: the
// pill is `.mem-ws-mine`'s shape with a glyph (app.js's refresh, folder and
// cpu bodies), never a colour — colour is a domain's (design rule 5).

const GLYPH = {
  'personal-sync': '<path d="M20 11a8 8 0 0 0-14.5-4.5M4 4.5V9h4.5"/><path d="M4 13a8 8 0 0 0 14.5 4.5M20 19.5V15h-4.5"/>',
  'project-git': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'this-computer': '<rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/><rect x="10" y="10" width="4" height="4" rx="0.8"/><path d="M9 3v2.3M15 3v2.3M9 18.7V21M15 18.7V21M3 9h2.3M3 15h2.3M18.7 9H21M18.7 15H21"/>',
};

/** The words for each `travels` value, as the screen prints them. */
export const TRAVELS_WORDS = Object.freeze({
  'personal-sync': 'Personal Sync',
  'project-git': 'project’s git',
  'this-computer': 'this computer only',
});

/** Each fold's channel, in the fold's own words. */
export const FOLD_TRAVELS = Object.freeze({
  'setup-tools': Object.freeze({ key: 'this-computer', word: 'set up on each computer' }),
  'setup-repo': Object.freeze({ key: 'project-git', word: 'project’s git' }),
  'setup-computers': Object.freeze({ key: 'personal-sync', word: 'Personal Sync' }),
});

/** The one count line each fold carries about how its contents travel. */
export const TRAVELS_LINES = Object.freeze({
  'setup-repo': 'These files reach your other computers only through this project’s git: commit and push here, pull there. Sync now does not carry them.',
  'setup-computers': 'Handoffs, the brief and Documents travel by Sync now — not by the project’s git.',
  'setup-tools': 'MCP settings, skills and hooks are set up on each computer; nothing syncs them.',
});

/** A neutral pill naming how something travels. `word` overrides the default. Pure. */
export function travelsPill(key, word) {
  const w = isStr(word) ? word : TRAVELS_WORDS[key];
  if (!w || !GLYPH[key]) return '';
  return '<span class="mem-ws-mine mem-setup-travels" data-travels="' + escapeHtml(key) + '">'
    + SVG(GLYPH[key], 11) + '<span>' + escapeHtml(w) + '</span></span>';
}

// ═══════════════════════════════════════════════════════════════════════════
// REPOSITORY
// ═══════════════════════════════════════════════════════════════════════════

const WHY_WORDS = {
  'claude-code': 'Claude Code has opened it',
  foundations: 'a document source of this project',
  'hook-log': 'a hook ran there for this project',
  'git-remote': 'its git remote matches this project’s documents',
};

/**
 * Folders found on this computer for this project. v3.78.0's
 * `repoCandidates`; a v3.77.0 server's reachable `repoSuggestions`. Pure.
 */
export function repoCandidatesOf(data) {
  if (!data) return [];
  if (Array.isArray(data.repoCandidates)) {
    return data.repoCandidates.filter((c) => c && isStr(c.path)).map((c) => ({
      path: c.path,
      display: isStr(c.display) ? c.display : c.path,
      why: isStr(c.whyText) ? c.whyText : (WHY_WORDS[c.why] || 'found on this computer'),
    }));
  }
  return (Array.isArray(data.repoSuggestions) ? data.repoSuggestions : [])
    .filter((s) => s && s.reachable && isStr(s.root))
    .map((s) => ({ path: s.root, display: isStr(s.rootDisplay) ? s.rootDisplay : s.root,
      why: s.inGit ? 'a document source of this project · a git checkout' : 'a document source of this project' }));
}

// The file each tool reads first, for the "were not checked" sentence. A tool
// the map does not know names its own (`instructionFile`, contract §5).
const FIRST_FILE = { 'claude-code': 'CLAUDE.md', antigravity: 'AGENTS.md', codex: 'AGENTS.md',
  opencode: 'AGENTS.md', cursor: 'AGENTS.md', dsh: 'AGENTS.md', 'gemini-cli': 'GEMINI.md' };

/** "CLAUDE.md, AGENTS.md and .curator-project" — what the repository checks would read. Pure. */
export function repoCheckedFiles(data) {
  const names = [];
  for (const t of (data && data.tools) || []) {
    const n = t && (isStr(t.instructionFile) ? t.instructionFile : FIRST_FILE[t.id]);
    if (isStr(n) && !names.includes(n)) names.push(n);
  }
  names.push('.curator-project');
  return names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/**
 * THE REPOSITORY IS NOT SET (v3.79.0, contract §A): a question, not a fault —
 * line 1 asks where the code is and says what setting it checks; line 2 says
 * what was found here, or that a project not on this Mac is cloned first.
 */
export function repoNotSetNote(data) {
  const cands = repoCandidatesOf(data);
  const who = isStr(data && data.project) ? data.project : 'this project';
  const l1 = escapeHtml('Where is ' + who + '’s code on this ' + thisMachine() + '? Set its folder so Setup can check ' + repoCheckedFiles(data) + '.');
  if (cands.length === 1) {
    return noteHtml(ICON_CIRC, l1, 'Found on this ' + thisMachine() + ': <span class="mem-setup-inline-path">' + escapeHtml(cands[0].display) + '</span>',
      btn2('use-repo', 'Use ' + cands[0].display, ' data-path="' + escapeHtml(cands[0].path) + '"')
        + btnG('choose-repo', 'Choose another folder'), 'mem-setup-repo-note');
  }
  if (cands.length > 1) {
    return noteHtml(ICON_CIRC, l1, escapeHtml(cands.length + ' folders on this ' + thisMachine() + ' look like it — choose one.'),
      btn2('choose-repo', 'Choose a folder'), 'mem-setup-repo-note');
  }
  return noteHtml(ICON_CIRC, l1, escapeHtml('Not on this ' + thisMachine() + ' yet? Clone it first.'), btn2('choose-repo', 'Set the folder'), 'mem-setup-repo-note');
}

function pathRow(data, ui, draft) {
  return '<div class="mem-setup-path-row">'
    + '<label class="visually-hidden" for="mem-setup-repo-input">Where ' + escapeHtml(data.project || 'this project') + ' is checked out on this computer</label>'
    + '<input type="text" id="mem-setup-repo-input" class="mem-setup-input" spellcheck="false" autocomplete="off"'
      + ' placeholder="Or type a folder: /Users/you/code/' + escapeHtml(data.project || 'project') + '" value="' + escapeHtml(draft || '') + '">'
    + btn2('save-repo', 'Use')
    + (ui.pickUnavailable ? '' : btnG('pick-repo', 'Choose…'))
    + (ui.editRepo && data.repo ? btnG('cancel-repo', 'Cancel') : '')
    + '</div>'
    + (ui.repoError ? '<p class="mem-setup-err" role="alert">' + escapeHtml(ui.repoError) + '</p>' + errorDetailHtml(ui.repoError) : '');
}

function repoNotSetBody(data, ui) {
  const cands = repoCandidatesOf(data);
  const table = cands.length
    ? '<div class="mem-ws-wrap mem-setup-wrap"><table class="mem-ws-table mem-setup-table"><thead><tr>'
      + '<th scope="col">Found on this computer</th><th scope="col">Why</th>'
      + '<th scope="col" class="mem-ws-cell-act"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>'
      + cands.map((c) => '<tr class="mem-ws-row">'
        + '<td class="mem-ws-cell-name"><span class="mem-setup-name">' + escapeHtml(c.display) + '</span></td>'
        + '<td class="mem-ws-cell-head"><span class="mem-ws-headline">' + escapeHtml(c.why) + '</span></td>'
        + '<td class="mem-ws-cell-act">' + btn2('use-repo', 'Use this folder', ' data-path="' + escapeHtml(c.path) + '"') + '</td>'
        + '</tr>').join('')
      + '</tbody></table></div>'
    : '';
  return table + pathRow(data, ui, ui.repoDraft)
    + '<div class="mem-ws-count">' + escapeHtml(TRAVELS_LINES['setup-repo']) + '</div>'
    + '<div class="mem-ws-count">The folder you set is kept on this computer only, never synced.'
    + (ui.pickUnavailable ? ' ' + escapeHtml(ui.pickUnavailable) : '') + '</div>';
}

/** The id a Repository file row's button carries (focus returns to it from the reader). */
export function fileRowId(name) {
  return 'mem-setup-file-' + String(name || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

/** The files a set repository is checked for, one row each. Pure over the payload. */
export function repoFileRows(data) {
  const r = data && data.repo;
  if (!r || !isStr(r.path)) return [];
  const root = r.path.replace(/\/+$/, '');
  const m = r.marker || null;
  let marker;
  if (r.exists === false) marker = { state: 'fix', word: 'the folder is not on this computer' };
  else if (!m || !m.present) marker = { state: 'fix', word: 'not in this folder' };
  else if (!m.namesThis) marker = { state: 'fix', word: 'names ' + (m.line || '?') };
  else {
    const g = m.git || {};
    const git = g.repo === false ? 'not a git repository'
      : g.tracked === false || g.uncommitted === true ? 'not committed'
        : g.unpushed === true ? 'not pushed' : g.upstream ? 'committed and pushed' : 'committed';
    marker = { state: git === 'not committed' || git === 'not pushed' ? 'fix' : 'ok',
      word: 'names ' + (data.project || 'this project') + ' · ' + git };
  }
  const rows = [{ name: '.curator-project', kind: 'marker', present: !!(m && m.present), state: marker.state, word: marker.word,
    readBy: 'agents and hooks', tools: [], path: root }];
  const files = new Map();
  for (const t of data.tools || []) {
    for (const f of (t && t.block && t.block.files) || []) {
      if (!f || !isStr(f.name)) continue;
      const cur = files.get(f.name) || { ...f, tools: [], toolIds: [] };
      cur.tools.push(t.label);
      cur.toolIds.push(t.id);
      files.set(f.name, cur);
    }
  }
  for (const f of files.values()) {
    const s = !f.present ? { state: 'none', word: 'no such file' }
      : !f.hasBlock ? { state: 'fix', word: 'no Curator block' }
        : f.wrongProject ? { state: 'fix', word: 'names ' + f.namesProject }
          : !f.current ? { state: 'fix', word: 'block outdated' }
            // v3.79.0 (amendment 2): the block does not fit in what the tool reads.
            : f.blockPastCap === true ? { state: 'fix', word: 'block past what it reads' }
              : { state: 'ok', word: f.atTop ? 'block current · at the top' : 'block current' };
    rows.push({ name: f.name, kind: 'instruction', present: !!f.present, ...s, readBy: f.tools.join(', '),
      tools: f.tools, toolIds: f.toolIds, path: root + '/' + f.name });
  }
  return rows;
}

function repoSetBody(data, ui) {
  const r = data.repo;
  const rows = repoFileRows(data);
  const table = r.exists === false ? ''
    : '<div class="mem-ws-wrap mem-setup-wrap"><table class="mem-ws-table mem-setup-table"><thead><tr>'
      + '<th scope="col">File</th><th scope="col">State</th><th scope="col">Read by</th>'
      + '<th scope="col" class="mem-ws-cell-act"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>'
      + rows.map((x) => '<tr class="mem-ws-row mem-setup-row" data-setup-row="' + fileRowId(x.name) + '">'
        // v3.79.0 (contract §C): the row opens the file in the reader.
        + '<td class="mem-ws-cell-name"><button type="button" class="mem-ws-open" id="' + fileRowId(x.name) + '"'
          + ' data-setup-act="file-open" data-name="' + escapeHtml(x.name) + '"'
          + ' aria-label="' + escapeHtml('Open ' + x.name + ' in the reader') + '">'
          + '<span class="mem-ws-slug">' + escapeHtml(x.name) + '</span></button></td>'
        + '<td>' + st(x.state, x.word) + '</td>'
        + '<td class="mem-ws-cell-who">' + escapeHtml(x.readBy || '—') + '</td>'
        + '<td class="mem-ws-cell-act">' + btnG('reveal', 'Reveal', ' data-path="' + escapeHtml(x.path) + '"'
          + ' aria-label="' + escapeHtml('Reveal ' + x.name + ' in Finder') + '"') + '</td>'
        + '</tr>').join('')
      + '</tbody></table></div>';
  const count = '<div class="mem-ws-count">' + escapeHtml(TRAVELS_LINES['setup-repo']) + '</div>'
    + '<div class="mem-ws-count"><span class="mem-setup-inline-path">' + escapeHtml(r.display || r.path) + '</span>'
    + ' · set on this computer · ' + btnG('change-repo', 'Change folder') + '</div>';
  return table + (ui.editRepo ? pathRow(data, ui, ui.repoDraft ?? r.path) : '') + count;
}

function repoMeta(data) {
  const r = data.repo;
  if (!r) {
    const n = repoCandidatesOf(data).length;
    return 'not set' + (n ? ' · ' + plural(n, 'folder') + ' found' : '');
  }
  const where = r.display || r.path;
  if (r.exists === false) return where + ' · not on this computer';
  const rows = repoFileRows(data);
  const fix = rows.filter((x) => x.state === 'fix').length;
  const current = rows.filter((x) => x.state === 'ok').length;
  return where + ' · ' + (fix ? fix + ' to fix' : plural(current, 'file') + ' current');
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPUTERS — the fold
// ═══════════════════════════════════════════════════════════════════════════

const KIND_WORD = { app: 'Mac app', source: 'source checkout' };

/** "Mac app · source checkout talis-…-17d23c (also saved as mac-17d23c)". Pure. */
export function installsLine(group) {
  const parts = group.installs.map((i, idx) => {
    // The first install's name IS the row's name, so only its kind is said.
    const head = idx === 0 ? (KIND_WORD[i.kind] || '')
      : [KIND_WORD[i.kind] || null, i.display || i.primary].filter(Boolean).join(' ');
    const also = i.aliases.length ? '(also saved as ' + i.aliases.join(', ') + ')' : '';
    return [head, also].filter(Boolean).join(' ');
  }).filter(Boolean);
  return parts.join(' · ');
}

function syncCell(group, sync) {
  if (group.thisComputer) {
    if (!sync || !sync.configured) return st('none', 'Personal Sync not set up');
    return (isStr(sync.lastSync) ? ageSpan(sync.lastSync, 'synced') : 'never synced')
      + (Number.isInteger(sync.pending) && sync.pending > 0 ? ' · ' + plural(sync.pending, 'change') + ' to send' : '');
  }
  if (group.waiting) return st('fix', 'a newer handoff is waiting on GitHub');
  return '—<span class="visually-hidden"> its own sync time is not recorded here</span>';
}

function computersBody(data) {
  const groups = physicalOf(data);
  const sync = data.sync || {};
  const table = groups.length
    ? '<div class="mem-ws-wrap mem-setup-wrap"><table class="mem-ws-table mem-setup-table"><thead><tr>'
      + '<th scope="col">Computer</th><th scope="col">Harnesses that saved</th><th scope="col">Newest save</th>'
      + '<th scope="col">Curator</th><th scope="col">Sync</th></tr></thead><tbody>'
      + groups.map((g, idx) => {
        const line = installsLine(g);
        // v3.79.0 (contract §C): the row opens the computer in the reader.
        return '<tr class="mem-ws-row mem-setup-row" data-setup-row="mem-setup-comp-' + idx + '">'
          + '<td class="mem-ws-cell-name"><button type="button" class="mem-ws-open" id="mem-setup-comp-' + idx + '"'
            + ' data-setup-act="computer-open" data-computer="' + idx + '"'
            + ' aria-label="' + escapeHtml('Open what ' + g.name + ' saved, in the reader') + '">' + freshDot(g.at)
            + '<span class="mem-ws-machine">' + escapeHtml(g.name) + '</span>'
            + (g.thisComputer ? '<span class="mem-ws-mine">this computer</span>' : '') + '</button>'
            + (line ? '<span class="mem-setup-sub">' + escapeHtml(line) + '</span>' : '') + '</td>'
          + '<td class="mem-ws-cell-who">' + escapeHtml(g.tools.join(', ') || '—') + '</td>'
          + '<td class="mem-ws-cell-age">' + (g.at ? ageSpan(g.at, null) : '—') + '</td>'
          + '<td class="mem-ws-cell-size">' + (g.curator ? '<span class="cur-setup-mono">' + escapeHtml(g.curator) + '</span>' : st('not-checked', 'not recorded')) + '</td>'
          + '<td class="mem-ws-cell-who">' + syncCell(g, sync) + '</td>'
          + '</tr>';
      }).join('')
      + '</tbody></table></div>'
    : '<p class="mem-setup-empty">No computer has saved to this project.</p>';
  let count;
  let doors;
  if (sync.configured) {
    const bits = ['Sync now pulls and pushes your whole knowledge folder — every domain.'];
    if (Number.isInteger(sync.pending) && sync.pending > 0) bits.push(plural(sync.pending, 'file') + ' not on GitHub, across all domains.');
    const waiting = Array.isArray(sync.incoming) ? sync.incoming.length : null;
    let checked = '';
    if (isStr(sync.incomingCheckedAt)) {
      checked = ' ' + ageSpan(sync.incomingCheckedAt, 'GitHub checked')
        + escapeHtml(waiting === null ? '.' : (waiting ? ': ' + plural(waiting, 'file') + ' waiting there' + (sync.incomingCapped ? ' (first 20 files)' : '') + '.' : ': nothing waiting there.'));
    } else if (waiting === null) checked = ' ' + escapeHtml('GitHub was not checked recently.');
    count = '<div class="mem-ws-count">' + escapeHtml(TRAVELS_LINES['setup-computers']) + ' ' + escapeHtml(bits.join(' ')) + checked + '</div>';
    doors = btn2('sync', 'Sync now') + (waiting === null ? btnG('check-github', 'Check GitHub') : '') + btnG('open-sync', 'Open Sync');
  } else {
    count = '<div class="mem-ws-count">' + escapeHtml(TRAVELS_LINES['setup-computers'])
      + ' Personal Sync is not set up on this computer, so other computers’ saves do not reach it.</div>';
    doors = btnG('open-sync', 'Open Sync');
  }
  return table + count + '<div class="mem-k-doors mem-setup-doors">' + doors + '</div>';
}

function computersMeta(data) {
  const c = computerCounts(data);
  return [plural(c.computers, 'computer'), c.installs > c.computers ? plural(c.installs, 'install') : null].filter(Boolean).join(' · ');
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SIMPLE VIEW (v4.2, Pro off) — one row per harness, one status, one action
// ═══════════════════════════════════════════════════════════════════════════
//
// DESIGN-context-redesign §3 and §7.1–7.4. The page shows the ANSWER ("is this
// harness ready, and if not, what is my next step?"); the reader shows the
// evidence. Nothing is hidden that Pro shows as a warning: a to-fix line that
// names a harness becomes that harness's row — its status, its words in
// full and its first fix button — and every other button it carries is one
// press away, in the harness's reader (the same in both modes). A to-fix
// line that names no harness stays a loud note above the list, as in Pro.

/** Guide states that still leave work to do on this computer. */
const LEFT_STATES = ['todo', 'fix', 'wait'];

/** What a "can't check here" step is called in a sentence ("skills can't be checked here"). */
const CANT_NOUNS = { mcp: 'the connection', skills: 'skills', block: 'the agent instructions', save: 'the first save' };

/**
 * THE ONE COUNT (v4.2.0 fix, audit M2 / e2e DEF-2). The simple row, the Pro
 * reader and the guide's own line all count from here, so "1 step left" on a
 * row never opens on "2 steps to do". `left` = steps with work to do (to do,
 * to fix, not checked yet); `cant` = steps The Curator can't check on this
 * computer — NOT done, and never counted as done: a row with nothing else
 * left says "Ready" only beside "<what> can't be checked here". Pure.
 */
export function guideTally(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const left = list.filter((x) => LEFT_STATES.includes(x.state));
  const cant = list.filter((x) => x.state === 'cant');
  const optional = list.filter((x) => x.state === 'optional');
  const fix = list.filter((x) => x.state === 'fix');
  const cantWords = cant.length
    ? cant.map((x) => CANT_NOUNS[x.key] || 'one step').join(' and ') + ' can’t be checked here'
    : '';
  return { left, cant, optional, fix, cantWords };
}

/**
 * One harness row's model: `{status, word, state, action, lines}`. Pure.
 *   fix       a to-fix line names it      → "Needs a fix" + that line's first fix
 *   not-here  saved from another computer, not connected here → "Not on this computer" + Set up here
 *   steps     steps left, nothing broken  → "N steps left" + Continue setup
 *   ready     nothing left                → "Ready"
 */
export function harnessRowModel(t, data) {
  const items = ((data && data.toFix) || []).filter((f) => f && f.tool === t.id);
  const { steps } = toolGuideSteps(t, data);
  const tally = guideTally(steps);
  const left = tally.left;
  const cantLine = tally.cantWords ? escapeHtml(tally.cantWords) : '';
  const sv = t.saved && isStr(t.saved.at) ? t.saved : null;
  const id = ' data-tool="' + escapeHtml(t.id) + '"';
  const savedLine = sv
    ? 'saved ' + ageSpan(sv.at, null) + ' ' + escapeHtml(sv.thisMachine ? 'on this ' + thisMachine() : 'on ' + (isStr(sv.machine) ? machineName(sv.machine, data) : 'another computer'))
    : escapeHtml('not saved yet');
  const unmeasured = t.measured === false || ((data && data.addable) || []).some((a) => a && a.id === t.id && a.measured === false);
  const untested = unmeasured ? escapeHtml('The Curator hasn’t tested this harness, so check its own settings too.') : '';
  if (items.length) {
    const f = items[0];
    let action = '';
    for (const fx of fixListOf(f)) { action = fixButton(fx, f, data && data.repo, true); if (action) break; }
    if (!action) action = btn2('tool-open', 'Show the fix', id + (stepKeyOfItem(f) ? ' data-step="' + stepKeyOfItem(f) + '"' : ''));
    return {
      status: 'fix', word: 'Needs a fix', state: 'fix', action,
      // EVERY to-fix line about it, in its own words, IN FULL — the same
      // sentences Pro's loud lines say (the parity test reads them). The
      // first one's first fix is the row's action; every other fix is one
      // press away, in its step in the reader.
      fixLines: items.length,
      lines: [...items.map((x) => { const d = fixDetailHtml(x); return withPaths(String(x.text || '')) + (d ? ' ' + d : ''); }),
        // The same count the guide opens on ("N steps to do"): every step
        // with work left, the fix included.
        [savedLine, items.length > 1 ? escapeHtml('the other fixes are in its steps') : null,
          left.length ? escapeHtml(plural(left.length, 'step') + ' left in all') : null, cantLine || null].filter(Boolean).join(' · '),
        untested].filter(Boolean),
    };
  }
  const mcpDone = steps[0] && steps[0].state === 'done';
  if (sv && !sv.thisMachine && !mcpDone) {
    return { status: 'not-here', word: 'Not on this computer', state: 'none',
      action: btn2('tool-open', 'Set up here', id + ' data-step="mcp"'), lines: [savedLine, untested].filter(Boolean) };
  }
  if (left.length) {
    return { status: 'steps', word: plural(left.length, 'step') + ' left', state: 'none',
      action: btn2('tool-open', 'Continue setup', id + ' data-step="' + left[0].key + '"'),
      lines: [escapeHtml('Next: ' + left[0].title.charAt(0).toLowerCase() + left[0].title.slice(1)) + ' · ' + savedLine
        + (cantLine ? ' · ' + cantLine : ''), untested].filter(Boolean) };
  }
  // Ready with a step The Curator can't check (Claude Code's skills, held by
  // the Claude account): "Ready" only beside the design's sub-line (§3.2).
  return { status: 'ready', word: 'Ready', state: 'ok', action: '', cant: tally.cant.length,
    lines: [cantLine ? cantLine + ' · ' + savedLine : savedLine, untested].filter(Boolean) };
}

/** One harness, one row: the whole row opens its reader (memory.js binds `data-setup-row`). Pure. */
function harnessRow(t, data) {
  const m = harnessRowModel(t, data);
  const rowId = 'mem-setup-tool-' + t.id;
  return '<li class="mem-hr mem-setup-row" data-setup-row="' + escapeHtml(rowId) + '" data-harness-status="' + m.status + '">'
    + '<button type="button" class="mem-hr-open" id="' + escapeHtml(rowId) + '" data-setup-act="tool-open" data-tool="' + escapeHtml(t.id) + '"'
      + ' aria-label="' + escapeHtml(t.label + ', ' + m.word.toLowerCase() + ' — open its setup steps') + '">'
      + '<span class="mem-hr-name">' + escapeHtml(t.label) + '</span></button>'
    + '<span class="mem-hr-status">' + st(m.state, m.word) + '</span>'
    + '<span class="mem-hr-act">' + m.action + '</span>'
    + '<span class="mem-hr-chev" aria-hidden="true">' + ICON_CHEV + '</span>'
    + '<span class="mem-hr-lines">' + m.lines.map((l, i) => '<span class="' + (i < (m.fixLines || 0) ? 'mem-hr-fix' : 'mem-hr-sub') + '">' + l + '</span>').join('') + '</span>'
    + '</li>';
}

/** The harness list, or the empty state that says what a harness is (§7.1). Pure. */
export function harnessList(data) {
  const tools = ((data && data.tools) || []).filter((t) => t && isStr(t.id));
  if (!tools.length) {
    return '<p class="mem-setup-empty mem-hr-empty">' + escapeHtml('No agent harness on this project yet. A harness is '
      + HARNESS_GLOSS + ' Add the one you use; Setup walks you through the four steps.') + '</p>';
  }
  return '<ul class="mem-hr-list" aria-label="Agent harnesses for this project">' + tools.map((t) => harnessRow(t, data)).join('') + '</ul>';
}

/** "N files here are not on GitHub yet" + Sync now — an outcome, so on screen in both modes (§3.5, D9). Pure. */
export function unsyncedLine(data) {
  const sync = (data && data.sync) || {};
  if (!sync.configured || !Number.isInteger(sync.pending) || sync.pending <= 0) return '';
  return noteHtml(ICON_CIRC, escapeHtml(plural(sync.pending, 'file') + ' here ' + (sync.pending === 1 ? 'is' : 'are') + ' not on GitHub yet, across all domains.'),
    escapeHtml('Your other computers see this project’s newest handoff only after you Sync now here.'),
    btn2('sync', 'Sync now'), 'mem-setup-unsynced');
}

/** The three travel routes, said ONCE, at the foot of the step (§3.5). Pure. */
export function routeLineHtml(data) {
  const sync = (data && data.sync) || {};
  const g = (key) => '<span class="mem-setup-route-glyph" data-travels="' + key + '">' + SVG(GLYPH[key], 12) + '</span>';
  const knowledge = sync.configured
    ? 'Handoffs, the brief and Documents travel by Sync now'
    : 'Handoffs, the brief and Documents travel by Personal Sync, which is not set up on this computer';
  const item = (key, words) => '<span class="mem-setup-route-item">' + g(key) + escapeHtml(words) + '</span>';
  return '<p class="mem-setup-route">'
    + item('personal-sync', knowledge)
    + item('project-git', 'the agent instructions and .curator-project by your project’s git')
    + item('this-computer', 'steps 1 and 2 are set up on each computer.')
    + (sync.configured ? '' : btnG('open-sync', 'Open Sync'))
    + '</p>';
}

/** What the "More in Pro" door names — only what is really behind it. Pure. */
export function setupProDoorWhat(data) {
  const tools = ((data && data.tools) || []).filter(Boolean);
  return [tools.length ? 'every check per harness' : null, 'the repository files', 'your computers']
    .filter(Boolean).join(', ');
}

/** The repository line in the simple view: the quiet question when unset, the field when asked for. Pure.
 *  Exported (phase 2) for the Projects page's Agents tab, both modes. */
export function simpleRepo(data, ui) {
  const field = ui.forceRepoOpen || ui.editRepo
    ? pathRow(data, ui, ui.repoDraft ?? (data.repo ? data.repo.path : ''))
      + (ui.pickUnavailable ? '<p class="mem-setup-empty" data-never-pro>' + escapeHtml(ui.pickUnavailable) + '</p>' : '')
    : '';
  return (data.repo ? '' : repoNotSetNote(data)) + field;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE STEP
// ═══════════════════════════════════════════════════════════════════════════

function fold(key, title, meta, body, open, attr = '') {
  return '<details class="mem-fold" data-mem-fold="' + escapeHtml(key) + '"' + attr + (open ? ' open' : '') + '>'
    + '<summary class="mem-fold-summary" id="mem-fold-' + escapeHtml(key) + '">' + ICON_CHEV
    + '<span>' + escapeHtml(title) + '</span>'
    // v3.79.0 (contract §B): the fold's channel, a neutral pill in its meta.
    + '<span class="mem-fold-meta">' + escapeHtml(meta)
      + (FOLD_TRAVELS[key] ? travelsPill(FOLD_TRAVELS[key].key, FOLD_TRAVELS[key].word) : '') + '</span>'
    + '</summary>'
    + '<div class="mem-fold-body">' + body + '</div>'
    + '</details>';
}

/** The picker row: "+ Add an agent harness", glossed beside it (the word's first use on the step). */
function pickerRow(ui, gloss = true) {
  return '<div class="mem-k-pick mem-setup-pick">' + (ui.pickerHtml || '')
    // v4.2.0 fix (e2e DEF-5): said once on the step — an empty list's own
    // line already says what a harness is, so the picker does not repeat it.
    + (gloss ? '<span class="mem-setup-gloss">' + escapeHtml('An agent harness is ' + HARNESS_GLOSS) + '</span>' : '') + '</div>' + customField(ui);
}

/**
 * The step's body. `s` is `{data, error, loading}`; `ui` carries the fold
 * state, the repository field, the custom-tool field, the picker's markup
 * (`pickerHtml`, rendered by memory.js from `setupToolPickerCfg`), and — v4.2
 * — the mode: `ui.pro` (the view passes `isPro()`; this module never reads a
 * global) and `ui.moreInPro`, shared/pro.js's `moreInProLine` (passed in, so
 * this module stays DOM-free and importable in Node).
 */
export function renderSetupBody(s, ui = {}) {
  const data = s && s.data;
  if (!data) {
    if (s && s.error) return '<div class="mem-ss-stack mem-setup-stack"><p class="mem-setup-err" role="alert">Could not check this computer: ' + escapeHtml(s.error) + '</p>' + errorDetailHtml(s.error) + '</div>';
    return '<div class="mem-ss-stack mem-setup-stack"><p class="mem-setup-empty" aria-busy="true">Checking this computer…</p></div>';
  }
  const folds = ui.openFolds || {};
  const recheckErr = s.error
    ? noteHtml(ICON_TRI, escapeHtml('The last re-check did not finish: ' + s.error + (/[.!?]$/.test(String(s.error)) ? '' : '.')),
      'What is shown is the reading before it.', btnG('check', 'Check again')) + errorDetailHtml(s.error)
    : '';
  if (!ui.pro) {
    const door = typeof ui.moreInPro === 'function' ? ui.moreInPro(setupProDoorWhat(data)) : '';
    return '<div class="mem-ss-stack mem-setup-stack mem-setup-simple">'
      + recheckErr
      // A to-fix line that names no harness on the list: a loud note, as in Pro.
      + toFixNotes(data, (f) => !harnessOfItem(f, data))
      + harnessList(data)
      + pickerRow(ui, ((data && data.tools) || []).some((t) => t && isStr(t.id)))
      + simpleRepo(data, ui)
      + unsyncedLine(data)
      + routeLineHtml(data)
      + door
      + '</div>';
  }
  const repoNote = data.repo ? '' : repoNotSetNote(data);
  // v4.2.0 fix: a refusal of the folder field is said ABOVE the folds (an
  // outcome never sits behind a chevron), so the fold below carries detail only.
  const repoErr = ui.repoError ? '<p class="mem-setup-err" role="alert">' + escapeHtml(ui.repoError) + '</p>' + errorDetailHtml(ui.repoError) : '';
  const foldUi = { ...ui, repoError: null };
  const repoBody = data.repo ? repoSetBody(data, foldUi) : repoNotSetBody(data, foldUi);
  // v4.2.0 fix (e2e DEF-3): the three folds exist only with Pro on, so they
  // carry the Pro marking (`proDrawnAttr`, passed in by the view: the "PRO"
  // label on the fold's title and the hairline). The to-fix lines, the
  // repository question, its refusal and the "not on GitHub yet" line are all
  // above them, on screen in both modes (scripts/test-pro-guard.js parity).
  const pa = typeof ui.proDrawnAttr === 'function' ? ui.proDrawnAttr() : '';
  return '<div class="mem-ss-stack mem-setup-stack">'
    + recheckErr + toFixNotes(data) + repoNote + repoErr
    // v4.2.0 fix (e2e DEF-4): "N files here are not on GitHub yet · Sync now"
    // is an outcome, so with Pro on too it is on screen, never inside the
    // closed Computers fold.
    + unsyncedLine(data)
    + pickerRow(ui)
    + fold('setup-tools', 'Agent harnesses', toolsMeta(data), toolsTable(data), !!folds['setup-tools'], pa)
    + fold('setup-repo', 'Repository on this computer', repoMeta(data), repoBody,
      !!folds['setup-repo'] || !!ui.forceRepoOpen || !!ui.editRepo, pa)
    + fold('setup-computers', 'Computers', computersMeta(data), computersBody(data), !!folds['setup-computers'], pa)
    + '</div>';
}

/** The head row's controls: when it was checked (ticking) and Re-check. */
export function setupHeadHtml(s) {
  const data = s && s.data;
  const at = data && data.checkedAt;
  return (isStr(at) ? ageSpan(at, 'checked', 'mem-setup-checked') : '')
    + '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="check"' + (s && s.loading ? ' disabled' : '') + '>'
    + (s && s.loading ? 'Checking…' : 'Check again') + '</button>';
}

// ═══════════════════════════════════════════════════════════════════════════
// THE READER — one tool's full evidence
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The evidence sections. v3.78.0 sends `evidence: [{heading, lines, reveal?}]`;
 * for a v3.77.0 server they are built from the row's own cells. Pure.
 */
// The evidence headings the backend writes, in the page's words (v4.2).
const EVIDENCE_HEADINGS = { 'MCP bridge': 'Connection (MCP)', 'Instruction block': 'Agent instructions' };

const ISO_AT_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;

/**
 * ONE EVIDENCE LINE, AS A PERSON READS IT (v4.2, audit bug 10). The backend's
 * lines carry what the maintainer measured, as he wrote it down: "on the
 * maintainer's Mac on 2026-09-25", "(2026-09-26)", and a save's raw ISO time.
 * A timestamp becomes its age ("2 hours ago"); a bare measurement date and the
 * maintainer's name go; the fact itself stays. Pure (the clock is `now`).
 */
export function plainEvidenceLine(line, now = Date.now()) {
  let out = String(line ?? '');
  // v4.2.0 fix (e2e DEF-7): the test notes the adapters record, said as what
  // they mean for this computer — never how or when the maintainer saw them.
  out = out.replace(/(^|\s+)each held their own (\S+) on the maintainer['’]s Mac(?: on \d{4}-\d{2}-\d{2})?/gi, '$1can each hold their own $2');
  out = out.replace(/\bran once(?: \(\d{4}-\d{2}-\d{2}\))? but its injection was not seen used(; the project file['’]s was)?/gi,
    (m, proj) => 'runs, but it is not confirmed that the agent uses what it adds' + (proj ? '; the project file’s hook is confirmed' : ''));
  out = out.replace(/\s*\((?:observed|seen)\b[^)]*\)/gi, '');
  out = out.replace(ISO_AT_RE, (iso) => ageWordsFor(iso, now, null) || iso);
  out = out.replace(/\s+on the maintainer['’]s Mac(?: on \d{4}-\d{2}-\d{2})?/gi, ' when The Curator was tested');
  out = out.replace(/\s*\((?:observed,?\s*)?\d{4}-\d{2}-\d{2}\)/g, '');
  out = out.replace(/\s+on \d{4}-\d{2}-\d{2}\b/g, '');
  out = out.replace(/\bthe maintainer['’]s\b/gi, 'a tested');
  return out.replace(/\s{2,}/g, ' ').trim();
}

export function toolEvidence(t, data = null) {
  if (Array.isArray(t && t.evidence) && t.evidence.length) {
    return t.evidence.filter((e) => e && isStr(e.heading)).map((e) => ({
      heading: EVIDENCE_HEADINGS[e.heading] || e.heading,
      lines: (Array.isArray(e.lines) ? e.lines : []).filter(isStr).map((l) => plainEvidenceLine(l)),
      reveal: isStr(e.reveal) ? e.reveal : null,
    }));
  }
  const out = [];
  const cellLines = (c) => (c ? [c.word, c.note].filter(isStr) : []);
  const sv = t && t.saved;
  out.push({ heading: 'Last saved', reveal: null, lines: sv && sv.at
    ? [ageWordsFor(sv.at, Date.now(), 'saved') || sv.at,
      [isStr(sv.machine) ? 'from ' + machineName(sv.machine, data) + (sv.thisMachine ? ' (this computer)' : '') : null,
        isStr(sv.scope) ? 'as ' + sv.scope + (sv.wrongScope ? ' — not its own name' : '') : null].filter(Boolean).join(' · ')].filter(isStr)
    : ['no save from any computer'] });
  out.push({ heading: 'Connection (MCP)', reveal: null, lines: cellLines(t && t.bridge) });
  out.push({ heading: 'Skills', reveal: null, lines: cellLines(t && t.skills) });
  const b = t && t.block;
  out.push({ heading: 'Agent instructions', reveal: null, lines: [...cellLines(b),
    ...((b && b.files) || []).filter((f) => f && isStr(f.name)).map((f) => f.name + ': ' + (!f.present ? 'no such file' : !f.hasBlock ? 'no Curator block' : f.current ? 'block current' : 'block outdated'))] });
  const h = t && t.hooks;
  const ev = h && h.evidence;
  out.push({ heading: 'Hooks', reveal: null, lines: [...cellLines(h),
    ev && ev.start && isStr(ev.start.at) ? 'start hook seen ' + (ageWordsFor(ev.start.at, Date.now(), null) || ev.start.at) : null,
    ev && ev.stop && isStr(ev.stop.at) ? 'stop hook seen ' + (ageWordsFor(ev.stop.at, Date.now(), null) || ev.stop.at)
      + (ev.stop.decision === 'ask' ? ', asked for a save' : ', did not ask') : null,
    h && isStr(h.suggest) ? 'to wire it: ' + h.suggest : null].filter(isStr) });
  return out.filter((e) => e.lines.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SETUP GUIDE — a tool that is not ready, as four numbered steps (v3.80.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// The maintainer, 2026-09-28: after "+ Add an agent app" nobody knows what to do
// next. So the reader of a tool that is not ready opens on the four things
// "ready" takes, in the order they are done, each built from what the check
// already read and each carrying its own state and its own doors:
//
//   1 Connect The Curator's MCP   — the file, its format, the entry to copy
//   2 Install the two skills      — where they go, the .zip files (or: skip)
//   3 Put the Curator instructions in the file it reads, then commit + push
//   4 Let it save once, from this computer
//
// A to-fix line about the tool is shown INSIDE the step it belongs to (its
// words and its buttons), never a second time above the guide. Nothing here
// writes anything: every door copies, reveals or downloads.

/** A guide state → [the state class it is inked with, its word]. */
export const GUIDE_MARKS = Object.freeze({
  done: ['ok', 'done'],
  fix: ['fix', 'to fix'],
  todo: ['none', 'to do'],
  cant: ['cant-check', 'can’t check here'],
  wait: ['not-checked', 'not checked yet'],
  optional: ['none', 'optional'],
  skip: ['none', 'skip'],
});

const FORMAT_WORDS = { json: 'JSON', toml: 'TOML', yaml: 'YAML', jsonc: 'JSON' };
const STEP_KINDS = {
  mcp: (k) => k === 'bridge' || k === 'bridge-file',
  skills: (k) => k === 'skills',
  block: (k) => /^block-/.test(k),
  save: (k) => k === 'wrong-scope',
};

/** The guide step a to-fix item belongs to ('mcp' · 'skills' · 'block' · 'save'), or null. Pure. */
export function stepKeyOfItem(f) {
  const k = String((f && f.kind) || '');
  return Object.keys(STEP_KINDS).find((key) => STEP_KINDS[key](k)) || null;
}

/** This app's own skill downloads for a tool (a payload href is data). */
function zipLinksFor(t) {
  const own = Array.isArray(t && t.skillZips) ? t.skillZips.filter((z) => z && isStr(z.href) && SKILL_HREF_RE.test(z.href)) : [];
  return own.length
    ? own.map((z) => '<a class="btn btn-ghost btn-xs" href="' + escapeHtml(z.href) + '" download>' + escapeHtml(isStr(z.name) ? z.name : baseName(z.href)) + '</a>').join('')
    : ZIPS;
}

/** The instruction files a tool reads: the payload's `reads`, else what this view knows. Pure. */
function readsOf(t) {
  if (Array.isArray(t && t.reads)) return t.reads.filter(isStr);
  if (isStr(t && t.instructionFile)) return [t.instructionFile];
  return FIRST_FILE[t && t.id] ? [FIRST_FILE[t.id]] : [];
}

/** A to-fix item's two lines as step prose. */
function itemText(f) {
  return '<p class="mem-setup-ev-p mem-setup-gfix">' + ICON_TRI
    + '<span class="mem-setup-note-text"><span class="mem-setup-note-l1">' + withPaths(String(f.text || '')) + '</span>'
    + (isStr(f.detail) ? '<span class="mem-setup-note-l2">' + withPaths(f.detail) + '</span>' : '') + '</span></p>';
}

/**
 * The four steps for one tool: `[{key, title, state, html, doors}]` plus the
 * to-fix items each one took. Pure over the payload.
 */
export function toolGuideSteps(t, data) {
  const label = t.label || t.id;
  const parts = toolParts(t);
  const repo = data && data.repo && data.repo.exists !== false ? data.repo : null;
  const repoWhere = repo ? (repo.display || repo.path) : null;
  const items = ((data && data.toFix) || []).filter((f) => f && f.tool === t.id);
  const placed = new Set();
  const take = (key) => {
    const got = items.filter((f) => STEP_KINDS[key](String(f.kind || '')));
    got.forEach((f) => placed.add(f));
    return got;
  };
  const fromItems = (got) => ({ html: got.map(itemText).join(''), doors: got.map((f) => fixButtons(f, repo)).join('') });
  const p = (text) => '<p class="mem-setup-ev-p">' + withPaths(text) + '</p>';
  const steps = [];

  // ── 1 · MCP ──────────────────────────────────────────────────────────────
  {
    const got = take('mcp');
    const snip = t.mcpSnippet && isStr(t.mcpSnippet.text) ? t.mcpSnippet : null;
    const target = t.mcpTarget && isStr(t.mcpTarget.display) ? t.mcpTarget : null;
    const unmeasured = t.measured === false || ((data && data.addable) || []).some((a) => a && a.id === t.id && a.measured === false);
    let state;
    let html;
    let doors = '';
    if (parts.mcp.state === 'ok') {
      state = 'done';
      html = p(target && target.exists ? target.display + ' names The Curator.' : 'Connected — ' + parts.mcp.word + '.');
    } else {
      state = got.length ? 'fix' : parts.mcp.state === 'cant-check' ? 'cant' : 'todo';
      const fmt = FORMAT_WORDS[(snip && snip.format) || (target && target.format)] || null;
      let where;
      if (t.id === 'dsh') where = 'Paste into ~/.dsh/cordis.patch.yml (merge — do not copy over the file); never cordis.yml.';
      else if (unmeasured) where = 'Config location not measured — copy the entry by hand into ' + label + '’s own MCP settings.';
      else if (t.custom === true || !target) where = 'Add this entry to ' + label + '’s MCP settings' + (t.custom === true ? ' — most harnesses read this mcpServers shape.' : '.');
      else where = 'Add this entry to ' + target.display + (fmt ? ' (' + fmt + ')' : '')
        + (target.exists ? ', beside what is already there' : ' — create the file if it isn’t there') + ', then restart ' + label + '.';
      html = (got.length ? fromItems(got).html : '') + p(where)
        + (snip ? '<pre class="mem-setup-snippet"><code>' + escapeHtml(snip.text) + '</code></pre>' : '');
      if (got.length) doors = fromItems(got).doors;
      if (snip && !/data-setup-act="copy-snippet"/.test(doors)) doors = btn2('copy-snippet', 'Copy MCP entry', ' data-tool="' + escapeHtml(t.id) + '"') + doors;
      if (!snip && !doors) doors = btn2('settings', 'Open Settings › MCP bridge');
      if (target && isStr(target.file) && !doors.includes('data-path="' + escapeHtml(target.file) + '"')) {
        doors += btnG('reveal', 'Reveal ' + baseName(target.file), ' data-path="' + escapeHtml(target.file) + '"');
      }
    }
    steps.push({ key: 'mcp', title: 'Connect it to The Curator', when: 'once per computer, for every project', state, html, doors });
  }

  // ── 2 · SKILLS ───────────────────────────────────────────────────────────
  {
    const got = take('skills');
    const tree = t.skillsTarget && typeof t.skillsTarget === 'object' ? t.skillsTarget : null;
    let state;
    let html;
    let doors = '';
    let when = 'once per computer, for every project';
    // v4.2.0 fix (e2e A, confusions 3 and 4): a skills folder is named IN
    // FULL. A path that does not start at ~ or / is inside the project's top
    // folder (the adapter's project root — OpenCode's .agents/skills/), so
    // the step says which folder and that it is per project; a home folder
    // the harness also reads is offered for every project.
    const roots = Array.isArray(tree && tree.roots) ? tree.roots.filter((r) => r && isStr(r.display)) : [];
    const homeDir = (roots.find((r) => r.base === 'home') || {}).display || null;
    const inProject = !!(tree && isStr(tree.path) && !/^[~/]/.test(tree.path));
    if (got.length) {
      state = 'fix';
      ({ html, doors } = fromItems(got));
      // v4.2 (audit bug 5): what a skill is, said where one is asked for.
      html = p(SKILL_GLOSS) + html;
    } else if (parts.skills.state === 'ok') {
      state = 'done';
      html = p('Both skills are installed and current (' + parts.skills.word + ').');
    } else if (tree && tree.accountHeld) {
      state = 'cant';
      // Where to add them: the folder the harness reads on this computer
      // (when it reads one), or the Claude account — Claude: Customize → Skills.
      html = p(SKILL_GLOSS) + (homeDir
        ? p(label + ' reads skills from ' + homeDir + ' on this computer and from your Claude account. The Curator can’t read your account, so this step can’t be checked here.')
          + p('If they are in neither yet: unzip both into ' + homeDir + ' — one folder per skill — or upload both in Claude: Customize → Skills. Then start a new ' + label + ' session.')
        : p(label + ' keeps skills in your Claude account, which The Curator can’t read. If they are not there yet, upload both in Claude: Customize → Skills.'));
      doors = zipLinksFor(t);
    } else if (tree && tree.verified && tree.path) {
      state = 'todo';
      const where = inProject
        ? tree.path + ' in your project’s top folder' + (repoWhere ? ' (' + repoWhere + ')' : '')
        : tree.path;
      html = p(SKILL_GLOSS) + p('Unzip both into ' + where + ' — one folder per skill' + (inProject && homeDir ? ', or into ' + homeDir + ' for every project' : '')
        + ' — then start a new ' + label + ' session.');
      if (inProject) when = homeDir ? 'once per project (or once per computer, in ' + homeDir + ')' : 'once per project';
      doors = zipLinksFor(t);
    } else if (tree && tree.verified && !tree.path) {
      state = 'skip';
      html = p(label + ' has no skills support — skip this step. The agent instructions in step 3 carry what it needs.');
    } else {
      state = 'optional';
      html = p(SKILL_GLOSS) + p('Whether ' + label + ' reads skills is not known. If it does, install both the way it documents; if not, skip this step.');
      doors = zipLinksFor(t);
    }
    steps.push({ key: 'skills', title: 'Teach it how to use The Curator', when, state, html, doors });
  }

  // ── 3 · THE INSTRUCTIONS ─────────────────────────────────────────────────
  {
    const got = take('block');
    const names = readsOf(t);
    const file = names[0] || 'AGENTS.md';
    let state;
    let html;
    let doors = '';
    if (got.length) {
      state = 'fix';
      ({ html, doors } = fromItems(got));
    } else if (parts.block.state === 'ok') {
      state = 'done';
      const cur = ((t.block && t.block.files) || []).find((f) => f && f.current && f.hasBlock && isStr(f.name));
      html = p('The agent instructions are current in ' + (cur ? cur.name : fileList(names) || file) + '.');
      if (repo) doors = btnG('change-repo', 'Change folder');
    } else if (!names.length) {
      state = 'optional';
      html = p(label + ' reads no instruction file The Curator knows — it keeps its own rules. Paste the agent instructions into them, or skip this step.');
      doors = btn2('copy-block', 'Copy agent instructions');
    } else if (parts.block.state === 'not-checked' || !repo) {
      state = 'wait';
      html = p(label + ' reads ' + fileList(names) + '. Paste the agent instructions at the very top of ' + file
        + ' in your project’s top folder, then commit and push it so your other computers get it too.')
        + p('Setup checks the file once you set where the project’s code is on this computer.');
      doors = btn2('copy-block', 'Copy agent instructions') + btnG('choose-repo', 'Set the folder');
    } else {
      state = 'todo';
      html = p(label + ' reads ' + fileList(names) + (t.custom === true ? ' (assumed — most harnesses do)' : '')
        + '. Paste the agent instructions at the very top of ' + file + ' in ' + repoWhere + ', then commit and push it so your other computers get it too.');
      const fx = Array.isArray(t.instructionFixes) ? t.instructionFixes : [];
      doors = (fx.length ? fixButtons({ fixes: fx, tool: t.id }, repo) : btn2('copy-block', 'Copy agent instructions'))
        + btnG('change-repo', 'Change folder');
    }
    steps.push({ key: 'block', title: 'Point it at this project', when: 'once per project, carried by its git', state, html, doors });
  }

  // ── 4 · THE FIRST SAVE ───────────────────────────────────────────────────
  {
    const got = take('save');
    const sv = t.saved && t.saved.at ? t.saved : null;
    const own = sv && !wrongSave({ ...sv, tool: t.id }, data);
    let state;
    let html;
    let doors = '';
    const how = 'Open a new conversation in ' + label + ' in your project’s folder' + (repoWhere ? ' (' + repoWhere + ')' : '')
      + ' and give it a task. It turns ready once it saves this project from this computer under its own name, “' + t.id + '”.';
    if (got.length) {
      state = 'fix';
      ({ html, doors } = fromItems(got));
    } else if (sv && sv.thisMachine && own) {
      state = 'done';
      html = '<p class="mem-setup-ev-p">' + escapeHtml('Saved from this computer ') + ageSpan(sv.at, null) + '.</p>';
    } else if (sv && !sv.thisMachine) {
      state = 'todo';
      html = p('It has saved this project from ' + (isStr(sv.machine) ? machineName(sv.machine, data) : 'another computer') + ', not from this one yet. ' + how);
    } else {
      state = 'todo';
      html = p(how);
    }
    steps.push({ key: 'save', title: 'Let it save once, from this computer', when: 'once per computer', state, html, doors });
  }
  return { steps, placed };
}

/** The guide's markup, and which to-fix items it placed. Pure. */
export function toolGuide(t, data) {
  const { steps, placed } = toolGuideSteps(t, data);
  const label = t.label || t.id;
  // v4.2.0 fix (audit M2): the row's count, from the one tally.
  const tally = guideTally(steps);
  const left = tally.left.length;
  const opt = tally.optional.length;
  const cant = tally.cantWords ? '; ' + tally.cantWords : '';
  const html = '<section class="mem-setup-guide" aria-label="' + escapeHtml('Set up ' + label + ' on this computer') + '">'
    + '<h3 class="mem-setup-ev-h" id="mem-setup-guide-h" tabindex="-1">' + escapeHtml('Set up ' + label + ' on this computer') + '</h3>'
    + '<p class="mem-setup-ev-p" data-guide-left="' + left + '">' + escapeHtml((left
      ? plural(left, 'step') + ' to do' + (opt ? ', ' + opt + ' optional' : '') + cant + '. Setup re-checks when you come back to this window.'
      : 'Nothing left to do here' + (opt ? ' (' + opt + ' optional)' : '') + cant + ' — Check again to read it again.')) + '</p>'
    + '<ol class="mem-setup-steps">'
    + steps.map((x, i) => {
      const [cls, word] = GUIDE_MARKS[x.state] || GUIDE_MARKS.todo;
      return '<li class="mem-setup-gstep" id="mem-setup-gstep-' + x.key + '" tabindex="-1" data-guide-step="' + x.key + '" data-guide-state="' + x.state + '">'
        + '<span class="settings-block-num mem-setup-gnum" aria-hidden="true">' + (i + 1) + '</span>'
        + '<div class="mem-setup-gbody">'
        + '<div class="mem-setup-ghead"><span class="mem-setup-gtitle">' + escapeHtml(x.title) + '</span>' + st(cls, word)
          + (x.when ? '<span class="mem-setup-gwhen">' + escapeHtml(x.when) + '</span>' : '') + '</div>'
        + x.html
        + (x.doors ? '<span class="mem-k-doors mem-setup-gdoors">' + x.doors + '</span>' : '')
        + '</div></li>';
    }).join('')
    + '</ol></section>';
  return { html, placed, steps };
}

/**
 * Remove, where it belongs (v3.80.0): a tool the owner added and that has
 * not saved is taken off this computer's list; one that has saved says why
 * it stays. Nothing is uninstalled either way.
 */
function removeSection(t) {
  const r = removableOf(t);
  const label = t.label || t.id;
  if (r.ok) {
    return '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">On this computer’s list</h3>'
      + '<p class="mem-setup-ev-p">' + escapeHtml('You added ' + label + ' here. Removing it only stops Setup checking it on this computer — nothing is uninstalled, and “+ Add an agent harness” brings it back.') + '</p>'
      + '<span class="mem-k-doors">' + btnG('remove-tool', 'Remove from this list', ' data-tool="' + escapeHtml(t.id) + '"') + '</span></section>';
  }
  if (t.userAdded !== true) return '';
  const why = r.why === 'saved'
    ? label + ' has saved this project, so it stays on the list — its saves are this project’s record.'
    : r.why === 'configured'
      ? label + '’s MCP settings on this computer name The Curator, so Setup keeps checking it. Take the entry out of its settings to take it off the list.'
      : null;
  return why ? '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">On this computer’s list</h3><p class="mem-setup-ev-p">' + escapeHtml(why) + '</p></section>' : '';
}

/**
 * The reader payload for one tool, or null. `hideBacklinks`: a tool is not a
 * wiki page, and "BACKLINKS · 0" under it would be a reading about nothing.
 * Pure.
 */
export function toolReaderContent(data, toolId, opts = {}) {
  const t = ((data && data.tools) || []).find((x) => x && x.id === toolId);
  if (!t) return null;
  const s = toolStatus(t, data);
  // v3.80.0: the reader opens on the numbered SETUP GUIDE; v4.2: for every
  // harness, a ready one too (its four steps then read "done", one line
  // each) — one layout, never a second one for "ready". The guide carries the
  // MCP entry, the agent instructions, the skills and each to-fix line it
  // belongs to, so those are not said a second time below it.
  const guide = toolGuide(t, data);
  const fixes = (data.toFix || []).filter((f) => f && f.tool === t.id && !guide.placed.has(f));
  const notes = fixes.map((f) => fixNote(f, data)).join('');
  const ev = toolEvidence(t, data).map((e) => '<section class="mem-setup-ev">'
    + '<h3 class="mem-setup-ev-h">' + escapeHtml(e.heading) + '</h3>'
    + '<ul class="mem-setup-ev-lines">' + e.lines.map((l) => '<li>' + withPaths(l) + '</li>').join('') + '</ul>'
    + (e.reveal ? '<span class="mem-k-doors">' + btnG('reveal', 'Reveal ' + baseName(e.reveal), ' data-path="' + escapeHtml(e.reveal) + '"') + '</span>' : '')
    + '</section>').join('');
  // "What Setup read": the evidence, behind ONE fold — open with Pro on (the
  // only difference between the two modes' readers). Nothing in it is a
  // warning: every to-fix line is in a step above or in `notes`.
  const evFold = ev
    ? '<details class="mem-fold mem-setup-evfold"' + (opts.pro ? ' open' : '') + '>'
      + '<summary class="mem-fold-summary">' + ICON_CHEV + '<span>What Setup read</span>'
      + '<span class="mem-fold-meta">' + escapeHtml('files on this computer'
        + (isStr(data.checkedAt) ? ', ' + (ageWordsFor(data.checkedAt, Date.now(), 'checked') || '') : '')) + '</span></summary>'
      + '<div class="mem-fold-body mem-setup-evbody">' + ev + '</div></details>'
    : '';
  const bodyHtml = '<div class="mem-setup-reader">'
    + '<p class="mem-setup-ev-status">' + st(s.state, s.word) + '</p>'
    + whereItStands(t, data)
    + notes
    + guide.html
    + removeSection(t)
    + evFold
    + '<p class="mem-setup-ev-foot">Last saved is this project’s record from every computer. Everything else was read from files on this computer' + (isStr(data.checkedAt) ? ', ' + escapeHtml(ageWordsFor(data.checkedAt, Date.now(), null) || '') : '') + '.</p>'
    + '</div>';
  return {
    slug: 'Setup › ' + t.label,
    title: t.label,
    typeLabel: 'agent harness',
    bodyHtml,
    hideBacklinks: true,
    returnFocusTo: 'mem-setup-tool-' + t.id,
  };
}

/** "Last saved 2 hours ago on this Mac, under “antigravity”." — the reader's first fact. Pure. */
function whereItStands(t, data = null) {
  const sv = t && t.saved && isStr(t.saved.at) ? t.saved : null;
  if (!sv) return '<p class="mem-setup-ev-p">' + escapeHtml((t.label || t.id) + ' has not saved this project yet.') + '</p>';
  const where = sv.thisMachine ? 'on this ' + thisMachine() : 'on ' + (isStr(sv.machine) ? machineName(sv.machine, data) : 'another computer');
  return '<p class="mem-setup-ev-p">' + escapeHtml('Last saved ') + ageSpan(sv.at, null)
    + escapeHtml(' ' + where + (isStr(sv.scope) ? ', under “' + sv.scope + '”' : '') + '.') + '</p>';
}

// ═══════════════════════════════════════════════════════════════════════════
// THE READER — one repository file (v3.79.0, contract §C)
// ═══════════════════════════════════════════════════════════════════════════
//
// The file's text is UNTRUSTED: it reaches the page only through the
// markdown renderer memory.js hands in (`opts.md`, shared/markdown.js's
// escape-first `renderMarkdown`), or — with none, as in plain Node — escaped
// into a <pre>. Never written into the page raw.
//
// The Curator's block is FRAMED, with its state and "Copy current
// instructions"; where the tool reads only the first N bytes a rule says
// "‹tool› reads up to here". A missing file says what goes there.

// Amendment 4: `state` ∈ current · outdated · wrong-project · past-cap, and
// `pill` ∈ ok · fix — the pill, when sent, decides the ink.
const BLOCK_WORDS = {
  current: ['ok', 'current'],
  outdated: ['fix', 'outdated'],
  'wrong-project': ['fix', 'names another project'],
  'past-cap': ['fix', 'past what the harness reads'],
};

/** A block's [state, word] for its frame. Pure. */
function blockMark(block) {
  const known = BLOCK_WORDS[block.state];
  const word = known ? known[1] : (isStr(block.state) ? block.state : 'not checked');
  const pill = block.pill === 'ok' || block.pill === 'fix' ? block.pill : null;
  return [pill || (known ? known[0] : 'not-checked'), word];
}

/** "Committed and pushed." — a git fact, or '' when none was read. Pure. */
function gitWords(g) {
  if (!g || typeof g !== 'object') return '';
  if (g.gitRepo === false) return 'The folder is not a git repository.';
  if (g.committed === false) return 'Not committed to the project’s git yet.';
  if (g.committed !== true) return '';
  return g.pushed === false ? 'Committed, not pushed yet.' : g.pushed === true ? 'Committed and pushed.' : 'Committed.';
}

/** "Antigravity" for a tool id or a label; the id itself when unknown. */
function toolLabelOf(data, idOrLabel) {
  if (!isStr(idOrLabel)) return null;
  const t = ((data && data.tools) || []).find((x) => x && (x.id === idOrLabel || x.label === idOrLabel));
  return t && isStr(t.label) ? t.label : idOrLabel;
}

const escPre = (t) => '<pre class="mem-setup-file-pre">' + escapeHtml(t) + '</pre>';

// A line that opens (or is) a block of its own — never joined to a neighbour.
const BLOCK_LINE_RE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|<|(?:[-*_]\s*){3,}$)/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * READ A FILE AS A DOCUMENT (v3.79.0 screen review): instruction files are
 * hard-wrapped at ~90 characters, and the reader rendered every source
 * newline as a line break, so paragraphs read ragged. Here a single newline
 * INSIDE a paragraph (or a list item's hard-wrapped continuation) becomes a
 * space; a blank line still separates paragraphs; a fenced block, a heading,
 * a table row, a quote and a line ending in two spaces (a markdown hard break)
 * are left exactly as written. Text in, text out — the escaping stays the
 * renderer's (shared/markdown.js, unchanged for every other caller). Pure.
 */
export function softWrap(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; out.push(line); continue; }
    const prev = out.length ? out[out.length - 1] : null;
    const joinable = !inFence && prev !== null && line.trim() !== '' && !BLOCK_LINE_RE.test(line)
      && prev.trim() !== '' && !/  $/.test(prev) && !FENCE_RE.test(prev)
      && !/^\s*(#{1,6}\s|>|\|)/.test(prev) && !/^\s{4,}\S/.test(line);
    if (joinable) out[out.length - 1] = prev.replace(/\s+$/, '') + ' ' + line.trim();
    else out.push(line);
  }
  return out.join('\n');
}

/**
 * The file's text cut at the block's two edges and the cap, each piece
 * rendered, the block's pieces inside one frame. Offsets are JS string
 * offsets into `text` (amendment 3), clamped: a truncated read may put them
 * past its end. Pure.
 */
export function fileBodyHtml(text, block, cap, capLabel, md) {
  const render = typeof md === 'function' ? md : escPre;
  const len = text.length;
  const clamp = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(len, Math.floor(n))) : null);
  const bs = block ? clamp(block.start) : null;
  const be = block ? clamp(block.end) : null;
  const hasBlock = bs !== null && be !== null && be > bs;
  const capAt = cap ? clamp(cap.at) : null;
  const cuts = [...new Set([0, len, ...(hasBlock ? [bs, be] : []), ...(capAt !== null ? [capAt] : [])])].sort((a, b) => a - b);
  const [stateKey, word] = hasBlock ? blockMark(block) : [];
  const frameHead = hasBlock
    ? '<div class="mem-setup-frame-head"><span class="mem-setup-frame-title">The agent instructions</span>'
      + st(stateKey, word)
      + '<span class="mem-k-doors">' + btn2('copy-block', 'Copy the current agent instructions') + '</span></div>'
    : '';
  const rule = capAt !== null
    ? '<div class="mem-setup-cap-rule" role="separator"><span>' + escapeHtml((capLabel || 'This harness') + ' reads up to here') + '</span></div>'
    : '';
  let out = '';
  let inFrame = false;
  let ruleDone = false;
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const inBlock = hasBlock && a >= bs && b <= be;
    if (!inBlock && inFrame) { out += '</section>'; inFrame = false; }
    if (inBlock && !inFrame) { out += '<section class="mem-setup-frame" aria-label="The agent instructions">' + frameHead; inFrame = true; }
    if (!ruleDone && capAt !== null && a === capAt) { out += rule; ruleDone = true; }
    const piece = text.slice(a, b);
    if (piece.trim()) out += '<div class="mem-reader-doc mem-setup-file-doc">' + render(typeof md === 'function' ? softWrap(piece) : piece) + '</div>';
  }
  if (!ruleDone && capAt !== null) out += rule;
  if (inFrame) out += '</section>';
  return out;
}

/**
 * The reader payload for one Repository file. `resp` is the file route's
 * answer: undefined while it is being read; `{error}` when it could not be
 * (an older server has no such route — the reader then still shows the
 * row's state and its doors). Pure.
 */
export function fileReaderContent(data, name, resp, opts = {}) {
  const row = repoFileRows(data).find((x) => x.name === name) || null;
  if (!row) return null;
  const isMarker = row.kind === 'marker';
  const who = isStr(data.project) ? data.project : 'this project';
  const repoWhere = data.repo && (data.repo.display || data.repo.path);
  const fixesFor = ((data && data.toFix) || []).filter((f) => f && (f.file === name || (isMarker && /^marker-/.test(f.kind || ''))));
  const notes = fixesFor.map((f) => fixNote(f, data)).join('');
  // The file's own doors, unless a to-fix line above already carries the same
  // action — one button per action on the page.
  const copyAct = isMarker ? 'copy-marker' : 'copy-block';
  const doors = (notes.includes('data-setup-act="' + copyAct + '"') ? ''
    : (isMarker ? btn2('copy-marker', 'Copy marker line') : btn2('copy-block', 'Copy agent instructions')))
    + (notes.includes('data-path="' + escapeHtml(row.path) + '"') ? ''
      : btnG('reveal', isMarker ? 'Reveal the folder' : 'Reveal ' + name, ' data-path="' + escapeHtml(row.path) + '"'));
  const head = '<p class="mem-setup-ev-status mem-setup-file-status">' + st(row.state, row.word)
    + travelsPill('project-git', 'travels by project’s git') + '</p>';
  let body;
  if (resp === undefined || resp === null) {
    body = '<p class="mem-setup-empty" aria-busy="true">Reading ' + escapeHtml(name) + '…</p>';
  } else if (resp.error || resp.ok === false) {
    // v3.99.2: raw text (an older server's "HTTP 404", a raw file error)
    // becomes the plain sentence, with the raw text below it for support. A
    // short refusal word from the route (repo_not_set) keeps the old shape.
    const why = resp.error ? userMessageFrom(resp) : null;
    body = (why && /[.!?]$/.test(why.error))
      ? '<p class="mem-setup-ev-p">' + escapeHtml('The file could not be shown here. ' + why.error)
        + (revealAvailable() ? ' Reveal it to open it in Finder.' : '') + '</p>' + renderErrorDetail(why.detail, why.code)
      : '<p class="mem-setup-ev-p">' + escapeHtml('The file could not be shown here: ' + ((why && why.error) || 'no answer') + '.')
        + (revealAvailable() ? ' Reveal it to open it in Finder.' : '') + '</p>' + (why ? renderErrorDetail(why.detail, why.code) : '');
  } else if (resp.exists === false) {
    body = '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">Not in this folder</h3><p class="mem-setup-ev-p">'
      + (isMarker
        ? escapeHtml('.curator-project holds one line — ' + (data.domain ? data.domain + '/' : '') + who
          + ' — so agents and hooks in this folder know which project it is. Create it at the top of the folder, then commit and push.')
        : escapeHtml((row.readBy && row.readBy !== '—' ? row.readBy : 'An agent harness') + ' reads ' + name
          + ' at the start of every session. Create it at the top of ' + (repoWhere || 'the folder')
          + ', paste the agent instructions at its very top, then commit and push.'))
      + '</p></section>';
  } else {
    const text = isStr(resp.text) ? resp.text : '';
    const capTool = resp.cap ? toolLabelOf(data, resp.cap.tool) : null;
    const lines = [];
    if (resp.truncated) lines.push('Showing the first 256 KB of this file.');
    // Amendment 4: `git` on every file, `marker` for .curator-project.
    const gw = gitWords(isMarker && resp.marker && typeof resp.marker === 'object' ? resp.marker : resp.git);
    if (gw) lines.push(gw);
    if (!isMarker && !resp.block) lines.push('No agent instructions in this file.');
    if (resp.block && Number.isFinite(resp.block.start) && resp.block.start >= text.length) {
      lines.push('The agent instructions start past the part shown here.');
    }
    if (resp.cap && Number.isFinite(resp.cap.bytes) && !Number.isFinite(resp.cap.at)) {
      lines.push((capTool || 'The harness') + ' reads the first ' + resp.cap.bytes.toLocaleString('en-US') + ' bytes; this file is shorter.');
    }
    body = (lines.length ? '<p class="mem-setup-ev-p">' + escapeHtml(lines.join(' ')) + '</p>' : '')
      + '<div class="mem-setup-file">' + (isMarker
        ? escPre(text)
        : fileBodyHtml(text, resp.block || null, resp.cap && Number.isFinite(resp.cap.at) ? resp.cap : null, capTool, opts.md)) + '</div>';
  }
  const bodyHtml = '<div class="mem-setup-reader">' + head + notes
    + (doors ? '<span class="mem-k-doors">' + doors + '</span>' : '')
    + body
    + '<p class="mem-setup-ev-foot">' + escapeHtml(TRAVELS_LINES['setup-repo']) + '</p>'
    + '</div>';
  return {
    slug: 'Setup › ' + name,
    title: name,
    typeLabel: 'repository file',
    bodyHtml,
    hideBacklinks: true,
    returnFocusTo: fileRowId(name),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE READER — one computer (v3.79.0, contract §C)
// ═══════════════════════════════════════════════════════════════════════════

function shortDate(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Is this save under a WRONG name? The backend's `wrongScope` when sent; with
 * none, only "main" or another KNOWN tool's id is wrong. Pure.
 */
export function wrongSave(s, data) {
  if (!s) return false;
  if (typeof s.wrongScope === 'boolean') return s.wrongScope;
  if (!isStr(s.scope)) return false;
  if (s.scope === 'main') return true;
  const known = new Set([...Object.keys(FIRST_FILE), ...((data && data.tools) || []).map((t) => t && t.id).filter(isStr)]);
  return known.has(s.scope) && s.scope !== s.tool;
}

/** Each tool's newest save on one computer, across its installs. Pure. */
export function newestSavesOf(group) {
  const by = new Map();
  for (const inst of (group && group.installs) || []) {
    for (const s of inst.saves || []) {
      const key = isStr(s.tool) ? s.tool : s.label;
      const cur = by.get(key);
      if (!cur || (Date.parse(s.at) || 0) > (Date.parse(cur.at) || 0)) by.set(key, { ...s, install: inst.display || inst.primary });
    }
  }
  return [...by.values()].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
}

/** The reader payload for one physical computer (by its row's index). Pure. */
export function computerReaderContent(data, idx) {
  const g = physicalOf(data)[Number(idx)];
  if (!g) return null;
  const sync = (data && data.sync) || {};
  const sec = (h, inner) => '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">' + escapeHtml(h) + '</h3>' + inner + '</section>';
  const ul = (items) => '<ul class="mem-setup-ev-lines">' + items.map((l) => '<li>' + l + '</li>').join('') + '</ul>';
  const head = '<p class="mem-setup-ev-status mem-setup-file-status">'
    + (g.thisComputer ? '<span class="mem-ws-mine mem-setup-here">this computer</span>' : '')
    + travelsPill('personal-sync', 'travels by Personal Sync') + '</p>';
  const installs = sec('Installs', ul(g.installs.map((i) => escapeHtml([KIND_WORD[i.kind] || 'install', i.display || i.primary].join(' '))
    + (i.aliases.length ? escapeHtml(' — also saved as ' + i.aliases.join(', ')) : '')
    + (i.curator ? ' · <span class="cur-setup-mono">' + escapeHtml('Curator ' + i.curator) + '</span>' : ''))));
  const saves = newestSavesOf(g);
  let savesHtml;
  if (saves.length) {
    savesHtml = sec('Each harness’s newest save', ul(saves.map((s) => {
      const label = isStr(s.label) ? s.label : toolLabelOf(data, s.tool);
      // Flag ONLY a save the backend calls wrong (`wrongScope`: under "main"
      // or another tool's name). A session-named scope
      // ("session-2026-09-28-…") is this project's own convention and is not
      // wrong — so `ownScope: false` alone never flags (screen review).
      const own = !wrongSave(s, data);
      return '<span class="mem-setup-save-who">' + escapeHtml(label) + '</span> · '
        + escapeHtml(shortDate(s.at)) + ' (' + ageSpan(s.at, null) + ')'
        + (isStr(s.scope) ? ' · ' + escapeHtml('saved under “' + s.scope + '”') : '')
        + (own ? '' : ' ' + st('fix', 'not its own name' + (isStr(s.tool) ? ' “' + s.tool + '”' : '')))
        + (isStr(s.curator) ? ' · <span class="cur-setup-mono">' + escapeHtml('Curator ' + s.curator) + '</span>' : '');
    })));
  } else {
    savesHtml = sec('Saves', ul([escapeHtml((g.tools.length ? g.tools.join(', ') : 'No agent harness') + ' saved this project here')
      + (g.at ? escapeHtml('; newest ' + shortDate(g.at) + ' (') + ageSpan(g.at, null) + ')' : '') + '.']));
  }
  let syncLines;
  if (g.thisComputer) {
    if (!sync.configured) syncLines = [escapeHtml('Personal Sync is not set up on this computer, so other computers’ saves do not reach it.')];
    else {
      syncLines = [isStr(sync.lastSync) ? ageSpan(sync.lastSync, 'Last synced') : escapeHtml('Never synced.'),
        escapeHtml(Number.isInteger(sync.pending) && sync.pending > 0
          ? plural(sync.pending, 'file') + ' here not on GitHub yet, across all domains.' : 'Nothing here waiting to be sent.')];
      const waiting = Array.isArray(sync.incoming) ? sync.incoming.length : null;
      if (waiting !== null) syncLines.push(escapeHtml(waiting ? plural(waiting, 'file') + ' waiting on GitHub for this ' + thisMachine() + '.' : 'Nothing waiting on GitHub.'));
      syncLines.push(escapeHtml('Sync now pulls and pushes your whole knowledge folder — every domain.'));
    }
  } else {
    syncLines = [escapeHtml(g.waiting
      ? 'A newer handoff from it is waiting in your Personal Sync on GitHub. Sync now before you start the agent.'
      : 'Its saves reach this ' + thisMachine() + ' after it syncs and you Sync now here. Its own sync time is not recorded here.')];
  }
  const syncDoors = sync.configured && (g.thisComputer || g.waiting) ? '<span class="mem-k-doors">' + btn2('sync', 'Sync now') + '</span>' : '';
  const bodyHtml = '<div class="mem-setup-reader">' + head + installs + savesHtml
    + sec('Personal Sync', ul(syncLines) + syncDoors)
    + '<p class="mem-setup-ev-foot">' + escapeHtml(TRAVELS_LINES['setup-computers']) + '</p>'
    + '</div>';
  return {
    slug: 'Setup › ' + g.name,
    title: g.name,
    typeLabel: 'computer',
    bodyHtml,
    hideBacklinks: true,
    returnFocusTo: 'mem-setup-comp-' + Number(idx),
  };
}
