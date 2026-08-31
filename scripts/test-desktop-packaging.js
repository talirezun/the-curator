#!/usr/bin/env node
/**
 * test-desktop-packaging.js — OFFLINE suite for the `desktop/` Electron
 * scaffold, its build config, and `.github/workflows/desktop-dmg.yml`.
 *
 * ── What this suite CAN and CANNOT do, stated first ─────────────────────────
 *
 * `npm test` must stay free, fast and offline, so this suite never installs
 * Electron and never builds. `desktop/main.js` therefore cannot be imported
 * here, let alone run. A suite that could only grep main.js would be the exact
 * defect `test-source-scan-helpers.js` was written to close: "a positive
 * source scan a // comment satisfies".
 *
 * As of 2026-08-31 the scaffold HAS been installed, built and launched by
 * hand — see the VERIFIED block at the end of §10 for exactly what that
 * established, and the NOT ENFORCED block beside it for why almost none of it
 * is reachable from here.
 *
 * So the scaffold was SHAPED so that the parts worth proving are provable.
 * `desktop/lib/{quit-decision,write-status,port}.js` import nothing from
 * Electron and nothing from `src/`, and §5–§7 EXECUTE them — real function
 * calls, real return values, a real ephemeral port bound by the OS. Only
 * main.js's wiring is source-scanned, and §10 says so out loud.
 *
 * ── The invariant that actually protects users ──────────────────────────────
 *
 * The root manifest must gain nothing. `src/routes/config.js` runs
 * `npm install --silent --no-audit --no-fund` on EVERY user's machine on every
 * update, so an Electron devDependency at the root would push hundreds of
 * megabytes to every existing browser user for a feature they do not have.
 * §2 enumerates dependency names out of BOTH manifests and asserts they are
 * disjoint — never a hardcoded "electron" check, which would miss
 * `electron-builder`'s own transitive additions and any future toolchain.
 *
 * ── Sections ────────────────────────────────────────────────────────────────
 *
 *   §1  real-credential fingerprint (this suite must not touch user data)
 *   §2  the root manifest gains nothing — enumerated, not hardcoded
 *   §3  desktop/ is a separate, self-contained project
 *   §4  no coupling: nothing in src/ or mcp/ reaches into desktop/
 *   §5  decideQuit() — EXECUTED, including the safeToQuit:null case
 *   §6  fetchWriteStatus() — EXECUTED against stub fetches; never rejects
 *   §7  pickFreePort() / appUrl() — EXECUTED against the real OS
 *   §8  the DMG workflow triggers on TAGS and cannot join the release gate
 *   §9  credential hygiene: .gitignore coverage + no credential-shaped literal
 *   §11 the `files` / `extraResources` mapping — the defect that shipped an
 *       .app which worked only inside the checkout
 *   §10 main.js source scan (weak by nature), anti-vacuity controls, a
 *       VERIFIED-BY-HAND block and an explicit NOT ENFORCED block
 *
 * §11 runs before §10 so the NOT ENFORCED block stays last in the output.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decideQuit, MAX_DIALOG_OPERATIONS } from '../desktop/lib/quit-decision.js';
import { fetchWriteStatus } from '../desktop/lib/write-status.js';
import { pickFreePort, appUrl } from '../desktop/lib/port.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const DMG_WORKFLOW = path.join(WORKFLOWS, 'desktop-dmg.yml');

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
 * Strip `#` comments from a YAML source, so a rule can never be satisfied by
 * a line of prose ABOUT the rule. The workflow and the build config are heavily
 * commented and those comments name almost every string asserted below.
 *
 * WHAT THIS IS AND IS NOT LOAD-BEARING FOR — MEASURED BY MUTATION, not claimed.
 * An earlier draft of this docblock said "without this, half of §8 would be
 * vacuous". That was FALSE, and disabling the stripper proved it: §8's trigger
 * assertions are anchored on indentation (`^\s{4}branches:`) which a `#`-led
 * comment line cannot satisfy, so they stayed green. Exactly ONE assertion
 * reddened — §9's "the DMG workflow consumes ZERO secrets today", which without
 * stripping reports the five secret NAMES documented in comments as live
 * references. So the stripper is load-bearing for the SECRETS check and is
 * defence-in-depth for the rest. Recorded as measured rather than restated,
 * because an over-claimed control is the thing this repo keeps re-learning.
 *
 * Quote-aware, because a `#` inside a quoted scalar is data, not a comment.
 */
function stripYamlComments(src) {
  return src.split('\n').map((line) => {
    let out = '', qc = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (qc) { out += ch; if (ch === qc && line[i - 1] !== '\\') qc = null; continue; }
      if (ch === '"' || ch === "'") { qc = ch; out += ch; continue; }
      if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
      out += ch;
    }
    return out;
  }).join('\n');
}

/** Every .js/.mjs file under a directory, recursively, skipping node_modules. */
function jsFilesUnder(dir) {
  const out = [];
  (function walk(d) {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === '.git') continue;
      const p = path.join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e)) out.push(p);
    }
  })(dir);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Real user data is untouched');
// ═══════════════════════════════════════════════════════════════════════════
// This suite reads manifests and runs pure functions. It must never read or
// write the maintainer's config. Fingerprint by sha256 + size + existence
// ONLY — never mtime, which the maintainer's live app rewrites during an
// ordinary Settings action and which has produced a false "isolation is
// broken" twice in this repo's history.
{
  const cfg = path.join(ROOT, '.curator-config.json');
  const before = existsSync(cfg)
    ? { size: statSync(cfg).size, sha: createHash('sha256').update(readFileSync(cfg)).digest('hex') }
    : null;
  // Nothing between here and the check below touches it; the check exists so
  // that a future edit to this suite which DOES touch it goes red.
  const after = existsSync(cfg)
    ? { size: statSync(cfg).size, sha: createHash('sha256').update(readFileSync(cfg)).digest('hex') }
    : null;
  eq(after, before, 'the real .curator-config.json is byte-identical (or absent in both readings)');

  // ── INVERTED 2026-08-31, and the replacement is a DIFFERENT KIND of claim ──
  // This used to read:
  //
  //     ok(!existsSync(path.join(DESKTOP, 'node_modules')),
  //        'desktop/node_modules does NOT exist — nothing has been installed here');
  //
  // `npm install` has now been run in desktop/, so it is false on a developer
  // machine. It is still TRUE on CI, which only installs at the root — so the
  // old assertion was environment-dependent and was never an invariant at all:
  // it would have passed on CI forever while being wrong locally.
  //
  // The real invariant is that this tree can never be COMMITTED, whether or
  // not it exists. That holds in both environments and is what protects the
  // repository. Existence itself is deliberately not asserted in either
  // direction.
  {
    const gi = read(path.join(ROOT, '.gitignore'));
    ok(gi.split('\n').some((l) => l.trim() === 'desktop/node_modules/'),
       'desktop/node_modules is gitignored — present or absent, it can never be committed');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  The ROOT manifest gains nothing');
// ═══════════════════════════════════════════════════════════════════════════
const rootPkg = JSON.parse(read(path.join(ROOT, 'package.json')));
const deskPkg = JSON.parse(read(path.join(DESKTOP, 'package.json')));

/**
 * Every dependency name declared in a manifest, across every field npm treats
 * as a dependency map. ENUMERATED FROM THE FILE — the point of this suite is
 * that it cannot be satisfied by a hardcoded allow-list that goes stale.
 */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
function depNames(pkg) {
  const names = new Set();
  for (const f of DEP_FIELDS) {
    const m = pkg[f];
    if (m && typeof m === 'object' && !Array.isArray(m)) for (const k of Object.keys(m)) names.add(k);
  }
  return names;
}

const rootDeps = depNames(rootPkg);
const deskDeps = depNames(deskPkg);

{
  const overlap = [...deskDeps].filter((n) => rootDeps.has(n));
  eq(overlap, [], 'root and desktop dependency sets are DISJOINT (enumerated from both files)');

  ok(!Object.hasOwn(rootPkg, 'devDependencies') ||
     Object.keys(rootPkg.devDependencies || {}).length === 0,
     'the root manifest still declares ZERO devDependencies');

  // The auto-updater's `npm install` reads the LOCKFILE too. An Electron entry
  // reaching it is the same harm arriving one file later.
  const lock = read(path.join(ROOT, 'package-lock.json'));
  const lockObj = JSON.parse(lock);
  const lockPkgNames = Object.keys(lockObj.packages || {});
  const electronInLock = lockPkgNames.filter((k) => /(^|\/)electron(-|$)/.test(k));
  eq(electronInLock, [], 'root package-lock.json contains no electron package entry');

  // Cross-check the two files agree about the root's own dependency set, so a
  // manifest edit that never made it into the lockfile is also caught.
  const lockRoot = (lockObj.packages && lockObj.packages['']) || {};
  const lockRootDeps = depNames(lockRoot);
  eq([...lockRootDeps].sort(), [...rootDeps].sort(),
     'package-lock.json\'s root entry declares the same dependency names as package.json');

  // A dependency-shaped word in the root manifest's SCRIPTS would reintroduce
  // the harm by another route (`npx electron-builder` on a user's machine).
  const rootScripts = Object.values(rootPkg.scripts || {}).join(' ');
  ok(!/electron/i.test(rootScripts), 'no root npm script mentions electron');
  ok(!/desktop\//.test(rootScripts), 'no root npm script reaches into desktop/');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  desktop/ is a separate, self-contained project');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(existsSync(path.join(DESKTOP, 'package.json')), 'desktop/package.json exists');
  ok(deskPkg.private === true, 'desktop/package.json is private:true — it can never be published to npm');
  ok(!Object.hasOwn(deskPkg, 'dependencies') || Object.keys(deskPkg.dependencies || {}).length === 0,
     'desktop/package.json declares no runtime dependencies (the app owns those)');

  const dd = deskPkg.devDependencies || {};
  ok(Object.hasOwn(dd, 'electron'), 'desktop declares electron as a devDependency');
  ok(Object.hasOwn(dd, 'electron-builder'), 'desktop declares electron-builder as a devDependency');

  // ── THE VERSIONS ARE PINNED EXACTLY, BECAUSE THESE ONES WERE MEASURED ─────
  // The scaffold declared `^43.0.0` / `^26.0.0`, taken from a plan rather than
  // from a resolution. They now name the versions that were actually installed
  // and that actually produced a working, relocatable .app and two .dmgs on
  // 2026-08-31. A caret range would let a future `npm install` silently move
  // to an Electron major nobody has run this app on — and the failure mode
  // that cost this scaffold its first build (an app that works only inside the
  // checkout) is exactly the kind that a green `npm test` cannot see.
  //
  // These are values, not shapes: bumping them is a deliberate act that should
  // come with a fresh build and a fresh relocation test, which is why the
  // assertion names them.
  eq(dd.electron, '43.5.0', 'electron is pinned EXACTLY to the version that was built and launched');
  eq(dd['electron-builder'], '26.15.3', 'electron-builder is pinned EXACTLY to the version that produced the DMGs');
  for (const [name, range] of Object.entries(dd)) {
    ok(/^\d+\.\d+\.\d+$/.test(range),
       `desktop devDependency ${name} is an exact pin, not a range (got "${range}")`);
  }

  // The lockfile must agree, or `npm ci` installs something the manifest does
  // not name — the same class as §2's root manifest/lockfile cross-check.
  const deskLockPath = path.join(DESKTOP, 'package-lock.json');
  ok(existsSync(deskLockPath), 'desktop/package-lock.json exists — `npm ci` in the workflow has something to read');
  if (existsSync(deskLockPath)) {
    const deskLock = JSON.parse(read(deskLockPath));
    const pkgs = deskLock.packages || {};
    eq(pkgs['node_modules/electron']?.version, dd.electron,
       'desktop/package-lock.json resolves electron to the pinned version');
    eq(pkgs['node_modules/electron-builder']?.version, dd['electron-builder'],
       'desktop/package-lock.json resolves electron-builder to the pinned version');
    // A runtime dependency reaching this lockfile means someone duplicated the
    // app's deps into the shell manifest — see §11 for why that is refused.
    const dupes = [...rootDeps].filter((n) => Object.hasOwn(pkgs, `node_modules/${n}`) &&
                                              Object.hasOwn(deskLock.packages[''] ?.dependencies || {}, n));
    eq(dupes, [], 'no root runtime dependency is declared in the desktop lockfile\'s own dependency map');
  }

  // The DMG's version comes from the git tag via --config.extraMetadata.version.
  // A hand-typed version here would drift from the release it claims to be.
  eq(deskPkg.version, '0.0.0',
     'desktop/package.json stays at 0.0.0 — the DMG version is injected from the tag');

  // Root must not have adopted desktop/ as an npm workspace — that would make
  // `npm install` at the root install Electron after all, defeating §2 while
  // leaving both manifests looking correct.
  ok(!Object.hasOwn(rootPkg, 'workspaces'),
     'the root manifest declares no `workspaces` — desktop/ can never be pulled into a root install');

  for (const f of ['main.js', 'preload.js', 'electron-builder.yml', 'README.md',
                   'lib/port.js', 'lib/write-status.js', 'lib/quit-decision.js',
                   'build/entitlements.mac.plist']) {
    ok(existsSync(path.join(DESKTOP, f)), `desktop/${f} exists`);
  }

  // The lib/ modules must stay executable offline: no electron import, no src/
  // import. If either creeps in, §5–§7 stop being real tests and this suite
  // quietly becomes a source scanner.
  for (const f of ['lib/port.js', 'lib/write-status.js', 'lib/quit-decision.js']) {
    const src = read(path.join(DESKTOP, f));
    ok(!/from\s+['"]electron['"]/.test(src), `desktop/${f} does not import electron`);
    ok(!/from\s+['"][^'"]*\.\.\/\.\.\/src\//.test(src), `desktop/${f} does not import from src/`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  No coupling — nothing in src/ or mcp/ reaches into desktop/');
// ═══════════════════════════════════════════════════════════════════════════
// The whole argument for the second manifest is that the app is unchanged. An
// import from src/ into desktop/ would make the browser build depend on a
// folder that is only present for the Electron shell.
{
  const appFiles = [...jsFilesUnder(path.join(ROOT, 'src')), ...jsFilesUnder(path.join(ROOT, 'mcp'))];
  ok(appFiles.length > 50, `enumerated ${appFiles.length} app source files from disk (anti-vacuity)`);
  const offenders = [];
  for (const f of appFiles) {
    const src = read(f);
    // Only import/require SPECIFIERS, not prose. A comment mentioning
    // "desktop/main.js" is fine and is expected once the src/ follow-ups land.
    const specifiers = [
      ...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
      ...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    if (specifiers.some((s) => /(^|\/)desktop\//.test(s))) offenders.push(path.relative(ROOT, f));
  }
  eq(offenders, [], 'no file under src/ or mcp/ imports anything from desktop/');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  decideQuit() — EXECUTED');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(decideQuit({ ok: true, safeToQuit: true, activeWrites: false, updateInProgress: false, operations: [], operationsTotal: 0 }).action,
     'quit', 'safeToQuit:true → quit');

  // THE CASE THIS MODULE EXISTS FOR. The route answers safeToQuit:null when
  // the write registry throws. Neither collapse is acceptable: treating it as
  // safe truncates a paid multi-minute ingest; treating it as busy makes the
  // app permanently un-quittable and pushes the user to Force Quit, which
  // truncates the write anyway.
  const nullCase = decideQuit({ ok: false, safeToQuit: null, error: 'boom' });
  eq(nullCase.action, 'ask', 'safeToQuit:null → ask (NOT quit, NOT a silent block)');
  eq(nullCase.reason, 'unknown-registry', 'safeToQuit:null is reported as its own reason');
  eq(nullCase.defaultIsQuit, false, 'safeToQuit:null defaults the dialog to the SAFE button');

  const noAnswer = decideQuit(null);
  eq(noAnswer.action, 'ask', 'no answer at all → ask');
  eq(noAnswer.reason, 'unreachable', 'no answer is distinguished from a null registry answer');

  const busy = decideQuit({
    ok: true, safeToQuit: false, activeWrites: true, updateInProgress: false,
    operations: [{ domain: 'articles', count: 1, ops: ['ingest'] }], operationsTotal: 1,
  });
  eq(busy.action, 'ask', 'active writes → ask');
  eq(busy.reason, 'active-writes', 'active writes are reported as such');
  eq(busy.operations, ['articles — ingest'], 'the operation is named in the dialog line');

  const updating = decideQuit({ ok: true, safeToQuit: false, activeWrites: false, updateInProgress: true, operations: [], operationsTotal: 0 });
  eq(updating.reason, 'update-in-progress',
     'an update in flight is reported separately from an ingest (different remedy)');

  // The TRUE total must survive the cap — v3.17.0's rule that a cap is never
  // reported as a measurement.
  const many = decideQuit({
    ok: true, safeToQuit: false, activeWrites: true, updateInProgress: false,
    operations: Array.from({ length: 20 }, (_, i) => ({ domain: `d${i}`, count: 1, ops: ['ingest'] })),
    operationsTotal: 137,
  });
  eq(many.operations.length, MAX_DIALOG_OPERATIONS, 'the dialog list is capped');
  eq(many.operationsTotal, 137, 'the TRUE total rides alongside the capped list');

  // A truthiness check would read the STRING 'false' as "safe to quit".
  for (const weird of ['false', 0, 1, {}, [], 'yes']) {
    eq(decideQuit({ safeToQuit: weird }).action, 'ask',
       `safeToQuit:${JSON.stringify(weird)} is never coerced into a quit`);
  }
  eq(decideQuit({ ok: true }).reason, 'malformed', 'a body with no safeToQuit key is malformed, not safe');
  eq(decideQuit([]).reason, 'malformed', 'an array body is malformed, not safe');
  eq(decideQuit('busy').reason, 'malformed', 'a string body is malformed, not safe');

  // Anti-vacuity: there must be at least one input that DOES return 'quit',
  // or every assertion above is satisfied by a function that always asks.
  ok(decideQuit({ safeToQuit: true }).action === 'quit',
     'CONTROL — decideQuit is not a function that always answers "ask"');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  fetchWriteStatus() — EXECUTED against stub fetches');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ── A TRIPWIRE ON THE REAL fetch, AND IT CAUGHT A DEFECT IN THIS SUITE ────
  // `fetchWriteStatus` resolves its implementation as `deps.fetchImpl ||
  // globalThis.fetch`, so passing a FALSY fetchImpl falls through to the REAL
  // one. An earlier draft of the "missing fetch implementation" assertion below
  // passed `null` and went green — not through the guard it named, but because
  // undici refuses port 1 as a "bad port" and the catch turned that into null.
  // A green assertion, testing nothing it claimed, in an OFFLINE suite that had
  // just made a real network call. Found by mutating the module, not by reading.
  //
  // This tripwire makes that class impossible: any escape to the real fetch is
  // a named failure rather than a silent pass. Restored in the finally below.
  const realFetch = globalThis.fetch;
  let escapedToRealFetch = 0;
  globalThis.fetch = (...args) => { escapedToRealFetch++; return Promise.reject(new Error('tripwire')); };

  const good = { ok: true, safeToQuit: true, activeWrites: false, updateInProgress: false, operations: [], operationsTotal: 0 };
  const okFetch = async () => ({ status: 200, text: async () => JSON.stringify(good) });
  eq(await fetchWriteStatus('http://127.0.0.1:1', { fetchImpl: okFetch }), good,
     'a 200 with a JSON body is returned parsed');

  let seenUrl = null;
  await fetchWriteStatus('http://127.0.0.1:65000', {
    fetchImpl: async (u) => { seenUrl = u; return { status: 200, text: async () => '{}' }; },
  });
  eq(seenUrl, 'http://127.0.0.1:65000/api/write-status', 'it asks the documented route on the given base URL');

  // Every failure shape resolves to null. A rejection inside before-quit is the
  // one place an uncaught error means "the app cannot quit" or "it quit over a
  // live ingest".
  const cases = [
    ['a thrown network error', async () => { throw new Error('ECONNREFUSED'); }],
    ['a 500', async () => ({ status: 500, text: async () => 'nope' })],
    ['a body that is not JSON', async () => ({ status: 200, text: async () => 'not json' })],
    ['a response with no status', async () => ({ text: async () => '{}' })],
    ['an abort', async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }],
  ];
  for (const [label, impl] of cases) {
    let threw = false, val;
    try { val = await fetchWriteStatus('http://127.0.0.1:1', { fetchImpl: impl }); } catch { threw = true; }
    ok(!threw && val === null, `${label} resolves to null and never rejects`);
  }
  // The guard's REAL trigger: no usable fetch anywhere. Exercised by removing
  // globalThis.fetch for the duration, which is the only way this branch is
  // reachable — see the tripwire note above for why `{ fetchImpl: null }` is
  // not it.
  {
    const saved = globalThis.fetch;
    globalThis.fetch = undefined;
    let threw = false, val;
    try { val = await fetchWriteStatus('http://127.0.0.1:1', { fetchImpl: null }); } catch { threw = true; }
    globalThis.fetch = saved;
    ok(!threw && val === null, 'with no fetch implementation available at all, it resolves to null');
  }

  // An oversized body is refused rather than parsed.
  const huge = 'x'.repeat(300 * 1024);
  eq(await fetchWriteStatus('http://127.0.0.1:1', { fetchImpl: async () => ({ status: 200, text: async () => huge }) }), null,
     'an oversized body is refused');

  // End-to-end through the pair, which is what main.js actually does.
  // WRAPPED, because an earlier mutation (making fetchWriteStatus rethrow)
  // KILLED this suite here on an unhandled rejection — no named assertion, a
  // wrong tally, and a stack trace naming a line rather than an expectation.
  // That is the v3.24.1 crash-instead-of-red shape; a guard has to STOP, not
  // merely report.
  {
    let threw = false, action = null;
    try {
      action = decideQuit(await fetchWriteStatus('http://127.0.0.1:1', { fetchImpl: async () => { throw new Error('down'); } })).action;
    } catch { threw = true; }
    ok(!threw && action === 'ask',
       `a dead server end-to-end (fetch → decide) asks rather than quitting${threw ? ' — it THREW instead' : ` — got ${action}`}`);
  }

  globalThis.fetch = realFetch;
  eq(escapedToRealFetch, 0,
     'CONTROL — no assertion in this section escaped to the real fetch (this suite is OFFLINE)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  pickFreePort() / appUrl() — EXECUTED against the real OS');
// ═══════════════════════════════════════════════════════════════════════════
{
  const p1 = await pickFreePort();
  ok(Number.isInteger(p1) && p1 >= 1024 && p1 <= 65535, `pickFreePort returned a usable port (${p1})`);
  const p2 = await pickFreePort();
  ok(Number.isInteger(p2), 'pickFreePort can be called twice');
  ok(p1 !== 3333 && p2 !== 3333,
     'pickFreePort does not hand back the hardcoded 3333 the maintainer\'s checkout holds');

  eq(appUrl(51234), 'http://127.0.0.1:51234', 'appUrl builds a loopback http URL');
  ok(!/^file:/.test(appUrl(51234)) && !/:\/\/localhost/.test(appUrl(51234)),
     'appUrl is neither file:// nor localhost — see the Origin: null trap');
  for (const bad of [0, -1, 80, 70000, 'x', null, 1.5]) {
    let threw = false;
    try { appUrl(bad); } catch { threw = true; }
    ok(threw, `appUrl refuses an invalid port (${JSON.stringify(bad)})`);
  }

  // The URL must match what src/server.js will put in ALLOWED_ORIGINS. That set
  // is built as `http://127.0.0.1:${PORT}` — asserted against the real source
  // so the two can never drift apart silently.
  const serverSrc = read(path.join(ROOT, 'src', 'server.js'));
  ok(serverSrc.includes('`http://127.0.0.1:${PORT}`'),
     'src/server.js still builds ALLOWED_ORIGINS from `http://127.0.0.1:${PORT}` (the shape appUrl matches)');
  ok(/process\.env\.PORT\s*\|\|\s*3333/.test(serverSrc),
     'src/server.js still reads process.env.PORT — the seam main.js sets');
  ok(serverSrc.includes('CURATOR_NO_OPEN'),
     'src/server.js still honours CURATOR_NO_OPEN — the seam that stops a browser opening beside the app');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  The DMG workflow triggers on TAGS and cannot join the release gate');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(existsSync(DMG_WORKFLOW), '.github/workflows/desktop-dmg.yml exists');
  const raw = read(DMG_WORKFLOW);
  const yml = stripYamlComments(raw);

  // Anti-vacuity: comment stripping must not have eaten the file.
  ok(yml.trim().length > 400, `comment-stripped workflow is still substantial (${yml.trim().length} chars)`);
  ok(yml.includes('runs-on: macos-latest'), 'CONTROL — a known non-comment line survives comment stripping');

  // Extract the `on:` block LINE BY LINE, running to the next top-level key.
  // A character-offset slice is easy to get subtly wrong here and an empty
  // block would make every absence assertion below pass vacuously — which is
  // why the length control fires before any of them.
  const lines = yml.split('\n');
  const onStart = lines.findIndex((l) => /^on:\s*$/.test(l));
  ok(onStart >= 0, 'the workflow has a top-level `on:` block');
  let onEnd = lines.length;
  for (let i = onStart + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { onEnd = i; break; }
  }
  const onBlock = lines.slice(onStart, onEnd).join('\n');
  ok(onBlock.split('\n').filter((l) => l.trim()).length >= 3,
     `CONTROL — the on: block really was extracted (${onBlock.split('\n').filter((l) => l.trim()).length} non-blank lines)`);

  ok(/^\s{2}push:\s*$/m.test(onBlock), 'it triggers on push');
  ok(/^\s{4}tags:\s*$/m.test(onBlock), 'the push trigger is filtered by TAGS');
  ok(/'v\*'|"v\*"|-\s*v\*/.test(onBlock), 'the tag filter is v*');

  // THE THREE ABSENCES. Each keeps this workflow out of
  // `gh run list --branch <b>` at a release SHA, which is how
  // scripts/release.js finds the run it gates on.
  ok(!/^\s{4}branches(-ignore)?:\s*$/m.test(onBlock),
     'NO `branches:` filter under push — a tag run\'s head_branch is the tag, so --branch main excludes it');
  ok(!/^\s{2}pull_request:/m.test(onBlock),
     'NO pull_request trigger — fork PRs can never start a macOS runner here');
  ok(!/^\s{2}workflow_dispatch:/m.test(onBlock),
     'NO workflow_dispatch — a manual run carries head_branch: main and could collide with the release gate at the same SHA');

  // A bare `push:` with no filter at all would fire on every branch, which is
  // exactly what test.yml relies on and exactly what this file must not do.
  ok(!/^\s{2}push:\s*$/m.test(onBlock) || /^\s{4}tags:/m.test(onBlock),
     'the push trigger is never bare');

  // Job names must not collide with test.yml's. release.js reads PER-JOB
  // conclusions by NAME and holds an ADVISORY_JOBS name list; two workflows
  // sharing a job name is a way for the wrong job to be classified.
  const testYml = stripYamlComments(read(path.join(WORKFLOWS, 'test.yml')));
  const namesOf = (s) => [...s.matchAll(/^\s{4}name:\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''));
  const dmgNames = namesOf(yml), testNames = namesOf(testYml);
  ok(dmgNames.length >= 2, `the DMG workflow declares job display names (${dmgNames.join(', ')})`);
  ok(testNames.length >= 2, `CONTROL — test.yml's job names were parsed (${testNames.join(', ')})`);
  eq(dmgNames.filter((n) => testNames.includes(n)), [],
     'no DMG job name collides with a test.yml job name');

  // test.yml itself must keep the property release.js refuses without. This is
  // asserted elsewhere too; repeated here because this change adds a workflow
  // beside it and the interaction is the whole risk.
  ok(!/^\s{4}branches(-ignore)?:/m.test(testYml.slice(testYml.search(/^on:\s*$/m))),
     'test.yml STILL has no branches filter — the release gate reaches release/* branches');

  // Signing must be explicitly disabled while unsigned, or electron-builder
  // auto-discovers a keychain identity and silently produces a one-Mac build.
  ok(/CSC_IDENTITY_AUTO_DISCOVERY/.test(yml), 'the build step forces CSC_IDENTITY_AUTO_DISCOVERY off');
  ok(/permissions:/.test(yml) && /contents:\s*read/.test(yml), 'the workflow token is read-only');

  // Nothing may be built out of a scaffold that was never installed.
  ok(/desktop\/package-lock\.json/.test(yml),
     'the build is gated on desktop/package-lock.json existing');

  // ── INVERTED 2026-08-31 ────────────────────────────────────────────────────
  // This used to read:
  //
  //     ok(!existsSync(path.join(DESKTOP, 'package-lock.json')),
  //        'desktop/package-lock.json does NOT exist — the gate is honest
  //         about the scaffold being unbuilt');
  //
  // The lockfile now exists and is COMMITTED, which is what flips the gate's
  // `buildable` output to true and turns the DMG job on. That is intended:
  // the build has been run and the artifacts verified, so the gate should no
  // longer skip. Unlike node_modules this is a tracked file, so the assertion
  // is environment-independent — it holds on CI and on a fresh clone.
  ok(existsSync(path.join(DESKTOP, 'package-lock.json')),
     'desktop/package-lock.json EXISTS and is committed — the gate now resolves to buildable');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  Credential hygiene');
// ═══════════════════════════════════════════════════════════════════════════
{
  const gi = read(path.join(ROOT, '.gitignore'));
  for (const pat of ['desktop/node_modules/', 'desktop/dist/', '*.p12', '*.mobileprovision',
                     '*.provisionprofile', 'AuthKey_*.p8', '*.cer']) {
    ok(gi.split('\n').some((l) => l.trim() === pat), `.gitignore covers ${pat}`);
  }
  // The lockfile must NOT be ignored — the workflow gate keys on it, and it is
  // a real artefact that belongs in the tree once it exists.
  ok(!gi.split('\n').some((l) => l.trim() === 'desktop/package-lock.json'),
     '.gitignore does NOT hide desktop/package-lock.json');

  // No credential-shaped literal anywhere in what this change added. The
  // repository is PUBLIC; a leaked Developer ID has to be revoked at Apple.
  // THIS SUITE IS DELIBERATELY NOT IN ITS OWN SCAN. It has to CARRY planted
  // credential-shaped literals to prove the scanner detects them (see the two
  // controls below), so scanning itself would be permanently red for the
  // wrong reason. The backstop for this file is `.githooks/pre-commit`, which
  // scans STAGED CONTENT with its own pattern list and requires any synthetic
  // fixture to be added to `.githooks/secret-allowlist` by exact value — and
  // the assertion below proves this suite's planted strings are NOT of a shape
  // that hook recognises, i.e. nothing real is hiding behind this exemption.
  const scanned = [DMG_WORKFLOW, ...jsFilesUnder(DESKTOP),
                   path.join(DESKTOP, 'package.json'),
                   path.join(DESKTOP, 'electron-builder.yml'),
                   path.join(DESKTOP, 'README.md'),
                   path.join(DESKTOP, 'build', 'entitlements.mac.plist')]
    .filter((f) => f !== path.join(__dirname, 'test-desktop-packaging.js'));
  ok(scanned.length >= 8, `scanning ${scanned.length} added files for credential shapes (anti-vacuity)`);
  {
    // The hook's own pattern, transcribed (not read back out of the hook —
    // an expectation read from the thing it checks cannot fail).
    const HOOK = /AIza[0-9A-Za-z_-]{35}|sk-ant-[0-9A-Za-z_-]{20,}|sk-or-v1-[0-9A-Za-z_-]{20,}|(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[0-9A-Za-z_]{20,}|sbat_[0-9a-f]{40}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
    ok(!HOOK.test(read(path.join(__dirname, 'test-desktop-packaging.js'))),
       'this suite carries nothing the repo\'s own pre-commit secret scanner would refuse');
  }

  const CRED = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a PEM private key'],
    [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
    [/\bsk-ant-[0-9A-Za-z_-]{20,}/, 'an Anthropic key'],
    [/\bsk-or-v1-[0-9A-Za-z_-]{20,}/, 'an OpenRouter key'],
    [/\b(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[0-9A-Za-z_]{20,}/, 'a GitHub token'],
    [/\bsbat_[0-9a-f]{40}\b/, 'a Shared Brain admin token'],
    // Apple app-specific password: four lowercase quads separated by hyphens.
    [/\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/, 'an Apple app-specific password'],
    // A Team ID or a signing identity written as a literal VALUE.
    [/(APPLE_TEAM_ID|CSC_KEY_PASSWORD|APPLE_APP_SPECIFIC_PASSWORD|CSC_LINK)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{6,}/, 'a signing credential assigned a literal'],
    [/Developer ID Application:\s*\S/, 'a concrete signing identity'],
  ];
  const hits = [];
  for (const f of scanned) {
    if (!existsSync(f)) continue;
    const src = read(f);
    for (const [re, what] of CRED) if (re.test(src)) hits.push(`${path.relative(ROOT, f)}: ${what}`);
  }
  eq(hits, [], 'no credential-shaped literal appears in anything this change added');

  // POSITIVE CONTROL — the scanner detects what it claims to. Without this,
  // a scanner whose regexes had rotted would report a clean tree forever.
  const planted = 'CSC_KEY_PASSWORD: "hunter2hunter2"';
  ok(CRED.some(([re]) => re.test(planted)), 'CONTROL — the credential scanner fires on a planted literal');
  ok(CRED.some(([re]) => re.test('Developer ID Application: Someone (ABCDE12345)')),
     'CONTROL — the credential scanner fires on a planted signing identity');

  // Every secret the workflow names must be a `${{ secrets.NAME }}` reference,
  // never a value. Today there are none, and that is asserted rather than
  // assumed, so the day one is added it is added as a reference.
  const wf = read(DMG_WORKFLOW);
  const secretRefs = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  const uncommented = stripYamlComments(wf);
  eq([...uncommented.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]), [],
     'the DMG workflow consumes ZERO secrets today (they appear only in comments as names)');
  ok(secretRefs.length > 0, 'CONTROL — secret NAMES are documented in comments, so the matcher is live');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11 The `files` mapping — the defect that shipped a broken .app');
// ═══════════════════════════════════════════════════════════════════════════
//
// ── THE BUG THIS SECTION EXISTS FOR, AND WHY IT WAS INVISIBLE ──────────────
//
// The scaffold's `files` block listed `node_modules/**/*` in a `from: ..`
// filter. That line DID NOTHING. electron-builder does not treat node_modules
// as ordinary files: it computes the PRODUCTION DEPENDENCY TREE from the app
// manifest's `dependencies` and copies that, ignoring a user glob.
// `desktop/package.json` deliberately declares no `dependencies`, so the
// computed tree is empty, the build logs
//
//     no node modules returned while searching directories
//
// and ships `Contents/Resources/app/` with no node_modules at all.
//
// MEASURED, 2026-08-31: that build LAUNCHES FINE while it sits inside the
// checkout, because Node resolves a bare specifier by walking UP the directory
// tree — out of the bundle, out of dist/, out of desktop/ — and finds the REPO
// ROOT's node_modules. Copy the same .app to /Applications and it dies with
// `ERR_MODULE_NOT_FOUND: Cannot find package 'dotenv'`, which main.js catches
// and shows through `fatal()`'s error dialog. So "I built it and it ran" is
// NOT evidence here, and this guard exists because the obvious test passes.
//
// ── WHAT THIS SECTION CAN AND CANNOT DO ────────────────────────────────────
//
// It is a CONFIG scan, not a build. `npm test` cannot run electron-builder —
// that is a 130 MB toolchain download and several minutes. What it can do is
// refuse the two shapes that are known to be wrong, in both directions:
//
//   · `node_modules` must NOT appear in `files`, because listing it there is
//     a no-op that reads like a fix.
//   · `extraResources` MUST place `../node_modules` at `app/node_modules`,
//     because that is the one path where both APP_ROOT derivations find it.
{
  const rawBuilder = read(path.join(DESKTOP, 'electron-builder.yml'));
  const builderNoComments = stripYamlComments(rawBuilder);

  ok(builderNoComments.length > 400 && builderNoComments.length < rawBuilder.length,
     `CONTROL — YAML comment stripping left real config (${builderNoComments.length} of ${rawBuilder.length} chars)`);
  ok(/^files:/m.test(builderNoComments), 'CONTROL — the files: key survives comment stripping');

  /** The lines of one top-level YAML block, comments already removed. */
  function blockLines(src, key) {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.trimEnd() === `${key}:`);
    if (start === -1) return null;
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      if (/^\S/.test(l)) break;           // next top-level key ends the block
      out.push(l);
    }
    return out;
  }

  const filesBlock = blockLines(builderNoComments, 'files');
  ok(Array.isArray(filesBlock) && filesBlock.length >= 4,
     `CONTROL — the files: block parsed into ${filesBlock ? filesBlock.length : 0} entries (anti-vacuity)`);

  // THE REGRESSION GUARD. Comments are stripped first, so the long explanation
  // ABOVE `files:` — which necessarily contains the word node_modules — cannot
  // satisfy or defeat this.
  const filesText = (filesBlock || []).join('\n');
  ok(!/node_modules/.test(filesText),
     '`files` does NOT list node_modules — listing it there is a silent no-op (see the note above this section)');

  // Everything the flat layout DOES need from the parent must still be listed,
  // or the packaged app root loses src/ or mcp/ instead.
  for (const needed of ['src/**/*', 'mcp/**/*']) {
    ok(filesText.includes(needed), `\`files\` still copies ${needed} from the parent`);
  }
  ok(/from:\s*\.\.\s*$/m.test(filesText) || /from:\s*\.\./.test(filesText),
     '`files` still has a `from: ..` entry — src/ and mcp/ come from the repo root');
  ok(/to:\s*\.\s*$/m.test(filesText) || /to:\s*\./.test(filesText),
     '`files` maps the parent content to `.` — the app root stays FLAT, so both APP_ROOT derivations agree');

  // The positive half. Without this, removing the node_modules line from
  // `files` would be satisfiable by shipping nothing at all.
  const extra = blockLines(builderNoComments, 'extraResources');
  ok(Array.isArray(extra) && extra.length >= 2,
     `extraResources exists and parsed into ${extra ? extra.length : 0} entries`);
  const extraText = (extra || []).join('\n');
  ok(/from:\s*\.\.\/node_modules\s*$/m.test(extraText),
     'extraResources copies the REPO ROOT node_modules (not a second install under desktop/)');
  // `to: app/node_modules` is asserted EXACTLY, and the reason is subtle
  // enough to be worth writing down: a bare `to: node_modules` would land the
  // tree at Contents/Resources/node_modules, which Node's walk-up resolver
  // WOULD ALSO FIND from Contents/Resources/app/src/server.js. It would work —
  // by exactly the accident that made the broken build look fine inside the
  // checkout. The app root must be self-contained rather than rely on a parent
  // directory happening to be on the resolution path, so the strict form is
  // the assertion.
  ok(/to:\s*app\/node_modules\s*$/m.test(extraText),
     'extraResources lands it at app/node_modules — `to` is relative to Contents/Resources, so this is the app root');

  // The safety property the whole "copy the root tree" decision rests on: the
  // root has NO devDependencies, so there is no dev tree to ship to users.
  // §2 asserts that too; it is repeated here because THIS is the line that
  // would start shipping one.
  ok(!Object.hasOwn(rootPkg, 'devDependencies') ||
     Object.keys(rootPkg.devDependencies || {}).length === 0,
     'the root manifest still has ZERO devDependencies — extraResources cannot ship a dev tree');

  // asar must stay off. With asar on, `to: app/node_modules` would land the
  // tree beside the archive rather than inside it, and every argument in the
  // electron-builder.yml header applies again.
  ok(/^asar:\s*false\s*$/m.test(builderNoComments),
     'asar is still false — extraResources into app/ only makes sense on an unpacked app root');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10 main.js source scan, and what is NOT enforced');
// ═══════════════════════════════════════════════════════════════════════════
// EVERYTHING IN THIS SECTION IS A SOURCE SCAN AND IS THEREFORE WEAK. Electron
// is not installed, so main.js cannot be imported, evaluated or run. A scan
// proves a call was WRITTEN, never that it RUNS, never that it runs in the
// right order, and never that the resulting app works. Comments are stripped
// first so a line of prose about a rule cannot satisfy the rule.
{
  const rawMain = read(path.join(DESKTOP, 'main.js'));
  // Strip block and line comments. Crude but sufficient: this file has no
  // regex literals and no `//` inside strings.
  const main = rawMain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(main.length > 1500 && main.length < rawMain.length,
     `CONTROL — comment stripping left real code (${main.length} of ${rawMain.length} chars)`);
  ok(main.includes('createWindow'), 'CONTROL — a known identifier survives comment stripping');

  ok(/requestSingleInstanceLock\(\)/.test(main), 'main.js takes the single-instance lock');
  ok(/second-instance/.test(main), 'main.js focuses the existing window on a second launch');
  ok(/showErrorBox/.test(main), 'the losing instance says something rather than exiting silently');

  ok(/process\.env\.CURATOR_NO_OPEN\s*=\s*'1'/.test(main), 'main.js sets CURATOR_NO_OPEN=1');
  ok(/process\.env\.PORT\s*=/.test(main), 'main.js sets PORT');

  // ORDER matters and a scan CAN see this one: both env writes must precede the
  // import, because src/server.js reads them at module scope.
  const iNoOpen = main.indexOf('CURATOR_NO_OPEN');
  const iPort = main.indexOf('process.env.PORT');
  const iImport = main.indexOf('await import(');
  ok(iImport > 0 && iNoOpen > 0 && iNoOpen < iImport, 'CURATOR_NO_OPEN is set BEFORE src/server.js is imported');
  ok(iPort > 0 && iPort < iImport, 'PORT is set BEFORE src/server.js is imported');

  ok(/loadURL\(baseUrl\)/.test(main), 'the window loads the loopback URL built by appUrl()');
  ok(!/registerSchemesAsPrivileged|protocol\.register/.test(main),
     'main.js registers NO custom scheme (Origin: null would 403 every POST)');
  ok(!/loadFile\(/.test(main), 'main.js never loads the UI from file://');

  ok(/before-quit/.test(main), 'main.js hooks before-quit');
  ok(/decideQuit\(/.test(main), 'before-quit routes through decideQuit()');
  ok(/fetchWriteStatus\(/.test(main), 'before-quit consults GET /api/write-status');
  ok(/app\.relaunch\(\)/.test(main), 'main.js calls app.relaunch() rather than letting the spawn-based restart run');

  // INVERTED, not deleted. This read `main.js intercepts POST /api/restart`,
  // and that interception was a WORKAROUND for the route spawning
  // process.execPath — which under Electron is the app binary. The route now
  // branches on the restartStyle capability and calls the `relaunch` hook.
  //
  // The interceptor had to GO rather than remain as belt-and-braces: it
  // cancelled the request BEFORE Express, so the real branch could never run
  // and the workaround would silently keep winning. Two mechanisms for one job,
  // where the worse one executes first, is not redundancy.
  ok(!/onBeforeRequest/.test(main),
     'main.js does NOT intercept the restart at the HTTP layer — the route branches on restartStyle instead, and an interceptor would cancel the request before that branch could run');
  ok(/registerDesktopHost\(/.test(main),
     'main.js registers its native hooks with the server it just imported — same Node realm, so the registry is a real channel');
  ok(/relaunch\s*:/.test(main),
     'the registered hooks include relaunch, which is what the restartStyle bundle arm calls');
  ok(/pickFolder\s*:/.test(main),
     'the registered hooks include pickFolder — without it the bundle arm of /api/config/pick-folder refuses, which is the fail-safe but not the feature');

  ok(/nodeIntegration:\s*false/.test(main), 'the renderer has no Node integration');
  ok(/contextIsolation:\s*true/.test(main), 'the renderer is context-isolated');
  ok(/sandbox:\s*true/.test(main), 'the renderer is sandboxed');
  ok(/setWindowOpenHandler/.test(main), 'external links go to the real browser, not a chrome-less window');

  const builder = stripYamlComments(read(path.join(DESKTOP, 'electron-builder.yml')));
  ok(/^asar:\s*false\s*$/m.test(builder),
     'electron-builder.yml sets asar:false (see the three hazards documented in that file)');
  ok(/identity:\s*null/.test(builder), 'the mac build is explicitly unsigned');
  ok(/publish:\s*null/.test(builder), 'nothing is published — no electron-updater wiring');
  ok(/entitlements:/.test(builder), 'an entitlements file is wired for the day signing lands');
  ok(/NSDocumentsFolderUsageDescription/.test(builder),
     'TCC usage descriptions are set — a hardened app without them is KILLED, not denied');

  // The asar reasoning rests on a fact in src/. Assert the fact, so the day
  // someone removes `cwd: ROOT` the argument in the config file is re-examined
  // rather than left standing on a premise that has expired.
  const syncSrc = read(path.join(ROOT, 'src', 'brain', 'sync.js'));
  ok(/cwd:\s*ROOT/.test(syncSrc),
     'src/brain/sync.js STILL passes cwd: ROOT to its git child — hazard (a) for asar is live');
  const pathsSrc = read(path.join(ROOT, 'src', 'brain', 'paths.js'));
  ok(/export const APP_ROOT = path\.resolve\(__dirname, '\.\.\/\.\.'\)/.test(pathsSrc),
     'APP_ROOT is still derived from __dirname — which inside an asar archive is not a real directory');
  const ingestSrc = read(path.join(ROOT, 'src', 'brain', 'ingest.js'));
  ok(/await import\('pdf-parse\/lib\/pdf-parse\.js'\)/.test(ingestSrc),
     'the dynamic pdf-parse import is still there — hazard (c) for asar is live');

  console.log(`
  VERIFIED BY HAND ON 2026-08-31 — none of it re-checked by \`npm test\`:
    · electron 43.5.0 + electron-builder 26.15.3 installed and pinned.
    · \`electron .\` launched a real window; the app's own UI rendered a real
      domain, and a POST from the renderer returned 201 while the same POST
      with a foreign Origin returned 403.
    · A .app and two .dmgs were built. APP_ROOT resolved to
      Contents/Resources/app in the packaged app, and the .app ran from
      /Applications.
    · The layout is flat and both APP_ROOT derivations agree.

  NOT ENFORCED — read this before trusting the numbers above:
    · \`npm test\` STILL CANNOT BUILD. Everything in the list above was
      established once, by hand, on one machine, on one macOS version. This
      suite scans configuration; it does not run electron-builder, does not
      produce a package, and does not launch anything. A change that keeps
      every assertion green can still ship a broken .app.
    · §11 IS A CONFIG SCAN, AND ITS CENTRAL LESSON IS THAT BUILDING IS NOT
      ENOUGH EITHER. The node_modules defect produced an app that launched
      and worked perfectly while it sat inside the checkout, because Node's
      resolver walked up out of the bundle. The only test that catches it is
      launching a COPY of the .app from outside the repo — which nothing
      automated does today. If you change the files/extraResources mapping,
      build it, copy it somewhere with no node_modules above it, and run it.
    · §10 is a SOURCE SCAN. It proves a call was written, not that it runs,
      not that it runs in the right order beyond the two import-ordering
      checks, and not that the resulting app launches.
    · THE PACKAGED APP IS NOT COVERED BY THE PROJECT'S USUAL TEST ISOLATION.
      \`CURATOR_TEST_USER_DATA_DIR\` does NOT redirect the MCP launcher —
      \`getMcpLauncherDir()\` has its own seam, \`CURATOR_TEST_MCP_LAUNCHER_DIR\`,
      and without it a bundle-mode run writes into the real
      ~/Library/Application Support/The Curator/bin. Electron's own Chromium
      profile goes to ~/Library/Application Support/<productName> regardless
      and cannot be redirected by any Curator seam.
    · The single-instance dialog, the quit decision reaching a real dialog,
      and the restart interceptor were exercised by hand and are not
      reproducible offline. The BUSY quit path in particular has never been
      run against a real in-flight write.
    · The claim that a tag-triggered run carries head_branch = the TAG (which
      is what keeps this workflow out of \`gh run list --branch main\`) is
      GitHub behaviour, asserted from documentation rather than measured. The
      durable fix is \`--workflow test.yml\` in scripts/release.js's watchCi,
      which is outside this change's scope.
    · Whether \`osascript ... choose folder\` needs the apple-events
      entitlement under a hardened runtime is INFERRED, not measured. The
      entitlement is granted defensively.
    · Signing, notarization, electron-updater, the app icon, and first-launch
      adoption of an existing repo install are all out of scope and absent.
      The built .app carries only the linker's ad-hoc signature
      (TeamIdentifier not set), so \`spctl\` rejects it and another Mac needs
      right-click -> Open. That is the intended state of \`identity: null\`.
    · This suite does not assert anything about the CONTENT of a packaged
      app, because it never produces one. §11 asserts the RECIPE, not the
      result.
`);
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed ? 1 : 0);
