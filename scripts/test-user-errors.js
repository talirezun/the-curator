#!/usr/bin/env node
/**
 * Plain-language errors (src/public/next/shared/user-errors.js and
 * src/brain/user-errors.js), offline.
 *
 * THE PROPERTY. Raw machine text (a Node errno, an AI SDK's message, git's
 * `Command failed:`, a V8 TypeError) becomes a sentence a non-technical person
 * can act on, with the original in a sanitised `detail`. Everything The Curator
 * wrote on purpose passes through UNCHANGED.
 *
 * WHAT MAKES IT NOT DECORATIVE
 *   §1  REAL error objects, never hand-typed strings where a real one can be
 *       made: fs errnos actually triggered in a temp dir; a real ECONNREFUSED
 *       from fetch to 127.0.0.1:1; a real child_process git `Command failed`;
 *       the installed Anthropic, Gemini and OpenRouter clients talking HTTP to
 *       a local stub that answers like the provider; the Shared Brain GitHub
 *       adapter over a stub fetch; a real TypeError. ENOSPC alone cannot be
 *       provoked and is built by hand, in Node's exact shape, and said so.
 *   §2  THE CENSUS: every string literal in src/routes, src/brain and
 *       server.js (17,000+), extracted by a tokenizer-grade scan
 *       (test-helpers/string-literals.js), must classify as null except two
 *       named raw producers. Then every TEMPLATE in that set is re-rendered
 *       with page-title-like values that mention the signatures' words
 *       mid-sentence (the way a user's page name or file name reaches a
 *       deliberate message), and must still classify as null. Plus the
 *       EXECUTED builders whose output is pinned elsewhere: llm.js's ⚠
 *       rate-limit and overload messages for every provider, model-gone,
 *       and every translated output of sync.js friendlyError.
 *   §3  The v3.0.16 case: merge-conflict text whose temp paths carry 401/403.
 *   §4  IN-SUITE MUTATION CONTROLS: a bare /\b401\b/ added to the signature
 *       list, and each anchored signature with its anchor removed, must each
 *       turn the census red. A census that cannot fail proves nothing.
 *   §5  The leak guard on `detail`, including the 40-hex classic token in a
 *       URL that scrubSecrets alone misses (shown, as a dumb cross-check).
 *   §6  userErrorBody: same object on a miss, never re-translates a body that
 *       has `detail`, never replaces an existing `code`, client classes ignored.
 *   §7  One table: the server re-exports the browser module's functions.
 *   §8  Every control a sentence names exists in src/public/next.
 *   §9  toUserError never touches the error; abort, ⚠ and model-gone pass.
 *   §10 Importing and running the server module writes nothing to stdout (it
 *       is reachable from mcp/ once other modules import it).
 *
 * NOT ENFORCED: the census sees literals, templates and the executed builders,
 * not a message assembled at run time from computed pieces; what a VIEW shows
 * is the frontend's suites' job.
 */

import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { exec, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

import * as SHARED from '../src/public/next/shared/user-errors.js';
import * as UE from '../src/brain/user-errors.js';
import { extractStringLiterals } from './test-helpers/string-literals.js';
import { scrubSecrets } from '../src/brain/logger.js';
import { scrubPaths } from '../src/brain/scrub-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`); }
function section(t) { console.log(`\n── ${t}`); }

const { classifyErrorText, USER_MESSAGES, KLASS_CODES, CLIENT_KLASSES } = SHARED;
const { toUserError, userErrorBody, userErrorText, sanitizeDetail } = UE;

/** Nothing raw may reach the visible sentence. */
const RAW_IN_ERROR = /\bE[A-Z]{3,}:|Command failed|\{"type"|\/Users\/|\/private\/|HTTP \d{3}|fetch failed|GoogleGenerativeAI|\bat [\w.]+ \(|x-api-key|status code/;

function expectKlass(label, err, klass, ctx = {}) {
  const u = toUserError(err, ctx);
  ok(`${label} → ${klass}`, !!u && u.code === KLASS_CODES[klass],
    `got ${u ? u.code : 'null'} for ${JSON.stringify(err && err.message !== undefined ? err.message : err).slice(0, 300)}`);
  if (u) {
    ok(`${label}: the sentence carries no raw text`, !RAW_IN_ERROR.test(u.error), u.error);
    ok(`${label}: the sentence is the catalogue's`, u.error.endsWith(USER_MESSAGES[klass]({ ...ctx, provider: 'P', name: 'N', service: 'S' }).split(' ').slice(-3).join(' ')), u.error);
    ok(`${label}: detail is present`, typeof u.detail === 'string' && u.detail.length > 0);
  }
  return u;
}

const tmp = mkdtempSync(path.join(tmpdir(), 'curator-user-errors-'));

// ── A local stub that answers like each provider ─────────────────────────────
let hang = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const url = req.url || '';
    // Anthropic: POST /v1/messages, scenario in the model name.
    if (url.startsWith('/v1/messages')) {
      const model = (() => { try { return JSON.parse(body).model; } catch { return ''; } })();
      const A = (status, type, message) => send(status, { type: 'error', error: { type, message } });
      switch (model) {
        case 'auth': return A(401, 'authentication_error', 'invalid x-api-key');
        case 'perm': return A(403, 'permission_error', 'Your API key does not have permission to use the specified resource.');
        case 'credit': return A(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.');
        case 'long': return A(400, 'invalid_request_error', 'prompt is too long: 212345 tokens > 200000 maximum');
        case 'gone': return A(404, 'not_found_error', 'model: claude-nope');
        case 'rate': return A(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit');
        case 'over': return A(529, 'overloaded_error', 'Overloaded');
        case 'other': return A(400, 'invalid_request_error', 'messages: text content blocks must be non-empty');
        case 'hang': hang.push(res); return undefined;
        default: return A(500, 'api_error', 'Internal server error');
      }
    }
    // Gemini: POST /v1beta/models/<scenario>:generateContent
    const g = /\/models\/([a-z]+):/.exec(url);
    if (g) {
      const G = (status, statusText, message, details) => { res.writeHead(status, statusText, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: status, message, status: statusText, details } })); };
      switch (g[1]) {
        case 'badkey': return G(400, 'Bad Request', 'API key not valid. Please pass a valid API key.',
          [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]);
        case 'quota': return G(429, 'Too Many Requests', 'Resource has been exhausted (e.g. check quota).');
        case 'long': return G(400, 'Bad Request', 'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).');
        case 'gone': return G(404, 'Not Found', 'models/gone is not found for API version v1beta, or is not supported for generateContent.');
        default: return G(503, 'Service Unavailable', 'The model is overloaded. Please try again later.');
      }
    }
    // OpenRouter: POST /chat/completions, scenario in the model name.
    if (url.startsWith('/chat/completions')) {
      const model = (() => { try { return JSON.parse(body).model; } catch { return ''; } })();
      if (model === 'or/long') return send(400, { error: { code: 400, message: "This endpoint's maximum context length is 8192 tokens. However, you requested about 90000 tokens." } });
      if (model === 'or/hang') { hang.push(res); return undefined; }
      return send(500, { error: { code: 500, message: 'Internal Server Error' } });
    }
    send(404, {});
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const STUB = `http://127.0.0.1:${stub.address().port}`;
// A port that was just closed, NOT port 1: Node's fetch (undici) refuses port 1
// itself as a "bad port" (cause: 'bad port') and never attempts a connection.
const closedPort = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const OFFLINE_URL = `http://127.0.0.1:${closedPort}`;

async function caught(fn) { try { await fn(); } catch (e) { return e; } return null; }

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('§1a — real fs errors, actually triggered');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const enoent = await caught(() => readFile(path.join(tmp, 'missing-page.md')));
    const u = expectKlass('ENOENT (readFile of a missing file)', enoent, 'files-missing');
    ok('ENOENT names the file by its basename only', u && u.error.includes('missing-page.md') && !u.error.includes(tmp), u && u.error);
    ok('ENOENT detail is path-scrubbed', u && !u.detail.includes(tmp) && u.detail.includes('missing-page.md'), u && u.detail);
    // What chat.js and the ingest queue send today: the message, path-scrubbed.
    const t = classifyErrorText(scrubPaths(enoent.message));
    eq('a path-scrubbed ENOENT message still classifies (text only)', t && t.klass, 'files-missing');
    eq('...and still names the basename', t && t.name, 'missing-page.md');

    mkdirSync(path.join(tmp, 'twice'));
    expectKlass('EEXIST (mkdir twice)', await caught(() => mkdir(path.join(tmp, 'twice'))), 'files-exists');

    const locked = path.join(tmp, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const eacces = await caught(() => readdir(locked));
    chmodSync(locked, 0o700);
    if (eacces) expectKlass('EACCES (readdir of a chmod 000 folder)', eacces, 'files-not-allowed');
    else ok('EACCES could be provoked (this suite must not run as root)', false, 'readdir of a mode-000 folder succeeded');

    writeFileSync(path.join(tmp, 'afile'), 'x');
    expectKlass('ENOTDIR (a file where a folder should be)', await caught(() => readFile(path.join(tmp, 'afile', 'index.md'))), 'files-wrong-kind');
    expectKlass('EISDIR (reading a folder as a file)', await caught(() => readFile(path.join(tmp, 'twice'))), 'files-wrong-kind');
    expectKlass('ENAMETOOLONG (a 300-character name)', await caught(() => readFile(path.join(tmp, 'a'.repeat(300)))), 'files-name-too-long');

    // ENOSPC cannot be provoked without filling a disk: built by hand, in Node's shape.
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { errno: -28, code: 'ENOSPC', syscall: 'write' });
    expectKlass('ENOSPC (hand-built, Node shape; no path)', enospc, 'files-disk-full');
    eq('ENOSPC as text classifies the same', classifyErrorText(enospc.message)?.klass, 'files-disk-full');

    // health-undo's glued message: its own sentence is KEPT, the errno moves to detail.
    const glued = `The Curator could not save a copy of concepts/x.md for Undo, so it did not change it. ${eacces ? eacces.message : "EACCES: permission denied, open '/tmp/x'"}`;
    const ug = toUserError(glued);
    ok('a glued message keeps The Curator\'s own sentence', ug && ug.error.startsWith('The Curator could not save a copy of concepts/x.md for Undo, so it did not change it. '), ug && ug.error);
    ok('...and loses the raw errno from the sentence', ug && !/EACCES|permission denied/.test(ug.error), ug && ug.error);
    ok('...which is kept in detail', ug && ug.detail.includes('EACCES'), ug && ug.detail);
    const colon = toUserError(`readPage failed: ${enoent.message}`);
    ok('a programmer prefix ending in a colon is dropped', colon && colon.error.startsWith('The Curator couldn\'t find'), colon && colon.error);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§1b — real network, git and bug errors');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const refused = await caught(() => fetch(`${OFFLINE_URL}/`));
    ok('fetch to a closed local port really failed with ECONNREFUSED', refused && refused.message === 'fetch failed' && refused.cause && refused.cause.code === 'ECONNREFUSED',
      refused && `${refused.message} / ${refused.cause && refused.cause.code}`);
    const u = expectKlass('fetch ECONNREFUSED (Shared Brain area)', refused, 'network-unreachable', { area: 'sharedbrain' });
    ok('...names GitHub for the Shared Brain area', u && u.error.includes('reach GitHub'), u && u.error);
    ok('...detail keeps the cause for support', u && u.detail.includes('ECONNREFUSED'), u && u.detail);
    expectKlass('fetch ECONNREFUSED (AI area)', refused, 'ai-unreachable', { area: 'ai' });
    eq('the cause text alone ("connect ECONNREFUSED …") classifies', classifyErrorText(refused.cause.message)?.klass, 'network-unreachable');

    const gitErr = await caught(() => promisify(exec)(`git --git-dir="${path.join(tmp, 'no-such-repo')}" --work-tree="${tmp}" status`));
    ok('a real git child_process failure starts "Command failed: git"', gitErr && /^Command failed: git /.test(gitErr.message), gitErr && gitErr.message);
    const ug = expectKlass('git Command failed', gitErr, 'git-other', { area: 'sync' });
    ok('...in the Sync area names Sync now', ug && ug.error.includes('Try Sync now again'), ug && ug.error);
    ok('...detail carries no temp path', ug && !ug.detail.includes(tmp), ug && ug.detail);
    const ug2 = toUserError(gitErr, { area: 'update' });
    ok('...outside Sync does not mention Sync', ug2 && !/Sync/.test(ug2.error), ug2 && ug2.error);

    let bug;
    try { const o = undefined; o.slug; } catch (e) { bug = e; }
    expectKlass('a real TypeError (reading a property of undefined)', bug, 'internal-error');
    ok('internal-error never claims nothing was changed', !/nothing was changed|not changed/i.test(USER_MESSAGES['internal-error']()));
    let ref;
    try { notDefinedAnywhere(); } catch (e) { ref = e; } // eslint-disable-line no-undef
    expectKlass('a real ReferenceError', ref, 'internal-error');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§1c — the installed Anthropic SDK, over HTTP to a stub');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const client = (opts = {}) => new Anthropic({ apiKey: 'sk-ant-FAKE-NOT-REAL-KEY-00000', baseURL: STUB, maxRetries: 0, ...opts });
    const call = (model, opts) => caught(() => client(opts).messages.create({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }));
    const auth = await call('auth');
    ok('the SDK really threw its AuthenticationError', auth && auth.constructor.name === 'AuthenticationError' && auth.status === 401, auth && auth.constructor.name);
    ok('...whose message is the raw "401 {json}" shape', auth && /^401 \{"type":"error"/.test(auth.message), auth && auth.message);
    const ua = expectKlass('Anthropic 401 authentication_error', auth, 'ai-key-rejected');
    ok('...names Anthropic and says not charged', ua && ua.error.startsWith('Anthropic didn') && ua.error.includes('not charged'), ua && ua.error);
    eq('...the same by text alone', classifyErrorText(auth.message)?.klass, 'ai-key-rejected');
    eq('...the same after a caller prefix', classifyErrorText(`Ingest failed: ${auth.message}`)?.klass, 'ai-key-rejected');
    expectKlass('Anthropic 403 permission_error', await call('perm'), 'ai-key-rejected');
    const credit = expectKlass('Anthropic 400 credit balance too low', await call('credit'), 'ai-no-credit');
    ok('...says not charged', credit && credit.error.includes('not charged'));
    expectKlass('Anthropic 400 prompt is too long', await call('long'), 'ai-too-long');
    expectKlass('Anthropic 404 not_found_error', await call('gone'), 'ai-model-unavailable');
    expectKlass('Anthropic 429 rate_limit_error', await call('rate'), 'ai-rate-limited');
    expectKlass('Anthropic 529 overloaded_error', await call('over'), 'ai-overloaded');
    expectKlass('Anthropic 500 api_error', await call('fivehundred'), 'ai-overloaded');
    expectKlass('Anthropic 400 other invalid_request_error', await call('other'), 'ai-provider-error');
    for (const s of ['auth', 'credit', 'long', 'gone', 'rate', 'over', 'other']) {
      const e = await call(s);
      eq(`Anthropic ${s}: structure and text agree`, classifyErrorText(e.message)?.klass, toUserError(e)?.code);
    }

    const conn = await caught(() => new Anthropic({ apiKey: 'sk-ant-FAKE-NOT-REAL-KEY-00000', baseURL: OFFLINE_URL, maxRetries: 0 })
      .messages.create({ model: 'x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }));
    ok('the SDK really threw APIConnectionError', conn && conn.constructor.name === 'APIConnectionError', conn && conn.constructor.name);
    const uc = expectKlass('Anthropic APIConnectionError', conn, 'ai-unreachable');
    ok('...names Anthropic', uc && uc.error.includes('reach Anthropic'), uc && uc.error);
    const to = await call('hang', { timeout: 150 });
    ok('the SDK really threw APIConnectionTimeoutError', to && to.constructor.name === 'APIConnectionTimeoutError', to && to.constructor.name);
    const ut = expectKlass('Anthropic timeout', to, 'ai-timeout');
    ok('...says the provider MAY still bill (never "not charged")', ut && /may still bill/.test(ut.error) && !/not charged/.test(ut.error), ut && ut.error);
    for (const r of hang.splice(0)) { try { r.destroy(); } catch { /* gone */ } }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§1d — the installed Gemini SDK, over HTTP to a stub');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const gen = (model, base = STUB) => caught(() => new GoogleGenerativeAI('AIzaFAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAK')
      .getGenerativeModel({ model }, { baseUrl: base }).generateContent('hi'));
    const bad = await gen('badkey');
    ok('the SDK really threw GoogleGenerativeAIFetchError', bad && bad.constructor.name === 'GoogleGenerativeAIFetchError' && bad.status === 400, bad && bad.constructor.name);
    ok('...whose message is the raw "[GoogleGenerativeAI Error]: Error fetching from" shape', bad && /^\[GoogleGenerativeAI Error\]: Error fetching from /.test(bad.message), bad && bad.message);
    const ub = expectKlass('Gemini 400 API_KEY_INVALID', bad, 'ai-key-rejected');
    ok('...names Gemini', ub && ub.error.startsWith('Gemini didn'), ub && ub.error);
    eq('...the same by text alone', classifyErrorText(bad.message)?.klass, 'ai-key-rejected');
    expectKlass('Gemini 429 quota', await gen('quota'), 'ai-rate-limited');
    expectKlass('Gemini 400 input token count too large', await gen('long'), 'ai-too-long');
    expectKlass('Gemini 404 model not found', await gen('gone'), 'ai-model-unavailable');
    expectKlass('Gemini 503 overloaded', await gen('busy'), 'ai-overloaded');
    const off = await gen('x', OFFLINE_URL);
    ok('offline, the SDK says "Error fetching from … fetch failed"', off && /Error fetching from \S+: fetch failed/.test(off.message), off && off.message);
    expectKlass('Gemini offline', off, 'ai-unreachable');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§1e — the OpenRouter adapter and the Shared Brain GitHub adapter');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { OpenRouterAdapter } = await import('../src/brain/openrouter-adapter.js');
    const or = (model, opts = {}) => caught(() => new OpenRouterAdapter({ apiKey: 'sk-or-v1-fixture-not-a-real-key', baseUrl: STUB, ...opts })
      .createChatCompletion({ model, systemPrompt: 's', userPrompt: 'u', maxTokens: 5 }));
    const e500 = await or('or/fivehundred');
    ok('the adapter really threw OpenRouterError with its "→ HTTP 500" text', e500 && e500.name === 'OpenRouterError' && /→ HTTP 500/.test(e500.message), e500 && `${e500.name} ${e500.code} ${e500.message}`);
    expectKlass('OpenRouter 500', e500, 'ai-overloaded');
    const eLong = await or('or/long');
    ok('the adapter really threw on a context-length 400', eLong && eLong.name === 'OpenRouterError', eLong && eLong.message);
    expectKlass('OpenRouter 400 maximum context length', eLong, 'ai-too-long');
    const eOff = await caught(() => new OpenRouterAdapter({ apiKey: 'sk-or-v1-fixture-not-a-real-key', baseUrl: OFFLINE_URL })
      .createChatCompletion({ model: 'm', systemPrompt: 's', userPrompt: 'u', maxTokens: 5 }));
    ok('the adapter really threw OPENROUTER_NETWORK offline', eOff && eOff.code === 'OPENROUTER_NETWORK', eOff && `${eOff.code} ${eOff.message}`);
    expectKlass('OpenRouter offline', eOff, 'ai-unreachable');
    eq('...the same by text alone', classifyErrorText(eOff.message)?.klass, 'ai-unreachable');
    const eSlow = await or('or/hang', { timeoutMs: 150 });
    ok('the adapter really timed out', eSlow && eSlow.code === 'OPENROUTER_NETWORK' && /did not respond within/.test(eSlow.message), eSlow && eSlow.message);
    expectKlass('OpenRouter timeout', eSlow, 'ai-timeout');
    eq('...the same by text alone', classifyErrorText(eSlow.message)?.klass, 'ai-timeout');
    for (const r of hang.splice(0)) { try { r.destroy(); } catch { /* gone */ } }

    const { GitHubStorageAdapter } = await import('../src/brain/sharedbrain-github-adapter.js');
    const gh = (status, message) => new GitHubStorageAdapter({
      owner: 'cohort', repo: 'brain', pat: 'github_pat_FAKE_SECRET_DONOTLEAK_zZ123456789',
      fetchImpl: async () => new Response(JSON.stringify({ message }), { status, headers: { 'content-type': 'application/json' } }),
    });
    const e401 = await caught(() => gh(401, 'Bad credentials').readPage('d', 'concepts/x.md'));
    ok('the adapter really threw GitHubAdapterError SHARED_BRAIN_AUTH', e401 && e401.name === 'GitHubAdapterError' && e401.code === 'SHARED_BRAIN_AUTH', e401 && `${e401.name} ${e401.code}`);
    const u = expectKlass('GitHub 401', e401, 'github-token-rejected');
    ok('...detail never carries the token', u && !u.detail.includes('github_pat_'), u && u.detail);
    eq('...the same by text alone (what a route\'s err.message carries)', classifyErrorText(e401.message)?.klass, 'github-token-rejected');
    eq('...after a caller prefix', classifyErrorText(`pullCollective: listPages failed: ${e401.message}`)?.klass, 'github-token-rejected');
    expectKlass('GitHub 403 rate limit', await caught(() => gh(403, 'API rate limit exceeded for user ID 1.').readPage('d', 'concepts/x.md')), 'github-busy');
    expectKlass('GitHub 403 forbidden', await caught(() => gh(403, 'Resource not accessible by personal access token').readPage('d', 'concepts/x.md')), 'github-token-rejected');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§2 — the census: every deliberate message passes through');
  // ═══════════════════════════════════════════════════════════════════════
  function walk(d) {
    return readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
  }
  const censusFiles = [...walk(path.join(ROOT, 'src/routes')), ...walk(path.join(ROOT, 'src/brain')), path.join(ROOT, 'src/server.js')]
    .filter((f) => !f.endsWith(`${path.sep}user-errors.js`));
  const literals = censusFiles.flatMap((f) => extractStringLiterals(readFileSync(f, 'utf8')).map((l) => ({ ...l, file: path.relative(ROOT, f) })));
  // The ONLY literals in the code base that ARE raw-machine producers, each
  // named: they head a message whose tail is another error's raw text.
  const RAW_PRODUCERS = new Map([
    ['src/brain/health-ai.js|AI response was not valid JSON: X', 'the model answered with unparseable JSON (V8 parser text follows)'],
    ['src/brain/openrouter-adapter.js|OpenRouter request failed before a response arrived: X', 'the transport error text follows'],
  ]);
  // Controls: the scan must see real messages, and must not see comments.
  const texts = new Set(literals.map((l) => l.text));
  ok('scan control: sees the ingest-preflight sentence', [...texts].some((t) => t.startsWith('Nothing was sent to the AI and nothing was charged')));
  ok('scan control: sees the Host-guard sentence head in server.js', [...texts].some((t) => t.startsWith('Invalid Host header.')));
  ok('scan control: sees the Shared Brain token sentence with "(401/403)"', [...texts].some((t) => t.includes('GitHub rejected the token (401/403)')));
  ok('scan control: a template\'s ${…} becomes X', texts.has('AI response was not valid JSON: X'));
  ok('scan control: skips comments (a phrase only in a comment is absent)', ![...texts].some((t) => t.includes('ORDER IS LOAD-BEARING (v3.0.16)')));
  ok(`scan control: a large census (${literals.length} literals, ${censusFiles.length} files)`, literals.length > 10000 && censusFiles.length > 80);

  function censusHits(list) {
    return list.filter((l) => classifyErrorText(l.text) && !RAW_PRODUCERS.has(`${l.file}|${l.text}`));
  }
  const hits = censusHits(literals);
  ok(`census: 0 of ${literals.length} deliberate literals classify`, hits.length === 0,
    hits.slice(0, 8).map((h) => `${h.file}:${h.line} ${classifyErrorText(h.text).klass} ${JSON.stringify(h.text.slice(0, 100))}`).join('\n      '));
  for (const key of RAW_PRODUCERS.keys()) {
    const [file, text] = key.split('|');
    ok(`raw producer still exists (else drop it from the list): ${file}`, literals.some((l) => l.file === file && l.text === text));
  }

  // Templates re-rendered with page-title-like values that mention the
  // signatures' words mid-sentence — how a user's page or file name reaches
  // a deliberate message.
  const HAZARD_VALUES = [
    'Why the fetch failed',
    'Handling a Connection error.',
    'Why the Request timed out.',
    'Notes on Command failed: git output',
    'A 401 {"type":"error","error":{"type":"authentication_error"}} sample',
    'Why a 503 status code (no body)',
    'Reading [GoogleGenerativeAI Error]: logs',
    'Why GitHub GET contents/x → 401',
    'Why OpenRouter chat/completions → HTTP 401',
    'Why OpenRouter request failed before a response arrived: notes',
    'Why OpenRouter did not respond within 5 ms.',
    'Why AI response was not valid JSON',
    'Notes on a self signed certificate in certificate chain',
    'My notes on why x is not a function',
    'Why Cannot read properties of undefined (reading \'x\') appears',
    'Why Failed to fetch',
    'A Request failed (500)',
    'Notes on why connect ECONNREFUSED shows',
    'Why Unexpected token \'<\', "<!DOCTYPE" shows',
  ];
  const templates = literals.filter((l) => l.text.includes('X') && /\s/.test(l.text) && !RAW_PRODUCERS.has(`${l.file}|${l.text}`));
  function renderAll(list) {
    const out = [];
    for (const t of list) for (const v of HAZARD_VALUES) out.push({ ...t, text: t.text.split('X').join(v) });
    return out;
  }
  const rendered = renderAll(templates);
  const tHits = rendered.filter((r) => classifyErrorText(r.text));
  // A rendered value MAY legitimately land right after "…: " where a raw tail
  // goes — those are not mid-sentence and are counted separately.
  const midSentence = tHits.filter((r) => !HAZARD_VALUES.some((v) => r.text.includes(`: ${v}`) || r.text.includes(`. ${v}`) || r.text.startsWith(v) || r.text.includes(`\n${v}`)));
  ok(`template fuzz: 0 of ${rendered.length} renders classify where the value sits mid-sentence (${templates.length} templates × ${HAZARD_VALUES.length} values)`,
    midSentence.length === 0,
    midSentence.slice(0, 6).map((h) => `${h.file}:${h.line} ${classifyErrorText(h.text).klass} ${JSON.stringify(h.text.slice(0, 120))}`).join('\n      '));
  // A value placed straight after "…: " is where callers append raw text; the
  // hazard values are written so that even there they do not classify.
  ok(`template fuzz: 0 renders classify even after ": " / ". " (all ${rendered.length})`, tHits.length === 0,
    tHits.slice(0, 6).map((h) => `${h.file}:${h.line} ${classifyErrorText(h.text).klass} ${JSON.stringify(h.text.slice(0, 120))}`).join('\n      '));

  // Executed builders whose words are pinned elsewhere.
  const { __testing: LLM } = await import('../src/brain/llm.js');
  const { modelGoneError } = await import('../src/brain/model-gone.js');
  const executed = [];
  for (const [name, id] of [['Gemini', 'gemini'], ['Claude', 'anthropic'], ['OpenRouter', 'openrouter'], ['AI provider', 'nope']]) {
    executed.push(LLM.buildRateLimitMessage(name, id, 30), LLM.buildRateLimitMessage(name, id, 1, { limit: '50', remaining: '0' }), LLM.buildServiceUnavailableMessage(name, id));
    executed.push(modelGoneError(name, 'some-model-401').message);
  }
  const { friendlyError } = await import('../src/brain/sync.js');
  const GIT_RAW = [
    'Command failed: git pull\nerror: The following untracked working tree files would be overwritten by merge:\n\twiki/a.md',
    'Command failed: git pull\nAutomatic merge failed; fix conflicts and then commit the result.',
    "Command failed: git fetch\nerror: cannot lock ref 'refs/remotes/origin/main': is at 4011a2 but expected 403ff1",
    'Command failed: git pull\nerror: Your local changes to the following files would be overwritten by merge:\n\twiki/b.md',
    "Command failed: git add\nerror: 'wiki/sub/' does not have a commit checked out",
    '/bin/sh: git: command not found',
    "Command failed: git push\nremote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
    "Command failed: git push\nfatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "Command failed: git push\nremote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found",
    'Command failed: git push\nfatal: unable to access: Could not resolve host: github.com',
    'Command failed: git push\n ! [rejected] main -> main (fetch first)',
  ];
  let friendlyCount = 0;
  for (const raw of GIT_RAW) {
    const out = friendlyError(new Error(raw));
    if (typeof out === 'string' && out !== raw && !out.startsWith('Command failed')) { executed.push(out); friendlyCount++; }
  }
  ok(`sync friendlyError translated most raw git shapes (${friendlyCount} of ${GIT_RAW.length})`, friendlyCount >= 6);
  const exHits = executed.filter((t) => classifyErrorText(t));
  ok(`executed builders: 0 of ${executed.length} classify (llm ⚠ messages, model-gone, sync friendlyError)`, exHits.length === 0,
    exHits.map((t) => JSON.stringify(t.slice(0, 120))).join('\n      '));
  for (const t of executed) {
    const body = { error: t };
    ok(`executed builder passes userErrorBody as the SAME object: ${t.slice(0, 50)}…`, userErrorBody(body) === body);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§3 — the v3.0.16 case: 401/403 inside merge-conflict text');
  // ═══════════════════════════════════════════════════════════════════════
  const MERGE_CONFLICT = [
    'Command failed: git -c core.quotepath=off pull --no-rebase origin main',
    'From https://github.com/o/r',
    ' * branch            main       -> FETCH_HEAD',
    '   4011f3a..403e2b9  main       -> origin/main',
    'Auto-merging wiki/concepts/401-k.md',
    'CONFLICT (content): Merge conflict in wiki/concepts/401-k.md',
    'error: could not write /private/var/folders/xy/T/curator-sync-403-9f2/.git/MERGE_MSG',
    'Automatic merge failed; fix conflicts and then commit the result.',
  ].join('\n');
  {
    const h = classifyErrorText(MERGE_CONFLICT);
    ok('merge-conflict text with 401/403 is never a token problem', !h || !/token|key/.test(h.klass), h && h.klass);
    eq('...it is the undiagnosed git class (Sync\'s own translation diagnoses)', h && h.klass, 'git-other');
    const plain = 'GitHub rejected the token (401/403). Check that the token is pasted correctly.';
    eq('a deliberate sentence mentioning (401/403) is left alone', classifyErrorText(plain), null);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§4 — in-suite mutation controls: the census can fail');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const SIG = SHARED.__SIGNATURES;
    const run = () => censusHits(literals).length + censusHits(renderAll(templates)).length
      + (classifyErrorText(MERGE_CONFLICT)?.klass === 'ai-key-rejected' ? 1 : 0)
      + executed.filter((t) => classifyErrorText(t)).length;
    eq('baseline: the census is green', run(), 0);
    // M1: a bare 401 — the v3.0.16 regression.
    SIG.unshift([/\b40[13]\b/, () => ({ klass: 'ai-key-rejected' })]);
    const m1 = run();
    SIG.shift();
    ok(`M1: a bare /\\b40[13]\\b/ signature turns the census red (${m1} hits)`, m1 > 0);
    // M2: each anchored signature, un-anchored, must be caught.
    const B = String.raw`(?:^|[:.]\s+|\n)`;
    let anchored = 0;
    const uncaught = [];
    for (let i = 0; i < SIG.length; i++) {
      const [re, build] = SIG[i];
      if (!re.source.startsWith(B)) continue;
      anchored++;
      SIG[i] = [new RegExp(re.source.slice(B.length), re.flags), build];
      const n = run();
      SIG[i] = [re, build];
      if (n === 0) uncaught.push(re.source.slice(B.length, B.length + 50));
    }
    ok(`M2: every one of ${anchored} anchored signatures, un-anchored, turns the census red`, uncaught.length === 0,
      `not caught: ${uncaught.join(' | ')}`);
    eq('restored: the census is green again', run(), 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§5 — the leak guard on detail');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const HEX40 = '0123456789abcdef0123456789abcdef01234567';
    const home = homedir();
    const SECRETS = [
      ['classic 40-hex token in a URL', `fatal: unable to access 'https://${HEX40}@github.com/o/r.git/': 403`, [HEX40]],
      ['user:token in a URL', `remote https://alice:${HEX40}@github.com/o/r.git`, [HEX40, 'alice:']],
      ['ghp_', 'token ghp_thisisasecretpatdonotleak1234abcdABCD was refused', ['ghp_', 'thisisasecretpat']],
      ['github_pat_', 'github_pat_FAKE_SECRET_DONOTLEAK_zZ123456789 expired', ['github_pat_', 'DONOTLEAK']],
      ['sk-ant-', '401 invalid key sk-ant-FAKE-NOT-REAL-KEY-00000', ['sk-ant-', 'NOT-REAL-KEY']],
      ['sk-or-', 'OpenRouter said: bad key sk-or-v1-fixture-not-a-real-key', ['sk-or-', 'fixture-not-a-real']],
      ['AIza', 'url https://x.googleapis.com/v1/m?key=AIzaFAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAK failed', ['AIza', 'FAKEKEY0']],
      ['Bearer', 'Authorization: Bearer abcdefghijklmnop0123 rejected', ['abcdefghijklmnop0123']],
      ['a home path with spaces', "ENOENT: no such file or directory, open '/Users/alice smith/Google Drive/My Drive/wiki/log.md'", ['alice smith', 'Google Drive']],
      ['this machine\'s home path', `EPERM: operation not permitted, open '${path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'wiki', 'index.md')}'`, [home]],
      ['an unquoted home path', `could not write ${path.join(home, 'Documents', 'wiki', 'x.md')} today`, [home]],
    ];
    for (const [label, text, forbidden] of SECRETS) {
      const d = sanitizeDetail(text);
      const leaked = forbidden.filter((f) => d.includes(f));
      ok(`detail: ${label} is removed`, leaked.length === 0, `${JSON.stringify(d)} still has ${leaked.join(', ')}`);
    }
    // Dumb cross-check: the chain is needed — scrubSecrets + scrubPaths alone leak the hex token.
    const alone = scrubPaths(scrubSecrets(`https://${HEX40}@github.com/o/r`));
    ok('cross-check: scrubSecrets+scrubPaths alone DO leak a classic 40-hex token (so the URL strip is needed)', alone.includes(HEX40), alone);
    // Cap after scrub: a token straddling the 600-character boundary.
    const long = 'x'.repeat(UE.DETAIL_MAX_CHARS - 10) + ' ghp_thisisasecretpatdonotleak1234abcdABCD tail';
    const capped = sanitizeDetail(long);
    ok('cap: detail is at most DETAIL_MAX_CHARS', capped.length <= UE.DETAIL_MAX_CHARS, String(capped.length));
    ok('cap: no partial token survives a cut at the boundary', !/ghp_|thisisas/.test(capped), capped.slice(-40));
    ok('cap: a long detail is visibly cut', capped.endsWith('…'));
    // A real error whose message carries a token: detail is clean, the sentence never echoes it.
    const u = toUserError(new Error(`Command failed: git push https://${HEX40}@github.com/o/r.git\nfatal: x`), { area: 'sync' });
    ok('toUserError: detail of a git error with a token URL is clean', u && !u.detail.includes(HEX40), u && u.detail);
    ok('toUserError: the stack never reaches detail', (() => { const e = new TypeError('x is not a function'); const v = toUserError(e); return v && !v.detail.includes(' at ') && !v.detail.includes(ROOT); })());
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§6 — userErrorBody');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const plain = { error: 'Unknown domain: zzz' };
    ok('a deliberate body comes back as the SAME object', userErrorBody(plain) === plain);
    const withDetail = { error: "ENOENT: no such file or directory, open '/x/y.md'", detail: 'already explained' };
    ok('a body that already has detail is never re-translated (same object)', userErrorBody(withDetail) === withDetail);
    const raw = { ok: false, error: "EACCES: permission denied, open '/x/index.md'", reason: 'r' };
    const t = userErrorBody(raw);
    ok('a raw body becomes a NEW object', t !== raw);
    ok('...with the plain sentence', t.error.startsWith("This computer didn't let The Curator use a file it needs (index.md)."), t.error);
    eq('...the original as detail', t.detail, "EACCES: permission denied, open '.../index.md'");
    eq('...a code added when absent', t.code, 'files-not-allowed');
    eq('...other fields kept', `${t.ok}|${t.reason}`, 'false|r');
    eq('...and the input is untouched', raw.error, "EACCES: permission denied, open '/x/index.md'");
    const coded = { error: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', code: 'NO_PROVIDER' };
    eq('an existing code is never replaced', userErrorBody(coded).code, 'NO_PROVIDER');
    const arr = [{ error: "ENOENT: no such file or directory, open 'x'" }];
    ok('an array body is returned unchanged', userErrorBody(arr) === arr);
    for (const s of ['Failed to fetch', 'Request failed (500)', "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"]) {
      const b = { error: s };
      ok(`a client-side class is not applied on the server: ${s}`, userErrorBody(b) === b);
      ok(`...but the browser can classify it: ${s}`, CLIENT_KLASSES.includes(classifyErrorText(s)?.klass));
    }
    const nonString = { error: { message: 'x' } };
    ok('a non-string error is left alone', userErrorBody(nonString) === nonString);
    eq('userErrorText: a miss falls back to the scrubbed message', userErrorText(new Error("Could not read '/Users/alice smith/x.md'")), "Could not read '.../x.md'");
    eq('userErrorText: an explicit fallback wins on a miss', userErrorText(new Error('Plain words.'), 'Fallback.'), 'Fallback.');
    ok('userErrorText: a hit is the plain sentence', userErrorText(new Error('Connection error.'), 'Fallback.').startsWith("The Curator couldn't reach"));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§7 — one table: the server re-exports the browser module');
  // ═══════════════════════════════════════════════════════════════════════
  ok('classifyErrorText is the same function on both sides', UE.classifyErrorText === SHARED.classifyErrorText);
  ok('USER_MESSAGES is the same object on both sides', UE.USER_MESSAGES === SHARED.USER_MESSAGES);
  ok('every klass has a code', Object.keys(USER_MESSAGES).every((k) => typeof KLASS_CODES[k] === 'string' && /^[a-z0-9-]+$/.test(KLASS_CODES[k])));
  ok('every client klass has a message', CLIENT_KLASSES.every((k) => typeof USER_MESSAGES[k] === 'function'));
  ok('the shared module imports nothing (it is served to the browser as-is)', !/^\s*import\s/m.test(readFileSync(path.join(ROOT, 'src/public/next/shared/user-errors.js'), 'utf8')));

  // ═══════════════════════════════════════════════════════════════════════
  section('§8 — every control a sentence names exists');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const front = walk(path.join(ROOT, 'src/public/next')).filter((f) => !f.endsWith('user-errors.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const all = Object.entries(USER_MESSAGES).map(([k, fn]) => [k, fn({ area: k === 'git-other' ? 'sync' : undefined })]);
    // Wave 3: the per-surface overrides are sentences a person reads too.
    for (const [area, bySurface] of Object.entries(SHARED.SURFACE_MESSAGES || {})) {
      for (const [surface, byKlass] of Object.entries(bySurface)) {
        for (const [k, fn] of Object.entries(byKlass)) all.push([`${area}/${surface}/${k}`, fn({ area, surface })]);
      }
    }
    // v3.99.2 audit: ai-too-long's next step follows the surface.
    for (const surface of ['ingest', 'chat', 'compile', 'health']) all.push([`ai-too-long/${surface}`, USER_MESSAGES['ai-too-long']({ area: 'ai', surface })]);
    const CONTROLS = [
      [/Settings › Providers & keys/, "'Providers & keys'"],
      [/Replace key/, "'Replace key'"],
      [/Settings › Knowledge base/, "'Knowledge base'"],
      [/Run system check/, "'Run system check'"],
      [/Settings › General/, "'General'"],
      [/Try Sync now again/, 'Sync now'],
      [/Add key/, "'Add key'"],
      [/New chat/, ' New chat</button>'],
      [/Compile to Wiki/, "'Compile to Wiki'"],
      // v3.99.2: Shared Brain's Replace token, on the connection's card.
      [/Replace token/, 'data-sb-action="token-replace-open">Replace token'],
    ];
    for (const [re, needle] of CONTROLS) {
      const users = all.filter(([, s]) => re.test(s)).map(([k]) => k);
      ok(`"${needle}" (named by ${users.join(', ') || 'nothing'}) exists in src/public/next`, users.length > 0 && front.includes(needle));
    }
    const named = all.map(([, s]) => s).join(' ');
    ok('no sentence names "Restart now" (it only shows when an update is waiting)', !/Restart now/.test(named));
    // v3.99.2: "Replace token" is named only by the Shared Brain token sentences,
    // whose control is the card's (Sync's has its own sentences, in sync.js).
    ok('only github-token-rejected names Replace token', all.filter(([, s]) => /Replace token/.test(s)).every(([k]) => /github-token-rejected$/.test(k)));
    for (const [k, s] of all) {
      ok(`${k}: plain words (no errno, HTTP code, or stack)`, !RAW_IN_ERROR.test(s) && !/\bstderr\b|\bHEAD\b|\bENOENT\b|\bref\b/.test(s), s);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§9 — toUserError never touches the error');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const e = await caught(() => readFile(path.join(tmp, 'nope.md')));
    const before = JSON.stringify({ m: e.message, k: Object.keys(e), c: e.code });
    toUserError(e); userErrorText(e); userErrorBody({ error: e.message });
    eq('err.message, its keys and code are unchanged', JSON.stringify({ m: e.message, k: Object.keys(e), c: e.code }), before);
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    eq('an AbortError is not translated', toUserError(abort), null);
    eq('a ⚠ message is not translated', toUserError(new Error('⚠ Rate limit hit on Gemini (HTTP 429).')), null);
    const gone = Object.assign(new Error('Gemini no longer offers `x` — pick another model in Settings.'), { curatorModelGone: true });
    eq('a model-gone error is not translated', toUserError(gone), null);
    const transient = Object.assign(new Error('503 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { curatorTransient: 'service_unavailable' });
    eq('a curatorTransient error is not translated', toUserError(transient), null);
    eq('a deliberate Error is not translated', toUserError(new Error('Domain "x" not found')), null);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§10 — the server module writes nothing to stdout');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const script = `
      const UE = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/brain/user-errors.js')).href)});
      const e = Object.assign(new Error("ENOENT: no such file or directory, open '/x/y'"), { code: 'ENOENT', syscall: 'open', path: '/x/y' });
      UE.toUserError(e); UE.userErrorText(e); UE.userErrorBody({ error: e.message }); UE.sanitizeDetail(e.message);
      const res = { json(b) { return b; }, status() { return this; } };
      UE.userErrorBodies({ method: 'GET', originalUrl: '/api/wiki/x' }, res, () => {});
      res.json({ error: e.message });
      UE.apiErrorHandler(Object.assign(new SyntaxError('bad'), { type: 'entity.parse.failed', status: 400 }), { method: 'POST', originalUrl: '/api/x' }, { headersSent: false, status() { return this; }, json() {} }, () => {});
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, CURATOR_TEST_LOG_DIR: path.join(tmp, 'logs'), CURATOR_TEST_USER_DATA_DIR: path.join(tmp, 'ud') },
    });
    eq('the child exited cleanly', r.status, 0);
    eq('stdout is empty', r.stdout, '');
    ok('...and the error was logged to the file instead', (() => { try { return readFileSync(path.join(tmp, 'logs', 'curator.log'), 'utf8').includes('files-missing'); } catch { return false; } })(), r.stderr);
  }
  // ═══════════════════════════════════════════════════════════════════════
  section('§11 — v3.99.2 audit: an fs error inside a deliberate sentence');
  // ═══════════════════════════════════════════════════════════════════════
  {
    // The measured case: the generic files sentence ("…Then try again.")
    // replaced a sentence that said the reply was CHARGED, so a person paid twice.
    const FS = "EACCES: permission denied, open '/Users/alice/brain/domains/work/wiki/entities/acme.md'";
    const charged = `The AI's reply was received (and charged), but not one of its 3 page(s) could be saved: ${FS}. Nothing else was changed.`;
    const u = toUserError(new Error(charged), { area: 'ai' });
    eq('the charged sentence is kept word for word, the raw text swapped for a plain clause', u && u.error,
      "The AI's reply was received (and charged), but not one of its 3 page(s) could be saved: this computer didn't allow access to acme.md. Nothing else was changed.");
    eq('...its detail is the raw fragment alone, scrubbed', u && u.detail, "EACCES: permission denied, open '.../acme.md'");
    eq('...with the files code', u && u.code, 'files-not-allowed');
    const body = userErrorBody({ error: charged });
    ok('...and the same through userErrorBody', body.error === u.error);
    // Two fragments in one sentence: both become clauses.
    const two = toUserError(`Could not write a.md: ${FS}. Then ENOSPC: no space left on device, write. Nothing was changed.`);
    ok('two raw fragments in one sentence both become clauses', two && !/E[A-Z]{3,}:/.test(two.error) && two.error.includes('Nothing was changed.') && /the disk is full/.test(two.error), two && two.error);
    // A bare fs text is still the class's own sentence.
    eq('the fs text alone is still the class sentence', toUserError(FS).error, USER_MESSAGES['files-not-allowed']({ name: 'acme.md' }));
    // A capitalised lead with nothing after: kept, ':' becomes '.'.
    eq('a prose lead with nothing after is kept before the class sentence', toUserError(`Could not read your saved API keys: ${FS}`).error,
      `Could not read your saved API keys. ${USER_MESSAGES['files-not-allowed']({ name: 'acme.md' })}`);
    // A programmer's label is still dropped.
    eq('a lower-case label is dropped, as before', toUserError(`pushDomain: ${FS}`).error, USER_MESSAGES['files-not-allowed']({ name: 'acme.md' }));
    // An fs error OBJECT whose message is a deliberate sentence: the sentence wins over the structural hit.
    const obj = Object.assign(new Error(`The document was written but the manifest was not: ${FS}. It is an orphan file until the next save.`), { code: 'EACCES', syscall: 'open', path: '/x/acme.md' });
    ok('an fs error object with a deliberate message keeps "was written but" and "orphan"', /was written but/.test(toUserError(obj).error) && /orphan/.test(toUserError(obj).error), toUserError(obj).error);

    // The census variant: a REAL fs error substituted into EVERY template in
    // src/brain and src/routes; the visible sentence keeps every money/state word.
    const FS_VALUES = [
      FS,
      'ENOSPC: no space left on device, write',
      "ENOENT: no such file or directory, open '/Users/alice/brain/wiki/log.md'",
      "EPERM: operation not permitted, unlink '/Users/alice/brain/wiki/x.md'",
    ];
    const WORDS = ['charged', 'Nothing was', 'nothing was', 'orphan', 'was written but', 'not charged', 'was received'];
    const tpls = literals.filter((l) => l.text.includes('X') && /\s/.test(l.text) && /^src\/(?:brain|routes)\//.test(l.file.split(path.sep).join('/')));
    const census = () => {
      const bad = [];
      let checked = 0;
      for (const t of tpls) {
        const words = WORDS.filter((w) => t.text.includes(w));
        if (!words.length) continue;
        // An X that is only ever a quoted NAME ("rescue orphans in \"X\"") is a
        // domain or page name, never where an error's text goes.
        if (!t.text.replace(/["'`]X["'`]/g, '').includes('X')) continue;
        for (const v of FS_VALUES) {
          const text = t.text.split('X').join(v);
          const r = toUserError(new Error(text));
          const visible = r ? r.error : text;
          if (r) checked++;
          const lost = words.filter((w) => !visible.includes(w));
          if (lost.length || (r && /\bE[A-Z]{3,}: /.test(visible))) bad.push(`${t.file}:${t.line} lost ${lost.join('|') || 'nothing (raw left)'}: ${JSON.stringify(visible.slice(0, 110))}`);
        }
      }
      return { bad, checked };
    };
    const c0 = census();
    ok(`fs census: the census translates money/state templates (${c0.checked} renders)`, c0.checked >= 20, String(c0.checked));
    ok(`fs census: 0 renders lose a money/state word or leave raw fs text (${tpls.length} templates × ${FS_VALUES.length} values)`, c0.bad.length === 0, c0.bad.slice(0, 8).join('\n      '));
    // MUTATION: the pre-audit fs builder (no whole/lead) must turn the census red.
    const SIG = SHARED.__SIGNATURES;
    const i = SIG.findIndex(([re]) => re.source.includes('(E[A-Z]{2,}): '));
    ok('mutation: found the fs signature', i >= 0);
    const saved = SIG[i];
    SIG[i] = [new RegExp(saved[0].source.replace('[a-z ,-]', '[a-z ,]')), (m) => {
      const klass = SHARED.FS_ERRNO_KLASS[m[1]];
      return klass ? { klass, name: SHARED.basenameOf(m[4]) || undefined } : null;
    }];
    const cm = census();
    SIG[i] = saved;
    ok(`mutation: the pre-audit fs builder turns the fs census red (${cm.bad.length} renders lose a word)`, cm.bad.length > 0);
    eq('restored: the fs census is green again', census().bad.length, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§12 — v3.99.2 audit: every fs code from its REAL Node text');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const map = (await import('node:util')).getSystemErrorMap();
    const desc = (code) => { for (const [, [n, d]] of map) if (n === code) return d; return null; };
    let n = 0;
    for (const [code, klass] of Object.entries(SHARED.FS_ERRNO_KLASS)) {
      const d = desc(code);
      if (!d) continue; // EDQUOT/EDEADLK: libuv has no text on this platform
      const text = `${code}: ${d}, open '/Volumes/x/a.md'`;
      n++;
      eq(`${code} ("${d}") → ${klass}`, classifyErrorText(text)?.klass, klass);
    }
    ok(`checked the real texts (${n})`, n >= 12);
    eq('EROFS: read-only file system (the hyphen) is reachable', toUserError(new Error("EROFS: read-only file system, open '/Volumes/x/a.md'"))?.code, 'files-read-only-disk');
    // Real errors, produced by Node itself.
    const realCases = [
      [() => readFile(path.join(tmp, 'absent', 'x.md')), 'files-missing'],
      [() => mkdir(tmp), 'files-exists'],
      [() => readFile(tmp), 'files-wrong-kind'],
      [() => readFile(path.join(tmp, 'x'.repeat(300))), 'files-name-too-long'],
    ];
    for (const [fn, klass] of realCases) {
      const e = await caught(fn);
      eq(`a real ${e && e.code} error → ${klass}`, toUserError(e)?.code, klass);
      eq(`...and by its text alone`, classifyErrorText(e && e.message)?.klass, klass);
    }
    // A missing PROGRAM is not a missing file of the person's.
    const sp = Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT', syscall: 'spawn osascript', path: 'osascript', errno: -2 });
    const su = toUserError(sp);
    eq('spawn ENOENT is internal-error, not files-missing', su && su.code, 'internal-error');
    ok('...and never names iCloud or Knowledge base', su && !/iCloud|Knowledge base/.test(su.error));
    const real = await caught(() => new Promise((res, rej) => { const c = spawn('curator-no-such-program-xyz'); c.on('error', rej); c.on('exit', res); }));
    eq('a REAL spawn failure is internal-error', toUserError(real)?.code, 'internal-error');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§13 — v3.99.2 audit: user text after a label is never classified');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const RAW = ['fetch failed', 'Request timed out.', 'Connection error.', 'x is not a function', "ENOENT: no such file or directory, open 'notes.md'", 'Command failed: git push'];
    const LABELS = ['Unknown domain: X', 'Page not found: X', 'Source page not found: X', 'Orphan page not found: X'];
    for (const l of LABELS) ok(`census sees the label "${l}"`, literals.some((t) => t.text === l || t.text.startsWith(l.replace('X', ''))), l);
    const echo = () => LABELS.flatMap((l) => RAW.map((r) => l.replace('X', r))).filter((t) => classifyErrorText(t));
    eq('a person\'s text after "Unknown domain: " / "Page not found: " is never classified', echo().length, 0);
    const b = { error: 'Unknown domain: fetch failed' };
    ok('GET /api/wiki/fetch%20failed: the 404 body comes back unchanged', userErrorBody(b, { area: 'wiki' }) === b);
    ok('...a real "Could not reach GitHub: fetch failed" is still classified', classifyErrorText('Could not reach GitHub: fetch failed')?.klass === 'network-unreachable');
    // MUTATION: without the echo guard the census is red.
    const re = SHARED.__USER_ECHO_RE;
    const src = re.source;
    re.compile('^(?!)');
    const m = echo().length;
    re.compile(src);
    ok(`mutation: without the echo guard ${m} user texts are classified`, m > 0);
    eq('restored', echo().length, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§14 — v3.99.2 audit: wording true on the screen it lands on');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const long = '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}';
    const by = (surface) => toUserError(long, { area: 'ai', ...(surface ? { surface } : {}) }).error;
    ok('ai-too-long in ingest: split the source', /split the source into smaller files/.test(by('ingest')));
    ok('ai-too-long in chat: New chat, never "split the source"', /New chat/.test(by('chat')) && !/split the source/.test(by('chat')));
    ok('ai-too-long in compile: Compile to Wiki, never "split the source"', /Compile to Wiki/.test(by('compile')) && !/split the source/.test(by('compile')));
    ok('ai-too-long with no surface (Health): only the model step', !/split the source|New chat|Compile/.test(by()) && /Providers & keys/.test(by()));
    ok('every ai-too-long wording still says not charged', ['ingest', 'chat', 'compile', undefined].every((s) => /not charged/.test(by(s))));
    // The middleware reads the surface from the path.
    eq('surfaceFromPath /api/chat/x', UE.surfaceFromPath('/api/chat/x'), 'chat');
    eq('surfaceFromPath /api/ingest-queue/x', UE.surfaceFromPath('/api/ingest-queue/x'), 'ingest');
    eq('surfaceFromPath /api/compile/x', UE.surfaceFromPath('/api/compile/x'), 'compile');
    eq('surfaceFromPath /api/health/x', UE.surfaceFromPath('/api/health/x'), undefined);
    {
      let sent = null;
      const res = { json(b) { sent = b; return b; } };
      UE.userErrorBodies({ method: 'POST', originalUrl: '/api/chat/work' }, res, () => {});
      res.json({ error: long });
      ok('the middleware on /api/chat words ai-too-long for chat', sent && /New chat/.test(sent.error), sent && sent.error);
    }
    // Replace key / Add key: both labels of the one button.
    ok('ai-key-rejected names both labels of the key button', /Replace key \(or Add key\)/.test(USER_MESSAGES['ai-key-rejected']()));
    // Not the provider's health: no "Try again in a few minutes".
    const NOT = [
      'LLM call failed: [GoogleGenerativeAI Error]: Candidate was blocked due to SAFETY',
      '[GoogleGenerativeAI Error]: Text not available. Response was blocked due to RECITATION',
      'LLM call failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 64000 > 8192, which is the maximum allowed"}}',
      'OpenRouter chat → HTTP 400: {"error":{"message":"max_tokens is too large"}}',
    ];
    for (const t of NOT) eq(`not classified: ${t.slice(0, 70)}`, toUserError(t), null);
    // …while a real overload is still classified.
    eq('a real Gemini 503 is still classified', toUserError('[GoogleGenerativeAI Error]: Error fetching from https://x/y: [503 Service Unavailable] overloaded')?.code, 'ai-overloaded');
    eq('an Anthropic 400 without an output limit is still classified', toUserError('400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: bad"}}')?.code, 'ai-provider-error');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§15 — v3.99.2 audit: sanitizeDetail closes the remaining shapes');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const HEX40 = '0123456789abcdef0123456789abcdef01234567';
    const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const CASES = [
      ['ESM stack frame', 'TypeError: x\n    at foo (file:///Users/alice/second-brain/src/brain/x.js:10:5)', ['alice', 'file://']],
      ['file:// URL', 'file:///Users/alice/brain/x.md failed', ['alice']],
      ['path after a colon', 'path:/Users/alice/brain/x.md', ['alice']],
      ['non-home path after a colon', 'path:/Volumes/Alice Backup/brain/x.md', ['Volumes', 'Alice']],
      ['UNC share', '\\\\server\\share\\Alice\\x.md', ['server', 'Alice']],
      ['ssh:// userinfo', `ssh://${HEX40}@github.com/u/r`, [HEX40]],
      ['git+https userinfo', `git+https://${GHP}@github.com/u/r`, [GHP]],
      ['percent-encoded @', `https://${HEX40}%40github.com/u/r`, [HEX40]],
      ['token@host with no scheme', `could not read Password for '${HEX40}@github.com'`, [HEX40]],
      ['bare 40-hex', `token ${HEX40} rejected`, [HEX40]],
      ['Authorization: token', `Authorization: token ${HEX40}`, [HEX40]],
      ['Authorization: Basic', 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Njc4OQ==', ['dXNlcjpw']],
      ['x-api-key header', 'x-api-key: sk-ant-api03-short', ['sk-ant']],
      ['a long Gemini key', `key ${['AI', 'za'].join('')}SyA1234567890abcdefghijklmnopqrstuvw bad`, ['AIza', 'uvw']],
      ['home with spaces, quoted', "ENOENT: no such file or directory, open '/Users/alice smith/My Brain/wiki/log.md'", ['alice', 'smith']],
      ['home with spaces, unquoted', 'open /Users/alice smith/Google Drive/x.md now', ['alice', 'smith']],
      ['a home folder alone', 'HOME=/Users/alice', ['alice']],
      ['a Windows home with spaces', 'C:\\Users\\Alice Smith\\brain\\x.md', ['Alice', 'Smith']],
    ];
    const run = () => CASES.filter(([, t, f]) => { const d = sanitizeDetail(t); return f.some((x) => d.includes(x)); }).map(([l, t]) => `${l}: ${JSON.stringify(sanitizeDetail(t))}`);
    const leaks = run();
    ok(`sanitizeDetail: 0 of ${CASES.length} shapes leak`, leaks.length === 0, leaks.join('\n      '));
    // Cap after scrubbing, still.
    const long = 'x'.repeat(UE.DETAIL_MAX_CHARS - 5) + ` Authorization: token ${HEX40}`;
    const capped = sanitizeDetail(long);
    ok('cap after scrub: no partial token at the boundary', capped.length <= UE.DETAIL_MAX_CHARS && !/0123456789abcdef/.test(capped), capped.slice(-30));
    // A readable detail stays readable.
    eq('a plain detail is unchanged', sanitizeDetail('Unexpected end of JSON input'), 'Unexpected end of JSON input');
    // MUTATION: without the shared scrubs, the census leaks.

    ok('the shared scrub is what the server uses (dumb cross-check: credentials alone)', !SHARED.scrubCredentials(`ssh://${HEX40}@x.com`).includes(HEX40));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§16 — v3.99.2 second audit: a kept sentence reads right on BOTH paths');
  // ═══════════════════════════════════════════════════════════════════════
  {
    // Both the server (toUserError) and the browser (classify + compose, which
    // has no scrubPaths) must give a sentence a person can read.
    const both = (text) => {
      const srv = toUserError(new Error(text));
      const hit = classifyErrorText(text);
      return { srv: srv && srv.error, det: srv && srv.detail, brw: hit ? SHARED.composeUserMessage(hit) : null };
    };
    // 1. A file name is never capitalised at the start of a sentence.
    for (const [label, text, want] of [
      ['ENOENT first', "ENOENT: no such file or directory, open '/Users/a/wiki/acme.md' while reading the wiki", /^The file acme\.md couldn't be found while reading the wiki/],
      ['EMFILE first', "EMFILE: too many open files, open '/Users/a/b.md'. Try again.", /^The file b\.md was busy or still downloading\. Try again\./],
      ['EEXIST after a full stop', "Could not create it. EEXIST: file already exists, mkdir '/Users/a/wiki/acme'. Choose another name.", /Could not create it\. Something called acme already exists\./],
      ['ENOTDIR first', "ENOTDIR: not a directory, scandir '/Users/a/wiki/entities'. The domain folder is damaged.", /^The name entities was a file where/],
    ]) {
      const r = both(text);
      ok(`${label}: server sentence keeps the name lower-case`, want.test(r.srv || ''), r.srv);
      ok(`${label}: browser sentence is the same`, r.brw === r.srv, r.brw);
      ok(`${label}: no capitalised file name anywhere`, !/\b(?:Acme|B)\.md\b|\bAcme\b|\bEntities\b/.test(`${r.srv} ${r.brw}`), `${r.srv} | ${r.brw}`);
    }
    // 2. Machine text glued on after the fragment goes to the detail; a bare
    //    "Error:" label is dropped; no home path in the visible sentence.
    {
      const r = both("Saving failed: EACCES: permission denied, open '/x/a.md'. Nothing was changed. Caused by: TypeError: x is not a function at foo (/Users/alice/app/src/x.js:10:5)");
      for (const [side, s] of [['server', r.srv], ['browser', r.brw]]) {
        ok(`Caused by tail, ${side}: the sentence stops before it`, s === "Saving failed: this computer didn't allow access to a.md. Nothing was changed.", s);
      }
      ok('Caused by tail: the detail keeps it, scrubbed', /Caused by: TypeError/.test(r.det || '') && !/alice/.test(r.det || ''), r.det);
      const only = both("Saving failed: EACCES: permission denied, open '/x/a.md'. Caused by: TypeError: x is not a function at foo (/Users/alice/app/src/x.js:10:5)");
      ok('tail and no other words: the class sentence on both sides', only.srv === USER_MESSAGES['files-not-allowed']({ name: 'a.md' }) && only.brw === only.srv, only);
      const lbl = both("Error: EACCES: permission denied, open '/Users/a/b.md' (retry 3 of 3 failed)");
      ok('a leading "Error:" label is dropped on both sides', !/^Error:/.test(lbl.srv || '') && !/^Error:/.test(lbl.brw || '') && /^This computer didn't allow access to b\.md/.test(lbl.brw || ''), lbl);
      const frame = both("Could not save it: EACCES: permission denied, open '/x/a.md' at Object.openSync (node:fs:581:18) and more");
      ok('a stack frame on the same line is cut on both sides', !/openSync|node:fs/.test(`${frame.srv} ${frame.brw}`), frame);
      // CONTROL: "at" in prose is not a stack frame.
      const prose = both("Health could not undo (EPERM: operation not permitted, unlink '/Users/a/.Trash/x.md'); the copy is at /Users/alice/Library/Application Support/the-curator/health-undo/123.");
      ok('CONTROL: "the copy is at <path>" stays (prose), path shortened', /the copy is at \.\.\.\/123\.$/.test(prose.brw || '') && prose.brw === prose.srv, prose);
      // CONTROL: "at <Word> (" in prose is not a stack frame either.
      const look = both("Error: ENOENT: no such file or directory, open '/Users/a/wiki/acme.md'. Look at Settings (General) for the folder.");
      ok('CONTROL: "Look at Settings (General)" stays', look.brw === "The file acme.md couldn't be found. Look at Settings (General) for the folder." && look.srv === look.brw, look);
      // A lead before a non-fs raw tail: no home path on the browser either.
      const netLead = both('Could not reach the service for /Users/alice/brain/keys.json. fetch failed');
      ok('a lead before "fetch failed": the browser shows no home path', netLead.brw && /^Could not reach the service for \.\.\.\/keys\.json\./.test(netLead.brw) && !/alice/.test(netLead.brw), netLead);
      // The browser never shows a home path, in a lead or a kept sentence.
      const H = '/Users/alice smith/Library/Application Support/Claude';
      for (const text of [
        `Could not read ${H}/claude_desktop_config.json: ENOENT: no such file or directory, open '${H}/claude_desktop_config.json'`,
        "The file /Users/alice/brain/x.md could not be saved: ENOSPC: no space left on device, write",
        "Could not write to the folder /Users/alice/brain/domains/work (EACCES: permission denied, mkdir '/Users/alice/brain/domains/work/wiki'). Pick another folder.",
        prose && "Health could not undo (EPERM: operation not permitted, unlink '/Users/a/.Trash/x.md'); the copy is at /Users/alice/Library/x/123.",
      ]) {
        const r2 = both(text);
        ok(`browser: no home path in "${text.slice(0, 40)}…"`, r2.brw && !/\/Users\/|alice/.test(r2.brw), r2.brw);
        ok(`server: same sentence for "${text.slice(0, 40)}…"`, r2.srv === r2.brw, `${r2.srv} | ${r2.brw}`);
      }
    }
    // 3. The next step inside a kept sentence matches the fs class.
    {
      const ING = (fs) => `The AI's reply was received (and charged), but not one of its 3 page(s) could be saved: ${fs}. Check that the domain's wiki folder is writable, then ingest the source again.`;
      const full = both(ING('ENOSPC: no space left on device, write'));
      ok('disk full inside the charged sentence: "free space", never "writable"', /\(and charged\)/.test(full.srv || '') && /Free some space/.test(full.srv || '') && !/writable/.test(full.srv || '') && full.brw === full.srv, full);
      const missing = both(ING("ENOENT: no such file or directory, open '/Users/a/w/acme.md'"));
      ok('missing inside the charged sentence: "still there", never "writable"', /still there/.test(missing.srv || '') && !/writable/.test(missing.srv || ''), missing.srv);
      const denied = both(ING("EACCES: permission denied, open '/Users/a/w/acme.md'"));
      ok('CONTROL: permission denied keeps "writable" (it fits)', /wiki folder is writable/.test(denied.srv || '') && denied.brw === denied.srv, denied.srv);
      const ro = both(ING("EROFS: read-only file system, open '/Volumes/x/acme.md'"));
      ok('CONTROL: a read-only disk keeps "writable" (it fits)', /wiki folder is writable/.test(ro.srv || ''), ro.srv);
    }
  }
} finally {
  for (const r of hang.splice(0)) { try { r.destroy(); } catch { /* gone */ } }
  stub.close();
  try { chmodSync(path.join(tmp, 'locked'), 0o700); } catch { /* absent */ }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
