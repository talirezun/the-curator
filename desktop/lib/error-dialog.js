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
 * main.js writes it to the log.
 */

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

export const FATAL_MAIN =
  'The Curator could not start. Quit it and open it again. If it keeps happening, ' +
  'choose Help › Show Logs and send the log to support.';
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
