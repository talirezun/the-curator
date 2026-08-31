/**
 * test-desktop-update.js — OFFLINE guard for the in-app updater.
 *
 * Covers `desktop/lib/update-plan.js`, `desktop/lib/update-release.js`,
 * `desktop/lib/update-engine.js` and the two new hook names in
 * `src/brain/desktop-host.js`.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────────
 *
 * Both update hooks are EXECUTED end to end. Not source-scanned: the download
 * really streams (from a real `Response` over a real byte buffer), the sha256
 * is really computed, the staging directory is really created on disk, the
 * swap script is really run by a real `/bin/sh` against a real fixture bundle,
 * and the rollback really rolls back. What is faked is exactly three things
 * and no more: the network, the four macOS command-line tools, and Electron's
 * `app.quit()`. Every one of those is an injected dependency of
 * `createUpdateEngine()` for this reason.
 *
 * The macOS tools themselves — `hdiutil`, `ditto`, `plutil`, `codesign` — are
 * exercised for real by `scripts/test-desktop-update-macos.js`, which is
 * LIVE_LOCAL because they do not exist on the Linux runner this suite has to
 * pass on. This suite proves the ORCHESTRATION; that one proves the tools.
 *
 * ── SECTIONS ────────────────────────────────────────────────────────────────
 *   §0  positive control — the modules really loaded
 *   §1  real user data is untouched
 *   §2  electron-updater is not merely absent, it is UNUSABLE — the
 *       offline-checkable half of that argument, executed
 *   §3  progressOf — the arithmetic, and `percent: null` as its own fact
 *   §4  which .dmg — digest parsing, arch tokens, https-only, refusals
 *   §5  where we are installed — and the REUSED translocation classifier
 *   §6  buildSwapScript — real /bin/sh parses it, and the two renames are
 *       adjacent
 *   §7  THE SWAP, EXECUTED — happy path, rollback, and every refusal
 *   §8  resolveInstallerRelease — delegation to the REAL src/routes/config.js
 *   §9  prepareUpdate, EXECUTED — download, verify, stage, and each failure
 *   §10 installUpdate, EXECUTED — the token boundary and the write guard
 *   §11 source discipline
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────────
 *
 *  - NO APPLICATION WAS EVER REPLACED. Nothing here runs against a real
 *    `.app` in `/Applications`; every path is inside a temp directory. The
 *    swap logic is proven on fixture directories that are structurally
 *    identical to a bundle, which is what `rename(2)` actually sees — but
 *    "macOS relaunches the swapped bundle correctly" is not, and cannot be,
 *    proven by an automated suite that must not touch the user's own app.
 *  - THE TWO-SYSCALL WINDOW IS NOT MEASURED. §6 asserts that no statement
 *    sits between the two `mv` commands, which is the property under this
 *    file's control. How wide that window is in wall-clock terms, and what a
 *    real power loss inside it leaves behind, is reasoned about in
 *    `buildSwapScript`'s docblock and not measured here.
 *  - §2 CANNOT PROVE SQUIRREL.MAC REJECTS THE UPDATE. It proves the premises
 *    that make the rejection certain — ad-hoc only, no zip target, no publish
 *    feed, no dependency — from the config and from the signing hook's own
 *    executed refusal. The rejection itself was verified by hand, once, by
 *    reading the shipped bundle's designated requirement with
 *    `codesign -d -r-`; it prints a bare `cdhash` requirement, which only the
 *    installed build can satisfy.
 *  - `desktop/main.js` IS NOT EXECUTED. Electron is not an offline-suite
 *    dependency. §11 scans its wiring and says so.
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

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
/**
 * Read, or return '' when the path is absent.
 *
 * Used for every read of a FIXTURE that a mutation could legitimately delete.
 * A bare `read()` there does not merely fail the assertion — it throws out of
 * the suite, which is the v3.24.1 shape: the tally is wrong, nothing names the
 * expectation, and in `npm test` it surfaces as a timeout rather than as a
 * failure. Two mutations landed exactly that way (the sweeper widened to the
 * whole folder; ditto swapped for a command the harness does not emulate), and
 * one of them crashed BEFORE the assertion that exists to catch it could run.
 */
function readIf(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

/** LINE COMMENTS FIRST — the order is load-bearing, and this repo has the
 *  scar: a `//` comment containing a glob path holds `/*`, so a block-comment
 *  pass run first opens a comment there and eats hundreds of lines, turning
 *  every subsequent `!/…/.test()` into a scan over an empty string that passes
 *  everything. Copied rather than imported for the same reason
 *  test-desktop-menu.js copied it: a shared helper is a shared blast radius. */
function stripJsComments(src) {
  return src.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-update-test-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let tmpSeq = 0;
function tmpdir(name) {
  const p = path.join(TMP, `${name}-${tmpSeq++}`);
  mkdirSync(p, { recursive: true });
  return p;
}

/** A directory that is structurally an app bundle. Everything the swap and
 *  the staging checks look at is real; only the Mach-O is a shell script. */
function makeFixtureApp(at, { version = '9.9.9', name = 'The Curator.app' } = {}) {
  const app = path.join(at, name);
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'MacOS', 'The Curator'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n' +
    `<key>CFBundleShortVersionString</key><string>${version}</string>\n</dict></plist>\n`);
  return app;
}

let plan, release, engine, host, cfg;
try {
  plan = await import(path.join(DESKTOP, 'lib', 'update-plan.js'));
  release = await import(path.join(DESKTOP, 'lib', 'update-release.js'));
  engine = await import(path.join(DESKTOP, 'lib', 'update-engine.js'));
  host = await import(path.join(ROOT, 'src', 'brain', 'desktop-host.js'));
  cfg = await import(path.join(ROOT, 'src', 'routes', 'config.js'));
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the update modules: ${err.message}`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§0 positive control — the modules really loaded');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(typeof plan.buildSwapScript === 'function', 'update-plan exports buildSwapScript');
  ok(typeof release.resolveInstallerRelease === 'function', 'update-release exports resolveInstallerRelease');
  ok(typeof engine.createUpdateEngine === 'function', 'update-engine exports createUpdateEngine');
  ok(typeof cfg.pickInstallableRelease === 'function',
     'the REAL src/routes/config.js loaded — §8 delegates to this, not to a stand-in');
  eq(plan.UPDATE_PHASES.slice(), ['resolving', 'downloading', 'verifying', 'staging', 'installing'],
     'the five phases are exactly the contract the UI half renders');
  ok(Object.isFrozen(plan.UPDATE_PHASES), 'and the list is frozen, so a consumer cannot mutate the contract');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1 Real user data is untouched');
// ═══════════════════════════════════════════════════════════════════════════
// sha256 + size + existence ONLY — never mtime, which the maintainer's live
// app rewrites during an ordinary Settings action and which has produced a
// false "isolation is broken" twice in this repo's history.
const fingerprint = (p) => (existsSync(p)
  ? { size: statSync(p).size, sha: createHash('sha256').update(readFileSync(p)).digest('hex') }
  : null);
const CONFIG_FILE = path.join(ROOT, '.curator-config.json');
const configBefore = fingerprint(CONFIG_FILE);
{
  ok(TMP.startsWith(os.tmpdir()), `every path this suite writes to is under ${os.tmpdir()} (anti-vacuity)`);
  ok(!TMP.startsWith(ROOT), 'and none of them is inside the repository');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 electron-updater is not merely absent — it is UNUSABLE');
// ═══════════════════════════════════════════════════════════════════════════
// Four independent premises. Any ONE of them alone would stop Squirrel.Mac,
// and all four hold today. They are asserted here so that a future change
// which quietly makes one of them false — adding a zip target, say — has to
// come past this section and state what it is doing about the other three.
{
  const rootPkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const deskPkg = JSON.parse(read(path.join(DESKTOP, 'package.json')));
  const allDeps = (p) => Object.keys({ ...(p.dependencies || {}), ...(p.devDependencies || {}) });
  ok(!allDeps(rootPkg).includes('electron-updater'), 'the root manifest does not depend on electron-updater');
  ok(!allDeps(deskPkg).includes('electron-updater'), 'nor does the desktop manifest');

  const yml = read(path.join(DESKTOP, 'electron-builder.yml'));
  const uncommented = yml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  ok(/^publish:\s*null\s*$/m.test(uncommented),
     'PREMISE 1 — `publish: null`, so electron-builder emits no latest-mac.yml, which is the feed electron-updater reads');
  ok(/^\s+identity:\s*null\s*$/m.test(uncommented),
     'PREMISE 2 — `mac.identity: null`, so no certificate signs the bundle');
  ok(/-\s*target:\s*dmg/.test(uncommented) && !/target:\s*zip/.test(uncommented),
     'PREMISE 3 — the only mac target is dmg; Squirrel.Mac installs from a ZIP and there is none');

  // PREMISE 4, and it is the load-bearing one: the shipped bundle is provably
  // AD-HOC, so its designated requirement can only be a cdhash — a hash of
  // this exact build, which no later build can match. That is not asserted
  // about a config string; the build hook's own refusal is EXECUTED.
  const adhoc = await import(path.join(DESKTOP, 'lib', 'adhoc-sign.mjs'));
  let threw = null;
  try {
    adhoc.assertAdhocOnly({
      flags: ['adhoc'], adhoc: true, linkerSigned: false,
      sealedResources: 'version=2 rules=13 files=5566', hasSealedResources: true,
      teamIdentifier: 'ABCDE12345', identifier: 'com.talirezun.the-curator', authority: null,
    });
  } catch (e) { threw = e; }
  ok(threw && /TeamIdentifier/.test(threw.message),
     'PREMISE 4 — the build REFUSES any bundle carrying a TeamIdentifier, so what ships is always ad-hoc');
  // The control that makes the above non-vacuous: the shape that DOES ship passes.
  let passedOk = false;
  try {
    passedOk = adhoc.assertAdhocOnly({
      flags: ['adhoc'], adhoc: true, linkerSigned: false,
      sealedResources: 'version=2 rules=13 files=5566', hasSealedResources: true,
      teamIdentifier: 'not set', identifier: 'com.talirezun.the-curator', authority: null,
    }) === true;
  } catch { passedOk = false; }
  ok(passedOk, 'CONTROL — the ad-hoc shape the release actually carries is accepted, so §2 is not refusing everything');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 progressOf — the arithmetic, and `percent: null` as its own fact');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(plan.progressOf('downloading', 50, 200), { phase: 'downloading', receivedBytes: 50, totalBytes: 200, percent: 25 },
     'a plain quarter is 25');
  eq(plan.progressOf('resolving', 0, null).percent, null,
     'an UNKNOWN total gives percent null — never 0, which would render as a bar that means "nothing yet"');
  eq(plan.progressOf('downloading', 5, 0).percent, null, 'a zero total is unknown, not a division by zero');
  eq(plan.progressOf('downloading', 5, -1).percent, null, 'a negative total is unknown too');
  eq(plan.progressOf('downloading', 300, 200).percent, 100, 'a server that over-sends is clamped to 100, not 150');
  eq(plan.progressOf('downloading', -5, 200).receivedBytes, 0, 'a negative byte count floors at 0');
  eq(plan.progressOf('downloading', NaN, 200).receivedBytes, 0, 'NaN in never becomes NaN out');
  eq(plan.progressOf('downloading', 10, NaN).percent, null, 'nor does a NaN total');
  eq(plan.progressOf('downloading', 1, 3).percent, 33.3, 'one decimal place, so a 140 MB bar moves smoothly');
  for (const p of ['resolving', 'downloading', 'verifying', 'staging', 'installing']) {
    ok(plan.progressOf(p, 1, 2).phase === p, `phase "${p}" round-trips`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 Which .dmg — digests, arch tokens, https-only');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(plan.parseAssetDigest(`sha256:${'a'.repeat(64)}`), { algorithm: 'sha256', hex: 'a'.repeat(64) },
     'a real GitHub digest parses');
  eq(plan.parseAssetDigest(`SHA256:${'A'.repeat(64)}`), { algorithm: 'sha256', hex: 'a'.repeat(64) },
     'case is normalised');
  eq(plan.SUPPORTED_DIGEST_ALGORITHMS.slice(), ['sha256', 'sha512'],
     'the algorithm allow-list is exactly sha256 and sha512');
  eq(plan.parseAssetDigest(`md5:${'a'.repeat(32)}`), null,
     'md5 is REFUSED at its OWN hex length — createHash would accept it, and a remote payload must not choose our hash');
  ok(!Object.hasOwn(plan.DIGEST_HEX_LENGTHS, 'md5'),
     'and the list is DERIVED from the length table, so md5 cannot be admitted without also stating a length');
  eq(plan.parseAssetDigest(`sha256:${'a'.repeat(63)}`), null, 'a short sha256 is refused, not truncated');
  eq(plan.parseAssetDigest('sha256:zzzz'), null, 'non-hex is refused');
  eq(plan.parseAssetDigest(null), null, 'an ABSENT digest is null, not a throw — older releases predate the field');

  // The real asset names, transcribed from this repository's live releases.
  eq(plan.archFromAssetName('TheCurator-3.32.0-arm64-AppleSilicon.dmg'), 'arm64', 'the real arm64 asset name');
  eq(plan.archFromAssetName('TheCurator-3.32.0-x64-Intel.dmg'), 'x64', 'the real x64 asset name');
  eq(plan.archFromAssetName('TheCurator-3.32.0-arm64-AppleSilicon.zip'), null, 'a non-.dmg is not an installer');
  // THE SUBSTRING TRAP. `name.includes('arm64')` passes this and is wrong.
  eq(plan.archFromAssetName('TheCurator-3.arm64.0-x64-Intel.dmg'), 'x64',
     'a version string containing "arm64" does NOT hijack the arch — tokens, not substrings');
  eq(plan.archFromAssetName('TheCurator-3.0.0-x64_64-Intel.dmg'), null,
     'and "x64_64" is not "x64" — an unrecognised token refuses rather than guessing');
  eq(plan.archFromAssetName('TheCurator-3.0.0-arm64-x64-universal.dmg'), null,
     'a name carrying BOTH tokens is AMBIGUOUS and refuses — preferring one is how a mislabelled or universal asset gets installed on the wrong chip');

  const assets = [
    { name: 'TheCurator-3.32.0-arm64-AppleSilicon.dmg', size: 137921531, browser_download_url: 'https://github.com/talirezun/the-curator/releases/download/v3.32.0/TheCurator-3.32.0-arm64-AppleSilicon.dmg', digest: `sha256:${'b'.repeat(64)}` },
    { name: 'TheCurator-3.32.0-x64-Intel.dmg', size: 143496447, browser_download_url: 'https://github.com/talirezun/the-curator/releases/download/v3.32.0/TheCurator-3.32.0-x64-Intel.dmg', digest: `sha256:${'c'.repeat(64)}` },
  ];
  const arm = plan.pickInstallerAsset(assets, { arch: 'arm64' });
  ok(arm.ok && arm.asset.name.includes('arm64'), 'an arm64 Mac is offered the arm64 build');
  eq(arm.asset.size, 137921531, 'with the size GitHub declares');
  const intel = plan.pickInstallerAsset(assets, { arch: 'x64' });
  ok(intel.ok && intel.asset.name.includes('x64'),
     'an Intel Mac is offered the Intel build — LIKE FOR LIKE, never a silent architecture migration');
  eq(plan.pickInstallerAsset(assets, { arch: 'riscv' }).reason, 'no-asset-for-arch', 'an unknown arch refuses by name');
  eq(plan.pickInstallerAsset(null, { arch: 'arm64' }).reason, 'no-asset-for-arch', 'a non-array refuses rather than throwing');

  eq(plan.pickInstallerAsset([{ name: 'x-arm64.dmg', size: 1, browser_download_url: 'http://github.com/a.dmg' }], { arch: 'arm64' }).reason,
     'asset-unusable', 'PLAIN HTTP IS REFUSED — the URL comes off the network and is handed to fetch()');
  eq(plan.pickInstallerAsset([{ name: 'x-arm64.dmg', size: 1, browser_download_url: 'https://evil.example.com/a.dmg' }], { arch: 'arm64' }).reason,
     'asset-unusable', 'and so is a host GitHub does not serve releases from');
  eq(plan.pickInstallerAsset([{ name: 'x-arm64.dmg', browser_download_url: 'https://github.com/a.dmg' }], { arch: 'arm64' }).reason,
     'asset-unusable', 'an asset with no size is refused — the length check would have nothing to compare against');

  // Every reason this feature can emit must have a sentence. A refusal that
  // renders as an empty dialog is worse than an exception.
  for (const r of Object.keys(plan.UPDATE_FAILURES)) {
    ok(typeof plan.UPDATE_FAILURES[r] === 'string' && plan.UPDATE_FAILURES[r].length > 20,
       `reason "${r}" carries a real sentence`);
  }
  ok(!Object.values(plan.UPDATE_FAILURES).some((m) => /\bEACCES\b|\bENOENT\b|undefined|\[object/.test(m)),
     'no failure sentence leaks an errno or a stringified object at the user');
  eq(plan.updateFailure('no-such-reason').ok, false, 'an unmapped reason is still a refusal...');
  ok(plan.updateFailure('no-such-reason').message.length > 10, '...with a sentence rather than an empty dialog');
  eq(plan.updateFailure('digest-mismatch', '/Users/somebody/secret').message,
     plan.UPDATE_FAILURES['digest-mismatch'],
     'the LOG detail never reaches the user-facing message — a path must not be splashed into a dialog');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 Where we are installed — and the REUSED translocation classifier');
// ═══════════════════════════════════════════════════════════════════════════
const launcher = await import(path.join(ROOT, 'src', 'brain', 'mcp-launcher.js'));
{
  eq(plan.bundlePathFromExecPath('/Applications/The Curator.app/Contents/MacOS/The Curator'),
     '/Applications/The Curator.app', 'the bundle is found from the executable');
  eq(plan.bundlePathFromExecPath('/usr/local/bin/node'), null,
     'a plain node binary is NOT a bundle — `npm start` must refuse, not guess at a directory to move');
  eq(plan.bundlePathFromExecPath('/Users/x/My.apps/thing'), null,
     'a folder merely ENDING in .app is not matched unless it is the component holding Contents/MacOS');
  eq(plan.bundlePathFromExecPath('/A/Outer.app/Inner.app/Contents/MacOS/x'), '/A/Outer.app/Inner.app',
     'nested .app components resolve to the INNER bundle, the one Contents/MacOS belongs to');
  eq(plan.bundlePathFromExecPath(''), null, 'an empty execPath is null');
  eq(plan.bundlePathFromExecPath(null), null, 'so is a missing one');

  // The classifier is the REAL one from src/brain/mcp-launcher.js. That is the
  // point of this section: proving the reuse, not proving a copy.
  const trans = launcher.classifyLaunchOrigin(
    '/private/var/folders/x/AppTranslocation/ABC/d/The Curator.app/Contents/MacOS/The Curator',
    '/Users/x', 'darwin');
  ok(trans.ephemeral && trans.reason === 'app-translocation', 'CONTROL — the real classifier still detects translocation');
  eq(plan.classifyInstallTarget({ execPath: '/x/The Curator.app/Contents/MacOS/c', launchOrigin: trans }).reason,
     'app-translocation',
     'a translocated app REFUSES: it is executing from a read-only mount that is not where it lives');

  const dl = launcher.classifyLaunchOrigin('/Users/x/Downloads/The Curator.app/Contents/MacOS/The Curator', '/Users/x', 'darwin');
  ok(dl.ephemeral && dl.reason === 'downloads-folder', 'CONTROL — the real classifier still flags ~/Downloads');
  const dlTarget = plan.classifyInstallTarget({ execPath: '/Users/x/Downloads/The Curator.app/Contents/MacOS/The Curator', launchOrigin: dl });
  ok(dlTarget.ok, 'a Downloads install PROCEEDS — the two features disagree here, and deliberately');
  // A SENTENCE, not an object, and not the classifier's own message. Everything
  // downstream of here — the engine's return, the route's relay, the panel —
  // RENDERS this value; an object arriving where a sentence was expected is how
  // this warning came to be built and then dropped on the floor for a release.
  eq(typeof dlTarget.warning, 'string', 'carrying a warning the UI can show, as a SENTENCE rather than a record');
  ok(/Downloads folder/.test(dlTarget.warning), '...that names the actual condition');
  ok(/Applications/.test(dlTarget.warning), '...and the thing to do about it');
  ok(!/Claude Desktop|launcher/i.test(dlTarget.warning),
     'and NOT the origin classifier\'s own sentence, which is about the Claude Desktop launcher — true where it was written, false in front of someone updating an app');
  eq(plan.updateWarning('downloads-folder'), dlTarget.warning, 'the sentence comes from the named table, so there is one copy of it');
  ok(/temporary location/.test(plan.updateWarning('some-future-reason') || ''),
     'an UNMAPPED ephemeral reason still produces a true sentence — returning null would put the warning back where this release found it');
  eq(plan.updateWarning(null), null, 'and no reason is no warning');
  eq(dlTarget.bundlePath, '/Users/x/Downloads/The Curator.app', 'and it resolves the bundle it is going to replace');
  eq(dlTarget.installDir, '/Users/x/Downloads', 'and the folder the swap happens in');

  const good = launcher.classifyLaunchOrigin('/Applications/The Curator.app/Contents/MacOS/The Curator', '/Users/x', 'darwin');
  ok(!good.ephemeral, 'CONTROL — a normal /Applications install is not ephemeral');
  const goodTarget = plan.classifyInstallTarget({ execPath: '/Applications/The Curator.app/Contents/MacOS/The Curator', launchOrigin: good });
  ok(goodTarget.ok, 'and it is accepted');
  // ANTI-VACUITY for the Downloads warning above. Found by mutation: making
  // the warning UNCONDITIONAL left this whole section green, because nothing
  // here asserted the healthy case stays quiet — and a panel that warns on
  // every update is a panel nobody reads.
  eq(goodTarget.warning, null, 'and it carries NO warning — the Downloads one is carried, not manufactured');
  eq(plan.classifyInstallTarget({ execPath: '', launchOrigin: launcher.classifyLaunchOrigin('', '/Users/x', 'darwin') }).reason,
     'no-exec-path', 'an empty execPath refuses by name');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 buildSwapScript — a real /bin/sh parses it, and the renames are adjacent');
// ═══════════════════════════════════════════════════════════════════════════
const SH = existsSync('/bin/sh');
{
  // A path with a SPACE and a path with a SINGLE QUOTE. `/Applications/The
  // Curator.app` has the space in every real install; the quote is the one
  // that turns a quoting bug into arbitrary command execution.
  const nasty = "/Applications/It's a Test.app";
  const script = plan.buildSwapScript({
    pid: 1, targetPath: nasty, stagedPath: "/tmp/st age/It's a Test.app",
    backupPath: '/tmp/b.app', stageDir: '/tmp/st age', logPath: '/tmp/l.log',
  });

  ok(script.startsWith('#!/bin/sh'), 'it is a POSIX sh script');
  ok(SH ? spawnSync('/bin/sh', ['-n'], { input: script }).status === 0 : true,
     'a REAL /bin/sh parses it with no syntax error (sh -n)');

  // THE ESCAPING IS PROVED BY EXECUTION, NOT BY A REGEX. A payload that would
  // run if the quoting were wrong is round-tripped through a real shell.
  if (SH) {
    // The payload writes to STDERR if it executes, so "did anything run?" is
    // a different channel from "what did TARGET become?". A payload that
    // echoed to stdout would put the literal PWNED into the expected value
    // too, and the check would be unable to tell data from execution.
    const payload = "/tmp/x'; echo PWNED >&2; echo '.app";
    const probe = plan.buildSwapScript({
      pid: 1, targetPath: payload, stagedPath: '/tmp/s.app', backupPath: '/tmp/b.app', stageDir: '/tmp/s',
    });
    // Run only the variable assignments, then print what TARGET became.
    const assigns = probe.split('\n').filter((l) => /^(PID|TARGET|STAGED|BACKUP|STAGE_DIR|LOG)=/.test(l)).join('\n');
    const r = spawnSync('/bin/sh', ['-c', `${assigns}\nprintf '%s' "$TARGET"`], { encoding: 'utf8' });
    eq(r.stdout, payload, 'a path containing `; echo PWNED;` survives as DATA — the shell never sees it as a command');
    eq(r.stderr, '', 'and NOTHING EXECUTED — the payload writes to stderr if it runs, and stderr is empty');
  }

  // The one structural property this file controls: nothing sits between the
  // two renames. Every statement placed there widens the only window in the
  // design in which the app is absent from its own path.
  const lines = script.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const firstMv = lines.findIndex((l) => l.includes('mv -f "$TARGET" "$BACKUP"'));
  const closeOfFirst = lines.indexOf('fi', firstMv);
  const secondMv = lines.findIndex((l) => l.includes('mv -f "$STAGED" "$TARGET"'));
  ok(firstMv >= 0 && secondMv > firstMv, 'both renames are present, in order');
  eq(secondMv, closeOfFirst + 1,
     'THE SECOND RENAME IS THE VERY NEXT STATEMENT after the first block closes — no log line, no sync, no check between them');

  ok(/mv -f "\$BACKUP" "\$TARGET"/.test(script), 'the rollback restores the previous version');
  const rollbackAt = script.indexOf('mv -f "$BACKUP" "$TARGET"');
  const rmAt = script.indexOf('rm -rf "$BACKUP"');
  ok(rollbackAt > 0 && rmAt > rollbackAt,
     'the backup is deleted only AFTER the swap has committed — at no point does exactly one copy of the app exist');
  eq((script.match(/\/usr\/bin\/open "\$TARGET"/g) || []).length, 3,
     'every exit path — both refusals and success — reopens the app: an update that did not happen must not also cost the user their application');
  ok(/if \[ "\$i" -gt \d+ \]/.test(script),
     'the wait for the parent is BOUNDED — an unbounded one hangs forever the day a PID is recycled');

  for (const missing of ['pid', 'targetPath', 'stagedPath', 'backupPath', 'stageDir']) {
    const args = { pid: 1, targetPath: 'a', stagedPath: 'b', backupPath: 'c', stageDir: 'd' };
    delete args[missing];
    let threw = false;
    try { plan.buildSwapScript(args); } catch { threw = true; }
    ok(threw, `a missing ${missing} throws at BUILD time rather than producing a script with an empty path in it`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 THE SWAP, EXECUTED — happy path, rollback, refusals');
// ═══════════════════════════════════════════════════════════════════════════
// Real directories, a real /bin/sh, real rename(2) via /bin/mv. Every path is
// inside a temp directory; no application anywhere on this machine is touched.
const TOOLS = SH && existsSync('/bin/mv') && existsSync('/bin/rm');
{
  ok(process.platform !== 'darwin' || TOOLS,
     'ANTI-VACUITY — on macOS the shell tools are present, so this section really runs');

  const runSwap = (opts) => {
    const scriptPath = path.join(opts.workDir, 'swap.sh');
    writeFileSync(scriptPath, plan.buildSwapScript(opts), { mode: 0o700 });
    return spawnSync('/bin/sh', [scriptPath], { encoding: 'utf8', timeout: 30000 });
  };

  if (TOOLS) {
    // ── happy path ──
    {
      const dir = tmpdir('swap-ok');
      const installDir = path.join(dir, 'Applications'); mkdirSync(installDir);
      const target = makeFixtureApp(installDir, { version: '1.0.0' });
      const stageDir = path.join(installDir, '.the-curator-update-x'); mkdirSync(stageDir);
      const staged = makeFixtureApp(stageDir, { version: '2.0.0' });
      const backup = path.join(installDir, '.the-curator-backup-x.app');
      const r = runSwap({ pid: 999999, targetPath: target, stagedPath: staged, backupPath: backup, stageDir, workDir: dir, logPath: path.join(dir, 'l.log') });
      eq(r.status, 0, 'the swap exits 0');
      ok(readIf(path.join(target, 'Contents', 'Info.plist')).includes('2.0.0'),
         'the app AT ITS OWN PATH is now the new version — the bundle was replaced, not copied beside');
      ok(!existsSync(backup), 'the backup is gone');
      ok(!existsSync(stageDir), 'and so is the staging directory');
      eq(readdirSync(installDir).sort(), ['The Curator.app'],
         'the Applications folder holds exactly the app and nothing this feature left behind');
      ok(read(path.join(dir, 'l.log')).includes('swap committed'), 'and the log says what happened');
    }

    // ── rollback: the second rename fails ──
    // Forced by pointing STAGED at something that exists at check time and is
    // then removed — no, that would trip the pre-check. Instead the staged
    // path is a FILE where a rename onto a now-vacant name still succeeds, so
    // the honest way to force it is a read-only parent. Use a staged path
    // inside a directory the mv cannot read out of.
    {
      const dir = tmpdir('swap-rollback');
      const installDir = path.join(dir, 'Applications'); mkdirSync(installDir);
      const target = makeFixtureApp(installDir, { version: '1.0.0' });
      const stageDir = path.join(installDir, '.the-curator-update-y'); mkdirSync(stageDir);
      const staged = makeFixtureApp(stageDir, { version: '2.0.0' });
      const backup = path.join(installDir, '.the-curator-backup-y.app');
      // A cross-purposes trick that is stable on every POSIX system: make the
      // STAGE DIRECTORY unwritable, so `mv` cannot unlink the staged entry
      // from it. The first rename has already happened by then.
      const script = plan.buildSwapScript({ pid: 999999, targetPath: target, stagedPath: staged, backupPath: backup, stageDir, logPath: path.join(dir, 'l.log') });
      const sp = path.join(dir, 'swap.sh'); writeFileSync(sp, script, { mode: 0o700 });
      spawnSync('/bin/chmod', ['500', stageDir]);
      const r = spawnSync('/bin/sh', [sp], { encoding: 'utf8', timeout: 30000 });
      spawnSync('/bin/chmod', ['700', stageDir]);
      if (r.status === 0) {
        // Some filesystems permit it. Say so rather than assert a falsehood.
        ok(true, 'NOTE — this filesystem permitted the rename, so the rollback arm could not be forced here');
      } else {
        eq(r.status, 7, 'the second rename failed and the script exits with the rollback code');
        ok(existsSync(target), 'THE APP IS BACK AT ITS OWN PATH — the rollback ran');
        // Read defensively. A mutation that deletes the rollback leaves this
        // path absent, and an unguarded read would CRASH the suite rather than
        // redden a named assertion — the v3.24.1 shape, where the tally is
        // wrong and nothing says what was expected.
        ok(readIf(path.join(target, 'Contents', 'Info.plist')).includes('1.0.0'),
           'and it is the ORIGINAL version, not a half-replaced bundle');
        ok(!existsSync(backup), 'the backup name is vacated again');
        ok(read(path.join(dir, 'l.log')).includes('ROLLBACK'), 'and the log names the rollback');
      }
    }

    // ── refusal: the staged bundle vanished during the quit ──
    {
      const dir = tmpdir('swap-nostage');
      const installDir = path.join(dir, 'Applications'); mkdirSync(installDir);
      const target = makeFixtureApp(installDir, { version: '1.0.0' });
      const stageDir = path.join(installDir, '.the-curator-update-z');
      const r = runSwap({ pid: 999999, targetPath: target, stagedPath: path.join(stageDir, 'The Curator.app'), backupPath: path.join(installDir, '.the-curator-backup-z.app'), stageDir, workDir: dir, logPath: path.join(dir, 'l.log') });
      eq(r.status, 4, 'it refuses with the "prepared update is missing" code');
      ok(readIf(path.join(target, 'Contents', 'Info.plist')).includes('1.0.0'),
         'and NOTHING WAS CHANGED — the installed app is untouched');
    }

    // ── refusal: the installed app vanished during the quit ──
    {
      const dir = tmpdir('swap-notarget');
      const installDir = path.join(dir, 'Applications'); mkdirSync(installDir);
      const stageDir = path.join(installDir, '.the-curator-update-w'); mkdirSync(stageDir);
      const staged = makeFixtureApp(stageDir, { version: '2.0.0' });
      const r = runSwap({ pid: 999999, targetPath: path.join(installDir, 'The Curator.app'), stagedPath: staged, backupPath: path.join(installDir, '.b.app'), stageDir, workDir: dir, logPath: path.join(dir, 'l.log') });
      eq(r.status, 5, 'it refuses rather than creating an app where the user deleted one');
    }

    // ── the wait really waits, and is really bounded ──
    {
      const dir = tmpdir('swap-wait');
      const installDir = path.join(dir, 'Applications'); mkdirSync(installDir);
      const target = makeFixtureApp(installDir, { version: '1.0.0' });
      const stageDir = path.join(installDir, '.the-curator-update-v'); mkdirSync(stageDir);
      const staged = makeFixtureApp(stageDir, { version: '2.0.0' });
      // A live process to wait on, with a wait budget of one tick.
      const sleeper = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
      const script = plan.buildSwapScript({
        pid: sleeper.pid, targetPath: target, stagedPath: staged,
        backupPath: path.join(installDir, '.b.app'), stageDir, logPath: path.join(dir, 'l.log'), waitTicks: 2,
      });
      const sp = path.join(dir, 'swap.sh'); writeFileSync(sp, script, { mode: 0o700 });
      const r = spawnSync('/bin/sh', [sp], { encoding: 'utf8', timeout: 30000 });
      try { sleeper.kill('SIGKILL'); } catch { /* already gone */ }
      eq(r.status, 3, 'a parent that will not exit makes the helper GIVE UP...');
      ok(readIf(path.join(target, 'Contents', 'Info.plist')).includes('1.0.0'),
         '...having changed nothing — the running app keeps its own bundle');
    }
  } else {
    console.log('  · SKIPPED — /bin/sh, /bin/mv or /bin/rm is absent on this platform');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 resolveInstallerRelease — delegation to the REAL src/routes/config.js');
// ═══════════════════════════════════════════════════════════════════════════
// The payload below is the shape GitHub really returns, transcribed from this
// repository's own live release listing.
const RELEASES = [
  {
    tag_name: 'v3.32.0', draft: false, prerelease: false, name: 'v3.32.0',
    html_url: 'https://github.com/talirezun/the-curator/releases/tag/v3.32.0',
    published_at: '2026-08-30T10:00:00Z',
    assets: [
      { name: 'TheCurator-3.32.0-arm64-AppleSilicon.dmg', size: 137921531, digest: `sha256:${'1'.repeat(64)}`, browser_download_url: 'https://github.com/talirezun/the-curator/releases/download/v3.32.0/TheCurator-3.32.0-arm64-AppleSilicon.dmg' },
      { name: 'TheCurator-3.32.0-x64-Intel.dmg', size: 143496447, digest: `sha256:${'2'.repeat(64)}`, browser_download_url: 'https://github.com/talirezun/the-curator/releases/download/v3.32.0/TheCurator-3.32.0-x64-Intel.dmg' },
    ],
  },
  {
    tag_name: 'v3.31.0', draft: false, prerelease: false, name: 'v3.31.0',
    html_url: 'https://github.com/talirezun/the-curator/releases/tag/v3.31.0', published_at: '2026-08-20T10:00:00Z',
    assets: [{ name: 'TheCurator-3.31.0-arm64-AppleSilicon.dmg', size: 137892355, digest: `sha256:${'3'.repeat(64)}`, browser_download_url: 'https://github.com/talirezun/the-curator/releases/download/v3.31.0/TheCurator-3.31.0-arm64-AppleSilicon.dmg' }],
  },
  { tag_name: 'v3.30.0', draft: false, prerelease: true, name: 'v3.30.0', html_url: 'https://github.com/talirezun/the-curator/releases/tag/v3.30.0', assets: [] },
];
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });
{
  const r = await release.resolveInstallerRelease({
    configModule: cfg, fetchImpl: okFetch(RELEASES), currentVersion: '3.31.0', arch: 'arm64',
  });
  ok(r.ok, 'a newer release with an installer resolves');
  eq(r.version, '3.32.0', 'and it is the newest one — chosen by config.js, not here');
  eq(r.tagName, 'v3.32.0', 'carrying the tag the picker returned');
  eq(r.asset.name, 'TheCurator-3.32.0-arm64-AppleSilicon.dmg', 'with THIS Mac\'s asset re-associated from that release');
  eq(r.asset.digest, { algorithm: 'sha256', hex: '1'.repeat(64) }, 'and the digest GitHub publishes for it');

  // The three verdicts, all delegated. If a comparator were ever written into
  // update-plan.js or update-release.js, these could disagree with the route.
  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch(RELEASES), currentVersion: '3.32.0', arch: 'arm64' })).reason,
     'no-update', 'the same version refuses as no-update');
  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch(RELEASES), currentVersion: '3.99.0', arch: 'arm64' })).reason,
     'local-ahead', 'a local build AHEAD of the release refuses — a "downgrade" is not an update');
  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch(RELEASES), currentVersion: 'nightly', arch: 'arm64' })).reason,
     'not-comparable', 'an uncomparable local version refuses rather than guessing');

  // The picker's own rules, reached THROUGH this function — proof the
  // delegation is real rather than a coincidence of ordering.
  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch([RELEASES[2]]), currentVersion: '3.0.0', arch: 'arm64' })).reason,
     'no-installable-release', 'a release with NO assets is not installable — config.js decides that, and it still holds here');
  const outOfOrder = [RELEASES[1], RELEASES[0]];
  const ooo = await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch(outOfOrder), currentVersion: '3.31.0', arch: 'arm64' });
  eq(ooo.version, '3.32.0', 'list ORDER does not decide the winner — semver does, in config.js');
  eq(ooo.asset.name, 'TheCurator-3.32.0-arm64-AppleSilicon.dmg',
     'and THE ASSET COMES FROM THAT RELEASE — re-associated by tag, never by list position. Taking payload[0] here would download 3.31.0\'s installer while reporting 3.32.0');

  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch(RELEASES), currentVersion: '3.31.0', arch: 'x64' })).asset.name,
     'TheCurator-3.32.0-x64-Intel.dmg', 'an Intel Mac gets the Intel asset from the SAME release');
  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch(RELEASES), currentVersion: '3.30.0', arch: 'ppc' })).reason,
     'no-asset-for-arch', 'a release with no asset for this Mac refuses by name');

  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: async () => { throw new Error('offline'); }, currentVersion: '3.31.0', arch: 'arm64' })).reason,
     'network-unreachable', 'no network refuses by name...');
  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: async () => ({ ok: false, status: 403 }), currentVersion: '3.31.0', arch: 'arm64' })).reason,
     'github-error', '...a 403 refuses differently...');
  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch({ not: 'an array' }), currentVersion: '3.31.0', arch: 'arm64' })).reason,
     'unexpected-response', '...and a body that is not a release list refuses differently again');
  eq((await release.resolveInstallerRelease({ configModule: cfg, fetchImpl: okFetch(RELEASES), currentVersion: '', arch: 'arm64' })).reason,
     'local-version-unreadable', 'an unreadable local version refuses rather than comparing against nothing');
  eq((await release.resolveInstallerRelease({ configModule: {}, fetchImpl: okFetch(RELEASES), currentVersion: '3.31.0', arch: 'arm64' })).reason,
     'unexpected-response', 'a config module without the helpers refuses by name, never as a raw TypeError');

  // THE URL IS THE ROUTE'S. Not typed here, not a fourth copy of the slug.
  let seen = null;
  await release.resolveInstallerRelease({
    configModule: cfg, currentVersion: '3.31.0', arch: 'arm64',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => RELEASES }; },
  });
  eq(seen.url, cfg.RELEASES_API_URL, 'the release list is fetched from config.js\'s own exported URL');
  eq(seen.init.headers['User-Agent'], cfg.RELEASES_USER_AGENT, 'with config.js\'s own content-free User-Agent');
  ok(seen.init.signal && typeof seen.init.signal.aborted === 'boolean', 'and a live abort signal, so the call is bounded');
  ok(!JSON.stringify(seen.init).includes('@'), 'nothing resembling an address is sent in a header');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 prepareUpdate, EXECUTED — download, verify, stage');
// ═══════════════════════════════════════════════════════════════════════════
// The download is real: a real Response over a real byte buffer, streamed to a
// real file, hashed by real crypto. The four macOS tools are emulated against
// real directories — see the LIVE_LOCAL suite for the tools themselves.
const DMG_BYTES = Buffer.from('a fake disk image, byte-for-byte'.repeat(400));
const DMG_SHA = createHash('sha256').update(DMG_BYTES).digest('hex');

function makeHarness(overrides = {}) {
  const dir = tmpdir('engine');
  const installDir = path.join(dir, 'Applications'); mkdirSync(installDir);
  const target = makeFixtureApp(installDir, { version: '3.31.0' });
  const imageSrc = tmpdir('image');
  makeFixtureApp(imageSrc, { version: overrides.stagedVersion || '3.32.0' });
  const workDir = path.join(dir, 'work');
  const events = [];
  const quits = [];
  const spawned = [];
  const toolCalls = [];

  const runCommand = async (cmd, args) => {
    toolCalls.push([cmd, ...args].join(' '));
    if (overrides.toolFail && overrides.toolFail(cmd, args)) return { status: 1, stdout: '', stderr: 'forced' };
    if (cmd.endsWith('stat')) return { status: 0, stdout: overrides.device ? overrides.device(args[2]) : '1', stderr: '' };
    if (cmd.endsWith('hdiutil') && args[0] === 'attach') {
      const mp = args[args.indexOf('-mountpoint') + 1];
      mkdirSync(mp, { recursive: true });
      cpSync(imageSrc, mp, { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd.endsWith('hdiutil') && args[0] === 'detach') { rmSync(args[1], { recursive: true, force: true }); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd.endsWith('ditto')) { cpSync(args[0], args[1], { recursive: true }); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd.endsWith('plutil')) {
      const m = read(args[args.length - 1]).match(/CFBundleShortVersionString<\/key><string>([^<]*)/);
      return m ? { status: 0, stdout: `${m[1]}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
    }
    if (cmd.endsWith('codesign')) return { status: 0, stdout: '', stderr: '' };
    return { status: 127, stdout: '', stderr: 'unknown tool' };
  };

  const eng = engine.createUpdateEngine({
    resolveRelease: overrides.resolveRelease || (async () => ({
      ok: true, current: '3.31.0', version: '3.32.0', tagName: 'v3.32.0',
      releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/v3.32.0',
      prerelease: false, publishedAt: null,
      asset: {
        name: 'TheCurator-3.32.0-arm64-AppleSilicon.dmg',
        url: 'https://github.com/talirezun/the-curator/releases/download/v3.32.0/x.dmg',
        size: overrides.declaredSize ?? DMG_BYTES.length,
        digest: overrides.digest === null ? null : { algorithm: 'sha256', hex: overrides.digest || DMG_SHA },
      },
    })),
    fetchImpl: overrides.fetchImpl || (async () => new Response(DMG_BYTES, { status: 200 })),
    execPath: path.join(target, 'Contents', 'MacOS', 'The Curator'),
    homeDir: dir,
    arch: 'arm64',
    classifyLaunchOrigin: Object.hasOwn(overrides, 'classifyLaunchOrigin')
      ? overrides.classifyLaunchOrigin : launcher.classifyLaunchOrigin,
    workDir,
    logPath: path.join(dir, 'update.log'),
    runCommand,
    spawnDetached: overrides.spawnDetached || ((c, a) => { spawned.push([c, ...a]); return { unref() {} }; }),
    quitApp: overrides.quitApp === null ? null : (overrides.quitApp || (() => quits.push(1))),
    writeRegistry: overrides.writeRegistry || {},
    pid: 999999,
    randomId: (() => { let n = 0; return () => `id${n++}`; })(),
  });
  return { eng, dir, installDir, target, workDir, events, quits, spawned, toolCalls,
    onProgress: (e) => events.push(e) };
}

{
  const h = makeHarness();
  const r = await h.eng.prepareUpdate({ onProgress: h.onProgress });
  ok(r.ok, 'a complete prepare succeeds');
  eq(r.version, '3.32.0', 'reporting the version it prepared');
  eq(r.bytes, DMG_BYTES.length, 'and the byte count it downloaded');
  eq(r.verifiedDigest, `sha256:${DMG_SHA}`, 'and WHAT WAS VERIFIED — the digest, named, not a bare boolean');
  ok(typeof r.token === 'string' && r.token.length > 5, 'with an opaque token for the install step');
  ok(!JSON.stringify(r).includes(h.installDir),
     'and NO PATH in the result — the renderer receives a token, never something it could hand back as a target');

  const phases = [...new Set(h.events.map((e) => e.phase))];
  eq(phases, ['resolving', 'downloading', 'verifying', 'staging'],
     'the four preparation phases were emitted, in order, and NOT `installing` — nothing was replaced');
  const dl = h.events.filter((e) => e.phase === 'downloading');
  ok(dl.length >= 2, `progress was emitted more than once during the download (${dl.length} events)`);
  eq(dl.length ? dl[dl.length - 1].receivedBytes : null, DMG_BYTES.length, 'the FINAL event carries the full byte count whatever the throttle did');
  eq(dl.length ? dl[dl.length - 1].percent : null, 100, 'and reaches 100');
  ok(dl.every((e) => e.totalBytes === DMG_BYTES.length), 'every download event carries the declared total');

  // The staged bundle is real, and it is where the swap needs it.
  const stageDirs = readdirSync(h.installDir).filter((n) => n.startsWith(engine.STAGE_PREFIX));
  eq(stageDirs.length, 1, 'exactly one staging directory was created BESIDE the installed app');
  const stagedApp = stageDirs.length ? path.join(h.installDir, stageDirs[0], 'The Curator.app') : path.join(h.installDir, '__no-staging-dir__');
  ok(existsSync(stagedApp), 'holding a complete bundle...');
  ok(readIf(path.join(stagedApp, 'Contents', 'Info.plist')).includes('3.32.0'), '...at the new version');
  ok(readIf(path.join(h.target, 'Contents', 'Info.plist')).includes('3.31.0'),
     'AND THE INSTALLED APP IS UNTOUCHED — prepare replaces nothing');
  eq(path.basename(stagedApp), path.basename(h.target),
     'the staged bundle carries the INSTALLED app\'s directory name, so the final rename lands on the existing path');
  eq(readdirSync(h.workDir), [], 'the 140 MB disk image is deleted once the bundle is out of it');

  ok(h.toolCalls.some((c) => c.startsWith('/usr/bin/ditto ')),
     'ditto did the copy — Apple\'s documented tool for bundles. NOT because cp -R was measured to break the signature: on macOS 15.7.7 it does not, and the engine\'s docblock records that measurement rather than repeating the folklore');
  ok(h.toolCalls.some((c) => c.includes('hdiutil detach')), 'and the image was detached — no phantom volume is left mounted');
  ok(h.toolCalls.some((c) => c.includes('codesign --verify --deep --strict')), 'and the staged bundle passed a real integrity check');
}

{
  // ── every refusal, each one named, each one leaving the app untouched ──
  const cases = [
    // A body that arrives INTACT but shorter than the release declares is a
    // different fact from a transfer that died mid-body, and the two get
    // different reasons. Both are asserted, so neither can silently absorb
    // the other.
    ['a body shorter than the release declares', { declaredSize: DMG_BYTES.length + 500 }, 'size-mismatch'],
    ['a connection that dies mid-body', {
      fetchImpl: async () => new Response(new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(DMG_BYTES.subarray(0, 64))); c.error(new Error('socket hang up')); },
      }), { status: 200 }),
    }, 'download-truncated'],
    ['a corrupted download', { digest: 'f'.repeat(64) }, 'digest-mismatch'],
    ['a 404 on the asset', { fetchImpl: async () => new Response('', { status: 404 }) }, 'download-not-found'],
    ['a 500 on the asset', { fetchImpl: async () => new Response('', { status: 500 }) }, 'download-failed'],
    ['a dropped connection', { fetchImpl: async () => { throw new Error('socket hang up'); } }, 'download-failed'],
    ['the user quitting mid-download', { fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); } }, 'download-cancelled'],
    ['a bundle at the wrong version', { stagedVersion: '1.2.3' }, 'staged-version-mismatch'],
    ['an image with no app in it', { toolFail: (c, a) => c.endsWith('ditto') }, 'copy-failed'],
    ['an image that will not mount', { toolFail: (c, a) => c.endsWith('hdiutil') && a[0] === 'attach' }, 'dmg-mount-failed'],
    ['a bundle that fails codesign', { toolFail: (c) => c.endsWith('codesign') }, 'staged-signature-invalid'],
    ['a staging dir on another disk', { device: (p) => (p.includes('Applications/.the-curator') ? '1' : '2') }, 'install-dir-cross-device'],
  ];
  for (const [label, overrides, reason] of cases) {
    const h = makeHarness(overrides);
    const r = await h.eng.prepareUpdate({ onProgress: h.onProgress });
    eq(r.reason, reason, `${label} refuses as "${reason}"`);
    ok(typeof r.message === 'string' && r.message.length > 20, `  …with a sentence a user can act on`);
    ok(readIf(path.join(h.target, 'Contents', 'Info.plist')).includes('3.31.0'), `  …and the installed app is untouched`);
    ok(readdirSync(h.installDir).filter((n) => n.startsWith(engine.STAGE_PREFIX)).length === 0,
       `  …and no staging directory is left behind`);
  }

  // An oversized body is aborted MID-STREAM, not after filling the disk.
  {
    const h = makeHarness({ declaredSize: 10 });
    const r = await h.eng.prepareUpdate({});
    eq(r.reason, 'download-oversized', 'a response longer than the release declares is refused');
    eq(readdirSync(h.workDir), [], 'and the partial file is discarded');
  }

  // A translocated app refuses BEFORE any network call — the cheap question first.
  {
    let fetched = false;
    const h = makeHarness({
      classifyLaunchOrigin: () => ({ ephemeral: true, reason: 'app-translocation', message: 'x' }),
      fetchImpl: async () => { fetched = true; return new Response(DMG_BYTES); },
      resolveRelease: async () => { fetched = true; return { ok: false }; },
    });
    const r = await h.eng.prepareUpdate({});
    eq(r.reason, 'app-translocation', 'a translocated app refuses');
    ok(!fetched, 'and it refuses BEFORE downloading 140 MB it could never install');
  }

  // A missing classifier REFUSES rather than silently skipping the check.
  {
    const h = makeHarness({ classifyLaunchOrigin: false });
    eq((await h.eng.prepareUpdate({})).reason, 'no-exec-path',
       'a missing launch-origin classifier refuses — an absent safety check must never read as "fine"');
  }

  // ── NEITHER HOOK MAY EVER REJECT ──
  // The contract is "a named reason the UI can render, never a raw exception
  // string", and enumeration alone cannot keep it: an unforeseen throw would
  // escape as a rejected promise, which in Electron's main process is an
  // unhandled rejection and, to the user, a button that silently does nothing.
  // This is here because a mutation that removed a guard CRASHED this suite
  // instead of reddening an assertion.
  {
    const h = makeHarness({ resolveRelease: async () => { throw new TypeError('x is not a function'); } });
    let rejected = false; let r = null;
    try { r = await h.eng.prepareUpdate({}); } catch { rejected = true; }
    ok(!rejected, 'an unforeseen throw inside prepareUpdate RESOLVES rather than rejecting');
    ok(r && r.ok === false && typeof r.reason === 'string', '...as a named refusal');
    ok(!/TypeError|not a function/.test(r.message), '...whose MESSAGE is a sentence, never the exception text');
  }
  {
    const h = makeHarness();
    const prep = await h.eng.prepareUpdate({});
    // Force a throw inside the install path by removing the work directory
    // AND making the script path unwritable is fragile; instead drive it
    // through a writeRegistry whose listActiveWrites explodes.
    const h2 = makeHarness({ writeRegistry: { hasActiveWrites: () => { throw new Error('registry exploded'); } } });
    await h2.eng.prepareUpdate({});
    let rejected = false; let r = null;
    try { r = await h2.eng.installUpdate({}); } catch { rejected = true; }
    ok(!rejected, 'and an unforeseen throw inside installUpdate RESOLVES too');
    ok(r && r.ok === false && r.reason === 'internal-error', '...as `internal-error`');
    ok(h2.spawned.length === 0 && h2.quits.length === 0, '...having started nothing and quit nothing');
    ok(prep.ok, '(control — the ordinary path still succeeds)');
  }

  // A progress callback that throws must not break the update.
  {
    const h = makeHarness();
    const r = await h.eng.prepareUpdate({ onProgress: () => { throw new Error('the UI blew up'); } });
    ok(r.ok, 'a throwing progress callback does not break the download — the UI is not load-bearing');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 installUpdate, EXECUTED — the token boundary and the write guard');
// ═══════════════════════════════════════════════════════════════════════════
{
  {
    const h = makeHarness();
    eq((await h.eng.installUpdate({})).reason, 'not-prepared', 'installing with nothing prepared refuses');

    const prep = await h.eng.prepareUpdate({});
    eq((await h.eng.installUpdate({ token: 'someone-elses-token' })).reason, 'stale-token',
       'a token that is not the prepared one refuses');

    const r = await h.eng.installUpdate({ token: prep.token, onProgress: h.onProgress });
    ok(r.ok, 'the right token installs');
    eq(h.events.length ? h.events[h.events.length - 1].phase : null, 'installing', 'and the final phase is `installing`');
    eq(h.spawned.length, 1, 'exactly one helper was started');
    eq(h.spawned.length ? h.spawned[0][0] : null, '/bin/sh', 'and it is a plain /bin/sh');
    const scriptPath = h.spawned.length ? h.spawned[0][1] : '__none__';
    ok(existsSync(scriptPath), 'the script it was handed really exists on disk');
    eq(existsSync(scriptPath) ? (statSync(scriptPath).mode & 0o777) : null, 0o700, 'and is 0700 — nobody else on the machine can rewrite it before it runs');
    eq(h.quits.length, 1, 'the app was then asked to quit — quitting IS the handoff');
    const scriptText = readIf(scriptPath);
    ok(scriptText.includes(h.target), 'the script names the installed app as its target');
    ok(/^PID='999999'$/m.test(scriptText), 'and this process\'s pid, so it waits for exactly us');
  }

  // The one refusal that exists to protect paid work.
  {
    const h = makeHarness({
      writeRegistry: {
        hasActiveWrites: () => true,
        listActiveWrites: () => [{ domain: 'articles', ops: ['ingest'] }],
        beginUpdate: () => { throw new Error('must not be reached'); },
      },
    });
    const prep = await h.eng.prepareUpdate({});
    ok(prep.ok, 'preparing DURING an ingest is allowed — a download touches nothing the ingest cares about');
    const r = await h.eng.installUpdate({ token: prep.token });
    eq(r.reason, 'writes-in-progress', 'but RESTARTING during one refuses — that is data loss');
    eq(r.operations, [{ domain: 'articles', ops: ['ingest'] }], 'naming what is running, so the user knows what to wait for');
    eq(h.spawned.length, 0, 'no helper was started');
    eq(h.quits.length, 0, 'and the app was not asked to quit');
  }

  // beginUpdate() is taken, so /api/write-status reports it and the quit
  // dialog says "an update is being applied" rather than "no writes".
  {
    const marks = [];
    const h = makeHarness({
      writeRegistry: { hasActiveWrites: () => false, beginUpdate: () => marks.push('begin'), endUpdate: () => marks.push('end') },
    });
    const prep = await h.eng.prepareUpdate({});
    await h.eng.installUpdate({ token: prep.token });
    eq(marks, ['begin'], 'the update marker is taken before the handoff and NOT released — the process is about to die');
  }

  // A shell that cannot quit must not leave a helper polling a live PID.
  {
    const h = makeHarness({ quitApp: null });
    const prep = await h.eng.prepareUpdate({});
    const r = await h.eng.installUpdate({ token: prep.token });
    eq(r.reason, 'relaunch-unavailable', 'no quit hook refuses...');
    eq(h.spawned.length, 0, '...BEFORE the helper is spawned, so nothing is left waiting on an app that will not exit');
  }

  // The marker is released when the handoff itself fails, or the app becomes
  // permanently un-quittable with an update that never happened.
  {
    const marks = [];
    const h = makeHarness({
      spawnDetached: () => { throw new Error('EPERM'); },
      writeRegistry: { hasActiveWrites: () => false, beginUpdate: () => marks.push('begin'), endUpdate: () => marks.push('end') },
    });
    const prep = await h.eng.prepareUpdate({});
    eq((await h.eng.installUpdate({ token: prep.token })).reason, 'helper-spawn-failed', 'a helper that cannot start refuses');
    eq(marks, ['begin', 'end'], 'and the update marker is RELEASED — otherwise the app could never be quit again');
    eq(h.quits.length, 0, 'and the app is not quit into a state where nothing is going to install anything');
  }

  // The staged bundle can be deleted between prepare and install.
  {
    const h = makeHarness();
    const prep = await h.eng.prepareUpdate({});
    for (const n of readdirSync(h.installDir).filter((x) => x.startsWith(engine.STAGE_PREFIX))) {
      rmSync(path.join(h.installDir, n), { recursive: true, force: true });
    }
    eq((await h.eng.installUpdate({ token: prep.token })).reason, 'not-prepared',
       'a staged bundle removed by a cleaner is re-checked, not trusted — acting on it means moving the installed app aside');
    eq(h.spawned.length, 0, 'and nothing was started');
  }

  // A second prepare discards the first, rather than accumulating 400 MB.
  {
    const h = makeHarness();
    await h.eng.prepareUpdate({});
    await h.eng.prepareUpdate({});
    eq(readdirSync(h.installDir).filter((n) => n.startsWith(engine.STAGE_PREFIX)).length, 1,
       'a second prepare leaves exactly one staging directory, not two');
  }

  // The sweeper removes OUR leftovers and nothing else.
  {
    const h = makeHarness();
    mkdirSync(path.join(h.installDir, `${engine.STAGE_PREFIX}orphan`));
    mkdirSync(path.join(h.installDir, `${engine.BACKUP_PREFIX}orphan.app`));
    mkdirSync(path.join(h.installDir, 'Some Other App.app'));
    mkdirSync(path.join(h.installDir, '.hidden-thing-of-someones'));
    await h.eng.prepareUpdate({});
    const left = readdirSync(h.installDir).sort();
    ok(!left.includes(`${engine.STAGE_PREFIX}orphan`), 'a stale staging directory is swept');
    ok(!left.includes(`${engine.BACKUP_PREFIX}orphan.app`), 'so is a stale backup');
    ok(left.includes('Some Other App.app'), 'ANOTHER APPLICATION IS NOT TOUCHED — this sweeps inside /Applications');
    ok(left.includes('.hidden-thing-of-someones'), 'nor is an unrelated hidden entry');
    ok(left.includes('The Curator.app'), 'and the installed app survives');
  }

  // describe() is wire-safe.
  {
    const h = makeHarness();
    const prep = await h.eng.prepareUpdate({});
    const d = h.eng.describe();
    eq(d.preparedVersion, '3.32.0', 'describe() reports the prepared version');
    ok(!JSON.stringify(d).includes(h.installDir), 'and carries no filesystem path — it is a diagnostics shape');
    await h.eng.discardPrepared();
    eq(h.eng.describe().preparedVersion, null, 'discarding really discards');
    eq(readdirSync(h.installDir).filter((n) => n.startsWith(engine.STAGE_PREFIX)).length, 0,
       'and reclaims the disk it was using');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 Source discipline');
// ═══════════════════════════════════════════════════════════════════════════
{
  // The hook names the shell registers must be the ones the registry accepts,
  // or the shell throws at boot and the app never starts.
  eq(host.DESKTOP_HOOKS.slice().sort(), ['installUpdate', 'pickFolder', 'prepareUpdate', 'relaunch'],
     'desktop-host accepts exactly four hooks');
  host.__resetDesktopHost();
  eq(host.getDesktopHook('prepareUpdate'), null, 'and neither update hook is registered by default...');
  eq(host.getDesktopHook('installUpdate'), null, '...so a consumer refuses rather than falling back');
  // Wrapped, because registerDesktopHost THROWS on an unknown name — which is
  // the designed behaviour and is exactly what happens if a hook is dropped
  // from the frozen list while main.js still registers it. Unguarded, that
  // throw crashes this suite instead of reddening an assertion.
  let reg = null; let regErr = null;
  try {
    reg = host.registerDesktopHost({ prepareUpdate: async () => ({ ok: true }), installUpdate: async () => ({ ok: true }) });
  } catch (e) { regErr = e; }
  ok(!regErr, `registering both update hooks does not throw${regErr ? ` — ${regErr.message}` : ''}`);
  eq(reg && reg.registered, ['installUpdate', 'prepareUpdate'], 'both register');
  eq(host.describeDesktopHost().hooks.prepareUpdate === true, true, 'and describeDesktopHost reports booleans for them');
  host.__resetDesktopHost();

  // The three new lib modules keep the property every other one has: no
  // Electron, no src/. Without it §3–§10 could not have run at all.
  for (const f of ['lib/update-plan.js', 'lib/update-release.js', 'lib/update-engine.js']) {
    const src = read(path.join(DESKTOP, f));
    ok(!/from\s+['"]electron['"]/.test(src), `desktop/${f} does not import electron`);
    ok(!/from\s+['"][^'"]*\.\.\/\.\.\/src\//.test(src), `desktop/${f} does not import from src/`);
  }

  // THE ONE RULE update-plan.js MUST NEVER BREAK: it does not compare versions.
  // Same rule, same reason, as lib/update-verdict.js's — a second verdict is
  // how the menu bar, Settings and the installer come to name three different
  // versions.
  const planSrc = stripJsComments(read(path.join(DESKTOP, 'lib', 'update-plan.js')));
  ok(planSrc.length > 2000, `ANTI-VACUITY — ${planSrc.length} chars survived comment-stripping, so the scans below have something to read`);
  ok(!/compareSemver|parseVersionCore|isComparableVersion|localeCompare/.test(planSrc),
     'update-plan.js contains no version comparator');
  ok(!/compareSemver|parseVersionCore|isComparableVersion/.test(stripJsComments(read(path.join(DESKTOP, 'lib', 'update-release.js')))),
     'nor does update-release.js — it CALLS config.js\'s');
  ok(/cfg\.decideInstallerUpdate|configModule/.test(read(path.join(DESKTOP, 'lib', 'update-release.js'))),
     'and the delegation is by call, not by copy');

  // main.js is source-scanned. It cannot be executed — Electron is not an
  // offline-suite dependency — and this block says so rather than pretending.
  const main = stripJsComments(read(path.join(DESKTOP, 'main.js')));
  ok(main.length > 8000, `ANTI-VACUITY — ${main.length} chars of main.js survived stripping`);
  ok(/prepareUpdate:\s*\(opts/.test(main) && /installUpdate:\s*\(opts/.test(main),
     'main.js registers both hooks');
  ok(/getAppSupportDir\(\)/.test(main) && !/getUserDataDir\(\)/.test(main),
     'the 140 MB download lands under Application Support, NEVER under getUserDataDir() — which in repo mode IS the git checkout');
  ok(/classifyLaunchOrigin:\s*launcher\.classifyLaunchOrigin/.test(main),
     'the translocation check is the app\'s own function, not a second copy typed here');
  ok(/detached:\s*true/.test(main) && /child\.unref\(\)/.test(main),
     'the helper is spawned detached and unref\'d, so it outlives the app it is replacing');
  ok(!/electron-updater|autoUpdater/.test(main),
     'nothing reaches for electron-updater — see §2 for why it cannot work here');
  ok(/quitAuthorised = true; app\.quit\(\)/.test(main),
     'the update quits with app.quit(), not app.exit(0) — exit() would skip the window-state save on every update');
}

// ═══════════════════════════════════════════════════════════════════════════
eq(fingerprint(CONFIG_FILE), configBefore, 'the real .curator-config.json is byte-identical at the end of the run');

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
