/**
 * test-install-mode.js — OFFLINE suite for `src/brain/install-mode.js` and the
 * routes that FORK on it.
 *
 * ── What this is guarding, and why it matters NOW ───────────────────────────
 *
 * The bundle arm of every fork below is UNREACHABLE in production today —
 * `scripts/build-app.sh` builds an AppleScript wrapper that RUNS THE CHECKOUT,
 * so that .app is a repo install (see `src/brain/paths.js`). That is exactly
 * why the fork is written now: while it is provably dead code, the whole
 * release is a no-op for every existing user, and the ONE claim that has to
 * hold is that the repo arm behaves precisely as it did before.
 *
 * So the headline assertion here is not "the bundle arm works". It is:
 *
 *     in repo mode, `POST /api/config/update` issues the SAME six commands,
 *     in the SAME order, with the SAME strings, as it did at HEAD~.
 *
 * §6 pins those six as LITERALS TRANSCRIBED INTO THIS FILE — never read back
 * out of `src/routes/config.js`, which would be the "expected value read from
 * the same constant the code reads" defect `test-source-scan-helpers.js`
 * exists to prevent.
 *
 * ── Sections ────────────────────────────────────────────────────────────────
 *
 *   §1  isolation + real-credential fingerprint
 *   §2  the capability record is exhaustive BY CONSTRUCTION, and frozen
 *   §3  the mode derives from paths.js's real signal — proven in CHILD
 *       PROCESSES against materialised trees, because APP_ROOT is fixed at
 *       module load (the technique `test-paths.js` §2 established)
 *   §4  fork sites ENUMERATED FROM DISK — never a hardcoded list — plus the
 *       rule that makes capability-branching real: no route may branch on the
 *       MODE
 *   §5  both arms of both forked handlers, driven through an INJECTED seam
 *   §6  the repo arm's command strings, pinned
 *   §7  the semver verdict, and agreement with /next's own compareSemver
 *   §8  GET /api/write-status
 *   §9  the git-missing message, and the confidently-wrong one it replaces
 *   §10 anti-vacuity controls + what is NOT enforced
 *
 * `POST /api/config/update` is NEVER invoked against the real implementations,
 * at any point, under any condition: it runs `git fetch` + `git reset --hard
 * origin/main` against the REAL checkout regardless of which process calls it.
 * Every invocation here injects a fake exec that RECORDS commands and runs
 * none. That injection is the whole reason the seam exists.
 *
 * Dependency-free (node: builtins only), no network, no API key, no writes
 * outside os.tmpdir().
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const same = actual === expected;
  ok(same, `${label}${same ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`);
}
function section(t) { console.log(`\n${t}`); }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Isolation — nothing here may reach a real credential file');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-installmode-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(TMP_DOMAINS, { recursive: true });

// BOTH seams, before any app module is imported. CURATOR_TEST_DOMAINS_DIR alone
// leaves the developer's real .sync-config.json (and its GitHub PAT) in reach.
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
// DOMAINS_PATH still outranks the default inside getDomainsDir(); an inherited
// one would point an "isolated" run at a real wiki (see paths.js's docblock).
delete process.env.DOMAINS_PATH;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(ROOT, f));

// sha256 + size + existence ONLY. mtime is deliberately excluded: the
// maintainer's live app rewrites .curator-config.json during ordinary Settings
// use, and an mtime-sensitive guard would then report a false "isolation is
// broken" (the v3.0.16 misattribution shape).
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!fs.existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = fs.readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const fpBefore = fingerprint();
ok(typeof fpBefore === 'string' && fpBefore.length > 0, 'real credential files fingerprinted before the run');

// install-mode.js THROWS AT MODULE LOAD if a capability record is not
// exhaustive — that throw is the designed loud failure. But an unhandled
// module-load throw kills the run with a raw stack, naming no expectation and
// leaving the tally wrong (the v3.24.1 "crash instead of a named assertion"
// shape). Caught here so the exhaustiveness failure is REPORTED as one, then
// exited, because nothing below can run without the module.
let installMode;
try {
  installMode = await import(path.join(ROOT, 'src/brain/install-mode.js'));
  ok(true, 'src/brain/install-mode.js loads (its exhaustiveness check passed at module load)');
} catch (err) {
  ok(false, `src/brain/install-mode.js FAILED to load: ${err && err.message}`);
  console.log(`\nPassed: ${passed}   Failed: ${failed}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
const configRoute = await import(path.join(ROOT, 'src/routes/config.js'));
const writeStatus = await import(path.join(ROOT, 'src/routes/write-status.js'));
const writeRegistry = await import(path.join(ROOT, 'src/brain/write-registry.js'));
const sync = await import(path.join(ROOT, 'src/brain/sync.js'));

// ═══════════════════════════════════════════════════════════════════════════
section('§2  The capability record — exhaustive by construction, and frozen');
// ═══════════════════════════════════════════════════════════════════════════

// The key list is transcribed here, NOT read from CAPABILITY_KEYS. Reading it
// from the module would make "every mode carries every key" tautological — the
// set would be defined by whatever the module happens to hold.
const EXPECTED_CAPABILITY_KEYS = [
  'canSelfUpdateViaGit',
  'canRunNpmInstall',
  'canRebuildAppleScriptApp',
  'canWriteBesideCode',
  'mcpLaunchStyle',
  'restartStyle',
];
const EXPECTED_MODES = ['repo', 'bundle'];

eq([...installMode.INSTALL_MODES].sort().join(','), [...EXPECTED_MODES].sort().join(','),
  'INSTALL_MODES is exactly {repo, bundle}');
eq([...installMode.CAPABILITY_KEYS].sort().join(','), [...EXPECTED_CAPABILITY_KEYS].sort().join(','),
  'CAPABILITY_KEYS matches the independently-transcribed list');

for (const mode of EXPECTED_MODES) {
  const caps = installMode.getCapabilities(mode);
  const have = Object.keys(caps).sort().join(',');
  eq(have, [...EXPECTED_CAPABILITY_KEYS].sort().join(','),
    `"${mode}" carries EVERY capability key and no others`);
  for (const k of EXPECTED_CAPABILITY_KEYS) {
    ok(caps[k] !== undefined, `"${mode}".${k} is defined (undefined would be falsy — the silent restrictive arm)`);
  }
  ok(Object.isFrozen(caps), `"${mode}" record is frozen`);
}

// The values themselves. Transcribed, not derived — a table that reads its own
// expectations off the module cannot fail.
eq(installMode.getCapabilities('repo').canSelfUpdateViaGit, true, 'repo CAN self-update via git');
eq(installMode.getCapabilities('repo').canRunNpmInstall, true, 'repo CAN run npm install');
eq(installMode.getCapabilities('repo').canRebuildAppleScriptApp, true, 'repo CAN rebuild the AppleScript .app');
eq(installMode.getCapabilities('repo').canWriteBesideCode, true, 'repo CAN write beside its code');
eq(installMode.getCapabilities('bundle').canSelfUpdateViaGit, false, 'bundle CANNOT self-update via git');
eq(installMode.getCapabilities('bundle').canRunNpmInstall, false, 'bundle CANNOT run npm install');
eq(installMode.getCapabilities('bundle').canRebuildAppleScriptApp, false,
  'bundle CANNOT rebuild the .app (build-app.sh ends in `codesign --force --deep --sign -`)');
eq(installMode.getCapabilities('bundle').canWriteBesideCode, false, 'bundle CANNOT write beside its code');

// A programming error must be LOUD. This is not the environment-driven unknown
// case — that one resolves to 'repo' inside getInstallMode(), proven in §3.
let threw = null;
try { installMode.getCapabilities('homebrew-cask'); } catch (e) { threw = e; }
ok(threw instanceof Error && /unknown install mode/i.test(threw.message),
  'getCapabilities() throws on an unknown mode rather than silently returning undefined');

// describeInstall() is an explicit allow-list, never a spread of internals.
const desc = installMode.describeInstall('bundle');
eq(Object.keys(desc).sort().join(','), 'capabilities,installMode,installModeLabel',
  'describeInstall() returns exactly {installMode, installModeLabel, capabilities}');
eq(desc.installMode, 'bundle', 'describeInstall honours an explicit mode argument');
eq(Object.keys(desc.capabilities).sort().join(','), [...EXPECTED_CAPABILITY_KEYS].sort().join(','),
  'describeInstall().capabilities carries every key');

// The refusal body.
const refusal = installMode.capabilityRefusal('canSelfUpdateViaGit', 'update the app');
eq(refusal.status, 501, 'capabilityRefusal() is a 501, not a 403 (the server is not withholding permission)');
ok(refusal.body.refused === 'capability_unavailable', 'refusal body carries a machine-readable `refused` code');
ok(refusal.body.capability === 'canSelfUpdateViaGit', 'refusal body NAMES the capability');
ok(/update the app/.test(refusal.body.error), 'refusal error names the ACTION the user attempted');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The mode derives from the real signal — child-process probes');
// ═══════════════════════════════════════════════════════════════════════════

// APP_ROOT is `path.resolve(<paths.js's dir>, '../..')`, fixed at module load,
// so the only honest way to exercise the bundle arm is to materialise a tree at
// a bundle-shaped path and import from THERE. Technique from test-paths.js §2.
function materialise(dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('/bin/sh', ['-c',
    `git -C ${JSON.stringify(ROOT)} archive HEAD | tar -x -C ${JSON.stringify(dest)}`]);
  // paths.js and install-mode.js may be newer than HEAD in the working tree.
  fs.mkdirSync(path.join(dest, 'src', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'src/brain/paths.js'), read('src/brain/paths.js'));
  fs.writeFileSync(path.join(dest, 'src/brain/install-mode.js'), read('src/brain/install-mode.js'));
  return dest;
}

function probeMode(appRoot, home) {
  const script = `
    import * as m from ${JSON.stringify(path.join(appRoot, 'src/brain/install-mode.js'))};
    process.stdout.write(JSON.stringify({
      mode: m.getInstallMode(),
      caps: m.getCapabilities(),
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, CURATOR_TEST_USER_DATA_DIR: '', CURATOR_TEST_DOMAINS_DIR: '' },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],   // swallow the bundle-mode stderr notice
  });
  return JSON.parse(out);
}

const fakeHome = path.join(TMP, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

const repoTree = materialise(path.join(TMP, 'checkout'));
fs.mkdirSync(path.join(repoTree, '.git'), { recursive: true });
const repoProbe = probeMode(repoTree, fakeHome);
eq(repoProbe.mode, 'repo', 'a normal checkout resolves to mode "repo"');
eq(repoProbe.caps.canSelfUpdateViaGit, true, 'a normal checkout gets the git-capable arm');

// The unrecognised-layout case: no .git, no marker, no bundle path shape. It
// must resolve to 'repo' — the direction that fails LOUDLY (see paths.js).
const strayTree = materialise(path.join(TMP, 'stray'));
fs.rmSync(path.join(strayTree, '.git'), { recursive: true, force: true });
const strayProbe = probeMode(strayTree, fakeHome);
eq(strayProbe.mode, 'repo', 'an UNRECOGNISED layout falls to "repo" — the fail-safe direction, inherited from paths.js');

// A real macOS bundle path shape: <X>.app/Contents/Resources.
const bundleTree = materialise(path.join(TMP, 'The Curator.app', 'Contents', 'Resources'));
const bundleProbe = probeMode(bundleTree, fakeHome);
eq(bundleProbe.mode, 'bundle', 'a *.app/Contents/... layout resolves to mode "bundle"');
eq(bundleProbe.caps.canSelfUpdateViaGit, false, 'a bundle gets the git-INCAPABLE arm');
eq(bundleProbe.caps.canRebuildAppleScriptApp, false, 'a bundle may not re-run build-app.sh');

// The marker file alone, on a non-bundle path — the packager's explicit signal.
const markerTree = materialise(path.join(TMP, 'marked'));
fs.writeFileSync(path.join(markerTree, '.curator-bundle'), '');
eq(probeMode(markerTree, fakeHome).mode, 'bundle', 'the .curator-bundle marker alone flips the mode');

// And the fact this whole release rests on: TODAY, here, we are repo.
eq(installMode.getInstallMode(), 'repo', 'THIS checkout is repo mode — so every fork below takes the unchanged arm');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  Fork sites ENUMERATED FROM DISK (never a hardcoded list)');
// ═══════════════════════════════════════════════════════════════════════════

// `test-route-write-guards.js` audits from a hardcoded list in which
// src/routes/ingest.js appears ZERO times — a list cannot notice a file nobody
// added to it. This walks src/routes/ instead.
const routeFiles = fs.readdirSync(path.join(ROOT, 'src/routes'))
  .filter(f => f.endsWith('.js'))
  .sort();
ok(routeFiles.length >= 10, `enumerated ${routeFiles.length} route files from disk (not a literal list)`);

// Strip COMMENTS before scanning, so a rule cannot be satisfied — or falsely
// triggered — by prose in a docblock. (test-next-button-chrome.js learned this
// one the hard way: an unstripped comment hid three real bugs, and this file's
// own §4 rules are stated in prose directly above the code they describe.)
//
// String literals are DELIBERATELY NOT stripped. A first draft did, and a naive
// quote-matcher ran away on apostrophes in surviving text, collapsing
// src/routes/config.js from 42 KB to 5 KB and reporting ZERO fork sites — a
// scanner that silently stops matching reports "all clear" forever, which is
// exactly the class §10's anti-vacuity controls exist for. The residual risk is
// the opposite direction (a capability name inside a string could be counted),
// which produces a red test someone investigates rather than a silent pass.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const stripCommentsAndStrings = stripComments;   // name kept at the call sites

// A fork site = a route file that reads a capability off getCapabilities().
const discovered = [];
for (const f of routeFiles) {
  const code = stripCommentsAndStrings(read(path.join('src/routes', f)));
  if (!/getCapabilities\s*\(/.test(code)) continue;
  const caps = EXPECTED_CAPABILITY_KEYS.filter(k => new RegExp(`\\b${k}\\b`).test(code));
  discovered.push({ file: f, caps });
}
ok(discovered.length >= 1, `discovered ${discovered.length} route file(s) that fork on a capability`);
for (const d of discovered) {
  ok(d.caps.length >= 1, `${d.file} names at least one capability key (a fork on nothing is not a fork)`);
}

// THE RULE THAT MAKES CAPABILITY-BRANCHING REAL, rather than aspirational.
// Today all four booleans are perfectly correlated with mode === 'repo', so
// nothing MEASURABLE distinguishes them; what distinguishes them is that a
// third mode must be a decision someone writes into the table, not a default
// inherited by every `!== 'bundle'` in the tree.
const MODE_BRANCH = /getInstallMode\s*\(\s*\)\s*[!=]==?\s*|isRepoInstall\s*\(|isBundleInstall\s*\(/;
for (const f of routeFiles) {
  const code = stripCommentsAndStrings(read(path.join('src/routes', f)));
  ok(!MODE_BRANCH.test(code),
    `src/routes/${f} does NOT branch on the install FORM — capability only`);
}

// Anti-vacuity: prove the scanner CAN see a mode-branch when one exists.
ok(MODE_BRANCH.test('if (getInstallMode() === "bundle") {}'),
  'CONTROL: the mode-branch detector fires on a planted getInstallMode() comparison');
ok(MODE_BRANCH.test('if (isRepoInstall()) {}'),
  'CONTROL: the mode-branch detector fires on a planted isRepoInstall() call');
ok(!MODE_BRANCH.test('const caps = getCapabilities(); if (caps.canSelfUpdateViaGit) {}'),
  'CONTROL: the detector does NOT fire on correct capability-branching');

// Every DISCOVERED fork site must be behaviourally covered below. A new fork
// added to a new route file, with no entry here, goes RED — which is the whole
// point of enumerating from disk rather than listing.
const BEHAVIOURALLY_COVERED = new Set(['config.js']);
for (const d of discovered) {
  ok(BEHAVIOURALLY_COVERED.has(d.file),
    `${d.file} has behavioural both-arm coverage in §5 (add it there, not to a list, if this fails)`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Both arms, driven through the INJECTED seam (never a source scan)');
// ═══════════════════════════════════════════════════════════════════════════

function fakeRes() {
  const r = { statusCode: 200, body: null, ended: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  return r;
}
const REPO_CAPS = installMode.getCapabilities('repo');
const BUNDLE_CAPS = installMode.getCapabilities('bundle');

// A fake exec that RECORDS and RUNS NOTHING. This is why the seam exists: the
// real bodies would `git reset --hard origin/main` this very worktree.
function recordingExec(responses = {}) {
  const calls = [];
  return {
    calls,
    exec: async (cmd) => {
      calls.push(cmd);
      if (Object.hasOwn(responses, cmd)) return responses[cmd];
      return { stdout: '', stderr: '' };
    },
  };
}

// ── GET /update-check ──────────────────────────────────────────────────────
{
  const rec = recordingExec({ 'git rev-parse --short HEAD': { stdout: 'aaaaaaa\n' } });
  const res = fakeRes();
  await configRoute.updateCheckHandler({}, res, {
    caps: BUNDLE_CAPS, execAsync: rec.exec, fetch: async () => { throw new Error('network must not be reached'); },
  });
  eq(res.statusCode, 501, 'update-check BUNDLE arm answers 501');
  eq(res.body.refused, 'capability_unavailable', 'update-check bundle arm names the refusal code');
  eq(res.body.capability, 'canSelfUpdateViaGit', 'update-check bundle arm names the capability');
  eq(res.body.updateAvailable, false, 'update-check bundle arm reports updateAvailable:false, not silence');
  eq(rec.calls.length, 0, 'update-check bundle arm runs ZERO subprocesses — it returns before any of them');
}
{
  const rec = recordingExec({ 'git rev-parse --short HEAD': { stdout: 'aaaaaaa\n' } });
  let fetched = 0;
  const res = fakeRes();
  await configRoute.updateCheckHandler({}, res, {
    caps: REPO_CAPS,
    execAsync: rec.exec,
    fetch: async (url) => {
      fetched++;
      if (String(url).includes('raw.githubusercontent.com')) {
        return { ok: true, json: async () => ({ version: '9.9.9' }) };
      }
      return { ok: true, text: async () => 'bbbbbbbccccccc' };
    },
  });
  eq(res.statusCode, 200, 'update-check REPO arm is reachable (not 501) when the capability is present');
  eq(res.body.latest, '9.9.9', 'update-check repo arm reports the remote version it fetched');
  eq(res.body.localCommit, 'aaaaaaa', 'update-check repo arm reports the local commit it read');
  ok(rec.calls.includes('git rev-parse --short HEAD'),
    'update-check repo arm still issues `git rev-parse --short HEAD`');
  ok(fetched >= 1, 'update-check repo arm still reaches the network layer');
}
{
  // THE CALL SITE, not just the function. §7 proves decideUpdateAvailable() is
  // right; this proves the ROUTE uses it. Mutation M6 — restoring the original
  // `latest !== current || commitsDiffer` inline in the handler — first ran
  // GREEN at 157/0 with only §7 in place, because every route-level fixture
  // happened to be a remote-newer case where the buggy and correct verdicts
  // agree. That is this repo's "function executed but its call site never
  // asserted" shape, and it is the exact defect the release fixes.
  //
  // `latest: '0.0.1'` is unambiguously older than any real package.json
  // version, and the commits DIFFER — so the pre-fix code answers
  // updateAvailable:true and offers a button that runs `git reset --hard
  // origin/main`: a downgrade.
  const rec = recordingExec({ 'git rev-parse --short HEAD': { stdout: 'aaaaaaa\n' } });
  const res = fakeRes();
  await configRoute.updateCheckHandler({}, res, {
    caps: REPO_CAPS,
    execAsync: rec.exec,
    fetch: async (url) => (String(url).includes('raw.githubusercontent.com')
      ? { ok: true, json: async () => ({ version: '0.0.1' }) }
      : { ok: true, text: async () => 'bbbbbbbccccccc' }),
  });
  eq(res.body.updateAvailable, false,
    'ON THE WIRE: a local build AHEAD of the published one is NOT offered an update (the live bug)');
  eq(res.body.localAhead, true,
    'ON THE WIRE: local-ahead is reported, so "current" and "ahead" stay distinguishable');
  eq(res.body.latest, '0.0.1', 'CONTROL: the fixture really did serve an older remote version');
  eq(res.body.remoteCommit, 'bbbbbbb',
    'CONTROL: the commits really do differ, so the old code would have said updateAvailable:true');
}

// ── POST /update ───────────────────────────────────────────────────────────
{
  const rec = recordingExec();
  const res = fakeRes();
  await configRoute.updateHandler({}, res, { caps: BUNDLE_CAPS, execAsync: rec.exec });
  eq(res.statusCode, 501, 'update BUNDLE arm answers 501');
  eq(res.body.capability, 'canSelfUpdateViaGit', 'update bundle arm names the capability');
  eq(rec.calls.length, 0, 'update bundle arm runs ZERO subprocesses — no git, no npm, no build-app.sh');
  ok(!writeRegistry.isUpdateInProgress(), 'update bundle arm leaves the update flag CLEAR (it never began one)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The repo arm issues the SAME commands it always did');
// ═══════════════════════════════════════════════════════════════════════════

// TRANSCRIBED from `git show HEAD~<n>:src/routes/config.js` at authoring time,
// deliberately NOT read back out of the module. An expectation read from the
// source it is checking cannot fail.
const PRE_FORK_UPDATE_COMMANDS = [
  'git fetch origin main',
  'git rev-parse HEAD',
  'git reset --hard origin/main',
  'git rev-parse HEAD',
  'npm install --silent --no-audit --no-fund',
  'bash scripts/build-app.sh',
];
// The ONE addition this release makes, and it is declared rather than hidden.
const PREFLIGHT_COMMAND = 'git --version';

{
  const rec = recordingExec({ 'git rev-parse HEAD': { stdout: '1234567890abcdef\n' } });
  const res = fakeRes();
  await configRoute.updateHandler({}, res, { caps: REPO_CAPS, execAsync: rec.exec });

  eq(res.statusCode, 200, 'update REPO arm is reachable and succeeds against the fake exec');
  eq(res.body.restarting, true, 'update repo arm still reports `restarting: true`');
  eq(res.body.from, '1234567', 'update repo arm still reports the short before-SHA');
  eq(res.body.to, '1234567', 'update repo arm still reports the short after-SHA');

  eq(rec.calls[0], PREFLIGHT_COMMAND, 'the git preflight runs FIRST');
  const rest = rec.calls.slice(1);
  eq(rest.join(' | '), PRE_FORK_UPDATE_COMMANDS.join(' | '),
    'the six pre-fork commands are UNCHANGED, in order, byte for byte');
  eq(rec.calls.length, PRE_FORK_UPDATE_COMMANDS.length + 1,
    'exactly one command was ADDED and none removed');
  ok(!writeRegistry.isUpdateInProgress(), 'the update flag is cleared in `finally` on the success path');
}

// The preflight's own behaviour: git missing must not surface as raw shell text.
{
  const rec = recordingExec();
  const failing = async (cmd) => {
    rec.calls.push(cmd);
    if (cmd === PREFLIGHT_COMMAND) throw new Error('/bin/sh: git: command not found');
    return { stdout: '' };
  };
  const res = fakeRes();
  await configRoute.updateHandler({}, res, { caps: REPO_CAPS, execAsync: failing });
  eq(res.statusCode, 500, 'a missing git fails the update');
  ok(/xcode-select --install/.test(res.body.error),
    'the update error names the REMEDY (`xcode-select --install`), not the raw shell text');
  ok(!/command not found/.test(res.body.error),
    'the raw "command not found" text does not reach the user');
  eq(rec.calls.length, 1, 'the preflight STOPS the flow — `git fetch` is never attempted');
  ok(!writeRegistry.isUpdateInProgress(), 'the update flag is cleared in `finally` on the failure path too');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  The semver verdict — the live bug, and /next agreement');
// ═══════════════════════════════════════════════════════════════════════════

const D = configRoute.decideUpdateAvailable;

// THE BUG. `latest !== current` is true in BOTH directions, so a checkout ahead
// of main reported an update whose button runs `git reset --hard origin/main`.
eq(D({ current: '3.26.0', latest: '3.25.0', localCommit: 'aaa', remoteCommit: 'bbb' }).updateAvailable, false,
  'local AHEAD of remote is NOT an update — even though the commits differ (the case the old code got wrong)');
eq(D({ current: '3.26.0', latest: '3.25.0', localCommit: 'aaa', remoteCommit: 'bbb' }).localAhead, true,
  'local-ahead is REPORTED, so a client can tell it apart from "up to date"');

// UNCHANGED cases — the no-op half.
eq(D({ current: '3.25.0', latest: '3.26.0', localCommit: 'aaa', remoteCommit: 'bbb' }).updateAvailable, true,
  'remote genuinely newer IS an update');
eq(D({ current: '3.25.0', latest: '3.25.0', localCommit: 'aaa', remoteCommit: 'bbb' }).updateAvailable, true,
  'same version, different commits IS an update (the legitimate commitsDiffer case, unchanged)');
eq(D({ current: '3.25.0', latest: '3.25.0', localCommit: 'aaa', remoteCommit: 'aaa' }).updateAvailable, false,
  'same version, same commit is NOT an update');
eq(D({ current: '3.25.0', latest: '3.25.0', localCommit: null, remoteCommit: null }).updateAvailable, false,
  'no commit information and equal versions is NOT an update');
eq(D({ current: '3.25.0', latest: '3.26.0', localCommit: null, remoteCommit: null }).updateAvailable, true,
  'version comparison alone still drives the verdict when commits are unknown');
// Fail-safe: unparseable collapses to 0, which leaves commitsDiffer in charge.
eq(D({ current: 'nightly', latest: '3.26.0', localCommit: 'aaa', remoteCommit: 'bbb' }).updateAvailable, true,
  'an UNPARSEABLE version never suppresses a real update (uncomparable => 0 => old behaviour)');
eq(D({ current: 'nightly', latest: '3.26.0', localCommit: 'aaa', remoteCommit: 'bbb' }).localAhead, false,
  'an unparseable version is never guessed to be ahead');
// The retired pre-release line: cores equal => 0.
eq(D({ current: '3.0.1-beta.27', latest: '3.0.1', localCommit: null, remoteCommit: null }).localAhead, false,
  'a pre-release suffix does not make the local build read as ahead');

// The two compareSemver implementations MUST agree — /next applies its own
// local-ahead guard on top of this route's verdict, and a disagreement makes
// the UI contradict itself.
const nextSrc = read('src/public/next/views/settings.js');
const m = nextSrc.match(/function compareSemver\(a, b\) \{[\s\S]*?\n\}/);
ok(!!m, 'located /next\'s own compareSemver (if this fails the agreement check below is vacuous)');
const nextCompare = m ? new Function(`${m[0]}; return compareSemver;`)() : null;
const PAIRS = [
  ['3.25.0', '3.26.0'], ['3.26.0', '3.25.0'], ['3.25.0', '3.25.0'],
  ['3.25.0', '3.25.1'], ['4.0.0', '3.99.99'], ['3.0.1-beta.27', '3.0.1'],
  ['nightly', '3.0.0'], ['3.0.0', ''], ['1.2.3.4', '1.2.3.5'], ['1.2.3.4.5', '1.2.3'],
];
let agree = 0;
for (const [a, b] of PAIRS) {
  const mine = Math.sign(configRoute.compareSemver(a, b));
  const theirs = nextCompare ? Math.sign(nextCompare(a, b)) : NaN;
  if (mine === theirs) agree++;
  else ok(false, `compareSemver disagreement on (${a}, ${b}): route=${mine} next=${theirs}`);
}
eq(agree, PAIRS.length, `route and /next compareSemver agree on all ${PAIRS.length} pairs`);
// Anti-vacuity: the comparator is not a constant function.
ok(new Set(PAIRS.map(([a, b]) => Math.sign(configRoute.compareSemver(a, b)))).size >= 3,
  'CONTROL: the comparison table exercises all three outcomes (-1, 0, +1)');

// ── §7b  The A/B that bounds the blast radius ──────────────────────────────
//
// The semver fix is a DELIBERATE behaviour change, so "nothing changed" is the
// wrong claim. The right one is that the change is CONFINED to local-ahead.
// This runs the pre-change expression — transcribed verbatim from
// `git show 53189e3:src/routes/config.js` — beside the shipped one over the
// whole matrix and requires the changed set to be exactly the local-ahead rows.
//
// THIS SECTION EARNED ITS KEEP BEFORE IT WAS COMMITTED. The first draft of
// decideUpdateAvailable used `versionDiffers = cmp < 0` alone, and this A/B
// reported 12 changed cells rather than 6: `compareSemver` returns 0 for
// UNCOMPARABLE as well as EQUAL, so `nightly` vs `3.25.0` (and
// `3.0.1-beta.27` vs `3.0.1`) with matching or unknown commits went from
// "update offered" to "no update" — the harmful direction, hiding a real
// update behind a string the comparator could not parse.
function preChangeVerdict({ current, latest, localCommit, remoteCommit }) {
  const versionDiffers = latest !== current;
  const commitsDiffer = localCommit && remoteCommit && localCommit !== remoteCommit;
  return Boolean(versionDiffers || commitsDiffer);
}
const AB_VERSIONS = [
  ['3.25.0', '3.26.0', false], ['3.25.0', '3.25.0', false], ['3.26.0', '3.25.0', true],
  ['3.25.0', '4.0.0', false],  ['4.0.0', '3.25.0', true],   ['nightly', '3.25.0', false],
  ['3.25.0', 'nightly', false], ['3.0.1-beta.27', '3.0.1', false],
];
const AB_COMMITS = [['aaaaaaa', 'bbbbbbb'], ['aaaaaaa', 'aaaaaaa'], [null, null]];
let abSame = 0, abChanged = 0, abUnexpected = 0, abAheadCells = 0;
for (const [current, latest, isAhead] of AB_VERSIONS) {
  for (const [localCommit, remoteCommit] of AB_COMMITS) {
    const args = { current, latest, localCommit, remoteCommit };
    const before = preChangeVerdict(args);
    const after = D(args).updateAvailable;
    if (isAhead) abAheadCells++;
    if (before === after) { abSame++; if (isAhead) abUnexpected++; }
    else { abChanged++; if (!isAhead) { abUnexpected++; ok(false, `UNEXPECTED CHANGE: ${current} vs ${latest}, commits ${localCommit}/${remoteCommit}: ${before} -> ${after}`); } }
  }
}
eq(abSame + abChanged, AB_VERSIONS.length * AB_COMMITS.length, `A/B covered all ${AB_VERSIONS.length * AB_COMMITS.length} cells`);
eq(abChanged, abAheadCells, `EXACTLY the ${abAheadCells} local-ahead cells changed verdict — every other cell is byte-identical to the pre-change expression`);
eq(abUnexpected, 0, 'no cell outside local-ahead changed, and no local-ahead cell failed to change');
// Anti-vacuity: the A/B must actually contain both a changed and an unchanged
// cell, or "the changed set is exactly X" is satisfiable by an empty X.
ok(abChanged > 0 && abSame > 0, 'CONTROL: the A/B matrix contains both changed and unchanged cells');

// ═══════════════════════════════════════════════════════════════════════════
section('§8  GET /api/write-status — "is it safe to quit?"');
// ═══════════════════════════════════════════════════════════════════════════

{
  const s = writeStatus.buildWriteStatus();
  eq(s.safeToQuit, true, 'an idle app reports safeToQuit:true');
  eq(s.activeWrites, false, 'an idle app reports activeWrites:false');
  eq(s.updateInProgress, false, 'an idle app reports updateInProgress:false');
  eq(s.operationsTotal, 0, 'an idle app lists zero operations');
}
{
  // Against the REAL registry, not a stub — this is the negative half that
  // tells "correctly reports busy" apart from "hardcoded false".
  const release = writeRegistry.registerWrite('zztest-domain', 'ingest');
  try {
    const s = writeStatus.buildWriteStatus();
    eq(s.safeToQuit, false, 'a live write makes safeToQuit false');
    eq(s.activeWrites, true, 'a live write is reported');
    eq(s.operationsTotal, 1, 'the operation total is the TRUE total');
    eq(s.operations[0].domain, 'zztest-domain', 'the operation names its domain');
    ok(s.operations[0].ops.includes('ingest'), 'the operation names its op');
    // The reason this is a READ route: it must ANSWER while busy, not 409.
    ok(s.ok === true, 'the endpoint still answers ok:true while a write is running (a 409 here would be useless)');
  } finally {
    release();
  }
}
{
  writeRegistry.beginUpdate();
  try {
    const s = writeStatus.buildWriteStatus();
    eq(s.safeToQuit, false, 'an update in progress ALSO makes safeToQuit false');
    eq(s.updateInProgress, true, 'an update in progress is reported separately from writes');
  } finally {
    writeRegistry.endUpdate();
  }
}
{
  // The cap must never be mistaken for a measurement (v3.17.0's rule).
  const many = Array.from({ length: writeStatus.MAX_LISTED_OPERATIONS + 7 },
    (_, i) => ({ domain: `d${i}`, count: 1, ops: ['ingest'] }));
  const s = writeStatus.buildWriteStatus({
    listActiveWrites: () => many,
    hasActiveWrites: () => true,
    isUpdateInProgress: () => false,
  });
  eq(s.operations.length, writeStatus.MAX_LISTED_OPERATIONS, 'the operations array is capped');
  eq(s.operationsTotal, many.length, 'the TRUE total is reported alongside the capped array');
}
{
  // Explicit allow-list — never a spread of registry internals.
  const s = writeStatus.buildWriteStatus({
    listActiveWrites: () => [{ domain: 'd', count: 1, ops: ['ingest'], secret: 'PAT', internalHandle: {} }],
    hasActiveWrites: () => true,
    isUpdateInProgress: () => false,
  });
  eq(Object.keys(s.operations[0]).sort().join(','), 'count,domain,ops',
    'an operation carries exactly {domain, count, ops} — extra fields are DROPPED, not spread');
}

// It must be registered, and registered as a plain GET.
{
  const serverSrc = stripCommentsAndStrings(read('src/server.js'));
  ok(/app\.use\(\s*''\s*,\s*writeStatusRouter\s*\)/.test(serverSrc.replace(/'[^']*'/g, "''")) ||
     /writeStatusRouter/.test(serverSrc),
    'the write-status router is mounted in server.js');
  const routeSrc = stripCommentsAndStrings(read('src/routes/write-status.js'));
  ok(/router\.get\(/.test(routeSrc), 'write-status is a GET');
  ok(!/router\.(post|put|delete|patch)\(/.test(routeSrc), 'write-status exposes no mutating verb');
  ok(!/guardConcurrent/.test(routeSrc), 'write-status is NOT behind guardConcurrent (a 409 would fire exactly when asked)');
  ok(!/registerWrite\s*\(/.test(routeSrc), 'write-status does not register a write of its own (it would report itself)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  The confidently-wrong git diagnosis, fixed at source');
// ═══════════════════════════════════════════════════════════════════════════

const GIT_MISSING_FORMS = [
  '/bin/sh: git: command not found',
  'Command failed: git status\n/bin/sh: line 1: git: command not found',
  'sh: git: not found',
  'spawn git ENOENT',
  "'git' is not recognized as an internal or external command, operable program or batch file.",
];
for (const raw of GIT_MISSING_FORMS) {
  const msg = sync.friendlyError(new Error(raw));
  ok(/xcode-select --install/.test(msg),
    `"${raw.slice(0, 40)}…" -> a message naming the remedy`);
  ok(!/Repository not found/.test(msg),
    `"${raw.slice(0, 40)}…" is NOT diagnosed as "Repository not found" (the pre-fix answer)`);
}
// The branch it sits above must still work — this is the half people forget.
ok(/Repository not found/.test(sync.friendlyError(new Error('remote: Repository not found.'))),
  'a REAL repository-not-found is still diagnosed as such');
ok(/GitHub rejected the token/.test(sync.friendlyError(new Error('fatal: Authentication failed for https://github.com/x/y'))),
  'the auth branch below the new one still fires');
ok(/couldn\u2019t be resolved automatically|could not be resolved automatically|manual look/.test(
  sync.friendlyError(new Error('Automatic merge failed; fix conflicts and then commit the result.'))),
  'the load-bearing merge-conflict branch ABOVE the auth branch still fires');

// Both git-missing messages (sync + update) must carry the same remedy.
const updateSrc = read('src/routes/config.js');
ok(/xcode-select --install/.test(updateSrc), 'the update route carries the same `xcode-select --install` remedy');

// ═══════════════════════════════════════════════════════════════════════════
section('§10  Surfacing, anti-vacuity, and what is NOT enforced');
// ═══════════════════════════════════════════════════════════════════════════

{
  const diagnostics = await import(path.join(ROOT, 'src/brain/diagnostics.js'));
  const { checks } = await diagnostics.runQuickDiagnostics();
  const ids = checks.map(c => c.id);
  ok(ids.includes('install-mode'), 'System Check reports the install mode');
  ok(ids.includes('git'), 'System Check reports git availability');
  // Guarded: a missing row must produce NAMED failures, not a TypeError that
  // aborts the run and leaves the tally wrong. M14 (dropping both rows) hit
  // exactly that and printed two reds with no `Failed:` line at all.
  const im = checks.find(c => c.id === 'install-mode') || { status: '(absent)', detail: '' };
  eq(im.status, 'info', 'the install-mode row is INFO — neither mode is an error');
  ok(/repo/.test(im.detail), 'the install-mode row names the resolved mode');
  // Every check still has the four-field shape the frontends iterate over.
  for (const c of checks) {
    ok(typeof c.id === 'string' && typeof c.label === 'string' &&
       typeof c.status === 'string' && typeof c.detail === 'string',
      `System Check row "${c.id}" keeps the {id,label,status,detail} shape both frontends render`);
  }
}
{
  const serverSrc = read('src/server.js');
  ok(/describeInstall\(\)/.test(serverSrc), 'GET /api/version surfaces the install mode');
  // Additive only: the three fields every existing consumer reads must survive.
  ok(/version, onDiskVersion, restartRequired/.test(serverSrc),
    'GET /api/version still returns version / onDiskVersion / restartRequired unchanged');
}

// Anti-vacuity: prove the handlers under test are the real ones, not stubs the
// suite could satisfy trivially.
ok(typeof configRoute.updateHandler === 'function' && configRoute.updateHandler.length === 2,   // (req, res) — `deps = null` is defaulted and does not count
  'updateHandler is the real exported handler with the (req, res, deps) signature');
ok(typeof configRoute.updateCheckHandler === 'function' && configRoute.updateCheckHandler.length === 2,   // (req, res) — `deps = null` is defaulted and does not count
  'updateCheckHandler is the real exported handler with the (req, res, deps) signature');
// Production must never inject: the seam defaults to null.
{
  const src = stripCommentsAndStrings(read('src/routes/config.js'));
  ok(/updateHandler\s*\(\s*req\s*,\s*res\s*\)/.test(src),
    'the production route registration passes NO deps — the seam is null in production');
  ok(/updateCheckHandler\s*\(\s*req\s*,\s*res\s*\)/.test(src),
    'the production update-check registration passes NO deps either');
}

/* ── NOT ENFORCED ────────────────────────────────────────────────────────────
 *
 * Stated so nobody reads a green run as more than it is:
 *
 *  1. THE BUNDLE ARM IS NEVER EXERCISED END TO END. §5 drives the handlers
 *     with an injected `caps`; §3 proves the mode flips on a real path shape.
 *     Nothing here runs a genuine packaged app, because none exists.
 *  2. THE FOUR BOOLEANS ARE NOT INDEPENDENTLY MEASURED. Today they are all
 *     `mode === 'repo'`. §4 enforces the part that is enforceable — that
 *     routes branch on a capability rather than the mode — not that any
 *     capability is empirically true of the machine.
 *  3. `mcpLaunchStyle` and `restartStyle` have NO BRANCH behind them. They are
 *     asserted to exist and to be surfaced; nothing asserts they are correct,
 *     because nothing consumes them yet.
 *  4. §4's scan is TEXTUAL over stripped source. A fork built by computed
 *     property access (`caps[someVar]`) is invisible to it, and a route that
 *     imports paths.js under an alias would defeat the mode-branch rule.
 *  5. §6 pins the command STRINGS and their ORDER, not their exec OPTIONS —
 *     a changed `cwd`, `env` or `timeout` passes.
 *  6. The two git-missing MESSAGES (sync.js and config.js) are separate
 *     strings. §9 asserts both carry `xcode-select --install`; nothing stops
 *     the rest of their wording drifting apart.
 *  7. NOTHING HERE MEASURES RENDERING. The System Check rows are asserted as
 *     data; whether they paint legibly is a browser question.
 */

const fpAfter = fingerprint();
eq(fpAfter, fpBefore, 'the real credential files are byte-identical after the run (sha256 + size + existence)');
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
