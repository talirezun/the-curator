#!/usr/bin/env node
/**
 * test-ingest-queue-nocall.js — OFFLINE. A batch item that made no AI call.
 *
 * The defect (2026-11-07): in a batch, a source whose exact bytes this model had
 * already read finished as plain "done", and the batch estimate still priced it
 * (about $0.02 a file) although the ingest returns before any call. Every way a
 * batch file can finish without a call:
 *
 *   1. its name is already in raw/ and overwrite is off  -> skipped at creation
 *   2. a second file in the batch with the same name       -> skipped at creation
 *   3. the same bytes, read before by the same model       -> runs, returns with calls: 0
 *   4. a failure before the first call (model gone, unreadable file, too little text)
 *      -> FAILED. It spent nothing, but it is a failure and must still read as one.
 *
 * §1 the queue, end to end, with the REAL ingestFile and a fake model: the no-call item
 *    is recorded as such from its measured call count, a calling item and a failed item
 *    are not, and the job's estimate does not price the no-call item.
 * §2 the estimate the user confirms: $0 and no calls for cases 1 and 3, the batch total
 *    leaves them out, and controls show the same file is priced when it will call.
 * §3 the route passes the two new inputs (sha256, overwrite) through.
 * §4 the view's row, done summary and confirm list, executed from the real source.
 *
 * No key, no network, no spend: the model is `opts.llm`, every directory is a tempdir.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
const section = (t) => console.log(`\n${t}`);

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-nocall-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');
process.env.CURATOR_NO_OPEN = '1';
for (const k of ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];
// A PRICED model, so a priced estimate is non-zero and a zero means something. The key
// is a placeholder: every call goes through the fake `opts.llm`, never a provider.
const MODEL = 'gemini-3.5-flash-lite';
process.env.LLM_MODEL = MODEL;
writeFileSync(path.join(USER_DATA, '.curator-config.json'), JSON.stringify({
  geminiApiKey: 'offline-test-placeholder-no-request-is-ever-made', activeProvider: 'gemini',
}), { mode: 0o600 });

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);
const { createDomain, rawPath } = await import('../src/brain/files.js');
const { ingestFile } = await import('../src/brain/ingest.js');
const Q = await import('../src/brain/ingest-queue.js');
const { createJob, startOrResumeJob, getJob, toWire, estimateIngestQueueCost, __testing } = Q;

const SHA = (s) => createHash('sha256').update(s).digest('hex');
const SEEN = 'A short note about agents talking to each other through a protocol. '.repeat(10);
const FRESH = 'A different note, about orchards and the bees that visit them in spring. '.repeat(10);
const SUMMARY = (t) => `# ${t}\n\nSource: ${t}.md\n\n## Key Takeaways\n- One point about ${t}\n`;

const quiet = async (fn) => {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};
/** A fake model that reports usage the way llm.js does, and counts its calls. */
function fakeModel() {
  const fn = async (schema, prompt, maxTokens, format, onWait, opts) => {
    fn.calls++;
    if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 1000, outputTokens: 200, provider: 'gemini', model: MODEL });
    return JSON.stringify({ title: 'T', pages: [{ path: `summaries/s${fn.calls}-${Date.now()}.md`, content: SUMMARY('t') }] });
  };
  fn.calls = 0;
  return fn;
}
let seq = 0;
function upload(name, text) {
  const dir = path.join(TMP_ROOT, 'uploads', String(++seq));
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `u-${seq}`);
  writeFileSync(p, text, 'utf8');
  return { originalname: name, path: p, size: Buffer.byteLength(text) };
}
async function waitTerminal(jobId) {
  const t0 = Date.now();
  for (;;) {
    const j = await getJob(jobId);
    if (j && ['done', 'failed', 'cancelled', 'paused'].includes(j.status)) return j;
    if (Date.now() - t0 > 15000) throw new Error('job did not settle');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function seededDomain(slug) {
  await createDomain(slug, 'No-call test', 'Throwaway domain for the no-call suite.', 'generic');
  const src = path.join(TMP_ROOT, `${slug}-seen.md`);
  writeFileSync(src, SEEN, 'utf8');
  // The first reading, by the real pipeline, so the manifest record is the real one.
  await quiet(() => ingestFile(slug, src, 'seen.md', false, null, { llm: fakeModel(), buildModel: MODEL }));
  return slug;
}

try {
  // ── §1 ───────────────────────────────────────────────────────────────────
  section('§1 The queue, end to end: no call is recorded from the measured call count');
  {
    const dom = await seededDomain('qone');
    ok(existsSync(path.join(rawPath(dom), 'seen.md')), 'setup: the first reading put seen.md in raw/');
    const model = fakeModel();
    const ingestImpl = async (d, filePath, name, overwrite, onProgress, opts) => {
      if (name === 'broken.md') throw new Error('This file could not be read (a test failure before any call).');
      return ingestFile(d, filePath, name, overwrite, onProgress, { ...opts, llm: model, buildModel: MODEL });
    };
    // The same bytes under a NEW name (not caught by the name check), a fresh file, a
    // file that fails before any call. Overwrite off.
    const job = await quiet(() => createJob({ domain: dom, uploadedFiles: [
      upload('copy-of-seen.md', SEEN), upload('fresh.md', FRESH), upload('broken.md', FRESH + 'x'),
    ] }));
    const priced = await estimateIngestQueueCost(dom, [{ name: 'fresh.md', size: Buffer.byteLength(FRESH) }, { name: 'broken.md', size: Buffer.byteLength(FRESH + 'x') }]);
    eq(job.estimate.calls, priced.estimate.calls, '★ the job\'s estimate plans the calls of the two files that will call, not the copy');
    eq(job.estimate.usdHigh, priced.estimate.usdHigh, '★ …and its dollar figure leaves the copy out');
    ok(job.estimate.usdHigh > 0, 'CONTROL: the files that will call are priced above zero', String(job.estimate.usdHigh));

    await quiet(async () => { await startOrResumeJob(job.jobId, { ingestFile: ingestImpl }); await waitTerminal(job.jobId); });
    const done = toWire(await getJob(job.jobId));
    const byName = Object.fromEntries(done.items.map((i) => [i.name, i]));
    const copy = byName['copy-of-seen.md'], fresh = byName['fresh.md'], broken = byName['broken.md'];
    eq(copy.status, 'done', 'the copy finished');
    eq(copy.tokenUsage && copy.tokenUsage.calls, 0, '…with a measured call count of zero');
    eq(copy.noCall, true, '★ …and the wire says it made no AI call');
    eq(fresh.status, 'done', 'CONTROL: the fresh file finished');
    ok(fresh.tokenUsage && fresh.tokenUsage.calls > 0, 'CONTROL: …after real calls', JSON.stringify(fresh.tokenUsage));
    eq(fresh.noCall, false, '★ CONTROL: a file that called is not labelled no-call');
    eq(broken.status, 'failed', 'the broken file failed');
    eq(broken.noCall, false, '★ a failed file with zero calls is still a failure, never "no call needed"');
    eq(model.calls, fresh.tokenUsage.calls, 'the model was called only for the fresh file');
  }

  // ── §2 ───────────────────────────────────────────────────────────────────
  section('§2 The estimate the user confirms: a file that will not call costs $0');
  {
    const dom = await seededDomain('qtwo');
    const size = Buffer.byteLength(SEEN), fsize = Buffer.byteLength(FRESH);
    const fresh = { name: 'fresh.md', size: fsize, sha256: SHA(FRESH) };
    const alone = await estimateIngestQueueCost(dom, [fresh]);
    ok(alone.estimate.usdHigh > 0 && alone.estimate.calls > 0, 'CONTROL: a fresh file alone is priced', JSON.stringify(alone.estimate.usdHigh));

    // Case 3: the same bytes under another name, hashed by the client.
    const withCopy = await estimateIngestQueueCost(dom, [fresh, { name: 'copy.md', size, sha256: SHA(SEEN) }]);
    eq(withCopy.estimate.usdHigh, alone.estimate.usdHigh, '★ the same bytes this model already read add $0 to the batch total');
    eq(withCopy.estimate.calls, alone.estimate.calls, '★ …and no planned calls');
    const nc = (withCopy.files.noCall || []).find((e) => e.name === 'copy.md');
    eq(nc && nc.reason, 'unchanged', '★ …and the estimate names it as a no-call file, with its reason');
    ok(!(withCopy.files.noCall || []).some((e) => e.name === 'fresh.md'), 'CONTROL: the fresh file is not in the no-call list');
    const noHash = await estimateIngestQueueCost(dom, [fresh, { name: 'copy.md', size }]);
    ok(noHash.estimate.usdHigh > alone.estimate.usdHigh, 'CONTROL: without a hash nothing is known, so the copy is priced (the safe direction)');
    const otherBytes = await estimateIngestQueueCost(dom, [fresh, { name: 'copy.md', size, sha256: SHA(SEEN + 'changed') }]);
    ok(otherBytes.estimate.usdHigh > alone.estimate.usdHigh, 'CONTROL: changed bytes are priced');
    const junk = await estimateIngestQueueCost(dom, [fresh, { name: 'copy.md', size, sha256: 'not-a-hash' }]);
    ok(junk.estimate.usdHigh > alone.estimate.usdHigh, 'CONTROL: a malformed hash is ignored, never trusted');

    // Case 1: the name is already in raw/ and overwrite is off -> skipped at creation.
    const byName = await estimateIngestQueueCost(dom, [fresh, { name: 'seen.md', size: size + 7 }], { overwrite: false });
    eq(byName.estimate.usdHigh, alone.estimate.usdHigh, '★ a file that will be skipped as already ingested adds $0');
    eq(((byName.files.noCall || []).find((e) => e.name === 'seen.md') || {}).reason, 'already-ingested', '…named with its reason');
    const overwriting = await estimateIngestQueueCost(dom, [fresh, { name: 'seen.md', size: size + 7 }], { overwrite: true });
    ok(overwriting.estimate.usdHigh > alone.estimate.usdHigh, 'CONTROL: with overwrite on, the same name is priced');
    const unsaid = await estimateIngestQueueCost(dom, [fresh, { name: 'seen.md', size: size + 7 }]);
    ok(unsaid.estimate.usdHigh > alone.estimate.usdHigh, 'CONTROL: a caller that does not say overwrite (the single-file run line) is priced');

    // Case 2: two files with one name -> the second is skipped at creation.
    const twice = await estimateIngestQueueCost(dom, [fresh, { name: 'FRESH.md', size: fsize - 1 }], { overwrite: false });
    eq(twice.estimate.usdHigh, alone.estimate.usdHigh, '★ the second file with the same name adds $0');
    eq(((twice.files.noCall || []).find((e) => e.name === 'FRESH.md') || {}).reason, 'same-name-in-batch', '…named with its reason');

    // createJob agrees with the estimate, from bytes it hashed itself.
    const job = await quiet(() => createJob({ domain: dom, uploadedFiles: [upload('fresh.md', FRESH), upload('copy.md', SEEN)] }));
    eq(job.estimate.usdHigh, alone.estimate.usdHigh, '★ createJob, hashing the staged bytes itself, prices the copy at $0 too');
    ok(job.items.find((i) => i.name === 'copy.md').status === 'pending', '…and still runs it (the ingest decides again, from the bytes)');
    await __testing.__resetInMemoryState?.();
  }

  // ── §3 ───────────────────────────────────────────────────────────────────
  section('§3 The estimate route passes sha256 and overwrite through');
  {
    const dom = await seededDomain('qthree');
    const router = (await import('../src/routes/ingest-queue.js')).default;
    const layer = router.stack.find((l) => l.route && l.route.path === '/estimate' && l.route.methods.post);
    const call = async (body) => {
      const sent = [];
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { sent.push(b); return this; } };
      await layer.route.stack[0].handle({ body }, res);
      return sent[0];
    };
    const size = Buffer.byteLength(SEEN);
    const hashed = await call({ domain: dom, files: [{ name: 'copy.md', size, sha256: SHA(SEEN) }] });
    eq(hashed.estimate.calls, 0, '★ through the route, a hashed copy plans no call');
    const named = await call({ domain: dom, files: [{ name: 'seen.md', size }], overwrite: false });
    eq(named.estimate.calls, 0, '★ through the route, overwrite:false skips a name already in raw/');
    const plain = await call({ domain: dom, files: [{ name: 'seen.md', size }] });
    ok(plain.estimate.calls > 0, 'CONTROL: the same body without overwrite is priced');
  }

  // ── §4 ───────────────────────────────────────────────────────────────────
  section('§4 The view says it plainly, from the real source');
  {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const js = readFileSync(path.join(here, '../src/public/next/views/ingest.js'), 'utf8');
    const logic = await import('../src/public/next/shared/ingest-queue-logic.js');
    const { formatUsdHonest } = await import('../src/public/next/shared/format-usd.js');
    const extract = (name) => {
      const m = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(js);
      if (!m) return null;
      let i = js.indexOf('{', js.indexOf(')', m.index)), depth = 0, q = null;
      for (let k = i; k < js.length; k++) {
        const c = js[k];
        if (q) { if (c === '\\') { k++; continue; } if (c === q) q = null; continue; }
        if (c === "'" || c === '"' || c === '`') { q = c; continue; }
        if (c === '/' && js[k + 1] === '/') { k = js.indexOf('\n', k); continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return js.slice(m.index, k + 1); }
      }
      return null;
    };
    const names = ['queueItemPageCounts', 'queueRanOnLine', 'queueSpendReading', 'queueSpendHtml', 'queueBudgetFacts',
      'renderQueueDoneSummary', 'renderNewPagesLine', 'renderQueueItemRow', 'renderQueueFileListItem'];
    const bodies = names.map(extract);
    ok(bodies.every(Boolean), 'setup: the renderers were extracted', names.filter((n, i) => !bodies[i]).join(', '));
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const v = new Function('escapeHtml', 'formatUsdHonest', 'computeQueueStatusCounts', 'formatHealthCounts', 'statusPillMeta',
      'sanitizeDisplayName', 'formatQueueBytes', `
      const icon = () => '<svg></svg>';
      const renderStatus = () => '';
      const progressRingHtml = () => '';
      const INGEST_STAGES = [];
      ${bodies.join('\n')}
      return { renderQueueDoneSummary, renderQueueItemRow, renderQueueFileListItem };
    `)(esc, formatUsdHonest, logic.computeQueueStatusCounts, logic.formatHealthCounts, logic.statusPillMeta,
      logic.sanitizeDisplayName, logic.formatQueueBytes);
    const text = (h) => String(h).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

    const noCall = { status: 'done', idx: 0, name: 'copy.md', noCall: true, tokenUsage: { calls: 0 },
      result: { title: 'copy.md', pagesWritten: 0, warningCount: 1, changeCounts: { created: 0, updated: 0, unchanged: 0 } } };
    const called = { status: 'done', idx: 1, name: 'fresh.md', noCall: false, tokenUsage: { calls: 2 },
      result: { title: 'Fresh', pagesWritten: 3, warningCount: 0, changeCounts: { created: 2, updated: 1, unchanged: 0 } } };
    const broke = { status: 'failed', idx: 2, name: 'broken.md', noCall: false, tokenUsage: null, error: 'This file could not be read.' };
    const rowNo = text(v.renderQueueItemRow(noCall, { jobTerminal: true }));
    ok(/No AI call was needed, so nothing was spent/.test(rowNo), '★ the no-call row says it made no call and spent nothing', rowNo);
    const rowCalled = text(v.renderQueueItemRow(called, { jobTerminal: true }));
    ok(!/No AI call/.test(rowCalled) && /2 new · 1 updated/.test(rowCalled), 'CONTROL: a row that called is unchanged', rowCalled);
    const rowBroke = text(v.renderQueueItemRow(broke, { jobTerminal: true }));
    ok(!/No AI call/.test(rowBroke) && /could not be read/.test(rowBroke), 'CONTROL: a failed row shows its failure, not "no call"', rowBroke);
    const rowOld = text(v.renderQueueItemRow({ ...noCall, noCall: undefined }, { jobTerminal: true }));
    ok(!/No AI call/.test(rowOld), 'CONTROL: a manifest from before the field claims nothing');

    const sum = text(v.renderQueueDoneSummary({ status: 'done', spentUsd: 0.001, items: [noCall, called, broke] }));
    ok(/1 needed no AI call/.test(sum), '★ the done summary counts the files that needed no call', sum);
    ok(!/needed no AI call/.test(text(v.renderQueueDoneSummary({ status: 'done', spentUsd: 0.001, items: [called, broke] }))),
      'CONTROL: a batch where every file called says nothing about it');

    const li = text(v.renderQueueFileListItem({ name: 'copy.md', bytes: 700 }, { removable: true, noCall: 'unchanged' }));
    ok(/no AI call/i.test(li) && /\$0/.test(li), '★ the confirm list marks the file that will not call, at $0', li);
    const liSkip = text(v.renderQueueFileListItem({ name: 'seen.md', bytes: 700 }, { removable: true, noCall: 'already-ingested' }));
    ok(/already ingested/i.test(liSkip) && /\$0/.test(liSkip), '★ …and the file that will be skipped as already ingested', liSkip);
    const liPlain = text(v.renderQueueFileListItem({ name: 'fresh.md', bytes: 700 }, { removable: true }));
    ok(!/no AI call|\$0/i.test(liPlain), 'CONTROL: an ordinary file is listed as before', liPlain);

    // The estimate request carries what the server needs, from the real source.
    const sel = extract('startQueueSelection') || (js.match(/async function startQueueSelection[\s\S]*?\n}\n/) || [''])[0];
    ok(/sha256:\s*hashes\[i\]/.test(sel) && /overwrite:\s*!!state\.queueOverwriteInput/.test(sel),'the batch estimate request sends each file\'s sha256 and the overwrite choice (source guard)');
  }
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
