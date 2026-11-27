/**
 * The Projects page (phase 2 of the Simple/Pro redesign, 2026-11-27;
 * CONTRACT-projects-v2). OFFLINE: the REAL model (views/projects/model.js)
 * and the REAL markup (views/projects/page.js) — both DOM-free — driven in
 * plain Node with the v4.2 setup-check fixture.
 *
 *   §1 the harness rows: the closed status vocabulary from harnessRowModel
 *   §2 the header's one status sentence, from real state only
 *   §3 the Now tab's warnings, every one a kit notice
 *   §4 the layouts: Simple draws three tabs and the one quiet line; Pro six
 *      tabs, tables, the tile strip; NO per-block "PRO" marking anywhere (D5)
 *   §5 NEVER-HIDE over the whole page, tab by tab (test-helpers/pro-guard.js
 *      pageParityFaults): every warning Pro shows is on a Simple tab, and a
 *      Pro-only tab holds none that Simple does not
 *   §6 THE KIT GUARD: the page's own classes are layout only — a `prj-` class
 *      naming a row, chip, notice, table or fold is refused, and page.js uses
 *      no class outside the kit, the buttons and its own layout set
 *   §7 the connect checklist (the only numbers on the page)
 *   §8 the Starting kit's words, History, the Agents matrix, Computers
 *   §9 every to-fix line is a notice in BOTH modes, with its own fix
 *
 * Every guard here is proven by mutation (see the contract report).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageParityFaults, parseHtml, textOf } from './test-helpers/pro-guard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = await import('../src/public/next/views/projects/model.js');
const P = await import('../src/public/next/views/projects/page.js');
const S = await import('../src/public/next/views/setup-step.js');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 900) : '')); }
}
const section = (t) => console.log('\n' + t);
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const words = (h) => textOf(parseHtml(String(h))).replace(/\s+/g, ' ').trim();

// ── the fixture: the v4.2 setup payload (scripts/test-context-setup-modes.js) ──
const ok4 = (word) => ({ state: 'ok', word });
const demo = () => ({
  ok: true, domain: 'projects', project: 'exhibit-site', checkedAt: iso(30e3),
  repo: null,
  tools: [
    { id: 'claude-code', label: 'Claude Code', status: 'ready',
      saved: { state: 'ok', at: iso(4 * 60e3), scope: 'claude-code', machine: 'mac-a', thisMachine: true, wrongScope: false },
      parts: { mcp: ok4('configured'), skills: ok4('current'), block: ok4('current · at the top'), hooks: { state: 'none', word: 'not wired, optional' } },
      reads: ['CLAUDE.md'] },
    { id: 'antigravity', label: 'Antigravity', status: 'to-fix',
      saved: { state: 'ok', at: iso(2 * 3600e3), scope: 'antigravity', machine: 'mac-a', thisMachine: true, wrongScope: false },
      parts: { mcp: ok4('configured'), skills: { state: 'fix', word: 'my-curator outdated' }, block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'unmeasured', word: 'wired · unmeasured' } },
      reads: ['AGENTS.md', 'GEMINI.md'],
      skillsTarget: { path: '~/.gemini/config/plugins/the-curator/skills', verified: true } },
    { id: 'codex', label: 'Codex', status: 'no-save', saved: { state: 'none', at: null },
      parts: { mcp: { state: 'none', word: 'not found' }, skills: { state: 'none', word: 'not installed' }, block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'none', word: '—' } },
      reads: ['AGENTS.md'], userAdded: true, removable: { ok: true },
      mcpSnippet: { format: 'toml', text: '[mcp_servers.my-curator]\ncommand = "node"' },
      mcpTarget: { display: '~/.codex/config.toml', file: '/x/.codex/config.toml', format: 'toml', exists: false },
      skillsTarget: { path: '~/.codex/skills', verified: true } },
    { id: 'opencode', label: 'OpenCode', status: 'no-save',
      saved: { state: 'ok', at: iso(26 * 3600e3), scope: 'opencode', machine: 'studio-mac', thisMachine: false, wrongScope: false },
      parts: { mcp: { state: 'none', word: 'not found' }, skills: { state: 'none', word: 'not installed' }, block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'none', word: '—' } },
      reads: ['AGENTS.md', 'CLAUDE.md'] },
  ],
  physical: [
    { thisComputer: true, installs: [{ primary: 'mac-a', names: ['mac-a'], thisComputer: true, installKind: 'app', tools: ['Antigravity', 'Claude Code'], newestSaveAt: iso(4 * 60e3), curatorVersion: '4.2.2', waiting: 0,
      saves: [{ at: iso(4 * 60e3), tool: 'claude-code' }, { at: iso(2 * 3600e3), tool: 'antigravity' }] }] },
    { thisComputer: false, installs: [{ primary: 'studio-mac', names: ['studio-mac'], thisComputer: false, installKind: 'app', tools: ['OpenCode'], newestSaveAt: iso(26 * 3600e3), curatorVersion: '4.2.1', waiting: 1,
      saves: [{ at: iso(26 * 3600e3), tool: 'opencode' }, { at: iso(30 * 3600e3), tool: 'claude-code' }] }] },
  ],
  computers: [],
  sync: { configured: true, lastSync: iso(3600e3), pending: 2, incoming: ['x'], incomingCheckedAt: iso(60e3) },
  toFix: [
    { tool: 'antigravity', kind: 'skills', reason: 'outdated', skills: ['my-curator'],
      text: 'Antigravity’s my-curator skill is older than the copy this app carries (in ~/.gemini/config/plugins/the-curator/skills).',
      detail: 'Download the current .zip, replace the folder with it, then start a new Antigravity session.',
      fixes: [{ kind: 'download-skill', skill: 'my-curator', href: '/api/setup/skills/my-curator.zip', label: 'Download my-curator.zip' }] },
    { kind: 'sync-incoming', machine: 'studio-mac', waiting: 1,
      text: 'studio-mac saved a newer handoff; it’s waiting in your Personal Sync on GitHub.', detail: 'Sync now before you start the agent.',
      fixes: [{ kind: 'sync', label: 'Sync now' }] },
  ],
  addable: [{ id: 'cursor', label: 'Cursor', group: 'known', reads: ['AGENTS.md'], configPaths: ['~/.cursor/mcp.json'] }],
});

const read = () => ({
  scopes: [
    { scope: 'checkout', machine: 'mac-a', headline: 'Checkout flow: tests green, payment retry still open', harness: 'claude-code', harnessLabel: 'Claude Code', model: 'opus-5-5', bytes: 1843, writtenAt: iso(27 * 60e3) },
    { scope: 'setup', machine: 'studio-mac', headline: 'Project set up; test runner chosen', harness: 'cursor', harnessLabel: 'Cursor', model: 'gpt-5.1', bytes: 912, writtenAt: iso(3 * 86400e3) },
    { scope: 'address', machine: 'mac-a', headline: 'Address step done; cart totals fixed', harness: 'claude-code', harnessLabel: 'Claude Code', model: 'opus-5-5', bytes: 2100, writtenAt: iso(86400e3) },
  ],
  brief: { present: true, text: '# Brief\n\nKeep it small.' },
});

// ═══════════════════════════════════════════════════════════════════════════
section('§1 the harness rows — the closed status vocabulary');
{
  const rows = M.harnessRows(demo());
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  ok(rows.length === 4, 'one row per harness on the list', rows.length);
  ok(by['claude-code'].kind === 'ready', 'Claude Code (nothing left) → Ready', by['claude-code'].kind);
  ok(by.antigravity.kind === 'needs-you', 'Antigravity (a to-fix line names it) → Needs you', by.antigravity.kind);
  ok(by.codex.kind === 'off', 'Codex (not connected here, steps left) → Not connected', by.codex.kind);
  ok(by.opencode.kind === 'off', 'OpenCode (saved from another computer only) → Not connected', by.opencode.kind);
  ok(rows.every((r) => ['ready', 'needs-you', 'working', 'off', 'unknown', 'error'].includes(r.kind)), 'every kind is one of shared/status.js\'s');
  ok(rows.every((r) => !/<|&[a-z]+;/.test(r.meta)), 'every meta line is plain text (no markup, no entities)', rows.map((r) => r.meta).join(' | '));
  ok(by['claude-code'].action === null, 'a Ready row carries no action', JSON.stringify(by['claude-code'].action));
  ok(['codex', 'opencode', 'antigravity'].every((id) => by[id].action && by[id].action.attrs['data-setup-act']),
    'every other row carries ONE action the view\'s setup listener knows (data-setup-act)', JSON.stringify(rows.map((r) => r.action)));
  ok(rows.every((r) => r.targetId === 'mem-setup-tool-' + r.id), 'each row\'s open target carries the id its reader returns focus to');
  // The count a row says is the guide's (guideTally), never a second count.
  const codexModel = S.harnessRowModel(demo().tools[2], demo());
  ok(by.codex.meta.startsWith(codexModel.word), 'a row with steps left leads with harnessRowModel\'s own count ("' + codexModel.word + '")', by.codex.meta);
}

section('§2 the header\'s one status sentence');
{
  const data = demo();
  const rows = M.harnessRows(data);
  const s = M.statusSentence({ read: read(), harnessRows: rows, thisNames: M.thisComputerNames(data), machineWord: 'Mac', machineName: (x) => x });
  ok(/^Claude Code saved a note 27 min ago on this Mac\./.test(s), 'names the newest save: harness, age, "this Mac"', s);
  ok(/Antigravity needs one step from you\./.test(s), 'names the ONE harness that needs the owner', s);
  const two = rows.map((r) => (r.id === 'claude-code' ? { ...r, kind: 'needs-you' } : r));
  ok(/2 agents need a step from you\./.test(M.statusSentence({ read: read(), harnessRows: two, thisNames: new Set(['mac-a']), machineWord: 'Mac' })), 'two that need the owner are counted');
  const none = M.statusSentence({ read: { scopes: [] }, harnessRows: [] });
  ok(none === 'No agent has saved here yet. Connect one to start.', 'no save, nothing connected → the blank-slate sentence', none);
  const conn = M.statusSentence({ read: { scopes: [] }, harnessRows: rows });
  ok(conn === 'No agent has saved here yet. Ask one to save where you are.', 'no save but an agent connected → ask it to save', conn);
  const else_ = M.statusSentence({ read: { scopes: [read().scopes[1]] }, harnessRows: rows, thisNames: new Set(['mac-a']), machineWord: 'Mac', machineName: () => 'Studio' });
  ok(/saved a note 3 days ago on Studio\./.test(else_), 'a save from another computer names that computer', else_);
  ok(M.statusSentence({ read: null }) === '', 'no read, no sentence (nothing is invented)');
  ok(s.split(/(?<=\.)\s/).length <= 3, 'one short status, never a paragraph', s);
}

section('§3 the Now tab\'s warnings — every one a kit notice');
{
  const all = M.nowNotices({
    readonly: true, staleWrite: true, lastSaveKind: 'trimmed', lastSaveNote: 'body: 52,000 bytes over',
    sharedHandoffs: [{ scope: 'main', who: 'Cursor and Claude Code' }],
    elsewhere: { machine: 'studio-mac', scope: 'setup', age: '2 hr ago' },
    unlisted: { reason: '2 directory entries are not addressable by name.' }, truncated: true, sanitised: true,
  });
  const titles = all.map((n) => n.title);
  for (const [want, tone] of [
    ['This is a read-only Shared Brain mirror.', 'info'],
    ['An agent saved here since you opened this page.', 'attention'],
    ['Part of the last handoff did not survive the save.', 'error'],
    ['Two agents are writing the same handoff.', 'error'],
    ['studio-mac saved after this computer.', 'attention'],
    ['Some state here is on disk but is not being read.', 'attention'],
    ['This handoff is longer than the state budget.', 'attention'],
    ['Protocol-shaped text in this handoff was neutralised on read.', 'info'],
  ]) {
    const n = all.find((x) => x.title === want);
    ok(n && n.tone === tone, '"' + want + '" is a ' + tone + ' notice', JSON.stringify(n));
  }
  ok(all.find((x) => x.title.startsWith('Part of')).line.includes('body: 52,000 bytes over'), 'the store\'s own note is kept in the line');
  ok(all.every((n) => n.title.split(/\s+/).length <= 12), 'every title is at most 12 words', titles.join(' | '));
  ok(all.find((x) => x.title === 'An agent saved here since you opened this page.').actions[0].attrs['data-prj-act'] === 'reload', 'the stale notice offers Reload');
  ok(all.find((x) => x.title.endsWith('saved after this computer.')).actions[0].attrs['data-setup-act'] === 'sync', 'the newer-elsewhere notice offers Sync now');
  ok(M.nowNotices({}).length === 0, 'nothing to say → no notice');
  // Rendered, every one is a kit notice (role status/alert).
  const html = P.nowPanel({ notices: all, hasSave: true, handoff: { title: 'T', bodyHtml: '<p>b</p>', footer: 'Claude Code · this Mac · 27 min ago' }, earlier: [] });
  ok((html.match(/class="kit-notice /g) || []).length === all.length, 'each warning renders as ONE kit notice', (html.match(/class="kit-notice /g) || []).length);
  ok(/role="alert"/.test(html) && /role="status"/.test(html), 'errors are role=alert, the rest role=status');
}

// ── the page in both modes, from ONE set of models ────────────────────────
const nowModel = (pro) => ({
  pro, notices: M.nowNotices({ staleWrite: true, lastSaveKind: 'replaced' }), hasSave: true,
  handoff: { title: 'Checkout flow: tests green', bodyHtml: '<p>Cart and address steps are done.</p>', footer: 'Claude Code · this Mac · 27 min ago', deleteScope: 'checkout' },
  earlier: M.earlierNotes(read().scopes, read().scopes[0], {}),
  proFacts: [{ label: 'Work-stream', value: 'checkout' }],
  journal: { rows: [{ id: 'j0', cells: { when: '27 min ago', harness: 'Claude Code', model: 'opus', headline: 'x' } }] },
});
const agentsModel = (pro) => {
  const data = demo();
  return {
    pro, state: 'ok', rows: M.harnessRows(data), notices: M.toFixNotices(data), unsynced: 2,
    checkedWords: 'checked just now',
    matrix: pro ? { rows: M.agentMatrix(data, { machineWord: 'Mac' }), view: 'computer' } : null,
  };
};
// The outcome of a failed reading-budget save: the view (memory.js
// prjBudgetNotices) puts the SAME notice on Starting kit (both modes) and on
// Pro's Budget tab — the fixture does the same, so §5 sees a real pair.
const BUDGET_FAIL = { tone: 'error', title: 'The reading budget was not changed.', line: 'The store refused the write.' };
const kitModel = (pro) => ({
  pro, notices: [{ tone: 'attention', title: 'The always-read documents are over their budget.', line: 'They are 70 KB of a 64 KB budget.' }, BUDGET_FAIL],
  brief: { meta: M.briefMeta({ present: true, words: 3038 }) },
  documents: { meta: M.documentsMeta({ count: 9, readFirstCount: 2, hiddenCount: 0 }) },
  knowledge: { meta: 'Work · 1,070 pages an agent can search' },
  figure: M.kitBudgetFigure(25900, 1000000), settingsWords: 'Reading budget: Standard ≈16.4k',
  docTable: pro ? P.documentsTable([{ slug: 'arch', title: 'Architecture', source: 'this computer', startWord: 'Always read', tokens: '≈8.4k', tokenCount: 8400, updated: '2 days ago' }]) : '',
});
const pages = (pro) => {
  const tabs = {
    now: P.nowPanel(nowModel(pro)),
    agents: P.agentsPanel(agentsModel(pro)),
    kit: P.kitPanel(kitModel(pro)),
  };
  if (pro) {
    tabs.history = P.historyPanel({ rows: M.historyRows(read().scopes), harnesses: ['Claude Code', 'Cursor'], canDelete: true,
      summary: M.connectionsSummary({ totals: { sessions: 11, read: 7, saved: 11, readNoSave: 0 } }) });
    tabs.budget = P.budgetPanel({ notices: [BUDGET_FAIL], layers: [{ layer: 'Brief', tokens: '≈4.9k', tokenCount: 4900, size: '19 KB', bytes: 19500, share: '0.5%' }] });
    tabs.computers = P.computersPanel({ rows: M.computerRows(demo()), routes: M.TRAVEL_ROUTES, repo: null, pending: 2, syncConfigured: true });
  }
  return tabs;
};
const whole = (pro, tab) => P.renderProjectsPage({ pro, tab, kicker: 'Work / my-app', title: 'my-app', sentence: 'Claude Code saved a note 27 min ago on this Mac.',
  counts: { agents: 4, history: 3, computers: 2 }, panelHtml: pages(pro)[tab] || '', tilesHtml: pro ? '<div data-tiles></div>' : '' });

section('§4 the layouts — Simple and Pro from one model');
{
  const simple = whole(false, 'now');
  const pro = whole(true, 'now');
  const tabIds = (h) => [...h.matchAll(/data-kit-tab="([a-z]+)"/g)].map((x) => x[1]);
  ok(JSON.stringify(tabIds(simple)) === JSON.stringify(['now', 'agents', 'kit']), 'Simple draws Now · Agents · Starting kit', tabIds(simple));
  ok(JSON.stringify(tabIds(pro)) === JSON.stringify(['now', 'agents', 'kit', 'history', 'budget', 'computers']), 'Pro adds History · Budget · Computers', tabIds(pro));
  ok(words(simple).includes(P.MORE_IN_PRO_LINE) && !words(pro).includes('More in Pro'), 'the ONE quiet "More in Pro" line, in Simple only');
  ok((simple.match(/More in Pro/g) || []).length === 1, 'exactly one "More in Pro" line on the Simple page');
  ok(/data-tiles/.test(pro) && !/data-tiles/.test(simple), 'the tile strip is Pro\'s; Simple has the one status sentence');
  ok(/<h1 class="kit-op-title">my-app<\/h1>/.test(simple), 'the title is the project\'s own name (no "Project context")');
  ok(/id="prj-connect"[^>]*>\+ Connect an agent</.test(simple) && /id="prj-connect"/.test(pro), 'the primary action is Connect an agent, in both modes');
  for (const [mode, tabs] of [['Simple', pages(false)], ['Pro', pages(true)]]) {
    const all = Object.values(tabs).join('');
    ok(!/data-detail="pro"|data-pro-mark|data-pro-drawn|>PRO</.test(all), mode + ': no per-block PRO marking anywhere (D5)');
    ok(!/<details/.test(all), mode + ': no fold on the page\'s own tabs (data is open; explanation is the ⓘ)');
    ok(!/\b(?:step|Step) [1-5]\b|settings-block-num/.test(all.replace(/class="prj-step[^"]*"/g, '')), mode + ': no numbered steps 1–5');
    ok(!/\bscopes?\b/i.test(words(all)), mode + ': the word "scope" is gone', (words(all).match(/.{30}\bscopes?\b.{30}/i) || [''])[0]);
  }
  ok(/kit-table/.test(pages(true).agents) && !/kit-table/.test(pages(false).agents), 'Agents: rows in Simple, the check table in Pro');
  ok(words(pages(true).budget).includes('The reading budget was not changed.') && words(pages(false).kit).includes('The reading budget was not changed.'),
    'CONTROL: the fixture really carries a never-hide outcome on Pro\'s Budget tab AND on Simple\'s Starting kit');
  ok(!/self-test/i.test(Object.values(pages(false)).join('')), 'Simple says nothing of "self-test calls excluded"');
  ok(!/class="[^"]*\bmono\b/.test(Object.values(pages(false)).join('')), 'Simple draws no monospace meter table');
}

section('§5 NEVER-HIDE over the whole page, tab by tab (D1)');
{
  const faults = pageParityFaults({ simpleTabs: pages(false), proTabs: pages(true), proOnly: [...P.PRO_ONLY_TABS] });
  ok(faults.length === 0, 'every warning, refusal and outcome Pro shows is on a Simple tab; no Pro-only tab holds one', faults.join('\n'));
  // The guard sees a Pro-only warning (dumb cross-check of the helper itself).
  const planted = { ...pages(true), history: pages(true).history + '<div class="kit-notice kit-notice-error" role="alert"><p class="kit-notice-title">Only in History</p></div>' };
  const caught = pageParityFaults({ simpleTabs: pages(false), proTabs: planted, proOnly: [...P.PRO_ONLY_TABS] });
  ok(caught.some((f) => /Pro-only tab "history" holds a never-hide item/.test(f)), 'a notice planted in a Pro-only tab is caught', caught.join('\n'));
  const drawn = pageParityFaults({ simpleTabs: { ...pages(false), budget: '' }, proTabs: {}, proOnly: ['budget'] });
  ok(drawn.length === 1, 'a Pro-only tab drawn in Simple is caught', drawn);
  ok(JSON.stringify(P.PRO_ONLY_TABS) === JSON.stringify(['history', 'budget', 'computers']), 'the Pro-only tabs are History, Budget, Computers');
}

section('§6 THE KIT GUARD — the page\'s own classes are layout only');
{
  const dir = join(ROOT, 'src/public/next/views/projects');
  const files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f));
  ok(files.includes('page.js') && files.includes('model.js') && files.includes('projects.css'), 'the three modules exist', files);
  const FORBIDDEN = /^prj-[a-z0-9-]*(row|chip|pill|badge|tag|note|notice|warn|alert|table|cell|th|td|fold|summary|details|status|dot)(-|$)/;
  const own = new Set();
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/\bprj-[a-z0-9-]+/g)) own.add(m[0]);
  }
  const bad = [...own].filter((c) => FORBIDDEN.test(c));
  ok(bad.length === 0, 'no prj- class names a row, chip, notice, table, fold or status (' + own.size + ' classes checked)', bad.join(', '));
  // page.js may draw only: the kit's classes (from the kit's own calls), the
  // buttons, its own prj- layout set, visually-hidden.
  const page = readFileSync(join(dir, 'page.js'), 'utf8');
  const literalClasses = [...page.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split("'")[0].split(/\s+/))
    .filter((c) => /^[a-z][a-z0-9-]*$/.test(c));
  const allowed = (c) => /^prj-/.test(c) || /^btn(-|$)/.test(c) || c === 'visually-hidden' || c === 'is-done' || c === 'is-current';
  const stray = [...new Set(literalClasses.filter((c) => !allowed(c)))];
  ok(stray.length === 0, 'page.js writes no class outside its layout set and the buttons (kit parts come from the kit\'s calls)', stray.join(', '));
  ok(!/\bmem-[a-z]/.test(page.replace(/'mem-ws-active'|mem-setup-tool-/g, '')), 'page.js draws no mem-* class (the old page\'s)');
  const css = readFileSync(join(dir, 'projects.css'), 'utf8');
  ok(!/(^|[\s,}])\.(?:kit|mem)-/m.test(css), 'projects.css restyles no kit- or mem- class');
  // The rendered page, both modes: every class is kit / prj / button / listbox / known shared.
  const rendered = Object.values(pages(true)).join('') + Object.values(pages(false)).join('') + whole(true, 'now') + whole(false, 'now');
  // xp-: the explainer's own panel (shared/explainer.js), opened by "How this works".
  const KNOWN = /^(kit-|prj-|btn|visually-hidden$|is-|tx-|xp$|xp-|cur-sb-dot$|cur-ov|lb|kit$)/;
  const classes = [...new Set([...rendered.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))];
  const odd = classes.filter((c) => !KNOWN.test(c));
  ok(odd.length === 0, 'the rendered page uses only kit, prj- layout, button and listbox classes (' + classes.length + ' checked)', odd.join(', '));
  ok(P.EMBEDDED_FLOWS.length > 0 && P.EMBEDDED_FLOWS.every((k) => /Html$/.test(k)), 'the embedded flows (today\'s editors, reused) are a named, closed list');
}

section('§7 the connect checklist — the only numbers on the page');
{
  const none = M.connectChecklist({ harnessRows: [], setup: { tools: [] } });
  ok(none.length === 4 && none[0].done && !none[1].done && !none[2].done && !none[3].done, 'a new project: created ✓, the other three to do');
  ok(none[1].action && none[1].action.attrs['data-prj-act'] === 'connect', 'step 2 offers Connect (the one flow)');
  ok(none[2].action && none[2].action.attrs['data-setup-act'] === 'copy-block', 'step 3 offers the one paste (Copy agent instructions)');
  ok(/save where we are/.test(none[3].title), 'step 4 says what to say to the agent', none[3].title);
  const data = demo();
  const after = M.connectChecklist({ harnessRows: M.harnessRows(data), setup: data });
  ok(after[1].done && after[2].done && !after[1].action, 'with an agent connected and told, steps 2 and 3 are done');
  const html = P.nowPanel({ hasSave: false, notices: [], checklist: none });
  ok((html.match(/class="prj-step-num"/g) || []).length === 4 && /<ol class="prj-steps"/.test(html), 'rendered as one numbered list');
  ok(!/Where the work stands/.test(html), 'until the first save, the checklist stands where the note will be');
}

section('§8 the Starting kit\'s words, History, the Agents matrix, Computers');
{
  ok(M.documentsMeta({ count: 9, readFirstCount: 2, hiddenCount: 0 }) === '9 documents · 2 always read, 7 when needed', 'Documents: "9 documents · 2 always read, 7 when needed"');
  ok(M.documentsMeta({ count: 3, readFirstCount: 1, hiddenCount: 1 }) === '3 documents · 1 always read, 1 when needed, 1 hidden', 'the read-first vocabulary on screen: Always read / When needed / Hidden');
  ok(JSON.stringify(M.START_WORDS) === JSON.stringify({ 'read-first': 'Always read', 'on-request': 'When needed', 'not-at-start': 'Hidden' }), 'the on-disk values map to the three words');
  ok(M.briefMeta({ present: true, words: 3038 }) === 'Your standing instructions for every agent · 3,038 words', 'Brief: its words, counted with the figure formatter');
  const f = M.kitBudgetFigure(25900, 1000000);
  ok(f.words === 'The starting kit uses 3% of your agent’s memory' && f.qualifier === 'plenty of room left', 'the one bar: "uses 3%… plenty of room left"', JSON.stringify(f));
  ok(M.kitBudgetFigure(500, 1000000).words.includes('less than 1%'), 'a sliver is "less than 1%", never "0%"');
  ok(M.kitBudgetFigure(null, 1000) === null, 'no measurement, no bar (nothing invented)');
  const h = M.historyRows(read().scopes);
  ok(h.length === 3 && h.every((r) => /^note:/.test(r.id)), 'History: one row per saved note, each opening its handoff');
  ok(M.filterHistory(h, 'payment', '').length === 1 && M.filterHistory(h, '', 'Cursor').length === 1, 'search and the harness filter narrow it');
  const mx = M.agentMatrix(demo(), { machineWord: 'Mac', savesByTool: { tools: [{ id: 'claude-code', events: 78 }] } });
  const cc = mx.filter((r) => r.tool === 'claude-code');
  ok(cc.length === 2 && cc[0].computer === 'this Mac' && cc[1].computer === 'studio-mac', 'the matrix: Claude Code on this Mac AND on studio-mac (it saved there)', cc.map((r) => r.computer));
  ok(cc[1].connected === 'unknown' && cc[1].skills === 'unknown' && cc[1].kind === 'unknown', 'another computer\'s checks are "unknown" — never guessed');
  ok(cc[0].saves7 === 78 && cc[0].connected === 'configured', 'this computer\'s row carries the checks and the 7-day saves');
  ok(M.agentMatrixPerHarness(mx).length === 4, 'Per harness: one row per harness');
  ok(M.computerRows(demo()).length === 2 && /this computer/.test(M.computerRows(demo())[0].name), 'Computers: one row per physical computer, this one marked');
  ok(/get_project_context/.test(M.continuePrompt('work', 'my-app')) && /"my-app"/.test(M.continuePrompt('work', 'my-app')), 'the "continue" prompt names the project and the tool to load it');
  ok(M.buttonSpecs('<button type="button" class="btn" data-setup-act="sync" data-x="a&amp;b">Sync now</button><a href="/z">no</a>')[0].attrs['data-x'] === 'a&b', 'button specs keep a fix\'s own data attributes, decoded once');
}

section('§9 every to-fix line is a notice in BOTH modes, with its own fix');
{
  const data = demo();
  const n = M.toFixNotices(data);
  ok(n.length === data.toFix.length, 'one notice per to-fix line', n.length);
  ok(n[0].title.startsWith('Antigravity’s my-curator skill is older') && n[0].tool === 'antigravity', 'a harness\'s line is titled in its own words');
  ok(n[0].actions.some((a) => a.attrs['data-setup-act'] === 'tool-open' && a.attrs['data-tool'] === 'antigravity'), 'a harness\'s line opens that harness\'s steps');
  ok(n[1].actions[0].label === 'Sync now' && n[1].actions[0].attrs['data-setup-act'] === 'sync', 'the newer-on-GitHub line offers Sync now');
  ok(n.every((x) => x.actions.length <= 2), 'at most two actions each (the notice cap)');
  for (const pro of [false, true]) {
    const html = P.agentsPanel(agentsModel(pro));
    ok(data.toFix.every((f) => M.noticeTitle(M.plainText(f.text)).every((part) => !part || words(html).includes(part))), (pro ? 'Pro' : 'Simple') + ': every to-fix line is on the Agents tab, in full (title and line)');
    ok(/2 files are only on this computer\./.test(words(html)), (pro ? 'Pro' : 'Simple') + ': "2 files are only on this computer" with Sync now');
  }
}

section('§10 behaviours carried over from the retired five-step pins');
{
  // The note is ON THE PAGE now (ANALYSIS §A1 #5 reverses v3.56.0's "off the page").
  const html = P.nowPanel({ hasSave: true, notices: [], earlier: [],
    handoff: { title: 'Checkout flow', bodyHtml: '<p>UNIQUE-BODY-MARKER</p>', footer: 'Claude Code · this Mac · 27 min ago' } });
  ok(html.includes('UNIQUE-BODY-MARKER') && /class="prj-handoff-title">Checkout flow</.test(html), 'the latest handoff\'s body and title are printed on the Now tab');
  ok(/Saved · Claude Code · this Mac · 27 min ago/.test(words(html)), 'its footer says who, where and when, "Saved" as words');
  ok(/data-prj-act="copy-continue"/.test(html) && /data-prj-act="open-note"/.test(html), 'Copy "continue" prompt and Open the full note are on the card');
  // A trimmed save is LOSS; a replacement is not — the label discriminates (old §7b).
  const tr = M.nowNotices({ lastSaveKind: 'trimmed' })[0];
  const rp = M.nowNotices({ lastSaveKind: 'replaced' })[0];
  const cl = M.nowNotices({ lastSaveKind: 'clipped' })[0];
  ok(tr.tone === 'error' && /did not survive/.test(tr.title), 'a trimmed save is said as loss, in the error tone');
  ok(rp.tone === 'info' && /Nothing the agent sent was lost/.test(rp.line) && !/did not survive/.test(rp.title), 'a replacement is said as a replacement, not as loss');
  ok(cl.tone === 'info' && /Nothing in the handoff was lost/.test(cl.line), 'a clipped label is said as clipped, nothing lost');
  // The stale-write offer (old §14): an agent SAVED; what is shown MAY not be latest; Reload offers.
  const st = M.nowNotices({ staleWrite: true })[0];
  ok(/saved/.test(st.title) && /may not be the latest/.test(st.line) && !/is stale/.test(st.line) && st.actions[0].label === 'Reload', 'the stale offer: an agent saved, "may not be the latest", Reload');
  // An unaddressable entry echoes the STORE's reason verbatim (old §14).
  ok(M.nowNotices({ unlisted: { reason: 'STORE-REASON-VERBATIM' } })[0].line === 'STORE-REASON-VERBATIM', 'the unlisted notice echoes the store\'s own reason');
  // History: absent is not zero; the harness by its label (old §17 P2, §31 F10).
  const h = M.historyRows([{ scope: 'x', machine: 'm', harness: 'claude-code', harnessLabel: 'Claude Code', writtenAt: iso(60e3) },
    { scope: 'y', machine: 'm', harness: 'claude-code', writtenAt: iso(120e3) }]);
  ok(h[0].bytes === null && /<td[^>]*>—<\/td>|>—</.test(P.historyPanel({ rows: h, harnesses: [] })), 'a note with no size says "—", never 0');
  ok(h[0].harness === 'Claude Code' && h[1].harness === 'claude-code', 'History names the harness by its label; an older server\'s raw name is kept, not guessed');
  // Agent connections: no usage log → "not logged", never "0".
  ok(/^not logged/.test(M.connectionsSummary({ logPresent: false, totals: { sessions: 0 } })), 'no usage log on this computer → "not logged", not "0 agent connections"');
  ok(/^11 agent connections/.test(M.connectionsSummary({ logPresent: true, totals: { sessions: 11, read: 7, saved: 11, readNoSave: 0 } })), 'CONTROL: a log → the counts');
  const cn = M.connectionNotice({ data: { logPresent: true, noSessionsButSaves: true } });
  ok(cn && cn.tone === 'attention' && cn.title.split(/\s+/).length <= 12 && /Restart the app/.test(cn.line), 'saves arrived but no connection was logged → a notice that names the fix');
  ok(M.connectionNotice({ logPresent: true, noSessionsButSaves: false }) === null && M.connectionNotice(null) === null, 'nothing to explain → no notice');
  for (const pro of [false, true]) {
    const html2 = P.agentsPanel({ ...agentsModel(pro), notices: [...M.toFixNotices(demo()), cn] });
    ok(words(html2).includes(cn.title), (pro ? 'Pro' : 'Simple') + ': the no-connection notice is on the Agents tab');
  }
  // Pro tiles: a figure not read yet is "…", one with no log "not logged" — never 0.
  const t0 = M.projectTiles({});
  ok(t0.find((c) => c.label === 'Agents').value === '…' && t0.find((c) => c.label === 'Saves').value === '…' && t0.find((c) => c.label === 'Last save').value === 'none yet',
    'Pro tiles before their reads: "…", never 0');
  // The loading panel invents no reading (old skeleton rule).
  ok(/aria-busy="true"/.test(P.loadingPanel()) && !/\d/.test(words(P.loadingPanel())), 'until the read lands the tab says it is reading, with no figure');
  // Edit on the Brief row opens TODAY's editor in the tab, in Simple (every task finishes in Simple).
  const k = P.kitPanel({ ...kitModel(false), open: 'brief', briefEditorHtml: '<textarea id="mem-brief-text"></textarea>' });
  ok(/data-prj-flow="briefEditorHtml"[^>]*><textarea id="mem-brief-text"/.test(k), 'Simple: Edit on Brief opens the brief editor on the Starting kit tab');
  ok(!/mem-brief-text/.test(P.kitPanel({ ...kitModel(false), briefEditorHtml: '<textarea id="mem-brief-text"></textarea>' })), '...and only when asked');
  ok(!/data-prj-act="brief-edit"/.test(P.kitPanel({ ...kitModel(false), readonly: true })), 'a read-only mirror is offered no Edit/Add actions');
}

section('§11 ESCAPING — hostile project, harness, headline and document names');
{
  const HOSTILES = ['<script>alert(1)</script>', 'x" onmouseover="alert(1)', "y' onfocus='alert(1)", '[[Wiki Link]] & <b>bold</b>'];
  for (const H of HOSTILES) {
    const data = demo();
    data.tools[0].label = H;           // a harness name
    const rd = read();
    rd.scopes[0].headline = H;         // a handoff headline
    rd.scopes[0].harnessLabel = H;
    rd.scopes[1].headline = H;
    const rows = M.harnessRows(data);
    const sentence = M.statusSentence({ read: rd, harnessRows: rows, thisNames: M.thisComputerNames(data), machineWord: 'Mac' });
    const html = [
      P.renderProjectsPage({ pro: true, tab: 'now', kicker: H + ' / ' + H, title: H, sentence, counts: {}, panelHtml: '' }),
      P.nowPanel({ hasSave: true, notices: [], handoff: { title: H, bodyHtml: '', footer: H, deleteScope: H },
        earlier: M.earlierNotes(rd.scopes, rd.scopes[0], {}) }),
      P.agentsPanel({ pro: false, state: 'ok', rows, notices: [] }),
      P.agentsPanel({ pro: true, state: 'ok', rows, notices: [], matrix: { rows: M.agentMatrix(data, { machineWord: 'Mac' }), view: 'computer' } }),
      P.historyPanel({ rows: M.historyRows(rd.scopes), harnesses: [H], canDelete: true }),
      P.documentsTable([{ slug: H, title: H, source: 'this computer', startWord: 'Always read', tokens: '1', tokenCount: 1, updated: 'now' }]),
      P.connectFlowHtml({ step: 'pick', harnesses: [{ id: H, label: H, meta: H, kind: 'off' }] }),
      P.connectFlowHtml({ step: 'computer', chosen: { id: H, label: H } }),
    ].join('\n');
    const label = JSON.stringify(H).slice(0, 40);
    ok(!/<script/i.test(html), label + ': no <script> element reaches the page');
    const attrNames = [];
    (function walk(n) { if (n.attrs) attrNames.push(...Object.keys(n.attrs)); (n.children || []).forEach(walk); })(parseHtml(html));
    ok(!attrNames.some((a) => /^on/.test(a)) && !attrNames.some((a) => /alert|^\(1\)/.test(a)),
      label + ': a quote cannot break out of an attribute (no element gains an on* attribute)', attrNames.filter((a) => /^on|alert/.test(a)).join(','));
    ok(!/<b>bold<\/b>/.test(html), label + ': markup in a name is text, not markup');
    ok(!/<a\b[^>]*>[^<]*Wiki Link/.test(html), label + ': "[[…]]" in a name stays literal (no link is made)');
    const text = textOf(parseHtml(html));
    ok(text.includes(H), label + ': ...and the name reads back exactly as typed (escaped once, not mangled)');
  }
  ok(M.continuePrompt('d', 'a"b').includes('"a"b"'), 'the copied "continue" prompt is plain text (it goes to the clipboard, not the page)');
}

console.log('\n' + (fail ? '✗' : '✓') + ' test-projects-page: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
