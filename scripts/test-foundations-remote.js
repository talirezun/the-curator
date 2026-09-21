#!/usr/bin/env node
/**
 * OFFLINE — tier 0's GITHUB MIRROR ARM (v3.63.0): the machine with no
 * checkout refreshes a repo-owned project's documents over the GitHub API.
 *
 * WHY THIS SUITE LOOKS THE WAY IT DOES
 * ────────────────────────────────────
 * Every defect this arm can have is silent, and three of them are the exact
 * shapes the local arm was built to refuse:
 *
 *   · A TRUNCATED FILE LISTING. GitHub truncates a recursive tree at ~100 k
 *     entries, and a truncated one makes a file that IS in the repository
 *     look absent — which this feature reports as `missing` while KEEPING the
 *     stale copy and reporting success. §6 requires the refusal to fire
 *     BEFORE any blob is fetched and proves the manifest's sha256 on disk is
 *     unchanged afterwards.
 *   · A PARTIAL WRITE. Everything is fetched before anything is written, so
 *     a failure mid-read leaves the mirror exactly as it was (§6, §7).
 *   · THE TOKEN IN A STRING. §7 drives a 401 with a real-shaped fixture token
 *     and then greps the WHOLE tempdir plus every error message for it.
 *   · A WRITE VERB. §2 records every request the client makes and requires
 *     all of them to be GET; §1 reads the module's own source for `PUT`/
 *     `DELETE`/`POST` on a fetch call.
 *   · `readFirst` DROPPED ON A RE-COPY (v3.62.0's own rule: the repository
 *     owns the bytes, the owner owns the routing) — §4.
 *   · THE ARM CHOSEN SILENTLY. §9 requires `source: 'auto'` to take a
 *     reachable checkout and to make ZERO HTTP requests doing it.
 *
 * NO REAL NETWORK, PROVED RATHER THAN CLAIMED. `globalThis.fetch` is replaced
 * at the top of this file with a spy that RECORDS and THROWS, so any code
 * path that forgot to take the injected `fetchImpl` reds the suite instead of
 * reaching github.com. §11 asserts the spy recorded nothing.
 *
 * Isolated via CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR (set
 * before the store is imported, because the token reader resolves
 * `.curator-config.json` and `.sync-config.json` through paths.js) AND
 * __setDomainsDirOverride. Nothing outside a tempdir is read or written.
 *
 * Run with:  node scripts/test-foundations-remote.js   (exit 0 = all green)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

// ── Isolation, BEFORE anything resolves a path ───────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-fnd-remote-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const CHECKOUT = path.join(TMP, 'checkout');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-fnd-remote-')) {
      rmSync(TMP, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});

// ── THE NETWORK SPY (see the header) ─────────────────────────────────────
//
// The real `fetch` is kept ONLY so §11 can talk to its own loopback server;
// nothing else in this file may reach it, and the spy below is what makes
// that true rather than promised.
const REAL_FETCH = globalThis.fetch.bind(globalThis);
const NET_ATTEMPTS = [];
globalThis.fetch = (...a) => {
  NET_ATTEMPTS.push(String(a[0]).slice(0, 200));
  throw new Error('NET BLOCKED BY SPY: a real fetch was attempted');
};

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);

const WS = await import('../src/brain/working-state.js');
const {
  listFoundations, refreshFoundationsFromRepo, initFoundations, setFoundationReadFirst,
  readWorkingState, MAX_FOUNDATION_BYTES, FOUNDATIONS_DIRNAME, FOUNDATIONS_MANIFEST_FILENAME,
} = WS;
const GH = await import('../src/brain/github-read-client.js');
const adapterMod = await import('../src/brain/sharedbrain-github-adapter.js');

// ── Harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err !== undefined) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err === undefined ? 'assertion failed' : err); }
function eq(a, b, label) { assert(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(name) { console.log(`\n── ${name} ──`); }

let skipped = 0;
function skip(label) { skipped++; console.log(`  ⊘ ${label}`); }
/** Real git, for the ONE assertion that needs a checkout with an `origin`. */
const gitOk = (() => {
  try { return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
})();

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const gitBlobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ── Fixtures ─────────────────────────────────────────────────────────────
const D = 'rdom';
const PROJ = 'sat';                       // a repo-owned project, no checkout
mkdirSync(path.join(DOMAINS, D, 'wiki'), { recursive: true });
writeFileSync(path.join(DOMAINS, D, 'CLAUDE.md'), `# ${D}\n`);

const fdir = (project) => path.join(DOMAINS, D, 'state', project, FOUNDATIONS_DIRNAME);
const manifestPath = (project) => path.join(fdir(project), FOUNDATIONS_MANIFEST_FILENAME);
const manifestOf = (project) => JSON.parse(readFileSync(manifestPath(project), 'utf8'));
const docOf = (project, slug) => readFileSync(path.join(fdir(project), slug), 'utf8');

/**
 * The fixture tokens. Real-SHAPED, so the redaction patterns in
 * `github-read-client.js` really apply to them and §8's leak audit is
 * measuring the thing it claims to.
 *
 * Both values are ones ALREADY on `.git/hooks/secret-allowlist` — the
 * pre-commit secret guard scans staged content and refuses a token shape, and
 * reusing an existing allow-listed value is cheaper and safer than widening
 * the list, which the git-hygiene skill asks to be done by exact value and
 * never by path or pattern.
 */
const CONFIG_TOKEN = 'github_pat_TESTONLY_SHOULD_NEVER_APPEAR_0123456789';
const SYNC_TOKEN = 'ghp_thisisasecretpatdonotleak1234abcdABCD';
function seedTokens({ config = true, sync = true } = {}) {
  writeFileSync(path.join(USER_DATA, '.curator-config.json'),
    JSON.stringify(config ? { githubReadToken: CONFIG_TOKEN } : {}, null, 2));
  writeFileSync(path.join(USER_DATA, '.sync-config.json'),
    JSON.stringify(sync ? { repoUrl: 'https://github.com/o/knowledge', token: SYNC_TOKEN } : {}, null, 2));
}
seedTokens();

// ── A FAKE GITHUB ────────────────────────────────────────────────────────
//
// A repository is a Map of path → string. Blob shas are computed the way git
// computes them, which is what makes the "unchanged without a fetch" path
// testable at all rather than merely asserted.
function makeGitHub(files, opts = {}) {
  const calls = [];
  const state = {
    files: new Map(Object.entries(files)),
    defaultBranch: opts.defaultBranch || 'main',
    commit: opts.commit || 'a'.repeat(40),
    truncated: !!opts.truncated,
    // A queue of statuses to answer with before behaving normally, e.g.
    // [500, 500] to exercise the retry ladder.
    statusQueue: (opts.statusQueue || []).slice(),
    rateRemaining: opts.rateRemaining ?? 5000,
    forceStatus: opts.forceStatus || null,
    blobFailFor: opts.blobFailFor || null,
    sizeOverride: opts.sizeOverride || null,
    knownRefs: opts.knownRefs || [],
  };
  const json = (body, status = 200, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (headers[k.toLowerCase()] ?? null) },
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  });
  const rateHeaders = () => ({ 'x-ratelimit-remaining': String(state.rateRemaining), 'x-ratelimit-reset': '1750000000' });

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init && init.method, headers: init && init.headers });
    if (state.statusQueue.length) {
      const s = state.statusQueue.shift();
      return json({ message: 'transient' }, s, rateHeaders());
    }
    if (state.forceStatus) {
      const s = state.forceStatus;
      return json({ message: 'GitHub said no' }, s,
        s === 429 || s === 403 ? { ...rateHeaders(), 'x-ratelimit-remaining': String(state.rateRemaining) } : rateHeaders());
    }
    const u = new URL(String(url));
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) return json({ message: 'no route' }, 404, rateHeaders());
    const rest = m[3] || '';
    if (rest === '') return json({ default_branch: state.defaultBranch }, 200, rateHeaders());
    const commits = /^\/commits\/(.+)$/.exec(rest);
    if (commits) {
      // A ref this repository does not have is a 404, so a client that
      // GUESSES 'main' instead of resolving the default branch fails here
      // rather than passing by luck.
      const want = decodeURIComponent(commits[1]);
      if (want !== state.defaultBranch && !state.knownRefs.includes(want)) {
        return json({ message: 'No commit found for SHA: ' + want }, 404, rateHeaders());
      }
      return json({ sha: state.commit }, 200, rateHeaders());
    }
    const tree = /^\/git\/trees\/(.+)$/.exec(rest);
    if (tree) {
      // GitHub returns only the TOP level unless `recursive=1` is asked for,
      // and the fixture honours that — otherwise a client that forgot the
      // flag would look correct here and mirror nothing in production.
      const recursive = /[?&]recursive=1/.test(String(url));
      const visible = [...state.files].filter(([p]) => recursive || !p.includes('/'));
      const entries = visible.map(([p, content]) => {
        const buf = Buffer.from(content, 'utf8');
        return { path: p, type: 'blob', sha: gitBlobSha(buf), size: state.sizeOverride ?? buf.length };
      });
      return json({ tree: entries, truncated: state.truncated }, 200, rateHeaders());
    }
    const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
    if (blob) {
      const hit = [...state.files].find(([, c]) => gitBlobSha(Buffer.from(c, 'utf8')) === blob[1]);
      // One named file's blob can be made to fail, so a failure MID-LOOP —
      // after other blobs are already in hand — is drivable.
      if (hit && state.blobFailFor && hit[0] === state.blobFailFor) {
        return json({ message: 'boom' }, 500, rateHeaders());
      }
      if (!hit) return json({ message: 'Not Found' }, 404, rateHeaders());
      return json({ content: Buffer.from(hit[1], 'utf8').toString('base64'), encoding: 'base64' }, 200, rateHeaders());
    }
    const contents = /^\/contents\/(.+)$/.exec(rest);
    if (contents) {
      const p = decodeURIComponent(contents[1].split('?')[0]);
      if (!state.files.has(p)) return json({ message: 'Not Found' }, 404, rateHeaders());
      const buf = Buffer.from(state.files.get(p), 'utf8');
      return json({ content: buf.toString('base64'), sha: gitBlobSha(buf) }, 200, rateHeaders());
    }
    return json({ message: 'no route' }, 404, rateHeaders());
  };
  return { fetchImpl, calls, state };
}

const ARCH = '# Architecture\n\nHow it hangs together. Visit https://example.com for more.\n';
const DEC = '# Decisions\n\n0001 — use markdown.\n';
const REPO_FILES = { 'docs/architecture.md': ARCH, 'docs/decisions.md': DEC, 'README.md': '# Readme\n' };

/** A repo-owned project whose manifest names a REMOTE and no reachable root. */
async function seedRemoteProject(project, {
  remote = { owner: 'acme', repo: 'thing', ref: null, path: null },
  files = [],
  root = path.join(TMP, 'not-here-at-all'),
} = {}) {
  mkdirSync(fdir(project), { recursive: true });
  writeFileSync(manifestPath(project), JSON.stringify({
    version: 1,
    ownership: 'repo',
    repo: { root, remote, lastRefreshAt: null, lastRefreshCommit: null },
    budgetBytes: 200 * 1024,
    order: ['architecture', 'decisions', 'conventions', 'roadmap', 'api', 'guide', 'other'],
    documents: files,
  }, null, 2) + '\n');
}

const sleepSpy = [];
const fakeSleep = async (ms) => { sleepSpy.push(ms); };

// ═════════════════════════════════════════════════════════════════════════
section('1. The read client is READ-ONLY, and its grammar');
{
  const src = readFileSync(new URL('../src/brain/github-read-client.js', import.meta.url), 'utf8');
  // A source scan is weak on its own (v3.0.17's rule) — §2 measures every
  // request's method behaviourally. This is the cheap independent check that
  // no write verb exists to be reached at all.
  assert(!/method:\s*['"](PUT|POST|DELETE|PATCH)['"]/.test(src), 'the client names no write verb anywhere in its source');
  assert((src.match(/method:\s*'GET'/g) || []).length >= 1, '(control) it DOES name GET — the scan can see a method literal');

  for (const [input, want] of [
    ['git@github.com:acme/thing.git', 'acme/thing'],
    ['git@github.com:acme/thing', 'acme/thing'],
    ['https://github.com/acme/thing.git', 'acme/thing'],
    ['https://github.com/acme/thing', 'acme/thing'],
    ['https://user@github.com/acme/thing', 'acme/thing'],
    ['ssh://git@github.com/acme/thing.git', 'acme/thing'],
    ['https://www.github.com/acme/thing', 'acme/thing'],
    ['acme/thing', 'acme/thing'],
  ]) {
    const r = GH.parseGitHubRemote(input);
    eq(r ? `${r.owner}/${r.repo}` : null, want, `remote ${JSON.stringify(input)}`);
  }
  for (const evil of [
    'git@gitlab.com:acme/thing.git', 'https://gitlab.com/acme/thing',
    'https://github.example.com/acme/thing',            // NOT github.com
    'https://github.com/acme', 'https://github.com/a/b/c',
    'https://github.com.evil.test/acme/thing',
    '../../etc/passwd', '', null, 42, {},
  ]) {
    eq(GH.parseGitHubRemote(evil), null, `remote ${JSON.stringify(String(evil)).slice(0, 40)} is REFUSED`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('2. The token: which file, never the value — and GET only');
{
  seedTokens();
  const c = GH.readGitHubReadToken('config');
  assert(c.ok && c.token === CONFIG_TOKEN && c.source === 'config', 'the config arm reads githubReadToken from .curator-config.json');
  const s = GH.readGitHubReadToken('sync');
  assert(s.ok && s.token === SYNC_TOKEN && s.source === 'sync', 'the sync arm reads the Personal Sync PAT, only when ASKED');
  eq(GH.readGitHubReadToken('anything-else').source, 'config', 'an unknown source falls back to config, never to the sync PAT');

  seedTokens({ config: false, sync: true });
  const none = GH.readGitHubReadToken('config');
  assert(!none.ok && none.reason === 'no-token', 'no config token is a named refusal');
  assert(/githubReadToken/.test(none.message) && !none.message.includes(SYNC_TOKEN),
    '...naming the KEY to set, and never leaking the sync token that IS there', none.message);
  seedTokens();

  const gh = makeGitHub(REPO_FILES);
  const client = GH.createGitHubReadClient({ token: CONFIG_TOKEN, fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  const head = await client.getRef('acme', 'thing', null);
  eq(head.sha, 'a'.repeat(40), 'a null ref resolves the DEFAULT branch to a commit sha');
  eq(head.ref, 'main', '...and reports which branch it resolved');
  const tree = await client.getTree('acme', 'thing', head.sha, { recursive: true });
  eq(tree.entries.length, 3, 'the tree lists the blobs');
  const blob = await client.getBlob('acme', 'thing', gitBlobSha(Buffer.from(ARCH, 'utf8')));
  eq(blob.buf.toString('utf8'), ARCH, 'a blob comes back as the EXACT bytes');
  assert(gh.calls.every((c2) => c2.method === 'GET'), 'every request the client made was a GET',
    gh.calls.map((c2) => c2.method).join(','));
  assert(gh.calls.every((c2) => !String(c2.url).includes(CONFIG_TOKEN)),
    'the token is never in a URL or a query string');
  assert(gh.calls.every((c2) => c2.headers && c2.headers.Authorization === `Bearer ${CONFIG_TOKEN}`),
    'it travels as a header and nowhere else');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. Retries, rate limits and the refusals that never retry');
{
  sleepSpy.length = 0;
  const gh = makeGitHub(REPO_FILES, { statusQueue: [500, 503] });
  const client = GH.createGitHubReadClient({ token: CONFIG_TOKEN, fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  const head = await client.getRef('acme', 'thing', 'main');
  eq(head.sha, 'a'.repeat(40), 'two 5xx then a 200: the third attempt succeeds');
  eq(JSON.stringify(sleepSpy), JSON.stringify([GH.READ_BACKOFF_MS, GH.READ_BACKOFF_MS * 2]),
    '...after the growing backoff the adapter uses, 250 then 500 ms');

  sleepSpy.length = 0;
  const gh3 = makeGitHub(REPO_FILES, { statusQueue: [500, 500, 500] });
  const c3 = GH.createGitHubReadClient({ token: CONFIG_TOKEN, fetchImpl: gh3.fetchImpl, sleepImpl: fakeSleep });
  let threw = null;
  try { await c3.getRef('acme', 'thing', 'main'); } catch (e) { threw = e; }
  eq(threw && threw.code, GH.READ_ERROR_CODES.HTTP, 'three 5xx exhausts the ladder under a named code');
  eq(gh3.calls.length, 3, '...having made exactly READ_ATTEMPTS requests');

  // A 404 is NOT retried — it is an answer, not a blip.
  const gh4 = makeGitHub(REPO_FILES, { forceStatus: 404 });
  const c4 = GH.createGitHubReadClient({ token: CONFIG_TOKEN, fetchImpl: gh4.fetchImpl, sleepImpl: fakeSleep });
  threw = null;
  try { await c4.getRef('acme', 'thing', 'main'); } catch (e) { threw = e; }
  eq(threw && threw.code, GH.READ_ERROR_CODES.NOT_FOUND, 'a 404 is a named refusal');
  eq(gh4.calls.length, 1, '...on the FIRST attempt — a 404 is never retried');
  assert(/fine-grained token scoped to another repository answers 404/.test(threw.message),
    '...and explains the scope, which is the likeliest cause', threw.message);

  // An EXHAUSTED primary rate limit is not retried either: the reset can be
  // an hour away, and three attempts would only spend the wait.
  const gh5 = makeGitHub(REPO_FILES, { forceStatus: 403, rateRemaining: 0 });
  const c5 = GH.createGitHubReadClient({ token: CONFIG_TOKEN, fetchImpl: gh5.fetchImpl, sleepImpl: fakeSleep });
  threw = null;
  try { await c5.getRef('acme', 'thing', 'main'); } catch (e) { threw = e; }
  eq(threw && threw.code, GH.READ_ERROR_CODES.RATE_LIMIT, 'an exhausted rate limit is its own code');
  eq(gh5.calls.length, 1, '...and is NOT retried');

  // ...while a 429 with budget left IS transient (secondary limit) and is.
  const gh6 = makeGitHub(REPO_FILES, { statusQueue: [429] });
  const c6 = GH.createGitHubReadClient({ token: CONFIG_TOKEN, fetchImpl: gh6.fetchImpl, sleepImpl: fakeSleep });
  eq((await c6.getRef('acme', 'thing', 'main')).sha, 'a'.repeat(40), 'a 429 with requests remaining is retried and succeeds');

  // The rate-limit WARNING reaches the caller's channel, once.
  const warns = [];
  const gh7 = makeGitHub(REPO_FILES, { rateRemaining: 12 });
  const c7 = GH.createGitHubReadClient({ token: CONFIG_TOKEN, fetchImpl: gh7.fetchImpl, sleepImpl: fakeSleep, onWarn: (m) => warns.push(m) });
  await c7.getRef('acme', 'thing', 'main');
  await c7.getTree('acme', 'thing', 'a'.repeat(40), {});
  eq(warns.length, 1, 'rate-limit pressure warns ONCE per client, not once per request');
  assert(/12 requests left/.test(warns[0]), '...naming the number left', warns[0]);
}

// ═════════════════════════════════════════════════════════════════════════
section('3b. The default branch is RESOLVED, and bad coordinates are refused');
{
  // A repository whose default branch is NOT `main`. Guessing the common
  // name would mirror nothing here — and on a real repository it would
  // mirror the WRONG commit silently, which is worse.
  const gh = makeGitHub(REPO_FILES, { defaultBranch: 'trunk' });
  const client = GH.createGitHubReadClient({ token: CONFIG_TOKEN, fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  // A THROW MUST RED, NOT CRASH. A client that guessed `main` here answers
  // the fixture's 404 by throwing, and an unguarded `await` exits 1 with no
  // named failure — the shape §4's manifest lookup hit and v3.60.0 recorded.
  let head = null, headErr = null;
  try { head = await client.getRef('acme', 'thing', null); } catch (e) { headErr = e; }
  assert(head !== null, 'resolving a null ref does not throw', headErr && `${headErr.code}: ${headErr.message}`);
  eq(head && head.ref, 'trunk', 'a null ref resolves the repository\'s OWN default branch, never a guessed "main"');
  assert(gh.calls.some((c) => /\/repos\/acme\/thing$/.test(c.url)),
    '...by asking the repository, which costs the one extra call it is worth');

  // The CLIENT's own owner/repo grammar, at its boundary.
  for (const [owner, repo, label] of [
    ['bad owner!', 'thing', 'an owner with a space'],
    ['acme', 'th ing', 'a repository with a space'],
    ['../../etc', 'thing', 'an owner carrying traversal'],
    ['', 'thing', 'an empty owner'],
  ]) {
    let threw = null;
    try { await client.getRef(owner, repo, 'trunk'); } catch (e) { threw = e; }
    eq(threw && threw.code, GH.READ_ERROR_CODES.MALFORMED, `${label} is refused before any request`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('4. A machine with NO checkout mirrors from GitHub');
{
  await seedRemoteProject(PROJ);
  const gh = makeGitHub(REPO_FILES);
  const out = await refreshFoundationsFromRepo(D, PROJ, null, {
    source: 'remote',
    fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep,
    files: [
      { path: 'docs/architecture.md', role: 'architecture' },
      { path: 'docs/decisions.md', role: 'decisions' },
    ],
  });
  assert(out.ok, 'a remote refresh succeeds with no checkout on this machine', out.message || out.reason);
  eq(out.source, 'remote', 'the result names the arm');
  eq(out.remoteChecked, true, 'remoteChecked is true — GitHub WAS asked');
  eq(out.remoteCommit, 'a'.repeat(40), 'remoteCommit is the resolved commit sha');
  eq(out.remoteError, null, 'remoteError is null on success');
  eq(out.repoRoot, null, 'repoRoot is NULL — no folder on this computer was read');
  eq(out.tokenSource, 'config', 'the token source is named (never the token)');
  eq(JSON.stringify(out.added.sort()), JSON.stringify(['architecture.md', 'decisions.md']), 'both documents arrived');

  eq(docOf(PROJ, 'architecture.md'), ARCH, 'the bytes on disk are the repository\'s, verbatim');
  const man = manifestOf(PROJ);
  // A MISSING ENTRY MUST RED, NOT CRASH. A manifest written without its
  // documents used to throw a TypeError here, which exits 1 without a single
  // named failure — the shape v3.60.0 recorded and hardened twice.
  const arch = man.documents.find((d) => d.slug === 'architecture.md') || {};
  assert(arch.slug === 'architecture.md', 'the manifest LISTS the document it just wrote', JSON.stringify(man.documents.map((d) => d.slug)));
  eq(arch.sha256, sha256(Buffer.from(ARCH, 'utf8')), 'the manifest records sha256 over the STORED BYTES');
  eq(arch.commit, 'a'.repeat(40), '...and the commit it came from');
  eq(arch.source.path, 'docs/architecture.md', '...and the path inside the repository');
  eq(man.repo.remote.owner, 'acme', 'repo.remote is written — its first real writer');
  eq(man.repo.remote.repo, 'thing', '...with the repository');
  eq(man.repo.lastRefreshCommit, 'a'.repeat(40), '...and lastRefreshCommit is the remote commit');
  eq(man.ownership, 'repo', 'ownership is UNCHANGED — a remote mirror is still a repo mirror');
  assert(man.repo.root !== null, 'repo.root is KEPT: the machine that has a checkout still has one');

  const idx = await listFoundations(D, PROJ);
  eq(idx.remoteMirror, true, 'the index says a GitHub mirror is available');
  eq(idx.remoteChecked, false, 'a READ asks GitHub nothing — remoteChecked is false by design');
  eq(idx.remoteCommit, 'a'.repeat(40), '...and reports the commit the last refresh stored');
  eq(idx.remoteError, null, 'a call that is not made cannot fail');
  // THE MCP SUMMARY DELIBERATELY DOES NOT CARRY THEM — a budget decision,
  // pinned here so it stays one rather than becoming an oversight:
  // test-mcp-working-state.js D3 bounds an empty project's cold-start read at
  // 1,000 bytes, and three more fields measured 1,066.
  const sum = await readWorkingState(D, { project: PROJ });
  eq(sum.foundations.remoteMirror, undefined, 'the MCP summary does NOT carry the remote readings');
  eq(sum.foundations.staleCount, 0, '(control) it DOES carry the tier-0 summary — the assertion above is not measuring an absent object');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. `readFirst` survives a remote re-copy; a changed blob is re-copied');
{
  const flag = await setFoundationReadFirst(D, PROJ, 'architecture.md', true);
  assert(flag.ok, 'the owner flags architecture.md as read-first', flag.message);

  // An UNCHANGED repository: nothing should be fetched at all, because the
  // stored copy already hashes to the tree's blob sha.
  const ghSame = makeGitHub(REPO_FILES);
  const same = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'remote', fetchImpl: ghSame.fetchImpl, sleepImpl: fakeSleep });
  assert(same.ok, 'a second refresh over an unchanged repository succeeds', same.message);
  eq(JSON.stringify(same.unchanged.sort()), JSON.stringify(['architecture.md', 'decisions.md']), 'both read UNCHANGED');
  eq(same.refreshed.length, 0, '...and nothing was re-copied');
  eq(ghSame.calls.filter((c) => /\/git\/blobs\//.test(c.url)).length, 0,
    'ZERO blobs were fetched — git\'s own blob sha answered it from the tree');

  // Now CHANGE one file upstream.
  const ARCH2 = ARCH + '\nA new paragraph upstream.\n';
  const ghNew = makeGitHub({ ...REPO_FILES, 'docs/architecture.md': ARCH2 }, { commit: 'b'.repeat(40) });
  const moved = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'remote', fetchImpl: ghNew.fetchImpl, sleepImpl: fakeSleep });
  assert(moved.ok, 'the refresh over a CHANGED repository succeeds', moved.message);
  eq(JSON.stringify(moved.refreshed), JSON.stringify(['architecture.md']), 'the changed document is re-copied');
  eq(JSON.stringify(moved.unchanged), JSON.stringify(['decisions.md']), '...and the unchanged one is not');
  eq(docOf(PROJ, 'architecture.md'), ARCH2, 'the new bytes are on disk');
  const man = manifestOf(PROJ);
  // A MISSING ENTRY MUST RED, NOT CRASH. A manifest written without its
  // documents used to throw a TypeError here, which exits 1 without a single
  // named failure — the shape v3.60.0 recorded and hardened twice.
  const arch = man.documents.find((d) => d.slug === 'architecture.md') || {};
  assert(arch.slug === 'architecture.md', 'the manifest LISTS the document it just wrote', JSON.stringify(man.documents.map((d) => d.slug)));
  eq(arch.sha256, sha256(Buffer.from(ARCH2, 'utf8')), 'the manifest sha256 moved with it');
  eq(arch.commit, 'b'.repeat(40), '...and the commit');
  eq(arch.readFirst, true, 'readFirst SURVIVED the re-copy — the repo owns the bytes, the owner owns the routing');
  eq(arch.skeleton, false, 'a mirrored document is never a skeleton');
  eq(ghNew.calls.filter((c) => /\/git\/blobs\//.test(c.url)).length, 1,
    'exactly ONE blob was fetched — only the file that moved');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. A vanished path is `missing` and its copy is KEPT');
{
  const before = docOf(PROJ, 'decisions.md');
  const gone = { 'docs/architecture.md': ARCH + '\nA new paragraph upstream.\n', 'README.md': '# Readme\n' };
  const gh = makeGitHub(gone, { commit: 'c'.repeat(40) });
  const out = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'remote', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  assert(out.ok, 'the refresh still succeeds', out.message);
  eq(JSON.stringify(out.missing), JSON.stringify(['docs/decisions.md']), 'the vanished source is reported missing');
  eq(docOf(PROJ, 'decisions.md'), before, '...and its stored copy is untouched — the last known good text');
  const man = manifestOf(PROJ);
  assert(man.documents.some((d) => d.slug === 'decisions.md'), '...and its manifest entry is kept, never deleted');
  assert((out.notes || []).some((n) => /missing/.test(n) && /acme\/thing/.test(n)),
    'a note names the repository the file is absent from', JSON.stringify(out.notes));
}

// ═════════════════════════════════════════════════════════════════════════
section('7. A TRUNCATED tree refuses loudly and writes NOTHING');
{
  const manBefore = sha256(readFileSync(manifestPath(PROJ)));
  const docBefore = sha256(readFileSync(path.join(fdir(PROJ), 'architecture.md')));
  const gh = makeGitHub({ ...REPO_FILES, 'docs/architecture.md': '# Completely different\n' }, { truncated: true, commit: 'd'.repeat(40) });
  const out = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'remote', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  eq(out.ok, false, 'a truncated file listing is REFUSED');
  eq(out.reason, 'remote-tree-truncated', '...under its own reason');
  eq(out.remoteChecked, true, '...with remoteChecked true — GitHub WAS asked');
  eq(out.remoteError, GH.READ_ERROR_CODES.TREE_TRUNCATED, '...and the error code named');
  assert(/silently|stale copy|Nothing was copied/i.test(out.message), '...saying what it would otherwise have done', out.message);
  eq(gh.calls.filter((c) => /\/git\/blobs\//.test(c.url)).length, 0, 'not one blob was fetched');
  eq(sha256(readFileSync(manifestPath(PROJ))), manBefore, 'the manifest on disk is byte-identical');
  eq(sha256(readFileSync(path.join(fdir(PROJ), 'architecture.md'))), docBefore, '...and so is every document');
}

// ═════════════════════════════════════════════════════════════════════════
section('7b. A blob that fails MID-LOOP writes nothing, not half a mirror');
{
  // The hardest of the four silent defects: the FIRST document downloads
  // fine and the SECOND does not. A loop that wrote as it went would leave
  // one new document beside a manifest that still describes the old one —
  // the exact shape "the manifest is written LAST" exists to prevent, one
  // level up. Everything is fetched before anything is written, so the
  // measurement is: both files on disk byte-identical afterwards.
  const A2 = ARCH + '\nChanged upstream A.\n';
  const D2 = DEC + '\nChanged upstream B.\n';
  const manBefore = sha256(readFileSync(manifestPath(PROJ)));
  const archBefore = sha256(readFileSync(path.join(fdir(PROJ), 'architecture.md')));
  const decBefore = sha256(readFileSync(path.join(fdir(PROJ), 'decisions.md')));
  const gh = makeGitHub({ 'docs/architecture.md': A2, 'docs/decisions.md': D2 },
    { commit: 'e'.repeat(40), blobFailFor: 'docs/decisions.md' });
  const out = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'remote', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  eq(out.ok, false, 'a blob that will not download refuses the whole refresh');
  eq(out.reason, 'remote-http', '...under the upstream reason');
  assert(gh.calls.filter((c) => /\/git\/blobs\//.test(c.url)).length >= 2,
    'PRECONDITION: the first blob really was fetched before the second failed',
    gh.calls.filter((c) => /\/git\/blobs\//.test(c.url)).length);
  eq(sha256(readFileSync(path.join(fdir(PROJ), 'architecture.md'))), archBefore,
    'the document that DID download was not written');
  eq(sha256(readFileSync(path.join(fdir(PROJ), 'decisions.md'))), decBefore, '...nor the one that did not');
  eq(sha256(readFileSync(manifestPath(PROJ))), manBefore, '...and the manifest is byte-identical');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. A 401 names the token\'s SOURCE — and the token appears nowhere');
{
  const manBefore = sha256(readFileSync(manifestPath(PROJ)));
  for (const [label, status] of [['a 401', 401], ['a 403 with budget left', 403]]) {
    const gh = makeGitHub(REPO_FILES, { forceStatus: status });
    const out = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'remote', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
    eq(out.ok, false, `${label} is refused`);
    eq(out.reason, 'unauthorised', '...under the reason a client can match on');
    eq(out.tokenSource, 'config', '...naming WHICH file the token came from');
    assert(/curator-config\.json/i.test(out.message), '...in the sentence too', out.message);
    assert(/fine-grained token can only read the repository it was/.test(out.message),
      '...with the scope explanation attached, the likeliest first failure', out.message);
    assert(!out.message.includes(CONFIG_TOKEN), 'THE TOKEN IS NOT IN THE MESSAGE');
    assert(!JSON.stringify(out).includes(CONFIG_TOKEN), '...nor anywhere in the result object');
  }
  eq(sha256(readFileSync(manifestPath(PROJ))), manBefore, 'and nothing was written');

  // The sync arm names ITSELF, so a user fixes the right credential.
  const gh = makeGitHub(REPO_FILES, { forceStatus: 401 });
  const out = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'remote', tokenSource: 'sync', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  eq(out.tokenSource, 'sync', 'the sync arm reports its own source');
  assert(/Personal Sync/.test(out.message) && !out.message.includes(SYNC_TOKEN),
    '...by name, and without the PAT', out.message);

  // THE WHOLE TEMPDIR, grepped. A token that reached a written file would be
  // invisible to every assertion above.
  const offenders = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      if (p === path.join(USER_DATA, '.curator-config.json') || p === path.join(USER_DATA, '.sync-config.json')) continue;
      if (statSync(p).size > 4 * 1024 * 1024) continue;
      const t = readFileSync(p, 'utf8');
      if (t.includes(CONFIG_TOKEN) || t.includes(SYNC_TOKEN)) offenders.push(p);
    }
  })(TMP);
  eq(offenders.length, 0, 'NO file under the tempdir holds either token, except the two that are meant to', offenders.join(', '));
}

// ═════════════════════════════════════════════════════════════════════════
section('9. The 512 KB per-document cap, over the wire');
{
  const BIG = 'x'.repeat(MAX_FOUNDATION_BYTES + 10);
  await seedRemoteProject('bigproj');
  const gh = makeGitHub({ 'docs/huge.md': BIG });
  const out = await refreshFoundationsFromRepo(D, 'bigproj', null, {
    source: 'remote', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep,
    files: [{ path: 'docs/huge.md', role: 'other' }],
  });
  assert(out.ok, 'the refresh completes — one refused document is not a failed refresh', out.message);
  eq(out.added.length, 0, 'the over-cap document was NOT stored');
  const r = (out.refused || []).find((x) => /huge/.test(x.path || ''));
  assert(r && new RegExp(String(MAX_FOUNDATION_BYTES)).test(r.reason) && /\b524298\b/.test(r.reason),
    'it is refused with BOTH byte counts named — a verbatim document cannot be trimmed honestly',
    JSON.stringify(r));
  eq(gh.calls.filter((c) => /\/git\/blobs\//.test(c.url)).length, 0,
    'and it was refused off the TREE\'s size, so its bytes were never downloaded');
  assert(!existsSync(path.join(fdir('bigproj'), 'huge.md')), 'nothing landed on disk');

  // A TREE THAT UNDER-REPORTS. The size check off the listing is the cheap
  // guard; the one after the download is the load-bearing one, and without a
  // lying tree nothing could tell them apart. GitHub has no reason to lie —
  // but a cap that is only enforced by an upstream's honesty is not a cap.
  await seedRemoteProject('bigproj2');
  const gh2 = makeGitHub({ 'docs/huge.md': BIG }, { sizeOverride: 10 });
  const out2 = await refreshFoundationsFromRepo(D, 'bigproj2', null, {
    source: 'remote', fetchImpl: gh2.fetchImpl, sleepImpl: fakeSleep,
    files: [{ path: 'docs/huge.md', role: 'other' }],
  });
  assert(out2.ok, 'the refresh still completes', out2.message);
  eq(out2.added.length, 0, 'a document the TREE said was 10 bytes is still refused once its bytes are in hand');
  assert(!existsSync(path.join(fdir('bigproj2'), 'huge.md')), '...and still never lands on disk');
  eq(gh2.calls.filter((c) => /\/git\/blobs\//.test(c.url)).length, 1,
    '(control) it really was downloaded first — the second guard is the one that fired');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. `auto` takes the checkout when it is here, and asks GitHub nothing');
{
  mkdirSync(path.join(CHECKOUT, 'docs'), { recursive: true });
  writeFileSync(path.join(CHECKOUT, 'docs', 'architecture.md'), ARCH);
  const P2 = 'localproj';
  await WS.createProject(D, P2, {});
  const init = await initFoundations(D, P2, {
    ownership: 'repo', repoRoot: CHECKOUT,
    files: [{ path: 'docs/architecture.md', role: 'architecture' }],
  });
  assert(init.ok, 'a project is mirrored from a real checkout', init.message);

  // Point its manifest at a remote too, so BOTH arms are available.
  const man = manifestOf(P2);
  man.repo.remote = { owner: 'acme', repo: 'thing', ref: null, path: null };
  writeFileSync(manifestPath(P2), JSON.stringify(man, null, 2) + '\n');

  const gh = makeGitHub({ 'docs/architecture.md': '# NOT what the checkout says\n' });
  const out = await refreshFoundationsFromRepo(D, P2, CHECKOUT, { source: 'auto', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  assert(out.ok, 'auto succeeds', out.message);
  eq(out.source, 'local', 'auto took the LOCAL arm — the checkout is here');
  eq(out.remoteChecked, false, '...so GitHub was not asked');
  eq(gh.calls.length, 0, '...and not one HTTP request was made');
  eq(docOf(P2, 'architecture.md'), ARCH, 'the bytes are the checkout\'s, not the fake remote\'s');
  eq(out.repoRoot !== null, true, '...and the root it read is named');

  // ── THE CHECKOUT'S `origin` IS RECORDED, which is what makes the remote
  // arm reachable AT ALL on a second machine. Without this, `repo.remote`
  // stays null for ever and every other assertion in this file describes a
  // feature nobody can switch on.
  if (gitOk) {
    const P3 = 'originproj';
    const CO2 = path.join(TMP, 'checkout2');
    mkdirSync(path.join(CO2, 'docs'), { recursive: true });
    writeFileSync(path.join(CO2, 'docs', 'architecture.md'), ARCH);
    const git = (...args) => spawnSync('git', ['-C', CO2, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'git@github.com:acme/from-origin.git');
    await WS.createProject(D, P3, {});
    const init3 = await initFoundations(D, P3, {
      ownership: 'repo', repoRoot: CO2,
      files: [{ path: 'docs/architecture.md', role: 'architecture' }],
    });
    assert(init3.ok, 'a project is mirrored from a checkout that HAS an origin', init3.message);
    const man3 = manifestOf(P3);
    eq(man3.repo.remote && man3.repo.remote.owner, 'acme', 'the checkout\'s origin is recorded as repo.remote');
    eq(man3.repo.remote && man3.repo.remote.repo, 'from-origin', '...owner and repository both');
    eq(man3.repo.remote.ref, null, '...with no ref pinned, so the default branch is resolved at read time');

    // An origin the owner already decided about is NOT overwritten.
    man3.repo.remote = { owner: 'acme', repo: 'chosen-by-hand', ref: 'release', path: 'docs' };
    writeFileSync(manifestPath(P3), JSON.stringify(man3, null, 2) + '\n');
    const again = await refreshFoundationsFromRepo(D, P3, CO2, { source: 'local' });
    assert(again.ok, 'a second local refresh succeeds', again.message);
    const man4 = manifestOf(P3);
    eq(man4.repo.remote.repo, 'chosen-by-hand', 'a STORED remote is a decision and is never overwritten by `origin`');
    eq(man4.repo.remote.ref, 'release', '...ref and all');
  } else {
    skip('git is not installed — the `origin` recording assertions are skipped');
  }

  // `local` NAMED, with no checkout, refuses rather than quietly going remote.
  const named = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'local', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  eq(named.ok, false, 'source: local with no checkout is refused');
  eq(named.reason, 'repo-unreachable', '...under the reason it has always used');
  eq(gh.calls.length, 0, '...without silently doing the other thing');

  // AUTO with no checkout and no remote: BOTH arms impossible, both named.
  await seedRemoteProject('noremote', { remote: null });
  const both = await refreshFoundationsFromRepo(D, 'noremote', path.join(TMP, 'nope'), { source: 'auto', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  eq(both.ok, false, 'neither arm is possible');
  eq(both.reason, 'repo-unreachable', '...under the reason v3.59.0 established, so old callers still match');
  eq(both.arms.local.reason, 'repo-unreachable', '...with the LOCAL arm\'s reason named');
  eq(both.arms.remote.reason, 'no-remote', '...and the REMOTE arm\'s');

  // A remote that is recorded but unreadable as a URL.
  const badRemote = await refreshFoundationsFromRepo(D, PROJ, null, {
    source: 'remote', remote: 'https://gitlab.com/acme/thing', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep,
  });
  eq(badRemote.reason, 'invalid-remote', 'a non-GitHub remote is refused by name');
  eq(gh.calls.length, 0, '...before any request');

  // NO TOKEN: the remote arm is impossible, and both arms say why.
  seedTokens({ config: false, sync: false });
  const noTok = await refreshFoundationsFromRepo(D, PROJ, null, { source: 'remote', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep });
  eq(noTok.ok, false, 'no token is a refusal');
  eq(noTok.reason, 'no-token', '...under its own reason');
  eq(noTok.arms.remote.reason, 'no-token', '...with the remote arm\'s reason named');
  eq(gh.calls.length, 0, '...and no request was attempted');
  seedTokens();
}

// ═════════════════════════════════════════════════════════════════════════
section('10b. `remote.path` confines the mirror, as the root does locally');
{
  // The local arm's confinement comes from `realpath` + "outside the
  // repository root". Over the API there is no filesystem to resolve
  // against, so `repo.remote.path` is what plays that role — and a document
  // outside it must be REFUSED with the reason, never quietly mirrored.
  await seedRemoteProject('confined', { remote: { owner: 'acme', repo: 'thing', ref: null, path: 'docs' } });
  const gh = makeGitHub(REPO_FILES);
  const out = await refreshFoundationsFromRepo(D, 'confined', null, {
    source: 'remote', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep,
    files: [
      { path: 'docs/architecture.md', role: 'architecture' },
      { path: 'README.md', role: 'guide' },
    ],
  });
  assert(out.ok, 'the refresh completes', out.message);
  eq(JSON.stringify(out.added), JSON.stringify(['architecture.md']), 'the document inside docs/ is mirrored');
  const r = (out.refused || []).find((x) => /README/.test(x.path || ''));
  assert(r && /outside docs\//.test(r.reason), 'the one outside it is REFUSED, naming the folder', JSON.stringify(r));
  assert(!existsSync(path.join(fdir('confined'), 'readme.md')), '...and never landed on disk');

  // A `path` carrying traversal is dropped at the manifest validator rather
  // than stored — an advisory field must not widen the confinement it is.
  await seedRemoteProject('badpath', { remote: { owner: 'acme', repo: 'thing', ref: null, path: '../../etc' } });
  const idx = await listFoundations(D, 'badpath');
  eq(idx.repo.remote.path, null, 'a traversing remote.path reads back as null, never as a prefix');
  eq(idx.repo.remote.owner, 'acme', '(control) the rest of the remote survives — only the path was dropped');
}

// ═════════════════════════════════════════════════════════════════════════
section('11. The ROUTE, over a real Express dispatch, against the real store');
{
  const express = (await import('express')).default;
  const router = (await import('../src/routes/memory.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/memory', router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const post = async (url, body) => {
    const res = await REAL_FETCH(`http://127.0.0.1:${port}${url}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    // The route cannot take an injected fetch, so it drives the REAL client
    // against the REAL network — which the spy blocks. That is the point of
    // this section: it proves the route's plumbing (arms, statuses, the
    // token source) with the network genuinely unavailable.
    // ONE listed document, so the work list is non-empty and the arm really
    // reaches the network — an empty one short-circuits to `noop: true`
    // before any request, which is correct and would prove nothing here.
    await seedRemoteProject('routeproj', {
      remote: { owner: 'acme', repo: 'thing', ref: null, path: null },
      files: [{
        slug: 'architecture.md', role: 'architecture', title: 'Architecture',
        source: { kind: 'repo', path: 'docs/architecture.md' },
        sha256: sha256(Buffer.from(ARCH, 'utf8')), bytes: Buffer.byteLength(ARCH),
        updatedAt: new Date().toISOString(), commit: null,
      }],
    });
    writeFileSync(path.join(fdir('routeproj'), 'architecture.md'), ARCH);

    const r1 = await post(`/api/memory/${D}/routeproj/foundations/refresh`, { source: 'remote', tokenSource: 'config' });
    eq(r1.status, 502, 'a blocked network answers 502 — upstream, not a bad request');
    eq(r1.body.reason, 'remote-unreachable', '...under the store\'s own reason');
    eq(r1.body.remoteChecked ?? true, true, '...having tried');
    assert(!JSON.stringify(r1.body).includes(CONFIG_TOKEN), 'the token is not in the response');

    const r2 = await post(`/api/memory/${D}/routeproj/foundations/refresh`, { source: 'remote', tokenSource: 'sync' });
    eq(r2.status, 502, 'the sync arm reaches the same place');
    assert(NET_ATTEMPTS.length >= 2, 'the spy recorded the real fetch attempts, so both arms really tried',
      JSON.stringify(NET_ATTEMPTS.slice(0, 2)));
    assert(NET_ATTEMPTS.every((u) => u.startsWith('https://api.github.com/repos/acme/thing')),
      '...at api.github.com and nowhere else', NET_ATTEMPTS[0]);

    // NO TOKEN in either file: 409, and both arms named.
    seedTokens({ config: false, sync: false });
    const r3 = await post(`/api/memory/${D}/routeproj/foundations/refresh`, { source: 'remote' });
    eq(r3.status, 409, 'no token is a 409 — the server\'s state is not one the request can act on');
    eq(r3.body.reason, 'no-token', '...under its own reason');
    seedTokens();

    // NO ROOT AND NO REMOTE: the v3.59.0 409, with the original sentence kept.
    // NO root recorded AND no remote: the route's own 409, before the store.
    await seedRemoteProject('routenone', { remote: null, root: null });
    const r4 = await post(`/api/memory/${D}/routenone/foundations/refresh`, {});
    eq(r4.status, 409, 'neither arm is a 409');
    eq(r4.body.reason, 'repo_unreachable', '...under the wire spelling every other tier-0 route uses');
    assert(/pass the path/.test(r4.body.error), '...keeping the sentence a user with a checkout can act on', r4.body.error);
    assert(/nothing to read over the network/.test(r4.body.error), '...and naming the remote arm too', r4.body.error);
    eq(r4.body.arms.remote.reason, 'no_remote', '...with a machine-readable reason per arm');

    // THE LOCAL ARM IS UNCHANGED through the route: a real checkout, 200, and
    // the new fields present and false/null.
    const r5 = await post(`/api/memory/${D}/localproj/foundations/refresh`, {});
    eq(r5.status, 200, 'a local refresh through the route still answers 200');
    eq(r5.body.source, 'local', '...naming the arm');
    eq(r5.body.remoteChecked, false, '...with remoteChecked present and FALSE, never absent');
    eq(r5.body.remoteError, null, '...and remoteError null');
    eq(r5.body.tokenSource, null, '...and no token source, because none was needed');
    assert(typeof r5.body.repoRoot === 'string' && r5.body.repoRoot.length > 0, '...and the root it read named back');

    // ── NO ROOT, BUT A REMOTE: the arm is TRIED, not refused ───────────
    // Without this the route could answer 409 whenever no folder path is
    // recorded — which is the state of every machine this feature exists
    // for — and every other assertion here would still pass.
    await seedRemoteProject('routenoroot', { remote: { owner: 'acme', repo: 'thing', ref: null, path: null }, root: null });
    writeFileSync(path.join(fdir('routenoroot'), 'architecture.md'), ARCH);
    {
      const man = manifestOf('routenoroot');
      man.documents = [{
        slug: 'architecture.md', role: 'architecture', title: 'Architecture',
        source: { kind: 'repo', path: 'docs/architecture.md' },
        sha256: sha256(Buffer.from(ARCH, 'utf8')), bytes: Buffer.byteLength(ARCH),
        updatedAt: new Date().toISOString(), commit: null,
      }];
      writeFileSync(manifestPath('routenoroot'), JSON.stringify(man, null, 2) + '\n');
    }
    const r7 = await post(`/api/memory/${D}/routenoroot/foundations/refresh`, {});
    eq(r7.status, 502, 'no folder path but a RECORDED REMOTE: the arm is tried, not refused with a 409');
    eq(r7.body.reason, 'remote-unreachable', '...and the failure is the blocked network, not a missing root');

    // ── THE SUCCESS SHAPE, through the router ──────────────────────────
    // The remote arm cannot be driven over a real socket without a real
    // GitHub, so the STORE is stubbed at the router's own test seam — every
    // other field on this path is the router's, and a dropped one is this
    // file's recorded defect class (v3.17.1's `unlistedEntries`).
    const routerMod2 = await import('../src/routes/memory.js');
    const realStore = await import('../src/brain/working-state.js');
    const FAKE_OK = {
      ok: true, domain: D, project: 'routeproj', repoRoot: null,
      source: 'remote', remoteChecked: true, remoteCommit: 'f'.repeat(40), remoteError: null,
      remote: { owner: 'acme', repo: 'thing', ref: 'main', path: 'docs' },
      tokenSource: 'sync', commit: 'f'.repeat(40),
      refreshed: ['architecture.md'], unchanged: [], missing: [], added: [], refused: [],
      totalBytes: 10, budgetBytes: 200 * 1024, budgetExceeded: false, documentCount: 1, notes: [],
    };
    routerMod2.__setWorkingStateStoreForTest({ ...realStore, refreshFoundationsFromRepo: async () => FAKE_OK });
    try {
      const r8 = await post(`/api/memory/${D}/routeproj/foundations/refresh`, { source: 'remote' });
      eq(r8.status, 200, 'a successful remote refresh is a 200');
      eq(r8.body.source, 'remote', '...naming the arm');
      eq(r8.body.remoteChecked, true, '...FORWARDING remoteChecked rather than dropping it');
      eq(r8.body.remoteCommit, 'f'.repeat(40), '...and the commit the view prints');
      eq(r8.body.remoteError, null, '...and the error slot, empty');
      eq(r8.body.tokenSource, 'sync', '...and WHICH FILE the token came from');
      eq(r8.body.repoRoot, null, '...with repoRoot null — no folder on this computer was read');
      eq(JSON.stringify(r8.body.remote), JSON.stringify(FAKE_OK.remote), '...and the coordinates it read');
    } finally {
      routerMod2.__setWorkingStateStoreForTest(null);
    }

    // A CURATOR-OWNED project is still a 400 on every arm.
    await WS.createProject(D, 'curproj', {});
    const cur = await initFoundations(D, 'curproj', { ownership: 'curator', seed: false });
    assert(cur.ok, '(fixture) a curator-owned project exists', cur.message);
    const r6 = await post(`/api/memory/${D}/curproj/foundations/refresh`, { source: 'remote' });
    eq(r6.status, 400, 'curator-owned is still a 400');
    eq(r6.body.reason, 'curator_owned', '...unchanged by the remote arm');
  } finally {
    server.close();
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('12. The Shared Brain adapter DELEGATES rather than duplicating');
{
  const t = adapterMod.__testing;
  assert(t.sanitizeDetail === GH.sanitizeDetail, 'the adapter uses the shared token redactor — one implementation, not two');
  assert(t.encodePath === GH.encodePath, '...and the shared path encoder');
  eq(t.encodePath('a b/c#d'), 'a%20b/c%23d', '(control) it still encodes per segment and keeps the separator');
  eq(t.sanitizeDetail(`oops ${CONFIG_TOKEN} leaked`), 'oops [redacted-token] leaked', '(control) it still redacts a fine-grained PAT');
  assert(/the-curator-sharedbrain\//.test(t.USER_AGENT), 'the adapter\'s User-Agent string is unchanged in shape', t.USER_AGENT);
  eq(t.decodeContent(Buffer.from('héllo', 'utf8').toString('base64')), 'héllo', 'its base64 decode still returns a STRING');
}

// ═════════════════════════════════════════════════════════════════════════
section('13. A MIRROR BORN REMOTE — initFoundations with a `remote` (v3.65.0)');
{
  // THE GAP THIS CLOSES: `initFoundations` required an absolute path on THIS
  // machine for `ownership: 'repo'`, so a laptop with no checkout could
  // refresh a mirror somebody else started and could never start one.
  //
  // THE PROPERTY THAT MATTERS, AND IT IS THE OPPOSITE OF THE LOCAL ARM'S:
  // ownership is set ONCE and refused afterwards, and the remote arm has no
  // cheap way to verify the repository first, so NOTHING is written unless
  // every blob is in hand. A typo must leave the project choosable again.
  const gh1 = makeGitHub(REPO_FILES);
  await WS.createProject(D, 'born', {});
  const born = await initFoundations(D, 'born', {
    ownership: 'repo',
    remote: 'acme/thing',
    tokenSource: 'config',
    files: [{ path: 'docs/architecture.md' }, { path: 'docs/decisions.md' }],
    fetchImpl: gh1.fetchImpl, sleepImpl: fakeSleep,
  });
  assert(born.ok, 'a repo-owned project can be created from a GitHub remote with no checkout', born.message);
  eq(born.ownership, 'repo', '...with ownership repo');
  eq(born.refresh && born.refresh.source, 'remote', '...mirrored over the remote arm');
  eq(JSON.stringify((born.refresh.added || []).slice().sort()), JSON.stringify(['architecture.md', 'decisions.md']),
    '...copying the two documents named');
  eq(docOf('born', 'architecture.md'), ARCH, '...byte for byte');
  const bm = manifestOf('born');
  eq(bm.ownership, 'repo', 'the manifest records ownership repo');
  eq(bm.repo.root, null, '...with repo.root NULL — no folder on this computer was read');
  eq(bm.repo.remote.owner, 'acme', '...and the remote it mirrors');
  eq(bm.repo.remote.repo, 'thing', '...owner and repository both');
  eq(bm.repo.lastRefreshCommit, 'a'.repeat(40), '...stamped with the commit it read');
  eq(born.remote.owner, 'acme', 'the result names the remote back');
  eq(born.tokenSource, 'config', '...and WHICH FILE the token came from');
  assert(!JSON.stringify(born).includes(CONFIG_TOKEN), '...and never the token itself');

  // A SECOND init is refused, exactly as on the local arm.
  const again = await initFoundations(D, 'born', {
    ownership: 'curator', fetchImpl: gh1.fetchImpl,
  });
  eq(again.reason, 'ownership-set', 'ownership is still set ONCE — a second init is refused');

  // ── THE READ FAILS: NOTHING IS WRITTEN, AND THE PROJECT IS STILL FREE ──
  const gh2 = makeGitHub(REPO_FILES, { forceStatus: 404 });
  await WS.createProject(D, 'typo', {});
  const failed404 = await initFoundations(D, 'typo', {
    ownership: 'repo', remote: 'acme/thign',
    files: [{ path: 'docs/architecture.md' }],
    fetchImpl: gh2.fetchImpl, sleepImpl: fakeSleep,
  });
  eq(failed404.ok, false, 'a repository that cannot be read refuses the init');
  eq(failed404.reason, 'remote-not-found', '...under the read\'s own reason');
  eq(failed404.ownershipSet, false, '...saying in a field that no ownership was recorded');
  assert(!existsSync(manifestPath('typo')), '...and NO manifest was written');
  assert(/still unchosen/.test(failed404.message || ''), '...and the sentence says the choice can be made again',
    failed404.message);
  // …and it really can be made again, which is the whole point.
  const second = await initFoundations(D, 'typo', { ownership: 'curator', seed: false });
  assert(second.ok, 'the project can still choose an ownership afterwards', second.message);
  eq(manifestOf('typo').ownership, 'curator', '...and it takes');

  // A TRUNCATED TREE refuses before a single blob, and writes nothing.
  const gh3 = makeGitHub(REPO_FILES, { truncated: true });
  await WS.createProject(D, 'trunc', {});
  const truncInit = await initFoundations(D, 'trunc', {
    ownership: 'repo', remote: { owner: 'acme', repo: 'thing' },
    files: [{ path: 'docs/architecture.md' }],
    fetchImpl: gh3.fetchImpl, sleepImpl: fakeSleep,
  });
  eq(truncInit.reason, 'remote-tree-truncated', 'a truncated file listing refuses the init');
  assert(!existsSync(manifestPath('trunc')), '...with no manifest written');
  eq(gh3.calls.filter((c) => /git\/blobs\//.test(c.url)).length, 0, '...and no blob fetched at all');

  // NO FILES: the ownership manifest is written and NO request is made.
  const gh4 = makeGitHub(REPO_FILES);
  await WS.createProject(D, 'bare', {});
  const bare = await initFoundations(D, 'bare', {
    ownership: 'repo', remote: 'https://github.com/acme/thing.git',
    fetchImpl: gh4.fetchImpl, sleepImpl: fakeSleep,
  });
  assert(bare.ok, 'a remote mirror with no documents named is created', bare.message);
  eq(gh4.calls.length, 0, '...making NO network request at all');
  // THE PROPERTY v3.61.0 RECORDED, restated for this arm: the refresh's own
  // empty-work-list branch returns `noop: true` and writes NOTHING, so an
  // init that delegated to it would report success and leave the project
  // with no manifest and no ownership — and the NEXT init would be allowed.
  assert(existsSync(manifestPath('bare')),
    '...and the ownership manifest IS written, although nothing was read — otherwise the ownership is not recorded at all');
  // Guarded, so a missing manifest is reported by the assertion above rather
  // than aborting the file with an ENOENT four lines later.
  const bareManifest = existsSync(manifestPath('bare')) ? manifestOf('bare') : null;
  eq(bareManifest && bareManifest.ownership, 'repo', '...recording the ownership');
  eq(bareManifest && bareManifest.repo.root, null, '...with no folder on this computer');
  eq(bareManifest && bareManifest.repo.remote.repo, 'thing', '...with the remote recorded for the first refresh');
  eq(bareManifest && bareManifest.documents.length, 0, '...and no documents');
  assert((bare.notes || []).some((n) => /nothing was read/.test(n)), '...saying so in a note', JSON.stringify(bare.notes));
  // …and that mirror refreshes from the manifest's own remote, no argument.
  const later = await refreshFoundationsFromRepo(D, 'bare', null, {
    source: 'remote', files: [{ path: 'docs/decisions.md' }],
    fetchImpl: gh4.fetchImpl, sleepImpl: fakeSleep,
  });
  assert(later.ok, 'a later refresh reads the remote the init recorded', later.message);
  eq(docOf('bare', 'decisions.md'), DEC, '...and copies the document');

  // ── THE ARGUMENT REFUSALS, each naming what it refused ────────────────
  await WS.createProject(D, 'argrefuse', {});
  const both = await initFoundations(D, 'argrefuse', {
    ownership: 'repo', repoRoot: CHECKOUT, remote: 'acme/thing',
  });
  eq(both.reason, 'root-and-remote', 'a folder AND a repository is refused — a mirror has one source');
  assert(!existsSync(manifestPath('argrefuse')), '...writing nothing');
  const curRemote = await initFoundations(D, 'argrefuse', { ownership: 'curator', remote: 'acme/thing' });
  eq(curRemote.reason, 'remote-not-allowed', 'a curator-owned project given a remote is refused');
  const badSource = await initFoundations(D, 'argrefuse', {
    ownership: 'repo', remote: 'acme/thing', tokenSource: 'somewhere-else',
    files: [{ path: 'docs/architecture.md' }],
  });
  eq(badSource.reason, 'invalid-token-source', 'an unrecognised token source is REFUSED, never normalised to config');
  const badRemote = await initFoundations(D, 'argrefuse', { ownership: 'repo', remote: 'https://gitlab.com/a/b' });
  eq(badRemote.reason, 'invalid-remote', 'a remote this cannot read is refused with the refresh\'s own words');
  assert(!existsSync(manifestPath('argrefuse')), 'after four refusals the project still has no manifest');

  // ── A TOKEN IN THE ARGUMENTS IS NOT READ ──────────────────────────────
  // The token comes from a FILE. Planting one in `opts` must not make the
  // call work when the file holds none, and must not appear anywhere.
  seedTokens({ config: false, sync: false });
  const gh5 = makeGitHub(REPO_FILES);
  await WS.createProject(D, 'planted', {});
  const planted = await initFoundations(D, 'planted', {
    ownership: 'repo', remote: 'acme/thing',
    token: CONFIG_TOKEN,
    files: [{ path: 'docs/architecture.md' }],
    fetchImpl: gh5.fetchImpl, sleepImpl: fakeSleep,
  });
  eq(planted.ok, false, 'a token planted in the ARGUMENTS does not authorise the read');
  eq(planted.reason, 'no-token', '...the store still refuses for want of a token FILE');
  eq(gh5.calls.length, 0, '...and no request was made with it');
  assert(!JSON.stringify(planted).includes(CONFIG_TOKEN), '...and the planted value is not echoed back');
  assert(!existsSync(manifestPath('planted')), '...and nothing was written');

  // …AND THE SAME AT THE LAYER THAT COULD ACTUALLY HONOUR ONE. `init` does
  // not forward `token`, so the assertions above would stay green even if the
  // REFRESH started reading `opts.token` — measured, by mutation: teaching
  // `refreshRemoteCore` to prefer a caller's token left this whole section
  // green. The refresh is where a forwarded token would be used, so the
  // refusal has to be driven there too.
  await seedRemoteProject('plantedrefresh', {
    remote: { owner: 'acme', repo: 'thing', ref: null, path: null },
  });
  const gh6 = makeGitHub(REPO_FILES);
  const plantedRefresh = await refreshFoundationsFromRepo(D, 'plantedrefresh', null, {
    source: 'remote', token: CONFIG_TOKEN,
    files: [{ path: 'docs/architecture.md' }],
    fetchImpl: gh6.fetchImpl, sleepImpl: fakeSleep,
  });
  eq(plantedRefresh.ok, false, 'a token in the REFRESH\'s arguments does not authorise it either');
  eq(plantedRefresh.reason, 'no-token', '...the token is read from a FILE, and there is none');
  eq(gh6.calls.length, 0, '...so no request was made with it');
  assert(!JSON.stringify(plantedRefresh).includes(CONFIG_TOKEN), '...and it is not echoed back');
  seedTokens();
}

// ═════════════════════════════════════════════════════════════════════════
section('14. THE REMOTE SCAN — two requests, no blob, the same three rules');
{
  const files = {
    'docs/architecture.md': ARCH,
    'docs/decisions.md': DEC,
    'README.md': '# Readme\n',
    'src/index.js': 'nope',
    'node_modules/pkg/README.md': '# vendored\n',
    '.github/README.md': '# dotfolder\n',
    'adr/0001-use-markdown.md': '# 0001\n',
    'a/b/c/d/e/deep-architecture.md': '# too deep\n',
    'notes/random.md': '# not a canonical name\n',
  };
  const gh = makeGitHub(files);
  const scan = await WS.scanRemoteForFoundations({
    remote: 'acme/thing', tokenSource: 'config', fetchImpl: gh.fetchImpl, sleepImpl: fakeSleep,
  });
  assert(scan.ok, 'a remote repository can be scanned for candidates', scan.message);
  eq(gh.calls.filter((c) => /git\/blobs\//.test(c.url)).length, 0, 'NO blob is fetched — the tree carries every size');
  assert(gh.calls.length <= 3, `at most three requests for the whole repository (made ${gh.calls.length})`);
  const paths2 = scan.candidates.map((c) => c.path);
  assert(paths2.includes('docs/architecture.md'), 'the docs/ rule admits a file under docs/');
  assert(paths2.includes('README.md'), 'the name rule admits a README at the root');
  assert(paths2.includes('adr/0001-use-markdown.md'), 'the decision-folder rule admits a dated ADR');
  assert(!paths2.includes('src/index.js'), 'a .js file is not a candidate');
  assert(!paths2.includes('node_modules/pkg/README.md'), 'node_modules is skipped');
  assert(!paths2.includes('.github/README.md'), 'a dotfolder is skipped');
  assert(!paths2.includes('notes/random.md'), 'an ordinary note under no rule is not offered');
  assert(!paths2.includes('a/b/c/d/e/deep-architecture.md'), 'the depth bound is applied to the tree\'s own paths');
  eq(scan.root, null, 'root is NULL — no folder on this computer was read');
  eq(scan.commit, 'a'.repeat(40), 'the commit the listing was taken at is named');
  eq(scan.candidates[0].path, 'docs/architecture.md', 'the order is role rank then path, as on the local scan');
  assert(scan.candidates.every((c) => c.firstHeading === null), 'firstHeading is null on EVERY row — uniformly "not read"');
  assert(scan.candidates.every((c) => c.modifiedAt === null), 'modifiedAt is null on every row — a tree carries no timestamp');
  eq(scan.maxDocumentBytes, MAX_FOUNDATION_BYTES, 'the per-document cap is named, as on the local scan');
  assert(!JSON.stringify(scan).includes(CONFIG_TOKEN), 'the token is not in the answer');

  // A ROW FROM THE SCAN IS A ROW THE MIRROR ACCEPTS — the two agree, which
  // is the whole reason the rules are one function rather than two copies.
  const gh2 = makeGitHub(files);
  await WS.createProject(D, 'scanned', {});
  const made = await initFoundations(D, 'scanned', {
    ownership: 'repo', remote: 'acme/thing',
    files: scan.candidates.filter((c) => c.suggestedRole === 'architecture').map((c) => ({ path: c.path, role: c.suggestedRole })),
    fetchImpl: gh2.fetchImpl, sleepImpl: fakeSleep,
  });
  assert(made.ok, 'the ticked candidates mirror without a refusal', made.message);
  eq((made.refresh.refused || []).length, 0, '...none refused');
  assert((made.refresh.added || []).length > 0, '...and at least one document copied');

  // A FOLDER narrows the tree, and the rules are applied BELOW it.
  const gh3 = makeGitHub(files);
  const narrowed = await WS.scanRemoteForFoundations({
    remote: 'acme/thing', path: 'docs', fetchImpl: gh3.fetchImpl, sleepImpl: fakeSleep,
  });
  assert(narrowed.ok, 'a folder can be named', narrowed.message);
  assert(narrowed.candidates.every((c) => c.path.startsWith('docs/')), 'every candidate is inside it');
  eq(narrowed.remote.path, 'docs', '...and the folder is named back');

  // REFUSALS: a bad remote, a missing token, a truncated tree.
  eq((await WS.scanRemoteForFoundations({ remote: 'https://gitlab.com/a/b' })).reason, 'invalid-remote',
    'a remote this cannot read is refused');
  eq((await WS.scanRemoteForFoundations({ remote: null })).reason, 'invalid-remote', 'no remote at all is refused');
  const ghT = makeGitHub(files, { truncated: true });
  eq((await WS.scanRemoteForFoundations({ remote: 'acme/thing', fetchImpl: ghT.fetchImpl, sleepImpl: fakeSleep })).reason,
    'remote-tree-truncated', 'a truncated listing refuses LOUDLY rather than showing a short list');
  seedTokens({ config: false, sync: false });
  const noTok = await WS.scanRemoteForFoundations({ remote: 'acme/thing', fetchImpl: makeGitHub(files).fetchImpl });
  eq(noTok.reason, 'no-token', 'no token file, no scan');
  seedTokens();
}

// ═════════════════════════════════════════════════════════════════════════
section('15. THE ROUTES for both (v3.65.0): a strict init body, and the scan');
{
  const express = (await import('express')).default;
  const routerMod = await import('../src/routes/memory.js');
  const app = express();
  app.use(express.json());
  app.use('/api/memory', routerMod.default);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const post = async (url, body) => {
    const res = await REAL_FETCH(`http://127.0.0.1:${port}${url}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const get = async (url) => {
    const res = await REAL_FETCH(`http://127.0.0.1:${port}${url}`);
    return { status: res.status, body: await res.json() };
  };

  try {
    await WS.createProject(D, 'routeinit', {});
    // A `token` IN THE BODY IS REFUSED BY NAME. Ignoring it would say
    // nothing; refusing it says the credential is read from a file.
    const withToken = await post(`/api/memory/${D}/routeinit/foundations/init`, {
      ownership: 'repo', remote: 'acme/thing', token: CONFIG_TOKEN,
    });
    eq(withToken.status, 400, 'a `token` in the init body is a 400');
    eq(withToken.body.reason, 'unexpected_fields', '...as an unexpected field');
    assert((withToken.body.fields || []).includes('token'), '...naming it', JSON.stringify(withToken.body.fields));
    assert(/NEVER sent here/.test(withToken.body.error || ''), '...and saying a token is never sent here', withToken.body.error);
    assert(!existsSync(manifestPath('routeinit')), '...and nothing was written');

    const unknownField = await post(`/api/memory/${D}/routeinit/foundations/init`, { ownership: 'curator', nonsense: 1 });
    eq(unknownField.status, 400, 'any unknown field is a 400');
    eq(unknownField.body.reason, 'unexpected_fields', '...under one reason');

    // THE SHIPPED CLIENT'S OWN BODY still passes — measured against the real
    // `chooserBody`, not against a hand-typed copy of it.
    const { chooserBody } = await import('../src/public/next/shared/foundations-init.js');
    for (const choice of [
      { ownership: 'curator' },
      { ownership: 'curator', seed: false },
      { ownership: 'repo', repoRoot: CHECKOUT, candidates: [], picks: {}, roles: {} },
    ]) {
      const b = chooserBody(choice) || {};
      const extra = Object.keys(b).filter((k) => !routerMod.INIT_BODY_FIELDS.has(k));
      eq(extra.length, 0, `the shipped chooser body for ${choice.ownership}${choice.seed === false ? ' (no seed)' : ''} carries no field this route refuses`);
    }

    // THE REMOTE ARM THROUGH THE ROUTE, with the network genuinely blocked:
    // the plumbing is proven by the refusal's STATUS, which is the upstream
    // one and not a 400.
    const blocked = await post(`/api/memory/${D}/routeinit/foundations/init`, {
      ownership: 'repo', remote: 'acme/thing', tokenSource: 'config', files: [{ path: 'docs/architecture.md' }],
    });
    eq(blocked.status, 502, 'a blocked network answers 502 on the init too — upstream, not a bad request');
    eq(blocked.body.reason, 'remote-unreachable', '...under the store\'s own reason');
    assert(!existsSync(manifestPath('routeinit')), '...and NOTHING was written, so the project can choose again');
    assert(!JSON.stringify(blocked.body).includes(CONFIG_TOKEN), '...and the token is not in the response');

    // THE SCAN ROUTE: the local arm is untouched, the remote arm reaches the
    // client (and is blocked here), and a bad remote is a 400.
    const localScan = await get(`/api/memory/repo-scan?root=${encodeURIComponent(CHECKOUT)}`);
    eq(localScan.status, 200, 'the LOCAL repo-scan is unchanged');
    assert(typeof localScan.body.root === 'string', '...still naming the resolved root');
    const badScan = await get('/api/memory/repo-scan?source=remote&remote=https%3A%2F%2Fgitlab.com%2Fa%2Fb');
    eq(badScan.status, 400, 'a remote this cannot read is a 400 on the scan');
    eq(badScan.body.reason, 'invalid-remote', '...naming the reason');
    const blockedScan = await get('/api/memory/repo-scan?source=remote&remote=acme%2Fthing&tokenSource=config');
    eq(blockedScan.status, 502, 'a blocked network answers 502 on the scan');
    assert(!JSON.stringify(blockedScan.body).includes(CONFIG_TOKEN), '...without the token');
  } finally {
    server.close();
  }
}
// ═════════════════════════════════════════════════════════════════════════
section('16. No real network was reached by anything but the two route sections');
{
  // Sections 1–10, 13 and 14 inject `fetchImpl`; only §11 and §15 drive the
  // real client. Every recorded attempt must therefore be one of theirs, and
  // none may have succeeded — the spy throws.
  assert(NET_ATTEMPTS.every((u) => u.startsWith('https://api.github.com/')),
    `every blocked attempt was §11's or §15's (${NET_ATTEMPTS.length} total)`, NET_ATTEMPTS.join(' | ').slice(0, 300));
  assert(NET_ATTEMPTS.length > 0, '(control) the spy CAN record — a green above is not an empty measurement');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}   Skipped: ${skipped}`);
console.log('═'.repeat(60));
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}\n    └─ ${f.err}`);
  process.exit(1);
}
console.log('All tier-0 GitHub mirror-arm assertions green.');
