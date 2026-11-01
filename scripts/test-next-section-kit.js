#!/usr/bin/env node
/**
 * test-next-section-kit.js — THE SECTION KIT (shared/section.js + section.css, v3.89.0)
 *
 * The Domain page's section head, card, control row, fold rows, fold items,
 * tinted action card and one-line status card moved into a shared kit so a
 * second page (Settings › MCP bridge) can draw the same objects. The move was
 * required to be INVISIBLE on the Domain page, and was measured so (a
 * before/after pixel comparison). This suite pins what keeps it that way:
 *
 *   §1  each renderer's markup — the kit's names, and the host's historical
 *       names beside them ONLY when the host asks (`alias: 'dm'` / `'sb'`);
 *   §2  trust: every plain string escaped, class and id slots filtered, a
 *       style value only ever a validated number;
 *   §3  the two copies the kit carries (escapeHtml, the chevron) equal their
 *       sources byte for byte;
 *   §4  shared/section.css holds the moved values (written out here as
 *       literals, so a retune is a decision this suite sees), and the old
 *       rules are GONE from views/domains.css and views/shared.css — one
 *       source, not two;
 *   §5  the kit owns its prefixes outright, and index.html links the sheet
 *       after every other shared sheet and before the view sheets (the
 *       cascade position the moved rules had).
 *
 * OFFLINE. No network, no browser.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as K from '../src/public/next/shared/section.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');
const read = (p) => readFileSync(join(NEXT, p), 'utf8');
const KIT_JS = read('shared/section.js');
const KIT_CSS = read('shared/section.css');
const stripCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 500)));
  return false;
}
function eq(msg, got, want) { return ok(got === want, msg, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

const CHEV = K.FOLD_CHEVRON;

// ═════════════════════════════════════════════════════════════════════════
section('§1  THE MARKUP — kit names always, host names only on request');
// ═════════════════════════════════════════════════════════════════════════
{
  eq('renderSectionTitle, aliasless',
    K.renderSectionTitle({ num: 2, title: 'Bridge' }),
    '<div class="cur-section-hd"><span class="cur-section-num" aria-hidden="true">2</span>'
    + '<div class="cur-group-title cur-section-title">Bridge</div></div>');
  eq('renderSectionTitle, the Domain page\'s Pages head (extra class, ⓘ inside the row)',
    K.renderSectionTitle({ num: 2, title: 'Pages', titleClass: 'dm-recent-eyebrow', infoBtnHtml: '<B/>', alias: 'dm' }),
    '<div class="cur-section-hd dm-section-hd"><span class="cur-section-num dm-section-num" aria-hidden="true">2</span>'
    + '<div class="cur-group-title cur-section-title dm-recent-eyebrow dm-section-eyebrow">Pages</div><B/></div>');
  eq('renderSectionHead — ①\'s head block, byte for byte with the dm alias',
    K.renderSectionHead({ num: 1, title: 'Ingest', titleId: 'dm-sources-title', focusable: true,
      info: { btn: '<B/>', panel: '<P/>' }, meta: 'last ingest 2 weeks ago', hostClass: 'dm-sources-hd', alias: 'dm' }),
    '<div class="cur-section-head dm-section dm-section-hd-block dm-sources-hd"><div class="cur-section-head-row dm-section-head-row">'
    + '<div class="cur-section-hd dm-section-hd"><span class="cur-section-num dm-section-num" aria-hidden="true">1</span>'
    + '<div class="cur-group-title cur-section-title dm-section-eyebrow" id="dm-sources-title" tabindex="-1">Ingest</div></div>'
    + '<B/><span class="cur-section-meta dm-fold-meta dm-section-meta">last ingest 2 weeks ago</span></div><P/></div>');
  ok(/<span class="cur-section-meta" id="r"><\/span>/.test(K.renderSectionHead({ num: 4, title: 'T', meta: '', metaId: 'r' })),
    'an EMPTY reading keeps its slot (④ writes into it in place once the panel reports)');
  ok(!/cur-section-meta/.test(K.renderSectionHead({ num: 4, title: 'T' })), '…and no reading at all renders no slot');
  eq('renderCard with the loading reserve',
    K.renderCard('x', { alias: 'dm', busy: true, minHeight: 452 }),
    '<div class="cur-card dm-health-card" aria-busy="true" style="min-height:452px">x</div>');
  eq('renderCard plain', K.renderCard('x'), '<div class="cur-card">x</div>');
  eq('renderControlRow', K.renderControlRow('<b/>', { alias: 'dm' }), '<div class="cur-card-top dm-health-top"><b/></div>');
  eq('renderFoldRows', K.renderFoldRows('r', { alias: 'sb' }), '<div class="cur-folds sb-sec-rows">r</div>');
  eq('renderFoldRow — an issue group (pill + action)',
    K.renderFoldRow({ key: 'brokenLinks', label: 'Broken links', pill: 2, open: true, actionHtml: '<A/>', bodyHtml: 'b', alias: 'dm' }),
    '<details class="cur-fold dm-group" data-group-key="brokenLinks" open><summary class="cur-fold-summary dm-group-summary">' + CHEV
    + '<span class="cur-fold-label dm-group-label">Broken links</span><span class="cur-fold-pill dm-group-pill">2</span><A/></summary>'
    + '<div class="cur-fold-body dm-group-body">b</div></details>');
  eq('renderFoldRow — a Shared Brain row (reading, its own key attribute)',
    K.renderFoldRow({ key: 'c1:token', label: 'Access token', meta: 'works', bodyHtml: 'b', alias: 'sb' }),
    '<details class="cur-fold sb-sec-row" data-sb-sec-row="c1:token"><summary class="cur-fold-summary sb-sec-row-summary">' + CHEV
    + '<span class="cur-fold-label sb-sec-row-label">Access token</span><span class="cur-fold-meta sb-sec-row-meta">works</span></summary>'
    + '<div class="cur-fold-body sb-sec-row-body">b</div></details>');
  eq('renderFoldRow aliasless uses the kit\'s own key attribute',
    K.renderFoldRow({ key: 'bridge', label: 'Bridge answers', meta: '24 tools' }),
    '<details class="cur-fold" data-fold-key="bridge"><summary class="cur-fold-summary">' + CHEV
    + '<span class="cur-fold-label">Bridge answers</span><span class="cur-fold-meta">24 tools</span></summary>'
    + '<div class="cur-fold-body"></div></details>');
  eq('renderFoldItem — main, meta, action',
    K.renderFoldItem({ main: 'a/b.md', meta: 'fact', actionHtml: '<A/>', alias: 'dm' }),
    '<div class="cur-fold-item dm-issue-row"><span class="mono cur-fold-item-main dm-issue-main">a/b.md</span>'
    + '<span class="cur-fold-item-meta dm-issue-meta">fact</span><A/></div>');
  eq('renderFoldItem — an absent part renders no span, an EMPTY one keeps its slot',
    K.renderFoldItem({ meta: '' }), '<div class="cur-fold-item"><span class="cur-fold-item-meta"></span></div>');
  eq('actionChip — the AI tier with its cost',
    K.actionChip({ tier: 'ai', action: 'orphans', label: 'Rescue 2 orphans', cost: '≈ $0.01', leadHtml: '<S/>', alias: 'dm' }),
    '<button class="btn btn-ai btn-xs cur-action-chip dm-quick-btn" data-action="orphans"><S/>'
    + '<span class="cur-action-label dm-quick-label">Rescue 2 orphans</span><span class="cur-action-cost dm-quick-cost">≈ $0.01</span></button>');
  eq('actionChip — disabled, no cost', K.actionChip({ label: 'Fix', disabled: true }),
    '<button class="btn btn-secondary btn-xs cur-action-chip" disabled><span class="cur-action-label">Fix</span></button>');
  ok(K.actionChip({ label: 'F', disabled: true, attrs: ' disabled aria-describedby="x"' }).includes('aria-describedby="x">')
    && (K.actionChip({ label: 'F', disabled: true, attrs: ' disabled aria-describedby="x"' }).match(/disabled/g) || []).length === 1,
    '`attrs` REPLACES the plain disabled (the no-key run line\'s attributes), never doubles it');
  eq('renderActionCard — Quick maintenance\'s anatomy',
    K.renderActionCard({ iconHtml: '<I/>', eyebrow: 'QUICK MAINTENANCE', chipsHtml: '<C/>', runHtml: '<R/>', footnoteHtml: '<F/>', alias: 'dm' }),
    '<div class="cur-action dm-quick"><div class="cur-action-eyebrow dm-quick-eyebrow cur-eyebrow"><I/> QUICK MAINTENANCE</div>'
    + '<div class="cur-action-chips dm-quick-actions"><C/></div><div class="cur-action-run dm-quick-run"><R/></div>'
    + '<div class="cur-action-footnote dm-quick-footnote"><F/></div></div>');
  ok(!/cur-action-run|cur-action-footnote/.test(K.renderActionCard({ eyebrow: 'E' })), 'an empty run line or footnote renders no wrapper');
  eq('renderStatusLine — the Shared Brain section\'s empty state',
    K.renderStatusLine('This domain isn’t part of a Shared Brain.', '<D/>', { alias: 'sb' }),
    '<div class="cur-status-line sb-sec-empty"><p class="cur-status-line-text sb-sec-line sb-sec-empty-text">'
    + 'This domain isn’t part of a Shared Brain.</p><D/></div>');
  // No host's names leak to a caller that did not ask for them.
  const plain = [K.renderSectionHead({ num: 1, title: 'T', meta: 'm' }), K.renderCard('x'), K.renderControlRow(''),
    K.renderFoldRows(K.renderFoldRow({ label: 'L', pill: 1 })), K.renderFoldItem({ main: 'm' }),
    K.renderActionCard({ eyebrow: 'E', chipsHtml: K.actionChip({ label: 'c' }) }), K.renderStatusLine('s')].join('');
  ok(!/\b(dm|sb)-/.test(plain), 'an aliasless caller gets kit names only — no dm- or sb- string', plain.match(/\b(dm|sb)-[\w-]+/));
  ok(!/\bdm-/.test(K.renderFoldRow({ label: 'L', alias: 'sb' })) && !/\bsb-/.test(K.renderFoldRow({ label: 'L', alias: 'dm' })),
    '…and one host never gets the other\'s');
  ok(!/\bdm-|\bsb-/.test(K.renderFoldRow({ label: 'L', alias: 'nope' })), 'an unknown alias is no alias');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  TRUST — escaped strings, filtered slots');
// ═════════════════════════════════════════════════════════════════════════
{
  const X = '<img src=x onerror=alert(1)>"\'&';
  const all = [
    K.renderSectionTitle({ num: X, title: X }), K.renderSectionHead({ num: 1, title: X, meta: X }),
    K.renderFoldRow({ key: X, label: X, pill: X, meta: X }), K.renderFoldItem({ main: X, meta: X }),
    K.actionChip({ label: X, cost: X, action: X }), K.renderActionCard({ eyebrow: X }), K.renderStatusLine(X),
  ];
  ok(all.every((h) => !h.includes('<img')), 'every plain string is escaped', all.find((h) => h.includes('<img')));
  ok(all.every((h) => !/="[^"]*"[^ >]*"/.test(h.replace(/&quot;/g, ''))) && all.every((h) => !/onerror=alert\(1\)>/.test(h)),
    'no attribute can be broken out of');
  eq('a class slot keeps only class-name tokens', K.renderCard('', { hostClass: 'ok bad"x <b> also-ok' }), '<div class="cur-card ok also-ok"></div>');
  ok(!/id=/.test(K.renderSectionTitle({ num: 1, title: 't', titleId: 'a" onclick="x' })), 'a malformed id is dropped, not escaped-and-hoped');
  ok(!/style/.test(K.renderCard('', { minHeight: '1px;background:red' })) && !/style/.test(K.renderCard('', { minHeight: -4 }))
    && !/style/.test(K.renderCard('', { minHeight: Infinity })), 'a min-height that is not a sane NUMBER emits no style at all');
  ok(/min-height:452.5px/.test(K.renderCard('', { minHeight: 452.5 })), '…and a measured fractional height is kept as measured');
  ok(K.renderStatusLine('<span class="sb-sec-dom">d</span>', '', { textIsHtml: true }).includes('<span class="sb-sec-dom">'),
    'renderStatusLine with textIsHtml passes a pre-escaped sentence through (state B\'s identity dots)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  THE TWO COPIES EQUAL THEIR SOURCES');
// ═════════════════════════════════════════════════════════════════════════
{
  const fnSrc = (src, name) => {
    const at = src.indexOf('function ' + name + '(');
    let i = src.indexOf('{', at), d = 0;
    for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1); }
    return null;
  };
  const mine = fnSrc(KIT_JS, 'escapeHtml');
  ok(mine && mine === fnSrc(read('shared/overview.js'), 'escapeHtml'), 'escapeHtml is byte-identical to shared/overview.js\'s');
  // The chevron: rebuilt from app.js's own icon() and ICON_BODY source, which
  // cannot be imported (app.js touches `document` at module scope).
  const APP = read('app.js');
  const body = (/\n\s*chevronRight:\s*'([^']*)'/.exec(APP) || [])[1];
  const iconFn = fnSrc(APP, 'icon');
  ok(body && iconFn, 'CONTROL — app.js still has icon() and the chevronRight body');
  const icon = new Function('ICON_BODY', 'MISSING_ICON_BODY', 'console', iconFn + '\nreturn icon;')(
    { chevronRight: body }, '', console);
  eq('FOLD_CHEVRON is byte-identical to icon(\'chevronRight\', 13)', CHEV, icon('chevronRight', 13));
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  shared/section.css — the moved values, and ONE source');
// ═════════════════════════════════════════════════════════════════════════
{
  const bare = stripCss(KIT_CSS);
  const decls = (css, sel) => {
    const re = new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    const out = {};
    for (const m of css.matchAll(re)) for (const d of m[1].split(';')) {
      const i = d.indexOf(':'); if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    return out;
  };
  // The values views/domains.css carried at v3.88.0, written out.
  const WANT = {
    '.cur-section-hd': { display: 'flex', 'align-items': 'baseline', gap: 'var(--space-6)', margin: '0 0 var(--space-4)' },
    '.cur-section-num': { width: '20px', height: '20px', 'border-radius': 'var(--radius-full)', 'font-size': 'var(--text-xs)',
      'font-weight': 'var(--weight-semibold)', background: 'var(--accent-tint)', color: 'var(--accent-text)',
      border: '1px solid var(--accent-border)', transform: 'translateY(2px)' },
    '.cur-section-hd .cur-section-title': { margin: '0', 'font-family': 'var(--font-sans)', 'font-size': 'var(--text-lg)',
      'font-weight': 'var(--weight-semibold)', 'letter-spacing': '-0.01em', 'text-transform': 'none', color: 'var(--text)' },
    '.cur-section-head': { 'margin-bottom': 'var(--space-4)' },
    '.cur-section-head-row': { display: 'flex', 'align-items': 'center', gap: 'var(--space-2)' },
    '.cur-section-meta': { 'margin-left': 'auto', flex: '0 1 auto', 'min-width': '12ch', 'font-size': 'var(--text-2xs)',
      color: 'var(--text-2)', 'text-align': 'right' },
    '.cur-card': { padding: '16px', 'border-radius': 'var(--radius-lg)', border: '1px solid var(--hairline)',
      background: 'var(--surface)', 'box-shadow': 'var(--elev-1)', 'margin-bottom': '24px' },
    '.cur-card-top': { display: 'flex', 'align-items': 'flex-start', 'justify-content': 'space-between', gap: '12px',
      'flex-wrap': 'wrap', 'margin-bottom': '6px' },
    '.cur-folds': { display: 'flex', 'flex-direction': 'column', gap: '2px' },
    '.cur-fold': { 'border-top': '1px solid var(--border-subtle)' },
    '.cur-fold:first-child': { 'border-top': 'none' },
    '.cur-fold-summary': { display: 'flex', 'align-items': 'center', 'flex-wrap': 'wrap', gap: '8px', padding: '10px 2px',
      'list-style': 'none' },
    '.cur-fold-pill': { 'font-size': 'var(--text-2xs)', background: 'var(--surface-inset)', 'border-radius': 'var(--radius-full)',
      padding: '1px 8px' },
    '.cur-fold-body': { display: 'flex', 'flex-direction': 'column', padding: '2px 2px 10px 21px' },
    '.cur-fold-item': { display: 'flex', 'align-items': 'center', gap: '10px', padding: '5px 0',
      'border-bottom': '1px solid var(--border-subtle)' },
    '.cur-fold-item-main': { flex: '1', 'min-width': '0', 'font-size': 'var(--text-2xs)', 'overflow-wrap': 'anywhere' },
    '.cur-action': { padding: '14px', 'border-radius': 'var(--radius-lg)', border: '1px solid var(--accent-border)',
      background: 'var(--accent-tint)', 'margin-bottom': '16px' },
    '.cur-action-eyebrow': { display: 'flex', gap: '6px', color: 'var(--accent-text)', 'margin-bottom': '10px' },
    '.cur-action-chips': { display: 'flex', 'flex-wrap': 'wrap', gap: '8px' },
    '.cur-action-chip': { gap: '6px' },
    '.cur-action-cost': { 'font-size': 'var(--text-2xs)', color: 'var(--text-2)' },
    '.cur-action-run': { 'margin-top': '4px' },
    '.cur-action-footnote': { 'margin-top': '10px' },
    '.cur-status-line': { padding: '14px', display: 'flex', 'justify-content': 'space-between', gap: '12px', 'flex-wrap': 'wrap' },
  };
  for (const [sel, want] of Object.entries(WANT)) {
    const got = decls(bare, sel);
    const bad = Object.entries(want).filter(([p, v]) => got[p] !== v);
    ok(bad.length === 0, sel + ' carries the moved values', bad.map(([p, v]) => p + ': ' + got[p] + ' ≠ ' + v).join('; '));
  }
  // ONE SOURCE. Each of these rules existed in views/domains.css (or as a
  // by-value copy in views/shared.css) and now exists only in the kit.
  const dm = stripCss(read('views/domains.css'));
  const sb = stripCss(read('views/shared.css'));
  const ruleFor = (css, sel) => new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[,{]').test(css);
  for (const sel of ['.dm-section-hd', '.dm-section-num', '.dm-section-head-row', '.dm-fold-meta', '.dm-health-card',
    '.dm-health-top', '.dm-quick', '.dm-quick-eyebrow', '.dm-quick-actions', '.dm-quick-btn', '.dm-quick-label',
    '.dm-quick-cost', '.dm-quick-run', '.dm-quick-footnote', '.dm-groups', '.dm-group', '.dm-group-summary',
    '.dm-group-label', '.dm-group-meta', '.dm-group-pill', '.dm-group-body', '.dm-issue-row', '.dm-issue-main', '.dm-issue-meta']) {
    ok(!ruleFor(dm, sel), 'views/domains.css no longer defines ' + sel + ' (it lives in the kit)');
  }
  for (const sel of ['.sb-sec-empty', '.sb-sec-empty-text', '.sb-sec-row-summary', '.sb-sec-row-label', '.sb-sec-row-meta']) {
    ok(!ruleFor(sb, sel), 'views/shared.css no longer copies ' + sel);
  }
  ok(ruleFor(dm, '.dm-section-hd + .dm-section') && ruleFor(dm, '.dm-sources-hd .dm-section-head-row'),
    'CONTROL — the Domain page\'s CONTEXT rules (column rhythm, ①\'s wrap) stay in its own sheet, on its own names');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  PREFIX OWNERSHIP, AND THE CASCADE POSITION');
// ═════════════════════════════════════════════════════════════════════════
{
  const index = read('index.html');
  const sheets = [...index.matchAll(/<link rel="stylesheet" href="\/next\/([^"]+\.css)">/g)].map((m) => m[1]);
  const at = sheets.indexOf('shared/section.css');
  ok(at >= 0, 'index.html links shared/section.css');
  const lastShared = Math.max(...sheets.map((s, i) => (s.startsWith('shared/') && s !== 'shared/section.css' ? i : -1)));
  const firstView = sheets.findIndex((s) => s.startsWith('views/'));
  ok(at > lastShared && at < firstView, '…after every other shared sheet and before the first view sheet', sheets.join(', '));
  // No other stylesheet in /next names the kit's prefixes in a selector.
  const PREFIX = /\.cur-(section|card|fold|folds|action|status-line)\b/;
  const offenders = sheets.filter((s) => s !== 'shared/section.css' && PREFIX.test(stripCss(read(s))));
  ok(offenders.length === 0, 'no other stylesheet styles a cur-section / cur-card / cur-fold / cur-action / cur-status-line name', offenders.join(', '));
  ok(!/\.(dm|sb)-/.test(stripCss(KIT_CSS)), 'shared/section.css names no host prefix — the aliases carry no rules here');
  ok(!/document|window\./.test(KIT_JS.replace(/\/\/[^\n]*/g, '')), 'shared/section.js is DOM-free (an offline suite imports it)');
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('Section-kit assertions FAILED'); process.exit(1); }
console.log('Section kit holds');
