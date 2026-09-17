/**
 * test-next-memory-view.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * NOTE FOR ANYONE GREPPING THIS FILE: `fingerprint()` below joins each path to
 * its hash with a literal NUL byte — correct, because a filename can contain
 * anything except NUL and `/` — but it makes `file(1)` classify this suite as
 * binary, so plain `grep` prints NOTHING and silently looks like a clean miss.
 * Use `grep -a`. Do not remove the NUL to make grep happy; it is the separator
 * that cannot collide with a real filename.
 *
 * Guards the Agent-memory surface: the read-only route (src/routes/memory.js)
 * and the /next view that renders it (src/public/next/views/memory.js).
 *
 * Everything here DRIVES REAL CODE. The route handlers are pulled straight
 * off the real Express router and invoked with fake req/res objects; the
 * view's render functions are lifted out of the live source by brace-matching
 * and executed with `new Function` (the technique test-next-loading-gate.js
 * and test-next-provider-rows.js use). "A test that proves a line exists
 * proves nothing about what it does."
 *
 * The store itself is real too: fixtures are produced by calling the real
 * `saveWorkingState` / `saveProjectBrief` against a tempdir domains root
 * installed with `__setDomainsDirOverride`. Nothing in this suite can reach
 * the user's own domains folder.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · THE ROUTE NEVER WRITES. A recursive sha256 of the whole domains tree is
 *    identical before and after every endpoint is driven, including with
 *    hostile inputs — and the router registers GET methods only, with no
 *    write-shaped call anywhere in its source.
 *  · Unknown project -> 404 BEFORE any filesystem access; an invalid scope or
 *    machine -> 400 carrying the store's own reason.
 *  · The index reports a project with no state as `scopeCount: 0` with
 *    `lastWriteAt: null` — a fact and its absence never collapse into one
 *    value (no "0 seconds ago", no epoch).
 *  · `journalLimit` is passed through un-clamped; the STORE owns the ceiling.
 *  · ESCAPING: every untrusted field the view interpolates itself is
 *    HTML-escaped, driven through the real render functions with hostile
 *    fixtures — and the handoff/brief BODY is routed through the shared
 *    markdown renderer, which is executed for real here, not stubbed away.
 *  · THE <summary> HAZARD, as a class invariant over rendered OUTPUT rather
 *    than over source text: no `<button>`, `<select>`, `<input>`, `<a>` or
 *    `<textarea>` may appear inside any `<summary>…</summary>` the view emits.
 *  · The view has NO write path, asserted STRUCTURALLY: every `fetch(` call
 *    site in the view takes exactly ONE argument, so it can only ever be a GET
 *    whatever a method string is spelled like. (The previous five-literal-
 *    string scan was defeated by `const M = 'PO' + 'ST'`.)
 *  · THE MOUNT CONTRACT IS EXECUTED, not grepped: onEnter is lifted out of the
 *    registerView object literal and run against a recording window/document.
 *    schedulePoll fires on mount; the teardown cancels the gate, calls
 *    stopPoll, closes view-owned popovers and REMOVES both wake listeners; two
 *    mount/teardown cycles leak nothing; and the wake handler itself is
 *    invoked (revalidates when visible, does not when hidden or unmounted).
 *  · The SHIPPED render() drives §11 — not a copy of it — so the fact that it
 *    records `renderedSignature` is what makes "an unchanged poll re-renders
 *    NOTHING" true. It paints both panes, re-wires, and bails on a stale mount.
 *  · The focus contract is executed: capture is bounded to FOCUSABLE_IDS,
 *    restore is BY ID with preventScroll, FOCUS_FALLBACK covers a control that
 *    removed itself, and a miss is held only while another render is coming.
 *  · The poll constants are pinned to HAND-WRITTEN LITERALS (20000 / 20 /
 *    300000) read off live source, and the SAME parsed values are threaded
 *    into the harness, so §11a's arithmetic is a claim about production.
 *  · renderStaleNotice is executed, and executed THROUGH renderProject, so the
 *    Reload offer is proven to reach all three content branches — each fixture
 *    additionally checked for having reached the branch it is named after.
 *  · reloadActive KEEPS the user's scope and machine (it does not snap to the
 *    newest, which is what selectProject deliberately does instead), falls back
 *    to the freshest only when the scope is genuinely gone, and abandons a
 *    result that lands after a remount.
 *  · A COVERAGE CENSUS enumerated FROM DISK: every top-level function is either
 *    executed here or listed with the reason it is not, so a new one cannot
 *    arrive untested in silence.
 *  · `splitHandoffPreamble` can never eat a body line, and returns the raw
 *    text unchanged rather than emptying a document it does not recognise.
 *  · `formatAge(null/NaN/negative)` is null, never "0s ago".
 *  · The cross-machine badge renders only on an explicit `false`, never on an
 *    absent field.
 *  · The SQUARE marker is square: .mem-row-mark / .mem-project-mark carry a
 *    small radius, and neither is a circle.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · Nothing here measures real rendering, layout or contrast. The browser
 *    pass (both themes, desktop and 768px, zero console errors, zero
 *    horizontal overflow) was run by hand and is not reproducible in Node.
 *  · The <summary> scan sees the markup THESE render functions emit. A
 *    control injected into a summary from some other code path, or built by
 *    string concatenation this suite does not drive, is invisible to it.
 *  · `shared/markdown.js` has its own suite (test-next-markdown.js) which
 *    owns the escape-first invariant. This suite only proves the view ROUTES
 *    untrusted body text through it and escapes everything else itself.
 *  · Headings rendered by the shared renderer are `<div class="chat-md-h">`,
 *    not real `<h*>` elements, so the handoff has no screen-reader outline.
 *    That is a pre-existing property of the shared renderer (recorded in
 *    v3.9.0) and is deliberately not changed from a view file.
 *  · The route's index cost (one journal-tail read per scope/machine pair) is
 *    inherited from listWorkingScopes and is not asserted here.
 *  · §11 drives the revalidation logic against a FAKE fetch and a FAKE clock.
 *    It proves what refreshIndex/refreshScopeList/nextPollDelay/schedulePoll
 *    DO with a given response; it does not prove the BROWSER fires `focus` or
 *    `visibilitychange`. That the listeners are attached and removed, and what
 *    the handler does when it fires, IS now executed (§12) — but against a
 *    fake EventTarget, so the browser half remains a hand-verified claim
 *    (0 fetches over 28 s away from the view).
 *  · renderSidebar / renderMain / wire are DOM-bound and are injected as
 *    spies. §12/§13 prove they are CALLED with the mount token; the markup
 *    they assemble from the render* functions is covered directly in §6/§14,
 *    but the setSidebar/setMain/addEventListener calls themselves are not run.
 *  · §12's "schedulePoll is in the mount half, stopPoll in the teardown half"
 *    is a SOURCE SCAN over the comment-stripped closure, and says so in its own
 *    assertion text. Execution proves each is called once per cycle; only the
 *    scan proves WHICH half it lives in.
 *  · The census records that a function is LIFTED and run, never that its every
 *    branch is covered, and never that a meaningful assertion was made about
 *    what it returned. Its EXECUTED set is hand-maintained; the only mechanical
 *    check on it is that each name really is extracted from live source here.
 *    `renderSidebar`, `renderMain`, `renderNoProjects`, `freshState`,
 *    `loadIndex`, `selectProject` and `wire` are listed as not executed, each
 *    with its reason, rather than being quietly absent.
 *  · refreshScopeList's `!state.scope` early return is defence in depth and
 *    is NOT independently pinned: the membership check below it already
 *    returns for a falsy scope. Said so in the source, and measured.
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Shared source-scanning helpers (scripts/test-source-scan-helpers.js proves
// each one detects the defect it claims to). Used here so a positive scan
// cannot be satisfied by a `//` comment, a file-wide regex cannot be satisfied
// by a line in some OTHER function, and vocabulary is pinned to a literal
// rather than to the constant the production code itself reads.
import { stripComments, functionSource, callSiteCount, assertLiteral } from './test-helpers/source-scan.js';
// The shared text system the view now renders through. IMPORTED, not stubbed
// and not lifted: shared/text.js deliberately takes no imports of its own so
// that it is executable in Node (its header records why), which makes it the
// one shared component this harness can run for real. A stub would let the
// escaping battery below pass over markup the shipped screen never emits.
import {
  renderDescription, renderStatus, renderReadout, renderReadoutGroup,
  renderBadge, renderExplainer,
  // §18h executes the header component itself: `panelWide` is an opt-in on
  // renderViewHeader, and asserting that memory.js PASSES it proves nothing
  // about whether the component honours it.
  renderViewHeader,
} from '../src/public/next/shared/text.js';
// The docs-link table, imported for the same reason: it takes no imports and
// THROWS on an unknown key, so lifting the real one is what proves the About
// panel's link resolves rather than merely that some string was interpolated.
import { docsLinkHtml } from '../src/public/next/shared/docs-links.js';
// The shared section block. Imported for the same reason the text renderers
// are: it imports only shared/text.js, which takes no imports at all, so the
// real component runs in Node — and every one of this page's five sections is
// framed by it since v3.55.0, so a stub would let the escaping battery and the
// placement assertions run past the thing that frames them.
import { renderBlock } from '../src/public/next/shared/block.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NEXT = join(ROOT, 'src/public/next');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

// ── Tempdir domains root ─────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'curator-memview-'));
const DOMAINS = join(TMP, 'domains');
mkdirSync(DOMAINS, { recursive: true });

// Registered so a throw still cleans up. `finally` runs BEFORE process.exit,
// which is the ordering v3.9.1's 37,353 stale temp directories came from.
function cleanup() {
  try {
    // Refuse anything that is not one segment below the OS temp dir.
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

const ws = await import('../src/brain/working-state.js');

await ws.saveProjectBrief('alpha', {
  brief: 'Alpha is the fixture project.',
  decisions: ['Never write from the app.'],
  harness: 'claude-code', model: 'claude-opus-5',
});
await ws.saveWorkingState('alpha', {
  scope: 'feature-x',
  headline: 'First save',
  nowState: 'Everything is fine.',
  nextSteps: ['Keep going.'],
  harness: 'claude-code', model: 'claude-opus-5',
});
await ws.saveWorkingState('alpha', {
  scope: 'feature-y',
  headline: 'Second scope',
  nowState: 'A different scope.',
  harness: 'cursor', model: 'gpt-5',
});
// THE MIRROR'S STATE IS WRITTEN TO DISK DIRECTLY, and it has to be. This was
// `saveWorkingState('shared-cohort', …)`, which the store REFUSES with
// `reason: 'readonly'` — every in-app write surface refuses a Shared Brain
// mirror — so the mirror fixture had no state at all, and every assertion
// about it was passing over an empty tree. It went unnoticed because the
// pre-v3.48.0 index emitted one row per DOMAIN whether or not anything was in
// it, so "the mirror appears in the index like any other project" was true of
// a domain with nothing in it. A mirror's state arrives over SYNC, not through
// a local save, so writing the files is also the honest fixture.
{
  const mdir = join(DOMAINS, 'shared-cohort', 'state', 'main', 'cohort-machine-aa11');
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(mdir, 'current.md'),
    '# Handoff\n\n## Headline\n\nMirror state\n\n## Where things stand\n\nFrom a cohort member.\n');
  writeFileSync(join(mdir, 'journal.jsonl'), JSON.stringify({
    saved_at: new Date().toISOString(), headline: 'Mirror state',
    harness: 'claude-code', model: 'claude-opus-5', kind: 'complete',
  }) + '\n');
}

// A PROJECT THAT EXISTS AND HAS NEVER BEEN SAVED TO. `briefed` carries a
// standing brief and no handoff, which is a real, deliberate configuration —
// somebody wrote the brief before the first agent session — and it is the row
// on which "a fact and its absence stay apart" is asserted below. It replaces
// `blank` in that role: since v3.48.0 the store OMITS a domain's own project
// when it has neither a brief nor a save, so `blank` is no longer a row at all
// and cannot carry an assertion about what a row says.
makeDomain('briefed');
{
  const r = await ws.saveProjectBriefText('briefed', 'briefed',
    '## Standing brief\n\nWritten before the first session.', { authoredBy: { kind: 'human' } });
  if (!r.ok) throw new Error('fixture: brief-only project could not be created: ' + r.message);
}

// A SECOND MACHINE under one scope. Without this the fixture has 2 scopes
// across 2 pairs, so `scopeCount` and the pair count are numerically equal
// and NO assertion could tell them apart — the pairs-vs-work-streams
// regression would pass silently. With it, alpha is 2 scopes / 3 pairs.
{
  const src = join(DOMAINS, 'alpha', 'state', 'feature-x');
  const machine = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory())[0].name;
  const dst = join(src, 'second-machine');
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(join(src, machine))) {
    writeFileSync(join(dst, f), readFileSync(join(src, machine, f)));
  }
}

// ── Recursive fingerprint of the whole domains tree ───────────────────────

function fingerprint(dir) {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(relative(dir, p) + '\u0000' + createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  })(dir);
  return { hash: createHash('sha256').update(files.join('\n')).digest('hex'), count: files.length };
}

// ── Fake req/res over the REAL router ────────────────────────────────────

const routerMod = await import('../src/routes/memory.js');
const router = routerMod.default;

function routesOf(r) {
  return (r.stack || [])
    .filter((l) => l.route)
    .map((l) => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods || {}).filter((m) => l.route.methods[m]),
      handle: l.route.stack[l.route.stack.length - 1].handle,
    }));
}
const ROUTES = routesOf(router);

function findRoute(path) {
  const r = ROUTES.find((x) => x.path === path);
  if (!r) throw new Error('route not found in the real router: ' + path);
  return r;
}

async function call(path, { params = {}, query = {} } = {}) {
  const route = findRoute(path);
  let status = 200;
  let body;
  let settled = false;
  const res = {
    status(c) { status = c; return res; },
    json(b) { body = b; settled = true; return res; },
  };
  await route.handle({ params, query }, res, (e) => { throw e || new Error('next() called'); });
  // Give an un-awaited handler a tick; every handler here is async and awaited,
  // so a false here would be a real regression, not flakiness.
  if (!settled) await new Promise((r) => setImmediate(r));
  return { status, body };
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — The route is registered READ-ONLY');
// ═════════════════════════════════════════════════════════════════════════

// ── THE ROUTE TABLE, AS A TABLE ─────────────────────────────────────────
//
// v3.48.0 gave this router its first write routes, and the old assertion
// here — "exactly 2 routes, all GET" — was the guard that said so. It is
// replaced rather than deleted, and by something STRICTER: the exact set of
// (method, path) pairs, so a new route of any kind has to be declared here
// before it can ship. An extra GET was invisible to the old count-and-verbs
// pair; it is not invisible to this.
const EXPECTED_ROUTES = [
  ['get', '/'],
  ['get', '/:domain/projects'],
  ['post', '/:domain/projects'],
  ['patch', '/:domain/projects/:project'],
  ['delete', '/:domain/projects/:project'],
  ['get', '/:domain/:project'],
  ['get', '/:project'],
];
const actualRoutes = ROUTES.flatMap((r) => r.methods.map((m) => [m, r.path]));
eq('the router registers exactly ' + EXPECTED_ROUTES.length + ' (method, path) pairs',
  actualRoutes.length, EXPECTED_ROUTES.length);
ok('the route table is exactly the declared one',
  JSON.stringify(actualRoutes) === JSON.stringify(EXPECTED_ROUTES),
  JSON.stringify(actualRoutes));

// ── ORDER IS A CORRECTNESS PROPERTY HERE, NOT TIDINESS ──────────────────
//
// A domain slug and a project slug are drawn from the same alphabet, so
// `/:domain/projects` and `/:domain/:project` are both two segments and
// Express matches them in REGISTRATION order. If the parametric one were
// registered first, `GET /api/memory/alpha/projects` would be read as "the
// project called `projects` in domain alpha" and the Domains view's whole
// list endpoint would 404. Asserted as an index comparison over the real
// router's own stack.
const iProjects = actualRoutes.findIndex((r) => r[0] === 'get' && r[1] === '/:domain/projects');
const iDetail = actualRoutes.findIndex((r) => r[0] === 'get' && r[1] === '/:domain/:project');
const iAlias = actualRoutes.findIndex((r) => r[0] === 'get' && r[1] === '/:project');
ok('GET /:domain/projects is registered BEFORE GET /:domain/:project',
  iProjects >= 0 && iDetail >= 0 && iProjects < iDetail, iProjects + ' vs ' + iDetail);
ok('the one-segment deprecated alias is registered LAST of the GETs',
  iAlias === actualRoutes.length - 1, 'index ' + iAlias);

const routeSrc = readFileSync(join(ROOT, 'src/routes/memory.js'), 'utf8');
// ── THE READ ROUTES STILL TOUCH NOTHING, AND THE WRITE ROUTES TOUCH TIER 1
//    ONLY ─────────────────────────────────────────────────────────────────
//
// The class guard is kept and NARROWED rather than dropped. This router may
// not write a byte itself: every mutation goes through the store, which owns
// the path chokepoint, the sanitisers and the caps. So the filesystem and
// wiki-write calls stay forbidden outright...
for (const forbidden of [
  'writeFile(', 'writeFileSync(', 'appendFile(', 'appendFileSync(', 'mkdir(', 'mkdirSync(',
  'rm(', 'rmSync(', 'unlink(', 'writePage(',
]) {
  ok('route source contains no ' + forbidden + ' call', !routeSrc.includes(forbidden));
}
// ...and so does the ONE store function that would reach tier 2 or tier 3.
// This is the assertion that carries the tier boundary: the app writes the
// standing brief and nothing else, and a handoff written from a browser
// would arrive wearing the last agent's provenance line.
ok('route source never calls saveWorkingState( — tiers 2 and 3 stay agent-only',
  !routeSrc.includes('saveWorkingState('));
// The write-registry IS imported now, and deliberately: a project rename
// moves a directory, so it must be refused while this domain has a write in
// flight — the same predicate PUT /api/domains/:domain uses.
ok('route source imports the write-registry, because a rename moves a directory',
  /^import[^;]*write-registry/m.test(routeSrc));

// ═════════════════════════════════════════════════════════════════════════
section('§2 — GET /api/memory (the index)');
// ═════════════════════════════════════════════════════════════════════════

const before = fingerprint(DOMAINS);
const idx = await call('/');
eq('index responds 200', idx.status, 200);
ok('index is ok', idx.body && idx.body.ok === true);
const byName = Object.fromEntries((idx.body.projects || []).map((p) => [p.project, p]));
// ── WHAT IS A ROW, SINCE v3.48.0 ─────────────────────────────────────────
// The store omits a domain's own project when it has NEITHER a brief NOR a
// save, because a row describing an empty tree is noise on a screen whose job
// is "which project". This route defers to that rather than keeping a second
// opinion — one description of "which projects exist", shared with the Domains
// view's Projects list and the menu-bar widget. `blank` is therefore absent,
// and this assertion is the deliberate replacement for "index lists every
// domain, not only those with state", which described v3.17.0-v3.47.
eq('the index lists the projects that HAVE something', Object.keys(byName).length, 3);
ok('...and a domain with neither a brief nor a save is not one of them',
  !byName.blank, JSON.stringify(Object.keys(byName)));
// THE OMISSION IS ONLY SAFE IF THE SERVER SAYS IT LOOKED. An empty index would
// otherwise be indistinguishable from "you have no domains", and the view
// would tell a user with four domains to create a fifth.
eq('...while the server says how many domains it scanned, so an EMPTY index is not ambiguous',
  idx.body.domainsScanned, 4);

// THE PAIRS-vs-WORK-STREAMS DISTINCTION. The fixture is deliberately
// asymmetric — 2 scopes spread over 3 (scope, machine) pairs — so these two
// assertions cannot both pass on a single number. Reporting the pair count as
// "scopes" told the user "3 scopes" for two work-streams, and got worse with
// every machine they synced from.
eq('alpha reports 2 SCOPES (work-streams), not 3 saved copies',
  (byName.alpha || {}).scopeCount, 2);
eq('alpha reports 3 SAVED COPIES (scope x machine pairs) as its own field',
  (byName.alpha || {}).savedCopies, 3);
ok('the fixture really is asymmetric, so the two assertions above cannot collapse',
  (byName.alpha || {}).scopeCount !== (byName.alpha || {}).savedCopies);
ok('alpha reports a standing brief', byName.alpha && byName.alpha.hasBrief === true);
ok('alpha carries a lastWriteAt', typeof (byName.alpha || {}).lastWriteAt === 'string');
ok('alpha carries a headline from the journal', typeof (byName.alpha || {}).headline === 'string');
ok('alpha names the newest scope so the view can open it in ONE request',
  typeof (byName.alpha || {}).newestScope === 'string' && typeof byName.alpha.newestMachine === 'string');

// A fact and its ABSENCE stay apart — the whole point. Asserted on `briefed`,
// a project that EXISTS (it has a standing brief) and has never been saved to.
ok('PRECONDITION: the brief-only project is a row at all', !!byName.briefed,
  JSON.stringify(Object.keys(byName)));
eq('a project with no saves reports scopeCount 0', (byName.briefed || {}).scopeCount, 0);
eq('a project with no saves reports lastWriteAt NULL, never an epoch', (byName.briefed || {}).lastWriteAt, null);
eq('a project with no saves reports ageSeconds NULL, never 0', (byName.briefed || {}).ageSeconds, null);
eq('a project with no saves reports headline NULL', (byName.briefed || {}).headline, null);
// "No state saved yet" and "a brief, no sessions yet" are DIFFERENT facts and
// the row says which: this one HAS a brief.
eq('...and reports its standing brief, which is why it is a row', (byName.briefed || {}).hasBrief, true);
// CONTROL: `alpha` differs on every one of those, so the assertions above are
// about this row rather than about a shape every row happens to have.
ok('CONTROL: a project WITH saves differs on each of them',
  byName.alpha.scopeCount > 0 && typeof byName.alpha.lastWriteAt === 'string'
  && typeof byName.alpha.headline === 'string');

ok('the shared mirror appears in the index like any other project', !!byName['shared-cohort']);
ok('...with the state that arrived over sync really counted, not an empty shell',
  (byName['shared-cohort'] || {}).savedCopies === 1, JSON.stringify(byName['shared-cohort']));

// ═════════════════════════════════════════════════════════════════════════
section('§3 — GET /api/memory/:project (the read)');
// ═════════════════════════════════════════════════════════════════════════

const unscoped = await call('/:project', { params: { project: 'alpha' } });
eq('unscoped read responds 200', unscoped.status, 200);
ok('unscoped read returns the brief', unscoped.body.brief && unscoped.body.brief.present === true);
eq('unscoped read returns scope: null', unscoped.body.scope, null);
eq('the unscoped read returns one index row per PAIR (the store’s own shape)',
  (unscoped.body.scopes || []).length, 3);
eq('unscoped read echoes readonly:false for a normal domain', unscoped.body.readonly, false);

const scoped = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'feature-x' } });
eq('scoped read responds 200', scoped.status, 200);
eq('scoped read reports the scope it read', scoped.body.scope, 'feature-x');
ok('scoped read returns current.md', scoped.body.current && scoped.body.current.present === true);
ok('scoped read still returns the brief (tier 1 is always returned)',
  scoped.body.brief && scoped.body.brief.present === true);
ok('scoped read picks a machine and says which', typeof scoped.body.machine === 'string');
eq('a scope with two machines lists BOTH so the user can switch',
  (scoped.body.machines || []).length, 2);
eq('scoped read reports whether that machine is this one', typeof scoped.body.machineIsThisMachine, 'boolean');
ok('scoped read returns journal entries', scoped.body.journal && scoped.body.journal.returned >= 1);

const mirror = await call('/:project', { params: { project: 'shared-cohort' }, query: { scope: 'main' } });
eq('a read-only mirror can still be READ (only writes are refused elsewhere)', mirror.status, 200);
eq('a read-only mirror echoes readonly:true so the view can say so', mirror.body.readonly, true);

const unknown = await call('/:project', { params: { project: 'not-a-domain' } });
eq('an unknown project is a 404', unknown.status, 404);
ok('the 404 body is ok:false', unknown.body && unknown.body.ok === false);

const traversal = await call('/:project', { params: { project: '../../etc' } });
eq('a traversal-shaped project name is refused as unknown (404)', traversal.status, 404);

// A traversal-shaped scope is SLUGIFIED to a safe segment by the store
// (`slugSegment('../escape')` -> 'escape'), so it resolves to a scope that
// simply does not exist rather than to a path outside state/. Asserted as
// what actually happens, not as what a 400 would have felt tidier.
const escScope = await call('/:project', { params: { project: 'alpha' }, query: { scope: '../escape' } });
eq('a traversal-shaped scope is slugified, not resolved outside state/', escScope.status, 200);
eq('...and reports the SLUGIFIED scope, never the raw input', escScope.body.scope, 'escape');
ok('...and finds nothing under it', escScope.body.current && escScope.body.current.present === false);

// A scope that cannot be slugified at all IS a 400 from the store.
const badScope = await call('/:project', { params: { project: 'alpha' }, query: { scope: '..' } });
eq('an unslugifiable scope is a 400', badScope.status, 400);
ok('the 400 carries the store’s own reason', typeof badScope.body.reason === 'string');
eq('...and names the field that was wrong', badScope.body.reason, 'invalid-scope');

const badMachine = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'feature-x', machine: '.' } });
eq('an unslugifiable machine is a 400', badMachine.status, 400);
eq('...and names the field that was wrong', badMachine.body.reason, 'invalid-machine');

const noSuchScope = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'nope' } });
eq('a scope that does not exist is 200 with an honest message, not an error', noSuchScope.status, 200);
ok('...and reports current.present false', noSuchScope.body.current && noSuchScope.body.current.present === false);

// journalLimit is passed through UN-CLAMPED; the store owns the ceiling.
const bigLimit = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'feature-x', journalLimit: '9999' } });
eq('an absurd journalLimit does not error', bigLimit.status, 200);
ok('...and the STORE clamps it (returned <= its own MAX)',
  bigLimit.body.journal.returned <= ws.MAX_JOURNAL_ENTRIES);
const junkLimit = await call('/:project', { params: { project: 'alpha' }, query: { scope: 'feature-x', journalLimit: 'abc' } });
eq('a non-numeric journalLimit falls back to the store default without erroring', junkLimit.status, 200);

// ═════════════════════════════════════════════════════════════════════════
section('§4 — Driving every endpoint wrote NOTHING');
// ═════════════════════════════════════════════════════════════════════════

const after = fingerprint(DOMAINS);
eq('the domains tree holds the same number of files', after.count, before.count);
eq('the domains tree is byte-identical after every route call', after.hash, before.hash);
ok('the fingerprint is not vacuous (it saw real files)', before.count > 10, 'saw ' + before.count);

// ═════════════════════════════════════════════════════════════════════════
section('§5 — View helpers, lifted from live source and EXECUTED');
// ═════════════════════════════════════════════════════════════════════════

/** Brace-matched extraction of a real function from live source. Throws
 *  loudly on a desync rather than producing a confusing SyntaxError later.
 *  (Same helper as scripts/test-next-loading-gate.js.) */
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out;
}

const viewSrc = readFileSync(join(NEXT, 'views/memory.js'), 'utf8');
// The shared age vocabulary. `freshnessStep` lives here since the freshness
// scale went app-wide; everything else the strip reads is still in the view.
const ageSrc = readFileSync(join(NEXT, 'shared/age.js'), 'utf8');
const viewCss = readFileSync(join(NEXT, 'views/memory.css'), 'utf8');
// The shared listbox's RENDER half. Lifted rather than stubbed, so §6's
// escaping battery runs through the component that actually paints these two
// pickers — a stub would let a hole in the component's own escaping pass here
// while the real screen carries it. It cannot be imported: shared/listbox.js
// imports next/app.js, which touches `document` at module scope.
const listboxSrc = readFileSync(join(NEXT, 'shared/listbox.js'), 'utf8');

// The REAL escapeHtml from app.js — lifted rather than reimplemented, so a
// change there cannot leave this suite testing a copy that no longer matches.
const appSrc = readFileSync(join(NEXT, 'app.js'), 'utf8');
const escapeHtml = new Function(extractFunction(appSrc, 'escapeHtml', 'app.js') + '\nreturn escapeHtml;')();
ok('the real escapeHtml was lifted and works', escapeHtml('<a>') === '&lt;a&gt;');

// The REAL shared markdown renderer, module body eval'd with `icon` stubbed
// (its only import). Not stubbed away: the handoff body genuinely goes
// through it, so the composition must be provable here.
const mdSrc = readFileSync(join(NEXT, 'shared/markdown.js'), 'utf8')
  .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\.\/app\.js';\s*$/m, '')
  .replace(/^export\s+/gm, '');           // module body -> function body
const renderMarkdown = new Function('icon', mdSrc + '\nreturn renderMarkdown;')(() => '<svg></svg>');
ok('the real renderMarkdown was lifted and works',
  renderMarkdown('# Hi').includes('chat-md-h'));

const formatAge = new Function(extractFunction(viewSrc, 'formatAge', 'memory.js') + '\nreturn formatAge;')();
const projectMetaLine = new Function(
  extractFunction(viewSrc, 'formatAge', 'memory.js') + '\n' +
  // projectMetaLine now reads the AGENT'S clock where the store recovered one
  // (effectiveSave), falling back to filesystem mtime. Lifted with it so this
  // executes the shipped function rather than a version missing its collaborator.
  extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
  extractFunction(viewSrc, 'projectMetaLine', 'memory.js') + '\nreturn projectMetaLine;')();
const splitHandoffPreamble = new Function(
  extractFunction(viewSrc, 'splitHandoffPreamble', 'memory.js') + '\nreturn splitHandoffPreamble;')();

// formatAge — absence must never render as a number.
eq('formatAge(null) is null, never "0s ago"', formatAge(null), null);
eq('formatAge(undefined) is null', formatAge(undefined), null);
eq('formatAge(NaN) is null', formatAge(NaN), null);
eq('formatAge(-5) is null', formatAge(-5), null);
eq('formatAge("30") is null (a string is not a measurement)', formatAge('30'), null);
eq('formatAge(0) is "just now"', formatAge(0), 'just now');
eq('formatAge(59) is "just now"', formatAge(59), 'just now');
eq('formatAge(60) is "1 min ago"', formatAge(60), '1 min ago');
eq('formatAge(3600) is "1 hr ago"', formatAge(3600), '1 hr ago');
eq('formatAge(86400) singularises "1 day ago"', formatAge(86400), '1 day ago');
eq('formatAge(172800) pluralises "2 days ago"', formatAge(172800), '2 days ago');
eq('formatAge(7*86400) is "1 week ago"', formatAge(7 * 86400), '1 week ago');
eq('formatAge(400*86400) is "1 year ago"', formatAge(400 * 86400), '1 year ago');
ok('formatAge is monotonic over a decade of samples', (() => {
  let last = -1;
  for (let s = 0; s < 400 * 86400; s += 3607) {
    const v = formatAge(s);
    if (typeof v !== 'string' || !v.length) return false;
    last = s;
  }
  return last > 0;
})());

// projectMetaLine — three DIFFERENT facts, said three different ways.
eq('meta: no state and no brief',
  projectMetaLine({ scopeCount: 0, hasBrief: false, ageSeconds: null }), 'no state saved yet');
eq('meta: a brief but no sessions is its OWN state, not "nothing"',
  projectMetaLine({ scopeCount: 0, hasBrief: true, ageSeconds: null }), 'brief only — no sessions yet');
eq('meta: one scope singularises',
  projectMetaLine({ scopeCount: 1, hasBrief: true, ageSeconds: 60 }), '1 scope · 1 min ago');
eq('meta: several scopes pluralise',
  projectMetaLine({ scopeCount: 3, hasBrief: true, ageSeconds: 3600 }), '3 scopes · 1 hr ago');
eq('meta: a scope count with an UNKNOWN age omits the age rather than inventing one',
  projectMetaLine({ scopeCount: 2, hasBrief: false, ageSeconds: null }), '2 scopes');
eq('meta: a null project is the empty string, not a crash', projectMetaLine(null), '');

// splitHandoffPreamble — must never eat a body line, must never empty a doc.
{
  const doc = '# Working state — x\n\n> The headline\n\n_Machine: m · Saved: t_\n\n## Where things stand\n\nBody text.\n';
  const r = splitHandoffPreamble(doc);
  eq('preamble split recovers the headline', r.headline, 'The headline');
  ok('preamble split drops the doc title', !r.body.includes('# Working state'));
  ok('preamble split drops the provenance line', !r.body.includes('_Machine:'));
  ok('preamble split keeps the first section heading', r.body.startsWith('## Where things stand'));
  ok('preamble split keeps the body', r.body.includes('Body text.'));
}
{
  // A document with no sections at all: strip NOTHING rather than empty it.
  const doc = '# Just a title\n\n> just a headline\n';
  const r = splitHandoffPreamble(doc);
  eq('a document that is ALL preamble is returned unchanged (fail safe)', r.body, doc);
  eq('...and no headline is claimed from it', r.headline, null);
}
{
  const doc = '## Where things stand\n\nStraight into a section.\n';
  const r = splitHandoffPreamble(doc);
  eq('a `## ` section is never mistaken for a doc title', r.body, doc);
  eq('...and no headline is invented', r.headline, null);
}
{
  const doc = '# T\n\n> H\n\n## S\n\nFirst.\n\n> A quote in the BODY\n';
  const r = splitHandoffPreamble(doc);
  ok('a quote later in the body survives', r.body.includes('> A quote in the BODY'));
  eq('only the FIRST leading quote is taken as the headline', r.headline, 'H');
}
eq('splitHandoffPreamble(null) does not throw', splitHandoffPreamble(null).body, '');
eq('splitHandoffPreamble("") does not throw', splitHandoffPreamble('').body, '');
{
  const plain = 'Just some prose with no markdown at all.';
  eq('plain prose is returned untouched', splitHandoffPreamble(plain).body, plain);
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — ESCAPING, through the REAL render functions');
// ═════════════════════════════════════════════════════════════════════════

const XSS = '<img src=x onerror=alert(1)>';
const ATTR = '" onmouseover="alert(1)';

// The v3.48.0 starting brief, lifted off LIVE SOURCE rather than retyped.
// A copy typed here would be a second description of the four headings the
// store renders, free to drift from the one the app actually offers.
const BRIEF_TEMPLATE_SRC = (() => {
  const m = /export const BRIEF_TEMPLATE = (\[[\s\S]*?\]\.join\('\\n'\));/.exec(viewSrc);
  if (!m) throw new Error('BRIEF_TEMPLATE not found in memory.js — the lift below would be a paraphrase');
  return new Function('return (' + m[1] + ');')();
})();

// The brief's byte wall, lifted off LIVE SOURCE for the same reason: it is the
// number `src/routes/memory.js` refuses at, and a copy typed here could drift
// from the one the editor actually shows and the route actually enforces.
const BRIEF_MAX_BYTES_SRC = (() => {
  const m = /const BRIEF_MAX_BYTES = (\d+);/.exec(viewSrc);
  if (!m) throw new Error('BRIEF_MAX_BYTES not found in memory.js — §16g would be a paraphrase');
  return m[1];
})();
// It is the STORE's wall, not a number of this view's choosing, and it is
// compared against the real exported constant rather than against a copy typed
// here. A view refusing at a DIFFERENT figure from the server would either
// block saves the server would accept, or offer saves it would reject with a
// 400 the user cannot act on.
ok('the editor’s byte wall IS the store’s MAX_BRIEF_BYTES, not a number of its own',
  Number(BRIEF_MAX_BYTES_SRC) === ws.MAX_BRIEF_BYTES,
  'memory.js caps the brief at ' + BRIEF_MAX_BYTES_SRC +
  ' bytes; the store refuses at ' + ws.MAX_BRIEF_BYTES);

function makeRenderers(stateObj) {
  // Every collaborator the render functions close over is injected, so this
  // executes the shipped code rather than a paraphrase of it.
  const body =
    extractFunction(viewSrc, 'formatAge', 'memory.js') + '\n' +
    // The freshness surface: renderProject renders renderSaveStatus above
    // everything else, and it reads through these five. Lifted so the escaping
    // battery below covers the strip too — it interpolates a scope name, a
    // machine id and a harness name, all of which arrive from disk.
    extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
    // `freshnessStep` MOVED to shared/age.js when the freshness scale became
    // app-wide (it is now one half of the scale shared/freshness.css paints,
    // rather than this screen's private ladder). Still the REAL shipped
    // function, lifted from its new home — memory.js imports it, so a stub
    // here would be a paraphrase of the thing under test.
    extractFunction(ageSrc, 'freshnessStep', 'shared/age.js') + '\n' +
    extractFunction(viewSrc, 'newestPair', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'harnessOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'firstNote', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'saveLine', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderSaveStatus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'splitHandoffPreamble', 'memory.js') + '\n' +
    // ── THE PICKERS BECAME A TABLE (v3.55.0) ───────────────────────────────
    // `renderScopeControls` is gone with the two listboxes it built. What
    // replaces it is `renderWorkStreams` — one ROW per (scope, machine) pair,
    // newest first, the row a button — plus `workStreamCounts` under it and
    // `newerOnAnotherMachine`, the menubar widget's "another computer saved
    // after this one" reading, which renderSaveStatus now calls.
    //
    // `freshnessTier` travels with them: the table's dots are cut on the same
    // scale as the strip's pip, by NAME rather than by step, and lifting the
    // real one keeps that a property of the shipped code rather than of a stub.
    // `freshnessTier` reads a module-level table in shared/age.js, so the
    // table travels with it — lifted off LIVE SOURCE rather than retyped, for
    // the same reason BRIEF_TEMPLATE is: a copy here would be a second
    // description of the scale, free to drift from the one shared/freshness.css
    // paints.
    (() => {
      const m = /const TIER_BY_STEP = (\[[^\]]*\]);/.exec(ageSrc);
      if (!m) throw new Error('TIER_BY_STEP not found in shared/age.js — freshnessTier would be a paraphrase');
      return 'const TIER_BY_STEP = ' + m[1] + ';';
    })() + '\n' +
    extractFunction(ageSrc, 'freshnessTier', 'shared/age.js') + '\n' +
    extractFunction(viewSrc, 'newerOnAnotherMachine', 'memory.js') + '\n' +
    // The table's ROW ORDER is a function, and it is lifted rather than
    // inlined for the same reason the tier ladder is: the order and the age
    // words must be one reading, and a copy here could agree with the words
    // while the shipped one disagreed.
    extractFunction(viewSrc, 'workStreamOrder', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderWorkStreams', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'workStreamCounts', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderHandoff', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderJournal', 'memory.js') + '\n' +
    // The v3.48.0 brief editor. Lifted WITH renderBrief, because renderBrief
    // calls it in both of its branches — a stub would leave §6's escaping
    // battery running past the one control on this screen that writes.
    'const BRIEF_TEMPLATE = ' + JSON.stringify(BRIEF_TEMPLATE_SRC) + ';\n' +
    // v3.55.0: the editor gained a byte/word readout and an Escape decision,
    // and both are real functions rather than inline branches so they can be
    // driven directly (§16g). `BRIEF_MAX_BYTES` is the route's own wall and is
    // injected as the literal, for the same reason BRIEF_TEMPLATE is.
    'const BRIEF_MAX_BYTES = ' + BRIEF_MAX_BYTES_SRC + ';\n' +
    extractFunction(viewSrc, 'briefStats', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'briefDismissDecision', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderBriefEditor', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderBrief', 'memory.js') + '\n' +
    // The rail's grouping renderer, so §14's grouping assertions and §6's
    // escaping battery both drive the shipped one.
    extractFunction(viewSrc, 'projectMetaLine', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderProjectGroups', 'memory.js') + '\n' +
    // `renderAbout` is GONE. Its words are the header's ⓘ panel now
    // (aboutInfoHtml, passed to renderViewHeader as `info`), so what is lifted
    // here is the function that composes them. It is lifted rather than
    // dropped because the escaping battery below still has to cover it: it is
    // the one string on this page that opts into raw HTML.
    extractFunction(viewSrc, 'aboutInfoHtml', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderEmptyProject', 'memory.js') + '\n' +
    // The five that used to be lifted by NOBODY. renderStaleNotice in
    // particular had no assertion of any kind: replacing its body with
    // `return '';` deleted the Reload offer — the v3.17.3 headline — and left
    // this suite fully green. renderProject is lifted with it so the offer is
    // proven to REACH the page rather than merely to exist.
    extractFunction(viewSrc, 'renderStaleNotice', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'unlistedCount', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderUnlistedNote', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderBriefOnlyNotice', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderCopyOutcome', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderProject', 'memory.js') + '\n' +
    // THE LISTBOX COMPONENT IS NO LONGER LIFTED. memory.js stopped importing
    // it in v3.55.0 (scripts/test-next-listbox.js §5b asserts that in both
    // directions), so lifting its render path here would be this suite
    // exercising a component the view under test does not use. The escaping
    // battery below lost nothing: every string the pickers interpolated — a
    // scope name, a machine id, a harness — is now interpolated by
    // `renderWorkStreams`, which IS lifted.
    'return { renderWorkStreams, workStreamCounts, newerOnAnotherMachine, workStreamOrder, ' +
    'renderHandoff, renderJournal, renderBrief, aboutInfoHtml, ' +
    'renderEmptyProject, renderStaleNotice, renderUnlistedNote, renderBriefOnlyNotice, ' +
    'unlistedCount, renderProject, renderSaveStatus, freshnessStep, freshnessTier, ' +
    'effectiveSave, briefStats, briefDismissDecision, ' +
    'renderBriefEditor, renderProjectGroups };';
  return new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'gatedLoader', 'loadGate',
    'JOURNAL_PAGE', 'JOURNAL_MORE', 'renderBlock',
    // The real shared text renderers, so §6's escaping battery runs through
    // the component that actually paints these sentences rather than past it.
    'renderDescription', 'renderStatus', 'renderReadout', 'renderReadoutGroup',
    'renderBadge', 'renderExplainer',
    // The REAL docs-link helper, imported rather than stubbed: aboutInfoHtml
    // ends with one, and a stub would let §6's escaping battery run past the
    // only <a> this page emits.
    'docsLinkHtml', body)(
    stateObj, escapeHtml, () => '<svg></svg>', renderMarkdown, () => '<div class="loader"></div>', null, 10, 50,
    // The REAL shared block, imported rather than stubbed: renderProject
    // composes all five of this page's sections through it, so a stub would
    // let §6's escaping battery and §14's placement assertions run past the
    // component that actually frames every one of them.
    renderBlock,
    renderDescription, renderStatus, renderReadout, renderReadoutGroup, renderBadge, renderExplainer,
    docsLinkHtml);
}

const hostileDetail = {
  scope: XSS,
  machine: ATTR,
  machineIsThisMachine: false,
  readonly: false,
  machines: [
    { machine: ATTR, ageSeconds: 60 },
    { machine: XSS, ageSeconds: 120 },
  ],
  current: {
    present: true,
    text: '# T\n\n> ' + XSS + '\n\n## Where things stand\n\n' + XSS + '\n',
    savedAt: '2026-08-28T10:00:00.000Z',
    truncated: true,
    sanitisedOnRead: true,
  },
  journal: {
    returned: 2,
    total: 9,
    totalUnknown: false,
    entries: [
      { at: '2026-08-28T10:00:00.000Z', harness: XSS, model: ATTR, headline: XSS, rejections: [XSS] },
      { at: null, harness: null, model: null, headline: null, rejections: [] },
    ],
  },
};

const hostileState = {
  activeProject: XSS,
  scope: XSS,
  machine: ATTR,
  detail: hostileDetail,
  detailLoading: false,
  journalLimit: 10,
  projectRead: {
    scopesTruncated: true,
    scopeCount: 99,
    brief: { present: true, text: '# B\n\n_Updated: t_\n\n## Standing brief\n\n' + XSS, updatedAt: '2026-08-28T09:00:00.000Z', truncated: true },
  },
};

const R = makeRenderers(hostileState);
const html = [
  R.renderWorkStreams([{ scope: XSS, machine: XSS, headline: XSS, harness: XSS, model: XSS,
    writtenAgeSeconds: 120, writtenAt: '2026-08-28T09:00:00.000Z' },
  { scope: 'other', machine: 'boxb', headline: 'ok', writtenAgeSeconds: 900 }], hostileDetail),
  R.renderHandoff(),
  R.renderJournal(),
  R.renderBrief(hostileState.projectRead),
  R.aboutInfoHtml(),
  R.renderEmptyProject(),
].join('\n');

ok('the hostile fixture actually produced markup (not an empty string)', html.length > 800, 'len ' + html.length);
ok('no raw <img ... onerror survives anywhere in the rendered output',
  !/<img\s/i.test(html), 'found a raw <img> tag');

/**
 * Event handlers must be looked for INSIDE TAGS, not in the whole string.
 * `&lt;img src=x onerror=alert(1)&gt;` is correctly escaped inert TEXT and
 * still contains the characters " onerror=", so a whole-string scan reports
 * a leak on output that is provably safe. (It did, on the first run — the
 * same false-positive shape v3.13.0 recorded for an XSS check that walked
 * straight through `&gt;`.) Only markup the browser will parse as a tag can
 * carry a live handler.
 */
function handlersInTags(markup) {
  const hits = [];
  for (const tag of markup.match(/<[^>]*>/g) || []) {
    // Strip QUOTED ATTRIBUTE VALUES before looking for a handler. A handler
    // only runs if it is a real attribute — i.e. outside every quoted value.
    // `<option value="&quot; onmouseover=&quot;alert(1)">` is ONE attribute
    // holding inert text: `&quot;` is an entity and does NOT terminate the
    // value, which is precisely what proves the escaping worked. Scanning the
    // raw tag flagged both of this suite's hostile fixtures as leaks while
    // they were, in fact, correctly escaped.
    const bare = tag.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    if (/\son[a-z]+\s*=/i.test(bare)) hits.push(tag);
  }
  return hits;
}
ok('no live event handler appears inside any emitted TAG',
  handlersInTags(html).length === 0, JSON.stringify(handlersInTags(html).slice(0, 2)));
// Positive control: the detector must be able to see a real one, or the
// assertion above is decorative.
ok('self-test: the tag scan detects a planted live handler',
  handlersInTags('<span onerror="alert(1)">x</span>').length === 1);
ok('self-test: the tag scan does NOT fire on correctly-escaped text',
  handlersInTags('&lt;img src=x onerror=alert(1)&gt;').length === 0);
ok('self-test: the tag scan does NOT fire on a handler INSIDE a quoted value',
  handlersInTags('<option value="&quot; onmouseover=&quot;alert(1)">x</option>').length === 0);
// The case that matters: a value that really DID break out of its quotes.
ok('self-test: the tag scan DOES fire on a genuine attribute breakout',
  handlersInTags('<option value="a" onmouseover="alert(1)">x</option>').length === 1);
ok('the hostile scope name appears ESCAPED', html.includes('&lt;img src=x onerror=alert(1)&gt;'));
ok('the attribute-breakout string appears ESCAPED (&quot;)', html.includes('&quot; onmouseover='));
ok('every attribute value in the output is balanced', (() => {
  // A crude but effective breakout detector: no tag may contain an odd
  // number of quote characters.
  for (const tag of html.match(/<[^>]*>/g) || []) {
    if (((tag.match(/"/g) || []).length) % 2 !== 0) return false;
  }
  return true;
})(), 'an emitted tag has an unbalanced quote');

// The body text goes through the shared renderer — proven end to end here,
// not asserted by reading the source.
ok('the handoff BODY is rendered through the shared markdown renderer (escape-first)',
  R.renderHandoff().includes('chat-md-h'));
ok('the brief BODY is rendered through the shared markdown renderer',
  R.renderBrief(hostileState.projectRead).includes('chat-md-h'));

// ── CROSS-MACHINE: POSITIVE EVIDENCE ONLY, AND IT MOVED HOUSE ─────────────
// It was a `from <machine>` badge beside the machine picker. The picker is
// gone; the FACT is not, and it is the same rule — rendered ONLY on an
// explicit `false`, never on an absent field. It is now a line in the save
// strip, which is also where it stopped being reachable by hover only.
const mineNote = /local paths and processes may differ/;
ok('an explicit machineIsThisMachine:false says the handoff was written elsewhere',
  mineNote.test(R.renderSaveStatus(hostileState.projectRead, hostileDetail)));
{
  const absent = makeRenderers(hostileState);
  ok('an ABSENT machineIsThisMachine says NOTHING (a fact is not its absence)',
    !mineNote.test(absent.renderSaveStatus(hostileState.projectRead,
      { ...hostileDetail, machineIsThisMachine: undefined })));
}
{
  const same = makeRenderers(hostileState);
  ok('machineIsThisMachine:true says nothing either',
    !mineNote.test(same.renderSaveStatus(hostileState.projectRead,
      { ...hostileDetail, machineIsThisMachine: true })));
}
// ...and the TABLE marks "this machine" under the same rule, for the one row
// the scoped read actually resolved and for no other.
{
  const rows = [{ scope: 'a', machine: 'boxa', writtenAgeSeconds: 60 },
    { scope: 'b', machine: 'boxb', writtenAgeSeconds: 60 }];
  ok('the table marks THIS machine only on an explicit machineIsThisMachine:true',
    R.renderWorkStreams(rows, { machine: 'boxa', machineIsThisMachine: true })
      .includes('mem-ws-mine'));
  ok('...and marks nothing when the response did not say',
    !R.renderWorkStreams(rows, { machine: 'boxa' }).includes('mem-ws-mine'));
  ok('...and marks nothing when it said false',
    !R.renderWorkStreams(rows, { machine: 'boxa', machineIsThisMachine: false })
      .includes('mem-ws-mine'));
}

// Truncation / unknown-total honesty.
ok('a truncated handoff renders a note saying so', R.renderHandoff().includes('mem-note'));
ok('read-side sanitisation is stated, not hidden',
  R.renderHandoff().toLowerCase().includes('neutralised'));
{
  const unknownTotal = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, journal: { ...hostileDetail.journal, total: null, totalUnknown: true, totalUnknownReason: 'journal is huge' } },
  });
  const j = unknownTotal.renderJournal();
  ok('an unknown journal total says the count is UNKNOWN', j.includes('unknown'));
  ok('...and does NOT print the tail length as if it were the total', !/of 2\b/.test(j));
}
{
  // THE COUNT IS AN INSTRUMENT NOW, not a sentence: the journal foot renders a
  // shared/text.js .tx-readout ("Save recorded" / "1") instead of the prose
  // "1 save recorded". The PROPERTY under test is unchanged and is the one
  // that matters — a count of one must not say "saves" — so it is asserted
  // against the shipped markup rather than against a phrase nothing emits.
  //
  // STRENGTHENED, not relaxed, in both directions: the singular case now pins
  // the figure as well as the wording, and the plural case is covered for the
  // first time. Reverting the view to a hardcoded 'Saves recorded' label reds
  // the first of these; dropping the count reds the second.
  const single = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, journal: { returned: 1, total: 1, totalUnknown: false, entries: [hostileDetail.journal.entries[1]] } },
  });
  const one = single.renderJournal();
  ok('one save singularises (readout label "Save recorded", never "Saves")',
    one.includes('>Save recorded<') && !one.includes('>Saves recorded<'), one.slice(-400));
  ok('...and the figure itself is rendered as the readout VALUE',
    /class="tx-readout-value">1</.test(one), one.slice(-400));

  const plural = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, journal: { returned: 3, total: 3, totalUnknown: false, entries: [hostileDetail.journal.entries[1]] } },
  });
  const many3 = plural.renderJournal();
  ok('three saves pluralise ("Saves recorded")', many3.includes('>Saves recorded<'), many3.slice(-400));
  ok('...with the figure as the value', /class="tx-readout-value">3</.test(many3), many3.slice(-400));
}

// Single-option controls collapse to a static label rather than a dropdown.
// ── §6b — THE WORK-STREAM TABLE, DRIVEN ─────────────────────────────────
// It replaced the two pickers in v3.55.0, and with them the "one option
// collapses to a label" pair of assertions that used to sit here: a table has
// no such state, one row is a table with one row. What replaces them is the
// property a table has and a dropdown did not — that every pair the store
// returned is ON SCREEN, in the order the store returned it, with its own
// freshness mark.
{
  const nowMs = Date.now();
  const at = (secs) => new Date(nowMs - secs * 1000).toISOString();
  // Four pairs, THREE scopes, one of them duplicated across machines, with
  // four distinct ages including one that is unknown.
  //
  // THE FIXTURE'S ORDER IS DELIBERATELY NOT ALPHABETICAL, so the order
  // assertion below can tell a real ordering from "any order".
  //
  // Here the two clocks AGREE — every row's `writtenAt` ranks it exactly as its
  // arrival would — so the store's order and the table's are the same list, and
  // this fixture says nothing about which of them is being followed. §6c is the
  // fixture that separates them, and it is the one that fails when the table
  // ranks by the file clock while its cells read the agent's.
  const rows = [
    { scope: 'side-quest', machine: 'boxa', headline: '<img src=x onerror=alert(1)>',
      harness: 'opencode', writtenAgeSeconds: 30, writtenAt: at(30) },
    { scope: 'main', machine: 'boxa', headline: 'Ship the table', harness: 'claude-code',
      model: 'opus-5', writtenAgeSeconds: 120, writtenAt: at(120) },
    { scope: 'main', machine: 'boxb', headline: 'Same stream, other laptop', harness: 'opencode',
      writtenAgeSeconds: 7200, writtenAt: at(7200) },
    { scope: 'archive', machine: 'boxa', headline: 'No clock on this one' },
  ];
  const T = makeRenderers(hostileState);
  const out = T.renderWorkStreams(rows, { scope: 'main', machine: 'boxb' });
  const trs = out.match(/<tr class="mem-ws-row/g) || [];
  eq('every (scope, machine) pair is a row — a duplicated scope is TWO rows', trs.length, 4);

  // ORDER: newest first, and the row with no clock at all is last.
  const order = [...out.matchAll(/data-mem-scope="([^"]*)" data-mem-machine="([^"]*)"/g)]
    .map((m) => m[1] + '/' + m[2]);
  eq('the rows are newest first, with the unknown age last',
    order.join(','), 'side-quest/boxa,main/boxa,main/boxb,archive/boxa');
  ok('CONTROL: that order is NOT alphabetical, so the assertion above can tell '
    + 'a real ordering from an incidental one',
    order.join(',') !== order.slice().sort().join(','), order.join(','));

  // THE DOT'S TIER IS RE-DERIVED INDEPENDENTLY, not read back off the markup.
  const tiers = [...out.matchAll(/class="fresh-dot fresh-([a-z]+)"/g)].map((m) => m[1]);
  const want = rows.map((r) => T.freshnessTier(T.effectiveSave(r).seconds));
  eq('each row\'s dot wears the tier freshnessTier independently computes',
    tiers.join(','), want.join(','));
  ok('...and those tiers are not all the same value, so the check is not vacuous',
    new Set(want).size >= 3, want.join(','));

  // THE HEADLINE IS ESCAPED. It comes off disk and can arrive over sync from
  // another person inside a shared mirror.
  ok('a hostile headline is escaped, never emitted as markup',
    out.includes('&lt;img src=x onerror=alert(1)&gt;') && !out.includes('<img '));

  // THE AGE CELL CARRIES THE CLOCK'S HOOK, and only where there is an age.
  const hooks = (out.match(/data-mem-age-at="/g) || []).length;
  eq('the three rows with a resolved stamp carry data-mem-age-at', hooks, 3);
  ok('...and the row with no age carries none, so the clock has nothing to freeze',
    out.includes('>unknown<'));
  ok('the words the clock rewrites sit in a named span, never the cell itself',
    (out.match(/class="mem-age-words"/g) || []).length === 4);

  // NO TOOLTIPS. The exact stamp is visible-to-AT text instead.
  ok('the table emits no title= at all — the stamp rides in a visually-hidden span',
    !/title="/.test(out) && out.includes('class="visually-hidden"'));

  // THE OPEN PAIR IS MARKED, and only that pair.
  eq('exactly one row is marked open', (out.match(/mem-ws-row-open/g) || []).length, 1);
  ok('...and it is the pair the scoped read resolved, not merely the first row',
    /<tr class="mem-ws-row mem-ws-row-open"[^>]*>[\s\S]*?data-mem-machine="boxb"/.test(out));
  eq('the open row is the one that carries the focus id', (out.match(/id="mem-ws-active"/g) || []).length, 1);

  // A ROW IS A CONTROL.
  eq('every row\'s first cell is a real button', (out.match(/<button type="button" class="mem-ws-open"/g) || []).length, 4);
  ok('and the view emits no <select anywhere, in markup or in a comment',
    !viewSrc.includes('<select'));

  // THE COUNTS ARE THE STORE'S, NEVER THE ROW COUNT.
  const counts = T.workStreamCounts({ savedCopies: 9, distinctScopeCount: 4, scopesTruncated: true }, 3);
  ok('the count line reports the store\'s uncapped totals, not the rows shown',
    counts.includes('4 work-streams') && counts.includes('9 saved copies'), counts);
  ok('...and says so when the list was capped', counts.includes('showing the 3 most recently saved'), counts);
  ok('an empty list renders no table at all', T.renderWorkStreams([], null) === '');
}

// ── §6c — THE ORDER IS THE CLOCK THE ROW SHOWS ──────────────────────
//
// THE DEFECT. The table said "newest first" and rendered `projectRead.scopes`
// in the STORE's order, which `listWorkingScopes` sorts by `mtimeMs` — the
// FILE clock. Every cell of that same row displays `effectiveSave(s)`, which
// prefers the AGENT's clock (`writtenAt`). The two clocks agree only on a
// machine that has never synced and never copied a folder: a checkout rewrites
// mtime, so on a real two-machine setup a handoff saved four hours ago sat
// UNDER rows a fortnight old, each correctly labelled with its own age. v3.55.0
// kept the freshness dot and the age words in lockstep on `effectiveSave`; the
// ORDER was left on the other clock, so one row could be marked fresh, worded
// fresh, and ranked stale at the same time.
//
// THE FIXTURE MAKES THE TWO CLOCKS DISAGREE ON PURPOSE, and it is the reverse
// case rather than a merely different one: the four rows carrying both clocks
// rank EXACTLY BACKWARDS by mtime against `writtenAt`, so an implementation
// reading either clock produces a defensible-looking list and only one of them
// matches the ages printed in the cells. The fixture is handed over in the
// STORE's order — mtime, newest first — because that is what the route returns.
{
  const day = 86400;
  // `writtenAgeSeconds` is the agent's clock; `lastWriteAt` is the file's, and
  // `effectiveSave` reads it only when no agent time exists at all.
  const fileAgo = (secs) => new Date(Date.now() - secs * 1000).toISOString();
  const rows = [
    // Given in mtime order, newest arrival first — the order the store returns.
    { scope: 'e-file-only', machine: 'boxa', headline: 'no journal time at all',
      lastWriteAt: fileAgo(2 * 3600) },
    { scope: 'd-agent-oldest', machine: 'boxa', headline: 'arrived last night',
      writtenAgeSeconds: 10 * day, lastWriteAt: fileAgo(1 * day) },
    { scope: 'c-agent-third', machine: 'boxa', headline: 'pulled five days ago',
      writtenAgeSeconds: 3 * day, lastWriteAt: fileAgo(5 * day) },
    { scope: 'b-agent-second', machine: 'boxa', headline: 'pulled ten days ago',
      writtenAgeSeconds: 3600, lastWriteAt: fileAgo(10 * day) },
    { scope: 'a-agent-newest', machine: 'boxa', headline: 'saved a minute ago',
      writtenAgeSeconds: 60, lastWriteAt: fileAgo(14 * day) },
    { scope: 'f-no-clock', machine: 'boxa', headline: 'neither clock resolves' },
  ];
  // Captured BEFORE anything renders: if the sort were done in place, a
  // snapshot taken afterwards would already be the sorted list and the
  // non-mutation assertion at the end would be vacuous.
  const given = rows.map((r) => r.scope);
  const T = makeRenderers(hostileState);
  // The OPEN pair is `d-agent-oldest`, which the fix moves from the second row
  // to the second-to-last: the mark has to travel with the row.
  const out = T.renderWorkStreams(rows, { scope: 'd-agent-oldest', machine: 'boxa' });
  const order = [...out.matchAll(/data-mem-scope="([^"]*)" data-mem-machine="([^"]*)"/g)]
    .map((m) => m[1]);

  eq('the rows follow the AGENT\'s clock — the one each cell displays — youngest first',
    order.join(','),
    'a-agent-newest,b-agent-second,e-file-only,c-agent-third,d-agent-oldest,f-no-clock');

  // THE THREE THINGS THAT ORDER IS NOT, each spelled out so a mutation cannot
  // satisfy the assertion above by accident.
  ok('CONTROL: that is NOT the order the store handed over (mtime, newest first)',
    order.join(',') !== given.join(','), order.join(','));
  ok('CONTROL: nor is it the reverse of the store\'s order, which the reversed '
    + 'fixture would otherwise make indistinguishable',
    order.join(',') !== given.slice().reverse().join(','), order.join(','));
  ok('CONTROL: nor is it alphabetical — `e-file-only` sorts third by its clock, '
    + 'not fifth by its name',
    order.join(',') !== order.slice().sort().join(','), order.join(','));
  ok('CONTROL: the four rows carrying BOTH clocks rank exactly backwards by '
    + 'mtime against writtenAt, so reading either clock gives a plausible list',
    (() => {
      const both = rows.filter((r) => r.writtenAgeSeconds !== undefined && r.lastWriteAt);
      const byAgent = both.slice().sort((a, b) => a.writtenAgeSeconds - b.writtenAgeSeconds)
        .map((r) => r.scope);
      const byFile = both.slice().sort((a, b) => Date.parse(b.lastWriteAt) - Date.parse(a.lastWriteAt))
        .map((r) => r.scope);
      return byAgent.join(',') === byFile.slice().reverse().join(',') && both.length === 4;
    })());

  // A ROW THAT FELL BACK TO THE FILE CLOCK IS RANKED BY WHAT IT SHOWS. It has
  // no agent time, so its arrival IS its reading, and it takes its place among
  // the others rather than being pushed to either end.
  eq('the file-clock-only row is ranked by the reading it displays', order[2], 'e-file-only');
  ok('...and it says so in its own provenance text, as the two-clock rule requires',
    /e-file-only[\s\S]*?file time/.test(out));

  // NO READING IS NOT A READING OF ZERO. `effectiveSave` returns null when it
  // can resolve neither clock — an ABSENCE, not an age — so the row goes last,
  // never to the head of a list whose promise is "newest first".
  eq('the row with no resolvable clock sorts LAST', order[order.length - 1], 'f-no-clock');
  ok('...and it is still SHOWN, reading "unknown" rather than being dropped',
    out.includes('>unknown<') && (out.match(/<tr class="mem-ws-row/g) || []).length === 6);

  // THE OPEN PAIR TRAVELS WITH ITS ROW.
  eq('exactly one row is marked open', (out.match(/mem-ws-row-open/g) || []).length, 1);
  ok('...and it is the open pair wherever the order put it, not the row at its '
    + 'old index',
    /<tr class="mem-ws-row mem-ws-row-open"[^>]*>[\s\S]*?data-mem-scope="d-agent-oldest"/.test(out));
  eq('the open row still carries the focus id', (out.match(/id="mem-ws-active"/g) || []).length, 1);

  // THE ORDER IS TOTAL AND THE INPUT IS UNTOUCHED.
  const tied = [
    { scope: 'zulu', machine: 'boxb', writtenAgeSeconds: 300 },
    { scope: 'alpha', machine: 'boxb', writtenAgeSeconds: 300 },
    { scope: 'alpha', machine: 'boxa', writtenAgeSeconds: 300 },
    { scope: 'nope', machine: 'boxa' },
    { scope: 'also-nope', machine: 'boxb' },
  ];
  eq('rows at the SAME age break on scope then machine, so the order is total',
    T.workStreamOrder(tied).map((r) => r.scope + '/' + r.machine).join(','),
    'alpha/boxa,alpha/boxb,zulu/boxb,also-nope/boxb,nope/boxa');
  ok('...and two calls agree, so a poll cannot shuffle rows under the pointer',
    T.workStreamOrder(tied).map((r) => r.scope).join(',')
    === T.workStreamOrder(tied).map((r) => r.scope).join(','));
  eq('the response array is NOT sorted in place — `scopes[0]` still resolves to '
    + 'the pair the route\'s own scope=latest would',
    rows.map((r) => r.scope).join(','), given.join(','));
  ok('an empty list still renders no table at all', T.renderWorkStreams([], null) === '');
}

// ── §6d — A RE-ORDER IS A REPAINT, AND ONLY THEN ─────────────────────
//
// The other half of the same defect. `screenSignature` is the no-op guard: the
// pane repaints iff the mark moves, so a mark taken over the RESPONSE while the
// table paints a SORTED copy describes an arrangement that is not on screen.
// Two saves in the same age band crossing each other move every row and no cell
// — which is exactly the case a projection off `pr.scopes` cannot see.
{
  const sigOf = (st) => new Function('state',
    ['formatAge', 'effectiveSave', 'workStreamOrder', 'newestPair', 'projectMetaLine',
      'screenSignature'].map((n) => extractFunction(viewSrc, n, 'memory.js')).join('\n')
    + '\nreturn screenSignature();')(st);

  // A third row is strictly the newest in both states, so `newestPair` — which
  // reads the raw response and is folded in separately — CANNOT be what moves
  // the mark. Without it this assertion would pass on the strip's reading alone
  // and prove nothing about the table.
  const pinned = { scope: 'aaa-pinned', machine: 'boxa', headline: 'newest either way',
    harness: 'claude-code', writtenAgeSeconds: 60, lastWriteAt: '2026-09-01T00:00:00.000Z' };
  // 7200 s and 7800 s both render "2 hr ago", so swapping them changes no cell
  // in either row — only which of the two comes first.
  const st = (xAge, yAge) => ({
    activeProject: 'proj', staleWrite: false, indexError: null,
    scope: 'x', machine: 'boxa', projects: [],
    projectRead: { scopes: [
      pinned,
      { scope: 'x', machine: 'boxa', headline: 'same words either way', harness: 'opencode',
        writtenAgeSeconds: xAge, lastWriteAt: '2026-09-02T00:00:00.000Z' },
      { scope: 'y', machine: 'boxa', headline: 'same words either way', harness: 'opencode',
        writtenAgeSeconds: yAge, lastWriteAt: '2026-09-03T00:00:00.000Z' },
    ] },
    detail: null,
  });

  ok('SETUP: the two rows that swap read the SAME age words in both states, so '
    + 'no cell\'s content can be what moves the mark',
    new Function(extractFunction(viewSrc, 'formatAge', 'memory.js')
      + '\nreturn formatAge(7200) === formatAge(7800) && formatAge(7200) === "2 hr ago";')());
  ok('two rows swapping their AGENT clocks repaints, with every mtime and every '
    + 'rendered cell unchanged — the re-order IS the change on screen',
    sigOf(st(7200, 7800)) !== sigOf(st(7800, 7200)));
  ok('CONTROL: an identical state still produces an identical mark, so this is '
    + 'not a signature that simply always differs',
    sigOf(st(7200, 7800)) === sigOf(st(7200, 7800)));
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — The <summary> hazard, over rendered OUTPUT');
// ═════════════════════════════════════════════════════════════════════════

function summariesIn(markup) {
  const out = [];
  const re = /<summary\b[^>]*>([\s\S]*?)<\/summary>/gi;
  let m;
  while ((m = re.exec(markup)) !== null) out.push(m[1]);
  return out;
}

const allSummaries = summariesIn(html);
// TWO, not three, since v3.55.0. The standing brief stopped being a <details>
// when it became a block with a pencil beside its title, so the page's folds
// are the handoff and the journal. The floor is lowered rather than deleted —
// it exists so the scan below cannot pass over a page that rendered NO
// summaries at all — and the block directly under it pins which two they are,
// so a third fold reappearing or one of these two vanishing is still caught.
ok('the fixture rendered at least 2 <summary> elements (the scan is not vacuous)',
  allSummaries.length >= 2, 'found ' + allSummaries.length);
{
  const folds = (html.match(/data-mem-fold="([a-z]+)"/g) || []).sort().join(',');
  ok('...and the two folds are the handoff and the journal, by name',
    folds === 'data-mem-fold="handoff",data-mem-fold="journal"', folds);
  // Over COMMENT-STRIPPED source on the second half: this file's history
  // records a mutation that a comment satisfied, and memory.js's wire() names
  // the retired attribute in prose while explaining why it is gone.
  ok('THE BRIEF IS NOT A FOLD: a pencil inside a <summary> would toggle its own '
    + 'section, and the fix is that there is no summary to put it in',
    !html.includes('data-mem-fold="brief"')
    && !stripComments(viewSrc).includes('data-mem-fold="brief"'));
}
for (const control of ['<button', '<select', '<input', '<textarea', '<a ']) {
  ok('no ' + control + '> appears inside any rendered <summary>',
    allSummaries.every((s) => !s.toLowerCase().includes(control)),
    'a control inside a <summary> toggles its own section (v3.0.1-beta.18)');
}
// Positive control: the detector must be able to SEE a control in a summary.
ok('self-test: the summary scan detects a planted control',
  summariesIn('<summary><button>x</button></summary>').some((s) => s.includes('<button')));

// The journal's "Show more" button exists and is NOT in the summary.
{
  const j = makeRenderers({
    ...hostileState,
    journalLimit: 10,
    detail: { ...hostileDetail, journal: { ...hostileDetail.journal, total: 40 } },
  }).renderJournal();
  ok('the journal offers a "Show more" control when more entries exist', j.includes('mem-journal-more'));
  ok('...and that control is NOT inside the <summary>',
    summariesIn(j).every((s) => !s.includes('mem-journal-more')));
}

// ═════════════════════════════════════════════════════════════════════════
section('§7b — The journal label may never claim loss that did not happen');
// ═════════════════════════════════════════════════════════════════════════
// SHIPPED, and seen in a browser: the journal rendered
//   "N field(s) rejected by the sanitiser: ..."
// over notes where NOTHING was rejected. The commonest note by far is an
// observation saved without a time — the save time was filled in AND
// disclosed, which is the store working correctly. A user reading that label
// concludes their data was thrown away.
//
// The store already bans loss vocabulary from any note that is not a loss,
// as a class over every note it emits (scripts/test-working-state.js). The
// UI's own label is NOT one of those notes and was NOT covered by that
// invariant — which is exactly how a word meaning "discarded" survived on the
// one surface a human reads. This section mirrors the store's invariant over
// the RENDERED OUTPUT, so the gap cannot reopen.
//
// The note strings are produced by the REAL store, not typed here. A fixture
// of hand-written notes would test this suite's idea of what the store says;
// only real notes prove the two layers still agree.
const LOSS_WORDS = /\b(dropped|omitted|truncated|rejected|discarded|lost)\b/i;

const journalOf = (notes) => makeRenderers({
  ...hostileState,
  journalLimit: 10,
  detail: {
    ...hostileDetail,
    journal: {
      returned: 1, total: 1, totalUnknown: false,
      entries: [{ at: '2026-08-28T10:00:00.000Z', harness: 'claude-code', model: 'm', headline: 'h', rejections: notes }],
    },
  },
}).renderJournal();

// ── Case 1 · NORMALISATION. A defaulted observation time. Nothing lost. ────
const normalised = await ws.saveWorkingState('alpha', {
  scope: 'label-normalised', headline: 'defaulted observation time',
  nowState: 'body so the save is not itself near-empty',
  observations: [{ statement: '84 offline suites green' }],
});
ok('PRECONDITION: the real store emits a note for an observation sent with no time',
  normalised.ok === true && (normalised.notes || []).some((n) => /observation time/i.test(n)),
  JSON.stringify(normalised.notes));
ok('PRECONDITION: ...and that note carries no loss vocabulary (the store class invariant holds)',
  !(normalised.notes || []).some((n) => LOSS_WORDS.test(n)), JSON.stringify(normalised.notes));

const normalisedHtml = journalOf(normalised.notes);
ok('the rendered label does NOT say "rejected by the sanitiser" over a normalised save',
  !/rejected by the sanitiser/i.test(normalisedHtml),
  'the shipped falsehood is still rendered');
ok('...and carries NO loss vocabulary at all — the store invariant, mirrored over rendered output',
  !LOSS_WORDS.test(normalisedHtml.replace(/<[^>]*>/g, '')),
  normalisedHtml.replace(/<[^>]*>/g, '').slice(0, 300));
ok('...and it still says a note exists and what it was for, rather than hiding it',
  /1 note/.test(normalisedHtml) && /normalised/i.test(normalisedHtml));
ok('...and the note text itself is still shown, so the user can read what happened',
  normalisedHtml.includes('observation time'));

// ── Case 2 · REAL LOSS. Unusable items really are dropped. Say so. ────────
const lossy = await ws.saveWorkingState('alpha', {
  scope: 'label-lossy', headline: 'unusable observations',
  nowState: 'body so the save is not itself near-empty',
  observations: [{ statement: 'kept' }, { nope: true }, 42],
});
ok('PRECONDITION: the real store reports genuinely unusable items as dropped',
  lossy.ok === true && (lossy.notes || []).some((n) => /\bdropped\b/i.test(n)),
  JSON.stringify(lossy.notes));
const lossyHtml = journalOf(lossy.notes);
ok('a REAL loss is labelled as loss — the label discriminates, it is not a fixed reassurance',
  /dropped or truncated/i.test(lossyHtml));
ok('...and it does not use the normalised-save wording, which would understate what happened',
  !/stored in full/i.test(lossyHtml));

// ── Case 3 · REPLACEMENT. Nothing the caller sent was lost — but the prior
// handoff was. Neither of the other two labels is true of it. ─────────────
await ws.saveWorkingState('alpha', {
  scope: 'label-replaced', headline: 'a real handoff',
  nowState: 'A substantial body. '.repeat(80),
  nextSteps: ['keep this'],
});
const replaced = await ws.saveWorkingState('alpha', {
  scope: 'label-replaced', headline: 'THIN', replace: true,
});
ok('PRECONDITION: the real store records a deliberate overwrite of a larger handoff',
  replaced.ok === true && (replaced.notes || []).some((n) => /overwrote/i.test(n)),
  JSON.stringify(replaced.notes));
const replacedHtml = journalOf(replaced.notes);
ok('a deliberate replacement is labelled as a replacement, not as normalisation',
  /replaced a larger handoff/i.test(replacedHtml));
ok('...and does not use the normalised-save wording, which would understate what happened',
  !/stored in full/i.test(replacedHtml));

// ── The class invariant, over every note the store can produce here ───────
// Not three pinned cases: every non-loss note, rendered, must be free of loss
// vocabulary. A future note kind is covered without editing this list.
const allNonLoss = [...(normalised.notes || []), ...(replaced.notes || [])]
  .filter((n) => !LOSS_WORDS.test(n));
ok('PRECONDITION: there is at least one non-loss note to test over (not vacuous)',
  allNonLoss.length > 0, 'count ' + allNonLoss.length);
ok('CLASS: no non-loss note is ever rendered under a loss-vocabulary label',
  allNonLoss.every((n) => !LOSS_WORDS.test(journalOf([n]).replace(/<[^>]*>/g, ''))));

// Positive control: the detector can SEE loss vocabulary in rendered output,
// so the assertions above are not passing over a scan that never fires.
ok('self-test: the scan detects loss vocabulary when it really is present',
  LOSS_WORDS.test(journalOf(['x: dropped 2 unusable item(s)']).replace(/<[^>]*>/g, '')));

// An empty rejections array renders no label at all — never warn about
// content that is not there (the same discipline as the empty-journal note).
ok('a save with no notes renders no note label at all',
  !/mem-j-rej/.test(journalOf([])));

// ═════════════════════════════════════════════════════════════════════════
section('§8 — The view writes the STANDING BRIEF and nothing else');
// ═════════════════════════════════════════════════════════════════════════

// STRUCTURAL, NOT A LIST OF LITERAL STRINGS. The five-string version of this
// scan was defeated by `const M = 'PO' + 'ST'` — a planted write survived it
// intact. What made this view read-only was that no fetch it issued carried a
// REQUEST INIT at all: `fetch(url)` with one argument can only ever be a GET,
// whatever the method name is spelled like.
//
// v3.48.0 GAVE THIS VIEW ONE WRITE — the standing brief — so "no init object
// anywhere" is no longer the property. The replacement is NARROWER rather
// than weaker, and it is what the tier boundary actually needs:
//
//   · EXACTLY ONE fetch call site carries an init object.
//   · Its method is the LITERAL 'PATCH' — not a variable, not a
//     concatenation, so the `'PO' + 'ST'` evasion is still refused by
//     construction.
//   · Its URL is the projects endpoint, which the route allows to touch
//     tier 1 only.
//   · Every OTHER fetch is still single-argument.
//
// So a planted `fetch(u, { method: M, body: b })` fails on the count; a
// planted POST fails on the literal; and a PATCH pointed at a scope read
// fails on the URL.
const viewNoComments = stripComments(viewSrc);

/** Every `fetch(` call site's argument list, paren-matched off real source. */
function fetchCallArgs(src) {
  const out = [];
  const re = /(?<![.\w$])fetch\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(m.index + m[0].length, i));
  }
  return out;
}

/** Split one argument list on TOP-LEVEL commas only. */
function topLevelArgs(argsSrc) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < argsSrc.length; i++) {
    const c = argsSrc[i];
    if (quote) { if (c === '\\') { cur += c + (argsSrc[++i] ?? ''); continue; } if (c === quote) quote = null; cur += c; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const fetchArgLists = fetchCallArgs(viewNoComments);
ok('the scan found the view\'s real fetch call sites (it is not vacuous)',
  fetchArgLists.length >= 2, 'found ' + fetchArgLists.length);
const withInit = fetchArgLists.filter((a) => topLevelArgs(a).length > 1);
eq('EXACTLY ONE fetch in the view carries a request init', withInit.length, 1);
ok('every other fetch is single-argument — structurally a GET, whatever a method string is spelled like',
  fetchArgLists.filter((a) => topLevelArgs(a).length === 1).length === fetchArgLists.length - 1,
  JSON.stringify(fetchArgLists.map((a) => topLevelArgs(a).length)));
{
  const init = topLevelArgs(withInit[0])[1];
  const url = topLevelArgs(withInit[0])[0];
  ok('the one write uses a LITERAL PATCH — never a variable or a concatenation',
    /\bmethod\s*:\s*'PATCH'/.test(init), init.slice(0, 120));
  ok('the one write targets the PROJECTS endpoint, which reaches tier 1 only',
    url.includes("'/projects/'") && url.includes('/api/memory/'), url.slice(0, 160));
  ok('the one write sends only a brief — never a handoff field',
    /body:\s*JSON.stringify\(\{\s*brief:/.test(init)
    && !/nowState|nextSteps|observations|traps|decisions/.test(init), init.slice(0, 200));
}
// Positive control: the detector must SEE an init object, including one whose
// method is assembled at runtime — the exact mutation the string list missed.
ok('self-test: the argument-count scan DOES fire on a runtime-assembled method',
  topLevelArgs(fetchCallArgs("const M='PO'+'ST'; await fetch(u, { method: M, body: b });")[0]).length === 2);
ok('self-test: the argument-count scan does NOT fire on a plain read',
  topLevelArgs(fetchCallArgs("await fetch('/api/memory');")[0]).length === 1);

// A request init cannot arrive by any other door either: the ONLY `method:`
// key in real code is the brief write's (comments stripped, so the docblock
// explaining the rule cannot satisfy or violate it), and no alternative
// transport exists at all.
{
  const methods = [...viewNoComments.matchAll(/\bmethod\s*:\s*([^,}\s]+)/g)].map((m) => m[1]);
  ok('exactly one `method:` property key appears in the view\'s real code, and it is \'PATCH\'',
    methods.length === 1 && methods[0] === "'PATCH'", JSON.stringify(methods));
}
for (const transport of ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'FormData', 'Request(']) {
  ok('the view never reaches for ' + transport + ' (fetch is not the only way to write)',
    !viewNoComments.includes(transport));
}
ok('the view fetches only /api/memory endpoints', (() => {
  const urls = [...viewNoComments.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
  const built = viewNoComments.includes("fetch('/api/memory/' + encodeURIComponent(domain)");
  return urls.every((u) => u.startsWith('/api/memory')) && built;
})());
// Import-scoped for the same reason as the route check above: the view's
// docblock explains why it does not join the cross-view write gate, and
// names beginDomainWrite while doing so.
ok('the view never IMPORTS a write helper from the shell', (() => {
  const imports = viewSrc.match(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/gm) || [];
  return imports.length > 0 && !imports.some((i) => /beginDomainWrite|registerWrite/.test(i));
})());
ok('the view escapes BOTH the domain and the project slug into every URL it builds', (() => {
  // Both segments, at every site: a domain slug reaches the URL now too, and
  // one un-escaped segment is one path the server has to disambiguate from
  // an attacker's.
  const sites = [...viewNoComments.matchAll(/fetch\(\s*'\/api\/memory\/'([\s\S]{0,200}?)\n/g)].map((m) => m[1]);
  return sites.length >= 2 && sites.every((t) => t.includes('encodeURIComponent'));
})());

// ═════════════════════════════════════════════════════════════════════════
section('§9 — Mount-token and timer discipline');
// ═════════════════════════════════════════════════════════════════════════

// EVERY SCAN IN THIS SECTION READS COMMENT-STRIPPED SOURCE. Over raw text
// each one is satisfiable by a `//` line — this file's own header quotes
// several of these call shapes while explaining them.
ok('the view imports isCurrentMount', viewNoComments.includes('isCurrentMount'));
ok('every setSidebar/setMain call passes a token', (() => {
  const calls = [...viewNoComments.matchAll(/set(?:Sidebar|Main)\(/g)];
  // Two definitions of the call shape: each call site must mention `token`
  // within its own STATEMENT, read by matching the call's own parentheses.
  //
  // IT WAS A 12-LINE WINDOW, and the window was the bug. renderMain's setMain
  // now opens with a multi-line renderViewHeader options object (eyebrow,
  // title, info, infoHtml, actionsHtml), which pushed `token` to line 14 and
  // reddened this assertion over a call that passes the token perfectly well.
  // A fixed line budget is a guess about formatting; brace matching is a
  // measurement of the call. The fail-safe direction is kept: an unbalanced
  // call (which cannot parse anyway) reads to end-of-file and still has to
  // contain the word.
  const lines = viewNoComments.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].search(/set(?:Sidebar|Main)\(/);
    if (at === -1) continue;
    seen++;
    const from = lines.slice(i).join('\n');
    let p = from.indexOf('(', at), depth = 0, end = from.length;
    for (; p < from.length; p++) {
      if (from[p] === '(') depth++;
      else if (from[p] === ')') { depth--; if (depth === 0) { end = p; break; } }
    }
    if (!/\btoken\b/.test(from.slice(at, end))) return false;
  }
  return seen > 0 && calls.length > 0;
})());
// The gate cancel is EXECUTED in §12 (a spy counts the real call). This stays
// as a cheap scoped confirmation that it lives in the teardown specifically —
// which execution alone cannot tell you.
ok('the teardown cancels the loading gate (timer hygiene)',
  /return \(\) => \{[\s\S]*loadGate\.cancel\(\)/.test(viewNoComments));
ok('async loaders check isCurrentMount after their await',
  (viewNoComments.match(/if \(!isCurrentMount\(token\)\)/g) || []).length >= 3);

// ═════════════════════════════════════════════════════════════════════════
section('§10 — The SQUARE marker, and CSS hygiene');
// ═════════════════════════════════════════════════════════════════════════

function ruleFor(css, selector) {
  const i = css.indexOf(selector + ' {');
  if (i === -1) return null;
  return css.slice(i, css.indexOf('}', i));
}
{
  const row = ruleFor(viewCss, '.mem-row-mark');
  const head = ruleFor(viewCss, '.mem-project-mark');
  ok('.mem-row-mark exists', !!row);
  ok('.mem-project-mark exists', !!head);
  ok('.mem-row-mark is SQUARE, not a circle', !!row && /border-radius:\s*2px/.test(row) && !/50%/.test(row));
  ok('.mem-project-mark is SQUARE, not a circle', !!head && /border-radius:\s*2px/.test(head) && !/50%/.test(head));
  // The distinction is only meaningful if the domain dot is still round.
  const domainsCss = readFileSync(join(NEXT, 'views/domains.css'), 'utf8');
  const dot = ruleFor(domainsCss, '.dm-row-dot');
  ok('the knowledge-domain dot is still ROUND, so the shapes actually differ',
    !!dot && /border-radius:\s*50%/.test(dot));
}
// Comments stripped first: this file's own header explains the rule by
// quoting a literal `0.16s ease` as the thing NOT to write, and a scan over
// raw text fires on that explanation rather than on any real declaration.
const cssNoComments = viewCss.replace(/\/\*[\s\S]*?\*\//g, '');
ok('memory.css hardcodes no animation/transition duration (reduced-motion is token-driven)',
  !/(?:transition|animation)[^;{}]*\b\d+(?:\.\d+)?m?s\b/.test(cssNoComments));
ok('self-test: that scan DOES fire on a planted hardcoded duration',
  /(?:transition|animation)[^;{}]*\b\d+(?:\.\d+)?m?s\b/.test('.x { animation: fade 0.16s ease; }'));
ok('memory.css contains no hardcoded hex colour (every colour is a token)',
  !/:\s*#[0-9a-f]{3,8}\b/i.test(cssNoComments));
ok('every var() used in memory.css resolves (delegated to test-css-tokens.js, which walks this file)',
  (viewCss.match(/var\(--/g) || []).length > 20);
// A machine id is `<hostname-slug>-<install-id>` and used to arrive under
// `overflow-wrap: anywhere`, which broke `talis-macbook-pro-acb035` across
// four lines and made every other row in the table taller with it.
ok('the MACHINE column is one ellipsised line, never a four-line stack',
  (() => {
    const r = ruleFor(viewCss, '.mem-ws-machine');
    return !!r && /white-space:\s*nowrap/.test(r) && /text-overflow:\s*ellipsis/.test(r)
      && /overflow:\s*hidden/.test(r) && /max-width:\s*\d+ch/.test(r)
      && !/overflow-wrap:\s*anywhere/.test(r);
  })());
ok('wide content scrolls inside its own box (pre gets overflow-x)',
  /\.mem-doc pre \{[\s\S]*?overflow-x: auto/.test(viewCss));
ok('focus is visible on the project rows', viewCss.includes('.mem-row:focus-visible'));
ok('focus is visible on the disclosures', viewCss.includes('.mem-fold-summary:focus-visible'));
// The pickers are the shared listbox now, so their focus ring lives in
// shared/listbox.css — asserted THERE rather than pretended to be here. What
// this file still owes is that it does not sit on top of the component's ring
// with a rule of its own.
ok('the pickers\' focus ring is the component\'s (shared/listbox.css), not overridden here',
  !/\.mem-ctl[^{]*\.lb-btn[^{]*:focus/.test(viewCss));
ok('focus is visible on the shared listbox trigger (shared/listbox.css)',
  readFileSync(join(NEXT, 'shared/listbox.css'), 'utf8').includes('.lb-btn:focus-visible'));

// ═════════════════════════════════════════════════════════════════════════
section('§11 — REVALIDATION, driven rather than grepped');
// ═════════════════════════════════════════════════════════════════════════
//
// v3.17.3 shipped the revalidation logic with NO offline assertion over it:
// §9 above checks timer hygiene only through a `loadGate.cancel()` regex that
// `stopPoll()` happens to satisfy incidentally. A section driving
// nextPollDelay, teardown and screenSignature was recorded as owed. This is
// it, and writing it is what would have caught the defect below.
//
// THE DEFECT THIS SECTION EXISTS FOR, reproduced in a real browser first:
// with the view open, a third scope written over MCP moved the sidebar row to
// "3 scopes" while the scope <select> beside it still listed TWO, until the
// user navigated away and back. refreshIndex updated state.projects and
// nothing else; the picker renders from state.projectRead, which no
// revalidation path ever re-read.
//
// Everything here executes the SHIPPED functions, lifted by brace-matching
// and given injected collaborators — a fake fetch, a fake clock, a render
// that does exactly what the real one does to the signature bookkeeping.

// THE HARNESS BELOW RUNS THE REAL render(), NOT A COPY OF IT.
//
// It used to define its own `function render(token) { renderedSignature =
// screenSignature(); onRender(token); }` and guard the real one with a source
// regex. Both halves were defeatable: the regex reads RAW source, so leaving
// `// renderedSignature = screenSignature();` behind satisfied it, and the
// executed half never touched the shipped function at all. Deleting that one
// assignment from production left this suite fully green while shipping a
// 20-second poll that re-renders the whole pane unconditionally — closing any
// picker the user had open, on the one screen whose premise is that something
// else writes while you watch.
//
// So render/captureFocus/restoreFocus are lifted from the live source like
// everything else, and only renderSidebar/renderMain/wire — which need a real
// DOM — are injected. §11d's "an unchanged poll re-renders NOTHING" is
// therefore a claim about the shipped function.

// ── The poll constants, pinned to HAND-WRITTEN LITERALS ──────────────────
//
// The harness used to be handed 20000 / 20 / 300000 as parameters, so it
// proved arithmetic about numbers the suite supplied and never read the ones
// production uses. Changing them to 50 / 0 / 60 — a 50 ms busy poll against a
// route that stats every (scope, machine) pair across up to 200 domains —
// left every assertion green. Read off real source, compared against literals
// typed here, and then THREADED INTO the harness so §11a's arithmetic moves
// with them too.
/** A top-level `const NAME = <literal>;` lifted off live source and eval'd. */
function liftConst(name) {
  const m = new RegExp('(?:^|\\n)const\\s+' + name + '\\s*=\\s*([\\s\\S]*?);\\n', 'm').exec(viewNoComments);
  if (!m) return null;
  try { return new Function('return (' + m[1] + ');')(); } catch { return null; }
}
const FOCUSABLE_IDS_SRC = liftConst('FOCUSABLE_IDS');
const FOCUS_FALLBACK_SRC = liftConst('FOCUS_FALLBACK');

function pollConst(name) {
  const m = new RegExp('(?:^|\\n)const\\s+' + name + '\\s*=\\s*(-?[\\d_]+)\\s*;').exec(viewNoComments);
  return m ? Number(m[1].replace(/_/g, '')) : null;
}
const POLL_BASE_MS_SRC = pollConst('POLL_BASE_MS');
const POLL_DUTY_SRC = pollConst('POLL_DUTY');
const POLL_MAX_MS_SRC = pollConst('POLL_MAX_MS');
ok('POLL_BASE_MS is declared in the view', POLL_BASE_MS_SRC !== null);
ok('POLL_DUTY is declared in the view', POLL_DUTY_SRC !== null);
ok('POLL_MAX_MS is declared in the view', POLL_MAX_MS_SRC !== null);

// ARGUMENT-ORDER ADAPTER, and it is not tidiness. assertLiteral calls
// `ok(cond, message)`; THIS suite's ok is `ok(label, cond)`. Passing `ok`
// directly made every literal assertion below read a non-empty message string
// as its condition and pass unconditionally — root cause 4 (expected equals
// actual by construction) reappearing inside the fix for root cause 4. Found
// by mutation: POLL_BASE_MS 20000 -> 50 went red on the arithmetic and NOT on
// the literal that exists to catch exactly that. Self-tested below.
const okc = (cond, label) => ok(label, cond);
ok('self-test: the literal-assertion adapter can actually FAIL', (() => {
  let sawFail = false;
  const spy = (label, cond) => { if (!cond) sawFail = true; };
  assertLiteral((c, m) => spy(m, c), 'expected', 'ACTUAL', 'probe');
  return sawFail;
})());

assertLiteral(okc, 20000, POLL_BASE_MS_SRC,
  'the poll FLOOR is 20 s — anything shorter is a busy poll against a route that stats every (scope, machine) pair across up to 200 domains');
assertLiteral(okc, 20, POLL_DUTY_SRC,
  'the poll spends at most 1/20th of the wall clock refreshing — a duty of 0 disables the adaptive throttle entirely');
assertLiteral(okc, 300000, POLL_MAX_MS_SRC,
  'the poll CEILING is 5 min — a small ceiling turns the adaptive throttle into a fixed fast poll on a big install');

/**
 * The revalidation machinery, executing for real.
 *
 * Returns the lifted functions plus the probes a test needs: how many of each
 * request went out, how many renders happened, and a fake clock so the poll
 * can be advanced without sleeping.
 */
function makeRevalidator(stateObj, responder, opts = {}) {
  const calls = { index: 0, project: 0, render: 0, sidebar: 0, wire: 0, urls: [] };
  let mounted = true;

  // Fake clock. Timers are a queue of {at, fn}; advance(ms) fires everything
  // due, re-armed timers included, so a setTimeout CHAIN can be walked.
  let now = 0, seq = 0;
  const timers = new Map();
  const fakeSetTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      timers.delete(next.id);
      now = next.t.at;
      next.t.fn();
    }
    now = end;
  }

  const fakeFetch = async (url) => {
    calls.urls.push(String(url));
    if (String(url) === '/api/memory') calls.index++; else calls.project++;
    return responder(String(url));
  };

  const body =
    'let pollTimer = null;\n' +
    'let renderedSignature = null;\n' +
    'let pendingFocusId = null;\n' +
    // THE SHIPPED render(), not a paraphrase of it — with its two focus
    // helpers, which it calls unconditionally.
    extractFunction(viewSrc, 'render', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'captureFocus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'restoreFocus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'formatAge', 'memory.js') + '\n' +
    // (domain, project) identity. Both are lifted, not stubbed: `activeKey`
    // is what every post-await "is this still the selection?" guard compares
    // through, so a stub here would be testing the harness's idea of identity
    // rather than the view's.
    extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
    // screenSignature now folds the save-status strip's own readings through
    // effectiveSave + formatAge, so a save into another scope of the same
    // project — or the reading simply ageing into the next band — repaints.
    extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'newestPair', 'memory.js') + '\n' +
    // The work-stream mark is taken over the ORDER the table paints, not
    // over the response, so the function that decides that order travels
    // with screenSignature everywhere it is executed.
    extractFunction(viewSrc, 'workStreamOrder', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'projectMetaLine', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fetchIndex', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fetchState', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'screenSignature', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'refreshIndex', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'refreshScopeList', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'nextPollDelay', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'stopPoll', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'schedulePoll', 'memory.js') + '\n' +
    'return { refreshIndex, refreshScopeList, screenSignature, nextPollDelay, ' +
    'schedulePoll, stopPoll, render, armed: () => pollTimer !== null, sig: () => renderedSignature };';

  const api = new Function(
    'state', 'renderSidebar', 'renderMain', 'wire', 'isCurrentMount', 'fetch', 'document',
    'FOCUSABLE_IDS', 'FOCUS_FALLBACK',
    'setTimeout', 'clearTimeout', 'POLL_BASE_MS', 'POLL_DUTY', 'POLL_MAX_MS', body)(
    stateObj,
    // Counted on renderMain so one render() is one tick, and the sidebar half
    // is counted separately — a render() that painted only one pane would show
    // up as a mismatch rather than as a pass.
    (t) => { calls.sidebar++; calls.sidebarToken = t; },
    (t) => { calls.render++; calls.mainToken = t; },
    (t) => { calls.wire++; calls.wireToken = t; },
    () => mounted,
    fakeFetch,
    { hidden: !!opts.hidden, activeElement: null, getElementById: () => null, querySelector: () => null },
    FOCUSABLE_IDS_SRC, FOCUS_FALLBACK_SRC,
    fakeSetTimeout, fakeClearTimeout,
    // The REAL constants, read off the live source above. A change to any of
    // them moves this harness, so §11a's arithmetic is a claim about
    // production rather than about three numbers typed into a test.
    POLL_BASE_MS_SRC, POLL_DUTY_SRC, POLL_MAX_MS_SRC);

  // PRIME, exactly as onEnter does: it calls render(mountToken) before
  // loadIndex, so by the time any revalidation runs `renderedSignature`
  // already describes what is painted. Skipping this would leave it null,
  // every signature would differ from it, and the no-op guard would look
  // broken when it is the harness that is unmounted.
  api.render(1);
  calls.render = 0;

  // Drain the microtask queue. The poll is a setTimeout CHAIN re-armed in a
  // .finally(), which is a microtask: firing the timer is not enough, the
  // promise behind it has to settle first. setImmediate outranks every
  // pending microtask, so awaiting it drains them all.
  const settle = () => new Promise((r) => setImmediate(r));

  return { ...api, calls, advance, settle, unmount: () => { mounted = false; } };
}

/** A state shaped exactly like the live one at the moment of the defect. */
function liveState(over = {}) {
  const T0 = 1_000_000;
  const detail = { scope: 'memory-view', machine: 'm1', machines: [{ machine: 'm1', ageSeconds: 5 }],
    current: { present: true, text: '# Second scope\n' }, journal: [] };
  return {
    loading: false, refreshing: false,
    projects: [{ project: 'projects', hasBrief: true, scopeCount: 2, savedCopies: 2,
      lastWriteAt: new Date(T0).toISOString(), ageSeconds: 30, headline: 'Second scope' }],
    indexError: null,
    activeProject: 'projects',
    projectRead: { scopes: [{ scope: 'memory-view' }, { scope: 'main' }], savedCopies: 2 },
    detail,
    detailError: null, detailLoading: false,
    scope: 'memory-view', machine: null, journalLimit: 10,
    openFolds: { 'mem-fold-journal': true },
    detailFetchedAt: T0, scopesFetchedAt: T0,
    staleWrite: false, lastRefreshMs: 0,
    ...over,
  };
}

/** Index + project responses describing "a third scope has just been written". */
function thirdScopeWritten(writeAtMs) {
  const iso = new Date(writeAtMs).toISOString();
  return (url) => {
    if (url === '/api/memory') {
      return { ok: true, json: async () => ({ ok: true, projects: [{
        project: 'projects', hasBrief: true, scopeCount: 3, savedCopies: 3,
        lastWriteAt: iso, ageSeconds: 1, headline: 'THE THIRD SCOPE' }] }) };
    }
    return { ok: true, json: async () => ({ ok: true, project: 'projects', savedCopies: 3,
      scopes: [{ scope: 'third-scope-added-live' }, { scope: 'memory-view' }, { scope: 'main' }] }) };
  };
}

// ── §11a — nextPollDelay: the adaptive interval, arithmetic and bounds ────

{
  const probe = (ms) => { const s = liveState({ lastRefreshMs: ms }); return makeRevalidator(s, () => {}).nextPollDelay(); };
  eq('nextPollDelay: nothing measured yet -> the floor', probe(0), 20000);
  eq('nextPollDelay: a fast refresh stays at the floor', probe(500), 20000);
  eq('nextPollDelay: 2 s of work -> 40 s (1/20th duty cycle)', probe(2000), 40000);
  eq('nextPollDelay: 15 s of work -> the 5-minute ceiling', probe(15000), 300000);
  eq('nextPollDelay: a huge measurement cannot exceed the ceiling', probe(9_999_999), 300000);
  ok('nextPollDelay is monotonic non-decreasing in the measured cost', (() => {
    let prev = -1;
    for (let ms = 0; ms <= 40000; ms += 137) { const d = probe(ms); if (d < prev) return false; prev = d; }
    return true;
  })());
  ok('nextPollDelay is inside [floor, ceiling] for every measurement swept', (() => {
    for (let ms = 0; ms <= 60000; ms += 91) { const d = probe(ms); if (d < 20000 || d > 300000) return false; }
    return true;
  })());
  // A busy poll on a big install is the failure this exists to prevent: the
  // route stats every (scope, machine) pair across up to 200 domains.
  ok('a 15 s refresh can never be re-issued more often than every 5 min',
    probe(15000) >= 300000);
}

// ── §11b — screenSignature must SEE the scope picker ──────────────────────
//
// Half of the defect. Once refreshIndex re-reads the list, a signature blind
// to it classifies a real change as a no-op and the fresh data is never
// painted. The decisive case is the one where the SIDEBAR ROW IS IDENTICAL:
// a save that adds a MACHINE under an existing scope leaves scopeCount,
// headline and age untouched, so nothing but the picker has moved.

{
  const base = liveState();
  const sigOf = (s) => makeRevalidator(s, () => {}).screenSignature();

  eq('screenSignature: identical state -> identical signature',
    sigOf(liveState()), sigOf(liveState()));

  const grew = liveState();
  grew.projectRead = { scopes: [{ scope: 'third-scope-added-live' }, { scope: 'memory-view' }, { scope: 'main' }] };
  ok('screenSignature CHANGES when a scope appears in the picker',
    sigOf(grew) !== sigOf(base));

  // The mutation-proof case: sidebar row byte-identical, only the picker moved.
  const sameRow = liveState();
  sameRow.projectRead = { scopes: [{ scope: 'memory-view' }, { scope: 'main' }, { scope: 'later' }] };
  ok('screenSignature changes on a picker-only change (sidebar row untouched)',
    sigOf(sameRow) !== sigOf(base) &&
    JSON.stringify(sameRow.projects) === JSON.stringify(base.projects));

  const otherScope = liveState({ scope: 'main' });
  ok('screenSignature changes when the SELECTED scope changes',
    sigOf(otherScope) !== sigOf(base));

  // ── INVERTED IN v3.55.0, AND THE REASON IS THE POINT ────────────────────
  // This asserted that a DUPLICATED pair must NOT move the signature, and that
  // was right while the pane was a <select>: two copies of `memory-view` were
  // one option, so reporting a duplicate as a change would have closed a
  // picker somebody had open for no visible difference.
  //
  // The pane is a TABLE now (renderWorkStreams) and a duplicated pair is TWO
  // ROWS, each with its own age, headline and harness. The signature's rule is
  // unchanged — repaint iff the pixels would differ — but the pixels now do.
  // The same reversal, with the same reasoning, is recorded in
  // scripts/test-memory-truth.js §8b.
  const dupes = liveState();
  dupes.projectRead = { scopes: [{ scope: 'memory-view' }, { scope: 'memory-view' }, { scope: 'main' }] };
  ok('a duplicated pair is TWO ROWS in the table, so it MUST move the signature',
    sigOf(dupes) !== sigOf(base));

  ok('screenSignature still tracks the sidebar (staleWrite)',
    sigOf(liveState({ staleWrite: true })) !== sigOf(base));
}

// ── §11c — the headline: refreshIndex heals the PICKER, not just the row ──

{
  const s = liveState();
  const detailBefore = s.detail;
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  await r.refreshIndex(1);

  eq('a write since the list was read costs exactly ONE extra request', r.calls.project, 1);
  ok('the newly written scope is now in the picker',
    s.projectRead.scopes.map((x) => x.scope).includes('third-scope-added-live'),
    JSON.stringify(s.projectRead.scopes));
  eq('the sidebar row updated too', s.projects[0].scopeCount, 3);
  ok('the screen was re-rendered (the change is on screen, not just in state)', r.calls.render > 0);

  // THE v3.17.3 INVARIANTS. The picker is a list of what exists and is
  // corrected in place; the DOCUMENT is offered, never swapped.
  ok('the document was NOT swapped (same object, untouched)', s.detail === detailBefore);
  eq('the user stays on the scope they chose', s.scope, 'memory-view');
  eq('the machine selection is untouched', s.machine, null);
  eq('the journal page size is untouched', s.journalLimit, 10);
  eq('open folds survive', s.openFolds['mem-fold-journal'], true);
  ok('the Reload offer still stands for the document', s.staleWrite === true);
  ok('the document mark did NOT move (Reload stays available until taken)',
    s.detailFetchedAt === 1_000_000);
  ok('the picker mark DID move (so this does not re-fire every poll)',
    s.scopesFetchedAt > 1_000_000);
}

// ── §11d — the steady state costs nothing ────────────────────────────────

/** The index answering with the row the screen already shows. */
function unchangedIndex(ageSeconds) {
  return (url) => url === '/api/memory'
    ? { ok: true, json: async () => ({ ok: true, projects: [{ project: 'projects', hasBrief: true,
        scopeCount: 2, savedCopies: 2, lastWriteAt: new Date(999_000).toISOString(),
        ageSeconds, headline: 'Second scope' }] }) }
    : { ok: true, json: async () => ({ ok: true, scopes: [] }) };
}

{
  const s = liveState();
  // Newest write is OLDER than both marks: nothing has happened.
  const r = makeRevalidator(s, unchangedIndex(30));
  await r.refreshIndex(1);
  eq('an unchanged poll issues NO project request', r.calls.project, 0);
  eq('an unchanged poll re-renders NOTHING', r.calls.render, 0);
  eq('an unchanged poll leaves the picker alone', s.projectRead.scopes.length, 2);
  eq('an unchanged poll raises no stale offer', s.staleWrite, false);
}

{
  // THE SIGNATURE IS OVER RENDERED TEXT, NOT RAW FIELDS — the doc block's own
  // claim, pinned. An age that moved but still READS the same must not
  // re-render (it would close a <select> the user has open); one that crossed
  // a wording boundary must.
  const quiet = liveState();
  const rq = makeRevalidator(quiet, unchangedIndex(52));       // 30s -> 52s, both "just now"
  await rq.refreshIndex(1);
  eq('an age that ticked without changing the WORDS re-renders nothing', rq.calls.render, 0);

  const loud = liveState();
  const rl = makeRevalidator(loud, unchangedIndex(61));        // 30s -> 61s: "just now" -> "1 min ago"
  await rl.refreshIndex(1);
  eq('an age that crossed into new WORDS does re-render', rl.calls.render, 1);
}

// ── §11e — a repeat poll while the Reload notice stands is free ──────────
//
// staleWrite keys off detailFetchedAt and stays true until the user reloads.
// Gating the scope re-read on that mark instead of its own would re-fetch on
// EVERY poll for as long as the notice is up. Two marks, one request.

{
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  await r.refreshIndex(1);
  const afterFirst = r.calls.project;
  await r.refreshIndex(1);
  await r.refreshIndex(1);
  eq('the scope list is re-read ONCE per write, not once per poll', r.calls.project, afterFirst);
  eq('...and the first poll is the one that paid for it', afterFirst, 1);
  ok('the Reload offer is still standing across all three polls', s.staleWrite === true);
}

// ── §11f — cases where the fresh list is deliberately NOT adopted ────────

{
  // The selected scope is gone: adopting would leave the <select> unable to
  // show state.scope, so the browser would paint another scope's name over
  // this scope's handoff.
  const s = liveState();
  const r = makeRevalidator(s, (url) => url === '/api/memory'
    ? { ok: true, json: async () => ({ ok: true, projects: [{ project: 'projects', hasBrief: true,
        scopeCount: 1, savedCopies: 1, lastWriteAt: new Date(1_005_000).toISOString(),
        ageSeconds: 1, headline: 'x' }] }) }
    : { ok: true, json: async () => ({ ok: true, scopes: [{ scope: 'something-else' }] }) });
  await r.refreshIndex(1);
  ok('a list missing the selected scope is REFUSED (picker and document stay consistent)',
    s.projectRead.scopes.map((x) => x.scope).join(',') === 'memory-view,main');
  eq('...and the picker mark does not move, so it will retry', s.scopesFetchedAt, 1_000_000);
  ok('...while the Reload offer is raised, which is the correct way out', s.staleWrite === true);
}

{
  // Nothing selected (an empty project receiving its first save): adopting
  // would paint a scope name over a document that was never read. The Reload
  // offer owns this case.
  // MEASURED LIMIT, recorded rather than implied away: this pins the COMBINED
  // behaviour, not the `!state.scope` line. Removing that line alone leaves
  // this green — the membership check below it returns for a falsy scope
  // anyway — so it is defence in depth and is described as such in the source.
  // The membership check itself IS load-bearing and is mutation-proven above.
  const s = liveState({ scope: null, detail: null, projectRead: { scopes: [] } });
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  await r.refreshIndex(1);
  eq('with nothing selected the picker is left to the Reload offer', s.projectRead.scopes.length, 0);
  ok('...and that offer is raised', s.staleWrite === true);
  ok('...and no document was invented for a scope that was never read', s.detail === null);
}

{
  // A failed re-read must change nothing — same rule refreshIndex already
  // follows for the index itself.
  const s = liveState();
  const r = makeRevalidator(s, (url) => url === '/api/memory'
    ? { ok: true, json: async () => ({ ok: true, projects: [{ project: 'projects', hasBrief: true,
        scopeCount: 3, savedCopies: 3, lastWriteAt: new Date(1_005_000).toISOString(),
        ageSeconds: 1, headline: 'x' }] }) }
    : { ok: false, status: 500, json: async () => ({ ok: false, message: 'boom' }) });
  await r.refreshIndex(1);
  eq('a failed scope re-read leaves the picker exactly as it was', s.projectRead.scopes.length, 2);
  eq('...and does not move the mark, so the next poll retries', s.scopesFetchedAt, 1_000_000);
  eq('...and never surfaces as a detail error', s.detailError, null);
}

{
  // A throwing fetch is the same story.
  const s = liveState();
  const r = makeRevalidator(s, (url) => {
    if (url === '/api/memory') {
      return { ok: true, json: async () => ({ ok: true, projects: [{ project: 'projects',
        hasBrief: true, scopeCount: 3, savedCopies: 3,
        lastWriteAt: new Date(1_005_000).toISOString(), ageSeconds: 1, headline: 'x' }] }) };
    }
    throw new Error('network down');
  });
  await r.refreshIndex(1);
  eq('a THROWING scope re-read leaves the picker as it was', s.projectRead.scopes.length, 2);
  eq('...and refreshIndex still completes', s.refreshing, false);
}

{
  // A remount mid-flight must abandon the result: this view is re-entered
  // constantly from the rail, and a late write would land in another mount.
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  const p = r.refreshIndex(1);
  r.unmount();
  await p;
  eq('a result arriving after a remount is discarded (picker)', s.projectRead.scopes.length, 2);
  eq('...and the sidebar too', s.projects[0].scopeCount, 2);
}

{
  // Re-entrancy: the wake handler and the poll can both fire. The second must
  // bail rather than double-fetch.
  const s = liveState({ refreshing: true });
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  await r.refreshIndex(1);
  eq('a refresh already in flight is not started twice (index)', r.calls.index, 0);
  eq('...nor the scope re-read', r.calls.project, 0);
}

// ── §11g — the poll: a CHAIN, hidden-tab skip, and real teardown ─────────

{
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  ok('no timer is armed before schedulePoll', !r.armed());
  r.schedulePoll(1);
  ok('schedulePoll arms a timer', r.armed());
  r.advance(19_000);
  eq('nothing fires before the floor elapses', r.calls.index, 0);
  r.advance(2_000);
  eq('the poll fires once past the floor', r.calls.index, 1);
  await r.settle();
  ok('the chain re-armed after the refresh settled', r.armed());
  r.advance(60_000);
  await r.settle();
  ok('the poll RE-ARMS itself (a chain, not a one-shot)', r.calls.index >= 2, 'index=' + r.calls.index);

  // Teardown. The measured claim is 0 fetches while unmounted; this is that
  // claim as an assertion rather than as a regex over `loadGate.cancel()`.
  r.stopPoll();
  ok('stopPoll disarms the timer', !r.armed());
  const at = r.calls.index;
  r.advance(600_000);
  eq('TEARDOWN: ten minutes unmounted costs ZERO further requests', r.calls.index, at);
}

{
  // A hidden tab reschedules WITHOUT fetching — nobody is looking, and the
  // wake handler covers the moment they are.
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000), { hidden: true });
  r.schedulePoll(1);
  r.advance(300_000);
  eq('a hidden tab never fetches', r.calls.index, 0);
  ok('...but keeps its timer armed for when it is shown again', r.armed());
  r.stopPoll();
}

{
  // An unmounted-but-still-armed timer must not fetch either: isCurrentMount
  // is checked inside the callback, not only at arm time.
  const s = liveState();
  const r = makeRevalidator(s, thirdScopeWritten(1_005_000));
  r.schedulePoll(1);
  r.unmount();
  r.advance(120_000);
  eq('a timer that outlived its mount fetches nothing', r.calls.index, 0);
  ok('...and does not re-arm itself', !r.armed());
}

// ── §11h — the two marks are genuinely two ───────────────────────────────

ok('the view tracks a mark for the PICKER distinct from the document mark',
  /scopesFetchedAt/.test(viewSrc) && /detailFetchedAt/.test(viewSrc));
ok('refreshScopeList never writes state.detail (the document is unreachable from it)',
  !/state\.detail\s*=/.test(extractFunction(viewSrc, 'refreshScopeList', 'memory.js')));
ok('refreshScopeList never moves the selection',
  !/state\.(scope|machine)\s*=/.test(extractFunction(viewSrc, 'refreshScopeList', 'memory.js')));

// ── §11i — A SAVE UNDER A DIFFERENT MACHINE, mid-poll ────────────────────
//
// The reported staleness, driven end to end at the layer it actually
// happened at. A hostname flap (working-state.js D10) makes one computer
// write into a SECOND machine folder under the SAME scope, so:
//
//   · the scope list is BYTE-IDENTICAL before and after — the picker's
//     contents cannot carry this, and §11b/§11c's headline is therefore
//     blind to it;
//   · the sidebar row's counts are identical too — `scopeCount` counts
//     DISTINCT SCOPES, and no new scope appeared;
//   · the ONLY thing that moves is `lastWriteAt`, and the only thing on
//     screen that can express it is the Reload offer.
//
// So this is the case where `state.staleWrite` is load-bearing all by
// itself. Removing it from screenSignature leaves every other §11 assertion
// green while the notice is computed and never painted.
{
  const t0 = 1_000_000;
  const s = liveState({
    scope: 'memory-view', machine: null,                 // nothing chosen
    detail: { scope: 'memory-view', machine: 'mac-9f3c1a', machines: [
      { machine: 'mac-9f3c1a', ageSeconds: 4 * 3600 }],
      current: { present: true, text: 'FOUR HOURS OLD' }, journal: [] },
    detailFetchedAt: t0, scopesFetchedAt: t0,
  });
  // The index sees the write because it reports the newest across ALL
  // machines; the scope list does not, because no scope was added.
  const wroteAt = t0 + 12 * 60 * 1000;
  const r = makeRevalidator(s, (url) => {
    if (url === '/api/memory') {
      return { ok: true, json: async () => ({ ok: true, projects: [{
        project: 'projects', hasBrief: true, scopeCount: 2, savedCopies: 3,
        lastWriteAt: new Date(wroteAt).toISOString(), ageSeconds: 1,
        headline: 'Second scope' }] }) };
    }
    return { ok: true, json: async () => ({ ok: true, project: 'projects',
      scopes: [{ scope: 'memory-view' }, { scope: 'main' }] }) };
  });

  const before = { renders: r.calls.render, doc: s.detail.current.text };
  await r.refreshIndex(1);

  ok('a save into a SECOND machine folder under the SAME scope is NOTICED by the poll',
    s.staleWrite === true, `staleWrite=${s.staleWrite}`);
  ok('...and it changes what the screen says, so the Reload offer is actually painted',
    r.calls.render > before.renders, `renders ${before.renders} -> ${r.calls.render}`);
  eq('...while the document under the reader is NOT swapped by the poll',
    s.detail.current.text, before.doc);
  eq('...and the selection is not moved either', s.machine, null);
  ok('corpus non-vacuous: the scope list really is unchanged, so nothing else could carry this',
    JSON.stringify(s.projectRead.scopes.map((x) => x.scope)) === JSON.stringify(['memory-view', 'main']),
    JSON.stringify(s.projectRead.scopes));

  // THE DECISIVE ONE, driven through the SHIPPED screenSignature: with the
  // scope list, the selection and the sidebar counts all unmoved, the stale
  // flag is the only thing left that can make this poll visible. Flip it back
  // and the signature must collapse to the pre-poll value — i.e. a signature
  // blind to `staleWrite` would skip the render and leave the Reload offer
  // computed but never painted.
  const sigWith = r.screenSignature();
  s.staleWrite = false;
  const sigWithout = r.screenSignature();
  s.staleWrite = true;                                   // restore
  ok('the stale flag is LOAD-BEARING in the signature — nothing else moved to carry this poll',
    sigWithout !== sigWith, `${sigWithout}\n vs \n${sigWith}`);
  eq('...and restoring it reproduces the post-poll signature exactly',
    r.screenSignature(), sigWith);

  // A repeat poll finding the same write must stay free.
  const rendersAfter = r.calls.render;
  await r.refreshIndex(1);
  eq('a repeat poll over the same unread write costs no further render',
    r.calls.render, rendersAfter);
}

// ═════════════════════════════════════════════════════════════════════════
section('§12 — THE MOUNT CONTRACT, executed rather than grepped');
// ═════════════════════════════════════════════════════════════════════════
//
// onEnter's mount+teardown closure was neither executed nor scanned by
// anything. Four separate deletions inside it left this suite fully green
// while shipping real defects:
//
//   · `schedulePoll(mountToken)` deleted  -> the poll never runs at all, so
//     the whole adaptive-revalidation feature is dead and §11's arithmetic
//     goes on proving things about a function nobody calls;
//   · `stopPoll()` deleted from the teardown -> leaving the view keeps
//     fetching forever, one more chain per re-entry, for the life of the page;
//   · either wake listener deleted -> revalidation-on-focus gone, which is the
//     cheapest and most valuable of the three triggers;
//   · the `removeEventListener` block deleted -> two permanent listeners leak
//     per mount, each holding a closure over a dead mount token.
//
// AND SINCE v3.54: THE AGE CLOCK. onEnter arms a 1-second setInterval so the
// handoff's freshness reading ticks, and NOTHING IN THIS REPOSITORY CAUGHT A
// LEAKED TIMER before this section was given spies for it. A leaked interval
// is worse than a leaked listener: it does not merely hold a closure, it RUNS,
// once a second, walking a DOM that belongs to whatever view mounted next, for
// the life of the page — and one more of them per rail click. `setInterval`
// and `clearInterval` are Node globals, so a rig that did not inject them
// would have armed a REAL timer here and reported nothing either way.
//
// §9's `loadGate.cancel()` regex satisfied none of these; it merely happened
// to sit in the same closure. So the closure is EXECUTED here, against a
// window and a document that record every listener, with every collaborator
// injected as a spy.

/** The real onEnter, lifted out of the registerView({...}) object literal. */
function liftOnEnter() {
  const fn = functionSource(viewNoComments, 'onEnter');
  if (fn === null) throw new Error('onEnter not found in memory.js — the mount contract would be untested');
  return fn;
}

function mountView({ hidden = false, mounted = true, noIntervals = false } = {}) {
  const log = { scheduled: [], stopped: 0, gateCancelled: 0, closedListboxes: 0, renders: [], loadIndex: 0, refresh: 0,
    // The age clock: every arm, every disarm, and the callback it was armed
    // with, so "armed" can be distinguished from "armed with the right thing".
    intervalsArmed: [], intervalsCleared: [], ticks: 0 };
  const listeners = { window: [], document: [] };
  const mkTarget = (bucket) => ({
    addEventListener: (type, fn) => bucket.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const i = bucket.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) bucket.splice(i, 1);
    },
  });
  const win = mkTarget(listeners.window);
  const doc = mkTarget(listeners.document);
  doc.hidden = hidden;

  const body =
    'let state, myMountToken, loadGate, wakeHandler, ageTimer = null;\n' +
    'const __view = {' + liftOnEnter() + '};\n' +
    'return { onEnter: __view.onEnter, wake: () => wakeHandler, token: () => myMountToken,' +
    '         timer: () => ageTimer };';

  // Handed out in order, so an arm and its clear can be matched by identity
  // rather than by count alone — clearing a DIFFERENT handle would otherwise
  // balance the books while leaving the real timer running.
  let nextHandle = 100;
  // Held in a named local so the assertions can compare the function the
  // interval was armed WITH against this exact reference. Counting arms is not
  // enough: an interval armed with render() would balance perfectly and would
  // be the v3.53.1 defect.
  const tickSpy = () => { log.ticks++; };
  const api = new Function(
    'freshState', 'createLoadingGate', 'isCurrentMount', 'render', 'loadIndex',
    'reportAsyncMountFailure', 'refreshIndex', 'schedulePoll', 'stopPoll',
    'closeAllListboxes', 'window', 'document',
    'tickAges', 'AGE_TICK_MS', 'setInterval', 'clearInterval', body)(
    () => ({ loading: true }),
    () => ({ begin: () => {}, cancel: () => { log.gateCancelled++; } }),
    () => mounted,
    (t) => { log.renders.push(t); },
    async (t) => { log.loadIndex++; return t; },
    () => {},
    async (t) => { log.refresh++; return t; },
    (t) => { log.scheduled.push(t); },
    () => { log.stopped++; },
    () => { log.closedListboxes++; },
    win, doc,
    tickSpy,
    1000,
    // `noIntervals` makes setInterval un-callable, which is the engine (or the
    // headless rig) that has none. onEnter guards on `typeof setInterval ===
    // 'function'`, so this arm proves the guard is real rather than decorative.
    noIntervals ? undefined : ((fn, ms) => { log.intervalsArmed.push({ fn, ms, id: nextHandle }); return nextHandle++; }),
    (id) => { log.intervalsCleared.push(id); });

  return { ...api, log, listeners, tickSpy,
    setMounted: (v) => { mounted = v; }, setHidden: (v) => { doc.hidden = v; } };
}

{
  const m = mountView();
  const teardown = m.onEnter(7);

  // ── The mount half ──
  eq('mount: the first paint happens with the mount token', m.log.renders[0], 7);
  eq('mount: the index is loaded exactly once', m.log.loadIndex, 1);
  eq('mount: schedulePoll IS called — without it the poll never runs at all', m.log.scheduled.length, 1);
  eq('mount: ...and it is armed with the MOUNT token, not a re-derived one', m.log.scheduled[0], 7);
  ok('mount: a `focus` listener is registered on window',
    m.listeners.window.some((l) => l.type === 'focus'), JSON.stringify(m.listeners.window.map((l) => l.type)));
  ok('mount: a `visibilitychange` listener is registered on document',
    m.listeners.document.some((l) => l.type === 'visibilitychange'), JSON.stringify(m.listeners.document.map((l) => l.type)));
  // GUARDED DEREFERENCES throughout this block. A missing listener is exactly
  // what the assertions above exist to catch, and an unguarded `[0].fn` turns
  // that catch into a TypeError that aborts the file — a red for the wrong
  // reason, which hides every assertion after it. Measured: deleting the
  // `focus` listener crashed this suite instead of failing it.
  const fire = (bucket, type) => { const l = bucket.find((x) => x.type === type); if (l) l.fn(); return !!l; };
  ok('mount: both wake listeners are the SAME handler, so both can be removed by it',
    m.listeners.window.length > 0 && m.listeners.document.length > 0 &&
    m.listeners.window[0].fn === m.listeners.document[0].fn);
  ok('onEnter returns a teardown function', typeof teardown === 'function');

  // ── The wake handler, actually invoked ──
  eq('the wake handler is what refreshes — nothing has fired yet', m.log.refresh, 0);
  ok('a `focus` wake listener exists to fire', fire(m.listeners.window, 'focus'));
  eq('coming back to a VISIBLE view revalidates', m.log.refresh, 1);
  m.setHidden(true);
  ok('a `visibilitychange` wake listener exists to fire', fire(m.listeners.document, 'visibilitychange'));
  eq('a HIDDEN tab does not revalidate (nobody is looking)', m.log.refresh, 1);
  m.setHidden(false);
  m.setMounted(false);
  fire(m.listeners.window, 'focus');
  eq('a listener that outlived its mount does not revalidate either', m.log.refresh, 1);
  m.setMounted(true);

  // ── The teardown half ──
  teardown();
  eq('teardown: the loading gate is cancelled (timer hygiene)', m.log.gateCancelled, 1);
  eq('teardown: stopPoll IS called — otherwise the view keeps FETCHING for a screen nobody is on', m.log.stopped, 1);
  // v3.55.0: there is no popover left to close. The scope and machine
  // listboxes are a table now, so the teardown's `closeAllListboxes()` was
  // deleted rather than left standing — a teardown step with nothing to tear
  // down is a claim about the screen that is no longer true. Asserted in the
  // NEGATIVE so the deletion is pinned rather than merely unmeasured:
  // re-adding the call (or the import) would red scripts/test-next-listbox.js
  // §5b, and leaving a dead stub here would red this.
  eq('teardown: no popover close is attempted — the view owns none', m.log.closedListboxes, 0);
  eq('teardown: the window `focus` listener is REMOVED (no leak per mount)', m.listeners.window.length, 0);
  eq('teardown: the document `visibilitychange` listener is REMOVED', m.listeners.document.length, 0);
}

{
  // Two mounts and two teardowns must leave nothing behind — the leak this
  // catches grows one listener pair per rail click.
  const m = mountView();
  const t1 = m.onEnter(1); t1();
  const t2 = m.onEnter(2); t2();
  eq('two full mount/teardown cycles leak no window listeners', m.listeners.window.length, 0);
  eq('two full mount/teardown cycles leak no document listeners', m.listeners.document.length, 0);
  eq('...and each mount armed its own poll', m.log.scheduled.length, 2);
  eq('...and each teardown disarmed one', m.log.stopped, 2);
}

// Scoped source checks for the two things execution cannot see: that the
// schedule call is in the MOUNT half and the stop call is in the TEARDOWN
// half. Stated as source scans, because they are.
{
  const onEnterSrc = functionSource(viewNoComments, 'onEnter');
  const tIdx = onEnterSrc.indexOf('return () =>');
  ok('onEnter contains a returned teardown closure', tIdx > 0);
  const mountHalf = onEnterSrc.slice(0, tIdx);
  const teardownHalf = onEnterSrc.slice(tIdx);
  ok('SOURCE SCAN: schedulePoll is called in the MOUNT half, not the teardown',
    /(?<![.\w$])schedulePoll\s*\(/.test(mountHalf) && !/(?<![.\w$])schedulePoll\s*\(/.test(teardownHalf));
  ok('SOURCE SCAN: stopPoll is called in the TEARDOWN half',
    /(?<![.\w$])stopPoll\s*\(/.test(teardownHalf));
  eq('stopPoll has exactly one call site inside onEnter (the teardown)',
    callSiteCount(viewSrc, 'stopPoll', { within: 'onEnter' }), 1);
  eq('schedulePoll has exactly one call site inside onEnter (the mount)',
    callSiteCount(viewSrc, 'schedulePoll', { within: 'onEnter' }), 1);
}

// ═════════════════════════════════════════════════════════════════════════
section('§13 — render() and the focus contract, executed');
// ═════════════════════════════════════════════════════════════════════════
//
// `restoreFocus()` made a no-op regressed the v3.17.1 focus-by-id fix — the
// one that stops "Show more" dropping a keyboard user to <body> — and nothing
// noticed. Both halves are executed here against a document that records
// focus() calls.

function makeFocusRig({ activeId = null, presentIds = [], detailLoading = false } = {}) {
  const focused = [];
  const mk = (id) => ({ id, focus(opts) { focused.push({ id, opts }); } });
  const els = new Map(presentIds.map((id) => [id, mk(id)]));
  const doc = {
    activeElement: activeId ? mk(activeId) : null,
    getElementById: (id) => els.get(id) || null,
    querySelector: (sel) => els.get(sel.replace(/^#/, '')) || null,
  };
  const st = { detailLoading };
  const body =
    'let pendingFocusId = null;\n' +
    extractFunction(viewSrc, 'render', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'captureFocus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'restoreFocus', 'memory.js') + '\n' +
    'let renderedSignature = null;\n' +
    'function screenSignature() { return "SIG"; }\n' +
    'return { render, captureFocus, restoreFocus, pending: () => pendingFocusId, sig: () => renderedSignature };';
  const painted = { sidebar: 0, main: 0, wire: 0 };
  const api = new Function(
    'state', 'document', 'FOCUSABLE_IDS', 'FOCUS_FALLBACK', 'isCurrentMount',
    'renderSidebar', 'renderMain', 'wire', body)(
    st, doc, FOCUSABLE_IDS_SRC, FOCUS_FALLBACK_SRC, () => true,
    () => { painted.sidebar++; }, () => { painted.main++; }, () => { painted.wire++; });
  return { ...api, focused, painted, doc };
}

ok('FOCUSABLE_IDS was lifted from real source and is non-trivial',
  Array.isArray(FOCUSABLE_IDS_SRC) && FOCUSABLE_IDS_SRC.length >= 6, JSON.stringify(FOCUSABLE_IDS_SRC));
ok('FOCUS_FALLBACK was lifted from real source',
  !!FOCUS_FALLBACK_SRC && typeof FOCUS_FALLBACK_SRC === 'object');

{
  // render() paints BOTH panes, wires them, and records the signature.
  const r = makeFocusRig();
  r.render(1);
  eq('render() paints the sidebar', r.painted.sidebar, 1);
  eq('render() paints the main pane', r.painted.main, 1);
  eq('render() re-wires the result', r.painted.wire, 1);
  eq('render() records the signature it just painted', r.sig(), 'SIG');
}
{
  // A stale mount paints nothing at all.
  const body =
    'let pendingFocusId = null;\nlet renderedSignature = null;\n' +
    'function screenSignature() { return "SIG"; }\n' +
    extractFunction(viewSrc, 'render', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'captureFocus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'restoreFocus', 'memory.js') + '\n' +
    'return { render, sig: () => renderedSignature };';
  let painted = 0;
  const api = new Function('state', 'document', 'FOCUSABLE_IDS', 'FOCUS_FALLBACK', 'isCurrentMount',
    'renderSidebar', 'renderMain', 'wire', body)(
    { detailLoading: false }, { activeElement: null, getElementById: () => null, querySelector: () => null },
    FOCUSABLE_IDS_SRC, FOCUS_FALLBACK_SRC, () => false,
    () => { painted++; }, () => { painted++; }, () => { painted++; });
  api.render(1);
  eq('a render for a STALE mount paints nothing', painted, 0);
  eq('...and does not touch the signature either', api.sig(), null);
}
{
  // Capture + restore, the real thing.
  const r = makeFocusRig({ activeId: 'mem-journal-more', presentIds: ['mem-journal-more'] });
  r.captureFocus();
  eq('captureFocus records a focusable control of ours', r.pending(), 'mem-journal-more');
  r.restoreFocus();
  // Guarded: a restoreFocus that focuses NOTHING is the defect, and an
  // unguarded `[0].id` would crash the file rather than name it.
  eq('restoreFocus focuses it back BY ID after the pane was replaced',
    r.focused.length ? r.focused[0].id : null, 'mem-journal-more');
  ok('...with preventScroll, so the reading position the re-render preserved is not undone',
    !!(r.focused.length && r.focused[0].opts && r.focused[0].opts.preventScroll === true),
    JSON.stringify(r.focused.length ? r.focused[0].opts : null));
  eq('...and the pending target is cleared once it lands', r.pending(), null);
}
{
  // The case that matters: "Show more" REMOVES itself, so a by-id-only
  // restore would drop focus every time it worked.
  const r = makeFocusRig({ activeId: 'mem-journal-more', presentIds: ['mem-fold-journal'] });
  r.captureFocus();
  r.restoreFocus();
  eq('a control that removed itself falls back to the nearest stable thing',
    r.focused.length ? r.focused[0].id : null, 'mem-fold-journal');
}
{
  // Reload dismisses the notice it lives in — same shape, its own fallback.
  const r = makeFocusRig({ activeId: 'mem-reload', presentIds: ['mem-refresh'] });
  r.captureFocus();
  r.restoreFocus();
  eq('Reload falls back to the sidebar Refresh, which does the same KIND of thing',
    r.focused.length ? r.focused[0].id : null, 'mem-refresh');
}
{
  // Never reach out of our own view.
  const r = makeFocusRig({ activeId: 'rail-btn-domains', presentIds: ['rail-btn-domains'] });
  r.captureFocus();
  eq('captureFocus IGNORES a control outside this view (it cannot steal focus from the rail)', r.pending(), null);
  r.restoreFocus();
  eq('...and restoreFocus therefore focuses nothing', r.focused.length, 0);
}
{
  // A miss is held while another render is still coming, dropped afterwards.
  //
  // `mem-ws-active` is the v3.55.0 stand-in for the retired `mem-machine-select`
  // and it is the BETTER case: it is the id of the work-stream table's OPEN
  // row, and the row that is open changes DURING the very two-render sequence
  // this exists for — loadScope paints a loader with no open row, then paints
  // the result with one. So the miss on the first render is not hypothetical
  // here, it happens on every row click.
  const held = makeFocusRig({ activeId: 'mem-ws-active', presentIds: [], detailLoading: true });
  held.captureFocus();
  held.restoreFocus();
  eq('a miss is HELD while another render is still coming (a scope change renders twice)',
    held.pending(), 'mem-ws-active');
  const dropped = makeFocusRig({ activeId: 'mem-ws-active', presentIds: [], detailLoading: false });
  dropped.captureFocus();
  dropped.restoreFocus();
  eq('...and is DROPPED once no further render is coming, so it cannot fire later out of context',
    dropped.pending(), null);
  // AND THE ID IS REALLY IN THE LIST. captureFocus only records an id in
  // FOCUSABLE_IDS, so a rename in memory.js that left this fixture behind would
  // make the two assertions above pass against a name the view never emits.
  ok('CONTROL: mem-ws-active is genuinely one of the view\'s focusable ids',
    FOCUSABLE_IDS_SRC.includes('mem-ws-active'), FOCUSABLE_IDS_SRC.join(','));
  ok('...and the two retired picker ids are gone from it',
    !FOCUSABLE_IDS_SRC.includes('mem-scope-select')
    && !FOCUSABLE_IDS_SRC.includes('mem-machine-select'));
}

// ═════════════════════════════════════════════════════════════════════════
section('§14 — The Reload OFFER is painted, and reaches every content branch');
// ═════════════════════════════════════════════════════════════════════════
//
// renderStaleNotice had NO assertion of any kind. `return ''` from it deletes
// the v3.17.3 headline — the offer to reload after an agent writes underneath
// you — with every other assertion in this file still green. Executed here,
// and executed THROUGH renderProject, so it is proven to reach the page.

{
  const quiet = makeRenderers({ ...hostileState, staleWrite: false });
  eq('no write since arrival renders no notice at all', quiet.renderStaleNotice(), '');

  const loud = makeRenderers({ ...hostileState, staleWrite: true });
  const n = loud.renderStaleNotice();
  ok('a newer write renders a notice', n.length > 0);
  ok('...carrying the Reload control by its stable id', n.includes('id="mem-reload"'));
  assertLiteral(okc, 'Reload', (/>([^<]*)<\/button>/.exec(n) || [])[1],
    'the control is labelled Reload — it OFFERS, it does not announce that something was replaced');
  ok('...announced politely rather than as an alert (nothing is broken)', n.includes('role="status"'));
  ok('...saying an agent SAVED, not that the document changed (we have not read it)',
    /saved to this project since you opened it/i.test(n));
  ok('...and it says what is below MAY not be latest, never that it IS stale',
    /may not be the latest/i.test(n));
}
{
  // ALL THREE CONTENT BRANCHES renderProject can take — and each fixture is
  // checked for having actually REACHED the branch it is named after. The
  // first draft of this block reused a fixture whose projectRead carried no
  // `scopes` array, so the "FULL branch" case silently exercised the
  // BRIEF-ONLY branch and deleting `staleNote` from the full branch stayed
  // green. A branch test that does not prove which branch it took is not a
  // branch test.
  const base = { ...hostileState, staleWrite: true };

  const fullState = { ...base,
    projectRead: { ...hostileState.projectRead, scopes: [{ scope: 'a' }, { scope: 'b' }] } };
  const full = makeRenderers(fullState).renderProject();
  ok('branch check: the FULL fixture really renders the handoff card', full.includes('CURRENT HANDOFF'));
  ok('the offer reaches the FULL branch (scopes + a handoff)', full.includes('id="mem-reload"'));

  const briefOnly = makeRenderers({ ...base, detail: null,
    projectRead: { scopes: [], brief: { present: true, text: '## B\n\nx' } } }).renderProject();
  ok('branch check: the BRIEF-ONLY fixture really renders the no-handoff card',
    briefOnly.includes('No handoff saved yet'));
  ok('the offer reaches the BRIEF-ONLY branch', briefOnly.includes('id="mem-reload"'));

  const empty = makeRenderers({ ...base, detail: null, projectRead: { scopes: [], brief: null } }).renderProject();
  ok('branch check: the EMPTY fixture really renders the empty card',
    empty.includes('Nothing saved for this project yet'));
  ok('the offer reaches the EMPTY branch — where "nothing saved yet" is exactly the sentence a fresh write falsifies',
    empty.includes('id="mem-reload"'));

  for (const [name, s] of [['FULL', fullState],
    ['BRIEF-ONLY', { ...base, detail: null, projectRead: { scopes: [], brief: { present: true, text: '## B\n\nx' } } }],
    ['EMPTY', { ...base, detail: null, projectRead: { scopes: [], brief: null } }]]) {
    ok('...and the ' + name + ' branch shows NO offer when nothing has been written',
      !makeRenderers({ ...s, staleWrite: false }).renderProject().includes('id="mem-reload"'));
  }

  // THE SAVE-STATUS STRIP REACHES THE SAME THREE BRANCHES, for the same
  // reason and with the same failure mode: it answers "am I saved?", and the
  // branch where it matters most is the one where the rest of the screen says
  // "nothing saved for this project yet". Deleting `saveStatus` from any one
  // return leaves every other assertion in this file green; scripts/
  // test-memory-truth.js executes what the strip SAYS, and this proves it is
  // on the page at all. It is ABOVE the reload notice in every branch, which
  // is the placement decision — the answer must not sit under its caveats.
  //
  // MATCHED ON THE CLASS TOKEN, NOT ON `class="mem-save"`. Every top-level
  // block on this page carries `mem-section` as well now (one adjacency rule
  // owns every gap), so the old exact-attribute match reddened on markup that
  // was correct in every way the assertion was about. Pinning a full class
  // ATTRIBUTE makes an assertion about spacing out of an assertion about
  // placement; the token regex keeps it about placement. The ordering half is
  // unchanged and still fails if either block moves.
  const classAt = (out, cls) => out.search(new RegExp('class="[^"]*\\b' + cls + '\\b'));
  for (const [name, out] of [['FULL', full], ['BRIEF-ONLY', briefOnly], ['EMPTY', empty]]) {
    ok('the save-status strip reaches the ' + name + ' branch',
      classAt(out, 'mem-save') !== -1, out.slice(0, 200));
    ok('...and it is painted ABOVE the reload notice there',
      classAt(out, 'mem-save') < classAt(out, 'mem-stale'),
      classAt(out, 'mem-save') + ' vs ' + classAt(out, 'mem-stale'));
  }
  ok('self-test: that class matcher is not vacuous and does not match a prefix',
    classAt('<div class="a mem-save b">', 'mem-save') === 5
    && classAt('<div class="mem-saved">', 'mem-save') === -1);
}
{
  // The unlisted note: the store's own sentence, echoed rather than
  // paraphrased, and the empty-project advice that changes with it.
  const s = { ...hostileState, staleWrite: false, detail: null,
    projectRead: { scopes: [], brief: null, unlistedEntries: 2, unlistedReason: 'RENAME THEM TO LETTERS.' } };
  const out = makeRenderers(s).renderProject();
  ok('an unaddressable directory entry is reported at all', out.includes('mem-note-loud'));
  ok('...echoing the STORE\'s own reason verbatim rather than a second copy of the rule',
    out.includes('RENAME THEM TO LETTERS.'));
  ok('...and the empty-project card stops claiming nobody has written a handoff',
    !out.includes('No agent has written a handoff here'));
  ok('...and warns that saving would STRAND what is already there', /stranded/i.test(out));
}

// ═════════════════════════════════════════════════════════════════════════
section('§15 — Reload keeps the user where they are (v3.17.3\'s own rule)');
// ═════════════════════════════════════════════════════════════════════════
//
// reloadActive was never executed. Making it snap to the newest scope and drop
// the machine — the exact behaviour v3.17.3 claims it prevents, and what
// selectProject deliberately does instead — left this suite green.

function makeReloader(stateObj, responder) {
  const calls = { urls: [], renders: 0 };
  let mounted = true;
  const body =
    // (domain, project) identity, lifted rather than stubbed — see the note
    // in makeRevalidator.
    extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'fetchState', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'loadScope', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'reloadActive', 'memory.js') + '\n' +
    'return { reloadActive, loadScope };';
  const api = new Function('state', 'render', 'isCurrentMount', 'fetch', 'URLSearchParams',
    'encodeURIComponent', 'JOURNAL_PAGE', body)(
    stateObj, () => { calls.renders++; }, () => mounted,
    async (url) => { calls.urls.push(String(url)); return responder(String(url)); },
    URLSearchParams, encodeURIComponent, 10);
  return { ...api, calls, unmount: () => { mounted = false; } };
}

{
  // Three scopes; the user is on the MIDDLE one, having DELIBERATELY picked a
  // machine from the picker. `state.machine` non-null is what "deliberately"
  // means — it is written by exactly one place, the machine picker's handler.
  //
  // THIS FIXTURE USED TO CARRY `machine: null`, and that made the assertion
  // below pin a defect: with nothing chosen, "the machine the user was on"
  // was read off `state.detail.machine`, which is what the STORE resolved,
  // not what anyone picked. See the case immediately after this one.
  const s = liveState({ scope: 'memory-view', machine: 'machine-b',
    detail: { scope: 'memory-view', machine: 'machine-b', machines: [], current: { present: true, text: 'x' } } });
  const r = makeReloader(s, (url) => url.includes('?')
    ? { ok: true, json: async () => ({ ok: true, scope: 'memory-view', machine: 'machine-b',
        current: { present: true, text: 'reloaded' }, machines: [] }) }
    : { ok: true, json: async () => ({ ok: true, scopes: [
        { scope: 'newest-scope' }, { scope: 'memory-view' }, { scope: 'main' }] }) });
  await r.reloadActive(1);

  eq('Reload KEEPS the scope the user was reading — it does not snap to the newest', s.scope, 'memory-view');
  ok('...and re-reads that scope, not scopes[0]',
    r.calls.urls.some((u) => /scope=memory-view/.test(u)), JSON.stringify(r.calls.urls));
  ok('...and does not ask for the newest scope at all',
    !r.calls.urls.some((u) => /scope=newest-scope/.test(u)), JSON.stringify(r.calls.urls));
  ok('Reload KEEPS a machine the user CHOSE — dropping it silently swaps whose handoff you read',
    r.calls.urls.some((u) => /machine=machine-b/.test(u)), JSON.stringify(r.calls.urls));
  eq('the fresh scope list IS adopted (that is what Reload is for)', s.projectRead.scopes.length, 3);
  eq('the document was replaced with the fresh read', s.detail.current.text, 'reloaded');
  eq('the stale offer is withdrawn once taken', s.staleWrite, false);
  eq('both marks moved together, because both reads started together', s.scopesFetchedAt, s.detailFetchedAt);
  ok('the marks moved forward', s.detailFetchedAt > 1_000_000);
  eq('loading finished', s.detailLoading, false);
}
{
  // ── THE REPORTED BUG. An AUTO-RESOLVED machine is not a CHOICE. ─────────
  //
  // Reported: the Agent-memory view sat open showing state from four hours
  // earlier; clicking the domain in the sidebar revealed a save from twelve
  // minutes earlier. Root cause, and it is one expression:
  //
  //     const wantMachine = state.detail ? state.detail.machine : state.machine;
  //
  // On arrival, selectProject calls loadScope(scope, null): `state.machine`
  // stays null and the STORE picks the most recently written machine, which
  // lands in `state.detail.machine`. From that first successful load onward
  // the expression above read the store's resolution back as though it were
  // the user's selection — so a save into a DIFFERENT machine folder (which
  // a hostname flap produces, see working-state.js D10) left Reload
  // re-reading the older folder, withdrawing the stale notice, and changing
  // nothing on screen. The Refresh button shares the same call and was
  // therefore equally inert.
  //
  // The poll was never the broken part: `GET /api/memory` reports the newest
  // write across ALL machines, so `staleWrite` flipped true and the Reload
  // offer DID appear. It was the only control that could act on it that
  // could not.
  const s = liveState({ scope: 'memory-view', machine: null,
    detail: { scope: 'memory-view', machine: 'stale-machine', machines: [],
      current: { present: true, text: 'FOUR HOURS OLD' } },
    staleWrite: true });
  // The fake store behaves like the real one: naming a machine gets THAT
  // machine's document, naming none gets the most recently written. Without
  // this the fixture would be vacuous — every response identical, so the
  // "moves forward" assertion could not fail however the URL was built.
  const r = makeReloader(s, (url) => {
    if (!url.includes('?')) {
      return { ok: true, json: async () => ({ ok: true, scopes: [{ scope: 'memory-view' }, { scope: 'main' }] }) };
    }
    const pinned = /machine=stale-machine/.test(url);
    return { ok: true, json: async () => ({ ok: true, scope: 'memory-view',
      machine: pinned ? 'stale-machine' : 'fresh-machine',
      current: { present: true, text: pinned ? 'FOUR HOURS OLD' : 'TWELVE MINUTES OLD' },
      machines: [] }) };
  });
  await r.reloadActive(1);

  ok('Reload does NOT pin to a machine the user never chose — the store re-resolves to the newest',
    !r.calls.urls.some((u) => /machine=/.test(u)), JSON.stringify(r.calls.urls));
  eq('...so the document actually moves forward instead of re-reading the stale folder',
    s.detail.current.text, 'TWELVE MINUTES OLD');
  eq('...and the scope is still the one the user was reading', s.scope, 'memory-view');
  eq('...and nothing was pinned as a side effect, so the next Reload is free too', s.machine, null);
  eq('the stale offer is withdrawn — and this time it was honestly satisfied', s.staleWrite, false);
}
{
  // The scope genuinely disappeared: fall back to the freshest, which is what
  // selectProject would have chosen anyway. Documented behaviour.
  const s = liveState({ scope: 'gone-scope', detail: { scope: 'gone-scope', machine: 'm1', machines: [], current: { present: true, text: 'x' } } });
  const r = makeReloader(s, (url) => url.includes('?')
    ? { ok: true, json: async () => ({ ok: true, current: { present: true, text: 'y' }, machines: [] }) }
    : { ok: true, json: async () => ({ ok: true, scopes: [{ scope: 'newest-scope' }, { scope: 'main' }] }) });
  await r.reloadActive(1);
  eq('a scope removed out of band falls back to the freshest', s.scope, 'newest-scope');
  ok('...and does NOT carry the old machine across to a different scope',
    !r.calls.urls.some((u) => /machine=m1/.test(u)), JSON.stringify(r.calls.urls));
}
{
  // A project whose state vanished entirely: say so, do not paint a scope
  // label over a document that was never read.
  const s = liveState();
  const r = makeReloader(s, (url) => ({ ok: true, json: async () => ({ ok: true, scopes: [] }) }));
  await r.reloadActive(1);
  eq('a project with no scopes left clears the document', s.detail, null);
  eq('...and the scope', s.scope, null);
  eq('...and the machine', s.machine, null);
  eq('...and stops loading', s.detailLoading, false);
}
{
  // A remount mid-flight abandons the result.
  const s = liveState();
  const before = s.detail;
  const r = makeReloader(s, (url) => ({ ok: true, json: async () => ({ ok: true, scopes: [{ scope: 'other' }] }) }));
  const p = r.reloadActive(1);
  r.unmount();
  await p;
  ok('a reload landing after a remount changes nothing', s.detail === before);
}
eq('reloadActive is reachable from the UI exactly where it should be — the Reload button and Refresh',
  callSiteCount(viewSrc, 'reloadActive', { within: 'wire' }), 2);

// ── TWO CALL SITES, TWO MEANINGS — and they must not be "tidied" into one ──
//
// Found by mutation, not by review: rewriting the journal's "show more"
// handler to use `state.machine` (i.e. making it match reloadActive) left
// this suite at 369/0. That is the likeliest future edit here, because the
// two expressions now look gratuitously different, and it is a real defect —
// expanding a journal would silently re-resolve to whichever machine wrote
// most recently, swapping the history you are part-way through reading.
//
// A SOURCE GUARD, and named as one: the handler lives inside `wire`, which
// needs a real DOM, so this checks the expression rather than executing it.
// It is scoped to the two functions by name, so a copy under a third name is
// invisible to it — stated rather than implied away.
{
  const reloadSrc = extractFunction(viewSrc, 'reloadActive', 'memory.js');
  ok('RELOAD honours only a DELIBERATE choice: it reads state.machine…',
    /const\s+wantMachine\s*=\s*state\.machine\s*;/.test(reloadSrc), reloadSrc.slice(0, 200));
  ok('…and never reads the machine the STORE resolved, which is what made an auto-pick a permanent pin',
    !/wantMachine\s*=\s*state\.detail/.test(reloadSrc));

  const wireSrc = extractFunction(viewSrc, 'wire', 'memory.js');
  const moreAt = wireSrc.indexOf('mem-journal-more');
  ok('fixture: the journal "show more" handler is where we think it is', moreAt > 0);
  const moreHandler = wireSrc.slice(moreAt, moreAt + 700);
  ok('SHOW MORE keeps the machine ON SCREEN — pagination must not re-resolve to a newer one',
    /state\.detail\s*\?\s*state\.detail\.machine/.test(moreHandler), moreHandler.slice(0, 300));
}

// ═════════════════════════════════════════════════════════════════════════
section('§16 — Projects inside a domain (v3.48.0)');
// ═════════════════════════════════════════════════════════════════════════
//
// The rail groups by domain, remembers the last project per domain, and the
// standing brief gained the one editor this view has. Every function below is
// lifted from live source and RUN; nothing here reads a source string.

// ── 16a. Identity is the PAIR, never the project name alone ──────────────
{
  const idApi = new Function('state',
    extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
    'return { keyOf, activeKey };')({ activeDomain: 'alpha', activeProject: 'main' });

  ok('two domains holding a project of the SAME name are two different keys',
    idApi.keyOf('alpha', 'main') !== idApi.keyOf('beta', 'main'));
  eq('activeKey reads the live selection', idApi.activeKey(), 'alpha/main');
  // The separator is a character isSafeSegment forbids, so no project slug
  // can contain one and forge another pair's key.
  ok('the key separator is a character a project slug cannot contain',
    idApi.keyOf('a', 'b') === 'a/b' && !/^[a-z0-9][a-z0-9._-]*$/i.test('a/b'));
}

// ── 16b. Which project opens on arrival ──────────────────────────────────
{
  const pick = new Function(extractFunction(viewSrc, 'initialPick', 'memory.js') +
    '\nreturn initialPick;')();

  const rows = [
    { domain: 'alpha', project: 'alpha', lastWriteAt: '2026-09-01T00:00:00.000Z' },
    { domain: 'beta', project: 'one', lastWriteAt: '2026-09-05T00:00:00.000Z' },
    { domain: 'beta', project: 'two', lastWriteAt: '2026-09-06T00:00:00.000Z' },
  ];
  eq('with nothing remembered, the FRESHEST project wins', pick(rows, {}).project, 'two');
  eq('...and it is in the freshest domain', pick(rows, {}).domain, 'beta');
  eq('a remembered project in the freshest domain wins over recency',
    pick(rows, { beta: 'one' }).project, 'one');
  // THE MEMORY IS PER DOMAIN, and this is the assertion that says why. A
  // single global "last project" would send a user who just saved in beta to
  // whatever they were reading in alpha yesterday.
  eq('a remembered project in a DIFFERENT domain is ignored',
    pick(rows, { alpha: 'alpha' }).project, 'two');
  eq('a remembered project that no longer exists falls back to recency',
    pick(rows, { beta: 'deleted' }).project, 'two');
  eq('a project with nothing saved is still selectable when it is all there is',
    pick([{ domain: 'x', project: 'x', lastWriteAt: null }], {}).project, 'x');
  eq('no projects at all -> null, never a throw', pick([], {}), null);
  eq('a junk remembered map degrades to recency', pick(rows, null).project, 'two');
}

// ── 16c. localStorage is a convenience that must never break the screen ──
{
  // The storage key is READ OFF LIVE SOURCE, not retyped: a copy here would
  // be a second name for one thing, and the pair would keep passing while the
  // shipped view wrote to a key nothing read back.
  const KEY = liftConst('LAST_PROJECT_KEY');
  ok('the storage key was lifted from live source (not vacuous)',
    typeof KEY === 'string' && KEY.length > 0, String(KEY));
  function memApi(store) {
    return new Function('localStorage', 'JSON', 'LAST_PROJECT_KEY',
      extractFunction(viewSrc, 'readRememberedProjects', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'rememberProject', 'memory.js') + '\n' +
      'return { readRememberedProjects, rememberProject };')(store, JSON, KEY);
  }
  const bin = {};
  const good = {
    // Keyed strictly: a write to the wrong key reads back as nothing, which
    // is what makes the round-trip assertions below real.
    getItem: (k) => (k === KEY && k in bin ? bin[k] : null),
    setItem: (k, v) => { bin[k] = String(v); },
  };
  const api = memApi(good);
  api.rememberProject('alpha', 'one');
  api.rememberProject('beta', 'two');
  eq('a remembered project round-trips', api.readRememberedProjects().alpha, 'one');
  eq('...per domain, not globally', api.readRememberedProjects().beta, 'two');
  api.rememberProject('alpha', 'three');
  eq('the newest choice replaces the old one', api.readRememberedProjects().alpha, 'three');

  // THROWS, not returns null: Safari's private window and a "block site
  // data" setting both make the ACCESSOR throw, which is the case a
  // null-check misses entirely.
  const hostile = memApi({
    getItem: () => { throw new Error('site data blocked'); },
    setItem: () => { throw new Error('site data blocked'); },
  });
  let threw = false;
  try {
    eq('a throwing localStorage reads as "nothing remembered"',
      JSON.stringify(hostile.readRememberedProjects()), '{}');
    hostile.rememberProject('a', 'b');
  } catch { threw = true; }
  ok('...and a throwing WRITE is swallowed — the app forgets, it does not break', !threw);

  // A stored value is per-browser state a user can edit by hand.
  const junk = memApi({ getItem: () => '["not","an","object"]', setItem: () => {} });
  eq('a stored ARRAY degrades to nothing remembered',
    JSON.stringify(junk.readRememberedProjects()), '{}');
  const partial = memApi({ getItem: () => '{"a":"ok","b":42,"c":null}', setItem: () => {} });
  eq('non-string values are dropped, the usable ones kept',
    JSON.stringify(partial.readRememberedProjects()), '{"a":"ok"}');
  const broken = memApi({ getItem: () => '{oh no', setItem: () => {} });
  eq('unparseable JSON degrades to nothing remembered',
    JSON.stringify(broken.readRememberedProjects()), '{}');
}

// ── 16d. The rail groups by domain ───────────────────────────────────────
{
  const g = makeRenderers({}).renderProjectGroups;
  const rows = [
    { domain: 'alpha', project: 'one', scopeCount: 2, hasBrief: true, lastWriteAt: null },
    { domain: 'alpha', project: 'two', scopeCount: 0, hasBrief: false, lastWriteAt: null },
    { domain: 'beta', project: 'one', scopeCount: 1, hasBrief: false, lastWriteAt: null },
  ];
  const html = g(rows, 'beta', 'one');
  eq('one group per domain, not one per row', (html.match(/mem-group-head/g) || []).length, 2);
  eq('every project still renders a row', (html.match(/data-mem-project=/g) || []).length, 3);
  ok('each row carries its DOMAIN as well as its project — the click handler needs both',
    (html.match(/data-mem-domain=/g) || []).length === 3);
  // THE ACTIVE ROW IS RESOLVED ON THE PAIR. Both domains hold a project
  // called `one`, so a renderer comparing the name alone marks BOTH.
  eq('exactly ONE row is active, even though two projects share a name',
    (html.match(/class="mem-row active"/g) || []).length, 1);
  ok('...and it is the one in the active DOMAIN, not the first of that name',
    html.indexOf('mem-row active') > html.indexOf('mem-group-head">beta'));
  ok('a project with nothing saved renders quiet, not hidden',
    html.includes('mem-row-quiet') && html.includes('mem-row-mark-off'));
  ok('a domain with ONE project still gets its heading — the rail must not change shape',
    (g([rows[2]], null, null).match(/mem-group-head/g) || []).length === 1);
  eq('no projects renders nothing at all', g([], null, null), '');

  // Escaping, through the shipped renderer.
  const hostile = g([{ domain: XSS, project: ATTR, scopeCount: 0, hasBrief: false }], null, null);
  ok('a hostile domain name is escaped', !hostile.includes('<img src=x'));
  ok('a hostile project name cannot break out of its attribute',
    !/data-mem-project="[^"]*"\s+onmouseover/.test(hostile));
}

// ── 16e. The standing brief, and its editor ──────────────────────────────
//
// REWRITTEN IN v3.55.0, and the shape of the rewrite is the finding. The
// brief was a <details> whose <summary> said "Standing brief" and whose body
// ended in an "Edit brief" button UNDER the rendered document — so the way to
// change a brief was below the brief, which is the maintainer's "buried". It
// is a BLOCK now: the block head is the heading, a toolbar row at the top of
// the body carries the brief's age and a PENCIL, and there is no <summary> on
// this section at all.
//
// That last part is why the assertions below changed direction rather than
// merely moving. The v3.0.1-beta.18 hazard — a control inside a <summary>
// toggles its own section — used to be guarded by asserting the control was
// outside the summary. There is no summary, so the hazard is not suppressed,
// it is INEXPRESSIBLE, and that is what is pinned.
{
  const R = makeRenderers({ briefEdit: null });
  const present = { brief: { present: true, text: '## x\n\nbody', updatedAt: '2026-09-10T00:00:00.000Z' } };

  // ── THE PENCIL, AND WHERE IT IS ─────────────────────────────────────────
  const idle = R.renderBrief(present);
  ok('the pencil is offered beside the title, in the block toolbar',
    /<div class="mem-block-toolbar">[\s\S]*?id="mem-brief-edit"/.test(idle), idle.slice(0, 400));
  ok('...and it is a real <button> with an accessible name, not a bare glyph',
    /<button type="button"[^>]*id="mem-brief-edit"[^>]*aria-label="Edit standing brief"/.test(idle));
  ok('...carrying a 14px inline SVG, because app.js has no `pencil` icon to ask for',
    /id="mem-brief-edit"[\s\S]{0,300}<svg width="14" height="14"/.test(idle));
  ok('THERE IS NO <summary> ON THIS SECTION AT ALL — the hazard is inexpressible',
    !/<summary/.test(idle) && !/<details/.test(idle), idle.slice(0, 300));
  ok('the brief\'s own age rides in the toolbar rather than in a tooltip',
    /class="mem-brief-age"/.test(idle) && !/title="/.test(idle));
  ok('the document is rendered through the shared markdown renderer',
    idle.includes('chat-md-h'));

  const absent = R.renderBrief({ brief: { present: false } });
  ok('with no brief yet, the control invites writing one',
    /id="mem-brief-edit"[\s\S]{0,300}Write a brief/.test(absent), absent.slice(0, 400));
  ok('...and says so in its accessible name too',
    /aria-label="Write a standing brief"/.test(absent));
  ok('...and the toolbar says the brief has not been written',
    /class="mem-brief-age">Not written yet/.test(absent));

  // A MIRROR GETS NO EDITOR AND NO PENCIL. The backend refuses the write, and
  // a control whose only outcome is a refusal is worse than no control.
  const mirror = makeRenderers({ briefEdit: null, detail: { readonly: true } })
    .renderBrief({ ...present, readonly: true });
  ok('a read-only Shared Brain mirror is offered no pencil', !mirror.includes('id="mem-brief-edit"'));
  eq('...and no editor either',
    R.renderBriefEditor({ brief: { present: true, text: 'x' } }, true), '');
  ok('CONTROL: the mirror still shows the brief itself', mirror.includes('chat-md-h'));

  // ── THE EDITOR ──────────────────────────────────────────────────────────
  const mkEdit = (over) => makeRenderers({
    briefEdit: {
      domain: 'alpha', project: 'main', loaded: 'loaded text', text: 'loaded text',
      busy: false, error: null, preview: false, confirmDiscard: false, ...over,
    },
  });
  const editing = mkEdit({ text: XSS }).renderBriefEditor(present, false);
  ok('the draft is rendered ESCAPED inside the textarea', !editing.includes('<img src=x'));
  ok('...and the textarea really carries it', editing.includes('id="mem-brief-text"'));
  ok('Save, Preview and Cancel are all offered',
    editing.includes('id="mem-brief-save"') && editing.includes('id="mem-brief-preview"')
    && editing.includes('id="mem-brief-cancel"'));
  ok('...and it says REPLACE rather than implying an append',
    /replaces the whole document/i.test(editing));
  ok('the editor reaches the PAGE, not merely the function',
    mkEdit({}).renderBrief(present).includes('id="mem-brief-text"'));
  ok('...and the rendered document is hidden while the editor is up, so there is one copy on screen',
    !mkEdit({}).renderBrief(present).includes('class="mem-doc"'));

  // FOUR, not three. Preview joined Save, Cancel and the textarea when the
  // editor gained it in v3.55.0 — updated deliberately, because a control the
  // user can still press during a save is a control that can swap the field
  // out from under a write in flight.
  const busy = mkEdit({ busy: true }).renderBriefEditor(present, false);
  eq('while saving, every control is disabled — a second click is a second whole-document write',
    (busy.match(/ disabled/g) || []).length, 4);
  for (const id of ['mem-brief-text', 'mem-brief-save', 'mem-brief-preview', 'mem-brief-cancel']) {
    ok('...including ' + id, new RegExp('id="' + id + '"[^>]* disabled').test(busy)
      || new RegExp('id="' + id + '"[^>]*>').test(busy) && busy.includes(' disabled'), id);
  }

  const failed = mkEdit({ text: 'the user typed this', error: 'refused' })
    .renderBriefEditor(present, false);
  ok('a failure shows the reason', failed.includes('refused'));
  ok('...and KEEPS the draft, which is the only copy of it',
    failed.includes('the user typed this'));

  // ── THE BYTE WALL ───────────────────────────────────────────────────────
  // The route answers 400 `brief_too_large` above MAX_BRIEF_BYTES, so an
  // over-budget draft is refused HERE, before a request the user cannot act on.
  const over = 'x'.repeat(Number(BRIEF_MAX_BYTES_SRC) + 1);
  const big = mkEdit({ text: over }).renderBriefEditor(present, false);
  ok('over the wall, Save is disabled',
    /id="mem-brief-save"[^>]* disabled/.test(big), big.slice(big.indexOf('mem-brief-save') - 80, big.indexOf('mem-brief-save') + 120));
  ok('...and the reason is PRINTED, not left to the server to explain',
    /Too long to save/.test(big) && big.includes(String(BRIEF_MAX_BYTES_SRC)));
  ok('...and Cancel stays available, so the draft is not a trap',
    !/id="mem-brief-cancel"[^>]* disabled/.test(big));
  const under = mkEdit({ text: 'short' }).renderBriefEditor(present, false);
  ok('CONTROL: under the wall Save is enabled and the wall is HIDDEN',
    !/id="mem-brief-save"[^>]* disabled/.test(under)
    && /id="mem-brief-over" hidden>/.test(under), under.slice(0, 200));
  ok('...and the wall is emitted either way, so the input handler can reveal it '
    + 'without a render taking the caret with it',
    under.includes('id="mem-brief-over"') && big.includes('id="mem-brief-over"')
    && !/id="mem-brief-over" hidden>/.test(big));

  // ── THE COUNTER COUNTS, WITHOUT A RENDER ────────────────────────────────
  // FOUND BY TYPING INTO THE REAL PAGE: the figures were rendered once, on
  // open, and the input handler deliberately does not re-render (the caret),
  // so the byte count sat frozen while the draft grew past the wall and the
  // refusal only appeared after a save the user could no longer make.
  //
  // Driven through the REAL handler wire() binds, against a fake document that
  // only knows the elements renderBriefEditor emits for it.
  {
    const stats = { dirty: 'unchanged', words: '0 words', bytes: '0 of 32768 bytes' };
    const cls = new Set();
    const box = {
      classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } },
      querySelector: (sel) => {
        const k = /data-brief-stat="([a-z]+)"/.exec(sel)[1];
        return { get textContent() { return stats[k]; }, set textContent(v) { stats[k] = v; } };
      },
    };
    // `addEventListener` on every stub: wire() binds to Save and Cancel too, and
    // a stub that answers getElementById but not addEventListener is a crash
    // rather than a failing assertion.
    const overEl = { hidden: true, addEventListener() {} };
    const saveEl = { disabled: false, addEventListener() {} };
    const field = { value: '', _input: null,
      addEventListener(t, fn) { if (t === 'input') this._input = fn; } };
    const st = { briefEdit: { domain: 'a', project: 'b', loaded: 'loaded', text: 'loaded' } };
    // A COUNTER, NOT A THROW. A spy that throws makes the mutation which adds
    // `render(token)` back to this handler kill the suite with an uncaught
    // error instead of naming the defect — measured, and re-done for that
    // reason: a crash is not a failing assertion.
    const renders = [];
    const api = new Function(
      'state', 'document', 'render', 'saveBrief', 'reportAsyncMountFailure', 'keyOf', 'activeKey',
      'selectProject', 'copyAgentInstructions', 'loadScope', 'refreshIndex', 'reloadActive',
      'BRIEF_TEMPLATE', 'BRIEF_MAX_BYTES', 'JOURNAL_PAGE', 'JOURNAL_MORE', 'pendingFocusId',
      extractFunction(viewSrc, 'briefStats', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'briefDismissDecision', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'wire', 'memory.js') + '\n' +
      'return { wire };')(
      st,
      { querySelectorAll: () => [],
        getElementById: (id) => ({ 'mem-brief-text': field, 'mem-brief-stats': box,
          'mem-brief-over': overEl, 'mem-brief-save': saveEl })[id] || null },
      () => { renders.push(1); },
      async () => {}, () => {}, (d, q) => d + '/' + q, () => 'a/b',
      async () => {}, async () => {}, async () => {}, async () => {}, async () => {},
      '', Number(BRIEF_MAX_BYTES_SRC), 10, 50, null);
    api.wire(1);
    ok('the input handler was bound', typeof field._input === 'function');

    field.value = 'loaded plus three more words';
    field._input();
    eq('typing updates the WORD count in place', stats.words, '5 words');
    eq('...and the BYTE count', stats.bytes, '28 of 32768 bytes');
    eq('...and says the draft is now modified', stats.dirty, 'modified');
    eq('the wall stays hidden under the budget', overEl.hidden, true);
    eq('...and Save stays available', saveEl.disabled, false);

    field.value = 'x'.repeat(Number(BRIEF_MAX_BYTES_SRC) + 5);
    field._input();
    eq('CROSSING THE WALL WHILE TYPING reveals it', overEl.hidden, false);
    eq('...and disables Save before the user can spend a refusal on it', saveEl.disabled, true);
    ok('...and the line is marked over budget', cls.has('mem-brief-stats-over'));

    field.value = 'back under';
    field._input();
    eq('...and coming back under hides it again', overEl.hidden, true);
    eq('...and re-enables Save', saveEl.disabled, false);
    eq('THE DRAFT IN STATE IS WHAT THE SAVE WILL SEND', st.briefEdit.text, 'back under');
    eq('AND NOT ONE RENDER HAPPENED — a render rebuilds the textarea and takes '
      + 'the caret and the selection with it', renders.length, 0);
  }

  // ── THE DRAFT'S READOUT ─────────────────────────────────────────────────
  ok('the status line reports modified / words / bytes',
    /class="mem-brief-stats"[\s\S]*?modified[\s\S]*?words[\s\S]*?of \d+ bytes/
      .test(mkEdit({ text: 'two words here' }).renderBriefEditor(present, false)));
  ok('...and says "unchanged" when the draft matches what was loaded',
    /class="mem-brief-stats"[\s\S]*?unchanged/.test(under) === false
    && /unchanged/.test(mkEdit({}).renderBriefEditor(present, false)));

  // briefStats is the measurement, driven directly.
  const st = R.briefStats;
  eq('bytes are UTF-8, not characters — the unit the route refuses on',
    st('——').bytes, 6);
  eq('...and the word count is words', st('one two  three\nfour').words, 4);
  eq('an empty draft is zero words, never one', st('').words, 0);
  eq('whitespace alone is zero words', st('   \n  ').words, 0);
  ok('over is computed against the wall', st('x'.repeat(Number(BRIEF_MAX_BYTES_SRC) + 1)).over === true
    && st('x').over === false);

  // ── PREVIEW ─────────────────────────────────────────────────────────────
  const prev = mkEdit({ text: '## Heading\n\nbody', preview: true }).renderBriefEditor(present, false);
  ok('Preview renders the DRAFT as markdown', prev.includes('chat-md-h'));
  ok('...in place of the field, so there is one copy of the text on screen',
    !prev.includes('id="mem-brief-text"'));
  ok('...and the toggle says how to get back', /id="mem-brief-preview"[^>]*>Back to editing/.test(prev));
  // The draft lives in state, so toggling back restores it byte for byte.
  const backAgain = mkEdit({ text: '## Heading\n\nbody', preview: false }).renderBriefEditor(present, false);
  ok('toggling back restores the draft exactly — it was never read out of the DOM',
    backAgain.includes('## Heading&#10;&#10;body') || backAgain.includes('## Heading\n\nbody'));

  // ── ESCAPE: THREE ANSWERS, AS A VALUE ───────────────────────────────────
  const dd = R.briefDismissDecision;
  eq('a clean draft closes', dd({ loaded: 'a', text: 'a', busy: false }), 'close');
  eq('a DIRTY draft asks first — Escape must never destroy the only copy',
    dd({ loaded: 'a', text: 'a changed', busy: false }), 'confirm');
  eq('a save in flight is BLOCKED — the reply cannot be cancelled',
    dd({ loaded: 'a', text: 'a changed', busy: true }), 'blocked');
  eq('...blocked even when clean, because the outcome is still unknown',
    dd({ loaded: 'a', text: 'a', busy: true }), 'blocked');
  eq('no editor at all closes', dd(null), 'close');

  const bar = mkEdit({ text: 'changed', confirmDiscard: true }).renderBriefEditor(present, false);
  ok('the unsaved-draft bar offers Discard and Keep editing',
    bar.includes('id="mem-brief-discard"') && bar.includes('id="mem-brief-keep"'));
  ok('...IN FLOW, over the text it is about, rather than in a dialog that covers it',
    bar.includes('class="mem-brief-discard"') && bar.includes('id="mem-brief-text"'));
  ok('...and it is absent until Escape raises it',
    !mkEdit({ text: 'changed' }).renderBriefEditor(present, false).includes('id="mem-brief-discard"'));
}

// ── 16e2. The keyboard contract, EXECUTED ────────────────────────────────
// A handler is the one thing a markup assertion cannot see. The keydown
// listener wire() binds on the textarea is lifted with wire() itself and driven
// with fake events, so "Cmd+S saves" is a measurement rather than a promise.
{
  const calls = { save: 0, render: 0, prevented: 0 };
  const el = {
    _keydown: null,
    _input: null,
    value: '',
    addEventListener(type, fn) { if (type === 'keydown') this._keydown = fn; if (type === 'input') this._input = fn; },
  };
  const st = {
    activeDomain: 'a', activeProject: 'b', projectRead: null,
    briefEdit: { domain: 'a', project: 'b', loaded: 'x', text: 'x', busy: false, confirmDiscard: false },
  };
  const api = new Function(
    'state', 'document', 'render', 'saveBrief', 'reportAsyncMountFailure', 'keyOf', 'activeKey',
    'selectProject', 'copyAgentInstructions', 'loadScope', 'refreshIndex', 'reloadActive',
    'BRIEF_TEMPLATE', 'JOURNAL_PAGE', 'JOURNAL_MORE', 'pendingFocusId',
    extractFunction(viewSrc, 'briefDismissDecision', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'wire', 'memory.js') + '\n' +
    'return { wire, pending: () => pendingFocusId };')(
    st,
    { querySelectorAll: () => [], getElementById: (id) => (id === 'mem-brief-text' ? el : null) },
    () => { calls.render++; },
    async () => { calls.save++; },
    () => {}, (d, p) => d + '/' + p, () => 'a/b',
    async () => {}, async () => {}, async () => {}, async () => {}, async () => {},
    '', 10, 50, null);
  api.wire(1);
  ok('the keydown handler was bound to the textarea', typeof el._keydown === 'function');

  const ev = (over) => ({ preventDefault() { calls.prevented++; }, metaKey: false, ctrlKey: false, ...over });
  el._keydown(ev({ metaKey: true, key: 's' }));
  eq('Cmd+S saves', calls.save, 1);
  el._keydown(ev({ ctrlKey: true, key: 'S' }));
  eq('Ctrl+Shift+S saves too — the key is matched case-insensitively', calls.save, 2);
  el._keydown(ev({ metaKey: true, key: 'Enter' }));
  eq('Cmd+Enter saves', calls.save, 3);
  eq('...and every one of them preventDefault()ed — otherwise Cmd+S opens the '
    + 'browser\'s Save-page dialog over an app that just saved', calls.prevented, 3);
  el._keydown(ev({ key: 's' }));
  eq('CONTROL: a bare `s` types an `s` and saves nothing', calls.save, 3);

  // Escape, over the three decisions.
  st.briefEdit.text = 'x';
  el._keydown(ev({ key: 'Escape' }));
  eq('Escape with a CLEAN draft closes the editor', st.briefEdit, null);
  st.briefEdit = { domain: 'a', project: 'b', loaded: 'x', text: 'changed', busy: false, confirmDiscard: false };
  el._keydown(ev({ key: 'Escape' }));
  ok('Escape with a DIRTY draft raises the bar and keeps the text',
    st.briefEdit && st.briefEdit.confirmDiscard === true && st.briefEdit.text === 'changed');
  st.briefEdit = { domain: 'a', project: 'b', loaded: 'x', text: 'changed', busy: true, confirmDiscard: false };
  const before = calls.render;
  el._keydown(ev({ key: 'Escape' }));
  ok('Escape during a save does nothing at all — no close, no bar, no render',
    st.briefEdit.confirmDiscard === false && calls.render === before);
}
// ── 16f. The brief write itself ──────────────────────────────────────────
{
  function makeSaver(stateObj, responder) {
    const calls = [];
    let mounted = true;
    const api = new Function('state', 'render', 'isCurrentMount', 'fetch', 'encodeURIComponent',
      'JSON', 'reloadActive', 'refreshIndex', 'reportAsyncMountFailure',
      extractFunction(viewSrc, 'keyOf', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'activeKey', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'saveBrief', 'memory.js') + '\n' +
      'return { saveBrief };')(
      stateObj, () => {}, () => mounted,
      async (url, init) => { calls.push({ url: String(url), init }); return responder(String(url), init); },
      encodeURIComponent, JSON,
      async () => { calls.push({ reloaded: true }); },
      async () => { calls.push({ refreshed: true }); },
      () => {});
    return { ...api, calls, unmount: () => { mounted = false; } };
  }
  const okRes = { ok: true, status: 200, json: async () => ({ ok: true, briefSaved: true }) };

  {
    const st = {
      activeDomain: 'alpha', activeProject: 'main',
      briefEdit: { domain: 'alpha', project: 'main', text: '## Standing brief\n\nnew', busy: false, error: null },
    };
    const r = makeSaver(st, () => okRes);
    await r.saveBrief(1);
    const req = r.calls.find((c) => c.url);
    eq('the write is a PATCH', req.init.method, 'PATCH');
    eq('...to the project endpoint, which reaches tier 1 only',
      req.url, '/api/memory/alpha/projects/main');
    eq('...carrying the WHOLE brief, because the store replaces rather than merges',
      JSON.parse(req.init.body).brief, '## Standing brief\n\nnew');
    eq('...and nothing else', Object.keys(JSON.parse(req.init.body)).join(','), 'brief');
    eq('the editor closes on success', st.briefEdit, null);
    ok('...and the screen re-reads rather than trusting the draft',
      r.calls.some((c) => c.reloaded) && r.calls.some((c) => c.refreshed));
  }
  {
    // A FAILURE MUST NOT DESTROY THE DRAFT.
    const st = {
      activeDomain: 'alpha', activeProject: 'main',
      briefEdit: { domain: 'alpha', project: 'main', text: 'typed by hand', busy: false, error: null },
    };
    const r = makeSaver(st, () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'too large' }) }));
    await r.saveBrief(1);
    ok('a refusal keeps the editor open with the draft intact',
      st.briefEdit && st.briefEdit.text === 'typed by hand');
    eq('...and shows the server\'s own reason', st.briefEdit.error, 'too large');
    eq('...and re-enables the buttons', st.briefEdit.busy, false);
    ok('...and does NOT re-read (there is nothing new to read)',
      !r.calls.some((c) => c.reloaded));
  }
  {
    // A SECOND CLICK WHILE BUSY IS NOT A SECOND WRITE.
    const st = { activeDomain: 'a', activeProject: 'b',
      briefEdit: { domain: 'a', project: 'b', text: 'x', busy: true, error: null } };
    const r = makeSaver(st, () => okRes);
    await r.saveBrief(1);
    eq('a save while one is already in flight issues no request at all',
      r.calls.filter((c) => c.url).length, 0);
  }
  {
    // A REPLY THAT LANDS AFTER THE USER MOVED ON IS DROPPED.
    const st = { activeDomain: 'a', activeProject: 'b',
      briefEdit: { domain: 'a', project: 'b', text: 'x', busy: false, error: null } };
    const r = makeSaver(st, () => {
      // The user switches project while the request is in flight.
      st.briefEdit = { domain: 'other', project: 'thing', text: 'y', busy: false, error: null };
      return okRes;
    });
    await r.saveBrief(1);
    ok('the reply is not applied to the project the user moved to',
      st.briefEdit && st.briefEdit.project === 'thing' && st.briefEdit.text === 'y');
    ok('...and nothing is re-read under it', !r.calls.some((c) => c.reloaded));
  }
}


// ════════════════════════════════════════════════════════════════════════
section('§18 — THE AGE CLOCK, and the things it must never do');
// ════════════════════════════════════════════════════════════════════════
//
// The handoff's freshness reading ticks once a second, so a non-Mac user gets
// the menubar widget's two readings on the web. That buys two new hazards, and
// NOTHING IN THIS REPOSITORY COULD SEE EITHER OF THEM before this section:
//
//   · A LEAKED TIMER. §12 above executes onEnter and its teardown, but
//     `setInterval` is a Node GLOBAL, so before the rig injected spies an armed
//     interval was simply invisible to it — deleting the clearInterval from the
//     teardown left every assertion in this file green while shipping one
//     running timer per rail click, for the life of the page.
//   · A TICK THAT RENDERS. settings.js shipped a once-a-second render tick and
//     v3.53.1 records it as a defect by name: a render replaces both panes by
//     innerHTML, which closes the ⓘ panel, shuts any picker that is open and
//     churns focus. So the tick is executed here against a render SPY.

// ── 18a · TIMER DISCIPLINE, over two full mount/teardown cycles ──────────
{
  const m = mountView();
  const teardown = m.onEnter(11);
  eq('mount: the age clock is armed exactly once', m.log.intervalsArmed.length, 1);
  eq('mount: ...at one second, not at the poll interval', m.log.intervalsArmed[0].ms, 1000);
  ok('mount: ...with tickAges, not with render — a render tick IS the v3.53.1 defect',
    m.log.intervalsArmed[0].fn === m.tickSpy, 'the interval was armed with something else');
  eq('mount: nothing is cleared yet', m.log.intervalsCleared.length, 0);

  teardown();
  eq('teardown: the age clock IS disarmed — otherwise it walks the next view\'s DOM forever',
    m.log.intervalsCleared.length, 1);
  eq('teardown: ...and it clears the handle it armed, not some other one',
    m.log.intervalsCleared[0], m.log.intervalsArmed[0].id);

  teardown();
  eq('teardown twice clears once — the handle is nulled, so a double teardown is not a double clear',
    m.log.intervalsCleared.length, 1);
}
{
  // THE BALANCE, which is the property that actually matters: two mounts and
  // two teardowns must leave nothing running. This is the assertion that reds
  // when somebody removes the clearInterval, and the one that reds when
  // somebody arms a second interval somewhere else in onEnter.
  const m = mountView();
  const t1 = m.onEnter(1); t1();
  const t2 = m.onEnter(2); t2();
  eq('two full mount/teardown cycles arm two intervals', m.log.intervalsArmed.length, 2);
  eq('...and disarm two', m.log.intervalsCleared.length, 2);
  eq('...leaving nothing running', new Set(m.log.intervalsArmed.map((x) => x.id)).size
    - new Set(m.log.intervalsCleared).size, 0);
}
{
  // AN ENGINE WITH NO setInterval. The guard in onEnter is `typeof setInterval
  // === 'function'`, and an unguarded arm would be a TypeError that kills the
  // whole mount — no list, no error card, a blank screen.
  const m = mountView({ noIntervals: true });
  const teardown = m.onEnter(3);
  eq('an engine with no setInterval still mounts', m.log.renders.length >= 1, true);
  eq('...arming nothing', m.log.intervalsArmed.length, 0);
  teardown();
  eq('...and its teardown clears nothing rather than throwing', m.log.intervalsCleared.length, 0);
}

// ── 18b · THE TICK WRITES TEXT AND NEVER RENDERS ────────────────────
{
  const renders = [];
  const mkNode = (at, text) => ({
    _at: at,
    textContent: text,
    getAttribute: (k) => (k === 'data-mem-age-at' ? at : null),
    querySelector: (sel) => (sel === '.tx-readout-value' ? mkNode._values.get(at) : null),
  });
  mkNode._values = new Map();
  const mkPair = (at, text) => {
    const value = { textContent: text, writes: 0 };
    const proxy = {
      get textContent() { return value.textContent; },
      set textContent(v) { value.textContent = v; value.writes++; },
    };
    mkNode._values.set(at, proxy);
    return { node: mkNode(at, ''), value };
  };

  const NOW = Date.parse('2026-09-17T12:00:00.000Z');
  const a = mkPair(new Date(NOW - 7200_000).toISOString(), 'stale words');
  const b = mkPair(new Date(NOW - 45_000).toISOString(), 'just now');
  const bad = mkPair('not a date', 'untouched');

  const box = new Function('document', 'Date', 'render', 'formatAge',
    extractFunction(viewSrc, 'tickAges', 'memory.js') + '\nreturn tickAges;')(
    { querySelectorAll: () => [a.node, b.node, bad.node] },
    { now: () => NOW, parse: Date.parse },
    () => { renders.push(1); },
    new Function(extractFunction(viewSrc, 'formatAge', 'memory.js') + '\nreturn formatAge;')());

  box();
  eq('the tick rewrote a stale reading into the right words', a.value.textContent, '2 hr ago');
  eq('...writing it exactly once', a.value.writes, 1);
  eq('an already-correct reading is NOT rewritten — a no-op write still dirties the node',
    b.value.writes, 0);
  eq('...and its words are left alone', b.value.textContent, 'just now');
  eq('an unparseable stamp FREEZES rather than printing junk', bad.value.textContent, 'untouched');
  eq('THE TICK NEVER RENDERS — a render closes the ⓘ and churns focus (v3.53.1)', renders.length, 0);

  // Positive control: the render spy must be able to see a call, or the
  // assertion above is decorative.
  const control = [];
  new Function('render', 'return function t() { render(); };')((x) => control.push(1))();
  eq('self-test: the render spy DOES record a planted call', control.length, 1);
}

// ── 18b2 · THE SECOND SHAPE THE CLOCK HAS TO REACH ───────────────────────
//
// v3.55.0 gave this screen two age shapes, and the fixtures above only cover
// one of them. A readout escapes its own value, so the handoff summary and the
// save strip put the words inside the COMPONENT's `.tx-readout-value`; the
// work-stream table's age cell and the "Working on" line are a cell and a
// sentence, and they carry this view's own `.mem-age-words`.
//
// WITHOUT THIS BLOCK the mutation that deletes the second lookup stays GREEN,
// and the table's clock silently freezes at whatever the last render painted —
// which is the exact defect (a figure that has quietly stopped being true)
// that tickAges exists for. Measured: it was green before this was written.
{
  const NOW = Date.parse('2026-09-17T12:00:00.000Z');
  const mk = (at, words) => {
    const inner = { textContent: words, writes: 0 };
    const proxy = {
      get textContent() { return inner.textContent; },
      set textContent(v) { inner.textContent = v; inner.writes++; },
    };
    return {
      inner,
      node: {
        getAttribute: (k) => (k === 'data-mem-age-at' ? at : null),
        // The TABLE's shape: no readout anywhere inside, a named span instead.
        querySelector: (sel) => (sel === '.mem-age-words' ? proxy : null),
      },
    };
  };
  const cell = mk(new Date(NOW - 7200_000).toISOString(), 'stale words');
  const fresh = mk(new Date(NOW - 30_000).toISOString(), 'just now');
  const box = new Function('document', 'Date', 'render', 'formatAge',
    extractFunction(viewSrc, 'tickAges', 'memory.js') + '\nreturn tickAges;')(
    { querySelectorAll: () => [cell.node, fresh.node] },
    { now: () => NOW, parse: Date.parse },
    () => { throw new Error('the tick called render()'); },
    new Function(extractFunction(viewSrc, 'formatAge', 'memory.js') + '\nreturn formatAge;')());
  box();
  eq('the tick reaches a TABLE cell through .mem-age-words', cell.inner.textContent, '2 hr ago');
  eq('...writing it exactly once', cell.inner.writes, 1);
  eq('...and leaves an already-correct one alone', fresh.inner.writes, 0);

  // AND IT NEVER WRITES THE WRAPPER'S OWN TEXT. The table's age cell also
  // holds a visually-hidden exact stamp, so a fallback to `el.textContent`
  // would delete it — asserted by giving the node NEITHER named child and
  // proving nothing is written to it.
  const bare = {
    textContent: 'a cell with other children', writes: 0,
    getAttribute: (k) => (k === 'data-mem-age-at' ? new Date(NOW - 7200_000).toISOString() : null),
    querySelector: () => null,
  };
  const wrapped = {
    get textContent() { return bare.textContent; },
    set textContent(v) { bare.textContent = v; bare.writes++; },
    getAttribute: bare.getAttribute,
    querySelector: bare.querySelector,
  };
  new Function('document', 'Date', 'render', 'formatAge',
    extractFunction(viewSrc, 'tickAges', 'memory.js') + '\nreturn tickAges;')(
    { querySelectorAll: () => [wrapped] },
    { now: () => NOW, parse: Date.parse },
    () => {},
    new Function(extractFunction(viewSrc, 'formatAge', 'memory.js') + '\nreturn formatAge;')())();
  eq('a node with NEITHER named child is left entirely alone — an unnamed '
    + 'fallback would delete the visually-hidden stamp beside the words',
    bare.writes, 0);
}
{
  // NO DOM AT ALL. The tick is armed by onEnter and can outlive a document in
  // a headless engine; it must return rather than throw.
  const box = new Function('document', 'formatAge',
    extractFunction(viewSrc, 'tickAges', 'memory.js') + '\nreturn tickAges;')(
    undefined, () => 'x');
  let threw = null;
  try { box(); } catch (e) { threw = e; }
  eq('a tick with no document returns quietly', threw, null);
}

// ── 18c · WHAT YOU OPEN STAYS OPEN ─────────────────────────────
//
// The ⓘ panel's open state lives ONLY in the DOM — shared/text.js flips
// `hidden` and records nothing — so every render closed it. On this screen the
// poll repaints whenever the reading ages into a new band, so a user reading
// "How this works" could have it shut under them. v3.53.1 fixed the same shape
// on Providers & keys and recorded it as UNFIXED here.
{
  const mkInfoRig = ({ expandedBefore = [], presentAfter = [], panels = true } = {}) => {
    const buttons = new Map();
    const panelEls = new Map();
    const mk = (id, expanded) => ({
      _id: id,
      _expanded: expanded,
      getAttribute: (k) => (k === 'data-tx-info' ? id : null),
      setAttribute: (k, v) => { if (k === 'aria-expanded') mk._set.push([id, v]); },
    });
    mk._set = [];
    let phase = 'before';
    for (const id of expandedBefore) buttons.set(id, mk(id, true));
    for (const id of presentAfter) {
      if (!buttons.has(id)) buttons.set(id, mk(id, false));
      if (panels) panelEls.set(id, { _id: id, hidden: true });
    }
    const doc = {
      querySelectorAll: (sel) => {
        if (sel === '[data-tx-info][aria-expanded="true"]') {
          return phase === 'before' ? expandedBefore.map((id) => buttons.get(id)) : [];
        }
        if (sel === '[data-tx-info]') {
          return presentAfter.map((id) => buttons.get(id)).filter(Boolean);
        }
        return [];
      },
      getElementById: (id) => panelEls.get(id) || null,
      querySelector: () => null,
      activeElement: null,
    };
    const body =
      'let pendingFocusId = null;\nlet renderedSignature = null;\n' +
      'function screenSignature() { return "SIG"; }\n' +
      extractFunction(viewSrc, 'render', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'captureFocus', 'memory.js') + '\n' +
      extractFunction(viewSrc, 'restoreFocus', 'memory.js') + '\n' +
      'return render;';
    const render = new Function('state', 'document', 'FOCUSABLE_IDS', 'FOCUS_FALLBACK',
      'isCurrentMount', 'renderSidebar', 'renderMain', 'wire', body)(
      { detailLoading: false }, doc, FOCUSABLE_IDS_SRC, FOCUS_FALLBACK_SRC, () => true,
      () => { phase = 'after'; }, () => {}, () => {});
    return { render, panelEls, set: mk._set };
  };

  const MAIN = 'tx-vh-info-agent-memory';
  const SIDE = 'tx-vh-info-agent-memory-sidebar';

  const r = mkInfoRig({ expandedBefore: [MAIN], presentAfter: [MAIN, SIDE] });
  r.render(1);
  eq('an ⓘ panel open BEFORE the render is open after it', r.panelEls.get(MAIN).hidden, false);
  ok('...with its button saying so — both halves or neither, because the shared '
    + 'listener reads aria-expanded to decide what the NEXT click does',
    r.set.some(([id, v]) => id === MAIN && v === 'true'), JSON.stringify(r.set));
  eq('CONTROL: a panel that was CLOSED is not opened — restore only ever opens',
    r.panelEls.get(SIDE).hidden, true);

  const both = mkInfoRig({ expandedBefore: [MAIN, SIDE], presentAfter: [MAIN, SIDE] });
  both.render(1);
  ok('BOTH marks are covered — the rail\'s header carries one too, and it is the '
    + 'one that was live and unfixed',
    both.panelEls.get(MAIN).hidden === false && both.panelEls.get(SIDE).hidden === false);

  const gone = mkInfoRig({ expandedBefore: [MAIN], presentAfter: [] });
  let threw = null;
  try { gone.render(1); } catch (e) { threw = e; }
  eq('a panel that the render did not re-emit is simply not restored, never a crash', threw, null);

  const noPanel = mkInfoRig({ expandedBefore: [MAIN], presentAfter: [MAIN], panels: false });
  threw = null;
  try { noPanel.render(1); } catch (e) { threw = e; }
  eq('a button whose panel is missing is skipped rather than half-opened', threw, null);
  ok('...and its button is NOT told it is expanded',
    !noPanel.set.some(([, v]) => v === 'true'), JSON.stringify(noPanel.set));

  // BOTH ids are in FOCUSABLE_IDS, or a keyboard user reading either panel is
  // dropped to <body> on the next poll — the v3.17.1 defect this view's focus
  // handling exists for, reopened on the newest control.
  for (const id of [MAIN + '-btn', SIDE + '-btn']) {
    ok('FOCUSABLE_IDS names ' + id, FOCUSABLE_IDS_SRC.includes(id), JSON.stringify(FOCUSABLE_IDS_SRC));
  }
}

// ── 18d · THE RENDERED HANDOFF: a lead fold with the widget's readings ─────
{
  const now = Date.now();
  const st = (over = {}) => ({
    activeDomain: 'acme', activeProject: 'lumina', scope: 'main', machine: 'boxa',
    detailLoading: false, journalLimit: 10, openFolds: {}, ageTickerArmed: true,
    projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 7200 }],
      brief: { present: false } },
    detail: {
      scope: 'main', machine: 'boxa', machines: [{ machine: 'boxa', writtenAgeSeconds: 7200 }],
      current: { present: true, writtenAgeSeconds: 7200,
        writtenAt: new Date(now - 7200_000).toISOString(),
        savedAt: new Date(now - 7200_000).toISOString(),
        text: '# T\n\n> Headline\n\n## Where things stand\n\nBody.\n' },
      journal: { returned: 1, total: 1, totalUnknown: false,
        entries: [{ at: new Date(now - 7200_000).toISOString(), harness: 'claude-code', model: 'opus-5', headline: 'h', rejections: [] }] },
    },
    ...over,
  });

  const h = makeRenderers(st()).renderHandoff();
  ok('the handoff is a <details> the user can collapse, like the other two',
    /<details[^>]*data-mem-fold="handoff"/.test(h), h.slice(0, 260));
  ok('...OPEN by default, because it is the answer this screen exists to give',
    /<details[^>]*data-mem-fold="handoff"[^>]*\sopen>/.test(h), h.slice(0, 260));
  ok('...marked as the LEADER, so three cards do not have to be read to be ranked',
    /class="[^"]*\bmem-fold-lead\b/.test(h), h.slice(0, 260));

  const sum = (m => m ? m[0] : '')(/<summary[\s\S]*?<\/summary>/.exec(h));
  ok('the summary really exists (the checks below are not vacuous)', sum.length > 60, sum);
  ok('THE PIP is in the summary, at the step the age says — the SAME class the '
    + 'save strip uses, never a second freshness ladder',
    /class="mem-save-pip mem-save-pip-s2"/.test(sum), sum);
  ok('THE LIVE CLOCK is in the summary, carrying the stamp effectiveSave resolved',
    /data-mem-age-at="[^"]+"/.test(sum), sum);
  ok('...and the words beside it are the age, not a raw timestamp',
    /class="tx-readout-value">2 hr ago</.test(sum), sum);
  ok('...saying it updates live, because it does',
    /updates live/.test(sum), sum);
  for (const control of ['<button', '<select', '<input', '<textarea', '<a ']) {
    ok('the summary holds no ' + control + '> — a control there toggles its own section',
      !sum.toLowerCase().includes(control), sum);
  }
  ok('the document itself is in the fold BODY, not the summary',
    /class="mem-fold-body"[\s\S]*chat-md-h/.test(h));

  // "updates live" IS A CLAIM. With no clock armed it must not be made.
  const still = makeRenderers(st({ ageTickerArmed: false })).renderHandoff();
  ok('CONTROL: with no clock armed the reading does NOT claim to update live',
    !/updates live/.test(still) && /class="tx-readout-value">2 hr ago</.test(still), still.slice(0, 600));

  // A REMEMBERED CLOSE WINS over the default, exactly as the brief's does.
  const closed = makeRenderers(st({ openFolds: { handoff: false } })).renderHandoff();
  ok('a fold the user closed STAYS closed across the next render',
    !/<details[^>]*data-mem-fold="handoff"[^>]*\sopen>/.test(closed), closed.slice(0, 200));

  // AN UNKNOWN AGE is the dashed ring and words, never step 0 and never "0s".
  const unknown = makeRenderers(st({
    detail: { ...st().detail, current: { ...st().detail.current, writtenAgeSeconds: null, writtenAt: null, savedAt: null },
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } },
  })).renderHandoff();
  ok('an unknown age takes the dashed -unknown ring, not step 0',
    /mem-save-pip-unknown/.test(unknown) && !/mem-save-pip-s0/.test(unknown), unknown.slice(0, 400));
  ok('...and says so in words rather than showing a bare mark',
    /time unknown/.test(unknown), unknown.slice(0, 400));
  ok('...and emits NO clock hook, because there is nothing to recount',
    !/data-mem-age-at/.test(unknown), unknown.slice(0, 400));
}

// ── 18d2 · A MID-READ FOLD MUST NOT EMIT A STATE IT DOES NOT MEAN ────────
//
// FOUND BY LOOKING at the rendered page, not by any assertion in this file: in
// v3.54.0 the standing brief was open on every visit, on a screen whose whole
// design is that the handoff is what you came for.
//
// The mechanism was two things meeting. (1) loadScope drops `state.detail`
// before it paints — deliberately, so the old machine's handoff is never shown
// under the new scope's label — so renderProject ran once with `d === null`,
// and the brief's "I am the only content here" rule was momentarily TRUE.
// (2) Chrome queues a `toggle` event for a <details> parsed WITH an `open`
// attribute; measured in a real browser, a freshly-innerHTML'd `<details open>`
// fires one. wire()'s listener wrote `openFolds.brief = true`, and a
// remembered value beats the default forever after — so a 200 ms transient
// became the permanent state.
//
// ── v3.55.0 CLOSED IT BY REMOVING THE PATH, NOT THE SYMPTOM ──────────────
// The brief is a BLOCK now, not a <details>: it has no `open` attribute to
// emit, no queued `toggle` to be raced, and no "only content here" rule to be
// transiently true. The assertions therefore change direction — from "it must
// not be emitted open mid-read" to "there is no fold here to open" — which is
// v3.22.0's rule (make the wrong output inexpressible) and v3.13.0's (remove
// the PATH, not the symptom).
//
// WHAT IS STILL PINNED IS THE HANDOFF, which IS a <details> and IS opened by
// default, so the class of defect has a live subject on this page. Its default
// must survive a mid-read and must still honour a user who closed it.
{
  const midRead = {
    activeDomain: 'acme', activeProject: 'lumina', scope: 'main', machine: 'boxa',
    detailLoading: true, detail: null, staleWrite: false, journalLimit: 10, openFolds: {},
    projects: [],
    projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
      brief: { present: true, text: '# B\n\n## Goal\n\nShip it.', updatedAt: new Date().toISOString() } },
  };
  const out = makeRenderers(midRead).renderProject();
  ok('mid-read: the page really is in the full branch (the check is not vacuous)',
    /data-block="memory-brief"|settings-block-memory-brief/.test(out), out.slice(0, 200));
  ok('mid-read: the standing brief is not a <details> at all, so there is no '
    + '`open` for Chrome\'s queued toggle to make permanent',
    !/data-mem-fold="brief"/.test(out));
  ok('...and the brief\'s content is on the page regardless — the fix did not '
    + 'close the transient by hiding the section',
    /id="mem-brief-edit"/.test(out));

  // THE HANDOFF IS THE LIVE SUBJECT OF THE ORIGINAL RULE, in both directions.
  const settledWithHandoff = { ...midRead, detailLoading: false,
    detail: { scope: 'main', machine: 'boxa', machines: [],
      current: { present: true, writtenAgeSeconds: 120, writtenAt: new Date().toISOString(),
        text: '## Where things stand\n\nx' },
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } } };
  ok('CONTROL: with a handoff to read, its fold IS emitted open',
    /<details[^>]*data-mem-fold="handoff"[^>]*\sopen>/
      .test(makeRenderers(settledWithHandoff).renderProject()));
  ok('CONTROL: and a user who closed it keeps it closed',
    !/<details[^>]*data-mem-fold="handoff"[^>]*\sopen>/
      .test(makeRenderers({ ...settledWithHandoff, openFolds: { handoff: false } }).renderProject()));

  // AND THE EMPTY CASE STILL SHOWS SOMETHING. The rule the brief's transient
  // came from — "do not leave the page blank" — is now answered by block ③
  // carrying the no-handoff card rather than by opening a different section.
  const settledNoHandoff = { ...midRead, detailLoading: false,
    detail: { scope: 'main', machine: 'boxa', current: { present: false }, machines: [],
      journal: { returned: 0, total: 0, totalUnknown: false, entries: [] } } };
  const empty = makeRenderers(settledNoHandoff).renderProject();
  ok('with no handoff, the Current handoff block says so in its own body',
    /No handoff under this scope yet/.test(empty), empty.slice(0, 200));
  ok('...and the brief is still fully on the page beneath it',
    /id="mem-brief-edit"/.test(empty));
}
// ── 18e · THE PAGE: an ⓘ in the header, and no explainer card ───────────
{
  const src = stripComments(readFileSync(join(NEXT, 'views/memory.js'), 'utf8'));
  ok('renderMain builds its header with an `info` panel — "How this works" is the mark now',
    callSiteCount(src, 'renderViewHeader', { within: 'renderMain' }) > 0
    && /info: aboutInfoHtml\(\)/.test(src), 'no info on the centre header');
  ok('...as raw HTML, which is what lets the panel carry its list and its docs link',
    /infoHtml: true/.test(src));
  ok('the explainer component is GONE from this view — not imported, not called',
    !/renderExplainer/.test(src));
  ok('...and no branch of the page emits one',
    !makeRenderers(hostileState).renderProject().includes('tx-explainer'));
  ok('the About panel ends with a docs link from the frozen table',
    /docsLinkHtml\('memory\.overview'/.test(src));
  ok('...and that link really resolves and really renders',
    /<a href="https:\/\/github\.com\/[^"]*working-state\.md"/.test(makeRenderers(hostileState).aboutInfoHtml()));
  ok('the sidebar\'s lock CARD is gone and its sentence is behind the rail\'s own mark',
    !/mem-sidebar-foot/.test(src)
    && /Agents save handoffs here over MCP; you write the standing brief\./.test(src));
  ok('"Copy agent instructions" is in the header\'s action slot, not floating in the breadcrumb',
    /actionsHtml:[\s\S]{0,240}id="mem-copy-agent"/.test(src)
    && callSiteCount(src, 'renderViewHeader', { within: 'renderMain' }) > 0);
  ok('...and the breadcrumb row no longer carries it',
    !/mem-project-head[\s\S]{0,900}mem-copy-agent/.test(src));
}

// ── 18g · THE WIDGET'S TWO READINGS, IN THE APP ─────────────────────────
//
// The menubar widget has carried both since v3.37.0 and no Windows or Linux
// user has ever seen either: the "Working on:" headline, and "another computer
// saved after this one". Both are derived from data every read already
// returned — `scopes[].headline` was fetched on every request and rendered
// nowhere at all.
{
  const nowMs = Date.now();
  const at = (secs) => new Date(nowMs - secs * 1000).toISOString();

  // ── "Working on:" IN BLOCK ① ──────────────────────────────────────────
  const withHead = makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina', projects: [],
  });
  const strip = withHead.renderSaveStatus(
    { scopes: [{ scope: 'main', machine: 'boxa', headline: 'Rewriting the memory view',
      writtenAgeSeconds: 120, writtenAt: at(120) }],
    brief: { present: false } },
    { scope: 'main', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 120, writtenAt: at(120) } });
  ok('the headline the agent wrote leads the Status block',
    /class="mem-working"[\s\S]*?Rewriting the memory view/.test(strip), strip.slice(0, 400));
  ok('...with the freshness pip and a LIVE age beside it',
    /class="mem-working"[^>]*data-mem-age-at="[^"]+"/.test(strip)
    && /class="mem-working"[\s\S]*?mem-save-pip-s3/.test(strip)
    && /class="mem-age-words mem-working-age">2 min ago</.test(strip), strip.slice(0, 500));
  ok('...and the headline is escaped, because it comes off disk',
    !withHead.renderSaveStatus({ scopes: [{ scope: 'a', headline: XSS, writtenAgeSeconds: 60 }] }, null)
      .includes('<img '));

  // IT FALLS BACK TO THE INDEX ROW, which is what the page has before the
  // unscoped read lands.
  const fromIndex = makeRenderers({
    activeDomain: 'acme', activeProject: 'lumina',
    projects: [{ domain: 'acme', project: 'lumina', headline: 'From the index row',
      writtenAgeSeconds: 300, writtenAt: at(300) }],
  }).renderSaveStatus({ scopes: [], brief: { present: false } }, null);
  ok('with no scope rows yet, the project index row supplies the headline',
    /class="mem-working"[\s\S]*?From the index row/.test(fromIndex), fromIndex.slice(0, 300));

  // ABSENT IS ABSENT. No headline anywhere renders no line, never an em dash.
  const noHead = makeRenderers({ activeDomain: 'a', activeProject: 'b', projects: [] })
    .renderSaveStatus({ scopes: [{ scope: 'main', writtenAgeSeconds: 60 }], brief: { present: false } }, null);
  ok('CONTROL: with no headline at all the line is omitted, not filled with a placeholder',
    !noHead.includes('mem-working'), noHead.slice(0, 200));

  // ── ...AND IN THE RAIL ────────────────────────────────────────────────
  const rail = makeRenderers({}).renderProjectGroups(
    [{ domain: 'acme', project: 'lumina', scopeCount: 2, hasBrief: true,
      headline: 'Rewriting the memory view', writtenAgeSeconds: 120, writtenAt: at(120) },
    { domain: 'acme', project: 'quiet', scopeCount: 0, hasBrief: false }], 'acme', 'lumina');
  ok('the rail row carries the headline too',
    /class="mem-row-head">Rewriting the memory view</.test(rail), rail.slice(0, 600));
  eq('...and a project with none gets no empty line',
    (rail.match(/class="mem-row-head"/g) || []).length, 1);
  ok('the rail row wears the freshness dot, on the shared scale',
    /class="mem-row-meta">[\s\S]{0,80}class="fresh-dot fresh-recent"/.test(rail), rail.slice(0, 900));
  ok('...and a row with no age at all takes the `unknown` tier, not `dormant`',
    /class="fresh-dot fresh-unknown"/.test(rail));

  // ── "ANOTHER COMPUTER SAVED AFTER THIS ONE" ───────────────────────────
  // The tray's `newerElsewhereNotice` rule, reproduced rather than imported —
  // desktop/ and src/ may not import each other. Driven BOTH ways.
  const N = makeRenderers({}).newerOnAnotherMachine;
  const local = { scope: 'main', machine: 'mine', writtenAgeSeconds: 600, writtenAt: at(600) };
  const foreignNewer = { scope: 'main', machine: 'theirs', writtenAgeSeconds: 60, writtenAt: at(60) };
  const foreignOlder = { scope: 'main', machine: 'theirs', writtenAgeSeconds: 9000, writtenAt: at(9000) };
  const here = { machine: 'mine', machineIsThisMachine: true };

  eq('a foreign machine that saved LATER is named',
    (N([local, foreignNewer], here) || {}).machine, 'theirs');
  eq('a foreign machine that saved EARLIER is not', N([local, foreignOlder], here), null);
  eq('a tie is not news', N([local, { ...local, machine: 'theirs' }], here), null);
  eq('with no foreign machine at all there is nothing to say', N([local], here), null);
  eq('with no LOCAL row there is no "after this one" to measure against',
    N([foreignNewer], here), null);

  // THE TWO CLAUSES THAT ARE ABOUT TRUTHFULNESS RATHER THAN ARITHMETIC.
  eq('without positive evidence of WHICH machine is this one, nothing is claimed',
    N([local, foreignNewer], { machine: 'mine' }), null);
  eq('...and an explicit false is not evidence either', N([local, foreignNewer],
    { machine: 'mine', machineIsThisMachine: false }), null);
  eq('FILESYSTEM ages are excluded — on a synced folder that is the time of the '
    + 'PULL, so comparing one machine\'s pull against another\'s save would '
    + 'manufacture this notice out of sync traffic',
    N([{ scope: 'main', machine: 'mine', ageSeconds: 600 },
      { scope: 'main', machine: 'theirs', ageSeconds: 60 }], here), null);
  ok('CONTROL: the same two rows on AGENT clocks do produce the notice',
    N([local, foreignNewer], here) !== null);

  // ...and it reaches the page.
  const reaches = makeRenderers({ activeDomain: 'a', activeProject: 'b', projects: [] })
    .renderSaveStatus({ scopes: [local, foreignNewer], brief: { present: false } },
      { ...here, scope: 'main', current: { present: true, writtenAgeSeconds: 600, writtenAt: at(600) } });
  ok('the reading reaches the Status block, naming the machine and the work-stream',
    /theirs[\s\S]*?saved after this computer/.test(reaches) && /side|main/.test(reaches),
    reaches.slice(0, 600));
  ok('...and says what to do about it, which is the whole point of naming it',
    /Pull before you continue/.test(reaches));
}

// ── 18h · THE HEADER'S PANEL RUNS THE COLUMN ────────────────────────────
// Every block, the table and both documents end at one right edge. A help
// panel capped at 68ch beside them was the last of the four widths v3.54.0
// began removing, and `panelWide` is the opt-in that closes it.
{
  const src = stripComments(readFileSync(join(NEXT, 'views/memory.js'), 'utf8'));
  ok('the centre header asks for the wide panel',
    /renderViewHeader\(\{[\s\S]{0,400}panelWide: true/.test(src), 'panelWide is not passed');
  // EXECUTED, not merely present: the component has to emit the class.
  const head = renderViewHeader({
    eyebrow: 'x', title: 'Agent memory', info: '<p>hi</p>', infoHtml: true, panelWide: true,
  });
  ok('...and the component really emits the modifier on the panel',
    /class="tx-vh-panel tx-vh-panel-wide"/.test(head), head);
  ok('CONTROL: without the opt-in the panel keeps the prose cap',
    /class="tx-vh-panel"/.test(renderViewHeader({ title: 'x', info: 'y' })));
  ok('...and the opt-in is `=== true`, so a stray string cannot widen a panel',
    !/tx-vh-panel-wide/.test(renderViewHeader({ title: 'x', info: 'y', panelWide: 'yes' })));
  // AND THE CLASS IS DEFINED, with the value that makes it mean anything.
  const txCss = readFileSync(join(NEXT, 'shared/text.css'), 'utf8');
  ok('shared/text.css defines .tx-vh-panel-wide as max-width: none',
    /\.tx-vh-panel-wide \{[^}]*max-width:\s*none/.test(txCss));
  ok('...and it is declared AFTER .tx-vh-panel, so the cascade resolves it',
    txCss.indexOf('.tx-vh-panel-wide {') > txCss.indexOf('.tx-vh-panel {'));
}

// ── 18i · FIVE BLOCKS, ONE RHYTHM, AND LEDES YOU CAN READ ─────────────
//
// The page is `renderBlock`s now, which means it inherits the rule v3.54.0 set
// for Settings: a bold title, a lede of at most TWENTY VISIBLE WORDS, and
// everything longer behind the block's own ⓘ. That rule is what stopped
// Providers & keys being "a sea of information", and a page that adopts the
// component without adopting the rule gets the component's chrome and the old
// page's prose.
//
// ENFORCED OVER THE RENDERED PAGE, not over the call sites: a lede passed as a
// composed fragment is still a lede when it reaches the reader.
{
  const nowIso = new Date().toISOString();
  const full = {
    activeDomain: 'acme', activeProject: 'lumina', scope: 'main', machine: 'boxa',
    detailLoading: false, staleWrite: true, journalLimit: 10, openFolds: {}, projects: [],
    projectRead: {
      scopes: [{ scope: 'main', machine: 'boxa', headline: 'x', writtenAgeSeconds: 120, writtenAt: nowIso }],
      savedCopies: 1, distinctScopeCount: 1,
      brief: { present: true, text: '# B\n\n## Goal\n\nShip it.', updatedAt: nowIso },
    },
    detail: {
      scope: 'main', machine: 'boxa', machines: [],
      current: { present: true, writtenAgeSeconds: 120, writtenAt: nowIso, text: '## Where\n\nx' },
      journal: { returned: 1, total: 1, totalUnknown: false,
        entries: [{ at: nowIso, headline: 'h', harness: 'claude-code', rejections: [] }] },
    },
  };
  const page = makeRenderers(full).renderProject();

  // ── FIVE BLOCKS, NAMED ────────────────────────────────────────────────
  const ids = [...page.matchAll(/settings-block-(memory-[a-z]+)\b/g)].map((m) => m[1]);
  const uniq = [...new Set(ids)];
  eq('the page is FIVE blocks, in the order the design names them',
    uniq.join(','), 'memory-status,memory-streams,memory-handoff,memory-brief,memory-journal');

  // ── UNNUMBERED, DELIBERATELY ──────────────────────────────────────────
  // shared/block.js's own note: a numeral is an argument for SEQUENCE, and
  // these five are readings about one project rather than steps.
  eq('every one of them is unnumbered — this page is not a sequence of steps',
    (page.match(/settings-block-unnumbered/g) || []).length, 5);
  ok('...so no numeral is emitted at all', !page.includes('settings-block-num'));

  // ── ≤ 20 VISIBLE WORDS PER LEDE ─────────────────────────────────────────
  const ledes = [...page.matchAll(/<p class="settings-job-lede settings-block-lede">([\s\S]*?)<\/p>/g)]
    .map((m) => m[1]
      // The ⓘ button is emitted INSIDE the lede paragraph; its accessible
      // name is not prose the reader sees as part of the sentence.
      .replace(/<button[\s\S]*?<\/button>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/g, 'x')
      .trim());
  eq('every block carries a lede (the scan is not vacuous)', ledes.length, 5);
  for (const lede of ledes) {
    const words = lede.split(/\s+/).filter(Boolean).length;
    ok('lede is at most 20 visible words (' + words + '): "' + lede.slice(0, 60) + '…"',
      words <= 20 && words > 0, lede);
  }

  // ── THE DEPTH IS BEHIND THE MARK, AND IT IS REALLY THERE ──────────────
  eq('every block carries an ⓘ with a panel of its own',
    (page.match(/data-tx-info="settings-block-info-memory-/g) || []).length, 5);
  eq('...and every one of those panels is hidden on first paint',
    (page.match(/class="tx-vh-panel" id="settings-block-info-memory-[a-z]+" role="group"[^>]*hidden>/g) || []).length, 5);

  // ── WHAT MAY NEVER FOLD (v3.16.1) ─────────────────────────────────────
  // A warning behind a click is not a warning. The Reload offer, the save
  // verdicts and the "state on disk we are not reading" note are in block ①'s
  // BODY, and this proves it by position rather than by reading the source.
  // Over the PANELS' own contents rather than by offset: renderBlock emits the
  // fold BEFORE the body, so a positional check reads the wrong way round —
  // found by writing it that way first and watching it fail on correct output.
  const panels = [...page.matchAll(/<div class="tx-vh-panel"[^>]*hidden>([\s\S]*?)<\/div>/g)]
    .map((m) => m[1]);
  eq('CONTROL: the five folds were really found (the scan is not vacuous)', panels.length, 5);
  const bodies = [...page.matchAll(/<div class="settings-block-body">([\s\S]*)$/g)].map((m) => m[1]);
  ok('CONTROL: at least one block body was found', bodies.length >= 1);
  for (const marker of ['id="mem-reload"', 'mem-save-line', 'mem-working', 'mem-note-loud']) {
    ok('`' + marker + '` is never inside a fold — a warning behind a click is not a warning',
      panels.every((x) => !x.includes(marker)));
  }
  for (const marker of ['id="mem-reload"', 'mem-save-line', 'mem-working']) {
    ok('...and `' + marker + '` really is on the page, so the check above is not vacuous',
      page.includes(marker));
  }
}

// ── 18j · THE SPACING INSIDE A BLOCK IS ITS OWN, AND SMALLER ────────────
//
// Two levels, two owners, two values. shell.css's
// `.settings-job-block + .settings-job-block` owns 24 | hairline | 24 BETWEEN
// blocks; `.mem-status-stack` owns the gap between the reading, the Reload
// offer and the unlisted note INSIDE block ①. Spacing those three at the block
// rhythm would read as three sections rather than as one reading with its
// caveats — and this view must not restate the block rhythm itself, or there
// would be two declarations of one gap, which is the drift the foundation
// removed.
{
  const css = viewCss.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('the status block stacks its notices in a column with its OWN gap',
    /\.mem-status-stack \{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*gap:\s*var\(--space-5\)/
      .test(css), (/\.mem-status-stack \{[^}]*\}/.exec(css) || [''])[0]);
  ok('...and that gap is SMALLER than the between-block rhythm, so a block '
    + 'break still reads as larger than a paragraph break',
    /--space-5/.test((/\.mem-status-stack \{[^}]*\}/.exec(css) || [''])[0])
    && !/--space-12/.test((/\.mem-status-stack \{[^}]*\}/.exec(css) || [''])[0]));
  ok('this view does NOT restate the block-to-block rhythm — shell.css owns it',
    !/\.settings-job-block \+ \.settings-job-block/.test(css));
  ok('...but it DOES bridge from a plain section into the first block, at the '
    + 'same value, so the step in is the same size as every step after it',
    /\.mem-section \+ \.settings-job-block \{[^}]*margin-top:\s*var\(--space-12\)/.test(css));
  ok('CONTROL: shell.css really is where the block rhythm lives',
    /\.settings-job-block \+ \.settings-job-block \{[^}]*margin-top:\s*var\(--space-12\)/
      .test(readFileSync(join(NEXT, 'shell.css'), 'utf8')));
  // THE BLOCK'S OWN TOOLBAR ROW, which is how block ④ gets a control beside
  // its title without `renderBlock` growing an actions slot.
  ok('the brief\'s toolbar row is declared, right-aligned and spaced',
    /\.mem-block-toolbar \{[^}]*justify-content:\s*space-between[^}]*margin-bottom:\s*var\(--space-4\)/
      .test(css));
}

// ── 18f · memory.css: one column, one rhythm ──────────────────────
{
  const css = viewCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleOf = (sel) => {
    const i = css.indexOf(sel + ' {');
    return i === -1 ? null : css.slice(i, css.indexOf('}', i));
  };
  ok('ONE adjacency rule owns every gap, at the Domains rhythm (24px)',
    /\.mem-section \+ \.mem-section \{[^}]*margin-top:\s*var\(--space-12\)/.test(css),
    'the .mem-section adjacency rule is missing or is not --space-12');
  for (const sel of ['.mem-save', '.mem-doc-card', '.mem-fold']) {
    const r = ruleOf(sel);
    ok(sel + ' exists', !!r);
    ok(sel + ' no longer caps ITS BOX at the prose measure — that is what left four '
      + 'different right edges on one page', !!r && !/max-width/.test(r), r || '');
  }
  // ── REVERSED IN v3.55.0, DELIBERATELY ──────────────────────────────────
  // v3.54.0 moved the measure cap off the three CARDS and onto the TEXT, and
  // asserted it HERE. That was right for a document and wrong for this page:
  // the handoff body, the standing brief, the "summary shortened" explanation
  // and the header's ⓘ panel all stopped at 68ch — roughly 47% of the 1200px
  // column — while the session journal beside them ran the full width. The
  // maintainer's verdict was "not okay" and "the page reads endlessly long",
  // and the mechanism is that everything on it was half as wide as its space.
  //
  // A measure cap is a rule about READING PROSE. This screen is a dashboard —
  // a status strip, a table, a document you scan for headings, a brief you
  // edit — so the cap is gone from the view entirely and the assertion is now
  // that it is ABSENT. It survives where it belongs: `.settings-job-lede`
  // caps a block's lede at 66ch in shell.css, because a lede IS a sentence.
  for (const sel of ['.mem-doc', '.mem-doc-headline', '.mem-save-line']) {
    const r = ruleOf(sel);
    ok(sel + ' exists', !!r);
    ok(sel + ' no longer caps the TEXT either — every block on this page runs '
      + 'the column, which is what a dashboard is', !!r && !/max-width/.test(r), r || '');
  }
  ok('...and `--prose-max` appears nowhere in this stylesheet at all',
    !/var\(--prose-max\)/.test(css), (/[^\n]*var\(--prose-max\)[^\n]*/.exec(css) || [''])[0]);
  // ANTI-VACUITY: `ruleOf` finds a rule by an exact `"<sel> {"` substring, so a
  // reformat would make all three read as absent and the `max-width` checks
  // would pass over nothing. The `exists` assertions above cover that, and this
  // proves the extractor itself still finds a cap when there is one to find.
  ok('CONTROL: ruleOf really would see a max-width — shell.css still caps the lede',
    /max-width:\s*66ch/.test(readFileSync(join(NEXT, 'shell.css'), 'utf8')));
  ok('the lead fold is marked with the accent, and only the lead fold',
    /\.mem-fold-lead \{[^}]*var\(--accent\)/.test(css)
    && !/\.mem-fold \{[^}]*var\(--accent\)/.test(css));
  ok('...and it is a rule plus weight plus elevation, not colour alone',
    /\.mem-fold-lead \{[^}]*border-left:[^;]*var\(--accent\)[\s\S]*?box-shadow:\s*var\(--elev-1\)/.test(css));
  ok('no block declares its own top or bottom margin to fight the one rule',
    !/\.mem-(save|stale|controls|doc-card|fold|project-head) \{[^}]*margin-(top|bottom):/.test(css),
    'a section still carries its own margin');
  ok('the pip STILL carries no transition (every render replaces the pane)',
    !/\.mem-save-pip[^{]*\{[^}]*transition/.test(css));
}

// ═════════════════════════════════════════════════════════════════════════
section('§17 — COVERAGE CENSUS — a new function cannot arrive untested in silence');
// ═════════════════════════════════════════════════════════════════════════
//
// 17 of this view's 34 top-level functions were never executed by anything and
// 16 were never even NAMED. A census enumerated FROM DISK (never a hardcoded
// list — that is how the v3.11.0 guard went blind) forces the next person
// adding one to make a decision rather than to inherit a silent gap.

const TOP_LEVEL_FNS = [...viewNoComments.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)]
  .map((m) => m[1]);

// Executed somewhere above, with real assertions over what they returned/did.
const EXECUTED = new Set([
  'formatAge', 'projectMetaLine', 'splitHandoffPreamble',
  // The freshness surface (v3.31.0). All six are lifted from live source by
  // §6's makeRenderers and reached through renderProject, which §6/§14 execute;
  // effectiveSave is additionally lifted into §5 and §11.
  //
  // `freshnessStep` IS NOT ON THIS LIST ANY MORE, and its absence is the
  // point: this census is taken over memory.js's own top-level functions, and
  // that one now lives in shared/age.js as one half of the app-wide freshness
  // scale. §6 still lifts and runs it — from there — so the strip is executed
  // exactly as before; naming it here would make the census claim a function
  // this file does not contain. scripts/test-freshness-scale.js owns it now.
  'effectiveSave', 'renderSaveStatus', 'newestPair', 'harnessOf',
  'firstNote', 'saveLine',
  // v3.55.0: the two pickers became a table, and the page became five blocks.
  'renderWorkStreams', 'workStreamCounts', 'newerOnAnotherMachine',
  // v3.55.x: the table's row order, driven directly in §6c and folded into
  // screenSignature, which §11/§6c both execute.
  'workStreamOrder',
  'briefStats', 'briefDismissDecision',
  'renderHandoff', 'renderJournal', 'renderBrief', 'aboutInfoHtml',
  'renderEmptyProject', 'renderStaleNotice', 'renderUnlistedNote', 'renderBriefOnlyNotice',
  'unlistedCount', 'renderCopyOutcome', 'renderProject',
  'render', 'captureFocus', 'restoreFocus',
  'screenSignature', 'nextPollDelay', 'stopPoll', 'schedulePoll',
  'fetchIndex', 'fetchState', 'refreshIndex', 'refreshScopeList', 'reloadActive', 'loadScope',
  // v3.48.0 — projects inside a domain. All eight are lifted and run in §16.
  'keyOf', 'activeKey', 'initialPick', 'renderProjectGroups',
  'readRememberedProjects', 'rememberProject', 'renderBriefEditor', 'saveBrief',
  // The age clock (§18). Lifted and driven against a fake document, with a
  // render spy proving it never reaches for one.
  'tickAges',
]);

// NOT executed, each with the reason it is not — so the gap is a decision on
// the record rather than an omission nobody noticed.
const NOT_EXECUTED = {
  freshState: 'a literal factory with no branches; every field it returns is exercised through the state fixtures',
  renderSidebar: 'setSidebar/setMain need a real DOM; §12 proves render() calls it, §9 proves the token is passed',
  renderMain: 'same — DOM-bound; its three branches are the render* functions §6/§14 execute directly',
  renderNoProjects: 'a constant string with no inputs and no branches',
  loadIndex: 'orchestration over fetchIndex + selectProject, both executed; its own logic is one sort, covered by §2',
  selectProject: 'orchestration over fetchState + loadScope, both executed; reloadActive (§15) covers the same shape',
  wire: 'addEventListener over a real DOM; its call targets are executed and its call sites are counted',
  copyAgentInstructions: 'needs navigator.clipboard; EXECUTED for real (both the granted and the refused arm, plus the switch-mid-copy stamp) in test-agent-instructions.js, which lifts it from this same file',
};

ok('the census enumerated this view\'s top-level functions FROM DISK',
  TOP_LEVEL_FNS.length >= 30, 'found ' + TOP_LEVEL_FNS.length);
{
  const unaccounted = TOP_LEVEL_FNS.filter((n) => !EXECUTED.has(n) && !(n in NOT_EXECUTED));
  ok('every top-level function is either EXECUTED here or listed with a reason it is not',
    unaccounted.length === 0, 'unaccounted for: ' + JSON.stringify(unaccounted));
  const stale = [...EXECUTED, ...Object.keys(NOT_EXECUTED)].filter((n) => !TOP_LEVEL_FNS.includes(n));
  ok('...and neither list names a function that no longer exists',
    stale.length === 0, 'stale entries: ' + JSON.stringify(stale));
  ok('the EXECUTED set is the majority of the file, not a token few',
    EXECUTED.size >= TOP_LEVEL_FNS.length - Object.keys(NOT_EXECUTED).length,
    EXECUTED.size + ' executed of ' + TOP_LEVEL_FNS.length);

  // THE CENSUS MUST NOT BE TAKEN ON TRUST. `EXECUTED` is hand-maintained, so
  // on its own it is a claim rather than a measurement — deleting a whole
  // section would leave it still asserting that section's functions run. Every
  // name in it is therefore required to appear in a real extractFunction call
  // in THIS file, which is the only way a module-private function can be
  // reached at all. It does not prove an assertion was made about the result;
  // it does prove the function was lifted out of live source to be run.
  const selfSrc = readFileSync(join(ROOT, 'scripts/test-next-memory-view.js'), 'utf8');
  const lifted = new Set([...selfSrc.matchAll(/extractFunction\(viewSrc,\s*'([A-Za-z0-9_$]+)'/g)].map((m) => m[1]));
  const claimed = [...EXECUTED].filter((n) => !lifted.has(n));
  ok('every function the census claims is EXECUTED is genuinely lifted from live source here',
    claimed.length === 0, 'claimed but never lifted: ' + JSON.stringify(claimed));
  ok('self-test: the lifted-set scan is not vacuous (it found the real extractions)',
    lifted.size >= 15, 'found ' + lifted.size);
}

// ── Done ─────────────────────────────────────────────────────────────────

cleanup();
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ All Agent-memory route + view assertions green');
else console.log('❌ ' + failed + ' Agent-memory assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
