#!/usr/bin/env node
/**
 * test-next-mcp-install.js — v3.85.0, re-cut v3.89.0. Settings › MCP bridge ›
 * ① "Agent apps": the REAL DOM-free builders in views/mcp-install.js (drawn
 * with the section kit since v3.89.0), fed payloads of GET
 * /api/mcp/install/status, POST …/plan, …/apply and …/check-entry.
 * Exists to stop:
 *   §1 a wrong word or tick: one word per status; only needs-update and
 *      not-installed are ticked, only where the app may write; Windows writes
 *      Claude Desktop only; Linux is copy-only;
 *   §2 a preview that hides what will be written: the exact entry text, the
 *      other servers' NAMES, the dated backup — and nothing until Apply;
 *   §3 an outcome behind a chevron: result lines with restart guidance, the
 *      refusal reason, Check again;
 *   §4 a copy line that does not say where the entry goes;
 *   §5 the health line and Check entry saying more than was observed;
 *   §6 unescaped path / app / server names; any network call from a render.
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
const row = (html, id) => (html.match(new RegExp('<details class="cur-fold" data-fold-key="app-' + id + '"[\\s\\S]*?</details>')) || [''])[0];

section('§1 words and ticks');
{
  const st = status(SAMPLE);
  const ms = models(st);
  ok(ms.map((m) => m.status).join(',') === 'connected,needs-update,not-installed,manual', 'one status per app, as the payload says');
  ok(M.STATUS_WORDS.connected === 'connected' && M.STATUS_WORDS['needs-update'] === 'needs an update' && M.STATUS_WORDS.manual === 'not connected', 'the words');
  ok(M.tickedIds(st.data.tools, {}, 'darwin').join(',') === 'cursor,antigravity', 'needs-update and can-be-added are ticked by default — connected and copy-only never');
  ok(M.tickedIds(st.data.tools, { cursor: false }, 'darwin').join(',') === 'antigravity', 'the person’s untick wins');
  const html = M.renderAgentApps({ status: st, ticks: {} });
  ok(/data-mcpi-tick="cursor" checked/.test(html) && /data-mcpi-tick="antigravity" checked/.test(html) && !/data-mcpi-tick="claude-desktop"/.test(html) && !/data-mcpi-tick="cline"/.test(html),
    'the ticks live in the Next step card, one per installable app');
  const next = (html.match(/<div class="cur-action" id="mcpi-next-step"[\s\S]*?<\/div><div class="cur-folds"/) || [''])[0];
  ok(/data-mcpi-warn="entry" data-mcpi-reason="launch_file_missing">Cursor: Its entry points at \/old\/mcp\/server\.js, which is no longer on this Mac\. Install for me rewrites it\./.test(next),
    'v3.88.1’s launch_file_missing reason is said in the Next step card, UNFOLDED, with the fix');
  ok(/NEXT STEP · 1 TO FIX/.test(next) && /<button type="button" class="btn btn-primary btn-xs cur-action-chip" id="mcpi-install-btn" data-mcpi-act="install"><span class="cur-action-label">Install for me<\/span><span class="cur-action-cost">2 apps · previewed first<\/span>/.test(next),
    'Install for me is the card’s primary chip, its consequence in the cost slot');
  ok(/data-mcpi-hint="cursor">Quit and reopen Cursor/.test(next), 'a ticked, running app gets its restart hint before anything is written');
  ok(/class="cur-action-footnote"><p class="tx-desc">Install for me writes only the my-curator entry, after a preview, and keeps a copy of the file first\./.test(next),
    'the safety promise is the card’s footnote, its last line');
  const cdRow = row(html, 'claude-desktop');
  ok(/<span class="cur-fold-label">Claude Desktop<\/span><span class="cur-fold-meta">connected · running · <span data-age-at=/.test(cdRow) || /connected · <span data-age-at=/.test(cdRow),
    'a connected row reads "connected · used …" in its meta (the age ticks)');
  ok(/<span class="cur-fold-pill">1 to fix<\/span>/.test(row(html, 'cursor')), 'the to-fix row carries the "1 to fix" pill');
  ok(/data-fold-key="app-cursor"[^>]*>/.test(html) && !/data-fold-key="app-cursor"[^>]* open/.test(html), 'rows are CLOSED by default');
  // Windows: only Claude Desktop is installable; the others read "not connected".
  const win = status(SAMPLE.map((t) => (t.id === 'claude-desktop' ? { ...t, status: 'not-installed' } : t)), { platform: 'win32' });
  ok(M.tickedIds(win.data.tools, {}, 'win32').join(',') === 'claude-desktop', 'Windows: only Claude Desktop can be ticked');
  const wh = M.renderAgentApps({ status: win, ticks: {} });
  ok(/data-mcpi-windows>On Windows, one-click install covers Claude Desktop only/.test(wh) && /data-mcpi-new-windows>New on Windows — tell us if it works/.test(wh),
    'Windows: the one-app line and the "New on Windows" label, in the card');
  ok(/data-mcpi-tool="antigravity" data-mcpi-status="manual"/.test(wh) && /on this PC/.test(M.notFoundFoldRow(win.data)) , 'other apps are copy-only on Windows; "this PC"');
  const running = status([tool({ id: 'claude-desktop', label: 'Claude Desktop', running: { checked: true, running: true } })], { platform: 'win32' });
  ok(new RegExp('data-mcpi-app-running>' + M.APP_RUNNING_WORDS.replace(/[().]/g, '\\$&')).test(M.renderAgentApps({ status: running })), 'Windows: Claude Desktop running is said before anyone clicks');
  const linux = status(SAMPLE.map((t) => ({ ...t, status: 'manual' })), { platform: 'linux', writable: false, install: { disabledText: 'Copy-only on this computer' } });
  const lh = M.renderAgentApps({ status: linux });
  ok(/id="mcpi-install-btn" data-mcpi-act="install" disabled>[^]*copy-only on this computer/.test(lh) && /data-mcpi-nonmac>One-click install works on a Mac in this version on Linux/.test(lh),
    'Linux: Install for me disabled, never hidden, and the copy-only line');
  const all = status([SAMPLE[0]], { notFound: [] });
  ok(/cur-status-line[^]*Every agent app The Curator can install into on this Mac is connected/.test(M.renderAgentApps({ status: all })), 'nothing to fix or add: the one-line status card');
}

section('§2 the preview');
{
  const plan = { action: 'install', items: [
    { id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', action: 'update', basis: 'abc', entryText: '{\n  "command": "/x"\n}', preserved: ['github', 'linear'],
      backupWillBe: '~/.cursor/mcp.json.curator-backup-<UTC time of apply>' },
    { id: 'antigravity', label: 'Antigravity', file: '~/.gemini/config/mcp_config.json', refused: { message: 'It changed.' } }] };
  const h = M.renderPlanCard(plan, SAMPLE, null);
  ok(/PLAN READY · NOTHING WRITTEN YET/.test(h), 'it says nothing is written yet');
  ok(/<pre class="mono cur-action-entry" data-mcpi-entry>\{\n  &quot;command&quot;: &quot;\/x&quot;\n\}<\/pre>/.test(h), 'the EXACT entry text');
  ok(/Your 2 other servers stay unchanged: github, linear\./.test(h), 'the other servers by NAME');
  ok(/data-mcpi-backup><span class="mono cur-fold-item-main">~\/\.cursor\/mcp\.json\.curator-backup-…<\/span>/.test(h) && !/UTC time of apply/.test(h), 'the dated backup, never the raw placeholder');
  ok(/data-mcpi-plan-refused[^]*Antigravity — not changed: It changed\./.test(h), 'a refused item says why');
  ok(/data-mcpi-quit|is running — it needs a restart/.test(h), 'a running app is told it needs a restart');
  ok(/data-mcpi-act="apply"><span class="cur-action-label">Apply<\/span><span class="cur-action-cost">1 file<\/span>/.test(h) && /data-mcpi-act="cancel"/.test(h), 'Apply (one file) · Cancel');
  const r = M.renderPlanCard({ action: 'restore', items: [{ id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', restoreFromAt: '2026-10-31T09:58:00Z', restoreFrom: '~/.cursor/mcp.json.curator-backup-x', backupWillBe: '~/.cursor/mcp.json.curator-backup-<UTC time of apply>' }] }, SAMPLE, null);
  ok(/data-mcpi-restore-from>Puts back the copy kept on 31 Oct, \d\d:58/.test(r) && /data-mcpi-act="apply"><span class="cur-action-label">Restore/.test(r), 'restore: which copy goes back, and a Restore button');
  ok(/disabled/.test(M.renderPlanCard({ action: 'install', items: [plan.items[1]] }, SAMPLE, null).match(/data-mcpi-act="apply"[^>]*>/)[0]), 'nothing doable: Apply disabled');
}

section('§3 results, never folded');
{
  const res = { action: 'install', planItems: [{ id: 'cursor', file: '~/.cursor/mcp.json', action: 'update' }], items: [
    { id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', outcome: 'written', backup: '~/b', restart: 'Quit and reopen Cursor' },
    { id: 'antigravity', label: 'Antigravity', file: '~/.gemini/config/mcp_config.json', outcome: 'refused', message: 'It changed after the plan.' }] };
  const h = M.renderResults(res, SAMPLE, 'darwin');
  ok(/data-mcpi-result="written"[^]*Cursor — updated · original kept · quit and reopen Cursor/.test(h), 'a per-file line: what happened, the original kept, the restart step');
  ok(/data-mcpi-result="refused"[^]*Antigravity — not changed: It changed after the plan\. Nothing was written to this file\./.test(h), 'a refusal says why and that nothing was written');
  ok(/data-mcpi-restart>Cursor is running — restart it to load My Curator\./.test(h), 'the restart line names the running app');
  ok(/data-mcpi-act="check-again"/.test(h) && /data-mcpi-act="dismiss"/.test(h), 'Check again · Dismiss');
  const win = M.renderResults({ action: 'install', items: [{ id: 'claude-desktop', label: 'Claude Desktop', file: 'x', outcome: 'written' }] }, [], 'win32');
  ok(new RegExp('data-mcpi-restart-windows>' + M.WINDOWS_RESTART_LINE.replace(/[().]/g, '\\$&')).test(win), 'Windows: the system-tray Quit line');
}

section('§4 copy lines');
{
  const st = status(SAMPLE);
  const p = M.copyPlanFor('cursor', status([tool()]).data, {});
  ok(p && p.line === 'Save as ~/.cursor/mcp.json' && p.whole === true, 'a missing file: the whole small document, "Save as <file>"');
  const st2 = status([tool({ files: [{ display: '~/.cursor/mcp.json', state: 'no-entry' }] })]);
  const p2 = M.copyPlanFor('cursor', st2.data, {});
  ok(p2 && p2.line === 'Paste into ~/.cursor/mcp.json inside "mcpServers"' && /^"my-curator": \{/.test(p2.text), 'an existing JSON file: only our entry, "Paste into <file> inside "mcpServers""');
  const h = M.renderAgentApps({ status: st2, folds: { 'app-cursor': true } });
  ok(/data-mcpi-copyline><span class="mono cur-fold-item-main">~\/\.cursor\/mcp\.json<\/span><span class="cur-fold-item-meta">paste it inside &quot;mcpServers&quot;<\/span><button[^>]*data-mcpi-act="copy" data-tool="cursor">Copy entry/.test(h),
    'the row’s copy line: the file (mono), where it goes, Copy entry — no mono inside a sentence');
  ok(/Goose — add this to/i.test(M.notFoundFoldRow(st.data)) || /Goose/.test(M.notFoundFoldRow(st.data)), '"Not on this Mac": one copy line per app');
  ok(/<span class="cur-fold-label">Not on this Mac<\/span><span class="cur-fold-pill">1<\/span>/.test(M.notFoundFoldRow(st.data)), '…a fold row with a count');
}

section('§5 the health line and Check entry');
{
  const now = Date.now();
  const st = status(SAMPLE);
  const [cd] = models(st);
  ok(M.healthWords(cd, now) === 'Claude Desktop last started it 2 days ago', 'a start after the entry was written: "<App> last started it <age>"');
  const stale = models(status([{ ...SAMPLE[0], lastStartedAt: iso(9 * 86400e3), entryWrittenAt: iso(3600e3) }]))[0];
  ok(M.healthWords(stale, now) === 'Claude Desktop hasn’t started My Curator since the entry was written 1 hr ago', 'no start since our write: "hasn’t started My Curator since …"');
  const never = models(status([{ ...SAMPLE[0], lastStartedAt: null, entryWrittenAt: iso(60e3) }]))[0];
  ok(/hasn’t started My Curator since the entry was written/.test(M.healthWords(never, now)), '…including when no start was ever logged');
  ok(M.healthWords(models(status([SAMPLE[2]]))[0], now) === '', 'an app with no entry gets no health line');
  const h = M.renderAgentApps({ status: st, folds: { 'app-claude-desktop': true } });
  ok(/data-mcpi-health>[^]*last started it 2 days ago[^]*data-mcpi-act="check-entry" data-tool="claude-desktop">Check entry/.test(row(h, 'claude-desktop')), 'Check entry sits on the health line');
  ok(!/check-entry/.test(row(h, 'antigravity')), 'only where the server can check (`checkEntry` from the status)');
  const starts = M.checkStatusHtml('Claude Desktop', { result: { results: [{ file: '~/a.json', ran: true, starts: true, toolCount: 24 }] } });
  ok(/data-mcpi-check="starts"[^]*Claude Desktop’s entry starts · 24 tools[^]*Started exactly as Claude Desktop starts it, from ~\/a\.json\./.test(starts), '"starts · 24 tools"');
  const fails = M.checkStatusHtml('Cursor', { result: { results: [{ file: '~/c.json', ran: true, starts: false, message: 'It stopped before it answered (exit code 1). It said: Error: Cannot find module' }] } });
  ok(/tx-status-danger[^>]*data-mcpi-check="fails"[^]*Cursor’s entry does not start[^]*Cannot find module/.test(fails), 'a failure: danger, with the stderr reason in plain words');
  const refused = M.checkStatusHtml('Cursor', { result: { results: [{ file: '~/c.json', ran: false, starts: false, code: 'not_allowed', message: 'Its entry starts /bin/sh, …' }] } });
  ok(/tx-status-attention[^>]*data-mcpi-check="refused"[^]*was not started/.test(refused), 'a refused entry: "was not started", never "does not start"');
  const busy = M.checkStatusHtml('Cursor', { busy: true });
  ok(/data-mcpi-check="busy"[^]*Starting Cursor’s entry…/.test(busy), 'while it runs, said');
}

section('§6 escaping, and no network from a render');
{
  const evil = '<img src=x onerror=alert(1)>';
  const st = status([tool({ id: 'claude-desktop', label: evil, status: 'connected', checkEntry: true, files: [{ display: '~/' + evil, state: 'connected' }] })], { notFound: [{ id: 'goose', label: evil }] });
  const h = M.renderAgentApps({ status: st, folds: { 'app-claude-desktop': true, 'mcpi-notfound': true }, checks: { 'claude-desktop': { error: evil } } })
    + M.renderPlanCard({ action: 'install', items: [{ id: 'x', label: evil, file: evil, entryText: evil, preserved: [evil] }] }, [], null)
    + M.renderResults({ action: 'install', items: [{ id: 'x', label: evil, file: evil, outcome: 'refused', message: evil }] }, [], 'darwin');
  ok(!/<img/.test(h) && /&lt;img/.test(h), 'every app, path, server name and message is escaped');
  ok(netCalls === 0, 'no render made a network call');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
