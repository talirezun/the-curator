// src/brain/identity-palette.js — the identity palette for Node-side readers
// (v3.66.0).
//
// The macOS menubar widget (desktop/main.js, in Electron's main process) paints
// one colour per domain and cannot read CSS. It imports THIS path. The data
// itself lives in src/public/next/shared/identity-palette.js, because the
// browser has to load it too (src/brain is not served), and one copy is the
// whole point: `IDENTITY_SLOTS` is the one slot-count constant for the app AND
// the widget, and `IDENTITY_PALETTE` is pinned to tokens/identity.css by
// scripts/test-identity-palette.js.
//
// Pure data, no Node builtin, nothing that touches a filesystem or a network,
// so the widget's import-graph proofs (scripts/test-tray-summary.js §6) stay
// true if it is reached from there.
export {
  IDENTITY_SLOTS,
  IDENTITY_PALETTE,
  identitySlot,
  identityHex,
} from '../public/next/shared/identity-palette.js';
