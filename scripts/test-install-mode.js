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
function deepEqJson(actual, expected, label) {
  eq(JSON.stringify(actual), JSON.stringify(expected), label);
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
  'folderPickerStyle',
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
// The three NAMED-STRING capabilities. Transcribed, never read back off the
// module — a fork below branches on the exact spelling of each of these, so a
// silent rename would move behaviour with nothing going red.
eq(installMode.getCapabilities('repo').mcpLaunchStyle, 'node-script', 'repo launches the MCP as a node script');
eq(installMode.getCapabilities('bundle').mcpLaunchStyle, 'launcher-script', 'bundle launches the MCP through a launcher shim');
eq(installMode.getCapabilities('repo').restartStyle, 'respawn-node', 'repo restarts by respawning node');
eq(installMode.getCapabilities('bundle').restartStyle, 'app-relaunch', 'bundle restarts by relaunching the application');
eq(installMode.getCapabilities('repo').folderPickerStyle, 'osascript', 'repo picks a folder with osascript');
eq(installMode.getCapabilities('bundle').folderPickerStyle, 'native-dialog', 'bundle picks a folder with the shell’s native dialog');

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

// ── THE SCAN SET IS WIDER THAN src/routes/, and it had to be ────────────────
//
// This scan used to enumerate route files ONLY, which was true of the tree at
// the time and became false the moment a fork landed in `src/brain/`. Two
// already had: `mcp-launcher.js` (covered, by luck of the mapping) and
// `diagnostics.js` (NOT covered by anything, and nobody knew). A scan that
// cannot see a whole directory reports "all clear" over it forever — the same
// class as `test-route-write-guards.js`'s hardcoded list, which this file's
// own header cites.
//
// Every candidate is still ENUMERATED FROM DISK. `install-mode.js` is excluded
// because it DEFINES getCapabilities; including the definer would report the
// capability table as a fork site on itself.
const brainFiles = fs.readdirSync(path.join(ROOT, 'src/brain'))
  .filter(f => f.endsWith('.js') && f !== 'install-mode.js')
  .sort();
ok(brainFiles.length >= 10, `enumerated ${brainFiles.length} brain files from disk`);
const scanTargets = [
  ...routeFiles.map(f => ({ key: `routes/${f}`, rel: path.join('src/routes', f) })),
  ...brainFiles.map(f => ({ key: `brain/${f}`, rel: path.join('src/brain', f) })),
  { key: 'server.js', rel: 'src/server.js' },
];

// A fork site = a file that reads a capability off getCapabilities().
const discovered = [];
for (const t of scanTargets) {
  const code = stripCommentsAndStrings(read(t.rel));
  if (!/getCapabilities\s*\(/.test(code)) continue;
  const caps = EXPECTED_CAPABILITY_KEYS.filter(k => new RegExp(`\\b${k}\\b`).test(code));
  discovered.push({ file: t.key, caps });
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
//
// SCOPE, stated precisely so nobody widens it into a false failure: this binds
// every ROUTE file, `src/server.js`, and every brain file DISCOVERED above as a
// fork site. It deliberately does NOT bind all of `src/brain/` — `paths.js`
// OWNS `isBundleInstall()` and `install-mode.js` is the one legitimate caller,
// so a blanket rule there would red on the two files that must branch on the
// form for the rest of the tree not to.
const MODE_BRANCH = /getInstallMode\s*\(\s*\)\s*[!=]==?\s*|isRepoInstall\s*\(|isBundleInstall\s*\(/;
const modeBranchTargets = [
  ...routeFiles.map(f => ({ key: `src/routes/${f}`, rel: path.join('src/routes', f) })),
  { key: 'src/server.js', rel: 'src/server.js' },
  ...discovered
    .filter(d => d.file.startsWith('brain/'))
    .map(d => ({ key: `src/${d.file}`, rel: `src/${d.file}` })),
];
for (const t of modeBranchTargets) {
  const code = stripCommentsAndStrings(read(t.rel));
  ok(!MODE_BRANCH.test(code),
    `${t.key} does NOT branch on the install FORM — capability only`);
}

// Anti-vacuity: prove the scanner CAN see a mode-branch when one exists.
ok(MODE_BRANCH.test('if (getInstallMode() === "bundle") {}'),
  'CONTROL: the mode-branch detector fires on a planted getInstallMode() comparison');
ok(MODE_BRANCH.test('if (isRepoInstall()) {}'),
  'CONTROL: the mode-branch detector fires on a planted isRepoInstall() call');
ok(!MODE_BRANCH.test('const caps = getCapabilities(); if (caps.canSelfUpdateViaGit) {}'),
  'CONTROL: the detector does NOT fire on correct capability-branching');

// Every DISCOVERED fork site must be behaviourally covered by a SUITE THAT
// ACTUALLY RUNS. A new fork added to a new route file, with no entry here,
// goes RED — which is the whole point of enumerating from disk rather than
// listing.
//
// This was a bare Set of filenames until a second fork site appeared
// (src/routes/mcp.js, whose launcher-style arm is owned by
// scripts/test-mcp-launcher.js). A Set could only be widened by adding a
// name, which is indistinguishable from waving the new fork through. Naming
// the OWNING SUITE instead is checkable three ways, all of which are enforced
// below: the file exists, it is registered in run-tests.js so it is not a
// suite nobody runs, and it mentions every capability key the fork reads.
// That is strictly stronger than the Set it replaces.
const BEHAVIOURALLY_COVERED = new Map([
  ['routes/config.js',       'test-install-mode.js'],   // §5, §5b of THIS file
  ['routes/mcp.js',          'test-mcp-launcher.js'],   // the launcher seam
  ['brain/mcp-launcher.js',  'test-mcp-launcher.js'],   // the shim writer
  ['brain/restart.js',       'test-install-mode.js'],   // §5c of THIS file
  ['brain/diagnostics.js',   'test-diagnostics.js'],    // the skipped git row
]);
const runnerSrc = read('scripts/run-tests.js');
for (const d of discovered) {
  const owner = BEHAVIOURALLY_COVERED.get(d.file);
  ok(!!owner,
    `${d.file} names an owning suite with behavioural both-arm coverage (add the suite, then the mapping — not just the mapping)`);
  if (!owner) continue;
  ok(fs.existsSync(path.join(ROOT, 'scripts', owner)),
    `${d.file}'s owning suite ${owner} EXISTS on disk`);
  ok(new RegExp(`'${owner.replace('.', '\\.')}'`).test(runnerSrc),
    `${d.file}'s owning suite ${owner} is REGISTERED in run-tests.js (a suite nobody runs is not coverage)`);
  const ownerSrc = fs.existsSync(path.join(ROOT, 'scripts', owner))
    ? read(path.join('scripts', owner)) : '';
  for (const k of d.caps) {
    ok(new RegExp(`\\b${k}\\b`).test(ownerSrc),
      `${owner} names ${d.file}'s forked capability "${k}"`);
  }
}
// Anti-vacuity: the mapping must not have grown a name for a file that no
// longer forks — a stale entry reads as coverage of nothing.
for (const f of BEHAVIOURALLY_COVERED.keys()) {
  ok(discovered.some(d => d.file === f),
    `CONTROL: ${f} is still a real fork site (a stale mapping entry is not coverage)`);
}

// ── EVERY CAPABILITY KEY IS ACCOUNTED FOR: branched, or DECLARED-ONLY ───────
//
// The rule this file existed without for three releases. `mcpLaunchStyle` and
// `restartStyle` each shipped with no consumer, on an argument written into
// install-mode.js — and that same docblock then claimed those were the ONLY
// two unwired keys, which was FALSE: `canRebuildAppleScriptApp` and
// `canWriteBesideCode` were unread as well and nothing said so.
//
// So a key may now be one of exactly two things, and the second requires a
// reason written down HERE, where it is checked against the tree rather than
// remembered. A key that is neither goes red.
const DECLARED_ONLY = new Map([
  ['canRebuildAppleScriptApp',
    'SUBSUMED: scripts/build-app.sh runs at exactly one site, below ' +
    'updateHandler\'s canSelfUpdateViaGit early return. A second check there ' +
    'is unreachable code, and unreachable code is not a guard.'],
  ['canWriteBesideCode',
    'SUBSUMED: mcp-launcher.js writes the shim into the user-data dir ' +
    'precisely so nothing ever writes beside the code. It is the statement of ' +
    'an invariant, not a switch — branching on it would imply the opposite.'],
]);
const branchedKeys = new Set(discovered.flatMap(d => d.caps));
for (const k of EXPECTED_CAPABILITY_KEYS) {
  const branched = branchedKeys.has(k);
  const declared = DECLARED_ONLY.get(k);
  ok(branched || (typeof declared === 'string' && declared.length > 40),
    `capability "${k}" is either BRANCHED by a discovered fork site, or recorded DECLARED-ONLY with a reason`);
}
// And the other direction, which is the half that rots: a key listed as
// declared-only that has since GROWN a branch is a stale excuse, and leaving
// it there is how the next auditor concludes the branch does not exist.
for (const k of DECLARED_ONLY.keys()) {
  ok(EXPECTED_CAPABILITY_KEYS.includes(k), `CONTROL: declared-only key "${k}" is still a real capability key`);
  ok(!branchedKeys.has(k), `CONTROL: "${k}" is still unbranched — a declared-only entry for a branched key is a stale excuse`);
}
// The scan must be able to SEE a branch, or the accounting above passes by
// finding nothing anywhere.
ok(branchedKeys.size >= 4,
  `CONTROL: the scan found ${branchedKeys.size} branched capabilities (a scanner that matches nothing reports every key declared-only)`);
ok(branchedKeys.has('folderPickerStyle') && branchedKeys.has('restartStyle') && branchedKeys.has('mcpLaunchStyle'),
  'CONTROL: the three named-string capabilities are all discovered as branched, from disk');

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
section('§5b  pick-folder — both arms, and the repo arm proven UNCHANGED');
// ═══════════════════════════════════════════════════════════════════════════
//
// ── WHY A `git diff -w` PROOF IS NOT ENOUGH HERE ────────────────────────────
//
// Inserting a branch ABOVE a body shows in a diff as a pure insertion, and a
// pure insertion looks reassuring. It says nothing about whether the surviving
// arm is still REACHED with the same inputs — which is the only claim that
// matters when the change is "add a branch". So the repo arm is proven three
// ways, and the third is the one that cannot be faked:
//
//   §5b-a  TEXT      the osascript command transcribed HERE as a literal and
//                    asserted byte-identical in HEAD and the working tree.
//   §5b-b  BEHAVIOUR the handler extracted from BOTH revisions, compiled with
//                    the same fake collaborators, and run over an input matrix
//                    — WITH THE CONTROL that the two must DISAGREE when the
//                    capability is stubbed to bundle mode. Without that
//                    control, "they agree" is satisfied by a branch that does
//                    nothing, and the proof is vacuous.
//   §5b-c  LIVE      the real exported handler, driven with an injected exec.
//
// This is the method `scripts/test-mcp-launcher.js` §2 established.

const headConfigSrc = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:src/routes/config.js'], { encoding: 'utf8' });
const workConfigSrc = read('src/routes/config.js');

// ── §5b-a TEXT ──────────────────────────────────────────────────────────────
const OSASCRIPT_COMMAND =
  `      \`osascript -e 'POSIX path of (choose folder with prompt "Select your Knowledge Base folder:")'\`,`;
ok(headConfigSrc.includes(OSASCRIPT_COMMAND), '§5b-a HEAD contains the transcribed osascript command line');
ok(workConfigSrc.includes(OSASCRIPT_COMMAND), '§5b-a the working tree contains it too, BYTE-IDENTICALLY');
eq((workConfigSrc.match(/osascript -e 'POSIX path of/g) || []).length, 1,
  '§5b-a exactly ONE osascript folder-picker command survives (a second copy is drift)');
ok(!OSASCRIPT_COMMAND.includes('${'),
  '§5b-a CONTROL: the pinned command is a fixed literal, not built by interpolation from a variable');

// ── §5b-b BEHAVIOUR ─────────────────────────────────────────────────────────
// HEAD has the handler as an inline arrow inside router.post(); the working
// tree has it as an exported function. Both are extracted by brace-matching
// from their own revision and wrapped into the same callable shape, so the
// comparison is of BEHAVIOUR and not of text.
function braceSlice(src, fromIdx) {
  let i = src.indexOf('{', fromIdx);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(fromIdx, i + 1); }
  }
  return null;
}
function extractHeadPickFolder(src) {
  const at = src.indexOf("router.post('/pick-folder'");
  if (at === -1) return null;
  const arrow = src.indexOf('async (_req, res) => {', at);
  if (arrow === -1) return null;
  const body = braceSlice(src, arrow);
  if (!body) return null;
  return 'async function pickFolderHandler(_req, res, deps) ' + body.slice(body.indexOf('{'));
}
function extractExportedAsyncFn(src, name) {
  const at = src.indexOf(`export async function ${name}(`);
  if (at === -1) return null;
  const whole = braceSlice(src, at);
  return whole ? whole.replace(/^export /, '') : null;
}
const headPick = extractHeadPickFolder(headConfigSrc);
const workPick = extractExportedAsyncFn(workConfigSrc, 'pickFolderHandler');
ok(!!headPick && !!workPick, '§5b-b extracted the pick-folder handler from BOTH revisions');
ok(/^async function pickFolderHandler/.test(headPick || '') && /^async function pickFolderHandler/.test(workPick || ''),
  '§5b-b both extractions are callable function sources (a desynced matcher would not be)');

// One compiler for both revisions. Every collaborator is supplied by name, so
// the HEAD version (which reads them from module scope) and the working-tree
// version (which reads them through `deps ||` defaults) close over the same
// fakes. `Object` comes from the realm; nothing here touches a real file.
function compilePick(fnSrc, capsFor, hookFor, io) {
  // eslint-disable-next-line no-new-func
  const make = new Function(
    'execAsync', 'defaultExec', 'SUBPROCESS_ENV', 'existsSync', 'hasActiveWrites',
    'conflictResponse', 'setDomainsDir', 'getCapabilities', 'capabilityRefusal', 'getDesktopHook',
    `${fnSrc}; return pickFolderHandler;`
  );
  return make(
    io.exec, io.exec, { PATH: '/usr/bin' }, io.existsSync, io.hasActiveWrites,
    (action) => ({ status: 409, body: { error: `busy: ${action}`, refused: 'write_in_progress' } }),
    io.setDomainsDir,
    () => capsFor,
    installMode.capabilityRefusal,
    () => hookFor,
  );
}
// The input matrix. Each entry drives the SAME scenario through both revisions.
const PICK_INPUTS = [
  { name: 'a real folder is chosen', exec: { stdout: '/Users/x/Knowledge\n' }, exists: true, busy: false },
  { name: 'a folder with spaces', exec: { stdout: '/Users/x/My Drive/Knowledge\n' }, exists: true, busy: false },
  { name: 'a non-ascii path', exec: { stdout: '/Users/x/ünïcode/Knowledge\n' }, exists: true, busy: false },
  { name: 'the chosen folder does not exist', exec: { stdout: '/gone\n' }, exists: false, busy: false },
  { name: 'a write started while the dialog was open', exec: { stdout: '/Users/x/K\n' }, exists: true, busy: true },
  { name: 'empty stdout (cancel)', exec: { stdout: '\n' }, exists: true, busy: false },
  { name: 'AppleScript -128 (real cancel)', throw: { stderr: 'execution error: User cancelled. (-128)', code: 1 }, exists: true, busy: false },
  { name: 'killed by the timeout', throw: { killed: true, message: 'timed out' }, exists: true, busy: false },
  { name: 'exit 1 with empty stderr', throw: { code: 1, stderr: '', message: 'Command failed' }, exists: true, busy: false },
  { name: 'exit 1 with a TCC refusal on stderr', throw: { code: 1, stderr: 'Not authorized to send Apple events', message: 'Command failed' }, exists: true, busy: false },
  { name: 'a generic spawn failure', throw: { message: 'spawn ENOENT' }, exists: true, busy: false },
  { name: 'setDomainsDir itself throws', exec: { stdout: '/Users/x/K\n' }, exists: true, busy: false, setThrows: true },
];
async function runPick(fnSrc, capsFor, hookFor, input) {
  const calls = { exec: [], setDomainsDir: [], hook: 0 };
  const io = {
    exec: async (cmd) => {
      calls.exec.push(cmd);
      if (input.throw) { const e = new Error(input.throw.message || 'x'); Object.assign(e, input.throw); throw e; }
      return input.exec;
    },
    existsSync: () => input.exists,
    hasActiveWrites: () => input.busy,
    setDomainsDir: (p) => { calls.setDomainsDir.push(p); if (input.setThrows) throw new Error('read-only volume'); },
  };
  const hook = typeof hookFor === 'function'
    ? async (...a) => { calls.hook++; return hookFor(...a); }
    : hookFor;
  const fn = compilePick(fnSrc, capsFor, hook, io);
  const res = fakeRes();
  let threw = null;
  try { await fn({}, res, null); } catch (e) { threw = e.message; }
  return { status: res.statusCode, body: res.body, calls, threw };
}
const REPO_CAPS_FOR_PICK = installMode.getCapabilities('repo');
const BUNDLE_CAPS_FOR_PICK = installMode.getCapabilities('bundle');

let pickAllSame = true;
const pickMismatches = [];
for (const input of PICK_INPUTS) {
  const a = await runPick(headPick, REPO_CAPS_FOR_PICK, null, input);
  const b = await runPick(workPick, REPO_CAPS_FOR_PICK, null, input);
  if (JSON.stringify(a) !== JSON.stringify(b)) { pickAllSame = false; pickMismatches.push(input.name); }
}
ok(pickAllSame,
  `§5b-b HEAD and HEAD+change agree on ALL ${PICK_INPUTS.length} inputs in repo mode` +
  (pickAllSame ? '' : ` — differed on: ${pickMismatches.join('; ')}`));

// THE CONTROL. Agreement in both modes would mean the branch does nothing, and
// the agreement above would prove nothing at all.
let pickDiffers = 0;
for (const input of PICK_INPUTS) {
  const a = await runPick(headPick, REPO_CAPS_FOR_PICK, null, input);
  const b = await runPick(workPick, BUNDLE_CAPS_FOR_PICK, null, input);
  if (JSON.stringify(a) !== JSON.stringify(b)) pickDiffers++;
}
eq(pickDiffers, PICK_INPUTS.length,
  '§5b-b CONTROL: with folderPickerStyle stubbed to native-dialog the two DISAGREE on EVERY input (so the agreement above is not vacuous)');

// ── The BUNDLE arm's own behaviour ──────────────────────────────────────────
{
  const r = await runPick(workPick, BUNDLE_CAPS_FOR_PICK, null,
    { name: 'no shell attached', exec: { stdout: '/x\n' }, exists: true, busy: false });
  eq(r.status, 501, '§5b bundle arm with NO hook registered answers 501');
  eq(r.body.capability, 'folderPickerStyle', 'and names the capability');
  eq(r.body.refused, 'capability_unavailable', 'and carries the machine-readable refusal code');
  eq(r.calls.exec.length, 0, 'and runs ZERO subprocesses — it never falls back to osascript');
  eq(r.calls.setDomainsDir.length, 0, 'and changes nothing');
  ok(/type or paste/i.test(r.body.hint || ''), 'and its hint names the typed-path route that needs no dialog');
}
{
  const r = await runPick(workPick, BUNDLE_CAPS_FOR_PICK, async () => '/Users/x/Knowledge',
    { name: 'hook returns a path', exec: { stdout: 'IGNORED\n' }, exists: true, busy: false });
  eq(r.status, 200, '§5b bundle arm WITH a hook succeeds');
  eq(r.body.ok, true, 'and reports ok');
  eq(r.body.path, '/Users/x/Knowledge', 'and returns the hook’s path');
  eq(r.calls.setDomainsDir[0], '/Users/x/Knowledge', 'and applies exactly that path');
  eq(r.calls.exec.length, 0, 'and STILL runs no subprocess — osascript is unreachable on this arm');
  eq(r.calls.hook, 1, 'and called the hook exactly once');
}
{
  const r = await runPick(workPick, BUNDLE_CAPS_FOR_PICK, async () => null,
    { name: 'hook cancels', exec: { stdout: '' }, exists: true, busy: false });
  eq(r.body.cancelled, true, '§5b a hook returning null is a CANCEL, not an error');
  eq(r.status, 200, 'and answers 200');
}
{
  // The post-pick rules are SHARED. If the bundle arm had its own copy this is
  // where it would drift — a native dialog can return a path that was deleted
  // between choosing and confirming, and it must be refused identically.
  const r = await runPick(workPick, BUNDLE_CAPS_FOR_PICK, async () => '/gone',
    { name: 'hook path missing', exec: { stdout: '' }, exists: false, busy: false });
  eq(r.status, 400, '§5b the bundle arm applies the SAME existence check');
  ok(/Folder does not exist/.test(r.body.error || ''), 'with the same message');
}
{
  const r = await runPick(workPick, BUNDLE_CAPS_FOR_PICK, async () => '/Users/x/K',
    { name: 'hook path but busy', exec: { stdout: '' }, exists: true, busy: true });
  eq(r.status, 409, '§5b the bundle arm applies the SAME concurrency re-check');
  eq(r.calls.setDomainsDir.length, 0, 'and does not mutate while a write is in flight');
  ok(r.body.cancelled === undefined,
    'and the refusal carries NO `cancelled` field (the frontend reads that BEFORE res.ok)');
}
{
  const boom = async () => { throw new Error('dialog exploded'); };
  const r = await runPick(workPick, BUNDLE_CAPS_FOR_PICK, boom,
    { name: 'hook throws', exec: { stdout: '' }, exists: true, busy: false });
  eq(r.status, 500, '§5b a throwing hook is a 500, never a silent cancel');
  ok(r.body.cancelled === undefined,
    'and is NOT reported as a cancellation — the exact mis-classification the osascript arm was fixed for');
  ok(!/osascript|Apple event|-128/i.test(JSON.stringify(r.body)),
    'and borrows none of the osascript classifier’s vocabulary');
}

// ── §5b-c LIVE ──────────────────────────────────────────────────────────────
// The REAL exported handler, on the real repo capabilities of this checkout.
{
  const rec = recordingExec({});
  const res = fakeRes();
  await configRoute.pickFolderHandler({}, res, {
    execAsync: async (cmd) => { rec.calls.push(cmd); return { stdout: '\n' }; },
    setDomainsDir: () => { throw new Error('the live probe must never mutate the domains dir'); },
  });
  eq(res.body.cancelled, true, '§5b-c live: the real handler treats empty output as a cancel');
  eq(rec.calls.length, 1, '§5b-c live: exactly one subprocess command was issued');
  ok(rec.calls[0].startsWith('osascript -e '),
    '§5b-c live: and it is the osascript command (this checkout is repo mode)');
}
ok(typeof configRoute.pickFolderHandler === 'function' && configRoute.pickFolderHandler.length === 2,
  '§5b-c pickFolderHandler is the real exported handler with the (req, res, deps) signature');
{
  const src = stripCommentsAndStrings(workConfigSrc);
  ok(/pickFolderHandler\s*\(\s*req\s*,\s*res\s*\)/.test(src),
    '§5b-c the production registration passes NO deps — the seam is null in production');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5c  POST /api/restart — both arms, and the repo arm proven UNCHANGED');
// ═══════════════════════════════════════════════════════════════════════════
//
// Same three-proof method as §5b. The restart handler lives in `src/server.js`,
// which CANNOT be imported here — it calls startListen() at module scope, so
// importing it would bind a port from inside `npm test`. It is therefore
// extracted from both revisions by brace-matching and executed in a sandbox,
// which is the only honest way to reach it.

const restartModule = await import(path.join(ROOT, 'src/brain/restart.js'));
const desktopHost = await import(path.join(ROOT, 'src/brain/desktop-host.js'));

const headServerSrc = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:src/server.js'], { encoding: 'utf8' });
const workServerSrc = read('src/server.js');

// ── §5c-a TEXT: the repo arm's spawn, pinned as a literal ───────────────────
const RESPAWN_BLOCK = [
  '    const child = spawn(',
  '      process.execPath,',
  "      [path.join(PROJECT_ROOT, 'src/server.js')],",
].join('\n');
ok(headServerSrc.includes(RESPAWN_BLOCK), '§5c-a HEAD contains the transcribed respawn block');
ok(workServerSrc.includes(RESPAWN_BLOCK), '§5c-a the working tree contains it too, BYTE-IDENTICALLY');
eq((workServerSrc.match(/const child = spawn\(/g) || []).length, 1,
  '§5c-a exactly ONE respawn survives');
ok(RESPAWN_BLOCK !== RESPAWN_BLOCK.replace('execPath', 'execpath'),
  '§5c-a CONTROL: flipping one character in the transcribed block changes it');

// ── §5c-b BEHAVIOUR ─────────────────────────────────────────────────────────
function extractRestartHandler(src) {
  const at = src.indexOf("app.post('/api/restart'");
  if (at === -1) return null;
  const arrow = src.indexOf('(_req, res) => {', at);
  if (arrow === -1) return null;
  const body = braceSlice(src, arrow);
  if (!body) return null;
  return 'function restartRoute(_req, res) ' + body.slice(body.indexOf('{'));
}
const headRestart = extractRestartHandler(headServerSrc);
const workRestart = extractRestartHandler(workServerSrc);
ok(!!headRestart && !!workRestart, '§5c-b extracted the /api/restart handler from BOTH revisions');

function runRestart(fnSrc, { busy, plan }) {
  const calls = { spawn: [], exit: [], close: 0, closeAll: 0, log: [], perform: 0 };
  // eslint-disable-next-line no-new-func
  const make = new Function(
    'hasActiveWrites', 'conflictResponse', 'logInfo', 'logWarn', 'logError',
    'spawn', 'path', 'PROJECT_ROOT', 'process', 'server', 'setTimeout', 'planRestart',
    `${fnSrc}; return restartRoute;`
  );
  const fn = make(
    () => busy,
    (action) => ({ status: 409, body: { error: `busy: ${action}`, refused: 'write_in_progress' } }),
    (s, m) => calls.log.push(['info', s, m]),
    (s, m) => calls.log.push(['warn', s, m]),
    (s, m) => calls.log.push(['error', s, m]),
    (bin, args, opts) => { calls.spawn.push({ bin, args, opts }); return { unref() {} }; },
    { join: (...p) => p.join('/') },
    '/APP',
    { execPath: '/opt/node', env: {}, exit: (c) => calls.exit.push(c) },
    { closeAllConnections: () => { calls.closeAll++; }, close: () => { calls.close++; } },
    (cb) => { cb(); return 0; },              // run every scheduled step synchronously
    () => { if (plan && plan.perform) return { ...plan, perform: () => { calls.perform++; plan.perform(); } }; return plan; },
  );
  const res = fakeRes();
  let threw = null;
  try { fn({}, res); } catch (e) { threw = e.message; }
  return { status: res.statusCode, body: res.body, calls, threw };
}
const REPO_PLAN = restartModule.planRestart(installMode.getCapabilities('repo'), null);
const BUNDLE_PLAN_NO_HOOK = restartModule.planRestart(installMode.getCapabilities('bundle'), null);
const RESTART_INPUTS = [
  { name: 'idle', busy: false },
  { name: 'a write is in flight', busy: true },
];
let restartAllSame = true;
for (const input of RESTART_INPUTS) {
  const a = runRestart(headRestart, { busy: input.busy, plan: REPO_PLAN });
  const b = runRestart(workRestart, { busy: input.busy, plan: REPO_PLAN });
  if (JSON.stringify(a) !== JSON.stringify(b)) restartAllSame = false;
}
ok(restartAllSame,
  `§5c-b HEAD and HEAD+change agree on ALL ${RESTART_INPUTS.length} inputs with restartStyle at 'respawn-node'`);
// THE CONTROL — again, agreement in both modes would prove nothing.
let restartDiffers = 0;
for (const input of RESTART_INPUTS) {
  const a = runRestart(headRestart, { busy: input.busy, plan: REPO_PLAN });
  const b = runRestart(workRestart, { busy: input.busy, plan: BUNDLE_PLAN_NO_HOOK });
  if (JSON.stringify(a) !== JSON.stringify(b)) restartDiffers++;
}
eq(restartDiffers, 1,
  '§5c-b CONTROL: with restartStyle stubbed to app-relaunch the two DISAGREE on the idle input (and correctly AGREE on the busy one — the write-registry refusal is checked FIRST and is unchanged)');
{
  const a = runRestart(headRestart, { busy: true, plan: REPO_PLAN });
  const b = runRestart(workRestart, { busy: true, plan: BUNDLE_PLAN_NO_HOOK });
  eq(JSON.stringify(a), JSON.stringify(b),
    '§5c-b and that agreement is asserted directly: an ingest still refuses a restart identically in BOTH modes');
}
{
  const r = runRestart(workRestart, { busy: false, plan: REPO_PLAN });
  deepEqJson(r.body, { ok: true, restarting: true }, '§5c the repo arm’s response body is unchanged');
  eq(r.calls.spawn.length, 1, 'and it spawns exactly one replacement');
  eq(r.calls.spawn[0].bin, '/opt/node', 'using process.execPath');
  eq(r.calls.spawn[0].args[0], '/APP/src/server.js', 'with the server entry as its argument');
  eq(r.calls.exit[0], 0, 'and exits 0');
}
{
  let relaunched = 0;
  const plan = restartModule.planRestart(installMode.getCapabilities('bundle'), () => { relaunched++; });
  const r = runRestart(workRestart, { busy: false, plan });
  eq(r.status, 200, '§5c the bundle arm with a relaunch hook is a SUCCESS, not a refusal');
  eq(r.body.restarting, true, 'and still reports restarting:true, the field every client reads');
  eq(r.body.restartStyle, 'app-relaunch', 'plus restartStyle, so a non-browser caller can tell the app is going away');
  eq(r.calls.perform, 1, 'and it calls the shell’s relaunch exactly once');
  eq(relaunched, 1, 'which really ran');
  eq(r.calls.spawn.length, 0, 'and it NEVER spawns — the second-window bug is unreachable on this arm');
  eq(r.calls.exit.length, 0, 'and does not exit the process itself; the shell owns that');
}
{
  const r = runRestart(workRestart, { busy: false, plan: BUNDLE_PLAN_NO_HOOK });
  eq(r.status, 501, '§5c the bundle arm with NO hook answers 501');
  eq(r.body.capability, 'restartStyle', 'and names the capability');
  eq(r.calls.spawn.length, 0, 'and does NOT fall back to the spawn (that is the bug, silently)');
  eq(r.calls.exit.length, 0, 'and leaves the process running');
  ok(/Quit The Curator/i.test(r.body.hint || ''), 'and tells the user what to do instead');
}
{
  const plan = restartModule.planRestart(installMode.getCapabilities('bundle'),
    () => { throw new Error('relaunch failed'); });
  const r = runRestart(workRestart, { busy: false, plan });
  eq(r.threw, null, '§5c a THROWING relaunch hook does not take the request down');
  eq(r.calls.spawn.length, 0, 'and still does not fall through to the spawn');
  ok(r.calls.log.some(l => l[0] === 'error'), 'and the failure is logged');
}

// planRestart itself, directly.
{
  const p = restartModule.planRestart(installMode.getCapabilities('repo'), () => {});
  eq(p.style, 'respawn-node', '§5c planRestart: repo mode is respawn-node even when a hook exists');
  eq(p.perform, null, 'and hands back no perform');
  deepEqJson(p.body, { ok: true, restarting: true }, 'and the byte-identical legacy body');
}
{
  const p = restartModule.planRestart(installMode.getCapabilities('bundle'), 'not-a-function');
  eq(p.ok, false, '§5c planRestart: a non-function hook is refused, not called');
  eq(p.status, 501, 'with 501');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5d  desktop-host — the registry both bundle arms resolve through');
// ═══════════════════════════════════════════════════════════════════════════
{
  desktopHost.__resetDesktopHost();
  eq(desktopHost.getDesktopHook('pickFolder'), null, 'nothing is registered by default');
  eq(desktopHost.getDesktopHook('relaunch'), null, 'neither hook');
  eq(desktopHost.describeDesktopHost().attached, false, 'and describeDesktopHost reports NOT attached');
  // This is the state every repo install is in, forever, which is why the
  // whole bundle half of this release is a provable no-op here.
  eq(installMode.getInstallMode(), 'repo', 'CONTROL: this checkout is repo mode, so no bundle arm is reachable in production');

  const r = desktopHost.registerDesktopHost({ relaunch: () => {} });
  deepEqJson(r.registered, ['relaunch'], 'registration is PARTIAL — a shell installs only what it has');
  ok(typeof desktopHost.getDesktopHook('relaunch') === 'function', 'the registered hook comes back');
  eq(desktopHost.getDesktopHook('pickFolder'), null, 'and the unregistered one is still null, not undefined');
  eq(desktopHost.describeDesktopHost().hooks.relaunch, true, 'describeDesktopHost reports booleans...');
  eq(desktopHost.describeDesktopHost().hooks.pickFolder, false, '...for both hooks');
  ok(!Object.values(desktopHost.describeDesktopHost().hooks).some(v => typeof v === 'function'),
    'and NEVER leaks the functions themselves onto the wire');

  let threw = null;
  try { desktopHost.registerDesktopHost({ pickfolder: () => {} }); } catch (e) { threw = e; }
  ok(threw instanceof Error && /unknown hook/i.test(threw.message),
    'a TYPO is refused loudly — silently registering nothing would leave the route refusing forever');
  threw = null;
  try { desktopHost.registerDesktopHost({ pickFolder: 'nope' }); } catch (e) { threw = e; }
  ok(threw instanceof Error && /must be a function/i.test(threw.message), 'a non-function is refused too');
  threw = null;
  try { desktopHost.registerDesktopHost(null); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'and so is a non-object');

  eq(desktopHost.getDesktopHook('__proto__'), null, 'an unknown name never reaches Object.prototype');
  eq(desktopHost.getDesktopHook('constructor'), null, 'nor Function.prototype');

  desktopHost.__resetDesktopHost();
  eq(desktopHost.getDesktopHook('relaunch'), null, 'the reset seam really clears');
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
 *  1. NO BUNDLE ARM RUNS END TO END, AND NONE CAN. §5/§5b/§5c drive the
 *     handlers with an injected `caps`; §3 proves the mode flips on a real
 *     path shape. Nothing here runs a genuine packaged app, BECAUSE NO
 *     PACKAGED APP EXISTS — `scripts/build-app.sh` still builds an AppleScript
 *     wrapper around the checkout, and `desktop/` has never been run. Every
 *     bundle assertion in this file is therefore a statement about a code path
 *     no user can reach today. That is the point (the release is a provable
 *     no-op), and it is also the ceiling on what a green run means.
 *  2. NEITHER DESKTOP HOOK HAS EVER BEEN CALLED BY A REAL SHELL. §5b and §5c
 *     prove the ROUTE half — what happens when a hook is present, absent, or
 *     throwing. Nothing proves that Electron's `dialog.showOpenDialog` or
 *     `app.relaunch()` behaves as the hook contract in `desktop-host.js`
 *     describes, and nothing proves a shell can reach this module's registry
 *     at all: that rests on `desktop/main.js` importing `src/server.js` into
 *     the Electron main process, which is READ from that file rather than
 *     observed. If that ever becomes a child process, every hook reads null
 *     and both arms refuse — the fail-safe direction, but a real regression
 *     that this suite would report as passing.
 *  3. THE FOUR BOOLEANS ARE NOT INDEPENDENTLY MEASURED. Today all seven
 *     capabilities are `mode === 'repo'`. §4 enforces the part that is
 *     enforceable — that a fork branches on a capability rather than the mode,
 *     and that every key is either branched or recorded declared-only WITH a
 *     reason — not that any capability is empirically true of the machine.
 *  4. §4's scan is TEXTUAL over stripped source. A fork built by computed
 *     property access (`caps[someVar]`) is invisible to it, and a file that
 *     imports paths.js under an alias would defeat the mode-branch rule. Its
 *     scan set is `src/routes/*.js` + `src/brain/*.js` + `src/server.js`, all
 *     from disk — a fork placed anywhere else (`mcp/`, `scripts/`) is unseen.
 *  4a. THE EQUIVALENCE PROOFS COMPARE AGAINST `HEAD`, so once this change is
 *     committed they compare the working tree to itself and the "they agree"
 *     halves become trivially true. What survives that is the part built to:
 *     the transcribed literals in §5b-a/§5c-a, which fail if the surviving arm
 *     is ever edited, and the DISAGREEMENT controls, which fail if the branch
 *     stops doing anything. Read a green §5b-b/§5c-b on a later commit as
 *     "the arms still differ", not as "the arm is unchanged since v3.30.0".
 *  4b. THE RESTART HANDLER IS EXECUTED IN A SANDBOX, NOT IMPORTED.
 *     `src/server.js` binds a port at module scope, so importing it inside
 *     `npm test` is not an option. The sandbox supplies `setTimeout` as a
 *     synchronous call, so the REAL flush delay, the real detach and the real
 *     500 ms exit grace are not exercised — only the order of the decisions.
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
