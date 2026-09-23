// ═══════════════════════════════════════════════════════════════════════════
//  shared/depth-bar.js — THE DEPTH BAR'S PUBLIC ADDRESS (v3.66.0)
// ═══════════════════════════════════════════════════════════════════════════
//
// The app's THIRD visual channel — SIZE / SHARE against a NAMED denominator —
// beside TIME (the freshness dot) and WHICH DOMAIN (the identity dot). Its
// rules are design rule 6 and live in shared/depth-bar.css's header; in short:
// a real budget or a column of peers, never a time, never a `<summary>` or a
// sidebar row, and the danger tone only for a budget over-run, which the host
// also says in words, unfolded.
//
// HOSTS OUTSIDE A MONITOR IMPORT FROM HERE: the Documents and Handoffs tables,
// the Chat project footer, the Ingest batch panel. A monitor line takes a
// `depth` object instead and never calls this directly.
//
// `renderDepthCell` is DEFINED in shared/monitor.js and re-exported here — see
// that file's "ITS PUBLIC ADDRESS" note for the measured reason (a suite pins
// monitor.js to zero imports, and `renderMonitor` must call the function).
//
// THE IDENTITY TONE. Where a bar ROW IS a domain — the per-domain page
// monitors — the bar takes that domain's colour, from the SAME palette and
// the SAME mapping as the dot beside it (design rule 5), never a second one.

import { identitySlot } from './identity-palette.js';

export { renderDepthCell } from './monitor.js';

/**
 * An install's domain index -> the depth bar's identity tone class
 * (`cur-depth-id-N`), for `renderDepthCell({ toneClass })` or a monitor
 * line's `depth.toneClass`. Same arithmetic as `identityDotClass`, because it
 * IS the same mapping (both call `identitySlot`).
 *
 * The danger tone still wins nothing here: an identity tone is an explicit
 * `toneClass`, and renderDepthCell only sets `cur-depth-danger` itself when
 * no tone was given. A per-domain comparison has no budget, so it never
 * over-runs.
 * @param {number} index
 * @returns {string}
 */
export function depthIdentityClass(index) {
  return 'cur-depth-id-' + identitySlot(index);
}
