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
 * §S11 is a THIRD arm, added in v3.61.0 for the tier-0 WRITE routes: the real
 * store again, over a real state tree AND a real tempdir folder standing in
 * for a checkout. It is the only arm that can prove a byte-exact round trip
 * through `?raw=1`, a 512 KB wall measured in real bytes, a `skeleton` flag
 * cleared on disk, and a mirror that is a byte copy of its source. The folder
 * it mirrors from has no git in it at all — which is the case the routes'
 * copy calls a "folder" rather than a "repository", a git checkout differing
 * only in that it also records a commit.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · The route table is exactly the declared (method, path) pairs in the
 *    declared ORDER, and order is a correctness property twice over:
 *    `/:domain/projects` is registered BEFORE `/:domain/:project` (a domain
 *    slug and a project slug are drawn from the same alphabet), and
 *    `/repo-scan` before the one-segment deprecated alias (or a scan would
 *    answer as a 404 about a domain called `repo-scan`).
 *  · The four-segment foundations routes REACH the domain's own project — the
 *    one whose slug IS the domain name, whose foundations live at
 *    `state/foundations/` with no `<project>` segment — driven as real
 *    writes, not as refusals, plus a route-table proof that a two-segment
 *    literal cannot shadow a four-segment path (§S11h).
 *  · Tier 0's three write routes: ownership set ONCE and refused after,
 *    curator-owned only, the human's stamp, the waived shrink guard, the
 *    512 KB wall with both numbers, the typed delete confirmation, the
 *    orphan, and every `files` refusal forwarded.
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
 *  · EXPRESS'S OWN DISPATCH. Handlers are pulled off the router and called
 *    directly, so the ORDER assertions are about the registration array, not
 *    about what Express would match for a given URL. That is the same thing
 *    for a router whose matching is by segment count and registration order,
 *    and it is not the same thing as driving `/api/memory/repo-scan` through
 *    a live server — which no arm here does.
 *  · The store's own tier-0 guarantees — the cross-process `.write-lock`, the
 *    manifest-written-LAST ordering, the atomic document write — belong to
 *    scripts/test-foundations*.js. §S11 checks the store's OUTPUT (bytes on
 *    disk, shas, flags read back) because that is what the router's
 *    correctness depends on. `409 locked` is therefore NOT driven here: the
 *    lock is the store's and provoking a real one needs a second process.
 *  · `statusForStoreRefusal`'s explicit 400 arms for the tier-0 refusals are
 *    NOT guarded, and cannot be: the function's default is already 400, so
 *    removing them changes no observable answer. They are named in source as
 *    a decision rather than left to a coincidence, and that is all they are.
 *    The arms that ARE observable — `not-found` → 404 and `repo-unreachable`
 *    → 409 — are driven above.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, realpathSync, symlinkSync , statSync } from 'node:fs';
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
const { SKELETON_BANNER } = await import('../src/brain/foundation-skeletons.js');

function routesOf(r) {
  return (r.stack || [])
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods || {})
      .filter((m) => l.route.methods[m])
      .map((m) => ({ method: m, path: l.route.path, handle: l.route.stack[l.route.stack.length - 1].handle })));
}
const ROUTES = routesOf(router);

function findRoute(method, path) {
  return ROUTES.find((x) => x.method === method && x.path === path) || null;
}

/**
 * A FIELD THAT MAY BE NULL, read without crashing the suite.
 *
 * Load-bearing, not tidiness: a mutation that makes `body.foundations` null
 * must REDDEN an assertion, and `null.skeletonCount` throws instead — a crash
 * is not a red, and the harness cannot tell one from a legitimate failure.
 * Four mutations in this file's own mutation run crashed before this existed.
 */
function obj(v) { return v && typeof v === 'object' ? v : {}; }

async function call(method, path, { params = {}, query = {}, body } = {}) {
  const route = findRoute(method, path);
  // A ROUTE THAT IS NOT REGISTERED IS A FAILURE, NOT A CRASH. The route-table
  // pin in §S1 is the guard that names it; every drive of the missing route
  // then fails its own assertion too, instead of aborting the file and taking
  // the remaining three hundred assertions with it.
  if (!route) return { status: 0, body: { ok: false, error: 'ROUTE NOT REGISTERED: ' + method + ' ' + path } };
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
    // WHERE THE REAL STORE TAKES THESE FROM, modelled rather than invented.
    // `listProjects` reads its headline, harness, model, save kind and newest
    // scope off the FIRST pair of `listWorkingScopes` — the MTIME-newest one
    // — and that is the whole subject of the agent-clock fixture below. A
    // seed that declares `wsPairs` gets exactly that behaviour; one that does
    // not keeps the flat placeholders the rest of this suite was written
    // against, so nothing else in the file moves.
    const first = Array.isArray(p.wsPairs) && p.wsPairs.length ? p.wsPairs[0] : null;
    const pick = (k, fallback) => (first ? (first[k] ?? null) : fallback);
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
      lastWriteAt: pick('lastWriteAt', newest ? newest.lastWriteAt : null),
      ageSeconds: pick('ageSeconds', newest ? 10 : null),
      writtenAt: pick('writtenAt', newest ? newest.lastWriteAt : null),
      writtenAgeSeconds: pick('writtenAgeSeconds', newest ? 10 : null),
      headline: pick('headline', newest ? 'a headline' : null),
      harness: pick('harness', newest ? 'claude-code' : null),
      model: pick('model', null),
      lastSaveKind: pick('lastSaveKind', null),
      lastSaveNotes: [],
      newestScope: first ? first.scope : (newest ? newest.scope : null),
      newestMachine: first ? first.machine : (newest ? newest.machine : null),
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
    // WHAT `withScopeFacts` PAYS FOR — the per-pair list, in the STORE'S OWN
    // ORDER (mtime, newest first). Opt-in through `wsPairs`: a seed that does
    // not declare it answers with no pairs, which is byte-identical to what
    // every assertion above already saw, because this method did not exist
    // and the route's own try/catch turned the TypeError into an empty list.
    async listWorkingScopes(domain, opts) {
      record('listWorkingScopes', [domain, opts]);
      const project = opts && opts.project ? opts.project : domain;
      const p = (data[domain] || {})[project];
      const pairs = (p && Array.isArray(p.wsPairs)) ? p.wsPairs : [];
      return {
        ok: true, project, domain, scopes: pairs, total: pairs.length,
        distinctScopeCount: new Set(pairs.map((s) => s.scope)).size,
        truncated: false, unlistedEntries: 0, unlistedReason: null,
      };
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
    // ── TIER 0 (v3.59.0) ────────────────────────────────────────────────
    // The three store functions the router calls for foundations, modelled on
    // the contract rather than invented: `listFoundations` answers an INDEX
    // with no bodies, `readFoundation` the bytes, `refreshFoundationsFromRepo`
    // a copy report. Each is opt-in through `fnd` on the seed, so every project
    // in the rest of this file keeps answering exactly what it answered before
    // this tier existed — which is what an ABSENT payload looks like on a real
    // store too.
    async listFoundations(domain, project) {
      record('listFoundations', [domain, project]);
      const p = (data[domain] || {})[project];
      const f = p && p.fnd;
      if (!f) return { present: false, documents: [] };
      if (f.refuse) return { ok: false, reason: f.refuse, message: 'store said no' };
      return {
        present: true,
        ownership: f.ownership || 'repo',
        repo: f.repo === undefined ? { root: '/repo' } : f.repo,
        budgetBytes: 200000,
        totalBytes: (f.documents || []).reduce((a, d) => a + (d.bytes || 0), 0),
        documents: f.documents || [],
        orphanFiles: f.orphanFiles || [],
        manifestError: f.manifestError || null,
        // A FIELD THE ROUTER HAS NEVER HEARD OF, for the allow-list assertion
        // — the same hook `extraRowFields` is on the project row, and for the
        // same reason: without it a `...out` spread would survive its mutation.
        ...(f.extraFields || {}),
      };
    },
    async readFoundation(domain, project, slug, opts) {
      record('readFoundation', [domain, project, slug, opts]);
      const p = (data[domain] || {})[project];
      const f = p && p.fnd;
      const doc = f && (f.documents || []).find((d) => d.slug === slug);
      if (!doc) return { ok: false, reason: 'foundation_not_found', message: 'no such document' };
      return { ok: true, ...doc, text: f.bodies ? (f.bodies[slug] || '') : '' };
    },
    async refreshFoundationsFromRepo(domain, project, repoRoot, opts) {
      record('refreshFoundationsFromRepo', [domain, project, repoRoot, opts]);
      const p = (data[domain] || {})[project];
      const f = p && p.fnd;
      if (f && f.refreshRefusal) return { ok: false, ...f.refreshRefusal };
      return {
        ok: true, refreshed: ['architecture.md'], unchanged: [], added: [], missing: [], commit: 'abc1234',
        // v3.61.0. Every `files` entry the mirror would not take, with its
        // reason. Modelled so the route's forwarding can be driven without a
        // real checkout; §S11 drives the real one.
        refused: (opts && Array.isArray(opts.files) ? opts.files : [])
          .filter((x) => x && typeof x.path === 'string' && x.path.startsWith('bad/'))
          .map((x) => ({ path: x.path, reason: 'modelled refusal' })),
      };
    },
    // ── TIER 0 WRITES (v3.61.0) ──────────────────────────────────────────
    // Present on the stub so the ROUTE-level guards can be proved to refuse
    // BEFORE the store is reached — the one thing a real store cannot show.
    // Their real behaviour is driven against the real store in §S11.
    async initFoundations(domain, project, opts) {
      record('initFoundations', [domain, project, opts]);
      return { ok: true, domain, project, ownership: opts && opts.ownership, seeded: [], documents: [], refresh: null };
    },
    async saveFoundation(domain, project, input) {
      record('saveFoundation', [domain, project, input]);
      return { ok: true, domain, project, slug: input && input.slug, bytes: 1, totalBytes: 1, budgetBytes: 200000 };
    },
    async removeFoundation(domain, project, slug) {
      record('removeFoundation', [domain, project, slug]);
      return { ok: true, domain, project, slug, removed: true, wasOrphan: false };
    },
    async scanRepoForFoundations(root) {
      record('scanRepoForFoundations', [root]);
      return { ok: true, root, candidates: [], truncated: false, cap: 200, maxDepth: 4, maxDocumentBytes: 512 * 1024 };
    },
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
  // v3.61.0. ONE SEGMENT, which is exactly what the deprecated `/:project`
  // alias matches — so this row's position is CORRECTNESS: registered after
  // the alias it would never be reached, and a repository scan would answer
  // as a 404 about a domain called `repo-scan`.
  ['get', '/repo-scan'],
  ['get', '/:domain/projects'],
  ['post', '/:domain/projects'],
  ['patch', '/:domain/projects/:project'],
  ['delete', '/:domain/projects/:project'],
  // TIER 0 (v3.59.0; the write rows v3.61.0). Four segments, so none can
  // shadow — or be shadowed by — the two-segment reads below; the ordering
  // WITHIN this group is readability, not correctness, and no `:slug` row
  // shares a method with `init`/`refresh` anyway (and FOUNDATION_SLUG_RE
  // requires `.md`, so neither literal could pass as a slug). What IS
  // load-bearing is that all of them still precede the one-segment alias.
  ['get', '/:domain/:project/foundations/:slug'],
  ['put', '/:domain/:project/foundations/:slug'],
  ['delete', '/:domain/:project/foundations/:slug'],
  ['post', '/:domain/:project/foundations/init'],
  ['post', '/:domain/:project/foundations/refresh'],
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
// v3.61.0: the OTHER end of the repo-scan hole. Registration order keeps the
// scan reachable; this keeps the app from ever minting a project whose own
// detail URL on the alias is unreachable.
ok('...and `repo-scan`, the new one-segment literal',
  routerMod.RESERVED_PROJECT_NAMES.has('repo-scan'));
{
  const gets = ROUTES.filter((r) => r.method === 'get').map((r) => r.path);
  ok('GET /repo-scan precedes the one-segment alias, or a scan would 404',
    gets.indexOf('/repo-scan') < gets.indexOf('/:project')
    && gets.indexOf('/repo-scan') !== -1, JSON.stringify(gets));
}
// THE STORE DOES NOT RESERVE IT, and this suite says so out loud rather than
// leaving the next reader to assume symmetry with `foundations`: `repo-scan`
// collides with a ROUTE literal, not with a file or directory the store
// addresses, so `projectPrefix` accepts it and a directory of that name made
// out of band stays listed and readable. The contract asked for both sets;
// only the router's is a real collision, and this is the assertion that keeps
// the claim honest in either direction.
eq('the STORE still accepts `repo-scan` as a path segment (route-only collision)',
  realStore.projectPrefix('alpha', 'repo-scan'), 'repo-scan/');

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

// ─────────────────────────────────────────────────────────────────────────
// ONE PROJECT, ONE CLOCK — the row speaks for the AGENT-newest pair.
// ─────────────────────────────────────────────────────────────────────────
//
// The store sorts pairs by mtime and `listProjects` reads its headline off
// the first of them. Every age the page renders comes from `effectiveSave`,
// which prefers the journal's `writtenAt`. On a synced or copied store the
// two disagree — git rewrites mtime on checkout — and the sidebar row then
// names a fortnight-old work-stream beside a Status block reporting a save
// three hours ago on a different scope. Both readings were of one project,
// from one fetch.
//
// The store's mtime sort is NOT the thing under test and is NOT changed:
// `scope=latest` and the tray consume it. The fixture returns pairs in that
// order and asserts the ROUTE re-picks.
{
  const stub = install({
    alpha: {
      // mtime order (the store's own), agent order REVERSED against it.
      reversed: {
        brief: null,
        scopes: [
          { scope: 'file-newest', machine: 'm1', lastWriteAt: '2026-09-17T00:00:00.000Z' },
          { scope: 'agent-newest', machine: 'm2', lastWriteAt: '2026-09-16T00:00:00.000Z' },
          { scope: 'no-journal', machine: 'm3', lastWriteAt: '2026-09-15T00:00:00.000Z' },
        ],
        wsPairs: [
          // Newest FILE clock, oldest AGENT clock: a fortnight-old handoff
          // that a checkout stamped with today's mtime.
          {
            scope: 'file-newest', machine: 'm1',
            lastWriteAt: '2026-09-17T00:00:00.000Z', ageSeconds: 3600,
            writtenAt: '2026-09-03T00:00:00.000Z', writtenAgeSeconds: 1209600,
            headline: 'a fortnight-old handoff that git restamped',
            harness: 'opencode', model: 'glm', lastSaveKind: 'full',
          },
          // The real newest save, three hours old, and second by mtime.
          {
            scope: 'agent-newest', machine: 'm2',
            lastWriteAt: '2026-09-16T00:00:00.000Z', ageSeconds: 90000,
            writtenAt: '2026-09-16T21:00:00.000Z', writtenAgeSeconds: 10800,
            headline: 'the save this project actually made',
            harness: 'claude-code', model: 'opus', lastSaveKind: 'full',
          },
          // No journal time at all. An ABSENCE, never an age of zero: it must
          // not displace a pair that has a reading.
          {
            scope: 'no-journal', machine: 'm3',
            lastWriteAt: '2026-09-15T00:00:00.000Z', ageSeconds: 180000,
            writtenAt: null, writtenAgeSeconds: null,
            headline: null, harness: null, model: null, lastSaveKind: null,
          },
        ],
      },
    },
  });
  // PRECONDITION. Without it the assertions below could pass over a store
  // that already answered with the agent-newest pair, proving nothing.
  const raw = await stub.listProjects('alpha');
  eq('PRECONDITION: the STORE row names the file-newest pair',
    raw.projects[0].newestScope, 'file-newest');
  eq('PRECONDITION: ...and carries that pair headline',
    raw.projects[0].headline, 'a fortnight-old handoff that git restamped');

  const r = await call('get', '/:domain/projects', { params: { domain: 'alpha' } });
  const p = r.body.projects.find((x) => x.project === 'reversed');
  eq('the row names the AGENT-newest work-stream', p.newestScope, 'agent-newest');
  eq('...and its machine', p.newestMachine, 'm2');
  eq('...and its headline', p.headline, 'the save this project actually made');
  eq('...and its harness', p.harness, 'claude-code');
  eq('...and its model', p.model, 'opus');
  eq('...and its agent stamp', p.writtenAt, '2026-09-16T21:00:00.000Z');
  eq('...and its agent age', p.writtenAgeSeconds, 10800);
  // THE FILE CLOCK IS LEFT ALONE. It is disclosed as the file's, and a
  // consumer asking when bytes last landed on this disk has nowhere else to
  // read it. Two clocks, two fields, neither pretending to be the other.
  eq('the FILE clock still reports the file-newest write',
    p.lastWriteAt, '2026-09-17T00:00:00.000Z');
  eq('...and its age', p.ageSeconds, 3600);
  // The index route folds the same facts, so it must make the same pick.
  const all = await call('get', '/');
  const pi = all.body.projects.find((x) => x.domain === 'alpha' && x.project === 'reversed');
  eq('GET /api/memory makes the same pick', pi.newestScope, 'agent-newest');
}
{
  // THE FALLBACK IS LOAD-BEARING. A pair whose journal recorded no time still
  // has a file time, and it can legitimately beat a pair whose agent clock is
  // a fortnight old — which is exactly what the Work-streams table does with
  // it. Drop the fallback and this pair becomes unselectable, handing the row
  // back to the stale save.
  install({
    alpha: {
      mixed: {
        brief: null,
        scopes: [{ scope: 'stale-agent', machine: 'm1', lastWriteAt: '2026-09-17T00:00:00.000Z' }],
        wsPairs: [
          {
            scope: 'stale-agent', machine: 'm1',
            lastWriteAt: '2026-09-17T00:00:00.000Z', ageSeconds: 100,
            writtenAt: '2026-08-01T00:00:00.000Z', writtenAgeSeconds: 1000000,
            headline: 'saved in August', harness: 'opencode', model: 'glm', lastSaveKind: 'full',
          },
          {
            scope: 'fresh-file-no-journal', machine: 'm2',
            lastWriteAt: '2026-09-16T22:00:00.000Z', ageSeconds: 5000,
            writtenAt: null, writtenAgeSeconds: null,
            headline: 'no journal time, but written an hour ago', harness: null,
            model: null, lastSaveKind: null,
          },
        ],
      },
    },
  });
  const r = await call('get', '/:domain/projects', { params: { domain: 'alpha' } });
  const p = r.body.projects.find((x) => x.project === 'mixed');
  eq('a pair with no agent clock still wins on its FILE clock',
    p.newestScope, 'fresh-file-no-journal');
  eq('...and says so by reporting no agent stamp', p.writtenAt, null);
  eq('...with the age absent rather than zero', p.writtenAgeSeconds, null);
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

// =========================================================================
section('S10 -- TIER 0: the foundations index, one document, and the refresh');
// =========================================================================
//
// Three routes and one refusal, driven against the stub store. The property
// under test is the TIER BOUNDARY as it applies to tier 0, which splits on
// OWNERSHIP rather than on tier:
//
//   * a CURATOR-owned document is the commissioned agent's and the app cannot
//     touch it -- there is no route, and the refresh refuses with a reason;
//   * a REPO-owned document is a MIRROR, and a refresh is a deterministic byte
//     copy of a file the repository already authors, which is why that one
//     write route exists at all.

const FND_DOC = {
  slug: 'architecture.md', role: 'architecture', title: 'Architecture',
  bytes: 1200, sha256: 'a'.repeat(64), updatedAt: '2026-09-17T09:00:00.000Z',
  commit: '9623343', source: { kind: 'repo', path: 'docs/architecture.md' },
  authoredBy: { kind: 'human' }, freshness: 'fresh',
};
const FND_SEED = {
  alpha: {
    lumina: {
      brief: '## Standing brief\n\nx',
      scopes: [{ scope: 'main', machine: 'm1', lastWriteAt: '2026-09-06T12:00:00.000Z' }],
      fnd: {
        ownership: 'repo',
        documents: [FND_DOC, { ...FND_DOC, slug: 'decisions.md', title: 'Decisions',
          role: 'decisions', freshness: 'stale' }],
        bodies: { 'architecture.md': '# Architecture\n\nThe body.' },
        orphanFiles: ['stray.md'],
        extraFields: { somethingNew: 'from a newer store' },
      },
    },
    alpha: { brief: null, scopes: [] },
    curated: {
      brief: null, scopes: [],
      fnd: { ownership: 'curator', repo: null,
        documents: [{ ...FND_DOC, slug: 'decisions.md', source: { kind: 'curator' },
          commit: null, freshness: 'n/a' },
        // v3.61.0. An unfilled SKELETON: prompts, not facts. The flag is
        // what tells a reader which it is, so it has to cross the wire.
        { ...FND_DOC, slug: 'roadmap.md', role: 'roadmap', title: 'Roadmap',
          source: { kind: 'curator' }, commit: null, freshness: 'n/a', skeleton: true }] },
    },
    faraway: {
      brief: null, scopes: [],
      fnd: { ownership: 'repo', repo: null,
        documents: [{ ...FND_DOC, freshness: 'unreachable' }],
        refreshRefusal: { reason: 'repo_unreachable', message: 'not on this machine' } },
    },
    broken: { brief: null, scopes: [], fnd: { ownership: 'repo', documents: [], manifestError: 'Unexpected token }' } },
  },
  blank: { blank: { brief: null, scopes: [] } },
  'shared-cohort': { 'shared-cohort': { brief: null, scopes: [] } },
};

// ── S10a -- the INDEX rides on the detail envelope, bodies and all left out ──
{
  install(FND_SEED);
  const res = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'lumina' } });
  eq('the detail read still answers 200', res.status, 200);
  const f = obj(res.body.foundations);
  ok('the envelope carries a `foundations` object', !!f && typeof f === 'object', JSON.stringify(Object.keys(res.body)));
  eq('...listing every document', (f.documents || []).length, 2);
  ok('NO BODY crosses on this route -- it is fetched on every project switch, '
    + 'and 200 KB of document text on a read whose job is "what is here" would '
    + 'make the cheapest screen in the app the most expensive',
  (f.documents || []).every((d) => !('text' in d)), JSON.stringify(f.documents[0]));
  eq('the freshness the store COMPUTED is forwarded verbatim', f.documents[0].freshness, 'fresh');
  eq('...including the one that is a mismatch rather than an absence',
    f.documents[1].freshness, 'stale');
  eq('the ownership mode crosses, because it decides what may write',
    f.ownership, 'repo');
  eq('the orphan-file disclosure crosses -- it is the only thing that says a '
    + 'save was interrupted', (f.orphanFiles || []).join(','), 'stray.md');
  eq('...and so does the manifest error field, as an explicit null when there is none',
    f.manifestError, null);
  // AN ALLOW-LIST, NOT A SPREAD -- the same rule `projectRow` records: a spread
  // forwards whatever the store grows next, including anything a synced
  // manifest.json put there.
  ok('a field the router has never heard of does NOT cross',
    !('somethingNew' in f), JSON.stringify(Object.keys(f)));

  // ── THE TWO NEW FIELDS (v3.61.0), AND THE NEGATIVE ANSWER ─────────────
  // `skeleton` is ALWAYS present rather than omitted when false: a block
  // reading "N skeletons to fill" needs a positive AND a negative answer
  // from every row, not an absence to interpret.
  eq('every document row carries `skeleton`, including as false',
    (f.documents || []).filter((d) => 'skeleton' in d).length, 2);
  eq('...and this repo-owned pair has none', f.skeletonCount, 0);
  {
    const cur = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'curated' } });
    const cf = obj(cur.body.foundations);
    eq('a curator-owned project counts its unfilled skeletons', cf.skeletonCount, 1);
    eq('...naming which row it is', obj((cf.documents || []).find((d) => d.skeleton)).slug, 'roadmap.md');
    eq('...and the filled one reads false, not absent',
      obj((cf.documents || []).find((d) => d.slug === 'decisions.md')).skeleton, false);
    // DERIVED FROM THE ROWS, not taken from the store's own tally: a store
    // that answered `skeletonCount: 99` beside one skeleton row would make
    // the summary line and the table disagree, which is the class of defect
    // this file's neighbours keep re-learning.
    const drifted = makeStubStore(FND_SEED);
    const inner = drifted.listFoundations;
    drifted.listFoundations = async (d, p) => ({ ...(await inner(d, p)), skeletonCount: 99 });
    routerMod.__setWorkingStateStoreForTest(drifted);
    const r2 = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'curated' } });
    eq('a store tally that disagrees with the rows does NOT cross the wire',
      obj(obj(r2.body).foundations).skeletonCount, 1);
    install(FND_SEED);
  }

  // A PROJECT WITH NO FOUNDATIONS says so as a FACT rather than by omitting the
  // key: a missing key is what an older server answers, and the view's fallback
  // depends on telling the two apart.
  const none = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'alpha' } });
  ok('a project with no foundations still carries the key', 'foundations' in none.body);
  eq('...reporting present: false', none.body.foundations.present, false);
  eq('...with an empty list rather than a missing one', none.body.foundations.documents.length, 0);

  // A MANIFEST THAT WILL NOT PARSE MUST NOT COST THE READ. The foundations
  // index is a PASSENGER: a project whose manifest is unreadable still has a
  // brief, work-streams and a handoff, and all three must still paint.
  const bad = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'broken' } });
  eq('a malformed manifest still answers 200', bad.status, 200);
  ok('...and discloses the error rather than swallowing it',
    /Unexpected token/.test(String(bad.body.foundations.manifestError)), JSON.stringify(bad.body.foundations));

  // ...AND SO MUST A STORE THAT THROWS. Same rule, harder case: the index is a
  // passenger on a read that answers about the brief, the work-streams and the
  // handoff, so an exception reading a manifest must become a disclosed
  // `manifestError` and not a 500 over a screen that is otherwise correct.
  {
    const thrower = makeStubStore(FND_SEED);
    thrower.listFoundations = async () => { throw new Error('EACCES: permission denied'); };
    routerMod.__setWorkingStateStoreForTest(thrower);
    const r = await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'lumina' } });
    eq('a THROWING store still answers 200 — the other three tiers are correct '
      + 'and must still paint', r.status, 200);
    ok('...with the exception disclosed rather than swallowed',
      /EACCES/.test(String(r.body.foundations.manifestError)), JSON.stringify(r.body.foundations));
    ok('...and the rest of the envelope intact', r.body.brief && r.body.brief.present === true);
    install(FND_SEED);
  }
}

// ── S10b -- `open` keeps its byte-identity claim ────────────────────────
//
// `?open=newest` promises that `open` is byte-for-byte what the equivalent
// `?scope=&machine=` request answers. Tier 0 is a property of the PROJECT, so
// the naive reading would put it on the outer envelope only -- and that would
// break the promise the moment a client compared the two. The same object is
// therefore attached to both.
{
  install(FND_SEED);
  const opened = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'lumina' }, query: { open: 'newest' } });
  const direct = await call('get', '/:domain/:project',
    { params: { domain: 'alpha', project: 'lumina' }, query: { scope: 'main', machine: 'm1' } });
  ok('the opened pair carries the foundations index too', !!(opened.body.open && opened.body.open.foundations));
  eq('...and it is the same answer the second request gives, field for field',
    JSON.stringify(opened.body.open.foundations), JSON.stringify(direct.body.foundations));
  // ANTI-VACUITY: the comparison is over a real index, not two empty objects.
  ok('CONTROL: the compared index is a real one',
    direct.body.foundations.documents.length === 2);
}

// ── S10c -- one document, verbatim ──────────────────────────────────────
{
  install(FND_SEED);
  const res = await call('get', '/:domain/:project/foundations/:slug',
    { params: { domain: 'alpha', project: 'lumina', slug: 'architecture.md' } });
  eq('a stored document answers 200', res.status, 200);
  eq('...with the bytes as stored', res.body.text, '# Architecture\n\nThe body.');
  eq('...and the provenance that qualifies them', res.body.source.path, 'docs/architecture.md');
  eq('...and the commit it came from', res.body.commit, '9623343');
  eq('...and the pair it belongs to, so a client need not re-derive it', res.body.project, 'lumina');

  const missing = await call('get', '/:domain/:project/foundations/:slug',
    { params: { domain: 'alpha', project: 'lumina', slug: 'nope.md' } });
  eq('a document that is not there is a 404 -- never a 200 describing an empty '
    + 'one, which is how a typo renders as a working, blank page', missing.status, 404);
  eq('...naming the document it could not find, as a FIELD rather than only in prose',
    missing.body.slug, 'nope.md');
  ok('...and forwarding the STORE\'s own sentence rather than restating it -- the '
    + 'rule `withErrorProse` records: a caller matching on the string the store '
    + 'gave it must go on matching',
  String(missing.body.error) === 'no such document', JSON.stringify(missing.body));
  // ...and when the store gives no prose at all, the route supplies a sentence
  // that NAMES the document, rather than leaving the user a status code. Driven
  // against a store whose refusal carries a reason and nothing else.
  {
    const silent = makeStubStore(FND_SEED);
    silent.readFoundation = async () => ({ ok: false, reason: 'foundation_not_found' });
    routerMod.__setWorkingStateStoreForTest(silent);
    const r = await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'alpha', project: 'lumina', slug: 'nope.md' } });
    eq('a prose-less store refusal is still a 404', r.status, 404);
    ok('...and the route\'s own fallback sentence names the document',
      /nope\.md/.test(String(r.body.error)), JSON.stringify(r.body));
    install(FND_SEED);
  }

  // THE SLUG IS VALIDATED AT THE BOUNDARY, with the store's own rule, and
  // nothing that fails it reaches a path builder.
  for (const evil of ['../../etc/passwd', '..', 'a/b.md', '', 'NOPE.MD', 'no-extension',
    'x'.repeat(80) + '.md', '-leading.md', 'sp ace.md']) {
    const r = await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'alpha', project: 'lumina', slug: evil } });
    eq('"' + evil.slice(0, 24) + '" is refused as a document name (400)', r.status, 400);
    eq('...with the reason named', r.body.reason, 'invalid_slug');
  }
  // CONTROL: the validator is not refusing everything.
  eq('CONTROL: a legal slug is NOT refused as invalid',
    (await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'alpha', project: 'lumina', slug: 'a1-b2.md' } })).body.reason,
    'foundation_not_found');
  // ...and the project name is checked too, on the same route.
  eq('an unusable PROJECT name is refused before anything is read',
    (await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'alpha', project: '../x', slug: 'a.md' } })).status, 400);
  eq('an unknown DOMAIN is a 404, as on every other read',
    (await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'nosuch', project: 'lumina', slug: 'a.md' } })).status, 404);
}

// ── S10d -- the refresh: what it copies, and the two refusals ───────────
{
  install(FND_SEED);
  const ok200 = await call('post', '/:domain/:project/foundations/refresh',
    { params: { domain: 'alpha', project: 'lumina' }, body: {} });
  eq('a repo-owned project may be refreshed', ok200.status, 200);
  eq('...and is told what was copied', (ok200.body.refreshed || []).join(','), 'architecture.md');
  eq('...and what was NOT deleted, only lost from the repository',
    Array.isArray(ok200.body.missing), true);
  eq('the repository root it used is named back, so a wrong one is visible',
    ok200.body.repoRoot, '/repo');

  // THE MANIFEST'S ROOT IS THE DEFAULT, and a caller may name another.
  const asked = await call('post', '/:domain/:project/foundations/refresh',
    { params: { domain: 'alpha', project: 'lumina' }, body: { repoRoot: '/elsewhere' } });
  eq('an explicitly named root wins over the manifest\'s hint', asked.body.repoRoot, '/elsewhere');

  // CURATOR-OWNED: a 400, and it is a STATEMENT about the documents rather than
  // an error condition -- there is no upstream file to copy from.
  const curated = await call('post', '/:domain/:project/foundations/refresh',
    { params: { domain: 'alpha', project: 'curated' }, body: {} });
  eq('a curator-owned project is refused with 400', curated.status, 400);
  eq('...under a reason a client can match on', curated.body.reason, 'curator_owned');
  ok('...and a sentence a person can act on', /written for this project/.test(String(curated.body.error)),
    JSON.stringify(curated.body));

  // UNREACHABLE: a 409. Nothing is malformed and nothing is broken -- the
  // server's own state is simply not one the request can act on.
  const far = await call('post', '/:domain/:project/foundations/refresh',
    { params: { domain: 'alpha', project: 'faraway' }, body: {} });
  eq('a project with no repository path on this computer is a 409', far.status, 409);
  eq('...under its own reason', far.body.reason, 'repo_unreachable');
  ok('...and says what to do about it', /pass the path|checkout|repo_root/i.test(String(far.body.error)),
    JSON.stringify(far.body));
  // ...and the STORE's own unreachable refusal maps to the same status, so the
  // two paths to that answer cannot disagree.
  {
    const seeded = JSON.parse(JSON.stringify(FND_SEED));
    seeded.alpha.faraway.fnd.repo = { root: '/repo' };
    install(seeded);
    const r = await call('post', '/:domain/:project/foundations/refresh',
      { params: { domain: 'alpha', project: 'faraway' }, body: {} });
    eq('a store-side unreachable is the same 409 as a missing root', r.status, 409);
    install(FND_SEED);
  }

  // A READ-ONLY SHARED MIRROR refuses this exactly as it refuses every other
  // write on this router.
  eq('a shared-* mirror refuses the refresh (403)',
    (await call('post', '/:domain/:project/foundations/refresh',
      { params: { domain: 'shared-cohort', project: 'shared-cohort' }, body: {} })).status, 403);
}

// ── S10e -- `foundations` is a RESERVED project name ────────────────────
//
// It is the directory tier 0 lives in, `<project>/foundations/`. A project of
// that name would sit exactly where the domain's own project's foundations
// directory goes -- that project's tree IS the state root -- so the two would
// be addressed by one path.
{
  install(FND_SEED);
  ok('the router declares it reserved', routerMod.RESERVED_PROJECT_NAMES.has('foundations'));
  const created = await call('post', '/:domain/projects',
    { params: { domain: 'alpha' }, body: { project: 'foundations' } });
  eq('creating a project called `foundations` is refused', created.status, 400);
  eq('...with the same reason shape the other reserved names use',
    created.body.reason, 'reserved_project');
  const renamed = await call('patch', '/:domain/projects/:project',
    { params: { domain: 'alpha', project: 'lumina' }, body: { rename: 'foundations' } });
  eq('and so is renaming to it', renamed.status, 400);
  eq('...under the same reason', renamed.body.reason, 'reserved_project');
  // CONTROL: an ordinary name still goes through, so the guard is not refusing
  // everything.
  eq('CONTROL: an ordinary project name is still accepted',
    (await call('post', '/:domain/projects',
      { params: { domain: 'alpha' }, body: { project: 'ordinary' } })).status, 201);
}

// ── S10f -- every tier-0 READ still writes nothing ──────────────────────
{
  install(FND_SEED);
  const before = fingerprint(DOMAINS);
  await call('get', '/:domain/:project', { params: { domain: 'alpha', project: 'lumina' } });
  await call('get', '/:domain/:project/foundations/:slug',
    { params: { domain: 'alpha', project: 'lumina', slug: 'architecture.md' } });
  await call('get', '/:domain/:project/foundations/:slug',
    { params: { domain: 'alpha', project: 'lumina', slug: '../../etc/passwd' } });
  // ...and so does every REFUSED write.
  await call('post', '/:domain/:project/foundations/refresh',
    { params: { domain: 'alpha', project: 'curated' }, body: {} });
  await call('post', '/:domain/:project/foundations/refresh',
    { params: { domain: 'alpha', project: 'faraway' }, body: {} });
  const after = fingerprint(DOMAINS);
  ok('a recursive sha256 of the whole domains tree is identical afterwards',
    before.hash === after.hash && before.count === after.count, before.hash + ' vs ' + after.hash);
}

// ═════════════════════════════════════════════════════════════════════════
section('S11 -- TIER 0 WRITES, against the REAL store over a real tree (v3.61.0)');
// ═════════════════════════════════════════════════════════════════════════
//
// NO STUB. `initFoundations`, `saveFoundation`, `removeFoundation`,
// `refreshFoundationsFromRepo` and `scanRepoForFoundations` run for real
// against the tempdir domains root and a tempdir FOLDER standing in for a
// checkout. This arm exists for the same reason §2 does: the shapes a stub
// tolerates are not the shapes the store has, and the mismatch is silent.
// It is also the only arm that can prove a byte-exact round trip, a wall
// measured in real bytes, and a `skeleton` flag cleared on disk.
//
// A PLAIN FOLDER IS A VALID SOURCE. `resolveRepoRoot` asks for a reachable
// DIRECTORY and never for `.git`, and `gitHeadCommit` answers null rather
// than failing — so the mirror below runs over a folder with no git in it at
// all, which is the case the messages call a "folder" rather than a
// "repository". A git checkout differs in exactly one way: it records a
// commit beside each document.

routerMod.__setWorkingStateStoreForTest(null);
makeDomain('tier0');

const REPO = join(TMP, 'repo');
{
  mkdirSync(join(REPO, 'docs'), { recursive: true });
  mkdirSync(join(REPO, 'decisions'), { recursive: true });
  mkdirSync(join(REPO, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(REPO, 'docs', 'architecture.md'), '# The Architecture\n\nHow it hangs together.\n');
  writeFileSync(join(REPO, 'docs', 'roadmap.md'), '# Roadmap\n\nNext.\n');
  writeFileSync(join(REPO, 'decisions', '0001-use-markdown.md'), '# 0001 Use markdown\n\nBecause.\n');
  writeFileSync(join(REPO, 'README.md'), '# Readme\n\nHello.\n');
  writeFileSync(join(REPO, 'node_modules', 'junk', 'readme.md'), '# Vendored\n');
  // Over the 512 KB per-document wall: SHOWN with the reason, never hidden.
  writeFileSync(join(REPO, 'docs', 'api-dump.md'), '#'.repeat(600 * 1024));
}

// ── S11a -- GET /repo-scan: read-only, project-free, and its two refusals ──
{
  const bad = [
    ['an empty root', ''],
    ['a relative root', 'code/thing'],
    ['a bare dot', '.'],
  ];
  for (const [label, root] of bad) {
    const r = await call('get', '/repo-scan', { query: { root } });
    eq('repo-scan refuses ' + label + ' with 400', r.status, 400);
    eq('...naming the reason in this router\'s own spelling', r.body.reason, 'invalid_root');
  }
  const gone = await call('get', '/repo-scan', { query: { root: join(TMP, 'not-here-at-all') } });
  eq('an absolute path that is not on this computer is a 409, not a 400 -- nothing '
    + 'is malformed, the folder is simply not here', gone.status, 409);
  eq('...under its own reason', gone.body.reason, 'repo_unreachable');

  // The scan is asked through a SYMLINK to the fixture folder, so that the
  // typed path and the resolved path differ on EVERY platform. The first cut
  // relied on the tempdir itself being a symlink, which is true on macOS
  // (`/var` -> `/private/var`) and false on Linux, where CI reddened the
  // precondition below while the product was right (v3.61.0's own gate).
  const REPO_LINK = join(TMP, 'repo-link');
  symlinkSync(REPO, REPO_LINK);
  const scan = await call('get', '/repo-scan', { query: { root: REPO_LINK } });
  eq('a real folder answers 200', scan.status, 200);
  const paths = (scan.body.candidates || []).map((c) => c.path);
  ok('the docs/ folder is scanned whole', paths.includes('docs/architecture.md') && paths.includes('docs/roadmap.md'),
    JSON.stringify(paths));
  ok('a decision record is found by its FOLDER, not its name',
    paths.includes('decisions/0001-use-markdown.md'), JSON.stringify(paths));
  ok('a root README is found by its NAME', paths.includes('README.md'), JSON.stringify(paths));
  ok('node_modules is not walked', !paths.some((p) => p.startsWith('node_modules/')), JSON.stringify(paths));
  const arch = obj((scan.body.candidates || []).find((c) => c.path === 'docs/architecture.md'));
  eq('...with the role the store suggests', arch.suggestedRole, 'architecture');
  eq('...the slug the MIRROR would derive, so the picker and the store agree',
    arch.suggestedSlug, 'architecture.md');
  eq('...the first heading, so a row can show a title beside a path (D20)',
    arch.firstHeading, 'The Architecture');
  eq('...which rule admitted it (D20)', arch.matchedBy, 'docs-folder');
  eq('...and how big it is', arch.bytes, readFileSync(join(REPO, 'docs', 'architecture.md')).length);
  // ── `modifiedAt` CROSSES THE ROUTE (v3.61.1) ──────────────────────────
  //
  // The picker puts an age on every candidate row, on the app's shared
  // freshness scale, because a list of paths and sizes cannot say whether a
  // document is still maintained. The store reads it off the `stat` it
  // already does; this is the assertion that it reaches a client — the route
  // forwards its candidate fields one by one (never a spread), so a field the
  // store grows is invisible until somebody adds it here, and a field the
  // route drops is invisible everywhere.
  //
  // Compared against the FILE'S OWN mtime, not merely "is a string": a value
  // read from the wrong stat would still parse as a date.
  eq('...and when the source file was last touched, as an ISO string',
    arch.modifiedAt,
    statSync(join(REPO, 'docs', 'architecture.md')).mtime.toISOString());
  ok('...on EVERY row, a string or null and never absent — the field means one thing '
    + 'per row rather than "absent = refused" on some and "absent = unknown" on others',
  (scan.body.candidates || []).every((c) => Object.hasOwn(c, 'modifiedAt')
    && (c.modifiedAt === null || typeof c.modifiedAt === 'string')),
  JSON.stringify((scan.body.candidates || []).map((c) => c.modifiedAt)));
  ok('...including the row over the per-document wall, which is still a real file',
    typeof obj((scan.body.candidates || [])
      .find((c) => c.path === 'docs/api-dump.md')).modifiedAt === 'string',
    JSON.stringify(obj((scan.body.candidates || [])
      .find((c) => c.path === 'docs/api-dump.md')).modifiedAt));
  eq('the decision record says it came from its folder', obj((scan.body.candidates || [])
    .find((c) => c.path === 'decisions/0001-use-markdown.md')).matchedBy, 'doc-folder');
  eq('the README says it came from its name', obj((scan.body.candidates || [])
    .find((c) => c.path === 'README.md')).matchedBy, 'name');
  const huge = obj((scan.body.candidates || []).find((c) => c.path === 'docs/api-dump.md'));
  eq('a file over the wall is LISTED, so the reason is visible', huge.tooLarge, true);
  eq('...and its heading is not read at all', huge.firstHeading, null);
  // THE RESOLVED root, not the text that was typed: a caller mirrors from the
  // folder the scan actually read. Compared against realpath, because on
  // macOS the tempdir itself is a symlink (`/var` → `/private/var`) — which
  // is exactly the case that would make a route echoing its input wrong.
  eq('the resolved root is answered back, never the text that was typed',
    scan.body.root, realpathSync(REPO));
  ok('PRECONDITION: those two really are different strings here, or the '
    + 'assertion above is vacuous', realpathSync(REPO_LINK) !== REPO_LINK, REPO_LINK + ' vs ' + realpathSync(REPO_LINK));
  ok('the cap, the depth and the wall are named rather than left to a view',
    scan.body.cap === 200 && scan.body.maxDepth === 4 && scan.body.maxDocumentBytes === 512 * 1024,
    JSON.stringify({ cap: scan.body.cap, d: scan.body.maxDepth, b: scan.body.maxDocumentBytes }));
  eq('...and a short list is not reported as truncated', scan.body.truncated, false);
  // READ-ONLY, proved rather than asserted: the scan is over a folder that
  // is NOT the domains tree, and the domains tree is unchanged.
  const fpBefore = fingerprint(DOMAINS);
  await call('get', '/repo-scan', { query: { root: REPO } });
  eq('a scan writes nothing into the domains tree', fingerprint(DOMAINS).hash, fpBefore.hash);
}

// ── S11b -- POST …/foundations/init: the ownership setter, and its refusals ──
{
  const st = join(DOMAINS, 'tier0', 'state');
  for (const p of ['curated', 'mirrored', 'ownerless', 'later', 'badmanifest']) {
    const r = await call('post', '/:domain/projects', { params: { domain: 'tier0' }, body: { project: p } });
    eq('PRECONDITION: project "' + p + '" created', r.status, 201);
  }

  // CURATOR: the manifest plus the four skeletons.
  const cur = await call('post', '/:domain/:project/foundations/init',
    { params: { domain: 'tier0', project: 'curated' }, body: { ownership: 'curator' } });
  eq('a curator init answers 201', cur.status, 201);
  eq('...recording the ownership', cur.body.ownership, 'curator');
  eq('...and naming every skeleton it wrote', (obj(cur.body).seeded||[]).join(','),
    'architecture.md,decisions.md,conventions.md,roadmap.md');
  eq('...with no mirror step at all', obj(cur.body).refresh, null);
  eq('the wire index counts them as unfilled', obj(obj(cur.body).foundations).skeletonCount, 4);
  ok('...and every row says so', (obj(obj(cur.body).foundations).documents||[]).every((d) => d.skeleton === true),
    JSON.stringify((obj(obj(cur.body).foundations).documents||[]).map((d) => [d.slug, d.skeleton])));
  ok('the files are really on disk under foundations/',
    existsSync(join(st, 'curated', 'foundations', 'architecture.md'))
    && existsSync(join(st, 'curated', 'foundations', 'manifest.json')));
  ok('...and each one carries the visible banner that says it is not written yet',
    readFileSync(join(st, 'curated', 'foundations', 'roadmap.md'), 'utf8')
      .startsWith(SKELETON_BANNER.slice(0, 30)),
    readFileSync(join(st, 'curated', 'foundations', 'roadmap.md'), 'utf8').slice(0, 60));

  // ONCE. A second init is refused with the ownership and the count named.
  const again = await call('post', '/:domain/:project/foundations/init',
    { params: { domain: 'tier0', project: 'curated' }, body: { ownership: 'repo', repoRoot: REPO } });
  eq('a second init is refused with 400', again.status, 400);
  eq('...under the route\'s own reason', again.body.reason, 'ownership_set');
  eq('...naming the ownership already chosen', again.body.ownership, 'curator');
  eq('...and how many documents that choice already holds', again.body.documentCount, 4);
  eq('...and the four documents are still there',
    readdirSync(join(st, 'curated', 'foundations')).filter((n) => n.endsWith('.md')).length, 4);

  // `seed: false` — the ownership without the prompts.
  const bare = await call('post', '/:domain/:project/foundations/init',
    { params: { domain: 'tier0', project: 'later' }, body: { ownership: 'curator', seed: false } });
  eq('curator with seed:false answers 201', bare.status, 201);
  eq('...and writes no skeletons', (obj(bare.body).seeded||[]).length, 0);
  eq('...but the manifest exists, so the choice is recorded', obj(obj(bare.body).foundations).present, true);

  // THE TWO CHOICES ARE EXCLUSIVE. A repoRoot on the curator arm is refused
  // rather than ignored -- a silent ignore would hide which choice was made.
  const both = await call('post', '/:domain/:project/foundations/init',
    { params: { domain: 'tier0', project: 'ownerless' }, body: { ownership: 'curator', repoRoot: REPO } });
  eq('curator + repoRoot is refused with 400', both.status, 400);
  eq('...under its own reason', both.body.reason, 'root_not_allowed');
  ok('...and nothing was written', !existsSync(join(st, 'ownerless', 'foundations')));

  for (const [label, ownership] of [['a missing ownership', undefined], ['an unrecognised one', 'mine'], ['a non-string', { a: 1 }]]) {
    const r = await call('post', '/:domain/:project/foundations/init',
      { params: { domain: 'tier0', project: 'ownerless' }, body: { ownership } });
    eq('init refuses ' + label + ' with 400', r.status, 400);
    eq('...under its own reason', r.body.reason, 'invalid_ownership');
  }

  const unreachable = await call('post', '/:domain/:project/foundations/init',
    { params: { domain: 'tier0', project: 'ownerless' }, body: { ownership: 'repo', repoRoot: join(TMP, 'nope') } });
  eq('repo + a folder that is not here is a 409', unreachable.status, 409);
  eq('...under its own reason', unreachable.body.reason, 'repo_unreachable');
  ok('...and no manifest was written', !existsSync(join(st, 'ownerless', 'foundations', 'manifest.json')));

  // REPO, with files from the scan.
  const mir = await call('post', '/:domain/:project/foundations/init', {
    params: { domain: 'tier0', project: 'mirrored' },
    body: {
      ownership: 'repo',
      repoRoot: REPO,
      files: [{ path: 'docs/architecture.md', role: 'architecture' }, { path: 'decisions/0001-use-markdown.md', role: 'decisions' }],
    },
  });
  eq('a repo init answers 201', mir.status, 201);
  eq('...recording the ownership', mir.body.ownership, 'repo');
  eq('...seeding nothing', (obj(mir.body).seeded||[]).length, 0);
  eq('...and reporting the mirror step', (obj(obj(mir.body).refresh).added || []).length, 2);
  eq('the index is repo-owned', obj(obj(mir.body).foundations).ownership, 'repo');
  eq('...with no skeletons, because a mirror is whatever the folder says',
    obj(obj(mir.body).foundations).skeletonCount, 0);
  eq('the mirrored bytes are a BYTE COPY of the source',
    readFileSync(join(st, 'mirrored', 'foundations', 'architecture.md'), 'utf8'),
    readFileSync(join(REPO, 'docs', 'architecture.md'), 'utf8'));
  eq('...and a plain folder with no git records no commit, rather than failing',
    obj((obj(obj(mir.body).foundations).documents||[])[0]).commit, null);

  // A MALFORMED MANIFEST IS `manifest_unreadable`, NOT `ownership_set`: the
  // two are different facts and only one of them is fixable by choosing.
  mkdirSync(join(st, 'badmanifest', 'foundations'), { recursive: true });
  writeFileSync(join(st, 'badmanifest', 'foundations', 'manifest.json'), '{ not json');
  const broke = await call('post', '/:domain/:project/foundations/init',
    { params: { domain: 'tier0', project: 'badmanifest' }, body: { ownership: 'curator' } });
  eq('init over a manifest this store cannot read is a 400', broke.status, 400);
  eq('...under manifest_unreadable, not ownership_set', broke.body.reason, 'manifest_unreadable');
  eq('...and no skeleton was written beside it',
    readdirSync(join(st, 'badmanifest', 'foundations')).filter((n) => n.endsWith('.md')).length, 0);

  // THE THREE GUARDS EVERY WRITE ROUTE RUNS.
  eq('init refuses an unknown domain with 404',
    (await call('post', '/:domain/:project/foundations/init',
      { params: { domain: 'nosuch', project: 'x' }, body: { ownership: 'curator' } })).status, 404);
  eq('init refuses a read-only mirror with 403',
    (await call('post', '/:domain/:project/foundations/init',
      { params: { domain: 'shared-cohort', project: 'shared-cohort' }, body: { ownership: 'curator' } })).status, 403);
  eq('init refuses an unusable project name with 400',
    (await call('post', '/:domain/:project/foundations/init',
      { params: { domain: 'tier0', project: '../escape' }, body: { ownership: 'curator' } })).status, 400);
  const ghost = await call('post', '/:domain/:project/foundations/init',
    { params: { domain: 'tier0', project: 'never-made' }, body: { ownership: 'curator' } });
  eq('init on a project that was never created is a 404', ghost.status, 404);
}

// ── S11c -- PUT: the owner's pen, and every wall in front of it ─────────
{
  const st = join(DOMAINS, 'tier0', 'state');

  // FILLING A SKELETON clears the mark -- on the wire, and on the next read.
  const filled = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'architecture.md' },
    body: { text: '# Architecture\n\nOne server, three stores.\n', title: 'Architecture' },
  });
  eq('a write to a seeded skeleton answers 200', filled.status, 200);
  eq('...reporting it as a REPLACEMENT, not a creation', filled.body.created, false);
  eq('...and saying it filled a skeleton', filled.body.wasSkeleton, true);
  eq('...with the mark now cleared on the row', obj(obj(filled.body).document).skeleton, false);
  eq('...and the bytes on disk are what was sent',
    readFileSync(join(st, 'curated', 'foundations', 'architecture.md'), 'utf8'),
    '# Architecture\n\nOne server, three stores.\n');
  const idxAfter = await call('get', '/:domain/:project', { params: { domain: 'tier0', project: 'curated' } });
  eq('the very next index read agrees: three skeletons left of four',
    obj(obj(idxAfter.body).foundations).skeletonCount, 3);
  eq('...and the filled row reads false there too',
    (obj(obj(idxAfter.body).foundations).documents||[]).find((d) => d.slug === 'architecture.md').skeleton, false);
  const docAfter = await call('get', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'architecture.md' } });
  eq('...and so does the document read', docAfter.body.skeleton, false);

  // CREATING a document: `created: true`, and the row carries the role given.
  const made = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'glossary.md' },
    body: { text: '# Glossary\n\nWords.\n', title: 'Glossary', role: 'guide' },
  });
  eq('a write to a slug that did not exist answers 200', made.status, 200);
  eq('...reported as a CREATION', made.body.created, true);
  eq('...with the role that was asked for', obj(obj(made.body).document).role, 'guide');
  eq('...and it is not a skeleton, because somebody wrote it', obj(obj(made.body).document).skeleton, false);
  eq('...and it did not fill one either', made.body.wasSkeleton, false);
  // THE ROW COMES FROM THE INDEX THAT NOW EXISTS, not from the save result.
  // `freshness` is COMPUTED and `saveFoundation` does not return it, so a
  // row built from the save result alone reads `null` where the table beside
  // the editor reads `n/a` — the same document described two ways on one
  // screen, one paint apart.
  eq('the returned row carries the COMPUTED freshness a curator document has',
    obj(obj(made.body).document).freshness, 'n/a');
  ok('the project budget is disclosed rather than enforced',
    made.body.budgetBytes === 200 * 1024 && made.body.budgetExceeded === false,
    JSON.stringify({ b: made.body.budgetBytes, e: made.body.budgetExceeded }));
  // THE HUMAN'S STAMP, part (ii) of the tier-0 argument: an app edit must
  // never arrive wearing an agent's provenance line.
  eq('the write is stamped as the HUMAN\'s', obj(obj(obj(made.body).document).authoredBy).kind, 'human');
  eq('...with no harness', obj(obj(obj(made.body).document).authoredBy).harness, null);
  eq('...and no model', obj(obj(obj(made.body).document).authoredBy).model, null);
  eq('...and a curator source, which is what makes it unable to land on a mirror',
    obj(obj(obj(made.body).document).source).kind, 'curator');
  // A FORGED STAMP IN THE BODY IS IGNORED. The store accepts an `authoredBy`
  // from its caller, so if the route forwarded the body's the owner's own
  // edit would arrive wearing whatever a loopback client typed.
  const forgedPut = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'forged.md' },
    body: { text: '# Forged\n\nx\n', title: 'Forged', authoredBy: { kind: 'agent', harness: 'not-a-person' } },
  });
  eq('a PUT carrying its own `authoredBy` still succeeds', forgedPut.status, 200);
  eq('...stamped as the HUMAN\'s regardless',
    obj(obj(obj(forgedPut.body).document).authoredBy).kind, 'human');
  ok('...and the forged harness is nowhere in the manifest',
    !/not-a-person/.test(readFileSync(join(st, 'curated', 'foundations', 'manifest.json'), 'utf8')));

  // THE 512 KB WALL, with BOTH numbers in the sentence a person reads.
  const over = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'huge.md' },
    body: { text: 'x'.repeat(512 * 1024 + 1), title: 'Huge' },
  });
  eq('a document over the per-document cap is refused with 400', over.status, 400);
  eq('...under the route\'s own reason', over.body.reason, 'too_large');
  ok('...naming the size that was sent AND the wall', /524289/.test(String(over.body.error))
    && /524288/.test(String(over.body.error)), String(over.body.error).slice(0, 200));
  ok('...and nothing was written', !existsSync(join(st, 'curated', 'foundations', 'huge.md')));
  // CONTROL: a document just UNDER the wall is accepted, so the wall is a
  // wall and not a blanket refusal.
  eq('CONTROL: one byte under the cap is accepted',
    (await call('put', '/:domain/:project/foundations/:slug', {
      params: { domain: 'tier0', project: 'curated', slug: 'big.md' },
      body: { text: 'y'.repeat(512 * 1024), title: 'Big' },
    })).status, 200);
  // ...and it is now removed again, so the project budget disclosure below
  // is not measuring this fixture.
  await call('delete', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'big.md' }, body: { confirm: 'big.md' } });

  // A MIRROR IS NOT EDITED HERE. The sentence is about the app's own two
  // controls, which is why the route says it rather than the store.
  const mirror = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'mirrored', slug: 'architecture.md' },
    body: { text: '# Hijack\n', title: 'Hijack' },
  });
  eq('a repo-owned document refuses the write with 400', mirror.status, 400);
  eq('...under its own reason', mirror.body.reason, 'repo_owned');
  ok('...with the sentence the contract names',
    /mirrored from the repository — edit it there and refresh/.test(String(mirror.body.error)),
    String(mirror.body.error));
  eq('...and the mirrored bytes are untouched',
    readFileSync(join(st, 'mirrored', 'foundations', 'architecture.md'), 'utf8'),
    readFileSync(join(REPO, 'docs', 'architecture.md'), 'utf8'));

  // NO OWNERSHIP YET: `init` is the call, and the refusal says so.
  const no = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'ownerless', slug: 'architecture.md' },
    body: { text: '# A\n', title: 'A' },
  });
  eq('a project that has not chosen refuses the write with 400', no.status, 400);
  eq('...under no_manifest', no.body.reason, 'no_manifest');
  ok('...and nothing was written', !existsSync(join(st, 'ownerless', 'foundations')));

  // A MANIFEST THAT WILL NOT PARSE: nothing is written, and the reason is
  // the file rather than the operation.
  const bad = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'badmanifest', slug: 'architecture.md' },
    body: { text: '# A\n', title: 'A' },
  });
  eq('a write over an unreadable manifest is a 400', bad.status, 400);
  eq('...under manifest_unreadable', bad.body.reason, 'manifest_unreadable');

  // BOUNDARY CHECKS, before any path is built.
  for (const evil of ['../../etc/passwd', '..', 'a/b.md', 'NOPE.MD', 'no-extension', '-leading.md']) {
    const r = await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: evil }, body: { text: '# x\n' } });
    eq('PUT refuses "' + evil.slice(0, 20) + '" as a document name', r.status, 400);
    eq('...with the reason named', r.body.reason, 'invalid_slug');
  }
  eq('PUT with no `text` at all is a 400',
    (await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: 'x.md' }, body: {} })).status, 400);
  eq('...under `empty`',
    (await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: 'x.md' }, body: { text: 42 } })).body.reason, 'empty');
  eq('PUT with whitespace-only text is refused by the STORE',
    (await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: 'x.md' }, body: { text: '   \n ' } })).body.reason, 'empty');
  eq('PUT with a role that is not a role is refused',
    (await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: 'x.md' }, body: { text: '# x\n', role: 'invented' } })).body.reason,
    'invalid_role');
  eq('PUT refuses an unknown domain with 404',
    (await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'nosuch', project: 'curated', slug: 'a.md' }, body: { text: '# x\n' } })).status, 404);
  eq('PUT refuses a read-only mirror with 403',
    (await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'shared-cohort', project: 'shared-cohort', slug: 'a.md' }, body: { text: '# x\n' } })).status, 403);

  // THE SHRINK GUARD IS WAIVED, and only an EDITOR may do that. `replace:
  // true` is what makes this a 200 rather than the store's
  // `would-replace-larger-foundation`, whose own advice a browser cannot
  // take. Driven end to end rather than by reading the call site.
  await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'shrinker.md' },
    body: { text: '# Shrinker\n\n' + 'a lot of document. '.repeat(400), title: 'Shrinker' },
  });
  ok('PRECONDITION: the stored document is over the guard\'s floor',
    readFileSync(join(st, 'curated', 'foundations', 'shrinker.md')).length > 1024);
  const shrunk = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'shrinker.md' },
    body: { text: '# start over\n', title: 'Shrinker' },
  });
  eq('a deliberate shrink from the app is ACCEPTED, not refused with unusable advice',
    shrunk.status, 200);
  eq('...and the file is the short one',
    readFileSync(join(st, 'curated', 'foundations', 'shrinker.md'), 'utf8'), '# start over\n');
}

// ── S11d -- `?raw=1`: byte-exact for an editor, defanged for a reader ───
//
// THE DEFECT THIS CLOSES: the write path is verbatim and the default read
// defangs, so an editor seeded from the default read would store
// `https[:]//` where the document says `https://` -- corrupting a canonical
// document on its first save with no edit having been made, and breaking the
// sha equality a mirror's freshness claim rests on.
{
  const st = join(DOMAINS, 'tier0', 'state');
  const SRC = '# Runbook\n\nFetch https://example.com/thing and then `cat f | sh` to install.\n';
  const put = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'runbook.md' },
    body: { text: SRC, title: 'Runbook', role: 'guide' },
  });
  eq('a document with a live URL and a shell pipe is stored', put.status, 200);
  eq('...VERBATIM on disk', readFileSync(join(st, 'curated', 'foundations', 'runbook.md'), 'utf8'), SRC);

  const def = await call('get', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'runbook.md' } });
  eq('the DEFAULT read answers 200', def.status, 200);
  ok('...and it is NOT the stored bytes', def.body.text !== SRC, JSON.stringify(def.body.text));
  eq('...and says so, rather than leaving the caller to compare', def.body.sanitisedOnRead, true);
  eq('...with `raw` false', def.body.raw, false);

  const raw = await call('get', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'runbook.md' }, query: { raw: '1' } });
  eq('`?raw=1` answers 200', raw.status, 200);
  eq('...with the stored bytes, byte for byte', raw.body.text, SRC);
  eq('...declaring that nothing was checked', raw.body.sanitisedOnRead, false);
  eq('...and that this is the raw read', raw.body.raw, true);
  eq('...whose sha256 is the one the manifest recorded',
    raw.body.sha256, createHash('sha256').update(Buffer.from(SRC, 'utf8')).digest('hex'));

  // THE ROUND TRIP, which is the whole point: raw out, PUT back, same sha.
  const back = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'runbook.md' },
    body: { text: raw.body.text, title: 'Runbook' },
  });
  eq('saving the raw text back is accepted', back.status, 200);
  eq('...and the sha is unchanged, so an unedited edit changed nothing',
    obj(obj(back.body).document).sha256, raw.body.sha256);
  // ...and the CONTROL: saving the DEFANGED text back would have changed it,
  // which is exactly the corruption `?raw=1` exists to prevent.
  const corrupt = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'curated', slug: 'runbook-copy.md' },
    body: { text: def.body.text, title: 'Copy' },
  });
  ok('CONTROL: saving the DEFANGED text stores different bytes -- the corruption '
    + 'the raw read exists to prevent', obj(obj(corrupt.body).document).sha256 !== raw.body.sha256,
  obj(obj(corrupt.body).document).sha256);
  eq('`?raw=true` is accepted as well as `?raw=1`',
    (await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: 'runbook.md' }, query: { raw: 'true' } })).body.raw, true);
  eq('...and anything else leaves the default alone',
    (await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: 'runbook.md' }, query: { raw: '0' } })).body.raw, false);
}

// ── S11e -- DELETE: the typed confirmation, the mirror, and the orphan ──
{
  const st = join(DOMAINS, 'tier0', 'state');
  const dir = join(st, 'curated', 'foundations');

  const nothing = await call('delete', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'glossary.md' }, body: {} });
  eq('a delete with no confirmation is refused', nothing.status, 400);
  eq('...under confirm_required', nothing.body.reason, 'confirm_required');
  ok('...and the file is still there', existsSync(join(dir, 'glossary.md')));
  const wrong = await call('delete', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'glossary.md' }, body: { confirm: 'glossary' } });
  eq('a delete confirming the wrong name is refused', wrong.status, 400);
  ok('...and the file is still there', existsSync(join(dir, 'glossary.md')));

  const gone = await call('delete', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'glossary.md' }, body: { confirm: 'glossary.md' } });
  eq('a correctly-confirmed delete answers 200', gone.status, 200);
  eq('...naming what was removed', gone.body.removed, 'glossary.md');
  eq('...and saying it was a listed document, not an orphan', gone.body.wasOrphan, false);
  ok('...and the file is really gone', !existsSync(join(dir, 'glossary.md')));
  ok('...while its siblings are untouched', existsSync(join(dir, 'architecture.md')));

  const absent = await call('delete', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'never-existed.md' }, body: { confirm: 'never-existed.md' } });
  eq('deleting a document that is not there is a 404, not a cheerful 200', absent.status, 404);
  eq('...under foundation_not_found', absent.body.reason, 'foundation_not_found');

  // AN ORPHAN -- a file the manifest never listed, which is the shape a crash
  // between a document write and the manifest write leaves behind. Removing
  // one is legitimate cleanup, and is reported as what it was.
  writeFileSync(join(dir, 'stray.md'), '# Stray\n');
  const orphan = await call('delete', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'curated', slug: 'stray.md' }, body: { confirm: 'stray.md' } });
  eq('deleting an unlisted orphan answers 200', orphan.status, 200);
  eq('...and says it was an orphan', orphan.body.wasOrphan, true);
  ok('...and it is gone', !existsSync(join(dir, 'stray.md')));

  // ── REMOVAL WORKS ON A MIRROR TOO, SINCE v3.61.2 ──────────────────────
  //
  // THE DEFECT THIS CLOSES: this route answered 400 `repo_owned` here, so a
  // mirrored project's document list could not be edited AT ALL — the
  // maintainer mirrored his own repository, got 25 rows including files he
  // never meant to carry, and had no way to drop one. v3.61.0 recorded the
  // refusal as "arguably wrong" on the grounds that "the next refresh would
  // simply put it back"; `refreshCore` builds its work list from
  // `manifest.documents`, so it does not, and the entry stays gone.
  //
  // Driven against the REAL store and the REAL repository fixture, because
  // the three facts that matter are all on disk: the copy goes, the MANIFEST
  // ENTRY goes, and the SOURCE FILE the copy came from does not.
  {
    const src = join(REPO, 'docs', 'architecture.md');
    ok('PRECONDITION: the source file is on disk and the copy is listed', existsSync(src)
      && existsSync(join(st, 'mirrored', 'foundations', 'architecture.md')), src);
    const before = JSON.parse(readFileSync(join(st, 'mirrored', 'foundations', 'manifest.json'), 'utf8'));
    ok('PRECONDITION: …and the manifest lists it',
      before.documents.some((d) => d.slug === 'architecture.md'), JSON.stringify(before.documents.map((d) => d.slug)));

    const mirror = await call('delete', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'mirrored', slug: 'architecture.md' }, body: { confirm: 'architecture.md' } });
    eq('a repo-owned document can now be REMOVED — stop mirroring, not an edit', mirror.status, 200);
    eq('...and the response says which outcome this was', mirror.body.ownership, 'repo');
    eq('...and that the source file was kept, which is the difference from a delete',
      mirror.body.sourceKept, true);
    ok('...the COPY is gone',
      !existsSync(join(st, 'mirrored', 'foundations', 'architecture.md')));
    const after = JSON.parse(readFileSync(join(st, 'mirrored', 'foundations', 'manifest.json'), 'utf8'));
    ok('...the MANIFEST ENTRY is gone, which is what makes a refresh leave it alone',
      !after.documents.some((d) => d.slug === 'architecture.md'),
      JSON.stringify(after.documents.map((d) => d.slug)));
    ok('...and the SOURCE FILE in the folder is untouched — the sentence the confirm strip '
      + 'promises before anything happens', existsSync(src), src);

    // AND THE INVARIANT THE OWNERSHIP GATE ACTUALLY PROTECTS IS UNMOVED: a
    // mirrored document still cannot be EDITED here, because a write would
    // make two writers of one file.
    const stillRefused = await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'mirrored', slug: '0001-use-markdown.md' },
        body: { text: '# Mine now\n' } });
    eq('CONTROL: PUT on a mirrored document is STILL refused with 400', stillRefused.status, 400);
    eq('...still under repo_owned', stillRefused.body.reason, 'repo_owned');
    // The OTHER mirrored document — the decision record, whose slug the store
    // DERIVED from `decisions/0001-use-markdown.md` — is still on disk with
    // its own bytes. Named by that derived slug, because it is what the mirror
    // wrote: a guess at `decisions.md` asserts about a file that was never
    // there, which is how the first cut of this assertion failed while the
    // route behaved correctly.
    ok('...and that document is unchanged on disk',
      existsSync(join(st, 'mirrored', 'foundations', '0001-use-markdown.md'))
      && !/Mine now/.test(readFileSync(join(st, 'mirrored', 'foundations', '0001-use-markdown.md'), 'utf8')));

    // A CURATOR-OWNED REMOVAL STILL REPORTS ITSELF AS ONE: the two outcomes
    // are different sentences to a person, and a client that could not tell
    // them apart would say "your folder is untouched" about a document that
    // only ever lived here.
    writeFileSync(join(dir, 'temp-one.md'), '# Temp\n');
    const seed = await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: 'temp-one.md' }, body: { text: '# Temp\n' } });
    ok('PRECONDITION: a curator document exists to remove', seed.status === 200, String(seed.status));
    const cur = await call('delete', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: 'temp-one.md' }, body: { confirm: 'temp-one.md' } });
    eq('a curator-owned removal answers 200', cur.status, 200);
    eq('...reporting curator ownership', cur.body.ownership, 'curator');
    eq('...and NOT claiming a source file was kept, because there is none',
      cur.body.sourceKept, false);

    // ── THE GATE IS THE MANIFEST, AND IT IS STILL A GATE ────────────────
    // v3.61.2 moved DELETE off `requireCuratorOwned` and on to
    // `requireManifest`, and the two arms that survived the move have to be
    // asserted or the change reads as "the gate went away". A mutation
    // deleting the `no_manifest` arm was GREEN before these two lines: the
    // suite proved the ownership refusal was gone and nothing proved the rest
    // of the gate was still there.
    const none = await call('delete', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'ownerless', slug: 'architecture.md' },
        body: { confirm: 'architecture.md' } });
    eq('a project that has never chosen an ownership has nothing to remove — 400',
      none.status, 400);
    eq('...under no_manifest, which is a different fact from "no such document"',
      none.body.reason, 'no_manifest');
    const badm = await call('delete', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'badmanifest', slug: 'architecture.md' },
        body: { confirm: 'architecture.md' } });
    eq('a manifest this app cannot read refuses the removal with 400', badm.status, 400);
    eq('...under manifest_unreadable — rewriting it could drop entries for documents '
      + 'nobody can see', badm.body.reason, 'manifest_unreadable');
  }

  eq('DELETE refuses an unusable slug with 400',
    (await call('delete', '/:domain/:project/foundations/:slug',
      { params: { domain: 'tier0', project: 'curated', slug: '../../etc/passwd' }, body: { confirm: '../../etc/passwd' } })).status, 400);
  eq('DELETE refuses an unknown domain with 404',
    (await call('delete', '/:domain/:project/foundations/:slug',
      { params: { domain: 'nosuch', project: 'curated', slug: 'a.md' }, body: { confirm: 'a.md' } })).status, 404);
  eq('DELETE refuses a read-only mirror with 403',
    (await call('delete', '/:domain/:project/foundations/:slug',
      { params: { domain: 'shared-cohort', project: 'shared-cohort', slug: 'a.md' }, body: { confirm: 'a.md' } })).status, 403);
}

// ── S11f -- the refresh grows a `files` list, and forwards every refusal ──
//
// Before v3.61.0 this route passed NO file list, so `opts.files` existed in
// the store and nothing reached it: a mirror could only be created from a
// test. A file somebody ticked and did not get is exactly the fact a
// projected response loses, so `refused[]` is forwarded and rendered
// un-folded.
{
  const st = join(DOMAINS, 'tier0', 'state');
  const r = await call('post', '/:domain/:project/foundations/refresh', {
    params: { domain: 'tier0', project: 'mirrored' },
    body: {
      files: [
        { path: 'docs/roadmap.md', role: 'roadmap' },
        { path: '../escape.md', role: 'other' },
        { path: 'docs/logo.png', role: 'other' },
        { path: 'docs/api-dump.md', role: 'api' },
        { path: 'docs/not-there.md', role: 'other' },
      ],
    },
  });
  eq('a refresh naming new files answers 200', r.status, 200);
  ok('the valid new file is ADDED to the mirror', (r.body.added || []).includes('roadmap.md'),
    JSON.stringify(r.body.added));
  ok('...and really copied byte for byte',
    existsSync(join(st, 'mirrored', 'foundations', 'roadmap.md'))
    && readFileSync(join(st, 'mirrored', 'foundations', 'roadmap.md'), 'utf8')
      === readFileSync(join(REPO, 'docs', 'roadmap.md'), 'utf8'),
    'the copy is not on disk at all');
  const refused = r.body.refused || [];
  ok('`refused` crosses the wire at all', Array.isArray(refused) && refused.length >= 3,
    JSON.stringify(refused));
  const byPath = new Map(refused.map((x) => [x.path, x.reason]));
  ok('a path outside the folder is refused with its reason',
    /outside the repository root/.test(String(byPath.get('../escape.md'))), JSON.stringify(refused));
  ok('a non-markdown source is refused with its reason',
    /only \.md and \.txt/.test(String(byPath.get('docs/logo.png'))), JSON.stringify(refused));
  ok('a file over the per-document cap is refused with BOTH numbers',
    /524288/.test(String(byPath.get('docs/api-dump.md'))), JSON.stringify(refused));
  ok('...and a source that simply is not there is `missing`, not `refused` -- the '
    + 'copy is kept and the two have parted', (r.body.missing || []).includes('docs/not-there.md'),
  JSON.stringify(r.body.missing));
  ok('every refused entry carries a path AND a reason, both strings',
    refused.every((x) => typeof x.path === 'string' && typeof x.reason === 'string'), JSON.stringify(refused));
  // CONTROL: the plain refresh (no files) still answers, and refuses nothing.
  const plain = await call('post', '/:domain/:project/foundations/refresh',
    { params: { domain: 'tier0', project: 'mirrored' }, body: {} });
  eq('CONTROL: a refresh with no `files` still answers 200', plain.status, 200);
  eq('...refusing nothing', (plain.body.refused || []).length, 0);
  eq('...and re-copying nothing, because nothing changed', (plain.body.refreshed || []).length, 0);
}

// ── S11g -- POST /:domain/projects with `foundations`, and the disclosure ──
{
  const st = join(DOMAINS, 'tier0', 'state');

  const withCur = await call('post', '/:domain/projects', {
    params: { domain: 'tier0' },
    body: { project: 'seeded-at-create', foundations: { ownership: 'curator' } },
  });
  eq('create + curator answers 201', withCur.status, 201);
  eq('...and hands back the marker line a coding agent needs',
    obj(withCur.body).markerLine, 'tier0/seeded-at-create');
  eq('...with four skeletons seeded', obj(obj(withCur.body).foundations).skeletonCount, 4);
  eq('...curator-owned', obj(obj(withCur.body).foundations).ownership, 'curator');
  eq('...and no disclosed failure', obj(withCur.body).foundationsError, null);
  ok('...and both tiers are on disk',
    existsSync(join(st, 'seeded-at-create', 'project.md'))
    && existsSync(join(st, 'seeded-at-create', 'foundations', 'manifest.json')));

  const withRepo = await call('post', '/:domain/projects', {
    params: { domain: 'tier0' },
    body: {
      project: 'mirrored-at-create',
      foundations: { ownership: 'repo', repoRoot: REPO, files: [{ path: 'README.md', role: 'guide' }] },
    },
  });
  eq('create + repo answers 201', withRepo.status, 201);
  eq('...repo-owned', obj(obj(withRepo.body).foundations).ownership, 'repo');
  eq('...with the named file mirrored', (obj(obj(withRepo.body).foundations).documents||[]).length, 1);
  ok('...and the mirror report riding along, so a refusal could be shown',
    !!obj(withRepo.body).refresh && Array.isArray(obj(obj(withRepo.body).refresh).refused),
    JSON.stringify(obj(withRepo.body).refresh));

  // THE DISCLOSURE. A tier-0 failure AFTER the brief is on disk is reported,
  // never a 5xx and never a rollback: the project EXISTS.
  const partial = await call('post', '/:domain/projects', {
    params: { domain: 'tier0' },
    body: { project: 'half-made', brief: '## Standing brief\n\nStill a project.', foundations: { ownership: 'repo', repoRoot: join(TMP, 'not-a-folder') } },
  });
  eq('a tier-0 failure still answers 201', partial.status, 201);
  eq('...with ok true, because the project was created', partial.body.ok, true);
  eq('...the failure disclosed under its own reason', obj(obj(partial.body).foundationsError).reason, 'repo_unreachable');
  ok('...with a sentence a person can act on',
    String(obj(obj(partial.body).foundationsError).message).length > 20, JSON.stringify(obj(partial.body).foundationsError));
  eq('...and `foundations` null rather than a half-built index', obj(partial.body).foundations, null);
  ok('...while the project itself really exists, brief and all',
    readFileSync(join(st, 'half-made', 'project.md'), 'utf8').includes('Still a project.'));
  ok('...and no foundations folder was left behind',
    !existsSync(join(st, 'half-made', 'foundations')));

  // A CALLER THAT DOES NOT OPT IN SEES NO NEW BEHAVIOUR.
  const plain = await call('post', '/:domain/projects',
    { params: { domain: 'tier0' }, body: { project: 'no-tier-zero' } });
  eq('create without `foundations` answers 201', plain.status, 201);
  eq('...with `foundations` explicitly null, not absent', obj(plain.body).foundations, null);
  eq('...and `foundationsError` explicitly null', obj(plain.body).foundationsError, null);
  ok('the key is PRESENT rather than omitted, because a view has to tell '
    + '"nothing to set up" from "this server does not know about tier 0"',
  'foundations' in plain.body && 'foundationsError' in plain.body, JSON.stringify(Object.keys(plain.body)));
  ok('...and nothing tier-0 was written', !existsSync(join(st, 'no-tier-zero', 'foundations')));

  // A `foundations` value of the WRONG SHAPE is ignored rather than passed
  // to the store as a string, which would read `opts.foundations.ownership`
  // as undefined -- the silent-mismatch shape this file was revised over.
  const shaped = await call('post', '/:domain/projects',
    { params: { domain: 'tier0' }, body: { project: 'bad-shape', foundations: 'curator' } });
  eq('a non-object `foundations` is ignored, not half-applied', shaped.status, 201);
  eq('...leaving tier 0 untouched', obj(shaped.body).foundations, null);

  // A TRUST BOUNDARY, not tidiness. `createProject` prefers
  // `foundations.authoredBy` over the caller's own, so a body carrying an
  // agent line would stamp the OWNER's seeded skeletons with an agent's
  // provenance — the dishonesty part (ii) of the tier-0 argument forbids,
  // and reachable from any loopback client. The stamp is the router's.
  const forged = await call('post', '/:domain/projects', {
    params: { domain: 'tier0' },
    body: {
      project: 'forged-stamp',
      foundations: {
        ownership: 'curator',
        authoredBy: { kind: 'agent', harness: 'not-a-person', model: 'not-a-person' },
      },
    },
  });
  eq('a forged provenance on `foundations` does not stop the create', forged.status, 201);
  const stamp = obj(obj((obj(obj(forged.body).foundations).documents || [])[0]).authoredBy);
  eq('...and every seeded document is still stamped as the HUMAN\'s', stamp.kind, 'human');
  eq('...with no harness the caller supplied', stamp.harness, null);
  eq('...and no model', stamp.model, null);
  // READ OFF DISK, and the absence of the file is a FAILURE rather than a
  // crash: a mutation that stops passing `foundations` to the store at all
  // leaves no manifest here, and the harness cannot tell a crash from a red.
  {
    const mfPath = join(st, 'forged-stamp', 'foundations', 'manifest.json');
    const mf = existsSync(mfPath) ? readFileSync(mfPath, 'utf8') : '';
    ok('...which is what the file on disk says too',
      /"kind": ?"human"/.test(mf), mf ? mf.slice(0, 300) : 'no manifest was written at all');
    ok('...and the forged harness appears NOWHERE in the manifest',
      mf !== '' && !/not-a-person/.test(mf), mf ? 'found it' : 'no manifest was written at all');
  }
}

// ── S11h -- THE DOMAIN'S OWN PROJECT reaches every one of these routes ──
//
// The domain's own project is the one whose slug IS the domain name and whose
// tree is the state ROOT — its foundations live at `state/foundations/` with
// no `<project>` segment at all. The header block records a KNOWN collision:
// `GET /:domain/projects` matches before `GET /:domain/:project`, so a
// project someone named `projects` is unreachable on the scoped read. The
// question this block answers by EXECUTION rather than by reasoning is
// whether the four-segment routes reach the domain's own project.
//
// THEY DO, and the mechanism is segment count: `/:domain/projects` matches
// exactly two segments and `…/tier0/tier0/foundations/init` has four, so the
// literal cannot shadow it. Driven below on init, PUT, GET (raw and default),
// DELETE and refresh — a control whose only outcome was a refusal would be
// the v3.16.1 defect, so each of these is a real write.
{
  const st = join(DOMAINS, 'tier0', 'state');

  // ROUTE-TABLE PROOF, independent of the drives below: no two-segment
  // pattern can match a four-segment path, so the collision cannot reach here.
  {
    const four = ROUTES.filter((r) => r.path.split('/').filter(Boolean).length === 4).map((r) => r.path);
    ok('every foundations route is four segments deep', four.length === 5, JSON.stringify(four));
    const twoGet = ROUTES.filter((r) => r.method === 'get'
      && r.path.split('/').filter(Boolean).length === 2).map((r) => r.path);
    eq('...while the colliding literal is a TWO-segment pattern',
      JSON.stringify(twoGet), JSON.stringify(['/:domain/projects', '/:domain/:project']));
    // ...and PATCH/DELETE on /:domain/projects/:project shadow nothing: they
    // are alone on their (method, segment-count) pair.
    for (const m of ['patch', 'delete']) {
      const three = ROUTES.filter((r) => r.method === m
        && r.path.split('/').filter(Boolean).length === 3).map((r) => r.path);
      eq(m.toUpperCase() + ' has exactly one three-segment route, so it shadows nothing',
        JSON.stringify(three), JSON.stringify(['/:domain/projects/:project']));
    }
  }

  const init = await call('post', '/:domain/:project/foundations/init',
    { params: { domain: 'tier0', project: 'tier0' }, body: { ownership: 'curator' } });
  eq('init reaches the domain\'s OWN project', init.status, 201);
  eq('...seeding it', (obj(init.body).seeded||[]).length, 4);
  ok('...at the state ROOT, with no <project> segment',
    existsSync(join(st, 'foundations', 'manifest.json'))
    && !existsSync(join(st, 'tier0', 'foundations')),
  readdirSync(st).join(','));

  const put = await call('put', '/:domain/:project/foundations/:slug', {
    params: { domain: 'tier0', project: 'tier0', slug: 'conventions.md' },
    body: { text: '# Conventions\n\nTabs. No, spaces.\n', title: 'Conventions' },
  });
  eq('PUT reaches the domain\'s own project', put.status, 200);
  eq('...and filled its skeleton', put.body.wasSkeleton, true);
  eq('...writing to the root foundations folder',
    readFileSync(join(st, 'foundations', 'conventions.md'), 'utf8'), '# Conventions\n\nTabs. No, spaces.\n');

  const rd = await call('get', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'tier0', slug: 'conventions.md' }, query: { raw: '1' } });
  eq('the raw GET reaches it', rd.status, 200);
  eq('...byte for byte', rd.body.text, '# Conventions\n\nTabs. No, spaces.\n');

  const del = await call('delete', '/:domain/:project/foundations/:slug',
    { params: { domain: 'tier0', project: 'tier0', slug: 'conventions.md' }, body: { confirm: 'conventions.md' } });
  eq('DELETE reaches it', del.status, 200);
  ok('...and the file is gone from the root folder', !existsSync(join(st, 'foundations', 'conventions.md')));

  // The refresh: curator-owned here, so the reachable answer is the named
  // 400 rather than a 404 about a project the router could not address —
  // which is the distinction this block exists to make.
  const ref = await call('post', '/:domain/:project/foundations/refresh',
    { params: { domain: 'tier0', project: 'tier0' }, body: {} });
  eq('the refresh reaches it too, and answers about its OWNERSHIP rather than '
    + 'about an unaddressable project', ref.status, 400);
  eq('...under curator_owned', ref.body.reason, 'curator_owned');

  // AND THE SCOPED TWO-SEGMENT READ, for contrast: it works for a project
  // named after its domain (the literal is `projects`, not the domain name),
  // and the index it carries is the root tier-0 one.
  const detail = await call('get', '/:domain/:project', { params: { domain: 'tier0', project: 'tier0' } });
  eq('the two-segment detail read reaches the domain\'s own project', detail.status, 200);
  eq('...and carries its root foundations index', obj(obj(detail.body).foundations).present, true);
  eq('...counting the three skeletons left after the fill and the delete',
    obj(obj(detail.body).foundations).skeletonCount, 3);
}

// ── S11i -- every REFUSED tier-0 write reaches the store ZERO times ─────
//
// Asserted by COUNTING store calls through the seam, because a route that
// refuses AFTER calling the store has already done the thing. The real-store
// arm above proves the files are untouched; this proves the call never left.
{
  const cases = [
    ['put', '/:domain/:project/foundations/:slug', 'saveFoundation',
      [['an unknown domain', { params: { domain: 'nope', project: 'lumina', slug: 'a.md' }, body: { text: 'x' } }, 404],
        ['a read-only mirror', { params: { domain: 'shared-cohort', project: 'shared-cohort', slug: 'a.md' }, body: { text: 'x' } }, 403],
        ['an unusable project', { params: { domain: 'alpha', project: '../x', slug: 'a.md' }, body: { text: 'x' } }, 400],
        ['an unusable slug', { params: { domain: 'alpha', project: 'lumina', slug: 'a/b.md' }, body: { text: 'x' } }, 400],
        ['no text', { params: { domain: 'alpha', project: 'lumina', slug: 'a.md' }, body: {} }, 400],
        ['a repo-owned project', { params: { domain: 'alpha', project: 'lumina', slug: 'a.md' }, body: { text: 'x' } }, 400]]],
    ['delete', '/:domain/:project/foundations/:slug', 'removeFoundation',
      [['an unknown domain', { params: { domain: 'nope', project: 'lumina', slug: 'a.md' }, body: { confirm: 'a.md' } }, 404],
        ['a read-only mirror', { params: { domain: 'shared-cohort', project: 'shared-cohort', slug: 'a.md' }, body: { confirm: 'a.md' } }, 403],
        ['no confirmation', { params: { domain: 'alpha', project: 'curated', slug: 'decisions.md' }, body: {} }, 400],
        ['the wrong confirmation', { params: { domain: 'alpha', project: 'curated', slug: 'decisions.md' }, body: { confirm: 'decisions' } }, 400]]],
    // ── AND NOT A REPO-OWNED PROJECT ANY MORE (v3.61.2) ────────────────
    // A repo-owned project WAS on this list, refused 400 `repo_owned`. It is
    // not a refusal now: removing a mirrored entry is the decision to stop
    // mirroring that document, not an edit to a file whose author is the
    // folder, and the real-store arm above proves all three facts on disk
    // (the copy goes, the manifest entry goes, the source file stays). PUT
    // keeps its own repo-owned row directly above, which is the invariant
    // the ownership gate exists for.
    ['post', '/:domain/:project/foundations/init', 'initFoundations',
      [['an unknown domain', { params: { domain: 'nope', project: 'lumina' }, body: { ownership: 'curator' } }, 404],
        ['a read-only mirror', { params: { domain: 'shared-cohort', project: 'shared-cohort' }, body: { ownership: 'curator' } }, 403],
        ['an unusable project', { params: { domain: 'alpha', project: '../x' }, body: { ownership: 'curator' } }, 400]]],
  ];
  for (const [method, path, storeFn, rows] of cases) {
    for (const [label, req, status] of rows) {
      const stub = install(FND_SEED);
      const r = await call(method, path, req);
      eq(method.toUpperCase() + ' refuses ' + label + ' with ' + status, r.status, status);
      eq('...and never reached ' + storeFn + ' (' + label + ')',
        stub.__calls.filter((c) => c.name === storeFn).length, 0);
    }
  }
  // CONTROL: the same routes DO reach the store when nothing refuses them,
  // so the counts above are not measuring a route that never works.
  {
    const stub = install(FND_SEED);
    await call('put', '/:domain/:project/foundations/:slug',
      { params: { domain: 'alpha', project: 'curated', slug: 'decisions.md' }, body: { text: '# x\n' } });
    eq('CONTROL: an accepted PUT does reach saveFoundation',
      stub.__calls.filter((c) => c.name === 'saveFoundation').length, 1);
    const args = obj(obj(stub.__calls.find((c) => c.name === 'saveFoundation')).args)[2];
    eq('...stamped as the human\'s', obj(args.authoredBy).kind, 'human');
    eq('...with the shrink guard waived, which only an EDITOR may do', args.replace, true);
  }
  {
    const stub = install(FND_SEED);
    await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'alpha', project: 'lumina', slug: 'architecture.md' }, query: { raw: '1' } });
    eq('CONTROL: `?raw=1` is forwarded to the store as `{raw: true}`',
      JSON.stringify(obj(obj(stub.__calls.find((c) => c.name === 'readFoundation')).args)[3]), '{"raw":true}');
    const stub2 = install(FND_SEED);
    await call('get', '/:domain/:project/foundations/:slug',
      { params: { domain: 'alpha', project: 'lumina', slug: 'architecture.md' } });
    eq('...and the DEFAULT read asks for nothing',
      JSON.stringify(obj(obj(stub2.__calls.find((c) => c.name === 'readFoundation')).args)[3]), '{}');
  }
  {
    const stub = install(FND_SEED);
    await call('post', '/:domain/:project/foundations/refresh',
      { params: { domain: 'alpha', project: 'lumina' }, body: { files: [{ path: 'docs/x.md' }] } });
    const call4 = obj(obj(obj(stub.__calls.find((c) => c.name === 'refreshFoundationsFromRepo')).args)[3]);
    eq('CONTROL: the refresh really forwards `files` to the store',
      JSON.stringify(call4.files || null), '[{"path":"docs/x.md"}]');
  }
}

// ── Done ─────────────────────────────────────────────────────────────────

routerMod.__setWorkingStateStoreForTest(null);
cleanup();
console.log('\n' + '-'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('All memory-projects route assertions green');
else console.log(failed + ' memory-projects assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
