/**
 * shared/format.js — THE FIGURE: one way to write a number on screen (kit v1).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 * The 2026-11-27 inventory (handoffs ANALYSIS-pro-ux.md §B) found nine local
 * size formatters that disagreed on the divisor (1000 in two views, 1024 in
 * seven), on the unit word ("B" vs "bytes"), and on the rounding (always one
 * decimal, never a decimal, one decimal under 100 KB). The same page could
 * read "196 KB" in one block and "191 KB" in the next. Every size, count,
 * token estimate, age and price in /next is now written by a function here,
 * and scripts/test-format.js fails a view that grows a local copy.
 *
 * ── THE RULES, ONCE ─────────────────────────────────────────────────────
 *   fmtCount(n)    whole number, en-US separators always: 3527 → "3,527".
 *   fmtPages(n)    "1 page" / "3,527 pages".
 *   fmtSize(bytes) ONE DIVISOR, 1024 (SIZE_DIVISOR). It is the divisor seven
 *                  of the nine old formatters already used, and the one the
 *                  operating system's file browser and every download shelf
 *                  this app is compared against use. The unit is still
 *                  written "KB"/"MB" (not "KiB"), as macOS and Windows write
 *                  it. Under 1024: "N bytes" ("1 byte"). From 1 KB: ONE
 *                  decimal below 10 of the unit ("1.8 KB", "9.9 KB"), a whole
 *                  number from 10 ("62 KB", "1,023 KB"); a trailing ".0" is
 *                  dropped ("4 KB", not "4.0 KB", so a whole-KB budget reads
 *                  as the round figure it is). A value that ROUNDS to 1024 of
 *                  a unit is written in the next unit ("1 MB", never
 *                  "1,024 KB"). MB and GB take the same rule.
 *   fmtTokens(n)   an ESTIMATE, so always with "≈": "≈0.5k", "≈10.3k",
 *                  "≈205k", "≈1M". The ladder is the one shared/bucket.js's
 *                  meter kit already spoke (moved here, so the meter and
 *                  every other token figure are one function):
 *                    < 100,000     one decimal of k, rounded half up; a
 *                                  whole number from 10k drops ".0"
 *                                  ("20k"); never "0.0k" for a non-zero
 *                                  count (a positive count under 50 reads
 *                                  "0.1k" — an estimate is never written as
 *                                  nothing when there is something)
 *                    100k – 1M     whole k ("205k")
 *                    ≥ 1M          one decimal of M, ".0" dropped ("1M",
 *                                  "1.5M"); a count that ROUNDS to 1000k is
 *                                  written "1M" (the old ladder wrote
 *                                  "1000k" for 999,500–999,999)
 *                  Zero is exact and carries no "≈": "0".
 *   fmtAge(t, now) the SECOND-resolution ladder of shared/age.js
 *                  (formatAge), which stays the canonical age and is not
 *                  copied here. This adds only the input handling every call
 *                  site repeated inline — ISO string, epoch ms or Date —
 *                  and the FUTURE: up to FUTURE_SKEW_S ahead (two computers'
 *                  clocks disagree) reads "just now"; further ahead reads
 *                  "dated ahead", formatDayAge's own word, because an age is
 *                  never rounded younger than the data allows (v3.34.0).
 *   fmtUsd(x)      shared/format-usd.js's formatUsdHonest, re-exported: a
 *                  non-zero cost never renders as zero.
 *
 * Every function returns null for a value that is not a number it can write
 * (NaN, null, undefined, a negative size or count where none can exist), the
 * convention update-phases.js, trash-list.js and formatUsdHonest already
 * keep: a caller can tell "no figure" from "zero" and say different things.
 *
 * ── NOT HERE, ON PURPOSE (each allow-listed with this reason in
 *    scripts/test-format.js) ─────────────────────────────────────────────
 *   shared/model-row.js contextWords — a model's context window in the
 *       VENDOR's own units ("1M", "512K", binary only when the vendor's figure
 *       is a power of two). It quotes a catalogue, it does not measure bytes.
 *   shared/update-phases.js formatBytes — a DOWNLOAD PROGRESS ticker, one
 *       decimal below 100 so the figure visibly moves on a slow connection;
 *       also held by the parallel update-check patch (do not edit there).
 *   views/memory.js's Session start tile — a body that is LIFTED by brace
 *       matching into two suites and may name no free identifier; it writes
 *       the same ladder as fmtTokens inline and test-format.js executes both
 *       over a matrix so the two cannot drift.
 *   views/memory.js formatAge — the pinned byte-identical copy of age.js's
 *       ladder (scripts/test-sidebar-status-rows.js holds the three copies).
 *
 * DOM-free and import-light: a suite imports it in plain Node.
 */

import { formatAge, formatDayAge } from './age.js';
import { formatUsdHonest } from './format-usd.js';

export { formatAge, formatDayAge };

/** The one size divisor (see the header). */
export const SIZE_DIVISOR = 1024;

/** How far ahead of this clock a timestamp may be and still read "just now". */
export const FUTURE_SKEW_S = 300;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 3527 → "3,527". Rounded to a whole number. null when not a number. */
export function fmtCount(n) {
  if (!isNum(n)) return null;
  const r = Math.round(n);
  return (r === 0 ? 0 : r).toLocaleString('en-US');
}

/** "1 page" / "3,527 pages" / "0 pages". null when not a count. */
export function fmtPages(n) {
  const c = fmtCount(n);
  if (c === null) return null;
  return c + (Math.round(n) === 1 ? ' page' : ' pages');
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'];

/** One unit's figure: one decimal below 10, whole from 10, ".0" dropped. */
function unitFigure(v) {
  const tenth = Math.round(v * 10) / 10;
  if (tenth < 10) return Number.isInteger(tenth) ? String(tenth) : tenth.toFixed(1);
  return Math.round(v).toLocaleString('en-US');
}

/** Bytes → "512 bytes" / "1.8 KB" / "62 KB" / "14 MB". null when not a size. */
export function fmtSize(bytes) {
  if (!isNum(bytes) || bytes < 0) return null;
  const b = Math.round(bytes);
  if (b < SIZE_DIVISOR) return b + (b === 1 ? ' byte' : ' bytes');
  let v = b / SIZE_DIVISOR;
  let u = 0;
  // Move up a unit when the value would ROUND to 1024 of this one, so the
  // figure is never "1,024 KB" (and never "1024.0 KB").
  while (u < SIZE_UNITS.length - 1 && Math.round(v) >= SIZE_DIVISOR) { v /= SIZE_DIVISOR; u++; }
  return unitFigure(v) + ' ' + SIZE_UNITS[u];
}

/** A signed change in size: "+6.1 KB" / "−340 bytes"; null when unchanged or
 *  not a number ("+0 bytes" would claim something happened). */
export function fmtSizeDelta(bytes) {
  if (!isNum(bytes) || Math.round(bytes) === 0) return null;
  return (bytes > 0 ? '+' : '−') + fmtSize(Math.abs(bytes));
}

/**
 * The token FIGURE without the "≈" — for a place that composes its own
 * estimate mark (the meter kit's labels). 0 and anything not a positive
 * number read "0" (the meter kit's long-standing contract).
 */
export function fmtTokenFigure(n) {
  const v = isNum(n) && n > 0 ? n : 0;
  if (v === 0) return '0';
  const m = (x) => { const r = Math.round(x / 1e5) / 10; return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + 'M'; };
  if (v >= 1e6) return m(v);
  if (v >= 1e5) {
    const k = Math.round(v / 1000);
    return k >= 1000 ? m(v) : k + 'k';
  }
  // Below ~1k a count is said as itself (e2e m6, v4.3.0 fix round: 115 bytes
  // read "≈0.1k" — honest is "≈30"); to the nearest 10 from 100, so an
  // estimate never claims single-token precision.
  if (v < 950) return String(v < 100 ? Math.max(1, Math.round(v)) : Math.round(v / 10) * 10);
  const k = Math.round(v / 100) / 10;
  if (k >= 100) return Math.round(v / 1000) + 'k';
  if (k >= 10 && Number.isInteger(k)) return k + 'k';   // "20k", not "20.0k"
  return k.toFixed(1) + 'k';
}

/** An estimated token count: "≈10.3k". Zero is exact: "0". null when not a
 *  number. */
export function fmtTokens(n) {
  if (!isNum(n) || n < 0) return null;
  const f = fmtTokenFigure(n);
  return f === '0' ? '0' : '≈' + f;
}

/** ISO string, epoch ms or Date → epoch ms, or null. */
function toMs(t) {
  if (t instanceof Date) { const v = t.getTime(); return isNum(v) ? v : null; }
  if (isNum(t)) return t;
  if (typeof t === 'string' && t.trim()) { const v = Date.parse(t); return isNum(v) ? v : null; }
  return null;
}

/** "just now" / "27 min ago" / "21 hr ago" / "1 day ago" / "2 weeks ago" …
 *  null when there is no readable time. See the header for the future. */
export function fmtAge(isoOrMs, now = Date.now()) {
  const t = toMs(isoOrMs);
  const n = toMs(now);
  if (t === null || n === null) return null;
  const secs = (n - t) / 1000;
  if (secs < 0) return -secs <= FUTURE_SKEW_S ? 'just now' : 'dated ahead';
  return formatAge(Math.round(secs));
}

/** USD, honestly (shared/format-usd.js). */
export function fmtUsd(x) {
  return formatUsdHonest(x);
}
