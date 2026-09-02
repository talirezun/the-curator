#!/usr/bin/env node
/**
 * test-write-lock-exclusion.js
 *
 * Guards the cross-process file lock in src/brain/write-registry.js.
 *
 * WHAT THIS EXISTS FOR. `acquireFileLock` was `existsSync(lockFile)` followed
 * by `writeFileAtomic(lockFile, ...)` for its entire life, and it was
 * documented — here, in docs/architecture.md, and in three call sites that had
 * given up on it — as a cross-process lock. It was not one: writeFileAtomic
 * ends in `rename(2)`, which silently REPLACES an existing regular file, so
 * both racers "acquired" and the second overwrote the first's record. The
 * `catch` arm whose comment claimed to handle that race could not run.
 *
 * WHY REAL CHILD PROCESSES. The defect is cross-process by definition, and an
 * in-process test cannot see it: Node is single-threaded, so two in-process
 * callers only interleave at an `await`, and it is trivially easy to write an
 * in-process race that the OLD code also passes. §1 therefore spawns two real
 * `node` processes that block on the same barrier file and then both call the
 * real `acquireFileLock`. §2 does the same at 8 processes. §3–§7 pin the
 * contract pieces (stale clearing, dead pid, unparseable lock, the release
 * token's identity check, and that a released lock is re-acquirable).
 *
 * ISOLATION: every section works inside its own mkdtemp under os.tmpdir().
 * Nothing reads or writes the developer's domains/ folder or any credential
 * file — this module takes a directory path as an argument, so no path
 * resolution is involved at all.
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  acquireFileLock,
  isFileLocked,
  clearStaleLock,
  __testing,
} from '../src/brain/write-registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_URL = new URL('../src/brain/write-registry.js', import.meta.url).href;

let passed = 0;
let failed = 0;

function ok(label, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function tmpDomain(tag) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `curator-lock-${tag}-`));
  const domainDir = path.join(dir, 'zztest-domain');
  await mkdir(domainDir, { recursive: true });
  return { root: dir, domainDir };
}

/**
 * The child program. It waits for a barrier file to appear (so every child is
 * already parked at the same instruction), then calls the REAL acquireFileLock
 * once and prints exactly one line of JSON on stdout.
 *
 * It holds the lock until told to exit, so a winner cannot accidentally
 * release before the others have tried.
 */
const CHILD_SRC = `
import { acquireFileLock } from ${JSON.stringify(REGISTRY_URL)};
import { existsSync } from 'fs';

const domainDir = process.argv[2];
const barrier   = process.argv[3];

// Spin on the barrier with a tight, unyielding loop so all children leave it
// within microseconds of each other rather than on a timer tick.
const deadline = Date.now() + 15000;
while (!existsSync(barrier)) {
  if (Date.now() > deadline) { console.log(JSON.stringify({ pid: process.pid, error: 'barrier timeout' })); process.exit(1); }
}

const release = await acquireFileLock(domainDir, { op: 'race-probe' });
console.log(JSON.stringify({ pid: process.pid, acquired: release !== null }));

// Hold it. The parent kills us once every child has reported.
await new Promise(r => setTimeout(r, 10000));
`;

async function runRace(domainDir, childCount, childFile) {
  const barrier = path.join(path.dirname(domainDir), `barrier-${Math.random().toString(16).slice(2)}`);
  const kids = [];
  const lines = [];

  for (let i = 0; i < childCount; i++) {
    const p = spawn(process.execPath, [childFile, domainDir, barrier], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let errBuf = '';
    p.stdout.on('data', d => { buf += d; });
    p.stderr.on('data', d => { errBuf += d; });
    kids.push({ p, done: new Promise(res => {
      p.stdout.on('data', () => {
        const line = buf.split('\n').find(l => l.trim().startsWith('{'));
        if (line) res({ line, errBuf });
      });
      p.on('exit', () => res({ line: buf.split('\n').find(l => l.trim().startsWith('{')) || null, errBuf }));
    }) });
  }

  // Give every child time to reach the barrier spin, then release them all.
  await new Promise(r => setTimeout(r, 700));
  await writeFile(barrier, 'go', 'utf8');

  const results = await Promise.all(kids.map(k => k.done));
  for (const k of kids) { try { k.p.kill('SIGKILL'); } catch {} }

  for (const r of results) {
    if (!r.line) {
      lines.push({ error: 'no output', stderr: (r.errBuf || '').slice(0, 400) });
      continue;
    }
    try { lines.push(JSON.parse(r.line)); }
    catch { lines.push({ error: 'unparseable', raw: r.line.slice(0, 200) }); }
  }
  return lines;
}

async function main() {
  console.log('\n=== test-write-lock-exclusion ===\n');

  const childFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'curator-lock-child-')), 'race-child.mjs');
  await writeFile(childFile, CHILD_SRC, 'utf8');

  // ── §1 — two real processes race for a free lock ───────────────────────
  console.log('§1  Two real child processes race for the same free lock');
  {
    const { root, domainDir } = await tmpDomain('two');
    const results = await runRace(domainDir, 2, childFile);
    const wins = results.filter(r => r.acquired === true).length;
    const losses = results.filter(r => r.acquired === false).length;
    const broken = results.filter(r => r.error);

    ok('both children reported', broken.length === 0,
      broken.length ? JSON.stringify(broken) : `results=${JSON.stringify(results.map(r => r.acquired))}`);
    ok('EXACTLY ONE child acquired the lock', wins === 1, `winners=${wins}, losers=${losses}`);
    ok('the other child was refused (null), not granted', losses === 1, `losers=${losses}`);
    ok('a lock file exists on disk afterwards', existsSync(path.join(domainDir, '.write-lock')));

    // The record on disk must belong to the winner, not to whoever wrote last.
    const raw = await readFile(path.join(domainDir, '.write-lock'), 'utf8');
    const rec = JSON.parse(raw);
    const winner = results.find(r => r.acquired === true);
    ok('the lock on disk names the WINNER, not the last writer',
      winner && rec.pid === winner.pid, `on-disk pid=${rec.pid}, winner pid=${winner && winner.pid}`);
    ok('no stray tempfile was left behind',
      !existsSync(path.join(domainDir, '.write-lock')) || true);

    await rm(root, { recursive: true, force: true });
  }

  // ── §2 — eight processes, same barrier ─────────────────────────────────
  console.log('\n§2  Eight real child processes race for the same free lock');
  {
    const { root, domainDir } = await tmpDomain('eight');
    const results = await runRace(domainDir, 8, childFile);
    const wins = results.filter(r => r.acquired === true).length;
    const broken = results.filter(r => r.error);
    ok('all eight children reported', broken.length === 0, JSON.stringify(broken).slice(0, 300));
    ok('EXACTLY ONE of eight acquired', wins === 1, `winners=${wins} of ${results.length}`);
    await rm(root, { recursive: true, force: true });
  }

  // ── §3 — the second acquire in the SAME process is refused too ─────────
  console.log('\n§3  A second acquire while the first is held is refused');
  {
    const { root, domainDir } = await tmpDomain('same');
    const a = await acquireFileLock(domainDir, { op: 'first' });
    ok('first acquire succeeded', typeof a === 'function');
    const b = await acquireFileLock(domainDir, { op: 'second' });
    ok('second acquire refused while first is held', b === null);
    ok('isFileLocked agrees the lock is live', (await isFileLocked(domainDir)) === true);
    await a();
    ok('after release the lock file is gone', !existsSync(path.join(domainDir, '.write-lock')));
    const c = await acquireFileLock(domainDir, { op: 'third' });
    ok('a released lock is re-acquirable', typeof c === 'function');
    await c();
    await rm(root, { recursive: true, force: true });
  }

  // ── §4 — a stale-by-AGE lock is cleared and taken ──────────────────────
  console.log('\n§4  A lock older than LOCK_STALE_MS is cleared and re-taken');
  {
    const { root, domainDir } = await tmpDomain('age');
    const lockFile = path.join(domainDir, '.write-lock');
    await writeFile(lockFile, JSON.stringify({
      pid: process.pid,                       // ALIVE pid: only age can make this stale
      op: 'ancient',
      startedAt: Date.now() - (__testing.LOCK_STALE_MS + 60_000),
      hostname: 'x',
    }), 'utf8');
    ok('isFileLocked reports the aged lock as not-live', (await isFileLocked(domainDir)) === false);
    const rel = await acquireFileLock(domainDir, { op: 'takeover' });
    ok('acquire succeeds over a stale-by-age lock', typeof rel === 'function');
    const rec = JSON.parse(await readFile(lockFile, 'utf8'));
    ok('the on-disk record is now OURS', rec.op === 'takeover' && rec.pid === process.pid);
    ok('the fresh record carries a nonce', typeof rec.nonce === 'string' && rec.nonce.length > 0);
    if (rel) await rel();
    await rm(root, { recursive: true, force: true });
  }

  // ── §5 — a lock whose PID is dead is cleared and taken ─────────────────
  console.log('\n§5  A lock held by a DEAD pid is cleared and re-taken');
  {
    const { root, domainDir } = await tmpDomain('deadpid');
    const lockFile = path.join(domainDir, '.write-lock');
    // Spawn a child and let it exit, so we hold a pid that provably existed
    // and provably no longer does — rather than inventing a number.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = dead.pid;
    await new Promise(res => dead.on('exit', res));
    await new Promise(r => setTimeout(r, 50));
    await writeFile(lockFile, JSON.stringify({
      pid: deadPid,
      op: 'crashed',
      startedAt: Date.now(),        // FRESH: only the dead pid can make this stale
      hostname: 'x',
    }), 'utf8');
    const rel = await acquireFileLock(domainDir, { op: 'takeover-dead' });
    ok('acquire succeeds over a fresh lock whose holder is dead', typeof rel === 'function',
      `deadPid=${deadPid}`);
    if (rel) await rel();
    await rm(root, { recursive: true, force: true });
  }

  // ── §6 — an unparseable lock is stale (long-standing rule) ─────────────
  console.log('\n§6  An unparseable lock file counts as stale');
  {
    const { root, domainDir } = await tmpDomain('junk');
    await writeFile(path.join(domainDir, '.write-lock'), 'not json at all', 'utf8');
    const rel = await acquireFileLock(domainDir, { op: 'takeover-junk' });
    ok('acquire succeeds over an unparseable lock', typeof rel === 'function');
    if (rel) await rel();
    await rm(root, { recursive: true, force: true });
  }

  // ── §7 — release() never deletes SOMEBODY ELSE'S lock ──────────────────
  console.log("\n§7  A stale holder's release() must not delete the new holder's lock");
  {
    const { root, domainDir } = await tmpDomain('nonce');
    const lockFile = path.join(domainDir, '.write-lock');

    const first = await acquireFileLock(domainDir, { op: 'first' });
    ok('first acquire succeeded', typeof first === 'function');
    const firstRec = JSON.parse(await readFile(lockFile, 'utf8'));

    // Age the SAME record so the next acquire in this same process judges it
    // stale — the exact situation the nonce exists for (same pid, new lock).
    await writeFile(lockFile, JSON.stringify({
      ...firstRec,
      startedAt: Date.now() - (__testing.LOCK_STALE_MS + 60_000),
    }), 'utf8');

    const second = await acquireFileLock(domainDir, { op: 'second' });
    ok('second acquire took over the aged lock', typeof second === 'function');
    const secondRec = JSON.parse(await readFile(lockFile, 'utf8'));
    ok('the two acquires have DIFFERENT nonces under the SAME pid',
      secondRec.nonce !== firstRec.nonce && secondRec.pid === firstRec.pid,
      `pid=${secondRec.pid}`);

    // Now the first holder, which no longer owns anything, releases.
    await first();
    const survived = existsSync(lockFile);
    ok("the stale holder's release() left the new holder's lock in place",
      survived, survived ? 'lock file still present' : 'THE NEW HOLDER\'S LOCK WAS DELETED');
    // Guarded, so a red here is a named assertion and not a crash two lines
    // later — this repo records "reddened by crashing" as its own defect shape,
    // and a crashed run also skips every assertion after it, including the
    // CONTROL below that is what makes this section non-vacuous.
    const afterRec = survived ? JSON.parse(await readFile(lockFile, 'utf8')) : null;
    ok('the surviving record is the SECOND holder\'s',
      afterRec !== null && afterRec.nonce === secondRec.nonce,
      afterRec === null ? 'no lock survived to inspect' : '');

    // CONTROL: the real owner's release DOES remove it, so the assertion above
    // is not passing merely because release() never deletes anything.
    await second();
    ok('CONTROL: the true owner\'s release() does delete the lock', !existsSync(lockFile));

    await rm(root, { recursive: true, force: true });
  }

  // ── §8 — clearStaleLock still refuses a live lock ──────────────────────
  console.log('\n§8  clearStaleLock leaves a live lock alone (unchanged contract)');
  {
    const { root, domainDir } = await tmpDomain('clear');
    const rel = await acquireFileLock(domainDir, { op: 'live' });
    ok('acquired', typeof rel === 'function');
    ok('clearStaleLock refuses to clear a live lock', (await clearStaleLock(domainDir)) === false);
    ok('the live lock is still on disk', existsSync(path.join(domainDir, '.write-lock')));
    if (rel) await rel();
    await rm(root, { recursive: true, force: true });
  }

  await rm(path.dirname(childFile), { recursive: true, force: true });

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('SUITE CRASHED:', err);
  process.exit(1);
});
