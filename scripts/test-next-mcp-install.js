#!/usr/bin/env node
/**
 * test-next-mcp-install.js — v3.85.0. Settings › MCP bridge › 5 "Tools on this
 * Mac" › "My Curator in your tools", through the REAL DOM-free builders
 * (views/mcp-install.js), fed payloads of GET /api/mcp/install/status,
 * POST …/plan and POST …/apply (CONTRACT-v3.85.0 §4).
 *
 * Exists to stop:
 *   §1 a wrong word or tick: one word per status, only needs-update and
 *      not-installed ticked, no checkbox where the app cannot write;
 *   §2 colour on a status tag (colour is a domain's);
 *   §3 a preview that hides what will be written: the exact entry text, the
 *      other servers' NAMES, the backup path;
 *   §4 an outcome behind a chevron: result lines, the refusal reason, the
 *      restart line;
 *   §5 unescaped path / tool / server names;
 *   §6 a request fired by rendering (no builder touches the network);
 *   §7 the non-macOS state offering a write, and the "Install for me" link
 *      on a Setup bridge line only for the three tools that can be written.
 */
let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

// §6: any network call during a render is a failure.
let netCalls = 0;
globalThis.fetch = () => { netCalls++; return Promise.reject(new Error('network used')); };

const M = await import('../src/public/next/views/mcp-install.js');
const S = await import('../src/public/next/views/setup-step.js');

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const tool = (o) => ({
  id: 'cursor', label: 'Cursor', status: 'not-installed', installer: 'file',
  detected: { by: 'app', path: '/Applications/Cursor.app' },
  running: { checked: true, running: false },
  files: [{ display: '~/.cursor/mcp.json', action: 'add', state: 'absent' }],
  reason: null, note: null, usedAt: null, restartHint: 'Quit and reopen Cursor', ...o,
});
const status = (tools, extra = {}) => ({
  data: {
    platform: 'darwin', writable: true, launch: { style: 'repo', command: 'node', argsCount: 2 },
    tools, notFound: [{ id: 'goose', label: 'Goose' }],
    manualSnippets: { goose: 'name: goose-snippet', cursor: '{"cursor":1}', opencode: '{"mcp":{}}' },
    ...extra,
  },
  error: null, loading: false,
});
const SAMPLE = [
  tool({ id: 'claude-desktop', label: 'Claude Desktop', status: 'connected', files: [{ display: '~/Library/Application Support/Claude/claude_desktop_config.json', action: 'none', state: 'ok' }], usedAt: iso(2 * 86400000) }),
  tool({ id: 'cursor', status: 'needs-update', files: [{ display: '~/.cursor/mcp.json', action: 'update', state: 'stale' }], running: { checked: true, running: true } }),
  tool({ id: 'antigravity', label: 'Antigravity', status: 'not-installed', files: [{ display: '~/.gemini/config/mcp_config.json', action: 'add', state: 'absent' }] }),
  tool({ id: 'windsurf', label: 'Windsurf', status: 'cant-read', reason: 'The file has comments, which this app will not rewrite.', files: [{ display: '~/.codeium/windsurf/mcp_config.json', action: 'none', state: 'jsonc' }] }),
  tool({ id: 'opencode', label: 'opencode', status: 'manual', installer: 'cli', reason: 'One-click install comes in a later version.', files: [{ display: '~/.config/opencode/opencode.json', action: 'none', state: 'ok' }] }),
];

// ── §1 words, counts, ticks ────────────────────────────────────────────────
section('§1 statuses, counts, default ticks');
ok(M.STATUS_WORDS.connected === 'connected' && M.STATUS_WORDS['needs-update'] === 'needs an update'
  && M.STATUS_WORDS['not-installed'] === 'can be added' && M.STATUS_WORDS['cant-read'] === 'can’t read'
  && M.STATUS_WORDS.manual === 'copy only', 'one word per status');
ok(JSON.stringify(Object.keys(M.STATUS_WORDS)) === JSON.stringify(['connected', 'needs-update', 'not-installed', 'cant-read', 'manual']), 'exactly the five contract statuses');
const c = M.countStatuses(SAMPLE);
ok(c.connected === 1 && c.needsUpdate === 1 && c.canAdd === 1 && c.cantRead === 1 && c.manual === 1, 'counts per status', JSON.stringify(c));
ok(M.overviewLine([...SAMPLE.slice(0, 3)]) === 'My Curator in your tools — 1 connected · 1 needs an update · 1 can be added', 'overview line', M.overviewLine(SAMPLE.slice(0, 3)));
ok(M.overviewLine([]) === 'My Curator in your tools — no tool found on this Mac', 'overview line with no tools');
const t = M.defaultTicks(SAMPLE);
ok(t.cursor === true && t.antigravity === true, 'needs-update and not-installed start ticked');
ok(!('claude-desktop' in t) && !('windsurf' in t) && !('opencode' in t), 'connected / cant-read / manual rows have no tick');
ok(M.defaultTicks(SAMPLE, { cursor: false }).cursor === false, 'a person’s own un-tick wins');
ok(M.defaultTicks([tool({ id: 'x', status: 'not-installed', installer: 'cli' })]).x === undefined, 'a cli row is never installable');
ok(JSON.stringify(M.tickedIds(SAMPLE)) === JSON.stringify(['cursor', 'antigravity']), 'tickedIds in payload order');
let b = M.installButtonState(status(SAMPLE), {}, null);
ok(b.n === 2 && b.label === 'Install for me (2 tools)' && !b.disabled, 'install button counts the ticks', JSON.stringify(b));
b = M.installButtonState(status(SAMPLE), { cursor: false, antigravity: false }, null);
ok(b.n === 0 && b.disabled, 'nothing ticked → Install disabled');
ok(M.installButtonState(status(SAMPLE, { writable: false }), {}, null).disabled, 'not writable → Install disabled');

// ── rows ───────────────────────────────────────────────────────────────────
section('§1 rows');
const st = status(SAMPLE);
const panel = M.renderInstallPanel({ status: st, ticks: {} });
const plain = (h) => h.replace(/<wbr>/g, '');
const rowOf = (id) => (panel.match(new RegExp('<div class="mcpi-row[^>]*data-mcpi-tool="' + id + '">[\\s\\S]*?(?=<div class="mcpi-row|</div></details>|</div>$)')) || [''])[0];
ok(/data-mcpi-tick="cursor" checked/.test(panel) && /data-mcpi-tick="antigravity" checked/.test(panel), 'cursor and antigravity rows carry a ticked checkbox');
ok(!/data-mcpi-tick="(claude-desktop|windsurf|opencode)"/.test(panel), 'no checkbox on connected / can’t-read / copy-only rows');
ok(/Remove/.test(rowOf('claude-desktop')) && /data-mcpi-act="remove"/.test(rowOf('claude-desktop')), 'connected row offers Remove');
ok(/used 2 days ago/.test(rowOf('claude-desktop')), 'connected row carries the used-age note', rowOf('claude-desktop'));
ok(/data-mcpi-running/.test(rowOf('cursor')) && !/data-mcpi-running/.test(rowOf('antigravity')), 'running tag only on the running tool');
ok(/~\/\.cursor\/mcp\.json/.test(plain(rowOf('cursor'))), 'row names the file it will write');
ok(/~\/<wbr>\.cursor\/<wbr>mcp\.json/.test(rowOf('cursor')), 'a path may wrap only after a slash (<wbr>)');
ok(/class="mcpi-l1"[\s\S]*data-mcpi-tick="cursor"[\s\S]*mcpi-st-needs-update[\s\S]*mcpi-acts[\s\S]*class="mcpi-files"/.test(rowOf('cursor')), 'two-line row: name, tag and actions on line 1, the path on line 2');
ok(/data-mcpi-reason/.test(rowOf('windsurf')) && /comments/.test(rowOf('windsurf')), 'can’t-read row shows its reason, open');
ok(/data-mcpi-act="copy"/.test(rowOf('opencode')) && !/data-mcpi-tick/.test(rowOf('opencode')) && /later version/.test(rowOf('opencode')), 'copy-only row: Copy, no checkbox, reason shown');
const withPaths = M.renderInstallPanel({ status: st, paths: { '~/.codeium/windsurf/mcp_config.json': '/Users/x/.codeium/windsurf/mcp_config.json' } });
ok(/data-mcpi-act="reveal" data-path="\/Users\/x\/\.codeium\/windsurf\/mcp_config\.json"/.test(withPaths), 'can’t-read row reveals the real file when its path is known');
ok(!/data-mcpi-act="reveal"/.test(panel), '…and offers no Reveal when it cannot name the file');
ok(/Restore original/.test(M.renderInstallPanel({ status: status([tool({ id: 'cursor', status: 'connected', restorable: true })]) })), 'a restorable tool offers Restore original');
ok(!/Restore original/.test(panel), 'no Restore original without a kept copy');
ok(/<details[^>]*data-setup-fold="mcpi-notfound"[^>]*>[\s\S]*Not found on this Mac \(1\)[\s\S]*Goose[\s\S]*data-mcpi-act="copy" data-tool="goose"/.test(panel), 'Not found fold: count, name and Copy per tool');
ok(/data-setup-fold="mcpi-notfound" open/.test(M.renderInstallPanel({ status: st, folds: { 'mcpi-notfound': true } })), 'fold open state is honoured');
ok(/Copy it myself/.test(panel) && /id="mcpi-install-btn"/.test(panel), 'both overview buttons present');
ok(/MY CURATOR IN YOUR TOOLS/.test(panel) && (panel.match(/cur-ov-card/g) || []).length === 3, 'one overview card with three readings');

// ── §2 greyscale ───────────────────────────────────────────────────────────
section('§2 status tags carry no colour class');
const tags = [...panel.matchAll(/<span class="(mcpi-st[^"]*)"/g)].map((m) => m[1]);
ok(tags.length >= 6, 'tags found on the sample', tags.length);
ok(tags.every((cl) => !/\b(ok|fix|err|danger|warn|success|attention|accent|id-\d|cur-setup-st-(ok|fix))\b/.test(cl)), 'no ok/fix/danger/identity class on any tag', tags.join(' | '));
ok(!/cur-setup-st-(ok|fix)/.test(panel) && !/cur-sb-dot/.test(panel), 'no coloured tag from the Setup kit and no identity dot');
ok(![...panel.matchAll(/style="([^"]*)"/g)].some((m) => /color|background/.test(m[1])), 'no inline colour anywhere in the panel (the overview kit’s track floor is the only style)');

// ── §3 preview ─────────────────────────────────────────────────────────────
section('§3 preview card');
const ENTRY = '{\n  "command": "node",\n  "args": ["/Users/x/app/mcp/server.js", "--domains", "/Users/x/Curator & <Co>"]\n}';
const plan = {
  action: 'install', token: 'tok',
  items: [
    { id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', action: 'update', entryText: ENTRY, preserved: ['github', 'sentry', 'a<b>'], backupWillBe: '~/.cursor/mcp.json.curator-backup-20261031T120000Z', basis: 'abc' },
    { id: 'antigravity', label: 'Antigravity', file: '~/.gemini/config/mcp_config.json', action: 'add', entryText: ENTRY, preserved: [], backupWillBe: null, basis: 'absent' },
    { id: 'windsurf', label: 'Windsurf', file: '~/w.json', action: 'none', refused: { reason: 'cant_read', message: 'This file has comments.' } },
  ],
};
const card = M.renderPlanCard(plan, SAMPLE, null);
ok(/Plan ready — nothing written yet/.test(card), 'titled “Plan ready — nothing written yet”');
ok(card.includes(M.preservedLine(['github', 'sentry', 'a<b>']).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')), 'lists the other servers by name');
ok(/Your 3 other servers stay unchanged: github, sentry, a&lt;b&gt;\./.test(card), 'the exact preserved sentence', card.match(/Your[^<]*/)?.[0]);
ok(M.preservedLine(['a']) === 'Your 1 other server stays unchanged: a.' && M.preservedLine([]) === 'No other servers are in this file.', 'preserved sentence: one / none');
ok(card.includes('data-mcpi-entry') && card.includes('&quot;command&quot;: &quot;node&quot;') && card.includes('Curator &amp; &lt;Co&gt;'), 'the exact entry text, escaped');
ok(/A new copy of the current file is kept beside it as <span class="mono">~\/\.cursor\/mcp\.json\.curator-backup-20261031T120000Z<\/span>/.test(card), 'names the backup file');
ok(/does not exist yet — it is created/.test(card), 'a new file says there is no original to keep');
ok(/Update in <span class="mono">~\/\.cursor\/mcp\.json/.test(card) && /Add to <span class="mono">~\/\.gemini/.test(card), 'update vs add wording per file');
ok(/This file has comments\./.test(card) && /Windsurf<\/strong> — not changed/.test(card), 'a refused item says why, open');
ok(/data-mcpi-act="apply"/.test(card) && /data-mcpi-act="cancel"/.test(card) && !/<details/.test(card), 'Apply and Cancel, no chevron');
ok(/Cursor is running — it needs a restart/.test(card), 'a running tool is told it needs a restart');
const cd = M.renderPlanCard({ action: 'install', token: 't', items: [{ id: 'claude-desktop', label: 'Claude Desktop', file: '~/c.json', action: 'update', entryText: '{}', preserved: [], backupWillBe: '~/c.bak', basis: 'x' }] },
  [tool({ id: 'claude-desktop', label: 'Claude Desktop', running: { checked: true, running: true } })], null);
ok(/data-mcpi-quit/.test(cd) && /Quit it first for the safest install/.test(cd), 'Claude Desktop running → “quit it first for the safest install”');
ok(!/data-mcpi-quit/.test(M.renderPlanCard(plan, SAMPLE, null)), '…and only for Claude Desktop');
ok(/disabled/.test(M.renderPlanCard({ action: 'install', token: 't', items: [plan.items[2]] }, SAMPLE, null).match(/data-mcpi-act="apply"[^>]*>/)[0]), 'Apply disabled when every item is refused');
ok(/Writing…/.test(M.renderPlanCard(plan, SAMPLE, 'apply')), 'busy label while applying');
const rm = M.renderPlanCard({ action: 'remove', token: 't', items: [{ id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', entryText: '{"command":"node"}', preserved: ['x'], backupWillBe: '~/b', basis: 'h' }] }, SAMPLE, null);
ok(/Remove from/.test(rm) && /This entry is removed/.test(rm) && />Remove</.test(rm), 'remove preview: names the entry removed');
const rs = M.renderPlanCard({ action: 'restore', token: 't', items: [{ id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', preserved: [], backupWillBe: '~/b2', basis: 'h', restoreFrom: 'claude_desktop_config.json.curator-backup-20261031T095800Z', restoreFromAt: '2026-10-31T09:58:00' }] }, SAMPLE, null);
ok(/Puts back the copy kept on 31 Oct, 09:58 \(claude_desktop_config\.json\.curator-backup-20261031T095800Z\)\./.test(rs), 'restore says which copy goes back and when it was kept', rs.match(/data-mcpi-restore-from[^<]*/)?.[0]);
ok(/Your current file is kept as a new copy first: <span class="mono">~\/b2/.test(rs), 'restore says the current file is kept as a new copy first');
ok(M.restoreWords({}) === 'Puts back the copy kept earlier.' && /Your current file is kept as a new copy first\./.test(M.renderPlanCard({ action: 'restore', token: 't', items: [{ id: 'cursor', label: 'C', file: '~/f', preserved: [], basis: 'h' }] }, SAMPLE, null)), 'restore falls back gracefully without the new fields');
ok(/Restore/.test(rs) && /Your current file is kept as a new copy first/.test(rs) && !/stay unchanged|No other servers/.test(rs), 'restore preview: the copy of the current file is kept, no server list');

// ── §4 results ─────────────────────────────────────────────────────────────
section('§4 results are never behind a chevron');
const res = {
  action: 'install', planItems: plan.items,
  items: [
    { id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', outcome: 'written', backup: '~/.cursor/mcp.json.curator-backup-1', restart: 'Quit and reopen Cursor' },
    { id: 'antigravity', label: 'Antigravity', file: '~/.gemini/config/mcp_config.json', outcome: 'created', backup: null, restart: 'Quit and reopen Antigravity' },
    { id: 'claude-desktop', label: 'Claude Desktop', file: '~/c.json', outcome: 'unchanged', message: 'Already up to date' },
    { id: 'windsurf', label: 'Windsurf', file: '~/w.json', outcome: 'refused', reason: 'config_changed', message: 'The file changed while you were looking at the plan.' },
  ],
};
const out = M.renderResults(res, SAMPLE);
const lines = [...out.matchAll(/data-mcpi-result="(\w+)"/g)].map((m) => m[1]);
ok(JSON.stringify(lines) === JSON.stringify(['written', 'created', 'unchanged', 'refused']), 'one line per result, in order', lines.join());
ok(/Cursor<\/strong> — updated in <span class="mono">~\/\.cursor\/mcp\.json<\/span> · original kept · quit and reopen Cursor/.test(out), 'written line: where, original kept, restart', out.match(/data-mcpi-result="written".*?<\/div>/)?.[0]);
ok(/created <span class="mono">~\/\.gemini[^<]*<\/span> with the My Curator entry · no original to keep/.test(out), 'created line');
ok(/already up to date in/.test(out) && !/Quit and reopen|quit and reopen Claude/.test(out.match(/data-mcpi-result="unchanged".*?<\/div>/)[0]), 'unchanged line, no restart');
ok(/not changed: The file changed while you were looking at the plan\./.test(out) && /Nothing was written to/.test(out), 'refused line carries the reason');
ok(/data-mcpi-restart>Cursor is running — restart it to load My Curator\./.test(out), 'one restart line names the running tool that changed', out.match(/data-mcpi-restart[^<]*/)?.[0]);
ok(/data-mcpi-act="check-again"/.test(out) && !/<details/.test(out), 'Check again present; no chevron anywhere in results');
ok(/added to/.test(M.renderResults({ action: 'install', items: [res.items[0]], planItems: [] }, [])), 'an add (no matching update item) reads “added to”');
ok(/removed from/.test(M.renderResults({ action: 'remove', items: [res.items[0]] }, [])) && /original put back in/.test(M.renderResults({ action: 'restore', items: [res.items[0]] }, [])), 'remove and restore wording');
ok(M.restartLine([res.items[2]], SAMPLE) === '', 'no restart line when nothing running changed');
ok(M.restartLine([{ id: 'cursor', label: 'Cursor', outcome: 'written' }, { id: 'claude-desktop', label: 'Claude Desktop', outcome: 'written' }], SAMPLE.map((x) => ({ ...x, running: { checked: true, running: true } })))
  === 'Cursor, Claude Desktop are running — restart them to load My Curator.', 'restart line for several tools');
const full = M.renderInstallPanel({ status: st, plan, results: res });
ok(full.indexOf('data-mcpi-plan') < full.indexOf('data-mcpi-results') && full.indexOf('data-mcpi-results') < full.indexOf('data-mcpi-tool="claude-desktop"'), 'order: plan, results, then the rows');

// ── §5 escaping ────────────────────────────────────────────────────────────
section('§5 escape-first');
const evil = '<img src=x onerror=alert(1)>';
const hostile = M.renderInstallPanel({
  status: status([tool({ id: 'cursor', label: evil, reason: evil, note: evil, files: [{ display: evil, action: 'add' }], status: 'cant-read' })], { notFound: [{ id: 'x"y', label: evil }], manualSnippets: { 'x"y': 'z' } }),
  plan: { action: 'install', items: [{ id: 'cursor', label: evil, file: evil, action: 'add', entryText: evil, preserved: [evil], backupWillBe: evil, basis: 'h' }] },
  results: { action: 'install', items: [{ id: 'cursor', label: evil, file: evil, outcome: 'written', backup: evil, restart: evil }] },
  error: evil, copied: evil, paths: { [evil]: evil },
});
ok(!hostile.includes('<img'), 'no raw tag from any field', hostile.match(/<img[^>]*>/)?.[0]);
ok(hostile.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the text is still shown, escaped');
ok(!/data-tool="x"y"/.test(hostile), 'a quote in an id cannot break an attribute');
ok(M.failureWords({ code: 'platform_unsupported' }).includes('Mac') && /Nothing was changed/.test(M.failureWords({ code: 'x', message: 'Boom.' })), 'failure sentences');

// ── §6 nothing fires by itself ─────────────────────────────────────────────
section('§6 rendering never asks the network');
ok(netCalls === 0, 'no fetch during any builder call', netCalls);
const calls = [];
globalThis.fetch = async (u, o) => { calls.push([u, o && o.method || 'GET', o && o.body]); return new Response(JSON.stringify({ tools: [], items: [], results: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
await M.fetchInstallStatus(); await M.requestPlan('install', ['cursor']); await M.requestApply('tok');
ok(JSON.stringify(calls.map((x) => x.slice(0, 2))) === JSON.stringify([['/api/mcp/install/status', 'GET'], ['/api/mcp/install/plan', 'POST'], ['/api/mcp/install/apply', 'POST']]), 'the three request functions hit the three contract routes', JSON.stringify(calls));
ok(calls[1][2] === '{"action":"install","ids":["cursor"]}' && calls[2][2] === '{"token":"tok"}', 'plan sends only action + ids; apply only the token', calls[1][2] + ' ' + calls[2][2]);
globalThis.fetch = async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
const stale = await M.requestPlan('install', ['cursor']);
ok(!stale.ok && stale.code === 'stale', 'an HTML answer (older server) is “stale”, never a plan');
globalThis.fetch = async () => new Response(JSON.stringify({ error: 'x', code: 'platform_unsupported' }), { status: 409, headers: { 'content-type': 'application/json' } });
const pu = await M.requestApply('t');
ok(!pu.ok && pu.code === 'platform_unsupported', 'a 409 keeps its code');
globalThis.fetch = async () => { throw new Error('offline'); };
ok((await M.fetchInstallStatus()).code === 'network', 'a network failure never throws');

// ── §7 non-macOS, the setup link ───────────────────────────────────────────
section('§7 non-macOS and the Setup link');
const lin = M.renderInstallPanel({ status: status(SAMPLE.map((x) => ({ ...x, status: x.status === 'connected' ? 'manual' : x.status === 'not-installed' || x.status === 'needs-update' ? 'manual' : x.status, installer: 'file' })), { platform: 'linux', writable: false }) });
ok(/data-mcpi-nonmac/.test(lin) && /on Linux/.test(lin) && /copy the entry for each tool/.test(lin), 'non-macOS: said open, copy instead');
ok(!/data-mcpi-tick/.test(lin) && !/data-mcpi-act="remove"/.test(lin) && !/data-mcpi-act="restore"/.test(lin), 'non-macOS: no checkbox, no Remove, no Restore');
ok(/id="mcpi-install-btn"[^>]*disabled/.test(lin), 'non-macOS: Install for me disabled');
ok(/data-mcpi-act="copy"/.test(lin), 'non-macOS: Copy is there');
ok(/aria-busy="true"/.test(M.renderInstallPanel({ status: null })) && /Could not check your tools: boom/.test(M.renderInstallPanel({ status: { data: null, error: 'boom' } })), 'loading and failed-to-load states');

const bridge = (tool) => S.fixButtons({ tool, fixes: [{ kind: 'copy-snippet', tool, label: 'Copy MCP entry' }] }, null);
ok(['claude-desktop', 'cursor', 'antigravity'].every((id) => /data-setup-act="settings">Install for me</.test(bridge(id))), 'Setup bridge line links to the installer for the three writable tools');
ok(!/Install for me/.test(bridge('opencode')) && !/Install for me/.test(bridge('claude-code')), '…and not for any other tool');
ok(!/Install for me/.test(S.fixButtons({ tool: 'cursor', fixes: [{ kind: 'copy-block' }] }, null)), '…and only on a line that already offers the entry');


// ── Copy: what goes on the clipboard, and the line that says what to do ───
section('§8 Copy it myself');
{
  const DOC = JSON.stringify({ mcpServers: { 'my-curator': { type: 'stdio', command: 'node', args: ['/x/server.js'] } } }, null, 2) + '\n';
  const data = { manualSnippets: { cursor: DOC, goose: 'extensions:\n  my-curator:\n    cmd: node\n', opencode: DOC },
    tools: [
      t_({ id: 'cursor', files: [{ display: '~/.cursor/mcp.json', state: 'missing' }] }),
      t_({ id: 'opencode', status: 'manual', files: [] }),
      t_({ id: 'goose', status: 'manual', files: [] }),
    ] };
  function t_(o) { return { installer: 'file', status: 'not-installed', files: [], ...o }; }
  const noFile = M.copyPlanFor('cursor', data, {});
  ok(noFile.whole === true && noFile.text === DOC && noFile.line === 'Save as ~/.cursor/mcp.json', 'a tool with NO file yet: the whole small document, “Save as <file>”', JSON.stringify(noFile));
  const has = M.copyPlanFor('cursor', { ...data, tools: [t_({ id: 'cursor', files: [{ display: '~/.cursor/mcp.json', state: 'no-entry' }] })] }, {});
  ok(has.whole === false && /^"my-curator": \{/.test(has.text) && !/mcpServers/.test(has.text) && has.line === 'Paste into ~/.cursor/mcp.json inside "mcpServers"', 'a file that exists: only the entry, “Paste into <file> inside "mcpServers"”', has.text + ' | ' + has.line);
  ok(JSON.parse('{' + has.text + '}')['my-curator'].command === 'node', 'the pasted entry is valid inside an object');
  const mf = M.copyPlanFor('opencode', data, { opencode: [{ display: '~/.config/opencode/opencode.json', present: true }] });
  ok(mf.whole === false && /inside "mcpServers"/.test(mf.line) && /~\/\.config\/opencode\/opencode\.json/.test(mf.line), 'a copy-only row names its file from the machine reading');
  const toml = M.copyPlanFor('goose', data, { goose: [{ display: '~/.config/goose/config.yaml', present: true }] });
  ok(toml.whole === true && toml.line === 'Add this to ~/.config/goose/config.yaml' && toml.text.startsWith('extensions:'), 'a non-JSON tool: the snippet as written, “Add this to <file>”');
  ok(M.copyPlanFor('cursor', { manualSnippets: {}, tools: [] }, {}) === null, 'no snippet, no Copy');
  const html = M.renderInstallPanel({ status: { data: { platform: 'darwin', writable: true, notFound: [], ...data, tools: [t_({ id: 'cursor', label: 'Cursor', files: [{ display: '~/.cursor/mcp.json', state: 'missing' }] })] } } });
  ok(/data-mcpi-copyline>Save as ~\/<wbr>\.cursor\/<wbr>mcp\.json</.test(html) && /data-mcpi-act="copy" data-tool="cursor"/.test(html), 'the line sits under the row, visible, beside a Copy button');
  const cr = M.renderInstallPanel({ status: { data: { platform: 'darwin', writable: true, notFound: [], ...data, tools: [t_({ id: 'cursor', label: 'Cursor', status: 'cant-read', reason: { code: 'corrupt', message: '~/.cursor/mcp.json is not valid JSON.' }, files: [{ display: '~/.cursor/mcp.json', file: '/Users/x/.cursor/mcp.json', state: 'cant-read' }] })] } } });
  ok(/data-mcpi-reason>~\/\.cursor\/mcp\.json is not valid JSON\./.test(cr) && /data-mcpi-act="reveal" data-path="\/Users\/x\/\.cursor\/mcp\.json"/.test(cr) && /data-mcpi-act="copy"/.test(cr), 'can’t-read: the reason (object form) in words, Reveal on the absolute path, and Copy');
  ok(!/\[object Object\]/.test(cr), 'a {code, message} reason never prints as [object Object]');
}
// A3 — backend restore fields
{
  const c = M.renderPlanCard({ action: 'restore', token: 't', items: [{ id: 'cursor', label: 'Cursor', file: '~/.cursor/mcp.json', preserved: [], basis: 'h', backupWillBe: '~/.cursor/mcp.json.curator-backup-<UTC time of apply>', restoreFrom: '~/.cursor/mcp.json.curator-backup-20261031T095800Z', restoreFromAt: '2026-10-31T09:58:00' }] }, [], null);
  ok(/Puts back the copy kept on 31 Oct, 09:58 \(~\/\.cursor\/mcp\.json\.curator-backup-20261031T095800Z\)/.test(c) && /new dated copy first/.test(c) && !/UTC time|&lt;/.test(c), 'restore: the source copy and when it was kept; the new copy said as “dated”, no placeholder');
}

{
  const P = '~/Library/Application Support/Claude/claude_desktop_config.json.curator-backup-<UTC time of apply>';
  const ins = M.renderPlanCard({ action: 'install', token: 't', items: [{ id: 'cursor', label: 'Cursor', file: '~/f.json', action: 'update', entryText: '{}', preserved: [], basis: 'h', backupWillBe: P }] }, [], null);
  ok(/A dated copy of the current file is kept beside it \(<span class="mono">[^<]*config\.json\.curator-backup-…<\/span>\)/.test(ins) && !/UTC time|&lt;|<UTC/.test(ins), 'a placeholder backup name reads “A dated copy … (…curator-backup-…)”, no angle brackets', ins.match(/data-mcpi-backup[^<]*<[^<]*/)?.[0]);
  const rst = M.renderPlanCard({ action: 'restore', token: 't', items: [{ id: 'cursor', label: 'Cursor', file: '~/f.json', preserved: [], basis: 'h', backupWillBe: P, restoreFrom: '~/old.bak', restoreFromAt: '2026-10-31T09:58:00' }] }, [], null);
  ok(/Your current file is kept as a new dated copy first\./.test(rst) && !/UTC time|&lt;/.test(rst), 'restore: “kept as a new dated copy first”, no placeholder');
  ok(M.STATUS_WORDS['not-installed'] === 'can be added' && /can be added<\/span>/.test(M.statusTag('not-installed')), 'a not-installed row’s tag uses the overview’s word');
}
const SM = await import('../src/public/next/views/setup-machine.js');
const foot = SM.renderToolsOnThisMacBody({ data: { harnesses: [], version: 'x' } }, {});
ok(/The checks only read\. Install for me writes only the my-curator entry, after a preview/.test(foot) && !/Nothing here writes a file/.test(foot), 'the block’s footer no longer says nothing is written');

// ── §9 Windows (v3.86.0) ───────────────────────────────────────────────────
section('§9 platform gating: darwin, win32, linux');
{
  const WIN = [
    tool({ id: 'claude-desktop', label: 'Claude Desktop', status: 'not-installed', files: [{ display: 'C:\\Users\\Ann Lee\\AppData\\Roaming\\Claude\\claude_desktop_config.json', action: 'add', state: 'absent' }], running: { checked: true, running: true } }),
    tool({ id: 'cursor', status: 'needs-update', files: [{ display: 'C:\\Users\\Ann Lee\\.cursor\\mcp.json', action: 'update', state: 'stale' }] }),
    tool({ id: 'antigravity', label: 'Antigravity', status: 'not-installed' }),
    tool({ id: 'windsurf', label: 'Windsurf', status: 'cant-read', reason: 'x', files: [{ display: 'C:\\w\\mcp_config.json', file: 'C:\\w\\mcp_config.json', state: 'jsonc' }] }),
  ];
  const wst = (tools = WIN, extra = {}) => status(tools, { platform: 'win32', writable: true, ...extra });
  const html = M.renderInstallPanel({ status: wst() });
  const row = (h, id) => (h.match(new RegExp('<div class="mcpi-row [^"]*" data-mcpi-tool="' + id + '">[\\s\\S]*?(?=<div class="mcpi-row |$)')) || [''])[0];
  ok(/data-mcpi-tick="claude-desktop"[^>]* checked/.test(html), 'win32: Claude Desktop is installable and ticked');
  ok(!/data-mcpi-tick="cursor"/.test(html) && !/data-mcpi-tick="antigravity"/.test(html), 'win32: every other row has no checkbox');
  ok(/data-mcpi-new-windows>New on Windows — tell us if it works</.test(row(html, 'claude-desktop')) && (html.match(/data-mcpi-new-windows/g) || []).length === 1, 'win32: the label sits on the Claude Desktop row only');
  ok(/data-mcpi-status="manual"/.test(row(html, 'cursor')) && !/data-mcpi-new-windows/.test(row(html, 'cursor')), 'win32: another tool reads "copy only" and keeps Copy', row(html, 'cursor'));
  ok(M.countStatuses(WIN, 'win32').canAdd === 1 && M.countStatuses(WIN, 'win32').needsUpdate === 0 && M.countStatuses(WIN, 'win32').manual === 2, 'win32: the counts follow what can be written', JSON.stringify(M.countStatuses(WIN, 'win32')));
  ok(M.overviewLine(WIN, 'win32') === 'My Curator in your tools — 1 can be added · 1 can’t be read · 2 copy only', 'win32: overview line', M.overviewLine(WIN, 'win32'));
  ok(M.installButtonState(wst(), {}, null).n === 1 && M.installButtonState(wst(), {}, null).label === 'Install for me', 'win32: Install for me counts one tool');
  ok(JSON.stringify(M.tickedIds(WIN, {}, 'win32')) === JSON.stringify(['claude-desktop']) && JSON.stringify(M.tickedIds(WIN, {})) === JSON.stringify(['claude-desktop', 'cursor', 'antigravity']), 'win32 gates ticks; no platform keeps today’s');
  ok(/data-mcpi-windows/.test(html), 'win32: said open that install covers Claude Desktop only');
  ok(!/data-mcpi-act="reveal"/.test(M.renderInstallPanel({ status: wst() })) && /data-mcpi-act="reveal"/.test(M.renderInstallPanel({ status: status([WIN[3]]) })) && !/data-mcpi-act="reveal"/.test(M.renderInstallPanel({ status: wst([WIN[3]]) })), 'Reveal is hidden on win32 (the reveal route is `open -R`, macOS only) and kept on darwin');
  ok(/C:\\<wbr>Users\\<wbr>Ann Lee\\<wbr>AppData\\<wbr>Roaming\\<wbr>Claude\\<wbr>claude_desktop_config\.json/.test(html), 'Windows paths wrap after each backslash', row(html, 'claude-desktop'));
  ok(/~\/<wbr>\.cursor\/<wbr>mcp\.json/.test(M.renderInstallPanel({ status: status(SAMPLE) })), 'POSIX paths still wrap after a slash');
  ok(!/<wbr>/.test(M.renderInstallPanel({ status: wst([tool({ id: 'cursor', files: [{ display: 'C:\\a<b>\\c' }] })]) }).replace(/\\<wbr>|&lt;|&gt;/g, '')) , 'a path is escaped before the break points are added');

  ok(!/data-mcpi-act="reveal"/.test(M.renderInstallPanel({ status: status([WIN[3]], { platform: 'linux', writable: false }) })), 'Reveal is hidden on linux too: it shows only on darwin');
  // reasons
  const nf = M.renderToolRow(tool({ id: 'claude-desktop', status: 'manual', reason: { code: 'config_not_found', message: 'backend text' }, files: [] }), { platform: 'win32', writable: true });
  ok(/data-mcpi-reason>Open Claude Desktop once, then press Check again</.test(nf), 'config_not_found in words', nf);
  const amb = M.renderToolRow(tool({ id: 'claude-desktop', status: 'manual', reason: { code: 'config_ambiguous', message: 'm', candidates: ['C:\\A\\c.json', 'C:\\B\\c.json'] }, files: [] }), { platform: 'win32', writable: true });
  ok(/more than one config file: C:\\<wbr>A|more than one config file: C:\\A/.test(amb.replace(/<wbr>/g, '')) && /C:\\B\\c\.json/.test(amb.replace(/<wbr>/g, '')), 'config_ambiguous names the candidates', amb);
  const amb2 = M.renderToolRow(tool({ id: 'claude-desktop', status: 'manual', reason: { code: 'config_ambiguous', message: 'm' }, files: [{ display: 'C:\\X\\c.json' }, { display: 'C:\\Y\\c.json' }] }), { platform: 'win32' });
  ok(/C:\\X\\c\.json · C:\\Y\\c\.json/.test(amb2.replace(/<wbr>/g, '')), 'config_ambiguous falls back to the row’s files');
  const amb3 = M.renderToolRow(tool({ id: 'claude-desktop', status: 'manual', reason: { code: 'config_ambiguous', message: 'm' }, files: [], candidates: [{ display: 'C:\\L\\c.json', live: true }, { display: 'C:\\R\\c.json', live: true }, { display: 'C:\\Dead\\c.json', live: false }] }), { platform: 'win32' });
  ok(/C:\\L\\c\.json · C:\\R\\c\.json/.test(amb3.replace(/<wbr>/g, '')) && !/Dead/.test(amb3), 'config_ambiguous names the backend’s LIVE row candidates (the v3.86.0 status shape), never a dead one', amb3);
  ok(/data-mcpi-reason>Some other message</.test(M.renderToolRow(tool({ status: 'manual', reason: { code: 'other', message: 'Some other message' } }), {})), 'any other reason is the backend’s message');

  // result line + Check again
  const res = { action: 'install', items: [{ id: 'claude-desktop', label: 'Claude Desktop', outcome: 'written', file: 'C:\\f.json', backup: 'b' }] };
  const wr = M.renderResults(res, WIN, 'win32');
  ok(/data-mcpi-restart-windows>Quit Claude Desktop fully \(system tray → Quit\), reopen it, then press Check again</.test(wr), 'win32: the restart line is shown, open');
  ok(/class="btn btn-primary btn-xs" data-mcpi-act="check-again"/.test(wr), 'win32: Check again is the primary button');
  ok(!/is running — restart/.test(wr), 'win32: no second, generic restart sentence for Claude Desktop');
  const dr = M.renderResults({ ...res }, SAMPLE.map((x) => (x.id === 'claude-desktop' ? { ...x, running: { checked: true, running: true } } : x)), 'darwin');
  ok(!/restart-windows/.test(dr) && /btn-secondary btn-xs" data-mcpi-act="check-again"/.test(dr) && /Claude Desktop is running — restart it/.test(dr), 'darwin: results unchanged (secondary Check again, generic restart)');
  ok(!/restart-windows/.test(M.renderResults({ action: 'install', items: [{ id: 'cursor', label: 'Cursor', outcome: 'written', file: 'f' }] }, WIN, 'win32')), 'win32: the line is only for a Claude Desktop change');

  // darwin and linux: byte-identical to the platform-less render
  const dsPanel = M.renderInstallPanel({ status: status(SAMPLE) });
  ok(!/data-mcpi-new-windows|data-mcpi-windows|data-mcpi-restart-windows/.test(dsPanel) && /data-mcpi-act="reveal"/.test(M.renderInstallPanel({ status: status([{ ...SAMPLE[3], files: [{ display: '~/w', file: '/h/w', state: 'jsonc' }] }]) })), 'darwin: no Windows element, Reveal kept');
  ok(M.overviewLine(SAMPLE) === M.overviewLine(SAMPLE, 'darwin') && M.overviewLine([], 'linux') === 'My Curator in your tools — no tool found on this Mac', 'darwin/linux overview line unchanged');
  ok(M.renderResults(res, SAMPLE) === M.renderResults(res, SAMPLE, 'darwin') && M.renderResults(res, SAMPLE) === M.renderResults(res, SAMPLE, 'linux'), 'darwin/linux results unchanged');
  const linX = M.renderInstallPanel({ status: status(SAMPLE.map((x) => ({ ...x, status: 'manual' })), { platform: 'linux', writable: false }) });
  ok(/on Linux/.test(linX) && !/data-mcpi-new-windows|data-mcpi-windows/.test(linX) && !/data-mcpi-tick/.test(linX), 'linux: copy-only, no Windows label');
  const wOff = M.renderInstallPanel({ status: wst(WIN, { writable: false }) });
  ok(/data-mcpi-nonmac>One-click install on Windows is not available right now/.test(wOff) && !/data-mcpi-tick/.test(wOff) && !/data-mcpi-new-windows/.test(wOff), 'win32 not writable: said open, copy instead');
  ok(!/data-mcpi-tick/.test(wOff) && /id="mcpi-install-btn"[^>]*disabled/.test(wOff), 'win32 not writable: no checkbox, Install disabled');
}
ok(netCalls === 0, 'no request fired by any Windows render');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
