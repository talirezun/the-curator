/**
 * test-freshness-scale.js — OFFLINE suite, zero dependencies, no network.
 *
 * ONE freshness scale for the whole app: a mark whose colour says how recently
 * something happened, cut on exactly the bands the WORD beside it is cut on,
 * so the two can never disagree.
 *
 * ── WHAT IT REPLACED, AND WHY THAT MATTERED ─────────────────────────────
 * Three ladders answered one question in three visual languages:
 *
 *   views/memory.css   .mem-save-pip-s0…s4   five steps, BRAND VIOLET
 *   views/ingest.css   .ing-fresh-s0…s3      four day-resolution steps, violet
 *   views/domains.css  .dm-fresh-s0…s3       a byte-identical copy of that
 *   desktop/lib/menu-dots.js                 teal / amber / neutral
 *
 * Violet in this app means IDENTITY and PRIMARY ACTION (tokens/color.css's
 * header says so), and the domains sidebar drew its identity dots from the
 * same family, so the freshness mark and the identity mark were two 8px dots
 * in one colour space two centimetres apart. Meanwhile `s2` meant "hours" in
 * one file and "this week" in the other two — the same numeral for two facts.
 * And the menubar tray, which the same person sees in the same glance, used
 * a third palette entirely.
 *
 * ── WHAT IS ENFORCED HERE ───────────────────────────────────────────────
 *  §1  THE BANDS. `freshnessTier` changes exactly where `formatAge`'s unit
 *      changes, over the enumerated boundaries AND over a wide sweep. The
 *      sweep asserts the ONE-DIRECTIONAL property that is actually true and
 *      is the one worth having: every tier change is also a word change, so
 *      the mark never subdivides a phrase. The converse is deliberately NOT
 *      asserted — `formatAge` keeps counting ("3 weeks", "2 months", "1
 *      year") inside `dormant`, because past a week the scale has nothing
 *      more to say and the words do.
 *  §2  The same, for `dayFreshnessTier` against `formatDayAge`.
 *  §3  Every tier has a rule in shared/freshness.css and no tier has one
 *      that the two functions cannot produce — a set equality in BOTH
 *      directions, so neither an invisible mark nor a dead rule can survive.
 *      Every colour in that sheet is a --fresh-* (or --text-faint) token
 *      defined in BOTH themes in tokens/color.css.
 *  §4  No view stylesheet declares `.ing-fresh-`, `.dm-fresh-` or any
 *      `.fresh-` rule of its own, and none carries a hex in a freshness rule.
 *      Plus: NO stylesheet anywhere paints TEXT with a --fresh-* token. The
 *      floor for these is 3:1 because they paint a graphic; the word beside
 *      the mark stays on a text token.
 *  §5  CONTRAST. Each --fresh-* token against --surface and --surface-raised,
 *      in both themes, ≥ 3:1 (WCAG 1.4.11, the non-text floor).
 *  §6  The Agent-memory pip's five classes reference the tier tokens their
 *      steps map to — s4/s3 hot, s2 mid, s1/s0 cold, unknown --text-faint.
 *  §7  The two sidebar renderers, EXECUTED, emit `fresh-dot fresh-<tier>`.
 *
 * ── WHAT THIS SUITE CANNOT DO ───────────────────────────────────────────
 * It does not render. §5 is arithmetic over token VALUES parsed out of
 * tokens/color.css — the same proxy scripts/test-next-contrast-ratchet.js
 * documents at length, with the same gaps: it assumes each mark's backdrop,
 * it cannot resolve the cascade, and it cannot see a declaration that is not
 * there. The numbers in shared/freshness.css's header were additionally read
 * off a real browser over a static harness in both themes; this suite exists
 * so they cannot rot back, and is a RATCHET, not a measurement.
 *
 * It also says nothing about whether the tiers are PERCEPTIBLY different at
 * 8px and 12px. v3.34.0 recorded that gap for the five-step pip and it is
 * still open; a contrast ratio is not a discriminability claim.
 *
 * AND §5 GRADES TWO BACKDROPS, --surface and --surface-raised. A SELECTED
 * sidebar row paints rgba(255,255,255,0.10) over --surface, which is a THIRD
 * backdrop and is not graded here. Measured in the browser, the dashed
 * `unknown` ring is 2.74:1 on it in the dark theme — under the floor. That is
 * recorded in shared/freshness.css's header with the one-token fix, and is
 * left as the maintainer's call; do not read a green §5 as covering it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NEXT = path.join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (extra ? '\n      ' + extra : '')); }
}
function eq(actual, expected, label) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(t) { console.log('\n' + t); }

const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');
/** Comments stripped before every CSS scan. Load-bearing: the three view
 *  sheets now carry prose naming the retired classes and quoting the retired
 *  tokens, so a raw scan reads an explanation and reports the opposite of the
 *  truth — the shape test-next-contrast-ratchet.js records for its own. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const age = await import(pathToFileURL(path.join(NEXT, 'shared/age.js')).href);
const { formatAge, formatDayAge, freshnessStep, freshnessTier, dayFreshnessStep,
  dayFreshnessTier, freshnessDotHtml, FRESHNESS_TIERS } = age;

// ═════════════════════════════════════════════════════════════════════════
section('§0  Positive control — everything this suite needs really loaded');
ok(['formatAge', 'formatDayAge', 'freshnessStep', 'freshnessTier', 'dayFreshnessStep',
  'dayFreshnessTier', 'freshnessDotHtml'].every((n) => typeof age[n] === 'function'),
  'shared/age.js exports both ladders, both tier functions and the dot');
ok(Array.isArray(FRESHNESS_TIERS) && FRESHNESS_TIERS.length === 6,
  `…and the tier NAMES as a list (${FRESHNESS_TIERS.join(', ')})`);
ok(formatAge(30) === 'just now' && formatAge(-1) === null,
  'CONTROL — formatAge answers, and can still say "unknown", so the matrices below are not all-null');

// ═════════════════════════════════════════════════════════════════════════
section('§1  The tier changes exactly where the WORD changes — seconds');
{
  // The unit a phrase is counted in, which is the thing that must move
  // together with the mark. Derived from the phrase rather than from a second
  // copy of formatAge's bands: reimplementing the ladder here would make this
  // an assertion that two copies of one table agree.
  const unitOf = (s) => {
    const w = formatAge(s);
    if (w === null) return 'unknown';
    if (w === 'just now') return 'just now';
    return w.replace(/^\d+\s+/, '').replace(/s ago$/, ' ago');
  };

  // THE ENUMERATED BOUNDARIES, in pairs: the last second of one band and the
  // first of the next. At each pair BOTH the tier and the unit must flip.
  const PAIRS = [[0, 59], [59, 60], [3599, 3600], [86399, 86400], [604799, 604800]];
  for (const [a, b] of PAIRS) {
    const tierMoved = freshnessTier(a) !== freshnessTier(b);
    const unitMoved = unitOf(a) !== unitOf(b);
    ok(tierMoved === unitMoved,
      `${a}s -> ${b}s: the mark and the word move together ` +
      `(${freshnessTier(a)}/"${formatAge(a)}" -> ${freshnessTier(b)}/"${formatAge(b)}")`);
  }
  eq([0, 59, 60, 3599, 3600, 86399, 86400, 604799, 604800].map(freshnessTier),
    ['live', 'live', 'recent', 'recent', 'today', 'today', 'week', 'week', 'dormant'],
    'the five tiers land on formatAge\'s own unit boundaries, to the second');

  // THE SWEEP. Every tier change anywhere in ten years must coincide with a
  // word-unit change. The converse is NOT asserted and must not be: formatAge
  // goes on counting weeks, months and years inside `dormant`, which is the
  // words carrying a distinction the mark deliberately drops.
  const SAMPLES = [];
  for (let s = 0; s <= 400; s++) SAMPLES.push(s);
  for (let m = 1; m <= 200; m++) SAMPLES.push(m * 60, m * 60 - 1, m * 60 + 1);
  for (let h = 1; h <= 60; h++) SAMPLES.push(h * 3600, h * 3600 - 1);
  for (let d = 1; d <= 3700; d++) SAMPLES.push(d * 86400, d * 86400 - 1);
  SAMPLES.sort((a, b) => a - b);
  const bad = [];
  for (let i = 1; i < SAMPLES.length; i++) {
    const a = SAMPLES[i - 1], b = SAMPLES[i];
    if (freshnessTier(a) !== freshnessTier(b) && unitOf(a) === unitOf(b)) bad.push([a, b]);
  }
  eq(bad, [], `over ${SAMPLES.length} samples spanning ten years, no tier change ever happens ` +
    'inside one phrase — the mark never subdivides a word');
  // Anti-vacuity, both halves: the sweep has to be able to SEE a change.
  const changes = SAMPLES.filter((s, i) => i > 0 && freshnessTier(SAMPLES[i - 1]) !== freshnessTier(s));
  ok(changes.length === 4,
    `CONTROL — the sweep observed exactly the four tier changes (${changes.join(', ')}s), so "no bad change" is not "no change"`);
  ok(new Set(SAMPLES.map(unitOf)).size >= 5,
    `CONTROL — …and at least five distinct phrase units, so unitOf is not returning one constant`);

  // UNKNOWN IS A TIER, NOT A STEP. The v3.34.0 rule: "we do not know when
  // this happened" and "this happened a long time ago" are different facts.
  for (const v of [null, undefined, NaN, -1, Infinity, '60', {}]) {
    ok(freshnessTier(v) === 'unknown' && formatAge(v) === null,
      `${String(v)} is 'unknown' on the mark and null in words — never 'dormant', never "0s ago"`);
  }

  // The tiers are a RELABELLING of the numeric steps, not a second cut.
  const stepBad = SAMPLES.filter((s) => FRESHNESS_TIERS[4 - freshnessStep(s)] !== freshnessTier(s));
  eq(stepBad.slice(0, 5), [],
    'freshnessTier is freshnessStep relabelled — s4 live, s3 recent, s2 today, s1 week, s0 dormant — ' +
    'so the numeric vocabulary the memory pip is pinned on and the named one cannot drift apart');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  The same, at DAY resolution');
{
  const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
  const dayBefore = (n) => {
    const d = new Date(2026, 8, 17);
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const unitOf = (n) => {
    const w = formatDayAge(dayBefore(n), NOW);
    if (w === null) return 'unknown';
    if (w === 'today' || w === 'yesterday' || w === 'dated ahead') return w;
    return w.replace(/^\d+\s+/, '').replace(/s ago$/, ' ago');
  };

  eq([0, 1, 6, 7, 34, 35].map((n) => dayFreshnessTier(dayBefore(n), NOW)),
    ['today', 'week', 'week', 'dormant', 'dormant', 'dormant'],
    'the day ladder enters the scale at `today` and bottoms out at `dormant`');
  eq(dayFreshnessTier(null, NOW), 'unknown',
    'no date at all is `unknown` — a DASHED ring, not the coldest filled one');
  eq(dayFreshnessTier('not-a-date', NOW), 'unknown', '…and so is a malformed one');
  eq(dayFreshnessTier(dayBefore(-3), NOW), 'dormant',
    'a date AHEAD of the clock takes the coldest tier, never the freshest — an age is never rounded younger');

  // It cannot reach `live` or `recent`, and that is a property of the DATA:
  // a YYYY-MM-DD heading has no time of day, so "12 minutes ago" would be a
  // precision the input does not carry.
  const reachable = new Set();
  for (let n = -5; n <= 4000; n++) reachable.add(dayFreshnessTier(dayBefore(n), NOW));
  reachable.add(dayFreshnessTier(null, NOW));
  eq([...reachable].sort(), ['dormant', 'today', 'unknown', 'week'],
    'over eleven years of dates it reaches exactly four tiers — never `live` or `recent`, ' +
    'because a day-resolution date cannot honestly claim either');

  // THE SWEEP, same one-directional property as §1.
  const bad = [];
  for (let n = 1; n <= 4000; n++) {
    const a = dayFreshnessTier(dayBefore(n - 1), NOW), b = dayFreshnessTier(dayBefore(n), NOW);
    if (a !== b && unitOf(n - 1) === unitOf(n)) bad.push(n);
  }
  eq(bad, [], 'over 4,000 consecutive days, no tier change ever happens inside one phrase');
  let changes = 0;
  for (let n = 1; n <= 4000; n++) {
    if (dayFreshnessTier(dayBefore(n - 1), NOW) !== dayFreshnessTier(dayBefore(n), NOW)) changes++;
  }
  ok(changes === 2, `CONTROL — the sweep observed exactly the two day-resolution tier changes (got ${changes})`);

  // dayFreshnessStep is KEPT and unchanged: other callers and suites reason
  // in steps, and the tier ladder is deliberately coarser at the cold end.
  eq([0, 1, 6, 7, 34, 35].map((n) => dayFreshnessStep(dayBefore(n), NOW)),
    [3, 2, 2, 1, 1, 0],
    'dayFreshnessStep still draws the "this month" / "a month or more" line the tier ladder folds together');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  Every tier has a rule, every rule has a tier, every value a token');
{
  const css = stripComments(read('shared/freshness.css'));
  const ruleTiers = [...css.matchAll(/^\.fresh-([a-z]+)\s*\{/gm)].map((m) => m[1])
    .filter((t) => t !== 'dot');
  eq(ruleTiers.slice().sort(), FRESHNESS_TIERS.slice().sort(),
    'the tier rules in shared/freshness.css are EXACTLY the tiers the two functions can return — ' +
    'a missing rule is an invisible mark, an extra one is a dead rule');
  ok(/^\.fresh-dot\s*\{/m.test(css), '…plus `.fresh-dot`, the shape, which carries no colour of its own');

  // Every colour named is a --fresh-* or --text-faint, and every one of those
  // is declared in BOTH theme blocks of tokens/color.css.
  const colorCss = stripComments(read('tokens/color.css'));
  const lightAt = colorCss.indexOf('[data-theme=');
  ok(lightAt > 0, 'CONTROL — tokens/color.css has a real light block (comments already stripped)');
  const declsIn = (s) => new Set([...s.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const darkTok = declsIn(colorCss.slice(0, lightAt));
  const lightTok = declsIn(colorCss.slice(lightAt));

  const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))].sort();
  ok(used.length >= 4, `the sheet names ${used.length} tokens (${used.join(', ')})`);
  const ALLOWED = /^--(fresh-[a-z-]+|text-faint)$/;
  eq(used.filter((t) => !ALLOWED.test(t)), [],
    'every one is a --fresh-* or --text-faint — no --accent, no --attention, no --success');
  eq(used.filter((t) => !(darkTok.has(t) && lightTok.has(t))), [],
    'and every one is declared in BOTH themes, so no mark can leak its dark value onto a white page');

  ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no colour literal anywhere in the sheet');
  ok(!/font-size\s*:\s*\d+px/.test(css), 'no px font size — the sheet paints marks, never words');
  ok(!/\.tx-[a-z]/.test(css), 'no `tx-` rule — shared/text.css owns that prefix outright');
  ok(!/transition|animation|@keyframes/.test(css),
    'no transition and no animation: every view re-renders by replacing innerHTML, so one could ' +
    'never run — a declaration that reads as behaviour and is dead on arrival (v3.27.0)');
  // Anti-vacuity for the scanners above.
  ok(/#[0-9a-fA-F]{3,8}\b/.test(stripComments('a{color:#FF0000}'))
     && !/#[0-9a-fA-F]{3,8}\b/.test(stripComments('/* #FF0000 */ a{color:var(--x)}')),
    'CONTROL — the hex scanner counts a real literal and ignores one quoted in a comment');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  No view owns a freshness ladder, and none paints TEXT with one');
{
  for (const rel of ['views/ingest.css', 'views/domains.css', 'views/memory.css']) {
    const raw = read(rel);
    const css = stripComments(raw);
    ok(!/\.(ing|dm)-fresh/.test(css),
      `${rel}: no private \`.ing-fresh-\` / \`.dm-fresh-\` ladder`);
    ok(!/\.fresh-[a-z]/.test(css),
      `${rel}: and no \`.fresh-\` rule either — shared/freshness.css owns that prefix`);
  }
  ok(/\.ing-fresh/.test(read('views/ingest.css')) && /\.dm-fresh/.test(read('views/domains.css')),
    'CONTROL — both files still MENTION the retired names in the prose recording where the rules ' +
    'went, so the assertions above are green because comments were stripped, not because the scanner broke');

  // THE WORD BESIDE THE MARK STAYS ON A TEXT TOKEN. These tokens clear the
  // 3:1 GRAPHIC floor; --fresh-mid measures 3.58 in the light theme, well
  // under the 4.5:1 WCAG 1.4.3 floor for text, so painting a phrase with one
  // would be a real accessibility regression, not a style preference.
  const SHEETS = ['shared/freshness.css', 'views/ingest.css', 'views/domains.css',
    'views/memory.css', 'shell.css'];
  const textPainters = [];
  for (const rel of SHEETS) {
    for (const m of stripComments(read(rel)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/(?:^|;)\s*color\s*:\s*var\(--fresh-/.test(m[2])) {
        textPainters.push(rel + ' ' + m[1].trim().replace(/\s+/g, ' '));
      }
    }
  }
  eq(textPainters, [],
    'no rule anywhere paints TEXT with a --fresh-* token — the floor for these is 3:1 because ' +
    'they paint a graphic, and the age phrase stays on --text-2/--text-3');
  {
    // Anti-vacuity: the detector must fire on a planted violation.
    const planted = '.x { color: var(--fresh-mid); }';
    let fired = false;
    for (const m of planted.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/(?:^|;)\s*color\s*:\s*var\(--fresh-/.test(m[2])) fired = true;
    }
    ok(fired, 'CONTROL — the text-painting detector fires on a planted `color: var(--fresh-mid)`');
  }
  // RE-POINTED (v3.65.0): views/memory.css no longer names the family at all —
  // the pip that used it is deleted and the dot is shared/freshness.css's —
  // so the control moves to the file that DOES paint it. The property under
  // test is unchanged: the assertion above is about which PROPERTY a
  // --fresh-* token may reach, not about the token being absent everywhere.
  ok(/var\(--fresh-/.test(stripComments(read('shared/freshness.css'))),
    'CONTROL — shared/freshness.css DOES use the family (on `background` and `box-shadow`), so the ' +
    'assertion above is about the PROPERTY, not about the token being absent');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  Contrast — every tier ink clears 3:1 in both themes');
{
  // The ratchet's own helper, reproduced here rather than imported:
  // scripts/test-next-contrast-ratchet.js is a top-level script with side
  // effects (it runs its own assertions and sets an exit code on import), so
  // importing it would run a second suite inside this one. Attribution
  // stated rather than implied — if the arithmetic there changes, change it
  // here too; both are plain WCAG and both are validated by the same two
  // controls below.
  const colorCss = stripComments(read('tokens/color.css'));
  const lightAt = colorCss.indexOf('[data-theme=');
  const parse = (s) => { const m = {}; for (const d of s.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) m[d[1]] = d[2].trim(); return m; };
  const base = parse(colorCss.slice(0, lightAt));
  const THEMES = { dark: base, light: { ...base, ...parse(colorCss.slice(lightAt)) } };
  const resolve = (t, n, d = 0) => {
    if (d > 12) return null;
    const v = t[n];
    if (!v) return null;
    const a = v.match(/^var\((--[a-z0-9-]+)\)$/);
    return a ? resolve(t, a[1], d + 1) : v;
  };
  const toRgb = (v) => {
    const hx = v && v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!hx) return null;
    let h = hx[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => {
    const L1 = lum(a), L2 = lum(b);
    return Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
  };
  const C = (theme, fg, bg) => {
    const f = toRgb(resolve(THEMES[theme], fg)), b = toRgb(resolve(THEMES[theme], bg));
    return f && b ? ratio(f, b) : null;
  };

  // The two controls the ratchet uses. A helper that cannot report 1.00 and
  // 21.00 is measuring something other than contrast.
  ok(ratio({ r: 0, g: 0, b: 0 }, { r: 0, g: 0, b: 0 }) === 1,
    'CONTROL — an identical pair measures 1.00');
  ok(ratio({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }) === 21,
    'CONTROL — black on white measures 21.00');
  ok(resolve(THEMES.dark, '--fresh-hot') !== resolve(THEMES.light, '--fresh-hot'),
    'CONTROL — the two theme tables really are different (a light block read out of a COMMENT ' +
    'would make them identical, which is how a previous tool in this repo reported both themes the same)');

  const FLOOR = 3;
  const INKS = ['--fresh-hot', '--fresh-mid', '--fresh-cold', '--text-faint'];
  const rows = [];
  for (const tok of INKS) {
    for (const bg of ['--surface', '--surface-raised']) {
      for (const theme of ['dark', 'light']) {
        const r = C(theme, tok, bg);
        rows.push([tok, bg, theme, r]);
        ok(r !== null && r >= FLOOR,
          `${tok} on ${bg} (${theme}): ${r} — clears the 3:1 NON-TEXT floor`);
      }
    }
  }
  console.log('      ' + rows.map(([t, b, th, r]) => `${t}/${b}/${th}=${r}`).join('  '));

  // THE HALO IS EXEMPT AND SAYS SO. It is translucent and paints AROUND the
  // live mark, which clears on its own; grading a glow as if it were the mark
  // would either fail honestly-correct code or push someone to make the glow
  // opaque, which is worse.
  ok(/^rgba\(/.test(resolve(THEMES.dark, '--fresh-hot-halo'))
     && /^rgba\(/.test(resolve(THEMES.light, '--fresh-hot-halo')),
    '--fresh-hot-halo is translucent in both themes — a glow around a mark that clears, not a mark');

  // ANTI-VACUITY: the floor must be able to fail. --text-faint is the token
  // tokens/color.css deliberately keeps under 4.5 so a positive control can
  // fire; here the planted failure is an ink that genuinely does not clear.
  ok(C('light', '--fresh-hot-halo', '--surface') === null,
    'CONTROL — the helper returns null for a value it cannot grade (rgba), rather than a number that looks like a pass');
  ok(C('light', '--teal-500', '--surface') < FLOOR,
    `CONTROL — the floor genuinely rejects: --teal-500 on white measures ${C('light', '--teal-500', '--surface')}, ` +
    'which is exactly why the light theme drops to --teal-600');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  The Agent-memory pip is GONE, and the dot is what is left');
{
  // ── WHAT THIS SECTION USED TO ASSERT, AND WHY THE CLAIM GOT STRONGER ──
  //
  // It read: "the Agent-memory pip wears the same scale" — six rules
  // (`.mem-save-pip-s4` … `-s0`, `-unknown`) each painting the token its tier
  // names, cross-checked against `shared/freshness.css` so a recolour of one
  // alone would red. That was the best available answer while TWO marks for
  // ONE quantity existed on one page: the pip on the save reading, the dot on
  // the rail's rows, the work-stream table, the overview strip and step ③.
  //
  // v3.65.0 deletes the pip (design record R13). There is one mark now, so
  // "the two cannot disagree" stops being an assertion and becomes a fact
  // about the source — which is what this section asserts instead, in both
  // directions: memory.css declares NO `.fresh-` rule and no pip rule, AND
  // the save reading really does wear a `.fresh-dot` cut on the shared tier.
  //
  // §4's rule — no `.fresh-` rule outside shared/freshness.css — is what makes
  // that deletion the only honest direction: re-declaring the ladder here
  // under any other name is how the second mark came to exist.
  const css = stripComments(read('views/memory.css'));
  for (const sel of ['.mem-save-pip', '.mem-save-pip-s4', '.mem-save-pip-s3',
    '.mem-save-pip-s2', '.mem-save-pip-s1', '.mem-save-pip-s0', '.mem-save-pip-unknown']) {
    ok(!new RegExp('\\' + sel + '\\s*\\{').test(css),
      sel + ' is gone — one quantity, one mark');
  }
  ok(!/\.fresh-[a-z]+\s*\{/.test(css),
    'and views/memory.css declares no `.fresh-` rule at all, which is §4\'s rule '
    + 'reached by deletion rather than routed around');
  // ANTI-VACUITY, TWICE. A scan for absence passes on an empty file, and a
  // scan for a class passes on a comment — so the file must still be the real
  // one, and the SOURCE must really emit the shared mark on this reading.
  ok(css.length > 10000 && /\.mem-fold-summary/.test(css),
    'CONTROL: the file really was read, and still carries this view\'s own rules');
  const viewJs = stripComments(read('views/memory.js'));
  ok(/fresh-dot fresh-' \+ freshnessTier\(eff\.seconds\)/.test(viewJs),
    'the save reading wears the SHARED dot, cut on the shared tier function');
  ok(!/class="mem-save-pip/.test(viewJs) && !/'mem-save-pip/.test(viewJs),
    '...and nothing in the view WRITES the old class either (the name survives '
    + 'only where the file explains the deletion)');
}
section('§7  Both sidebar renderers emit the shared classes, EXECUTED');
{
  const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();
  eq(freshnessDotHtml('2026-09-17', NOW),
    '<span class="fresh-dot fresh-today" aria-hidden="true"></span>',
    'the dot helper emits the shape class, the tier class and nothing else');
  eq(freshnessDotHtml(null, NOW),
    '<span class="fresh-dot fresh-unknown" aria-hidden="true"></span>',
    '…and an absent date is `unknown`, aria-hidden like the rest');

  // THE RENDERERS THEMSELVES. Extracted from the real view sources and run —
  // a source regex proving `freshnessDotHtml(` appears would prove nothing
  // about what reaches the DOM, which is this repo's most-recorded guard
  // defect ("assert behaviour, not the presence of a line of source").
  const bothCalls = [];
  for (const [rel, call] of [['views/ingest.js', /freshnessDotHtml\(([^)]*)\)/],
    ['views/domains.js', /freshnessDotHtml\(([^)]*)\)/]]) {
    const m = call.exec(stripComments(read(rel)).replace(/\/\/[^\n]*/g, ''));
    ok(m !== null, `${rel} calls freshnessDotHtml`);
    if (m) bothCalls.push(m[1].trim());
  }
  eq(bothCalls, ['d.lastIngestDate, now', 'd.lastIngestDate, now'],
    'both call it with the DATE and the clock — the per-view class PREFIX argument is gone, ' +
    'because a function that takes a prefix is a function expecting more than one ladder');

  // And the emitted rows, for every tier a day-resolution date can produce.
  // scripts/test-sidebar-status-rows.js executes the full renderers against
  // stubs; here the helper is driven directly across the reachable tiers so a
  // tier that lost its class is caught by the suite that owns the SCALE too.
  const day = (n) => { const d = new Date(2026, 8, 17); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  for (const [n, tier] of [[0, 'today'], [3, 'week'], [42, 'dormant']]) {
    ok(freshnessDotHtml(day(n), NOW).includes('fresh-dot fresh-' + tier),
      `${n} day(s) ago renders \`fresh-dot fresh-${tier}\`, beside the words "${formatDayAge(day(n), NOW)}"`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log(`❌ ${failed} freshness-scale assertion(s) failed`); process.exit(1); }
console.log('✅ All freshness-scale assertions green');
