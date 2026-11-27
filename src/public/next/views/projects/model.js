// views/projects/model.js — WHAT the Projects page says, decided once (phase 2
// of the Simple/Pro redesign, 2026-11-27; CONTRACT-projects-v2).
//
// DOM-FREE AND PURE: an offline suite imports this file in plain Node
// (scripts/test-projects-page.js) and drives every decision with data. The
// view (views/memory.js) owns the state, the requests and the listeners; this
// module turns the data it already fetched into plain models; page.js turns
// the models into kit markup.
//
// ── ONE MODEL, TWO LAYOUTS (owner decision D1) ─────────────────────────────
// Every function here is mode-free: Simple and Pro are drawn from the SAME
// models, so a warning, a status, a count or an action can never exist in
// one mode only. Where Pro shows more it shows more COLUMNS of the same rows.
//
// ── THE STATUS VOCABULARY IS CLOSED (D9) ───────────────────────────────────
// A harness's state is one of shared/status.js's kinds. The mapping from
// views/setup-step.js's `harnessRowModel` (the v4.2.0 source of truth, kept):
//   fix        → needs-you   "Needs you"
//   not-here   → off         "Not connected"  (saved elsewhere, not set up here)
//   steps      → off when it is not connected here yet, else needs-you
//   ready      → ready       "Ready"
// A check that has not answered yet is `working`; one that failed with no
// earlier reading is `unknown`.

import { fmtAge, fmtCount, fmtSize, fmtTokens } from '../../shared/format.js';
import {
  harnessRowModel, toolGuideSteps, toolParts, physicalOf, removableOf, machineNamesOf,
} from '../setup-step.js';

const isStr = (v) => typeof v === 'string' && v.length > 0;
const plural = (n, one, many) => fmtCount(n) + ' ' + (n === 1 ? one : (many || one + 's'));

// ── small text helpers ────────────────────────────────────────────────────

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&nbsp;': ' ' };
/** Markup → its visible text (setup-step.js builds some lines as HTML). */
export function plainText(html) {
  return String(html == null ? '' : html)
    .replace(/<span class="visually-hidden">[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|#039|nbsp);/g, (m) => ENT[m] || m)
    .replace(/\s+/g, ' ')
    .trim();
}

/** "A. B. C." → ["A.", "B. C."] — the first sentence and the rest. */
export function firstSentence(text) {
  const t = String(text || '').trim();
  const m = /^(.+?[.!?])(\s+)(\S[\s\S]*)$/.exec(t);
  return m ? [m[1], m[3]] : [t, ''];
}

/**
 * Every <button> in a piece of setup-step.js markup, as kit action specs
 * ({label, attrs}): its words and its data-* attributes, which are what the
 * view's delegated listeners (`bindSetup`) key on. Links (a skill .zip) are
 * not buttons and are left out — the harness's reader still offers them.
 */
export function buttonSpecs(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const attrs = {};
    m[1].replace(/\s(data-[a-z0-9-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = plainText(v); return ''; });
    const label = plainText(m[2]);
    if (label && Object.keys(attrs).length) out.push({ label, attrs });
  }
  return out;
}

// ── the clock ─────────────────────────────────────────────────────────────

/**
 * A save row's clock in seconds, or null — the same order as memory.js's
 * `effectiveSave` (the agent's own `writtenAt` first, then the file's time).
 * The view passes `effectiveSave` itself as `secondsOf`; this default exists
 * so the suite can drive the model without the view.
 */
export function saveSeconds(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return null;
  const secs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const stamp = (s) => {
    const t = isStr(s) ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
  };
  const w = stamp(row.writtenAt) ?? secs(row.writtenAgeSeconds);
  if (w !== null) return w;
  return stamp(row.savedAt || row.arrivedAt || row.lastWriteAt || null) ?? secs(row.ageSeconds);
}

/** The newest (scope, machine) pair in a project read's scope list, or null. */
export function newestScope(scopes, secondsOf = saveSeconds) {
  let best = null; let bestAge = null;
  for (const s of (Array.isArray(scopes) ? scopes : [])) {
    if (!s) continue;
    const age = secondsOf(s);
    if (age === null) continue;
    if (bestAge === null || age < bestAge) { best = s; bestAge = age; }
  }
  return best;
}

// ── harnesses (the Agents tab, and the header's sentence) ─────────────────

/** The harness's label, never empty. */
const labelOf = (t) => (t && (isStr(t.label) ? t.label : t.id)) || 'agent';

/**
 * ONE ROW'S MODEL for a harness: the kit chip kind, one plain meta line, one
 * action spec and the id that opens its setup steps. Built on
 * `harnessRowModel` (v4.2.0), so the count a row says is the count its
 * reader opens on (guideTally).
 */
export function harnessRow(t, data) {
  const m = harnessRowModel(t, data);
  const { steps } = toolGuideSteps(t, data);
  const connected = !!(steps[0] && steps[0].state === 'done');
  let kind;
  if (m.status === 'fix') kind = 'needs-you';
  else if (m.status === 'not-here') kind = 'off';
  else if (m.status === 'steps') kind = connected ? 'needs-you' : 'off';
  else kind = 'ready';
  const fixLines = Number.isInteger(m.fixLines) ? m.fixLines : 0;
  const lines = (m.lines || []).slice(fixLines).map(plainText).filter(Boolean);
  // A row whose to-fix lines are said in full in the notices under the list
  // names the first one in its meta, so the row reads alone too.
  const meta = (fixLines
    ? [firstSentence(plainText(m.lines[0]))[0]].concat(lines)
    : (m.status === 'steps' ? [m.word].concat(lines) : lines)).join(' · ');
  let action = buttonSpecs(m.action)[0] || null;
  if (!action && m.status !== 'ready') {
    action = { label: 'Open its steps', attrs: { 'data-setup-act': 'tool-open', 'data-tool': t.id } };
  }
  return {
    id: t.id,
    label: labelOf(t),
    kind,
    status: m.status,
    word: m.word,
    meta,
    action,
    connected,
    removable: removableOf(t).ok,
    targetId: 'mem-setup-tool-' + t.id,
  };
}

/** Every harness on the project's list, as rows. Empty array when none. */
export function harnessRows(data) {
  const tools = ((data && data.tools) || []).filter((t) => t && isStr(t.id));
  return tools.map((t) => harnessRow(t, data));
}

/**
 * EVERY TO-FIX LINE AS A KIT NOTICE (both modes — a warning never folds).
 * Title: the line's own first sentence; line: the rest plus its detail;
 * actions: its first fix and, when it names a harness, "Open its steps".
 */
export function toFixNotices(data) {
  const toFix = Array.isArray(data && data.toFix) ? data.toFix.filter(Boolean) : [];
  const tools = ((data && data.tools) || []).filter(Boolean);
  return toFix.map((f) => {
    const text = plainText(String(f.text || ''));
    const [title, rest] = firstSentence(text);
    const detail = plainText(String(f.detail || ''));
    const t = isStr(f.tool) ? tools.find((x) => x && x.id === f.tool) : null;
    const fixes = Array.isArray(f.fixes) ? f.fixes : [];
    const actions = [];
    // The fix buttons setup-step.js would draw for this line (its own words).
    for (const fx of fixes) {
      if (actions.length) break;
      if (!fx || typeof fx !== 'object') continue;
      const spec = fixSpec(fx, t);
      if (spec) actions.push(spec);
    }
    if (t) actions.push({ label: 'Open its steps', attrs: { 'data-setup-act': 'tool-open', 'data-tool': t.id } });
    return {
      tone: 'attention',
      title: title || 'Something needs a fix',
      line: [rest, detail].filter(Boolean).join(' '),
      actions: actions.slice(0, 2),
      tool: t ? t.id : null,
      kind: isStr(f.kind) ? f.kind : null,
    };
  });
}

/** One fix kind → a kit action (the kinds setup-step.js's fixButton knows). */
function fixSpec(fx, t) {
  const tool = t ? { 'data-tool': t.id } : {};
  const label = (d) => (isStr(fx.label) && !/^Open Tools on this /.test(fx.label) ? fx.label : d);
  switch (fx.kind) {
    case 'copy-block': return { label: 'Copy agent instructions', attrs: { 'data-setup-act': 'copy-block' } };
    case 'copy-marker': return { label: label('Copy marker line'), attrs: { 'data-setup-act': 'copy-marker' } };
    case 'copy-command': return isStr(fx.command)
      ? { label: label('Copy command'), attrs: { 'data-setup-act': 'copy-command', 'data-cmd': fx.command, 'data-cwd': isStr(fx.cwdDisplay) ? fx.cwdDisplay : '' } }
      : null;
    case 'copy-snippet': return { label: label('Copy MCP entry'), attrs: { 'data-setup-act': 'copy-snippet', ...tool } };
    case 'sync': return { label: 'Sync now', attrs: { 'data-setup-act': 'sync' } };
    case 'settings': return { label: label('Open Settings › MCP bridge'), attrs: { 'data-setup-act': 'settings' } };
    case 'choose-repo': return { label: label('Set the folder'), attrs: { 'data-setup-act': 'choose-repo' } };
    default: return null;
  }
}

/** How many harnesses want something from the owner (the header's sentence). */
export function harnessesNeedingYou(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.kind !== 'ready');
}

/** The names a payload uses for THIS computer (its install names). */
export function thisComputerNames(data) {
  const names = new Set();
  for (const g of physicalOf(data)) {
    if (!g.thisComputer) continue;
    for (const i of g.installs) {
      if (isStr(i.primary)) names.add(i.primary);
      for (const a of i.aliases || []) if (isStr(a)) names.add(a);
    }
  }
  return names;
}

// ── the header ────────────────────────────────────────────────────────────

/**
 * THE ONE STATUS SENTENCE, from real state only. `machineWord` is "Mac" / "PC"
 * / "computer"; `machineName(raw)` turns a raw machine id into its display
 * name. Returns '' when nothing has been read.
 *
 *   "Claude Code saved a note 27 min ago on this Mac. Antigravity needs one step from you."
 *   "No agent has saved here yet. Connect one to start."
 */
export function statusSentence(o) {
  const opts = o || {};
  const read = opts.read;
  if (!read) return '';
  const scopes = Array.isArray(read.scopes) ? read.scopes : [];
  const newest = newestScope(scopes, opts.secondsOf || saveSeconds);
  const rows = Array.isArray(opts.harnessRows) ? opts.harnessRows : null;
  const parts = [];
  if (!newest) {
    parts.push('No agent has saved here yet.');
    parts.push(rows && rows.some((r) => r.connected) ? 'Ask one to save where you are.' : 'Connect one to start.');
    return parts.join(' ');
  }
  const who = (isStr(newest.harnessLabel) && newest.harnessLabel) || (isStr(newest.harness) && newest.harness) || 'An agent';
  const secs = (opts.secondsOf || saveSeconds)(newest);
  const age = secs === null ? null : fmtAge(Date.now() - secs * 1000);
  const here = opts.thisNames instanceof Set && isStr(newest.machine) ? opts.thisNames.has(newest.machine) : null;
  const where = here === true ? 'on this ' + (opts.machineWord || 'computer')
    : isStr(newest.machine) ? 'on ' + (typeof opts.machineName === 'function' ? opts.machineName(newest.machine) : newest.machine)
      : '';
  parts.push([who, 'saved a note', age, where].filter(Boolean).join(' ') + '.');
  if (rows) {
    const need = harnessesNeedingYou(rows).filter((r) => r.kind === 'needs-you');
    if (need.length === 1) parts.push(need[0].label + ' needs one step from you.');
    else if (need.length > 1) parts.push(fmtCount(need.length) + ' agents need a step from you.');
  }
  if (opts.readonly) parts.push('This is a read-only Shared Brain mirror.');
  return parts.join(' ');
}

/** The "continue" prompt the Now tab copies (one short instruction). */
export function continuePrompt(domain, project) {
  return 'Load the project context for "' + String(project || '') + '" in the "' + String(domain || '')
    + '" domain from The Curator (get_project_context), read the latest handoff, and continue where the last agent left off.';
}

// ── the Now tab ───────────────────────────────────────────────────────────

/**
 * Split a handoff document into its title and body, by the store's own
 * preamble rule (memory.js splitHandoffPreamble is passed in so the two can
 * never disagree).
 */
export function handoffParts(text, split) {
  const s = typeof split === 'function' ? split(String(text || '')) : { headline: '', body: String(text || '') };
  return { title: s.headline || '', body: s.body || '' };
}

/**
 * THE NOW TAB'S WARNINGS, as kit notice specs. Every warning today's Memory
 * step and handoff reader showed is here, in both modes (D1 never-hide).
 *
 * `f` carries facts memory.js already computes:
 *   readonly, staleWrite, lastSaveKind, lastSaveNote, sharedHandoffs:[{scope, who}],
 *   elsewhere:{machine, scope, age}|null, newer:{scope, machine, age}|null,
 *   unlisted:{count, machines, reason}|null, truncated, sanitised
 */
export function nowNotices(f) {
  const o = f || {};
  const out = [];
  if (o.readonly) {
    out.push({ tone: 'info', title: 'This is a read-only Shared Brain mirror.',
      line: 'What you read here can have been written by someone else on your cohort.' });
  }
  if (o.staleWrite) {
    out.push({ tone: 'attention', title: 'An agent saved here since you opened this page.',
      line: 'What is shown may not be the latest.', actions: [{ label: 'Reload', attrs: { 'data-prj-act': 'reload' } }] });
  }
  if (o.lastSaveKind === 'trimmed') {
    out.push({ tone: 'error', title: 'Part of the last handoff did not survive the save.',
      line: 'Content was dropped or cut short before it was written. Ask the agent to save it again.'
        + (o.lastSaveNote ? ' ' + o.lastSaveNote : '') });
  } else if (o.lastSaveKind === 'clipped') {
    out.push({ tone: 'info', title: 'The last handoff’s summary or a label was shortened.',
      line: 'Nothing in the handoff was lost. It clears on the next save that fits.'
        + (o.lastSaveNote ? ' ' + o.lastSaveNote : '') });
  } else if (o.lastSaveKind === 'replaced') {
    out.push({ tone: 'info', title: 'The last save replaced a larger handoff.',
      line: 'Nothing the agent sent was lost, but the longer document it overwrote cannot be recovered.'
        + (o.lastSaveNote ? ' ' + o.lastSaveNote : '') });
  }
  for (const s of (Array.isArray(o.sharedHandoffs) ? o.sharedHandoffs : []).slice(0, 3)) {
    out.push({ tone: 'error', title: 'Two agents are writing the same handoff.',
      line: (s.who ? s.who + ' have both' : 'They have both') + ' saved into ' + s.scope
        + ', and a save overwrites. Give each agent its own handoff; the History keeps both trails.' });
  }
  if (o.elsewhere) {
    out.push({ tone: 'attention', title: o.elsewhere.machine + ' saved after this computer.',
      line: o.elsewhere.scope + ', ' + (o.elsewhere.age || 'unknown age') + '. Sync now before you continue, or that work waits there.',
      actions: [{ label: 'Sync now', attrs: { 'data-setup-act': 'sync' } }] });
  }
  if (o.newer) {
    out.push({ tone: 'info', title: 'There is newer state in this project.',
      line: o.newer.scope + (o.newer.machine ? ' on ' + o.newer.machine : '') + ' — ' + (o.newer.age || 'unknown age') + '.' });
  }
  if (o.unlisted) {
    out.push({ tone: 'attention', title: 'Some state here is on disk but is not being read.',
      line: o.unlisted.reason || '' });
  }
  if (o.truncated) {
    out.push({ tone: 'attention', title: 'This handoff is longer than the state budget.',
      line: 'The tail is not shown. The file is complete up to that budget; nothing below it was written.' });
  }
  if (o.sanitised) {
    out.push({ tone: 'info', title: 'Protocol-shaped text in this handoff was neutralised on read.',
      line: 'The words are unchanged; only their markup is.' });
  }
  return out;
}

/** The handoff card's footer facts: harness · computer · age (plain). */
export function handoffFooter(o) {
  const x = o || {};
  return [x.harness, x.computer, x.age].filter(isStr).join(' · ');
}

/**
 * "Earlier notes": the next few saved copies after the one on the card,
 * newest first. `order` is memory.js's workStreamOrder (passed in).
 */
export function earlierNotes(scopes, shown, o = {}) {
  const list = (Array.isArray(scopes) ? scopes : []).filter(Boolean)
    .filter((s) => !(shown && s.scope === shown.scope && (s.machine || null) === (shown.machine || null)));
  const secs = o.secondsOf || saveSeconds;
  list.sort((a, b) => {
    const x = secs(a); const y = secs(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return x - y;
  });
  const limit = Number.isInteger(o.limit) ? o.limit : 4;
  return list.slice(0, limit).map((s) => {
    const sec = secs(s);
    return {
      scope: s.scope,
      machine: s.machine || null,
      title: (isStr(s.headline) && s.headline) || s.scope,
      meta: [(isStr(s.harnessLabel) && s.harnessLabel) || (isStr(s.harness) && s.harness) || null,
        typeof o.machineName === 'function' && isStr(s.machine) ? o.machineName(s.machine) : (s.machine || null),
        sec === null ? null : fmtAge(Date.now() - sec * 1000)].filter(Boolean).join(' · '),
    };
  });
}

/**
 * THE CONNECT CHECKLIST (until the first save) — the ONLY numbering on the
 * page. Four steps; a step is done from real readings only.
 */
export function connectChecklist(o) {
  const x = o || {};
  const rows = Array.isArray(x.harnessRows) ? x.harnessRows : [];
  const tools = ((x.setup && x.setup.tools) || []).filter(Boolean);
  const connected = rows.some((r) => r.connected);
  const told = tools.some((t) => toolParts(t).block.state === 'ok');
  return [
    { key: 'create', title: 'Create the project', line: '', done: true },
    { key: 'connect', title: 'Connect an agent',
      line: 'Pick Claude Code, Cursor, Codex… The Curator sets it up and shows what it changed.',
      done: connected, action: connected ? null : { label: 'Connect', attrs: { 'data-prj-act': 'connect' }, primary: true } },
    { key: 'tell', title: 'Tell it about this project',
      line: 'One paste into your project’s instruction file.',
      done: told, action: told ? null : { label: 'Copy agent instructions', attrs: { 'data-setup-act': 'copy-block' } } },
    { key: 'save', title: 'Open your agent and say “save where we are”',
      line: 'The first note appears here.', done: false },
  ];
}

// ── the Starting kit tab ─────────────────────────────────────────────────

/** The read-first vocabulary on screen (on-disk values unchanged). */
export const START_WORDS = Object.freeze({
  'read-first': 'Always read',
  'on-request': 'When needed',
  'not-at-start': 'Hidden',
});

/** "9 · 2 always read, 7 when needed" — the Documents row's meta. */
export function documentsMeta(facts) {
  const f = facts || {};
  const n = Number.isInteger(f.count) ? f.count : 0;
  if (!n) return 'No documents yet — add the ones every agent should know.';
  const rf = Number.isInteger(f.readFirstCount) ? f.readFirstCount : 0;
  const hidden = Number.isInteger(f.hiddenCount) ? f.hiddenCount : 0;
  const onReq = Math.max(0, n - rf - hidden);
  return [plural(n, 'document'), [rf ? fmtCount(rf) + ' always read' : null,
    onReq ? fmtCount(onReq) + ' when needed' : null, hidden ? fmtCount(hidden) + ' hidden' : null]
    .filter(Boolean).join(', ')].filter(Boolean).join(' · ');
}

/** The Brief row's meta: "3,038 words" or "Not written yet". */
export function briefMeta(o) {
  const x = o || {};
  if (!x.present) return 'Not written yet — your standing instructions for every agent.';
  const words = Number.isInteger(x.words) ? x.words : 0;
  return 'Your standing instructions for every agent · ' + plural(words, 'word');
}

/**
 * THE ONE BAR (Simple): "The starting kit uses N% of your agent's memory" and
 * a plain qualifier. `tokens` is what an agent receives at start, `window`
 * the context window it is drawn against. Null until measured.
 */
export function kitBudgetFigure(tokens, windowTokens) {
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(windowTokens) || windowTokens <= 0) return null;
  const pct = (tokens / windowTokens) * 100;
  const pctWord = pct > 0 && pct < 1 ? 'less than 1%' : Math.round(pct) + '%';
  const qualifier = pct < 10 ? 'plenty of room left' : pct < 30 ? 'room left' : pct < 60 ? 'a large share' : 'most of the room';
  return {
    pct: Math.min(100, Math.max(0, pct)),
    words: 'The starting kit uses ' + pctWord + ' of your agent’s memory',
    qualifier,
    tokens: fmtTokens(tokens),
    window: fmtTokens(windowTokens),
  };
}

// ── the History tab (Pro) ─────────────────────────────────────────────────

/** One row per saved copy (work-stream × computer), the store's own unit. */
export function historyRows(scopes, o = {}) {
  const secs = o.secondsOf || saveSeconds;
  return (Array.isArray(scopes) ? scopes : []).filter(Boolean).map((s, i) => {
    const sec = secs(s);
    const harness = (isStr(s.harnessLabel) && s.harnessLabel) || (isStr(s.harness) && s.harness) || '';
    return {
      id: 'note:' + encodeURIComponent(s.scope || '') + ':' + encodeURIComponent(s.machine || ''),
      scope: s.scope,
      machine: s.machine || null,
      harness,
      model: isStr(s.model) ? s.model : '',
      headline: isStr(s.headline) ? s.headline : '',
      bytes: Number.isInteger(s.bytes) && s.bytes >= 0 ? s.bytes : null,
      seconds: sec,
      when: sec === null ? 'unknown' : fmtAge(Date.now() - sec * 1000),
      computer: typeof o.machineName === 'function' && isStr(s.machine) ? o.machineName(s.machine) : (s.machine || ''),
    };
  });
}

/** History filtered by a search text and a harness ('' = all). */
export function filterHistory(rows, q, harness) {
  const needle = String(q || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => (!harness || r.harness === harness)
    && (!needle || [r.scope, r.harness, r.model, r.headline, r.computer].join(' ').toLowerCase().includes(needle)));
}

/** The agent connections summary in plain words (History's figure row). */
export function connectionsSummary(capture) {
  const c = capture && capture.data ? capture.data : capture;
  const t = c && c.totals;
  if (!t || !Number.isInteger(t.sessions)) return null;
  const parts = [plural(t.sessions, 'agent connection')];
  if (Number.isInteger(t.read)) parts.push(fmtCount(t.read) + ' read this project at the start');
  if (Number.isInteger(t.saved)) parts.push(fmtCount(t.saved) + ' saved before stopping');
  if (Number.isInteger(t.readNoSave) && t.readNoSave > 0) parts.push(fmtCount(t.readNoSave) + ' read and did not save');
  return parts.join(' · ');
}

// ── the Agents tab (Pro): one row per harness per computer ────────────────

const PART_WORDS = { ok: 'yes', fix: 'needs a fix', 'cant-check': 'can’t check here', 'not-checked': 'not checked', unmeasured: 'not measured', none: 'no' };

/** A part cell's word on this computer. */
export function partWord(cell) {
  if (!cell) return 'unknown';
  if (cell.state === 'ok') return isStr(cell.word) ? cell.word : 'yes';
  return PART_WORDS[cell.state] || (isStr(cell.word) ? cell.word : 'unknown');
}

/**
 * The matrix: each harness on the list × each computer it saved from, plus
 * this computer. The checks (connected, skills, instructions, hooks) are read
 * on THIS computer only; on another computer they are "Unknown" — the app
 * cannot read another computer's files, and the cell says so instead of
 * guessing. `savesByTool` (the capture route's 7-day counts) is per harness.
 */
export function agentMatrix(data, o = {}) {
  const tools = ((data && data.tools) || []).filter((t) => t && isStr(t.id));
  const groups = physicalOf(data);
  const names = machineNamesOf(data);
  const saves7 = new Map();
  for (const s of ((o.savesByTool && o.savesByTool.tools) || [])) if (s && isStr(s.id)) saves7.set(s.id, s.events);
  const rows = [];
  for (const t of tools) {
    const parts = toolParts(t);
    const h = harnessRow(t, data);
    const savedHere = !!(t.saved && t.saved.thisMachine);
    const here = groups.find((g) => g.thisComputer) || null;
    rows.push({
      id: 'tool:' + t.id + ':here',
      tool: t.id,
      harness: labelOf(t),
      computer: 'this ' + (o.machineWord || 'computer'),
      kind: h.kind,
      connected: partWord(parts.mcp),
      skills: partWord(parts.skills),
      instructions: partWord(parts.block),
      hooks: partWord(parts.hooks),
      lastSave: savedHere ? t.saved.at : (here ? newestToolSave(here, t.id) : null),
      saves7: Number.isInteger(saves7.get(t.id)) ? saves7.get(t.id) : null,
      removable: h.removable,
      here: true,
    });
    for (const g of groups) {
      if (g.thisComputer) continue;
      const at = newestToolSave(g, t.id);
      if (!at) continue;
      rows.push({
        id: 'tool:' + t.id + ':' + rows.length,
        tool: t.id,
        harness: labelOf(t),
        computer: names.get(g.id) || g.name,
        kind: 'unknown',
        connected: 'unknown', skills: 'unknown', instructions: 'unknown', hooks: 'unknown',
        lastSave: at,
        saves7: null,
        removable: false,
        here: false,
      });
    }
  }
  return rows;
}

/** The newest save a computer group lists for one harness, or null. */
function newestToolSave(group, toolId) {
  let best = null;
  for (const i of (group && group.installs) || []) {
    for (const s of i.saves || []) {
      if ((s.tool || s.label) !== toolId && s.tool !== toolId) continue;
      if (!best || Date.parse(s.at) > Date.parse(best)) best = s.at;
    }
  }
  return best;
}

/** Per harness: one row per harness, the newest of its computers. */
export function agentMatrixPerHarness(rows) {
  const by = new Map();
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const prev = by.get(r.tool);
    if (!prev) { by.set(r.tool, { ...r, id: 'tool:' + r.tool + ':all', computers: 1 }); continue; }
    prev.computers += 1;
    if (r.lastSave && (!prev.lastSave || Date.parse(r.lastSave) > Date.parse(prev.lastSave))) prev.lastSave = r.lastSave;
  }
  return [...by.values()].map((r) => ({ ...r, computer: plural(r.computers, 'computer') }));
}

// ── the Computers tab (Pro) ───────────────────────────────────────────────

/** Computers and installs, plainly. */
export function computerRows(data) {
  return physicalOf(data).map((g, i) => ({
    id: 'c' + i,
    index: i,
    name: g.name + (g.thisComputer ? ' (this computer)' : ''),
    installs: g.installs.map((x) => x.display + (x.kind ? ' · ' + (x.kind === 'app' ? 'app' : 'from source') : '')).join(', '),
    harnesses: g.tools.join(', '),
    curator: g.curator || '',
    lastSave: g.at,
    waiting: g.waiting,
  }));
}

/** The three travel routes, said once (Computers tab). */
export const TRAVEL_ROUTES = Object.freeze([
  { what: 'Notes, the brief, documents and the wiki', how: 'Sync now' },
  { what: 'The instruction file and .curator-project', how: 'your project’s git' },
  { what: 'The agent connection, skills and hooks', how: 'set up on each computer' },
]);

// ── the sidebar ───────────────────────────────────────────────────────────

/** A sidebar row's meta: "<harness> · <age>", Pro adds the work-stream count. */
export function sidebarFigure(p, ageWords, pro) {
  const harness = (p && isStr(p.harnessLabel) && p.harnessLabel) || (p && isStr(p.harness) && p.harness) || '';
  const n = p && Number.isInteger(p.distinctScopeCount) ? p.distinctScopeCount
    : (p && Number.isInteger(p.scopeCount) ? p.scopeCount : null);
  return [harness || null, pro && n !== null ? plural(n, 'work-stream') : null].filter(Boolean).join(' · ');
}

/** Sizes on this page, one formatter (kit rule). */
export const size = (b) => (Number.isFinite(b) && b >= 0 ? fmtSize(b) : '—');
