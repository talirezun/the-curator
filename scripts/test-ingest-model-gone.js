#!/usr/bin/env node
/**
 * test-ingest-model-gone.js — OFFLINE suite for the PRE-SPEND gate: an ingest
 * whose pinned model the provider no longer offers must refuse BEFORE the first
 * paid call, on both the single-file route and the batch queue.
 *
 * ── WHAT THIS EXISTS TO PROVE, AND WHY A COUNT IS THE ONLY HONEST PROOF ────
 *
 * The claim is "no money was spent". A test that asserts the ERROR MESSAGE
 * proves the user was told something; it does not prove the pipeline stopped.
 * So both sections drive the real handler with an INJECTED ingest seam that
 * COUNTS ITS OWN INVOCATIONS, and assert ZERO. That count is the assertion;
 * everything else is about whether the refusal is usable.
 *
 * A multi-phase ingest is one outline call plus one per content batch — 25+ on a
 * large source — and every one of them would fail identically against a
 * withdrawn model, after llm.js had spent its 429/503 retry ladder on each.
 *
 * ── MUTATIONS RUN AGAINST THIS SUITE ───────────────────────────────────────
 *
 *   M6  remove the ingest route's pre-spend gate            (§1 reds, 5 assertions)
 *   M12 remove the batch queue's pre-spend gate             (§2 reds, 4 assertions)
 *   M13 classify the model-gone error as TRANSIENT          (§2 reds: the job PAUSES)
 *   M14 make the gate fire on `!== 'present'` (null too)    (§1b/§2b red)
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR before any
 * app import; real credential files fingerprinted by sha256 + size + existence.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), Object.is(actual, expected)
    ? label
    : `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-model-gone-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
const TMP_QUEUE = path.join(TMP, 'queue');
for (const d of [TMP_USER, TMP_DOMAINS, TMP_QUEUE]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;
delete process.env.LLM_MODEL;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(REPO_ROOT, f));
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

const FAKE_KEY = ['sk', 'or', 'v1', 'B'.repeat(40)].join('-');
writeFileSync(path.join(TMP_USER, '.curator-config.json'), JSON.stringify({
  openrouterApiKey: FAKE_KEY,
  activeProvider: 'openrouter',
  selectedModels: { openrouter: 'minimax/minimax-m3:free' },
}), { mode: 0o600 });

// A domain with the folders ingest expects.
const DOMAIN = 'zztest-model-gone';
for (const sub of ['raw', 'wiki']) mkdirSync(path.join(TMP_DOMAINS, DOMAIN, sub), { recursive: true });
writeFileSync(path.join(TMP_DOMAINS, DOMAIN, 'CLAUDE.md'), '# schema\n');
writeFileSync(path.join(TMP_DOMAINS, DOMAIN, 'wiki', 'index.md'), '# Index\n');

const llm = await import('../src/brain/llm.js');
const { default: express } = await import('express');
const { createServer } = await import('http');

console.log('test-ingest-model-gone.js — the pre-spend gate\n');

// The state both sections run against: the pinned model is withdrawn.
llm.recordLiveModelListing('openrouter', [
  'minimax/minimax-m3',            // the PAID twin is listed
  'upstage/solar-pro4',
  'ibm-granite/granite-4.0-h-micro',
], { source: 'network' });

{
  const info = llm.getProviderInfo();
  eq(info.model, 'minimax/minimax-m3:free', 'fixture: the resolved build model is the withdrawn id');
  eq(llm.catalogueAbsence(info.provider, info.model), 'missing', 'fixture: and it is reported missing');
}

// ─────────────────────────────────────────────────────────────────────────
// §1. The single-file route
// ─────────────────────────────────────────────────────────────────────────
section('§1. POST /api/ingest — the SSE error frame, and ZERO provider calls [M6]');

/**
 * ── COUNTING AT THE TRANSPORT, NOT AT `ingestFile` ─────────────────────────
 *
 * The route imports `ingestFile` statically and an ESM namespace object is
 * non-configurable, so neither can be stubbed. `llm.js`'s OWN seam —
 * `__setOpenRouterAdapterFactory`, the same one the OpenRouter suites use — is
 * better anyway: it counts at the LAST layer before the wire, so the assertion
 * becomes "did anything try to reach the provider". That is the actual claim,
 * and it is stronger than counting entries into `ingestFile`, because a future
 * refactor could add a second spend path beside it and a call-site count would
 * not notice.
 *
 * The double THROWS rather than returning a fake completion: a run that gets
 * past the gate must fail loudly and visibly, never produce a plausible wiki.
 */
let providerCalls = 0;
llm.__setOpenRouterAdapterFactory(() => ({
  createChatCompletion: async () => {
    providerCalls++;
    throw new Error('the injected transport should never be reached before the gate');
  },
}));

const { default: ingestRouter } = await import('../src/routes/ingest.js');
const app = express();
app.use('/api/ingest', ingestRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/** POST a multipart upload and collect the SSE frames. */
async function postIngest(filename, body) {
  const form = new FormData();
  form.set('domain', DOMAIN);
  form.set('file', new Blob([body], { type: 'text/markdown' }), filename);
  const res = await fetch(`${BASE}/api/ingest`, { method: 'POST', body: form });
  const text = await res.text();
  const frames = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { frames.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
    }
  }
  return { status: res.status, contentType: res.headers.get('content-type'), frames };
}

{
  providerCalls = 0;
  const { contentType, frames } = await postIngest('gone.md', '# A source\n\n' + 'word '.repeat(400));
  ok(String(contentType).includes('text/event-stream'),
    'the refusal arrives on the SSE stream, not as a JSON body a streaming client would never read');
  const err = frames.find(f => f.type === 'error');
  ok(err, '★ an error frame is emitted [M6]');
  eq(err && err.code, 'MODEL_GONE', '★ …carrying the machine-readable code [M6]');
  ok(err && /no longer offers/.test(err.message), '…and a message that says what happened');
  ok(err && err.message.includes('minimax/minimax-m3:free'), '…naming the model');
  ok(err && /pick another model/i.test(err.message), '…and what to do next');
  eq(providerCalls, 0,
    '★★ ZERO provider calls — the claim is "no money was spent", and a call count is the only thing that proves it [M6: removing the gate drives the real ingest and this becomes non-zero]');
  ok(!frames.some(f => f.type === 'done'), 'and no `done` frame, so no client renders a success panel');
}

section('§1b. An UNCHECKED provider must NOT be blocked [M14]');
{
  llm.__clearLiveModelListings();
  eq(llm.catalogueAbsence('openrouter', 'minimax/minimax-m3:free'), null, 'fixture: with no listing the verdict is null');
  providerCalls = 0;
  const { frames } = await postIngest('unchecked.md', '# Another source\n\n' + 'word '.repeat(400));
  const err = frames.find(f => f.type === 'error');
  ok(!err || err.code !== 'MODEL_GONE',
    '★ the ingest is NOT refused as model-gone — "we could not check" may never block work [M14: gating on `!== \'present\'` refuses here]');
  ok(providerCalls > 0,
    '★★ …it proceeds all the way to the TRANSPORT, which is the positive control for the zero above: the same harness CAN count a call, so §1\'s 0 is a real refusal and not a broken counter [M14]');
}

await new Promise(r => server.close(r));
llm.__setOpenRouterAdapterFactory(null);

// ─────────────────────────────────────────────────────────────────────────
// §2. The batch queue
// ─────────────────────────────────────────────────────────────────────────
section('§2. The batch queue — the item FAILS, the job does not PAUSE, nothing spends [M12, M13]');

process.env.CURATOR_TEST_INGEST_QUEUE_DIR = TMP_QUEUE;
const queue = await import('../src/brain/ingest-queue.js');

// Re-arm the withdrawn state for this section.
llm.recordLiveModelListing('openrouter', ['minimax/minimax-m3', 'upstage/solar-pro4'], { source: 'network' });
eq(llm.catalogueAbsence('openrouter', 'minimax/minimax-m3:free'), 'missing', 'fixture: still missing');

{
  // `classifyTransientError` is the function that decides PAUSE vs FAIL. Driving
  // it directly is what pins M13: a model-gone error classified transient would
  // pause the whole batch — and pause again on every Resume, forever, because a
  // withdrawn model does not come back with time.
  const gone = llm.makeModelGoneError('openrouter', 'minimax/minimax-m3:free');
  eq(queue.classifyTransientError(gone), null,
    '★★ the model-gone error is NOT transient, so it fails ONE item instead of pausing the batch forever [M13]');
  eq(queue.classifyTransientError(gone, { ignore: 'minimax/minimax-m3:free' }), null,
    '…and stays non-transient once the filename-scrub pass has run over it');
  eq(gone.curatorTransient, undefined, 'it carries no curatorTransient tag — the structural signal the classifier reads first');

  // Non-vacuous: the classifier CAN say yes, so the null above is a real answer.
  const rateLimited = Object.assign(new Error('provider said (HTTP 429)'), {});
  ok(queue.classifyTransientError(rateLimited) === 'rate_limit',
    'control: a genuine 429 DOES classify transient, so the assertions above are not passing on a function that always returns null');
}

/**
 * A staged upload in the shape `createJob` expects, and `__testing.processItem`
 * to drive ONE item through the real `processItemInner`. Going via `startJob`
 * plus a poll would exercise the worker loop as well and could not distinguish
 * "the gate refused" from "the loop never selected the item" — which is the
 * reason this module exposes `processItem` in the first place.
 */
async function makeUpload(name, bytes) {
  const p = path.join(TMP, `upload-${Math.random().toString(16).slice(2)}-${name}`);
  writeFileSync(p, Buffer.alloc(bytes, 'x'));
  return { originalname: name, path: p, size: bytes };
}

{
  let ingestCalls = 0;
  const countingIngest = async () => {
    ingestCalls++;
    throw new Error('the injected ingest should never run');
  };

  const job = await queue.createJob({
    domain: DOMAIN,
    uploadedFiles: [await makeUpload('batch-source.md', 4000)],
  });
  ok(job && job.jobId, 'fixture: a one-item job is created');

  const outcome = await queue.__testing.processItem(job.jobId, job.items[0].idx, countingIngest);
  ok(outcome && typeof outcome === 'object', 'processItem settles without throwing, as its own contract requires');

  const after = await queue.getJob(job.jobId);
  const item = after.items[0];
  eq(item.status, 'failed', '★ the item is marked FAILED [M12]');
  eq(item.errorCode, 'MODEL_GONE', '★ …with the machine-readable code, so a client can offer the right remedy [M12]');
  ok(/no longer offers/.test(item.error || ''), '…and the same sentence the route emits — one builder, one wording');
  ok(String(item.error || '').includes('minimax/minimax-m3:free'), '…naming the model');
  eq(ingestCalls, 0,
    '★★ ZERO calls into the ingest seam — the item never reached the pipeline, so it never reached a provider [M12]');
  eq(after.status === 'paused', false,
    '★ the JOB is not paused [M13: classifying model-gone as transient pauses it here, and again on every Resume]');
  eq(after.spentUsd || 0, 0, 'and nothing was charged');
  eq(after.consecutiveFailures, 1,
    'it counts as ONE ordinary failure, so the existing circuit breaker bounds a whole batch of them without a second mechanism');

  const wire = queue.toWire(after);
  eq(wire.items[0].errorCode, 'MODEL_GONE',
    "the code survives the wire allow-list — a field the producer computes and the wire drops is this repo's dominant defect class");
}

section('§2b. An UNCHECKED provider does not block a batch item either [M14]');
{
  // Settle the §2 job by hand. `processItem` deliberately settles the ITEM and
  // leaves the JOB to the worker loop we are not running, so without this the
  // next `createJob` correctly 409s on "a batch is already active" — the guard
  // working, not a defect.
  const stale = await queue.getActiveJob();
  if (stale) await queue.__testing.settleJob(stale.jobId, { status: 'failed', failReason: 'settled by the suite' });
  eq(await queue.getActiveJob(), null, 'fixture: no batch is active, so a second job may be created');

  llm.__clearLiveModelListings();
  eq(llm.catalogueAbsence('openrouter', 'minimax/minimax-m3:free'), null, 'fixture: no listing, so the verdict is null');

  let ingestCalls = 0;
  const countingIngest = async () => {
    ingestCalls++;
    return { title: 'ok', pagesWritten: [], warnings: [], changes: [] };
  };

  const job = await queue.createJob({
    domain: DOMAIN,
    uploadedFiles: [await makeUpload('batch-source-2.md', 4000)],
  });
  await queue.__testing.processItem(job.jobId, job.items[0].idx, countingIngest);

  const after = await queue.getJob(job.jobId);
  eq(ingestCalls, 1,
    "★★ the item RAN — an unchecked provider answers null, and null may never stop work. This is also the positive control for §2's zero: the same harness CAN count a call [M14]");
  eq(after.items[0].status, 'done', '…and completed');
  eq(after.items[0].errorCode, null, 'with no error code, since there was no failure to code');
}

// ─────────────────────────
// §3. Cleanup + isolation proof
// ─────────────────────────
section('§3. Cleanup + isolation proof');
eq(fingerprint(), FINGERPRINT_BEFORE,
  'the real credential files are byte-identical before and after this run');
ok(!existsSync(path.join(REPO_ROOT, 'domains', DOMAIN)),
  'the throwaway domain was never created in the repo\'s real domains/ folder');
delete process.env.CURATOR_TEST_USER_DATA_DIR;
delete process.env.CURATOR_TEST_DOMAINS_DIR;
delete process.env.CURATOR_TEST_INGEST_QUEUE_DIR;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
ok(!existsSync(TMP), 'the isolated tempdir is removed');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All ingest model-gone assertions green');
