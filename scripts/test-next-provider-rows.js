/**
 * test-next-provider-rows.js — OFFLINE suite for the /next Settings →
 * "Providers & keys" surface (src/public/next/views/settings.js): both the
 * ROW RENDERER and the SAVE-KEY write path.
 *
 * No network, no API key, no server, no browser. The real, live functions
 * (`renderProviderRow`, `onSaveKey`) and the real `PROVIDER_ROWS` table are
 * extracted from source by brace-matching and executed standalone with
 * `new Function` — the same technique scripts/test-chat-markdown.js uses
 * for the browser Markdown renderer and scripts/test-next-model-fallback.js
 * / -progress-ring.js already use for this exact view and its sibling
 * component.
 *
 * ── THE BUG THIS SUITE EXISTS FOR — TWO SITES, ONE SHAPE ─────────────────
 * `renderProviderRow` used to pick each row's key state with a BINARY
 * ternary:
 *   const hasKeyField = p.id === 'gemini' ? k.geminiApiKey : k.anthropicApiKey;
 *   const hasKey      = p.id === 'gemini' ? k.hasGeminiKey : k.hasAnthropicKey;
 * Two arms, no third. Any row whose id is neither 'gemini' nor 'anthropic'
 * fell into the `else` and rendered ANTHROPIC's masked key + "configured"/
 * "active" state next to that OTHER provider's name — a real
 * misrepresentation on a credentials screen.
 *
 * `onSaveKey` (the Save-button handler) had the identical shape, ONE STEP
 * WORSE — it WRITES:
 *   const body = provider === 'gemini' ? { geminiApiKey: value } : { anthropicApiKey: value };
 * Saving a key for any third provider would have POSTed it under
 * `anthropicApiKey`, silently OVERWRITING the user's real Anthropic
 * credential with a key for a different service — credential corruption,
 * not just a misleading render, on the one screen where users hand us
 * secrets. This is this repo's named failure shape verbatim: fixing the
 * reported (render) case while the worse instance of the same defect
 * (save) stayed armed.
 *
 * Both were latent only because `PROVIDER_ROWS`'s other entries carried
 * `available: false` — the render path returns early for those, and the save
 * path is only reachable through a "Replace" row that `renderProviderRow`
 * only ever renders for an `available` provider. Both arm the moment a third
 * provider is ever flipped `available: true`.
 *
 * ── v3.15.0: THAT MOMENT ARRIVED, AND IT EXPOSED A GAP IN THIS FILE ──────
 * `openrouter` shipped as PROVIDER_ROWS' third `available: true` row, with a
 * real key field and a real save mapping. Two things followed.
 *
 * FIRST, two §5 assertions failed on an EXPIRED PREMISE, not a defect: they
 * pinned "openrouter has no known field mapping -> refuses", which had stopped
 * being true. They are not deleted — the class they protect (a row with no
 * mapping must refuse rather than write into a neighbour's credential field)
 * is still the whole point of this file. It moved to §5b, driven by a
 * SYNTHETIC available row, so it tests the class rather than one id that has
 * since gained a mapping. §5 also gained a COMPLETENESS check: an available
 * row this file has no declared expectation for is now a named failure, where
 * before it silently fell into the "must refuse" branch and asserted the
 * opposite of the truth.
 *
 * SECOND — and this is the part nothing reported — the FIXTURE could not
 * express "openrouter has a saved key". It hardcoded `hasGeminiKey` /
 * `hasAnthropicKey`, so the openrouter row always rendered the empty state and
 * §3's "renders no other provider's mask" passed because it rendered nothing
 * at all. A row reading the WRONG wire field (settings.js:1212 warns in prose
 * about exactly this: the wire carries `hasOpenrouterKey`, lowercase r) would
 * have been invisible. The fixture is now built mechanically from the
 * provider id for every available row, and §3 asserts own-mask-in /
 * every-other-mask-out across the whole table.
 *
 * The fix replaces BOTH ternaries with a lookup table keyed by the
 * provider's own id: `renderProviderRow`'s `KEY_INFO_BY_PROVIDER` resolves
 * an unknown id to `undefined` (safe: "no key configured"); `onSaveKey`'s
 * `SAVE_BODY_KEY_BY_PROVIDER` resolves an unknown id to `undefined` and
 * the function THROWS rather than guessing a field — surfaced to the user
 * as a save error, with zero network request ever issued. Under-saving is
 * recoverable; writing into the wrong provider's slot may not be noticed
 * until that other service starts failing.
 *
 * ── SWEPT FOR MORE INSTANCES OF THIS SHAPE, FOUND NONE ───────────────────
 * The whole file was grepped for `=== 'gemini'`, `=== 'anthropic'`, both
 * operand orders, and every `p.id ===` / `provider ===` / `id ===`
 * conditional, plus every ternary in the file was read by hand. The only
 * other hit is `providerLabel(id)` (an if-chain, not a ternary, used only
 * for DISPLAY text) — it already degrades an unknown id to the id itself
 * (or null), never to "Anthropic", so it is not this defect shape and is
 * left untouched. `onDisconnect`/`onSetActive` post `{ provider }` verbatim
 * with no client-side field-name branching at all — the backend resolves
 * the field, so this shape cannot arise there today.
 *
 * ── WHAT THIS SUITE ASSERTS, AND HOW ─────────────────────────────────────
 * Everything below DRIVES the real, extracted functions — no assertion
 * here greps the source for the word "ternary" or for any other shape of
 * the fix. A test that proves a line of source exists proves nothing about
 * what it does (see CLAUDE.md's v3.0.17 lesson on this exact failure
 * shape) — only running the function proves what it renders or sends.
 *
 * RENDER PATH:
 *   §1 Extraction sanity — PROVIDER_ROWS parses as an array with the shape
 *      the rest of this suite depends on.
 *   §2 Fixture self-check — the two real providers' key-state values in the
 *      test fixture are actually DISTINCT from each other, so a mix-up
 *      between them is observable rather than accidentally masked by two
 *      equal values.
 *   §3 For EVERY row in the REAL, mechanically-enumerated PROVIDER_ROWS
 *      table: an available row renders ONLY its own mask/model/state, and
 *      an unavailable row never leaks any mask at all.
 *   §4 THE CLASS INVARIANT (render) — a provider id that exists NOWHERE in
 *      PROVIDER_ROWS is fed straight to the extracted `renderProviderRow`
 *      with `available: true`, under TWO different synthetic ids (rules
 *      out a fix that merely special-cases one literal string). Both must
 *      render the safe "not set" state and contain NEITHER real
 *      provider's mask/model.
 *
 * SAVE PATH:
 *   §5 For EVERY *available* row in the REAL, mechanically-enumerated
 *      PROVIDER_ROWS table: driving the real, extracted `onSaveKey`
 *      through a stubbed `fetch` proves the request body names THAT
 *      provider's own credential field (gemini/anthropic/openrouter today).
 *      Preceded by a two-way completeness check against this file's own
 *      declared expectations, so neither a new row nor a removed one can
 *      pass silently.
 *  §5b THE CLASS §5 USED TO CARRY — a row that IS in the table and IS
 *      `available` but has NO field mapping must refuse before any fetch.
 *      Driven by two synthetic rows. Distinct from §6: this is the
 *      REACHABLE shape (the row renders a Replace flow), §6 is defence in
 *      depth against ids the table never contained.
 *  §5c The positive half for the new provider, spelled out: openrouter's
 *      body is exactly `{ openrouterApiKey }` and carries neither of the
 *      other two credential fields.
 *   §6 THE CLASS INVARIANT (save) — the same two synthetic, table-absent
 *      ids from §4 are driven directly through `onSaveKey`. Asserts fetch
 *      is never called at all, and — the exact historical corruption
 *      vector — that if it somehow were called, the body would not carry
 *      `anthropicApiKey`.
 *   §7 Harness self-check — the fake `fetch`/`document` capture what a real
 *      save actually sends, proven against the known-good gemini/anthropic
 *      cases before being trusted for the unknown-id cases.
 *  §7b THE POST-RESPONSE HALF OF onSaveKey, which nothing covered. A save the
 *      server ACCEPTED must leave `keysActionError` null, and the activation
 *      verdict must be read from the POST's OWN body.
 *
 *      ── A SILENT FAILURE THIS FILE WAS CARRYING, MEASURED ──────────────
 *      v3.15.0 made `onSaveKey` call `classifyActivationOutcome`. It was not
 *      in this file's extraction list, so the extracted function threw
 *      `ReferenceError: classifyActivationOutcome is not defined` on EVERY
 *      successful save — swallowed by onSaveKey's own `catch`, which set the
 *      user-visible error. This suite reported **139 passed / 0 failed**
 *      throughout, because §5/§5c inspect only the fetch call, which happens
 *      BEFORE the throw. The sibling suite's §0 caught the same class of
 *      staleness LOUDLY; here it was silent, which is worse. Closed by
 *      extracting the real classifier and asserting the absence of the error
 *      state (mutation: removing it again yields 8 named reds).
 *
 * ── ENFORCED ──────────────────────────────────────────────────────────────
 *   - Every entry in the REAL PROVIDER_ROWS table (mechanically enumerated,
 *     never hardcoded) renders only its own key/mask/model via
 *     `renderProviderRow`, and — if available — saves only under its own
 *     credential field via `onSaveKey`.
 *   - An id absent from PROVIDER_ROWS entirely, fed straight to either
 *     function with `available: true`, is safe: the render shows "not
 *     set"/no mask, and the save refuses before touching the network.
 *     Proven under two independent synthetic ids in both halves, so a fix
 *     that special-cases one literal string would still be caught.
 *
 * ── NOT ENFORCED (stated rather than implied) ────────────────────────────
 *   - `onSaveKey` is executed with `document`, `fetch`, `state`, `render`,
 *     `isCurrentMount` and `loadKeys` ALL STUBBED (see makeSaveKeyHarness
 *     below). This proves the field-selection/refusal logic exactly as
 *     shipped, but does NOT exercise: real DOM event wiring for the
 *     Replace-row input, real network behaviour, `render()`'s real
 *     re-paint, or `loadKeys()`'s real re-fetch-and-merge. The MEDIUM-2
 *     "live DOM value beats stale state.replaceValue" precedence is only
 *     exercised against our own controllable fake `document.getElementById`
 *     — not against a real browser input element.
 *   - `onDisconnect`/`onSetActive` are NOT covered here at all. The sweep
 *     above found they post `{ provider }` verbatim with no client-side
 *     field-name branching, so this defect shape cannot arise in them
 *     today — but if that ever changes (e.g. a client-side field name is
 *     added), this suite would not notice.
 *   - The BACKEND's handling of `/api/config/api-keys` — whether
 *     `src/routes/config.js` does anything sane with an unrecognised body
 *     key — is entirely out of scope. This suite is client-side only:
 *     "no field mapping exists" refuses BEFORE any request is sent, so the
 *     backend's behaviour on that input is moot for the bug this guards.
 *   - The "not available" branch's own copy/markup (openai/local today) —
 *     unaffected by this bug and unchanged by the fix; §3 asserts it stays
 *     mask-free as a side effect of full-table coverage, not as its focus.
 *   - Whether `k.hasGeminiKey`/`k.hasAnthropicKey` etc. are computed
 *     correctly by the backend — that is src/routes/config.js's and
 *     scripts/test-chat-model.js's territory.
 *   - Anything about `renderProviders()` (the section wrapper) itself —
 *     it depends on `state.keys`, `icon()`, `renderFallbackBanner()` and
 *     `renderActiveModelLine()` from app.js's shared surface and is not
 *     independently executable from this file without pulling in that
 *     whole rendering stack.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SETTINGS_PATH = path.join(ROOT, 'src/public/next/views/settings.js');
const settings = readFileSync(SETTINGS_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Extract the pure function + the real table from the live source ──────
// Brace-matched, so nested braces in a function body cannot truncate the
// extraction. A missing name THROWS rather than silently testing nothing.
// (Copied from scripts/test-next-progress-ring.js / -model-fallback.js —
// same technique, same file family.)
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in settings.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  // Skip the PARAMETER LIST before hunting for the body brace — a
  // destructured parameter would otherwise latch the brace-matcher onto
  // the parameter pattern and "end" the function at the closing paren.
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
  if (!m) throw new Error(`extractConst: "${name}" not found in settings.js`);
  const extracted = m[0].trim().replace(/^export\s+/, '');
  if (/\bfunction\s/.test(extracted)) {
    throw new Error(`extractConst: "${name}" extraction swallowed a function — the terminator desynced`);
  }
  return extracted;
}

// A minimal, faithful HTML escaper standing in for app.js's shared
// escapeHtml — real enough that none of our fixture values (plain
// alphanumerics with hyphens) are altered by it, so substring assertions
// below reflect renderProviderRow's OWN branching, not an escaping quirk.
function escapeHtmlStub(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// state.replacing / state.keysBusy are the only module-state renderProviderRow
// reads. Passed as a live object reference so tests can flip its fields
// between calls and the sandboxed closure sees the change (same object
// identity, not a snapshot).
const stubState = { replacing: null, keysBusy: null };

// ── THE EXTRACTION MANIFEST, DECLARED AS DATA ─────────────────────────────
// Named lists rather than inline arguments, so §0 below can reason about them
// — and ONE map for the injected bindings, because `new Function(...names,
// body)(...args)` binds POSITIONALLY and a hand-aligned name list beside a
// hand-aligned argument list produces NO ERROR when it slips, just every name
// bound to the wrong value.
// TX_INFO_GLYPH + infoMark: the "no models yet — cannot be active" reason used
// to be a `title=` on a NON-FOCUSABLE <span>, i.e. unreachable by keyboard and
// absent entirely on touch. It is now behind a real button, and that button is
// built by infoMark — so the row path calls it and it must be extracted, not
// stubbed: a stub would prove something about the stub, and this is the one
// place the reason is written anywhere on that row.
const ROW_CONSTS = ['PROVIDER_ROWS', 'TX_INFO_GLYPH'];
const ROW_FN_NAMES = ['infoMark', 'renderProviderRow'];
const ROW_INJECTED = {
  escapeHtml: escapeHtmlStub,
  crossWriteTitle: (msg) => 'cross-write: ' + msg,
  state: stubState,
};
const ROW_INJECTED_NAMES = Object.keys(ROW_INJECTED);

// The SAVE-path sandbox's manifest, declared here beside the row one so §0 can
// see both. `makeSaveKeyHarness` builds from these exact names.
const SAVE_FN_NAMES = ['readSkippedActivation', 'classifyActivationOutcome', 'onSaveKey'];
const SAVE_INJECTED_NAMES = ['document', 'fetch', 'state', 'render', 'isCurrentMount', 'loadKeys'];
/** Set by makeSaveKeyHarness to whatever it ACTUALLY injected; checked in §0b. */
let saveInjectedNamesActual = null;

/**
 * ══ §0  EVERY CALLEE IS PROVIDED — A NAMED FAILURE, NOT A CRASH OR A HUSH ══
 *
 * Both sandboxes below lift functions out of settings.js by a HARDCODED list
 * and execute them with `new Function`. Anything an extracted function calls
 * that is neither extracted nor injected is a free identifier that only
 * explodes at CALL TIME — and in THIS file the explosion is silent.
 *
 * MEASURED, in this very file: v3.15.0 made `onSaveKey` call
 * `classifyActivationOutcome`. It was not in the manifest, so every successful
 * save threw `ReferenceError: classifyActivationOutcome is not defined` —
 * swallowed by onSaveKey's own `catch`, which merely set
 * `state.keysActionError`. This suite reported **139 passed / 0 failed**
 * throughout, because §5/§5c inspect the fetch call, which happens BEFORE the
 * throw. The name was added by hand afterwards; nothing stopped the NEXT one.
 *
 * The sibling suite (test-next-model-picker.js §0) closed this class for its
 * own sandboxes and recorded explicitly that "every other suite in the repo
 * that lifts functions by a hardcoded list has the same blind spot". This is
 * that closure for this file. The scanner is duplicated rather than shared
 * because the two suites have different `extractFunction` signatures and this
 * change may not add a file outside the suites it owns; the duplication is
 * stated rather than hidden.
 *
 * ── ENFORCED ──
 *   • Every function CALLED by an extracted function resolves to something the
 *     sandbox provides (extracted, injected, or a standard global).
 *   • Every manifest entry is a real top-level function in settings.js.
 *   • The injected-name manifest matches what the harness actually injects.
 * ── NOT ENFORCED ──
 *   • Method calls (`a.b()`) — those resolve against a value, not module scope.
 *   • Free identifiers READ but never CALLED (a bare `SOME_CONST`). Both
 *     extracted consts are read-only names and both are in the manifest; a new
 *     one would still crash loudly rather than pass quietly.
 *   • Comment/literal stripping is approximate and errs toward OVER-reporting,
 *     whose cost is one manifest entry.
 */
/** Strip comments and string/template literals so prose cannot read as a call. */
function stripCommentsAndLiterals(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (two === '/*') { i += 2; while (i < src.length && src.slice(i, i + 2) !== '*/') i++; i += 2; continue; }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
      i++;
      out += '""';
      continue;
    }
    out += c; i++;
  }
  return out;
}
/** Every `function NAME(` declared at column 0. */
function topLevelFunctionNames(src) {
  const names = new Set();
  const re = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}
/** Names bound by an `import { a, b as c }` / `import d` statement. */
function importedNames(src) {
  const names = new Set();
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) names.add(m[1]);
    if (m[2]) for (const part of m[2].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(t);
      names.add(as ? as[1] : t);
    }
  }
  return names;
}
const SAFE_GLOBALS = new Set([
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'RegExp',
  'Date', 'Error', 'Set', 'Map', 'Symbol', 'Promise', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'BigInt',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
]);
/** Names a function body binds for itself — params + local declarations. */
function locallyBoundNames(body) {
  const names = new Set();
  const decl = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = decl.exec(body)) !== null) names.add(m[1]);
  const params = /(?:function\s*[A-Za-z_$\w$]*\s*|\)\s*=>|^)?\(([^()]*)\)\s*(?:=>|\{)/g;
  while ((m = params.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  const destr = /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g;
  while ((m = destr.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(':').pop().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  return names;
}
/** Callees of `names` (taken from `src`) that resolve to nothing `provided` has. */
function unresolvedCallees(src, names, provided) {
  const out = [];
  for (const name of names) {
    const body = stripCommentsAndLiterals(extractFunction(src, name));
    const locals = locallyBoundNames(body);
    // ── WHY THIS DOES NOT CONSUME THE PRECEDING CHARACTER ──────────────────
    // The obvious form, `/(^|[^.\w$\\])([A-Za-z_$][\w$]*)\s*\(/g`, EATS the
    // opening paren, so in `if (hasAnyKeyConfigured())` the match for `if (`
    // leaves lastIndex past the paren and the inner callee is never seen.
    // Measured: control 1 below reported "nothing found" against a call that
    // is plainly there. Any callee wrapped in `if (…)`, `while (…)`,
    // `return (…)` or another call was invisible. The identifier is now
    // matched with a LOOKAHEAD for the paren and the preceding character is
    // inspected without being consumed — `.` (member access), `\` (a regex
    // escape such as `/\B(?=…)/`) and a word character (a longer identifier)
    // all disqualify it.
    const callRe = /[A-Za-z_$][\w$]*(?=\s*\()/g;
    let m;
    while ((m = callRe.exec(body)) !== null) {
      const called = m[0];
      const prev = m.index > 0 ? body[m.index - 1] : '';
      if (prev === '.' || prev === '\\' || /[\w$]/.test(prev)) continue;
      if (called === name) continue;
      if (provided.has(called)) continue;
      if (locals.has(called)) continue;
      if (SAFE_GLOBALS.has(called)) continue;
      out.push(`${name}() -> ${called}()`);
    }
  }
  return [...new Set(out)];
}

section('§0  Extraction manifests are COMPLETE (a missing callee is a named failure)');
{
  const topLevel = topLevelFunctionNames(settings);
  ok(topLevel.size > 20,
    `the top-level function scanner sees settings.js's helpers (found ${topLevel.size})`);
  for (const n of [...ROW_FN_NAMES, ...SAVE_FN_NAMES]) {
    ok(topLevel.has(n), `manifest entry "${n}" is a real top-level function in settings.js`);
  }

  const rowProvided  = new Set([...ROW_FN_NAMES, ...ROW_CONSTS, ...ROW_INJECTED_NAMES]);
  const saveProvided = new Set([...SAVE_FN_NAMES, ...SAVE_INJECTED_NAMES]);
  // A RENAMED function makes extractFunction THROW, which would abort the whole
  // file — the very outcome this section exists to convert into a tally entry.
  const unresolved = [];
  for (const [names, provided, which] of [
    [ROW_FN_NAMES, rowProvided, 'row'], [SAVE_FN_NAMES, saveProvided, 'save'],
  ]) {
    try { unresolved.push(...unresolvedCallees(settings, names, provided)); }
    catch (err) { unresolved.push(`${which} manifest: SCAN ABORTED — ${err && err.message}`); }
  }
  ok(unresolved.length === 0,
    'every function an extracted helper calls is itself extracted, injected or a standard global' +
    (unresolved.length
      ? ` — UNRESOLVED: ${unresolved.join(', ')}. Add the callee to ROW_FN_NAMES / SAVE_FN_NAMES if it ` +
        'is a settings.js helper, or to the injected map if the sandbox should supply it. Without this ' +
        'the extracted function throws a ReferenceError at CALL time: on the row path that is a bare ' +
        'crash with no assertion at all, and on the save path onSaveKey\'s own catch SWALLOWS it.'
      : ''));

  // ── POSITIVE CONTROL 1 — the exact regression that produced this section ──
  // Drop classifyActivationOutcome from the save manifest; the detector must
  // NAME onSaveKey as its caller. Proves the guard is not green because it
  // sees nothing.
  {
    const without = SAVE_FN_NAMES.filter((n) => n !== 'classifyActivationOutcome');
    const provided = new Set([...without, ...SAVE_INJECTED_NAMES]);
    const found = unresolvedCallees(settings, without, provided);
    ok(found.some((s) => s.endsWith('-> classifyActivationOutcome()')),
      `control — removing classifyActivationOutcome from the manifest IS detected (${found.join(', ') || 'nothing found'})`);
  }
  // ── POSITIVE CONTROL 2 — a DIFFERENT shape: an INJECTED binding ──────────
  // One control proves the mechanism for one kind of name; two prove it is not
  // keyed to a special case.
  {
    const provided = new Set([
      ...ROW_FN_NAMES, ...ROW_CONSTS,
      ...ROW_INJECTED_NAMES.filter((n) => n !== 'escapeHtml'),
    ]);
    const found = unresolvedCallees(settings, ROW_FN_NAMES, provided);
    ok(found.some((s) => s.endsWith('-> escapeHtml()')),
      `control — an INJECTED callee is visible to the same scanner (${found.join(', ') || 'nothing found'})`);
    // Non-vacuous precondition: escapeHtml really is an IMPORT of settings.js,
    // not a local, so the sandbox genuinely has to supply it.
    ok(importedNames(settings).has('escapeHtml') && !topLevel.has('escapeHtml'),
      'settings.js imports escapeHtml rather than declaring it — so control 2 is the injected-binding path, not an accident of naming');
  }

  // ── POSITIVE CONTROL 3 — THE SHAPE THE OLD REGEX COULD NOT SEE ─────────
  // Synthetic source, so it pins the SCANNER rather than today's settings.js.
  // The previous consuming form matched `if (` and left lastIndex past the
  // paren, making `zzInner`, and everything nested inside another call,
  // invisible. This control fails on that form and passes on the lookahead
  // one; it also proves a METHOD call is still not mistaken for a free
  // identifier.
  {
    const probe = 'function zzProbe(a) {\n  if (zzInner(a)) return zzOuter(zzDeep(a));\n  return a.zzMethod();\n}\n';
    const found = unresolvedCallees(probe, ['zzProbe'], new Set());
    const want = ['zzInner', 'zzOuter', 'zzDeep'];
    ok(want.every((n) => found.includes(`zzProbe() -> ${n}()`)) &&
       !found.some((s) => s.endsWith('-> zzMethod()')),
      `control — a callee nested inside \`if (…)\` or another call IS visible, and a method call is not mistaken for one (${found.join(', ') || 'nothing found'})`);
  }
}

const sandbox = new Function(
  ...ROW_INJECTED_NAMES,
  ROW_CONSTS.map((n) => extractConst(settings, n)).join('\n') + '\n' +
  ROW_FN_NAMES.map((n) => extractFunction(settings, n)).join('\n') + '\n' +
  'return { ' + [...ROW_FN_NAMES, ...ROW_CONSTS].join(', ') + ' };'
)(...ROW_INJECTED_NAMES.map((n) => ROW_INJECTED[n]));

const { renderProviderRow, PROVIDER_ROWS } = sandbox;

// Reset the shared stub state before every call site below so one test's
// mutation (e.g. simulating a Replace-row-open) can never leak into the
// next.
function freshState() { stubState.replacing = null; stubState.keysBusy = null; }

// ── Fixture: one DISTINCT, recognisable key state PER AVAILABLE ROW ───────
// The masks and models are deliberately distinguishable strings (not e.g.
// both "configured") so that a row rendering the WRONG provider's value is
// observable, not accidentally camouflaged by two equal fixtures.
//
// ── WHY THE FIELD NAMES ARE DERIVED, NOT LISTED ──────────────────────────
// This fixture used to hardcode `hasGeminiKey` / `hasAnthropicKey` and
// nothing else. The moment PROVIDER_ROWS gained a third AVAILABLE row
// (openrouter, v3.15.0) that made every §3 assertion about it vacuous: the
// fixture could not express "openrouter has a saved key", so the row always
// rendered the empty state and "renders no other provider's mask" passed
// because it rendered nothing at all.
//
// The wire field names are MECHANICAL — the route derives them from the
// provider id (`has` + Capitalised(id) + `Key`, and id + `ApiKey`), which is
// why the wire carries `hasOpenrouterKey` with a LOWERCASE r. Deriving them
// here from the id, rather than copying settings.js's own lookup tables,
// keeps this file an independent oracle: if a table in settings.js ever
// spells a field differently from the wire, the row silently reads
// `undefined`, renders "not set", and §3 goes RED naming the provider —
// which is precisely the failure settings.js:1212 warns about in prose.
function wireHasField(id) {
  return 'has' + String(id).charAt(0).toUpperCase() + String(id).slice(1) + 'Key';
}
function wireMaskField(id) {
  return String(id) + 'ApiKey';
}
/** Every AVAILABLE row in the real table, mechanically enumerated. */
const AVAILABLE_IDS = PROVIDER_ROWS.filter((p) => p.available).map((p) => p.id);
/** A per-provider mask/model string that cannot be confused with another's. */
const maskFor = (id) => 'mask-' + id + '-AAA111';
const modelFor = (id) => 'model-' + id + '-G1';

function keys(over = {}) {
  const base = { models: {}, activeProvider: AVAILABLE_IDS[0] };
  for (const id of AVAILABLE_IDS) {
    base[wireHasField(id)] = true;
    base[wireMaskField(id)] = maskFor(id);
    base.models[id] = modelFor(id);
  }
  return Object.assign(base, over);
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  Extraction sanity — PROVIDER_ROWS is the real, live table');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(Array.isArray(PROVIDER_ROWS), 'PROVIDER_ROWS extracted as an array');
  ok(PROVIDER_ROWS.length >= 2, `PROVIDER_ROWS has at least 2 entries (found ${PROVIDER_ROWS.length})`);
  for (const p of PROVIDER_ROWS) {
    ok(typeof p.id === 'string' && p.id.length > 0, `entry has a non-empty string id (got ${JSON.stringify(p.id)})`);
    ok(typeof p.available === 'boolean', `entry "${p.id}" has a boolean "available" flag`);
  }
  ok(typeof renderProviderRow === 'function', 'renderProviderRow extracted as a function');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  Fixture self-check — every available provider is distinguishable');
// ═════════════════════════════════════════════════════════════════════════
{
  const k = keys();
  ok(AVAILABLE_IDS.length >= 2,
    `the real table has ${AVAILABLE_IDS.length} AVAILABLE rows (${AVAILABLE_IDS.join(', ')}) — a collapse to 1 would make every cross-provider assertion below vacuous`);
  const masks = AVAILABLE_IDS.map((id) => k[wireMaskField(id)]);
  const models = AVAILABLE_IDS.map((id) => k.models[id]);
  ok(new Set(masks).size === masks.length,
    'control: every mask in the fixture is a different string, so a mix-up is observable');
  ok(new Set(models).size === models.length,
    'control: every model id in the fixture is a different string');
  for (const id of AVAILABLE_IDS) {
    ok(k[wireHasField(id)] === true,
      `control: the fixture can express "${id} has a saved key" (field "${wireHasField(id)}")`);
  }
  // The wire-field convention this fixture depends on, pinned against the
  // three shipping names so a silent rename is caught here rather than as a
  // puzzling "renders nothing" three sections later.
  ok(wireHasField('gemini') === 'hasGeminiKey' && wireMaskField('gemini') === 'geminiApiKey',
    'the derived field convention reproduces the shipping gemini field names');
  ok(wireHasField('openrouter') === 'hasOpenrouterKey' && wireMaskField('openrouter') === 'openrouterApiKey',
    'the derived field convention reproduces hasOpenrouterKey — LOWERCASE r, as the wire carries it');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  Every REAL row renders only its OWN provider\'s state (mechanically enumerated)');
// ═════════════════════════════════════════════════════════════════════════
// NOTE THE SHAPE. This loop deliberately contains no `p.id === 'gemini' ? …`
// of its own: the suite that exists to forbid a binary provider ternary in
// the code under test carried one in its own fixture logic, and that is what
// made a third available provider unobservable here.
{
  const k = keys();
  for (const p of PROVIDER_ROWS) {
    freshState();
    const html = renderProviderRow(p, k, false);
    const allMasks = AVAILABLE_IDS.map(maskFor);

    if (!p.available) {
      ok(allMasks.every((m) => !html.includes(m)),
        `unavailable row "${p.id}": no real provider's mask leaks into its markup`);
      ok(/not available/i.test(html), `unavailable row "${p.id}": rendered as not-available`);
      continue;
    }

    // Every AVAILABLE row must render ITS OWN key state and nobody else's.
    // Before v3.15.0 this branch was only reachable for gemini/anthropic;
    // openrouter now exercises it too, which is the whole point — the class
    // invariant is "each available row shows its own", not "the two we
    // happened to write assertions for show their own".
    ok(html.includes(maskFor(p.id)),
      `row "${p.id}": renders its OWN mask (${maskFor(p.id)}) — read via its own wire field "${wireMaskField(p.id)}"`);
    ok(html.includes(modelFor(p.id)),
      `row "${p.id}": renders its OWN model (${modelFor(p.id)}) — the k.models[p.id] lookup`);
    for (const otherId of AVAILABLE_IDS) {
      if (otherId === p.id) continue;
      ok(!html.includes(maskFor(otherId)),
        `row "${p.id}": does NOT render "${otherId}"'s mask (${maskFor(otherId)}) — the v3.10.1 over-report`);
      ok(!html.includes(modelFor(otherId)),
        `row "${p.id}": does NOT render "${otherId}"'s model (${modelFor(otherId)})`);
    }
  }

  // The other half of the same claim: a row whose key is NOT saved shows the
  // empty state and still borrows nothing. Asserted per available row, so a
  // provider that reads the wrong `has…Key` field (and therefore always looks
  // unset) cannot hide behind the always-saved fixture above.
  for (const p of PROVIDER_ROWS.filter((x) => x.available)) {
    freshState();
    const unset = keys({ [wireHasField(p.id)]: false, [wireMaskField(p.id)]: '' });
    const html = renderProviderRow(p, unset, false);
    ok(html.includes('provider-key-empty'),
      `row "${p.id}" with no saved key: renders the EMPTY key state`);
    for (const otherId of AVAILABLE_IDS) {
      if (otherId === p.id) continue;
      ok(!html.includes(maskFor(otherId)),
        `row "${p.id}" with no saved key: still borrows no mask from "${otherId}"`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§3b  "Set active" is hidden for a provider that has NO measured model');
// ═════════════════════════════════════════════════════════════════════════
// Found while mutation-proving §3, and not previously covered by anything:
// v3.15.0 added `canBuild` to renderProviderRow. With a provider marked
// active that has no default model, `getProviderInfo()` THROWS — and it is
// the single producer of the provider/model pair every `generateText` call
// resolves, so ingest, Health scans and Compile all fail. A one-click "Set
// active" that breaks three features, on a row whose state cell reads
// "configured", is the worst control on this screen.
//
// The gate is `models[p.id]` — a PAYLOAD fact, null exactly when the provider
// has nothing measured — never `p.id === 'openrouter'`. Asserted
// BEHAVIOURALLY on both arms of a SINGLE provider, which no id-keyed
// implementation can satisfy, and then across the whole table.
//
// NOT ENFORCED, and the source says so itself: this is FAIL-OPEN. Hiding a
// control is not a guarantee, only a way to stop the common case — a user can
// still reach the state, because saving a key sets that provider active
// server-side with no click here. The durable fix belongs on the write path.
// This section pins the render half and claims nothing more.
{
  for (const p of PROVIDER_ROWS.filter((x) => x.available)) {
    freshState();
    // Same provider, same key, same everything — only the default model moves.
    const withModel = renderProviderRow(p, keys({ activeProvider: 'none' }), false);
    const noModel = renderProviderRow(
      p, keys({ activeProvider: 'none', models: Object.assign({}, keys().models, { [p.id]: null }) }), false);

    ok(new RegExp('data-set-active="' + p.id + '"').test(withModel),
      `row "${p.id}" WITH a measured default model: offers "Set active"`);
    ok(!new RegExp('data-set-active="' + p.id + '"').test(noModel),
      `row "${p.id}" with NO measured default model: hides "Set active" — activating it would throw in getProviderInfo() and break ingest, Health and Compile`);
    // …and it is still shown as configured, so this is not "the row vanished".
    ok(noModel.includes(maskFor(p.id)),
      `row "${p.id}" with no default model: still shows its saved key — only the dangerous control is withheld`);
  }
  // The empty-string form of the same payload fact (a wire that sends '' for
  // "nothing measured" rather than null) must behave identically.
  {
    const p = PROVIDER_ROWS.find((x) => x.available);
    freshState();
    const blank = renderProviderRow(
      p, keys({ activeProvider: 'none', models: Object.assign({}, keys().models, { [p.id]: '' }) }), false);
    ok(!new RegExp('data-set-active="' + p.id + '"').test(blank),
      `row "${p.id}": an EMPTY-STRING default model is treated as no model, not as a model named ""`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§3c  The "Test this key" control appears only where a FREE key check exists');
// ═════════════════════════════════════════════════════════════════════════
// Also uncovered before this pass. `KEY_TEST_BY_PROVIDER` is a third
// provider-keyed table in this file, and the reason it is not every provider
// is a MONEY reason: OpenRouter publishes an authenticated endpoint that
// returns a key's own limits and spends ZERO tokens, while Gemini and
// Anthropic can only be checked by making a real, billable call. An
// identical-looking button beside all three, where one is free and two cost
// money, would be the worse design. So the asymmetry is deliberate and this
// section pins it in BOTH directions rather than only asserting the button
// exists somewhere.
{
  const TEST_KEY_EXPECTED = new Set(['openrouter']);
  for (const p of PROVIDER_ROWS.filter((x) => x.available)) {
    freshState();
    const html = renderProviderRow(p, keys(), false);
    const has = new RegExp('data-test-key="' + p.id + '"').test(html);
    if (TEST_KEY_EXPECTED.has(p.id)) {
      ok(has, `row "${p.id}": offers "Test this key" — a free, zero-token key check exists for it`);
      ok(/Test this key/.test(html), `row "${p.id}": …and the control is labelled in words a user can act on`);
    } else {
      ok(!has,
        `row "${p.id}": offers NO "Test this key" — the only way to check this provider's key is a BILLABLE call, which belongs behind System Check's cost confirm`);
    }
  }
  // A provider with NO saved key has nothing to test, whatever the table says.
  for (const id of TEST_KEY_EXPECTED) {
    const p = PROVIDER_ROWS.find((x) => x.id === id);
    if (!p) continue;
    freshState();
    const unset = renderProviderRow(p, keys({ [wireHasField(id)]: false, [wireMaskField(id)]: '' }), false);
    ok(!new RegExp('data-test-key="' + id + '"').test(unset),
      `row "${id}" with no saved key: the test control is absent — there is no key to test`);
  }
  // Completeness, both ways, so this section cannot go stale the way §5's
  // premise did: a declared id must be a real available row.
  for (const id of TEST_KEY_EXPECTED) {
    ok(PROVIDER_ROWS.some((p) => p.id === id && p.available),
      `declared test-key provider "${id}" is a real AVAILABLE row (no dead expectation)`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  THE CLASS INVARIANT — an id absent from PROVIDER_ROWS, fed straight in as available:true');
// ═════════════════════════════════════════════════════════════════════════
// PROVIDER_ROWS' real third/fourth entries (openai, local) are gated
// `available: false` and can never reach the code under test through the
// table alone. To prove the fix is a class invariant — "any id this table
// could ever hold is safe" — rather than "gemini and anthropic happen to
// both be handled", renderProviderRow is called DIRECTLY with synthetic
// provider objects the real table does not contain. Two distinct unknown
// ids, so a fix that merely special-cased one literal string would still
// be caught.
{
  const k = keys();
  for (const syntheticId of ['zzz-mystery-provider', 'openai-pro-max']) {
    freshState();
    const synthetic = { id: syntheticId, name: 'Synthetic Provider', dot: '#000', available: true };
    const html = renderProviderRow(synthetic, k, false);

    for (const realId of AVAILABLE_IDS) {
      ok(!html.includes(maskFor(realId)),
        `unknown id "${syntheticId}": does NOT render "${realId}"'s mask (${maskFor(realId)})${realId === 'anthropic' ? ' — the historical over-report' : ''}`);
      ok(!html.includes(modelFor(realId)),
        `unknown id "${syntheticId}": does NOT render "${realId}"'s model id`);
    }
    ok(html.includes('provider-key-empty'), `unknown id "${syntheticId}": key field renders in the EMPTY state`);
    ok(/>Not set<\/code>/.test(html), `unknown id "${syntheticId}": key field text reads "Not set"`);
    ok(/provider-state[^"]*">not set</.test(html), `unknown id "${syntheticId}": status text reads "not set", not "configured" or "active"`);
    ok(!/data-disconnect="/.test(html), `unknown id "${syntheticId}": no Disconnect button renders (no key to disconnect)`);
    ok(!/data-set-active="/.test(html), `unknown id "${syntheticId}": no Set-active button renders (no key to activate)`);
  }

  // Adversarial variant: the backend claims this unknown id is the ACTIVE
  // provider. isActive can still legitimately read true (that's a
  // backend-trust question, out of this bug's scope) — but even then the
  // row must not borrow another provider's MASK. This is the sharpest form
  // of the historical bug: the row would have shown "active" state dressed
  // in Anthropic's key.
  freshState();
  const activeUnknown = { id: 'zzz-mystery-provider', name: 'Synthetic Provider', dot: '#000', available: true };
  const htmlActive = renderProviderRow(activeUnknown, keys({ activeProvider: 'zzz-mystery-provider' }), false);
  ok(AVAILABLE_IDS.every((id) => !htmlActive.includes(maskFor(id))),
    'unknown id claimed as activeProvider: still renders no real provider\'s mask');
}

// ── Save-path harness ──────────────────────────────────────────────────────
// onSaveKey is entangled with document/fetch/state/render/isCurrentMount/
// loadKeys — all free identifiers in its body. Rather than isolate a
// smaller unit (which would mean testing our OWN extraction of the fix
// instead of the shipped function), every one of those is stubbed and
// passed in as a `new Function` parameter, so the REAL, unmodified
// `onSaveKey` runs to completion and we observe exactly what it would have
// sent over the network. See the ENFORCED/NOT ENFORCED block above for
// precisely what this does and does not prove.
function makeSaveKeyHarness() {
  const domRegistry = Object.create(null);
  let lastFetchCall = null;
  let fetchResponse = { ok: true, jsonBody: {} };

  const fakeDocument = {
    getElementById: (id) => (id in domRegistry ? domRegistry[id] : null),
  };
  const fakeFetch = async (url, init) => {
    lastFetchCall = {
      url,
      method: init && init.method,
      // JSON.parse here (not just storing the raw string) so assertions
      // compare STRUCTURE, immune to key-ordering differences between
      // `{ [bodyKey]: value }` and a hand-written object literal.
      body: init && init.body !== undefined ? JSON.parse(init.body) : undefined,
    };
    return { ok: fetchResponse.ok, json: async () => fetchResponse.jsonBody };
  };
  const fakeState = {
    replaceValue: '', keysBusy: null, keysActionError: null, replacing: 'placeholder',
    // v3.15.0 — onSaveKey writes its activation verdict here.
    keysActivationNotice: null,
  };
  const fakeRender = () => {};
  const fakeIsCurrentMount = () => true;
  const fakeLoadKeys = async () => {};

  // ── ONE MAP, name to value ────────────────────────────────────────────
  // `new Function(...names, body)(...args)` binds POSITIONALLY, so a name
  // list and a separate argument list must stay index-aligned by hand — and
  // a misalignment produces NO ERROR, just every name bound to the wrong
  // value. Deriving both from one object literal makes that inexpressible.
  const INJECTED = {
    document: fakeDocument,
    fetch: fakeFetch,
    state: fakeState,
    render: fakeRender,
    isCurrentMount: fakeIsCurrentMount,
    loadKeys: fakeLoadKeys,
  };
  // ── EXTRACTED, NOT STUBBED, AND THE REASON IS A MEASUREMENT ───────────
  // v3.15.0 made `onSaveKey` call `classifyActivationOutcome` after a
  // successful save. It was not in this sandbox, so the extracted function
  // threw `ReferenceError: classifyActivationOutcome is not defined` on
  // EVERY successful save — caught by onSaveKey's own `catch`, which set
  // `state.keysActionError`. This suite reported **139 passed / 0 failed**
  // throughout, because §5/§5c only inspect the fetch call, which happens
  // BEFORE the throw. Measured, not inferred; §7b now asserts the absence of
  // that error state so the condition can never be silent again.
  //
  // This is the same blind spot the sibling suite's §0 exists for — a
  // hardcoded extraction list going stale — in its QUIET form. There, a
  // missing name crashed loudly. Here it was swallowed.
  // Declared at module scope (SAVE_FN_NAMES) so §0's completeness guard can
  // reason about the same list this sandbox actually builds from.
  const FNS = SAVE_FN_NAMES;
  const names = Object.keys(INJECTED);
  // The guard scans SAVE_INJECTED_NAMES; if the two ever diverge it would be
  // scanning a manifest nothing builds from, which is the failure it exists to
  // prevent wearing a different hat.
  saveInjectedNamesActual = names;
  const sandbox = new Function(
    ...names,
    FNS.map((n) => extractFunction(settings, n)).join('\n') + '\n' +
    'return { ' + FNS.join(', ') + ' };'
  )(...names.map((n) => INJECTED[n]));

  return {
    onSaveKey: sandbox.onSaveKey,
    setInputValue: (provider, value) => { domRegistry['replace-input-' + provider] = { value }; },
    setFetchResponse: (r) => { fetchResponse = r; },
    getLastFetchCall: () => lastFetchCall,
    state: fakeState,
  };
}

/**
 * THIS FILE'S OWN STATEMENT of what each available provider must save under —
 * an independent oracle, deliberately NOT read out of settings.js's
 * `SAVE_BODY_KEY_BY_PROVIDER`. Deriving the expectation from the table under
 * test would make §5 tautological ("onSaveKey uses its own table").
 *
 * ── THE STALE PREMISE THIS REPLACES, AND THE INVARIANT IT MUST NOT LOSE ───
 * Until v3.15.0 this map held gemini + anthropic only, and §5 took any row
 * missing from it as "no field mapping — must refuse". `openrouter` then
 * landed in PROVIDER_ROWS as `available: true` WITH a mapping, and two
 * assertions went red on an expired premise rather than on a defect.
 *
 * The invariant those two assertions protect is still vital and is NOT
 * deleted: it is the v3.10.1 credential-overwrite class — a provider row
 * with no field mapping must REFUSE rather than fall through into another
 * provider's credential field, silently overwriting a real key with one for
 * a different service. It moves to §5b below, driven by a SYNTHETIC row, so
 * it keeps testing the class instead of one id that has since gained a
 * mapping.
 */
const SAVE_FIELD_BY_PROVIDER = {
  gemini: 'geminiApiKey',
  anthropic: 'anthropicApiKey',
  openrouter: 'openrouterApiKey',
};
/**
 * Available ids this file deliberately expects to have NO mapping yet. Empty
 * today. A row lands here only as a recorded decision, never by omission —
 * see the completeness assertion at the top of §5.
 */
const SAVE_FIELD_NOT_WIRED_YET = new Set();

// ═════════════════════════════════════════════════════════════════════════
section('§5  SAVE PATH — every AVAILABLE real row saves under its OWN field');
// ═════════════════════════════════════════════════════════════════════════
{
  // COMPLETENESS FIRST. A new available row that this file has no declared
  // expectation for used to fall silently into the "must refuse" branch and
  // assert the opposite of the truth. Now it is a NAMED failure telling the
  // maintainer to declare the expectation, in either direction.
  for (const p of PROVIDER_ROWS.filter((x) => x.available)) {
    ok(Object.prototype.hasOwnProperty.call(SAVE_FIELD_BY_PROVIDER, p.id)
       || SAVE_FIELD_NOT_WIRED_YET.has(p.id),
      `available row "${p.id}": this suite declares an expectation for it ` +
      `(add it to SAVE_FIELD_BY_PROVIDER, or to SAVE_FIELD_NOT_WIRED_YET if it genuinely has no credential field yet)`);
  }
  // …and the reverse, so a provider removed from the table leaves no dead
  // expectation quietly claiming coverage it no longer has.
  for (const id of Object.keys(SAVE_FIELD_BY_PROVIDER)) {
    ok(PROVIDER_ROWS.some((p) => p.id === id && p.available),
      `declared expectation "${id}" corresponds to a real AVAILABLE row (no dead entry)`);
  }

  for (const p of PROVIDER_ROWS) {
    if (!p.available) continue; // onSaveKey is only reachable through an available row's Replace flow
    const h = makeSaveKeyHarness();
    const testValue = 'value-for-' + p.id + '-9f3a';
    h.setInputValue(p.id, testValue);

    const expectedField = SAVE_FIELD_BY_PROVIDER[p.id];
    // onSaveKey is async and its `try` awaits `fetch` — this MUST be
    // awaited (top-level await; this file is an ES module) before reading
    // the harness's captured call, or the assertions below would run
    // before onSaveKey's promise settles and — worse — before the final
    // Passed/Failed tally at the bottom of this file, silently under-
    // counting every §5-§7 assertion. Confirmed by construction, not by
    // luck: every `ok()` call in these three sections sits after an
    // `await`.
    await h.onSaveKey(p.id, 'tok');
    const call = h.getLastFetchCall();
    if (expectedField) {
      ok(call !== null, `available row "${p.id}": a save issues exactly one fetch call`);
      if (call) {
        ok(Object.keys(call.body || {}).length === 1 && call.body[expectedField] === testValue,
          `available row "${p.id}": the request body names its OWN field "${expectedField}" and nothing else (got ${JSON.stringify(call.body)})`);
        for (const otherField of Object.values(SAVE_FIELD_BY_PROVIDER)) {
          if (otherField === expectedField) continue;
          ok(!(otherField in (call.body || {})),
            `available row "${p.id}": the request body does NOT carry the other provider's field "${otherField}"`);
        }
      }
    } else {
      // An available id this suite has DECLARED as not-yet-wired (empty set
      // today). Must refuse, not guess.
      ok(call === null, `available row "${p.id}" declared not-yet-wired: refuses BEFORE any fetch call (no field to guess)`);
      ok(typeof h.state.keysActionError === 'string' && h.state.keysActionError.includes(p.id),
        `available row "${p.id}" declared not-yet-wired: the refusal error names the provider (got ${JSON.stringify(h.state.keysActionError)})`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§5b  THE INVARIANT §5 USED TO CARRY — an AVAILABLE row with no field mapping REFUSES');
// ═════════════════════════════════════════════════════════════════════════
// Re-pointed from `openrouter` (which gained a mapping in v3.15.0) onto a
// synthetic row, so the CLASS keeps being tested rather than the one id that
// happened to be unmapped when the assertion was written.
//
// This is a DIFFERENT case from §6's. §6 drives ids that are absent from
// PROVIDER_ROWS altogether — unreachable through the UI, so it is defence in
// depth. Here the row IS in the table and IS `available`, which is exactly
// the reachable shape: renderProviderRow gives it a Replace flow, the user
// types a key, and onSaveKey must refuse rather than write it into some other
// provider's credential slot. That is the v3.10.1 corruption vector, and it
// arms the moment anyone adds a provider row without its field mapping.
{
  for (const syntheticId of ['zzz-future-provider', 'openai']) {
    const row = { id: syntheticId, name: 'Synthetic ' + syntheticId, dot: '#000', available: true };
    // Precondition, so this section cannot pass because the id secretly IS
    // mapped: it must be absent from BOTH the real table and our expectations.
    ok(!PROVIDER_ROWS.some((p) => p.id === syntheticId),
      `§5b precondition: "${syntheticId}" is genuinely absent from the real PROVIDER_ROWS table`);

    // It renders as a normal available row (i.e. the save path is reachable).
    freshState();
    const html = renderProviderRow(row, keys(), false);
    ok(!/not available/i.test(html),
      `"${syntheticId}": an available:true row renders as available — the Replace/save flow is REACHABLE, so the refusal below matters`);

    const h = makeSaveKeyHarness();
    const secret = 'sk-secret-for-' + syntheticId;
    h.setInputValue(syntheticId, secret);
    await h.onSaveKey(syntheticId, 'tok');
    const call = h.getLastFetchCall();

    ok(call === null,
      `"${syntheticId}": an AVAILABLE row with no field mapping refuses BEFORE any fetch — it does not guess a field`);
    for (const field of Object.values(SAVE_FIELD_BY_PROVIDER)) {
      ok(!call || !(field in (call.body || {})),
        `"${syntheticId}": nothing was written into "${field}" — the credential-overwrite vector stays closed`);
    }
    ok(typeof h.state.keysActionError === 'string' && h.state.keysActionError.includes(syntheticId),
      `"${syntheticId}": the refusal is SURFACED and names the provider (got ${JSON.stringify(h.state.keysActionError)})`);
    ok(typeof h.state.keysActionError === 'string' && !h.state.keysActionError.includes(secret),
      `"${syntheticId}": …and the refusal message does not echo the secret the user typed`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§5c  OPENROUTER saves under openrouterApiKey, and under nothing else');
// ═════════════════════════════════════════════════════════════════════════
// The positive half of the repointed premise, spelled out rather than left
// implicit in §5's generic loop: this is the assertion that would go red if
// the new provider were ever wired to a neighbour's credential field.
{
  const h = makeSaveKeyHarness();
  // DELIBERATELY NOT KEY-SHAPED. An earlier draft used a realistic
  // 'sk-or-v1-…' literal, which the repo's pre-commit secret guard correctly
  // BLOCKS. Allow-listing our own fixture would train the next person to
  // allow-list, which is the habit that guard exists to prevent — and this
  // assertion is about which FIELD the value lands in, never about its shape.
  const secret = 'FIXTURE-VALUE-FOR-OPENROUTER-9f3a';
  h.setInputValue('openrouter', secret);
  await h.onSaveKey('openrouter', 'tok');
  const call = h.getLastFetchCall();
  ok(call !== null, 'openrouter: a save issues exactly one fetch call');
  ok(call && call.url === '/api/config/api-keys' && call.method === 'POST',
    'openrouter: it POSTs to the shared credential endpoint, not a bespoke one');
  ok(call && JSON.stringify(call.body) === JSON.stringify({ openrouterApiKey: secret }),
    `openrouter: the body is EXACTLY { openrouterApiKey } and nothing else (got ${JSON.stringify(call && call.body)})`);
  ok(call && !('anthropicApiKey' in (call.body || {})),
    'openrouter: the body does NOT carry anthropicApiKey — the historical over-write field');
  ok(call && !('geminiApiKey' in (call.body || {})),
    'openrouter: the body does NOT carry geminiApiKey either');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  THE CLASS INVARIANT (save) — an id absent from PROVIDER_ROWS never reaches fetch, never names anthropicApiKey');
// ═════════════════════════════════════════════════════════════════════════
// Same rationale as §4: PROVIDER_ROWS' real unknown-shaped entries are all
// `available: false` and can never reach onSaveKey through the table
// alone (there is no Replace button to click), so onSaveKey is driven
// DIRECTLY with ids the real table does not contain. This is the
// assertion that would have caught the reported bug: it does not merely
// check "no fetch happened" (which a crash could also produce) — it also
// asserts what the OLD code would have sent if it HAD gone through, so a
// regression is named precisely rather than just detected.
{
  for (const syntheticId of ['zzz-mystery-provider', 'openai-pro-max']) {
    const h = makeSaveKeyHarness();
    const testValue = 'leaked-value-for-' + syntheticId;
    h.setInputValue(syntheticId, testValue);

    await h.onSaveKey(syntheticId, 'tok');
    const call = h.getLastFetchCall();
    ok(call === null, `unknown id "${syntheticId}": onSaveKey never calls fetch — refused before any network request`);
    // Defence in depth: even if some future change let a call through,
    // this pins that it must never be the historical corruption vector.
    ok(!call || !('anthropicApiKey' in (call.body || {})),
      `unknown id "${syntheticId}": if a request were ever sent, it must not carry anthropicApiKey (the historical over-write)`);
    ok(typeof h.state.keysActionError === 'string' && h.state.keysActionError.length > 0,
      `unknown id "${syntheticId}": onSaveKey surfaces a save error rather than silently no-op'ing`);
    // Deliberately re-checks the type here rather than trusting the assertion
    // above: a regression that makes onSaveKey silently succeed for an
    // unknown id (keysActionError stays null) must fail this assertion
    // CLEANLY — never crash the suite with a null-dereference TypeError,
    // which would abort every assertion after it and misreport the tally.
    ok(typeof h.state.keysActionError === 'string' && h.state.keysActionError.includes(syntheticId),
      `unknown id "${syntheticId}": the surfaced error names the actual provider id (got ${JSON.stringify(h.state.keysActionError)})`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  Harness self-check — the fake fetch/document capture what a real save sends');
// ═════════════════════════════════════════════════════════════════════════
// A stubbed fetch that is wired wrong could make §5/§6 pass vacuously (e.g.
// if getLastFetchCall() always returned null regardless of whether fetch
// ran). This proves the harness DOES observe a real call, using the
// known-good gemini/anthropic paths as a positive control.
{
  const h = makeSaveKeyHarness();
  h.setInputValue('gemini', 'harness-control-value');
  await h.onSaveKey('gemini', 'tok');
  const call = h.getLastFetchCall();
  ok(call !== null, 'positive control: a gemini save IS observed by the harness (fetch was actually called)');
  ok(call && call.url === '/api/config/api-keys', 'positive control: the observed call targets the real endpoint');
  ok(call && call.method === 'POST', 'positive control: the observed call is a POST');
  ok(call && JSON.stringify(call.body) === JSON.stringify({ geminiApiKey: 'harness-control-value' }),
    'positive control: the observed body matches exactly what onSaveKey should send for gemini');

  // A DOM value must actually reach onSaveKey through document.getElementById
  // — i.e. the harness's `setInputValue` is not a no-op that onSaveKey
  // silently ignores in favour of state.replaceValue.
  const h2 = makeSaveKeyHarness();
  h2.state.replaceValue = 'stale-state-value-should-NOT-be-sent';
  h2.setInputValue('anthropic', 'live-dom-value-should-be-sent');
  await h2.onSaveKey('anthropic', 'tok');
  const call2 = h2.getLastFetchCall();
  ok(call2 && call2.body && call2.body.anthropicApiKey === 'live-dom-value-should-be-sent',
    'positive control: the live DOM input value wins over stale state.replaceValue (MEDIUM-2 precedence), proving setInputValue is wired through');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7b  A SUCCESSFUL SAVE LEAVES NO ERROR — and reports why the Active row moved or did not');
// ═════════════════════════════════════════════════════════════════════════
// TWO things, and the first is the one that was silently broken.
//
// (1) `state.keysActionError` must be null after a save the server ACCEPTED.
//     Nothing asserted that, so when onSaveKey gained a call this sandbox did
//     not provide, every successful save threw a swallowed ReferenceError,
//     set an error the user would have seen, and this suite stayed 139/0
//     green. §5's assertions all inspect the fetch call, which happens before
//     the throw — so the whole post-response half of onSaveKey was untested.
//
// (2) The activation verdict is computed from the POST's OWN response body,
//     not from state after the refetch. That is deliberate in the source: the
//     verdict and the `activeProvider` it is judged against then come from the
//     same reply, so a concurrent write landing between the two requests
//     cannot make them disagree. Asserted by giving the POST a body the
//     refetch never sees.
{
  const P = AVAILABLE_IDS[0];
  const OTHER = AVAILABLE_IDS.find((id) => id !== P);

  // (1) The plain, happy save.
  {
    const h = makeSaveKeyHarness();
    h.setInputValue(P, 'value');
    h.setFetchResponse({ ok: true, jsonBody: { activeProvider: P, skippedActivation: [] } });
    await h.onSaveKey(P, 'tok');
    ok(h.state.keysActionError === null,
      `a SUCCESSFUL save leaves keysActionError null (got ${JSON.stringify(h.state.keysActionError)}) — this is the assertion whose absence hid a swallowed ReferenceError`);
    ok(h.state.keysActivationNotice === null,
      'and an empty skippedActivation records NO notice — a normal save stays quiet');
    ok(h.state.keysBusy === null && h.state.replacing === null,
      'and the row is left idle rather than stuck mid-save');
    ok(h.state.replaceValue === '',
      'and the typed secret does not linger in state past a successful save');
  }

  // (1b) A REFUSED save still surfaces the server's error — so the assertion
  //      above is about "no spurious error", not about errors never appearing.
  {
    const h = makeSaveKeyHarness();
    h.setInputValue(P, 'value');
    h.setFetchResponse({ ok: false, jsonBody: { error: 'the server said no' } });
    await h.onSaveKey(P, 'tok');
    ok(h.state.keysActionError === 'the server said no',
      'control: a REFUSED save DOES surface the server\'s message, so §7b is not passing because errors are never recorded');
  }

  // (2) The verdict comes from the POST body.
  {
    const h = makeSaveKeyHarness();
    h.setInputValue(P, 'value');
    h.setFetchResponse({
      ok: true,
      jsonBody: { activeProvider: OTHER, skippedActivation: [{ provider: P, reason: 'no_build_model' }] },
    });
    await h.onSaveKey(P, 'tok');
    ok(h.state.keysActionError === null,
      'a save the server accepted but did NOT activate is still not an error — the key was saved');
    const v = h.state.keysActivationNotice;
    ok(v && v.kind === 'skipped',
      `the skippedActivation the POST reported is recorded as a verdict (got ${JSON.stringify(v && v.kind)})`);
    ok(v && Array.isArray(v.entries) && v.entries.some((e) => e.provider === P),
      'and it names the provider whose key was just saved');
  }

  // (2b) ABSENT field + the response's own activeProvider showing the row did
  //      not move -> the "unreported" arm, end to end through the real handler.
  {
    const h = makeSaveKeyHarness();
    h.setInputValue(P, 'value');
    h.setFetchResponse({ ok: true, jsonBody: { activeProvider: OTHER } });
    await h.onSaveKey(P, 'tok');
    const v = h.state.keysActivationNotice;
    ok(v && v.kind === 'unreported' && v.provider === P,
      `an ABSENT skippedActivation with a non-matching activeProvider records "unreported" for the saved provider (got ${JSON.stringify(v)})`);
  }

  // (2c) An UNPARSEABLE body must never be re-thrown as a failed save: the
  //      server already stored the key, and reporting a lost key it actually
  //      holds is worse than the silence this whole surface exists to remove.
  {
    const h = makeSaveKeyHarness();
    h.setInputValue(P, 'value');
    // The harness's `json()` returns `fetchResponse.jsonBody`, so a THROWING
    // GETTER is what makes `await res.json()` reject — verified to reject with
    // a SyntaxError, i.e. this fixture is not vacuously fine.
    h.setFetchResponse({ ok: true, get jsonBody() { throw new SyntaxError("Unexpected token '<'"); } });
    await h.onSaveKey(P, 'tok');
    ok(h.state.keysActionError === null,
      'an UNPARSEABLE success body is NOT reported as a failed save — the key was stored, and claiming otherwise would be worse than saying nothing');
    ok(h.state.keysActivationNotice === null,
      'and it records no verdict, because a body we could not read tells us nothing');
  }
}

// ── §0b  THE MANIFEST §0 SCANNED IS THE ONE THE HARNESS BUILT FROM ────────
// Runs LAST, because it observes what makeSaveKeyHarness actually injected.
// Without it, §0 could be scanning a stale name list while the harness injects
// a different set — a completeness guard checking a manifest nothing uses,
// which is the same defect wearing a different hat.
section('§0b  The scanned injected-name manifest matches what the harness injects');
{
  ok(Array.isArray(saveInjectedNamesActual),
    'makeSaveKeyHarness ran during this suite, so its injected names were observable (otherwise §0 covers the save path only in theory)');
  ok(Array.isArray(saveInjectedNamesActual) &&
     saveInjectedNamesActual.slice().sort().join(',') === SAVE_INJECTED_NAMES.slice().sort().join(','),
    `SAVE_INJECTED_NAMES is exactly what the save sandbox injects (declared: ${SAVE_INJECTED_NAMES.join(', ')} | actual: ${(saveInjectedNamesActual || []).join(', ')})`);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All /next provider-row assertions green');
