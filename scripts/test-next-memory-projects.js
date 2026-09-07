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
 * TWO ARMS: THE REAL STORE, AND A RECORDING STUB
 * ─────────────────────────────────────────────────────────────────────────
 * §2 drives every route against the REAL `src/brain/working-state.js` over a
 * real state tree in the tempdir — create, list, read, rename, delete, the
 * brief, `scope=latest` and the deprecated alias — and checks the FILES
 * afterwards. That is the arm that proves the router and the store agree
 * about argument shape, which is the whole reason this file was revised:
 * the project rides on the store's OPTIONS object, and passing it
 * positionally does not throw — the store reads `opts.project` off a string,
 * gets undefined, and answers about the domain's own project instead. Every
 * assertion in a stub arm would have stayed green through that.
 *
 * §3 onward install a RECORDING STUB through the route's declared test seam
 * (`__setWorkingStateStoreForTest`) — the same seam-not-a-source-regex
 * pattern `compileConversation`'s `opts.generateText` uses. The stub is for
 * the two things a real store cannot show: WHICH ARGUMENTS reached it (and,
 * more often, that a refused write reached it ZERO times), and refusals that
 * are awkward to provoke for real. Its shape is kept in step with the real
 * store's by §2 sitting above it: a signature change that the stub alone
 * tolerated would red the real-store arm.
 *
 * WHAT NEITHER ARM PROVES: that the store's own guarantees hold — the write
 * lock, the sanitisers, the shrink guard. That is the store suite's job
 * (scripts/test-working-state-*.js). And nothing here renders anything.
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
 *  · The store's own INTERNAL guarantees — that deleteProject takes the write
 *    lock, that the sanitisers run, that the shrink guard fires — belong to
 *    the store suite. §2 checks the store's OUTPUT (files on disk, provenance
 *    read back) because that is what the router's correctness depends on.
 *  · The cross-origin guard on mutating requests is global middleware in
 *    src/server.js and is not exercised by calling a handler directly.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
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
      isDefaultProject: project === domain,
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
      const rows = Object.keys(d).map((p) => rowFor(domain, p));
      return { ok: true, domain, projects: rows, total: rows.length, truncated: false };
    },
    async listAllProjects() {
      record('listAllProjects', []);
      const rows = [];
      for (const domain of Object.keys(data)) {
        for (const p of Object.keys(data[domain])) rows.push({ domain, ...rowFor(domain, p) });
      }
      rows.sort((a, b) => String(b.lastWriteAt || '').localeCompare(String(a.lastWriteAt || '')));
      return { ok: true, projects: rows, total: rows.length, truncated: false };
    },
    // THE PROJECT RIDES ON THE OPTIONS OBJECT, exactly as the real store takes
    // it. Written positionally this reads `opts.project` off a string, gets
    // undefined, and answers about the domain's own project — silently. The
    // stub mirrors the real signature so that a router regression to the
    // positional form reds HERE as well as in the real-store arm.
    async readWorkingState(domain, opts) {
      record('readWorkingState', [domain, opts]);
      const project = opts && opts.project ? opts.project : domain;
      const p = (data[domain] || {})[project];
      // The store's own answer for a named project that was never created:
      // ok, with the existence reported as a FACT rather than as a refusal.
      if (!p) return { ok: true, project, domain, projectExists: false, brief: { present: false } };
      const base = {
        ok: true, project, domain, projectExists: true,
        brief: { present: typeof p.brief === 'string', text: p.brief || '' },
      };
      if (opts && opts.scope) {
        // `latest` is the STORE's keyword, resolved by the store. The router
        // hands the word straight through, so the stub resolves it too.
        const wanted = String(opts.scope).trim().toLowerCase() === 'latest'
          ? (p.scopes.length ? p.scopes[0].scope : null)
          : opts.scope;
        if (wanted) {
          return {
            ...base, scope: wanted, machine: 'm1',
            scopeResolvedBy: String(opts.scope).trim().toLowerCase() === 'latest' ? 'latest' : 'exact',
            current: { present: true, text: 'x' }, journal: { entries: [] },
          };
        }
      }
      return {
        ...base, scope: null, scopes: p.scopes, scopeCount: p.scopes.length,
        distinctScopeCount: new Set(p.scopes.map((s) => s.scope)).size,
      };
    },
    async createProject(domain, project, opts) {
      record('createProject', [domain, project, opts]);
      data[domain] = data[domain] || {};
      if (data[domain][project]) return { ok: false, reason: 'project-exists', message: 'already there' };
      data[domain][project] = { brief: (opts && typeof opts.brief === 'string') ? opts.brief : null, scopes: [] };
      return { ok: true };
    },
    async renameProject(domain, from, to) {
      record('renameProject', [domain, from, to]);
      if (!data[domain] || !data[domain][from]) return { ok: false, reason: 'unknown-state-project', message: 'no such project' };
      if (data[domain][to]) return { ok: false, reason: 'project-exists', message: 'target exists' };
      data[domain][to] = data[domain][from];
      delete data[domain][from];
      return { ok: true };
    },
    async deleteProject(domain, project, opts) {
      record('deleteProject', [domain, project, opts]);
      if (!data[domain] || !data[domain][project]) return { ok: false, reason: 'unknown-state-project', message: 'no such project' };
      delete data[domain][project];
      return { ok: true };
    },
    // THE WHOLE-TEXT WRITER, by its real name. The store also exports
    // `saveProjectBrief`, which DISPATCHES ON ARGUMENT SHAPE and still accepts
    // the pre-v3.48.0 structured form that renders the document from four
    // known section keys — dropping every hand-written heading. The stub
    // deliberately does NOT offer that name, so a router calling it reds here.
    async saveProjectBriefText(domain, project, text, opts) {
      record('saveProjectBriefText', [domain, project, text, opts]);
      if (!data[domain] || !data[domain][project]) return { ok: false, reason: 'unknown-state-project', message: 'no such project' };
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
section('S2 -- THE REAL STORE, end to end, over a real state tree');
// ═════════════════════════════════════════════════════════════════════════
//
// No stub at all: the real `src/brain/working-state.js` over the tempdir
// domains root. This arm exists because the mismatch it catches is SILENT.
// The store takes the project on its OPTIONS object; a router passing it
// positionally reads `opts.project` off a string, gets undefined, and is
// answered about the DOMAIN'S OWN project — the wrong tree under the right
// name, with every stub assertion still green.

routerMod.__setWorkingStateStoreForTest(null);
{
  // A pre-v3.48.0-shaped tree in `alpha`: a standing brief and one work-stream
  // at the ROOT of state/, which is where the domain's own project lives —
  // permanently, not pending a migration.
  const st = join(DOMAINS, 'alpha', 'state');
  mkdirSync(join(st, 'main', 'macbook-ab12'), { recursive: true });
  writeFileSync(join(st, 'project.md'), '# alpha\n\n## Standing brief\n\nThe domain own project.\n');
  writeFileSync(join(st, 'main', 'macbook-ab12', 'current.md'), '# Handoff\n\n## Headline\n\nroot work-stream\n');
  mkdirSync(join(st, 'older', 'macbook-ab12'), { recursive: true });
  writeFileSync(join(st, 'older', 'macbook-ab12', 'current.md'), '# Handoff\n\n## Headline\n\nolder\n');
  // `main` is written LAST so it is the newest by mtime, which is what
  // `scope=latest` must resolve to.
  writeFileSync(join(st, 'main', 'macbook-ab12', 'current.md'), '# Handoff\n\n## Headline\n\nroot work-stream\n');

  const idx = await call('get', '/');
  eq('the index answers 200 against the real store', idx.status, 200);
  const rows = idx.body.projects || [];
  const own = rows.find((r) => r.domain === 'alpha' && r.project === 'alpha');
  ok('the domain own project is a row', !!own, JSON.stringify(rows.map((r) => r.domain + '/' + r.project)));
  eq('...flagged with the STORE own field name', own.isDefaultProject, true);
  eq('...with its brief seen', own.hasBrief, true);
  eq('...and its two work-streams counted', own.distinctScopeCount, 2);
  eq('...as two saved copies', own.savedCopies, 2);
  eq('...naming the newest', own.newestScope, 'main');
  ok('a domain with nothing saved and no brief is omitted by the store, not invented here',
    !rows.some((r) => r.domain === 'blank'), JSON.stringify(rows.map((r) => r.domain)));

  // ── CREATE, for real ───────────────────────────────────────────────────
  const created = await call('post', '/:domain/projects',
    { params: { domain: 'alpha' }, body: { project: 'lumina', brief: '## Standing brief\n\nBuild the thing.' } });
  eq('a create answers 201', created.status, 201);
  const briefPath = join(st, 'lumina', 'project.md');
  const onDisk = readFileSync(briefPath, 'utf8');
  ok('...and project.md really exists under the project directory', onDisk.includes('Build the thing.'));
  // THE PROVENANCE. `classifyBriefAuthority` grants OWNER authority to a brief
  // whose provenance reads human (or is absent), and only `commissioned` to
  // one an agent wrote. An app edit is a human edit and the FILE must say so.
  ok('...stamped as a HUMAN edit in the file itself',
    /authored_by=human/.test(onDisk), onDisk.split('\n')[0]);
  const backBrief = await realStore.readProjectBrief('alpha', 'lumina');
  eq('...which the store reads back as human', backBrief.authoredBy.kind, 'human');

  const listed = await call('get', '/:domain/projects', { params: { domain: 'alpha' } });
  eq('the per-domain list answers 200', listed.status, 200);
  eq('...and this server CAN write projects', listed.body.canWrite, true);
  const names = listed.body.projects.map((r) => r.project).sort();
  eq('...listing the new project beside the domain own', JSON.stringify(names), '["alpha","lumina"]');

  // ── READ ONE PROJECT ───────────────────────────────────────────────────
  const one = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'lumina' } });
  eq('reading the new project answers 200', one.status, 200);
  eq('...and it is the PROJECT that was asked for, not the domain own',
    one.body.project, 'lumina');
  ok('...whose brief is the one just written',
    (one.body.brief.text || '').includes('Build the thing.'), JSON.stringify(one.body.brief).slice(0, 120));
  eq('...with no work-streams of its own yet', one.body.savedCopies, 0);

  // THE MIX-UP THIS ARM EXISTS FOR, as a direct assertion: the domain's own
  // project has a DIFFERENT brief and two work-streams, so a router that
  // dropped the project on the floor would answer with these instead.
  const root = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'alpha' } });
  eq('CONTROL: the domain own project is a different read', root.body.savedCopies, 2);
  ok('...with its own brief', (root.body.brief.text || '').includes('The domain own project.'));

  // ── scope=latest, resolved by the STORE ────────────────────────────────
  const latest = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'alpha' }, query: { scope: 'latest' } });
  eq('`latest` answers 200', latest.status, 200);
  eq('...resolved to the newest-written work-stream', latest.body.scope, 'main');
  eq('...and says the keyword was what resolved it', latest.body.scopeResolvedBy, 'latest');
  const named = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'alpha' }, query: { scope: 'older' } });
  eq('CONTROL: a named work-stream is opened as named', named.body.scope, 'older');
  const cold = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'lumina' }, query: { scope: 'latest' } });
  eq('`latest` on a project with nothing saved is not an error', cold.status, 200);
  eq('...it is the scope-less "what exists" read', cold.body.scope, null);

  // ── THE DEPRECATED ALIAS ───────────────────────────────────────────────
  const alias = await call('get', '/:project', { params: { project: 'alpha' } });
  eq('the old one-segment URL still answers', alias.status, 200);
  eq('...resolved to the domain own project', alias.body.project, 'alpha');
  eq('...and says it is deprecated', alias.body.deprecated, true);
  eq('...naming the URL that replaces it', alias.body.replacedBy, '/api/memory/alpha/alpha');
  eq('...and it is the SAME answer the two-segment URL gives',
    alias.body.savedCopies, root.body.savedCopies);

  // ── THE BRIEF EDIT ─────────────────────────────────────────────────────
  const edited = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: '## Standing brief\n\nEdited in the app.' } });
  eq('a brief edit answers 200', edited.status, 200);
  eq('...and reports the write', edited.body.briefSaved, true);
  const after = readFileSync(briefPath, 'utf8');
  ok('...and the file really changed', after.includes('Edited in the app.'));
  ok('...still stamped human', /authored_by=human/.test(after));
  ok('...with exactly ONE provenance comment, not a stack of them',
    after.split('curator-brief:').length - 1 === 1, after.slice(0, 200));

  // A DELIBERATE SHRINK IS ACCEPTED. The store refuses a brief under 5% of
  // the stored one, because tier 1 has no journal behind it — right for an
  // agent composing blind, wrong for a person whose editor was seeded with
  // the current text and who then pressed Save. The refusal's own advice
  // ("repeat the call with replace: true") is advice a browser cannot take.
  const big = '## Standing brief\n\n' + 'a lot of standing brief. '.repeat(120);
  await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: big } });
  ok('PRECONDITION: the stored brief is over the shrink guard floor',
    readFileSync(briefPath, 'utf8').length > 1024);
  const shrunk = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: '# start over' } });
  eq('a deliberate shrink from the app is ACCEPTED, not refused with unusable advice',
    shrunk.status, 200);
  ok('...and the file is the short one', readFileSync(briefPath, 'utf8').includes('start over'));
  // CONTROL: the guard is not switched off wholesale -- an EMPTY brief is
  // still refused, ahead of the shrink guard and regardless of replace.
  const empty = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: '   \n  ' } });
  eq('CONTROL: an EMPTY brief is still refused', empty.status, 400);
  eq('...with the store own named reason', empty.body.reason, 'empty-brief');
  ok('...and its prose reaches the shell own `error` key, not just `message`',
    typeof empty.body.error === 'string' && empty.body.error.length > 0
    && empty.body.error === empty.body.message, JSON.stringify(empty.body));

  // ── RENAME, AND THE ONE PROJECT THAT CANNOT BE RENAMED ─────────────────
  const renamed = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { rename: 'lumina-ai' } });
  eq('a rename answers 200', renamed.status, 200);
  ok('...and the directory really moved',
    !existsSync(join(st, 'lumina')) && existsSync(join(st, 'lumina-ai', 'project.md')));

  const refusedDefault = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'alpha' }, body: { rename: 'something-else' } });
  eq('the domain OWN project cannot be renamed', refusedDefault.status, 400);
  eq('...with the store own named reason', refusedDefault.body.reason, 'default-project');
  ok('...explaining that its directory holds every other project',
    /every other project|them all/.test(String(refusedDefault.body.error || '')),
    String(refusedDefault.body.error));

  // A name that is already a work-stream of the domain's own project is
  // refused too -- a project of that name would sit on top of it.
  const onTop = await call('post', '/:domain/projects',
    { params: { domain: 'alpha' }, body: { project: 'main' } });
  eq('a project named after an existing work-stream is refused', onTop.status, 400);
  eq('...with the store own named reason', onTop.body.reason, 'reserved-project');

  const dup = await call('post', '/:domain/projects',
    { params: { domain: 'alpha' }, body: { project: 'lumina-ai' } });
  eq('a duplicate create is a 409', dup.status, 409);
  ok('...and the store prose reaches `error`',
    /already exists/.test(String(dup.body.error || '')), String(dup.body.error));

  // ── A PROJECT THAT WAS NEVER CREATED ───────────────────────────────────
  const ghost = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'ghost' } });
  eq('a project that does not exist is a 404, not a 200 describing an empty tree', ghost.status, 404);
  eq('...with a named reason', ghost.body.reason, 'project_not_found');

  // ── DELETE, AND THE TYPED CONFIRMATION ─────────────────────────────────
  const wrong = await call('delete', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina-ai' }, body: { confirm: 'lumina' } });
  eq('a delete with the wrong confirmation is refused', wrong.status, 400);
  ok('...and the project is still on disk', existsSync(join(st, 'lumina-ai')));

  const gone = await call('delete', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina-ai' }, body: { confirm: 'lumina-ai' } });
  eq('a correctly-confirmed delete answers 200', gone.status, 200);
  ok('...and the directory is really gone', !existsSync(join(st, 'lumina-ai')));
  ok('...while the domain own project is untouched', existsSync(join(st, 'project.md')));

  const deleteDefault = await call('delete', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'alpha' }, body: { confirm: 'alpha' } });
  eq('the domain OWN project cannot be deleted either', deleteDefault.status, 400);
  eq('...with the store own named reason', deleteDefault.body.reason, 'default-project');
  ok('...and its state root survives', existsSync(join(st, 'project.md')));

  // ── THE MIRROR, AND THE RESERVED LITERAL ───────────────────────────────
  const mirror = await call('post', '/:domain/projects',
    { params: { domain: 'shared-cohort' }, body: { project: 'x' } });
  eq('a read-only Shared Brain mirror refuses a create', mirror.status, 403);
  ok('...and wrote nothing into it', !existsSync(join(DOMAINS, 'shared-cohort', 'state')));

  const reserved = await call('post', '/:domain/projects',
    { params: { domain: 'alpha' }, body: { project: 'projects' } });
  eq('the one literal that would shadow its own detail URL is refused', reserved.status, 400);
  eq('...at the ROUTE, with its own reason', reserved.body.reason, 'reserved_project');
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
  // ...but it DOES carry the provenance, which is not the same field and must
  // not be dropped with it: the seeded brief the store writes is the human's.
  eq('...while still stamping the seeded brief as a HUMAN one',
    opts.authoredBy.kind, 'human');
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
  const save = stub.__calls.find((c) => c.name === 'saveProjectBriefText');
  eq('the store is given the WHOLE text, because a brief write replaces',
    save.args[2], '## Standing brief\n\nreplaced');
  // THE PROVENANCE. The store's brief-authority reading decides whether a
  // brief carries the OWNER's standing instructions; an app edit is a HUMAN
  // edit and must never arrive wearing an agent's provenance line.
  eq('...and stamped as a HUMAN edit', save.args[3].authoredBy.kind, 'human');
  // AND THE SHRINK GUARD IS WAIVED, on purpose and only here. See the route's
  // saveBrief docblock: the app's editor is seeded with the current text, so a
  // shrink is deliberate and visible, and the guard's own advice ("repeat the
  // call with replace: true") is advice a browser cannot take. §2 pins the
  // behaviour end to end, including the empty-brief refusal that survives it.
  eq('...with the shrink guard waived, which only an EDITOR may do',
    save.args[3].replace, true);
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
  const order = stub.__calls.map((c) => c.name).filter((n) => n === 'renameProject' || n === 'saveProjectBriefText');
  eq('the rename ran BEFORE the brief write', JSON.stringify(order), '["renameProject","saveProjectBriefText"]');
  eq('...and the brief was written to the NEW name',
    stub.__calls.find((c) => c.name === 'saveProjectBriefText').args[1], 'renamed');
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
  eq('...and NOTHING was written', stub.__calls.filter((c) => c.name === 'saveProjectBriefText').length, 0);
}
{
  const stub = install();
  const exact = 'x'.repeat(realStore.MAX_BRIEF_BYTES);
  const r = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { brief: exact } });
  eq('a brief EXACTLY at the cap is accepted -- the boundary is not off by one', r.status, 200);
  eq('...and really written', stub.__calls.filter((c) => c.name === 'saveProjectBriefText').length, 1);
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
  eq('...and nothing was written', stub.__calls.filter((c) => c.name === 'saveProjectBriefText').length, 0);
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
  // THE PROJECT RIDES ON THE OPTIONS OBJECT. Written positionally the store
  // reads `opts.project` off a string, gets undefined, and answers about the
  // domain's own project -- silently, with every other assertion here green.
  // §2 proves the consequence against real files; this pins the CALL.
  const read = stub.__calls.find((c) => c.name === 'readWorkingState');
  eq('the store was given the domain first', read.args[0], 'alpha');
  eq('...and the project on the OPTIONS object, never positionally',
    read.args[1].project, 'lumina');
  eq('...with exactly two arguments', read.args.length, 2);
}
{
  const stub = install();
  const r = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'lumina' }, query: { scope: 'latest' } });
  eq('`latest` answers 200', r.status, 200);
  eq('...resolved to the NEWEST-written work-stream', r.body.scope, 'newest');
  // THE KEYWORD IS THE STORE'S, AND IT IS HANDED STRAIGHT THROUGH. This route
  // used to resolve `latest` itself before calling the store -- a second copy
  // of a rule the store already owns, and one that DISAGREED with it: the
  // store resolves an ACTUAL work-stream named `latest` in preference to the
  // keyword (LATEST_SCOPE), while the route's copy always meant "newest".
  eq('...and the store was given the WORD, because the store owns the keyword',
    stub.__calls.find((c) => c.name === 'readWorkingState').args[1].scope, 'latest');
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
  const aliasRead = stub.__calls.find((c) => c.name === 'readWorkingState');
  eq('the store was asked for the default project', aliasRead.args[1].project, 'alpha');
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
