/**
 * test-next-views-kit.js — OFFLINE suite for the VIEW-level half of the
 * "Quiet System" design pass: chat, domains, ingest, memory, sync, shared,
 * onboarding and the two wizards.
 *
 * scripts/test-next-design-kit.js grades the FOUNDATIONS — tokens/material.css,
 * shell.css's control recipes, shared/switch.css, views/settings.css as the
 * exemplar. This one grades the seven views that adopted them, and it is a
 * separate file for the same reason those are separate agents: a suite that
 * spans both owns neither, and the two halves land on different branches.
 *
 * ── WHAT THIS SUITE REFUSES TO DO ────────────────────────────────────────
 * EVERY CONTRAST FIGURE BELOW IS RECOMPUTED FROM THE VALUES ON DISK. Two of
 * the changes in this pass are defect fixes whose whole justification is a
 * number — the citation chip's label and the domain stat counts, both under
 * WCAG 1.4.3's 4.5:1 in the light theme — and a test that pinned the new hex
 * would pass happily while the PAIRING was wrong. The suite therefore reads
 * tokens/color.css + tokens/material.css + the view's own custom properties,
 * resolves var() chains, composites translucent fills, and computes the
 * ratio. It is the same shape and the same arithmetic as the design-kit
 * suite, deliberately, so the two agree on what a number means.
 *
 * ── EVERY THRESHOLD SECTION CARRIES AN ANTI-VACUITY CONTROL ──────────────
 * §0 asserts 1.00 on an identical pair and 21.00 on black-on-white, because
 * v3.17.3 records a contrast helper in this repo reporting 2.34 for an
 * element genuinely at 7.26. Beyond that, every section that asserts "X is
 * above a floor" also feeds the SHIPPED-BEFORE value to the same comparator
 * and requires it to be reported as FAILING. A check that cannot fail is not
 * a check, and in this pass the before-values are known exactly.
 *
 * Sections:
 *   0  helper controls
 *   1  the theme tables parse, and every owned file is found
 *   2  the citation chip: the label clears AA in BOTH themes (was 2.80-3.11
 *      on light), and the type is carried by a DOT that clears the 3:1
 *      non-text floor
 *   3  the domain stat counts clear AA on light (were 3.22-3.58)
 *   4  no colour literal was ADDED to a view — a per-file hex baseline that
 *      may only shrink
 *   5  `cursor: pointer` is gone from every control in every owned view, and
 *      chrome carries user-select: none
 *   6  digits that align or tick carry tabular figures
 *   7  the monospace face is spent on LITERALS, not on facts
 *   8  rows on a material take the alpha overlay, never an opaque surface
 *   9  the sheets: top-anchored, material, both edges, reduced-motion escape
 *  10  hit targets: every control reaches --hit-min, by box or by ::before
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

console.log('/next VIEW adoption of the Quiet System control kit — offline guard\n');

/* ─────────────────────────────────────────────────────────────────────────
   Parsing. Comments are stripped FIRST and that is load-bearing rather than
   tidy: several of these files QUOTE `[data-theme="light"]` and quote hex
   values inside prose explaining a measurement, so a bare indexOf on the raw
   text locates a block inside a comment and reads the wrong table. Three
   other suites already strip for exactly this.
   ───────────────────────────────────────────────────────────────────────── */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

function dropAtRules(css) {
  let out = '', i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let j = css.indexOf('{', at);
    if (j < 0) break;
    let depth = 1; j++;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    i = j;
  }
  return out;
}

function parseTokenBlock(body) {
  const map = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  return map;
}

/** The dark table is everything at bare `:root`; light is dark overlaid with
 *  the `[data-theme="light"]` block. @media blocks are EXCLUDED — they are
 *  accessibility degradations, and grading the shipped design against its own
 *  fallback grades the fallback.
 *
 *  THE VIEW FILES ARE IN THIS LIST, not just tokens/ — and since v3.65.1
 *  shared/sidebar.css is too, because that is where the three derived rungs
 *  went. They were `--dm-ink-entity/-concept/-summary` in views/domains.css;
 *  they are `--id-ink-1/-2/-3` in the kit, one name for a value that both the
 *  identity dots and this view's stat counts need, and a table built from
 *  tokens/ alone resolves all three to null — which would make §3 grade
 *  nothing while reporting green. Concatenated in index.html's LINK ORDER, so
 *  a `:root` in a view wins the same (0,1,0) tie it wins in the browser. */
function themeTables(files) {
  const dark = {}, light = {};
  for (const rel of files) {
    const css = dropAtRules(stripComments(read(rel)));
    const lightAt = css.indexOf('[data-theme="light"]');
    const head = lightAt < 0 ? css : css.slice(0, lightAt);
    Object.assign(dark, parseTokenBlock(head));
    Object.assign(light, parseTokenBlock(head));
    if (lightAt >= 0) Object.assign(light, parseTokenBlock(css.slice(lightAt)));
  }
  return { dark, light };
}

function resolve(theme, name, depth = 0) {
  if (depth > 12) return null;
  const v = theme[name];
  if (!v) return null;
  const alias = v.match(/^var\((--[a-z0-9-]+)\)$/);
  return alias ? resolve(theme, alias[1], depth + 1) : v;
}

function toRgb(v) {
  if (!v) return null;
  let m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
function ratio(a, b) {
  const L1 = lum(a), L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}
function composite(top, bottom) {
  if (top.a >= 1) return { ...top, a: 1 };
  return {
    r: Math.round(top.r * top.a + bottom.r * (1 - top.a)),
    g: Math.round(top.g * top.a + bottom.g * (1 - top.a)),
    b: Math.round(top.b * top.a + bottom.b * (1 - top.a)),
    a: 1,
  };
}
const r2 = (n) => Math.round(n * 100) / 100;

/** `color-mix(in srgb, var(--tok) N%, black)` — the ONE derivation this pass
 *  introduces, used so a light-theme dot can be darkened without a fourth set
 *  of hex literals landing in a file whose colour-literal baseline is zero.
 *  Resolved here rather than approximated: srgb mixing with black is a plain
 *  per-channel scale, which is exactly what the engine computes. */
function resolveValue(theme, value) {
  if (!value) return null;
  const mix = /^color-mix\(\s*in\s+srgb\s*,\s*var\((--[a-z0-9-]+)\)\s+([\d.]+)%\s*,\s*black\s*\)$/i.exec(value.trim());
  if (mix) {
    const base = toRgb(resolve(theme, mix[1]));
    if (!base) return null;
    const p = +mix[2] / 100;
    return { r: Math.round(base.r * p), g: Math.round(base.g * p), b: Math.round(base.b * p), a: 1 };
  }
  const varRef = /^var\((--[a-z0-9-]+)\)$/.exec(value.trim());
  if (varRef) return toRgb(resolve(theme, varRef[1]));
  return toRgb(value.trim());
}

const TEXT_FLOOR = 4.5;
const NONTEXT_FLOOR = 3;

const OWNED = ['views/chat.css', 'views/chat-list.css', 'views/domains.css', 'views/ingest.css',
  'views/memory.css', 'views/sync.css', 'views/shared.css',
  'views/onboarding.css', 'views/mcp-wizard.css'];
const OWNED_JS = ['views/chat.js', 'views/chat-list.js', 'views/domains.js', 'views/ingest.js',
  'views/memory.js', 'views/sync.js', 'views/shared.js',
  'views/onboarding.js', 'views/mcp-wizard.js'];

/** The last declaration of `prop` in the last top-level rule whose selector
 *  list matches `selector` exactly. Comments are stripped first. */
function declFor(css, selector, prop) {
  const clean = stripComments(css);
  let found = null;
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (!sels.includes(selector)) continue;
    const d = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;}]+)').exec(m[2]);
    if (d) found = d[1].trim();
  }
  return found;
}

// ═════════════════════════════════════════════════════════════════════════
section('0. Helper controls — nothing below counts until these pass');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(r2(ratio(toRgb('#123456'), toRgb('#123456'))) === 1, 'contrast(identical pair) === 1.00');
  ok(r2(ratio(toRgb('#000000'), toRgb('#FFFFFF'))) === 21, 'contrast(black, white) === 21.00');
  const half = composite({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0, a: 1 });
  ok(half.r === 128 && half.a === 1, `composite() blends and returns an opaque colour (got rgb(${half.r}))`);
  // The color-mix resolver, controlled against arithmetic done by hand.
  const t = { '--probe': '#646464' };  // 100,100,100
  const mixed = resolveValue(t, 'color-mix(in srgb, var(--probe) 50%, black)');
  ok(mixed && mixed.r === 50 && mixed.g === 50 && mixed.b === 50,
    `resolveValue() computes an srgb mix with black (got ${mixed ? `${mixed.r},${mixed.g},${mixed.b}` : 'null'}, expected 50,50,50)`);
  ok(resolveValue(t, 'color-mix(in srgb, var(--nope) 50%, black)') === null,
    'control: and it returns null on a token it cannot resolve, rather than guessing');
  ok(declFor('.a { color: red; } .a { color: blue; }', '.a', 'color') === 'blue',
    'declFor() takes the LAST declaration, which is what the cascade does');
  ok(declFor('/* .a { color: red } */ .b { color: blue; }', '.a', 'color') === null,
    'control: …and it does not read a rule that only exists inside a comment');
}

// ═════════════════════════════════════════════════════════════════════════
section('1. The theme tables parse and every owned file is on disk');
// ═════════════════════════════════════════════════════════════════════════
const { dark: D, light: L } = themeTables(
  ['tokens/color.css', 'tokens/material.css', 'tokens/identity.css', 'shared/sidebar.css', ...OWNED]);
{
  const missing = [...OWNED, ...OWNED_JS].filter((f) => !existsSync(path.join(NEXT, f)));
  ok(missing.length === 0, missing.length === 0
    ? `all ${OWNED.length + OWNED_JS.length} owned files found`
    : 'missing: ' + missing.join(', '));
  ok(resolve(D, '--type-entity') === '#3FBFD8' && resolve(L, '--type-entity') === '#2596AE',
    'the type triad resolves differently per theme (dark -500, light -600) — so the tables are really two tables');
  // v3.66.0: the three derived light rungs are the PAGE-TYPE inks and were
  // renamed `--id-ink-1/-2/-3` -> `--type-ink-entity/-concept/-summary`, and
  // moved to tokens/identity.css, so the domain palette could change without
  // re-colouring the Domains OVERVIEW figures. Their VALUES did not move.
  ok(resolve(L, '--type-ink-entity') !== resolve(L, '--type-entity'),
    "the type inks' derived light-theme rungs are IN the table (declared in tokens/identity.css)");
  ok(resolve(D, '--type-ink-entity') === resolve(D, '--type-entity'),
    '…and in DARK they alias the token, so no dark value moved by a byte');
  {
    const got = ['--type-ink-entity', '--type-ink-concept', '--type-ink-summary'].map((t) => resolve(L, t)).join(',');
    ok(got === '#16768C,#438126,#925E13',
      '…and the three light values are v3.65.1\'s, unchanged by the rename (' + got + ')');
  }
  // ONE PALETTE: the three rungs are declared ONCE, and the file that
  // declares them is the token file. A view re-declaring one is the two-copies
  // defect v3.65.1 removed, in its subtlest form — same name, same value,
  // different file, and whichever is linked last silently wins.
  for (const tok of ['--type-ink-entity', '--type-ink-concept', '--type-ink-summary']) {
    const declarers = [...OWNED, 'shared/sidebar.css', 'tokens/identity.css']
      .filter((rel) => new RegExp('(?:^|[;{\\s])' + tok + '\\s*:').test(stripComments(read(rel))));
    ok(declarers.length === 1 && declarers[0] === 'tokens/identity.css',
      `${tok} is declared in tokens/identity.css and NOWHERE else`, declarers.join(', '));
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('2. The citation chip — the LABEL is text, the DOT is the type');
// ═════════════════════════════════════════════════════════════════════════
{
  // v3.72.0 (P2 + P3, M4): the citation chip is shared/page-chip.css's ONE
  // page chip — Chat's Sources list and the reader's backlinks wear it — so
  // the same contrast properties are held THERE. views/chat.css's
  // `.chat-cite-chip` / `.chat-chip-*` / `.chat-type-dot` are gone.
  const chat = read('shared/page-chip.css');
  const chipLabel = declFor(chat, '.page-chip', 'color');
  ok(chipLabel === 'var(--text-2)',
    `.page-chip's label takes a neutral text token, not a type colour (got ${chipLabel})`);

  // The chip's real backdrop: its own type tint composited over the thread's
  // canvas. Graded per type, per theme.
  const TYPES = ['entity', 'concept', 'summary'];
  for (const [name, T] of [['dark', D], ['light', L]]) {
    const canvas = toRgb(resolve(T, '--canvas'));
    for (const ty of TYPES) {
      const tint = toRgb(resolve(T, `--type-${ty}-tint`));
      if (!tint || !canvas) { ok(false, `${name}/${ty}: the tint and canvas resolve`); continue; }
      const back = composite(tint, canvas);
      const label = toRgb(resolve(T, '--text-2'));
      const got = r2(ratio(label, back));
      ok(got >= TEXT_FLOOR, `${name}: the ${ty} chip's label reads ${got}:1 on its own tint (floor ${TEXT_FLOOR})`);
      // ANTI-VACUITY: the value that SHIPPED must be reported as failing by
      // this same comparator, in the theme where it failed.
      if (name === 'light') {
        const was = r2(ratio(toRgb(resolve(T, `--type-${ty}`)), back));
        ok(was < TEXT_FLOOR,
          `…and the type colour it used to use reads ${was}:1 there — under the floor, which is the defect`);
      }
    }
  }

  // The DOT now carries the type, so it is a non-text indicator at 3:1. On
  // light it is derived from the token with color-mix rather than from a new
  // literal; on dark it is the token itself, unchanged.
  for (const [name, T, sel] of [
    ['dark', D, (ty) => `.page-chip-${ty} .page-chip-dot`],
    ['light', L, (ty) => `[data-theme="light"] .page-chip-${ty} .page-chip-dot`],
  ]) {
    for (const ty of TYPES) {
      const decl = declFor(chat, sel(ty), 'background');
      const dot = resolveValue(T, decl);
      ok(!!dot, `${name}: the ${ty} dot's fill resolves (${decl})`);
      if (!dot) continue;
      // The worst backdrop a chip dot can land on: its own tint, or a bare
      // canvas/surface if the chip is the untyped variant.
      const backs = [
        composite(toRgb(resolve(T, `--type-${ty}-tint`)), toRgb(resolve(T, '--canvas'))),
        toRgb(resolve(T, '--canvas')),
        toRgb(resolve(T, '--surface')),
      ].filter(Boolean);
      const worst = r2(Math.min(...backs.map((b) => ratio(dot, b))));
      ok(worst >= NONTEXT_FLOOR,
        `${name}: the ${ty} dot reads ${worst}:1 against the worst backdrop it can land on (floor ${NONTEXT_FLOOR})`);
      if (name === 'light') {
        const raw = toRgb(resolve(T, `--type-${ty}`));
        const wasWorst = r2(Math.min(...backs.map((b) => ratio(raw, b))));
        // The undarkened concept green is the one that genuinely failed; the
        // other two cleared by hundredths. Asserted as a SET so the section
        // states the real shape rather than three separate near-misses.
        if (ty === 'concept') {
          ok(wasWorst < NONTEXT_FLOOR,
            `…and undarkened it reads ${wasWorst}:1 — under the floor, which is why the mix exists`);
        }
      }
    }
  }
  // And the derivation must be a DERIVATION, not a fourth set of literals.
  ok(/color-mix\(in srgb, var\(--type-entity\) \d+%, black\)/.test(stripComments(chat)),
    'the light dot is DERIVED from the token with color-mix — so it moves if the palette does');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. The domain stat counts clear AA in the light theme');
// ═════════════════════════════════════════════════════════════════════════
{
  const dom = read('views/domains.css');
  // ── WHAT THE DIGITS SIT ON, AFTER v3.50.0 ───────────────────────────────
  // The tile used to paint `--surface` itself. The five figures are now inside
  // ONE inset group (the reported "the top number cards float without a card")
  // and the tile is transparent, so the plane behind the digits is the GROUP's
  // — which is the kit's `.cur-group`, in shell.css. The backdrop the contrast
  // arithmetic below uses is therefore RE-DERIVED rather than assumed: if the
  // group ever moves off `--surface`, this goes red instead of the numbers
  // quietly being computed against a plane that is no longer there.
  const groupBg = declFor(read('shell.css'), '.cur-group', 'background');
  ok(groupBg === 'var(--surface)', `the OVERVIEW group is on --surface (got ${groupBg})`);
  // v3.64.2 — the tile and its group are the SHARED overview component's now
  // (the Project-context view renders the same card), so the rule is read
  // from that stylesheet and the markup from that module. Only the three ink
  // classes below stayed in views/domains.css; since v3.65.1 they read the
  // identity palette's own `--id-ink-*` rungs from shared/sidebar.css, which
  // is the point — the number and the dot beside it are one colour.
  const ov = read('shared/overview.css');
  const tileBg = declFor(ov, '.cur-ov-group .cur-ov-card', 'background');
  ok(tileBg === 'none',
     `the overview tile is transparent inside the group, so the group's plane is the backdrop (got ${tileBg})`);
  ok(read('shared/overview.js').includes(`class="cur-group ' + cls('cur-ov-group'`),
     '…and the group the component renders really is the kit\'s `.cur-group` — otherwise the two reads ' +
     'above describe a plane nothing paints');
  for (const [ty, tok] of [['entity', '--type-ink-entity'], ['concept', '--type-ink-concept'], ['summary', '--type-ink-summary']]) {
    const decl = declFor(dom, `.dm-stat-${ty}`, 'color');
    ok(decl === `var(${tok})`, `.dm-stat-${ty} takes ${tok} (got ${decl})`);
    for (const [name, T] of [['dark', D], ['light', L]]) {
      const fg = toRgb(resolve(T, tok));
      const bg = toRgb(resolve(T, '--surface'));
      if (!fg || !bg) { ok(false, `${name}/${ty}: both ends resolve`); continue; }
      const got = r2(ratio(fg, bg));
      ok(got >= TEXT_FLOOR, `${name}: the ${ty} count reads ${got}:1 on the card (floor ${TEXT_FLOOR})`);
    }
    // ANTI-VACUITY: the raw token, which is what shipped, fails on light.
    const was = r2(ratio(toRgb(resolve(L, `--type-${ty}`)), toRgb(resolve(L, '--surface'))));
    ok(was < TEXT_FLOOR,
      `…and the --type-${ty} it used to use reads ${was}:1 on light — under the floor, which is the defect`);
  }
  // The counts are also FIGURES in a row of equal-width cards.
  ok(/font-variant-numeric:\s*var\(--numeric-tabular\)/.test(declForBody(ov, '.cur-ov-value')),
    '.cur-ov-value carries tabular figures, so four counts in a row line up');
}

/** The UNION of every top-level rule matching `selector`.
 *
 *  UNION, NOT "THE LAST ONE", AND @media BLOCKS ARE DROPPED FIRST. Both were
 *  found by this suite reporting green-looking failures on rules that are
 *  demonstrably correct on screen:
 *
 *    · `.mem-j-when` and `.sync-pending-note` each carry their tabular
 *      declaration in a GROUPED rule and their size/colour in a later
 *      dedicated one. CSS is additive across rules for different properties,
 *      so "the last rule" is the wrong model for asking whether a selector
 *      ends up with a property at all.
 *    · `.sbw-card` and `.mcpw-card` are followed by
 *      `@media (prefers-reduced-motion: reduce) { .sbw-card { animation: none } }`,
 *      and the inner rule of a media block matches the same naive
 *      selector-plus-braces scan — so the LAST body for either card was the
 *      three-word reduced-motion override, and every sheet assertion read it
 *      instead of the sheet.
 *
 *  For a SINGLE property where the cascade decides the answer, `declFor`
 *  above still takes the last declaration, which is the right model there. */
function declForBody(css, selector) {
  const clean = dropAtRules(stripComments(css));
  const parts = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (sels.includes(selector)) parts.push(m[2]);
  }
  return parts.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. No colour literal was ADDED to a view — a shrinking baseline');
// ═════════════════════════════════════════════════════════════════════════
{
  /* A view names colours by token, never by literal. Counted per file and
     BASELINED, because views/domains.css legitimately carries three derived
     rungs the type triad has no token for (there is no --entity-700), and
     removing them is a palette change that belongs to the token layer, not
     to this pass. The baseline may only ever SHRINK.

     Comments are STRIPPED before counting, and that is not a nicety: this
     pass added several hundred lines of prose that quote measured hex values
     while explaining why they were replaced. An unstripped count would report
     every one of those explanations as a new literal. */
  const BASELINE = {
    // Three derived rungs, ONE declaration each, referenced by both the
    // sidebar row dots and the stat counts. Was 8 — five of the eight were
    // duplicate uses that the naming removed.
    'views/domains.css': 3,
  };
  const findings = [];
  for (const rel of OWNED) {
    const css = stripComments(read(rel));
    const hexes = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
    const allowed = BASELINE[rel] || 0;
    if (hexes > allowed) findings.push(`${rel}: ${hexes} (baseline ${allowed})`);
  }
  ok(findings.length === 0, findings.length === 0
    ? `all ${OWNED.length} view stylesheets name colours by token (one file baselined at 3)`
    : 'colour literals found: ' + findings.join(', '));
  ok(Object.keys(BASELINE).length === 1,
    'the baseline holds exactly ONE file — adding a second to make this pass is the thing this assertion exists to prevent');
  ok((BASELINE['views/domains.css'] || 0) <= 3,
    "…and that entry may only ever SHRINK; it went 8 -> 3 in this pass by NAMING the value rather than repeating it");
  // Anti-vacuity, both directions.
  ok((stripComments('a{color:#FF0000}').match(/#[0-9a-fA-F]{3,8}\b/g) || []).length === 1,
    'control: the scanner counts a real literal');
  ok((stripComments('/* measured #FF0000 */ a{color:var(--x)}').match(/#[0-9a-fA-F]{3,8}\b/g) || []).length === 0,
    'control: …and ignores one quoted in a comment, which is most of what this pass wrote');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. The hand cursor is gone, and chrome does not drag-select');
// ═════════════════════════════════════════════════════════════════════════
{
  /* The cheapest native tell in the whole redesign: no AppKit control shows a
     pointing hand — not a push button, not a segment, not a sidebar row — and
     nothing marks a desktop app as a web page faster. Paired with
     `user-select: none` on chrome, which is the same argument from the other
     side: a button label that turns blue and drag-selects when a click starts
     a pixel early is a web page's behaviour. */
  const offenders = [];
  for (const rel of OWNED) {
    const css = stripComments(read(rel));
    const n = (css.match(/cursor:\s*pointer/g) || []).length;
    if (n) offenders.push(`${rel}: ${n}`);
  }
  ok(offenders.length === 0, offenders.length === 0
    ? 'no `cursor: pointer` survives in any of the eight view stylesheets'
    : '`cursor: pointer` still present: ' + offenders.join(', '));

  // …and it was really replaced rather than deleted: every one of those rules
  // still declares a cursor.
  let cursorRules = 0, withSelect = 0;
  /* THE THIRD EXEMPTION WAS FOUND BY THIS ASSERTION, NOT ANTICIPATED.
     `.reader-source-url` declares `user-select: text` explicitly — it is the
     source URL of a wiki page, and being able to select and copy it is the
     only reason it is on screen. That is the rule working: `user-select:
     none` is for CHROME, and a rule that opted OUT deliberately is evidence
     the distinction is real rather than a blanket. */
  // `.chat-conv-row-main` WAS the first exemption. v3.72.0 (P3) made Chat's
  // conversation rows the ONE sidebar row (`.cur-sb-row`, shared/sidebar.css),
  // so the selector no longer exists and the exemption goes with it.
  const contentExempt = ['.sbw-dht-card', '.reader-source-url'];
  const noSelect = [];
  for (const rel of OWNED) {
    const css = stripComments(read(rel));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/cursor:\s*default/.test(m[2])) continue;
      cursorRules++;
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (/user-select:\s*none/.test(m[2])) withSelect++;
      else if (!contentExempt.includes(sel)) noSelect.push(`${rel} ${sel}`);
    }
  }
  ok(cursorRules >= 40, `${cursorRules} rules declare \`cursor: default\` — the pointer was replaced, not deleted`);
  ok(noSelect.length === 0, noSelect.length === 0
    ? `and ${withSelect} of them also set user-select: none, with only the two CONTENT-bearing rules exempt`
    : 'chrome that still drag-selects: ' + noSelect.join(', '));
  // The exemptions are real and are stated: both hold text a user may want to
  // select — a conversation title the user typed, and terms they are agreeing
  // to. A test that exempted a selector that does not exist would be exempting
  // nothing while looking thorough.
  const allOwned = OWNED.map((r) => stripComments(read(r))).join('\n');
  for (const sel of contentExempt) {
    ok(new RegExp(sel.replace('.', '\\.') + '\\s*\\{').test(allOwned),
      `control: the exempt selector ${sel} really exists in an owned file`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('6. Digits that align or tick carry tabular figures');
// ═════════════════════════════════════════════════════════════════════════
{
  /* The one property the monospace face was genuinely buying at these call
     sites: a proportional `1` is narrower than a `4`, so a count that ticks
     reflows the words beside it and a column of figures does not line up.
     Taken WITHOUT the code face, per class, so each is checkable. */
  const WANT = [
    // v3.72.0 (P3): `.chat-scope-count` and `.chat-conv-meta` went with the
    // scope bar and the hand-built rows. The page count now ticks in the
    // header's meta line, and the list head carries the true conversation
    // count; the rows' figure is the kit's `.cur-sb-meta`.
    ['views/chat.css', '.chat-num'], ['views/chat.css', '.chat-head-meta'],
    ['views/chat-list.css', '.chat-list-count'], ['views/chat.css', '.chat-compile-change-detail'],
    // v3.64.2: `.dm-stat-value` moved to the shared overview component as
    // `.cur-ov-value` when the Project-context view adopted the same card.
    ['shared/overview.css', '.cur-ov-value'],
    // `.ing-queue-estimate-row strong` WAS HERE. The rule it named is deleted:
    // v3.20.0 replaced those rows with renderReadoutGroup and the row rules sat
    // dead for four releases, this WANT entry certifying a selector nothing
    // emitted. The figure's tabular treatment did not go with it — it lives on
    // `.tx-readout-value` in shared/text.css, which is where the role is now.
    ['views/ingest.css', '.ing-num'],
    // `.mem-row-meta` WAS HERE. v3.65.0's Context package adopted the shared
    // sidebar row for memory.js; the tabular rule for that figure now lives on
    // `.cur-sb-meta` in shared/sidebar.css (see its own font-variant-numeric
    // rule), so this WANT entry named a selector the view no longer writes.
    ['views/memory.css', '.mem-j-when'],
    ['views/sync.css', '.sync-pending-note'],
    ['views/shared.css', '.sb-num'],
  ];
  const missing = [];
  for (const [file, sel] of WANT) {
    const body = declForBody(read(file), sel);
    if (!/font-variant-numeric:\s*var\(--numeric-tabular\)/.test(body)) missing.push(`${file} ${sel}`);
  }
  ok(missing.length === 0, missing.length === 0
    ? `all ${WANT.length} figure-bearing rules take var(--numeric-tabular)`
    : 'figures with no tabular rule: ' + missing.join(', '));
  ok(/--numeric-tabular:\s*tabular-nums/.test(stripComments(read('tokens/material.css'))),
    'and the token really resolves to tabular-nums, so the rules above are not naming a ghost');
  ok(!/font-variant-numeric:\s*var\(--numeric-tabular\)/.test(declForBody(read('views/chat.css'), '.chat-answer')),
    'control: the answer PROSE does not take tabular figures — this is for columns and counters, not for body text');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. The monospace face is spent on LITERALS, not on facts');
// ═════════════════════════════════════════════════════════════════════════
{
  /* THE FINDING THIS SECTION GUARDS. views/chat.css alone carried 662
     monospace glyph runs against 284 in the text face; views/ingest.js
     carried 57 `mono` spans. Two different jobs were wearing one name: a
     COUNT was in mono so it would not reflow (that is tabular figures), and a
     NAME — a filename, a domain, a wiki slug, a scope — was in mono out of
     habit, which is what made these screens read as build logs.

     What is left is spent on LITERALS: things a reader retypes, pastes or
     copies. Each is listed with its reason so the next person adding a `mono`
     has to argue against a specific list rather than against a vibe. */
  const KEPT = {
    'views/chat.js': 4,       // four message eyebrows. v3.72.0 (P4): the model id moved to
                              // shared/model-row.js (browse dialog only). v3.72.0 (P3):
                              // the SCOPE and PROJECT eyebrows went with the scope bar, and the
                              // conversation group label is the sidebar kit's `.cur-eyebrow`.
                              // (was 8: four message eyebrows, the SCOPE and PROJECT eyebrows (v3.64.0), the conversation group label,
                              // the SCOPE eyebrow, and the model id in the picker.
                              // An eyebrow is a mono IDIOM in this system —
                              // tokens/typography.css defines --type-eyebrow as a
                              // mono token — and a model id is an identifier.
    /* views/domains.js: the eyebrow, plus fifteen PATHS AND SLUGS on the
       health and knowledge-folder surfaces. That second group is a LINE THIS
       PASS DREW NARROWER after reading an existing guard rather than after
       reasoning from scratch: scripts/test-next-domain-dots.js §8 executes
       renderIssueRow over every health category and requires every
       code-SHAPED value (a path, a slug, a [[wikilink]]) to be mono while
       requiring a PROSE word not to be — with a control on the orphan row's
       `type` word proving the rule is a rule and not "mono everything".

       On a screen whose task is comparing two slugs character by character
       to decide whether to delete a page, that is right; it is closer to a
       diff than to a sentence. So the rule this suite enforces is not "names
       move to the text face" — it is: a PATH or a SLUG keeps the code face,
       a COUNT does not. The 16 counts, stat values, row metas and health
       chips in this view moved; these 15 did not, and the 31 -> 16 reduction
       is the real measurement (16 slug sites plus the eyebrow). */
    /* v3.48.0 RAISED THIS FROM 17 TO 24, itemised so the raise is an argument
       rather than a number that moved. The Projects sub-section added seven,
       and every one is a LITERAL by this section's own rule:
         · 3 form inputs (`dm-lc-input mono`) — a project name IS a folder
           slug, typed character by character, and the same rule that keeps a
           slug in the code face on the health rows applies to typing one;
         · 1 `dm-lc-textarea mono` — the standing brief is Markdown SOURCE
           (`## ` headings, list markers, an HTML comment), edited as text, not
           read as prose. Its sibling editor in views/memory.js takes the same
           face through --type-mono;
         · 3 inline spans — the project name the user must RETYPE to confirm a
           delete, the filename `.curator-project`, and the path
           `<domain>/state/`. A thing you retype, a filename and a path are the
           three cases this budget exists for.
       v3.50.0 RAISED IT FROM 24 TO 25, for one span and the same rule:
         · 1 `mono dm-browse-path` on a MEMORY row — the path of a standing
           brief or a work-stream handoff under `state/`, which is the same
           case as the wiki row's path directly beside it, and it is the fact
           that tells a reader where the file sits in their synced folder. */
    'views/domains.js': 25,
    'views/ingest.js': 1,     // the accepted extensions: .txt .md .pdf
    'views/sync.js': 3,       // two setup inputs (repo URL, PAT) + the <code> repo readout
    'views/shared.js': 8,     // repo URL, fellow id, both one-shot tokens, two revoke inputs, the retype string
    'views/mcp-wizard.js': 4, // the config snippet and the config-file paths
    /* v3.55.0 RAISED IT FROM 4 TO 6, for two spans and the same rule. The
       Agent-memory page became five blocks, each with its own ⓘ fold, and two
       of those folds name the same two kinds of literal the budget already
       exists for: `my-curator` (the package a user configures, in the Current
       handoff fold) and `state/<project>/project.md` (the file a user opens in
       a text editor, in the Standing brief fold). Both are things the reader
       retypes or opens, which is exactly the case the four existing spans are
       allowed for.
       WHAT WAS REFUSED in the same pass: a `mono` span around the words
       "file time" in the Status fold. That is the app quoting its OWN UI text,
       not a literal anyone types, and it was rewritten in quotation marks
       instead — so this is 6 rather than 7.
       ALSO REFUSED: the work-stream table's slug column. It genuinely wants
       the code face, and it takes it through a named rule (`.mem-ws-slug` in
       views/memory.css) rather than through the utility class, because a table
       cell's type belongs in the stylesheet that owns the table. */
    'views/memory.js': 6,
  };
  const findings = [];
  for (const rel of OWNED_JS) {
    const n = (read(rel).match(/class="[^"]*\bmono\b[^"]*"/g) || []).length;
    const allowed = KEPT[rel] || 0;
    if (n > allowed) findings.push(`${rel}: ${n} (allowed ${allowed})`);
  }
  ok(findings.length === 0, findings.length === 0
    ? 'no view emits more monospace spans than its stated literal budget'
    : 'monospace spans over budget: ' + findings.join(', '));
  // The budget is a CAP; this pins the SHAPE of what survives, so a future
  // `mono` cannot slip in under the cap by replacing an eyebrow.
  {
    const kept = (read('views/chat.js').match(/class="([^"]*)\bmono\b([^"]*)"/g) || [])
      .map((c) => c.replace(/class="|"| ?\bmono\b ?/g, '').trim()).sort();
    // v3.72.0 (P4): the model id's mono span moved to shared/model-row.js
    // (`mr-id`, browse dialog only), so chat.js keeps only its eyebrows.
    ok(JSON.stringify(kept) === JSON.stringify([
      'chat-msg-eyebrow', 'chat-msg-eyebrow', 'chat-msg-eyebrow', 'chat-msg-eyebrow',
    ]), `views/chat.js keeps mono ONLY on its eyebrows (got ${kept.join(', ')})`);
  }
  // The stylesheets, from the other side: the chip and the wikilink no longer
  // name the mono family at all.
  const chat = stripComments(read('views/chat.css'));
  ok(!/font-family:\s*var\(--font-mono\)/.test(declForBody(stripComments(read('shared/page-chip.css')), '.page-chip')),
    '.page-chip (the Sources chip, v3.72.0) is not set in the code face');
  ok(!/font-family:\s*var\(--font-mono\)/.test(declForBody(chat, '.chat-wikilink')),
    '.chat-wikilink is not set in the code face either — a [[link]] in a sentence is a name');
  ok(/font-family:\s*var\(--font-mono\)/.test(declForBody(chat, '.chat-answer code')),
    'control: …and CODE still is, so the face was re-aimed rather than abolished');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. Rows on a material take the alpha overlay, not an opaque fill');
// ═════════════════════════════════════════════════════════════════════════
{
  /* An opaque fill on a translucent plane REPLACES the material for the width
     of the row: the blur stops, the plane's own tint stops, and the hover
     reads as a hole punched in the sidebar rather than as a lit row. The
     overlays composite onto the plane instead, which is what AppKit does. */
  const ROWS = [
    // `.chat-conv-row:hover/.active` WERE HERE. v3.72.0 (P3): Chat's rows are
    // the ONE sidebar row, so `.cur-sb-row` below is their rule too.
    // THE DOMAINS ROW IS THE KIT'S SINCE v3.65.0. `.dm-row` still rides the
    // same element as an ALIAS, but the RULES moved to shared/sidebar.css
    // when all three sidebars became one component — so the declaration this
    // section is really about is read where the browser reads it. The
    // `.mem-row` entry that used to sit here is GONE: v3.65.0's Context
    // package adopted the same kit row for memory.js, so `.cur-sb-row:hover`
    // above already covers it — a second entry would assert the same rule
    // under a selector that no longer exists.
    ['shared/sidebar.css', '.cur-sb-row:hover', '--mat-row-hover'],
    ['shared/sidebar.css', '.cur-sb-row.active', '--mat-row-active'],
    ['views/ingest.css', '.ing-dest-row:hover:not([disabled])', '--mat-row-hover'],
    ['views/ingest.css', '.ing-dest-row.active', '--mat-row-active'],
  ];
  const wrong = [];
  for (const [file, sel, tok] of ROWS) {
    const decl = declFor(read(file), sel, 'background');
    if (!decl || !decl.includes(tok)) wrong.push(`${file} ${sel} -> ${decl}`);
  }
  ok(wrong.length === 0, wrong.length === 0
    ? `all ${ROWS.length} sidebar row states take a --mat-row-* overlay`
    : 'row states still on an opaque surface: ' + wrong.join(', '));
  // ...AND THE VIEW KEPT NO COPY. While views/domains.css also declared the
  // row, both files painted the same values and nothing could move — which is
  // exactly what lets a duplication survive a review. The move is asserted
  // from this side too, because this is the section that names the rule.
  ok(!/\.dm-row(?![a-z-])[^{}]*\{/.test(stripComments(read('views/domains.css'))),
    'views/domains.css declares no `.dm-row` rule of its own — the row MOVED into the kit, '
    + 'it was not copied into it');

  // …and the overlay really is the larger step off the plane, measured. If it
  // were not, this would be a rename rather than a fix.
  for (const [name, T] of [['dark', D], ['light', L]]) {
    const plane = composite(toRgb(resolve(T, '--mat-sidebar')), toRgb(resolve(T, '--canvas')));
    const hovered = composite(toRgb(resolve(T, '--mat-row-hover')), plane);
    const opaque = toRgb(resolve(T, '--surface-hover'));
    const step = r2(ratio(hovered, plane));
    const wasStep = r2(ratio(opaque, plane));
    ok(step > wasStep,
      `${name}: the overlay steps ${step}:1 off the plane where --surface-hover managed ${wasStep}:1`);
  }

  // THE EXCEPTION THIS SECTION USED TO CARVE OUT FOR `.mem-row.active` IS
  // RETIRED (v3.65.0, R2): the accent-tinted "selected scope" treatment is
  // gone with the bespoke row — the kit's `.cur-sb-row.active` above is a
  // FILLED plane (`--mat-row-active`) like every other row, so the active
  // state is uniform everywhere now and there is nothing left to carve out.
}

// ═════════════════════════════════════════════════════════════════════════
section('9. The two wizards are SHEETS');
// ═════════════════════════════════════════════════════════════════════════
{
  const SHEETS = [['views/shared.css', '.sbw-scrim', '.sbw-card'],
                  ['views/mcp-wizard.css', '.mcpw-scrim', '.mcpw-card']];
  for (const [file, scrim, card] of SHEETS) {
    const css = read(file);
    ok(declFor(css, scrim, 'align-items') === 'flex-start',
      `${scrim} aligns to the TOP of the window — a sheet hangs from the chrome, it does not float in the middle`);
    ok(/^0(px)?\s/.test(declFor(css, scrim, 'padding') || ''),
      `…with no top padding, so the sheet is flush with the chrome it came from (got ${declFor(css, scrim, 'padding')})`);
    const body = declForBody(css, card);
    ok(/background:\s*var\(--mat-sheet\)/.test(body), `${card} is on the --mat-sheet material`);
    ok(/backdrop-filter:\s*blur\(var\(--mat-blur\)\)\s*saturate\(var\(--mat-sat\)\)/.test(body),
      '…with the blur and saturate that make it a plane rather than a flat fill');
    ok(/--mat-edge-hi/.test(body) && /--mat-edge-lo/.test(body),
      '…and BOTH edge lines — one reads as a div border, two read as a plane with thickness');
    ok(/var\(--elev-4\)/.test(body), '…on --elev-4, the sheet rung');
    ok(/animation:\s*curator-sheet-in\s+var\(--dur-sheet-in\)\s+var\(--ease-emphasized\)/.test(body),
      '…and it travels on --ease-emphasized over --dur-sheet-in, both tokens rather than literals');
    // A 0ms animation still paints its from-state for one frame, so the rule
    // keeps its own escape even though the duration token is already zeroed.
    ok(new RegExp('@media \\(prefers-reduced-motion: reduce\\) \\{\\s*' + card.replace('.', '\\.') + ' \\{ animation: none; \\}')
      .test(stripComments(css)),
      '…and carries its own `animation: none` escape under prefers-reduced-motion');
  }
  // THE REFUSAL, asserted so it cannot be quietly reversed: the guidance panel
  // is NOT a sheet, and its own file says why.
  const ob = stripComments(read('views/onboarding.css'));
  ok(!/--mat-sheet|--mat-menu|backdrop-filter/.test(ob),
    '.obp-panel takes no material and no blur — it is a docked panel that floats over nothing, and R7 forbids a modal here');
  ok(/box-shadow:\s*var\(--elev-3\)/.test(declForBody(read('views/onboarding.css'), '.obp-panel')),
    '…but it does take --elev-3, so it lifts on the same scale as everything else this pass touched');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. Nothing interactive in a view is under --hit-min');
// ═════════════════════════════════════════════════════════════════════════
{
  /* macOS's DEFAULT control target is 28x28pt. Two techniques are accepted
     and both are used here: grow the BOX (the scope pills, .btn-xs), or keep
     the glyph and grow the TARGET with a transparent ::before (the two delete
     buttons, the queue's remove). A third exists only for <input> checkboxes,
     which render no ::before at all: a wrapping <label> at --hit-min. */
  /* `chip` IS NOT IN THIS LIST, and that matches the design-kit suite's own
     classifier, which rejects `.reader-tag-chip` by name as "a
     non-interactive chip". Verified here rather than copied: `.dm-chip` is a
     <span> with no handler — a health readout — and inflating it to 28 would
     put a 28px box inside a 25px readout. The ONE chip in these views that
     IS a button, `.chat-cite-chip`, is asserted by name below instead, so
     the exception is written down rather than swallowed by a pattern.

     `sep` and `attn` join the reject list for the same reason `dot` is
     already there: `.chat-browse-sep` is a 1x16px vertical rule and
     `.dm-row-attn` a 6px marker. Neither is something anyone clicks. */
  const CONTROL_TAIL = /^\.[a-z0-9-]*(btn|pill|close|remove|delete|toggle|refresh|tab|link|row|check|hit)[a-z0-9-]*(:[a-z-]+(\([^)]*\))?)*$/i;
  const isControl = (sel) => {
    const last = sel.split(/\s|>/).filter(Boolean).pop() || '';
    if (/dot|badge|icon|mark|svg|label|list|name|size|meta|sep|attn/i.test(last)) return false;
    return CONTROL_TAIL.test(last);
  };
  // The one chip that IS a control, graded by name because the pattern above
  // deliberately cannot see it.
  ok(/button\.page-chip\s*\{[^}]*height:\s*var\(--hit-min\)/.test(stripComments(read('shared/page-chip.css'))),
    'button.page-chip (the Sources chip, v3.72.0) is a real <button> and grew its BOX to --hit-min — the one chip the classifier above cannot reach');
  const small = [];
  for (const rel of OWNED) {
    const css = stripComments(read(rel));
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ');
      if (sel.includes(',') || /::(before|after)/.test(sel)) continue;
      if (!isControl(sel)) continue;
      const h = /(?:^|;|\s)height:\s*(\d+)px/.exec(m[2]);
      if (!h || +h[1] >= 28) continue;
      const base = sel.replace(/:[a-z-]+(\([^)]*\))?$/g, '');
      const esc = new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '::before\\s*\\{[^}]*--hit-min');
      if (esc.test(css)) continue;
      small.push(`${rel} ${sel} height:${h[1]}px`);
    }
  }
  ok(small.length === 0, small.length === 0
    ? 'every under-28px control in the eight views grows its TARGET to --hit-min with a transparent ::before'
    : 'under-target controls with no hit box: ' + small.join(', '));

  // The three ::before hit boxes are real and DERIVED from --hit-min and the
  // glyph size, not written as a magic number.
  /* `.chat-bulk-delete` WAS HERE AT 20px AND IS GONE — deliberately, and the
     removal is the fix rather than a concession. The bulk-delete control is
     `btn btn-danger btn-xs` now; `.btn-xs` is `--control-sm`, which IS
     `--hit-min` (28px), so its REAL box is the target and the transparent
     ::before has nothing left to do. Asserted below rather than merely
     dropped, so "the entry went away" cannot mean "the control shrank and
     nobody noticed". */
  const DERIVED = [
    // v3.72.0 (P3): `.chat-conv-delete` became the ONE row action.
    ['shared/row-action.css', '.row-act', 24],
    ['views/ingest.css', '.ing-queue-file-remove', 20],
  ];
  for (const [file, sel, px] of DERIVED) {
    const css = stripComments(read(file));
    const re = new RegExp(sel.replace('.', '\\.') + '::before\\s*\\{[^}]*inset:\\s*calc\\(\\(var\\(--hit-min\\) - ' + px + 'px\\) / -2\\)');
    ok(re.test(css), `${sel} keeps its ${px}px glyph and grows its target to --hit-min via a derived ::before`);
    ok(new RegExp(sel.replace('.', '\\.') + '\\s*\\{[^}]*position:\\s*relative').test(css),
      `…and is positioned, without which that ::before would anchor to an ancestor and grow the wrong box`);
  }
  // The retired hit box: the control it belonged to must now reach --hit-min
  // by its BOX, through the shell, and this file must no longer declare it.
  {
    const chat = stripComments(read('views/chat.css'));
    const shell = stripComments(readFileSync(path.join(NEXT, 'shell.css'), 'utf8'));
    ok(!/\.chat-bulk-delete\s*(\{|,|:|::)/.test(chat),
      '.chat-bulk-delete is no longer declared in views/chat.css at all — the bulk-delete control is a shell variant');
    ok(/\.btn-xs\s*\{[^}]*height:\s*var\(--control-sm\)/.test(shell),
      '…and the variant it took, .btn-xs, sets its height from --control-sm');
    const space = stripComments(readFileSync(path.join(NEXT, 'tokens/space.css'), 'utf8'));
    const material = stripComments(readFileSync(path.join(NEXT, 'tokens/material.css'), 'utf8'));
    const sm = /--control-sm:\s*(\d+)px/.exec(space);
    const hit = /--hit-min:\s*(\d+)px/.exec(material);
    ok(!!sm && !!hit && sm[1] === hit[1],
      `…and --control-sm (${sm ? sm[1] : '?'}px) IS --hit-min (${hit ? hit[1] : '?'}px), which is WHY the ::before ` +
      'could be deleted rather than moved — asserted as the arithmetic, so a future edit that shrinks either token ' +
      'goes red here instead of silently re-opening a 20px target on a control that deletes N conversations');
  }

  // The checkbox labels — the ONE case the ::before technique cannot reach.
  ok(/\.chat-conv-check-hit\s*\{[^}]*height:\s*var\(--hit-min\)/.test(stripComments(read('views/chat-list.css'))),
    'the conversation checkbox is wrapped in a <label> at --hit-min — an <input> renders no ::before, so the label is its only possible target');
  ok(/\.chat-bulk-all\s*\{[^}]*min-height:\s*var\(--hit-min\)/.test(stripComments(read('views/chat-list.css'))),
    'and so is the bulk "Select all" label');
  ok(/\.sbw-checkbox-label\s*\{[^}]*min-height:\s*var\(--hit-min\)/.test(stripComments(read('views/shared.css'))),
    'and the Shared Brain wizard\'s consent and domain labels');
  ok(!/\.cur-check::before/.test(stripComments(read('shared/checkbox.css'))),
    'control: .cur-check itself declares NO ::before, which is exactly why the labels have to carry it');

  // Anti-vacuity, three ways, because this scan has three ways to lie.
  ok(isControl('.x-btn') && isControl('.chat-scope-pill:active'),
    'control: the classifier accepts a control and a control in a state');
  ok(!isControl('.dm-row-dot') && !isControl('.mem-row-name') && !isControl('.ing-queue-file-size')
     && !isControl('.chat-browse-sep') && !isControl('.dm-row-attn') && !isControl('.dm-chip'),
    'control: it rejects a decorative dot, a row label, a figure, a separator, an attention marker and a non-interactive chip');
  {
    const probe = 'a{}\n.x-btn{height:20px}';
    const found = [...probe.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => isControl(m[1].trim()) && /height:\s*(\d+)px/.test(m[2]) && +/height:\s*(\d+)px/.exec(m[2])[1] < 28);
    ok(found.length === 1, 'control: a 20px control with no ::before IS reported (the scan can fail)');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('11. What §10 CANNOT see, pinned by name because a browser found it');
// ═════════════════════════════════════════════════════════════════════════
{
  /* §10 reads `height: Npx` out of the stylesheet. That finds a control whose
     box is declared and misses every control whose box is the SUM of its
     padding, its line-height and its content — which a source scan cannot
     compute and a layout engine computes for free.

     SEVEN CONTROLS WERE UNDER macOS's 28pt DEFAULT AND §10 REPORTED NONE OF
     THEM. Measured in a real browser at 1280x860, both themes:

         .obp-dismiss        24x24   the only control that puts the guidance
                                     panel away
         .obp-go             95x26   its primary action
         .dm-dismiss-btn     56x22   dismiss / restore on a health row — the
         .dm-restore-btn             smallest real buttons in the app
         .mem-refresh        51x16   no height declared at all; padding only
         .ing-browse-link    95x14   the ONE way into the file picker that
                                     does not involve dragging, i.e. the
                                     fallback for anyone who cannot drag
         .dm-group-fixall-btn 26     (this one §10 did catch)

     They are pinned HERE, by name, rather than by teaching §10 to compute
     layout — which it cannot do honestly from text. The next reader should
     know that this list came from rendering the app, and that the scan above
     is a floor rather than a proof. */
  const PINNED = [
    ['views/onboarding.css', '.obp-panel .obp-go', /height:\s*var\(--control-sm\)/],
    ['views/onboarding.css', '.obp-dismiss', /position:\s*relative/],
    ['views/domains.css', '.dm-dismiss-btn', /height:\s*var\(--control-sm\)/],
    ['views/domains.css', '.dm-group-fixall-btn', /height:\s*var\(--control-sm\)/],
    // `.mem-refresh` WAS HERE, at its browser-found 51x16. v3.65.0's Context
    // package retired that bespoke link: Refresh is a full-width
    // `btn btn-secondary` in the head slot now, so its height comes from
    // `.btn`'s `--control-md` — the ordinary control floor, not a hit-target
    // grown past its own box.
    ['views/ingest.css', '.ing-browse-link', /min-height:\s*var\(--hit-min\)/],
  ];
  const unpinned = [];
  for (const [file, sel, re] of PINNED) {
    if (!re.test(declForBody(read(file), sel))) unpinned.push(`${file} ${sel}`);
  }
  ok(unpinned.length === 0, unpinned.length === 0
    ? `all ${PINNED.length} browser-found targets still reach --hit-min or --control-sm`
    : 'browser-found targets that regressed: ' + unpinned.join(', '));
  ok(/\.obp-dismiss::before\s*\{[^}]*inset:\s*calc\(\(var\(--hit-min\) - 24px\) \/ -2\)/
    .test(stripComments(read('views/onboarding.css'))),
    '.obp-dismiss keeps its 24px glyph and grows its TARGET with a derived ::before');
  // Control: the pin can fail. A selector that does not exist must not read
  // as a pass, which is what a bare `.test('')` would do for a truthy regex.
  ok(declForBody(read('views/memory.css'), '.zz-not-a-real-selector') === '',
    'control: declForBody returns nothing for a selector that does not exist, so an absent rule cannot pass a pin');
  ok(!/min-height:\s*var\(--hit-min\)/.test(declForBody(read('views/memory.css'), '.zz-not-a-real-selector')),
    'control: …and the pin above therefore fails on one, rather than matching an empty string');

  /* ── AND THE THREE FOUNDATION CONTROLS, NOW FIXED ───────────────────────
     The same rendered sweep found `cursor: pointer` on `.cur-check`
     (shared/checkbox.css), `.tx-vh-info` and `.tx-explainer-summary`
     (shared/text.css) — the hand cursor on a checkbox, on the info mark that
     appears on eleven surfaces, and on every explainer disclosure. All three
     were in the foundation layer THIS PASS did not own, so the assertion here
     used to say `foreign.length === 2` — it asserted they were STILL WRONG,
     so that it would go red the day they were fixed rather than sit as a lie.

     They were fixed at the release merge, which is exactly the event that
     assertion was built to force, so it is INVERTED rather than deleted: the
     record becomes a guard. `.cur-check-label` was corrected in the same
     sweep — it wraps `.cur-check`, so a hand cursor on the label put the hand
     back over the checkbox by another door, and leaving it would have made a
     file-level check impossible to state honestly.

     `not-allowed` is deliberately NOT swept: it is a different statement (this
     control exists and is refusing you) and is the idiom used throughout this
     tree, in the views as well as here. */
  const foreign = ['shared/checkbox.css', 'shared/text.css']
    .filter((f) => /cursor:\s*pointer/.test(stripComments(read(f))));
  ok(foreign.length === 0,
    foreign.length === 0
      ? 'FIXED: no `cursor: pointer` survives in shared/checkbox.css or shared/text.css either'
      : `${foreign.join(' and ')} still set cursor: pointer`);
  // Replaced, not merely deleted — the same distinction §5 draws for the
  // views. An absent `cursor` inherits, which on a <button> is not the arrow.
  for (const [file, sel] of [['shared/checkbox.css', '.cur-check'],
                             ['shared/checkbox.css', '.cur-check-label'],
                             ['shared/text.css', '.tx-vh-info'],
                             ['shared/text.css', '.tx-explainer-summary']]) {
    ok(/cursor:\s*default/.test(declForBody(read(file), sel)),
      `${sel} (${file}) declares \`cursor: default\` — the pointer was replaced, not dropped`);
  }
  // Control: the pin above can fail. A selector with no cursor at all must
  // not read as a pass.
  ok(!/cursor:\s*default/.test(declForBody(read('shared/text.css'), '.zz-no-such-control')),
    'control: …and that pin fails on a selector that declares no cursor, so an absent rule cannot pass it');
  // …and `not-allowed` survives, so the sweep did not flatten the disabled
  // statement into the ordinary one.
  ok(/cursor:\s*not-allowed/.test(stripComments(read('shared/checkbox.css'))),
    '…while `cursor: not-allowed` is untouched — a refusal is a different statement from an ordinary control');
}

console.log('\n' + '─'.repeat(60));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ /next view-adoption assertions FAILED'); process.exit(1); }
console.log('✅ All /next view-adoption assertions green');
