/**
 * tray-popover-ipc.js — the main-process side of the Windows tray popover's ONE narrow IPC surface.
 *
 * desktop/preload.js stays empty on purpose ("ONE narrow, named channel with an allow-list"); this is
 * that channel, for the popover window only (desktop/lib/tray-popover-preload.js on the other side).
 * Contract: CONTRACT-tray-popover.md §3 (P2, 2026-11-21).
 *
 *   curator-tray:model    main → page   webContents.send(payload)            (not handled here)
 *   curator-tray:act      page → main   invoke {gen, id}       → boolean     gate.act; false ⇒ resend
 *   curator-tray:size     page → main   send   {height}                      clamped by the controller
 *   curator-tray:painted  page → main   send   {gen, rows}                   ends the first-paint wait
 *   curator-tray:dismiss  page → main   send   {}                            hides (Esc on root)
 *
 * A page → main message is accepted only when ALL hold, else it is ignored (`act` answers false):
 *   - the sender is the popover's own webContents (identity, not an id that could be reused),
 *   - the sending frame is that webContents' TOP frame (`event.senderFrame === mainFrame`),
 *   - that frame's URL is exactly the popover page's file URL (no query, no fragment, same file),
 *   - the message is a plain object with exactly the listed own keys, of the listed types;
 *   - `act` additionally only while the popover is on screen (visible and not waiting to paint).
 * The generation and id checks are the gate's (tray-popover-model.js createPopoverActionGate): a
 * stale gen is refused because row ids are a per-build sequence and an old id can name a DIFFERENT
 * project after a refresh. User activation is checked in the preload (main cannot see it; the page
 * cannot forge it either: it is the browser's own per-frame state, read from the isolated world).
 * Nothing is logged about a refused message. Nothing here throws into Electron.
 */

export const CHANNELS = Object.freeze({
  model: 'curator-tray:model',
  act: 'curator-tray:act',
  size: 'curator-tray:size',
  painted: 'curator-tray:painted',
  dismiss: 'curator-tray:dismiss',
});

/** Longest action id the contract allows. */
export const MAX_ACTION_ID_CHARS = 200;
/** Largest content height a page may report (anything above is junk; the controller clamps further). */
export const MAX_REPORTED_HEIGHT = 100000;

const isSafeGen = (g) => Number.isSafeInteger(g) && g >= 1;

/** A structured-clone plain object with EXACTLY these own keys; else false. */
function hasExactKeys(msg, keys) {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return false;
  const proto = Object.getPrototypeOf(msg);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Reflect.ownKeys(msg);
  if (own.length !== keys.length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(msg, k));
}

/** `{gen, id}` → the same, or null. */
export function parseAct(msg) {
  if (!hasExactKeys(msg, ['gen', 'id'])) return null;
  const { gen, id } = msg;
  if (!isSafeGen(gen)) return null;
  if (typeof id !== 'string' || id.length < 1 || id.length > MAX_ACTION_ID_CHARS) return null;
  return { gen, id };
}

/** `{height}` → the same, or null. */
export function parseSize(msg) {
  if (!hasExactKeys(msg, ['height'])) return null;
  const { height } = msg;
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || height > MAX_REPORTED_HEIGHT) return null;
  return { height };
}

/** `{gen, rows}` → the same, or null. */
export function parsePainted(msg) {
  if (!hasExactKeys(msg, ['gen', 'rows'])) return null;
  const { gen, rows } = msg;
  if (!isSafeGen(gen) || !Number.isSafeInteger(rows) || rows < 0) return null;
  return { gen, rows };
}

/** `{}` → `{}`, or null. */
export function parseDismiss(msg) {
  return hasExactKeys(msg, []) ? {} : null;
}

/**
 * The local file a `file:` URL names, as a platform path; null for anything else (another scheme,
 * a host (UNC), a query, a fragment, a bad escape, a relative segment on win32).
 * Decoded by hand so it is the same on every host Node runs the suite on.
 */
export function fileUrlToPlatformPath(url, platform = process.platform) {
  if (typeof url !== 'string' || url.length === 0 || url.length > 8192) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'file:' || u.host !== '') return null;
  // No query and no fragment, not even an EMPTY one (which leaves search/hash ''): a literal ? or #
  // in a file URL is always one; the characters themselves arrive as %3F / %23.
  if (url.includes('?') || url.includes('#')) return null;
  let p;
  try { p = decodeURIComponent(u.pathname); } catch { return null; }
  if (p.includes('\0')) return null;
  if (platform === 'win32') {
    const m = /^\/([A-Za-z]):(\/.*)?$/.exec(p);
    if (!m) return null;
    p = `${m[1]}:${(m[2] || '/').replace(/\//g, '\\')}`;
  }
  return p;
}

const sameFile = (a, b, platform) =>
  platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** True when `url` is exactly the popover page's file URL. */
export function isPageUrl(url, pagePath, platform = process.platform) {
  if (typeof pagePath !== 'string' || pagePath.length === 0) return false;
  const p = fileUrlToPlatformPath(url, platform);
  return p !== null && sameFile(p, pagePath, platform);
}

/**
 * True when an IPC event comes from the popover's top frame showing the popover page.
 * `target.webContents()` → the popover's webContents or null (no window, destroyed).
 */
export function senderAllowed(event, target) {
  try {
    const wc = target.webContents();
    if (!wc || !event || event.sender !== wc) return false;
    const frame = event.senderFrame;
    if (!frame || (frame.parent !== null && frame.parent !== undefined)) return false;
    const top = wc.mainFrame;
    // Identity first; the (processId, routingId) pair names the same frame if Electron ever hands
    // out a second wrapper object for it.
    if (frame !== top && !(top && Number.isInteger(frame.routingId) && frame.processId === top.processId
      && frame.routingId === top.routingId)) return false;
    return isPageUrl(frame.url, target.pagePath, target.platform);
  } catch {
    return false;
  }
}

/**
 * Registers the four page → main channels. Returns { dispose() } (removes exactly what it added).
 *
 * deps:
 *   ipcMain                Electron's ipcMain (handle/removeHandler/on/removeListener)
 *   target                 { webContents(), isShown(), currentGen(), knownId(id), pagePath, platform }
 *   gate                   createPopoverActionGate() (act, current)
 *   quit                   () => app.quit()  — NEVER app.exit(): before-quit carries the write guard
 *   onActed()              after a successful act (the controller hides)
 *   resend()               after a refused act from the popover itself (the page repaints)
 *   onSize({height}), onPainted({gen, rows}), onDismiss()
 */
export function registerTrayPopoverIpc(deps) {
  const { ipcMain, target, gate } = deps;
  const call = (fn, ...args) => { try { if (typeof fn === 'function') fn(...args); } catch { /* never into Electron */ } };

  const onAct = async (event, msg) => {
    try {
      if (!senderAllowed(event, target)) return false;
      if (target.isShown() !== true) return false;
      const parsed = parseAct(msg);
      if (!parsed) return false;
      // Main's own cross-check before the gate: the gen and the id must be those of the payload
      // this page was last SENT (the gate checks the last PUBLISHED one; both must agree).
      if (parsed.gen !== target.currentGen() || target.knownId(parsed.id) !== true) {
        call(deps.resend);
        return false;
      }
      const ok = gate.act(parsed.gen, parsed.id, { quit: deps.quit }) === true;
      if (ok) call(deps.onActed);
      else call(deps.resend);
      return ok;
    } catch {
      return false;
    }
  };
  const onSize = (event, msg) => {
    if (!senderAllowed(event, target)) return;
    const parsed = parseSize(msg);
    if (parsed) call(deps.onSize, parsed);
  };
  const onPainted = (event, msg) => {
    if (!senderAllowed(event, target)) return;
    const parsed = parsePainted(msg);
    if (parsed) call(deps.onPainted, parsed);
  };
  const onDismiss = (event, msg) => {
    if (!senderAllowed(event, target)) return;
    if (parseDismiss(msg)) call(deps.onDismiss);
  };

  ipcMain.handle(CHANNELS.act, onAct);
  ipcMain.on(CHANNELS.size, onSize);
  ipcMain.on(CHANNELS.painted, onPainted);
  ipcMain.on(CHANNELS.dismiss, onDismiss);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      try { ipcMain.removeHandler(CHANNELS.act); } catch { /* */ }
      try { ipcMain.removeListener(CHANNELS.size, onSize); } catch { /* */ }
      try { ipcMain.removeListener(CHANNELS.painted, onPainted); } catch { /* */ }
      try { ipcMain.removeListener(CHANNELS.dismiss, onDismiss); } catch { /* */ }
    },
  };
}
