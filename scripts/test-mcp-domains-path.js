#!/usr/bin/env node
/**
 * MCP `--domains-path`: reads and writes must resolve ONE folder.
 *
 * OFFLINE. No network, no API key, no LLM call. Deterministic. ~2s.
 *
 * ── THE DEFECT THIS GUARDS (v3.16.2) ────────────────────────────────────────
 * The MCP server is launched as `node mcp/server.js --domains-path <X>`; the
 * generated Claude Desktop config always passes it. MCP READS honoured it —
 * mcp/storage/local.js ranks it at rung 2. MCP WRITES did not: the write tools
 * import writePage/wikiPath/domainPath from src/brain/files.js, which resolve
 * through getDomainsDir() in src/brain/config.js, and that function had NO rung
 * for the arg at all. One process, two trees.
 *
 * Measured before the fix, with `--domains-path X` and a stored domainsPath of
 * Y: compile_to_wiki returned `ok: true` with a summary_path, the page landed
 * in Y, .mcp-write-log.jsonl landed in X (the audit log goes through the read
 * adapter), and a follow-up get_node on the path just returned said NOT FOUND.
 *
 * ── WHY IT SURVIVED test-paths.js ───────────────────────────────────────────
 * test-paths.js §9 checks four cases. Cases (a), (b) and (c) each assert the
 * adapter's answer AND add a companion "config.js agrees" assertion. Case (d) —
 * the CLI-arg case, the only one where they disagreed — has the adapter half
 * and NO companion. The hole is visible in the shape of the file. §2 below is
 * that missing companion, and §3 drives the real write path rather than the
 * resolver alone, because "getDomainsDir agrees" is a weaker claim than "the
 * bytes land in the folder the reader will look in".
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 * CURATOR_TEST_DOMAINS_DIR is deliberately NOT used: it outranks the CLI arg in
 * both resolvers, so setting it would mask the exact rung under test. Isolation
 * comes from the user-data seam instead (__setUserDataDirOverride in-process,
 * CURATOR_TEST_USER_DATA_DIR for the spawned child), which redirects BOTH the
 * config file and the default domains dir into a tempdir — so the real
 * domains/ and the real .curator-config.json are unreachable by construction,
 * not by remembering to avoid them.
 *
 * ── ENFORCED ────────────────────────────────────────────────────────────────
 *   • getDomainsDir()'s full precedence matrix, driven as a function.
 *   • The app path with no CLI arg, against independently computed expectations.
 *   • The real write path (writePage/domainPath/wikiPath) landing bytes in the
 *     folder the real read adapter then finds them in.
 *   • The real spawned mcp/server.js READING the right tree, and stdout purity.
 *   • That the production override and the test seam are separate mechanisms,
 *     and that exactly one production caller exists and it is mcp/server.js.
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *   • §4 drives the spawned server's READ side only. An MCP WRITE end-to-end
 *     through the real JSON-RPC surface would be the strongest possible proof,
 *     but the write tools live in mcp/tools/** and this suite deliberately does
 *     not couple to their argument schemas. Consequence: deleting the
 *     setCliDomainsDir call from server.js is caught by §5's SOURCE scan (three
 *     assertions), not by §4 — because the adapter receives the arg directly
 *     and would keep reading correctly. The mechanism's EFFECT is covered
 *     behaviourally in §2/§3, which invoke the setter exactly as server.js does.
 *   • The adapter snapshots its base at construction. §5 pins the call ordering
 *     that makes that safe; it does not prove the snapshot itself is correct.
 *   • Nothing here covers the app's HTTP layer. The claim that the web server is
 *     unaffected rests on the caller count in §5 plus §1's behavioural cases.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const section = (t) => console.log(`\n${t}\n${'─'.repeat(t.length)}`);
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const good = actual === expected;
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${expected}`);
    console.log(`      actual:   ${actual}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-mcp-dompath-'));
const cleanups = [() => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }];

const paths   = await import(path.join(ROOT, 'src/brain/paths.js'));
const cfg     = await import(path.join(ROOT, 'src/brain/config.js'));
const files   = await import(path.join(ROOT, 'src/brain/files.js'));
const { createStorageAdapter } = await import(path.join(ROOT, 'mcp/storage/local.js'));

// Every rung above the one under test must be OFF for the whole run, or a
// developer's ambient env would silently short-circuit these assertions and
// they would pass without ever reaching the CLI rung.
const savedEnv = {
  testDomains: process.env.CURATOR_TEST_DOMAINS_DIR,
  legacy: process.env.DOMAINS_PATH,
  userData: process.env.CURATOR_TEST_USER_DATA_DIR,
};
delete process.env.CURATOR_TEST_DOMAINS_DIR;
delete process.env.DOMAINS_PATH;
delete process.env.CURATOR_TEST_USER_DATA_DIR;
cfg.__setDomainsDirOverride(null);
cfg.setCliDomainsDir(null);

function restoreEnv() {
  cfg.setCliDomainsDir(null);
  cfg.__setDomainsDirOverride(null);
  paths.__setUserDataDirOverride(null);
  for (const [k, v] of [
    ['CURATOR_TEST_DOMAINS_DIR', savedEnv.testDomains],
    ['DOMAINS_PATH', savedEnv.legacy],
    ['CURATOR_TEST_USER_DATA_DIR', savedEnv.userData],
  ]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
cleanups.push(restoreEnv);

// ═══════════════════════════════════════════════════════════════════════════
section('§0  Fixture self-check — the three folders must be DISTINCT');
// ═══════════════════════════════════════════════════════════════════════════
// Without this, every "reads and writes agree" assertion below could pass by
// the two resolvers happening to land on the same folder for a reason that has
// nothing to do with the fix. The whole suite is vacuous if these collide.

const userData   = path.join(tmpRoot, 'user-data');
const dirCli     = path.join(tmpRoot, 'from-cli-arg');
const dirConfig  = path.join(tmpRoot, 'from-config');
const dirEnv     = path.join(tmpRoot, 'from-env');
const dirDefault = path.join(userData, 'domains');
for (const d of [userData, dirCli, dirConfig, dirEnv, dirDefault]) fs.mkdirSync(d, { recursive: true });

const distinct = new Set([dirCli, dirConfig, dirEnv, dirDefault]);
eq(distinct.size, 4, 'the CLI / config / env / default folders are four different paths');
ok(dirCli !== dirConfig, 'CLI folder is not the config folder — the disagreement is expressible');

paths.__setUserDataDirOverride(userData);
const configFile = paths.getCuratorConfigFile();
ok(configFile.startsWith(userData),
  'the config file the resolvers read is INSIDE the tempdir (the real one is unreachable)');
fs.writeFileSync(configFile, JSON.stringify({ domainsPath: dirConfig }), 'utf8');
eq(path.resolve(paths.getDefaultDomainsDir()), path.resolve(dirDefault),
  'the default domains dir is inside the tempdir too');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  NO CLI ARG — the app path is byte-identical to before the fix');
// ═══════════════════════════════════════════════════════════════════════════
// This is the regression that matters most. The web server never calls
// setCliDomainsDir, so for every existing caller getDomainsDir() must resolve
// exactly what it resolved before the new rung existed. Each case is checked
// against an INDEPENDENTLY computed expectation (the stored value, the env
// value, paths.js's default) — never against the function's own output.

cfg.setCliDomainsDir(null);
eq(cfg.getDomainsDir(), path.resolve(dirConfig),
  '(a) stored domainsPath still wins when no CLI arg is installed');
eq(path.resolve(createStorageAdapter({}).getBase()), path.resolve(dirConfig),
  '(a) the read adapter agrees — stored domainsPath');

process.env.DOMAINS_PATH = dirEnv;
eq(cfg.getDomainsDir(), path.resolve(dirConfig),
  '(b) stored domainsPath still outranks the DOMAINS_PATH env fallback');

fs.rmSync(configFile);
eq(cfg.getDomainsDir(), path.resolve(dirEnv),
  '(c) with no stored value, the DOMAINS_PATH env fallback still resolves');
delete process.env.DOMAINS_PATH;
eq(cfg.getDomainsDir(), path.resolve(dirDefault),
  '(d) with nothing set at all, the default still resolves');

// Restore the stored value for the sections that need a real disagreement.
fs.writeFileSync(configFile, JSON.stringify({ domainsPath: dirConfig }), 'utf8');

// getConfig() must never report a source that contradicts the folder beside it.
const shownNoCli = cfg.getConfig();
eq(shownNoCli.domainsPath, path.resolve(dirConfig), '(e) getConfig() reports the stored folder');
eq(shownNoCli.domainsPathSource, 'ui', '(e) getConfig() reports source "ui", unchanged for the app');

// ═══════════════════════════════════════════════════════════════════════════
section('§2  WITH THE CLI ARG — the companion assertion test-paths.js §9(d) lacks');
// ═══════════════════════════════════════════════════════════════════════════
// The read half (adapter honours the arg) was always true and is already
// guarded. The WRITE half is what shipped broken.

cfg.setCliDomainsDir(dirCli);

const readBase  = path.resolve(createStorageAdapter({ domainsPath: dirCli }).getBase());
const writeBase = path.resolve(cfg.getDomainsDir());

eq(readBase, path.resolve(dirCli), 'READ side resolves the CLI arg (unchanged, already guarded)');
eq(writeBase, path.resolve(dirCli), 'WRITE side resolves the CLI arg — THIS IS THE FIX');
eq(writeBase, readBase, 'reads and writes resolve the SAME folder');
ok(writeBase !== path.resolve(dirConfig),
  'the write side did NOT fall through to the stored domainsPath (the shipped bug)');

// Precedence matrix, exercised against the real function.
process.env.DOMAINS_PATH = dirEnv;
eq(cfg.getDomainsDir(), path.resolve(dirCli), 'CLI arg outranks the DOMAINS_PATH env fallback');
delete process.env.DOMAINS_PATH;
eq(cfg.getDomainsDir(), path.resolve(dirCli), 'CLI arg outranks the stored domainsPath');

// Both TEST seams must still outrank the production rung, or a test could no
// longer isolate an MCP child onto a throwaway tempdir.
process.env.CURATOR_TEST_DOMAINS_DIR = dirEnv;
eq(cfg.getDomainsDir(), path.resolve(dirEnv),
  'CURATOR_TEST_DOMAINS_DIR still outranks the CLI arg (matches the read adapter)');
eq(path.resolve(createStorageAdapter({ domainsPath: dirCli }).getBase()), path.resolve(dirEnv),
  'the read adapter agrees on that ordering too');
delete process.env.CURATOR_TEST_DOMAINS_DIR;

cfg.__setDomainsDirOverride(dirDefault);
eq(cfg.getDomainsDir(), path.resolve(dirDefault),
  '__setDomainsDirOverride (the TEST seam) still beats the production CLI rung');
cfg.__setDomainsDirOverride(null);

// The two mechanisms are separate, and clearing one must not clear the other.
eq(cfg.getDomainsDir(), path.resolve(dirCli),
  'clearing the test seam leaves the production CLI override installed');

const shownCli = cfg.getConfig();
eq(shownCli.domainsPath, path.resolve(dirCli), 'getConfig() reports the CLI folder when it is active');
eq(shownCli.domainsPathSource, 'cli',
  'getConfig() names the source honestly — it cannot say "ui" over a CLI-resolved folder');

// A blank/absent arg must be a no-op: launching without --domains-path is a
// legitimate, documented way to run the server.
cfg.setCliDomainsDir(null);
eq(cfg.getDomainsDir(), path.resolve(dirConfig), 'clearing the CLI override falls back to the stored value');
cfg.setCliDomainsDir('');
eq(cfg.getDomainsDir(), path.resolve(dirConfig), 'an EMPTY --domains-path is a no-op, not a cwd-relative write');
cfg.setCliDomainsDir(undefined);
eq(cfg.getDomainsDir(), path.resolve(dirConfig), 'an ABSENT --domains-path is a no-op');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  THE REAL WRITE PATH — bytes must land where the reader looks');
// ═══════════════════════════════════════════════════════════════════════════
// Resolver agreement is necessary but not sufficient. The write tools call
// writePage/wikiPath/domainPath from src/brain/files.js, so this drives those
// REAL functions and then reads the result back through the REAL adapter — the
// exact reproduction of the reported defect, minus the LLM.

cfg.setCliDomainsDir(dirCli);

const DOMAIN = 'probe-domain';
// The domain exists ONLY in the CLI tree. If the write leaks to the stored
// tree, that shows up as a file appearing under a folder that has no domain.
fs.mkdirSync(path.join(dirCli, DOMAIN, 'wiki'), { recursive: true });
fs.writeFileSync(path.join(dirCli, DOMAIN, 'CLAUDE.md'), '# probe schema\n', 'utf8');

eq(path.resolve(files.domainPath(DOMAIN)), path.resolve(path.join(dirCli, DOMAIN)),
  'files.domainPath() — used by every write tool — resolves under the CLI folder');
eq(path.resolve(files.wikiPath(DOMAIN)), path.resolve(path.join(dirCli, DOMAIN, 'wiki')),
  'files.wikiPath() resolves under the CLI folder');

const rec = await files.writePage(DOMAIN, 'concepts/probe.md', '# Probe\n\nA test page.\n');
ok(rec && typeof rec.canonPath === 'string', 'writePage returned a change record');

const landedCli    = path.join(dirCli,    DOMAIN, 'wiki', 'concepts', 'probe.md');
const landedConfig = path.join(dirConfig, DOMAIN, 'wiki', 'concepts', 'probe.md');
ok(fs.existsSync(landedCli),  'the page landed in the CLI folder — where the reader will look');
ok(!fs.existsSync(landedConfig),
  'the page did NOT land in the stored-domainsPath folder (pre-fix, it landed HERE)');

// And the read side can actually find what the write side just produced. This
// is the assertion that would have gone red on the shipped code: pre-fix the
// adapter listed the CLI tree while writePage populated the stored tree, so
// the file the write reported was invisible to every read tool.
const adapter = createStorageAdapter({ domainsPath: dirCli });
const listed = await adapter.listDomains();
ok(listed.includes(DOMAIN), 'the read adapter sees the domain the write was addressed to');
const wikiFiles = await adapter.listWikiFiles(DOMAIN);
ok(wikiFiles.some(f => f.path === 'concepts/probe.md'),
  'the read adapter finds the page the write path just wrote — reads and writes agree END TO END');

// The audit log is written through the adapter; the page through files.js.
// Pre-fix these two went to different trees for the same operation.
await adapter.appendToWriteAudit(DOMAIN, { ts: 'probe', tool: 'test' });
ok(fs.existsSync(path.join(dirCli, DOMAIN, '.mcp-write-log.jsonl')),
  'the audit log lands in the same tree as the page it describes');

cfg.setCliDomainsDir(null);
paths.__setUserDataDirOverride(null);

// ═══════════════════════════════════════════════════════════════════════════
section('§4  THE REAL SERVER — spawned as Claude Desktop spawns it');
// ═══════════════════════════════════════════════════════════════════════════
// Everything above drives modules directly. This drives mcp/server.js itself
// over real stdio JSON-RPC, so the wiring (parse the arg → install it → build
// the adapter, in that order) is proven rather than assumed. It also re-checks
// stdout purity, because this change adds an import to that process.

const childUserData = path.join(tmpRoot, 'child-user-data');
const childCli      = path.join(tmpRoot, 'child-cli-tree');
const childConfig   = path.join(tmpRoot, 'child-config-tree');
fs.mkdirSync(childUserData, { recursive: true });
// The domain exists ONLY in the CLI tree; a decoy with a DIFFERENT name exists
// only in the stored tree. Whichever name comes back names the folder the
// server actually resolved — so this cannot pass by accident.
fs.mkdirSync(path.join(childCli, 'cli-tree-domain', 'wiki'), { recursive: true });
fs.writeFileSync(path.join(childCli, 'cli-tree-domain', 'CLAUDE.md'), '# cli\n', 'utf8');
fs.mkdirSync(path.join(childConfig, 'config-tree-domain', 'wiki'), { recursive: true });
fs.writeFileSync(path.join(childConfig, 'config-tree-domain', 'CLAUDE.md'), '# config\n', 'utf8');
fs.writeFileSync(path.join(childUserData, '.curator-config.json'),
  JSON.stringify({ domainsPath: childConfig }), 'utf8');

function runServer(extraArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp/server.js'), ...extraArgs], {
      cwd: ROOT,
      env: {
        ...process.env,
        CURATOR_TEST_USER_DATA_DIR: childUserData,
        // Explicitly cleared: this rung outranks the arg under test.
        CURATOR_TEST_DOMAINS_DIR: '',
        DOMAINS_PATH: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_domains', arguments: {} } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20000);
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    setTimeout(() => { try { child.stdin.end(); } catch {} }, 2500);
  });
}

const withArg = await runServer(['--domains-path', childCli]);
const framesA = withArg.out.split('\n').filter(Boolean);
let parsedAllA = true;
const objsA = [];
for (const line of framesA) {
  try { objsA.push(JSON.parse(line)); } catch { parsedAllA = false; }
}
ok(framesA.length > 0, 'the spawned server produced stdout frames');
ok(parsedAllA, 'every stdout line parses as JSON — the JSON-RPC stream is not polluted');
const callA = objsA.find(o => o.id === 2);
ok(!!callA, 'the server answered the list_domains call');
const textA = JSON.stringify(callA ?? {});
ok(textA.includes('cli-tree-domain'),
  'the spawned server READS the CLI tree (the domain that exists only there)');
ok(!textA.includes('config-tree-domain'),
  'the spawned server did NOT read the stored-domainsPath tree');

const noArg = await runServer([]);
const objsB = [];
let parsedAllB = true;
for (const line of noArg.out.split('\n').filter(Boolean)) {
  try { objsB.push(JSON.parse(line)); } catch { parsedAllB = false; }
}
ok(parsedAllB, 'stdout stays pure JSON when launched WITHOUT the arg too');
const callB = objsB.find(o => o.id === 2);
const textB = JSON.stringify(callB ?? {});
ok(textB.includes('config-tree-domain'),
  'without the arg, the server falls back to the stored domainsPath — unchanged behaviour');
ok(!textB.includes('cli-tree-domain'),
  'without the arg, the CLI tree is not consulted');

// ═══════════════════════════════════════════════════════════════════════════
section('§5  The two seams are distinct mechanisms, not one renamed');
// ═══════════════════════════════════════════════════════════════════════════
// The production override must NOT be the test seam wearing a new name: the
// test seam is documented and guarded as "production never sets this", and
// test-paths.js §4 depends on that. Both must exist, and independently.

ok(typeof cfg.setCliDomainsDir === 'function', 'setCliDomainsDir (production) is exported');
ok(typeof cfg.__setDomainsDirOverride === 'function', '__setDomainsDirOverride (test seam) still exists');
ok(cfg.setCliDomainsDir !== cfg.__setDomainsDirOverride,
  'they are two different functions — the test seam was not repurposed for production');

const serverSrc = fs.readFileSync(path.join(ROOT, 'mcp/server.js'), 'utf8');
ok(!/__setDomainsDirOverride/.test(serverSrc),
  'mcp/server.js does NOT touch the test seam');
const iSet = serverSrc.indexOf('setCliDomainsDir(');
const iAdapter = serverSrc.indexOf('createStorageAdapter({');
ok(iSet > -1 && iAdapter > -1 && iSet < iAdapter,
  'server.js installs the override BEFORE building the adapter (the adapter snapshots its base)');

// Exactly one production caller, and it is the MCP entry point. If the web
// server ever starts calling this, §1's "unchanged for the app" claim dies —
// so the count is asserted, not assumed.
const callers = [];
for (const dir of ['src', 'mcp']) {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) {
        const s = fs.readFileSync(full, 'utf8');
        // The declaration site in config.js is not a call.
        if (/setCliDomainsDir\s*\(/.test(s) && !full.endsWith(path.join('brain', 'config.js'))) {
          callers.push(path.relative(ROOT, full).split(path.sep).join('/'));
        }
      }
    }
  };
  walk(path.join(ROOT, dir));
}
eq(callers.length, 1, 'exactly ONE production caller of setCliDomainsDir across src/ and mcp/');
eq(callers[0], 'mcp/server.js', 'and that caller is the MCP entry point, not the web server');

// ── Cleanup + tally ─────────────────────────────────────────────────────────
for (const c of cleanups) { try { c(); } catch {} }

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ MCP domains-path: reads and writes resolve one folder');
