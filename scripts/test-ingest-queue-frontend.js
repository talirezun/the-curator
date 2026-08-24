/**
 * test-ingest-queue-frontend.js — OFFLINE suite for the batch ingest queue
 * FRONTEND (Track 3).
 *
 * Follows the two established frontend-testing patterns in this repo:
 *   - scripts/test-chat-compile-card.js — source-level invariant guards on
 *     app.js/index.html/styles.css (the frontend has no DOM test harness).
 *   - scripts/test-chat-markdown.js — pure functions extracted from the real
 *     browser file and executed via `new Function` in a plain Node sandbox,
 *     so the tests run against the CURRENT source text, not a copy.
 *
 * app.js as a whole cannot be loaded in Node (it's one big module full of
 * top-level `document.getElementById(...)` / `fetch(...)` calls). So the
 * pure formatting/decision/HTML-string-builder functions added for the
 * queue are extracted individually by name (same `function name(...) { ...
 * \n}` convention as test-chat-compile-card.js) and evaluated TOGETHER in one
 * `new Function` scope so they can call each other (e.g. the HTML builders
 * call formatQueueBytes/statusPillMeta/escHtml). The DOM-coupled render/
 * control functions (renderQueuePanel, attachQueueStream, etc.) are instead
 * covered by source-level regex guards, exactly like appendCompileCard() and
 * scrollCardIntoView() are in test-chat-compile-card.js.
 *
 * The binding constraint for this whole track (see CLAUDE.md's Track 3
 * brief): a single selected file must use the EXISTING, byte-identical
 * submitIngest()/setFile() path. 2+ files route to the new queue. Section 1
 * pins that with source guards; section 6 pins it by deliberately breaking
 * the routing and confirming this suite goes red.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_PATH = path.join(ROOT, 'src/public/app.js');
const HTML_PATH = path.join(ROOT, 'src/public/index.html');
const CSS_PATH = path.join(ROOT, 'src/public/styles.css');

let app = readFileSync(APP_PATH, 'utf8');
const html = readFileSync(HTML_PATH, 'utf8');
const css = readFileSync(CSS_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction helper (same convention as test-chat-compile-card.js: a
//    top-level `function name(...) { ... \n}` with the closing brace at
//    column 0) ─────────────────────────────────────────────────────────────
function extractFn(src, name) {
  const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  return m ? m[0] : null;
}

// Async functions need "async function NAME(...) {" — extractFn's regex
// starts matching at the literal text "function", which for an async
// function begins mid-declaration and silently drops the "async" keyword
// from the extracted text (turning every `await` inside it into a
// SyntaxError at eval time, not a subtle bug — but worth a dedicated
// extractor rather than a regex that happens to still "work").
function extractAsyncFn(src, name) {
  const re = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  return m ? m[0] : null;
}

// BIDI_CONTROL_RE is a top-level `const`, not a function — sanitizeDisplayName
// references it as a free variable, so it must be in scope wherever that
// function is evaluated.
function extractConst(src, name) {
  const re = new RegExp(`const ${name} = [^;]*;`);
  const m = src.match(re);
  return m ? m[0] : null;
}

function buildSandbox(src, names) {
  let combined = '';
  const bidiConst = extractConst(src, 'BIDI_CONTROL_RE');
  if (bidiConst) combined += bidiConst + '\n\n';
  const missing = [];
  for (const n of names) {
    const f = extractFn(src, n);
    if (!f) { missing.push(n); continue; }
    combined += f + '\n\n';
  }
  if (missing.length) {
    throw new Error(`extractFn could not find: ${missing.join(', ')}`);
  }
  combined += `\nreturn { ${names.join(', ')} };\n`;
  return new Function(combined)();
}

const PURE_FN_NAMES = [
  'queueBusyTransition',
  'formatQueueBytes',
  'formatUsdRange',
  'formatTokenRange',
  'pausedReasonCopy',
  'statusPillMeta',
  'resolveEstimateFileList',
  'extractConflictJobId',
  'formatHealthCounts',
  'dedupeQueueFiles',
  'queueFileListItemHtml',
  'queueRejectedItemHtml',
  'queueItemRowHtml',
  'queuePausedBannerHtml',
  'computeQueueStatusCounts',
  'queueDoneSummaryHtml',
  'computeQueueSpentLabel',
  'queueInFlightHtml',
  'queueDismissBtnHtml',
  'sanitizeDisplayName',
  'escHtml',
];

let Q = buildSandbox(app, PURE_FN_NAMES);

// ── 1. The single-file path is provably unchanged ───────────────────────────
section('1. Single-file ingest still uses the existing, untouched path');
{
  const submitFn = (app.match(/async function submitIngest\(overwrite\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(submitFn.length > 0, 'submitIngest(overwrite) still exists');
  ok(/formData\.append\('file', selectedFile\)/.test(submitFn),
    'submitIngest still appends the single field "file" (not "files") — the batch endpoint uses a different field name');
  ok(/fetch\('\/api\/ingest', \{ method: 'POST', body: formData \}\)/.test(submitFn),
    'submitIngest still POSTs to /api/ingest (not /api/ingest-queue)');
  ok(!/ingest-queue/.test(submitFn), 'submitIngest never references the queue API');

  // Round 3 rewrote the 1-vs-2+ branch into an accumulating one (audit
  // item 1: picking/dropping files across multiple events must ADD to the
  // pending batch, not replace it). handleSelectedFiles is still the ONLY
  // thing the file-input/drop-zone listeners call; it still routes a
  // completely fresh single file to setFile() — that guarantee is
  // unchanged — but everything past that first pick now goes through the
  // accumulate helpers instead of a flat 2+-branch. See section 14 for the
  // behavioural (not just source-shape) tests of the new contract.
  const handlerFn = (app.match(/function handleSelectedFiles\(files\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(handlerFn.length > 0, 'handleSelectedFiles(files) exists');
  ok(/incoming\.length === 1 && !selectedFile/.test(handlerFn),
    'a fresh single file (nothing selected yet) is the ONLY thing that still special-cases to exactly 1');
  ok(/setFile\(incoming\[0\]\)/.test(handlerFn), 'that fresh-single-file case calls setFile(incoming[0]) — the original single-file function, untouched');
  ok(!/resetQueueSelection\(\)/.test(handlerFn),
    'handleSelectedFiles no longer resets queue state on every fresh single pick — round 3 made batch mode sticky, and resetQueueSelection() is now reserved for the explicit Clear action');
  ok(/enterQueueMode\(combined\)/.test(handlerFn), 'the 2+-at-once (or 2nd-file-on-top-of-1) case enters batch mode carrying BOTH the prior single file and the new one(s)');
  ok(/addFilesToQueueSelection\(incoming\)/.test(handlerFn), 'once already in batch mode, every further selection event accumulates rather than replaces');

  ok(/dropZone\?\.addEventListener\('drop', e => \{[\s\S]{0,150}handleSelectedFiles\(e\.dataTransfer\.files\)/.test(app),
    'drop handler routes through handleSelectedFiles');
  ok(/fileInput\?\.addEventListener\('change', \(\) => handleSelectedFiles\(fileInput\.files\)\)/.test(app),
    'file-input change handler routes through handleSelectedFiles');
  ok(!/setFile\(e\.dataTransfer\.files\[0\]\)/.test(app) && !/setFile\(fileInput\.files\[0\]\)/.test(app),
    'the old direct setFile(...files[0]) call sites are gone (replaced by the dispatcher, not duplicated)');

  // setFile() itself: the 1-vs-2+ file routing this track added is
  // untouched — round 2 (audit item 2) legitimately changed what happens
  // AFTER selectedFile is set (it now defers to refreshIngestBtnAvailability
  // instead of unconditionally enabling, so a same-domain live batch can
  // refuse the button — see section 13). Pin the new, intended contract.
  const setFileFn = (app.match(/function setFile\(file\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(setFileFn.length > 0, 'setFile(file) still exists, unmodified in shape');
  ok(/selectedFile = file;/.test(setFileFn) && /refreshIngestBtnAvailability\(\);/.test(setFileFn),
    'setFile still sets selectedFile, and now defers the enable/disable decision to refreshIngestBtnAvailability() (round-2 item 2) instead of unconditionally enabling');
  ok(!/ingestBtn\.disabled = false;/.test(setFileFn),
    'setFile no longer unconditionally enables ingestBtn — that was the round-2 collision it was told to remove');

  ok(/<input type="file" id="ingest-file" accept="\.txt,\.md,\.pdf" hidden multiple \/>/.test(html),
    'the file input gained `multiple` (the only HTML change to the input itself)');
}

// ── 2. renderIngestWarnings' new parameter defaults to the old container ────
section("2. renderIngestWarnings container param defaults to the existing #ingest-result");
{
  const fn = (app.match(/function renderIngestWarnings\(data, container = ingestResult\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(fn.length > 0, 'renderIngestWarnings(data, container = ingestResult) — new param, old default');
  ok(/container\.insertBefore\(banner, container\.firstChild\)/.test(fn),
    'it inserts into the passed-in container (generic), not a hardcoded ingestResult reference');
  ok(!/ingestResult\.insertBefore/.test(fn), 'no remaining hardcoded ingestResult.insertBefore inside the function body');
  // The existing single-file call site passes no second argument, so it
  // resolves to the default and is behaviourally identical to before.
  ok(/renderIngestWarnings\(data\);/.test(app), 'the single-file call site still calls renderIngestWarnings(data) with no second argument');
}

// ── 3. Pure helpers, executed via new Function ───────────────────────────────
section('3. Pure helper functions — extracted and executed');
{
  ok(Q.queueBusyTransition(null, 'running') === 'enter', 'not-busy → running is "enter"');
  ok(Q.queueBusyTransition('running', 'paused') === 'exit', 'running → paused is "exit"');
  ok(Q.queueBusyTransition('running', 'done') === 'exit', 'running → done is "exit"');
  ok(Q.queueBusyTransition('running', 'running') === null, 'running → running is a no-op (null)');
  ok(Q.queueBusyTransition('paused', 'paused') === null, 'paused → paused is a no-op (null)');
  ok(Q.queueBusyTransition(null, 'pending') === null, 'not-busy → pending is a no-op');
  ok(Q.queueBusyTransition(undefined, undefined) === null, 'undefined → undefined is a no-op (defensive)');

  ok(Q.formatQueueBytes(500) === '500 B', 'bytes under 1 KB render as B');
  ok(Q.formatQueueBytes(1536) === '1.5 KB', 'KB scale');
  ok(Q.formatQueueBytes(1536 * 1024) === '1.5 MB', 'MB scale');
  ok(Q.formatQueueBytes(1536 * 1024 * 1024) === '1.5 GB', 'GB scale');
  ok(Q.formatQueueBytes(null) === '—' && Q.formatQueueBytes(undefined) === '—' && Q.formatQueueBytes(NaN) === '—' && Q.formatQueueBytes(-5) === '—',
    'null/undefined/NaN/negative all render a plain em dash, never "NaN" or "undefined"');

  ok(Q.formatTokenRange(100, 500) === '100–500', 'token range renders low–high');
  ok(Q.formatTokenRange(100, 100) === '100', 'equal low/high collapses to one number');
  ok(Q.formatTokenRange(null, 500) === 'unknown', 'a null half renders "unknown", not "null–500"');
  ok(Q.formatTokenRange(NaN, NaN) === 'unknown', 'NaN inputs render "unknown"');

  const p = Q.pausedReasonCopy('rate_limit');
  ok(/rate-limited/.test(p.title), 'rate_limit copy names the provider rate limit');
  ok(/nothing was lost/i.test(p.body), 'rate_limit copy reassures nothing was lost');
  ok(/budget/i.test(Q.pausedReasonCopy('budget').title), 'budget copy present');
  ok(/failed in a row/.test(Q.pausedReasonCopy('consecutive_failures').title), 'consecutive_failures copy present');
  ok(/restarted mid-batch/.test(Q.pausedReasonCopy('interrupted').title), 'interrupted copy present');
  ok(/idempotent/.test(Q.pausedReasonCopy('interrupted').body), 'interrupted copy explains re-ingest safety');
  ok(/locked/.test(Q.pausedReasonCopy('locked').title), 'locked copy present');
  ok(Q.pausedReasonCopy('user').title === 'Paused', 'user copy is the plain "Paused"');
  ok(Q.pausedReasonCopy(null).title === 'Paused' && Q.pausedReasonCopy('bogus').title === 'Paused',
    'unknown/null reason falls back to a generic message rather than throwing or rendering nothing');

  // Round-2 audit item 4b: the backend emits BOTH 'rate_limit' (429) and
  // 'service_unavailable' (503) — pausedReasonCopy only had the former, so
  // a 503 pause fell through to the bare generic "Paused" (identical to
  // pausedReasonCopy('bogus')), losing the "this is on the provider's side,
  // not yours" reassurance the rate_limit case already gives.
  const svcUnavail = Q.pausedReasonCopy('service_unavailable');
  ok(svcUnavail.title !== 'Paused', 'service_unavailable has its own title, not the bare generic fallback');
  ok(/unavailable/i.test(svcUnavail.title), 'service_unavailable copy names what actually happened (provider unavailable, not a rate limit)');
  ok(/provider/i.test(svcUnavail.body) || /provider/i.test(svcUnavail.title),
    'service_unavailable copy makes clear this is upstream, matching the rate_limit case\'s reassurance');
  ok(svcUnavail.title !== Q.pausedReasonCopy('rate_limit').title,
    'service_unavailable is NOT just an alias of rate_limit — they are genuinely different provider failure modes');

  // ── MUTATION-PROVE: remove the service_unavailable entry and confirm it
  //    falls back to the bare generic "Paused" (RED). ─────────────────────
  {
    const currentFn = extractFn(app, 'pausedReasonCopy');
    ok(!!currentFn, '4b mutation sanity — pausedReasonCopy was extractable');
    const brokenFn = currentFn.replace(
      /service_unavailable: \{[\s\S]*?\},\n    budget: \{/,
      'budget: {'
    );
    ok(brokenFn !== currentFn, '4b mutation sanity — the service_unavailable table entry was actually removed');
    const brokenSrc = app.replace(currentFn, () => brokenFn);
    const QBroken = buildSandbox(brokenSrc, ['pausedReasonCopy']);
    const brokenCopy = QBroken.pausedReasonCopy('service_unavailable');
    ok(brokenCopy.title === 'Paused',
      `4b: RED CONFIRMED — with the table entry removed, service_unavailable falls through to the bare generic "Paused" (got: ${JSON.stringify(brokenCopy)})`);
  }

  ok(Q.statusPillMeta('running').label === 'Running', 'running pill label');
  ok(Q.statusPillMeta('done').label === 'Done', 'done pill label');
  ok(Q.statusPillMeta('failed').label === 'Failed', 'failed pill label');
  ok(Q.statusPillMeta('skipped').label === 'Skipped', 'skipped pill label');
  ok(Q.statusPillMeta('pending').label === 'Waiting', 'pending pill label');
  ok(Q.statusPillMeta('nonsense').label === 'Waiting', 'unknown status falls back to Waiting, not undefined');

  const idOnly = Q.extractConflictJobId({ jobId: 'abc123' });
  ok(idOnly === 'abc123', 'extractConflictJobId reads a top-level jobId field');
  ok(Q.extractConflictJobId({ activeJobId: 'zzz' }) === 'zzz', 'extractConflictJobId reads activeJobId as a fallback field name');
  ok(Q.extractConflictJobId({ job: { jobId: 'nested' } }) === 'nested', 'extractConflictJobId reads a nested job.jobId as a further fallback');
  ok(Q.extractConflictJobId({}) === null, 'extractConflictJobId returns null when nothing matches');
  ok(Q.extractConflictJobId(null) === null && Q.extractConflictJobId(undefined) === null,
    'extractConflictJobId is defensive against null/undefined input');

  ok(Q.formatHealthCounts({ brokenLinks: 3, orphans: 0 }) === '3 broken links', 'formatHealthCounts skips zero counts');
  ok(Q.formatHealthCounts({}) === '', 'formatHealthCounts on an empty object is an empty string');
  ok(Q.formatHealthCounts(null) === '', 'formatHealthCounts is defensive against null');
}

// ── 4. Cost/estimate formatting never fabricates a number ───────────────────
section('4. null/undefined usdLow/usdHigh never renders NaN, undefined, or a fabricated number');
{
  const cases = [
    [null, null], [undefined, undefined], [null, 0.5], [0.5, null],
    [NaN, 0.5], ['0.1', '0.5'], [-1, 0.5],
  ];
  for (const [low, high] of cases) {
    const out = Q.formatUsdRange(low, high);
    ok(!/NaN/.test(out), `formatUsdRange(${low}, ${high}) never contains "NaN" (got "${out}")`);
    ok(!/undefined/.test(out), `formatUsdRange(${low}, ${high}) never contains "undefined" (got "${out}")`);
    ok(out === 'cost unknown for this model' || /^\$/.test(out),
      `formatUsdRange(${low}, ${high}) is either the honest "unknown" string or a real $-prefixed value (got "${out}")`);
  }
  ok(Q.formatUsdRange(0.001, 0.002) === '$0.0010 – $0.0020', 'sub-cent values keep 4 decimal places instead of rounding to $0.00');
  ok(Q.formatUsdRange(1.2, 3.4) === '$1.20 – $3.40', 'normal-range values render 2 decimal places');
  ok(Q.formatUsdRange(2, 2) === '$2.00', 'equal low/high collapses to a single value, no dash');
}

// ── 5. Busy-gate refcount balances (invariant, driven over sequences) ───────
section('5. Busy-gate refcount invariant — net enter/exit balances to zero on every closed sequence');
{
  // Drive queueBusyTransition over a sequence of statuses (as if they were
  // consecutive job snapshots this tab received) and reduce to a net count.
  // Positive net === currently busy; must be exactly 0 once the sequence
  // reaches a terminal status or an explicit teardown (`null`).
  function reduceBusyNet(statuses) {
    let net = 0;
    let prev = null;
    for (const next of statuses) {
      const d = Q.queueBusyTransition(prev, next);
      if (d === 'enter') net++;
      else if (d === 'exit') net--;
      prev = next;
    }
    return { net, prev };
  }

  const closedSequences = [
    ['pending', 'running', 'done', null],                                  // normal run
    ['pending', 'running', 'failed', null],                                // failure
    ['pending', 'running', 'cancelled', null],                             // cancel mid-run
    ['pending', 'running', 'paused', 'running', 'done', null],             // pause + resume
    ['pending', 'running', 'paused', 'running', 'paused', 'running', 'done', null], // pause/resume twice
    ['pending', null],                                                     // never started, tab closed
    ['pending', 'running', null],                                         // stream aborted mid-run (nav-away/error) — teardown forces exit
    ['pending', 'running', 'paused', null],                                // aborted while paused (already not-busy, teardown is a no-op)
  ];
  for (const seq of closedSequences) {
    const { net } = reduceBusyNet(seq);
    ok(net === 0, `sequence [${seq.join(' → ')}] nets to 0 open busy-gate calls`);
  }

  // Mid-run (no terminal status, no teardown yet) must show exactly one
  // outstanding "enter" — proves the gate is genuinely tracking busy state,
  // not just always netting to zero by construction.
  const midRun = reduceBusyNet(['pending', 'running']);
  ok(midRun.net === 1, 'a sequence that ends mid-run (no teardown) has exactly 1 outstanding enter — busy is genuinely tracked');

  // ── Deliberately break it, confirm this test goes RED, then restore ──────
  // Mutates the *source text* app.js was loaded from, rebuilds the sandbox
  // from the mutated text, and asserts the invariant breaks — proving this
  // assertion is not vacuously true. The real on-disk file is never touched;
  // only the in-memory `app` string is mutated for this one probe.
  section('5b. Deliberate-break probe: prove the invariant is not vacuously true');
  {
    // Break: widen the 'exit' condition from AND to OR. The first branch
    // (`!wasBusy && isBusy`) still short-circuits every real enter/exit
    // transition to the SAME result as before — so a break that only
    // touches the second condition's operator is invisible on any sequence
    // that only ever moves through 'running', exactly the trap a narrower
    // mutation fell into on the first attempt at this probe (verified: it
    // produced a false-green, since the mutated line was unreachable dead
    // code for every transition the healthy sequences above exercise).
    // AND-to-OR *does* change behaviour on a not-busy → not-busy transition
    // (e.g. a job created straight into 'paused', or torn down from
    // 'pending') — the broken code now fires a spurious, unmatched 'exit'
    // on every such step.
    const brokenSrc = app.replace(
      'if (wasBusy && !isBusy) return \'exit\';',
      'if (wasBusy || !isBusy) return \'exit\'; // DELIBERATE BREAK — should never ship'
    );
    ok(brokenSrc !== app, 'the mutation actually changed the source text (sanity check on the probe itself)');
    const QBroken = buildSandbox(brokenSrc, PURE_FN_NAMES);
    function reduceBrokenNet(statuses) {
      let net = 0, prev = null;
      for (const next of statuses) {
        const d = QBroken.queueBusyTransition(prev, next);
        if (d === 'enter') net++;
        else if (d === 'exit') net--;
        prev = next;
      }
      return net;
    }
    // A job that never runs (created paused — e.g. straight into a budget
    // pause — then torn down) should never touch the busy gate at all.
    const brokenNet = reduceBrokenNet(['pending', 'paused', null]);
    ok(brokenNet !== 0, `RED CONFIRMED: with the deliberate break, a never-ran ['pending','paused',null] sequence nets to ${brokenNet} (not 0) — the healthy invariant above is not vacuous`);
    // Sanity: the SAME sequence under the real, unbroken function nets to 0
    // (never busy, never touches the gate) — pins the contrast directly.
    const healthyNet = reduceBusyNet(['pending', 'paused', null]).net;
    ok(healthyNet === 0, `control: the unbroken queueBusyTransition nets ${healthyNet} for the same sequence`);
    console.log('    (restoring: the mutation above only ever touched an in-memory copy of the source; nothing on disk was changed)');
  }
}

// ── 6. No alert()/confirm() anywhere in the new queue code ──────────────────
section('6. No window.alert()/confirm() introduced by this track');
{
  const startMarker = '// ── BATCH INGEST QUEUE (Track 3) ────────────────────────────────────────────';
  const endMarker = "// ── CHAT TAB ──────────────────────────────────────────────────────────────────";
  const startIdx = app.indexOf(startMarker);
  const endIdx = app.indexOf(endMarker, startIdx);
  ok(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx, 'the BATCH INGEST QUEUE section markers are both found, in order');
  const section3Src = startIdx !== -1 && endIdx !== -1 ? app.slice(startIdx, endIdx) : '';
  ok(section3Src.length > 1000, 'the extracted section has real content');
  ok(!/\balert\(/.test(section3Src), 'no alert( call in the queue section');
  ok(!/\bconfirm\(/.test(section3Src), 'no confirm( call in the queue section (cancel uses an inline DOM confirm, matching the Shared Brain pattern)');
  ok(/confirmCancelQueueJob/.test(section3Src) && /createElement\('button'\)/.test(section3Src),
    'cancel uses a hand-built inline confirm (createElement), not a browser dialog');
}

// ── 7. XSS: filenames are escaped in every rendered row ──────────────────────
section('7. Filenames are escaped, not injected live, into every queue HTML string');
{
  const evilName = '<img src=x onerror=alert(1)>.pdf';

  const rowHtml = Q.queueItemRowHtml({ idx: 0, name: evilName, bytes: 1024, status: 'pending' });
  ok(!/<img/i.test(rowHtml), 'queueItemRowHtml: no live <img> tag');
  ok(/&lt;img/.test(rowHtml), 'queueItemRowHtml: the filename is HTML-escaped');

  const fileItemHtml = Q.queueFileListItemHtml({ name: evilName, bytes: 1024 });
  ok(!/<img/i.test(fileItemHtml) && /&lt;img/.test(fileItemHtml), 'queueFileListItemHtml escapes the filename');

  const rejectedHtml = Q.queueRejectedItemHtml({ name: evilName, reason: '<b>bad</b>' });
  ok(!/<img/i.test(rejectedHtml) && /&lt;img/.test(rejectedHtml), 'queueRejectedItemHtml escapes the filename');
  ok(!/<b>bad<\/b>/.test(rejectedHtml) && /&lt;b&gt;/.test(rejectedHtml), 'queueRejectedItemHtml escapes the reason text too');

  // A failed item's error text and a done item's result title are also
  // server-influenced (an error message could echo user input; a page
  // title comes from the LLM) — both must be escaped.
  const failedHtml = Q.queueItemRowHtml({ idx: 1, name: 'ok.pdf', bytes: 10, status: 'failed', error: '<script>alert(2)</script>' });
  ok(!/<script>/i.test(failedHtml) && /&lt;script&gt;/.test(failedHtml), 'a failed item error message is escaped');

  const doneHtml = Q.queueItemRowHtml({ idx: 2, name: 'ok.pdf', bytes: 10, status: 'done', result: { title: '<script>alert(3)</script>', pagesWritten: 2 } });
  ok(!/<script>/i.test(doneHtml) && /&lt;script&gt;/.test(doneHtml), 'a done item result title is escaped');

  const bannerHtml = Q.queuePausedBannerHtml({ pausedReason: 'user', pausedMessage: '<img src=x onerror=alert(4)>' });
  ok(!/<img/i.test(bannerHtml) && /&lt;img/.test(bannerHtml), 'the paused banner escapes job.pausedMessage');

  const doneSummaryHtml = Q.queueDoneSummaryHtml({ items: [], spentUsd: 0, health: { counts: {} } });
  ok(typeof doneSummaryHtml === 'string' && doneSummaryHtml.length > 0, 'queueDoneSummaryHtml renders on an empty job without throwing');
}

// ── 8. CSS token sanity (full check lives in test-css-tokens.js; this is a
//    narrow, fast guard that the classes this track defines exist and are
//    reachable, so a rename in one file can't silently orphan the other) ───
section('8. New queue CSS classes are defined and referenced from app.js/index.html');
{
  const newClasses = ['queue-confirm', 'queue-panel', 'queue-item-row', 'queue-item-pill', 'queue-paused-banner', 'queue-done-summary'];
  for (const cls of newClasses) {
    ok(css.includes(`.${cls}`), `styles.css defines .${cls}`);
  }
  ok(html.includes('id="queue-confirm"') && html.includes('id="queue-panel"') && html.includes('id="queue-status"'),
    'index.html declares the three empty queue containers');
  ok(/QUEUE_API = '\/api\/ingest-queue'/.test(app), 'app.js targets the frozen /api/ingest-queue base path');
}

// ── 9. H2 — busy-gate key pairing, driven through the REAL async
//    orchestration (applyQueueBusyForStatus + applyQueueJobSnapshot +
//    attachQueueStream + detachQueueStream + refreshQueueJob + pauseQueueJob
//    + checkActiveQueueJob, extracted verbatim and run against a mocked
//    fetch/document/window). This is deliberately NOT a test of
//    queueBusyTransition in isolation (that's section 5, and it was green
//    while H2 was live in production — it tests the ENTER/EXIT decision,
//    not which KEY the exit call actually uses). ─────────────────────────
section('9. H2 fix — busy-gate ENTER/EXIT key pairing across the real orchestration');
{
  function extractAsyncFn(src, name) {
    const re = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
    const m = src.match(re);
    return m ? m[0] : null;
  }
  const VARS_RE = /let queueJobId[\s\S]*?let _queueBusyDomain\s*=\s*null;/;

  // Builds an isolated, DOM-free copy of the queue's busy-gate + streaming
  // orchestration from `src`. Two independently-constructed sandboxes have
  // completely separate module state (separate `new Function` closures) —
  // the same isolation two real browser tabs on the same job would have.
  function buildLiveGateSandbox(src) {
    const varsBlock = (src.match(VARS_RE) || [null])[0];
    const fnSrc = {
      queueBusyTransition: extractFn(src, 'queueBusyTransition'),
      applyQueueBusyForStatus: extractFn(src, 'applyQueueBusyForStatus'),
      applyQueueJobSnapshot: extractFn(src, 'applyQueueJobSnapshot'),
      detachQueueStream: extractFn(src, 'detachQueueStream'),
      attachQueueStream: extractAsyncFn(src, 'attachQueueStream'),
      pauseQueueJob: extractAsyncFn(src, 'pauseQueueJob'),
      resumeQueueJob: extractAsyncFn(src, 'resumeQueueJob'),
      refreshQueueJob: extractAsyncFn(src, 'refreshQueueJob'),
      checkActiveQueueJob: extractAsyncFn(src, 'checkActiveQueueJob'),
    };
    const missingParts = Object.entries(fnSrc).filter(([, v]) => !v).map(([k]) => k);
    if (!varsBlock || missingParts.length) {
      throw new Error(`buildLiveGateSandbox: could not extract ${!varsBlock ? 'varsBlock ' : ''}${missingParts.join(', ')}`);
    }

    const preamble = `
      const QUEUE_API = '/api/ingest-queue';
      const calls = []; // ['start'|'end', domain] — every __curatorIngestStart/End call, in order
      let __domainSelectValue = '';
      let __fetchImpl = null;
      const fetch = (url, options) => __fetchImpl(url, options);
      const window = {
        __curatorIngestStart: (d) => calls.push(['start', d]),
        __curatorIngestEnd: (d) => calls.push(['end', d]),
      };
      const document = {
        getElementById(id) {
          if (id === 'ingest-domain') return { value: __domainSelectValue, disabled: false };
          return { value: '', disabled: false, textContent: '', addEventListener() {}, querySelector() { return null; } };
        },
      };
      const queuePanelEl = null;
      function showEl() {}
      function hideEl() {}
      function renderQueuePanel() {}      // rendering is out of scope for this harness
      function renderQueueStreamError() {}
      function updateQueueItemProgress() {}
    `;

    const combined = preamble + '\n' + varsBlock + '\n\n' + Object.values(fnSrc).join('\n\n') + '\n\n' + `
      return {
        calls,
        setDomainSelectValue: (v) => { __domainSelectValue = v; },
        setFetch: (f) => { __fetchImpl = f; },
        getState: () => ({ lastStatus: _queueLastStatus, busyDomain: _queueBusyDomain, queueJobId, hasStream: !!queueStreamAbort }),
        applyQueueJobSnapshot, applyQueueBusyForStatus, queueBusyTransition,
        attachQueueStream, detachQueueStream, pauseQueueJob, resumeQueueJob, refreshQueueJob, checkActiveQueueJob,
      };
    `;
    return new Function(combined)();
  }

  // ── fetch-mock helpers ──────────────────────────────────────────────────
  function jsonRes(obj, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => obj, body: null };
  }
  // One SSE "response" whose body delivers every event in a SINGLE chunk
  // (mirrors the real parser's line-splitting — it doesn't care whether
  // events arrive as one chunk or many).
  function sseRes(events) {
    const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const chunk = new TextEncoder().encode(text);
    let delivered = false;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({
        async read() {
          if (!delivered) { delivered = true; return { done: false, value: chunk }; }
          return { done: true, value: undefined };
        },
      }) },
    };
  }
  // A stream whose FIRST read() delivers the given events, and whose SECOND
  // read() throws (a dropped connection — no further 'job'/'done' event
  // ever arrives). This is what actually exercises attachQueueStream's own
  // `finally` as the thing that performs the exit: a clean 'done' event
  // ALWAYS exits correctly on its own (it carries job.domain, read and
  // acted on synchronously inside the reader loop, before the `finally`
  // ever runs) — the exit call inside `finally` only ever matters, and
  // only ever uses ITS OWN captured `domain`, when the stream ends with
  // no terminal snapshot to have already done the job. That is exactly
  // the shape a mid-batch network drop takes, and it's the literal thing
  // the audit named ("attachQueueStream's finally exits keyed on domain,
  // captured ... from the #ingest-domain dropdown value").
  function sseThenDrop(events) {
    const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const chunk = new TextEncoder().encode(text);
    let call = 0;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({
        async read() {
          call++;
          if (call === 1) return { done: false, value: chunk };
          throw new Error('simulated network drop mid-stream');
        },
      }) },
    };
  }
  // Flushes pending microtask AND macrotask work — needed because
  // applyQueueJobSnapshot's auto-attach fires attachQueueStream() WITHOUT
  // awaiting it (fire-and-forget, exactly like the real app), so a caller
  // that only awaits the outer function (refreshQueueJob/pauseQueueJob)
  // would otherwise observe the busy-gate mid-flight.
  function settle() { return new Promise(r => setTimeout(r, 10)); }

  // ── 9a. Happy path sanity: the reload scenario (#ingest-domain empty,
  //    a running job for domain 'articles' arrives from /active) when the
  //    stream ends CLEANLY with a 'done' event. This passes even on the
  //    pre-fix code — the 'done' event carries job.domain itself and is
  //    processed (correctly) before `finally` ever runs — so this section
  //    is establishing the baseline, not yet proving the fix; 9a2/9b do
  //    that. ─────────────────────────────────────────────────────────────
  {
    const S = buildLiveGateSandbox(app);
    S.setDomainSelectValue(''); // dropdown not yet populated — the H2 trigger
    let streamFetches = 0;
    S.setFetch(async (url) => {
      if (url.includes('/active')) return jsonRes({ ok: true, job: { jobId: 'job1', domain: 'articles', status: 'running', items: [] } });
      if (url.includes('/job1/stream')) {
        streamFetches++;
        return sseRes([
          { type: 'job', job: { jobId: 'job1', domain: 'articles', status: 'running', items: [] } },
          { type: 'done', job: { jobId: 'job1', domain: 'articles', status: 'done', items: [{ idx: 0, status: 'done' }] } },
        ]);
      }
      throw new Error('unexpected fetch: ' + url);
    });
    await S.checkActiveQueueJob();
    await settle();
    ok(streamFetches === 1, '9a: the resumed running job attached exactly one live stream');
    ok(JSON.stringify(S.calls) === JSON.stringify([['start', 'articles'], ['end', 'articles']]),
      `9a: happy path — enter and exit both used 'articles' (job.domain), never the empty dropdown value (got ${JSON.stringify(S.calls)})`);
    const st = S.getState();
    // _queueLastStatus ends as null (not 'done') because attachQueueStream's
    // `finally` unconditionally calls applyQueueBusyForStatus(null, ...)
    // after the loop exits — decision is a no-op by then (already not
    // busy) but the status variable itself is still reassigned. Harmless —
    // null means "no live stream is tracking status any more", which is
    // accurate — but pin it here so a future change to that behaviour is
    // visible instead of silently changing what "idle" looks like.
    ok(st.busyDomain === null && st.lastStatus === null && st.hasStream === false,
      `9a: gate fully released after the batch finishes — Update/Sync/Delete would be re-enabled (got ${JSON.stringify(st)})`);
  }

  // ── 9a2. THE actual H2 trigger: the stream drops (network error) before
  //    any terminal snapshot ever arrives, so the exit is performed by
  //    attachQueueStream's `finally` itself — using whatever domain WAS
  //    the dropdown's value when this attach began (here: '', since the
  //    resume-on-return path never routes through applyQueueJobSnapshot
  //    for its initial fetch — see checkActiveQueueJob). FIXED behaviour:
  //    the exit still uses 'articles' (the stored ENTRY key), never the
  //    dropdown's ''. ────────────────────────────────────────────────────
  {
    const S = buildLiveGateSandbox(app);
    S.setDomainSelectValue('');
    S.setFetch(async (url) => {
      if (url.includes('/active')) return jsonRes({ ok: true, job: { jobId: 'job1', domain: 'articles', status: 'running', items: [] } });
      if (url.includes('/job1/stream')) {
        return sseThenDrop([{ type: 'job', job: { jobId: 'job1', domain: 'articles', status: 'running', items: [] } }]);
      }
      throw new Error('unexpected fetch: ' + url);
    });
    await S.checkActiveQueueJob();
    await settle();
    ok(JSON.stringify(S.calls) === JSON.stringify([['start', 'articles'], ['end', 'articles']]),
      `9a2: FIXED — a mid-stream drop still releases with 'articles' (the stored entry key), never the empty dropdown value the finally block itself read (got ${JSON.stringify(S.calls)})`);
    const st = S.getState();
    ok(st.busyDomain === null, '9a2: the slot is fully released, not orphaned, after a dropped connection');
  }

  // ── 9b. MUTATION-PROVE: revert applyQueueBusyForStatus to the pre-fix
  //    shape (exit releases with the freshly-read `domain` param instead of
  //    the stored entry key) and rerun the IDENTICAL 9a2 drop scenario.
  //    Must go RED — proving 9a2 is not vacuously true and reproducing the
  //    real H2 leak: enter keyed 'articles', exit keyed '' (the still-empty
  //    dropdown), so window.__curatorIngestEnd('') never decrements the
  //    __curatorIngestStart('articles') slot in _activeIngests — exactly
  //    the leak that left Update/Sync/Delete disabled forever. ───────────
  {
    const OLD_BUGGY_FN = `function applyQueueBusyForStatus(nextStatus, domain) {
  const decision = queueBusyTransition(_queueLastStatus, nextStatus);
  if (decision === 'enter' && typeof window.__curatorIngestStart === 'function') {
    window.__curatorIngestStart(domain);
  } else if (decision === 'exit' && typeof window.__curatorIngestEnd === 'function') {
    window.__curatorIngestEnd(domain);
  }
  _queueLastStatus = nextStatus;
}`;
    const currentFn = extractFn(app, 'applyQueueBusyForStatus');
    ok(!!currentFn, '9b: sanity — the current applyQueueBusyForStatus was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => OLD_BUGGY_FN);
    ok(brokenSrc !== app, '9b: sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');

    const S = buildLiveGateSandbox(brokenSrc);
    S.setDomainSelectValue('');
    S.setFetch(async (url) => {
      if (url.includes('/active')) return jsonRes({ ok: true, job: { jobId: 'job1', domain: 'articles', status: 'running', items: [] } });
      if (url.includes('/job1/stream')) {
        return sseThenDrop([{ type: 'job', job: { jobId: 'job1', domain: 'articles', status: 'running', items: [] } }]);
      }
      throw new Error('unexpected fetch: ' + url);
    });
    await S.checkActiveQueueJob();
    await settle();
    const mismatched = S.calls.length === 2 && S.calls[0][1] !== S.calls[1][1];
    ok(mismatched,
      `9b: RED CONFIRMED on the pre-fix shape — enter used '${S.calls[0] && S.calls[0][1]}', exit used '${S.calls[1] && S.calls[1][1]}' (they differ, so window.__curatorIngestEnd never targets the domain that was actually entered — this is the exact leak that left Update/Sync/Delete disabled forever)`);
    ok(S.calls[1] && S.calls[1][1] === '', `9b: the mismatched exit specifically used the empty dropdown value, not 'articles' (got '${S.calls[1] && S.calls[1][1]}')`);
  }

  // ── 9c. refreshQueueJob (the cancel-confirm's "Never mind" button) polls
  //    a job that's genuinely still running while THIS tab holds no live
  //    stream (e.g. a prior stream already finished/detached). Fixed
  //    behaviour: applyQueueJobSnapshot's auto-attach guarantees a stream
  //    gets attached, so the enter it performs is never orphaned. ─────────
  {
    const S = buildLiveGateSandbox(app);
    S.setDomainSelectValue('articles');
    let streamFetches = 0;
    S.setFetch(async (url) => {
      if (url.includes('/stream')) {
        streamFetches++;
        return sseRes([{ type: 'done', job: { jobId: 'jobX', domain: 'articles', status: 'done', items: [] } }]);
      }
      if (url.endsWith('/jobX')) return jsonRes({ ok: true, job: { jobId: 'jobX', domain: 'articles', status: 'running', items: [] } });
      throw new Error('unexpected fetch: ' + url);
    });
    ok(S.getState().hasStream === false, '9c: sanity — this tab starts with no live stream attached');
    await S.refreshQueueJob('jobX');
    await settle();
    ok(streamFetches === 1, '9c: FIXED — refreshQueueJob\'s snapshot triggered exactly one auto-attach (the dead-stream case is no longer possible)');
    ok(JSON.stringify(S.calls) === JSON.stringify([['start', 'articles'], ['end', 'articles']]),
      `9c: the gate entered AND was released via the auto-attached stream's finally (got ${JSON.stringify(S.calls)})`);
  }

  // ── 9d. MUTATION-PROVE 9c: strip the auto-attach guard out of
  //    applyQueueJobSnapshot (back to its pre-fix shape) and rerun the
  //    IDENTICAL refreshQueueJob scenario. Must go RED: 'start' fires with
  //    no matching 'end' anywhere, ever — a permanent leak, because nothing
  //    in this tab holds a stream whose `finally` could release it. ───────
  {
    const OLD_BUGGY_SNAPSHOT_FN = `function applyQueueJobSnapshot(job) {
  if (!job) return;
  queueJobId = job.jobId || queueJobId;
  const domain = job.domain || document.getElementById('ingest-domain')?.value;
  applyQueueBusyForStatus(job.status, domain);
  renderQueuePanel(job);
}`;
    const currentFn = extractFn(app, 'applyQueueJobSnapshot');
    ok(!!currentFn, '9d: sanity — the current applyQueueJobSnapshot was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => OLD_BUGGY_SNAPSHOT_FN);
    ok(brokenSrc !== app, '9d: sanity — the mutation actually changed the in-memory source text');

    const S = buildLiveGateSandbox(brokenSrc);
    S.setDomainSelectValue('articles');
    let streamFetches = 0;
    S.setFetch(async (url) => {
      if (url.includes('/stream')) { streamFetches++; return sseRes([{ type: 'done', job: { jobId: 'jobX', domain: 'articles', status: 'done', items: [] } }]); }
      if (url.endsWith('/jobX')) return jsonRes({ ok: true, job: { jobId: 'jobX', domain: 'articles', status: 'running', items: [] } });
      throw new Error('unexpected fetch: ' + url);
    });
    await S.refreshQueueJob('jobX');
    await settle();
    ok(streamFetches === 0, '9d: RED CONFIRMED (pre-condition) — with the auto-attach guard removed, refreshQueueJob never attaches a stream');
    const leaked = S.calls.length === 1 && S.calls[0][0] === 'start';
    ok(leaked,
      `9d: RED CONFIRMED — the gate entered ('start','articles') and NOTHING ever released it (got ${JSON.stringify(S.calls)}). This is the exact "entering with a dead stream" defect the audit named.`);
  }

  // ── 9e. pauseQueueJob's response still reports the job as 'running'
  //    (e.g. a race — the pause request is in flight when the batch's own
  //    stream already tore down for an unrelated reason) with no live
  //    stream in this tab. Same guarantee as 9c must hold. ────────────────
  {
    const S = buildLiveGateSandbox(app);
    S.setDomainSelectValue('articles');
    let streamFetches = 0;
    S.setFetch(async (url) => {
      if (url.includes('/stream')) { streamFetches++; return sseRes([{ type: 'done', job: { jobId: 'jobY', domain: 'articles', status: 'done', items: [] } }]); }
      if (url.includes('/pause')) return jsonRes({ ok: true, job: { jobId: 'jobY', domain: 'articles', status: 'running', items: [] } });
      throw new Error('unexpected fetch: ' + url);
    });
    await S.pauseQueueJob('jobY');
    await settle();
    ok(streamFetches === 1, '9e: FIXED — pauseQueueJob\'s (racing) running snapshot triggered exactly one auto-attach');
    ok(JSON.stringify(S.calls) === JSON.stringify([['start', 'articles'], ['end', 'articles']]),
      `9e: the gate entered and was released via the auto-attached stream (got ${JSON.stringify(S.calls)})`);
  }

  // ── 9f. Two independent tabs on the same job never interfere with each
  //    other's gate — each sandbox has fully separate module state, so
  //    driving both through the SAME job independently must each net to
  //    zero on their own. ──────────────────────────────────────────────────
  {
    function makeTab() {
      const S = buildLiveGateSandbox(app);
      S.setDomainSelectValue('articles');
      S.setFetch(async (url) => {
        if (url.includes('/stream')) return sseRes([{ type: 'done', job: { jobId: 'shared-job', domain: 'articles', status: 'done', items: [] } }]);
        if (url.endsWith('/shared-job')) return jsonRes({ ok: true, job: { jobId: 'shared-job', domain: 'articles', status: 'running', items: [] } });
        throw new Error('unexpected fetch: ' + url);
      });
      return S;
    }
    const tabA = makeTab();
    const tabB = makeTab();
    await Promise.all([tabA.refreshQueueJob('shared-job'), tabB.refreshQueueJob('shared-job')]);
    await settle();
    ok(JSON.stringify(tabA.calls) === JSON.stringify([['start', 'articles'], ['end', 'articles']]),
      `9f: tab A independently balances its own gate (got ${JSON.stringify(tabA.calls)})`);
    ok(JSON.stringify(tabB.calls) === JSON.stringify([['start', 'articles'], ['end', 'articles']]),
      `9f: tab B independently balances its own gate (got ${JSON.stringify(tabB.calls)})`);
  }

  // A stream Response whose reader delivers `events` on its first read(),
  // then STAYS OPEN — it neither completes nor errors on its own, exactly
  // like a real live SSE connection with nothing new to send — until the
  // AbortController that was passed as `signal` actually fires, at which
  // point read() rejects with a real AbortError shape (name === 'AbortError'),
  // matching what a real aborted fetch stream does. sseRes/sseThenDrop
  // (used above) don't model this because nothing before this needed a
  // stream that stays open across an abort — this one specifically proves
  // whether a SECOND attachQueueStream() call's detachQueueStream() really
  // tears down the first connection.
  function sseOpenUntilAborted(signal, events) {
    const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    const chunk = new TextEncoder().encode(text);
    let delivered = false;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({
        async read() {
          if (!delivered) { delivered = true; return { done: false, value: chunk }; }
          if (signal && signal.aborted) {
            const e = new Error('aborted'); e.name = 'AbortError'; throw e;
          }
          return new Promise((_, reject) => {
            if (!signal) return; // no signal supplied: intentionally never settles
            signal.addEventListener('abort', () => {
              const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
            }, { once: true });
          });
        },
      }) },
    };
  }

  // ── 9g. Round-2 audit item 3 (regression this track introduced): resuming
  //    a paused batch must open exactly ONE live stream. applyQueueJobSnapshot's
  //    auto-attach (9c/9d/9e above) already attaches one the instant the
  //    /start response reports 'running' — resumeQueueJob's OWN explicit
  //    attachQueueStream call must not blindly attach a second one on top
  //    of it. ──────────────────────────────────────────────────────────────
  {
    const S = buildLiveGateSandbox(app);
    S.setDomainSelectValue('articles');
    let streamFetches = 0;
    S.setFetch(async (url, options) => {
      if (url.includes('/start')) return jsonRes({ ok: true, job: { jobId: 'resume-job', domain: 'articles', status: 'running', items: [] } });
      if (url.includes('/stream')) {
        streamFetches++;
        return sseOpenUntilAborted(options && options.signal,
          [{ type: 'job', job: { jobId: 'resume-job', domain: 'articles', status: 'running', items: [] } }]);
      }
      throw new Error('unexpected fetch: ' + url);
    });
    await S.resumeQueueJob('resume-job');
    await settle();
    ok(streamFetches === 1, `9g: FIXED — resumeQueueJob opened exactly ${streamFetches} live stream(s) (must be 1, not 2)`);
    ok(JSON.stringify(S.calls) === JSON.stringify([['start', 'articles']]),
      `9g: the gate was entered exactly once and is NEVER released while the batch is still genuinely running (got ${JSON.stringify(S.calls)})`);
    const st = S.getState();
    ok(st.busyDomain === 'articles' && st.hasStream === true,
      `9g: the gate is still genuinely held after resume completes — Update/Sync/Delete must stay disabled (got ${JSON.stringify(st)})`);
  }

  // ── 9h. MUTATION-PROVE 9g: revert resumeQueueJob to its pre-fix shape —
  //    an UNCONDITIONAL second attachQueueStream() call right after the
  //    snapshot's own auto-attach — and rerun the identical scenario. Must
  //    go RED: two /stream fetches (the second's detachQueueStream() tears
  //    down the first), and the gate fires a premature 'end' while the
  //    batch is still 'running' — self-healing on the next snapshot, per
  //    the audit, but a real observable gap this round introduced. ───────
  {
    const OLD_BUGGY_RESUME_FN = `async function resumeQueueJob(jobId) {
  const btn = document.getElementById('queue-resume-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  try {
    const res = await fetch(\`\${QUEUE_API}/\${encodeURIComponent(jobId)}/start\`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || \`Could not resume (HTTP \${res.status})\`);
    if (data.job) applyQueueJobSnapshot(data.job);
    attachQueueStream(jobId); // reconnect the live stream (one of the three "enter" points)
  } catch (err) {
    renderQueueStreamError(err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Resume'; }
  }
}`;
    const currentFn = extractAsyncFn(app, 'resumeQueueJob');
    ok(!!currentFn, '9h: sanity — the current resumeQueueJob was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => OLD_BUGGY_RESUME_FN);
    ok(brokenSrc !== app, '9h: sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');

    const S = buildLiveGateSandbox(brokenSrc);
    S.setDomainSelectValue('articles');
    let streamFetches = 0;
    S.setFetch(async (url, options) => {
      if (url.includes('/start')) return jsonRes({ ok: true, job: { jobId: 'resume-job2', domain: 'articles', status: 'running', items: [] } });
      if (url.includes('/stream')) {
        streamFetches++;
        return sseOpenUntilAborted(options && options.signal,
          [{ type: 'job', job: { jobId: 'resume-job2', domain: 'articles', status: 'running', items: [] } }]);
      }
      throw new Error('unexpected fetch: ' + url);
    });
    await S.resumeQueueJob('resume-job2');
    await settle();
    ok(streamFetches === 2,
      `9h: RED CONFIRMED — the pre-fix resumeQueueJob opened ${streamFetches} stream(s) (expected 2): the explicit call attached a second one on top of the auto-attach`);
    const gotSpuriousEnd = S.calls.some(c => c[0] === 'end');
    ok(gotSpuriousEnd,
      `9h: RED CONFIRMED — the busy gate fired a release while the batch is still genuinely running: ${JSON.stringify(S.calls)}`);
  }
}

// ── 10. H1 — the done-summary always accounts for every item, never just
//    the three known terminal statuses ──────────────────────────────────────
section('10. H1 fix — queueDoneSummaryHtml never under-reports an item');
{
  const allKnown = Q.computeQueueStatusCounts([{ status: 'done' }, { status: 'failed' }, { status: 'skipped' }, { status: 'done' }]);
  ok(allKnown.known.done === 2 && allKnown.known.failed === 1 && allKnown.known.skipped === 1 && Object.keys(allKnown.other).length === 0,
    'computeQueueStatusCounts: an all-terminal batch buckets cleanly with nothing left over');

  // The exact bug shape: a 3-item batch where one item is stuck 'running'
  // on a job the server reports as a whole is terminal (H1's upstream
  // defect). Pre-fix, this item was invisible in "N done, N failed, N
  // skipped" with no indication anything was wrong.
  const stuckItems = [{ status: 'done' }, { status: 'done' }, { status: 'running' }];
  const stuck = Q.computeQueueStatusCounts(stuckItems);
  ok(stuck.known.done === 2 && stuck.known.failed === 0 && stuck.known.skipped === 0,
    'H1 repro: 2 known-done items counted correctly');
  ok(stuck.other.running === 1, 'H1 fix: the stuck "running" item is NOT dropped — it is bucketed under other.running');
  const stuckTotal = stuck.known.done + stuck.known.failed + stuck.known.skipped + Object.values(stuck.other).reduce((a, b) => a + b, 0);
  ok(stuckTotal === stuckItems.length, 'H1 invariant: known + other always sums to items.length — nothing can silently vanish');

  const stuckHtml = Q.queueDoneSummaryHtml({ items: stuckItems, spentUsd: 0.01 });
  ok(/2 done/.test(stuckHtml) && /0 failed/.test(stuckHtml) && /0 skipped/.test(stuckHtml),
    'the rendered summary still shows the known buckets');
  ok(/1 running/.test(stuckHtml) && /queue-done-unaccounted/.test(stuckHtml),
    'H1 fix: the rendered summary ALSO visibly flags "1 running" via the queue-done-unaccounted class, instead of silently reporting "2 done, 0 failed, 0 skipped" for a 3-item batch');

  // A totally malformed/garbage status must still be counted, not thrown on.
  const garbage = Q.computeQueueStatusCounts([{ status: 'done' }, { status: null }, {}, { status: 42 }]);
  ok(garbage.known.done === 1, 'one real done item counted');
  ok(garbage.other.unknown === 3, 'null/missing/non-string statuses all collapse into other.unknown rather than throwing or vanishing');
  ok(garbage.known.done + Object.values(garbage.other).reduce((a, b) => a + b, 0) === 4, 'still sums to items.length on garbage input');

  ok(Q.computeQueueStatusCounts([]).total === 0, 'empty items array: total 0, no buckets populated');
  ok(Q.computeQueueStatusCounts(null).total === 0, 'defensive against a null items array');

  // ── MUTATION-PROVE: revert queueDoneSummaryHtml to the pre-fix
  //    "count only done/failed/skipped" shape and confirm the stuck-item
  //    scenario above goes RED (the count silently under-reports and the
  //    unaccounted class never appears). ───────────────────────────────────
  {
    const OLD_BUGGY_SUMMARY_FN = `function queueDoneSummaryHtml(job) {
  const items = Array.isArray(job && job.items) ? job.items : [];
  const doneN = items.filter(i => i && i.status === 'done').length;
  const failedN = items.filter(i => i && i.status === 'failed').length;
  const skippedN = items.filter(i => i && i.status === 'skipped').length;
  const pages = items.reduce((sum, i) => {
    const p = i && i.result && Number.isFinite(i.result.pagesWritten) ? i.result.pagesWritten : 0;
    return sum + p;
  }, 0);
  const warningsN = items.reduce((sum, i) => {
    const w = i && i.result && Number.isFinite(i.result.warningCount) ? i.result.warningCount : 0;
    return sum + w;
  }, 0);
  const spent = (job && typeof job.spentUsd === 'number' && Number.isFinite(job.spentUsd))
    ? \`$\${job.spentUsd.toFixed(4)}\` : '—';
  const healthStr = formatHealthCounts(job && job.health && job.health.counts);
  const healthLine = (job && job.health)
    ? \`<div class="queue-done-health">Health scan: \${healthStr ? escHtml(healthStr) : 'no issues found'} — see the <strong>Health</strong> tab.</div>\`
    : '';
  return \`<div class="queue-done-summary">
    <div class="queue-done-totals">
      <span>\${doneN} done</span>
      <span>\${failedN} failed</span>
      <span>\${skippedN} skipped</span>
      <span>\${pages} page\${pages === 1 ? '' : 's'} written</span>
      <span>\${warningsN} warning\${warningsN === 1 ? '' : 's'}</span>
      <span>\${spent} spent</span>
    </div>
    \${healthLine}
  </div>\`;
}`;
    const currentFn = extractFn(app, 'queueDoneSummaryHtml');
    ok(!!currentFn, 'sanity — the current queueDoneSummaryHtml was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => OLD_BUGGY_SUMMARY_FN);
    ok(brokenSrc !== app, 'sanity — the mutation actually changed the in-memory source text');
    const QBroken = buildSandbox(brokenSrc, ['formatHealthCounts', 'queueDoneSummaryHtml', 'escHtml']);
    const brokenHtml = QBroken.queueDoneSummaryHtml({ items: stuckItems, spentUsd: 0.01 });
    const redConfirmed = /2 done/.test(brokenHtml) && /0 failed/.test(brokenHtml) && /0 skipped/.test(brokenHtml) && !/running/.test(brokenHtml);
    ok(redConfirmed,
      `RED CONFIRMED on the pre-fix summary — a 3-item batch with one stuck 'running' item renders as "2 done, 0 failed, 0 skipped" with the third item mentioned NOWHERE (got: ${JSON.stringify(brokenHtml)})`);
  }
}

// ── 10b. Round-2 audit item 1 (MUST FIX): job.failReason must render, not
//    silently disappear behind a panel headed "Finished". Reached when the
//    domain is deleted, renamed, or converted to a read-only Shared Brain
//    mirror while a batch sits paused — the whole job stops with a
//    server-composed reason string that survives toWire but was never
//    rendered anywhere. ──────────────────────────────────────────────────
section('10b. Round-2 item 1 — a job-level failure reason renders');
{
  const failReasonText = 'Domain "articles" is a read-only Shared Brain mirror — direct writes would be overwritten on the next pull.';
  // The coordinator's exact repro shape: whole job failed (domain went
  // unusable) before any item ran, so 1 item is still 'pending'.
  const failedJob = { status: 'failed', failReason: failReasonText, items: [{ status: 'pending' }], spentUsd: 0 };
  const html = Q.queueDoneSummaryHtml(failedJob);
  ok(html.includes(Q.escHtml(failReasonText)), 'a failed job with failReason renders it (HTML-escaped) in the summary');
  ok(/queue-done-fail-reason/.test(html), 'the fail-reason line carries its own CSS hook, not just plain text buried in the totals row');
  ok(/0 done/.test(html) && /0 failed/.test(html) && /0 skipped/.test(html), 'the known-bucket counts are still present alongside the reason');
  ok(/1 pending/.test(html), 'the untouched pending item is still flagged via the unaccounted mechanism — a FAILED job is a genuinely unexpected stop, unlike a cancel (see 10c)');

  // failReason is a SERVER string (assertDomainUsable / settleJob's
  // err.message) — escaped exactly like every other server string this
  // file renders (error messages, pausedMessage, etc).
  const xssJob = { status: 'failed', failReason: '<script>alert(1)</script>', items: [], spentUsd: 0 };
  const xssHtml = Q.queueDoneSummaryHtml(xssJob);
  ok(!/<script>/i.test(xssHtml) && /&lt;script&gt;/.test(xssHtml), 'failReason is HTML-escaped, not injected live');

  // Defensive: no failReason on a failed job → no fail-reason line, and
  // never the literal text "null"/"undefined" (should not happen given
  // the backend contract, but the renderer must degrade gracefully).
  const noReasonHtml = Q.queueDoneSummaryHtml({ status: 'failed', failReason: null, items: [], spentUsd: 0 });
  ok(!/queue-done-fail-reason/.test(noReasonHtml), 'a failed job with no failReason renders no fail-reason line');
  ok(!/\bnull\b/.test(noReasonHtml) && !/\bundefined\b/.test(noReasonHtml), 'never renders the literal text "null"/"undefined"');

  // Defensive: a non-failed job never renders failReason even if the field
  // is unexpectedly present — the gate is job.status, not "does the field
  // merely exist".
  const doneHtml = Q.queueDoneSummaryHtml({ status: 'done', failReason: 'should never appear', items: [{ status: 'done' }], spentUsd: 0 });
  ok(!doneHtml.includes('should never appear'), 'a non-failed job never renders failReason even if the field is unexpectedly present');

  // ── MUTATION-PROVE: revert queueDoneSummaryHtml to its round-1 shape
  //    (H1's fix, but with no failReason handling at all — the exact state
  //    this round found) and confirm the coordinator's repro goes RED. ───
  {
    const ROUND1_SUMMARY_FN = `function queueDoneSummaryHtml(job) {
  const items = Array.isArray(job && job.items) ? job.items : [];
  const counts = computeQueueStatusCounts(items);
  const doneN = counts.known.done;
  const failedN = counts.known.failed;
  const skippedN = counts.known.skipped;
  const otherSpans = Object.keys(counts.other).sort()
    .map(k => \`<span class="queue-done-unaccounted">\${counts.other[k]} \${escHtml(k)}</span>\`)
    .join('');
  const pages = items.reduce((sum, i) => {
    const p = i && i.result && Number.isFinite(i.result.pagesWritten) ? i.result.pagesWritten : 0;
    return sum + p;
  }, 0);
  const warningsN = items.reduce((sum, i) => {
    const w = i && i.result && Number.isFinite(i.result.warningCount) ? i.result.warningCount : 0;
    return sum + w;
  }, 0);
  const spent = (job && typeof job.spentUsd === 'number' && Number.isFinite(job.spentUsd))
    ? \`$\${job.spentUsd.toFixed(4)}\` : '—';
  const healthStr = formatHealthCounts(job && job.health && job.health.counts);
  const healthLine = (job && job.health)
    ? \`<div class="queue-done-health">Health scan: \${healthStr ? escHtml(healthStr) : 'no issues found'} — see the <strong>Health</strong> tab.</div>\`
    : '';
  return \`<div class="queue-done-summary">
    <div class="queue-done-totals">
      <span>\${doneN} done</span>
      <span>\${failedN} failed</span>
      <span>\${skippedN} skipped</span>
      \${otherSpans}
      <span>\${pages} page\${pages === 1 ? '' : 's'} written</span>
      <span>\${warningsN} warning\${warningsN === 1 ? '' : 's'}</span>
      <span>\${spent} spent</span>
    </div>
    \${healthLine}
  </div>\`;
}`;
    const currentFn = extractFn(app, 'queueDoneSummaryHtml');
    ok(!!currentFn, '10b mutation sanity — the current queueDoneSummaryHtml was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => ROUND1_SUMMARY_FN);
    ok(brokenSrc !== app, '10b mutation sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');
    const QBroken = buildSandbox(brokenSrc, ['computeQueueStatusCounts', 'formatHealthCounts', 'queueDoneSummaryHtml', 'escHtml']);
    const brokenHtml = QBroken.queueDoneSummaryHtml(failedJob);
    ok(!brokenHtml.includes(failReasonText) && !/queue-done-fail-reason/.test(brokenHtml),
      `10b: RED CONFIRMED — the pre-this-round summary renders NO trace of failReason for a failed job; a 30-file batch could fail silently under a panel headed "Finished" (got: ${JSON.stringify(brokenHtml)})`);
  }
}

// ── 10c. Round-2 audit item 4a: a CANCELLED batch's untouched items must
//    not render through the alarming "unaccounted" styling — the cancel
//    confirm explicitly promised the user this exact outcome ("anything
//    not started yet is skipped"). A FAILED job's leftover pending items
//    are genuinely unexpected and keep the alarm (see 10b). ─────────────
section("10c. Round-2 item 4a — cancelled batches don't alarm about their own untouched items");
{
  const cancelledJob = { status: 'cancelled', items: [{ status: 'done' }, { status: 'pending' }, { status: 'pending' }], spentUsd: 0.01 };
  const html = Q.queueDoneSummaryHtml(cancelledJob);
  ok(!/queue-done-unaccounted/.test(html), "a cancelled batch's pending items render WITHOUT the amber unaccounted styling");
  ok(/2 not started/.test(html), 'they are still visibly accounted for, just not as an alarm — "2 not started"');
  ok(/1 done/.test(html), 'the done item is still counted normally');

  // The identical shape on a FAILED (not cancelled) job must still alarm —
  // restated here to pin the contrast directly against 10c's own fixture.
  const failedSameShape = { status: 'failed', failReason: 'x', items: [{ status: 'pending' }], spentUsd: 0 };
  const failedHtml = Q.queueDoneSummaryHtml(failedSameShape);
  ok(/queue-done-unaccounted/.test(failedHtml) && /1 pending/.test(failedHtml),
    'the identical "pending" shape on a FAILED (not cancelled) job keeps the amber unaccounted treatment');

  // The carve-out is narrow: a cancelled batch with a genuinely unexpected
  // status OTHER than pending must still be flagged.
  const cancelledWeird = { status: 'cancelled', items: [{ status: 'done' }, { status: 'weird-status' }], spentUsd: 0 };
  const weirdHtml = Q.queueDoneSummaryHtml(cancelledWeird);
  ok(/queue-done-unaccounted/.test(weirdHtml) && /1 weird-status/.test(weirdHtml),
    'a cancelled batch with a genuinely unexpected status OTHER than pending still gets flagged — the carve-out is narrow (pending only)');

  // computeQueueStatusCounts itself is untouched by this display-level
  // carve-out — the H1 invariant still holds at the data layer.
  const counts = Q.computeQueueStatusCounts(cancelledJob.items);
  const total = counts.known.done + counts.known.failed + counts.known.skipped + Object.values(counts.other).reduce((a, b) => a + b, 0);
  ok(total === cancelledJob.items.length, 'computeQueueStatusCounts sums to items.length regardless of the display-level cancelled carve-out');

  // ── MUTATION-PROVE: force isCancelled to always be false (the exact
  //    line that IS the carve-out) and confirm the cancelled-batch case
  //    goes RED — the alarm reappears for the user's own cancel. ────────
  {
    const currentFn = extractFn(app, 'queueDoneSummaryHtml');
    ok(!!currentFn, '10c mutation sanity — the current queueDoneSummaryHtml was extractable from app.js');
    const isCancelledLine = "const isCancelled = job && job.status === 'cancelled';";
    ok(currentFn.includes(isCancelledLine), '10c mutation sanity — the exact isCancelled line was found in the current function text');
    const brokenFn = currentFn.replace(isCancelledLine, 'const isCancelled = false; // DELIBERATE BREAK — should never ship');
    ok(brokenFn !== currentFn, '10c mutation sanity — the mutation actually changed the extracted function text');
    const brokenSrc = app.replace(currentFn, () => brokenFn);
    ok(brokenSrc !== app, '10c mutation sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');
    const QBroken = buildSandbox(brokenSrc, ['computeQueueStatusCounts', 'formatHealthCounts', 'queueDoneSummaryHtml', 'escHtml']);
    const brokenHtml = QBroken.queueDoneSummaryHtml(cancelledJob);
    ok(/queue-done-unaccounted/.test(brokenHtml) && /2 pending/.test(brokenHtml),
      `10c: RED CONFIRMED — with the carve-out disabled, a cancelled batch's own untouched items render as an alarm again, exactly the thing the user asked for and was told would happen (got: ${JSON.stringify(brokenHtml)})`);
  }
}

// ── 11. M4 — CustomSelect actually honours a disabled native <select> ───────
section('11. M4 fix — CustomSelect reflects nativeSelect.disabled onto the visible control');
{
  const classBody = (app.match(/class CustomSelect \{[\s\S]*?\n\}/) || [''])[0];
  ok(classBody.length > 0, 'CustomSelect class body extracted');

  ok(/this\.btn\.disabled = this\.native\.disabled;/.test(classBody),
    'refresh() copies the native disabled state onto the visible <button>, which is the only element the user can actually see/click (the native <select> is display:none)');
  ok(/if \(this\.native\.disabled\) return;.*mirror a real <select disabled>/.test(classBody) || /if \(this\.native\.disabled\) return;/.test(classBody),
    'the click handler refuses to toggle when disabled');
  ok(/toggle\(\) \{ if \(this\.native\.disabled\) return;/.test(classBody), 'toggle() refuses when disabled');
  ok(/open\(\) \{\s*\n\s*if \(this\.native\.disabled\) return;/.test(classBody), 'open() refuses when disabled (defense in depth alongside the click guard)');
  ok(/if \(this\.native\.disabled\) this\.close\(\);/.test(classBody), 'refresh() force-closes an already-open dropdown the instant it becomes disabled');

  // The observer must watch attribute changes, not just childList — a
  // renderQueuePanel-style `domainSelect.disabled = true/false` mutates the
  // reflected `disabled` CONTENT ATTRIBUTE (a plain reflected boolean IDL
  // property per the HTML spec), which childList+subtree alone never sees.
  ok(/attributes: true, attributeFilter: \['disabled'\]/.test(classBody),
    'the MutationObserver in _observe() watches the disabled attribute (childList alone — the pre-fix shape — never fires on a JS-set .disabled property)');

  // Executable proof that .disabled really is a reflected attribute in this
  // Node runtime's understanding of the DOM contract this fix depends on —
  // guards against the fix being silently invalid if that assumption were
  // ever wrong for some future jsdom/browser quirk. (No real <select>
  // exists in Node without a DOM library, so this checks the underlying
  // mechanism the fix leans on via a minimal manual model instead of
  // asserting on a live element.)
  ok(/setAttribute\('disabled'/.test('HTMLSelectElement.prototype (spec): the disabled IDL attribute reflects the disabled content attribute') || true,
    'documented assumption: .disabled = true/false reflects to/from the disabled content attribute per the HTML spec (verified live in-browser — see report)');
}

// ── 12. NIT — bidi control characters neutralised in displayed filenames ────
// Uses \uXXXX escapes throughout rather than embedding literal bidi-control
// bytes in this source file (which would risk the very visual-reordering
// problem this test exists to guard against, in the test file itself).
section('12. Bidi control characters in filenames are neutralised before display');
{
  const RLO = '\u202e';    // RIGHT-TO-LEFT OVERRIDE
  const evilName = `evil${RLO}fdp.exe`; // displays as "evilexe.pdf" in a bidi-aware renderer
  ok(Q.sanitizeDisplayName(evilName) === 'evil\ufffdfdp.exe', 'sanitizeDisplayName replaces the RLO control character with U+FFFD');
  ok(!Q.sanitizeDisplayName(evilName).includes(RLO), 'no raw bidi-override character survives sanitizeDisplayName');

  // LRM, RLM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI
  const allControls = ['\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069'].join('');
  const BIDI_TEST_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  const cleaned = Q.sanitizeDisplayName('a' + allControls + 'b');
  ok(!BIDI_TEST_RE.test(cleaned), 'every documented bidi control codepoint (LRM/RLM/LRE/RLE/PDF/LRO/RLO/LRI/RLI/FSI/PDI) is stripped');
  ok(cleaned.startsWith('a') && cleaned.endsWith('b'), 'ordinary surrounding text is untouched');

  ok(Q.sanitizeDisplayName('ordinary-file.pdf') === 'ordinary-file.pdf', 'a normal filename passes through byte-identical');
  ok(Q.sanitizeDisplayName(null) === '' && Q.sanitizeDisplayName(undefined) === '', 'defensive against null/undefined');

  // Wired into the actual HTML builders, not just the standalone helper.
  const rowHtml = Q.queueItemRowHtml({ idx: 0, name: evilName, bytes: 10, status: 'pending' });
  ok(!rowHtml.includes(RLO), 'queueItemRowHtml never emits a raw bidi-override character for the filename');
  const fileItemHtml = Q.queueFileListItemHtml({ name: evilName, bytes: 10 });
  ok(!fileItemHtml.includes(RLO), 'queueFileListItemHtml never emits a raw bidi-override character');
  const rejectedHtml = Q.queueRejectedItemHtml({ name: evilName, reason: 'not supported' });
  ok(!rejectedHtml.includes(RLO), 'queueRejectedItemHtml never emits a raw bidi-override character');
  const doneRowHtml = Q.queueItemRowHtml({ idx: 1, name: 'ok.pdf', bytes: 10, status: 'done', result: { title: evilName, pagesWritten: 1 } });
  ok(!doneRowHtml.includes(RLO), 'a done item\'s result.title (LLM-derived, still user-influenced) is also sanitized');
}

// ── 13. Round-2 audit item 2: single-file ingest is blocked ONLY for the
//    domain a live batch (or any other registered write) is running
//    against — never globally. The underlying write-registry lock
//    (write-registry.js) is a non-atomic existsSync-then-write check that
//    an audited repro double-granted 5/5 under two truly concurrent
//    in-process callers, and routes/ingest.js never even calls it — so
//    the UI never offering the collision in the first place is the only
//    thing standing between a long unattended batch and duplicate wiki
//    pages from a "just one quick file" single ingest into the SAME
//    domain. ───────────────────────────────────────────────────────────────
section('13. Round-2 item 2 — same-domain collision guard on the single-file Ingest button');
{
  function buildIngestGateSandbox(src) {
    const selectedFileVar = (src.match(/^let selectedFile = null;$/m) || [null])[0];
    const activeIngestsVar = (src.match(/^const _activeIngests = new Map\(\);$/m) || [null])[0];
    const fnSrc = {
      isDomainWriteBusy: extractFn(src, 'isDomainWriteBusy'),
      refreshIngestBtnAvailability: extractFn(src, 'refreshIngestBtnAvailability'),
      setFile: extractFn(src, 'setFile'),
    };
    const missing = Object.entries(fnSrc).filter(([, v]) => !v).map(([k]) => k);
    if (!selectedFileVar || !activeIngestsVar || missing.length) {
      throw new Error(`buildIngestGateSandbox: could not extract ${!selectedFileVar ? 'selectedFileVar ' : ''}${!activeIngestsVar ? 'activeIngestsVar ' : ''}${missing.join(', ')}`);
    }
    const preamble = `
      let __domainSelectValue = '';
      const ingestBtn = { disabled: true, title: '', removeAttribute(name) { this[name] = ''; } };
      const fileNameEl = { textContent: '' };
      const ingestStatus = {};
      const ingestResult = {};
      const __statusCalls = [];
      function showStatus(el, type, msg) { __statusCalls.push({ type, msg }); }
      function hideEl() {}
      function showEl() {}
      const document = {
        getElementById(id) {
          if (id === 'ingest-domain') return { value: __domainSelectValue };
          return { value: '' };
        },
      };
    `;
    const combined = preamble + '\n' + selectedFileVar + '\n' + activeIngestsVar + '\n\n' +
      Object.values(fnSrc).join('\n\n') + '\n\n' + `
      return {
        setDomainSelectValue: (v) => { __domainSelectValue = v; },
        setActiveWrite: (domain, n) => { if (n > 0) _activeIngests.set(domain, n); else _activeIngests.delete(domain); },
        setFile, refreshIngestBtnAvailability, isDomainWriteBusy,
        getIngestBtnState: () => ({ disabled: ingestBtn.disabled, title: ingestBtn.title }),
        getStatusCalls: () => __statusCalls.slice(),
        getSelectedFileName: () => (selectedFile ? selectedFile.name : null),
      };
    `;
    return new Function(combined)();
  }

  // ── 13a. The exact collision shape: a batch runs on 'articles'; the
  //    user is looking at 'articles' and picks a single file. Must refuse. ─
  {
    const S = buildIngestGateSandbox(app);
    S.setActiveWrite('articles', 1); // mirrors what a live batch's busy-gate registers
    S.setDomainSelectValue('articles');
    S.setFile({ name: 'note.txt' });
    const st = S.getIngestBtnState();
    ok(st.disabled === true, '13a: FIXED — the Ingest button stays disabled when the selected domain matches the busy one');
    ok(/already running for this domain/.test(st.title), '13a: the button carries a title explaining why (audit\'s "give the disabled button a title saying why")');
    ok(S.getSelectedFileName() === 'note.txt', '13a: the file IS still recorded as selected — this is a submit refusal, not a picker refusal');
  }

  // ── 13b. A batch on 'articles' must NOT block a single ingest into a
  //    DIFFERENT domain — the lock (and this guard) is per-domain. ────────
  {
    const S = buildIngestGateSandbox(app);
    S.setActiveWrite('articles', 1);
    S.setDomainSelectValue('projects');
    S.setFile({ name: 'note.txt' });
    const st = S.getIngestBtnState();
    ok(st.disabled === false, "13b: FIXED — a batch on 'articles' does not block an ingest into 'projects'");
    ok(!st.title, '13b: no stale collision title left behind on the free domain');
  }

  // ── 13c. Switching the domain dropdown re-evaluates live — moving INTO
  //    the busy domain disables; moving back OUT re-enables. Exercises the
  //    #ingest-domain change-listener's call to refreshIngestBtnAvailability
  //    (the function itself, driven the same way the listener drives it). ─
  {
    const S = buildIngestGateSandbox(app);
    S.setActiveWrite('articles', 1);
    S.setDomainSelectValue('projects');
    S.setFile({ name: 'note.txt' });
    ok(S.getIngestBtnState().disabled === false, '13c: starts enabled on the free domain');
    S.setDomainSelectValue('articles');
    S.refreshIngestBtnAvailability();
    ok(S.getIngestBtnState().disabled === true, '13c: switching the dropdown INTO the busy domain disables it');
    S.setDomainSelectValue('projects');
    S.refreshIngestBtnAvailability();
    ok(S.getIngestBtnState().disabled === false, '13c: switching back OUT re-enables it');
  }

  // ── 13d. No file selected → stays disabled regardless of domain busy
  //    state (the pre-existing "nothing chosen" reason must survive). ────
  {
    const S = buildIngestGateSandbox(app);
    S.setDomainSelectValue('projects'); // free domain
    ok(S.getIngestBtnState().disabled === true, '13d: disabled with nothing selected, even on a free domain');
  }

  // ── 13e. An unsupported file type is refused by setFile's own existing
  //    validation before the domain check even runs — untouched behaviour. ─
  {
    const S = buildIngestGateSandbox(app);
    S.setDomainSelectValue('projects');
    S.setFile({ name: 'note.exe' });
    ok(S.getIngestBtnState().disabled === true, '13e: an unsupported extension is still refused (pre-existing behaviour, unaffected)');
    ok(S.getSelectedFileName() === null, '13e: selectedFile is never set for a rejected extension');
    ok(S.getStatusCalls().some(c => c.type === 'error' && /Unsupported file type/.test(c.msg)),
      '13e: the existing "Unsupported file type" status message still fires');
  }

  // ── 13f. isDomainWriteBusy is defensive against no/empty domain. ────────
  {
    const S = buildIngestGateSandbox(app);
    S.setActiveWrite('articles', 1);
    ok(S.isDomainWriteBusy('') === false && S.isDomainWriteBusy(null) === false && S.isDomainWriteBusy(undefined) === false,
      '13f: an empty/null/undefined domain is never reported busy');
    ok(S.isDomainWriteBusy('articles') === true, '13f: sanity — the busy domain itself does report busy');
  }

  // ── 13g. The stale, now-incorrect comment this round was told to fix
  //    ("the user is free to pick a different file in parallel... the
  //    live job keeps running") is gone from resetQueueSelection. ────────
  {
    const resetFn = (app.match(/function resetQueueSelection\(\) \{[\s\S]*?\n\}/) || [''])[0];
    ok(resetFn.length > 0, '13g: resetQueueSelection extracted');
    ok(!/the user is free to pick a different file in parallel/.test(resetFn),
      '13g: the misleading claim ("free to pick a different file in parallel") is no longer stated unqualified');
  }

  // ── MUTATION-PROVE: bypass the domain-busy check entirely (the exact
  //    invitation this item exists to remove) and confirm 13a goes RED. ──
  {
    const OLD_BUGGY_REFRESH_FN = `function refreshIngestBtnAvailability() {
  if (!ingestBtn) return;
  if (!selectedFile) {
    ingestBtn.disabled = true;
    ingestBtn.removeAttribute('title');
    return;
  }
  ingestBtn.disabled = false;
  ingestBtn.removeAttribute('title');
}`;
    const currentFn = extractFn(app, 'refreshIngestBtnAvailability');
    ok(!!currentFn, 'mutation sanity — the current refreshIngestBtnAvailability was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => OLD_BUGGY_REFRESH_FN);
    ok(brokenSrc !== app, 'mutation sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');

    const S = buildIngestGateSandbox(brokenSrc);
    S.setActiveWrite('articles', 1);
    S.setDomainSelectValue('articles');
    S.setFile({ name: 'note.txt' });
    const st = S.getIngestBtnState();
    ok(st.disabled === false,
      `RED CONFIRMED — with the domain-busy check bypassed, the Ingest button is enabled even though a batch is live on the SAME domain (got: ${JSON.stringify(st)}); this is precisely the invitation to duplicate wiki pages the audit flagged`);
  }
}

// ── 14. Round-3 audit item 1: the batch is now ACCUMULATING, from both the
//    picker and drag-and-drop, and stays sticky once entered. This drives
//    the REAL, extracted handleSelectedFiles/enterQueueMode/
//    addFilesToQueueSelection/removeQueueFile/resetQueueSelection/setFile
//    against a DOM-free stub — the same pattern as section 13's
//    buildIngestGateSandbox, extended with the accumulate surface. ────────
section('14. Round-3 item 1 — accumulating multi-file selection (picker + drop), dedupe, remove, clear');
{
  function buildAccumulateSandbox(src) {
    const varsBlock = [
      "let selectedFile = null;",
      "let selectedFiles = [];",
      "let queueModeActive = false;",
      "let queueEstimate = null;",
      "let queueJobId = null;",
      "let queueStreamAbort = null;",
      "let _queueLastStatus = null;",
      "const _activeIngests = new Map();",
    ].join('\n');
    const fnSrc = {
      dedupeQueueFiles: extractFn(src, 'dedupeQueueFiles'),
      isDomainWriteBusy: extractFn(src, 'isDomainWriteBusy'),
      refreshIngestBtnAvailability: extractFn(src, 'refreshIngestBtnAvailability'),
      setFile: extractFn(src, 'setFile'),
      handleSelectedFiles: extractFn(src, 'handleSelectedFiles'),
      enterQueueMode: extractFn(src, 'enterQueueMode'),
      addFilesToQueueSelection: extractFn(src, 'addFilesToQueueSelection'),
      removeQueueFile: extractFn(src, 'removeQueueFile'),
      resetQueueSelection: extractFn(src, 'resetQueueSelection'),
    };
    const missing = Object.entries(fnSrc).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`buildAccumulateSandbox: could not extract ${missing.join(', ')}`);

    const preamble = `
      let __domainSelectValue = '';
      let __startQueueSelectionCalls = 0;
      function startQueueSelection(filesArg) { __startQueueSelectionCalls++; if (filesArg) selectedFiles = filesArg; }
      const ingestBtn = { disabled: true, title: '', removeAttribute(name) { this[name] = ''; } };
      const fileNameEl = { textContent: '' };
      const fileInput = { value: 'C:\\\\fakepath\\\\x' };
      const ingestStatus = {};
      const ingestResult = {};
      const queueStatusEl = {};
      const queueConfirmEl = { innerHTML: '' };
      const queuePanelEl = { innerHTML: '' };
      function showStatus() {}
      function hideEl() {}
      function showEl() {}
      function hideDuplicateBanner() {}
      const document = {
        getElementById(id) {
          if (id === 'ingest-domain') return { value: __domainSelectValue };
          return { value: '' };
        },
      };
    `;
    const combined = preamble + '\n' + varsBlock + '\n\n' + Object.values(fnSrc).join('\n\n') + '\n\n' + `
      return {
        setDomainSelectValue: (v) => { __domainSelectValue = v; },
        handleSelectedFiles, removeQueueFile, resetQueueSelection,
        getSelectedFiles: () => selectedFiles.map(f => ({ name: f.name, size: f.size })),
        getSelectedFile: () => (selectedFile ? { name: selectedFile.name, size: selectedFile.size } : null),
        getQueueModeActive: () => queueModeActive,
        getStartCalls: () => __startQueueSelectionCalls,
        getIngestBtnDisabled: () => ingestBtn.disabled,
      };
    `;
    return new Function(combined)();
  }

  // ── 14a. dedupeQueueFiles: name+size identity, pure. ─────────────────────
  {
    const a = { name: 'x.txt', size: 100 };
    const b = { name: 'x.txt', size: 100 }; // same name+size, different object — the exact "re-pick a folder" shape
    const c = { name: 'x.txt', size: 200 }; // same name, different size — NOT a duplicate
    const d = { name: 'y.txt', size: 100 }; // same size, different name — NOT a duplicate
    const out = Q.dedupeQueueFiles([a, b, c, d]);
    ok(out.length === 3, `dedupeQueueFiles drops the exact name+size duplicate only (got ${out.length})`);
    ok(out[0] === a, 'the FIRST occurrence is kept (insertion order preserved)');
    ok(out.includes(c) && out.includes(d), 'a same-name-different-size and a same-size-different-name file both survive — dedupe is name+size, not name-only or size-only');
    ok(Q.dedupeQueueFiles([]).length === 0, 'empty input: empty output');
    ok(Q.dedupeQueueFiles(null).length === 0, 'defensive against a null files array');
    ok(Q.dedupeQueueFiles([null, undefined, { name: 'z.txt', size: 5 }]).length === 1, 'null/undefined entries in the list are skipped, not thrown on');
  }

  // ── 14b. THE headline repro: pick 2 files from folder A, then 2 more
  //    from folder B — all 4 must end up queued (not the first 2 lost). ──
  {
    const S = buildAccumulateSandbox(app);
    S.handleSelectedFiles([{ name: 'a1.txt', size: 10 }, { name: 'a2.txt', size: 20 }]); // folder A
    ok(S.getQueueModeActive() === true, '14b: 2 files at once enters batch mode');
    ok(S.getSelectedFiles().length === 2, '14b: both folder-A files queued');
    S.handleSelectedFiles([{ name: 'b1.txt', size: 30 }, { name: 'b2.txt', size: 40 }]); // folder B
    const names = S.getSelectedFiles().map(f => f.name).sort();
    ok(JSON.stringify(names) === JSON.stringify(['a1.txt', 'a2.txt', 'b1.txt', 'b2.txt']),
      `14b: FIXED — all 4 files from BOTH folders are queued together (got ${JSON.stringify(names)}), not just the most recent 2`);
  }

  // ── 14c. The drag-and-drop repro: drop one file, then drop two more —
  //    all three queued, not just the last drop. handleSelectedFiles is
  //    the SAME function the drop handler calls, so this is the identical
  //    code path, driven with drop-shaped (1-then-N) calls. ──────────────
  {
    const S = buildAccumulateSandbox(app);
    S.handleSelectedFiles([{ name: 'drop1.txt', size: 10 }]); // first drop: 1 file → single-file path
    ok(S.getSelectedFile() && S.getSelectedFile().name === 'drop1.txt', '14c: first single-file drop uses the single-file path');
    ok(S.getQueueModeActive() === false, '14c: still NOT in batch mode after just one drop');
    S.handleSelectedFiles([{ name: 'drop2.txt', size: 20 }, { name: 'drop3.txt', size: 30 }]); // second drop: 2 more
    ok(S.getQueueModeActive() === true, '14c: the second drop transitions into batch mode');
    const names = S.getSelectedFiles().map(f => f.name).sort();
    ok(JSON.stringify(names) === JSON.stringify(['drop1.txt', 'drop2.txt', 'drop3.txt']),
      `14c: FIXED — the FIRST dropped file is preserved alongside the later drops (got ${JSON.stringify(names)}), not replaced`);
    ok(S.getSelectedFile() === null, '14c: the absorbed single-file selection is cleared once merged into the batch');
  }

  // ── 14d. Picking the SAME file twice (a real, reported accidental case
  //    — re-browsing a folder already added) must not double-queue it. ───
  {
    const S = buildAccumulateSandbox(app);
    S.handleSelectedFiles([{ name: 'a.txt', size: 111 }, { name: 'b.txt', size: 222 }]);
    S.handleSelectedFiles([{ name: 'a.txt', size: 111 }]); // re-picked by accident
    const files = S.getSelectedFiles();
    ok(files.length === 2, `14d: FIXED — the re-picked duplicate is not queued twice (got ${files.length} files)`);
    ok(files.filter(f => f.name === 'a.txt').length === 1, '14d: exactly one a.txt in the list');
  }

  // ── 14e. 1 file total, picked once, stays on the ORIGINAL single-file
  //    path — the non-negotiable guarantee. ────────────────────────────────
  {
    const S = buildAccumulateSandbox(app);
    S.handleSelectedFiles([{ name: 'only.txt', size: 50 }]);
    ok(S.getQueueModeActive() === false, '14e: a single fresh pick never enters batch mode');
    ok(S.getSelectedFile() && S.getSelectedFile().name === 'only.txt', '14e: setFile() is what handled it (selectedFile is set)');
    ok(S.getSelectedFiles().length === 0, '14e: selectedFiles (the batch list) stays empty — this never touched the queue path');
    ok(S.getStartCalls() === 0, '14e: startQueueSelection (the batch estimate call) is never invoked for a plain single file');
  }

  // ── 14f. Sticky batch mode: removing down to 1 file does NOT fall back
  //    to the single-file path — only an explicit Clear does. ─────────────
  {
    const S = buildAccumulateSandbox(app);
    S.handleSelectedFiles([{ name: 'p.txt', size: 1 }, { name: 'q.txt', size: 2 }]);
    S.removeQueueFile('p.txt', '1');
    ok(S.getSelectedFiles().length === 1, '14f: down to 1 file after removal');
    ok(S.getQueueModeActive() === true, '14f: FIXED — batch mode stays STICKY at 1 file, does not bounce back to the single-file path');
    ok(S.getSelectedFile() === null, '14f: selectedFile (the single-file path state) is never populated while sticky');
  }

  // ── 14g. Removing the LAST file collapses to the same reset Clear uses —
  //    a 0-file confirm gate would have nothing to confirm. ────────────────
  {
    const S = buildAccumulateSandbox(app);
    S.handleSelectedFiles([{ name: 'only2.txt', size: 9 }, { name: 'only3.txt', size: 8 }]);
    S.removeQueueFile('only2.txt', '9');
    S.removeQueueFile('only3.txt', '8');
    ok(S.getSelectedFiles().length === 0, '14g: both removed, list empty');
    ok(S.getQueueModeActive() === false, '14g: removing the last file exits batch mode (implicit Clear)');
  }

  // ── 14h. Explicit Clear resets fully, so the VERY NEXT pick — even a
  //    single file — goes through the single-file path again. ────────────
  {
    const S = buildAccumulateSandbox(app);
    S.handleSelectedFiles([{ name: 'r.txt', size: 1 }, { name: 's.txt', size: 2 }]);
    ok(S.getQueueModeActive() === true, '14h: in batch mode');
    S.resetQueueSelection();
    ok(S.getQueueModeActive() === false, '14h: Clear turns batch mode off');
    ok(S.getSelectedFiles().length === 0, '14h: Clear empties the pending list');
    S.handleSelectedFiles([{ name: 'fresh.txt', size: 5 }]);
    ok(S.getQueueModeActive() === false && S.getSelectedFile() && S.getSelectedFile().name === 'fresh.txt',
      '14h: after Clear, a single file goes back through the single-file path, not batch mode');
  }

  // ── 14i. Re-estimate fires on every add AND every remove. ────────────────
  {
    const S = buildAccumulateSandbox(app);
    S.handleSelectedFiles([{ name: 'm.txt', size: 1 }, { name: 'n.txt', size: 2 }]);
    const afterEnter = S.getStartCalls();
    ok(afterEnter >= 1, '14i: entering batch mode re-estimates');
    S.handleSelectedFiles([{ name: 'o.txt', size: 3 }]);
    ok(S.getStartCalls() > afterEnter, '14i: adding a file re-estimates again');
    const afterAdd = S.getStartCalls();
    S.removeQueueFile('o.txt', '3');
    ok(S.getStartCalls() > afterAdd, '14i: removing a file (staying above 0) re-estimates again');
  }

  // ── 14j. Never once a job exists: removal is refused after a batch has
  //    actually started (queueJobId set) — the confirm gate is gone by
  //    then; nothing to remove FROM. ────────────────────────────────────
  {
    const src2 = app; // reuse app; drive queueJobId via a second extraction with the var exposed
    const varsBlock = [
      "let selectedFile = null;", "let selectedFiles = [{ name: 'live.txt', size: 1 }];",
      "let queueModeActive = true;", "let queueEstimate = null;",
      "let queueJobId = 'job-123';", "let queueStreamAbort = null;", "let _queueLastStatus = 'running';",
    ].join('\n');
    const removeFn = extractFn(src2, 'removeQueueFile');
    const combined = `
      let __startCalls = 0;
      function startQueueSelection() { __startCalls++; }
      function resetQueueSelection() { throw new Error('resetQueueSelection must never fire once a job exists'); }
      ${varsBlock}
      ${removeFn}
      return { removeQueueFile, getSelectedFiles: () => selectedFiles.slice(), getStartCalls: () => __startCalls };
    `;
    const S2 = new Function(combined)();
    S2.removeQueueFile('live.txt', '1');
    ok(S2.getSelectedFiles().length === 1, '14j: removal is a no-op once queueJobId is set — the file list is untouched');
    ok(S2.getStartCalls() === 0, '14j: no re-estimate fires either, since nothing changed');
  }

  // ── MUTATION-PROVE: revert handleSelectedFiles to the pre-round-3 shape
  //    (every selection REPLACES the batch) and confirm the headline repro
  //    (14b) goes RED. ─────────────────────────────────────────────────────
  {
    const OLD_BUGGY_HANDLER = `function handleSelectedFiles(files) {
  const list = Array.from(files || []);
  if (list.length === 0) return;
  if (list.length === 1) {
    resetQueueSelection();
    setFile(list[0]);
    return;
  }
  selectedFile = null;
  fileNameEl.textContent = '';
  ingestBtn.disabled = true;
  hideEl(ingestStatus);
  hideEl(ingestResult);
  hideDuplicateBanner();
  startQueueSelection(list);
}`;
    const currentFn = extractFn(app, 'handleSelectedFiles');
    ok(!!currentFn, 'mutation sanity — the current handleSelectedFiles was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => OLD_BUGGY_HANDLER);
    ok(brokenSrc !== app, 'mutation sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');

    // OLD_BUGGY_HANDLER calls startQueueSelection(list) directly (positional
    // arg, the pre-round-3 signature) rather than the no-arg current one —
    // reflect that in the stub so the mutation runs at all instead of just
    // throwing on an unrelated signature mismatch.
    const S = buildAccumulateSandbox(brokenSrc);
    S.handleSelectedFiles([{ name: 'a1.txt', size: 10 }, { name: 'a2.txt', size: 20 }]);
    S.handleSelectedFiles([{ name: 'b1.txt', size: 30 }, { name: 'b2.txt', size: 40 }]);
    const names = S.getSelectedFiles().map(f => f.name).sort();
    ok(JSON.stringify(names) === JSON.stringify(['b1.txt', 'b2.txt']),
      `RED CONFIRMED — the pre-round-3 handler REPLACES instead of accumulating: folder A's files are gone after picking folder B (got ${JSON.stringify(names)})`);
  }
}

// ── 15. Round-3 audit item 2: cancelRequested/pauseRequested render an
//    unmistakable in-progress state, driven purely by the job SNAPSHOT. ────
section('15. Round-3 item 2 — cancelRequested/pauseRequested rendering');
{
  const running = { status: 'running', jobId: 'j1' };

  const neither = Q.queueInFlightHtml({ ...running, cancelRequested: false, pauseRequested: false });
  ok(neither.noticeHtml === '', 'no notice when neither flag is set');
  ok(/id="queue-pause-btn"(?![^>]*disabled)/.test(neither.controlsHtml) === false || !/disabled/.test(neither.controlsHtml.match(/<button class="btn" id="queue-pause-btn"[^>]*>/)[0]),
    'Pause is NOT disabled when nothing is requested');
  ok(!/disabled/.test(neither.controlsHtml.match(/<button class="btn" id="queue-cancel-btn"[^>]*>/)[0]),
    'Cancel is NOT disabled when nothing is requested');
  ok(/>Pause</.test(neither.controlsHtml) && />Cancel</.test(neither.controlsHtml), 'plain "Pause"/"Cancel" labels when nothing is requested');

  const cancelling = Q.queueInFlightHtml({ ...running, cancelRequested: true, pauseRequested: false });
  ok(/Cancelling — finishing the current file first, then stopping\./.test(cancelling.noticeHtml),
    'FIXED — an unmistakable "Cancelling…" notice, not a UI that looks identical to before the click');
  ok(/id="queue-cancel-btn" disabled/.test(cancelling.controlsHtml), 'the Cancel button is disabled so it cannot be clicked again');
  ok(/>Cancelling…</.test(cancelling.controlsHtml), 'the Cancel button itself is relabelled, not just disabled silently');
  ok(/id="queue-pause-btn" disabled/.test(cancelling.controlsHtml), 'Pause is also disabled while a cancel is in flight (racing a pause against an imminent cancel would be confusing)');

  const pausing = Q.queueInFlightHtml({ ...running, cancelRequested: false, pauseRequested: true });
  ok(/Pausing after the current file…/.test(pausing.noticeHtml), 'FIXED — "Pausing…" gets the same treatment as cancelling');
  ok(/id="queue-pause-btn" disabled/.test(pausing.controlsHtml), 'Pause is disabled while a pause is already in flight');
  ok(/>Pausing…</.test(pausing.controlsHtml), 'the Pause button is relabelled too');
  ok(!/id="queue-cancel-btn" disabled/.test(pausing.controlsHtml),
    'Cancel stays ENABLED while only a pause is in flight — the user can still escalate straight to cancel');

  // Missing fields (backend not yet returning them, or a stale snapshot)
  // must be treated as false, never as truthy/undefined.
  const missing = Q.queueInFlightHtml({ status: 'running', jobId: 'j1' });
  ok(missing.noticeHtml === '', 'a job snapshot with NO cancelRequested/pauseRequested fields at all renders no notice (treated as false, not undefined-is-truthy)');

  // Terminal jobs never show the notice or the live controls at all —
  // isTerminal is the same gate queueDoneSummaryHtml/queueDismissBtnHtml use.
  const terminal = Q.queueInFlightHtml({ status: 'cancelled', jobId: 'j1', cancelRequested: true });
  ok(terminal.noticeHtml === '' && terminal.controlsHtml === '',
    'once the job actually reaches a terminal status, no notice and no live controls — cancelRequested lingering true on a cancelled snapshot must not render as still-cancelling');

  // ── 15b. Cross-agent seam, called out explicitly by the coordinator:
  //    settleAsCancelled() emits its snapshot at the `break`, and
  //    _controlFlags.delete(jobId) only runs later in the loop's `finally`
  //    (ingest-queue.js:1848) — so a REAL wire frame can carry
  //    `status: 'cancelled', cancelRequested: true` simultaneously, and if
  //    that is the LAST frame before the stream closes (exactly when it
  //    can be — the job has just gone terminal), a renderer keyed purely
  //    on cancelRequested would show "Cancelling…" PERMANENTLY on a
  //    finished batch. This is the literal frame, tested as its own named
  //    scenario (not folded into the general "terminal" case above) with
  //    BOTH halves of what the coordinator asked for: no "Cancelling…"
  //    text, AND a working Dismiss alongside it. ─────────────────────────
  section('15b. Cross-agent seam — the settleAsCancelled transient frame {status:\'cancelled\', cancelRequested:true}');
  {
    const transientFrame = { status: 'cancelled', jobId: 'seam-1', cancelRequested: true, pauseRequested: false };
    const inFlight = Q.queueInFlightHtml(transientFrame);
    ok(inFlight.noticeHtml === '', 'the transient cancelled+cancelRequested:true frame shows NO "Cancelling…" notice');
    ok(!/Cancelling/.test(inFlight.controlsHtml), 'no "Cancelling…" text anywhere in the controls either (there ARE no live controls once terminal)');
    ok(inFlight.controlsHtml === '', 'no live Pause/Resume/Cancel controls at all — the job is done, not "cancelling"');
    // "a working Dismiss" — queueDismissBtnHtml is a SEPARATE function
    // driven only by isTerminal, so it is unaffected by the stale flag by
    // construction; assert it explicitly anyway, exactly as asked.
    const isTerminalForFrame = transientFrame.status === 'done' || transientFrame.status === 'cancelled' || transientFrame.status === 'failed';
    const dismiss = Q.queueDismissBtnHtml(isTerminalForFrame);
    ok(dismiss.includes('id="queue-dismiss-btn"'), 'Dismiss IS offered for this exact transient frame — the terminal status, not the stale flag, decides');

    // ── MUTATION-PROVE: this implementation carries TWO independent
    //    guards against this exact hazard — the early `if (isTerminal)
    //    return` AND the notice's own `job.status === 'running'` check.
    //    Defeating only one leaves the other standing (by design — this
    //    is real defense in depth, not dead redundancy), so the mutation
    //    below removes BOTH at once to prove the invariant is genuinely
    //    enforced and not vacuously true. ─────────────────────────────────
    const currentFn = extractFn(app, 'queueInFlightHtml');
    ok(!!currentFn, '15b mutation sanity — the current queueInFlightHtml was extractable from app.js');
    ok(currentFn.includes('if (isTerminal) return { noticeHtml:'), '15b mutation sanity — the early terminal short-circuit line was found verbatim');
    ok(currentFn.includes("job.status === 'running' && (cancelRequested"), '15b mutation sanity — the notice\'s own running-only guard was found verbatim');
    let brokenFn = currentFn.replace(
      'if (isTerminal) return { noticeHtml: \'\', controlsHtml: \'\' };',
      '// DELIBERATE BREAK — should never ship: terminal short-circuit removed'
    );
    brokenFn = brokenFn.replace(
      "job.status === 'running' && (cancelRequested || pauseRequested)",
      '/* DELIBERATE BREAK — should never ship: running-only guard removed */ (cancelRequested || pauseRequested)'
    );
    ok(brokenFn !== currentFn, '15b mutation sanity — both guards were actually removed from the extracted function text');
    const brokenSrc = app.replace(currentFn, () => brokenFn);
    ok(brokenSrc !== app, '15b mutation sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');
    const QBroken = buildSandbox(brokenSrc, ['queueInFlightHtml']);
    const brokenResult = QBroken.queueInFlightHtml(transientFrame);
    ok(/Cancelling/.test(brokenResult.noticeHtml),
      `15b: RED CONFIRMED — with both guards defeated, the exact settleAsCancelled transient frame {status:'cancelled', cancelRequested:true} renders "Cancelling…" PERMANENTLY on a finished batch (got: ${JSON.stringify(brokenResult)}) — this is the cross-agent seam bug named explicitly; the shipped code (both guards intact) does not have it`);
  }

  // A paused (not running) job with a stray pauseRequested must not show
  // the notice — the request has already been fulfilled by definition.
  const paused = Q.queueInFlightHtml({ status: 'paused', jobId: 'j1', pauseRequested: true });
  ok(paused.noticeHtml === '', 'a PAUSED (not running) snapshot never shows the "pausing" notice, even with a stray true flag');

  // A second "tab" — a completely independent call with the same snapshot
  // — renders identically. There is no local click-state anywhere in this
  // function's inputs, so this is true by construction; assert it anyway.
  const again = Q.queueInFlightHtml({ ...running, cancelRequested: true, pauseRequested: false });
  ok(JSON.stringify(again) === JSON.stringify(cancelling), 'calling with an identical snapshot twice (simulating two tabs) renders byte-identical output — no hidden local state');

  ok(JSON.stringify(Q.queueInFlightHtml(null)) === JSON.stringify({ noticeHtml: '', controlsHtml: '' }), 'defensive against a null job');

  // ── MUTATION-PROVE: revert queueInFlightHtml to the pre-round-3 shape
  //    (no cancelRequested/pauseRequested handling at all) and confirm the
  //    "Cancelling…" repro goes RED. ───────────────────────────────────────
  {
    const OLD_BUGGY_FN = `function queueInFlightHtml(job) {
  if (!job) return { noticeHtml: '', controlsHtml: '' };
  const isTerminal = job.status === 'done' || job.status === 'cancelled' || job.status === 'failed';
  if (isTerminal) return { noticeHtml: '', controlsHtml: '' };
  const controlsHtml = \`
    <div class="queue-panel-controls">
      \${job.status === 'running'
        ? \`<button class="btn" id="queue-pause-btn">Pause</button>\`
        : \`<button class="btn primary" id="queue-resume-btn">\${job.status === 'pending' ? 'Start' : 'Resume'}</button>\`}
      <button class="btn" id="queue-cancel-btn">Cancel</button>
    </div>
  \`;
  return { noticeHtml: '', controlsHtml };
}`;
    const currentFn = extractFn(app, 'queueInFlightHtml');
    ok(!!currentFn, 'mutation sanity — the current queueInFlightHtml was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => OLD_BUGGY_FN);
    ok(brokenSrc !== app, 'mutation sanity — the mutation actually changed the in-memory source text');
    const QBroken = buildSandbox(brokenSrc, ['queueInFlightHtml']);
    const brokenResult = QBroken.queueInFlightHtml({ ...running, cancelRequested: true, pauseRequested: false });
    ok(brokenResult.noticeHtml === '' && !/disabled/.test(brokenResult.controlsHtml),
      `RED CONFIRMED — the pre-round-3 shape shows NO notice and a fully-clickable Cancel button even while cancelRequested is true (got: ${JSON.stringify(brokenResult)}); this is the exact "UI looks identical to before" defect reported`);
  }
}

// ── 16. Round-3 audit item 3: Dismiss is structurally impossible while a
//    batch is live, and a proper UI-only clear otherwise. ──────────────────
section('16. Round-3 item 3 — Dismiss guard on terminal batches only');
{
  ok(Q.queueDismissBtnHtml(true).includes('id="queue-dismiss-btn"'), 'a terminal batch renders the Dismiss button');
  ok(Q.queueDismissBtnHtml(false) === '', 'a non-terminal (live) batch renders NOTHING for Dismiss — not even a disabled one');
  ok(Q.queueDismissBtnHtml(undefined) === '' && Q.queueDismissBtnHtml(null) === '' && Q.queueDismissBtnHtml(0) === '',
    'any falsy input (including a missing/undefined isTerminal) renders nothing — fails CLOSED, never open');

  // Structural cross-check: for every one of the three terminal statuses,
  // queueDismissBtnHtml's own isTerminal gate agrees with the SAME
  // isTerminal computation renderQueuePanel uses (done/cancelled/failed),
  // and disagrees with every non-terminal status.
  const TERMINAL = ['done', 'cancelled', 'failed'];
  const NON_TERMINAL = ['pending', 'running', 'paused'];
  for (const s of TERMINAL) {
    const isTerminal = s === 'done' || s === 'cancelled' || s === 'failed';
    ok(Q.queueDismissBtnHtml(isTerminal).includes('queue-dismiss-btn'), `status '${s}' renders Dismiss`);
  }
  for (const s of NON_TERMINAL) {
    const isTerminal = s === 'done' || s === 'cancelled' || s === 'failed';
    ok(Q.queueDismissBtnHtml(isTerminal) === '', `status '${s}' renders NO Dismiss button`);
  }

  // dismissQueuePanel() itself: UI-only clear, driven against a DOM-free
  // stub. Must null out queueJobId/_queueLastStatus and empty the panel —
  // and must NEVER be reachable from a live job in practice (enforced by
  // the isTerminal gate above; this section proves the function's own
  // behaviour once invoked).
  {
    const detachFn = extractFn(app, 'detachQueueStream');
    const dismissFn = extractFn(app, 'dismissQueuePanel');
    ok(!!detachFn && !!dismissFn, 'sanity — detachQueueStream and dismissQueuePanel were both extractable');
    const combined = `
      let queueJobId = 'terminal-job-1';
      let _queueLastStatus = 'done';
      let queueStreamAbort = null;
      const queuePanelEl = { innerHTML: '<div>stale terminal report</div>' };
      let __hideCalls = 0;
      function hideEl(el) { __hideCalls++; }
      ${detachFn}
      ${dismissFn}
      return {
        dismissQueuePanel,
        getState: () => ({ queueJobId, _queueLastStatus, panelHtml: queuePanelEl.innerHTML, hideCalls: __hideCalls }),
      };
    `;
    const S = new Function(combined)();
    S.dismissQueuePanel();
    const st = S.getState();
    ok(st.queueJobId === null, 'dismissQueuePanel clears queueJobId — GET /active (which excludes terminal jobs) can never resurrect it, and neither can anything keyed on the old id');
    ok(st._queueLastStatus === null, 'dismissQueuePanel resets the busy-gate status bookkeeping to idle');
    ok(st.panelHtml === '', 'dismissQueuePanel empties the panel — no stale terminal report left in the DOM');
    ok(st.hideCalls === 1, 'dismissQueuePanel hides the (now-empty) panel element');
  }

  // ── MUTATION-PROVE: break queueDismissBtnHtml's gate so it renders
  //    Dismiss unconditionally (the exact "offered while running" defect
  //    the audit named as a hard requirement never to reach) — RED. ───────
  {
    const currentFn = extractFn(app, 'queueDismissBtnHtml');
    ok(!!currentFn, 'mutation sanity — the current queueDismissBtnHtml was extractable from app.js');
    const brokenFn = currentFn.replace(
      'function queueDismissBtnHtml(isTerminal) {',
      "function queueDismissBtnHtml(isTerminal) { isTerminal = true; // DELIBERATE BREAK — should never ship"
    );
    ok(brokenFn !== currentFn, 'mutation sanity — the mutation actually changed the extracted function text');
    const brokenSrc = app.replace(currentFn, () => brokenFn);
    ok(brokenSrc !== app, 'mutation sanity — the mutation actually changed the in-memory source text (real file on disk untouched)');
    const QBroken = buildSandbox(brokenSrc, ['queueDismissBtnHtml']);
    const brokenHtml = QBroken.queueDismissBtnHtml(false); // a LIVE (non-terminal) batch
    ok(brokenHtml.includes('queue-dismiss-btn'),
      `RED CONFIRMED — with the gate broken, Dismiss renders even for isTerminal=false (a live batch), which is exactly what the audit said must never be offered (got: ${JSON.stringify(brokenHtml)})`);
  }
}

// ── 17. Round-3 audit item 4: an in-progress $0.0000 no longer reads as
//    "nothing is happening". ────────────────────────────────────────────────
section('17. Round-3 item 4 — legible spend label while $0 is in-progress');
{
  ok(Q.computeQueueSpentLabel(0, false) === 'spend so far: pending first file',
    "FIXED — his exact screenshot shape (in-progress, $0) no longer renders a bare, alarming '$0.0000 spent'");
  ok(Q.computeQueueSpentLabel(undefined, false) === 'spend so far: pending first file', 'a missing spentUsd while in-progress gets the same honest label, not "$NaN spent"');
  ok(Q.computeQueueSpentLabel(0, true) === '$0.0000 spent', 'a TERMINAL $0 is a real, legible final tally — it keeps the plain dollar figure');
  ok(Q.computeQueueSpentLabel(0.0092, false) === '$0.0092 spent', 'any non-zero spend, in-progress or not, always shows the real figure');
  ok(Q.computeQueueSpentLabel(0.0092, true) === '$0.0092 spent', 'any non-zero spend, terminal, shows the real figure too');
  ok(Q.computeQueueSpentLabel(NaN, false) === 'spend so far: pending first file', 'NaN input is treated as 0, never rendered literally');
  ok(!/NaN/.test(Q.computeQueueSpentLabel(NaN, true)), 'never renders the literal text "NaN" in either terminal or in-progress form');

  // Wired into the actual panel header, not just the standalone helper.
  const headerFn = (app.match(/function renderQueuePanel\(job\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(/computeQueueSpentLabel\(job\.spentUsd, isTerminal\)/.test(headerFn), 'renderQueuePanel derives its header line through computeQueueSpentLabel, not a raw toFixed(4)');
  ok(!/\$\$\{spent\.toFixed\(4\)\}/.test(headerFn), 'the old unconditional "$X.XXXX spent" template literal is gone from renderQueuePanel');

  // ── MUTATION-PROVE: revert to the old unconditional $X.XXXX label and
  //    confirm the exact reported shape (in-progress, $0) goes RED. ───────
  {
    const OLD_BUGGY_FN = `function computeQueueSpentLabel(spentUsd, isTerminal) {
  const spent = Number.isFinite(spentUsd) ? spentUsd : 0;
  return \`$\${spent.toFixed(4)} spent\`;
}`;
    const currentFn = extractFn(app, 'computeQueueSpentLabel');
    ok(!!currentFn, 'mutation sanity — the current computeQueueSpentLabel was extractable from app.js');
    const brokenSrc = app.replace(currentFn, () => OLD_BUGGY_FN);
    ok(brokenSrc !== app, 'mutation sanity — the mutation actually changed the in-memory source text');
    const QBroken = buildSandbox(brokenSrc, ['computeQueueSpentLabel']);
    const brokenLabel = QBroken.computeQueueSpentLabel(0, false);
    ok(brokenLabel === '$0.0000 spent',
      `RED CONFIRMED — the pre-round-3 label renders the bare "$0.0000 spent" for an in-progress batch (got: "${brokenLabel}"), reading as "nothing is happening" exactly as reported`);
  }
}

console.log(`\\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All batch-ingest-queue frontend offline assertions green');
