/**
 * "My Curator in your tools" — the one-click installer for the `my-curator`
 * MCP entry in OTHER applications' config files (v3.85.0, macOS only).
 *
 * THIS IS THE MOST DANGEROUS WRITE THE APP MAKES. Every other writer in the
 * repository writes The Curator's own files; this one replaces a file another
 * application owns, which holds that user's other MCP servers and, in their
 * `env` blocks, their API keys. So the module is built as a PURE PLANNER plus a
 * small EXECUTOR with injected IO, and every rule below exists because the
 * failure it prevents is silent and unrecoverable:
 *
 *   1. WHERE: paths come only from the adapter table resolved against home —
 *      never from a request. Every resolved target is asserted to sit under
 *      home before anything is read or written (`outside_home`).
 *   2. WHAT: the launch line is `buildCuratorEntry()` (passed IN by the route —
 *      this module imports no route), the shape is `mcpEntryFor(id, launch)`.
 *      No second launch line, no second shape.
 *   3. ONLY OUR KEY: the next document is the parsed one with exactly
 *      `doc[key]["my-curator"]` set or deleted. A STRUCTURAL CHECK — the two
 *      documents with our key taken out must be deep-equal — runs in the
 *      planner AND again in the executor, or the write is refused
 *      (`structure_changed`).
 *   4. REFUSE WHAT WE CANNOT READ EXACTLY: a symlink, a non-regular file, an
 *      unreadable file, invalid JSON, JSON that only parses once comments are
 *      stripped (JSONC — re-serialising would delete the comments), a
 *      non-object top level, a non-object server map, a DUPLICATE KEY
 *      (JSON.parse keeps the last one, so a rewrite would silently drop the
 *      first — a pasted second `mcpServers` block is a real way to get one),
 *      and a number JSON.parse cannot hold exactly (a rewrite would change it).
 *      A refusal leaves the file byte-identical.
 *   5. BACKUP FIRST: the original BYTES go to
 *      `<file>.curator-backup-<UTC stamp>` (0600, exclusive create) before the
 *      file is replaced; if the backup throws nothing is replaced.
 *   6. COMPARE-AND-SWAP: the plan records the file's sha256 (`basis`); the
 *      executor re-reads immediately before the atomic replace and refuses
 *      `config_changed` on any difference.
 *   7. IDEMPOTENT: our entry already equal to the planned one → `unchanged`:
 *      no write, no backup, no manifest row.
 *   8. MODE KEPT: a replaced file keeps its permission bits; a new one is 0600.
 *
 * WINDOWS (v3.86.0, Claude Desktop only — `resolveWinClaude` below). The
 * file is CHOSEN, never assumed: Claude Desktop on Windows has kept its config
 * in several places, so exactly one LIVE candidate is a target, none or more
 * than one is `manual` with the reason, and a candidate the adapter row marks
 * `write: false` is never written. On top of rules 1–7: the under-home check is
 * case-insensitive; a read-only file is refused (`read_only`); the replace is
 * temp-file + rename, retried for about 3 s on EPERM / EACCES / EBUSY (an
 * antivirus or indexer holding the file) with the compare-and-swap re-checked
 * before EVERY attempt, then refused `file_locked`; no POSIX mode is copied.
 * On every platform a UTF-8 BOM is stripped to parse and written back, and
 * CRLF stays CRLF.
 *
 * TEST SEAMS (never set in production): `__setHomeOverride`,
 * `CURATOR_TEST_INSTALL_HOME`, `__setPlatformOverride`,
 * `CURATOR_TEST_INSTALL_PLATFORM`, `CURATOR_TEST_INSTALL_APPS_DIR`. A process
 * that isolated its user data (`CURATOR_TEST_USER_DATA_DIR`) but named NO fake
 * home gets NO home at all, so a suite that forgets the seam fails closed
 * (`no_home`) instead of reaching the maintainer's real config files.
 *
 * Nothing here writes to stdout, and nothing under `mcp/` imports it.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MCP_SERVER_NAME, adapterFor, listHarnesses, mcpEntryFor, resolveTemplate,
} from './harness-adapters.js';
import { stripJsonComments, tildeUnder } from './setup-check.js';
import { writeFileAtomicSync } from './atomic-write.js';
import { getMcpInstallManifestPath } from './paths.js';

// ─────────────────────────────────────────────────────────────────────────
// Seams
// ─────────────────────────────────────────────────────────────────────────

let _homeOverride = null;
let _platformOverride = null;

/** TEST-ONLY: resolve every target under this folder instead of the user's home. */
export function __setHomeOverride(p) { _homeOverride = p ? pathFor(p).resolve(p) : null; }
/** TEST-ONLY: pretend to be this platform ('darwin', 'linux', 'win32'). */
export function __setPlatformOverride(p) { _platformOverride = p || null; }

/** The home every target resolves against, or null (fail closed). */
export function installHome() {
  if (_homeOverride) return _homeOverride;
  if (process.env.CURATOR_TEST_INSTALL_HOME) return pathFor(process.env.CURATOR_TEST_INSTALL_HOME).resolve(process.env.CURATOR_TEST_INSTALL_HOME);
  // An isolated process that named no fake home must not be handed the real one.
  if (process.env.CURATOR_TEST_USER_DATA_DIR) return null;
  try { const h = os.homedir(); return h && path.isAbsolute(h) ? path.resolve(h) : null; } catch { return null; }
}

export function installPlatform() {
  return _platformOverride || process.env.CURATOR_TEST_INSTALL_PLATFORM || process.platform;
}

/** The Applications folders detection looks in — overridable for tests. */
export function installAppsDirs(home) {
  if (process.env.CURATOR_TEST_INSTALL_APPS_DIR) return [path.resolve(process.env.CURATOR_TEST_INSTALL_APPS_DIR)];
  if (_homeOverride || process.env.CURATOR_TEST_INSTALL_HOME) return home ? [path.join(home, 'Applications')] : [];
  return null; // the detector's own default: /Applications and ~/Applications
}

// ─────────────────────────────────────────────────────────────────────────
// Which tools, which files
// ─────────────────────────────────────────────────────────────────────────

/** The fixed allow-list of tools this release can write (contract §0). */
export const INSTALL_IDS = Object.freeze(['claude-desktop', 'cursor', 'antigravity']);
/** …and the subset it can write on Windows (v3.86.0): Claude Desktop only. */
export const WIN32_INSTALL_IDS = Object.freeze(['claude-desktop']);

/** Can THIS platform write this tool? macOS: the three; Windows: Claude Desktop; else none. */
export function isInstallCapableOn(id, platform) {
  if (!isInstallCapable(id)) return false;
  if (platform === 'darwin') return true;
  if (platform === 'win32') return WIN32_INSTALL_IDS.includes(id) && !!adapterFor(id)?.mcpConfig?.platforms?.win32;
  return false;
}

/** Install-capable = the table says so AND the release allows it. Both must hold. */
export function isInstallCapable(id) {
  if (!INSTALL_IDS.includes(id)) return false;
  const m = adapterFor(id)?.mcpConfig;
  return !!(m && m.installer === 'file' && m.verified === true && m.format === 'json'
    && m.shape === 'mcpServers' && m.jsonc !== true && (m.user || []).length > 0);
}

export const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
export const MANIFEST_CAP = 200;
const BACKUP_INFIX = '.curator-backup-';
/** The preview's stand-in for a backup stamp that is fixed only at apply. */
export const BACKUP_AT_APPLY = '<UTC time of apply>';

/**
 * Is `p` strictly under `home`? Both absolute, compared after resolve. On
 * win32 the comparison is case-insensitive and uses Windows path semantics
 * (`C:\\Users\\Ana` and `c:\\users\\ana` are one folder). macOS: unchanged.
 */
export function isUnderHome(home, p, platform) {
  if ((platform || installPlatform()) === 'win32') {
    const P = pathFor(home);
    if (!home || typeof p !== 'string' || !P.isAbsolute(p) || !P.isAbsolute(home)) return false;
    const h = P.resolve(home).toLowerCase().replace(/[\\/]+$/, '');
    const r = P.resolve(p).toLowerCase();
    return r !== h && r.startsWith(`${h}${P.sep}`) && !r.split(P.sep).includes('..');
  }
  if (!home || typeof p !== 'string' || !path.isAbsolute(p)) return false;
  const h = path.resolve(home);
  const r = path.resolve(p);
  return r !== h && r.startsWith(`${h}${path.sep}`) && !r.split(path.sep).includes('..');
}

// ─────────────────────────────────────────────────────────────────────────
// Windows: path semantics, roots, display
// ─────────────────────────────────────────────────────────────────────────

const WIN_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * The path module for logic about Windows paths. On Windows it is Node's own
 * (= path.win32). Elsewhere it is path.win32 when the home LOOKS like a
 * Windows path (the in-memory suites: real backslash semantics on a Mac), and
 * the host's path otherwise (a simulated win32 over a real POSIX scratch home,
 * so the real server can be smoke-tested on a Mac). Never used on macOS paths.
 */
export function pathFor(home) {
  if (process.platform === 'win32') return path.win32;
  return typeof home === 'string' && WIN_PATH_RE.test(home) ? path.win32 : path;
}

/**
 * `{localAppData, appData}` for win32, or null. Production reads
 * %LOCALAPPDATA% and %APPDATA% (absolute, or null). A test home NEVER reads
 * the process's real ones — on a Windows CI runner they are the runner's real
 * folders: it takes CURATOR_TEST_INSTALL_LOCALAPPDATA / _APPDATA, or derives
 * `<home>\\AppData\\Local` and `<home>\\AppData\\Roaming`.
 */
export function winRoots(home) {
  if (!home) return null;
  const P = pathFor(home);
  const testHome = !!(_homeOverride || process.env.CURATOR_TEST_INSTALL_HOME);
  let la;
  let ad;
  if (testHome) {
    la = process.env.CURATOR_TEST_INSTALL_LOCALAPPDATA || P.join(home, 'AppData', 'Local');
    ad = process.env.CURATOR_TEST_INSTALL_APPDATA || P.join(home, 'AppData', 'Roaming');
  } else {
    la = process.env.LOCALAPPDATA;
    ad = process.env.APPDATA;
  }
  if (typeof la !== 'string' || typeof ad !== 'string' || !P.isAbsolute(la) || !P.isAbsolute(ad)) return null;
  return { localAppData: P.resolve(la), appData: P.resolve(ad) };
}

/**
 * A path for a HUMAN. macOS: `~/…` (unchanged). Windows: `%LOCALAPPDATA%\\…`,
 * `%APPDATA%\\…` or `%USERPROFILE%\\…` — the forms Windows' own Run box and
 * Explorer accept — else the path as is.
 */
export function displayFor(home, p, platform, roots) {
  if ((platform || installPlatform()) !== 'win32') return tildeUnder(home, p);
  if (typeof p !== 'string') return p;
  const P = pathFor(home);
  const pl = p.toLowerCase();
  const bases = [];
  if (roots) bases.push(['%LOCALAPPDATA%', roots.localAppData], ['%APPDATA%', roots.appData]);
  if (home) bases.push(['%USERPROFILE%', home]);
  bases.sort((x, y) => y[1].length - x[1].length);
  for (const [name, b] of bases) {
    const bl = P.resolve(b).toLowerCase();
    if (pl === bl) return name;
    if (pl.startsWith(`${bl}${P.sep}`)) return `${name}${p.slice(bl.length)}`;
  }
  return p;
}

/**
 * The user-level files this release would touch for one tool, in order:
 * `[{file, role, createAllowed}]`. `role` is 'documented' or 'observed'.
 *
 *   claude-desktop  ~/Library/Application Support/Claude/claude_desktop_config.json
 *                   (the table's Linux path is never a macOS target)
 *   cursor          ~/.cursor/mcp.json
 *   antigravity     ~/.gemini/config/mcp_config.json always; the two OBSERVED
 *                   files (~/.gemini/antigravity/, ~/.gemini/antigravity-ide/)
 *                   only when something is already at that path — never created.
 * Project files: never.
 */
export function targetsFor(id, home, io = defaultIO(), opts = {}) {
  const m = adapterFor(id)?.mcpConfig;
  if (!m || !home) return [];
  // Windows: Claude Desktop's ONE chosen file, or nothing (manual). Every other
  // tool writes nothing on Windows in this version.
  if ((opts.platform || installPlatform()) === 'win32') {
    if (id !== 'claude-desktop') return [];
    const w = opts.win || resolveWinClaude({ home, roots: opts.roots === undefined ? winRoots(home) : opts.roots, io, appx: opts.appx });
    return w.decision.ok ? [{ file: w.decision.file, role: w.decision.role, createAllowed: w.decision.createAllowed }] : [];
  }
  const resolve = (tpl) => resolveTemplate(tpl, { home });
  const out = [];
  if (id === 'claude-desktop') {
    const tpl = m.user.find((t) => t.segments[0] === 'Library');
    if (tpl) out.push({ file: resolve(tpl), role: 'documented', createAllowed: true });
  } else if (id === 'cursor') {
    out.push({ file: resolve(m.user[0]), role: 'documented', createAllowed: true });
  } else if (id === 'antigravity') {
    out.push({ file: resolve(m.user[0]), role: 'documented', createAllowed: true });
    for (const tpl of m.user.slice(1)) {
      const f = resolve(tpl);
      if (lexists(f, io)) out.push({ file: f, role: 'observed', createAllowed: false });
    }
  }
  return out.filter((t) => t.file);
}

function lexists(p, io) {
  try { io.lstat(p); return true; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────
// Windows: WHICH FILE Claude Desktop reads (v3.86.0)
// ─────────────────────────────────────────────────────────────────────────

/** Reason codes a win32 Claude Desktop row can be `manual` for. */
export const WIN_MANUAL_REASONS = Object.freeze([
  'config_not_found', 'config_ambiguous', 'config_unverified', 'config_unconfirmed',
  'config_moving', 'appdata_unknown', 'outside_home',
]);

/** The win32 candidates from the adapter row, resolved. Pure. */
export function winCandidates(home, roots) {
  const w = adapterFor('claude-desktop')?.mcpConfig?.platforms?.win32;
  if (!w || !roots) return [];
  const P = pathFor(home);
  return w.candidates.map((c) => {
    const base = c.base === 'localappdata' ? roots.localAppData : c.base === 'appdata' ? roots.appData : null;
    return { n: c.n, file: base ? P.join(base, ...c.segments) : null, source: c.source, write: c.write === true, note: c.note };
  }).filter((c) => c.file);
}

function listDir(p, io) {
  try { return { ok: true, names: io.readdir(p) }; } catch (err) {
    return { ok: !!(err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')), names: [] };
  }
}

/**
 * Decide which Claude Desktop config file on Windows is LIVE, read-only.
 *
 * A candidate is LIVE when the path exists, no folder between its root
 * (%LOCALAPPDATA% / %APPDATA%) and the file holds a `.user-data-left.*`
 * marker (Claude Desktop leaves one in a folder whose data it moved away), and
 * no `~copying.*` entry sits beside its folder (a move in progress). A folder
 * that cannot be listed makes its candidate UNCERTAIN, which counts as live:
 * an unknown never shrinks the set and so never makes a single file "the one".
 *
 *   any `~copying.*` in %LOCALAPPDATA%\Claude-Data → manual config_moving
 *   more than one live                              → manual config_ambiguous
 *   one live, row `write: false`                    → manual config_unverified
 *   one live = %APPDATA%\Claude, and an MSIX
 *     install is present or could not be ruled out  → manual config_unconfirmed
 *   one live, outside the user folder               → manual outside_home
 *   one live                                        → THAT file
 *   none, legacy .exe confirmed (Update.exe, Appx
 *     checked and absent, no MSIX folders)          → create %APPDATA%\Claude\…
 *   none                                            → manual config_not_found
 *
 * `appx` is `{checked, families}` from harness-detect's `detectWinAppx`, or
 * undefined (= not checked). Returns `{roots, candidates, live, installed,
 * msix, legacy, decision}`; decision is `{ok: true, file, n, role,
 * createAllowed}` or `{ok: false, reason, message}`. Never throws.
 */
export function resolveWinClaude({ home, roots, io = defaultIO(), appx } = {}) {
  const platform = 'win32';
  const d = (p) => displayFor(home, p, platform, roots);
  const w = adapterFor('claude-desktop')?.mcpConfig?.platforms?.win32;
  const out = { roots: roots || null, candidates: [], live: [], installed: null, msix: null, legacy: false, decision: null };
  if (!home || !roots || !w) {
    out.decision = { ok: false, reason: 'appdata_unknown', message: 'The Curator could not find your AppData folders (%LOCALAPPDATA% and %APPDATA%), so it will not write Claude Desktop\'s settings. Copy the entry in by hand.' };
    return out;
  }
  const P = pathFor(home);
  const claudeData = P.join(roots.localAppData, 'Claude-Data');
  const cdList = listDir(claudeData, io);
  const moving = cdList.names.filter((n) => typeof n === 'string' && n.startsWith('~copying.'));

  for (const c of winCandidates(home, roots)) {
    const rec = { ...c, display: d(c.file), exists: lexists(c.file, io), live: false, stale: null };
    if (rec.exists) {
      // Only the file's OWN folder and that folder's siblings are read. A
      // marker further up could belong to some other folder, and calling a
      // file stale is not the safe direction: it can turn "two live files"
      // (manual) into "one" (written).
      const own = listDir(P.dirname(c.file), io);
      if (own.names.some((n) => typeof n === 'string' && n.startsWith('.user-data-left.'))) rec.stale = 'marker';
      const sib = listDir(P.dirname(P.dirname(c.file)), io);
      if (!rec.stale && sib.names.some((n) => typeof n === 'string' && n.startsWith('~copying.'))) rec.stale = 'copying';
      rec.live = !rec.stale;
      if (!rec.stale && (!own.ok || !sib.ok)) rec.uncertain = true;
    }
    out.candidates.push(rec);
  }
  out.live = out.candidates.filter((c) => c.live);

  // Installed / MSIX / legacy signals — read-only.
  const families = appx && appx.checked ? (appx.families || []) : null;
  const msixFolder = (w.appxFamilies || []).flatMap((fam) => [P.join(roots.localAppData, 'Packages', fam), P.join(claudeData, fam.toLowerCase())])
    .find((f) => lexists(f, io)) || null;
  const msixFolders = !!msixFolder;
  out.msix = families === null ? (msixFolders ? true : null) : (families.length > 0 || msixFolders);
  const upd = w.legacyUpdater ? P.join(roots.localAppData, ...w.legacyUpdater.segments) : null;
  const updater = !!(upd && lexists(upd, io));
  out.legacy = updater && out.msix === false;
  if (families && families.length) out.installed = { by: 'app', path: families[0] };
  else if (updater) out.installed = { by: 'app', path: d(upd) };
  else if (msixFolder) out.installed = { by: 'app', path: d(msixFolder) };
  else {
    const any = out.candidates.find((c) => c.exists);
    if (any) out.installed = { by: 'config', path: any.display };
  }

  const names = (list) => list.map((c) => c.display).join(' and ');
  if (moving.length) {
    out.decision = { ok: false, reason: 'config_moving', message: 'Claude Desktop is moving its data to a new folder right now. Open Claude Desktop, wait a minute, then press Check again.' };
  } else if (out.live.length > 1) {
    out.decision = { ok: false, reason: 'config_ambiguous', message: `Claude Desktop has more than one settings file (${names(out.live)}), and The Curator cannot tell which one it reads. Add the entry by hand to the one Claude Desktop opens from Settings › Developer › Edit Config.` };
  } else if (out.live.length === 1) {
    const c = out.live[0];
    if (!c.write) {
      out.decision = { ok: false, reason: 'config_unverified', message: `Claude Desktop's settings are in ${c.display}, a location The Curator has not verified yet, so it will not write there. Copy the entry in by hand.` };
    } else if (c.n === 4 && out.msix !== false) {
      out.decision = { ok: false, reason: 'config_unconfirmed', message: `${c.display} exists, but Claude Desktop ${out.msix ? 'is installed as a Windows app package, which may keep its settings elsewhere' : 'could not be checked for a Windows app package install'}, so The Curator cannot be sure this is the file it reads. Add the entry by hand from Settings › Developer › Edit Config.` };
    } else if (!isUnderHome(home, c.file, platform)) {
      out.decision = { ok: false, reason: 'outside_home', message: `${c.display} is outside your user folder (AppData is redirected), so The Curator will not write it. Copy the entry in by hand.` };
    } else {
      out.decision = { ok: true, file: c.file, n: c.n, role: c.n === 4 ? 'documented' : 'observed', createAllowed: false };
    }
  } else {
    const legacyFile = out.candidates.find((c) => c.n === 4);
    if (out.legacy && legacyFile && legacyFile.write && !legacyFile.exists && isUnderHome(home, legacyFile.file, platform)) {
      out.decision = { ok: true, file: legacyFile.file, n: 4, role: 'documented', createAllowed: true };
    } else {
      out.decision = { ok: false, reason: 'config_not_found', message: `Claude Desktop's settings file was not found. Open Claude Desktop once, then press Check again. (Looked in ${names(out.candidates.filter((c) => c.write))}.)` };
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// IO
// ─────────────────────────────────────────────────────────────────────────

export function defaultIO() {
  return {
    lstat: (p) => lstatSync(p),
    readFile: (p) => readFileSync(p),
    exists: (p) => existsSync(p),
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    // Exclusive create: a backup never overwrites anything, including an
    // earlier backup taken in the same second.
    writeExclusive: (p, buf, mode) => {
      writeFileSync(p, buf, { flag: 'wx', mode });
      // Windows has no POSIX mode; chmod there can only toggle read-only. The
      // backup's privacy comes from the folder's inherited ACL.
      if (process.platform !== 'win32') chmodSync(p, mode);
    },
    writeAtomic: (p, text, mode) => writeFileAtomicSync(p, text, { encoding: 'utf8', mode }),
    now: () => new Date(),
    // v3.86.0, the Windows replace (see `replaceWithRetry`). Host path
    // semantics: these touch the real disk.
    readdir: (p) => readdirSync(p),
    writeTemp: (target, data) => {
      _tmpN = (_tmpN + 1) & 0xffffffff;
      const tmp = path.join(path.dirname(target), `.tmp-${path.basename(target)}-${process.pid}-${_tmpN}`);
      writeFileSync(tmp, data, { flag: 'wx' });
      return tmp;
    },
    rename: (a, b) => renameSync(a, b),
    unlink: (p) => unlinkSync(p),
    sleep: (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  };
}
let _tmpN = 0;

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ─────────────────────────────────────────────────────────────────────────
// Reading one target exactly
// ─────────────────────────────────────────────────────────────────────────

const REASON_TEXT = Object.freeze({
  symlink: 'is a symbolic link — The Curator does not write through links',
  not_regular: 'is not a regular file',
  unopenable: 'could not be opened (a macOS permission, or it is in use)',
  too_large: 'is larger than The Curator will rewrite',
  corrupt: 'is not valid JSON',
  jsonc: 'contains comments — rewriting it would delete them',
  not_object: 'does not hold a JSON object at the top level',
  servers_not_object: 'has a server list that is not a JSON object',
  duplicate_key: 'names the same key twice — rewriting it would silently drop one of them',
  lossy_number: 'holds a number that would change if the file were rewritten',
  read_only: 'is marked read-only — The Curator will not change that',
});

/** Human sentence for a per-file refusal code. */
export function reasonText(code) { return REASON_TEXT[code] || null; }

/**
 * Find the first duplicate key or lossy number in TEXT that JSON.parse already
 * accepted. Returns `null` or `{reason, at}`. A scanner, not a parser: it only
 * has to walk valid JSON.
 */
export function scanJsonHazards(text) {
  let i = 0;
  const n = text.length;
  const WS = ' \t\n\r';
  const ws = () => { while (i < n && WS.includes(text[i])) i++; };
  const str = () => {
    let j = i + 1;
    while (j < n) { const c = text[j]; if (c === '\\') { j += 2; continue; } if (c === '"') break; j++; }
    const raw = text.slice(i, j + 1);
    i = j + 1;
    return JSON.parse(raw);
  };
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const val = (at, depth) => {
    if (depth > 200) throw Object.assign(new Error('too deep'), { hazard: 'corrupt', at });
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const seen = new Set();
      ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        const k = str();
        if (seen.has(k)) throw Object.assign(new Error('dup'), { hazard: 'duplicate_key', at: `${at}/${k}` });
        seen.add(k);
        ws(); i++; // ':'
        val(`${at}/${k}`, depth + 1);
        ws();
        if (text[i] === ',') { i++; continue; }
        i++; return;
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      let k = 0;
      for (;;) {
        val(`${at}/${k++}`, depth + 1);
        ws();
        if (text[i] === ',') { i++; continue; }
        i++; return;
      }
    }
    if (c === '"') { str(); return; }
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (m && m[0].length) {
      if (!numberRoundTrips(m[0])) throw Object.assign(new Error('num'), { hazard: 'lossy_number', at });
      i += m[0].length;
      return;
    }
    for (const lit of ['true', 'false', 'null']) if (text.startsWith(lit, i)) { i += lit.length; return; }
    throw Object.assign(new Error('unexpected'), { hazard: 'corrupt', at });
  };
  try { val('', 0); return null; } catch (e) {
    return { reason: e.hazard || 'corrupt', at: e.at || '' };
  }
}

/** True when a JSON number token survives JSON.parse → JSON.stringify with its value intact. */
export function numberRoundTrips(tok) {
  const v = Number(tok);
  if (!Number.isFinite(v)) return false;
  const mant = tok.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '');
  const sig = mant.replace(/^0+/, '').replace(/0+$/, '');
  if (v === 0) return sig.length === 0;
  // Every decimal with at most 15 significant digits is exact through a double.
  return sig.length <= 15;
}

/** Indent unit, line ending and trailing-newline state of a JSON text. */
export function detectFormat(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = /\n$/.test(text) || text.trim() === '';
  let indent = 2;
  const m = /\n([ \t]+)\S/.exec(text);
  if (m) {
    if (m[1][0] === '\t') indent = '\t';
    else if (m[1].length >= 1 && m[1].length <= 8) indent = m[1].length;
  }
  return { indent, eol, trailingNewline };
}

export function serialise(doc, fmt) {
  let s = JSON.stringify(doc, null, fmt.indent);
  if (fmt.eol === '\r\n') s = s.replace(/\n/g, '\r\n');
  if (fmt.trailingNewline) s += fmt.eol;
  // A file that began with a UTF-8 byte-order mark (Notepad writes one) keeps it.
  if (fmt.bom) s = `\uFEFF${s}`;
  return s;
}

/** True when the bytes start with the UTF-8 byte-order mark EF BB BF. */
export function hasUtf8Bom(bytes) {
  return !!bytes && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/**
 * `{file, exists, sha, bytes, mode, state, reason?, doc?, fmt?}`.
 * state: 'missing' | 'ok' | 'cant-read'. `sha` is 'absent' for a missing file.
 * Never throws.
 */
export function readTarget(file, key, io = defaultIO(), adapterJsonc = false) {
  let st;
  try { st = io.lstat(file); } catch (err) {
    if (err && err.code === 'ENOENT') return { file, exists: false, sha: 'absent', bytes: null, mode: null, state: 'missing' };
    if (err && err.code === 'ENOTDIR') return { file, exists: false, sha: 'absent', bytes: null, mode: null, state: 'cant-read', reason: 'not_regular' };
    return { file, exists: true, sha: null, bytes: null, mode: null, state: 'cant-read', reason: 'unopenable' };
  }
  const base = { file, exists: true, mode: st.mode & 0o7777 };
  if (st.isSymbolicLink()) return { ...base, sha: null, bytes: null, state: 'cant-read', reason: 'symlink' };
  if (!st.isFile()) return { ...base, sha: null, bytes: null, state: 'cant-read', reason: 'not_regular' };
  if (st.size > MAX_CONFIG_BYTES) return { ...base, sha: null, bytes: null, state: 'cant-read', reason: 'too_large' };
  let bytes;
  try { bytes = io.readFile(file); } catch { return { ...base, sha: null, bytes: null, state: 'cant-read', reason: 'unopenable' }; }
  const sha = sha256(bytes);
  const r = { ...base, sha, bytes };
  // JSON.parse rejects a byte-order mark, so it is set aside here and written
  // back by `serialise` (v3.86.0; every platform).
  const bom = hasUtf8Bom(bytes);
  const text = (bom ? bytes.subarray(3) : bytes).toString('utf8');
  if (adapterJsonc) return { ...r, state: 'cant-read', reason: 'jsonc' };
  // Whitespace only: there is nothing in it to lose. It is written as a new
  // document (backup of the original bytes still taken).
  if (!text.trim()) return { ...r, state: 'ok', doc: {}, empty: true, fmt: { ...detectFormat(''), bom } };
  let doc;
  try { doc = JSON.parse(text); } catch {
    let commentsOnly = false;
    try { JSON.parse(stripJsonComments(text)); commentsOnly = true; } catch { /* corrupt */ }
    return { ...r, state: 'cant-read', reason: commentsOnly ? 'jsonc' : 'corrupt' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ...r, state: 'cant-read', reason: 'not_object' };
  const servers = Object.prototype.hasOwnProperty.call(doc, key) ? doc[key] : undefined;
  if (servers !== undefined && (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
    return { ...r, state: 'cant-read', reason: 'servers_not_object' };
  }
  const hazard = scanJsonHazards(text);
  if (hazard) return { ...r, state: 'cant-read', reason: hazard.reason };
  return { ...r, state: 'ok', doc, fmt: { ...detectFormat(text), bom } };
}

/** Windows: the file's write permission is off (the read-only attribute). */
export function isReadOnlyMode(mode) {
  return Number.isInteger(mode) && (mode & 0o222) === 0;
}

/** readTarget, plus the win32 rule that a read-only file is not ours to change. */
function readTargetOn(platform, file, key, io, jsonc) {
  const r = readTarget(file, key, io, jsonc);
  if (platform === 'win32' && r.state === 'ok' && r.exists && isReadOnlyMode(r.mode)) {
    return { ...r, state: 'cant-read', reason: 'read_only' };
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────
// Entries and the structural check
// ─────────────────────────────────────────────────────────────────────────

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** The document with our key removed (and a server map left empty by that, removed). */
export function withoutOurs(doc, key) {
  const d = clone(doc) || {};
  if (d[key] && typeof d[key] === 'object' && !Array.isArray(d[key])) {
    delete d[key][MCP_SERVER_NAME];
    if (Object.keys(d[key]).length === 0) delete d[key];
  }
  return d;
}

/** Our entry in a parsed doc, or undefined. */
export function ourEntryIn(doc, key) {
  const s = doc && typeof doc === 'object' ? doc[key] : undefined;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
  return Object.prototype.hasOwnProperty.call(s, MCP_SERVER_NAME) ? s[MCP_SERVER_NAME] : undefined;
}

/** Keys THIS release manages inside our entry. Anything else (env, …) is the user's. */
const MANAGED_KEYS = new Set(['type', 'command', 'args']);

/**
 * Is an existing entry the planned one, "after the harness shape"?
 * command equal; args deep-equal (absent ≡ []); and `type` equal when the
 * harness requires one. Other keys (an `env` the user added) do not count.
 */
export function entryMatches(existing, planned, requiresType) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return false;
  if (existing.command !== planned.command) return false;
  const ea = existing.args === undefined ? [] : existing.args;
  const pa = planned.args === undefined ? [] : planned.args;
  if (!deepEqual(ea, pa)) return false;
  if (requiresType && existing.type !== requiresType) return false;
  return true;
}

/** The entry to write: the planned one, plus keys the user added to OUR old entry. */
export function entryToWrite(existing, planned) {
  const e = { ...planned };
  const kept = [];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing)) {
      if (MANAGED_KEYS.has(k) || Object.prototype.hasOwnProperty.call(planned, k)) continue;
      e[k] = clone(v);
      kept.push(k);
    }
  }
  return { entry: e, kept };
}

/** The next document: `doc` with only our key set (entry) or deleted (entry === null). */
export function nextDocument(doc, key, entry) {
  const next = clone(doc) || {};
  if (entry === null) {
    if (next[key] && typeof next[key] === 'object') delete next[key][MCP_SERVER_NAME];
    return next;
  }
  if (!next[key] || typeof next[key] !== 'object') next[key] = {};
  next[key][MCP_SERVER_NAME] = clone(entry);
  return next;
}

/**
 * THE STRUCTURAL CHECK. Everything except our key is deep-equal, and our key
 * holds exactly what was planned (or is gone, for a remove).
 */
export function structureOk(before, next, key, entry) {
  if (!deepEqual(withoutOurs(before, key), withoutOurs(next, key))) return false;
  const ours = ourEntryIn(next, key);
  if (entry === null) return ours === undefined;
  return deepEqual(ours, entry);
}

// ─────────────────────────────────────────────────────────────────────────
// The manifest — what this app wrote, so Restore can put it back
// ─────────────────────────────────────────────────────────────────────────

export function readManifest(io = defaultIO(), file = getMcpInstallManifestPath()) {
  let buf;
  try { buf = io.readFile(file); } catch { return { rows: [], readable: true }; }
  try {
    const j = JSON.parse(buf.toString('utf8'));
    const rows = Array.isArray(j?.rows) ? j.rows.filter((r) => r && typeof r === 'object') : [];
    return { rows, readable: true };
  } catch { return { rows: [], readable: false }; }
}

export function appendManifestRow(row, io = defaultIO(), file = getMcpInstallManifestPath()) {
  const cur = readManifest(io, file);
  if (!cur.readable) {
    // Keep the unreadable bytes beside it rather than overwrite them.
    try { io.writeExclusive(`${file}.unreadable-${stamp(io.now())}`, io.readFile(file), 0o600); } catch { /* best effort */ }
  }
  const rows = [...cur.rows, row].slice(-MANIFEST_CAP);
  io.mkdirp(path.dirname(file));
  io.writeAtomic(file, `${JSON.stringify({ version: 1, rows }, null, 2)}\n`, 0o600);
}

/**
 * The newest manifest row this app wrote for (harness, file) that a Restore
 * could undo, and whether it still can: only while the file is byte-for-byte
 * what that write left (`shaAfter`).
 */
export function restoreCandidate(rows, harness, file, currentSha) {
  const row = [...rows].reverse().find((r) => r.harness === harness && r.file === file
    && ['install', 'update', 'remove'].includes(r.action));
  if (!row) return { eligible: false, reason: 'no_backup', row: null };
  if (!row.backup) return { eligible: false, reason: 'no_backup', row };
  if (row.shaAfter !== currentSha) return { eligible: false, reason: 'changed_since', row };
  return { eligible: true, reason: null, row };
}

function stamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// ─────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────

/**
 * One tool's files and their state against the planned entry.
 * Returns `{files: [{file, role, read, entryState}], planned, mcp}`.
 * entryState: 'none' | 'match' | 'differs' | null (file not readable/absent).
 */
export function inspectTool(id, { home, launch, io = defaultIO(), platform, roots, win, appx }) {
  const plat = platform || installPlatform();
  const mcp = mcpEntryFor(id, launch);
  const m = adapterFor(id).mcpConfig;
  const files = targetsFor(id, home, io, { platform: plat, roots, win, appx }).map((t) => {
    const read = readTargetOn(plat, t.file, m.key, io, m.jsonc === true);
    let entryState = null;
    if (read.state === 'ok') {
      const ours = ourEntryIn(read.doc, m.key);
      entryState = ours === undefined ? 'none' : (mcp.ok && entryMatches(ours, mcp.entry, m.requiresType) ? 'match' : 'differs');
    }
    return { ...t, read, entryState };
  });
  return { files, mcp, key: m.key, requiresType: m.requiresType };
}

/** The status word for an install-capable tool on macOS (contract §1). */
export function statusFor(files) {
  if (files.some((f) => f.read.state === 'cant-read')) return 'cant-read';
  const existing = files.filter((f) => f.read.state === 'ok');
  if (existing.length && existing.every((f) => f.entryState === 'match')) return 'connected';
  if (existing.some((f) => f.entryState === 'match' || f.entryState === 'differs')) return 'needs-update';
  return 'not-installed';
}

/** What an Install would do to one file: 'add' | 'update' | 'none'. */
export function installActionFor(f) {
  if (f.read.state === 'missing') return 'add';
  if (f.read.state !== 'ok') return 'none';
  if (f.entryState === 'match') return 'none';
  return f.entryState === 'differs' ? 'update' : 'add';
}

// ─────────────────────────────────────────────────────────────────────────
// The planner
// ─────────────────────────────────────────────────────────────────────────

export const ACTIONS = Object.freeze(['install', 'remove', 'restore']);

function refusedItem(base, reason, message) {
  return { ...base, action: 'none', refused: { reason, message } };
}

/**
 * Plan one action for one tool. Pure with respect to the filesystem except
 * for READS through `io`. Each item carries everything the executor needs:
 * `_nextText` (what would be written) or `_restoreFrom` (backup path).
 *
 * ctx: {home, launch, launcherState, detected (bool), manifestRows, io}
 */
export function planTool(id, action, ctx) {
  const { home, launch, launcherState, io = defaultIO() } = ctx;
  const platform = ctx.platform || installPlatform();
  const a = adapterFor(id);
  const label = a ? a.label : id;
  if (!isInstallCapable(id)) {
    return [{ id, label, file: null, display: null, action: 'none', refused: { reason: 'not_installable', message: `${label} cannot be installed by The Curator in this version — copy the entry in by hand.` } }];
  }
  if (platform === 'win32' && !WIN32_INSTALL_IDS.includes(id)) {
    return [{ id, label, file: null, display: null, action: 'none', refused: { reason: 'platform_unsupported', message: `One-click install for ${label} is not available on Windows in this version. Copy the entry in by hand.` } }];
  }
  if (!home) {
    return [{ id, label, file: null, display: null, action: 'none', refused: { reason: 'no_home', message: 'The Curator could not find your home folder, so it will not write any tool\'s settings.' } }];
  }
  let roots;
  let win;
  if (platform === 'win32') {
    roots = ctx.roots === undefined ? winRoots(home) : ctx.roots;
    win = ctx.win || resolveWinClaude({ home, roots, io, appx: ctx.appx });
    if (!win.decision.ok) {
      return [{ id, label, file: null, display: null, action: 'none', refused: { reason: win.decision.reason, message: win.decision.message } }];
    }
  }
  const disp = (p) => displayFor(home, p, platform, roots);
  const P = platform === 'win32' ? pathFor(home) : path;
  const insp = inspectTool(id, { home, launch, io, platform, roots, win });
  const { key } = insp;
  const items = [];
  for (const f of insp.files) {
    const display = disp(f.file);
    const base = {
      id, label, file: f.file, display, basis: f.read.sha === null ? null : f.read.sha,
      entryText: null, preserved: [], kept: [], backupWillBe: null,
    };
    if (!isUnderHome(home, f.file, platform)) { items.push(refusedItem(base, 'outside_home', `${display} is not inside your home folder.`)); continue; }
    if (f.read.state === 'cant-read') {
      items.push(refusedItem(base, f.read.reason, `${display} ${reasonText(f.read.reason) || 'could not be read'}. Nothing was changed — add the entry by hand.`));
      continue;
    }
    const doc = f.read.state === 'ok' ? f.read.doc : null;
    const servers = doc && doc[key] && typeof doc[key] === 'object' ? doc[key] : {};
    base.preserved = Object.keys(servers).filter((k) => k !== MCP_SERVER_NAME);
    const ours = doc ? ourEntryIn(doc, key) : undefined;
    const backupName = `${f.file}${BACKUP_INFIX}${stamp(io.now())}`;
    // What the preview may PROMISE about the new copy. The exact stamp is not
    // knowable here: apply re-plans from disk at a later second, and a name
    // already taken gets `-2`. So the preview names the pattern, never a stamp —
    // and in particular never an EXISTING backup (v3.85.0 screen review: a
    // restore preview showed the copy it restores FROM). `backup` on the apply
    // result is the real name.
    const newCopy = `${display}${BACKUP_INFIX}${BACKUP_AT_APPLY}`;

    if (action === 'install') {
      if (!insp.mcp.ok) { items.push(refusedItem(base, insp.mcp.reason || 'no_entry', insp.mcp.message || 'No entry could be built.')); continue; }
      if (launcherState && launcherState.required && !launcherState.present) {
        items.push(refusedItem(base, 'launcher_missing', `${launcherState.message || 'The launcher this tool would start is missing.'} Nothing was written.`));
        continue;
      }
      const planned = insp.mcp.entry;
      if (f.entryState === 'match') {
        items.push({ ...base, action: 'none', entryText: JSON.stringify(ours, null, 2) });
        continue;
      }
      // Windows: the resolver itself allows creation only on a confirmed legacy
      // install (`createAllowed`), which is detection enough.
      if (f.read.state === 'missing' && !(f.createAllowed && (ctx.detected || platform === 'win32'))) {
        items.push(refusedItem(base, 'not_detected', `${label} was not found on this ${platform === 'win32' ? 'PC' : 'Mac'}, so The Curator will not create ${display}.`));
        continue;
      }
      const { entry, kept } = entryToWrite(ours, planned);
      const before = doc || {};
      const next = nextDocument(before, key, entry);
      if (!structureOk(before, next, key, entry)) { items.push(refusedItem(base, 'structure_changed', `The change to ${display} would have touched more than the my-curator entry, so it was not made.`)); continue; }
      const fmt = f.read.fmt || detectFormat('');
      items.push({
        ...base,
        action: f.read.state === 'missing' ? 'add' : (ours === undefined ? 'add' : 'update'),
        entryText: JSON.stringify(planned, null, 2),
        kept,
        backupWillBe: f.read.exists ? newCopy : null,
        _nextText: serialise(next, fmt),
        _entry: entry,
        _create: f.read.state === 'missing',
        _backup: f.read.exists ? backupName : null,
      });
      continue;
    }

    if (action === 'remove') {
      if (f.read.state === 'missing' || ours === undefined) { items.push({ ...base, action: 'none' }); continue; }
      const before = doc;
      const next = nextDocument(before, key, null);
      if (!structureOk(before, next, key, null)) { items.push(refusedItem(base, 'structure_changed', `Removing the entry from ${display} would have touched more than the my-curator entry, so it was not done.`)); continue; }
      items.push({
        ...base,
        action: 'remove',
        entryText: JSON.stringify(ours, null, 2),
        backupWillBe: newCopy,
        _nextText: serialise(next, f.read.fmt),
        _entry: null,
        _create: false,
        _backup: backupName,
      });
      continue;
    }

    if (action === 'restore') {
      const cand = restoreCandidate(ctx.manifestRows || [], id, f.file, f.read.sha);
      if (!cand.eligible) {
        if (!cand.row) { items.push({ ...base, action: 'none' }); continue; }
        items.push(refusedItem(base, cand.reason, cand.reason === 'changed_since'
          ? `${display} has changed since The Curator wrote it, so the original was not put back. Remove the entry instead.`
          : `There is no copy of the original ${display} to put back.`));
        continue;
      }
      const backupPath = cand.row.backup;
      if (!isUnderHome(home, backupPath, platform) || P.dirname(backupPath) !== P.dirname(f.file)
        || !P.basename(backupPath).startsWith(`${P.basename(f.file)}${BACKUP_INFIX}`)) {
        items.push(refusedItem(base, 'backup_missing', `The saved copy of ${display} is not where The Curator left it.`));
        continue;
      }
      let bst;
      try { bst = io.lstat(backupPath); } catch { bst = null; }
      if (!bst || !bst.isFile() || bst.isSymbolicLink()) { items.push(refusedItem(base, 'backup_missing', `The saved copy of ${display} is no longer there.`)); continue; }
      let bbytes;
      try { bbytes = io.readFile(backupPath); } catch { bbytes = null; }
      if (!bbytes || sha256(bbytes) !== cand.row.shaBefore) { items.push(refusedItem(base, 'backup_mismatch', `The saved copy of ${display} has changed since it was taken, so it was not put back.`)); continue; }
      items.push({
        ...base,
        action: 'restore',
        restoreFrom: disp(backupPath),
        restoreFromAt: cand.row.at || null,
        backupWillBe: newCopy,
        _restoreFrom: backupPath,
        _restoreSha: cand.row.shaBefore,
        _create: false,
        _backup: backupName,
      });
      continue;
    }
    items.push(refusedItem(base, 'bad_action', 'Unknown action.'));
  }
  if (!items.length) {
    items.push({ id, label, file: null, display: null, action: 'none' });
  }
  return items;
}

/** Strip the executor-only fields for a response. */
export function publicItem(it) {
  const out = {};
  for (const [k, v] of Object.entries(it)) if (!k.startsWith('_') && k !== 'file') out[k] = v;
  out.file = it.display || null;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// The executor
// ─────────────────────────────────────────────────────────────────────────

const MANIFEST_ACTION = { add: 'install', update: 'update', remove: 'remove', restore: 'restore' };

/**
 * Carry out ONE planned item. Order, each step a precondition of the next:
 *   re-read + CAS → structural re-check → backup (exclusive, 0600) → re-read +
 *   CAS → atomic replace (mode kept / 0600) → manifest row.
 * Returns `{outcome: 'written'|'created'|'unchanged'|'refused', reason?, message, backup?}`.
 */
export function executeItem(item, ctx) {
  const io = ctx.io || defaultIO();
  const platform = ctx.platform || installPlatform();
  const win = platform === 'win32';
  const roots = win ? (ctx.roots === undefined ? winRoots(ctx.home) : ctx.roots) : undefined;
  const disp = (p) => displayFor(ctx.home, p, platform, roots);
  const P = win ? pathFor(ctx.home) : path;
  const display = item.display;
  if (item.refused) return { outcome: 'refused', reason: item.refused.reason, message: item.refused.message };
  if (item.action === 'none') return { outcome: 'unchanged', message: `${display || item.label} already as planned — nothing written.` };
  if (!isUnderHome(ctx.home, item.file, platform)) return { outcome: 'refused', reason: 'outside_home', message: `${display} is not inside your home folder.` };
  if (!isInstallCapable(item.id)) return { outcome: 'refused', reason: 'not_installable', message: `${item.label} cannot be written by The Curator.` };
  if (win && !WIN32_INSTALL_IDS.includes(item.id)) return { outcome: 'refused', reason: 'platform_unsupported', message: `${item.label} cannot be written by The Curator on Windows.` };
  const a = adapterFor(item.id);
  const key = a.mcpConfig.key;
  const jsonc = a.mcpConfig.jsonc === true;

  const cur = readTargetOn(platform, item.file, key, io, jsonc);
  if (cur.sha !== item.basis) return { outcome: 'refused', reason: 'config_changed', message: `${display} changed after the plan was made. Nothing was written — check again and re-plan.` };
  if (cur.reason === 'read_only') return { outcome: 'refused', reason: 'read_only', message: `${display} ${reasonText('read_only')}. Nothing was written.` };

  let text;
  if (item.action === 'restore') {
    let b;
    try { b = io.readFile(item._restoreFrom); } catch { b = null; }
    if (!b || sha256(b) !== item._restoreSha) return { outcome: 'refused', reason: 'backup_mismatch', message: `The saved copy of ${display} changed, so it was not put back.` };
    text = b;
  } else {
    if (cur.state !== 'ok' && cur.state !== 'missing') return { outcome: 'refused', reason: cur.reason || 'unopenable', message: `${display} ${reasonText(cur.reason) || 'could not be read'}.` };
    const before = cur.state === 'ok' ? cur.doc : {};
    let next;
    // The planned text may carry a byte-order mark (kept from the original).
    try { next = JSON.parse(String(item._nextText).replace(/^﻿/, '')); } catch { next = null; }
    if (!next || !structureOk(before, next, key, item._entry)) {
      return { outcome: 'refused', reason: 'structure_changed', message: `The change to ${display} would have touched more than the my-curator entry, so it was not made.` };
    }
    text = item._nextText;
  }

  // BACKUP FIRST.
  let backup = null;
  if (cur.exists) {
    backup = item._backup;
    if (!backup || P.dirname(backup) !== P.dirname(item.file)) return { outcome: 'refused', reason: 'backup_failed', message: `No safe place for a copy of ${display}; nothing was written.` };
    // Exclusive create; a second write in the same second gets `-2`, `-3`, …
    // An earlier backup is never overwritten.
    let lastErr = null;
    let taken = null;
    for (let n = 1; n <= 20 && !taken; n++) {
      const name = n === 1 ? backup : `${backup}-${n}`;
      try { io.writeExclusive(name, cur.bytes, 0o600); taken = name; } catch (err) {
        lastErr = err;
        if (!err || err.code !== 'EEXIST') break;
      }
    }
    if (!taken) {
      return { outcome: 'refused', reason: 'backup_failed', message: `Could not keep a copy of ${display} (${lastErr && lastErr.code ? lastErr.code : 'error'}), so nothing was written.` };
    }
    backup = taken;
  } else {
    try { io.mkdirp(P.dirname(item.file)); } catch (err) {
      return { outcome: 'refused', reason: 'write_failed', message: `Could not create the folder for ${display} (${err && err.code ? err.code : 'error'}).` };
    }
  }
  const kept = backup ? disp(backup) : undefined;

  // COMPARE-AND-SWAP, immediately before the replace.
  const again = readTargetOn(platform, item.file, key, io, jsonc);
  if (again.sha !== item.basis) {
    return { outcome: 'refused', reason: 'config_changed', message: `${display} changed while it was being updated. Nothing was written.${backup ? ` A copy was kept as ${kept}.` : ''}`, backup: kept };
  }

  if (win) {
    // Windows: temp file + rename, retried while something holds the file,
    // with the compare-and-swap re-checked before EVERY attempt.
    const r = replaceWithRetry(item, text, { io, key, jsonc, platform, display, kept });
    if (r) return r;
  } else {
    const mode = cur.exists && Number.isInteger(cur.mode) ? (cur.mode & 0o777) : 0o600;
    try {
      io.writeAtomic(item.file, text, mode);
    } catch (err) {
      return { outcome: 'refused', reason: 'write_failed', message: `Could not write ${display} (${err && err.code ? err.code : 'error'}). The original is unchanged.`, backup: kept };
    }
  }
  const shaAfter = sha256(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'));

  let manifestNote = '';
  try {
    appendManifestRow({
      at: io.now().toISOString(),
      harness: item.id,
      file: item.file,
      action: MANIFEST_ACTION[item.action],
      shaBefore: cur.exists ? cur.sha : null,
      shaAfter,
      backup,
    }, io, ctx.manifestFile);
  } catch {
    manifestNote = ' (The Curator could not record this write, so Restore will not be offered for it.)';
  }
  const verb = { add: 'added to', update: 'updated in', remove: 'removed from', restore: 'original put back in' }[item.action];
  return {
    outcome: cur.exists ? 'written' : 'created',
    message: `${item.label} — ${verb} ${display}${backup ? ' · original kept' : ''}${manifestNote}`,
    backup: kept,
  };
}

/** The rename errors an antivirus, indexer, backup tool or editor causes on Windows. */
export const LOCK_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);
/** Waits between rename attempts: 7 attempts, about 2.75 s in all (contract §3: ~3 s). */
export const WIN_RENAME_BACKOFF_MS = Object.freeze([50, 100, 200, 400, 800, 1200]);

/**
 * The Windows replace. Writes the new bytes to a temp file beside the target,
 * then, for each attempt: re-reads the target and refuses `config_changed` if
 * its sha256 is no longer the plan's basis (or `read_only` if it became
 * read-only), and renames the temp file over it. A lock error waits and tries
 * again; after the last wait it refuses `file_locked`. Any refusal removes the
 * temp file. Returns null on success, else the refusal result. Synchronous:
 * the waits block for at most WIN_RENAME_BACKOFF_MS's sum, only on this path.
 */
export function replaceWithRetry(item, text, { io, key, jsonc, platform, display, kept }) {
  let tmp;
  try { tmp = io.writeTemp(item.file, text); } catch (err) {
    return { outcome: 'refused', reason: 'write_failed', message: `Could not write ${display} (${err && err.code ? err.code : 'error'}). The original is unchanged.`, backup: kept };
  }
  const cleanup = () => { try { io.unlink(tmp); } catch { /* best effort */ } };
  for (let attempt = 0; ; attempt++) {
    const now = readTargetOn(platform, item.file, key, io, jsonc);
    if (now.sha !== item.basis) {
      cleanup();
      return { outcome: 'refused', reason: 'config_changed', message: `${display} changed while it was being updated. Nothing was written.${kept ? ` A copy was kept as ${kept}.` : ''}`, backup: kept };
    }
    if (now.reason === 'read_only') {
      cleanup();
      return { outcome: 'refused', reason: 'read_only', message: `${display} ${reasonText('read_only')}. Nothing was written.`, backup: kept };
    }
    try {
      io.rename(tmp, item.file);
      return null;
    } catch (err) {
      const code = err && err.code;
      if (!LOCK_CODES.includes(code) || attempt >= WIN_RENAME_BACKOFF_MS.length) {
        cleanup();
        return LOCK_CODES.includes(code)
          ? { outcome: 'refused', reason: 'file_locked', message: `${display} is in use by another program (${code}). Nothing was written — quit Claude Desktop and try again.`, backup: kept }
          : { outcome: 'refused', reason: 'write_failed', message: `Could not write ${display} (${code || 'error'}). The original is unchanged.`, backup: kept };
      }
      io.sleep(WIN_RENAME_BACKOFF_MS[attempt]);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Small helpers the route uses
// ─────────────────────────────────────────────────────────────────────────

export function newToken() { return randomBytes(24).toString('hex'); }
export const TOKEN_RE = /^[0-9a-f]{48}$/;
export const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Every MCP-capable harness id in table order. */
export function mcpHarnessIds() {
  return listHarnesses().filter((id) => adapterFor(id)?.mcpConfig);
}
