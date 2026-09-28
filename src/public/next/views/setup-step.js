// Context › project › step 5 "Setup" (v3.77.0; rebuilt v3.78.0) — the words
// and the markup.
//
// DOM-FREE AT IMPORT, the ws-delete.js / chat-list.js rule: an offline suite
// imports the REAL builders in plain Node (scripts/test-next-setup-step.js)
// instead of lifting them out of memory.js by brace-matching. memory.js owns
// the state, the requests and the listeners; this module owns what the step
// SAYS. It imports nothing that touches a DOM — the "+ Add a tool" listbox is
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
// · "+ Add a tool" is the SHARED listbox (step ③'s "+ Add a domain"), groups
//   "Known tools" / "Other", its last row "Custom tool…".
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
// `repoSuggestions`; no `group` on `addable` → one "Known tools" group and no
// "Custom tool…" row (the old server would refuse the custom PUT).

import { ageWordsFor } from '../shared/age-ticker.js';
import { freshnessTier } from '../shared/age.js';
// v3.80.0: the "+ Add a tool" rows are the composer's model rows' anatomy
// (import-free, DOM-free — the suite still imports this module in Node).
import { listRowBodyHtml } from '../shared/model-row.js';

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

/** The listbox value of the "Custom tool…" row. */
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
  if (Array.isArray(data.physical) && data.physical.length) {
    return data.physical
      .filter((g) => g && Array.isArray(g.installs))
      .map((g) => groupOf(g.installs.filter(Boolean).map(installOf), g.thisComputer === true))
      .sort((a, b) => (b.thisComputer - a.thisComputer) || ((Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)));
  }
  const rows = (Array.isArray(data.computers) ? data.computers : []).filter(Boolean).map(installOf);
  const here = rows.filter((r) => r.thisComputer);
  const out = here.length ? [groupOf(here, true)] : [];
  for (const r of rows.filter((x) => !x.thisComputer)) out.push(groupOf([r], false));
  return out;
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
    tools.length ? tools.join(' · ') : 'no agent tool yet',
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
  return '<tr class="mem-ws-row">'
    + '<td class="mem-ws-cell-name"><button type="button" class="mem-ws-open" id="mem-setup-tool-' + escapeHtml(t.id) + '"'
      + ' data-setup-act="tool-open" data-tool="' + escapeHtml(t.id) + '"'
      + ' aria-label="' + escapeHtml('Open the Setup evidence for ' + t.label) + '">'
      + freshDot(saved && saved.at)
      + '<span class="mem-ws-slug">' + escapeHtml(t.label) + '</span>'
    + '</button></td>'
    + '<td class="mem-setup-cell-status">' + st(s.state, s.word) + '</td>'
    + '<td class="mem-ws-cell-age">' + (saved ? ageSpan(saved.at, null) : '—') + '</td>'
    + '<td class="mem-ws-cell-machine">' + (saved && isStr(saved.machine)
      ? '<span class="mem-ws-machine">' + escapeHtml(saved.machine) + '</span>'
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
export const TOOLS_COUNT_LINE = 'A tool is ready once it is connected here, reads the Curator instructions and has saved this project from this computer — press one for its setup steps.';

function toolsTable(data) {
  const tools = (data.tools || []).filter((t) => t && isStr(t.id));
  if (!tools.length) {
    return '<p class="mem-setup-empty">No agent tool has saved to this project or is set up on this computer.</p>';
  }
  return '<div class="mem-ws-wrap"><table class="mem-ws-table mem-setup-table">'
    + '<thead><tr><th scope="col">Tool</th><th scope="col">Status</th><th scope="col">Last saved</th>'
    + '<th scope="col">Saved from</th><th scope="col">On this computer</th>'
    + '<th scope="col" class="mem-ws-cell-act"><span class="visually-hidden">Actions</span></th></tr></thead>'
    + '<tbody>' + tools.map((t) => toolRow(t, data)).join('') + '</tbody></table></div>'
    + '<div class="mem-ws-count">' + escapeHtml(TRAVELS_LINES['setup-tools']) + ' ' + escapeHtml(TOOLS_COUNT_LINE) + '</div>';
}

function toolsMeta(data) {
  const tools = (data.tools || []).filter(Boolean);
  const fixN = tools.filter((t) => toolStatus(t, data).status === 'to-fix').length;
  return [plural(tools.length, 'tool'), fixN ? fixN + ' to fix' : null].filter(Boolean).join(' · ');
}

// ═══════════════════════════════════════════════════════════════════════════
// THE "+ Add a tool" PICKER — a cfg for the shared listbox
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
export const TOOL_MENU_FOOT = 'Adding a tool only tells Setup to check it on this computer — you connect it yourself.';

/**
 * ONE cfg, for both `renderListboxHtml` and `mountListbox` (memory.js calls
 * both with it). Groups "Known tools" / "Other"; "Custom tool…" is an ACTION
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
  const options = [...known.map((a) => opt(a, 'Known tools')), ...other.map((a) => opt(a, 'Other'))];
  if (custom) {
    const label = isStr(custom.label) ? custom.label : 'Custom tool…';
    const meta = ['any other MCP client', 'you name it'];
    options.push({ value: CUSTOM_TOOL_VALUE, label, group: 'Other', action: true,
      detail: meta.join(' · '), html: listRowBodyHtml({ title: label, meta }) });
  }
  return {
    id: 'mem-setup-add',
    value: null,
    placeholder: '+ Add a tool',
    triggerText: busy ? 'Adding…' : '+ Add a tool',
    ariaLabel: 'Add an agent tool to check on this computer',
    disabled: busy === true || options.length === 0,
    triggerClass: 'btn btn-secondary btn-xs',
    menuClass: 'lb-rich mr-menu',
    minWidth: 360,
    footHtml: '<p class="mr-foot">' + escapeHtml(TOOL_MENU_FOOT) + '</p>',
    actionValues: custom ? [CUSTOM_TOOL_VALUE] : [],
    options,
  };
}

/** The custom name's refusal, or null. The route's rule, said first here. Pure. */
export function customToolNameError(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'Type the tool’s name.';
  if (n.length > 40) return 'A tool name is at most 40 characters.';
  if (!CUSTOM_TOOL_RE.test(n)) return 'Use letters, digits, spaces, dots, dashes and underscores only.';
  return null;
}

function customField(ui) {
  if (!ui.customOpen) return '';
  return '<div class="mem-setup-path-row mem-setup-custom">'
    + '<label class="visually-hidden" for="mem-setup-custom-input">The custom tool’s name</label>'
    + '<input type="text" id="mem-setup-custom-input" class="mem-setup-input" spellcheck="false" autocomplete="off" maxlength="40"'
      + ' placeholder="The tool’s name, e.g. My Harness" value="' + escapeHtml(ui.customDraft || '') + '">'
    + '<button type="button" class="btn btn-secondary btn-xs" data-setup-act="add-custom">Add</button>'
    + '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="custom-cancel">Cancel</button>'
    + '</div>'
    + (ui.customError ? '<p class="mem-setup-err" role="alert">' + escapeHtml(ui.customError) + '</p>' : '');
}

// ═══════════════════════════════════════════════════════════════════════════
// THE TO-FIX NOTES — one loud line each, with its own fix
// ═══════════════════════════════════════════════════════════════════════════

const btn2 = (act, label, extra = '') => '<button type="button" class="btn btn-secondary btn-xs" data-setup-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';
const btnG = (act, label, extra = '') => '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="' + act + '"' + extra + '>' + escapeHtml(label) + '</button>';
const ZIPS = '<a class="btn btn-ghost btn-xs" href="/api/setup/skills/my-curator.zip" download>my-curator.zip</a>'
  + '<a class="btn btn-ghost btn-xs" href="/api/setup/skills/curator-continuity.zip" download>curator-continuity.zip</a>';
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
  const label = (dflt) => (isStr(fx.label) ? fx.label : dflt);
  switch (fx.kind) {
    case 'copy-block':
      return b('copy-block', label('Copy instructions'));
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
      return '<a class="btn ' + (primary ? 'btn-secondary' : 'btn-ghost') + ' btn-xs" href="' + escapeHtml(href) + '" download>'
        + escapeHtml(label('Download ' + baseName(href))) + '</a>';
    }
    case 'sync':
      return b('sync', label('Sync now'));
    case 'change-repo':
      return b('change-repo', label('Change folder'));
    case 'choose-folder':
      return b('choose-repo', label('Choose the folder'));
    case 'settings':
      return b('settings', label('Open Tools on this Mac'));
    case 'recheck':
      return b('check', label('Re-check'));
    case 'skills':
      // v3.78.0's one "skills" fix: the settings door and both downloads.
      return b('settings', label('Open Tools on this Mac')) + ZIPS;
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
    if (fix.kind === 'reveal' && isStr(f.tool) && isStr(fix.path)) out.push(btnG('settings', 'Open Tools on this Mac'));
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

/** One to-fix item as a note. Pure. */
function fixNote(f, data, attrs = '') {
  return noteHtml(ICON_TRI, withPaths(String(f.text || '')), isStr(f.detail) ? withPaths(f.detail) : '',
    fixButtons(f, data && data.repo), 'mem-setup-fix-note', attrs);
}

/** Every to-fix item as one loud note with its own fix. Pure. */
export function toFixNotes(data) {
  const toFix = Array.isArray(data && data.toFix) ? data.toFix.filter(Boolean) : [];
  return toFix.map((f, i) => fixNote(f, data, ' data-setup-fix="' + i + '"')).join('');
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
  const l1 = escapeHtml('Where is ' + who + '’s code on this Mac? Set its folder so Setup can check ' + repoCheckedFiles(data) + '.');
  if (cands.length === 1) {
    return noteHtml(ICON_CIRC, l1, 'Found on this Mac: <span class="mem-setup-inline-path">' + escapeHtml(cands[0].display) + '</span>',
      btn2('use-repo', 'Use ' + cands[0].display, ' data-path="' + escapeHtml(cands[0].path) + '"')
        + btnG('choose-repo', 'Choose another folder'), 'mem-setup-repo-note');
  }
  if (cands.length > 1) {
    return noteHtml(ICON_CIRC, l1, escapeHtml(cands.length + ' folders on this Mac look like it — choose one.'),
      btn2('choose-repo', 'Choose a folder'), 'mem-setup-repo-note');
  }
  return noteHtml(ICON_CIRC, l1, escapeHtml('Not on this Mac yet? Clone it first.'), btn2('choose-repo', 'Set the folder'), 'mem-setup-repo-note');
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
    + (ui.repoError ? '<p class="mem-setup-err" role="alert">' + escapeHtml(ui.repoError) + '</p>' : '');
}

function repoNotSetBody(data, ui) {
  const cands = repoCandidatesOf(data);
  const table = cands.length
    ? '<div class="mem-ws-wrap"><table class="mem-ws-table mem-setup-table"><thead><tr>'
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
    : '<div class="mem-ws-wrap"><table class="mem-ws-table mem-setup-table"><thead><tr>'
      + '<th scope="col">File</th><th scope="col">State</th><th scope="col">Read by</th>'
      + '<th scope="col" class="mem-ws-cell-act"><span class="visually-hidden">Actions</span></th></tr></thead><tbody>'
      + rows.map((x) => '<tr class="mem-ws-row">'
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
      : [KIND_WORD[i.kind] || null, i.primary].filter(Boolean).join(' ');
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
    ? '<div class="mem-ws-wrap"><table class="mem-ws-table mem-setup-table"><thead><tr>'
      + '<th scope="col">Computer</th><th scope="col">Tools that saved</th><th scope="col">Newest save</th>'
      + '<th scope="col">Curator</th><th scope="col">Sync</th></tr></thead><tbody>'
      + groups.map((g, idx) => {
        const line = installsLine(g);
        // v3.79.0 (contract §C): the row opens the computer in the reader.
        return '<tr class="mem-ws-row">'
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
// THE STEP
// ═══════════════════════════════════════════════════════════════════════════

function fold(key, title, meta, body, open) {
  return '<details class="mem-fold" data-mem-fold="' + escapeHtml(key) + '"' + (open ? ' open' : '') + '>'
    + '<summary class="mem-fold-summary" id="mem-fold-' + escapeHtml(key) + '">' + ICON_CHEV
    + '<span>' + escapeHtml(title) + '</span>'
    // v3.79.0 (contract §B): the fold's channel, a neutral pill in its meta.
    + '<span class="mem-fold-meta">' + escapeHtml(meta)
      + (FOLD_TRAVELS[key] ? travelsPill(FOLD_TRAVELS[key].key, FOLD_TRAVELS[key].word) : '') + '</span>'
    + '</summary>'
    + '<div class="mem-fold-body">' + body + '</div>'
    + '</details>';
}

/**
 * The step's body. `s` is `{data, error, loading}`; `ui` carries the fold
 * state, the repository field, the custom-tool field and the picker's markup
 * (`pickerHtml`, rendered by memory.js from `setupToolPickerCfg`).
 */
export function renderSetupBody(s, ui = {}) {
  const data = s && s.data;
  if (!data) {
    if (s && s.error) return '<div class="mem-ss-stack mem-setup-stack"><p class="mem-setup-err" role="alert">Could not check this computer: ' + escapeHtml(s.error) + '</p></div>';
    return '<div class="mem-ss-stack mem-setup-stack"><p class="mem-setup-empty" aria-busy="true">Checking this computer…</p></div>';
  }
  const folds = ui.openFolds || {};
  const recheckErr = s.error
    ? noteHtml(ICON_TRI, escapeHtml('The last re-check did not finish: ' + s.error + '.'), 'What is shown is the reading before it.', btnG('check', 'Re-check'))
    : '';
  const repoNote = data.repo ? '' : repoNotSetNote(data);
  const picker = '<div class="mem-k-pick mem-setup-pick">' + (ui.pickerHtml || '') + '</div>' + customField(ui);
  const repoBody = data.repo ? repoSetBody(data, ui) : repoNotSetBody(data, ui);
  return '<div class="mem-ss-stack mem-setup-stack">'
    + recheckErr + toFixNotes(data) + repoNote
    + picker
    + fold('setup-tools', 'Tools', toolsMeta(data), toolsTable(data), !!folds['setup-tools'])
    + fold('setup-repo', 'Repository on this computer', repoMeta(data), repoBody,
      !!folds['setup-repo'] || !!ui.forceRepoOpen || !!ui.editRepo)
    + fold('setup-computers', 'Computers', computersMeta(data), computersBody(data), !!folds['setup-computers'])
    + '</div>';
}

/** The head row's controls: when it was checked (ticking) and Re-check. */
export function setupHeadHtml(s) {
  const data = s && s.data;
  const at = data && data.checkedAt;
  return (isStr(at) ? ageSpan(at, 'checked', 'mem-setup-checked') : '')
    + '<button type="button" class="btn btn-ghost btn-xs" data-setup-act="check"' + (s && s.loading ? ' disabled' : '') + '>'
    + (s && s.loading ? 'Checking…' : 'Re-check') + '</button>';
}

// ═══════════════════════════════════════════════════════════════════════════
// THE READER — one tool's full evidence
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The evidence sections. v3.78.0 sends `evidence: [{heading, lines, reveal?}]`;
 * for a v3.77.0 server they are built from the row's own cells. Pure.
 */
export function toolEvidence(t) {
  if (Array.isArray(t && t.evidence) && t.evidence.length) {
    return t.evidence.filter((e) => e && isStr(e.heading)).map((e) => ({
      heading: e.heading,
      lines: (Array.isArray(e.lines) ? e.lines : []).filter(isStr),
      reveal: isStr(e.reveal) ? e.reveal : null,
    }));
  }
  const out = [];
  const cellLines = (c) => (c ? [c.word, c.note].filter(isStr) : []);
  const sv = t && t.saved;
  out.push({ heading: 'Last saved', reveal: null, lines: sv && sv.at
    ? [ageWordsFor(sv.at, Date.now(), 'saved') || sv.at,
      [isStr(sv.machine) ? 'from ' + sv.machine + (sv.thisMachine ? ' (this computer)' : '') : null,
        isStr(sv.scope) ? 'as ' + sv.scope + (sv.wrongScope ? ' — not its own name' : '') : null].filter(Boolean).join(' · ')].filter(isStr)
    : ['no save from any computer'] });
  out.push({ heading: 'MCP', reveal: null, lines: cellLines(t && t.bridge) });
  out.push({ heading: 'Skills', reveal: null, lines: cellLines(t && t.skills) });
  const b = t && t.block;
  out.push({ heading: 'Instruction block', reveal: null, lines: [...cellLines(b),
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
// The maintainer, 2026-09-28: after "+ Add a tool" nobody knows what to do
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
      else if (t.custom === true || !target) where = 'Add this entry to ' + label + '’s MCP settings' + (t.custom === true ? ' — most tools read this mcpServers shape.' : '.');
      else where = 'Add this entry to ' + target.display + (fmt ? ' (' + fmt + ')' : '')
        + (target.exists ? ', beside what is already there' : ' — create the file if it isn’t there') + ', then restart ' + label + '.';
      html = (got.length ? fromItems(got).html : '') + p(where)
        + (snip ? '<pre class="mem-setup-snippet"><code>' + escapeHtml(snip.text) + '</code></pre>' : '');
      if (got.length) doors = fromItems(got).doors;
      if (snip && !/data-setup-act="copy-snippet"/.test(doors)) doors = btn2('copy-snippet', 'Copy MCP entry', ' data-tool="' + escapeHtml(t.id) + '"') + doors;
      if (!snip && !doors) doors = btn2('settings', 'Open Tools on this Mac');
      if (target && isStr(target.file) && !doors.includes('data-path="' + escapeHtml(target.file) + '"')) {
        doors += btnG('reveal', 'Reveal ' + baseName(target.file), ' data-path="' + escapeHtml(target.file) + '"');
      }
    }
    steps.push({ key: 'mcp', title: 'Connect The Curator’s MCP', state, html, doors });
  }

  // ── 2 · SKILLS ───────────────────────────────────────────────────────────
  {
    const got = take('skills');
    const tree = t.skillsTarget && typeof t.skillsTarget === 'object' ? t.skillsTarget : null;
    let state;
    let html;
    let doors = '';
    if (got.length) {
      state = 'fix';
      ({ html, doors } = fromItems(got));
    } else if (parts.skills.state === 'ok') {
      state = 'done';
      html = p('Both skills are installed and current (' + parts.skills.word + ').');
    } else if (tree && tree.accountHeld) {
      state = 'cant';
      html = p(label + ' keeps skills in your Claude account, which The Curator can’t read. If they are not there yet, add both from these files.');
      doors = zipLinksFor(t);
    } else if (tree && tree.verified && tree.path) {
      state = 'todo';
      html = p('Unzip both into ' + tree.path + ' — one folder per skill — then start a new ' + label + ' session.');
      doors = zipLinksFor(t);
    } else if (tree && tree.verified && !tree.path) {
      state = 'skip';
      html = p(label + ' has no skills support — skip this step. The instructions in step 3 carry what it needs.');
    } else {
      state = 'optional';
      html = p('Whether ' + label + ' reads skills is not known. If it does, install both the way it documents; if not, skip this step.');
      doors = zipLinksFor(t);
    }
    steps.push({ key: 'skills', title: 'Install the two skills', state, html, doors });
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
      html = p('The Curator instructions are current in ' + (cur ? cur.name : fileList(names) || file) + '.');
    } else if (!names.length) {
      state = 'optional';
      html = p(label + ' reads no instruction file The Curator knows — it keeps its own rules. Paste the Curator instructions into them, or skip this step.');
      doors = btn2('copy-block', 'Copy instructions');
    } else if (parts.block.state === 'not-checked' || !repo) {
      state = 'wait';
      html = p(label + ' reads ' + fileList(names) + '. Paste the Curator instructions at the very top of ' + file
        + ' in your project’s top folder, then commit and push it so your other computers get it too.')
        + p('Setup checks the file once you set where the project’s code is on this computer.');
      doors = btn2('copy-block', 'Copy instructions') + btnG('choose-repo', 'Set the folder');
    } else {
      state = 'todo';
      html = p(label + ' reads ' + fileList(names) + (t.custom === true ? ' (assumed — most tools do)' : '')
        + '. Paste the Curator instructions at the very top of ' + file + ' in ' + repoWhere + ', then commit and push it so your other computers get it too.');
      const fx = Array.isArray(t.instructionFixes) ? t.instructionFixes : [];
      doors = fx.length ? fixButtons({ fixes: fx, tool: t.id }, repo) : btn2('copy-block', 'Copy instructions');
    }
    steps.push({ key: 'block', title: 'Put the Curator instructions in the file it reads', state, html, doors });
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
      html = p('It has saved this project from ' + (isStr(sv.machine) ? sv.machine : 'another computer') + ', not from this one yet. ' + how);
    } else {
      state = 'todo';
      html = p(how);
    }
    steps.push({ key: 'save', title: 'Let it save once, from this computer', state, html, doors });
  }
  return { steps, placed };
}

/** The guide's markup, and which to-fix items it placed. Pure. */
export function toolGuide(t, data) {
  const { steps, placed } = toolGuideSteps(t, data);
  const label = t.label || t.id;
  const left = steps.filter((x) => !['done', 'skip', 'optional'].includes(x.state)).length;
  const opt = steps.filter((x) => x.state === 'optional').length;
  const html = '<section class="mem-setup-guide" aria-label="' + escapeHtml('Set up ' + label + ' on this computer') + '">'
    + '<h3 class="mem-setup-ev-h">' + escapeHtml('Set up ' + label + ' on this computer') + '</h3>'
    + '<p class="mem-setup-ev-p">' + escapeHtml((left
      ? plural(left, 'step') + ' to do' + (opt ? ', ' + opt + ' optional' : '') + '. Setup re-checks when you come back to this window.'
      : 'Nothing left to do here' + (opt ? ' (' + opt + ' optional)' : '') + ' — Re-check to read it again.')) + '</p>'
    + '<ol class="mem-setup-steps">'
    + steps.map((x, i) => {
      const [cls, word] = GUIDE_MARKS[x.state] || GUIDE_MARKS.todo;
      return '<li class="mem-setup-gstep" data-guide-step="' + x.key + '" data-guide-state="' + x.state + '">'
        + '<span class="settings-block-num mem-setup-gnum" aria-hidden="true">' + (i + 1) + '</span>'
        + '<div class="mem-setup-gbody">'
        + '<div class="mem-setup-ghead"><span class="mem-setup-gtitle">' + escapeHtml(x.title) + '</span>' + st(cls, word) + '</div>'
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
      + '<p class="mem-setup-ev-p">' + escapeHtml('You added ' + label + ' here. Removing it only stops Setup checking it on this computer — nothing is uninstalled, and “+ Add a tool” brings it back.') + '</p>'
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
export function toolReaderContent(data, toolId) {
  const t = ((data && data.tools) || []).find((x) => x && x.id === toolId);
  if (!t) return null;
  const s = toolStatus(t, data);
  // v3.80.0: a tool that is not ready opens on its numbered SETUP GUIDE; the
  // guide carries the snippet, the instructions, the skills and each to-fix
  // line it belongs to, so those are not said a second time below it.
  const guide = s.status === 'ready' ? null : toolGuide(t, data);
  const fixes = (data.toFix || []).filter((f) => f && f.tool === t.id && !(guide && guide.placed.has(f)));
  const notes = fixes.map((f) => fixNote(f, data)).join('');
  const ev = toolEvidence(t).map((e) => '<section class="mem-setup-ev">'
    + '<h3 class="mem-setup-ev-h">' + escapeHtml(e.heading) + '</h3>'
    + '<ul class="mem-setup-ev-lines">' + e.lines.map((l) => '<li>' + withPaths(l) + '</li>').join('') + '</ul>'
    + (e.reveal ? '<span class="mem-k-doors">' + btnG('reveal', 'Reveal ' + baseName(e.reveal), ' data-path="' + escapeHtml(e.reveal) + '"') + '</span>' : '')
    + '</section>').join('');
  const parts = toolParts(t);
  // Amendment A2: known rows carry their own entry too. It is offered where it
  // is needed — a custom tool, or a tool whose MCP part is not ok here.
  const snip = t.mcpSnippet && isStr(t.mcpSnippet.text) && (t.custom === true || parts.mcp.state !== 'ok') ? t.mcpSnippet : null;
  const unmeasured = t.measured === false
    || ((data.addable || []).some((a) => a && a.id === t.id && a.measured === false));
  const snippet = snip
    ? '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">The Curator’s MCP entry</h3>'
      + '<p class="mem-setup-ev-p">' + escapeHtml(
        // Amendment A1: dsh's user layer is a PATCH file; cordis.yml is rewritten on every boot.
        t.id === 'dsh' ? 'Paste into ~/.dsh/cordis.patch.yml (merge — do not copy over the file); never cordis.yml.'
          : unmeasured ? 'Config location not measured — copy the entry by hand into ' + t.label + '’s own config.'
            : 'Paste this into ' + t.label + '’s MCP config.') + '</p>'
      + '<pre class="mem-setup-snippet"><code>' + escapeHtml(snip.text) + '</code></pre>'
      + '<span class="mem-k-doors">' + btn2('copy-snippet', 'Copy MCP entry', ' data-tool="' + escapeHtml(t.id) + '"') + '</span></section>'
    : '';
  const instr = isStr(t.instructionFile)
    ? '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">Instruction file</h3><p class="mem-setup-ev-p">'
      + escapeHtml(t.label + ' reads ' + t.instructionFile + ' at the top of the repository. Paste the Curator instructions at its very top.')
      + '</p><span class="mem-k-doors">' + btn2('copy-block', 'Copy instructions') + '</span></section>'
    : '';
  const zipLinks = Array.isArray(t.skillZips) && t.skillZips.some((z) => z && isStr(z.href) && z.href.startsWith('/api/setup/skills/'))
    ? t.skillZips.filter((z) => z && isStr(z.href) && z.href.startsWith('/api/setup/skills/'))
      .map((z) => '<a class="btn btn-ghost btn-xs" href="' + escapeHtml(z.href) + '" download>' + escapeHtml(isStr(z.name) ? z.name : baseName(z.href)) + '</a>').join('')
    : ZIPS;
  const zips = t.custom === true || parts.skills.state === 'cant-check' || parts.skills.state === 'fix'
    ? '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">Skill downloads</h3><p class="mem-setup-ev-p">The two skills this app carries, to install in the tool’s own skills folder.</p>'
      + '<span class="mem-k-doors">' + zipLinks + '</span></section>'
    : '';
  const bodyHtml = '<div class="mem-setup-reader">'
    + '<p class="mem-setup-ev-status">' + st(s.state, s.word) + '</p>'
    + notes
    + (guide ? guide.html + ev : ev + snippet + instr + zips)
    + removeSection(t)
    + '<p class="mem-setup-ev-foot">Last saved is this project’s record from every computer. Everything else was read from files on this computer' + (isStr(data.checkedAt) ? ', ' + escapeHtml(ageWordsFor(data.checkedAt, Date.now(), null) || '') : '') + '.</p>'
    + '</div>';
  return {
    slug: 'Setup › ' + t.label,
    title: t.label,
    typeLabel: 'agent tool',
    bodyHtml,
    hideBacklinks: true,
    returnFocusTo: 'mem-setup-tool-' + t.id,
  };
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
  'past-cap': ['fix', 'past what the tool reads'],
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
    ? '<div class="mem-setup-frame-head"><span class="mem-setup-frame-title">The Curator instructions</span>'
      + st(stateKey, word)
      + '<span class="mem-k-doors">' + btn2('copy-block', 'Copy current instructions') + '</span></div>'
    : '';
  const rule = capAt !== null
    ? '<div class="mem-setup-cap-rule" role="separator"><span>' + escapeHtml((capLabel || 'This tool') + ' reads up to here') + '</span></div>'
    : '';
  let out = '';
  let inFrame = false;
  let ruleDone = false;
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const inBlock = hasBlock && a >= bs && b <= be;
    if (!inBlock && inFrame) { out += '</section>'; inFrame = false; }
    if (inBlock && !inFrame) { out += '<section class="mem-setup-frame" aria-label="The Curator instructions">' + frameHead; inFrame = true; }
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
    : (isMarker ? btn2('copy-marker', 'Copy marker line') : btn2('copy-block', 'Copy instructions')))
    + (notes.includes('data-path="' + escapeHtml(row.path) + '"') ? ''
      : btnG('reveal', isMarker ? 'Reveal the folder' : 'Reveal ' + name, ' data-path="' + escapeHtml(row.path) + '"'));
  const head = '<p class="mem-setup-ev-status mem-setup-file-status">' + st(row.state, row.word)
    + travelsPill('project-git', 'travels by project’s git') + '</p>';
  let body;
  if (resp === undefined || resp === null) {
    body = '<p class="mem-setup-empty" aria-busy="true">Reading ' + escapeHtml(name) + '…</p>';
  } else if (resp.error || resp.ok === false) {
    body = '<p class="mem-setup-ev-p">' + escapeHtml('The file could not be shown here: ' + (resp.error || 'no answer') + '.')
      + ' Reveal it to open it in Finder.</p>';
  } else if (resp.exists === false) {
    body = '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">Not in this folder</h3><p class="mem-setup-ev-p">'
      + (isMarker
        ? escapeHtml('.curator-project holds one line — ' + (data.domain ? data.domain + '/' : '') + who
          + ' — so agents and hooks in this folder know which project it is. Create it at the top of the folder, then commit and push.')
        : escapeHtml((row.readBy && row.readBy !== '—' ? row.readBy : 'An agent tool') + ' reads ' + name
          + ' at the start of every session. Create it at the top of ' + (repoWhere || 'the folder')
          + ', paste the Curator instructions at its very top, then commit and push.'))
      + '</p></section>';
  } else {
    const text = isStr(resp.text) ? resp.text : '';
    const capTool = resp.cap ? toolLabelOf(data, resp.cap.tool) : null;
    const lines = [];
    if (resp.truncated) lines.push('Showing the first 256 KB of this file.');
    // Amendment 4: `git` on every file, `marker` for .curator-project.
    const gw = gitWords(isMarker && resp.marker && typeof resp.marker === 'object' ? resp.marker : resp.git);
    if (gw) lines.push(gw);
    if (!isMarker && !resp.block) lines.push('No Curator instructions in this file.');
    if (resp.block && Number.isFinite(resp.block.start) && resp.block.start >= text.length) {
      lines.push('The Curator instructions start past the part shown here.');
    }
    if (resp.cap && Number.isFinite(resp.cap.bytes) && !Number.isFinite(resp.cap.at)) {
      lines.push((capTool || 'The tool') + ' reads the first ' + resp.cap.bytes.toLocaleString('en-US') + ' bytes; this file is shorter.');
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
      if (!cur || (Date.parse(s.at) || 0) > (Date.parse(cur.at) || 0)) by.set(key, { ...s, install: inst.primary });
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
  const installs = sec('Installs', ul(g.installs.map((i) => escapeHtml([KIND_WORD[i.kind] || 'install', i.primary].join(' '))
    + (i.aliases.length ? escapeHtml(' — also saved as ' + i.aliases.join(', ')) : '')
    + (i.curator ? ' · <span class="cur-setup-mono">' + escapeHtml('Curator ' + i.curator) + '</span>' : ''))));
  const saves = newestSavesOf(g);
  let savesHtml;
  if (saves.length) {
    savesHtml = sec('Each tool’s newest save', ul(saves.map((s) => {
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
    savesHtml = sec('Saves', ul([escapeHtml((g.tools.length ? g.tools.join(', ') : 'No tool') + ' saved this project here')
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
      if (waiting !== null) syncLines.push(escapeHtml(waiting ? plural(waiting, 'file') + ' waiting on GitHub for this Mac.' : 'Nothing waiting on GitHub.'));
      syncLines.push(escapeHtml('Sync now pulls and pushes your whole knowledge folder — every domain.'));
    }
  } else {
    syncLines = [escapeHtml(g.waiting
      ? 'A newer handoff from it is waiting in your Personal Sync on GitHub. Sync now before you start the agent.'
      : 'Its saves reach this Mac after it syncs and you Sync now here. Its own sync time is not recorded here.')];
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
