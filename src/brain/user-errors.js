// src/brain/user-errors.js — plain-language errors at the server's exit.
//
// The catalogue (signatures + sentences) lives in the SERVED tree,
// src/public/next/shared/user-errors.js, so the browser and the server read
// one table. This module adds what only the server can do: read an error
// OBJECT structurally, sanitise the technical text for `detail`, and the three
// Express pieces server.js installs.
//
// ── THE RULE THIS MODULE EXISTS TO KEEP ──────────────────────────────────────
// Translate ONLY at the wire. `err.message` is never changed: in-process code
// branches on the raw text (llm.js is429/is503/isModelNotFound, the batch
// queue's classifyTransientError, sync.js friendlyError, sharedbrain's
// isTransientLlmError), and the MCP calls the same brain functions and wants
// the raw text. Everything here returns a NEW value and leaves its input alone.
//
// ── PASS-THROUGH IS THE DEFAULT ──────────────────────────────────────────────
// Only text matching an anchored raw-machine signature is rewritten. A body
// whose `error` is The Curator's own sentence is returned as the SAME object,
// byte-identical; a body that already has `detail` is never re-translated; an
// existing `code` is never replaced.
//
// MCP reachability: this module never writes stdout. Its only side effect is
// logger.js (a file under the logs dir), and only from the Express middleware.

import {
  classifyErrorText,
  composeUserMessage,
  isClientKlass,
  KLASS_CODES,
  USER_MESSAGES,
  FS_ERRNO_KLASS,
  anthropicKlass,
  basenameOf,
} from '../public/next/shared/user-errors.js';
import { scrubPaths } from './scrub-paths.js';
import { scrubSecrets, logWarn, logError } from './logger.js';

export {
  classifyErrorText,
  composeUserMessage,
  isClientKlass,
  KLASS_CODES,
  USER_MESSAGES,
  CLIENT_KLASSES,
} from '../public/next/shared/user-errors.js';

/** `detail` is capped AFTER scrubbing, so a cut can never leave half a token. */
export const DETAIL_MAX_CHARS = 600;

// The two URL-credential strips sync.js `sanitize()` uses (sync.js:180), copied
// because sync.js is owned elsewhere and must not be imported into the MCP's
// reach. They are what catch a CLASSIC 40-hex token in `https://<token>@host`,
// which matches none of scrubSecrets' prefix shapes.
const URL_USER_PASS_RE = /https?:\/\/[^:@\s]+:[^@\s]*@/g;
const URL_TOKEN_RE = /https?:\/\/[^@\s]+@/g;
// A credential in a query string (`?key=…`, `&access_token=…`).
const QUERY_SECRET_RE = /([?&](?:key|api_key|apikey|access_token|token|auth)=)[^&\s'"]+/gi;

/**
 * The technical text, safe to show and to paste into a support request.
 * Chain: URL credentials → credential shapes → absolute paths → length cap.
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeDetail(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.replace(URL_USER_PASS_RE, 'https://***@').replace(URL_TOKEN_RE, 'https://***@');
  s = s.replace(QUERY_SECRET_RE, '$1[redacted]');
  s = scrubSecrets(s);
  s = scrubPaths(s);
  if (s.length > DETAIL_MAX_CHARS) s = s.slice(0, DETAIL_MAX_CHARS - 1) + '…';
  return s;
}

// ── Structural reading of an error object ────────────────────────────────────

const ANTHROPIC_NAMES = new Set([
  'APIError', 'BadRequestError', 'AuthenticationError', 'PermissionDeniedError', 'NotFoundError',
  'ConflictError', 'UnprocessableEntityError', 'RateLimitError', 'InternalServerError',
]);
const NET_CAUSE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EPIPE']);
const NET_TIMEOUT_CAUSE = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const CERT_CAUSE = /^(?:CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_SELF_SIGNED_CERT$|ERR_TLS_CERT_)/;

function ctorName(err) {
  try { return (err && err.constructor && err.constructor.name) || ''; } catch { return ''; }
}

function isAbort(err) {
  const n = ctorName(err);
  return !!err && (err.name === 'AbortError' || n === 'APIUserAbortError' || n === 'GoogleGenerativeAIAbortError');
}

/** A message The Curator composed on purpose and other code relies on. */
function isDeliberate(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.curatorModelGone || err.curatorTransient) return true;
  return typeof err.message === 'string' && err.message.trimStart().startsWith('⚠');
}

function areaService(area) {
  if (area === 'sync' || area === 'sharedbrain') return 'GitHub';
  return undefined;
}

/** → {klass, provider?, name?, service?} from the object's own fields, or null. */
function structuralHit(err, ctx) {
  const name = ctorName(err);

  // Anthropic SDK (0.39: error.js) — duck-typed on the fields APIError sets.
  if (ANTHROPIC_NAMES.has(name) && typeof err.status === 'number' && 'headers' in err) {
    const body = err.error && typeof err.error === 'object' ? err.error : {};
    const inner = body.error && typeof body.error === 'object' ? body.error : {};
    return { klass: anthropicKlass(err.status, inner.type, inner.message || err.message), provider: 'Anthropic' };
  }
  if (name === 'APIConnectionTimeoutError') return { klass: 'ai-timeout', provider: 'Anthropic' };
  if (name === 'APIConnectionError') return { klass: 'ai-unreachable', provider: 'Anthropic' };

  // Gemini SDK: GoogleGenerativeAIFetchError carries status + errorDetails.
  if (name === 'GoogleGenerativeAIFetchError' && Array.isArray(err.errorDetails)) {
    const reasons = err.errorDetails.map((d) => d && d.reason).filter(Boolean);
    if (reasons.includes('API_KEY_INVALID') || reasons.includes('API_KEY_EXPIRED')) {
      return { klass: 'ai-key-rejected', provider: 'Gemini' };
    }
  }

  // OpenRouter adapter: a STABLE code, set from the status, never from prose.
  // OPENROUTER_AUTH and _INSUFFICIENT_CREDITS are absent on purpose: the
  // adapter words both as ⚠ sentences, which isDeliberate() passes through
  // before this function runs, so a case for them could never be reached.
  if (err.name === 'OpenRouterError' && typeof err.code === 'string') {
    switch (err.code) {
      case 'OPENROUTER_RATE_LIMIT': return { klass: 'ai-rate-limited', provider: 'OpenRouter' };
      case 'OPENROUTER_TIMEOUT': return { klass: 'ai-timeout', provider: 'OpenRouter' };
      case 'OPENROUTER_UPSTREAM_DOWN':
      case 'OPENROUTER_NO_PROVIDER':
      case 'OPENROUTER_SERVER_ERROR': return { klass: 'ai-overloaded', provider: 'OpenRouter' };
      case 'OPENROUTER_NETWORK':
        return { klass: /did not (?:respond|finish)/.test(err.message || '') ? 'ai-timeout' : 'ai-unreachable', provider: 'OpenRouter' };
      default: break; // BAD_REQUEST, MODEL_NOT_FOUND, … fall to the text
    }
  }

  // Shared Brain's GitHub adapter.
  if (err.name === 'GitHubAdapterError' && typeof err.code === 'string') {
    if (err.code === 'SHARED_BRAIN_AUTH') return { klass: 'github-token-rejected' };
    if (err.code === 'SHARED_BRAIN_FORBIDDEN') {
      return { klass: /rate limit/i.test(err.message || '') ? 'github-busy' : 'github-token-rejected' };
    }
    if (err.code === 'SHARED_BRAIN_NOT_FOUND') return { klass: 'github-not-found' };
  }

  // Node fs: an errno code AND a syscall (a network error has a syscall too,
  // but its codes are not in the fs table except ETIMEDOUT, so require a path
  // or a file syscall for that one).
  if (typeof err.code === 'string' && typeof err.syscall === 'string' && FS_ERRNO_KLASS[err.code]) {
    const fileish = typeof err.path === 'string' || !/^(?:connect|getaddrinfo|read|write|queryA+|querySrv)$/.test(err.syscall);
    if (fileish) return { klass: FS_ERRNO_KLASS[err.code], name: basenameOf(err.path) || undefined };
  }

  // undici fetch: TypeError('fetch failed') with the real reason in .cause.
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : null;
  const causeCode = cause && typeof cause.code === 'string' ? cause.code : '';
  if (err.message === 'fetch failed' || (causeCode && (NET_CAUSE.has(causeCode) || NET_TIMEOUT_CAUSE.has(causeCode) || CERT_CAUSE.test(causeCode)))) {
    const service = (ctx && ctx.service) || areaService(ctx && ctx.area);
    if (CERT_CAUSE.test(causeCode)) return { klass: 'network-certificate', service };
    if (ctx && ctx.area === 'ai') {
      return { klass: NET_TIMEOUT_CAUSE.has(causeCode) ? 'ai-timeout' : 'ai-unreachable' };
    }
    if (err.message === 'fetch failed' || NET_CAUSE.has(causeCode) || NET_TIMEOUT_CAUSE.has(causeCode)) {
      return { klass: 'network-unreachable', service };
    }
  }
  if (typeof err.code === 'string' && NET_CAUSE.has(err.code) && typeof err.syscall === 'string') {
    const service = (ctx && ctx.service) || areaService(ctx && ctx.area);
    return ctx && ctx.area === 'ai' ? { klass: 'ai-unreachable' } : { klass: 'network-unreachable', service };
  }

  return null;
}

/** A programming error: a TypeError/ReferenceError/RangeError with no I/O code. */
function isBug(err) {
  if (!(err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError)) return false;
  if (err.message === 'fetch failed') return false;
  if (typeof err.code === 'string' && /^(?:E[A-Z]+|UND_ERR_|CERT_|ERR_INVALID_URL$)/.test(err.code)) return false;
  return true;
}

function detailOf(err, text) {
  let raw = text;
  const cause = err && typeof err === 'object' && err.cause && typeof err.cause === 'object' ? err.cause : null;
  if (cause && typeof cause.message === 'string' && cause.message && !raw.includes(cause.message)) {
    raw = `${raw} (${cause.message})`;
  }
  return sanitizeDetail(raw);
}

/**
 * Translate an error for a person. Returns a NEW object and never touches err.
 * @param {unknown} err  an Error, or a string
 * @param {{area?: string, service?: string, provider?: string}} [ctx]
 *   area: 'ai' | 'sync' | 'sharedbrain' | 'update' | … (names a service, picks wording)
 * @returns {{error: string, detail: string, code: string} | null}
 *   null = not recognised: the caller keeps its own message.
 */
export function toUserError(err, ctx = {}) {
  if (err == null) return null;
  const text = typeof err === 'string' ? err : (typeof err.message === 'string' ? err.message : '');
  if (typeof err === 'object') {
    if (isAbort(err) || isDeliberate(err)) return null;
  }
  let hit = typeof err === 'object' ? structuralHit(err, ctx) : null;
  if (!hit) {
    const t = classifyErrorText(text);
    if (t && !isClientKlass(t.klass)) hit = t;
  }
  if (!hit && typeof err === 'object' && isBug(err)) hit = { klass: 'internal-error' };
  if (!hit) return null;
  if (hit.klass === 'network-unreachable' && !hit.service) {
    const s = (ctx && ctx.service) || areaService(ctx && ctx.area);
    if (s) hit.service = s;
  }
  if (hit.klass === 'network-unreachable' && ctx && ctx.area === 'ai') hit = { ...hit, klass: 'ai-unreachable' };
  const error = composeUserMessage(
    hit.lead ? { ...hit, lead: scrubPaths(hit.lead) } : hit,
    { ...ctx, ...(hit.service ? { service: hit.service } : {}) },
  );
  if (!error) return null;
  return { error, detail: detailOf(err, text), code: KLASS_CODES[hit.klass] };
}

/**
 * The text for an SSE frame or a job record on the wire.
 * @param {unknown} err
 * @param {string} [fallback]  used when the error is not recognised; default
 *   is the original message with absolute paths scrubbed (as chat.js and the
 *   ingest queue already do).
 * @param {object} [ctx]  as toUserError
 * @returns {string}
 */
export function userErrorText(err, fallback, ctx = {}) {
  const u = toUserError(err, ctx);
  if (u) return u.error;
  if (typeof fallback === 'string') return fallback;
  const text = err == null ? '' : (typeof err === 'string' ? err : String(err.message ?? err));
  return scrubPaths(text);
}

/**
 * Translate a JSON body's `error`, if it is raw machine text.
 * On a miss — or when the body already has `detail`, or `error` is not a
 * string — returns the SAME object, untouched.
 * @param {unknown} body
 * @param {object} [ctx]  as toUserError
 * @returns {unknown}
 */
export function userErrorBody(body, ctx = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (typeof body.error !== 'string' || !body.error) return body;
  if (Object.prototype.hasOwnProperty.call(body, 'detail')) return body;
  const hit = classifyErrorText(body.error);
  if (!hit || isClientKlass(hit.klass)) return body;
  const u = toUserError(body.error, ctx);
  if (!u) return body;
  const out = { ...body, error: u.error, detail: u.detail };
  if (body.code == null) out.code = u.code;
  return out;
}

/** /api/<area>/… → the area word toUserError understands. */
export function areaFromPath(p) {
  const seg = String(p || '').split('?')[0].replace(/^\/api\//, '').split('/')[0];
  switch (seg) {
    case 'sync': return 'sync';
    case 'sharedbrain': return 'sharedbrain';
    case 'chat': case 'ingest': case 'ingest-queue': case 'compile': case 'query': return 'ai';
    default: return seg || undefined;
  }
}

function pathOnly(req) {
  return String((req && (req.originalUrl || req.url)) || '').split('?')[0];
}

/**
 * Express middleware: wraps res.json for THIS request only (never a prototype
 * patch) so every JSON body leaving /api passes through userErrorBody,
 * regardless of status (`200 {ok:false, error}` is common).
 */
export function userErrorBodies(req, res, next) {
  const original = res.json;
  res.json = function jsonWithPlainErrors(...args) {
    try {
      const i = args.length >= 2 && typeof args[0] === 'number' ? 1 : 0;
      const body = args[i];
      const out = userErrorBody(body, { area: areaFromPath(pathOnly(req)) });
      if (out !== body) {
        args[i] = out;
        logWarn('api-error', `${req.method} ${pathOnly(req)} → ${out.code}: ${out.detail}`);
      }
    } catch { /* a translation failure must never break a response */ }
    return original.apply(this, args);
  };
  next();
}

/** `app.all('/api/*', apiNotFound)`: an unknown API path is JSON, not the SPA's HTML. */
export function apiNotFound(req, res) {
  res.status(404).json({
    error: USER_MESSAGES['api-route-missing'](),
    // Not sanitizeDetail: an /api path is not a file path, and scrubPaths
    // would reduce it to its last segment. Credential shapes are still removed.
    detail: scrubSecrets(`${req.method} ${pathOnly(req)}`).slice(0, DETAIL_MAX_CHARS),
    code: KLASS_CODES['api-route-missing'],
  });
}

const BODY_PARSER_MALFORMED = new Set([
  'entity.parse.failed', 'encoding.unsupported', 'charset.unsupported',
  'request.size.invalid', 'stream.encoding.set', 'stream.not.readable', 'request.aborted',
]);

/**
 * The 4-argument error handler for /api: body-parser failures (malformed or
 * oversized JSON) and anything a route throws synchronously or passes to
 * next(err). Express's default answers HTML with a stack trace.
 */
// eslint-disable-next-line no-unused-vars
export function apiErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const where = `${req.method} ${pathOnly(req)}`;
  let status = 500;
  let body;
  const type = err && typeof err.type === 'string' ? err.type : '';
  if (type === 'entity.too.large') {
    status = 413;
    body = { error: USER_MESSAGES['request-too-large'](), code: KLASS_CODES['request-too-large'] };
  } else if (BODY_PARSER_MALFORMED.has(type)) {
    status = 400;
    body = { error: USER_MESSAGES['request-malformed'](), code: KLASS_CODES['request-malformed'] };
  } else {
    const declared = Number(err && (err.statusCode || err.status));
    const u = toUserError(err, { area: areaFromPath(pathOnly(req)) });
    if (u) {
      status = declared >= 400 && declared < 600 ? declared : 500;
      body = u;
    } else if (declared >= 400 && declared < 500 && typeof err.message === 'string' && err.message) {
      // A deliberate refusal thrown on purpose: its own words, unchanged.
      status = declared;
      body = { error: err.message };
    } else {
      status = 500;
      body = { error: USER_MESSAGES['internal-error'](), code: KLASS_CODES['internal-error'] };
    }
  }
  if (!body.detail && err && typeof err.message === 'string' && status >= 500) body.detail = sanitizeDetail(err.message);
  try {
    const log = status >= 500 ? logError : logWarn;
    // The stack only for a 5xx (a bug worth reporting); a refused body is just its message.
    const what = status >= 500 ? (err && (err.stack || err.message)) : (err && err.message);
    log('api-error', `${where} → ${status} ${body.code || ''}: ${sanitizeDetail(what)}`);
  } catch { /* never let logging break the response */ }
  res.status(status).json(body);
}
