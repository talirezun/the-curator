/**
 * test-next-model-picker.js — OFFLINE suite for the /next Settings →
 * "Providers & keys" MODEL LIST (src/public/next/views/settings.js).
 *
 * No network, no API key, no server, no browser. The real, live render
 * functions are extracted from source by brace-matching and executed
 * standalone with `new Function` — the same technique
 * scripts/test-next-provider-rows.js uses on this very file, and
 * scripts/test-chat-markdown.js uses on the browser Markdown renderer. The
 * real `escapeHtml` is extracted from app.js and the real `formatUsdHonest`
 * is IMPORTED, so the escaping and money assertions below exercise the
 * shipping implementations rather than stand-ins for them.
 *
 * ── WHAT IS AT STAKE ─────────────────────────────────────────────────────
 * The offerable catalogue spans 50x on input and 62x on output between its
 * cheapest and dearest entries. A user reading this list is making a
 * spending decision on their own API key, so the list has exactly three
 * jobs and this suite exists to keep it doing all three:
 *
 *   1. Show the price that is billed TODAY. `standardInput`/`standardOutput`
 *      are the POST-promotion figures — for `gemini-3.7-flash` and
 *      `gemini-3.6-flash` they are double what the user currently pays.
 *      Rendering them as the price would overstate the bill by 2x; the
 *      symmetric mistake (showing a promo as permanent) understates it by
 *      2x from 2027-01-01. Both are covered.
 *   2. Show the MEASURED reason for every flagged model. `suitability` and
 *      `dominated` are verdicts; `note` is the evidence. A badge with no
 *      evidence is an opinion the user cannot check.
 *   3. Never appear for a provider whose key was Disconnected in Settings —
 *      v3.0.13's rule, which exists because a user Disconnected a key and
 *      the app carried on using it.
 *
 * ── ENUMERATED FROM THE REAL CATALOGUE, NEVER A HARDCODED LIST ───────────
 * Every per-model assertion walks `OFFERABLE_MODELS` imported from
 * src/brain/llm.js, JSON round-tripped so the `input`/`output` GETTERS are
 * resolved exactly as `src/routes/config.js` serialises them to the wire. A
 * hardcoded model list is how guards in this repo have gone blind before
 * (v3.9.1: a broken-link corpus whose reject side never reached the region
 * where the formula was wrong). Adding a model to llm.js therefore extends
 * this suite automatically; it cannot be forgotten.
 *
 * ── DATE-PROOF, DELIBERATELY ─────────────────────────────────────────────
 * The two real promotions expire on 2026-12-31. A suite that asserted
 * "at least one real entry renders a price rise" would go red on
 * 2027-01-01 for a correct app. So the promo FLOOR is pinned on a synthetic
 * entry that is always mid-promotion, while the real catalogue is asserted
 * CONDITIONALLY (whichever real entries are mid-promotion right now must
 * render their rise) and the count is printed. The expired branch — promo
 * metadata still present, live price already equal to standard, therefore
 * NO rise announced — is asserted on its own synthetic entry, so both sides
 * of the boundary are exercised today rather than one side plus a comment.
 *
 * ── THE SHAPE: TWO LEVELS OF <details>, BOTH COLLAPSED ───────────────────
 * A flat list of 14 model cards measured 3,938px — 4.6 screens — and the
 * maintainer's report was the scroll. So: one COLLAPSED section per provider,
 * and inside it one COLLAPSED row per model.
 *
 * What is on the collapsed SECTION header answers the common question
 * without an expand: provider, the model actually in force, and the count.
 * What is on a collapsed model ROW is everything a SPENDING decision needs:
 * name, id, the price billed today, the promotional rise, every badge. Only
 * the measured NOTE — the argument for a badge already on screen — is behind
 * the row's own expand, and the row itself is that control, so there is no
 * separate affordance to miss.
 *
 * Native <details>, following views/domains.js's Health .dm-group precedent,
 * so keyboard operation and screen-reader announcement come for free. NEITHER
 * summary carries an interactive control: an element inside <summary> toggles
 * the section when clicked (v3.0.1-beta.18 — Health's "Fix all" needed
 * preventDefault + stopPropagation for exactly this), and §14 asserts the
 * hazard is closed by construction rather than by remembering to call it.
 *
 * That property became LOAD-BEARING when the list gained a control. The pick
 * button is a SIBLING of each row's disclosure inside the <li>, never a child
 * of its <summary> — so there is no propagation path to suppress and none
 * that a later edit can forget to suppress. §24 asserts both halves: no
 * interactive element inside any <summary>, AND the control genuinely exists
 * outside one (otherwise the first half passes vacuously on a list that has
 * no control at all).
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *   - A provider with no SAVED key renders NO list at all, for every entry
 *     in the REAL PROVIDER_ROWS table (§2), and an id absent from that
 *     table entirely renders nothing and leaks no other provider's
 *     catalogue (§8, the class invariant).
 *   - Every section, and every model row inside it, is COLLAPSED on a fresh
 *     mount — asserted through the REAL renderProviders (§16), not through
 *     renderModelPicker alone. See the next block for why that distinction
 *     is the most important thing in this file.
 *   - The collapsed section header names the provider, the model in force
 *     and the available count, and carries no interactive control (§14).
 *   - Exactly one section per keyed provider, enumerated from the real
 *     catalogue; an available:false row contributes none (§15).
 *   - Every entry in the REAL catalogue renders its own headline price, and
 *     that price is built from the LIVE `input`/`output` — proven sharply
 *     on the promoted entries, whose headline price must NOT equal their
 *     standard price (§3).
 *   - Every entry with `suitability !== 'general'` OR `dominated: true`
 *     renders its `note` verbatim and carries a flag badge (§4).
 *   - A mid-promotion entry names the standard price it rises to and the
 *     date it rises on; an expired promotion names no rise (§5).
 *   - Hostile `label`/`id`/`note`/`suitability` values are escaped through
 *     the REAL app.js escapeHtml — no raw tag survives into the markup (§6).
 *   - Rendered order is the DELIVERED order, per provider (§7).
 *   - The default model, and only it, is badged as in use (§9).
 *   - `formatIsoDay` is timezone-independent (§10) — it is run under three
 *     forced TZ offsets in-process to prove the date cannot slip a day.
 *
 * ── ENFORCED: THE PICKER (§17-§28) ───────────────────────────────────────
 * The list became a PICKER once POST /api/config/api-keys/model landed. The
 * real `onPickModel` is extracted and executed against an injected fetch, and
 * the markup it produces is rendered from the SAME state object — so these
 * are assertions about what a user sees after a click, not about source text.
 *   - A pick POSTs { provider, model } to /api/config/api-keys/model, and
 *     refetches the payload on success rather than trusting the echo (§17).
 *   - THE MONEY ASSERTION: the clicked model is NOT shown as the choice
 *     while the request is in flight, and never at all if it fails. Measured
 *     by rendering DURING the request; the previous choice is still the one
 *     badged, and the clicked row says "Saving…" instead (§18).
 *   - A 400 renders the server's own actionable wording, refetches nothing,
 *     and leaves the standing selection exactly where it was (§19).
 *   - A 409 says a write operation is running, NAMES it, and states the
 *     model did not change — asserted on the rendered TEXT, not merely on
 *     "some error appeared". A 409 with an unreadable body still explains
 *     itself rather than surfacing a JSON parse error (§20).
 *   - The collapsed header names the PERSISTED pick and marks it as the
 *     user's own, distinctly from an unpinned default, and moves when a save
 *     confirms (§21).
 *   - "in use", "your choice" and "cheapest" are three separate markers and
 *     all three appear together on a row that is all three (§22).
 *   - A provider with no SAVED key exposes no control, and the handler
 *     refuses an unknown provider without issuing a request (§23).
 *   - No interactive element inside any <summary>; the control is a sibling
 *     of the disclosure (§24).
 *   - A running write disables every pick control, with a reason (§25) —
 *     the SECOND layer; the 409 in §20 is the guarantee.
 *   - Clearing back to the app default uses the SAME endpoint with an empty
 *     model, never a second write path (§26).
 *   - A pick resolving on a stale mount writes nothing and paints nothing
 *     (§27) — the v3.2.0 class, on a handler that spends.
 *   - CLASS INVARIANT: no `provider === 'gemini' ? … : …` anywhere in the
 *     pick path, and a third provider fails closed rather than onto a
 *     neighbour's slot (§28). test-next-provider-rows.js is FUNCTION-scoped
 *     (it extracts renderProviderRow and onSaveKey), so that shape
 *     reappearing in a NEW function leaves it 61/0 green.
 *
 * ── A MUTATION THAT STAYED GREEN, AND WHAT IT COST ───────────────────────
 * Replacing the call site's `state.modelPickerOpen[p.id] === true` with a
 * literal `true` forces every section open for every user — the maintainer's
 * exact complaint, reintroduced — and this suite reported 200/0 GREEN. Every
 * openness assertion drove `renderModelPicker` DIRECTLY and passed its third
 * argument itself, so none of them could see the wrapper that chooses that
 * argument. The fix was not another source grep (that proves a line exists,
 * not what it does): `renderProviders` is now extracted and EXECUTED against
 * real state in §16, with the sibling renderers stubbed. The same mutation
 * now fails 4 assertions.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *   - THE SERVER SIDE OF PERSISTENCE. `fetch` is injected, so nothing here
 *     proves that `setSelectedModel` writes, that `guardConcurrent` actually
 *     produces the 409 this suite feeds itself, or that `isOfferableModel`
 *     gates the 400. Those are `scripts/test-selected-model.js`'s and
 *     `scripts/test-route-write-guards.js`'s territory. What IS proven here
 *     is the half a user experiences: the request that goes out, and what
 *     the screen says about each answer that comes back.
 *   - THE WIRING. §17-§28 call `onPickModel` directly. That the click
 *     listeners are attached to `[data-pick-model]` / `[data-pick-clear]` is
 *     not executed — `wireProviderListeners` needs a real DOM. The controls'
 *     `data-` attributes ARE asserted (§17, §26), so a renamed attribute
 *     goes red on one side; a listener deleted outright would not.
 *   - The earlier claim that persistence was impossible is GONE, and §11
 *     is what forced it: it pinned the words "not wired up yet", so the
 *     four assertions went red the moment the endpoint landed rather than
 *     leaving a stale falsehood standing on a screen about money.
 *   - The route's own gating (a provider with no saved key receives
 *     `offerable: []`) — that is `src/routes/config.js`'s and
 *     `scripts/test-offerable-models-route.js`'s territory. This suite
 *     proves the SECOND, client-side layer holds on its own, i.e. that the
 *     list would still not render even if the route sent a catalogue for a
 *     disconnected provider.
 *   - Real CSS layout, real `<details>` behaviour, real browser rendering.
 *     Verified separately in a live browser; this suite only reads markup.
 *   - `renderProviders()` IS executed here, but with `crossWriteBusy`,
 *     `renderCrossWriteBanner`, `renderFallbackBanner`,
 *     `renderActiveModelLine`, `gatedLoader` and `icon` all STUBBED. So the
 *     openness decision, the key gate and the attachment order are proven;
 *     the cross-write disable path, the fallback banner and the loading gate
 *     are not — those belong to their own suites.
 *   - OpenRouter and a local runtime are the maintainer's next two tracks
 *     and are NOT built. §15 proves the shape admits them (a new provider is
 *     a data change) and proves it FAILS CLOSED until its key flag is added —
 *     it does not prove the eventual integration works.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';
import { OFFERABLE_MODELS } from '../src/brain/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SETTINGS_PATH = path.join(ROOT, 'src/public/next/views/settings.js');
const APP_PATH = path.join(ROOT, 'src/public/next/app.js');
const settings = readFileSync(SETTINGS_PATH, 'utf8');
const appJs = readFileSync(APP_PATH, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction (technique copied from test-next-provider-rows.js) ─────────
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
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
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction desynced (no top-level closing brace)`);
  }
  return extracted;
}

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

// The module state renderProviders and renderProviderRow read. A live object
// reference, so a test can flip a field between calls and the sandboxed
// closure sees the change (same identity, not a snapshot).
const stubState = {
  keys: null, keysError: null, keysActionError: null,
  replacing: null, keysBusy: null,
  modelPickerOpen: {},
  // The picker's own two fields. Same live-object rule: onPickModel (executed
  // in the SECOND sandbox below) mutates these, and renderModelPicker in the
  // FIRST sandbox reads them off the same identity — so §17-§21 can drive the
  // real handler and then inspect the real markup it produced.
  modelPickBusy: null,
  modelPickError: {},
};

// The REAL escapeHtml, lifted out of the shell rather than re-implemented.
// §6's whole claim is "the shipping escaper handles this input"; a local
// stand-in would prove something about the stand-in instead.
const sandbox = new Function(
  'formatUsdHonest', 'icon', 'state', 'crossWriteBusy', 'crossWriteTitle',
  'renderCrossWriteBanner', 'renderFallbackBanner', 'renderActiveModelLine',
  'gatedLoader', 'loadGate',
  extractFunction(appJs, 'escapeHtml', 'app.js') + '\n' +
  extractConst(settings, 'PROVIDER_ROWS') + '\n' +
  extractConst(settings, 'MODEL_SUITABILITY_BADGES') + '\n' +
  extractFunction(settings, 'formatIsoDay', 'settings.js') + '\n' +
  extractFunction(settings, 'formatTokenCount', 'settings.js') + '\n' +
  extractFunction(settings, 'formatModelPrice', 'settings.js') + '\n' +
  extractFunction(settings, 'renderModelPickerScope', 'settings.js') + '\n' +
  extractFunction(settings, 'renderModelOption', 'settings.js') + '\n' +
  extractFunction(settings, 'renderModelPicker', 'settings.js') + '\n' +
  // The REAL section wrapper and the REAL row renderer. renderProviders is
  // what DECIDES whether a section is open — see §16 — so grepping its call
  // site would prove a line exists, not what it does.
  extractFunction(settings, 'renderProviderRow', 'settings.js') + '\n' +
  extractFunction(settings, 'renderProviders', 'settings.js') + '\n' +
  'return { escapeHtml, PROVIDER_ROWS, MODEL_SUITABILITY_BADGES, formatIsoDay, ' +
  'formatTokenCount, formatModelPrice, renderModelPickerScope, renderModelOption, ' +
  'renderModelPicker, renderProviders };'
)(
  formatUsdHonest,
  (name, size) => '<svg data-icon="' + name + '" width="' + size + '"></svg>',
  stubState,
  () => false,                       // crossWriteBusy — no write in flight
  (msg) => 'cross-write: ' + msg,
  () => '',                          // renderCrossWriteBanner
  () => '',                          // renderFallbackBanner
  () => '',                          // renderActiveModelLine
  () => '<LOADER/>',                 // gatedLoader
  null,                              // loadGate
);

const {
  escapeHtml, PROVIDER_ROWS, formatIsoDay, formatTokenCount,
  formatModelPrice, renderModelPicker, renderModelOption, renderProviders,
} = sandbox;

// ── The real catalogue, exactly as the wire carries it ────────────────────
// JSON round-trip resolves llm.js's `input`/`output` getters into plain
// numbers, which is precisely what src/routes/config.js serialises.
const WIRE = JSON.parse(JSON.stringify(OFFERABLE_MODELS));
const PROVIDERS = Object.keys(WIRE);

/** Full key payload for a provider that HAS a saved key. */
function keysFor(provider, over = {}) {
  return Object.assign({
    hasGeminiKey: provider === 'gemini',
    hasAnthropicKey: provider === 'anthropic',
    geminiApiKey: provider === 'gemini' ? 'gem-mask-AAA111' : '',
    anthropicApiKey: provider === 'anthropic' ? 'ant-mask-BBB222' : '',
    models: { gemini: WIRE.gemini[0].id, anthropic: WIRE.anthropic[0].id },
    activeProvider: provider,
    offerable: WIRE,
  }, over);
}
function rowFor(provider) {
  const found = PROVIDER_ROWS.find((p) => p.id === provider);
  return found || { id: provider, name: provider, available: true };
}
/** Slice out one model's <li>. Returns '' when the model is absent. */
function liFor(html, id) {
  const needle = '<li class="model-option';
  let from = 0;
  for (;;) {
    const s = html.indexOf(needle, from);
    if (s === -1) return '';
    const e = html.indexOf('</li>', s);
    if (e === -1) return '';
    const li = html.slice(s, e + 5);
    if (li.includes('data-model-id="' + escapeHtml(String(id)) + '"')) return li;
    from = e + 5;
  }
}
/** The headline price text of one <li> — NOT the promo "rises to" clause. */
function headlinePrice(li) {
  const m = /<span class="mono model-price">([\s\S]*?)<span class="model-price-unit">/.exec(li);
  return m ? m[1] : null;
}
const idsInOrder = (html) =>
  [...html.matchAll(/data-model-id="([^"]*)"/g)].map((m) => m[1]);

// ═════════════════════════════════════════════════════════════════════════
section('§1  Extraction sanity + the real catalogue is non-trivial');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(typeof renderModelPicker === 'function', 'renderModelPicker extracted as a function');
  ok(typeof renderModelOption === 'function', 'renderModelOption extracted as a function');
  ok(Array.isArray(PROVIDER_ROWS) && PROVIDER_ROWS.length >= 2,
    `PROVIDER_ROWS extracted (${PROVIDER_ROWS.length} entries)`);
  ok(escapeHtml('<x>') === '&lt;x&gt;', 'the REAL app.js escapeHtml was extracted and works');
  ok(PROVIDERS.length >= 2, `the real catalogue covers ${PROVIDERS.length} providers`);
  let total = 0;
  for (const prov of PROVIDERS) {
    ok(Array.isArray(WIRE[prov]) && WIRE[prov].length > 0,
      `catalogue for "${prov}" is a non-empty array (${WIRE[prov].length} models)`);
    total += WIRE[prov].length;
  }
  ok(total >= 8, `enumerating ${total} real models — a collapse to a handful would silently weaken every loop below`);
  for (const prov of PROVIDERS) {
    for (const m of WIRE[prov]) {
      ok(typeof m.input === 'number' && typeof m.output === 'number',
        `"${m.id}" arrived on the wire with numeric input/output (getters resolved by JSON)`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  A provider with NO saved key renders NO list (M3)');
// ═════════════════════════════════════════════════════════════════════════
{
  for (const p of PROVIDER_ROWS) {
    // Full catalogue present, every key flag false — i.e. even if the route
    // wrongly sent a catalogue for a Disconnected provider, nothing shows.
    const noKeys = {
      hasGeminiKey: false, hasAnthropicKey: false,
      models: { gemini: WIRE.gemini[0].id, anthropic: WIRE.anthropic[0].id },
      offerable: WIRE,
    };
    const html = renderModelPicker(p, noKeys);
    ok(html === '', `"${p.id}": no saved key -> renders nothing at all`);
  }
  for (const prov of PROVIDERS) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    ok(html.length > 0, `control: "${prov}" WITH a saved key does render a list (the §2 gate is not vacuous)`);
    // The other provider has no key in this fixture and must stay hidden.
    const other = PROVIDERS.find((q) => q !== prov);
    const otherHtml = renderModelPicker(rowFor(other), keysFor(prov));
    ok(otherHtml === '', `"${other}" stays hidden while only "${prov}" holds a key`);
  }
  ok(renderModelPicker(rowFor('gemini'), keysFor('gemini', { offerable: {} })) === '',
    'a saved key but an EMPTY catalogue renders nothing (no empty disclosure)');
  ok(renderModelPicker(rowFor('gemini'), keysFor('gemini', { offerable: undefined })) === '',
    'a saved key but NO offerable field at all renders nothing (older backend degrades cleanly)');
  const unavailableRow = PROVIDER_ROWS.find((p) => !p.available);
  if (unavailableRow) {
    ok(renderModelPicker(unavailableRow, keysFor('gemini', { hasGeminiKey: true })) === '',
      `an available:false row ("${unavailableRow.id}") renders nothing`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  Every model renders its OWN, LIVE price — never the standard one (M1)');
// ═════════════════════════════════════════════════════════════════════════
{
  let promoted = 0;
  for (const prov of PROVIDERS) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    for (const m of WIRE[prov]) {
      const li = liFor(html, m.id);
      ok(li !== '', `"${m.id}": has its own row`);
      const price = headlinePrice(li);
      const expectLive = escapeHtml(formatModelPrice(m.input, m.output));
      ok(price === expectLive,
        `"${m.id}": headline price is the LIVE figure (${expectLive})`);

      const liveDiffersFromStandard =
        m.input !== m.standardInput || m.output !== m.standardOutput;
      if (liveDiffersFromStandard) {
        promoted++;
        const standard = escapeHtml(formatModelPrice(m.standardInput, m.standardOutput));
        // THE SHARP ONE. For a promoted model the two strings differ, so
        // rendering standardInput/standardOutput as the price is directly
        // observable here — this is the assertion mutation M1 trips.
        ok(price !== standard,
          `"${m.id}": headline price is NOT standardInput/standardOutput (${standard}) — it is mid-promotion`);
      }
    }
  }
  ok(promoted > 0 || true,
    `fixture note: ${promoted} real model(s) are mid-promotion right now (0 is legitimate after 2026-12-31 — §5 pins the floor synthetically)`);
  // A control proving these assertions CAN fail: a deliberately wrong price
  // must not appear anywhere in a rendered list.
  const g = renderModelPicker(rowFor('gemini'), keysFor('gemini'));
  ok(!g.includes('$999.99'), 'control: a price nobody publishes does not appear (the price assertions are not vacuous)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  Every FLAGGED model shows its measured note, verbatim (M2)');
// ═════════════════════════════════════════════════════════════════════════
{
  let flagged = 0, general = 0;
  for (const prov of PROVIDERS) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    for (const m of WIRE[prov]) {
      const li = liFor(html, m.id);
      const isFlagged = m.suitability !== 'general' || m.dominated === true;
      if (!isFlagged) { general++; continue; }
      flagged++;
      ok(li.includes(escapeHtml(m.note)),
        `"${m.id}" (${m.suitability}${m.dominated ? ', dominated' : ''}): renders its note VERBATIM`);
      ok(li.includes('model-badge-flag'),
        `"${m.id}": carries a flag badge, so the note has something to explain`);
    }
  }
  ok(flagged >= 4, `${flagged} flagged models enumerated — a collapse to 0 would make §4 vacuous`);
  ok(general >= 2, `${general} 'general' models present — the corpus contains BOTH kinds, so §4 is discriminating`);
  // A flagged model with an EMPTY note must not fabricate one.
  const blank = Object.assign({}, WIRE.gemini[0], { id: 'x-blank', suitability: 'caution', note: '   ' });
  ok(!renderModelOption(blank, 1, '').includes('model-note'),
    'a flagged model with a blank note renders no note element rather than an empty box');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  A promotion names the rise; an EXPIRED promotion does not (M5)');
// ═════════════════════════════════════════════════════════════════════════
{
  // Synthetic and always mid-promotion, so this floor is date-proof.
  const midPromo = {
    id: 'synthetic-promo', provider: 'gemini', label: 'Synthetic Promo',
    maxOutput: 65536, thinks: false, jsonRaw: true, tokenizerFactor: 1,
    suitability: 'caution', note: 'A synthetic entry used to pin the promotion branch.',
    input: 0.75, output: 3.75,
    standardInput: 1.5, standardOutput: 7.5,
    promotionUntilIso: '2026-12-31', standardPriceFromIso: '2027-01-01',
    dominated: false,
  };
  const li = renderModelOption(midPromo, 1, '');
  ok(headlinePrice(li) === escapeHtml(formatModelPrice(0.75, 3.75)),
    'mid-promotion: the headline price is the promotional figure');
  ok(li.includes('rises to'), 'mid-promotion: the rise is announced');
  ok(li.includes(escapeHtml(formatModelPrice(1.5, 7.5))),
    'mid-promotion: the STANDARD price it rises to is named');
  ok(li.includes('1 Jan 2027'), 'mid-promotion: the date it rises on is named, readably');
  ok(li.includes('model-promo'), 'mid-promotion: the rise has its own element to style as a warning');

  // Same entry after the promotion lapses: metadata still present, live
  // price already equal to standard. There is no rise left to warn about.
  const expired = Object.assign({}, midPromo, { id: 'synthetic-expired', input: 1.5, output: 7.5 });
  const li2 = renderModelOption(expired, 1, '');
  ok(!li2.includes('rises to'),
    'expired promotion: no rise is announced (the price change already happened)');
  ok(headlinePrice(li2) === escapeHtml(formatModelPrice(1.5, 7.5)),
    'expired promotion: the headline price is the standard figure, which is now the live one');

  // A model with no promotion at all never mentions one.
  const plain = Object.assign({}, midPromo, {
    id: 'synthetic-plain', input: 2, output: 10, standardInput: 2, standardOutput: 10,
    promotionUntilIso: null, standardPriceFromIso: null,
  });
  ok(!renderModelOption(plain, 1, '').includes('rises to'),
    'an unpromoted model never mentions a rise');

  // And every REAL entry that is mid-promotion right now must announce it.
  let realActive = 0;
  for (const prov of PROVIDERS) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    for (const m of WIRE[prov]) {
      if (m.input === m.standardInput && m.output === m.standardOutput) continue;
      realActive++;
      const rli = liFor(html, m.id);
      ok(rli.includes('rises to') && rli.includes(escapeHtml(formatModelPrice(m.standardInput, m.standardOutput))),
        `real mid-promotion model "${m.id}": names the price it rises to`);
      if (m.standardPriceFromIso) {
        ok(rli.includes(escapeHtml(formatIsoDay(m.standardPriceFromIso))),
          `real mid-promotion model "${m.id}": names the date it rises on`);
      }
    }
  }
  console.log(`     (${realActive} real model(s) mid-promotion at this run's clock)`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  Hostile model fields are escaped through the REAL escapeHtml (M4)');
// ═════════════════════════════════════════════════════════════════════════
{
  const XSS = '<script>alert(1)</script>';
  const ATTR = '" onmouseover="alert(2)';
  const hostile = {
    id: 'evil-id' + ATTR,
    provider: 'gemini',
    label: XSS + ' Label',
    maxOutput: 1000,
    thinks: true,
    jsonRaw: false,
    tokenizerFactor: 1.5,
    suitability: 'caution',
    note: 'A note containing ' + XSS + ' and a quote " and an ampersand & and <b>bold</b>.',
    input: 1, output: 2, standardInput: 1, standardOutput: 2,
    promotionUntilIso: null, standardPriceFromIso: null, dominated: true,
  };
  const li = renderModelOption(hostile, 1, '');
  ok(!li.includes('<script>'), 'no raw <script> tag survives into the markup');
  ok(!li.includes('</script>'), 'no raw closing </script> tag survives either');
  ok(!li.includes('<b>bold</b>'), 'no raw markup from the note survives');
  ok(li.includes('&lt;script&gt;'), 'the hostile label/note is present in ESCAPED form (not merely dropped)');
  // NOTE THE SHAPE OF THIS ASSERTION. An earlier draft stripped `&quot;`
  // before testing — which un-escapes the payload and then reports the
  // un-escaped result as a failure. The property that actually matters is
  // that no attribute is opened with a LIVE quote: the breakout characters
  // may (and must) still be present as entities inside the value.
  ok(!li.includes('onmouseover="'),
    'the attribute-breakout attempt in the id opens no live event attribute');
  ok(li.includes('&quot; onmouseover=&quot;'),
    '…because its quotes are neutralised as entities INSIDE data-model-id, not stripped');
  ok(li.includes('&quot;'), 'the double quote from the id is escaped');

  // Same treatment through the full picker, so the wrapper cannot re-introduce
  // an unescaped path around the row renderer.
  const k = keysFor('gemini', { offerable: { gemini: [hostile], anthropic: [] } });
  const full = renderModelPicker(rowFor('gemini'), k);
  ok(full.length > 0 && !full.includes('<script>'),
    'the same hostile entry rendered through renderModelPicker is also escaped');

  // A hostile SUITABILITY must not reach the badge table's output raw.
  const evilSuit = Object.assign({}, hostile, { id: 'evil-suit', suitability: XSS });
  const li3 = renderModelOption(evilSuit, 1, '');
  ok(!li3.includes('<script>'), 'an unknown/hostile suitability value cannot inject markup');

  // Control: a benign label is NOT mangled, so §6 is not passing because
  // everything is being stripped.
  const benign = Object.assign({}, hostile, { id: 'benign', label: 'Flash Lite 2.5', note: 'Plain note.' });
  ok(renderModelOption(benign, 1, '').includes('Flash Lite 2.5'),
    'control: a benign label renders unchanged (escaping is not blanket removal)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  Rendered order is the DELIVERED order (cheapest first)');
// ═════════════════════════════════════════════════════════════════════════
{
  for (const prov of PROVIDERS) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    const rendered = idsInOrder(html);
    const delivered = WIRE[prov].map((m) => escapeHtml(m.id));
    ok(rendered.length === delivered.length,
      `"${prov}": every delivered model is rendered (${rendered.length}/${delivered.length})`);
    ok(rendered.join('|') === delivered.join('|'),
      `"${prov}": rendered in delivered order, unsorted by this view`);
  }
  // Control: the delivered order is actually cheapest-first, so §7 is
  // asserting something the user cares about and not just "unchanged".
  for (const prov of PROVIDERS) {
    const first = WIRE[prov][0], last = WIRE[prov][WIRE[prov].length - 1];
    ok(first.standardInput <= last.standardInput,
      `"${prov}": the delivered order really is cheapest-first (${first.id} <= ${last.id} on input)`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  CLASS INVARIANT — an id absent from PROVIDER_ROWS renders nothing');
// ═════════════════════════════════════════════════════════════════════════
// The binary `p.id === 'gemini' ? A : B` shape made renderProviderRow show
// ANTHROPIC's masked key beside a third provider's name (v3.10.1). That
// suite's coverage is FUNCTION-scoped, so it cannot see the shape
// reappearing in this NEW function. Two distinct synthetic ids, so a fix
// that special-cased one literal string would still be caught here.
{
  for (const fakeId of ['mistral', 'zzz-provider']) {
    const row = { id: fakeId, name: 'Synthetic ' + fakeId, dot: '#000', available: true };
    // Both real keys saved AND a catalogue published under the fake id —
    // the most permissive input this function can be handed.
    const k = {
      hasGeminiKey: true, hasAnthropicKey: true,
      geminiApiKey: 'gem-mask-AAA111', anthropicApiKey: 'ant-mask-BBB222',
      models: { gemini: WIRE.gemini[0].id, anthropic: WIRE.anthropic[0].id },
      offerable: Object.assign({}, WIRE, { [fakeId]: WIRE.anthropic }),
    };
    const html = renderModelPicker(row, k);
    ok(html === '', `unknown provider "${fakeId}": renders nothing (no key mapping -> fails safe)`);
    for (const m of WIRE.anthropic) {
      ok(!html.includes(m.id), `unknown provider "${fakeId}": does not leak Anthropic's model "${m.id}"`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  The default model, and only it, is badged as in use');
// ═════════════════════════════════════════════════════════════════════════
{
  for (const prov of PROVIDERS) {
    const defaultId = WIRE[prov][0].id;
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    const badged = WIRE[prov].filter((m) => liFor(html, m.id).includes('model-badge-default'));
    ok(badged.length === 1, `"${prov}": exactly one model is badged as in use (got ${badged.length})`);
    ok(badged[0] && badged[0].id === defaultId,
      `"${prov}": the badged model is the one the app runs (${defaultId})`);
    ok(liFor(html, defaultId).includes('model-option-default'),
      `"${prov}": the in-use row carries its own class for styling`);
  }
  // A non-first default (e.g. after DEFAULTS is bumped) still badges correctly
  // and does NOT claim to be the cheapest.
  const second = WIRE.gemini[1];
  const html2 = renderModelPicker(rowFor('gemini'),
    keysFor('gemini', { models: { gemini: second.id, anthropic: WIRE.anthropic[0].id } }));
  const li2 = liFor(html2, second.id);
  ok(li2.includes('model-badge-default'), 'a non-first default is still badged as in use');
  ok(!li2.includes('model-badge-cheapest'), 'and it does NOT claim to be the cheapest');
  ok(liFor(html2, WIRE.gemini[0].id).includes('model-badge-cheapest'),
    'while the genuinely cheapest model is still labelled cheapest');
  // A default naming a model that is not offerable badges nothing, rather
  // than badging an arbitrary row.
  const html3 = renderModelPicker(rowFor('gemini'),
    keysFor('gemini', { models: { gemini: 'gemini-not-in-the-catalogue', anthropic: '' } }));
  ok(!html3.includes('model-badge-default'),
    'an unrecognised default (e.g. an LLM_MODEL dev override) badges nothing rather than guessing');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10  Helpers: dates cannot slip a day, counts cannot slip a locale');
// ═════════════════════════════════════════════════════════════════════════
{
  // The failure this guards: `new Date('2027-01-01').toLocaleDateString()`
  // reads the ISO string as UTC midnight and renders it in the viewer's
  // zone, telling anyone west of Greenwich the price rises on 31 Dec 2026.
  const savedTz = process.env.TZ;
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    process.env.TZ = tz;
    ok(formatIsoDay('2027-01-01') === '1 Jan 2027', `formatIsoDay is stable under TZ=${tz}`);
  }
  if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;

  ok(formatIsoDay('2026-12-31') === '31 Dec 2026', 'formatIsoDay renders a year-end date');
  ok(formatIsoDay('not-a-date') === 'not-a-date', 'formatIsoDay returns unparseable input verbatim, inventing nothing');
  ok(formatIsoDay(null) === '', 'formatIsoDay tolerates a null');
  ok(formatIsoDay('2026-13-01') === '2026-13-01', 'formatIsoDay refuses an impossible month rather than wrapping it');

  ok(formatTokenCount(128000) === '128,000', 'formatTokenCount groups thousands');
  ok(formatTokenCount(64000) === '64,000', 'formatTokenCount groups a 5-digit count');
  ok(formatTokenCount(999) === '999', 'formatTokenCount leaves a 3-digit count alone');
  ok(formatTokenCount(null) === '', 'formatTokenCount tolerates a null');

  ok(formatModelPrice(0.1, 0.4) === '$0.10 in · $0.40 out', 'formatModelPrice reads as money, both sides labelled');
  ok(formatModelPrice(null, 0.4) === '', 'formatModelPrice renders nothing when half the price is missing');
  ok(formatModelPrice(0.4, undefined) === '', 'formatModelPrice renders nothing when the other half is missing');

  // Facts that carry cost consequences are surfaced.
  const thinker = WIRE.anthropic.find((m) => m.thinks) || WIRE.gemini.find((m) => m.thinks);
  if (thinker) {
    const li = renderModelOption(thinker, 1, '');
    ok(/thinks/.test(li), `"${thinker.id}": hidden reasoning spend is stated (it is billed as output)`);
  }
  const premium = [...WIRE.anthropic, ...WIRE.gemini].find((m) => m.tokenizerFactor > 1);
  if (premium) {
    const li = renderModelOption(premium, 1, '');
    ok(li.includes(premium.tokenizerFactor.toFixed(2) + '×'),
      `"${premium.id}": the tokenizer premium is stated (${premium.tokenizerFactor}× input tokens)`);
  }
  const capped = WIRE.anthropic[0];
  ok(renderModelOption(capped, 1, '').includes(formatTokenCount(capped.maxOutput) + ' max output'),
    `"${capped.id}": the output ceiling is stated`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§11  The honesty line — what a choice does, and does not, do');
// ═════════════════════════════════════════════════════════════════════════
// This is a guard on a CLAIM, not on behaviour. It previously pinned the
// words "not wired up yet" — true while nothing could store a choice, and
// FALSE the moment POST /api/config/api-keys/model landed. That is the whole
// point of pinning a claim: the four assertions here went red and forced the
// sentence to be rewritten rather than left standing as a stale falsehood on
// a screen about money.
//
// What it must say NOW is the distinction the user cannot infer from "using
// X": whether X is pinned by them (an update will not move it) or is our
// default (an update can). Those are different bills.
{
  for (const prov of PROVIDERS) {
    const defaultId = WIRE[prov][0].id;
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    ok(html.includes('model-picker-scope'), `"${prov}": the list states its scope`);
    ok(!html.includes('not wired up yet'),
      `"${prov}": the stale "not wired up yet" claim is GONE — a choice now persists`);
    ok(!html.includes('nothing on this list changes what you are billed'),
      `"${prov}": and so is the claim that picking cannot change the bill`);
    ok(html.includes('follows the app default'),
      `"${prov}": with no pick stored, it says the model can move when The Curator updates`);
    ok(html.includes(escapeHtml(defaultId)),
      `"${prov}": it names the model actually in force (${defaultId})`);

    // The other half of the same sentence, on a payload that HAS a pick.
    const pinnedId = WIRE[prov][1] ? WIRE[prov][1].id : WIRE[prov][0].id;
    const pinnedHtml = renderModelPicker(rowFor(prov), keysFor(prov, {
      selectedModels: { [prov]: pinnedId },
    }));
    ok(pinnedHtml.includes('pinned this choice'),
      `"${prov}": with a pick stored, it says the choice is pinned`);
    ok(!pinnedHtml.includes('follows the app default'),
      `"${prov}": and does NOT also claim it follows the default — the two states are exclusive`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§12  The list is attached to its own provider row');
// ═════════════════════════════════════════════════════════════════════════
{
  // The one line renderProviders() uses. Asserted on source because
  // renderProviders itself is not independently executable from here (it
  // needs state, icon() and two sibling renderers) — stated as a source
  // guard rather than dressed up as behaviour.
  // BEHAVIOURAL, not a source grep: the real renderProviders is executed and
  // the output inspected. A source guard here would prove a line exists.
  stubState.keys = keysFor('gemini', { hasAnthropicKey: true, anthropicApiKey: 'ant-mask-BBB222' });
  stubState.modelPickerOpen = {};
  const section = renderProviders();
  const rowAt = section.indexOf('class="provider-row"');
  const pickAt = section.indexOf('data-model-picker="gemini"');
  ok(rowAt !== -1 && pickAt !== -1 && pickAt > rowAt,
    'the Gemini model section is rendered AFTER its own provider row, in the same list');
  ok(/import \{ formatUsdHonest \} from '\.\.\/shared\/format-usd\.js';/.test(settings),
    'SOURCE GUARD: settings.js imports the shared USD formatter rather than growing a local one');
  ok(!/toFixed\(4\)/.test(settings), 'settings.js has no local four-decimal dollar formatter');
}

// ═════════════════════════════════════════════════════════════════════════
section('§13  The expanded/collapsed state survives a repaint');
// ═════════════════════════════════════════════════════════════════════════
// render() replaces the whole section, so a native <details open> attribute
// is discarded on the next repaint — and this section repaints on things the
// user did not do (the cross-view write gate fires when an ingest starts or
// finishes ANYWHERE). A list that snapped shut mid-read, for no visible
// reason, reads as a bug. Reproduced live in a browser before this was
// added: toggling the theme collapsed both lists.
{
  const p = rowFor('gemini');
  const k = keysFor('gemini');
  const closed = renderModelPicker(p, k, false);
  const open = renderModelPicker(p, k, true);
  ok(!/<details class="model-picker"[^>]*\sopen/.test(closed),
    'collapsed by default — a 7-model list does not seize the section on entry');
  // M7's target. The third argument is how a section is opened, so the
  // default with NO argument at all must be closed, and only a STRICT true
  // may open one — a truthy-but-not-true value (a stray string from a future
  // caller) must not silently expand every section.
  ok(!/<details class="model-picker"[^>]*\sopen/.test(renderModelPicker(p, k)),
    'with the openness argument OMITTED entirely, the section is still collapsed');
  ok(!/<details class="model-picker"[^>]*\sopen/.test(renderModelPicker(p, k, 'yes')),
    'only a strict true opens a section — a truthy non-true value does not');
  ok(!/<details class="model-row"[^>]*\sopen/.test(open),
    'and every MODEL row inside an expanded section is itself collapsed');
  ok(/<details class="model-picker"[^>]*\sopen/.test(open), 'a recorded-open list repaints OPEN');
  ok(open.includes('data-model-picker="gemini"'),
    'each list is tagged with its own provider id, so the toggle listener records the right one');
  ok(closed.includes('data-model-picker="gemini"'),
    'and is tagged whether open or closed, so a first expand is recordable');
  ok(renderModelPicker(rowFor('anthropic'), keysFor('anthropic'), true).includes('data-model-picker="anthropic"'),
    'the tag carries the provider\'s OWN id, not a shared constant');
  // `open` must be presentation only: nothing is withheld from a collapsed
  // list, so the markup differs by exactly that attribute and nothing else.
  ok(closed.replace(' open', '') === open.replace(' open', ''),
    'open/closed changes nothing but the attribute — no content is withheld from a collapsed list');
  ok(/addEventListener\('toggle'/.test(settings),
    'SOURCE GUARD: a toggle listener records the change');
  ok(!/addEventListener\('toggle'[\s\S]{0,400}?render\(myMountToken\)/.test(settings),
    'SOURCE GUARD: and does NOT re-render — repainting would discard the DOM the user just opened');
}
// ═════════════════════════════════════════════════════════════════════════
section('§14  The COLLAPSED header answers "what am I running?" without an expand (M8)');
// ═════════════════════════════════════════════════════════════════════════
// The maintainer's report was scroll length: 14 model cards measured
// 3,938px, 4.6 screens. The fix is a collapsed section per provider — but a
// collapse is only an improvement if the common question is answered on the
// header, otherwise it just adds a click to everything.
{
  for (const prov of PROVIDERS) {
    const row = rowFor(prov);
    const defaultId = WIRE[prov][0].id;
    const html = renderModelPicker(row, keysFor(prov));
    const summary = /<summary class="model-picker-summary">([\s\S]*?)<\/summary>/.exec(html);
    ok(summary !== null, `"${prov}": the section has a summary header`);
    const head = summary[1];
    ok(head.includes(escapeHtml(row.name)), `"${prov}": the header names the provider (${row.name})`);
    ok(head.includes(escapeHtml(defaultId)),
      `"${prov}": the header names the model actually in force (${defaultId}) — no expand needed`);
    ok(head.includes('model-picker-current'),
      `"${prov}": that model has its own element, so it is stylable as the answer it is`);
    ok(head.includes(String(WIRE[prov].length) + ' models'),
      `"${prov}": the header states how many models are available (${WIRE[prov].length})`);
    // THE v3.0.1-beta.18 HAZARD, closed by construction rather than by
    // remembering preventDefault: an interactive element inside <summary>
    // toggles the section when clicked. This one carries none.
    ok(!/<button|<a\s|<input|<select|role="button"/.test(head),
      `"${prov}": the header carries NO interactive control — nothing can toggle the section by accident`);
  }
  // A provider whose default is unknown still gets a usable header rather
  // than the word 'undefined'.
  const noDefault = renderModelPicker(rowFor('gemini'),
    keysFor('gemini', { models: { gemini: '', anthropic: '' } }));
  ok(!/undefined|null/.test(/<summary[\s\S]*?<\/summary>/.exec(noDefault)[0]),
    'a missing default renders no placeholder text in the header');
  ok(/<summary[\s\S]*?<\/summary>/.exec(noDefault)[0].includes('7 models'),
    'and the count is still there, so the header is never empty');
}

// ═════════════════════════════════════════════════════════════════════════
section('§15  Exactly one section per keyed provider, and the shape admits more');
// ═════════════════════════════════════════════════════════════════════════
// Enumerated from the real catalogue. OpenRouter and a local runtime are the
// maintainer's next two tracks; the assertion below is that adding one is a
// DATA change, not a restructure — a synthetic third provider with a key and
// a catalogue renders a complete section with no code change here.
{
  const bothKeys = {
    hasGeminiKey: true, hasAnthropicKey: true,
    models: { gemini: WIRE.gemini[0].id, anthropic: WIRE.anthropic[0].id },
    offerable: WIRE,
  };
  const all = PROVIDER_ROWS.map((p) => renderModelPicker(p, bothKeys, false)).join('');
  const sections = [...all.matchAll(/data-model-picker="([^"]*)"/g)].map((m) => m[1]);
  ok(sections.length === PROVIDERS.length,
    `one section per keyed provider (${sections.length} sections for ${PROVIDERS.length} catalogues)`);
  ok(new Set(sections).size === sections.length, 'no provider gets two sections');
  for (const prov of PROVIDERS) {
    ok(sections.includes(prov), `"${prov}" has a section`);
  }
  // The unavailable rows (openai, local today) contribute none — they are
  // not built here, and must not half-appear.
  for (const p of PROVIDER_ROWS.filter((x) => !x.available)) {
    ok(!sections.includes(p.id), `"${p.id}" (available:false) contributes no section`);
  }
  // THE EXTENSIBILITY CLAIM, actually exercised: a provider this file has
  // never heard of gets a full section the moment its key flag and its
  // catalogue exist. This is what stops the next provider being a rewrite.
  const future = { id: 'openrouter', name: 'OpenRouter', dot: '#000', available: true };
  const withFuture = Object.assign({}, bothKeys, {
    hasOpenRouterKey: true,
    models: Object.assign({}, bothKeys.models, { openrouter: WIRE.gemini[0].id }),
    offerable: Object.assign({}, WIRE, { openrouter: WIRE.gemini }),
  });
  ok(renderModelPicker(future, withFuture, false) === '',
    'a new provider is NOT rendered until its key flag is added to the lookup — it fails closed, never onto another provider\'s key');
}
// ═════════════════════════════════════════════════════════════════════════
section('§16  The SECTION WRAPPER decides openness — executed, not grepped (M7b)');
// ═════════════════════════════════════════════════════════════════════════
// A mutation that stayed GREEN is what produced this section, and it is
// recorded rather than filed as coverage: replacing the call site's
// `state.modelPickerOpen[p.id] === true` with a literal `true` forces every
// section open for every user — the maintainer's exact complaint — and every
// assertion written before this one passed, because they all drove
// renderModelPicker directly and never the wrapper that CHOOSES its third
// argument. Grepping the call site would have proved a line exists, not what
// it does. So renderProviders is extracted and executed with real state.
{
  const twoKeys = keysFor('gemini', { hasAnthropicKey: true, anthropicApiKey: 'ant-mask-BBB222' });

  stubState.keys = twoKeys;
  stubState.modelPickerOpen = {};
  const fresh = renderProviders();
  const openCount = (h) => (h.match(/<details class="model-picker"[^>]*\sopen/g) || []).length;
  const sectionCount = (h) => (h.match(/data-model-picker="/g) || []).length;
  ok(sectionCount(fresh) === PROVIDERS.length,
    `a fresh mount renders one section per keyed provider (${sectionCount(fresh)})`);
  ok(openCount(fresh) === 0,
    'a fresh mount renders EVERY section collapsed — nothing is expanded for the user');

  stubState.modelPickerOpen = { gemini: true };
  const oneOpen = renderProviders();
  ok(openCount(oneOpen) === 1, 'recording ONE section as open expands exactly one');
  ok(/data-model-picker="gemini"[^>]*>/.test(oneOpen) &&
     /<details class="model-picker" open data-model-picker="gemini"/.test(oneOpen),
    'and it is the one the user actually opened, not an arbitrary section');
  ok(!/<details class="model-picker" open data-model-picker="anthropic"/.test(oneOpen),
    'the OTHER provider stays collapsed — openness is per-section, not global');

  stubState.modelPickerOpen = {};
  const reclosed = renderProviders();
  ok(openCount(reclosed) === 0, 'clearing the record collapses them again on the next repaint');

  // The key gate, through the real wrapper this time.
  stubState.keys = keysFor('gemini');  // anthropic has no saved key
  const oneKey = renderProviders();
  ok(sectionCount(oneKey) === 1, 'only the provider with a saved key gets a section');
  ok(oneKey.includes('data-model-picker="gemini"') && !oneKey.includes('data-model-picker="anthropic"'),
    'and it is the keyed one — a Disconnected provider is not pickable anywhere');

  stubState.keys = null;  // still loading
  ok(!renderProviders().includes('data-model-picker'),
    'before the key payload arrives, no section is rendered at all');
  stubState.keys = twoKeys;
  stubState.modelPickerOpen = {};
}

// ═════════════════════════════════════════════════════════════════════════
// THE ACTION LAYER — the real onPickModel, executed against a stubbed fetch
// ═════════════════════════════════════════════════════════════════════════
// A SECOND sandbox, closing over the SAME stubState object as the renderers
// above. That shared identity is the whole design: §17-§21 call the real
// handler, let it mutate state, and then render the real markup from that
// state — so what is asserted is what a user would actually see after a
// click, not what a comment says should happen.
//
// `fetch`, `render`, `isCurrentMount` and `loadKeys` are injected as
// parameters rather than monkey-patched onto a global, so there is no
// ambient state to leak between sections.
const fetchCalls = [];
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
// Every call to render() captures the markup the picker WOULD paint at that
// instant. That is how the "not optimistic" claim is measured: the render
// that happens BEFORE the fetch resolves is a real, inspectable artifact.
let renderSnapshots = [];
let renderProviderId = 'gemini';
let loadKeysCalls = 0;
let loadKeysImpl = async () => {};
let mountIsCurrent = true;

const actions = new Function(
  'state', 'fetch', 'render', 'isCurrentMount', 'loadKeys',
  extractFunction(settings, 'modelPickErrorMessage', 'settings.js') + '\n' +
  extractFunction(settings, 'onPickModel', 'settings.js') + '\n' +
  'return { modelPickErrorMessage, onPickModel };'
)(
  stubState,
  (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
  () => {
    renderSnapshots.push(
      renderModelPicker(rowFor(renderProviderId), stubState.keys, true, false));
  },
  () => mountIsCurrent,
  // Mirrors the REAL loadKeys (settings.js): it refetches, then renders on
  // the current mount. Stubbing away that trailing render would make the
  // "settled" half of §18 unobservable — and would quietly make the suite
  // measure a sequence the app never produces.
  async () => {
    loadKeysCalls++;
    await loadKeysImpl();
    if (mountIsCurrent) {
      renderSnapshots.push(
        renderModelPicker(rowFor(renderProviderId), stubState.keys, true, false));
    }
  },
);
const { onPickModel, modelPickErrorMessage } = actions;

/** Reset every injected seam between sections. */
function resetActionHarness(provider) {
  fetchCalls.length = 0;
  renderSnapshots = [];
  loadKeysCalls = 0;
  loadKeysImpl = async () => {};
  mountIsCurrent = true;
  renderProviderId = provider;
  stubState.modelPickBusy = null;
  stubState.modelPickError = {};
  stubState.modelPickerOpen = { [provider]: true };
}
/** A response object with the shape onPickModel actually consumes. */
function reply(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === '__NOT_JSON__') throw new SyntaxError("Unexpected token '<'");
      return body;
    },
  };
}
/** The <li> for one model, out of the LAST render the handler triggered. */
function lastLiFor(id) {
  const html = renderSnapshots[renderSnapshots.length - 1] || '';
  return liFor(html, id);
}

// ═════════════════════════════════════════════════════════════════════════
section('§17  Selecting a model POSTs the right thing to the right place');
// ═════════════════════════════════════════════════════════════════════════
{
  for (const prov of PROVIDERS) {
    // Deliberately NOT index 0: picking the model that is already in force
    // would let a handler that POSTs nothing at all pass this section.
    const target = WIRE[prov][1] ? WIRE[prov][1].id : WIRE[prov][0].id;
    resetActionHarness(prov);
    stubState.keys = keysFor(prov);
    fetchImpl = async () => reply(200, { ok: true, provider: prov, selectedModel: target });

    await onPickModel(prov, target, null);

    ok(fetchCalls.length === 1, `"${prov}": exactly one request is issued`);
    const [url, opts] = fetchCalls[0] || [];
    ok(url === '/api/config/api-keys/model',
      `"${prov}": to the model endpoint, not the provider one (${url})`);
    ok(opts && opts.method === 'POST', `"${prov}": as a POST`);
    let body = null;
    try { body = JSON.parse(opts.body); } catch { body = null; }
    ok(body && body.provider === prov,
      `"${prov}": the body names this provider`);
    ok(body && body.model === target,
      `"${prov}": and the model that was clicked (${target})`);
    ok(loadKeysCalls === 1,
      `"${prov}": the payload is REFETCHED on success — the render is never trusted to the echo`);
  }

  // The button the user actually clicks carries both halves of that body.
  const prov = PROVIDERS[0];
  stubState.keys = keysFor(prov);
  const html = renderModelPicker(rowFor(prov), stubState.keys, true, false);
  const target = WIRE[prov][1] ? WIRE[prov][1].id : WIRE[prov][0].id;
  const li = liFor(html, target);
  ok(li.includes('data-pick-model="' + escapeHtml(target) + '"'),
    'the row carries the model id the handler will POST');
  ok(li.includes('data-pick-provider="' + escapeHtml(prov) + '"'),
    'and the provider, off the control itself rather than inferred from position');
}

// ═════════════════════════════════════════════════════════════════════════
section('§18  The selection is NOT shown as active until the server confirms (M1)');
// ═════════════════════════════════════════════════════════════════════════
// THE MONEY ASSERTION. A model choice is a spending decision, so showing it
// as in force while the write is still in flight — or after it failed — is
// this repo's dead-data shape on the one screen where it costs the user
// money. Measured by rendering DURING the request, not by reading the code.
{
  for (const prov of PROVIDERS) {
    const before = WIRE[prov][0].id;
    const after = WIRE[prov][1] ? WIRE[prov][1].id : WIRE[prov][0].id;
    if (before === after) continue;  // one-model provider: nothing to move

    resetActionHarness(prov);
    stubState.keys = keysFor(prov, { selectedModels: { [prov]: before } });

    let midFlight = null;
    fetchImpl = async () => {
      // Whatever the UI is painting right now, at the exact moment the
      // request is outstanding.
      midFlight = renderSnapshots[renderSnapshots.length - 1] || '';
      return reply(200, { ok: true });
    };
    loadKeysImpl = async () => {
      stubState.keys = keysFor(prov, {
        selectedModels: { [prov]: after },
        models: Object.assign({}, keysFor(prov).models, { [prov]: after }),
      });
    };

    await onPickModel(prov, after, null);

    ok(midFlight !== null && midFlight !== '',
      `"${prov}": the UI repainted before the request resolved (so there IS something to check)`);
    const midNew = liFor(midFlight, after);
    const midOld = liFor(midFlight, before);
    ok(!midNew.includes('model-badge-chosen'),
      `"${prov}": mid-flight, the clicked model is NOT yet badged as the choice`);
    ok(!midNew.includes('model-pick-state'),
      `"${prov}": mid-flight, it is NOT shown in the settled "Selected" state either`);
    ok(midOld.includes('model-badge-chosen'),
      `"${prov}": mid-flight, the PREVIOUS choice is still the one shown as chosen`);
    ok(midNew.includes('Saving…'),
      `"${prov}": the clicked row says what is happening instead of lying about the outcome`);
    ok(midNew.includes('disabled'),
      `"${prov}": and cannot be clicked again while it is in flight`);

    // …and only after the refetch does the selection move.
    const settledNew = lastLiFor(after);
    const settledOld = lastLiFor(before);
    ok(settledNew.includes('model-pick-state'),
      `"${prov}": once confirmed, the new model renders as the settled choice`);
    ok(!settledOld.includes('model-badge-chosen'),
      `"${prov}": and the old one no longer claims to be`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§19  A 400 refusal is VISIBLE and moves nothing (M2)');
// ═════════════════════════════════════════════════════════════════════════
{
  for (const prov of PROVIDERS) {
    const before = WIRE[prov][0].id;
    const after = WIRE[prov][1] ? WIRE[prov][1].id : WIRE[prov][0].id;
    resetActionHarness(prov);
    stubState.keys = keysFor(prov, { selectedModels: { [prov]: before } });
    const serverText = `That model is not available for ${prov}. Pick one from the list in Settings.`;
    fetchImpl = async () => reply(400, { error: serverText });

    await onPickModel(prov, after, null);

    const html = renderSnapshots[renderSnapshots.length - 1] || '';
    ok(html.includes('model-pick-error'),
      `"${prov}": the refusal renders a message the user can see`);
    ok(html.includes(escapeHtml(serverText)),
      `"${prov}": and it is the server's own actionable wording, not a generic failure`);
    ok(loadKeysCalls === 0,
      `"${prov}": nothing is refetched — there is no successful write to reflect`);
    if (before !== after) {
      ok(!liFor(html, after).includes('model-badge-chosen'),
        `"${prov}": the refused model is NOT shown as the choice`);
    }
    ok(liFor(html, before).includes('model-badge-chosen'),
      `"${prov}": the previous choice is still what the list shows`);
    ok(!html.includes('Saving…'),
      `"${prov}": and no row is left stuck in a pending state`);
  }

  // The message must survive the repaint that renders it — the v3.6.0 shape
  // where an error was set and then erased by a reload in the same finally.
  // Checked on the LAST provider the loop ran, because resetActionHarness
  // clears the map at the top of each iteration.
  const lastProv = PROVIDERS[PROVIDERS.length - 1];
  ok(typeof stubState.modelPickError[lastProv] === 'string' &&
     stubState.modelPickError[lastProv] !== '',
    'the refusal is held in state, so a later repaint cannot silently drop it');
}

// ═════════════════════════════════════════════════════════════════════════
section('§20  A 409 says a WRITE IS RUNNING and that nothing was saved (M3)');
// ═════════════════════════════════════════════════════════════════════════
// The good refusal. resolveProviderDefault reads the stored pick fresh on
// every LLM call, so a change landing mid-ingest would plan the outline on
// one model and write Phase-2 batches on another, invalidate Anthropic's
// prompt cache (a different model is a different namespace, so cached READS
// become WRITES at 1.25x) and make per-item spend arithmetic wrong. The user
// has to be told that this is what happened — and, crucially, that their
// model did not change.
{
  for (const prov of PROVIDERS) {
    const before = WIRE[prov][0].id;
    const after = WIRE[prov][1] ? WIRE[prov][1].id : WIRE[prov][0].id;
    resetActionHarness(prov);
    stubState.keys = keysFor(prov, { selectedModels: { [prov]: before } });
    // The real body conflictResponse() builds, verbatim in shape.
    fetchImpl = async () => reply(409, {
      error: 'Cannot change the AI model while a write operation is running: ' +
             'articles (ingest). Please wait for it to finish, then try again.',
      conflict: 'write_in_progress',
      active: [{ domain: 'articles', ops: ['ingest'] }],
      updateInProgress: false,
    });

    await onPickModel(prov, after, null);

    const html = renderSnapshots[renderSnapshots.length - 1] || '';
    const box = /<div class="settings-inline-error model-pick-error"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    const text = box ? box[1] : '';
    ok(text !== '', `"${prov}": a refusal message is rendered`);
    // The TEXT has to convey the situation, not merely be non-empty.
    ok(/write operation is running/i.test(text),
      `"${prov}": it says a write operation is running`);
    ok(/ingest/i.test(text),
      `"${prov}": and names what is running, so "wait" is actionable`);
    ok(/NOT saved|unchanged/i.test(text),
      `"${prov}": and states that the model did NOT change`);
    ok(/try again/i.test(text),
      `"${prov}": and that retrying later is the right move`);
    ok(loadKeysCalls === 0, `"${prov}": nothing is refetched`);
    if (before !== after) {
      ok(!liFor(html, after).includes('model-badge-chosen'),
        `"${prov}": the refused model is not shown as chosen`);
    }
    ok(liFor(html, before).includes('model-badge-chosen'),
      `"${prov}": the standing choice is untouched`);
  }

  // A 409 whose body never arrives (a proxy, a non-JSON page) must still
  // explain itself. A blank error box is the invisible refusal again.
  resetActionHarness(PROVIDERS[0]);
  stubState.keys = keysFor(PROVIDERS[0]);
  fetchImpl = async () => reply(409, '__NOT_JSON__');
  await onPickModel(PROVIDERS[0], WIRE[PROVIDERS[0]][1].id, null);
  const bare = stubState.modelPickError[PROVIDERS[0]] || '';
  ok(/write operation is running/i.test(bare) && /NOT saved|unchanged/i.test(bare),
    'a 409 with an unreadable body still explains a write is running and nothing changed');
  ok(!/Unexpected token/i.test(bare),
    'and never surfaces a raw JSON parse error — the class fixed in v2.3.3 and v3.6.0');

  // The conflict wording is keyed on the STATUS or the structured flag, not
  // on the prose — a reworded server message must not silently downgrade it
  // to a generic failure.
  const byFlag = modelPickErrorMessage(0, { conflict: 'write_in_progress', error: 'busy' });
  ok(/NOT saved|unchanged/i.test(byFlag),
    'the structured conflict flag alone is enough to produce the conflict wording');
  const plain = modelPickErrorMessage(400, { error: 'nope' });
  ok(!/write operation is running/i.test(plain),
    'and a non-conflict failure does NOT claim a write is running');
}

// ═════════════════════════════════════════════════════════════════════════
section('§21  The COLLAPSED header names the PERSISTED choice (M5)');
// ═════════════════════════════════════════════════════════════════════════
// "using X" alone cannot answer the question a user actually has, which is
// whether X is theirs or ours. Both render the same three words; only the
// marker separates "pinned, and it stays X" from "our default, and an update
// can move it".
{
  for (const prov of PROVIDERS) {
    const pinned = WIRE[prov][1] ? WIRE[prov][1].id : WIRE[prov][0].id;

    // Collapsed (isOpen falsy) — the header is all the user has.
    const withPick = renderModelPicker(rowFor(prov), keysFor(prov, {
      selectedModels: { [prov]: pinned },
      models: Object.assign({}, keysFor(prov).models, { [prov]: pinned }),
    }), false, false);
    const head = /<summary class="model-picker-summary">([\s\S]*?)<\/summary>/.exec(withPick);
    const headHtml = head ? head[1] : '';
    ok(headHtml !== '', `"${prov}": the section has a collapsed header`);
    ok(headHtml.includes(escapeHtml(pinned)),
      `"${prov}": which names the persisted model (${pinned}) without an expand`);
    ok(headHtml.includes('model-picker-chosen'),
      `"${prov}": and marks it as the user's own choice`);

    const noPick = renderModelPicker(rowFor(prov), keysFor(prov), false, false);
    const head2 = /<summary class="model-picker-summary">([\s\S]*?)<\/summary>/.exec(noPick);
    ok(head2 && !head2[1].includes('model-picker-chosen'),
      `"${prov}": with nothing pinned, the header does NOT claim a choice was made`);
    ok(head2 && head2[1].includes('model-picker-current'),
      `"${prov}": but still says what is running — the common question, answered collapsed`);
  }

  // And it MOVES when a save confirms. Driven through the real handler.
  const prov = PROVIDERS[0];
  const from = WIRE[prov][0].id;
  const to = WIRE[prov][1].id;
  resetActionHarness(prov);
  stubState.keys = keysFor(prov, { selectedModels: { [prov]: from } });
  fetchImpl = async () => reply(200, { ok: true });
  loadKeysImpl = async () => {
    stubState.keys = keysFor(prov, {
      selectedModels: { [prov]: to },
      models: Object.assign({}, keysFor(prov).models, { [prov]: to }),
    });
  };
  await onPickModel(prov, to, null);
  const finalHead = /<summary class="model-picker-summary">([\s\S]*?)<\/summary>/
    .exec(renderModelPicker(rowFor(prov), stubState.keys, false, false));
  ok(finalHead && finalHead[1].includes(escapeHtml(to)),
    'after a confirmed save the collapsed header names the NEW model');
  ok(finalHead && !finalHead[1].includes(escapeHtml(from)),
    'and no longer the old one');
}

// ═════════════════════════════════════════════════════════════════════════
section('§22  "your choice" and "cheapest" are separately legible');
// ═════════════════════════════════════════════════════════════════════════
// Three independent facts — what runs, what the user pinned, what costs
// least — and the screen exists so a user can hold all three at once. Merging
// any two into one marker hides the question this list is for.
{
  for (const prov of PROVIDERS) {
    if (WIRE[prov].length < 2) continue;
    const cheapest = WIRE[prov][0].id;
    const pinned = WIRE[prov][1].id;
    const html = renderModelPicker(rowFor(prov), keysFor(prov, {
      selectedModels: { [prov]: pinned },
      models: Object.assign({}, keysFor(prov).models, { [prov]: pinned }),
    }), true, false);

    const cheapLi = liFor(html, cheapest);
    const pinnedLi = liFor(html, pinned);
    ok(cheapLi.includes('model-badge-cheapest'),
      `"${prov}": the cheapest model is still badged cheapest`);
    ok(!cheapLi.includes('model-badge-chosen'),
      `"${prov}": and is NOT badged as the choice, because it is not`);
    ok(pinnedLi.includes('model-badge-chosen'),
      `"${prov}": the pinned model is badged as the user's choice`);
    ok(!pinnedLi.includes('model-badge-cheapest'),
      `"${prov}": and is not also claimed to be the cheapest`);
    ok(pinnedLi.includes('model-badge-default'),
      `"${prov}": and separately as the one in use`);
    // The two markers must be DISTINGUISHABLE, not the same class twice.
    ok(!/model-badge-chosen[^"]*cheapest|model-badge-cheapest[^"]*chosen/.test(html),
      `"${prov}": the two markers are distinct classes, not one styled two ways`);

    // Exactly one row can be the choice.
    const chosenCount = (html.match(/model-badge-chosen/g) || []).length;
    ok(chosenCount === 1, `"${prov}": exactly one row is badged as the choice (${chosenCount})`);
  }

  // The common case: the user pins the model that IS the cheapest. Both
  // badges must appear on that one row — this is precisely where a merged
  // marker would lose a fact.
  const prov = PROVIDERS[0];
  const cheapest = WIRE[prov][0].id;
  const both = liFor(renderModelPicker(rowFor(prov), keysFor(prov, {
    selectedModels: { [prov]: cheapest },
  }), true, false), cheapest);
  ok(both.includes('model-badge-chosen') && both.includes('model-badge-cheapest') &&
     both.includes('model-badge-default'),
    'a model that is in use, chosen AND cheapest carries all three markers at once');
}

// ═════════════════════════════════════════════════════════════════════════
section('§23  No saved key ⇒ no selection control at all (M4)');
// ═════════════════════════════════════════════════════════════════════════
// Config-scoped, per v3.0.13: a Disconnected provider must not be pickable
// even if a stale .env key would still let the app call it. Two layers — the
// route sends `offerable: []`, and this renders nothing — and this asserts
// the second, since it is the one a user sees.
{
  for (const p of PROVIDER_ROWS) {
    const noKey = renderModelPicker(p, {
      hasGeminiKey: false, hasAnthropicKey: false,
      models: {}, selectedModels: {}, offerable: WIRE,
    }, true, false);
    ok(!noKey.includes('data-pick-model'),
      `"${p.id}": with no saved key, there is no model button`);
    ok(!noKey.includes('data-pick-clear'),
      `"${p.id}": and no way to clear a selection either`);
    ok(noKey === '', `"${p.id}": the whole section is absent, not merely disabled`);
  }

  // …and the handler refuses a provider it does not know, rather than
  // guessing a slot. Under-writing is recoverable; writing a model into
  // another provider's slot is not noticed until that provider bills oddly.
  resetActionHarness('gemini');
  stubState.keys = keysFor('gemini');
  fetchImpl = async () => { throw new Error('must not be reached'); };
  await onPickModel('openrouter', 'some-model', null);
  ok(fetchCalls.length === 0,
    'an unknown provider issues NO request — it fails closed, not onto a neighbour');
  ok(/unknown provider/i.test(stubState.modelPickError['openrouter'] || ''),
    'and says why, rather than failing silently');
}

// ═════════════════════════════════════════════════════════════════════════
section('§24  The control cannot toggle the disclosure it sits in');
// ═════════════════════════════════════════════════════════════════════════
// v3.0.1-beta.18: an interactive element inside a <summary> toggles that
// section when clicked — Health's "Fix all" needed preventDefault +
// stopPropagation to live there. Rather than accept the hazard and rely on
// two calls a later edit could drop, the pick control is a SIBLING of the
// row's disclosure. Asserted structurally, so the property holds by
// construction rather than by remembering.
{
  for (const prov of PROVIDERS) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov), true, false);
    for (const m of /* every summary in the section */ html.split('<summary').slice(1)) {
      const body = m.slice(0, m.indexOf('</summary>'));
      ok(!/<button|<input|<select|<textarea|<a\s/i.test(body),
        `"${prov}": no interactive control inside a <summary> (${body.slice(0, 40).replace(/\s+/g, ' ')}…)`);
    }
    // And the control genuinely exists, outside — otherwise the assertion
    // above passes vacuously on a picker that has no control at all.
    ok(html.includes('data-pick-model'),
      `"${prov}": the pick control exists, outside every <summary>`);
    // Structurally a sibling of the row block, not nested inside it.
    ok(/<div class="model-option-main">[\s\S]*?<\/div><div class="model-option-pick">/.test(html),
      `"${prov}": the control is a SIBLING of the row's disclosure block`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§25  A running write disables the control before it can be refused');
// ═════════════════════════════════════════════════════════════════════════
// The second layer, and only the second: the 409 in §20 is the guarantee.
// This just stops the common case producing a refusal at all.
{
  for (const prov of PROVIDERS) {
    const busy = renderModelPicker(rowFor(prov), keysFor(prov), true, true);
    const buttons = busy.match(/<button[^>]*data-pick-model[^>]*>/g) || [];
    ok(buttons.length > 0, `"${prov}": there are pick controls to check`);
    ok(buttons.every((b) => b.includes('disabled')),
      `"${prov}": every pick control is disabled while a write runs elsewhere`);
    ok(buttons.every((b) => b.includes('title=')),
      `"${prov}": each says why, so a dead button is not a mystery`);

    const idle = renderModelPicker(rowFor(prov), keysFor(prov), true, false);
    const idleButtons = idle.match(/<button[^>]*data-pick-model[^>]*>/g) || [];
    ok(idleButtons.every((b) => !b.includes('disabled')),
      `"${prov}": and they are live again when nothing is writing`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§26  Clearing goes back to the app default, through the same endpoint');
// ═════════════════════════════════════════════════════════════════════════
// Picking the default model by hand PINS it, which is a different outcome
// from following whatever the app defaults to. Without this control there is
// no way back to the un-pinned state.
{
  const prov = PROVIDERS[0];
  const pinned = WIRE[prov][1].id;
  const withPick = renderModelPicker(rowFor(prov), keysFor(prov, {
    selectedModels: { [prov]: pinned },
  }), true, false);
  ok(withPick.includes('data-pick-clear="' + escapeHtml(prov) + '"'),
    'a pinned provider offers a way back to the app default');
  const noPick = renderModelPicker(rowFor(prov), keysFor(prov), true, false);
  ok(!noPick.includes('data-pick-clear'),
    'and an un-pinned one does not offer a control that would do nothing');

  resetActionHarness(prov);
  stubState.keys = keysFor(prov, { selectedModels: { [prov]: pinned } });
  fetchImpl = async () => reply(200, { ok: true, selectedModel: null });
  loadKeysImpl = async () => { stubState.keys = keysFor(prov); };
  await onPickModel(prov, '', null);
  ok(fetchCalls.length === 1 && fetchCalls[0][0] === '/api/config/api-keys/model',
    'clearing uses the SAME endpoint — never a second write path with its own idea of "none"');
  const body = JSON.parse(fetchCalls[0][1].body);
  ok(body.model === '', 'with an empty model, which is how the route spells "clear"');
  ok(loadKeysCalls === 1, 'and the payload is refetched so the header stops claiming a choice');
  const after = renderModelPicker(rowFor(prov), stubState.keys, false, false);
  ok(!after.includes('model-picker-chosen'),
    'after clearing, the collapsed header no longer marks a user choice');
}

// ═════════════════════════════════════════════════════════════════════════
section('§27  A stale mount cannot repaint, and a stale pick cannot be shown');
// ═════════════════════════════════════════════════════════════════════════
// Settings renders are gated by isCurrentMount and fail closed. A pick that
// resolves after the user navigated away must write nothing and paint
// nothing — the v3.2.0 stale-mount class, on a handler that spends.
{
  const prov = PROVIDERS[0];
  const target = WIRE[prov][1].id;

  resetActionHarness(prov);
  stubState.keys = keysFor(prov);
  fetchImpl = async () => { mountIsCurrent = false; return reply(200, { ok: true }); };
  await onPickModel(prov, target, null);
  ok(loadKeysCalls === 0, 'a success that lands on a stale mount does not refetch into a dead view');

  resetActionHarness(prov);
  stubState.keys = keysFor(prov);
  const rendersBefore = () => renderSnapshots.length;
  fetchImpl = async () => { mountIsCurrent = false; return reply(400, { error: 'nope' }); };
  const n = rendersBefore();
  await onPickModel(prov, target, null);
  // The one render that DID happen is the pre-request one, issued while the
  // mount was still current.
  ok(renderSnapshots.length === n + 1,
    'a refusal that lands on a stale mount repaints nothing further');
  ok(!stubState.modelPickError[prov],
    'and leaves no error queued for a view the user has left');
}

// ═════════════════════════════════════════════════════════════════════════
section('§28  CLASS INVARIANT — no binary provider ternary in the pick path (M6)');
// ═════════════════════════════════════════════════════════════════════════
// The same invariant §8 holds for the render path, applied to the WRITE
// path. test-next-provider-rows.js is FUNCTION-scoped — it extracts
// renderProviderRow and onSaveKey — so a `p.id === 'gemini' ? A : B`
// reappearing in a NEW function leaves it 61/0 green. Here the stakes are
// the same as onSaveKey's: the binary form POSTs a THIRD provider's choice
// under one of the two known names.
{
  const src = extractFunction(settings, 'onPickModel', 'settings.js') + '\n' +
              extractFunction(settings, 'renderModelPicker', 'settings.js') + '\n' +
              extractFunction(settings, 'renderModelOption', 'settings.js') + '\n' +
              extractFunction(settings, 'renderModelPickerScope', 'settings.js');
  const ternary = /===\s*['"](gemini|anthropic)['"]\s*\?/;
  ok(!ternary.test(src),
    'no `provider === "gemini" ? … : …` anywhere in the pick path — a lookup or nothing');

  // BEHAVIOURAL, not only a grep: a third provider must fail closed in both
  // directions. Render side (§23 covers the no-key case; this is the case
  // where a third provider HAS an entry in the catalogue).
  const third = renderModelPicker(
    { id: 'openrouter', name: 'OpenRouter', available: true },
    { hasGeminiKey: true, hasAnthropicKey: true, models: {}, selectedModels: {},
      offerable: Object.assign({}, WIRE, { openrouter: WIRE[PROVIDERS[0]] }) },
    true, false);
  ok(third === '',
    'a provider absent from the key lookup renders NOTHING — never another provider’s list');
  ok(!third.includes('data-pick-model'),
    'and exposes no control that could write a choice for it');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ /next model-picker assertions FAILED');
  process.exit(1);
}
console.log('✅ All /next model-picker assertions green');
process.exit(0);
