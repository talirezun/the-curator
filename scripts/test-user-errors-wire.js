#!/usr/bin/env node
/**
 * Plain-language errors on the wires the res.json wrapper cannot reach
 * (v3.99.2, error-inventory §2 Part B): SSE `error` frames, job records, and
 * the Verify AI connection result. Offline.
 *
 * A real Anthropic SDK client talks to a local stub server, so every failure
 * below is the SDK's own error class and message (`401 {"type":"error",…}`),
 * reached through the REAL llm.js generateText path (no hand-typed fixture
 * strings on the provider side).
 *
 *   §1 Settings › General › Verify AI connection (runLiveApiCheck): a bad key,
 *      no credit and offline answer in plain words, with `detail` and `code`.
 *   §2 Ingest (single file) SSE: the `error` frame is plain, with detail/code.
 *   §3 Compile SSE and §4 Chat (stream and JSON): the same.
 *   §5 Health's AI scan: a `batch-error` frame is plain on the wire.
 *   §6 Ingest queue: the item on the WIRE is plain, the manifest on DISK keeps
 *      the raw text (byte-identical across toWire), a pre-existing errorCode
 *      survives, a deliberate sentence passes unchanged, and a transient pause
 *      still pauses and resumes (classifyTransientError reads the raw error).
 *   §7 duplicate-job plainProviderError: catalogue first, old behaviour else.
 *   §8 A deliberate sentence passes every exit unchanged.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function section(t) { console.log(`\n${t}`); }
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? `  [${typeof extra === 'string' ? extra : JSON.stringify(extra)}]` : ''}`); }
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const RAW_RE = /E[A-Z]{3,}:|Command failed|\{"type"|\/Users\/|HTTP \d{3}|fetch failed|authentication_error/;

// ── Isolation, BEFORE any brain module is imported ─────────────────────────
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-user-errors-wire-'));
const DOMAINS = path.join(TMP, 'domains');
const USERDATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USERDATA, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USERDATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_LOG_DIR = path.join(USERDATA, 'logs');
process.env.CURATOR_NO_OPEN = '1';
delete process.env.LLM_MODEL;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
writeFileSync(path.join(USERDATA, '.curator-config.json'), JSON.stringify({
  anthropicApiKey: 'zz-fake-anthropic-key-for-tests',
  activeProvider: 'anthropic',
}) + '\n');

// ── The provider stub: answers like Anthropic's API, chosen per test ───────
let stubMode = 'auth';
const STUB_BODIES = {
  auth: [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }],
  credit: [400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } }],
};
const stub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const [status, body] = STUB_BODIES[stubMode] || STUB_BODIES.auth;
    res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_stub' });
    res.end(JSON.stringify(body));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;
const OFFLINE_URL = await new Promise((r) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(`http://127.0.0.1:${p}`)); });
});

const { default: Anthropic } = await import('@anthropic-ai/sdk');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const llm = await import('../src/brain/llm.js');
let baseURL = STUB;
llm.__setAnthropicClientFactory(() => new Anthropic({ apiKey: 'zz-fake-anthropic-key-for-tests', baseURL, maxRetries: 0 }));

const { default: express } = await import('express');
const { runLiveApiCheck } = await import('../src/brain/diagnostics.js');
const { createDomain } = await import('../src/brain/files.js');
const iq = await import('../src/brain/ingest-queue.js');
const { plainProviderError } = await import('../src/brain/duplicate-job.js');
const { toUserError } = await import('../src/brain/user-errors.js');

const app = express();
app.use(express.json());
app.use('/api/ingest', (await import('../src/routes/ingest.js')).default);
app.use('/api/compile', (await import('../src/routes/compile.js')).default);
app.use('/api/chat', (await import('../src/routes/chat.js')).default);
app.use('/api/health', (await import('../src/routes/health.js')).default);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;

/** Every `data:` frame of an SSE response, parsed. */
async function frames(res) {
  const text = await res.text();
  return text.split('\n').filter((l) => l.startsWith('data:')).map((l) => {
    try { return JSON.parse(l.slice(5).trim()); } catch { return null; }
  }).filter(Boolean);
}
function expectPlainFrame(where, fr, field, code) {
  ok(!!fr, `${where}: an error frame arrived`, fr);
  if (!fr) return;
  const text = fr[field];
  ok(typeof text === 'string' && !RAW_RE.test(text), `${where}: the frame's ${field} is plain words`, text);
  ok(fr.code === code, `${where}: code is ${code}`, fr.code);
  ok(typeof fr.detail === 'string' && /authentication_error|credit balance/.test(fr.detail), `${where}: the raw text travels as detail`, fr.detail);
  ok(typeof fr.detail === 'string' && !fr.detail.includes('zz-fake-anthropic-key'), `${where}: detail carries no key`);
}

await createDomain('alpha', 'Alpha', 'A throwaway domain for the wire suite.', 'generic');
const CONV_ID = '00000001-0000-4000-8000-000000000000';
mkdirSync(path.join(DOMAINS, 'alpha', 'conversations'), { recursive: true });
writeFileSync(path.join(DOMAINS, 'alpha', 'conversations', `${CONV_ID}.json`), JSON.stringify({
  id: CONV_ID, title: 'A talk', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  messages: [
    { role: 'user', content: 'What is the Acme widget made of?' },
    { role: 'assistant', content: 'The Acme widget is made of brass and has three gears.', citations: [] },
  ],
}, null, 2));

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('§1 Verify AI connection (runLiveApiCheck) answers in plain words');
  // ═══════════════════════════════════════════════════════════════════════
  {
    stubMode = 'auth';
    const r = await runLiveApiCheck();
    ok(r.ok === false, 'a rejected key is a failed check');
    ok(r.code === 'ai-key-rejected', 'code ai-key-rejected', r.code);
    ok(/didn't accept the API key/.test(r.error) && /Replace key/.test(r.error) && !RAW_RE.test(r.error), 'error is the plain key sentence naming Replace key', r.error);
    ok(/authentication_error/.test(r.detail || ''), 'the raw text is the detail', r.detail);
    ok(r.provider && r.model, 'provider and model are still reported');

    stubMode = 'credit';
    const c = await runLiveApiCheck();
    ok(c.code === 'ai-no-credit' && /run out of credit/.test(c.error), 'no credit: plain sentence', c);

    baseURL = OFFLINE_URL;
    const o = await runLiveApiCheck();
    ok(o.code === 'ai-unreachable' && /couldn't reach/.test(o.error) && !RAW_RE.test(o.error), 'offline: plain sentence', o);
    baseURL = STUB;
    stubMode = 'auth';
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§2 Ingest (single file) — the SSE error frame');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const fd = new FormData();
    fd.append('domain', 'alpha');
    const longText = '# Acme widget\n\n' + Array.from({ length: 40 }, (_, i) => `The Acme widget, model ${i}, is made of brass and has three gears that turn at different speeds.`).join(' ') + '\n';
    fd.append('file', new Blob([longText], { type: 'text/markdown' }), 'acme.md');
    const res = await fetch(`${BASE}/api/ingest`, { method: 'POST', body: fd });
    ok(/text\/event-stream/.test(res.headers.get('content-type') || ''), 'the ingest streamed', res.status);
    const fr = (await frames(res)).find((f) => f.type === 'error');
    expectPlainFrame('ingest', fr, 'message', 'ai-key-rejected');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§3 Compile — the SSE error frame');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const res = await fetch(`${BASE}/api/compile/conversation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'alpha', conversationId: CONV_ID }),
    });
    const fr = (await frames(res)).find((f) => f.type === 'error');
    expectPlainFrame('compile', fr, 'message', 'ai-key-rejected');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§4 Chat — the SSE error frame and the JSON body');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const res = await fetch(`${BASE}/api/chat/alpha`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What is the Acme widget made of?', stream: true }),
    });
    const fr = (await frames(res)).find((f) => f.type === 'error');
    expectPlainFrame('chat stream', fr, 'message', 'ai-key-rejected');

    const j = await fetch(`${BASE}/api/chat/alpha`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'What is the Acme widget made of?' }),
    });
    const body = await j.json();
    ok(j.status === 401, 'chat JSON: the status is unchanged (the SDK error\'s own 401)', j.status);
    expectPlainFrame('chat JSON', body, 'error', 'ai-key-rejected');

    const nf = await fetch(`${BASE}/api/chat/nope-domain`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    });
    const nb = await nf.json();
    ok(nf.status === 404 && Object.keys(nb).join() === 'error' && !('code' in nb), 'chat: a deliberate refusal keeps its exact shape (error only)', nb);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§5 Health AI scan — batch-error frames are plain on the wire');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const ent = path.join(DOMAINS, 'alpha', 'wiki', 'entities');
    mkdirSync(ent, { recursive: true });
    for (const [slug, title] of [['acme-widget', 'Acme Widget'], ['acme-widgets', 'Acme Widgets'], ['the-acme-widget', 'The Acme Widget']]) {
      writeFileSync(path.join(ent, `${slug}.md`), `---\ntype: entity\n---\n# ${title}\n\nA brass widget with three gears.\n`);
    }
    const res = await fetch(`${BASE}/api/health/alpha/semantic-dupes/scan`, { method: 'POST' });
    const all = await frames(res);
    const be = all.find((f) => f.type === 'batch-error');
    const er = all.find((f) => f.type === 'error');
    ok(!!(be || er), 'the scan reported the provider failure', all.map((f) => f.type));
    if (be) expectPlainFrame('health batch-error', be, 'error', 'ai-key-rejected');
    if (er) expectPlainFrame('health error', er, 'error', 'ai-key-rejected');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§6 Ingest queue — plain on the wire, raw on disk');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const up = (name) => {
      const p = path.join(USERDATA, `upload-${name}`);
      writeFileSync(p, `# ${name}\n\nSome text about ${name}.\n`);
      return { originalname: name, path: p, size: readFileSync(p).length };
    };
    // A real SDK error, made by the real client against the stub.
    const authErr = await new Anthropic({ apiKey: 'zz-fake', baseURL: STUB, maxRetries: 0 })
      .messages.create({ model: 'x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null, (e) => e);
    ok(authErr && authErr.constructor.name === 'AuthenticationError', 'fixture: the SDK threw its AuthenticationError');
    const deliberate = 'This PDF has no text layer, so nothing could be read from it.';
    const gone = Object.assign(new Error('Anthropic no longer offers `zz-model` — pick another model in Settings.'), { curatorModelGone: true });
    const plan = { 'a.md': authErr, 'b.md': new Error(deliberate), 'c.md': gone };
    const fake = async (dom, filePath, name) => { const o = plan[name]; if (o instanceof Error) throw o; return { title: name, pagesWritten: [], changes: [], warnings: [] }; };
    const job = await iq.createJob({ domain: 'alpha', uploadedFiles: [up('a.md'), up('b.md'), up('c.md')] });
    await iq.startOrResumeJob(job.jobId, { ingestFile: fake });
    let final = null;
    for (let i = 0; i < 400 && !final; i++) {
      const j = await iq.getJob(job.jobId);
      if (j && ['done', 'failed', 'paused', 'cancelled'].includes(j.status)) final = j; else await new Promise((r) => setTimeout(r, 15));
    }
    ok(!!final, 'the job settled', final && final.status);
    const manifestFile = iq.__testing.manifestPath(job.jobId);
    const before = readFileSync(manifestFile);
    const disk = JSON.parse(before.toString('utf8'));
    const wire = iq.toWire(final);
    const after = readFileSync(manifestFile);
    ok(sha(before) === sha(after), 'toWire leaves the manifest on disk byte-identical');
    const dA = disk.items.find((i) => i.name === 'a.md');
    const wA = wire.items.find((i) => i.name === 'a.md');
    ok(dA && /^401 \{"type":"error"/.test(dA.error), 'DISK: the item keeps the raw provider text', dA && dA.error);
    ok(wA && /didn't accept the API key/.test(wA.error) && !RAW_RE.test(wA.error), 'WIRE: the item error is the plain sentence', wA && wA.error);
    ok(wA && /authentication_error/.test(wA.errorDetail || ''), 'WIRE: errorDetail carries the raw text', wA && wA.errorDetail);
    ok(wA && wA.errorCode === 'ai-key-rejected', 'WIRE: errorCode is the catalogue code', wA && wA.errorCode);
    ok(final.items.find((i) => i.name === 'a.md').error === dA.error, 'the in-memory job object was not mutated by toWire');
    const wB = wire.items.find((i) => i.name === 'b.md');
    ok(wB && wB.error === deliberate && wB.errorDetail === null, 'a deliberate sentence passes the wire unchanged, with no detail', wB);
    const dC = disk.items.find((i) => i.name === 'c.md');
    const wC = wire.items.find((i) => i.name === 'c.md');
    ok(dC && dC.errorCode === 'MODEL_GONE' && wC && wC.errorCode === 'MODEL_GONE' && wC.error === dC.error, 'an existing code (MODEL_GONE) and its sentence are never replaced', wC);

    // The transient path: a 429 still PAUSES (classifyTransientError reads the
    // raw error) and resume still completes the item.
    const rl = new Error('⚠ Rate limit hit on Anthropic (HTTP 429). Please wait and try again.');
    rl.curatorTransient = 'rate_limit';
    let throwOnce = true;
    const fake2 = async (dom, filePath, name) => { if (throwOnce) { throwOnce = false; throw rl; } return { title: name, pagesWritten: [], changes: [], warnings: [] }; };
    const job2 = await iq.createJob({ domain: 'alpha', uploadedFiles: [up('d.md')] });
    await iq.startOrResumeJob(job2.jobId, { ingestFile: fake2 });
    let p2 = null;
    for (let i = 0; i < 400 && !p2; i++) { const j = await iq.getJob(job2.jobId); if (j && j.status !== 'running' && j.status !== 'queued' && j.status !== 'pending') p2 = j; else await new Promise((r) => setTimeout(r, 15)); }
    ok(p2 && p2.status === 'paused' && p2.pausedReason === 'rate_limit', 'a 429 still pauses the batch as rate_limit', p2 && [p2.status, p2.pausedReason]);
    ok(p2 && p2.pausedMessage.includes('HTTP 429'), 'DISK: pausedMessage keeps the raw tail', p2 && p2.pausedMessage);
    ok(iq.classifyTransientError(new Error(p2.pausedMessage)) === 'rate_limit', 'classifyTransientError still classifies the persisted text');
    await iq.startOrResumeJob(job2.jobId, { ingestFile: fake2 });
    let d2 = null;
    for (let i = 0; i < 400 && !d2; i++) { const j = await iq.getJob(job2.jobId); if (j && j.status === 'done') d2 = j; else await new Promise((r) => setTimeout(r, 15)); }
    ok(d2 && d2.items[0].status === 'done', 'resume runs the paused item to done');

    // failReason / pausedMessage: a raw shape on the job is translated on the wire only.
    const synthetic = { ...final, status: 'failed', failReason: authErr.message, pausedMessage: null };
    const w3 = iq.toWire(synthetic);
    ok(/didn't accept the API key/.test(w3.failReason) && synthetic.failReason === authErr.message, 'failReason: plain on the wire, raw on the object');
    // An item with its OWN code whose text the catalogue also recognises: the
    // text is translated, the code is never replaced.
    const coded = { ...final, items: [{ ...final.items[0], error: authErr.message, errorCode: 'SOME_OWN_CODE' }] };
    const w4 = iq.toWire(coded).items[0];
    ok(w4.errorCode === 'SOME_OWN_CODE' && /didn't accept the API key/.test(w4.error), 'an existing errorCode is never replaced by the catalogue code', w4);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§7 Compare all — plainProviderError tries the catalogue first');
  // ═══════════════════════════════════════════════════════════════════════
  {
    ok(/didn't accept the API key/.test(plainProviderError('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}')), 'a raw 401 body becomes the key sentence');
    ok(plainProviderError('got status: 503. {"error":{"message":"Overloaded","code":503}}') === 'Overloaded', 'an unrecognised JSON body still gives up its inner sentence');
    ok(plainProviderError('a plain message') === 'a plain message', 'plain text is left as it is');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§8 Deliberate sentences match nothing at these exits');
  // ═══════════════════════════════════════════════════════════════════════
  {
    for (const s of [
      'Paused by user request.',
      'The app restarted while this batch was running. The interrupted item will be re-run from the start on resume (ingest is safe to re-run). Review progress below, then click Resume to continue.',
      '⚠ Rate limit hit on Anthropic (HTTP 429). Please wait and try again.',
      'Conversation too short to compile (need at least 1 user messages, got 0)',
    ]) ok(toUserError(s) === null, `passes unchanged: "${s.slice(0, 50)}…"`);
  }
} finally {
  llm.__setAnthropicClientFactory(null);
  await new Promise((r) => server.close(r));
  await new Promise((r) => stub.close(r));
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
