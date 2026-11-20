// shared/net.js — the frontend half of plain-language errors (v3.99.2).
//
// Three things, and nothing else:
//
//   1. installFetchTranslation() wraps window.fetch ONCE (app.js boot). When the
//      app's own server can't be reached, the browser rejects with a TypeError
//      whose text is "Failed to fetch" (Chromium, Electron), "Load failed"
//      (Safari) or "NetworkError when attempting to fetch resource." (Firefox).
//      About 140 views render `err.message`, so the wrapper replaces that one
//      rejection with an Error carrying the catalogue's `server-unreachable`
//      sentence. Everything else is untouched:
//        - an AbortError (or any rejection while the request's signal is
//          aborted) is re-thrown as the SAME object: chat's cancel
//          (views/chat.js `controller.signal.aborted || err.name === 'AbortError'`)
//          depends on it;
//        - a Response is never touched, so streaming and SSE are unaffected;
//        - a TypeError that is not one of the three network texts (a bad header
//          name, a bug) passes through unchanged;
//        - a request to another origin is not translated: "The Curator isn't
//          responding" would be the wrong sentence for it.
//
//   2. userMessageFrom(errOrBody, opts) → {error, detail, code}: one call that
//      turns whatever a view caught (a server body, an Error, a string, or
//      nothing) into the contract's shape. A server body that already has
//      `detail` is the server's own translation and is returned as it is. A
//      deliberate, already-plain message passes through UNCHANGED (the
//      catalogue's classifier recognises raw machine text only).
//
//   3. renderUserError(errOrBody, opts) → HTML: the plain sentence and, below
//      it, "Technical detail (for support): …", visible (never behind a
//      chevron), smaller, muted, selectable, escaped. Built on renderStatus.
//      renderErrorDetail(detail) is the detail line alone, for a site that
//      keeps its own error styling for the sentence.
//
// The catalogue (USER_MESSAGES, classifyErrorText) is shared/user-errors.js,
// the SAME file the server imports, so the two can never disagree.

import { USER_MESSAGES, KLASS_CODES, classifyErrorText, composeUserMessage, isCatalogueCode, scrubCredentials, scrubHomes } from './user-errors.js';
import { browserPlatform } from './platform.js';
import { renderStatus } from './text.js';

// The same five replacements as text.js / app.js escapeHtml (text.js keeps its
// copy private by design, so this file has its own; the suite checks they agree).
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const DETAIL_PREFIX = 'Technical detail (for support): ';
const DETAIL_MAX = 600;
const INSTALLED = Symbol.for('curator.fetchTranslation');

// The three browsers' network-failure texts. A prefix match, so a browser that
// appends a host ("Failed to fetch (localhost)") is still recognised.
const NETWORK_TEXT = /^(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource)/;

// Safari and Firefox word a JSON parse failure differently from V8; the shared
// classifier holds V8's and Firefox's HTML shapes. These are the parse failures
// of an HTML or empty body that only a browser produces.
const SAFARI_HTML_JSON = /^(?:SyntaxError: )?JSON Parse error: Unrecognized token '<'/;
const STREAM_DIED = /^(?:TypeError: )?(?:network error|Error in input stream)$/;
const SAFARI_EMPTY_JSON = /^(?:SyntaxError: )?(?:JSON Parse error: Unexpected EOF|The string did not match the expected pattern\.)$/;

function isAbort(err, input, init) {
  if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true;
  const sig = (init && init.signal) || (input && typeof input === 'object' && input.signal);
  return !!(sig && sig.aborted);
}

function isSameOrigin(input, target) {
  let url = '';
  try {
    url = typeof input === 'string' ? input
      : (input && typeof input.url === 'string') ? input.url
      : (input && typeof input.href === 'string') ? input.href : String(input);
  } catch { return true; }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//')) return true; // relative: our server
  try {
    const here = target && target.location && target.location.origin;
    if (!here) return false;
    return new URL(url, here).origin === here;
  } catch { return false; }
}

/**
 * The replacement for a network rejection, or the original error unchanged.
 * Exported for the suite; views never need it.
 */
export function translateFetchRejection(err, input, init, target = globalThis) {
  if (isAbort(err, input, init)) return err;
  const isTypeError = err instanceof TypeError || (err && err.name === 'TypeError');
  if (!isTypeError || !NETWORK_TEXT.test(String(err.message || ''))) return err;
  if (!isSameOrigin(input, target)) return err;
  const out = new Error(USER_MESSAGES['server-unreachable']());
  out.curatorNetwork = true;
  out.code = 'server-unreachable';
  out.cause = err;
  return out;
}

/**
 * Wrap `target.fetch` once. Returns true when it installed, false when there
 * was no fetch or it was already installed (calling twice is harmless).
 */
export function installFetchTranslation(target = globalThis) {
  const orig = target && target.fetch;
  if (typeof orig !== 'function' || orig[INSTALLED]) return false;
  const wrapped = function fetch(input, init) {
    let p;
    try {
      // Always call with the target as `this`: window.fetch throws
      // "Illegal invocation" on any other receiver.
      p = orig.call(target, input, init);
    } catch (err) {
      return Promise.reject(translateFetchRejection(err, input, init, target));
    }
    return Promise.resolve(p).then(undefined, (err) => {
      throw translateFetchRejection(err, input, init, target);
    });
  };
  Object.defineProperty(wrapped, INSTALLED, { value: true });
  Object.defineProperty(wrapped, 'original', { value: orig });
  target.fetch = wrapped;
  return true;
}

// ── Shaping ────────────────────────────────────────────────────────────────

/**
 * Credentials and home folders out of a detail line, then a length cap. The
 * shapes are the shared catalogue's (scrubCredentials, scrubHomes: the same
 * ones the server's sanitizeDetail removes), so a raw error from an older
 * server, or an Error's own text, never shows a key or a user name.
 */
export function cleanDetail(text) {
  if (typeof text !== 'string') return '';
  let t = text
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1')
    .replace(/(https?:\/\/)[^\s/@:]{16,}@/gi, '$1');
  t = scrubHomes(scrubCredentials(t)).trim();
  if (t.length > DETAIL_MAX) t = t.slice(0, DETAIL_MAX - 1) + '…';
  return t;
}

function nonEmpty(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/** A plain shape for one piece of text (an older server's raw error, an Error's message). */
function fromText(text, fallbackCode) {
  const t = nonEmpty(text);
  if (!t) return generic('', fallbackCode);
  if (SAFARI_HTML_JSON.test(t)) return { error: USER_MESSAGES['server-outdated'](), detail: '', code: 'server-outdated' };
  if (SAFARI_EMPTY_JSON.test(t)) return generic(t);
  // A stream the server stopped mid-way: reader.read() rejects with exactly
  // this text (Chromium: 'network error'; Firefox: 'Error in input stream').
  if (STREAM_DIED.test(t)) return { error: USER_MESSAGES['server-unreachable'](), detail: '', code: 'server-unreachable' };
  const hit = classifyErrorText(t);
  if (!hit) return { error: t, detail: '', code: fallbackCode || '' };
  const error = composeUserMessage(hit, { platform: browserPlatform() }) || t;
  const code = KLASS_CODES[hit.klass] || hit.klass;
  // The browser's own "Failed to fetch" and an HTML parse failure tell support
  // nothing the sentence doesn't; any other raw text is kept as the detail.
  // When the message is The Curator's own sentence kept whole (an fs error
  // inside it), the detail is the raw fragment, not the sentence again.
  const detail = (code === 'server-unreachable' || code === 'server-outdated') ? '' : cleanDetail(hit.whole && hit.raw ? hit.raw : t);
  return { error, detail, code };
}

function generic(raw, code) {
  return { error: USER_MESSAGES['request-failed'](), detail: cleanDetail(raw || ''), code: code || 'request-failed' };
}

/**
 * Whatever a view caught → the contract's {error, detail, code}. Never throws.
 *
 *   - a server body `{error, detail?, code?}`: with `detail`, returned as the
 *     server sent it (the server already translated); without, its `error` is
 *     run through the shared classifier (an older server's raw text becomes a
 *     sentence, the raw text the detail); an existing `code` is never replaced.
 *     A body with no `error` uses `message` (a few routes answer that way).
 *   - an Error: the fetch wrapper's network error, an Error a view built from a
 *     body (its `.detail`/`.code` are read), a JSON SyntaxError on an HTML page
 *     (→ server-outdated), anything else by its message.
 *   - a string: classified the same way.
 *   - null, an empty body, a body with no message: the view's own
 *     `opts.fallback` sentence when given (e.g. 'The invite token could not be
 *     re-generated.'), else the generic request-failed sentence; `HTTP <status>`
 *     is the detail when `opts.status` is given.
 *
 * @param {unknown} x
 * @param {{status?: number, fallback?: string}} [opts]
 * @returns {{error: string, detail: string, code: string}}
 */
export function userMessageFrom(x, opts = {}) {
  const status = opts && Number.isInteger(opts.status) ? opts.status : null;
  const statusDetail = status && status >= 400 ? 'HTTP ' + status : ''; // a 2xx with a bad body says nothing useful
  const fb = opts ? nonEmpty(opts.fallback) : '';
  const none = (code) => fb ? { error: fb, detail: statusDetail, code: code || '' } : generic(statusDetail, code || undefined);
  try {
    if (x == null) return none();
    if (typeof x === 'string') return withStatus(fromText(x), statusDetail);
    if (x instanceof Error || (typeof x === 'object' && typeof x.message === 'string' && typeof x.name === 'string' && !('error' in x))) {
      if (x.curatorNetwork) return { error: x.message, detail: '', code: 'server-unreachable' };
      const ownDetail = nonEmpty(x.detail);
      const ownCode = nonEmpty(x.code);
      if (ownDetail) return { error: nonEmpty(x.message) || USER_MESSAGES['request-failed'](), detail: cleanDetail(ownDetail), code: ownCode };
      if (!nonEmpty(x.message)) return none(ownCode);
      const r = fromText(x.message, ownCode);
      if (ownCode) r.code = ownCode; // never replace an existing code
      return withStatus(r, statusDetail);
    }
    if (typeof x === 'object' && !Array.isArray(x)) {
      const msg = nonEmpty(x.error) || nonEmpty(x.message);
      const code = nonEmpty(x.code);
      if (!msg) return none(code);
      const detail = nonEmpty(x.detail);
      if (detail) return { error: msg, detail: cleanDetail(detail), code };
      const r = fromText(msg, code);
      if (code) r.code = code; // never replace an existing code
      return withStatus(r, statusDetail);
    }
    return none();
  } catch {
    return none();
  }
}

function withStatus(r, statusDetail) {
  if (r.code === 'request-failed' && !r.detail && statusDetail) r.detail = statusDetail;
  return r;
}

/** Just the sentence, for a site that shows a single line of text. */
export function userErrorText(x, opts) {
  return userMessageFrom(x, opts).error;
}

/**
 * An Error to THROW from a failed response, keeping the server's detail and
 * code so the catch site can render them: `throw errorFromResponse(res, data)`.
 * `fallback` is the view's own sentence for a response with no message (the
 * status then goes in the detail, never in the sentence).
 */
export function errorFromResponse(res, data, fallback) {
  const u = userMessageFrom(data, { status: res && res.status, fallback });
  const e = new Error(u.error);
  if (u.detail) e.detail = u.detail;
  if (u.code) e.code = u.code;
  if (res && Number.isInteger(res.status)) e.status = res.status;
  return e;
}

// ── For views that keep an error as a STRING in state ──────────────────────
//
// Many views store `state.xError = err.message` and render it with
// escapeHtml(state.xError), and suites read those fields as strings. For those,
// `plainError(x)` returns the plain sentence (a string) and remembers its detail
// BESIDE it, keyed by the exact sentence; `errorDetailHtml(state.xError)` then
// renders that detail under the sentence. A detail can only ever render under
// the message it came with, and a later, different message never inherits it.
// Bounded (the oldest of 50 goes first).
// Each entry is {detail, code}; `code` is kept only when it is a catalogue code.
const ERROR_DETAILS = new Map();

/**
 * Remember `detail` (and, optionally, the catalogue `code`) as belonging to the
 * sentence `message`. A no-op when there is neither a detail nor a catalogue code.
 */
export function rememberErrorDetail(message, detail, code) {
  if (typeof message !== 'string' || !message) return;
  const d = typeof detail === 'string' ? detail : '';
  const c = isCatalogueCode(code) ? code : '';
  // A later error with the same sentence and nothing to add must not inherit
  // an earlier one's detail: forget it.
  ERROR_DETAILS.delete(message);
  if (!d && !c) return;
  ERROR_DETAILS.set(message, { detail: d, code: c });
  if (ERROR_DETAILS.size > 50) ERROR_DETAILS.delete(ERROR_DETAILS.keys().next().value);
}

/** userMessageFrom(x, opts).error, with its detail and code remembered for errorDetailHtml. */
export function plainError(x, opts) {
  const u = userMessageFrom(x, opts);
  rememberErrorDetail(u.error, u.detail, u.code);
  return u.error;
}

/** The remembered detail for exactly this sentence, or ''. */
export function errorDetailOf(message) {
  const e = typeof message === 'string' ? ERROR_DETAILS.get(message) : null;
  return (e && e.detail) || '';
}

/** The remembered catalogue code for exactly this sentence, or ''. */
export function errorCodeOf(message) {
  const e = typeof message === 'string' ? ERROR_DETAILS.get(message) : null;
  return (e && e.code) || '';
}

/** renderErrorDetail(errorDetailOf(message), errorCodeOf(message)): the line, or ''. */
export function errorDetailHtml(message) {
  return renderErrorDetail(errorDetailOf(message), errorCodeOf(message));
}

/**
 * For a monitor (shared/monitor.js renders its `loud` text itself): the entry,
 * then, when its text has a remembered detail or code, a quiet entry right
 * below it carrying the support line. `loud.push(...loudWithDetail(e))`.
 */
export function loudWithDetail(entry) {
  const line = entry ? supportLineText(errorDetailOf(entry.text), errorCodeOf(entry.text)) : '';
  return line ? [entry, { tone: 'quiet', text: line }] : [entry];
}

// ── Rendering ──────────────────────────────────────────────────────────────

/**
 * The support line's TEXT, or '' when there is nothing to show:
 *
 *   detail + code  →  "Technical detail (for support): <detail> (code: ai-key-rejected)"
 *   code only      →  "Technical detail (for support): code: ai-key-rejected"
 *   detail only    →  "Technical detail (for support): <detail>"
 *
 * The code is the one a person can look up in the published error catalogue,
 * so ONLY a catalogue code is shown (isCatalogueCode). A raw errno a route
 * passes as `code` ('EACCES'), an adapter's internal code
 * ('SHARED_BRAIN_AUTH') or a view-branching code ('manifest-newer') is not
 * one, and showing it as "code: EACCES" would send a person looking for an
 * entry that does not exist; that text already reaches support in the detail.
 * Not escaped: for a DOM site that sets textContent.
 */
export function supportLineText(detail, code) {
  const d = typeof detail === 'string' ? cleanDetail(detail) : '';
  const c = isCatalogueCode(code) ? code : '';
  if (!d && !c) return '';
  if (!c) return DETAIL_PREFIX + d;
  return DETAIL_PREFIX + (d ? d + ' (code: ' + c + ')' : 'code: ' + c);
}

/**
 * The detail line alone (escaped HTML), or '' when there is none. For a site
 * that keeps its own styling for the sentence and puts this right below it.
 * `code` is optional: a catalogue code is shown at the end of the line.
 */
export function renderErrorDetail(detail, code) {
  const line = supportLineText(detail, code);
  if (!line) return '';
  return '<div class="tx-error-detail">' + escapeHtml(line) + '</div>';
}

/**
 * The whole error as a danger status box, in one call:
 *
 *   renderUserError(err)                                  // title = the plain sentence
 *   renderUserError(data, { status: res.status })         // a failed response's body
 *   renderUserError(err, { title: 'Could not save the key' })
 *       // title = the view's own heading; the sentence becomes the second line
 *
 * The detail line is always visible, below, prefixed "Technical detail (for
 * support):", smaller and muted. Everything is escaped.
 *
 * @param {unknown} x  anything userMessageFrom accepts, or an {error, detail} it returned
 * @param {{title?: string, state?: string, status?: number}} [opts]
 */
export function renderUserError(x, opts = {}) {
  const u = userMessageFrom(x, opts);
  const title = nonEmpty(opts.title);
  // A site that rebuilt the body from a remembered sentence
  // ({error, detail: errorDetailOf(msg)}) has dropped the code; the sentence
  // still finds it.
  const code = u.code || errorCodeOf(u.error);
  return renderStatus({
    state: opts.state || 'danger',
    title: title || u.error,
    detail: title ? u.error : '',
    support: supportLineText(u.detail, code),
  });
}
