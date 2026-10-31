#!/usr/bin/env node
/**
 * test-mcp-install-write.js — OFFLINE. The EXECUTOR of v3.85.0's installer
 * (src/brain/mcp-install.js) against a REAL filesystem inside a scratch FAKE
 * HOME, plus injected IO for the failures a real disk will not produce on cue.
 *
 * What it proves, each with the arm that would fail without the rule:
 *   - BACKUP FIRST: a backup write that throws leaves the original
 *     byte-identical and no partial file behind;
 *   - the backup is the ORIGINAL BYTES, 0600, beside the file;
 *   - MODE KEPT (0644 stays 0644, 0640 stays 0640); a NEW file is 0600;
 *   - COMPARE-AND-SWAP: an edit between plan and apply, and an edit between
 *     the backup and the replace, are both refused `config_changed` and the
 *     edited bytes survive;
 *   - the STRUCTURAL CHECK runs again in the executor (a tampered plan is
 *     refused `structure_changed`, file byte-identical);
 *   - IDEMPOTENT: a second install writes nothing, takes no backup, adds no
 *     manifest row;
 *   - a symlink is refused and neither the link nor its target changes;
 *   - Remove, Restore, and Restore refused after a later edit;
 *   - indent and the trailing-newline state survive a real write;
 *   - the manifest lives in user data (never domains/), 0600.
 *
 * ISOLATION: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR + a fake
 * HOME via `__setHomeOverride`, all inside one tempdir; the REAL config files
 * are fingerprinted before and after.
 */
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
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
const TMP = realpathSync(mkdtempSync(path.join(tmpdir(), 'curator-mcpinst-write-')));
const HOME = path.join(TMP, 'home');
const UD = path.join(TMP, 'ud');
const DOM = path.join(TMP, 'domains');
for (const d of [HOME, UD, DOM]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = UD;
process.env.CURATOR_TEST_DOMAINS_DIR = DOM;

const M = await import('../src/brain/mcp-install.js');
const A = await import('../src/brain/harness-adapters.js');
const { getMcpInstallManifestPath } = await import('../src/brain/paths.js');
M.__setHomeOverride(HOME);

const REPO = { command: '/usr/local/bin/node', args: ['/app/mcp/server.js', '--domains-path', DOM] };
const CU = path.join(HOME, '.cursor', 'mcp.json');
const CD = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const AG = path.join(HOME, '.gemini', 'config', 'mcp_config.json');
const AG2 = path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json');
const OTHER = { command: 'npx', args: ['-y', 'other'], env: { API_KEY: 'sk-PLANTED' } };

const io = () => M.defaultIO();
const bytes = (p) => readFileSync(p);
const modeOf = (p) => statSync(p).mode & 0o777;
const backupsOf = (f) => (existsSync(path.dirname(f)) ? readdirSync(path.dirname(f)).filter((n) => n.startsWith(`${path.basename(f)}.curator-backup-`)) : []);
const manifestRows = () => M.readManifest(io()).rows;
function put(p, text, mode = 0o644) { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); chmodSync(p, mode); }
function plan(id, action, extra = {}) {
  return M.planTool(id, action, { home: HOME, launch: REPO, launcherState: { required: false, present: true }, detected: true, manifestRows: manifestRows(), io: io(), ...extra });
}
const run = (it, theIO = io()) => M.executeItem(it, { home: HOME, io: theIO });
let clock = Date.parse('2026-10-31T10:00:00Z');
const ticking = (base = io()) => ({ ...base, now: () => new Date((clock += 1000)) });

try {
  section('§0 — isolation');
  eq('installHome() is the fake home', M.installHome(), HOME);
  ok('the manifest resolves inside user data, never domains/', getMcpInstallManifestPath().startsWith(UD + path.sep) && !getMcpInstallManifestPath().startsWith(DOM));
  for (const id of M.INSTALL_IDS) for (const t of M.targetsFor(id, HOME, io())) ok(`${id} target under the fake HOME: ${path.relative(TMP, t.file)}`, M.isUnderHome(HOME, t.file));

  section('§1 — install into a file with other servers: backup first, only our key');
  {
    const original = JSON.stringify({ theme: 'dark', mcpServers: { other: OTHER } }, null, 4);
    put(CU, original, 0o644);
    const [it] = M.planTool('cursor', 'install', { home: HOME, launch: REPO, detected: true, manifestRows: [], io: ticking() });
    const r = run(it);
    eq('outcome written', r.outcome, 'written');
    const after = JSON.parse(bytes(CU).toString());
    ok('the other server and top-level key are unchanged', JSON.stringify(after.mcpServers.other) === JSON.stringify(OTHER) && after.theme === 'dark');
    ok('our entry is the planned one (with Cursor\'s type)', JSON.stringify(after.mcpServers['my-curator']) === JSON.stringify(A.mcpEntryFor('cursor', REPO).entry));
    const bks = backupsOf(CU);
    eq('exactly one backup beside the file', bks.length, 1);
    const bk = path.join(path.dirname(CU), bks[0]);
    eq('the backup holds the ORIGINAL bytes', bytes(bk).toString(), original);
    eq('the backup is 0600', modeOf(bk), 0o600);
    eq('the file keeps its mode 0644', modeOf(CU), 0o644);
    ok('4-space indent kept, no trailing newline added', bytes(CU).toString().startsWith('{\n    "theme"') && !bytes(CU).toString().endsWith('\n'));
    const rows = manifestRows();
    ok('one manifest row with shaBefore/shaAfter/backup', rows.length === 1 && rows[0].action === 'install' && rows[0].shaBefore === M.sha256(Buffer.from(original)) && rows[0].shaAfter === M.sha256(bytes(CU)) && rows[0].backup === bk);
    eq('the manifest is 0600', modeOf(getMcpInstallManifestPath()), 0o600);

    section('§2 — idempotent');
    const [again] = plan('cursor', 'install');
    const r2 = run(again);
    ok('second install → unchanged', r2.outcome === 'unchanged' && again.action === 'none');
    eq('...no second backup', backupsOf(CU).length, 1);
    eq('...no second manifest row', manifestRows().length, 1);
  }

  section('§2b — two writes in the same second never overwrite a backup');
  {
    const frozen = { ...io(), now: () => new Date('2026-10-31T11:11:11Z') };
    const f = path.join(HOME, '.cursor', 'mcp.json');
    put(f, '{"mcpServers":{}}', 0o644);
    const n0 = backupsOf(f).length;
    const r1 = run(M.planTool('cursor', 'remove', { home: HOME, launch: REPO, detected: true, manifestRows: [], io: frozen })[0], frozen);
    const r2 = run(M.planTool('cursor', 'install', { home: HOME, launch: REPO, detected: true, manifestRows: [], io: frozen })[0], frozen);
    const r3 = run(M.planTool('cursor', 'remove', { home: HOME, launch: REPO, detected: true, manifestRows: [], io: frozen })[0], frozen);
    ok('install then remove in one second both write', r2.outcome === 'written' && r3.outcome === 'written', JSON.stringify([r1, r2, r3]));
    ok('...each kept its own backup (the second is suffixed -2)', backupsOf(f).length === n0 + 2 && /-2$/.test(r3.backup || ''), JSON.stringify(backupsOf(f)));
  }

  section('§3 — BACKUP FIRST: a backup that throws replaces nothing');
  {
    const original = JSON.stringify({ mcpServers: { other: OTHER } }, null, 2) + '\n';
    put(CD, original, 0o640);
    const [it] = plan('claude-desktop', 'install');
    let wrote = 0;
    const failing = { ...io(), writeExclusive: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }, writeAtomic: () => { wrote++; } };
    const r = run(it, failing);
    ok('refused backup_failed', r.outcome === 'refused' && r.reason === 'backup_failed', JSON.stringify(r));
    eq('the target was never written', wrote, 0);
    eq('the original is byte-identical', bytes(CD).toString(), original);
    eq('no backup and no temp file beside it', readdirSync(path.dirname(CD)).length, 1);

    const r3 = run(plan('claude-desktop', 'install')[0]);
    eq('a real run then writes', r3.outcome, 'written');
    eq('the 0640 mode is kept', modeOf(CD), 0o640);
    ok('the trailing newline is kept', bytes(CD).toString().endsWith('}\n'));
  }

  section('§4 — COMPARE-AND-SWAP');
  {
    put(AG, JSON.stringify({ mcpServers: {} }), 0o644);
    const [it] = plan('antigravity', 'install');
    put(AG, JSON.stringify({ mcpServers: { userAddedLater: { command: 'x' } } }), 0o644);
    const edited = bytes(AG).toString();
    const r = run(it);
    ok('an edit between plan and apply → config_changed', r.outcome === 'refused' && r.reason === 'config_changed');
    eq('the user\'s edit survives byte-for-byte', bytes(AG).toString(), edited);
    eq('no backup was taken', backupsOf(AG).length, 0);

    const [it2] = plan('antigravity', 'install');
    const racing = { ...io(), writeExclusive: (p, b, m) => { io().writeExclusive(p, b, m); writeFileSync(AG, '{"mcpServers":{"raced":{"command":"r"}}}'); } };
    let replaced = false;
    racing.writeAtomic = () => { replaced = true; };
    const r2 = run(it2, racing);
    ok('an edit between the backup and the replace → config_changed', r2.outcome === 'refused' && r2.reason === 'config_changed');
    ok('...the replace never ran and the raced bytes survive', !replaced && bytes(AG).toString().includes('raced'));
  }

  section('§5 — the executor re-runs the structural check');
  {
    put(CU, JSON.stringify({ mcpServers: { other: OTHER } }), 0o644);
    const before = bytes(CU).toString();
    const [it] = plan('cursor', 'install');
    const tampered = { ...it, _nextText: JSON.stringify({ mcpServers: { 'my-curator': it._entry } }) };
    const r = run(tampered);
    ok('a plan whose text drops another server → structure_changed', r.outcome === 'refused' && r.reason === 'structure_changed');
    eq('file byte-identical', bytes(CU).toString(), before);
  }

  section('§6 — refusals leave the file byte-identical (real disk)');
  {
    const cases = [['corrupt', '{"mcpServers": {'], ['JSONC', '{\n // keep me\n "mcpServers": {}\n}\n'], ['non-object', '[1]'], ['duplicate key', '{"mcpServers":{"a":{"command":"x"}},"mcpServers":{}}']];
    for (const [name, text] of cases) {
      put(CU, text, 0o644);
      const nb = backupsOf(CU).length;
      const [it] = plan('cursor', 'install');
      const r = run(it);
      ok(`${name}: refused and byte-identical, no backup`, r.outcome === 'refused' && bytes(CU).toString() === text && backupsOf(CU).length === nb);
    }
    const target = path.join(TMP, 'elsewhere.json');
    writeFileSync(target, '{"mcpServers":{}}');
    rmSync(CU);
    symlinkSync(target, CU);
    const [it] = plan('cursor', 'install');
    const r = run(it);
    ok('a symlinked config is refused (symlink)', r.outcome === 'refused' && r.reason === 'symlink');
    ok('...the link is still a link and its target untouched', lstatSync(CU).isSymbolicLink() && readFileSync(target, 'utf8') === '{"mcpServers":{}}');
    rmSync(CU);
  }

  section('§7 — creating a missing file for a detected tool: 0600, parent made');
  {
    const fresh = path.join(HOME, '.gemini', 'config');
    rmSync(fresh, { recursive: true, force: true });
    const [it] = plan('antigravity', 'install');
    const r = run(it);
    eq('created', r.outcome, 'created');
    eq('a new file is 0600', modeOf(AG), 0o600);
    ok('2-space JSON with a trailing newline', bytes(AG).toString().startsWith('{\n  "mcpServers"') && bytes(AG).toString().endsWith('}\n'));
    const row = manifestRows().at(-1);
    ok('manifest row: shaBefore null, backup null', row.shaBefore === null && row.backup === null && row.action === 'install');
    const [nd] = M.planTool('cursor', 'install', { home: HOME, launch: REPO, detected: false, manifestRows: [], io: io() });
    ok('an undetected tool\'s missing file is NOT created', nd.refused && nd.refused.reason === 'not_detected' && !existsSync(CU));
    ok('an observed Antigravity file that does not exist is never created', !existsSync(AG2));
  }

  section('§8 — Remove, Restore, and Restore refused after a later edit');
  {
    const original = '{\n\t"mcpServers": {\n\t\t"other": {\n\t\t\t"command": "o"\n\t\t}\n\t}\n}\n';
    put(CU, original, 0o644);
    const r1 = run(M.planTool('cursor', 'install', { home: HOME, launch: REPO, detected: true, manifestRows: manifestRows(), io: ticking() })[0]);
    eq('install written', r1.outcome, 'written');
    ok('tab indent kept', bytes(CU).toString().includes('\n\t"mcpServers"'));
    const [rs] = M.planTool('cursor', 'restore', { home: HOME, launch: REPO, detected: true, manifestRows: manifestRows(), io: ticking() });
    eq('restore is offered', rs.action, 'restore');
    const r2 = run(rs);
    eq('restore written', r2.outcome, 'written');
    eq('the ORIGINAL bytes are back', bytes(CU).toString(), original);
    ok('restore itself kept a backup of what it replaced', r2.backup && backupsOf(CU).length >= 2);
    ok('...a NEW copy, not the one it restored from (the preview\'s backupWillBe !== restoreFrom too)', r2.backup !== rs.restoreFrom && rs.backupWillBe !== rs.restoreFrom, `${r2.backup} / ${rs.restoreFrom} / ${rs.backupWillBe}`);
    const [again] = plan('cursor', 'restore');
    ok('a second restore is not offered', again.action === 'none' || (again.refused && again.refused.reason === 'changed_since'));

    run(M.planTool('cursor', 'install', { home: HOME, launch: REPO, detected: true, manifestRows: manifestRows(), io: ticking() })[0]);
    const [rm] = M.planTool('cursor', 'remove', { home: HOME, launch: REPO, detected: true, manifestRows: manifestRows(), io: ticking() });
    const r3 = run(rm);
    const afterRm = JSON.parse(bytes(CU).toString());
    ok('remove: only our key is gone, the other stays', r3.outcome === 'written' && !afterRm.mcpServers['my-curator'] && afterRm.mcpServers.other.command === 'o');

    run(M.planTool('cursor', 'install', { home: HOME, launch: REPO, detected: true, manifestRows: manifestRows(), io: ticking() })[0]);
    const edited = bytes(CU).toString().replace('"o"', '"o2"');
    writeFileSync(CU, edited);
    const [late] = plan('cursor', 'restore');
    ok('restore after a later edit → changed_since ("Remove the entry instead")', late.refused && late.refused.reason === 'changed_since' && /Remove the entry instead/.test(late.refused.message));
    eq('...and the edited file is untouched', bytes(CU).toString(), edited);
  }

  section('§9 — outside home is refused even with a forged item');
  {
    const victim = path.join(TMP, 'victim.json');
    writeFileSync(victim, '{}');
    const [it] = plan('cursor', 'remove');
    ok('(the forged item starts from a real writing plan)', it.action === 'remove');
    const forged = { ...it, file: victim, basis: M.sha256(Buffer.from('{}')) };
    const r = run(forged);
    ok('refused outside_home, victim untouched', r.outcome === 'refused' && r.reason === 'outside_home' && readFileSync(victim, 'utf8') === '{}');
  }
} finally {
  M.__setHomeOverride(null);
  const moved = changedSince(REAL_BEFORE);
  ok('the REAL user\'s config files are byte-identical before and after', moved.length === 0, moved.join(', '));
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
