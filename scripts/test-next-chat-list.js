/**
 * test-next-chat-list.js — OFFLINE suite for the v3.72.0 Chat overhaul, P3
 * (views/chat-list.js, shared/age-ticker.js, and the parts of views/chat.js
 * that adopt them). No network, no server, no browser, no LLM call.
 *
 * The maintainer's decisions (2026-09-25) this suite holds:
 *   M1  ONE conversation list across all domains: a domain dot on every row,
 *       plus a hollow grey square and the project NAME when a project was
 *       pinned; a domain filter.
 *   M3  ONE row-action rule: a neutral `.row-act` trash, always visible; a
 *       Select MODE for bulk delete; red only in the confirm.
 *   M4  numbered citations + ONE Sources list (P2's answer API, wired here).
 * And the truth audit's Chat findings owned by P3: F2 (the "priced at the
 * time" label, and "today's price" said as today's), F5 (the compile
 * confirm names a fallback and its price), F7 (groups and ages are live).
 *
 *   §1  The row, through the ONE sidebar component — dot, project mark, age.
 *   §2  Groups: Today / Yesterday / Previous 7 days / Earlier, by LAST USE.
 *   §3  Select mode and the list head.
 *   §4  The wiring, driven with a fake root.
 *   §5  shared/age-ticker.js — named targets, prefixes, no repaint, the day.
 *   §6  ADOPTION: Chat uses renderSidebarRow, .row-act, identitySlotClass and
 *       P2's answer API, and the retired idioms are gone.
 *   §7  F2 — the answer's cost: what it cost, or today's price said as today's.
 *   §8  F5 — the compile confirm prices the fallback it may bill.
 *   §9  The sidebar kit's new line-three detail is escaped, never trusted.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as LIST from '../src/public/next/views/chat-list.js';
import * as TICK from '../src/public/next/shared/age-ticker.js';
import { renderSidebarRow, identitySlotClass } from '../src/public/next/shared/sidebar.js';
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, 'src/public/next', rel), 'utf8');
const chatSrc = read('views/chat.js');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const chatCode = stripJs(chatSrc);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(t) { console.log(`\n${t}`); }

function extractFunction(src, name) {
  const m = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), d = 0;
  for (; p < src.length; p++) { if (src[p] === '(') d++; else if (src[p] === ')') { d--; if (d === 0) { p++; break; } } }
  let i = src.indexOf('{', p); d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
  const out = src.slice(start, i);
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced`);
  return out;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NOW = new Date(2026, 8, 25, 15, 0, 0).getTime(); // local 25 Sep 2026, 15:00
const at = (daysAgo, h = 12, m = 0) => { const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.toISOString(); };
// `identitySlot` is each domain's RECORDED colour slot (v3.76.0) — deliberately
// NOT its position, so a test that paints by position goes red.
const DOMAINS = [
  { slug: 'articles', displayName: 'Articles', identitySlot: 4 }, { slug: 'business', displayName: 'Business', identitySlot: 1 },
  { slug: 'projects', displayName: 'Projects', identitySlot: 10 },
];
const ctx = (over = {}) => Object.assign({
  domains: DOMAINS, activeDomain: 'articles', activeConversationId: null, conversations: [],
  selectMode: false, selectedKeys: new Set(), now: NOW,
}, over);

// ═════════════════════════════════════════════════════════════════════════
section('§1 — the row: the ONE sidebar component, a domain dot, the project mark, a true age');
// ═════════════════════════════════════════════════════════════════════════
{
  const c = { id: 'u1', domain: 'projects', title: 'What did we decide?', messageCount: 8,
    createdAt: at(0, 13, 0), updatedAt: at(0, 14, 48), lastProject: 'curator' };
  const html = LIST.conversationRowHtml(c, ctx());
  ok(html.startsWith('<div class="chat-conv-item"'), 'the item wraps the row and its action (a <button> cannot hold one)');
  ok(html.includes('<button type="button" class="cur-sb-row'), '★ the row IS renderSidebarRow\'s button');
  ok(html.includes('class="cur-sb-dot ' + identitySlotClass(10) + '"') && !html.includes('cur-sb-dot-3"'),
    '★ the dot is the ROW\'s domain\'s RECORDED slot — Projects is slot 10, not its position (3) nor the active domain\'s');
  ok(!/cur-sb-dot-\d/.test(LIST.conversationRowHtml(c, ctx({ domains: DOMAINS.map(({ identitySlot, ...d }) => d) }))),
    '…and with no recorded slot on the row there is NO dot — never a position guess');
  ok(/<span class="cur-sb-event">Projects<span class="cur-sb-sep" aria-hidden="true"> · <\/span><span class="cur-sb-event-mark chat-pmark" aria-hidden="true"><\/span><span class="cur-sb-event-detail">curator<\/span><\/span>/.test(html),
    '★ line three: the domain in WORDS, then the hollow project mark and the project\'s NAME');
  ok(html.includes('8 messages'), 'the figure is the server\'s real messageCount');
  ok(html.includes('data-age-at="' + c.updatedAt + '"') && !html.includes('data-age-prefix'),
    '★ a recorded updatedAt is LAST USE: the age ticks from it, with no prefix');
  ok(html.includes('<span class="cur-sb-age">12 min ago</span>'), '…and it reads from the one age vocabulary');
  ok(/visually-hidden"> \(last message \d{4}-\d\d-\d\d \d\d:\d\d\)/.test(html), 'the absolute time is there for AT, never a title=');
  ok(!/ title="/.test(html), 'no hover-only title= anywhere on the row');

  const old = LIST.conversationRowHtml({ id: 'u2', domain: 'articles', title: 'Old', messageCount: 2, createdAt: at(21) }, ctx());
  ok(old.includes('data-age-prefix="started"') && old.includes('>started 3 weeks ago<'),
    '★ a pre-v3.72 file (no updatedAt) says "started … ago" — its START is never presented as last use');
  ok(!old.includes('chat-pmark'), '★ …and it shows NO project mark — nothing is guessed for a file that recorded none');
  const nullProj = LIST.conversationRowHtml({ id: 'u3', domain: 'articles', title: 'N', createdAt: at(1), lastProject: null }, ctx());
  ok(!nullProj.includes('chat-pmark'), 'a turn recorded with NO project (null) shows no mark either');
  const junk = LIST.conversationRowHtml({ id: 'u4', domain: 'articles', title: 'J', createdAt: at(1), lastProject: 42 }, ctx());
  ok(!junk.includes('chat-pmark') && !junk.includes('>42<'), 'a non-string project is not rendered');
  const noTime = LIST.conversationRowHtml({ id: 'u5', domain: 'articles', title: 'T' }, ctx());
  ok(!noTime.includes('data-age-at') && !noTime.includes('cur-sb-age'), 'no readable time → no age at all, never "NaN ago"');
  const gone = LIST.conversationRowHtml({ id: 'u6', domain: 'vanished', title: 'G', createdAt: at(1) }, ctx());
  ok(!gone.includes('cur-sb-dot') && gone.includes('>vanished<'),
    'a domain the install no longer lists gets NO dot (never another domain\'s colour) and its slug in words');
  const act = LIST.conversationRowHtml(c, ctx({ activeDomain: 'projects', activeConversationId: 'u1' }));
  ok(/class="cur-sb-row active chat-conv-row"/.test(act) && act.includes('aria-current="true"'), 'the open conversation is the kit\'s active row');
  const sameIdOther = LIST.conversationRowHtml(c, ctx({ activeDomain: 'articles', activeConversationId: 'u1' }));
  ok(!/cur-sb-row active/.test(sameIdOther), '★ the SAME id open in another domain does not light this row');
  ok(html.includes('<button type="button" class="row-act chat-conv-act" data-conv-delete="u1" data-conv-domain="projects"'),
    '★ the trash is the ONE row action, carrying the row\'s OWN domain');
  ok(html.includes('aria-label="Delete What did we decide?"'), '…and names the conversation it deletes');
  ok(html.includes('d="' + LIST.TRASH_PATH_D + '"'), 'the glyph is the one trash path');
  const app = read('app.js');
  const appTrash = /trash:\s*'<path d="([^"]+)"\/>'/.exec(app);
  eq(LIST.TRASH_PATH_D, appTrash && appTrash[1], '★ …pinned BYTE-IDENTICAL to app.js ICON_BODY.trash (C9: one glyph)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — groups by LAST USE: Today / Yesterday / Previous 7 days / Earlier (F7)');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(LIST.dayBucket(at(0, 0, 1), NOW), 'today', 'one minute past midnight today is Today');
  eq(LIST.dayBucket(at(1, 23, 59), NOW), 'yesterday', 'a minute before midnight is Yesterday');
  eq(LIST.dayBucket(at(1, 0, 0), NOW), 'yesterday', 'the start of yesterday is Yesterday');
  eq(LIST.dayBucket(at(2), NOW), 'week', 'two days ago is the previous 7 days');
  eq(LIST.dayBucket(at(7, 0, 5), NOW), 'week', 'seven calendar days back is still in the week');
  eq(LIST.dayBucket(at(8), NOW), 'earlier', 'eight days back is Earlier');
  eq(LIST.dayBucket('garbage', NOW), 'earlier', 'an unreadable time claims nothing about recency');
  eq(LIST.dayBucket(new Date(NOW + 3600e3).toISOString(), NOW), 'today', 'a time AHEAD of this clock is never older than today');
  // THE MIDNIGHT CROSSING, which is F7: the same row, re-grouped at the next day.
  const row = { id: 'x', domain: 'articles', createdAt: at(0, 23, 50), updatedAt: at(0, 23, 55) };
  const before = LIST.groupConversations([row], new Date(NOW).setHours(23, 59, 0, 0));
  const nextDay = new Date(NOW); nextDay.setDate(nextDay.getDate() + 1); nextDay.setHours(0, 1, 0, 0);
  const after = LIST.groupConversations([row], nextDay.getTime());
  eq(before[0].key + '>' + after[0].key, 'today>yesterday', '★ a conversation from 23:55 moves from Today to Yesterday at midnight');
  const revived = { id: 'r', domain: 'articles', createdAt: at(30), updatedAt: at(0, 10) };
  eq(LIST.groupConversations([revived], NOW)[0].key, 'today',
    '★ a month-old thread continued this morning is under TODAY — grouped by last use, not by start (C11)');
  const list = [
    { id: 'a', domain: 'articles', createdAt: at(0) }, { id: 'b', domain: 'articles', createdAt: at(20) },
    { id: 'c', domain: 'articles', createdAt: at(3) }, { id: 'd', domain: 'articles', createdAt: at(0) },
  ];
  const g = LIST.groupConversations(list, NOW);
  eq(g.map((x) => x.label).join(' | '), 'Today | Previous 7 days | Earlier', 'empty groups are omitted; the order is fixed');
  eq(g[0].rows.map((r) => r.id).join(), 'a,d', 'inside a group the SERVER\'s order is kept, never re-sorted here');
  const html = LIST.conversationListHtml(ctx({ conversations: list }));
  ok(/<div class="cur-sb-group-head cur-eyebrow">Today<\/div><div class="cur-sb-list">/.test(html),
    'each group is the sidebar kit\'s own group (eyebrow + list)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — the list head, and SELECT MODE (M3)');
// ═════════════════════════════════════════════════════════════════════════
{
  const two = [{ id: 'a', domain: 'articles', title: 'A', createdAt: at(0) }, { id: 'b', domain: 'business', title: 'B', createdAt: at(0) }];
  const head = LIST.listHeadHtml(ctx({ conversations: two, total: 31 }));
  ok(head.includes('id="chat-domain-filter-host"'), 'the head hosts the domain filter (the view mounts the shared listbox into it)');
  ok(/aria-label="31 conversations">31</.test(head), '★ the count is the server\'s TRUE total, not the page length');
  ok(head.includes('id="chat-select-btn">Select<'), 'a "Select" text button enters the mode');
  ok(LIST.listHeadHtml(ctx({ conversations: [] })).includes('id="chat-select-btn" disabled'), '…disabled with nothing to select');
  ok(!LIST.listHeadHtml(ctx({ conversations: two, selectMode: true })).includes('chat-select-btn'), '…and gone while the mode is on (Done leaves it)');
  eq(LIST.truncationHintHtml(ctx({ conversations: two, total: 2 })), '', 'no "showing" line when everything was fetched');
  ok(/Showing the newest 2 of 812\./.test(LIST.truncationHintHtml(ctx({ conversations: two, total: 812 }))),
    '★ …and a true one when the server said there are more');
  ok(/Could not read the conversations in Business\./.test(LIST.unreadableHintHtml(ctx({ unreadable: ['business'] }))),
    '★ an unreadable domain is NAMED, never silently counted as "no conversations"');
  const pane = LIST.conversationPaneHtml(ctx({ conversations: two, selectMode: true, selectedKeys: new Set(['business/b']) }));
  ok(/class="chat-conv-list row-select-mode"/.test(pane), 'the mode puts `.row-select-mode` on the list (row-action.css hides every trash)');
  ok((pane.match(/type="checkbox" class="cur-check cur-check-sm chat-conv-check"/g) || []).length === 2, 'every row gains a checkbox');
  ok(pane.includes('data-conv-check="business/b" checked'), 'keyed by domain AND id');
  ok(pane.includes('>Delete 1<') && !/btn-danger/.test(pane), '★ "Delete 1" is neutral — red belongs to the confirm alone');
  // THE RULE THE MODE LEANS ON, read from the one stylesheet that owns it.
  ok(/\.row-select-mode \.row-act\s*\{\s*display:\s*none;?\s*\}/.test(read('shared/row-action.css')),
    'CONTROL: row-action.css really hides `.row-act` under `.row-select-mode`');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — the wiring, driven');
// ═════════════════════════════════════════════════════════════════════════
{
  const mkEl = (attrs) => ({
    attrs, _l: {}, checked: !!attrs.checked,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener(t, f) { this._l[t] = f; },
    fire(t, e = {}) { this._l[t] && this._l[t](Object.assign({ stopPropagation() { e.stopped = true; } }, e)); return e; },
  });
  const build = (html) => {
    const byAttr = {};
    for (const m of html.matchAll(/<(button|input)\s([^>]*)>/g)) {
      const attrs = {};
      for (const a of m[2].matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? true : a[2].replace(/&amp;/g, '&');
      const el = mkEl(attrs);
      for (const k of Object.keys(attrs)) (byAttr[k] = byAttr[k] || []).push(el);
    }
    return {
      byAttr,
      querySelectorAll: (sel) => byAttr[sel.slice(1, -1)] || [],
      querySelector: (sel) => ((byAttr.id || []).find((e) => '#' + e.attrs.id === sel) || null),
    };
  };
  const calls = [];
  const h = {
    onOpen: (id, d) => calls.push(['open', id, d]), onDelete: (id, d, t) => calls.push(['delete', id, d, t]),
    onToggle: (k, on) => calls.push(['toggle', k, on]), onToggleAll: (on) => calls.push(['all', on]),
    onDeleteSelected: () => calls.push(['bulk']), onSelectMode: (on) => calls.push(['mode', on]), onAsk: () => calls.push(['ask']),
  };
  const rows = [{ id: 'a', domain: 'business', title: 'A & B', createdAt: at(0) }];
  const root = build(LIST.conversationPaneHtml(ctx({ conversations: rows })));
  LIST.wireConversationPane(root, h, { selectMode: false });
  root.byAttr['data-conv-select'][0].fire('click');
  root.byAttr['data-conv-delete'][0].fire('click');
  root.querySelector('#chat-select-btn').fire('click');
  eq(JSON.stringify(calls), JSON.stringify([['open', 'a', 'business'], ['delete', 'a', 'business', 'A & B'], ['mode', true]]),
    '★ a row opens IN ITS DOMAIN; its trash deletes in its domain; Select enters the mode');
  calls.length = 0;
  const sel = build(LIST.conversationPaneHtml(ctx({ conversations: rows, selectMode: true })));
  LIST.wireConversationPane(sel, h, { selectMode: true });
  sel.byAttr['data-conv-select'][0].fire('click');
  const box = sel.byAttr['data-conv-check'][0]; box.checked = true; box.fire('change');
  sel.querySelector('#chat-bulk-all').checked = true; sel.querySelector('#chat-bulk-all').fire('change');
  sel.querySelector('#chat-bulk-delete').fire('click');
  sel.querySelector('#chat-select-done').fire('click');
  eq(JSON.stringify(calls), JSON.stringify([['toggle', 'business/a', null], ['toggle', 'business/a', true], ['all', true], ['bulk'], ['mode', false]]),
    '★ in Select mode a row press TOGGLES (never opens a thread and throws the selection away); the bar\'s controls do their one job each');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — shared/age-ticker.js: one clock, named targets, never a repaint');
// ═════════════════════════════════════════════════════════════════════════
{
  const T0 = Date.parse('2026-09-25T10:00:00.000Z');
  eq(TICK.ageWordsFor('2026-09-25T09:48:00.000Z', T0), '12 min ago', 'the words come from the one vocabulary (formatAge)');
  eq(TICK.ageWordsFor('2026-09-25T09:48:00.000Z', T0, 'started'), 'started 12 min ago', 'a prefix is prepended');
  eq(TICK.ageWordsFor('2026-09-25T11:00:00.000Z', T0), 'just now', 'a time AHEAD of this clock is "just now", never negative');
  eq(TICK.ageWordsFor('nope', T0), null, 'an unreadable time is null — the text is left alone');
  const mk = (attrs, target) => ({
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    querySelector: (sel) => (target && target.sel === sel ? target : null),
    textContent: 'WRAPPER',
  });
  const rowAge = { sel: '.cur-sb-age', textContent: '12 min ago' };
  const row = mk({ 'data-age-at': '2026-09-25T09:48:00.000Z' }, rowAge);
  const readout = { sel: '.tx-readout-value', textContent: 'saved 1 min ago' };
  const foot = mk({ 'data-age-at': '2026-09-25T09:59:00.000Z', 'data-age-prefix': 'saved' }, readout);
  const self = mk({ 'data-age-at': '2026-09-25T08:00:00.000Z', 'data-age-prefix': 'started', 'data-age-text': '' }, null);
  self.textContent = 'started 2 hr ago';
  const bare = mk({ 'data-age-at': '2026-09-25T09:00:00.000Z' }, null);
  const root = { querySelectorAll: (s) => (s === '[data-age-at]' ? [row, foot, self, bare] : []) };
  eq(TICK.tickAges(root, T0), 0, 'nothing changed → NOTHING is written (a no-op write re-announces in a live region)');
  const later = T0 + 50 * 60e3;
  eq(TICK.tickAges(root, later), 2, 'fifty minutes later, exactly the two targets whose WORDS changed are rewritten');
  eq(rowAge.textContent, '1 hr ago', '★ a sidebar row\'s `.cur-sb-age`');
  eq(readout.textContent, 'saved 51 min ago', '★ a readout\'s `.tx-readout-value`, with its prefix');
  eq(self.textContent, 'started 2 hr ago', '…an element that is its own target (unchanged words, so untouched)');
  eq(bare.textContent, 'WRAPPER', '★ an element with NO named target is never written — a wrapper\'s own text is never clobbered');
  ok(TICK.localDayKey(new Date(2026, 8, 25, 23, 59).getTime()) !== TICK.localDayKey(new Date(2026, 8, 26, 0, 1).getTime()),
    'the day key changes across LOCAL midnight — what re-groups the list');
  const src = stripJs(read('shared/age-ticker.js'));
  ok(!/render|innerHTML/.test(src), '★ the ticker contains no render and no innerHTML — it writes textContent only (the v3.53.1 defect)');
  ok(!/^\s*(document|window)\./m.test(src.replace(/function[\s\S]*?\n\}/g, '')), 'and touches no DOM at import');
  // THE SUBSCRIPTION: the view subscribes on mount and unsubscribes in teardown.
  ok(/stopAgeTicker = subscribeAgeTicker\(\{/.test(chatCode) && /if \(stopAgeTicker\) \{ stopAgeTicker\(\); stopAgeTicker = null; \}/.test(chatCode),
    'Chat subscribes on mount and unsubscribes in its teardown');
  ok(/onDayChange: \(\) => \{ if \(isCurrentMount\(mountToken\)\) renderSidebarConversationsOnly\(mountToken\); \}/.test(chatCode),
    '★ the day change re-groups the LIST alone (a light repaint), never the view');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — ADOPTION: the one sidebar row, the one row action, the one identity map, P2\'s answer API');
// ═════════════════════════════════════════════════════════════════════════
{
  const listSrc = stripJs(read('views/chat-list.js'));
  ok(/import \{[^}]*renderSidebarRow[^}]*identitySlotClass[^}]*\} from '\.\.\/shared\/sidebar\.js'/.test(listSrc),
    '★ the conversation pane imports renderSidebarRow and identitySlotClass from the ONE sidebar kit');
  ok((listSrc.match(/renderSidebarRow\(/g) || []).length === 1 && !/class="chat-conv-row/.test(listSrc),
    '…calls it ONCE, and hand-builds no row of its own');
  ok(/class="row-act chat-conv-act"/.test(listSrc), '★ the per-row trash is `.row-act`');
  ok(!/chat-conv-delete|--danger/.test(listSrc + read('views/chat-list.css')), '…and neither the retired class nor a danger ink is anywhere in the pane');
  ok(!/\.chat-conv-delete|\.chat-cite-chip|\.chat-cite-row|\.chat-scope-pill|\.chat-scopebar/.test(stripJs(read('views/chat.css'))),
    'chat.css carries none of the retired idioms (conversation delete, cite chips, scope bar)');
  ok(/import \{ renderAnswer, sourcesHtml, sourceByNumber \} from '\.\.\/shared\/answer\.js'/.test(chatCode),
    '★ Chat imports P2\'s answer API');
  const thread = extractFunction(chatCode, 'renderThreadOnly');
  ok(/renderAnswer\(m\.content \|\| '', \{/.test(thread) && /sourcesHtml\(rendered\.sources, rendered\.mentions\)/.test(thread),
    '★ …renders every answer through it, with the ONE Sources list under it');
  ok(!/chat-cite-row|chat-citation-tag|data-cite=|citationLabel/.test(chatCode),
    '★ the title-chip row, the inline path tags\' handler and citationLabel are gone');
  const click = extractFunction(chatCode, 'onThreadCitationClick');
  ok(/sourceByNumber\(/.test(click) && !/textContent|dataset\.cite\b/.test(click),
    '★ ONE delegated click resolves a NUMBER through sourceByNumber — the path is never read from the DOM');
  ok(/getElementById\('chat-thread'\)\?\.addEventListener\('click', onThreadCitationClick\)/.test(chatCode),
    '…bound once per thread element (renderMain creates it; renderThreadOnly only replaces its contents)');
  ok(/identitySlotClass\(d\.identitySlot\)/.test(extractFunction(chatCode, 'chatHeadMetaHtml')) && /identitySlotClass\(d\.identitySlot\)/.test(extractFunction(chatCode, 'domainPickerCfg')),
    'the header\'s domain dot and the domain pill\'s options use the one identity mapping too');
  ok(read('index.html').includes('<link rel="stylesheet" href="/next/views/chat-list.css">'), 'the pane\'s stylesheet is linked');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — F2: what the answer COST, or today\'s price said as today\'s');
// ═════════════════════════════════════════════════════════════════════════
{
  const ENTRY = { id: 'gemini-3.7-flash', label: 'Flash 3.7', input: 0.75, output: 3.75 };
  const FREE = { id: 'free-model', label: 'Free One', free: true };
  const c = { offerable: { gemini: [ENTRY, FREE] }, availableProviders: ['gemini'] };
  const fns = ['offerableEntries', 'resolveChatModel', 'messageUsageTokens', 'cacheMultipliers', 'messageCostUsd', 'costMarkHtml', 'assistantCostHtml'];
  const api = new Function('escapeHtml', 'formatUsdHonest', fns.map((n) => extractFunction(chatSrc, n)).join('\n') +
    '\nreturn { assistantCostHtml, messageCostUsd };')(esc, formatUsdHonest);
  const usage = { inputTokens: 10000, outputTokens: 1000, cachedReadTokens: 0, cacheWriteTokens: 0 };
  const face = (h) => (/>([^<]*)<\/button>/.exec(h) || [])[1];
  const panel = (h) => (/role="group" aria-label="Token breakdown" hidden>([^<]*)<\/div>/.exec(h) || [])[1];

  const recorded = api.assistantCostHtml({ model: ENTRY.id, usage,
    priced: { free: false, inPerM: 1.5, outPerM: 7.5, costUsd: 0.0225, at: '2026-12-20T09:00:00.000Z' } }, c, 1);
  eq(face(recorded), formatUsdHonest(0.0225), '★ a message that RECORDED its price shows what it cost THEN');
  ok(face(recorded) !== formatUsdHonest(api.messageCostUsd({ model: ENTRY.id, usage }, c)),
    'CONTROL: today\'s catalogue would say something different — so the figure above is not today\'s');
  ok(/Priced when answered on 2026-12-20: \$1\.50 in \/ \$7\.50 out per 1M tokens\./.test(panel(recorded)),
    '★ …and the disclosure says when, and at which rates');
  const legacy = api.assistantCostHtml({ model: ENTRY.id, usage }, c, 2);
  ok(/ at today’s price$/.test(face(legacy)),
    '★ a message from before the record says "at today’s price" ON THE FACE — never presented as what it cost');
  ok(/At today’s price: this answer was written before prices were recorded with each answer\./.test(panel(legacy)),
    '…and the disclosure says why');
  eq(face(api.assistantCostHtml({ model: FREE.id, usage, priced: { free: true, costUsd: 0, at: '2026-09-25T00:00:00.000Z' } }, c)),
    'free', 'a RECORDED free answer says "free"');
  eq(face(api.assistantCostHtml({ model: FREE.id, usage }, c)), 'free today', '…an unrecorded one "free today"');
  const junk = api.assistantCostHtml({ model: ENTRY.id, usage, priced: { free: false, inPerM: -1, outPerM: 7.5, costUsd: 1 } }, c);
  ok(/ at today’s price$/.test(face(junk)), 'a malformed `priced` record is NOT believed — the figure falls back to today\'s, labelled');
  const free0 = api.assistantCostHtml({ model: ENTRY.id, usage, priced: { free: true, costUsd: 0.5 } }, c);
  ok(face(free0) !== 'free', 'a "free" record carrying a non-zero cost is refused');
  // The live turn carries what the server persisted.
  const send = extractFunction(chatCode, 'sendCurrentMessage');
  ok(/priced: data\.priced && typeof data\.priced === 'object' \? data\.priced : null/.test(send) && /project: \(typeof data\.project === 'string' \|\| data\.project === null\)/.test(send),
    'the live answer keeps the server\'s `priced` and `project`, so the live and reloaded threads agree');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — F5: the compile confirm names the fallback it may bill');
// ═════════════════════════════════════════════════════════════════════════
{
  const build = new Function('formatUsdHonest', extractFunction(chatSrc, 'providerDisplayLabel') + '\n' +
    extractFunction(chatSrc, 'buildCompileConfirmCopy') + '\nreturn buildCompileConfirmCopy;')(formatUsdHonest);
  const est = (fallback) => ({ provider: 'gemini', model: 'gemini-3.7-flash',
    estimate: { priceKnown: true, usdLow: 0.004, usdHigh: 0.011, fallback } });
  const paid = build(est({ provider: 'anthropic', model: 'claude-sonnet-5', free: false, priceKnown: true, inPerM: 2, outPerM: 10 }), 'articles', 'T', null);
  ok(/If Gemini "gemini-3\.7-flash" is unavailable, The Curator may fall back to Claude "claude-sonnet-5", priced \$2 \/ \$10 per 1M input \/ output tokens\./.test(paid.detail),
    '★ a priced fallback is named WITH its price, before the spend');
  ok(/may fall back to .*, which is free\./.test(build(est({ provider: 'openrouter', model: 'x:free', free: true, inPerM: null, outPerM: null }), 'a', 'T', null).detail),
    'a free rung says it is free');
  ok(/which has no published price\./.test(build(est({ provider: 'openrouter', model: 'y', free: false, priceKnown: false, inPerM: null, outPerM: null }), 'a', 'T', null).detail),
    'an unpriced rung says so — never a $0');
  const none = build(est(null), 'articles', 'T', null);
  ok(!/fall back/.test(none.detail), 'no chain (or an older server) → no sentence');
  ok(/may fall back/.test(build(est({ provider: 'anthropic', model: 'claude-sonnet-5', free: false, priceKnown: true, inPerM: 2, outPerM: 10 }), 'a', 'T', null, { runLine: true }).detail),
    '…and the sentence survives when the dialog leads with the run line (the run line prices the PRIMARY only)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — the sidebar kit\'s line-three detail is ESCAPED, and its mark is a class NAME');
// ═════════════════════════════════════════════════════════════════════════
{
  const h = renderSidebarRow({ name: 'N', event: 'Articles', eventDetail: '<img src=x onerror=1>', eventMarkClass: 'chat-pmark" onclick="x' });
  ok(!/<img/.test(h) && /&lt;img/.test(h), '★ the detail is escaped — no fourth trusted field');
  ok(!/onclick/.test(h), '★ the mark is a filtered class NAME, so a quote cannot reach an attribute');
  const plain = renderSidebarRow({ name: 'N', event: 'Articles' });
  ok(/<span class="cur-sb-event">Articles<\/span>/.test(plain), 'CONTROL: a row with no detail renders line three exactly as before');
  const detailOnly = renderSidebarRow({ name: 'N', eventDetail: 'curator', eventMarkClass: 'chat-pmark' });
  ok(!/cur-sb-sep/.test(detailOnly.slice(detailOnly.indexOf('cur-sb-event'))), 'no separator when there is nothing before the detail');
  ok(/\.cur-sb-event-detail\s*\{/.test(read('shared/sidebar.css')) && /\.cur-sb-event-mark\s*\{/.test(read('shared/sidebar.css')),
    'both new kit classes resolve a rule in the kit stylesheet');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-list assertions green');
