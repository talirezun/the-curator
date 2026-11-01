#!/usr/bin/env node
/**
 * test-next-page-contract.js — THE PAGE CONTRACT, AND THE PAGES HELD TO IT (v3.89.0)
 *
 * scripts/test-helpers/page-contract.js checks a page's RENDERED markup
 * against measurable rules: a per-page class allow-list (layer 1) and the
 * structure a section-kit page must have (layer 2: the column sequence, every
 * button inside a card, every <details> a kit fold row, no monitor head, a
 * footnote only as the last line of what it qualifies, no inline style, at
 * most one primary button, optionally no mono inside prose).
 *
 * This suite does three things:
 *
 *   §1  proves the helper's parser reads the shapes the kit emits;
 *   §2  proves EVERY rule by a positive control — a compliant page built from
 *       the REAL section kit passes, and each mutation from the redesign's
 *       guard design (a description between two cards, a button moved out of
 *       its control row, an inline margin, a monitor given a head, a page-
 *       private class, a bare <details>, stray text, a second primary, a mono
 *       span in a sentence) turns it red, by name;
 *   §3  runs the PAGE REGISTRY: one entry per page, each with its own
 *       allow-list. An entry is ENFORCED or not yet — Settings › MCP bridge's
 *       contract is written here and is enforced by the step that rebuilds
 *       that page; the Domain page's ⑤ Wiki health card is the first enforced
 *       client, rendered from the real views/domains.js.
 *
 * OFFLINE. No network, no browser, no user data.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPageContract, parseHtml, walk, KIT_CLASSES } from './test-helpers/page-contract.js';
import { SECTION_KIT, SECTION_KIT_NAMES, SECTION_KIT_VALUES } from './test-helpers/section-kit.js';
import { renderMonitor } from '../src/public/next/shared/monitor.js';
import { renderOverview } from '../src/public/next/shared/overview.js';
import { renderStatus, renderDescription, renderViewHeader } from '../src/public/next/shared/text.js';
import { freshnessTier, formatAge } from '../src/public/next/shared/age.js';
import { explainerMark } from '../src/public/next/shared/explainer.js';
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';
import { renderRunsOn, renderSpent, aiActionDisabledAttrs } from '../src/public/next/shared/ai-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOMAINS_JS = readFileSync(join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
const K = SECTION_KIT;

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 600)));
  return false;
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

// ═════════════════════════════════════════════════════════════════════════
//  THE CONTRACTS — one per page, each with its own allow-list
// ═════════════════════════════════════════════════════════════════════════

// The depth bar's fill is its one documented inline style (shared/monitor.js
// renderDepthCell writes a computed percentage); nothing else may carry one.
const DEPTH_BAR_WIDTH = /^width:\d+(\.\d+)?%$/;

/** A section-kit page (the MCP bridge page's target shape, PROPOSAL §4–§5). */
const MCP_CONTRACT = Object.freeze({
  name: 'Settings › MCP bridge',
  allow: [...KIT_CLASSES, 'settings-ov-ok', 'settings-ov-attn'],
  forbid: ['mcpi-*', 'mcp-*', 'settings-block-footnote', 'settings-btn-row', 'settings-block*'],
  column: {
    kinds: [['header', ['tx-vh']], ['overview', ['cur-ov']], ['head', ['cur-section-head']],
      ['card', ['cur-card']]],
    pattern: /^header overview( head card)+$/,
  },
  buttonHomes: ['cur-card', 'cur-ov'],
  foldClass: 'cur-fold',
  noMonitorHead: true,
  footnotes: { classes: ['tx-desc', 'tx-note'], lastIn: ['cur-card', 'cur-fold-body'],
    slots: ['cur-action-footnote', 'cur-mon-note', 'tx-vh-panel'] },
  styleAllow: [/^--cur-ov-min:\d+px$/, DEPTH_BAR_WIDTH],
  maxPrimary: 1,
  monoInProse: { prose: ['p', 'tx-desc', 'tx-note', 'cur-action-run'] },
});

/** The Domain page's ⑤ Wiki health section, as it ships. Its own names
 *  (`dm-*`) ride beside the kit's, and the contract records the two places
 *  the Domain page is looser than the MCP target — both on the backlog
 *  (APP-SURVEY), neither changed here: a slug in mono inside a row's sentence
 *  ("suggests `slug`"), and the measured min-height reserve on the loading
 *  card. */
const DOMAIN_HEALTH_CONTRACT = Object.freeze({
  name: 'Domains › ⑤ Wiki health',
  allow: [...KIT_CLASSES, 'dm-*', 'content-reveal', 'ai-run', 'ai-run-*', 'ring-*', 'cur-ring*'],
  forbid: ['mcpi-*', 'settings-*'],
  column: { kinds: [['section', ['dm-health']]], pattern: /^section$/ },
  buttonHomes: ['cur-card'],
  foldClass: 'cur-fold',
  noMonitorHead: true,
  footnotes: { classes: ['tx-desc', 'tx-note'], lastIn: ['cur-card', 'cur-fold-body'],
    slots: ['cur-action-footnote', 'cur-mon-note', 'tx-vh-panel'] },
  styleAllow: [/^min-height:\d+(\.\d+)?px$/, DEPTH_BAR_WIDTH],
  maxPrimary: 0,
  monoInProse: false,
});

// ═════════════════════════════════════════════════════════════════════════
section('§1  THE PARSER reads what the kit emits');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = K.renderFoldRows(K.renderFoldRow({ key: 'k', label: 'Row', pill: 3, alias: 'dm',
    bodyHtml: K.renderFoldItem({ main: 'a/b.md', meta: 'fact', actionHtml: '<button class="btn btn-ghost">Go</button>' }) }),
  { alias: 'dm' });
  const root = parseHtml(html);
  const tags = [];
  walk(root, (n) => { if (n.tag !== '#text') tags.push(n.tag); });
  ok(tags.join(',') === 'div,details,summary,svg,path,span,span,div,div,span,span,button',
    'the tree is the markup, element for element (the chevron\'s <path/> self-closes)', tags.join(','));
  ok(root.children.length === 1 && root.children[0].classes.join(' ') === 'cur-folds dm-groups',
    'one top-level block, its classes split');
  const t = parseHtml('<p>a <span class="mono">x</span> b</p>');
  ok(t.children[0].children.length === 3 && t.children[0].children[0].tag === '#text', 'text nodes are kept beside elements');
  ok(parseHtml('<div title="a > b" class="x">y</div>').children[0].attrs.title === 'a > b',
    'a quoted ">" inside an attribute does not end the tag');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  EVERY RULE, PROVED BY A POSITIVE CONTROL');
// ═════════════════════════════════════════════════════════════════════════
// A compliant page, built ONLY from the real kit, the real overview and the
// real monitor: the shape the MCP bridge page is rebuilt to.
function compliantPage(over) {
  const o = over || {};
  const head = (n, title, meta) => K.renderSectionHead({ num: n, title, meta, info: { btn: '', panel: '' } });
  const mon = renderMonitor({ lines: [{ key: 'tools', value: '24' }], note: 'A monitor\'s own note.', ...(o.monitorExtra || {}) });
  const card1 = K.renderCard(
    K.renderControlRow('<button class="btn btn-secondary" id="b1">Check again</button>') +
    K.renderActionCard({ eyebrow: 'NEXT STEP', chipsHtml: K.actionChip({ label: 'Install for me', cost: 'nothing to add' }),
      runHtml: 'Runs on this Mac.', footnoteHtml: renderDescription('Writes only the my-curator entry.') }) +
    K.renderFoldRows(K.renderFoldRow({ key: 'app', label: 'Claude Desktop', meta: 'connected', bodyHtml:
      K.renderFoldItem({ main: '~/Library/x.json', meta: 'has the entry', actionHtml: '<button class="btn btn-ghost">Remove</button>' }) })) +
    (o.cardTail || ''));
  const card2 = K.renderCard(mon + renderDescription('The card\'s last line.'));
  return renderViewHeader({ eyebrow: 'configuration', title: 'MCP bridge' }) +
    renderOverview({ id: 'mcp-ov', eyebrow: 'OVERVIEW', cards: [{ label: 'CONNECTED', value: '3' }] }) +
    head(1, 'Agent apps', 'checked just now') + card1 +
    (o.between || '') +
    head(2, 'Bridge', 'self-test 37 min ago') + card2 +
    (o.after || '');
}
{
  const base = compliantPage();
  const v = checkPageContract(base, MCP_CONTRACT);
  ok(v.length === 0, 'CONTROL — a page built from the real kit passes the MCP contract', v.join(' | '));

  const red = (label, html, needle) => {
    const got = checkPageContract(html, MCP_CONTRACT);
    ok(got.some((x) => x.includes(needle)), label + ' → red, by name ("' + needle + '")', got.join(' | ') || '(no violation)');
  };
  // The four mutations of the redesign's guard design (PROPOSAL §5).
  red('(a) a description re-inserted between two cards',
    compliantPage({ between: '<p class="tx-desc">Which agent apps on this Mac reach My Curator.</p>' }), 'unclassified block');
  red('(b) the self-test button moved out of its card',
    compliantPage({ between: '<div><button class="btn btn-secondary" id="btn-mcp-self-test">Run self-test</button></div>' }),
    'button outside every card');
  red('(c) an inline margin', base.replace('<div class="cur-card">', '<div class="cur-card" style="margin-top:8px">'), 'inline style');
  red('(d) the Bridge monitor given a head', compliantPage({ monitorExtra: { head: { stateWord: 'Not tested yet' } } }), 'a monitor with a head');
  // And the rest of the rules, one each.
  red('a page-private warning block', base.replace('<div class="cur-card">', '<div class="cur-card mcpi-warn">'), 'forbidden class: .mcpi-warn');
  red('a class nobody listed', base.replace('<div class="cur-card">', '<div class="cur-card fancy-box">'), 'class not on the allow-list: .fancy-box');
  red('a bare <details>', compliantPage({ cardTail: '<details><summary>More</summary>x</details>' }), 'not a kit fold row');
  red('stray text in the column', compliantPage({ between: 'loose words' }), 'text between the column');
  red('a footnote floating between two instruments',
    compliantPage({ cardTail: renderDescription('A floating foot.') + '<div class="cur-folds"></div>' }), 'not the last line');
  red('a second primary button',
    compliantPage({ cardTail: '<button class="btn btn-primary">A</button><button class="btn btn-primary">B</button>' }), 'primary buttons');
  red('a mono span inside a sentence',
    compliantPage({ cardTail: '<p class="tx-desc">Paste into <span class="mono">~/.cline/mcp.json</span> now.</p>' }), 'mono span inside a sentence');
  red('a section with two cards', compliantPage({ after: K.renderCard('x') }), 'column sequence');
  // NEGATIVE controls: the exemptions are exemptions, not holes.
  ok(checkPageContract(base, MCP_CONTRACT).every((x) => !x.includes('tx-vh-info')),
    'the ⓘ mark in a head is not "a button outside every card"');
  ok(checkPageContract(compliantPage({ cardTail: renderDescription('Last line.') }), MCP_CONTRACT).length === 0,
    'a description that IS the card\'s last line passes');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  THE PAGE REGISTRY');
// ═════════════════════════════════════════════════════════════════════════

/** Brace-match a top-level function out of views/domains.js. */
function extractFunction(src, name) {
  const at = src.search(new RegExp('\\nfunction ' + name + '\\('));
  if (at === -1) throw new Error('no function ' + name);
  // The body's brace follows the PARAMETER list, which may itself hold a
  // destructuring `{ … } = {}` — so match the parentheses first.
  let i = src.indexOf('(', at), parens = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') parens++;
    else if (src[i] === ')' && --parens === 0) break;
  }
  i = src.indexOf('{', i);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at + 1, i + 1);
  }
  throw new Error('unbalanced ' + name);
}
/** A top-level `const NAME = …;` whose value may span lines. */
function extractConst(src, name) {
  const at = src.search(new RegExp('\\nconst ' + name + ' = '));
  if (at === -1) throw new Error('no const ' + name);
  let depth = 0, q = null;
  for (let i = at + 1; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ';' && depth === 0) return src.slice(at + 1, i + 1);
  }
  throw new Error('unterminated ' + name);
}

/** ⑤ Wiki health, rendered by the REAL views/domains.js functions. */
function renderDomainHealth(stateOver) {
  const FNS = ['shouldKeepHealthOnReload', 'healthScanLabel', 'healthSection', 'renderHealthPanel',
    'renderQuickMaintenance', 'quickAiButton', 'costReadout', 'formatUsd', 'pluralize', 'countSafeFixable',
    'countOf', 'totalOpenIssues', 'renderIssueGroups', 'renderIssueGroup', 'renderIssueRow', 'renderDismissedGroup',
    'describeDismissed', 'relTime'];
  const CONSTS = ['HEALTH_CATEGORIES', 'AUTO_FIX_TYPES', 'GIT_UNDO_NOTE', 'HEALTH_INFO'];
  const deps = {
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    icon: (n) => '<svg data-icon="' + n + '"></svg>', buttonRingHtml: () => '<span class="cur-ring"></span>',
    fmtInt: (n) => String(n), inFlightWriteSlugs: new Set(),
    renderBanner: () => '', renderMirrorNote: () => '', renderAiProgressRing: () => '',
    renderConfirmCard: () => '', renderPendingPlan: () => '', activeSemanticScan: () => null,
    renderSemanticScanResult: () => '', gatedLoader: () => '', loadGate: null,
    renderMonitor, freshnessTier, formatAge, renderStatus, renderDescription, explainerMark, formatUsdHonest,
    renderRunsOn, renderSpent, aiActionDisabledAttrs,
    ...SECTION_KIT,
  };
  const names = Object.keys(deps).filter((n) => !SECTION_KIT_NAMES.includes(n));
  const body = 'let state = __state;\n' +
    CONSTS.map((c) => extractConst(DOMAINS_JS, c)).join('\n') + '\n' +
    FNS.map((f) => extractFunction(DOMAINS_JS, f)).join('\n\n') + '\nreturn renderHealthPanel;';
  const fn = new Function('__state', ...names, ...SECTION_KIT_NAMES, body);
  const state = {
    healthLoading: false, healthError: null, healthSlug: 'early-computing', busyKey: null,
    expandedGroups: new Set(['scan', 'brokenLinks', 'orphans', 'dismissed']), dismissedRecords: [],
    estimates: {}, aiAvailable: true, aiRunsOn: { job: 'wiki-health', needsKey: false, provider: 'gemini',
      providerLabel: 'Gemini', model: 'gemini-2.5-flash-lite', modelLabel: 'Flash Lite 2.5', priceKnown: true },
    aiSpent: null, confirm: null, pendingPlan: null, banner: null, reveal: null, reserve: null,
    health: {
      counts: { entities: 11, concepts: 8, summaries: 4, dismissed: 1 }, dismissedRecords: 1,
      scannedAt: '2026-10-30T12:00:00Z',
      brokenLinks: [{ sourceFile: 'entities/a.md', linkText: 'B', suggestedTarget: 'b' }, { sourceFile: 'entities/c.md', linkText: 'Z' }],
      orphans: [{ path: 'concepts/x.md', type: 'concept' }], crossFolderDupes: [], hyphenVariants: [],
      folderPrefixLinks: [], missingBacklinks: [{ summary: 'summaries/s.md', entity: 'entities/e.md' }],
      summaryLinkSections: [], indexDrift: [],
    },
    ...(stateOver || {}),
  };
  return fn(state, ...names.map((n) => deps[n]), ...SECTION_KIT_VALUES)({ slug: 'early-computing' }, false);
}

const PAGES = [
  { id: 'settings.mcp', contract: MCP_CONTRACT, enforced: false,
    why: 'the contract the rebuilt MCP bridge page must pass; enforced by the step that rebuilds it' },
  { id: 'domains.health', contract: DOMAIN_HEALTH_CONTRACT, enforced: true, render: () => renderDomainHealth() },
  { id: 'domains.health (loading, with a reserve)', contract: DOMAIN_HEALTH_CONTRACT, enforced: true,
    render: () => renderDomainHealth({ healthLoading: true, health: null, reserve: { health: 452 } }) },
  { id: 'domains.health (scan failed)', contract: DOMAIN_HEALTH_CONTRACT, enforced: true,
    render: () => renderDomainHealth({ healthError: 'the disk went away', health: null }) },
];
for (const p of PAGES) {
  if (!p.enforced) {
    ok(typeof p.contract === 'object' && p.contract.name, p.id + ': contract registered, NOT YET ENFORCED — ' + p.why);
    continue;
  }
  let html = '';
  try { html = p.render(); } catch (err) { ok(false, p.id + ': renders', err && err.stack); continue; }
  ok(html.length > 200, p.id + ': renders from the real views/domains.js (' + html.length + ' bytes)');
  const v = checkPageContract(html, p.contract);
  ok(v.length === 0, p.id + ': passes "' + p.contract.name + '"', v.join(' | '));
}
{
  // ANTI-VACUITY for the first client: the rendered card really holds the
  // things the rules are about, so a pass is a finding.
  const html = renderDomainHealth();
  ok(/<details class="cur-fold dm-group/.test(html) && /cur-action dm-quick/.test(html)
    && /<button class="btn btn-secondary" id="dm-rescan-btn"/.test(html) && /class="cur-mon/.test(html)
    && /class="tx-desc/.test(html),
  'CONTROL — the ⑤ render holds fold rows, the action card, the control-row button, a monitor and a footnote');
  const mutated = html.replace('<div class="cur-card-top dm-health-top">', '</div><div class="cur-card-top dm-health-top">');
  ok(checkPageContract(mutated, DOMAIN_HEALTH_CONTRACT).length > 0,
    'CONTROL — the same render with Rescan moved out of its card goes red');
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('Page-contract assertions FAILED'); process.exit(1); }
console.log('Page contract holds');
