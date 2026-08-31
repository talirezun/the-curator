/**
 * fetchWriteStatus() — ask `GET /api/write-status` whether it is safe to quit.
 *
 * Kept out of main.js so the guard suite can EXECUTE it against a stub fetch,
 * offline and free. It imports nothing from Electron and nothing from `src/`.
 *
 * ── Every failure resolves; nothing rejects ─────────────────────────────────
 *
 * A quit handler is a bad place for an exception. Server down, DNS nonsense,
 * a body that is not JSON, a hang — all of them mean the same thing to the
 * caller ("no answer") and all of them return `null`, which `decideQuit()`
 * turns into 'ask'. Rejecting would push a try/catch into the one code path
 * where a missed catch means the app either cannot quit or quits over a live
 * ingest.
 *
 * ── The timeout is short ON PURPOSE ─────────────────────────────────────────
 *
 * This runs inside `before-quit`, with the user's ⌘Q already pressed. The
 * route reads three in-memory counters and returns; it does no I/O. If it has
 * not answered in a couple of seconds the server is wedged, and a wedged
 * server is itself a reason to ask the human rather than to keep them waiting.
 */

/** Milliseconds before we stop waiting and treat the answer as unknown. */
export const WRITE_STATUS_TIMEOUT_MS = 2500;

/** Refuse to parse a body larger than this — the documented payload is tiny. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * @param {string} baseUrl e.g. 'http://127.0.0.1:52341'
 * @param {{ fetchImpl?: Function, timeoutMs?: number }} [deps]
 * @returns {Promise<object|null>} parsed body, or null when there is no answer
 */
export async function fetchWriteStatus(baseUrl, deps = {}) {
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : WRITE_STATUS_TIMEOUT_MS;
  if (typeof doFetch !== 'function') return null;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { try { controller && controller.abort(); } catch { /* ignore */ } }, timeoutMs);

  try {
    const res = await doFetch(`${baseUrl}/api/write-status`, {
      method: 'GET',
      signal: controller ? controller.signal : undefined,
      // No credentials, no cache. This is a same-origin loopback GET.
      headers: { accept: 'application/json' },
    });
    // NOTE: the route answers 200 even when the registry threw — it carries
    // `safeToQuit: null` in the BODY rather than in the status code, precisely
    // so a caller cannot mistake "I don't know" for "request failed". So a
    // non-2xx here really is a transport-level problem and maps to null.
    if (!res || typeof res.status !== 'number' || res.status < 200 || res.status >= 300) return null;
    const text = typeof res.text === 'function' ? await res.text() : null;
    if (typeof text !== 'string' || text.length > MAX_BODY_BYTES) return null;
    return JSON.parse(text);
  } catch {
    // Abort, network error, JSON.parse — all "no answer".
    return null;
  } finally {
    clearTimeout(timer);
  }
}
