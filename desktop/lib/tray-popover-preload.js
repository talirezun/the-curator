/**
 * tray-popover-preload.js — the Windows tray popover's preload, and the ONLY bridge its page has.
 *
 * desktop/preload.js (the main window's) stays empty: its header asks for "ONE narrow, named channel
 * with an allow-list" if a real need appears. This is that channel, loaded only into the popover
 * window (sandbox, contextIsolation, no nodeIntegration). It exposes exactly
 *
 *   window.curatorTray = { onModel(cb), act(gen, id), size(height), painted(gen, rows), dismiss() }
 *
 * (CONTRACT-tray-popover.md §3). Every message has a fixed shape; main checks it again
 * (tray-popover-ipc.js) and also checks the sender frame, the page URL, visibility and the gen.
 *   - act: only while navigator.userActivation.isActive (a real click or key press; page script
 *     cannot make one), one call in flight (a second answers false without IPC), a 1..200-char id
 *     and a positive safe-integer gen; answers true/false and never rejects.
 *   - dismiss: NOT activation-gated on purpose: Escape is excluded from activation-triggering keys
 *     by the HTML spec, so gating it would make Esc dead. Its worst case is hiding the popover.
 *   - onModel: a later call replaces the callback; the latest payload that arrived before any
 *     callback is delivered once on registration (main sends after did-finish-load, but a page that
 *     registers late must not paint nothing).
 *
 * CommonJS on purpose: a sandboxed preload is loaded as CommonJS regardless of package "type".
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const CH = Object.freeze({
  model: 'curator-tray:model',
  act: 'curator-tray:act',
  size: 'curator-tray:size',
  painted: 'curator-tray:painted',
  dismiss: 'curator-tray:dismiss',
});
const MAX_ID_CHARS = 200;

let modelCb = null;
let pending = null;   // { payload } that arrived before a callback was registered
let busy = false;

function deliver(payload) {
  try { modelCb(payload); } catch (_) { /* the page's own error */ }
}

ipcRenderer.on(CH.model, (_event, payload) => {
  if (typeof modelCb === 'function') deliver(payload);
  else pending = { payload };
});

function activated() {
  try {
    const a = globalThis.navigator && globalThis.navigator.userActivation;
    return Boolean(a && a.isActive === true);
  } catch (_) {
    return false;
  }
}

const isGen = (g) => Number.isSafeInteger(g) && g >= 1;

function onModel(cb) {
  if (typeof cb !== 'function') return;
  modelCb = cb;
  if (pending) {
    const { payload } = pending;
    pending = null;
    deliver(payload);
  }
}

function act(gen, id) {
  if (!isGen(gen) || typeof id !== 'string' || id.length < 1 || id.length > MAX_ID_CHARS) return Promise.resolve(false);
  if (busy || !activated()) return Promise.resolve(false);
  busy = true;
  let sent;
  try {
    sent = ipcRenderer.invoke(CH.act, { gen, id });
  } catch (_) {
    busy = false;
    return Promise.resolve(false);
  }
  return Promise.resolve(sent)
    .then((answer) => answer === true, () => false)
    .finally(() => { busy = false; });
}

function size(height) {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return;
  try { ipcRenderer.send(CH.size, { height }); } catch (_) { /* */ }
}

function painted(gen, rows) {
  if (!isGen(gen) || !Number.isSafeInteger(rows) || rows < 0) return;
  try { ipcRenderer.send(CH.painted, { gen, rows }); } catch (_) { /* */ }
}

function dismiss() {
  try { ipcRenderer.send(CH.dismiss, {}); } catch (_) { /* */ }
}

contextBridge.exposeInMainWorld('curatorTray', Object.freeze({ onModel, act, size, painted, dismiss }));
