/**
 * update-engine.js — the in-app updater's front door: one engine per platform.
 *
 *   createUpdateInstaller('darwin', deps)  the Mac engine, update-install-darwin.js
 *   createUpdateInstaller('win32', deps)   the Windows engine, update-install-win32.js
 *   anything else                          null: no updater (the hooks are not
 *                                          registered and the route refuses with
 *                                          `no-updater`, desktop-host.js's rule)
 *
 * ── THE MAC ENGINE IS UNCHANGED, BYTE FOR BYTE ──────────────────────────────
 *
 * update-install-darwin.js IS the v3.99.3 update-engine.js, moved with
 * `git mv` and not edited (sha-256 1143961d…ddfb8bf, before and after). Its
 * whole docblock, including why this is not electron-updater, is there. This
 * file re-exports it, so every existing importer (main.js, the macOS suites)
 * keeps working unchanged.
 *
 * ── ONE SURFACE ─────────────────────────────────────────────────────────────
 *
 * Both engines return the same four methods, which are what main.js wires to
 * the two desktop-host hooks:
 *
 *   prepareUpdate({onProgress, signal})   → {ok:true, token, version, …} | failure
 *   installUpdate({token, onProgress, stopConnections?}) → {ok:true, installing} | failure
 *   discardPrepared()                     → {ok, discarded}
 *   describe()                            → {preparedVersion, token, verifiedDigest}
 *
 * plus two that only do something on Windows and are harmless elsewhere, so
 * the shell can call them without a platform branch:
 *
 *   checkInUse()                  → {ok, connections, others}
 *   afterStart({currentVersion})  → {ok, outcome: null | {status, result, version, message}}
 *
 * Imports nothing from Electron and nothing from `src/`.
 */

import { createUpdateEngine } from './update-install-darwin.js';
import { createWin32UpdateEngine } from './update-install-win32.js';

export * from './update-install-darwin.js';
export { createWin32UpdateEngine } from './update-install-win32.js';

/** The platforms that have an in-app updater. */
export const UPDATE_PLATFORMS = Object.freeze(['darwin', 'win32']);

export function createUpdateInstaller(platform, deps = {}) {
  if (platform === 'darwin') {
    const engine = createUpdateEngine(deps);
    return {
      ...engine,
      checkInUse: async () => ({ ok: true, connections: 0, others: 0 }),
      afterStart: async () => ({ ok: true, outcome: null, removed: 0, kept: 0 }),
    };
  }
  if (platform === 'win32') return createWin32UpdateEngine(deps);
  return null;
}
