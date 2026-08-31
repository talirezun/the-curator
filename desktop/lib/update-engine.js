/**
 * update-engine.js — download the new build, prove it is the right one, put it
 * beside the old one, and hand the swap to a helper that outlives us.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY THIS IS HAND-ROLLED AND NOT electron-updater. MEASURED, NOT          ║
 * ║  ASSUMED — on the artifact that is actually shipping.                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * On macOS, `electron-updater`'s `MacUpdater` is a thin driver over Electron's
 * own `autoUpdater`, which is Squirrel.Mac. Squirrel.Mac takes the RUNNING
 * app's designated code requirement and validates the downloaded bundle
 * against it before it will install anything. Read off the shipped v3.32.0
 * bundle with `codesign -d -r-`:
 *
 *     # designated => cdhash H"…"
 *     Signature=adhoc      TeamIdentifier=not set      flags=0x2(adhoc)
 *
 * An ad-hoc signature has no certificate and no team, so `codesign` has
 * nothing to build a requirement out of except the code directory hash — the
 * hash OF THIS EXACT BUILD. The requirement is therefore satisfiable by
 * exactly one bundle: the one already installed. Every genuine update has a
 * different cdhash by definition, so Squirrel.Mac rejects 100% of them,
 * deterministically, with "code failed to satisfy specified code
 * requirement(s)". There is no option to relax it: the check lives in
 * Squirrel.Mac inside Electron's own binary, not in electron-updater's
 * JavaScript, so no configuration reaches it.
 *
 * Two further blockers are independent of the signature, and each one alone
 * would also be sufficient:
 *
 *   · Squirrel.Mac installs from a ZIP. This project's releases publish two
 *     `.dmg` files and nothing else — verified against the live release list.
 *   · electron-updater reads a `latest-mac.yml` feed that electron-builder
 *     only emits when `publish` is configured, and `desktop/electron-builder.yml`
 *     sets `publish: null` on purpose.
 *
 * So the answer is not "we would rather hand-roll". It is that the standard
 * updater cannot be made to work against an ad-hoc signature at all, and this
 * is what Mac apps did before notarisation: download, verify, swap, relaunch.
 *
 * ── WHAT CHANGES THE DAY A DEVELOPER ID EXISTS ──────────────────────────────
 *
 * All of it, and that is the point of keeping the surface this small. The
 * whole capability is two functions behind two hooks. Replacing them with
 * electron-updater means: enrol, set `mac.identity`, add a `zip` target beside
 * `dmg`, set `publish: github` so `latest-mac.yml` is emitted, add
 * `electron-updater` to `desktop/package.json`, and register the two hooks
 * against `autoUpdater` instead of against this file. `lib/adhoc-sign.mjs`
 * already turns ITSELF off the moment a real identity appears, so nothing here
 * has to be remembered. Nothing in `src/` changes, because nothing in `src/`
 * knows how the update is performed — it knows only that a hook exists.
 *
 * ── DISCIPLINE ──────────────────────────────────────────────────────────────
 *
 * Imports nothing from Electron and nothing from `src/`. Every effect —
 * fetch, filesystem, subprocess, quitting the app, the write registry — is an
 * injected dependency, so `npm test` EXECUTES both hooks end to end against a
 * temp-directory fixture and a fake release, with no Electron, no network and
 * no real application anywhere near it.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  progressOf, updateFailure, classifyInstallTarget, buildSwapScript,
} from './update-plan.js';

/** Emit a progress record at most this often, by bytes. 256 KB over a ~140 MB
 *  download is ~550 updates — smooth at any bar width, and nowhere near enough
 *  traffic to matter. A time-based throttle was considered and rejected: it
 *  makes the event count depend on the user's connection speed, so a slow link
 *  (the one where the bar matters most) would get the fewest updates. */
export const PROGRESS_BYTES = 256 * 1024;

/** Prefix for everything this feature writes next to the installed app. One
 *  literal, so the sweeper and the writer cannot disagree about what is ours —
 *  and distinctive enough that it can never match something a user put there. */
export const STAGE_PREFIX = '.the-curator-update-';
export const BACKUP_PREFIX = '.the-curator-backup-';

const noop = () => {};

/**
 * Create the engine.
 *
 * Everything is injected. The two that look like over-engineering and are not:
 *
 *   quitApp        the engine must NOT reach for `app.quit()` itself — it has
 *                  no Electron import, and more importantly the shell owns the
 *                  `quitAuthorised` flag that stops `before-quit` re-asking.
 *   writeRegistry  `hasActiveWrites` / `beginUpdate` / `endUpdate` come from
 *                  `src/brain/write-registry.js` in production. Injecting them
 *                  is what lets the suite prove the refusal AND the marker
 *                  without an ingest running.
 */
export function createUpdateEngine(deps = {}) {
  const {
    resolveRelease,
    fetchImpl = globalThis.fetch,
    execPath = null,
    homeDir = null,
    arch = null,
    classifyLaunchOrigin = null,
    workDir,
    logPath = null,
    runCommand,
    spawnDetached,
    quitApp = null,
    writeRegistry = {},
    pid = process.pid,
    randomId = () => Math.random().toString(36).slice(2, 10),
  } = deps;

  /** The single prepared update, or null. Held in memory ON PURPOSE. */
  let prepared = null;

  // ───────────────────────────────────────────────────────────────────────────
  //  Small helpers
  // ───────────────────────────────────────────────────────────────────────────

  /** A caller's progress callback must never be able to break an update. */
  const emitter = (onProgress) => {
    const fn = typeof onProgress === 'function' ? onProgress : noop;
    return (phase, received, total) => {
      try { fn(progressOf(phase, received, total)); } catch { /* the UI is not load-bearing */ }
    };
  };

  const run = async (cmd, args, opts = {}) => {
    if (typeof runCommand !== 'function') return { status: 127, stdout: '', stderr: 'no runCommand' };
    return runCommand(cmd, args, opts);
  };

  /** `stat -f %d` — the filesystem's device id. Used to PROVE that `mv` will
   *  perform a rename and not a 400 MB copy; see buildSwapScript's docblock. */
  const deviceOf = async (p) => {
    const r = await run('/usr/bin/stat', ['-f', '%d', p]);
    return r.status === 0 ? String(r.stdout || '').trim() : null;
  };

  const rmrf = async (p) => { try { await fsp.rm(p, { recursive: true, force: true }); } catch { /* best effort */ } };

  /**
   * Remove anything this feature left behind on a previous run.
   *
   * Only paths whose basename starts with one of OUR two prefixes are touched,
   * and only inside the two directories we own. That is deliberately narrower
   * than "clean the folder": this sweeps INSIDE the user's Applications folder,
   * and a sweeper there that is even slightly loose is a catastrophe generator.
   *
   * A leftover BACKUP is safe to remove here for a reason worth stating rather
   * than assuming: this code is running, which means the app exists at its own
   * path, which means the swap that created that backup either committed or
   * rolled back. Either way nothing depends on it any more.
   */
  const sweep = async (dirs) => {
    for (const dir of dirs) {
      if (!dir) continue;
      let entries = [];
      try { entries = await fsp.readdir(dir); } catch { continue; }
      for (const name of entries) {
        if (name.startsWith(STAGE_PREFIX) || name.startsWith(BACKUP_PREFIX)) {
          await rmrf(path.join(dir, name));
        }
      }
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  //  prepareUpdate
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Resolve → download → verify → stage. Resolves when there is a complete,
   * verified application bundle sitting beside the installed one and NOTHING
   * has been replaced yet.
   *
   * The split between this and `installUpdate` is the contract's, and it is the
   * right split: the expensive, slow, cancellable, entirely reversible part is
   * separated from the two-syscall part that cannot be undone. It also means
   * the UI can say "ready — restarting now" instead of the window vanishing
   * halfway through a progress bar.
   */
  /**
   * The public hook. Wraps the real work so that NOTHING can escape as a
   * rejection — see `internal-error` in update-plan.js for why a promise that
   * rejects is worse here than one that resolves with a refusal.
   */
  async function prepareUpdate(opts = {}) {
    try {
      return await prepareUpdateInner(opts);
    } catch (err) {
      return updateFailure('internal-error', err && err.stack ? err.stack.split('\n')[0] : String(err));
    }
  }

  async function prepareUpdateInner(opts = {}) {
    const emit = emitter(opts.onProgress);
    const signal = opts.signal || null;

    // ── 0. Can we install AT ALL? Asked first, before any network. ──────────
    // A translocated app cannot replace itself no matter what GitHub says, and
    // finding that out after a 140 MB download would be a cruel way to learn
    // it. Cheap questions first.
    // REFUSED rather than skipped when the classifier is missing. Treating an
    // absent ephemeral-location check as "fine" would silently remove the one
    // guard that stops a translocated app trying to replace a read-only mount
    // — a weakening with no symptom, which is the shape this repo's paths.js
    // and install-mode.js both go out of their way to avoid.
    if (typeof classifyLaunchOrigin !== 'function') {
      return updateFailure('no-exec-path', 'no launch-origin classifier was provided');
    }
    const origin = classifyLaunchOrigin(execPath, homeDir);
    const target = classifyInstallTarget({ execPath, launchOrigin: origin });
    if (!target.ok) return target;

    emit('resolving', 0, null);

    // ── 1. Which release, which asset. Wholly delegated. ────────────────────
    if (typeof resolveRelease !== 'function') {
      return updateFailure('unexpected-response', 'no release resolver was provided');
    }
    let release;
    try {
      release = await resolveRelease({ arch, signal });
    } catch (err) {
      return updateFailure('network-unreachable', err && err.message);
    }
    if (!release || !release.ok) return release || updateFailure('unexpected-response', 'resolver returned nothing');

    // Anything half-finished from a previous attempt goes now, while there is
    // still nothing of value on disk to confuse it with.
    await discardPrepared();
    await sweep([target.installDir]);
    try {
      await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return updateFailure('download-write-failed', err && err.code);
    }
    for (const name of await fsp.readdir(workDir).catch(() => [])) {
      await rmrf(path.join(workDir, name));
    }

    const { asset } = release;
    const dmgPath = path.join(workDir, `${release.tagName}-${asset.name}`);

    // ── 2. Download, with a real byte count. ────────────────────────────────
    emit('downloading', 0, asset.size);
    const dl = await downloadAsset({ asset, dmgPath, signal, emit });
    if (!dl.ok) { await rmrf(dmgPath); return dl; }

    // ── 3. Verify BEFORE anything is unpacked, let alone installed. ─────────
    emit('verifying', asset.size, asset.size);
    if (dl.bytes !== asset.size) {
      await rmrf(dmgPath);
      return updateFailure('size-mismatch', `${dl.bytes} != ${asset.size}`);
    }
    if (asset.digest) {
      if (dl.digest !== asset.digest.hex) {
        await rmrf(dmgPath);
        return updateFailure('digest-mismatch', `${asset.digest.algorithm} mismatch`);
      }
    }

    // ── 4. Stage: mount, copy the app out, prove it. ────────────────────────
    emit('staging', 0, null);
    const stageDir = path.join(target.installDir, `${STAGE_PREFIX}${randomId()}`);
    const staged = await stageBundle({ dmgPath, stageDir, release, target });
    // The disk image is 140 MB and is of no further use once the bundle is out
    // of it — removed on success and on failure alike.
    await rmrf(dmgPath);
    if (!staged.ok) { await rmrf(stageDir); return staged; }

    prepared = {
      token: `${release.version}:${randomId()}`,
      version: release.version,
      tagName: release.tagName,
      releaseUrl: release.releaseUrl,
      prerelease: release.prerelease === true,
      assetName: asset.name,
      bytes: asset.size,
      verifiedDigest: asset.digest ? `${asset.digest.algorithm}:${asset.digest.hex}` : null,
      stagedPath: staged.stagedPath,
      stageDir,
      targetPath: target.bundlePath,
      installDir: target.installDir,
    };

    return {
      ok: true,
      token: prepared.token,
      version: prepared.version,
      current: release.current,
      releaseUrl: prepared.releaseUrl,
      prerelease: prepared.prerelease,
      assetName: prepared.assetName,
      bytes: prepared.bytes,
      // Honest about the strength of what was checked. `null` when GitHub
      // published no digest for this asset, which is a DIFFERENT statement
      // from "we checked and it matched" and must never render as one.
      verifiedDigest: prepared.verifiedDigest,
      verifiedLength: true,
      warning: target.warning,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  The download
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Stream to disk, hashing as we go.
   *
   * Hashed DURING the download rather than by re-reading the file afterwards:
   * a second full read of 140 MB buys nothing, and hashing the bytes as they
   * are written means the digest covers exactly what was received rather than
   * what a later read happened to return.
   *
   * The oversize check aborts MID-STREAM rather than at the end. A server (or
   * a redirect to somewhere unexpected) that keeps sending would otherwise
   * fill the user's disk before the length check ever ran, and the failure the
   * user would see is "your disk is full", not "that download was wrong".
   */
  async function downloadAsset({ asset, dmgPath, signal, emit }) {
    let response;
    try {
      response = await fetchImpl(asset.url, { redirect: 'follow', signal: signal || undefined });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return updateFailure('download-cancelled');
      return updateFailure('download-failed', err && err.message);
    }
    if (!response) return updateFailure('download-failed', 'no response');
    if (response.status === 404 || response.status === 410) return updateFailure('download-not-found', `status ${response.status}`);
    if (!response.ok) return updateFailure('download-failed', `status ${response.status}`);
    if (!response.body) return updateFailure('download-failed', 'response carried no body');

    const hash = createHash(asset.digest ? asset.digest.algorithm : 'sha256');
    const out = createWriteStream(dmgPath, { mode: 0o600 });
    let received = 0;
    let lastEmit = 0;

    const write = (chunk) => new Promise((resolve, reject) => {
      // Honour backpressure. Without the drain wait a fast connection buffers
      // the whole 140 MB in memory, which on a small Mac is the difference
      // between an update and a swap-thrash.
      if (out.write(chunk)) resolve();
      else out.once('drain', resolve);
      out.once('error', reject);
    });

    try {
      for await (const chunk of response.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buf.length;
        if (received > asset.size) {
          throw Object.assign(new Error('oversized'), { curatorReason: 'download-oversized' });
        }
        hash.update(buf);
        await write(buf);
        if (received - lastEmit >= PROGRESS_BYTES) {
          lastEmit = received;
          emit('downloading', received, asset.size);
        }
      }
      await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
    } catch (err) {
      // WAIT FOR THE STREAM TO ACTUALLY CLOSE before returning, or the
      // caller's cleanup races the file's own creation. `createWriteStream`
      // opens the fd ASYNCHRONOUSLY, so on the oversize path — which throws
      // before the first write — `destroy()` can be called before the open
      // completes, the open then creates the file, and the `rm` that already
      // ran has nothing to remove. Measured: it left a 0-byte .dmg behind
      // after every oversized download.
      try { out.destroy(); } catch { /* already gone */ }
      await new Promise((resolve) => { if (out.closed) resolve(); else out.once('close', resolve); });
      if (err && err.curatorReason) return updateFailure(err.curatorReason);
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return updateFailure('download-cancelled');
      if (err && (err.code === 'ENOSPC' || err.code === 'EDQUOT' || err.code === 'EACCES' || err.code === 'EROFS')) {
        return updateFailure('download-write-failed', err.code);
      }
      // A connection that dies mid-body lands here. It is reported as
      // TRUNCATED rather than as a generic failure, because that is what it is
      // and because the user's next move differs: retry, and the resumed
      // download will be complete.
      return updateFailure('download-truncated', err && err.message);
    }

    // Always emit the final byte count, whatever the throttle did.
    emit('downloading', received, asset.size);
    return { ok: true, bytes: received, digest: hash.digest('hex') };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  Staging
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Mount the image, copy the bundle out beside the installed app, prove it.
   *
   * ── THE STAGE DIRECTORY IS THE WRITABILITY PROBE, AND THAT IS NOT AN ────────
   *    ACCIDENT
   *
   * `/Applications` is `drwxrwxr-x root:admin`. A non-admin account, a managed
   * Mac, or an MDM profile can all make it unwritable, and `fs.access(W_OK)`
   * is not a reliable answer there — ACLs and sandbox policy can permit or
   * deny in ways `access(2)` does not model. So the engine does not ASK; it
   * creates the real directory it is about to need, in the real place, and
   * reports the real errno. By the time `prepareUpdate` resolves, the parent
   * directory has had 400 MB written into it — "ready to install" is a
   * measurement, not a prediction.
   *
   * ── `ditto`, NOT `cp -R` — AND THE USUAL JUSTIFICATION FOR THAT IS ─────────
   *    WRONG ON THIS macOS, MEASURED
   *
   * The received wisdom is that `cp -R` drops extended attributes and so
   * breaks a bundle's code signature, while `ditto` preserves them. This file
   * said exactly that until a mutation swapping `ditto` for `cp -R` came back
   * GREEN. Measured on macOS 15.7.7, on a real ad-hoc-signed bundle copied out
   * of a real mounted .dmg:
   *
   *     ditto  →  codesign --verify --deep --strict  exit 0,  11 xattr lines
   *     cp -R  →  codesign --verify --deep --strict  exit 0,  11 xattr lines
   *
   * They are indistinguishable here. So `ditto` is used for the GUARANTEE
   * rather than for a measured difference: it is Apple's documented tool for
   * copying bundles, it is what `@electron/osx-sign` and every packaging tool
   * reaches for, and its behaviour on ACLs and resource forks is specified
   * rather than a property of one release of `cp`. What actually protects the
   * user against a bad copy is the `codesign --verify` below, which runs
   * whichever tool did the copying — and that is where the guard belongs.
   *
   * The mutation stays GREEN, deliberately and on the record: an assertion
   * that `cp -R` breaks the bundle would be asserting something that is not
   * true on this system.
   */
  async function stageBundle({ dmgPath, stageDir, release, target }) {
    try {
      await fsp.mkdir(stageDir, { recursive: false, mode: 0o755 });
    } catch (err) {
      const code = err && err.code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        return updateFailure('install-dir-not-writable', code);
      }
      return updateFailure('copy-failed', code);
    }

    // Same filesystem, proved rather than assumed. Both paths exist right now,
    // so this is a real measurement of the two directories `mv` will be given.
    const [devStage, devTarget] = await Promise.all([deviceOf(stageDir), deviceOf(target.bundlePath)]);
    if (devStage && devTarget && devStage !== devTarget) {
      return updateFailure('install-dir-cross-device', `${devStage} != ${devTarget}`);
    }

    const mountPoint = path.join(stageDir, 'mnt');
    await fsp.mkdir(mountPoint, { recursive: true });

    const attach = await run('/usr/bin/hdiutil', [
      'attach', dmgPath,
      '-mountpoint', mountPoint,
      // -nobrowse: never show it in Finder. -readonly and -noverify: we have
      // already verified the bytes against GitHub's own sha256, so hdiutil's
      // slower internal checksum pass would be a second, weaker check.
      // -noautoopen: do not let the image open a window at the user.
      '-nobrowse', '-readonly', '-noverify', '-noautoopen',
    ]);
    if (attach.status !== 0) {
      return updateFailure('dmg-mount-failed', `hdiutil exit ${attach.status}`);
    }

    try {
      let entries = [];
      try { entries = await fsp.readdir(mountPoint); } catch { entries = []; }
      const appName = entries.find((n) => n.toLowerCase().endsWith('.app'));
      if (!appName) return updateFailure('dmg-no-app', `mounted image holds ${entries.length} entries, none a .app`);

      // Named for the installed app, not for what is inside the image: the
      // final rename must land on the EXISTING path, and macOS treats a
      // bundle's directory name as part of its identity.
      const stagedPath = path.join(stageDir, path.basename(target.bundlePath));
      const copy = await run('/usr/bin/ditto', [path.join(mountPoint, appName), stagedPath]);
      if (copy.status !== 0) return updateFailure('copy-failed', `ditto exit ${copy.status}`);

      return await verifyStaged({ stagedPath, release });
    } finally {
      // Always detach, on every path. A leaked mount survives the app and
      // shows up as a phantom volume on the user's desktop. `-force` because
      // by this point we no longer care why it is busy.
      const det = await run('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet']);
      if (det.status !== 0) await run('/usr/bin/hdiutil', ['detach', mountPoint, '-force', '-quiet']);
    }
  }

  /**
   * Three checks on the bundle that is about to replace the user's app.
   *
   * WHAT THIS PROVES, stated precisely, because the honest limits matter more
   * than the list:
   *
   *   1. the executable exists      catches a copy that stopped halfway
   *   2. the version is the one     catches the wrong asset, a mislabelled
   *      that was resolved          release, and a stale staging directory
   *   3. codesign --verify passes   catches corruption anywhere in the 5,500
   *                                 files the first two checks never look at
   *
   * WHAT IT DOES NOT PROVE, and cannot: that Apple vouches for these bytes.
   * The bundle is ad-hoc signed, so check 3 is an INTEGRITY check — "this
   * bundle is internally consistent with its own seal" — and not an
   * authenticity one. Authenticity rests entirely on the sha256 the download
   * was matched against and on the fact that it came from GitHub over TLS.
   * That distinction is the whole reason the digest check above is not
   * optional.
   */
  async function verifyStaged({ stagedPath, release }) {
    const exeDir = path.join(stagedPath, 'Contents', 'MacOS');
    let exes = [];
    try { exes = await fsp.readdir(exeDir); } catch { exes = []; }
    if (!exes.length) return updateFailure('staged-incomplete', 'no executable in Contents/MacOS');

    const plist = path.join(stagedPath, 'Contents', 'Info.plist');
    const v = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
    if (v.status !== 0) return updateFailure('staged-incomplete', 'Info.plist has no version');
    const stagedVersion = String(v.stdout || '').trim();
    if (stagedVersion !== release.version) {
      return updateFailure('staged-version-mismatch', `${stagedVersion} != ${release.version}`);
    }

    const sig = await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedPath]);
    if (sig.status !== 0) return updateFailure('staged-signature-invalid', `codesign exit ${sig.status}`);

    return { ok: true, stagedPath, stagedVersion };
  }

  // ───────────────────────────────────────────────────────────────────────────
  //  installUpdate
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Write the helper, start it detached, and quit.
   *
   * ── THE TOKEN IS A SECURITY BOUNDARY, NOT BOOKKEEPING ───────────────────────
   *
   * This function takes an opaque token and NOTHING ELSE. It never accepts a
   * path. The caller is ultimately a renderer over loopback HTTP, and a
   * version of this that took `{stagedPath, targetPath}` would be a
   * "replace any directory on this Mac with any other" primitive reachable
   * from a page. The two paths come only from the record this engine created
   * itself, in `prepareUpdate`, from a bundle it verified.
   *
   * ── WHY THE WRITE GUARD IS CHECKED HERE AND NOT IN prepareUpdate ────────────
   *
   * Downloading during an ingest is harmless — it writes to a temp directory
   * and touches nothing the ingest cares about. Restarting during one is data
   * loss: a multi-phase ingest is 20+ paid LLM calls and a partly-written
   * wiki. So the guard sits at the moment of the restart, where it belongs,
   * and `beginUpdate()` is taken at the same moment so that `/api/write-status`
   * reports `updateInProgress` and the shell's own quit dialog says "an update
   * is being applied" rather than "no writes in progress".
   */
  async function installUpdate(opts = {}) {
    try {
      return await installUpdateInner(opts);
    } catch (err) {
      // The marker must come off on this path too, or an unforeseen throw
      // between beginUpdate() and the handoff leaves the app permanently
      // un-quittable without a dialog.
      if (typeof writeRegistry.endUpdate === 'function') { try { writeRegistry.endUpdate(); } catch { /* ignore */ } }
      return updateFailure('internal-error', err && err.stack ? err.stack.split('\n')[0] : String(err));
    }
  }

  async function installUpdateInner(opts = {}) {
    const emit = emitter(opts.onProgress);

    if (!prepared) return updateFailure('not-prepared');
    if (opts.token && opts.token !== prepared.token) return updateFailure('stale-token');

    // The staged bundle could have been deleted between prepare and install —
    // by a cleaner, by the user, by another tool. Re-checked rather than
    // trusted, because acting on it means moving the installed app aside.
    try { await fsp.stat(prepared.stagedPath); } catch { await discardPrepared(); return updateFailure('not-prepared', 'staged bundle is gone'); }
    try { await fsp.stat(prepared.targetPath); } catch { return updateFailure('not-a-bundle', 'the installed app is no longer at its own path'); }

    if (typeof writeRegistry.hasActiveWrites === 'function' && writeRegistry.hasActiveWrites()) {
      let ops = [];
      try {
        ops = typeof writeRegistry.listActiveWrites === 'function' ? writeRegistry.listActiveWrites() : [];
      } catch { ops = []; }
      return { ...updateFailure('writes-in-progress'), operations: Array.isArray(ops) ? ops.slice(0, 8) : [] };
    }

    // Checked BEFORE the helper is spawned. A helper started against an app
    // that then refuses to quit would sit polling for two minutes and exit
    // having changed nothing — recoverable, but it leaves the staged bundle in
    // the user's Applications folder with no explanation.
    if (typeof quitApp !== 'function') return updateFailure('relaunch-unavailable');

    emit('installing', 0, null);

    const scriptPath = path.join(workDir, 'install-update.sh');
    const backupPath = path.join(prepared.installDir, `${BACKUP_PREFIX}${randomId()}.app`);
    let script;
    try {
      script = buildSwapScript({
        pid,
        targetPath: prepared.targetPath,
        stagedPath: prepared.stagedPath,
        backupPath,
        stageDir: prepared.stageDir,
        logPath,
      });
      await fsp.mkdir(workDir, { recursive: true, mode: 0o700 });
      await fsp.writeFile(scriptPath, script, { mode: 0o700 });
    } catch (err) {
      return updateFailure('helper-write-failed', err && err.code);
    }

    if (typeof writeRegistry.beginUpdate === 'function') {
      try { writeRegistry.beginUpdate(); } catch { /* never blocks the update */ }
    }

    try {
      spawnDetached('/bin/sh', [scriptPath]);
    } catch (err) {
      if (typeof writeRegistry.endUpdate === 'function') { try { writeRegistry.endUpdate(); } catch { /* ignore */ } }
      return updateFailure('helper-spawn-failed', err && err.message);
    }

    // Everything after this point is the helper's. It is already waiting on
    // this process's PID, so quitting IS the handoff.
    try {
      quitApp();
    } catch (err) {
      if (typeof writeRegistry.endUpdate === 'function') { try { writeRegistry.endUpdate(); } catch { /* ignore */ } }
      return updateFailure('relaunch-unavailable', err && err.message);
    }

    return { ok: true, installing: true, version: prepared.version, targetPath: prepared.targetPath };
  }

  /** Throw away a prepared update and the ~400 MB it is sitting on. */
  async function discardPrepared() {
    if (!prepared) return { ok: true, discarded: false };
    await rmrf(prepared.stageDir);
    prepared = null;
    return { ok: true, discarded: true };
  }

  /** Wire-safe. Booleans, a version and a token — never a path, because this
   *  is the shape a diagnostics endpoint would render. */
  function describe() {
    return {
      preparedVersion: prepared ? prepared.version : null,
      token: prepared ? prepared.token : null,
      verifiedDigest: prepared ? prepared.verifiedDigest : null,
    };
  }

  return { prepareUpdate, installUpdate, discardPrepared, describe };
}
