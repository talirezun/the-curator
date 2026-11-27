// views/projects/page.js — the Projects page's MARKUP, composed only from the
// shared kit (phase 2 of the Simple/Pro redesign, CONTRACT-projects-v2).
//
// DOM-FREE: every function returns a string from a plain model (model.js), so
// scripts/test-projects-page.js renders the whole page in plain Node, in both
// modes, and compares them.
//
// ── WHAT THIS FILE MAY DRAW ─────────────────────────────────────────────────
// Rows (shared/row.js), status chips (shared/status.js), notices
// (shared/notice.js), tabs and segmented (shared/tabs.js), data tables
// (shared/table.js) and the page anatomy (shared/object-page.js). Its own
// classes (`prj-*`, views/projects/projects.css) are LAYOUT ONLY: a panel's
// stack, a card that holds a list, the handoff's reading column, the one bar,
// the numbered checklist. A `prj-` class that names a row, chip, note, table
// or fold is refused by scripts/test-projects-page.js (the kit guard).
//
// ── TRUSTED INPUTS ──────────────────────────────────────────────────────────
// A few model fields are TRUSTED markup the view composed: the handoff body
// (shared/markdown.js, escape-first), the "···" listbox and the pickers
// (shared/listbox.js), and the EMBEDDED FLOWS — the brief editor, the
// documents list with its add doors, the knowledge picker, the reading-plan
// helper, the meter, the repository field. Those flows are today's code,
// reused so every task still finishes in Simple; they are named in
// EMBEDDED_FLOWS below and wrapped in `prj-flow`, and their re-skin onto the
// kit is a later package (see the contract's builder amendment).
//
// ── NEVER-HIDE (owner decision D1) ──────────────────────────────────────────
// Simple and Pro draw the SAME notices from the SAME models: Simple's three
// tabs hold every warning, refusal, cost and outcome. A Pro-only tab
// (History, Budget, Computers) holds data and settings, never a notice that is
// not also in a Simple tab — scripts/test-projects-page.js renders both modes
// and fails on a notice that exists in Pro only.

import { objectPage } from '../../shared/object-page.js';
import { tabs, tabPanelAttrs, segmented } from '../../shared/tabs.js';
import { row } from '../../shared/row.js';
import { statusChip } from '../../shared/status.js';
import { notice } from '../../shared/notice.js';
import { table } from '../../shared/table.js';
import { fmtAge, fmtCount, fmtSize } from '../../shared/format.js';
import { CHECK_AGAIN, SYNC_NOW } from '../../shared/verbs.js';
import { explainerMark, explainerWordMark } from '../../shared/explainer.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const isStr = (v) => typeof v === 'string' && v.length > 0;

/** The tab strip's id prefix, and the tabs in order. */
export const TABS_ID = 'prj';
export const TAB_ITEMS = Object.freeze([
  { id: 'now', label: 'Now' },
  { id: 'agents', label: 'Agents' },
  { id: 'kit', label: 'Starting kit' },
  { id: 'history', label: 'History', pro: true },
  { id: 'budget', label: 'Budget', pro: true },
  { id: 'computers', label: 'Computers', pro: true },
]);
export const SIMPLE_TABS = Object.freeze(TAB_ITEMS.filter((t) => !t.pro).map((t) => t.id));
export const PRO_ONLY_TABS = Object.freeze(TAB_ITEMS.filter((t) => t.pro).map((t) => t.id));

/** The embedded flows (today's code, reused), by the model key that carries each. */
export const EMBEDDED_FLOWS = Object.freeze([
  'briefEditorHtml', 'documentsHtml', 'knowledgeHtml', 'plannerHtml', 'meterHtml',
  'sessionNoticesHtml', 'repoHtml', 'customHtml', 'pickerHtml', 'deleteHtml', 'budgetPickersHtml', 'kitBudgetPickerHtml',
  'receivesHtml', 'reachHtml', 'copyOutcomeHtml', 'mirrorsHtml',
]);

/**
 * ONE SENTENCE PER TAB (ANALYSIS §A3: "no one sentence per screen for a
 * teacher"), each with its "How this works" — the explainer that was the old
 * step's ⓘ (shared/explainers.js `context.*`), opened in place through the one
 * ⓘ mechanism. Explanation only: never a warning, cost or outcome.
 */
export const TAB_LEDES = Object.freeze({
  now: { text: 'Where the work stands — the note the last agent left.' },
  agents: { text: 'The agents that can open this project’s notes.' },
  kit: { text: 'What every agent reads before it does anything.' },
  history: { text: 'Every note any agent saved, in one table.' },
  budget: { text: 'How much of the agent’s window the starting kit takes.' },
  computers: { text: 'Which computers hold this project, and how each part reaches them.' },
});

/** The tab's one sentence and its explainer door(s). */
export function tabLede(tab) {
  const l = TAB_LEDES[tab];
  if (!l) return '';
  // Literal keys, one call each (scripts/test-explainer-adoption.js reads them).
  const W = 'How this works';
  const marks = tab === 'now' ? [explainerWordMark('prj-why-now', 'context.memory', W)]
    : tab === 'agents' ? [explainerWordMark('prj-why-agents', 'context.setup', W)]
      : tab === 'kit' ? [explainerWordMark('prj-why-kit', 'context.session-start', W),
        explainerWordMark('prj-why-docs', 'context.documents', 'About documents'),
        explainerWordMark('prj-why-knowledge', 'context.knowledge', 'About knowledge')]
        : tab === 'history' ? [explainerWordMark('prj-why-history', 'context.overview', W)]
          : tab === 'budget' ? [explainerWordMark('prj-why-budget', 'context.session-start', W)]
            : [explainerWordMark('prj-why-computers', 'context.setup', W)];
  return '<div class="prj-lede"><p class="prj-lede-text">' + esc(l.text) + '</p>'
    + marks.map((m) => m.btn).join('') + '</div>' + marks.map((m) => m.panel).join('');
}

/** The one quiet line under the tabs in Simple. */
export const MORE_IN_PRO_LINE = 'More in Pro: every save in a table, the token budget, your computers.';

const flow = (html, key) => (isStr(html) ? '<div class="prj-flow" data-prj-flow="' + esc(key) + '">' + html + '</div>' : '');
const h2 = (text, id) => '<h2 class="prj-h"' + (id ? ' id="' + esc(id) + '" tabindex="-1"' : '') + '>' + esc(text) + '</h2>';
const notices = (list) => (Array.isArray(list) ? list : []).map((n) => notice(n)).join('');
const card = (inner, label) => '<section class="prj-card"' + (label ? ' aria-label="' + esc(label) + '"' : '') + '>' + inner + '</section>';
const btn = (label, attrs, primary, id) => '<button type="button" class="btn btn-xs ' + (primary ? 'btn-primary' : 'btn-secondary') + '"'
  + (id ? ' id="' + esc(id) + '"' : '')
  + Object.keys(attrs || {}).filter((k) => /^(data|aria)-[a-z0-9-]+$/.test(k)).map((k) => ' ' + k + '="' + esc(attrs[k]) + '"').join('')
  + '>' + esc(label) + '</button>';

// ═══════════════════════════════════════════════════════════════════════════
// THE PAGE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The whole main column for one project.
 *   m = { pro, tab, kicker, title, identityDot, sentence, menuHtml, tilesHtml,
 *         counts: {agents, history, computers}, panelHtml }
 */
export function renderProjectsPage(m) {
  const pro = !!m.pro;
  const items = TAB_ITEMS.map((t) => ({ ...t,
    count: t.id === 'agents' ? m.counts && m.counts.agents
      : t.id === 'history' ? m.counts && m.counts.history
        : t.id === 'computers' ? m.counts && m.counts.computers : undefined }));
  const strip = tabs({ id: TABS_ID, label: 'Project', items, active: m.tab, pro });
  // What a project is (the old header's info mark, context.page), beside the menu.
  const pageInfo = explainerMark('prj-page-info', 'context.page', { here: 'agent-memory' });
  const quiet = pro ? '' : '<p class="prj-quiet">' + esc(MORE_IN_PRO_LINE)
    + ' <button type="button" class="prj-link" data-prj-act="pro-on">Turn on Pro ›</button></p>';
  const body = '<div class="prj-panel"' + tabPanelAttrs(TABS_ID, m.tab) + ' data-prj-panel="' + esc(m.tab) + '">' + tabLede(m.tab) + (m.panelHtml || '') + '</div>'
    + quiet;
  return '<div class="prj-page" data-prj-mode="' + (pro ? 'pro' : 'simple') + '">' + objectPage({
    identityDot: m.identityDot || '',
    kicker: m.kicker,
    title: m.title,
    statusSentence: m.sentence,
    primaryAction: '<button type="button" class="btn btn-primary" id="prj-connect" data-prj-act="connect">+ Connect an agent</button>',
    moreMenu: (m.menuHtml || '') + pageInfo.btn,
    // Pro's tile strip sits between the status sentence and the tabs (the
    // approved mockup): readings about the whole project, above every tab.
    strip: pro && m.tilesHtml ? m.tilesHtml : '',
    tabs: strip,
    body: pageInfo.panel + body,
  }) + '</div>';
}

/** A panel that has not got its data yet. */
export function loadingPanel(words) {
  return '<p class="prj-wait" aria-busy="true">' + esc(words || 'Reading…') + '</p>';
}

// ═══════════════════════════════════════════════════════════════════════════
// NOW
// ═══════════════════════════════════════════════════════════════════════════

/**
 * m = { notices, handoff: {title, bodyHtml, footer, saved, kindWord}|null,
 *       hasSave, checklist, earlier: [{scope, machine, title, meta, targetId?}],
 *       pro, proFacts: [{label, value}], journal: {rows}|null, path, error }
 */
export function nowPanel(m) {
  const out = [];
  out.push(notices(m.notices));
  if (m.error) out.push(notice({ tone: 'error', title: 'Could not read this project’s notes.', line: m.error }));
  if (!m.hasSave) {
    out.push(checklistHtml(m.checklist));
    return '<div class="prj-stack">' + out.join('') + '</div>';
  }
  if (m.handoff) {
    const h = m.handoff;
    const facts = m.pro && Array.isArray(m.proFacts) && m.proFacts.length
      ? table({ id: 'prj-now-facts', caption: 'About this note', columns: [{ id: 'k', label: 'Field' }, { id: 'v', label: 'Value' }],
        rows: m.proFacts.map((f, i) => ({ id: 'f' + i, cells: { k: f.label, v: f.value } })) })
      : '';
    out.push(card(
      '<header class="prj-card-head">'
        + '<div class="prj-card-titles">' + h2('Where the work stands', 'prj-now-h')
        + '<p class="prj-sub">The note the last agent left. The next agent you open reads this first.</p></div>'
        + btn('Copy “continue” prompt', { 'data-prj-act': 'copy-continue' }, false, 'prj-copy-continue')
      + '</header>'
      + '<article class="prj-handoff">'
        + (h.title ? '<h3 class="prj-handoff-title">' + esc(h.title) + '</h3>' : '')
        + '<div class="prj-handoff-body">' + (h.bodyHtml || '') + '</div>'
      + '</article>'
      + '<footer class="prj-card-foot">'
        // "Saved" is a fact, not one of the closed status words (D9), so it
        // is said in the footer's text rather than drawn as a chip.
        + '<span class="prj-foot-facts"><span class="prj-foot-text">Saved · ' + esc(h.footer || '') + '</span></span>'
        + '<button type="button" class="prj-link" data-prj-act="open-note"' + (h.targetId ? ' id="' + esc(h.targetId) + '"' : '') + '>Open the full note ›</button>'
        + (h.deleteScope ? '<button type="button" class="btn btn-ghost btn-xs" data-ws-delete="' + esc(h.deleteScope) + '" aria-label="' + esc('Delete handoff ' + h.deleteScope + '…') + '">Delete…</button>' : '')
      + '</footer>'
      + facts,
      'The latest note'));
    if (m.pro && m.journal && Array.isArray(m.journal.rows) && m.journal.rows.length) {
      out.push(card('<header class="prj-card-head">' + h2('This work-stream’s journal') + '</header>'
        + table({ id: 'prj-journal', columns: [
          { id: 'when', label: 'When' }, { id: 'harness', label: 'Harness' }, { id: 'model', label: 'Model' },
          { id: 'headline', label: 'Headline' }],
        rows: m.journal.rows }) + (m.journal.moreHtml || ''), 'Journal'));
    }
  }
  if (Array.isArray(m.earlier) && m.earlier.length) {
    out.push(card('<header class="prj-card-head">' + h2('Earlier notes') + '</header>'
      + '<div class="prj-list">' + m.earlier.map((e, i) => row({
        id: 'note:' + encodeURIComponent(e.scope || '') + ':' + encodeURIComponent(e.machine || ''), title: e.title, meta: e.meta, opens: true, targetId: e.targetId,
      })).join('') + '</div>', 'Earlier notes'));
  }
  out.push(flow(m.deleteHtml, 'deleteHtml'));
  return '<div class="prj-stack">' + out.join('') + '</div>';
}

/** The connect checklist — the only numbering on the page. */
export function checklistHtml(items) {
  const list = Array.isArray(items) ? items : [];
  return card('<header class="prj-card-head"><div class="prj-card-titles">' + h2('Three steps, then your agent remembers', 'prj-check-h')
      + '<p class="prj-sub">No agent has saved a note here yet.</p></div></header>'
    + '<ol class="prj-steps">' + list.map((it, i) => '<li class="prj-step' + (it.done ? ' is-done' : '') + '" data-prj-step="' + esc(it.key) + '">'
      + '<span class="prj-step-num" aria-hidden="true">' + (it.done ? '✓' : String(i + 1)) + '</span>'
      + '<span class="prj-step-text"><span class="prj-step-title">' + esc(it.title)
        + (it.done ? '<span class="visually-hidden"> — done</span>' : '') + '</span>'
        + (it.line ? '<span class="prj-step-line">' + esc(it.line) + '</span>' : '') + '</span>'
      + (it.action ? btn(it.action.label, it.action.attrs, it.action.primary) : '')
      + '</li>').join('') + '</ol>', 'Connect checklist');
}

// ═══════════════════════════════════════════════════════════════════════════
// AGENTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * m = { pro, state: 'loading'|'error'|'ok', error, rows, notices, checkedAt,
 *       pickerHtml, customHtml, repoHtml, unsynced, recheckError,
 *       matrix: {rows, view, computer, computers, filter} }
 */
export function agentsPanel(m) {
  const out = [];
  const head = '<div class="prj-toolbar">'
    + (m.pro ? '<input type="search" class="prj-search" id="prj-agents-filter" data-prj-filter="agents" placeholder="Filter…" aria-label="Filter agents" value="' + esc(m.matrix && m.matrix.filter || '') + '">' : '')
    + (m.pro ? segmented({ id: 'prj-agents-view', label: 'Group the table', items: [{ id: 'computer', label: 'Per computer' }, { id: 'harness', label: 'Per harness' }], active: m.matrix && m.matrix.view === 'harness' ? 'harness' : 'computer' }) : '')
    + '<span class="prj-toolbar-end">'
      + (m.checkedWords ? '<span class="prj-sub">' + esc(m.checkedWords) + '</span>' : '')
      + btn(m.state === 'loading' ? 'Checking…' : CHECK_AGAIN, { 'data-setup-act': 'check' })
      + flow(m.pickerHtml, 'pickerHtml')
    + '</span></div>';
  out.push(head);
  out.push(flow(m.customHtml, 'customHtml'));
  if (m.recheckError) out.push(notice({ tone: 'attention', title: 'The last check did not finish.', line: m.recheckError + ' What is shown is the reading before it.' }));
  if (m.state === 'loading' && !(m.rows && m.rows.length)) {
    out.push(card('<div class="prj-list">' + row({ id: 'checking', title: 'Checking this computer…', status: statusChip('working') }) + '</div>'));
  } else if (m.state === 'error' && !(m.rows && m.rows.length)) {
    out.push(notice({ tone: 'error', title: 'Could not check this computer.', line: m.error || '' }));
  } else if (!m.rows || !m.rows.length) {
    out.push(card('<div class="prj-empty"><p>No agent on this project yet. An agent here is the app your agent runs in — Claude Code, Codex, Cursor, Antigravity…</p>'
      + btn('Connect an agent', { 'data-prj-act': 'connect' }, true) + '</div>', 'Agents'));
  } else if (m.pro && m.matrix) {
    out.push(matrixTable(m.matrix));
  } else {
    out.push(card('<div class="prj-list">' + m.rows.map((r) => row({
      id: 'tool:' + r.id, title: r.label, meta: r.meta, status: statusChip(r.kind), action: r.action || undefined,
      opens: true, targetId: r.targetId,
    })).join('') + '</div>', 'Agents'));
  }
  out.push(notices(m.notices));
  if (m.unsynced) {
    out.push(notice({ tone: 'info', title: fmtCount(m.unsynced) + ' file' + (m.unsynced === 1 ? ' is' : 's are') + ' only on this computer.',
      line: 'Your other computers see the newest note after you sync.',
      actions: [{ label: SYNC_NOW, attrs: { 'data-setup-act': 'sync' } }] }));
  }
  out.push(flow(m.repoHtml, 'repoHtml'));
  return '<div class="prj-stack">' + out.join('') + '</div>';
}

/** A check cell: the word itself ("yes", "needs a fix", "unknown"…), never colour alone. */
function checkCell(word) {
  return { text: String(word || 'unknown'), sort: String(word || '') };
}

/** The Pro matrix: one row per harness per computer (or per harness). */
export function matrixTable(mx) {
  const rows = (mx.rows || []).map((r) => ({
    id: r.id,
    targetId: r.here ? 'mem-setup-tool-' + r.tool : undefined,
    cells: {
      harness: r.harness,
      computer: r.computer,
      status: { html: statusChip(r.kind), sort: r.kind },
      connected: checkCell(r.connected),
      skills: checkCell(r.skills),
      instructions: checkCell(r.instructions),
      hooks: checkCell(r.hooks),
      last: { text: r.lastSave ? fmtAge(r.lastSave) : 'never', sort: r.lastSave ? -Date.parse(r.lastSave) : null },
      saves: r.saves7 === null || r.saves7 === undefined ? { text: '—', sort: null } : r.saves7,
      remove: r.removable ? { html: btn('Remove', { 'data-setup-act': 'remove-tool', 'data-tool': r.tool, 'aria-label': 'Remove ' + r.harness + ' from this computer’s list' }) } : '',
    },
  }));
  return table({
    id: 'prj-agents',
    caption: 'Every check, per ' + (mx.view === 'harness' ? 'harness' : 'harness and computer'),
    opens: true,
    sortBy: mx.sortBy || null,
    columns: [
      { id: 'harness', label: 'Harness', sort: true },
      { id: 'computer', label: 'Computer', sort: true },
      { id: 'status', label: 'Status', sort: true },
      { id: 'connected', label: 'Connected' },
      { id: 'skills', label: 'Skills' },
      { id: 'instructions', label: 'Instructions' },
      { id: 'hooks', label: 'Hooks' },
      { id: 'last', label: 'Last save', sort: true },
      { id: 'saves', label: 'Saves 7 d', numeric: true, sort: true },
    ].concat((mx.rows || []).some((r) => r.removable) ? [{ id: 'remove', label: 'Remove' }] : []),
    rows,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STARTING KIT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * m = { pro, open: 'brief'|'documents'|'knowledge'|null, brief: {meta}, documents: {meta},
 *       knowledge: {meta, dot}, figure, settingsWords, notices, sessionNoticesHtml,
 *       briefEditorHtml, documentsHtml, knowledgeHtml, plannerHtml, docTable }
 */
export function kitPanel(m) {
  const out = [];
  out.push(notices(m.notices));
  out.push(flow(m.sessionNoticesHtml, 'sessionNoticesHtml'));
  out.push(card('<div class="prj-list">'
    + row({ id: 'kit:brief', title: 'Brief', meta: m.brief && m.brief.meta, opens: true, targetId: 'prj-kit-brief',
      action: m.readonly ? undefined : { label: 'Edit', attrs: { 'data-prj-act': 'brief-edit' } } })
    + row({ id: 'kit:documents', title: 'Documents', meta: m.documents && m.documents.meta, opens: true, targetId: 'prj-kit-documents',
      action: m.readonly ? undefined : { label: 'Add', attrs: { 'data-prj-act': 'documents-add' } } })
    + row({ id: 'kit:knowledge', title: 'Knowledge', meta: m.knowledge && m.knowledge.meta, dot: m.knowledge && m.knowledge.dot,
      opens: true, targetId: 'prj-kit-knowledge',
      action: m.readonly ? undefined : { label: 'Add a domain', attrs: { 'data-prj-act': 'knowledge-add' } } })
    + '</div>', 'Starting kit'));
  // audit M1: a start that does not fit says the meter's own sentence here,
  // in both modes (Pro's Budget draws it on the window bar).
  if (m.figure && m.figure.over > 0) {
    out.push(notice({ tone: 'attention', title: m.figure.overLine, line: m.figure.qualifier }));
  }
  if (m.figure) {
    out.push(card('<div class="prj-meter-head"><p class="prj-meter-words">' + esc(m.figure.words) + '</p>'
      + (m.figure.over > 0 ? '' : '<p class="prj-sub">' + esc(m.figure.qualifier) + '</p>')
      + flow(m.kitBudgetPickerHtml, 'kitBudgetPickerHtml') + '</div>'
      + '<div class="prj-meter" role="img" aria-label="' + esc(m.figure.words + ' — ' + m.figure.tokens + ' of ' + m.figure.window + ' tokens') + '">'
      + '<span class="prj-meter-fill" style="width:' + (Math.round(m.figure.pct * 10) / 10) + '%"></span></div>'
      + (m.settingsWords ? '<p class="prj-sub">' + esc(m.settingsWords) + '</p>' : ''), 'Starting kit size'));
  } else if (m.figureError) {
    out.push(notice({ tone: 'attention', title: 'What an agent receives could not be measured.', line: m.figureError }));
  }
  // Owner decision 2026-11-27: the Documents row opens the list in BOTH
  // modes (each document's At-start picker, open, edit, delete); Pro keeps
  // it open.
  if (m.docTable && (m.pro || m.open === 'documents')) out.push(m.docTable);
  if (m.open === 'brief') out.push(flow(m.briefEditorHtml, 'briefEditorHtml'));
  if (m.open === 'documents' || m.pro) out.push(flow(m.documentsHtml, 'documentsHtml'));
  if (m.open === 'knowledge') out.push(flow(m.knowledgeHtml, 'knowledgeHtml'));
  if (m.pro) out.push(flow(m.plannerHtml, 'plannerHtml'));
  return '<div class="prj-stack">' + out.join('') + '</div>';
}

/** Pro's documents table: Document · Source · At start · Tokens · Updated. */
export function documentsTable(docs) {
  return table({
    id: 'prj-docs',
    caption: 'Documents',
    opens: true,
    columns: [
      { id: 'doc', label: 'Document', sort: true },
      { id: 'source', label: 'Source', sort: true },
      { id: 'start', label: 'At start' },
      { id: 'tokens', label: 'Tokens', numeric: true, sort: true },
      { id: 'updated', label: 'Updated', sort: true },
    ].concat((docs || []).some((d) => isStr(d.actionsHtml)) ? [{ id: 'act', label: 'Actions' }] : []),
    rows: (docs || []).map((d) => ({ id: 'doc:' + d.slug, targetId: d.targetId, cells: {
      doc: d.title, source: d.source, start: { html: d.startHtml || esc(d.startWord), sort: d.startWord },
      tokens: { text: d.tokens, sort: d.tokenCount }, updated: { text: d.updated, sort: d.updatedSort },
      // Today's edit (kept documents) and delete buttons, by their own data-*
      // attributes, so bindFoundationRows wires them and the confirms are today's.
      act: isStr(d.actionsHtml) ? { html: d.actionsHtml } : '',
    } })),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY (Pro)
// ═══════════════════════════════════════════════════════════════════════════

/** m = { rows, q, harness, harnesses, summary, savesLine, sortBy } */
export function historyPanel(m) {
  const opts = [{ value: '', label: 'All' }].concat((m.harnesses || []).map((h) => ({ value: h, label: h })));
  const out = [];
  out.push('<div class="prj-toolbar">'
    + '<input type="search" class="prj-search" id="prj-history-q" data-prj-filter="history" placeholder="Search notes…" aria-label="Search notes" value="' + esc(m.q || '') + '">'
    + (m.harnessPickerHtml || '<span class="prj-sub">' + esc(opts.length - 1 + ' harnesses') + '</span>')
    + '</div>');
  if (m.summary || m.savesLine) {
    out.push(table({ id: 'prj-history-figures', caption: 'Agent connections', columns: [{ id: 'k', label: 'Reading' }, { id: 'v', label: 'Value' }],
      rows: [m.summary ? { id: 's', cells: { k: m.summaryLabel || 'Agent connections', v: m.summary } } : null,
        m.savesLine ? { id: 'b', cells: { k: 'Saves by harness', v: m.savesLine } } : null].filter(Boolean) }));
  }
  out.push(table({
    id: 'prj-history',
    caption: 'Every saved note',
    opens: true,
    sortBy: m.sortBy || { id: 'when', dir: 'asc' },
    columns: [
      { id: 'when', label: 'When', sort: true },
      { id: 'scope', label: 'Work-stream', sort: true },
      { id: 'harness', label: 'Harness', sort: true },
      { id: 'model', label: 'Model', sort: true },
      { id: 'headline', label: 'Headline' },
      { id: 'computer', label: 'Computer', sort: true },
      { id: 'size', label: 'Size', numeric: true, sort: true },
    ].concat(m.canDelete ? [{ id: 'del', label: 'Delete' }] : []),
    rows: (m.rows || []).map((r) => ({ id: r.id, targetId: r.targetId, cells: {
      when: { text: r.when, sort: r.seconds === null ? null : r.seconds },
      scope: r.scope, harness: r.harness || '—', model: r.model || '—', headline: r.headline || '—',
      computer: r.computer || '—',
      size: { text: r.bytes === null ? '—' : fmtSize(r.bytes), sort: r.bytes },
      del: m.canDelete ? { html: '<button type="button" class="btn btn-ghost btn-xs" data-ws-delete="' + esc(r.scope) + '" aria-label="'
        + esc('Delete handoff ' + r.scope + '…') + '">Delete…</button>' } : '',
    } })),
  }));
  if (!(m.rows || []).length) out.push('<p class="prj-sub">No note matches.</p>');
  out.push(flow(m.deleteHtml, 'deleteHtml'));
  return '<div class="prj-stack">' + out.join('') + '</div>';
}

// ═══════════════════════════════════════════════════════════════════════════
// BUDGET (Pro)
// ═══════════════════════════════════════════════════════════════════════════

/** m = { budgetPickersHtml, meterHtml, layers: [{layer, tokens, size, share}], receivesHtml, reachHtml, errorsHtml } */
export function budgetPanel(m) {
  const out = [];
  out.push(notices(m.notices));
  out.push(flow(m.budgetPickersHtml, 'budgetPickersHtml'));
  out.push(flow(m.meterHtml, 'meterHtml'));
  if (Array.isArray(m.layers) && m.layers.length) {
    out.push(table({ id: 'prj-layers', caption: 'What an agent receives at the start', columns: [
      { id: 'layer', label: 'Layer' }, { id: 'tokens', label: 'Tokens', numeric: true },
      { id: 'size', label: 'Size', numeric: true }, { id: 'share', label: 'Of the window', numeric: true }],
    rows: m.layers.map((l, i) => ({ id: 'l' + i, cells: { layer: l.layer, tokens: { text: l.tokens, sort: l.tokenCount },
      size: { text: l.size, sort: l.bytes }, share: l.share } })) }));
  }
  out.push('<div class="prj-actions">' + btn('What an agent receives, in full ›', { 'data-prj-act': 'receives-full' }) + '</div>');
  out.push(flow(m.reachHtml, 'reachHtml'));
  return '<div class="prj-stack">' + out.join('') + '</div>';
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPUTERS (Pro)
// ═══════════════════════════════════════════════════════════════════════════

/** m = { rows, routes, repo: {path, set}, pending, waiting, syncConfigured } */
export function computersPanel(m) {
  const out = [];
  out.push(table({ id: 'prj-computers', caption: 'Computers that saved this project', opens: true, columns: [
    { id: 'name', label: 'Computer', sort: true }, { id: 'installs', label: 'App' },
    { id: 'harnesses', label: 'Harnesses' }, { id: 'curator', label: 'Curator version' },
    { id: 'last', label: 'Last save', sort: true }, { id: 'waiting', label: 'Not sent', numeric: true }],
  rows: (m.rows || []).map((r) => ({ id: 'comp:' + r.index, cells: {
    name: r.name, installs: r.installs || '—', harnesses: r.harnesses || '—', curator: r.curator || 'not recorded',
    last: { text: r.lastSave ? fmtAge(r.lastSave) : 'never', sort: r.lastSave ? -Date.parse(r.lastSave) : null },
    waiting: r.waiting ? r.waiting : { text: '—', sort: 0 },
  } })) }));
  out.push(table({ id: 'prj-routes', caption: 'How each part reaches your other computers', columns: [
    { id: 'what', label: 'What' }, { id: 'how', label: 'Travels by' }],
  rows: (m.routes || []).map((r, i) => ({ id: 'r' + i, cells: { what: r.what, how: r.how } })) }));
  const facts = [
    { k: 'Project folder on this computer', v: m.repo && m.repo.path ? m.repo.path : 'not set' },
    { k: 'Files not on GitHub yet', v: Number.isInteger(m.pending) ? fmtCount(m.pending) + ' (all domains)' : (m.syncConfigured ? 'unknown' : 'Sync is not set up here') },
  ];
  if (Array.isArray(m.files) && m.files.length) facts.push({ k: 'Repository files checked', v: m.files.join(', ') });
  out.push(table({ id: 'prj-computer-facts', caption: 'This computer', columns: [{ id: 'k', label: 'Reading' }, { id: 'v', label: 'Value' }],
    rows: facts.map((f, i) => ({ id: 'cf' + i, cells: { k: f.k, v: f.v } })) }));
  out.push('<div class="prj-actions">'
    + (m.syncConfigured ? btn(SYNC_NOW, { 'data-setup-act': 'sync' }) : btn('Open Sync', { 'data-setup-act': 'open-sync' }))
    + btn(m.repo && m.repo.path ? 'Change folder' : 'Set the folder', { 'data-setup-act': m.repo && m.repo.path ? 'change-repo' : 'choose-repo' })
    + '</div>');
  return '<div class="prj-stack">' + out.join('') + '</div>';
}

// ═══════════════════════════════════════════════════════════════════════════
// THE CONNECT FLOW (D8) — the reader's body, one flow
// ═══════════════════════════════════════════════════════════════════════════

/**
 * m = { step: 'pick'|'computer'|'project', harnesses: [{id, label, meta, kind}],
 *       chosen: {id, label}|null, computerHtml (trusted: the install plan / results / copy entry),
 *       projectHtml (trusted: the harness's guide, steps 2–4), outcome }
 */
export function connectFlowHtml(m) {
  const steps = [
    { key: 'pick', title: 'Pick the agent' },
    { key: 'computer', title: 'Connect it on this computer' },
    { key: 'project', title: 'Point it at this project' },
  ];
  const at = steps.findIndex((s) => s.key === m.step);
  const head = '<ol class="prj-steps prj-steps-compact">' + steps.map((s, i) => '<li class="prj-step' + (i < at ? ' is-done' : '') + (i === at ? ' is-current' : '') + '"'
    + (i === at ? ' aria-current="step"' : '') + '>'
    + '<span class="prj-step-num" aria-hidden="true">' + (i < at ? '✓' : String(i + 1)) + '</span>'
    + '<span class="prj-step-text"><span class="prj-step-title">' + esc(s.title) + '</span></span></li>').join('') + '</ol>';
  let body = '';
  if (m.step === 'pick') {
    body = '<h3 class="prj-h" id="prj-connect-h" tabindex="-1">Which agent do you use?</h3>'
      + '<div class="prj-list">' + (m.harnesses || []).map((h) => row({
        id: 'connect:' + h.id, title: h.label, meta: h.meta, status: h.kind ? statusChip(h.kind) : '', opens: true,
      })).join('') + '</div>'
      + (m.otherHtml ? flow(m.otherHtml, 'pickerHtml') : '');
  } else {
    body = '<h3 class="prj-h" id="prj-connect-h" tabindex="-1">' + esc((m.chosen && m.chosen.label) || 'Your agent') + '</h3>'
      + (m.outcome ? notice(m.outcome) : '')
      + (m.computerHtml ? '<section class="prj-flow-part" aria-label="On this computer">' + h2('On this computer') + m.computerHtml + '</section>' : '')
      + (m.projectHtml ? '<section class="prj-flow-part" aria-label="For this project">' + h2('For this project') + m.projectHtml + '</section>' : '')
      + '<div class="prj-actions">' + btn('Pick another agent', { 'data-prj-connect': 'back' }) + '</div>';
  }
  return '<div class="prj-connect">' + head + body + '</div>';
}
