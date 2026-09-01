/**
 * adhoc-sign.mjs — give the packaged app a VALID ad-hoc signature.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE DEFECT THIS CLOSES IS NOT "THE APP IS UNSIGNED". IT IS THAT THE      ║
 * ║  SIGNATURE FAILS INTEGRITY VALIDATION, WHICH IS A DIFFERENT AND MUCH      ║
 * ║  WORSE GATEKEEPER CLASS.                                                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Measured on a bundle built from this config with `mac.identity: null`:
 *
 *   codesign -dv                      Identifier=Electron
 *                                     flags=0x20002(adhoc,linker-signed)
 *                                     Sealed Resources=none
 *   codesign --verify --deep --strict  exit 1 — "code has no resources but
 *                                     signature indicates they must be present"
 *   spctl --assess --type execute      exit 1 — the SAME integrity error, not a
 *                                     plain "rejected"
 *   syspolicy_check distribution       TWO fatals: Codesign Error + Notary
 *                                     Ticket Missing
 *
 * `identity: null` SKIPS signing entirely, which leaves Electron's own
 * linker-signed ad-hoc CodeDirectory in place — and that CodeDirectory declares
 * a resource seal the bundle does not have. An app in that state is the
 * "**… is damaged and can't be opened. You should move it to the Trash**" case:
 * the dialog offers Move to Trash / Cancel, no "Open Anyway" ever appears in
 * System Settings, and the only escape is a terminal
 * `xattr -dr com.apple.quarantine` — which is precisely the CLI step this whole
 * desktop pivot exists to remove.
 *
 * A VALID ad-hoc signature moves the app into the ordinary "unidentified
 * developer" class, where Open Anyway works and no terminal is needed.
 *
 * ── WHY THIS IS A HOOK AND NOT `mac.identity: '-'` ──────────────────────────
 *
 * `'-'` is the obvious candidate and it is WRONG, and this was measured against
 * electron-builder 26.15.3's own matcher rather than reasoned about.
 *
 * `MacTargetHelper.findSigningIdentity` handles `qualifier === '-'` only INSIDE
 * `if (identity == null)` — i.e. AFTER it has already run
 * `findIdentity('Developer ID Application', '-', keychain)`. And `_findIdentity`
 * filters candidate keychain lines with
 *
 *     if (qualifier != null && !line.includes(qualifier)) continue;
 *
 * a bare SUBSTRING test. So `'-'` matches any identity line containing a
 * literal hyphen — which covers a hyphenated surname and essentially every
 * organisation name with a dash in it.
 *
 * Worse, `CSC_IDENTITY_AUTO_DISCOVERY=false` does NOT protect against this. The
 * env is consulted only on the `isEmptyOrSpaces(identity)` branch of
 * `findIdentity`; a `'-'` qualifier takes the other branch and the keychain is
 * searched regardless. Driven against electron-builder's real matcher with a
 * fabricated keychain:
 *
 *   identity:'-'      + AUTO_DISCOVERY=false + "…Application: Tali-Rezun (…)"
 *       -> CAPTURED — the env does not protect
 *   identity:undefined + AUTO_DISCOVERY=false + the same keychain
 *       -> no match — the env DOES protect here
 *
 * So `identity: '-'` would re-open exactly the hazard `identity: null`'s comment
 * exists to prevent: silently signing with whatever is in the developer's
 * keychain and shipping an artifact that works on one Mac. `identity: null`
 * STAYS — `handleNullIdentity()` returns before any keychain call — and the
 * ad-hoc signature is applied here, where the `codesign` invocation is explicit
 * and no identity search happens at all.
 *
 * ── STRUCTURALLY OFF WHEN REAL SIGNING ARRIVES ──────────────────────────────
 *
 * CLAUDE.md records `scripts/build-app.sh`'s trailing
 * `codesign --force --deep --sign -` as a hazard precisely because it would
 * DESTROY a Developer ID signature. This module must not become the same
 * hazard, so it does not merely document that it should be turned off — it
 * turns ITSELF off, on three independent signals, and the artifact check at the
 * end refuses to let a keychain identity through even if one somehow arrived.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

/** Env vars whose presence means somebody is configuring REAL signing. */
export const REAL_SIGNING_ENV = [
  'CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD',
  'CSC_INSTALLER_LINK', 'CSC_INSTALLER_KEY_PASSWORD',
  'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY',
];

/**
 * Decide whether the ad-hoc fallback should run at all.
 *
 * Returns `{sign, reason}`. It THROWS only for a configuration that would make
 * an applied signature silently invalid — see the `electronFuses` case, which
 * is the one thing that runs between this hook and the finished bundle.
 *
 * Pure, so the offline suite can execute every branch on any platform.
 */
export function shouldAdhocSign({ identity, env = {}, electronFuses = null } = {}) {
  // 1. Real signing configured in the build config. electron-builder's own
  //    signing step runs AFTER afterPack, so it would overwrite us anyway — but
  //    "it would be overwritten" is not a safety argument, it is luck. Refuse.
  if (identity !== null && identity !== undefined) {
    return { sign: false, reason: `mac.identity is set (${JSON.stringify(identity)}) — real signing owns this bundle` };
  }
  // `undefined` means the key is absent, which in electron-builder means
  // AUTO-DISCOVER. That is the hazard identity:null exists to prevent, so this
  // module refuses to paper over it with an ad-hoc signature.
  if (identity === undefined) {
    return { sign: false, reason: 'mac.identity is absent — electron-builder would auto-discover a keychain identity; set it to null explicitly' };
  }

  // 2. Real signing configured in the environment.
  const present = REAL_SIGNING_ENV.filter((k) => typeof env[k] === 'string' && env[k].length > 0);
  if (present.length) {
    return { sign: false, reason: `real signing credentials are present in the environment (${present.join(', ')})` };
  }

  // 3. Electron fuses flip bits in the main binary, and electron-builder does
  //    that AFTER afterPack ("the fuses MUST be flipped right before signing").
  //    A signature applied here would be silently invalidated. Today
  //    `electronFuses` is unset so `doAddElectronFuses` returns immediately —
  //    this refusal is the tripwire for the day that changes.
  if (electronFuses != null) {
    throw new Error(
      'BUILD REFUSED — `electronFuses` is configured. electron-builder flips fuses in the main ' +
      'binary AFTER the afterPack hook, which would silently invalidate the ad-hoc signature ' +
      'applied here. Move the ad-hoc signing step after the fuse step, or drop electronFuses.'
    );
  }

  return { sign: true, reason: 'no real signing configured — applying a valid ad-hoc signature' };
}

/**
 * Parse `codesign -dv --verbose=4` output (which goes to STDERR).
 *
 * The fields that matter, and why:
 *   flags            `adhoc` must be set; `linker-signed` means Electron's own
 *                    stub is still in place and we have not re-signed.
 *   Sealed Resources `none` is the exact defect — a CodeDirectory that
 *                    declares resources the bundle does not have.
 *   TeamIdentifier   anything other than "not set" means a REAL certificate
 *                    signed this, which for this build path is a leak.
 */
export function parseSignatureInfo(text) {
  const s = typeof text === 'string' ? text : '';
  const flagsMatch = s.match(/flags=0x[0-9a-f]+\(([^)]*)\)/i);
  const flags = flagsMatch ? flagsMatch[1].split(',').map((f) => f.trim()) : [];
  const sealed = s.match(/Sealed Resources[^\n]*/i);
  const team = s.match(/^TeamIdentifier=(.*)$/m);
  const ident = s.match(/^Identifier=(.*)$/m);
  const authority = s.match(/^Authority=(.*)$/m);
  return {
    flags,
    adhoc: flags.includes('adhoc'),
    linkerSigned: flags.includes('linker-signed'),
    sealedResources: sealed ? sealed[0].replace(/^Sealed Resources\s*/i, '').trim() : null,
    hasSealedResources: !!(sealed && /version=\d+/i.test(sealed[0])),
    teamIdentifier: team ? team[1].trim() : null,
    identifier: ident ? ident[1].trim() : null,
    authority: authority ? authority[1].trim() : null,
  };
}

/**
 * The artifact-level guarantee, checked on what was actually produced.
 *
 * This is the assertion that makes the keychain hazard a MEASURED property of
 * the bundle rather than a claim about a config file. Even if some future path
 * managed to hand a real certificate to this build, the bundle does not leave
 * the hook.
 */
export function assertAdhocOnly(info) {
  const problems = [];
  if (!info.adhoc) problems.push(`the signature is not ad-hoc (flags: ${info.flags.join(',') || 'none'})`);
  if (info.linkerSigned) problems.push('the signature is still Electron\'s linker-signed stub — codesign did not replace it');
  if (!info.hasSealedResources) {
    problems.push(`Sealed Resources is "${info.sealedResources ?? 'absent'}" — this is the "damaged and can\'t be opened" defect`);
  }
  // MEASURED, not theorised. A build with `mac.identity: '-'` produces
  // flags=0x10002(adhoc,runtime) — electron-builder applies `hardenedRuntime`
  // to an ad-hoc signature — and that app DOES NOT LAUNCH:
  //
  //   dyld: Library not loaded: @rpath/Electron Framework.framework/…
  //   Reason: code signature not valid for use in process: mapping process and
  //           mapped file (non-platform) have different Team IDs
  //
  // Library validation refuses to load the framework, and this bundle's
  // entitlements file carries no `com.apple.security.cs.disable-library-
  // validation` (checked: zero occurrences). The lethal part is that such a
  // bundle passes `codesign --verify --deep --strict`, passes `spctl` the same
  // way as a good one, and clears syspolicy_check's Codesign Error — every
  // static check goes green on an app that is dead on arrival. Only launching
  // it finds that. So the flag is refused here.
  if (info.adhoc && info.flags.includes('runtime')) {
    problems.push(
      'the hardened runtime is enabled on an AD-HOC signature (flags: ' + info.flags.join(',') + '). ' +
      'Measured: that bundle fails to launch with a dyld library-validation error, while passing ' +
      'every static signature check. The hardened runtime belongs with a real Developer ID signature.'
    );
  }
  if (info.teamIdentifier && info.teamIdentifier !== 'not set') {
    problems.push(`TeamIdentifier=${info.teamIdentifier} — a REAL certificate signed this bundle, which this build path must never do`);
  }
  if (info.authority) {
    problems.push(`Authority=${info.authority} — an ad-hoc signature has no authority chain`);
  }
  if (problems.length) {
    throw new Error(
      'BUILD REFUSED — the packaged app\'s signature is not the ad-hoc signature this build path guarantees.\n\n' +
      problems.map((p) => `  · ${p}`).join('\n') + '\n'
    );
  }
  return true;
}

/**
 * Default runner: combined stdout+stderr plus the exit status.
 *
 * `spawnSync`, NOT `execFileSync`, and that is load-bearing: **`codesign -dv`
 * writes its entire report to STDERR even when it succeeds**, so an
 * `execFileSync` that only returns stdout hands back an empty string and every
 * field parses as absent. That is not a hypothetical — the first version of
 * this file did exactly that and the build refused itself with
 * "the signature is not ad-hoc (flags: none)" on a bundle that had just been
 * signed correctly. The refusal was right; the reading was wrong.
 */
function runCodesign(args) {
  const r = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  if (r.error) return { status: 1, output: String(r.error.message || r.error) };
  return {
    status: typeof r.status === 'number' ? r.status : 1,
    output: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

/**
 * Apply and then PROVE the ad-hoc signature.
 *
 * ── `--deep` IS DEPRECATED BY APPLE, AND IS STILL RIGHT HERE ────────────────
 *
 * Apple deprecates `--deep` for real signing: it signs nested code with the
 * OUTER bundle's options, which for a Developer ID build silently produces
 * nested code with the wrong entitlements, and notarization rejects it. The
 * documented replacement is inside-out signing — every nested framework,
 * helper and dylib signed individually, innermost first, then the outer app —
 * which is exactly what `@electron/osx-sign` does and exactly what
 * electron-builder will do for us the day `mac.identity` names a real
 * certificate.
 *
 * None of that applies to an ad-hoc signature that is never notarized and
 * carries no entitlements: there are no per-target options for `--deep` to get
 * wrong. This bundle has 5,500+ nested files (`asar: false`), so hand-rolling
 * inside-out signing here would be a second implementation of a thing we do not
 * ship. WHEN DEVELOPER ID ARRIVES this module turns itself OFF at
 * `shouldAdhocSign`, and `--deep` goes with it — it is never the thing that
 * signs a real release.
 *
 * `--deep` WAS SUSPECTED OF BREAKING THE BUNDLE AND WAS EXONERATED BY A
 * CONTROLLED EXPERIMENT. One bundle, copied; `--deep` in BOTH arms; the single
 * variable was `--options runtime`:
 *
 *   codesign --force --deep --sign -                   -> loads and runs
 *   codesign --force --deep --options runtime --sign - -> dyld: Library not
 *       loaded: @rpath/Electron Framework.framework/Electron Framework …
 *       "not valid for use in process: mapping process and mapped file
 *        (non-platform) have different Team IDs"
 *
 * Both arms pass `codesign --verify --deep --strict` with exit 0. So `--deep`
 * is not the hazard on this bundle; the HARDENED RUNTIME over an ad-hoc
 * signature is — and that is precisely what `mac.identity: '-'` produces,
 * because electron-builder applies `hardenedRuntime: true` on its own signing
 * path. The obvious fix would have shipped an app that crashes at launch while
 * passing every static signature check.
 *
 * ── NO `--options runtime`, DELIBERATELY ────────────────────────────────────
 *
 * `electron-builder.yml` sets `hardenedRuntime: true`, but that is applied at
 * codesign time and this call does not pass it. That is not an oversight:
 * electron-builder itself warns that "ad-hoc signing with hardenedRuntime
 * enabled requires the com.apple.security.cs.disable-library-validation
 * entitlement to prevent app launch failures due to library validation". An
 * ad-hoc build with the hardened runtime on can simply fail to launch. The
 * hardened runtime belongs with the real signature, and the config's own
 * comment already says the entitlement block is inert until then.
 */
export function adhocSign({ appPath, identity, env = process.env, electronFuses = null, exec = runCodesign }) {
  const decision = shouldAdhocSign({ identity, env, electronFuses });
  if (!decision.sign) return { signed: false, ...decision };

  const signed = exec(['--force', '--deep', '--sign', '-', appPath]);
  if (signed.status !== 0) {
    throw new Error(`BUILD REFUSED — ad-hoc codesign failed (exit ${signed.status}):\n${signed.output}`);
  }

  // Prove it, rather than trusting the exit code. `--verify --deep --strict` is
  // the check that FAILED before this change, so it is the one that has to pass.
  const verified = exec(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (verified.status !== 0) {
    throw new Error(
      `BUILD REFUSED — the app does not pass \`codesign --verify --deep --strict\` after signing.\n` +
      `This is the "damaged and can't be opened" defect.\n\n${verified.output}`
    );
  }

  const info = parseSignatureInfo(exec(['-dv', '--verbose=4', appPath]).output);
  assertAdhocOnly(info);
  assertLoadable(appPath);

  return { signed: true, reason: decision.reason, info };
}

/**
 * Prove the signed bundle CAN ACTUALLY BE LOADED, not merely that it verifies.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE WHOLE REASON THIS EXISTS: a bundle can pass `codesign --verify        ║
 * ║  --deep --strict` with exit 0, pass `spctl` exactly as a good one does,    ║
 * ║  clear syspolicy_check's Codesign Error — and then DIE AT dyld TIME with   ║
 * ║  a library-validation error, before a single line of app code runs.       ║
 * ║  Measured, twice. Every static check is green on an app that is dead on    ║
 * ║  arrival, and that is strictly WORSE than the defect being fixed: it       ║
 * ║  turns a Gatekeeper prompt the user can click through into a hard crash    ║
 * ║  they cannot.                                                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * `ELECTRON_RUN_AS_NODE=1` makes the app binary behave as Node. dyld still maps
 * the embedded Electron Framework — so a library-validation refusal still
 * fails here — but NO WINDOW IS CREATED and `main.js` never runs. It is the
 * cheapest honest answer to "does this app start", and it is headless, which
 * matters because a real launch puts a dialog on a real person's desktop.
 *
 * It does NOT prove the server serves or the window paints. It proves the one
 * thing that was silently failing.
 */
export function assertLoadable(appPath, budgets = null) {
  // TEST-ONLY SEAM, null in production — the same shape as compile.js's
  // `opts.generateText`. Without it the timeout arm costs 5 minutes to
  // exercise, which means in practice it is never exercised at all.
  const FIRST_MS = budgets && budgets.firstMs ? budgets.firstMs : 60_000;
  const RETRY_MS = budgets && budgets.retryMs ? budgets.retryMs : 240_000;
  const macOsDir = path.join(appPath, 'Contents', 'MacOS');
  let exe;
  try {
    const entries = readdirSync(macOsDir);
    if (entries.length !== 1) {
      throw new Error(`expected exactly one executable in Contents/MacOS, found ${entries.length}`);
    }
    exe = path.join(macOsDir, entries[0]);
  } catch (err) {
    throw new Error(`BUILD REFUSED — cannot locate the app executable to load-test it: ${err.message}`);
  }

  // ── THE PROBE NAMES WHICH WAY IT FAILED, AND RETRIES A TIMEOUT ────────
  //
  // This threw ONE message for three different facts — the app exited non-zero,
  // the probe was KILLED for taking too long, or the process never started at
  // all — and it discarded `status`, `signal` and `error`. So the log carried a
  // confident "the signed app FAILS TO LOAD" above an EMPTY output, with no way
  // to tell a dyld refusal from a stopwatch running out.
  //
  // It cost a real release. v3.38.0's x64 bundle built green in the morning and
  // refused twice that afternoon on the same runner image, from the same code
  // path, and the message said the same thing either way.
  //
  // A cold x64 bundle on an arm64 runner pays for Rosetta translation on its
  // FIRST launch — exactly the kind of cost a fixed 60s budget survives on an
  // idle machine and loses on a loaded one. So a TIMEOUT is retried once,
  // generously; a genuine non-zero EXIT is fatal immediately, because that is
  // the defect this guard exists to catch and retrying it would only make the
  // guard intermittent.
  const probe = (timeout) => spawnSync(exe, ['-e', 'process.exit(0)'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout,
  });
  const timedOut = (x) => x.signal === 'SIGTERM' || (x.error && x.error.code === 'ETIMEDOUT');

  let r = probe(FIRST_MS);
  let retried = false;
  if (r.status !== 0 && timedOut(r)) {
    retried = true;
    r = probe(RETRY_MS);
  }
  if (r.status === 0) return true;

  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const how = timedOut(r)
    ? `the probe was KILLED after ${Math.round((retried ? RETRY_MS : FIRST_MS) / 1000)}s without answering` +
      (retried ? ', having already been retried once with a longer budget' : '')
    : r.error
      ? `the probe could not be STARTED: ${(r.error.code || '') + ' ' + r.error.message}`.trim()
      : `the app EXITED with status ${r.status}`;
  // THREE modes, THREE diagnoses. Branching on `timedOut ? … : dyld` sent a
  // process that never STARTED into the dyld text — caught by the control in
  // test-desktop-version-identity.js, which is precisely the overstatement this
  // whole change exists to remove, reintroduced by the change itself.
  const diagnosis = (r.error && !timedOut(r))
    ? 'THE PROCESS NEVER STARTED, so nothing has been learned about the signature\n' +
      'at all. This is an environment or permissions problem — an unreadable or\n' +
      'non-executable file, a missing interpreter, a full disk — and it is NOT\n' +
      'evidence of a dyld refusal. Fix the environment and run it again.'
    : timedOut(r)
    ? 'A TIMEOUT IS NOT A DYLD REFUSAL, and this message must not pretend it is.\n' +
      'On an arm64 runner an x64 bundle pays for Rosetta translation on first\n' +
      'launch, and a loaded machine can exceed the budget where an idle one does\n' +
      'not. If this recurs on an otherwise unchanged build, suspect the machine\n' +
      'before the app.'
    : 'It passed every static signature check and still cannot start. This is the\n' +
      'hardened-runtime-over-ad-hoc failure mode, or a nested component whose\n' +
      'signature the loader rejects. Shipping this would be worse than shipping\n' +
      'the unsigned bundle: a Gatekeeper prompt can be clicked through, a dyld\n' +
      'crash cannot.';
  throw new Error(
    `BUILD REFUSED — the load probe did not pass: ${how}.\n\n${diagnosis}\n\n` +
    `exe=${exe}\nstatus=${r.status} signal=${r.signal || 'none'} retried=${retried}\n` +
    `output=${output ? output.slice(0, 2000) : '(empty — the process produced no output at all)'}`
  );
}
