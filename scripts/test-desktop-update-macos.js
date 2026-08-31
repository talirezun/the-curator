/**
 * test-desktop-update-macos.js — LIVE_LOCAL. The four macOS tools, for real.
 *
 * ── WHY THIS IS A SECOND FILE, AND WHY IT IS LIVE_LOCAL ─────────────────────
 *
 * `scripts/test-desktop-update.js` proves the ORCHESTRATION: it executes both
 * hooks end to end with `hdiutil`, `ditto`, `plutil` and `codesign` emulated
 * against real directories. That suite has to be OFFLINE, which means it has
 * to pass on the Linux runner, which means it can never invoke those four
 * commands — none of them exists there.
 *
 * So the tools get their own suite. It costs no money, makes no network call
 * and touches no user data, but it is macOS-only and it is therefore
 * LIVE_LOCAL, which `scripts/run-tests.js` excludes when `CI=true`. It
 * SELF-SKIPS with exit 0 off darwin, the same convention every other live
 * suite uses for a missing prerequisite.
 *
 * ── WHAT IS REAL HERE ───────────────────────────────────────────────────────
 *
 *   · a real application bundle, built on disk and AD-HOC SIGNED with the same
 *     `codesign --force --deep --sign -` the release build uses
 *   · a real `.dmg`, built by `hdiutil create`
 *   · the real `runCommand` from `desktop/main.js`'s shape — spawn, collect,
 *     never throw — driving the real `hdiutil attach`, `ditto`, `plutil` and
 *     `codesign --verify --deep --strict`
 *   · the real swap script, run by a real `/bin/sh`, against a real bundle
 *
 * ── WHAT IS NOT REAL, AND CANNOT BE ─────────────────────────────────────────
 *
 *   · THE NETWORK. The .dmg is served from disk through an injected fetch.
 *     Downloading 140 MB from GitHub in a test suite would be slow, flaky and
 *     pointless — §9 of the offline suite already proves the streaming, the
 *     hashing and every failure mode.
 *   · /Applications. Every path here is inside a temp directory. Nothing in
 *     this suite may ever replace an application on this Mac, and the fixture
 *     is deliberately not named after any real one.
 *   · LAUNCHING the swapped app. `open` is never run; the script's relaunch
 *     line is asserted to exist and is not executed.
 */

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');

if (process.platform !== 'darwin') {
  console.log('\n  · SKIPPED — this suite drives hdiutil / ditto / plutil / codesign, which exist only on macOS.\n');
  process.exit(0);
}

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

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-update-macos-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const plan = await import(path.join(DESKTOP, 'lib', 'update-plan.js'));
const engine = await import(path.join(DESKTOP, 'lib', 'update-engine.js'));
const launcher = await import(path.join(ROOT, 'src', 'brain', 'mcp-launcher.js'));

/**
 * The SAME shape `desktop/main.js` installs as `runCommand`: spawn, collect a
 * bounded amount of output, resolve a status, never throw. Copied rather than
 * imported because main.js cannot be imported without Electron — which is the
 * one honest gap in this suite, and it is stated in §0 rather than hidden.
 */
function runCommand(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (err) { resolve({ status: 127, stdout: '', stderr: String(err.message) }); return; }
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < 65536) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < 65536) stderr += d.toString(); });
    child.on('error', (err) => resolve({ status: 127, stdout, stderr: String(err.message) }));
    child.on('close', (code) => resolve({ status: typeof code === 'number' ? code : 1, stdout, stderr }));
  });
}

/** A real, ad-hoc-signed application bundle. `Fixture Curator.app`, never
 *  `The Curator.app` — nothing in this suite should be confusable with the
 *  maintainer's own installed application in a stack trace or a stray path. */
function buildSignedApp(at, version, name = 'Fixture Curator.app') {
  const app = path.join(at, name);
  mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(path.join(app, 'Contents', 'MacOS', 'Fixture Curator'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(app, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n' +
    '<key>CFBundleExecutable</key><string>Fixture Curator</string>\n' +
    '<key>CFBundleIdentifier</key><string>com.example.curator-fixture</string>\n' +
    `<key>CFBundleShortVersionString</key><string>${version}</string>\n` +
    `<key>CFBundleVersion</key><string>${version}</string>\n</dict></plist>\n`);
  const r = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app], { encoding: 'utf8' });
  return { app, signed: r.status === 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
section('§0 The fixture: a real signed bundle inside a real .dmg');
// ═══════════════════════════════════════════════════════════════════════════
const stage = path.join(TMP, 'image-src'); mkdirSync(stage, { recursive: true });
const { app: srcApp, signed } = buildSignedApp(stage, '3.32.0');
ok(signed, 'the fixture bundle is ad-hoc signed with the same command the release build uses');
ok(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', srcApp]).status === 0,
   'and it passes codesign --verify --deep --strict — the check the engine runs on the staged bundle');

const DMG = path.join(TMP, 'fixture.dmg');
{
  const r = spawnSync('/usr/bin/hdiutil',
    ['create', '-quiet', '-srcfolder', stage, '-volname', 'CuratorFixture', '-format', 'UDZO', DMG],
    { encoding: 'utf8' });
  ok(r.status === 0 && existsSync(DMG), `a real .dmg was built by hdiutil (${r.status === 0 ? statSync(DMG).size : '?'} bytes)`);
}
const DMG_BYTES = readFileSync(DMG);
const DMG_SHA = createHash('sha256').update(DMG_BYTES).digest('hex');
ok(DMG_BYTES.length > 1000, 'the image has real content to download');

// ═══════════════════════════════════════════════════════════════════════════
section('§1 prepareUpdate against the REAL macOS tools');
// ═══════════════════════════════════════════════════════════════════════════
function harness(overrides = {}) {
  const dir = path.join(TMP, `run-${Math.random().toString(36).slice(2, 8)}`);
  const installDir = path.join(dir, 'Applications');
  mkdirSync(installDir, { recursive: true });
  const { app: target } = buildSignedApp(installDir, '3.31.0');
  const events = []; const spawned = []; const quits = [];
  const eng = engine.createUpdateEngine({
    resolveRelease: async () => ({
      ok: true, current: '3.31.0', version: overrides.claimVersion || '3.32.0', tagName: 'v3.32.0',
      releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/v3.32.0', prerelease: false,
      asset: {
        name: 'TheCurator-3.32.0-arm64-AppleSilicon.dmg',
        url: 'https://github.com/talirezun/the-curator/releases/download/v3.32.0/x.dmg',
        size: DMG_BYTES.length, digest: { algorithm: 'sha256', hex: DMG_SHA },
      },
    }),
    // The bytes are real and the hashing is real; only the transport is local.
    fetchImpl: async () => new Response(DMG_BYTES, { status: 200 }),
    execPath: path.join(target, 'Contents', 'MacOS', 'Fixture Curator'),
    homeDir: dir,
    arch: 'arm64',
    classifyLaunchOrigin: launcher.classifyLaunchOrigin,
    workDir: path.join(dir, 'work'),
    logPath: path.join(dir, 'update.log'),
    runCommand,
    spawnDetached: (c, a) => { spawned.push([c, ...a]); return { unref() {} }; },
    quitApp: () => quits.push(1),
    writeRegistry: {},
    pid: 999999,
  });
  return { eng, dir, installDir, target, events, spawned, quits, onProgress: (e) => events.push(e) };
}

const h = harness();
{
  const r = await h.eng.prepareUpdate({ onProgress: h.onProgress });
  ok(r.ok, `a full prepare succeeded through hdiutil + ditto + plutil + codesign${r.ok ? '' : ` — ${r.reason}: ${r.detail || ''}`}`);
  if (r.ok) {
    eq(r.version, '3.32.0', 'the prepared version is the one the release named');
    eq(r.verifiedDigest, `sha256:${DMG_SHA}`, 'the sha256 was computed over the real image and matched');

    const stageDirs = readdirSync(h.installDir).filter((n) => n.startsWith(engine.STAGE_PREFIX));
    eq(stageDirs.length, 1, 'one staging directory beside the installed app');
    const stagedApp = path.join(h.installDir, stageDirs[0] || '__none__', 'Fixture Curator.app');
    ok(existsSync(stagedApp), 'holding the bundle ditto copied out of the mounted image');
    eq(path.basename(stagedApp), path.basename(h.target),
       'named for the INSTALLED app, so the final rename lands on the existing path');

    // The claim that justifies `ditto` over `cp -R`, measured on the real copy.
    ok(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]).status === 0,
       'THE COPIED BUNDLE STILL PASSES codesign --verify — ditto preserved the signature through the DMG round trip');
    const v = spawnSync('/usr/bin/plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(stagedApp, 'Contents', 'Info.plist')],
      { encoding: 'utf8' });
    eq(v.stdout.trim(), '3.32.0', 'and plutil reads the version the engine checked it against');

    // No mount survives the run.
    const mounts = spawnSync('/bin/sh', ['-c', 'mount | grep -c CuratorFixture || true'], { encoding: 'utf8' });
    eq(mounts.stdout.trim(), '0', 'NO DISK IMAGE IS LEFT MOUNTED — hdiutil detach ran on the way out');
    eq(readdirSync(path.join(h.dir, 'work')), [], 'and the downloaded image was deleted once the bundle was out of it');

    ok(existsSync(h.target) && readFileSync(path.join(h.target, 'Contents', 'Info.plist'), 'utf8').includes('3.31.0'),
       'THE INSTALLED APP IS UNTOUCHED — prepare replaces nothing');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 Quarantine — the real benefit, with the control that makes it real');
// ═══════════════════════════════════════════════════════════════════════════
// A browser download stamps `com.apple.quarantine` on the .dmg, and macOS
// propagates it to everything copied out of the mounted image — which is why a
// hand-installed build gets a Gatekeeper prompt, and, if the quarantine is not
// cleared, App Translocation. A programmatic download does NOT get the
// attribute, because it is applied by the DOWNLOADING application through
// LaunchServices, not by the kernel.
//
// So the swapped app launches with no prompt. That is asserted here in BOTH
// directions: an assertion that "our copy is clean" is worthless on its own,
// because it also passes on a machine where quarantine never happens at all.
{
  const hasQuarantine = (p) => {
    const r = spawnSync('/usr/bin/xattr', ['-lr', p], { encoding: 'utf8' });
    return /com\.apple\.quarantine/.test(r.stdout || '');
  };

  // POSITIVE CONTROL — a QUARANTINED image really does infect its contents.
  {
    const dir = path.join(TMP, 'quar-pos'); mkdirSync(dir, { recursive: true });
    const dmg = path.join(dir, 'q.dmg');
    writeFileSync(dmg, DMG_BYTES);
    spawnSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;00000000;Safari;', dmg]);
    const mnt = path.join(dir, 'mnt');
    const att = spawnSync('/usr/bin/hdiutil', ['attach', dmg, '-mountpoint', mnt, '-nobrowse', '-readonly', '-noverify', '-noautoopen', '-quiet']);
    if (att.status === 0) {
      const out = path.join(dir, 'out.app');
      spawnSync('/usr/bin/ditto', [path.join(mnt, 'Fixture Curator.app'), out]);
      spawnSync('/usr/bin/hdiutil', ['detach', mnt, '-quiet']);
      ok(hasQuarantine(out),
         'CONTROL — a bundle copied out of a QUARANTINED image IS quarantined, exactly as a hand-installed download is');
    } else {
      ok(false, `CONTROL could not run — hdiutil attach exited ${att.status}`);
    }
  }

  // THE CLAIM — the engine's own staged bundle, produced from an image this
  // process downloaded, carries no quarantine.
  {
    const stageDirs = readdirSync(h.installDir).filter((n) => n.startsWith(engine.STAGE_PREFIX));
    if (stageDirs.length) {
      const stagedApp = path.join(h.installDir, stageDirs[0] || '__none__', 'Fixture Curator.app');
      ok(!hasQuarantine(stagedApp),
         'THE STAGED BUNDLE IS NOT QUARANTINED — a programmatic download never gets the attribute, so the swapped app opens with no Gatekeeper prompt and is never translocated');
    } else {
      ok(false, 'no staged bundle to check');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 An unwritable install folder is DETECTED, not stumbled into');
// ═══════════════════════════════════════════════════════════════════════════
// `/Applications` is `drwxrwxr-x root:admin`, so a non-admin account or a
// managed Mac can make this the normal case. The engine does not ask
// `access(W_OK)` — ACLs and sandbox policy make that answer unreliable — it
// creates the real directory it needs and reports the real errno.
{
  const g = harness();
  spawnSync('/bin/chmod', ['500', g.installDir]);
  const r = await g.eng.prepareUpdate({});
  spawnSync('/bin/chmod', ['700', g.installDir]);
  eq(r.reason, 'install-dir-not-writable', 'a read-only install folder refuses by name');
  ok(/Applications folder|administers/.test(r.message), 'and the sentence tells the user what to do about it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 Same-device detection uses the REAL stat');
// ═══════════════════════════════════════════════════════════════════════════
// `mv` across devices is a copy, not a rename, and a 400 MB non-atomic copy is
// exactly the state the swap design exists to avoid. The check is a real
// `stat -f %d` on the two real directories.
{
  const a = await runCommand('/usr/bin/stat', ['-f', '%d', TMP]);
  const b = await runCommand('/usr/bin/stat', ['-f', '%d', os.tmpdir()]);
  eq(a.status, 0, 'stat -f %d runs');
  eq(a.stdout.trim(), b.stdout.trim(), 'and two directories on one volume report the same device id (anti-vacuity)');
  const root = await runCommand('/usr/bin/stat', ['-f', '%d', '/']);
  ok(root.status === 0 && root.stdout.trim().length > 0, 'and it answers for / too, so the comparison is over real values');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 THE SWAP, on a real signed bundle, by a real /bin/sh');
// ═══════════════════════════════════════════════════════════════════════════
{
  const g = harness();
  const prep = await g.eng.prepareUpdate({});
  ok(prep.ok, 'prepared');
  if (prep.ok) {
    const r = await g.eng.installUpdate({ token: prep.token });
    ok(r.ok, 'installUpdate handed off');
    eq(g.quits.length, 1, 'and asked the app to quit');
    const script = g.spawned[0][1];

    // The app never actually quit — this process is the "app". So the script
    // is run with the wait already satisfied, by pointing it at a pid that is
    // gone. Rebuilt rather than edited, from the same builder, so what runs
    // here is the real script shape and not a doctored one.
    const real = readFileSync(script, 'utf8');
    ok(/\/usr\/bin\/open "\$TARGET"/.test(real), 'the real script ends by reopening the app (not executed here)');

    const stageDirs = readdirSync(g.installDir).filter((n) => n.startsWith(engine.STAGE_PREFIX));
    ok(stageDirs.length === 1, 'a staging directory exists to swap in');
    const stagedApp = path.join(g.installDir, stageDirs[0] || '__none__', 'Fixture Curator.app');
    const rerun = path.join(g.dir, 'rerun.sh');
    writeFileSync(rerun, plan.buildSwapScript({
      pid: 999999999, // no such process — the wait falls through immediately
      targetPath: g.target,
      stagedPath: stagedApp,
      backupPath: path.join(g.installDir, `${engine.BACKUP_PREFIX}t.app`),
      stageDir: path.join(g.installDir, stageDirs[0]),
      logPath: path.join(g.dir, 'swap.log'),
      // The ONE thing swapped out for the test, and the reason is not
      // convenience: the real script ends in `/usr/bin/open "$TARGET"`, and a
      // suite that LAUNCHES an application on the maintainer's Mac — even a
      // fixture in a temp directory — is doing something no test should. The
      // real command is asserted to be present in the real script two
      // assertions above; here it is replaced with a no-op so that everything
      // BEFORE it can be executed for real.
      openCommand: '/usr/bin/true',
    }), { mode: 0o700 });
    const sw = spawnSync('/bin/sh', [rerun], { encoding: 'utf8', timeout: 60000 });

    eq(sw.status, 0, 'the swap script exits 0');
    ok(existsSync(g.target) && readFileSync(path.join(g.target, 'Contents', 'Info.plist'), 'utf8').includes('3.32.0'),
       'THE APP AT ITS OWN PATH IS NOW THE NEW VERSION — a real bundle was really replaced');
    ok(spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', g.target]).status === 0,
       'and the swapped-in bundle still passes codesign — rename(2) moved it without touching a byte');
    eq(readdirSync(g.installDir).sort(), ['Fixture Curator.app'],
       'nothing this feature created is left in the folder');
  }
}

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
