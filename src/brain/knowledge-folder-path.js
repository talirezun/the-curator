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
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import { APP_ROOT } from './paths.js';

export const KNOWLEDGE_FOLDER_REFUSALS = Object.freeze([
  'empty', 'invalid', 'not-absolute', 'missing', 'not-a-folder', 'unreadable', 'inside-app',
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

  const typed = cleanTypedPath(input);
  if (!typed) return refuse('empty', 'Paste the full path of your knowledge folder.');
  if (typed.includes('\0')) return refuse('invalid', 'That is not a folder path.');
  const absolute = platform === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(typed) || /^\\\\[^\\]/.test(typed)
    : P.isAbsolute(typed);
  if (!absolute) {
    return refuse('not-absolute', 'Use the folder\u2019s FULL path' +
      (platform === 'win32' ? ', starting with a drive letter such as C:\\' : ', starting with /') +
      ' \u2014 not a relative one: ' + typed);
  }
  const resolved = P.resolve(typed);

  // The existing route's sentence, kept word for word.
  if (!existsSync(resolved)) return refuse('missing', `Folder does not exist: ${resolved}`);
  let st;
  try { st = statSync(resolved); } catch (err) {
    return refuse('unreadable', 'The Curator cannot read that folder: ' + resolved + ' (' + (err.code || err.message) + ').');
  }
  if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) {
    return refuse('not-a-folder', 'That is a file, not a folder: ' + resolved + '. Use the folder that contains your domains.');
  }
  try { readdirSync(resolved); } catch (err) {
    return refuse('unreadable', 'The Curator cannot read that folder: ' + resolved + ' (' + (err.code || err.message) + ').');
  }

  // Containment on REAL paths, case-folded where the file system usually is.
  let real = resolved;
  let rootReal = appRoot;
  try { real = realpathSync(resolved); } catch { /* keep the resolved path */ }
  try { rootReal = realpathSync(appRoot); } catch { /* keep APP_ROOT */ }
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
  return { ok: true, path: resolved };
}
