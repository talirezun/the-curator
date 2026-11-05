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
 *       allow-list, every one ENFORCED: Settings › MCP bridge (v3.89.0 step
 *       2) in sixteen arms rendered from the real views/settings.js, and the
 *       Domain page's ⑤ Wiki health card from the real views/domains.js;
 *   §4  proves the MCP guard by MUTATING THE REAL CODE (PROPOSAL §5): a
 *       footnote floated between cards, the self-test button moved out of
 *       its card, a footnote no longer its card's last line, an inline
 *       margin, the monitor head back, a page-private class.
 *
 * OFFLINE. No network, no browser, no user data.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPageContract, parseHtml, walk, KIT_CLASSES, MCP_PAGE_CONTRACT, DEPTH_BAR_WIDTH } from './test-helpers/page-contract.js';
import { SECTION_KIT, SECTION_KIT_NAMES, SECTION_KIT_VALUES } from './test-helpers/section-kit.js';
import { renderMonitor } from '../src/public/next/shared/monitor.js';
import { renderOverview } from '../src/public/next/shared/overview.js';
import { renderStatus, renderDescription, renderViewHeader } from '../src/public/next/shared/text.js';
import { freshnessTier, formatAge } from '../src/public/next/shared/age.js';
import { explainerMark } from '../src/public/next/shared/explainer.js';
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';
import { renderRunsOn, renderSpent, aiActionDisabledAttrs } from '../src/public/next/shared/ai-run.js';
import { renderMcpPage, baseState, SETTINGS_SRC } from './test-helpers/mcp-page-sandbox.js';

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

/** Settings › MCP bridge (PROPOSAL §4–§5) — lives in the helper so the
 *  browser e2e (scripts/e2e-mcp-bridge.mjs) checks the LIVE page against the
 *  very same contract. */
const MCP_CONTRACT = MCP_PAGE_CONTRACT;

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
    K.renderActionCard({ eyebrow: 'Next step · 1 to do', eyebrowCase: 'sentence', chipsHtml: K.actionChip({ label: 'Install for me' }),
      runHtml: 'Runs on this Mac.', footnoteHtml: renderDescription('Install for me changes only The Curator’s own line.') }) +
    K.renderFoldRows(K.renderFoldRow({ key: 'app', label: 'Claude Desktop', meta: 'connected', bodyHtml:
      K.renderFoldItem({ main: '~/Library/x.json', meta: 'has The Curator’s line', actionHtml: '<button class="btn btn-danger btn-xs">Remove</button>' }) })) +
    (o.cardTail || ''));
  const card2 = K.renderCard(mon + renderDescription('The card\'s last line.'));
  return renderViewHeader({ eyebrow: 'configuration', title: 'MCP bridge' }) +
    renderOverview({ id: 'mcp-ov', eyebrow: 'OVERVIEW', cards: [{ label: 'CONNECTED', value: '3' }] }) +
    head(1, 'Agent apps', 'checked just now') + card1 +
    (o.between || '') +
    head(2, 'Connection test', 'last test 37 min ago') + card2 +
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
  // v3.90.0 — the copy deck's principles, one positive control each.
  red('a ghost button (reads as plain text)', base.replace('class="btn btn-secondary" id="b1"', 'class="btn btn-ghost" id="b1"'), 'not a real button');
  red('a bare link', compliantPage({ cardTail: '<a href="/x">Download</a>' }), 'link that is not a real button');
  red('a span with an action hook', compliantPage({ cardTail: '<span data-mcpi-act="copy">Copy</span>' }), 'clickable element that is not a <button>');
  red('"entry" on screen', base.replace('has The Curator’s line', 'has the entry'), 'mechanism word on screen ("entry")');
  red('"bridge" outside the title', base.replace("'Connection test'", "'Bridge'").replace('Connection test', 'Bridge'), 'mechanism word on screen ("bridge")');
  red('"launcher" on screen', compliantPage({ cardTail: '<p class="tx-desc">The launcher is missing.</p>' }), 'mechanism word on screen ("launcher")');
  red('an ALL-CAPS eyebrow', base.replace('Next step · 1 to do', 'NEXT STEP · 1 TO DO'), 'ALL-CAPS text outside the overview');
  ok(checkPageContract(compliantPage({ cardTail: '<pre class="mono">{"command": "/x/launcher"}</pre>' }), MCP_CONTRACT).length === 0,
    'NEGATIVE CONTROL — the exact setup text in a <pre> is data, not a mechanism word');
  ok(checkPageContract(base, MCP_CONTRACT).every((x) => !/ALL-CAPS/.test(x)) && /CONNECTED/.test(base),
    'NEGATIVE CONTROL — the overview\'s own figure labels are uppercase and pass');
  ok(checkPageContract(base, MCP_CONTRACT).every((x) => !/"bridge"/.test(x)) && /MCP bridge/.test(base),
    'NEGATIVE CONTROL — "MCP bridge" in the page title passes');
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
    'describeDismissed', 'relTime', 'renderConfirmCard', 'renderPendingPlan', 'renderOutcomeLine', 'renderAnchorStack',
    'renderAiProgressRing', 'busyRingLabel', 'fmtKB'];
  const CONSTS = ['HEALTH_CATEGORIES', 'AUTO_FIX_TYPES', 'GIT_UNDO_NOTE', 'HEALTH_INFO', 'BUSY_LABELS', 'DESTRUCTIVE_FIX_TYPES'];
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
    progressRingHtml: () => '<span class="cur-ring"></span>', ringValueFromCounts: () => null,
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
  return fn(state, ...names.map((n) => deps[n]), ...SECTION_KIT_VALUES)({ slug: 'early-computing' }, !!state.readonlyArm);
}


/** Every arm of the MCP page a person can reach: [label, state, opts]. */
function mcpArms() {
  const b = baseState;
  const mi = (over) => ({ ...b().mcpInstall, ...over });
  const data = (over) => ({ ...b().mcpInstall.status.data, ...over });
  const allOpen = { 'app-claude-desktop': true, 'app-antigravity': true, 'app-cursor': true, 'app-cline': true, 'mcpi-notfound': true,
    'app-details-claude-desktop': true, 'app-details-antigravity': true, 'app-details-cursor': true,
    'skill-my-curator': true, 'skill-curator-continuity': true, 'bridge-answers': true, 'default-domain': true, 'all-tools': true };
  const plan = { action: 'install', token: 't', items: [{ id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', action: 'add', basis: 'absent',
    entryText: '{\n  "command": "/x/launcher"\n}', preserved: [] }, { id: 'claude-desktop', label: 'Claude Desktop',
    file: '~/Library/Application Support/Claude/claude_desktop_config.json', action: 'update', basis: 'abc', entryText: '{}', preserved: ['github'],
    backupWillBe: '~/Library/Application Support/Claude/claude_desktop_config.json.curator-backup-<UTC time of apply>' }] };
  const results = { action: 'install', planItems: plan.items, items: [{ id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', outcome: 'created', restart: 'Quit and reopen Cursor' },
    { id: 'claude-desktop', label: 'Claude Desktop', file: '~/x.json', outcome: 'refused', message: 'It changed.' }] };
  return [
    ['connected + to fix, folds closed', b()],
    ['every fold open', b({ setupMachineFolds: allOpen })],
    ['the install preview', b({ mcpInstall: mi({ plan }) })],
    ['the results', b({ mcpInstall: mi({ results }) })],
    ['a copy confirmation and an install error', b({ mcpInstall: mi({ copied: 'Setup text copied. Save as ~/.cursor/mcp.json.', error: 'Could not reach The Curator.' }) })],
    ['Check entry outcomes', b({ mcpChecks: { 'claude-desktop': { result: { results: [{ file: '~/a.json', ran: true, starts: true, toolCount: 24 }] } },
      antigravity: { result: { results: [{ file: '~/b.json', ran: false, starts: false, code: 'not_allowed', message: 'No.' }] } } } })],
    ['everything connected', b({ mcpInstall: mi({ status: { data: data({ counts: { connected: 1, toFix: 0, notConnected: 0 }, notFound: [],
      tools: [b().mcpInstall.status.data.tools[0]] }) } }) })],
    ['Windows', b({ mcpInstall: mi({ status: { data: data({ platform: 'win32' }) } }) })],
    ['Linux, copy-only', b({ mcpInstall: mi({ status: { data: data({ platform: 'linux', writable: false,
      tools: b().mcpInstall.status.data.tools.map((t) => ({ ...t, status: 'manual', checkEntry: false })) }) } }) })],
    ['a self-test and a full test just ran', b({ selfTest: { ok: true, tool_count: 24 }, selfTestAt: new Date().toISOString(),
      mcpExercise: { ranAt: new Date().toISOString(), durationMs: 900, results: [{ tool: 'get_node', ok: true }, { tool: 'save_foundation', refused: true, note: 'read-only' }] } })],
    ['a failed self-test and a missing folder', b({ selfTest: { ok: false, error: 'spawn ENOENT', domains_status: 'missing_folder' }, selfTestAt: new Date().toISOString() })],
    ['a fresh install (no calls, no projects)', b({ mcpUsage: { present: false, tools: b().mcpUsage.tools.map((t) => ({ ...t, lastUsedAt: null, lastAgentAt: null })), sessions: {} },
      mcpProjects: { byProject: [], window: { windowDays: 30, logPresent: false }, savePulse: null } })],
    ['readings still loading', b({ mcpUsage: null, mcpProjects: null, setupMachine: null, mcpInstall: mi({ status: null }) })],
    ['the status failed', b({ mcpInstall: mi({ status: { data: null, error: 'HTTP 500' } }), mcpUsage: null, mcpUsageError: 'nope', mcpProjectsError: 'old server', mcpProjects: null })],
    ['the section failed', b({ mcp: null, mcpError: 'Could not load' })],
    ['first paint (gate visible)', b({ mcp: null })],
  ];
}

const PAGES = [
  // ── SETTINGS › MCP BRIDGE — ENFORCED (v3.89.0, step 2), rendered from the
  // REAL views/settings.js renderMcp in every arm a person can reach.
  ...mcpArms().map(([id, st, opts]) => ({ id: 'settings.mcp (' + id + ')', contract: MCP_CONTRACT, enforced: true,
    render: () => renderMcpPage(st, opts).column })),
  { id: 'domains.health', contract: DOMAIN_HEALTH_CONTRACT, enforced: true, render: () => renderDomainHealth() },
  { id: 'domains.health (loading, with a reserve)', contract: DOMAIN_HEALTH_CONTRACT, enforced: true,
    render: () => renderDomainHealth({ healthLoading: true, health: null, reserve: { health: 452 } }) },
  { id: 'domains.health (scan failed)', contract: DOMAIN_HEALTH_CONTRACT, enforced: true,
    render: () => renderDomainHealth({ healthError: 'the disk went away', health: null }) },
];
// ── THE PRESS RULE, IN EVERY ARM OF ⑤ IT CAN REACH (Stage 1). The three arms above
// are at rest, loading and failed, which is none of what the owner reported. These
// render the question, the plan, the running action and the failure from the real
// code. A confirm's yes is still violet until the wording stage, so `maxPrimary` is
// the one thing eased, and only for the arms that carry one.
const WITH_YES = { ...DOMAIN_HEALTH_CONTRACT, maxPrimary: 1 };
const ASKED = { title: 'Fix all 2 cross-folder duplicates?', body: 'This MERGES each group.', confirmLabel: 'Merge and delete', run() {} };
const PRESS_ARMS = [
  ['a question under its row', WITH_YES, { confirm: { ...ASKED, anchor: 'group:brokenLinks' }, rowLines: {} }, ['dm-confirm-card', 'id="dm-confirm-no"']],
  ['a question under the chips', WITH_YES, { confirm: { ...ASKED, anchor: 'quick' }, rowLines: {} }, ['dm-confirm-card']],
  ['a question answered, running', WITH_YES, { confirm: { ...ASKED, anchor: 'quick', busy: true, busyLabel: 'Merging…' }, rowLines: {} }, ['aria-busy="true"', 'Merging…']],
  ['a plan open', WITH_YES, { pendingPlan: { kind: 'orphans', anchor: 'quick', plan: [{}], summary: { rescuable: 1, noHome: 0 } }, rowLines: {} }, ['id="dm-plan-apply-btn"']],
  ['a repair running', DOMAIN_HEALTH_CONTRACT, { busyKey: 'group:brokenLinks', pressAnchor: 'group:brokenLinks', rowLines: {} }, ['aria-busy="true"', 'Repairing…']],
  ['AI help running', DOMAIN_HEALTH_CONTRACT, { busyKey: 'orphansPlan', ringAnchor: 'quick', rowLines: {} }, ['aria-busy="true"', 'dm-ai-progress']],
  ['a row failed', DOMAIN_HEALTH_CONTRACT, { rowLines: { 'group:brokenLinks': { key: 'group:brokenLinks', tone: 'error', text: 'Could not repair: the disk went away', retry() {} } } }, ['dm-outcome-failed', 'Try again']],
  ['the trace', DOMAIN_HEALTH_CONTRACT, { healthTrace: { slug: 'early-computing', text: 'Repaired 2', at: '2026-11-05T10:00:00Z' }, activeSlug: 'early-computing', rowLines: {} }, ['dm-health-trace']],
  ['a read-only mirror', DOMAIN_HEALTH_CONTRACT, { readonlyArm: true, rowLines: {} }, []],
];
for (const [label, contract, over, must] of PRESS_ARMS) {
  PAGES.push({ id: 'domains.health (' + label + ')', contract, enforced: true, render: () => renderDomainHealth(over), must });
}
function pressRuleViolations(html) {
  const bad = [];
  if (/dm-banner/.test(html)) bad.push('a banner inside the section: an outcome belongs on its row');
  if (/btn-ghost/.test(html)) bad.push('a text-styled button: every control has visible chrome');
  if (/role="button"|onclick=/.test(html)) bad.push('something clickable that is not a <button>');
  if ((html.match(/aria-live=/g) || []).length !== 1) bad.push('the section must hold exactly one live region');
  return bad;
}

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
  if (p.id.startsWith('domains.health')) {
    const pr = pressRuleViolations(html);
    ok(pr.length === 0, p.id + ': holds the press rule', pr.join(' | '));
    for (const m of p.must || []) ok(html.includes(m), p.id + ': really is that state, holding ' + m);
  }
}
{
  // ANTI-VACUITY: each press-rule check goes red on the thing it forbids.
  const base = renderDomainHealth();
  ok(pressRuleViolations(base).length === 0, 'CONTROL — the plain render passes the press rule');
  ok(pressRuleViolations(base + '<div class="dm-banner"></div>').length === 1, 'CONTROL — a banner goes red');
  ok(pressRuleViolations(base + '<button class="btn btn-ghost">Skip</button>').length === 1, 'CONTROL — a ghost button goes red');
  ok(pressRuleViolations(base + '<span role="button">x</span>').length === 1, 'CONTROL — a span acting as a button goes red');
  ok(pressRuleViolations(base + '<div aria-live="polite"></div>').length === 1, 'CONTROL — a second live region goes red');
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

// ═════════════════════════════════════════════════════════════════════════
section('§4  THE MCP PAGE\'S GUARD, PROVED BY MUTATING THE REAL CODE (PROPOSAL §5)');
// ═════════════════════════════════════════════════════════════════════════
{
  const real = renderMcpPage(baseState({ setupMachineFolds: { 'bridge-answers': true } })).column;
  ok(/class="cur-ov settings-ov-section"/.test(real) && (real.match(/class="cur-section-head"/g) || []).length === 4
    && (real.match(/<div class="cur-card"/g) || []).length === 4 && /id="btn-mcp-self-test"/.test(real) && /class="cur-action"/.test(real)
    && /class="cur-mon/.test(real) && /class="tx-desc/.test(real) && /class="cur-section-foot"/.test(real),
  'CONTROL — the real page holds the overview, four heads, four cards, the self-test button, the action card, a monitor, a footnote and the closing line');
  const mutant = (label, from, to, needle) => {
    ok(SETTINGS_SRC.includes(from), label + ': the code being mutated exists (the mutation is not vacuous)');
    const v = checkPageContract(renderMcpPage(baseState(), { source: SETTINGS_SRC.replace(from, to) }).column, MCP_CONTRACT);
    ok(v.some((x) => x.includes(needle)), label + ' → red, by name ("' + needle + '")', v.join(' | ') || '(no violation)');
  };
  // (a) a floating footnote: the default-domain consequence printed BETWEEN
  // sections ② and ③ instead of as its fold body's last line.
  mutant('(a) a footnote floated between two cards',
    "    + mcpSection(4, 'use',", "    + renderDescription('A floating foot.') + mcpSection(4, 'use',", 'unclassified block in the column');
  // (b) the self-test button moved out of its card's control row, between sections.
  mutant('(b) the self-test button moved out of its card',
    "    + mcpSection(3, 'bridge',", "    + '<div><button type=\"button\" class=\"btn btn-secondary\" id=\"btn-mcp-self-test\">Test connection</button></div>' + mcpSection(3, 'bridge',",
    'button outside every card');
  // (b2) the footnote inside a card, but no longer its last line.
  mutant('(b2) the Next step footnote moved above the fold rows',
    "  return control + (line ? '<div class=\"cur-card-notes\">' + line + '</div>' : '') + folds;",
    "  return control + renderDescription('A floating foot.') + folds;", 'not the last line');
  // (c) an inline margin on a card.
  mutant('(c) an inline margin', "'<div class=\"cur-card\" id=\"mcp-card-' + key + '\"'",
    "'<div class=\"cur-card\" style=\"margin-top:8px\" id=\"mcp-card-' + key + '\"'", 'inline style');
  // (d) the Bridge monitor given its old head word back.
  mutant('(d) the Tool activity monitor given a head', "label: 'Tool activity', keys: 'identifier',", "label: 'Tool activity', head: { stateWord: 'Not tested yet', tone: 'quiet' }, keys: 'identifier',", 'a monitor with a head');
  // (e) a page-private class back on a section.
  mutant('(e) a page-private class', "renderCard(innerHtml)", "renderCard(innerHtml, { hostClass: 'mcp-busiest' })", 'forbidden class: .mcp-busiest');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  THE COPY DECK\'S PRINCIPLES, PROVED BY MUTATING THE REAL CODE (v3.90.0)');
// ═════════════════════════════════════════════════════════════════════════
// Each check is proved the way §4's are: the real page passes; the real code,
// edited back toward v3.89.0's shapes, goes red by name. mcp-install.js is a
// module, so its mutants are loaded from a temporary copy of the file.
{
  const { readFileSync: rf, writeFileSync: wf, mkdtempSync, copyFileSync, rmSync, mkdirSync } = await import('node:fs');
  const os = await import('node:os');
  const MI_PATH = join(ROOT, 'src/public/next/views/mcp-install.js');
  const MI_SRC = rf(MI_PATH, 'utf8');
  const open = { 'app-claude-desktop': true, 'app-antigravity': true, 'app-cursor': true, 'app-cline': true, 'mcpi-notfound': true,
    'app-details-claude-desktop': true, 'app-details-antigravity': true, 'skill-my-curator': true, 'all-tools': true };
  const st = () => baseState({ setupMachineFolds: open, mcpInstall: { ...baseState().mcpInstall, copied: 'Setup text copied. Paste into ~/.cursor/mcp.json inside "mcpServers".' } });
  const real = renderMcpPage(st()).column;
  ok(checkPageContract(real, MCP_CONTRACT).length === 0, 'CONTROL — the real page, every fold open, passes the deck checks',
    checkPageContract(real, MCP_CONTRACT).join(' | '));
  ok(/class="btn btn-danger btn-xs" data-mcpi-act="remove"/.test(real) && /<a class="btn btn-secondary btn-xs" href="\/api\/setup\/skills\/my-curator.zip"/.test(real)
    && /Next step · 2 to do/.test(real) && /Test connection/.test(real),
  'CONTROL — the real page holds Remove (danger), a Download link as a button, the sentence-case eyebrow and Test connection (the checks are not vacuous)');
  const dir = mkdtempSync(join(os.tmpdir(), 'curator-contract-'));
  // A copy of the views/shared tree the module imports, so its relative imports resolve.
  const SHARED = join(ROOT, 'src/public/next/shared');
  mkdirSync(join(dir, 'views'));
  mkdirSync(join(dir, 'shared'));
  for (const f of (await import('node:fs')).readdirSync(SHARED)) if (f.endsWith('.js')) copyFileSync(join(SHARED, f), join(dir, 'shared', f));
  let n = 0;
  const miMutant = async (label, from, to, needle) => {
    ok(MI_SRC.includes(from), label + ': the code being mutated exists (the mutation is not vacuous)');
    const file = join(dir, 'views', 'mcp-install-' + (++n) + '.js');
    wf(file, MI_SRC.replace(from, to));
    const M = await import(file);
    const v = checkPageContract(renderMcpPage(st(), { deps: { renderAgentApps: M.renderAgentApps, renderSkills: M.renderSkills } }).column, MCP_CONTRACT);
    ok(v.some((x) => x.includes(needle)), label + ' → red, by name ("' + needle + '")', v.join(' | ') || '(no violation)');
  };
  try {
    // (f) every action is a real button: the shared secondary button back to v3.89.0's ghost.
    await miMutant('(f) the per-app buttons drawn as ghosts again', "const btnS = (act, label, extra = '') => '<button type=\"button\" class=\"btn btn-secondary btn-xs\"",
      "const btnS = (act, label, extra = '') => '<button type=\"button\" class=\"btn btn-ghost btn-xs\"", 'not a real button');
    // (g) a Download that is a bare link.
    await miMutant('(g) a skill download as a bare link', "return '<a class=\"btn btn-secondary btn-xs\" href=\"/api/setup/skills/' + s + '",
      "return '<a href=\"/api/setup/skills/' + s + '", 'link that is not a real button');
    // (h) a mechanism word back on screen: v3.89.0's "Copy entry".
    await miMutant('(h) "Copy entry" back on the per-app button', "const copyBtn = m.copy ? btnS('copy', 'Copy the setup text', tid) : '';",
      "const copyBtn = m.copy ? btnS('copy', 'Copy entry', tid) : '';", 'mechanism word on screen ("entry")');
    // (i) ALL-CAPS outside the overview: v3.89.0's "NEXT STEP · N TO FIX".
    await miMutant('(i) the Next step eyebrow in capitals again', "eyebrow: 'Next step · ' + items.length + ' to do',",
      "eyebrow: 'NEXT STEP · ' + items.length + ' TO DO',", 'ALL-CAPS text outside the overview');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // (j) a mechanism word in settings.js: the v3.89.0 section title.
  const mutantS = (label, from, to, needle) => {
    ok(SETTINGS_SRC.includes(from), label + ': the code being mutated exists (the mutation is not vacuous)');
    const v = checkPageContract(renderMcpPage(baseState(), { source: SETTINGS_SRC.replace(from, to) }).column, MCP_CONTRACT);
    ok(v.some((x) => x.includes(needle)), label + ' → red, by name ("' + needle + '")', v.join(' | ') || '(no violation)');
  };
  mutantS('(j) section ③ called "Bridge" again', "mcpSection(3, 'bridge', 'Connection test',", "mcpSection(3, 'bridge', 'Bridge',", 'mechanism word on screen ("bridge")');
  mutantS('(k) "Run self-test" said as "Start the launcher"', "(busy ? 'Testing…' : 'Test connection')", "(busy ? 'Testing…' : 'Start the launcher')", 'mechanism word on screen ("launcher")');
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('Page-contract assertions FAILED'); process.exit(1); }
console.log('Page contract holds');
