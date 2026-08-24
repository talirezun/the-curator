// Shared logic: batch ingest queue — pure helpers.
//
// This file is a BYTE-IDENTICAL copy of 13 pure helper functions (plus the
// BIDI_CONTROL_RE constant they share) that live in src/public/app.js (the
// shipping app), drawn from TWO NON-CONTIGUOUS ranges of that file:
//   - 11 of them come from app.js's own "Pure helpers (extracted +
//     unit-tested via new Function in scripts/test-ingest-queue-frontend.js
//     ...)" section, roughly its lines 669–883.
//   - computeQueueStatusCounts and computeQueueSpentLabel come from a
//     SEPARATE range, roughly app.js's lines 970–1085, inside what that
//     file calls its "Pure HTML-string builders" section — despite the
//     section name, both of these two return plain data/strings, not
//     markup. They were originally left out of this file and REIMPLEMENTED
//     locally in views/ingest.js on the theory that "HTML builders" (by
//     app.js line range) meant "reimplement, don't copy" — that theory was
//     wrong for these two specifically: computeQueueStatusCounts encodes
//     the no-item-lost bucketing invariant (a real v3.3.0 bug: an item
//     could appear in NONE of the UI's buckets while a "Running" pill still
//     showed on a finished batch), and computeQueueSpentLabel had ALREADY
//     drifted cosmetically (a template literal in app.js vs string
//     concatenation in the /next reimplementation) before the mismatch was
//     caught. The lesson, recorded rather than just fixed: this file's
//     boundary is drawn by a function's NATURE (pure logic vs markup), not
//     by which app.js section it happens to sit in — a function that
//     returns data, not HTML, belongs here even if app.js filed it under
//     "HTML builders".
//
// Do not "improve" anything below while touching this file — a source-level
// drift tripwire test (scripts/test-next-ingest-logic-drift.js) string-
// compares each function's source text against the copy still living in
// app.js, specifically so that a bug fixed in one frontend and not the
// other goes RED instead of silently re-shipping at cutover (the redesign's
// stated goal is porting the shipping app's proven batch-queue interaction
// design, not re-deriving it). That test ALSO independently scans this
// file's own top-level `function NAME(` declarations and asserts the set
// matches its checked-name list exactly — so adding a 14th helper here
// without also adding its name to that test's SHARED_FN_NAMES list fails
// loudly (proven live: doing exactly that for these two functions produced
// a real RED — 39 passed / 2 failed — before the test was updated). If you
// find a real bug in one of these while working on the /next port, fix it
// in src/public/app.js first (the shipping app must stay byte-untouched
// otherwise, but a genuine bug fix is exactly the kind of change that goes
// through review there), then copy the corrected function down here
// verbatim, and call it out explicitly to whoever is running the port.
//
// Deliberately NOT `export`ed at each declaration (that would NOT be
// byte-identical to the app.js originals, which are plain top-level
// function/const declarations) — every name is instead re-exported via one
// `export { ... }` statement at the bottom of this file. This keeps the
// declarations themselves diffable 1:1 against app.js.
//
// Used by views/ingest.js (imported from '../shared/ingest-queue-logic.js')
// for the Phase 2 batch queue UI.

// ── Pure helpers (extracted + unit-tested via new Function in
//    scripts/test-ingest-queue-frontend.js — keep them free of DOM/fetch
//    calls so they stay testable in a plain Node sandbox) ──────────────────

// Should the shared busy gate be entered or exited when the queue's last-
// known job status moves from `prev` to `next`? 'running' is the only
// status where the batch is actually writing to the wiki — every other
// status (pending/paused/done/cancelled/failed, and the synthetic `null`
// meaning "not attached") is not-busy. Returns 'enter' | 'exit' | null.
function queueBusyTransition(prevStatus, nextStatus) {
  const wasBusy = prevStatus === 'running';
  const isBusy = nextStatus === 'running';
  if (!wasBusy && isBusy) return 'enter';
  if (wasBusy && !isBusy) return 'exit';
  return null;
}

// Byte formatter for batch totals, which can run into the hundreds of MB
// (unlike the KB-scale formatBytes() above, used for single pages). Never
// renders NaN/undefined text — a non-finite input renders as an em dash.
function formatQueueBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)} ${units[i]}`;
}

// Pre-spend USD range formatter. Renders a real range, a single value when
// low === high, or an explicit "unknown" string — NEVER a fabricated
// number, NaN, or the literal text "undefined"/"null".
function formatUsdRange(low, high) {
  const isNum = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!isNum(low) || !isNum(high)) return 'cost unknown for this model';
  const fmt = v => `$${v > 0 && v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
  if (Math.abs(high - low) < 0.0001) return fmt(low);
  return `${fmt(low)} – ${fmt(high)}`;
}

// Same contract as formatUsdRange but for a token count range.
function formatTokenRange(low, high) {
  const isNum = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!isNum(low) || !isNum(high)) return 'unknown';
  const fmt = v => Math.round(v).toLocaleString();
  if (low === high) return fmt(low);
  return `${fmt(low)}–${fmt(high)}`;
}

// Copy table for the paused banner, keyed off job.pausedReason. Every key
// in the frozen contract is covered; an unrecognised/null reason falls back
// to a generic message rather than rendering nothing.
function pausedReasonCopy(reason) {
  const table = {
    rate_limit: {
      title: 'Paused — the AI provider rate-limited us',
      body: 'The app already retried with backoff. Nothing was lost. Wait a few minutes, then resume.',
    },
    service_unavailable: {
      title: 'Paused — the AI provider is temporarily unavailable',
      body: 'The app already retried with backoff. Nothing was lost. This is on the provider\'s side, not yours — wait a few minutes, then resume.',
    },
    budget: {
      title: 'Paused — budget cap reached',
      body: 'Raise the cap or resume without one to keep going.',
    },
    consecutive_failures: {
      title: 'Paused — 3 files failed in a row',
      body: 'Something may be systemic (a bad file type, a domain issue). Check the errors below before resuming.',
    },
    interrupted: {
      title: 'Paused — the app restarted mid-batch',
      body: 'The interrupted file will be re-run from the start. Re-ingesting is safe and idempotent — resume when ready.',
    },
    locked: {
      title: 'Paused — this domain is locked',
      body: 'Another process is writing to this domain right now. Resume once it finishes.',
    },
    user: {
      title: 'Paused',
      body: "Resume whenever you're ready.",
    },
  };
  return table[reason] || { title: 'Paused', body: "Resume whenever you're ready." };
}

// Per-item status pill label + CSS class.
// Round-4 audit item 1: a 'pending' item on a LIVE job genuinely IS
// waiting its turn — but on a TERMINAL job (done/cancelled/failed) that
// same 'pending' means "the batch ended before this file's turn came up",
// which "Waiting" misleadingly reads as "still queued, will run". The
// caller passes whether the JOB is terminal; this function never derives
// it itself, so there is exactly one isTerminal computation in this file
// (renderQueuePanel's), not two that could drift apart.
//
// Round-4 audit item 2: 'cancelled' is a new ITEM status (distinct from
// the job-level 'cancelled' status) — the file that was mid-ingest when a
// cancel was requested, interrupted at the next LLM call boundary rather
// than left to finish. It is neither a failure (nothing went wrong) nor a
// skip (it was genuinely in progress) — "Stopped" names that third thing.
function statusPillMeta(status, isTerminalJob) {
  if (status === 'pending' && isTerminalJob) {
    return { label: 'Not started', cls: 'queue-pill-notstarted' };
  }
  const table = {
    pending:   { label: 'Waiting',   cls: 'queue-pill-pending' },
    running:   { label: 'Running',   cls: 'queue-pill-running' },
    done:      { label: 'Done',      cls: 'queue-pill-done' },
    failed:    { label: 'Failed',    cls: 'queue-pill-failed' },
    skipped:   { label: 'Skipped',   cls: 'queue-pill-skipped' },
    cancelled: { label: 'Stopped',   cls: 'queue-pill-cancelled' },
  };
  return table[status] || { label: 'Waiting', cls: 'queue-pill-pending' };
}

// Resolve the ordered "files that will actually be ingested" list for the
// confirm-gate preview from the /estimate response. The frozen contract only
// pins files.rejected's shape ({name,reason}[]); files.accepted's shape is
// not further specified, so this defensively accepts an array of strings, an
// array of {name, size|bytes} objects, or — if the field is absent/not an
// array — falls back to the browser's own selection order. That fallback is
// explicitly marked `ordered:false`: it is NOT guaranteed to match the
// backend's largest-first execution order, so callers must not present it as
// authoritative.
function resolveEstimateFileList(estimate, localFiles) {
  const accepted = estimate && estimate.files && estimate.files.accepted;
  const local = Array.isArray(localFiles) ? localFiles : [];
  const sizeByName = new Map(local.map(f => [f && f.name, f && f.size]));

  if (Array.isArray(accepted)) {
    return accepted.map(entry => {
      if (typeof entry === 'string') {
        return { name: entry, bytes: sizeByName.has(entry) ? sizeByName.get(entry) : null, ordered: true };
      }
      if (entry && typeof entry === 'object') {
        const name = typeof entry.name === 'string' ? entry.name : '';
        const bytes = typeof entry.size === 'number' ? entry.size
                    : typeof entry.bytes === 'number' ? entry.bytes
                    : (sizeByName.has(name) ? sizeByName.get(name) : null);
        return { name, bytes, ordered: true };
      }
      return { name: String(entry), bytes: null, ordered: true };
    });
  }

  return local.map(f => ({ name: f && f.name, bytes: f && f.size, ordered: false }));
}

// Round-3 audit item 1: "same name AND same size is the same file" — the
// exact rule specified. Re-picking a folder the user already added files
// from (a real reported scenario) must not queue every file twice. Keeps
// FIRST occurrence order stable (matters for the "largest first" display,
// which is server-derived anyway, but also for any caller that cares about
// insertion order). Pure — takes/returns plain {name,size}-shaped objects
// (real File objects satisfy this without any special-casing), so it's
// directly unit-testable via `new Function`.
function dedupeQueueFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const seen = new Set();
  const out = [];
  for (const f of list) {
    if (!f || typeof f.name !== 'string') continue;
    const key = `${f.name}\u0000${f.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// 409 "a batch is already running" responses "name the active jobId" per the
// contract, without pinning the exact field name — defensively check the
// shapes a Node/Express JSON body would plausibly use.
function extractConflictJobId(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.jobId === 'string' && data.jobId) return data.jobId;
  if (typeof data.activeJobId === 'string' && data.activeJobId) return data.activeJobId;
  if (data.job && typeof data.job.jobId === 'string' && data.job.jobId) return data.job.jobId;
  return null;
}

// Summarise a job's Health scan counts (job.health.counts) into a short,
// human-readable line. Unknown/absent keys are silently skipped rather than
// dumped as raw JSON — this mirrors the labels already used elsewhere for
// the same counts shape (see renderHealthReport).
function formatHealthCounts(counts) {
  if (!counts || typeof counts !== 'object') return '';
  const labels = {
    brokenLinks: 'broken links', orphans: 'orphans',
    folderPrefixLinks: 'folder-prefix links', crossFolderDupes: 'cross-folder duplicates',
    hyphenVariants: 'hyphen variants', missingBacklinks: 'missing backlinks',
  };
  const parts = [];
  for (const key of Object.keys(labels)) {
    const v = counts[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) parts.push(`${v} ${labels[key]}`);
  }
  return parts.join(', ');
}

// Neutralises Unicode bidi-control codepoints (RLO/LRO/RLE/LRE/PDF/
// RLI/LRI/FSI/PDI/RLM/LRM) in a user-controlled filename before display.
// Filenames here are 100% attacker-controlled and never sanitised
// server-side; a bidi-override character can visually reorder the
// rendered text (e.g. making "evil<RLO>fdp.exe" DISPLAY as
// "evilexe.pdf") without being any kind of markup — escHtml (which only
// handles &/</>/") would pass it straight through unchanged. This is a
// display-integrity fix, not an XSS one: no auditor found an injection
// vector here, and every user-controlled string in this file's HTML
// builders already goes through escHtml.
const BIDI_CONTROL_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
function sanitizeDisplayName(str) {
  return String(str == null ? '' : str).replace(BIDI_CONTROL_RE, '\uFFFD');
}

// ── Two more, from a SEPARATE, non-contiguous range of app.js
//    (~970-1085, inside its "HTML builders" section) — added later, after
//    it turned out the shared/reimplement boundary had been drawn by LINE
//    RANGE rather than by NATURE. These two are pure logic (no markup
//    returned), same as everything above, so they belong here on the same
//    byte-identical-copy contract, not reimplemented in views/ingest.js.
//    computeQueueStatusCounts encodes the no-item-lost bucketing invariant
//    (a real v3.3.0 bug: an item could appear in NONE of the UI's buckets
//    while still showing a "Running" pill on a finished batch) — exactly
//    the kind of thing a silent second copy must never be allowed to drift
//    on. computeQueueSpentLabel looked safe to reimplement (it's four
//    lines) and technically WAS byte-different for a while — a template
//    literal in app.js vs string concatenation in the first /next port —
//    semantically identical, but that is precisely the "probably fine"
//    gap that makes REAL drift undetectable later. Fixed by copying app.js's
//    literal form, not by declaring the difference harmless.

// Buckets every item into exactly one status count. This is deliberately
// NOT "count done + count failed + count skipped" — that shape lets an
// item in ANY other state (still 'running' on a batch the server reports
// terminal, a future status, a malformed item) vanish from the summary
// with no trace: the done-summary would read "2 done, 0 failed, 0
// skipped" for a 3-item batch and the missing item would simply never be
// mentioned (H1). Because every item is placed in exactly one bucket here
// — the three known ones, or `other` keyed by its literal status string —
// `known.done + known.failed + known.skipped + sum(other values)` is
// ALWAYS === items.length, by construction, regardless of what statuses
// the server ever sends.
// Round-4 audit item 2: 'cancelled' (the new item status for a file
// interrupted mid-ingest by a real abort) joins the KNOWN set rather than
// widening the "is this accounted for" check — it is a status we now ship
// deliberately, not an unexpected one, so it must never land in the amber
// .queue-done-unaccounted bucket the way a genuinely surprising status
// would. known.done + known.failed + known.skipped + known.cancelled +
// sum(other values) is still ALWAYS === items.length, by construction.
function computeQueueStatusCounts(items) {
  const list = Array.isArray(items) ? items : [];
  const known = { done: 0, failed: 0, skipped: 0, cancelled: 0 };
  const other = {};
  for (const i of list) {
    const s = (i && typeof i.status === 'string' && i.status) ? i.status : 'unknown';
    if (Object.prototype.hasOwnProperty.call(known, s)) known[s]++;
    else other[s] = (other[s] || 0) + 1;
  }
  return { known, other, total: list.length };
}

// Round-3 audit item 4: a genuine $0.0000 read as "nothing is happening"
// while an item was actively mid-flight (his exact screenshot: "Item 1 of
// 3 · $0.0000 spent"). A TERMINAL $0 is a real, legible final tally
// (everything was skipped/cancelled before any spend) — only the
// IN-PROGRESS zero needed a different label, so isTerminal is part of the
// contract, not just spentUsd.
function computeQueueSpentLabel(spentUsd, isTerminal) {
  const spent = Number.isFinite(spentUsd) ? spentUsd : 0;
  if (spent > 0) return `$${spent.toFixed(4)} spent`;
  return isTerminal ? '$0.0000 spent' : 'spend so far: pending first file';
}

// ── Re-exports ────────────────────────────────────────────────────────
// One export statement, not per-declaration `export`, so every function
// above stays a byte-identical copy of its src/public/app.js original —
// see the file-header comment.
export {
  queueBusyTransition,
  formatQueueBytes,
  formatUsdRange,
  formatTokenRange,
  pausedReasonCopy,
  statusPillMeta,
  resolveEstimateFileList,
  dedupeQueueFiles,
  extractConflictJobId,
  formatHealthCounts,
  sanitizeDisplayName,
  computeQueueStatusCounts,
  computeQueueSpentLabel,
  BIDI_CONTROL_RE,
};
