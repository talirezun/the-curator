/**
 * test-next-icons.js — OFFLINE suite for two visual defects in the /next
 * shell found by the maintainer driving the real UI:
 *
 *   (1) The theme toggle (sun/moon) and the Settings rail button rendered
 *       the SAME icon. `VIEW_META.settings.icon` was `'settings'`, and
 *       ICON_BODY *did* have a `settings` key — but its gear-teeth outline
 *       path carried `opacity="0"`, so all that ever rendered was a small
 *       center circle plus 8 short radiating tick lines: a smaller,
 *       shorter-rayed copy of the `sun` glyph immediately below it in the
 *       same table. Fixed by replacing the body with a real cog (a ring +
 *       a smaller center hole + 8 teeth that touch the ring), and by
 *       making `icon()`'s fallback for an unknown name LOUD instead of
 *       silently rendering a legitimate, easily-confused glyph (`dot`).
 *
 *   (2) The favicon (`next/index.html`) linked `mark-small-on-dark.svg` —
 *       bright ink built for a dark background — so on the light browser
 *       tab background most users have most of the time, it was nearly
 *       invisible. Fixed by switching to `mark-small-on-light.svg` (dark
 *       ink, plus mid-tone saturated accent dots that carry visibility on
 *       a dark tab too).
 *
 * No network, no API key, no server, no browser. `ICON_BODY`, `VIEW_META`
 * and the `icon()` function are extracted from the REAL source by
 * brace-matching and evaluated standalone with `new Function` — the same
 * technique test-next-mcp-wizard.js and test-next-onboarding.js use, so a
 * rename or a refactor that breaks this extraction fails LOUDLY here
 * rather than silently testing nothing.
 *
 * ── What this suite ACTUALLY covers ─────────────────────────────────────
 * COVERED, behaviourally (the real ICON_BODY/VIEW_META objects and the
 * real icon() function are executed, not re-derived by this test):
 *   - Every VIEW_META[*].icon name resolves to a real ICON_BODY entry —
 *     the class-level assertion the task asked for. Mutation-proven: with
 *     the `settings` key deleted, this goes RED for a BEHAVIOURAL reason
 *     (the resolved body falls back to the placeholder and the identity
 *     check fails), not a syntax error.
 *   - `icon('settings', 18)` no longer contains `opacity="0"` anywhere in
 *     its output (the literal bug) and its body differs from `icon('sun')`
 *     and `icon('moon')`'s bodies (the reported symptom — "same icon").
 *   - `icon()` on an unknown name renders the dedicated missing-icon body
 *       (never ICON_BODY.dot, never a legitimate glyph) and logs via
 *       console.error exactly once.
 *   - `icon()` on every real ICON_BODY key renders that key's exact body
 *     with no console.error call — the fallback change didn't regress the
 *     happy path for any of the ~35 existing glyphs.
 *
 * COVERED, as source-level / file-level guards (stated as such, not as
 * behaviour):
 *   - next/index.html's favicon link points at the on-light asset, that
 *     asset exists on disk under next/assets/, and the reference is
 *     root-absolute + /next/-prefixed (test-next-asset-paths.js's own
 *     convention — a bare-relative ref at `/` resolves to HTML at 200
 *     with no 404 to notice).
 *   - The on-light asset's ink is dark (#14141F) and the on-dark asset's
 *     ink is light (#EDEDF4) — a sanity check that the two files are what
 *     their names claim, so a future asset swap can't silently pick the
 *     wrong one again.
 *
 * NOT COVERED here (stated rather than implied):
 *   - Actual pixel rendering / legibility at 18px, or how a real browser
 *     paints an SVG favicon against its own chrome color. Verified
 *     separately in a live browser for this change; not reproducible from
 *     here.
 *   - Whether real browsers honour `media="(prefers-color-scheme)"` on
 *     `<link rel="icon">` — moot, since this fix deliberately ships a
 *     single asset rather than relying on that (see index.html's comment
 *     for why).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const APP_PATH = path.join(ROOT, 'src/public/next/app.js');
const app = readFileSync(APP_PATH, 'utf8');
const NEXT_HTML_PATH = path.join(ROOT, 'src/public/next/index.html');
const nextHtml = readFileSync(NEXT_HTML_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── Extraction helpers (brace-matched, fail loudly on desync) ───────────

function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in app.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
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
  // Strip a leading "export " so `new Function` doesn't choke on it.
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

// Brace-matched object-literal const extractor — used for VIEW_META and
// ICON_BODY, both `const NAME = { ... };` spanning many lines. Brace
// matching (not a semicolon-terminated regex) because a future glyph could
// legitimately contain other punctuation; this can't desync on that.
function extractObjectConst(src, name) {
  const marker = new RegExp(`(?:^|\\n)const ${name} = \\{`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractObjectConst: "${name}" not found in app.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const braceStart = src.indexOf('{', start);
  let i = braceStart, depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i);
  if (!extracted.trim().endsWith('}')) {
    throw new Error(`extractObjectConst: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

console.log('\n=== 1. Extraction sanity ===');
let viewMetaSrc, iconBodySrc, missingBodySrc, iconFnSrc;
try {
  viewMetaSrc = extractObjectConst(app, 'VIEW_META');
  iconBodySrc = extractObjectConst(app, 'ICON_BODY');
  iconFnSrc = extractFunction(app, 'icon');
  const missingMarker = /(?:^|\n)const MISSING_ICON_BODY = ([\s\S]*?);\n/.exec(app);
  if (!missingMarker) throw new Error('MISSING_ICON_BODY constant not found');
  missingBodySrc = `const MISSING_ICON_BODY = ${missingMarker[1]};`;
  ok(true, 'VIEW_META, ICON_BODY, MISSING_ICON_BODY and icon() all extracted cleanly');
} catch (e) {
  ok(false, `extraction failed: ${e.message}`);
  console.log(`\nPassed: ${passed}   Failed: ${failed}`);
  process.exit(1);
}

// Sandbox: real objects + real function, no DOM, capturing console.error
// calls instead of letting them hit stderr (they're an assertion target,
// not noise).
const consoleLog = [];
const sandbox = new Function(
  'consoleLog',
  `${missingBodySrc}\n${viewMetaSrc}\n${iconBodySrc}\n` +
  `const console = { error: (...a) => consoleLog.push(a.join(' ')) };\n` +
  `${iconFnSrc}\n` +
  `return { VIEW_META, ICON_BODY, MISSING_ICON_BODY, icon };`
);
const { VIEW_META, ICON_BODY, MISSING_ICON_BODY, icon } = sandbox(consoleLog);

// ── 2. Every VIEW_META icon resolves — the class-level fix ──────────────

console.log('\n=== 2. Every VIEW_META[*].icon exists in ICON_BODY ===');
const viewNames = Object.keys(VIEW_META);
ok(viewNames.length >= 7, `VIEW_META has ${viewNames.length} views (sanity floor)`);

for (const v of viewNames) {
  const iconName = VIEW_META[v].icon;
  ok(Object.prototype.hasOwnProperty.call(ICON_BODY, iconName),
     `VIEW_META.${v}.icon ("${iconName}") is a real ICON_BODY key`);
}

// Behavioural companion: rendering every VIEW_META icon must never fall
// through to the missing-icon placeholder, and must never log an error.
console.log('\n=== 3. Rendering every VIEW_META icon hits a real glyph, not the placeholder ===');
for (const v of viewNames) {
  consoleLog.length = 0;
  const iconName = VIEW_META[v].icon;
  const rendered = icon(iconName, 18);
  const expectedBody = ICON_BODY[iconName];
  ok(expectedBody !== undefined && rendered.includes(expectedBody),
     `icon(VIEW_META.${v}.icon) renders the real "${iconName}" body`);
  ok(!rendered.includes(MISSING_ICON_BODY.match(/rect[^>]*>/)?.[0] || ' IMPOSSIBLE'),
     `icon(VIEW_META.${v}.icon) does not fall back to the missing-icon placeholder`);
  ok(consoleLog.length === 0, `icon(VIEW_META.${v}.icon) logs no console.error`);
}

// ── 4. The specific "settings looks like sun" bug ────────────────────────

console.log('\n=== 4. Defect 1 — settings vs sun/moon ===');
// Guarded with a fallback empty string rather than letting a missing key
// throw mid-suite: if `settings` regresses to undefined, assertion 2 (the
// class-level VIEW_META-vs-ICON_BODY check above) already reports it, and
// this section should degrade to more REDs, not an uncaught exception that
// hides everything after it. Mutation-tested by deleting ICON_BODY.settings
// entirely: this section still reports clean, itemised failures.
const settingsBody = ICON_BODY.settings || '';
ok(typeof ICON_BODY.settings === 'string' && ICON_BODY.settings.length > 0,
   'ICON_BODY.settings exists and is non-empty');
ok(!settingsBody.includes('opacity="0"'),
   'ICON_BODY.settings has no opacity="0" segment (the literal bug — a hidden gear body)');
ok(settingsBody !== '' && settingsBody !== ICON_BODY.sun && settingsBody !== ICON_BODY.moon,
   'ICON_BODY.settings differs from both sun and moon');

// The reported symptom was specifically that settings and the theme
// toggle (sun/moon) were indistinguishable. Structural check standing in
// for "looks different": settings must contain a ring-sized circle (a
// gear body) that sun does not have — sun's only circle is a small dot.
const settingsCircleRadii = [...settingsBody.matchAll(/<circle[^>]*\br="([\d.]+)"/g)].map(m => parseFloat(m[1]));
const sunCircleRadii = [...(ICON_BODY.sun || '').matchAll(/<circle[^>]*\br="([\d.]+)"/g)].map(m => parseFloat(m[1]));
ok(settingsCircleRadii.some(r => r >= 5),
   `settings has a ring-sized circle (radii found: ${settingsCircleRadii.join(', ')})`);
ok(sunCircleRadii.length > 0 && sunCircleRadii.every(r => r < 5),
   `sun has no ring-sized circle, only its small center dot (radii found: ${sunCircleRadii.join(', ')})`);

const settingsRendered = icon('settings', 18);
ok(!settingsRendered.includes('opacity="0"'), 'icon(\'settings\', 18) output has no hidden segment');

// ── 5. icon() fallback is loud, not a legitimate lookalike glyph ────────

console.log('\n=== 5. Defect 1, class-level — unknown icon names ===');
consoleLog.length = 0;
const unknownRendered = icon('this-icon-does-not-exist', 18);
ok(unknownRendered.includes(MISSING_ICON_BODY), 'unknown name renders the dedicated missing-icon placeholder');
ok(!unknownRendered.includes(ICON_BODY.dot), 'unknown name does NOT fall back to ICON_BODY.dot (the old, confusable fallback)');
ok(consoleLog.length === 1 && consoleLog[0].includes('this-icon-does-not-exist'),
   'unknown name logs exactly one console.error naming the bad key');

consoleLog.length = 0;
const knownRendered = icon('dot', 18);
ok(knownRendered.includes(ICON_BODY.dot) && consoleLog.length === 0,
   'a real name ("dot") still renders correctly with no console.error (fallback change is additive, not a regression)');

// Prototype-pollution-shaped names must not resolve via the prototype
// chain (Object.prototype.hasOwnProperty is the load-bearing check here,
// not `in` or bracket-truthiness).
consoleLog.length = 0;
const protoRendered = icon('constructor', 18);
ok(protoRendered.includes(MISSING_ICON_BODY), `icon('constructor') is treated as unknown, not resolved via the prototype chain`);

// ── 6. Favicon (Defect 2) ────────────────────────────────────────────────

console.log('\n=== 6. Defect 2 — favicon visible on a light tab ===');
const faviconMatch = /<link rel="icon" href="([^"]+)">/.exec(nextHtml);
ok(!!faviconMatch, 'next/index.html has exactly one <link rel="icon"> (this suite assumes a single-asset fix — see its header comment)');

const faviconHref = faviconMatch ? faviconMatch[1] : '';
ok(faviconHref === '/next/assets/mark-small-on-light.svg',
   `favicon points at the on-light asset (got "${faviconHref}")`);
ok(faviconHref.startsWith('/next/'), 'favicon reference is root-absolute and /next/-prefixed (matches test-next-asset-paths.js\'s convention)');

const faviconDiskPath = path.join(ROOT, 'src/public', faviconHref.replace(/^\//, ''));
ok(existsSync(faviconDiskPath), `the referenced favicon file exists on disk (${faviconDiskPath})`);

// Sanity: the two mark assets are actually what their names claim — dark
// ink on the "on-light" file, light ink on the "on-dark" file — so a
// future swap back to the wrong one is at least structurally implausible.
const onLightSvg = existsSync(faviconDiskPath) ? readFileSync(faviconDiskPath, 'utf8') : '';
ok(onLightSvg.includes('#14141F'), 'mark-small-on-light.svg uses dark ink (#14141F)');
ok(!onLightSvg.includes('#EDEDF4'), 'mark-small-on-light.svg does not use the on-dark light ink (#EDEDF4)');

const onDarkPath = path.join(ROOT, 'src/public/next/assets/mark-small-on-dark.svg');
if (existsSync(onDarkPath)) {
  const onDarkSvg = readFileSync(onDarkPath, 'utf8');
  ok(onDarkSvg.includes('#EDEDF4'), 'mark-small-on-dark.svg (still on disk, unused by index.html now) uses light ink (#EDEDF4), confirming it really is the dark-background variant');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
