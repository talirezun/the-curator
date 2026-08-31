/**
 * pickFreePort() — choose the loopback port the in-process server will bind.
 *
 * ── Why not 3333 ────────────────────────────────────────────────────────────
 *
 * `src/server.js` reads `process.env.PORT || 3333`, and BUILDS its
 * `ALLOWED_ORIGINS` / `ALLOWED_HOSTS` sets from that same value:
 *
 *     const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`,
 *                                      `http://127.0.0.1:${PORT}`, …])
 *
 * So overriding PORT moves the guards with it — there is no second place to
 * update, and a `BrowserWindow` loading `http://127.0.0.1:<that port>` sends
 * a matching `Origin` and `Host` and passes both guards unchanged.
 *
 * The maintainer runs a repo-mode checkout on 3333 permanently. Hardcoding
 * 3333 here means the desktop build and the checkout fight over one port, and
 * the loser's behaviour today is: retry every ~1 s for ~6 s, then
 * `process.exit(1)` with the reason written only to a log file. A desktop app
 * whose window never appears and which explains itself nowhere is the worst
 * available outcome, and it is the DEFAULT outcome on the one machine that
 * matters most for development.
 *
 * ── What this costs, stated rather than glossed ─────────────────────────────
 *
 * Port collision was ACCIDENTALLY doing a second job: it stopped two copies of
 * The Curator writing into one `domains/` folder. A dynamic port removes that
 * accident, so the desktop app must guard the real invariant itself — see
 * `requestSingleInstanceLock()` in main.js.
 *
 * That lock covers two copies of the DESKTOP app. It does NOT cover "desktop
 * app + `npm start` checkout": those are different executables holding
 * different locks, and with a dynamic port they will now happily coexist over
 * the same `domains/` folder. That is what the maintainer explicitly wants
 * while both installs exist, and the app already has `.write-lock` and the
 * write registry between them — but it is a REDUCTION in protection compared
 * with the accidental EADDRINUSE, not a neutral change, and it is written down
 * here so the packaging release can decide about it deliberately.
 *
 * ── The TOCTOU, and why it is acceptable ────────────────────────────────────
 *
 * Asking the OS for an ephemeral port means binding a socket, reading the
 * port, and closing it — so there is a window between our close and the
 * server's bind in which another process could take it. That window is
 * microseconds on loopback, and `src/server.js` already carries EADDRINUSE
 * retry with backoff (added in v2.7.1 for the restart race), so the failure
 * mode is "the server waits and retries", not "the app dies".
 *
 * The alternative — passing port 0 straight through and letting Express pick —
 * does NOT work here, because ALLOWED_ORIGINS is computed from `PORT` at
 * module load, BEFORE `listen()` resolves. With PORT=0 the guard sets would
 * contain `http://127.0.0.1:0`, which nothing ever sends, and every mutating
 * request would 403. Fixing that would need a change in `src/`, which this
 * change deliberately does not make.
 */

import net from 'node:net';

/** Ports below this are privileged or well-known; never hand one back. */
const MIN_ACCEPTABLE_PORT = 1024;

/**
 * Ask the OS for a free loopback TCP port.
 *
 * Binds 127.0.0.1:0, reads the assigned port, closes. Never binds 0.0.0.0 —
 * a probe that briefly listens on every interface is a (very short) exposure
 * of exactly the kind v3.0.1-beta.20 removed from the real server.
 *
 * @param {{ createServer?: Function }} [deps] Injection seam for the guard suite.
 * @returns {Promise<number>}
 */
export function pickFreePort(deps = {}) {
  const createServer = deps.createServer || net.createServer;
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = addr && typeof addr === 'object' ? addr.port : null;
      probe.close((closeErr) => {
        if (closeErr) return reject(closeErr);
        if (!Number.isInteger(port) || port < MIN_ACCEPTABLE_PORT || port > 65535) {
          return reject(new Error(`pickFreePort: OS returned an unusable port (${String(port)})`));
        }
        resolve(port);
      });
    });
  });
}

/**
 * The URL the BrowserWindow loads.
 *
 * ── DO NOT REPLACE THIS WITH A CUSTOM SCHEME OR file:// ─────────────────────
 *
 * This is the single most expensive thing to rediscover at 2am, so it is
 * written here rather than left to be re-derived:
 *
 *   A page loaded from `file://` or from a registered custom scheme
 *   (`curator://…`) sends `Origin: null` on its fetches. `src/server.js`'s
 *   cross-origin guard tests `if (origin && !ALLOWED_ORIGINS.has(origin))` —
 *   and the STRING "null" is truthy. So `Origin: null` is not "absent", it is
 *   "present and not allow-listed", and EVERY POST / PUT / DELETE / PATCH is
 *   refused with 403.
 *
 * That breaks ingest, chat, compile, sync, settings — everything the app does.
 * It would present as "the UI loads and nothing works", which reads like an
 * app bug rather than a header problem, and the fix would look like "loosen
 * the CSRF guard", which is the wrong direction.
 *
 * `http://127.0.0.1:<port>` sends a real Origin and a real Host that both
 * match the sets the server built from the same PORT value. Nothing in `src/`
 * has to change. Keep it that way.
 *
 * 127.0.0.1 rather than `localhost` because `src/server.js` binds
 * `BIND_HOST = '127.0.0.1'` and `localhost` can resolve to `::1` first on a
 * dual-stack machine, which nothing is listening on. Both spellings are in
 * ALLOWED_ORIGINS, so this is about reaching the socket, not about the guard.
 *
 * @param {number} port
 * @returns {string}
 */
export function appUrl(port) {
  if (!Number.isInteger(port) || port < MIN_ACCEPTABLE_PORT || port > 65535) {
    throw new Error(`appUrl: refusing to build a URL for an invalid port (${String(port)})`);
  }
  return `http://127.0.0.1:${port}`;
}
