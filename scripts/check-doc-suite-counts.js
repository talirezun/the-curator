/**
 * check-doc-suite-counts.js — OFFLINE suite that keeps CONTRIBUTING.md's
 * test-suite count from going stale.
 *
 * HANDOFF.md recorded: "The CONTRIBUTING suite count has gone stale three
 * times this session. It wants to be generated, not hand-maintained." This
 * suite is the guard: it parses the OFFLINE / LIVE_CI / LIVE_LOCAL arrays
 * directly out of scripts/run-tests.js (the single source of truth — see
 * CLAUDE.md's "Test suite is run via `npm test`" decision) and asserts that
 * every "N suites total — N OFFLINE + N LIVE_CI + N LIVE_LOCAL" figure
 * written in prose in CONTRIBUTING.md still matches.
 *
 * ── The failure shape this suite exists to avoid ────────────────────────
 * This repo has a recorded pattern: "a check that stops reaching the thing
 * it was written to protect" (see test-frontend-null-safety.js's history —
 * a lexer desync made it silently see 78 of 90 declarations while reporting
 * every assertion green). The equivalent failure here would be: the array
 * regex stops matching (e.g. the const is renamed, or reformatted in a way
 * the parser doesn't expect) and the suite quietly runs zero comparisons and
 * exits 0 — a green suite that has stopped checking anything. To prevent
 * that:
 *   - If an expected array cannot be found in run-tests.js, this suite FAILS
 *     LOUDLY naming which array and why — it never falls through to "0
 *     entries, nothing to compare".
 *   - If CONTRIBUTING.md contains ZERO occurrences of the "N suites total —
 *     ..." pattern, this suite FAILS LOUDLY rather than reporting an empty
 *     "0 checked, 0 wrong" success. A doc that stopped stating the count at
 *     all is exactly the drift this suite exists to catch, not a pass.
 *
 * ── KNOWN GAP, stated rather than implied away ──────────────────────────
 * .github/workflows/test.yml sets paths-ignore: ['**.md', 'docs/**'], and
 * CONTRIBUTING.md matches '**.md'. So the one commit shape that makes the
 * doc wrong IN ISOLATION — editing or reflowing the count line and nothing
 * else — does not trigger the workflow on a push. It IS caught on any pull
 * request (not path-filtered) and on the likelier shape (adding a suite is
 * a .js change, which does trigger). Recorded here rather than fixed,
 * because widening the CI trigger has broader consequences than this guard
 * warrants — but do not read the list above as complete coverage.
 *
 * ── Parsing approach (robust, not line-count-dependent) ─────────────────
 * The array parser does NOT assume a fixed number of entries or a specific
 * one-line-per-entry layout. It finds `const NAME = [` in run-tests.js, then
 * walks forward character-by-character tracking bracket depth (ignoring
 * brackets inside string/comment literals) until the depth returns to zero
 * — the same "don't trust a fixed shape, track the real structure" method
 * test-css-tokens.js uses for its comment/string masking. Only genuine
 * `'*.js'` / `"*.js"` string literals found inside that span are counted as
 * suite entries — a comment mentioning a filename does not inflate the count.
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
// Parser: extract one `const NAME = [ ... ];` array body, bracket-depth
// aware (skips brackets inside '...'/"..." strings and //, /* */ comments),
// then count the `.js` string-literal entries inside it.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns the source span of the array literal assigned to `const NAME =`
 * (the text between the opening `[` and its matching `]`, inclusive), or
 * null if the declaration cannot be found at all. Never returns an empty
 * span silently for a declaration that WAS found but whose bracket never
 * closes — that is a parse error and throws, since it means this parser's
 * model of the file is wrong and continuing would produce a false count.
 */
function extractArraySpan(source, constName) {
  // The WALKER below is comment-aware, but the FINDER was not: a line like
  //   // e.g. const OFFLINE = ['a.js', 'b.js'];
  // above the real declaration made this measure the comment instead. That
  // fails loud today (the count mismatches), but it blames CONTRIBUTING.md
  // for being stale when run-tests.js is what confused the parser — and a
  // decoy whose entry count happened to MATCH would pass silently, which is
  // the "check that stopped reaching what it protects" shape. Requiring
  // exactly one match removes both outcomes: ambiguity is now an error.
  const declRe = new RegExp(`const\\s+${constName}\\s*=\\s*\\[`, 'g');
  const all = [...source.matchAll(declRe)];
  if (all.length === 0) return null;
  if (all.length > 1) {
    throw new Error(
      `run-tests.js contains ${all.length} declarations matching "const ${constName} = [" ` +
      `(expected exactly 1). This parser cannot tell which is authoritative, so it refuses ` +
      `to guess rather than silently measure the wrong one.`
    );
  }
  const m = all[0];

  const openIdx = m.index + m[0].length - 1; // index of the opening '['
  let i = openIdx;
  let depth = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];

    if (c === '/' && source[i + 1] === '/') {
      // Line comment — skip to end of line.
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      // Block comment — skip to closing */.
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      // String literal — skip to the matching unescaped closing quote.
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) { j += 1; break; }
        j += 1;
      }
      i = j;
      continue;
    }
    if (c === '[') { depth++; i++; continue; }
    if (c === ']') {
      depth--;
      i++;
      if (depth === 0) {
        return source.slice(openIdx, i); // inclusive of both brackets
      }
      continue;
    }
    i++;
  }

  // Reached EOF with depth still open — the declaration exists but this
  // parser's bracket-tracking never found a close. Fail loudly rather than
  // silently returning whatever partial span we scanned.
  throw new Error(
    `found "const ${constName} = [" but never found its matching closing "]" — ` +
    `the bracket-depth scan is either wrong or the file's structure changed ` +
    `in a way this parser doesn't understand. Refusing to guess.`
  );
}

/** Count `.js` string-literal entries (single- or double-quoted) inside an
 *  array span. Only counts genuine string tokens — a `.js` substring inside
 *  a `//` or `/* *\/` comment inside the span is excluded by the same
 *  comment-vs-string state machine used above, reused here in scan form.
 */
function countJsEntries(span) {
  const entries = [];
  let i = 0;
  const n = span.length;
  while (i < n) {
    const c = span[i];
    if (c === '/' && span[i + 1] === '/') {
      const nl = span.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && span[i + 1] === '*') {
      const end = span.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let str = '';
      while (j < n) {
        if (span[j] === '\\') { str += span[j] + (span[j + 1] ?? ''); j += 2; continue; }
        if (span[j] === quote) { j += 1; break; }
        str += span[j];
        j += 1;
      }
      if (/\.js$/.test(str)) entries.push(str);
      i = j;
      continue;
    }
    i++;
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Parse the three manifest arrays out of scripts/run-tests.js
// ─────────────────────────────────────────────────────────────────────────
section('1. Parse OFFLINE / LIVE_CI / LIVE_LOCAL out of scripts/run-tests.js');

const runTestsPath = path.join(ROOT, 'scripts/run-tests.js');
const runTestsSrc = readFileSync(runTestsPath, 'utf8');

const ARRAY_NAMES = ['OFFLINE', 'LIVE_CI', 'LIVE_LOCAL'];
const counts = {};
const entries = {};

for (const name of ARRAY_NAMES) {
  const span = extractArraySpan(runTestsSrc, name);
  // A missing array must FAIL LOUDLY, not be treated as "0 entries" and
  // silently folded into the totals below (that would be exactly the
  // "check that stops reaching the thing it was written to protect" shape).
  ok(span !== null, `found "const ${name} = [ ... ]" in scripts/run-tests.js`);
  if (span === null) {
    entries[name] = null;
    counts[name] = null;
    continue;
  }
  const list = countJsEntries(span);
  ok(list.length > 0, `"${name}" array contains at least one '*.js' entry (found ${list.length})`);
  entries[name] = list;
  counts[name] = list.length;
}

// If any array genuinely could not be found, there is nothing safe to
// compare against the doc — stop here with a hard failure rather than
// silently comparing against `null`/`NaN` or skipping the doc check.
const anyArrayMissing = ARRAY_NAMES.some(name => counts[name] === null);
if (anyArrayMissing) {
  console.log(
    `\n  ✗ FATAL: could not locate one or more manifest arrays in ` +
    `scripts/run-tests.js (${ARRAY_NAMES.filter(n => counts[n] === null).join(', ')}). ` +
    `Cannot verify CONTRIBUTING.md's suite count against nothing — refusing ` +
    `to report a false pass.`
  );
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed + 1}`);
  console.log('❌ FAILURES');
  process.exit(1);
}

const total = counts.OFFLINE + counts.LIVE_CI + counts.LIVE_LOCAL;
console.log(`  → measured: OFFLINE=${counts.OFFLINE}  LIVE_CI=${counts.LIVE_CI}  LIVE_LOCAL=${counts.LIVE_LOCAL}  TOTAL=${total}`);

// ─────────────────────────────────────────────────────────────────────────
// 2. Find every "N suites total — N OFFLINE + N LIVE_CI + N LIVE_LOCAL"
//    occurrence in CONTRIBUTING.md and check it against the measured counts.
// ─────────────────────────────────────────────────────────────────────────
section('2. Cross-check CONTRIBUTING.md prose against the measured counts');

const contributingPath = path.join(ROOT, 'CONTRIBUTING.md');
const contributingSrc = readFileSync(contributingPath, 'utf8');
const docLineStarts = (() => {
  const starts = [0];
  for (let i = 0; i < contributingSrc.length; i++) {
    if (contributingSrc[i] === '\n') starts.push(i + 1);
  }
  return starts;
})();
function lineNumberFor(index) {
  let lo = 0, hi = docLineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (docLineStarts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// Dash class covers a plain hyphen and the em/en dashes Markdown prose in
// this repo actually uses (CONTRIBUTING.md uses U+2014 em dash here) — a
// future re-wording swapping dash style must not silently defeat the match.
const DASH = '[-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015]';
const countRe = new RegExp(
  '(\\d+)\\s+suites\\s+total\\s*' + DASH + '\\s*' +
  '(\\d+)\\s+OFFLINE\\s*\\+\\s*(\\d+)\\s+LIVE_CI\\s*\\+\\s*(\\d+)\\s+LIVE_LOCAL',
  'gi'
);

const matches = [...contributingSrc.matchAll(countRe)];

// The core "don't silently pass with zero comparisons" guard: if the doc no
// longer contains the pattern at all, that is a FAILURE (the doc's count
// claim went missing or was reworded in a way this checker can't verify),
// never a quiet 0-checked success.
ok(matches.length > 0,
  matches.length > 0
    ? `found ${matches.length} "N suites total — N OFFLINE + N LIVE_CI + N LIVE_LOCAL" occurrence(s) in CONTRIBUTING.md to verify`
    : `found ZERO "N suites total — ..." occurrences in CONTRIBUTING.md — cannot verify anything. ` +
      `Either the doc's wording changed (update this checker's pattern to match) or the count claim ` +
      `was silently removed (restore it). A check that finds nothing to compare must fail, not pass.`
);

if (matches.length === 0) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  console.log('❌ FAILURES');
  process.exit(1);
}

for (const m of matches) {
  const line = lineNumberFor(m.index);
  const [, docTotal, docOffline, docLiveCi, docLiveLocal] = m.map(Number);
  const label = `CONTRIBUTING.md:${line} ("${docTotal} suites total — ${docOffline} OFFLINE + ${docLiveCi} LIVE_CI + ${docLiveLocal} LIVE_LOCAL")`;

  ok(docOffline === counts.OFFLINE,
    docOffline === counts.OFFLINE
      ? `${label} — OFFLINE count (${docOffline}) matches run-tests.js (${counts.OFFLINE})`
      : `${label} — STALE: OFFLINE count says ${docOffline}, but scripts/run-tests.js's OFFLINE array has ${counts.OFFLINE} entries`
  );
  ok(docLiveCi === counts.LIVE_CI,
    docLiveCi === counts.LIVE_CI
      ? `${label} — LIVE_CI count (${docLiveCi}) matches run-tests.js (${counts.LIVE_CI})`
      : `${label} — STALE: LIVE_CI count says ${docLiveCi}, but scripts/run-tests.js's LIVE_CI array has ${counts.LIVE_CI} entries`
  );
  ok(docLiveLocal === counts.LIVE_LOCAL,
    docLiveLocal === counts.LIVE_LOCAL
      ? `${label} — LIVE_LOCAL count (${docLiveLocal}) matches run-tests.js (${counts.LIVE_LOCAL})`
      : `${label} — STALE: LIVE_LOCAL count says ${docLiveLocal}, but scripts/run-tests.js's LIVE_LOCAL array has ${counts.LIVE_LOCAL} entries`
  );
  ok(docTotal === total,
    docTotal === total
      ? `${label} — total (${docTotal}) matches OFFLINE+LIVE_CI+LIVE_LOCAL (${total})`
      : `${label} — STALE: total says ${docTotal}, but OFFLINE+LIVE_CI+LIVE_LOCAL = ${total}`
  );
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ CONTRIBUTING.md suite count matches scripts/run-tests.js');
