/**
 * test-first-run-domains.js — OFFLINE suite for the FIRST SCREEN of a fresh
 * install: an empty knowledge base must render as EMPTY, never as an error.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * Reported from a real v3.30.0 packaged install. In bundle mode
 * `getDomainsDir()` resolves under ~/Library/Application Support/The Curator,
 * and on a fresh install that `domains/` folder does not exist — nothing had
 * ever created it. `listDomains()` therefore threw, and the Domains view
 * rendered, in BOTH the sidebar and the main pane:
 *
 *     Could not load domains
 *     ENOENT: no such file or directory, scandir '…/The Curator/domains'
 *
 * beside a Getting Started panel telling the user to create their first
 * domain. The app was not broken. It was empty. Those are different things,
 * and the UI already had a correct empty state for the second one — it simply
 * never got there, because the read threw before the view could branch.
 *
 * A source install never showed it: `domains/` ships in the checkout (a
 * TRACKED `domains/.gitkeep`), so the folder exists before the app first runs.
 * This is therefore a bundle-mode regression, and §5's DISAGREEMENT CONTROL is
 * what proves that claim rather than assuming it.
 *
 * ── The two-layer fix, and why neither layer alone is enough ────────────────
 *
 *   config.js  `ensureDefaultDomainsDir()` — creates the DEFAULT domains dir,
 *              once, at server startup. Needed because absence is not only a
 *              READ problem: `sync.setup()`'s first statement writes
 *              `<domains>/.gitignore` through `writeFileAtomic`, which does
 *              not create parents, so Personal Sync — how an existing user
 *              brings their real wiki to a new machine — could not be set up
 *              at all. The same directory is Personal Sync's git WORK-TREE.
 *              It deliberately refuses to create a user-CONFIGURED path.
 *
 *   files.js   `listDomains()` — ENOENT means zero domains. Needed because a
 *              configured `domainsPath` is never provisioned by the layer
 *              above (an unmounted drive, a renamed folder), and because an
 *              absent collection is genuinely empty rather than broken.
 *
 * ── What this suite refuses to let collapse ────────────────────────────────
 *
 * ABSENT and UNREADABLE are different. §2 asserts that EACCES and ENOTDIR
 * still THROW and still reach the user as an error — if they were folded into
 * the ENOENT branch, a permission fault or a broken install would present as
 * a friendly "no domains yet" and the real problem would be invisible.
 *
 *   §1  the reproduction — an absent dir yields [], not a throw
 *   §2  absent vs unreadable, with an anti-vacuity control on each
 *   §3  the ROUTE — GET /api/domains answers 200 + [] rather than 500
 *   §4  ensureDefaultDomainsDir: created / exists / not-default / failed,
 *       and that a FAILURE IS NOT CACHED (the paths.js 'blocked' defect)
 *   §5  repo mode unchanged, PLUS the disagreement control that stops §5
 *       being vacuous
 *   §6  the folder picker — the escape hatch out of a wrong knowledge folder
 *       — actually works in bundle mode, and refuses (never silently falls
 *       back) when the desktop shell has registered no hook
 *   §7  the provisioning is WIRED: the real src/server.js is spawned and the
 *       folder is looked for on disk. Without this the fix could be dead code
 *       and every §4 assertion would still be green.
 *   §8  isolation fingerprints: the real config and the real domains/ folder
 *
 * ── NOT ENFORCED (stated so nobody reads more into a green run) ────────────
 *
 *   - Nothing here renders. The empty state itself is `views/domains.js`'s
 *     `state.domains.length === 0` branch, already shipping and unmodified;
 *     this suite proves the SERVER now reaches it, not that it paints well.
 *   - `mcp/storage/local.js`'s own `listDomains()` swallows EVERY error and
 *     returns [] — it DOES collapse absent and unreadable. That file is
 *     outside this change's scope; §2's rule is asserted for `src/` only.
 *   - An unmounted external drive whose `domainsPath` is gone now shows an
 *     empty wiki rather than an error. That is a deliberate trade (see
 *     files.js) and is not detected here — nor was it before, since a
 *     mounted-but-empty folder has always rendered the same way.
 *   - §6 drives `pickFolderHandler` through its `deps` seam and reads
 *     `desktop/main.js` as text. Nothing here launches Electron, so it proves
 *     the wiring EXISTS, not that a packaged app's dialog opens.
 *
 * Dependency-free beyond what the app already ships. No network, no API key,
 * no LLM. Every write lands in os.tmpdir().
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected,
    `${label}${actual === expected ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`);
}
function section(t) { console.log(`\n${t}`); }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * `listDomains()` under test THROWS in some of the cases below, and under a
 * mutation it can throw in cases where it should not. A bare `await` there
 * kills the run on a raw stack trace that names no expectation and leaves the
 * tally wrong — the failure shape recorded in v3.24.1. Every call in this
 * suite goes through here so a mutation REDS a named assertion instead.
 */
async function tryList(mod) {
  try { return { value: await mod.listDomains(), err: null }; }
  catch (err) { return { value: null, err }; }
}

// ── Isolation, before anything imports a path resolver ──────────────────────
// CURATOR_TEST_DOMAINS_DIR and DOMAINS_PATH both outrank the default in
// getDomainsDir(), so a developer with either set would silently point this
// suite at a real wiki. Cleared here and restored at the end.
const savedEnv = {
  CURATOR_TEST_DOMAINS_DIR: process.env.CURATOR_TEST_DOMAINS_DIR,
  CURATOR_TEST_USER_DATA_DIR: process.env.CURATOR_TEST_USER_DATA_DIR,
  DOMAINS_PATH: process.env.DOMAINS_PATH,
};
delete process.env.CURATOR_TEST_DOMAINS_DIR;
delete process.env.CURATOR_TEST_USER_DATA_DIR;
delete process.env.DOMAINS_PATH;

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-firstrun-'));
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const paths  = await import(path.join(ROOT, 'src/brain/paths.js'));
const config = await import(path.join(ROOT, 'src/brain/config.js'));
const files  = await import(path.join(ROOT, 'src/brain/files.js'));

// Fingerprint the REAL user files BEFORE any test runs, so §7 can prove this
// suite never touched them. sha256 + size + existence only — mtime makes this
// fail whenever the maintainer's live app rewrites config during an ordinary
// Settings action (the misattribution shape recorded in v3.0.16).
function fingerprint(p) {
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const names = fs.readdirSync(p).sort().join('\n');
      return `dir:${crypto.createHash('sha256').update(names).digest('hex')}:${fs.readdirSync(p).length}`;
    }
    return `file:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}:${st.size}`;
  } catch (err) { return `absent:${err.code}`; }
}
const REAL_CONFIG_PATH  = paths.getCuratorConfigFile();
const REAL_DOMAINS_PATH = config.getDomainsDir();
const REAL_CONFIG_FP  = fingerprint(REAL_CONFIG_PATH);
const REAL_DOMAINS_FP = fingerprint(REAL_DOMAINS_PATH);

// A throwaway user-data dir shaped like a FRESH BUNDLE INSTALL: it exists (the
// bundle branch of getUserDataDir() mkdirs it), holds no config, and holds no
// domains/ folder. That is precisely the maintainer's reported state — his
// real one holds a 46-byte .curator-config.json and no domains/.
function freshUserDataDir(name) {
  const d = path.join(tmpBase, name);
  fs.mkdirSync(d, { recursive: true });
  paths.__setUserDataDirOverride(d);
  return d;
}
function clearOverride() { paths.__setUserDataDirOverride(null); }

// ═══════════════════════════════════════════════════════════════════════════
section('§1  The reproduction — an ABSENT domains folder is an EMPTY list');
// ═══════════════════════════════════════════════════════════════════════════

{
  const ud = freshUserDataDir('fresh-read');
  const domainsDir = config.getDomainsDir();

  eq(domainsDir, path.join(ud, 'domains'),
    'a fresh install with no config resolves domains/ under the user-data dir');
  ok(!fs.existsSync(domainsDir),
    'ANTI-VACUITY: the folder genuinely does not exist, so §1 is testing the real case');

  // The pre-fix behaviour, established independently of listDomains so the
  // suite is not merely agreeing with the code it checks.
  let rawCode = null;
  try { fs.readdirSync(domainsDir); } catch (err) { rawCode = err.code; }
  eq(rawCode, 'ENOENT',
    'a raw readdir on that path throws ENOENT — the error the UI was rendering');

  let result, threw = null;
  try { result = await files.listDomains(); } catch (err) { threw = err; }
  ok(threw === null,
    `listDomains() does NOT throw on an absent folder${threw ? ` — threw ${threw.code}: ${threw.message}` : ''}`);
  ok(Array.isArray(result) && result.length === 0,
    'listDomains() returns [] — "zero domains" is a true and complete answer');

  clearOverride();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  ABSENT and UNREADABLE must NOT collapse into one answer');
// ═══════════════════════════════════════════════════════════════════════════

{
  // (a) EACCES — a folder that is there and cannot be read is a FAULT.
  const ud = freshUserDataDir('unreadable');
  const domainsDir = path.join(ud, 'domains');
  fs.mkdirSync(domainsDir);
  fs.mkdirSync(path.join(domainsDir, 'somedomain'));
  fs.writeFileSync(path.join(domainsDir, 'somedomain', 'CLAUDE.md'), '# schema\n');

  // Control: prove the list is non-empty while the folder IS readable, so a
  // later [] cannot be mistaken for "there was nothing in it anyway".
  const before = await tryList(files);
  ok(before.err === null && before.value.length === 1 && before.value[0] === 'somedomain',
    `CONTROL: while readable, the folder lists its one real domain${before.err ? ` — threw ${before.err.code}` : ''}`);

  fs.chmodSync(domainsDir, 0o000);
  let canStillRead = true;
  try { fs.readdirSync(domainsDir); } catch { canStillRead = false; }

  if (canStillRead || isRoot) {
    // Running as root (or on a filesystem ignoring the mode) makes this case
    // INEXPRESSIBLE. Report it rather than passing vacuously — a green tick
    // here would claim coverage the run does not have.
    ok(false, 'ENVIRONMENT cannot express an unreadable directory (running as root?) — §2a is UNPROVEN, not passing');
  } else {
    let threw = null, res2 = null;
    try { res2 = await files.listDomains(); } catch (err) { threw = err; }
    ok(threw !== null,
      `an UNREADABLE domains folder still THROWS — it is a fault, not an empty wiki${threw ? '' : ` (got ${JSON.stringify(res2)})`}`);
    eq(threw && threw.code, 'EACCES',
      'and the error is EACCES, surfaced verbatim rather than swallowed');
  }
  fs.chmodSync(domainsDir, 0o700);
  clearOverride();
}

{
  // (b) ENOTDIR — a FILE where the folder should be is a broken install, and
  // reporting it as "no domains yet" would invite the user to start over on
  // top of it.
  const ud = freshUserDataDir('notdir');
  fs.writeFileSync(path.join(ud, 'domains'), 'this is a file, not a directory\n');
  let threw = null, res3 = null;
  try { res3 = await files.listDomains(); } catch (err) { threw = err; }
  ok(threw !== null,
    `a FILE at the domains path still THROWS${threw ? '' : ` (got ${JSON.stringify(res3)})`}`);
  eq(threw && threw.code, 'ENOTDIR',
    'and the error is ENOTDIR — distinguishable from an absent folder');
  clearOverride();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The ROUTE — the first screen gets 200 + [], not 500 + a stack string');
// ═══════════════════════════════════════════════════════════════════════════

{
  const ud = freshUserDataDir('route');
  ok(!fs.existsSync(path.join(ud, 'domains')),
    'ANTI-VACUITY: the route is exercised against a genuinely absent folder');

  const express = (await import('express')).default;
  const domainsRouter = (await import(path.join(ROOT, 'src/routes/domains.js'))).default;
  const app = express();
  app.use('/api/domains', domainsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const hit = (p) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });

    const r1 = await hit('/api/domains');
    eq(r1.status, 200, 'GET /api/domains answers 200 on a fresh install (was 500)');
    let parsed1 = null;
    try { parsed1 = JSON.parse(r1.body); } catch { /* asserted below */ }
    ok(parsed1 && Array.isArray(parsed1.domains) && parsed1.domains.length === 0,
      'GET /api/domains body is {domains: []} — the shape the empty state renders from');
    ok(parsed1 && !parsed1.error,
      'GET /api/domains carries NO error field — nothing for the view to render as a failure');
    ok(!/ENOENT|scandir/.test(r1.body),
      'the ENOENT text the user was shown appears nowhere in the response');

    const r2 = await hit('/api/domains/stats');
    eq(r2.status, 200, 'GET /api/domains/stats answers 200 too (the sidebar reads this one)');
    ok(/"domains":\s*\[\]/.test(r2.body),
      'GET /api/domains/stats body is an empty domains array');
  } finally {
    await new Promise(res => server.close(res));
  }
  clearOverride();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  ensureDefaultDomainsDir — provisions the DEFAULT, refuses the CONFIGURED');
// ═══════════════════════════════════════════════════════════════════════════

{
  const ud = freshUserDataDir('provision');
  const dir = path.join(ud, 'domains');
  ok(!fs.existsSync(dir), 'ANTI-VACUITY: nothing there before the first call');

  const r1 = config.ensureDefaultDomainsDir();
  eq(r1.status, 'created', 'first call on a fresh install reports created');
  eq(r1.dir, dir, 'and names the default location it created');
  ok(fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
    'the folder really is on disk afterwards — sync.setup() can now write .gitignore into it');

  const r2 = config.ensureDefaultDomainsDir();
  eq(r2.status, 'exists', 'second call reports exists — idempotent, writes nothing');

  // The write that used to fail FIRST on a fresh bundle install: sync.setup()
  // opens by writing <domains>/.gitignore, and writeFileAtomic does not create
  // parents. Proven directly rather than asserted about.
  const aw = await import(path.join(ROOT, 'src/brain/atomic-write.js'));
  let gitignoreErr = null;
  try { await aw.writeFileAtomic(path.join(dir, '.gitignore'), '*/raw/\n', 'utf8'); }
  catch (err) { gitignoreErr = err; }
  ok(gitignoreErr === null,
    `Personal Sync's first write (<domains>/.gitignore) now succeeds${gitignoreErr ? ` — ${gitignoreErr.code}` : ''}`);

  clearOverride();
}

{
  // A CONFIGURED domainsPath is the user's folder. Its absence means something
  // — an unmounted drive, a renamed folder — and fabricating an empty one
  // there would shadow a real mount point and present an empty wiki as if it
  // were the user's.
  const ud = freshUserDataDir('configured');
  const chosen = path.join(tmpBase, 'a-folder-the-user-chose-that-is-gone');
  fs.writeFileSync(
    path.join(ud, '.curator-config.json'),
    JSON.stringify({ domainsPath: chosen }, null, 2) + '\n'
  );
  eq(config.getDomainsDir(), chosen, 'CONTROL: the configured path is the one in play');

  const r = config.ensureDefaultDomainsDir();
  eq(r.status, 'not-default', 'a CONFIGURED domainsPath is reported not-default');
  ok(!fs.existsSync(chosen),
    'and is NOT created — the app never fabricates a folder the user pointed at');

  // …which is exactly why the read layer has to tolerate absence on its own.
  const listed = await tryList(files);
  ok(listed.err === null && Array.isArray(listed.value) && listed.value.length === 0,
    `the read layer still answers [] there, so the app stays usable rather than erroring${listed.err ? ` — threw ${listed.err.code}` : ''}`);

  clearOverride();
}

{
  // Failure must be REPORTED and NOT CACHED. paths.js's getUserDataDir()
  // memoises after a failed mkdirSync and then reports 'blocked' for the life
  // of the process even after the user fixes the permission; this function
  // must not repeat that.
  const parent = path.join(tmpBase, 'locked-parent');
  fs.mkdirSync(parent);
  const ud = path.join(parent, 'ud');
  fs.mkdirSync(ud);
  paths.__setUserDataDirOverride(ud);
  fs.chmodSync(ud, 0o500);   // r-x: can traverse, cannot create

  let expressible = true;
  try { fs.mkdirSync(path.join(ud, 'probe')); fs.rmdirSync(path.join(ud, 'probe')); }
  catch { expressible = false; }

  if (expressible || isRoot) {
    ok(false, 'ENVIRONMENT cannot express an unwritable parent (running as root?) — §4c is UNPROVEN, not passing');
    fs.chmodSync(ud, 0o700);
  } else {
    const bad = config.ensureDefaultDomainsDir();
    eq(bad.status, 'failed', 'a failed mkdir is reported as failed, not thrown');
    ok(bad.error && typeof bad.error.message === 'string',
      'and carries the underlying error so startup can say why');

    fs.chmodSync(ud, 0o700);   // the user fixes the permission
    const fixed = config.ensureDefaultDomainsDir();
    eq(fixed.status, 'created',
      'a LATER call after the repair succeeds — the failure was NOT cached (unlike getUserDataDirState)');
  }
  clearOverride();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Repo mode unchanged — WITH the disagreement control that makes it mean something');
// ═══════════════════════════════════════════════════════════════════════════

{
  clearOverride();
  ok(paths.isRepoInstall(), 'CONTROL: this checkout is a repo install, so §5 measures the repo arm');
  const repoDefault = paths.getDefaultDomainsDir();
  eq(config.getDomainsDir(), repoDefault,
    'repo mode resolves domains/ beside the code, exactly as before');
  ok(fs.existsSync(repoDefault),
    'and it ALREADY exists in a checkout (domains/.gitkeep is tracked) — which is why a source install never saw this bug');

  const namesBefore = fs.readdirSync(repoDefault).sort().join('\n');
  const r = config.ensureDefaultDomainsDir();
  eq(r.status, 'exists', 'ensureDefaultDomainsDir() is a NO-OP in repo mode');
  eq(fs.readdirSync(repoDefault).sort().join('\n'), namesBefore,
    'and the real domains/ folder is byte-for-byte the same listing afterwards');

  // THE DISAGREEMENT CONTROL. An equivalence proof that passes in both modes
  // proves nothing: if the bundle-shaped case ALSO reported 'exists', the
  // assertion above would be satisfied by a function that does nothing at all.
  const udBundle = freshUserDataDir('disagreement');
  const bundleResult = config.ensureDefaultDomainsDir();
  clearOverride();
  eq(bundleResult.status, 'created',
    'DISAGREEMENT CONTROL: the same call on a fresh bundle-shaped dir reports created, not exists');
  ok(bundleResult.dir !== r.dir,
    'the two modes resolved DIFFERENT directories, so the pair is a real fork and not one path measured twice');
  ok(bundleResult.dir.startsWith(udBundle),
    'the bundle-shaped answer landed under the user-data dir, never beside the code');

  // The ENOENT branch must not be able to swallow a real domain.
  const udSeeded = freshUserDataDir('seeded');
  const seededDomains = path.join(udSeeded, 'domains', 'realdomain');
  fs.mkdirSync(seededDomains, { recursive: true });
  fs.writeFileSync(path.join(seededDomains, 'CLAUDE.md'), '# schema\n');
  const seededList = await tryList(files);
  ok(seededList.err === null && seededList.value.length === 1 && seededList.value[0] === 'realdomain',
    `a populated folder still lists its domains — the ENOENT branch cannot hide real data${seededList.err ? ` — threw ${seededList.err.code}` : ''}`);
  clearOverride();
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The ESCAPE HATCH — the folder picker must work in a packaged app');
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the route an EXISTING user takes out of a wrong (or empty) knowledge
// folder: point the app at the wiki they already have. If the desktop shell
// registers no pickFolder hook, the bundle arm refuses — fail-safe, but it
// would leave the user with no way out at all, which is far worse than an ugly
// first screen. So the refusal is asserted to be a NAMED, recoverable one, and
// the shell's registration is asserted to exist.

{
  const cfgRoutes = await import(path.join(ROOT, 'src/routes/config.js'));
  const chosen = path.join(tmpBase, 'picked-folder');
  fs.mkdirSync(chosen, { recursive: true });

  function fakeRes() {
    const out = { status: 200, body: null };
    return {
      out,
      status(c) { out.status = c; return this; },
      json(b) { out.body = b; return this; },
    };
  }
  const BUNDLE_CAPS = { folderPickerStyle: 'native-dialog' };
  const REPO_CAPS   = { folderPickerStyle: 'osascript' };
  // setDomainsDir is stubbed at EVERY call site below: the real one writes
  // .curator-config.json, and this suite must never touch it.
  const applied = [];
  const baseDeps = {
    existsSync: fs.existsSync,
    hasActiveWrites: () => false,
    setDomainsDir: (p) => applied.push(p),
    execAsync: async () => { throw new Error('osascript must not run in the bundle arm'); },
  };

  // (a) bundle + a registered hook — the happy path a packaged app must have.
  let res = fakeRes();
  await cfgRoutes.pickFolderHandler({}, res, {
    ...baseDeps, caps: BUNDLE_CAPS,
    pickFolderHook: async () => chosen,
  });
  eq(res.out.status, 200, 'bundle arm with a registered hook answers 200');
  ok(res.out.body && res.out.body.ok === true && res.out.body.path === chosen,
    'and returns the picked folder, so the user can point the app at their existing wiki');
  eq(applied.length, 1, 'the domains path is applied exactly once');
  eq(applied[0], chosen, 'and it is the folder the native dialog returned');

  // (b) bundle + a cancel — must not be mistaken for an error.
  res = fakeRes();
  await cfgRoutes.pickFolderHandler({}, res, {
    ...baseDeps, caps: BUNDLE_CAPS, pickFolderHook: async () => null,
  });
  eq(res.out.status, 200, 'a cancelled native dialog is not an error');
  ok(res.out.body && res.out.body.cancelled === true, 'and reports cancelled');
  eq(applied.length, 1, 'a cancel applies nothing');

  // (c) bundle + NO hook — refuses, and the refusal has to be RECOVERABLE.
  //
  // The first draft asserted only `status >= 400`, and mutation M6 (which made
  // the bundle arm fall through to osascript) kept it GREEN — the fall-through
  // hit this suite's throwing execAsync stub and produced a 500, which is also
  // >= 400. So the assertion that carries the rule is the CALL COUNT: the
  // bundle arm must not reach osascript at all, whatever it then answers.
  let noHookExec = 0;
  res = fakeRes();
  await cfgRoutes.pickFolderHandler({}, res, {
    ...baseDeps, caps: BUNDLE_CAPS, pickFolderHook: null,
    execAsync: async () => { noHookExec++; return { stdout: chosen + '\n' }; },
  });
  eq(noHookExec, 0,
    'bundle arm with NO registered hook does NOT shell out to osascript — under a hardened runtime that is a dead process, not a catchable error');
  ok(res.out.status >= 400,
    'and it refuses rather than reporting success');
  ok(!(res.out.body && res.out.body.ok),
    'the refusal never reports ok — a silent fallback that HAPPENED to work would still be the wrong contract');
  const hint = (res.out.body && res.out.body.hint) || '';
  ok(/type or paste/i.test(hint) && /path/i.test(hint),
    'and the refusal names the typed-path route, so the user still has a way out');
  eq(applied.length, 1, 'a refusal applies nothing');

  // (d) repo arm untouched — it still shells out to osascript.
  let execCalls = 0;
  res = fakeRes();
  await cfgRoutes.pickFolderHandler({}, res, {
    ...baseDeps, caps: REPO_CAPS,
    execAsync: async () => { execCalls++; return { stdout: chosen + '\n' }; },
  });
  eq(execCalls, 1, 'repo arm still runs osascript exactly once — unchanged by this release');
  ok(res.out.body && res.out.body.ok === true && res.out.body.path === chosen,
    'and accepts the folder through the same shared post-pick rules');

  // (e) The desktop shell must actually install the hook, or (c) is what every
  // packaged user gets. Read as TEXT — nothing here launches Electron.
  const mainJs = read('desktop/main.js');
  ok(/registerDesktopHost\s*\(/.test(mainJs),
    'desktop/main.js calls registerDesktopHost — the hook registry is wired at all');
  ok(/pickFolder\s*:/.test(mainJs),
    'desktop/main.js registers a pickFolder hook, so the packaged app takes branch (a) and not (c)');
  ok(/showOpenDialog/.test(mainJs),
    "and that hook is Electron's own dialog rather than a shell-out");
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  The provisioning is actually WIRED — a real server start, not a source scan');
// ═══════════════════════════════════════════════════════════════════════════
//
// §4 proves the function is correct. This proves something else entirely, and
// without it the whole fix could be dead code: that STARTUP calls it. A source
// regex would be satisfied by a call inside an unreachable branch, so the real
// entry point is spawned against a fresh bundle-shaped user-data dir and the
// folder is looked for on disk afterwards.
//
// PORT=0 binds an ephemeral port — it can never collide with the maintainer's
// live app on 3333, or with a packaged app. Every user-data path is isolated,
// which also makes maybeAutoSyncOpenRouter self-skip, so this start is offline.

{
  clearOverride();
  const { spawn } = await import('node:child_process');
  const ud = path.join(tmpBase, 'server-boot');
  fs.mkdirSync(ud, { recursive: true });
  const expected = path.join(ud, 'domains');
  ok(!fs.existsSync(expected), 'ANTI-VACUITY: no domains folder before the server starts');

  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      CURATOR_NO_OPEN: '1',
      CURATOR_TEST_USER_DATA_DIR: ud,
      CURATOR_TEST_LOG_DIR: path.join(ud, 'logs'),
      CURATOR_TEST_MCP_LAUNCHER_DIR: path.join(ud, 'bin'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', c => { out += c; });
  child.stderr.on('data', c => { out += c; });
  try {
    // Poll for the TWO conditions this assertion block actually needs, not a
    // wall-clock sleep. This used to poll fs.existsSync(expected) ALONE and
    // then, the instant it went true, immediately check `out` for the
    // "Created knowledge folder" announcement — but server.js's own order is
    // mkdirSync() (synchronous, complete on disk before it returns) THEN
    // console.error/logInfo (a pipe write the PARENT only sees once libuv
    // delivers the 'data' event). Those are two independently-timed signals:
    // the disk state can go true well before the corresponding stdout bytes
    // land in `out`, especially if the parent's own event loop is delayed by
    // system load. Asserting on `out` immediately after the fs check alone
    // raced that delivery with zero margin — GREEN almost always, since the
    // gap is normally sub-millisecond, and occasionally red for a reason
    // that looks like nothing changed. Wait for BOTH the folder AND the
    // announcement (or the process dying) before asserting on either.
    const waitStarted = Date.now();
    const deadline = waitStarted + 60000;
    let seen = false;
    let folderExists = false;
    let announced = false;
    while (Date.now() < deadline) {
      folderExists = fs.existsSync(expected);
      announced = /Created knowledge folder/.test(out);
      if (folderExists && announced) { seen = true; break; }
      if (child.exitCode !== null) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const waitedMs = Date.now() - waitStarted;
    ok(seen,
      `starting the real src/server.js creates the knowledge folder and announces it (waited ${waitedMs}ms)` +
      (seen ? '' : `\n        folder present: ${folderExists}, announcement seen: ${announced}, process exited: ${child.exitCode !== null ? `yes (code ${child.exitCode})` : 'no'}` +
        `\n        server output:\n${out.split('\n').slice(0, 12).map(l => '        ' + l).join('\n')}`));
    ok(seen && fs.statSync(expected).isDirectory(),
      'and it is a directory Personal Sync can use as its git work-tree');
    ok(announced,
      'startup ANNOUNCES the creation — relocating or creating user data is never silent');
  } finally {
    // Killed by PID, always. A leaked node process holding an ephemeral port
    // is exactly the leak class this repo has recorded four releases running.
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  Isolation — the real user data was never touched');
// ═══════════════════════════════════════════════════════════════════════════

clearOverride();
eq(fingerprint(REAL_CONFIG_PATH), REAL_CONFIG_FP,
  'the real .curator-config.json is unchanged (sha256 + size)');
eq(fingerprint(REAL_DOMAINS_PATH), REAL_DOMAINS_FP,
  'the real domains/ folder has the same entries it started with');
ok(REAL_CONFIG_PATH.startsWith(paths.APP_ROOT),
  'CONTROL: those fingerprints were taken on the REAL paths, not on a tempdir');

// Cleanup + env restore
try { fs.chmodSync(path.join(tmpBase, 'locked-parent', 'ud'), 0o700); } catch { /* best-effort */ }
try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }
for (const [k, v] of Object.entries(savedEnv)) {
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ A fresh install renders EMPTY, an unreadable one still ERRORS');
