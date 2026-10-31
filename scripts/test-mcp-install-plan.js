#!/usr/bin/env node
/**
 * test-mcp-install-plan.js — OFFLINE. The PURE half of v3.85.0's installer
 * (src/brain/mcp-install.js): reading a target exactly, the status words, the
 * planner, the structural check — all over an IN-MEMORY filesystem, so not one
 * byte is read from or written to a real disk except the read-only real-file
 * fingerprint.
 *
 * Matrix: {absent, empty, valid-with-others, already-ours, stale-ours, corrupt,
 * JSONC-with-comments, symlink, non-object, servers-not-object, duplicate key,
 * lossy number} × {claude-desktop, cursor, antigravity}; repo vs bundle launch
 * lines; the Antigravity observed files; indent / CRLF / trailing newline; the
 * structural check proven to bite; Restore eligibility.
 */
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fingerprintReal, changedSince } from './test-helpers/real-mcp-configs.js';

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
const eq = (label, a, b) => ok(label, Object.is(a, b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = (t) => console.log('\n' + t);

const REAL_BEFORE = fingerprintReal();
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-mcpinst-plan-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'ud');

const M = await import('../src/brain/mcp-install.js');
const A = await import('../src/brain/harness-adapters.js');

const HOME = '/fakehome/u';

// ── An in-memory filesystem, shaped like the IO the module injects ─────────
function memfs(files = {}) {
  const fs = new Map();
  for (const [p, v] of Object.entries(files)) {
    if (v && v.symlink) fs.set(p, { type: 'symlink', mode: 0o777 });
    else if (v && v.dir) fs.set(p, { type: 'dir', mode: 0o755 });
    else fs.set(p, { type: 'file', bytes: Buffer.from(v), mode: 0o644 });
  }
  const writes = [];
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    fs, writes,
    lstat(p) {
      const e = fs.get(p); if (!e) throw enoent();
      return { mode: e.mode | (e.type === 'file' ? 0o100000 : 0), size: e.bytes ? e.bytes.length : 0,
        isFile: () => e.type === 'file', isSymbolicLink: () => e.type === 'symlink', isDirectory: () => e.type === 'dir' };
    },
    readFile(p) { const e = fs.get(p); if (!e || e.type !== 'file') throw enoent(); return Buffer.from(e.bytes); },
    exists(p) { return fs.has(p); },
    mkdirp(p) { writes.push(['mkdir', p]); },
    writeExclusive(p, buf, mode) { if (fs.has(p)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); writes.push(['backup', p]); fs.set(p, { type: 'file', bytes: Buffer.from(buf), mode }); },
    writeAtomic(p, text, mode) { writes.push(['write', p]); fs.set(p, { type: 'file', bytes: Buffer.from(text), mode }); },
    now: () => new Date('2026-10-31T12:00:00Z'),
  };
}

const REPO = { command: '/usr/local/bin/node', args: ['/app/mcp/server.js', '--domains-path', '/u/domains'] };
const BUNDLE = { command: '/u/Library/Application Support/The Curator/bin/my-curator-mcp', args: [] };

const CD = `${HOME}/Library/Application Support/Claude/claude_desktop_config.json`;
const CU = `${HOME}/.cursor/mcp.json`;
const AG = `${HOME}/.gemini/config/mcp_config.json`;
const AG2 = `${HOME}/.gemini/antigravity/mcp_config.json`;
const AG3 = `${HOME}/.gemini/antigravity-ide/mcp_config.json`;
const FILE = { 'claude-desktop': CD, cursor: CU, antigravity: AG };
const OTHER = { command: 'npx', args: ['-y', 'other-server'], env: { API_KEY: 'sk-PLANTED-SECRET-123' } };

const ctx = (io, extra = {}) => ({ home: HOME, launch: REPO, launcherState: { required: false, present: true }, detected: true, manifestRows: [], io, ...extra });

try {
  section('§0 — the allow-list agrees with the adapter table');
  {
    const fromTable = A.listHarnesses().filter((id) => {
      const m = A.adapterFor(id)?.mcpConfig;
      return m && m.installer === 'file' && m.verified === true;
    }).sort();
    eq('INSTALL_IDS = the table\'s verified installer:"file" rows', JSON.stringify([...M.INSTALL_IDS].sort()), JSON.stringify(fromTable));
    for (const id of ['claude-code', 'codex', 'gemini-cli', 'opencode', 'zed', 'goose']) ok(`${id} is NOT install-capable`, !M.isInstallCapable(id));
    for (const id of M.INSTALL_IDS) ok(`${id} is install-capable`, M.isInstallCapable(id));
    ok('the user-data dir is the tempdir (isolation)', process.env.CURATOR_TEST_USER_DATA_DIR.startsWith(TMP));
    eq('a process with CURATOR_TEST_USER_DATA_DIR and NO fake home gets NO home (fail closed)', M.installHome(), null);
  }

  section('§1 — targets come from the table, resolved under home');
  {
    const io = memfs();
    eq('Claude Desktop: the macOS path only (never ~/.config/Claude)', JSON.stringify(M.targetsFor('claude-desktop', HOME, io).map((t) => t.file)), JSON.stringify([CD]));
    eq('Cursor: ~/.cursor/mcp.json', JSON.stringify(M.targetsFor('cursor', HOME, io).map((t) => t.file)), JSON.stringify([CU]));
    eq('Antigravity with nothing on disk: the documented file only', JSON.stringify(M.targetsFor('antigravity', HOME, io).map((t) => t.file)), JSON.stringify([AG]));
    const io2 = memfs({ [AG2]: '{}', [AG3]: '{}' });
    const t2 = M.targetsFor('antigravity', HOME, io2);
    eq('Antigravity: the observed files join ONLY when they exist', JSON.stringify(t2.map((t) => t.file)), JSON.stringify([AG, AG2, AG3]));
    ok('...and an observed file may never be created', t2.filter((t) => t.role === 'observed').every((t) => t.createAllowed === false));
    for (const id of M.INSTALL_IDS) for (const t of M.targetsFor(id, HOME, io2)) ok(`${id}: ${t.file} is under the fake home`, M.isUnderHome(HOME, t.file));
    ok('isUnderHome refuses home itself, a sibling, and a ..', !M.isUnderHome(HOME, HOME) && !M.isUnderHome(HOME, '/fakehome/u2/x') && !M.isUnderHome(HOME, `${HOME}/../x`));
    eq('no home → no targets', M.targetsFor('cursor', null, io).length, 0);
  }

  section('§2 — reading one target exactly (readTarget)');
  {
    const cases = [
      ['absent', undefined, 'missing', undefined],
      ['empty (0 bytes)', '', 'ok', undefined],
      ['whitespace only', '  \n', 'ok', undefined],
      ['valid with others', JSON.stringify({ mcpServers: { other: OTHER } }), 'ok', undefined],
      ['corrupt', '{"mcpServers": {', 'cant-read', 'corrupt'],
      ['JSONC with comments', '{\n  // mine\n  "mcpServers": {}\n}\n', 'cant-read', 'jsonc'],
      ['JSONC with a trailing comma', '{"mcpServers": {"a": {"command": "x"},}}', 'cant-read', 'jsonc'],
      ['top-level array', '[1,2]', 'cant-read', 'not_object'],
      ['top-level null', 'null', 'cant-read', 'not_object'],
      ['top-level string', '"x"', 'cant-read', 'not_object'],
      ['mcpServers is an array', '{"mcpServers": []}', 'cant-read', 'servers_not_object'],
      ['mcpServers is a string', '{"mcpServers": "x"}', 'cant-read', 'servers_not_object'],
      ['mcpServers is null', '{"mcpServers": null}', 'cant-read', 'servers_not_object'],
      ['duplicate key (two mcpServers blocks)', '{"mcpServers": {"a": {"command": "x"}}, "mcpServers": {"b": {"command": "y"}}}', 'cant-read', 'duplicate_key'],
      ['duplicate server name', '{"mcpServers": {"a": {"command": "x"}, "a": {"command": "y"}}}', 'cant-read', 'duplicate_key'],
      ['an integer past 2^53', '{"id": 12345678901234567890, "mcpServers": {}}', 'cant-read', 'lossy_number'],
      ['a number that overflows', '{"x": 1e400}', 'cant-read', 'lossy_number'],
      ['ordinary numbers are fine', '{"x": 1.5, "y": -3, "z": 1e3, "w": 0.0001, "v": 100000000000000000000}', 'ok', undefined],
    ];
    for (const [name, text, state, reason] of cases) {
      const io = memfs(text === undefined ? {} : { [CU]: text });
      const r = M.readTarget(CU, 'mcpServers', io);
      ok(`${name} → ${state}${reason ? ` (${reason})` : ''}`, r.state === state && r.reason === reason, `${r.state}/${r.reason}`);
    }
    const sym = M.readTarget(CU, 'mcpServers', memfs({ [CU]: { symlink: true } }));
    ok('a symlink → cant-read (symlink), never followed', sym.state === 'cant-read' && sym.reason === 'symlink');
    const dir = M.readTarget(CU, 'mcpServers', memfs({ [CU]: { dir: true } }));
    ok('a directory → cant-read (not_regular)', dir.state === 'cant-read' && dir.reason === 'not_regular');
    const jc = M.readTarget(CU, 'mcpServers', memfs({ [CU]: '{}' }), true);
    ok('an adapter row marked jsonc → refused even when the text is plain JSON', jc.state === 'cant-read' && jc.reason === 'jsonc');
    const absent = M.readTarget(CU, 'mcpServers', memfs());
    eq('an absent file\'s basis is the word "absent"', absent.sha, 'absent');
    const present = M.readTarget(CU, 'mcpServers', memfs({ [CU]: '{}' }));
    eq('a present file\'s basis is its sha256', present.sha, M.sha256(Buffer.from('{}')));
  }

  section('§3 — format detection and serialisation');
  {
    eq('2 spaces', M.detectFormat('{\n  "a": 1\n}\n').indent, 2);
    eq('4 spaces', M.detectFormat('{\n    "a": 1\n}').indent, 4);
    eq('tab', M.detectFormat('{\n\t"a": 1\n}').indent, '\t');
    eq('one-line file → default 2', M.detectFormat('{"a":1}').indent, 2);
    ok('trailing newline detected', M.detectFormat('{}\n').trailingNewline === true && M.detectFormat('{}').trailingNewline === false);
    eq('CRLF detected', M.detectFormat('{\r\n  "a": 1\r\n}\r\n').eol, '\r\n');
    const s = M.serialise({ a: { b: 1 } }, { indent: 4, eol: '\r\n', trailingNewline: false });
    eq('serialise keeps 4 spaces, CRLF and no trailing newline', s, '{\r\n    "a": {\r\n        "b": 1\r\n    }\r\n}');
  }

  section('§4 — entries: shape from mcpEntryFor, compared after the harness shape');
  {
    const cu = A.mcpEntryFor('cursor', REPO).entry;
    eq('Cursor\'s planned entry carries type "stdio"', cu.type, 'stdio');
    ok('Cursor entry missing type → does NOT match (needs-update)', !M.entryMatches({ command: REPO.command, args: REPO.args }, cu, 'stdio'));
    ok('Cursor entry with type → matches', M.entryMatches({ type: 'stdio', command: REPO.command, args: REPO.args }, cu, 'stdio'));
    const cdB = A.mcpEntryFor('claude-desktop', BUNDLE).entry;
    for (const id of M.INSTALL_IDS) {
      const e = A.mcpEntryFor(id, BUNDLE).entry;
      ok(`${id}: launcher-mode planned entry has args: [] (the write-config shape)`, Array.isArray(e.args) && e.args.length === 0);
    }
    ok('an existing entry WITHOUT args (older hand-pasted shape) still MATCHES — missing ≡ []', M.entryMatches({ command: BUNDLE.command }, cdB, false));
    ok('...and for Cursor too', M.entryMatches({ type: 'stdio', command: BUNDLE.command }, A.mcpEntryFor('cursor', BUNDLE).entry, 'stdio'));
    ok('...and an existing `args: []` (what write-config writes) still MATCHES — no false needs-update', M.entryMatches({ command: BUNDLE.command, args: [] }, cdB, false));
    ok('a repo-mode entry on a bundle install does NOT match', !M.entryMatches({ command: REPO.command, args: REPO.args }, cdB, false));
    ok('another knowledge folder does NOT match', !M.entryMatches({ command: REPO.command, args: ['/app/mcp/server.js', '--domains-path', '/elsewhere'] }, A.mcpEntryFor('claude-desktop', REPO).entry, false));
    ok('an extra env on our entry still matches (not ours to judge)', M.entryMatches({ command: REPO.command, args: REPO.args, env: { X: '1' } }, A.mcpEntryFor('claude-desktop', REPO).entry, false));
    const w = M.entryToWrite({ command: 'old', args: ['x'], env: { CURATOR_MCP_VIA: 'a' } }, A.mcpEntryFor('claude-desktop', REPO).entry);
    ok('an update keeps the user\'s own keys on our entry (env) and names them', w.kept.join() === 'env' && w.entry.env.CURATOR_MCP_VIA === 'a' && w.entry.command === REPO.command);
    ok('...and never keeps a stale managed key (args)', JSON.stringify(w.entry.args) === JSON.stringify(REPO.args));
  }

  section('§5 — the status matrix × three tools');
  {
    for (const id of M.INSTALL_IDS) {
      const f = FILE[id];
      const planned = A.mcpEntryFor(id, REPO).entry;
      const stale = { ...planned, args: ['/old/mcp/server.js', '--domains-path', '/old'] };
      const mk = (text) => M.statusFor(M.inspectTool(id, { home: HOME, launch: REPO, io: memfs(text === undefined ? {} : { [f]: text }) }).files);
      eq(`${id}: absent → not-installed`, mk(undefined), 'not-installed');
      eq(`${id}: empty → not-installed`, mk(''), 'not-installed');
      eq(`${id}: valid with others → not-installed`, mk(JSON.stringify({ mcpServers: { other: OTHER } })), 'not-installed');
      eq(`${id}: already ours → connected`, mk(JSON.stringify({ mcpServers: { other: OTHER, 'my-curator': planned } })), 'connected');
      eq(`${id}: stale ours → needs-update`, mk(JSON.stringify({ mcpServers: { 'my-curator': stale } })), 'needs-update');
      eq(`${id}: corrupt → cant-read`, mk('{"mcpServers": {'), 'cant-read');
      eq(`${id}: JSONC → cant-read`, mk('{ /* c */ "mcpServers": {} }'), 'cant-read');
      eq(`${id}: non-object → cant-read`, mk('[]'), 'cant-read');
      eq(`${id}: symlink → cant-read`, M.statusFor(M.inspectTool(id, { home: HOME, launch: REPO, io: memfs({ [f]: { symlink: true } }) }).files), 'cant-read');
    }
    const planned = A.mcpEntryFor('antigravity', REPO).entry;
    const both = memfs({ [AG]: JSON.stringify({ mcpServers: { 'my-curator': planned } }), [AG2]: JSON.stringify({ mcpServers: {} }) });
    eq('Antigravity: ours in one file, missing from an observed one → needs-update', M.statusFor(M.inspectTool('antigravity', { home: HOME, launch: REPO, io: both }).files), 'needs-update');
    const all = memfs({ [AG]: JSON.stringify({ mcpServers: { 'my-curator': planned } }), [AG2]: JSON.stringify({ mcpServers: { 'my-curator': planned } }) });
    eq('Antigravity: ours in every existing file → connected', M.statusFor(M.inspectTool('antigravity', { home: HOME, launch: REPO, io: all }).files), 'connected');
    const bundleOnRepo = memfs({ [CD]: JSON.stringify({ mcpServers: { 'my-curator': { command: BUNDLE.command, args: [] } } }) });
    eq('a bundle entry while running from a checkout → needs-update', M.statusFor(M.inspectTool('claude-desktop', { home: HOME, launch: REPO, io: bundleOnRepo }).files), 'needs-update');
  }

  section('§6 — the planner (install)');
  {
    const before = JSON.stringify({ globalShortcut: 'x', mcpServers: { other: OTHER, zeta: { command: 'z' } } }, null, 4) + '\n';
    const io = memfs({ [CU]: before });
    const [it] = M.planTool('cursor', 'install', ctx(io));
    eq('valid file → action add', it.action, 'add');
    eq('basis = sha256 of the bytes on disk', it.basis, M.sha256(Buffer.from(before)));
    eq('preserved = the OTHER servers\' names', it.preserved.join(','), 'other,zeta');
    ok('entryText is OUR entry only (no other server, no other value)', !it.entryText.includes('sk-PLANTED') && !it.entryText.includes('other-server') && JSON.parse(it.entryText).command === REPO.command);
    ok('the public item never carries another server\'s value', !JSON.stringify(M.publicItem(it)).includes('sk-PLANTED'));
    ok('the public item carries the ~ display path, not the absolute one', M.publicItem(it).file === '~/.cursor/mcp.json' && !JSON.stringify(M.publicItem(it)).includes(HOME));
    ok('the public item drops executor-only fields', Object.keys(M.publicItem(it)).every((k) => !k.startsWith('_')));
    eq('backupWillBe names a NEW sibling copy, stamped at apply (never a predicted stamp)', it.backupWillBe, `~/.cursor/mcp.json.curator-backup-${M.BACKUP_AT_APPLY}`);
    const next = JSON.parse(it._nextText);
    ok('next document: other servers byte-for-byte equal as values', JSON.stringify(next.mcpServers.other) === JSON.stringify(OTHER) && next.globalShortcut === 'x');
    ok('next text keeps 4-space indent and the trailing newline', it._nextText.startsWith('{\n    "globalShortcut"') && it._nextText.endsWith('}\n'));
    ok('key order kept: our entry appended last', Object.keys(next.mcpServers).join() === 'other,zeta,my-curator');
    eq('the planner wrote nothing', io.writes.length, 0);

    const planned = A.mcpEntryFor('cursor', REPO).entry;
    const io2 = memfs({ [CU]: JSON.stringify({ mcpServers: { 'my-curator': planned } }) });
    const [same] = M.planTool('cursor', 'install', ctx(io2));
    ok('already ours → action none (idempotent: no backup planned)', same.action === 'none' && !same._backup && !same._nextText);

    const [miss] = M.planTool('cursor', 'install', ctx(memfs()));
    ok('absent + detected → add, created fresh, no backup', miss.action === 'add' && miss._create === true && miss.backupWillBe === null && miss.basis === 'absent');
    const [nd] = M.planTool('cursor', 'install', ctx(memfs(), { detected: false }));
    ok('absent + NOT detected → refused not_detected (never create a file for a tool that is not here)', nd.refused && nd.refused.reason === 'not_detected');

    const items = M.planTool('antigravity', 'install', ctx(memfs({ [AG2]: '{"mcpServers":{}}' })));
    ok('Antigravity: the documented file is created and the existing observed one updated', items.length === 2 && items[0].action === 'add' && items[0]._create && items[1].action === 'add' && !items[1]._create);

    for (const [name, text, reason] of [['corrupt', '{', 'corrupt'], ['JSONC', '{//x\n}', 'jsonc'], ['non-object', '1', 'not_object'], ['symlink', { symlink: true }, 'symlink']]) {
      const [r] = M.planTool('cursor', 'install', ctx(memfs({ [CU]: text })));
      ok(`${name} → refused ${reason}, with a sentence`, r.refused && r.refused.reason === reason && typeof r.refused.message === 'string' && r.refused.message.length > 10);
    }
    const [lm] = M.planTool('cursor', 'install', ctx(memfs({ [CU]: '{}' }), { launch: BUNDLE, launcherState: { required: true, present: false, message: 'Launcher gone.' } }));
    ok('bundle launch with a missing launcher → refused launcher_missing', lm.refused && lm.refused.reason === 'launcher_missing');
    const [nh] = M.planTool('cursor', 'install', ctx(memfs(), { home: null }));
    ok('no home → refused no_home', nh.refused && nh.refused.reason === 'no_home');
    const [ni] = M.planTool('claude-code', 'install', ctx(memfs()));
    ok('a cli row → refused not_installable', ni.refused && ni.refused.reason === 'not_installable');

    const [cdB] = M.planTool('claude-desktop', 'install', ctx(memfs({ [CD]: '{}' }), { launch: BUNDLE }));
    ok('bundle launch: the entry is the launcher with args: []', JSON.parse(cdB.entryText).command === BUNDLE.command && JSON.stringify(JSON.parse(cdB.entryText).args) === '[]');
    const [cdR] = M.planTool('claude-desktop', 'install', ctx(memfs({ [CD]: '{}' })));
    ok('repo launch: node + server.js + --domains-path', JSON.stringify(JSON.parse(cdR.entryText).args) === JSON.stringify(REPO.args));

    const [kept] = M.planTool('cursor', 'install', ctx(memfs({ [CU]: JSON.stringify({ mcpServers: { 'my-curator': { command: 'old', env: { SECRET: 'sk-OURS-SECRET' } } } }) })));
    ok('update keeps our entry\'s env, names it in `kept`, and does not echo its value', kept.action === 'update' && kept.kept.join() === 'env' && !kept.entryText.includes('sk-OURS-SECRET'));
  }

  section('§7 — the structural check bites');
  {
    const before = { a: 1, mcpServers: { other: OTHER } };
    const entry = { command: 'x' };
    const good = M.nextDocument(before, 'mcpServers', entry);
    ok('our own next document passes', M.structureOk(before, good, 'mcpServers', entry));
    const touched = JSON.parse(JSON.stringify(good)); touched.mcpServers.other.env.API_KEY = 'changed';
    ok('a changed OTHER server fails', !M.structureOk(before, touched, 'mcpServers', entry));
    const dropped = JSON.parse(JSON.stringify(good)); delete dropped.mcpServers.other;
    ok('a dropped OTHER server fails', !M.structureOk(before, dropped, 'mcpServers', entry));
    const topk = JSON.parse(JSON.stringify(good)); topk.b = 2;
    ok('an added top-level key fails', !M.structureOk(before, topk, 'mcpServers', entry));
    const wrong = M.nextDocument(before, 'mcpServers', { command: 'y' });
    ok('our key holding something other than planned fails', !M.structureOk(before, wrong, 'mcpServers', entry));
    const rm = M.nextDocument({ mcpServers: { other: OTHER, 'my-curator': entry } }, 'mcpServers', null);
    ok('a remove leaves the others and drops only ours', M.structureOk({ mcpServers: { other: OTHER, 'my-curator': entry } }, rm, 'mcpServers', null) && rm.mcpServers.other);
    ok('a "remove" that left ours in place fails', !M.structureOk(before, good, 'mcpServers', null));
    ok('nextDocument never mutates its input', JSON.stringify(before) === JSON.stringify({ a: 1, mcpServers: { other: OTHER } }));
  }

  section('§8 — remove and restore plans');
  {
    const planned = A.mcpEntryFor('cursor', REPO).entry;
    const text = JSON.stringify({ mcpServers: { other: OTHER, 'my-curator': planned } }, null, 2);
    const [rm] = M.planTool('cursor', 'remove', ctx(memfs({ [CU]: text })));
    ok('remove → action remove, backup planned, others preserved', rm.action === 'remove' && rm.backupWillBe && rm.preserved.join() === 'other' && !JSON.parse(rm._nextText).mcpServers['my-curator']);
    ok('remove keeps "no trailing newline" when the file had none', !rm._nextText.endsWith('\n'));
    const [rn] = M.planTool('cursor', 'remove', ctx(memfs({ [CU]: '{"mcpServers":{}}' })));
    eq('remove with no entry → none', rn.action, 'none');

    const orig = Buffer.from('{"mcpServers":{"other":{"command":"x"}}}');
    const after = Buffer.from('{"mcpServers":{"other":{"command":"x"},"my-curator":{"command":"y"}}}');
    const bk = `${CU}.curator-backup-20261030T000000Z`;
    const row = { at: '2026-10-30T00:00:00Z', harness: 'cursor', file: CU, action: 'install', shaBefore: M.sha256(orig), shaAfter: M.sha256(after), backup: bk };
    const io = memfs({ [CU]: after.toString(), [bk]: orig.toString() });
    const [rs] = M.planTool('cursor', 'restore', ctx(io, { manifestRows: [row] }));
    ok('restore offered while the file is exactly what we left', rs.action === 'restore' && rs._restoreFrom === bk);
    const pub = M.publicItem(rs);
    eq('restoreFrom = the display path of the SOURCE backup', pub.restoreFrom, '~/.cursor/mcp.json.curator-backup-20261030T000000Z');
    eq('restoreFromAt = that manifest row\'s `at`', pub.restoreFromAt, '2026-10-30T00:00:00Z');
    ok('backupWillBe !== restoreFrom (the new copy is never the copy being restored from)', pub.backupWillBe && pub.backupWillBe !== pub.restoreFrom, `${pub.backupWillBe} vs ${pub.restoreFrom}`);
    ok('...and it is the new-copy pattern', pub.backupWillBe === `~/.cursor/mcp.json.curator-backup-${M.BACKUP_AT_APPLY}`);
    ok('the old field name restoreAt is gone', !('restoreAt' in pub));
    const io2 = memfs({ [CU]: after.toString() + ' ', [bk]: orig.toString() });
    const [rs2] = M.planTool('cursor', 'restore', ctx(io2, { manifestRows: [row] }));
    ok('restore refused changed_since after a later edit', rs2.refused && rs2.refused.reason === 'changed_since');
    const io3 = memfs({ [CU]: after.toString(), [bk]: 'tampered' });
    const [rs3] = M.planTool('cursor', 'restore', ctx(io3, { manifestRows: [row] }));
    ok('restore refused backup_mismatch when the backup bytes changed', rs3.refused && rs3.refused.reason === 'backup_mismatch');
    const io4 = memfs({ [CU]: after.toString() });
    const [rs4] = M.planTool('cursor', 'restore', ctx(io4, { manifestRows: [row] }));
    ok('restore refused backup_missing when the backup is gone', rs4.refused && rs4.refused.reason === 'backup_missing');
    const evil = { ...row, backup: '/etc/passwd' };
    const [rs5] = M.planTool('cursor', 'restore', ctx(memfs({ [CU]: after.toString() }), { manifestRows: [evil] }));
    ok('a manifest row naming a backup outside the file\'s folder is refused (never read)', rs5.refused && rs5.refused.reason === 'backup_missing');
    const created = { ...row, shaBefore: null, backup: null };
    const [rs6] = M.planTool('cursor', 'restore', ctx(memfs({ [CU]: after.toString() }), { manifestRows: [created] }));
    ok('a file we CREATED has nothing to restore (never deleted)', rs6.refused && rs6.refused.reason === 'no_backup');
    const restoredRow = { ...row, action: 'restore', shaBefore: row.shaAfter, shaAfter: row.shaBefore, backup: `${CU}.curator-backup-x` };
    const c = M.restoreCandidate([row, restoredRow], 'cursor', CU, M.sha256(orig));
    ok('after a restore, the original install row is no longer eligible', !c.eligible);
  }

  section('§9 — the manifest is capped and 0600 (memfs)');
  {
    const io = memfs();
    const mf = `${HOME}/ud/.mcp-installs.json`;
    for (let i = 0; i < M.MANIFEST_CAP + 5; i++) M.appendManifestRow({ at: String(i), harness: 'cursor', file: CU, action: 'install' }, io, mf);
    const rows = JSON.parse(io.fs.get(mf).bytes.toString()).rows;
    ok(`capped at the newest ${M.MANIFEST_CAP}`, rows.length === M.MANIFEST_CAP && rows[0].at === '5' && rows.at(-1).at === String(M.MANIFEST_CAP + 4));
    eq('written 0600', io.fs.get(mf).mode, 0o600);
  }
} finally {
  const moved = changedSince(REAL_BEFORE);
  ok('the REAL user\'s config files are byte-identical before and after', moved.length === 0, moved.join(', '));
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
