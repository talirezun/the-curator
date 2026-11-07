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
import { wordAllowed, isFigure, BANNED } from './test-helpers/health-words.js';
import { SECTION_KIT, SECTION_KIT_NAMES, SECTION_KIT_VALUES } from './test-helpers/section-kit.js';
import { renderMonitor } from '../src/public/next/shared/monitor.js';
import { renderOverview } from '../src/public/next/shared/overview.js';
import { renderStatus, renderDescription, renderViewHeader } from '../src/public/next/shared/text.js';
import { freshnessTier, formatAge } from '../src/public/next/shared/age.js';
import { explainerMark } from '../src/public/next/shared/explainer.js';
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';
import { renderRunsOn, renderSpent, aiActionDisabledAttrs } from '../src/public/next/shared/ai-run.js';
import { renderMcpPage, baseState, SETTINGS_SRC } from './test-helpers/mcp-page-sandbox.js';
import { deskFixture, pair as deskPair } from './test-helpers/review-desk-fixture.js';

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
  allow: [...KIT_CLASSES, 'dm-*', 'hr-*', 'content-reveal', 'ai-run', 'ai-run-*', 'ring-*', 'cur-ring*'],
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
    'renderHealthLanes', 'renderFreeLane', 'renderDecisionLane', 'renderAiLane', 'renderLaneHead', 'renderLaneTrace', 'renderPlainRow', 'renderShowMore', 'renderIssueFold', 'repairButton', 'mergeRowButton', 'deletesReading', 'renderCompareRow', 'renderSuggestRow', 'activeSemanticQuote', 'renderAnchorHere', 'freeRepairCount', 'n0', 'deletedPageCount', 'semanticCoverageFrom', 'liveBatchPairs',
    'quickAiButton', 'costReadout', 'formatUsd', 'pluralize', 'semanticPairKey', 'isSemanticPreviewed', 'canMergeSemanticPair',
    'countOf', 'totalOpenIssues', 'renderIssueRow', 'renderDismissedGroup', 'renderChangesRow', 'recentChangeCount', 'changeMeta',
    'describeDismissed', 'relTime', 'renderConfirmCard', 'renderPendingPlan', 'renderOutcomeLine', 'renderAnchorStack',
    'busyRingLabel', 'fmtKB'];
  const CONSTS = ['HEALTH_CATEGORIES', 'AUTO_FIX_TYPES', 'GIT_UNDO_NOTE', 'HEALTH_INFO', 'BUSY_LABELS', 'DESTRUCTIVE_FIX_TYPES', 'ISSUE_PAGE', 'FREE_ROWS'];
  const deps = {
    escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    icon: (n) => '<svg data-icon="' + n + '"></svg>', buttonRingHtml: () => '<span class="cur-ring"></span>',
    fmtInt: (n) => String(n), inFlightWriteSlugs: new Set(),
    renderBanner: () => '', gatedLoader: () => '', loadGate: null,
    renderMirrorNote: () => renderStatus({ title: 'This domain is a read-only Shared Brain mirror', detail: 'Fixes here would be overwritten on the next Pull — fix issues in your personal contributing domain, then push from Sync.' }),
    activeSemanticScan: () => (stateOver && stateOver.semanticScan) || null,
    compareAll: { reading: () => null, actions: (slug, next) => next, line: () => '', running: () => false, onClick: () => false, afterPaint() {}, sync() {}, noteQuote() {}, acknowledge() {}, forgetQuote() {} },
    renderMonitor, freshnessTier, formatAge, renderStatus, renderDescription, explainerMark, formatUsdHonest,
    renderRunsOn, renderSpent, aiActionDisabledAttrs,
    progressRingHtml: () => '<span class="cur-ring"></span>', ringValueFromCounts: () => null,
    ...SECTION_KIT,
  };
  const names = Object.keys(deps).filter((n) => !SECTION_KIT_NAMES.includes(n));
  const body = 'let state = __state;\nconst fmtIntAlias = 0;\n' +
    CONSTS.map((c) => extractConst(DOMAINS_JS, c)).join('\n') + '\n' +
    FNS.map((f) => extractFunction(DOMAINS_JS, f)).join('\n\n') + '\nreturn renderHealthPanel;';
  const fn = new Function('__state', ...names, ...SECTION_KIT_NAMES, body);
  const state = {
    healthLoading: false, healthError: null, healthSlug: 'early-computing', busyKey: null,
    expandedGroups: new Set(['scan', 'brokenLinks', 'brokenLinksOpen', 'orphans', 'dismissed', 'missingBacklinks']), dismissedRecords: [{ type: 'orphans', path: 'concepts/old.md' }, { type: 'semanticDupe', slugs: ['a', 'b'] }],
    rowLines: {}, rowBusy: new Set(), leftRows: {}, groupVisible: {},
    estimates: { brokenLinks: { estimatedUsd: 0.0003, priceKnown: true, needAi: 2, resolveFree: 0 }, orphans: { estimatedUsd: 0.0004, priceKnown: true } },
    activeSlug: 'early-computing', semanticQuote: { slug: 'early-computing', forNext: 500, est: { candidatePairs: 500, totalPairs: 2108, checkedPairs: 0, leftPairs: 2108, nextPairs: 500, estimatedUsd: 0.04, priceKnown: true } },
    aiAvailable: true, aiRunsOn: { job: 'wiki-health', needsKey: false, provider: 'gemini',
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
// ── EVERY ARM OF ⑤ A PERSON CAN REACH, RENDERED FROM THE REAL CODE (Stage 2, PLAN §3).
// The three arms above are at rest, loading and failed, which is none of what the owner
// reported. These render the question, the plan, the running action, the failure and the
// clean state; the desk's arms follow them.
const WITH_YES = { ...DOMAIN_HEALTH_CONTRACT };
const ASKED = { title: 'Merge 2 pages with the same name?', body: '2 pages are deleted and their links move to the page that stays.',
  warn: 'You can undo this in Recent changes for 30 days, on this computer only, while none of these pages has changed since.', tier: 'danger', confirmLabel: 'Merge and delete 2', run() {} };
const AI_ASKED = { title: 'Ask AI to find a page that should link to each?', body: 'Sends each page’s opening and the list of your page names to Flash Lite 2.5. About $0.0004. Nothing is written yet.', tier: 'ai', confirmLabel: 'Ask for', costText: '≈ $0.0004', run() {} };
const FORGET = { title: 'Forget all comparisons?', body: 'The Curator forgets which pairs it has compared in this domain, so the next run starts over and costs money again. Pairs you kept apart stay that way. Nothing in your wiki changes.', confirmLabel: 'Forget', run() {} };
const FIRST_USE = { title: 'Before you use AI help.', body: 'These actions send the opening of the pages involved, and usually a list of your other page names, to your AI provider (Google Gemini). The next step shows what it sends and what it costs before anything runs. The provider’s own privacy policy applies. To turn this off, remove your API key in Settings.', confirmLabel: 'Continue', run() {} };
const REFUSED = { title: 'This run is over your cost limit.', body: 'It would send 500 pairs: about 200,000 tokens, over your limit of 100,000. Nothing has been sent.', refused: true, settingsLabel: 'Open scan limits', confirmLabel: null };
const FULL_REPORT = {
  counts: { entities: 11, concepts: 8, summaries: 4, dismissed: 1 }, dismissedRecords: 2, scannedAt: '2026-10-30T12:00:00Z',
  brokenLinks: [{ sourceFile: 'entities/a.md', linkText: 'B', suggestedTarget: 'b' }, { sourceFile: 'entities/c.md', linkText: 'Z', occurrences: 2 }],
  orphans: [{ path: 'concepts/x.md', type: 'concept' }], crossFolderDupes: [{ keep: 'entities/d.md', remove: 'concepts/d.md' }], hyphenVariants: [{ files: ['concepts/a-b.md', 'concepts/ab.md', 'concepts/a_b.md'], suggestedSlug: 'ab' }],
  folderPrefixLinks: [{ sourceFile: 'concepts/y.md', linkText: 'concepts/z' }], missingBacklinks: [{ summary: 'summaries/s.md', entity: 'entities/e.md' }, { summary: 'summaries/s.md', entity: 'entities/f.md' }],
  summaryLinkSections: [{ summary: 'summaries/s.md', duplicateLines: 2, conceptsToMove: 1, entitiesToMove: 0 }], indexDrift: [{ missing: 326, stale: 4 }],
};
const OPEN_ALL = new Set(['scan', 'brokenLinks', 'brokenLinksOpen', 'orphans', 'dismissed', 'missingBacklinks', 'folderPrefixLinks', 'summaryLinkSections', 'crossFolderDupes', 'hyphenVariants', 'spelling']);
const CLEAN_REPORT = { counts: { entities: 1, concepts: 1, summaries: 0, dismissed: 0 }, dismissedRecords: 0, scannedAt: '2026-10-30T12:00:00Z',
  brokenLinks: [], orphans: [], crossFolderDupes: [], hyphenVariants: [], folderPrefixLinks: [], missingBacklinks: [], summaryLinkSections: [], indexDrift: [] };
const SCAN = { slug: 'early-computing', previewed: new Set(), preview: null, visible: 50, counting: false, failedPairs: 3, failedAll: false,
  coverage: { total: 2108, checked: 500, left: 1608, next: 500 },
  pairs: [{ keepFolder: 'concepts', keepSlug: 'handoff', removeFolder: 'concepts', removeSlug: 'hand-off', confidence: 'high', rationale: 'Same.', spellingVariant: true, status: 'open' }] };
const PLAN_INDEX = { kind: 'indexRebuild', anchor: 'group:indexDrift', basis: 'b', summary: { add: 326, removeStale: 4, keepDescriptions: 10, repoint: 2, mergeDuplicates: 2, unlinkable: 2, unaddressable: 2, bytesBefore: 100000, bytesAfter: 200000 },
  samples: { add: [{ path: 'concepts/p.md', description: 'd' }, { path: 'concepts/q.md', description: 'e' }], removeStale: [{ target: 'gone', description: 'r' }] } };
const lane = (st) => ({ health: FULL_REPORT, expandedGroups: OPEN_ALL, ...st });
const PRESS_ARMS = [
  ['issues, every lane full', WITH_YES, lane({}), ['Free repairs', 'Your decision', 'AI help', 'Repair all', 'deletes 1 page', 'deletes 2 pages']],
  ['a question that deletes, under its row', WITH_YES, lane({ confirm: { ...ASKED, anchor: 'group:crossFolderDupes' } }), ['dm-confirm-card', 'id="dm-confirm-no"', 'btn-danger']],
  ['a question answered, running', WITH_YES, lane({ busyKey: 'group:crossFolderDupes', confirm: { ...ASKED, anchor: 'group:crossFolderDupes', busy: true, busyLabel: 'Merging…' } }), ['aria-busy="true"', 'Merging…']],
  ['an AI question, under its row', WITH_YES, lane({ confirm: { ...AI_ASKED, anchor: 'group:aiOrphans' } }), ['btn-ai', 'Ask for']],
  ['forgetting comparisons', WITH_YES, lane({ semanticScan: SCAN, confirm: { ...FORGET, anchor: 'group:compare' } }), ['Forget']],
  ['the first AI use', WITH_YES, lane({ confirm: { ...FIRST_USE, anchor: 'group:compare' } }), ['Before you use AI help.']],
  ['a run refused', WITH_YES, lane({ confirm: { ...REFUSED, anchor: 'group:compare' } }), ['Open scan limits', 'Close']],
  ['the links plan open', WITH_YES, lane({ pendingPlan: { kind: 'orphans', anchor: 'group:aiOrphans', plan: [{}], summary: { rescuable: 2, noHome: 3 } } }), ['id="dm-plan-apply-btn"', 'Add these links']],
  ['the targets plan open', WITH_YES, lane({ pendingPlan: { kind: 'brokenLinks', anchor: 'group:aiBroken', plan: [{}], summary: { retarget: 2, strip: 3 } } }), ['Apply', 'Discard']],
  ['the rebuild plan open', WITH_YES, lane({ pendingPlan: PLAN_INDEX }), ['Rebuild the list', 'Cancel']],
  ['a repair running', DOMAIN_HEALTH_CONTRACT, lane({ busyKey: 'group:missingBacklinks', pressAnchor: 'group:missingBacklinks' }), ['aria-busy="true"', 'Repairing…']],
  ['Repair all running', DOMAIN_HEALTH_CONTRACT, lane({ busyKey: 'laneFree', laneRun: { i: 2, n: 5 } }), ['aria-busy="true"', 'Repairing 2 of 5…']],
  ['AI help running', DOMAIN_HEALTH_CONTRACT, lane({ semanticScan: SCAN, busyKey: 'semanticDupesScan', aiProgress: { key: 'semanticDupesScan', processed: 12, total: 500 } }), ['Comparing 12 of 500…']],
  ['a row failed', DOMAIN_HEALTH_CONTRACT, lane({ rowLines: { 'group:missingBacklinks': { key: 'group:missingBacklinks', tone: 'error', text: 'Could not repair: the disk went away', retry() {} } } }), ['dm-outcome-failed', 'Try again']],
  ['the trace', DOMAIN_HEALTH_CONTRACT, lane({ healthTrace: { slug: 'early-computing', lane: 'free', text: 'Repaired 2', at: '2026-11-05T10:00:00Z' }, activeSlug: 'early-computing' }), ['dm-lane-reading', 'Repaired 2']],
  ['a row left as is, with Undo', DOMAIN_HEALTH_CONTRACT, lane({ activeSlug: 'early-computing', leftRows: { 'issue:orphans:{"path":"concepts/w.md"}': { slug: 'early-computing', group: 'orphans', index: 0, issue: { path: 'concepts/w.md' }, type: 'orphans' } } }), ['Left as is.', 'Undo']],
  ['a walk left with pages no pair names', DOMAIN_HEALTH_CONTRACT, lane({ semanticScan: { ...SCAN, pairs: SCAN.pairs.map((p) => ({ ...p, status: 'merged' })), walkWaiting: 2 } }), ['Possible duplicates', 'Review']],
  ['pairs waiting, with the spelling row', DOMAIN_HEALTH_CONTRACT, lane({ semanticScan: SCAN }), ['Possible duplicates', 'Review', 'Spelling variants', '500 of 2,108 pairs compared', 'could not be compared']],
  ['no key', DOMAIN_HEALTH_CONTRACT, lane({ aiAvailable: false, aiRunsOn: { job: 'wiki-health', needsKey: true } }), ['Needs an AI provider key', 'disabled aria-disabled="true"']],
  ['a read-only mirror', DOMAIN_HEALTH_CONTRACT, lane({ readonlyArm: true }), ['read-only Shared Brain mirror']],
  ['a page list with only rows whose page has gone', DOMAIN_HEALTH_CONTRACT, lane({ health: { ...FULL_REPORT, indexDrift: [{ missing: 0, stale: 4 }] } }), ['Rows in the page list with no page']],
  ['a question with no busy word of its own', WITH_YES, lane({ busyKey: 'x', confirm: { ...FORGET, anchor: 'group:compare', busy: true } }), ['Saving…']],
  ['clean', DOMAIN_HEALTH_CONTRACT, { health: CLEAN_REPORT, expandedGroups: new Set(['scan']) }, ['Nothing to fix.', 'All 2 pages were checked', 'dm-rescan-btn', 'nothing to look at']],
  ['clean, with a repair just done', DOMAIN_HEALTH_CONTRACT, { health: CLEAN_REPORT, expandedGroups: new Set(), activeSlug: 'early-computing', healthTrace: { slug: 'early-computing', lane: 'free', text: 'Repaired 5', at: '2026-11-05T10:00:00Z' } }, ['Repaired 5']],
];
for (const [label, contract, over, must] of PRESS_ARMS) {
  PAGES.push({ id: 'domains.health (' + label + ')', contract, enforced: true, render: () => renderDomainHealth(over), must, over });
}

// THE DESK, drawn by the real views/health-review.js inside the real section. These run
// after their setup, so a page's render is a string by the time it is checked.
function renderDeskSection(html) {
  const HEALTH_INFO = explainerMark('dm-health-info', 'domains.health');
  const section = new Function('state', 'escapeHtml', 'HEALTH_INFO', ...SECTION_KIT_NAMES,
    extractFunction(DOMAINS_JS, 'healthSection') + '\nreturn healthSection;')(
    { healthLive: '' }, (t) => String(t), HEALTH_INFO, ...SECTION_KIT_VALUES);
  return section(K.renderCard(html, { alias: 'dm' }), 'Checked <span data-age-text>just now</span> · 25 to look at');
}
const DESK_PAIRS = () => [deskPair('data-privacy', 'privacy-and-data-protection'), deskPair('agent', 'ai-agents', { nameRelation: 'version-differs' }), deskPair('hand-off', 'handoff', { nameRelation: 'spelling-variant' })];
const deskOpen = async (fn, pairs, over) => { const fx = deskFixture(pairs || DESK_PAIRS(), over); fx.desk.open(); await fx.paint(); if (fn) await fn(fx); return renderDeskSection(fx.html()); };
const DESK_ARMS = [
  ['the desk, the comparison seen', await deskOpen((f) => { f.seen(); }), ['Pair 1 of 3', 'Merge into', 'id="hr-merge"', 'btn-danger', 'Read full page']],
  ['the desk, before 500 ms', await deskOpen(), ['aria-describedby="hr-gate" disabled']],
  ['the desk, loading', renderDeskSection((() => { const f = deskFixture(DESK_PAIRS()); f.desk.open(); return f.html(); })()), ['Loading the page…']],
  ['the desk, merging', await deskOpen((f) => { f.seen(); f.state.busyKey = 'semanticMergeOne:' + f.key(f.scan.pairs[0]); }), ['aria-busy="true"', 'Merging…']],
  ['the desk, keeping both', await deskOpen((f) => { f.seen(); f.state.busyKey = 'semanticSkip:' + f.key(f.scan.pairs[0]); }), ['aria-busy="true"', 'Saving…']],
  ['the desk, merged', await deskOpen(async (f) => { f.seen(); await f.press('hr-merge'); }), ['Merged', '4 links moved.', 'Pair 2 of 3']],
  ['the desk, kept apart', await deskOpen(async (f) => { f.seen(); await f.press('hr-keep'); }), ['They will not come back.', 'id="hr-undo"']],
  ['the desk, a merge failed', await deskOpen(async (f) => { f.seen(); f.nextMerge = { error: 'Could not merge: the disk went away' }; await f.press('hr-merge'); }), ['Could not merge: the disk went away', 'id="hr-retry"', 'hr-outcome-failed']],
  ['the desk, the comparison failed', await (async () => { const f = deskFixture(DESK_PAIRS()); f.nextCompare = { error: 'the disk went away' }; f.desk.open(); await f.paint(); return renderDeskSection(f.html()); })(), ['Could not load the comparison: the disk went away', 'aria-describedby="hr-gate" disabled']],
  ['the desk, a page changed', await deskOpen(async (f) => { f.seen(); f.nextMerge = { stale: true }; await f.press('hr-merge'); await f.paint(); }), ['This page changed since you compared it. The comparison has been refreshed.', 'aria-describedby="hr-gate" disabled']],
  ['the desk, the list open', await deskOpen((f) => { f.state.expandedGroups.add('reviewPairs'); }), ['hr-fold-summary', 'this pair', 'hr-jump']],
  ['the desk, the pointer still on Merge', await deskOpen(async (f) => { f.overMerge = true; f.desk.onPointer({ clientX: 5, clientY: 5, pointerType: 'mouse' }); await f.press('hr-next'); await f.paint(); f.seen(); }), ['Move the pointer off Merge and back to press it.', 'aria-describedby="hr-gate" disabled']],
  ['the desk, the end', await deskOpen(async (f) => { f.seen(); await f.press('hr-merge'); await f.paint(); f.seen(); await f.press('hr-keep'); await f.paint(); f.seen(); await f.press('hr-merge'); }, null, { coverage: { left: 12 } }), ['All pairs decided.', '12 pairs have not been compared yet, shown in AI help.']],
];
// A family at the same desk. The same section, the same kit classes, in every state it has.
const FAMILY_PAIRS = () => [deskPair('b', 'a', { rationale: 'A and B match.' }), deskPair('c', 'b', { rationale: 'B and C match.' }), deskPair('d', 'c', { rationale: 'C and D match.' })];
const FAMILY_FACTS = { pages: ['a', 'b', 'c', 'd'].map((s, i) => ({ page: 'concepts/' + s, folder: 'concepts', slug: s, exists: true, opening: 'Opening of ' + s + '.', length: 1000 + i, links: 9 - i })),
  answers: [{ a: 'concepts/a', b: 'concepts/b', compared: 'same', rationale: 'A and B match.' }, { a: 'concepts/b', b: 'concepts/c', compared: 'same', rationale: 'B and C match.' }, { a: 'concepts/c', b: 'concepts/d', compared: 'same', rationale: 'C and D match.' }, { a: 'concepts/a', b: 'concepts/d', compared: 'different', rationale: 'Another subject.' }], kept: [] };
const familyOpen = async (fn) => {
  const f = deskFixture(FAMILY_PAIRS(), { deps: { familyFacts: async (s, pages, textOf) => (textOf ? { pages: [{ page: textOf, exists: true, length: 5000, links: 20 }], answers: [], kept: [], keptText: { text: '# a\n', truncated: false } } : { ...FAMILY_FACTS, pages: FAMILY_FACTS.pages.filter((p) => pages.includes(p.page)) }), keepApart: async () => {}, reload: () => {}, note: 'Every change here can be undone in Recent changes for 30 days, on this computer, while its pages stay unchanged.' } });
  f.desk.open(); await f.paint();
  if (fn) await fn(f);
  return renderDeskSection(f.html());
};
const famPick = async (f) => { await f.press('', { famPick: 'concepts/a' }); await f.paint(); };
DESK_ARMS.push(
  ['a family, which page stays', await familyOpen(), ['Family of 4 pages', 'Decision 1 of 1', 'Which page stays?', 'Keep all 4 apart', 'possible pairs']],
  ['a family, the walk', await familyOpen(async (f) => { await famPick(f); f.seen(); }), ['Page 1 of 3', 'id="hr-merge"', 'btn-danger', 'Merge', 'Choose again', 'aria-label="3 pages to go through: 0 merged, 0 kept, 3 left"']],
  ['a family, never compared', await familyOpen(async (f) => { await famPick(f); f.seen(); await f.press('hr-merge'); await f.paint(); }), ['The AI never compared these two pages.', 'which you have since merged in', 'Page 2 of 3']],
  ['a family, the list open', await familyOpen(async (f) => { await famPick(f); f.state.expandedGroups.add('reviewFamily'); }), ['All 3 pages', 'The AI never compared these with', 'this page', 'hr-fam-jump']],
  ['a family, a merged page gone back to', await familyOpen(async (f) => { await famPick(f); f.seen(); await f.press('hr-merge'); await f.paint(); await f.press('hr-prev'); await f.paint(); }), ['This page no longer exists', 'Nothing more to decide here.']],
  ['a family, a kept page gone back to', await familyOpen(async (f) => { await famPick(f); await f.press('hr-keep'); await f.paint(); await f.press('hr-prev'); await f.paint(); }), ['apart.', 'id="hr-undo"', 'Goes away']],
  ['a family, finished', await familyOpen(async (f) => { await famPick(f); f.seen(); await f.press('hr-merge'); await f.paint(); await f.press('hr-done'); await f.paint(); for (const k of ['reviewFamMerged', 'reviewFamLeft']) f.state.expandedGroups.add(k); }), ['Took in 1 page.', 'Merged in', 'Not decided', 'Go back to them', 'Review those', 'Every change here can be undone in Recent changes']],
  ['a family, kept apart', await familyOpen(async (f) => { await f.press('hr-fam-apart'); await f.paint(); }), ['Kept these 4 pages apart.', 'id="hr-undo"']],
);
for (const [label, html, must] of DESK_ARMS) {
  PAGES.push({ id: 'domains.health (' + label + ')', contract: DOMAIN_HEALTH_CONTRACT, enforced: true, render: () => html, must });
}

// ── THE WORDS AND THE LANES (PLAN §3). Each is proved to fail, below, and each by
// mutating the real code in the stage's mutation run.
const LANE_TITLES = ['Free repairs', 'Your decision', 'AI help'];
const WARN = 'You can undo this in Recent changes for 30 days, on this computer only, while none of these pages has changed since.';
const hasClass = (n, c) => (n.classes || []).includes(c);
const ancestorWith = (n, pred) => { for (let p = n.parent; p; p = p.parent) if (pred(p)) return p; return null; };
// What a person reads: every element's own text, with page names and page text out.
// A page's own words are data.
function visibleLines(root) {
  const lines = [];
  walk(root, (n) => {
    if (n.tag === '#text' || n.tag === 'svg' || n.tag === 'style') return;
    if (hasClass(n, 'visually-hidden') || hasClass(n, 'mono') || hasClass(n, 'dm-plan-data') || hasClass(n, 'ai-run-model') || hasClass(n, 'tx-status-detail') || hasClass(n, 'hr-fam-pick-open')) return;
    if (ancestorWith(n, (p) => hasClass(p, 'visually-hidden') || hasClass(p, 'mono') || hasClass(p, 'dm-plan-data'))) return;
    if (ancestorWith(n, (p) => hasClass(p, 'hr-pane-text'))) return;
    let t = ''; let own = false;
    for (const c of n.children || []) {
      if (c.tag === '#text') { const v = c.text == null ? (c.value || '') : c.text; t += v; if (v.trim()) own = true; }
      else if (hasClass(c, 'mono') || hasClass(c, 'ai-run-model')) t += 'NAME';
      else if ('data-age-text' in c.attrs) t += 'just now';
    }
    if (own) lines.push(t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim());
  });
  return lines;
}
function healthContractViolations(html) {
  const bad = [];
  const root = parseHtml(html);
  if (/dm-banner/.test(html)) bad.push('a banner inside the section: an outcome belongs on its row');
  if (/btn-ghost/.test(html)) bad.push('a text-styled button: every control has visible chrome');
  // The ⓘ panel's link to the user guide is the shared explainer's, and a real link.
  if (/role="button"|onclick=|<a\s/.test(html.replace(/<a class="xp-guide"/g, ''))) bad.push('something clickable that is not a <button>');
  if ((html.match(/aria-live=/g) || []).length !== 1) bad.push('the section must hold exactly one live region');
  for (const t of LANE_TITLES) {
    const n = (html.match(new RegExp('class="dm-lane-title">' + t + '<', 'g')) || []).length;
    if (n > 1) bad.push('the lane title "' + t + '" appears ' + n + ' times');
  }
  walk(root, (n) => {
    if (n.tag !== 'button') {
      if (hasClass(n, 'btn')) bad.push('a .btn that is not a <button>: ' + n.tag);
      return;
    }
    const inAi = !!ancestorWith(n, (p) => hasClass(p, 'dm-lane-ai'));
    if (hasClass(n, 'btn-ai')) {
      if (!inAi) bad.push('btn-ai outside AI help');
      const costed = (n.children || []).some((c) => hasClass(c, 'cur-action-cost'));
      const quiet = 'disabled' in n.attrs || n.attrs['aria-busy'] === 'true';
      if (!costed && !quiet) bad.push('an AI button with no cost');
    }
    if (hasClass(n, 'btn-primary')) bad.push('btn-primary: nothing here leans toward an action');
    if (hasClass(n, 'btn-danger')) {
      const ownText = (m) => (m.children || []).map((c) => (c.tag === '#text' ? (c.text || c.value || '') : ownText(c))).join('');
      const label = ownText(n).trim();
      const block = ancestorWith(n, (p) => hasClass(p, 'dm-confirm-card') || hasClass(p, 'hr-decide'));
      if (!/^(Merge and delete [\d,]+|Merging|Merge into \S|Merge \S+ into \S)/.test(label)) bad.push('btn-danger whose label does not name its result: ' + label);
      if (!block || !html.includes(WARN)) bad.push('btn-danger without the undo warning in its block');
    }
  });
  for (const l of visibleLines(root)) {
    if (!l || isFigure(l)) continue;
    if (BANNED.test(l)) bad.push('a banned word on screen: ' + l);
    if (/^[A-Z][A-Z ]{3,}$/.test(l)) bad.push('capitals on screen: ' + l);
    if (!wordAllowed(l)) bad.push('not in the deck: ' + l);
  }
  return bad;
}
const pressRuleViolations = healthContractViolations;

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
  ok(pressRuleViolations(base + '<button class="btn btn-ghost">Cancel</button>').some((v) => /text-styled/.test(v)), 'CONTROL — a ghost button goes red');
  ok(pressRuleViolations(base + '<span role="button">Cancel</span>').some((v) => /not a <button>/.test(v)), 'CONTROL — a span acting as a button goes red');
  ok(pressRuleViolations(base + '<div aria-live="polite"></div>').length === 1, 'CONTROL — a second live region goes red');
  const full = renderDomainHealth(lane({}));
  ok(pressRuleViolations(full + '<div class="dm-lane-title">Free repairs</div>').some((v) => /appears 2 times/.test(v)), 'CONTROL — a lane title twice goes red');
  ok(pressRuleViolations(full + '<button class="btn btn-ai">Go<span class="cur-action-cost">$1</span></button>').some((v) => /outside AI help/.test(v)), 'CONTROL — an AI button outside the lane goes red');
  ok(pressRuleViolations(full.replace(/<span class="cur-action-cost[^"]*">[^<]*<\/span>/g, '')).some((v) => /with no cost/.test(v)), 'CONTROL — an AI button with no cost goes red');
  ok(pressRuleViolations(full + '<button class="btn btn-primary">Go</button>').some((v) => /btn-primary/.test(v)), 'CONTROL — a primary button goes red');
  ok(pressRuleViolations(full + '<div class="dm-confirm-card"><button class="btn btn-danger">Delete</button></div>').some((v) => /does not name/.test(v)), 'CONTROL — a danger button that names nothing goes red');
  ok(pressRuleViolations(full + '<div>Fix the orphan pages</div>').some((v) => /banned word/.test(v)), 'CONTROL — a banned word goes red');
  ok(pressRuleViolations(full + '<div>OVERVIEW OF THINGS</div>').some((v) => /capitals/.test(v)), 'CONTROL — capitals go red');
  ok(pressRuleViolations(full + '<div>Words nobody agreed</div>').some((v) => /not in the deck/.test(v)), 'CONTROL — a word outside the deck goes red');
  const emptyLanes = renderDomainHealth({ health: CLEAN_REPORT, expandedGroups: new Set() });
  ok(!/Free repairs|Your decision/.test(emptyLanes) && /AI help/.test(emptyLanes), 'an empty lane renders nothing, title included; AI help stays');
  ok(!/AI help|btn-ai|dm-lane-title/.test(renderDomainHealth(lane({ readonlyArm: true }))), 'a mirror draws the facts, and no lane and no AI action');
  // No uppercase anywhere in the section, whatever a shared part does elsewhere.
  ok(/\.dm-section\.dm-health \* \{ text-transform: none; \}/.test(readFileSync(join(ROOT, 'src/public/next/views/domains.css'), 'utf8')), 'nothing in the section can be uppercased by a shared part');
}
{
  // ANTI-VACUITY for the first client: the rendered card really holds the
  // things the rules are about, so a pass is a finding.
  const html = renderDomainHealth();
  ok(/<details class="cur-fold dm-group/.test(html) && /dm-lane-ai/.test(html)
    && /<button class="btn btn-secondary" id="dm-rescan-btn"/.test(html) && /class="cur-mon/.test(html)
    && /class="tx-desc/.test(html),
  'CONTROL — the ⑤ render holds fold rows, AI help, the control-row button, a monitor and a footnote');
  const mutated = html.replace('<div class="cur-card-top dm-health-top">', '</div><div class="cur-card-top dm-health-top">');
  ok(checkPageContract(mutated, DOMAIN_HEALTH_CONTRACT).length > 0,
    'CONTROL — the same render with Check again moved out of its card goes red');
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
