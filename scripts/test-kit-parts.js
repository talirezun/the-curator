#!/usr/bin/env node
/**
 * test-kit-parts.js — OFFLINE. The shared kit, v1 (2026-11-27): the parts
 * every view rebuilt from phase 2 on must use, driven through their REAL
 * markup and wire functions in a small DOM (test-helpers/kit-dom.js).
 *
 *   §1  status chip — the vocabulary is CLOSED (an unknown kind or word
 *       throws), every chip has a word and a mark, the count form, a CSS
 *       rule and a distinct SHAPE per kind, reduced motion
 *   §2  status tones — ≥ 4.5:1 for the chip's word in BOTH themes, against
 *       --surface and against the chip's own tint, recomputed from
 *       tokens/color.css (with a control that the old light tones fail)
 *   §3  notice — three tones only, the two-action cap, roles, the ≤ 12-word
 *       title warning (once), "Why?" through the one ⓘ mechanism
 *   §4  row — the whole row is the target (one open control per row), the
 *       action never opens it, Space on the link form, no nested control
 *   §5  tabs + segmented — roving tabindex and arrows/Home/End, aria, Pro
 *       tabs drawn only with Pro on, 2–4 choices, no Pro-only choice
 *   §6  data table — sorting (numbers, text, nulls last, stable), aria-sort
 *       on the sorted head only, Pro columns, right-aligned tabular numbers,
 *       a row opens (but not from another control), the stacked labels
 *   §7  the fold rule — `cur-fold` is the one fold: no kit part emits a
 *       <details> or a fold class of its own
 *   §8  page anatomy, verbs, prefix ownership, the dev-only kit page gate
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './test-helpers/kit-dom.js';
import { statusChip, STATUS_KINDS, STATUS_WORDS } from '../src/public/next/shared/status.js';
import { notice, NOTICE_TONES, __resetNoticeWarnings } from '../src/public/next/shared/notice.js';
import { row, wireRows } from '../src/public/next/shared/row.js';
import { tabs, segmented, wireTabs, wireSegmented, tabPanelAttrs, activeTab, nextIndex } from '../src/public/next/shared/tabs.js';
import { table, wireTable, sortRows, nextSort } from '../src/public/next/shared/table.js';
import { objectPage } from '../src/public/next/shared/object-page.js';
import * as VERBS from '../src/public/next/shared/verbs.js';
import { explainerHtml } from '../src/public/next/shared/explainer.js';
import { __setProEnv, __resetPro, setPro } from '../src/public/next/shared/pro.js';
import { kitPageAllowed } from '../src/routes/kit-page.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src', 'public', 'next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function ok(c, m, detail) {
  if (c) { passed++; console.log('  ✓ ' + m); }
  else { failed++; console.log('  ✗ ' + m + (detail !== undefined ? ' — ' + String(detail).slice(0, 400) : '')); }
}
function throws(fn, m) { let t = false; try { fn(); } catch { t = true; } ok(t, m); }
function section(t) { console.log('\n' + t); }
const text = (html) => parse(html).textContent.replace(/\s+/g, ' ').trim();

// ═══════════════════════════════════════════════════════════════════════════
section('§1  STATUS CHIP — a closed vocabulary');
{
  ok(JSON.stringify(STATUS_KINDS) === JSON.stringify(['ready', 'needs-you', 'working', 'off', 'unknown', 'error']),
    'the kinds are exactly the six of decision D9', STATUS_KINDS.join(','));
  ok(Object.isFrozen(STATUS_WORDS) && STATUS_KINDS.every((k) => Object.isFrozen(STATUS_WORDS[k])), 'the vocabulary is frozen');
  const WANT = { ready: 'Ready', 'needs-you': 'Needs you', working: 'Working', off: 'Not connected', unknown: 'Unknown', error: 'Failed' };
  for (const k of STATUS_KINDS) {
    const d = parse(statusChip(k));
    const chip = d.querySelector('.kit-chip');
    ok(chip && chip.classList.contains('kit-chip-' + k) && chip.getAttribute('data-status') === k
       && chip.querySelector('.kit-chip-mark') && chip.querySelector('.kit-chip-mark').getAttribute('aria-hidden') === 'true'
       && chip.querySelector('.kit-chip-label').textContent === WANT[k],
      k + ': shape mark (aria-hidden) + the word "' + WANT[k] + '" + its tone class');
  }
  ok(text(statusChip('off', { label: 'Off' })) === 'Off', 'off may also say "Off"');
  throws(() => statusChip('done'), 'an unknown kind THROWS');
  throws(() => statusChip(''), 'an empty kind THROWS');
  throws(() => statusChip('ready', { label: 'All good' }), 'a word outside the kind\'s list THROWS');
  throws(() => statusChip('error', { label: 'Ready' }), 'another kind\'s word THROWS');
  ok(text(statusChip('needs-you', { count: 21, label: 'to review' })) === '21 to review', 'the count form: "21 to review"');
  ok(text(statusChip('ready', { count: 3527, label: 'pages checked' })) === '3,527 pages checked', 'the count is a fmtCount figure');
  throws(() => statusChip('needs-you', { count: 3 }), 'a count with no label THROWS');
  throws(() => statusChip('needs-you', { count: NaN, label: 'x' }), 'a count that is not a number THROWS');
  ok(text(statusChip('ready', { count: 2, label: '<b>x</b>' })) === '2 <b>x</b>' && !/<b>/.test(statusChip('ready', { count: 2, label: '<b>x</b>' })),
    'the count label is escaped');

  const css = stripCss(read('shared/status.css'));
  const rule = (sel) => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css); return m ? m[1] : null; };
  const defined = [...css.matchAll(/\.kit-chip-([a-z-]+)\s*[{,]/g)].map((m) => m[1]).filter((k) => !['mark', 'label'].includes(k));
  ok(STATUS_KINDS.every((k) => defined.includes(k)) && defined.every((k) => STATUS_KINDS.includes(k)),
    'the stylesheet styles every kind and no other (both directions)', defined.join(','));
  ok(/rotate\(45deg\)/.test(rule('.kit-chip-needs-you .kit-chip-mark') || ''), 'needs you: a DIAMOND');
  ok(/border-radius:\s*1px/.test(rule('.kit-chip-error .kit-chip-mark') || '') && !/rotate/.test(rule('.kit-chip-error .kit-chip-mark') || ''), 'failed: a SQUARE');
  ok(/background:\s*transparent/.test(rule('.kit-chip-off .kit-chip-mark') || '') && /solid/.test(rule('.kit-chip-off .kit-chip-mark') || ''), 'off: a HOLLOW ring');
  ok(/dashed/.test(rule('.kit-chip-unknown .kit-chip-mark') || ''), 'unknown: a DASHED ring');
  ok(/animation:\s*curator-spin/.test(rule('.kit-chip-working .kit-chip-mark') || ''), 'working: a turning ring');
  ok(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.kit-chip-working \.kit-chip-mark\s*\{[^}]*animation:\s*none/.test(css), '…which stands still under reduced motion');
  for (const [k, tok] of [['ready', 'status-ok'], ['needs-you', 'status-attn'], ['error', 'status-err'], ['working', 'status-work'], ['off', 'status-off'], ['unknown', 'status-off']]) {
    ok(new RegExp('color:\\s*var\\(--' + tok + '\\)').test(rule('.kit-chip-' + k) || ''), k + ': its word takes --' + tok);
  }
  ok(!/--id-\d|cur-sb-dot/.test(css), 'no identity colour on a chip (D9: identity stays on the identity dot)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  STATUS TONES — ≥ 4.5:1 in both themes, recomputed from the tokens');
{
  const colorCss = stripCss(read('tokens/color.css'));
  const lightAt = colorCss.indexOf('[data-theme="light"]');
  const block = (s) => { const m = {}; for (const x of s.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) m[x[1]] = x[2].trim(); return m; };
  const dark = block(colorCss.slice(0, lightAt));
  const light = { ...dark, ...block(colorCss.slice(lightAt)) };
  const resolve = (t, name, depth = 0) => {
    let v = t[name];
    if (v === undefined) throw new Error('undefined token ' + name);
    for (let i = 0; i < 10 && /^var\(/.test(v); i++) v = t[/^var\((--[a-z0-9-]+)\)$/.exec(v)[1]];
    return v;
  };
  const rgba = (v) => {
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(v);
    if (m) return [+m[1], +m[2], +m[3], +m[4]];
    throw new Error('unparsed colour ' + v);
  };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  ok(Math.abs(ratio([0, 0, 0], [255, 255, 255]) - 21) < 0.01 && Math.abs(ratio([9, 9, 9], [9, 9, 9]) - 1) < 0.001, 'control: black on white is 21.00, a colour on itself 1.00');
  const TONES = [['--status-ok', '--status-ok-tint'], ['--status-attn', '--status-attn-tint'], ['--status-err', '--status-err-tint'], ['--status-work', '--status-work-tint'], ['--status-off', null]];
  for (const [theme, t] of [['dark', dark], ['light', light]]) {
    const surface = rgba(resolve(t, '--surface'));
    for (const [fgName, tintName] of TONES) {
      const fg = rgba(resolve(t, fgName));
      const onSurface = ratio(fg, surface);
      const onTint = tintName ? ratio(fg, over(rgba(resolve(t, tintName)), surface)) : onSurface;
      const worst = Math.min(onSurface, onTint);
      ok(worst >= 4.5, theme + ' ' + fgName + ': ' + onSurface.toFixed(2) + ' on --surface, ' + onTint.toFixed(2) + ' on its tint (≥ 4.5)');
    }
  }
  // Anti-vacuity: the tokens the light theme could NOT reuse really fail.
  const surfL = rgba(resolve(light, '--surface'));
  ok(ratio(rgba(resolve(light, '--success-text')), surfL) < 4.5 && ratio(rgba(resolve(light, '--attention-text')), surfL) < 4.5,
    'control: light --success-text and --attention-text measure under 4.5 (why --status-* exist)');
  for (const name of ['--status-ok', '--status-attn', '--status-err', '--status-work', '--status-off', '--status-ok-tint', '--status-attn-tint', '--status-err-tint', '--status-work-tint', '--status-attn-border', '--status-err-border']) {
    ok(dark[name] !== undefined && block(colorCss.slice(lightAt))[name] !== undefined, name + ' is defined in BOTH themes');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  NOTICE');
{
  ok(JSON.stringify(NOTICE_TONES) === '["info","attention","error"]', 'three tones');
  throws(() => notice({ tone: 'warning', title: 'x' }), 'an unknown tone THROWS');
  throws(() => notice({ tone: 'info' }), 'a notice with no title THROWS');
  const two = notice({ tone: 'attention', title: 'Two choices', actions: [{ label: 'A', primary: true }, { label: 'B' }] });
  ok(parse(two).querySelectorAll('button').length === 2, 'two actions render as two buttons');
  throws(() => notice({ tone: 'info', title: 'Three', actions: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }), 'a THIRD action THROWS (the cap is two)');
  const roles = Object.fromEntries(NOTICE_TONES.map((t) => [t, parse(notice({ tone: t, title: 'x' })).querySelector('.kit-notice').getAttribute('role')]));
  ok(roles.info === 'status' && roles.attention === 'status' && roles.error === 'alert', 'roles: status, status, alert', JSON.stringify(roles));
  const glyphs = NOTICE_TONES.map((t) => /<svg[\s\S]*?<\/svg>/.exec(notice({ tone: t, title: 'x' }))[0]);
  ok(new Set(glyphs).size === 3, 'each tone has its own glyph SHAPE');
  ok(!glyphs[0].includes('M12 11v5M12 8h.01'), 'the info glyph is not the ⓘ (the explainer\'s control)');
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  __resetNoticeWarnings();
  const long = 'This title has far more than twelve words in it so it should warn once';
  notice({ tone: 'info', title: long }); notice({ tone: 'info', title: long });
  notice({ tone: 'info', title: 'Exactly twelve words are fine here and so this one never warns' });
  console.warn = orig;
  ok(warns.length === 1 && warns[0].includes(long), 'a title over 12 words warns ONCE; twelve does not', JSON.stringify(warns));
  ok(text(notice({ tone: 'info', title: long })).includes(long), '…and is still rendered in full (a warning is never dropped)');
  const why = parse(notice({ tone: 'attention', title: 'Why test', why: 'context.setup', id: 'w1' }));
  const btn = why.querySelector('[data-tx-info]');
  ok(btn && btn.textContent === 'Why?' && btn.getAttribute('data-tx-info') === 'w1' && btn.getAttribute('aria-expanded') === 'false'
     && btn.classList.contains('tx-vh-info') && !btn.hasAttribute('aria-label'),
    '"Why?" is the one ⓘ mechanism (data-tx-info, aria-expanded), named by its visible word');
  const panel = why.querySelector('.tx-vh-panel');
  ok(panel && panel.getAttribute('id') === 'w1' && panel.hasAttribute('hidden')
     && notice({ tone: 'attention', title: 'Why test', why: 'context.setup', id: 'w1' }).includes(explainerHtml('context.setup')),
    '…and opens the explainer entry itself, closed until pressed');
  throws(() => notice({ tone: 'info', title: 'x', why: 'no.such-key' }), 'an unknown explainer key THROWS');
  ok(!/<script|onerror/.test(notice({ tone: 'info', title: '<script>x</script>', line: '<img onerror=1>' }).replace(/&lt;[^&]*&gt;/g, '')), 'title and line are escaped');
  const attrs = parse(notice({ tone: 'info', title: 'x', actions: [{ label: 'Go', attrs: { 'data-go': '1', onclick: 'evil()' } }] })).querySelector('button');
  ok(attrs.getAttribute('data-go') === '1' && !attrs.hasAttribute('onclick'), 'an action takes data-/aria- attributes only');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  ROW — the whole row is the target');
{
  const html = row({ id: 'r1', dot: 'cur-sb-dot-2 bad"class', title: 'Claude Code', meta: 'Last note 27 min ago', status: statusChip('ready'), action: { label: 'Update', attrs: { 'data-up': 'r1' } }, opens: true }) +
    row({ id: 'r2', title: 'Linked', opens: true, href: '/next/#x' }) +
    row({ id: 'r3', title: 'Plain', meta: 'not a door' });
  const d = parse(html);
  const r1 = d.querySelector('[data-kit-row="r1"]');
  const targets = r1.querySelectorAll('[data-kit-row-open]');
  ok(targets.length === 1 && targets[0].tagName === 'BUTTON' && targets[0].textContent === 'Claude Code',
    'ONE open target per row, a <button> named by the title (Enter and Space are a button\'s own)');
  ok(r1.classList.contains('kit-row-opens') && r1.querySelector('.kit-row-chev'), 'a row that opens carries the chevron');
  ok(r1.querySelector('.kit-row-dot').getAttribute('class') === 'kit-row-dot cur-sb-dot cur-sb-dot-2', 'the identity dot class is filtered to the class alphabet', r1.querySelector('.kit-row-dot').getAttribute('class'));
  ok(!targets[0].querySelector('button, a'), 'no control inside the open target (no nested interactive content)');
  ok(r1.querySelectorAll('button').length === 2, 'the row has its open target and its ONE action, nothing else');
  ok(d.querySelector('[data-kit-row="r3"]').querySelectorAll('button, a').length === 0 && !d.querySelector('[data-kit-row="r3"] .kit-row-chev'), 'a row that does not open has no control and no chevron');
  const opened = [];
  wireRows(d, (id, el, e) => { opened.push(id); if (e && e.preventDefault) e.preventDefault(); });
  targets[0].click();
  d.querySelector('[data-up="r1"]').click();
  r1.querySelector('.kit-row-meta').click();
  ok(JSON.stringify(opened) === '["r1"]', 'pressing the title opens; pressing the action does NOT; a press on the meta reaches the stretched target in a browser (scripts/kit-shots.mjs measures that)', JSON.stringify(opened));
  const link = d.querySelector('[data-kit-row="r2"] a[data-kit-row-open]');
  ok(link && link.getAttribute('href') === '/next/#x', 'the link form is a real <a href>');
  const ev = link.dispatch('keydown', { key: ' ' });
  ok(ev.defaultPrevented && opened[1] === 'r2', 'Space on the link form opens it (and does not scroll the page)', JSON.stringify(opened));
  throws(() => row({ title: 'x', opens: true, href: 'javascript:alert(1)' }), 'an unsafe href THROWS');
  throws(() => row({ title: '' }), 'a row with no title THROWS');
  const css = stripCss(read('shared/row.css'));
  ok(/\.kit-row-open\s*\{[^}]*cursor:\s*pointer/.test(css), 'the open target shows the pointer');
  ok(/\.kit-row-open::after\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/.test(css) && /\.kit-row\s*\{[^}]*position:\s*relative/.test(css), 'its ::after is stretched over the row');
  ok(/\.kit-row-opens:hover\s*\{[^}]*var\(--mat-row-hover\)/.test(css), 'a visible hover, on the alpha overlay');
  ok(/\.kit-row-act\s*\{[^}]*z-index:\s*1/.test(css.replace(/\.kit-row-status,\s*/, '')), 'the action sits ABOVE the stretch');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  TABS and SEGMENTED');
{
  const ITEMS = [{ id: 'now', label: 'Now' }, { id: 'agents', label: 'Agents', count: 3 }, { id: 'kit', label: 'Starting kit' },
    { id: 'history', label: 'History', count: 1045, pro: true }];
  const simple = parse(tabs({ id: 'p', label: 'Project', items: ITEMS, active: 'agents', pro: false }));
  const proOn = parse(tabs({ id: 'p', label: 'Project', items: ITEMS, active: 'history', pro: true }));
  ok(simple.querySelectorAll('[role="tab"]').length === 3 && proOn.querySelectorAll('[role="tab"]').length === 4, 'a Pro tab is DRAWN only with Pro on (3 vs 4)');
  ok(!tabs({ id: 'p', items: ITEMS, active: 'now', pro: false }).includes('History'), '…absent, not CSS-hidden, while Pro is off');
  ok(activeTab(ITEMS, 'history', false) === 'now' && activeTab(ITEMS, 'history', true) === 'history', 'a Pro tab active while Pro is off falls back to the first tab');
  const list = simple.querySelector('[role="tablist"]');
  ok(list.getAttribute('aria-label') === 'Project', 'role="tablist" with its name');
  const ts = simple.querySelectorAll('[role="tab"]');
  ok(ts.every((t) => t.getAttribute('aria-controls') === 'p-panel-' + t.getAttribute('data-kit-tab') && t.getAttribute('id') === 'p-tab-' + t.getAttribute('data-kit-tab')),
    'every tab controls its panel by id');
  ok(ts.map((t) => t.getAttribute('aria-selected') + t.getAttribute('tabindex')).join(',') === 'false-1,true0,false-1', 'ROVING: only the selected tab is in the tab order');
  ok(proOn.querySelector('[data-kit-tab="history"] .kit-tab-count').textContent === '1,045', 'a tab count is a fmtCount figure');
  ok(tabPanelAttrs('p', 'agents') === ' role="tabpanel" id="p-panel-agents" aria-labelledby="p-tab-agents" tabindex="0"', 'the panel attributes match the tab');
  const changes = [];
  wireTabs(simple, (id) => changes.push(id));
  const key = (el, k) => el.dispatch('keydown', { key: k });
  ts[1].focus(); key(ts[1], 'ArrowRight');
  ok(simple.doc.activeElement === ts[2] && ts[2].getAttribute('aria-selected') === 'true' && ts[2].getAttribute('tabindex') === '0'
     && ts[1].getAttribute('tabindex') === '-1' && changes[0] === 'kit', 'ArrowRight moves focus AND selection (automatic activation)');
  key(ts[2], 'ArrowRight');
  ok(simple.doc.activeElement === ts[0] && changes[1] === 'now', 'ArrowRight from the last WRAPS to the first');
  key(ts[0], 'ArrowLeft');
  ok(simple.doc.activeElement === ts[2], 'ArrowLeft from the first wraps to the last');
  key(ts[2], 'Home'); ok(simple.doc.activeElement === ts[0], 'Home → first');
  key(ts[0], 'End'); ok(simple.doc.activeElement === ts[2], 'End → last');
  const before = changes.length;
  const e = key(ts[2], 'a');
  ok(changes.length === before && !e.defaultPrevented, 'another key is left alone');
  ts[0].click();
  ok(ts[0].getAttribute('aria-selected') === 'true' && changes[changes.length - 1] === 'now', 'a click selects');
  ok(nextIndex(3, 0, 'ArrowLeft') === 2 && nextIndex(3, 2, 'ArrowRight') === 0 && nextIndex(0, 0, 'Home') === null, 'nextIndex: wrap both ways, nothing to move in an empty strip');

  throws(() => segmented({ id: 's', items: [{ id: 'a', label: 'A' }] }), 'segmented: one choice THROWS');
  throws(() => segmented({ id: 's', items: 'abcde'.split('').map((c) => ({ id: c, label: c })) }), 'segmented: five choices THROW (use the listbox)');
  throws(() => segmented({ id: 's', items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', pro: true }] }), 'segmented: a Pro-only choice THROWS');
  const seg = parse(segmented({ id: 's', label: 'Window', items: [{ id: 'auto', label: 'Automatic' }, { id: '200k', label: '200k' }, { id: '1m', label: '1M' }], active: '200k' }));
  ok(seg.querySelector('[role="radiogroup"]').getAttribute('aria-label') === 'Window', 'role="radiogroup", named');
  const rs = seg.querySelectorAll('[role="radio"]');
  ok(rs.map((r) => r.getAttribute('aria-checked') + r.getAttribute('tabindex')).join(',') === 'false-1,true0,false-1', 'aria-checked, roving tabindex');
  const segChanges = [];
  wireSegmented(seg, (id) => segChanges.push(id));
  rs[1].focus(); key(rs[1], 'ArrowRight');
  ok(seg.doc.activeElement === rs[2] && rs[2].getAttribute('aria-checked') === 'true' && segChanges[0] === '1m', 'arrows move and select');

  // Pro default: tabs() reads shared/pro.js when not told.
  __resetPro(); __setProEnv({ fetch: async (u, init) => { const b = init && init.body ? JSON.parse(init.body) : { uiDetail: 'simple' }; return { ok: true, status: 200, json: async () => ({ uiDetail: b.uiDetail }) }; }, document: null, localStorage: null, toast: () => null });
  await setPro(true);
  ok(parse(tabs({ id: 'p', items: ITEMS, active: 'now' })).querySelectorAll('[role="tab"]').length === 4, 'with no `pro` option the strip follows shared/pro.js (on → 4)');
  await setPro(false);
  ok(parse(tabs({ id: 'p', items: ITEMS, active: 'now' })).querySelectorAll('[role="tab"]').length === 3, '…(off → 3)');
  __resetPro(); __setProEnv(null);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  DATA TABLE');
{
  const COLS = [{ id: 'name', label: 'Name', sort: true }, { id: 'size', label: 'Size', numeric: true, sort: true },
    { id: 'model', label: 'Model', pro: true }, { id: 'note', label: 'Note' }];
  const ROWS = [
    { id: 'a', cells: { name: 'beta', size: { text: '2 KB', sort: 2048 }, model: 'm1', note: '<b>x</b>' } },
    { id: 'b', cells: { name: 'alpha', size: { text: '10 KB', sort: 10240 }, model: 'm2' } },
    { id: 'c', cells: { name: 'Gamma', size: null, model: 'm3' } },
    { id: 'd', cells: { name: 'alpha', size: { text: '1 KB', sort: 1024 } } },
  ];
  const ids = (rows) => rows.map((r) => r.id).join('');
  ok(ids(sortRows(ROWS, COLS, { id: 'size', dir: 'desc' })) === 'badc', 'numbers sort as numbers, descending; an unknown value LAST');
  ok(ids(sortRows(ROWS, COLS, { id: 'size', dir: 'asc' })) === 'dabc', '…ascending; the unknown still last');
  ok(ids(sortRows(ROWS, COLS, { id: 'name', dir: 'asc' })) === 'bdac', 'text sorts case-insensitively and STABLY (alpha, alpha keep their order)');
  ok(ids(sortRows(ROWS, COLS, { id: 'note', dir: 'asc' })) === 'abcd', 'a column that does not sort leaves the order alone');
  ok(JSON.stringify(nextSort(null, 'size', COLS)) === '{"id":"size","dir":"desc"}' && JSON.stringify(nextSort(null, 'name', COLS)) === '{"id":"name","dir":"asc"}'
     && JSON.stringify(nextSort({ id: 'size', dir: 'desc' }, 'size', COLS)) === '{"id":"size","dir":"asc"}',
    'nextSort: numbers start largest-first, text A–Z, a second press flips');
  const html = table({ id: 't1', columns: COLS, rows: ROWS, sortBy: { id: 'size', dir: 'desc' }, opens: true, pro: false });
  const d = parse(html);
  const ths = d.querySelectorAll('th');
  ok(ths.length === 3 && !html.includes('Model') && !html.includes('m1'), 'a Pro column is DRAWN only with Pro on (head and cells)');
  ok(parse(table({ id: 't1', columns: COLS, rows: ROWS, pro: true })).querySelectorAll('th').length === 4, '…and drawn with it');
  ok(ths[1].getAttribute('aria-sort') === 'descending' && !ths[0].hasAttribute('aria-sort') && !ths[2].hasAttribute('aria-sort'),
    'aria-sort on the SORTED head only');
  ok(ths[0].querySelector('button[data-kit-sort="name"]') && !ths[2].querySelector('button'), 'a sortable head is a button; the others are text');
  ok(ths[1].classList.contains('kit-num') && d.querySelectorAll('td.kit-num').length === 4, 'the numeric column is right-aligned (head and cells)');
  ok(d.querySelectorAll('td').every((td) => td.hasAttribute('data-label')), 'every cell carries data-label (the stacked layout)');
  ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), 'a plain cell is escaped');
  ok(d.querySelectorAll('tbody tr').map((tr) => tr.getAttribute('data-kit-row')).join('') === 'badc', 'the rows render in sorted order');
  const firstCells = d.querySelectorAll('tbody tr').map((tr) => tr.querySelector('td'));
  ok(firstCells.every((td) => td.querySelector('button[data-kit-row-open]')), 'a row that opens has ONE keyboard target, in its first cell');
  const seen = { sort: [], open: [] };
  wireTable(d, { onSort: (c, t) => seen.sort.push(c + '@' + t), onOpen: (id) => seen.open.push(id) });
  ths[0].querySelector('button').click();
  d.querySelector('tr[data-kit-row="b"] td.kit-num').click();
  d.querySelector('tr[data-kit-row="a"] button[data-kit-row-open]').click();
  ok(seen.sort.join() === 'name@t1', 'a head press asks for that sort', seen.sort.join());
  ok(seen.open.join() === 'b,a', 'a press anywhere on the row, or on its first-cell button, opens it', seen.open.join());
  const withBtn = parse(table({ id: 't2', columns: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }], opens: true,
    rows: [{ id: 'r', cells: { x: 'a', y: { html: '<button type="button" data-other>Do</button>' } } }] }));
  const got = [];
  wireTable(withBtn, { onOpen: (id) => got.push(id) });
  withBtn.querySelector('[data-other]').click();
  ok(got.length === 0, 'a press on ANOTHER control in the row does not open it');
  throws(() => table({ id: '1bad', columns: COLS, rows: [] }), 'a bad table id THROWS');
  const css = stripCss(read('shared/table.css'));
  ok(/\.kit-num\s*\{[^}]*text-align:\s*right[^}]*font-variant-numeric:\s*var\(--numeric-tabular\)/.test(css), 'numbers: right-aligned, tabular figures');
  ok(/@media \(max-width: 900px\)[\s\S]*display:\s*block[\s\S]*content:\s*attr\(data-label\)/.test(css), 'below 900 px the rows stack with their labels');
  ok(/\.kit-tr-opens\s*\{[^}]*cursor:\s*pointer/.test(css) && /\.kit-th-btn\s*\{[^}]*cursor:\s*pointer/.test(css), 'an opening row and a sort head show the pointer');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  THE FOLD RULE — `cur-fold` is the one fold');
const KIT_JS = ['format.js', 'status.js', 'notice.js', 'row.js', 'tabs.js', 'table.js', 'object-page.js', 'verbs.js'];
const KIT_CSS = ['status.css', 'notice.css', 'row.css', 'tabs.css', 'table.css', 'object-page.css'];
{
  for (const f of KIT_JS) {
    const src = read('shared/' + f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok(!/<details|<summary/.test(src), 'shared/' + f + ' emits no <details>/<summary> (a fold is shared/section.js renderFoldRow, cur-fold)');
  }
  for (const f of KIT_CSS) ok(!/fold|details|summary/i.test(stripCss(read('shared/' + f))), 'shared/' + f + ' styles no fold of its own');
  ok(/class="' \+ cls\('cur-fold'/.test(read('shared/section.js')), 'control: the one fold really is shared/section.js\'s cur-fold');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  PAGE ANATOMY, VERBS, PREFIX OWNERSHIP, THE KIT PAGE GATE');
{
  const html = objectPage({ identityDot: 'cur-sb-dot-1', kicker: 'Work · project', title: 'my-<app>', statusSentence: 'Claude Code saved a note 27 minutes ago.',
    primaryAction: '<button type="button" class="btn btn-primary">Connect</button>', moreMenu: '<button type="button">···</button>',
    tabs: tabs({ id: 'op', items: [{ id: 'now', label: 'Now' }], active: 'now', pro: false }), body: '<div' + tabPanelAttrs('op', 'now') + '>b</div>' });
  const order = ['kit-op-head', 'kit-op-status', 'kit-op-tabs', 'kit-op-body'].map((c) => html.indexOf('class="' + c));
  ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'header → one status sentence → tab strip → body, in that order');
  ok((html.match(/<h1/g) || []).length === 1 && html.includes('my-&lt;app&gt;'), 'one <h1>, the title escaped');
  ok(!/<section|cur-section-num|settings-block-num/.test(html), 'no numbered sections');
  throws(() => objectPage({}), 'a page with no title THROWS');
  ok(VERBS.CHECK_AGAIN === 'Check again' && VERBS.SYNC_NOW === 'Sync now' && VERBS.CONNECT === 'Connect' && VERBS.ADD === 'Add' && VERBS.OPEN === 'Open'
     && Object.isFrozen(VERBS.VERBS), 'the verb list');

  // Prefix ownership: the kit sheets define kit- classes only (the ⓘ word form
  // lives in shared/text.css, which owns tx-), and no other sheet defines kit-.
  for (const f of KIT_CSS) {
    const classes = [...stripCss(read('shared/' + f)).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]);
    const foreign = classes.filter((c) => !c.startsWith('kit-') && !/^is-/.test(c) && !/^\d/.test(c));   // `is-` = a state (listbox's convention)
    ok(foreign.length === 0, 'shared/' + f + ' styles only `kit-` classes (and `is-` states)', foreign.join(','));
  }
  const walk = (dir, rel = '') => readdirSync(path.join(NEXT, dir), { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name), path.join(rel, e.name)) : e.name.endsWith('.css') ? [path.join(rel, e.name)] : []);
  const others = walk('.').filter((r) => !KIT_CSS.includes(path.basename(r)) || !r.startsWith('shared'));
  const leak = others.filter((r) => /\.kit-[a-z]/.test(stripCss(read(r))));
  ok(leak.length === 0, 'no other stylesheet defines a `kit-` rule', leak.join(','));
  const index = read('index.html');
  ok(KIT_CSS.every((f) => index.includes('<link rel="stylesheet" href="/next/shared/' + f + '">')), 'index.html links every kit sheet');

  // The dev-only kit page.
  ok(kitPageAllowed({ env: {} }) === false, 'kit page: NOT served without the flag (any install)');
  ok(kitPageAllowed({ env: { CURATOR_KIT_PAGE: '1' } }) === true, 'kit page: served with CURATOR_KIT_PAGE=1');
  ok(kitPageAllowed({ env: { CURATOR_KIT_PAGE: 'true' } }) === false && kitPageAllowed({ env: null }) === false, 'kit page: only the exact flag value "1"');
  ok(!/isRepoInstall|isBundleInstall|getInstallMode/.test(readFileSync(path.join(ROOT, 'src', 'routes', 'kit-page.js'), 'utf8').replace(/\/\/[^\n]*/g, '')),
    'kit page: the gate does not branch on the install form (test-install-mode.js\'s rule)');
  ok(existsSync(path.join(ROOT, 'src', 'dev', 'kit', 'kit.html')) && !existsSync(path.join(NEXT, 'kit.html')) && !existsSync(path.join(NEXT, 'kit.js')),
    'the kit page lives OUTSIDE src/public (the static mount can never serve it)');
  const app = read('app.js');
  ok(!/kit\.html/.test(app) && !/kit\.html/.test(index), 'nothing in the app links to the kit page');
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
process.exit(failed ? 1 : 0);
