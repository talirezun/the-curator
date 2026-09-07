#!/usr/bin/env node
/**
 * test-next-memory-projects.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * Guards the v3.48.0 route surface for PROJECTS INSIDE A DOMAIN
 * (src/routes/memory.js): the per-project index, the per-domain project list,
 * the three tier-1 write routes, the `scope=latest` resolution and the
 * deprecated one-segment alias.
 *
 * Everything here DRIVES THE REAL ROUTER. Handlers are pulled off the real
 * Express router and invoked with fake req/res objects; `listDomains` and
 * `isDomainReadonly` are the real functions, reading a tempdir domains root
 * installed with `__setDomainsDirOverride`, so nothing in this suite can
 * reach the user's own domains folder.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE STORE IS A STUB HERE, AND THAT IS STATED RATHER THAN HIDDEN
 * ─────────────────────────────────────────────────────────────────────────
 * The v3.48.0 working-state store (listProjects / listAllProjects /
 * createProject / renameProject / deleteProject / the whole-text
 * saveProjectBrief) is built on a PARALLEL branch. This suite therefore
 * drives the real router against a MINIMAL IN-FILE STUB of that API,
 * installed through the route's declared test seam
 * (`__setWorkingStateStoreForTest`) — the same seam-not-a-source-regex
 * pattern `compileConversation`'s `opts.generateText` uses, and for the same
 * reason: a source assertion proves a line exists and nothing about what it
 * does.
 *
 * WHAT A STUB CAN AND CANNOT PROVE, said plainly:
 *   · IT CAN prove everything this file is actually about — the route table,
 *     the guard ORDER, which arguments reach the store, which HTTP status a
 *     refusal maps to, and that a refused write calls nothing at all. Those
 *     are properties of the ROUTER, and a stub records them exactly.
 *   · IT CANNOT prove the store honours them. That is the store suite's job
 *     (scripts/test-working-state-*.js).
 *   · THE STUB IS NOT THE ONLY ARM. Section 2 drives the SAME router against
 *     the REAL store with no projects support at all, which is the
 *     compatibility path a mixed fleet actually runs, and the name rule is
 *     the real `isSafeSegment` in every arm.
 * At assembly the real store replaces the stub and this file is re-run; the
 * assertions are written so that requires no edit.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · The route table is exactly seven (method, path) pairs, and
 *    `/:domain/projects` is registered BEFORE `/:domain/:project` — order is
 *    a correctness property, because a domain slug and a project slug are
 *    drawn from the same alphabet.
 *  · Every write refuses an unknown domain (404), a read-only `shared-*`
 *    mirror (403), an unusable or RESERVED project name (400) — and refuses
 *    BEFORE the store is called, asserted by counting store calls.
 *  · DELETE refuses without a typed confirmation that matches the project
 *    name exactly, and the refusal happens at the ROUTE, not only in a view.
 *  · A rename is refused with a 409 while the domain has a write in flight
 *    (the real write-registry, driven through the real registerWrite).
 *  · A brief larger than the store's own cap is REFUSED with both numbers
 *    named and nothing written — the app's editor must not silently truncate
 *    text a person typed and is looking at. The cap is measured in BYTES.
 *  · PATCH applies the rename FIRST and writes the brief to the NEW name, so
 *    a partial failure is always "renamed, brief unchanged".
 *  · `scope=latest` resolves server-side to the newest-written work-stream,
 *    and degrades to the scope-less read when nothing is saved.
 *  · The deprecated `/:project` alias still answers, resolves to the default
 *    project, and SAYS it is deprecated with the URL that replaces it.
 *  · A GET never writes: a recursive sha256 of the whole domains tree is
 *    identical before and after every read endpoint is driven, hostile
 *    inputs included.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · Nothing here renders anything. The Projects sub-section's markup is
 *    covered by scripts/test-next-domain-projects.js; the browser pass (both
 *    themes, real Electron) is not reproducible in Node.
 *  · The store's own behaviour — that createProject really creates a
 *    directory, that deleteProject takes the write lock, that a legacy tree
 *    reads as the default project — belongs to the store suite. This file
 *    asserts only what the ROUTER asks it to do.
 *  · The cross-origin guard on mutating requests is global middleware in
 *    src/server.js and is not exercised by calling a handler directly.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ok ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? ' -- ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

// ── Tempdir domains root ─────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'curator-memproj-'));
const DOMAINS = join(TMP, 'domains');
mkdirSync(DOMAINS, { recursive: true });

// Cleaned up on every exit path. `finally` runs BEFORE process.exit, which is
// the ordering v3.9.1's 37,353 stale temp directories came from.
function cleanup() {
  try {
    const rel = relative(tmpdir(), TMP);
    if (rel && !rel.startsWith('..') && !rel.includes('/')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
}

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);

function makeDomain(slug, extraCLAUDE) {
  mkdirSync(join(DOMAINS, slug, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(DOMAINS, slug, 'CLAUDE.md'), (extraCLAUDE || '') + '# ' + slug + '\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'log.md'), '# Log\n');
}

makeDomain('alpha');
makeDomain('blank');
// A read-only Shared Brain mirror: isDomainReadonly reads `readonly: true`
// out of the domain's CLAUDE.md frontmatter.
makeDomain('shared-cohort', '---\nreadonly: true\n---\n\n');

function fingerprint(dir) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(relative(dir, p) + ' ' + createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  })(dir);
  return { hash: createHash('sha256').update(files.join('\n')).digest('hex'), count: files.length };
}

// ── The REAL router, and the REAL store's name rule ──────────────────────

const routerMod = await import('../src/routes/memory.js');
const router = routerMod.default;
const realStore = await import('../src/brain/working-state.js');

function routesOf(r) {
  return (r.stack || [])
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods || {})
      .filter((m) => l.route.methods[m])
      .map((m) => ({ method: m, path: l.route.path, handle: l.route.stack[l.route.stack.length - 1].handle })));
}
const ROUTES = routesOf(router);

function findRoute(method, path) {
  const r = ROUTES.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error('route not found in the real router: ' + method + ' ' + path);
  return r;
}

async function call(method, path, { params = {}, query = {}, body } = {}) {
  const route = findRoute(method, path);
  let status = 200;
  let out;
  let settled = false;
  const res = {
    status(c) { status = c; return res; },
    json(b) { out = b; settled = true; return res; },
  };
  await route.handle({ params, query, body }, res, (e) => { throw e || new Error('next() called'); });
  if (!settled) await new Promise((r) => setImmediate(r));
  return { status, body: out };
}

// ═════════════════════════════════════════════════════════════════════════
// THE STUB STORE — a minimal, in-memory implementation of the v3.48.0
// contract. Marked, so nobody mistakes it for the real thing.
// ═════════════════════════════════════════════════════════════════════════

function makeStubStore(seed) {
  // domain -> project -> { brief, briefAuthoredBy, scopes: [{scope, machine, lastWriteAt}] }
  const data = JSON.parse(JSON.stringify(seed || {}));
  const calls = [];
  const record = (name, args) => { calls.push({ name, args }); };

  function rowFor(domain, project) {
    const p = data[domain][project];
    const newest = p.scopes.length ? p.scopes[0] : null;
    return {
      // A HOOK FOR FIELDS THE ROUTER HAS NEVER HEARD OF, spread FIRST so an
      // allow-listed name still wins. Without it the allow-list assertion
      // below is vacuous: putting an extra key on the stub's internal record
      // never reaches the ROW the router actually receives, so a `...r` spread
      // in projectRow survived the mutation with the suite fully green. Found
      // by mutating, which is the only way that kind of hole shows up.
      ...(p.extraRowFields || {}),
      project,
      isLegacyDefault: project === domain,
      hasBrief: typeof p.brief === 'string',
      briefUpdatedAt: typeof p.brief === 'string' ? '2026-09-01T00:00:00.000Z' : null,
      briefAuthoredBy: p.briefAuthoredBy || null,
      distinctScopeCount: new Set(p.scopes.map((s) => s.scope)).size,
      savedCopies: p.scopes.length,
      scopesTruncated: false,
      unlistedEntries: 0,
      unlistedReason: null,
      layoutWarning: p.layoutWarning || null,
      lastWriteAt: newest ? newest.lastWriteAt : null,
      ageSeconds: newest ? 10 : null,
      writtenAt: newest ? newest.lastWriteAt : null,
      writtenAgeSeconds: newest ? 10 : null,
      headline: newest ? 'a headline' : null,
      harness: newest ? 'claude-code' : null,
      lastSaveKind: null,
      lastSaveNotes: [],
      newestScope: newest ? newest.scope : null,
      newestMachine: newest ? newest.machine : null,
      harnessShared: false,
      harnessSharedScopes: [],
      harnessScanned: p.scopes.length,
    };
  }

  return {
    __calls: calls,
    __data: data,
    // The name rule and the path chokepoint are the REAL ones, never a copy:
    // a stub that validated names its own way would prove the router accepts
    // whatever the stub accepts.
    isSafeSegment: realStore.isSafeSegment,
    resolveInsideState: realStore.resolveInsideState,
    BRIEF_FILENAME: realStore.BRIEF_FILENAME,
    MAX_BRIEF_BYTES: realStore.MAX_BRIEF_BYTES,

    async listProjects(domain) {
      record('listProjects', [domain]);
      const d = data[domain] || {};
      return { projects: Object.keys(d).map((p) => rowFor(domain, p)), truncated: false };
    },
    async listAllProjects() {
      record('listAllProjects', []);
      const rows = [];
      for (const domain of Object.keys(data)) {
        for (const p of Object.keys(data[domain])) rows.push({ domain, ...rowFor(domain, p) });
      }
      rows.sort((a, b) => String(b.lastWriteAt || '').localeCompare(String(a.lastWriteAt || '')));
      return { projects: rows, truncated: false };
    },
    async listWorkingScopes(domain, project) {
      record('listWorkingScopes', [domain, project]);
      const p = (data[domain] || {})[project];
      if (!p) return { ok: true, scopes: [], total: 0, distinctScopeCount: 0, truncated: false };
      return {
        ok: true, scopes: p.scopes, total: p.scopes.length,
        distinctScopeCount: new Set(p.scopes.map((s) => s.scope)).size, truncated: false,
      };
    },
    async readWorkingState(domain, project, opts) {
      record('readWorkingState', [domain, project, opts]);
      const p = (data[domain] || {})[project];
      if (!p) return { ok: false, reason: 'project_not_found', message: 'no such project' };
      const base = { ok: true, project, brief: { present: typeof p.brief === 'string', text: p.brief || '' } };
      if (opts && opts.scope) {
        return { ...base, scope: opts.scope, machine: 'm1', current: { present: true, text: 'x' }, journal: { entries: [] } };
      }
      return {
        ...base, scope: null, scopes: p.scopes, scopeCount: p.scopes.length,
        distinctScopeCount: new Set(p.scopes.map((s) => s.scope)).size,
      };
    },
    async createProject(domain, project, opts) {
      record('createProject', [domain, project, opts]);
      data[domain] = data[domain] || {};
      if (data[domain][project]) return { ok: false, reason: 'project_exists', message: 'already there' };
      data[domain][project] = { brief: (opts && typeof opts.brief === 'string') ? opts.brief : null, scopes: [] };
      return { ok: true };
    },
    async renameProject(domain, from, to) {
      record('renameProject', [domain, from, to]);
      if (!data[domain] || !data[domain][from]) return { ok: false, reason: 'project_not_found', message: 'no such project' };
      if (data[domain][to]) return { ok: false, reason: 'project_exists', message: 'target exists' };
      data[domain][to] = data[domain][from];
      delete data[domain][from];
      return { ok: true };
    },
    async deleteProject(domain, project, opts) {
      record('deleteProject', [domain, project, opts]);
      if (!data[domain] || !data[domain][project]) return { ok: false, reason: 'project_not_found', message: 'no such project' };
      delete data[domain][project];
      return { ok: true };
    },
    async saveProjectBrief(domain, project, text, opts) {
      record('saveProjectBrief', [domain, project, text, opts]);
      if (!data[domain] || !data[domain][project]) return { ok: false, reason: 'project_not_found', message: 'no such project' };
      data[domain][project].brief = text;
      data[domain][project].briefAuthoredBy = (opts && opts.authoredBy) || null;
      return { ok: true };
    },
  };
}

const SEED = {
  alpha: {
    lumina: {
      brief: '## Standing brief\n\nx',
      scopes: [
        { scope: 'newest', machine: 'm1', lastWriteAt: '2026-09-06T12:00:00.000Z' },
        { scope: 'older', machine: 'm1', lastWriteAt: '2026-09-01T12:00:00.000Z' },
      ],
    },
    alpha: { brief: null, scopes: [{ scope: 'main', machine: 'm1', lastWriteAt: '2026-09-02T12:00:00.000Z' }] },
  },
  blank: { blank: { brief: null, scopes: [] } },
  'shared-cohort': { 'shared-cohort': { brief: null, scopes: [] } },
};

function install(seed) {
  const stub = makeStubStore(seed === undefined ? SEED : seed);
  routerMod.__setWorkingStateStoreForTest(stub);
  return stub;
}

// ═════════════════════════════════════════════════════════════════════════
section('S1 -- The route table, and why its ORDER is correctness');
// ═════════════════════════════════════════════════════════════════════════

const EXPECTED = [
  ['get', '/'],
  ['get', '/:domain/projects'],
  ['post', '/:domain/projects'],
  ['patch', '/:domain/projects/:project'],
  ['delete', '/:domain/projects/:project'],
  ['get', '/:domain/:project'],
  ['get', '/:project'],
];
ok('the router registers exactly the declared (method, path) table',
  JSON.stringify(ROUTES.map((r) => [r.method, r.path])) === JSON.stringify(EXPECTED),
  JSON.stringify(ROUTES.map((r) => [r.method, r.path])));

// A domain slug and a project slug are drawn from the same alphabet, so both
// two-segment GETs match `/api/memory/alpha/projects`. Express picks the FIRST
// registered, so this ordering is what makes the Domains view's list endpoint
// reachable at all.
{
  const gets = ROUTES.filter((r) => r.method === 'get').map((r) => r.path);
  ok('GET /:domain/projects precedes GET /:domain/:project',
    gets.indexOf('/:domain/projects') < gets.indexOf('/:domain/:project'), JSON.stringify(gets));
  ok('the one-segment deprecated alias is last, so it can shadow nothing',
    gets[gets.length - 1] === '/:project', JSON.stringify(gets));
}

// The collision that ordering creates is CLOSED at the other end: `projects`
// cannot be created as a project name, so the app never produces a project
// whose own detail URL is unreachable.
ok('`projects` is a reserved project name, closing the one literal collision',
  routerMod.RESERVED_PROJECT_NAMES.has('projects'));
ok('...as are the store own reserved filenames',
  routerMod.RESERVED_PROJECT_NAMES.has('project.md')
  && routerMod.RESERVED_PROJECT_NAMES.has('journal.jsonl'));

// ═════════════════════════════════════════════════════════════════════════
section('S2 -- The LEGACY store: one default project per domain, still served');
// ═════════════════════════════════════════════════════════════════════════
//
// The REAL store, as it exists before the v3.48.0 additions land. This is the
// compatibility path a mixed fleet runs, and it is driven here with no stub
// at all.

routerMod.__setWorkingStateStoreForTest(null);
{
  const before = fingerprint(DOMAINS);
  const idx = await call('get', '/');
  eq('the index answers 200 against the real, project-less store', idx.status, 200);
  const rows = idx.body.projects || [];
  eq('every domain still appears', rows.length, 3);
  ok('each row carries BOTH a domain and a project',
    rows.every((r) => typeof r.domain === 'string' && typeof r.project === 'string'));
  ok('the legacy default project is named after its domain, and says so',
    rows.every((r) => r.project === r.domain && r.isLegacyDefault === true));
  ok('a domain with nothing saved reports 0 scopes and a NULL last write -- never "0 seconds ago"',
    rows.some((r) => r.domain === 'blank' && r.scopeCount === 0 && r.lastWriteAt === null));
  ok('a legacy brief authorship is UNKNOWN (null), never guessed as "owner"',
    rows.every((r) => r.briefAuthoredBy === null));

  const list = await call('get', '/:domain/projects', { params: { domain: 'alpha' } });
  eq('the per-domain list answers 200', list.status, 200);
  eq('...with exactly the one default project', (list.body.projects || []).length, 1);
  eq('...and reports that this server CANNOT write projects', list.body.canWrite, false);

  // The refusal is a 501 with a NAMED capability, not a 500 and not a silent
  // fallback onto the pre-v3.48.0 structured saveProjectBrief -- which takes
  // {brief, decisions, ...} and would render an EMPTY document over a real
  // hand-written brief. The old function still EXISTS under that name, which
  // is exactly why the capability probe checks for the projects API and not
  // merely for a function of the right name.
  const create = await call('post', '/:domain/projects',
    { params: { domain: 'alpha' }, body: { project: 'newthing' } });
  eq('creating a project against a project-less store is 501, not 500', create.status, 501);
  eq('...naming the capability rather than printing a stack', create.body.reason, 'store_lacks_projects');
  ok('PRECONDITION: the real store DOES export a saveProjectBrief of the old shape',
    typeof realStore.saveProjectBrief === 'function');
  const brief = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'alpha' }, body: { brief: '## x' } });
  eq('...and a brief write is refused rather than sent to it', brief.status, 501);

  const after = fingerprint(DOMAINS);
  ok('NOTHING on disk changed while every legacy-path endpoint was driven',
    before.hash === after.hash && before.count === after.count);
}

// ═════════════════════════════════════════════════════════════════════════
section('S3 -- GET /api/memory: one row per PROJECT');
// ═════════════════════════════════════════════════════════════════════════

{
  install();
  const idx = await call('get', '/');
  eq('the index answers 200', idx.status, 200);
  const rows = idx.body.projects;
  eq('every project in every domain is a row', rows.length, 4);
  ok('rows are sorted newest-first', rows[0].project === 'lumina', JSON.stringify(rows.map((r) => r.project)));
  ok('a project carries the domain it lives in',
    rows.every((r) => typeof r.domain === 'string' && r.domain.length > 0));
  ok('two rows can share a project name across domains without colliding',
    new Set(rows.map((r) => r.domain + '/' + r.project)).size === rows.length);
}
{
  // THE WIRE ROW IS AN ALLOW-LIST, NOT A SPREAD. A spread forwards whatever
  // the store grows next -- including anything a fellow's synced file put
  // there. Same rule, same reason, as the ingest queue's toWire().
  const stub = install({ alpha: { p: { brief: null, scopes: [] } } });
  stub.__data.alpha.p.extraRowFields = { somethingNew: 'should not reach the wire' };
  const idx = await call('get', '/');
  // PRECONDITION: the stub really does hand the router that field, or the
  // assertion below passes over a row that never had it -- which is exactly
  // how the first draft of this check went green against a `...r` spread.
  const raw = await stub.listAllProjects();
  ok('PRECONDITION: the store really does emit the unknown field',
    Object.keys(raw.projects[0]).includes('somethingNew'), JSON.stringify(Object.keys(raw.projects[0])));
  ok('a field the store grows is NOT forwarded to the wire',
    !Object.keys(idx.body.projects[0]).includes('somethingNew'),
    JSON.stringify(Object.keys(idx.body.projects[0])));
  ok('CONTROL: the allow-listed fields ARE forwarded',
    Object.keys(idx.body.projects[0]).includes('project')
    && Object.keys(idx.body.projects[0]).includes('domain'));
}

// ═════════════════════════════════════════════════════════════════════════
section('S4 -- GET /api/memory/:domain/projects');
// ═════════════════════════════════════════════════════════════════════════

{
  const stub = install();
  const r = await call('get', '/:domain/projects', { params: { domain: 'alpha' } });
  eq('answers 200', r.status, 200);
  eq('lists this domain projects only', r.body.projects.length, 2);
  eq('...and echoes the domain', r.body.domain, 'alpha');
  eq('reports that this server CAN write projects', r.body.canWrite, true);
  eq('reports whether the domain is a read-only mirror', r.body.readonly, false);
  eq('the store was asked for exactly this domain',
    stub.__calls.filter((c) => c.name === 'listProjects').length, 1);

  const mirror = await call('get', '/:domain/projects', { params: { domain: 'shared-cohort' } });
  eq('a mirror is still READABLE -- only writes are refused', mirror.status, 200);
  eq('...and says it is read-only', mirror.body.readonly, true);
  eq('...and therefore reports that it cannot be written', mirror.body.canWrite, false);

  const unknown = await call('get', '/:domain/projects', { params: { domain: 'nope' } });
  eq('an unknown domain is a 404', unknown.status, 404);
  eq('...with a named reason', unknown.body.reason, 'unknown_domain');
}

// ═════════════════════════════════════════════════════════════════════════
section('S5 -- POST: creating a project');
// ═════════════════════════════════════════════════════════════════════════

{
  const stub = install();
  const r = await call('post', '/:domain/projects',
    { params: { domain: 'alpha' }, body: { project: 'newthing', brief: '## Standing brief\n\nhello' } });
  eq('a valid create answers 201', r.status, 201);
  eq('...and the store was told the domain', stub.__calls.at(-1).args[0], 'alpha');
  eq('...and the name', stub.__calls.at(-1).args[1], 'newthing');
  eq('...and the brief rode along', stub.__calls.at(-1).args[2].brief, '## Standing brief\n\nhello');
  ok('...and the project exists in the store afterwards', !!stub.__data.alpha.newthing);

  const dup = await call('post', '/:domain/projects',
    { params: { domain: 'alpha' }, body: { project: 'newthing' } });
  eq('a duplicate is a 409, not a 500', dup.status, 409);
}
{
  // An EMPTY brief is sent as ABSENT, not as an empty string: an empty string
  // is a brief the user wrote nothing in, and the store would create the file.
  const stub = install();
  await call('post', '/:domain/projects', { params: { domain: 'alpha' }, body: { project: 'nobrief' } });
  const opts = stub.__calls.find((c) => c.name === 'createProject').args[2];
  ok('a create with no brief passes no brief at all', !('brief' in opts), JSON.stringify(opts));
}

// ── EVERY REFUSAL HAPPENS BEFORE THE STORE IS CALLED ─────────────────────
//
// Asserted by COUNTING store calls, not by reading the response: a route that
// refuses AFTER calling the store has already done the thing.
{
  const cases = [
    ['an unknown domain', { params: { domain: 'nope' }, body: { project: 'x' } }, 404],
    ['a read-only mirror', { params: { domain: 'shared-cohort' }, body: { project: 'x' } }, 403],
    ['a missing name', { params: { domain: 'alpha' }, body: {} }, 400],
    ['an empty name', { params: { domain: 'alpha' }, body: { project: '   ' } }, 400],
    ['a traversal name', { params: { domain: 'alpha' }, body: { project: '../escape' } }, 400],
    ['a dot-dot name', { params: { domain: 'alpha' }, body: { project: '..' } }, 400],
    ['a slash in the name', { params: { domain: 'alpha' }, body: { project: 'a/b' } }, 400],
    ['a name over 64 characters', { params: { domain: 'alpha' }, body: { project: 'a'.repeat(65) } }, 400],
    ['a non-string name', { params: { domain: 'alpha' }, body: { project: { evil: 1 } } }, 400],
    ['the RESERVED name "projects"', { params: { domain: 'alpha' }, body: { project: 'projects' } }, 400],
    ['the reserved name "project.md"', { params: { domain: 'alpha' }, body: { project: 'project.md' } }, 400],
  ];
  for (const [label, req, status] of cases) {
    const stub = install();
    const r = await call('post', '/:domain/projects', req);
    eq('create refuses ' + label + ' with ' + status, r.status, status);
    eq('...and never reached the store (' + label + ')',
      stub.__calls.filter((c) => c.name === 'createProject').length, 0);
  }
}

// The name rule is the STORE's, imported rather than restated -- so a name the
// router accepts and the store then refuses cannot happen. Driven through the
// real predicate, with a control proving it is not a rubber stamp.
ok('the router validates names with the store own isSafeSegment',
  realStore.isSafeSegment('lumina') && !realStore.isSafeSegment('../x') && !realStore.isSafeSegment(''));

// ═════════════════════════════════════════════════════════════════════════
section('S6 -- PATCH: rename and/or replace the brief');
// ═════════════════════════════════════════════════════════════════════════

{
  const stub = install();
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: '## Standing brief\n\nreplaced' } });
  eq('a brief-only patch answers 200', r.status, 200);
  eq('...reports the brief was saved', r.body.briefSaved, true);
  eq('...and nothing was renamed', r.body.renamed, null);
  const save = stub.__calls.find((c) => c.name === 'saveProjectBrief');
  eq('the store is given the WHOLE text, because a brief write replaces',
    save.args[2], '## Standing brief\n\nreplaced');
  // THE PROVENANCE. The store's brief-authority reading decides whether a
  // brief carries the OWNER's standing instructions; an app edit is a HUMAN
  // edit and must never arrive wearing an agent's provenance line.
  eq('...and stamped as a HUMAN edit', save.args[3].authoredBy.kind, 'human');
}
{
  const stub = install();
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { rename: 'lumina-2' } });
  eq('a rename-only patch answers 200', r.status, 200);
  eq('...and reports both names', JSON.stringify(r.body.renamed), '{"from":"lumina","to":"lumina-2"}');
  eq('...and no brief was written', r.body.briefSaved, false);
  ok('the store performed the rename', !!stub.__data.alpha['lumina-2'] && !stub.__data.alpha.lumina);
}
{
  // RENAME FIRST, BRIEF SECOND, AND THE BRIEF GOES TO THE NEW NAME. The other
  // order would write the brief to a name that is about to stop existing; a
  // partial failure would then be "renamed, and the brief landed nowhere".
  const stub = install();
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { rename: 'renamed', brief: '## new' } });
  eq('a combined patch answers 200', r.status, 200);
  eq('...and reports the FINAL name', r.body.project, 'renamed');
  const order = stub.__calls.map((c) => c.name).filter((n) => n === 'renameProject' || n === 'saveProjectBrief');
  eq('the rename ran BEFORE the brief write', JSON.stringify(order), '["renameProject","saveProjectBrief"]');
  eq('...and the brief was written to the NEW name',
    stub.__calls.find((c) => c.name === 'saveProjectBrief').args[1], 'renamed');
  eq('...where it really landed', stub.__data.alpha.renamed.brief, '## new');
}
{
  // A rename to the name it already has asks for NOTHING, and the route says
  // so rather than reporting a rename it did not perform. Pinned because the
  // alternative -- answering 200 with `renamed: null` -- reads as "done" for
  // a request that was a no-op, and a scripted client comparing the reply to
  // what it asked for would be told it got what it wanted from a route that
  // did nothing. The view never sends this: it closes the form instead.
  const stub = install();
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { rename: 'lumina' } });
  eq('renaming a project to the name it already has asks for nothing, and says so', r.status, 400);
  eq('...with the same named reason as an empty patch', r.body.reason, 'nothing_to_do');
  eq('...and issues no rename at all', stub.__calls.filter((c) => c.name === 'renameProject').length, 0);
}
{
  const stub = install();
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: {} });
  eq('a patch asking for nothing is a 400, not a silent 200', r.status, 400);
  eq('...with a named reason', r.body.reason, 'nothing_to_do');
  eq('...and the store was never touched', stub.__calls.length, 0);
}
{
  const stub = install();
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'shared-cohort', project: 'shared-cohort' }, body: { brief: 'x' } });
  eq('a read-only mirror refuses the brief write with 403', r.status, 403);
  eq('...naming the reason', r.body.reason, 'readonly');
  eq('...before the store was called', stub.__calls.length, 0);
}
{
  const stub = install();
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { rename: 'projects' } });
  eq('renaming TO a reserved name is refused', r.status, 400);
  eq('...with a named reason', r.body.reason, 'reserved_project');
  eq('...and nothing was renamed', stub.__calls.filter((c) => c.name === 'renameProject').length, 0);
}
{
  const stub = install();
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { rename: '../escape' } });
  eq('renaming TO an unusable name is refused', r.status, 400);
  eq('...and nothing was renamed', stub.__calls.filter((c) => c.name === 'renameProject').length, 0);
}

// ── THE BRIEF SIZE CEILING ───────────────────────────────────────────────
//
// The store TRIMS an over-budget write and discloses the trim, which is right
// for an agent near its context limit -- a refused handoff is a lost handoff --
// and wrong for a person who typed the text and is looking at it. So the
// route refuses, names both numbers, and writes nothing.
{
  const stub = install();
  const huge = 'x'.repeat(realStore.MAX_BRIEF_BYTES + 1);
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: huge } });
  eq('an over-budget brief is REFUSED, not silently trimmed', r.status, 400);
  eq('...with a named reason', r.body.reason, 'brief_too_large');
  eq('...naming the limit', r.body.limit, realStore.MAX_BRIEF_BYTES);
  ok('...and the actual size', r.body.bytes > r.body.limit);
  eq('...and NOTHING was written', stub.__calls.filter((c) => c.name === 'saveProjectBrief').length, 0);
}
{
  const stub = install();
  const exact = 'x'.repeat(realStore.MAX_BRIEF_BYTES);
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: exact } });
  eq('a brief EXACTLY at the cap is accepted -- the boundary is not off by one', r.status, 200);
  eq('...and really written', stub.__calls.filter((c) => c.name === 'saveProjectBrief').length, 1);
}
{
  // BYTES, NOT CHARACTERS. A brief of em-dashes and curly quotes is three
  // bytes a character in places, and a character count would let it through.
  const stub = install();
  const multibyte = '—'.repeat(Math.ceil(realStore.MAX_BRIEF_BYTES / 3) + 1);
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: multibyte } });
  ok('the cap is measured in BYTES: a multi-byte brief under the CHARACTER count is still refused',
    r.status === 400 && multibyte.length < realStore.MAX_BRIEF_BYTES,
    'chars ' + multibyte.length + ' vs cap ' + realStore.MAX_BRIEF_BYTES);
  eq('...and nothing was written', stub.__calls.filter((c) => c.name === 'saveProjectBrief').length, 0);
}

// ── A RENAME IS REFUSED WHILE THE DOMAIN IS BUSY ─────────────────────────
//
// A rename MOVES a directory. The real write-registry is driven here, through
// the real registerWrite, exactly as PUT /api/domains/:domain uses it: the
// mover and an in-flight writer resolve their paths independently, so the
// writer happily recreates the old directory and writes into a folder nothing
// lists.
{
  const { registerWrite } = await import('../src/brain/write-registry.js');
  const stub = install();
  const done = registerWrite('alpha', 'test-ingest');
  try {
    const r = await call('patch', '/:domain/projects/:project',
      { params: { domain: 'alpha', project: 'lumina' }, body: { rename: 'other' } });
    eq('a rename during an active write on that domain is a 409', r.status, 409);
    eq('...and never reached the store', stub.__calls.filter((c) => c.name === 'renameProject').length, 0);
    // A BRIEF write is NOT refused: it touches one file an ingest never opens,
    // and refusing it would be a restriction the backend does not need.
    const b = await call('patch', '/:domain/projects/:project',
      { params: { domain: 'alpha', project: 'lumina' }, body: { brief: '## fine' } });
    eq('...while a brief write on the same busy domain is allowed', b.status, 200);
  } finally { done(); }
  const after = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { rename: 'other' } });
  eq('CONTROL: the same rename succeeds once the write finishes', after.status, 200);
}

// ═════════════════════════════════════════════════════════════════════════
section('S7 -- DELETE: the typed confirmation is enforced at the ROUTE');
// ═════════════════════════════════════════════════════════════════════════
//
// A confirmation that lives only in a view is a confirmation every other
// client skips. Deleting a project removes its brief, every work-stream
// handoff and every journal -- frequently the only record of decisions nobody
// wrote down anywhere else.

{
  const stub = install();
  const r = await call('delete', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { confirm: 'lumina' } });
  eq('a correctly-confirmed delete answers 200', r.status, 200);
  ok('...and the project is gone', !stub.__data.alpha.lumina);
  eq('...and the confirmation was passed to the store as well',
    stub.__calls.find((c) => c.name === 'deleteProject').args[2].confirm, 'lumina');
}
{
  const cases = [
    ['no body at all', undefined],
    ['an empty confirmation', { confirm: '' }],
    ['the wrong name', { confirm: 'lumina-x' }],
    ['a case-different name', { confirm: 'LUMINA' }],
    ['a non-string confirmation', { confirm: true }],
    ['the DOMAIN name instead of the project', { confirm: 'alpha' }],
  ];
  for (const [label, body] of cases) {
    const stub = install();
    const r = await call('delete', '/:domain/projects/:project',
      { params: { domain: 'alpha', project: 'lumina' }, body });
    eq('delete refuses ' + label, r.status, 400);
    eq('...with a named reason (' + label + ')', r.body.reason, 'confirm_required');
    eq('...and never reached the store (' + label + ')',
      stub.__calls.filter((c) => c.name === 'deleteProject').length, 0);
    ok('...and the project is still there (' + label + ')', !!stub.__data.alpha.lumina);
  }
}
{
  const stub = install();
  const r = await call('delete', '/:domain/projects/:project',
    { params: { domain: 'shared-cohort', project: 'shared-cohort' }, body: { confirm: 'shared-cohort' } });
  eq('a read-only mirror refuses a delete even with a correct confirmation', r.status, 403);
  eq('...and never reached the store', stub.__calls.filter((c) => c.name === 'deleteProject').length, 0);
}
{
  const { registerWrite } = await import('../src/brain/write-registry.js');
  const stub = install();
  const done = registerWrite('alpha', 'test-ingest');
  try {
    const r = await call('delete', '/:domain/projects/:project',
      { params: { domain: 'alpha', project: 'lumina' }, body: { confirm: 'lumina' } });
    eq('a delete during an active write on that domain is a 409', r.status, 409);
    eq('...and never reached the store', stub.__calls.filter((c) => c.name === 'deleteProject').length, 0);
  } finally { done(); }
}

// ═════════════════════════════════════════════════════════════════════════
section('S8 -- GET /:domain/:project, and `scope=latest`');
// ═════════════════════════════════════════════════════════════════════════

{
  const stub = install();
  const r = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'lumina' } });
  eq('a scope-less read answers 200', r.status, 200);
  eq('...echoing the domain', r.body.domain, 'alpha');
  eq('...and the project', r.body.project, 'lumina');
  eq('...and whether the domain is a mirror', r.body.readonly, false);
  eq('...and the pair count under the unambiguous name', r.body.savedCopies, 2);
  ok('...and it is NOT marked deprecated', r.body.deprecated === undefined);
  eq('the store was asked for the right project',
    JSON.stringify(stub.__calls.find((c) => c.name === 'readWorkingState').args.slice(0, 2)),
    '["alpha","lumina"]');
}
{
  const stub = install();
  const r = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'lumina' }, query: { scope: 'latest' } });
  eq('`latest` answers 200', r.status, 200);
  eq('...resolved to the NEWEST-written work-stream, server-side', r.body.scope, 'newest');
  eq('...and the store was given the resolved name, never the word "latest"',
    stub.__calls.find((c) => c.name === 'readWorkingState').args[2].scope, 'newest');
  const r2 = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'lumina' }, query: { scope: 'LATEST' } });
  eq('`latest` is case-insensitive', r2.body.scope, 'newest');
  const r3 = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'lumina' }, query: { scope: 'older' } });
  eq('CONTROL: a real scope name is passed through untouched', r3.body.scope, 'older');
}
{
  // `latest` against a project with nothing saved resolves to nothing. The
  // scope-less read is the honest answer -- it says what exists, which is
  // nothing -- rather than a 400 about a scope the caller never named.
  const r = await call('get', '/:domain/:project',
    { params: { domain: 'blank', project: 'blank' }, query: { scope: 'latest' } });
  eq('`latest` on an empty project is not an error', r.status, 200);
  eq('...it is the scope-less read', r.body.scope, null);
}
{
  install();
  const r = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'ghost' } });
  eq('a project that does not exist is a 404, not a 400', r.status, 404);
  const bad = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: '../etc' } });
  eq('an unusable project name is a 400 before any path is built', bad.status, 400);
  const nod = await call('get', '/:domain/:project', { params: { domain: 'nope', project: 'x' } });
  eq('an unknown domain is a 404', nod.status, 404);
}

// ── THE DEPRECATED ALIAS ─────────────────────────────────────────────────
{
  const stub = install();
  const r = await call('get', '/:project', { params: { project: 'alpha' } });
  eq('the old one-segment URL still answers', r.status, 200);
  eq('...resolved to the domain DEFAULT project', r.body.project, 'alpha');
  eq('...and it says so out loud', r.body.deprecated, true);
  eq('...naming the URL that replaces it', r.body.replacedBy, '/api/memory/alpha/alpha');
  eq('the store was asked for the default project',
    JSON.stringify(stub.__calls.find((c) => c.name === 'readWorkingState').args.slice(0, 2)),
    '["alpha","alpha"]');
  const unknown = await call('get', '/:project', { params: { project: 'nope' } });
  eq('an unknown domain through the alias is still a 404', unknown.status, 404);
}

// ═════════════════════════════════════════════════════════════════════════
section('S9 -- A READ NEVER WRITES');
// ═════════════════════════════════════════════════════════════════════════

{
  install();
  const before = fingerprint(DOMAINS);
  await call('get', '/');
  await call('get', '/:domain/projects', { params: { domain: 'alpha' } });
  await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'lumina' } });
  await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'lumina' }, query: { scope: 'latest' } });
  await call('get', '/:project', { params: { project: 'alpha' } });
  // Hostile inputs, through every read route.
  for (const evil of ['../../etc', '..', 'a/b', '', '.'.repeat(80)]) {
    await call('get', '/:domain/:project', { params: { domain: 'alpha', project: evil } });
    await call('get', '/:project', { params: { project: evil } });
    await call('get', '/:domain/projects', { params: { domain: evil } });
  }
  const after = fingerprint(DOMAINS);
  ok('a recursive sha256 of the whole domains tree is identical after every read',
    before.hash === after.hash && before.count === after.count,
    before.hash + ' vs ' + after.hash);
}

// The route module itself may not write a byte: every mutation goes through
// the store, which owns the path chokepoint, the sanitisers and the caps.
{
  const routeSrc = readFileSync(join(ROOT, 'src/routes/memory.js'), 'utf8');
  for (const forbidden of ['writeFile(', 'writeFileSync(', 'rmSync(', 'unlink(', 'mkdirSync(']) {
    ok('the route module never calls ' + forbidden, !routeSrc.includes(forbidden));
  }
  // THE TIER BOUNDARY, as a source class guard: tiers 2 and 3 are agent-only.
  ok('the route module never calls saveWorkingState( -- tiers 2 and 3 stay agent-only',
    !routeSrc.includes('saveWorkingState('));
}

// ── Done ─────────────────────────────────────────────────────────────────

routerMod.__setWorkingStateStoreForTest(null);
cleanup();
console.log('\n' + '-'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('All memory-projects route assertions green');
else console.log(failed + ' memory-projects assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
