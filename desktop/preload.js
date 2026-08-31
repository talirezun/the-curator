/**
 * Preload — deliberately empty of API surface.
 *
 * The renderer is The Curator's OWN frontend, served over loopback by the same
 * `src/server.js` a browser talks to. It already has everything it needs: a
 * fetch to `/api/...`, over an origin the server's guards allow. Exposing an
 * IPC bridge would create a SECOND way into the app's capabilities — one that
 * bypasses the cross-origin guard, the Host guard, the write registry's 409s
 * and every route-level validation — for no capability the HTTP API lacks.
 *
 * So this file intentionally calls no `contextBridge.exposeInMainWorld`. It
 * exists because `sandbox: true` + `contextIsolation: true` in main.js want a
 * preload path, and because an empty, explained preload is a better artefact
 * than an absent one: the next person to reach for IPC finds the reason not to.
 *
 * If a genuine need appears (a native menu action, a file-drop path), add ONE
 * narrow, named channel with an allow-list — never a generic `invoke(channel,
 * args)` passthrough, which is `eval` wearing a hat.
 *
 * CommonJS on purpose: a sandboxed preload is loaded as CommonJS regardless of
 * the package's "type", so `require` is the correct form here even though every
 * other file in this folder is ESM.
 */

// Nothing exposed. See above.
