/**
 * test-paths.js — OFFLINE suite guarding src/brain/paths.js, the single source
 * of truth for WHERE user data lives.
 *
 * ── Why this suite is load-bearing ──────────────────────────────────────────
 *
 * paths.js exists so The Curator can one day ship as a macOS .app bundle. A
 * signed bundle is READ-ONLY — writing inside it invalidates the signature and
 * macOS refuses to launch it — so user data (.curator-config.json,
 * .sync-config.json, .sharedbrain-config.json, .knowledge-git/, domains/) has to
 * move out of the code directory.
 *
 * It ships one full release BEFORE any packaging work, precisely so it can be
 * proven in the only mode that exists today: a git checkout, where NOTHING
 * should move. Every real user auto-updates from `main` and their entire wiki
 * lives at these paths. If one of them shifts by a single character, that user's
 * app comes up with an empty wiki, no API key, and no sync remote.
 *
 * So the headline assertion here is not "the new code works" — it is
 * **"the new code resolves the exact same absolute strings as the old code"**.
 * Section 1 re-derives every path the OLD way (literally
 * `path.resolve(<the module's own directory>, '../..')`, which is what each
 * module computed for itself before paths.js existed) and asserts byte equality
 * against what paths.js now returns. That comparison is deliberately NOT written
 * in terms of paths.js's own exports, so it cannot pass tautologically.
 *
 * ── What else is covered ────────────────────────────────────────────────────
 *
 *   §1  repo-mode equivalence, path by path (the no-op proof)
 *   §2  isRepoInstall() in BOTH directions, plus the bundle branch, exercised
 *       in child processes against a synthetic app tree (the real APP_ROOT is
 *       fixed at module load, so this is the only honest way to test it)
 *   §3  the TCC guard — bundle mode must never land in ~/Documents, ~/Desktop
 *       or ~/Downloads (see the long rationale in paths.js's docblock)
 *   §4  the existing test seams still win, with their existing precedence:
 *       __setDomainsDirOverride > CURATOR_TEST_DOMAINS_DIR > config.domainsPath
 *       > DOMAINS_PATH > default. DOMAINS_PATH losing to config is deliberate.
 *   §5  source guards — no module may re-derive a user-data path from its own
 *       location, bypassing paths.js. This is the regression that would
 *       silently reintroduce the split-brain the module was written to remove.
 *   §6  MCP safety — paths.js is imported by the stdio child process, so it
 *       must log nothing and import only Node builtins.
 *
 * Dependency-free (node: builtins only), no network, no API key, no writes
 * outside os.tmpdir().
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}${actual === expected ? '' : `\n        expected: ${expected}\n        actual:   ${actual}`}`);
}
function section(t) { console.log(`\n${t}`); }

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const paths = await import(path.join(ROOT, 'src/brain/paths.js'));

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Repo-mode equivalence — every path resolves EXACTLY as before');
// ═══════════════════════════════════════════════════════════════════════════

// Re-derive the OLD way, independently of paths.js. Before this refactor every
// module computed its own root with path.resolve(<its own dir>, '../..')
// (src/server.js used '..'), then joined a literal filename onto it.
const OLD_BRAIN_ROOT  = path.resolve(path.join(ROOT, 'src/brain'),   '../..');
const OLD_ROUTES_ROOT = path.resolve(path.join(ROOT, 'src/routes'),  '../..');
const OLD_SERVER_ROOT = path.resolve(path.join(ROOT, 'src'),         '..');
const OLD_MCP_ROOT    = path.resolve(path.join(ROOT, 'mcp/storage'), '../..');

ok(OLD_BRAIN_ROOT === OLD_ROUTES_ROOT && OLD_BRAIN_ROOT === OLD_SERVER_ROOT
   && OLD_BRAIN_ROOT === OLD_MCP_ROOT,
  'all four historical root derivations agree with each other (sanity)');

const OLD_ROOT = OLD_BRAIN_ROOT;

ok(paths.isRepoInstall(),
  'this checkout is detected as a repo install (has .git) — §1 tests repo mode');

eq(paths.APP_ROOT, OLD_ROOT, 'APP_ROOT === historical PROJECT_ROOT');
eq(paths.getUserDataDir(), OLD_ROOT, 'getUserDataDir() === historical PROJECT_ROOT (repo mode: NOTHING moves)');

// The six user-data locations, each compared against its old literal join.
eq(paths.getCuratorConfigFile(),     path.join(OLD_ROOT, '.curator-config.json'),     'config.js CONFIG_FILE (.curator-config.json)');
eq(paths.getDefaultDomainsDir(),     path.join(OLD_ROOT, 'domains'),                  'config.js DEFAULT_DOMAINS (domains/)');
eq(paths.getSyncGitDir(),            path.join(OLD_ROOT, '.knowledge-git'),           'sync.js GIT_DIR (.knowledge-git)');
eq(paths.getSyncConfigFile(),        path.join(OLD_ROOT, '.sync-config.json'),        'sync.js CONFIG_FILE (.sync-config.json)');
eq(paths.getSharedBrainConfigFile(), path.join(OLD_ROOT, '.sharedbrain-config.json'), 'sharedbrain-config.js CONFIG_FILE');
eq(paths.appPath('package.json'),    path.join(OLD_ROOT, 'package.json'),             'package.json (CODE — stays on APP_ROOT)');
eq(paths.appPath('mcp', 'server.js'), path.join(OLD_ROOT, 'mcp', 'server.js'),        'mcp/server.js path (CODE — stays on APP_ROOT)');

// The credential sweep list — previously duplicated verbatim in server.js and
// diagnostics.js as relative names joined onto PROJECT_ROOT.
const HISTORICAL_CREDENTIAL_RELS = [
  '.curator-config.json',
  '.sync-config.json',
  '.sharedbrain-config.json',
  '.env',
  '.knowledge-git/config',
];
const creds = paths.getCredentialFiles();
eq(creds.length, HISTORICAL_CREDENTIAL_RELS.length, 'credential list has the same number of entries as before');
eq(creds.map(c => c.rel).join(','), HISTORICAL_CREDENTIAL_RELS.join(','), 'credential list has the same entries, in the same order');
for (const rel of HISTORICAL_CREDENTIAL_RELS) {
  const entry = creds.find(c => c.rel === rel);
  eq(entry?.abs, path.join(OLD_ROOT, rel), `credential file resolves as before: ${rel}`);
}

// The live resolvers the app and the MCP actually call must agree with each
// other. A disagreement here is the "Claude Desktop silently reads a stale or
// empty wiki" bug that motivated routing mcp/storage/local.js through paths.js.
const { getDomainsDir } = await import(path.join(ROOT, 'src/brain/config.js'));
const { createStorageAdapter } = await import(path.join(ROOT, 'mcp/storage/local.js'));
eq(path.resolve(createStorageAdapter({}).getBase()), path.resolve(getDomainsDir()),
  'MCP storage adapter resolves the SAME domains folder as the app');
eq(getDomainsDir(), path.join(OLD_ROOT, 'domains'),
  'app getDomainsDir() default is unchanged (no config/env override active in this run)');

// ═══════════════════════════════════════════════════════════════════════════
section('§2  Install-form detection — against a REALISTICALLY built tree');
// ═══════════════════════════════════════════════════════════════════════════

// APP_ROOT is fixed at module load from the module's own location, so the only
// honest way to exercise the bundle branch is to stand up a real app tree in a
// tempdir and import paths.js from inside it.
//
// CRITICAL: these trees are built with `git archive HEAD` — the actual set of
// tracked files a bundle would ship — NOT a synthetic empty directory. An
// earlier version of this suite used a synthetic tree with no files in it, and
// that false premise hid a ship-blocker: `domains/.gitkeep` is TRACKED, so every
// real checkout AND every real bundle contains a `domains/` directory. A
// detection rule that treated `domains/` as proof-of-checkout made bundle mode
// unreachable and would have written inside the read-only bundle. If the tree
// you test against isn't the tree you'd ship, the test proves nothing.
const tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-paths-test-')));
const realPathsSrc = read('src/brain/paths.js');

/**
 * Materialise the real tracked source tree at `dest`, then overlay the current
 * working-tree paths.js (it is untracked, so `git archive` can't carry it).
 */
function materialise(dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('/bin/sh', ['-c',
    `git -C ${JSON.stringify(ROOT)} archive HEAD | tar -x -C ${JSON.stringify(dest)}`]);
  fs.mkdirSync(path.join(dest, 'src', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'src', 'brain', 'paths.js'), realPathsSrc);
  return dest;
}

/** Import paths.js from inside a materialised tree, with a controlled HOME. */
function probe(appRoot, { home }) {
  const script = `
    import * as p from ${JSON.stringify(path.join(appRoot, 'src/brain/paths.js'))};
    process.stdout.write(JSON.stringify({
      isRepo: p.isRepoInstall(),
      isBundle: p.isBundleInstall(),
      appRoot: p.APP_ROOT,
      dataDir: p.getUserDataDir(),
      appSupport: p.getAppSupportDir(),
      curatorConfig: p.getCuratorConfigFile(),
      domains: p.getDefaultDomainsDir(),
      syncGit: p.getSyncGitDir(),
      creds: p.getCredentialFiles(),
      dataDirExists: p.userDataDirExists(),
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],   // capture the bundle notice; don't spam the report
  });
  return JSON.parse(out);
}

const fakeHome = path.join(tmpBase, 'home');
fs.mkdirSync(fakeHome, { recursive: true });

// Sanity: confirm the premise this whole section rests on.
const premise = materialise(path.join(tmpBase, 'premise'));
ok(fs.existsSync(path.join(premise, 'domains')),
  'a shipped tree DOES contain domains/ (domains/.gitkeep is tracked) — so it can never prove "checkout"');
ok(!fs.existsSync(path.join(premise, '.git')),
  'a shipped tree does NOT contain .git — so .git alone can never prove "bundle" either');
ok(!fs.existsSync(path.join(premise, '.curator-config.json')),
  'a shipped tree does NOT contain .curator-config.json');

// ── Repo install (the only form that exists today) ──────────────────────────
const repoApp = materialise(path.join(tmpBase, 'checkout'));
fs.mkdirSync(path.join(repoApp, '.git'), { recursive: true });
const r = probe(repoApp, { home: fakeHome });
ok(r.isRepo === true && r.isBundle === false, 'a normal checkout is a repo install');
eq(r.dataDir, r.appRoot, 'repo mode: getUserDataDir() === APP_ROOT');
eq(r.curatorConfig, path.join(repoApp, '.curator-config.json'), 'repo mode: config file sits in the checkout');
eq(r.domains, path.join(repoApp, 'domains'), 'repo mode: default domains dir sits in the checkout');
ok(!fs.existsSync(path.join(fakeHome, 'Library', 'Application Support', 'The Curator')),
  'repo mode creates NOTHING in ~/Library/Application Support (pure resolver, no side effects)');

// ── H1: no amount of MISSING files may relocate a live install ──────────────
// This was the original ship-blocker. With detection inverted it is closed by
// construction — "unknown layout" resolves to repo — but these vectors are the
// real-world ways a checkout loses its markers, so they stay pinned.
const h1Vectors = [
  ['zip-download',    a => fs.rmSync(path.join(a, '.git'), { recursive: true, force: true }),
   'GitHub "Download ZIP" / user deleted .git to save space'],
  ['no-domains',      a => fs.rmSync(path.join(a, 'domains'), { recursive: true, force: true }),
   'a copy that dropped domains/'],
  ['bare-tree',       a => { fs.rmSync(path.join(a, '.git'), { recursive: true, force: true });
                             fs.rmSync(path.join(a, 'domains'), { recursive: true, force: true }); },
   'no .git AND no domains/ — an unrecognised layout'],
  ['git-as-file',     a => { fs.rmSync(path.join(a, '.git'), { recursive: true, force: true });
                             fs.writeFileSync(path.join(a, '.git'), 'gitdir: /elsewhere/.git'); },
   '.git as a FILE (git worktree / submodule gitlink)'],
];
for (const [name, mutate, label] of h1Vectors) {
  const tree = materialise(path.join(tmpBase, `h1-${name}`));
  fs.mkdirSync(path.join(tree, '.git'), { recursive: true });
  mutate(tree);
  const v = probe(tree, { home: fakeHome });
  ok(v.isRepo === true, `stays a repo install: ${label}`);
  eq(v.dataDir, v.appRoot, `  └─ data stays in place, nothing relocates: ${name}`);
}

// ── Bundle install: BOTH positive signals, on a realistically built tree ────
const expectedSupport = path.join(fakeHome, 'Library', 'Application Support', 'The Curator');

// (a) macOS bundle layout — the tree lives at <X>.app/Contents/Resources.
const macBundle = materialise(path.join(tmpBase, 'Curator.app', 'Contents', 'Resources'));
const b = probe(macBundle, { home: fakeHome });
ok(b.isBundle === true && b.isRepo === false,
  'a tree inside <X>.app/Contents/ is a BUNDLE — even though it contains domains/');
ok(fs.existsSync(path.join(macBundle, 'domains')),
  '  └─ and it really does contain domains/ (the trap the old rule fell into)');
eq(b.dataDir, expectedSupport, 'bundle mode: getUserDataDir() === ~/Library/Application Support/The Curator');
ok(!b.dataDir.startsWith(b.appRoot), 'bundle mode: user data is OUTSIDE the read-only app root');
eq(b.curatorConfig, path.join(expectedSupport, '.curator-config.json'), 'bundle mode: config file moves to the data dir');
eq(b.domains, path.join(expectedSupport, 'domains'), 'bundle mode: default domains dir moves to the data dir');
eq(b.syncGit, path.join(expectedSupport, '.knowledge-git'), 'bundle mode: sync git dir moves to the data dir');
ok(fs.existsSync(expectedSupport), 'bundle mode creates the data dir (a bundle has nowhere else to write)');
ok(b.dataDirExists === true, 'bundle mode: userDataDirExists() true after creation');

// (b) explicit packager marker — works at any path, no .app in sight.
const markedBundle = materialise(path.join(tmpBase, 'marked'));
fs.writeFileSync(path.join(markedBundle, '.curator-bundle'), '');
const m = probe(markedBundle, { home: fakeHome });
ok(m.isBundle === true, 'the packager marker file alone declares a bundle, at any path');
eq(m.dataDir, expectedSupport, '  └─ and relocates user data accordingly');

// A near-miss must NOT trip the path heuristic.
const nearMiss = materialise(path.join(tmpBase, 'notabundle.app', 'src-copy'));
ok(probe(nearMiss, { home: fakeHome }).isRepo === true,
  'a ".app" component NOT followed by Contents/ is not a bundle (strict segment match)');

// .env is a developer-only fallback that dotenv reads relative to cwd, so it
// stays anchored to the CODE root — but every other credential file follows the
// data dir, which is what makes the startup chmod sweep still find them.
const bEnv = b.creds.find(c => c.rel === '.env');
const bCfg = b.creds.find(c => c.rel === '.curator-config.json');
const bGit = b.creds.find(c => c.rel === '.knowledge-git/config');
eq(bEnv.abs, path.join(b.appRoot, '.env'), 'bundle mode: .env stays on the app root (dev-only, cwd-relative)');
eq(bCfg.abs, path.join(expectedSupport, '.curator-config.json'), 'bundle mode: chmod sweep follows .curator-config.json to the data dir');
eq(bGit.abs, path.join(expectedSupport, '.knowledge-git', 'config'), 'bundle mode: chmod sweep follows .knowledge-git/config to the data dir');

// N1: the data dir holds API keys and a GitHub PAT — 0700, not 0755.
const supportMode = fs.statSync(expectedSupport).mode & 0o777;
ok(supportMode === 0o700, `bundle data dir is created 0700, not world-readable (got ${supportMode.toString(8)})`);

// The bundle transition must announce itself — on STDERR, never stdout. A
// single stray stdout byte corrupts the MCP's JSON-RPC framing (v2.5.3 bug).
const notice = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import * as p from ${JSON.stringify(path.join(macBundle, 'src/brain/paths.js'))};
  p.getUserDataDir(); p.getUserDataDir(); p.getUserDataDir();
`], { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
ok(notice.stdout === '', `bundle-mode notice writes NOTHING to stdout (got ${JSON.stringify(notice.stdout.slice(0, 60))})`);
ok(/packaged app/.test(notice.stderr), 'bundle-mode notice is emitted on stderr');
ok(/do not re-run onboarding/.test(notice.stderr), 'bundle-mode notice tells the user their data is not lost');
eq((notice.stderr.match(/packaged app/g) || []).length, 1,
  'bundle-mode notice is emitted ONCE per process, not on every resolution');

// The test seam must beat both branches.
const overrideProbe = execFileSync(process.execPath, ['--input-type=module', '-e', `
  import * as p from ${JSON.stringify(path.join(macBundle, 'src/brain/paths.js'))};
  p.__setUserDataDirOverride('/tmp/curator-seam-check');
  const forced = p.getUserDataDir();
  p.__setUserDataDirOverride(null);
  process.stdout.write(JSON.stringify({ forced, restored: p.getUserDataDir() }));
`], { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
const ov = JSON.parse(overrideProbe);
eq(ov.forced, path.resolve('/tmp/curator-seam-check'), '__setUserDataDirOverride() wins over the real resolution');
eq(ov.restored, expectedSupport, '__setUserDataDirOverride(null) restores the real resolution (no cached poisoning)');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  TCC guard — bundle mode must not touch protected directories');
// ═══════════════════════════════════════════════════════════════════════════

// ~/Documents, ~/Desktop and ~/Downloads are TCC-protected on macOS. The MCP
// server runs as a headless child of Claude Desktop, so a permission prompt
// would be attributed to Claude Desktop and may never render at all. See the
// full rationale in paths.js's docblock — do not "helpfully" move this.
for (const forbidden of ['Documents', 'Desktop', 'Downloads', 'Movies', 'Music', 'Pictures']) {
  const dir = path.join(fakeHome, forbidden) + path.sep;
  ok(!(b.dataDir + path.sep).startsWith(dir), `bundle data dir is NOT under ~/${forbidden} (TCC-protected)`);
}
ok(paths.getAppSupportDir().includes(path.join('Library', 'Application Support')),
  'getAppSupportDir() targets ~/Library/Application Support (not TCC-protected)');
ok(read('src/brain/paths.js').includes('TCC'),
  'paths.js documents the TCC rationale, so nobody relocates this by accident');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The existing test seams still win, with unchanged precedence');
// ═══════════════════════════════════════════════════════════════════════════

// getDomainsDir's precedence is: __setDomainsDirOverride > CURATOR_TEST_DOMAINS_DIR
// > config.domainsPath > DOMAINS_PATH > default. paths.js only supplies the
// DEFAULT — every override above it must still take priority.
const cfgModule = await import(path.join(ROOT, 'src/brain/config.js'));
const seamDir = path.join(tmpBase, 'seam-domains');

const savedEnvTest = process.env.CURATOR_TEST_DOMAINS_DIR;
const savedEnvLegacy = process.env.DOMAINS_PATH;
try {
  cfgModule.__setDomainsDirOverride(seamDir);
  eq(cfgModule.getDomainsDir(), path.resolve(seamDir), '__setDomainsDirOverride() still beats everything');

  cfgModule.__setDomainsDirOverride(null);
  process.env.CURATOR_TEST_DOMAINS_DIR = seamDir;
  eq(cfgModule.getDomainsDir(), path.resolve(seamDir), 'CURATOR_TEST_DOMAINS_DIR still beats config + the new default');

  cfgModule.__setDomainsDirOverride(path.join(tmpBase, 'higher'));
  eq(cfgModule.getDomainsDir(), path.resolve(path.join(tmpBase, 'higher')),
    '__setDomainsDirOverride() still outranks CURATOR_TEST_DOMAINS_DIR');
} finally {
  cfgModule.__setDomainsDirOverride(null);
  if (savedEnvTest === undefined) delete process.env.CURATOR_TEST_DOMAINS_DIR;
  else process.env.CURATOR_TEST_DOMAINS_DIR = savedEnvTest;
  if (savedEnvLegacy === undefined) delete process.env.DOMAINS_PATH;
  else process.env.DOMAINS_PATH = savedEnvLegacy;
}

// Source-level: DOMAINS_PATH must stay BELOW config.domainsPath. That ordering
// is deliberate (a real install almost always has domainsPath in config, which
// is why CURATOR_TEST_DOMAINS_DIR exists at all) and is easy to "tidy" wrongly.
const configSrc = read('src/brain/config.js');
const iOverride = configSrc.indexOf('_domainsDirOverride');
const iTestEnv  = configSrc.indexOf('CURATOR_TEST_DOMAINS_DIR');
const iCfgPath  = configSrc.indexOf('cfg.domainsPath');
const iLegacy   = configSrc.indexOf('process.env.DOMAINS_PATH');
const iDefault  = configSrc.indexOf('return getDefaultDomainsDir();');
ok(iOverride > -1 && iTestEnv > -1 && iCfgPath > -1 && iLegacy > -1 && iDefault > -1,
  'getDomainsDir still contains all five precedence rungs');
ok(iOverride < iTestEnv && iTestEnv < iCfgPath && iCfgPath < iLegacy && iLegacy < iDefault,
  'precedence order is unchanged: override > CURATOR_TEST_DOMAINS_DIR > config > DOMAINS_PATH > default');
ok(/return getDefaultDomainsDir\(\);/.test(configSrc),
  'config.js takes its default domains dir from paths.js');

const syncSrc = read('src/brain/sync.js');
ok(/__setSyncTestOverrides/.test(syncSrc) && /_gitDirOverride \|\| getSyncGitDir\(\)/.test(syncSrc)
   && /_configFileOverride \|\| getSyncConfigFile\(\)/.test(syncSrc),
  'sync.js test seam (__setSyncTestOverrides) is intact and still outranks the resolved paths');

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Source guards — nothing may bypass paths.js');
// ═══════════════════════════════════════════════════════════════════════════

/** Every .js file under src/ and mcp/, excluding src/public (browser code). */
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs, acc); }
    else if (e.name.endsWith('.js')) acc.push(abs);
  }
  return acc;
}
const serverFiles = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'mcp'))]
  .filter(f => !f.includes(`${path.sep}public${path.sep}`))
  .map(f => ({ rel: path.relative(ROOT, f), src: fs.readFileSync(f, 'utf8') }));

ok(serverFiles.length > 20, `scanned ${serverFiles.length} server/MCP source files`);

// (a) No module other than paths.js may derive an app root from its own
//     location. That shape is what let mcp/storage/local.js drift from the app.
const ROOT_DERIVATION = /path\.resolve\(\s*__dirname\s*,\s*['"]\.\.(?:\/\.\.)?['"]\s*\)/;
const rootDerivers = serverFiles.filter(f =>
  f.rel !== path.join('src', 'brain', 'paths.js') && ROOT_DERIVATION.test(f.src));
ok(rootDerivers.length === 0,
  rootDerivers.length === 0
    ? 'no module re-derives an app root from its own location (only paths.js does)'
    : `these modules bypass paths.js by deriving their own root: ${rootDerivers.map(f => f.rel).join(', ')}`);

// (b) The user-data filenames may only be JOINED onto a path inside paths.js.
//     Mentions in comments/strings elsewhere are fine; a path.join is not.
const DATA_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json', '.knowledge-git'];
const joiners = [];
for (const f of serverFiles) {
  if (f.rel === path.join('src', 'brain', 'paths.js')) continue;
  for (const name of DATA_FILES) {
    const re = new RegExp(`path\\.(?:join|resolve)\\([^)]*['"\`][^'"\`]*${name.replace(/\./g, '\\.')}`);
    if (re.test(f.src)) joiners.push(`${f.rel} → ${name}`);
  }
}
ok(joiners.length === 0,
  joiners.length === 0
    ? 'no module constructs a user-data file path itself — all go through paths.js'
    : `these construct user-data paths outside paths.js: ${joiners.join(', ')}`);

// (b2) M1 REGRESSION GUARD: no module may SNAPSHOT a paths.js getter into a
//      module-level binding. `const CONFIG_FILE = getCuratorConfigFile()` is
//      evaluated at import time, so a test seam set afterwards silently no-ops
//      and the module keeps using the developer's REAL credential files.
//      Resolve per call (a `const x = () => getX()` arrow is fine).
//
//      SCOPE — this guard is a tripwire, NOT a proof. It catches the shapes we
//      expect a maintainer to write: const/let/var, a namespace-qualified call
//      (`paths.getX()`), and a getter wrapped in a path.join(). It does NOT
//      catch an aliased import (`import { getX as g }`), an indirect call
//      through a variable, or a computed member access. Those were checked by
//      hand at the time of writing and don't exist in the tree; if this ever
//      needs to be airtight it wants a real AST walk (acorn), not more regex.
const SNAPSHOTTABLE = [
  'getCuratorConfigFile', 'getSyncConfigFile', 'getSyncGitDir',
  'getSharedBrainConfigFile', 'getDefaultDomainsDir', 'getUserDataDir', 'userDataPath',
];
const snapshots = [];
for (const f of serverFiles) {
  if (f.rel === path.join('src', 'brain', 'paths.js')) continue;
  for (const getter of SNAPSHOTTABLE) {
    // Top-level `const|let|var NAME = ... getter(` on one line, allowing a
    // namespace qualifier (paths.getX) and any wrapping call (path.join(getX(…))).
    // An arrow body (`= () => getter()`) is explicitly exempt.
    const re = new RegExp(
      `^(?:export\\s+)?(?:const|let|var)\\s+\\w+\\s*=\\s*(?!\\(?\\)?\\s*=>)[^=\\n]*?\\b(?:\\w+\\.)?${getter}\\s*\\(`,
      'm');
    if (re.test(f.src)) snapshots.push(`${f.rel} → ${getter}()`);
  }
}
ok(snapshots.length === 0,
  snapshots.length === 0
    ? 'no module snapshots a paths.js getter at import time (test seams stay effective)'
    : `these snapshot a paths.js getter into a module-level binding, defeating the test seams: ${snapshots.join(', ')}`);

// (b3) The three credential-file consumers must resolve per call.
for (const [rel, needle] of [
  [path.join('src', 'brain', 'config.js'),             'const configFile = () => getCuratorConfigFile()'],
  [path.join('src', 'brain', 'sharedbrain-config.js'), 'const configFile = () => getSharedBrainConfigFile()'],
]) {
  const f = serverFiles.find(x => x.rel === rel);
  ok(f && f.src.includes(needle), `${rel} resolves its credential file per call`);
}

// (c) The credential list must exist in exactly one place.
const serverSrc = read('src/server.js');
const diagSrc   = read('src/brain/diagnostics.js');
ok(serverSrc.includes('getCredentialFiles()'), 'server.js startup chmod sweep uses paths.js getCredentialFiles()');
ok(diagSrc.includes('getCredentialFiles()'), 'diagnostics.js credential check uses paths.js getCredentialFiles()');
for (const [label, src] of [['server.js', serverSrc], ['diagnostics.js', diagSrc]]) {
  const hasOwnList = /['"]\.sync-config\.json['"]\s*,\s*\n?\s*['"]\.sharedbrain-config\.json['"]/.test(src);
  ok(!hasOwnList, `${label} no longer carries its own copy of the credential list`);
}
ok(/mode:\s*0o600/.test(read('src/brain/config.js')), 'config.js still writes .curator-config.json at 0600');
ok(/mode:\s*0o600/.test(syncSrc), 'sync.js still writes .sync-config.json at 0600');
ok(/mode:\s*0o600/.test(read('src/brain/sharedbrain-config.js')), 'sharedbrain-config.js still writes at 0600');
ok(/chmodSync\(abs, 0o600\)/.test(serverSrc), 'server.js startup sweep still chmods to 0600');

// (c2) L1: the MCP must honour the same wholesale test-isolation env as the app,
//      so a spawned MCP child can be pointed at a tempdir. Verified behaviourally
//      (and that it does NOT leak into production, where the var is never set).
const isoDir = path.join(tmpBase, 'mcp-isolated');
fs.mkdirSync(isoDir, { recursive: true });
const savedIso = process.env.CURATOR_TEST_DOMAINS_DIR;
try {
  process.env.CURATOR_TEST_DOMAINS_DIR = isoDir;
  const { createStorageAdapter: mk } = await import(
    `${path.join(ROOT, 'mcp/storage/local.js')}?iso=1`);
  eq(path.resolve(mk({}).getBase()), path.resolve(isoDir),
    'MCP honours CURATOR_TEST_DOMAINS_DIR (spawned children can be isolated)');
  eq(path.resolve(mk({ domainsPath: path.join(tmpBase, 'cli-arg') }).getBase()), path.resolve(isoDir),
    'MCP test-isolation outranks the --domains-path CLI arg (a test that sets it means it)');
} finally {
  if (savedIso === undefined) delete process.env.CURATOR_TEST_DOMAINS_DIR;
  else process.env.CURATOR_TEST_DOMAINS_DIR = savedIso;
}
const { createStorageAdapter: mkProd } = await import(
  `${path.join(ROOT, 'mcp/storage/local.js')}?prod=1`);
eq(path.resolve(mkProd({ domainsPath: path.join(tmpBase, 'cli-arg') }).getBase()),
   path.resolve(path.join(tmpBase, 'cli-arg')),
  'with the env unset the CLI arg wins again — no production behaviour change');

// (d) The MCP adapter must resolve through paths.js, not its own derivation.
const mcpLocalSrc = read('mcp/storage/local.js');
ok(/from '\.\.\/\.\.\/src\/brain\/paths\.js'/.test(mcpLocalSrc),
  'mcp/storage/local.js imports paths.js (no independent config-path derivation)');
ok(!/CURATOR_ROOT/.test(mcpLocalSrc),
  'mcp/storage/local.js no longer has its own CURATOR_ROOT constant');

// ═══════════════════════════════════════════════════════════════════════════
section('§6  MCP safety — paths.js is loaded by the stdio child process');
// ═══════════════════════════════════════════════════════════════════════════

const pathsSrc = read('src/brain/paths.js');
const codeOnly = pathsSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
  .replace(/^\s*\/\/.*$/gm, '');      // line comments
const consoleCalls = [...codeOnly.matchAll(/console\.(\w+)/g)].map(m => m[1]);
ok(!consoleCalls.some(m => m !== 'error'),
  consoleCalls.every(m => m === 'error')
    ? `paths.js writes only to stderr (console.error ×${consoleCalls.length}) — stdout is reserved for JSON-RPC frames in the MCP child`
    : `paths.js uses non-stderr console methods: ${[...new Set(consoleCalls.filter(m => m !== 'error'))].join(', ')}`);
ok(consoleCalls.length > 0,
  'paths.js announces the bundle branch on stderr — relocating all user data is never silent');
const imports = [...codeOnly.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
ok(imports.length > 0, `paths.js has ${imports.length} import(s)`);
const nonBuiltin = imports.filter(i => !/^(node:)?(path|os|fs|url)$/.test(i));
ok(nonBuiltin.length === 0,
  nonBuiltin.length === 0
    ? 'paths.js imports only Node builtins (safe + cheap for the MCP child)'
    : `paths.js pulled in non-builtin imports: ${nonBuiltin.join(', ')}`);
ok(/export function __setUserDataDirOverride/.test(pathsSrc),
  'paths.js exposes a test seam for the data dir');
ok(/export function getUserDataDirState/.test(pathsSrc),
  'paths.js exposes getUserDataDirState() — the seam a future bundle migration hangs off');

// ═══════════════════════════════════════════════════════════════════════════
section('§7  The seams are import-order independent, and cross process boundaries');
// ═══════════════════════════════════════════════════════════════════════════

// A module-level `const CONFIG_FILE = getCuratorConfigFile()` snapshots the
// value at IMPORT time. paths.js would then honour a later override while the
// consumer kept using the real path — a seam that silently no-ops. That is not
// hypothetical: it would mean a test reading and WRITING the maintainer's real
// .curator-config.json / .sync-config.json (GitHub PAT) / .sharedbrain-config.json.
//
// These probes drive the REAL config.js, importing it BEFORE the seam is set.
// A backstop env var is set first so that even a total failure of both seams
// writes into a tempdir, never the developer's real files.
function seamProbe(label, { envDir, overrideDir, importFirst }) {
  const script = `
    ${importFirst ? `import * as cfg from ${JSON.stringify(path.join(ROOT, 'src/brain/config.js'))};` : ''}
    import * as p from ${JSON.stringify(path.join(ROOT, 'src/brain/paths.js'))};
    ${!importFirst ? `const cfg = await import(${JSON.stringify(path.join(ROOT, 'src/brain/config.js'))});` : ''}
    ${overrideDir ? `p.__setUserDataDirOverride(${JSON.stringify(overrideDir)});` : ''}
    cfg.setApiKeys({ geminiApiKey: 'seam-probe-key' });
    process.stdout.write(JSON.stringify({ resolved: p.getCuratorConfigFile() }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CURATOR_TEST_USER_DATA_DIR: envDir },
    encoding: 'utf8',
  });
  if (r.status !== 0) return { error: (r.stderr || '').trim().split('\n').slice(-3).join(' ') };
  return JSON.parse(r.stdout);
}

const envOnlyDir = path.join(tmpBase, 'seam-env');
const overrideDir = path.join(tmpBase, 'seam-override');
fs.mkdirSync(envOnlyDir, { recursive: true });
fs.mkdirSync(overrideDir, { recursive: true });

// M4: the env seam alone must isolate the credential files, in a spawned child.
const envRun = seamProbe('env', { envDir: envOnlyDir, overrideDir: null, importFirst: true });
ok(!envRun.error, `env-seam probe ran${envRun.error ? `: ${envRun.error}` : ''}`);
eq(envRun.resolved, path.join(envOnlyDir, '.curator-config.json'),
  'CURATOR_TEST_USER_DATA_DIR redirects the config path in a SPAWNED child');
ok(fs.existsSync(path.join(envOnlyDir, '.curator-config.json')),
  'config.js actually WROTE into the env-isolated dir (not just resolved there)');

// M1: the in-process override must win even when set AFTER config.js is loaded.
const orderRun = seamProbe('order', { envDir: envOnlyDir, overrideDir, importFirst: true });
ok(!orderRun.error, `import-order probe ran${orderRun.error ? `: ${orderRun.error}` : ''}`);
eq(orderRun.resolved, path.join(overrideDir, '.curator-config.json'),
  '__setUserDataDirOverride() set AFTER importing config.js still redirects it');
ok(fs.existsSync(path.join(overrideDir, '.curator-config.json')),
  'config.js wrote to the LATE override target — the seam is not snapshotted at import');

// M-B: pin the EXACT boundary of what the env seam isolates, so the docblock
// claim is enforced rather than merely asserted in prose. The four credential
// locations are unconditional; domains/ is NOT, because getDomainsDir() still
// consults DOMAINS_PATH above its default. A test that needs domains isolated
// must also set CURATOR_TEST_DOMAINS_DIR (or ensure DOMAINS_PATH is unset).
function isolationProbe(extraEnv) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import * as p from ${JSON.stringify(path.join(ROOT, 'src/brain/paths.js'))};
    const c = await import(${JSON.stringify(path.join(ROOT, 'src/brain/config.js'))});
    const s = await import(${JSON.stringify(path.join(ROOT, 'src/brain/sync.js'))});
    process.stdout.write(JSON.stringify({
      cfg: p.getCuratorConfigFile(), sync: p.getSyncConfigFile(),
      sb: p.getSharedBrainConfigFile(), git: p.getSyncGitDir(),
      domains: c.getDomainsDir(), syncConfigured: s.isConfigured(),
    }));
  `], { env: { ...process.env, CURATOR_TEST_USER_DATA_DIR: envOnlyDir, ...extraEnv }, encoding: 'utf8' });
  return JSON.parse(r.stdout);
}

const clean = isolationProbe({ DOMAINS_PATH: '' });
for (const [key, name] of [['cfg', '.curator-config.json'], ['sync', '.sync-config.json'],
                           ['sb', '.sharedbrain-config.json'], ['git', '.knowledge-git']]) {
  ok(clean[key].startsWith(envOnlyDir), `env seam isolates ${name} unconditionally`);
}
ok(clean.syncConfigured === false,
  'an env-isolated run reports sync UNCONFIGURED — the real GitHub PAT is out of reach');
ok(clean.domains.startsWith(envOnlyDir), 'env seam isolates domains/ when nothing overrides it');

const leakDir = path.join(tmpBase, 'NOT_ISOLATED_WIKI');
const leaked = isolationProbe({ DOMAINS_PATH: leakDir });
ok(leaked.cfg.startsWith(envOnlyDir),
  'DOMAINS_PATH does NOT compromise credential isolation (the important half)');
eq(path.resolve(leaked.domains), path.resolve(leakDir),
  'DOMAINS_PATH still wins for domains/ — the documented limit of the env seam, pinned here');

// The real config must be untouched by any of the above.
eq(paths.getCuratorConfigFile(), path.join(OLD_ROOT, '.curator-config.json'),
  'the real config path is unaffected by the child probes');

// ═══════════════════════════════════════════════════════════════════════════
section('§8  getUserDataDirState() — the migration trigger');
// ═══════════════════════════════════════════════════════════════════════════

// A bare "does it exist" boolean cannot drive the one-time import: it reports
// true for a regular FILE at that path (after which every write fails ENOTDIR),
// and cannot tell "fresh install, offer migration" from "already set up".
function stateWith(target) {
  paths.__setUserDataDirOverride(target);
  try { return { state: paths.getUserDataDirState(), exists: paths.userDataDirExists() }; }
  finally { paths.__setUserDataDirOverride(null); }
}

const stMissing = stateWith(path.join(tmpBase, 'state-nope'));
eq(stMissing.state, 'missing', "absent dir → 'missing'");
ok(stMissing.exists === false, 'userDataDirExists() false for an absent dir');

const emptyDir = path.join(tmpBase, 'state-empty');
fs.mkdirSync(emptyDir, { recursive: true });
const stEmpty = stateWith(emptyDir);
eq(stEmpty.state, 'empty', "existing but Curator-less dir → 'empty' (THE migration trigger)");
ok(stEmpty.exists === true, 'userDataDirExists() true for a real empty dir');

const readyCfg = path.join(tmpBase, 'state-ready-cfg');
fs.mkdirSync(readyCfg, { recursive: true });
fs.writeFileSync(path.join(readyCfg, '.curator-config.json'), '{}');
eq(stateWith(readyCfg).state, 'ready', "dir holding .curator-config.json → 'ready'");

const readyDomains = path.join(tmpBase, 'state-ready-domains');
fs.mkdirSync(path.join(readyDomains, 'domains'), { recursive: true });
eq(stateWith(readyDomains).state, 'ready', "dir holding domains/ → 'ready'");

// M-C: an EXISTING-BUT-UNUSABLE dir is 'blocked', not 'missing'. A caller that
// sees 'missing' would happily try to create/populate it; 'blocked' says stop.
const brokenLink = path.join(tmpBase, 'state-broken-symlink');
fs.symlinkSync(path.join(tmpBase, 'state-target-that-does-not-exist'), brokenLink);
const stLink = stateWith(brokenLink);
eq(stLink.state, 'blocked', "a BROKEN SYMLINK → 'blocked', not 'missing' (statSync ENOENT is ambiguous)");
ok(stLink.exists === false, 'userDataDirExists() false for a broken symlink');

if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
  const noRead = path.join(tmpBase, 'state-unreadable');
  fs.mkdirSync(noRead, { recursive: true });
  fs.chmodSync(noRead, 0o000);
  try {
    eq(stateWith(noRead).state, 'blocked', "an UNREADABLE directory → 'blocked', not 'missing'");
  } finally { fs.chmodSync(noRead, 0o700); }
} else {
  ok(true, 'unreadable-directory case skipped (root or non-POSIX)');
}

// M-C: the mkdir failure must be keyed to the dir it happened for. If it were a
// sticky module-level flag, one transient failure would make the migration seam
// answer 'blocked' for the rest of the process — permanently refusing to offer
// migration until relaunch — even when pointed at a healthy directory.
const healthy = path.join(tmpBase, 'state-healthy-after-failure');
fs.mkdirSync(healthy, { recursive: true });
const stickyProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import * as p from ${JSON.stringify(path.join(ROOT, 'src/brain/paths.js'))};
  // Force a real mkdir failure by pointing the bundle branch's parent at a FILE.
  const bad = ${JSON.stringify(path.join(tmpBase, 'state-is-a-file'))} + '/child';
  p.__setUserDataDirOverride(bad);
  const first = p.getUserDataDirState();
  p.__setUserDataDirOverride(${JSON.stringify(healthy)});
  const second = p.getUserDataDirState();
  process.env.CURATOR_TEST_USER_DATA_DIR = ${JSON.stringify(healthy)};
  p.__setUserDataDirOverride(null);
  process.stdout.write(JSON.stringify({ first, second, viaEnv: p.getUserDataDirState() }));
`], { encoding: 'utf8' });
const sticky = JSON.parse(stickyProbe.stdout);
ok(sticky.first !== 'ready', `an unusable dir does not report 'ready' (got '${sticky.first}')`);
eq(sticky.second, 'empty', 'a healthy dir reports its own state after an earlier failure (error is not sticky)');
eq(sticky.viaEnv, 'empty', 'the ENV seam also gets a clean state — not a stale blocked flag');

// The regression the audit caught: a regular FILE must never read as usable.
const fileNotDir = path.join(tmpBase, 'state-is-a-file');
fs.writeFileSync(fileNotDir, 'not a directory');
const stFile = stateWith(fileNotDir);
eq(stFile.state, 'blocked', "a regular FILE at the data path → 'blocked', not 'ready'");
ok(stFile.exists === false,
  'userDataDirExists() is FALSE for a regular file (every later write would fail ENOTDIR)');

// ═══════════════════════════════════════════════════════════════════════════
section('§9  MCP domains-path precedence now matches the app (config outranks DOMAINS_PATH)');
// ═══════════════════════════════════════════════════════════════════════════

// Prior bug: mcp/storage/local.js ranked DOMAINS_PATH ABOVE .curator-config.json,
// while src/brain/config.js's getDomainsDir() ranked config ABOVE DOMAINS_PATH —
// so a user with both set got Claude Desktop reading a different wiki than the
// app showed. This section drives the REAL createStorageAdapter() (not a source
// regex) with a real temp config file and real env vars, and separately proves
// config.js's real getDomainsDir() resolves the SAME folder on the same inputs —
// the actual guarantee this fix exists to provide.
const p9Base = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-mcp-precedence-'));
const p9ConfigDomains = path.join(p9Base, 'from-config');
const p9EnvDomains = path.join(p9Base, 'from-env');
const p9CliDomains = path.join(p9Base, 'from-cli-arg');
const p9TestSeamDomains = path.join(p9Base, 'from-test-seam');

const savedEnvP9DomainsPath = process.env.DOMAINS_PATH;
const savedEnvP9TestSeam = process.env.CURATOR_TEST_DOMAINS_DIR;
try {
  delete process.env.DOMAINS_PATH;
  delete process.env.CURATOR_TEST_DOMAINS_DIR;
  paths.__setUserDataDirOverride(p9Base);
  cfgModule.__setDomainsDirOverride(null); // config.js has its OWN override; keep it null so it falls through to the real config-file/env logic below

  // (a) Nothing configured at all → falls through to the default.
  eq(path.resolve(createStorageAdapter({}).getBase()), path.resolve(path.join(p9Base, 'domains')),
    '(a) nothing set → default, <user-data dir>/domains');
  eq(cfgModule.getDomainsDir(), path.resolve(path.join(p9Base, 'domains')),
    '(a) config.js agrees: default when nothing is set');

  // (b) DOMAINS_PATH alone (no config file, no CLI arg) → the env var still works.
  process.env.DOMAINS_PATH = p9EnvDomains;
  eq(path.resolve(createStorageAdapter({}).getBase()), path.resolve(p9EnvDomains),
    '(b) DOMAINS_PATH alone (no config domainsPath) resolves the domains folder');
  eq(cfgModule.getDomainsDir(), path.resolve(p9EnvDomains),
    '(b) config.js agrees: DOMAINS_PATH alone still works');

  // (c) THE FIX: config AND DOMAINS_PATH both set, no CLI arg → config MUST win.
  // This is the exact case that silently disagreed before this change — verified
  // by hand to FAIL against the pre-fix ordering (see the session report).
  fs.writeFileSync(path.join(p9Base, '.curator-config.json'),
    JSON.stringify({ domainsPath: p9ConfigDomains }));
  eq(path.resolve(createStorageAdapter({}).getBase()), path.resolve(p9ConfigDomains),
    '(c) config.domainsPath wins over DOMAINS_PATH in the MCP adapter');
  eq(cfgModule.getDomainsDir(), path.resolve(p9ConfigDomains),
    '(c) config.js\'s getDomainsDir() resolves the SAME folder — this is the app/MCP agreement the fix restores');

  // (d) Same config + same DOMAINS_PATH, but the CLI arg is supplied (exactly as
  // the generated Claude Desktop config always does) → the CLI arg wins over both.
  eq(path.resolve(createStorageAdapter({ domainsPath: p9CliDomains }).getBase()), path.resolve(p9CliDomains),
    '(d) --domains-path CLI arg wins over config AND DOMAINS_PATH');

  // (e) The test seam still outranks the CLI arg — this ordering is UNCHANGED by
  // this fix and must not regress alongside it.
  process.env.CURATOR_TEST_DOMAINS_DIR = p9TestSeamDomains;
  eq(path.resolve(createStorageAdapter({ domainsPath: p9CliDomains }).getBase()), path.resolve(p9TestSeamDomains),
    '(e) CURATOR_TEST_DOMAINS_DIR still outranks the CLI arg (unchanged by this fix)');
  delete process.env.CURATOR_TEST_DOMAINS_DIR;
} finally {
  paths.__setUserDataDirOverride(null);
  if (savedEnvP9DomainsPath === undefined) delete process.env.DOMAINS_PATH;
  else process.env.DOMAINS_PATH = savedEnvP9DomainsPath;
  if (savedEnvP9TestSeam === undefined) delete process.env.CURATOR_TEST_DOMAINS_DIR;
  else process.env.CURATOR_TEST_DOMAINS_DIR = savedEnvP9TestSeam;
  try { fs.rmSync(p9Base, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Light source-order guard, supplementary to the behavioural assertions above
// (mirrors the convention already used for config.js in §4). The behavioural
// cases (a)-(e) are the ones that actually catch a regression; this just keeps
// the two files' comments/rung lists honest at a glance.
const mcpLocalSrcP9 = read('mcp/storage/local.js');
const mIdxCli    = mcpLocalSrcP9.indexOf('if (domainsPath) return path.resolve(domainsPath);');
const mIdxConfig = mcpLocalSrcP9.indexOf('if (cfg.domainsPath) return path.resolve(cfg.domainsPath);');
const mIdxEnv    = mcpLocalSrcP9.indexOf("if (process.env.DOMAINS_PATH) return path.resolve(process.env.DOMAINS_PATH);");
const mIdxDefault = mcpLocalSrcP9.indexOf('return getDefaultDomainsDir();');
ok(mIdxCli > -1 && mIdxConfig > -1 && mIdxEnv > -1 && mIdxDefault > -1,
  'mcp/storage/local.js still contains all four non-test-seam rungs');
ok(mIdxCli < mIdxConfig && mIdxConfig < mIdxEnv && mIdxEnv < mIdxDefault,
  'mcp/storage/local.js source order is CLI arg > config > DOMAINS_PATH > default — matches config.js');

// Cleanup
try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All path-resolution assertions green');
