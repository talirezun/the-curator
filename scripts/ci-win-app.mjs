#!/usr/bin/env node
/**
 * ci-win-app.mjs — what GitHub's windows-latest runner proves about the
 * Windows app, run by .github/workflows/desktop-dmg.yml (on a tag) and the
 * `windows` job of .github/workflows/test.yml (on every push).
 *
 * NONE OF THIS RUNS ON A MAC. The subcommands that touch Windows refuse to
 * start anywhere else. The pure helpers at the top are exported and driven by
 * scripts/test-release-publish.js (§7), against the REAL production modules,
 * so the fixture this file serves to the updater is proven acceptable to the
 * updater's own resolver offline.
 *
 * Subcommands (each exits 1 on the first failed group, with ::error:: lines):
 *
 *   check-build    --unpacked <win-unpacked> --setup <exe> --version X.Y.Z
 *     the exe's and the setup's version resources (PowerShell VersionInfo,
 *     and the setup's ProductVersion exactly as the updater normalises it),
 *     the bundle marker, the bundled git (`git --version` = 2.56.1.windows.1,
 *     file-for-file the verified MinGit), LICENSE.txt + package-versions.txt,
 *     the notices (MinGit + the GPL source file's name), tray icons, every root
 *     runtime dependency in resources\app\node_modules, the RunAsNode fuse
 *     (the exe RUN as Node, plus the fuse wire read), no blockmap / latest.yml
 *     / app-update.yml, and the app LAUNCHED from a copy outside the
 *     workspace (a space and a non-ASCII letter in its path) answering
 *     /api/version as a bundle with mcpLaunchStyle app-binary.
 *
 *   install-smoke  --setup <exe> --version X.Y.Z
 *     silent install (/S) → files, the marker inside the installed payload,
 *     the HKCU uninstall key (and none in HKLM), both shortcuts → the exe;
 *     the installed app launched (isolated data) answers /api/version; the
 *     git checks below against the INSTALLED app, plus System Check's git row
 *     over HTTP with no git on PATH (ok, then the repair sentence with the
 *     bundled git hidden); silent uninstall → program, key and shortcuts gone,
 *     %LOCALAPPDATA%\TheCurator\App\sentinel.txt and a seeded wiki page
 *     byte-identical, %APPDATA%\The Curator kept; then the installer guard:
 *     /S /D=%LOCALAPPDATA%\TheCurator (and …\App) exits 2 and writes nothing.
 *
 *   git-checks     --mingit <dir> | --install-dir <dir>
 *     Personal Sync's git, as planGit() (src/brain/subprocess-env.js) plans it,
 *     with NO git on PATH: init / commit / push to a local bare repository /
 *     clone back, through paths with spaces and non-ASCII letters; a 401 from
 *     a local HTTP server ends in seconds with no Git Credential Manager
 *     process; with the bundled git hidden, System Check's git row is the
 *     Windows app's repair sentence (sync.js gitMissingMessage).
 *     --mingit (test.yml) lays the verified MinGit out as an install would and
 *     uses this checkout's modules; --install-dir uses the installed app's.
 *
 *   rehearse-update --from <setup N> --from-version N --to <setup N+1> --to-version N+1
 *     F's update test: install N, seed data, run N, serve N+1 from a LOCAL
 *     fixture (see "THE SEAM" below), drive the installed N's own
 *     createUpdateInstaller('win32') prepare → install: first with an MCP
 *     bridge (`The Curator.exe`, ELECTRON_RUN_AS_NODE=1, mcp\server.js, after
 *     a real MCP initialize) → `in-use-by-ai-app` and nothing quit; then with
 *     stopConnections → the helper stops the bridge, runs the setup, the app
 *     reopens on N+1 (/api/version), updates\ is emptied by afterStart, the
 *     shortcuts and the HKCU key are kept (DisplayVersion N+1), and the seeded
 *     data is byte-identical.
 *
 *   next-version --version X.Y.Z      prints X.Y.(Z+1)
 *   stamp-version --version X.Y.Z     sets the root package.json "version"
 *     (the rehearsal's N+1 build, on the runner only; never committed)
 *
 * ── THE SEAM, AND WHY PRODUCTION CANNOT HONOUR IT ──────────────────────────
 * Nothing in the shipped app was changed to make the update testable. The
 * engine takes `fetchImpl` and `resolveRelease` as injected dependencies
 * (desktop/lib/update-install-win32.js; main.js passes globalThis.fetch). This
 * script imports the INSTALLED copy's engine and config.js and injects a fetch
 * that answers EXACTLY two URL shapes from a server on 127.0.0.1 — config.js's
 * own RELEASES_API_URL, and https://github.com/talirezun/the-curator/releases/
 * download/… — and rejects every other URL. The release JSON carries the real
 * https://github.com/… download URL, so update-plan.js's https-and-GitHub-host
 * rule, the size, the SHA-256 digest and the ProductVersion checks all run
 * unchanged. There is no environment variable, file or flag a production app
 * reads to point it elsewhere: the redirection exists only inside this process.
 *
 * What this does NOT exercise (human check): the in-app route → hook glue,
 * and quitting through app.quit() (here the engine's quitApp ends the app
 * with taskkill /F); the reopened app and its afterStart ARE the real ones.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync, realpathSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ═════════════════════════════════════════════════════════════════════════
//  Pure helpers (exported; scripts/test-release-publish.js §7 drives them)
// ═════════════════════════════════════════════════════════════════════════

export const REPO_RELEASES_DOWNLOAD = 'https://github.com/talirezun/the-curator/releases/download/';
export const PRODUCT = 'The Curator';
export const EXE_NAME = 'The Curator.exe';
export const UNINSTALLER = 'Uninstall The Curator.exe';
export const SHORTCUT = 'The Curator.lnk';
export const GIT_VERSION_LINE = 'git version 2.56.1.windows.1';

/** X.Y.Z → X.Y.(Z+1). Plain semver only (the project's rule); else null. */
export function nextPatchVersion(v) {
  const m = typeof v === 'string' && v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : null;
}

/** package.json text with ONLY its top-level "version" value replaced. */
export function stampVersionText(text, version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`not a plain X.Y.Z version: ${version}`);
  const parsed = JSON.parse(text);
  if (typeof parsed.version !== 'string') throw new Error('package.json has no version');
  const out = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(out).version !== version) throw new Error('the version did not change');
  return out;
}

/**
 * The GitHub Releases payload the fixture serves: ONE release, N+1, carrying
 * the setup program with GitHub's own `digest` field and the real download URL.
 */
export function fixtureReleases({ version, assetName, size, sha256 }) {
  const tag = `v${version}`;
  return [{
    tag_name: tag,
    name: `The Curator ${tag}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/talirezun/the-curator/releases/tag/${tag}`,
    published_at: '2026-11-20T00:00:00Z',
    assets: [{
      name: assetName,
      size,
      digest: `sha256:${sha256}`,
      content_type: 'application/x-msdownload',
      browser_download_url: `${REPO_RELEASES_DOWNLOAD}${tag}/${assetName}`,
    }],
  }];
}

/**
 * The injected fetch: config.js's RELEASES_API_URL → `${base}/releases`, a
 * download URL of THIS repository → `${base}/download/<tag>/<name>`, anything
 * else REJECTED (so nothing in a rehearsal can reach the real network).
 */
export function makeFixtureFetch({ releasesApiUrl, base, fetchImpl = globalThis.fetch, onCall = () => {} }) {
  return async (url, init) => {
    const u = String(url);
    let target = null;
    if (u === releasesApiUrl) target = `${base}/releases`;
    else if (u.startsWith(REPO_RELEASES_DOWNLOAD)) target = `${base}/download/${u.slice(REPO_RELEASES_DOWNLOAD.length)}`;
    onCall(u, target);
    if (!target) throw new TypeError(`ci-win-app: refused a network call outside the fixture: ${u}`);
    return fetchImpl(target, init);
  };
}

/** Instance records (src/brain/instance-probe.js) under an `instances` root. */
export function readInstanceRecords(instancesRoot, { readdir = readdirSync, readFile = readFileSync } = {}) {
  const out = [];
  let buckets = [];
  try { buckets = readdir(instancesRoot); } catch { return out; }
  for (const b of buckets) {
    let files = [];
    try { files = readdir(path.join(instancesRoot, b)); } catch { continue; }
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const r = JSON.parse(readFile(path.join(instancesRoot, b, f), 'utf8'));
        if (r && Number.isInteger(r.pid) && Number.isInteger(r.port)) out.push(r);
      } catch { /* a record being written */ }
    }
  }
  return out;
}

/** {relPath: sha256} → the paths whose bytes changed or that vanished. Pure. */
export function snapshotDiff(before, after) {
  const changed = [];
  const missing = [];
  for (const [k, v] of Object.entries(before)) {
    if (!(k in after)) missing.push(k);
    else if (after[k] !== v) changed.push(k);
  }
  const added = Object.keys(after).filter((k) => !(k in before));
  return { changed, missing, added };
}

/**
 * Copy the folder tree `src` to `dest`, file by file, through fs.mkdirSync /
 * fs.copyFileSync (libuv's wide-character Windows calls). Returns the number
 * of files copied. A symbolic link is refused, never followed.
 *
 * NEVER fs.cpSync here. On Windows, Node 22's cpSync (node_file.cc
 * CpSyncCopyDir, v22.23.5: `create_directories(*dest)`) hands the destination
 * to C++ std::filesystem as a NARROW string, which the Microsoft library reads
 * in the ANSI code page, not UTF-8: under code page 1252 a UTF-8
 * "Programs Ž é" becomes "Programs Å½ Ã©", and the whole copy lands there
 * without an error (its path check, CpSyncCheckPaths, converts correctly, so
 * nothing complains). The launch that followed failed with spawn ENOENT
 * (Desktop DMG run 44756919210). That is a Node bug in a test tool, not the
 * product: the product never calls cpSync (trash.js uses the asynchronous
 * fs.promises.cp, which is plain JavaScript over libuv).
 */
export function copyTree(src, dest, fsImpl = { mkdirSync, readdirSync, copyFileSync }) {
  let files = 0;
  const walk = (from, to) => {
    fsImpl.mkdirSync(to, { recursive: true });
    for (const e of fsImpl.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isSymbolicLink()) throw new Error(`copyTree: refusing a symbolic link (${a})`);
      if (e.isDirectory()) walk(a, b);
      else if (e.isFile()) { fsImpl.copyFileSync(a, b); files++; }
      else throw new Error(`copyTree: not a file or a folder (${a})`);
    }
  };
  walk(src, dest);
  return files;
}

/** Number of files under `dir` (0 when it does not exist). */
export function countFiles(dir, { readdir = readdirSync } = {}) {
  let n = 0;
  const walk = (d) => {
    let names = [];
    try { names = readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile()) n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * What a folder actually holds, `depth` levels down, one line each, for a
 * failure message: when a copy "succeeded" but the file is not where it was
 * asked to be, the listing shows where it went (a mangled sibling folder).
 */
export function describeTree(dir, depth = 3, { readdir = readdirSync } = {}) {
  const lines = [];
  const walk = (d, indent, left) => {
    let names = [];
    try { names = readdir(d, { withFileTypes: true }); } catch (err) { lines.push(`${indent}(cannot read: ${err.code || err.message})`); return; }
    if (!names.length) lines.push(`${indent}(empty)`);
    for (const e of names.slice(0, 40)) {
      // Code points for a name that is not plain ASCII, so mojibake is visible as such.
      const cps = /[^\x20-\x7e]/.test(e.name) ? `  [U+${[...e.name].map((c) => c.codePointAt(0).toString(16).toUpperCase()).join(' U+')}]` : '';
      lines.push(`${indent}${e.name}${e.isDirectory() ? '\\' : ''}${cps}`);
      if (e.isDirectory() && left > 1) walk(path.join(d, e.name), `${indent}  `, left - 1);
    }
    if (names.length > 40) lines.push(`${indent}… ${names.length - 40} more`);
  };
  lines.push(`${dir}:`);
  walk(dir, '  ', depth);
  return lines.join('\n');
}

/**
 * Watch a child for the 'error' event a failed spawn emits (ENOENT, EACCES…).
 * Unhandled, that event CRASHES this script with a stack trace and no
 * verdict; handled, the caller turns it into a failed check. Returns a getter
 * for the error (null while none).
 */
export function catchSpawnError(child, onError = () => {}) {
  let error = null;
  child.on('error', (err) => { if (!error) { error = err; onError(err); } });
  return () => error;
}
export function spawnErrorText(err) {
  return err ? `${err.code || 'error'}: ${err.message || err}` : '';
}

// ═════════════════════════════════════════════════════════════════════════
//  Windows effects
// ═════════════════════════════════════════════════════════════════════════

let failures = 0;
// ── The app's Apps & features key (HKCU\…\Uninstall\<NSIS_GUID>) ─────────
//
// v3.99.3-wintest.2 failed "…\Uninstall\80ccaaf9-… exists — null" whatever the
// installer had written: the probe piped an `if` STATEMENT
// (`if (…) {…} else {…} | ConvertTo-Json`), which Windows PowerShell refuses
// to parse ("An empty pipe element is not allowed"), so stdout was empty and
// the empty reply read as "no key" — and the later "the key is gone" checks
// passed for the same wrong reason. The probe below never pipes a statement,
// prints a sentinel for "absent", and a PowerShell failure THROWS.

export const UNINSTALL_ROOT_PS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
export const KEY_ABSENT = '__CURATOR_KEY_ABSENT__';
const UNINSTALL_FIELDS = 'DisplayName, DisplayVersion, UninstallString, QuietUninstallString, Publisher';

function psSingleQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

export function uninstallKeyCommand(guid) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(guid))) throw new Error(`not a GUID: ${guid}`);
  const k = psSingleQuote(`${UNINSTALL_ROOT_PS}\\${guid}`);
  return `$k = ${k}; if (Test-Path -LiteralPath $k) { Get-ItemProperty -LiteralPath $k | Select-Object ${UNINSTALL_FIELDS} | ConvertTo-Json -Compress -Depth 4 } else { ${psSingleQuote(KEY_ABSENT)} }`;
}
/** {status, stdout, stderr} → the key's values, or null when the key is absent; throws when PowerShell failed. */
export function parseUninstallKeyProbe(r) {
  if (!r || r.status !== 0) throw new Error(`PowerShell exited ${r && r.status}: ${firstLine(r && r.stderr)}`);
  const out = String(r.stdout || '').trim();
  if (out === KEY_ABSENT) return null;
  let v;
  try { v = JSON.parse(out); } catch { throw new Error(`unreadable probe reply: ${JSON.stringify(out.slice(0, 200))}`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`unexpected probe reply: ${JSON.stringify(out.slice(0, 200))}`);
  return v;
}
export function uninstallListCommand() {
  return `$root = ${psSingleQuote(UNINSTALL_ROOT_PS)}; $rows = @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue; [pscustomobject]@{ Key = $_.PSChildName; DisplayName = $p.DisplayName; DisplayVersion = $p.DisplayVersion; UninstallString = $p.UninstallString } } | Where-Object { $_.DisplayName -like '*Curator*' }); ConvertTo-Json -InputObject $rows -Compress -Depth 3`;
}
/** {status, stdout, stderr} → [{Key, DisplayName, DisplayVersion, UninstallString}]; throws when PowerShell failed. */
export function parseUninstallList(r) {
  if (!r || r.status !== 0) throw new Error(`PowerShell exited ${r && r.status}: ${firstLine(r && r.stderr)}`);
  const out = String(r.stdout || '').trim();
  if (!out) return [];
  let v;
  try { v = JSON.parse(out); } catch { throw new Error(`unreadable list reply: ${JSON.stringify(out.slice(0, 200))}`); }
  const rows = v == null ? [] : Array.isArray(v) ? v : [v];
  return rows.filter((e) => e && typeof e === 'object' && typeof e.Key === 'string');
}
/** The keys whose DisplayName is exactly the product name: the app's own entry, never a stranger's "Curator-something". */
export function appUninstallKeys(entries, product = 'The Curator') {
  return entries.filter((e) => e.DisplayName === product).map((e) => e.Key);
}

function ok(cond, label, detail = '') {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); console.log(`::error::${label}${detail ? ` — ${String(detail).replace(/\r?\n/g, ' ')}` : ''}`); }
  return !!cond;
}
function eq(a, b, label) {
  return ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
function section(t) { console.log(`\n${t}`); }
function finish(what) {
  console.log(`\n${failures ? `✗ ${what}: ${failures} check(s) failed` : `✓ ${what}: every check passed`}`);
  process.exit(failures ? 1 : 0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSROOT = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
const PS = path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TASKKILL = path.join(SYSROOT, 'System32', 'taskkill.exe');
const WHERE = path.join(SYSROOT, 'System32', 'where.exe');
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function ps(command, timeout = 120000) {
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}`], { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
function psJson(command) {
  const r = ps(`${command} | ConvertTo-Json -Compress -Depth 4`);
  // A command PowerShell cannot even parse prints nothing on stdout: say so,
  // instead of letting it read as "no such thing" (v3.99.3-wintest.2).
  if (r.status !== 0) console.log(`    · PowerShell exited ${r.status}: ${firstLine(r.stderr)}`);
  try { return r.stdout ? JSON.parse(r.stdout) : null; } catch { return null; }
}
function firstLine(text) { return String(text || '').split(/\r?\n/).find((l) => l.trim()) || '(no error text)'; }

function sha256File(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    let names = [];
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}\\${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) { try { out[r] = sha256File(full); } catch { out[r] = 'unreadable'; } }
    }
  };
  walk(dir, '');
  return out;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err && err.code === 'EPERM'; }
}
function killTree(pid) {
  if (!pid) return;
  spawnSync(TASKKILL, ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
}
async function waitFor(pred, { timeoutMs, everyMs = 1000 }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

function localAppData() { return process.env.LOCALAPPDATA; }
function appSupport() { return path.join(localAppData(), 'TheCurator'); }
function installDirExpected() { return path.join(localAppData(), 'Programs', PRODUCT); }

/** The environment a person's app gets: no test seams, no ELECTRON_*. */
function personEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^CURATOR_TEST_/i.test(k) || /^ELECTRON_/i.test(k) || /^(PORT|DOMAINS_PATH|NODE_OPTIONS)$/i.test(k)) delete env[k];
  }
  return { ...env, ...extra };
}
/** No git anywhere on PATH (the runner has Git for Windows on its PATH). */
function noGitPath() { return `${path.join(SYSROOT, 'System32')};${SYSROOT}`; }
function withPath(env, value) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== 'PATH') out[k] = v;
  out.Path = value;
  return out;
}

async function getJson(port, p) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (err) { return { status: 0, body: null, error: err.message }; }
}

/**
 * Start the app and wait until its server answers. `instancesRoot` is where
 * its instance record lands. Returns {pid, port, version, body} or null.
 */
async function launchApp({ exe, env, instancesRoot, version, timeoutMs = 180000, notPid = null }) {
  const child = spawn(exe, [], { env, detached: true, stdio: 'ignore', windowsHide: false });
  const spawnError = catchSpawnError(child);
  child.unref();
  const hit = await waitFor(async () => {
    if (spawnError()) return { spawnError: spawnError() };
    for (const r of readInstanceRecords(instancesRoot)) {
      if (r.pid === notPid || !alive(r.pid)) continue;
      if (version && r.version !== version) continue;
      const v = await getJson(r.port, '/api/version');
      if (v.status === 200 && v.body) return { pid: r.pid, port: r.port, version: v.body.version, body: v.body };
    }
    return null;
  }, { timeoutMs, everyMs: 1500 });
  if (hit && hit.spawnError) {
    ok(false, `"${exe}" could not be started`, `${spawnErrorText(hit.spawnError)}${existsSync(exe) ? ' (the file exists)' : ' (no such file)'}`);
    return null;
  }
  if (!hit) killTree(child.pid);
  return hit ? { ...hit, launcherPid: child.pid } : null;
}
async function waitForRunningApp({ instancesRoot, version, notPid, timeoutMs }) {
  return waitFor(async () => {
    for (const r of readInstanceRecords(instancesRoot)) {
      if (r.pid === notPid || !alive(r.pid) || r.version !== version) continue;
      const v = await getJson(r.port, '/api/version');
      if (v.status === 200 && v.body) return { pid: r.pid, port: r.port, version: v.body.version, body: v.body };
    }
    return null;
  }, { timeoutMs, everyMs: 2000 });
}

function isolatedEnv(root, extra = {}) {
  const ud = path.join(root, 'user data');
  mkdirSync(path.join(ud, 'domains'), { recursive: true });
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  return {
    env: personEnv({
      CURATOR_TEST_USER_DATA_DIR: ud,
      CURATOR_TEST_DOMAINS_DIR: path.join(ud, 'domains'),
      CURATOR_TEST_LOG_DIR: path.join(root, 'logs'),
      ...extra,
    }),
    instancesRoot: path.join(ud, 'instances'),
  };
}

function versionInfo(file) {
  return psJson(`(Get-Item -LiteralPath ${psq(file)}).VersionInfo | Select-Object ProductVersion, FileVersion, ProductName`);
}
function shortcutTarget(lnk) {
  const r = ps(`(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)}).TargetPath`);
  return r.status === 0 ? r.stdout : null;
}
function shortcutPaths() {
  const r = psJson("[pscustomobject]@{ desktop = [Environment]::GetFolderPath('Desktop'); programs = [Environment]::GetFolderPath('Programs') }");
  return {
    desktop: r ? path.join(r.desktop, SHORTCUT) : null,
    startMenu: r ? path.join(r.programs, SHORTCUT) : null,
  };
}
async function uninstallKey(guid) {
  return parseUninstallKeyProbe(ps(uninstallKeyCommand(guid)));
}
/** Every HKCU Uninstall subkey that names The Curator, with its key name: printed when the expected key is missing. */
function curatorUninstallEntries() {
  return parseUninstallList(ps(uninstallListCommand()));
}
/** Throws (a failed check, never "absent") when PowerShell itself failed. */
function probeAbsent(guid, label) {
  try { return ok(uninstallKeyAbsentNow(guid), label); } catch (e) { return ok(false, label, e.message); }
}
function uninstallKeyAbsentNow(guid) { return parseUninstallKeyProbe(ps(uninstallKeyCommand(guid))) === null; }
function printCuratorUninstallEntries() {
  let list;
  try { list = curatorUninstallEntries(); } catch (e) { console.log(`    · could not list HKCU\\…\\Uninstall: ${e.message}`); return; }
  if (!list.length) { console.log('    · no HKCU\\…\\Uninstall subkey has a DisplayName containing "Curator"'); return; }
  for (const e of list) console.log(`    · HKCU\\…\\Uninstall\\${e.Key}: DisplayName ${JSON.stringify(e.DisplayName)}, DisplayVersion ${JSON.stringify(e.DisplayVersion)}, UninstallString ${JSON.stringify(e.UninstallString)}`);
}
function machineKeyExists(guid) {
  const r = ps(`(Test-Path -LiteralPath 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}') -or (Test-Path -LiteralPath 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}')`);
  return r.stdout.trim() === 'True';
}

function runInstaller(setup, args, timeout = 600000) {
  // Verbatim: NSIS reads /D= raw, to the end of the line, and never unquotes.
  const r = spawnSync(setup, args, { windowsVerbatimArguments: true, timeout, windowsHide: true });
  return r.status;
}

async function waitUninstalled(installDir, timeoutMs = 240000) {
  return waitFor(() => !existsSync(path.join(installDir, EXE_NAME)) && !existsSync(path.join(installDir, UNINSTALLER)),
    { timeoutMs, everyMs: 1000 });
}

/** Write an MCP initialize to a bridge and wait for its reply. */
function mcpInitialize(child, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      for (const line of buf.split('\n')) {
        try {
          const m = JSON.parse(line);
          if (m && m.id === 1 && m.result) { clearTimeout(timer); resolve(m.result); return; }
        } catch { /* partial */ }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-win-app', version: '0' } },
    })}\n`);
  });
}

function requireWindows(cmd) {
  if (process.platform !== 'win32') {
    console.error(`ci-win-app ${cmd}: runs on Windows only (the windows-latest runner). Nothing was done.`);
    process.exit(2);
  }
}

async function importFrom(appRoot, rel) {
  return import(pathToFileURL(path.join(appRoot, ...rel.split('/'))).href);
}

// ═════════════════════════════════════════════════════════════════════════
//  git checks (D): no git on PATH, no credential window, the repair sentence
// ═════════════════════════════════════════════════════════════════════════

async function gitChecks({ appRoot, exe, moduleRoot, label }) {
  section(`git: ${label}`);
  const se = await importFrom(moduleRoot, 'src/brain/subprocess-env.js');
  const syncMod = await importFrom(moduleRoot, 'src/brain/sync.js');
  const diag = await importFrom(moduleRoot, 'src/brain/diagnostics.js');
  const base = withPath(personEnv(), noGitPath());

  const where = spawnSync(WHERE, ['git'], { env: base, encoding: 'utf8', windowsHide: true });
  ok(where.status !== 0, 'CONTROL: with this PATH, where.exe finds no git (the runner\'s Git for Windows is out of reach)');

  const plan = se.planGit({ platform: 'win32', env: base, execPath: exe, appRoot, isBundle: true, exists: existsSync });
  const expectedExe = path.join(path.dirname(appRoot), 'git', 'cmd', 'git.exe');
  ok(plan.bundledPresent === true, 'planGit finds the bundled git');
  eq(plan.bundledExe, expectedExe, 'planGit names <resources>\\git\\cmd\\git.exe');

  // Sync starts `git` by NAME with the plan's env (sync.js); resolve it the same way.
  const runGit = (args, opts = {}) => spawnSync('git', [...plan.configArgs, ...args], {
    env: { ...plan.env, GIT_AUTHOR_NAME: 'CI', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'CI', GIT_COMMITTER_EMAIL: 'ci@example.invalid' },
    encoding: 'utf8', timeout: 120000, windowsHide: true, ...opts,
  });
  const ver = runGit(['--version']);
  ok(ver.status === 0 && (ver.stdout || '').trim() === GIT_VERSION_LINE,
    `git by name, with the plan's PATH and no git on the person's PATH, is the bundled one (${(ver.stdout || ver.stderr || '').trim()})`);

  const work = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-git-')));
  const top = path.join(work, 'Sync Ž é');
  mkdirSync(top, { recursive: true });
  const remote = path.join(top, 'remote.git');
  const local = path.join(top, 'knowledge base');
  const steps = [
    ['init', '--bare', remote],
    ['init', local],
  ];
  for (const s of steps) { const r = runGit(s); ok(r.status === 0, `git ${s[0]} ${s[1]}`, r.stderr); }
  const note = 'Ziga Novak, notes é č ž\r\nsecond line\r\n';
  mkdirSync(path.join(local, 'wiki'), { recursive: true });
  writeFileSync(path.join(local, 'wiki', 'opomba ž.md'), note);
  for (const s of [['add', '-A'], ['commit', '-m', 'first'], ['push', remote, 'HEAD:refs/heads/main']]) {
    const r = runGit(s, { cwd: local });
    ok(r.status === 0, `git ${s[0]} (in a folder with a space and a non-ASCII letter)`, r.stderr);
  }
  const clone = path.join(top, 'clone back');
  const c = runGit(['clone', '--branch', 'main', remote, clone]);
  ok(c.status === 0, 'git clone of what was pushed', c.stderr);
  ok(existsSync(path.join(clone, 'wiki', 'opomba ž.md')), 'the pushed file is in the clone, under its non-ASCII name');

  // ── No credential window: a 401 must end quickly, with no GCM process. ──
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ci"', 'Content-Type': 'text/plain' });
    res.end('auth required');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let gcmSeen = false;
  const watcher = setInterval(() => {
    const t = spawnSync(path.join(SYSROOT, 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    if (/git-credential-manager|credential-manager-core|git-credential-wincred/i.test(t.stdout || '')) gcmSeen = true;
  }, 700);
  const started = Date.now();
  const lsr = await new Promise((resolve) => {
    const ch = spawn('git', [...plan.configArgs, 'ls-remote', `http://127.0.0.1:${port}/knowledge.git`], { env: plan.env, windowsHide: true });
    let stderr = '';
    ch.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { try { ch.kill(); } catch { /* */ } resolve({ status: 'timeout', stderr }); }, 60000);
    ch.on('close', (code) => { clearTimeout(t); resolve({ status: code, stderr }); });
    ch.on('error', (err) => { clearTimeout(t); resolve({ status: 'error', stderr: err.message }); });
  });
  clearInterval(watcher);
  server.close();
  const secs = (Date.now() - started) / 1000;
  ok(lsr.status !== 'timeout' && lsr.status !== 0, `a rejected token fails instead of waiting (exit ${lsr.status}, ${secs.toFixed(1)} s)`, lsr.stderr);
  ok(secs < 45, 'it ended in under 45 s (no prompt was waited for)');
  ok(requests >= 1, `git really reached the server (${requests} request(s))`);
  ok(!gcmSeen, 'no Git Credential Manager process was started');
  const sysHelper = spawnSync('C:\\Program Files\\Git\\cmd\\git.exe', ['config', '--system', '--get', 'credential.helper'], { encoding: 'utf8', windowsHide: true });
  console.log(`  · CONTROL (information): the runner's Git for Windows has credential.helper=${(sysHelper.stdout || '').trim() || '(none)'}`);

  // ── The repair sentence when the bundled git is gone. ──
  const gitDir = path.dirname(path.dirname(plan.bundledExe));
  const hidden = `${gitDir}.ci-hidden`;
  renameSync(gitDir, hidden);
  try {
    const gone = se.planGit({ platform: 'win32', env: base, execPath: exe, appRoot, isBundle: true, exists: existsSync });
    ok(gone.bundledPresent === false, 'with resources\\git hidden, planGit reports no bundled git');
    const row = await diag.checkGit(null, { platform: 'win32', isBundle: true, plan: gone });
    const want = syncMod.gitMissingMessage({ platform: 'win32', isBundle: true });
    eq([row.status, row.detail], ['fail', want], 'System Check\'s git row is the Windows app\'s repair sentence (real ENOENT, no git on PATH)');
    ok(/installer/i.test(row.detail) && /keeps your notes/i.test(row.detail) && !/xcode/i.test(row.detail),
      'CROSS-CHECK: it says to run the installer again, that notes are kept, and never xcode-select');
  } finally {
    renameSync(hidden, gitDir);
  }
  rmSync(work, { recursive: true, force: true });
}

async function gitChecksOverHttp({ exe, installDir, version }) {
  section('git: System Check over HTTP, from the installed app, with no git on PATH');
  const gitDir = path.join(installDir, 'resources', 'git');
  const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-diag-')));
  const want = (await importFrom(path.join(installDir, 'resources', 'app'), 'src/brain/sync.js'))
    .gitMissingMessage({ platform: 'win32', isBundle: true });
  const probe = async (tag) => {
    const iso = isolatedEnv(path.join(tmp, tag));
    const app = await launchApp({ exe, env: withPath(iso.env, noGitPath()), instancesRoot: iso.instancesRoot, version, timeoutMs: 180000 });
    if (!ok(!!app, `the app started (${tag})`)) return null;
    const d = await getJson(app.port, '/api/diagnostics/quick');
    killTree(app.pid);
    await waitFor(() => !alive(app.pid), { timeoutMs: 30000 });
    return d.body && Array.isArray(d.body.checks) ? d.body.checks.find((c) => c.id === 'git') : null;
  };
  const okRow = await probe('with-git');
  ok(okRow && okRow.status === 'ok' && String(okRow.detail).includes(GIT_VERSION_LINE),
    'System Check: git ok, and it is the bundled 2.56.1.windows.1', JSON.stringify(okRow));
  renameSync(gitDir, `${gitDir}.ci-hidden`);
  try {
    const failRow = await probe('without-git');
    eq(failRow && [failRow.status, failRow.detail], ['fail', want],
      'System Check with the bundled git removed: fail, with the reinstall sentence');
  } finally {
    renameSync(`${gitDir}.ci-hidden`, gitDir);
  }
  rmSync(tmp, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════
//  check-build
// ═════════════════════════════════════════════════════════════════════════

async function checkBuild({ unpacked, setup, version }) {
  const wp = await import(pathToFileURL(path.join(ROOT, 'desktop', 'lib', 'win-pack.mjs')).href);
  const fm = await import(pathToFileURL(path.join(ROOT, 'desktop', 'lib', 'fetch-mingit.mjs')).href);
  const planWin = await import(pathToFileURL(path.join(ROOT, 'desktop', 'lib', 'update-plan-win32.js')).href);
  const exe = path.join(unpacked, EXE_NAME);
  const res = path.join(unpacked, 'resources');
  const app = path.join(res, 'app');

  section('versions');
  const ev = versionInfo(exe);
  ok(ev && new RegExp(`^${version.replace(/\./g, '\\.')}(\\.0)?$`).test(String(ev.ProductVersion)), `The Curator.exe ProductVersion is ${version}`, JSON.stringify(ev));
  ok(ev && new RegExp(`^${version.replace(/\./g, '\\.')}(\\.0)?$`).test(String(ev.FileVersion)), `The Curator.exe FileVersion is ${version}`, JSON.stringify(ev));
  const sv = versionInfo(setup);
  eq(sv && planWin.normaliseProductVersion(String(sv.ProductVersion)), version,
    'the SETUP program\'s ProductVersion, normalised exactly as the updater does, is the version (else every update is refused as staged-version-mismatch)');
  const pe = wp.readPeVersionInfo(readFileSync(exe));
  eq(wp.checkExeVersion({ expected: version, info: pe }).problems, [], 'CROSS-CHECK: win-pack.mjs reads the same version from the exe\'s bytes');
  eq(JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')).version, version, 'resources\\app\\package.json carries the version');

  section('bundle marker, notices, icons, dependencies');
  // The marker is named only by desktop/ and paths.js (scripts/test-paths-win32.js
  // scans for it), so it is checked through win-pack.mjs's own afterSign check.
  const signCheck = (dir) => { try { wp.winAfterSign({ appOutDir: dir, repoRoot: ROOT, log: () => {} }); return null; } catch (e) { return e.message; } };
  const built = signCheck(unpacked);
  ok(built === null, 'win-pack.mjs winAfterSign on the built tree: the bundle marker, the exe version and RunAsNode all hold', built);
  const notices = path.join(res, fm.NOTICES_FILE);
  const nt = existsSync(notices) ? readFileSync(notices, 'utf8') : '';
  ok(nt.includes(`MinGit ${fm.MINGIT.version}`) && nt.includes(fm.MINGIT.tag), 'THIRD-PARTY-NOTICES.txt names MinGit 2.56.1 and its tag');
  ok(nt.includes(fm.MINGIT_SOURCE.asset), `THIRD-PARTY-NOTICES.txt names the source file the release carries (${fm.MINGIT_SOURCE.asset})`);
  for (const f of wp.TRAY_ICON_FILES) ok(existsSync(path.join(app, 'build', f)), `tray icon resources\\app\\build\\${f}`);
  const deps = Object.keys(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies || {});
  ok(deps.length >= 5, `CONTROL: the root manifest lists ${deps.length} runtime dependencies`);
  for (const d of deps) ok(existsSync(path.join(app, 'node_modules', ...d.split('/'), 'package.json')), `resources\\app\\node_modules\\${d}`);
  ok(!existsSync(path.join(res, 'app-update.yml')), 'no resources\\app-update.yml (no electron-updater feed)');
  const dist = path.dirname(unpacked);
  eq(readdirSync(dist).filter((n) => /\.blockmap$/i.test(n) || /^latest.*\.ya?ml$/i.test(n)), [], 'no .blockmap and no latest*.yml in the output');

  section('bundled git (MinGit, unmodified)');
  const gitExe = path.join(res, 'git', 'cmd', 'git.exe');
  const gv = spawnSync(gitExe, ['--version'], { encoding: 'utf8', windowsHide: true });
  eq((gv.stdout || '').trim(), GIT_VERSION_LINE, 'resources\\git\\cmd\\git.exe --version');
  for (const f of ['LICENSE.txt', path.join('etc', 'package-versions.txt')]) ok(existsSync(path.join(res, 'git', f)), `resources\\git\\${f} (shipped unmodified)`);
  const manifest = JSON.parse(readFileSync(path.join(fm.DEFAULT_OUT_DIR, fm.STAGE_DIR_NAME, fm.MANIFEST_FILE), 'utf8'));
  const tree = fm.checkTreeAgainstManifest(path.join(res, 'git'), manifest);
  ok(tree.ok, `resources\\git is file-for-file the verified MinGit (${Object.keys(manifest.files).length} files)`, tree.problems.slice(0, 5).join('; '));

  section('RunAsNode: the exe runs as Node (what Claude Desktop does for the MCP bridge)');
  const rn = spawnSync(exe, ['-e', 'process.stdout.write(JSON.stringify({e: process.versions.electron, n: process.versions.node}))'],
    { env: personEnv({ ELECTRON_RUN_AS_NODE: '1' }), encoding: 'utf8', timeout: 60000, windowsHide: true });
  let rv = null;
  try { rv = JSON.parse(rn.stdout); } catch { /* */ }
  const pinnedElectron = JSON.parse(readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).devDependencies.electron;
  eq(rv && rv.e, pinnedElectron, `ELECTRON_RUN_AS_NODE=1 "The Curator.exe" -e … ran as Node inside Electron ${pinnedElectron}`);
  const wire = wp.readFuseWire(readFileSync(exe));
  ok(wp.runAsNodeEnabled(wire), 'CROSS-CHECK: the fuse wire read from the exe has RunAsNode enabled');

  section('the app, launched from a copy OUTSIDE the workspace');
  const outside = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-copy-')));
  const copy = path.join(outside, 'Programs Ž é', PRODUCT);
  const copied = copyTree(unpacked, copy);
  const copiedExe = path.join(copy, EXE_NAME);
  const landed = ok(existsSync(copiedExe), `the copy is where it was asked to be: …\\Programs Ž é\\${PRODUCT}\\${EXE_NAME}`,
    `not there; what the temporary folder holds:\n${describeTree(outside, 3)}`);
  eq(countFiles(copy), countFiles(unpacked), `CROSS-CHECK: the copy holds as many files as win-unpacked (${copied} copied)`);
  const iso = isolatedEnv(path.join(outside, 'data'));
  const run = landed ? await launchApp({ exe: copiedExe, env: iso.env, instancesRoot: iso.instancesRoot, version }) : null;
  ok(!!run, 'the copied app started and its server answered /api/version');
  if (run) {
    eq([run.body.version, run.body.installMode, run.body.capabilities && run.body.capabilities.mcpLaunchStyle],
      [version, 'bundle', 'app-binary'], '/api/version: the version, a bundle, and the Windows app\'s MCP launch style');
    killTree(run.pid);
  }
  finish('check-build');
}

// ═════════════════════════════════════════════════════════════════════════
//  install-smoke
// ═════════════════════════════════════════════════════════════════════════

async function installSmoke({ setup, version }) {
  const wp = await import(pathToFileURL(path.join(ROOT, 'desktop', 'lib', 'win-pack.mjs')).href);
  const installDir = installDirExpected();
  const exe = path.join(installDir, EXE_NAME);
  const dataDir = path.join(appSupport(), 'App');
  // THIS process imports the installed app's modules (git checks); the seams
  // keep those imports off the person's folders. Every app this starts gets
  // personEnv() (seams stripped) plus its own isolated folders.
  const seams = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-seams-')));
  process.env.CURATOR_TEST_USER_DATA_DIR = path.join(seams, 'ud');
  process.env.CURATOR_TEST_DOMAINS_DIR = path.join(seams, 'ud', 'domains');
  process.env.CURATOR_TEST_LOG_DIR = path.join(seams, 'logs');
  mkdirSync(process.env.CURATOR_TEST_DOMAINS_DIR, { recursive: true });

  section('before');
  ok(!existsSync(exe), 'nothing is installed yet');
  mkdirSync(path.join(dataDir, 'domains', 'ci-sentinel', 'wiki'), { recursive: true });
  writeFileSync(path.join(dataDir, 'sentinel.txt'), 'The Curator CI sentinel: Ž é č\r\nmust survive uninstall\r\n');
  writeFileSync(path.join(dataDir, 'domains', 'ci-sentinel', 'wiki', 'index.md'), '# Index\n\n- [[alpha]]\n');
  const seeded = snapshot(dataDir);
  ok(Object.keys(seeded).length === 2, `CONTROL: two seeded files under %LOCALAPPDATA%\\TheCurator\\App (${Object.keys(seeded).join(', ')})`);

  section('silent install');
  eq(runInstaller(setup, ['/S']), 0, 'the setup program /S exits 0');
  for (const f of [EXE_NAME, UNINSTALLER, path.join('resources', 'app', 'package.json'), path.join('resources', 'git', 'cmd', 'git.exe'), path.join('resources', 'THIRD-PARTY-NOTICES.txt')]) {
    ok(existsSync(path.join(installDir, f)), `installed: %LOCALAPPDATA%\\Programs\\The Curator\\${f}`);
  }
  let installed = null;
  try { wp.winAfterSign({ appOutDir: installDir, repoRoot: ROOT, log: () => {} }); } catch (e) { installed = e.message; }
  ok(installed === null, 'the bundle marker is INSIDE the installer payload (win-pack.mjs winAfterSign on the INSTALLED folder: marker, exe version, RunAsNode)', installed);
  let key = null;
  let keyError = '';
  try { key = await uninstallKey(wp.NSIS_GUID); } catch (e) { keyError = e.message; }
  ok(!!key, `HKCU\\…\\Uninstall\\${wp.NSIS_GUID} exists`, keyError || 'the key is absent');
  if (!key) printCuratorUninstallEntries();
  let entries = null;
  try { entries = curatorUninstallEntries(); } catch (e) { ok(false, 'HKCU\\…\\Uninstall can be listed', e.message); }
  if (entries) eq(appUninstallKeys(entries, PRODUCT), [wp.NSIS_GUID], `CROSS-CHECK: the one HKCU Uninstall subkey named "${PRODUCT}" is ${wp.NSIS_GUID} (win-pack.mjs NSIS_GUID, what install.ps1 looks for)`);
  if (key) {
    eq([key.DisplayName, key.DisplayVersion], [PRODUCT, version], 'Apps & features: "The Curator", and its DisplayVersion is the version');
    ok(String(key.UninstallString || '').toLowerCase().includes(installDir.toLowerCase()), 'its UninstallString points into the install folder', key.UninstallString);
  }
  ok(!machineKeyExists(wp.NSIS_GUID), 'no HKLM uninstall key (per user, no administrator)');
  const sc = shortcutPaths();
  for (const [where, lnk] of [['Desktop', sc.desktop], ['Start menu', sc.startMenu]]) {
    ok(lnk && existsSync(lnk), `${where} shortcut "${SHORTCUT}"`, lnk);
    if (lnk && existsSync(lnk)) eq(String(shortcutTarget(lnk) || '').toLowerCase(), exe.toLowerCase(), `${where} shortcut → the installed exe`);
  }

  section('the installed app starts');
  const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-smoke-')));
  const iso = isolatedEnv(path.join(tmp, 'run'));
  const run = await launchApp({ exe, env: iso.env, instancesRoot: iso.instancesRoot, version });
  ok(!!run, 'the installed app started and its local server answered /api/version');
  if (run) {
    eq([run.body.version, run.body.installMode, run.body.capabilities && run.body.capabilities.mcpLaunchStyle],
      [version, 'bundle', 'app-binary'], '/api/version from the installed app');
    killTree(run.pid);
    await waitFor(() => !alive(run.pid), { timeoutMs: 30000 });
  }

  await gitChecks({ appRoot: path.join(installDir, 'resources', 'app'), exe, moduleRoot: path.join(installDir, 'resources', 'app'), label: 'the INSTALLED app\'s git and modules' });
  await gitChecksOverHttp({ exe, installDir, version });

  section('silent uninstall keeps the data');
  const roaming = path.join(process.env.APPDATA, PRODUCT);
  const roamingBefore = existsSync(roaming);
  eq(runInstaller(path.join(installDir, UNINSTALLER), ['/S']), 0, 'the uninstaller /S exits 0');
  ok(!!(await waitUninstalled(installDir)), 'the program files are gone');
  probeAbsent(wp.NSIS_GUID, 'the HKCU uninstall key is gone');
  for (const [where, lnk] of [['Desktop', sc.desktop], ['Start menu', sc.startMenu]]) ok(!lnk || !existsSync(lnk), `${where} shortcut removed`);
  const after = snapshot(dataDir);
  const d = snapshotDiff(seeded, after);
  eq([d.changed, d.missing], [[], []], '%LOCALAPPDATA%\\TheCurator\\App\\sentinel.txt and the seeded wiki page are byte-identical');
  if (roamingBefore) ok(existsSync(roaming), '%APPDATA%\\The Curator (window state) is kept (deleteAppDataOnUninstall: false)');

  section('the installer refuses the data folder');
  for (const target of [appSupport(), dataDir]) {
    const before = snapshot(appSupport());
    const code = runInstaller(setup, ['/S', `/D=${target}`]);
    eq(code, 2, `/S /D=${target.replace(localAppData(), '%LOCALAPPDATA%')} exits 2 (refused)`);
    await sleep(3000);
    const now = snapshot(appSupport());
    const diff = snapshotDiff(before, now);
    eq([diff.changed, diff.missing, diff.added], [[], [], []], '…and nothing in %LOCALAPPDATA%\\TheCurator changed, vanished or appeared');
    ok(!existsSync(path.join(target, EXE_NAME)), '…and no The Curator.exe was written there');
    probeAbsent(wp.NSIS_GUID, '…and no uninstall key was written');
  }
  rmSync(tmp, { recursive: true, force: true });
  finish('install-smoke');
}

// ═════════════════════════════════════════════════════════════════════════
//  rehearse-update
// ═════════════════════════════════════════════════════════════════════════

async function rehearseUpdate({ from, fromVersion, to, toVersion }) {
  const wp = await import(pathToFileURL(path.join(ROOT, 'desktop', 'lib', 'win-pack.mjs')).href);
  const installDir = installDirExpected();
  const exe = path.join(installDir, EXE_NAME);
  const appRoot = path.join(installDir, 'resources', 'app');
  const dataDir = path.join(appSupport(), 'App');
  const updatesDir = path.join(appSupport(), 'updates');
  const instancesRoot = path.join(appSupport(), 'instances');
  const toName = path.basename(to);
  eq(toName, wp.installerFileName(toVersion), 'CONTROL: the N+1 setup carries the published name');

  section(`install ${fromVersion} and seed a knowledge base`);
  ok(!existsSync(exe), 'nothing is installed yet');
  eq(runInstaller(from, ['/S']), 0, `the ${fromVersion} setup /S exits 0`);
  mkdirSync(path.join(dataDir, 'domains', 'ci-rehearsal', 'wiki', 'entities'), { recursive: true });
  mkdirSync(path.join(dataDir, 'domains', 'ci-rehearsal', 'raw'), { recursive: true });
  writeFileSync(path.join(dataDir, 'sentinel.txt'), 'survives the update: Ž é č\r\n');
  writeFileSync(path.join(dataDir, 'domains', 'ci-rehearsal', 'wiki', 'entities', 'alpha.md'), '---\ntype: entity\n---\n# Alpha\n\nKept across the update.\n');
  writeFileSync(path.join(dataDir, 'domains', 'ci-rehearsal', 'raw', 'izvor é.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0xc5, 0xbd]));
  const seededNames = ['sentinel.txt', 'domains\\ci-rehearsal\\wiki\\entities\\alpha.md', 'domains\\ci-rehearsal\\raw\\izvor é.txt'];
  const sc = shortcutPaths();
  const targetsBefore = [shortcutTarget(sc.desktop), shortcutTarget(sc.startMenu)];

  section(`run ${fromVersion} as a person would (no test seams)`);
  const appN = await launchApp({ exe, env: personEnv(), instancesRoot, version: fromVersion, timeoutMs: 240000 });
  if (!ok(!!appN, `${fromVersion} started and answered /api/version`)) finish('rehearse-update');
  // Let its own start finish (afterStart tidies updates\ once; a download made
  // before that would be swept).
  await sleep(20000);
  const before = snapshot(dataDir);
  for (const n of seededNames) ok(n in before, `seeded: App\\${n}`);

  section('serve N+1 from a local fixture');
  const bytes = statSync(to).size;
  const digest = sha256File(to);
  const releases = fixtureReleases({ version: toVersion, assetName: toName, size: bytes, sha256: digest });
  const hits = { releases: 0, download: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === '/releases') { hits.releases++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(releases)); return; }
    if (req.url === `/download/v${toVersion}/${encodeURI(toName)}` || req.url === `/download/v${toVersion}/${toName}`) {
      hits.download++;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes });
      createReadStream(to).pipe(res);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // The INSTALLED app's own modules: what shipped, not this checkout. Their
  // imports resolve inside resources\app (node_modules shipped there). The
  // seams keep THIS process's imports off the person's App folder; the app's
  // own process and the helper never see them (personEnv()).
  const scratch = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-rehearse-')));
  process.env.CURATOR_TEST_USER_DATA_DIR = path.join(scratch, 'ud');
  process.env.CURATOR_TEST_DOMAINS_DIR = path.join(scratch, 'ud', 'domains');
  process.env.CURATOR_TEST_LOG_DIR = path.join(scratch, 'logs');
  mkdirSync(process.env.CURATOR_TEST_DOMAINS_DIR, { recursive: true });
  const cfg = await importFrom(appRoot, 'src/routes/config.js');
  const { createUpdateInstaller } = await importFrom(appRoot, 'lib/update-engine.js');
  const { resolveInstallerRelease } = await importFrom(appRoot, 'lib/update-release.js');
  const { runCommandWith } = await importFrom(appRoot, 'lib/run-command.js');
  const calls = [];
  const fetchImpl = makeFixtureFetch({ releasesApiUrl: cfg.RELEASES_API_URL, base, onCall: (u, t) => calls.push([u, t]) });

  let quits = 0;
  const env = personEnv();
  const engine = createUpdateInstaller('win32', {
    resolveRelease: ({ signal }) => resolveInstallerRelease({
      configModule: cfg, fetchImpl, currentVersion: fromVersion, arch: 'x64', signal, platform: 'win32',
    }),
    fetchImpl,
    execPath: exe,
    arch: 'x64',
    env,
    workDir: updatesDir,
    logPath: path.join(appSupport(), 'logs', 'update-install.log'),
    runCommand: (cmd, args, opts) => runCommandWith(spawn, cmd, args, opts),
    spawnDetached: (cmd, args, opts = {}) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...(opts.env ? { env: opts.env } : {}) });
      catchSpawnError(child, (err) => ok(false, `the engine's detached "${cmd}" could not be started`, spawnErrorText(err)));
      child.unref();
      return child;
    },
    // The app is ANOTHER process here; the engine's "quit" ends it.
    quitApp: () => { quits++; killTree(appN.pid); },
    writeRegistry: {},
    pid: appN.pid,
    showMessages: false,
  });
  ok(!!engine, 'the installed app\'s createUpdateInstaller(\'win32\') built an engine');

  section('prepare');
  const prep = await engine.prepareUpdate({});
  eq([prep.ok, prep.version, prep.verifiedDigest], [true, toVersion, `sha256:${digest}`], 'prepareUpdate: N+1 resolved, downloaded, size + SHA-256 + ProductVersion checked', JSON.stringify(prep));
  eq([hits.releases, hits.download], [1, 1], 'the fixture served the release list once and the setup once');
  ok(calls.every(([, t]) => t), 'no call left the fixture', JSON.stringify(calls));
  if (!prep.ok) { killTree(appN.pid); server.close(); finish('rehearse-update'); }

  section('an AI app connection holds The Curator.exe');
  const bridge = spawn(exe, [path.join(appRoot, 'mcp', 'server.js')], {
    env: personEnv({ ELECTRON_RUN_AS_NODE: '1' }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let bridgeExited = false;
  bridge.on('exit', () => { bridgeExited = true; });
  catchSpawnError(bridge, (err) => { bridgeExited = true; ok(false, `the MCP bridge "${exe}" could not be started`, spawnErrorText(err)); });
  bridge.stdin.on('error', () => { /* EPIPE after a failed start: reported above */ });
  const init = await mcpInitialize(bridge);
  ok(!!(init && init.serverInfo), 'the bridge answers an MCP initialize (the installed exe as Node, over stdio)', JSON.stringify(init));
  const inUse = await engine.checkInUse();
  eq([inUse.ok, inUse.connections, inUse.others], [true, 1, 0], 'checkInUse: one AI app connection, nothing else');
  const refused = await engine.installUpdate({ token: prep.token });
  eq([refused.ok, refused.reason, refused.connections, refused.canStopConnections], [false, 'in-use-by-ai-app', 1, true],
    'installUpdate without consent REFUSES with in-use-by-ai-app', JSON.stringify(refused));
  eq(quits, 0, '…BEFORE quitting: the app was not asked to quit');
  ok(alive(appN.pid) && !bridgeExited, '…the app and the connection are both still running');

  section('install, with consent to stop the connection');
  const res = await engine.installUpdate({ token: prep.token, stopConnections: true });
  eq([res.ok, res.installing, res.version, res.stoppedConnections], [true, true, toVersion, 1], 'installUpdate: the helper is running and the app quits', JSON.stringify(res));
  eq(quits, 1, 'quitApp was called once');
  ok(!!(await waitFor(() => !alive(appN.pid), { timeoutMs: 60000 })), `${fromVersion} exited`);
  ok(!!(await waitFor(() => bridgeExited, { timeoutMs: 180000 })), 'the helper stopped the AI app connection');

  section(`the app reopens on ${toVersion}`);
  const appN1 = await waitForRunningApp({ instancesRoot, version: toVersion, notPid: appN.pid, timeoutMs: 600000 });
  ok(!!appN1, `${toVersion} is running and answers /api/version`);
  if (appN1) eq([appN1.body.version, appN1.body.installMode], [toVersion, 'bundle'], '/api/version after the update');
  const logFile = path.join(appSupport(), 'logs', 'update-install.log');
  if (existsSync(logFile)) console.log(`  · update-install.log:\n${readFileSync(logFile, 'utf8').split(/\r?\n/).slice(-15).map((l) => `      ${l}`).join('\n')}`);
  const emptied = await waitFor(() => (!existsSync(updatesDir) || readdirSync(updatesDir).length === 0 ? true : null),
    { timeoutMs: 120000, everyMs: 2000 });
  ok(!!emptied, 'updates\\ was emptied by the reopened app (afterStart read the outcome once and tidied)',
    existsSync(updatesDir) ? readdirSync(updatesDir).join(', ') : '');
  const ev = versionInfo(exe);
  ok(ev && String(ev.ProductVersion).startsWith(toVersion), `the installed exe is ${toVersion}`, JSON.stringify(ev));
  let key = null;
  try { key = await uninstallKey(wp.NSIS_GUID); } catch (e) { console.log(`    · ${e.message}`); }
  eq(key && key.DisplayVersion, toVersion, 'the HKCU uninstall key now says the new version');
  if (!key) printCuratorUninstallEntries();
  eq([shortcutTarget(sc.desktop), shortcutTarget(sc.startMenu)], targetsBefore, 'both shortcuts are kept, pointing where they did');

  section('the data');
  const now = snapshot(dataDir);
  for (const n of seededNames) eq(now[n], before[n], `App\\${n} is byte-identical`);
  const d = snapshotDiff(before, now);
  console.log(`  · other files the app itself rewrote (information): changed ${JSON.stringify(d.changed.filter((k) => !seededNames.includes(k)))}, ` +
    `missing ${JSON.stringify(d.missing)}, added ${d.added.length}`);
  eq(d.missing, [], 'no file under App vanished');

  if (appN1) killTree(appN1.pid);
  server.close();
  finish('rehearse-update');
}

// ═════════════════════════════════════════════════════════════════════════
//  CLI
// ═════════════════════════════════════════════════════════════════════════

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = { cmd };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const m = a.match(/^--([a-z-]+)$/);
    if (!m) return { error: `unexpected argument ${a}` };
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
    o[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    i++;
  }
  const need = {
    'check-build': ['unpacked', 'setup', 'version'],
    'install-smoke': ['setup', 'version'],
    'rehearse-update': ['from', 'fromVersion', 'to', 'toVersion'],
    'next-version': ['version'],
    'stamp-version': ['version'],
    'git-checks': [],
  }[cmd];
  if (!need) return { error: `unknown subcommand ${cmd}` };
  for (const k of need) if (!o[k]) return { error: `${cmd} needs --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` };
  if (cmd === 'git-checks' && !!o.mingit === !!o.installDir) return { error: 'git-checks needs exactly one of --mingit or --install-dir' };
  return o;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const a = parseArgs(process.argv.slice(2));
  if (a.error) { console.error(`ci-win-app: ${a.error}`); process.exit(2); }
  if (a.cmd === 'next-version') {
    const n = nextPatchVersion(a.version);
    if (!n) { console.error(`ci-win-app: not a plain X.Y.Z version: ${a.version}`); process.exit(2); }
    process.stdout.write(n);
    process.exit(0);
  }
  if (a.cmd === 'stamp-version') {
    const p = path.join(ROOT, 'package.json');
    writeFileSync(p, stampVersionText(readFileSync(p, 'utf8'), a.version));
    console.log(`ci-win-app: package.json version is now ${a.version} (this runner only; never committed)`);
    process.exit(0);
  }
  requireWindows(a.cmd);
  if (a.cmd === 'check-build') await checkBuild({ unpacked: path.resolve(a.unpacked), setup: path.resolve(a.setup), version: a.version });
  else if (a.cmd === 'install-smoke') await installSmoke({ setup: path.resolve(a.setup), version: a.version });
  else if (a.cmd === 'rehearse-update') {
    await rehearseUpdate({ from: path.resolve(a.from), fromVersion: a.fromVersion, to: path.resolve(a.to), toVersion: a.toVersion });
  } else if (a.cmd === 'git-checks') {
    if (a.installDir) {
      const dir = path.resolve(a.installDir);
      await gitChecks({ appRoot: path.join(dir, 'resources', 'app'), exe: path.join(dir, EXE_NAME), moduleRoot: path.join(dir, 'resources', 'app'), label: 'an installed app' });
    } else {
      // Lay the verified MinGit out exactly where an install has it, under a
      // folder with a space and a non-ASCII letter, and use THIS checkout's
      // modules (test.yml: no build on every push).
      const top = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ci-layout-')));
      const inst = path.join(top, 'Programs Ž é', PRODUCT);
      mkdirSync(path.join(inst, 'resources', 'app'), { recursive: true });
      copyTree(path.resolve(a.mingit), path.join(inst, 'resources', 'git'));
      copyFileSync(process.execPath, path.join(inst, EXE_NAME));
      if (!ok(existsSync(path.join(inst, 'resources', 'git', 'cmd', 'git.exe')), 'MinGit is where it was asked to be: …\\Programs Ž é\\The Curator\\resources\\git\\cmd\\git.exe',
        `not there; what the temporary folder holds:\n${describeTree(top, 4)}`)) finish('git-checks');
      process.env.CURATOR_TEST_USER_DATA_DIR = path.join(top, 'ud');
      process.env.CURATOR_TEST_DOMAINS_DIR = path.join(top, 'ud', 'domains');
      process.env.CURATOR_TEST_LOG_DIR = path.join(top, 'logs');
      mkdirSync(process.env.CURATOR_TEST_DOMAINS_DIR, { recursive: true });
      await gitChecks({ appRoot: path.join(inst, 'resources', 'app'), exe: path.join(inst, EXE_NAME), moduleRoot: ROOT, label: 'MinGit laid out as an install, this checkout\'s modules' });
      rmSync(top, { recursive: true, force: true });
    }
    finish('git-checks');
  }
}

