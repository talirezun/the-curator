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
const ICON_CHEV = '<svg class="icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
    + '</tr>';
}

function toolsTable(data) {
  const tools = (data.tools || []).filter((t) => t && isStr(t.id));
  if (!tools.length) {
    return '<p class="mem-setup-empty">No agent tool has saved to this project or is set up on this computer.</p>';
  }
  return '<div class="mem-ws-wrap"><table class="mem-ws-table mem-setup-table">'
    + '<thead><tr><th scope="col">Tool</th><th scope="col">Status</th><th scope="col">Last saved</th>'
    + '<th scope="col">Saved from</th><th scope="col">On this computer</th></tr></thead>'
    + '<tbody>' + tools.map((t) => toolRow(t, data)).join('') + '</tbody></table></div>'
    + '<div class="mem-ws-count">Last saved is this project’s record from every computer; the rest reads this computer. Press a tool for its evidence.</div>';
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
 * ONE cfg, for both `renderListboxHtml` and `mountListbox` (memory.js calls
 * both with it). Groups "Known tools" / "Other"; "Custom tool…" is an ACTION
 * row (it opens a name field and never becomes the control's value). A
 * v3.77.0 server sends no groups and no custom row: every option is a known
 * tool and there is no custom row to offer. Pure.
 */
export function setupToolPickerCfg(data, busy = false) {
  const addable = Array.isArray(data && data.addable) ? data.addable.filter((a) => a && isStr(a.id)) : [];
  const known = addable.filter((a) => a.id !== CUSTOM_TOOL_VALUE && a.group !== 'other');
  const other = addable.filter((a) => a.id !== CUSTOM_TOOL_VALUE && a.group === 'other');
  const custom = addable.find((a) => a.id === CUSTOM_TOOL_VALUE) || null;
  const opt = (a, group) => ({
    value: a.id,
    label: isStr(a.label) ? a.label : a.id,
    group,
    detail: a.measured === false ? 'config location not measured' : (isStr(a.detail) ? a.detail : ''),
  });
  const options = [...known.map((a) => opt(a, 'Known tools')), ...other.map((a) => opt(a, 'Other'))];
  if (custom) {
    options.push({ value: CUSTOM_TOOL_VALUE, label: isStr(custom.label) ? custom.label : 'Custom tool…', group: 'Other',
      detail: isStr(custom.detail) ? custom.detail : 'name it, point it at The Curator', action: true });
  }
  return {
    id: 'mem-setup-add',
    value: null,
    placeholder: '+ Add a tool',
    triggerText: busy ? 'Adding…' : '+ Add a tool',
    ariaLabel: 'Add an agent tool to check on this computer',
    disabled: busy === true || options.length === 0,
    triggerClass: 'btn btn-secondary btn-xs',
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

/** The buttons one to-fix item carries. Pure. */
export function fixButtons(f, repo) {
  const fix = f && f.fix ? f.fix : {};
  const out = [];
  if (fix.kind === 'copy-block') out.push(btn2('copy-block', 'Copy block' + (isStr(f.file) ? ' for ' + f.file : '')));
  if (fix.kind === 'copy-marker') out.push(btn2('copy-marker', 'Copy marker line'));
  if (fix.kind === 'copy-command' && isStr(fix.command)) out.push(btn2('copy-command', 'Copy command', ' data-cmd="' + escapeHtml(fix.command) + '"'));
  if (fix.kind === 'sync') out.push(btn2('sync', 'Sync now'));
  if (fix.kind === 'change-repo') out.push(btn2('change-repo', 'Change folder'));
  // v3.78.0: a reveal carries its ABSOLUTE path and its own label (contract §1).
  if (fix.kind === 'reveal' && isStr(fix.path)) {
    out.push(btn2('reveal', isStr(fix.label) ? fix.label : 'Reveal ' + baseName(fix.path), ' data-path="' + escapeHtml(fix.path) + '"'));
  } else {
    const revealName = fix.reveal || (fix.kind === 'reveal' ? f.file : null);
    if (isStr(revealName) && repo && isStr(repo.path)) {
      out.push(btn2('reveal', 'Reveal ' + revealName, ' data-path="' + escapeHtml(repo.path.replace(/\/+$/, '') + '/' + revealName) + '"'));
    }
  }
  if (fix.kind === 'settings' || fix.kind === 'skills' || (fix.kind === 'reveal' && isStr(f.tool) && isStr(fix.path))) {
    out.push(btnG('settings', 'Open Tools on this Mac'));
  }
  if (fix.kind === 'skills') out.push(ZIPS);
  return out.join('');
}

/** Escaped text, with every `~/…` path set in mono. */
function withPaths(text) {
  return escapeHtml(text).replace(/(~\/[^\s]*[^\s.,;:!?)])/g, '<span class="mem-setup-inline-path">$1</span>');
}

function noteHtml(iconSvg, textHtml, buttonsHtml, cls = '', attrs = '') {
  return '<div class="tx-note mem-ss-note mem-setup-note' + (cls ? ' ' + cls : '') + '"' + attrs + '>' + iconSvg
    + '<span>' + textHtml + '</span>'
    + (buttonsHtml ? '<span class="mem-k-doors mem-setup-note-acts">' + buttonsHtml + '</span>' : '')
    + '</div>';
}

/** Every to-fix item as one loud line with its own fix. Pure. */
export function toFixNotes(data) {
  const toFix = Array.isArray(data && data.toFix) ? data.toFix.filter(Boolean) : [];
  return toFix.map((f, i) => noteHtml(ICON_TRI,
    withPaths(String(f.text || '')) + (isStr(f.detail) ? ' ' + withPaths(f.detail) : ''),
    fixButtons(f, data.repo), 'mem-setup-fix-note', ' data-setup-fix="' + i + '"')).join('');
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

function repoNotSetNote(data) {
  const cands = repoCandidatesOf(data);
  const lead = 'The repository folder is not set on this computer, so ' + repoCheckedFiles(data) + ' were not checked.';
  if (cands.length === 1) {
    return noteHtml(ICON_CIRC, escapeHtml(lead) + ' Found: <span class="mem-setup-inline-path">' + escapeHtml(cands[0].display) + '</span>',
      btn2('use-repo', 'Use ' + cands[0].display, ' data-path="' + escapeHtml(cands[0].path) + '"'), 'mem-setup-repo-note');
  }
  if (cands.length > 1) {
    return noteHtml(ICON_CIRC, escapeHtml(lead + ' ' + cands.length + ' folders were found for it.'),
      btn2('choose-repo', 'Choose a folder'), 'mem-setup-repo-note');
  }
  return noteHtml(ICON_CIRC, escapeHtml(lead), btn2('choose-repo', 'Set the folder'), 'mem-setup-repo-note');
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
    + '<div class="mem-ws-count">Kept on this computer only, never synced.'
    + (ui.pickUnavailable ? ' ' + escapeHtml(ui.pickUnavailable) : '') + '</div>';
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
  const rows = [{ name: '.curator-project', state: marker.state, word: marker.word, readBy: 'agents and hooks', path: root }];
  const files = new Map();
  for (const t of data.tools || []) {
    for (const f of (t && t.block && t.block.files) || []) {
      if (!f || !isStr(f.name)) continue;
      const cur = files.get(f.name) || { ...f, tools: [] };
      cur.tools.push(t.label);
      files.set(f.name, cur);
    }
  }
  for (const f of files.values()) {
    const s = !f.present ? { state: 'none', word: 'no such file' }
      : !f.hasBlock ? { state: 'fix', word: 'no Curator block' }
        : f.wrongProject ? { state: 'fix', word: 'names ' + f.namesProject }
          : !f.current ? { state: 'fix', word: 'block outdated' }
            : { state: 'ok', word: f.atTop ? 'block current · at the top' : 'block current' };
    rows.push({ name: f.name, ...s, readBy: f.tools.join(', '), path: root + '/' + f.name });
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
        + '<td class="mem-ws-cell-name"><span class="mem-setup-name">' + escapeHtml(x.name) + '</span></td>'
        + '<td>' + st(x.state, x.word) + '</td>'
        + '<td class="mem-ws-cell-who">' + escapeHtml(x.readBy || '—') + '</td>'
        + '<td class="mem-ws-cell-act">' + btnG('reveal', 'Reveal', ' data-path="' + escapeHtml(x.path) + '"'
          + ' aria-label="' + escapeHtml('Reveal ' + x.name + ' in Finder') + '"') + '</td>'
        + '</tr>').join('')
      + '</tbody></table></div>';
  const count = '<div class="mem-ws-count"><span class="mem-setup-inline-path">' + escapeHtml(r.display || r.path) + '</span>'
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
      + groups.map((g) => {
        const line = installsLine(g);
        return '<tr class="mem-ws-row">'
          + '<td class="mem-ws-cell-name"><span class="mem-setup-name">' + freshDot(g.at)
            + '<span class="mem-ws-machine">' + escapeHtml(g.name) + '</span>'
            + (g.thisComputer ? '<span class="mem-ws-mine">this computer</span>' : '') + '</span>'
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
    count = '<div class="mem-ws-count">' + escapeHtml(bits.join(' ')) + checked + '</div>';
    doors = btn2('sync', 'Sync now') + (waiting === null ? btnG('check-github', 'Check GitHub') : '') + btnG('open-sync', 'Open Sync');
  } else {
    count = '<div class="mem-ws-count">Personal Sync is not set up on this computer, so other computers’ saves do not reach it.</div>';
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
    + '<span class="mem-fold-meta">' + escapeHtml(meta) + '</span>'
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
    ? noteHtml(ICON_TRI, escapeHtml('The last re-check did not finish: ' + s.error + '. What is shown is the reading before it.'), btnG('check', 'Re-check'))
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

/**
 * The reader payload for one tool, or null. `hideBacklinks`: a tool is not a
 * wiki page, and "BACKLINKS · 0" under it would be a reading about nothing.
 * Pure.
 */
export function toolReaderContent(data, toolId) {
  const t = ((data && data.tools) || []).find((x) => x && x.id === toolId);
  if (!t) return null;
  const s = toolStatus(t, data);
  const fixes = (data.toFix || []).filter((f) => f && f.tool === t.id);
  const notes = fixes.map((f) => noteHtml(ICON_TRI,
    withPaths(String(f.text || '')) + (isStr(f.detail) ? ' ' + withPaths(f.detail) : ''), fixButtons(f, data.repo), 'mem-setup-fix-note')).join('');
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
      + '<span class="mem-k-doors">' + btn2('copy-snippet', 'Copy entry', ' data-tool="' + escapeHtml(t.id) + '"') + '</span></section>'
    : '';
  const instr = isStr(t.instructionFile)
    ? '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">Instruction file</h3><p class="mem-setup-ev-p">'
      + escapeHtml(t.label + ' reads ' + t.instructionFile + ' at the top of the repository. Paste the agent instructions block at its very top.')
      + '</p><span class="mem-k-doors">' + btn2('copy-block', 'Copy block for ' + t.instructionFile) + '</span></section>'
    : '';
  const zipLinks = Array.isArray(t.skillZips) && t.skillZips.some((z) => z && isStr(z.href) && z.href.startsWith('/api/setup/skills/'))
    ? t.skillZips.filter((z) => z && isStr(z.href) && z.href.startsWith('/api/setup/skills/'))
      .map((z) => '<a class="btn btn-ghost btn-xs" href="' + escapeHtml(z.href) + '" download>' + escapeHtml(isStr(z.name) ? z.name : baseName(z.href)) + '</a>').join('')
    : ZIPS;
  const zips = t.custom === true || parts.skills.state === 'cant-check' || parts.skills.state === 'fix'
    ? '<section class="mem-setup-ev"><h3 class="mem-setup-ev-h">Skill downloads</h3><p class="mem-setup-ev-p">The two skills this app carries, to install in the tool’s own skills folder.</p>'
      + '<span class="mem-k-doors">' + zipLinks + '</span></section>'
    : '';
  // Only a tool the owner ADDED can be removed (a saved-only unknown tool is
  // `custom` too, amendment A2, but is not on this computer's list).
  const remove = t.custom === true && t.userAdded !== false
    ? '<span class="mem-k-doors">' + btnG('remove-custom', 'Remove ' + t.label, ' data-name="' + escapeHtml(t.label) + '"') + '</span>'
    : '';
  const bodyHtml = '<div class="mem-setup-reader">'
    + '<p class="mem-setup-ev-status">' + st(s.state, s.word) + '</p>'
    + notes + ev + snippet + instr + zips + remove
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
