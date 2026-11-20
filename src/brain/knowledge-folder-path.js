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
import nodePath from 'node:path';
import { APP_ROOT, isBundleInstall } from './paths.js';
import {
  isWindowsDevicePath, isUncPath, isDriveRoot, windowsBadSegment, sameLocationIgnoringCase,
  windowsProgramFolder, isInsideWindows, classifyFolderError, folderAccessMessage, probeWritable,
  WIN_FOLDER_MAX_CHARS, WIN_FOLDER_WARN_CHARS,
} from './folder-access.js';

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
