#!/usr/bin/env node
/**
 * scripts/test-duplicate-job.js — OFFLINE
 *
 * "Compare all remaining" (src/brain/duplicate-job.js), the candidate memo filter
 * after a merge (health-ai.js liveCandidates) and the families reading.
 *
 * ── WHAT THIS PINS ────────────────────────────────────────────────────────
 *   A. The estimate: Flash Lite at its measured rate, a tiered model at its own
 *      tier, free and unpriced in words, no write and no call.
 *   B. Start: needs a confirmed amount for the model in use; a second start gets 409,
 *      also from another domain; the short scan and Forget are refused beside it.
 *   C. It keeps running with no client; Pause stops further calls and keeps answers;
 *      Resume sends only what is left; the status route writes nothing.
 *   D. Restart: a dead process's record reads paused, nothing is called, resume is
 *      explicit. Proved by a REAL SIGKILL of a child process.
 *   E. The 120% stop, with a retry and a fallback counted in the spend.
 *   F. Provider failures, a changed model, a page or domain gone mid-run.
 *   G. Nothing is written under domains/ (inside C).
 *   H. Memo: filtered list equals a full pass at scale, order included, through
 *      merges, dismissals and undismissals, with no extra full pass.
 *   I. Families: A~B and B~C say nothing about A~C.
 *
 * ── METHOD ────────────────────────────────────────────────────────────────
 * Real files, the real router, a fake LLM through __setCompareAllLlmForTest. The
 * fake reports usage through the same `onUsage` a provider call does. No live call.
 *
 * ── NOT ENFORCED ──────────────────────────────────────────────────────────
 *   • Whether the measured rates still hold on a real provider (Gemini credits were
 *     depleted when this was written): the rates are v3.91.0's measurements.
 *   • A call in flight at a crash is not on record, so spent can read one call low.
 *   • A scan started from the MCP's process beside a job is not seen by the gate.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { createServer } from 'http';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');
const IS_CRASH_CHILD = process.argv[2] === '--crash-child';
const USER_DIR = IS_CRASH_CHILD ? process.env.CURATOR_TEST_USER_DATA_DIR : mkdtempSync(path.join(os.tmpdir(), 'curator-dupjob-user-'));
const DOMAINS_DIR = IS_CRASH_CHILD ? process.env.CURATOR_TEST_DOMAINS_DIR : mkdtempSync(path.join(os.tmpdir(), 'curator-dupjob-domains-'));
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DIR;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
process.env.GEMINI_API_KEY = 'fake-key-never-sent';
process.env.LLM_PROVIDER = 'gemini';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.LLM_MODEL;

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS_DIR);
const job = await import(path.join(REPO, 'src/brain/duplicate-job.js'));
const ai = await import(path.join(REPO, 'src/brain/health-ai.js'));
const health = await import(path.join(REPO, 'src/brain/health.js'));
const dc = await import(path.join(REPO, 'src/brain/duplicate-checks.js'));
const llmMod = await import(path.join(REPO, 'src/brain/llm.js'));
const { addDismissal, removeDismissal } = await import(path.join(REPO, 'src/brain/health-dismissed.js'));
const { getDuplicateJobsDir } = await import(path.join(REPO, 'src/brain/paths.js'));

const MODEL = 'gemini-2.5-flash-lite';
const USAGE = { inputTokens: 6000, outputTokens: 900 };
const CALL_USD = llmMod.priceUsageUsd(MODEL, { ...USAGE, calls: 1 });

function pairsIn(user) {
  const out = [];
  const re = /--- PAIR (\d+) ---\nA: \[([^\]]+)\]\n[\s\S]*?\nB: \[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(user))) out.push({ index: Number(m[1]), a: m[2], b: m[3] });
  return out;
}

/** A fake provider: answers `different` unless told otherwise, reports usage per call. */
function fakeLLM({ decide = () => ({ relation: 'different', difference: 'unrelated' }), usage = () => ({ ...USAGE, model: MODEL, provider: 'gemini' }), before = null } = {}) {
  const fn = async (sys, user, max, mode, sysCache, opts) => {
    fn.calls++;
    const pairs = pairsIn(user);
    fn.sent.push(...pairs.map((p) => `${p.a} + ${p.b}`));
    if (before) await before(fn, pairs);
    opts.onUsage(usage(fn));
    const results = [];
    for (const p of pairs) {
      const r = decide(p);
      if (r) results.push({ index: p.index, canonicalSlug: p.a.split('/')[1], rationale: 'because', ...r });
    }
    return JSON.stringify({ results });
  };
  fn.calls = 0;
  fn.sent = [];
  return fn;
}

let seq = 0;
function family(n, name = 'job' + (++seq)) {
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (let i = 0; i < n; i++) {
    const s = `widget-model-${String(i).padStart(3, '0')}`;
    writeFileSync(path.join(wiki, `concepts/${s}.md`), `---\ntype: concept\n---\n\n# ${s}\n\nAbout ${s}.\n`);
  }
  return { name, wiki };
}

// ── The child a real SIGKILL lands on ───────────────────────────────────────
if (IS_CRASH_CHILD) {
  const domain = process.argv[3];
  job.__setCompareAllLlmForTest(fakeLLM({
    before: async (fn) => { if (fn.calls > 3) await new Promise(() => {}); },
  }));
  job.startCompareAll(domain, { confirmedModel: MODEL, confirmedUsd: 100 });
  // The timer holds the process open: with only a promise pending, Node would exit by
  // itself once the fake LLM hangs, and that would not be a crash.
  setInterval(() => {}, 1000);
  await new Promise(() => {}); // the parent kills this process
}

const routes = await import(path.join(REPO, 'src/routes/health.js'));
const { default: express } = await import('express');
const app = express();
app.use(express.json());
app.use('/api/health', routes.default);
const server = createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/health`;
const post = async (p, body) => {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* a stream */ }
  return { status: res.status, body: json, text };
};
const get = async (p) => {
  const res = await fetch(BASE + p);
  return { status: res.status, body: await res.json() };
};
const start = (name, extra = {}) => post(`/${name}/semantic-dupes/compare-all/start`, { confirmedModel: MODEL, confirmedUsd: 100, ...extra });
const status = async (name) => (await get(`/${name}/semantic-dupes/compare-all/status`)).body.job;
// A job that never ends fails here, in seconds, rather than holding the whole run.
const settled = () => {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the job did not end within 30 s')), 30000); });
  return Promise.race([job.__compareAllSettled(), limit]).finally(() => clearTimeout(timer));
};
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, ms = 20000) {
  const t = Date.now();
  while (!(await cond())) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for: ${label}`);
    await tick(5);
  }
}
const recordFile = (name) => path.join(getDuplicateJobsDir(), `${name}.json`);
const treeHash = (dir) => {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const full = path.join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else { h.update(path.relative(dir, full)); h.update(readFileSync(full)); }
    }
  };
  walk(dir);
  return h.digest('hex');
};
/** Holds each provider call until the test lets it go. */
function gatedLLM(extra = {}) {
  const waiters = [];
  const fn = fakeLLM({ ...extra, before: () => new Promise((r) => waiters.push(r)) });
  fn.release = () => { const w = waiters.shift(); if (w) w(); return !!w; };
  fn.waiting = () => waiters.length;
  fn.releaseAll = () => { fn.open = true; while (waiters.length) waiters.shift()(); };
  return fn;
}

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }
const approx = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ═══════════════════════════════════════════════════════════════════════════
section('A. The estimate');
{
  const d = family(46); // 46 pages → 1,035 pairs
  const before = treeHash(path.join(DOMAINS_DIR, d.name));
  const { status: st, body: e } = await get(`/${d.name}/semantic-dupes/compare-all/estimate`);
  ok(st === 200 && e.pairs === 1035, 'A.1 every pair left, not one run\'s cap', JSON.stringify({ st, pairs: e.pairs, left: e.leftPairs }));
  ok(e.pairs === e.leftPairs, 'A.2 pairs is leftPairs');
  const per1000 = (e.estimatedUsd / e.pairs) * 1000;
  ok(approx(per1000, 0.046, 0.002), 'A.3 Flash Lite at the measured $0.046 per 1,000 pairs', String(per1000));
  ok(approx(e.estimatedSeconds / e.pairs, 0.165, 0.002) && e.timeBasis === 'measured', 'A.4 the measured 165 ms per pair', String(e.estimatedSeconds));
  ok(e.rateBasis === 'measured' && e.model === MODEL, 'A.5 says the rate is measured, and on which model');
  ok(/costs more/.test(e.fallbackNote) && /really billed/.test(e.fallbackNote), 'A.6 says what a fallback does to the figure');
  ok(e.stopMargin === 1.2, 'A.7 states the stop');
  ok(treeHash(path.join(DOMAINS_DIR, d.name)) === before, 'A.8 an estimate writes nothing');
  ok(e.job.state === 'none', 'A.9 no job yet');

  // Above the per-run ceiling is stated, not refused: 1,035 pairs is under 200k tokens
  // at this rate, so a low ceiling shows it. (Decision D6: allowed, and said.)
  const big = await get(`/${d.name}/semantic-dupes/estimate`);
  ok(big.status === 200, 'A.10 the per-run estimate still answers');
  await post('/ai-settings', { costCeilingTokens: 1000 });
  const over = await get(`/${d.name}/semantic-dupes/compare-all/estimate`);
  ok(over.body.overCeiling === true, 'A.11 above the per-run ceiling is stated');
  await post('/ai-settings', { costCeilingTokens: 200000 });

  // A tiered model: priced at the tier of its own batch prompt, never flat at the top.
  process.env.ANTHROPIC_API_KEY = 'fake-key-never-sent';
  process.env.LLM_PROVIDER = 'anthropic';
  process.env.LLM_MODEL = 'claude-haiku-5-5';
  const h = await ai.estimateCompareAll(d.name);
  ok(h.model === 'claude-haiku-5-5', 'A.12 the tiered model is the one in use', h.model);
  const lower = llmMod.estimateRates('claude-haiku-5-5', 10000);
  const upper = llmMod.estimateRates('claude-haiku-5-5', null);
  ok(upper.input > lower.input, 'A.13 (control) this model really has two tiers', JSON.stringify({ lower, upper }));
  const want = (h.pairs * 290 * lower.input + h.pairs * 160 * lower.output) / 1e6;
  ok(approx(h.estimatedUsd, want, 1e-6), 'A.14 priced at the tier its 6,000-token prompt falls in', `${h.estimatedUsd} vs ${want}`);
  ok(h.rateBasis === 'measured-tokens' && h.timeBasis === 'assumed', 'A.15 says what was and was not measured on it');

  process.env.LLM_MODEL = 'claude-model-with-no-price';
  const u = await ai.estimateCompareAll(d.name);
  ok(u.estimatedUsd === null && u.priceKnown === false && !!u.costNote && u.rateBasis === 'assumed', 'A.16 an unpriced model says so, and no figure', JSON.stringify({ usd: u.estimatedUsd, known: u.priceKnown, model: u.model }));

  process.env.LLM_PROVIDER = 'gemini';
  delete process.env.LLM_MODEL;
  delete process.env.ANTHROPIC_API_KEY;
}

// ═══════════════════════════════════════════════════════════════════════════
section('B. Start');
{
  const d = family(12);
  const other = family(12);
  const llm = gatedLLM();
  job.__setCompareAllLlmForTest(llm);

  let r = await post(`/${d.name}/semantic-dupes/compare-all/start`, {});
  ok(r.status === 400 && r.body.code === 'JOB_CONFIRM_REQUIRED', 'B.1 no confirmed amount: refused', JSON.stringify(r.body));
  r = await start(d.name, { confirmedUsd: 0 });
  ok(r.status === 400 && r.body.code === 'JOB_CONFIRM_REQUIRED', 'B.2 a zero amount is no amount');
  r = await start(d.name, { confirmedUsd: 'lots' });
  ok(r.status === 400 && r.body.code === 'JOB_CONFIRM_REQUIRED', 'B.3 an amount that is not a number is no amount');
  r = await start(d.name, { confirmedModel: 'gemini-3.1-flash-lite' });
  ok(r.status === 409 && r.body.code === 'JOB_ESTIMATE_STALE', 'B.4 an estimate for another model: refused');
  ok((await status(d.name)).state === 'none' && llm.calls === 0, 'B.5 none of those started anything or called anything');

  r = await start(d.name);
  ok(r.status === 200 && r.body.job.state === 'running', 'B.6 a confirmed start runs', JSON.stringify(r.body).slice(0, 200));
  ok(r.body.job.limit.kind === 'usd' && approx(r.body.job.limit.stopAt, 120), 'B.7 and stops at 120% of what was confirmed');

  const second = await start(d.name);
  ok(second.status === 409 && second.body.code === 'JOB_RUNNING', 'B.8 a second start gets 409', JSON.stringify(second.body));
  const elsewhere = await start(other.name);
  ok(elsewhere.status === 409 && elsewhere.body.code === 'JOB_RUNNING' && elsewhere.body.running.domain === d.name, 'B.9 another domain too, naming where it runs');
  ok((await status(other.name)).runningElsewhere === d.name, 'B.10 the other domain\'s status says where it runs');
  const both = await Promise.all([start(other.name), start(other.name)]);
  ok(both.every((b) => b.status === 409), 'B.11 two at once: neither gets through');

  const scan = await post(`/${d.name}/semantic-dupes/scan`, {});
  ok(scan.status === 409 && scan.body.code === 'COMPARE_ALL_RUNNING', 'B.12 the short scan is refused beside it, before any spend', JSON.stringify(scan.body));
  const forget = await post(`/${d.name}/semantic-dupes/forget`, {});
  ok(forget.status === 409 && forget.body.code === 'COMPARE_ALL_RUNNING', 'B.13 Forget is refused beside it');

  llm.releaseAll();
  const pump = setInterval(() => llm.releaseAll(), 2);
  await settled();
  clearInterval(pump);
  const done = await status(d.name);
  ok(done.state === 'done', 'B.14 it finishes', JSON.stringify(done).slice(0, 300));
  ok(done.progress.checkedPairs === 66 && done.progress.totalPairs === 66, 'B.15 every pair answered', JSON.stringify(done.progress));
  ok(new Set(llm.sent).size === 66 && llm.sent.length === 66, 'B.16 each exactly once');
  const scanAfter = await post(`/${d.name}/semantic-dupes/scan`, {});
  ok(scanAfter.status === 200, 'B.17 the short scan runs again afterwards');

  const m = family(4);
  m.claudeFile = path.join(DOMAINS_DIR, m.name, 'CLAUDE.md');
  writeFileSync(m.claudeFile, '---\nreadonly: true\n---\n# mirror\n');
  const mirror = await start(m.name);
  ok(mirror.status === 400 && /read-only/.test(mirror.body.error), 'B.18 a mirror is refused: nothing found there could be merged');
}

// ═══════════════════════════════════════════════════════════════════════════
section('C. Pause and Resume; it does not need a client');
{
  const d = family(20); // 190 pairs, 10 batches
  const tree = treeHash(path.join(DOMAINS_DIR, d.name));
  const llm = gatedLLM();
  job.__setCompareAllLlmForTest(llm);
  await start(d.name);
  await until(() => llm.waiting() === 1, 'first call');
  llm.release();
  await until(() => llm.waiting() === 1 && llm.calls === 2, 'second call');
  await tick(150); // the first batch's record is written behind this; let it land before comparing

  const beforeBytes = readFileSync(recordFile(d.name));
  for (let i = 0; i < 5; i++) await status(d.name);
  ok(readFileSync(recordFile(d.name)).equals(beforeBytes), 'C.1 reading status five times writes nothing');

  const paused = await post(`/${d.name}/semantic-dupes/compare-all/pause`, {});
  ok(paused.status === 200 && paused.body.job.state === 'pausing', 'C.2 Pause answers at once: the call in flight still finishes', JSON.stringify(paused.body).slice(0, 200));
  llm.release();
  await settled();
  const p = await status(d.name);
  ok(p.state === 'paused' && p.pauseReason === 'user', 'C.3 then it is paused', JSON.stringify(p).slice(0, 200));
  const callsAtPause = llm.calls;
  await tick(60);
  ok(llm.calls === callsAtPause && callsAtPause === 2, 'C.4 no further call is made', String(llm.calls));
  ok(p.spent.calls === 2 && approx(p.spent.usd, 2 * CALL_USD), 'C.5 spend is what the two calls cost', JSON.stringify(p.spent));
  ok(p.progress.checkedPairs === 40, 'C.6 two batches are recorded');
  const checks = await dc.loadDuplicateChecks(d.name);
  ok(checks.size === 40, 'C.7 and their answers are saved', String(checks.size));
  const again = await post(`/${d.name}/semantic-dupes/compare-all/pause`, {});
  ok(again.status === 200 && again.body.job.state === 'paused', 'C.8 pausing twice is the same as once');
  ok(p.secondsLeft === null, 'C.9 a paused job promises no time');

  const sent = new Set(llm.sent);
  const pump = setInterval(() => llm.releaseAll(), 2);
  const resumed = await post(`/${d.name}/semantic-dupes/compare-all/resume`, {});
  ok(resumed.status === 200 && resumed.body.job.state === 'running', 'C.10 Resume runs it', JSON.stringify(resumed.body).slice(0, 200));
  await settled();
  clearInterval(pump);
  const end = await status(d.name);
  ok(end.state === 'done' && end.progress.checkedPairs === 190, 'C.11 and it finishes', JSON.stringify(end.progress));
  const repeats = llm.sent.slice(40).filter((x) => sent.has(x));
  ok(repeats.length === 0 && llm.sent.length === 190, 'C.12 Resume sends only what is left', `${repeats.length} repeats, ${llm.sent.length} sent`);
  ok(approx(end.spent.usd, 10 * CALL_USD), 'C.13 spend carries across the pause', String(end.spent.usd));

  let r = await post(`/${d.name}/semantic-dupes/compare-all/resume`, {});
  ok(r.status === 409 && r.body.code === 'JOB_NOT_PAUSED', 'C.14 a finished job cannot be resumed');
  r = await post(`/${d.name}/semantic-dupes/compare-all/pause`, {});
  ok(r.status === 409 && r.body.code === 'JOB_NOT_RUNNING', 'C.15 nor paused');
  ok(treeHash(path.join(DOMAINS_DIR, d.name)) === tree, 'C.16 nothing under domains/ changed');
  ok(!recordFile(d.name).startsWith(DOMAINS_DIR) && existsSync(recordFile(d.name)), 'C.17 the record lives outside domains/');

  // Resume pressed while the pause is still waiting on the call in flight.
  const e = family(10);
  const l2 = gatedLLM();
  job.__setCompareAllLlmForTest(l2);
  await start(e.name);
  await until(() => l2.waiting() === 1, 'first call');
  await post(`/${e.name}/semantic-dupes/compare-all/pause`, {});
  const un = await post(`/${e.name}/semantic-dupes/compare-all/resume`, {});
  ok(un.status === 200 && un.body.job.state === 'running', 'C.18 Resume before the pause lands simply carries on');
  const pump2 = setInterval(() => l2.releaseAll(), 2);
  await settled();
  clearInterval(pump2);
  ok((await status(e.name)).state === 'done', 'C.19 and it finishes');

  // A second resume while running is a 409, and so is resume during another job.
  const f = family(10);
  const l3 = gatedLLM();
  job.__setCompareAllLlmForTest(l3);
  await start(f.name);
  r = await post(`/${f.name}/semantic-dupes/compare-all/resume`, {});
  ok(r.status === 409 && r.body.code === 'JOB_RUNNING', 'C.20 resume while running gets 409');
  const pump3 = setInterval(() => l3.releaseAll(), 2);
  await settled();
  clearInterval(pump3);
}

// ═══════════════════════════════════════════════════════════════════════════
section('D. Restart: nothing auto-starts spend (a real SIGKILL)');
{
  const d = family(20);
  const child = spawn(process.execPath, [SELF, '--crash-child', d.name], { env: process.env, stdio: 'ignore' });
  const childEnded = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  await until(() => {
    try { return JSON.parse(readFileSync(recordFile(d.name), 'utf8')).spent.calls >= 3; } catch { return false; }
  }, 'the child to have spent three calls');
  child.kill('SIGKILL');
  const ended = await childEnded;
  ok(ended.signal === 'SIGKILL', 'D.0 (control) the child really was killed, mid-run', JSON.stringify(ended));

  const onDisk = JSON.parse(readFileSync(recordFile(d.name), 'utf8'));
  ok(onDisk.state === 'running', 'D.1 (control) the dead process\'s record still says running', onDisk.state);
  const bytes = readFileSync(recordFile(d.name));

  const llm = fakeLLM();
  job.__setCompareAllLlmForTest(llm);
  const s = await status(d.name);
  ok(s.state === 'paused' && s.pauseReason === 'restart' && s.recovered === true, 'D.2 it reads as paused, because a restart did it', JSON.stringify(s).slice(0, 200));
  ok(/restarted/.test(s.reason), 'D.3 and says so');
  ok(s.spent.calls === onDisk.spent.calls && s.spent.calls >= 3, 'D.4 the spend so far is kept');
  await tick(80);
  ok(llm.calls === 0, 'D.5 no call is made by reading it, or by waiting');
  ok(readFileSync(recordFile(d.name)).equals(bytes), 'D.6 reading it writes nothing');
  const est = await get(`/${d.name}/semantic-dupes/compare-all/estimate`);
  ok(llm.calls === 0 && est.body.job.state === 'paused', 'D.7 neither does the estimate');

  const saved = (await dc.loadDuplicateChecks(d.name)).size;
  ok(saved >= 40, 'D.8 the answers the dead process paid for are saved', String(saved));
  const r = await post(`/${d.name}/semantic-dupes/compare-all/resume`, {});
  ok(r.status === 200, 'D.9 an explicit Resume runs it');
  await settled();
  const end = await status(d.name);
  ok(end.state === 'done', 'D.10 and finishes', JSON.stringify(end).slice(0, 200));
  ok(llm.sent.length === 190 - saved, 'D.11 sending only what was not saved', `${llm.sent.length} sent, ${saved} saved`);
  ok(approx(end.spent.usd, (onDisk.spent.calls + llm.calls) * CALL_USD), 'D.12 spend carries across the crash');
  ok(end.recovered === false, 'D.13 and it no longer reads as recovered');

  // A recovered job already at its limit makes no call at all.
  const e = family(12);
  const l2 = fakeLLM();
  job.__setCompareAllLlmForTest(l2);
  const rec = JSON.parse(readFileSync(recordFile(d.name), 'utf8'));
  writeFileSync(recordFile(e.name), JSON.stringify({ ...rec, domain: e.name, state: 'running', limit: { kind: 'usd', confirmed: 1, stopAt: 1.2 }, spent: { ...rec.spent, usd: 1.2 } }));
  const resumed = await post(`/${e.name}/semantic-dupes/compare-all/resume`, {});
  ok(resumed.status === 200, 'D.14 resuming one at its limit is allowed');
  await settled();
  const atLimit = await status(e.name);
  ok(atLimit.state === 'stopped' && atLimit.stopReason === 'spend-limit' && l2.calls === 0, 'D.15 and it stops before any call', JSON.stringify({ s: atLimit.state, c: l2.calls }));

  // A bad record is no record.
  const g = family(4);
  mkdirSync(getDuplicateJobsDir(), { recursive: true });
  writeFileSync(recordFile(g.name), 'not json');
  ok((await status(g.name)).state === 'none', 'D.16 a corrupt record reads as no job');
  writeFileSync(recordFile(g.name), JSON.stringify({ format: 99, state: 'running' }));
  ok((await status(g.name)).state === 'none', 'D.17 so does a wrong-shaped one');
}

// ═══════════════════════════════════════════════════════════════════════════
section('E. The stop at 120%, retries and fallbacks in the spend');
{
  const d = family(30); // 435 pairs, 22 batches
  let llm = fakeLLM();
  job.__setCompareAllLlmForTest(llm);
  const confirmed = 5.5 * CALL_USD; // stops at 6.6 calls' worth
  await start(d.name, { confirmedUsd: confirmed });
  await settled();
  let s = await status(d.name);
  ok(s.state === 'stopped' && s.stopReason === 'spend-limit', 'E.1 it stops itself', JSON.stringify(s).slice(0, 300));
  ok(llm.calls === 6 && approx(s.spent.usd, 6 * CALL_USD), 'E.2 after 6 calls: a seventh would pass 120%, so it is not made', `${llm.calls} calls, ${s.spent.usd}`);
  ok(s.spent.usd <= confirmed * 1.2, 'E.3 not above 120%');
  ok(/120%/.test(s.reason) && s.reason.includes('$'), 'E.4 and says why, in dollars', s.reason);
  ok((await dc.loadDuplicateChecks(d.name)).size === 120, 'E.5 what it paid for is saved');
  const res = await post(`/${d.name}/semantic-dupes/compare-all/resume`, {});
  ok(res.status === 409 && res.body.code === 'JOB_NOT_PAUSED', 'E.6 Resume cannot spend past it: that takes a new confirm');
  llm = fakeLLM();
  job.__setCompareAllLlmForTest(llm);
  await start(d.name, { confirmedUsd: 100 });
  await settled();
  s = await status(d.name);
  ok(s.state === 'done' && llm.sent.length === 435 - 120, 'E.7 a new confirm carries on from there', JSON.stringify(s.progress));

  // A reply the scan cannot use is billed, and the split that follows it is billed too.
  const r = family(9); // 36 pairs: batches of 20 and 16
  let first = true;
  const retrying = async (sys, user, max, mode, sc, opts) => {
    retrying.calls++;
    opts.onUsage({ ...USAGE, model: MODEL, provider: 'gemini' });
    if (first) { first = false; return 'this is not the shape'; }
    return JSON.stringify({ results: pairsIn(user).map((p) => ({ index: p.index, relation: 'different', difference: 'x' })) });
  };
  retrying.calls = 0;
  job.__setCompareAllLlmForTest(retrying);
  await start(r.name);
  await settled();
  s = await status(r.name);
  ok(retrying.calls === 4 && s.spent.calls === 4, 'E.8 the bad reply and both halves of its split are all counted', `${retrying.calls} calls, spent ${s.spent.calls}`);
  ok(approx(s.spent.usd, 4 * CALL_USD), 'E.9 and all are priced', String(s.spent.usd));
  ok(s.progress.checkedPairs === 36, 'E.10 the retry got every answer');

  // The stop counts retries too: a confirm of two calls, the first batch alone takes three.
  const r2 = family(9);
  let first2 = true;
  let calls2 = 0;
  job.__setCompareAllLlmForTest(async (sys, user, max, mode, sc, opts) => {
    calls2++;
    opts.onUsage({ ...USAGE, model: MODEL, provider: 'gemini' });
    if (first2) { first2 = false; return 'not the shape'; }
    return JSON.stringify({ results: pairsIn(user).map((p) => ({ index: p.index, relation: 'different', difference: 'x' })) });
  });
  await start(r2.name, { confirmedUsd: 2.5 * CALL_USD / 1.2 });
  await settled();
  s = await status(r2.name);
  ok(s.stopReason === 'spend-limit' && calls2 === 2, 'E.11 the limit stops a retry between the halves of a split', `${calls2} calls`);

  // A dearer fallback answers: spend is at ITS price, and the stop comes sooner.
  const rung = 'gemini-3.1-flash-lite';
  const dear = llmMod.priceUsageUsd(rung, { ...USAGE, calls: 1 });
  ok(dear > CALL_USD * 2, 'E.12 (control) the rung really costs more', `${dear} vs ${CALL_USD}`);
  const f = family(30);
  llm = fakeLLM({ usage: (fn) => ({ ...USAGE, model: fn.calls >= 2 ? rung : MODEL, provider: 'gemini' }) });
  job.__setCompareAllLlmForTest(llm);
  await start(f.name, { confirmedUsd: 5.5 * CALL_USD });
  await settled();
  s = await status(f.name);
  ok(s.fallbackAnswered === true && s.answeredBy[rung].calls >= 1 && s.answeredBy[MODEL].calls === 1, 'E.13 the record says who really answered', JSON.stringify(s.answeredBy));
  const expected = CALL_USD + s.answeredBy[rung].calls * dear;
  ok(approx(s.spent.usd, expected), 'E.14 each call is priced at the model that answered', `${s.spent.usd} vs ${expected}`);
  ok(s.stopReason === 'spend-limit' && llm.calls < 6, 'E.15 so the limit is reached in fewer calls', String(llm.calls));
  ok(s.spent.usd <= 5.5 * CALL_USD * 1.2, 'E.16 and still not above it', String(s.spent.usd));

  // An unpriced answer: the dollars cannot be checked any more.
  const g = family(30);
  llm = fakeLLM({ usage: () => ({ ...USAGE, model: 'unpriced/model-x', provider: 'openrouter' }) });
  job.__setCompareAllLlmForTest(llm);
  await start(g.name);
  await settled();
  s = await status(g.name);
  ok(s.stopReason === 'price-unknown' && llm.calls === 1, 'E.17 an answer with no price stops it at once', JSON.stringify({ r: s.stopReason, c: llm.calls }));
  ok(/no published price/.test(s.reason), 'E.18 and says why');

  // A provider that reports no usage would otherwise read as free, for ever.
  const z = family(30);
  llm = fakeLLM({ usage: () => ({ model: MODEL, provider: 'gemini' }) });
  job.__setCompareAllLlmForTest(llm);
  await start(z.name);
  await settled();
  s = await status(z.name);
  ok(s.stopReason === 'price-unknown' && llm.calls === 1 && /without saying/.test(s.reason), 'E.19 an answer with no usage stops it at once', JSON.stringify({ r: s.stopReason, c: llm.calls }));
}

// ═══════════════════════════════════════════════════════════════════════════
section('F. Failures, a changed model, a page gone mid-run');
{
  const d = family(30);
  let calls = 0;
  job.__setCompareAllLlmForTest(async () => { calls++; throw new Error('quota exhausted'); });
  await start(d.name);
  await settled();
  let s = await status(d.name);
  ok(s.state === 'paused' && s.pauseReason === 'provider-errors', 'F.1 a provider failing every batch pauses it', JSON.stringify(s).slice(0, 300));
  ok(calls === 3, 'F.2 after three batches, not all 22', String(calls));
  ok(/quota exhausted/.test(s.reason) && s.lastError === 'quota exhausted', 'F.3 and shows the error');
  ok(s.spent.calls === 0, 'F.4 a call that failed is not billed');

  const llm = fakeLLM();
  job.__setCompareAllLlmForTest(llm);
  process.env.LLM_MODEL = 'gemini-3.1-flash-lite';
  let r = await post(`/${d.name}/semantic-dupes/compare-all/resume`, {});
  ok(r.status === 409 && r.body.code === 'JOB_MODEL_CHANGED' && llm.calls === 0, 'F.5 a changed model cannot resume on the old confirm', JSON.stringify(r.body).slice(0, 200));
  delete process.env.LLM_MODEL;
  r = await post(`/${d.name}/semantic-dupes/compare-all/resume`, {});
  ok(r.status === 200, 'F.6 the same model can');
  await settled();
  ok((await status(d.name)).state === 'done', 'F.7 and finishes');

  // One failed batch among good ones does not pause it; those pairs stay unanswered.
  const e = family(12);
  let n = 0;
  job.__setCompareAllLlmForTest(fakeLLM({ before: async () => { n++; if (n === 1) throw new Error('blip'); } }));
  await start(e.name);
  await settled();
  s = await status(e.name);
  ok(s.state === 'done' && s.progress.failedPairs === 20 && s.progress.checkedPairs === 46, 'F.8 one failed batch: it finishes and counts what it could not answer', JSON.stringify(s.progress));

  // A page merged away during the run is not paid for.
  const g = family(12);
  const target = 'widget-model-011';
  const gone = fakeLLM({ before: async (fn) => { if (fn.calls === 1) rmSync(path.join(g.wiki, `concepts/${target}.md`)); } });
  job.__setCompareAllLlmForTest(gone);
  await start(g.name);
  await settled();
  const after = gone.sent.slice(20).filter((x) => x.includes(target));
  ok(after.length === 0, 'F.9 pairs touching a page deleted mid-run are not sent', after.join(' | '));
  const sAfter = await status(g.name);
  ok(sAfter.state === 'done', 'F.10 and the job still finishes');
  const fresh = await ai.semanticScanStatus(g.name);
  ok(fresh.totalPairs === 55, 'F.11 the count afterwards does not include them', String(fresh.totalPairs));

  // The domain itself removed mid-run.
  const h = family(12);
  job.__setCompareAllLlmForTest(fakeLLM({ before: async () => { rmSync(path.join(DOMAINS_DIR, h.name), { recursive: true, force: true }); } }));
  await start(h.name);
  await settled();
  const rec = JSON.parse(readFileSync(recordFile(h.name), 'utf8'));
  ok(rec.state === 'stopped' && rec.stopReason === 'domain-missing', 'F.12 a deleted domain stops it', JSON.stringify({ s: rec.state, r: rec.stopReason }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Only for the mutation runs of guards outside the memo: this section is most of the time.
const SKIP_MEMO = process.env.DUPJOB_SKIP_MEMO === '1';
section('H. The memo filter equals a full pass');
if (!SKIP_MEMO) {
  const passes = ai.__testing.candidateFullPasses;
  // Seeded, so a failure reproduces.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'neural', 'network', 'model', 'agent', 'privacy', 'data', 'law', 'graph', 'token', 'memory', 'claude', 'gemini', 'open', 'source', 'vector', 'index'];
  const name = 'memo' + (++seq);
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  const pages = new Set();
  while (pages.size < 2000) {
    const shape = rnd(6);
    const w = () => WORDS[rnd(WORDS.length)];
    const s = shape === 0 ? `${w()}-${w()}` : shape === 1 ? `${w()}-${w()}-${rnd(40)}` : shape === 2 ? `${w()}_${w()}-${w()}` : shape === 3 ? `${w()}s-${w()}` : shape === 4 ? `${w()}${w()}${rnd(9)}` : `${w()}-${w()}-${w()}-${w()}`;
    pages.add(`${rnd(3) === 0 ? 'entities' : 'concepts'}/${s}`);
  }
  // Shapes a whole-domain signal would trip on: spelling variants and acronyms.
  for (const s of ['hand-off', 'handoff', 'rag', 'retrieval-augmented-generation', 'neural-networks', 'neural-network', 'foo_bar', 'foo-bar']) pages.add(`concepts/${s}`);
  for (const p of pages) writeFileSync(path.join(wiki, `${p}.md`), `# ${p}\n\nAbout it.\n`);
  const cross = 'entities/shared-name';
  writeFileSync(path.join(wiki, `${cross}.md`), '# x\n');
  writeFileSync(path.join(wiki, 'concepts/shared-name.md'), '# y\n');
  pages.add(cross); pages.add('concepts/shared-name');

  const canon = (r) => JSON.stringify({ pageCount: r.pageCount, pairs: r.pairs, truncated: r.truncated, totalCandidates: r.totalCandidates, dismissed: r.dismissed });
  const full = async () => canon(await health.findSemanticCandidatePairs(name, Number.MAX_SAFE_INTEGER));
  const memoed = async () => canon(await ai.__testing.liveCandidates(name));

  const startPasses = passes();
  const firstFull = await full();
  ok(await memoed() === firstFull, 'H.1 the first answer is the full pass');
  ok(passes() === startPasses + 1, 'H.2 one pass');
  ok(JSON.parse(firstFull).totalCandidates > 3000, 'H.3 (control) a real number of pairs', String(JSON.parse(firstFull).totalCandidates));

  const list = [...pages];
  let rounds = 0, disagreements = 0, dismissedSome = 0;
  const dismissals = [];
  for (const removeCount of [1, 1, 1, 2, 5, 1, 13, 1, 40, 3, 1, 90]) {
    for (let k = 0; k < removeCount; k++) {
      const i = rnd(list.length);
      rmSync(path.join(wiki, `${list[i]}.md`));
      list.splice(i, 1);
    }
    // Sometimes a Keep both, and sometimes one taken back: dismissals move both ways.
    const current = JSON.parse(await memoed());
    const pick = current.pairs[rnd(current.pairs.length)];
    if (rounds % 3 === 0) {
      await addDismissal(name, 'semanticDupe', pick, 'test');
      dismissals.push(pick);
      dismissedSome++;
    } else if (rounds % 3 === 1 && dismissals.length) {
      await removeDismissal(name, 'semanticDupe', dismissals.pop());
    }
    const reference = await full();
    const derived = await memoed();
    if (derived !== reference) {
      disagreements++;
      const a = JSON.parse(derived); const b = JSON.parse(reference);
      console.log(`      round ${rounds}: derived ${a.totalCandidates}, full ${b.totalCandidates}, dismissed ${a.dismissed}/${b.dismissed}`);
    }
    rounds++;
  }
  ok(disagreements === 0, `H.4 byte-identical to a full pass, order included, over ${rounds} rounds of deletes and dismissals`, `${disagreements} disagreed`);
  ok(passes() === startPasses + 1, 'H.5 and no full pass ran in the memo', `${passes() - startPasses} passes`);
  ok(dismissedSome >= 3, 'H.6 (control) dismissals really moved', String(dismissedSome));

  // A dumb cross-check, not built on any of this: the survivors are exactly the pairs
  // of the original list that touch no deleted page and no dismissal.
  const alive = new Set(list);
  const original = JSON.parse(firstFull).pairs;
  const survivors = original.filter((p) => alive.has(`${p.folderA}/${p.slugA}`) && alive.has(`${p.folderB}/${p.slugB}`));
  const dismissedPairs = new Set(dismissals.map((p) => dc.pairKey(p.folderA, p.slugA, p.folderB, p.slugB)));
  const dumb = survivors.filter((p) => !dismissedPairs.has(dc.pairKey(p.folderA, p.slugA, p.folderB, p.slugB)));
  ok(JSON.stringify(dumb) === JSON.stringify(JSON.parse(await memoed()).pairs), 'H.7 and to a plain filter of the original list', `${dumb.length} vs ${JSON.parse(await memoed()).pairs.length}`);

  const fig = await (async () => {
    await saveOne(name);
    return ai.semanticScanStatus(name, 500);
  })();
  ok(fig.figuresFrom === 'memo-filtered' && fig.estimated === false, 'H.8 status says where its figures came from, and that they are not estimates', JSON.stringify({ f: fig.figuresFrom, e: fig.estimated }));
  const before = passes();
  const rec1 = await ai.semanticScanStatus(name, 500, { reconcile: true });
  ok(passes() === before + 1 && rec1.figuresFrom === 'full-pass', 'H.9 the panel opening repeats the pass once, after a filter', JSON.stringify({ d: passes() - before, f: rec1.figuresFrom }));
  ok(rec1.totalPairs === fig.totalPairs && rec1.checkedPairs === fig.checkedPairs, 'H.10 and the recount agrees');
  await ai.semanticScanStatus(name, 500, { reconcile: true });
  ok(passes() === before + 1, 'H.11 opening again with nothing changed does not repeat it');

  // New pages go the slow way: nothing is known about their pairs.
  const b2 = passes();
  writeFileSync(path.join(wiki, 'concepts/alpha-beta-new.md'), '# new\n\nNew page.\n');
  ok(await memoed() === await full(), 'H.12 a new page gives the true list');
  ok(passes() === b2 + 1, 'H.13 through a full pass');
  // A rename is a delete and an add.
  rmSync(path.join(wiki, 'concepts/alpha-beta-new.md'));
  writeFileSync(path.join(wiki, 'concepts/alpha-beta-newer.md'), '# new\n\nNew page.\n');
  const b3 = passes();
  ok(await memoed() === await full() && passes() === b3 + 1, 'H.14 so does a rename');
  // Another domain does not get this one's list.
  const o = family(6);
  ok((await ai.__testing.liveCandidates(o.name)).totalCandidates === 15, 'H.15 another domain is its own pass');
}

async function saveOne(name) {
  const { pairs } = await ai.__testing.liveCandidates(name);
  const p = pairs[0];
  const keep = `${p.folderA}/${p.slugA}`;
  await ai.scanSemanticDuplicates(name, { maxPairs: 1, costCeilingTokens: 1e9, generateText: fakeLLM() }, () => {});
  return keep;
}

// A real merge, against a full recomputation, on the figures a person sees.
section('H2. After a real merge: coverage against a fresh full pass');
{
  const d = family(30);
  job.__setCompareAllLlmForTest(fakeLLM());
  await start(d.name, { confirmedUsd: 100 });
  await settled();
  const status0 = await ai.semanticScanStatus(d.name, 500);
  ok(status0.checkedPairs === 435 && status0.leftPairs === 0, 'H2.1 everything is answered', JSON.stringify({ c: status0.checkedPairs, l: status0.leftPairs }));

  const issue = { keepFolder: 'concepts', keepSlug: 'widget-model-000', removeFolder: 'concepts', removeSlug: 'widget-model-001' };
  const { body: p } = await post(`/${d.name}/semantic-dupes/preview`, { issue });
  const m = await post(`/${d.name}/fix`, { type: 'semanticDupe', issue, basis: p.basis });
  ok(m.body.fixed === 1, 'H2.2 merge', JSON.stringify(m.body));

  const passes = ai.__testing.candidateFullPasses;
  const b = passes();
  const after = await ai.semanticScanStatus(d.name, 500);
  ok(passes() === b, 'H2.3 the recount after a merge runs no full pass');
  ok(after.figuresFrom === 'memo-filtered', 'H2.4 and says so');
  ai.__testing.forgetCandidateMemo();
  const truth = await ai.semanticScanStatus(d.name, 500);
  ok(truth.figuresFrom === 'full-pass', 'H2.5 (control) the reference is a full pass');
  ok(after.totalPairs === truth.totalPairs && after.checkedPairs === truth.checkedPairs && after.leftPairs === truth.leftPairs && after.rememberedPairs === truth.rememberedPairs,
    'H2.6 every figure equals the full pass', JSON.stringify({ after: [after.totalPairs, after.checkedPairs, after.leftPairs], truth: [truth.totalPairs, truth.checkedPairs, truth.leftPairs] }));
  ok(after.totalPairs === 406, 'H2.7 435 less the 29 pairs of the deleted page', String(after.totalPairs));
  // Was 28: on a short page the moved text fell inside the 500 characters the model reads,
  // so one merge lapsed every answer about the kept page and they were billed again.
  // pageOpening stops at the composer's own heading, so nothing lapses.
  ok(after.leftPairs === 0, 'H2.8 a merge re-bills nothing: the kept page\'s answers still apply', String(after.leftPairs));
}

// ═══════════════════════════════════════════════════════════════════════════
section('I. Families: A~B and B~C say nothing about A~C');
{
  const name = 'fam' + (++seq);
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  const P = (s) => path.join(wiki, `concepts/${s}.md`);
  for (const s of ['claude-opus', 'claude-opus-5', 'claude-opus-4', 'claude-opus-3', 'lonely-page-one', 'lonely-page-two', 'solo-page']) writeFileSync(P(s), `# ${s}\n\nAbout ${s}.\n`);
  const unordered = (x, y) => [x, y].sort().join(' + ');
  const yes = new Set([
    unordered('concepts/claude-opus', 'concepts/claude-opus-5'),
    unordered('concepts/claude-opus-4', 'concepts/claude-opus-5'),
    unordered('concepts/lonely-page-one', 'concepts/lonely-page-two'),
  ]);
  const left = new Set([unordered('concepts/claude-opus', 'concepts/claude-opus-4')]);
  const llm = fakeLLM({
    decide: (p) => {
      const key = unordered(p.a, p.b);
      if (yes.has(key)) return { relation: 'same', confidence: 'high', difference: 'none' };
      if (left.has(key)) return null; // the model left this pair out: never compared
      return { relation: 'different', difference: 'x' };
    },
  });
  await ai.scanSemanticDuplicates(name, { maxPairs: 500, costCeilingTokens: 1e9, generateText: llm }, () => {});

  const before = treeHash(path.join(DOMAINS_DIR, name));
  const callsBefore = llm.calls;
  const { status: st, body } = await get(`/${name}/semantic-dupes/families`);
  ok(st === 200 && body.openPairs === 3, 'I.1 the open pairs', JSON.stringify({ st, o: body.openPairs }));
  ok(treeHash(path.join(DOMAINS_DIR, name)) === before && llm.calls === callsBefore, 'I.2 read-only: no write, no call');
  ok(body.families.length === 2 && body.families[0].size === 3 && body.families[1].size === 2, 'I.3 grouped by shared pages', JSON.stringify(body.families.map((f) => f.pages.map((p) => p.slug))));
  const fam = body.families[0];
  ok(fam.suggestedStay === 'concepts/claude-opus-5', 'I.4 the page with the most open pairs is suggested', fam.suggestedStay);
  const by = (f, slug) => f.pages.find((p) => p.slug === slug);
  ok(by(fam, 'claude-opus').compared === 'same' && by(fam, 'claude-opus-4').compared === 'same', 'I.5 each states a real answer against the page that stays');
  ok(by(fam, 'claude-opus-5').stays === true && by(fam, 'claude-opus-5').compared === undefined, 'I.6 the page that stays is marked');
  ok(!!by(fam, 'claude-opus').opening, 'I.7 every page\'s opening is there');
  ok(!fam.pages.some((p) => p.slug === 'claude-opus-3'), 'I.8 a page the AI said differs from all of them is not in the family');

  // THE POINT. Stay on claude-opus: claude-opus-4 is connected through -5 and only -5.
  const other = (await get(`/${name}/semantic-dupes/families?stay=${encodeURIComponent('concepts/claude-opus')}`)).body.families[0];
  ok(other.stays === 'concepts/claude-opus', 'I.9 the page that stays can be chosen');
  ok(by(other, 'claude-opus-4').compared === 'never', 'I.10 A~B and B~C: A against C is plainly "never"', JSON.stringify(by(other, 'claude-opus-4')));
  ok(by(other, 'claude-opus-5').compared === 'same', 'I.11 and the real one is still "same"');
  ok(by(other, 'claude-opus-4').confidence === undefined, 'I.12 "never" claims no confidence');
  const unknownStay = (await get(`/${name}/semantic-dupes/families?stay=${encodeURIComponent('concepts/not-in-any')}`)).body.families[0];
  ok(unknownStay.stays === unknownStay.suggestedStay, 'I.13 an unknown page falls back to the suggestion');

  // An answer that no longer applies is not an answer.
  writeFileSync(P('claude-opus-4'), '# claude-opus-4\n\nA changed opening.\n');
  let after = (await get(`/${name}/semantic-dupes/families`)).body;
  ok(!after.families.some((f) => f.pages.some((p) => p.slug === 'claude-opus-4')), 'I.14 a changed opening takes that pair out of the open pairs');
  writeFileSync(P('claude-opus-4'), '# claude-opus-4\n\nAbout claude-opus-4.\n');

  // An old answer for this exact pair, about openings that have since changed, while
  // both pages stay in the family through other answers.
  const key = dc.pairKey('concepts', 'claude-opus-4', 'concepts', 'claude-opus');
  const anyRec = [...(await dc.loadDuplicateChecks(name)).values()].find((x) => x.verdict === 'yes');
  await dc.saveDuplicateChecks(name, new Map([[key, { ...anyRec, keep: 'concepts/claude-opus', remove: 'concepts/claude-opus-4', openings: 'other-openings' }]]));
  after = (await get(`/${name}/semantic-dupes/families?stay=${encodeURIComponent('concepts/claude-opus')}`)).body.families[0];
  ok(by(after, 'claude-opus-4').compared === 'stale' && by(after, 'claude-opus-4').confidence === undefined, 'I.14b an answer about other openings is "stale", never "same"', JSON.stringify(by(after, 'claude-opus-4')));

  // A Keep both between a member and the page that stays is said, in words.
  await addDismissal(name, 'semanticDupe', { folderA: 'concepts', slugA: 'claude-opus-4', folderB: 'concepts', slugB: 'claude-opus' }, 'test');
  after = (await get(`/${name}/semantic-dupes/families?stay=${encodeURIComponent('concepts/claude-opus')}`)).body.families[0];
  ok(by(after, 'claude-opus-4').compared === 'kept-both', 'I.15 a Keep both is stated', JSON.stringify(by(after, 'claude-opus-4')));

  // Dumb cross-check of the grouping: repeated merging of sets, no union-find.
  const edges = (await ai.semanticRememberedPairs(name)).pairs.map((p) => [`${p.keepFolder}/${p.keepSlug}`, `${p.removeFolder}/${p.removeSlug}`]);
  let sets = edges.map((e) => new Set(e));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < sets.length && !changed; i++) for (let j = i + 1; j < sets.length && !changed; j++) {
      if ([...sets[i]].some((x) => sets[j].has(x))) { sets[i] = new Set([...sets[i], ...sets[j]]); sets.splice(j, 1); changed = true; }
    }
  }
  const dumb = sets.map((s) => [...s].sort().join(',')).sort();
  const real = after && (await get(`/${name}/semantic-dupes/families`)).body.families.map((f) => f.pages.map((p) => p.page).sort().join(',')).sort();
  ok(JSON.stringify(dumb) === JSON.stringify(real), 'I.16 the grouping equals a dumb set merge', JSON.stringify({ dumb, real }));

  const empty = family(3);
  const none = await get(`/${empty.name}/semantic-dupes/families`);
  ok(none.status === 200 && none.body.families.length === 0, 'I.17 nothing compared yet: no families');
}

job.__setCompareAllLlmForTest(null);
server.close();
rmSync(USER_DIR, { recursive: true, force: true });
rmSync(DOMAINS_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
