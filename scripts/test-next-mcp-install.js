#!/usr/bin/env node
/**
 * test-next-mcp-install.js — v3.85.0, re-cut v3.89.0, re-worded v3.90.0 (the
 * copy deck). Settings › MCP bridge › ① "Your AI apps": the REAL DOM-free
 * builders in views/mcp-install.js, fed payloads of GET
 * /api/mcp/install/status, POST …/plan, …/apply and …/check-entry.
 * Exists to stop:
 *   §1 a wrong word or tick: one word per status; only needs-update and
 *      not-installed are ticked, only where the app may write; Windows writes
 *      Claude Desktop only; Linux is copy-only;
 *   §2 a preview that hides what will be written: the exact entry text, the
 *      other servers' NAMES, the dated backup — and nothing until Apply;
 *   §3 an outcome behind a chevron: result lines with restart guidance, the
 *      refusal reason, Check again;
 *   §4 a copy line that does not say where the setup text goes;
 *   §5 the default view and Test connection saying more than was observed;
 *   §6 Details listing a file that does not exist (other than the one Install
 *      for me would create); Remove not drawn as the danger button;
 *   §7 unescaped path / app / server names; any network call from a render.
 * OFFLINE.
 */
let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

let netCalls = 0;
globalThis.fetch = () => { netCalls++; return Promise.reject(new Error('network used')); };
const M = await import('../src/public/next/views/mcp-install.js');

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const tool = (o) => ({ id: 'cursor', label: 'Cursor', status: 'not-installed', installer: 'file', running: { checked: true, running: false },
  files: [{ file: '/Users/ann/.cursor/mcp.json', display: '~/.cursor/mcp.json', action: 'add', state: 'missing' }], reason: null, note: null,
  usedAt: null, restartHint: 'Quit and reopen Cursor', ...o });
const status = (tools, extra = {}) => ({ data: { platform: 'darwin', writable: true, tools, notFound: [{ id: 'goose', label: 'Goose' }],
  manualSnippets: { goose: 'name: goose', cursor: '{"mcpServers":{"my-curator":{"command":"/x"}}}', cline: '{"mcpServers":{"my-curator":{"command":"/x"}}}' }, ...extra },
error: null, loading: false });
const SAMPLE = [
  tool({ id: 'claude-desktop', label: 'Claude Desktop', status: 'connected', usedAt: iso(2 * 86400e3), checkEntry: true, restorable: true,
    lastStartedAt: iso(2 * 86400e3), entryWrittenAt: iso(5 * 86400e3),
    files: [{ file: '/Users/ann/Library/Application Support/Claude/claude_desktop_config.json', display: '~/Library/Application Support/Claude/claude_desktop_config.json', state: 'connected' }] }),
  tool({ id: 'cursor', status: 'needs-update', running: { checked: true, running: true },
    reason: { code: 'launch_file_missing', message: 'Its entry points at /old/mcp/server.js, which is no longer on this Mac.' },
    files: [{ file: '/Users/ann/.cursor/mcp.json', display: '~/.cursor/mcp.json', action: 'update', state: 'differs' }] }),
  tool({ id: 'antigravity', label: 'Antigravity', files: [{ file: '/Users/ann/.gemini/config/mcp_config.json', display: '~/.gemini/config/mcp_config.json', action: 'add', state: 'no-entry' }] }),
  tool({ id: 'cline', label: 'Cline', status: 'manual', installer: 'cli', files: [], reason: { code: 'installer_cli', message: 'x' } }),
];
const models = (st, ctx = {}) => M.appRowModels(st, ctx);
const row = (html, id) => {
  // One app's fold, up to the next APP fold (its nested Details stays inside).
  const at = html.indexOf('data-fold-key="app-' + id + '"');
  if (at < 0) return '';
  const re = /data-fold-key="(app-(?!details-)[\w-]+|mcpi-notfound)"/g;
  re.lastIndex = at + 5;
  const m = re.exec(html);
  return html.slice(at, m ? m.index : html.length);
};

section('§1 words and ticks');
{
  const st = status(SAMPLE);
  const ms = models(st);
  ok(ms.map((m) => m.status).join(',') === 'connected,needs-update,not-installed,manual', 'one status per app, as the payload says');
  ok(ms.map((m) => M.APP_STATE_WORDS[M.appStateKey(m)]).join(',') === 'connected,needs attention,not connected,not connected',
    'the deck’s four state words: connected · needs attention · not connected · can’t read its settings');
  ok(M.APP_STATE_WORDS['cant-read'] === 'can’t read its settings', '…the fourth');
  ok(M.tickedIds(st.data.tools, {}, 'darwin').join(',') === 'cursor,antigravity', 'needs-update and can-be-added are ticked by default — connected and copy-only never');
  ok(M.tickedIds(st.data.tools, { cursor: false }, 'darwin').join(',') === 'antigravity', 'the person’s untick wins');
  const html = M.renderAgentApps({ status: st, ticks: {} });
  ok(/data-mcpi-tick="cursor" checked/.test(html) && /data-mcpi-tick="antigravity" checked/.test(html) && !/data-mcpi-tick="claude-desktop"/.test(html) && !/data-mcpi-tick="cline"/.test(html),
    'the ticks live in the Next step card, one per installable app');
  const next = (html.match(/<div class="cur-action" id="mcpi-next-step"[\s\S]*?<\/div><\/div><div class="cur-folds"/) || [''])[0];
  ok(/data-mcpi-item="out-of-date" data-tool="cursor"><p class="cur-fold-line-text"><strong>Cursor’s connection is out of date — it points at \/old\/mcp\/server\.js, which is no longer on this Mac\.<\/strong>/.test(next),
    'v3.88.1’s launch_file_missing reason, in the deck’s words, UNFOLDED in Next step');
  ok(/<strong>Antigravity isn’t connected yet\.<\/strong>/.test(next), 'an app that can be added: "{App} isn’t connected yet."');
  ok(/Next step · 2 to do/.test(next) && /<button type="button" class="btn btn-primary btn-xs cur-action-chip" id="mcpi-install-btn" data-mcpi-act="install"><span class="cur-action-label">Install for me<\/span><\/button>/.test(next)
    && /data-mcpi-act="copy-myself" data-tool="cursor"><span class="cur-action-label">Copy the setup text<\/span>/.test(next),
    'Install for me (primary) and Copy the setup text, after the items');
  ok(/class="cur-action-footnote"><p class="tx-desc">Install for me changes only The Curator’s own line in each app’s settings file\. It shows you the change first and keeps a backup\.<\/p>/.test(next),
    'the safety line is the card’s footnote, its last line');
  const cdRow = row(html, 'claude-desktop');
  ok(/<span class="cur-fold-label">Claude Desktop<\/span><span class="cur-fold-meta">connected<\/span>/.test(cdRow), 'a connected row reads "connected"');
  ok(/<span class="cur-fold-meta">needs attention<\/span>/.test(row(html, 'cursor')), 'the to-fix row reads "needs attention"');
  ok(/data-fold-key="app-cursor"[^>]*>/.test(html) && !/data-fold-key="app-cursor"[^>]* open/.test(html), 'rows are CLOSED by default');
  // Windows: only Claude Desktop is installable; the others read "not connected".
  const win = status(SAMPLE.map((t) => (t.id === 'claude-desktop' ? { ...t, status: 'not-installed' } : t)), { platform: 'win32' });
  ok(M.tickedIds(win.data.tools, {}, 'win32').join(',') === 'claude-desktop', 'Windows: only Claude Desktop can be ticked');
  const wh = M.renderAgentApps({ status: win, ticks: {} });
  ok(/data-mcpi-new-windows>New on Windows — tell us if it works/.test(wh), 'Windows: the "New on Windows" label, in the card');
  ok(/data-mcpi-tool="antigravity" data-mcpi-status="manual"/.test(wh) && /on this PC/.test(M.notFoundFoldRow(win.data)), 'other apps are copy-only on Windows; "this PC"');
  const running = status([tool({ id: 'claude-desktop', label: 'Claude Desktop', running: { checked: true, running: true } })], { platform: 'win32' });
  ok(new RegExp('data-mcpi-app-running>' + M.APP_RUNNING_WORDS.replace(/[().]/g, '\\$&')).test(M.renderAgentApps({ status: running })), 'Windows: Claude Desktop running is said before anyone clicks');
  const linux = status(SAMPLE.map((t) => ({ ...t, status: 'manual' })), { platform: 'linux', writable: false });
  const lh = M.renderAgentApps({ status: linux });
  ok(!/id="mcpi-next-step"/.test(lh) && /Cursor can’t be set up automatically yet\. Copy the setup text and paste it into/.test(lh),
    'Linux (copy-only): no Install card; each app says to copy its setup text');
  const all = status([SAMPLE[0]], { notFound: [] });
  ok(/cur-status-line[^]*<strong>Everything is connected\.<\/strong>/.test(M.renderAgentApps({ status: all })), 'nothing to do: "Everything is connected."');
  const allButCopy = status([SAMPLE[0], SAMPLE[3]], { notFound: [] });
  ok(!/Everything is connected/.test(M.renderAgentApps({ status: allButCopy })), '…never when a copy-only app is still not connected');
}

section('§2 the preview — "Check the change · nothing written yet"');
{
  const plan = { action: 'install', items: [
    { id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', action: 'update', basis: 'abc', entryText: '{\n  "command": "/x"\n}', preserved: ['github', 'linear'],
      backupWillBe: '~/.cursor/mcp.json.curator-backup-<UTC time of apply>' },
    { id: 'antigravity', label: 'Antigravity', file: '~/.gemini/config/mcp_config.json', refused: { message: 'It changed.' } }] };
  const h = M.renderPlanCard(plan, SAMPLE, null);
  ok(/Check the change · nothing written yet/.test(h), 'it says nothing is written yet');
  ok(/<span class="cur-fold-item-meta"><strong>Cursor<\/strong> —<\/span><span class="mono cur-fold-item-main">~\/\.cursor\/mcp\.json<\/span>/.test(h), '"{App} — {path}"');
  ok(/<p>Adds:<\/p><pre class="mono cur-action-entry" data-mcpi-entry>\{\n  &quot;command&quot;: &quot;\/x&quot;\n\}<\/pre>/.test(h), '"Adds:" then the EXACT setup text');
  ok(/Your other connections stay as they are: github, linear\./.test(h), 'the other connections by NAME');
  ok(/data-mcpi-backup>Backup: mcp\.json\.curator-backup-…<\/p>/.test(h) && !/UTC time of apply/.test(h), '"Backup: {file name}", never the raw placeholder');
  ok(/data-mcpi-plan-refused[^]*✗ <strong>Antigravity<\/strong> was not changed: it changed\./.test(h), 'a refused item says why');
  ok(/data-mcpi-act="apply"><span class="cur-action-label">Apply<\/span>/.test(h) && /data-mcpi-act="cancel"/.test(h), 'Apply · Cancel');
  const r = M.renderPlanCard({ action: 'restore', items: [{ id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', restoreFromAt: '2026-10-31T09:58:00Z', backupWillBe: '~/.cursor/mcp.json.curator-backup-<UTC time of apply>' }] }, SAMPLE, null);
  ok(/data-mcpi-restore-from>Put back the original settings file/.test(r), 'restore: "Put back the original settings file"');
  ok(/disabled/.test(M.renderPlanCard({ action: 'install', items: [plan.items[1]] }, SAMPLE, null).match(/data-mcpi-act="apply"[^>]*>/)[0]), 'nothing doable: Apply disabled');
}

section('§3 results, never folded');
{
  const res = { action: 'install', items: [
    { id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', outcome: 'written', backup: '~/b' },
    { id: 'antigravity', label: 'Antigravity', file: '~/.gemini/config/mcp_config.json', outcome: 'refused', message: 'It changed after the plan.' }] };
  const h = M.renderResults(res, SAMPLE, 'darwin');
  ok(/data-mcpi-result="ok"[^]*✓ <strong>Cursor<\/strong> is set up\. <strong>Quit Cursor completely and open it again<\/strong> to use My Curator\. \(⌘Q — closing the window is not enough\)/.test(h),
    'a per-file line: set up, and how to quit it on a Mac');
  ok(/data-mcpi-result="refused"[^]*✗ <strong>Antigravity<\/strong> was not changed: it changed after the plan\.[^]*data-mcpi-act="copy" data-tool="antigravity">Copy the setup text/.test(h),
    'a refusal says why, with Copy the setup text');
  ok(/data-mcpi-act="check-again"/.test(h), 'then Check again');
  const win = M.renderResults({ action: 'install', items: [{ id: 'claude-desktop', label: 'Claude Desktop', file: 'x', outcome: 'written' }] }, [], 'win32');
  ok(/\(right-click its icon by the clock → Quit\)/.test(win), 'Windows: right-click its icon by the clock → Quit');
}

section('§4 copy lines');
{
  const st = status(SAMPLE);
  const p = M.copyPlanFor('cursor', status([tool()]).data, {});
  ok(p && p.line === 'Save as ~/.cursor/mcp.json' && p.whole === true, 'a missing file: the whole small document, "Save as <file>"');
  const st2 = status([tool({ files: [{ display: '~/.cursor/mcp.json', state: 'no-entry' }] })]);
  const p2 = M.copyPlanFor('cursor', st2.data, {});
  ok(p2 && p2.line === 'Paste into ~/.cursor/mcp.json inside "mcpServers"' && /^"my-curator": \{/.test(p2.text), 'an existing JSON file: only our line, "Paste into <file> inside "mcpServers""');
  const cline = row(M.renderAgentApps({ status: status([tool({ id: 'cline', label: 'Cline', status: 'manual', installer: 'cli', files: [{ display: '~/.cline/x.json', state: 'no-entry' }], reason: { code: 'installer_cli', message: 'x' } })]) }), 'cline');
  ok(/Cline can’t be set up automatically yet\. Copy the setup text and paste it into ~\/\.cline\/x\.json, inside &quot;mcpServers&quot;\.[^]*data-mcpi-act="copy" data-tool="cline">Copy the setup text/.test(cline),
    'a copy-only app: the deck’s sentence with its file and key, and one button');
  ok(/<span class="cur-fold-label">Not on this Mac \(1\)<\/span>/.test(M.notFoundFoldRow(st.data)) && /Goose\. If you install one of these, press Check again\./.test(M.notFoundFoldRow(st.data)),
    '"Not on this Mac (n)": the names on one line');
}

section('§5 the default view and Test connection');
{
  const st = status(SAMPLE);
  const h = M.renderAgentApps({ status: st, folds: { 'app-claude-desktop': true } });
  ok(/Connected\. Claude Desktop last used My Curator <span data-age-at=[^>]*>2 days ago<\/span>\.[^]*data-mcpi-act="check-entry" data-tool="claude-desktop">Test connection/.test(row(h, 'claude-desktop')),
    'connected and used: "Connected. {App} last used My Curator {age}." [Test connection]');
  const fresh = status([{ ...SAMPLE[0], lastStartedAt: iso(9 * 86400e3), entryWrittenAt: iso(3600e3) }]);
  ok(/Connected\. Claude Desktop hasn’t used My Curator since it was set up <span data-age-at=[^>]*>1 hr ago<\/span> — quit and reopen Claude Desktop if it doesn’t show up\./.test(M.renderAgentApps({ status: fresh })),
    'not used since we set it up: the deck’s sentence with the age');
  ok(!/check-entry/.test(row(h, 'antigravity')), 'Test connection only where the server can test (`checkEntry`)');
  const r = (c) => M.testResultWords('Claude Desktop', c, 'darwin');
  ok(r({ result: { results: [{ file: '~/a.json', ran: true, starts: true, toolCount: 24 }] } }).text === 'Works — My Curator starts the way Claude Desktop starts it and answers with all 24 tools.',
    'a test that starts: "Works — …"');
  ok(/^Doesn’t start: it stopped before it answered/.test(r({ result: { results: [{ ran: true, starts: false, message: 'It stopped before it answered (exit code 1).' }] } }).text),
    'a test that fails: "Doesn’t start: {reason}."');
  ok(r({ result: { results: [{ ran: false, starts: false, code: 'not_allowed', message: 'x' }] } }).text
    === 'The Curator only tests its own setup line; this one points at something else, so it was not run.', 'a refused test: the deck’s refusal sentence');
  ok(r({ result: { results: [{ ran: false, starts: false, code: 'launch_file_missing', path: '/old/launch' }] } }).text
    === 'Doesn’t start: it points at /old/launch, which is no longer on this Mac.', 'a missing file: named');
  const tested = M.renderAgentApps({ status: st, checks: { 'claude-desktop': { result: { results: [{ ran: true, starts: true, toolCount: 24 }] } } } });
  ok(/Connected\. Works — My Curator starts the way Claude Desktop starts it/.test(row(tested, 'claude-desktop')), 'the result replaces the sentence’s second half');
}

section('§6 Details: only files that exist, plus the one Install for me would create');
{
  const st = status(SAMPLE);
  const machine = M.adaptMachine({ data: { harnesses: [{ id: 'antigravity', label: 'Antigravity',
    files: [{ file: '/Users/ann/.gemini/config/mcp_config.json', display: '~/.gemini/config/mcp_config.json', present: true, named: false, status: 'ok' },
      { file: '/Users/ann/.gemini/antigravity/mcp_config.json', display: '~/.gemini/antigravity/mcp_config.json', present: false, status: 'missing' }],
    hooks: { format: 'json', files: [{ file: '/Users/ann/w/.agents/hooks.json', present: true, ours: true }] }, skills: {} }] } });
  const h = M.renderAgentApps({ status: st, machine, folds: { 'app-antigravity': true, 'app-details-antigravity': true, 'app-cursor': true, 'app-details-cursor': true } });
  const ag = row(h, 'antigravity');
  ok(/~\/\.gemini\/config\/mcp_config\.json<\/span><span class="cur-fold-item-meta">no Curator line<\/span>/.test(ag) && !/antigravity\/mcp_config\.json/.test(ag),
    'an existing file is listed with its state; a missing alternate is hidden');
  ok(/Automatic saves: on\. When on, Antigravity saves a handoff by itself when a session ends\./.test(ag), 'automatic saves, in words');
  const cu = row(h, 'cursor');
  ok(/~\/\.cursor\/mcp\.json<\/span><span class="cur-fold-item-meta">has The Curator’s line/.test(cu) || /not there yet/.test(cu) || /no Curator line/.test(cu), 'Cursor’s own file is listed');
  const add = M.renderAgentApps({ status: status([tool({ id: 'cursor' })]), folds: { 'app-cursor': true, 'app-details-cursor': true } });
  ok(/~\/\.cursor\/mcp\.json<\/span><span class="cur-fold-item-meta">not there yet<\/span>/.test(add), 'the file Install for me would create: "not there yet"');
  const cd = row(M.renderAgentApps({ status: st, folds: { 'app-claude-desktop': true, 'app-details-claude-desktop': true } }), 'claude-desktop');
  ok(/Remove The Curator from Claude Desktop<\/p><span class="cur-fold-line-acts"><button type="button" class="btn btn-danger btn-xs" data-mcpi-act="remove" data-tool="claude-desktop">Remove<\/button>/.test(cd),
    'Remove is the danger button');
  ok(/Put back the original settings file<\/p><span class="cur-fold-line-acts"><button type="button" class="btn btn-secondary btn-xs" data-mcpi-act="restore"/.test(cd), 'Restore original, only when a backup exists');
  ok(/data-fold-key="app-details-claude-desktop" open[^>]*>[^]*<span class="cur-fold-label">Details<\/span>/.test(cd) && !/data-fold-key="app-details-antigravity" open/.test(M.renderAgentApps({ status: st })),
    'Details is a nested fold, closed by default');
}

section('§7 escaping, and no network from a render');
{
  const evil = '<img src=x onerror=alert(1)>';
  const st = status([tool({ id: 'claude-desktop', label: evil, status: 'connected', checkEntry: true, files: [{ display: '~/' + evil, state: 'connected' }] })], { notFound: [{ id: 'goose', label: evil }] });
  const h = M.renderAgentApps({ status: st, folds: { 'app-claude-desktop': true, 'mcpi-notfound': true, 'app-details-claude-desktop': true }, checks: { 'claude-desktop': { error: evil } } })
    + M.renderPlanCard({ action: 'install', items: [{ id: 'x', label: evil, file: evil, entryText: evil, preserved: [evil] }] }, [], null)
    + M.renderResults({ action: 'install', items: [{ id: 'x', label: evil, file: evil, outcome: 'refused', message: evil }] }, [], 'darwin');
  ok(!/<img/.test(h) && /&lt;img/.test(h), 'every app, path, connection name and message is escaped');
  ok(netCalls === 0, 'no render made a network call');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
