// src/dev/kit/kit.js — the KIT PAGE (kit v1, phase 0's acceptance picture).
//
// DEV-ONLY. Served at /next/kit.html + /next/kit.js by src/routes/kit-page.js
// only when the server runs with CURATOR_KIT_PAGE=1 (never otherwise, and
// never linked from the app's navigation). It renders every kit part in every
// state, in both themes side by side, plus an object page assembled from the
// parts with the mockups' synthetic "my-app" data. It fetches nothing and
// writes nothing.
//
// Each part is rendered twice: in a panel that inherits the dark theme from
// <html>, and in a panel carrying data-theme="light" — the token files scope
// every semantic alias to `[data-theme="light"]`, so one page shows both.

import { fmtCount, fmtPages, fmtSize, fmtSizeDelta, fmtTokens, fmtAge, fmtUsd, SIZE_DIVISOR } from '/next/shared/format.js';
import { statusChip, STATUS_KINDS, STATUS_WORDS } from '/next/shared/status.js';
import { notice } from '/next/shared/notice.js';
import { row, wireRows } from '/next/shared/row.js';
import { tabs, segmented, tabPanelAttrs, wireTabs, wireSegmented } from '/next/shared/tabs.js';
import { table, wireTable, nextSort } from '/next/shared/table.js';
import { objectPage } from '/next/shared/object-page.js';
import { renderFoldRows, renderFoldRow, renderFoldItem } from '/next/shared/section.js';
import { identitySlotClass } from '/next/shared/sidebar.js';
import { CHECK_AGAIN, SYNC_NOW, CONNECT, ADD, OPEN } from '/next/shared/verbs.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A fixed clock, so the PNGs are the same picture on every run.
const NOW = Date.parse('2026-11-27T12:00:00Z');
const ago = (s) => NOW - s * 1000;

const H = (title, sub) => '<h2 class="kit-demo-h">' + esc(title) + '</h2>' + (sub ? '<p class="kit-demo-sub">' + esc(sub) + '</p>' : '');
const card = (inner) => '<div class="kit-demo-card">' + inner + '</div>';

function figures() {
  const rowsF = [
    ['fmtCount(3527)', fmtCount(3527)], ['fmtPages(1)', fmtPages(1)], ['fmtPages(3527)', fmtPages(3527)],
    ['fmtSize(512)', fmtSize(512)], ['fmtSize(1843)', fmtSize(1843)], ['fmtSize(63488)', fmtSize(63488)],
    ['fmtSize(14.2 MiB)', fmtSize(14.2 * 1048576)], ['fmtSizeDelta(6246)', fmtSizeDelta(6246)],
    ['fmtTokens(500)', fmtTokens(500)], ['fmtTokens(10300)', fmtTokens(10300)], ['fmtTokens(205000)', fmtTokens(205000)],
    ['fmtTokens(1e6)', fmtTokens(1e6)], ['fmtAge(45 s)', fmtAge(ago(45), NOW)], ['fmtAge(27 min)', fmtAge(ago(1620), NOW)],
    ['fmtAge(21 hr)', fmtAge(ago(75600), NOW)], ['fmtAge(4 days)', fmtAge(ago(4 * 86400), NOW)],
    ['fmtAge(2 weeks)', fmtAge(ago(15 * 86400), NOW)], ['fmtAge(1 hr ahead)', fmtAge(NOW + 3600e3, NOW)],
    ['fmtUsd(0.00002)', fmtUsd(0.00002)], ['fmtUsd(0.042)', fmtUsd(0.042)],
  ];
  return H('1 · Figure — shared/format.js', 'One divisor (' + SIZE_DIVISOR + '), one rounding, en-US separators.') +
    card(table({
      id: 'kit-fig', pro: true,
      columns: [{ id: 'call', label: 'Call' }, { id: 'out', label: 'Writes', align: 'right' }],
      rows: rowsF.map(([a, b], i) => ({ id: 'f' + i, cells: { call: { html: '<code>' + esc(a) + '</code>', sort: a }, out: b } })),
    }));
}

function chips() {
  const bare = STATUS_KINDS.map((k) => statusChip(k)).join(' ');
  const alt = statusChip('off', { label: 'Off' });
  const counts = statusChip('needs-you', { count: 21, label: 'to review' }) + ' ' +
    statusChip('ready', { count: 3527, label: 'pages checked' }) + ' ' +
    statusChip('error', { count: 2, label: 'failed to write' });
  return H('2 · Status chip — shared/status.js', 'Closed vocabulary: ' + STATUS_KINDS.map((k) => STATUS_WORDS[k].join(' / ')).join(' · ')) +
    card('<div class="kit-demo-line">' + bare + ' ' + alt + '</div><div class="kit-demo-line">' + counts + '</div>');
}

function notices(theme) {
  return H('3 · Notice — shared/notice.js', 'Three tones; title ≤ 12 words, one line, ≤ 2 actions, “Why?” opens the explainer.') +
    '<div class="kit-demo-stack">' +
    notice({ tone: 'info', title: '14 files are only on this computer', line: 'Your other computer sees the newest note after you sync.', actions: [{ label: SYNC_NOW, primary: true, attrs: { 'data-kit-demo': 'sync' } }] }) +
    notice({ tone: 'attention', title: 'Antigravity may skip saving', line: 'Its instructions are out of date.', actions: [{ label: 'Update', primary: true }, { label: OPEN }], why: 'context.setup', id: 'kit-why-setup-' + theme }) +
    notice({ tone: 'error', title: 'The last sync failed', line: 'GitHub refused the token. Nothing was changed on either side.', actions: [{ label: CHECK_AGAIN }] }) +
    '</div>';
}

function rows(theme) {
  const list = [
    row({ id: 'claude-' + theme, dot: identitySlotClass(2), title: 'Claude Code', meta: 'Last note 27 min ago, from this Mac', status: statusChip('ready'), opens: true }),
    row({ id: 'anti-' + theme, dot: identitySlotClass(4), title: 'Antigravity', meta: 'Its instructions are out of date, so it may skip saving', status: statusChip('needs-you'), action: { label: 'Update', attrs: { 'data-kit-demo': 'update' } }, opens: true }),
    row({ id: 'open-' + theme, title: 'OpenCode', meta: '2 of 3 steps left · next: connect it to The Curator', status: statusChip('off'), action: { label: 'Continue' }, opens: true }),
    row({ id: 'codex-' + theme, title: 'Codex', meta: 'Checking…', status: statusChip('working') }),
    row({ id: 'cursor-' + theme, title: 'Cursor', meta: 'Skills cannot be checked on this computer', status: statusChip('unknown') }),
  ].join('');
  return H('4 · Row — shared/row.js', 'The whole row is the target when it opens; one status, at most one action.') +
    card('<div class="kit-demo-rows" data-kit-demo-rows>' + list + '</div><p class="kit-demo-out" data-kit-demo-out>Press a row.</p>');
}

const TAB_ITEMS = [
  { id: 'now', label: 'Now' }, { id: 'agents', label: 'Agents', count: 3 }, { id: 'kit', label: 'Starting kit' },
  { id: 'history', label: 'History', count: 45, pro: true }, { id: 'budget', label: 'Budget', pro: true }, { id: 'computers', label: 'Computers', count: 2, pro: true },
];

function pickers(theme) {
  return H('5 · Tabs and Segmented — shared/tabs.js', 'Roving focus: ←/→, Home, End. Pro tabs are drawn only with Pro on.') +
    card('<p class="kit-demo-cap">Simple</p>' + tabs({ id: 'kit-t-s-' + theme, label: 'Project', items: TAB_ITEMS, active: 'now', pro: false }) +
      '<p class="kit-demo-cap">Pro</p>' + tabs({ id: 'kit-t-p-' + theme, label: 'Project', items: TAB_ITEMS, active: 'history', pro: true }) +
      '<p class="kit-demo-cap">Segmented (2–4 choices)</p>' +
      segmented({ id: 'kit-seg-' + theme, label: 'Window', items: [{ id: 'auto', label: 'Automatic' }, { id: '200k', label: '200k' }, { id: '1m', label: '1M' }], active: 'auto' }));
}

const SAVES = [
  { id: 's1', when: 1620, stream: 'checkout', harness: 'Claude Code', model: 'claude-opus-5-5', head: 'Checkout flow: tests green, payment retry still open', bytes: 6246 },
  { id: 's2', when: 86400 + 3600, stream: 'checkout', harness: 'Claude Code', model: 'claude-opus-5-5', head: 'Address step done; cart totals fixed', bytes: 4710 },
  { id: 's3', when: 3 * 86400, stream: 'setup', harness: 'Cursor', model: 'gpt-5.2', head: 'Project set up; test runner chosen', bytes: 1843 },
  { id: 's4', when: 16 * 86400, stream: 'design', harness: 'Antigravity', model: 'gemini-3-pro', head: 'Design tokens agreed', bytes: 63488 },
];
const SAVE_COLS = [
  { id: 'head', label: 'Headline', sort: true },
  { id: 'when', label: 'Saved', sort: true, numeric: true },
  { id: 'harness', label: 'Harness', sort: true },
  { id: 'stream', label: 'Work-stream', sort: true, pro: true },
  { id: 'model', label: 'Model', pro: true },
  { id: 'size', label: 'Size', sort: true, numeric: true, pro: true },
];
function saveRows() {
  return SAVES.map((s) => ({ id: s.id, cells: {
    head: s.head, when: { text: fmtAge(ago(s.when), NOW), sort: -s.when }, harness: s.harness,
    stream: s.stream, model: { html: '<code>' + esc(s.model) + '</code>', sort: s.model }, size: { text: fmtSize(s.bytes), sort: s.bytes },
  } }));
}
const tableState = {};
function savesTable(id, pro) {
  return table({ id, pro, opens: true, caption: pro ? 'Pro: every column' : 'Simple: three columns', columns: SAVE_COLS, rows: saveRows(), sortBy: tableState[id] || { id: 'when', dir: 'desc' } });
}
function tables(theme) {
  return H('6 · Data table — shared/table.js', 'Sortable heads (aria-sort), numbers right-aligned in tabular figures, rows open the reader; stacks below 900 px.') +
    card('<div data-kit-demo-table="' + theme + '-s">' + savesTable('kit-tb-s-' + theme, false) + '</div>') +
    card('<div data-kit-demo-table="' + theme + '-p">' + savesTable('kit-tb-p-' + theme, true) + '</div>');
}

function fold() {
  return H('7 · Fold — cur-fold (shared/section.js), the one fold', 'For explanation or optional steps only — never a warning, a cost or an outcome; in Pro, never data.') +
    card(renderFoldRows(renderFoldRow({ key: 'kit-fold', label: 'How an agent reaches this project', open: false,
      bodyHtml: renderFoldItem({ meta: 'It reads the brief and the latest note through The Curator’s tools when it starts.' }) })));
}

function page(theme) {
  const agents = [
    row({ id: 'p-claude-' + theme, title: 'Claude Code', meta: 'Last note 27 min ago, from this Mac', status: statusChip('ready'), opens: true }),
    row({ id: 'p-anti-' + theme, title: 'Antigravity', meta: 'Its instructions are out of date, so it may skip saving', status: statusChip('needs-you'), action: { label: 'Update' }, opens: true }),
    row({ id: 'p-open-' + theme, title: 'OpenCode', meta: '2 of 3 steps left · next: connect it to The Curator', status: statusChip('off'), action: { label: 'Continue' }, opens: true }),
  ].join('');
  const id = 'kit-op-' + theme;
  const body = '<div' + tabPanelAttrs(id, 'agents') + '>' +
    '<div class="kit-demo-card">' + agents + '</div>' +
    notice({ tone: 'info', title: '14 files are only on this computer', line: 'Your other computer sees the newest note after you sync.', actions: [{ label: SYNC_NOW, primary: true }] }) +
    '</div>';
  return H('8 · Page anatomy — shared/object-page.js', 'Header, one status sentence, tab strip, body. Synthetic “my-app” data.') +
    card(objectPage({
      identityDot: identitySlotClass(1), kicker: 'Work · project', title: 'my-app',
      statusSentence: 'Claude Code saved a note 27 minutes ago on this Mac. Antigravity needs one step from you.',
      primaryAction: '<button type="button" class="btn btn-primary">' + esc(CONNECT) + ' an agent</button>',
      moreMenu: '<button type="button" class="btn btn-secondary" aria-label="More">···</button>',
      tabs: tabs({ id, label: 'my-app', items: TAB_ITEMS, active: 'agents', pro: false }),
      body,
    }) + '<p class="kit-demo-cap">Verbs: ' + [CHECK_AGAIN, SYNC_NOW, CONNECT, ADD, OPEN].map(esc).join(' · ') + '</p>');
}

function column(theme) {
  return '<section class="kit-demo-col"' + (theme === 'light' ? ' data-theme="light"' : '') + ' aria-label="' + theme + ' theme">' +
    '<p class="kit-demo-theme">' + (theme === 'light' ? 'Light' : 'Dark') + '</p>' +
    figures() + chips() + notices(theme) + rows(theme) + pickers(theme) + tables(theme) + fold() + page(theme) +
  '</section>';
}

const root = document.getElementById('kit-root');
root.innerHTML = column('dark') + column('light');

wireRows(root, (id) => {
  const out = root.querySelectorAll('[data-kit-demo-out]');
  for (const o of out) o.textContent = 'Opened ' + id + '.';
});
wireTabs(root, () => {});
wireSegmented(root, () => {});
wireTable(root, {
  onSort: (col, tid) => {
    tableState[tid] = nextSort(tableState[tid] || { id: 'when', dir: 'desc' }, col, SAVE_COLS);
    const wrap = root.querySelector('[data-kit-table="' + tid + '"]');
    if (wrap) wrap.outerHTML = savesTable(tid, /-p-/.test(tid));
  },
  onOpen: () => {},
});
document.documentElement.setAttribute('data-kit-ready', '1');
