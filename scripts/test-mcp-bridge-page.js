#!/usr/bin/env node
/**
 * OFFLINE — the facts the redesigned Settings › MCP bridge page reads (v3.88.0).
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * The 2026-11-01 truth audit of the bridge page found the page saying things
 * its data did not support: every open bridge "still offers the older tool
 * list" (it did not: the same 24 tools), Antigravity "1 to fix" with no
 * sentence saying what, Claude Code "copy only" while Setup said it was
 * configured through Claude Desktop's file, OpenCode "used 4 weeks ago"
 * beside "no entry" with nothing explaining the two, a disabled Install for
 * me with no word why, and "N of N connections" where the bar carried no
 * information. This suite pins the BACKEND answers to each of those:
 *
 *   §1  the tool-list signature — what moves it and what must not
 *   §2  the per-app row verdicts (skill sentence reused from Setup, the
 *       readAlso relation, used-without-entry, to-fix counting)
 *   §3  the install-status payload end to end, with every probe faked
 *   §4  per-project handoff saves for "Across projects", and the capped flag
 *
 * SAFETY — no real process list, no real home, no real usage log: the home is
 * a mkdtemp, the bridge reading and the machine rows are injected, and the
 * real MCP config files are fingerprinted before and after.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fingerprintReal, changedSince } from './test-helpers/real-mcp-configs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const eq = (label, a, b) => ok(label, Object.is(a, b), { got: a, expected: b });
const section = (t) => console.log('\n' + t);
const t0 = Date.now();

const REAL_BEFORE = fingerprintReal();
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'curator-bridge-page-')));
const HOME = path.join(TMP, 'home');
const UD = path.join(TMP, 'ud');
const DOM = path.join(TMP, 'domains');
const BIN = path.join(TMP, 'bin');
const APPS = path.join(TMP, 'Applications');
for (const d of [HOME, UD, DOM, BIN, APPS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = UD;
process.env.CURATOR_TEST_DOMAINS_DIR = DOM;
process.env.CURATOR_TEST_MCP_LAUNCHER_DIR = BIN;
process.env.CURATOR_TEST_LOG_DIR = path.join(UD, 'logs');

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOM);
const { toolSignature, TOOL_SIG_RE } = await import('../mcp/tool-signature.js');
const { tools: REAL_TOOLS } = await import('../mcp/tools/index.js');
const S = await import('../src/brain/setup-check.js');
const M = await import('../src/brain/mcp-install.js');
const R = await import('../src/routes/mcp-install.js');
const MCP = await import('../src/routes/mcp.js');
const B = await import('../src/brain/mcp-bridge-status.js');
const U = await import('../src/brain/mcp-usage.js');
const T = await import('../src/brain/tray-summary.js');

function put(p, text) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); }

// ─────────────────────────────────────────────────────────────────────────
section('§1  The tool-list signature');
// ─────────────────────────────────────────────────────────────────────────
{
  const defs = REAL_TOOLS.map((t) => t.definition);
  const sig = toolSignature(defs);
  ok('the real tool list signs to 8 lower-case hex', TOOL_SIG_RE.test(sig || ''), sig);
  eq('…and the usage log accepts exactly that shape', String(U.BRIDGE_TSIG_RE), String(TOOL_SIG_RE));
  eq('registration ORDER does not move it (the same set is the same list)', toolSignature([...defs].reverse()), sig);
  const reworded = defs.map((d, i) => (i === 0 ? { ...d, description: d.description + ' Reworded.' } : d));
  eq('a DESCRIPTION edit does not move it (never a reason to quit Claude Desktop)', toolSignature(reworded), sig);
  ok('a removed tool moves it', toolSignature(defs.slice(1)) !== sig);
  ok('an added tool moves it', toolSignature([...defs, { name: 'new_tool', inputSchema: { type: 'object' } }]) !== sig);
  const withArg = defs.map((d, i) => (i === 0 ? { ...d, inputSchema: { ...d.inputSchema, properties: { ...(d.inputSchema.properties || {}), extra: { type: 'string' } } } } : d));
  ok('a new ARGUMENT moves it (the schema is part of the list)', toolSignature(withArg) !== sig);
  const rev = (v) => (Array.isArray(v) ? v.map(rev) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, rev(v[k])])) : v);
  const reKeyed = defs.map((d) => ({ inputSchema: rev(d.inputSchema), name: d.name }));
  ok('CONTROL: the re-keyed copy really is in another key order', JSON.stringify(reKeyed[0].inputSchema) !== JSON.stringify(defs[0].inputSchema));
  eq('object KEY order inside a schema does not move it', toolSignature(reKeyed), sig);
  ok('junk in → null, never a guess', toolSignature(null) === null && toolSignature([]) === null && toolSignature([{ inputSchema: {} }]) === null);
  const cur = await B.currentBridgeIdentity();
  eq('the app computes the SAME signature from the code on disk', cur.toolsHash, sig);
  eq('…and the same tool count', cur.toolCount, defs.length);
}

// ─────────────────────────────────────────────────────────────────────────
section('§2  The per-app row verdicts');
// ─────────────────────────────────────────────────────────────────────────
const SKILL_DIR = path.join(HOME, '.gemini', 'config', 'plugins', 'the-curator', 'skills', 'my-curator');
const AG_MACHINE = {
  id: 'antigravity', label: 'Antigravity',
  bridge: { state: S.STATES.OK, word: 'configured' },
  skills: { state: S.STATES.FIX, word: 'my-curator outdated', roots: [path.dirname(SKILL_DIR)],
    installed: [{ skill: 'my-curator', dir: SKILL_DIR, match: false, differs: ['SKILL.md', 'examples.md'], missing: [] }] },
  hooks: { state: S.STATES.NONE, files: [] },
  files: [{ file: path.join(HOME, '.gemini/config/mcp_config.json'), display: '~/.gemini/config/mcp_config.json', via: 'own', named: true, present: true }],
};
const CD_FILE = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const CC_MACHINE = {
  id: 'claude-code', label: 'Claude Code',
  bridge: { state: S.STATES.OK, word: 'configured', via: 'readAlso', note: 'found only in Claude Desktop’s config', observation: 'Observed 2026-09-26.' },
  skills: { state: S.STATES.CANT, installed: [], roots: [] }, hooks: { state: S.STATES.NONE, files: [] },
  files: [{ file: path.join(HOME, '.claude.json'), display: '~/.claude.json', via: 'own', named: false, present: true },
    { file: CD_FILE, display: '~/Library/Application Support/Claude/claude_desktop_config.json', via: 'readAlso', named: true, present: true }],
};
{
  const v = S.machineRowVerdicts(AG_MACHINE, HOME);
  ok('an outdated skill gives a skill verdict', !!v.skill);
  eq('…whose text is Setup’s own sentence, word for word',
    v.skill.text, 'Antigravity’s my-curator skill is older than the copy this app carries (in ~/.gemini/config/plugins/the-curator/skills).');
  eq('…with Setup’s own instruction', v.skill.detail, 'Download the current .zip, replace the folder with it, then start a new Antigravity session.');
  eq('…the Download and Reveal actions, in that order', v.skill.fixes.map((f) => f.kind).join(','), 'download-skill,reveal');
  eq('…the download is the app’s own skill .zip', v.skill.fixes[0].href, '/api/setup/skills/my-curator.zip');
  eq('…the reveal opens the skill folder', v.skill.fixes[1].path, SKILL_DIR);
  eq('…and the files that differ are named', v.skill.differs.join(','), 'SKILL.md,examples.md');
  ok('a current skill gives none', S.machineRowVerdicts({ ...AG_MACHINE, skills: { state: S.STATES.OK, installed: [] } }, HOME).skill === null);

  const c = S.machineRowVerdicts(CC_MACHINE, HOME);
  eq('Claude Code configured only through Claude Desktop’s file → connectedVia Claude Desktop', c.connectedVia && c.connectedVia.id, 'claude-desktop');
  eq('…with the quiet line', c.connectedVia.text, 'Uses Claude Desktop’s entry.');
  eq('…naming the file', c.connectedVia.display, '~/Library/Application Support/Claude/claude_desktop_config.json');
  ok('…and `named` is true (a file this check reads names my-curator)', c.named === true);
  ok('a bridge configured in its OWN file has no connectedVia',
    S.machineRowVerdicts({ ...CC_MACHINE, bridge: { state: S.STATES.OK, word: 'configured' } }, HOME).connectedVia === null);
  ok('a readAlso that is a FIX (a different folder) is not "connected"',
    S.machineRowVerdicts({ ...CC_MACHINE, bridge: { state: S.STATES.FIX, via: 'readAlso', word: 'reads a different knowledge folder' } }, HOME).connectedVia === null);
  ok('no machine row → nothing', JSON.stringify(S.machineRowVerdicts(null)) === JSON.stringify({ skill: null, connectedVia: null, named: false }));

  const V = R.rowVerdict;
  eq('rowVerdict: connected + nothing to fix → connected', V({ status: 'connected' }).verdict, 'connected');
  eq('rowVerdict: connected + an outdated skill → to-fix', V({ status: 'connected', skill: {} }).verdict, 'to-fix');
  eq('rowVerdict: needs-update + a skill + a changed-tools bridge → three to fix', V({ status: 'needs-update', skill: {}, bridges: { notice: 'warn' } }).toFix, 3);
  eq('rowVerdict: a SAME-tools older bridge is not a fix', V({ status: 'connected', bridges: { notice: 'quiet' } }).verdict, 'connected');
  eq('rowVerdict: an UNKNOWN bridge (soft) is not a fix either — it warns once, softly', V({ status: 'connected', bridges: { notice: 'soft' } }).verdict, 'connected');
  eq('rowVerdict: copy-only through another app’s file → connected', V({ status: 'manual', connectedVia: {} }).verdict, 'connected');
  eq('rowVerdict: copy-only, nothing else → not-connected', V({ status: 'manual' }).verdict, 'not-connected');
}

// ─────────────────────────────────────────────────────────────────────────
section('§3  GET /api/mcp/install/status — the new fields, every probe faked');
// ─────────────────────────────────────────────────────────────────────────
M.__setHomeOverride(HOME);
M.__setPlatformOverride('darwin');
R.__setDetectDeps({ appsDirs: [APPS], runPs: async () => '  10 /Applications/Claude.app/Contents/MacOS/Claude\n', runShell: async () => '' });
mkdirSync(path.join(APPS, 'Claude.app'), { recursive: true });
put(CD_FILE, '{"mcpServers":{}}\n');
put(path.join(HOME, '.gemini', 'config', 'mcp_config.json'), '{"mcpServers":{}}\n');
put(path.join(HOME, '.claude.json'), '{}\n');
put(path.join(HOME, '.config', 'opencode', 'opencode.json'), '{}\n');
R.__setMachineRows([AG_MACHINE, CC_MACHINE, { id: 'opencode', label: 'OpenCode', bridge: { state: S.STATES.NONE, word: 'no entry found' }, skills: { state: S.STATES.NONE, installed: [] }, hooks: { state: S.STATES.NONE, files: [] }, files: [] }]);
// The usage log: OpenCode used the bridge once, weeks ago.
const USED = '2026-09-28T06:17:49.049Z';
put((await import('../src/brain/paths.js')).getMcpUsageLogPath(),
  `{"ts":"${USED}","ev":"session","sid":"aaaaaaaaaaaa","client":"opencode"}\n{"ts":"${USED}","tool":"list_domains","domain":null,"ok":true,"refused":false,"ms":1,"sid":"aaaaaaaaaaaa"}\n`);
// The open bridges: one Claude Desktop bridge whose tools DIFFER.
const SERVER = path.join(ROOT, 'mcp', 'server.js');
const cur = await B.currentBridgeIdentity();
const psTable = [
  '   500     1 Sun Nov  1 10:01:12 2026 /Applications/Claude.app/Contents/MacOS/Claude',
  `   510   500 Sun Nov  1 10:01:16 2026 /usr/local/bin/node ${SERVER}`,
].join('\n');
R.__setBridgeDeps({
  platform: 'darwin', serverPath: SERVER, selfPid: 999999, current: cur,
  sessions: [{ ev: 'session', pid: 510, at: Date.parse('Sun Nov  1 10:01:17 2026'), tsig: '00000000', v: '3.86.0', client: 'claude-desktop' }],
  execFile: (f, a, o, cb) => setImmediate(() => cb(null, psTable)),
});
{
  const st = await R.buildStatus();
  const row = (id) => st.tools.find((t) => t.id === id);
  const cd = row('claude-desktop');
  ok('Claude Desktop carries its open bridge', cd && cd.bridges && cd.bridges.count === 1, cd && cd.bridges);
  eq('…whose tools are different → notice warn', cd.bridges.notice, 'warn');
  eq('…naming the version it runs', cd.bridges.version, '3.86.0');
  ok('…with the remedy for Claude Desktop', /^Quit Claude Desktop \(Claude › Quit, or ⌘Q/.test(cd.bridges.remedy || ''), cd.bridges.remedy);
  eq('…and the current tool count beside it', cd.bridges.toolCount, cur.toolCount);
  eq('…so the row is to-fix (changed tools)', cd.verdict, 'to-fix');
  eq('…counting ONE reason: "can be added" is not-connected, never a fix', cd.toFix, 1);

  const ag = row('antigravity');
  ok('Antigravity carries Setup’s skill sentence on its row', ag && ag.skill && /older than the copy this app carries/.test(ag.skill.text), ag && ag.skill);
  eq('…and is to-fix', ag.verdict, 'to-fix');

  const cc = row('claude-code');
  eq('Claude Code keeps its installer status (copy only)', cc.status, 'manual');
  eq('…but reads connected through Claude Desktop', cc.verdict, 'connected');
  eq('…with the relation', cc.connectedVia && cc.connectedVia.label, 'Claude Desktop');

  const oc = row('opencode');
  eq('OpenCode: used, per the log', oc.usedAt, USED);
  ok('…with no entry, so the payload EXPLAINS the two', !!oc.usedWithoutEntry && oc.usedWithoutEntry.usedAt === USED && /^No entry in your user settings/.test(oc.usedWithoutEntry.text), oc.usedWithoutEntry);
  eq('…and it is not connected', oc.verdict, 'not-connected');
  ok('a connected-through-another-app row never gets usedWithoutEntry', cc.usedWithoutEntry === null);

  eq('counts: connected', st.counts.connected, 1);
  eq('counts: to fix', st.counts.toFix, 2);
  eq('counts: not connected', st.counts.notConnected, 1);
  ok('Install for me has rows to write here', st.install.available >= 2 && st.install.disabledReason === null, st.install);
  eq('bridgeCheck says the reading was taken', st.bridgeCheck.checked, true);
  eq('…and what the code on disk serves', st.bridgeCheck.current.toolsHash, cur.toolsHash);
  for (const k of ['platform', 'writable', 'launch', 'tools', 'notFound', 'manualSnippets']) ok(`the pre-existing field ${k} is still there`, Object.hasOwn(st, k));
  for (const k of ['id', 'label', 'status', 'installer', 'detected', 'running', 'files', 'reason', 'note', 'usedAt', 'restartHint', 'restorable']) ok(`…and every row keeps ${k}`, st.tools.every((t) => Object.hasOwn(t, k)));

  // Make every install-capable row connected: write the exact entries the
  // payload offers, then nothing is left to install.
  put(CD_FILE, st.manualSnippets['claude-desktop']);
  put(path.join(HOME, '.gemini', 'config', 'mcp_config.json'), st.manualSnippets.antigravity);
  const st2 = await R.buildStatus();
  eq('every install-capable row connected → Install for me has nothing to do', st2.install.available, 0);
  eq('…disabledReason nothing_to_install', st2.install.disabledReason, 'nothing_to_install');
  eq('…and the button’s words', st2.install.disabledText, 'Nothing to install');
  eq('…while Claude Desktop’s changed-tools bridge still makes it to-fix', st2.tools.find((t) => t.id === 'claude-desktop').verdict, 'to-fix');
  // The overview's cards (integration, per the acceptance picture): a CONNECTED
  // app that also has something to fix counts in BOTH cards; NOT CONNECTED is
  // the rows that are neither. Claude Desktop (bridge warn) and Antigravity
  // (outdated skill) are connected AND to fix; Claude Code connected via; OpenCode neither.
  eq('counts after connecting: connected includes the connected rows that are also to fix', st2.counts.connected, 3);
  eq('…to fix', st2.counts.toFix, 2);
  eq('…not connected is neither', st2.counts.notConnected, 1);
  eq('a Setup hooks fix makes a connected row to-fix', R.rowVerdict({ status: 'connected', hooksFix: { word: 'x' } }).verdict, 'to-fix');
  eq('CONTROL: without it the connected row is connected', R.rowVerdict({ status: 'connected' }).verdict, 'connected');

  M.__setPlatformOverride('linux');
  const st3 = await R.buildStatus();
  eq('Linux → platform_unsupported', st3.install.disabledReason, 'platform_unsupported');
  eq('…worded for this computer', st3.install.disabledText, 'Copy-only on this computer');
  M.__setPlatformOverride('darwin');

  // No seam → an isolated test process never lists real processes.
  R.__setBridgeDeps(null);
  const st4 = await R.buildStatus();
  eq('without a seam, under test isolation, the bridge reading is "not looked"', st4.bridgeCheck.checked, false);
  ok('…and no row claims a bridge', st4.tools.every((t) => t.bridges === null));
}

// ─────────────────────────────────────────────────────────────────────────
section('§3b  The tool map\u2019s readings from the usage log (integration): lastAgentAt and lastExercise');
// ─────────────────────────────────────────────────────────────────────────
{
  const L = (o) => ({ ok: true, refused: false, ms: 10, via: null, sid: 'a'.repeat(12), ...o, at: Date.parse(o.ts) });
  const lines = [
    L({ ts: '2026-11-01T09:00:00.000Z', tool: 'list_domains', sid: 'b'.repeat(12) }),
    L({ ts: '2026-11-01T10:00:00.000Z', tool: 'list_domains', via: 'self-test', sid: 'c'.repeat(12) }),
    L({ ts: '2026-11-01T11:00:00.000Z', tool: 'list_domains', via: 'self-test' }),
    L({ ts: '2026-11-01T11:00:00.400Z', tool: 'get_index', via: 'self-test', ok: false, refused: true }),
    L({ ts: '2026-11-01T11:00:01.000Z', tool: 'get_node', via: 'self-test', ok: false, ms: 100 }),
  ];
  const x = U.lastExerciseOf(lines);
  eq('lastExercise: the NEWEST run only (by its sid)', x && x.total, 3);
  eq('…started at its first call', x.at, '2026-11-01T11:00:00.000Z');
  eq('…answered counts ok and refused', x.answered, 2);
  eq('…refused', x.refused, 1);
  eq('…the tool that did not answer, by name', x.failed.join(','), 'get_node');
  eq('…the duration spans first call to the end of the last', x.durationMs, 1100);
  eq('…a refusal carries no invented reason', x.refusals[0].note, null);
  eq('no self-test line → null', U.lastExerciseOf(lines.slice(0, 1)), null);
  // lastAgentAt through the real route, over a real log file.
  const log = (await import('../src/brain/paths.js')).getMcpUsageLogPath();
  put(log, [
    '{"ts":"2026-10-30T08:00:00.000Z","tool":"search_wiki","domain":null,"ok":true,"refused":false,"ms":1,"sid":"dddddddddddd"}',
    '{"ts":"2026-11-01T08:00:00.000Z","tool":"search_wiki","domain":null,"ok":true,"refused":false,"ms":1,"sid":"eeeeeeeeeeee","via":"self-test"}',
  ].join('\n') + '\n');
  let body = null;
  await MCP.usageHandler({ query: {} }, { json: (b) => { body = b; }, status() { return this; } });
  const sw = body && body.tools.find((t) => t.name === 'search_wiki');
  eq('lastAgentAt: the newest NON-self-test call', sw && sw.lastAgentAt, '2026-10-30T08:00:00.000Z');
  eq('CONTROL: lastUsedAt is the self-test call', sw && sw.lastUsedAt, '2026-11-01T08:00:00.000Z');
  eq('…an unused tool has lastAgentAt null', body.tools.find((t) => t.name === 'get_tags').lastAgentAt, null);
  ok('the route carries lastExercise from the log', body.lastExercise && body.lastExercise.total === 1, body.lastExercise);
}

// ─────────────────────────────────────────────────────────────────────────
section('§4  Across projects — handoff saves from the store, and the capped flag');
// ─────────────────────────────────────────────────────────────────────────
{
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const DAY = 86400000;
  const since = NOW - 30 * DAY;
  eq('savesFor: in-window saves are counted', MCP.savesFor({ saveTimes: [NOW - 40 * DAY, NOW - 2 * DAY, NOW - DAY] }, since).saves, 2);
  eq('…the newest save of ANY age is the last save', MCP.savesFor({ saveTimes: [NOW - 40 * DAY, NOW - DAY] }, since).lastSaveAt, new Date(NOW - DAY).toISOString());
  eq('…a handoff write newer than any journal entry wins', MCP.savesFor({ saveTimes: [NOW - 3 * DAY], savedAtMax: NOW - DAY }, since).lastSaveAt, new Date(NOW - DAY).toISOString());
  eq('…a project whose scopes were not read is null, never 0', MCP.savesFor({}, since).saves, null);
  eq('…a project read with no saves is 0', MCP.savesFor({ saveTimes: [] }, since).saves, 0);
  eq('capped: a truncated journal whose oldest readable save is INSIDE the window → a floor',
    MCP.savesFor({ saveTimes: [NOW - DAY], saveTimesCapped: true, cappedFrom: NOW - DAY }, since).savesCapped, true);
  eq('capped: a truncated journal that still reaches BEFORE the window → exact', MCP.savesFor({ saveTimes: [NOW - 40 * DAY, NOW - DAY], saveTimesCapped: true, cappedFrom: NOW - 40 * DAY }, since).savesCapped, false);
  eq('capped: no truncation → exact', MCP.savesFor({ saveTimes: [NOW - DAY] }, since).savesCapped, false);

  // getStoreActivity hands the route each project's save times, from the
  // SAME listing the pulse reads.
  const scopes = {
    a: [{ scope: 'claude-code', machine: 'm1', saveTimes: [NOW - 2 * DAY, NOW - DAY], journalTailTruncated: true, writtenAt: new Date(NOW - DAY).toISOString() },
      { scope: 'antigravity', machine: 'm1', saveTimes: [NOW - 50 * DAY], journalTailTruncated: false, writtenAt: new Date(NOW - 50 * DAY).toISOString() }],
    b: [],
  };
  const store = {
    listAllProjects: async () => ({ projects: [{ domain: 'projects', project: 'a' }, { domain: 'projects', project: 'b' }], total: 2 }),
    listWorkingScopes: async (_d, o) => ({ ok: true, scopes: scopes[o.project] }),
  };
  const act = await T.getStoreActivity({ store, now: NOW });
  const pa = act.projects.find((p) => p.project === 'a');
  eq('getStoreActivity: every work-stream’s save times are gathered', pa.saveTimes.length, 3);
  eq('…the truncation is carried', pa.saveTimesCapped, true);
  eq('…with the oldest save the truncated journal still showed', pa.cappedFrom, NOW - 2 * DAY);
  const sa = MCP.savesFor(pa, since);
  eq('→ 2 saves in the window', sa.saves, 2);
  eq('→ a floor ("2+")', sa.savesCapped, true);
  eq('an empty project → 0 saves, exact', MCP.savesFor(act.projects.find((p) => p.project === 'b'), since).saves, 0);

  // The route: each row carries saves; nothing raw leaks onto the wire.
  const body = await new Promise((resolve) => MCP.usageHandler({ query: { include: 'projects' } }, { json: resolve, status: () => ({ json: resolve }) }));
  ok('the route answers a byProject list', Array.isArray(body.byProject));
  ok('…every row carries saves / lastSaveAt / savesCapped', body.byProject.every((r) => 'saves' in r && 'lastSaveAt' in r && 'savesCapped' in r));
  ok('…and no row carries the raw save times', body.byProject.every((r) => !('saveTimes' in r) && !('cappedFrom' in r)));
  // v3.88.0 polish — ONE window for block ④: saves per project are counted
  // over the pulse's window (the per-app reading's), and the route says so.
  eq('byProjectWindow.savesWindowDays is the pulse window (7)', body.byProjectWindow && body.byProjectWindow.savesWindowDays, T.PULSE_WINDOW_SECONDS / 86400);
  const ss = body.byProjectWindow && Date.parse(body.byProjectWindow.savesSince);
  ok('…and savesSince is that many days back', Number.isFinite(ss) && Math.abs((Date.now() - ss) - T.PULSE_WINDOW_SECONDS * 1000) < 60000, body.byProjectWindow && body.byProjectWindow.savesSince);
}

R.__setMachineRows(null);
M.__setHomeOverride(null);
M.__setPlatformOverride(null);
const realChanged = changedSince(REAL_BEFORE);
ok('the real MCP config files were not touched by this run', realChanged.length === 0, realChanged);
rmSync(TMP, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '✓' : '✗'} test-mcp-bridge-page: ${passed} passed, ${failed} failed  (${Date.now() - t0} ms)`);
process.exit(failed === 0 ? 0 : 1);
