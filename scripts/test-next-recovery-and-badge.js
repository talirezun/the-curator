/**
 * test-next-recovery-and-badge.js — OFFLINE suite for two cutover defects in
 * the /next shell, plus the version stamp on src/server.js's cutover block.
 *
 * No network, no API key, no server, no browser.
 *
 * ── What this suite ACTUALLY covers ─────────────────────────────────────
 * COVERED, behaviourally (the real function is executed, both directions):
 *   - syncPendingFromStatus(): the badge's whole decision, driven over the
 *     REAL response shapes GET /api/sync/status can produce — including
 *     `{configured:true, error}` (src/brain/sync.js:522 returns exactly
 *     that, with NO changesCount, when the git call itself failed) and the
 *     null that a rejected fetch / non-200 resolves to. Fail-quiet is the
 *     single most important assertion in this file: a badge that lies about
 *     unpushed work is worse than no badge.
 *   - syncBadgeMarkup() / syncBadgeTitle() over the same range.
 *   - refreshSyncBadgeIfVisible() / refreshSyncRemoteBadgeIfVisible() / the
 *     wake handler armSyncBadgeWakeHandler() installs (v3.30.0+, the
 *     background/menubar hidden-window guard): the REAL functions are run
 *     with a fake `document`/`window` and spies standing in for
 *     refreshSyncBadge()/refreshSyncRemoteBadge(), so the assertion is
 *     behavioural (the spy is or is not called), not a grep for the string
 *     "document.hidden" — a check that is present but never consulted would
 *     still pass a grep. See §4b.
 *
 * COVERED, as source-level assertions over the REAL recovery copy (the
 * strings are extracted from index.html and asserted on as text — that is
 * behaviour for a panel whose entire job is what it says):
 *   - Both recovery strings name /old.
 *   - NEITHER sends the user to "/". Asserted by SET EQUALITY over every
 *     URL-shaped token in the string, not by a substring absence — "/" is a
 *     substring of "/old", so a naive absence check would be either
 *     vacuous or unsatisfiable. See §1c.
 *   - The boot guard was not weakened while its copy was edited: the
 *     window.__curatorBooted sentinel, the capture-phase error listener and
 *     the deferred DOMContentLoaded verdict are all still present.
 *
 * COVERED, as source-level guards (stated as such, not as behaviour):
 *   - `pendingCount` is no longer a hardcoded literal in renderRail().
 *   - refreshSyncBadge() is wired to navigate(), boot()'s interval, and the
 *     batch-ingest 'exit' transition.
 *   - applySyncBadge() does NOT call renderRail() — the requirement that a
 *     badge refresh must not rebuild the rail or re-bind its listeners.
 *
 * NOT COVERED here (stated rather than implied):
 *   - Rendering. applySyncBadge() and renderRail() need a DOM; they were
 *     verified in a real browser instead and that is not reproducible here.
 *   - The 60s/10-minute intervals actually elapsing in a real event loop,
 *     and the real fetch()/git-fetch behind refreshSyncBadge()/
 *     refreshSyncRemoteBadge() themselves — §4b covers only the NEW
 *     visibility gate sitting in front of them (whether they get CALLED),
 *     via a spy; what they do once called is refreshSyncBadge's own
 *     concern and test-sync-hygiene.js's for the remote half.
 *   - Whether /old serves the shipping app (that is scripts/test-cutover.js).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const appJs = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
const nextIndex = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8');
const serverJs = readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');

// ── Comment stripping ───────────────────────────────────────────────────
// Every assertion below has to run against CODE. Both files deliberately
// QUOTE the strings being asserted (app.js's badge block explains why
// `const pendingCount = 0` was wrong by naming it; index.html's new comment
// spells out "the escape hatch is /old, NOT '/'"). Run against raw text,
// those guards would be reading a comment — this repo's named failure
// shape, "a check that stopped reaching the thing it protects".
//
// Conservative on purpose: whole-line // comments and then /* … */ blocks.
// ORDER IS LOAD-BEARING and matches scripts/test-next-onboarding.js: line
// comments FIRST, because app.js's prose contains `/*`-looking sequences
// inside // comments that would otherwise open a fake block comment and
// swallow thousands of characters. assertStrippedSane() is the tripwire.
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

// Sanity anchors are STRUCTURAL and deliberately do NOT overlap anything
// asserted below — a mutation must produce a RED assertion, never a thrown
// tripwire before the first assertion runs (which would prove nothing).
const appCode = assertStrippedSane(stripComments(appJs), 'next/app.js', [
  'function renderRail() {',
  'function boot() {',
  'export async function refreshSyncBadge()',
]);
const indexCode = assertStrippedSane(stripComments(nextIndex), 'next/index.html', [
  'function showFatalPanel(detail)',
  'window.__curatorBooted',
]);
const serverCode = assertStrippedSane(stripComments(serverJs), 'server.js', [
  "app.get('/old'",
]);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction helpers ──────────────────────────────────────────────────
// Brace-matched, so nested braces in a body cannot truncate the extraction.
// A missing name THROWS rather than silently testing nothing.
function extractFunction(src, name, label) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  // Skip the PARAMETER LIST before hunting for the body brace — a
  // destructured parameter would otherwise latch the matcher onto the
  // parameter pattern and "end" the function at the closing paren.
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
  // Desync tripwire: a truncated extraction must fail LOUDLY here rather
  // than later as a confusing SyntaxError out of new Function().
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

// Same brace-matching discipline for a top-level object/const literal.
function extractObjectConst(src, name, label) {
  const marker = new RegExp(`(?:^|\\n)const ${name} = \\{`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractObjectConst: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i) + ';';
  if (!/\n\};$/.test(extracted)) {
    throw new Error(`extractObjectConst: "${name}" extraction desynced`);
  }
  return extracted;
}

// Pull the boot guard's two recovery strings out of index.html, from the
// COMMENT-STRIPPED source so the new explanatory comment beside step 2
// (which itself contains "/old" and a quoted "/") cannot be mistaken for
// the copy under test. Both extractors THROW if their anchor moves.
function extractRecoverySteps() {
  const startAnchor = "var ol = document.createElement('ol');";
  const endAnchor = '].forEach(';
  const s = indexCode.indexOf(startAnchor);
  if (s === -1) throw new Error('recovery steps: the <ol> anchor is gone from index.html');
  const e = indexCode.indexOf(endAnchor, s);
  if (e === -1) throw new Error('recovery steps: the .forEach terminator is gone from index.html');
  const slice = indexCode.slice(s, e);
  const out = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(slice)) !== null) out.push(m[1]);
  // Drop the createElement/style arguments — only sentences are steps.
  const steps = out.filter((t) => t.length > 25 && /[a-z] [a-z]/.test(t));
  if (steps.length < 2) {
    throw new Error(`recovery steps: expected at least 2 step sentences, extracted ${steps.length}`);
  }
  return steps;
}

function extractFallbackString() {
  const re = /document\.documentElement\.textContent\s*=\s*'((?:[^'\\]|\\.)*)'/;
  const m = re.exec(indexCode);
  if (!m) throw new Error('recovery fallback: the documentElement.textContent assignment is gone from index.html');
  return m[1];
}

// Every URL-shaped token in a string: a "/" plus the word characters that
// follow it. This is what makes the negative assertion in §1c non-vacuous
// AND satisfiable — "/" is a substring of "/old", so a plain
// `!s.includes('/')` could never pass, and `!s.includes(' / ')` would pass
// vacuously against copy that said "at /." instead.
function urlTokens(s) {
  return (s.match(/\/[A-Za-z0-9_-]*/g) || []);
}

// ── Build the sandbox from the REAL app.js source ───────────────────────
const PURE_FNS = ['syncPendingFromStatus', 'syncBadgeMarkup', 'syncBadgeTitle'];
const sandbox = new Function(
  extractObjectConst(appJs, 'VIEW_META', 'next/app.js') + '\n' +
  PURE_FNS.map((n) => extractFunction(appJs, n, 'next/app.js')).join('\n\n') + '\n' +
  `return { ${PURE_FNS.join(', ')} };`
)();
const { syncPendingFromStatus, syncBadgeMarkup, syncBadgeTitle } = sandbox;

console.log('test-next-recovery-and-badge.js — /next boot-recovery copy + rail sync badge\n');

// ════════════════════════════════════════════════════════════════════════
section('§1  Boot-recovery panel — the escape hatch is /old, never "/"');
// ════════════════════════════════════════════════════════════════════════

const steps = extractRecoverySteps();
const fallback = extractFallbackString();
const recovery = [
  ['step list', steps.join(' ')],
  ['catch fallback', fallback],
];

// §1a — the copy exists at all (a vacuity guard for everything after it).
ok(steps.length >= 2, `two recovery steps extracted from index.html (got ${steps.length})`);
ok(fallback.length > 40, 'catch-fallback string extracted from index.html');

// §1b — POSITIVE: both strings name the escape hatch that actually works.
for (const [label, text] of recovery) {
  ok(/\/old\b/.test(text), `${label} names /old`);
}

// §1c — NEGATIVE, and specific enough that it cannot pass vacuously.
// Post-cutover "/" IS this shell, so "go back to /" is a loop that returns
// the user to the broken page. Every URL-shaped token in the recovery copy
// must be exactly "/old" — asserted by set equality, and paired with a
// non-empty check so an empty token set can never satisfy it.
for (const [label, text] of recovery) {
  const tokens = urlTokens(text);
  ok(tokens.length > 0, `${label} contains at least one URL token (vacuity guard)`);
  const bad = tokens.filter((t) => t !== '/old');
  ok(bad.length === 0, `${label} points ONLY at /old (offending tokens: ${JSON.stringify(bad)})`);
}

// §1d — the preview-era framing is gone. "the shipping app" is now this
// shell, so the phrase actively misdirects.
for (const [label, text] of recovery) {
  ok(!/shipping app/i.test(text), `${label} no longer says "shipping app"`);
  ok(!/preview/i.test(text), `${label} no longer calls this a preview`);
}
ok(!/\(preview\)/i.test(indexCode), 'no "(preview)" left anywhere in the boot-guard code');

// §1e — leads with the action, not with an apology.
ok(/^(Reload|Open)\b/.test(steps[0]), `first step opens with an action (got "${steps[0].slice(0, 24)}…")`);
ok(/^Open\b/.test(steps[1]), `second step opens with an action (got "${steps[1].slice(0, 24)}…")`);
ok(/^The Curator could not finish loading\./.test(fallback), 'fallback leads with what happened, then the action');

// §1f — THE GUARD ITSELF WAS NOT WEAKENED while its copy was edited.
// These are the three mechanisms the panel depends on; editing text must
// not have disturbed any of them.
ok(indexCode.includes('window.__curatorBooted = false;'),
  'guard still initialises the window.__curatorBooted sentinel');
ok(/if \(window\.__curatorBooted\) \{[\s\S]{0,200}?return;/.test(indexCode),
  'guard still keys its verdict on the __curatorBooted sentinel');
ok(/addEventListener\('error', function \(ev\) \{[\s\S]*?\}, true\)/.test(indexCode),
  'guard still registers the capture-phase error listener (pre-boot download failures)');
ok(indexCode.includes("addEventListener('unhandledrejection'"),
  'guard still records pre-boot unhandled rejections');
ok(/document\.addEventListener\('DOMContentLoaded'[\s\S]*?showFatalPanel\(preBootError/.test(indexCode),
  'guard still defers the verdict to DOMContentLoaded and shows the recorded error');
ok(indexCode.includes('pre.textContent = String(detail'),
  'error detail is still inserted with textContent, never HTML');

// ════════════════════════════════════════════════════════════════════════
section('§2  Rail sync badge — the decision function, executed');
// ════════════════════════════════════════════════════════════════════════

// Shapes below are the REAL ones GET /api/sync/status can return; see
// getStatus() in src/brain/sync.js.

// NOT CONFIGURED — a user who never set up sync must never see a badge.
eq(syncPendingFromStatus({ configured: false }), 0, 'not configured -> 0');
eq(syncPendingFromStatus({ configured: false, changesCount: 12 }), 0,
  'not configured BEATS a changesCount that came along for the ride');

// CONFIGURED, nothing pending.
eq(syncPendingFromStatus({ configured: true, changesCount: 0 }), 0, 'configured, zero changes -> 0');

// CONFIGURED, N pending.
eq(syncPendingFromStatus({ configured: true, changesCount: 1 }), 1, 'configured, 1 change -> 1');
eq(syncPendingFromStatus({ configured: true, changesCount: 206 }), 206, 'configured, 206 changes -> 206');

// FAIL QUIET — every one of these must produce NO badge rather than a guess.
eq(syncPendingFromStatus(null), 0, 'fetch failed (null) -> 0');
eq(syncPendingFromStatus(undefined), 0, 'undefined status -> 0');
eq(syncPendingFromStatus({}), 0, 'empty body -> 0');
eq(syncPendingFromStatus({ error: 'Sync is not configured' }), 0, 'error body with no configured flag -> 0');
eq(syncPendingFromStatus({ configured: true, error: 'fatal: not a git repository' }), 0,
  'REAL {configured:true, error} shape (no changesCount) -> 0');
eq(syncPendingFromStatus({ configured: 'yes', changesCount: 5 }), 0,
  'truthy-but-not-true configured is refused (strict === true)');
eq(syncPendingFromStatus({ configured: true, changesCount: '7' }), 0, 'string changesCount -> 0');
eq(syncPendingFromStatus({ configured: true, changesCount: null }), 0, 'null changesCount -> 0');
eq(syncPendingFromStatus({ configured: true, changesCount: NaN }), 0, 'NaN changesCount -> 0');
eq(syncPendingFromStatus({ configured: true, changesCount: Infinity }), 0, 'Infinity changesCount -> 0');
eq(syncPendingFromStatus({ configured: true, changesCount: -3 }), 0, 'negative changesCount -> 0');
eq(syncPendingFromStatus({ configured: true, changesCount: 3.7 }), 3, 'fractional changesCount floors to an integer');

// ════════════════════════════════════════════════════════════════════════
section('§3  Rail sync badge — markup and title, executed');
// ════════════════════════════════════════════════════════════════════════

eq(syncBadgeMarkup(0), '', 'zero renders NO badge element at all');
eq(syncBadgeMarkup(4), '<span class="rail-badge">4</span>', 'four renders the badge span');
ok(!/["'<>]/.test(String(syncBadgeMarkup(9)).replace(/<span class="rail-badge">|<\/span>/g, '')),
  'the interpolated value carries no quote or angle bracket into the rail HTML');

eq(syncBadgeTitle(0), 'Sync', 'zero keeps the plain "Sync" tooltip');
eq(syncBadgeTitle(1), 'Sync — 1 local change not yet pushed to GitHub', 'one change is singular');
eq(syncBadgeTitle(2), 'Sync — 2 local changes not yet pushed to GitHub', 'two changes are plural');
ok(!/["]/.test(syncBadgeTitle(2)),
  'the title never emits a double quote (it is interpolated into a title="…" attribute)');

// ════════════════════════════════════════════════════════════════════════
section('§4  Wiring guards (source-level, stated as such)');
// ════════════════════════════════════════════════════════════════════════

// THE DEFECT: `const pendingCount = 0` made the badge structurally unable
// to appear. It must not come back in any hardcoded form.
ok(!/const pendingCount\s*=\s*\d/.test(appCode),
  'renderRail() no longer assigns pendingCount a hardcoded numeric literal');
ok(!/\bpendingCount\b/.test(appCode),
  'the pendingCount identifier is gone from app.js code entirely');
ok(appCode.includes('syncBadgeMarkup(_syncPendingCount)'),
  'renderRail() renders the badge from the live cached count');

// Refresh triggers — one per moment, no chatty poll.
const navigateFn = extractFunction(appCode, 'navigate', 'next/app.js');
ok(/refreshSyncBadge\(\)/.test(navigateFn),
  'navigate() refreshes the badge (the /next equivalent of a tab click)');
const bootFn = extractFunction(appCode, 'boot', 'next/app.js');
// v3.30.0+: boot() arms the hidden-aware WRAPPER, not the raw refresher
// directly — see §4b for the wrapper's own behaviour, executed.
ok(/setInterval\(refreshSyncBadgeIfVisible, SYNC_BADGE_REFRESH_MS\)/.test(bootFn),
  'boot() arms the slow safety-net interval, via the hidden-aware wrapper');
ok(/SYNC_BADGE_REFRESH_MS = 60_000/.test(appCode),
  'the safety net is 60s — the same cadence the shipping app has used since v3.0.1-beta.5');
const jobFn = extractFunction(appCode, '_checkActiveJobOnce', 'next/app.js');
ok(/decision === 'exit'[\s\S]*?refreshSyncBadge\(\)/.test(jobFn),
  "a finished batch ingest ('exit' transition) refreshes the badge");

// No second polling path: refreshSyncBadge is the ONLY thing that fetches
// sync status in the shell, and it does so once per call.
const shellSyncFetches = (appCode.match(/fetch\('\/api\/sync\/status'\)/g) || []).length;
eq(shellSyncFetches, 1, 'exactly ONE /api/sync/status fetch site in the shell');
const refreshFn = extractFunction(appCode, 'refreshSyncBadge', 'next/app.js');
ok(/try \{[\s\S]*?\} catch/.test(refreshFn),
  'refreshSyncBadge() wraps its fetch in try/catch (it runs inside boot(); a throw would trip the recovery panel)');
ok(!/\bthrow\b/.test(refreshFn), 'refreshSyncBadge() never throws');
ok(/export async function refreshSyncBadge/.test(appCode),
  'refreshSyncBadge is exported, so a view can call it after a sync operation without a second fetch path');

// A badge refresh must NOT rebuild the rail or re-bind its listeners.
const applyFn = extractFunction(appCode, 'applySyncBadge', 'next/app.js');
ok(!/renderRail\(\)/.test(applyFn), 'applySyncBadge() does NOT call renderRail() (no rebuild, no duplicate listeners)');
ok(!/addEventListener/.test(applyFn), 'applySyncBadge() binds no listeners');
ok(!/innerHTML/.test(applyFn), 'applySyncBadge() does not touch innerHTML');
ok(/querySelector\('#rail \.rail-btn\[data-view="sync"\]'\)/.test(applyFn),
  'applySyncBadge() targets the sync rail button specifically');

// ════════════════════════════════════════════════════════════════════════
section('§4b  Hidden-window guard — executed, with spies, not grepped');
// ════════════════════════════════════════════════════════════════════════
//
// THE DEFECT THIS GUARDS AGAINST: the app now ships as a window a user may
// leave running all day (and is about to gain a background/menubar mode).
// Two shell-level setInterval timers kept firing regardless of visibility —
// refreshSyncBadge (60s, local `git status`) and refreshSyncRemoteBadge
// (10 minutes, a `git fetch` to GitHub). For a hidden/occluded window,
// refreshSyncRemoteBadgeIfVisible/refreshSyncBadgeIfVisible must decline to
// call the real refresher, and armSyncBadgeWakeHandler must resume promptly
// (not wait out the rest of a skipped interval) the moment the window is
// shown again — but must NOT fire on the *hide* half of a visibilitychange
// pair, which the browser also delivers.
//
// A regex asserting the string "document.hidden" appears would pass on a
// build where the check is present but never CONSULTED (e.g. an inverted
// condition, or a check against the wrong variable). So this section
// extracts the three REAL functions and runs them in a sandbox with a fake
// `document`/`window` and two spies standing in for refreshSyncBadge() and
// refreshSyncRemoteBadge() — the assertion is whether the SPY was called,
// which only happens if the extracted source's own control flow reaches it.

function makeVisibilitySandbox() {
  const calls = { local: 0, remote: 0 };
  const docListeners = {};
  const winListeners = {};
  const fakeDocument = {
    hidden: false,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  };
  const fakeWindow = {
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
  };
  const body =
    extractFunction(appCode, 'refreshSyncBadgeIfVisible', 'next/app.js') + '\n\n' +
    extractFunction(appCode, 'refreshSyncRemoteBadgeIfVisible', 'next/app.js') + '\n\n' +
    extractFunction(appCode, 'armSyncBadgeWakeHandler', 'next/app.js') + '\n' +
    'return { refreshSyncBadgeIfVisible, refreshSyncRemoteBadgeIfVisible, armSyncBadgeWakeHandler };';
  const factory = new Function('document', 'window', 'refreshSyncBadge', 'refreshSyncRemoteBadge', body);
  const fns = factory(
    fakeDocument, fakeWindow,
    () => { calls.local++; },
    () => { calls.remote++; },
  );
  return { fns, calls, fakeDocument, docListeners, winListeners };
}

// §4b-i — refreshSyncBadgeIfVisible: the LOCAL 60s tick.
//
// Each direction checks a DELTA FROM A RESET ZERO, not a running total. A
// running total was tried first and had a real gap: for an INVERTED
// condition ("skip when visible" instead of "skip when hidden"), the hidden
// check wrongly increments the count to 1, and the visible check then
// wrongly declines to increment it — leaving the total sitting at 1, which
// equals what a CORRECT run's total would be at that point. The assertion
// would read green for a coincidence of arithmetic, not because the call
// happened. Resetting the counter before each fire closes that: every
// assertion is "did this exact call increment it," which an inverted
// condition cannot satisfy in both directions at once. (Verified live —
// see this file's own mutation notes; not asserted from theory.)
{
  const { fns, calls, fakeDocument } = makeVisibilitySandbox();
  fakeDocument.hidden = true;
  fns.refreshSyncBadgeIfVisible();
  eq(calls.local, 0, 'refreshSyncBadgeIfVisible: hidden window -> refreshSyncBadge is NOT called');
  calls.local = 0;
  fakeDocument.hidden = false;
  fns.refreshSyncBadgeIfVisible();
  eq(calls.local, 1, 'refreshSyncBadgeIfVisible: visible window -> refreshSyncBadge IS called');
}

// §4b-ii — refreshSyncRemoteBadgeIfVisible: the REMOTE 10-minute tick, the
// one that performs the actual `git fetch` to GitHub. Same reset-before-each
// discipline as §4b-i, for the same reason.
{
  const { fns, calls, fakeDocument } = makeVisibilitySandbox();
  fakeDocument.hidden = true;
  fns.refreshSyncRemoteBadgeIfVisible();
  eq(calls.remote, 0, 'refreshSyncRemoteBadgeIfVisible: hidden window -> the GitHub-fetching refresher is NOT called');
  calls.remote = 0;
  fakeDocument.hidden = false;
  fns.refreshSyncRemoteBadgeIfVisible();
  eq(calls.remote, 1, 'refreshSyncRemoteBadgeIfVisible: visible window -> the GitHub-fetching refresher IS called');
}

// §4b-iii — armSyncBadgeWakeHandler: one listener on each of window "focus"
// and document "visibilitychange"; resumes on the SHOW transition and stays
// silent on the HIDE transition; "focus" carries the same guard. Same
// reset-before-each discipline as §4b-i/ii, applied to both counters at
// every step, so no step's read can be masked by a prior step's miscount.
{
  const { fns, calls, fakeDocument, docListeners, winListeners } = makeVisibilitySandbox();
  fns.armSyncBadgeWakeHandler();
  eq((winListeners.focus || []).length, 1, 'armSyncBadgeWakeHandler binds exactly one window "focus" listener');
  eq((docListeners.visibilitychange || []).length, 1,
    'armSyncBadgeWakeHandler binds exactly one document "visibilitychange" listener');

  // Resolve both handlers ONCE, defensively — a missing registration must
  // fail as a named assertion below (this project's own recorded lesson:
  // "M16 reds by CRASHING rather than by a named assertion"), not throw and
  // take the rest of this file's assertions (including §5) down with it.
  const visHandler = (docListeners.visibilitychange || [])[0];
  const focusHandler = (winListeners.focus || [])[0];
  ok(typeof visHandler === 'function' && typeof focusHandler === 'function',
    'both wake listeners resolved to callable handlers (prerequisite for the transition checks below)');

  if (typeof visHandler === 'function' && typeof focusHandler === 'function') {
    // The HIDE transition: document.hidden is true when the handler fires.
    fakeDocument.hidden = true;
    visHandler();
    eq(calls.local, 0, 'wake handler on the HIDE transition calls neither refresher (local)');
    eq(calls.remote, 0, 'wake handler on the HIDE transition calls neither refresher (remote)');
    calls.local = 0; calls.remote = 0;

    // The SHOW transition: document.hidden is false when the handler fires —
    // both refreshers run immediately, not on a debounce (see armSyncBadge-
    // WakeHandler's own comment for why an immediate refresh is safe here).
    fakeDocument.hidden = false;
    visHandler();
    eq(calls.local, 1, 'wake handler on the SHOW transition refreshes the local badge immediately');
    eq(calls.remote, 1, 'wake handler on the SHOW transition refreshes the remote badge immediately');
    calls.local = 0; calls.remote = 0;

    // `focus` is wired to the identical handler and obeys the identical guard.
    focusHandler();
    eq(calls.local, 1, 'the "focus" listener carries the same wake behaviour (local)');
    eq(calls.remote, 1, 'the "focus" listener carries the same wake behaviour (remote)');
  } else {
    // Keep the assertion COUNT stable regardless of which branch runs, so a
    // missing-listener mutation cannot be disguised as "fewer assertions ran"
    // — it must show up as failures, not as a shorter, quieter report.
    for (let i = 0; i < 6; i++) ok(false, 'skipped: a wake listener above did not resolve');
  }
}

// §4b-iv — boot() actually arms the wake handler (the interval wiring for
// both timers is checked above in §4 and in test-sync-hygiene.js §18b).
ok(/armSyncBadgeWakeHandler\(\)/.test(bootFn), 'boot() arms the visibility wake handler');

// ════════════════════════════════════════════════════════════════════════
section('§5  server.js cutover block names the release it shipped in');
// ════════════════════════════════════════════════════════════════════════

// Read from the RAW source, not serverCode: the stamp lives in a comment,
// and the comment IS the subject here. This project treats a false claim in
// a comment as a real defect — it is what stops the next reader looking.
const pkgVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const cutoverHeading = /═+ THE CUTOVER \(v([0-9]+\.[0-9]+\.[0-9]+)\)/.exec(serverJs);
ok(!!cutoverHeading, 'the cutover block still carries a version stamp');
eq(cutoverHeading && cutoverHeading[1], '3.9.0', 'cutover block is stamped v3.9.0 (the release it shipped in)');

// v3.9.1: this assertion used to read `eq(pkgVersion, '3.9.0', …)`, which
// pinned package.json to a LITERAL and therefore went red on the very next
// version bump — it would have blocked every future release. Its own stated
// purpose ("not a second, drifting source of truth") is about AGREEMENT, but
// equality-with-a-literal cannot express that, and it contradicted the
// assertion directly above it: the stamp names the release the cutover
// SHIPPED IN, which is history and must never move, while package.json
// advances every release. Two assertions, opposite intents, same constant.
//
// The real invariant is ORDERING: the stamp may never claim a release that
// has not happened yet. That catches someone "helpfully" bumping the stamp
// alongside the version — the actual drift this section exists to prevent —
// and stays true for every release after this one.
const cmpSemver = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
  return 0;
};
ok(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pkgVersion), `package.json carries a plain semver (got "${pkgVersion}")`);
ok(cmpSemver(cutoverHeading ? cutoverHeading[1] : '0.0.0', pkgVersion) <= 0,
  `the cutover stamp (v${cutoverHeading && cutoverHeading[1]}) is at or before package.json (v${pkgVersion}) — a stamp naming an unreleased version is the drift this guards`);

// The ordering check above is necessary but NOT sufficient, and the adversarial
// audit of v3.9.1 was right to say so: the stamp-moved-with-the-version case it
// claimed to catch is already caught by the literal assertion two lines up, and
// the ordering check alone cannot see `package.json` advancing to 4.7.0 with the
// stamp untouched — which the deleted literal DID catch. So restore a real
// agreement invariant, on the pair that must genuinely agree and that nothing
// else cross-checks: CLAUDE.md carries its own `**Version:**` line, hand-edited
// every release, and a release that bumps one and forgets the other ships a dev
// guide that misreports what is running. Unlike the literal it replaces, this
// never blocks a legitimate bump — it only requires the two move together.
const claudeMd = readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const claudeVersion = /^- \*\*Version:\*\* ([0-9]+\.[0-9]+\.[0-9]+)\s*$/m.exec(claudeMd);
ok(!!claudeVersion, 'CLAUDE.md still carries a `- **Version:** X.Y.Z` line');
eq(claudeVersion && claudeVersion[1], pkgVersion,
  `CLAUDE.md's version line agrees with package.json (this is AGREEMENT, not a pinned literal — the pinned literal it replaced would have gone red on every future release)`);

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
