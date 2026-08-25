/**
 * test-next-progress-ring.js — OFFLINE suite for the ported design-system
 * ProgressRing (src/public/next/shared/progress-ring.js +
 * shared/progress-ring.css) and its adoption in views/ingest.js and
 * views/domains.js.
 *
 * No network, no API key, no server, no browser. Every decision the
 * component makes — geometry, segment fill, value arc, centre text, tone,
 * ARIA, the orbit's phase offset, and the map from ingest's real pct onto
 * its real phases — is a pure function with no DOM, extracted from the REAL
 * source by brace-matching and executed standalone with `new Function`
 * (the technique scripts/test-next-onboarding.js and
 * scripts/test-chat-markdown.js already use).
 *
 * ── THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────────────
 * §4, THE HONESTY INVARIANT. The component's own prompt file states it:
 *
 *   "The outer layer is the truth. A segment only fills when that stage
 *    genuinely advances. If a stage reports nothing while it runs, leave
 *    stageProgress at 0 — the segment stays empty and that is correct.
 *    ...never speed the orbit up to imply progress, and never advance the
 *    outer ring to look busy."
 *
 * That is not a style note. It is the reason the component exists, and
 * this codebase has already paid for the inversion once (v3.0.17: a user
 * reported the app as hung because ingest's Phase 1 is ONE LLM call with
 * no sub-progress and the bar genuinely could not move). §4 proves three
 * separate things: a live stage at stageProgress 0 renders NO fill; the
 * fill is a function of stageProgress ALONE; and neither the module nor
 * its stylesheet contains any clock/elapsed/orbit term that outer-ring
 * fill could be derived from.
 *
 * ── COVERED, behaviourally (the real function runs) ─────────────────────
 *   - ringGeometry across every size the design names (16/20/32/48/72)
 *     plus defensive input.
 *   - ringSegments for representative stages/stage/stageProgress combos,
 *     including out-of-range and non-numeric stageProgress.
 *   - ringValueArc: value null -> no arc at all; 0/50/100; clamping.
 *   - ringCenterText for all four `center` modes and the <40px suppression.
 *   - ringToneClass, isRingComplete (incl. the `complete:true` override),
 *     ringAria (determinate vs not), orbitDelaySeconds, ringValueFromCounts.
 *   - mapIngestPctToStage against the ACTUAL pct values src/brain/ingest.js
 *     emits, read out of that file in §7 so the map cannot silently drift
 *     away from the server.
 *   - progressRingHtml end-to-end: markup, escaping, ARIA, the finished
 *     state, the decorative in-button case.
 *
 * ── COVERED as source-level guards (stated as such, not as behaviour) ───
 *   - A `prefers-reduced-motion` block exists in the stylesheet and it
 *     actually targets the orbit.
 *   - Every `var(--x)` in progress-ring.css resolves to a token defined in
 *     tokens/*.css or in progress-ring.css itself. (scripts/test-css-tokens.js
 *     discovers stylesheets through next/index.html's <link> tags; this
 *     file is not linked there yet — see the report — so the check is done
 *     here rather than left to a suite that cannot see the file.)
 *   - `pring-` is owned: it appears in no other /next stylesheet.
 *   - No requestAnimationFrame / setInterval / setTimeout anywhere in the
 *     module (this element is on screen for minutes).
 *   - No `prefers-color-scheme` in the stylesheet (`[data-theme]` only).
 *   - The two views import the module and no longer render the bars they
 *     replaced, and ingest keeps the #ing-elapsed id its clock tick patches.
 *
 * ── NOT COVERED here (stated rather than implied) ───────────────────────
 *   - Anything visual: stroke rendering, whether the orbit reads as smooth
 *     across a re-render, colour in either theme. Browser-verified instead,
 *     and that verification is not reproducible from here.
 *   - The SSE plumbing in domains.js/ingest.js is checked as source
 *     ordering, not executed — those functions touch fetch and the DOM.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const RING_PATH = path.join(ROOT, 'src/public/next/shared/progress-ring.js');
const ring = readFileSync(RING_PATH, 'utf8');
const ringCss = readFileSync(path.join(ROOT, 'src/public/next/shared/progress-ring.css'), 'utf8');
const ingestJs = readFileSync(path.join(ROOT, 'src/public/next/views/ingest.js'), 'utf8');
const ingestCss = readFileSync(path.join(ROOT, 'src/public/next/views/ingest.css'), 'utf8');
const domainsJs = readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
const brainIngest = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');

// ── Comment stripping for the source guards ─────────────────────────────
// Every ABSENCE check below has to run against CODE, because this module's
// header and its stylesheet's header deliberately QUOTE the very strings
// being asserted absent while explaining why they are absent ("never speed
// the orbit up", "there must never be one" about rAF, and the removed
// `.ing-progress-fill` class names). Run against raw text those guards
// would be reading a comment — this repo's named failure shape, "a check
// that stopped reaching the thing it protects".
//
// ORDER IS LOAD-BEARING and matches scripts/test-next-onboarding.js: line
// comments FIRST. These files contain `/next` and `and/or`-style slashes
// inside // comments; strip blocks first and a stray `/*` inside one of
// them opens a fake block comment that runs on until the next `*/`,
// swallowing real code. assertStrippedSane is the tripwire for exactly
// that, and it is why the anchors below are structural declarations that
// no assertion elsewhere in this file also tests.
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

const ringCode = assertStrippedSane(stripComments(ring), 'progress-ring.js', [
  'export function ringGeometry(size)',
  'export function ringSegments(opts)',
  'export function progressRingHtml(opts)',
  'export function mapIngestPctToStage(pct)',
]);
const ringCssCode = assertStrippedSane(stripComments(ringCss), 'progress-ring.css', [
  '.pring {',
  '.pring-orbit {',
]);
const ingestCode = assertStrippedSane(stripComments(ingestJs), 'ingest.js', [
  'function renderProgress()',
  'function updateQueueItemProgress(idx, pct, message)',
]);
const ingestCssCode = assertStrippedSane(stripComments(ingestCss), 'ingest.css', ['.ing-progress {']);
const domainsCode = assertStrippedSane(stripComments(domainsJs), 'domains.js', [
  'function renderAiProgressRing()',
  'function noteAiProgress(key, ev)',
]);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function close(actual, expected, label, tol = 1e-9) {
  ok(Math.abs(actual - expected) < tol, `${label} (got ${actual}, expected ~${expected})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extract the pure functions from the real source ──────────────────────
// Brace-matched, so nested braces in a body cannot truncate the extraction.
// A missing name THROWS rather than silently testing nothing.
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in progress-ring.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  // Skip the PARAMETER LIST before hunting for the body brace — a
  // destructured parameter would otherwise latch the brace-matcher onto the
  // parameter pattern and "end" the function at the closing paren.
  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
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
  // Desync tripwire: a truncated extraction must fail LOUDLY here rather
  // than later as a confusing SyntaxError out of new Function().
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

/** Stops at the first `;` that ends a LINE, allowing a trailing // comment
 *  after it. The tripwire turns a desync into a named failure. */
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)(?:export\\s+)?const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in progress-ring.js`);
  const extracted = m[0].trim().replace(/^export\s+/, '');
  if (/\bfunction\s/.test(extracted)) {
    throw new Error(`extractConst: "${name}" extraction swallowed a function — the terminator desynced`);
  }
  return extracted;
}

const PURE_FNS = [
  'ringGeometry', 'isSegmented', 'isRingComplete', 'ringSegments',
  'ringValueArc', 'ringCenterText', 'ringToneClass', 'ringAria',
  'orbitDelaySeconds', 'mapIngestPctToStage', 'ringValueFromCounts',
  'esc', 'attr', 'progressRingHtml',
];
const PURE_CONSTS = ['PRING_ORBIT_PERIOD_S', 'INGEST_STAGES'];

const sandbox = new Function(
  PURE_CONSTS.map((c) => extractConst(ring, c)).join('\n') + '\n' +
  PURE_FNS.map((n) => extractFunction(ring, n)).join('\n\n') + '\n' +
  `return { ${PURE_FNS.join(', ')}, ${PURE_CONSTS.join(', ')} };`
)();

const {
  ringGeometry, isSegmented, isRingComplete, ringSegments, ringValueArc,
  ringCenterText, ringToneClass, ringAria, orbitDelaySeconds,
  mapIngestPctToStage, ringValueFromCounts, progressRingHtml,
  PRING_ORBIT_PERIOD_S, INGEST_STAGES,
} = sandbox;

// ═════════════════════════════════════════════════════════════════════════
section('§1  Geometry — ported verbatim, at every size the design names');
// ═════════════════════════════════════════════════════════════════════════
{
  // The design's five sizes: 16 in a button · 20 row · 32 compact ·
  // 48 readout · 72 empty state.
  for (const size of [16, 20, 32, 48, 72]) {
    const g = ringGeometry(size);
    ok(g.size === size, `size ${size}: preserved`);
    ok(g.stroke === Math.max(2.5, Math.round(size * 0.09)), `size ${size}: stroke matches the design formula`);
    ok(g.rIn < g.rOut, `size ${size}: the inner (liveness) radius sits inside the outer (work) radius`);
    ok(g.rOut > 0, `size ${size}: outer radius is positive`);
    close(g.cOut, 2 * Math.PI * g.rOut, `size ${size}: outer circumference`);
  }
  // 16px is the smallest the design uses; the inner radius must still be
  // drawable or the in-button ring renders as a dot with a negative-radius
  // circle (which SVG treats as an error and skips silently).
  ok(ringGeometry(16).rIn > 0, 'at 16px (the in-button size) the inner radius is still positive — the orbit is drawable');

  const d = ringGeometry(undefined);
  eq(d.size, 48, 'a missing size falls back to the 48px readout size');
  eq(ringGeometry(0).size, 48, 'size 0 falls back rather than producing a zero-radius ring');
  eq(ringGeometry('nonsense').size, 48, 'a non-numeric size falls back');
  eq(ringGeometry(-10).size, 48, 'a negative size falls back');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  Segments — one per stage, in order, at the right angles');
// ═════════════════════════════════════════════════════════════════════════
{
  const stages = ['Reading', 'Planning', 'Entities', 'Concepts', 'Merging'];
  const segs = ringSegments({ stages, stage: 2, stageProgress: 0.5, size: 48 });
  eq(segs.length, 5, 'five stages produce five segments');
  eq(segs[0].rotate, -90, 'the first segment starts at 12 o\'clock (-90°)');
  eq(segs[1].rotate, -90 + 72, 'the second segment is one fifth further round');
  eq(segs[4].rotate, -90 + 4 * 72, 'the fifth segment is four fifths round');
  eq(segs.map((s) => s.state).join(','), 'done,done,live,todo,todo',
    'stages before the live one are done, after it are todo');
  eq(segs[0].fillDash, segs[0].trackDash, 'a completed segment is fully filled');
  eq(segs[3].fillDash, null, 'a not-yet-started segment has no fill element at all');
  close(segs[2].fillDash, segs[2].trackDash * 0.5, 'the live segment is filled to stageProgress');

  eq(ringSegments({ stages: null }).length, 0, 'no stages -> no segments');
  eq(ringSegments({ stages: [] }).length, 0, 'an empty stages array -> no segments');
  eq(ringSegments({}).length, 0, 'a missing opts field is survivable');
  eq(ringSegments().length, 0, 'no arguments at all is survivable');

  // Defensive: a malformed frame must not take the ring down or produce a
  // NaN dasharray (which silently renders nothing).
  const bad = ringSegments({ stages, stage: 1, stageProgress: 'x', size: 48 });
  eq(bad[1].fillDash, 0, 'a non-numeric stageProgress is treated as 0, not NaN');
  const over = ringSegments({ stages, stage: 1, stageProgress: 4.2, size: 48 });
  eq(over[1].fillDash, over[1].trackDash, 'stageProgress above 1 clamps to a full segment');
  const under = ringSegments({ stages, stage: 1, stageProgress: -3, size: 48 });
  eq(under[1].fillDash, 0, 'a negative stageProgress clamps to 0');

  // Finished: stage === stages.length means every segment is done and none
  // is live.
  const doneSegs = ringSegments({ stages, stage: 5, stageProgress: 0, size: 48 });
  ok(doneSegs.every((s) => s.state === 'done'), 'stage === stages.length marks every segment done');
  ok(doneSegs.every((s) => s.fillDash === s.trackDash), 'every finished segment is fully filled');

  // Segments plus their gaps must fit the circle, or they overlap.
  const total = segs.reduce((a, s) => a + s.trackDash, 0);
  ok(total < ringGeometry(48).cOut, 'the segments plus their gaps fit inside the circumference (no overlap)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  The unstaged arc, and `value: null` = activity only');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(ringValueArc({ value: null, size: 32 }), null, 'value null produces NO arc — the ring is track plus orbit only');
  eq(ringValueArc({ size: 32 }), null, 'an absent value produces no arc');
  eq(ringValueArc({ value: 'x', size: 32 }), null, 'a non-numeric value produces no arc rather than a NaN offset');

  const g = ringGeometry(32);
  const zero = ringValueArc({ value: 0, size: 32 });
  close(zero.dashOffset, g.cOut, 'value 0 leaves the arc completely un-swept');
  const half = ringValueArc({ value: 50, size: 32 });
  close(half.dashOffset, g.cOut * 0.5, 'value 50 sweeps half the circle');
  const full = ringValueArc({ value: 100, size: 32 });
  close(full.dashOffset, 0, 'value 100 sweeps the whole circle');
  close(ringValueArc({ value: 250, size: 32 }).dashOffset, 0, 'a value above 100 clamps');
  close(ringValueArc({ value: -40, size: 32 }).dashOffset, g.cOut, 'a value below 0 clamps');

  // value 0 is NOT the same as value null, and conflating them is how an
  // "unknown" turns into a claimed "nothing done yet".
  ok(ringValueArc({ value: 0, size: 32 }) !== null,
    'value 0 is a real arc element (a known zero) while value null is none (an unknown) — the two are distinct');

  const html = progressRingHtml({ value: null, size: 32, label: 'Checking sync status…' });
  ok(!html.includes('pring-arc'), 'activity-only markup contains NO filled arc element');
  ok(html.includes('pring-orbit'), 'activity-only markup still contains the orbit');
  ok(html.includes('pring-track'), 'activity-only markup still contains the track');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  THE HONESTY INVARIANT — a stage that reports nothing shows nothing');
// ═════════════════════════════════════════════════════════════════════════
{
  const stages = INGEST_STAGES;

  // (a) The behavioural core. Planning is ONE LLM call with no sub-progress
  //     — the phase v3.0.17 was reported as hung on. It must render EMPTY.
  const segs = ringSegments({ stages, stage: 2, stageProgress: 0, size: 48 });
  eq(segs[2].state, 'live', 'the Planning segment is the live one');
  eq(segs[2].fillDash, 0,
    'A LIVE STAGE AT stageProgress 0 HAS ZERO FILL — no minimum, no nudge, no "it looks broken" floor');
  ok(segs[2].trackDash > 0, 'its track is still drawn, so the segment is visible as an empty slot');

  const html = progressRingHtml({ stages, stage: 2, stageProgress: 0, size: 48, label: 'Planning…' });
  ok(!/class="pring-fill"[^>]*stroke-dasharray="0\.[1-9]/.test(html),
    'the emitted markup carries no fabricated partial fill for the live stage');
  ok(html.includes('pring-orbit'),
    'the ORBIT is present while the outer ring is empty — liveness is what carries a silent phase');

  // (b) The fill is a function of stageProgress and NOTHING else. Same
  //     stage, same size, same everything — only stageProgress differs, and
  //     the fill must track it exactly and monotonically.
  const fills = [0, 0.25, 0.5, 0.75, 1].map(
    (sp) => ringSegments({ stages, stage: 1, stageProgress: sp, size: 48 })[1].fillDash);
  for (let i = 1; i < fills.length; i++) {
    ok(fills[i] > fills[i - 1], `fill is strictly increasing in stageProgress (${fills[i - 1]} -> ${fills[i]})`);
  }
  const trackLen = ringSegments({ stages, stage: 1, stageProgress: 0, size: 48 })[1].trackDash;
  close(fills[2], trackLen * 0.5, 'fill is exactly proportional to stageProgress — no curve, no easing, no floor');

  // (c) Calling the SAME inputs twice, at two different wall-clock moments,
  //     must give byte-identical outer-ring geometry. If elapsed time ever
  //     leaked into the fill, this is what would catch it.
  const a = JSON.stringify(ringSegments({ stages, stage: 2, stageProgress: 0, size: 48 }));
  const spinUntil = Date.now() + 12;
  while (Date.now() < spinUntil) { /* burn a measurable amount of wall clock */ }
  const b = JSON.stringify(ringSegments({ stages, stage: 2, stageProgress: 0, size: 48 }));
  eq(a, b, 'the outer ring is byte-identical across a real passage of wall-clock time — it cannot be time-derived');

  // (d) Source guard, complementary to (a)–(c): the fill path has no access
  //     to a clock or to the orbit in the first place.
  const segFn = extractFunction(ring, 'ringSegments');
  ok(segFn.length > 300, 'sanity: ringSegments extracted (a truncated extract would pass the absence checks vacuously)');
  for (const banned of ['Date.now', 'performance.now', 'elapsed', 'orbit', 'Math.random']) {
    ok(!segFn.includes(banned), `ringSegments contains no reference to \`${banned}\``);
  }

  // (e) The orbit's period is a constant and is never a function of
  //     progress — "never speed it up to imply progress".
  eq(PRING_ORBIT_PERIOD_S, 1.15, 'the orbit period is the design\'s constant 1.15s');
  const delayFn = extractFunction(ring, 'orbitDelaySeconds');
  for (const banned of ['stage', 'value', 'progress']) {
    ok(!delayFn.includes(banned), `orbitDelaySeconds cannot see \`${banned}\` — phase only, never rate`);
  }
  ok(/animation:\s*curator-spin\s+1\.15s/.test(ringCssCode),
    'the stylesheet hard-codes the 1.15s period on .pring-orbit — it is not a variable something could re-point');
  ok(!/animation-duration/.test(ringCssCode.replace(/@media[\s\S]*$/, '')),
    'nothing outside the reduced-motion block overrides the orbit duration');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  The finished state — the orbit stops and the ring settles');
// ═════════════════════════════════════════════════════════════════════════
{
  const stages = INGEST_STAGES;
  ok(isRingComplete({ stages, stage: 5 }), 'stage === stages.length is complete');
  ok(!isRingComplete({ stages, stage: 4 }), 'the last stage still in flight is NOT complete');
  ok(isRingComplete({ value: 100 }), 'value 100 is complete');
  ok(!isRingComplete({ value: 99.4 }), 'value just under 100 is not complete');
  ok(!isRingComplete({ value: null }), 'activity-only is never complete');
  ok(!isRingComplete({}), 'an empty opts object is not complete');
  ok(isRingComplete({ value: 40, complete: true }),
    'the explicit `complete` override wins — a cancelled batch stops orbiting even though its count never reaches 100');
  ok(!isRingComplete({ value: 40, complete: 'yes' }),
    'the override is strictly `true`; a truthy string does not stop the orbit by accident');

  const done = progressRingHtml({ stages, stage: 5, size: 32, tone: 'success' });
  ok(!done.includes('pring-orbit'), 'the finished ring contains NO orbit — nothing is still moving');
  ok(done.includes('pring-settled'), 'the finished ring carries the settled inner circle instead');
  ok(done.includes('pring-complete'), 'the finished ring is class-marked so a caller can style the settle frame');
  ok(done.includes('pring-tone-success'), 'tone="success" reaches the markup');

  const live = progressRingHtml({ stages, stage: 3, stageProgress: 0.2, size: 32 });
  ok(live.includes('pring-orbit'), 'an unfinished ring still orbits');
  ok(!live.includes('pring-settled'), 'an unfinished ring has no settled circle');

  const cancelled = progressRingHtml({ value: 40, complete: true, size: 32 });
  ok(!cancelled.includes('pring-orbit'), 'a cancelled batch (complete override, value 40) stops orbiting');
  ok(cancelled.includes('aria-valuenow="40"'), '…while still reporting its TRUE value of 40, not a rounded-up 100');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  Centre text, tone, ARIA and the orbit phase offset');
// ═════════════════════════════════════════════════════════════════════════
{
  const stages = INGEST_STAGES;
  eq(ringCenterText({ stages, stage: 1, stageProgress: 0.4, size: 48 }), '2/5', 'auto + stages prints "2/5"');
  eq(ringCenterText({ stages, stage: 1, stageProgress: 0, size: 48 }), '1/5',
    'a stage that has not reported yet does not count itself as started in the centre readout');
  eq(ringCenterText({ stages, stage: 5, stageProgress: 0, size: 48 }), '5/5', 'the finished readout is "5/5"');
  eq(ringCenterText({ value: 67.6, size: 48 }), '68', 'auto + value prints the rounded number');
  eq(ringCenterText({ value: null, size: 48 }), null, 'activity-only prints nothing in the centre');
  eq(ringCenterText({ stages, stage: 1, size: 48, center: 'none' }), null, 'center "none" prints nothing');
  eq(ringCenterText({ stages, stage: 1, stageProgress: 0.4, size: 32 }), null,
    'the centre readout is suppressed below 40px — illegible at row and button sizes');
  eq(ringCenterText({ value: 50, size: 20 }), null, 'suppressed at the 20px row size too');
  eq(ringCenterText({ stages: null, size: 48, center: 'stage' }), null, 'center "stage" with no stages prints nothing');
  eq(ringCenterText({ value: null, size: 48, center: 'value' }), null, 'center "value" with no value prints nothing');

  eq(ringToneClass('accent'), 'pring-tone-accent', 'tone accent');
  eq(ringToneClass('success'), 'pring-tone-success', 'tone success');
  eq(ringToneClass('attention'), 'pring-tone-attention', 'tone attention');
  eq(ringToneClass(undefined), 'pring-tone-accent', 'an absent tone falls back to accent');
  eq(ringToneClass('danger'), 'pring-tone-accent', 'an unrecognised tone falls back to accent, never to no class');

  const ar = ringAria({ stages, stage: 2, stageProgress: 0.5, size: 48 });
  ok(ar.determinate, 'a staged ring is determinate');
  eq(ar.valueNow, 50, '2.5 of 5 stages reads as 50%');
  eq(ringAria({ stages, stage: 5 }).valueNow, 100, 'the finished staged ring reads as 100%');
  eq(ringAria({ stages, stage: 0, stageProgress: 0 }).valueNow, 0, 'a just-started staged ring reads as 0%');
  const ind = ringAria({ value: null });
  ok(!ind.determinate, 'activity-only is indeterminate');
  eq(ind.valueNow, null, 'indeterminate reports NO aria-valuenow — it does not invent a number');
  eq(ringAria({ value: 67.6 }).valueNow, 68, 'a plain value rounds for ARIA');
  eq(ringAria({ value: 'x' }).valueNow, null, 'a non-numeric value is indeterminate, not NaN');

  // orbitDelaySeconds: phase continuity across a re-render.
  eq(orbitDelaySeconds(0), -0, 'a zero clock gives a zero offset');
  close(orbitDelaySeconds(500), -0.5, 'half a second in gives a −0.5s offset');
  close(orbitDelaySeconds(1150), -0, 'exactly one period wraps back to 0');
  close(orbitDelaySeconds(1400), -0.25, 'a second into the cycle wraps within the period');
  ok(orbitDelaySeconds(999999) <= 0 && orbitDelaySeconds(999999) > -PRING_ORBIT_PERIOD_S,
    'the offset always lands inside one period, whatever the clock');
  eq(orbitDelaySeconds('x'), 0, 'a non-numeric clock is survivable');
  eq(orbitDelaySeconds(-5), 0, 'a negative clock is survivable');

  eq(ringValueFromCounts(0, 10), 0, 'processed 0 of 10 is a real 0');
  eq(ringValueFromCounts(5, 10), 50, '5 of 10 is 50');
  eq(ringValueFromCounts(10, 10), 100, '10 of 10 is 100');
  eq(ringValueFromCounts(3, 0), null, 'a zero total is unknown, not a divide-by-zero');
  eq(ringValueFromCounts(null, 10), null, 'a missing count is unknown');
  eq(ringValueFromCounts(undefined, undefined), null, 'nothing reported is unknown');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  The ingest phase map, checked against src/brain/ingest.js itself');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(INGEST_STAGES.length, 5, 'five stages');
  eq(INGEST_STAGES.join(','), 'Saving,Extracting,Planning,Writing,Merging', 'the stage names, in server order');

  // These are the literal pct values src/brain/ingest.js passes to
  // progress(). Read from that file so the map cannot drift away from the
  // server without this suite noticing — a hard-coded expectation here
  // would pass forever after the backend changed.
  const emitted = [...brainIngest.matchAll(/\bprogress\((\d+),/g)].map((m) => Number(m[1]));
  ok(emitted.length >= 8, `sanity: found ${emitted.length} literal progress() pct values in src/brain/ingest.js`);
  for (const p of [4, 8, 10, 12, 13, 15, 90, 93, 96, 100]) {
    ok(emitted.includes(p), `src/brain/ingest.js still emits pct ${p} (the map is built on it)`);
  }
  for (const p of emitted) {
    const r = mapIngestPctToStage(p);
    ok(Number.isFinite(r.stage) && r.stage >= 0 && r.stage <= 5,
      `pct ${p} maps to a stage in range (got ${r.stage})`);
    ok(r.stageProgress >= 0 && r.stageProgress <= 1, `pct ${p} maps to a stageProgress in 0..1`);
  }

  eq(mapIngestPctToStage(4).stage, 0, 'pct 4 ("Saving source file…") is stage 0');
  eq(mapIngestPctToStage(4).stageProgress, 0, '…and reports nothing within itself');
  eq(mapIngestPctToStage(8).stage, 1, 'pct 8 ("Extracting text…") is stage 1');
  eq(mapIngestPctToStage(8).stageProgress, 0, '…and reports nothing within itself');

  // THE ONE THAT MATTERS: every pct the planning phase can send maps to a
  // live stage with ZERO progress, because it is one LLM call.
  for (const p of [10, 12, 13, 15, 19]) {
    const r = mapIngestPctToStage(p);
    eq(r.stage, 2, `pct ${p} is the Planning stage`);
    eq(r.stageProgress, 0,
      `pct ${p} reports NOTHING within Planning — one LLM call, no sub-progress (the v3.0.17 phase)`);
  }

  // The only band with genuine sub-progress: 20 + (batch/total)*58.
  const b1of4 = Math.round(20 + (1 / 4) * 58);
  const b4of4 = Math.round(20 + (4 / 4) * 58);
  eq(mapIngestPctToStage(b1of4).stage, 3, 'batch 1 of 4 is the Writing stage');
  ok(mapIngestPctToStage(b1of4).stageProgress > 0.2 && mapIngestPctToStage(b1of4).stageProgress < 0.3,
    'batch 1 of 4 is roughly a quarter through the Writing stage — a REAL fraction from the server');
  close(mapIngestPctToStage(b4of4).stageProgress, 1, 'the last batch fills the Writing stage', 0.02);
  ok(mapIngestPctToStage(b1of4).stageProgress < mapIngestPctToStage(b4of4).stageProgress,
    'later batches are further through the stage');

  eq(mapIngestPctToStage(90).stage, 4, 'pct 90 ("Writing pages to disk") is the Merging stage');
  eq(mapIngestPctToStage(90).stageProgress, 0, '…starting at 0');
  close(mapIngestPctToStage(93).stageProgress, 0.3, '…backlinks are 30% through it');
  close(mapIngestPctToStage(96).stageProgress, 0.6, '…the index update is 60% through it');
  eq(mapIngestPctToStage(100).stage, 5, 'pct 100 is stage 5 === stages.length, i.e. complete');
  ok(isRingComplete({ stages: INGEST_STAGES, stage: mapIngestPctToStage(100).stage }),
    'pct 100 therefore stops the orbit');

  // Defensive — a malformed SSE frame must not take the progress display down.
  eq(mapIngestPctToStage(undefined).stage, 0, 'an absent pct clamps to the start');
  eq(mapIngestPctToStage('x').stage, 0, 'a non-numeric pct clamps to the start');
  eq(mapIngestPctToStage(-40).stage, 0, 'a negative pct clamps to the start');
  eq(mapIngestPctToStage(9999).stage, 5, 'an over-range pct clamps to complete');

  // The map is monotonic: pct can only ever move the ring FORWARD.
  let prev = -1;
  for (let p = 0; p <= 100; p++) {
    const r = mapIngestPctToStage(p);
    const linear = r.stage + r.stageProgress;
    ok(linear >= prev, `pct ${p}: the ring never moves backwards`);
    prev = linear;
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  Markup, escaping and the accessibility contract');
// ═════════════════════════════════════════════════════════════════════════
{
  const stages = INGEST_STAGES;
  const html = progressRingHtml({
    stages, stage: 1, stageProgress: 0.4, size: 48,
    label: 'Planning the decomposition…',
    sublabel: 'stage 2 of 5 · 0:38 · Gemini 2.5 Flash Lite',
  });
  ok(html.startsWith('<span class="pring '), 'the root is a .pring span');
  ok(html.includes('<svg class="pring-svg"'), 'the ring is an inline svg');
  ok(html.includes('role="progressbar"'), 'the svg is a progressbar');
  ok(html.includes('aria-valuemin="0"') && html.includes('aria-valuemax="100"'), 'it carries min and max');
  ok(html.includes('aria-valuenow="28"'), 'and a determinate aria-valuenow (1.4 of 5 stages)');
  ok(html.includes('aria-label="Planning the decomposition…"'), 'the label reaches the accessible name');
  ok(/<span class="pring-label" aria-hidden="true">/.test(html),
    'the VISIBLE label is aria-hidden when determinate — the svg\'s aria-label already says it, once');
  ok(/<span class="pring-sublabel mono" aria-hidden="true">/.test(html),
    'the sublabel is ALWAYS aria-hidden — it is the elapsed clock and must never be read out every second');
  ok(!html.includes('role="status"'), 'a determinate ring is not a live region — it would announce on every frame');

  const act = progressRingHtml({ value: null, size: 20, label: 'Checking sync status…' });
  ok(act.includes('role="status"') && act.includes('aria-live="polite"'),
    'an activity-only ring WITH a label is a polite live region, so a phase change is announced once');
  ok(!act.includes('aria-valuenow'), 'and it reports no aria-valuenow — indeterminate, per ARIA');
  ok(!/<span class="pring-label" aria-hidden="true">/.test(act),
    'its visible label is NOT hidden — that is the text the live region announces');

  const btn = progressRingHtml({ value: null, size: 16, center: 'none' });
  ok(btn.includes('aria-hidden="true"'), 'an unlabelled, indeterminate in-button ring is decorative and aria-hidden');
  ok(!btn.includes('role="progressbar"'), '…and contributes no progressbar to the button\'s accessible name');
  ok(!btn.includes('role="status"'), '…and adds no empty live region');
  const bare = progressRingHtml({ value: 40, size: 32, center: 'none' });
  ok(bare.includes('role="progressbar"') && bare.includes('aria-valuenow="40"'),
    'a DETERMINATE ring stays a progressbar even without a label — it carries a real number');

  // Escaping. Both text slots go through the same five-entity escape.
  const xss = progressRingHtml({
    value: 10, size: 48,
    label: '<img src=x onerror=alert(1)>',
    sublabel: '"><script>alert(2)</script>',
  });
  ok(!xss.includes('<img'), 'a label containing markup is escaped');
  ok(!xss.includes('<script'), 'a sublabel containing markup is escaped');
  ok(xss.includes('&lt;img'), 'and lands as escaped text');
  ok(!/aria-label="[^"]*"[^>]*onerror/.test(xss), 'the aria-label attribute cannot be broken out of');
  ok(xss.includes('aria-label="&lt;img src=x onerror=alert(1)&gt;"'), 'the aria-label value is escaped too');

  // labelHtml / sublabelHtml are the documented pre-escaped escape hatches.
  const pre = progressRingHtml({
    stages, stage: 0, size: 48,
    labelHtml: 'Wrote <span class="mono">7</span> pages',
    sublabelHtml: '<span id="ing-elapsed">0:12</span>',
  });
  ok(pre.includes('<span class="mono">7</span>'), 'labelHtml passes pre-built markup through');
  ok(pre.includes('id="ing-elapsed"'), 'sublabelHtml preserves an id the caller patches directly');

  // No text block at all when there is nothing to put in it.
  const noText = progressRingHtml({ value: 50, size: 32 });
  ok(!noText.includes('pring-text'), 'no label and no sublabel produces no text block');

  // The negative animation-delay that keeps the orbit continuous.
  const withClock = progressRingHtml({ value: null, size: 32, nowMs: 500 });
  ok(/animation-delay:-0\.500s/.test(withClock), 'the orbit carries the clock-derived negative delay');
  const atZero = progressRingHtml({ value: null, size: 32, nowMs: 0 });
  ok(/animation-delay:(-)?0\.000s/.test(atZero), 'a zero clock gives a zero delay');
  ok(!progressRingHtml({ stages, stage: 5, size: 32, nowMs: 500 }).includes('animation-delay'),
    'a finished ring has no orbit and therefore no delay');

  eq(progressRingHtml({ value: 50, size: 32, id: 'x-ring' }).includes('id="x-ring"'), true, 'an id is passed through');
  ok(progressRingHtml({ value: 50, size: 32, className: 'extra-cls' }).includes('extra-cls'), 'extra classes are appended');
  ok(typeof progressRingHtml() === 'string', 'calling with no arguments produces a string rather than throwing');
  ok(typeof progressRingHtml({}) === 'string', 'an empty opts object produces a string');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  Stylesheet — reduced motion, tokens, theming, prefix ownership');
// ═════════════════════════════════════════════════════════════════════════
{
  // A permanently-orbiting element on screen for MINUTES must honour this.
  ok(/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(ringCssCode),
    'progress-ring.css has a prefers-reduced-motion: reduce block');
  const rmBlock = ringCssCode.slice(ringCssCode.indexOf('@media (prefers-reduced-motion'));
  ok(rmBlock.includes('.pring-orbit'), 'the reduced-motion block actually targets the orbit (not some other element)');
  ok(/\.pring-orbit\s*\{[^}]*animation:\s*(none|pring-breathe)/.test(rmBlock),
    'under reduced motion the orbit\'s rotation is replaced, not left running');
  ok(!/curator-spin/.test(rmBlock), 'the rotation keyframe is not re-applied inside the reduced-motion block');
  ok(rmBlock.includes('transition: none'), 'the outer-ring transitions are stopped under reduced motion too');

  // Theming: [data-theme] only. tokens/*.css carry no prefers-color-scheme
  // and neither may this file — the shell stamps the attribute.
  // Against the STRIPPED code: this stylesheet's own header explains why
  // prefers-color-scheme is absent, and a raw-text check would be reading
  // that explanation instead of the rules.
  ok(!/prefers-color-scheme/.test(ringCssCode),
    'no prefers-color-scheme anywhere in progress-ring.css — theming is [data-theme] only');

  // Tokens. An undefined custom property fails SILENTLY at computed-value
  // time, which is the entire reason scripts/test-css-tokens.js exists.
  // That suite discovers stylesheets through next/index.html's <link> tags
  // and this file is not linked there yet, so the check is done here.
  const tokensDir = path.join(ROOT, 'src/public/next/tokens');
  const defined = new Set();
  for (const f of readdirSync(tokensDir)) {
    if (!f.endsWith('.css')) continue;
    for (const m of readFileSync(path.join(tokensDir, f), 'utf8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  for (const m of ringCss.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  ok(defined.has('--accent'), 'sanity: the token scan found --accent (an empty set would pass the loop below vacuously)');
  ok(defined.size > 60, `sanity: the token scan found ${defined.size} definitions`);
  const refs = [...ringCss.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]);
  ok(refs.length > 10, `sanity: progress-ring.css references ${refs.length} custom properties`);
  const missing = [...new Set(refs)].filter((r) => !defined.has(r));
  eq(missing.join(', '), '', 'every var(--x) in progress-ring.css resolves to a defined token');
  ok(/\.pring\s*\{[^}]*--pring-color:/.test(ringCssCode),
    '--pring-color is DEFINED on .pring itself, not only re-pointed by the tone modifiers');
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(ringCssCode.replace(/var\([^)]*\)/g, '')),
    'no colour literal anywhere in progress-ring.css — tokens only');

  // Prefix ownership (the house convention: obp-, mcpw-, and now pring-).
  const nextDir = path.join(ROOT, 'src/public/next');
  const otherCss = [];
  for (const d of ['views', 'tokens', '.']) {
    const full = path.join(nextDir, d);
    for (const f of readdirSync(full)) {
      if (!f.endsWith('.css')) continue;
      if (path.join(full, f) === path.join(nextDir, 'shared/progress-ring.css')) continue;
      otherCss.push(path.join(full, f));
    }
  }
  ok(otherCss.length > 5, `sanity: found ${otherCss.length} other /next stylesheets to check the prefix against`);
  const collisions = otherCss.filter((f) => /\.pring[-\s{,:.]/.test(stripComments(readFileSync(f, 'utf8'))));
  eq(collisions.map((f) => path.basename(f)).join(', '), '',
    'the `pring-` prefix is owned — it defines no rule in any other /next stylesheet');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10  Performance — CSS animation only, no JS loop');
// ═════════════════════════════════════════════════════════════════════════
{
  // This element is on screen for MINUTES during a large ingest.
  for (const banned of ['requestAnimationFrame', 'setInterval', 'setTimeout']) {
    ok(!ringCode.includes(banned), `progress-ring.js contains no ${banned} — the browser animates, not us`);
  }
  ok(!ringCode.includes('addEventListener'), 'the module binds no listeners — it is a pure markup builder');
  ok(!/\bfetch\s*\(/.test(ringCode), 'the module makes no network calls');
  ok(ringCode.includes('animation-delay'), 'phase continuity is done with a CSS animation-delay, not a JS driver');
  // Date.now() is allowed exactly once, as the default clock for that delay.
  eq((ringCode.match(/Date\.now\(\)/g) || []).length, 1,
    'Date.now() appears exactly once — the orbit-phase default, and nowhere near the outer ring');
}

// ═════════════════════════════════════════════════════════════════════════
section('§11  Adoption — ingest.js');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/import \{[\s\S]{0,200}progressRingHtml[\s\S]{0,200}\} from '\.\.\/shared\/progress-ring\.js'/.test(ingestCode),
    'ingest.js imports the shared module rather than reimplementing it');
  ok(ingestCode.includes('mapIngestPctToStage'), 'and uses the shared phase map');

  const rp = extractFunction(ingestJs, 'renderProgress');
  ok(rp.length > 400, 'sanity: renderProgress extracted');
  ok(rp.includes('progressRingHtml('), 'renderProgress renders the ring');
  ok(rp.includes('mapIngestPctToStage(pct)'),
    'its stage comes from the shared map applied to the SERVER\'s pct — not from a local guess');

  // The honesty work already in this surface must survive the swap.
  ok(rp.includes("id=\"ing-elapsed\""),
    'the #ing-elapsed id survives — the v3.0.17 clock tick patches it by textContent and would silently no-op without it');
  ok(ingestCode.includes("getElementById('ing-elapsed')"),
    'and the tick that patches it is still there');
  ok(rp.includes("p.waiting ? 'attention'"),
    'a retry/backoff `wait` event still renders amber — now as tone="attention"');
  ok(rp.includes('isn’t stuck'),
    'the "large documents take a minute per phase / it isn\'t stuck" note is still rendered');
  ok(/\+ pct \+ '%/.test(rp), 'the pct readout survives the move into the sublabel');
  ok(rp.includes('labelContent'), 'the specific done-label (never the word "Done!") still reaches the ring');

  // The bar it replaced is gone from BOTH the view and the stylesheet — a
  // dead rule set is how a stylesheet starts lying about what is rendered.
  for (const dead of ['ing-progress-track', 'ing-progress-fill', 'ing-progress-pct',
    'ing-progress-elapsed', 'ing-progress-header', 'ing-progress-meta']) {
    ok(!ingestCode.includes(dead), `the linear bar's \`${dead}\` is gone from ingest.js`);
    ok(!ingestCssCode.includes(dead), `…and its rule is gone from ingest.css`);
  }
  ok(!ingestCssCode.includes('ing-progress-pulse'), 'the bar\'s pulse keyframe is gone too');
  ok(ingestCssCode.includes('.ing-progress-note'), 'sanity: the honesty NOTE\'s rule is still there');

  // Per-item and overall batch rings.
  const uq = extractFunction(ingestJs, 'updateQueueItemProgress');
  ok(uq.includes('progressRingHtml('), 'the per-item queue row renders a ring');
  ok(uq.includes('mapIngestPctToStage(pct)'), '…driven by the same server pct map');
  ok(uq.includes('size: 20'), '…at the design\'s 20px row size');
  ok(ingestCode.includes('complete: isTerminal'),
    'the overall batch ring stops orbiting when the job is terminal, even if settled/total never reaches 100');
  ok(ingestCode.includes('computeQueueSpentLabel'),
    'the honest spend label ("spend so far: pending first file" on an in-progress zero) is untouched');
  ok(ingestCode.includes('formatUsdHonest'), 'and so is the "at least $X" lower-bound renderer');
}

// ═════════════════════════════════════════════════════════════════════════
section('§12  Adoption — domains.js (Health)');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/import \{[\s\S]{0,120}progressRingHtml[\s\S]{0,120}\} from '\.\.\/shared\/progress-ring\.js'/.test(domainsCode),
    'domains.js imports the shared module');

  const note = extractFunction(domainsJs, 'noteAiProgress');
  ok(note.includes('ev.processed'), 'the SSE reader handles the plan/scan streams\' `processed` key');
  ok(note.includes('ev.done'), 'and the apply/merge streams\' `done` key — two names for the same quantity');
  ok(/total <= 0/.test(note), 'a zero total is refused rather than dividing by it');
  ok(/return;/.test(note), 'a frame carrying neither key leaves the count alone rather than resetting it to zero');

  const rend = extractFunction(domainsJs, 'renderAiProgressRing');
  ok(rend.includes('ringValueFromCounts'), 'the ring\'s value comes from the server\'s own counts');
  ok(rend.includes('state.aiProgress.key === state.busyKey') || rend.includes("aiProgress.key === key"),
    'the count is stamped with the operation it came from, so a late frame cannot drive a different ring');
  ok(rend.includes('value,'), 'the value is passed through — null (activity only) until a count arrives');
  ok(!/Date\.now|elapsed/.test(rend),
    'nothing in the Health ring is derived from elapsed time — an unknown stays an unknown');

  // Every long operation feeds the ring.
  for (const k of ['brokenLinksPlan', 'orphansPlan', 'semanticDupesScan', 'semanticMerge']) {
    ok(new RegExp(`noteAiProgress\\('${k}'`).test(domainsCode), `the ${k} stream feeds the ring`);
  }
  ok(domainsCode.includes("noteAiProgress(kind + 'Apply'"), 'the plan-apply stream feeds the ring');

  // The count must be cleared with the operation, or a stale one shows on
  // the next run before its first frame arrives.
  const busyResets = (domainsCode.match(/state\.busyKey = null;/g) || []).length;
  const progResets = (domainsCode.match(/state\.aiProgress = null;/g) || []).length;
  ok(busyResets > 5, `sanity: found ${busyResets} busyKey resets`);
  ok(progResets >= busyResets, `every busyKey reset is paired with an aiProgress reset (${progResets} >= ${busyResets})`);

  // Existing per-pair actions must NOT sprout a ring — they are sub-second.
  ok(rend.includes('semanticPreview:'), 'the sub-second per-pair actions are excluded from the ring');
  ok(domainsCode.includes('markSemanticPairStatus'),
    'the merge stream\'s per-pair status recording (which stops a batch destroying unreviewed pairs) is untouched');
  ok(domainsCode.includes('buttonRingHtml()'), 'the 16px in-button ring is used');
  ok(/running \? buttonRingHtml\(\) : icon\('sparkles', 12\)/.test(domainsCode),
    'the sparkles token-spend mark is replaced by the ring ONLY on the button that is actually running');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
