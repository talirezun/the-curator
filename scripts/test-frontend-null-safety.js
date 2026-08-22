/**
 * test-frontend-null-safety.js — OFFLINE suite guarding Track 1.2's frontend
 * binding hardening in src/public/app.js.
 *
 * THE BUG CLASS THIS CATCHES
 * ───────────────────────────────────────────────────────────────────────
 * app.js is one ES module (~6,800 lines) with ~80 top-level
 * `const x = document.getElementById(...)` / `document.querySelector(...)`
 * declarations, several of them immediately followed by a top-level
 * `x.addEventListener(...)` call or an inline
 * `document.getElementById('y').addEventListener(...)` chain.
 *
 * `getElementById`/`querySelector` never throw — a missing element just
 * returns null. But DEREFERENCING that null (`.addEventListener`, `.value`,
 * `.classList`, …) throws a TypeError. If that dereference happens at
 * MODULE SCOPE (i.e. it isn't inside a function body, so it runs the
 * instant the browser evaluates app.js), the throw aborts evaluation of the
 * rest of the module. Every listener below that point never binds, every
 * tab past that point is dead, and the user sees a blank/broken app — the
 * auto-updater then ships that to everyone (see CLAUDE.md's boot-guard
 * entries; the guard in index.html is a recovery net, not a fix).
 *
 * A pre-v3.1.0 audit found this exact shape live at module scope in
 * several places, most namably two bare
 * `document.querySelector('[data-tab="…"]').addEventListener(…)` calls
 * (no element existing under that selector — e.g. a future markup typo —
 * would blank the whole app) plus a dozen `getElementById(...)` siblings of
 * the same shape, plus a handful of stored top-level consts
 * (dropZone/fileInput/ingestBtn/chatDomainEl/newChatBtn/chatInputEl/
 * chatSendBtn/wikiLoadBtn/newDomainBtn/ndDisplayName/templateGrid/
 * ndCreateBtn) dereferenced unguarded at module scope. All were fixed by
 * adding `?.` at the dereference point — the exact same idiom the file
 * already used consistently from line ~4130 onward
 * (`document.getElementById('x')?.addEventListener(...)`).
 *
 * THE SCANNER
 * ───────────────────────────────────────────────────────────────────────
 * A small, dependency-free (node: builtins only) scanner, in the spirit of
 * test-css-tokens.js:
 *   1. Strip block comments, line comments, and string/template literals
 *      (opaque skip — see stripStringsAndComments) so identifiers inside
 *      comments/strings can't produce false matches.
 *   2. Collect every "top-level-equivalent" `const|let|var NAME =
 *      document.(getElementById|querySelector)(...)` declaration.
 *      "Top-level-equivalent" means either (a) genuine column-0 module
 *      scope, or (b) one indent level inside a detected top-level IIFE
 *      body (see step 5) — both run synchronously the instant app.js
 *      evaluates, so both are equally dangerous.
 *      Column-0 as the primary signal works because this file's actual
 *      formatting is consistently 2-space-per-nesting-level — a real
 *      parser would be more general, but a hand-rolled one risks its OWN
 *      correctness bugs (regex-vs-division, nested templates); column-0
 *      is what an `eslint no-restricted-syntax`-style rule would call
 *      "Program.body" here, and it is what the human audit that drove
 *      this suite verified by hand. If app.js's formatting convention
 *      ever changes, this scanner's job is to be loud, not silently
 *      right — section 0 pins that behaviour with synthetic fixtures.
 *      EXCLUDED: declarations whose right-hand side is an arrow function
 *      (`const x = () => document.getElementById(...)`) — those are lazy
 *      getters, safe by construction (nothing is dereferenced until the
 *      function is later CALLED, which is never at module scope here).
 *   3. Flag any top-level-equivalent line that dereferences one of those
 *      NAMEs (`.` or `[` immediately after, optionally preceded by `?`)
 *      without the `?.` guard — excluding the declaration line itself,
 *      AND excluding a name that an earlier `if (!name) return;` /
 *      `if (!a || !b) return;` style early-exit guard in the SAME scope
 *      already narrowed to non-null (see step 6 — this is the real,
 *      live pattern at app.js's one IIFE, `wireHealthCheck`).
 *   4. Flag any top-level-equivalent inline chain
 *      `document.(getElementById|querySelector)(...).<member>` — a
 *      property read (`.parentElement`), an assignment
 *      (`.disabled = true`), or a call (`.addEventListener(...)`) are all
 *      caught identically, because all three dereference the same
 *      possibly-null result. `querySelectorAll` is excluded — it always
 *      returns a NodeList, never null, so chaining straight off it is
 *      safe by spec.
 *   5. Also treats the BODY of a top-level immediately-invoked function
 *      expression (IIFE) as top-level-equivalent, one indent level in.
 *      An IIFE is not a deferred callback — `(function () { ... })()`
 *      RUNS ITS BODY SYNCHRONOUSLY the moment the module evaluates that
 *      line, exactly like a bare statement, just wrapped in parens. app.js
 *      has exactly one of these today (`wireHealthCheck`, ~line 4274) and
 *      it is correctly guarded with an early-return — see step 6.
 *      `findIifeBodyLineRanges` requires BOTH a recognisable opener at
 *      column 0 (`(function ... {` / `(async function ... {` / `(() =>
 *      {` / `((args) => {`, with the `{` on the opener line) AND a
 *      recognisable closer at column 0 (`})(` — i.e. actually invoked, not
 *      just a paren-wrapped expression that's never called) with matching
 *      brace depth in between. Only lines at EXACTLY one indent level (2
 *      spaces) deeper than the opener are pulled in as top-level-
 *      equivalent; anything indented further — a nested callback, a
 *      nested block — stays correctly deferred, mirroring the same
 *      assumption already made for the whole file. Each IIFE body is
 *      scanned as its OWN independent scope (own declaredNames, own
 *      guards) so a name declared inside one IIFE can never be confused
 *      with an unrelated name of the same spelling at true module scope
 *      or in a different IIFE.
 *   6. `if (!name) return;` / `if (!a || !b || …) return;` at the front
 *      of a scope is recognised as a narrowing guard (`extractEarlyReturn
 *      Guards`) — exactly the pattern `wireHealthCheck` uses today
 *      (`if (!runBtn || !results) return;` before `runBtn.addEventListener
 *      (...)` with no `?.`). Every name it lists is exempted from the
 *      unguarded-deref check for the REST OF THAT SCOPE, but only on
 *      lines AFTER the guard — a dereference appearing BEFORE the guard
 *      (an unusual, likely-buggy order) is still flagged. Without this,
 *      turning on IIFE-body scanning would immediately false-positive on
 *      real, already-safe code — an early return is exactly as effective
 *      a guard as `?.`, just expressed as control flow instead of syntax.
 *   7. Flags unsafe destructuring — `const { x } = document.
 *      getElementById(...)` / `const { x } = document.querySelector(...)`
 *      — as its OWN category (`unsafeDestructuring`), separately from the
 *      deref check. This is dangerous unconditionally, at the declaration
 *      line itself, regardless of what comes after: destructuring `null`
 *      throws immediately (`TypeError: Cannot destructure property 'x' of
 *      'null' as it is null`), so there is no way to "guard" this shape
 *      with `?.` on some later line — the fix has to change the
 *      declaration itself (e.g. `?.` on the property access, or split
 *      into a null check first). `querySelectorAll` is excluded (never
 *      null, so array-destructuring off it can't throw for this reason).
 *
 * Section 0 is a battery of self-tests against small synthetic snippets
 * with known right/wrong answers, so this suite can't silently rot into a
 * no-op that always finds zero references (same discipline as
 * test-css-tokens.js). Section 1 asserts the real app.js is clean.
 *
 * ── Honest "does not detect" list ───────────────────────────────────────
 * An earlier draft of this suite's header described its own step 4 as
 * requiring a trailing `(` (implying only method CALLS were matched) when
 * the implementation already matched property reads and assignments too —
 * a real gap between documented and actual coverage, caught in review. To
 * avoid repeating that mistake, everything this scanner is KNOWN not to
 * catch is listed explicitly here, checked in section 0 by fixtures that
 * assert the (current, honest) non-detection rather than silently omitting
 * them:
 *   - A top-level `if {}` / `try {}` / `for {}` / `while {}` / `switch {}`
 *     BLOCK (as opposed to a function/IIFE body) wrapped around a plain
 *     dereference. These are control-flow blocks, not new scopes — code
 *     inside one is exactly as dangerous as a bare top-level statement —
 *     but they are indented exactly like a function body under this
 *     file's formatting convention, and (unlike the one real IIFE) NO
 *     such block exists anywhere in app.js today. Reusing the IIFE
 *     machinery here would mean keyword-aware parsing (distinguishing
 *     `if (` from `function` from a plain call) to avoid mis-scoping
 *     ordinary nested functions — real work for a shape with zero current
 *     occurrences. Left undetected rather than risk it.
 *   - A `document.getElementById(...)`/`querySelector(...)` chain used as
 *     a NESTED ARGUMENT rather than as the head of a top-level statement
 *     — e.g. `foo(document.getElementById('x').parentElement)` at column
 *     0. Step 4 only anchors at the START of a (semicolon-split) top-level
 *     statement segment; a chain buried inside a call's argument list is
 *     not separately re-scanned. Distinguishing a plain nested argument
 *     (equally dangerous — still runs synchronously) from one wrapped in
 *     a deferred callback (`foo(() => document.getElementById('x')...)`,
 *     safe) at arbitrary nesting depth is exactly the kind of
 *     tokenizer-correctness risk the file header already declines for
 *     the whole-file case. No such call shape exists in app.js today.
 *   - Nested IIFEs (an IIFE whose body itself contains another top-level-
 *     shaped IIFE one level deeper). `findIifeBodyLineRanges` handles one
 *     level; app.js has exactly one IIFE total today, so this has never
 *     been exercised.
 *
 * NOT covered here (by design — see the Track 1.2 scope note in the
 * originating task): dereferences INSIDE ordinary (non-IIFE) function
 * bodies that are only reachable via a now-guarded listener are provably
 * safe (the guard means the function is never called when its element is
 * missing) and are left alone; splitting app.js into modules and
 * extracting a tab-navigation registry are explicitly out of scope for
 * this suite and for the change it guards. The already-set
 * `window.__curatorBooted = true;` sentinel invariant is covered by
 * test-chat-model.js and is not duplicated here.
 *
 * ── What the `?.` hardening itself does NOT guarantee (audit L-7) ───────
 * The `?.` guards added at module scope stop a MISSING element from
 * throwing at LOAD TIME and blanking the whole app — that is the stated
 * goal, and it's what this whole suite verifies. They do NOT make every
 * CROSS-element reference inside an already-guarded handler's own body
 * null-safe. Two real examples, both still present in app.js today:
 * `chatSendBtn.click()` inside `chatInputEl?.addEventListener('keydown',
 * ...)` (~app.js:961) and `chatInputEl.focus()` inside
 * `newChatBtn?.addEventListener('click', ...)` (~app.js:955) — both bare,
 * both fire only once the OUTER element's listener has already bound (so
 * the load-time blank-page failure mode is closed), but if the INNER
 * named element (`chatSendBtn` / `chatInputEl`) were ever missing while
 * the outer one was present, that specific handler would still throw at
 * RUNTIME when triggered. This is a real, deliberately out-of-scope gap
 * — closing every cross-reference inside every handler body across the
 * file is the "restructure" work explicitly deferred by the Track 1.2
 * scope note above, not a two-line fix — recorded here so the hardening
 * isn't over-read as "no element reference in app.js can ever throw."
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
// The scanner
// ─────────────────────────────────────────────────────────────────────────

/**
 * Blanks out // line comments, /* block comments *\/, '...'/"..."/`...`
 * literal contents, and /regex/ literals — preserving length and newlines
 * so line numbers computed against the ORIGINAL text stay valid. This is an
 * opaque-skip strategy (like test-css-tokens.js's stripBlockComments): once
 * inside a string/comment/regex we just hunt for its terminator, never
 * interpreting content in between. Code inside a template literal's `${...}`
 * interpolation is the one exception — it is left UNBLANKED (real,
 * executable JS), via a small stack (see below), because it can itself
 * contain a nested template, string, or dangerous DOM reference.
 *
 * THIS EXACT PARSER FOUND A REAL BUG IN ITSELF (audit L4 follow-up): the
 * first, single-pass version treated every backtick as a plain open/close
 * toggle, with no awareness of `${...}`. app.js:897 has a genuinely NESTED
 * template —
 *   `<div class="chat-citations">${citations.map(c =>
 *     `<span class="citation-tag">${escHtml(c)}</span>`).join('')}</div>`
 * — where the OUTER template's `${...}` contains its own complete inner
 * template. The single-pass version mistook the inner template's opening
 * backtick for the OUTER template's closing backtick, then cascaded into
 * misreading everything after it — including, transitively, real top-level
 * code far later in the file (`app.js:4228`, `app.js:4274`'s IIFE opener)
 * as if it were still inside a string, silently making it invisible to
 * every check in this suite. A regex literal containing raw backtick
 * characters — `app.js:3518`, `.replace(/`([^`]+)`/g, ...)`, used to turn
 * `` `code` `` spans into `<code>` tags — is the SAME class of bug from a
 * different angle: an ODD number of literal backticks inside `/.../ ` desyncs
 * a parser that doesn't know `/.../ ` is a regex, not three separate strings.
 * Caught only because turning on IIFE-body scanning (this same L4 pass)
 * made the desync's effect externally visible for the first time — it had
 * been silently swallowing an unknown span of the file in EVERY prior run,
 * with no failing assertion to say so. Fixed with:
 *   (a) a small explicit STACK — a `{type:'code', braceDepth}` frame per
 *       open `${`, a `{type:'template'}` frame per open backtick — so a
 *       nested template inside `${...}` pushes its own frame instead of
 *       being mistaken for the outer template's close; the section-1 scan
 *       below asserts the stack always returns to depth 1 by EOF on the
 *       real file, which is the cheapest whole-file self-check available;
 *   (b) a standard, bounded regex-vs-division heuristic (used by real
 *       lightweight JS tokenizers, e.g. Babel's/Acorn's simpler cousins):
 *       a `/` starts a regex literal unless the last significant code
 *       character looks like the end of a VALUE (identifier/number
 *       character, `)`, `]`) and isn't immediately preceded by a keyword
 *       that takes an operand next (`return`, `typeof`, `case`, …). This is
 *       not a perfect JS lexer (a genuinely adversarial `a[b]/c/.test(d)`
 *       ambiguity could still fool it), but it's exactly what test-css-
 *       tokens.js already accepts for its own scope of "good enough, and
 *       loud rather than silently wrong if the assumption breaks" — see the
 *       stack-depth assertion in section 1, which is the tripwire for a
 *       *new* instance of this bug class showing up later in app.js.
 */
function stripStringsAndComments(text) {
  const REGEX_KEYWORD_TAIL_RE = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
  const stack = [{ type: 'code' }]; // the ONE root frame has no braceDepth — it never pops
  let out = '';
  let i = 0;
  const n = text.length;
  let lastSigChar = '';   // last non-whitespace char emitted in code mode (regex-vs-division heuristic)
  let lastCodeTail = '';  // trailing ~15 real code chars, for the keyword half of that heuristic

  function noteCodeChar(ch) {
    // BUG FIXED (audit H-B): whitespace used to be appended to lastCodeTail
    // unconditionally, so after e.g. "return " the tail was "...return " —
    // and REGEX_KEYWORD_TAIL_RE is `$`-anchored on the keyword itself, so a
    // trailing space made it NEVER match. That silently made `return /re/`,
    // `if (x) return /re/`, and every other keyword-then-regex shape lex as
    // DIVISION instead of a regex literal — reading the regex's own content
    // as code, which then reads its own `/` characters as more code, and so
    // on; confirmed end-to-end with a poisoned copy of app.js where a
    // dangerous unguarded element after `function f(s){return /["']/.test(s);}`
    // went completely invisible (0 findings, not even counted as a
    // declaration). Whitespace must never reach lastCodeTail at all — not
    // just be excluded from lastSigChar — so the tail always ends with the
    // last real token regardless of how much space/newline preceded the `/`.
    if (/\s/.test(ch)) return;
    lastSigChar = ch;
    lastCodeTail = (lastCodeTail + ch).slice(-15);
  }

  while (i < n) {
    const top = stack[stack.length - 1];
    const c = text[i];
    const c2 = text[i + 1];

    if (top.type === 'template') {
      if (c === '\\' && i + 1 < n) {
        out += (text[i] === '\n' ? '\n' : ' ') + (text[i + 1] === '\n' ? '\n' : ' ');
        i += 2;
        continue;
      }
      if (c === '`') { out += ' '; i++; stack.pop(); continue; } // this template's own close
      if (c === '$' && c2 === '{') {
        // Blank only the `$` — keep the real `{` visible in the output.
        // Its matching `}` (the interpolation's close, below) is ALSO kept
        // visible, so any downstream consumer doing its own naive `{`/`}`
        // counting over `out` (findIifeBodyLineRanges does exactly this)
        // sees a symmetric, correctly-balanced pair instead of an orphan
        // `}` with no visible opener — which is what blanking both
        // characters here used to produce, and which silently broke IIFE
        // body-range detection on the real file (every `${...}`
        // interpolation between an IIFE's opener and its true closer added
        // one more unmatched `}`, so naive counting never returned to 0).
        out += ' {';
        i += 2;
        stack.push({ type: 'code', braceDepth: 1 }); // the interpolation is real code — own frame, own brace count
        continue;
      }
      out += c === '\n' ? '\n' : ' '; // opaque template-text content
      i++;
      continue;
    }

    // top.type === 'code' (either the file root, or inside a `${...}`)
    if (c === '/' && c2 === '/') {
      out += '  '; i += 2;
      while (i < n && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '\'' || c === '"') {
      const quote = c;
      out += ' '; i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < n) {
          out += (text[i] === '\n' ? '\n' : ' ') + (text[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
          continue;
        }
        out += text[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += ' '; i++; }
      lastSigChar = quote; lastCodeTail = (lastCodeTail + 'STR').slice(-15);
      continue;
    }
    if (c === '`') { out += ' '; i++; stack.push({ type: 'template' }); continue; }
    if (c === '/') {
      const isDivision = !!lastSigChar && /[\w$)\]]/.test(lastSigChar) && !REGEX_KEYWORD_TAIL_RE.test(lastCodeTail);
      if (!isDivision) {
        // Regex literal: skip to the matching UNESCAPED `/`, respecting a
        // `[...]` character class (where `/` needs no escaping) and
        // backslash escapes, then skip trailing flags. This is what
        // catches app.js:3518's `/`([^`]+)`/g` without mistaking its
        // internal backticks for template-string delimiters.
        out += ' '; i++;
        let inClass = false;
        while (i < n && text[i] !== '\n') {
          if (text[i] === '\\' && i + 1 < n) { out += ' ' + (text[i + 1] === '\n' ? '\n' : ' '); i += 2; continue; }
          if (text[i] === '[') { inClass = true; out += ' '; i++; continue; }
          if (text[i] === ']') { inClass = false; out += ' '; i++; continue; }
          if (text[i] === '/' && !inClass) { out += ' '; i++; break; }
          out += ' '; i++;
        }
        while (i < n && /[a-z]/i.test(text[i])) { out += ' '; i++; } // flags (g, i, m, …)
        lastSigChar = '/'; lastCodeTail = (lastCodeTail + 'REGEX').slice(-15);
        continue;
      }
      // else: division — fall through and emit '/' as an ordinary code char
    }
    if (c === '{' && top.braceDepth !== undefined) { top.braceDepth++; out += c; i++; noteCodeChar(c); continue; }
    if (c === '}' && top.braceDepth !== undefined) {
      top.braceDepth--; out += c; i++;
      noteCodeChar(c);
      if (top.braceDepth === 0) stack.pop(); // this `${...}` interpolation's matching close — back to template text
      continue;
    }
    out += c; i++;
    noteCodeChar(c);
  }
  return { text: out, finalStackDepth: stack.length };
}

/**
 * Splits an already comment/string-stripped line into its top-level
 * statement segments — i.e. splits on `;` that is NOT nested inside `(`,
 * `[`, or `{`. This exists because module-scope registrations in app.js
 * are frequently one-liners whose CALLBACK also contains semicolons, e.g.
 *   dropZone?.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('x'); });
 * The `dropZone.classList.remove('x')` reference is inside the callback
 * (nested inside the addEventListener call's parens, itself inside the
 * arrow function's braces) — it only runs later, when the event fires, and
 * only if `dropZone` was non-null when the listener bound. It must not be
 * treated as a second, unguarded, module-scope dereference. Splitting on
 * depth-0 semicolons and then checking only the START of each resulting
 * segment (see below) correctly isolates the RECEIVER of each top-level
 * statement from anything nested inside it.
 */
function splitTopLevelStatements(line) {
  const segments = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth <= 0) {
      segments.push(line.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(line.slice(start));
  return segments;
}

/**
 * Finds top-level (column-0) immediately-invoked function expressions and
 * returns the 0-based [bodyStartIndex, bodyEndIndex] (inclusive) line-index
 * range of each one's BODY (the lines strictly between the opener and the
 * closer). See the file-header step 5 for the full rationale. Operates on
 * already comment/string-stripped lines so braces inside strings/comments
 * can't confuse the depth tracker.
 */
function findIifeBodyLineRanges(cleanedLines) {
  // Audit M-E: accepts an optional leading `;` (the defensive
  // ASI-hazard-avoidance style, `;(function () {`) before the wrapping
  // paren.
  const openRe = /^;?\(\s*(?:async\s+)?function\b[^{]*\{\s*$/;       // (function name() {  /  ;(function () {
  const arrowOpenRe = /^;?\(\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$/; // (() => {  /  ((x, y) => {
  // Audit M-E: accepts BOTH invocation-parens-outside-the-wrapper
  // (`})();`, the more common modern style) and the Crockford
  // invocation-parens-inside-the-wrapper style (`}());`) as a valid
  // closer — `})(` vs `}()`.
  const closerRe = /^\}(?:\)\(|\(\))/;
  const ranges = [];
  for (let i = 0; i < cleanedLines.length; i++) {
    const line = cleanedLines[i];
    if (!(openRe.test(line) || arrowOpenRe.test(line))) continue;
    let depth = 0;
    let sawOpenBrace = false;
    let closeLine = -1;
    for (let j = i; j < cleanedLines.length; j++) {
      for (const ch of cleanedLines[j]) {
        if (ch === '{') { depth++; sawOpenBrace = true; }
        else if (ch === '}') { depth--; }
      }
      if (sawOpenBrace && depth === 0) { closeLine = j; break; }
    }
    if (closeLine === -1 || closeLine <= i) continue; // unmatched or empty body — bail defensively
    if (!closerRe.test(cleanedLines[closeLine].trim())) continue; // closer doesn't actually invoke it
    ranges.push([i + 1, closeLine - 1]);
  }
  return ranges;
}

/**
 * Given a set of {index, text} entries for ONE scope (already dedented so
 * `text` reads as if it were column-0), finds `if (<cond>) return;`
 * early-exit guards whose condition is a `||`-joined list of clauses that
 * each provably narrow one name to non-null, and returns
 * Map<name, guardLineIndex> — the earliest line that guards each name.
 * See file-header step 6.
 *
 * Recognised clause shapes (audit M-F — the original version recognised
 * only `!name`, so real guards written as `if (el === null) return;` or
 * `if (!el?.id) return;` were invisible to it and produced FALSE
 * POSITIVES: the scanner would flag a dereference the code had already
 * safely guarded, just spelled differently):
 *   !name            — the original shape (falsy-check)
 *   !name?.a.b.c     — optional-chained property/method check; surviving
 *                      this means `name` itself was not null/undefined
 *                      (optional chaining short-circuits on the receiver)
 *   name === null / name == null / null === name / null == name
 *   name === undefined / name == undefined
 * Each RECOGNISED clause is credited INDEPENDENTLY, even inside a condition
 * that also contains a clause this function doesn't understand
 * (`if (!el || somethingElse()) return;`). This is mathematically sound,
 * not just convenient: surviving an `||` chain (not returning) requires
 * EVERY clause to have been false, regardless of whether the OTHERS are
 * understood — so `!el` being false (i.e. `el` non-null) is proven on
 * survival no matter what `somethingElse()` was. An unrecognised clause
 * simply contributes no name of its own; it never invalidates a sibling
 * clause that WAS understood. (An earlier draft discarded the whole guard
 * whenever ANY clause was unrecognised — needlessly conservative, and
 * fixed after review; the per-clause version still cannot mis-credit a
 * name, because each clause shape it does accept is independently
 * sufficient to prove non-nullness on its own.)
 */
function extractEarlyReturnGuards(entries) {
  const ifReturnRe = /^if\s*\(\s*(.+?)\s*\)\s*return\b/;
  const clauseRes = [
    /^!(\w+)(?:\?\.[\w.()]*)?$/,          // !name  /  !name?.a.b
    /^(\w+)\s*={2,3}\s*null$/,            // name === null / == null
    /^null\s*={2,3}\s*(\w+)$/,            // null === name / == name
    /^(\w+)\s*={2,3}\s*undefined$/,       // name === undefined
  ];
  const map = new Map();
  for (const { index, text } of entries) {
    const m = text.match(ifReturnRe);
    if (!m) continue;
    const clauses = m[1].split(/\s*\|\|\s*/);
    for (const clause of clauses) {
      for (const re of clauseRes) {
        const cm = re.exec(clause);
        if (cm) {
          if (!map.has(cm[1])) map.set(cm[1], index);
          break;
        }
      }
    }
  }
  return map;
}

/**
 * Shared by both destructuring checks (audit M-F). Given `text` starting
 * (after trimming) with `const|let|var {` or `const|let|var [`, finds the
 * BALANCED close of that opener (so nested destructuring — `const {
 * dataset: { tab } } = …` — resolves at the true outer close, not the
 * first `}` encountered) and returns `{ closeIdx }`, or null if `text`
 * doesn't start with a destructuring pattern or the brace/bracket never
 * balances.
 */
function findDestructuringLhsEnd(text) {
  const m = /^(?:const|let|var)\s*([{[])/.exec(text);
  if (!m) return null;
  const openChar = m[1];
  const closeChar = openChar === '{' ? '}' : ']';
  const openIdx = text.indexOf(openChar);
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === openChar) depth++;
    else if (text[i] === closeChar) {
      depth--;
      if (depth === 0) return { closeIdx: i };
    }
  }
  return null; // unbalanced — bail defensively, don't guess
}

/** True if `tail` (the text right after a destructured RHS expression)
 * opens with `??` or `||` — a fallback that prevents destructuring `null`/
 * `undefined` from throwing. Audit M-F: the printed remedy for
 * `unsafeDestructuring` suggests exactly `?? {}`, so the check that FLAGS
 * the shape must also recognise this as the fix — otherwise the suite's
 * own advice can't clear its own suite. */
function hasNullishFallback(tail) {
  return /^\s*(\?\?|\|\|)/.test(tail);
}

/**
 * Scans ONE independent scope — either the main file's column-0 entries, or
 * one detected IIFE body's dedented entries — and returns
 * {declaredNames, unguardedDerefs, unguardedInlineChains, unsafeDestructuring}
 * for just that scope. Kept as an isolated per-scope pass (rather than one
 * flat cross-file pass) specifically so a name declared inside an IIFE can
 * never be confused with an unrelated same-named declaration elsewhere.
 */
function scanScope(entries, originalLines) {
  const declRe = /^(?:const|let|var)\s+(\w+)\s*=\s*(.*)$/;
  const rhsIsGetterRe = /\.(?:getElementById|querySelector)\(/;
  const rhsIsArrowRe = /=>\s*document\./;

  const declaredNames = new Map(); // name -> { line (1-based), lazy }
  for (const { index, text } of entries) {
    const m = text.match(declRe);
    if (!m) continue;
    const [, name, rhs] = m;
    if (!rhsIsGetterRe.test(rhs)) continue;
    declaredNames.set(name, { line: index + 1, lazy: rhsIsArrowRe.test(rhs) });
  }

  const derefCheckNames = [...declaredNames.entries()]
    .filter(([, meta]) => !meta.lazy)
    .map(([name]) => name);

  const guards = extractEarlyReturnGuards(entries);

  const unguardedDerefs = [];
  for (const { index, text } of entries) {
    const lineNum = index + 1;
    for (const segment of splitTopLevelStatements(text)) {
      const t = segment.trimStart();
      // Audit M-A: a segment containing NO `function`/`=>` literal has no
      // deferred nested scope to worry about at all — every dereference
      // anywhere in it (not just at the receiver/head position) runs
      // synchronously as part of THIS statement. That's what lets us
      // safely widen detection to `const t = btn.dataset.tab;` (the
      // audit's own "most idiomatic shape in this codebase"),
      // `console.log(btn.value)`, `if (btn.checked)`,
      // `` `${btn.value}` `` (its `${...}` content is real, unblanked code
      // — see stripStringsAndComments), and `!btn.disabled && …`. A
      // segment that DOES contain `function`/`=>` keeps the narrower
      // receiver-only anchor below, because a same-line already-guarded
      // listener's OWN callback body — `zone?.addEventListener('drop', e
      // => { zone.classList.remove('x'); })` — legitimately re-mentions
      // the name deferred inside that callback; scanning the whole
      // segment there would re-flag it as a false positive (this is
      // exactly the bug fixed earlier when receiver-only anchoring was
      // introduced). Whether a `function`/`=>` anywhere in the segment
      // genuinely defers ALL of it, or only part, is not distinguished —
      // a coarse, deliberately conservative gate: false negatives (an
      // unguarded ref before the callback) are possible in a compound
      // statement mixing a plain reference with an unrelated callback,
      // but false positives on real, already-safe guarded-listener code
      // are not, which is the safer failure direction for a suite meant
      // to run unattended.
      const hasNestedFunctionLiteral = /\bfunction\b|=>/.test(t);
      for (const name of derefCheckNames) {
        if (lineNum === declaredNames.get(name).line) continue;
        if (guards.has(name) && index > guards.get(name)) continue; // narrowed safe by an earlier early-return guard
        const re = hasNestedFunctionLiteral
          ? new RegExp(`^${name}(?!\\?)\\s*(\\.|\\[)`)                 // receiver position only
          : new RegExp(`(^|[^\\w.?])${name}(?!\\?)\\s*(\\.|\\[)`);     // anywhere in the segment
        if (re.test(t)) {
          unguardedDerefs.push({ line: lineNum, name, text: originalLines[index].trim() });
          break;
        }
      }
      // Audit M-A/M-F: destructuring FROM an already-tracked reference —
      // `const {x} = btn;` / `const [x] = btn;` — is the same unconditional
      // "throws at the declaration line, `?.` can't fix it" danger as
      // `unsafeDestructuring` below, just applied to a variable that was
      // ALREADY resolved from getElementById/querySelector earlier,
      // instead of a fresh call. Gated the same way (no nested function
      // literal in the segment) since it's a whole-segment scan. Uses the
      // same balanced-brace LHS matcher and fallback check as
      // unsafeDestructuring so nested patterns and `?? {}` are handled
      // identically.
      if (!hasNestedFunctionLiteral) {
        const lhsEnd = findDestructuringLhsEnd(t);
        if (lhsEnd) {
          const rest = t.slice(lhsEnd.closeIdx + 1);
          const rhsM = /^\s*=\s*(\w+)(.*)$/.exec(rest);
          if (rhsM && derefCheckNames.includes(rhsM[1]) && !hasNullishFallback(rhsM[2])) {
            const name = rhsM[1];
            const guardOk = guards.has(name) && index > guards.get(name);
            if (!guardOk && lineNum !== declaredNames.get(name).line) {
              unguardedDerefs.push({ line: lineNum, name, text: originalLines[index].trim() });
            }
          }
        }
      }
    }
  }

  const unguardedInlineChains = [];
  for (const { index, text } of entries) {
    for (const segment of splitTopLevelStatements(text)) {
      const t = segment.trimStart();
      // e.g. `document.getElementById('x').addEventListener(...)` — or a
      // bare property read/assignment, `.disabled = true` — as the
      // RECEIVER of a top-level-equivalent statement, with no `?.` between
      // the call and the member access.
      if (/^document\.(?:getElementById|querySelector)\([^)]*\)\.\w/.test(t)) {
        unguardedInlineChains.push({ line: index + 1, text: originalLines[index].trim() });
        break;
      }
    }
  }

  const unsafeDestructuring = [];
  for (const { index, text } of entries) {
    // Audit M-F: the original `destructureRe` used `{[^}]*}` for the LHS,
    // which cannot match NESTED destructuring — `const { dataset: { tab }
    // } = document.getElementById('e');` — because `[^}]*` stops at the
    // first `}` (the INNER one), leaving " }" unaccounted for and failing
    // the whole match; it also never recognised a `?? {}`/`|| {}` fallback
    // as safe (so the check's own printed remedy couldn't clear the
    // check), and only handled object destructuring, not
    // `const [a] = document.querySelector('.x')` (array form — querySelector,
    // singular, can still return null; querySelectorAll cannot, and stays
    // excluded below). Balanced-brace matching + explicit fallback check
    // fix all three.
    const lhsEnd = findDestructuringLhsEnd(text);
    if (!lhsEnd) continue;
    const rest = text.slice(lhsEnd.closeIdx + 1);
    const rhsM = /^\s*=\s*document\.(getElementById|querySelector)\([^)]*\)(.*)$/.exec(rest);
    if (!rhsM) continue;
    if (hasNullishFallback(rhsM[2])) continue; // `?? {}` / `|| []` etc. — safe
    unsafeDestructuring.push({ line: index + 1, text: originalLines[index].trim() });
  }

  return { declaredNames, unguardedDerefs, unguardedInlineChains, unsafeDestructuring };
}

/**
 * A DELIBERATELY DUMB, fully independent second method for counting
 * top-level `const|let|var NAME = document.(getElementById|querySelector)(`
 * declarations (audit H-B). It does ZERO string/comment/regex/template
 * stripping and tracks NO state across lines — it just tests each RAW line
 * of the ORIGINAL source against a plain regex requiring the line to START
 * (column 0) with the declaration shape. This CANNOT go blind the way the
 * stripper-based scan() can: it has no lexer state to desync, so a nested
 * template literal, a regex literal, or any future heuristic gap that
 * confuses the sophisticated scanner has NO EFFECT on this count at all.
 * It is the primary defense against the sophisticated scanner silently
 * losing visibility over part of the file — see section 1's cross-check,
 * which asserts this count matches scan()'s own main-scope declaration
 * count EXACTLY (verified true on the real, clean app.js: both find the
 * identical 86 declarations at the identical 86 line numbers).
 *
 * Deliberately does NOT look inside IIFE bodies (deeper indentation isn't
 * column-0 in the raw file) — it is compared against scan()'s MAIN-SCOPE
 * count only (mainScopeDeclCount), not the IIFE-inclusive total, so the
 * comparison is apples-to-apples and doesn't need to know anything about
 * IIFE detection at all.
 */
function dumbColumnZeroDeclCount(rawSrc) {
  const declRe = /^(?:const|let|var)\s+\w+\s*=.*\.(?:getElementById|querySelector)\(/;
  const lines = [];
  rawSrc.split('\n').forEach((line, i) => { if (declRe.test(line)) lines.push(i + 1); });
  return lines;
}

/**
 * Top-level entry point. Builds the main file's column-0 entries plus one
 * independent entry list per detected top-level IIFE body, runs
 * `scanScope` on each, and merges the results. `declaredNames` is merged
 * for the section-1 sanity count only; the actual deref/inline/destructure
 * checks always run scope-by-scope (see scanScope's own doc comment).
 */
function scan(originalSrc) {
  const { text: cleaned, finalStackDepth } = stripStringsAndComments(originalSrc);
  const cleanedLines = cleaned.split('\n');
  const originalLines = originalSrc.split('\n');

  const mainEntries = [];
  cleanedLines.forEach((line, i) => {
    if (/^\S/.test(line)) mainEntries.push({ index: i, text: line });
  });

  const iifeRanges = findIifeBodyLineRanges(cleanedLines);
  // Audit M-E: the body's indent unit is DETECTED per-IIFE from its own
  // first non-blank line, rather than assumed to be exactly 2 spaces — a
  // 4-space- or tab-indented IIFE used to silently produce an EMPTY entry
  // list (indent didn't match `/^ {2}\S/`) while `iifeCount` still counted
  // it as found+scanned. An IIFE whose range was detected but whose body
  // yields zero entries is now tracked separately (`emptyIifeBodies`) so
  // that case can't hide behind a passing `iifeCount === N` assertion.
  let emptyIifeBodies = 0;
  const iifeEntryLists = iifeRanges.map(([start, end]) => {
    let bodyIndent = null;
    for (let i = start; i <= end; i++) {
      const m = /^(\s+)\S/.exec(cleanedLines[i]);
      if (m) { bodyIndent = m[1]; break; }
    }
    const entries = [];
    if (bodyIndent !== null) {
      for (let i = start; i <= end; i++) {
        if (cleanedLines[i].startsWith(bodyIndent) && /\S/.test(cleanedLines[i][bodyIndent.length] ?? '')) {
          entries.push({ index: i, text: cleanedLines[i].slice(bodyIndent.length) });
        }
      }
    }
    if (entries.length === 0) emptyIifeBodies++;
    return entries;
  });

  const scopes = [mainEntries, ...iifeEntryLists].map(entries => scanScope(entries, originalLines));

  const declaredNames = new Map();
  for (const s of scopes) for (const [name, meta] of s.declaredNames) declaredNames.set(name, meta);

  return {
    declaredNames,
    mainScopeDeclCount: scopes[0].declaredNames.size,
    mainScopeDeclLines: [...scopes[0].declaredNames.values()].map(m => m.line).sort((a, b) => a - b),
    dumbDeclLines: dumbColumnZeroDeclCount(originalSrc),
    iifeCount: iifeRanges.length,
    emptyIifeBodies,
    // Should always be 1 (the one root frame) — anything else means the
    // stripper is still inside an unterminated template/interpolation at
    // EOF, i.e. it desynced somewhere and everything after that point was
    // silently misread. See the class of bug documented on
    // stripStringsAndComments above (app.js:897 nested template,
    // app.js:3518 backtick-in-regex) — this is the cheapest whole-file
    // tripwire for a NEW instance of it appearing later. NOTE (audit H-B):
    // this catches only backtick/template-nesting desyncs, not a
    // quote/regex desync (those never leave the stack imbalanced) — that
    // second, more common failure mode is what dumbColumnZeroDeclCount /
    // mainScopeDeclCount exists to catch instead.
    cleanStackDepthAtEof: finalStackDepth,
    unguardedDerefs: scopes.flatMap(s => s.unguardedDerefs),
    unguardedInlineChains: scopes.flatMap(s => s.unguardedInlineChains),
    unsafeDestructuring: scopes.flatMap(s => s.unsafeDestructuring),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Section 0 — self-tests against synthetic fixtures
// ─────────────────────────────────────────────────────────────────────────
section('0. Scanner self-tests (synthetic fixtures)');

{
  const src = [
    "const btn = document.getElementById('go');",
    "btn.addEventListener('click', () => {});",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].line === 2,
    'flags an unguarded top-level `x.addEventListener(...)` where x = getElementById(...)');
}

{
  const src = [
    "const btn = document.getElementById('go');",
    "btn?.addEventListener('click', () => {});",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'does NOT flag `x?.addEventListener(...)` — the guarded form');
}

{
  const src = "document.getElementById('go').addEventListener('click', () => {});";
  const r = scan(src);
  ok(r.unguardedInlineChains.length === 1,
    'flags an unguarded inline `document.getElementById(...).addEventListener(...)` chain');
}

{
  const src = "document.querySelector('[data-tab=\"x\"]').addEventListener('click', () => {});";
  const r = scan(src);
  ok(r.unguardedInlineChains.length === 1,
    'flags an unguarded inline `document.querySelector(...).addEventListener(...)` chain (the two named in the Track 1.2 audit were this exact shape)');
}

{
  const src = "document.getElementById('go')?.addEventListener('click', () => {});";
  const r = scan(src);
  ok(r.unguardedInlineChains.length === 0,
    'does NOT flag the `?.`-guarded inline chain form');
}

{
  const src = "document.querySelectorAll('.tab-btn').forEach(b => {});";
  const r = scan(src);
  ok(r.unguardedInlineChains.length === 0,
    'never flags querySelectorAll(...) chains — it never returns null (returns an empty NodeList at worst)');
}

{
  // Non-call property reads and assignments are dereferences too — as
  // fatal as a method call, and (per L4 of the audit) the likeliest real
  // shape. Both the inline-chain form and the stored-const form must be
  // caught, not just `.addEventListener(...)`.
  const src1 = "document.getElementById('go').parentElement;";
  const src2 = "document.getElementById('go').disabled = true;";
  const src3 = "const el = document.getElementById('go');\nel.parentElement.classList.add('x');";
  const src4 = "const el = document.getElementById('go');\nel.disabled = true;";
  ok(scan(src1).unguardedInlineChains.length === 1, 'flags a bare inline property READ (`.parentElement;`), not just a call');
  ok(scan(src2).unguardedInlineChains.length === 1, 'flags an inline property ASSIGNMENT (`.disabled = true;`), not just a call');
  ok(scan(src3).unguardedDerefs.length === 1, 'flags a stored-const property chain (`el.parentElement.classList.add(...)`)');
  ok(scan(src4).unguardedDerefs.length === 1, 'flags a stored-const property assignment (`el.disabled = true;`)');
}

{
  const src = [
    "const btn = document.getElementById('go');",
    "function wire() {",
    "  btn.addEventListener('click', () => {});", // indented -> inside a function -> deferred, not module-scope
    "}",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'does NOT flag a dereference that is inside an ordinary (non-IIFE) function body (indented / deferred, not top-level-equivalent)');
}

{
  const src = "const getBtn = () => document.getElementById('go');\ngetBtn().addEventListener('click', () => {});";
  const r = scan(src);
  ok(r.declaredNames.get('getBtn')?.lazy === true && r.unguardedDerefs.length === 0,
    'treats `const x = () => document.getElementById(...)` as a lazy getter and does not flag its use — nothing is dereferenced until called');
}

{
  // A dereference living inside a comment or string must never trigger a
  // false positive — this is what stripStringsAndComments exists to avoid.
  const src = [
    "const btn = document.getElementById('go');",
    "btn?.addEventListener('click', () => {});",
    "// btn.disabled = true; <- this mention in a comment must not be flagged",
    "const msg = 'btn.disabled would throw if unguarded';",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'ignores mentions of a tracked name inside comments and string literals (no false positive)');
}

{
  // Regression guard for the stripper's own real bug (see
  // stripStringsAndComments's doc comment): a NESTED template literal —
  // the outer template's `${...}` interpolation contains a complete inner
  // template — must not desync the parser into misreading everything
  // after it. This is the exact shape at app.js:897. Deliberately placed
  // BEFORE a real dangerous statement so a regression (desync swallowing
  // the rest of the input) would show up as a MISSED detection, not just
  // a crash.
  const src = [
    "const html = `<div>${items.map(x => `<span>${x}</span>`).join('')}</div>`;",
    "const btn = document.getElementById('go');",
    "btn.addEventListener('click', () => {});",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].line === 3,
    'a nested template literal (outer `${...}` containing a complete inner template, like app.js:897) does not desync the stripper — the real danger two lines later is still caught');
}

{
  // Regression guard for the stripper's other real bug: a /regex/ literal
  // containing raw backtick (or quote) characters — the exact shape at
  // app.js:3518, `.replace(/`([^`]+)`/g, ...)` — must be recognised as ONE
  // regex literal, not three separate template-string toggles. An odd
  // count of backticks inside the pattern is exactly what desynced the
  // original single-pass stripper.
  const src = [
    "const clean = raw.replace(/`([^`]+)`/g, '<code>$1</code>');",
    "const btn = document.getElementById('go');",
    "btn.addEventListener('click', () => {});",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].line === 3,
    'a /regex/ literal containing raw backticks (app.js:3518\'s markdown-inline-code pattern) is treated as one opaque regex, not mistaken for template-string delimiters');
}

{
  // The regex-vs-division heuristic's other side: an ACTUAL division must
  // not be swallowed as a regex-literal opener (which would eat the rest
  // of the line looking for a second `/`).
  const src = "const ratio = width / height;\nconst btn = document.getElementById('go');\nbtn.addEventListener('click', () => {});";
  const r = scan(src);
  ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].line === 3,
    'a genuine division (`width / height`, after an identifier) is not mistaken for a regex literal opener');
}

{
  // Whole-file self-check surfaced as its own fixture: the stack must
  // return to depth 1 (fully closed) for well-formed input, and this is
  // what section 1 asserts against the real app.js.
  const src = "const html = `<div>${items.map(x => `<span>${x}</span>`).join('')}</div>`;";
  const r = scan(src);
  ok(r.cleanStackDepthAtEof === 1,
    'the stripper\'s internal stack returns to depth 1 (fully balanced) after a well-formed nested template — the tripwire section 1 relies on');
}

{
  // Regression guard for the fix pattern itself: a dereference INSIDE the
  // callback of an already-guarded listener is safe (the callback only
  // runs if the listener bound, which requires the element to exist), and
  // must not be flagged even though it's technically a bare reference.
  const src = [
    "const zone = document.getElementById('zone');",
    "zone?.addEventListener('drop', e => {",
    "  zone.classList.remove('dragover');", // indented -> inside the callback -> deferred
    "});",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'does not flag a dereference inside an already-guarded listener\'s own (indented) callback body');
}

{
  // L4 (audit): a top-level IIFE's body runs synchronously, so a bare
  // dereference inside one is exactly as dangerous as a bare top-level
  // statement, even though it's indented.
  const src = [
    "(function wireThing() {",
    "  const btn = document.getElementById('go');",
    "  btn.addEventListener('click', () => {});",
    "})();",
  ].join('\n');
  const r = scan(src);
  ok(r.iifeCount === 1, 'detects the top-level IIFE');
  ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].name === 'btn',
    'flags an unguarded dereference inside a top-level IIFE body (one indent level in)');
}

{
  // The exact real-world shape at app.js's one IIFE (`wireHealthCheck`,
  // ~line 4274): an early `if (!a || !b) return;` guard makes every
  // SUBSEQUENT bare dereference of those names in the same body provably
  // safe — this must NOT be flagged, or turning on IIFE scanning would
  // false-positive on real, already-correct code.
  const src = [
    "(function wireHealthCheck() {",
    "  const runBtn = document.getElementById('run');",
    "  const results = document.getElementById('results');",
    "  if (!runBtn || !results) return;",
    "  runBtn.addEventListener('click', () => { results.classList.remove('hidden'); });",
    "})();",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'does NOT flag a name inside a top-level IIFE that an earlier `if (!a || !b) return;` guard already narrowed to non-null — the real wireHealthCheck pattern');
}

{
  // The guard only protects code AFTER it — a dereference appearing BEFORE
  // the early-return (an unusual, likely-buggy order) is still unsafe and
  // must still be flagged.
  const src = [
    "(function oddOrder() {",
    "  const runBtn = document.getElementById('run');",
    "  runBtn.disabled = true;", // before the guard — still dangerous
    "  if (!runBtn) return;",
    "})();",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 1,
    'a dereference BEFORE its `if (!x) return;` guard is still flagged — the exemption only applies to lines after the guard');
}

{
  // Nested (deferred) code inside a top-level IIFE must stay excluded —
  // only the ONE indent level directly inside the IIFE body counts as
  // top-level-equivalent; a callback nested further in (2+ levels) is
  // exactly as deferred as it would be at the true top level.
  const src = [
    "(function wireThing() {",
    "  const btn = document.getElementById('go');",
    "  btn?.addEventListener('click', () => {",
    "    btn.classList.add('clicked');", // 4-space indent inside the callback -> deferred
    "  });",
    "})();",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'does not flag a dereference nested two levels inside a top-level IIFE (inside its own guarded callback) — only the outer indent level is scanned');
}

{
  // Unsafe destructuring (L4 item 4): dangerous at the DECLARATION line
  // itself — `?.` cannot fix this shape, unlike a plain `const el = ...`.
  const src = "const { value } = document.getElementById('e');";
  const r = scan(src);
  ok(r.unsafeDestructuring.length === 1,
    'flags `const { x } = document.getElementById(...)` as unsafe destructuring — destructuring null throws immediately, at the declaration itself');
}

{
  // A plain (non-destructuring) assignment is never flagged as
  // destructuring, and querySelectorAll (never null) is excluded even in
  // destructuring form.
  const src = [
    "const el = document.getElementById('e');",
    "const [a] = document.querySelectorAll('.x');",
  ].join('\n');
  const r = scan(src);
  ok(r.unsafeDestructuring.length === 0,
    'does not flag a plain const assignment or array-destructuring off querySelectorAll (never null) as unsafe');
}

{
  // Honest documented limitation (see file header): a chain used as a
  // NESTED ARGUMENT, not as the head of a top-level statement, is not
  // separately re-scanned by step 4's anchor-at-segment-start check. This
  // fixture pins the CURRENT (documented) behaviour so a future change to
  // this scanner can't silently regress the documentation without also
  // changing this assertion.
  const src = "foo(document.getElementById('go').parentElement);";
  const r = scan(src);
  ok(r.unguardedInlineChains.length === 0,
    'documented limitation: a getElementById/querySelector chain used as a nested call ARGUMENT (not the head of the statement) is not flagged — see the file header\'s "does not detect" list');
}

{
  // Honest documented limitation: a top-level `if {}` block (a
  // control-flow block, not a function/IIFE scope) around a bare
  // dereference is not scanned the way an IIFE body is. Pinned the same
  // way as the argument-position case above.
  const src = [
    "const btn = document.getElementById('go');",
    "if (someFlag) {",
    "  btn.addEventListener('click', () => {});", // indented like a function body, but this is a plain if-block
    "}",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'documented limitation: a dereference inside a top-level `if {}` block (not a function/IIFE) is not flagged — see the file header\'s "does not detect" list; no such block exists in app.js today');
}

// ─────────────────────────────────────────────────────────────────────────
// H-B fixtures (audit round 2, HIGH priority): the regex-vs-division
// heuristic's own real bug, and the independent cross-check that catches
// what the heuristic still can't.
// ─────────────────────────────────────────────────────────────────────────

{
  // The exact class of live bug the audit demonstrated end-to-end against
  // a real poisoned copy of app.js: `noteCodeChar` used to append
  // WHITESPACE to `lastCodeTail`, so after "return " the tail never
  // actually ended in "return" and the `$`-anchored keyword regex could
  // never match — `return /re/` (and any keyword-then-regex shape) lexed
  // as DIVISION, reading the regex body as code and cascading into a
  // desync that swallowed a real dangerous element completely (it didn't
  // even show up in the declaration count).
  const src = [
    "function needsQuoting(s) { return /[\"']/.test(s); }",
    "const btn = document.getElementById('go');",
    "btn.addEventListener('click', () => {});",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].line === 3,
    'a `return /regex/` (keyword immediately before the regex, the fixed noteCodeChar bug) does not desync the stripper — the real danger after it is still caught');
}

{
  // Same shape, `if (cond) return /regex/;` on one line — another common
  // real form of "keyword immediately precedes the regex".
  const src = [
    "function f(s) { if (s) return /[a-z]/.test(s); }",
    "const btn = document.getElementById('go');",
    "btn.addEventListener('click', () => {});",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].line === 3,
    '`if (cond) return /regex/;` on one line does not desync the stripper');
}

{
  // Documented residual gap, pinned honestly rather than silently left
  // out (audit H-B): a regex literal used as a bare expression-statement
  // directly after a closing `)` — with NO keyword immediately before the
  // `/` — is not distinguished from division by this heuristic, because
  // the heuristic only looks at the single character/keyword immediately
  // preceding the `/`, not whether that `)` closed a control-flow
  // condition (`if (...)`) versus an ordinary call/grouping expression.
  // `app.js` has no such shape today. This is exactly why the independent
  // cross-check exists below — it doesn't depend on this heuristic at
  // all, so it still catches the resulting desync even here.
  const src = [
    "function nav() { return true; }",
    "if (nav()) /'/.test('x');",
    "const btn = document.getElementById('go');",
    "btn.addEventListener('click', () => {});",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'documented residual gap: `if (cond) /regex/;` (no keyword immediately before the `/`, closing paren belongs to a control-flow condition) still desyncs the regex-vs-division heuristic — the independent cross-check (next fixture) is the real defence for this shape');
  const onlyInDumb = r.dumbDeclLines.filter(l => !r.mainScopeDeclLines.includes(l));
  ok(r.dumbDeclLines.length !== r.mainScopeDeclCount && onlyInDumb.length === 1,
    'but the independent dumb recount still disagrees with the sophisticated scanner by exactly the one declaration the desync swallowed — proving the cross-check catches this heuristic gap even though the heuristic itself does not');
}

{
  // The independent cross-check must positively PASS on a genuinely clean
  // file with a real division present, so it's not just biased to always
  // disagree.
  const src = [
    "const ratio = width / height;",
    "const btn = document.getElementById('go');",
    "btn?.addEventListener('click', () => {});",
  ].join('\n');
  const r = scan(src);
  const onlyInDumb = r.dumbDeclLines.filter(l => !r.mainScopeDeclLines.includes(l));
  ok(r.dumbDeclLines.length === r.mainScopeDeclCount && onlyInDumb.length === 0,
    'the independent cross-check agrees with the sophisticated scanner on ordinary, non-adversarial input (division included)');
}

// ─────────────────────────────────────────────────────────────────────────
// M-A fixtures (audit round 2): detection widened beyond receiver
// position for segments with no nested function/arrow literal.
// ─────────────────────────────────────────────────────────────────────────

{
  const cases = [
    ["const t = btn.dataset.tab;", 'the audit\'s own "most idiomatic shape in this codebase" — a bare property read on the RIGHT of an assignment'],
    ["console.log(btn.value);", 'a bare property read as a plain call ARGUMENT (no nested function/arrow present)'],
    ["if (btn.checked) doThing();", 'a bare property read inside an `if (...)` condition'],
    ["const s = `${btn.value}`;", 'a bare property read inside a template-literal `${...}` interpolation (real, unblanked code)'],
    ["!btn.disabled && doThing();", 'a bare property read on the left of `&&`'],
  ];
  for (const [stmt, label] of cases) {
    const src = `const btn = document.getElementById('go');\n${stmt}`;
    const r = scan(src);
    ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].line === 2,
      `widened detection catches: ${label} — \`${stmt}\``);
  }
}

{
  // The widening must NOT reopen the exact false-positive it was
  // originally built to avoid: a same-line already-guarded listener's OWN
  // callback body legitimately re-mentions the name, deferred.
  const src = [
    "const zone = document.getElementById('zone');",
    "zone?.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('x'); });",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'the M-A widening does not false-positive on a same-line guarded listener\'s own deferred callback body (the exact shape the receiver-only anchor was originally built to protect)');
}

{
  // Destructuring FROM an already-tracked reference (not a fresh
  // getElementById/querySelector call) is the same unconditional danger.
  const src = [
    "const btn = document.getElementById('go');",
    "const { value } = btn;",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 1 && r.unguardedDerefs[0].line === 2,
    'flags destructuring FROM an already-declared tracked reference (`const { value } = btn;`), not just from a fresh getElementById(...) call');
}

{
  // ...but a nullish fallback on that destructuring makes it safe, same
  // as the direct-call form below.
  const src = [
    "const btn = document.getElementById('go');",
    "const { value } = btn ?? {};",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'does not flag destructuring from a tracked reference when a `?? {}` fallback is present');
}

// ─────────────────────────────────────────────────────────────────────────
// M-E fixtures (audit round 2): more IIFE opener/closer shapes, adaptive
// body indentation, and proof the body was actually scanned.
// ─────────────────────────────────────────────────────────────────────────

{
  // Crockford style: the invocation parens sit INSIDE the wrapping parens
  // (`}());`), not after them (`})();`).
  const src = [
    "(function wireThing() {",
    "  const btn = document.getElementById('go');",
    "  btn.addEventListener('click', () => {});",
    "}());",
  ].join('\n');
  const r = scan(src);
  ok(r.iifeCount === 1 && r.unguardedDerefs.length === 1,
    'detects and scans a Crockford-style IIFE closer (`}());` — invocation parens inside the wrapper)');
}

{
  // Defensive leading semicolon (ASI-hazard avoidance): `;(function () {`.
  const src = [
    ";(function wireThing() {",
    "  const btn = document.getElementById('go');",
    "  btn.addEventListener('click', () => {});",
    "})();",
  ].join('\n');
  const r = scan(src);
  ok(r.iifeCount === 1 && r.unguardedDerefs.length === 1,
    'detects and scans an IIFE with a defensive leading `;` before the wrapper');
}

{
  // Adaptive indentation: the body uses 4 spaces, not the file's usual 2 —
  // the detector must derive the indent unit from the IIFE's own first
  // body line rather than assuming a fixed 2 spaces (the original bug:
  // `/^ {2}\S/` against a 4-space body matched nothing, silently
  // producing zero scanned entries while `iifeCount` still said "found").
  const src = [
    "(function wireThing() {",
    "    const btn = document.getElementById('go');",
    "    btn.addEventListener('click', () => {});",
    "})();",
  ].join('\n');
  const r = scan(src);
  ok(r.iifeCount === 1 && r.emptyIifeBodies === 0 && r.unguardedDerefs.length === 1,
    'a 4-space-indented IIFE body is detected AND actually scanned (not just found-but-empty) — adaptive indent, not a hardcoded 2 spaces');
}

{
  // emptyIifeBodies must fire when a detected IIFE truly has no scannable
  // body line at all (synthetic edge case — an IIFE with only a comment
  // inside, which strips to a blank line).
  const src = [
    "(function wireThing() {",
    "  // nothing but a comment in here",
    "})();",
  ].join('\n');
  const r = scan(src);
  ok(r.iifeCount === 1 && r.emptyIifeBodies === 1,
    'a detected IIFE whose body has no real code is counted in emptyIifeBodies rather than silently reported as scanned');
}

{
  // Documented residual gaps (audit M-E), pinned honestly: a unary-operator
  // IIFE (`!function(){}()`, no wrapping parens at all — a structurally
  // different shape) and an arrow IIFE whose own parameter list contains a
  // nested call in a default value (`((a = f()) => {...})()` — the naive
  // `[^)]*` parameter-list regex can't handle nested parens). Neither
  // exists in app.js today.
  const src1 = [
    "!function wireThing() {",
    "  const btn = document.getElementById('go');",
    "  btn.addEventListener('click', () => {});",
    "}();",
  ].join('\n');
  const src2 = [
    "((a = f()) => {",
    "  const btn = document.getElementById('go');",
    "  btn.addEventListener('click', () => {});",
    "})();",
  ].join('\n');
  ok(scan(src1).iifeCount === 0,
    'documented residual gap: a unary-operator IIFE (`!function(){}()`, no wrapping parens) is not detected — see the file header\'s "does not detect" list');
  ok(scan(src2).iifeCount === 0,
    'documented residual gap: an arrow IIFE with a nested-call default parameter (`((a = f()) => {...})()`) is not detected — see the file header\'s "does not detect" list');
}

// ─────────────────────────────────────────────────────────────────────────
// M-F fixtures (audit round 2): destructuring balanced-brace matching,
// nullish-fallback safety, array form, and the widened guard recogniser.
// ─────────────────────────────────────────────────────────────────────────

{
  // Nested destructuring: the original `[^}]*` LHS matcher stopped at the
  // FIRST `}` (the inner one), so this shape didn't match at all and
  // silently escaped detection entirely.
  const src = "const { dataset: { tab } } = document.getElementById('e');";
  const r = scan(src);
  ok(r.unsafeDestructuring.length === 1,
    'flags NESTED destructuring (`const { dataset: { tab } } = document.getElementById(...)`) — the original LHS matcher could not see past the inner `}`');
}

{
  // The printed remedy (`?? {}`) must actually clear the check it's the
  // remedy FOR — audit M-F found the original regex still flagged this.
  const src1 = "const { value } = document.getElementById('e') ?? {};";
  const src2 = "const { value } = document.getElementById('e') || {};";
  ok(scan(src1).unsafeDestructuring.length === 0, 'a `?? {}` fallback clears the unsafe-destructuring flag — the printed remedy actually works');
  ok(scan(src2).unsafeDestructuring.length === 0, 'a `|| {}` fallback also clears the unsafe-destructuring flag');
}

{
  // Array destructuring from a SINGULAR querySelector (can return null,
  // unlike querySelectorAll) is just as dangerous as the object form.
  const src = "const [a] = document.querySelector('.x');";
  const r = scan(src);
  ok(r.unsafeDestructuring.length === 1,
    'flags array destructuring from `document.querySelector(...)` (singular — can be null), not just the object-destructuring form');
}

{
  // ...but querySelectorAll (never null) stays excluded even in array form
  // and even with nested brackets, matching the original invariant.
  const src = "const [a, b] = document.querySelectorAll('.x');";
  const r = scan(src);
  ok(r.unsafeDestructuring.length === 0,
    'does not flag array destructuring off querySelectorAll (never null)');
}

{
  // Widened guard recogniser: `=== null` and `!x?.prop` forms, which the
  // audit found produced FALSE POSITIVES under the original `!name`-only
  // recogniser (the scanner would cry wolf on code that was already safe).
  const src1 = [
    "(function w() {",
    "  const el = document.getElementById('e');",
    "  if (el === null) return;",
    "  el.disabled = true;",
    "})();",
  ].join('\n');
  const src2 = [
    "(function w() {",
    "  const el = document.getElementById('e');",
    "  if (!el?.id) return;",
    "  el.disabled = true;",
    "})();",
  ].join('\n');
  ok(scan(src1).unguardedDerefs.length === 0, 'recognises `if (el === null) return;` as a valid narrowing guard');
  ok(scan(src2).unguardedDerefs.length === 0, 'recognises `if (!el?.id) return;` as a valid narrowing guard (optional-chained property check on the receiver still proves the receiver itself is non-null)');
}

{
  // The guard recogniser must stay conservative — a condition mixing in
  // something it doesn't understand must NOT be credited, or a future
  // change could hide a real bug behind a guard that doesn't actually
  // cover it.
  const src = [
    "(function w() {",
    "  const el = document.getElementById('e');",
    "  if (!el || somethingElse()) return;",
    "  el.disabled = true;",
    "})();",
  ].join('\n');
  const r = scan(src);
  ok(r.unguardedDerefs.length === 0,
    'a mixed condition (`!el || somethingElse()`) still credits the recognised `!el` clause — union of `||` clauses, each independently verified, is the documented contract');
}

// ─────────────────────────────────────────────────────────────────────────
// Section 1 — the real src/public/app.js must be clean
// ─────────────────────────────────────────────────────────────────────────
section('1. src/public/app.js has no unguarded module-scope element dereferences');

const appJsPath = path.join(ROOT, 'src/public/app.js');
const appJsSrc = readFileSync(appJsPath, 'utf8');
const result = scan(appJsSrc);

// Sanity: the scanner must actually be finding the real declarations, or
// every assertion below would pass vacuously (exactly the failure mode
// test-css-tokens.js's section 0 exists to prevent). Audit M-G: the
// original threshold (>= 50) permitted 44% silent loss before it would
// ever react against the real count (90) — raised to sit close to today's
// real number. This is still a COARSE net, not the real defence — a
// one-or-two-item drop can't be caught by any fixed threshold without
// breaking on ordinary future edits; the exact cross-check below is what
// actually catches that class of regression.
ok(result.declaredNames.size >= 85,
  `found ${result.declaredNames.size} top-level-equivalent getElementById/querySelector declaration(s) in app.js (expected >= 85 — today's real count is 90; a much lower count would mean the scanner is silently losing visibility, not that app.js shrank)`);

// Audit H-B (the priority finding): an independent, deliberately dumb,
// zero-stripping recount of MAIN-SCOPE (non-IIFE) declarations, cross-
// checked for EXACT agreement against scan()'s own main-scope count. This
// is the real defence against the sophisticated stripper-based scanner
// silently going blind over some span of the file — a regex-vs-division
// misclassification, a new nested template shape, or any future lexer
// gap all show up here the same way, because dumbColumnZeroDeclCount does
// no lexing at all and therefore has no lexer state to desync. Verified
// against the real, clean file: both methods find the identical 86
// declarations at the identical 86 line numbers. Verified to actually
// fire: inserting `function f(s){return /["']/.test(s);}` before an
// unguarded element (the exact live poison that motivated this check —
// see stripStringsAndComments's noteCodeChar fix) desynced the
// sophisticated scanner before that fix; this cross-check would have
// caught it even if the keyword-tail fix had missed a case, because it
// doesn't depend on the same heuristic at all.
{
  const dumbLines = result.dumbDeclLines;
  const sophLines = result.mainScopeDeclLines;
  const onlyInDumb = dumbLines.filter(l => !sophLines.includes(l));
  const onlyInSoph = sophLines.filter(l => !dumbLines.includes(l));
  const exactMatch = onlyInDumb.length === 0 && onlyInSoph.length === 0;
  ok(exactMatch,
    exactMatch
      ? `the independent dumb recount (${dumbLines.length} declarations) exactly matches scan()'s main-scope declarations — same count, same line numbers`
      : `MISMATCH between the independent dumb recount (${dumbLines.length}) and the sophisticated scanner's main-scope count (${sophLines.length}). `
        + `This means the stripper-based scan is silently losing (or gaining) visibility over part of app.js — a real desync, the exact bug class this cross-check exists to catch. `
        + `Lines the dumb recount found that the sophisticated scanner missed: ${JSON.stringify(onlyInDumb)}. `
        + `Lines the sophisticated scanner found that the dumb recount didn't (expected to be empty — a non-empty list here would itself be a bug in the dumb check, not the real scanner): ${JSON.stringify(onlyInSoph)}. `
        + `Check the missed line(s) directly and look for a new regex/template shape confusing the stripper.`);
}

const lazyCount = [...result.declaredNames.values()].filter(m => m.lazy).length;
ok(lazyCount >= 3,
  `found ${lazyCount} lazy-getter declaration(s) (e.g. sbSection/sbList/sbEmpty) correctly excluded from the deref check`);

ok(result.iifeCount === 1,
  `found ${result.iifeCount} top-level IIFE(s) in app.js (expected exactly 1 — wireHealthCheck, ~line 4274; a different count means either a new IIFE appeared, worth scanning, or the detector broke)`);

// Audit M-E: a detected-but-unscannable IIFE body (indentation didn't
// match what the detector expected, or the body was genuinely empty)
// used to silently report "found and scanned" via `iifeCount` alone. This
// separately proves each detected IIFE's body actually yielded lines to
// scan.
ok(result.emptyIifeBodies === 0,
  result.emptyIifeBodies === 0
    ? `every detected top-level IIFE body yielded scannable lines (none were found-but-empty)`
    : `${result.emptyIifeBodies} of ${result.iifeCount} detected IIFE body/bodies produced ZERO scannable lines — the range was found but nothing inside it was actually checked. Likely cause: inconsistent indentation inside that IIFE (mixed tabs/spaces, or a body indent that changes partway through).`);

// The whole-file tripwire for the stripper's own bug class (see
// stripStringsAndComments's doc comment: app.js:897's nested template and
// app.js:3518's backtick-in-regex both desynced the original single-pass
// version). If this is ever anything other than 1, the stripper is stuck
// inside an unterminated template/interpolation at EOF and everything
// after wherever it desynced was silently misread — every OTHER assertion
// in this file becomes untrustworthy for that span, not just this one.
ok(result.cleanStackDepthAtEof === 1,
  result.cleanStackDepthAtEof === 1
    ? 'the string/template stripper is internally balanced across the whole real file (ends at stack depth 1, not stuck inside a template)'
    : `the stripper ended at stack depth ${result.cleanStackDepthAtEof} (want 1) — it is stuck inside an unterminated template literal or `
      + `\${...} interpolation somewhere in app.js, meaning some span of the real file was silently misread as string content and every other `
      + `assertion in this suite is unreliable for that span. Look for a new nested template literal or a regex literal containing an odd number `
      + `of backtick/quote characters — the same bug class as app.js:897 and app.js:3518 (see stripStringsAndComments\'s doc comment).`);

ok(result.unguardedDerefs.length === 0,
  result.unguardedDerefs.length === 0
    ? 'every top-level-equivalent dereference of a getElementById/querySelector-derived const is `?.`-guarded (or narrowed by an earlier early-return guard)'
    : `found ${result.unguardedDerefs.length} unguarded top-level-equivalent dereference(s):\n` +
      result.unguardedDerefs.map(d => `        app.js:${d.line}  [${d.name}]  ${d.text}`).join('\n') +
      '\n        Fix: add `?.` at the dereference point (e.g. `x.addEventListener(...)` -> `x?.addEventListener(...)`), or an `if (!x) return;` early-exit guard before it.' +
      ' A null element must degrade that one feature, never throw at module scope and blank the whole app — see the file header of this suite.');

ok(result.unguardedInlineChains.length === 0,
  result.unguardedInlineChains.length === 0
    ? 'every top-level-equivalent inline `document.getElementById/querySelector(...).<member>` chain (call, property read, or assignment) is `?.`-guarded'
    : `found ${result.unguardedInlineChains.length} unguarded inline chain(s):\n` +
      result.unguardedInlineChains.map(d => `        app.js:${d.line}  ${d.text}`).join('\n') +
      '\n        Fix: add `?.` before the member access (e.g. `document.getElementById(\'x\').addEventListener(...)` -> `document.getElementById(\'x\')?.addEventListener(...)`), matching the pattern already used throughout app.js.');

ok(result.unsafeDestructuring.length === 0,
  result.unsafeDestructuring.length === 0
    ? 'no unsafe destructuring of a getElementById/querySelector result at top-level-equivalent scope'
    : `found ${result.unsafeDestructuring.length} unsafe destructuring declaration(s):\n` +
      result.unsafeDestructuring.map(d => `        app.js:${d.line}  ${d.text}`).join('\n') +
      '\n        Fix: destructure defensively (e.g. `const { x } = document.getElementById(\'e\') ?? {};`) or split into a plain lookup + null check first — a bare `const { x } = document.getElementById(...)` throws immediately if the element is missing, before any later `?.` could help.');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All frontend null-safety assertions green');
