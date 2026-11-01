/**
 * THE REAL SETTINGS › MCP BRIDGE PAGE, RENDERED IN PLAIN NODE (v3.89.0).
 *
 * views/settings.js imports app.js, which touches `document` at import, so a
 * suite cannot import it. This helper lifts the page's own functions out of
 * the source (brace-matched, comments stripped) and executes them with the
 * REAL DOM-free modules they import — the section kit, the overview, the
 * monitor, text.js, the explainers, mcp-install.js — so what a suite asserts
 * on is the markup the app paints. Only three things are stubbed, each
 * because it touches the DOM or the shell: `icon()` (app.js), the shared
 * listbox (it reads `document` at import; the stub emits its `lb-*` shape),
 * and the loading gate (a plain object).
 *
 *   renderMcpPage(state, {gateVisible}) → { html, column, pending }
 *     html    — renderMcp()'s output (the section body)
 *     column  — the view header + html: the column the page contract checks
 *     pending — the listbox configs the render queued (pendingListboxes)
 *
 * `baseState()` is a realistic payload set (GET /api/mcp/config, /usage,
 * /install/status, /setup/machine, /usage?include=projects) a suite overrides.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as K from '../../src/public/next/shared/section.js';
import * as MI from '../../src/public/next/views/mcp-install.js';
import { renderOverview } from '../../src/public/next/shared/overview.js';
import { renderMonitor } from '../../src/public/next/shared/monitor.js';
import { renderStatus, renderDescription, renderViewHeader } from '../../src/public/next/shared/text.js';
import { explainerMark, explainerHtml } from '../../src/public/next/shared/explainer.js';
import { formatAge, freshnessTier } from '../../src/public/next/shared/age.js';
import { domainIdentityClass } from '../../src/public/next/shared/sidebar.js';
import { gatedLoader } from '../../src/public/next/shared/loading-gate.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SETTINGS_SRC = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');

export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}
export function extractFunction(src, name) {
  const m = new RegExp(`(?:^|\\n)(?:async\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start); let d = 0;
  for (; p < src.length; p++) { if (src[p] === '(') d++; else if (src[p] === ')') { d--; if (d === 0) { p++; break; } } }
  let i = src.indexOf('{', p); d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { i++; break; } } }
  return src.slice(start, i);
}
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

export const PAGE_FUNCTIONS = ['renderMcp', 'mcpSection', 'mcpOverviewHtml', 'mcpInstallCtx', 'metaAge', 'appsMetaWords',
  'bridgeMetaWords', 'agentUseMetaWords', 'acrossMetaWords', 'renderAgentAppsCard', 'renderBridgeCard', 'renderExerciseOutcome',
  'renderToolMapBody', 'renderAcrossProjectsBody', 'installRevealPaths', 'installMachineFiles', 'currentBridgeFacts', 'lastSelfTest',
  'lastExerciseRun', 'installWords', 'installPlatform', 'ageSecondsOf', 'usageWindowWords', 'footWindowWords', 'agentReading',
  'tickedAgeHtml', 'sessionLine', 'adaptProjects', 'acrossWindowWords', 'windowDaysWords', 'logWindowWords'];
const CONSTS = ['mcpMetaAges', 'AGENT_USE_TOP', 'ACROSS_PROJECTS_MAX_ROWS', 'MCP_DOMAIN_CONSEQUENCE'];

function bodyOf(src) {
  const code = stripComments(src);
  return CONSTS.map((c) => extractConst('\n' + code, c)).join('\n') + '\n'
    + PAGE_FUNCTIONS.map((n) => extractFunction(code, n)).join('\n') + '\nreturn renderMcp;';
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const icon = (n, size) => '<svg width="' + (size || 19) + '" height="' + (size || 19) + '" viewBox="0 0 24 24" fill="none" aria-hidden="true" data-icon="' + n + '"></svg>';
const listbox = (cfg) => '<span class="lb" data-lb-root="' + esc(cfg.id) + '"><button type="button" class="lb-btn ' + esc(cfg.triggerClass || '') + '" id="'
  + esc(cfg.id) + '" aria-label="' + esc(cfg.ariaLabel) + '"' + (cfg.disabled ? ' disabled' : '') + '><span class="lb-btn-text">'
  + esc((cfg.options.find((o) => o.value === cfg.value) || cfg.options[0]).label) + '</span></button></span>';

const DEPS = {
  escapeHtml: esc, icon, renderListboxHtml: listbox, explainerMark, explainerHtml, renderOverview, renderMonitor,
  renderStatus, renderDescription, formatAge, freshnessTier, domainIdentityClass, gatedLoader,
  machineWord: MI.machineWord, adaptMachine: MI.adaptMachine, adaptBridges: MI.adaptBridges, tildePath: MI.tildePath,
  renderAgentApps: MI.renderAgentApps, countsFor: MI.countsFor, appRowModels: MI.appRowModels,
  renderSectionHead: K.renderSectionHead, renderCard: K.renderCard, renderControlRow: K.renderControlRow,
  renderFoldRows: K.renderFoldRows, renderFoldRow: K.renderFoldRow, renderFoldItem: K.renderFoldItem, renderStatusLine: K.renderStatusLine,
};
const NAMES = Object.keys(DEPS);
const factoryOf = (src) => new Function('state', 'loadGate', 'pendingListboxes', 'myMountToken', 'onSaveDefaultDomain', ...NAMES, bodyOf(src));
const FACTORY = factoryOf(SETTINGS_SRC);

/**
 * Render the real page. `opts.source` renders a MUTATED copy of settings.js
 * instead (a suite proving a guard by mutation edits the real code, never a
 * fixture). `opts.deps` replaces an import (e.g. a mutated mcp-install builder).
 */
export function renderMcpPage(state, opts = {}) {
  const pending = [];
  const gate = { visible: opts.gateVisible !== false };
  const make = opts.source ? factoryOf(opts.source) : FACTORY;
  const deps = { ...DEPS, ...(opts.deps || {}) };
  const renderMcp = make(state, gate, pending, 1, () => {}, ...NAMES.map((n) => deps[n]));
  const html = renderMcp();
  const column = renderViewHeader({ eyebrow: 'configuration', title: 'MCP bridge', info: explainerHtml('settings.mcp'), infoHtml: true }) + html;
  return { html, column, pending };
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
export const ENTRY = '{"mcpServers":{"my-curator":{"command":"/x/launcher","args":[]}}}';
const TOOL_NAMES = ['list_domains', 'get_index', 'search_wiki', 'get_node', 'get_backlinks', 'get_connected_nodes', 'get_graph_overview',
  'get_tags', 'get_summary', 'get_raw_source', 'search_cross_domain', 'scan_wiki_health', 'scan_semantic_duplicates', 'get_health_dismissed',
  'get_project_context', 'get_working_state', 'list_projects', 'compile_to_wiki', 'fix_wiki_issue', 'dismiss_wiki_issue',
  'undismiss_wiki_issue', 'save_working_state', 'save_project_brief', 'save_foundation'];
const WRITES = new Set(['compile_to_wiki', 'fix_wiki_issue', 'dismiss_wiki_issue', 'undismiss_wiki_issue', 'save_working_state', 'save_project_brief', 'save_foundation']);

/**
 * A realistic page: Claude Desktop connected and used, Antigravity connected
 * with an outdated skill (to fix), Cursor can be added, Cline copy-only, a
 * week of agent use, two projects that saved and one that did not.
 */
export function baseState(over = {}) {
  const tools = TOOL_NAMES.map((name, i) => ({
    name, group: WRITES.has(name) ? 'write' : 'read', purpose: '',
    count7dAgent: name === 'save_working_state' ? 177 : name === 'get_project_context' ? 13 : i < 6 ? 6 - i : 0,
    lastAgentAt: i < 6 || name === 'save_working_state' || name === 'get_project_context' ? iso(17 * 60e3) : null,
    lastUsedAt: iso(9 * 60e3), lastVia: 'self-test',
  }));
  const s = {
    section: 'mcp',
    mcp: { domains_dir: '/Users/ann/second-brain/domains', domains_dir_exists: true, mcp_server_exists: true,
      bridge_processes: { checked: true, running: 0, stale: [], bridges: [], current: { version: '3.89.0', toolsHash: 'aaaa', toolCount: 24 } } },
    mcpError: null,
    selfTest: null, selfTestAt: null, selfTestLoading: false,
    mcpExercise: null, mcpExerciseBusy: false, mcpExerciseError: null,
    setupMachineFolds: {}, mcpChecks: {}, mcpCheckBusy: null,
    defaultDomainInfo: { domains: ['articles', 'projects'], defaultDomain: 'projects', identity: { projects: 5, articles: 2 } },
    defaultDomainSaving: false, defaultDomainError: null,
    mcpUsage: { present: true, logStartedAt: iso(20 * 86400e3), countWindowDays: 7, tools,
      sessions: { lastBootstrapAt: iso(6 * 3600e3), lastSaveAt: iso(51 * 60e3) }, lastExercise: null, lastSelfTest: { at: iso(37 * 60e3), ok: true, toolCount: 24 } },
    mcpUsageError: null,
    mcpProjects: { byProject: [
      { domain: 'projects', project: 'agentlink', saves: 41, lastSaveAt: iso(86400e3), inStore: true },
      { domain: 'projects', project: 'curator', saves: 12, lastSaveAt: iso(51 * 60e3), inStore: true, savesCapped: true },
      { domain: 'articles', project: 'field-notes', saves: 0, lastSaveAt: null, inStore: true },
    ], window: { windowDays: 30, logPresent: true, savesWindowDays: 30 },
    savePulse: { events: 53, windowSeconds: 30 * 86400, byTool: [{ label: 'Claude Code', events: 53 }, { label: 'Antigravity', events: 0, lastSeenAt: '2026-10-25T10:00:00Z' }] } },
    mcpProjectsError: null,
    setupMachine: { data: { ok: true, checkedAt: iso(2000), version: '3.89.0', install: 'Packaged app', skillsShipped: true,
      harnesses: [
        { id: 'claude-desktop', label: 'Claude Desktop', bridge: { state: 'ok', word: 'configured' },
          skills: { state: 'cant-check', word: 'can’t check here', note: 'held by your Claude account', installed: [] },
          hooks: { state: 'none', format: 'none', files: [] },
          files: [{ file: '/Users/ann/Library/Application Support/Claude/claude_desktop_config.json', display: '~/Library/Application Support/Claude/claude_desktop_config.json', via: 'own', present: true, named: true, status: 'ok' }] },
      ] } },
    mcpInstall: { status: { data: {
      platform: 'darwin', writable: true,
      counts: { connected: 2, toFix: 1, notConnected: 2 },
      install: { available: 1, disabledReason: null, disabledText: null },
      notFound: [{ id: 'zed', label: 'Zed' }], manualSnippets: { cursor: ENTRY, cline: ENTRY, zed: ENTRY, 'claude-desktop': ENTRY },
      tools: [
        { id: 'claude-desktop', label: 'Claude Desktop', status: 'connected', installer: 'file', running: { checked: true, running: true },
          usedAt: iso(6 * 3600e3), lastStartedAt: iso(6 * 3600e3), entryWrittenAt: iso(2 * 86400e3), checkEntry: true, restorable: true,
          files: [{ file: '/Users/ann/Library/Application Support/Claude/claude_desktop_config.json', display: '~/Library/Application Support/Claude/claude_desktop_config.json', state: 'connected' }],
          verdict: 'connected', toFix: 0 },
        { id: 'antigravity', label: 'Antigravity', status: 'connected', installer: 'file', running: { checked: true, running: false },
          usedAt: iso(7 * 86400e3), checkEntry: true, verdict: 'to-fix', toFix: 1,
          skill: { text: 'Its my-curator skill is older than this app’s copy (1 file differs).', detail: 'Download it, replace …/skills/my-curator with it, then start a new Antigravity session.',
            fixes: [{ kind: 'download-skill', skill: 'my-curator' }, { kind: 'reveal', path: '/Users/ann/.gemini/skills/my-curator', label: 'Reveal folder' }] },
          files: [{ file: '/Users/ann/.gemini/config/mcp_config.json', display: '~/.gemini/config/mcp_config.json', state: 'connected' }] },
        { id: 'cursor', label: 'Cursor', status: 'not-installed', installer: 'file', running: { checked: true, running: false },
          files: [{ file: '/Users/ann/.cursor/mcp.json', display: '~/.cursor/mcp.json', state: 'missing', action: 'add' }], verdict: 'not-connected', toFix: 0 },
        { id: 'cline', label: 'Cline', status: 'manual', installer: 'cli', running: { checked: false, running: false },
          reason: { code: 'installer_cli', message: 'Cline has its own command for this.' }, files: [], verdict: 'not-connected', toFix: 0 },
      ] } },
      ticks: {}, plan: null, results: null, busy: null, error: null, copied: null },
  };
  return { ...s, ...over };
}
