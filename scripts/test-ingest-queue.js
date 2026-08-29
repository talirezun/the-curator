#!/usr/bin/env node
/**
 * Battle test for the batch-ingest queue (Track 3, src/brain/ingest-queue.js).
 *
 * Pure offline — no network, no LLM calls, no real ingestFile. The worker is
 * exercised end-to-end against a FAKE ingestFile (the module's documented
 * `opts.ingestFile` test seam), isolated via __setUserDataDirOverride /
 * __setDomainsDirOverride so nothing here ever touches a real install.
 *
 * ── Two things this suite learned the hard way ──────────────────────────────
 *
 * 1. IT WAS NOT TESTING ITS OWN LOAD-BEARING GUARDS. An auditor deleted BOTH
 *    of the module's concurrency guards outright and this suite reported
 *    98/98 green; the same for the never-auto-start guarantee. The old
 *    "sequential execution" test issued exactly ONE start, so its
 *    `assert(!fake.hadConcurrencyViolation())` could never construct the
 *    condition it claimed to pin. Anything here that claims to guard
 *    something must FAIL when that guard is removed — verified by mutation,
 *    per guard, and recorded in the release report. Where a test asserts an
 *    invariant it now asserts the invariant (peak concurrent ingests; every
 *    item accounted for), not a flag's value at one convenient instant.
 *
 * 2. ONE THROW USED TO HIDE 76 OF 98 ASSERTIONS. A single unhandled rejection
 *    aborted the whole run at the top-level try, printing "Passed: 22
 *    Failed: 1" while sections 5–14 never executed. Every section now runs
 *    inside `section()`, which converts a throw into one failure and moves
 *    on, so a regression can never conceal the assertions after it.
 *
 * Run: node scripts/test-ingest-queue.js
 */

import { mkdtemp, writeFile, readFile, mkdir, stat, rm, chmod, readdir } from 'fs/promises';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';

import { __setUserDataDirOverride, getIngestQueueDir } from '../src/brain/paths.js';
import { __setDomainsDirOverride, getDomainsDir } from '../src/brain/config.js';
import { createDomain, rawPath } from '../src/brain/files.js';
import {
  classifyTransientError,
  createJob,
  getJob,
  listJobs,
  getActiveJob,
  toWire,
  scrubPaths,
  startOrResumeJob,
  requestPause,
  requestCancel,
  deleteJobEverything,
  recoverOnBoot,
  subscribeToJob,
  estimateIngestQueueCost,
  isValidJobId,
  CONSECUTIVE_FAILURE_LIMIT,
  cachingSavingsFraction,
  __testing,
} from '../src/brain/ingest-queue.js';

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Every line this suite prints, teed for the self-check at the bottom of the
 * file (`assertRunnerSeesThisSuiteAsRun`).
 *
 * This exists because a single ASSERTION LABEL silently un-ran the whole
 * suite: scripts/run-tests.js classifies a suite whose output contains the
 * bare uppercase word "SKIPPED" as having self-skipped — that is how a LIVE
 * suite reports a missing API key — so `npm test` showed "⏭ skip" for this
 * file. It passed, it was counted as not-run, and CI would have stayed green
 * across any regression in it. Scanning the real captured output is the
 * deliberately-dumb cross-check: it sees section titles and stray logs too,
 * not just labels routed through ok()/fail().
 */
const _printed = [];
const _realLog = console.log.bind(console);
console.log = (...args) => { _printed.push(args.join(' ')); _realLog(...args); };

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) {
  failed++;
  failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
}
function assert(cond, label, detail) { cond ? ok(label) : fail(label, detail); }
function assertEq(actual, expected, label) {
  if (actual === expected) return ok(label);
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Fault isolation. A throw inside one section is ONE failure attributed to
 * that section; every later section still runs. See this file's docblock —
 * without this, a single regression hid three quarters of the suite.
 */
async function section(title, fn) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (err) {
    fail(`${title} — threw before finishing`, (err && err.stack) || String(err));
  }
}

// ── Test harness plumbing ────────────────────────────────────────────────────

let _tmpRoot;

/**
 * EVERY tempdir this suite has ever created, so it can all be removed on
 * every exit path — not just the one `freshEnv()` call a developer happened
 * to be looking at. `freshEnv()` is called 30+ times per run (once per
 * section); a design that tracks only the CURRENT root (a bare `_tmpRoot`
 * variable) forgets every earlier one the instant the next section replaces
 * it — that is the actual defect that left 35,000+ directories on this
 * machine. A registry + one removal routine means forgetting is structurally
 * impossible: nothing new can leak without going through `freshEnv()`, and
 * `freshEnv()` always registers what it creates.
 * @type {Set<string>}
 */
const _tmpRoots = new Set();

/**
 * True only for a path that is unambiguously one of THIS suite's own tempdirs
 * — inside the OS temp dir, one path segment down, and named with this
 * suite's own mkdtemp prefix. Cleanup must never be able to remove anything
 * else; a cleanup routine with a path bug is worse than the leak it fixes.
 */
function isOwnTempDir(dir) {
  if (!dir) return false;
  const base = path.resolve(tmpdir());
  const resolved = path.resolve(dir);
  const rel = path.relative(base, resolved);
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !path.isAbsolute(rel) &&
    rel === path.basename(resolved) && // exactly one segment below tmpdir()
    path.basename(resolved).startsWith('curator-queue-test-')
  );
}

/** Async, best-effort removal of every registered tempdir. Never throws. */
async function cleanupTmpRoots() {
  const dirs = Array.from(_tmpRoots);
  _tmpRoots.clear();
  for (const dir of dirs) {
    if (!isOwnTempDir(dir)) {
      console.error(`  (cleanup: refused to remove a path outside this suite's own tempdirs: ${dir})`);
      continue;
    }
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      console.error(`  (cleanup: failed to remove ${dir}: ${err && err.message})`);
    }
  }
}

/**
 * Synchronous last-resort fallback. `process.exit()` does not run pending
 * `finally` blocks or awaited async cleanup, so the primary `cleanupTmpRoots`
 * call (awaited before this suite ever calls `process.exit`) is what runs on
 * every normal exit path — this `process.on('exit', ...)` handler exists only
 * to catch anything unanticipated (e.g. an unhandled rejection that bypasses
 * the try/finally below). It is idempotent: if the primary cleanup already
 * ran, `_tmpRoots` is empty and this is a no-op.
 */
process.on('exit', () => {
  for (const dir of _tmpRoots) {
    if (!isOwnTempDir(dir)) continue;
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort */ }
  }
});

/**
 * @param {{withProviderKey?: boolean, model?: string}} [opts]
 *   `withProviderKey` seeds a FAKE api key into the ISOLATED
 *   .curator-config.json so `getProviderInfo()` resolves to a real, PRICED
 *   model id and the cost estimate produces real numbers. No network call is
 *   ever made with it — every ingest in this suite goes through the fake
 *   `ingestFile` seam, and model pricing is a local table lookup in llm.js.
 *   It is OFF by default so that any accidental path into the REAL ingestFile
 *   fails immediately with "No LLM API key found" instead of attempting a
 *   request.
 */
async function freshEnv({ withProviderKey = false, model = null } = {}) {
  _tmpRoot = await mkdtemp(path.join(tmpdir(), 'curator-queue-test-'));
  _tmpRoots.add(_tmpRoot);
  const userDataDir = path.join(_tmpRoot, 'userdata');
  const domainsDir = path.join(_tmpRoot, 'domains');
  await mkdir(userDataDir, { recursive: true });
  await mkdir(domainsDir, { recursive: true });
  __setUserDataDirOverride(userDataDir);
  __setDomainsDirOverride(domainsDir);
  if (withProviderKey) {
    await writeFile(path.join(userDataDir, '.curator-config.json'), JSON.stringify({
      geminiApiKey: 'offline-test-placeholder-no-request-is-ever-made',
      activeProvider: 'gemini',
    }, null, 2));
  }
  if (model) process.env.LLM_MODEL = model;
  else delete process.env.LLM_MODEL;
  __testing.__resetInMemoryState();
  return { userDataDir, domainsDir };
}

async function makeDomain(slug = 'testdom') {
  await createDomain(slug, 'Test Domain', 'A throwaway domain for the queue test suite.', 'generic');
  return slug;
}

/** Creates a real temp file of `bytes` size and returns a multer-shaped entry. */
async function makeUpload(name, bytes, uploadDir) {
  const p = path.join(uploadDir, `upload-${crypto.randomUUID()}-${path.basename(name).slice(0, 40)}`);
  await writeFile(p, Buffer.alloc(bytes, 'x'));
  const st = await stat(p);
  return { originalname: name, path: p, size: st.size };
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 15 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

const TERMINAL = new Set(['done', 'cancelled', 'failed']);
const ITEM_TERMINAL = new Set(['done', 'failed', 'skipped']);

async function waitTerminal(jobId, opts) {
  return waitFor(async () => {
    const j = await getJob(jobId);
    return j && TERMINAL.has(j.status) ? j : null;
  }, opts);
}
async function waitStatus(jobId, status, opts) {
  return waitFor(async () => {
    const j = await getJob(jobId);
    return j && j.status === status ? j : null;
  }, opts);
}
/**
 * Wait until the job STOPS MOVING — paused or terminal, whichever comes first.
 *
 * FOR TESTS WHOSE FAILURE MODE IS "IT DID NOT PAUSE". `waitStatus(id,'paused')`
 * is the wrong instrument there: a job that runs to `done` instead of pausing
 * fails as `waitFor timed out` after 8 s, with a stack trace and no statement
 * of what went wrong. That is red for the right reason wearing the disguise of
 * a flake, and this repo has twice mistaken one for the other. Waiting for
 * either outcome and asserting on WHICH one arrived turns the same defect into
 * a named assertion that prints the status it actually got.
 */
async function waitSettled(jobId, opts) {
  return waitFor(async () => {
    const j = await getJob(jobId);
    return j && (j.status === 'paused' || TERMINAL.has(j.status)) ? j : null;
  }, opts);
}
/** Waits until the worker loop has fully released the process-wide claim. */
// HAZARD for anyone copying a call to this: it polls the in-memory worker
// claim, so it is only meaningful AFTER an awaited startOrResumeJob() has
// synchronously taken that claim. Called BEFORE a start, it observes the
// still-idle claim, returns immediately, and is decorative — green, and
// guarding nothing. Used at 14 sites; check the ordering at each.
async function waitWorkerIdle(opts) {
  return waitFor(async () => (__testing.getRunningJobId() === null ? true : null), opts);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readManifest(jobId) {
  return JSON.parse(await readFile(path.join(getIngestQueueDir(), jobId, 'manifest.json'), 'utf8'));
}
async function writeManifest(jobId, job) {
  await writeFile(path.join(getIngestQueueDir(), jobId, 'manifest.json'), JSON.stringify(job, null, 2));
}
/** Reads a job's on-disk manifest, applies `mutator`, writes it back. */
async function patchManifest(jobId, mutator) {
  const job = await readManifest(jobId);
  mutator(job);
  await writeManifest(jobId, job);
  return job;
}

/**
 * Builds a fake ingestFile. `plan` maps originalName -> outcome, where an
 * outcome is one of:
 *   'ok'                      -> succeeds
 *   'fail'                    -> throws a generic (non-transient) error
 *   Error instance             -> thrown as-is (use to set curatorTransient)
 *   function(name)             -> called to decide per-call
 * Records every call and, critically, the PEAK number of calls in flight at
 * once — the sequentiality invariant, measured rather than assumed.
 * Mimics the ONE load-bearing behavior of the real ingestFile that this
 * module's correctness depends on: writing raw/<name> as the FIRST step,
 * before anything can fail — see the crash-resume/duplicate test below.
 */
function makeFakeIngestFile(domain, plan = {}, { writeRawFirst = true, tokenUsage = null, delayMs = 5 } = {}) {
  const calls = [];
  let concurrent = 0;
  let peak = 0;
  const fn = async (dom, filePath, originalName, isOverwrite, onProgress) => {
    concurrent++;
    if (concurrent > peak) peak = concurrent;
    calls.push({ name: originalName, dom, isOverwrite });
    try {
      if (writeRawFirst) {
        const dir = rawPath(dom);
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, originalName), await readFile(filePath));
      }
      onProgress && onProgress({ pct: 50, message: 'fake progress' });
      await sleep(delayMs); // let real concurrency show up if it existed
      const outcome = typeof plan[originalName] === 'function' ? plan[originalName](originalName) : plan[originalName];
      if (outcome instanceof Error) throw outcome;
      if (outcome === 'fail') throw new Error(`fake failure for ${originalName}`);
      return {
        title: originalName,
        pagesWritten: ['summaries/x.md', 'entities/y.md'],
        changes: [{ status: 'created' }, { status: 'updated' }],
        warnings: [],
        truncated: false,
        tokenUsage: tokenUsage,
      };
    } finally {
      concurrent--;
    }
  };
  fn.calls = calls;
  fn.peakConcurrency = () => peak;
  fn.hadConcurrencyViolation = () => peak > 1;
  return fn;
}

/**
 * THE accounting invariant, asserted wherever a job reaches a terminal state:
 * every file the user handed over is in exactly one of done / failed /
 * skipped. A 3-file batch reporting "2 done, 0 failed, 0 skipped" is the
 * H1 bug, and it is invisible to any assertion that only checks the ones it
 * expects to have succeeded.
 */
function assertEveryItemAccountedFor(job, label) {
  const total = job.items.length;
  const terminal = job.items.filter(i => ITEM_TERMINAL.has(i.status));
  const stragglers = job.items.filter(i => !ITEM_TERMINAL.has(i.status));
  assert(
    terminal.length === total,
    `${label}: every one of the ${total} item(s) reached a terminal state (done+failed+skipped === item count)`,
    stragglers.length ? `left behind: ${stragglers.map(i => `${i.name}:${i.status}`).join(', ')}` : undefined
  );
}

// ── 1. Sequential execution, under genuine concurrent pressure ──────────────

async function testSequential() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [
    await makeUpload('a.md', 1000, userDataDir),
    await makeUpload('b.md', 1000, userDataDir),
    await makeUpload('c.md', 1000, userDataDir),
  ];
  const fake = makeFakeIngestFile(domain, { 'a.md': 'ok', 'b.md': 'ok', 'c.md': 'ok' });
  const job = await createJob({ domain, uploadedFiles: uploads });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'job completes');
  assertEq(fake.peakConcurrency(), 1, 'peak concurrent ingestFile calls is exactly 1');
  assertEq(fake.calls.length, 3, 'ingestFile called exactly once per item');
  assertEveryItemAccountedFor(final, 'single start');
}

/**
 * THE C1 regression test. Four `startOrResumeJob` calls issued in the SAME
 * synchronous turn, which is what a double-clicked Resume, two open tabs, or
 * a reload mid-POST actually produce.
 *
 * The pre-fix module read its `_runningJobId` flag, then awaited a domain
 * re-validation (listDomains + a CLAUDE.md read per domain) and two manifest
 * writes before setting it — so all four saw `null`, all four started a
 * worker loop, and the measured result was 2 concurrent ingestFile calls and
 * 6 total calls for 3 items (each document ingested twice). The assertions
 * below are on the invariant itself: peak in flight, and total calls.
 */
async function testConcurrentStartsRunOneWorker() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [
    await makeUpload('c0.md', 1000, userDataDir),
    await makeUpload('c1.md', 1000, userDataDir),
    await makeUpload('c2.md', 1000, userDataDir),
  ];
  const fake = makeFakeIngestFile(domain, { 'c0.md': 'ok', 'c1.md': 'ok', 'c2.md': 'ok' }, { delayMs: 25 });
  const job = await createJob({ domain, uploadedFiles: uploads });

  const settled = await Promise.allSettled([
    startOrResumeJob(job.jobId, { ingestFile: fake }),
    startOrResumeJob(job.jobId, { ingestFile: fake }),
    startOrResumeJob(job.jobId, { ingestFile: fake }),
    startOrResumeJob(job.jobId, { ingestFile: fake }),
  ]);
  assertEq(settled.filter(s => s.status === 'rejected').length, 0,
    'four simultaneous starts on the SAME job are idempotent — none is rejected');

  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'the batch completes exactly once');
  assertEq(fake.peakConcurrency(), 1, 'AT MOST ONE ingestFile in flight at any instant, across all four starts');
  assertEq(__testing.getMaxIngestInFlight(), 1, 'the module\'s own in-flight counter also peaked at 1');
  assertEq(fake.calls.length, 3, 'exactly one ingestFile call per item — no document was ingested twice');
  const names = fake.calls.map(c => c.name).sort().join(',');
  assertEq(names, 'c0.md,c1.md,c2.md', 'each of the three documents was ingested exactly once');
  assertEveryItemAccountedFor(final, 'four concurrent starts');

  // The raw/ folder is the durable evidence: a second worker would have
  // re-written each file, and log.md would carry duplicate entries.
  const raws = await readdir(rawPath(domain));
  assertEq(raws.filter(f => f.endsWith('.md')).length, 3, 'raw/ holds exactly three files — no duplicate ingest');
}

/** The same pressure, applied to a job that is ALREADY running. */
async function testConcurrentStartsWhileRunning() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [
    await makeUpload('d0.md', 1000, userDataDir),
    await makeUpload('d1.md', 1000, userDataDir),
    await makeUpload('d2.md', 1000, userDataDir),
    await makeUpload('d3.md', 1000, userDataDir),
  ];
  const fake = makeFakeIngestFile(domain, { 'd0.md': 'ok', 'd1.md': 'ok', 'd2.md': 'ok', 'd3.md': 'ok' }, { delayMs: 30 });
  const job = await createJob({ domain, uploadedFiles: uploads });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  await waitStatus(job.jobId, 'running');

  // Hammer start while item 1 is mid-flight.
  await Promise.allSettled(Array.from({ length: 6 }, () => startOrResumeJob(job.jobId, { ingestFile: fake })));

  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'job still completes normally');
  assertEq(fake.peakConcurrency(), 1, 'six starts against an already-running job never produce a second worker');
  assertEq(fake.calls.length, 4, 'exactly four ingestFile calls for four items');
  assertEveryItemAccountedFor(final, 'starts during run');
}

/** A start for a DIFFERENT job while one is running is refused with 409. */
async function testStartRefusesSecondJob() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const jobA = await createJob({ domain, uploadedFiles: [await makeUpload('e0.md', 1000, userDataDir)] });

  // `createJob` refuses a second active job, so a second startable manifest is
  // planted by hand — the same technique the crash-resume tests use.
  const idB = crypto.randomUUID();
  const manifestB = await readManifest(jobA.jobId);
  manifestB.jobId = idB;
  manifestB.items = manifestB.items.map(i => ({ ...i, stagedPath: null }));
  await mkdir(path.join(getIngestQueueDir(), idB), { recursive: true });
  await writeManifest(idB, manifestB);

  let releaseHold;
  const held = new Promise(res => { releaseHold = res; });
  const slowFake = async (dom, fp, name) => {
    await mkdir(rawPath(dom), { recursive: true });
    await writeFile(path.join(rawPath(dom), name), 'x');
    await held;
    return { title: name, pagesWritten: [], changes: [], warnings: [], tokenUsage: null };
  };
  await startOrResumeJob(jobA.jobId, { ingestFile: slowFake });
  await waitStatus(jobA.jobId, 'running');

  let status = null;
  try { await startOrResumeJob(idB, { ingestFile: slowFake }); }
  catch (err) { status = err.statusCode; }
  assertEq(status, 409, 'starting a DIFFERENT job while one is running is refused with 409');

  releaseHold();
  await waitTerminal(jobA.jobId);
  await rm(path.join(getIngestQueueDir(), idB), { recursive: true, force: true });
}

/**
 * THE flake root cause, as a first-class regression test — and a real
 * user-facing bug, not a test artifact.
 *
 * `settleAsPaused` publishes `paused` to the manifest BEFORE the worker
 * loop's `finally` releases the process-wide claim. A Resume landing in that
 * window used to hit a bare `if (_runningJobId === jobId) return job` and do
 * NOTHING — HTTP 200, status "paused", no worker started, the user clicking
 * Resume and watching nothing happen. Reproduced 5/5 by resuming the instant
 * `paused` became visible; it is also what made this suite ~3% flaky (a
 * timeout in section 4's RESUME, not its pause).
 */
async function testResumeDuringWindDown() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [
    await makeUpload('w0.md', 1000, userDataDir),
    await makeUpload('w1.md', 1000, userDataDir),
    await makeUpload('w2.md', 1000, userDataDir),
  ];
  const rateLimitErr = new Error('⚠ Rate limit hit on Gemini (HTTP 429). Please wait and try again.');
  rateLimitErr.curatorTransient = 'rate_limit';
  const fake = makeFakeIngestFile(domain, { 'w0.md': rateLimitErr, 'w1.md': 'ok', 'w2.md': 'ok' });
  const job = await createJob({ domain, uploadedFiles: uploads });

  // Hitting this window by polling is a RACE — the test passes either way
  // depending on which side of it the poll lands, so it cannot pin the guard
  // (verified: mutating the fix back to the bare no-op left a polling version
  // of this test green). The SSE listener is deterministic instead: `emit` is
  // called SYNCHRONOUSLY from inside `settleJob`, so a listener runs while the
  // worker is still mid-settle — the manifest already says `paused`, the
  // process-wide claim is still held, and the loop's `finally` has not run.
  // That is exactly the state a user's Resume click lands in.
  const fake2 = makeFakeIngestFile(domain, { 'w0.md': 'ok', 'w1.md': 'ok', 'w2.md': 'ok' });
  let resumePromise = null;
  let claimHeldAtResume = null;
  const unsubscribe = subscribeToJob(job.jobId, (ev) => {
    if (resumePromise || !ev || ev.type !== 'done') return;
    if (!ev.job || ev.job.status !== 'paused') return;
    claimHeldAtResume = __testing.getRunningJobId();
    resumePromise = startOrResumeJob(job.jobId, { ingestFile: fake2 });
  });

  await startOrResumeJob(job.jobId, { ingestFile: fake });
  await waitFor(async () => (resumePromise ? true : null));
  unsubscribe();

  assertEq(claimHeldAtResume, job.jobId,
    'sanity: the Resume really was issued while the worker still held the claim (the wind-down window)');
  await resumePromise;

  const final = await waitTerminal(job.jobId, { timeoutMs: 6000 });
  assertEq(final.status, 'done', 'a Resume issued the instant "paused" becomes visible actually resumes');
  assertEq(fake2.peakConcurrency(), 1, 'the resumed run is still strictly sequential');
  assertEq(fake2.calls.length, 3, 'the resumed run processed all three remaining items');
  assertEveryItemAccountedFor(final, 'resume during wind-down');
}

// ── 2. Largest-first ordering ───────────────────────────────────────────────

async function testOrdering() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  // Upload order deliberately scrambled: small, large, medium.
  const uploads = [
    await makeUpload('small.md', 1000, userDataDir),
    await makeUpload('large.md', 9000, userDataDir),
    await makeUpload('medium.md', 5000, userDataDir),
  ];
  const fake = makeFakeIngestFile(domain, { 'small.md': 'ok', 'large.md': 'ok', 'medium.md': 'ok' });
  const job = await createJob({ domain, uploadedFiles: uploads });
  assertEq(job.items.map(i => i.name).join(','), 'large.md,medium.md,small.md', 'manifest items[] already reflects largest-first order');
  assertEq(job.order, 'largest-first', 'job.order is recorded and inspectable');
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  await waitTerminal(job.jobId);
  assertEq(fake.calls.map(c => c.name).join(','), 'large.md,medium.md,small.md', 'ingestFile was actually CALLED in largest-first order');
}

// ── 3. Crash resume + never-auto-start + the duplicate-check regression ─────

async function testCrashResumeGeneral() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [await makeUpload('x.md', 1000, userDataDir), await makeUpload('y.md', 1000, userDataDir)];
  const job = await createJob({ domain, uploadedFiles: uploads });

  // Simulate a crash: hand-edit the manifest to look like the worker died
  // mid-item (this is exactly the shape a real SIGKILL would leave behind,
  // since every transition is a fresh atomic write).
  await patchManifest(job.jobId, j => {
    j.status = 'running';
    j.items[0].status = 'running';
    j.items[0].startedAt = new Date().toISOString();
    j.currentIndex = 0;
  });

  const { recovered } = await recoverOnBoot();
  assert(recovered >= 1, 'recoverOnBoot reports at least one recovered job');

  const after = await getJob(job.jobId);
  assertEq(after.status, 'paused', 'job status is paused after recovery');
  assertEq(after.pausedReason, 'interrupted', 'pausedReason is "interrupted"');
  assertEq(after.items[0].status, 'pending', 'the running item was reset to pending');
  assert(after.items[0].startedAt === null, 'the reset item\'s startedAt was cleared');

  // ── NEVER AUTO-START SPEND. The old assertion read a flag at ONE instant
  // (`getRunningJobId() === null` immediately after the await), which a
  // deferred auto-start — the shape any real auto-start would take, since it
  // would be launched and not awaited — passes trivially. An auditor disabled
  // this guarantee entirely and the suite stayed green. What is asserted now
  // is the thing that costs money: NO INGEST HAPPENED, still true after the
  // event loop has had ample opportunity to run a deferred start.
  await sleep(250);
  assertEq(__testing.getMaxIngestInFlight(), 0, 'recovery never called ingestFile — not once, and not on a later tick');
  assertEq(__testing.getRunningJobId(), null, 'recovery started no worker');
  const stillPaused = await getJob(job.jobId);
  assertEq(stillPaused.status, 'paused', 'the job is still paused 250ms later — nothing resumed itself');
  assertEq(stillPaused.items[0].status, 'pending', 'the recovered item is still waiting for an explicit Resume');

  await requestCancel(job.jobId);
}

/**
 * An item left `running` is never lost — even when the JOB itself is not
 * `running`, which is the case boot recovery used to skip entirely
 * (`job.status !== 'running') continue` repaired JOBS, not ITEMS).
 */
async function testStrandedItemUnderNonRunningJob() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [
    await makeUpload('s0.md', 3000, userDataDir),
    await makeUpload('s1.md', 2000, userDataDir),
    await makeUpload('s2.md', 1000, userDataDir),
  ];
  const job = await createJob({ domain, uploadedFiles: uploads });

  // The exact shape reproduced by the audit: a PAUSED job carrying an item
  // still marked `running`. Invisible to boot recovery (job not running),
  // invisible to the worker (it only selected `pending`), and invisible to
  // the done check (which never looked) — so the batch reported "2 done, 0
  // failed, 0 skipped" for three files.
  await patchManifest(job.jobId, j => {
    j.status = 'paused';
    j.pausedReason = 'user';
    j.items[1].status = 'running';
    j.items[1].startedAt = new Date().toISOString();
  });

  await recoverOnBoot();
  const recovered = await getJob(job.jobId);
  assertEq(recovered.items[1].status, 'pending',
    'boot recovery reclaims a stranded item even though the JOB was not "running"');

  // And the worker reclaims it too, independently of boot recovery — put it
  // back to `running` and start, without any recovery pass in between.
  await patchManifest(job.jobId, j => { j.items[1].status = 'running'; });
  const fake = makeFakeIngestFile(domain, { 's0.md': 'ok', 's1.md': 'ok', 's2.md': 'ok' });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);

  assertEq(final.status, 'done', 'job completes');
  assertEveryItemAccountedFor(final, 'stranded item under a paused job');
  assertEq(fake.calls.filter(c => c.name === 's1.md').length, 1,
    'the stranded item was actually INGESTED, not silently skipped past');
  assertEq(fake.calls.length, 3, 'all three items ran');
}

/** A job may not report `done` while any item is unfinished — the tripwire. */
async function testDoneRefusedWithUnfinishedItem() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [await makeUpload('t0.md', 2000, userDataDir), await makeUpload('t1.md', 1000, userDataDir)];
  const job = await createJob({ domain, uploadedFiles: uploads });

  const fake = makeFakeIngestFile(domain, { 't0.md': 'ok', 't1.md': 'ok' });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'baseline: a fully-processed batch does reach done');

  // LOAD-BEARING, DO NOT DELETE AS REDUNDANT. waitTerminal() above resolves on
  // the manifest reaching a terminal status, which settleJob writes BEFORE the
  // worker loop's finally releases its claim. Those are normally microtasks
  // apart, but the order can invert on a loaded/low-core runner.
  //
  // That matters because of what comes next: we hand-forge `status:'running'`
  // into the manifest, a state the module itself never writes while no loop is
  // live. startOrResumeJob() then refuses to start a worker — but note the
  // trigger is a CONJUNCTION, not the on-disk status alone: the early return
  // at ingest-queue.js:2008 sits inside the loop body entered only when
  // claimSync() at :1988 found the claim ALREADY HELD. With the claim free,
  // control breaks at :1989, the status is re-read at :2020 where 'running'
  // is not terminal, and a worker IS started. So the forgery is only harmful
  // in the window where the claim outlives the terminal manifest write — and
  // in that window nothing ever runs the job, so the waitTerminal() below can
  // never succeed. Not slow: never. Raising the 8 s cap moves nothing; this is
  // a race to remove, not a margin to widen.
  //
  // This is the failure that made the v3.7.0 tag build red while the branch
  // build of the SAME commit passed. Note what it cost: the timeout landed in
  // this SETUP, so the H1 tripwire assertions below never executed at all —
  // measured, the failing run reported 335 passed against 343 with the fix.
  //
  // Reproducing it naturally needs the writer's threadpool thread descheduled
  // between the rename syscall and its completion callback for longer than a
  // read+write round-trip: plausible on a 2-core CI runner, ~1-2 per 150 runs
  // under heavy synthetic load here, and 0 in 90 idle runs. Widening that
  // window artificially (a 60 ms delay after settleJob's terminal write) makes
  // it 12/12 deterministic, which is how the mechanism was confirmed.
  //
  // waitWorkerIdle() is GUARANTEED to terminate by the worker loop's
  // unconditional finally (ingest-queue.js:1955) — though the actual time
  // bound is waitFor's own 8 s cap, not the finally. It is safe HERE
  // specifically because the claim was taken synchronously inside the
  // startOrResumeJob() we already awaited above, so it cannot observe
  // idle-before-start. The sibling forge site below already had this guard;
  // this closes the one symmetric gap that was missed.
  await waitWorkerIdle();

  // Now force the inconsistent state directly and drive a settle through the
  // same chokepoint: an item that is neither done, failed nor skipped.
  await patchManifest(job.jobId, j => {
    j.status = 'running';
    j.items[1].status = 'pending';
  });
  const fake2 = makeFakeIngestFile(domain, { 't1.md': 'ok' });
  await startOrResumeJob(job.jobId, { ingestFile: fake2 });
  const again = await waitTerminal(job.jobId);
  assertEq(again.status, 'done', 'the unfinished item is processed rather than papered over');
  assertEveryItemAccountedFor(again, 'reopened job');
  assertEq(fake2.calls.length, 1, 'exactly the unfinished item was re-run');
  await waitWorkerIdle();

  // ── The tripwire itself, driven DIRECTLY.
  //
  // It is the second of two layers. While `reclaimStrandedItems` works, the
  // state the tripwire refuses cannot arise through the worker — so a test
  // that reached it via the worker would be exercising the FIRST layer and
  // reporting it as coverage of the second. (Verified by mutation: removing
  // only the tripwire leaves every worker-driven test green.) The only
  // honest way to pin it is to ask settleJob for `done` over an unfinished
  // item and check that it refuses.
  await patchManifest(job.jobId, j => {
    j.status = 'running';
    j.items[1].status = 'pending';
  });
  const refused = await __testing.settleJob(job.jobId, { status: 'done' });
  assertEq(refused.status, 'paused', 'settleJob REFUSES to write "done" while an item is unfinished');
  assertEq(refused.pausedReason, 'interrupted', 'and says why');
  assert(refused.pausedMessage.includes('t1.md'), 'naming the file that would otherwise have been silently dropped');
  assert(/Nothing was lost/i.test(refused.pausedMessage), 'and reassuring the user the work is still queued');

  // A settle to `done` over a genuinely finished batch is unaffected.
  await patchManifest(job.jobId, j => { j.status = 'running'; j.items[1].status = 'done'; });
  const allowed = await __testing.settleJob(job.jobId, { status: 'done' });
  assertEq(allowed.status, 'done', 'a genuinely complete batch still settles as done');
}

async function testCrashResumeDuplicateRegression() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [await makeUpload('first.md', 1000, userDataDir), await makeUpload('second.md', 1000, userDataDir)];
  const job = await createJob({ domain, uploadedFiles: uploads });
  // largest-first with equal sizes keeps upload order — first.md, second.md
  const item2 = job.items[1];
  assertEq(item2.name, 'second.md', 'sanity: item under test is second.md');

  // Simulate: second.md's ingest had ALREADY written raw/second.md (the real
  // ingestFile's first internal step) before the crash. This is the exact
  // state a per-item "does raw/<name> already exist?" check would
  // misinterpret as "already ingested, skip".
  await mkdir(rawPath(domain), { recursive: true });
  await writeFile(path.join(rawPath(domain), 'second.md'), 'partial content from the interrupted attempt');

  await patchManifest(job.jobId, j => {
    j.status = 'running';
    j.items[0].status = 'done'; // first.md already finished before the crash
    j.items[1].status = 'running';
    j.items[1].startedAt = new Date().toISOString();
    j.currentIndex = 1;
  });

  await recoverOnBoot();
  const recovered = await getJob(job.jobId);
  assertEq(recovered.status, 'paused', 'job paused after simulated crash');
  assertEq(recovered.items[1].status, 'pending', 'second.md reset to pending, not left running');

  const fake = makeFakeIngestFile(domain, { 'second.md': 'ok' });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);

  assertEq(final.status, 'done', 'job completes after resume');
  assertEq(final.items[1].status, 'done', 'second.md actually RE-RAN and completed — it was NOT skipped as a duplicate');
  assertEq(fake.calls.length, 1, 'ingestFile was called for the resumed item (proves it re-ran, not skipped)');
  assertEveryItemAccountedFor(final, 'crash-resume duplicate regression');
}

// ── 4. Rate limit pauses the batch, does not fail the item ──────────────────

async function testRateLimitPauses() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [
    await makeUpload('f0.md', 1000, userDataDir), await makeUpload('f1.md', 1000, userDataDir),
    await makeUpload('f2.md', 1000, userDataDir), await makeUpload('f3.md', 1000, userDataDir),
    await makeUpload('f4.md', 1000, userDataDir),
  ];
  const rateLimitErr = new Error('⚠ Rate limit hit on Gemini (HTTP 429). Please wait 5 seconds and try again.');
  rateLimitErr.curatorTransient = 'rate_limit';
  const fake = makeFakeIngestFile(domain, { 'f0.md': 'ok', 'f1.md': rateLimitErr, 'f2.md': 'ok', 'f3.md': 'ok', 'f4.md': 'ok' });

  const job = await createJob({ domain, uploadedFiles: uploads });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const paused = await waitStatus(job.jobId, 'paused');

  assertEq(paused.pausedReason, 'rate_limit', 'pausedReason is rate_limit');
  const f0 = paused.items.find(i => i.name === 'f0.md');
  const f1 = paused.items.find(i => i.name === 'f1.md');
  const f2 = paused.items.find(i => i.name === 'f2.md');
  assertEq(f0.status, 'done', 'the item before the rate limit completed');
  assertEq(f1.status, 'pending', 'the rate-limited item is PENDING, not failed — it will be retried, not abandoned');
  assertEq(f2.status, 'pending', 'items after the rate-limited one were never attempted');

  // Resume with a fake that now succeeds everywhere — the batch should finish.
  const fake2 = makeFakeIngestFile(domain, { 'f0.md': 'ok', 'f1.md': 'ok', 'f2.md': 'ok', 'f3.md': 'ok', 'f4.md': 'ok' });
  await startOrResumeJob(job.jobId, { ingestFile: fake2 });
  const done = await waitTerminal(job.jobId);
  assertEq(done.status, 'done', 'batch completes after resume');
  assert(done.items.every(i => i.status === 'done'), 'every item is done after resume');
  assertEq(fake2.calls.length, 4, 'resume only re-ran the items that had not finished (f1..f4)');
  assertEveryItemAccountedFor(done, 'rate-limit resume');
}

// ── 5. A permanent failure does not pause the batch ──────────────────────────

async function testPermanentFailureContinues() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [
    await makeUpload('g0.md', 1000, userDataDir), await makeUpload('g1.md', 1000, userDataDir),
    await makeUpload('g2.md', 1000, userDataDir), await makeUpload('g3.md', 1000, userDataDir),
  ];
  const fake = makeFakeIngestFile(domain, {
    'g0.md': 'ok',
    'g1.md': new Error('"g1.pdf" yielded only 174 characters of text — too little to produce meaningful wiki pages.'),
    'g2.md': 'ok', 'g3.md': 'ok',
  });
  const job = await createJob({ domain, uploadedFiles: uploads });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);

  assertEq(final.status, 'done', 'job reaches done — one bad item does not pause a healthy batch');
  const g1 = final.items.find(i => i.name === 'g1.md');
  assertEq(g1.status, 'failed', 'g1.md is marked failed');
  assert(g1.error.includes('174 characters'), 'the real error message is preserved on the item');
  assert(final.items.filter(i => i.status === 'done').length === 3, 'the other three items completed');
  assertEveryItemAccountedFor(final, 'permanent failure');
}

// ── 6. Consecutive-failure circuit breaker ───────────────────────────────────

async function testCircuitBreakerTrips() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const files = [];
  for (let i = 0; i < 5; i++) files.push(await makeUpload(`h${i}.md`, 1000 - i, userDataDir)); // distinct sizes -> stable order
  // Largest-first with sizes 1000,999,998,997,996 (h0..h4) -> processing order
  // h0,h1,h2,h3,h4. The 3 consecutive failures must NOT be the last items, or
  // there is nothing left to "pause before" and the job simply finishes.
  const fake = makeFakeIngestFile(domain, { 'h0.md': 'fail', 'h1.md': 'fail', 'h2.md': 'fail', 'h3.md': 'ok', 'h4.md': 'ok' });
  const job = await createJob({ domain, uploadedFiles: files });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const paused = await waitStatus(job.jobId, 'paused');
  assertEq(paused.pausedReason, 'consecutive_failures', 'paused with reason consecutive_failures');
  assertEq(paused.consecutiveFailures, CONSECUTIVE_FAILURE_LIMIT, `consecutiveFailures reached the limit (${CONSECUTIVE_FAILURE_LIMIT})`);
  assertEq(paused.items.find(i => i.name === 'h3.md').status, 'pending', 'h3.md (next in line) was never attempted after the breaker tripped');
  assertEq(paused.items.find(i => i.name === 'h4.md').status, 'pending', 'h4.md was never attempted either');
  await requestCancel(job.jobId);
}

async function testCircuitBreakerResetsOnSuccess() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const files = [];
  for (let i = 0; i < 5; i++) files.push(await makeUpload(`k${i}.md`, 1000 - i, userDataDir)); // order k0..k4
  const fake = makeFakeIngestFile(domain, { 'k0.md': 'fail', 'k1.md': 'fail', 'k2.md': 'ok', 'k3.md': 'fail', 'k4.md': 'fail' });
  const job = await createJob({ domain, uploadedFiles: files });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'job reaches done — a mid-batch success reset the breaker so it never tripped');
  assertEq(final.items.filter(i => i.status === 'failed').length, 4, 'all four fail-planned items are marked failed');
  assertEq(final.items.filter(i => i.status === 'done').length, 1, 'the one success completed');
  assertEveryItemAccountedFor(final, 'breaker reset');
}

// ── 7. Transient classification ─────────────────────────────────────────────

async function testTransientClassification() {
  const notTransient = new Error('"g1.pdf" yielded only 429 characters of text — too little to produce meaningful wiki pages.');
  assertEq(classifyTransientError(notTransient), null, '"429 characters of text" is NOT classified as a rate limit');

  const tagged = new Error('some wrapper: original error was lost');
  tagged.curatorTransient = 'rate_limit';
  assertEq(classifyTransientError(tagged), 'rate_limit', 'the structured curatorTransient tag is honoured regardless of message text');

  const real429 = new Error('⚠ Rate limit hit on Gemini (HTTP 429). This is an upstream limit on your API account, not an issue with The Curator.');
  assertEq(classifyTransientError(real429), 'rate_limit', 'the real llm.js 429 message text is classified rate_limit via the fallback pattern');

  const real503 = new Error('⚠ Claude infrastructure is temporarily overloaded (HTTP 503). This is a transient backend issue on the provider\'s side.');
  assertEq(classifyTransientError(real503), 'service_unavailable', 'the real llm.js 503 message text is classified service_unavailable');

  const wrapped = new Error('Ingest failed: ⚠ Rate limit hit on Gemini (HTTP 429). Please retry.');
  assertEq(classifyTransientError(wrapped), 'rate_limit', 'a re-wrapped message still classifies — the "(HTTP nnn)" substring survives the wrap');

  assertEq(classifyTransientError(null), null, 'null input is handled defensively');
  assertEq(classifyTransientError({}), null, 'an object with no message is handled defensively');

  // ── L4: the four UNANCHORED patterns are gone. Each of these strings is
  // exactly what ingest.js produces for a genuine, permanent extraction
  // failure on a file with that NAME. Classified transient, each one paused
  // the batch — and paused it again on every Resume, forever.
  for (const name of ['Service Unavailable', 'Too Many Requests', 'RESOURCE_EXHAUSTED', 'temporarily overloaded']) {
    const err = new Error(`"${name}.pdf" yielded only 12 characters of text — too little to produce meaningful wiki pages.`);
    assertEq(classifyTransientError(err), null,
      `a file named "${name}.pdf" failing extraction is NOT mistaken for a provider error`);
  }

  // And the residual, documented vector is closed for the worker's own call
  // shape by the `ignore` option.
  const named = new Error('"HTTP 429 report.pdf" yielded only 12 characters of text.');
  assertEq(classifyTransientError(named), 'rate_limit', 'documents the residual: the filename itself contains "HTTP 429"');
  assertEq(classifyTransientError(named, { ignore: 'HTTP 429 report.pdf' }), null,
    'passing the item name as `ignore` (which the worker does) closes even that case');
}

/** End-to-end: a badly-named file must not put the batch into a pause loop. */
async function testTransientFalsePositiveDoesNotLoop() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const uploads = [
    await makeUpload('Service Unavailable.md', 2000, userDataDir),
    await makeUpload('after.md', 1000, userDataDir),
  ];
  const fake = makeFakeIngestFile(domain, {
    'Service Unavailable.md': new Error('"Service Unavailable.md" yielded only 12 characters of text — too little to produce meaningful wiki pages.'),
    'after.md': 'ok',
  });
  const job = await createJob({ domain, uploadedFiles: uploads });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'a file NAMED after a provider error fails as one item; the batch does not pause');
  assertEq(final.items.find(i => i.name === 'Service Unavailable.md').status, 'failed', 'it is marked failed, not left pending forever');
  assertEq(final.items.find(i => i.name === 'after.md').status, 'done', 'the next file still ran');
  assertEveryItemAccountedFor(final, 'transient false positive');
}

// ── 8. Budget cap ────────────────────────────────────────────────────────────

async function testBudgetCapWithRealUsage() {
  const { userDataDir } = await freshEnv({ withProviderKey: true });
  const domain = await makeDomain();
  const files = [];
  for (let i = 0; i < 5; i++) files.push(await makeUpload(`m${i}.md`, 1000 - i, userDataDir));
  // gemini-2.5-flash-lite is priced ($0.10 in / $0.40 out per MTok — see
  // MODEL_PRICES_USD_PER_MTOK in llm.js). 1,000,000 in + 0 out => exactly
  // $0.10 per item at full price.
  const tokenUsage = { provider: 'gemini', model: 'gemini-2.5-flash-lite', calls: 1, inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 };
  const fake = makeFakeIngestFile(domain, { 'm0.md': 'ok', 'm1.md': 'ok', 'm2.md': 'ok', 'm3.md': 'ok', 'm4.md': 'ok' }, { tokenUsage });
  // Budget check runs BEFORE starting an item, against spend already
  // accumulated from COMPLETED items. At $0.10/item: after item1 spend is
  // $0.10 (< $0.15, item2 starts); after item2 spend is $0.20 (>= $0.15,
  // paused before item3). So exactly 2 items complete.
  const job = await createJob({ domain, uploadedFiles: files, budgetUsd: 0.15 });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const paused = await waitStatus(job.jobId, 'paused');
  assertEq(paused.pausedReason, 'budget', 'paused with reason budget');
  assert(paused.spentUsd >= 0.15 && paused.spentUsd < 0.30, `spentUsd (${paused.spentUsd}) reflects exactly the completed items' real cost`);
  assertEq(paused.spendIsEstimated, false, 'spendIsEstimated stays false when real tokenUsage was usable');
  const doneCount = paused.items.filter(i => i.status === 'done').length;
  assertEq(doneCount, 2, 'exactly 2 items completed before the cap engaged');
  await requestCancel(job.jobId);
}

async function testBudgetCapWithoutTokenUsage() {
  const { userDataDir } = await freshEnv({ withProviderKey: true });
  const domain = await makeDomain();
  const files = [];
  for (let i = 0; i < 4; i++) files.push(await makeUpload(`n${i}.md`, 60_000 - i, userDataDir));
  const fake = makeFakeIngestFile(domain, { 'n0.md': 'ok', 'n1.md': 'ok', 'n2.md': 'ok', 'n3.md': 'ok' }, { tokenUsage: undefined });
  const job = await createJob({ domain, uploadedFiles: files, budgetUsd: 0.000001 }); // effectively zero
  // No manifest patching: the isolated .curator-config.json seeded by
  // freshEnv({withProviderKey:true}) makes getProviderInfo() resolve to the
  // real, PRICED default model, so `job.estimate.usdHigh` is a genuine number
  // produced by the real estimator. The previous version of this test forced
  // usdHigh onto the manifest by hand and carried a comment acknowledging the
  // real value would be null — which is precisely the case that made the cap
  // inert, sidestepped rather than tested. See testBudgetRefusedWhenUnpriced.
  assert(typeof job.estimate.usdHigh === 'number' && job.estimate.usdHigh > 0,
    `the estimate is a real, positive number (${job.estimate.usdHigh}) — not patched in`);
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const paused = await waitStatus(job.jobId, 'paused');
  assertEq(paused.pausedReason, 'budget', 'the budget cap STILL fires with no real usage data anywhere');
  assertEq(paused.spendIsEstimated, true, 'spendIsEstimated flips true — the UI can say the figure is approximate');
  assert(paused.spentUsd > 0, `spentUsd (${paused.spentUsd}) is non-zero — it did NOT silently stay at 0 forever`);
  await requestCancel(job.jobId);
}

/**
 * ── 8d. THE CACHED-READ MULTIPLIER DECIDES WHEN THE CAP BITES ───────────────
 *
 * `chargeForItem` used to apply ANTHROPIC's 0.1x cached-read discount to EVERY
 * provider. OpenRouter bills cached reads at FULL input price (measured against
 * real credit-balance deltas: a cold run matching actual spend to 8 decimal
 * places as the control, a warm run up to 2.17x UNDER), and Gemini's implicit
 * cache rate is unmeasured — so both now charge full price, which is the
 * over-stating direction and the only safe one on a spend surface.
 *
 * IN THE CHAT VIEW that bug was a misreport. HERE IT IS A CONTROL FAILURE, and
 * this section exists because that does NOT follow from the arithmetic: the cap
 * is enforced in the worker loop, between items, against the accumulated
 * `job.spentUsd`. Under-counting cached reads by 10x let a batch run PAST the
 * ceiling the user set.
 *
 * WHY THE FIXTURE IS SHAPED LIKE THIS. Every item reports 1,000,000 cached-read
 * tokens and NOTHING else, so the charge is the cached-read term alone and the
 * multiplier is the only variable. `gemini-2.5-flash-lite` bills $0.10/MTok
 * input, so per item:
 *
 *     OLD (universal 0.1x):  1e6/1e6 x $0.10 x 0.1  = $0.01
 *     NEW (full price):      1e6/1e6 x $0.10 x 1.0  = $0.10
 *
 * Against a $0.15 cap over 5 items the two differ in OUTCOME, not in a decimal:
 * at $0.10 the cap is reached after item 2 and the job PAUSES with 2 done; at
 * $0.01 it never reaches $0.15 at all and the whole batch runs to `done`. So
 * this asserts a pause the pre-fix code could not have produced, rather than a
 * figure that merely looks different.
 */
async function testBudgetCapChargesCachedReadsAtProviderRate() {
  const { userDataDir } = await freshEnv({ withProviderKey: true });
  const domain = await makeDomain();
  const files = [];
  for (let i = 0; i < 5; i++) files.push(await makeUpload(`c${i}.md`, 1000 - i, userDataDir));
  const tokenUsage = {
    provider: 'gemini', model: 'gemini-2.5-flash-lite', calls: 1,
    inputTokens: 0, outputTokens: 0, cachedReadTokens: 1_000_000, cacheWriteTokens: 0,
  };
  const plan = {};
  for (let i = 0; i < 5; i++) plan[`c${i}.md`] = 'ok';
  const fake = makeFakeIngestFile(domain, plan, { tokenUsage });
  const job = await createJob({ domain, uploadedFiles: files, budgetUsd: 0.15 });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const paused = await waitSettled(job.jobId);
  assertEq(paused.status, 'paused',
    `a GEMINI batch whose entire cost is cached reads STOPS on the cap (got status "${paused.status}" with ${paused.items.filter(i => i.status === 'done').length} item(s) done) — under the old universal 0.1x each item charged $0.01, the cap was never reached, and the whole batch ran to \`done\``);
  assertEq(paused.pausedReason, 'budget', '…and it stopped for the BUDGET, not for some other pause reason');
  assertEq(paused.spendIsEstimated, false,
    'the figure the cap fired on is MEASURED, not an estimate share');
  const doneCount = paused.items.filter(i => i.status === 'done').length;
  assertEq(doneCount, 2, 'exactly 2 items completed before the cap engaged — 5 would mean the discount is still being applied');
  assert(paused.spentUsd >= 0.15 && paused.spentUsd < 0.30,
    `spentUsd (${paused.spentUsd}) is the full-price figure (~$0.20), not the 10x-discounted $0.02 the old formula produced`);
  await requestCancel(job.jobId);
}

/**
 * ── 8e. …AND ANTHROPIC'S DISCOUNT IS STILL APPLIED ─────────────────────────
 *
 * The fix must not become "charge everyone full price". Anthropic's 0.1x
 * cached-read rate is published by the provider and is the one rate this
 * project has a source for, so removing it would be a second wrong number
 * introduced while fixing the first — over-stating instead of under-stating,
 * but still wrong, and it would pause real batches early.
 *
 * Same fixture, same $0.15 cap, ONLY the provider changes. `claude-haiku-4-5`
 * bills $1.00/MTok input, so per item:
 *
 *     WITH the discount:     1e6/1e6 x $1.00 x 0.1 = $0.10  -> cap after item 2
 *     WITHOUT (full price):  1e6/1e6 x $1.00 x 1.0 = $1.00  -> cap after item 1
 *
 * So the assertion is again an item COUNT, and 8d and 8e together pin the SPLIT
 * rather than either half alone: 8d fails if the discount is universal, 8e
 * fails if it has been removed. A single-provider test could not tell those two
 * mistakes apart, and the universal-0.1x formula this release removed passed
 * 8e perfectly.
 */
async function testAnthropicKeepsItsCachedReadDiscount() {
  const { userDataDir } = await freshEnv({ withProviderKey: true });
  const domain = await makeDomain();
  const files = [];
  for (let i = 0; i < 5; i++) files.push(await makeUpload(`a${i}.md`, 1000 - i, userDataDir));
  const tokenUsage = {
    provider: 'anthropic', model: 'claude-haiku-4-5', calls: 1,
    inputTokens: 0, outputTokens: 0, cachedReadTokens: 1_000_000, cacheWriteTokens: 0,
  };
  const plan = {};
  for (let i = 0; i < 5; i++) plan[`a${i}.md`] = 'ok';
  const fake = makeFakeIngestFile(domain, plan, { tokenUsage });
  const job = await createJob({ domain, uploadedFiles: files, budgetUsd: 0.15 });
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const paused = await waitSettled(job.jobId);
  assertEq(paused.status, 'paused', `the cap stops an Anthropic batch too (got status "${paused.status}")`);
  assertEq(paused.pausedReason, 'budget', '…for the BUDGET, not for some other pause reason');
  const doneCount = paused.items.filter(i => i.status === 'done').length;
  assertEq(doneCount, 2,
    'exactly 2 items completed — 1 would mean Anthropic lost its documented 0.1x cached-read discount and is being over-charged 10x');
  assert(paused.spentUsd >= 0.15 && paused.spentUsd < 0.30,
    `spentUsd (${paused.spentUsd}) is the discounted figure (~$0.20 for 2 items at $1.00/MTok x 0.1), not the ~$2.00 full-price one`);
  await requestCancel(job.jobId);
}

/**
 * M1. With a model that has NO published price, `chargeForItem` returned 0
 * from BOTH branches — the real branch has no price, and the estimate
 * fallback divides `estimate.usdHigh`, which the estimator gates on that same
 * price and therefore leaves null. Measured before the fix: a $0.01 cap ran a
 * full 6-file batch to completion with `spentUsd` frozen at 0 while
 * `spendIsEstimated: true` claimed the estimate was in use.
 *
 * Deliberately reproduced through the REAL null-price path (an LLM_MODEL
 * override to an id absent from MODEL_PRICES_USD_PER_MTOK), not by forcing a
 * price onto the manifest.
 */
async function testBudgetRefusedWhenUnpriced() {
  const { userDataDir } = await freshEnv({ withProviderKey: true, model: 'curator-test-model-with-no-published-price' });
  try {
    const domain = await makeDomain();
    const files = [];
    for (let i = 0; i < 3; i++) files.push(await makeUpload(`p${i}.md`, 40_000 - i, userDataDir));

    // Sanity: this really is the unpriced path, not a mis-set-up test.
    const est = await estimateIngestQueueCost(domain, files.map(f => ({ name: f.originalname, size: f.size })));
    assertEq(est.estimate.usdHigh, null, 'sanity: the estimator genuinely cannot price this model');
    assert(est.warnings.some(w => w.includes('No published price')), 'sanity: the estimate says so in a warning');

    let status = null, message = '';
    try {
      await createJob({ domain, uploadedFiles: files, budgetUsd: 0.01 });
    } catch (err) { status = err.statusCode; message = err.message; }
    assertEq(status, 400, 'a budget cap that CANNOT be enforced is refused at create, not silently accepted');
    assert(/spending cap/i.test(message) && /published price/i.test(message),
      'the refusal explains why, naming the missing price');
    assert(!/\$0\.00/.test(message) || /reporting \$0\.00/.test(message),
      'the message describes the failure mode rather than showing a fake figure');

    const active = await getActiveJob();
    assertEq(active, null, 'the refused create left NO job behind on disk');

    // The same batch without a cap is still allowed — refusing the cap must
    // not refuse the feature.
    //
    // NOTE: fresh uploads, deliberately. `createJob` consumes (unlinks) the
    // caller's temp files as it stages them, so re-using `files` here would
    // have every item fail to stage — the batch would still reach `done` (an
    // all-terminal job with nothing to run) and every assertion below would
    // pass without a single ingest having happened. Found while mutation-
    // testing M4: the section threw only once per-file isolation was removed,
    // which is what exposed that it had been passing for the wrong reason.
    const fresh = [];
    for (let i = 0; i < 3; i++) fresh.push(await makeUpload(`q${i}.md`, 40_000 - i, userDataDir));
    const fake = makeFakeIngestFile(domain, { 'q0.md': 'ok', 'q1.md': 'ok', 'q2.md': 'ok' });
    const job = await createJob({ domain, uploadedFiles: fresh });
    assertEq(job.budgetUsd, null, 'an uncapped batch on an unpriced model is created normally');
    assertEq(job.items.filter(i => i.status === 'pending').length, 3, 'all three files staged and are queued to run');
    await startOrResumeJob(job.jobId, { ingestFile: fake });
    const final = await waitTerminal(job.jobId);
    assertEq(final.status, 'done', 'and it runs to completion');
    assertEq(fake.calls.length, 3, 'all three files were actually ingested (not vacuously "done")');
    assertEveryItemAccountedFor(final, 'unpriced uncapped batch');
  } finally {
    delete process.env.LLM_MODEL;
  }
}

// ── 9. Pause / cancel / delete state machine ─────────────────────────────────

async function testStateMachine() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();

  // Pausing a job that was never started settles immediately.
  {
    const files = [await makeUpload('p0.md', 1000, userDataDir)];
    const job = await createJob({ domain, uploadedFiles: files });
    const paused = await requestPause(job.jobId);
    assertEq(paused.status, 'paused', 'pausing a never-started (pending) job settles it immediately');
    await requestCancel(job.jobId);
  }

  // Cancel deletes staged files for items that never ran.
  {
    const files = [await makeUpload('q0.md', 1000, userDataDir), await makeUpload('q1.md', 1000, userDataDir), await makeUpload('q2.md', 1000, userDataDir)];
    const job = await createJob({ domain, uploadedFiles: files });
    const stagedPaths = job.items.map(i => path.join(getIngestQueueDir(), job.jobId, 'files', `${i.idx}-${i.name}`));
    for (const p of stagedPaths) assert(existsSync(p), `staged file exists before cancel: ${path.basename(p)}`);
    const cancelled = await requestCancel(job.jobId);
    assertEq(cancelled.status, 'cancelled', 'job status is cancelled');
    for (const p of stagedPaths) assert(!existsSync(p), `staged file removed after cancel: ${path.basename(p)}`);
  }

  // Delete refuses while running; succeeds once terminal.
  {
    const files = [await makeUpload('r0.md', 1000, userDataDir)];
    let releaseHold;
    const held = new Promise(res => { releaseHold = res; });
    const slowFake = async (dom, filePath, originalName) => {
      await mkdir(rawPath(dom), { recursive: true });
      await writeFile(path.join(rawPath(dom), originalName), 'x');
      await held; // block until the test releases it
      return { title: originalName, pagesWritten: [], changes: [], warnings: [], truncated: false, tokenUsage: null };
    };
    const job = await createJob({ domain, uploadedFiles: files });
    await startOrResumeJob(job.jobId, { ingestFile: slowFake });
    await waitStatus(job.jobId, 'running');
    let refused = false;
    try { await deleteJobEverything(job.jobId); } catch (err) { refused = err.statusCode === 409; }
    assert(refused, 'DELETE refuses a running job with 409');
    releaseHold();
    const done = await waitTerminal(job.jobId);
    assertEq(done.status, 'done', 'sanity: the held job completed once released');
    await waitWorkerIdle();
    await deleteJobEverything(job.jobId);
    assert(!existsSync(path.join(getIngestQueueDir(), job.jobId)), 'DELETE removed the job directory entirely once terminal');
  }

  // Cancel during wind-down actually cancels (it used to set a flag no loop
  // would ever read, leaving the job paused).
  {
    const files = [await makeUpload('u0.md', 2000, userDataDir), await makeUpload('u1.md', 1000, userDataDir)];
    const rl = new Error('⚠ Rate limit hit (HTTP 429).');
    rl.curatorTransient = 'rate_limit';
    const fake = makeFakeIngestFile(domain, { 'u0.md': rl, 'u1.md': 'ok' });
    const job = await createJob({ domain, uploadedFiles: files });

    // Same deterministic construction as the Resume test: cancel from inside
    // the synchronous `emit`, while the claim is still held but the job is no
    // longer `running`. Testing the claim ALONE (as the pre-fix code did) set
    // a flag no loop would ever read, so the job stayed paused instead of
    // cancelling. Polling for this window is a race and cannot pin it.
    let cancelPromise = null;
    let claimHeld = null;
    const unsub = subscribeToJob(job.jobId, (ev) => {
      if (cancelPromise || !ev || ev.type !== 'done') return;
      if (!ev.job || ev.job.status !== 'paused') return;
      claimHeld = __testing.getRunningJobId();
      cancelPromise = requestCancel(job.jobId);
    });
    await startOrResumeJob(job.jobId, { ingestFile: fake });
    await waitFor(async () => (cancelPromise ? true : null));
    unsub();
    assertEq(claimHeld, job.jobId, 'sanity: the cancel was issued inside the wind-down window');
    const cancelled = await cancelPromise;
    assertEq(cancelled.status, 'cancelled', 'a cancel issued during worker wind-down really cancels');
    await waitWorkerIdle();
    const onDisk = await getJob(job.jobId);
    assertEq(onDisk.status, 'cancelled', 'and it is cancelled on disk, not left paused');
  }
}

// ── 10. Manifest resilience + a corrupt manifest is still deletable ──────────

async function testManifestResilience() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const files = [await makeUpload('v0.md', 1000, userDataDir), await makeUpload('v1.md', 1000, userDataDir)];
  const fake = makeFakeIngestFile(domain, { 'v0.md': 'ok', 'v1.md': 'ok' });
  const job = await createJob({ domain, uploadedFiles: files });

  async function assertParseable(label) {
    const raw = await readFile(path.join(getIngestQueueDir(), job.jobId, 'manifest.json'), 'utf8');
    try { JSON.parse(raw); ok(`manifest parses as JSON: ${label}`); }
    catch (e) { fail(`manifest parses as JSON: ${label}`, e.message); }
  }
  await assertParseable('after create');
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  await assertParseable('right after start');
  await waitTerminal(job.jobId);
  await assertParseable('after completion');
  await waitWorkerIdle();

  // A second, deliberately corrupt job manifest sits alongside a healthy one.
  const corruptId = crypto.randomUUID();
  await mkdir(path.join(getIngestQueueDir(), corruptId), { recursive: true });
  await writeFile(path.join(getIngestQueueDir(), corruptId, 'manifest.json'), '{ this is not valid JSON');
  await writeFile(path.join(getIngestQueueDir(), corruptId, 'stray-staged-file.md'), 'x'.repeat(1024));

  let threw = false;
  let result;
  try { result = await recoverOnBoot(); } catch { threw = true; }
  assert(!threw, 'recoverOnBoot does not throw when one job\'s manifest is corrupt');
  assert(result && typeof result.recovered === 'number', 'recoverOnBoot still returns a usable result despite the corrupt sibling');

  const jobs = await listJobs();
  assert(Array.isArray(jobs), 'listJobs() still works with a corrupt manifest present');
  assert(!jobs.some(j => j.jobId === corruptId), 'the corrupt job is silently excluded from listJobs(), not crashed on');

  // M3: routing delete through a PARSED manifest made a corrupt job
  // permanently undeletable — 404 forever, invisible to GET / and /active,
  // its directory unreachable through the API and its disk unreclaimable.
  let deleteErr = null;
  try { await deleteJobEverything(corruptId); } catch (err) { deleteErr = err; }
  assertEq(deleteErr, null, 'a job with a CORRUPT manifest can still be deleted');
  assert(!existsSync(path.join(getIngestQueueDir(), corruptId)), 'its directory (and staged bytes) are actually gone');

  // A job id that has no directory at all is still a clean 404.
  let missing = null;
  try { await deleteJobEverything(crypto.randomUUID()); } catch (err) { missing = err.statusCode; }
  assertEq(missing, 404, 'deleting a job that does not exist is a 404, not a silent success');
}

// ── 11. The wire representation: no leaks, no unknown fields, bounded ───────

async function testWireRepresentation() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();

  // ── scrubPaths, DIRECTION (a): every leak shape must be scrubbed.
  //
  // The first implementation excluded whitespace from its character class, so
  // a match stopped at the first space and echoed the rest verbatim — and a
  // path with a space in it is the COMMON case on macOS and Windows, not a
  // corner case. The test that shipped with it only used space-free paths, so
  // it was green on exactly the inputs that already worked. Every case below
  // was measured leaking through a real toWire.
  const LEAK_CASES = [
    ["ENOENT: no such file or directory, open '/private/tmp/curator-x/domains/testdom/wiki/log.md'",
      ['/private/tmp', 'curator-x', 'testdom'], 'log.md', 'space-free POSIX path (the case that always worked)'],
    ["ENOENT: no such file or directory, open '/Users/alice smith/Google Drive/My Drive/wiki/log.md'",
      ['alice smith', 'Google Drive', 'My Drive', '/Users/'], 'log.md', 'SPACES in the user name and folder names'],
    ["EACCES: permission denied, open 'C:\\Users\\Alice Smith\\AppData\\Curator\\x.md'",
      ['Alice Smith', 'AppData', 'Curator', 'Users'], 'x.md', 'Windows drive path with a spaced user name'],
    ["ENOENT: open '/Users/t/Dropbox (Personal)/notes/a.md'",
      ['Dropbox', 'Personal', 'notes'], 'a.md', 'parenthesised folder (Dropbox (Personal))'],
    ["ENOENT: open '/Volumes/My Book/archive/b.md'",
      ['My Book', 'Volumes', 'archive'], 'b.md', 'spaced mount point (/Volumes/My Book)'],
    ["ENOENT: open '/Users/t/OneDrive - Company/c.md'",
      ['OneDrive', 'Company'], 'c.md', 'dash-separated folder (OneDrive - Company)'],
    ["ENAMETOOLONG: name too long, copyfile '/var/folders/aa/T/af fe224' -> '/Users/some one/queue/files/0-x.pdf'",
      ['/Users/', 'some one', '/var/folders', 'queue'], '0-x.pdf', 'BOTH paths of a copyfile error, each with spaces'],
    ['/Users/alice smith/Documents/x.md is missing',
      ['alice smith', 'Documents', '/Users/'], 'x.md', 'UNQUOTED spaced path'],
    ['C:\\Users\\Alice Smith\\AppData\\x.md could not be read',
      ['Alice Smith', 'AppData'], 'x.md', 'UNQUOTED Windows path'],
    ["open '/Users/alice smith/Docs/x.md",
      ['alice smith', 'Docs', '/Users/'], 'x.md', 'UNTERMINATED quote (falls through to the bare pass)'],
    ['/Users/t/A B C D E F/x.md',
      ['A B C D E F'], 'x.md', 'unquoted path with a six-word folder name'],
  ];
  for (const [input, secrets, keep, label] of LEAK_CASES) {
    const out = scrubPaths(input);
    const leaked = secrets.filter(sec => out.includes(sec));
    assert(leaked.length === 0, `scrubPaths hides the filesystem: ${label}`,
      leaked.length ? `still leaks ${JSON.stringify(leaked)} — got: ${out}` : undefined);
    assert(out.includes(keep), `scrubPaths keeps the basename (${keep}), which is the useful half: ${label}`);
  }

  // ── DIRECTION (b): a normal message must stay READABLE.
  //
  // Without this, "just scrub more aggressively" is an invisible regression:
  // the leak tests above would stay green while every error message the user
  // depends on quietly lost its explanation. These must survive byte-identical.
  const PROSE_CASES = [
    '"g1.pdf" yielded only 174 characters of text — too little to produce meaningful wiki pages.',
    'summaries/my-page.md is fine and entities/x.md too',
    'See https://ai.google.dev/pricing for current rates, or switch provider in Settings.',
    'Paused — the AI provider rate-limited this request. "report.pdf" will be retried first on resume.',
    'Try: macOS Preview → Tools → Adjust Text → OCR, or run ocrmypdf, and/or paste the text.',
    'MODEL_PRICES_USD_PER_MTOK in src/brain/llm.js has no entry for this model.',
    'Another file in this batch is also called "report.pdf". Only the first was ingested.',
  ];
  for (const msg of PROSE_CASES) {
    assertEq(scrubPaths(msg), msg, `an ordinary message survives the scrubber byte-identical: "${msg.slice(0, 46)}…"`);
  }
  // A path embedded in prose loses the path and KEEPS the sentence.
  //
  // These three pin the UPPER bound of BARE_PATH_SPACE_BRIDGE, which the
  // leak cases above cannot: widening the bridge fixes nothing they test and
  // silently starts swallowing whole sentences. Each of these is a message a
  // user would need to read, and each loses its explanation the moment the
  // bridge is widened enough to reach a later separator.
  const MIXED_CASES = [
    ['/a/b.md was not found, check entities/c.md', ['was not found', 'entities/c.md'], 'comma-separated'],
    ['/a/b.md was not found please check entities/c.md', ['was not found please check', 'entities/c.md'], 'four-word gap, no punctuation'],
    ['/a/b.md is missing and so is /c/d.md', ['is missing and so is', 'd.md'], 'two absolute paths with prose between them'],
    ['Paused before /a/b.md and the batch still has entities/c.md to write', ['and the batch still has', 'to write'], 'path mid-sentence'],
  ];
  for (const [input, mustKeep, label] of MIXED_CASES) {
    const mixed = scrubPaths(input);
    assert(!/(?:^|\s)\/a\//.test(mixed), `the absolute path in a mixed message is scrubbed: ${label}`);
    for (const keep of mustKeep) {
      assert(mixed.includes(keep), `…and the prose around it survives ("${keep}"): ${label}`,
        `got: ${mixed}`);
    }
  }
  assertEq(scrubPaths(null), null, 'scrubPaths is defensive about non-strings');
  // Bounded: a pathological input must not hang the response path.
  {
    const t0 = Date.now();
    scrubPaths('/a' + ' b'.repeat(20000) + ' end');
    scrubPaths('/' + 'a/'.repeat(20000) + 'x y '.repeat(50));
    const ms = Date.now() - t0;
    assert(ms < 1000, `scrubPaths does not backtrack catastrophically on adversarial input (${ms}ms)`);
  }

  {
    const files = [await makeUpload('a0.md', 1000, userDataDir)];
    const fake = makeFakeIngestFile(domain, { 'a0.md': 'ok' });
    const job = await createJob({ domain, uploadedFiles: files });
    await startOrResumeJob(job.jobId, { ingestFile: fake });
    const done = await waitTerminal(job.jobId);

    const wire = toWire(done);
    assert(!wire.items.some(i => Object.hasOwn(i, 'stagedPath')), 'toWire() strips stagedPath from every item');
    assert(!Object.hasOwn(wire, 'stagedPath'), 'toWire() has no top-level stagedPath');

    // The allow-list, tested as an allow-list: an unknown field must NOT
    // survive. The old `...rest` spread echoed everything it did not
    // recognise, so any future internal field leaked BY DEFAULT.
    const tainted = JSON.parse(JSON.stringify(done));
    tainted.secretInternalField = '/Users/someone/.curator-config.json';
    tainted.items[0].anotherInternalField = '/private/tmp/whatever/x';
    const taintedWire = toWire(tainted);
    assert(!Object.hasOwn(taintedWire, 'secretInternalField'), 'an UNKNOWN top-level field is dropped, not echoed');
    assert(!Object.hasOwn(taintedWire.items[0], 'anotherInternalField'), 'an UNKNOWN item field is dropped, not echoed');

    // Absolute paths embedded in prose are scrubbed at this chokepoint —
    // asserted END-TO-END through the real toWire, using the SPACED shapes
    // that the first scrubber echoed verbatim rather than the space-free ones
    // it happened to handle.
    const pathy = JSON.parse(JSON.stringify(done));
    pathy.items[0].error = "ENOENT: no such file or directory, open '/Users/alice smith/Google Drive/My Drive/wiki/log.md'";
    pathy.pausedMessage = "ENAMETOOLONG: copyfile '/var/folders/aa/T/af fe' -> '/Users/some one/queue/files/0-x.pdf'";
    pathy.failReason = "EACCES: permission denied, open 'C:\\Users\\Alice Smith\\AppData\\Curator\\x.md'";
    const pathyWire = toWire(pathy);
    const asJson = JSON.stringify(pathyWire);
    for (const secret of ['/Users/', '/var/folders', 'alice smith', 'Google Drive', 'My Drive', 'some one', 'Alice Smith', 'AppData']) {
      assert(!asJson.includes(secret), `no filesystem detail survives toWire(): "${secret}"`);
    }
    assert(asJson.includes('log.md') && asJson.includes('0-x.pdf') && asJson.includes('x.md'),
      'the basenames DO survive toWire() — the messages stay useful');

    // Bounded. A planted 48 MB manifest came back whole (a measured 50 MB
    // GET / response) because the spread copied whatever was there.
    const huge = JSON.parse(JSON.stringify(done));
    huge.items[0].error = 'E'.repeat(5 * 1024 * 1024);
    huge.pausedMessage = 'P'.repeat(5 * 1024 * 1024);
    huge.estimate = { ...huge.estimate, basis: 'B'.repeat(5 * 1024 * 1024) };
    huge.items = Array.from({ length: 5000 }, (_, i) => ({ ...huge.items[0], idx: i }));
    const hugeWire = toWire(huge);
    const bytes = Buffer.byteLength(JSON.stringify(hugeWire));
    assert(bytes < 2 * 1024 * 1024, `a deliberately huge manifest serialises to a bounded response (${bytes} bytes)`);
    assertEq(hugeWire.itemsTruncated, true, 'the response says so when items were truncated');
    assertEq(hugeWire.itemCount, 5000, 'and still reports the true item count');
  }

  // The SSE listener map must not grow one permanent entry per job ever
  // streamed: `unsubscribe` deleted the listener but left the empty Set
  // behind, so a long-running server leaked one Map entry per job forever.
  {
    const before = __testing.getListenerJobCount();
    const un1 = subscribeToJob('11111111-1111-1111-1111-111111111111', () => {});
    const un2 = subscribeToJob('11111111-1111-1111-1111-111111111111', () => {});
    assertEq(__testing.getListenerJobCount(), before + 1, 'two listeners on one job add exactly one map entry');
    un1();
    assertEq(__testing.getListenerJobCount(), before + 1, 'the entry stays while a second listener is still attached');
    un2();
    assertEq(__testing.getListenerJobCount(), before, 'unsubscribing the LAST listener removes the entry — no permanent growth');
  }

  // The `item-progress` SSE frame carries a message produced OUTSIDE this
  // module (ingest.js's progress callback), so it does not pass through
  // toWire's job-shaped allow-list and needs its own scrub.
  {
    const files = [await makeUpload('pg0.md', 1000, userDataDir)];
    const job = await createJob({ domain, uploadedFiles: files });
    const frames = [];
    const un = subscribeToJob(job.jobId, ev => frames.push(ev));
    const leaky = async (dom, filePath, originalName, isOverwrite, onProgress) => {
      await mkdir(rawPath(dom), { recursive: true });
      await writeFile(path.join(rawPath(dom), originalName), 'x');
      onProgress({ pct: 50, message: `Reading /Users/someone/Documents/${originalName} from disk` });
      onProgress({ pct: 60, message: 'M'.repeat(5000) });
      return { title: originalName, pagesWritten: [], changes: [], warnings: [], tokenUsage: null };
    };
    await startOrResumeJob(job.jobId, { ingestFile: leaky });
    await waitTerminal(job.jobId);
    un();
    await waitWorkerIdle();
    const progressFrames = frames.filter(f => f.type === 'item-progress');
    assert(progressFrames.length >= 2, 'item-progress frames were emitted');
    const asJson = JSON.stringify(progressFrames);
    assert(!asJson.includes('/Users/'), 'an absolute path in a progress message is scrubbed before it reaches SSE');
    assert(progressFrames.every(f => !f.message || f.message.length <= 520), 'a runaway progress message is length-bounded');
  }

  // Every terminal state, checked for leaks.
  for (const [label, build] of Object.entries({
    cancelled: async () => {
      const job = await createJob({ domain, uploadedFiles: [await makeUpload('b0.md', 1000, userDataDir)] });
      return requestCancel(job.jobId);
    },
    'done-with-a-failed-item': async () => {
      const fake = makeFakeIngestFile(domain, { 'c0.md': 'fail' });
      const job = await createJob({ domain, uploadedFiles: [await makeUpload('c0.md', 1000, userDataDir)] });
      await startOrResumeJob(job.jobId, { ingestFile: fake });
      const j = await waitTerminal(job.jobId);
      await waitWorkerIdle();
      return j;
    },
  })) {
    const j = await build();
    const wire = toWire(j);
    assert(!wire.items.some(i => Object.hasOwn(i, 'stagedPath')), `toWire() strips stagedPath: ${label}`);
    assert(!/\/(Users|private|var)\//.test(JSON.stringify(wire)), `no absolute path anywhere in the wire payload: ${label}`);
  }
}

// ── 11b. A pending pause/cancel is VISIBLE on the wire ─────────────────────

/**
 * v3.3.0 field report: "Cancel doesn't work." It did work — the worker honours
 * the request between items, which is correct, because aborting mid-ingestFile
 * would leave partial wiki state. But a cancel of a 76 KB multi-phase document
 * takes minutes to take effect, and `toWire`'s allow-list did not expose the
 * request, so every snapshot the UI applied still read `status: running` with
 * the item running. The user had no way to tell the click had registered and
 * reasonably concluded the button was broken.
 *
 * The flags are IN-PROCESS (`_controlFlags`) while the job lives on disk, so
 * these assertions pin three things a naive implementation gets wrong:
 * they must be read LIVE at serialisation time (so a second polling tab sees
 * what the clicking tab sees), they must be strict `false` rather than
 * `undefined` for a job with no flags entry, and they must never be persisted.
 */
async function testPendingRequestIsVisible() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();

  for (const [action, request, field, endState] of [['cancel', requestCancel, 'cancelRequested', 'cancelled'],
                                                   ['pause', requestPause, 'pauseRequested', 'paused']]) {
    const files = [
      await makeUpload(`${action}0.md`, 3000, userDataDir),
      await makeUpload(`${action}1.md`, 2000, userDataDir),
    ];
    let release;
    const held = new Promise(r => { release = r; });
    const slowFake = async (dom, fp, name) => {
      await mkdir(rawPath(dom), { recursive: true });
      await writeFile(path.join(rawPath(dom), name), 'x');
      await held;   // stands in for a multi-phase ingest still running
      return { title: name, pagesWritten: [], changes: [], warnings: [], tokenUsage: null };
    };

    const job = await createJob({ domain, uploadedFiles: files });
    const frames = [];
    const unsub = subscribeToJob(job.jobId, ev => frames.push(ev));
    await startOrResumeJob(job.jobId, { ingestFile: slowFake });
    // Wait for an ITEM to be in flight, not merely for the job to say
    // `running` — `startOrResumeJob` writes that status before the worker
    // picks anything up, which is a beat too early to reproduce the reported
    // moment (a file genuinely mid-ingest when the user clicks).
    await waitFor(async () => {
      const j = await getJob(job.jobId);
      return j && j.items.some(i => i.status === 'running') ? j : null;
    });

    // Before the click: nothing pending.
    const before = toWire(await getJob(job.jobId));
    assertEq(before[field], false, `${field} is false before the user clicks ${action}`);

    await request(job.jobId);

    // THE ASSERTION THE FIELD REPORT IS ABOUT: the request is visible while the
    // job is still running and the in-flight item has not finished.
    const during = toWire(await getJob(job.jobId));
    assertEq(during.status, 'running', `the job is still running right after ${action} (the in-flight item finishes first)`);
    assertEq(during[field], true, `${field} is TRUE on the wire immediately after ${action}, before the job settles`);
    assertEq(during.items[0].status, 'running', 'and the in-flight item is genuinely still running — this is the exact moment the UI looked broken');

    // A SECOND consumer polling GET /:jobId must see the same thing — this is
    // what "read live, do not snapshot" buys.
    const secondTab = toWire(await getJob(job.jobId));
    assertEq(secondTab[field], true, `a second tab polling the job sees the same pending ${action}`);

    // And it reaches SSE, not just REST — the frontend renders from whichever
    // arrives first.
    frames.length = 0;
    release();
    const settled = await waitStatus(job.jobId, endState);
    unsub();
    const jobFrames = frames.filter(f => f.type === 'job' || f.type === 'done');
    assert(jobFrames.length > 0, `SSE job frames were emitted around the ${action}`);
    assert(jobFrames.every(f => typeof f.job[field] === 'boolean'),
      `every SSE job frame carries ${field} as a real boolean`);
    assertEq(settled.status, endState, `the ${action} took effect once the in-flight item finished`);
    await waitWorkerIdle();
  }
}

/**
 * A job recovered after a restart has NO `_controlFlags` entry. Both fields
 * must serialise as `false` — `undefined` would read to the frontend as "this
 * server does not report the field" rather than "no request is pending", and
 * would also vanish from the JSON entirely.
 */
async function testFlagsDefaultFalseAndAreNotPersisted() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const files = [await makeUpload('pf0.md', 2000, userDataDir), await makeUpload('pf1.md', 1000, userDataDir)];
  const job = await createJob({ domain, uploadedFiles: files });

  // Fresh job, no flags entry at all — the post-restart shape.
  __testing.__resetInMemoryState();
  const wire = toWire(await getJob(job.jobId));
  assertEq(wire.cancelRequested, false, 'a job with no in-process flags serialises cancelRequested as false');
  assertEq(wire.pauseRequested, false, 'a job with no in-process flags serialises pauseRequested as false');
  assert(Object.hasOwn(wire, 'cancelRequested') && Object.hasOwn(wire, 'pauseRequested'),
    'the fields are always PRESENT, never omitted — the UI can rely on them existing');
  assert(typeof wire.cancelRequested === 'boolean' && typeof wire.pauseRequested === 'boolean',
    'and they are strict booleans, never undefined');

  // They must never reach the manifest: a cancel requested before a restart
  // must not silently stop a job the user later chooses to resume.
  let release;
  const held = new Promise(r => { release = r; });
  const slowFake = async (dom, fp, name) => {
    await mkdir(rawPath(dom), { recursive: true });
    await writeFile(path.join(rawPath(dom), name), 'x');
    await held;
    return { title: name, pagesWritten: [], changes: [], warnings: [], tokenUsage: null };
  };
  await startOrResumeJob(job.jobId, { ingestFile: slowFake });
  await waitStatus(job.jobId, 'running');
  await requestCancel(job.jobId);
  assertEq(toWire(await getJob(job.jobId)).cancelRequested, true, 'sanity: the request is live on the wire');

  const rawManifest = await readFile(path.join(getIngestQueueDir(), job.jobId, 'manifest.json'), 'utf8');
  assert(!/cancelRequested/.test(rawManifest), 'cancelRequested is NOT written to the on-disk manifest');
  assert(!/pauseRequested/.test(rawManifest), 'pauseRequested is NOT written to the on-disk manifest');
  const parsed = JSON.parse(rawManifest);
  assert(!Object.hasOwn(parsed, 'cancelRequested') && !Object.hasOwn(parsed, 'pauseRequested'),
    'and toWire did not mutate the job object on its way through');

  release();
  await waitTerminal(job.jobId);
  await waitWorkerIdle();

  // After a simulated restart the recovered job carries no pending request.
  __testing.__resetInMemoryState();
  const afterRestart = toWire(await getJob(job.jobId));
  assertEq(afterRestart.cancelRequested, false, 'after a restart the stale cancel request is gone, not resurrected');
  assertEq(afterRestart.pauseRequested, false, 'same for pauseRequested');
}

// ── 12. Gitignore invariants ─────────────────────────────────────────────────

async function testGitignoreInvariants() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');
  assert(gitignore.includes('.ingest-queue/'), '.gitignore contains .ingest-queue/');

  const syncSrc = await readFile(path.join(repoRoot, 'src/brain/sync.js'), 'utf8');
  const rulesBlockMatch = syncSrc.match(/DOMAINS_GITIGNORE_RULES\s*=\s*\[([\s\S]*?)\];/);
  assert(!!rulesBlockMatch, 'DOMAINS_GITIGNORE_RULES array found in sync.js');
  assert(!!rulesBlockMatch && rulesBlockMatch[1].includes('.ingest-queue/'), 'DOMAINS_GITIGNORE_RULES includes .ingest-queue/');

  // Under default config (domains dir defaulting under the SAME user-data
  // root as everything else — the pathological case this rule defends
  // against), the queue dir must not be a subpath of the domains dir.
  await freshEnv();
  __setDomainsDirOverride(null); // let domains fall back to its default under the same user-data root
  const qDir = getIngestQueueDir();
  const dDir = getDomainsDir();
  assert(qDir !== dDir, 'queue dir and domains dir are different paths');
  assert(!qDir.startsWith(dDir + path.sep), 'queue dir is not nested inside the domains dir');
  assert(!dDir.startsWith(qDir + path.sep), 'domains dir is not nested inside the queue dir');
}

// ── 13. Path traversal + staged-name hygiene ────────────────────────────────

async function testPathTraversal() {
  const badIds = ['../../etc/passwd', '/etc/passwd', 'not-a-uuid', '..', '', null, undefined, '00000000-0000-0000-0000-00000000000g'];
  for (const id of badIds) {
    assert(!isValidJobId(id), `isValidJobId rejects: ${JSON.stringify(id)}`);
  }
  assert(isValidJobId(crypto.randomUUID()), 'isValidJobId accepts a real UUID');

  const result = await getJob('../../../../etc/passwd');
  assertEq(result, null, 'getJob returns null for a traversal-shaped id without touching disk');

  const sanitized = __testing.sanitizeBaseName('../../evil.md');
  assert(!sanitized.includes('/') && !sanitized.includes('\\'), `sanitizeBaseName strips path separators: got "${sanitized}"`);
  assertEq(sanitized, 'evil.md', 'sanitizeBaseName collapses a traversal-shaped name to its basename');

  const dotdot = __testing.sanitizeBaseName('..');
  const joined = path.join(__testing.filesDir('00000000-0000-0000-0000-000000000000'), `0-${dotdot}`);
  assertEq(path.dirname(joined), __testing.filesDir('00000000-0000-0000-0000-000000000000'), 'a bare ".." name, once index-prefixed, cannot escape the staging directory');

  // L2: `${idx}-` used to push a legal 254-char macOS filename over the
  // 255-byte component limit, so copyFile threw ENAMETOOLONG and — before
  // the per-item guard — aborted the whole batch with a 500 carrying two
  // absolute paths.
  const longName = 'a'.repeat(250) + '.pdf';
  const staged = __testing.stagedFileName(12, longName);
  assert(Buffer.byteLength(staged) <= 255, `a 250-char filename stages to a legal component (${Buffer.byteLength(staged)} bytes)`);
  assert(staged.endsWith('.pdf'), 'the extension survives truncation — ingest.js picks its reader by extension');
  assert(staged.startsWith('12-'), 'the item-index prefix is preserved, so two items can never collide');
}

// ── 14. Cost estimate: shape, interpolation, and input validation ───────────

async function testEstimateShape() {
  assertEq(cachingSavingsFraction(1), 0, 'single-pass (1 call) gets 0% caching savings — no breakpoint is ever set');
  assertEq(Math.abs(cachingSavingsFraction(4) - 0.303) < 1e-9, true, 'the canonical 4-call case hits the cited 30.3% anchor exactly');
  assertEq(Math.abs(cachingSavingsFraction(7) - 0.56) < 1e-9, true, 'the 7-call case hits the cited 56% anchor exactly');
  assertEq(cachingSavingsFraction(21), 0.56, 'savings are capped at 56% beyond the cited 7-call anchor, not extrapolated further');
  assert(cachingSavingsFraction(2) > 0 && cachingSavingsFraction(2) < cachingSavingsFraction(4), 'interpolates smoothly between 1 and 4 calls');
}

async function testEstimateValidation() {
  await freshEnv({ withProviderKey: true });
  const domain = await makeDomain();

  // L1: `'x'.repeat(-5000)` threw a RangeError that surfaced as an HTTP 500
  // body reading {"error":"Invalid count value: -5000"}.
  const neg = await estimateIngestQueueCost(domain, [{ name: 'ok.md', size: 1000 }, { name: 'neg.md', size: -5000 }]);
  assert(neg.files.rejected.some(r => r.name === 'neg.md'), 'a negative size is REJECTED with a reason, not crashed on');
  assert(!neg.files.accepted.includes('neg.md'), 'and it is not silently counted');

  // L2(live): a missing or non-numeric size was coerced to 0, so a client
  // that omitted sizes got a $0.00 estimate for a real batch — the cost gate
  // under-reporting rather than refusing.
  const noSize = await estimateIngestQueueCost(domain, [{ name: 'nosize.md' }, { name: 'abc.md', size: 'abc' }]);
  assertEq(noSize.files.accepted.length, 0, 'files with missing/non-numeric sizes are not accepted');
  assertEq(noSize.files.rejected.length, 2, 'both are rejected, each with a reason');
  assert(noSize.files.rejected.every(r => /size/i.test(r.reason)), 'the reason names the size, not something unrelated');

  // L3: no cap on files.length — 10,000 entries were accepted, each one
  // running the real prompt-assembly code against the full domain inventory.
  const many = Array.from({ length: __testing.MAX_ESTIMATE_FILES + 1 }, (_, i) => ({ name: `f${i}.md`, size: 100 }));
  let status = null;
  try { await estimateIngestQueueCost(domain, many); } catch (err) { status = err.statusCode; }
  assertEq(status, 400, `more than ${__testing.MAX_ESTIMATE_FILES} files is refused with 400, not silently processed`);

  const atLimit = Array.from({ length: __testing.MAX_ESTIMATE_FILES }, (_, i) => ({ name: `f${i}.md`, size: 100 }));
  const okRes = await estimateIngestQueueCost(domain, atLimit);
  assertEq(okRes.ok, true, 'exactly at the limit is still allowed');

  // ── The basis string must not present ANY single number as the general case.
  //
  // This has gone wrong three times in this feature: "~416k input tokens" for
  // a case the estimator computed at 1,051,302; then "roughly twice", derived
  // from the 80 KB point, which is the single most FAVOURABLE point on the
  // curve (a 2 KB note against a mature wiki is ~40x); and `usdHigh`
  // described as "no caching at all", which reads as a ceiling while a
  // measured live batch came in at 103.1% of it.
  //
  // So the assertions below pin the SHAPE, not a value: the multiple must be
  // computed per batch and must therefore MOVE with document size. A constant
  // — any constant — fails the first assertion by construction.
  const bigOne = await estimateIngestQueueCost(domain, [{ name: 'big.pdf', size: 80000 }]);
  const tinyOne = await estimateIngestQueueCost(domain, [{ name: 'note.md', size: 2048 }]);
  const readMult = (r) => {
    const m = r.estimate.basis.match(/about ([\d.]+)x the input tokens/);
    return m ? parseFloat(m[1]) : null;
  };
  const basis = bigOne.estimate.basis;

  assert(!/188k|416k/.test(basis), 'the basis quotes no unverified absolute token figure');
  assert(!/(roughly|about|approximately)\s+(twice|two times|2x)/i.test(basis),
    'the basis states NO generic "roughly twice" multiple — that was true only at the 80 KB point');
  assert(!/no caching at all/i.test(basis),
    'usdHigh is no longer described in words that read as a hard ceiling');
  assert(/can land above the range/i.test(basis),
    'and the basis says plainly that actual spend can exceed the estimate');
  assert(/REAL current page inventory/.test(basis), 'it still explains that the number is derived, not a flat rate');
  assert(/re-sends the existing page list/.test(basis), 'and still explains the MECHANISM, which is the valuable part');

  // On a domain with real content, the per-batch multiple must differ sharply
  // between a tiny document and a TEXT_CAP-sized one. This is the assertion a
  // hard-coded constant cannot survive.
  {
    const richDomain = await makeDomain('richdom');
    const wiki = path.join(getDomainsDir(), richDomain, 'wiki');
    await mkdir(path.join(wiki, 'entities'), { recursive: true });
    await mkdir(path.join(wiki, 'concepts'), { recursive: true });
    for (let i = 0; i < 250; i++) {
      await writeFile(path.join(wiki, 'entities', `entity-number-${i}.md`), '# e\n');
      await writeFile(path.join(wiki, 'concepts', `concept-number-${i}.md`), '# c\n');
    }
    await writeFile(path.join(wiki, 'index.md'), '| Page | Type | Summary |\n' +
      Array.from({ length: 500 }, (_, i) => `| [[entity-number-${i}]] | Entity | A page about subject number ${i} |`).join('\n'));

    const tiny = readMult(await estimateIngestQueueCost(richDomain, [{ name: 'note.md', size: 2048 }]));
    const big = readMult(await estimateIngestQueueCost(richDomain, [{ name: 'big.pdf', size: 80000 }]));
    assert(tiny !== null && big !== null, 'a per-batch multiple IS quoted on a domain that has content',
      `tiny=${tiny} big=${big}`);
    assert(tiny > big * 2,
      'the multiple is SIZE-DEPENDENT — a tiny note costs proportionally far more than a TEXT_CAP document',
      `tiny=${tiny}x big=${big}x — if these are equal, someone has hard-coded a constant again`);
    assert(big >= 1, 'and the large-document multiple is still at least 1x');
  }

  // An empty domain adds no overhead, so no multiple is claimed at all —
  // rather than a misleading "1.0x".
  assertEq(readMult(tinyOne), null, 'no multiple is quoted when the domain is empty and there is no overhead to report');
}

// ── 15. In-batch duplicate names ────────────────────────────────────────────

/**
 * M5. The duplicate check ran once at create against PRE-EXISTING raw/ state
 * and never against the batch itself, so two files sharing a basename both
 * staged (their `<idx>-` prefixes differ), both ingested, the second
 * overwrote raw/<name>, and — because the summary slug is deterministic from
 * the filename — both union-merged into ONE summary. Two documents, one page,
 * no warning.
 */
async function testInBatchDuplicateNames() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const a = await makeUpload('report.pdf', 3000, userDataDir);
  const b = await makeUpload('report.pdf', 2000, userDataDir);
  const c = await makeUpload('other.pdf', 1000, userDataDir);

  const fake = makeFakeIngestFile(domain, { 'report.pdf': 'ok', 'other.pdf': 'ok' });
  const job = await createJob({ domain, uploadedFiles: [a, b, c] });

  const dupes = job.items.filter(i => i.name === 'report.pdf');
  assertEq(dupes.length, 2, 'both same-named files still appear on the manifest (nothing is hidden from the user)');
  // NB: the wording here matters. scripts/run-tests.js treats a suite whose
  // output contains the bare uppercase word "SKIPPED" as having self-skipped
  // (that is how a live suite reports a missing API key), so an assertion
  // label containing it made this entire suite report as "⏭ skip" in
  // `npm test` — passing, but counted as NOT RUN, and therefore invisible to
  // CI. That is the same class of blindness v3.2.0 was written to close, so
  // no label in this file may contain that token in that form.
  assertEq(dupes.filter(i => i.status === 'skipped').length, 1, 'exactly one of them is skipped (status "skipped")');
  assertEq(dupes.filter(i => i.status === 'pending').length, 1, 'exactly one is queued to run');
  const skipped = dupes.find(i => i.status === 'skipped');
  assert(/same name/i.test(skipped.error) && /merged into a single wiki page/i.test(skipped.error),
    'the skip reason explains the real consequence, not a generic "duplicate"');

  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);
  assertEq(fake.calls.filter(c2 => c2.name === 'report.pdf').length, 1, 'report.pdf was ingested exactly ONCE');
  assertEveryItemAccountedFor(final, 'in-batch duplicates');

  // Even with overwrite: `overwrite` means "replace what is in the wiki"; it
  // cannot turn two files with one name into two pages.
  await requestCancel(job.jobId).catch(() => {});
  await waitWorkerIdle();
  const a2 = await makeUpload('again.pdf', 3000, userDataDir);
  const b2 = await makeUpload('again.pdf', 2000, userDataDir);
  const job2 = await createJob({ domain, uploadedFiles: [a2, b2], overwrite: true });
  assertEq(job2.items.filter(i => i.status === 'skipped').length, 1, 'the in-batch duplicate is skipped even with overwrite: true');
  await requestCancel(job2.jobId);
}

// ── 16. Garbage collection of staged files and job directories ──────────────

/**
 * M6. `stagedPath` was unlinked only on item SUCCESS, so every failed and
 * every skipped item's staged copy — up to 50 MB each — persisted for the
 * life of the install, as did every job directory ever created.
 */
async function testGarbageCollection() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();

  const files = [
    await makeUpload('gc0.md', 3000, userDataDir),
    await makeUpload('gc1.md', 2000, userDataDir),
    await makeUpload('gc2.md', 1000, userDataDir),
  ];
  const fake = makeFakeIngestFile(domain, { 'gc0.md': 'ok', 'gc1.md': 'fail', 'gc2.md': 'ok' });
  const job = await createJob({ domain, uploadedFiles: files });
  const stagedDir = path.join(getIngestQueueDir(), job.jobId, 'files');
  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'batch finishes with one failed item');
  await waitWorkerIdle();

  const leftovers = existsSync(stagedDir) ? await readdir(stagedDir) : [];
  assertEq(leftovers.length, 0, `no staged file survives a terminal job — including the FAILED item's (left: ${leftovers.join(', ')})`);
  assert(final.items.every(i => !Object.hasOwn(i, 'stagedPath') || i.stagedPath === null), 'and the manifest no longer points at any staged file');

  // Job-directory pruning: only terminal jobs, oldest first, keeping the cap.
  const retained = __testing.MAX_JOBS_RETAINED;
  for (let i = 0; i < retained + 4; i++) {
    const id = crypto.randomUUID();
    await mkdir(path.join(getIngestQueueDir(), id), { recursive: true });
    await writeManifest(id, {
      jobId: id, version: 1, domain, status: 'done', items: [],
      createdAt: new Date(Date.now() - (retained + 10 - i) * 60000).toISOString(),
      updatedAt: new Date(Date.now() - (retained + 10 - i) * 60000).toISOString(),
    });
  }
  const before = (await readdir(getIngestQueueDir())).length;
  assert(before > retained, `sanity: ${before} job directories exist before pruning`);
  const pruned = await __testing.pruneOldJobs();
  assert(pruned > 0, `pruneOldJobs deleted ${pruned} old terminal job directories`);
  const after = (await readdir(getIngestQueueDir())).length;
  assert(after <= retained, `at most ${retained} job directories remain (${after})`);

  // A NON-terminal job is never pruned, however old.
  const liveId = crypto.randomUUID();
  await mkdir(path.join(getIngestQueueDir(), liveId), { recursive: true });
  await writeManifest(liveId, {
    jobId: liveId, version: 1, domain, status: 'paused', items: [],
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  });
  await __testing.pruneOldJobs();
  assert(existsSync(path.join(getIngestQueueDir(), liveId)), 'a paused (non-terminal) job is never pruned, no matter how old');
}

// ── 17. createJob is serialised; one bad file does not kill the batch ───────

/**
 * H2. `getActiveJob()` was checked before staging and the estimate, both of
 * which await — so three concurrent creates all saw "no active job" and all
 * wrote one. Measured: three active jobs on disk, `/active` returning an
 * arbitrary one while the others stayed invisible yet still 409'd every new
 * batch, so the user had to discover and clear them one at a time.
 */
async function testConcurrentCreates() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();

  const batches = [];
  for (let b = 0; b < 3; b++) {
    batches.push([
      await makeUpload(`batch${b}-0.md`, 2000, userDataDir),
      await makeUpload(`batch${b}-1.md`, 1000, userDataDir),
    ]);
  }
  const settled = await Promise.allSettled(batches.map(uploadedFiles => createJob({ domain, uploadedFiles })));
  const created = settled.filter(s => s.status === 'fulfilled');
  const refused = settled.filter(s => s.status === 'rejected');

  assertEq(created.length, 1, 'exactly ONE of three simultaneous creates succeeds');
  assertEq(refused.length, 2, 'the other two are refused');
  assert(refused.every(r => r.reason && r.reason.statusCode === 409), 'both refusals are 409, not a 500');

  const all = await listJobs();
  assertEq(all.length, 1, 'exactly one job exists on disk afterwards');
  const active = await getActiveJob();
  assertEq(active.jobId, created[0].value.jobId, '/active reports that same job');
  await requestCancel(active.jobId);
}

/**
 * M4. A 16-file batch containing one unstageable file returned 400 and
 * DISCARDED the other 15 valid files, with a message blaming disk space.
 */
async function testOneBadFileDoesNotKillTheBatch() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();

  const uploads = [];
  for (let i = 0; i < 5; i++) uploads.push(await makeUpload(`good${i}.md`, 3000 - i, userDataDir));
  // A file whose source bytes are gone by the time staging runs — the general
  // shape of "this one file cannot be staged", without depending on any
  // particular OS error code.
  const bad = await makeUpload('broken.md', 2500, userDataDir);
  await rm(bad.path);
  uploads.push(bad);

  const plan = {};
  for (let i = 0; i < 5; i++) plan[`good${i}.md`] = 'ok';
  const fake = makeFakeIngestFile(domain, plan);

  const job = await createJob({ domain, uploadedFiles: uploads });
  assertEq(job.items.length, 6, 'the whole batch is still created — one bad file does not discard the other five');
  const badItem = job.items.find(i => i.name === 'broken.md');
  assertEq(badItem.status, 'failed', 'the unstageable file is ONE failed item');
  assert(!/disk space/i.test(badItem.error), 'and its message does not misdiagnose the cause as disk space');
  assert(!/\/(Users|private|var)\//.test(badItem.error), 'nor does it leak an absolute path');
  assertEq(job.items.filter(i => i.status === 'pending').length, 5, 'all five valid files are queued');

  await startOrResumeJob(job.jobId, { ingestFile: fake });
  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'the batch runs to completion');
  assertEq(fake.calls.length, 5, 'all five valid files were ingested');
  assertEveryItemAccountedFor(final, 'one unstageable file');
}

// ── 1f/1g. The two claim-lifecycle guards nothing was pinning ───────────────

/**
 * `startOrResumeJob`'s outer `catch` releases the worker claim before
 * re-throwing. Nothing tested it, and it is not cosmetic: the claim is taken
 * BEFORE the job is read from disk, so a start for a job id that does not
 * exist takes the claim and then throws 404 out of the try. Without the
 * release, that claim is held for the life of the process and EVERY later
 * batch 409s. Proven both ways when the release was mutated away:
 *   fixed: start#1 threw 404 · claim after = null · start#2 ran to done
 *   mutated: start#1 threw 404 · claim = <jobId> · start#2 THREW 409 · 0 ingests
 * One `POST /api/ingest-queue/<any-valid-uuid>/start` is enough to trigger it.
 */
async function testFailedStartReleasesTheClaim() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();

  const ghost = crypto.randomUUID();
  let status = null;
  try { await startOrResumeJob(ghost, { ingestFile: makeFakeIngestFile(domain, {}) }); }
  catch (err) { status = err.statusCode; }
  assertEq(status, 404, 'starting a job that does not exist throws 404');
  assertEq(__testing.getRunningJobId(), null,
    'and RELEASES the worker claim — otherwise it wedges the queue for the life of the process');

  // The claim being free is only half the guarantee; prove the queue still works.
  const files = [await makeUpload('fs0.md', 2000, userDataDir), await makeUpload('fs1.md', 1000, userDataDir)];
  const fake = makeFakeIngestFile(domain, { 'fs0.md': 'ok', 'fs1.md': 'ok' });
  const job = await createJob({ domain, uploadedFiles: files });
  const started = await startOrResumeJob(job.jobId, { ingestFile: fake });
  assertEq(started.status, 'running', 'a legitimate start AFTER the failed one is accepted, not 409-ed');
  const final = await waitTerminal(job.jobId);
  assertEq(final.status, 'done', 'and it runs to completion');
  assertEq(fake.calls.length, 2, 'both items were actually ingested');
  assertEveryItemAccountedFor(final, 'after a failed start');
  await waitWorkerIdle();

  // Same guarantee for the OTHER early-exit paths that release the claim.
  const terminalStart = await startOrResumeJob(job.jobId, { ingestFile: fake });
  assertEq(terminalStart.status, 'done', 'starting an already-terminal job is a no-op');
  assertEq(__testing.getRunningJobId(), null, 'and does not leave the claim held either');
}

/**
 * `settleJob`'s OWN call to `reclaimStrandedItems`. The worker loop has its
 * own reclaim, so a worker-driven test cannot tell the two apart — this
 * drives the settle path with NO worker running, which is the case the
 * worker's reclaim can never cover: a job left `running` on disk by a crash,
 * then paused by the user before any Resume.
 */
async function testSettleReclaimsWithoutAWorker() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const files = [
    await makeUpload('sr0.md', 3000, userDataDir),
    await makeUpload('sr1.md', 2000, userDataDir),
    await makeUpload('sr2.md', 1000, userDataDir),
  ];
  const job = await createJob({ domain, uploadedFiles: files });

  // A crash left the job running with an item mid-flight. No worker exists.
  await patchManifest(job.jobId, j => {
    j.status = 'running';
    j.items[1].status = 'running';
    j.items[1].startedAt = new Date().toISOString();
    j.currentIndex = 1;
  });
  assertEq(__testing.getRunningJobId(), null, 'sanity: no worker is running, so only settleJob can reclaim');

  const paused = await requestPause(job.jobId);
  assertEq(paused.status, 'paused', 'pausing the orphaned job settles it immediately');
  assertEq(paused.pausedReason, 'user', 'with the user reason');
  assertEq(paused.items[1].status, 'pending',
    'settleJob RECLAIMED the stranded item to pending — nothing else could have');
  assertEq(paused.items[1].startedAt, null, 'and cleared its startedAt');

  // The same on the cancel path, which settles through the same chokepoint.
  await patchManifest(job.jobId, j => { j.status = 'running'; j.items[2].status = 'running'; });
  const cancelled = await requestCancel(job.jobId);
  assertEq(cancelled.status, 'cancelled', 'cancel settles the job');
  assertEq(cancelled.items[2].status, 'pending',
    'and no item is left "running" under a terminal job with nobody executing it');
  assert(cancelled.items.every(i => i.status !== 'running'), 'no item anywhere is still marked running');
}

// ── 17c. processItem never throws ───────────────────────────────────────────

/**
 * `runWorkerLoop`'s only handler for an escaped throw is `.catch(console.error)`
 * on an un-awaited promise — so a throw from OUTSIDE `processItem`'s inner
 * try (the realistic one being `writeJob` itself failing on a full or
 * read-only disk) killed the loop silently and left the item `running` with
 * no worker: the H1 orphan, arriving by a second route.
 *
 * Asserted DIRECTLY rather than through the worker. Through the worker the
 * guard is indistinguishable — caught or escaped, the loop stops and the
 * on-disk state is identical — so a worker-level test would report coverage
 * it does not have. (Verified: mutating the outer catch away left every
 * worker-level test green.)
 */
async function testProcessItemNeverThrows() {
  const { userDataDir } = await freshEnv();
  const domain = await makeDomain();
  const files = [await makeUpload('pi0.md', 1000, userDataDir)];
  const job = await createJob({ domain, uploadedFiles: files });
  const dir = path.join(getIngestQueueDir(), job.jobId);

  // Make the manifest unwritable, so the very first `writeJob` — which runs
  // before processItem's inner try — fails.
  await chmod(dir, 0o500);
  let threw = null;
  let outcome = null;
  try {
    outcome = await __testing.processItem(job.jobId, job.items[0].idx, makeFakeIngestFile(domain, { 'pi0.md': 'ok' }));
  } catch (err) {
    threw = (err && err.message) || String(err);
  } finally {
    await chmod(dir, 0o700);
  }

  assertEq(threw, null, 'processItem RESOLVES rather than throwing when the manifest cannot be written');
  assert(outcome && typeof outcome.harnessError === 'string',
    'it reports the unpersistable failure as a harnessError so the loop can bound it');
  assert(!/\/(Users|private|var)\//.test(outcome.harnessError || ''), 'and the reported error carries no absolute path');
}

// ── 18. The accounting invariant under a randomised control sequence ────────

/**
 * Rather than enumerating the state transitions somebody thought of, drive a
 * pseudo-random sequence of start / pause / cancel / simulated-crash-recover
 * against batches whose items randomly succeed, fail permanently, or rate-
 * limit, and assert the ONE thing that must always hold: when a job is
 * terminal, every file the user handed over is in exactly one of done,
 * failed or skipped — and no ingest ever overlapped another.
 */
async function testAccountingUnderRandomSequences() {
  // Deterministic PRNG so a failure is reproducible from the seed printed
  // below rather than being a one-off nobody can chase.
  const seed = Number(process.env.QUEUE_TEST_SEED || 20260824);
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  console.log(`  (seed ${seed} — set QUEUE_TEST_SEED to reproduce a failure)`);

  let rounds = 0;
  for (let round = 0; round < 6; round++) {
    const { userDataDir } = await freshEnv();
    const domain = await makeDomain(`randdom${round}`);
    const n = 3 + Math.floor(rnd() * 4);
    const uploads = [];
    const plan = {};
    for (let i = 0; i < n; i++) {
      const name = `r${round}-${i}.md`;
      uploads.push(await makeUpload(name, 3000 - i * 10, userDataDir));
      const roll = rnd();
      if (roll < 0.2) plan[name] = 'fail';
      else if (roll < 0.35) {
        const e = new Error('⚠ Rate limit hit (HTTP 429).');
        e.curatorTransient = 'rate_limit';
        plan[name] = e;
      } else plan[name] = 'ok';
    }
    const fake = makeFakeIngestFile(domain, plan, { delayMs: 2 });
    const job = await createJob({ domain, uploadedFiles: uploads });

    // Up to 8 control actions, each resolving the job further.
    for (let step = 0; step < 8; step++) {
      const j = await getJob(job.jobId);
      if (!j || TERMINAL.has(j.status)) break;
      const action = rnd();
      if (action < 0.55) {
        await startOrResumeJob(job.jobId, { ingestFile: fake });
        await sleep(Math.floor(rnd() * 30));
      } else if (action < 0.7) {
        await requestPause(job.jobId).catch(() => {});
        await sleep(10);
      } else if (action < 0.8) {
        // Simulated crash: strand whatever is running, then recover.
        await waitWorkerIdle().catch(() => {});
        await patchManifest(job.jobId, m => {
          const running = m.items.find(i => i.status === 'running');
          if (running) { m.status = 'running'; }
        });
        await recoverOnBoot();
      } else if (action < 0.88) {
        await requestCancel(job.jobId).catch(() => {});
      } else {
        await sleep(20);
      }
    }

    // Drive it to a terminal state deterministically.
    for (let guard = 0; guard < 40; guard++) {
      const j = await getJob(job.jobId);
      if (!j || TERMINAL.has(j.status)) break;
      const allGood = makeFakeIngestFile(domain, Object.fromEntries(Object.keys(plan).map(k => [k, 'ok'])), { delayMs: 1 });
      await startOrResumeJob(job.jobId, { ingestFile: allGood });
      await sleep(60);
    }

    const finalJob = await getJob(job.jobId);
    assert(finalJob && TERMINAL.has(finalJob.status), `round ${round}: the job reached a terminal state (${finalJob && finalJob.status})`);
    if (finalJob && finalJob.status === 'done') {
      assertEveryItemAccountedFor(finalJob, `round ${round} (done)`);
    } else if (finalJob) {
      // cancelled/failed are legitimate places to stop with work outstanding,
      // but nothing may be left in `running` with nobody executing it.
      const stuck = finalJob.items.filter(i => i.status === 'running');
      assertEq(stuck.length, 0, `round ${round}: no item is left "running" under a ${finalJob.status} job`);
    }
    assertEq(__testing.getMaxIngestInFlight() <= 1, true, `round ${round}: never more than one ingest in flight`);
    await waitWorkerIdle().catch(() => {});
    rounds++;
  }
  assertEq(rounds, 6, 'all six randomised rounds completed');
}

// ── Run ──────────────────────────────────────────────────────────────────────

(async () => {
 try {
  await section('1. Sequential execution (never two items at once)', testSequential);
  await section('1b. FOUR simultaneous starts run exactly ONE worker (C1)', testConcurrentStartsRunOneWorker);
  await section('1c. Starts against an already-running job never fork a second worker', testConcurrentStartsWhileRunning);
  await section('1d. A start for a DIFFERENT job while one runs is 409', testStartRefusesSecondJob);
  await section('1e. Resume during worker wind-down is not a silent no-op', testResumeDuringWindDown);
  await section('1f. A FAILED start releases the worker claim (never wedges the queue)', testFailedStartReleasesTheClaim);
  await section('1g. settleJob reclaims a stranded item with no worker running', testSettleReclaimsWithoutAWorker);
  await section('2. Largest-first processing order', testOrdering);
  await section('3. Crash resume + NEVER auto-start spend', testCrashResumeGeneral);
  await section('3b. Crash resume does NOT drop the interrupted item as a false "duplicate"', testCrashResumeDuplicateRegression);
  await section('3c. A stranded "running" item is never lost (H1)', testStrandedItemUnderNonRunningJob);
  await section('3d. "done" is refused while any item is unfinished (H1 tripwire)', testDoneRefusedWithUnfinishedItem);
  await section('4. A rate-limit error pauses the whole batch (not just the one item)', testRateLimitPauses);
  await section('5. A permanent (non-transient) failure fails just that item', testPermanentFailureContinues);
  await section('6a. Circuit breaker: 3 consecutive failures pause the job', testCircuitBreakerTrips);
  await section('6b. Circuit breaker: a success in between resets the counter', testCircuitBreakerResetsOnSuccess);
  await section('7. classifyTransientError — anchored patterns only (L4)', testTransientClassification);
  await section('7b. A file NAMED after a provider error does not create a pause loop', testTransientFalsePositiveDoesNotLoop);
  await section('8a. Budget cap with real tokenUsage', testBudgetCapWithRealUsage);
  await section('8b. Budget cap still fires when tokenUsage is UNDEFINED', testBudgetCapWithoutTokenUsage);
  await section('8c. A budget that cannot be enforced is REFUSED, not silently inert (M1)', testBudgetRefusedWhenUnpriced);
  await section('8d. Cached reads are charged at the PROVIDER\'s rate, and the cap bites on it', testBudgetCapChargesCachedReadsAtProviderRate);
  await section('8e. …and Anthropic keeps its documented 0.1x cached-read discount', testAnthropicKeepsItsCachedReadDiscount);
  await section('9. Pause / cancel / delete state machine', testStateMachine);
  await section('10. Manifest resilience; a corrupt manifest is still deletable (M3)', testManifestResilience);
  await section('11. The wire representation: allow-list, scrubbed, bounded (H2/M2)', testWireRepresentation);
  await section('11b. A pending pause/cancel is visible on the wire (v3.3.0 field report)', testPendingRequestIsVisible);
  await section('11c. Control flags default to false and are never persisted', testFlagsDefaultFalseAndAreNotPersisted);
  await section('12. .ingest-queue/ is excluded from sync in every relevant place', testGitignoreInvariants);
  await section('13. Path-traversal defenses and staged-name hygiene (L2)', testPathTraversal);
  await section('14. estimateIngestQueueCost — caching-savings interpolation', testEstimateShape);
  await section('14b. estimate input validation and an honest basis (L1/L3)', testEstimateValidation);
  await section('15. Two files sharing a name do not collapse into one page (M5)', testInBatchDuplicateNames);
  await section('16. Staged files and job directories are collected (M6)', testGarbageCollection);
  await section('17. createJob is serialised (H2)', testConcurrentCreates);
  await section('17b. One unstageable file does not discard the batch (M4)', testOneBadFileDoesNotKillTheBatch);
  await section('17c. processItem never throws — a worker-killing throw is bounded', testProcessItemNeverThrows);
  await section('18. Accounting invariant under randomised control sequences', testAccountingUnderRandomSequences);

  // Must run LAST, over everything actually printed. See `_printed`.
  //
  // The tokens are BUILT rather than written literally, and the labels below
  // describe them instead of quoting them. The first version of this guard
  // spelled them out — and thereby tripped itself, leaving the suite still
  // reported as not-run while its own check reported green. A self-check that
  // contains the thing it forbids is not a check.
  {
    console.log('\n19. This suite is visible to `npm test` (not misread as self-skipped)');
    const upperSkipped = 'SKIP' + 'PED';
    const skipGlyph = String.fromCodePoint(0x23ED);
    const patterns = [
      [new RegExp(`\\b${upperSkipped}\\b`), 'the all-caps form of the word "skipped"'],
      [new RegExp(skipGlyph), 'the next-track glyph run-tests.js prints for a skipped suite'],
      [/^SKIP:/m, 'a line beginning with the all-caps abbreviation for "skip", followed by a colon'],
    ];
    const haystack = _printed.join('\n');
    for (const [re, what] of patterns) {
      const hit = _printed.find(line => re.test(line));
      assert(!hit && !re.test(haystack),
        `no output line contains ${what} — otherwise run-tests.js counts this whole suite as NOT RUN`,
        hit ? `offending line: ${hit.trim().slice(0, 120)}` : undefined);
    }
  }
 } finally {
  // Runs on EVERY path through the try block above: full completion, or a
  // throw that somehow escapes `section()`'s own catch (none currently does,
  // but this suite must not depend on that staying true forever). This is
  // the primary cleanup — it runs BEFORE either `process.exit()` call below,
  // so the temp dirs are gone before the process ever asks to exit. See the
  // `process.on('exit', ...)` handler above `freshEnv()` for the synchronous
  // fallback that covers anything unanticipated.
  await cleanupTmpRoots();
 }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
    process.exit(1);
  }
  process.exit(0);
})();
