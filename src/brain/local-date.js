/**
 * local-date.js — THE one writer of bare `YYYY-MM-DD` calendar stamps (v3.72.1,
 * truth audit Ingest F6).
 *
 * Every reader of these stamps — shared/age.js's dayDelta behind the sidebar's
 * "x ago", the freshness dot and the domain page — reads a bare date as a LOCAL
 * calendar day. The writers used `new Date().toISOString().slice(0, 10)`, the
 * UTC day, so for |offset| hours every day a fresh write read "yesterday" (east
 * of Greenwich) or "dated ahead" (west of it). Writers of a calendar stamp use
 * this; ISO timestamps with a time and zone are untouched.
 *
 * A leaf module (no imports), so files.js, compile.js and ingest.js can all use
 * it without a cycle. Never writes stdout (reachable from mcp/).
 */
export function localDateStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
