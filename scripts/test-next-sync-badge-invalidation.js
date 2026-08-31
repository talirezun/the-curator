/**
 * test-next-sync-badge-invalidation.js — OFFLINE suite.
 *
 * No network, no API key, no server, no browser, no spawned child.
 *
 * Two questions, and they are deliberately in one file because the second
 * only means anything once the first has been answered.
 *
 * ── §1. Did v3.31.0's hidden-window gating change a VISIBLE window? ─────
 *
 * v3.31.0 (commit 6f1c22d) put a `document.hidden` guard in front of the
 * shell's two badge timers and added a focus/visibilitychange wake handler.
 * A pending-change badge then turned out to be stale in the packaged app,
 * so the first thing to establish is whether that commit is responsible.
 *
 * The method is a DIFFERENTIAL: extract the function the shell installs on
 * the badge interval from the revision BEFORE the gating and from the
 * working tree, and drive both through the same seam over the same matrix
 * of visibility inputs. Agreement on every visible-window input exonerates
 * the commit; disagreement is the regression.
 *
 * THE TRAP THIS FILE IS BUILT NOT TO FALL INTO — recorded in this project's
 * history: a differential pinned to the moving ref `HEAD` compares a
 * function against ITSELF the moment the change is committed, and passes
 * while proving nothing. So §1a pins a REAL 40-character SHA, asserts git
 * resolves it, asserts it is NOT HEAD, and — the assertion that actually
 * closes the hole — asserts the two extracted TEXTS DIFFER before any
 * behaviour is compared. If a future edit makes them identical, this file
 * goes red rather than quietly becoming vacuous.
 *
 * ── §2. The real defect: nothing invalidated the badge after a write ────
 *
 * /next refreshed the badge on boot, on every navigate(), on a 60s timer
 * and on the batch-queue 'exit' transition — and on no other event. A
 * finished single-file ingest, a Health fix, a domain deletion: none of
 * them told the badge anything, so the interval did all the work and the
 * number was stale by construction for up to a minute.
 *
 * §2 covers the fix BEHAVIOURALLY. The real beginDomainWrite() closure and
 * its real helpers are extracted and executed in a sandbox with a spy
 * standing in for refreshSyncBadge(), so every assertion is "did the spy
 * get called", never "does the source contain a call" — a call that is
 * present but unreachable would still satisfy a grep.
 *
 * ── NOT COVERED, stated rather than implied ─────────────────────────────
 *   - Rendering. applySyncBadge() needs a DOM.
 *   - The real fetch() behind refreshSyncBadge(), and whether the server's
 *     `git status --porcelain` is itself correct — that is
 *     test-sync-hygiene.js's and src/brain/sync.js's concern. This file
 *     covers only WHETHER AND WHEN the refresher is invoked.
 *   - Compile-to-Wiki. It writes many wiki pages and does NOT register a
 *     client-side write gate (src/public/next/views/chat.js has no
 *     beginDomainWrite call), so the fix in §2 does not reach it. §3c
 *     records that as a measured, named gap rather than leaving it to be
 *     rediscovered; it is not asserted as an absence, because an assertion
 *     that compile stays ungated would go red the day someone fixes it.
 *   - Real elapsed intervals in a real event loop.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction helpers ──────────────────────────────────────────────────
// Brace-matched (a nested brace in a body cannot truncate the extraction),
// and a missing name THROWS rather than silently testing nothing — the same
// discipline as scripts/test-next-recovery-and-badge.js, from which these
// two are deliberately copied rather than imported: that file is a test, not
// a module, and importing it would execute its whole suite.
function extractFunction(src, name, label) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i);
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

// `new Function` compiles a script body, not a module, so a leading `export`
// on an extracted declaration is a SyntaxError. Stripped only at the start of
// a line, so an `export` appearing inside a string or comment is untouched.
function noExport(src) { return src.replace(/^export\s+/gm, ''); }

const workingApp = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');

// =======================================================================
section('§1 — v3.31.0 differential: did the hidden-window gate change a VISIBLE window?');
// =======================================================================

// §1a — pin a REAL SHA and prove the comparison is not vacuous.
//
// 58d1b8e1 is 6f1c22d^ — the commit immediately BEFORE "Stop the shell's two
// timers running behind a hidden window". Written out in full, never derived
// from a ref that can move, and never `HEAD`.
const PRE_SHA = '58d1b8e115218aef31cb8b7122815483610a23b7';

ok(/^[0-9a-f]{40}$/.test(PRE_SHA), '§1a PRE_SHA is a full 40-character SHA, not a movable ref');

let preApp = null;
let gitOk = true;
try {
  execFileSync('git', ['cat-file', '-e', `${PRE_SHA}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
  preApp = execFileSync('git', ['show', `${PRE_SHA}:src/public/next/app.js`], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
} catch {
  gitOk = false;
}
ok(gitOk && typeof preApp === 'string' && preApp.length > 0,
  '§1a the pinned revision resolves and carries src/public/next/app.js');

const headSha = gitOk ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim() : '';
ok(gitOk && headSha !== PRE_SHA,
  '§1a the pinned revision is NOT HEAD — a differential against HEAD compares a function with itself');

// THE anti-vacuity assertion. Two identical texts cannot disagree, so a
// behavioural comparison between them proves nothing at all.
ok(gitOk && preApp !== workingApp,
  '§1a the pinned and working-tree texts DIFFER — the differential below is not comparing a file with itself');

// §1b — locate the badge-interval callback in EACH revision, from the source
// rather than from an assumption about its name.
//
// This is what makes the two arms genuinely comparable: whatever identifier
// boot() hands to setInterval IS the behaviour under test, and the two
// revisions do not use the same one (that difference is the change).
function intervalCallbackName(src, constName, label) {
  const m = new RegExp(`setInterval\\(\\s*([A-Za-z0-9_$]+)\\s*,\\s*${constName}\\s*\\)`).exec(src);
  if (!m) throw new Error(`intervalCallbackName: no setInterval(..., ${constName}) in ${label}`);
  return m[1];
}

let preLocalCb = null, postLocalCb = null, preRemoteCb = null, postRemoteCb = null;
let nameErr = null;
try {
  preLocalCb   = intervalCallbackName(preApp, 'SYNC_BADGE_REFRESH_MS', 'pinned');
  postLocalCb  = intervalCallbackName(workingApp, 'SYNC_BADGE_REFRESH_MS', 'working');
  preRemoteCb  = intervalCallbackName(preApp, 'SYNC_REMOTE_REFRESH_MS', 'pinned');
  postRemoteCb = intervalCallbackName(workingApp, 'SYNC_REMOTE_REFRESH_MS', 'working');
} catch (err) { nameErr = err; }
ok(!nameErr, `§1b both revisions arm both badge intervals${nameErr ? ` — ${nameErr.message}` : ''}`);
eq(preLocalCb, 'refreshSyncBadge', '§1b pinned revision ticks the local badge refresher DIRECTLY (no gate)');
eq(preRemoteCb, 'refreshSyncRemoteBadge', '§1b pinned revision ticks the remote badge refresher DIRECTLY (no gate)');
ok(postLocalCb !== preLocalCb, '§1b working tree ticks a DIFFERENT callback for the local badge — the gate is in the path');
ok(postRemoteCb !== preRemoteCb, '§1b working tree ticks a DIFFERENT callback for the remote badge — the gate is in the path');

// §1c — ONE seam, both arms.
//
// Each arm is compiled into the same sandbox shape: spies for the two real
// refreshers, a fake `document`/`window`, and the revision's own interval
// callback invoked by the name its own boot() uses. The pinned arm has no
// wrapper to extract (that is the change), so its callback resolves to the
// spy itself — which is precisely what "the interval called the refresher
// directly" means, not a shortcut.
function makeArm(src, localCbName, remoteCbName, wantWake) {
  const wrappers = [];
  for (const nm of [localCbName, remoteCbName]) {
    if (nm !== 'refreshSyncBadge' && nm !== 'refreshSyncRemoteBadge') {
      wrappers.push(extractFunction(src, nm, 'revision'));
    }
  }
  if (wantWake && /function armSyncBadgeWakeHandler\s*\(/.test(src)) {
    wrappers.push(extractFunction(src, 'armSyncBadgeWakeHandler', 'revision'));
  }
  const hasWake = /function armSyncBadgeWakeHandler\s*\(/.test(src);
  const body =
    wrappers.join('\n\n') + '\n' +
    `return { local: ${localCbName}, remote: ${remoteCbName}, ` +
    `arm: ${hasWake ? 'armSyncBadgeWakeHandler' : 'null'} };`;

  return function run(docState) {
    const calls = { local: 0, remote: 0 };
    const docListeners = {};
    const winListeners = {};
    const fakeDocument = docState === undefined ? undefined : {
      hidden: docState,
      addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    };
    const fakeWindow = {
      addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    };
    const factory = new Function('document', 'window', 'refreshSyncBadge', 'refreshSyncRemoteBadge', body);
    const fns = factory(
      fakeDocument, fakeWindow,
      () => { calls.local++; },
      () => { calls.remote++; },
    );
    return { fns, calls, fakeDocument, docListeners, winListeners };
  };
}

let preRun = null, postRun = null, armErr = null;
try {
  preRun  = makeArm(preApp, preLocalCb, preRemoteCb, true);
  postRun = makeArm(workingApp, postLocalCb, postRemoteCb, true);
} catch (err) { armErr = err; }
ok(!armErr, `§1c both arms compile into the shared seam${armErr ? ` — ${armErr.message}` : ''}`);

// The matrix. `undefined` models a host with no `document` at all — the case
// the guard's own `typeof document !== 'undefined'` clause exists for, and
// the one an inverted or over-eager guard would silently break.
const MATRIX = [
  { name: 'visible window (document.hidden === false)', doc: false, visible: true },
  { name: 'hidden window (document.hidden === true)',   doc: true,  visible: false },
  { name: 'no document at all (non-DOM host)',          doc: undefined, visible: true },
];

for (const row of MATRIX) {
  const a = preRun(row.doc);
  const b = postRun(row.doc);
  a.fns.local(); a.fns.remote();
  b.fns.local(); b.fns.remote();

  if (row.visible) {
    // The exoneration, or the conviction. Equality here on every visible
    // input is the whole claim v3.31.0 made about itself.
    eq(b.calls.local, a.calls.local,
      `§1c ${row.name}: local badge tick behaves IDENTICALLY before and after the gate`);
    eq(b.calls.remote, a.calls.remote,
      `§1c ${row.name}: remote badge tick behaves IDENTICALLY before and after the gate`);
    eq(b.calls.local, 1, `§1c ${row.name}: the local refresher IS called (not merely "the same as a broken baseline")`);
    eq(b.calls.remote, 1, `§1c ${row.name}: the remote refresher IS called`);
  } else {
    // The one input the two are SUPPOSED to disagree on. Asserting the
    // disagreement is what stops §1c passing on a gate that does nothing.
    eq(a.calls.local, 1, `§1c ${row.name}: BEFORE the gate, a hidden window still polled locally`);
    eq(a.calls.remote, 1, `§1c ${row.name}: BEFORE the gate, a hidden window still git-fetched GitHub`);
    eq(b.calls.local, 0, `§1c ${row.name}: AFTER the gate, the local poll is skipped`);
    eq(b.calls.remote, 0, `§1c ${row.name}: AFTER the gate, the GitHub fetch is skipped — v3.31.0's whole point`);
  }
}

// §1d — the wake path is purely ADDITIVE, which is the other half of
// "a visible window is unaffected": the gate can only ever have made a
// visible window refresh MORE often, never less.
{
  const a = preRun(false);
  const b = postRun(false);
  const aListeners = (a.winListeners.focus || []).length + (a.docListeners.visibilitychange || []).length;
  eq(a.fns.arm, null, '§1d pinned revision has NO wake handler to arm — it did not exist before v3.31.0');
  eq(typeof b.fns.arm, 'function', '§1d working tree DOES have one (positive control for the line above)');
  eq(aListeners, 0, '§1d pinned revision installs zero wake listeners');

  b.fns.arm();
  eq((b.winListeners.focus || []).length, 1, '§1d working tree installs exactly one focus listener');
  eq((b.docListeners.visibilitychange || []).length, 1, '§1d working tree installs exactly one visibilitychange listener');

  // Wake while visible: refreshes. Wake while hidden (visibilitychange also
  // fires on the way OUT): declines. Both directions, each from a reset zero
  // so an inverted condition cannot satisfy them by arithmetic coincidence.
  b.calls.local = 0; b.calls.remote = 0;
  b.fakeDocument.hidden = false;
  b.winListeners.focus[0]();
  eq(b.calls.local, 1, '§1d wake on a VISIBLE window refreshes the local badge');
  eq(b.calls.remote, 1, '§1d wake on a VISIBLE window refreshes the remote badge');

  b.calls.local = 0; b.calls.remote = 0;
  b.fakeDocument.hidden = true;
  b.docListeners.visibilitychange[0]();
  eq(b.calls.local, 0, '§1d the visibilitychange that fires on the way OUT does not refresh anything');
  eq(b.calls.remote, 0, '§1d ...including the GitHub fetch');
}

// =======================================================================
section('§2 — the real defect: a completed write must invalidate the badge');
// =======================================================================

// The REAL functions, executed. `_domainWrites`/`_writeGateSubscribers` are
// re-declared here because they are plain module state, not behaviour; every
// function that reads or mutates them is the shipped source.
function makeGateSandbox() {
  const calls = { badge: 0, remote: 0, notify: 0 };
  const body =
    'const _domainWrites = new Map();\n' +
    'const _writeGateSubscribers = new Set();\n' +
    extractFunction(workingApp, '_notifyWriteGateSubscribers', 'next/app.js') + '\n\n' +
    extractFunction(workingApp, '_refreshSyncBadgeIfWritesSettled', 'next/app.js') + '\n\n' +
    noExport(extractFunction(workingApp, 'beginDomainWrite', 'next/app.js')) + '\n\n' +
    noExport(extractFunction(workingApp, 'isAnyWriteBusy', 'next/app.js')) + '\n\n' +
    noExport(extractFunction(workingApp, 'isDomainWriteBusy', 'next/app.js')) + '\n\n' +
    noExport(extractFunction(workingApp, 'onWriteGateChange', 'next/app.js')) + '\n' +
    'return { beginDomainWrite, isAnyWriteBusy, isDomainWriteBusy, onWriteGateChange };';
  const factory = new Function('refreshSyncBadge', 'refreshSyncRemoteBadge', 'console', 'document', body);
  const fns = factory(
    () => { calls.badge++; },
    () => { calls.remote++; },
    { warn() {}, error() {} },
    { hidden: false },
  );
  return { fns, calls };
}

// §2a — THE REGRESSION TEST for the reported defect. An ingest finishing is
// a write handle being released; before this fix nothing on that path told
// the badge anything, and the number stayed as it was until the next
// navigate() or 60s tick — "1" while 33 files were pending.
{
  const { fns, calls } = makeGateSandbox();
  const release = fns.beginDomainWrite('articles', 'ingest');
  eq(calls.badge, 0, '§2a starting a write does NOT refresh the badge (nothing has been written yet)');
  release();
  eq(calls.badge, 1, '§2a a FINISHED ingest refreshes the pending-change badge exactly once');
  eq(calls.remote, 0, '§2a ...and never the REMOTE badge — a local write changes nothing on GitHub');
}

// §2b — coalescing. `git status --porcelain` is repo-wide, so N concurrent
// writes have ONE answer to fetch, not N. The badge must fire on the edge
// where the gate falls idle, not on every release.
{
  const { fns, calls } = makeGateSandbox();
  const a = fns.beginDomainWrite('articles', 'ingest');
  const b = fns.beginDomainWrite('projects', 'health-fix');
  a();
  eq(calls.badge, 0, '§2b releasing ONE of two concurrent writes does not refresh — another write is still landing files');
  eq(fns.isAnyWriteBusy(), true, '§2b ...and the gate correctly still reads busy');
  b();
  eq(calls.badge, 1, '§2b the LAST release refreshes, exactly once for the whole burst');
  eq(fns.isAnyWriteBusy(), false, '§2b ...and the gate is idle');
}

// §2c — two handles on the SAME domain (a batch item plus a manually started
// single ingest, the case beginDomainWrite's own comment names).
{
  const { fns, calls } = makeGateSandbox();
  const a = fns.beginDomainWrite('articles', 'batch ingest');
  const b = fns.beginDomainWrite('articles', 'ingest');
  a();
  eq(calls.badge, 0, '§2c same-domain: first release does not refresh');
  b();
  eq(calls.badge, 1, '§2c same-domain: second release refreshes once');
}

// §2d — idempotence was a documented property of the release handle BEFORE
// this change and must survive it. A double release that fired a second
// refresh would be a new bug hidden inside a fix.
{
  const { fns, calls } = makeGateSandbox();
  const release = fns.beginDomainWrite('articles', 'ingest');
  release();
  release();
  release();
  eq(calls.badge, 1, '§2d releasing an already-released handle refreshes NOTHING further');
}

// §2e — the no-op handle beginDomainWrite() returns for a falsy domain
// registered nothing, so it must settle nothing.
{
  const { fns, calls } = makeGateSandbox();
  const noop = fns.beginDomainWrite('', 'ingest');
  noop();
  eq(calls.badge, 0, '§2e the refusal handle for a falsy domain does not fake a completed write');
}

// §2f — a THROWING subscriber must not swallow the refresh. Subscribers are
// view code; one of them throwing is a view bug, not a reason for the badge
// to go stale. (_notifyWriteGateSubscribers already catches per-subscriber;
// this asserts the badge sits downstream of that catch and is reached.)
{
  const { fns, calls } = makeGateSandbox();
  fns.onWriteGateChange(() => { throw new Error('view blew up'); });
  const release = fns.beginDomainWrite('articles', 'ingest');
  release();
  eq(calls.badge, 1, '§2f a throwing write-gate subscriber does not prevent the badge refresh');
}

// §2h — a THROWING refresher must not break the release itself. Today it
// cannot throw synchronously (refreshSyncBadge is an `async function`), so
// this asserts the DEFENSIVE try/catch that exists for the edit that makes
// it non-async one day. The stake is not the badge: an exception escaping
// release() would leave the write gate permanently busy for that domain and
// every guarded control disabled for the life of the page.
{
  const calls = { badge: 0 };
  const body =
    'const _domainWrites = new Map();\n' +
    'const _writeGateSubscribers = new Set();\n' +
    extractFunction(workingApp, '_notifyWriteGateSubscribers', 'next/app.js') + '\n\n' +
    extractFunction(workingApp, '_refreshSyncBadgeIfWritesSettled', 'next/app.js') + '\n\n' +
    noExport(extractFunction(workingApp, 'beginDomainWrite', 'next/app.js')) + '\n\n' +
    noExport(extractFunction(workingApp, 'isAnyWriteBusy', 'next/app.js')) + '\n' +
    'return { beginDomainWrite, isAnyWriteBusy };';
  const factory = new Function('refreshSyncBadge', 'refreshSyncRemoteBadge', 'console', 'document', body);
  const fns = factory(
    () => { calls.badge++; throw new Error('refresher blew up'); },
    () => {},
    { warn() {}, error() {} },
    { hidden: false },
  );
  const release = fns.beginDomainWrite('articles', 'ingest');
  let threw = false;
  try { release(); } catch { threw = true; }
  eq(threw, false, '§2h a throwing refreshSyncBadge does not propagate out of release()');
  eq(calls.badge, 1, '§2h ...it was genuinely reached and genuinely threw (positive control)');
  eq(fns.isAnyWriteBusy(), false, '§2h ...and the write gate still fell idle — no permanently-disabled controls');
}

// §2g — the refresh runs regardless of document.hidden, and that is a
// DECISION, not an oversight: this is event-driven, at most once per
// completed operation, and local-only. v3.31.0's rule is about timers and
// network, and this path is neither. A user who starts an ingest and
// alt-tabs away must come back to a correct badge without depending on the
// wake handler having fired.
{
  const calls = { badge: 0, remote: 0 };
  const body =
    'const _domainWrites = new Map();\n' +
    'const _writeGateSubscribers = new Set();\n' +
    extractFunction(workingApp, '_notifyWriteGateSubscribers', 'next/app.js') + '\n\n' +
    extractFunction(workingApp, '_refreshSyncBadgeIfWritesSettled', 'next/app.js') + '\n\n' +
    noExport(extractFunction(workingApp, 'beginDomainWrite', 'next/app.js')) + '\n\n' +
    noExport(extractFunction(workingApp, 'isAnyWriteBusy', 'next/app.js')) + '\n' +
    'return { beginDomainWrite };';
  const factory = new Function('refreshSyncBadge', 'refreshSyncRemoteBadge', 'console', 'document', body);
  const fns = factory(
    () => { calls.badge++; },
    () => { calls.remote++; },
    { warn() {}, error() {} },
    { hidden: true }, // the window is hidden
  );
  fns.beginDomainWrite('articles', 'ingest')();
  eq(calls.badge, 1, '§2g a write finishing behind a HIDDEN window still refreshes the local badge');
  eq(calls.remote, 0, '§2g ...and still issues no GitHub fetch, which is the constraint that matters');
}

// =======================================================================
section('§3 — the chokepoint is real: /next write paths go through the gate');
// =======================================================================

// Source-level, and labelled as such. §2 proves the gate refreshes the badge;
// this proves the gate is actually where /next's file-writing operations
// live, which is what makes §2 worth anything. Both of the maintainer's
// reported cases are named individually rather than counted, so a rename
// that quietly drops one goes red.
const ingestView  = readFileSync(path.join(ROOT, 'src/public/next/views/ingest.js'), 'utf8');
const domainsView = readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');

ok(/beginDomainWrite\(\s*domain\s*,\s*'ingest'\s*\)/.test(ingestView),
  "§3a the single-file ingest registers a write gate — the REPORTED case ('1' while 33 were pending)");
ok(/beginDomainWrite\([^)]*'health-fix'\)/.test(domainsView),
  '§3b a Health fix registers a write gate — the second reported case');
ok(/beginDomainWrite\([^)]*'broken-links-apply'/.test(domainsView),
  '§3b ...as does the broken-links apply path specifically');
ok(/beginDomainWrite\([^)]*'delete-domain'\)/.test(domainsView),
  '§3b a domain deletion registers a write gate');

// §3c — the KNOWN GAP, reported rather than asserted as an absence.
// Compile-to-Wiki writes many pages from views/chat.js and registers no
// client-side gate, so it is still badge-stale until the next navigate() or
// 60s tick — exactly as it was before this fix, so nothing regressed; it is
// simply not reached. Printed so it cannot be rediscovered as a surprise.
{
  const chatView = readFileSync(path.join(ROOT, 'src/public/next/views/chat.js'), 'utf8');
  const compileGated = /beginDomainWrite\(/.test(chatView);
  console.log(compileGated
    ? '  · NOTE: views/chat.js now registers a write gate — Compile is covered by §2 as well.'
    : '  · NOTE (known gap, not a failure): views/chat.js registers NO write gate, so a\n' +
      '    Compile-to-Wiki still waits for navigate() or the 60s tick. One beginDomainWrite()\n' +
      '    around the /api/compile/conversation call would close it; that file was out of scope.');
  ok(true, '§3c the Compile gap is reported explicitly rather than left to be rediscovered');
}

// §3d — the remote badge must NOT be dragged onto the write path. This is
// the one assertion here that guards a COST rather than a behaviour: a
// `git fetch` to GitHub after every finished ingest is exactly what
// SYNC_REMOTE_REFRESH_MS's 10-minute cadence exists to prevent.
{
  const fn = extractFunction(workingApp, '_refreshSyncBadgeIfWritesSettled', 'next/app.js');
  const code = fn.replace(/\/\/[^\n]*/g, ''); // strip comments; the comment legitimately names the remote refresher
  ok(!/refreshSyncRemoteBadge\s*\(/.test(code),
    '§3d the post-write invalidation never triggers the GitHub-fetching remote refresher');
  ok(/refreshSyncBadge\s*\(/.test(code),
    '§3d ...and does trigger the local one (positive control for the strip above)');
}

// ── Verdict ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`PASS — ${passed} assertions`);
