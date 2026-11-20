/**
 * desktop/lib/folder-dialog.js — the desktop app's native folder chooser, as
 * the `pickFolder` hook of src/brain/desktop-host.js (the Windows app,
 * 2026-11-20).
 *
 * Every folder a person picks in the app — Settings › Knowledge base › Choose
 * folder, Domains › Use existing folder (both POST /api/config/pick-folder),
 * and a project's documents folder (POST /api/config/pick-path) — reaches
 * Electron's `dialog.showOpenDialog` through this one function. The routes own
 * every rule about the answer (src/routes/config.js, and on Windows
 * src/brain/knowledge-folder-path.js + folder-access.js); this file only shows
 * the dialog and hands back ONE path or null.
 *
 * ── macOS: exactly what main.js did inline before this file existed ─────────
 *   showOpenDialog(mainWindow, { title, properties: ['openDirectory', 'createDirectory'] })
 *   → r.canceled || !r.filePaths.length ? null : r.filePaths[0]
 * Same options, same window argument, same answer (scripts/test-win-folder-access.js
 * pins it against a recording fake).
 *
 * ── Windows: the lessons from AgentLink's Explorer picker (18b26c5d8) ────────
 *   • ONE dialog at a time: a second request while one is open answers null
 *     (a cancel) instead of stacking a second modal Explorer window;
 *   • the window is passed only when it exists and is not destroyed, else the
 *     dialog opens unparented rather than throwing;
 *   • `createDirectory` is macOS-only (Explorer's dialog always has "New
 *     folder"); `dontAddToRecent` keeps the pick out of Quick access;
 *   • no `defaultPath`: opening the dialog at a network share could reach the
 *     network before the person chose anything;
 *   • the answer must be exactly one absolute Windows path (a drive letter or
 *     `\\server\share`), never a device path (`\\?\`, `\\.\`), with no
 *     control/format characters and at most 4096 characters; anything else is
 *     null. Whether it is a GOOD folder (program folder, drive root, reserved
 *     name, writable) is the route's decision, not the dialog's.
 *   • a dialog that THROWS is let through: the route answers 500 with a
 *     typed-path hint, never a silent cancel (config.js's own rule).
 *
 * No Electron import: `dialog` is injected, so the offline suite runs this.
 */
import nodePath from 'node:path';

export const FOLDER_DIALOG_MAX_PATH = 4096;
/** Control, format (bidi, zero-width), surrogate and separator characters. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/** The options for showOpenDialog on `platform`. */
export function folderDialogOptions(prompt, platform) {
  if (platform === 'win32') {
    return { title: prompt, properties: ['openDirectory', 'dontAddToRecent'] };
  }
  return { title: prompt, properties: ['openDirectory', 'createDirectory'] };
}

/** The dialog's answer as one path, or null (see the header for each platform). */
export function pickedFolderPath(result, platform) {
  if (platform !== 'win32') {
    const r = result;
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  }
  if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length !== 1) return null;
  const p = result.filePaths[0];
  if (typeof p !== 'string' || !p || p.length > FOLDER_DIALOG_MAX_PATH || UNSHOWABLE.test(p)) return null;
  if (/^[\\/]{2}[?.][\\/]/.test(p)) return null;
  const drive = /^[A-Za-z]:[\\/]/.test(p);
  const unc = /^\\\\[^\\/?.][^\\/]*[\\/][^\\/]+/.test(p);
  if (!drive && !unc) return null;
  return nodePath.win32.normalize(p);
}

/**
 * The `pickFolder` hook. `dialog` is Electron's, `getWindow()` returns the
 * main window (or null).
 */
export function createPickFolder({ dialog, getWindow, platform = process.platform }) {
  if (!dialog || typeof dialog.showOpenDialog !== 'function') {
    throw new Error('createPickFolder: expected Electron\'s dialog');
  }
  if (typeof getWindow !== 'function') throw new Error('createPickFolder: expected getWindow()');

  if (platform !== 'win32') {
    // macOS (and any other shell): the inline code main.js has always had.
    return async ({ prompt }) => {
      const r = await dialog.showOpenDialog(getWindow(), folderDialogOptions(prompt, platform));
      return pickedFolderPath(r, platform);
    };
  }

  let open = false;
  return async ({ prompt } = {}) => {
    if (open) return null;
    open = true;
    try {
      const win = getWindow();
      const opts = folderDialogOptions(typeof prompt === 'string' ? prompt : '', platform);
      const usable = win && !(typeof win.isDestroyed === 'function' && win.isDestroyed());
      const r = usable ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return pickedFolderPath(r, platform);
    } finally {
      open = false;
    }
  };
}
