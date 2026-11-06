/**
 * src/brain/duplicate-job.js — "Compare all remaining": a paid pass over every pair
 * not yet answered, run by the server, not by the page that asked for it.
 *
 * WHY. A full pass on a 3,407-page domain is about 36,000 pairs and 100 minutes
 * (v3.91.0). A run tied to an open request is lost when the user moves to another
 * section, and 70 presses of "Check the next 500" is not a way to finish anything.
 *
 * THE RULES, following src/brain/sync-job.js and the ingest queue:
 *   - ONE AT A TIME, across domains. A second start gets a typed error, never a queue
 *     and never a run beside the first: two runs share one provider's rate limit, and
 *     one person cannot watch two meters. The check-and-set has no `await` between
 *     them, so on Node's single thread two requests cannot both pass it.
 *   - IT KEEPS RUNNING if the client leaves. Nothing here listens to a request.
 *   - NOTHING AUTO-STARTS SPEND. A record that says "running" with no run in this
 *     process means the process died, and it READS as paused. Only an explicit Resume
 *     runs it again. There is no startup hook, so nothing can forget to do this.
 *   - AN EXPLICIT START CARRIES THE CONFIRMED AMOUNT, and the job stops itself at 120%
 *     of it, before the call that would pass the limit, and says why.
 *   - THE ANSWERS ARE SAVED AFTER EVERY BATCH by scanSemanticDuplicates, exactly as a
 *     short scan saves them. Pausing, stopping and dying all keep what was paid for,
 *     and Resume simply plans again: what is answered is no longer on the list.
 *
 * WHAT IS COUNTED. Every completed provider call, split retries and fallback rungs
 * included (`onUsage`), priced one call at a time at the model that really answered.
 * A call in flight when the process dies is not on record, so after a crash the
 * spent figure can be low by one call. `recovered: true` says that happened.
 *
 * A record lives outside domains/ (paths.js getDuplicateJobsDir). The wiki is not
 * touched: AI Health stays read-only. Not reachable from mcp/, and it still writes
 * nothing to stdout.
 */
import { existsSync } from 'fs';
import { readFile, mkdir } from 'fs/promises';
import path from 'path';
import { getDuplicateJobsDir } from './paths.js';
import { writeFileAtomic } from './atomic-write.js';
import { wikiPath } from './files.js';
import { getProviderInfo, getModelPrice, isFreeModel, priceUsageUsd, providerDisplayName } from './llm.js';
import { scanSemanticDuplicates } from './health-ai.js';

const FORMAT = 1;
export const COMPARE_ALL_SPEND_MARGIN = 1.2;
/** A provider that fails this many batches running is not going to recover on its own. */
const MAX_CONSECUTIVE_BATCH_ERRORS = 3;

/**
 * "Out of credits" in the words providers use for it: HTTP 402 (OpenRouter, a prepaid
 * balance) and Anthropic's "credit balance is too low", which arrives as a 400. No later
 * batch can succeed and no retry helps, so the job pauses on the FIRST one.
 */
export function isOutOfCredits(ev) {
  if (ev && Number(ev.status) === 402) return true;
  const m = String((ev && ev.error) || '');
  return /\bHTTP 402\b|"code":\s*402\b|\b402\b.*(payment|credit)|payment required|insufficient[_ ]credits?|credit balance|prepaid credits?|credits? (are|is|have|has) (been )?(depleted|exhausted)|out of credits/i.test(m);
}

/** A provider's error is often its whole JSON body. The row gets the sentence inside it. */
export function plainProviderError(message) {
  const raw = String(message || '').trim();
  const at = raw.indexOf('{');
  if (at !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(at));
      const inner = parsed && parsed.error && (parsed.error.message || parsed.error);
      if (typeof inner === 'string' && inner.trim()) return inner.trim().slice(0, 240);
    } catch { /* not JSON: the text as it came */ }
  }
  return raw.slice(0, 240);
}

let _run = null;              // { domain, record, pauseRequested, stop, ... } — THE run
const _manualScans = new Map(); // domain → how many short scans are running
let _llmForTest = null;
let _lastFinished = Promise.resolve();

export class CompareAllError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

function fileFor(domain) {
  const name = encodeURIComponent(String(domain));
  if (!name || name === '.' || name === '..') return null;
  return path.join(getDuplicateJobsDir(), name + '.json');
}

async function readRecord(domain) {
  const file = fileFor(domain);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || parsed.format !== FORMAT || typeof parsed.state !== 'string' || !parsed.spent || !parsed.limit) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Writes are chained, so a slow one can never overwrite a newer one. */
function persist(run) {
  const snapshot = JSON.stringify({ format: FORMAT, ...run.record }) + '\n';
  const file = fileFor(run.domain);
  run.writes = run.writes.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, snapshot);
  }).catch((err) => {
    process.stderr.write(`[duplicate-job] could not save ${run.domain}: ${err && err.message}\n`);
  });
  return run.writes;
}

function secondsLeft(record) {
  const p = record.progress;
  if (!(record.secondsPerPair > 0)) return null; // no batch has finished in this run yet
  return Math.ceil(Math.max(0, p.totalPairs - p.checkedPairs) * record.secondsPerPair);
}

/** What the view reads. Copies, with the state a dead process's record really has. */
function present(record, { live }) {
  const out = JSON.parse(JSON.stringify(record));
  delete out.format;
  if (!live && (out.state === 'running' || out.state === 'pausing')) {
    out.state = 'paused';
    out.pauseReason = 'restart';
    out.recovered = true;
    out.reason = 'The app restarted while this was running. It stays paused until you resume it.';
  }
  out.secondsLeft = out.state === 'running' || out.state === 'pausing' ? secondsLeft(out) : null;
  return out;
}

/** READ-ONLY: this reads one file and writes nothing, whatever it finds. */
export async function compareAllStatus(domain) {
  if (_run && _run.domain === domain) return present(_run.record, { live: true });
  const record = await readRecord(domain);
  const elsewhere = _run ? { runningElsewhere: _run.domain } : {};
  if (!record) return { state: 'none', ...elsewhere };
  return { ...present(record, { live: false }), ...elsewhere };
}

function limitFromConfirm(info, confirm) {
  const c = confirm && typeof confirm === 'object' ? confirm : {};
  if (typeof c.confirmedModel !== 'string' || !c.confirmedModel) {
    throw new CompareAllError('JOB_CONFIRM_REQUIRED', 400, 'This request carried no confirmed amount, so nothing was started. Read the estimate and confirm it first.');
  }
  if (c.confirmedModel !== info.model) {
    throw new CompareAllError('JOB_ESTIMATE_STALE', 409, `The estimate you confirmed was for ${c.confirmedModel}, and the model is now ${info.model}. Nothing was started. Read the new estimate and confirm that.`);
  }
  const priced = !isFreeModel(info.model) && !!getModelPrice(info.model);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  if (priced) {
    const usd = num(c.confirmedUsd);
    if (usd === null) throw new CompareAllError('JOB_CONFIRM_REQUIRED', 400, 'This request carried no confirmed amount in dollars, so nothing was started. Read the estimate and confirm it first.');
    return { kind: 'usd', confirmed: usd, stopAt: usd * COMPARE_ALL_SPEND_MARGIN };
  }
  const tokens = num(c.confirmedTokens);
  if (tokens === null) throw new CompareAllError('JOB_CONFIRM_REQUIRED', 400, 'This request carried no confirmed amount in tokens, so nothing was started. Read the estimate and confirm it first.');
  return { kind: 'tokens', confirmed: tokens, stopAt: tokens * COMPARE_ALL_SPEND_MARGIN };
}

function busyError(run) {
  return new CompareAllError('JOB_RUNNING', 409, `A comparison is already running in "${run.domain}". It keeps going on its own; this one was not started.`, { running: { domain: run.domain, state: run.record.state } });
}

/**
 * A short scan (the SSE route) and a whole pass would pay for the same pairs. The
 * short scan asks here first and releases when done. A scan from the MCP's separate
 * process is not seen: that costs a repeat of some pairs, never data.
 */
export function beginManualScan(domain) {
  if (_run && _run.domain === domain) {
    throw new CompareAllError('COMPARE_ALL_RUNNING', 409, 'A comparison of all remaining pairs is running in this domain. Pause it first, or let it finish.');
  }
  _manualScans.set(domain, (_manualScans.get(domain) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (_manualScans.get(domain) || 1) - 1;
    if (n > 0) _manualScans.set(domain, n); else _manualScans.delete(domain);
  };
}

/** For a route that must not run under a job, such as forgetting the answers. */
export function refuseIfCompareAllRunning(domain) {
  if (_run && _run.domain === domain) {
    throw new CompareAllError('COMPARE_ALL_RUNNING', 409, 'A comparison of all remaining pairs is running in this domain. Pause it first, or let it finish.');
  }
}

function launch(domain, record) {
  // No `await` between the caller's check and this assignment.
  const run = {
    domain, record,
    pauseRequested: false, stop: null, consecutiveErrors: 0, largestCall: 0,
    writes: Promise.resolve(), startedMs: Date.now(), secondsBefore: record.runSeconds || 0,
  };
  _run = run;
  record.state = 'running';
  record.pauseReason = null;
  record.reason = null;
  record.recovered = false;
  run.finished = runLoop(run);
  _lastFinished = run.finished;
  return run;
}

/**
 * The one place that decides whether another provider call may be made. The job
 * stops BEFORE the call that would pass the limit, using its largest call so far as
 * the size of the next one. A call that turns out larger can pass it by that much,
 * which is why the record states `spent` beside `limit` and never assumes.
 */
function stopReasonBeforeCall(run) {
  if (run.pauseRequested) return { kind: 'pause', pauseReason: 'user', reason: 'Paused. Answers so far are saved.' };
  if (run.stop) return run.stop;
  const { record } = run;
  if (!existsSync(wikiPath(run.domain))) {
    return { kind: 'stop', stopReason: 'domain-missing', reason: 'This domain no longer exists, so the comparison stopped.' };
  }
  const { limit, spent } = record;
  const used = limit.kind === 'usd' ? spent.usd : spent.inputTokens + spent.outputTokens + spent.cachedReadTokens + spent.cacheWriteTokens;
  if (used >= limit.stopAt || used + run.largestCall > limit.stopAt) {
    return {
      kind: 'stop', stopReason: 'spend-limit',
      reason: limit.kind === 'usd'
        ? (used >= limit.stopAt
          // One call can pass it: what a call costs is only known once it has answered.
          ? `Stopped at the limit: it had spent $${used.toFixed(4)}, past $${limit.stopAt.toFixed(4)}, 120% of the $${limit.confirmed.toFixed(4)} you confirmed, because a call's cost is only known once it answers. Answers so far are saved.`
          : `Stopped at the limit: it had spent $${used.toFixed(4)} and would have passed $${limit.stopAt.toFixed(4)}, 120% of the $${limit.confirmed.toFixed(4)} you confirmed. Answers so far are saved.`)
        : `Stopped at the limit: it had used ${Math.round(used).toLocaleString()} tokens and would have passed ${Math.round(limit.stopAt).toLocaleString()}, 120% of what you confirmed. Answers so far are saved.`,
    };
  }
  return null;
}

function noteUsage(run, u) {
  const r = u && typeof u === 'object' ? u : {};
  const { record } = run;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const tokens = n(r.inputTokens) + n(r.outputTokens) + n(r.cachedReadTokens) + n(r.cacheWriteTokens);
  const model = typeof r.model === 'string' && r.model ? r.model : record.model;
  // `calls: 1` is what makes a tiered model price this call at its own prompt's tier.
  const usd = priceUsageUsd(model, { ...r, calls: 1 });
  const s = record.spent;
  s.calls++;
  s.inputTokens += n(r.inputTokens);
  s.outputTokens += n(r.outputTokens);
  s.cachedReadTokens += n(r.cachedReadTokens);
  s.cacheWriteTokens += n(r.cacheWriteTokens);
  if (usd !== null) s.usd += usd;
  const by = record.answeredBy[model] || (record.answeredBy[model] = { calls: 0, usd: 0 });
  by.calls++;
  if (usd !== null) by.usd += usd;
  if (model !== record.model) record.fallbackAnswered = true;
  run.largestCall = Math.max(run.largestCall, record.limit.kind === 'usd' ? (usd || 0) : tokens);

  // Three bills the confirmed amount cannot govern, so none is allowed to continue.
  if (tokens === 0) {
    run.stop = { kind: 'stop', stopReason: 'price-unknown', reason: 'The provider answered without saying how much it used, so what this costs can no longer be checked against what you confirmed. Answers so far are saved.' };
  } else if (record.limit.kind === 'usd' && usd === null) {
    run.stop = { kind: 'stop', stopReason: 'price-unknown', reason: `The answer came from ${model}, which has no published price, so what this costs can no longer be checked against what you confirmed. Answers so far are saved.` };
  } else if (record.limit.kind === 'tokens' && model !== record.model && usd !== 0) {
    run.stop = { kind: 'stop', stopReason: 'fallback-not-confirmed', reason: `The answer came from ${model} instead of ${record.model}, which is not what you confirmed, so the comparison stopped. Answers so far are saved.` };
  }
  record.updatedAt = new Date().toISOString();
  persist(run);
}

function noteEvent(run, ev) {
  const p = run.record.progress;
  if (ev.type === 'start') {
    p.pairsThisRun = ev.candidatePairs;
    p.processed = 0;
    p.totalPairs = ev.totalPairs;
    p.checkedPairs = ev.checkedPairs;
    p.rememberedPairs = ev.rememberedPairs;
  } else if (ev.type === 'pair') {
    if (!ev.pair.remembered) p.found++;
  } else if (ev.type === 'batch-error') {
    p.failedBatches++;
    run.record.lastError = ev.error;
    run.batchFailed = true;
    if (isOutOfCredits(ev)) {
      run.stop = { kind: 'pause', pauseReason: 'provider-errors', reason: `${providerDisplayName(run.record.provider)} says this account is out of credits, so the comparison paused. What it already compared is saved and paid for. Add credits with your provider, then press Resume.` };
    }
  } else if (ev.type === 'progress') {
    p.processed = ev.processed;
    p.checkedPairs = ev.checkedPairs;
    if (run.batchFailed) {
      run.consecutiveErrors++;
      if (!run.stop && run.consecutiveErrors >= MAX_CONSECUTIVE_BATCH_ERRORS) {
        run.stop = { kind: 'pause', pauseReason: 'provider-errors', reason: `The AI failed ${run.consecutiveErrors} batches in a row, so the comparison paused rather than keep trying. Last error: ${plainProviderError(run.record.lastError)}` };
      }
    } else {
      run.consecutiveErrors = 0;
    }
    run.batchFailed = false;
    const thisRun = (Date.now() - run.startedMs) / 1000;
    run.record.runSeconds = run.secondsBefore + thisRun;
    if (ev.processed > 0) run.record.secondsPerPair = thisRun / ev.processed;
    run.record.updatedAt = new Date().toISOString();
    persist(run);
  } else if (ev.type === 'done') {
    p.totalPairs = ev.totalPairs;
    p.checkedPairs = ev.checkedPairs;
    p.rememberedPairs = ev.rememberedPairs;
    p.failedPairs = ev.failedPairs;
  }
}

async function runLoop(run) {
  const { record, domain } = run;
  let ended = null;
  try {
    await persist(run);
    await scanSemanticDuplicates(domain, {
      maxPairs: Number.MAX_SAFE_INTEGER,
      // A per-run ceiling is about one press of a button. This job's own limit is the
      // amount the person confirmed for the whole pass, and it is enforced per call.
      costCeilingTokens: Number.POSITIVE_INFINITY,
      liveWiki: true,
      generateText: _llmForTest || undefined,
      onUsage: (u) => noteUsage(run, u),
      shouldStop: () => {
        ended = stopReasonBeforeCall(run);
        run.ending = !!ended;
        return run.ending;
      },
    }, (ev) => noteEvent(run, ev));
  } catch (err) {
    ended = { kind: 'stop', stopReason: 'failed', reason: `The comparison stopped: ${err && err.message ? err.message : String(err)}` };
    record.lastError = err && err.message ? err.message : String(err);
  }
  // The run's last batch failed the way that pauses, so no later check saw it. A list
  // that ran out on a failure is not "done": those pairs are still to pay for.
  if (!ended && run.stop && run.stop.kind === 'pause') ended = run.stop;
  const now = new Date().toISOString();
  record.runSeconds = run.secondsBefore + (Date.now() - run.startedMs) / 1000;
  record.updatedAt = now;
  if (ended && ended.kind === 'pause') {
    record.state = 'paused';
    record.pauseReason = ended.pauseReason;
    record.reason = ended.reason;
  } else if (ended) {
    record.state = ended.stopReason === 'failed' ? 'failed' : 'stopped';
    record.stopReason = ended.stopReason;
    record.reason = ended.reason;
    record.finishedAt = now;
  } else {
    record.state = 'done';
    record.finishedAt = now;
  }
  await persist(run);
  await run.writes;
  // The last thing, so a start cannot begin before this record is on disk.
  if (_run === run) _run = null;
}

/** Start a pass. Throws CompareAllError without starting anything. */
export function startCompareAll(domain, confirm) {
  if (_run) throw busyError(_run);
  if (_manualScans.has(domain)) {
    throw new CompareAllError('SCAN_RUNNING', 409, 'A duplicate scan is running in this domain. Let it finish, then start this.');
  }
  let info;
  try { info = getProviderInfo(); }
  catch (err) { throw new CompareAllError('NO_PROVIDER', 400, err.message); }
  const limit = limitFromConfirm(info, confirm);
  const now = new Date().toISOString();
  const run = launch(domain, {
    domain,
    state: 'running',
    provider: info.provider,
    model: info.model,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    limit,
    spent: { usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 },
    answeredBy: {},
    fallbackAnswered: false,
    progress: { pairsThisRun: 0, processed: 0, totalPairs: 0, checkedPairs: 0, rememberedPairs: 0, found: 0, failedBatches: 0, failedPairs: 0 },
    runSeconds: 0,
    secondsPerPair: null,
    pauseReason: null,
    stopReason: null,
    reason: null,
    lastError: null,
    recovered: false,
  });
  return present(run.record, { live: true });
}

/** Ask the run to stop before its next call. Saying it twice is the same as once. */
export async function pauseCompareAll(domain) {
  if (_run && _run.domain === domain) {
    _run.pauseRequested = true;
    _run.record.state = 'pausing';
    return present(_run.record, { live: true });
  }
  const status = await compareAllStatus(domain);
  if (status.state === 'paused') return status;
  throw new CompareAllError('JOB_NOT_RUNNING', 409, 'Nothing is running in this domain, so there is nothing to pause.');
}

/**
 * Run a paused job again, on the amount already confirmed, with everything already
 * spent still counted. An explicit press is the only way in. A job priced on another
 * model is refused: the confirmed dollars were for that model, and answers bound to
 * it would not apply, so the whole list would be paid for again.
 */
export async function resumeCompareAll(domain) {
  if (_run && _run.domain === domain) {
    if (_run.pauseRequested && !_run.ending) {
      // Pressed before the batch in flight finished, so the run simply carries on.
      _run.pauseRequested = false;
      _run.record.state = 'running';
      return present(_run.record, { live: true });
    }
    throw busyError(_run);
  }
  if (_run) throw busyError(_run);
  const record = await readRecord(domain);
  // An `await` above: a start or another resume may have got in during it.
  if (_run) throw busyError(_run);
  const shown = record ? present(record, { live: false }) : null;
  if (!shown || shown.state !== 'paused') {
    throw new CompareAllError('JOB_NOT_PAUSED', 409, 'There is no paused comparison in this domain to resume.');
  }
  let info;
  try { info = getProviderInfo(); }
  catch (err) { throw new CompareAllError('NO_PROVIDER', 400, err.message); }
  if (info.model !== record.model || info.provider !== record.provider) {
    throw new CompareAllError('JOB_MODEL_CHANGED', 409, `This comparison was confirmed for ${record.model}, and the model is now ${info.model}. Read the new estimate and start again.`);
  }
  if (_manualScans.has(domain)) {
    throw new CompareAllError('SCAN_RUNNING', 409, 'A duplicate scan is running in this domain. Let it finish, then resume this.');
  }
  const run = launch(domain, record);
  run.record.updatedAt = new Date().toISOString();
  return present(run.record, { live: true });
}

/**
 * Close a paused job without running it, so the row goes back to its ordinary buttons.
 * What it compared stays remembered; only the job's record says it is over.
 */
export async function stopCompareAll(domain) {
  const record = await readRecord(domain);
  const shown = record ? present(record, { live: false }) : null;
  if (!shown || shown.state !== 'paused') {
    throw new CompareAllError('JOB_NOT_PAUSED', 409, 'There is no paused comparison in this domain to stop.');
  }
  // After the read, so a resume that got in during it is seen. A running job's record reads
  // as paused from here, because this reads it as a dead process's would be.
  if (_run && _run.domain === domain) throw busyError(_run);
  const now = new Date().toISOString();
  Object.assign(record, { state: 'stopped', stopReason: 'user', pauseReason: null, reason: null, recovered: false, updatedAt: now, finishedAt: now });
  const file = fileFor(domain);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify({ format: FORMAT, ...record }) + '\n');
  return present(record, { live: false });
}

// ── Test seams ──────────────────────────────────────────────────────────────

/** The fake LLM: this module's only provider seam, null in production. */
export function __setCompareAllLlmForTest(fn) { _llmForTest = fn; }
/** Resolves when the current run has ended and its record is on disk. */
export function __compareAllSettled() { return _lastFinished; }
/** Forget the run as a dead process would have. The loop must already have ended, or be abandoned by its fake LLM. */
export function __forgetCompareAllProcessForTest() { _run = null; _manualScans.clear(); }
