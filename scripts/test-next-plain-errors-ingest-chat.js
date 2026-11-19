#!/usr/bin/env node
/**
 * scripts/test-next-plain-errors-ingest-chat.js — OFFLINE (v3.99.2, wave 3 C2).
 *
 * Plain-language errors on Ingest (single file and batch), Chat, Compile,
 * the conversation list, the setup step's file reader and the MCP install
 * panel. No network, no server, no browser, no key.
 *
 * The shipping functions are LIFTED out of the view files and RUN with the
 * REAL shared/net.js and shared/user-errors.js (never a stub), fed the wire
 * shapes the server sends after part B ({type:'error', message, detail, code}
 * frames, {error, detail, code} bodies, the queue's error/errorDetail/
 * errorCode) and the raw text an OLDER server still sends. Every assertion is
 * on what a person would see: the rendered HTML or the state a render reads.
 *
 * The detail line's exact format belongs to net.js (it may gain a code
 * suffix), so this suite compares against renderErrorDetail()'s own output or
 * checks that the detail text is present, never a hand-typed line.
 *
 * Run: node scripts/test-next-plain-errors-ingest-chat.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as net from '../src/public/next/shared/net.js';
import { USER_MESSAGES } from '../src/public/next/shared/user-errors.js';
import { renderStatus } from '../src/public/next/shared/text.js';
import { readSseFrames } from '../src/public/next/shared/sse.js';
import { stripComments, functionSource } from './test-helpers/source-scan.js';
import './test-helpers/net-globals.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
const failures = [];
function section(t) { console.log(`\n${t}`); }
function ok(cond, msg, extra) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; failures.push(msg); console.log(`  ✗ ${msg}` + (extra !== undefined ? `\n      ${String(extra).slice(0, 600)}` : '')); }
}

function lift(src, name, where) {
  const body = functionSource(stripComments(src), name);
  if (!body) throw new Error(`lift: ${name} not found in ${where}`);
  return body;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Raw text exactly as the providers and the browser produce it.
const RAW_ANTHROPIC_401 = '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
const RAW_ANTHROPIC_CREDIT = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
const KEY_SENTENCE = net.userMessageFrom(RAW_ANTHROPIC_401).error;
const CREDIT_SENTENCE = net.userMessageFrom(RAW_ANTHROPIC_CREDIT).error;
const SERVER_DOWN = USER_MESSAGES['server-unreachable']();
const SERVER_OLD = USER_MESSAGES['server-outdated']();
const RAWISH = /\{"type"|authentication_error|HTTP \d{3}|Failed to fetch|Unexpected token|is not valid JSON/;

section('§0 the fixtures are what the catalogue says they are (dumb cross-check)');
ok(/didn't accept the API key/.test(KEY_SENTENCE) && !RAWISH.test(KEY_SENTENCE), 'a raw Anthropic 401 classifies as the bad-key sentence', KEY_SENTENCE);
ok(/run out of credit/.test(CREDIT_SENTENCE), 'a raw "credit balance is too low" classifies as the no-credit sentence', CREDIT_SENTENCE);
const translatedDown = net.translateFetchRejection(new TypeError('Failed to fetch'), '/api/ingest', {});
ok(translatedDown.message === SERVER_DOWN && translatedDown.curatorNetwork === true, 'the real fetch translation turns "Failed to fetch" into the server-unreachable sentence');

// ══════════════════════════════════════════════════════════════════════════
// INGEST, single file: runIngest end to end, with a fetch that answers the
// way the server does.
// ══════════════════════════════════════════════════════════════════════════
const ingestSrc = read('src/public/next/views/ingest.js');
const runIngestSrc = lift(ingestSrc, 'runIngest', 'ingest.js');
const failureSrc = lift(ingestSrc, 'renderIngestFailure', 'ingest.js');

const I = new Function('escapeHtml', 'renderStatus', 'icon', `
  ${failureSrc}
  return { renderIngestFailure };
`)(esc, renderStatus, () => '<svg></svg>');

function makeIngestRunner(fetchImpl) {
  const state = { file: { name: 'notes.pdf' }, domain: 'articles', errorMessage: null, errorCode: null, errorDetail: '' };
  const run = new Function('state', 'fetch', 'render', 'isCurrentMount', 'beginDomainWrite', 'document',
    'formatIngestDoneLabelHtml', 'clearSingleRunLine', 'refreshDomainStats', 'ackOwnCompletedRun', 'formatElapsedMs', `
    let phaseStartedAt = null; let elapsedTimerId = null;
    ${runIngestSrc}
    return runIngest;
  `)(state, fetchImpl, () => {}, () => true, () => () => {}, { getElementById: () => null },
    () => '', () => {}, async () => {}, async () => {}, () => '0s');
  return { state, run };
}

function sseResponse(frames) {
  const body = frames.map((f) => 'data: ' + JSON.stringify(f) + '\n\n').join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function jsonResponse(status, data) {
  return new Response(data === undefined ? '' : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

async function ingestWith(fetchImpl) {
  const { state, run } = makeIngestRunner(fetchImpl);
  await run('tok', false);
  const html = I.renderIngestFailure(state.errorMessage, state.errorCode, state.errorDetail);
  return { state, html };
}

section('§1 single-file ingest: a bad key (the server translated the frame)');
{
  const DETAIL = RAW_ANTHROPIC_401;
  const { state, html } = await ingestWith(async () => sseResponse([
    { type: 'progress', pct: 10, message: 'Reading' },
    { type: 'error', message: KEY_SENTENCE, detail: DETAIL, code: 'ai-key-rejected' },
  ]));
  ok(state.errorMessage === KEY_SENTENCE, '★ the plain sentence is the message', state.errorMessage);
  ok(state.errorDetail === DETAIL, '★ the frame\'s detail is kept (it used to be thrown away with the frame)', state.errorDetail);
  ok(html.includes(net.renderErrorDetail(DETAIL)), '★ the failure block shows the detail line under the sentence', html);
  ok(/Ingest failed/.test(html) && text(html).includes(KEY_SENTENCE), 'the heading and the sentence stay', html);
}

section('§2 single-file ingest: an OLDER server sends the raw provider text');
{
  const { state, html } = await ingestWith(async () => sseResponse([{ type: 'error', message: RAW_ANTHROPIC_CREDIT }]));
  ok(state.errorMessage === CREDIT_SENTENCE, '★ the raw text becomes the no-credit sentence', state.errorMessage);
  ok(state.errorDetail.includes('credit balance is too low'), 'and the raw text becomes the detail');
  const face = text(html.replace(/<div class="tx-error-detail">[\s\S]*?<\/div>/, ''));
  ok(!RAWISH.test(face), '★ no provider JSON in the main text', face);
}

section('§3 single-file ingest: the server is not running');
{
  const { state, html } = await ingestWith(async () => { throw net.translateFetchRejection(new TypeError('Failed to fetch'), '/api/ingest', {}); });
  ok(state.errorMessage === SERVER_DOWN, '★ "The Curator isn\'t responding…"', state.errorMessage);
  ok(state.errorDetail === '' && !/tx-error-detail/.test(html), 'no detail line for the browser\'s own text');
}

section('§4 single-file ingest: JSON refusals before the stream');
{
  const PREFLIGHT = 'The wiki folder for this domain is read-only. Nothing was sent to the AI and nothing was charged.';
  const a = await ingestWith(async () => jsonResponse(400, { error: PREFLIGHT }));
  ok(a.state.errorMessage === PREFLIGHT, '★ a deliberate refusal passes through UNCHANGED', a.state.errorMessage);
  const b = await ingestWith(async () => jsonResponse(500, undefined));
  ok(b.state.errorMessage === 'The ingest could not start.' && !/HTTP|\(5/.test(b.state.errorMessage), '★ an empty 500 says it in words, never "Ingest failed (500)"', b.state.errorMessage);
  ok(b.state.errorDetail === 'HTTP 500', 'and the status is the detail', b.state.errorDetail);
  const c = await ingestWith(async () => jsonResponse(500, { error: 'Something went wrong inside The Curator. Try again.', detail: 'TypeError: x is undefined', code: 'internal-error' }));
  ok(c.state.errorDetail === 'TypeError: x is undefined' && c.html.includes(net.renderErrorDetail('TypeError: x is undefined')), 'a body\'s detail reaches the screen');
}

section('§5 single-file ingest: MODEL_GONE keeps its own block, and the detail renders there too');
{
  const GONE = 'claude-haiku-4-5 is no longer offered by Anthropic.';
  const { state, html } = await ingestWith(async () => sseResponse([{ type: 'error', message: GONE, code: 'MODEL_GONE', detail: '404 not_found_error' }]));
  ok(state.errorCode === 'MODEL_GONE' && state.errorMessage === GONE, 'the code still dispatches, the sentence is unchanged');
  ok(/data-ingest-error-code="MODEL_GONE"/.test(html) && html.includes(net.renderErrorDetail('404 not_found_error')), 'the MODEL_GONE block carries the detail line');
  ok(I.renderIngestFailure('Plain.', null, '') === I.renderIngestFailure('Plain.', null), 'no detail: the markup is what it was');
}

// ══════════════════════════════════════════════════════════════════════════
// INGEST, batch: one queue row per failed file.
// ══════════════════════════════════════════════════════════════════════════
section('§6 batch rows: the wire\'s errorDetail is shown, an older server\'s raw text is translated');
{
  const logic = await import('../src/public/next/shared/ingest-queue-logic.js');
  const { formatUsdHonest } = await import('../src/public/next/shared/format-usd.js');
  const names = ['queueItemPageCounts', 'queueRanOnLine', 'queueSpendReading', 'queueSpendHtml', 'queueBudgetFacts', 'renderQueueItemRow'];
  const bodies = names.map((n) => lift(ingestSrc, n, 'ingest.js'));
  const V = new Function('escapeHtml', 'formatUsdHonest', 'computeQueueStatusCounts', 'formatHealthCounts', 'statusPillMeta',
    'sanitizeDisplayName', 'formatQueueBytes', 'queueRowNote', `
    const icon = () => '<svg></svg>';
    const progressRingHtml = () => '';
    const INGEST_STAGES = [];
    ${bodies.join('\n')}
    return { renderQueueItemRow };
  `)(esc, formatUsdHonest, logic.computeQueueStatusCounts, logic.formatHealthCounts, logic.statusPillMeta,
    logic.sanitizeDisplayName, logic.formatQueueBytes, logic.queueRowNote);

  const newWire = { status: 'failed', idx: 0, name: 'a.pdf', error: KEY_SENTENCE, errorDetail: RAW_ANTHROPIC_401, errorCode: 'ai-key-rejected' };
  const row = V.renderQueueItemRow(newWire, { jobTerminal: true });
  ok(text(row).includes(KEY_SENTENCE) && row.includes(net.renderErrorDetail(RAW_ANTHROPIC_401)), '★ the row shows the sentence and the detail line', row);

  const oldWire = { status: 'failed', idx: 1, name: 'b.pdf', error: RAW_ANTHROPIC_401 };
  const rowOld = V.renderQueueItemRow(oldWire, { jobTerminal: true });
  const faceOld = text(rowOld.replace(/<div class="tx-error-detail">[\s\S]*?<\/div>/, ''));
  ok(faceOld.includes(KEY_SENTENCE) && !RAWISH.test(faceOld), '★ an older server\'s raw text becomes the sentence on the row', faceOld);

  const plain = { status: 'failed', idx: 2, name: 'c.md', error: 'This file could not be read.' };
  const rowPlain = V.renderQueueItemRow(plain, { jobTerminal: true });
  ok(text(rowPlain).includes('This file could not be read.') && !/tx-error-detail/.test(rowPlain), 'a deliberate sentence passes through, with no detail line');

  const gone = { status: 'failed', idx: 3, name: 'd.md', error: 'The model is gone.', errorCode: 'MODEL_GONE', errorDetail: 'raw 404' };
  const rowGone = V.renderQueueItemRow(gone, { jobTerminal: true });
  ok(/data-ingest-error-code="MODEL_GONE"/.test(rowGone) && rowGone.includes(net.renderErrorDetail('raw 404')), 'a MODEL_GONE row keeps its block and shows the detail');
}

// ══════════════════════════════════════════════════════════════════════════
// CHAT: the stream reader, the JSON path, the failed turn.
// ══════════════════════════════════════════════════════════════════════════
const chatSrc = read('src/public/next/views/chat.js');

section('§7 chat stream: an error frame keeps its detail and code');
{
  const consume = new Function('readSseFrames', 'schedulePaintStream', `
    ${lift(chatSrc, 'consumeChatStream', 'chat.js')}
    return consumeChatStream;
  `)(readSseFrames, () => {});
  const body = sseResponse([
    { type: 'content', text: 'Hel' },
    { type: 'error', message: CREDIT_SENTENCE, detail: RAW_ANTHROPIC_CREDIT, code: 'ai-no-credit' },
  ]).body;
  let thrown = null;
  try { await consume(body, { reasoning: '', content: '' }, 1); } catch (e) { thrown = e; }
  ok(thrown && thrown.message === CREDIT_SENTENCE, 'the sentence is the message');
  ok(thrown && thrown.detail === RAW_ANTHROPIC_CREDIT && thrown.code === 'ai-no-credit', '★ detail and code travel on the Error');
  const u = net.userMessageFrom(thrown);
  ok(u.error === CREDIT_SENTENCE && u.detail === RAW_ANTHROPIC_CREDIT, 'and userMessageFrom reads them back for the failed turn');
}

section('§8 chat: the failed turn renders the detail under the sentence');
{
  // The exact markup the thread uses for an errored turn (lifted from the
  // render's own branch would need the whole thread renderer; the line that
  // matters is asserted on the SOURCE of that branch plus the helper's output).
  const branch = /if \(m\.error\) \{[\s\S]*?reaskButtonHtml\(i\)/.exec(stripComments(chatSrc));
  ok(branch && /renderErrorDetail\(m\.errorDetail\)/.test(branch[0]), 'the errored-turn branch renders m.errorDetail (source guard)');
  ok(net.renderErrorDetail(undefined) === '', 'a turn with no detail adds nothing');
}

section('§9 chat send: a JSON error body {error, detail, code} becomes an Error with all three');
{
  const res = { ok: false, status: 401 };
  const e = net.errorFromResponse(res, { error: KEY_SENTENCE, detail: RAW_ANTHROPIC_401, code: 'ai-key-rejected' }, 'The request failed.');
  ok(e.message === KEY_SENTENCE && e.detail === RAW_ANTHROPIC_401 && e.code === 'ai-key-rejected', 'all three survive');
  const empty = net.errorFromResponse({ ok: false, status: 502 }, null, 'The request failed.');
  ok(empty.message === 'The request failed.' && empty.detail === 'HTTP 502', 'a null body no longer throws a TypeError; it says the view\'s sentence with the status as detail');
  const sendSrc = stripComments(chatSrc);
  ok(/if \(!res\.ok\) throw errorFromResponse\(res, data, 'The request failed\.'\);/.test(sendSrc), 'the send path uses it (source guard)');
}

section('§10 chat cancel is untouched: the abort branch still comes first');
{
  const s = stripComments(chatSrc);
  const i = s.indexOf("if (controller.signal.aborted || (err && err.name === 'AbortError'))");
  const j = s.indexOf('const failure = userMessageFrom(err);', i);
  ok(i > 0 && j > i, '★ the abort test precedes the error translation in the send catch');
  const abort = new DOMException('The operation was aborted.', 'AbortError');
  const passed2 = net.translateFetchRejection(abort, '/api/chat/x', {});
  ok(passed2 === abort, 'the fetch translation passes an AbortError through as the same object');
}

section('§11 compile: the stream\'s error frame and the pre-flight body keep their detail');
{
  const s = stripComments(chatSrc);
  const fn = functionSource(s, 'runCompile') || '';
  ok(/errored = event;/.test(fn) && /e\.detail = errored\.detail/.test(fn), 'the reader keeps the whole frame (source guard)');
  ok(/renderErrorDetail\(failure\.detail\)/.test(fn), 'the outcome card renders the detail (source guard)');
  ok(/throw errorFromResponse\(res, j, 'The compile could not start\.'\)/.test(fn) && !/'HTTP ' \+ res\.status/.test(fn), 'the pre-flight path has no bare "HTTP <status>" message');
}

section('§12 compile confirm: a whole-sentence reason follows the copy, a short one keeps the old shape');
{
  const build = new Function('providerDisplayLabel', 'formatUsdHonest', `
    ${lift(chatSrc, 'buildCompileConfirmCopy', 'chat.js')}
    return buildCompileConfirmCopy;
  `)((p) => p, (n) => '$' + n);
  const a = build(null, 'articles', 'Chat', SERVER_DOWN);
  ok(a.detail.startsWith('The cost could not be estimated, so') && a.detail.endsWith(SERVER_DOWN) && !/\(The Curator/.test(a.detail), '★ a sentence is not squeezed into parentheses', a.detail);
  const b = build(null, 'articles', 'Chat', 'the request failed');
  ok(/could not be estimated \(the request failed\)/.test(b.detail), 'a short reason: byte-identical shape');
}

// ══════════════════════════════════════════════════════════════════════════
// The rest
// ══════════════════════════════════════════════════════════════════════════
section('§13 chat list: a load error shows its remembered detail');
{
  const LIST = await import('../src/public/next/views/chat-list.js');
  const msg = net.plainError(net.errorFromResponse({ status: 500 }, { error: 'EACCES: permission denied, open \'/Users/x/wiki/conversations/a.json\'' }));
  const html = LIST.conversationListHtml({ loadError: msg, conversations: [] });
  ok(/didn't let The Curator use a file/.test(text(html)), 'the sentence', text(html));
  ok(/tx-error-detail/.test(html) && /EACCES/.test(html) && !/\/Users\/x/.test(html), '★ the detail line, with the home folder cleaned', html);
}

section('§14 MCP install: a failed request is a sentence, never "HTTP 500", and its detail renders');
{
  const MI = await import('../src/public/next/views/mcp-install.js');
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => jsonResponse(500, undefined);
    const r = await MI.fetchInstallStatus();
    ok(r.ok === false && !/HTTP/.test(r.message) && r.detail === 'HTTP 500', '★ an empty 500: a sentence, the status as detail', JSON.stringify(r));
    globalThis.fetch = async () => jsonResponse(500, { error: 'EPERM: operation not permitted, open \'/Users/x/Library/Application Support/Claude/claude_desktop_config.json\'' });
    const r2 = await MI.fetchInstallStatus();
    const words = MI.failureWords(r2);
    const html = MI.renderAgentApps({ status: { error: words, data: null } });
    ok(/didn't let The Curator use a file/.test(text(html)) && /tx-error-detail/.test(html) && /EPERM/.test(html) && !/\/Users\/x/.test(html),
      '★ an older server\'s raw fs error: the sentence, then the cleaned detail', html);
    globalThis.fetch = async () => jsonResponse(409, { error: 'Another install is still running.', code: 'busy' });
    const r3 = await MI.fetchInstallStatus();
    ok(MI.failureWords(r3) === 'Another install is still running. Wait a moment, then try again.', 'a deliberate code keeps its own sentence');
  } finally {
    globalThis.fetch = origFetch;
  }
}

console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('Failures:\n  - ' + failures.join('\n  - ')); }
process.exit(failed === 0 ? 0 : 1);
