/**
 * folder-access.js — the Windows rules for a folder a person picks, types or
 * creates (the Windows app, 2026-11-20).
 *
 * Every place The Curator takes a folder from a person — Settings › Knowledge
 * base (choose or paste), Domains › Use existing folder, and creating a new
 * domain inside the knowledge folder — runs the SAME macOS/Linux rules it has
 * always run. On Windows a few more things can go wrong, and each of them used
 * to surface as a raw errno or not at all:
 *
 *   • a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) or a name
 *     ending in a dot or space. Node's fs prefixes `\\?\`, which turns those
 *     checks OFF, so `mkdir …\con` SUCCEEDS and leaves a folder File Explorer,
 *     Obsidian and git cannot open or delete;
 *   • the device namespaces `\\?\` and `\\.\` typed as a path;
 *   • a whole drive (`D:\`) as the knowledge folder;
 *   • a path near or over MAX_PATH (260): Node copes, git and File Explorer
 *     do not;
 *   • Windows Defender's Controlled folder access, which refuses writes from
 *     apps it does not know (an unsigned app is one) under Documents, Desktop,
 *     Pictures, Music, Videos and Favorites, as EPERM/EACCES;
 *   • OneDrive's Files On-Demand: EBUSY while syncing, a cloud error when the
 *     provider is not running;
 *   • an unreachable network share (UNC or a mapped drive);
 *   • a folder that can be listed but not written (ACL read-only);
 *   • the existing folder named in another case: `c:\users\ana\wiki` for
 *     `C:\Users\Ana\Wiki` — the AgentLink W1 lesson (7a0258fc8): use the
 *     folder under its REAL name, and only when realpath differs in case alone
 *     (a mapped drive's realpath is a UNC path, which is NOT the same text).
 *
 * PURE apart from `probeWritable` (which takes its fs from `deps`). Every
 * function takes `platform` explicitly and uses `path.win32` for Windows, so
 * the offline suite drives Windows path shapes on any host (the AgentLink
 * 7c432bb60 lesson: a simulated platform uses ITS path shape, never the
 * runner's temp folder).
 *
 * Nothing here applies off Windows: every classifier answers null there, and
 * the callers keep their macOS/Linux behaviour byte-for-byte.
 *
 * The sentences are DATA (FOLDER_ACCESS_MESSAGES), keyed by a stable code, the
 * way sharedbrain-token.js keeps its own: what happened, whether anything
 * changed, the one next step. Reachable from routes only; never writes to
 * stdout.
 */
import nodePath from 'node:path';
import { isWindowsReservedName } from './reserved-names.js';

const W = nodePath.win32;

/** The longest knowledge-folder path Windows accepts here (CreateDirectory's own limit is 248). */
export const WIN_FOLDER_MAX_CHARS = 247;
/**
 * Above this a knowledge folder is accepted WITH a warning: below it come
 * `\<domain up to 32>\wiki\entities\<page>.md`, which reaches 260 quickly.
 */
export const WIN_FOLDER_WARN_CHARS = 120;

/** Folders Controlled folder access protects by default (under the profile and under OneDrive). */
const CFA_FOLDERS = Object.freeze(['documents', 'desktop', 'pictures', 'music', 'videos', 'favorites']);

/** Network-shaped errors: a share that cannot be reached. */
const NET_CODES = new Set(['ENOENT', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ECONNREFUSED', 'ECONNRESET', 'EIO', 'UNKNOWN', 'EINVAL']);

// ── Path shape ───────────────────────────────────────────────────────────────

/** `\\?\…` or `\\.\…` (either slash): the device namespaces, never a folder a person means. */
export function isWindowsDevicePath(p) {
  return typeof p === 'string' && /^[\\/]{2}[?.][\\/]/.test(p);
}

/** `\\server\share…` (and not a device path). */
export function isUncPath(p) {
  return typeof p === 'string' && /^[\\/]{2}[^\\/?.]/.test(p) && !isWindowsDevicePath(p);
}

/** `C:\`, `C:` or `c:/` — a whole drive. */
export function isDriveRoot(p) {
  return typeof p === 'string' && /^[A-Za-z]:[\\/]?$/.test(p);
}

/**
 * The first path segment Windows cannot have as a folder name, or null:
 * a reserved device name (`con`, `NUL.txt`, `com1`) or a name ending in a dot
 * or a space. `.` and `..` are navigation, not names. The drive and the UNC
 * server/share are not judged.
 */
export function windowsBadSegment(p) {
  if (typeof p !== 'string') return null;
  const parsed = W.parse(p);
  const rest = p.slice(parsed.root.length);
  for (const seg of rest.split(/[\\/]+/)) {
    if (!seg || seg === '.' || seg === '..') continue;
    if (isWindowsReservedName(seg) || /[. ]$/.test(seg)) return seg;
  }
  return null;
}

/**
 * True when `real` names the same place as `typed`, up to case (Windows file
 * names are case-insensitive): same root, same number of segments, each equal
 * ignoring case. A realpath that is a different path (a mapped drive turned
 * into its UNC share, a junction followed) is NOT the same place for this test.
 */
export function sameLocationIgnoringCase(real, typed) {
  if (typeof real !== 'string' || typeof typed !== 'string' || !real || !typed) return false;
  const a = W.parse(W.normalize(real));
  const b = W.parse(W.normalize(typed));
  if (a.root.toLowerCase() !== b.root.toLowerCase()) return false;
  const sa = W.normalize(real).slice(a.root.length).split(/[\\/]+/).filter(Boolean);
  const sb = W.normalize(typed).slice(b.root.length).split(/[\\/]+/).filter(Boolean);
  if (sa.length !== sb.length) return false;
  return sa.every((s, i) => s.toLowerCase() === sb[i].toLowerCase());
}

/**
 * The Windows app's PROGRAM folder (`…\Programs\The Curator`), which the
 * installer replaces on every update and deletes on uninstall — so nothing a
 * person keeps may live in it. `appRoot` is `<install>\resources\app` in the
 * packaged app. Null when this is not a Windows bundle.
 */
export function windowsProgramFolder({ platform, bundle, appRoot }) {
  if (platform !== 'win32' || !bundle || typeof appRoot !== 'string' || !appRoot) return null;
  return W.resolve(appRoot, '..', '..');
}

/** True when `p` is `root` or inside it, case-insensitively (Windows). */
export function isInsideWindows(p, root) {
  if (!p || !root) return false;
  const rel = W.relative(root.toLowerCase(), p.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !W.isAbsolute(rel));
}

// ── Where a path sits ────────────────────────────────────────────────────────

function oneDriveRoots(env) {
  const e = env || {};
  return ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']
    .map((k) => e[k]).filter((v) => typeof v === 'string' && W.isAbsolute(v));
}

/** True when `p` is inside a OneDrive folder (by the env OneDrive sets, or a `OneDrive…` folder in the profile). */
export function isInOneDrive(p, env) {
  if (typeof p !== 'string' || !p) return false;
  if (oneDriveRoots(env).some((r) => isInsideWindows(p, r))) return true;
  const profile = env && env.USERPROFILE;
  if (typeof profile === 'string' && isInsideWindows(p, profile)) {
    const first = W.relative(profile.toLowerCase(), p.toLowerCase()).split(/[\\/]/)[0];
    return /^onedrive\b/.test(first);
  }
  return false;
}

/**
 * True when `p` is inside a folder Controlled folder access protects by
 * default: Documents, Desktop, Pictures, Music, Videos or Favorites in the
 * profile or in a OneDrive folder (OneDrive's "back up" moves them there).
 */
export function isInControlledFolder(p, env) {
  if (typeof p !== 'string' || !p) return false;
  const roots = [];
  const profile = env && env.USERPROFILE;
  if (typeof profile === 'string' && W.isAbsolute(profile)) roots.push(profile);
  roots.push(...oneDriveRoots(env));
  for (const r of roots) {
    if (!isInsideWindows(p, r)) continue;
    const segs = W.relative(r.toLowerCase(), p.toLowerCase()).split(/[\\/]/).filter(Boolean);
    if (CFA_FOLDERS.includes(segs[0])) return true;
    // `%USERPROFILE%\OneDrive - Contoso\Documents\…` when no OneDrive env is set.
    if (r === profile && /^onedrive\b/.test(segs[0] || '') && CFA_FOLDERS.includes(segs[1])) return true;
  }
  return false;
}

// ── The sentences ────────────────────────────────────────────────────────────

const ALLOW_CFA = 'Windows Security › Virus & threat protection › Manage ransomware protection › Allow an app through Controlled folder access';

/** code → (ctx) → sentence. ctx: { name?: folder shown, segment?, length?, drive?, oneDrive? } */
export const FOLDER_ACCESS_MESSAGES = Object.freeze({
  'folder-protected-by-windows': (c) =>
    `Windows didn't let The Curator save in ${c.name || 'that folder'}, so nothing was changed. ` +
    `This usually means Controlled folder access is on: it stops apps it doesn't know from changing Documents, Desktop, ` +
    `Pictures, Music and Videos. Choose a folder outside those, or allow The Curator in ${ALLOW_CFA}.` +
    (c.oneDrive ? ' If the folder is in OneDrive, also wait until OneDrive has finished syncing it.' : ''),
  'folder-not-writable': (c) =>
    `The Curator isn't allowed to save in ${c.name || 'that folder'}, so nothing was changed. ` +
    `The folder may be read-only, belong to another user, or be on a share you can only read. ` +
    `Choose a folder you can change, or ask its owner for permission to change it.`,
  'folder-cloud-busy': (c) =>
    `OneDrive is busy with ${c.name || 'that folder'} (it may be syncing or still downloading files), so The Curator ` +
    `couldn't save and nothing was changed. Wait until OneDrive shows the folder as up to date, then try again.`,
  'folder-busy': (c) =>
    `Another program is using ${c.name || 'that folder'} or a file in it, so The Curator couldn't save and nothing was ` +
    `changed. Close programs that may have it open, or wait for a backup or virus scan to finish, then try again.`,
  'folder-cloud-unavailable': (c) =>
    `OneDrive couldn't give The Curator the files in ${c.name || 'that folder'}, so nothing was changed. ` +
    `Make sure OneDrive is running and signed in, then try again. To use the folder offline, right-click it in ` +
    `File Explorer and choose "Always keep on this device".`,
  'folder-network-unreachable': (c) =>
    `The Curator can't reach the network folder${c.name ? ` ${c.name}` : ''}, so nothing was changed. ` +
    `Check that this computer is connected to the network and the shared folder is available, then try again.`,
  'folder-path-too-long': (c) =>
    `The path${c.name ? ` ${c.name}` : ''} is too long for Windows${c.length ? ` (${c.length} characters)` : ''}, so nothing was changed. ` +
    `Choose a folder closer to the top of the drive, for example one directly in your user folder.`,
  'folder-drive-root': (c) =>
    `${c.name || 'That'} is a whole drive, not a folder, so nothing was changed. Create a folder on it ` +
    `(for example ${c.drive || 'D:\\'}Curator) and choose that, so your domains don't sit among the drive's own folders.`,
  'folder-reserved-name': (c) =>
    `Windows keeps the name "${c.segment || ''}" for itself, so it can't be used for a folder and nothing was changed. ` +
    `CON, PRN, AUX, NUL, COM1 to COM9 and LPT1 to LPT9 are reserved, and a name can't end in a dot or a space. ` +
    `Rename that folder in File Explorer, or choose another one.`,
  'folder-device-path': () =>
    `That is a Windows device path, not a folder, so nothing was changed. Use the folder's normal path, starting with ` +
    `a drive letter such as C:\\ (File Explorer's address bar shows it).`,
  'folder-inside-app': (c) =>
    `That folder is part of The Curator's own program files${c.name ? ` (${c.name})` : ''}, which an update replaces and an uninstall ` +
    `deletes, so nothing was changed. Choose a folder outside the program folder, for example one in your user folder.`,
  'folder-path-long': (c) =>
    `This folder's path is ${c.length} characters long. Windows programs such as File Explorer, Obsidian and Git can ` +
    `fail on paths over 260 characters, and page names are added below it. If a page can't be opened later, move ` +
    `the knowledge folder closer to the top of the drive.`,
});
/** Every code above, for the published catalogue. */
export const FOLDER_ACCESS_CODES = Object.freeze(Object.keys(FOLDER_ACCESS_MESSAGES));

/** The sentence for `code`, or null for an unknown code. */
export function folderAccessMessage(code, ctx = {}) {
  const fn = Object.hasOwn(FOLDER_ACCESS_MESSAGES, code) ? FOLDER_ACCESS_MESSAGES[code] : null;
  return fn ? fn(ctx || {}) : null;
}

// ── Classifying an fs error ──────────────────────────────────────────────────

/**
 * What a failed write/create/rename under `folder` means on Windows, as
 * `{code, message}`; null when `platform` is not win32 or the error is not one
 * of these (the caller then keeps its own handling, unchanged).
 *
 * The checks read the error's `code`, never its text. ctx: { platform, folder,
 * env, name } — `folder` is where the write was aimed (the knowledge folder for
 * a new domain), `name` how it is shown (default: `folder`).
 */
export function classifyFolderError(err, { platform, folder, env, name } = {}) {
  if (platform !== 'win32' || !err) return null;
  const code = typeof err.code === 'string' ? err.code : '';
  const where = typeof folder === 'string' ? folder : '';
  const ctx = { name: name || where, oneDrive: isInOneDrive(where, env), length: where.length };
  const pick = (c) => ({ code: c, message: folderAccessMessage(c, ctx) });

  if (code === 'ENAMETOOLONG') return pick('folder-path-too-long');
  const network = isUncPath(where);
  if (network && NET_CODES.has(code)) return pick('folder-network-unreachable');
  if (code === 'EPERM' || code === 'EACCES') {
    if (isInControlledFolder(where, env)) return pick('folder-protected-by-windows');
    if (ctx.oneDrive && code === 'EPERM') return pick('folder-cloud-busy');
    return pick('folder-not-writable');
  }
  if (code === 'EROFS') return pick('folder-not-writable');
  if (code === 'EBUSY' || code === 'EAGAIN' || code === 'ETXTBSY') {
    return pick(ctx.oneDrive ? 'folder-cloud-busy' : 'folder-busy');
  }
  // Files On-Demand with OneDrive not running: libuv has no name for the
  // cloud-file errors, so they arrive as UNKNOWN (or EIO).
  if (ctx.oneDrive && (code === 'UNKNOWN' || code === 'EIO')) return pick('folder-cloud-unavailable');
  return null;
}

// ── The write probe ──────────────────────────────────────────────────────────

/**
 * Can The Curator create a file in `dir`? Writes `.curator-write-check-<id>`
 * and removes it. Returns `{ok:true}` or `{ok:false, err}`. A file, not a
 * folder: Controlled folder access judges file writes. A leftover (the remove
 * failed because OneDrive or a scanner grabbed it) is a few bytes with a name
 * that says what it is. deps: { writeFileSync, unlinkSync, join, id }.
 */
export function probeWritable(dir, deps) {
  const id = deps.id || `${process.pid}-${Date.now().toString(36)}`;
  const file = (deps.join || W.join)(dir, `.curator-write-check-${id}`);
  try {
    deps.writeFileSync(file, 'The Curator checked that it can save in this folder. Safe to delete.\n', { flag: 'wx' });
  } catch (err) {
    return { ok: false, err };
  }
  try { deps.unlinkSync(file); } catch { /* best-effort, see above */ }
  return { ok: true };
}
