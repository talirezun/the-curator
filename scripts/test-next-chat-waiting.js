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
 * a slow model and cannot tell what is happening. Chat is a SINGLE
 * NON-STREAMING POST, so time-to-first-byte EQUALS total — measured at 186s on
 * `z-ai/glm-5.3-flash` — and nothing can appear on screen until the whole
 * answer is done. Streaming is a separate release; the wait itself is what this
 * surface handles.
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
    id, textContent: '', innerHTML: '', className: '',
    _children: [],
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
    const src = `
      let sendStartedAt = null, sendTimerId = null, sendLatencyHint = null;
      const SLOW_TURN_NOTICE_AFTER_MS = ${(/const SLOW_TURN_NOTICE_AFTER_MS = (\d+);/.exec(chatSrc) || [])[1]};
      const Date = { now: () => clock.now };
      ${extractFunction(chatSrc, 'slowTurnNoticeText')}
      ${extractFunction(chatSrc, 'thinkingBodyHtml')}
      ${extractFunction(chatSrc, 'startSendClock')}
      ${extractFunction(chatSrc, 'stopSendClock')}
      return {
        thinkingBodyHtml, startSendClock, stopSendClock, slowTurnNoticeText,
        setStarted: (v) => { sendStartedAt = v; },
        setHint: (v) => { sendLatencyHint = v; },
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
function bodyAt(elapsedMs, hint) {
  const { api, clock } = sandboxWith({ now: 1_000_000 });
  clock.now = 1_000_000;
  api.setStarted(1_000_000 - elapsedMs);
  api.setHint(hint === undefined ? null : hint);
  return api.thinkingBodyHtml();
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
  ok(!/requestAnimationFrame/.test(chatSrc),
    'chat.js runs no requestAnimationFrame loop (this element can be on screen for minutes)');
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

console.log(`\n────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
