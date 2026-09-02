/**
 * What "restart" means for THIS build — the branch behind `restartStyle`.
 *
 * ── The defect this closes, and it is not hypothetical ──────────────────────
 *
 * `POST /api/restart` in `src/server.js` does, and has always done:
 *
 *     spawn(process.execPath, [path.join(PROJECT_ROOT, 'src/server.js')], …)
 *
 * That is exactly right for a repo install, where `process.execPath` is the
 * user's `node`. Under Electron it is the APP BINARY. Spawning the app binary
 * with a script path opens a SECOND CURATOR WINDOW rather than a headless
 * server, and then the original process exits — leaving a window whose backend
 * was never started the way the shell starts it.
 *
 * `desktop/main.js` currently works around this by cancelling the request at
 * the HTTP layer with `session.webRequest.onBeforeRequest`, and says so in its
 * own words: *"The durable fix is a `restartStyle` branch in the route. Report
 * it, do not let this comment become the reason nobody does it."* This is that
 * branch, and it removes all three limitations that workaround records:
 *
 *   · the renderer's fetch no longer rejects with ERR_BLOCKED_BY_CLIENT, so a
 *     relaunch that FAILS reports a restart error rather than a network one;
 *   · a restart triggered by anything other than the renderer — curl, a
 *     script, a future menu item, the updater's own restart step — takes the
 *     correct path instead of the broken one;
 *   · nothing depends on matching an exact URL on a dynamically-chosen port.
 *
 * ── Why a HOOK and not a signal the client acts on ─────────────────────────
 *
 * The obvious alternative is to answer the client with "you do it". That puts
 * the decision in the RENDERER — the one participant the relaunch is about to
 * destroy — and leaves every non-renderer caller on the broken path, which is
 * the second limitation above rather than a fix for it. Since `src/server.js`
 * runs inside the Electron MAIN process (see `src/brain/desktop-host.js`), the
 * shell can simply register the action and the route can perform it. The
 * client keeps the response shape it already handles.
 *
 * ── A 501 is right ONLY when nothing is registered ─────────────────────────
 *
 * Restart is a legitimate action in bundle mode, so the bundle arm is a
 * SUCCESS, not a refusal. It refuses only when `restartStyle` says
 * 'app-relaunch' and no shell has registered a relaunch — a state in which
 * this process genuinely cannot restart the application, which is what 501
 * means. It does NOT fall back to the spawn: that would be the second-window
 * bug, silently, under a response that said everything was fine.
 *
 * Pure. No spawn, no exit, no I/O — `perform` is handed back for the caller to
 * run after the HTTP response has flushed, so this whole decision is testable
 * without a server and without killing the test runner.
 */

import { getCapabilities, capabilityRefusal } from './install-mode.js';
import { getDesktopHook } from './desktop-host.js';

/**
 * Decide how this install restarts.
 *
 * Both parameters default to the live values and are injectable so a suite can
 * drive either arm; production passes neither.
 *
 * Returns one of:
 *   { ok:true,  style:'respawn-node', body, perform:null }  — the caller runs
 *       its existing spawn block. `body` is byte-identical to the response
 *       this route has always sent.
 *   { ok:true,  style:'app-relaunch', body, perform }       — the caller sends
 *       `body`, then calls `perform()`.
 *   { ok:false, status, body }                              — 501, named.
 */
export function planRestart(caps = getCapabilities(), relaunchHook = getDesktopHook('relaunch')) {
  if (caps.restartStyle === 'app-relaunch') {
    if (typeof relaunchHook !== 'function') {
      const { status, body } = capabilityRefusal('restartStyle', 'restart the app', {
        restartStyle: caps.restartStyle,
        hint: 'Quit The Curator completely and open it again.',
      });
      return { ok: false, status, body };
    }
    return {
      ok: true,
      style: 'app-relaunch',
      // `restartStyle` rides along so a non-browser caller can tell "the whole
      // application is going away" from "a node process is being replaced".
      // The repo arm deliberately does NOT gain a field — see below.
      body: { ok: true, restarting: true, restartStyle: 'app-relaunch' },
      perform: relaunchHook,
    };
  }
  // The repo arm's body is transcribed here EXACTLY as the route has always
  // sent it. Adding `restartStyle: 'respawn-node'` here would be harmless to
  // read and is still refused: the pre-redesign shell's updater flow used to
  // poll this endpoint's response (that shell, reachable at /old, was
  // deleted in v3.41.0 — /old now just redirects to /), and "byte-identical"
  // is a claim worth being able to make without an asterisk regardless of
  // who is polling today.
  return { ok: true, style: 'respawn-node', body: { ok: true, restarting: true }, perform: null };
}
