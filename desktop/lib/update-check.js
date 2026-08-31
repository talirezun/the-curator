/**
 * fetchUpdateCheck() — ask `GET /api/config/update-check` what it knows.
 *
 * Sibling of `write-status.js`, and written from it deliberately: same shape,
 * same reasons, one important difference spelled out below. It imports nothing
 * from Electron and nothing from `src/`, so the guard suite EXECUTES it rather
 * than grepping it — the same property every other module in this folder has.
 *
 * ── THE DIFFERENCE FROM fetchWriteStatus, AND IT MATTERS ────────────────────
 *
 * `GET /api/write-status` answers 200 for every outcome, carrying its "I don't
 * know" in the BODY, so its client can map any non-2xx to null and be right.
 *
 * `GET /api/config/update-check` does the opposite: `installerUpdateCheck()`
 * answers **502** for unreachable / rate-limited / HTTP-error / bad-shape, and
 * **500** for an unreadable local version — and every one of those bodies
 * carries a `reason` code AND a sentence the user can act on, written by the
 * route (`classifyReleaseFailure`). Discarding the body on a non-2xx would
 * throw away the only actionable half of the answer and replace six distinct,
 * already-authored sentences with one generic shrug.
 *
 * So: the body is parsed whatever the status, and only a genuinely absent
 * answer (network, abort, unparseable, oversized) is synthesised here.
 *
 * ── ONE synthesised sentence, and it is not a duplicate ─────────────────────
 *
 * `SHELL_UNREACHABLE` is the only user-facing sentence this file owns. It
 * cannot come from the server, because the case it names is "the server did
 * not answer". It carries `reason: 'shell-unreachable'`, a code no route
 * emits, so it is distinguishable from an upstream failure by anything reading
 * the result — a fact and its absence never share a value.
 */

/** Milliseconds before we stop waiting. The route's own upstream budget is
 *  RELEASES_TIMEOUT_MS = 8000 (src/routes/config.js) plus request overhead, so
 *  a shorter timeout here would abort a check that was about to succeed and
 *  report a failure the server never had. Deliberately LONGER than
 *  write-status's 2500: this call is not on the quit path and it really does
 *  go to the network. */
export const UPDATE_CHECK_TIMEOUT_MS = 12000;

/** Refuse to parse a body larger than this. The documented payload is ~600
 *  bytes; this is three orders of magnitude of headroom and still bounded. */
export const MAX_BODY_BYTES = 256 * 1024;

/** The one sentence this module authors. See the header. */
export const SHELL_UNREACHABLE =
  'The Curator could not reach its own update service. If the app has only just started, wait a moment and try again.';

/**
 * @param {string} baseUrl e.g. 'http://127.0.0.1:52341'
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [deps]
 * @returns {Promise<object>} ALWAYS an object — the route's body, or a
 *   locally-authored `{error, reason:'shell-unreachable'}`. Never null, never
 *   a rejection: this is called from a menu item, and an unhandled rejection
 *   in the main process is a menu item that silently does nothing.
 */
export async function fetchUpdateCheck(baseUrl, deps = {}) {
  const unreachable = () => ({ error: SHELL_UNREACHABLE, reason: 'shell-unreachable' });

  // NOTE the explicit `in` check rather than `deps.fetchImpl || globalThis.fetch`.
  // v3.30.0 recorded an OFFLINE suite in this repo that made a REAL network
  // call for exactly that reason: an assertion passing `{fetchImpl: null}` fell
  // straight through to the global. Here a caller that names the seam gets the
  // seam, even when what they named is unusable — and then this refuses rather
  // than reaching the network behind their back.
  const doFetch = ('fetchImpl' in deps) ? deps.fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return unreachable();
  if (typeof baseUrl !== 'string' || !baseUrl) return unreachable();

  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : UPDATE_CHECK_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller && controller.abort(); } catch { /* ignore */ } }, timeoutMs);

  try {
    const res = await doFetch(`${baseUrl}/api/config/update-check`, {
      method: 'GET',
      signal: controller ? controller.signal : undefined,
      headers: { accept: 'application/json' },
    });
    if (!res) return unreachable();
    const text = typeof res.text === 'function' ? await res.text() : null;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_BODY_BYTES) return unreachable();
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return unreachable();
    return body;
  } catch {
    // Abort, network error, JSON.parse — all "no answer".
    return unreachable();
  } finally {
    clearTimeout(timer);
  }
}
