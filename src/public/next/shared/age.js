/**
 * age.js — ONE age vocabulary for every status row in /next.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 * Two sidebars now carry the same STATUS-ROW ANATOMY — name, key figure, a
 * freshness mark plus a relative age, and the last event. Ingest's
 * destination rows and Domains' knowledge rows. Before this they each said
 * "last write 2026-09-16", an absolute date the reader has to do arithmetic
 * on, while the Agent-memory rows and the menubar tray said "3 days ago" in
 * a vocabulary of their own.
 *
 * Three copies of one vocabulary is this repo's named drift shape, so the
 * words live here and both views IMPORT them.
 *
 * ── TWO CLOCKS, DELIBERATELY, BECAUSE THERE ARE TWO RESOLUTIONS ─────────
 * `formatAge(seconds)` is the SECOND-resolution ladder the memory rows and
 * the tray already speak. It is a BYTE-IDENTICAL copy of the body in
 * src/public/next/views/memory.js — copied rather than imported for the same
 * reason desktop/lib/tray-model.js copies it: memory.js registers a view and
 * reaches for a DOM at import time, so a module that must stay DOM-free
 * cannot import it. The duplication is only safe because it is PINNED:
 * scripts/test-sidebar-status-rows.js extracts all THREE bodies from their
 * real sources and compares them byte for byte, the same way
 * scripts/test-tray-shell.js already does for two of them.
 *
 * `formatDayAge(dateStr)` is the DAY-resolution ladder, and it is a
 * different function rather than a call into the first one because the input
 * is genuinely different. `lastIngestDate` is a `YYYY-MM-DD` heading written
 * by appendLog: it has NO time of day, and log.md's mtime is rewritten by
 * Personal Sync on every pull, so there is no truthful second-resolution
 * clock to fall back on. Feeding a fabricated midnight into `formatAge`
 * would produce "7 hr ago" for a write that happened at any hour of today —
 * a precision the data does not have, which is the v3.34.0 rule this file is
 * written against: ONE age source, never rounded younger, and unknown
 * rendered as unknown.
 *
 * ── THE MARK AND THE WORD ARE CUT ON THE SAME BANDS ─────────────────────
 * `dayFreshnessStep` reads its band boundaries off `formatDayAge`'s own
 * ladder, so a dot can never say "today" while the words beside it say
 * "1 week ago". A second, independently-tuned threshold table is how those
 * two readings drift apart, and v3.34.0 records that class.
 *
 * ── NO DOM AT IMPORT ────────────────────────────────────────────────────
 * Pure functions and one string-returning glyph. Nothing here touches
 * `document`, so a suite can import this module in plain Node.
 */

// ── The SECOND-resolution ladder ────────────────────────────────────────
// BYTE-IDENTICAL to src/public/next/views/memory.js's body and to
// desktop/lib/tray-model.js's. Do not "tidy" it here: the three are pinned
// against each other, and a tidy in one file is a red suite, by design.
export function formatAge(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hr ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  const w = Math.floor(d / 7);
  if (w < 5) return w + ' week' + (w === 1 ? '' : 's') + ' ago';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + ' month' + (mo === 1 ? '' : 's') + ' ago';
  const y = Math.floor(d / 365);
  return y + ' year' + (y === 1 ? '' : 's') + ' ago';
}

// ── The DAY-resolution ladder ───────────────────────────────────────────
//
// TIMEZONE: the comparison is over CALENDAR DAYS IN LOCAL TIME, and that is
// the correct frame rather than a convenience. The `YYYY-MM-DD` in log.md was
// written by the machine that did the ingest, which for the overwhelmingly
// common single-machine install is this machine; comparing it against the
// reader's own local calendar day is what makes "today" mean the day they
// are living in. Stated rather than implied because it is NOT exact for a
// synced two-machine setup across a date line — and the honest answer there
// is that a day-resolution date cannot be, which is why the band beside it
// is coarse.
//
// Returns null for null/undefined/malformed input. The CALLER renders that
// as "nothing written yet" or "unknown"; this function never guesses a date,
// and never returns a zero-valued phrase ("0 years ago") — every band below
// is continuous with the next, so no input falls between two of them.
export function formatDayAge(dateStr, now = Date.now()) {
  const days = dayDelta(dateStr, now);
  if (days === null) return null;
  // A date in the FUTURE is not an error and is not "today". A hand-edited
  // log, or a machine whose clock is ahead of this one's, can produce one;
  // reporting it as today would be rounding it YOUNGER, which v3.34.0 names
  // as the one direction an age must never be wrong in.
  if (days < 0) return 'dated ahead';
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return days + ' days ago';
  if (days < 35) { const w = Math.floor(days / 7); return w + ' week' + (w === 1 ? '' : 's') + ' ago'; }
  if (days < 365) { const mo = Math.floor(days / 30); return mo + ' month' + (mo === 1 ? '' : 's') + ' ago'; }
  const y = Math.floor(days / 365);
  return y + ' year' + (y === 1 ? '' : 's') + ' ago';
}

// The freshness mark, 0–3, or null when the age is unknown.
//
// CUT ON formatDayAge's OWN BANDS, not on a second threshold table:
//   3  today                       — the ladder's `days < 1` arm
//   2  yesterday / N days ago      — its `days < 7` arms ("this week")
//   1  N weeks ago                 — its `days < 35` arm ("this month")
//   0  a month or more             — everything past it
// A future date takes step 0: we do not know what it means, and the one
// thing we must not do is paint it as the freshest possible reading.
export function dayFreshnessStep(dateStr, now = Date.now()) {
  const days = dayDelta(dateStr, now);
  if (days === null) return null;
  if (days < 0) return 0;
  if (days < 1) return 3;
  if (days < 7) return 2;
  if (days < 35) return 1;
  return 0;
}

// Whole calendar days between a `YYYY-MM-DD` string and `now`, in LOCAL time.
// null when the string is absent or not a real date. Built from local date
// COMPONENTS, not from Date.parse — which reads a bare `YYYY-MM-DD` as UTC
// and would shift the answer by a day for every reader west of Greenwich.
function dayDelta(dateStr, now) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const then = new Date(y, mo - 1, d);
  // Round-trip check: `new Date(2026, 1, 31)` silently becomes 2 March, so a
  // malformed-but-plausible date would otherwise be answered rather than
  // refused.
  if (then.getFullYear() !== y || then.getMonth() !== mo - 1 || then.getDate() !== d) return null;
  const nowD = new Date(now);
  const today = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate());
  // Math.round, not floor: a DST transition inside the span makes one of
  // these "days" 23 or 25 hours long, and a floor would then report a
  // whole-day boundary one day late.
  return Math.round((today.getTime() - then.getTime()) / 86400000);
}

// ── The freshness mark ──────────────────────────────────────────────────
//
// WHY THE CLASS PREFIX IS A PARAMETER. The two views that carry status rows
// own their own stylesheets; shell.css belongs to another change, so the dot
// RULES are declared twice, once per view, with identical values and
// different prefixes (`.ing-fresh-*`, `.dm-fresh-*`), and a suite asserts the
// two ladders are byte-identical modulo the prefix. The DECISION — which step
// a date is on, and what "unknown" looks like — is not duplicated: it is this
// function, and it is the only place `dayFreshnessStep` is turned into a
// class name. A follow-up promoting the rules into shell.css deletes one of
// the CSS copies and changes nothing here.
//
// aria-hidden: the dot is a redundant encoding of the age phrase rendered
// immediately beside it, never a fact of its own. That is also why colour is
// never the only carrier — the words say the same thing.
export function freshnessDotHtml(prefix, dateStr, now = Date.now()) {
  const step = dayFreshnessStep(dateStr, now);
  const mod = step === null ? 'unknown' : 's' + step;
  return '<span class="' + prefix + '-fresh ' + prefix + '-fresh-' + mod +
    '" aria-hidden="true"></span>';
}

// ── The clock glyph ─────────────────────────────────────────────────────
//
// NOT `icon('clock', …)`: src/public/next/app.js's ICON_BODY has no clock,
// and app.js is not this change's to edit. It follows the kit's own geometry
// exactly — 24×24 viewBox, `fill: none`, `stroke: currentColor`, width 1.7,
// round caps and joins, `aria-hidden` — so it sits beside a real kit icon
// without reading as a different set. ONE copy, imported by both views:
// views/domains.js and views/settings.js each already carry a private inline
// SVG, and a third and fourth hand-maintained copy of one mark is the shape
// this module exists to avoid.
//
// aria-hidden, deliberately: the glyph REPEATS the words beside it ("3 days
// ago"), it is not a second fact. A screen reader that announced it would
// read the row's age twice.
//
// NO CLASS ON THE <svg>. It was `class="tx-clock"` for one commit, and that
// is a name shared/text.css owns outright — scripts/test-next-text-system.js
// fails any other stylesheet that defines a `tx-` rule, and it caught this.
// The views style it by ELEMENT inside their own meta line
// (`.ing-dest-meta svg`, `.dm-row-meta svg`), which is also what keeps
// `--text-3` off a text selector in files where that token is retired as a
// text colour — an svg is a graphic, and the 3:1 non-text floor is the one
// that applies to it.
export function clockGlyph(size) {
  const px = size || 12;
  return (
    '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ' +
    'aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/></svg>'
  );
}
