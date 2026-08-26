#!/usr/bin/env node
/**
 * Battle test for REAL cancellation of an in-flight ingest (v3.3.x).
 *
 * THE BUG THIS EXISTS FOR: Cancel used to take effect only BETWEEN files. On a
 * 76 KB source — a multi-phase ingest of dozens of LLM calls — clicking Cancel
 * left the user staring at a "Cancelling…" button for minutes while their API
 * budget kept draining. A cancel that keeps spending is not a cancel.
 *
 * THE TRAP THIS SUITE IS MOSTLY ABOUT: ingest.js contains THREE recovery
 * ladders that deliberately catch an LLM error and degrade rather than fail —
 * Phase 1's stricter-prompt retry, Phase 2's batch -> page-by-page -> concise
 * retry -> STUB PAGE, and single-pass -> multi-phase. Every one of them issues
 * MORE LLM calls. An abort caught by any of them would be "recovered": the
 * ingest would keep spending and write stub pages, i.e. the exact opposite of
 * cancelling, while the button still said "Cancelling…". So the assertions
 * here are not "it eventually stopped" — they are "ZERO further LLM calls
 * happened" and "no stub page was written", each paired with a CONTROL run
 * proving the ladder really does fire for the recoverable error it exists for.
 * Without that control, an assertion of "0 extra calls" could pass simply
 * because the test never reached the ladder at all.
 *
 * OFFLINE. No API key, no internet, no real LLM. Two mechanisms:
 *   • the documented fake-LLM seams (`ingestMultiPhase`'s trailing `llm` param,
 *     the queue's `opts.ingestFile`) — same pattern and rationale as
 *     compile.js's `opts.generateText`;
 *   • ONE loopback HTTP server on 127.0.0.1 (ephemeral port) standing in for
 *     the Anthropic API via ANTHROPIC_BASE_URL, used only by section 7. That is
 *     the only way to reach the real 429 retry/backoff ladder inside
 *     generateText without a paid call, and it makes "no further provider calls
 *     after the abort" measurable at the HTTP level — a request counter, not a
 *     proxy for one. Nothing leaves the machine; no real key is ever present.
 *
 * Run: node scripts/test-ingest-abort.js
 */

import { mkdtemp, writeFile, mkdir, readdir, rm, stat } from 'fs/promises';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';
import http from 'http';

import { __setUserDataDirOverride } from '../src/brain/paths.js';
import { __setDomainsDirOverride } from '../src/brain/config.js';
import { createDomain, rawPath, wikiPath } from '../src/brain/files.js';
import {
  generateText, makeAbortError, isAbortError, ABORT_MESSAGE,
} from '../src/brain/llm.js';
import {
  ingestFile, isOutputTokenLimit, makeUsageAccumulator, __testing as ingestTesting,
} from '../src/brain/ingest.js';
import {
  createJob, getJob, startOrResumeJob, requestCancel, requestPause,
  classifyTransientError, __testing as queueTesting,
} from '../src/brain/ingest-queue.js';

let passed = 0, failed = 0;
const failures = [];

// Teed for the runner-visibility self-check at the bottom — see section 8.
const _printed = [];
const _realLog = console.log.bind(console);
console.log = (...a) => { _printed.push(a.join(' ')); _realLog(...a); };

function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) {
  failed++; failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
}
function assert(cond, label, detail) { cond ? ok(label) : fail(label, detail); }
function assertEq(actual, expected, label) {
  if (actual === expected) return ok(label);
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** One section's throw is ONE failure; every later section still runs. */
async function section(title, fn) {
  console.log(`\n${title}`);
  try { await fn(); }
  catch (err) { fail(`${title} — threw before finishing`, (err && err.stack) || String(err)); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(intervalMs);
  }
}

let _tmpRoot;

/**
 * EVERY tempdir this suite has ever created, so all of them are removed on
 * every exit path. The pre-existing cleanup at the bottom of this file
 * removed only the LAST `_tmpRoot` — a single-variable design that forgets
 * every earlier root the instant `freshEnv()` is called again. This suite
 * calls `freshEnv()` 6 times per run, so 5 of every 6 tempdirs it created
 * were never removed; that is the actual mechanism behind the 1,600+
 * `curator-abort-test-*` directories found on this machine. A registry plus
 * one removal routine means forgetting a root is structurally impossible.
 * @type {Set<string>}
 */
const _tmpRoots = new Set();

/**
 * True only for a path that is unambiguously one of THIS suite's own tempdirs
 * — inside the OS temp dir, one path segment down, named with this suite's
 * own mkdtemp prefix. Cleanup must never be able to remove anything else.
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
    path.basename(resolved).startsWith('curator-abort-test-')
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
 * Synchronous last-resort fallback — `process.exit()` skips pending `finally`
 * blocks and awaited async cleanup, so this `process.on('exit', ...)` handler
 * catches anything unanticipated that bypasses the awaited `cleanupTmpRoots()`
 * call at the bottom of this file. Idempotent: a no-op once the primary
 * cleanup has already emptied `_tmpRoots`.
 */
process.on('exit', () => {
  for (const dir of _tmpRoots) {
    if (!isOwnTempDir(dir)) continue;
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best-effort */ }
  }
});

async function freshEnv({ providerKey = null } = {}) {
  _tmpRoot = await mkdtemp(path.join(tmpdir(), 'curator-abort-test-'));
  _tmpRoots.add(_tmpRoot);
  const userDataDir = path.join(_tmpRoot, 'userdata');
  const domainsDir = path.join(_tmpRoot, 'domains');
  await mkdir(userDataDir, { recursive: true });
  await mkdir(domainsDir, { recursive: true });
  __setUserDataDirOverride(userDataDir);
  __setDomainsDirOverride(domainsDir);
  if (providerKey) {
    await writeFile(path.join(userDataDir, '.curator-config.json'), JSON.stringify(providerKey, null, 2));
  }
  delete process.env.LLM_MODEL;
  queueTesting.__resetInMemoryState();
  return { userDataDir, domainsDir };
}

// ── Scripted multi-phase harness ─────────────────────────────────────────────

const SUMMARY = 'summaries/fake-source.md';
const NO_FILES = { entities: [], concepts: [] };

const outlineJSON = (paths) => JSON.stringify({
  title: 'Fake Source',
  pages: paths.map(p => ({ path: p, summary: `description of ${p}` })),
});
const pagesJSON = (paths) => JSON.stringify({
  pages: paths.map(p => ({ path: p, content: `# ${p}\n\n- a bullet\n`, summary: `s ${p}` })),
});
const tokenLimitError = () => new Error('Gemini hit the output token limit (24576 tokens) on this call.');

/**
 * Scripted fake LLM. A step is {out} | {throw} | {abortThenOut} | {abortAndThrow}.
 *
 * `abortAndThrow` is the faithful simulation of a cancel landing DURING a
 * provider call: llm.js aborts the fetch and re-throws the tagged error, which
 * is exactly what the real generateText does with an aborted signal.
 *
 * Every call records the opts it was handed, so "calls after the abort" is
 * measured from the LLM's own point of view rather than inferred from a clock.
 */
function makeFakeLLM(steps, controller = null) {
  const prompts = [], seenOpts = [];
  let i = 0, abortedAt = -1;
  const llm = async (schema, prompt, maxTokens, format, onRetry, opts) => {
    const step = steps[Math.min(i, steps.length - 1)];
    const idx = i++;
    prompts.push(prompt);
    seenOpts.push(opts || null);
    if (opts && typeof opts.onUsage === 'function') {
      opts.onUsage({ inputTokens: 100, outputTokens: 10, provider: 'fake', model: 'fake-1' });
    }
    if (step.abortThenOut !== undefined) {
      if (abortedAt < 0) abortedAt = idx;
      controller.abort();
      return step.abortThenOut;
    }
    if (step.abortAndThrow !== undefined) {
      if (abortedAt < 0) abortedAt = idx;
      controller.abort();
      throw makeAbortError();
    }
    if (step.throw) throw step.throw();
    return step.out;
  };
  return {
    llm, prompts, seenOpts,
    calls: () => i,
    abortedAtCall: () => abortedAt,
    /** LLM calls issued STRICTLY AFTER the one that aborted. Must be 0. */
    callsAfterAbort: () => (abortedAt < 0 ? -1 : i - (abortedAt + 1)),
  };
}

async function runMultiPhase(steps, { controller = null, passSignal = true } = {}) {
  const warnings = [];
  const acc = makeUsageAccumulator();
  const fake = makeFakeLLM(steps, controller);
  const realError = console.error, realWarn = console.warn;
  console.error = () => {}; console.warn = () => {};
  let result = null, thrown = null;
  try {
    const args = [
      'schema', '2026-08-24', '', NO_FILES, 'fake-source.md', 'Some source text.',
      false, () => {}, SUMMARY, warnings, [], NO_FILES, acc.onUsage, fake.llm,
    ];
    if (passSignal && controller) args.push(controller.signal);
    result = await ingestTesting.ingestMultiPhase(...args);
  } catch (e) { thrown = e; }
  finally { console.error = realError; console.warn = realWarn; }
  return { result, thrown, warnings, fake };
}

/** 12 pages -> 3 batches of BATCH_SIZE (4). */
const TWELVE = [SUMMARY, ...Array.from({ length: 11 }, (_, n) => `concepts/c${n}.md`)];
const batchOf = (n) => TWELVE.slice(n * 4, n * 4 + 4);

/** A stub page is the visible artefact of a recovery ladder having run out. */
function anyStub(result) {
  if (!result || !Array.isArray(result.pages)) return false;
  return result.pages.some(p => p && typeof p.content === 'string' && /Stub page/i.test(p.content));
}

// ═════════════════════════════════════════════════════════════════════════════

await section('1. Cancellation primitives — an abort can never be mistaken for anything recoverable', async () => {
  const e = makeAbortError();
  assert(e instanceof Error, 'makeAbortError returns an Error');
  assertEq(e.curatorAborted, true, 'tagged with curatorAborted === true');
  assertEq(e.name, 'AbortError', 'named AbortError');
  assert(isAbortError(e), 'isAbortError recognises its own error');
  assert(isAbortError({ name: 'AbortError' }), 'isAbortError recognises a raw SDK AbortError (safe-direction widening)');
  assert(!isAbortError(new Error('boom')), 'a plain error is not an abort');
  assert(!isAbortError(null) && !isAbortError(undefined), 'null/undefined are not aborts');

  // The whole design rests on the abort message colliding with NO other
  // classifier. Each of these, if it matched, would route a cancel into a
  // path that issues more paid calls.
  assert(!isOutputTokenLimit(e), 'an abort is NOT an output-token-limit (that would trigger every recovery ladder)');
  assertEq(classifyTransientError(e), null, 'an abort is NOT a transient provider error (that would pause and retry the batch)');
  const m = ABORT_MESSAGE.toLowerCase();
  for (const needle of ['429', '503', 'too many requests', 'resource_exhausted', 'service unavailable',
    'high demand', 'overloaded', 'output token limit', 'not found', 'is not supported',
    'model_not_found', 'not_found_error', 'does not exist']) {
    assert(!m.includes(needle), `the abort message contains no "${needle}" (is429 / is503 / isModelNotFound collision)`);
  }
});

await section('2. Abort mid-Phase-2 STOPS — zero LLM calls after it, measured', async () => {
  const controller = new AbortController();
  // outline, batch 1 ok, batch 2 aborts mid-call, [batch 3 must never happen]
  const r = await runMultiPhase([
    { out: outlineJSON(TWELVE) },
    { out: pagesJSON(batchOf(0)) },
    { abortAndThrow: true },
    { out: pagesJSON(batchOf(2)) },
  ], { controller });

  assert(r.thrown && isAbortError(r.thrown), 'the abort propagates out of ingestMultiPhase', String(r.thrown && r.thrown.message));
  assertEq(r.result, null, 'no result is produced');
  assertEq(r.fake.abortedAtCall(), 2, 'the abort landed on the batch-2 call (call index 2)');
  assertEq(r.fake.callsAfterAbort(), 0, 'ZERO LLM calls after the abort — this is the whole point of the change');
  assertEq(r.fake.calls(), 3, 'exactly 3 calls total (outline + batch 1 + the aborted batch 2)');

  // The other half: a cancel observed BETWEEN calls must stop the loop too,
  // not only one that lands inside a call.
  const c2 = new AbortController();
  const r2 = await runMultiPhase([
    { out: outlineJSON(TWELVE) },
    { abortThenOut: pagesJSON(batchOf(0)) },   // batch 1 completes, cancel arrives
    { out: pagesJSON(batchOf(1)) },            // must never be issued
  ], { controller: c2 });
  assert(r2.thrown && isAbortError(r2.thrown), 'a cancel arriving between batches also stops the ingest');
  assertEq(r2.fake.callsAfterAbort(), 0, 'and issues no further batch — the per-batch checkpoint fires');

  // Every call was handed the signal. Without this the checkpoints are the
  // only defence, and an in-flight call could never be interrupted at all.
  assert(r.fake.seenOpts.every(o => o && o.signal && typeof o.signal.aborted === 'boolean'),
    'every LLM call receives the AbortSignal in its opts');
});

await section('3. THE TRAP — no recovery ladder may run on an abort (each paired with a control)', async () => {
  // ── 3a CONTROL: the Phase 2 page-by-page fallback really does fire ────────
  const ctl = await runMultiPhase([
    { out: outlineJSON(TWELVE) },
    { out: pagesJSON(batchOf(0)) },
    { throw: tokenLimitError },              // batch 2 overflows -> page-by-page
    { out: pagesJSON([TWELVE[4]]) },
    { out: pagesJSON([TWELVE[5]]) },
    { out: pagesJSON([TWELVE[6]]) },
    { out: pagesJSON([TWELVE[7]]) },
    { out: pagesJSON(batchOf(2)) },
  ]);
  assert(!ctl.thrown, 'CONTROL: a token-limit error is recovered, not fatal');
  assertEq(ctl.fake.calls(), 8, 'CONTROL: the fallback issued 4 extra single-page calls (so this test CAN see a ladder fire)');

  // ── 3a ABORT: same slot, abort instead of a token limit ──────────────────
  const c1 = new AbortController();
  const r1 = await runMultiPhase([
    { out: outlineJSON(TWELVE) },
    { out: pagesJSON(batchOf(0)) },
    { abortAndThrow: true },
    { out: pagesJSON([TWELVE[4]]) },         // page-by-page: must never happen
  ], { controller: c1 });
  assert(r1.thrown && isAbortError(r1.thrown), 'an abort in the batch call is fatal, not recovered');
  assertEq(r1.fake.callsAfterAbort(), 0, 'the page-by-page fallback did NOT fire on the abort');
  assert(!anyStub(r1.result), 'no stub page was written');

  // ── 3b CONTROL + ABORT: Phase 1 stricter-prompt retry ────────────────────
  const p1ctl = await runMultiPhase([
    { throw: tokenLimitError },                       // outline attempt 1 overflows
    { out: outlineJSON([SUMMARY, 'entities/a.md']) }, // stricter retry recovers
    { out: pagesJSON([SUMMARY, 'entities/a.md']) },
  ]);
  assert(!p1ctl.thrown, 'CONTROL: Phase 1 recovers from a token-limit via the stricter retry');
  assertEq(p1ctl.fake.calls(), 3, 'CONTROL: the stricter retry really was issued');

  const c2 = new AbortController();
  const p1 = await runMultiPhase([
    { abortAndThrow: true },                          // cancel during outline attempt 1
    { out: outlineJSON([SUMMARY, 'entities/a.md']) }, // stricter retry: must never happen
  ], { controller: c2 });
  assert(p1.thrown && isAbortError(p1.thrown), 'an abort during the Phase 1 outline is fatal');
  assertEq(p1.fake.calls(), 1, 'the Phase 1 stricter retry was NOT issued after a cancel');

  // ── 3c: the page-by-page + concise-retry ladder, aborted from inside ─────
  // The batch legitimately overflows (recovery fires, as designed) and THEN
  // the user cancels during the first single-page call. Neither the concise
  // retry nor a stub page may appear.
  const c3 = new AbortController();
  const r3 = await runMultiPhase([
    { out: outlineJSON(TWELVE) },
    { throw: tokenLimitError },       // batch 1 -> page-by-page
    { abortAndThrow: true },          // cancel during single page 1
    { out: pagesJSON([TWELVE[0]]) },  // concise retry / next page: must never happen
  ], { controller: c3 });
  assert(r3.thrown && isAbortError(r3.thrown), 'an abort inside the page-by-page fallback is fatal');
  assertEq(r3.fake.callsAfterAbort(), 0, 'no concise retry and no further page call after the cancel');
  assert(!anyStub(r3.result), 'no stub page was written by the aborted page-by-page run');
});

await section('4. No signal ⇒ byte-identical behaviour (the property every existing caller relies on)', async () => {
  const steps = () => ([
    { out: outlineJSON(TWELVE) },
    { out: pagesJSON(batchOf(0)) },
    { out: pagesJSON(batchOf(1)) },
    { out: pagesJSON(batchOf(2)) },
  ]);
  // (a) the pre-change call shape: 14 positional args, no signal at all.
  const a = await runMultiPhase(steps(), { controller: null, passSignal: false });
  // (b) the new call shape, with a signal that is never aborted.
  const live = new AbortController();
  const b = await runMultiPhase(steps(), { controller: live, passSignal: true });

  assert(!a.thrown && !b.thrown, 'both runs complete');
  assertEq(a.fake.calls(), b.fake.calls(), 'identical number of LLM calls');
  // Byte-comparison, not a spot check: the prompt is what a provider bills for.
  const joinPrompts = (f) => f.prompts.join('');
  assertEq(joinPrompts(a.fake), joinPrompts(b.fake), 'every generated prompt is BYTE-IDENTICAL with and without a signal');
  assertEq(JSON.stringify(a.result.pages), JSON.stringify(b.result.pages), 'the resulting page set is byte-identical');
  assertEq(JSON.stringify(a.warnings), JSON.stringify(b.warnings), 'the warnings are byte-identical');
  assert(a.fake.seenOpts.every(o => !o.signal), 'with no signal argument, opts.signal is falsy at every call site');
  assertEq(a.fake.seenOpts.length, b.fake.seenOpts.length, 'the same number of calls saw an opts object');
});

await section('5. ingestFile end-to-end (real fs, no provider call) — the single-pass ladder', async () => {
  await freshEnv();
  const domain = 'abortdom';
  await createDomain(domain, 'Abort Domain', 'throwaway', 'generic');
  const srcDir = path.join(_tmpRoot, 'src');
  await mkdir(srcDir, { recursive: true });
  const srcPath = path.join(srcDir, 'small.md');
  // Under MULTI_PHASE_INPUT_THRESHOLD so the SINGLE-PASS path is attempted,
  // and over MIN_TEXT_LEN so extraction is not refused.
  await writeFile(srcPath, `# Small source\n\n${'Some prose about a topic. '.repeat(60)}\n`);

  // ── 5a: already cancelled before the item even starts ────────────────────
  {
    const c = new AbortController();
    c.abort();
    let thrown = null;
    try { await ingestFile(domain, srcPath, 'small.md', false, null, { signal: c.signal }); }
    catch (e) { thrown = e; }
    assert(thrown && isAbortError(thrown), 'a pre-aborted signal refuses the ingest immediately');
    assert(!existsSync(path.join(rawPath(domain), 'small.md')),
      'and does so BEFORE saving the raw file — no work, no spend, no leftovers');
  }

  // ── 5b: cancelled the instant before the single-pass provider call ───────
  // The abort is fired from the progress callback that immediately precedes
  // the call, so generateText's own pre-flight check throws — the REAL code
  // path, with no network and no API key. The single-pass catch must re-throw
  // it instead of "recovering" into multi-phase, which is the most expensive
  // ladder in the file (an outline call plus one call per batch).
  {
    const c = new AbortController();
    const messages = [];
    let thrown = null;
    const realError = console.error, realWarn = console.warn;
    console.error = () => {}; console.warn = () => {};
    try {
      await ingestFile(domain, srcPath, 'small.md', false, (ev) => {
        messages.push((ev && ev.message) || '');
        if (ev && ev.pct === 15) c.abort();
      }, { signal: c.signal });
    } catch (e) { thrown = e; }
    finally { console.error = realError; console.warn = realWarn; }

    assert(thrown && isAbortError(thrown), 'a cancel at the single-pass call is fatal', String(thrown && thrown.message));
    const joined = messages.join(' | ').toLowerCase();
    assert(!joined.includes('multi-phase'), 'it did NOT fall through to the multi-phase ladder');
    assert(!joined.includes('phase 1'), 'Phase 1 planning never started');
    // Nothing may have been written to the wiki by an ingest cancelled before
    // its first provider call even returned.
    const entities = await readdir(path.join(wikiPath(domain), 'entities')).catch(() => []);
    const summaries = await readdir(path.join(wikiPath(domain), 'summaries')).catch(() => []);
    assertEq(entities.length + summaries.length, 0, 'no wiki pages were written');
  }
});

await section('6. The queue — a cancel stops the FILE, not just the batch', async () => {
  /**
   * A fake ingestFile that behaves like the real one under cancellation: it
   * runs until aborted, then throws the tagged error. If the signal never
   * reached it, this never resolves and the test times out — which is exactly
   * the "Cancelling… forever" bug, turned into a failing assertion.
   */
  function makeAbortAwareIngest() {
    const state = { started: 0, sawSignal: false, abortedSignals: 0, finishedNormally: 0 };
    const fn = async (dom, filePath, originalName, isOverwrite, onProgress, opts) => {
      state.started++;
      const signal = opts && opts.signal;
      if (signal) state.sawSignal = true;
      // raw-write-first, mirroring the real ingestFile's ordering contract
      try {
        await mkdir(rawPath(dom), { recursive: true });
        await writeFile(path.join(rawPath(dom), originalName), 'x');
      } catch { /* best-effort */ }
      for (let i = 0; i < 2000; i++) {
        if (signal && signal.aborted) { state.abortedSignals++; throw makeAbortError(); }
        await sleep(5);
      }
      state.finishedNormally++;
      return { title: originalName, pagesWritten: [], changes: [], warnings: [], truncated: false, tokenUsage: null };
    };
    fn.state = state;
    return fn;
  }

  // `bytes` is explicit because createJob orders items LARGEST-FIRST: the
  // file this suite intends to cancel must be the one that actually runs
  // first, not whichever way a tie happens to sort.
  async function makeUpload(name, dir, bytes = 64) {
    const p = path.join(dir, `up-${crypto.randomUUID()}`);
    await writeFile(p, Buffer.alloc(bytes, 'x'));
    const st = await stat(p);
    return { originalname: name, path: p, size: st.size };
  }

  // ── 6a: cancel the FIRST of two files, mid-ingest ────────────────────────
  {
    await freshEnv();
    const domain = 'qdom';
    await createDomain(domain, 'Q', 'throwaway', 'generic');
    const upDir = path.join(_tmpRoot, 'uploads'); await mkdir(upDir, { recursive: true });
    const uploadedFiles = [await makeUpload('a.md', upDir, 512), await makeUpload('b.md', upDir, 64)];
    const job = await createJob({ domain, uploadedFiles, overwrite: false });
    const fake = makeAbortAwareIngest();
    await startOrResumeJob(job.jobId, { ingestFile: fake });
    await waitFor(async () => fake.state.started >= 1);

    const t0 = Date.now();
    await requestCancel(job.jobId);
    const settled = await waitFor(async () => {
      const j = await getJob(job.jobId);
      return j && queueTesting.TERMINAL_STATUSES.has(j.status) ? j : null;
    }, { timeoutMs: 6000 });
    const elapsed = Date.now() - t0;

    assertEq(settled.status, 'cancelled', 'the job settles as cancelled');
    assertEq(settled.items[0].status, 'cancelled', 'the in-flight item is marked cancelled (not failed, not stuck running)');
    assert(/Re-ingest this file/i.test(settled.items[0].error || ''),
      'the item carries an honest partial-state message telling the user how to recover',
      settled.items[0].error);
    assert(/some pages may already have been written/i.test(settled.items[0].error || ''),
      'and does not pretend nothing happened');
    assert(!settled.items.some(i => i.status === 'running'), 'no item is left in `running`');
    assertEq(fake.state.abortedSignals, 1, 'the ingest observed the abort on ITS OWN signal (real cancellation, not just a flag)');
    assertEq(fake.state.finishedNormally, 0, 'the file did NOT run to completion');
    assertEq(fake.state.started, 1, 'the second file was never started');
    assert(elapsed < 3000, `cancel took effect promptly (${elapsed} ms)`,
      'a cancel that waits out the current file is the bug this change removes');
  }

  // ── 6b: cancel the LAST item — must settle `cancelled`, never `done` ─────
  // The worker loop's "no pending items left -> finishJobDone" branch runs
  // BEFORE its between-items cancel check, so a cancel on the final item is
  // the case that could report a completed batch. Settling from inside the
  // item is what closes it.
  {
    await freshEnv();
    const domain = 'qdom2';
    await createDomain(domain, 'Q2', 'throwaway', 'generic');
    const upDir = path.join(_tmpRoot, 'uploads'); await mkdir(upDir, { recursive: true });
    const uploadedFiles = [await makeUpload('only.md', upDir)];
    const job = await createJob({ domain, uploadedFiles, overwrite: false });
    const fake = makeAbortAwareIngest();
    await startOrResumeJob(job.jobId, { ingestFile: fake });
    await waitFor(async () => fake.state.started >= 1);
    await requestCancel(job.jobId);
    const settled = await waitFor(async () => {
      const j = await getJob(job.jobId);
      return j && queueTesting.TERMINAL_STATUSES.has(j.status) ? j : null;
    }, { timeoutMs: 6000 });

    assertEq(settled.status, 'cancelled', 'cancelling the ONLY item settles the job cancelled, not done');
    assert(settled.items.every(i => queueTesting.ITEM_TERMINAL.has(i.status)),
      'EVERY item reached a terminal state — the no-item-is-lost tripwire is satisfied',
      JSON.stringify(settled.items.map(i => `${i.name}:${i.status}`)));
    assertEq(settled.pausedMessage, null, 'and the job was NOT downgraded to a phantom "paused, never finished" state');
  }

  // ── 6c: PAUSE must NOT abort the in-flight file ──────────────────────────
  {
    await freshEnv();
    const domain = 'qdom3';
    await createDomain(domain, 'Q3', 'throwaway', 'generic');
    const upDir = path.join(_tmpRoot, 'uploads'); await mkdir(upDir, { recursive: true });
    const uploadedFiles = [await makeUpload('p1.md', upDir, 512), await makeUpload('p2.md', upDir, 64)];
    const job = await createJob({ domain, uploadedFiles, overwrite: false });

    // Short-running, so pause has a file to FINISH rather than a file to wait on.
    const state = { started: 0, aborted: 0, finished: 0 };
    const fake = async (dom, filePath, originalName, isOverwrite, onProgress, opts) => {
      state.started++;
      await mkdir(rawPath(dom), { recursive: true });
      await writeFile(path.join(rawPath(dom), originalName), 'x');
      for (let i = 0; i < 12; i++) {
        if (opts && opts.signal && opts.signal.aborted) { state.aborted++; throw makeAbortError(); }
        await sleep(10);
      }
      state.finished++;
      return { title: originalName, pagesWritten: [], changes: [], warnings: [], truncated: false, tokenUsage: null };
    };

    await startOrResumeJob(job.jobId, { ingestFile: fake });
    await waitFor(async () => state.started >= 1);
    await requestPause(job.jobId);
    const paused = await waitFor(async () => {
      const j = await getJob(job.jobId);
      return j && j.status === 'paused' ? j : null;
    }, { timeoutMs: 6000 });

    assertEq(state.aborted, 0, 'PAUSE does not abort the in-flight file — its documented, lossless meaning is preserved');
    assertEq(state.finished, 1, 'the in-flight file ran to completion');
    assertEq(paused.items[0].status, 'done', 'and is recorded as done, not cancelled');
    assertEq(paused.items[1].status, 'pending', 'the untouched file stays pending for Resume');
  }
});

await section('7. Abort during a 429 backoff returns promptly (real generateText, loopback provider)', async () => {
  await freshEnv({
    providerKey: {
      anthropicApiKey: 'offline-test-placeholder-never-leaves-this-machine',
      activeProvider: 'anthropic',
    },
  });

  let requests = 0;
  let abortedAt = null;
  let requestsAfterAbort = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (abortedAt !== null) requestsAfterAbort++;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

  const realWarn = console.warn; console.warn = () => {};
  try {
    const c = new AbortController();
    let onWaitFired = false;
    let abortMs = 0;
    const started = Date.now();

    // `onWait` fires immediately BEFORE the backoff sleep, which makes this
    // deterministic: no wall-clock guessing about when the ladder began.
    const p = generateText('sys', 'user', 64, 'text', () => {
      if (onWaitFired) return;
      onWaitFired = true;
      abortedAt = Date.now();
      abortMs = Date.now();
      c.abort();
    }, { signal: c.signal });

    let thrown = null;
    try { await p; } catch (e) { thrown = e; }
    const sinceAbort = Date.now() - abortMs;

    assert(onWaitFired, 'the 429 retry ladder was genuinely reached (onWait fired before the backoff)');
    assert(thrown && isAbortError(thrown), 'the cancel surfaces as a tagged abort, not as a rate-limit error',
      String(thrown && thrown.message));
    // With no parseable retry hint the backoff is 60_000 ms. Serving it out is
    // the failure mode; anything under a couple of seconds proves the sleep
    // itself was interrupted.
    assert(sinceAbort < 3000, `the backoff was interrupted (${sinceAbort} ms after the abort, not the full 60 s)`);
    assertEq(requestsAfterAbort, 0, 'and ZERO further HTTP requests reached the provider after the cancel');
    assert(requests >= 1, `the provider was really called before the cancel (${requests} request(s))`);
    assert(Date.now() - started < 20000, 'the whole ladder finished promptly');
  } finally {
    console.warn = realWarn;
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBase;
    await new Promise(r => server.close(r));
  }
});

await section('7b. Abort DURING the provider request (the common real-world case)', async () => {
  await freshEnv({
    providerKey: {
      anthropicApiKey: 'offline-test-placeholder-never-leaves-this-machine',
      activeProvider: 'anthropic',
    },
  });

  // A server that accepts the request and NEVER answers, so the abort lands
  // while the HTTP call is genuinely in flight — which is where a cancel
  // lands most of the time on a real multi-phase ingest. This is also the
  // end-to-end proof that `messages.stream(body, {signal})` really aborts the
  // request rather than the signal being quietly ignored by the SDK.
  let sawRequest = false;
  const open = [];
  const server = http.createServer((req, res) => { sawRequest = true; open.push(res); /* never respond */ });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;

  const realWarn = console.warn; console.warn = () => {};
  try {
    const c = new AbortController();
    const p = generateText('sys', 'user', 64, 'text', null, { signal: c.signal });
    let caught = null;
    p.catch(e => { caught = e; });

    await waitFor(async () => sawRequest, { timeoutMs: 5000 });
    const t0 = Date.now();
    c.abort();
    let thrown = null;
    try { await p; } catch (e) { thrown = e; }
    const elapsed = Date.now() - t0;

    assert(sawRequest, 'the request really reached the provider');
    assert(thrown, 'the in-flight call rejects instead of hanging forever');
    assert(isAbortError(thrown), 'and it rejects as a TAGGED abort, not as a raw SDK error',
      `name=${thrown && thrown.name} message=${String(thrown && thrown.message).slice(0, 140)}`);
    assert(elapsed < 5000, `the in-flight request was torn down promptly (${elapsed} ms)`);
    void caught;
  } finally {
    console.warn = realWarn;
    for (const res of open) { try { res.destroy(); } catch { /* best-effort */ } }
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBase;
    await new Promise(r => server.close(r));
  }
});

await section('8. This suite is visible to `npm test` (not misread as self-skipped)', async () => {
  const out = _printed.join('\n');
  assert(!/\bSKIPPED\b/.test(out), 'no output line contains the all-caps form of the word "skipped"');
  assert(!out.includes('⏭'), 'no output line contains the next-track glyph run-tests.js prints for a skipped suite');
  assert(!/^SKIP:/m.test(out), 'no output line begins with the all-caps abbreviation for "skip", followed by a colon');
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
// Removes EVERY tempdir this run created (see `_tmpRoots` above `freshEnv`),
// not just the one from the final `freshEnv()` call. Runs before either
// `process.exit()` call below, so cleanup always completes before the
// process asks to exit; `process.on('exit', ...)` is the synchronous
// fallback for anything that bypasses this line entirely.
await cleanupTmpRoots();
__setUserDataDirOverride(null);
__setDomainsDirOverride(null);

console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `\n      ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('✅ All ingest-cancellation offline assertions green');
