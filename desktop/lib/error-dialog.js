/**
 * error-dialog.js — the words of the Mac app's native error dialogs.
 *
 * A native dialog used to show `err.stack` (or a raw `err.message`): frame
 * lines, absolute home paths, whatever the failing library put in its text.
 * This module is the pure, electron-free part that turns an error into
 *
 *     <plain sentence saying what to do>
 *     Technical detail (for support): <first line of the error, scrubbed>
 *
 * so the offline suite can EXECUTE it (Electron is not installed there).
 *
 * The scrub is `sanitizeDetail` from src/brain/user-errors.js, loaded with a
 * dynamic import by main.js. That import can itself be what failed (a broken
 * install is exactly when `fatal()` runs), so every path here falls back to
 * `minimalScrub`, a small local copy of the same idea, and the result is ALWAYS
 * passed through `minimalScrub` as well. The full stack never reaches a dialog;
 * fatal() writes it, scrubbed, to curator.log first (writeFatalLog).
 */

import os from 'node:os';
import path from 'node:path';

export const DETAIL_LABEL = 'Technical detail (for support):';
const MAX_CHARS = 300;

/**
 * Local last-resort scrub: URL credentials, query secrets, well-known token
 * shapes, long hex/base64-ish runs, and absolute home paths. Never throws.
 * @param {unknown} text
 * @returns {string}
 */
export function minimalScrub(text) {
  try {
    let s = String(text == null ? '' : text);
    s = s.replace(/https?:\/\/[^@\s/]+@/g, 'https://***@');
    s = s.replace(/([?&](?:key|api_key|apikey|access_token|token|auth)=)[^&\s'"]+/gi, '$1[redacted]');
    s = s.replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[ousr]_[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,})/g, '[redacted]');
    s = s.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]');
    s = s.replace(/\/(?:Users|home)\/[^/\s'"`)]+/g, '~');
    s = s.replace(/[A-Za-z]:\\Users\\[^\\\s'"`)]+/g, '~');
    s = s.replace(/(^|[\s'"(=:])\/(?:private\/)?(?:var|tmp|opt|Volumes|Library|Applications|etc|usr)\/[^\s'"`)]*/g, '$1[path]');
    if (s.length > MAX_CHARS) s = s.slice(0, MAX_CHARS - 1) + '…';
    return s;
  } catch {
    return '';
  }
}

/**
 * The first line of an error that is not a stack frame. A string error is read
 * the same way. Never the stack.
 * @param {unknown} err
 * @returns {string}
 */
export function firstLine(err) {
  let text = '';
  try {
    if (err && typeof err === 'object') text = (typeof err.message === 'string' && err.message) ? err.message : (err.name || '');
    else text = err == null ? '' : String(err);
  } catch { text = ''; }
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^at\s/.test(line)) continue; // a stack frame
    return line;
  }
  return '';
}

/**
 * Load the shared sanitizer. `importer` is `() => import(<user-errors.js URL>)`.
 * Resolves to a function that never throws and always ends in `minimalScrub`.
 * @param {() => Promise<{sanitizeDetail?: Function}>} importer
 * @returns {Promise<(text: unknown) => string>}
 */
export async function loadSanitizer(importer) {
  let shared = null;
  try {
    const mod = await importer();
    if (mod && typeof mod.sanitizeDetail === 'function') shared = mod.sanitizeDetail;
  } catch {
    shared = null;
  }
  return composeSanitizer(shared);
}

/** @param {Function|null} shared */
export function composeSanitizer(shared) {
  return (text) => {
    let s = String(text == null ? '' : text);
    if (typeof shared === 'function') {
      try { s = String(shared(s)); } catch { /* fall through to the local scrub */ }
    }
    return minimalScrub(s);
  };
}

/**
 * The text of one dialog: a plain `main` sentence, then the error's first line
 * (scrubbed) as a labelled detail line. No detail line when there is none.
 * @param {string} main
 * @param {unknown} err
 * @param {(text: unknown) => string} [sanitize]
 * @returns {string}
 */
export function dialogText(main, err, sanitize) {
  const clean = typeof sanitize === 'function' ? composeSanitizer(sanitize) : minimalScrub;
  const detail = clean(firstLine(err)).trim();
  return detail ? `${main}\n\n${DETAIL_LABEL} ${detail}` : main;
}

// ── The fatal dialog: the app is about to exit ───────────────────────────────
// Help › Show Logs does not exist once the app has exited, and before v3.99.2
// nothing wrote the main process's failure to curator.log (its console.error
// goes to a stderr nobody sees in a packaged app). So fatal() first APPENDS
// the full, scrubbed stack to curator.log (writeFatalLog), then the dialog
// names that folder in plain words, home shortened to ~.

export const LOG_FILE_NAME = 'curator.log';

/**
 * The log folder logger.js writes to, for when main.js has not resolved it
 * through paths.js yet (or that import is what failed). Same answer as
 * src/brain/paths.js getLogsDir() for a real install.
 */
export function defaultLogsDir({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (env && env.CURATOR_TEST_LOG_DIR) return path.resolve(env.CURATOR_TEST_LOG_DIR);
  if (platform === 'win32') {
    const base = (env && env.LOCALAPPDATA) || path.win32.join(homedir, 'AppData', 'Local');
    return path.win32.join(base, 'TheCurator', 'logs');
  }
  return path.join(homedir, 'Library', 'Logs', 'The Curator');
}

/** A folder for a person to read: their home folder shortened to ~. */
export function displayFolder(dir, homedir = os.homedir()) {
  const d = String(dir || '');
  if (homedir && (d === homedir || d.startsWith(homedir + path.sep) || d.startsWith(homedir + '/'))) {
    return '~' + d.slice(homedir.length);
  }
  return d;
}

/**
 * The fatal dialog's sentence, naming where the log is. `logWritten: false`
 * (writeFatalLog returned '') names no log file: there is none to send, so
 * the dialog itself (with its technical line, when it has one) is what goes
 * to support.
 */
export function fatalMain(logsDir, homedir = os.homedir(), { logWritten = true } = {}) {
  if (!logWritten) return FATAL_NO_LOG_MAIN;
  const where = logsDir ? displayFolder(logsDir, homedir) : '';
  if (!where) return FATAL_MAIN;
  return 'The Curator could not start. Quit it and open it again. If it keeps happening, send the file ' +
    `${LOG_FILE_NAME} from the folder ${where} to support.`;
}

/**
 * The full error for the log: the stack (or the message), every line
 * scrubbed by `sanitize`, joined the way logger.js joins a multi-line record.
 */
export function fatalLogText(err, sanitize) {
  const clean = typeof sanitize === 'function' ? composeSanitizer(sanitize) : minimalScrub;
  let raw = '';
  try {
    raw = (err && typeof err === 'object' && (err.stack || err.message)) || String(err == null ? '' : err);
  } catch { raw = ''; }
  return String(raw).split(/\r?\n/).map((l) => clean(l).trimEnd()).filter(Boolean).join(' ⏎ ');
}

/**
 * Append one `[error] [desktop]` line to curator.log in `logsDir`, in
 * logger.js's format, mode 0600. Never throws; returns the file written, or ''.
 * @param {{err: unknown, logsDir: string, sanitize?: Function, fs: {appendFileSync: Function, mkdirSync: Function}, now?: () => Date}} o
 */
export function writeFatalLog({ err, logsDir, sanitize, fs, now = () => new Date() }) {
  try {
    if (!logsDir || !fs) return '';
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const file = path.join(logsDir, LOG_FILE_NAME);
    fs.appendFileSync(file, `${now().toISOString()} [error] [desktop] fatal: could not start: ${fatalLogText(err, sanitize)}\n`, { mode: 0o600 });
    return file;
  } catch {
    return '';
  }
}

export const FATAL_MAIN =
  'The Curator could not start. Quit it and open it again. If it keeps happening, ' +
  'send the file curator.log from The Curator\'s log folder to support.';
export const FATAL_NO_LOG_MAIN =
  'The Curator could not start, and it could not write what went wrong to its log file either. ' +
  'Quit it and open it again. If it keeps happening, take a screenshot of this message and send it to support.';
export const UPDATE_CHECK_MAIN =
  'The Curator could not check for updates. Try again in a moment. If it keeps happening, ' +
  'choose Help › Show Logs and send the log to support.';
export const UPDATE_INSTALL_MAIN =
  'The Curator could not finish updating. Try again in a moment. If it keeps happening, choose Help › Show Logs and send the log to support.';
export const QUIT_CHECK_MAIN =
  'The Curator did not quit, because it could not confirm that no work was in progress. ' +
  'Try quitting again. If it keeps happening, choose Help › Show Logs and send the log to support.';
export const LOG_FOLDER_MAIN =
  'The Curator could not open its log folder. The folder may not exist yet. Use The Curator for a moment, then try Help › Show Logs again.';
