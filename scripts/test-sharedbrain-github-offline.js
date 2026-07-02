#!/usr/bin/env node
/**
 * Shared Brain — Phase 3 Battle Test (GitHub adapter, OFFLINE)
 *
 * Validates the GitHubStorageAdapter without any network access. A
 * deterministic mock-fetch is injected via the adapter's `fetchImpl`
 * constructor option; every request is matched against a scripted
 * scenario so we can assert:
 *
 *   - request shapes (URL, method, headers, base64 body)
 *   - 200/201/404/409/422/429/403-rate-limit handling
 *   - SHA-based optimistic concurrency: conflict → retry → success
 *   - SHA-based optimistic concurrency: conflict → retry → conflict → throw
 *   - skip-write optimisation when remote content matches local
 *   - path-traversal hardening (no fetch fires for unsafe args)
 *   - rate-limit warning fires on low remaining; throws on remaining=0+429
 *   - the PAT never appears in any thrown Error's message/stack/toString,
 *     and never appears in console output
 *
 * Run with:  node scripts/test-sharedbrain-github-offline.js
 *
 * Exit code 0 if all green; non-zero on any failure.
 * No network access, no env vars required. Safe for normal regression.
 */

import { GitHubStorageAdapter, __testing as adapterT } from '../src/brain/sharedbrain-github-adapter.js';
import { createStorageAdapter } from '../src/brain/sharedbrain-storage-factory.js';

// ── Harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];
function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assert(c, l, e)  { c ? ok(l) : fail(l, new Error(e || 'assertion failed')); }
function assertEq(a, e, l) {
  const sa = JSON.stringify(a);
  const se = JSON.stringify(e);
  sa === se ? ok(l) : fail(l, new Error(`expected ${se}, got ${sa}`));
}
async function expectThrow(fn, label, matcher) {
  try {
    await fn();
    fail(label, new Error('expected throw, but call resolved'));
  } catch (err) {
    if (matcher && !matcher.test(err.message || String(err))) {
      fail(label, new Error(`thrown but message did not match ${matcher} (got "${err.message || err}")`));
    } else {
      ok(label);
    }
  }
}
function section(name) { console.log(`\n── ${name} ──`); }

// ── Mock-fetch scaffolding ──────────────────────────────────────────────

/**
 * A scriptable fetch mock. `script` is an array of handlers; each handler
 * takes (url, init) and either returns a Response-shaped object or null
 * (meaning "not my request, try the next handler"). Once a handler matches
 * and returns, it is REMOVED from the front of the queue — order-preserving.
 *
 * This style matches the existing battle-test harness pattern (no test
 * framework, no jest, no vitest — plain functions).
 */
function makeMockFetch(script) {
  const queue = script.slice();
  const calls = [];
  async function mockFetch(url, init = {}) {
    calls.push({ url, init });
    const handler = queue.shift();
    if (!handler) {
      throw new Error(`mock-fetch: unexpected request (no handler in queue): ${init.method || 'GET'} ${url}`);
    }
    const result = handler(url, init);
    if (result === null || result === undefined) {
      throw new Error(`mock-fetch: handler returned null for ${init.method || 'GET'} ${url}`);
    }
    return Promise.resolve(result);
  }
  mockFetch.calls = calls;
  mockFetch.remaining = () => queue.length;
  return mockFetch;
}

function mockResponse({ status = 200, body = {}, headers = {} } = {}) {
  const hdr = new Map(Object.entries({
    'content-type': 'application/json',
    'x-ratelimit-remaining': '4900',
    'x-ratelimit-reset': '9999999999',
    ...headers,
  }));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: k => hdr.get(String(k).toLowerCase()) ?? null },
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); },
  };
}

const SECRET_PAT = 'github_pat_FAKE_SECRET_DONOTLEAK_zZ123456789';

function makeAdapter(fetchImpl, overrides = {}) {
  return new GitHubStorageAdapter({
    owner: 'octocat',
    repo:  'shared-brain-mock',
    pat:   SECRET_PAT,
    branch: 'main',
    fetchImpl,
    ...overrides,
  });
}

function b64(str) { return Buffer.from(str, 'utf8').toString('base64'); }
function decodeBody(init) { return init && init.body ? JSON.parse(init.body) : null; }

// ── 1. Constructor validation ──────────────────────────────────────────

section('Constructor: input validation');

await expectThrow(
  async () => new GitHubStorageAdapter({}),
  'rejects empty config (owner required)',
  /owner is required/,
);

await expectThrow(
  async () => new GitHubStorageAdapter({ owner: 'octocat' }),
  'rejects missing repo',
  /repo is required/,
);

await expectThrow(
  async () => new GitHubStorageAdapter({ owner: 'octocat', repo: 'foo' }),
  'rejects missing pat',
  /pat is required/,
);

await expectThrow(
  async () => new GitHubStorageAdapter({
    owner: 'octocat', repo: 'foo', pat: 'tooshort',
  }),
  'rejects pat shorter than 20 chars',
  /pat is required/,
);

await expectThrow(
  async () => new GitHubStorageAdapter({
    owner: '..bad', repo: 'foo', pat: 'github_pat_long_enough_dummy_value',
  }),
  'rejects owner with leading dots',
  /owner is required/,
);

await expectThrow(
  async () => new GitHubStorageAdapter({
    owner: 'octocat', repo: 'foo/bar', pat: 'github_pat_long_enough_dummy_value',
  }),
  'rejects repo name with slashes',
  /repo is required/,
);

await expectThrow(
  async () => new GitHubStorageAdapter({
    owner: 'octocat', repo: 'foo', pat: 'github_pat_long_enough_dummy_value',
    branch: '../master',
  }),
  'rejects branch with parent-traversal',
  /branch must be a valid ref/,
);

// Valid construction
try {
  const a = makeAdapter(makeMockFetch([]));
  assert(a instanceof GitHubStorageAdapter, 'constructs with valid config');
} catch (err) { fail('valid construct', err); }

// ── 2. Path-traversal hardening ─────────────────────────────────────────

section('Security: path-traversal rejected before any HTTP fires');

{
  const fetch = makeMockFetch([]); // no requests expected
  const adapter = makeAdapter(fetch);

  // unsafe domain
  await expectThrow(
    () => adapter.writePage('../evil', 'entities/foo.md', 'x'),
    'writePage refuses unsafe domain',
    /unsafe domain or path/,
  );
  // unsafe relative path
  await expectThrow(
    () => adapter.writePage('work-ai', '../../etc/passwd', 'x'),
    'writePage refuses ../ in path',
    /unsafe domain or path/,
  );
  await expectThrow(
    () => adapter.writePage('work-ai', '/abs/path.md', 'x'),
    'writePage refuses absolute path',
    /unsafe domain or path/,
  );
  await expectThrow(
    () => adapter.writePage('work-ai', '', 'x'),
    'writePage refuses empty path',
    /unsafe domain or path/,
  );
  await expectThrow(
    () => adapter.writePage('work-ai', 'entities/\x00bad.md', 'x'),
    'writePage refuses NUL byte in path',
    /unsafe domain or path/,
  );

  // unsafe contribution ids
  await expectThrow(
    () => adapter.storeContribution('../fellow', 'sub', { x: 1 }),
    'storeContribution refuses unsafe fellowId',
    /unsafe ids/,
  );

  // unsafe meta key
  await expectThrow(
    () => adapter.writeMeta('../escape', { x: 1 }),
    'writeMeta refuses traversal key',
    /unsafe key/,
  );

  assertEq(fetch.calls.length, 0, 'no HTTP request fired for any rejected unsafe arg');
}

// ── 3. readPage: 404 → null; 200 → decoded string ───────────────────────

section('readPage: success and not-found paths');

{
  const fetch = makeMockFetch([
    (url, init) => {
      assert(
        url.includes('/repos/octocat/shared-brain-mock/contents/collective/work-ai/wiki/entities/anthropic.md'),
        'URL targets collective/<domain>/wiki/<path>',
      );
      assert(url.includes('?ref=main'), 'URL includes ?ref=<branch>');
      assertEq(init.method, 'GET', 'readPage uses GET');
      assertEq(init.headers['Accept'], 'application/vnd.github+json', 'Accept header set');
      assertEq(init.headers['X-GitHub-Api-Version'], '2022-11-28', 'API version header set');
      assertEq(init.headers['Authorization'], `Bearer ${SECRET_PAT}`, 'Authorization is Bearer <pat>');
      assert(init.headers['User-Agent'].startsWith('the-curator-sharedbrain/'),
        'User-Agent starts with the-curator-sharedbrain/');
      return mockResponse({ status: 200, body: {
        content: b64('# Anthropic\n\nAI safety company.\n'),
        sha: 'abc123sha',
      }});
    },
    () => mockResponse({ status: 404, body: { message: 'Not Found' } }),
  ]);
  const adapter = makeAdapter(fetch);
  const got = await adapter.readPage('work-ai', 'entities/anthropic.md');
  assertEq(got, '# Anthropic\n\nAI safety company.\n', 'readPage decodes base64 content');

  const missing = await adapter.readPage('work-ai', 'entities/nope.md');
  assertEq(missing, null, 'readPage returns null on 404');

  assertEq(fetch.remaining(), 0, 'both scripted readPage requests consumed');
}

// ── 4. writePage: create (no sha) → success ─────────────────────────────

section('writePage: create new file (no existing sha)');

{
  const fetch = makeMockFetch([
    // First the adapter does a GET to discover existing SHA.
    () => mockResponse({ status: 404, body: { message: 'Not Found' } }),
    // Then PUT to create.
    (url, init) => {
      assertEq(init.method, 'PUT', 'writePage uses PUT');
      assertEq(init.headers['Content-Type'], 'application/json', 'PUT sets Content-Type JSON');
      const body = decodeBody(init);
      assert(body.message && body.message.startsWith('Shared Brain: write'),
        'commit message starts with "Shared Brain: write"');
      assert(body.content === b64('# OpenAI\n'), 'PUT body content is base64-encoded UTF-8');
      assertEq(body.branch, 'main', 'PUT body specifies branch');
      assertEq(body.sha, undefined, 'PUT body omits sha for new file');
      return mockResponse({ status: 201, body: { content: { sha: 'newsha111' } } });
    },
  ]);
  const adapter = makeAdapter(fetch);
  await adapter.writePage('work-ai', 'entities/openai.md', '# OpenAI\n');
  assertEq(fetch.remaining(), 0, 'GET + PUT scripted sequence consumed');
}

// ── 5. writePage: update existing → passes sha ──────────────────────────

section('writePage: update existing file (sha attached)');

{
  const fetch = makeMockFetch([
    // GET returns existing content + sha.
    () => mockResponse({ status: 200, body: {
      content: b64('# OpenAI\n\nOld content.\n'),
      sha: 'existingsha999',
    }}),
    // PUT must include sha.
    (_url, init) => {
      const body = decodeBody(init);
      assertEq(body.sha, 'existingsha999', 'PUT includes existing sha on update');
      return mockResponse({ status: 200, body: { content: { sha: 'updatedsha000' } } });
    },
  ]);
  const adapter = makeAdapter(fetch);
  await adapter.writePage('work-ai', 'entities/openai.md', '# OpenAI\n\nNew content.\n');
  assertEq(fetch.remaining(), 0, 'GET + PUT consumed on update');
}

// ── 6. writePage: skip-write optimisation when content matches ─────────

section('writePage: skip PUT when remote content is byte-identical');

{
  const fetch = makeMockFetch([
    // GET returns the SAME content we're about to write.
    () => mockResponse({ status: 200, body: {
      content: b64('# Already.\n'),
      sha: 'identical',
    }}),
    // NO PUT should follow — if it does, this handler throws "unexpected request".
  ]);
  const adapter = makeAdapter(fetch);
  await adapter.writePage('work-ai', 'entities/already.md', '# Already.\n');
  assertEq(fetch.remaining(), 0, 'only the GET was made; PUT was skipped (no commit when unchanged)');
  assertEq(fetch.calls.length, 1, 'exactly one network call for identical-content write');
}

// ── 7. writePage: 409 conflict → refetch sha → retry → success ────────

section('writePage: 409 conflict triggers single refetch + retry');

{
  const fetch = makeMockFetch([
    () => mockResponse({ status: 200, body: { content: b64('v1'), sha: 'sha-v1' }}),
    () => mockResponse({ status: 409, body: { message: 'sha does not match' }}),
    () => mockResponse({ status: 200, body: { content: b64('v1'), sha: 'sha-v2' }}),
    (_u, init) => {
      const body = decodeBody(init);
      assertEq(body.sha, 'sha-v2', 'retry PUT uses refreshed sha (sha-v2)');
      return mockResponse({ status: 200, body: { content: { sha: 'sha-v3' } } });
    },
  ]);
  const adapter = makeAdapter(fetch);
  await adapter.writePage('work-ai', 'entities/contested.md', 'v2');
  assertEq(fetch.remaining(), 0, '4-step conflict-recovery sequence fully consumed');
}

// ── 8. writePage: 409 twice → throw with code ──────────────────────────

section('writePage: persistent 409 after retry → throws SHARED_BRAIN_SHA_CONFLICT');

{
  const fetch = makeMockFetch([
    () => mockResponse({ status: 200, body: { content: b64('v1'), sha: 'sha-v1' }}),
    () => mockResponse({ status: 409, body: { message: 'sha does not match' }}),
    () => mockResponse({ status: 200, body: { content: b64('v1'), sha: 'sha-v2' }}),
    () => mockResponse({ status: 409, body: { message: 'sha does not match again' }}),
  ]);
  // maxRetries pinned to 1: this scenario scripts exactly one retry cycle.
  // (The production DEFAULT is 3 since v3.0.6 — the live 5.4 concurrency
  // test showed one immediate retry loses the create-race against GitHub's
  // read-after-write lag. Asserted below.)
  const adapter = makeAdapter(fetch, { maxRetries: 1 });
  await expectThrow(
    () => adapter.writePage('work-ai', 'entities/contested.md', 'v2'),
    'writePage throws on persistent conflict',
    /SHARED_BRAIN_SHA_CONFLICT|409/,
  );
  assertEq(fetch.remaining(), 0, 'all 4 conflict handlers consumed before throw');
}

// v3.0.6: the production retry default must stay ≥3 (create-race + GitHub
// eventual-consistency absorption). A regression to 1 re-opens the 5.4 bug.
{
  const a = makeAdapter(makeMockFetch([]));
  assert(a._maxRetries >= 3, `default maxRetries is ≥3 for real-world create races (got ${a._maxRetries})`);
}

// ── 9. listPages: tree → filter to domain ───────────────────────────────

section('listPages: uses tree API, filters by domain');

{
  const fetch = makeMockFetch([
    (url) => {
      assert(url.includes('/git/trees/main?recursive=1'), 'listPages calls trees API with recursive=1');
      return mockResponse({ status: 200, body: {
        tree: [
          { type: 'blob', path: 'collective/work-ai/wiki/entities/anthropic.md', sha: 's1' },
          { type: 'blob', path: 'collective/work-ai/wiki/concepts/rag.md',        sha: 's2' },
          { type: 'blob', path: 'collective/work-ai/wiki/summaries/intro.md',     sha: 's3' },
          { type: 'blob', path: 'collective/other-domain/wiki/entities/x.md',     sha: 's4' },
          { type: 'blob', path: 'contributions/abc/def.json',                     sha: 's5' },
          { type: 'tree', path: 'collective/work-ai/wiki/entities',               sha: 's6' },
        ],
        truncated: false,
      }});
    },
  ]);
  const adapter = makeAdapter(fetch);
  const pages = await adapter.listPages('work-ai');
  assertEq(
    pages.sort(),
    ['concepts/rag.md', 'entities/anthropic.md', 'summaries/intro.md'],
    'listPages returns only domain-matching blob paths, relative to wiki/',
  );
}

// ── 10. listPages with prefix ───────────────────────────────────────────

section('listPages: prefix filtering');

{
  const fetch = makeMockFetch([
    () => mockResponse({ status: 200, body: {
      tree: [
        { type: 'blob', path: 'collective/work-ai/wiki/entities/a.md', sha: 's1' },
        { type: 'blob', path: 'collective/work-ai/wiki/entities/b.md', sha: 's2' },
        { type: 'blob', path: 'collective/work-ai/wiki/concepts/c.md', sha: 's3' },
      ],
      truncated: false,
    }}),
  ]);
  const adapter = makeAdapter(fetch);
  const entities = await adapter.listPages('work-ai', 'entities');
  assertEq(entities.sort(), ['entities/a.md', 'entities/b.md'], 'listPages prefix filters correctly');
}

// ── 11. listContributionsSince: tree + bounded parallel fetch ──────────

section('listContributionsSince: tree + per-file content fetch + chronological sort');

{
  const fetch = makeMockFetch([
    // Tree call
    () => mockResponse({ status: 200, body: {
      tree: [
        { type: 'blob', path: 'contributions/fellow1/sub1.json', sha: 's1' },
        { type: 'blob', path: 'contributions/fellow2/sub2.json', sha: 's2' },
        { type: 'blob', path: 'contributions/fellow3/sub3.json', sha: 's3' },
        // Decoy — must be ignored
        { type: 'blob', path: 'collective/work-ai/wiki/entities/anthropic.md', sha: 'sx' },
        { type: 'blob', path: 'contributions/fellow1/sub1.json.bak',           sha: 'sy' },
      ],
      truncated: false,
    }}),
    // Per-file content fetches — order matches the candidates as listed above.
    () => mockResponse({ status: 200, body: {
      content: b64(JSON.stringify({ contributed_at: '2026-05-14T10:00:00Z', deltas: [] })),
      sha: 's1',
    }}),
    () => mockResponse({ status: 200, body: {
      content: b64(JSON.stringify({ contributed_at: '2026-05-14T11:00:00Z', deltas: [] })),
      sha: 's2',
    }}),
    () => mockResponse({ status: 200, body: {
      content: b64(JSON.stringify({ contributed_at: '2026-05-14T12:00:00Z', deltas: [] })),
      sha: 's3',
    }}),
  ]);
  const adapter = makeAdapter(fetch);
  const recent = await adapter.listContributionsSince('2026-05-14T11:00:00Z');
  assertEq(recent.length, 2, 'sinceIso filter excludes earlier contributions');
  assertEq(recent.map(c => c.fellowId), ['fellow2', 'fellow3'],
    'remaining contributions are ordered chronologically');
}

// ── 12. Rate-limit handling: low remaining warning + exhaustion throw ──

section('Rate limit: low-remaining warning, exhaustion throws typed error');

{
  // First scenario: response with 25 remaining → expect warning, but call succeeds.
  const origErr = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a.join(' '));

  const fetch = makeMockFetch([
    () => mockResponse({
      status: 200,
      body: { content: b64('x'), sha: 'a' },
      headers: { 'x-ratelimit-remaining': '25' },
    }),
  ]);
  const adapter = makeAdapter(fetch);
  await adapter.readPage('work-ai', 'entities/foo.md');
  console.error = origErr;

  const sawWarning = captured.some(line => /rate limit low: 25/.test(line));
  assert(sawWarning, 'low rate limit (25 remaining) emits warning to stderr');
}

{
  const fetch = makeMockFetch([
    () => mockResponse({
      status: 403,
      body: { message: 'API rate limit exceeded' },
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
    }),
  ]);
  const adapter = makeAdapter(fetch);
  await expectThrow(
    () => adapter.readPage('work-ai', 'entities/foo.md'),
    'exhausted rate limit throws typed SHARED_BRAIN_RATE_LIMIT',
    /SHARED_BRAIN_RATE_LIMIT|rate limit/i,
  );
}

// ── 13. Token-leak audit ────────────────────────────────────────────────

section('Token-leak audit: PAT never appears in errors or stderr');

{
  const origErr = console.error;
  const captured = [];
  console.error = (...a) => captured.push(a.join(' '));

  // Trigger various error paths
  const fetch = makeMockFetch([
    () => mockResponse({ status: 401, body: { message: 'Bad credentials' }}),
    () => mockResponse({ status: 500, body: { message: 'Internal error' }}),
    () => mockResponse({ status: 403, body: {
      message: `accidentally includes pat-shaped string ${SECRET_PAT}`,
    }, headers: { 'x-ratelimit-remaining': '4900' }}),
  ]);
  const adapter = makeAdapter(fetch);

  const collected = [];
  for (let i = 0; i < 3; i++) {
    try { await adapter.readPage('work-ai', `entities/leak${i}.md`); }
    catch (err) {
      collected.push(err.message || '');
      collected.push(err.stack || '');
      collected.push(String(err));
      try { collected.push(JSON.stringify(err, Object.getOwnPropertyNames(err))); } catch { /* ignore */ }
    }
  }

  console.error = origErr;

  const fullBlob = [...captured, ...collected].join('\n');
  const firstHalf = SECRET_PAT.slice(0, 20);
  assert(!fullBlob.includes(SECRET_PAT),
    'full PAT never appears in any captured error / stderr');
  assert(!fullBlob.includes(firstHalf),
    'first 20 chars of PAT never appears in any captured error / stderr');

  // 200-char detail truncation: when GitHub's response body contained the
  // PAT shape, the adapter must truncate AND avoid echoing it. The detail
  // path slices the first 200 chars of `message`. Verify GitHub message
  // body containing the token shape is fully suppressed.
  const lastErr = collected.slice(-3).join('\n');
  assert(!lastErr.includes(SECRET_PAT),
    'when GitHub response body contains PAT-shaped text, adapter does NOT echo it');
}

// ── 14. Meta + digest round-trip ────────────────────────────────────────

section('Meta + digest operations');

{
  const fetch = makeMockFetch([
    // writeMeta: GET to discover sha (404 — new file), then PUT.
    (url) => {
      assert(url.includes('/contents/meta/state/last-synthesis.json?ref=main'),
        'writeMeta uses meta/<key-as-path>.json + ?ref=main');
      return mockResponse({ status: 404 });
    },
    () => mockResponse({ status: 201, body: { content: { sha: 'msha' } } }),
    // readMeta: GET returning JSON.
    () => mockResponse({ status: 200, body: {
      content: b64(JSON.stringify({ at: '2026-05-14T12:00:00Z' }, null, 2) + '\n'),
      sha: 'msha',
    }}),
    // storeDigest: GET (404) + PUT.
    () => mockResponse({ status: 404 }),
    () => mockResponse({ status: 201, body: { content: { sha: 'dsha' } } }),
    // loadDigest
    () => mockResponse({ status: 200, body: {
      content: b64(JSON.stringify({ pages: 5 }, null, 2) + '\n'),
      sha: 'dsha',
    }}),
  ]);
  const adapter = makeAdapter(fetch);

  await adapter.writeMeta('state.last-synthesis', { at: '2026-05-14T12:00:00Z' });
  const meta = await adapter.readMeta('state.last-synthesis');
  assertEq(meta, { at: '2026-05-14T12:00:00Z' }, 'writeMeta + readMeta round-trip via Contents API');

  const fellowId = 'aaaaaaaaaaaa';
  await adapter.storeDigest(fellowId, { pages: 5 });
  const digest = await adapter.loadDigest(fellowId);
  assertEq(digest, { pages: 5 }, 'storeDigest + loadDigest round-trip');
}

// ── 15. Factory dispatch for storage_type=github ────────────────────────

section('Factory: storage_type=github wires GitHubStorageAdapter');

{
  const adapter = createStorageAdapter({
    storage_type: 'github',
    github_repo_owner: 'octocat',
    github_repo_name:  'hello-world',
    github_pat:        'github_pat_thisistwentycharsplusmore_xx',
    github_branch:     'main',
  });
  assertEq(adapter.constructor.name, 'GitHubStorageAdapter',
    'factory dispatches storage_type=github to GitHubStorageAdapter');
}

// ── 16. encoding helpers (pure functions) ───────────────────────────────

section('Encoding helpers');

const { encodeContent, decodeContent, encodePath, isSafeId, safeRelPath } = adapterT;

assertEq(decodeContent(encodeContent('hello world\n')), 'hello world\n',
  'encode/decode round-trip for ASCII');
assertEq(decodeContent(encodeContent('café — résumé 🧠')), 'café — résumé 🧠',
  'encode/decode round-trip for UTF-8 + emoji');
assertEq(encodePath('a/b/c with space.md'), 'a/b/c%20with%20space.md',
  'encodePath encodes each segment, keeps / as separator');
assertEq(encodePath('a/b/c%bad?weird.md'), 'a/b/c%25bad%3Fweird.md',
  'encodePath URL-encodes % and ?');
assert(isSafeId('work-ai'), 'isSafeId accepts slug');
assert(!isSafeId('../bad'), 'isSafeId rejects path traversal');
assertEq(safeRelPath('a/b/c.md'), 'a/b/c.md', 'safeRelPath accepts normal path');
assertEq(safeRelPath('a/../b'), null, 'safeRelPath rejects internal ..');
assertEq(safeRelPath('a/./b'), null, 'safeRelPath rejects internal .');
assertEq(safeRelPath('/abs/path'), null, 'safeRelPath rejects absolute');
assertEq(safeRelPath(''), null, 'safeRelPath rejects empty');
assertEq(safeRelPath('a/\x00b'), null, 'safeRelPath rejects NUL byte');

// ── Summary ──────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
console.log('══════════════════════════════════════');

if (failed > 0) {
  console.log('\nFAILURES:');
  for (const { label, err } of failures) {
    console.log(`  ✗ ${label}`);
    if (err) console.log(`    └─ ${err.message || err}`);
  }
  process.exit(1);
}

console.log('\nAll Phase 3 GitHub adapter OFFLINE tests green.');
console.log('Run the live test with: source /tmp/curator-sharedbrain-phase3.env && node scripts/test-sharedbrain-github-live.js');
process.exit(0);
