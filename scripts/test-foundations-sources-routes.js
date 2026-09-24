#!/usr/bin/env node
/**
 * OFFLINE — v3.69.0 PER-DOCUMENT SOURCES, through the ROUTES and the MCP.
 *
 * Package A proved the store (test-foundations-sources.js) and package C the
 * view against fixtures (test-foundations-sources-view.js). This suite is the
 * JOIN: the REAL router (src/routes/memory.js) over the REAL store, driven by
 * the VIEW'S OWN request builders (`listUrl`, `buildAddCommit` from
 * shared/foundations-add.js) and read back by the view's own readers
 * (`readCommitResponse`, `sourcesOf`, `rowKind`, `refreshOutcome`,
 * `deleteConfirmCopy`), on ONE mixed project with THREE source groups — a
 * folder checkout, and two GitHub repositories — beside a written and two
 * copied documents. A field the view reads that the routes do not send reds
 * here, not in a screen review.
 *
 *   §1  the checklist: repo-scan with domain/project/mode answers the per-row
 *       `alreadyAdded`/`alreadyAs`/`landsAs`/`suggestedSlug` and top-level
 *       `inGitCheckout` + `mode` — before and after a commit, for both doors
 *   §2  the commits: add-local {mode}, add-remote (the addendum-3 shape),
 *       a collision landing under a suffix, never an overwrite
 *   §3  the envelope: `foundations.sources[]` with EXACTLY the addendum-2
 *       keys, every row's `source.group`, `ownership: 'mixed'`, and the view's
 *       own `rowKind` counting all four kinds
 *   §4  PUT is a per-DOCUMENT gate (repo_owned on a mirrored slug only, D4)
 *   §5  refresh {group}/{}: `groups[]`, one failing group reported and left
 *       exactly as it was; `no_sources` with prose; group_required/unknown
 *   §6  tokenSource is forwarded ONLY when named — a group's recorded file wins
 *   §7  the switch per group ({group} required with ≥2 sources)
 *   §8  DELETE: {ok, sourceKept, source{label,path}, groupRemoved}, and the
 *       view's confirm copy for the same row
 *   §9  body allow-lists: `token` refused BY NAME on every new/changed route
 *   §10 the MCP: save_foundation per D4, get_project_context carries `sources`
 *       only for v2 (and v1 has no key at all), the §6.1 description sentences
 *   §11 the REAL server's cross-origin guard refuses a foreign-Origin POST to
 *       add-remote with 403 (src/server.js spawned on an isolated port)
 *   §12 no real network: every GitHub call went to the fake
 *
 * Isolated with CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR (set
 * before any import resolves a path) and the in-process overrides. The fake
 * GitHub answers through `globalThis.fetch`; loopback requests go to the real
 * fetch; anything else THROWS.
 *
 * Run with:  node scripts/test-foundations-sources-routes.js   (exit 0 = green)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import net from 'net';
import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-fnd-srcroutes-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-fnd-srcroutes-')) {
      rmSync(TMP, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});

// ── Harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); if (detail !== undefined) console.log(`    └─ ${String(detail).slice(0, 600)}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(name) { console.log(`\n── ${name} ──`); }
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const gitBlobSha = (buf) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const sameKeys = (o, keys) => !!o && JSON.stringify(Object.keys(o).sort()) === JSON.stringify(keys.slice().sort());

// ── The tokens: real-SHAPED values already on the secret allow-list ──────
const CONFIG_TOKEN = 'github_pat_TESTONLY_SHOULD_NEVER_APPEAR_0123456789';
const SYNC_TOKEN = 'ghp_thisisasecretpatdonotleak1234abcdABCD';
writeFileSync(path.join(USER_DATA, '.curator-config.json'), JSON.stringify({ githubReadToken: CONFIG_TOKEN }, null, 2));
writeFileSync(path.join(USER_DATA, '.sync-config.json'),
  JSON.stringify({ repoUrl: 'https://github.com/o/knowledge', token: SYNC_TOKEN }, null, 2));

// ── A FAKE GITHUB, several repositories, one per `owner/repo` ────────────
const REPOS = new Map();
const GH_CALLS = [];
const NET_ESCAPES = [];
function repo(full, files, opts = {}) {
  REPOS.set(full.toLowerCase(), { files: new Map(Object.entries(files)), commit: opts.commit || 'c'.repeat(40), fail: null });
}
const jres = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => ({ 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1750000000' }[k.toLowerCase()] ?? null) },
  async json() { return body; }, async text() { return JSON.stringify(body); },
});
async function fakeGitHub(url, init) {
  const u = new URL(String(url));
  const auth = init && init.headers ? (init.headers.Authorization || init.headers.authorization || null) : null;
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
  GH_CALLS.push({ path: u.pathname, auth, method: (init && init.method) || 'GET' });
  if (!m) return jres({ message: 'no route' }, 404);
  const r = REPOS.get(`${m[1]}/${m[2]}`.toLowerCase());
  if (!r) return jres({ message: 'Not Found' }, 404);
  if (r.fail) return jres({ message: 'GitHub is having a bad afternoon' }, r.fail);
  const rest = m[3] || '';
  if (rest === '') return jres({ default_branch: 'main' });
  if (/^\/commits\//.test(rest)) return jres({ sha: r.commit });
  if (/^\/git\/trees\//.test(rest)) {
    return jres({ truncated: false, tree: [...r.files].map(([p, c]) => ({ path: p, type: 'blob', sha: gitBlobSha(Buffer.from(c)), size: Buffer.byteLength(c) })) });
  }
  const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(rest);
  if (blob) {
    const hit = [...r.files].find(([, c]) => gitBlobSha(Buffer.from(c)) === blob[1]);
    return hit ? jres({ content: Buffer.from(hit[1]).toString('base64'), encoding: 'base64' }) : jres({ message: 'Not Found' }, 404);
  }
  return jres({ message: 'no route' }, 404);
}
const REAL_FETCH = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (/^https:\/\/api\.github\.com\//.test(s)) return fakeGitHub(url, init);
  if (/^http:\/\/127\.0\.0\.1:/.test(s)) return REAL_FETCH(url, init);
  NET_ESCAPES.push(s.slice(0, 200));
  throw new Error('NET BLOCKED BY SPY: ' + s.slice(0, 80));
};

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);
const WS = await import('../src/brain/working-state.js');
const ADD = await import('../src/public/next/shared/foundations-add.js');
const FSRC = await import('../src/public/next/shared/foundations-sources.js');
const TOOLS = await import('../mcp/tools/working-state.js');
const routerMod = await import('../src/routes/memory.js');
const express = (await import('express')).default;

// ── Fixtures ─────────────────────────────────────────────────────────────
const D = 'mixdom';
const P = 'mix';
const KEPT = 'keptonly';
const RO = 'shared-cohort';
for (const d of [D]) {
  mkdirSync(path.join(DOMAINS, d, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, d, 'CLAUDE.md'), `# ${d}\n`);
}
mkdirSync(path.join(DOMAINS, RO, 'wiki'), { recursive: true });
writeFileSync(path.join(DOMAINS, RO, 'CLAUDE.md'), '---\nreadonly: true\n---\n# shared\n');
await WS.createProject(D, P, {});
await WS.createProject(D, KEPT, {});
const fdir = (project) => path.join(DOMAINS, D, 'state', project, WS.FOUNDATIONS_DIRNAME);
const manifestPath = (project) => path.join(fdir(project), WS.FOUNDATIONS_MANIFEST_FILENAME);
const manifestOf = (project) => JSON.parse(readFileSync(manifestPath(project), 'utf8'));
const fileSha = (p) => sha(readFileSync(p));

// A plain folder (copy once), with a name that collides later.
const NOTES = path.join(TMP, 'notes');
mkdirSync(NOTES, { recursive: true });
writeFileSync(path.join(NOTES, 'notes.md'), '# Notes\n\nKept here.\n');
writeFileSync(path.join(NOTES, 'architecture.md'), '# Architecture (notes)\n\nCopied once.\n');

// A git checkout (keep in sync), whose origin is acme/second-brain.
const CHECKOUT = path.join(TMP, 'second-brain');
mkdirSync(path.join(CHECKOUT, 'docs', 'dev'), { recursive: true });
writeFileSync(path.join(CHECKOUT, 'docs', 'architecture.md'), '# Architecture (checkout)\n\nMirrored.\n');
writeFileSync(path.join(CHECKOUT, 'docs', 'dev', 'decisions.md'), '# Decisions\n\n0001 mirror.\n');
writeFileSync(path.join(CHECKOUT, '.curator-project'), `${D}/${P}\n`);
const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a],
  { cwd: CHECKOUT, encoding: 'utf8' });
const gitOk = (() => { try { return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0; } catch { return false; } })();
if (gitOk) {
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/acme/second-brain.git');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
}
repo('acme/second-brain', {
  'docs/architecture.md': '# Architecture (checkout)\n\nMirrored.\n',
  'docs/dev/decisions.md': '# Decisions\n\n0001 mirror, read from GitHub.\n',
});
repo('acme/lumina', { 'docs/architecture.md': '# Lumina architecture\n', 'README.md': '# Lumina\n' });
repo('acme/other', { 'guide.md': '# Other guide\n' }, { commit: 'd'.repeat(40) });

// ── The router, on loopback ──────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/memory', routerMod.default);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;
async function call(method, url, body) {
  const res = await globalThis.fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}
const base = `/api/memory/${D}/${P}/foundations`;
const envelope = async (project = P) => (await call('GET', `/api/memory/${D}/${project}`)).body.foundations;
/** A panel record the way the view builds one. */
function panel(door, over) {
  return { ...ADD.freshAddPanel(door, {}, {}), domain: D, project: P, ...over };
}
function tick(rec, candidates, paths) {
  rec.candidates = candidates;
  rec.picks = Object.fromEntries(paths.map((p) => [p, true]));
  return rec;
}
const CAND_KEYS = ['path', 'bytes', 'suggestedRole', 'suggestedSlug', 'tooLarge', 'matchedBy', 'firstHeading', 'modifiedAt',
  'alreadyAdded', 'alreadyAs', 'landsAs'];
const SOURCE_KEYS = ['id', 'kind', 'label', 'reachableHere', 'remote', 'lastRefreshAt', 'lastRefreshCommit', 'documentCount'];

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('1. The checklist — repo-scan with domain, project and mode');
  // ═══════════════════════════════════════════════════════════════════════
  let copyRec = panel('local', { root: NOTES, mode: 'copy' });
  const url1 = ADD.listUrl(copyRec);
  ok(/mode=copy/.test(url1) && /domain=mixdom/.test(url1) && /project=mix/.test(url1), 'the view\'s listUrl names mode, domain and project', url1);
  const scan1 = await call('GET', url1);
  eq(scan1.status, 200, 'the local copy listing answers 200');
  ok(scan1.body.inGitCheckout === false && scan1.body.mode === 'copy', 'top-level inGitCheckout (false: a plain folder) and the mode it annotated for',
    JSON.stringify({ g: scan1.body.inGitCheckout, m: scan1.body.mode }));
  ok(scan1.body.candidates.length === 2 && scan1.body.candidates.every((c) => sameKeys(c, CAND_KEYS)),
    'every candidate carries EXACTLY the scan fields plus alreadyAdded/alreadyAs/landsAs', JSON.stringify(scan1.body.candidates[0]));
  ok(scan1.body.candidates.every((c) => c.alreadyAdded === false && c.alreadyAs === null && c.landsAs === c.suggestedSlug),
    'nothing added yet: every row lands under its natural name', JSON.stringify(scan1.body.candidates));
  const half = await call('GET', `/api/memory/repo-scan?all=1&root=${encodeURIComponent(NOTES)}&domain=${D}`);
  ok(half.status === 400 && half.body.reason === 'project_required' && /both/.test(half.body.error || ''),
    'a domain without a project is a 400 with prose, never "no project"', JSON.stringify(half.body));
  const badMode = await call('GET', `/api/memory/repo-scan?all=1&root=${encodeURIComponent(NOTES)}&mode=sync&domain=${D}&project=${P}`);
  ok(badMode.status === 400 && badMode.body.reason === 'invalid_mode', 'an unknown mode is a 400', JSON.stringify(badMode.body));
  const ghost = await call('GET', `/api/memory/repo-scan?all=1&root=${encodeURIComponent(NOTES)}&domain=nope&project=${P}`);
  eq(ghost.status, 404, 'an unknown domain is a 404');
  const free = await call('GET', `/api/memory/repo-scan?all=1&root=${encodeURIComponent(NOTES)}`);
  ok(free.status === 200 && free.body.candidates.every((c) => !('alreadyAdded' in c)) && free.body.inGitCheckout === false,
    'unnamed, the listing is the pre-v3.69 project-free one plus inGitCheckout', JSON.stringify(free.body).slice(0, 300));

  // ═══════════════════════════════════════════════════════════════════════
  section('2. The commits — copy, written, mirror, two GitHub sources');
  // ═══════════════════════════════════════════════════════════════════════
  tick(copyRec, scan1.body.candidates, ['notes.md', 'architecture.md']);
  const c1 = ADD.buildAddCommit(copyRec, {}, D, P);
  ok(c1.url.endsWith('/foundations/add-local') && c1.body.mode === 'copy' && !('token' in c1.body), 'the view posts add-local {root, files, mode: copy}');
  const r1 = await call('POST', c1.url, c1.body);
  const read1 = ADD.readCommitResponse(r1.status, r1.body, copyRec);
  ok(r1.status === 200 && read1.ok && read1.added.sort().join() === 'architecture.md,notes.md',
    'copied: the view reads two added documents', JSON.stringify(r1.body).slice(0, 300));
  ok(r1.body.mode === 'copy' && r1.body.groupId === null && Array.isArray(r1.body.addedFiles)
    && r1.body.addedFiles.every((a) => typeof a.path === 'string' && typeof a.slug === 'string'),
    '...with mode copy, no source group, and addedFiles [{path, slug}]', JSON.stringify(r1.body.addedFiles));
  const again = await call('GET', ADD.listUrl(copyRec));
  ok(again.body.candidates.every((c) => c.alreadyAdded === true && typeof c.alreadyAs === 'string'),
    'listed again: both rows are ALREADY ADDED, as the server decides', JSON.stringify(again.body.candidates.map((c) => [c.path, c.alreadyAdded])));

  const w = await call('PUT', `${base}/plan.md`, { text: '# Plan\n\nWritten here.\n' });
  ok(w.status === 200 && w.body.created === true, 'a WRITTEN document (PUT) into the kept project', JSON.stringify(w.body).slice(0, 200));

  // The checkout — mirror mode. The view lists as mirror; a checkout reports inGitCheckout.
  const mirRec = panel('local', { root: path.join(CHECKOUT, 'docs'), mode: 'mirror' });
  const scan2 = await call('GET', ADD.listUrl(mirRec));
  eq(scan2.status, 200, 'the checkout listing (mirror) answers 200');
  eq(scan2.body.inGitCheckout, gitOk, 'inGitCheckout says whether the folder is inside a git work tree');
  const archRow = scan2.body.candidates.find((c) => c.path === 'architecture.md');
  ok(archRow && archRow.alreadyAdded === false && archRow.suggestedSlug === 'architecture.md'
    && archRow.landsAs === 'architecture-second-brain.md',
    'a same-named file from ANOTHER source is NOT "already added": it lands as architecture-second-brain.md', JSON.stringify(archRow));
  ok(ADD.landsAsBadge(archRow), '...and the view shows the landing badge for that row');
  ok(scan2.body.group && scan2.body.group.created === true && scan2.body.group.id === null,
    '...and the scan says a mirror commit would START a source', JSON.stringify(scan2.body.group));
  tick(mirRec, scan2.body.candidates, ['architecture.md', 'dev/decisions.md']);
  const archBefore = fileSha(path.join(fdir(P), 'architecture.md'));
  const c2 = ADD.buildAddCommit(mirRec, {}, D, P);
  const r2 = await call('POST', c2.url, c2.body);
  ok(r2.status === 200 && r2.body.mode === 'mirror' && r2.body.groupId === 's1' && r2.body.groupCreated === true,
    'mirrored: a new folder source s1', JSON.stringify(r2.body).slice(0, 400));
  ok(r2.body.added.includes('architecture-second-brain.md') && r2.body.landed.some((x) => x.slug === 'architecture-second-brain.md'),
    '...the colliding file LANDED under its suffix, named in `landed`', JSON.stringify(r2.body.landed));
  eq(fileSha(path.join(fdir(P), 'architecture.md')), archBefore, '...and the copied architecture.md is byte-identical (never an overwrite)');
  ok(r2.body.group && r2.body.group.kind === 'folder' && r2.body.group.label === 'second-brain',
    '...the group names its kind and its folder BASENAME (never a path)', JSON.stringify(r2.body.group));
  const scan2b = await call('GET', ADD.listUrl(mirRec));
  ok(scan2b.body.candidates.find((c) => c.path === 'architecture.md').alreadyAs === 'architecture-second-brain.md',
    're-listed: the mirrored row is already added AS its landed name');

  // GitHub, twice.
  const ghRec = panel('github', { remote: 'acme/lumina', tokenSource: 'config' });
  const gurl = ADD.listUrl(ghRec);
  const scan3 = await call('GET', gurl);
  ok(scan3.status === 200 && !('inGitCheckout' in scan3.body) && scan3.body.mode === 'mirror', 'the GitHub listing answers, mode mirror', JSON.stringify(scan3.body).slice(0, 200));
  const ghArch = scan3.body.candidates.find((c) => c.path === 'docs/architecture.md');
  ok(ghArch && ghArch.landsAs === 'architecture-lumina.md' && ghArch.alreadyAdded === false,
    'GitHub: docs/architecture.md would land as architecture-lumina.md', JSON.stringify(ghArch));
  tick(ghRec, scan3.body.candidates, ['docs/architecture.md', 'README.md']);
  const c3 = ADD.buildAddCommit(ghRec, {}, D, P);
  ok(c3.url.endsWith('/foundations/add-remote') && !('token' in c3.body) && c3.body.tokenSource === 'config',
    'the view posts add-remote {remote, tokenSource, files} — no token', JSON.stringify(c3.body));
  const r3 = await call('POST', c3.url, c3.body);
  ok(r3.status === 200 && r3.body.groupId === 's2' && Array.isArray(r3.body.added)
    && r3.body.added.every((a) => a && typeof a.path === 'string' && typeof a.slug === 'string'),
    'add-remote answers the addendum-3 shape: added [{path, slug}], groupId', JSON.stringify(r3.body).slice(0, 400));
  ok(Array.isArray(r3.body.refused) && r3.body.tokenSource === 'config' && !JSON.stringify(r3.body).includes(CONFIG_TOKEN),
    '...names WHICH token file, never the token');
  const read3 = ADD.readCommitResponse(r3.status, r3.body, ghRec);
  ok(read3.ok && read3.added.includes('architecture-lumina.md'), 'the view reads the landed slug out of {path, slug}', JSON.stringify(read3));
  const ghRec2 = panel('github', { remote: 'acme/other', tokenSource: 'sync' });
  const scan4 = await call('GET', ADD.listUrl(ghRec2));
  tick(ghRec2, scan4.body.candidates, ['guide.md']);
  const r4 = await call('POST', ADD.buildAddCommit(ghRec2, {}, D, P).url, ADD.buildAddCommit(ghRec2, {}, D, P).body);
  ok(r4.status === 200 && r4.body.groupId === 's3' && r4.body.tokenSource === 'sync', 'a second repository is a THIRD source, s3 (read with the sync token file)',
    JSON.stringify(r4.body).slice(0, 300));
  const again3 = await call('GET', ADD.listUrl(ghRec));
  ok(again3.body.candidates.filter((c) => c.alreadyAdded).length === 2, 're-listed on GitHub: both committed rows are already added');

  // ═══════════════════════════════════════════════════════════════════════
  section('3. The envelope — the fields the view reads, exactly');
  // ═══════════════════════════════════════════════════════════════════════
  const f = await envelope();
  ok(f.present === true && f.ownership === 'mixed' && f.manifestVersion === 2, 'present, ownership "mixed", manifest version 2',
    JSON.stringify({ p: f.present, o: f.ownership, v: f.manifestVersion }));
  eq(f.sources.length, 3, 'foundations.sources has three groups');
  ok(f.sources.every((g) => sameKeys(g, SOURCE_KEYS)), 'every group carries EXACTLY the addendum-2 keys', JSON.stringify(f.sources[0]));
  ok(JSON.stringify(f.sources.map((g) => [g.id, g.kind, g.label, g.documentCount]))
    === JSON.stringify([['s1', 'folder', 'second-brain', 2], ['s2', 'github', 'acme/lumina', 2], ['s3', 'github', 'acme/other', 1]]),
    'ids, kinds, labels and document counts', JSON.stringify(f.sources));
  ok(f.sources[0].reachableHere === true && f.sources[1].reachableHere === false && f.sources[1].remote.repo === 'lumina',
    'the folder is reachable here, a GitHub source is not; remote carries owner/repo/ref/path');
  ok(!JSON.stringify(f.sources).includes(CHECKOUT), 'the folder\'s absolute path is NOT in sources[]');
  const docKeys = ['source', 'copiedFrom', 'skeleton', 'freshness', 'authoredBy', 'commit', 'updatedAt'];
  ok(f.documents.every((d) => docKeys.every((k) => k in d) && d.source && 'kind' in d.source && 'path' in d.source && 'group' in d.source),
    'every row carries source.{kind,path,group}, copiedFrom, skeleton, freshness, authoredBy, commit, updatedAt');
  const kinds = {};
  const srcs = FSRC.sourcesOf(f);
  for (const d of f.documents) kinds[FSRC.rowKind(d, srcs)] = (kinds[FSRC.rowKind(d, srcs)] || 0) + 1;
  eq(JSON.stringify(kinds), JSON.stringify({ copied: 2, written: 1, folder: 2, github: 3 }),
    'the view\'s own rowKind reads all FOUR kinds off the real envelope');
  ok(f.documents.filter((d) => d.source.kind === 'repo').every((d) => /^s[123]$/.test(d.source.group))
    && f.documents.filter((d) => d.source.kind === 'curator').every((d) => d.source.group === null),
    'a mirrored row names its group; a kept row names none');
  const freshWords = f.documents.map((d) => (FSRC.rowFreshWord(d, srcs) || {}).word);
  ok(freshWords.includes(FSRC.NOT_CHECKED) && !freshWords.includes(FSRC.NOT_HERE),
    'a GitHub row reads "GitHub · not checked", never "source not here"', JSON.stringify(freshWords));
  const keptEnv = await envelope(KEPT);
  ok(keptEnv && Array.isArray(keptEnv.sources) && keptEnv.sources.length === 0,
    'a project with no foundations still carries sources: [] (always an array)', JSON.stringify(keptEnv && keptEnv.sources));

  // ═══════════════════════════════════════════════════════════════════════
  section('4. PUT is a per-DOCUMENT gate (D4)');
  // ═══════════════════════════════════════════════════════════════════════
  const ghSha = fileSha(path.join(fdir(P), 'architecture-lumina.md'));
  const put1 = await call('PUT', `${base}/architecture-lumina.md`, { text: '# Hijack\n' });
  ok(put1.status === 400 && put1.body.reason === 'repo_owned' && /mirrored from acme\/lumina — edit it there and refresh/.test(put1.body.error || ''),
    'an edit of a MIRRORED slug is 400 repo_owned, naming its source', JSON.stringify(put1.body).slice(0, 300));
  ok(put1.body.mirrored && put1.body.mirrored.group === 's2' && put1.body.mirrored.kind === 'github', '...with mirrored {group, kind, label, path}');
  ok(/A NEW document can still be written into this project under another name\./.test(put1.body.error || ''),
    '...refused by the ROUTE\'s own gate, which says a new document is still possible (not only the store\'s backstop)');
  eq(fileSha(path.join(fdir(P), 'architecture-lumina.md')), ghSha, '...and the mirrored bytes are untouched');
  const put2 = await call('PUT', `${base}/conventions.md`, { text: '# Conventions\n\nWritten beside three mirrors.\n' });
  ok(put2.status === 200 && put2.body.created === true, 'a NEW document in the same mixed project is written (D4)', JSON.stringify(put2.body).slice(0, 200));
  const put3 = await call('PUT', `${base}/notes.md`, { text: '# Notes\n\nEdited here.\n' });
  eq(put3.status, 200, 'a COPIED document is editable here (it is kept)');

  // ═══════════════════════════════════════════════════════════════════════
  section('5. Refresh — per group, all groups, and the refusals');
  // ═══════════════════════════════════════════════════════════════════════
  const markOne = GH_CALLS.length;
  const one = await call('POST', `${base}/refresh`, { group: 's2' });
  ok(one.status === 200 && Array.isArray(one.body.groups) && one.body.groups.length === 1 && one.body.groups[0].id === 's2'
    && one.body.groups[0].ok === true, 'refresh {group: s2} refreshes that group only', JSON.stringify(one.body.groups));
  ok(['refreshed', 'added', 'unchanged', 'missing', 'refused'].every((k) => Array.isArray(one.body[k])), '...with the five top-level lists the view reads');
  ok(GH_CALLS.slice(markOne).length > 0 && GH_CALLS.slice(markOne).every((c) => c.path.includes('/acme/lumina')),
    '...and GitHub was asked about acme/lumina only');
  REPOS.get('acme/other').fail = 500;
  const s3Before = fileSha(path.join(fdir(P), 'guide.md'));
  const mBefore = manifestOf(P).sources.find((g) => g.id === 's3');
  REPOS.get('acme/lumina').files.set('README.md', '# Lumina, changed upstream\n');
  const all = await call('POST', `${base}/refresh`, {});
  ok(all.status === 200 && all.body.groups.length === 3, 'refresh {} answers every group', JSON.stringify(all.body).slice(0, 400));
  const g3 = all.body.groups.find((g) => g.id === 's3');
  ok(g3 && g3.ok === false && typeof g3.reason === 'string' && typeof g3.message === 'string',
    'the failing source is reported ok:false with reason and message', JSON.stringify(g3));
  ok(all.body.groups.filter((g) => g.ok).length === 2 && all.body.refreshed.includes('readme.md'),
    '...the others were refreshed (the changed README re-copied)', JSON.stringify(all.body.refreshed));
  eq(fileSha(path.join(fdir(P), 'guide.md')), s3Before, '...and the failing source\'s document is byte-identical');
  eq(JSON.stringify(manifestOf(P).sources.find((g) => g.id === 's3')), JSON.stringify(mBefore), '...and its manifest record too');
  const outcome = FSRC.refreshOutcome(all.body, f.sources);
  ok(outcome.failed.length === 1 && /acme\/other was not refreshed and is unchanged/.test(outcome.failed[0]),
    'the view\'s refreshOutcome names the failed source from the route\'s own groups[]', JSON.stringify(outcome));
  REPOS.get('acme/other').fail = null;
  const noSrc = await call('POST', `/api/memory/${D}/${KEPT}/foundations/refresh`, {});
  ok(noSrc.status === 409 && noSrc.body.reason === 'repo_unreachable',
    'a project with NO manifest keeps its pre-v3.69 answer (409: nothing recorded to read from)', JSON.stringify(noSrc.body).slice(0, 200));
  await call('POST', `/api/memory/${D}/${KEPT}/foundations/add-local`, { root: NOTES, files: [{ path: 'notes.md' }], mode: 'copy' });
  const noSrc2 = await call('POST', `/api/memory/${D}/${KEPT}/foundations/refresh`, {});
  ok(noSrc2.status === 400 && noSrc2.body.reason === 'no_sources'
    && noSrc2.body.error === 'Nothing here is mirrored, so there is nothing to refresh. Copies and documents written here never change on their own.',
    'a kept-only project: 400 no_sources with the contract\'s prose', JSON.stringify(noSrc2.body));
  const needGroup = await call('POST', `${base}/refresh`, { files: [{ path: 'x.md' }] });
  ok(needGroup.status === 400 && needGroup.body.reason === 'group_required' && typeof needGroup.body.error === 'string',
    'files without a group, with 3 sources: 400 group_required with prose', JSON.stringify(needGroup.body));
  const unknown = await call('POST', `${base}/refresh`, { group: 's9' });
  ok(unknown.status === 404 && unknown.body.reason === 'unknown_group' && typeof unknown.body.error === 'string',
    'an unknown group: 404 unknown_group', JSON.stringify(unknown.body));
  const badGroup = await call('POST', `${base}/refresh`, { group: '../s1' });
  ok(badGroup.status === 400 && badGroup.body.reason === 'invalid_group', 'a malformed group id: 400 before the store', JSON.stringify(badGroup.body));

  // ═══════════════════════════════════════════════════════════════════════
  section('6. tokenSource — forwarded ONLY when the body names one');
  // ═══════════════════════════════════════════════════════════════════════
  const mark = GH_CALLS.length;
  const s3r = await call('POST', `${base}/refresh`, { group: 's3' });
  const s3auth = GH_CALLS.slice(mark).filter((c) => c.path.includes('acme/other')).map((c) => c.auth);
  ok(s3r.status === 200 && s3auth.length > 0 && s3auth.every((a) => a === `Bearer ${SYNC_TOKEN}`),
    'a refresh that names NO token file reads s3 with the file it RECORDED (sync)', JSON.stringify({ st: s3r.status, n: s3auth.length }));
  const mark2 = GH_CALLS.length;
  await call('POST', `${base}/refresh`, { group: 's3', tokenSource: 'config' });
  ok(GH_CALLS.slice(mark2).filter((c) => c.path.includes('acme/other')).every((c) => c.auth === `Bearer ${CONFIG_TOKEN}`),
    'a refresh that NAMES one uses it');
  const badTs = await call('POST', `${base}/refresh`, { group: 's3', tokenSource: 'env' });
  ok(badTs.status === 400 && badTs.body.reason === 'invalid_token_source', 'an unknown token file is refused, not read as config');

  // ═══════════════════════════════════════════════════════════════════════
  section('7. The switch — per group');
  // ═══════════════════════════════════════════════════════════════════════
  const noG = await call('POST', `${base}/source`, { remote: { owner: 'acme', repo: 'second-brain' }, tokenSource: 'config' });
  ok(noG.status === 400 && noG.body.reason === 'group_required' && typeof noG.body.error === 'string',
    'with 3 sources and no group: 400 group_required, nothing changed', JSON.stringify(noG.body));
  const swRec = { ...ADD.freshAddPanel('github', { mode: 'switch', group: 's1', groupLabel: 'second-brain', remote: { owner: 'acme', repo: 'second-brain' } }, {}), tokenSource: 'config' };
  const sw = ADD.buildAddCommit(swRec, {}, D, P);
  ok(sw.url.endsWith('/foundations/source') && sw.body.group === 's1', 'the view posts source {group, remote, tokenSource}', JSON.stringify(sw.body));
  const swr = await call('POST', sw.url, sw.body);
  ok(swr.status === 200 && swr.body.rootCleared === true && swr.body.group && swr.body.group.id === 's1',
    'the folder source s1 now reads from GitHub; its folder is cleared', JSON.stringify(swr.body).slice(0, 300));
  const afterSw = await envelope();
  ok(afterSw.sources.find((g) => g.id === 's1').kind === 'github' && afterSw.sources.length === 3,
    '...and only s1 changed kind');

  // ═══════════════════════════════════════════════════════════════════════
  section('8. DELETE — what is kept, and the view\'s confirm for the same row');
  // ═══════════════════════════════════════════════════════════════════════
  const guideRow = afterSw.documents.find((d) => d.slug === 'guide.md');
  const copy = FSRC.deleteConfirmCopy(guideRow, FSRC.sourcesOf(afterSw));
  ok(/acme\/other/.test(JSON.stringify(copy)) && /last document/.test(JSON.stringify(copy)),
    'the view\'s confirm names acme/other and says it is the source\'s last document', JSON.stringify(copy).slice(0, 300));
  const del1 = await call('DELETE', `${base}/guide.md`, { confirm: 'guide.md' });
  ok(del1.status === 200 && del1.body.ok === true && del1.body.sourceKept === true && del1.body.groupRemoved === true
    && del1.body.source && del1.body.source.label === 'acme/other' && del1.body.source.path === 'guide.md',
    'a GitHub document: {ok, sourceKept: true, source {label, path}, groupRemoved: true}', JSON.stringify(del1.body));
  ok(del1.body.origin === 'github' && del1.body.ownership === 'repo', '...origin github; ownership is the ROW\'s');
  ok(!manifestOf(P).sources.some((g) => g.id === 's3'), '...and the source is gone from the manifest in the same write');
  const del2 = await call('DELETE', `${base}/plan.md`, { confirm: 'plan.md' });
  ok(del2.status === 200 && del2.body.sourceKept === false && del2.body.source === null && del2.body.groupRemoved === false
    && del2.body.origin === 'written', 'a WRITTEN document: sourceKept false, source null', JSON.stringify(del2.body));
  const del3 = await call('DELETE', `${base}/architecture.md`, { confirm: 'architecture.md' });
  ok(del3.body.sourceKept === true && del3.body.origin === 'copied' && del3.body.source.label === 'notes' && del3.body.source.path === null,
    'a COPIED document: the original folder is kept, named by basename', JSON.stringify(del3.body));
  const noConfirm = await call('DELETE', `${base}/notes.md`, {});
  eq(noConfirm.body.reason, 'confirm_required', 'DELETE still requires {confirm: slug}');

  // ═══════════════════════════════════════════════════════════════════════
  section('9. Strict bodies — `token` refused BY NAME on every new/changed route');
  // ═══════════════════════════════════════════════════════════════════════
  const snap = fileSha(manifestPath(P));
  for (const [name, url, body] of [
    ['add-remote', `${base}/add-remote`, { remote: 'acme/lumina', files: [{ path: 'README.md' }], token: CONFIG_TOKEN }],
    ['refresh', `${base}/refresh`, { group: 's2', token: CONFIG_TOKEN }],
    ['source', `${base}/source`, { group: 's1', remote: 'acme/second-brain', token: CONFIG_TOKEN }],
    ['add-local', `${base}/add-local`, { root: NOTES, files: [{ path: 'notes.md' }], token: CONFIG_TOKEN }],
  ]) {
    const r = await call('POST', url, body);
    ok(r.status === 400 && r.body.reason === 'unexpected_fields' && (r.body.fields || []).includes('token')
      && !JSON.stringify(r.body).includes(CONFIG_TOKEN), `${name}: a token in the body is a 400 naming it, never echoed`, JSON.stringify(r.body).slice(0, 200));
  }
  ok(/NEVER sent here/.test((await call('POST', `${base}/add-remote`, { token: 'x' })).body.error || ''),
    'add-remote says a token is never sent here');
  eq(fileSha(manifestPath(P)), snap, '...and none of them wrote anything');
  const extraField = await call('POST', `${base}/add-remote`, { remote: 'acme/lumina', files: [], evil: 1 });
  eq(extraField.body.reason, 'unexpected_fields', 'add-remote refuses any unknown field');
  const badModeAdd = await call('POST', `${base}/add-local`, { root: NOTES, files: [{ path: 'notes.md' }], mode: 'sync' });
  eq(badModeAdd.body.reason, 'invalid_mode', 'add-local refuses an unknown mode by name');
  const roAdd = await call('POST', `/api/memory/${RO}/${RO}/foundations/add-remote`, { remote: 'acme/lumina', files: [{ path: 'README.md' }] });
  eq(roAdd.status, 403, 'add-remote on a read-only Shared Brain mirror is 403');
  const noFiles = await call('POST', `${base}/add-remote`, { remote: 'acme/lumina', files: [] });
  ok(noFiles.status >= 400 && typeof noFiles.body.error === 'string' && noFiles.body.error.length > 10,
    'every add-remote refusal carries prose', JSON.stringify(noFiles.body));

  // ═══════════════════════════════════════════════════════════════════════
  section('10. The MCP — save_foundation (D4), get_project_context, descriptions');
  // ═══════════════════════════════════════════════════════════════════════
  const storage = { listDomains: async () => [D], appendToWriteAudit: async () => {} };
  const mBytes = fileSha(path.join(fdir(P), 'architecture-lumina.md'));
  const sf1 = await TOOLS.saveFoundationHandler({ domain: D, project: P, slug: 'architecture-lumina.md', text: '# Hijack\n', commissioned_by_owner: true }, storage);
  ok(sf1.ok === false && sf1.reason === 'ownership-mismatch' && /is mirrored from acme\/lumina — edit it there and refresh\. Nothing was written\./.test(sf1.error || ''),
    'save_foundation over a MIRRORED slug: ownership-mismatch, naming its source', JSON.stringify(sf1).slice(0, 300));
  ok(sf1.mirrored && sf1.mirrored.label === 'acme/lumina', '...and `mirrored` names where it comes from');
  eq(fileSha(path.join(fdir(P), 'architecture-lumina.md')), mBytes, '...nothing was written');
  const sf2 = await TOOLS.saveFoundationHandler({ domain: D, project: P, slug: 'api-notes', role: 'api', text: '# API notes\n\nBy an agent.\n', commissioned_by_owner: true }, storage);
  ok(sf2.ok === true && sf2.ownership === 'mixed', 'a NEW slug in the same mixed project is written; ownership reads "mixed"', JSON.stringify(sf2).slice(0, 200));
  const ctx = await TOOLS.getProjectContextHandler({ domain: D, project: P, include: 'index' }, storage);
  ok(ctx.ok === true && Array.isArray(ctx.foundations.sources) && ctx.foundations.sources.length === 2,
    'get_project_context on a v2 project carries foundations.sources', JSON.stringify(ctx.foundations && ctx.foundations.sources).slice(0, 300));
  ok(ctx.foundations.index.filter((r) => r.source && r.source.kind === 'repo').every((r) => /^s[12]$/.test(r.source.group)),
    '...and each mirrored index row its source.group');
  const kctx = await TOOLS.getProjectContextHandler({ domain: D, project: KEPT, include: 'index' }, storage);
  ok(kctx.ok === true && !('sources' in kctx.foundations) && kctx.foundations.index.every((r) => !('group' in r.source)),
    'a v1 project: NO sources key and no group on any row (v1 output unmoved)', JSON.stringify(kctx.foundations).slice(0, 200));
  const sfd = TOOLS.saveFoundationDefinition.description;
  ok(sfd.includes('is refused for a document that is MIRRORED from a folder or a GitHub repository (its index row has `source.kind: "repo"`) — that one is refreshed from its source, never edited here. A new document can be written into any project, including one that also mirrors a repository; if the name is taken by a mirrored document the save is refused, so choose another slug.'),
    'save_foundation carries the §6.1 sentence verbatim');
  ok(!/refused for a project whose foundations are mirrored/.test(sfd), '...and not the retired project-wide one');
  ok(/refreshes the documents this project mirrors from that checkout: a folder source inside it, or a GitHub source whose origin it is \(advisory, skipped with a reason otherwise\)\./
    .test(TOOLS.saveWorkingStateDefinition.inputSchema.properties.repo_root.description), 'repo_root carries the §6.1 sentence');
  ok(/`foundations\.sources` names each mirror source/.test(TOOLS.getProjectContextDefinition.description)
    && /`source\.group`/.test(TOOLS.getProjectContextDefinition.description), 'get_project_context names foundations.sources and source.group');
  for (const d of [TOOLS.getProjectContextDefinition, TOOLS.saveFoundationDefinition, TOOLS.saveWorkingStateDefinition]) {
    const b = Buffer.byteLength(JSON.stringify(d));
    ok(b < 3200, `${d.name} stays under the 3,200 B per-turn ceiling (${b} B)`);
  }

  // save_working_state repo_root: the checkout refreshes its own folder
  // source; a GitHub source whose origin it is stays GitHub (root stays null).
  if (gitOk) {
    writeFileSync(path.join(CHECKOUT, 'docs', 'dev', 'decisions.md'), '# Decisions\n\n0001 mirror, edited in the checkout.\n');
    const sv = await TOOLS.saveWorkingStateHandler({ domain: D, project: P, scope: 'boot', headline: 'mixed sources, advisory refresh',
      repo_root: CHECKOUT }, storage);
    ok(sv.ok === true && sv.foundations_refresh && sv.foundations_refresh.attempted === true,
      'save_working_state with repo_root refreshes the source this checkout is', JSON.stringify(sv.foundations_refresh).slice(0, 300));
    const s1 = manifestOf(P).sources.find((g) => g.id === 's1');
    ok(s1 && s1.root === null && s1.remote && s1.remote.repo === 'second-brain',
      '...and s1 (switched to GitHub, origin = this checkout) STAYS a GitHub source: root is not set', JSON.stringify(s1));
    ok(readFileSync(path.join(fdir(P), 'decisions.md'), 'utf8').includes('edited in the checkout'),
      '...read from the working tree (no rate limit spent)');
  } else {
    console.log('  ⊘ git not available — the repo_root refresh is not driven here');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('11. The REAL server: a foreign Origin on add-remote is 403');
  // ═══════════════════════════════════════════════════════════════════════
  const freePort = await new Promise((resolve) => {
    const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(freePort), CURATOR_NO_OPEN: '1', CURATOR_TEST_USER_DATA_DIR: USER_DATA,
      CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_LOG_DIR: path.join(USER_DATA, 'logs'),
      CURATOR_TEST_MCP_LAUNCHER_DIR: path.join(USER_DATA, 'bin') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  try {
    const deadline = Date.now() + 60000;
    let up = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { const r = await REAL_FETCH(`http://127.0.0.1:${freePort}/api/memory`); if (r.status) { up = true; break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    ok(up, 'the real src/server.js started on an isolated port', out.split('\n').slice(0, 8).join(' | '));
    if (up) {
      const url = `http://127.0.0.1:${freePort}/api/memory/${D}/${P}/foundations/add-remote`;
      const body = JSON.stringify({ remote: 'acme/lumina', files: [{ path: 'README.md' }], token: 'x' });
      const evil = await REAL_FETCH(url, { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://evil.example' }, body });
      eq(evil.status, 403, 'a foreign-Origin POST to add-remote is refused 403 by the cross-origin guard');
      const same = await REAL_FETCH(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const sameBody = await same.json();
      ok(same.status === 400 && sameBody.reason === 'unexpected_fields', '...while the same request with no Origin reaches the route (and its strict body)',
        JSON.stringify(sameBody).slice(0, 200));
    }
  } finally {
    child.kill('SIGTERM');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('12. No real network');
  // ═══════════════════════════════════════════════════════════════════════
  eq(NET_ESCAPES.length, 0, 'no request left for anywhere but the fake GitHub and loopback');
  ok(GH_CALLS.every((c) => c.method === 'GET'), 'every GitHub request was a GET');
} finally {
  server.close();
}

console.log(`\n${'═'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ foundations-sources-routes FAILURES'); process.exit(1); }
console.log('✅ All foundations-sources-routes assertions green');
process.exit(0);
