/**
 * The hooks a DESKTOP SHELL may install into this process.
 *
 * ── Why this module can exist at all, which is the whole argument ───────────
 *
 * Two capabilities in `src/brain/install-mode.js` name an action the Express
 * routes cannot perform on their own:
 *
 *     folderPickerStyle: 'native-dialog'   → Electron's dialog.showOpenDialog
 *     restartStyle:      'app-relaunch'    → Electron's app.relaunch()
 *
 * Both live in Electron's MAIN process. The obvious reading is therefore that
 * a route can never reach them, and that the only options are a refusal the
 * shell interprets, an HTTP interception, or an unwired field. That reading is
 * WRONG, and `desktop/main.js` is where it is refuted — in its own words:
 *
 *     "`src/server.js` runs UNMODIFIED, in this process, as an ordinary ESM
 *      import. It is a script with side effects … importing it IS starting it."
 *     "Start the app. This is the whole backend: one import, no child process,
 *      no second Node runtime."
 *
 * The server and the shell are the SAME Node realm. Node's ESM loader keys
 * modules by resolved URL, so a shell that imports this file gets the very
 * object a route imports. A plain module-level registry is therefore a real
 * channel, not a metaphor — no IPC, no port, no second serialisation of a
 * decision that has already been made.
 *
 * That is why this is a registry and not a signal the client has to act on.
 * A signal would put the decision in the RENDERER — the one participant that
 * is about to be destroyed by the very relaunch it was asked to arrange — and
 * would leave every non-renderer caller (curl, a script, a future menu item)
 * on the broken path. The interception in `desktop/main.js` records exactly
 * that limitation about itself.
 *
 * ── The one property that must never be traded away: NO FALLBACK ────────────
 *
 * If a capability says 'native-dialog' or 'app-relaunch' and NOTHING IS
 * REGISTERED, the consumer REFUSES. It does not quietly run `osascript`, and
 * it does not quietly `spawn(process.execPath)`. A silent fallback would make
 * the capability a lie — the route would claim one contract and honour
 * another — and both fallbacks are precisely the behaviour the bundle arm
 * exists to stop (an `osascript` the hardened runtime may kill outright; a
 * spawn of the app binary that opens a SECOND WINDOW instead of a server).
 *
 * A refusal is recoverable: it names what is missing and, for the folder
 * picker, points at the typed-path route that has always existed. A wrong
 * fallback is not.
 *
 * ── If the shape ever changes, this fails in the safe direction ─────────────
 *
 * Should a future packaging move the server into a utilityProcess or a child,
 * the shell's registration simply never reaches this realm, every hook reads
 * null, and every consumer refuses with a named reason. That is the same
 * asymmetry `paths.js` and `install-mode.js` are built on: the failure that
 * is loud and recoverable is the one we choose.
 *
 * ── Discipline ─────────────────────────────────────────────────────────────
 *
 * Performs NO filesystem work, makes no network call, and never writes to
 * stdout (this file is not on the MCP child's import graph today, but the
 * v2.5.3 rule is house-wide). It holds process-local state and nothing else.
 *
 * It deliberately does NOT read `install-mode.js`: registration and
 * capability are independent facts. A shell registering hooks does not make
 * an install a bundle, and an install being a bundle does not conjure hooks.
 * The CONSUMER joins the two, which is where the refusal belongs.
 *
 * ── HOW A SHELL ATTACHES, and the ordering that matters ────────────────────
 *
 * Written here rather than only in `desktop/`, because this is the file
 * someone reads when a bundle arm refuses and they want to know why:
 *
 *     await import(pathToFileURL(SERVER_ENTRY).href);      // starts the server
 *     const { registerDesktopHost } =
 *       await import(pathToFileURL(path.join(APP_ROOT, 'src/brain/desktop-host.js')).href);
 *     registerDesktopHost({
 *       pickFolder: async ({ prompt }) => {
 *         const r = await dialog.showOpenDialog(mainWindow,
 *           { title: prompt, properties: ['openDirectory', 'createDirectory'] });
 *         return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
 *       },
 *       relaunch: () => { quitAuthorised = true; app.relaunch(); app.exit(0); },
 *     });
 *
 * The import specifier MUST resolve to the same file the routes import, or
 * Node gives you a second module instance and a registry nobody reads —
 * deriving it from the same `APP_ROOT` the server entry came from is what
 * keeps that true. Registration may happen AFTER the server starts: nothing
 * reads a hook until a request arrives.
 *
 * AND THE INTERCEPTOR MUST GO. While `desktop/main.js` cancels
 * `POST /api/restart` in `session.webRequest.onBeforeRequest`, the request
 * never reaches Express and the `restartStyle` branch never runs — the
 * workaround and the fix would both be present, and the workaround wins.
 */

/**
 * The hook names this process will accept, and what each one promises.
 *
 * `pickFolder(opts) -> Promise<string|null>`
 *   Show a native directory chooser and resolve with the ABSOLUTE POSIX path
 *   the user selected, or `null` if they cancelled. It must NOT validate the
 *   path, mutate config, or throw for a cancel — the route owns all three, so
 *   that both arms of the fork share one set of post-pick rules.
 *   `opts.prompt` is the dialog's title.
 *
 * `relaunch() -> void`
 *   Restart the whole desktop application. Called AFTER the HTTP response has
 *   been sent and after `hasActiveWrites()` has already refused a restart
 *   during an ingest, so it must not re-litigate either. It is not expected to
 *   return.
 */
export const DESKTOP_HOOKS = Object.freeze(['pickFolder', 'relaunch']);

/** Process-local. Never persisted, never serialised, never sent over the wire. */
const hooks = Object.create(null);
for (const name of DESKTOP_HOOKS) hooks[name] = null;

/**
 * Install one or more hooks. Partial by design — a shell that can relaunch but
 * has no folder picker registers only what it has, and the consumer of the
 * other one refuses rather than inheriting a half-truth.
 *
 * REFUSES AN UNKNOWN NAME, loudly, for the same reason `defineCapabilities()`
 * refuses an unknown capability key: a typo'd `pickfolder` would register
 * nothing, throw nothing, and leave the route refusing forever with the shell
 * author certain they had wired it. A non-function value is refused for the
 * same reason.
 *
 * Returns the names actually installed, so a caller can assert on it.
 */
export function registerDesktopHost(next) {
  if (!next || typeof next !== 'object') {
    throw new Error('registerDesktopHost: expected an object of hooks');
  }
  const names = Object.keys(next);
  const unknown = names.filter((n) => !DESKTOP_HOOKS.includes(n));
  if (unknown.length) {
    throw new Error(
      `registerDesktopHost: unknown hook(s) ${unknown.join(', ')} — expected one of ${DESKTOP_HOOKS.join(', ')}`
    );
  }
  for (const n of names) {
    if (typeof next[n] !== 'function') {
      throw new Error(`registerDesktopHost: hook "${n}" must be a function, got ${typeof next[n]}`);
    }
  }
  for (const n of names) hooks[n] = next[n];
  return { registered: names.slice().sort() };
}

/**
 * The hook, or null. Consumers MUST treat null as "refuse", never as "fall
 * back" — see the no-fallback rule in this file's header.
 *
 * Own-property lookup through the frozen name list rather than `hooks[name]`,
 * so a caller that ever threads user input through here cannot reach
 * `__proto__` or `constructor`. (`hooks` is already a null-prototype object;
 * this is the second layer, and it costs nothing.)
 */
export function getDesktopHook(name) {
  if (!DESKTOP_HOOKS.includes(name)) return null;
  return hooks[name] || null;
}

/**
 * Wire-safe description — booleans only, never the functions themselves.
 * Suitable for System Check or `GET /api/version`; nothing consumes it yet,
 * and it is exported because "is a shell attached?" is the first question
 * anyone debugging a refusal will ask.
 */
export function describeDesktopHost() {
  const out = {};
  for (const n of DESKTOP_HOOKS) out[n] = typeof hooks[n] === 'function';
  return { hooks: out, attached: DESKTOP_HOOKS.some((n) => typeof hooks[n] === 'function') };
}

/**
 * TEST-ONLY. Clears every hook so a suite can prove the refusing arm and the
 * hooked arm in the same run, in either order.
 *
 * Exported rather than hidden behind an env check on purpose: an env-gated
 * reset is a second way for production behaviour to depend on a test variable,
 * and this function cannot do harm — the only thing it can achieve in
 * production is a refusal, which is the fail-safe direction.
 */
export function __resetDesktopHost() {
  for (const n of DESKTOP_HOOKS) hooks[n] = null;
}
