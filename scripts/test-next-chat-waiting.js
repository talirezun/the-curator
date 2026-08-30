/**
 * test-next-chat-waiting.js — OFFLINE suite for the CHAT WAITING STATE
 * (src/public/next/views/chat.js `thinkingBodyHtml` / `startSendClock`,
 * plus views/chat.css).
 *
 * No network, no API key, no server, no browser, no LLM call. The real, live
 * functions are extracted from source by brace-matching and executed standalone
 * with `new Function` — the technique scripts/test-next-chat-cancel.js and
 * scripts/test-next-composer-model.js use for browser-side code — and the REAL
 * `progressRingHtml` is imported from shared/progress-ring.js rather than
 * stubbed, so what is asserted is the markup that actually ships.
 *
 * ── WHY THIS SURFACE EXISTS ──────────────────────────────────────────────
 * The maintainer has reported the same thing five times: he asks a question on
 * a slow model and cannot tell what is happening.
 *
 * ── A PREMISE THIS FILE USED TO ASSERT, AND WHICH IS NOW FALSE ───────────
 * The version of this header written before streaming stated flatly that chat
 * is "a SINGLE NON-STREAMING POST, so time-to-first-byte EQUALS total". That
 * was true when it was written and is not true now: with `stream: true` the
 * route emits deltas long before the answer is finished (measured on
 * `z-ai/glm-5.3-flash`: reasoning deltas from ~460ms, first CONTENT delta only
 * at 86-91% of the way through a 45-99s turn). The claim is corrected here
 * rather than quietly left standing, because a test header asserting something
 * false about the system is how the next reader reasons from the wrong model —
 * the two-comments-disagreeing shape this repo keeps re-finding.
 *
 * What survives that correction is the SHAPE of the pre-first-byte wait, which
 * is still a single call with no sub-progress. The ring now covers exactly
 * that gap, as a PRE-ROLL, and hands over to the streamed text at the first
 * delta. §8 covers the handover; §1's rule is unchanged and is now enforced
 * across BOTH occupants of the slot.
 *
 * ── THE ONE RULE THIS SUITE EXISTS TO ENFORCE ────────────────────────────
 * THE OUTER RING MUST NEVER ADVANCE. A chat turn reports no sub-progress at any
 * point, so there is no fraction to draw and no total to divide by. Any
 * advancing arc would be derived from a CLOCK rather than from work done, which
 * is exactly the dishonesty shared/progress-ring.js was built to refuse
 * (v3.9.0) and which this repo has already paid for once (v3.0.17, a user
 * reporting the app as hung because ingest's Planning phase genuinely could not
 * move a bar). Liveness is the ORBIT's job; the number on screen is the elapsed
 * clock, which is a real measurement.
 *
 * STREAMING DOES NOT WEAKEN THAT RULE, IT STRENGTHENS THE ARGUMENT FOR IT.
 * A stream gives us a token COUNT, which is the most convincing wrong
 * denominator available: `max_tokens` is a cap, not a forecast, so an arc
 * drawn from "tokens seen / max_tokens" would be an invented fraction wearing
 * a real measurement's clothes.
 *
 * §1 is that rule, and it is proven the hard way: the ring's geometry is
 * asserted BYTE-IDENTICAL at 0s, 30s and 5 minutes of elapsed time, with a
 * positive control (§1e) showing that a ring given a real `value` DOES render
 * an arc and DOES stamp `aria-valuenow` — so the absence assertions above it
 * cannot be vacuously green.
 *
 * ── WHAT IS ASSERTED, AND HOW ────────────────────────────────────────────
 * Everything below DRIVES the real extracted functions and asserts on their
 * OUTPUT. Nothing here greps chat.js for the shape of a fix — a test that
 * proves a line of source exists proves nothing about what it does (CLAUDE.md,
 * v3.0.17). The two source scans that do exist (§6b, §7) are CLASS invariants
 * over a whole file, are labelled as scans, and sit beside executed assertions
 * rather than standing in for them.
 *
 *   §0  Harness self-check — `ok()` can fail, and the sandbox resolves.
 *   §1  THE HONESTY RULE: the outer ring is empty, stationary, and carries
 *       no `aria-valuenow` — at every elapsed value. With a positive control.
 *   §2  The orbit is present, is the only thing moving, and its period is
 *       owned by CSS (there is no JS animation loop on this path).
 *   §3  The elapsed clock is patched IN PLACE, not by re-rendering the ring.
 *   §4  The measured-expectation notice: stated when we have data, silent
 *       when we do not, and escaped.
 *   §5  Accessibility: the activity-only contract, end to end.
 *   §6  Stop stays reachable, and `.abort(` stays at exactly one call site.
 *   §7  CSS: reduced motion is INHERITED from the component (not
 *       re-implemented), no px font-size, no `pring-` selector, every
 *       custom property referenced is defined.
 *   §8  THE PRE-ROLL HANDOVER: the ring covers the gap before the first
 *       delta and is REPLACED by the streamed text, the slow-turn notice is
 *       suppressed on a streaming response (and retracted if it was already
 *       painted), and the outer-ring rule survives into the stream.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { progressRingHtml, PRING_ORBIT_PERIOD_S } from '../src/public/next/shared/progress-ring.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_JS = path.join(ROOT, 'src/public/next/views/chat.js');
const CHAT_CSS = path.join(ROOT, 'src/public/next/views/chat.css');
const RING_CSS = path.join(ROOT, 'src/public/next/shared/progress-ring.css');
const chatSrc = readFileSync(CHAT_JS, 'utf8');
const cssSrc = readFileSync(CHAT_CSS, 'utf8');
const ringCssSrc = readFileSync(RING_CSS, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction (brace-matched; a desync fails LOUDLY, never silently) ─────
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in chat.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction desynced`);
  }
  return extracted;
}

/** The real shell escaper's contract. Deliberately NOT a pass-through: §4d's
 *  positive control proves an unescaped value would be observable. */
function escapeHtmlStub(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The real `formatDurationMs`, lifted from shared/model-summary.js so the
 *  clock's rendered text is the shipped one rather than a re-implementation. */
const summarySrc = readFileSync(path.join(ROOT, 'src/public/next/shared/model-summary.js'), 'utf8');
const formatDurationMs = new Function(
  extractFunction(summarySrc, 'formatDurationMs') + '\nreturn formatDurationMs;'
)();

// ── A fake DOM, only as deep as this surface actually reaches ─────────────
function makeEl(id) {
  return {
    id, textContent: '', className: '',
    _children: [], _html: '',
    // `innerHTML = ''` really does drop every child in a browser, and the
    // suppression retraction in startSendClock's tick depends on exactly that.
    // Modelled rather than stubbed, so the assertion is about the code and not
    // about a fixture that happens to agree with it.
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); if (this._html === '') this._children = []; },
    get firstChild() { return this._children[0] || null; },
    appendChild(c) { this._children.push(c); return c; },
  };
}
function makeDoc(ids) {
  const els = new Map();
  for (const id of ids) els.set(id, makeEl(id));
  return {
    els,
    getElementById: (id) => els.get(id) || null,
    createElement: () => makeEl(null),
  };
}

// ── The sandbox ──────────────────────────────────────────────────────────
// Module-level `let`s are redeclared here in the SAME scope as the extracted
// functions, so the real reassignments inside them are observable.
function sandboxWith(opts) {
  const o = opts || {};
  const doc = o.document || makeDoc([]);
  const clock = { now: o.now == null ? 0 : o.now };
  const intervals = [];
  const cleared = [];
  const api = (function build() {
    // The stream constants are read OUT OF THE SOURCE rather than re-typed, so
    // a change to either is a change the assertions below see. Re-typing them
    // would be the "expected value read from the same constant the code reads"
    // hazard's mirror image — a fixture that agrees with a stale value forever.
    const tailLines = (/const STREAM_TAIL_LINES = (\d+);/.exec(chatSrc) || [])[1];
    const tailChars = (/const STREAM_TAIL_CHARS = (\d+);/.exec(chatSrc) || [])[1];
    const src = `
      let sendStartedAt = null, sendTimerId = null, sendLatencyHint = null;
      let sendStream = null;
      const SLOW_TURN_NOTICE_AFTER_MS = ${(/const SLOW_TURN_NOTICE_AFTER_MS = (\d+);/.exec(chatSrc) || [])[1]};
      const STREAM_TAIL_LINES = ${tailLines};
      const STREAM_TAIL_CHARS = ${tailChars};
      const Date = { now: () => clock.now };
      ${extractFunction(chatSrc, 'slowTurnNoticeText')}
      ${extractFunction(chatSrc, 'slowNoticeSuppressed')}
      ${extractFunction(chatSrc, 'streamShapeKey')}
      ${extractFunction(chatSrc, 'reasoningTailText')}
      ${extractFunction(chatSrc, 'streamSlotHtml')}
      ${extractFunction(chatSrc, 'preRollRingHtml')}
      ${extractFunction(chatSrc, 'thinkingBodyHtml')}
      ${extractFunction(chatSrc, 'startSendClock')}
      ${extractFunction(chatSrc, 'stopSendClock')}
      return {
        thinkingBodyHtml, startSendClock, stopSendClock, slowTurnNoticeText,
        streamSlotHtml, streamShapeKey, reasoningTailText, slowNoticeSuppressed,
        setStarted: (v) => { sendStartedAt = v; },
        setHint: (v) => { sendLatencyHint = v; },
        setStream: (v) => { sendStream = v; },
        getStream: () => sendStream,
        getStarted: () => sendStartedAt,
        getHint: () => sendLatencyHint,
        getTimerId: () => sendTimerId,
      };
    `;
    return new Function(
      'clock', 'document', 'escapeHtml', 'formatDurationMs', 'progressRingHtml',
      'latencyHintForTurn', 'isCurrentMount', 'setInterval', 'clearInterval',
      src
    )(
      clock, doc, escapeHtmlStub, formatDurationMs, progressRingHtml,
      () => (o.hintOnStart === undefined ? null : o.hintOnStart),
      () => (o.currentMount === undefined ? true : o.currentMount),
      (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      (id) => { cleared.push(id); }
    );
  })();
  return { api, doc, clock, intervals, cleared };
}

/** Render the waiting body at a given elapsed time. */
function bodyAt(elapsedMs, hint, stream) {
  const { api, clock } = sandboxWith({ now: 1_000_000 });
  clock.now = 1_000_000;
  api.setStarted(1_000_000 - elapsedMs);
  api.setHint(hint === undefined ? null : hint);
  if (stream) api.setStream(stream);
  return api.thinkingBodyHtml();
}

/** A stream record in the shape sendCurrentMessage actually creates. */
function streamRec(over) {
  return Object.assign(
    { sse: true, seen: true, reasoning: '', content: '', reasoningView: 'tail' },
    over || {}
  );
}

/** Strip everything that legitimately varies between two renders: the orbit's
 *  phase delay and the clock's text. What remains is the RING GEOMETRY, which
 *  must not move with time. */
function ringSkeleton(html) {
  return html
    .replace(/animation-delay:-?[\d.]+s/g, 'animation-delay:PHASE')
    .replace(/(<span id="chat-think-elapsed">)[^<]*/g, '$1CLOCK');
}
const countOf = (html, re) => (html.match(re) || []).length;

console.log('\n══ test-next-chat-waiting.js — the chat waiting state ══');

// ── §0 Harness self-check ────────────────────────────────────────────────
section('§0  Harness self-check');
{
  // The control runs ok() against an ISOLATED tally rather than the real one.
  // Printing a bare ✗ here would be read as a failure by run-tests.js's output
  // scanner (the v3.3.0 / v3.7.0 shape: a suite reported skipped/failed because
  // of a word in its own log), so the proof is made without emitting one.
  const realPassed = passed, realFailed = failed;
  const silent = [];
  const origLog = console.log;
  console.log = (line) => silent.push(String(line));
  ok(false, 'control');
  console.log = origLog;
  const controlFired = failed === realFailed + 1 && silent.some(l => l.includes('control'));
  passed = realPassed; failed = realFailed;
  ok(controlFired, 'ok() genuinely increments `failed` — this suite is capable of going red');

  let threw = false;
  try { extractFunction(chatSrc, 'noSuchFunctionAnywhere'); } catch { threw = true; }
  ok(threw, 'extractFunction throws loudly on a missing function (a desync cannot pass silently)');

  const probe = bodyAt(0);
  ok(typeof probe === 'string' && probe.length > 0,
    'the sandbox resolves every binding thinkingBodyHtml needs and returns markup');
  ok(typeof progressRingHtml === 'function' && typeof formatDurationMs === 'function',
    'the REAL progressRingHtml and formatDurationMs are in play, not stubs');
}

// ── §1 THE HONESTY RULE ──────────────────────────────────────────────────
section('§1  THE HONESTY RULE — the outer ring is empty and cannot advance');
{
  const at0 = bodyAt(0);
  const at30s = bodyAt(30_000);
  const at5m = bodyAt(300_000);
  const at1h = bodyAt(3_600_000);

  // §1a — the track is there and nothing fills it, at any elapsed time.
  for (const [label, html] of [['0s', at0], ['30s', at30s], ['5m', at5m], ['1h', at1h]]) {
    ok(countOf(html, /class="pring-track"/g) === 1,
      `${label}: exactly one outer TRACK circle is drawn`);
    ok(countOf(html, /class="pring-fill"/g) === 0,
      `${label}: ZERO segment-fill circles — no stage has been claimed as done`);
    ok(countOf(html, /class="pring-arc"/g) === 0,
      `${label}: ZERO value arc — nothing draws a fraction of the ring`);
  }

  // §1b — THE MUTATION KILLER. Derive `value` (or `stages`) from the clock and
  // the geometry starts moving with time; this comparison goes red naming it.
  ok(ringSkeleton(at0) === ringSkeleton(at30s),
    '§1b the ring geometry is BYTE-IDENTICAL at 0s and 30s (only phase + clock differ)');
  ok(ringSkeleton(at0) === ringSkeleton(at5m),
    '§1b the ring geometry is BYTE-IDENTICAL at 0s and 5 minutes');
  ok(ringSkeleton(at0) === ringSkeleton(at1h),
    '§1b the ring geometry is BYTE-IDENTICAL at 0s and one hour — an hour of waiting advances nothing');

  // §1c — no percentage anywhere, for a sighted user or a screen reader.
  for (const [label, html] of [['0s', at0], ['5m', at5m]]) {
    ok(!/aria-valuenow/.test(html),
      `${label}: no aria-valuenow — the standard representation of "running, amount unknown"`);
    ok(!/\d+\s*%/.test(html.replace(/<!--[\s\S]*?-->/g, '')),
      `${label}: no percentage is rendered anywhere in the waiting markup`);
  }

  // §1d — and no centre readout either (a third framing of a quantity we do
  // not have). `center: 'none'` is passed explicitly.
  ok(countOf(at5m, /class="pring-center"/g) === 0,
    '§1d no centre glyph — there is no number to put in the middle of the ring');

  // §1e — POSITIVE CONTROL. Everything above asserts an ABSENCE, so prove the
  // detector fires: the same component, given a real value, DOES render the arc
  // and DOES stamp aria-valuenow.
  const determinate = progressRingHtml({ value: 42, size: 32, center: 'none', label: 'x' });
  ok(countOf(determinate, /class="pring-arc"/g) === 1,
    '§1e control: a ring given value:42 DOES render a pring-arc (the §1a checks are not vacuous)');
  ok(/aria-valuenow="42"/.test(determinate),
    '§1e control: a ring given value:42 DOES stamp aria-valuenow (the §1c checks are not vacuous)');
  const staged = progressRingHtml({ stages: ['a', 'b'], stage: 1, stageProgress: 0.5, size: 32 });
  ok(countOf(staged, /class="pring-fill"/g) > 0,
    '§1e control: a staged ring DOES render pring-fill circles (the §1a checks are not vacuous)');
}

// ── §2 The orbit ─────────────────────────────────────────────────────────
section('§2  The orbit is the only thing moving, and CSS owns its period');
{
  const html = bodyAt(45_000);
  ok(countOf(html, /class="pring-orbit"/g) === 1, 'exactly one orbit group is rendered');
  ok(/class="pring-orbit-dot"/.test(html), 'the orbit carries its leading dot');
  ok(countOf(html, /class="pring-settled"/g) === 0,
    'the SETTLED inner circle is absent — a turn in flight has not finished');

  // Phase continuity across re-renders is a negative animation-delay inside one
  // period. Anything outside that window would be a period change in disguise.
  const m = /animation-delay:(-?[\d.]+)s/.exec(html);
  ok(!!m, 'the orbit carries a phase delay so a re-render does not snap it to 12 o\'clock');
  const delay = m ? Number(m[1]) : NaN;
  ok(Number.isFinite(delay) && delay <= 0 && delay > -PRING_ORBIT_PERIOD_S - 0.001,
    `the phase delay (${m ? m[1] : '?'}s) sits inside ONE 1.15s period — it can shift phase, never speed`);

  // The period itself is CSS, not JS: there is no rAF loop and no duration in
  // the emitted markup. (Class scan over the shipped stylesheet.)
  ok(/\.pring-orbit\s*\{[^}]*animation:\s*curator-spin\s+1\.15s/.test(ringCssSrc),
    'shared/progress-ring.css fixes the orbit at 1.15s — the view cannot make it "look busier"');
  // ── THIS ASSERTION WAS `!/requestAnimationFrame/.test(chatSrc)` AND IS NOW
  //    NARROWER, BECAUSE THE BLANKET FORM BECAME FALSE FOR THE RIGHT REASON.
  // Streaming coalesces its paints with a single rAF, which is strictly LESS
  // work than painting on every one of 31-38 chunks per second. What the
  // original assertion was actually protecting is the thing that would be bad
  // on an element that can be on screen for minutes: a SELF-PERPETUATING loop,
  // i.e. a rAF callback that requests the next frame. So that is what is
  // asserted now — by extracting the scheduler and checking its callback body,
  // not by a blanket ban on the identifier.
  //
  // ── THIS ASSERTION WAS ITSELF DECORATIVE ON ITS FIRST DRAFT, AND WAS
  //    CAUGHT BY MUTATION RATHER THAN BY REVIEW. ─────────────────────────
  // It looked for `requestAnimationFrame` or `raf(` inside the callback body.
  // The mutation that actually creates the loop calls `schedulePaintStream`,
  // which matches neither — so the guard stayed GREEN with a self-perpetuating
  // rAF loop fully present, and the only signal was the streaming suite hanging
  // until its harness killed it. A hang is a red, but it is a red with no name
  // on it. Named now: the callback body may reference NEITHER the raw API NOR
  // the scheduler that wraps it.
  const sched = extractFunction(chatSrc, 'schedulePaintStream');
  const rafCallbackBody = /raf\(\(\) => \{([\s\S]*?)\n  \}\);/.exec(sched);
  ok(!!rafCallbackBody, 'the rAF callback body is locatable in schedulePaintStream');
  ok(rafCallbackBody && !/requestAnimationFrame|raf\(|schedulePaintStream/.test(rafCallbackBody[1]),
    'the rAF callback NEVER schedules another frame — it is a throttle, not an animation loop');
  ok(rafCallbackBody && /paintStream\(token\)/.test(rafCallbackBody[1]),
    'CONTROL: the callback really does contain the paint, so the check above is reading the right body');
  ok(/streamPaintQueued = false/.test(sched) && /if \(streamPaintQueued\) return;/.test(sched),
    'and it is guarded by a queued flag cleared inside the callback, so a quiet stream schedules nothing');
  // The blanket rule still holds everywhere else in the file: the ONLY rAF in
  // chat.js is that scheduler's own feature check and call.
  const rafSites = (chatSrc.match(/requestAnimationFrame/g) || []).length;
  const rafInSched = (sched.match(/requestAnimationFrame/g) || []).length;
  ok(rafSites === rafInSched && rafSites > 0,
    `every requestAnimationFrame in chat.js is inside schedulePaintStream (${rafInSched} of ${rafSites})`);
}

// ── §3 The elapsed clock ─────────────────────────────────────────────────
section('§3  The elapsed clock is a real measurement, patched in place');
{
  const html = bodyAt(0);
  ok(/id="chat-think-elapsed"/.test(html), 'the clock element is present from the first frame');
  ok(/<span id="chat-think-elapsed">0s<\/span>/.test(html), 'it starts at a real 0s, not blank');
  ok(/<div id="chat-think-slow">/.test(html), 'the slow-notice slot is present for the tick to fill');

  ok(/<span id="chat-think-elapsed">3m 5s<\/span>/.test(bodyAt(185_000)),
    'at 185s it reads "3m 5s" — the shipped formatter, matching ingest\'s vocabulary');

  // Drive the REAL tick. It must patch textContent and must NOT re-render the
  // ring: re-rendering would restart the orbit's phase every single second.
  const doc = makeDoc(['chat-think-elapsed', 'chat-think-slow']);
  const { api, clock, intervals, cleared } = sandboxWith({ now: 1_000_000, document: doc });
  api.startSendClock('tok');
  ok(intervals.length === 1 && intervals[0].ms === 1000, 'startSendClock arms exactly one 1s interval');
  clock.now = 1_000_000 + 7_000;
  intervals[0].fn();
  ok(doc.els.get('chat-think-elapsed').textContent === '7s',
    'the tick writes the new elapsed value straight into the clock node');
  ok(doc.els.get('chat-think-elapsed').innerHTML === '',
    'the tick never re-renders the ring — nothing writes innerHTML, so the orbit keeps its phase');

  // Idempotence + teardown.
  api.startSendClock('tok');
  ok(cleared.length >= 1, 'a second start CLEARS the first interval — two timers can never write to one node');
  api.stopSendClock();
  ok(api.getStarted() === null && api.getHint() === null && api.getTimerId() === null,
    'stopSendClock fully resets the clock (a timer outliving its turn keeps a finished answer looking unfinished)');

  // A tick belonging to an abandoned mount must not write into a later thread.
  const doc2 = makeDoc(['chat-think-elapsed', 'chat-think-slow']);
  const stale = sandboxWith({ now: 1_000_000, document: doc2, currentMount: false });
  stale.api.startSendClock('old');
  stale.clock.now = 1_000_000 + 9_000;
  stale.intervals[0].fn();
  ok(doc2.els.get('chat-think-elapsed').textContent === '',
    'a tick from a superseded mount writes NOTHING (the mount gate still holds)');
}

// ── §4 The measured-expectation notice ───────────────────────────────────
section('§4  The notice states what we measured, and stays silent when we did not');
{
  const measured = { kind: 'measured', label: 'GLM 5.3 Flash', ms: 186_000, free: false };
  const unmeasured = { kind: 'unmeasured', label: 'Some Model', lowMs: 13_000, highMs: 382_000, free: false };

  ok(!/chat-thinking-slow/.test(bodyAt(19_000, measured)),
    'below the 20s bound the notice is absent — an ordinary answer never sees it');
  const late = bodyAt(21_000, measured);
  ok(/chat-thinking-slow/.test(late), 'past the bound the notice appears');
  ok(/GLM 5\.3 Flash measured at about 3m 6s per call/.test(late),
    'it names the model and the figure we actually recorded');
  ok(/larger prompt than a chat turn/.test(late),
    'it names the workload the figure came from rather than passing it off as a prediction');

  const un = bodyAt(21_000, unmeasured);
  ok(/We have no timing measurement for Some Model/.test(un),
    'an UNMEASURED model is told so plainly — no average, no extrapolation, no borrowed sibling figure');
  ok(/13s to 6m 22s/.test(un), 'and is given the span of what we HAVE measured, as a fact about our data');

  ok(!/chat-thinking-slow/.test(bodyAt(300_000, null)),
    'a null hint yields NO claim even after five minutes — the absence rule, intact');
  ok(/id="chat-think-elapsed"/.test(bodyAt(300_000, null)),
    '...while the live clock and the orbit still run, so silence is never mistaken for a hang');

  // §4d — positive control for the escaper: a hostile label must not reach
  // markup raw, and this proves the escaping assertion above it can fire.
  const hostile = bodyAt(21_000, { kind: 'measured', label: '<img src=x onerror=alert(1)>', ms: 30_000, free: false });
  ok(!/<img src=x/.test(hostile), '§4d a hostile model label is escaped before it reaches the notice');
  ok(/&lt;img src=x/.test(hostile), '§4d ...and is present in escaped form (the check is not vacuous)');
}

// ── §5 Accessibility ─────────────────────────────────────────────────────
section('§5  The activity-only accessibility contract, end to end');
{
  const html = bodyAt(60_000);
  ok(/role="status" aria-live="polite"/.test(html),
    'the root is a polite live region — a change of phase is announced once');
  ok(/role="progressbar" aria-valuemin="0" aria-valuemax="100"/.test(html),
    'the svg is a progressbar with min/max...');
  ok(!/aria-valuenow/.test(html), '...and NO aria-valuenow, because there is no honest number');
  ok(/aria-label="Thinking…"/.test(html), 'the progressbar carries an accessible name');
  ok(/<span class="pring-sublabel mono" aria-hidden="true">/.test(html),
    'the sublabel region is aria-hidden');
  // THE ASSERTION THAT BITES: it is not enough that SOME aria-hidden region
  // exists — the CLOCK has to be the thing inside it. Move the ticking number
  // into the (readable, live-region) label and a screen reader is handed a new
  // announcement every single second for minutes.
  const subMatch = /<span class="pring-sublabel mono" aria-hidden="true">([\s\S]*?)<\/span>/.exec(html);
  ok(!!subMatch && /id="chat-think-elapsed"/.test(subMatch[1]),
    'the ticking clock sits INSIDE that aria-hidden region — not read out once a second for minutes');
  const labMatch = /<span class="pring-label"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  ok(!!labMatch && !/chat-think-elapsed/.test(labMatch[1]),
    'and NOT inside the readable label, which lives in a polite live region');
  ok(/<span class="pring-label">/.test(html) && !/<span class="pring-label" aria-hidden/.test(html),
    'the visible label stays readable to AT (activity-only rings do not double-hide it)');
  ok(!/class="chat-spinner"/.test(html),
    'the old bare spinner is gone from the waiting markup');
}

// ── §6 Stop stays reachable ──────────────────────────────────────────────
section('§6  Stop is still the way out of a long wait');
{
  const busy = new Function(
    'escapeHtml', 'icon', 'state',
    extractFunction(chatSrc, 'composerPrimaryButtonHtml') + '\nreturn composerPrimaryButtonHtml;'
  )(escapeHtmlStub, () => '', { sending: true })(true);
  ok(/aria-label="Stop"/.test(busy), 'while a turn is in flight the primary button is Stop');
  ok(!/\bdisabled\b/.test(busy), 'Stop is NEVER disabled — the wait is exactly when it is wanted');

  // §6b CLASS SCAN, labelled as one: aborting from anywhere but the Stop
  // handler would turn "navigate away" into "destroy the paid answer".
  const abortSites = (chatSrc.match(/\.abort\(/g) || []).length;
  ok(abortSites === 1, `§6b source scan: exactly one \`.abort(\` call site in chat.js (found ${abortSites})`);
  ok(/function cancelCurrentSend[\s\S]{0,900}?\.abort\(/.test(chatSrc),
    '§6b source scan: that one call site is inside cancelCurrentSend, the Stop handler');
}

// ── §7 CSS ───────────────────────────────────────────────────────────────
section('§7  The stylesheet: inherited motion, tokenised type, no reach-in');
{
  // Reduced motion is the COMPONENT's, deliberately: progress-ring.css
  // SUBSTITUTES a slow opacity breath rather than removing motion, because
  // liveness is doctrine there. A view-local `animation: none` on the orbit
  // would silently delete the one signal the waiting state depends on.
  ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.pring-orbit\s*\{[\s\S]*?pring-breathe/.test(ringCssSrc),
    'reduced motion SUBSTITUTES a breath for the orbit rather than disabling it');
  ok(!/pring-/.test(cssSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
    'chat.css declares NO `pring-` selector — the prefix stays owned by one file');

  // The clock's own rule: chat-owned id, tokenised, contrast-aware.
  const clockRule = /#chat-think-elapsed\s*\{([^}]*)\}/.exec(cssSrc);
  ok(!!clockRule, '#chat-think-elapsed carries a rule');
  ok(clockRule && /color:\s*var\(--text-2\)/.test(clockRule[1]),
    'the clock takes --text-2 (measured pass) rather than inheriting the sublabel\'s --text-3 (4.27/4.14, a fail)');
  ok(clockRule && /tabular-nums/.test(clockRule[1]),
    'tabular figures so a ticking second does not shift the glyphs beside it');
  ok(clockRule && !/font-size/.test(clockRule[1]),
    'it sets no font-size — scale stays owned by the component, and no px literal can freeze under --font-scale');

  // Class invariant over the whole file (the v3.20.0 rule).
  const decls = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const pxFont = decls.match(/font-size:\s*[^;]*?\d+px/g) || [];
  ok(pxFont.length === 0, `no hardcoded px font-size anywhere in chat.css (found ${pxFont.length})`);

  // Every custom property this change references must actually exist —
  // an undefined one fails SILENTLY at computed-value time.
  const tokenSrc = ['color.css', 'typography.css', 'motion.css', 'space.css', 'shape.css', 'base.css']
    .map(f => { try { return readFileSync(path.join(ROOT, 'src/public/next/tokens', f), 'utf8'); } catch { return ''; } })
    .join('\n');
  ok(tokenSrc.length > 500, 'the token files were actually read (a missed filename would make the sweep meaningless)');
  for (const name of ['--text-2', '--text-2xs']) {
    ok(new RegExp(`${name}\\s*:`).test(tokenSrc), `${name} is defined in the token files`);
  }
  ok(!/--text-dim/.test(cssSrc), 'chat.css references no `--text-dim` — that property does not exist');

  // The retained-but-unemitted spinner is documented, not orphaned.
  ok(/RETAINED, AND NO LONGER EMITTED/.test(cssSrc),
    '.chat-spinner\'s retention (pinned by test-next-reduced-motion.js) is recorded where the next reader will look');
}

// ── §8 The pre-roll handover ─────────────────────────────────────────────
section('§8  The ring is a PRE-ROLL, and hands over to the streamed text');
{
  // §8a — with no stream record at all (the non-streaming route, still a real
  // shipping path), the waiting state is byte-for-byte what it was.
  const plain = bodyAt(5_000);
  ok(/class="pring-track"/.test(plain), 'no stream: the ring is still the waiting state');
  ok(!/chat-stream-head/.test(plain), 'no stream: no stream region is emitted');

  // §8b — a stream that has been ACCEPTED but has produced nothing yet is
  // still the ring. `seen` is what ends the pre-roll, not `sse`.
  const accepted = bodyAt(5_000, null, streamRec({ seen: false }));
  ok(/class="pring-track"/.test(accepted),
    'headers accepted but no delta yet: the ring still covers the gap');

  // §8c — the first delta REPLACES the ring. Not "adds text beside it": a ring
  // left spinning under live text is two liveness signals for one fact.
  const streaming = bodyAt(5_000, null, streamRec({ reasoning: 'weighing the sources' }));
  ok(!/class="pring-track"/.test(streaming), 'first delta: the ring is GONE, not left spinning under the text');
  ok(/class="chat-stream-reasoning/.test(streaming), 'first delta: the reasoning region is painted');
  ok(/weighing the sources/.test(streaming), 'and it carries the model\'s actual text');
  ok(/id="chat-think-elapsed"/.test(streaming),
    'the elapsed clock SURVIVES the handover — the same id, so the tick keeps patching in place');

  // §8d — THE OUTER-RING RULE, ENFORCED INTO THE STREAM. There is no arc, no
  // aria-valuenow and no percentage anywhere once text is arriving either —
  // a token count is the most convincing wrong denominator available.
  const long = bodyAt(120_000, null, streamRec({ reasoning: 'x'.repeat(4000), content: 'partial answer' }));
  ok(!/aria-valuenow/.test(long), 'streaming: still no aria-valuenow');
  ok(!/pring-arc/.test(long), 'streaming: still no value arc');
  ok(!/\d+\s*%/.test(long), 'streaming: no percentage derived from tokens seen');

  // §8e — reasoning is ESCAPED PLAIN TEXT. Two hazards this closes, both real:
  // renderMarkdown's citation pass consuming to the NEXT `]` on a truncated
  // `[source: …` (a clickable chip pointing at the WRONG page), and partial
  // markdown restructuring the text as it grows.
  const hostile = bodyAt(5_000, null, streamRec({
    reasoning: '<img src=x onerror=alert(1)> [source: entities/wrong-page and more',
  }));
  ok(!/<img src=x/.test(hostile), 'reasoning is escaped before it reaches the markup');
  ok(/&lt;img src=x/.test(hostile), 'POSITIVE CONTROL: the payload really did reach the markup, escaped');
  ok(!/chat-citation-tag/.test(hostile),
    'a truncated `[source: …` in the reasoning produces NO citation chip — nothing is markdown-rendered here');
  ok(!/chat-wikilink/.test(hostile), 'and no wikilink either');

  // §8f — the DRAFT ANSWER is held to the same rule, for the same reasons.
  const draft = bodyAt(5_000, null, streamRec({
    content: '**bold** [source: entities/half',
  }));
  ok(/chat-stream-draft/.test(draft), 'the draft answer is painted');
  ok(!/chat-citation-tag/.test(draft), 'the draft produces no citation chip mid-stream');
  ok(!/<strong>/.test(draft), 'and no partial markdown is applied — the draft is a preview, rendered as text');
  ok(/\*\*bold\*\*/.test(draft), 'POSITIVE CONTROL: the markdown source really is present, just not rendered');

  // §8g — AUTO-COLLAPSE on the first content delta is what the renderer paints
  // when `reasoningView` is 'hidden': the summary line and a way back in, not
  // a deletion.
  const collapsed = bodyAt(38_000, null, streamRec({
    reasoning: 'a'.repeat(500), content: 'the answer so far', reasoningView: 'hidden',
  }));
  // The CLASS, not the bare string: the toggle's `aria-controls` names the same
  // id, so a substring match here would be satisfied by the very button that
  // proves the box is folded.
  ok(!/class="chat-stream-reasoning/.test(collapsed), 'collapsed: the reasoning box is not painted');
  ok(/Thought for/.test(collapsed), 'collapsed: the head becomes a past-tense summary');
  ok(/id="chat-think-elapsed"[^>]*>38s</.test(collapsed), 'and it carries how long the model thought for');
  ok(/data-stream-view="full"/.test(collapsed) && /Show reasoning/.test(collapsed),
    'collapsed: a real <button> reopens it — the scratchpad is folded, never discarded');
  ok(/<button type="button" class="chat-stream-toggle"/.test(collapsed),
    'and it is a focusable button, not a hover affordance');
  ok(/aria-expanded="false"/.test(collapsed), 'with the fold state announced to assistive tech');

  // §8h — the TAIL, not the firehose. A measured turn emits 6,687-8,385 chars
  // of reasoning at 31-38 chunks/sec; all of it live is unreadable.
  const lines = Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n');
  const tailed = bodyAt(5_000, null, streamRec({ reasoning: lines }));
  ok(/line 39/.test(tailed), 'the tail shows the NEWEST text');
  ok(!/line 0\b/.test(tailed), 'and not the whole scratchpad');
  const full = bodyAt(5_000, null, streamRec({ reasoning: lines, reasoningView: 'full' }));
  ok(/line 0\b/.test(full) && /line 39/.test(full),
    'expanded: the WHOLE scratchpad is there — the tail is a view, nothing is truncated on the way in');
  ok(/chat-stream-reasoning-full/.test(full), 'and it takes the scrollable variant');

  // §8i — THE SLOW-TURN NOTICE IS SUPPRESSED ON A STREAMING RESPONSE.
  // It quotes a TOTAL call time; the clock before the first delta measures
  // time-to-first-byte, for which no corpus exists. Silence beats a number
  // that means something other than what the reader will take it to mean.
  const measured = { kind: 'measured', label: 'GLM 5.3 Flash', ms: 186_000, free: false };
  ok(/chat-thinking-slow/.test(bodyAt(60_000, measured)),
    'CONTROL: without a stream the notice still fires at 60s, exactly as before');
  ok(!/chat-thinking-slow/.test(bodyAt(60_000, measured, streamRec({ seen: false }))),
    'on a CONFIRMED streaming response the notice is suppressed, even before any delta');
  ok(!/chat-thinking-slow/.test(bodyAt(60_000, measured, streamRec({ reasoning: 'x' }))),
    'and once text is arriving');

  // §8j — RETRACTION. A notice already painted before the SSE headers were
  // read must be REMOVED, not left standing: a claim we have decided we
  // cannot make must not survive on screen because it got there first.
  const doc = makeDoc(['chat-think-elapsed', 'chat-think-slow']);
  const s = sandboxWith({ now: 1_000_000, document: doc, hintOnStart: measured });
  s.api.startSendClock('tok');
  s.clock.now = 1_000_000 + 25_000;
  s.intervals[0].fn();
  ok(doc.els.get('chat-think-slow').firstChild !== null,
    'CONTROL: at 25s with no stream the tick really does paint the notice');
  s.api.setStream(streamRec({ seen: false }));
  s.clock.now = 1_000_000 + 26_000;
  s.intervals[0].fn();
  ok(doc.els.get('chat-think-slow').firstChild === null,
    'once the response is known to be a stream, the already-painted notice is RETRACTED');
  ok(doc.els.get('chat-think-elapsed').textContent === '26s',
    'and the clock keeps ticking through the retraction — silence is never a hang');

  // §8k — the shape key is what keeps the fast path off `renderThreadOnly`.
  // It must NOT move when only the text grows, or the slot would be re-rendered
  // 31-38 times a second, dropping the fold's listener and any text selection
  // inside it on every frame.
  const box = sandboxWith({ now: 0 });
  box.api.setStream(streamRec({ reasoning: 'abc' }));
  const k1 = box.api.streamShapeKey();
  box.api.getStream().reasoning += ' and much more text arriving';
  ok(box.api.streamShapeKey() === k1,
    '★ the shape key does NOT move when only text grows — a delta costs two textContent writes');
  box.api.getStream().content = 'answer';
  ok(box.api.streamShapeKey() !== k1, 'but it DOES move on a structural change (the answer starting)');
  box.api.setStream(null);
  ok(box.api.streamShapeKey() === 'ring', 'and with no stream it names the pre-roll');
}

// ── §9 The stream stylesheet ─────────────────────────────────────────────
section('§9  The streaming rules: on the ramp, over the AA floor, no motion');
{
  for (const sel of ['.chat-stream-head', '.chat-stream-reasoning', '.chat-stream-draft', '.chat-stream-toggle']) {
    ok(new RegExp(sel.replace('.', '\\.') + '\\s*\\{').test(cssSrc), `${sel} carries a rule`);
  }
  // Every string in the streaming bubble is --text-2. --text-3 measured
  // 4.38:1 dark / 4.00:1 light on this view's own sibling note — under the
  // 4.5:1 AA body floor — so the three voices are separated by SIZE, not by
  // dropping the recessed one below what can be read.
  for (const sel of ['.chat-stream-title', '.chat-stream-reasoning', '.chat-stream-draft', '.chat-stream-toggle']) {
    const rule = new RegExp(sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}').exec(cssSrc);
    ok(!!rule && /var\(--text-2\)/.test(rule[1]), `${sel} takes --text-2`);
    ok(!!rule && !/var\(--text-3\)|--text-faint/.test(rule[1]), `${sel} does NOT drop below the AA floor`);
  }
  // NOTHING ANIMATES. test-next-reduced-motion.js pins this file at exactly one
  // hardcoded-duration animation (.chat-spinner); a blinking caret would break
  // that suite AND add motion a reader has to look past to read live text.
  const streamBlock = cssSrc.slice(cssSrc.indexOf('.chat-stream {'), cssSrc.indexOf('/* ── RETAINED'));
  ok(streamBlock.length > 200, 'control: the streaming block was actually located in the stylesheet');
  ok(!/animation/.test(streamBlock), 'no animation anywhere in the streaming rules — no caret, no pulse');
  ok(!/font-size:\s*[^;]*\d+px/.test(streamBlock), 'no px font-size (it would freeze at 1x under --font-scale)');
  // The expanded scratchpad scrolls INSIDE ITS OWN BLOCK. v3.0.14: a flex item
  // whose overflow is not `visible` resolves its automatic min-height to 0,
  // which is how the compile card came to be squeezed to nothing.
  const fullRule = /\.chat-stream-reasoning-full\s*\{([^}]*)\}/.exec(cssSrc);
  ok(!!fullRule && /overflow-y:\s*auto/.test(fullRule[1]) && /max-height/.test(fullRule[1]),
    'the expanded scratchpad caps and scrolls itself rather than an ancestor');
  const threadRule = /\.chat-thread\s*\{([^}]*)\}/.exec(cssSrc);
  ok(!!threadRule && !/overflow/.test(threadRule[1]),
    '.chat-thread — which IS a flex item — still sets no overflow of its own');
}

console.log(`\n────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
