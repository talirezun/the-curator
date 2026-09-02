/**
 * Path resolution — the single source of truth for WHERE user data lives.
 *
 * ── Why this module exists ───────────────────────────────────────────────────
 *
 * Today The Curator runs from a git checkout, and every piece of user data
 * (.curator-config.json, .sync-config.json, .sharedbrain-config.json,
 * .knowledge-git/, domains/) lives inside that checkout. That works because a
 * checkout is writable.
 *
 * An installed macOS `.app` bundle is NOT writable. Writing anything inside a
 * signed bundle invalidates its code signature and macOS then refuses to launch
 * it. So before The Curator can ever be packaged as an app, user data has to
 * live outside the code.
 *
 * This module draws that line ONCE:
 *
 *   APP_ROOT          — where the CODE is. Read-only in a bundle. Used for
 *                       package.json, src/server.js, mcp/server.js, src/public,
 *                       and the git checkout the auto-updater operates on.
 *   getUserDataDir()  — where USER DATA goes. Always writable.
 *
 *   repo install   (anything that is not a recognised bundle — today, everyone):
 *       getUserDataDir() === APP_ROOT      ← byte-identical to pre-existing
 *                                            behaviour. Nothing moves. Ever.
 *   bundle install (a packaged .app, positively identified):
 *       getUserDataDir() === ~/Library/Application Support/The Curator/
 *
 * ── Why detection asks "is this a BUNDLE?", never "is this a repo?" ──────────
 *
 * This is the load-bearing design decision in the module. Read before changing.
 *
 * The two mistakes are not symmetric:
 *
 *   Wrongly deciding "bundle" for a real checkout   → CATASTROPHIC. Every path
 *     moves at once (config, domains, sync, Shared Brain). The user's data is
 *     still safe in the old folder, but nothing in the app points at it, so
 *     they get the onboarding wizard, no API key and no domains. It presents as
 *     "the update deleted my second brain".
 *   Wrongly deciding "repo" for a real bundle       → loud and immediate. The
 *     first write fails on the read-only bundle with a clear error, and no data
 *     is lost or orphaned.
 *
 * So the DEFAULT must be "repo", and only a positive, unambiguous signal may
 * move data. A packaged app KNOWS it is packaged (we build it); a checkout can
 * never prove it isn't one. Hence:
 *
 *     isBundleInstall()  → explicit signal, and nothing else
 *     isRepoInstall()    → !isBundleInstall()      // unknown ⇒ data stays put
 *
 * Two earlier designs were tried and rejected, both for real reasons:
 *
 *   1. `existsSync(APP_ROOT/.git)` alone. A checkout that loses `.git` (GitHub
 *      "Download ZIP", a user deleting it to save space, a copy that dropped
 *      dotfiles, an interrupted clone) silently flips to bundle mode and
 *      relocates a LIVE install. That is the catastrophic direction.
 *   2. Adding data markers (`.curator-config.json`, `domains`) as additional
 *      repo evidence. This fixed (1) but broke the forward half: `domains/`
 *      contains a TRACKED `.gitkeep` (see .gitignore: `domains/*` +
 *      `!domains/.gitkeep`), so `git archive HEAD` — i.e. any bundle built by
 *      shipping the source tree — CONTAINS a `domains/` directory. Bundle mode
 *      became unreachable by construction, and the app would have written
 *      inside the read-only bundle. Verified, not theorised.
 *
 * Inverting the question kills both. It also removes the dependency on which
 * files happen to be tracked, and does not require a build script and a runtime
 * constant to stay in sync with each other.
 *
 * The two accepted bundle signals:
 *
 *   a) BUNDLE_MARKER_FILE — a file the PACKAGER writes into the shipped tree.
 *      Nothing else in this repo ever creates it. Explicit and unambiguous.
 *   b) macOS bundle layout — APP_ROOT contains a `<Something>.app` path
 *      component immediately followed by `Contents`. A checkout would have to
 *      be cloned inside an app bundle to trip this.
 *
 * NOTE for whoever does the packaging work: `scripts/build-app.sh` today builds
 * an AppleScript wrapper that RUNS THE CHECKOUT — the code stays in the repo, so
 * that .app is a repo install and must keep resolving to APP_ROOT. Do NOT make
 * build-app.sh write the marker as things stand; that would flip every existing
 * user into bundle mode. The marker belongs to a future build that actually
 * copies the code inside the bundle.
 *
 * Taking the bundle branch is announced once on stderr — a transition that
 * relocates all user data must never be silent.
 *
 * ── Why ~/Library/Application Support and NOT ~/Documents ────────────────────
 *
 * DO NOT "helpfully" move this to ~/Documents, ~/Desktop or ~/Downloads.
 * Those three directories are TCC-protected (macOS Transparency, Consent and
 * Control): the first access triggers a system permission prompt, and the
 * prompt is attributed to the process that made the access.
 *
 * The My Curator MCP server is spawned by *Claude Desktop* as a headless stdio
 * child process. If it touched a TCC-protected directory, macOS would attribute
 * the prompt to Claude Desktop — and for a headless child with no UI session
 * the prompt may never render at all. The MCP would simply fail to read the
 * wiki, with no user-visible explanation.
 *
 * ~/Library/Application Support is not TCC-protected, is the Apple-documented
 * location for exactly this kind of data, and is already where Claude Desktop
 * keeps its own config — so the MCP child can reach it without any prompt.
 *
 * ── Test seams ───────────────────────────────────────────────────────────────
 *
 *   __setUserDataDirOverride(dir)   in-process, highest precedence
 *   CURATOR_TEST_USER_DATA_DIR      env; survives into SPAWNED CHILD PROCESSES
 *
 * Both are checked BEFORE install-form detection, mirroring how
 * CURATOR_TEST_DOMAINS_DIR already outranks config in getDomainsDir().
 *
 * The env seam matters because `CURATOR_TEST_DOMAINS_DIR` only isolates
 * `domains/` — a test that spawns a real server still reads and writes the
 * maintainer's REAL `.curator-config.json`, `.sync-config.json` (which holds
 * their GitHub PAT) and `.sharedbrain-config.json`.
 *
 * EXACTLY what CURATOR_TEST_USER_DATA_DIR isolates:
 *   - unconditionally: .curator-config.json, .sync-config.json,
 *     .sharedbrain-config.json, .knowledge-git/  (all four resolve only here)
 *   - domains/ ONLY IF nothing higher in getDomainsDir()'s chain overrides it.
 *     A `domainsPath` in the redirected config is fine (it is read from the
 *     isolated file), but a `DOMAINS_PATH` env var still wins over the default
 *     and would point a "isolated" run at a real wiki. The MCP's
 *     `--domains-path` CLI arg behaves the same way. Tests that need domains
 *     isolated too should also set CURATOR_TEST_DOMAINS_DIR, or ensure
 *     DOMAINS_PATH is unset.
 *
 * IMPORTANT for consumers: resolve these paths PER CALL. A module-level
 * `const CONFIG_FILE = getCuratorConfigFile()` snapshots the value at import
 * time, which silently defeats both seams for anything imported before the
 * override is set.
 *
 * ── Invariants ───────────────────────────────────────────────────────────────
 *
 *  1. In repo mode this module performs NO filesystem writes and creates no
 *     directories — it is a pure resolver. In BUNDLE mode it lazily mkdir's the
 *     data dir (0700), because unlike a checkout it may not exist yet. That
 *     mkdir is a genuine import-time-reachable side effect, including in the
 *     MCP child; it is best-effort and any failure is recorded (see
 *     getUserDataDirState) rather than thrown.
 *  2. Every path here is absolute.
 *  3. This module never writes to STDOUT. It is imported by the MCP child
 *     process, where stdout is reserved for JSON-RPC frames (see the MCP stdout
 *     discipline note in CLAUDE.md). The one diagnostic it emits — the bundle
 *     -mode notice — goes to console.error (stderr), once per process.
 *  4. `mcp/storage/local.js` MUST resolve through this module too. It used to
 *     re-derive the config path independently; if the two ever disagreed, the
 *     MCP server would read a different domains folder than the UI and the
 *     user's Claude Desktop would silently see a stale or empty wiki.
 *
 * ── Migration (deliberately NOT implemented here) ────────────────────────────
 *
 * The bundle branch is currently unexercised in production — there is no
 * bundle yet. It ships one full release ahead of any packaging work precisely
 * so it can be proven in the mode where nothing should change, and so this seam
 * is settled while it is still free to change.
 *
 * When a bundle does exist, a first-launch migration will be needed: a fresh
 * bundle install finds an EMPTY ~/Library/Application Support/The Curator while
 * the user's real wiki still sits in their old checkout. A bundle cannot infer
 * the old checkout's location, so the seam is `getUserDataDirState()`:
 *
 *   'ready'   — the data dir holds a config and/or a domains folder. Proceed.
 *   'empty'   — the dir exists but holds neither. THIS is the migration
 *               trigger: offer a one-time import before onboarding, rather
 *               than letting the user think their wiki is gone.
 *   'missing' — the dir does not exist and could not be created.
 *   'blocked' — the path exists but is unusable: not a directory, an
 *               unreadable directory, a broken symlink, or mkdir failed. Every
 *               later write would fail; surface this, don't proceed.
 *
 * A boolean "does it exist" is NOT sufficient for that decision, which is why
 * this returns a state rather than a flag. The import itself should copy the
 * credential files + .knowledge-git and then set `domainsPath` in config,
 * rather than moving a possibly-huge domains/ tree. Nothing here should start
 * silently copying data.
 */

import path from 'path';
import os from 'os';
import { existsSync, mkdirSync, statSync, lstatSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Root of the CODE. In a repo install this is the checkout; in a bundle it is
 * the (read-only) resources directory. Never write here.
 *
 * NOTE: this is the same `path.resolve(<module dir>, '../..')` every
 * src/brain/* module computed for itself before this module existed, so it is
 * unchanged by construction.
 */
export const APP_ROOT = path.resolve(__dirname, '../..');

/** Directory name used under ~/Library/Application Support in bundle mode. */
export const APP_SUPPORT_DIR_NAME = 'The Curator';

/**
 * Directory name used under ~/Library/Logs. Deliberately the SAME string as
 * APP_SUPPORT_DIR_NAME — one app, one name, wherever macOS convention puts it.
 */
export const APP_LOGS_DIR_NAME = APP_SUPPORT_DIR_NAME;

/**
 * Written by the PACKAGER into a shipped bundle. Nothing in this repo creates
 * it — see the "NOTE for whoever does the packaging work" in the docblock.
 * Its presence is a positive declaration: "the code around me is read-only".
 */
export const BUNDLE_MARKER_FILE = '.curator-bundle';

// Test-only override. Production NEVER sets this, so it stays null and the
// real install-form detection runs untouched.
let _userDataDirOverride = null;
let _cachedUserDataDir = null;
let _mkdirErrorFor = null;      // { dir, err } — keyed by dir, never sticky
let _bundleNoticeShown = false;

/**
 * Test seam — force the user-data dir (e.g. at a tempdir) without touching the
 * user's real files. Pass null to clear. Also clears the memoised value.
 */
export function __setUserDataDirOverride(p) {
  _userDataDirOverride = p ? path.resolve(p) : null;
  _cachedUserDataDir = null;
}

/**
 * True when `dir` sits inside a macOS application bundle — i.e. some path
 * component ends in `.app` and is immediately followed by `Contents`.
 * Deliberately strict: a stray directory merely named "foo.app" is not enough.
 */
function looksLikeMacOSBundle(dir) {
  const parts = dir.split(path.sep);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i].toLowerCase().endsWith('.app') && parts[i + 1] === 'Contents') return true;
  }
  return false;
}

/**
 * True ONLY on a positively-identified packaged app. Everything else — including
 * any layout we don't recognise — is treated as a repo install, because that is
 * the direction whose failure mode is safe. See the docblock.
 */
export function isBundleInstall() {
  if (existsSync(path.join(APP_ROOT, BUNDLE_MARKER_FILE))) return true;
  if (looksLikeMacOSBundle(APP_ROOT)) return true;
  return false;
}

/**
 * True when the app should keep its data next to the code — a checkout, and any
 * unrecognised layout. Never inferred from which files happen to be present.
 */
export function isRepoInstall() {
  return !isBundleInstall();
}

/**
 * The macOS Application Support location used in bundle mode. Exported for
 * tests and for error messages; callers should use getUserDataDir().
 */
export function getAppSupportDir() {
  return path.join(os.homedir(), 'Library', 'Application Support', APP_SUPPORT_DIR_NAME);
}

// Test-only override for the log directory. Separate from
// _userDataDirOverride on purpose — a suite exercising the logger needs to
// isolate ONLY where log lines land, independent of whatever domains/config
// dir a surrounding fixture already redirected, and a real run must never be
// able to write a log into the maintainer's actual ~/Library/Logs.
let _logDirOverride = null;

/** Test seam — force the log directory (e.g. a tempdir). Pass null to clear. */
export function __setLogDirOverride(p) {
  _logDirOverride = p ? path.resolve(p) : null;
}

/**
 * Absolute path to the directory the app's own log file lives in.
 *
 * Unlike getUserDataDir(), this does NOT fork on install mode. A repo
 * checkout is still a live git working tree — writing a growing log file
 * inside it would show up in every `git status`, and it's exactly the kind
 * of machine-local operational file (`.DS_Store` in v3.0.16, `.write-lock`
 * in v3.0.15) this project has already shipped inside a synced/tracked tree
 * by mistake more than once. The log is diagnostic exhaust, not user data —
 * ~/Library/Logs is the OS-conventional home for it in EITHER install mode,
 * exactly like Application Support is for user data.
 *
 * Not TCC-protected (same reasoning as getAppSupportDir() above), so an MCP
 * child spawned headlessly by Claude Desktop can also write here without
 * risking a permission prompt with nowhere to render.
 *
 *   __setLogDirOverride            → that (test seam)
 *   CURATOR_TEST_LOG_DIR           → that (test seam, crosses process boundaries)
 *   an isolated USER-DATA dir      → <that>/logs      (v3.43.0)
 *   otherwise                      → ~/Library/Logs/The Curator
 *
 * The third rung is the v3.43.0 addition and it closes a real leak. Every
 * suite that spawns a server isolates with CURATOR_TEST_USER_DATA_DIR, whose
 * documented job is "all four credential locations, and domains/ too" — but
 * the log was not on that list, so two throwaway Shared Brain instances driven
 * end to end wrote their whole run into the MAINTAINER'S OWN
 * ~/Library/Logs/The Curator/curator.log, interleaved with his real app's. A
 * test seam that isolates almost everything is worse than one that isolates
 * nothing, because nobody checks the difference. Log lines are diagnostic
 * exhaust rather than credentials, so the harm is contaminated diagnostics and
 * a rotated-away real log, not a leak — which is exactly why it went unnoticed
 * for four releases.
 *
 * Note the ordering: the two LOG-SPECIFIC seams still win, so a suite
 * exercising the logger inside a fixture that already redirected user data can
 * still point the log somewhere else. This rung only fills in what nothing
 * else asked for.
 *
 * Pure resolver — never creates the directory. The logger module owns that,
 * lazily and best-effort, at write time (see its own docblock for why: a
 * failed mkdir here must never be allowed to throw through a caller that
 * only wanted to log an error).
 */
export function getLogsDir() {
  if (_logDirOverride) return _logDirOverride;
  if (process.env.CURATOR_TEST_LOG_DIR) {
    return path.resolve(process.env.CURATOR_TEST_LOG_DIR);
  }
  // Read the user-data SEAMS directly rather than calling getUserDataDir():
  // in a real install that getter returns APP_ROOT (repo) or Application
  // Support (bundle), and this function deliberately does NOT fork on install
  // mode. Only an explicitly ISOLATED user-data dir may pull the log with it.
  if (_userDataDirOverride) return path.join(_userDataDirOverride, 'logs');
  if (process.env.CURATOR_TEST_USER_DATA_DIR) {
    return path.join(path.resolve(process.env.CURATOR_TEST_USER_DATA_DIR), 'logs');
  }
  return path.join(os.homedir(), 'Library', 'Logs', APP_LOGS_DIR_NAME);
}

// Test-only override for the MCP launcher directory. Separate from the other
// two overrides for the same reason __setLogDirOverride is separate from
// __setUserDataDirOverride: a suite exercising shim generation must isolate
// ONLY where the shim lands, and a real run must never be able to drop an
// executable into the maintainer's actual Application Support tree.
let _mcpLauncherDirOverride = null;

/** Test seam — force the MCP launcher dir (e.g. a tempdir). Pass null to clear. */
export function __setMcpLauncherDirOverride(p) {
  _mcpLauncherDirOverride = p ? path.resolve(p) : null;
}

/**
 * Absolute path to the directory holding the MCP launcher shim — the small
 * shell script Claude Desktop is pointed at in bundle mode, instead of at
 * `process.execPath` and a file inside an asar archive.
 *
 * Like getLogsDir(), this does NOT fork on install mode, and the reason is the
 * same one that has bitten this project twice. In repo mode getUserDataDir()
 * IS the checkout, so anchoring the shim on userDataPath() would drop a
 * generated executable into a live git working tree — the `.DS_Store`
 * (v3.0.16) and `.write-lock` (v3.0.15) class, both of which shipped. Worse,
 * a user whose `domainsPath` points at the user-data dir would have it land
 * inside Personal Sync's git WORK-TREE and be committed and pushed. The shim
 * is machine-local operational exhaust that names an absolute path on THIS
 * Mac; it is meaningless on any other machine and must never travel.
 *
 * ~/Library/Application Support/The Curator/bin is therefore unconditional.
 * It is not TCC-protected (same reasoning as getAppSupportDir() above), which
 * matters here more than anywhere else in this module: the file at this path
 * is EXECUTED by Claude Desktop, headless, with no UI session in which a
 * permission prompt could render.
 *
 *   __setMcpLauncherDirOverride     → that (test seam)
 *   CURATOR_TEST_MCP_LAUNCHER_DIR   → that (test seam, crosses process bounds)
 *   otherwise                       → ~/Library/Application Support/The Curator/bin
 *
 * Pure resolver — never creates the directory and never writes. Generation is
 * owned by src/brain/mcp-launcher.js, which also enforces at write time that
 * the resolved directory is not inside getDomainsDir() (a check this resolver
 * cannot make without importing config.js and creating a cycle).
 */
export function getMcpLauncherDir() {
  if (_mcpLauncherDirOverride) return _mcpLauncherDirOverride;
  if (process.env.CURATOR_TEST_MCP_LAUNCHER_DIR) {
    return path.resolve(process.env.CURATOR_TEST_MCP_LAUNCHER_DIR);
  }
  return path.join(getAppSupportDir(), 'bin');
}

/**
 * Absolute path to the writable user-data directory.
 *
 *   __setUserDataDirOverride   → that (test seam)
 *   CURATOR_TEST_USER_DATA_DIR → that (test seam, crosses process boundaries)
 *   repo mode                  → APP_ROOT (unchanged from every prior version)
 *   bundle mode                → ~/Library/Application Support/The Curator
 *
 * The detected value is memoised — install form cannot change within a process,
 * and this is on the hot path (getDomainsDir runs on nearly every request). The
 * two seams are re-read on every call so they are never defeated by import
 * order.
 */
export function getUserDataDir() {
  if (_userDataDirOverride) return _userDataDirOverride;
  if (process.env.CURATOR_TEST_USER_DATA_DIR) {
    return path.resolve(process.env.CURATOR_TEST_USER_DATA_DIR);
  }
  if (_cachedUserDataDir) return _cachedUserDataDir;

  if (!isBundleInstall()) {
    // Repo mode: identical to the historical PROJECT_ROOT. No mkdir, no writes.
    _cachedUserDataDir = APP_ROOT;
    return _cachedUserDataDir;
  }

  const dir = getAppSupportDir();

  // Relocating every user-data path is never allowed to be silent. stderr only
  // — stdout belongs to the MCP's JSON-RPC framing.
  if (!_bundleNoticeShown) {
    _bundleNoticeShown = true;
    console.error(
      `[The Curator] Running as a packaged app (${APP_ROOT}) — using ${dir} for user data. ` +
      `If you expected an existing wiki, it is still in your original install folder; ` +
      `do not re-run onboarding.`
    );
  }

  // Bundle mode only: unlike a checkout, this may not exist yet. Best-effort —
  // a failure here must not crash startup, but it IS recorded so callers can
  // distinguish "empty, offer migration" from "broken, every write will fail".
  // 0700 because this tree holds API keys and a GitHub PAT.
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    _mkdirErrorFor = null;
  } catch (err) {
    _mkdirErrorFor = { dir, err };
  }
  _cachedUserDataDir = dir;
  return _cachedUserDataDir;
}

/** Join segments onto the user-data dir. */
export function userDataPath(...segments) {
  return path.join(getUserDataDir(), ...segments);
}

/** Join segments onto the app (code) root. Never write to the result. */
export function appPath(...segments) {
  return path.join(APP_ROOT, ...segments);
}

/**
 * True only when the user-data dir exists AND is a real directory. A regular
 * file at that path is NOT "exists" — every subsequent write would fail
 * ENOTDIR, so reporting true there would defeat the migration check.
 */
export function userDataDirExists() {
  try { return statSync(getUserDataDir()).isDirectory(); }
  catch { return false; }
}

/**
 * Migration seam — 'ready' | 'empty' | 'missing' | 'blocked'.
 * See the Migration section of this module's docblock for what each means and
 * why a boolean is not enough.
 */
export function getUserDataDirState() {
  const dir = getUserDataDir();
  // The mkdir failure is keyed to the directory it happened for, so a transient
  // failure can never make an unrelated (or later, healthy) dir read 'blocked'.
  if (_mkdirErrorFor && _mkdirErrorFor.dir === dir) return 'blocked';

  let st;
  try {
    st = statSync(dir);
  } catch (err) {
    // ENOENT from statSync can still mean "a broken symlink lives here", which
    // is a broken install, not an absent one — lstat sees the link itself.
    if (err && err.code === 'ENOENT') {
      try { lstatSync(dir); return 'blocked'; } catch { return 'missing'; }
    }
    // EACCES / ELOOP / anything else: the path is there but unusable.
    return 'blocked';
  }
  if (!st.isDirectory()) return 'blocked';

  // "Holds a Curator install?" — a config or a domains folder.
  const hasData = existsSync(path.join(dir, '.curator-config.json'))
               || existsSync(path.join(dir, 'domains'));
  if (hasData) return 'ready';

  // A dir we cannot enumerate is unusable, not empty.
  try { readdirSync(dir); } catch { return 'blocked'; }
  return 'empty';
}

// ── Named user-data locations ────────────────────────────────────────────────
// Each of these was previously `path.join(PROJECT_ROOT, <name>)` in one or more
// modules. In repo mode they resolve to exactly the same absolute strings.
//
// Call these PER USE. Snapshotting one into a module-level const defeats both
// test seams for any module imported before the override is set.

/** `.curator-config.json` — API keys, domainsPath, activeProvider. 0600. */
export function getCuratorConfigFile() {
  return userDataPath('.curator-config.json');
}

/** `.sync-config.json` — GitHub Personal Sync credentials. 0600. */
export function getSyncConfigFile() {
  return userDataPath('.sync-config.json');
}

/** `.knowledge-git` — the bare git dir backing Personal Sync. */
export function getSyncGitDir() {
  return userDataPath('.knowledge-git');
}

/** `.sharedbrain-config.json` — Shared Brain PATs + admin/fellow tokens. 0600. */
export function getSharedBrainConfigFile() {
  return userDataPath('.sharedbrain-config.json');
}

/** Default domains folder, used only when config/env don't override it. */
export function getDefaultDomainsDir() {
  return userDataPath('domains');
}

/**
 * Batch-ingest queue directory (Track 3). Deliberately NOT inside
 * getDomainsDir() — that directory is Personal Sync's git work-tree
 * (`sync.js` passes `--work-tree=getDomainsDir()`), so a queue living there
 * would commit and push staged source files (PDFs etc., possibly mid-batch,
 * possibly large) to the user's GitHub repo. This project has shipped that
 * exact class of bug twice already (`.DS_Store` in v3.0.16, `.write-lock` in
 * v3.0.15) — machine-local operational state landing in the domains tree.
 *
 * A user CAN point `domainsPath` at the app root (or anywhere), which would
 * make getDomainsDir() and getUserDataDir() coincide — belt-and-braces
 * defenses against that pathological case live in src/brain/sync.js
 * (DOMAINS_GITIGNORE_RULES) and .gitignore, not here.
 */
export function getIngestQueueDir() {
  return userDataPath('.ingest-queue');
}

/**
 * Files that must be owner-only (0600), as {rel, abs} pairs.
 *
 * Single source of truth for BOTH the startup chmod sweep in server.js and the
 * System Check credential-permission check in diagnostics.js — those two lists
 * previously had to be kept in sync by hand.
 *
 * `.env` is a developer-only fallback that lives with the SOURCE (dotenv reads
 * it relative to cwd, which for a repo install is APP_ROOT), so it is anchored
 * to APP_ROOT rather than the data dir. In repo mode the two are the same path,
 * so this list is byte-identical to the pre-existing one.
 */
export function getCredentialFiles() {
  return [
    { rel: '.curator-config.json',     abs: getCuratorConfigFile() },
    { rel: '.sync-config.json',        abs: getSyncConfigFile() },
    { rel: '.sharedbrain-config.json', abs: getSharedBrainConfigFile() },
    { rel: '.env',                     abs: appPath('.env') },
    { rel: '.knowledge-git/config',    abs: path.join(getSyncGitDir(), 'config') },
  ];
}
