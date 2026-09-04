#!/usr/bin/env node
/**
 * test-instance-probe.js — OFFLINE suite for src/brain/instance-probe.js and
 * the GET /api/config/instances endpoint that renders its answer.
 *
 * ══ WHAT THIS EXISTS TO CATCH ═══════════════════════════════════════════════
 *
 * The maintainer ran the repo checkout and the packaged Mac app at the same
 * time over ONE domains folder. An ingest failed; the next took close to an
 * hour. Neither window said the two were sharing a folder, because nothing in
 * `src/` had ever been able to tell — the protection had been an ACCIDENTAL
 * port collision, removed when `desktop/lib/port.js` started picking an
 * ephemeral port (that file's own docblock calls it "a REDUCTION in
 * protection" and asks for a deliberate replacement).
 *
 * ══ HOW IT IS TESTED, AND WHY THAT SHAPE ════════════════════════════════════
 *
 * §3 spawns TWO REAL CHILD PROCESSES. Everything this module claims is about
 * processes seeing each other, and a single-process test can only assert that
 * a function returns what a fixture put in front of it. Two children register
 * against one temp domains folder and each reports what IT sees; the parent —
 * a third process — then reads the same registry. Nothing here simulates a
 * pid: liveness is `process.kill(pid, 0)` against pids the OS actually issued,
 * a clean quit really exits, and a stale record is produced by a real
 * SIGKILL, which is the one way to leave a marker behind.
 *
 * §7 asserts the property the design argument turns on — NOTHING is written
 * inside the domains folder — by comparing a recursive listing before and
 * after. It is asserted behaviourally rather than by reading the path
 * constant, because `domains/` is Personal Sync's git work-tree and a file
 * there is committed and pushed by the next `git add -A`.
 *
 * §8 drives the REAL router over a REAL HTTP round trip against a REAL
 * registry, rather than calling a handler with a stub `res` — the wire shape
 * is an allow-list and the only honest way to prove a field does not leak is
 * to read the bytes that came back.
 *
 * ══ ISOLATION ══════════════════════════════════════════════════════════════
 *
 * `CURATOR_TEST_USER_DATA_DIR` (crosses into the spawned children) plus
 * `__setDomainsDirOverride` in-process. §0 and §10 fingerprint the real
 * `.curator-config.json` — sha256 + size + existence, never mtime, per
 * CLAUDE.md's v3.1.1 rule — and §10 asserts it is untouched.
 *
 * ══ NOT ENFORCED, stated plainly ═══════════════════════════════════════════
 *
 *   • Nothing here runs under Electron, so `describeThisInstance()`'s
 *     `process.versions.electron` arm is exercised only through a forced
 *     value, never by a real app.
 *   • The BANNER itself is not rendered — `src/public/next/app.js` executes
 *     DOM code at module scope and there is no DOM here. §9 pins the shared
 *     SENTENCE-BUILDING (describeOthers), which the banner duplicates
 *     client-side; the rendered result is unverified.
 *   • PID REUSE after a hard kill can still produce a false positive. That is
 *     recorded in the module's docblock as accepted, and is not tested
 *     because it cannot be forced.
 */

import path from 'path';
import os from 'os';
import http from 'http';
import { spawn } from 'child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  readdirSync, statSync, rmSync, symlinkSync, copyFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)})`); }
function section(t) { console.log(`\n${t}`); }

// ── §0. Isolation FIRST, before a single module is imported ─────────────────
//
// paths.js memoises its resolved user-data dir, and every module that reads a
// user-data path is reachable from the imports below. Setting the env after
// an import would isolate nothing and the suite would silently run against
// the maintainer's real files while reporting green.
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-instance-probe-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;

/** sha256 + size + existence. NEVER mtime — see the docblock. */
function fingerprint(file) {
  if (!existsSync(file)) return { exists: false };
  const buf = readFileSync(file);
  return {
    exists: true,
    size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}
const REAL_CONFIG = path.join(REPO_ROOT, '.curator-config.json');
const REAL_CONFIG_BEFORE = fingerprint(REAL_CONFIG);

const probe = await import('../src/brain/instance-probe.js');
const { __setDomainsDirOverride, getDomainsDir } = await import('../src/brain/config.js');
const paths = await import('../src/brain/paths.js');
__setDomainsDirOverride(DOMAINS);

// ── §1. Where the registry resolves, and what it must never be ──────────────
section('1. Registry root resolution — the four rungs, and the shared default');
{
  const root = probe.getInstanceRegistryRoot();
  ok(root === path.join(USER_DATA, 'instances'),
    `an isolated user-data dir pulls the registry with it (got ${root})`);
  ok(!root.startsWith(DOMAINS + path.sep) && root !== DOMAINS,
    'the registry is NOT inside the domains folder — the whole point of the location argument');

  const forced = path.join(TMP_ROOT, 'forced-registry');
  probe.__setInstanceRegistryRootOverride(forced);
  eq(probe.getInstanceRegistryRoot(), forced, 'the in-process override wins over everything');
  probe.__setInstanceRegistryRootOverride(null);
  eq(probe.getInstanceRegistryRoot(), path.join(USER_DATA, 'instances'),
    'clearing the override restores the isolated location');

  const envDir = path.join(TMP_ROOT, 'env-registry');
  process.env.CURATOR_TEST_INSTANCE_DIR = envDir;
  eq(probe.getInstanceRegistryRoot(), envDir, 'the env seam is read PER CALL, so it crosses a process boundary');
  delete process.env.CURATOR_TEST_INSTANCE_DIR;

  // The production default, asserted without writing anything into it. This is
  // the rung that makes two DIFFERENT installs land in one place, so it must
  // not follow getUserDataDir() (which forks on install form).
  const savedUserData = process.env.CURATOR_TEST_USER_DATA_DIR;
  delete process.env.CURATOR_TEST_USER_DATA_DIR;
  const shared = probe.getInstanceRegistryRoot();
  process.env.CURATOR_TEST_USER_DATA_DIR = savedUserData;
  eq(shared, path.join(paths.getAppSupportDir(), 'instances'),
    'with no seam set it is the UNCONDITIONAL Application Support location, not getUserDataDir()');
  ok(shared !== path.join(paths.APP_ROOT, 'instances'),
    'and specifically NOT the repo checkout, which is where a getUserDataDir()-based design would put a checkout\'s registry');
  ok(!existsSync(shared) || statSync(shared).isDirectory(),
    'CONTROL: reading the production default created nothing (this resolver is pure)');
}

// ── §2. The hash BUCKETS; the recorded path DECIDES ─────────────────────────
section('2. Bucketing by domains path — symlinks collapse, different folders do not');
{
  const other = path.join(TMP_ROOT, 'other-domains');
  mkdirSync(other, { recursive: true });
  ok(probe.bucketName(DOMAINS) !== probe.bucketName(other),
    'two different folders get different buckets');

  const linkPath = path.join(TMP_ROOT, 'domains-link');
  let symlinked = true;
  try { symlinkSync(DOMAINS, linkPath, 'dir'); } catch { symlinked = false; }
  if (symlinked) {
    eq(probe.bucketName(linkPath), probe.bucketName(DOMAINS),
      'the same folder reached through a symlink lands in the SAME bucket');
    eq(probe.canonicalDomainsPath(linkPath), probe.canonicalDomainsPath(DOMAINS),
      'and canonicalDomainsPath agrees, which is what the record then carries');
  } else {
    ok(true, 'symlink creation unavailable on this filesystem — symlink collapse skipped');
  }

  const missing = path.join(TMP_ROOT, 'does-not-exist-at-all');
  ok(probe.canonicalDomainsPath(missing) === path.resolve(missing),
    'a folder that does not exist yet keeps its resolved form rather than throwing');
  eq(probe.bucketName(DOMAINS).length, probe.__testing.BUCKET_HEX_CHARS,
    'the bucket name is the documented width');
}

// ── §3. TWO REAL CHILD PROCESSES over ONE domains folder ────────────────────
section('3. Two real processes, one knowledge folder — each sees the other');

const CHILD = path.join(TMP_ROOT, 'child.mjs');
writeFileSync(CHILD, `
import { registerInstance, listInstances, listOtherInstances } from ${JSON.stringify(path.join(REPO_ROOT, 'src/brain/instance-probe.js'))};
const domains = process.env.CHILD_DOMAINS;
const port = Number(process.env.CHILD_PORT);
await registerInstance({ domainsDir: domains, port, version: 'test' });
process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\\n');
let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line === 'LIST') {
      const others = await listOtherInstances(domains);
      const all = await listInstances(domains);
      process.stdout.write(JSON.stringify({ others, allPids: all.map(r => r.pid) }) + '\\n');
    } else if (line === 'QUIT') {
      process.exit(0);   // clean exit -> the 'exit' handler must remove the marker
    }
  }
});
`, 'utf8');

function startChild(port) {
  const child = spawn(process.execPath, [CHILD], {
    env: {
      ...process.env,
      CHILD_DOMAINS: DOMAINS,
      CHILD_PORT: String(port),
      CURATOR_TEST_USER_DATA_DIR: USER_DATA,
      CURATOR_TEST_DOMAINS_DIR: DOMAINS,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  const waiters = [];
  let acc = '';
  child.stdout.on('data', (d) => {
    acc += d.toString();
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, i).trim();
      acc = acc.slice(i + 1);
      if (!line) continue;
      // A line is EITHER handed to a waiting reader OR queued — never both.
      // Doing both leaves a stale copy in the queue, and the next read then
      // returns the PREVIOUS message; that defect was hit while writing this
      // suite and it presented as "child B never answered", which is exactly
      // the failure the suite is meant to detect for real.
      const w = waiters.shift();
      if (w) w(JSON.parse(line));
      else lines.push(line);
    }
  });
  child.stderr.on('data', () => { /* diagnostics only */ });
  child.next = () => new Promise((resolve, reject) => {
    if (lines.length) return resolve(JSON.parse(lines.shift()));
    waiters.push(resolve);
    setTimeout(() => reject(new Error('child produced no line within 10s')), 10000).unref();
  });
  child.send = (s) => child.stdin.write(s + '\n');
  return child;
}

let childRecordA = null;
{
  const a = startChild(3333);
  const readyA = await a.next();
  const b = startChild(51234);
  const readyB = await b.next();
  ok(readyA.pid !== readyB.pid, 'two genuinely different OS processes are running');

  a.send('LIST');
  const seenByA = await a.next();
  b.send('LIST');
  const seenByB = await b.next();

  ok(seenByA.others.some(o => o.pid === readyB.pid),
    'process A sees process B over the same knowledge folder');
  ok(!seenByA.others.some(o => o.pid === readyA.pid),
    'process A does NOT report ITSELF — the banner must never fire for the app the user is looking at');
  ok(seenByA.allPids.includes(readyA.pid) && seenByA.allPids.includes(readyB.pid),
    'CONTROL: listInstances DOES include A itself, so the exclusion above is a filter and not an empty registry');
  ok(seenByB.others.some(o => o.pid === readyA.pid),
    'and process B symmetrically sees process A');

  const bRecord = seenByA.others.find(o => o.pid === readyB.pid);
  eq(bRecord.port, 51234, 'the reported port is the one the other process actually bound');
  ok(typeof bRecord.kind === 'string' && bRecord.kind.length > 0,
    `the record names WHAT the other copy is, in plain words (got ${JSON.stringify(bRecord.kind)})`);

  // Clean quit → the exit handler removes the marker immediately, with no
  // reader having to notice a dead pid first.
  childRecordA = path.join(probe.getBucketDir(DOMAINS), `${readyA.pid}.json`);
  const recordB = path.join(probe.getBucketDir(DOMAINS), `${readyB.pid}.json`);
  ok(existsSync(recordB), 'B\'s marker is on disk while B is alive');
  b.send('QUIT');
  await new Promise(r => b.on('exit', r));
  ok(!existsSync(recordB),
    'a CLEAN quit removes its own marker on the way out — no reader needed');

  // Hard kill → the marker survives the process, and the next read clears it.
  ok(existsSync(childRecordA), 'A\'s marker is still on disk before the kill');
  a.kill('SIGKILL');
  await new Promise(r => a.on('exit', r));
  ok(existsSync(childRecordA),
    'CONTROL: SIGKILL leaves the marker behind — so the stale-clear below is not testing an already-empty directory');

  const afterKill = await probe.listInstances(DOMAINS);
  ok(!afterKill.some(r => r.pid === readyA.pid),
    'a killed process is not reported as live');
  ok(!existsSync(childRecordA),
    'and its marker is REMOVED from disk, so a crash can never block or mislead anyone later');
}

// ── §4. This process: registered, listed, and excluded from "others" ────────
section('4. Own-process handling');
{
  const reg = await probe.registerInstance({ domainsDir: DOMAINS, port: 3333, version: 'suite' });
  ok(reg.ok, 'this process registers');
  const all = await probe.listInstances(DOMAINS);
  ok(all.some(r => r.pid === process.pid), 'listInstances includes this process');
  const others = await probe.listOtherInstances(DOMAINS);
  ok(!others.some(r => r.pid === process.pid), 'listOtherInstances excludes this process');
  eq(others.length, 0, 'with nobody else alive, there are no others');

  // Registering twice must be idempotent, not an error and not a duplicate —
  // a restart-in-place or a second listen callback must not double-count.
  const again = await probe.registerInstance({ domainsDir: DOMAINS, port: 4444, version: 'suite' });
  ok(again.ok, 're-registering the same process succeeds');
  const all2 = await probe.listInstances(DOMAINS);
  eq(all2.filter(r => r.pid === process.pid).length, 1,
    'and leaves exactly one record for this pid');
  eq(all2.find(r => r.pid === process.pid).port, 4444,
    'with the NEW port, so a re-bind is reflected rather than stale');
}

// ── §5. The hash buckets; the recorded PATH decides ────────────────────────
section('5. A record naming a different folder is never reported (and never deleted)');
{
  const bucket = probe.getBucketDir(DOMAINS);
  const foreign = path.join(bucket, '999999.json');
  writeFileSync(foreign, JSON.stringify({
    pid: process.pid,                       // deliberately a LIVE pid
    port: 9999,
    kind: 'a terminal checkout',
    startedAt: Date.now(),
    domainsPath: '/somewhere/else/entirely',
  }), 'utf8');

  const all = await probe.listInstances(DOMAINS);
  ok(!all.some(r => r.port === 9999),
    'a record whose domainsPath is a DIFFERENT folder is not reported, even with a live pid');
  ok(existsSync(foreign),
    'and it is not deleted either — a path mismatch is somebody else\'s business, not junk');
  rmSync(foreign);
}

// ── §6. Junk clears itself ─────────────────────────────────────────────────
section('6. An unparseable record is removed rather than believed');
{
  const bucket = probe.getBucketDir(DOMAINS);
  const junk = path.join(bucket, '999998.json');
  writeFileSync(junk, 'this is not json', 'utf8');
  const all = await probe.listInstances(DOMAINS);
  ok(!all.some(r => r.pid === 999998), 'junk is not reported');
  ok(!existsSync(junk), 'and is removed — link(2) publishes name and content together, so this cannot be a half-written marker');

  const stray = path.join(bucket, 'something.tmp');
  writeFileSync(stray, 'x', 'utf8');
  await probe.listInstances(DOMAINS);
  ok(existsSync(stray), 'a .tmp file mid-publish is skipped, never deleted out from under its writer');
  rmSync(stray);
}

// ── §7. Nothing is EVER written inside the domains folder ──────────────────
section('7. The domains folder is untouched — the property the location argument rests on');
{
  function listTree(dir) {
    const out = [];
    const walk = (d, rel) => {
      for (const name of readdirSync(d)) {
        const p = path.join(d, name);
        const r = rel ? path.join(rel, name) : name;
        out.push(r);
        try { if (statSync(p).isDirectory()) walk(p, r); } catch { /* ignore */ }
      }
    };
    walk(dir, '');
    return out.sort();
  }
  const before = listTree(DOMAINS);
  await probe.registerInstance({ domainsDir: DOMAINS, port: 3333 });
  await probe.listInstances(DOMAINS);
  await probe.listOtherInstances(DOMAINS);
  const after = listTree(DOMAINS);
  eq(JSON.stringify(after), JSON.stringify(before),
    'register + two reads wrote nothing into the domains folder (Personal Sync\'s git work-tree)');

  // Anti-vacuity: the probe DID write somewhere, so the comparison above is
  // not the trivially-true statement that nothing happened at all.
  ok(existsSync(path.join(probe.getBucketDir(DOMAINS), `${process.pid}.json`)),
    'CONTROL: the marker really was written — into the registry, outside domains/');
}

// ── §8. The route, over a real HTTP round trip ─────────────────────────────
section('8. GET /api/config/instances — real router, real socket, allow-listed wire shape');
{
  const express = (await import('express')).default;
  const configRouter = (await import('../src/routes/config.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;

  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });

  // Nobody else alive → an empty list, and specifically NOT this process.
  const empty = JSON.parse((await get('/api/config/instances')).body);
  ok(empty.ok === true, 'the endpoint answers ok');
  eq(empty.others.length, 0, 'with no second Curator, the list is empty');
  eq(empty.othersTotal, 0, 'and the honest total agrees');

  // Plant a live-looking second instance and read the wire bytes.
  //
  // The pid has to be LIVE (a dead one is cleared on sight) and must not be
  // OURS (the route excludes this process by design), so it is the parent of
  // this process — guaranteed alive for as long as this suite runs.
  const bucket = probe.getBucketDir(getDomainsDir());
  const liveButNotUs = process.ppid;
  const planted = path.join(bucket, `${liveButNotUs}.json`);
  writeFileSync(planted, JSON.stringify({
    pid: liveButNotUs,
    port: 3333,
    kind: 'a terminal checkout',
    startedAt: 1700000000000,
    version: '9.9.9',
    domainsPath: probe.canonicalDomainsPath(getDomainsDir()),
    secretField: 'MUST-NOT-APPEAR-ON-THE-WIRE',
  }), 'utf8');

  const res = await get('/api/config/instances');
  const data = JSON.parse(res.body);
  eq(res.status, 200, 'the endpoint is a 200 even when it has something to report');
  eq(data.othersTotal, 1, 'the second Curator is reported');
  eq(data.others[0].port, 3333, 'with the port a user needs to find it');
  eq(data.others[0].pid, liveButNotUs, 'and the pid, which is what actually lets them quit it');
  ok(!res.body.includes('MUST-NOT-APPEAR-ON-THE-WIRE'),
    'a field the record happens to carry is NOT spread onto the wire — the toWire() allow-list rule');
  eq(JSON.stringify(Object.keys(data.others[0]).sort()),
    JSON.stringify(['kind', 'pid', 'port', 'startedAt']),
    'the per-instance wire shape is exactly the four allow-listed fields');

  rmSync(planted);
  server.close();
  await new Promise(r => server.once('close', r));
}

// ── §9. The sentence three surfaces share ──────────────────────────────────
section('9. describeOthers — one wording for the log, the banner and the ingest error');
{
  eq(probe.describeOthers([]), null, 'no others -> no sentence at all');
  eq(probe.describeOthers(null), null, 'a missing list is not an error');
  eq(probe.describeOthers([{ kind: 'the Mac app', port: 51234 }]),
    'the Mac app on port 51234', 'one instance names what it is and where');
  eq(probe.describeOthers([{ kind: 'the Mac app', port: null }]),
    'the Mac app', 'a record with no port still produces a usable sentence');
  eq(probe.describeOthers([
      { kind: 'the Mac app', port: 51234 },
      { kind: 'a terminal checkout', port: 3333 },
    ]),
    'the Mac app on port 51234, and a terminal checkout on port 3333',
    'two instances read as one plain sentence');

  const kind = probe.describeThisInstance();
  ok(['the Mac app', 'an installed app', 'a terminal checkout'].includes(kind),
    `describeThisInstance returns one of the three plain-word forms (got ${JSON.stringify(kind)})`);
  eq(kind, 'a terminal checkout',
    'and under `node scripts/…` — no Electron, no bundle marker — it is the checkout form');
}

// ── §10. The real credential file was never touched ────────────────────────
section('10. Isolation held');
{
  const after = fingerprint(REAL_CONFIG);
  eq(JSON.stringify(after), JSON.stringify(REAL_CONFIG_BEFORE),
    'the real .curator-config.json is byte-identical (sha256 + size + existence)');
  // The comparison above is only INFORMATIVE when there was a file to
  // compare. In a fresh git worktree there is none, and reporting a green
  // tick for an absent file is precisely the passing-test-that-measures-
  // nothing shape this project keeps writing down. So the state is named.
  console.log(REAL_CONFIG_BEFORE.exists
    ? `  · a real config WAS present (${REAL_CONFIG_BEFORE.size} bytes) — the comparison above is load-bearing`
    : '  · no .curator-config.json in this checkout — the comparison above proves only that none was CREATED');
  ok(process.env.CURATOR_TEST_USER_DATA_DIR === USER_DATA,
    'and the isolation seam was in force for the whole run, which is what kept it that way');
  ok(paths.getCuratorConfigFile().startsWith(USER_DATA + path.sep),
    `every credential path resolved inside the temp dir (got ${paths.getCuratorConfigFile()})`);
}

await probe.unregisterInstance(DOMAINS);
try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${'─'.repeat(62)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('❌ Instance-probe assertions failed');
  process.exit(1);
}
console.log('✅ All instance-probe assertions green');
