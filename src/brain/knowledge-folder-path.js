/**
 * knowledge-folder-path.js — validate a knowledge folder path a person TYPED
 * (v3.87.1).
 *
 * `POST /api/config/domains-path` takes a path from the client and repoints
 * the one setting every domain, wiki and project in the app lives under. Until
 * v3.87.1 its only caller was the Domains page's "Go back to the previous
 * folder", which sends a path the server itself reported earlier, and the
 * route checked existence only. v3.87.1 makes it the typed-path fallback
 * beside the folder picker (the safety net when a native dialog cannot open),
 * so the path is now whatever a person pasted, and it is checked here first:
 *
 *   • a string, without a NUL byte, after trimming and removing ONE pair of
 *     surrounding quotes (File Explorer's "Copy as path" adds them);
 *   • ABSOLUTE — on Windows with a drive letter or a UNC prefix, since
 *     `\folder` is "absolute" to Node but means "the current drive";
 *   • normalised (`..` resolved) BEFORE every other check, so a traversal is
 *     judged by where it lands;
 *   • it exists, it is a directory, and it can be listed;
 *   • it is not the app's own checkout or anything inside it, judged on the
 *     REAL path (symlinks followed) — except the checkout's own `domains`
 *     folder, which is where a repo install keeps its knowledge by default.
 *     An update resets the checkout to `origin/main`, and the code folders are
 *     not a place a knowledge base can safely live.
 *
 * Returns `{ok:true, path}` (the normalised path, the one to apply) or
 * `{ok:false, reason, error}`, and never throws. `deps` is the test seam.
 *
 * ── ON WINDOWS ONLY (the Windows app, 2026-11-20) ──────────────────────────
 * More rules, each with a plain sentence and a `code` from
 * src/brain/folder-access.js (macOS and Linux answers are unchanged, byte for
 * byte, and never carry `code` or `warnings`):
 *   • `\\?\` and `\\.\` device paths are refused (`invalid`);
 *   • a whole drive (`D:\`) is refused (`drive-root`);
 *   • a reserved device name or a name ending in a dot/space anywhere in the
 *     path is refused (`reserved-name`);
 *   • longer than WIN_FOLDER_MAX_CHARS is refused (`too-long`); longer than
 *     WIN_FOLDER_WARN_CHARS is accepted with `warnings:[{code, message}]`;
 *   • an unreachable network share says so (`missing`, network sentence);
 *   • in the Windows APP the whole program folder (`…\Programs\The Curator`,
 *     replaced on update, deleted on uninstall) is `inside-app`, with no
 *     `domains` exception;
 *   • the folder must take a file (`not-writable`): Controlled folder access,
 *     OneDrive and read-only folders are told apart by `classifyFolderError`;
 *   • a folder named in another case is applied under its REAL on-disk name
 *     (realpath.native), but only when the two differ in case alone.
 * deps (win32): `bundle`, `realpathNative`, `writeFileSync`, `unlinkSync`, `env`.
 */
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import {
  APP_ROOT, isBundleInstall, getAppSupportDir, WINDOWS_BUNDLE_DATA_SUBDIR, APP_SUPPORT_DIR_NAME, getPlatform,
  getHostEnv, appPath,
} from './paths.js';
import {
  isWindowsDevicePath, isUncPath, isDriveRoot, windowsBadSegment, sameLocationIgnoringCase,
  windowsProgramFolder, isInsideWindows, classifyFolderError, folderAccessMessage, probeWritable,
  localAdminShareToDrive, WIN_FOLDER_MAX_CHARS, WIN_FOLDER_WARN_CHARS,
} from './folder-access.js';

const W = nodePath.win32;

/** A win32 path with a drive letter or a UNC prefix (`\folder` is the current drive, not absolute). */
function isWindowsFullPath(p) {
  return typeof p === 'string' && (/^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p));
}

/**
 * The real on-disk spelling of `p` through `native` (fs.realpathSync.native:
 * GetFinalPathNameByHandle, which expands 8.3 short names and follows
 * junctions, symlinks and subst drives), or — when `p` does not exist yet —
 * of its deepest existing ancestor with the rest re-attached. Null when
 * nothing could be resolved or there is no `native`.
 */
function realNativeOrAncestor(p, native) {
  if (typeof native !== 'function' || !isWindowsFullPath(p)) return null;
  let cur = W.resolve(p);
  const tail = [];
  for (let i = 0; i < 128; i++) {
    try {
      const r = native(cur);
      if (typeof r === 'string' && r) return tail.length ? W.join(r, ...tail.reverse()) : r;
    } catch { /* not there: try the parent */ }
    const up = W.dirname(cur);
    if (up === cur) return null;
    tail.push(W.basename(cur));
    cur = up;
  }
  return null;
}

/** Every spelling of `p` worth comparing: as written, the local admin share as its drive, the real one. */
function windowsSpellings(p, native, env) {
  const out = new Set();
  const add = (x) => { if (typeof x === 'string' && isWindowsFullPath(x)) out.add(W.resolve(x)); };
  add(p);
  add(localAdminShareToDrive(p, env));
  for (const x of [...out]) {
    const r = realNativeOrAncestor(x, native);
    add(r);
    add(localAdminShareToDrive(r, env));
  }
  return [...out];
}

/**
 * WINDOWS APP ONLY (audit M2/M3, 2026-11-20). Where a knowledge folder may
 * never be, judged on every spelling of BOTH sides (as written, a local admin
 * share `\\localhost\C$\…` as its drive, and the real on-disk path through
 * realpath.native, which expands 8.3 names and follows junctions and subst
 * drives — the program folder is derived from the REAL APP_ROOT too):
 *
 *   • the program folder (`…\Programs\The Curator`): replaced by every update,
 *     deleted by an uninstall;
 *   • the app's shared working folder %LOCALAPPDATA%\TheCurator — its
 *     updates\, logs\, instances\ and the browser install's runtime\ — EXCEPT
 *     a folder strictly inside its App\ subfolder that is not one of the app's
 *     own dot-folders. App\ is the Windows app's own user-data folder: neither
 *     an update nor an uninstall touches it, and its default knowledge folder
 *     is App\domains. App\ ITSELF is refused (it holds the API keys and the
 *     sync repository, which would then sit inside Sync's work tree), and so
 *     are App\.knowledge-git, App\.ingest-queue and the other dot-folders;
 *   • Electron's own profile %APPDATA%\The Curator (Chromium's caches).
 *
 * Returns null, or `{ code: 'folder-inside-app', ctx }` for folderAccessMessage.
 * Pure apart from `deps.realpathNative`. Never called off a Windows bundle.
 */
export function windowsAppFolderRefusal(candidate, deps = {}) {
  const env = deps.env || process.env;
  const appRoot = deps.appRoot || APP_ROOT;
  const homedir = (env && typeof env.USERPROFILE === 'string' && isWindowsFullPath(env.USERPROFILE))
    ? env.USERPROFILE : (deps.homedir || os.homedir());
  const native = deps.realpathNative;
  const forms = windowsSpellings(candidate, native, env);
  if (!forms.length) return null;
  const name = deps.name || candidate;

  const programForms = windowsSpellings(appRoot, native, env)
    .map((r) => windowsProgramFolder({ platform: 'win32', bundle: true, appRoot: r }));
  if (forms.some((f) => programForms.some((pf) => isInsideWindows(f, pf)))) {
    return { code: 'folder-inside-app', ctx: { name } };
  }

  const supportRoot = getAppSupportDir({ platform: 'win32', env, homedir });
  const supportForms = windowsSpellings(supportRoot, native, env);
  const appDataForms = windowsSpellings(W.join(supportRoot, WINDOWS_BUNDLE_DATA_SUBDIR), native, env);
  const roaming = (env && typeof env.APPDATA === 'string' && isWindowsFullPath(env.APPDATA))
    ? env.APPDATA : W.join(homedir, 'AppData', 'Roaming');
  const profileForms = windowsSpellings(W.join(roaming, APP_SUPPORT_DIR_NAME), native, env);

  const inAllowedAppData = (f) => appDataForms.some((a) => {
    if (!isInsideWindows(f, a)) return false;
    const rel = W.relative(a.toLowerCase(), f.toLowerCase());
    return rel !== '' && !rel.split(/[\\/]+/)[0].startsWith('.');
  });
  for (const f of forms) {
    if (profileForms.some((r) => isInsideWindows(f, r))) return { code: 'folder-inside-app', ctx: { name, appData: true } };
    if (supportForms.some((r) => isInsideWindows(f, r)) && !inAllowedAppData(f)) {
      return { code: 'folder-inside-app', ctx: { name, appData: true } };
    }
  }
  return null;
}

/** The sentence for a knowledge folder setting that is not a full path (Windows app, at start). */
export const WINDOWS_RELATIVE_KNOWLEDGE_FOLDER_MESSAGE = (p) =>
  `Your knowledge folder setting (${p}) is not a full path, so The Curator would look for it in whatever folder it ` +
  `happened to be started from. Nothing was read or changed. Choose your knowledge folder again on the Domains page.`;

/**
 * THE WINDOWS APP, AT START (audit M2): the knowledge folder ALREADY SET —
 * a hand-edited `.curator-config.json` domainsPath, DOMAINS_PATH, the MCP's
 * `--domains-path`, even the default — is held to the rules above before
 * anything is read from it or written to it. `raw` is the value as set (a
 * relative one is refused: it would resolve against the working folder, which
 * is the program folder on a shortcut launch), `resolved` the absolute path.
 * Throws an Error with `code` and a plain sentence; never deletes or moves
 * anything. A no-op off a Windows bundle, so macOS, Linux, the browser
 * install and every checkout are untouched. `deps` is the test seam
 * ({ platform, bundle, env, appRoot, realpathNative }).
 */
export function assertWindowsAppKnowledgeFolder(raw, resolved, deps = {}) {
  const platform = deps.platform || getPlatform();
  if (platform !== 'win32') return;
  const bundle = Object.hasOwn(deps, 'bundle') ? !!deps.bundle : isBundleInstall();
  if (!bundle) return;
  if (typeof raw === 'string' && raw && !isWindowsFullPath(raw.trim())) {
    throw Object.assign(new Error(WINDOWS_RELATIVE_KNOWLEDGE_FOLDER_MESSAGE(raw)), { code: 'knowledge-folder-not-absolute' });
  }
  const realHost = process.platform === 'win32';
  const native = Object.hasOwn(deps, 'realpathNative') ? deps.realpathNative
    : (realHost && fs.realpathSync && fs.realpathSync.native);
  // The live install's root and environment (a simulated host's in a suite;
  // APP_ROOT and process.env in production).
  const r = windowsAppFolderRefusal(resolved, {
    env: deps.env || getHostEnv(), appRoot: deps.appRoot || appPath(), realpathNative: native, name: resolved,
  });
  if (r) {
    throw Object.assign(new Error(folderAccessMessage(r.code, { ...r.ctx, configured: true })), { code: r.code });
  }
}

export const KNOWLEDGE_FOLDER_REFUSALS = Object.freeze([
  'empty', 'invalid', 'not-absolute', 'missing', 'not-a-folder', 'unreadable', 'inside-app',
  // The Windows app (2026-11-20), win32 only — see src/brain/folder-access.js.
  'drive-root', 'reserved-name', 'too-long', 'not-writable',
]);

/** PURE. Trim, and drop ONE pair of matching surrounding quotes. */
export function cleanTypedPath(input) {
  let s = typeof input === 'string' ? input.trim() : '';
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function validateKnowledgeFolderPath(input, deps = {}) {
  const platform = deps.platform || process.platform;
  const P = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const existsSync = deps.existsSync || fs.existsSync;
  const statSync = deps.statSync || fs.statSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const realpathSync = deps.realpathSync || fs.realpathSync;
  const appRoot = deps.appRoot || APP_ROOT;
  const refuse = (reason, error) => ({ ok: false, reason, error });
  const win = platform === 'win32';
  const env = deps.env || process.env;
  // Windows only: a refusal carries its catalogue code (see folder-access.js).
  const refuseCode = (reason, code, ctx) => ({ ok: false, reason, code, error: folderAccessMessage(code, ctx) });

  const typed = cleanTypedPath(input);
  if (!typed) return refuse('empty', 'Paste the full path of your knowledge folder.');
  if (typed.includes('\0')) return refuse('invalid', 'That is not a folder path.');
  if (win && isWindowsDevicePath(typed)) return refuseCode('invalid', 'folder-device-path', {});
  const absolute = platform === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(typed) || /^\\\\[^\\]/.test(typed)
    : P.isAbsolute(typed);
  if (!absolute) {
    return refuse('not-absolute', 'Use the folder\u2019s FULL path' +
      (platform === 'win32' ? ', starting with a drive letter such as C:\\' : ', starting with /') +
      ' \u2014 not a relative one: ' + typed);
  }
  const resolved = P.resolve(typed);

  if (win) {
    if (isDriveRoot(resolved)) {
      return refuseCode('drive-root', 'folder-drive-root', { name: resolved, drive: resolved.slice(0, 2).toUpperCase() + '\\' });
    }
    const bad = windowsBadSegment(resolved);
    if (bad) return refuseCode('reserved-name', 'folder-reserved-name', { segment: bad });
    if (resolved.length > WIN_FOLDER_MAX_CHARS) {
      return refuseCode('too-long', 'folder-path-too-long', { name: resolved, length: resolved.length });
    }
  }
  // Windows: an fs error with a plain Windows meaning (a share offline,
  // OneDrive not running, a protected folder) gets that sentence and its code.
  const unreadable = (err) => {
    const c = win ? classifyFolderError(err, { platform, folder: resolved, env }) : null;
    if (c) return { ok: false, reason: 'unreadable', code: c.code, error: c.message };
    return refuse('unreadable', 'The Curator cannot read that folder: ' + resolved + ' (' + (err.code || err.message) + ').');
  };

  // The existing route's sentence, kept word for word.
  if (!existsSync(resolved)) {
    if (win && isUncPath(resolved)) return refuseCode('missing', 'folder-network-unreachable', { name: resolved });
    return refuse('missing', `Folder does not exist: ${resolved}`);
  }
  let st;
  try { st = statSync(resolved); } catch (err) {
    return unreadable(err);
  }
  if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) {
    return refuse('not-a-folder', 'That is a file, not a folder: ' + resolved + '. Use the folder that contains your domains.');
  }
  try { readdirSync(resolved); } catch (err) {
    return unreadable(err);
  }

  // Containment on REAL paths, case-folded where the file system usually is.
  let real = resolved;
  let rootReal = appRoot;
  try { real = realpathSync(resolved); } catch { /* keep the resolved path */ }
  try { rootReal = realpathSync(appRoot); } catch { /* keep APP_ROOT */ }
  // The Windows APP: its whole program folder is replaced by every update and
  // deleted by an uninstall, so nothing a person keeps may live anywhere in it
  // (the repo checkout's `domains` exception below does not apply there).
  const bundle = Object.hasOwn(deps, 'bundle') ? !!deps.bundle : (win && isBundleInstall());
  const programFolder = windowsProgramFolder({ platform, bundle, appRoot });
  if (programFolder && (isInsideWindows(resolved, programFolder) || isInsideWindows(real, programFolder))) {
    return refuseCode('inside-app', 'folder-inside-app', { name: resolved });
  }
  // …and every other spelling of it, plus the app's own working folders
  // (audit M2/M3): 8.3 names, junctions and subst drives through
  // realpath.native on BOTH sides, `\\localhost\C$\…`, %LOCALAPPDATA%\TheCurator
  // outside App\, and Electron's %APPDATA%\The Curator. Windows app only.
  if (programFolder) {
    const nativeFn = deps.realpathNative
      || (process.platform === 'win32' && fs.realpathSync && fs.realpathSync.native) || null;
    const r = windowsAppFolderRefusal(resolved, { env, appRoot, realpathNative: nativeFn, homedir: deps.homedir, name: resolved });
    if (r) return refuseCode('inside-app', r.code, r.ctx);
  }
  const fold = (s) => (platform === 'win32' || platform === 'darwin') ? s.toLowerCase() : s;
  const rel = P.relative(fold(rootReal), fold(real));
  const inside = rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
  if (inside) {
    const first = rel.split(/[\\/]/)[0];
    if (first !== 'domains') {
      return refuse('inside-app', 'That folder is part of The Curator\u2019s own program files (' + resolved +
        '), which an update replaces. Choose the folder that holds your domains.');
    }
  }
  if (!win) return { ok: true, path: resolved };

  // Windows: the folder under its REAL name when the person typed it in
  // another case (AgentLink W1). realpath.native answers the on-disk case; it
  // also turns a mapped drive into its share, which is NOT taken (not the same
  // text up to case), so `Z:\wiki` stays `Z:\wiki`.
  let chosen = resolved;
  // The real fs only on a real Windows host: a simulated win32 path on macOS
  // or Linux is a relative file name there, and must never be created in the
  // cwd. A suite that simulates win32 passes its own fakes (and is refused,
  // loudly, if it forgets the writer).
  const realHost = process.platform === 'win32';
  const native = deps.realpathNative || (realHost && fs.realpathSync && fs.realpathSync.native);
  if (typeof native === 'function') {
    try {
      const onDisk = native(resolved);
      if (onDisk !== resolved && sameLocationIgnoringCase(onDisk, resolved)) chosen = onDisk;
    } catch { /* keep what was typed */ }
  }

  // Windows: it must take a file. Listing works in places a write does not
  // (Controlled folder access, a read-only share, an ACL), and finding that out
  // at the first new domain is too late.
  const probe = probeWritable(chosen, {
    writeFileSync: deps.writeFileSync || (realHost ? fs.writeFileSync : () => {
      throw Object.assign(new Error('simulated win32: no writeFileSync seam'), { code: 'ESIMULATED' });
    }),
    unlinkSync: deps.unlinkSync || (realHost ? fs.unlinkSync : () => {}),
    join: P.join,
    id: deps.probeId,
  });
  if (!probe.ok) {
    const c = classifyFolderError(probe.err, { platform, folder: chosen, env });
    const code = c ? c.code : 'folder-not-writable';
    return { ok: false, reason: 'not-writable', code, error: c ? c.message : folderAccessMessage(code, { name: chosen }) };
  }
  const out = { ok: true, path: chosen };
  if (chosen.length > WIN_FOLDER_WARN_CHARS) {
    out.warnings = [{ code: 'folder-path-long', message: folderAccessMessage('folder-path-long', { length: chosen.length }) }];
  }
  return out;
}
