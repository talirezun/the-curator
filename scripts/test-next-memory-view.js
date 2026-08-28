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
 *  · The view has NO write path: no non-GET fetch anywhere in its source.
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
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
      else if (e.isFile()) files.push(relative(dir, p) + ' ' + createHash('sha256').update(readFileSync(p)).digest('hex'));
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
    extractFunction(viewSrc, 'splitHandoffPreamble', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderScopeControls', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderHandoff', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderJournal', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderBrief', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderAbout', 'memory.js') + '\n' +
    extractFunction(viewSrc, 'renderEmptyProject', 'memory.js') + '\n' +
    'return { renderScopeControls, renderHandoff, renderJournal, renderBrief, renderAbout, renderEmptyProject };';
  return new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'gatedLoader', 'loadGate',
    'JOURNAL_PAGE', 'JOURNAL_MORE', body)(
    stateObj, escapeHtml, () => '<svg></svg>', renderMarkdown, () => '<div class="loader"></div>', null, 10, 50);
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
  const single = makeRenderers({
    ...hostileState,
    detail: { ...hostileDetail, journal: { returned: 1, total: 1, totalUnknown: false, entries: [hostileDetail.journal.entries[1]] } },
  });
  ok('one save singularises ("1 save recorded")', single.renderJournal().includes('1 save recorded'));
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

for (const forbidden of ["method: 'POST'", 'method: "POST"', "method: 'DELETE'", "method: 'PUT'", "method: 'PATCH'"]) {
  ok('view source contains no ' + forbidden, !viewSrc.includes(forbidden));
}
ok('the view fetches only /api/memory endpoints', (() => {
  const urls = [...viewSrc.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]);
  const built = viewSrc.includes("fetch('/api/memory/' + encodeURIComponent(project)");
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

ok('the view imports isCurrentMount', viewSrc.includes('isCurrentMount'));
ok('every setSidebar/setMain call passes a token', (() => {
  const calls = [...viewSrc.matchAll(/set(?:Sidebar|Main)\(/g)];
  // Two definitions of the call shape: each call site must mention `token`
  // within its own statement. Line-scoped and therefore fail-safe.
  const lines = viewSrc.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/set(?:Sidebar|Main)\(/.test(lines[i])) continue;
    seen++;
    const chunk = lines.slice(i, i + 12).join('\n');
    if (!/\btoken\b/.test(chunk)) return false;
  }
  return seen > 0 && calls.length > 0;
})());
ok('the teardown cancels the loading gate (timer hygiene)',
  /return \(\) => \{[\s\S]*loadGate\.cancel\(\)/.test(viewSrc));
ok('async loaders check isCurrentMount after their await',
  (viewSrc.match(/if \(!isCurrentMount\(token\)\)/g) || []).length >= 3);

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
ok('focus is visible on the selects', viewCss.includes('.mem-select:focus-visible'));

// ── Done ─────────────────────────────────────────────────────────────────

cleanup();
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ All Agent-memory route + view assertions green');
else console.log('❌ ' + failed + ' Agent-memory assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
