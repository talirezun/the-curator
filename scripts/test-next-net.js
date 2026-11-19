#!/usr/bin/env node
/**
 * test-next-net.js — the frontend half of plain-language errors (v3.99.2).
 *
 * shared/net.js, executed in Node with a stub fetch:
 *   §1  installFetchTranslation: a real network TypeError (a fetch to a closed
 *       port, through Node's own fetch) becomes the server-unreachable sentence
 *       with `.cause` kept; an AbortError comes back as the SAME object (chat's
 *       cancel depends on it); a rejection while the signal is aborted is
 *       untouched; a non-network TypeError and another origin are untouched;
 *       a Response passes through as the same object; installing twice is a no-op;
 *       `this` is always the target (window.fetch throws "Illegal invocation").
 *   §2  userMessageFrom over every input shape: a server body with detail is
 *       kept, an older server's raw text is translated, a deliberate sentence
 *       passes UNCHANGED, an existing code is never replaced, a real HTML
 *       response's res.json() SyntaxError → server-outdated, a real empty body
 *       → request-failed, null with a status, an Error carrying detail/code.
 *   §3  renderUserError / renderErrorDetail / renderStatus: escaping, the
 *       prefix, both lines visible, renderStatus byte-identical without
 *       `support`, and net.js's escapeHtml agreeing with app.js's.
 *   §4  app.js installs it at boot (an executed check, not a line scan:
 *       boot() is lifted out and run against a stub window).
 *
 * OFFLINE. No browser, no user data. The only socket is a fetch to a closed
 * port on 127.0.0.1.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installFetchTranslation, translateFetchRejection, userMessageFrom, userErrorText,
  errorFromResponse, renderUserError, renderErrorDetail, DETAIL_PREFIX, cleanDetail,
  plainError, errorDetailOf, errorDetailHtml, rememberErrorDetail, loudWithDetail,
} from '../src/public/next/shared/net.js';
import { USER_MESSAGES } from '../src/public/next/shared/user-errors.js';
import { renderStatus } from '../src/public/next/shared/text.js';
import { stripComments, functionSource } from './test-helpers/source-scan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++; console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 400)));
  return false;
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

const UNREACHABLE = USER_MESSAGES['server-unreachable']();
const OUTDATED = USER_MESSAGES['server-outdated']();
const GENERIC = USER_MESSAGES['request-failed']();

// A stub window: a fetch that does whatever the case says, and an origin.
function stubWindow(impl, origin = 'http://127.0.0.1:3333') {
  const w = { location: { origin }, calls: [] };
  w.fetch = function (input, init) { w.calls.push({ self: this, input, init }); return impl(input, init); };
  return w;
}
async function rejection(p) { try { await p; return null; } catch (e) { return e; } }

// ═════════════════════════════════════════════════════════════════════════
section('§1 installFetchTranslation');
{
  // A REAL network TypeError: Node's own fetch to a port nothing listens on.
  const srv = createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port; await new Promise((r) => srv.close(r));
  const realErr = await rejection(globalThis.fetch('http://127.0.0.1:' + port + '/api/x'));
  ok(realErr instanceof TypeError, 'control: a fetch to a closed port really rejects with a TypeError', realErr && realErr.name);

  // Node says "fetch failed"; browsers say "Failed to fetch" / "Load failed" /
  // "NetworkError when attempting to fetch resource.". The browser texts are
  // what the wrapper must recognise (Node's is not a browser's, so it stays).
  for (const text of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'Failed to fetch (localhost)']) {
    const orig = new TypeError(text);
    const w = stubWindow(() => Promise.reject(orig));
    installFetchTranslation(w);
    const e = await rejection(w.fetch('/api/domains'));
    ok(e && e.message === UNREACHABLE && e.curatorNetwork === true && e.cause === orig && e.code === 'server-unreachable',
      `"${text}" → the server-unreachable sentence, .curatorNetwork, .cause kept`, e && e.message);
  }

  // A synchronous throw from fetch is treated the same way.
  {
    const w = stubWindow(() => { throw new TypeError('Failed to fetch'); });
    installFetchTranslation(w);
    const e = await rejection(w.fetch('/api/x'));
    ok(e && e.curatorNetwork === true, 'a synchronous TypeError throw is translated too');
  }

  // AbortError: the SAME object, never wrapped.
  {
    const abortErr = new DOMException('The user aborted a request.', 'AbortError');
    const w = stubWindow(() => Promise.reject(abortErr));
    installFetchTranslation(w);
    const e = await rejection(w.fetch('/api/chat', { signal: new AbortController().signal }));
    ok(e === abortErr, 'an AbortError comes back as the SAME object');
    ok(e && e.name === 'AbortError', 'and still says AbortError (chat cancel reads err.name)');
  }
  // A REAL abort through Node's fetch, wrapped.
  {
    const srv2 = createServer((req, res) => { setTimeout(() => res.end('{}'), 2000); });
    await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
    const w = { location: { origin: 'http://127.0.0.1:' + srv2.address().port }, fetch: globalThis.fetch };
    installFetchTranslation(w);
    const ac = new AbortController();
    const p = w.fetch('http://127.0.0.1:' + srv2.address().port + '/slow', { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const e = await rejection(p);
    ok(e && e.name === 'AbortError' && !e.curatorNetwork, 'a real aborted fetch rejects with the original AbortError', e && e.name);
    srv2.closeAllConnections && srv2.closeAllConnections(); await new Promise((r) => srv2.close(r));
  }
  // Any rejection while the signal is aborted passes untouched (even a TypeError).
  {
    const ac = new AbortController(); ac.abort();
    const t = new TypeError('Failed to fetch');
    const w = stubWindow(() => Promise.reject(t));
    installFetchTranslation(w);
    const e = await rejection(w.fetch('/api/x', { signal: ac.signal }));
    ok(e === t, 'a TypeError while the signal is aborted passes through untouched');
  }
  // A TimeoutError (AbortSignal.timeout) passes untouched.
  {
    const t = new DOMException('signal timed out', 'TimeoutError');
    const w = stubWindow(() => Promise.reject(t));
    installFetchTranslation(w);
    ok((await rejection(w.fetch('/api/x'))) === t, 'a TimeoutError passes through untouched');
  }
  // A non-network TypeError (a bug, a bad header) is not dressed as "not responding".
  {
    const t = new TypeError("Failed to execute 'fetch' on 'Window': Invalid name");
    const w = stubWindow(() => Promise.reject(t));
    installFetchTranslation(w);
    ok((await rejection(w.fetch('/api/x'))) === t, 'a non-network TypeError passes through untouched');
  }
  // Another origin: "The Curator isn't responding" would be wrong.
  {
    const t = new TypeError('Failed to fetch');
    const w = stubWindow(() => Promise.reject(t));
    installFetchTranslation(w);
    ok((await rejection(w.fetch('https://api.github.com/x'))) === t, 'a failed request to ANOTHER origin passes through untouched');
    const e2 = await rejection(w.fetch('http://127.0.0.1:3333/api/x'));
    ok(e2 && e2.curatorNetwork, 'an absolute URL on the SAME origin is translated');
    const e3 = await rejection(w.fetch(new URL('http://127.0.0.1:3333/api/y')));
    ok(e3 && e3.curatorNetwork, 'a URL object on the same origin is translated');
  }
  // A Response is the same object (streaming / SSE untouched).
  {
    const resp = new Response('data: x\n\n', { status: 200 });
    const w = stubWindow(() => Promise.resolve(resp));
    installFetchTranslation(w);
    ok((await w.fetch('/api/chat')) === resp, 'a Response resolves as the SAME object');
    const r500 = new Response('{"error":"x"}', { status: 500 });
    const w2 = stubWindow(() => Promise.resolve(r500));
    installFetchTranslation(w2);
    ok((await w2.fetch('/api/x')) === r500, 'a 500 Response is not turned into a rejection');
  }
  // Idempotent, and `this` is the target.
  {
    const w = stubWindow(() => Promise.resolve(new Response('')));
    ok(installFetchTranslation(w) === true, 'first install returns true');
    const once = w.fetch;
    ok(installFetchTranslation(w) === false && w.fetch === once, 'second install is a no-op (no double wrap)');
    await w.fetch.call(undefined, '/api/x');
    ok(w.calls[0].self === w, 'the original fetch is always called with the target as `this`');
    ok(installFetchTranslation({}) === false, 'no fetch → nothing installed, no throw');
  }
  // The exported translator, directly: non-errors pass.
  ok(translateFetchRejection('x', '/a') === 'x', 'a non-Error rejection value passes through');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 userMessageFrom');
{
  // A server body the server already translated: kept as sent.
  const body = { error: "GitHub didn't accept the access token for this Shared Brain.", detail: 'GitHub GET contents/x → 401: Bad credentials', code: 'github-token-rejected' };
  const u = userMessageFrom(body);
  ok(u.error === body.error && u.detail === body.detail && u.code === body.code, 'a translated body is returned as the server sent it');

  // An older server's raw text: translated, raw text kept as detail.
  const old = userMessageFrom({ error: "EACCES: permission denied, open '/Users/alice smith/Documents/vault/wiki/index.md'" });
  ok(old.code === 'files-not-allowed' && /didn't let The Curator use a file/.test(old.error), 'an older server\'s raw EACCES becomes the plain sentence', old.error);
  ok(old.detail.includes('EACCES') && !/\/Users\/alice/.test(old.detail), 'its raw text is the detail, with the home folder cleaned', old.detail);

  // Deliberate prose passes UNCHANGED (pass-through is the default).
  for (const s of [
    'Nothing was sent to the AI and nothing was charged. The folder "wiki" is a file.',
    'GitHub rejected the token. Replace it on this page.',
    '⚠ Rate limit hit — wait a minute.',
    'The server returned a response we could not read (HTTP 500).',
    'Domain not found',
  ]) {
    const r = userMessageFrom({ error: s });
    ok(r.error === s && r.detail === '' , 'deliberate sentence unchanged: ' + s.slice(0, 50), JSON.stringify(r));
  }
  // An existing code is never replaced.
  ok(userMessageFrom({ error: 'Failed to fetch', code: 'my-code' }).code === 'my-code', 'an existing code is never replaced (body)');
  const ec = new Error('Request failed (500)'); ec.code = 'keep-me';
  ok(userMessageFrom(ec).code === 'keep-me', 'an existing code is never replaced (Error)');

  // A REAL HTML response → res.json() → SyntaxError → server-outdated.
  {
    const res = new Response('<!DOCTYPE html><html><body>app</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    let err = null; try { await res.json(); } catch (e) { err = e; }
    ok(err instanceof SyntaxError, 'control: res.json() on an HTML page throws a SyntaxError', err && err.message);
    const r = userMessageFrom(err);
    ok(r.code === 'server-outdated' && r.error === OUTDATED, 'an HTML page parsed as JSON → server-outdated', r.error);
  }
  // Safari's wording of the same.
  ok(userMessageFrom(new SyntaxError("JSON Parse error: Unrecognized token '<'")).code === 'server-outdated', "Safari's HTML-as-JSON wording → server-outdated");
  ok(userMessageFrom(new SyntaxError('JSON Parse error: Unexpected EOF')).code === 'request-failed', "Safari's empty-body wording → request-failed");
  // A REAL empty body.
  {
    const res = new Response('', { status: 500 });
    let err = null; try { await res.json(); } catch (e) { err = e; }
    const r = userMessageFrom(err);
    ok(r.code === 'request-failed' && r.error === GENERIC, 'res.json() on an empty body → request-failed', err && err.message);
  }
  // The views' own fallbacks.
  for (const s of ['Request failed (500)', 'HTTP 404', '(HTTP 502)']) {
    const r = userMessageFrom(s);
    ok(r.error === GENERIC && r.detail === s, `"${s}" → request-failed, the raw text kept as detail`, JSON.stringify(r));
  }
  // null / empty body with a status.
  const n = userMessageFrom(null, { status: 503 });
  ok(n.error === GENERIC && n.detail === 'HTTP 503' && n.code === 'request-failed', 'null + status → request-failed with HTTP 503 as the detail', JSON.stringify(n));
  ok(userMessageFrom({}, { status: 500 }).detail === 'HTTP 500', 'a body with no error → request-failed with the status as detail');
  ok(userMessageFrom(undefined).error === GENERIC, 'undefined → request-failed');
  ok(userMessageFrom({ message: 'Project name already taken.' }).error === 'Project name already taken.', 'a `message`-keyed body is read');
  // The wrapper's network error.
  {
    const w = stubWindow(() => Promise.reject(new TypeError('Failed to fetch')));
    installFetchTranslation(w);
    const e = await rejection(w.fetch('/api/x'));
    const r = userMessageFrom(e);
    ok(r.error === UNREACHABLE && r.detail === '' && r.code === 'server-unreachable', 'the wrapper\'s error → the sentence, no detail');
    // A view that prefixes it: "Could not save: <sentence>" stays readable (the sentence is plain).
    ok(!/Failed to fetch/.test('Could not save: ' + e.message), 'a view prefixing err.message no longer shows "Failed to fetch"');
  }
  // A raw "Failed to fetch" that never went through the wrapper (old code path).
  ok(userMessageFrom(new TypeError('Failed to fetch')).error === UNREACHABLE, 'an unwrapped "Failed to fetch" is translated too');
  // An Error a view built from a body.
  {
    const res = { status: 401 };
    const e = errorFromResponse(res, { error: 'Plain words.', detail: 'raw 401', code: 'ai-key-rejected' });
    ok(e instanceof Error && e.message === 'Plain words.' && e.detail === 'raw 401' && e.code === 'ai-key-rejected' && e.status === 401, 'errorFromResponse keeps message, detail, code, status');
    const back = userMessageFrom(e);
    ok(back.error === 'Plain words.' && back.detail === 'raw 401' && back.code === 'ai-key-rejected', 'userMessageFrom(errorFromResponse(...)) round-trips');
    const e2 = errorFromResponse({ status: 500 }, null);
    ok(e2.message === GENERIC && e2.detail === 'HTTP 500', 'errorFromResponse with no body → request-failed + HTTP status');
  }
  ok(userErrorText({ error: 'HTTP 500' }) === GENERIC, 'userErrorText returns the sentence only');
  // A view's own fallback sentence, for a response with no message.
  {
    const e = errorFromResponse({ status: 502 }, {}, 'The invite token could not be re-generated.');
    ok(e.message === 'The invite token could not be re-generated.' && e.detail === 'HTTP 502', 'fallback: the view\'s sentence, the status as detail (never in the sentence)');
    const e2 = errorFromResponse({ status: 400 }, { error: 'Label is required.' }, 'unused');
    ok(e2.message === 'Label is required.' && !e2.detail, 'fallback: unused when the server sent a message');
    ok(userMessageFrom(null, { fallback: 'X failed.' }).error === 'X failed.', 'fallback with null');
  }
  // Detail cleaning.
  const cd = cleanDetail('git push https://x-access-token:ghp_FAKEFAKEFAKEFAKE@github.com/o/r and https://abcdef0123456789abcdef0123456789abcdef01@github.com /home/bob/a C:\\Users\\Bob\\b');
  ok(!/ghp_|abcdef0123456789|\/home\/bob|Users\\Bob/.test(cd), 'cleanDetail strips URL credentials and home folders', cd);
  ok(cleanDetail('x'.repeat(2000)).length === 600, 'cleanDetail caps at 600 characters');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 rendering');
{
  const html = renderUserError({ error: 'Plain <b>words</b>.', detail: 'raw <script>alert(1)</script> & "q"', code: 'x' });
  ok(html.includes('tx-status-danger'), 'a danger status box');
  ok(html.includes('<div class="tx-status-title">Plain &lt;b&gt;words&lt;/b&gt;.</div>'), 'the sentence is the title, escaped', html);
  ok(html.includes('<div class="tx-error-detail">Technical detail (for support): raw &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;</div>'), 'the detail is a visible, escaped, prefixed line', html);
  ok(!/<details|<summary|hidden/.test(html), 'nothing behind a chevron or hidden');
  const titled = renderUserError(new Error('Request failed (500)'), { title: 'Could not save the key' });
  ok(titled.includes('>Could not save the key<') && titled.includes('tx-status-detail">' + GENERIC.replace(/'/g, '&#39;')), 'with a title: the view\'s heading, then the sentence', titled);
  ok(titled.includes('Technical detail (for support): Request failed (500)'), 'and the raw text as the support line');
  const plain = renderUserError({ error: 'Domain not found' });
  ok(!plain.includes('tx-error-detail'), 'no detail → no detail line');
  ok(renderErrorDetail('') === '' && renderErrorDetail(null) === '', 'renderErrorDetail of nothing is the empty string');
  ok(renderErrorDetail('a<b') === '<div class="tx-error-detail">' + 'Technical detail (for support): a&lt;b</div>', 'renderErrorDetail escapes and prefixes');
  ok(DETAIL_PREFIX === 'Technical detail (for support): ', 'the prefix is the contract\'s');
  // renderStatus without support is byte-identical to the v3.99.1 markup.
  const before = '<div class="tx-status tx-status-danger" role="group"><div class="tx-status-title">T</div><div class="tx-status-detail">D</div></div>';
  ok(renderStatus({ state: 'danger', title: 'T', detail: 'D' }) === before, 'renderStatus without `support` is byte-identical to before');
  ok(renderStatus({ state: 'danger', title: 'T', support: '  ' }) === '<div class="tx-status tx-status-danger" role="group"><div class="tx-status-title">T</div></div>', 'a blank support adds nothing');

  // net.js's private escapeHtml must agree with app.js's (and text.js's).
  const app = readFileSync(join(ROOT, 'src/public/next/app.js'), 'utf8');
  const net = readFileSync(join(ROOT, 'src/public/next/shared/net.js'), 'utf8');
  const grab = (src) => { const m = /function escapeHtml\(s\) \{[\s\S]*?\n\}/.exec(src); return m && new Function('return ' + m[0])(); };
  const a = grab(app), b = grab(net);
  const corpus = ['', 'plain', '<>&"\'', '&amp;', null, undefined, 42, '<script>"x"</script>', "it's"];
  ok(a && b && corpus.every((s) => a(s) === b(s)), 'net.js escapeHtml agrees with app.js over a corpus');
  // CSS: the class exists in the shared kit stylesheet, and uses defined tokens only.
  const css = readFileSync(join(ROOT, 'src/public/next/shared/text.css'), 'utf8');
  const rule = /\.tx-error-detail \{([\s\S]*?)\}/.exec(css);
  ok(rule && /user-select: text/.test(rule[1]) && /--text-2/.test(rule[1]), '.tx-error-detail is muted and selectable in shared/text.css');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3b string-state helpers (plainError / errorDetailHtml / loudWithDetail)');
{
  const s = plainError({ error: "EPERM: operation not permitted, open '/Users/x/vault/wiki/a.md'" });
  ok(typeof s === 'string' && /didn't let The Curator use a file/.test(s), 'plainError returns the plain sentence as a string');
  ok(/EPERM/.test(errorDetailOf(s)) && /tx-error-detail/.test(errorDetailHtml(s)), '…and remembers its detail beside it');
  ok(errorDetailHtml('A different sentence.') === '', 'a different message never inherits a detail');
  ok(errorDetailHtml(null) === '' && errorDetailHtml(undefined) === '', 'nothing → nothing');
  const plainOnly = plainError({ error: 'Domain not found' });
  ok(plainOnly === 'Domain not found' && errorDetailHtml(plainOnly) === '', 'deliberate prose: unchanged, no detail');
  rememberErrorDetail('Error: ' + s, errorDetailOf(s));
  ok(errorDetailOf('Error: ' + s) === errorDetailOf(s), 'rememberErrorDetail binds a detail to a composed message');
  for (let i = 0; i < 60; i++) rememberErrorDetail('m' + i, 'd' + i);
  ok(errorDetailOf('m0') === '' && errorDetailOf('m59') === 'd59', 'bounded: the oldest entries go first');
  const loud = loudWithDetail({ tone: 'danger', text: plainError(new Error('Request failed (500)')) });
  ok(loud.length === 2 && loud[1].tone === 'quiet' && loud[1].text === DETAIL_PREFIX + 'Request failed (500) (code: request-failed)', 'loudWithDetail adds a quiet support entry below (wave 3: with its catalogue code)', JSON.stringify(loud));
  ok(loudWithDetail({ tone: 'quiet', text: 'Pushed 3 pages.' }).length === 1, '…and nothing for a message without a detail');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 app.js installs the hook at boot');
{
  const app = readFileSync(join(ROOT, 'src/public/next/app.js'), 'utf8');
  ok(/import \{[^}]*\binstallFetchTranslation\b[^}]*\} from '\.\/shared\/net\.js';/.test(app), 'app.js imports installFetchTranslation from shared/net.js');
  // Lift boot()'s first statement block up to the theme read and run it: the
  // call must be at the top of boot(), before anything can fetch.
  const start = app.indexOf('\nfunction boot() {');
  ok(start > 0, 'boot() found');
  const body = app.slice(start, start + 400);
  const firstStmt = body.split('\n').slice(2).find((l) => l.trim() && !l.trim().startsWith('//'));
  ok(firstStmt && /^\s*installFetchTranslation\(\);/.test(firstStmt), 'the FIRST statement of boot() is installFetchTranslation()', firstStmt);
  // Executed: run that statement against a stub window with the real function.
  const w = stubWindow(() => Promise.reject(new TypeError('Failed to fetch')));
  new Function('installFetchTranslation', 'globalThis', firstStmt.replace('installFetchTranslation()', 'installFetchTranslation(globalThis)'))(installFetchTranslation, w);
  const e = await rejection(w.fetch('/api/x'));
  ok(e && e.curatorNetwork === true, 'run against a stub window, it installs the translation');
  const html = readFileSync(join(ROOT, 'src/public/next/index.html'), 'utf8');
  ok(!/installFetchTranslation|shared\/net\.js/.test(html), 'index.html (the boot guard) is untouched');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 the converted views, executed (Settings › Verify AI connection, Providers & keys)');
{
  const SETTINGS = stripComments(readFileSync(join(ROOT, 'src/public/next/views/settings.js'), 'utf8'));
  const lift = (names, injected) => new Function(...Object.keys(injected),
    names.map((n) => { const f = functionSource(SETTINGS, n); if (!f) throw new Error('not found: ' + n); return f; }).join('\n') +
    '\nreturn {' + names.join(',') + '};')(...Object.values(injected));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = {};
  const env = {
    state, escapeHtml: esc, icon: (n) => '<i data-icon="' + n + '"></i>',
    plainError, errorDetailHtml, errorFromResponse, isCurrentMount: () => true, render: () => {},
    fetch: null, document: { getElementById: () => null }, loadKeys: async () => {},
    markSystemCheckStale: () => {}, setLiveRunsOn: () => {},
  };
  const v = lift(['renderLiveResult', 'onVerifyAiConfirm'], env);

  // The route as the server now answers a dead key: plain error + detail + code.
  state.live = { ok: false, error: "Anthropic didn't accept the API key saved in The Curator, so the request was refused and not charged. Open Settings › Providers & keys and use Replace key to paste a working key.",
    detail: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', code: 'ai-key-rejected' };
  let html = v.renderLiveResult();
  ok(/didn&#39;t accept the API key/.test(html) && /Technical detail \(for support\): 401 \{&quot;type&quot;/.test(html),
    'Verify AI connection: the plain sentence, with the raw provider text on the detail line', html);
  // An OLDER server: the raw SDK text in `error`.
  state.live = { ok: false, error: 'Connection error.' };
  html = v.renderLiveResult();
  ok(!/>Connection error\.</.test(html) && /class="check-detail">[^<]+<\/span>/.test(html), 'an older server\'s raw text is not the visible sentence', html);
  state.live = { ok: false, error: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}' };
  html = v.renderLiveResult();
  ok(/run out of credit/.test(html) && /Technical detail \(for support\): 400/.test(html), 'an older server\'s raw no-credit text → the plain sentence + detail', html);
  state.live = { ok: false };
  ok(/The check did not finish\./.test(v.renderLiveResult()), 'no error at all → a sentence, never "Unknown error"');

  // The press itself, with the app's server gone (the wrapper's error).
  const w = stubWindow(() => Promise.reject(new TypeError('Failed to fetch')));
  installFetchTranslation(w);
  const v2 = lift(['renderLiveResult', 'onVerifyAiConfirm'], { ...env, fetch: w.fetch });
  await v2.onVerifyAiConfirm(1);
  ok(state.live && state.live.ok === false && state.live.error === UNREACHABLE, 'server gone mid-press → the server-unreachable sentence', state.live && state.live.error);

  // Providers & keys › Save, refused by a server with a raw fs error (older server).
  const save = lift(['readSkippedActivation', 'classifyActivationOutcome', 'markSystemCheckStale', 'onSaveKey'].filter((n) => functionSource(SETTINGS, n)), {
    ...env,
    document: { getElementById: () => ({ value: 'sk-ant-FAKE-NOT-REAL-KEY-00000' }) },
    fetch: async () => new Response(JSON.stringify({ error: "EACCES: permission denied, open '/Users/a/.curator-config.json'" }), { status: 500 }),
  });
  state.keysActionError = null;
  await save.onSaveKey('anthropic', 1);
  ok(typeof state.keysActionError === 'string' && /didn't let The Curator use a file it needs \(\.curator-config\.json\)/.test(state.keysActionError),
    'Save key: a raw EACCES becomes the plain sentence, naming only the file', state.keysActionError);
  ok(/EACCES/.test(errorDetailOf(state.keysActionError)) && !/\/Users\/a/.test(errorDetailOf(state.keysActionError)),
    '…with the raw text as its detail, home folder removed', errorDetailOf(state.keysActionError));
  // (renderProviders needs the whole model picker in its sandbox; that suite,
  // test-next-model-picker.js, runs it with errorDetailHtml injected.)
  ok(/tx-error-detail/.test(errorDetailHtml(state.keysActionError)), '…which renders as the visible detail line under it');
  // A deliberate refusal from the route passes through unchanged.
  const save2 = lift(['readSkippedActivation', 'classifyActivationOutcome', 'markSystemCheckStale', 'onSaveKey'].filter((n) => functionSource(SETTINGS, n)), {
    ...env,
    document: { getElementById: () => ({ value: 'x' }) },
    fetch: async () => new Response(JSON.stringify({ error: 'That does not look like an Anthropic key.' }), { status: 400 }),
  });
  await save2.onSaveKey('anthropic', 1);
  ok(state.keysActionError === 'That does not look like an Anthropic key.', 'Save key: a written refusal passes through unchanged', state.keysActionError);
}

section('§ v3.99.2 audit: the browser half');
{
  // #3: cleanDetail removes credential shapes too, dependency-free (the
  // shared catalogue's scrubs, no server import).
  const HEX40 = '0123456789abcdef0123456789abcdef01234567';
  const SK = ['sk', 'ant', 'api03', 'c'.repeat(30)].join('-');
  const AIZA = 'AIza' + 'b'.repeat(35);
  const raw = `https://ghp_${'a'.repeat(36)}@github.com/x /Users/alice smith/x ?key=${AIZA} ${SK} Authorization: token ${HEX40} ssh://${HEX40}@github.com/r`;
  const shapes = () => {
    const c = cleanDetail(raw);
    return ['ghp_', 'AIza', 'sk-ant', HEX40, 'alice', 'smith'].filter((x) => c.includes(x));
  };
  ok(shapes().length === 0, 'cleanDetail: no key, token or user name survives', shapes().join(', '));
  const viaBody = userMessageFrom({ error: 'S', detail: raw });
  ok(!/sk-ant|AIza|ghp_|smith/.test(viaBody.detail), 'a server detail is cleaned the same way', viaBody.detail);
  const viaRaw = userMessageFrom({ error: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key ' + SK + '"}}' });
  ok(!viaRaw.detail.includes(SK), 'a raw old-server error kept as detail loses its key', viaRaw.detail);
  ok(!/^\s*import\s/m.test(readFileSync(join(ROOT, 'src/public/next/shared/user-errors.js'), 'utf8')), 'the scrubs live in the import-free shared module');
  // Mutation control: the pre-audit cleanDetail (home folders and URL userinfo only) leaks.
  const old = (t) => t.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1').replace(/(https?:\/\/)[^\s/@:]{16,}@/gi, '$1')
    .replace(/\/Users\/[^/\s'"`]+/g, '~');
  ok(/sk-ant|AIza|smith/.test(old(raw)), 'mutation control: the pre-audit scrub leaves a key and "smith" (so the check can fail)');

  // #4: a later error with the same sentence and no detail does not inherit one.
  const a = plainError({ error: 'Same sentence for the audit.', detail: 'detail A' });
  ok(errorDetailOf(a) === 'detail A', 'a detail is remembered for its sentence');
  const c = plainError({ error: 'Same sentence for the audit.' });
  ok(errorDetailOf(c) === '', 'a later error with the same sentence and no detail shows none (not the stale one)', errorDetailOf(c));
  ok(errorDetailHtml(c) === '', '…and renders no detail line');

  // #8: the server dying mid-stream.
  for (const [label, err] of [
    ['Chromium reader.read()', new TypeError('network error')],
    ['Firefox reader.read()', new TypeError('Error in input stream')],
  ]) {
    const u = userMessageFrom(err);
    ok(u.code === 'server-unreachable' && u.error === USER_MESSAGES['server-unreachable'](), `${label} → server-unreachable`, JSON.stringify(u));
  }
  for (const s of ['Could not reach GitHub: network error', 'The network error page', 'network errors']) {
    ok(userMessageFrom({ error: s }).error === s, `only the exact shape: "${s}" passes through`);
  }

  // #1 in the browser: an fs error inside a deliberate sentence keeps the sentence.
  const charged = "The AI's reply was received (and charged), but not one of its 3 page(s) could be saved: EACCES: permission denied, open '/Users/a/w/acme.md'. Nothing else was changed.";
  const uc = userMessageFrom({ error: charged });
  ok(/\(and charged\)/.test(uc.error) && /Nothing else was changed\./.test(uc.error) && !/EACCES/.test(uc.error), 'an older server\'s charged sentence keeps its words in the browser', uc.error);
  ok(/^EACCES: permission denied, open '/.test(uc.detail) && !uc.detail.includes('/Users/a'), '…with the raw fragment alone as detail', uc.detail);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
