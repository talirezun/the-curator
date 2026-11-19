#!/usr/bin/env node
/**
 * test-next-domains-errors.js — v3.99.2 plain-language errors on the Domains view and Wiki health.
 *
 * Offline. The REAL functions are lifted out of views/domains.js and run with the REAL
 * shared/net.js (test-helpers/net-globals.js) and the real shared/text.js renderStatus;
 * the review desk and Compare all are the real modules, driven with stand-ins for domains.js.
 *
 * What it holds:
 *   1. fetchJSON and streamSSE throw the plain sentence, keep the technical text as
 *      err.detail, and keep status/body (the 409 refusal readers depend on them).
 *      Deliberate server prose (a 409, " no longer exists") passes through unchanged.
 *      No "Request failed (N)" reaches the sentence.
 *   2. A Health SSE `error` frame keeps its `detail`; a frame with no message gets the
 *      view's own sentence, never "Plan failed".
 *   3. A failed outcome line on Wiki health shows the detail line; a success never does.
 *   4. The knowledge-folder notice shows the detail inside its status box.
 *   5. The review desk and Compare all carry the detail to the screen.
 *
 * The exact detail-line format belongs to net.js (renderErrorDetail); this suite only
 * asserts that line is what the screen shows, never its spelling.
 */
import './test-helpers/net-globals.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, functionSource } from './test-helpers/source-scan.js';
import { renderErrorDetail, userMessageFrom } from '../src/public/next/shared/net.js';
import { renderStatus } from '../src/public/next/shared/text.js';
import { deskFixture, pair } from './test-helpers/review-desk-fixture.js';
import { createCompareAll } from '../src/public/next/views/health-compare.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = stripComments(readFileSync(join(ROOT, 'src/public/next/views/domains.js'), 'utf8'));

let passed = 0;
let failed = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) passed++;
  else { failed++; fails.push(msg); console.log('  FAIL ' + msg); }
}
function section(t) { console.log('\n' + t); }

function lift(name) {
  const src = functionSource(SRC, name);
  if (!src) throw new Error('could not find ' + name + ' in views/domains.js');
  return src;
}
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n) => '<svg data-icon="' + n + '"></svg>';

// A raw Node fs error, the way an unwrapped route would echo it.
const RAW = "EACCES: permission denied, open '/Users/someone/Documents/wiki/index.md'";

function fakeResponse(status, body, { sse } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: sse ? sse : null,
    json: async () => { if (body === undefined) throw new SyntaxError('Unexpected end of JSON input'); return body; },
  };
}
function sseBody(frames) {
  const text = frames.map((f) => 'event: ' + f.type + '\ndata: ' + JSON.stringify(f) + '\n\n').join('');
  let done = false;
  return {
    getReader: () => ({
      read: async () => { if (done) return { done: true }; done = true; return { done: false, value: new TextEncoder().encode(text) }; },
      cancel: async () => {},
    }),
  };
}

// ── 1. fetchJSON / streamSSE ───────────────────────────────────────────────
section('1. fetchJSON and streamSSE throw the plain sentence and keep the detail');
{
  let next = null;
  globalThis.fetch = async () => next;
  const fetchJSON = new Function('return (' + lift('fetchJSON') + ')')();
  const streamSSE = new Function('return (' + lift('streamSSE') + ')')();
  const catchOf = async (p) => { try { await p; return null; } catch (e) { return e; } };

  next = fakeResponse(500, { error: RAW });
  let e = await catchOf(fetchJSON('/api/x'));
  ok(e && !/EACCES|\/Users\//.test(e.message), '1.1 a raw fs error is not the sentence: ' + (e && e.message));
  ok(e && /EACCES/.test(e.detail || '') && !/\/Users\/someone/.test(e.detail), '1.2 it is the detail, with the home folder cleaned');
  ok(e && e.status === 500 && e.body && e.body.error === RAW, '1.3 status and body are kept for the readers that branch on them');

  next = fakeResponse(502, undefined);
  e = await catchOf(fetchJSON('/api/x'));
  ok(e && !/Request failed|\(\d{3}\)|HTTP/.test(e.message), '1.4 an empty 502 never puts a status code in the sentence: ' + (e && e.message));
  ok(e && /502/.test(e.detail || ''), '1.5 the status is in the detail');

  const PROSE = 'Another process is already writing to "alpha". Wait for it to finish, then try again.';
  next = fakeResponse(409, { error: PROSE, conflict: 'write' });
  e = await catchOf(fetchJSON('/api/x'));
  ok(e && e.message === PROSE && e.status === 409 && e.body.conflict === 'write', '1.6 a deliberate 409 refusal passes through unchanged');

  const GONE = 'concepts/data-privacy no longer exists. Run a new scan.';
  next = fakeResponse(404, { error: GONE });
  e = await catchOf(fetchJSON('/api/x'));
  ok(e && e.message === GONE, '1.7 the " no longer exists" refusal keeps its words (semanticStaleFromError reads them)');

  next = fakeResponse(409, { error: PROSE, conflict: 'write' });
  e = await catchOf(streamSSE('/api/x', {}, () => {}));
  ok(e && e.message === PROSE && e.status === 409 && e.body && e.body.conflict === 'write', '1.8 streamSSE: a pre-stream 409 keeps its shape and words');
  next = fakeResponse(500, { error: RAW });
  e = await catchOf(streamSSE('/api/x', {}, () => {}));
  ok(e && !/EACCES/.test(e.message) && /EACCES/.test(e.detail || ''), '1.9 streamSSE: a pre-stream raw error is plain with its detail');
  next = fakeResponse(503, undefined);
  e = await catchOf(streamSSE('/api/x', {}, () => {}));
  ok(e && !/Request failed|\(\d{3}\)/.test(e.message), '1.10 streamSSE: an empty failure never says "Request failed (N)"');

  // ── 2. An SSE error frame, the way the Health readers throw it ──────────
  section('2. A Health error frame keeps its detail; an empty one gets the view\'s sentence');
  const plan = lift('runBrokenLinksPlan');
  const thrower = /if \(type === 'error'\) throw ([^;]+);/.exec(plan);
  ok(!!thrower, '2.0 the broken-links plan reader throws on an error frame');
  if (thrower) {
    const throwFor = new Function('ev', 'throw ' + thrower[1] + ';');
    const sent = { type: 'error', error: 'Gemini is having problems on its side right now. Wait a few minutes, then try again.', detail: '503 Service Unavailable', code: 'ai-overloaded' };
    let f = null; try { throwFor(sent); } catch (x) { f = x; }
    ok(f && f.message === sent.error && f.detail === sent.detail && f.code === 'ai-overloaded', '2.1 the frame\'s sentence, detail and code reach the catch');
    const fsFrame = { type: 'error', error: 'This computer didn\'t let The Curator use a file it needs (index.md).', detail: RAW, code: 'EACCES' };
    f = null; try { throwFor(fsFrame); } catch (x) { f = x; }
    ok(f && f.code === 'EACCES' && f.message === fsFrame.error, '2.2 an fs error\'s own code is kept as it came, never replaced');
    f = null; try { throwFor({ type: 'error' }); } catch (x) { f = x; }
    ok(f && f.message && !/^Plan failed$/.test(f.message), '2.3 a frame with no message gets a sentence, not "Plan failed": ' + (f && f.message));
  }
  // Each of the five readers, run on a frame that carries a detail.
  const readers = ['runBrokenLinksPlan', 'runOrphansPlan', 'applyPendingPlan', 'runSemanticScan', 'runMergeSemanticDuplicates'];
  for (const r of readers) {
    const m = /if \(type === 'error'\) throw ([^;]+);/.exec(lift(r));
    let f = null;
    try { if (m) new Function('ev', 'throw ' + m[1] + ';')({ type: 'error', error: 'A plain sentence.', detail: 'raw text', code: 'x' }); } catch (x) { f = x; }
    ok(f && f.message === 'A plain sentence.' && f.detail === 'raw text', '2.4 ' + r + ' keeps the frame\'s detail when it throws');
  }
}

// ── 3. The outcome line ─────────────────────────────────────────────────────
section('3. Wiki health: a failed outcome shows its detail, a success never does');
{
  const renderOutcomeLine = new Function('escapeHtml', 'icon', 'return (' + lift('renderOutcomeLine') + ')')(escapeHtml, icon);
  const detail = RAW;
  const failedLine = renderOutcomeLine({ key: 'quick', tone: 'error', text: 'Could not repair: something.', detail, retry: () => {} });
  ok(failedLine.includes(renderErrorDetail(detail)), '3.1 the detail line, as net.js renders it, is on the failed row');
  ok(failedLine.indexOf('Could not repair') < failedLine.indexOf(renderErrorDetail(detail)), '3.2 under the sentence');
  ok(/dm-outcome-retry/.test(failedLine), '3.3 Try again is still there');
  const done = renderOutcomeLine({ key: 'quick', tone: 'success', text: 'Repaired 3', detail });
  ok(!done.includes('tx-error-detail'), '3.4 a success never carries a detail line');
  const bare = renderOutcomeLine({ key: 'quick', tone: 'error', text: 'Could not save: x.' });
  ok(!bare.includes('tx-error-detail'), '3.5 no detail, no line');
  const hostile = renderOutcomeLine({ key: 'q', tone: 'error', text: 'x', detail: '<img src=x onerror=alert(1)>' });
  ok(!hostile.includes('<img src=x') && hostile.includes('&lt;img'), '3.6 the detail is escaped');
}

// ── 4. The knowledge-folder notice ───────────────────────────────────────────
section('4. The knowledge-folder notice shows the detail inside its status box');
{
  const classifyPickResponse = new Function('return (' + lift('classifyPickResponse') + ')')();
  const v = classifyPickResponse(500, { error: RAW });
  ok(v.kind === 'error' && !/EACCES/.test(v.detail) && /EACCES/.test(v.support || ''), '4.1 a raw picker failure: plain sentence, raw text as support');
  const empty = classifyPickResponse(500, null);
  ok(empty.kind === 'error' && !/Request failed|\(\d{3}\)/.test(empty.detail) && /500/.test(empty.support), '4.2 an empty failure says why it cannot say, the status in support');
  const PROSE = 'A write is in progress on "alpha". Wait for it to finish, then try again.';
  const refused = classifyPickResponse(409, { error: PROSE });
  ok(refused.kind === 'refused' && refused.detail === PROSE && !refused.support, '4.3 a 409 keeps the server\'s own sentence and has no support line');

  const state = { kbNotice: { state: 'danger', title: 'The folder picker did not finish', detail: v.detail, support: v.support, undoPath: null }, kbBusy: false };
  const renderKnowledgeNotice = new Function('state', 'renderStatus', 'escapeHtml', 'renderTypedKnowledgePath', 'return (' + lift('renderKnowledgeNotice') + ')')(state, renderStatus, escapeHtml, () => '');
  const html = renderKnowledgeNotice();
  ok(html.includes('tx-status-danger') && html.includes('tx-error-detail') && html.includes('EACCES'), '4.4 the notice renders the detail line in the box');
  ok(html.indexOf('tx-status-detail') < html.indexOf('tx-error-detail'), '4.5 below the sentence');
  state.kbNotice = { state: 'danger', title: 'T', detail: 'D', undoPath: null };
  ok(!renderKnowledgeNotice().includes('tx-error-detail'), '4.6 no support, no line');
}

// ── 5. The review desk and Compare all ───────────────────────────────────────
section('5. The review desk and Compare all carry the detail to the screen');
{
  const THREE = () => [pair('data-privacy', 'data-protection'), pair('ml', 'machine-learning'), pair('llm', 'large-language-model')];
  const bad = deskFixture(THREE());
  const ENOENT = "ENOENT: no such file or directory, open 'index.md'";
  bad.nextCompare = { error: 'The Curator couldn\'t find index.md.', detail: ENOENT };
  bad.desk.open();
  await bad.paint();
  const h = bad.html();
  ok(h.includes('Could not load the comparison: The Curator couldn') && h.includes(renderErrorDetail(ENOENT)),
     '5.1 a failed comparison shows the sentence and the detail line');
  ok(/id="hr-retry"/.test(h), '5.2 with Try again');
  ok(h.indexOf('id="hr-retry"') < h.indexOf('tx-error-detail'), '5.3 the detail sits under the line, after its button');

  // A merge that failed with a detail (domains.js records it as errorDetail on the pair).
  const fx = deskFixture(THREE(), { deps: {
    merge: async (slug, p, cb) => {
      const list = fx.scan.pairs; const i = list.findIndex((x) => fx.key(x) === fx.key(p));
      list[i] = { ...list[i], error: 'Could not merge: The disk is full.', errorDetail: 'ENOSPC: no space left on device, write', errorAction: 'merge' };
      cb({ error: 'Could not merge: The disk is full.' });
    },
  } });
  fx.desk.open();
  await fx.paint();
  fx.seen();
  await fx.press('hr-merge');
  const m = fx.html();
  ok(m.includes('Could not merge: The disk is full.') && m.includes(renderErrorDetail('ENOSPC: no space left on device, write')), '5.4 a failed merge shows its detail');
  ok(!/ENOSPC/.test(fx.state.healthLive || '') , '5.5 the spoken line is the sentence only');

  // Undo that failed with a detail.
  const un = deskFixture(THREE(), { deps: { bringBack: async () => { const e = new Error('The Curator isn\'t responding.'); e.detail = 'HTTP 502'; throw e; } } });
  un.desk.open();
  await un.paint();
  un.seen();
  await un.press('hr-keep');
  await un.press('hr-undo');
  ok(un.html().includes('Could not save: The Curator isn') && un.html().includes(renderErrorDetail('HTTP 502')), '5.6 a failed Undo shows its detail');

  // Compare all: the note carries the detail.
  const notes = [];
  const api = createCompareAll({
    pollMs: 5, slug: () => 'alpha', offered: () => true, mounted: () => true,
    fetchJSON: async () => { const e = new Error('Gemini is having problems on its side right now.'); e.detail = '503 upstream'; throw e; },
    render: () => {}, live: () => {}, ask: () => {}, note: (slug, text, retry, detail) => notes.push({ text, detail }),
    setBusy: () => {}, busy: () => false, focusAfterStart: () => {}, focusAfterStop: () => {}, modelName: () => 'm',
    cost: () => '', usd: () => '', chip: () => '', ring: () => '', sparkles: () => '', alert: () => '', escape: String,
    scanCounting: () => false, setCoverage: () => {}, pullPairs: async () => {}, ended: () => {},
  });
  await api.press('alpha');
  ok(notes.length === 1 && /^Could not compare pages: Gemini/.test(notes[0].text) && notes[0].detail === '503 upstream', '5.7 Compare all: a failed estimate notes the sentence and its detail');
  ok(userMessageFrom(new Error('x')).detail === '', '5.8 (cross-check) an error without detail carries none');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failures:\n  ' + fails.join('\n  ')); process.exit(1); }
