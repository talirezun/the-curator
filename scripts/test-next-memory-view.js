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
} from '../src/public/next/shared/text.js';

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
await ws.saveWorkingState('shared-cohort', {
  scope: 'main', headline: 'Mirror state', nowState: 'From a cohort member.',
  harness: 'claude-code', model: 'claude-opus-5',
});

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

ok('the router registers exactly 2 routes (index + project)', ROUTES.length === 2, 'got ' + ROUTES.length);
ok('every registered route is GET-only',
  ROUTES.every((r) => r.methods.length === 1 && r.methods[0] === 'get'),
  JSON.stringify(ROUTES.map((r) => [r.path, r.methods])));
ok('the index route is mounted at "/"', ROUTES.some((r) => r.path === '/'));
ok('the project route is mounted at "/:project"', ROUTES.some((r) => r.path === '/:project'));

const routeSrc = readFileSync(join(ROOT, 'src/routes/memory.js'), 'utf8');
// Source-level class guard: no write-shaped call may appear in this file.
// Deliberately checked as CALLS (`name(`), so the words are still free to
// appear in the docblock that explains why they must not.
for (const forbidden of [
  'writeFile(', 'writeFileSync(', 'appendFile(', 'appendFileSync(', 'mkdir(', 'mkdirSync(',
  'rm(', 'rmSync(', 'unlink(', 'rename(', 'writePage(', 'saveWorkingState(', 'saveProjectBrief(',
]) {
  ok('route source contains no ' + forbidden + ' call', !routeSrc.includes(forbidden));
}
for (const verb of ['router.post', 'router.put', 'router.delete', 'router.patch', 'router.all']) {
  ok('route source registers no ' + verb, !routeSrc.includes(verb));
}
// Checked as an IMPORT, not as the word: this file's own docblock explains
// WHY there is no write-registry registration, and a bare substring scan
// would fire on that explanation. (It did, on the first run.)
ok('route source does not IMPORT the write-registry (nothing to guard)',
  !/^import[^;]*write-registry/m.test(routeSrc));

// ═════════════════════════════════════════════════════════════════════════
section('§2 — GET /api/memory (the index)');
// ═════════════════════════════════════════════════════════════════════════

const before = fingerprint(DOMAINS);
const idx = await call('/');
eq('index responds 200', idx.status, 200);
ok('index is ok', idx.body && idx.body.ok === true);
const byName = Object.fromEntries((idx.body.projects || []).map((p) => [p.project, p]));
eq('index lists every domain, not only those with state', Object.keys(byName).length, 3);

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

// A fact and its ABSENCE stay apart — the whole point.
eq('a project with no state reports scopeCount 0', (byName.blank || {}).scopeCount, 0);
eq('a project with no state reports lastWriteAt NULL, never an epoch', (byName.blank || {}).lastWriteAt, null);
eq('a project with no state reports ageSeconds NULL, never 0', (byName.blank || {}).ageSeconds, null);
eq('a project with no state reports hasBrief false', (byName.blank || {}).hasBrief, false);
eq('a project with no state reports headline NULL', (byName.blank || {}).headline, null);

ok('the shared mirror appears in the index like any other project', !!byName['shared-cohort']);

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
    extractFunction(viewSrc, 'freshnessStep', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'newestPair', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'harnessOf', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'firstNote', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'saveLine', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderSaveStatus', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'splitHandoffPreamble', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderScopeControls', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderHandoff', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderJournal', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderBrief', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderAbout', 'memory.js') + '\n' +
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
    extractFunction(viewSrc, 'renderProject', 'memory.js') + '\n' +
    // The REAL component render path, with its own helpers, so the escaping
    // assertions below cover it too.
    extractFunction(listboxSrc, 'normaliseOptions', 'listbox.js') + '\n' +
    extractFunction(listboxSrc, 'findOption', 'listbox.js') + '\n' +
    extractFunction(listboxSrc, 'triggerLabelFor', 'listbox.js') + '\n' +
    extractFunction(listboxSrc, 'renderListboxHtml', 'listbox.js') + '\n' +
    'return { renderScopeControls, renderHandoff, renderJournal, renderBrief, renderAbout, ' +
    'renderEmptyProject, renderStaleNotice, renderUnlistedNote, renderBriefOnlyNotice, ' +
    'unlistedCount, renderProject, renderSaveStatus, freshnessStep, effectiveSave, pendingListboxes };';
  return new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'gatedLoader', 'loadGate',
    'JOURNAL_PAGE', 'JOURNAL_MORE', 'pendingListboxes',
    // The real shared text renderers, so §6's escaping battery runs through
    // the component that actually paints these sentences rather than past it.
    'renderDescription', 'renderStatus', 'renderReadout', 'renderReadoutGroup',
    'renderBadge', 'renderExplainer', body)(
    stateObj, escapeHtml, () => '<svg></svg>', renderMarkdown, () => '<div class="loader"></div>', null, 10, 50, [],
    renderDescription, renderStatus, renderReadout, renderReadoutGroup, renderBadge, renderExplainer);
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
  R.renderScopeControls([{ scope: XSS }, { scope: 'other' }]),
  R.renderHandoff(),
  R.renderJournal(),
  R.renderBrief(hostileState.projectRead, false),
  R.renderAbout(),
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
  R.renderBrief(hostileState.projectRead, false).includes('chat-md-h'));

// Cross-machine badge: positive evidence only.
ok('an explicit machineIsThisMachine:false renders the cross-machine badge',
  R.renderScopeControls([{ scope: XSS }]).includes('mem-badge-attn'));
{
  const absent = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, machineIsThisMachine: undefined },
  });
  ok('an ABSENT machineIsThisMachine renders NO badge (a fact is not its absence)',
    !absent.renderScopeControls([{ scope: 'a' }]).includes('mem-badge-attn'));
}
{
  const same = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, machineIsThisMachine: true },
  });
  ok('machineIsThisMachine:true renders NO badge',
    !same.renderScopeControls([{ scope: 'a' }]).includes('mem-badge-attn'));
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
{
  const one = makeRenderers({
    ...hostileState,
    scope: 'only',
    detail: { ...hostileDetail, machine: 'only-machine', machines: [{ machine: 'only-machine', ageSeconds: 5 }] },
  });
  const out = one.renderScopeControls([{ scope: 'only' }]);
  ok('a single scope renders a static label, not a one-option <select>', !out.includes('id="mem-scope-select"'));
  ok('a single machine renders a static label, not a one-option <select>', !out.includes('id="mem-machine-select"'));
  ok('...and the values are still shown', out.includes('only') && out.includes('only-machine'));
}
{
  const many = makeRenderers(hostileState);
  const out = many.renderScopeControls([{ scope: 'a' }, { scope: 'b' }]);
  ok('two scopes render a <select>', out.includes('id="mem-scope-select"'));
  ok('two machines render a <select>', out.includes('id="mem-machine-select"'));
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
ok('the fixture rendered at least 3 <summary> elements (the scan is not vacuous)',
  allSummaries.length >= 3, 'found ' + allSummaries.length);
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
section('§8 — The view has no write path');
// ═════════════════════════════════════════════════════════════════════════

// STRUCTURAL, NOT A LIST OF LITERAL STRINGS. The five-string version of this
// scan was defeated by `const M = 'PO' + 'ST'` — a planted write survived it
// intact. What actually makes this view read-only is that no fetch it issues
// carries a REQUEST INIT at all: `fetch(url)` with one argument can only ever
// be a GET, whatever the method name is spelled like. So the argument count is
// what is asserted, and the method vocabulary is a second, weaker layer.
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
ok('EVERY fetch in the view is single-argument — structurally a GET, whatever a method string is spelled like',
  fetchArgLists.every((a) => topLevelArgs(a).length === 1),
  JSON.stringify(fetchArgLists.map((a) => topLevelArgs(a).length)));
// Positive control: the detector must SEE an init object, including one whose
// method is assembled at runtime — the exact mutation the string list missed.
ok('self-test: the argument-count scan DOES fire on a runtime-assembled method',
  topLevelArgs(fetchCallArgs("const M='PO'+'ST'; await fetch(u, { method: M, body: b });")[0]).length === 2);
ok('self-test: the argument-count scan does NOT fire on a plain read',
  topLevelArgs(fetchCallArgs("await fetch('/api/memory');")[0]).length === 1);

// A request init cannot arrive by any other door either: no `method:` key
// anywhere in real code (comments stripped, so the docblock explaining the
// rule cannot satisfy or violate it), and no alternative transport.
ok('no `method:` property key appears anywhere in the view\'s real code',
  !/\bmethod\s*:/.test(viewNoComments));
for (const transport of ['XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'FormData', 'Request(']) {
  ok('the view never reaches for ' + transport + ' (fetch is not the only way to write)',
    !viewNoComments.includes(transport));
}
ok('the view fetches only /api/memory endpoints', (() => {
  const urls = [...viewNoComments.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
  const built = viewNoComments.includes("fetch('/api/memory/' + encodeURIComponent(project)");
  return urls.every((u) => u.startsWith('/api/memory')) && built;
})());
// Import-scoped for the same reason as the route check above: the view's
// docblock explains why it does not join the cross-view write gate, and
// names beginDomainWrite while doing so.
ok('the view never IMPORTS a write helper from the shell', (() => {
  const imports = viewSrc.match(/^import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/gm) || [];
  return imports.length > 0 && !imports.some((i) => /beginDomainWrite|registerWrite/.test(i));
})());
ok('the view escapes the project slug into the URL', viewSrc.includes('encodeURIComponent(project)'));

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
  // within its own statement. Line-scoped and therefore fail-safe.
  const lines = viewNoComments.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/set(?:Sidebar|Main)\(/.test(lines[i])) continue;
    seen++;
    const chunk = lines.slice(i, i + 12).join('\n');
    if (!/\btoken\b/.test(chunk)) return false;
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
    // screenSignature now folds the save-status strip's own readings through
    // effectiveSave + formatAge, so a save into another scope of the same
    // project — or the reading simply ageing into the next band — repaints.
    extractFunction(viewSrc, 'effectiveSave', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'newestPair', 'memory.js') + '\n' +
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

  // Duplicated pairs are one option in the <select>, so they must not read as
  // a change — renderScopeControls deduplicates and so must the signature.
  const dupes = liveState();
  dupes.projectRead = { scopes: [{ scope: 'memory-view' }, { scope: 'memory-view' }, { scope: 'main' }] };
  ok('screenSignature deduplicates pairs the way the <select> does',
    sigOf(dupes) === sigOf(base));

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

function mountView({ hidden = false, mounted = true } = {}) {
  const log = { scheduled: [], stopped: 0, gateCancelled: 0, closedListboxes: 0, renders: [], loadIndex: 0, refresh: 0 };
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
    'let state, myMountToken, loadGate, wakeHandler;\n' +
    'const __view = {' + liftOnEnter() + '};\n' +
    'return { onEnter: __view.onEnter, wake: () => wakeHandler, token: () => myMountToken };';

  const api = new Function(
    'freshState', 'createLoadingGate', 'isCurrentMount', 'render', 'loadIndex',
    'reportAsyncMountFailure', 'refreshIndex', 'schedulePoll', 'stopPoll',
    'closeAllListboxes', 'window', 'document', body)(
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
    win, doc);

  return { ...api, log, listeners, setMounted: (v) => { mounted = v; }, setHidden: (v) => { doc.hidden = v; } };
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
  eq('teardown: view-owned popovers are closed', m.log.closedListboxes, 1);
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
  const held = makeFocusRig({ activeId: 'mem-machine-select', presentIds: [], detailLoading: true });
  held.captureFocus();
  held.restoreFocus();
  eq('a miss is HELD while another render is still coming (a scope change renders twice)',
    held.pending(), 'mem-machine-select');
  const dropped = makeFocusRig({ activeId: 'mem-machine-select', presentIds: [], detailLoading: false });
  dropped.captureFocus();
  dropped.restoreFocus();
  eq('...and is DROPPED once no further render is coming, so it cannot fire later out of context',
    dropped.pending(), null);
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
  for (const [name, out] of [['FULL', full], ['BRIEF-ONLY', briefOnly], ['EMPTY', empty]]) {
    ok('the save-status strip reaches the ' + name + ' branch',
      out.includes('class="mem-save"'), out.slice(0, 200));
    ok('...and it is painted ABOVE the reload notice there',
      out.indexOf('class="mem-save"') < out.indexOf('class="mem-stale"'),
      out.indexOf('class="mem-save"') + ' vs ' + out.indexOf('class="mem-stale"'));
  }
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
section('§16 — COVERAGE CENSUS — a new function cannot arrive untested in silence');
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
  // The freshness surface (v3.31.0). All seven are lifted from live source by
  // §6's makeRenderers and reached through renderProject, which §6/§14 execute;
  // effectiveSave is additionally lifted into §5 and §11.
  'effectiveSave', 'freshnessStep', 'renderSaveStatus', 'newestPair', 'harnessOf',
  'firstNote', 'saveLine',
  'renderScopeControls', 'renderHandoff', 'renderJournal', 'renderBrief', 'renderAbout',
  'renderEmptyProject', 'renderStaleNotice', 'renderUnlistedNote', 'renderBriefOnlyNotice',
  'unlistedCount', 'renderProject',
  'render', 'captureFocus', 'restoreFocus',
  'screenSignature', 'nextPollDelay', 'stopPoll', 'schedulePoll',
  'fetchIndex', 'fetchState', 'refreshIndex', 'refreshScopeList', 'reloadActive', 'loadScope',
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
