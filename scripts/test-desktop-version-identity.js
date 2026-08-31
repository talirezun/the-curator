#!/usr/bin/env node
/**
 * test-desktop-version-identity.js — OFFLINE suite for the ONE thing the
 * packaged Mac app reports about itself: its version.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * The first shipped DMG's About panel read `0.0.0 (0.0.0)`. Not a display bug:
 * `/Applications/The Curator.app/Contents/Info.plist` genuinely carried
 * CFBundleShortVersionString=0.0.0 and CFBundleVersion=0.0.0, because
 * electron-builder derives both from the app manifest's `version` and
 * `desktop/package.json` is pinned at 0.0.0. The DMGs were then RENAMED BY
 * HAND at upload time, so the filename said 3.30.0 and the app inside said
 * 0.0.0. Nothing noticed, because nothing was looking.
 *
 * ── A claim this suite CORRECTS rather than encodes ─────────────────────────
 *
 * v3.30.0's changelog row says the pin exists "so the DMG version can only
 * come from the git tag". `.github/workflows/desktop-dmg.yml` really does pass
 * `--config.extraMetadata.version` from the tag — that part is true and that
 * path was never broken. What was false is "can only": `npm run dist` was
 * `electron-builder --mac --config electron-builder.yml`, with no version
 * anywhere, and that is the command that built the DMGs that shipped.
 *
 * ── What this suite EXECUTES, and what it merely reads ──────────────────────
 *
 * `desktop/lib/app-version.js` and `desktop/lib/verify-version.mjs` import
 * nothing from Electron and nothing from `src/`, exactly so this suite can run
 * them for real. §5 fabricates real `.app` bundles on disk, with real
 * `Info.plist` files, and drives the REAL electron-builder hook against them.
 * §4 spawns the real `dist` wrapper. §7 drives the real About-panel installer
 * against a stub `app`.
 *
 * `desktop/main.js` cannot be imported (Electron is not an offline dependency),
 * so its single call site is source-scanned and §8 says so out loud.
 *
 * ── Sections ────────────────────────────────────────────────────────────────
 *
 *   §1  the two manifests — one real version, one permanent sentinel
 *   §2  distArgv() — EXECUTED, including both refusals
 *   §3  parseInfoPlistVersions() / checkBundleVersions() — EXECUTED
 *   §4  the `dist` script really injects — the wrapper is SPAWNED
 *   §5  the build-time refusal — the REAL afterPack hook, real bundles on disk
 *   §6  electron-builder.yml still wires that hook up
 *   §7  applyAboutPanel() — EXECUTED against a stub app
 *   §8  main.js call site (source scan, weak by nature)
 *   §9  the ad-hoc signing OFF-SWITCH — EXECUTED, every branch
 *   §10 signature parsing + refusal — EXECUTED against REAL codesign output
 *   §11 the afterPack hook runs BOTH checks — EXECUTED
 *   §12 a real codesign round trip — macOS only, SKIPPED and said so elsewhere
 *   §13 NOT ENFORCED
 *
 * ── Why signing lives in a file called "version identity" ───────────────────
 *
 * Both halves are the same question — what does the packaged artifact claim
 * about itself, and is the claim true — and "signing identity" is literally
 * the second half's name. Keeping one file also keeps one registration in
 * scripts/run-tests.js and one suite count in CONTRIBUTING.md.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  UNSET_VERSION, VERSION_FLAG, PRINT_ARGS_FLAG,
  readManifestVersion, repoRootFrom, distArgv,
  parseInfoPlistVersions, checkBundleVersions, formatVersionLabel,
  aboutPanelOptions, applyAboutPanel,
} from '../desktop/lib/app-version.js';
import {
  REAL_SIGNING_ENV, shouldAdhocSign, parseSignatureInfo, assertAdhocOnly, adhocSign, assertLoadable,
} from '../desktop/lib/adhoc-sign.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const EB_YML = path.join(DESKTOP, 'electron-builder.yml');
const MAIN_JS = path.join(DESKTOP, 'main.js');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(t) { console.log(`\n${t}`); }
function read(p) { return readFileSync(p, 'utf8'); }

/** Run `fn`; report whether it threw, and hand the message back for inspection. */
function threw(fn) {
  try { fn(); return { threw: false, message: null }; }
  catch (err) { return { threw: true, message: err && err.message ? err.message : String(err) }; }
}

/** Strip `#` comments from YAML so no rule can be satisfied by a comment. */
function stripYamlComments(src) {
  return src.split('\n').map((line) => {
    let out = '', qs = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (qs) { out += c; if (c === qs) qs = null; continue; }
      if (c === '"' || c === "'") { qs = c; out += c; continue; }
      if (c === '#') break;
      out += c;
    }
    return out.trimEnd();
  }).join('\n');
}

const SCRATCH = path.join(tmpdir(), `curator-version-identity-${process.pid}`);

/**
 * Write a minimal but REAL `.app` on disk: `<dir>/<name>.app/Contents/Info.plist`,
 * XML, in the shape electron-builder's plist serialiser emits.
 */
function fabricateBundle(outDir, name, { short, bundle, raw } = {}) {
  const contents = path.join(outDir, `${name}.app`, 'Contents');
  mkdirSync(contents, { recursive: true });
  const body = raw !== undefined ? raw : [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '    <key>CFBundleName</key>',
    '    <string>The Curator</string>',
    ...(short === null ? [] : ['    <key>CFBundleShortVersionString</key>', `    <string>${short}</string>`]),
    ...(bundle === null ? [] : ['    <key>CFBundleVersion</key>', `    <string>${bundle}</string>`]),
    '</dict>',
    '</plist>',
  ].join('\n');
  writeFileSync(path.join(contents, 'Info.plist'), body);
  return path.join(contents, 'Info.plist');
}

console.log('\n════════ DESKTOP VERSION IDENTITY ════════');

// ─────────────────────────────────────────────────────────────────────────────
section('§1  The two manifests — one real version, one permanent sentinel');
// ─────────────────────────────────────────────────────────────────────────────

const rootVersion = readManifestVersion(path.join(ROOT, 'package.json'));
const desktopVersion = readManifestVersion(path.join(DESKTOP, 'package.json'));

ok(typeof rootVersion === 'string' && /^\d+\.\d+\.\d+/.test(rootVersion),
   `the root package.json carries a real version (${rootVersion})`);
ok(rootVersion !== UNSET_VERSION,
   'the root version is not the sentinel — it is the source of truth');

// The desktop manifest must STAY at the sentinel. This is not laziness: two
// manifests that have to agree by hand is exactly how the shipped defect
// happened. Keeping it permanently wrong means it can never be silently right
// in a way that hides a missing injection. scripts/test-desktop-packaging.js
// §3 asserts the same literal from the other direction.
eq(desktopVersion, UNSET_VERSION,
   'desktop/package.json stays at the sentinel and is never a maintained number');

// The suite must be able to tell the two apart, or every assertion below is
// vacuous. CONTROL.
ok(rootVersion !== desktopVersion,
   'CONTROL — the two manifests genuinely hold different values');

// readManifestVersion must fail CLOSED. A default here would be the whole bug.
eq(readManifestVersion(path.join(SCRATCH, 'nope', 'package.json')), null,
   'readManifestVersion returns null for a missing manifest — never a default');
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(path.join(SCRATCH, 'broken.json'), '{ not json');
eq(readManifestVersion(path.join(SCRATCH, 'broken.json')), null,
   'readManifestVersion returns null for unparseable JSON');
writeFileSync(path.join(SCRATCH, 'noversion.json'), '{"name":"x"}');
eq(readManifestVersion(path.join(SCRATCH, 'noversion.json')), null,
   'readManifestVersion returns null when there is no version field');
writeFileSync(path.join(SCRATCH, 'numeric.json'), '{"version":3}');
eq(readManifestVersion(path.join(SCRATCH, 'numeric.json')), null,
   'readManifestVersion refuses a non-string version rather than coercing it');

eq(repoRootFrom(DESKTOP), path.resolve(ROOT),
   'repoRootFrom(desktop/) resolves to this repository root');

// ─────────────────────────────────────────────────────────────────────────────
section('§2  distArgv() — EXECUTED, including both refusals');
// ─────────────────────────────────────────────────────────────────────────────

const argv = distArgv(rootVersion);
ok(argv.includes(`${VERSION_FLAG}=${rootVersion}`),
   `distArgv injects ${VERSION_FLAG}=${rootVersion}`);
ok(argv.includes('--mac') && argv.includes('electron-builder.yml'),
   'distArgv still targets mac and the project config');

const withExtra = distArgv(rootVersion, ['--dir', '--arm64']);
eq(withExtra.slice(-2), ['--dir', '--arm64'],
   'passthrough args are appended LAST, so a caller can still add --dir/--arm64');

ok(threw(() => distArgv(UNSET_VERSION)).threw,
   'distArgv REFUSES the sentinel version rather than building 0.0.0');
ok(threw(() => distArgv('')).threw,
   'distArgv REFUSES an empty version');
ok(threw(() => distArgv(undefined)).threw,
   'distArgv REFUSES a missing version');

// ─────────────────────────────────────────────────────────────────────────────
section('§3  parseInfoPlistVersions() / checkBundleVersions() — EXECUTED');
// ─────────────────────────────────────────────────────────────────────────────

const samplePlist = read(fabricateBundle(path.join(SCRATCH, 'parse'), 'Sample',
  { short: '3.30.0', bundle: '3.30.0' }));
eq(parseInfoPlistVersions(samplePlist), { short: '3.30.0', bundle: '3.30.0' },
   'both version keys are parsed out of a real XML plist');
eq(parseInfoPlistVersions('<plist><dict></dict></plist>'), { short: null, bundle: null },
   'a plist with neither key yields nulls — never a guess');
eq(parseInfoPlistVersions(null), { short: null, bundle: null },
   'a non-string input yields nulls rather than throwing');

eq(checkBundleVersions({ expected: '3.30.0', short: '3.30.0', bundle: '3.30.0' }).ok, true,
   'a matching pair is accepted');
ok(checkBundleVersions({ expected: '3.30.0', short: UNSET_VERSION, bundle: UNSET_VERSION })
   .problems.some((p) => p.includes(UNSET_VERSION)),
   'the sentinel reaching the artifact is refused, and named as the sentinel');
ok(checkBundleVersions({ expected: '3.30.0', short: '9.9.9', bundle: '9.9.9' })
   .problems.some((p) => p.includes('9.9.9') && p.includes('3.30.0')),
   'a mismatch is refused and BOTH numbers appear in the message');
// CFBundleVersion is checked separately because the About panel shows it too —
// "0.0.0 (0.0.0)" was two wrong numbers, not one.
eq(checkBundleVersions({ expected: '3.30.0', short: '3.30.0', bundle: '9.9.9' }).ok, false,
   'a correct short version does NOT excuse a wrong CFBundleVersion');
eq(checkBundleVersions({ expected: '3.30.0', short: '3.30.0', bundle: null }).ok, false,
   'an unreadable CFBundleVersion fails CLOSED');
eq(checkBundleVersions({ expected: null, short: '3.30.0', bundle: '3.30.0' }).ok, false,
   'an unreadable root manifest fails CLOSED — never "assume it is fine"');
eq(checkBundleVersions({ expected: UNSET_VERSION, short: UNSET_VERSION, bundle: UNSET_VERSION }).ok, false,
   'agreement ON the sentinel is still a refusal (equality alone is not the test)');

// ─────────────────────────────────────────────────────────────────────────────
section('§4  The `dist` script really injects — the wrapper is SPAWNED');
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the assertion that reds when someone reverts `npm run dist` to a bare
// electron-builder call. It does not look for a string in a file: it reads the
// COMMAND the manifest names, runs it, and inspects the argv that command would
// hand to electron-builder, computed from the real root manifest.

const deskPkg = JSON.parse(read(path.join(DESKTOP, 'package.json')));
const distScript = String(deskPkg.scripts && deskPkg.scripts.dist || '');
const m = distScript.match(/^node\s+(\S+)$/);
ok(m !== null,
   `the dist script routes through a node wrapper (got: "${distScript}")`);

if (m) {
  const wrapper = path.join(DESKTOP, m[1]);
  ok(existsSync(wrapper), `the wrapper named by the dist script exists (${m[1]})`);

  const r = spawnSync(process.execPath, [wrapper, PRINT_ARGS_FLAG],
    { cwd: DESKTOP, encoding: 'utf8' });
  eq(r.status, 0, 'the dist wrapper exits 0 in print-args mode');

  let printed = null;
  try { printed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* stays null */ }
  ok(printed !== null, 'the dist wrapper prints a parseable command');

  if (printed) {
    eq(printed.version, rootVersion,
       'the wrapper takes its version from the ROOT manifest, live');
    ok(Array.isArray(printed.args) && printed.args.includes(`${VERSION_FLAG}=${rootVersion}`),
       `the command it would run carries ${VERSION_FLAG}=${rootVersion}`);
    ok(!printed.args.includes(`${VERSION_FLAG}=${UNSET_VERSION}`),
       'and it never carries the sentinel');
  }

  // Passthrough survives the real wrapper, not just distArgv().
  const r2 = spawnSync(process.execPath, [wrapper, PRINT_ARGS_FLAG, '--dir'],
    { cwd: DESKTOP, encoding: 'utf8' });
  let printed2 = null;
  try { printed2 = JSON.parse(r2.stdout.trim().split('\n').pop()); } catch { /* stays null */ }
  ok(printed2 && printed2.args.includes('--dir'),
     'extra flags reach electron-builder through the wrapper');
}

// ─────────────────────────────────────────────────────────────────────────────
section('§5  The build-time refusal — the REAL hook, real bundles on disk');
// ─────────────────────────────────────────────────────────────────────────────
//
// The hook is imported from the path electron-builder.yml names (§6 proves that
// is the same file), and driven against `.app` directories fabricated on disk
// with real Info.plist files. If the refusal is deleted, weakened, or made
// unreachable, these go red because the BUILD WOULD HAVE BEEN ALLOWED — not
// because a line vanished from a file.

const hookPath = path.join(DESKTOP, 'lib', 'verify-version.mjs');
ok(existsSync(hookPath), 'the afterPack hook module exists');

const hook = await import(`file://${hookPath}`);
ok(typeof hook.afterPack === 'function',
   'the hook exports `afterPack` — the exact named export electron-builder resolves');
ok(typeof hook.verifyPackedVersion === 'function',
   'the check itself is exported so it can be driven without a build context');

const goodDir = path.join(SCRATCH, 'good');
fabricateBundle(goodDir, 'The Curator', { short: rootVersion, bundle: rootVersion });
const goodRun = threw(() => hook.verifyPackedVersion({ appOutDir: goodDir, repoRoot: ROOT }));
ok(!goodRun.threw,
   `a bundle whose plist matches the root manifest is ACCEPTED (${rootVersion})`);

const sentinelDir = path.join(SCRATCH, 'sentinel');
fabricateBundle(sentinelDir, 'The Curator', { short: UNSET_VERSION, bundle: UNSET_VERSION });
const sentinelRun = threw(() => hook.verifyPackedVersion({ appOutDir: sentinelDir, repoRoot: ROOT }));
ok(sentinelRun.threw, 'THE SHIPPED DEFECT: a 0.0.0 bundle is REFUSED');
ok(sentinelRun.threw && /BUILD REFUSED/.test(sentinelRun.message),
   'and the refusal says BUILD REFUSED, so a build log cannot be misread');
ok(sentinelRun.threw && sentinelRun.message.includes(rootVersion),
   'and it names the version that SHOULD have been there');

const wrongDir = path.join(SCRATCH, 'wrong');
fabricateBundle(wrongDir, 'The Curator', { short: '9.9.9', bundle: '9.9.9' });
ok(threw(() => hook.verifyPackedVersion({ appOutDir: wrongDir, repoRoot: ROOT })).threw,
   'a bundle carrying ANY version other than the root manifest\'s is REFUSED');

// This is the CI case: a tag that disagrees with the committed version. It is
// caught by the same rule, which is why the hook compares against the manifest
// rather than against whatever flag was passed.
const halfDir = path.join(SCRATCH, 'half');
fabricateBundle(halfDir, 'The Curator', { short: rootVersion, bundle: '9.9.9' });
ok(threw(() => hook.verifyPackedVersion({ appOutDir: halfDir, repoRoot: ROOT })).threw,
   'a bundle with a correct short version and a wrong CFBundleVersion is REFUSED');

const emptyPlistDir = path.join(SCRATCH, 'unreadable');
fabricateBundle(emptyPlistDir, 'The Curator', { raw: 'not a plist at all' });
ok(threw(() => hook.verifyPackedVersion({ appOutDir: emptyPlistDir, repoRoot: ROOT })).threw,
   'an unreadable Info.plist is REFUSED — fail closed, never assume');

const noAppDir = path.join(SCRATCH, 'noapp');
mkdirSync(noAppDir, { recursive: true });
ok(threw(() => hook.verifyPackedVersion({ appOutDir: noAppDir, repoRoot: ROOT })).threw,
   'an output directory with no .app is REFUSED rather than silently passing');

const twoAppDir = path.join(SCRATCH, 'twoapps');
fabricateBundle(twoAppDir, 'One', { short: rootVersion, bundle: rootVersion });
fabricateBundle(twoAppDir, 'Two', { short: UNSET_VERSION, bundle: UNSET_VERSION });
ok(threw(() => hook.verifyPackedVersion({ appOutDir: twoAppDir, repoRoot: ROOT })).threw,
   'two .app bundles is REFUSED rather than checking whichever sorted first');

// The exported hook signature electron-builder actually calls.
let hookRejected = false;
try { await hook.afterPack({ appOutDir: sentinelDir }); } catch { hookRejected = true; }
ok(hookRejected,
   'afterPack({appOutDir}) — the real call signature — rejects on a bad bundle');

// ─────────────────────────────────────────────────────────────────────────────
section('§6  electron-builder.yml still wires that hook up');
// ─────────────────────────────────────────────────────────────────────────────

const yml = stripYamlComments(read(EB_YML));
ok(/runs-on|asar:\s*false/.test(yml) || yml.includes('appId:'),
   'CONTROL — a known non-comment line survives comment stripping');

const hookLine = yml.match(/^afterPack:\s*(\S+)\s*$/m);
ok(hookLine !== null,
   'electron-builder.yml declares an afterPack hook OUTSIDE a comment');
if (hookLine) {
  // electron-builder takes ONE afterPack, so the yml names a COMPOSER that
  // calls both artifact checks. §11 proves the composer really invokes them;
  // here we only prove the yml points at a module that imports the version
  // check, so a rename cannot quietly orphan it.
  const declared = path.resolve(DESKTOP, hookLine[1]);
  ok(existsSync(declared), `the declared hook exists (${path.basename(declared)})`);
  const composerSrc = read(declared);
  ok(composerSrc.includes('./verify-version.mjs'),
     'the declared hook imports the version check §5 just proved');
  ok(composerSrc.includes('./adhoc-sign.mjs'),
     'the declared hook imports the ad-hoc signing step §9-§10 prove');
}

// ─────────────────────────────────────────────────────────────────────────────
section('§7  applyAboutPanel() — EXECUTED against a stub app');
// ─────────────────────────────────────────────────────────────────────────────
//
// The user's report was literally "it doesn't have any data". These assertions
// are about CONTENT reaching Electron, driven through the real function.

function stubApp(version) {
  const calls = [];
  return {
    calls,
    getVersion: () => version,
    setAboutPanelOptions: (o) => calls.push(o),
  };
}

// A fake "packaged app root": a directory holding the injected manifest.
const packagedRoot = path.join(SCRATCH, 'packaged-root');
mkdirSync(packagedRoot, { recursive: true });
writeFileSync(path.join(packagedRoot, 'package.json'), JSON.stringify({ version: '4.2.0' }));

const appA = stubApp('0.0.0');
const optsA = applyAboutPanel(appA, packagedRoot, {
  versions: { electron: '43.5.0', chrome: '140.0.0.0', node: '22.20.0', v8: '14.0' },
  platform: 'darwin', osRelease: '24.6.0', arch: 'arm64', systemVersion: '15.6',
});
eq(appA.calls.length, 1, 'setAboutPanelOptions is called exactly once');
eq(appA.calls[0], optsA, 'and it is called with what the function returned');
eq(optsA.applicationVersion, '4.2.0',
   'the manifest at the app root wins over app.getVersion() — which is the sentinel');
ok(/Electron 43\.5\.0/.test(optsA.credits), 'the panel carries the Electron version');
ok(/Node 22\.20\.0/.test(optsA.credits), 'the panel carries the Node version');
ok(/Chromium 140\.0\.0\.0/.test(optsA.credits), 'the panel carries the Chromium version');
ok(/macOS 15\.6 \(arm64\)/.test(optsA.credits),
   'the OS line uses the macOS MARKETING version and the architecture');
ok(optsA.credits.split('\n').length >= 3,
   'the panel body is more than one line — the "no data" complaint is answered');

// The panel must not invent an application name or a copyright: both already
// exist authoritatively in the bundle, and a second copy is the class of defect
// this whole change is about.
ok(!('applicationName' in optsA) && !('copyright' in optsA),
   'no second copy of the app name or copyright is introduced');

// os.release() on a Mac is the DARWIN KERNEL version. Labelling it "macOS"
// would be a fabricated field.
const appB = stubApp('9.9.9');
const optsB = applyAboutPanel(appB, packagedRoot, {
  versions: { electron: '43.5.0', node: '22.20.0' },
  platform: 'darwin', osRelease: '24.6.0', arch: 'arm64', systemVersion: undefined,
});
ok(/darwin 24\.6\.0/.test(optsB.credits) && !/macOS 24\.6\.0/.test(optsB.credits),
   'without the Electron marketing version the kernel release is labelled darwin, not macOS');

// The sentinel must be LABELLED, never presented as a release number.
const emptyRoot = path.join(SCRATCH, 'empty-root');
mkdirSync(emptyRoot, { recursive: true });
const appC = stubApp(UNSET_VERSION);
const optsC = applyAboutPanel(appC, emptyRoot, { platform: 'linux', versions: {} });
ok(optsC.applicationVersion.includes(UNSET_VERSION) && optsC.applicationVersion !== UNSET_VERSION,
   'if the sentinel ever reaches the panel it is labelled, not shown as a version');
eq(formatVersionLabel('3.30.0'), '3.30.0',
   'CONTROL — a real version is shown unadorned');
eq(formatVersionLabel(UNSET_VERSION), `${UNSET_VERSION} (not injected)`, 'the sentinel is labelled');
eq(formatVersionLabel(null), 'unknown', 'an absent version says unknown rather than guessing');

// Falling back to app.getVersion() when there is no manifest at all.
ok(optsC.applicationVersion.startsWith(UNSET_VERSION),
   'with no manifest at the app root, app.getVersion() is the fallback');

// aboutPanelOptions must not fabricate lines from missing inputs.
eq(aboutPanelOptions({ version: '1.0.0' }).credits, '',
   'with no runtime information the credits block is EMPTY, not invented');

// ─────────────────────────────────────────────────────────────────────────────
section('§8  main.js call site (SOURCE SCAN — weak by nature)');
// ─────────────────────────────────────────────────────────────────────────────

const mainSrc = read(MAIN_JS);
const mainCode = mainSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
ok(/nativeTheme/.test(mainCode),
   'CONTROL — a known line of real code survives comment stripping');
ok(!/reported as "it doesn't have any data"/.test(mainCode),
   'CONTROL — a known comment does NOT survive comment stripping');

ok(/applyAboutPanel\s*\(\s*app\s*,\s*APP_ROOT\s*\)/.test(mainCode),
   'main.js calls applyAboutPanel(app, APP_ROOT) in real code, not in a comment');
ok(/from\s+'\.\/lib\/app-version\.js'/.test(mainCode),
   'and imports it from the module this suite executes');
ok(!/setAboutPanelOptions/.test(mainCode),
   'main.js does NOT hand-roll the panel — the one implementation stays testable');


// ─────────────────────────────────────────────────────────────────────────────
section('§9  The ad-hoc signing OFF-SWITCH — EXECUTED, every branch');
// ─────────────────────────────────────────────────────────────────────────────
//
// CLAUDE.md records `scripts/build-app.sh`'s trailing
// `codesign --force --deep --sign -` as a hazard because it would DESTROY a
// Developer ID signature. The ad-hoc step must not become the same hazard, so
// it turns itself off rather than merely documenting that it should be.

eq(shouldAdhocSign({ identity: null, env: {} }).sign, true,
   'with identity:null and a clean environment, the ad-hoc signature IS applied');

eq(shouldAdhocSign({ identity: 'Developer ID Application: Someone (ABCD1234)', env: {} }).sign, false,
   'a real mac.identity turns the ad-hoc step OFF — real signing owns the bundle');

// `'-'` is refused as a real identity rather than treated as "ad-hoc anyway".
// §10's fixture records what that route actually produces.
eq(shouldAdhocSign({ identity: '-', env: {} }).sign, false,
   "mac.identity:'-' turns the ad-hoc step off — electron-builder owns that path, and it is a TRAP");

// An ABSENT identity means electron-builder auto-discovers a keychain identity.
// Papering over that with an ad-hoc signature would hide the hazard, so refuse.
eq(shouldAdhocSign({ identity: undefined, env: {} }).sign, false,
   'an ABSENT mac.identity is refused — that is the keychain auto-discovery hazard, not a default');

// Every credential env var, enumerated from the module rather than hardcoded,
// so a new one added there is covered here automatically.
ok(REAL_SIGNING_ENV.length >= 5, `CONTROL — the credential env list is populated (${REAL_SIGNING_ENV.length} names)`);
let envOff = 0;
for (const key of REAL_SIGNING_ENV) {
  if (shouldAdhocSign({ identity: null, env: { [key]: 'x' } }).sign === false) envOff++;
}
eq(envOff, REAL_SIGNING_ENV.length,
   `every real-signing credential in the environment turns the ad-hoc step off (${envOff}/${REAL_SIGNING_ENV.length})`);
eq(shouldAdhocSign({ identity: null, env: { CSC_LINK: '' } }).sign, true,
   'CONTROL — an EMPTY credential variable does not count as configured');

// assertLoadable's STRUCTURAL refusals are portable — they never reach a
// Mach-O. The real load probe is §12b, on a real bundle, on macOS.
const twoExeDir = path.join(SCRATCH, 'twoexe.app', 'Contents', 'MacOS');
mkdirSync(twoExeDir, { recursive: true });
writeFileSync(path.join(twoExeDir, 'A'), '');
writeFileSync(path.join(twoExeDir, 'B'), '');
ok(threw(() => assertLoadable(path.join(SCRATCH, 'twoexe.app'))).threw,
   'assertLoadable REFUSES an ambiguous bundle rather than probing an arbitrary binary');
ok(threw(() => assertLoadable(path.join(SCRATCH, 'no-such.app'))).threw,
   'assertLoadable REFUSES a bundle with no Contents/MacOS at all');
const deadDir = path.join(SCRATCH, 'dead.app', 'Contents', 'MacOS');
mkdirSync(deadDir, { recursive: true });
writeFileSync(path.join(deadDir, 'Dead'), '#!/nonexistent\n');
spawnSync('chmod', ['000', path.join(deadDir, 'Dead')]);
const deadRun = threw(() => assertLoadable(path.join(SCRATCH, 'dead.app')));
ok(deadRun.threw, 'assertLoadable REFUSES a bundle whose executable cannot start');
ok(deadRun.threw && /FAILS TO LOAD/.test(deadRun.message),
   'and it says FAILS TO LOAD — the failure a signature check cannot see');

// electronFuses is the one thing electron-builder does BETWEEN this hook and
// the finished bundle, and it rewrites the main binary. A signature applied
// here would be silently invalidated, so this THROWS rather than skipping.
const fuseRun = threw(() => shouldAdhocSign({ identity: null, env: {}, electronFuses: { runAsNode: false } }));
ok(fuseRun.threw, 'configuring electronFuses REFUSES the build rather than shipping a broken signature');
ok(fuseRun.threw && /invalidate/i.test(fuseRun.message),
   'and the refusal explains that the signature would be invalidated');
// And it must not be true today, or the shipping build is already broken.
const ebRaw = read(EB_YML);
ok(!/^\s*electronFuses:/m.test(stripYamlComments(ebRaw)),
   'CONTROL — electron-builder.yml configures no electronFuses today, so the hook order holds');

// ─────────────────────────────────────────────────────────────────────────────
section('§10 Signature parsing + refusal — EXECUTED against REAL codesign output');
// ─────────────────────────────────────────────────────────────────────────────
//
// These three fixtures are VERBATIM `codesign -dv --verbose=4` output measured
// on real bundles built from this very config on 2026-08-31. The fourth is
// marked as fabricated because no Developer ID certificate exists to produce
// it. Nothing here is paraphrased.

// (a) The SHIPPED DEFECT: `mac.identity: null`, no hook.
const BEFORE_FIX = `Executable=/…/The Curator.app/Contents/MacOS/The Curator
Identifier=Electron
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements count=0 size=12`;

// (b) What this build path now produces.
const AFTER_FIX = `Executable=/…/The Curator.app/Contents/MacOS/The Curator
Identifier=com.talirezun.the-curator
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=498 flags=0x2(adhoc) hashes=9+3 location=embedded
Signature=adhoc
Info.plist entries=28
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=5563
Internal requirements count=1 size=192`;

// (c) THE TRAP. Real output from a build with `mac.identity: '-'`. It passes
//     `codesign --verify --deep --strict`, passes spctl the same way as a good
//     bundle, and clears syspolicy_check's Codesign Error — and the app DOES
//     NOT LAUNCH (dyld library-validation error, measured).
const IDENTITY_DASH = `Executable=/…/The Curator.app/Contents/MacOS/The Curator
Identifier=com.talirezun.the-curator
CodeDirectory v=20500 size=634 flags=0x10002(adhoc,runtime) hashes=9+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=5563`;

// (d) FABRICATED — no Developer ID certificate exists here to produce a real
//     one. Labelled rather than presented as measured.
const DEVELOPER_ID = `Executable=/…/The Curator.app/Contents/MacOS/The Curator
Identifier=com.talirezun.the-curator
CodeDirectory v=20500 size=634 flags=0x10000(runtime) hashes=9+7 location=embedded
Authority=Developer ID Application: Example Org (9ABCDEFG12)
TeamIdentifier=9ABCDEFG12
Sealed Resources version=2 rules=13 files=5563`;

const before = parseSignatureInfo(BEFORE_FIX);
eq(before.identifier, 'Electron',
   'BEFORE: the identifier was the generic "Electron", not the app\'s bundle id');
eq(before.linkerSigned, true, 'BEFORE: the signature was Electron\'s linker-signed stub');
eq(before.hasSealedResources, false, 'BEFORE: there were NO sealed resources — the "damaged" defect');
ok(threw(() => assertAdhocOnly(before)).threw,
   'THE SHIPPED DEFECT IS REFUSED: the before-fix signature does not pass');
ok(/damaged/i.test(threw(() => assertAdhocOnly(before)).message),
   'and the refusal names the user-visible symptom');

const after = parseSignatureInfo(AFTER_FIX);
eq(after.identifier, 'com.talirezun.the-curator',
   'AFTER: the identifier is the real bundle id — signing also fixed the app\'s identity');
eq(after.adhoc, true, 'AFTER: ad-hoc');
eq(after.linkerSigned, false, 'AFTER: the linker-signed stub is gone');
eq(after.hasSealedResources, true, 'AFTER: resources are sealed (rules=13 files=5563)');
eq(after.teamIdentifier, 'not set', 'AFTER: no TeamIdentifier — no certificate was used');
eq(assertAdhocOnly(after), true, 'AFTER: the shipping signature is ACCEPTED');

const dash = parseSignatureInfo(IDENTITY_DASH);
eq(dash.flags.includes('runtime'), true, "identity:'-' turns the hardened runtime ON over an ad-hoc signature");
const dashRun = threw(() => assertAdhocOnly(dash));
ok(dashRun.threw, "THE TRAP IS REFUSED: hardened-runtime-over-ad-hoc does not pass, even though codesign --verify accepts it");
ok(dashRun.threw && /launch/i.test(dashRun.message),
   'and the refusal says the measured consequence: the app fails to launch');

const devid = parseSignatureInfo(DEVELOPER_ID);
eq(devid.teamIdentifier, '9ABCDEFG12', 'a real certificate is detected by its TeamIdentifier');
const devRun = threw(() => assertAdhocOnly(devid));
ok(devRun.threw,
   'A KEYCHAIN IDENTITY CANNOT LEAK THROUGH: a Developer-ID-signed bundle is refused by this path');
ok(devRun.threw && /TeamIdentifier/.test(devRun.message),
   'and the refusal names the TeamIdentifier that gave it away');

eq(parseSignatureInfo('').flags, [],
   'unparseable codesign output yields no flags — which assertAdhocOnly then refuses');
ok(threw(() => assertAdhocOnly(parseSignatureInfo(''))).threw,
   'and an EMPTY reading fails CLOSED rather than passing');

// ─────────────────────────────────────────────────────────────────────────────
section('§11 The afterPack hook runs BOTH checks — EXECUTED');
// ─────────────────────────────────────────────────────────────────────────────

const hookLine2 = stripYamlComments(read(EB_YML)).match(/^afterPack:\s*(\S+)\s*$/m);
const composerPath = hookLine2 ? path.resolve(DESKTOP, hookLine2[1]) : null;
ok(composerPath && existsSync(composerPath),
   'the afterPack module electron-builder.yml names exists');

const composer = await import(`file://${composerPath}`);
ok(typeof composer.afterPack === 'function', 'it exports `afterPack`');

// A context shaped like electron-builder's, with a bundle carrying the WRONG
// version. It must reject — proving the version half is still wired in.
const badVersionDir = path.join(SCRATCH, 'hook-badversion');
fabricateBundle(badVersionDir, 'The Curator', { short: '9.9.9', bundle: '9.9.9' });
let composerRejected = false, composerMsg = '';
try {
  await composer.afterPack({
    appOutDir: badVersionDir,
    packager: { platformSpecificBuildOptions: { identity: null }, config: {} },
  });
} catch (err) { composerRejected = true; composerMsg = err.message; }
ok(composerRejected && /root package\.json/.test(composerMsg),
   'the hook still refuses a wrong VERSION — the version half is wired in');

// Correct version, but a real identity configured: the hook must complete and
// must NOT have signed. Proving it did not sign is the point — it is the
// property that stops this becoming build-app.sh's signature-destroying step.
const skipDir = path.join(SCRATCH, 'hook-skip');
fabricateBundle(skipDir, 'The Curator', { short: rootVersion, bundle: rootVersion });
let skipOk = true;
try {
  await composer.afterPack({
    appOutDir: skipDir,
    packager: {
      platformSpecificBuildOptions: { identity: 'Developer ID Application: Example (9ABCDEFG12)' },
      config: {},
    },
  });
} catch { skipOk = false; }
ok(skipOk, 'with a real identity configured the hook completes without signing');
ok(!existsSync(path.join(skipDir, 'The Curator.app', 'Contents', '_CodeSignature')),
   'and it left NO _CodeSignature behind — nothing was signed, nothing was clobbered');

// And the positive half: with identity:null the composer must actually SIGN.
// Proven by capturing what it reports while driving it over the real built app
// (re-signing is idempotent). If the signing call is removed from the composer
// this goes red, because the step simply does not happen.
{
  const builtRoots = ['mac-arm64', 'mac', 'mac-universal', 'mac-x64']
    .map((d) => path.join(DESKTOP, 'dist', d)).filter((d) => existsSync(d));
  let realApp = null;
  for (const d of builtRoots) {
    const app = readdirSync(d).find((e) => e.endsWith('.app'));
    if (app) { realApp = path.join(d, app); break; }
  }
  if (process.platform !== 'darwin' || !realApp) {
    console.log('  ⊘ the composer\'s SIGNING half needs a real built app on macOS — skipped here.');
    console.log('    Every real build exercises it; §9-§10 cover the decision and the refusal.');
  } else {
    const said = [];
    const realLog = console.log;
    console.log = (...a) => said.push(a.join(' '));
    let composerErr = null;
    try {
      await composer.afterPack({
        appOutDir: path.dirname(realApp),
        packager: { platformSpecificBuildOptions: { identity: null }, config: {} },
      });
    } catch (err) { composerErr = err; }
    console.log = realLog;
    ok(composerErr === null, 'the composer completes on the real built app');
    ok(said.some((l) => /ad-hoc signature/.test(l) && /valid/.test(l)),
       'THE COMPOSER REALLY SIGNS: it reports a valid ad-hoc signature on the real bundle');
    ok(said.some((l) => /version identity/.test(l)),
       'and it reports the version check in the same run — both halves ran');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('§12 A real codesign round trip');
// ─────────────────────────────────────────────────────────────────────────────

if (process.platform !== 'darwin') {
  console.log('  ⊘ SKIPPED — codesign is macOS-only, and `npm test` runs on ubuntu-latest in CI.');
  console.log('    A DMG can only be built on a Mac, which is where this section does run.');
  console.log('    §9–§11 above cover the off-switch, the parser and the hook wiring everywhere.');
} else {
  // ── §12a — a REAL codesign round trip on a fabricated bundle ─────────────
  //
  // A minimal but genuine bundle: a real Mach-O, a real Info.plist, and a
  // resource to seal. codesign treats it exactly as it treats the app.
  //
  // The executable is a COPY OF /bin/echo, and it is deliberately never
  // executed here: a copy of an Apple platform binary is SIGKILLed on exec
  // (measured — exit 137, before and after signing), which is a property of
  // macOS platform binaries and nothing to do with our signature. §12b does
  // the load probe, on a real bundle.
  const rtDir = path.join(SCRATCH, 'roundtrip');
  const rtApp = path.join(rtDir, 'Probe.app');
  mkdirSync(path.join(rtApp, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(path.join(rtApp, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(path.join(rtApp, 'Contents', 'Resources', 'seed.txt'), 'seal me');
  writeFileSync(path.join(rtApp, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>' +
    '<key>CFBundleExecutable</key><string>Probe</string>' +
    '<key>CFBundleIdentifier</key><string>com.example.probe</string>' +
    '</dict></plist>');
  writeFileSync(path.join(rtApp, 'Contents', 'MacOS', 'Probe'), readFileSync('/bin/echo'));

  const signRun = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', rtApp], { encoding: 'utf8' });
  eq(signRun.status, 0, 'a real ad-hoc codesign of a real bundle succeeds');

  const verifyRun = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', rtApp], { encoding: 'utf8' });
  eq(verifyRun.status, 0, 'INDEPENDENT: `codesign --verify --deep --strict` exits 0 on it');

  const dvRun = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', rtApp], { encoding: 'utf8' });
  const realInfo = parseSignatureInfo(`${dvRun.stdout}${dvRun.stderr}`);
  eq(realInfo.adhoc, true, 'the parser reads `adhoc` off REAL codesign output');
  eq(realInfo.hasSealedResources, true, 'and reads a real sealed-resource line');
  eq(realInfo.teamIdentifier, 'not set', 'and reads TeamIdentifier=not set');
  eq(assertAdhocOnly(realInfo), true, 'and the refusal function ACCEPTS a genuinely good signature');

  // The control that makes §12a non-vacuous: the SAME shape, unsigned.
  const rawApp = path.join(rtDir, 'Raw.app');
  mkdirSync(path.join(rawApp, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(path.join(rawApp, 'Contents', 'Info.plist'), readFileSync(path.join(rtApp, 'Contents', 'Info.plist')));
  writeFileSync(path.join(rawApp, 'Contents', 'MacOS', 'Probe'), readFileSync('/bin/echo'));
  spawnSync('/usr/bin/codesign', ['--remove-signature', path.join(rawApp, 'Contents', 'MacOS', 'Probe')]);
  const rawCheck = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', rawApp], { encoding: 'utf8' });
  ok(rawCheck.status !== 0,
     'CONTROL — an unsigned bundle of the same shape FAILS the same check');

  // ── §12b — the LOAD PROBE, against a real built app if one is present ────
  //
  // This is the check no static signature check can replace: a bundle can
  // verify clean and still die at dyld time. It needs a real Electron bundle,
  // so it runs only after a local build. dist/ is gitignored, so on a clean
  // checkout this reports SKIPPED rather than pretending.
  const distRoots = ['mac-arm64', 'mac', 'mac-universal', 'mac-x64']
    .map((d) => path.join(DESKTOP, 'dist', d))
    .filter((d) => existsSync(d));
  let builtApp = null;
  for (const d of distRoots) {
    const app = readdirSync(d).find((e) => e.endsWith('.app'));
    if (app) { builtApp = path.join(d, app); break; }
  }

  if (!builtApp) {
    console.log('  ⊘ §12b SKIPPED — no built app under desktop/dist/. Run `npm run dist` in');
    console.log('    desktop/ first; the hook itself runs this same probe on every build,');
    console.log('    so a real build cannot skip it.');
  } else {
    // Re-signing an already-signed bundle is idempotent, so this is safe to run
    // against the real artifact.
    const real = adhocSign({ appPath: builtApp, identity: null, env: {} });
    eq(real.signed, true, `the REAL adhocSign() signs the built app (${path.basename(builtApp)})`);
    eq(real.info.adhoc, true, 'the built app is ad-hoc signed');
    eq(real.info.hasSealedResources, true, 'its resources are SEALED — the shipped defect is gone');
    eq(real.info.teamIdentifier, 'not set', 'it carries no TeamIdentifier — no keychain identity leaked');
    ok(!real.info.flags.includes('runtime'),
       'and the hardened runtime is NOT enabled — that is the shape that fails to launch');
    ok(!threw(() => assertLoadable(builtApp)).threw,
       'THE LOAD PROBE PASSES: dyld maps the embedded Electron Framework');

    // Non-vacuity, on a COPY, by changing exactly one variable: the hardened
    // runtime. `--deep` is present in BOTH arms, which is what exonerates it.
    const badCopy = path.join(SCRATCH, 'Runtime.app');
    const cp = spawnSync('cp', ['-R', builtApp, badCopy], { encoding: 'utf8' });
    if (cp.status === 0) {
      const rs = spawnSync('/usr/bin/codesign',
        ['--force', '--deep', '--options', 'runtime', '--sign', '-', badCopy], { encoding: 'utf8' });
      if (rs.status === 0) {
        const badVerify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', badCopy], { encoding: 'utf8' });
        eq(badVerify.status, 0,
           'CONTROL — the hardened-runtime copy PASSES `codesign --verify --deep --strict`…');
        ok(threw(() => assertLoadable(badCopy)).threw,
           '…and STILL fails the load probe. Static checks cannot see this; the probe can.');
        const badInfo = parseSignatureInfo(
          (() => { const r = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', badCopy], { encoding: 'utf8' }); return `${r.stdout}${r.stderr}`; })());
        ok(threw(() => assertAdhocOnly(badInfo)).threw,
           'and assertAdhocOnly refuses it too, on the runtime flag alone');
      } else {
        console.log('  ⊘ the hardened-runtime control could not be produced (codesign refused)');
      }
      rmSync(badCopy, { recursive: true, force: true });
    }
  }
}

console.log(`
  ── NOT ENFORCED, stated rather than implied ──────────────────────────────

  · THE RENDERED PANEL IS NOT VERIFIED. macOS's About panel is a native
    NSPanel with no read-back API, and driving the menu item needs assistive
    access, which was attempted and refused (-1719). §7 proves the exact
    options object handed to Electron; it does not prove what macOS draws.

  · §8 IS A SOURCE SCAN and cannot be more. main.js is unimportable offline
    (Electron is not an offline-suite dependency). The scan proves the call
    site exists in code; only a running app proves it executes. It DID run:
    the packaged .app was launched under test isolation on 2026-08-31 and
    boot() completed with this call in it.

  · THE HOOK IS BYPASSABLE BY A DELIBERATE ACT. A different --config, an
    explicit --config.afterPack=null, or packaging by hand all skip it. What
    it closes is the path that actually shipped: forgetting the version.

  · NOTHING HERE BUILDS. npm test must stay free and offline, so the real
    electron-builder run is not reachable from this suite. It was run by hand:
    without injection the build was REFUSED at afterPack and produced no DMG;
    with \`npm run dist\` the Info.plist read 3.30.0 for both keys; and an
    injected 9.9.9 was refused with the mismatch named.

  · SIGNING: THE LOAD PROBE IS NOT A LAUNCH. 'assertLoadable' proves dyld maps
    the embedded Electron Framework — the thing that was silently failing — by
    running the app binary in ELECTRON_RUN_AS_NODE mode. It does NOT prove the
    window paints or the server serves. Both were verified BY HAND on
    2026-08-31, in place and after copying the .app out of the build tree
    (relocated: framework loads, modules resolve, GET /api/write-status -> 200).

  · SIGNING: NO GATEKEEPER PATH IS EXERCISED. Nothing here downloads the DMG,
    so no quarantine xattr is ever set and the actual "unidentified developer"
    prompt is never seen. 'spctl --assess' was run by hand and reported the
    plain "rejected" that corresponds to it (exit 3), rather than the integrity
    error the unsigned build produced (exit 1).

  · SIGNING: §12 IS macOS-ONLY. 'codesign' does not exist on the ubuntu-latest
    runner 'npm test' uses in CI, so on Linux §12 prints SKIPPED. §9-§11 — the
    off-switch, the parser and the hook wiring — run everywhere. A DMG can only
    be built on a Mac, which is where §12 does run.

  · THE ROOT MANIFEST AND THE GIT TAG ARE STILL TWO SOURCES. The CI workflow
    derives the version from the tag, and this hook then checks it against the
    root manifest — so a tag that disagrees now FAILS the build rather than
    shipping. That is a check, not a single source; scripts/release.js is what
    keeps them equal, and this suite does not own it.
`);

rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\n${'═'.repeat(42)}\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
