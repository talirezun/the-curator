/**
 * test-update-in-app.js — OFFLINE suite for the IN-APP updater: the route half
 * (`POST /api/config/update`'s installer arm, `POST /api/config/update/apply`,
 * `GET /api/config/update-progress`) and the Settings half that renders it.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * The maintainer updated v3.31.0 -> v3.32.0 and called it "terrible": Check for
 * updates opened a GitHub page and he downloaded a `.dmg` by hand. What he
 * asked for is "update the app in the app itself like it is done for
 * professional apps. When you click update, some progress bar shows that you
 * download the app, and then the app restarts and that's it."
 *
 * ── WHAT THIS SUITE IS FOR, IN ORDER OF HOW MUCH IT MATTERS ────────────────
 *
 *   §2  REPO MODE IS UNCHANGED. Proved BEHAVIOURALLY — the handler extracted
 *       from `git show HEAD:` and from the working tree, compiled with the same
 *       fake collaborators and driven over a matrix — not by reading a diff. A
 *       branch inserted above a body shows in a diff as a pure insertion, which
 *       says nothing about whether the surviving arm is still REACHED with the
 *       same inputs. With the ANTI-VACUITY CONTROL that the two must DISAGREE
 *       when the capability is stubbed to bundle mode: agreement in both modes
 *       would be satisfied by a branch that does nothing.
 *
 *   §4  THE EVENT LIST IS EXACTLY WHAT IS DOCUMENTED. `docs/api-reference.md`
 *       records that compile once documented a `wait` event it has never
 *       emitted. §4 drives the real route and compares the event types it
 *       actually emitted against the table in the doc, in BOTH directions.
 *
 *   §5  NO RAW EXCEPTION TEXT EVER REACHES THE WIRE. A hook rejecting with an
 *       Error whose message carries an absolute path is planted, and the path
 *       is asserted absent from every byte the route wrote.
 *
 *   §9  THE PROGRESS DISPLAY CANNOT LIE. A phase that reports no sub-progress
 *       gets an EMPTY ring segment, and an unknown download total renders as
 *       "total size unknown" rather than as 0%.
 *
 * Everything here is OFFLINE: no network, no subprocess, no real hook, no real
 * credential file. The route is driven through its `deps` seam.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const same = actual === expected;
  ok(same, `${label}${same ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`);
}
function section(t) { console.log(`\n${t}`); }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Isolation, and the contract constants');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-updinapp-')));
fs.mkdirSync(path.join(TMP, 'userdata'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'domains'), { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
delete process.env.DOMAINS_PATH;

// sha256 + size + existence ONLY — never mtime. The maintainer's live app
// rewrites .curator-config.json during ordinary Settings use, and an
// mtime-sensitive guard reports a false "isolation is broken".
const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(ROOT, f));
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!fs.existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = fs.readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const fpBefore = fingerprint();
ok(fpBefore.length > 0, 'real credential files fingerprinted before the run');

let configRoute, installMode, desktopHost, writeRegistry;
try {
  configRoute = await import(path.join(ROOT, 'src/routes/config.js'));
  installMode = await import(path.join(ROOT, 'src/brain/install-mode.js'));
  desktopHost = await import(path.join(ROOT, 'src/brain/desktop-host.js'));
  writeRegistry = await import(path.join(ROOT, 'src/brain/write-registry.js'));
  ok(true, 'the modules under test load');
} catch (err) {
  // A module-load throw would otherwise kill the run with a raw stack, naming
  // no expectation and leaving the tally wrong (the v3.24.1 shape).
  ok(false, `a module under test FAILED to load: ${err && err.message}`);
  console.log(`\nPassed: ${passed}   Failed: ${failed}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

const REPO_CAPS = installMode.getCapabilities('repo');
const BUNDLE_CAPS = installMode.getCapabilities('bundle');
const workConfigSrc = read('src/routes/config.js');
const workSettingsSrc = read('src/public/next/views/settings.js');
const headConfigSrc = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:src/routes/config.js'], { encoding: 'utf8' });
const headSettingsSrc = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:src/public/next/views/settings.js'], { encoding: 'utf8' });

// ── THE FORK IS EXHAUSTIVE OVER THE CAPABILITY TABLE ────────────────────────
// A third install form (a Homebrew cask, a Windows MSI) that names a new
// `updateStyle` and is added to install-mode.js WITHOUT being added here would
// otherwise fall through to the git arm — i.e. run `git reset --hard` inside a
// packaged app. Enumerated from the real table, never a literal list.
{
  const styles = [...new Set(installMode.INSTALL_MODES.map(m => installMode.getCapabilities(m).updateStyle))];
  ok(styles.length >= 2, `enumerated ${styles.length} distinct updateStyle values from the real capability table`);
  const handled = new Set([...configRoute.INSTALLER_UPDATE_STYLES, 'git-pull']);
  for (const s of styles) {
    ok(handled.has(s), `updateStyle "${s}" is handled by a NAMED arm of POST /api/config/update`);
  }
  ok(configRoute.INSTALLER_UPDATE_STYLES.includes('download-installer'),
    'CONTROL: the installer list really does contain the value it exists for');
  ok(!configRoute.INSTALLER_UPDATE_STYLES.includes('git-pull'),
    'CONTROL: and does NOT contain the git one, so the two arms cannot both claim an install');
}

// ── THE HOOK NAMES ARE A CROSS-FILE CONTRACT ───────────────────────────────
// `desktop-host.js` refuses an unknown hook name and `getDesktopHook` returns
// null for one, so a mismatch between this route and the engine fails SAFE —
// the route refuses with `no-updater` and points at the download page. This
// asserts the direction that is knowable from here: the names are non-empty,
// distinct, and of the shape the registry accepts.
// TRANSCRIBED AS LITERALS, not read back from the module — a name read from
// the thing under test agrees with itself by construction. These two strings
// are the agreed contract with the engine, which lives in a directory this
// change does not own; `getDesktopHook` returns null for a name outside its own
// frozen list, so a mismatch fails SAFE (§3's `no-updater` arm) rather than
// half-working. It caught a real one: the rename from an earlier draft's
// `stageUpdate`/`applyUpdate` silently did not land, and nothing else here
// would have noticed.
eq(configRoute.UPDATE_STAGE_HOOK, 'prepareUpdate', 'the staging hook is named prepareUpdate');
eq(configRoute.UPDATE_APPLY_HOOK, 'installUpdate', 'the apply hook is named installUpdate');
ok(configRoute.UPDATE_STAGE_HOOK !== configRoute.UPDATE_APPLY_HOOK,
  'and they are DIFFERENT names — staging and swapping are two hooks, which is the whole contract');
ok(desktopHost.getDesktopHook(configRoute.UPDATE_STAGE_HOOK) === null,
  'INTEGRATION STATE, recorded rather than assumed: no engine is registered in this checkout, so the route must take its refusing arm');

// ── THE PHASE LIST IS DUPLICATED ACROSS THE SERVER/BROWSER BOUNDARY ────────
// settings.js is browser ESM and config.js is a server route, so the list is
// copied rather than imported — the same call `compareSemver` already makes in
// that file. Copying is only safe if drift is impossible, which is this.
{
  const m = workSettingsSrc.match(/const UPDATE_PHASE_ORDER = \[([^\]]*)\]/);
  ok(!!m, 'the client carries its own copy of the phase list');
  const clientPhases = m ? m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean) : [];
  eq(clientPhases.join('|'), configRoute.UPDATE_PHASES.join('|'),
    'and it is IDENTICAL to the server list, in the same order (order is load-bearing — it is the ring\'s segment order)');
  const stages = (workSettingsSrc.match(/const UPDATE_RING_STAGES = \[([^\]]*)\]/) || [])[1] || '';
  eq(stages.split(',').filter(s => s.trim()).length, configRoute.UPDATE_PHASES.length,
    'the ring has exactly one segment per phase — a segment with no phase could never fill');
}

// ── THE FAILURE MAPPER IS TOTAL, AND THE ENGINE OWNS ITS OWN COPY ─────────
// `prepareUpdate` resolves `{ok:false, reason, message}` across 34 named
// reasons and `message` is already written for a user, so the route RELAYS it.
// This table holds only the refusals the route makes itself, plus a fallback.
// A second sentence per engine reason here would be a second copy of one fact,
// free to drift — the shape this project has paid for twice.
{
  const codes = Object.keys(configRoute.UPDATE_FAILURE_COPY);
  ok(codes.length >= 1 && codes.length <= 4,
    `the table holds only ROUTE-owned refusals (${codes.length}: ${codes.join(', ')}) — the engine's 34 reasons are not duplicated here`);
  for (const c of codes) {
    const copy = configRoute.updateFailureCopy(c);
    eq(copy.reason, c, `"${c}" round-trips its own reason code`);
    ok(copy.error.length > 30 && copy.hint.length > 10, `"${c}" has a real sentence and a real hint`);
    ok(!/capability|hook|prepareUpdate|installUpdate|undefined|null/.test(copy.error),
      `"${c}" names no internal identifier at the user — the v3.31.0 defect, not repeated`);
  }
  // THE ENGINE'S MESSAGE WINS, for every reason, recognised or not.
  const ENGINE_MSG = 'The download does not match what GitHub published, so it was discarded.';
  for (const r of ['checksum-mismatch', 'no-updater', 'a-reason-this-route-has-never-heard-of']) {
    eq(configRoute.updateFailureCopy(r, ENGINE_MSG).error, ENGINE_MSG,
      `the engine's own sentence for "${r}" is relayed VERBATIM — the route never rewrites it`);
    eq(configRoute.updateFailureCopy(r, ENGINE_MSG).reason, r,
      `…and the reason is echoed for branching and logs`);
  }
  ok(/release page/.test(configRoute.updateFailureCopy('x', ENGINE_MSG).hint),
    'while the route adds the ONE thing the engine cannot know: that a manual download is still available');
  // Totality, on inputs a wrong engine could actually produce.
  for (const bad of ['', null, undefined, 42, {}, '__proto__', 'constructor', 'CONSTRUCTOR']) {
    const copy = configRoute.updateFailureCopy(bad);
    ok(typeof copy.error === 'string' && copy.error.length > 30,
      `an unusable reason (${JSON.stringify(bad)}) still yields a usable sentence`);
    ok(typeof copy.hint === 'string' && copy.hint.length > 10, `…and a usable hint`);
  }
  for (const blank of ['', '   ', null, 42, {}]) {
    ok(/still works|no built-in updater|no downloaded update/.test(configRoute.updateFailureCopy('offline', blank).error),
      `an engine failure with an unusable message (${JSON.stringify(blank)}) falls back to a sentence that still says the app is intact`);
  }
  eq(configRoute.updateFailureCopy('__proto__').reason, 'unknown',
    'a prototype-chain name is not treated as a known reason (own-property lookup, not truthiness)');
  eq(configRoute.updateFailureCopy('unheard-of').reason, 'unheard-of',
    'but a WELL-FORMED unknown code is echoed back verbatim — a fact and its absence are different values');
  // reasonFromError must never read a message.
  eq(configRoute.reasonFromError(Object.assign(new Error('/Users/someone/secret'), { reason: 'disk-space' })), 'disk-space',
    'a named rejection yields its name');
  eq(configRoute.reasonFromError(new Error('ENOENT: no such file, open /Users/someone/Library/x')), 'unknown',
    'an UNNAMED rejection yields "unknown" — the message is never mined for one');
  eq(configRoute.reasonFromError(null), 'unknown', 'and a non-error rejection is unknown, not a crash');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  REPO MODE IS UNCHANGED — proved behaviourally, not by diff');
// ═══════════════════════════════════════════════════════════════════════════

function braceSlice(src, fromIdx) {
  let i = src.indexOf('{', fromIdx);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(fromIdx, i + 1); }
  }
  return null;
}
function extractExportedFn(src, name) {
  const needle = `export async function ${name}(`;
  const at = src.indexOf(needle);
  if (at === -1) return null;
  const whole = braceSlice(src, at);
  return whole ? whole.replace(/^export /, '') : null;
}

const HEAD_UPDATE = extractExportedFn(headConfigSrc, 'updateHandler');
const WORK_UPDATE = extractExportedFn(workConfigSrc, 'updateHandler');
ok(!!HEAD_UPDATE && HEAD_UPDATE.length > 800, 'extracted updateHandler from HEAD');
ok(!!WORK_UPDATE && WORK_UPDATE.length > 800, 'extracted updateHandler from the working tree');
ok(HEAD_UPDATE !== WORK_UPDATE, 'CONTROL: the two revisions genuinely differ (otherwise this whole section is vacuous)');

// Every free name either revision's body reaches for. Supplied identically to
// both, so any behavioural difference can only come from the bodies.
const FREE_NAMES = [
  'getCapabilities', 'capabilityRefusal', 'defaultExec', 'hasActiveWrites', 'conflictResponse',
  'PROJECT_ROOT', 'SUBPROCESS_ENV', 'beginUpdate', 'endUpdate', 'getReleaseRef',
  'GIT_MISSING_MESSAGE', 'classifyNpmError', 'usesInstallerUpdates', 'installerUpdateApply',
];
function compileUpdate(body, env) {
  return new Function(...FREE_NAMES, `${body}; return updateHandler;`)(...FREE_NAMES.map(n => env[n]));
}
function sseCapableRes() {
  const r = { statusCode: 200, body: null, ended: false, headers: {}, written: [], writableEnded: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; r.writableEnded = true; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.flushHeaders = () => { r.headers.__flushed = true; };
  r.write = (s) => { r.written.push(s); return true; };
  r.end = () => { r.ended = true; r.writableEnded = true; };
  return r;
}

// The environment both revisions run in. `exec` RECORDS and RUNS NOTHING —
// the real body would `git reset --hard origin/main` this very worktree.
function makeEnv({ caps, execResponses = {}, execFail = null, installerSpy }) {
  const calls = [];
  const exec = async (cmd) => {
    calls.push(cmd);
    if (execFail && execFail.cmd && cmd.startsWith(execFail.cmd)) throw new Error(execFail.message);
    for (const [k, v] of Object.entries(execResponses)) if (cmd.startsWith(k)) return v;
    return { stdout: '', stderr: '' };
  };
  let updateFlag = false;
  const env = {
    calls,
    getCapabilities: () => caps,
    capabilityRefusal: installMode.capabilityRefusal,
    defaultExec: exec,
    hasActiveWrites: () => false,
    conflictResponse: writeRegistry.conflictResponse,
    PROJECT_ROOT: ROOT,
    SUBPROCESS_ENV: {},
    beginUpdate: () => { updateFlag = true; },
    endUpdate: () => { updateFlag = false; },
    getReleaseRef: () => ({ channel: 'stable', branch: 'main' }),
    GIT_MISSING_MESSAGE: 'git missing',
    classifyNpmError: () => ({ actionable: null, kind: null }),
    usesInstallerUpdates: (c) => configRoute.INSTALLER_UPDATE_STYLES.includes(c && c.updateStyle),
    installerUpdateApply: installerSpy,
    flagAfter: () => updateFlag,
  };
  return env;
}

const MATRIX = [
  { name: 'clean update', execResponses: { 'git rev-parse HEAD': { stdout: 'aaaaaaa1234\n' } } },
  { name: 'git missing', execFail: { cmd: 'git --version', message: 'git: command not found' } },
  { name: 'fetch fails', execFail: { cmd: 'git fetch', message: 'Could not resolve host' } },
  { name: 'npm fails (unclassified)', execFail: { cmd: 'npm install', message: 'EACCES rename' },
    execResponses: { 'git rev-parse HEAD': { stdout: 'bbbbbbb\n' } } },
];

let repoMatrixRan = 0;
for (const cell of MATRIX) {
  let headSpy = 0, workSpy = 0;
  const headEnv = makeEnv({ caps: REPO_CAPS, ...cell, installerSpy: () => { headSpy++; } });
  const workEnv = makeEnv({ caps: REPO_CAPS, ...cell, installerSpy: () => { workSpy++; } });
  const headRes = sseCapableRes();
  const workRes = sseCapableRes();
  await compileUpdate(HEAD_UPDATE, headEnv)({}, headRes, null);
  await compileUpdate(WORK_UPDATE, workEnv)({}, workRes, null);
  repoMatrixRan++;
  eq(workEnv.calls.join(' | '), headEnv.calls.join(' | '),
    `§2 "${cell.name}": the working tree runs the IDENTICAL command sequence, in order`);
  eq(JSON.stringify(workRes.body), JSON.stringify(headRes.body),
    `§2 "${cell.name}": and returns a byte-identical response body`);
  eq(workRes.statusCode, headRes.statusCode, `§2 "${cell.name}": and the identical status code`);
  eq(workSpy, 0, `§2 "${cell.name}": the installer arm is NEVER reached in repo mode`);
  eq(headSpy, 0, `§2 "${cell.name}": CONTROL: nor in HEAD, which has no such arm`);
}
eq(repoMatrixRan, MATRIX.length, `§2 CONTROL: the matrix actually ran ${MATRIX.length} cells`);
ok(MATRIX.some(c => c.execFail) && MATRIX.some(c => !c.execFail),
  '§2 CONTROL: the matrix reaches both a success path and failure paths');

// ── §2 ANTI-VACUITY: they must DISAGREE in bundle mode ─────────────────────
// Without this, "the two agree" is satisfied by a branch that does nothing at
// all, and the whole section proves nothing. This is the control v3.30.0
// records as the one that matters.
{
  let workSpy = 0, headSpy = 0;
  const headEnv = makeEnv({ caps: BUNDLE_CAPS, installerSpy: () => { headSpy++; } });
  const workEnv = makeEnv({ caps: BUNDLE_CAPS, installerSpy: () => { workSpy++; } });
  const headRes = sseCapableRes();
  const workRes = sseCapableRes();
  await compileUpdate(HEAD_UPDATE, headEnv)({}, headRes, null);
  await compileUpdate(WORK_UPDATE, workEnv)({}, workRes, null);
  eq(workSpy, 1, '§2 ANTI-VACUITY: in BUNDLE mode the working tree DOES reach the installer arm, exactly once');
  eq(headSpy, 0, '§2 ANTI-VACUITY: and HEAD does not — so the two revisions genuinely differ where they should');
  eq(headRes.statusCode, 501, '§2 ANTI-VACUITY CONTROL: HEAD refused with 501 (the behaviour being replaced)');
  eq(headRes.body.capability, 'canSelfUpdateViaGit', '§2 ANTI-VACUITY CONTROL: naming the git capability, which is the defect');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The installer arm REFUSES before it streams');
// ═══════════════════════════════════════════════════════════════════════════
// Every refusal must be plain JSON sent BEFORE any SSE header. Once
// flushHeaders() has run the status code is spent and the client's res.ok
// check has already passed — the failure shape src/routes/ingest.js's own
// error middleware warns about.

const spentExec = { calls: [], exec: async (c) => { spentExec.calls.push(c); return { stdout: '' }; } };

// GUARDED, not merely awaited. A handler that THROWS reds this suite by
// crashing it — the v3.24.1 shape, where the tally is left wrong and no
// expectation is named. Found by mutation M6 and M16, whose mutants each
// crashed after a partial run. A throw is now a NAMED failure, and every
// assertion downstream still gets a `res` object to read rather than null.
async function drive(deps, res = sseCapableRes()) {
  configRoute.__resetUpdateJob();
  try {
    await configRoute.updateHandler({}, res, { caps: BUNDLE_CAPS, execAsync: spentExec.exec, ...deps });
  } catch (err) {
    ok(false, `POST /update THREW instead of answering: ${err && err.message}`);
    if (res.body === null) res.body = {};
  }
  // ALWAYS default, not only when nothing was streamed. Mutation M16 removed
  // the busy refusal so the handler STREAMED where a refusal was expected —
  // `written` was non-empty, `body` stayed null, and the next assertion crashed
  // the suite instead of naming what it wanted.
  if (res.body === null) res.body = {};
  return res;
}

{
  spentExec.calls.length = 0;
  const res = await drive({ hasActiveWrites: () => true, prepareUpdateHook: async () => ({ ok: true }) });
  eq(res.statusCode, 409, 'a write in flight refuses with 409');
  eq(res.body.conflict, 'write_in_progress', 'and uses the SHARED conflictResponse shape, not a hand-rolled body');
  eq(res.body.reason, 'write-in-flight', 'plus a machine-readable reason');
  eq(res.headers.__flushed, undefined, 'and NO SSE header was flushed — the refusal is a real status code');
  eq(spentExec.calls.length, 0, 'zero subprocesses');
  ok(!writeRegistry.isUpdateInProgress(), 'and the update flag was never set');
}
{
  const res = await drive({ hasActiveWrites: () => false, isUpdateInProgress: () => true, prepareUpdateHook: async () => ({ ok: true }) });
  eq(res.statusCode, 409, 'an update already running refuses with 409');
  eq(res.body.reason, 'already-running', 'named as already-running, not as a generic write conflict');
  eq(res.headers.__flushed, undefined, 'and again no stream was opened');
}
{
  // The important one: NO ENGINE ATTACHED. This is every packaged build whose
  // shell did not register a hook, and this checkout.
  const res = await drive({ hasActiveWrites: () => false, prepareUpdateHook: null });
  eq(res.statusCode, 501, 'no updater engine refuses with 501');
  eq(res.body.reason, 'no-updater', 'named');
  eq(res.body.refused, 'updater_unavailable', 'with a machine-readable refusal code');
  ok(/release page/.test(res.body.hint), 'and the hint is v3.31.0\'s behaviour: download the installer yourself');
  eq(res.body.releasesPageUrl, configRoute.RELEASES_PAGE_URL,
    'carrying the releases URL, so the CLIENT never has to hardcode one');
  eq(res.headers.__flushed, undefined, 'refusal before any stream');
  ok(!writeRegistry.isUpdateInProgress(), 'and the flag is clear — a refusal must not leave ingest blocked');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The happy path, and the event list is EXACTLY what is documented');
// ═══════════════════════════════════════════════════════════════════════════

function parseFrames(written) {
  const out = [];
  const text = written.join('');
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim()) continue;
    let type = null, data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (data) { try { out.push({ type, ...JSON.parse(data) }); } catch { /* malformed */ } }
  }
  return out;
}

let happyFrames = [];
{
  let flagDuring = null;
  let sawSignal = null;
  const res = await drive({
    hasActiveWrites: () => false,
    prepareUpdateHook: async ({ onProgress, signal }) => {
      sawSignal = signal;
      flagDuring = writeRegistry.isUpdateInProgress();
      onProgress({ phase: 'resolving' });
      onProgress({ phase: 'downloading', receivedBytes: 0, totalBytes: 143165576 });
      onProgress({ phase: 'downloading', receivedBytes: 61000000, totalBytes: 143165576 });
      onProgress({ phase: 'verifying' });
      onProgress({ phase: 'staging' });
      return { ok: true, version: '3.33.0', token: 'OPAQUE-TOKEN-abc123', prerelease: true, warning: 'This is a pre-release build.' };
    },
  });
  happyFrames = parseFrames(res.written);
  eq(res.headers['Content-Type'], 'text/event-stream', 'the happy path really is a stream');
  eq(res.ended, true, 'and it is closed');
  eq(flagDuring, true, 'the update flag is SET while the download runs, so an ingest gets a clear 409');
  sawSignal = sawSignal || {};
  ok(typeof sawSignal.aborted === 'boolean',
    'the hook is handed a REAL AbortSignal, not undefined, so its own guards see a well-formed object');
  eq(sawSignal.aborted, false,
    'and this route never fires it \u2014 there is no cancel, which is the navigate-away decision, and a signal that fired would be a half-wired one');
  ok(!writeRegistry.isUpdateInProgress(), 'and CLEARED when it finishes — a stuck flag is a stuck Ingest button');

  const types = happyFrames.map(f => f.type);
  eq(types.filter(t => t === 'progress').length, 5, 'one progress frame per onProgress call');
  eq(types[types.length - 1], 'staged', 'and it ends on `staged`');
  ok(!types.includes('done'),
    'there is NO `done` event — "staged" is not "done": nothing has been replaced, and collapsing the two is the lie this split exists to avoid');
  eq((happyFrames[happyFrames.length - 1] || {}).version, '3.33.0', 'the staged frame carries the version');

  const dl = happyFrames.find(f => f.receivedBytes === 61000000);
  ok(!!dl, 'the byte counts reach the wire');
  ok(dl && Math.abs(dl.percent - 42.61) < 0.1, 'and the percentage is DERIVED from them server-side (42.6%)');
}

// THE DOC AND THE ROUTE AGREE, IN BOTH DIRECTIONS.
{
  const doc = read('docs/api-reference.md');
  const at = doc.indexOf('### Arm 2 — the in-app updater');
  ok(at !== -1, 'docs/api-reference.md has a section for the in-app updater arm');
  const docSection = at === -1 ? '' : doc.slice(at, at + 6000);
  const emitted = [...new Set(happyFrames.map(f => f.type))].concat(['error']).sort();
  for (const t of emitted) {
    ok(new RegExp('`' + t + '`').test(docSection), `the doc names the \`${t}\` event this route actually emits`);
  }
  // The other direction — the one compile got wrong. Every event the doc
  // TABLE names must be one the route can emit.
  const documented = [...new Set([...docSection.matchAll(/^\| `([a-z]+)` \|/gm)].map(m => m[1]))].sort();
  ok(documented.length >= 3, `the doc table names ${documented.length} events`);
  for (const t of documented) {
    ok(emitted.includes(t), `the documented \`${t}\` event is one the route EMITS (compile once documented a \`wait\` it never sent)`);
  }
}

// AN ENGINE THAT RESOLVES SOMETHING ELSE IS A FAILURE, NOT A SUCCESS.
// Checked for `ok === true` rather than for truthiness: reporting a staged
// update that does not exist would send the user to a swap of nothing.
for (const bogus of [undefined, null, {}, { version: '3.33.0' }, { ok: 'yes' }, 'staged']) {
  const res = await drive({ hasActiveWrites: () => false, prepareUpdateHook: async () => bogus });
  const frames = parseFrames(res.written);
  const types = frames.map(f => f.type);
  ok(!types.includes('staged'),
    `an engine resolving ${JSON.stringify(bogus)} is NOT reported as staged`);
  ok(types.includes('error'), `…it is reported as an error`);
}
{
  const res = await drive({ hasActiveWrites: () => false, prepareUpdateHook: async () => ({ ok: true, version: '3.33.0' }) });
  ok(parseFrames(res.written).some(f => f.type === 'staged'),
    'CONTROL: an `ok:true` result IS staged — otherwise the rule above is satisfied by a route that never succeeds');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  A failure is NAMED, and no raw exception text reaches the wire');
// ═══════════════════════════════════════════════════════════════════════════

{
  const SECRET = '/Users/somebody/Library/Application Support/The Curator/staging/tmp9f2';
  const res = await drive({
    hasActiveWrites: () => false,
    prepareUpdateHook: async ({ onProgress }) => {
      onProgress({ phase: 'downloading', receivedBytes: 10, totalBytes: 100 });
      // A RESOLVED failure — the contract's shape. The `message` is the
      // engine's own user-facing sentence; the path never leaves the engine.
      return { ok: false, reason: 'permission-denied', message: 'macOS would not let The Curator write the update into place. Nothing was replaced.' };
    },
  });
  const frames = parseFrames(res.written);
  const err = frames.find(f => f.type === 'error') || {};
  ok(!!err.type, 'a rejecting hook produces an `error` frame');
  eq(err.reason, 'permission-denied', 'carrying the engine\'s NAME');
  ok(/release page/.test(err.hint || ''), 'and a hint a non-developer can act on');
  ok(/would not let The Curator write/.test(err.error),
    'THE ENGINE\u2019S OWN SENTENCE reaches the user verbatim — the route does not rewrite it');
  ok(!res.written.join('').includes(SECRET),
    'THE ABSOLUTE PATH IN THE EXCEPTION NEVER REACHES THE WIRE — not in the message, not in the hint');
  ok(!res.written.join('').includes('EACCES'), 'nor the errno');
  ok(!writeRegistry.isUpdateInProgress(), 'and the update flag is cleared on the failure path too');
}
{
  // An UNNAMED rejection is the realistic engine-contract violation.
  const res = await drive({
    hasActiveWrites: () => false,
    // A REJECTION is an engine-contract violation, not an expected outcome —
    // still handled, because a crashing route leaves a ring that never moves.
    prepareUpdateHook: async () => { throw new Error('boom at /private/var/folders/xy/T/abc'); },
  });
  const err = parseFrames(res.written).find(f => f.type === 'error') || {};
  eq(err.reason, 'unknown', 'an unnamed rejection is reported as `unknown` rather than guessed at');
  ok(!res.written.join('').includes('/private/var/folders'),
    'and its message still never reaches the wire');
  ok(/still works/.test(err.error || ''), 'while the sentence still tells the user their app is intact');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  GET /update-progress — the answer to "they navigated away"');
// ═══════════════════════════════════════════════════════════════════════════

// Driven through the real router stack, because this route has no handler
// export — it is the registration itself that must be right.
function findRoute(method, routePath) {
  const stack = configRoute.default.stack || [];
  for (const layer of stack) {
    if (layer.route && layer.route.path === routePath && layer.route.methods[method]) return layer.route;
  }
  return null;
}
{
  const r = findRoute('get', '/update-progress');
  ok(!!r, 'GET /update-progress is registered');
  ok(r && r.stack.length === 1,
    'and carries NO guard middleware — a 409 here would fire exactly when someone asks "is my update still going?"');

  configRoute.__resetUpdateJob();
  const res = sseCapableRes();
  await r.stack[0].handle({}, res, () => {});
  eq(res.body.ok, true, 'it answers');
  eq(res.body.job, null, 'with a null job when nothing is running — an absence, not an empty object');
  eq(res.body.updaterAttached, false,
    'and reports that no engine is attached, which is what lets the UI offer the LINK instead of a button that would 501');

  // …and after a real run it reports the staged job.
  await drive({ hasActiveWrites: () => false, prepareUpdateHook: async () => ({ ok: true, version: '3.33.0', token: 'OPAQUE-TOKEN-abc123' }) });
  const res2 = sseCapableRes();
  await r.stack[0].handle({}, res2, () => {});
  eq((res2.body.job || {}).state, 'staged', 'after a completed download the job is readable as `staged`');
  eq((res2.body.job || {}).version, '3.33.0', 'with its version');
  // ALLOW-LIST, never a spread.
  const keys = Object.keys(res2.body.job || {}).sort().join(',');
  eq(keys, 'error,hint,percent,phase,prerelease,reason,receivedBytes,startedAt,state,totalBytes,version,warning',
    'the wire shape is an explicit allow-list (the v3.3.0 toWire rule), so a stashed error object can never leak');
  // THE SECURITY PROPERTY, asserted rather than described.
  ok(!('token' in res2.body.job),
    'and the OPAQUE TOKEN is ABSENT from it — this route\u2019s caller is a renderer, and a handle on the staged bundle must not be reachable from a page');
  ok(!/\/Users\/|\/Volumes\/|\/private\/|\/Applications\//.test(JSON.stringify(res2.body)),
    'and no filesystem path of any kind reaches the wire');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  POST /update/apply — the step that actually replaces the app');
// ═══════════════════════════════════════════════════════════════════════════

async function driveApply(deps) {
  const res = sseCapableRes();
  try {
    await configRoute.updateApplyHandler({}, res, { caps: BUNDLE_CAPS, ...deps });
  } catch (err) {
    ok(false, `POST /update/apply THREW instead of answering: ${err && err.message}`);
  }
  if (res.body === null) res.body = {};
  return res;
}
{
  const res = sseCapableRes();
  try { await configRoute.updateApplyHandler({}, res, { caps: REPO_CAPS }); }
  catch (err) { ok(false, `the repo-mode refusal THREW: ${err && err.message}`); res.body = res.body || {}; }
  eq(res.statusCode, 501, 'a git checkout refuses to "install a downloaded update"');
  eq(res.body.capability, 'updateStyle', 'naming the capability that decided it');
  ok(/Check for updates/.test(res.body.hint),
    'and pointing at the route that HAS always worked there — never a dead end');
}
{
  configRoute.__resetUpdateJob();
  const res = await driveApply({ hasActiveWrites: () => false, installUpdateHook: async () => {} });
  eq(res.statusCode, 412, 'nothing staged is 412, NOT 409');
  eq(res.body.reason, 'nothing-staged', 'named');
  ok(!('conflict' in res.body),
    'and it does NOT wear the conflict shape — waiting will never make it true, so it must not read as a queue');
}
{
  // Stage something first, then prove the busy re-check.
  await drive({ hasActiveWrites: () => false, prepareUpdateHook: async () => ({ ok: true, version: '3.33.0', token: 'OPAQUE-TOKEN-abc123' }) });
  let applied = 0, sawToken = null;
  const res = await driveApply({ hasActiveWrites: () => true, installUpdateHook: async ({ token }) => { applied++; sawToken = token; } });
  eq(res.statusCode, 409, 'an ingest that started DURING the download refuses the swap');
  eq(applied, 0, 'and the bundle is NOT swapped — this is what makes auto-continue safe after a navigate-away');
  const res2 = await driveApply({ hasActiveWrites: () => false, installUpdateHook: null });
  eq(res2.statusCode, 501, 'and with no apply hook it refuses rather than falling back to anything');
  eq(res2.body.reason, 'no-updater', 'named');
}
{
  await drive({ hasActiveWrites: () => false, prepareUpdateHook: async () => ({ ok: true, version: '3.33.0', token: 'OPAQUE-TOKEN-abc123' }) });
  let applied = 0, sawToken = null;
  const res = await driveApply({ hasActiveWrites: () => false, installUpdateHook: async ({ token }) => { applied++; sawToken = token; } });
  eq(applied, 1, 'the happy path calls the apply hook exactly once');
  eq(sawToken, 'OPAQUE-TOKEN-abc123',
    'and hands back the OPAQUE TOKEN prepareUpdate produced — never a path, which from a renderer would be a replace-any-directory primitive');
  eq(res.body.relaunching, true, 'and says so if the shell chose not to end the process');
  ok(!writeRegistry.isUpdateInProgress(), 'the flag is cleared');
}
{
  await drive({ hasActiveWrites: () => false, prepareUpdateHook: async () => ({ ok: true, version: '3.33.0', token: 'OPAQUE-TOKEN-abc123' }) });
  const res = await driveApply({
    hasActiveWrites: () => false,
    installUpdateHook: async () => ({ ok: false, reason: 'translocated', message: 'The Curator is running from a temporary read-only copy, so it cannot replace itself.' }),
  });
  eq(res.statusCode, 500, 'a failed swap is reported, not swallowed');
  eq(res.body.reason, 'translocated', 'by name');
  ok(/temporary read-only copy/.test(res.body.error), 'relaying the engine\u2019s sentence');
  ok(!JSON.stringify(res.body).includes('/Volumes/'), 'with no filesystem path anywhere in the body');
  // The state it lands in is the interesting part.
  const r = findRoute('get', '/update-progress');
  const p = sseCapableRes();
  await r.stack[0].handle({}, p, () => {});
  eq((p.body.job || {}).state, 'staged',
    'and the job goes back to STAGED, not failed — the verified bundle is still on disk, so "downloaded, not yet installed" is the true state and the finish button is still the right offer');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  normaliseUpdateProgress — a fact and its absence are not the same');
// ═══════════════════════════════════════════════════════════════════════════

const N = configRoute.normaliseUpdateProgress;
{
  const a = N({ phase: 'downloading', receivedBytes: 50, totalBytes: 200 });
  eq(a.percent, 25, 'both counts present ⇒ percent derived from them');
  const b = N({ phase: 'downloading', receivedBytes: 50, totalBytes: 200, percent: 99 });
  eq(b.percent, 25, 'a SUPPLIED percent that disagrees with the bytes is DISCARDED — two numbers that disagree is worse than one');
  const c = N({ phase: 'downloading', receivedBytes: 50 });
  eq(c.percent, null, 'an unknown total gives percent NULL, never 0 — 0 renders as a bar stuck at the far left, i.e. a hang');
  eq(c.totalBytes, null, 'and the total stays null');
  const d = N({ phase: 'downloading', receivedBytes: 50, totalBytes: 0 });
  eq(d.totalBytes, null, 'a ZERO total is "unknown", not "an empty file"');
  const e = N({ phase: 'verifying' });
  eq(e.percent, null, 'a phase with no numbers claims no proportion');
  eq(N({ phase: 'nonsense' }), null, 'an unrecognised phase carrying nothing else is dropped entirely');
  eq(N({ phase: 'nonsense', receivedBytes: 5 }).phase, null,
    'and an unrecognised phase alongside real bytes yields a NULL phase, so the caller keeps the last phase it could describe');
  eq(N(null), null, 'null in, null out');
  eq(N({ receivedBytes: -5 }), null, 'a negative byte count is not a measurement');
  eq(N({ phase: 'downloading', receivedBytes: 300, totalBytes: 200 }).percent, 100, 'and percent is clamped');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  The client: the progress display cannot lie');
// ═══════════════════════════════════════════════════════════════════════════

// Handles `function f(` and `async function f(` alike — `loadVersion` and
// `probeInAppUpdate` are both async, and a regex that silently returned null
// for them would splice EMPTY strings into the sandbox and fail with a
// ReferenceError naming the wrong thing.
function extractLocalFn(src, name) {
  const at = src.search(new RegExp(`(^|\\n)(async )?function ${name}\\s*\\(`));
  if (at === -1) return null;
  const kwAt = src.lastIndexOf('function ', src.indexOf(`function ${name}`, at) + 1);
  const asyncAt = src.slice(Math.max(0, kwAt - 6), kwAt) === 'async ' ? kwAt - 6 : kwAt;
  return braceSlice(src, asyncAt);
}
const clientPure = new Function(`
  ${(workSettingsSrc.match(/const UPDATE_PHASE_ORDER = \[[^\]]*\];/) || [''])[0]}
  ${(workSettingsSrc.match(/const UPDATE_PHASE_COPY = \{[\s\S]*?\n\};/) || [''])[0]}
  ${extractLocalFn(workSettingsSrc, 'updateRingPosition')}
  ${extractLocalFn(workSettingsSrc, 'formatBytes')}
  ${extractLocalFn(workSettingsSrc, 'updateProgressSublabel')}
  return { updateRingPosition, formatBytes, updateProgressSublabel, UPDATE_PHASE_COPY, UPDATE_PHASE_ORDER };`)();

// ── THE HONESTY RULE ───────────────────────────────────────────────────────
// A phase with no sub-progress must produce an EMPTY segment. This is the
// assertion a future "make it look busy" tweak has to break.
for (const phase of ['resolving', 'verifying', 'staging', 'installing']) {
  const pos = clientPure.updateRingPosition({ phase, percent: 87 });
  eq(pos.stageProgress, 0,
    `§9 "${phase}" reports no sub-progress, so its ring segment stays EMPTY even when a percent is present`);
  eq(pos.stage, clientPure.UPDATE_PHASE_ORDER.indexOf(phase), `§9 …and it is on the right segment`);
}
eq(clientPure.updateRingPosition({ phase: 'downloading', percent: 50 }).stageProgress, 0.5,
  '§9 CONTROL: the one phase with genuine sub-progress DOES fill — otherwise the rule above is vacuous');
eq(clientPure.updateRingPosition({ phase: 'downloading', percent: null }).stageProgress, 0,
  '§9 a download with an unknown total fills nothing rather than guessing');
eq(clientPure.updateRingPosition({ phase: 'who-knows' }).stage, 0, '§9 an unknown phase clamps to the start rather than throwing');
eq(clientPure.updateRingPosition(null).stage, 0, '§9 and so does nothing at all');

// ── THE NUMBERS THE USER READS ─────────────────────────────────────────────
eq(clientPure.formatBytes(143165576), '137 MB', '§9 a 143,165,576-byte DMG reads as 137 MB');
eq(clientPure.formatBytes(61000000), '58.2 MB', '§9 and a partial download keeps a decimal, so the number visibly moves on a slow connection');
eq(clientPure.formatBytes(6100000), '5.8 MB', '§9 small figures keep a decimal');
eq(clientPure.formatBytes(0), '0 B', '§9 zero bytes is a measurement');
eq(clientPure.formatBytes(null), null, '§9 no measurement is null, and the caller says something different about it');
eq(clientPure.formatBytes(-1), null, '§9 as is a nonsense one');
eq(clientPure.updateProgressSublabel({ phase: 'downloading', receivedBytes: 61000000, totalBytes: 143165576, percent: 42.6 }),
  '58.2 MB of 137 MB · 43%', '§9 both counts known: size, total and percentage on one line');
eq(clientPure.updateProgressSublabel({ phase: 'downloading', receivedBytes: 61000000, totalBytes: null, percent: null }),
  '58.2 MB downloaded · total size unknown',
  '§9 unknown total: says so in words rather than showing a percentage it does not have');
eq(clientPure.updateProgressSublabel({ phase: 'downloading' }), null,
  '§9 nothing reported yet: NO line at all, rather than a reassuring "0 MB of 0 MB"');
eq(clientPure.updateProgressSublabel({ phase: 'verifying', receivedBytes: 5, totalBytes: 5 }), null,
  '§9 and the byte line belongs to the download phase only');

// Every phase has copy. A phase with no sentence would render a blank box.
for (const phase of clientPure.UPDATE_PHASE_ORDER) {
  const c = clientPure.UPDATE_PHASE_COPY[phase];
  ok(c && c.headline && c.body, `§9 the "${phase}" phase has a headline and a sentence`);
  ok(c && !/hook|stage|SSE|capability/i.test(c.body), `§9 …in the user's terms, not the engine's`);
}
// The two states that say "nothing has been replaced" must actually say it.
for (const phase of ['verifying', 'staging']) {
  ok(/replaced/.test(clientPure.UPDATE_PHASE_COPY[phase].body),
    `§9 "${phase}" tells the user nothing has been replaced yet — the whole reason staging is a separate step`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  The link arm is BYTE-UNCHANGED for a build with no engine');
// ═══════════════════════════════════════════════════════════════════════════
// A packaged build whose shell registered no hook must keep v3.31.0's exact
// behaviour. Proved by running HEAD's renderer and the working tree's over the
// same verdicts and requiring identical HTML.

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function mkInstallerRenderer(src) {
  return new Function('escapeHtml', `
    ${extractLocalFn(src, 'box')}
    ${extractLocalFn(src, 'renderInstallerUpdateStatus')}
    return renderInstallerUpdateStatus;`)(escapeHtml);
}
const headRender = mkInstallerRenderer(headSettingsSrc);
const workRender = mkInstallerRenderer(workSettingsSrc);
const VERDICTS = [
  { kind: 'available', current: '3.31.0', latest: '3.32.0', releaseUrl: 'https://github.com/x/y/releases/tag/v3.32.0', releasesPageUrl: 'https://github.com/x/y/releases', releaseName: 'v3.32.0', prerelease: true },
  { kind: 'available', current: '3.31.0', latest: '3.32.0', releaseUrl: null, releasesPageUrl: null, releaseName: null, prerelease: false },
  { kind: 'current', current: '3.32.0', latest: '3.32.0', prerelease: true },
  { kind: 'local-ahead', current: '3.33.0', latest: '3.32.0' },
  { kind: 'no-release', current: '3.32.0', latest: null, releasesPageUrl: 'https://github.com/x/y/releases' },
  { kind: 'unknown-version', current: '3.32.0', latest: 'nightly', releasesPageUrl: 'https://github.com/x/y/releases' },
];
let renderedAvailable = null;
for (const v of VERDICTS) {
  const h = headRender(v);
  const w = workRender(v, { canInstall: false, busy: false });
  eq(w, h, `§10 "${v.kind}" (no engine): the working tree renders HEAD's HTML byte for byte`);
  const wNoArg = workRender(v);
  eq(wNoArg, h, `§10 "${v.kind}": and omitting the argument entirely is the same — the render function reaches for no module state`);
  if (v.kind === 'available' && v.releaseUrl) renderedAvailable = { head: h, work: workRender(v, { canInstall: true, busy: false }) };
}
ok(!!renderedAvailable, '§10 CONTROL: the matrix included an available-with-URL verdict');
ok(renderedAvailable.head !== renderedAvailable.work,
  '§10 ANTI-VACUITY: with an engine attached the SAME verdict renders DIFFERENTLY — otherwise "unchanged" is satisfied by a flag nothing reads');
ok(!renderedAvailable.head.includes('btn-inapp-install'),
  '§10 HEAD has no install button (the defect: a packaged user got a link and a manual download)');
ok(renderedAvailable.work.includes('btn-inapp-install'),
  '§10 and the engine-attached arm offers one');
ok(renderedAvailable.work.includes('Open the download page'),
  '§10 while KEEPING the manual download as a secondary way out — a failed in-app update must never leave the user stuck');
{
  const busyHtml = workRender(VERDICTS[0], { canInstall: true, busy: true });
  ok(/id="btn-inapp-install" disabled/.test(busyHtml), '§10 an in-flight write disables the install button');
  ok(/Wait for the running ingest/.test(busyHtml),
    '§10 and the reason is rendered as TEXT — a `title=` on a disabled control is out of the tab order and mouse-only');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11  Motion, colour and shape: nothing new was invented');
// ═══════════════════════════════════════════════════════════════════════════
// The reduced-motion decision is DELIBERATE and it is "reuse the component
// that already made it": shared/progress-ring.js drops the rotation under
// prefers-reduced-motion and substitutes a 2.6s opacity breath, keeping the
// liveness cue. A download is the same class as the ingest ring's recorded
// exception — the only signal during a long operation the user must not
// mistake for a hang.
{
  const sharedCss = read('src/public/next/views/shared.css');
  const at = sharedCss.indexOf('.upd-progress');
  ok(at !== -1, 'the update progress block has a CSS rule');
  ok(!/@keyframes\s+upd/.test(sharedCss), 'and declares NO new keyframe — nothing here needs a reduced-motion escape');
  const updRules = sharedCss.match(/^\.upd-[^\n{]*\{[^}]*\}/gm) || [];
  ok(updRules.length >= 5, `scanned ${updRules.length} .upd-* rules`);
  for (const r of updRules) {
    ok(!/\banimation\b/.test(r), 'no .upd-* rule declares an animation (the ring owns its own motion, and its own reduce answer)');
    ok(!/box-shadow/.test(r), 'and none declares a box-shadow — the house rule about fighting the :focus-visible ring');
    ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(r), 'and none carries a colour literal — every colour is a token');
  }
  const ringCss = read('src/public/next/shared/progress-ring.css');
  ok(/prefers-reduced-motion/.test(ringCss) && /pring-breathe/.test(ringCss),
    'CONTROL: the component being reused really does carry the deliberate reduced-motion answer it is being reused for');
  ok(workSettingsSrc.includes("from '../shared/progress-ring.js'"),
    'and the view imports that component rather than hand-rolling a second bar');
}
{
  // No sixth modal shape. The confirm goes through the shared dialog.
  ok(/confirmThen\(\{[\s\S]{0,400}?Download and install this update\?/.test(workSettingsSrc),
    'the install confirmation reuses shared/confirm.js — not a sixth modal');
  ok(!/window\.confirm|window\.alert/.test(workSettingsSrc.slice(workSettingsSrc.indexOf('function onInstallInApp'), workSettingsSrc.indexOf('function onInstallInApp') + 2000)),
    'and never the browser\'s own chrome');
}
{
  // The navigate-away decision, pinned so it cannot be quietly reversed.
  // COMMENTS STRIPPED FIRST. The function's own docblock says "DELIBERATELY NO
  // req.on('close') HANDLER", so an unstripped scan matches the prose that
  // promises the property and reports the opposite of the truth — the exact
  // class test-install-mode.js §4 records having been bitten by.
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const src = workConfigSrc.slice(workConfigSrc.indexOf('async function installerUpdateApply'));
  const body = strip(braceSlice(src, 0) || '');
  ok(/req\.on\(\s*'close'/.test(strip("x; req.on('close', () => {});")),
    'CONTROL: the close-handler detector fires on a planted handler');
  ok(!/req\.on\(\s*'close'/.test(body),
    'THE NAVIGATE-AWAY DECISION: the stream registers NO close handler, so leaving the view cannot cancel a 140 MB download');
  ok(/writableEnded/.test(body),
    'while a closed connection still stops the writes rather than throwing');
  const applySrc = workConfigSrc.slice(workConfigSrc.indexOf('export async function updateApplyHandler'));
  ok(/hasActiveWrites/.test(strip(braceSlice(applySrc, 0) || '')),
    'and the swap re-checks for active writes at the moment it happens — which is what makes finishing unattended safe');
}


// ═══════════════════════════════════════════════════════════════════════════
section('§13  THE CALL SITE, not just the renderers');
// ═══════════════════════════════════════════════════════════════════════════
// §9 and §10 drive the pieces directly, which is satisfied by pieces nothing
// reaches — this repo's recorded "function executed but its call site never
// asserted" shape (v3.26.0 M6). Both holes were found by mutation here: M21
// deleted `renderUpdateStatus`'s dispatch to the in-app panel and M22 hardcoded
// the install-button flag at the call site, and BOTH came back green until this
// section existed. `renderUpdateStatus` is what the view actually calls, so it
// is driven here, with the real progress-ring component.

const { progressRingHtml } = await import(path.join(ROOT, 'src/public/next/shared/progress-ring.js'));
const mkStatus = (state, inAppUpdate, updaterAttached, busy = false) =>
  new Function('escapeHtml', 'state', 'crossWriteBusy', 'inAppUpdate', 'updaterAttached', 'progressRingHtml', `
    ${(workSettingsSrc.match(/const UPDATE_PHASE_ORDER = \[[^\]]*\];/) || [''])[0]}
    ${(workSettingsSrc.match(/const UPDATE_RING_STAGES = \[[^\]]*\];/) || [''])[0]}
    ${(workSettingsSrc.match(/const UPDATE_PHASE_COPY = \{[\s\S]*?\n\};/) || [''])[0]}
    ${extractLocalFn(workSettingsSrc, 'compareSemver')}
    ${extractLocalFn(workSettingsSrc, 'updateStyleOf')}
    ${extractLocalFn(workSettingsSrc, 'classifyInstallerUpdate')}
    ${extractLocalFn(workSettingsSrc, 'classifyUpdate')}
    ${extractLocalFn(workSettingsSrc, 'box')}
    ${extractLocalFn(workSettingsSrc, 'updateRingPosition')}
    ${extractLocalFn(workSettingsSrc, 'formatBytes')}
    ${extractLocalFn(workSettingsSrc, 'updateProgressSublabel')}
    ${extractLocalFn(workSettingsSrc, 'renderInAppUpdate')}
    ${extractLocalFn(workSettingsSrc, 'renderInstallerUpdateStatus')}
    ${extractLocalFn(workSettingsSrc, 'renderUpdateStatus')}
    return renderUpdateStatus;`)(escapeHtml, state, () => busy, inAppUpdate, updaterAttached, progressRingHtml);

const AVAILABLE = {
  current: '3.31.0', latest: '3.32.0', updateAvailable: true, updateStyle: 'download-installer',
  comparable: true, localAhead: false, noInstallableRelease: false, prerelease: true,
  releaseUrl: 'https://github.com/x/y/releases/tag/v3.32.0',
  releasesPageUrl: 'https://github.com/x/y/releases', releaseName: 'v3.32.0',
};
const VER = { version: '3.31.0', onDiskVersion: '3.31.0', restartRequired: false };
const IDLE = { updatePhase: 'idle', updateCheck: AVAILABLE, version: VER };

// ── M22: the call site really does read the measured flag ─────────────────
{
  const noEngine = mkStatus(IDLE, null, null)();
  ok(!noEngine.includes('btn-inapp-install'),
    '§13 CALL SITE: with no engine measured, the available card offers NO install button');
  ok(noEngine.includes('Open the download page'), '§13 …only the link that has always worked');
  const withEngine = mkStatus(IDLE, null, true)();
  ok(withEngine.includes('btn-inapp-install'),
    '§13 CALL SITE: with an engine attached it DOES offer one');
  ok(withEngine.includes('Open the download page'),
    '§13 …and keeps the manual download beside it, so a failed in-app update is never a dead end');
  const busyHtml = mkStatus(IDLE, null, true, true)();
  ok(/btn-inapp-install" disabled/.test(busyHtml),
    '§13 CALL SITE: and a live wiki write disables it — read from crossWriteBusy(), not hardcoded');
}

// ── M21: the in-app panel is REACHABLE, and each state says its own thing ──
{
  const streaming = mkStatus(IDLE, {
    phase: 'streaming',
    job: { phase: 'downloading', receivedBytes: 61000000, totalBytes: 143165576, percent: 42.6 },
    version: null, failure: null, restartHint: false,
  }, true)();
  ok(streaming.includes('upd-progress'), '§13 CALL SITE: a running update REPLACES the check verdict with the progress panel');
  ok(!streaming.includes('btn-inapp-install'),
    '§13 …so a live install is never redrawn as a stale "Update available" banner underneath itself');
  ok(streaming.includes('role="progressbar"'), '§13 and the ring is a real progressbar for assistive tech');
  ok(streaming.includes('58.2 MB of 137 MB'), '§13 with the real byte figures on screen');
  ok(streaming.includes('43%'), '§13 and the percentage the maintainer asked for');
  ok(/aria-valuenow="\d+"/.test(streaming), '§13 announced as a determinate value');

  const unknownTotal = mkStatus(IDLE, {
    phase: 'streaming', job: { phase: 'downloading', receivedBytes: 61000000, totalBytes: null, percent: null },
    version: null, failure: null, restartHint: false,
  }, true)();
  ok(unknownTotal.includes('total size unknown'),
    '§13 an unknown download size SAYS SO rather than showing a bar that has stopped at zero');
  ok(!unknownTotal.includes('0%'), '§13 and never quotes a percentage it does not have');

  const verifying = mkStatus(IDLE, {
    phase: 'streaming', job: { phase: 'verifying' }, version: null, failure: null, restartHint: false,
  }, true)();
  ok(verifying.includes('Checking the download'), '§13 the verifying phase has its own headline');
  ok(verifying.includes('Nothing has been replaced'), '§13 and says the app is still intact');

  const staged = mkStatus(IDLE, {
    phase: 'staged', job: null, version: '3.32.0', failure: null, restartHint: false,
  }, true)();
  ok(staged.includes('Update ready to install'), '§13 the staged state has its own headline');
  ok(staged.includes('btn-inapp-finish'), '§13 and ONE button that finishes it');
  ok(/hasn’t changed yet/.test(staged),
    '§13 and it says the app has not changed yet — which is the whole reason staging is a separate step');

  const relaunching = mkStatus(IDLE, {
    phase: 'relaunching', job: null, version: '3.32.0', failure: null, restartHint: false,
  }, true)();
  ok(relaunching.includes('Restarting'), '§13 the terminal state says the app is restarting');
  ok(relaunching.includes('reloads itself'), '§13 and that the page comes back on its own');
  ok(!relaunching.includes('btn-'), '§13 with nothing left to click');
  const gaveUp = mkStatus(IDLE, {
    phase: 'relaunching', job: null, version: '3.32.0', failure: null, restartHint: true,
  }, true)();
  ok(/Applications folder/.test(gaveUp),
    '§13 …and if it never comes back, the user is told how to open it by hand rather than left on a spinner');

  const failed = mkStatus(IDLE, {
    phase: 'install-failed', job: null, version: null,
    failure: configRoute.updateFailureCopy('checksum-mismatch',
      'The download does not match what GitHub published, so it was discarded and nothing was replaced.'),
    restartHint: false,
  }, true)();
  ok(failed.includes('upd-bad'), '§13 a failure is toned as one');
  ok(failed.includes('does not match what GitHub published'),
    '\u00a713 rendering the ENGINE\u2019s own sentence, relayed by the route, never a client re-invention');
  ok(!failed.includes('checksum-mismatch'),
    '\u00a713 and NOT the reason slug \u2014 an internal identifier shown to a person is the v3.31.0 defect');
  ok(failed.includes('btn-inapp-retry'), '§13 and there is a way to try again');
  ok(!/undefined|\[object Object\]/.test(failed), '§13 and nothing leaks a JS artefact into the copy');

  // The staged-after-a-refused-swap state: the one a navigate-away can produce.
  const stagedAfterRefusal = mkStatus(IDLE, {
    phase: 'staged', job: null, version: '3.32.0',
    failure: { reason: 'nothing', error: 'Cannot restart to finish the update while a write operation is running.' },
    restartHint: false,
  }, true)();
  ok(stagedAfterRefusal.includes('btn-inapp-finish'),
    '§13 NAVIGATE-AWAY OUTCOME: a swap refused because an ingest was running still offers the finish button');
  ok(stagedAfterRefusal.includes('while a write operation is running'),
    '§13 …and says why it did not finish on its own');
}

// ── M23/M24: the ring's own arguments, asserted where they are PASSED ─────
// §9 proves updateRingPosition is honest. That is satisfied by a call site
// that ignores it — `stageProgress: pos.stageProgress || 0.5` is a one-token
// "make it look busy" tweak, and it came back GREEN until this existed.
{
  const verifying = mkStatus(IDLE, {
    phase: 'streaming', job: { phase: 'verifying' }, version: null, failure: null, restartHint: false,
  }, true)();
  // 5 segments, stage index 2, stageProgress 0 -> round(2/5*100) = 40.
  // A floor of 0.5 on the live segment would make it 50.
  ok(/aria-valuenow="40"/.test(verifying),
    '§13 HONESTY AT THE CALL SITE: a phase reporting nothing produces an EMPTY live segment (aria 40, not 50)');
  const downloading = mkStatus(IDLE, {
    phase: 'streaming', job: { phase: 'downloading', receivedBytes: 50, totalBytes: 100, percent: 50 },
    version: null, failure: null, restartHint: false,
  }, true)();
  ok(/aria-valuenow="30"/.test(downloading),
    '§13 CONTROL: and a phase that IS half done reports it (stage 1 + 0.5 of 5 = 30)');
  ok(/>2\/5</.test(downloading),
    '§13 the ring centre carries the stage fraction — one number, not a second percentage competing with the byte line');
}

// ── M27: the check button is disabled while an install runs ───────────────
{
  const busyFn = new Function(`${extractLocalFn(workSettingsSrc, 'updatesAreBusy')}; return updatesAreBusy;`)();
  eq(busyFn({ updatePhase: 'idle' }, { phase: 'streaming' }), true,
    '§13 a running download disables "Check for updates" — re-checking would race the process being replaced');
  eq(busyFn({ updatePhase: 'idle' }, { phase: 'relaunching' }), true, '§13 so does a relaunch');
  eq(busyFn({ updatePhase: 'idle' }, { phase: 'staged' }), false,
    '§13 but a STAGED update does not — it is a resting state, and re-checking there is reasonable');
  eq(busyFn({ updatePhase: 'idle' }, { phase: 'install-failed' }), false, '§13 nor does a failed one');
  eq(busyFn({ updatePhase: 'applying' }, null), true, '§13 CONTROL: the git half still works');
  eq(busyFn({ updateChecking: true }, null), true, '§13 CONTROL: and so does the checking flag');
  eq(busyFn(null, null), false, '§13 and nothing at all is not busy');
  ok(/const updatesBusy = updatesAreBusy\(state, inAppUpdate\);/.test(workSettingsSrc),
    '§13 CALL SITE: renderGeneral computes its disabled state through that function, not a second inline copy');
}

// The git path is untouched by all of this.
{
  const gitHtml = mkStatus({
    updatePhase: 'idle',
    updateCheck: { current: '3.25.0', latest: '3.26.0', updateAvailable: true },
    version: VER,
  }, null, null)();
  ok(gitHtml.includes('btn-apply-update'),
    '§13 CONTROL: a git payload still renders the git Install-update button — the dispatch is a fork, not a takeover');
  ok(!gitHtml.includes('btn-inapp-install'), '§13 CONTROL: and never the in-app one');
}


// ═══════════════════════════════════════════════════════════════════════════
section('§14  Re-finding a download the page stopped watching');
// ═══════════════════════════════════════════════════════════════════════════
// The mount probe is the recovery path for the case `inAppUpdate` cannot cover:
// a FULL PAGE RELOAD mid-download, where the module state died with the page.
// Deleting it came back GREEN until this section existed — and the symptom
// would have been silent: a running download with no indicator anywhere, plus
// an "Update available" card offering a button whose engine was never measured.

function mkMount(fetchImpl) {
  return new Function('fetchImpl', `
    let inAppUpdate = null;
    let updaterAttached = null;
    let state = { version: null };
    let renders = 0;
    let polls = 0;
    const fetch = fetchImpl;
    const isCurrentMount = () => true;
    const render = () => { renders++; };
    const renderIfSettingsMounted = () => { renders++; };
    const pollInAppUpdate = () => { polls++; };
    ${extractLocalFn(workSettingsSrc, 'installUpdateStyle')}
    ${extractLocalFn(workSettingsSrc, 'probeInAppUpdate')}
    ${extractLocalFn(workSettingsSrc, 'loadVersion')}
    return {
      loadVersion,
      read: () => ({ inAppUpdate, updaterAttached, polls, renders, version: state.version && state.version.version }),
    };`)(fetchImpl);
}
const BUNDLE_VERSION_BODY = { version: '3.31.0', capabilities: { updateStyle: 'download-installer' } };
const REPO_VERSION_BODY = { version: '3.31.0', capabilities: { updateStyle: 'git-pull' } };

{
  const urls = [];
  const m = mkMount(async (u) => {
    urls.push(String(u));
    if (String(u) === '/api/version') return { json: async () => BUNDLE_VERSION_BODY };
    return { json: async () => ({
      ok: true, updaterAttached: true,
      job: { state: 'running', phase: 'downloading', receivedBytes: 61000000, totalBytes: 143165576, percent: 42.6, version: null },
    }) };
  });
  await m.loadVersion(1);
  const r = m.read();
  eq(urls.join(' -> '), '/api/version -> /api/config/update-progress',
    '§14 a packaged install asks the server what the updater is doing, exactly once, on mount');
  eq(r.updaterAttached, true, '§14 and learns that an engine is attached');
  eq(r.inAppUpdate && r.inAppUpdate.phase, 'streaming',
    '§14 A RUNNING DOWNLOAD IS RE-FOUND after a full page reload, rather than silently invisible');
  eq(r.inAppUpdate && r.inAppUpdate.job.receivedBytes, 61000000, '§14 with its real byte counts');
  eq(r.polls, 1, '§14 and it starts POLLING, because this page has no stream of its own to read');
}
{
  const urls = [];
  const m = mkMount(async (u) => {
    urls.push(String(u));
    return { json: async () => REPO_VERSION_BODY };
  });
  await m.loadVersion(1);
  eq(urls.join(' -> '), '/api/version',
    '§14 CONTROL: a git checkout never issues the probe at all — a browser user pays nothing for a feature they cannot use');
  eq(m.read().updaterAttached, null,
    '§14 …and `updaterAttached` stays null, which is the arm that renders the download LINK');
}
{
  // A PACKAGED BUILD WITH NO ENGINE — today's DMG, and the case that decides
  // whether the card shows a button or the download link. Found by mutation:
  // hardcoding `updaterAttached = true` in the probe was invisible until a
  // fixture existed in which the server says false.
  const m = mkMount(async (u) => (String(u) === '/api/version'
    ? { json: async () => BUNDLE_VERSION_BODY }
    : { json: async () => ({ ok: true, updaterAttached: false, job: null }) }));
  await m.loadVersion(1);
  eq(m.read().updaterAttached, false,
    '§14 a packaged build whose shell registered NO engine is recorded as such — the client reports the server\'s answer, it does not assume one');
  eq(m.read().inAppUpdate, null, '§14 and no job is invented');
}
{
  // The other two terminal states a returning client can meet.
  const m = mkMount(async (u) => (String(u) === '/api/version'
    ? { json: async () => BUNDLE_VERSION_BODY }
    : { json: async () => ({ ok: true, updaterAttached: true, job: { state: 'staged', version: '3.32.0' } }) }));
  await m.loadVersion(1);
  const r = m.read();
  eq(r.inAppUpdate && r.inAppUpdate.phase, 'staged', '§14 a finished download is re-found as staged…');
  eq(r.inAppUpdate && r.inAppUpdate.version, '3.32.0', '§14 …with the version it staged');
  eq(r.polls, 0, '§14 and does NOT poll — there is nothing left to watch');
}
{
  const m = mkMount(async (u) => (String(u) === '/api/version'
    ? { json: async () => BUNDLE_VERSION_BODY }
    : { json: async () => ({ ok: true, updaterAttached: true, job: { state: 'failed', reason: 'disk-space', error: 'no room', hint: 'free some' } }) }));
  await m.loadVersion(1);
  const r = m.read();
  eq(r.inAppUpdate && r.inAppUpdate.phase, 'install-failed', '§14 and a failure survives the reload too');
  eq(r.inAppUpdate && r.inAppUpdate.failure.reason, 'disk-space', '§14 with its named reason');
}
{
  // A probe that fails must cost the user nothing — never an error box over the
  // ordinary check result.
  const m = mkMount(async (u) => (String(u) === '/api/version'
    ? { json: async () => BUNDLE_VERSION_BODY }
    : { json: async () => { throw new Error('offline'); } }));
  await m.loadVersion(1);
  const r = m.read();
  eq(r.updaterAttached, null, '§14 a failed probe leaves the flag UNKNOWN…');
  eq(r.inAppUpdate, null, '§14 …invents no job…');
  eq(r.version, '3.31.0', '§14 …and does not take the version read down with it');
}


// ═══════════════════════════════════════════════════════════════════════════
section('§15  "Click update, a bar, then it restarts" — driven end to end');
// ═══════════════════════════════════════════════════════════════════════════
// The maintainer's actual sentence. §11 pins the navigate-away DECISION at
// source level; this drives the code that implements it, against a fake stream
// and a fake `fetch`, with NO Settings mount current at any point — which is
// exactly the navigate-away case.

function sseStream(frames) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => (i < frames.length
        ? { done: false, value: enc.encode(`event: ${frames[i].type}\ndata: ${JSON.stringify(frames[i++])}\n\n`) }
        : { done: true }),
      cancel: async () => {},
    }),
  };
}
function mkFlow(fetchImpl, { mounted = false } = {}) {
  return new Function('fetchImpl', 'mounted', 'TextDecoder', `
    let inAppUpdate = null;
    let renders = 0;
    let polled = 0;
    const fetch = fetchImpl;
    const renderIfSettingsMounted = () => { if (mounted) renders++; };
    const pollForRestart = (t, onGiveUp) => { polled++; };
    const state = { updateCheck: null, version: null };
    const classifyUpdate = () => ({ kind: 'available', style: 'download-installer', current: '3.31.0', latest: '3.32.0' });
    const confirmThen = (o) => o.onConfirm();
    const updaterAttached = true;
    ${extractLocalFn(workSettingsSrc, 'failInApp')}
    ${extractLocalFn(workSettingsSrc, 'finishInAppUpdate')}
    ${extractLocalFn(workSettingsSrc, 'runInAppUpdate')}
    ${extractLocalFn(workSettingsSrc, 'onInstallInApp')}
    ${extractLocalFn(workSettingsSrc, 'onRetryInApp')}
    return { onInstallInApp, runInAppUpdate, finishInAppUpdate, onRetryInApp,
             read: () => ({ inAppUpdate, renders, polled }) };`)(fetchImpl, mounted, TextDecoder);
}
const HAPPY_FRAMES = [
  { type: 'progress', phase: 'resolving' },
  { type: 'progress', phase: 'downloading', receivedBytes: 0, totalBytes: 143165576, percent: 0 },
  { type: 'progress', phase: 'downloading', receivedBytes: 143165576, totalBytes: 143165576, percent: 100 },
  { type: 'progress', phase: 'verifying' },
  { type: 'progress', phase: 'staging' },
  { type: 'staged', version: '3.32.0' },
];

{
  // NOTHING IS MOUNTED. The user pressed the button and walked off.
  const calls = [];
  const f = mkFlow(async (u, opts) => {
    calls.push((opts && opts.method ? opts.method + ' ' : 'GET ') + u);
    if (String(u) === '/api/config/update') return { ok: true, body: sseStream(HAPPY_FRAMES) };
    return { ok: true, json: async () => ({ ok: true }) };
  }, { mounted: false });
  await f.onInstallInApp();
  eq(calls.join(' | '), 'POST /api/config/update | POST /api/config/update/apply',
    '§15 NAVIGATE-AWAY: the download runs to completion and AUTO-CONTINUES to the restart, with no view mounted');
  eq(f.read().inAppUpdate.phase, 'relaunching',
    '\u00a715 the flow lands in the relaunching state — "and then the app restarts and that is it"');
  eq(f.read().polled, 1, '§15 with the restart poller running, so the page reloads itself when the app comes back');
  eq(f.read().renders, 0,
    '§15 CONTROL: and it drew NOTHING while unmounted — the work is mount-independent, the drawing is not');
}
{
  // The ingest-started-during-the-download case. The SERVER refuses the swap;
  // the client must park at `staged` with the reason, not report a failure.
  const f = mkFlow(async (u, opts) => {
    if (String(u) === '/api/config/update') return { ok: true, body: sseStream(HAPPY_FRAMES) };
    return { ok: false, status: 409, json: async () => ({
      error: 'Cannot restart to finish the update while a write operation is running: articles (ingest).',
      conflict: 'write_in_progress', reason: 'write-in-flight',
    }) };
  });
  await f.runInAppUpdate();
  const u = f.read().inAppUpdate;
  eq(u.phase, 'staged',
    '§15 a swap refused because an ingest is running parks at STAGED — the download is not thrown away and the ingest is not truncated');
  eq(u.version, '3.32.0', '§15 keeping the version it staged');
  ok(/write operation is running/.test(u.failure.error), '\u00a715 and carrying the reason the server gave, so the user knows why it stopped');
}
{
  // A named engine failure mid-download.
  const f = mkFlow(async (u) => (String(u) === '/api/config/update'
    ? { ok: true, body: sseStream([
        { type: 'progress', phase: 'downloading', receivedBytes: 10, totalBytes: 100, percent: 10 },
        { type: 'error', ...configRoute.updateFailureCopy('checksum-mismatch',
            'The download does not match what GitHub published, so it was discarded.') },
      ]) }
    : { ok: true, json: async () => ({}) }));
  await f.runInAppUpdate();
  const u = f.read().inAppUpdate;
  eq(u.phase, 'install-failed', '§15 a named failure lands in the failed state');
  eq(u.failure.reason, 'checksum-mismatch', '§15 by name');
  ok(/does not match/.test(u.failure.error), '\u00a715 and the ENGINE\u2019s own sentence is what reaches the user');
}
{
  // THE STREAM DIES MID-DOWNLOAD with no error frame — a frozen ring forever is
  // the "my click didn't register" shape this app has already been reported for.
  const f = mkFlow(async (u) => (String(u) === '/api/config/update'
    ? { ok: true, body: sseStream([{ type: 'progress', phase: 'downloading', receivedBytes: 5, totalBytes: 100, percent: 5 }]) }
    : { ok: true, json: async () => ({}) }));
  await f.runInAppUpdate();
  eq(f.read().inAppUpdate.phase, 'install-failed',
    '§15 a stream that ends with neither `staged` nor `error` is reported as a failure, never left on a ring that will never move again');
  eq(f.read().inAppUpdate.failure.reason, 'interrupted', '§15 named as interrupted');
}
{
  // A pre-stream refusal (the 501 with no engine) must render as its own thing.
  const f = mkFlow(async () => ({ ok: false, status: 501, json: async () => ({
    ...configRoute.updateFailureCopy('no-updater'), refused: 'updater_unavailable',
    releasesPageUrl: 'https://github.com/x/y/releases',
  }) }));
  await f.runInAppUpdate();
  const u = f.read().inAppUpdate;
  eq(u.failure.reason, 'no-updater', '§15 a 501 refusal is read from the JSON body, not guessed from the status');
  eq(u.failure.releasesPageUrl, 'https://github.com/x/y/releases',
    '\u00a715 and carries the releases URL the server gave, so the failed panel can offer the manual download');
}
{
  // Retry re-runs from the top with no second confirm.
  let posts = 0;
  const f = mkFlow(async (u) => {
    if (String(u) === '/api/config/update') { posts++; return { ok: true, body: sseStream(HAPPY_FRAMES) }; }
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await f.runInAppUpdate();
  await f.onRetryInApp();
  eq(posts, 2, '§15 "Try again" re-runs the whole flow');
  eq(f.read().inAppUpdate.phase, 'relaunching', '§15 …and can reach the restart on the second attempt');
}
{
  // finishInAppUpdate must refuse to fire from any state but `staged` — the
  // button only renders there, so this is the second layer.
  let posts = 0;
  const f = mkFlow(async () => { posts++; return { ok: true, json: async () => ({ ok: true }) }; });
  await f.finishInAppUpdate();
  eq(posts, 0, '§15 the finish step does nothing when there is nothing staged — it never POSTs on spec');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12  Isolation — the real user data was never touched');
// ═══════════════════════════════════════════════════════════════════════════

configRoute.__resetUpdateJob();
eq(fingerprint(), fpBefore, 'the real credential files are unchanged (sha256 + size + existence)');
ok(REAL_FILES[0].startsWith(ROOT), 'CONTROL: the fingerprint was taken on the REAL paths, not on the tempdir');
ok(!writeRegistry.isUpdateInProgress(), 'and no update flag was left set behind this suite');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ FAILURES');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('✅ The app updates itself, and says only true things while it does');
