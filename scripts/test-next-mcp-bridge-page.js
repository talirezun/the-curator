#!/usr/bin/env node
/**
 * test-next-mcp-bridge-page.js — v3.88.0. Settings › MCP bridge › 1 "Connect
 * your agent apps": the ONE-ROW-PER-APP model and its adapters, through the
 * REAL DOM-free builders in views/mcp-install.js, fed the shapes of BE
 * amendment 1 (GET /api/mcp/config `bridge_processes.bridges[]`, the install
 * status rows' `bridges` / `skill` / `connectedVia` / `usedWithoutEntry`,
 * `install.disabledText`) and the shapes an older server sends.
 *
 * Exists to stop (each proved by mutation — see the report of v3.88.0):
 *   §1 a bridge serving the SAME tools raising a warning (the owner's
 *      decision 3) — it is one quiet line on its app's row, or nothing;
 *   §2 a warning behind a chevron: every warning is unfolded under its row,
 *      with its own buttons; the evidence fold is CLOSED by default;
 *   §3 one app with two verdicts (truth audit A2): the outdated skill is said
 *      ON the row, with Download and Reveal, and counted "to fix";
 *   §4 Claude Code read as "copy only" while it works through Claude
 *      Desktop's entry (T2), and an unexplained "used" age (T3);
 *   §5 a disabled primary button with no word (T7);
 *   §6 an older payload breaking the page, or "did not look" read as "none".
 */
const M = await import('../src/public/next/views/mcp-install.js');

let passed = 0, failed = 0;
const ok = (c, l, d) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.log(`  ✗ ${l}${d !== undefined ? `\n      ${String(d).slice(0, 600)}` : ''}`); } };
const section = (t) => console.log(`\n${t}`);
let net = 0;
globalThis.fetch = () => { net++; return Promise.reject(new Error('network used')); };

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const REMEDY = 'Quit Claude Desktop (⌘Q — closing the window is not enough) and reopen it. This also ends Claude Code sessions in its Code tab.';
const cfg = (bridges, extra = {}) => ({ bridge_stale_remedy: 'Restart the app that launched it.',
  bridge_processes: { checked: true, running: bridges.length, stale: [], current: { version: '3.88.0', toolsHash: 'aaaa', toolCount: 24 }, bridges, ...extra } });
const br = (o) => ({ pid: 1, startedAt: iso(3 * 3600e3), app: { id: 'claude-desktop', label: 'Claude Desktop', checked: true },
  version: '3.87.1', toolsHash: 'aaaa', tools: 'same', notice: 'quiet', remedy: null, ...o });
const tool = (o) => ({ id: 'claude-desktop', label: 'Claude Desktop', status: 'connected', installer: 'file',
  running: { checked: true, running: true }, files: [{ display: '~/Library/Application Support/Claude/claude_desktop_config.json', state: 'connected' }],
  reason: null, note: null, usedAt: iso(4 * 3600e3), restartHint: 'Quit Claude Desktop first for the safest install — it rewrites its own config file — then reopen it.', restorable: false, ...o });
const machine = () => M.adaptMachine({ data: { ok: true, checkedAt: iso(1000), version: '3.88.0', install: 'Packaged app', skillsShipped: true,
  harnesses: [
    { id: 'claude-desktop', label: 'Claude Desktop', bridge: { state: 'ok', word: 'configured' },
      skills: { state: 'cant-check', word: 'can’t check here', note: 'held by your Claude account', installed: [] }, hooks: { state: 'none', format: 'none', files: [] },
      files: [{ file: '/Users/ann/Library/Application Support/Claude/claude_desktop_config.json', display: '~/Library/Application Support/Claude/claude_desktop_config.json', via: 'own', present: true, named: true, status: 'ok' }] },
    { id: 'claude-code', label: 'Claude Code', bridge: { state: 'ok', word: 'configured', via: 'readAlso' },
      skills: { state: 'cant-check', word: 'can’t check here', note: 'held by your Claude account', installed: [] }, hooks: { state: 'none', format: 'verified', files: [] },
      files: [{ file: '/Users/ann/.claude.json', display: '~/.claude.json', via: 'own', present: true, named: false, status: 'ok' },
        { file: '/Users/ann/Library/Application Support/Claude/claude_desktop_config.json', display: '~/Library/Application Support/Claude/claude_desktop_config.json', via: 'readAlso', present: true, named: true, status: 'ok' }] },
    { id: 'antigravity', label: 'Antigravity', bridge: { state: 'ok', word: 'configured' },
      skills: { state: 'fix', word: 'my-curator outdated', installed: [{ skill: 'my-curator', dir: '/Users/ann/.gemini/config/plugins/the-curator/skills/my-curator',
        dirDisplay: '~/.gemini/config/plugins/the-curator/skills/my-curator', match: false, differs: ['SKILL.md', 'examples.md', 'maintenance.md', 'shared-brain.md'], missing: [] }] },
      hooks: { state: 'unmeasured', format: 'verified', files: [] },
      files: [{ file: '/Users/ann/.gemini/config/mcp_config.json', display: '~/.gemini/config/mcp_config.json', via: 'own', present: true, named: true, status: 'ok' }] },
    { id: 'opencode', label: 'OpenCode', bridge: { state: 'none', word: 'no entry found' }, skills: { state: 'none', installed: [] }, hooks: { state: 'none', format: 'present-useless', files: [] },
      files: [{ file: '/Users/ann/.config/opencode/opencode.json', display: '~/.config/opencode/opencode.json', via: 'own', present: true, named: false, status: 'ok' }] },
  ] } });
const SNIP = (key) => JSON.stringify({ [key]: { 'my-curator': { command: '/x/launcher' } } });
const status = (tools, extra = {}) => ({ data: { platform: 'darwin', writable: true, notFound: [{ id: 'cursor', label: 'Cursor' }, { id: 'zed', label: 'Zed' }],
  manualSnippets: { 'claude-code': SNIP('mcpServers'), opencode: SNIP('mcp'), cline: SNIP('mcpServers'), cursor: SNIP('mcpServers') }, tools, ...extra } });
const LIVE = () => [
  tool(),
  tool({ id: 'claude-code', label: 'Claude Code', status: 'manual', installer: 'cli', running: { checked: false, running: false }, files: [], usedAt: null, restartHint: null,
    reason: { code: 'installer_cli', message: 'Claude Code has its own command for this — one-click install comes in a later version. Copy the entry for now.' } }),
  tool({ id: 'antigravity', label: 'Antigravity', running: { checked: true, running: false }, usedAt: null, note: 'Antigravity keeps more than one MCP file on this Mac; each one that exists is kept in step.',
    files: [{ display: '~/.gemini/config/mcp_config.json', state: 'connected' }] }),
  tool({ id: 'cline', label: 'Cline', status: 'manual', installer: 'cli', running: { checked: false, running: false }, files: [], usedAt: null, restartHint: null,
    reason: { code: 'installer_cli', message: 'Cline has its own command for this.' } }),
  tool({ id: 'opencode', label: 'OpenCode', status: 'manual', installer: 'manual', running: { checked: false, running: false }, files: [], usedAt: iso(28 * 86400e3), restartHint: null,
    reason: { code: 'installer_manual', message: 'Copy the entry into OpenCode\'s settings by hand.' } }),
];
const mf = () => { const m = machine(); const out = {}; for (const h of m.harnesses) out[h.id] = h.files.map((f) => ({ display: f.display, file: f.file, present: f.present })); out.cline = [{ display: '~/.cline/data/settings/cline_mcp_settings.json', present: true }]; return out; };
const panel = (bridges, tools = LIVE(), extra = {}) => M.renderInstallPanel({ status: status(tools, extra), ticks: {}, machine: machine(), bridges: M.adaptBridges(cfg(bridges)),
  current: { version: '3.88.0', toolCount: 24 }, machineFiles: mf(), folds: {} });
const rowOf = (html, id) => (html.match(new RegExp('<div class="mcpi-row[^"]*" data-mcpi-tool="' + id + '">[\\s\\S]*?(?=<div class="mcpi-row|<details class="settings-setup-fold mcpi-notfound|$)')) || [''])[0];
const warns = (html) => [...html.matchAll(/<div class="cur-mon-loud[^"]*mcpi-warn"[^>]*data-mcpi-warn="([^"]+)"/g)].map((m) => m[1]);
/** Every warning's position is outside every <details>. */
function warningsInsideFolds(html) {
  const out = [];
  let depth = 0;
  const re = /<details\b|<\/details>|data-mcpi-warn="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0] === '<details' ) depth++;
    else if (m[0] === '</details>') depth--;
    else if (depth > 0) out.push(m[1]);
  }
  return out;
}

// ── §1 ─────────────────────────────────────────────────────────────────────
section('§1 the stale-bridge rule (the owner’s decision 3)');
{
  const same = panel([br(), br({ pid: 2 })]);
  ok(warns(same).every((k) => !/^bridge/.test(k)), 'SAME tools, older version: no bridge warning on any row', warns(same).join(','));
  ok(/data-mcpi-bridge="same">Running My Curator 3\.87\.1 since \d\d:\d\d — the same 24 tools as 3\.88\.0\. It moves to 3\.88\.0 the next time you quit Claude Desktop\.</.test(rowOf(same, 'claude-desktop')),
    '…one quiet line on Claude Desktop’s row instead', rowOf(same, 'claude-desktop'));
  ok(!/restart needed/.test(same), '…and no "restart needed" mark');
  ok(!/data-mcpi-bridge|bridge/.test(warns(panel([br({ version: '3.88.0', notice: 'none' })])).join()) && !/the same 24 tools/.test(panel([br({ version: '3.88.0', notice: 'none' })])),
    'same tools AND same version: nothing at all');
  const diff = panel([br({ tools: 'different', notice: 'warn', remedy: REMEDY })]);
  ok(warns(rowOf(diff, 'claude-desktop')).includes('bridge') && /restart needed/.test(rowOf(diff, 'claude-desktop')), 'tools CHANGED: a warning and a "restart needed" mark, on Claude Desktop’s row');
  ok(rowOf(diff, 'claude-desktop').includes('<strong>' + REMEDY.replace(/&/g, '&amp;') + '</strong>'), '…with the payload’s quit step verbatim, in bold');
  ok(warns(diff).filter((k) => k === 'bridge').length === 1 && !warns(rowOf(diff, 'claude-code')).includes('bridge'), '…once, and only on the app that opened it');
  const withMissing = M.bridgeRowFact('Claude Desktop', { tools: 'changed', notice: 'warn', version: '3.86.0', startedAt: null, missing: ['get_project_context', 'save_foundation'], remedy: 'R' });
  ok(withMissing.warn.text === 'Claude Desktop is still using My Curator 3.86.0 — it lacks get_project_context and save_foundation.', 'when the payload names what is missing, the warning names it', withMissing.warn.text);
  const soft = panel([br({ tools: 'unknown', notice: 'soft', version: null, remedy: REMEDY })]);
  ok(warns(rowOf(soft, 'claude-desktop')).includes('bridge-unknown') && /cur-mon-quiet mcpi-warn/.test(rowOf(soft, 'claude-desktop')), 'UNKNOWN: one SOFT line (the quiet tone), "can’t tell"');
  ok((soft.match(/data-mcpi-warn="bridge-unknown"/g) || []).length === 1, '…once, however many bridges the app has open');
  // The backend's notice decides — the view never re-derives it.
  ok(!M.bridgeRowFact('X', { tools: 'unknown', notice: 'none', missing: [] }).warn, 'an unknown bridge the backend marks "none" (started after the code changed) says nothing');
  // A row's own `bridges` summary is read too.
  const rowLevel = M.renderInstallPanel({ status: status([tool({ bridges: { count: 2, notice: 'warn', oldestStartedAt: iso(3600e3), version: '3.86.0', tools: 'different', remedy: REMEDY, toolCount: 24 } })]),
    machine: machine(), bridges: M.adaptBridges(cfg([])), current: { version: '3.88.0', toolCount: 24 } });
  ok(warns(rowLevel).includes('bridge'), 'the install status row’s own `bridges` summary raises the same warning');
}

// ── §2 ─────────────────────────────────────────────────────────────────────
section('§2 a warning is never behind a chevron; the evidence fold is closed');
{
  const html = panel([br({ tools: 'different', notice: 'warn', remedy: REMEDY })], [...LIVE(), tool({ id: 'windsurf', label: 'Windsurf', status: 'cant-read', reason: 'The file has comments.', files: [{ display: '~/w.json', file: '/Users/ann/w.json' }] })]);
  ok(warns(html).length >= 3, 'CONTROL: the fixture raises several warnings (bridge, skill, can’t read)', warns(html).join(','));
  ok(warningsInsideFolds(html).length === 0, 'no warning sits inside any <details>', warningsInsideFolds(html).join(','));
  const details = [...html.matchAll(/<details class="mcpi-more"[^>]*>/g)].map((m) => m[0]);
  ok(details.length >= 3 && details.every((d) => !/\bopen\b/.test(d)), 'every per-row disclosure renders CLOSED', details.join(' | '));
  const opened = M.renderInstallPanel({ status: status(LIVE()), machine: machine(), bridges: M.adaptBridges(cfg([])), folds: { 'tool-antigravity': true } });
  ok(/data-setup-fold="tool-antigravity" open>/.test(opened), '…until the person opens one (its state survives a repaint)');
  ok(/<summary>Files and skills<\/summary>/.test(rowOf(html, 'claude-desktop')), 'the fold names what it holds ("Files and skills")');
  ok(/data-mcpi-act="remove" data-tool="claude-desktop">Remove from Claude Desktop</.test(rowOf(html, 'claude-desktop'))
    && /<details[\s\S]*Remove from Claude Desktop[\s\S]*<\/details>/.test(rowOf(html, 'claude-desktop')), 'Remove lives inside the disclosure, named for its app');
  ok(/Antigravity keeps more than one MCP file/.test(rowOf(html, 'antigravity').match(/<details[\s\S]*<\/details>/)[0]), 'an explanation (Antigravity’s several files) moves into the disclosure');
  ok(!/<details/.test(rowOf(html, 'cline')) && !/<details/.test(rowOf(html, 'opencode')), 'a not-connected app with nothing to fix has no disclosure — its copy line is all it needs');
  ok(!/Quit Claude Desktop first for the safest install/.test(rowOf(html, 'claude-desktop')), 'the safe-install hint is not shown on a CONNECTED row (it belongs to an install about to happen)');
}

// ── §3 ─────────────────────────────────────────────────────────────────────
section('§3 one app, one verdict: the outdated skill is said on the row');
{
  const html = panel([br()]);
  const ag = rowOf(html, 'antigravity');
  ok(/data-mcpi-warn="skill">Its my-curator skill is older than this app’s copy \(4 files differ\)\. <strong>Download it, replace ~\/\.gemini\/config\/plugins\/the-curator\/skills\/my-curator with it, then start a new Antigravity session\.<\/strong>/.test(ag),
    'the sentence and the step, unfolded on Antigravity’s row', ag);
  ok(/href="\/api\/setup\/skills\/my-curator\.zip" download data-mcpi-download="my-curator">Download my-curator\.zip</.test(ag) && /data-setup-act="reveal" data-path="\/Users\/ann\/\.gemini\/config\/plugins\/the-curator\/skills\/my-curator">Reveal folder</.test(ag),
    '…with its own Download and Reveal folder buttons');
  ok(/data-mcpi-status="connected">connected</.test(ag) && /data-mcpi-fixn>1 to fix</.test(ag), 'the row reads "connected · 1 to fix" — never "connected" above a hidden fault');
  const win = M.renderInstallPanel({ status: status(LIVE(), { platform: 'win32' }), machine: machine(), bridges: M.adaptBridges(cfg([])) });
  ok(!/Reveal folder/.test(rowOf(win, 'antigravity')) && /Download my-curator\.zip/.test(rowOf(win, 'antigravity')), 'win32: Download stays, Reveal (macOS only) goes');
  // The payload's own sentence wins (setup-check's skillsItem), with its fix list.
  const withSkill = LIVE().map((t) => (t.id === 'antigravity' ? { ...t, skill: { reason: 'outdated', text: 'Antigravity’s my-curator skill is older than the copy this app carries.',
    detail: 'Download the current .zip, replace the folder with it, then start a new Antigravity session.',
    fixes: [{ kind: 'download-skill', skill: 'my-curator', href: 'https://evil.example/x.zip', label: 'Download my-curator.zip' }, { kind: 'reveal', path: '/Users/ann/.gemini/s', label: 'Reveal the folder' }] } } : t));
  const p2 = panel([], withSkill);
  const ag2 = rowOf(p2, 'antigravity');
  ok(/Antigravity’s my-curator skill is older than the copy this app carries\. <strong>Download the current \.zip/.test(ag2), 'the payload’s `skill.text` / `skill.detail` are used verbatim');
  ok((ag2.match(/data-mcpi-warn="skill"/g) || []).length === 1, '…and the derived sentence is not ALSO shown');
  ok(!/evil\.example/.test(ag2) && /href="\/api\/setup\/skills\/my-curator\.zip"/.test(ag2), 'a payload `href` is never followed — the download is always this app’s own route');
  ok(/>Reveal folder</.test(ag2), '"Reveal the folder" reads "Reveal folder"');
  const c = M.countVerdicts(M.appRowModels(status(LIVE()), { machine: machine(), bridges: M.adaptBridges(cfg([br()])), current: { version: '3.88.0', toolCount: 24 }, machineFiles: mf() }));
  ok(c.connected === 3 && c.fix === 1 && c.notConnected === 2, 'the overview counts 3 connected · 1 to fix · 2 not connected (the acceptance picture)', JSON.stringify(c));
}

// ── §4 ─────────────────────────────────────────────────────────────────────
section('§4 Claude Code through Claude Desktop, and a use with no entry');
{
  const html = panel([br()]);
  const cc = rowOf(html, 'claude-code');
  ok(/data-mcpi-status="via">connected in the Claude app</.test(cc), 'Claude Code reads "connected in the Claude app", never "copy only" (truth audit T2)', cc);
  ok(/Uses Claude Desktop’s entry\. For <span class="mono">claude<\/span> in a terminal, paste into <span class="mono">~\/<wbr>\.claude\.json<\/span> inside &quot;mcpServers&quot;\./.test(cc), '…and says how to add its own for `claude` in a terminal', (cc.match(/data-mcpi-copyline>[\s\S]*?<\/p>/) || [''])[0]);
  ok(!/later version/.test(cc) && !/Copy the entry for now/.test(cc), 'the installer’s "has its own command…" sentence is not shown');
  ok(/data-mcpi-act="copy" data-tool="claude-code">Copy entry</.test(cc), 'its one action: Copy entry');
  const viaPayload = M.adaptInstallTool({ id: 'claude-code', connectedVia: { id: 'claude-desktop', label: 'Claude Desktop', text: 'Uses Claude Desktop’s entry.' } }, null);
  ok(viaPayload.via && viaPayload.via.id === 'claude-desktop' && viaPayload.via.text === 'Uses Claude Desktop’s entry.', 'the payload’s `connectedVia` is read as the relation');
  const oc = rowOf(html, 'opencode');
  ok(/data-mcpi-status="manual">not connected</.test(oc) && /used 4 weeks ago/.test(oc), 'OpenCode: "not connected · used 4 weeks ago"');
  ok(/No entry in your user settings — the use 4 weeks ago came from another file\. Paste into <span class="mono">~\/<wbr>\.config\/<wbr>opencode\/<wbr>opencode\.json<\/span> inside &quot;mcp&quot;\./.test(oc), '…and the row explains the use and where the entry goes (T3)', (oc.match(/data-mcpi-copyline>[\s\S]*?<\/p>/) || [''])[0]);
  const uwe = panel([], LIVE().map((t) => (t.id === 'opencode' ? { ...t, usedWithoutEntry: { usedAt: t.usedAt, text: 'Server says: used, no entry.' } } : t)));
  ok(/Server says: used, no entry\. Paste into/.test(rowOf(uwe, 'opencode')), 'the payload’s `usedWithoutEntry.text` wins');
  ok(/Paste into <span class="mono">~\/<wbr>\.cline[\s\S]*?<\/span> inside &quot;mcpServers&quot;\. One-click comes in a later version\./.test(rowOf(html, 'cline')), 'Cline: the copy line, then "One-click comes in a later version."', (rowOf(html, 'cline').match(/data-mcpi-copyline>[\s\S]*?<\/p>/) || [''])[0]);
  ok(/Not on this Mac \(2\)[\s\S]*mcpi-nf-names">Cursor · Zed</.test(html) && !/<details[^>]*mcpi-notfound[^>]*open/.test(html), '"Not on this Mac (2)" is folded, with the names in its summary');
}

// ── §5 ─────────────────────────────────────────────────────────────────────
section('§5 the Install button says why it is disabled');
{
  ok(M.installButtonState(status(LIVE()), {}, null).label === 'Nothing to install' && M.installButtonState(status(LIVE()), {}, null).disabled, 'nothing installable: "Nothing to install", disabled (T7)');
  ok(M.installButtonState(status(LIVE(), { install: { available: 0, disabledReason: 'not_writable', disabledText: 'Can’t install here' } }), {}, null).label === 'Can’t install here', 'the payload’s `disabledText` wins');
  const one = [tool({ id: 'cursor', label: 'Cursor', status: 'not-installed', files: [{ display: '~/.cursor/mcp.json' }] })];
  ok(M.installButtonState(status(one), {}, null).label === 'Install for me' && !M.installButtonState(status(one), {}, null).disabled, 'CONTROL: one installable app reads "Install for me", enabled');
  ok(M.installButtonState(status(one), { cursor: false }, null).label === 'Install for me', 'an app the person un-ticked is still installable — the label stays "Install for me"');
}

// ── §6 ─────────────────────────────────────────────────────────────────────
section('§6 older payloads, and "did not look"');
{
  const old = M.adaptBridges({ bridge_stale_remedy: 'Restart the app that launched it.', bridge_processes: { checked: true, running: 2, stale: [{ pid: 4, startedAt: iso(3600e3) }] } });
  ok(old.list.length === 1 && old.list[0].tools === 'unknown' && old.list[0].notice === 'soft' && old.list[0].appId === null && old.list[0].remedy === 'Restart the app that launched it.',
    'a pre-3.88 payload: each stale entry is "unknown", soft, unattributed, with the route’s one remedy');
  ok(!/data-mcpi-warn="bridge/.test(M.renderInstallPanel({ status: status(LIVE()), machine: machine(), bridges: old })), '…and an unattributed bridge lands on NO row');
  const notLooked = M.adaptBridges({ bridge_processes: { checked: false, reason: 'no ps', stale: [{ pid: 9 }] } });
  ok(notLooked.checked === false && notLooked.list.length === 0 && notLooked.reason === 'no ps', '`checked: false` is "did not look" — never a list, never "none"');
  ok(M.adaptBridges(null).checked === false && M.adaptBridges({}).checked === false, 'no payload at all: not checked');
  const modern = M.adaptBridges(cfg([br({ tools: 'different', notice: 'warn' })]));
  ok(modern.list[0].tools === 'changed' && modern.current.version === '3.88.0' && modern.current.toolCount === 24, '"different" reads as changed; `current` is carried');
  ok(M.adaptBridges(cfg([br({ notice: 'bogus', tools: 'same' })])).list[0].notice === 'quiet', 'an unknown notice falls back to the one the comparison implies');
  ok(M.tildePath('/Users/ann/second-brain/domains', '/Users/ann') === '~/second-brain/domains' && M.tildePath('/Users/annex/x', '/Users/ann') === '/Users/annex/x', 'tildePath shortens only below the home the machine reading showed');
  ok(machine().home === '/Users/ann', 'the home is read from a file shown beside its "~/" display — never guessed');
  const evil = '<img src=x onerror=1>';
  const h = M.renderInstallPanel({ status: status([tool({ label: evil })]), machine: null, bridges: M.adaptBridges(cfg([br({ app: { id: 'claude-desktop', label: evil }, tools: 'different', notice: 'warn', remedy: evil })])) });
  ok(!/<img/.test(h) && /&lt;img/.test(h), 'labels and remedies from a payload are escaped');
}
// Moved from test-mcp-stale-bridge.js §7 (v3.88.0 integration): THE REMEDY IS
// NEVER AUTHORED IN THE VIEW. The backend owns the sentence (STALE_REMEDY and
// staleRemedyFor); a second copy in the view that happens to be right today
// goes stale tomorrow.
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const B = await import('../src/brain/mcp-bridge-status.js');
  const views = ['src/public/next/views/mcp-install.js', 'src/public/next/views/settings.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const sentences = [B.STALE_REMEDY,
    B.staleRemedyFor({ id: 'claude-desktop', label: 'Claude Desktop' }, 'darwin'),
    B.staleRemedyFor({ id: 'cursor', label: 'Cursor' }, 'win32'),
    B.staleRemedyFor(null)];
  ok(sentences.every((x) => typeof x === 'string' && x.length > 20), 'CONTROL: the backend\u2019s remedy sentences are read');
  ok(sentences.every((x) => !views.includes(x)), 'no backend remedy sentence is typed into the view\u2019s source');
}
// The overview renders the BACKEND's counts when it sends them (integration).
{
  const withCounts = status(LIVE(), { counts: { connected: 7, toFix: 5, notConnected: 3 } });
  const h = M.renderInstallOverview(withCounts, {}, null, { machine: machine() });
  ok(/>7</.test(h) && />5</.test(h) && />3</.test(h), 'the overview cards show the payload’s `counts`, as sent');
  ok(M.countsFor({ counts: { connected: 1, toFix: 0, notConnected: 2 } }, []).notConnected === 2, 'countsFor: payload counts win');
  ok(M.countsFor({}, [{ connected: true, fix: true }, { connected: false, fix: false }]).connected === 1
    && M.countsFor({}, [{ connected: true, fix: true }]).fix === 1, 'countsFor: an older payload is counted from the rows (connected and to-fix overlap)');
  const row = M.appRowModel({ id: 'cline', label: 'Cline', status: 'manual', installer: 'cli', verdict: 'to-fix', setupFix: { word: 'launch file missing' }, files: [] }, { platform: 'darwin' });
  ok(row.fix === true && row.warnings.some((w) => w.kind === 'bridge-file' && /launch file missing/.test(w.text)), 'a `setupFix` the backend counts is said on its row');
}
// v3.88.0 polish — "Run self-test" is a real secondary button ATTACHED to
// the Bridge answers panel (the same `btn btn-secondary` as "Copy it myself"),
// never faint plain text floating under it. Executed from views/settings.js.
section('§7 the self-test is a button on the Bridge answers panel');
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
  const start = src.search(/function renderSelfTestResult\s*\(/);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  const fnSrc = src.slice(start, i + 1);
  const { renderMonitor } = await import('../src/public/next/shared/monitor.js');
  const { formatAge } = await import('../src/public/next/shared/age.js');
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const run = (st, last) => new Function('state', 'lastSelfTest', 'adaptMachine', 'adaptBridges', 'currentBridgeFacts', 'tildePath',
    'ageSecondsOf', 'formatAge', 'escapeHtml', 'installWords', 'renderMonitor', fnSrc + '\nreturn renderSelfTestResult();')(
    st, () => last, () => null, () => ({ checked: true, running: 0, list: [] }), () => ({ version: '3.88.0' }), (p) => p,
    () => 5, formatAge, esc, () => '', renderMonitor);
  const h = run({ mcp: { domains_dir: '/x/domains' } }, { ok: true, toolCount: 24, at: iso(5000) });
  const btn = (h.match(/<button[^>]*id="btn-mcp-self-test"[^>]*>[^<]*<\/button>/) || [''])[0];
  ok(/class="btn btn-secondary"/.test(btn) && />Run self-test</.test(btn), '★ "Run self-test" is a secondary button, like "Copy it myself"', btn);
  ok(/^<div class="mcp-bridge-panel"><div class="cur-mon" id="mcp-bridge-monitor"[^]*<\/div><div class="settings-btn-row mcp-bridge-acts"><button/.test(h),
    '…attached directly under the Bridge answers panel, inside its wrapper', h.slice(-300));
  const busy = run({ mcp: {}, selfTestLoading: true }, null);
  ok(/class="btn btn-secondary" id="btn-mcp-self-test" disabled>Testing…</.test(busy), '…and while it runs it says "Testing…" and is disabled');
}
ok(net === 0, 'no builder fired a request', net);

console.log(`\n${failed ? '✗' : '✓'} test-next-mcp-bridge-page: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
