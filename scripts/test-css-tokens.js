/**
 * test-css-tokens.js — OFFLINE suite that catches undefined CSS custom
 * property references before they ship.
 *
 * CSS custom properties (`--name`) fail SILENTLY. In v3.0.12 styles.css
 * shipped `var(--text-dim)` — a variable that was never defined anywhere.
 * The declaration was invalid, so the browser fell back to the inherited /
 * UA-default colour (near-black on a `<button>`), and the chat composer's
 * dropdown text became unreadable on the dark theme. Nothing caught it
 * because there was no CSS test at all — it shipped to real users and was
 * only found from a bug report (see CLAUDE.md's v3.0.12 entry).
 *
 * This suite is a small, dependency-free (node: builtins only) CSS scanner:
 *   1. Reads every LOCAL stylesheet <link rel="stylesheet"> in index.html
 *      (external ones like Google Fonts are skipped — we don't control their
 *      custom-property surface, and they don't ship this app's theme tokens).
 *   2. Strips comments / string literals / plain url(...) contents so stray
 *      "--" sequences inside them can't be mistaken for real definitions or
 *      references.
 *   3. Extracts every `--name: value;` DEFINITION, wherever it appears
 *      (:root, inside a media query, inside a [data-theme] block, inside any
 *      selector) — a definition anywhere in the cascade counts as "defined".
 *   4. Extracts every `var(--name)` / `var(--name, fallback)` REFERENCE,
 *      including nested ones inside a fallback (`var(--a, var(--b, red))`
 *      references BOTH --a and --b).
 *   5. Asserts every referenced name has a matching definition. A fallback
 *      value is NOT a definition — `var(--missing, blue)` still requires
 *      `--missing` to be defined somewhere, exactly like the real
 *      `--text-dim` incident (which had no fallback at all).
 *
 * Section 0 is a battery of self-tests against small synthetic CSS strings
 * with known right/wrong answers, so this suite can't silently rot into a
 * no-op that always finds zero references.
 *
 * ── Pre-existing findings (baselined, not new) ──────────────────────────
 * Building this scanner and running it against the real app originally
 * surfaced FIVE distinct undefined custom-property names in `styles.css`.
 * TWO of them — `--font-mono` (real token: `--mono`) and `--text-1` (likely
 * meant `--text`/`--text-2`) — were the genuine `--text-dim`-class bugs: NO
 * fallback, so an invalid declaration silently fell back to inherited/UA
 * colour. Those two have SINCE BEEN FIXED in `styles.css` (another agent
 * corrected both call sites to the real token names), so they are gone from
 * KNOWN_ISSUES below and are instead locked in by an explicit regression
 * assertion in section 3 — reintroducing `var(--font-mono)` or
 * `var(--text-1)` now fails loudly with a dedicated message, not just the
 * generic "new undefined variable" bucket.
 *
 * THREE remain, all carrying a working hex fallback (so they render
 * correctly today — CSS's fallback mechanism means these are dead/orphaned
 * token names, not silent rendering bugs) and are deliberately left as-is
 * for the design-system token consolidation work rather than patched ad hoc
 * (this suite is not the CSS's owner and must not edit styles.css):
 *
 *   --text-primary   (2 refs, hex fallback: #e2e8f0)
 *   --text-secondary (3 refs, hex fallback: #94a3b8 / #b8c0e0)
 *   --surface-1      (1 ref,  hex fallback: #0f1117)
 *
 * These three are listed in KNOWN_ISSUES below and reported as ⚠ (not
 * counted as failures) so the suite stays green while remaining honest —
 * every run prints them, so they can't be silently forgotten. ANY new
 * undefined reference (any name not in this exact list) is a hard failure.
 * When one of these three is eventually fixed in styles.css, simply delete
 * its entry here — the suite doesn't require the issue to still exist.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// The parser
// ─────────────────────────────────────────────────────────────────────────

/** Blank out /* *\/ block comments, preserving length + newlines so char
 *  offsets computed against the ORIGINAL text stay valid for line numbers.
 */
function stripBlockComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '/' && text[i + 1] === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      for (let k = i; k < j; k++) out += text[k] === '\n' ? '\n' : ' ';
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Blank out any `// ...` line comment, UNLESS it's part of a URL scheme
 *  like `https://` (real .css never uses `//` comments; this is a defensive
 *  fallback in case a preprocessor-flavoured `//` sneaks into the file).
 *  Preserves length + newlines.
 */
function stripLineComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] === '/' && text[i + 1] === '/') {
      const prevNonSpace = out.replace(/\s+$/, '').slice(-1);
      if (prevNonSpace === ':') {
        // e.g. "https:" immediately before "//" — part of a URL, not a comment.
        out += text[i];
        i++;
        continue;
      }
      let j = text.indexOf('\n', i);
      j = j === -1 ? n : j;
      for (let k = i; k < j; k++) out += ' ';
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/** Blank the interior of '...' / "..." string literals (keep the quotes so
 *  length + structure are preserved). Prevents literal text like
 *  `content: "var(--fake)"` from being read as a real reference.
 */
function maskStrings(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < n && text[i] !== quote) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) { out += text[i]; i++; } // closing quote
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Blank the interior of `url(...)` calls, UNLESS the interior itself
 *  contains a `var(` (e.g. `url(var(--icon-url))`), which stays intact.
 *  Prevents a filename like `--fake-icon.png` from being read as real.
 */
function maskPlainUrls(text) {
  return text.replace(/url\(([^)]*)\)/g, (whole, inner) => {
    if (/var\(/.test(inner)) return whole;
    const blanked = inner.replace(/[^\n]/g, ' ');
    return `url(${blanked})`;
  });
}

/** Full cleanup pipeline: comments → strings → plain urls. Same length as
 *  the input, so indices/line numbers computed on the result are valid
 *  against the original source too.
 */
function cleanCss(text) {
  let out = stripBlockComments(text);
  out = stripLineComments(out);
  out = maskStrings(out);
  out = maskPlainUrls(out);
  return out;
}

/** Every `--name: value;` DEFINITION in the (cleaned) text. A definition
 *  must sit in declaration position — immediately after `{`, `;`, or the
 *  start of the file (ignoring whitespace) — and must not be followed by a
 *  second `:` (a `::pseudo-element` right after a BEM-style `--modifier`
 *  class, e.g. `.btn--primary::before`, must not be mistaken for one).
 *  This also naturally rejects `.btn--primary:hover` (no boundary char
 *  immediately before the `--`, since BEM class names have no whitespace
 *  there) and rejects a fallback like `var(--a, --not-a-def)` (no `:`
 *  follows the name there).
 *  Returns a Map<name, number[]> of every definition's char index.
 */
function extractDefinitions(cleaned) {
  const defs = new Map();
  const re = /--([a-zA-Z0-9_-]+)\s*:/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const idx = m.index;
    let k = idx - 1;
    while (k >= 0 && /\s/.test(cleaned[k])) k--;
    const prevChar = k >= 0 ? cleaned[k] : null;
    const isDeclStart = prevChar === null || prevChar === '{' || prevChar === ';';
    const afterColon = m.index + m[0].length;
    const isDoubleColon = cleaned[afterColon] === ':';
    if (isDeclStart && !isDoubleColon) {
      if (!defs.has(m[1])) defs.set(m[1], []);
      defs.get(m[1]).push(idx);
    }
  }
  return defs;
}

/** Every `var(--name)` / `var(--name, fallback)` REFERENCE in the (cleaned)
 *  text, including references nested inside another var()'s fallback.
 *  Returns [{name, index}].
 */
function extractReferences(cleaned) {
  const refs = [];
  const re = /var\(\s*--([a-zA-Z0-9_-]+)/g;
  let m;
  while ((m = re.exec(cleaned))) {
    refs.push({ name: m[1], index: m.index });
  }
  return refs;
}

function computeLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineNumberFor(lineStarts, index) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// ─────────────────────────────────────────────────────────────────────────
// 0. Parser self-tests — synthetic CSS with known right/wrong answers.
//    Without these, this suite could silently rot into a no-op that always
//    reports zero references (e.g. a regex typo that never matches anything
//    would still print a green summary).
// ─────────────────────────────────────────────────────────────────────────
section('0. Parser self-tests (synthetic CSS)');

{
  const src = `
:root { --known: red; }
.x { color: var(--known); }
.y { color: var(--missing-a, var(--missing-b, blue)); }
`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  const refNames = refs.map(r => r.name);

  ok(defs.has('known') && !defs.has('missing-a') && !defs.has('missing-b'),
    'definitions: only --known is defined');
  ok(refNames.includes('known'), 'references: plain var(--known) is found');
  ok(refNames.includes('missing-a'), 'references: outer var(--missing-a, ...) is found');
  ok(refNames.includes('missing-b'),
    'references: NESTED var(--missing-b, blue) inside a fallback is also found');
}

{
  // "A fallback value is not a definition" — a hardcoded fallback must NOT
  // make the extractor think the variable is defined.
  const src = `.z { color: var(--not-defined-anywhere, #ffffff); }`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  ok(!defs.has('not-defined-anywhere'),
    'a var() fallback value does not register as a definition');
  ok(refs.some(r => r.name === 'not-defined-anywhere'),
    'the reference itself is still recorded (so it can be checked against real definitions)');
}

{
  // Comments — both the /* */ block form and a defensive // line form —
  // must hide BOTH definitions and references inside them.
  const src = `
/* --should-not-count: red; */
// --also-should-not-count: blue;
.a {
  /* color: var(--commented-out-ref); */
  color: var(--should-not-count);
}
`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  ok(!defs.has('should-not-count'), 'a definition inside a /* */ comment is ignored');
  ok(!defs.has('also-should-not-count'), 'a definition inside a // comment is ignored');
  ok(!refs.some(r => r.name === 'commented-out-ref'),
    'a var() reference inside a /* */ comment is ignored (not counted as a real usage)');
  ok(refs.some(r => r.name === 'should-not-count'),
    'the REAL (non-commented) reference to --should-not-count is still found — proving the ' +
    'name is correctly flagged as undefined rather than accidentally suppressed');
}

{
  // A definition inside a media query or a [data-theme] block still counts.
  const src = `
:root { --light-only: blue; }
@media (prefers-color-scheme: dark) {
  :root { --dark-var: black; }
}
[data-theme="dark"] { --themed: navy; }
.b { color: var(--dark-var); }
.c { background: var(--themed); }
`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  ok(defs.has('dark-var'), 'a definition inside @media (prefers-color-scheme: dark) counts as defined');
  ok(defs.has('themed'), 'a definition inside a [data-theme="dark"] block counts as defined');
}

{
  // "--name" appearing inside a string or a plain url(...) must not be
  // mistaken for a real definition or reference.
  const src = `
.d::before { content: "var(--fake-in-string)"; }
.e { background: url(images/--fake-in-url.png); }
`;
  const cleaned = cleanCss(src);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  ok(!refs.some(r => r.name === 'fake-in-string'),
    'a "var(...)"-shaped string INSIDE a quoted string literal is not read as a real reference');
  ok(!defs.has('fake-in-url') && !refs.some(r => r.name === 'fake-in-url'),
    '"--"-shaped text inside a plain url(...) is not read as a definition or reference');
  // url(var(--icon)) — a legitimate modern reference — must NOT be masked away.
  const src2 = `.f { background: url(var(--icon-url)); }`;
  const refs2 = extractReferences(cleanCss(src2));
  ok(refs2.some(r => r.name === 'icon-url'), 'url(var(--x)) still extracts --x as a real reference');
}

{
  // BEM-style double-hyphen class modifiers immediately followed by a
  // pseudo-class/pseudo-element colon must never be mistaken for a
  // custom-property definition.
  const src = `.button--primary:hover { color: red; }`;
  const defs = extractDefinitions(cleanCss(src));
  ok(defs.size === 0,
    '.button--primary:hover is not misread as a definition of --primary');

  // Direct guard on the "::" (pseudo-element) rejection, independent of the
  // BEM prevChar guard above.
  const src2 = `; --weird::what { }`;
  const defs2 = extractDefinitions(cleanCss(src2));
  ok(!defs2.has('weird'), 'a name immediately followed by "::" (pseudo-element) is rejected');
}

{
  // Whitespace robustness inside var().
  const src = `.g { color: var(  --spaced  ,  blue  ); }`;
  const refs = extractReferences(cleanCss(src));
  ok(refs.some(r => r.name === 'spaced'), 'var( --spaced , blue ) with extra whitespace is still extracted');
}

{
  // Line-number accuracy.
  const src = `:root {\n  --a: red;\n}\n.h {\n  color: var(--undefined-thing);\n}\n`;
  const cleaned = cleanCss(src);
  const lineStarts = computeLineStarts(src);
  const refs = extractReferences(cleaned);
  const ref = refs.find(r => r.name === 'undefined-thing');
  ok(ref && lineNumberFor(lineStarts, ref.index) === 5,
    'line number is correctly computed for a reference several lines into the source');
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Discover every LOCAL stylesheet the app actually loads
// ─────────────────────────────────────────────────────────────────────────
section('1. Discover local stylesheets loaded by index.html');

const indexPath = path.join(ROOT, 'src/public/index.html');
const indexHtml = readFileSync(indexPath, 'utf8');

const linkRe = /<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi;
const hrefRe = /href=["']([^"']+)["']/i;
const allLinks = indexHtml.match(linkRe) || [];
const localCssFiles = [];
for (const tag of allLinks) {
  const hrefMatch = tag.match(hrefRe);
  if (!hrefMatch) continue;
  const href = hrefMatch[1];
  if (/^(https?:)?\/\//i.test(href)) continue; // external (e.g. Google Fonts) — not ours to check
  localCssFiles.push(href);
}

ok(allLinks.length > 0, 'index.html contains at least one <link rel="stylesheet"> tag');
ok(localCssFiles.includes('styles.css'), 'styles.css is discovered as a local stylesheet');
console.log(`  → local stylesheets found: ${localCssFiles.join(', ')}`);
console.log(`  → external stylesheets skipped: ${allLinks.length - localCssFiles.length} (e.g. Google Fonts — not this app's token surface)`);

// ─────────────────────────────────────────────────────────────────────────
// 2. Extract definitions + references from every local stylesheet
// ─────────────────────────────────────────────────────────────────────────
section('2. Extract definitions and references from the real app CSS');

const publicDir = path.dirname(indexPath);
const files = localCssFiles.map(href => ({
  relPath: `src/public/${href}`,
  absPath: path.join(publicDir, href),
}));

const globalDefs = new Set();
const perFileData = [];

for (const f of files) {
  const raw = readFileSync(f.absPath, 'utf8');
  const cleaned = cleanCss(raw);
  const defs = extractDefinitions(cleaned);
  const refs = extractReferences(cleaned);
  const lineStarts = computeLineStarts(raw);
  for (const name of defs.keys()) globalDefs.add(name);
  perFileData.push({ ...f, raw, cleaned, defs, refs, lineStarts });
}

const totalDefs = globalDefs.size;
const totalRefs = perFileData.reduce((n, f) => n + f.refs.length, 0);

ok(totalDefs > 0, `found ${totalDefs} distinct custom-property definitions across ${files.length} file(s)`);
ok(totalRefs > 0, `found ${totalRefs} total var() references across ${files.length} file(s)`);
console.log(`  → defined tokens: ${[...globalDefs].sort().join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────
// 3. Every referenced variable must be defined somewhere
// ─────────────────────────────────────────────────────────────────────────
section('3. Every var() reference resolves to a defined custom property');

// Pre-existing, already-in-production issues (see file header for full
// detail + provenance). Baselined by NAME so this suite stays green against
// the current codebase without hiding them — every run still prints them.
// A NEW undefined name (anything not in this exact list) is a hard failure.
// `--font-mono` and `--text-1` are DELIBERATELY NOT here — they were the two
// genuine no-fallback bugs and have been fixed in styles.css; section 3b
// below locks that fix in with a dedicated regression assertion instead of
// leaving them silently forgiven here.
const KNOWN_ISSUES = new Set([
  'text-primary',   // has a hex fallback; 2 refs
  'text-secondary', // has a hex fallback; 3 refs
  'surface-1',      // has a hex fallback; 1 ref
]);
ok(KNOWN_ISSUES.size === 3,
  'baseline contains exactly the three remaining fallback-carrying names (not the two already-fixed ones)');

const realOffenders = [];
const knownOffenders = [];

for (const f of perFileData) {
  for (const ref of f.refs) {
    if (globalDefs.has(ref.name)) continue; // defined somewhere — fine
    const line = lineNumberFor(f.lineStarts, ref.index);
    const declaration = f.raw.split('\n')[line - 1]?.trim() ?? '(unavailable)';
    const entry = { file: f.relPath, line, name: ref.name, declaration };
    if (KNOWN_ISSUES.has(ref.name)) knownOffenders.push(entry);
    else realOffenders.push(entry);
  }
}

if (knownOffenders.length > 0) {
  console.log(`\n  ⚠ ${knownOffenders.length} pre-existing (baselined) undefined-variable reference(s) — not new, not failing this suite:`);
  for (const o of knownOffenders) {
    console.log(`      ${o.file}:${o.line}  var(--${o.name})  →  ${o.declaration}`);
  }
}

ok(realOffenders.length === 0,
  realOffenders.length === 0
    ? 'no NEW undefined custom-property references found'
    : `found ${realOffenders.length} NEW undefined custom-property reference(s):\n` +
      realOffenders.map(o => `        ${o.file}:${o.line}  var(--${o.name})  →  ${o.declaration}`).join('\n')
);

// ─────────────────────────────────────────────────────────────────────────
// 3b. Regression lock — the two FIXED no-fallback bugs must never come back
// ─────────────────────────────────────────────────────────────────────────
// `--font-mono` and `--text-1` were undefined-with-NO-fallback references —
// the exact `--text-dim` silent-rendering-failure class — until styles.css
// was corrected (`--font-mono` → `--mono`, `--text-1` → `--text`). They are
// intentionally absent from KNOWN_ISSUES above, so without this explicit
// check a reintroduction would just land in the generic "new undefined
// variable" bucket in section 3. These two assertions name the exact
// regression so a failure is unmistakable.
const allRefs = perFileData.flatMap(f =>
  f.refs.map(r => ({ ...r, file: f.relPath, lineStarts: f.lineStarts }))
);
const fontMonoRefs = allRefs.filter(r => r.name === 'font-mono');
const text1Refs = allRefs.filter(r => r.name === 'text-1');

ok(fontMonoRefs.length === 0,
  fontMonoRefs.length === 0
    ? 'REGRESSION GUARD: var(--font-mono) is not referenced anywhere (the real token is --mono; this was the v3.0.12-class no-fallback bug)'
    : `REGRESSION: var(--font-mono) reintroduced at ${fontMonoRefs.map(r => `${r.file}:${lineNumberFor(r.lineStarts, r.index)}`).join(', ')} — the real token is --mono`
);
ok(text1Refs.length === 0,
  text1Refs.length === 0
    ? 'REGRESSION GUARD: var(--text-1) is not referenced anywhere (likely meant --text/--text-2; this was the v3.0.12-class no-fallback bug)'
    : `REGRESSION: var(--text-1) reintroduced at ${text1Refs.map(r => `${r.file}:${lineNumberFor(r.lineStarts, r.index)}`).join(', ')} — likely meant --text/--text-2`
);

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All CSS custom-property token assertions green');
