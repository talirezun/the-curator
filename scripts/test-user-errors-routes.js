#!/usr/bin/env node
/**
 * Plain-language errors at the server's exit — the three pieces server.js
 * installs (src/brain/user-errors.js: userErrorBodies, apiNotFound,
 * apiErrorHandler), offline.
 *
 * TWO ARMS
 *   §1 IN-PROCESS A/B. The REAL routers (domains, wiki, trash, memory) are
 *      mounted twice over one isolated domains folder: once bare, once behind
 *      userErrorBodies. Every deliberate refusal must be BYTE-IDENTICAL (status,
 *      content-type, body bytes) in both; a raw fs error must be plain in the
 *      wrapped app and raw in the bare one (the control: without the wrapper
 *      the raw text really does reach the wire).
 *   §2 THE REAL src/server.js, spawned with CURATOR_TEST_USER_DATA_DIR,
 *      CURATOR_TEST_DOMAINS_DIR and CURATOR_NO_OPEN: the same raw error is
 *      plain (so the middleware is INSTALLED, not merely written); the same
 *      deliberate refusals are byte-identical to the bare in-process app; an
 *      unknown /api path is a JSON 404 `api-route-missing` (GET and POST),
 *      not the SPA's HTML at 200; a malformed or oversized JSON body is a
 *      plain JSON error, never Express's HTML page with a stack; the SPA,
 *      /api/version and the Host guard are unchanged.
 *
 * Removing any of the three server.js lines turns §2 red (recorded in the
 * commit's mutation log).
 *
 * The broken domains are real: `wiki` is a FILE (ENOTDIR) in one, and a mode
 * 000 folder (EACCES) in the other.
 */

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const T = mkdtempSync(path.join(tmpdir(), 'curator-user-errors-routes-'));
const DOMAINS = path.join(T, 'domains');
const USER_DATA = path.join(T, 'ud');
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_LOG_DIR = path.join(USER_DATA, 'logs');
process.env.CURATOR_TEST_MCP_LAUNCHER_DIR = path.join(USER_DATA, 'bin');
process.env.CURATOR_NO_OPEN = '1';

mkdirSync(path.join(DOMAINS, 'good', 'wiki', 'entities'), { recursive: true });
writeFileSync(path.join(DOMAINS, 'good', 'CLAUDE.md'), '# Good\n');
writeFileSync(path.join(DOMAINS, 'good', 'wiki', 'index.md'), '# Index\n');
writeFileSync(path.join(DOMAINS, 'good', 'wiki', 'log.md'), '# Log\n');
mkdirSync(path.join(DOMAINS, 'filewiki'), { recursive: true });
writeFileSync(path.join(DOMAINS, 'filewiki', 'CLAUDE.md'), '# File wiki\n');
writeFileSync(path.join(DOMAINS, 'filewiki', 'wiki'), 'a file where the wiki folder should be');
mkdirSync(path.join(DOMAINS, 'locked', 'wiki', 'concepts'), { recursive: true });
writeFileSync(path.join(DOMAINS, 'locked', 'CLAUDE.md'), '# Locked\n');
writeFileSync(path.join(DOMAINS, 'locked', 'wiki', 'index.md'), '# Index\n');
chmodSync(path.join(DOMAINS, 'locked', 'wiki'), 0o000);
mkdirSync(USER_DATA, { recursive: true });

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`); }
}
function eq(name, a, b) { ok(name, a === b, `expected ${JSON.stringify(b)}\n      got      ${JSON.stringify(a)}`); }
function section(t) { console.log(`\n── ${t}`); }

const RAW = /\bE[A-Z]{3,}:|scandir|\/var\/folders|\/private\/|\/Users\/|<!DOCTYPE|<html|\bat [\w.]+ \(|SyntaxError/;

// Silence the routes' own console.error noise; this suite reads responses.
const realError = console.error;
console.error = () => {};

const express = (await import('express')).default;
const { userErrorBodies } = await import('../src/brain/user-errors.js');
const routers = {
  '/api/domains': (await import('../src/routes/domains.js')).default,
  '/api/wiki': (await import('../src/routes/wiki.js')).default,
  '/api/trash': (await import('../src/routes/trash.js')).default,
  '/api/memory': (await import('../src/routes/memory.js')).default,
};
async function startApp(withMiddleware) {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  if (withMiddleware) app.use('/api', userErrorBodies);
  for (const [m, r] of Object.entries(routers)) app.use(m, r);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

async function call(base, method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const r = await fetch(base + url, init);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, type: r.headers.get('content-type') || '', text, json };
}

// Deliberate refusals: The Curator's own words. Each must be byte-identical
// with and without the wrapper.
const DELIBERATE = [
  ['GET', '/api/domains/zzz/stats'],
  ['GET', '/api/wiki/zzz/list'],
  ['GET', '/api/wiki/good/page?path=index.md'],
  ['POST', '/api/domains', { name: '' }],
  ['POST', '/api/domains', { name: 'good' }],
  ['DELETE', '/api/domains/good', {}],
  ['GET', '/api/trash'],
  ['DELETE', '/api/trash/scopes/does-not-exist', { confirm: 'x' }],
  ['GET', '/api/domains'],
];
const RAW_ROUTES = [
  ['GET', '/api/wiki/filewiki', 'files-wrong-kind'],
  ['GET', '/api/wiki/locked', 'files-not-allowed'],
];

let bareBodies = new Map();

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('§1 — in-process A/B over the real routers');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const bare = await startApp(false);
    const wrapped = await startApp(true);
    try {
      for (const [method, url, body] of DELIBERATE) {
        const a = await call(bare.base, method, url, body);
        const b = await call(wrapped.base, method, url, body);
        bareBodies.set(`${method} ${url} ${JSON.stringify(body)}`, a);
        ok(`deliberate ${method} ${url}: answers JSON with an error or data`, !!a.json, a.text.slice(0, 120));
        ok(`deliberate ${method} ${url}: byte-identical with the wrapper (status ${a.status})`,
          a.status === b.status && a.type === b.type && a.text === b.text, `bare ${a.status} ${a.text.slice(0, 160)}\n      wrap ${b.status} ${b.text.slice(0, 160)}`);
      }
      const refusals = [...bareBodies.values()].filter((r) => r.json && typeof r.json.error === 'string');
      ok(`at least 5 of those are refusals carrying an error sentence (${refusals.length})`, refusals.length >= 5);
      for (const [method, url, klass] of RAW_ROUTES) {
        const a = await call(bare.base, method, url);
        const b = await call(wrapped.base, method, url);
        ok(`control: without the wrapper ${url} really sends raw text`, a.json && RAW.test(a.json.error || ''), a.text.slice(0, 160));
        eq(`${url}: same status with the wrapper`, b.status, a.status);
        ok(`${url}: the wrapped error is plain`, b.json && !RAW.test(b.json.error), b.text.slice(0, 200));
        eq(`${url}: code`, b.json && b.json.code, klass);
        ok(`${url}: detail keeps the errno, path-scrubbed`, b.json && /^E[A-Z]+: /.test(b.json.detail) && !b.json.detail.includes(T), b.json && b.json.detail);
      }
    } finally {
      bare.srv.close();
      wrapped.srv.close();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§2 — the real src/server.js');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const port = await new Promise((resolve) => {
      const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const base = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 60000;
      let up = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try { const r = await fetch(`${base}/api/version`); if (r.status === 200) { up = true; break; } } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      ok('the real server came up', up, out.split('\n').slice(0, 8).join(' | '));

      for (const [method, url, body] of DELIBERATE) {
        const a = bareBodies.get(`${method} ${url} ${JSON.stringify(body)}`);
        const b = await call(base, method, url, body);
        // The trash route reports its own folder; equal by construction in both.
        ok(`real server, deliberate ${method} ${url}: byte-identical to the bare routers`,
          a && a.status === b.status && a.text === b.text, `bare ${a && a.status} ${a && a.text.slice(0, 160)}\n      real ${b.status} ${b.text.slice(0, 160)}`);
      }
      for (const [method, url, klass] of RAW_ROUTES) {
        const b = await call(base, method, url);
        ok(`real server, ${url}: plain sentence (the middleware is installed)`, b.json && !RAW.test(b.json.error || ''), b.text.slice(0, 200));
        eq(`real server, ${url}: code`, b.json && b.json.code, klass);
        ok(`real server, ${url}: detail has no temp path`, b.json && typeof b.json.detail === 'string' && !b.json.detail.includes(T), b.json && b.json.detail);
      }

      for (const method of ['GET', 'POST', 'DELETE']) {
        const r = await call(base, method, '/api/no-such-route/x', method === 'GET' ? undefined : {});
        eq(`unknown ${method} /api path: 404`, r.status, 404);
        ok(`unknown ${method} /api path: JSON, not HTML`, r.type.startsWith('application/json') && !!r.json, `${r.type} ${r.text.slice(0, 80)}`);
        eq(`unknown ${method} /api path: code`, r.json && r.json.code, 'api-route-missing');
        ok(`unknown ${method} /api path: a plain sentence`, r.json && /isn't available in the version that's running/.test(r.json.error), r.text);
      }
      const nested = await call(base, 'GET', '/api/domains/good/no-such-thing/at-all');
      eq('an unknown path under a real router is the JSON 404 too', nested.json && nested.json.code, 'api-route-missing');

      const bad = await call(base, 'POST', '/api/domains', '{"name": ');
      eq('malformed JSON: 400', bad.status, 400);
      ok('malformed JSON: JSON body, not Express HTML', bad.type.startsWith('application/json') && !!bad.json, bad.text.slice(0, 120));
      eq('malformed JSON: code', bad.json && bad.json.code, 'request-malformed');
      ok('malformed JSON: no stack, no parser text', !RAW.test(bad.text), bad.text);

      const big = '{"name":"' + 'x'.repeat(51 * 1024 * 1024) + '"}';
      const large = await call(base, 'POST', '/api/domains', big);
      eq('oversized JSON (51 MB > the 50 MB limit): 413', large.status, 413);
      ok('oversized JSON: JSON body, not Express HTML', large.type.startsWith('application/json') && !!large.json, large.text.slice(0, 120));
      eq('oversized JSON: code', large.json && large.json.code, 'request-too-large');

      const v = await call(base, 'GET', '/api/version');
      ok('/api/version is unchanged JSON', v.status === 200 && v.json && typeof v.json.version === 'string');
      const spa = await call(base, 'GET', '/domains/good');
      ok('an SPA path still serves the shell (HTML 200)', spa.status === 200 && /<html/i.test(spa.text));
      const root = await call(base, 'GET', '/');
      ok('/ still serves the shell', root.status === 200 && /<html/i.test(root.text));
      // fetch() may not set Host (a forbidden header), so a raw request does.
      const evil = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/version', headers: { Host: 'evil.example' } }, (res) => {
          let text = ''; res.on('data', (c) => { text += c; });
          res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* */ } resolve({ status: res.statusCode, text, json }); });
        });
        req.on('error', reject); req.end();
      });
      ok('the Host guard still answers first, with its own words', evil.status === 403 && evil.json && evil.json.error.startsWith('Invalid Host header.'), evil.text);
      const xo = await call(base, 'POST', '/api/domains', { name: 'x' }, { Origin: 'https://evil.example' });
      ok('the Origin guard still answers first, with its own words', xo.status === 403 && xo.json && xo.json.error.startsWith('Cross-origin request blocked.'), xo.text);
    } finally {
      child.kill('SIGTERM');
    }
  }
} finally {
  console.error = realError;
  try { chmodSync(path.join(DOMAINS, 'locked', 'wiki'), 0o700); } catch { /* absent */ }
  rmSync(T, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
