#!/usr/bin/env node
/**
 * v4.1.2, candidate audit N5. A damaged `.curator-config.json` or
 * `.sharedbrain-config.json` is kept beside itself as
 * `<file>.unreadable-<sha:12>` (src/brain/config.js keepDamagedCopy), a BYTE
 * copy, so it holds the same API keys and GitHub tokens. The standing rule for
 * credential files applies to it:
 *
 *   §1  getCredentialFiles() lists every kept copy that exists (and nothing
 *       else new), so the startup 0600 sweep and System Check cover it.
 *   §2  the real startup sweep (src/server.js, spawned) makes a 0644 copy 0600.
 *   §3  isCredentialPath() answers true for both names, at any depth.
 *   §4  Personal Sync never pushes one: a knowledge folder holding a copy (the
 *       folder IS the user-data folder, audit O5) is connected and synced to a
 *       local bare repository, and the copy never reaches it.
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR, a fake HOME
 * and CURATOR_NO_OPEN are set before any app module is imported; sync's git dir
 * and config file go through __setSyncTestOverrides. No network.
 */

import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import net from 'net';
import { spawn, execFileSync } from 'child_process';
import { createHash } from 'crypto';

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-n5-'));
const USER = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const HOME = path.join(TMP, 'home');
for (const d of [USER, DOMAINS, HOME]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_NO_OPEN = '1';
process.env.HOME = HOME;
delete process.env.DOMAINS_PATH;

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const REAL = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json'].map((f) => path.join(ROOT, f));
const fingerprint = () => REAL.map((f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent')).join('|');
const FP = fingerprint();

const paths = await import('../src/brain/paths.js');
const safety = await import('../src/brain/sync-safety.js');
const sync = await import('../src/brain/sync.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}
const section = (t) => console.log(`\n${t}\n`);
const mode = (f) => statSync(f).mode & 0o777;

const CFG_COPY = '.curator-config.json.unreadable-0123456789ab';
const SBC_COPY = '.sharedbrain-config.json.unreadable-ba9876543210';
const DECOYS = ['.mcp-installs.json.unreadable-0123456789ab', 'notes.unreadable-x', '.curator-config.json.bak'];
const SECRET = 'sk-ant-api03-' + 'Q'.repeat(40);

// ═══════════════════════════════════════════════════════════════════════════
section('§1 getCredentialFiles() lists the kept copies');
// ═══════════════════════════════════════════════════════════════════════════
const fixed = paths.getCredentialFiles().map((c) => c.rel);
ok(!fixed.some((r) => r.includes('.unreadable-')), 'with no copy on disk, the list holds only the fixed entries', fixed);
for (const n of [CFG_COPY, SBC_COPY, ...DECOYS]) writeFileSync(path.join(USER, n), `{"apiKeys":{"anthropic":"${SECRET}"}`, { mode: 0o644 });
const listed = paths.getCredentialFiles();
const rels = listed.map((c) => c.rel);
ok(rels.includes(CFG_COPY), 'the .curator-config.json copy is listed', rels);
ok(rels.includes(SBC_COPY), 'the .sharedbrain-config.json copy is listed', rels);
ok(DECOYS.every((d) => !rels.includes(d)), 'and no other file is', rels);
ok(JSON.stringify(rels.slice(0, fixed.length)) === JSON.stringify(fixed), 'the fixed entries come first, unchanged');
ok((listed.find((c) => c.rel === CFG_COPY) || {}).abs === path.join(USER, CFG_COPY), 'with its absolute path in the user-data folder');

// ═══════════════════════════════════════════════════════════════════════════
section('§2 the real startup sweep makes a kept copy 0600');
// ═══════════════════════════════════════════════════════════════════════════
if (process.platform === 'win32') {
  console.log('  (skipped on Windows: POSIX modes are not enforced)');
} else {
  ok(mode(path.join(USER, CFG_COPY)) === 0o644, 'precondition: the copy is 0644');
  const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    env: { ...process.env, PORT: String(port), CURATOR_TEST_USER_DATA_DIR: USER, CURATOR_TEST_DOMAINS_DIR: DOMAINS, HOME, CURATOR_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { up = (await fetch(`http://127.0.0.1:${port}/api/config/settings-files`)).ok; } catch { /* not yet */ }
  }
  ok(up, 'the server started on the isolated user-data folder');
  ok(mode(path.join(USER, CFG_COPY)) === 0o600, 'the .curator-config.json copy is now 0600', mode(path.join(USER, CFG_COPY)).toString(8));
  ok(mode(path.join(USER, SBC_COPY)) === 0o600, 'the .sharedbrain-config.json copy is now 0600', mode(path.join(USER, SBC_COPY)).toString(8));
  ok(mode(path.join(USER, 'notes.unreadable-x')) === 0o644, 'control: an unrelated file is left at its mode');
  child.kill('SIGTERM');
  await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); });
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 isCredentialPath() answers true for both copies');
// ═══════════════════════════════════════════════════════════════════════════
for (const p of [CFG_COPY, SBC_COPY, `sub/${CFG_COPY}`, '.curator-config.json.unreadable-x', '.SharedBrain-Config.json.unreadable-0']) {
  ok(safety.isCredentialPath(p), `credential by name: ${p}`);
}
for (const p of ['notes.unreadable-x', 'wiki/entities/curator-config.md', '.mcp-installs.json.unreadable-0123456789ab', 'unreadable-pages/x.md']) {
  ok(!safety.isCredentialPath(p), `not a credential: ${p}`);
}
ok(!safety.CREDENTIAL_GITIGNORE_RULES.some((r) => r.includes('unreadable')),
  'the generated .gitignore rules are unchanged (no rewrite of every connected install\'s .gitignore)');

// ═══════════════════════════════════════════════════════════════════════════
section('§4 Personal Sync never pushes a kept copy');
// ═══════════════════════════════════════════════════════════════════════════
{
  const remote = path.join(TMP, 'r.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]);
  const folder = path.join(TMP, 'knowledge');   // stands for "the knowledge folder IS the user-data folder"
  mkdirSync(path.join(folder, 'alpha/wiki'), { recursive: true });
  writeFileSync(path.join(folder, 'alpha/wiki/index.md'), '# alpha\n');
  writeFileSync(path.join(folder, CFG_COPY), `{"apiKeys":{"anthropic":"${SECRET}"}`);
  writeFileSync(path.join(folder, 'alpha', SBC_COPY), '{"connections":[{"pat":"ghp_' + 'Z'.repeat(36) + '"}');
  sync.__setSyncTestOverrides({ gitDir: path.join(TMP, 'k.git'), configFile: path.join(TMP, 'sync.json') });
  __setDomainsDirOverride(folder);
  await sync.setup(`file://${remote}`, 't', 'push');
  writeFileSync(path.join(folder, 'alpha/wiki/more.md'), 'more\n');
  writeFileSync(path.join(folder, CFG_COPY), `{"apiKeys":{"anthropic":"${SECRET}x"}`);
  await sync.sync();
  const files = execFileSync('git', ['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main']).toString().split('\n').filter(Boolean);
  ok(files.includes('alpha/wiki/index.md') && files.includes('alpha/wiki/more.md'), 'precondition: the wiki reached the remote', files);
  ok(!files.some((f) => f.includes('.unreadable-')), 'no kept copy reached the remote, at the root or in a domain', files);
  const all = execFileSync('git', ['--git-dir', remote, 'log', '--all', '-p']).toString();
  ok(!all.includes(SECRET), 'and the key is in no commit of the remote');
  sync.__setSyncTestOverrides({});
  __setDomainsDirOverride(null);
}

ok(fingerprint() === FP, '§Z the real credential files are unchanged');
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:\n' + failures.map((f) => '  - ' + f).join('\n')); process.exit(1); }
