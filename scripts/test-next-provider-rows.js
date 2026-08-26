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
 * Both were latent only because `PROVIDER_ROWS`'s other two entries
 * (openai, local) carry `available: false` — the render path returns early
 * for those, and the save path is only reachable through a "Replace" row
 * that `renderProviderRow` only ever renders for an `available` provider.
 * Both arm the moment a third provider is ever flipped `available: true`.
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
 *      provider's own credential field (gemini/anthropic today), or — for
 *      an available id with no known field — that `onSaveKey` REFUSES
 *      before any `fetch` call and surfaces an error naming the provider.
 *   §6 THE CLASS INVARIANT (save) — the same two synthetic, table-absent
 *      ids from §4 are driven directly through `onSaveKey`. Asserts fetch
 *      is never called at all, and — the exact historical corruption
 *      vector — that if it somehow were called, the body would not carry
 *      `anthropicApiKey`.
 *   §7 Harness self-check — the fake `fetch`/`document` capture what a real
 *      save actually sends, proven against the known-good gemini/anthropic
 *      cases before being trusted for the unknown-id cases.
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

const sandbox = new Function(
  'escapeHtml', 'crossWriteTitle', 'state',
  extractConst(settings, 'PROVIDER_ROWS') + '\n' +
  extractFunction(settings, 'renderProviderRow') + '\n' +
  'return { renderProviderRow, PROVIDER_ROWS };'
)(
  escapeHtmlStub,
  (msg) => 'cross-write: ' + msg,
  stubState
);

const { renderProviderRow, PROVIDER_ROWS } = sandbox;

// Reset the shared stub state before every call site below so one test's
// mutation (e.g. simulating a Replace-row-open) can never leak into the
// next.
function freshState() { stubState.replacing = null; stubState.keysBusy = null; }

// ── Fixture: two DISTINCT, recognisable key states ────────────────────────
// The masks and models are deliberately distinguishable strings (not e.g.
// both "configured") so that a row rendering the WRONG provider's value is
// observable, not accidentally camouflaged by two equal fixtures.
function keys(over = {}) {
  return Object.assign({
    hasGeminiKey: true,
    geminiApiKey: 'gem-mask-AAA111',
    hasAnthropicKey: true,
    anthropicApiKey: 'ant-mask-BBB222',
    models: { gemini: 'gemini-model-G1', anthropic: 'anthropic-model-A1' },
    activeProvider: 'gemini',
  }, over);
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
section('§2  Fixture self-check — the two known providers are distinguishable');
// ═════════════════════════════════════════════════════════════════════════
{
  const k = keys();
  ok(k.geminiApiKey !== k.anthropicApiKey, 'control: the two masks in the fixture are different strings');
  ok(k.models.gemini !== k.models.anthropic, 'control: the two model ids in the fixture are different strings');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  Every REAL row renders only its OWN provider\'s state (mechanically enumerated)');
// ═════════════════════════════════════════════════════════════════════════
{
  const k = keys();
  for (const p of PROVIDER_ROWS) {
    freshState();
    const html = renderProviderRow(p, k, false);

    if (!p.available) {
      ok(!html.includes(k.geminiApiKey) && !html.includes(k.anthropicApiKey),
        `unavailable row "${p.id}": no real provider's mask leaks into its markup`);
      ok(/not available/i.test(html), `unavailable row "${p.id}": rendered as not-available`);
      continue;
    }

    if (p.id === 'gemini' || p.id === 'anthropic') {
      const ownMask = p.id === 'gemini' ? k.geminiApiKey : k.anthropicApiKey;
      const otherMask = p.id === 'gemini' ? k.anthropicApiKey : k.geminiApiKey;
      const ownModel = p.id === 'gemini' ? k.models.gemini : k.models.anthropic;
      const otherModel = p.id === 'gemini' ? k.models.anthropic : k.models.gemini;
      ok(html.includes(ownMask), `row "${p.id}": renders its OWN mask (${ownMask})`);
      ok(!html.includes(otherMask), `row "${p.id}": does NOT render the other provider's mask (${otherMask})`);
      ok(html.includes(ownModel), `row "${p.id}": renders its OWN model (${ownModel}) — line 1078's k.models[p.id] lookup`);
      ok(!html.includes(otherModel), `row "${p.id}": does NOT render the other provider's model (${otherModel})`);
    } else {
      // A future available-but-unknown-to-the-fixture real row (should
      // never happen given today's table, but §3 walks the table
      // mechanically rather than assuming exactly {gemini, anthropic}).
      ok(!html.includes(k.geminiApiKey) && !html.includes(k.anthropicApiKey),
        `available row "${p.id}" with no matching key-state field renders no other provider's mask`);
    }
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

    ok(!html.includes(k.geminiApiKey),
      `unknown id "${syntheticId}": does NOT render Gemini's mask (${k.geminiApiKey})`);
    ok(!html.includes(k.anthropicApiKey),
      `unknown id "${syntheticId}": does NOT render Anthropic's mask (${k.anthropicApiKey}) — the historical over-report`);
    ok(!html.includes(k.models.gemini) && !html.includes(k.models.anthropic),
      `unknown id "${syntheticId}": does NOT render either real provider's model id`);
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
  ok(!htmlActive.includes(k.geminiApiKey) && !htmlActive.includes(k.anthropicApiKey),
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
  const fakeState = { replaceValue: '', keysBusy: null, keysActionError: null, replacing: 'placeholder' };
  const fakeRender = () => {};
  const fakeIsCurrentMount = () => true;
  const fakeLoadKeys = async () => {};

  const sandbox = new Function(
    'document', 'fetch', 'state', 'render', 'isCurrentMount', 'loadKeys',
    extractFunction(settings, 'onSaveKey') + '\n' +
    'return { onSaveKey };'
  )(fakeDocument, fakeFetch, fakeState, fakeRender, fakeIsCurrentMount, fakeLoadKeys);

  return {
    onSaveKey: sandbox.onSaveKey,
    setInputValue: (provider, value) => { domRegistry['replace-input-' + provider] = { value }; },
    setFetchResponse: (r) => { fetchResponse = r; },
    getLastFetchCall: () => lastFetchCall,
    state: fakeState,
  };
}

const SAVE_FIELD_BY_PROVIDER = { gemini: 'geminiApiKey', anthropic: 'anthropicApiKey' };

// ═════════════════════════════════════════════════════════════════════════
section('§5  SAVE PATH — every AVAILABLE real row saves under its OWN field, or refuses');
// ═════════════════════════════════════════════════════════════════════════
{
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
      // An available id with no known field mapping (e.g. a future
      // provider with a working Replace flow but no wired credential
      // field yet) — must refuse, not guess.
      ok(call === null, `available row "${p.id}" has no known field mapping: refuses BEFORE any fetch call (no field to guess)`);
      ok(typeof h.state.keysActionError === 'string' && h.state.keysActionError.includes(p.id),
        `available row "${p.id}" has no known field mapping: the refusal error names the provider (got ${JSON.stringify(h.state.keysActionError)})`);
    }
  }
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

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All /next provider-row assertions green');
