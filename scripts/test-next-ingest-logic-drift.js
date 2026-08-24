/**
 * test-next-ingest-logic-drift.js — OFFLINE drift tripwire between the
 * shipping app's batch-ingest pure helpers and their /next port.
 *
 * ============================================================================
 * THIS TEST IS DELIBERATELY TEMPORARY. DELETE IT AT CUTOVER.
 * ============================================================================
 * The app has two frontends during the redesign: src/public/app.js (the
 * SHIPPING app) and src/public/next/** (a parallel rewrite served at /next).
 * At cutover, /next becomes / and app.js is deleted outright.
 *
 * src/public/next/shared/ingest-queue-logic.js is a byte-identical COPY of
 * 13 pure helper functions (plus the BIDI_CONTROL_RE constant) that also
 * live in src/public/app.js. The maintainer uses the shipping app in
 * production and has already found and fixed three real batch-queue defects
 * that way. If a future bug is found and fixed in app.js only, the /next
 * copy silently keeps the bug and re-ships it to every user at cutover —
 * and nobody would notice, because both copies would have green tests
 * covering their OWN version. This suite exists solely to make that
 * scenario impossible: it fails loudly the moment the two copies diverge.
 *
 * When src/public/app.js no longer exists (post-cutover), DELETE this file
 * and its scripts/run-tests.js OFFLINE entry. Do NOT "fix" it by pointing
 * it at some other file or by turning it into a coverage test for the
 * survivor — its only reason to exist is comparing two copies that are
 * supposed to be temporarily-duplicated, and once there is only one copy
 * left, the comparison is meaningless.
 *
 * DESIGN — deliberately dumb, on purpose (CLAUDE.md's own recorded lesson):
 *   "an independent, deliberately-dumb second measurement" is the effective
 *   countermeasure against a clever check that is silently blind (see the
 *   v3.1.0 test-frontend-null-safety.js history in CLAUDE.md — a lexer that
 *   desynced on a nested template literal saw 78 of 90 declarations while
 *   reporting every assertion green). So this suite does NOT evaluate the
 *   functions, does NOT run them against sample inputs, does NOT try to be
 *   clever about semantic equivalence. It extracts each function's SOURCE
 *   TEXT from both files with a plain regex and string-compares it. A
 *   behavioural test can pass while the sources diverge in a way that
 *   matters for an input nobody happened to sample; a source comparison
 *   cannot miss ANY textual difference, however small.
 *
 * Extraction follows the exact convention already established in
 * scripts/test-ingest-queue-frontend.js (function ... { ... \n} with the
 * closing brace at column 0) and scripts/test-chat-compile-card.js. Not
 * imported from that file (this suite must stand alone and must not be
 * broken by edits to the file it explicitly must not touch) but the same
 * regex shape, deliberately.
 *
 * WHITESPACE / COMMENTS: this suite requires BYTE-IDENTICAL function bodies,
 * not merely semantically-equivalent ones. See the docblock note at the
 * bottom of this file for the reasoning — TL;DR: the two files are
 * byte-identical today (verified at write time), the strictest check is
 * free to have right now and only gets more expensive to add later, and
 * ingest-queue-logic.js's own header comment already asserts "byte-identical
 * copy" as its self-declared contract — this test just enforces the
 * contract the file already claims for itself.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_PATH = path.join(ROOT, 'src/public/app.js');
const NEXT_PATH = path.join(ROOT, 'src/public/next/shared/ingest-queue-logic.js');

const appSrc = readFileSync(APP_PATH, 'utf8');
const nextSrc = readFileSync(NEXT_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction (same convention as test-ingest-queue-frontend.js /
//    test-chat-compile-card.js: a top-level `function NAME(...) { ... \n}`
//    with the closing brace at column 0 — deliberately duplicated here
//    rather than imported, so this suite has no dependency on a file it is
//    forbidden to touch) ─────────────────────────────────────────────────
//
// AUDIT-FOUND BUG (fixed below): the original extractor found the function
// body with `[\s\S]*?\n\}` — non-greedy, so it stops at the FIRST line
// consisting of just `}` at column 0. A template literal containing plain
// CSS/HTML text (e.g. `` `.foo {\n  color: red;\n}\n` ``) has EXACTLY that
// shape in its literal text, with nothing to do with the function's real
// closing brace. The auditor demonstrated this concretely: give the app.js
// and ingest-queue-logic.js copies of a function an IDENTICAL head, then a
// template literal with a column-0 `}`, then genuinely DIFFERENT tails —
// the old extractor truncated both copies at the same early point, so the
// (identical) truncated PREFIXES compared equal and the suite reported
// "Passed: 47 Failed: 0" for two functions with different runtime
// behaviour. Latent today (no current shared helper has this shape) but
// not hypothetical — see this file's own module docblock and
// ingest-queue-logic.js's header comment, both of which anticipate more
// helpers migrating in from HTML/CSS template-literal-builder code.
//
// FIX — scanBalanced() below finds the function's REAL closing brace by
// counting `{`/`}` while tracking lexical context (single/double-quoted
// strings, `//` and /* */ comments, template literals — including nested
// `${...}` interpolations, whose braces DO count structurally, unlike a
// template literal's plain text, which does not — AND regex literals).
//
// AUDIT ROUND 2 FOUND A NARROWER BUT REAL GAP IN THE FIX ABOVE: the
// column-0 plausibility check catches a fake-string span that happens to
// close somewhere mid-line, but a regex literal containing an apostrophe
// (`/can't/`) opens a FAKE single-quoted string whose eventual close can
// coincidentally land exactly at column 0 — the plausibility check then
// ACCEPTS the wrong span as if it were legitimate. The docblock that used
// to sit here presented "closing brace at column 0" as sufficient
// protection against the acknowledged regex gap; it is not, for this one
// parity arrangement, and this is the overclaiming-docblock trap this
// project has been bitten by before (an overclaiming docblock is worse
// than an honest gap, because it stops the next reviewer looking).
//
// FIX: scanBalanced() now recognises regex literals directly, via a
// heuristic regex-vs-division disambiguation (the SAME kind of
// preceding-token heuristic every non-parser JS tokenizer uses — see e.g.
// Acorn's simplified `finishOp`/`readRegexp` gating). This is a
// heuristic, not a parser, and it is used ONLY to decide "does this `/`
// open an atomic regex literal I should skip over without looking at its
// interior", never to attempt full JS semantics:
//   - `/` immediately after `(` `{` `,` `;` `:` `=` `!` `&` `|` `?` `+` `-`
//     `*` `%` `^` `~` `<` `>` or start-of-source → regex context.
//   - `/` immediately after an identifier/number → division context,
//     UNLESS that identifier is one of the small set of keywords that can
//     legitimately precede a regex operand (`return`, `typeof`,
//     `instanceof`, `in`, `of`, `new`, `delete`, `void`, `throw`, `yield`,
//     `case`, `do`, `else`, `extends`, `default`, `await`).
//   - `/` immediately after `)` → division UNLESS that `)` closes a
//     control-flow condition (`if(...)`, `while(...)`, `for(...)`,
//     `switch(...)`, `with(...)`, `catch(...)`) — tracked with a small
//     paren stack recording, for each `(`, whether the token immediately
//     before it was one of those keywords.
//   - `/` immediately after `]` → division (computed member access).
//   - `/` immediately after postfix `++`/`--` → division (ECMAScript
//     treats `++`/`--` like an identifier for this purpose).
// Once judged a regex, the literal is consumed ATOMICALLY (respecting `\`
// escapes and `[...]` character classes, where an unescaped `/` does not
// terminate) up to its closing `/` + trailing flag letters — so quote and
// backtick characters inside it NEVER reach the string/template state
// machine, and brace characters inside it (e.g. a `{3}` quantifier) are
// never fed to the depth counter. If no valid terminator is found before
// a literal newline or EOF (which real JS regex literals cannot contain),
// the WHOLE extraction is refused as AMBIGUOUS rather than guessed — this
// can produce a false "ambiguous" on some contrived division shapes (e.g.
// `a++\n/ b`, division split across a line with nothing else on the first
// line), which is an accepted, documented trade-off: refusing is always
// safe, guessing is not.
//
// WHAT IS **NOT** CLAIMED: this is a heuristic, not a real JS parser, and
// full regex-vs-division disambiguation is undecidable without one (that
// attempt is exactly what desynced test-frontend-null-safety.js's earlier
// "dead regex-vs-division heuristic" — see CLAUDE.md's v3.1.0 history —
// which is why this repo has no parser dependency by design). One
// specific residual gap, explicitly recorded rather than silently
// present: a regex literal appearing directly after a bare `)` that
// closes something OTHER than a tracked control-flow keyword (e.g. a
// function call or grouping expression) with no operator in between —
// `foo() /re/.test(x)` — is treated as division, so a quote inside such a
// regex could still corrupt the string state machine for that narrow,
// ASI-hostile, essentially unheard-of style. None of the 13 real shared
// helpers this suite compares are written that way. Separately, the
// column-0 plausibility check in extractFnBalanced() below is STILL kept
// as defense-in-depth for any closing-brace shape neither this file's own
// convention nor the regex handling anticipates — but it is no longer
// presented as sufficient on its own; the regex-atomic-consumption above
// is what actually closes the reported gap, not the column-0 check.
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'with', 'catch']);
const REGEX_CONTEXT_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'yield', 'case', 'do', 'else', 'extends', 'default', 'await',
]);

// The identifier/keyword token ending immediately BEFORE `idx` (exclusive) —
// used both to classify a paren's preceding keyword and to classify the
// token immediately before a candidate regex-opening `/`.
function precedingWord(src, idx) {
  let k = idx - 1;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
  return src.slice(k + 1, idx);
}

// Atomically consumes a regex literal starting at src[openIdx] === '/'.
// Handles `\`-escapes and `[...]` character classes (where an unescaped
// `/` does not terminate the literal), then consumes trailing flag
// letters. Returns { ok:false } if no valid terminator is found before a
// literal newline or EOF — a real JS regex literal cannot span a raw
// newline, so hitting one here means the initial regex/division guess was
// wrong and the caller must refuse rather than guess further.
function consumeRegexLiteral(src, openIdx) {
  let i = openIdx + 1;
  const n = src.length;
  let inClass = false;
  while (i < n) {
    const c = src[i];
    if (c === '\n') return { ok: false };
    if (c === '\\') { i += 2; continue; }
    if (inClass) { if (c === ']') inClass = false; i++; continue; }
    if (c === '[') { inClass = true; i++; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && /[A-Za-z]/.test(src[j])) j++; // trailing flags (g, i, m, ...)
      return { ok: true, endIdx: j };
    }
    i++;
  }
  return { ok: false };
}

function scanBalanced(src, openIdx) {
  let i = openIdx;
  const n = src.length;
  let depth = 0;
  let mode = 'code'; // 'code' | 'template'
  let inSingle = false, inDouble = false, inLineComment = false, inBlockComment = false;
  const templateReturnDepths = []; // depth values at which a closing `}` (from `${`) returns to 'template' mode
  const parenStack = []; // per open '(' in code mode: was it preceded by a control-flow keyword?
  let lastCloseWasControlParen = false; // set by the ')' that most recently closed a control-paren

  for (; i < n; i++) {
    const c = src[i];

    if (mode === 'template') {
      if (c === '\\') { i++; continue; } // escaped char in template text
      if (c === '`') { mode = 'code'; continue; } // closing backtick — always returns to 'code'
      if (c === '$' && src[i + 1] === '{') {
        depth++;
        templateReturnDepths.push(depth);
        mode = 'code';
        i++; // consume the '{' of '${' (already counted)
        continue;
      }
      continue; // plain template text — braces here are NOT structural
    }

    // mode === 'code'
    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && src[i + 1] === '/') { inBlockComment = false; i++; } continue; }
    if (inSingle) { if (c === '\\') { i++; continue; } if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === '\\') { i++; continue; } if (c === '"') inDouble = false; continue; }

    if (c === '/' && src[i + 1] === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && src[i + 1] === '*') { inBlockComment = true; i++; continue; }

    if (c === '/') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      const prevChar = k >= 0 ? src[k] : null;
      let isRegexContext;
      if (prevChar === null) {
        isRegexContext = true; // start of source
      } else if (/[A-Za-z0-9_$]/.test(prevChar)) {
        isRegexContext = REGEX_CONTEXT_KEYWORDS.has(precedingWord(src, k + 1));
      } else if (prevChar === ')') {
        isRegexContext = lastCloseWasControlParen;
      } else if (prevChar === ']') {
        isRegexContext = false; // computed member access
      } else if ((prevChar === '+' && src[k - 1] === '+') || (prevChar === '-' && src[k - 1] === '-')) {
        isRegexContext = false; // postfix ++/-- behaves like an identifier here
      } else {
        isRegexContext = true; // punctuation: ( { , ; : = ! & | ? + - * % ^ ~ < >
      }

      if (isRegexContext) {
        const rr = consumeRegexLiteral(src, i);
        if (rr.ok) { i = rr.endIdx - 1; continue; } // loop's i++ lands exactly at endIdx
        return { closeIdx: -1, ok: false, reason: 'a possible regex literal spans a line break or is unterminated before EOF — refusing rather than risk mis-lexing a fake string open' };
      }
      continue; // ordinary division operator — no special handling needed
    }

    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === '`') { mode = 'template'; continue; }

    if (c === '(') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      parenStack.push(CONTROL_KEYWORDS.has(precedingWord(src, k + 1)));
      continue;
    }
    if (c === ')') {
      lastCloseWasControlParen = parenStack.length ? parenStack.pop() : false;
      continue;
    }

    if (c === '{') { depth++; continue; }
    if (c === '}') {
      depth--;
      const top = templateReturnDepths[templateReturnDepths.length - 1];
      if (top !== undefined && depth === top - 1) {
        templateReturnDepths.pop();
        mode = 'template';
        continue;
      }
      if (depth === 0) return { closeIdx: i, ok: true };
      continue;
    }
  }
  return { closeIdx: -1, ok: false, reason: 'unterminated (brace never balanced back to 0 before EOF)' };
}

function extractFnBalanced(src, name) {
  const headRe = new RegExp(`function ${name}\\([^)]*\\) \\{`);
  const m = headRe.exec(src);
  if (!m) return { text: null, status: 'not-found' };
  const openIdx = m.index + m[0].length - 1; // index of the head's trailing '{'
  const scan = scanBalanced(src, openIdx);
  if (!scan.ok) return { text: null, status: 'ambiguous', reason: scan.reason || 'unterminated (brace never balanced back to 0 before EOF)' };
  const closeIdx = scan.closeIdx;
  const precededByNewline = closeIdx > 0 && src[closeIdx - 1] === '\n';
  if (!precededByNewline) {
    return { text: null, status: 'ambiguous', reason: `balanced close at index ${closeIdx} is not at column 0 (this codebase's own convention for a top-level function) — refusing rather than risk comparing a wrong span` };
  }
  return { text: src.slice(m.index, closeIdx + 1), status: 'ok' };
}

// Back-compat shim so nothing else in this file has to know about the
// {text,status} shape — returns the extracted text, or null for EITHER
// "not found" or "ambiguous". Section 1 below distinguishes the two for
// its own reporting; everything downstream just needs text-or-null.
function extractFn(src, name) {
  return extractFnBalanced(src, name).text;
}

function extractConst(src, name) {
  const re = new RegExp(`const ${name} = [^;]*;`);
  const m = src.match(re);
  return m ? m[0] : null;
}

// The complete, intentional list of what is supposed to be shared. This is
// the ONE place a future contributor adding a NEW shared helper (a 14th,
// or beyond) must remember to update — section 3 below independently
// proves they did.
const SHARED_FN_NAMES = [
  'queueBusyTransition',
  'formatQueueBytes',
  'formatUsdRange',
  'formatTokenRange',
  'pausedReasonCopy',
  'statusPillMeta',
  'resolveEstimateFileList',
  'dedupeQueueFiles',
  'extractConflictJobId',
  'formatHealthCounts',
  'sanitizeDisplayName',
  // Added later, from app.js's SEPARATE ~970-1085 range (its "HTML
  // builders" section) — the shared/reimplement boundary had been drawn
  // by LINE RANGE rather than by NATURE, and these two pure-logic
  // functions fell on the wrong side of it. See ingest-queue-logic.js's
  // own header comment.
  'computeQueueStatusCounts',
  'computeQueueSpentLabel',
];
const SHARED_CONST_NAMES = ['BIDI_CONTROL_RE'];

function firstDiffLine(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const n = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < n; i++) {
    if (aLines[i] !== bLines[i]) {
      return { lineNo: i + 1, appLine: aLines[i] ?? '(missing)', nextLine: bLines[i] ?? '(missing)' };
    }
  }
  return null;
}

function reportDrift(label, appText, nextText) {
  failed++;
  console.log(`  ✗ ${label} is BYTE-IDENTICAL between app.js and ingest-queue-logic.js`);
  console.log(`      DRIFT DETECTED — src/public/app.js and`);
  console.log(`      src/public/next/shared/ingest-queue-logic.js disagree on '${label}'.`);
  console.log(`      This almost always means someone fixed (or introduced) a bug in ONE`);
  console.log(`      frontend and not the other. app.js is the shipping app used in`);
  console.log(`      production — it is the more likely place a real fix landed; treat`);
  console.log(`      ingest-queue-logic.js as the stale copy unless you can show otherwise.`);
  const diff = firstDiffLine(appText, nextText);
  if (diff) {
    console.log(`      First differing line (#${diff.lineNo} within the extracted function):`);
    console.log(`        app.js:                  ${diff.appLine}`);
    console.log(`        next/ingest-queue-logic:  ${diff.nextLine}`);
  } else {
    console.log(`      (lengths differ but no line-level diff found — inspect both sources directly)`);
  }
}

// ── 0. Extractor self-tests (synthetic sources, known right/wrong answers)
// ─────────────────────────────────────────────────────────────────────────
// Proves scanBalanced/extractFnBalanced against known-shape inputs BEFORE
// trusting them on the real files below — without this, a regex typo in
// the extractor itself could silently rot into "always finds nothing" (or
// "always finds the wrong span") while every downstream assertion still
// reports green (this is the same discipline test-css-tokens.js's own
// section 0 already applies to ITS parser).
section('0. Extractor self-tests (synthetic sources)');

{
  // Baseline: a plain top-level function, no strings/templates/comments.
  const src = `function plain(a, b) {\n  return a + b;\n}\n`;
  const r = extractFnBalanced(src, 'plain');
  ok(r.status === 'ok' && r.text === `function plain(a, b) {\n  return a + b;\n}`,
    'baseline: a plain function is extracted in full, exactly as written');
}

{
  // THE AUDITOR'S EXACT BYPASS: a template literal whose plain text
  // contains a column-0 `}` (e.g. embedded CSS), followed by tails that
  // genuinely differ between the two "copies". The OLD extractor truncated
  // both at the embedded `}` and reported them equal (the reproduced bug —
  // see old_drift_repro.mjs in the audit trail). This must no longer happen.
  const appSrc = [
    'function buildWidget(x) {',
    '  const css = `',
    '.foo {',
    '  color: red;',
    '}',
    '`;',
    "  return css + 'APP-TAIL-BEHAVIOUR-A';",
    '}',
    '',
  ].join('\n');
  const nextSrc = [
    'function buildWidget(x) {',
    '  const css = `',
    '.foo {',
    '  color: red;',
    '}',
    '`;',
    "  return css + 'NEXT-TAIL-BEHAVIOUR-B-DIFFERENT';",
    '}',
    '',
  ].join('\n');
  const appR = extractFnBalanced(appSrc, 'buildWidget');
  const nextR = extractFnBalanced(nextSrc, 'buildWidget');
  ok(appR.status === 'ok' && nextR.status === 'ok',
    'the auditor\'s bypass shape (template literal with an embedded column-0 "}") still extracts cleanly on both sides');
  ok(appR.text !== null && appR.text.includes('APP-TAIL-BEHAVIOUR-A'),
    'app-side extraction reaches PAST the embedded "}" and includes its real tail');
  ok(nextR.text !== null && nextR.text.includes('NEXT-TAIL-BEHAVIOUR-B-DIFFERENT'),
    'next-side extraction reaches PAST the embedded "}" and includes its real (different) tail');
  ok(appR.text !== nextR.text,
    'REGRESSION GUARD for the exact reported bug: the two genuinely-different functions are no longer reported as byte-identical (old extractor collapsed both to the same truncated prefix)');
}

{
  // Ambiguous-case detection: a source where the function's closing brace,
  // once correctly balanced, does NOT land at column 0 (violates this
  // codebase's own stated top-level-declaration convention). Must be
  // refused as ambiguous rather than silently returning a (technically
  // balanced, but convention-violating) span.
  const src = `function notColumnZero(a) {\n  return a; }\n// trailing comment\n`;
  const r = extractFnBalanced(src, 'notColumnZero');
  ok(r.status === 'ambiguous' && r.text === null,
    'a balanced close that is NOT at column 0 is refused as ambiguous (fail loudly), not silently returned');
}

{
  // Unterminated function (no closing brace at all before EOF) must be
  // refused, not return a runaway span to EOF.
  const src = `function neverCloses(a) {\n  return a;\n`;
  const r = extractFnBalanced(src, 'neverCloses');
  ok(r.status === 'ambiguous' && r.text === null,
    'an unterminated function (no balancing "}" before EOF) is refused as ambiguous, not returned as a runaway span');
}

{
  // Not found at all — distinct from "ambiguous".
  const src = `function somethingElse(a) {\n  return a;\n}\n`;
  const r = extractFnBalanced(src, 'doesNotExist');
  ok(r.status === 'not-found' && r.text === null, 'a genuinely absent function name reports "not-found", not "ambiguous"');
}

{
  // Nested `${...}` interpolation containing a real structural object
  // literal — proves depth-tracking through template/code transitions is
  // correct, not just "ignore all braces in templates".
  const src = [
    'function withInterp(n) {',
    '  const label = `count: ${ { value: n, extra: { deep: 1 } } .value }`;',
    '  return label;',
    '}',
    '',
  ].join('\n');
  const r = extractFnBalanced(src, 'withInterp');
  ok(r.status === 'ok' && r.text.includes('return label;'),
    'a template literal with a nested `${ {object: {deep: 1}} }` interpolation is still extracted correctly (structural braces inside ${} are tracked; the surrounding template text is not)');
}

{
  // Comments and strings containing brace characters must not perturb depth.
  const src = [
    'function withNoise(a) {',
    '  // a stray } inside a line comment',
    '  /* another stray } inside a block comment */',
    "  const s = 'a string with a } inside it';",
    '  return a;',
    '}',
    '',
  ].join('\n');
  const r = extractFnBalanced(src, 'withNoise');
  ok(r.status === 'ok' && r.text.includes('return a;'),
    'brace characters inside // comments, /* */ comments, and string literals do not perturb the depth counter');
}

{
  // A regex literal with BALANCED brace characters (e.g. a {n} quantifier)
  // extracts correctly — this alone is NOT meaningful coverage (a balanced
  // pair nets to zero regardless of whether it's lexed correctly), but it's
  // kept as a smoke test alongside the genuinely load-bearing tests below.
  const src = [
    'function withBalancedRegexBraces(s) {',
    "  const re = /\\{3\\}/;",
    '  return re.test(s);',
    '}',
    '',
  ].join('\n');
  const r = extractFnBalanced(src, 'withBalancedRegexBraces');
  ok(r.status === 'ok' && r.text.includes('return re.test(s);'),
    'a regex literal with BALANCED brace characters (e.g. a {n} quantifier) does not confuse the scanner');
}

// ── AUDIT ROUND 2: the regex-literal-as-fake-string bypass, and its fix ───
// The auditor demonstrated concretely that a regex literal containing an
// apostrophe (`/can't/`) opens a FAKE single-quoted string; a later
// unrelated apostrophe (inside a `//` comment, which isn't scanned while
// `inSingle`) closes it, swallowing a real `{`; depth then reaches zero at
// an inner `}` that happens to sit at column 0 — so the OLD scanner's own
// plausibility check ACCEPTED the wrong, truncated span as legitimate. Two
// genuinely-different function bodies were then reported byte-identical.
// Each test below builds an app-side/next-side PAIR with an IDENTICAL head
// up to and including the trap, then genuinely DIFFERENT tails — if the
// scanner mis-lexes the trap, both copies truncate at the same point and
// report equal (the bug); if it lexes correctly, both extract in FULL and
// are correctly found unequal. These are load-bearing: reverting the
// regex-literal handling in scanBalanced() makes every one of them fail.
{
  const appSrc = [
    'function buildRow(s) {',
    "  const re = /can't/;        // opens a fake string",
    '  if (re.test(s)) {          // this { is swallowed',
    "    // won't matter          // this ' closes the fake string",
    '    doThing();',
    '}                            // <- would be accepted as the close, at column 0, if mis-lexed',
    "  return 'APP-BEHAVIOUR-A';  // <- outside the wrongly-truncated span",
    '}',
    '',
  ].join('\n');
  const nextSrc = appSrc.replace('APP-BEHAVIOUR-A', 'NEXT-BEHAVIOUR-B-TOTALLY-DIFFERENT');
  const appR = extractFnBalanced(appSrc, 'buildRow');
  const nextR = extractFnBalanced(nextSrc, 'buildRow');
  ok(appR.status === 'ok' && nextR.status === 'ok',
    "the auditor's exact repro (apostrophe inside a regex literal, /can't/) extracts cleanly on both sides");
  ok(appR.text !== null && appR.text.includes('APP-BEHAVIOUR-A'),
    'app-side extraction reaches the REAL tail past the regex-apostrophe trap');
  ok(nextR.text !== null && nextR.text.includes('NEXT-BEHAVIOUR-B-TOTALLY-DIFFERENT'),
    'next-side extraction reaches its REAL (different) tail past the same trap');
  ok(appR.text !== nextR.text,
    "REGRESSION GUARD for the audit-round-2 bypass: /can't/ no longer collapses two different functions to the same truncated prefix (the exact '*** GREEN (compared equal) ***' the auditor demonstrated)");
}

{
  // Same shape, backtick instead of apostrophe — a backtick inside a regex
  // literal must not be mistaken for the start of a template literal.
  const mk = (tail) => `function f(s) {\n  const re = /a\`b/;\n  return '${tail}';\n}\n`;
  const appR = extractFnBalanced(mk('APP-TAIL'), 'f');
  const nextR = extractFnBalanced(mk('NEXT-TAIL-DIFFERENT'), 'f');
  ok(appR.status === 'ok' && nextR.status === 'ok' && appR.text !== nextR.text,
    'a backtick inside a regex literal (/a`b/) does not open a fake template literal — two different tails are correctly found different');
}

{
  // Same shape, double-quote instead of apostrophe.
  const mk = (tail) => `function f(s) {\n  const re = /a"b/;\n  return '${tail}';\n}\n`;
  const appR = extractFnBalanced(mk('APP-TAIL'), 'f');
  const nextR = extractFnBalanced(mk('NEXT-TAIL-DIFFERENT'), 'f');
  ok(appR.status === 'ok' && nextR.status === 'ok' && appR.text !== nextR.text,
    'a double-quote inside a regex literal (/a"b/) does not open a fake double-quoted string — two different tails are correctly found different');
}

{
  // A regex literal containing a quote, nested inside a `${...}`
  // interpolation — proves the regex handling composes correctly with the
  // template/interpolation state machine, not just at top-level code.
  const mk = (tail) => `function f(s) {\n  const label = \`x \${ /a'b/.test(s) } y\`;\n  return '${tail}';\n}\n`;
  const appR = extractFnBalanced(mk('APP-TAIL'), 'f');
  const nextR = extractFnBalanced(mk('NEXT-TAIL-DIFFERENT'), 'f');
  ok(appR.status === 'ok' && nextR.status === 'ok' && appR.text !== nextR.text,
    "a regex literal with a quote INSIDE a \${...} interpolation (\${ /a'b/.test(s) }) is still lexed atomically — two different tails are correctly found different");
}

{
  // A regex literal directly after a control-flow paren's ')' (e.g.
  // `if (s) /a'b/...`) — proves the paren-stack regex-context tracking
  // works, not just the identifier/punctuation cases.
  const mk = (tail) => `function f(s) {\n  if (s) /a'b/.test(s);\n  return '${tail}';\n}\n`;
  const appR = extractFnBalanced(mk('APP-TAIL'), 'f');
  const nextR = extractFnBalanced(mk('NEXT-TAIL-DIFFERENT'), 'f');
  ok(appR.status === 'ok' && nextR.status === 'ok' && appR.text !== nextR.text,
    "a regex literal directly after an `if (...)` control-paren's ')' is still recognised as a regex, not division — two different tails are correctly found different");
}

{
  // Sanity checks the OTHER direction: ordinary division must NOT be
  // misread as a regex-literal opening (that would atomically swallow real
  // code up to the next unrelated '/', corrupting extraction the other
  // way). Division after an identifier, after a non-control-paren ')',
  // after an array index ']', and after postfix '++' must all behave as
  // plain division.
  const cases = [
    ['function f(a, b) {\n  const x = a / b;\n  return x;\n}\n', 'division after a plain identifier'],
    ['function f(a) {\n  const x = g(a) / 2;\n  return x;\n}\n', "division after a non-control call's ')'"],
    ['function f(a) {\n  const x = a[0] / 2;\n  return x;\n}\n', "division after an array index ']'"],
    ['function f(a, b) {\n  const x = a++ / b;\n  return x;\n}\n', 'division right after postfix ++'],
  ];
  for (const [src, label] of cases) {
    const r = extractFnBalanced(src, 'f');
    ok(r.status === 'ok' && r.text === src.slice(0, src.length - 1),
      `${label} is still lexed as plain division, not misread as a regex literal (extracts in full)`);
  }
}

{
  // A "regex" that spans a literal newline before finding a terminating
  // '/' is not valid JS — the scanner must refuse the WHOLE extraction as
  // ambiguous rather than guess (this is the accepted, documented
  // trade-off: refusing is always safe, silently guessing is not).
  const src = 'function f(s) {\n  const re = /abc\ndef/;\n  return s;\n}\n';
  const r = extractFnBalanced(src, 'f');
  ok(r.status === 'ambiguous' && r.text === null,
    'a candidate regex literal that spans a literal newline before terminating is refused as ambiguous, not silently mis-scanned');
}

// ── 1. Every shared function/const must be FOUND in BOTH files ─────────────
// A missing function is a FAILURE, not a skip — this repo has been bitten
// before by a scanner that silently saw 78 of 90 declarations while
// reporting every assertion green (test-frontend-null-safety.js history,
// see CLAUDE.md v3.1.0). We refuse to repeat that shape here: if extraction
// finds nothing, that is loud red, never a quiet pass.
section('1. Every shared function is present in BOTH app.js and the /next module');
const appFns = {};
const nextFns = {};
for (const name of SHARED_FN_NAMES) {
  const appResult = extractFnBalanced(appSrc, name);
  const nextResult = extractFnBalanced(nextSrc, name);
  appFns[name] = appResult.text;
  nextFns[name] = nextResult.text;
  ok(appResult.status === 'ok',
    appResult.status === 'ok'
      ? `'${name}' found in src/public/app.js`
      : `'${name}' NOT usably extracted from src/public/app.js (${appResult.status}${appResult.reason ? ': ' + appResult.reason : ''})`);
  ok(nextResult.status === 'ok',
    nextResult.status === 'ok'
      ? `'${name}' found in src/public/next/shared/ingest-queue-logic.js`
      : `'${name}' NOT usably extracted from src/public/next/shared/ingest-queue-logic.js (${nextResult.status}${nextResult.reason ? ': ' + nextResult.reason : ''})`);
}
const appConsts = {};
const nextConsts = {};
for (const name of SHARED_CONST_NAMES) {
  appConsts[name] = extractConst(appSrc, name);
  nextConsts[name] = extractConst(nextSrc, name);
  ok(appConsts[name] !== null, `const '${name}' found in src/public/app.js`);
  ok(nextConsts[name] !== null, `const '${name}' found in src/public/next/shared/ingest-queue-logic.js`);
}

// ── 2. Byte-identical comparison — the actual drift tripwire ───────────────
// Only compare pairs that were actually found in both files; a pair missing
// from either side already failed loudly in section 1 and comparing `null`
// text would just be noise on top of a clear signal.
section('2. Byte-identical source comparison (the actual drift tripwire)');
for (const name of SHARED_FN_NAMES) {
  if (appFns[name] === null || nextFns[name] === null) {
    failed++;
    console.log(`  ✗ '${name}' — SKIPPED comparison because it was missing from one file (see section 1)`);
    continue;
  }
  if (appFns[name] === nextFns[name]) {
    passed++;
    console.log(`  ✓ '${name}' is byte-identical between app.js and ingest-queue-logic.js`);
  } else {
    reportDrift(name, appFns[name], nextFns[name]);
  }
}
for (const name of SHARED_CONST_NAMES) {
  if (appConsts[name] === null || nextConsts[name] === null) {
    failed++;
    console.log(`  ✗ const '${name}' — SKIPPED comparison because it was missing from one file (see section 1)`);
    continue;
  }
  if (appConsts[name] === nextConsts[name]) {
    passed++;
    console.log(`  ✓ const '${name}' is byte-identical between app.js and ingest-queue-logic.js`);
  } else {
    reportDrift(`const ${name}`, appConsts[name], nextConsts[name]);
  }
}

// ── 3. The /next module's declared-function list matches this test's list
//    EXACTLY (set equality, not just a count) ──────────────────────────────
// Independent measurement, deliberately dumb: a plain top-level
// `function NAME(` scan (column-0 anchored, same style convention as every
// declaration in this module — see the file's own header comment). If a
// 14th helper is added to ingest-queue-logic.js and this test's
// SHARED_FN_NAMES list is not updated to match, that helper is invisible to
// section 2's comparison and would drift uncovered forever. A raw count
// alone is not enough (13 declared vs. 13 checked could still be two
// different sets of 13) — assert full set equality in both directions.
// PROVEN LIVE, not just asserted: raising the module from 11 to 13
// functions (computeQueueStatusCounts + computeQueueSpentLabel, moved over
// from views/ingest.js's own reimplementations) WITHOUT updating
// SHARED_FN_NAMES first produced a real, observed RED here — 39 passed / 2
// failed, both failures right here in section 3 ("found 13" vs the
// then-hardcoded 11, plus both new names listed as UNCOVERED) — before
// this file was edited to expect 13. This section is not a decoration.
section('3. The /next module declares EXACTLY the 13 functions this suite checks (set equality)');
const declaredInNext = [...nextSrc.matchAll(/^function ([A-Za-z0-9_$]+)\(/gm)].map(m => m[1]);
ok(declaredInNext.length === 13,
  `ingest-queue-logic.js declares exactly 13 top-level functions (found ${declaredInNext.length}: ${declaredInNext.join(', ')})`);

const declaredSet = new Set(declaredInNext);
const checkedSet = new Set(SHARED_FN_NAMES);
const declaredButNotChecked = [...declaredSet].filter(n => !checkedSet.has(n));
const checkedButNotDeclared = [...checkedSet].filter(n => !declaredSet.has(n));
ok(declaredButNotChecked.length === 0,
  declaredButNotChecked.length === 0
    ? 'every function declared in ingest-queue-logic.js is covered by this test’s SHARED_FN_NAMES list'
    : `UNCOVERED: declared in ingest-queue-logic.js but NOT checked by this test: ${declaredButNotChecked.join(', ')} — add ${declaredButNotChecked.length === 1 ? 'it' : 'them'} to SHARED_FN_NAMES above`);
ok(checkedButNotDeclared.length === 0,
  checkedButNotDeclared.length === 0
    ? 'every name in this test’s SHARED_FN_NAMES list is actually declared in ingest-queue-logic.js'
    : `STALE: this test checks for ${checkedButNotDeclared.join(', ')} but ingest-queue-logic.js no longer declares ${checkedButNotDeclared.length === 1 ? 'it' : 'them'} — SHARED_FN_NAMES is out of date`);

// ── 4. The module's own re-export list matches too (belt + suspenders —
//    a function could be declared but never exported, silently unusable by
//    views/ingest.js) ────────────────────────────────────────────────────
section('4. Every checked name (+ the shared const) is actually re-exported');
// Anchored to column 0 ('m' flag + ^) so this can't match the phrase
// "`export { ... }` statement" inside the file's own header comment (which
// is indented behind "// " and is not a real declaration) — verified this
// bites in practice: an unanchored version matched into the header comment
// and then closed on the first unrelated top-level-looking "};" it found
// inside pausedReasonCopy's table object, silently comparing garbage.
const exportBlockMatch = nextSrc.match(/^export \{([\s\S]*?)\n\};/m);
ok(exportBlockMatch !== null, 'ingest-queue-logic.js has a single `export { ... };` block');
if (exportBlockMatch) {
  const exported = exportBlockMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  const exportedSet = new Set(exported);
  const allExpected = [...SHARED_FN_NAMES, ...SHARED_CONST_NAMES];
  const notExported = allExpected.filter(n => !exportedSet.has(n));
  ok(notExported.length === 0,
    notExported.length === 0
      ? 'every checked function + BIDI_CONTROL_RE is present in the export block'
      : `NOT EXPORTED (declared but unreachable by importers): ${notExported.join(', ')}`);
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(70)}`);
console.log(`test-next-ingest-logic-drift.js: Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log(`\nDRIFT SUMMARY: this suite exists to catch exactly this — one of the`);
  console.log(`shared batch-ingest helpers has diverged (or gone missing) between`);
  console.log(`src/public/app.js (shipping) and src/public/next/shared/ingest-queue-logic.js`);
  console.log(`(the /next port). See the specific '✗' lines above for which one(s), and`);
  console.log(`the top of this file for what to do when src/public/app.js is eventually`);
  console.log(`deleted at cutover (delete this suite too).`);
  process.exit(1);
}
