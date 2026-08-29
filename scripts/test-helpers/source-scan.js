/**
 * Shared source-scanning helpers for the offline frontend suites.
 *
 * WHY THIS EXISTS. An adversarial audit on 2026-08-29 found ~40 assertions
 * across seven suites that could not fail. Four root causes, all of them
 * addressed here:
 *
 *   1. A positive source scan run over RAW source is satisfied by a `//`
 *      comment. Proven repeatedly: deleting a real call and leaving
 *      `// theCall();` behind kept suites green while shipping the defect the
 *      assertion existed to prevent. Two suites had no comment stripping at
 *      all; one had a version that missed a TRAILING `//`.
 *   2. A FILE-WIDE regex is satisfied by a matching line in a DIFFERENT
 *      function. `open()`'s disabled refusal was deleted outright and the
 *      suite stayed green because an identical line exists in `onKeyDown`.
 *   3. A function is extracted and executed, but its CALL SITE is never
 *      asserted — so the function can be left with zero callers, or the call
 *      can be deleted, with every executed assertion still passing.
 *   4. An expected value is read from the same constant the code reads, so
 *      expected equals actual by construction. That one cannot be fixed by a
 *      helper; it is a rule — pin to a LITERAL. See `assertLiteral` below for
 *      the shape to use instead.
 *
 * Every helper here is self-tested by `scripts/test-source-scan-helpers.js`,
 * which includes POSITIVE CONTROLS proving each one detects the defect it
 * claims to. A helper nobody has proven can detect is the thing it replaces.
 */

/**
 * Remove comments so a scan reads the source the ENGINE reads.
 *
 * Handles block comments, line comments (including a trailing `//` after real
 * code, which the previous hand-rolled version missed), and — critically —
 * does NOT strip comment-looking text inside string or template literals or
 * regex literals, because `'https://x'` and `/a\/\/b/` are code, not comments.
 * Newlines are preserved so reported line numbers stay meaningful.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // What we are inside of: null | "'" | '"' | '`' | 'regex'
  let quote = null;
  // Tracks whether a `/` can legally start a regex literal here.
  let prevMeaningful = '';
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
      if (quote === 'regex' && c === '\n') { quote = null; out += c; i++; continue; }
      if ((quote === 'regex' && c === '/') || c === quote) { quote = null; }
      out += c; i++; continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && /[=(,:[!&|?{};+\-*%^~<>]|^$|return|typeof|case|in|of|do|else/.test(prevMeaningful)) {
      quote = 'regex'; out += c; i++; continue;
    }
    if (!/\s/.test(c)) prevMeaningful = /[A-Za-z0-9_$]/.test(c) ? (prevMeaningful + c).slice(-8) : c;
    out += c; i++;
  }
  return out;
}

/**
 * Return the SOURCE OF ONE FUNCTION, brace-matched, so an assertion cannot be
 * satisfied by a line living in a different function (root cause 2).
 *
 * Recognises the declaration forms this codebase actually uses:
 *   function f(…) {}            async function f(…) {}
 *   const f = (…) => {}         const f = async (…) => {}
 *   const f = function (…) {}   f(…) {}  (object/class method)
 *
 * Returns null when the name is not found, so a caller can FAIL LOUDLY rather
 * than scanning an empty string and passing vacuously. Always pass source that
 * has already been through `stripComments`.
 */
export function functionSource(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [
    new RegExp(`(?:async\\s+)?function\\s+${esc}\\s*\\(`),
    new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s*)?\\(`),
    new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s+)?function\\b`),
    new RegExp(`(?:^|[\\s,{])${esc}\\s*\\([^)]*\\)\\s*\\{`, 'm'),
  ];
  let start = -1;
  for (const re of forms) {
    const m = re.exec(src);
    if (m) { start = m.index; break; }
  }
  if (start === -1) return null;
  // Skip the PARAMETER LIST before looking for the body brace. A default
  // object parameter — `f(project, input = {})`, which this codebase uses —
  // otherwise brace-matches the `{}` of the DEFAULT and returns a ~50-char
  // slice of the signature. That fails safe (a scan finds nothing) but an
  // assertion written `=== 0` then passes VACUOUSLY over source that plainly
  // contains the thing. Found by an agent adopting this module, not by review.
  const paren = src.indexOf('(', start);
  let afterParams = start;
  if (paren !== -1) {
    let pd = 0;
    for (let i = paren; i < src.length; i++) {
      if (src[i] === '(') pd++;
      else if (src[i] === ')') { pd--; if (pd === 0) { afterParams = i + 1; break; } }
    }
  }
  const open = src.indexOf('{', afterParams);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/**
 * Count REAL call sites of `fn`, excluding its own declaration — the fix for
 * root cause 3. `within` scopes the count to one enclosing function, so
 * "`stopPoll()` is called in the teardown" cannot be satisfied by the call in
 * some other function.
 *
 * Throws when `within` names a function that does not exist, because a scan
 * over an empty string is exactly the vacuous pass this module exists to stop.
 */
export function callSiteCount(rawSrc, fn, { within = null } = {}) {
  const src = stripComments(rawSrc);
  let scope = src;
  if (within) {
    scope = functionSource(src, within);
    if (scope === null) throw new Error(`callSiteCount: enclosing function '${within}' not found — the scan would have passed vacuously`);
  }
  const esc = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const calls = scope.match(new RegExp(`(?<![.\\w$])${esc}\\s*\\(`, 'g')) || [];
  const decls = scope.match(new RegExp(`(?:function\\s+${esc}\\s*\\(|(?:const|let|var)\\s+${esc}\\s*=)`, 'g')) || [];
  return calls.length - decls.length;
}

/**
 * Compare an actual value against a HAND-WRITTEN LITERAL (root cause 4) and
 * return the verdict, WITHOUT touching the caller's assertion function.
 *
 * PREFER THIS over `assertLiteral`. It cannot be misused, because it never
 * receives an `ok` whose argument order it might guess wrong — see the hazard
 * documented on `assertLiteral` below, which is not hypothetical: it was hit
 * on the first real adoption of this module.
 *
 *   const v = checkLiteral('measured by The Curator', CHIPS.curator, 'curator chip');
 *   ok(v.pass, v.message);          // suites with ok(cond, label)
 *   ok(v.message, v.pass);          // suites with ok(label, cond)
 */
export function checkLiteral(literal, actual, message) {
  const pass = actual === literal;
  return {
    pass,
    message: `${message} — expected the literal ${JSON.stringify(literal)}, got ${JSON.stringify(actual)}`,
  };
}

/**
 * ⚠ SIGNATURE HAZARD — read before using this instead of `checkLiteral`.
 *
 * This form calls `ok(cond, message)`. The suites in this repo are NOT
 * consistent about that order — measured 2026-08-29:
 *
 *   scripts/test-next-memory-view.js            function ok(label, cond, detail)
 *   scripts/test-next-model-picker.js           function ok(cond, label)
 *   scripts/test-next-settings-scroll-and-scale.js  function ok(cond, label)
 *   scripts/test-next-listbox.js                function ok(cond, label)
 *   scripts/test-next-chat-sidebar.js           function ok(cond, label)
 *
 * Hand this an `ok` of the OTHER shape and every call passes unconditionally,
 * because a non-empty message string is truthy — which is root cause 4
 * reappearing INSIDE the fix for root cause 4. That happened on the first real
 * adoption and was caught only by a mutation, not by review.
 *
 * Use `checkLiteral` unless you have verified your suite's argument order.
 */
export function assertLiteral(ok, literal, actual, message) {
  const v = checkLiteral(literal, actual, message);
  ok(v.pass, v.message);
}
