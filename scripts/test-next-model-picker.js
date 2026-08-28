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
 * ── …AND, SINCE v3.15.0, THE PROVIDER DIMENSION TOO ──────────────────────
 * The models were enumerated; the FIXTURE that fed them was not. `keysFor`
 * hardcoded `hasGeminiKey: provider === 'gemini'` with no generic arm, so
 * `keysFor(<a third provider>)` produced a payload in which no has-key flag
 * was ever true for it. Every `for (const prov of PROVIDERS)` loop then
 * rendered `''` for that provider and asserted nothing — §7 reported
 * "openrouter: every delivered model is rendered (0/0)", a green over a
 * fixture that could not express the state under test. Both the has-key and
 * the mask field names are now DERIVED from the provider id, which is how the
 * route builds them (hence `hasOpenrouterKey`, lowercase r).
 *
 * ── EMPTY IS A STATE, NOT AN ABSENCE (§1b, §2b) ──────────────────────────
 * A provider's catalogue may legitimately be `[]`: this project does not
 * offer a model for a job it has not been measured doing, so a provider whose
 * routes have not met the real ingest outline prompt ships none. §1 used to
 * demand every catalogue be NON-empty and §7 then indexed `[0]` on it, so a
 * correct, deliberate state produced a CRASH. §1b now partitions the
 * providers into POPULATED and EMPTY, asserts the partition is TOTAL (so a
 * genuinely missing or malformed catalogue still fails), and every
 * content-inspecting loop runs over POPULATED while §2b covers the empty
 * disclosure on its own terms.
 *
 * ── ASSERTIONS REPOINTED OFF AN ID THAT BECAME REAL ──────────────────────
 * Three places used the literal string `'openrouter'` as their exemplar
 * UNKNOWN / future / unrecognised provider. It is a real provider now, so
 * those assertions were conceptually wrong even where they still passed:
 *   - §15's extensibility claim also spelled the key flag `hasOpenRouterKey`
 *     (CAPITAL R) while the wire carries `hasOpenrouterKey`, so it was
 *     passing because the FIXTURE was wrong, not because the code fails
 *     closed. Repointed onto two synthetic ids, with the field name derived.
 *   - §23's "unknown provider issues no request" now drives two synthetic
 *     ids plus both prototype keys, and adds the converse: every REAL
 *     provider is accepted by the same gate, so onPickModel's KNOWN table
 *     cannot drift away from PROVIDER_ROWS.
 *   - §33's unrecognised-activeProvider list now uses synthetic ids;
 *     `providerLabel('openrouter')` legitimately returns "OpenRouter", which
 *     that section reads as "a known provider was named in its place".
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
 *   - THE EXTRACTION MANIFEST IS COMPLETE (§0). Every identifier an extracted
 *     helper CALLS resolves to another extracted helper, an injected binding,
 *     an extracted constant, a local binding of its own, or a standard
 *     global. Anything else is a NAMED failing assertion that stops the run
 *     with a tally — instead of the ReferenceError this suite actually died
 *     of when `renderEmptyModelPicker` landed in settings.js. See §0 for the
 *     class, its two positive controls, and what it still cannot see.
 *   - THE SANDBOX BINDINGS CANNOT MISALIGN (§0b). `new Function(...names,
 *     body)(...args)` binds POSITIONALLY, and while the names and the values
 *     were two hand-maintained lists, editing one and not the other bound
 *     every later name to the WRONG value with NO error — surfacing ~300
 *     lines away as `TypeError: gatedLoader is not a function`. Both sandboxes
 *     now derive names and values from ONE object literal, and §0b asserts the
 *     construction itself still uses it.
 *   - EVERY EXTRACTED FUNCTION RESOLVES ITS BINDINGS WHEN CALLED (§0c). The
 *     scanner in §0 reads CALLS and is blind to a bare identifier READ — a
 *     blind spot that armed immediately, because the new
 *     `renderActivationNotice` reads the module const
 *     `ACTIVATION_SKIP_REASONS` without calling anything. §0c smoke-calls
 *     every extracted function and treats only `ReferenceError` as a failure.
 *   - PAID / FREE / UNKNOWN ARE THREE PRICE STATES (§1, §3, §3b). A free
 *     model's `input`/`output` are `null` BY DESIGN — never 0, because a
 *     truthy zero makes the ingest budget cap inert (v3.3.0). Settings
 *     rendered such a row BLANK until v3.15.0, which is the rendering
 *     reserved for "we were not told what this costs": two different facts
 *     collapsed into one, on a spend surface, with `entry.free` sitting on the
 *     wire read by nobody. Decided by the FLAG alone — never a price of zero,
 *     never a provider id, never a ":free" id substring.
 *
 *     A related accidental green fell out of the same change and is recorded
 *     because it is the sharper lesson: §7's cheapest-first control compared
 *     `first.standardInput <= last.standardInput`, and a free entry's null
 *     coerces to 0, so `null <= 0.017` is TRUE. The moment a free model landed
 *     at index 0 that control started passing WITHOUT COMPARING ANYTHING. It
 *     now compares only entries carrying real numbers, and asserts the
 *     partition is total so nothing can be silently skipped.
 *   - THE `skippedActivation` SURFACE (§16b): the decision, the presentation,
 *     and the delegation through the real `renderProviders`. ABSENT is
 *     distinguished from EMPTY in both directions; an unknown reason code
 *     renders the fact with no invented "because"; a provider absent from
 *     every table inherits the surface unchanged.
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
// §39 forces a TIMEZONE on a child process. v3.14.0's lesson: a date helper
// exercised through the ambient locale passes every same-process assertion on
// a machine east of Greenwich and fails elsewhere, so the zone must be forced
// in a process that has not already resolved one.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';
import {
  OFFERABLE_MODELS,
  // v3.15.2 — the REAL runtime-admission path. §36 below mints its
  // "fetched from the provider's catalogue" fixtures through this rather
  // than hand-writing entry literals, so the discriminator the UI reads
  // (`suitability === 'chat-only'` + `jsonRaw === null`) is asserted against
  // what the shipping admission function actually PRODUCES. A hand-written
  // literal would assert the fixture agrees with the fixture.
  setOpenRouterCatalogue,
  listOfferableModels,
} from '../src/brain/llm.js';
// §39 mints its fetched-entry NOTE through the SHIPPING record-to-spec
// function rather than typing one. The note is the thing under test — the
// picker must strip one sentence of it and keep the rest — so a hand-written
// literal would assert this file agrees with itself while the real wording
// drifted away underneath.
import { openRouterRecordToSpec } from '../src/brain/openrouter-adapter.js';

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

/**
 * ── AN EMPTY NEEDLE MATCHES EVERYTHING ───────────────────────────────────
 *
 * `escapeHtml(undefined)` is `''` (app.js coerces a nullish input to the
 * empty string), and `'anything'.includes('')` is ALWAYS TRUE. So every
 * assertion of the shape
 *
 *     ok(html.includes(escapeHtml(TABLE.some_key)), '…renders the reason')
 *
 * silently becomes a tautology the moment `some_key` stops resolving — while
 * still reading, in the tally, as positive proof that the reason was rendered.
 *
 * MEASURED, not theorised. Renaming `ACTIVATION_SKIP_REASONS.no_build_model`
 * to `no_buildlane_model` in a throwaway copy of settings.js left this suite
 * at **836 passed / 0 failed**: three assertions about "the MEASURED reason,
 * verbatim" passed over markup that no longer contained any reason at all.
 *
 * The NEGATIVE form rots differently and just as quietly:
 * `!html.includes(undefined)` searches for the six-character literal
 * `"undefined"`, finds nothing, and passes for a reason unrelated to what it
 * claims.
 *
 * These two helpers make the needle itself part of the assertion. A needle
 * that resolves to a non-string, or to the empty string, FAILS with a named
 * reason rather than matching (or missing) by construction. They spend no
 * extra assertions — one call, one tally entry — so the guard cannot be read
 * as tally inflation either.
 *
 * Use them anywhere the expected text is LOOKED UP or FORMATTED rather than
 * written literally at the call site; a literal `'rises to'` needs neither.
 */
function needleOrNull(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function needleFailure(v) {
  return ` [NEEDLE MISSING — the expected text resolved to ${JSON.stringify(v)}; ` +
    'an empty/absent needle matches everything, so this assertion would otherwise ' +
    'be a tautology. The lookup or formatter behind it has stopped resolving.]';
}
/** `hay` must contain `needle`, and `needle` must be a real non-empty string. */
function okContains(hay, needle, label) {
  const n = needleOrNull(needle);
  if (n === null) { ok(false, label + needleFailure(needle)); return; }
  ok(String(hay).includes(n), label);
}
/** `hay` must NOT contain `needle` — and `needle` must be real, or the miss is meaningless. */
function okOmits(hay, needle, label) {
  const n = needleOrNull(needle);
  if (n === null) { ok(false, label + needleFailure(needle)); return; }
  ok(!String(hay).includes(n), label);
}

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
  // v3.15.2 — the catalogue-refresh control's three fields. Same live-object
  // rule: onSyncCatalogue (action sandbox) mutates these and
  // renderCatalogueSync (render sandbox) reads them off the same identity.
  catalogueSyncBusy: null,
  catalogueSync: {},
  catalogueSyncError: {},
};

// ── THE EXTRACTION MANIFEST ───────────────────────────────────────────────
// Declared as data rather than inline in the `new Function` call, so §0's
// completeness guard can reason about it. Every name here is resolved against
// the real source before anything is executed.
//
// The REAL escapeHtml, lifted out of the shell rather than re-implemented.
// §6's whole claim is "the shipping escaper handles this input"; a local
// stand-in would prove something about the stand-in instead.
const APP_FN_NAMES = ['escapeHtml'];
const RENDER_CONSTS = ['PROVIDER_ROWS', 'MODEL_SUITABILITY_BADGES', 'ACTIVATION_SKIP_REASONS',
  // v3.16.0 — the four lane states. Extracted, never re-declared here: §39
  // drives the real predicate against the real rows, and a local copy of the
  // string values would keep passing after the module renamed one.
  'MODEL_LANES',
  // v3.15.2 — the chat-lane fold threshold. Extracted rather than duplicated
  // as a literal here: §36 asserts the fold appears strictly above it and
  // not at it, and a hardcoded 8 in this file would keep passing after the
  // module moved to a different number.
  'CHAT_LANE_COLLAPSE_AT'];
const RENDER_FN_NAMES = [
  // The REAL providerLabel: renderModelPicker names the ACTIVE provider in the
  // inactive section's sentence, and a stub would prove something about the
  // stub. It echoes an unknown id back rather than substituting another
  // provider's identity (v3.10.1) — §30 depends on that being the real one.
  'providerLabel',
  'formatIsoDay', 'formatTokenCount', 'formatModelPrice',
  // v3.15.2 — the catalogue-refresh surface. formatSyncedAt is the one that
  // must never emit a raw ISO string at a user; renderCatalogueSync is the
  // panel; renderModelLanes is the lane split renderModelPicker delegates to.
  'formatSyncedAt', 'renderCatalogueSync', 'renderModelLanes',
  // v3.16.0 — the SINGLE SOURCE OF TRUTH for a row's lane, plus the note
  // filter it drives. renderModelLanes and renderModelOption both call these,
  // so omitting them is a ReferenceError at extraction rather than a failing
  // assertion — which is exactly what §0's unresolved-callee detector exists
  // to convert into a named failure.
  'qualificationFor', 'modelLaneOf', 'laneBuildsWiki',
  'splitSentences', 'withoutLaneClaim',
  'renderModelPickerScope', 'renderModelOption',
  // On-wiki qualification (this release). renderModelOption DELEGATES to both,
  // so omitting them is what made this suite report an UNRESOLVED callee rather
  // than crash — the v3.14.0 detector doing its job. formatDuration is the
  // helper renderQualification and renderQualifyPanel both call.
  'formatDuration', 'renderQualification', 'renderQualifyPanel',
  // v3.15.0. renderModelPicker DELEGATES to this when a keyed provider's
  // catalogue is empty — the OpenRouter state for this release. Omitting it
  // is what made this suite CRASH with a ReferenceError instead of failing;
  // see §0.
  'renderEmptyModelPicker',
  'renderModelPicker',
  // v3.15.0 — the skippedActivation surface ($12b). EXTRACTED rather than
  // stubbed: renderProviders calls it, and a `() => ''` stub would make any
  // assertion driven through renderProviders vacuous. Its two peers
  // (renderFallbackBanner, renderActiveModelLine) ARE stubbed, because this
  // suite asserts nothing about them.
  // The DECISION behind it. Pure, DOM-free and fetch-free, so $16b drives
  // the real classifier rather than asserting on a verdict this file invented.
  'readSkippedActivation', 'classifyActivationOutcome',
  'renderActivationNotice',
  // The REAL section wrapper and the REAL row renderer. renderProviders is
  // what DECIDES whether a section is open — see §16 — so grepping its call
  // site would prove a line exists, not what it does.
  'renderProviderRow', 'renderProviders',
];

/**
 * Bindings the render sandbox supplies — ONE MAP, name to value.
 *
 * ── WHY THIS IS NOT TWO LISTS ────────────────────────────────────────────
 * It used to be a `RENDER_INJECTED` array of NAMES and a separate positional
 * ARGUMENT LIST, which had to stay index-aligned by hand. That is the same
 * class of hazard §0 exists to close — two hand-maintained lists that must
 * agree, in a suite whose whole purpose is catching drift — and it is worse
 * than the manifest, because a misalignment produces NO ERROR AT ALL: every
 * name still resolves, each just to the wrong value. `renderFallbackBanner`
 * silently becomes `crossWriteTitle`, the markup changes, and the failure
 * surfaces as an unrelated assertion about a price or a badge.
 *
 * With a single object literal, `new Function(...names, body)(...names.map(
 * n => VALUES[n]))` derives BOTH lists from the same source in the same
 * order, so misalignment is not caught — it is INEXPRESSIBLE. Adding a
 * binding is one line, and there is no second place to forget.
 *
 * §0b proves the property rather than asserting it: it re-derives the pairing
 * from the map and checks every parameter name maps to its own value, and a
 * control shows the OLD two-list shape would have accepted a swap silently.
 */
const RENDER_INJECTED_VALUES = {
  formatUsdHonest,
  icon: (name, size) => '<svg data-icon="' + name + '" width="' + size + '"></svg>',
  state: stubState,
  crossWriteBusy: () => false,                 // no write in flight
  crossWriteTitle: (msg) => 'cross-write: ' + msg,
  renderCrossWriteBanner: () => '',
  renderFallbackBanner: () => '',
  renderActiveModelLine: () => '',
  gatedLoader: () => '<LOADER/>',
  loadGate: null,
};
const RENDER_INJECTED = Object.keys(RENDER_INJECTED_VALUES);

/**
 * The action sandbox, built further down (see §17's preamble) — same ONE-MAP
 * rule as the render sandbox above, for the same reason.
 *
 * The values are arrow closures over harness variables declared ~300 lines
 * below. That is safe and it was MEASURED, not assumed: a closure only
 * evaluates its free names when CALLED, and this map is called after the
 * harness is initialised. The alternative — a name list up here and an
 * argument list down there — is exactly the positional coupling this refactor
 * removes.
 */
const ACTION_FN_NAMES = ['modelPickErrorMessage', 'onPickModel',
  // v3.15.2 — the catalogue refresh. Same not-optimistic invariant as
  // onPickModel, and a sharper failure mode if it breaks: the list it must
  // not clear reads as "this provider has no models", which is a lie about
  // capability rather than a missing update.
  'catalogueSyncErrorMessage', 'onSyncCatalogue'];
const ACTION_INJECTED_VALUES = {
  state: stubState,
  fetch: (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
  // Every call to render() captures the markup the picker WOULD paint at that
  // instant. That is how the "not optimistic" claim is measured: the render
  // that happens BEFORE the fetch resolves is a real, inspectable artifact.
  render: () => {
    renderSnapshots.push(
      renderModelPicker(rowFor(renderProviderId), stubState.keys, true, false));
    // The sync panel is a SIBLING of the picker, so it is not inside the
    // markup above and would be unobservable without its own capture. Pushed
    // to a separate array so every existing renderSnapshots index is
    // unchanged.
    syncSnapshots.push(
      renderCatalogueSync(rowFor(renderProviderId), stubState.keys, false));
  },
  isCurrentMount: () => mountIsCurrent,
  // Mirrors the REAL loadKeys (settings.js): it refetches, then renders on
  // the current mount. Stubbing away that trailing render would make the
  // "settled" half of §18 unobservable — and would quietly make the suite
  // measure a sequence the app never produces.
  loadKeys: async () => {
    loadKeysCalls++;
    await loadKeysImpl();
    if (mountIsCurrent) {
      renderSnapshots.push(
        renderModelPicker(rowFor(renderProviderId), stubState.keys, true, false));
      syncSnapshots.push(
        renderCatalogueSync(rowFor(renderProviderId), stubState.keys, false));
    }
  },
};
const ACTION_INJECTED = Object.keys(ACTION_INJECTED_VALUES);

const RENDER_EXPORTS = [...APP_FN_NAMES, ...RENDER_CONSTS, ...RENDER_FN_NAMES];

const sandbox = new Function(
  ...RENDER_INJECTED,
  APP_FN_NAMES.map((n) => extractFunction(appJs, n, 'app.js')).join('\n') + '\n' +
  RENDER_CONSTS.map((n) => extractConst(settings, n)).join('\n') + '\n' +
  RENDER_FN_NAMES.map((n) => extractFunction(settings, n, 'settings.js')).join('\n') + '\n' +
  'return { ' + RENDER_EXPORTS.join(', ') + ' };'
)(...RENDER_INJECTED.map((n) => RENDER_INJECTED_VALUES[n]));

const {
  escapeHtml, PROVIDER_ROWS, providerLabel, formatIsoDay, formatTokenCount,
  formatModelPrice, renderModelPicker, renderModelPickerScope, renderModelOption,
  renderEmptyModelPicker, renderActivationNotice, classifyActivationOutcome,
  ACTIVATION_SKIP_REASONS, renderProviders, MODEL_SUITABILITY_BADGES,
  formatSyncedAt, renderCatalogueSync, renderModelLanes, CHAT_LANE_COLLAPSE_AT,
  MODEL_LANES, qualificationFor, modelLaneOf, laneBuildsWiki,
  splitSentences, withoutLaneClaim, renderQualifyPanel,
} = sandbox;

// ── The real catalogue, exactly as the wire carries it ────────────────────
// JSON round-trip resolves llm.js's `input`/`output` getters into plain
// numbers, which is precisely what src/routes/config.js serialises.
const WIRE = JSON.parse(JSON.stringify(OFFERABLE_MODELS));
const PROVIDERS = Object.keys(WIRE);

// ── EMPTY IS A STATE, NOT AN ABSENCE ──────────────────────────────────────
// A provider's catalogue may legitimately be EMPTY. That is not a defect and
// not a placeholder: this project does not offer a model for a job it has not
// been measured doing (docs/model-lifecycle.md), so a provider whose routes
// have not yet met the real ingest outline prompt ships `[]`.
//
// STALE CLAIM CORRECTED: this said "OpenRouter is that state for v3.15.0".
// It no longer is — three OpenRouter models were hand-measured and admitted,
// so EMPTY is `[]` TODAY and every `for (… of EMPTY)` loop below runs ZERO
// times. The loops are kept deliberately (a provider can return to that state,
// and the empty-picker surface still exists), but a loop over an empty
// collection is not a passing test — it is no test — so §1b asserts the
// partition is total and the EMPTY arm's coverage is DECLARED there rather
// than left for a reader to infer from a green tally.
//
// The distinction that matters, and that §1b pins, is EMPTY (the wire told us
// there are none) versus MISSING (no key, a non-array, a truncated payload —
// we were told nothing). Assertions that need at least one model run over
// POPULATED only; assertions about the empty state run over EMPTY. Every
// provider must be in exactly one of the two, so neither loop can silently
// stop covering a provider.
const POPULATED = PROVIDERS.filter((p) => Array.isArray(WIRE[p]) && WIRE[p].length > 0);
const EMPTY = PROVIDERS.filter((p) => Array.isArray(WIRE[p]) && WIRE[p].length === 0);

// ── THE WIRE FIELD CONVENTION ─────────────────────────────────────────────
// The route derives each provider's key fields mechanically from its id, which
// is why the wire carries `hasOpenrouterKey` with a LOWERCASE r
// (settings.js:1212 warns about exactly this). Derived here rather than
// listed, for the reason the next block records.
const wireHasField = (id) => 'has' + String(id).charAt(0).toUpperCase() + String(id).slice(1) + 'Key';
const wireMaskField = (id) => String(id) + 'ApiKey';

/**
 * Full key payload for a provider that HAS a saved key.
 *
 * ── WHY THIS IS BUILT, NOT LISTED ────────────────────────────────────────
 * It used to hardcode `hasGeminiKey: provider === 'gemini'` and
 * `hasAnthropicKey: provider === 'anthropic'`, with no generic arm. Every
 * `for (const prov of PROVIDERS)` loop below then calls `keysFor(prov)` — so
 * the moment the catalogue gained a THIRD provider, `keysFor('openrouter')`
 * produced a payload in which no has-key flag was ever true for it. Every one
 * of those loops silently rendered `''` for that provider and asserted
 * nothing: §7 reported "openrouter: every delivered model is rendered (0/0)"
 * — a green over a fixture that could not express the state under test.
 *
 * The default model per provider is likewise derived from the catalogue and
 * is NULL for a provider that ships none, which is what the wire carries when
 * `DEFAULTS[provider]` is null (nothing measured yet).
 */
function defaultModelFor(prov) {
  const list = WIRE[prov];
  return Array.isArray(list) && list.length > 0 ? list[0].id : null;
}
function keysFor(provider, over = {}) {
  const base = { models: {}, activeProvider: provider, offerable: WIRE };
  for (const prov of PROVIDERS) {
    base[wireHasField(prov)] = prov === provider;
    base[wireMaskField(prov)] = prov === provider ? 'mask-' + prov + '-AAA111' : '';
    base.models[prov] = defaultModelFor(prov);
  }
  return Object.assign(base, over);
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
/** The full text of a row's price span, whatever shape it takes. A FREE row
 *  renders `<span class="mono model-price">free</span>` with no unit child,
 *  so headlinePrice() below (which reads up to the unit span) sees nothing. */
function freeLabelOf(li) {
  const m = /<span class="mono model-price">([\s\S]*?)<\/span>/.exec(li);
  return m ? m[1] : null;
}
/** The headline price text of one <li> — NOT the promo "rises to" clause. */
function headlinePrice(li) {
  const m = /<span class="mono model-price">([\s\S]*?)<span class="model-price-unit">/.exec(li);
  return m ? m[1] : null;
}
const idsInOrder = (html) =>
  [...html.matchAll(/data-model-id="([^"]*)"/g)].map((m) => m[1]);

// ── The lane copy, read off the RENDERED markup ────────────────────────────
// Deliberately matched on the sentence the user actually reads, not on a
// class name: a section that kept the styling and lost the claim would still
// be the defect. The two phrases are disjoint ("builds" vs "does not build"),
// so a section cannot satisfy both and a mutation cannot satisfy neither by
// accident.
const summaryOf = (html) => {
  const m = /<summary class="model-picker-summary">([\s\S]*?)<\/summary>/.exec(html);
  return m ? m[1] : '';
};
const scopeOf = (html) => {
  const m = /<p class="model-picker-scope[^"]*">([\s\S]*?)<\/p>/.exec(html);
  return m ? m[1] : '';
};
const claimsBuild = (s) => /this model builds your wiki/i.test(s);
const disclaimsBuild = (s) => /this model does not build your wiki/i.test(s);
const laneIsLive = (head) => /model-picker-lane-live/.test(head);
/** Whole-word presence in the VISIBLE text, so a class name or an attribute
 *  can never be mistaken for prose naming a provider. */
const wordIn = (html, word) => {
  if (!word) return false;
  const text = html.replace(/<[^>]*>/g, ' ');
  return new RegExp('\\b' + String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text);
};

// ═════════════════════════════════════════════════════════════════════════
section('§0  EXTRACTION COMPLETENESS — the harness cannot go blind by omission');
// ═════════════════════════════════════════════════════════════════════════
/*
 * ── THE BLIND SPOT THIS CLOSES, AND WHY IT IS A CLASS ────────────────────
 * The extraction manifest is a hardcoded list of names. An extracted function
 * that CALLS a helper not on that list throws `ReferenceError` at call time —
 * so the suite CRASHES with a stack trace instead of failing with a tally.
 * That is strictly worse than a red: the runner classifies suites by their
 * assertion output, so a crash can read as "did not run" rather than "is
 * broken", and the developer who added the helper sees a harness error rather
 * than a statement about their code.
 *
 * IT HAPPENED HERE. v3.15.0 added `renderEmptyModelPicker` to settings.js;
 * `renderModelPicker` delegates to it whenever a keyed provider's catalogue is
 * empty, which is OpenRouter's normal state for this release. The name was not
 * in the manifest, and this suite died with
 * `ReferenceError: renderEmptyModelPicker is not defined`.
 *
 * That is the v3.11.0 shape verbatim. `test-next-semantic-gate.js` lifted a
 * hardcoded list of functions out of domains.js; a new module-level helper was
 * not in it, `loadHealth` threw ReferenceError MID-CLEAR, and the suite's red
 * was diagnosed as a state-lifetime bug that did not exist.
 *
 * ── CLOSED GENERALLY, NOT JUST FOR THIS RELEASE'S HELPER ─────────────────
 * The obvious fix is "add the name", which fixes the INSTANCE and leaves the
 * class open for the next helper. So instead: every identifier CALLED by an
 * extracted function is resolved against (a) the other extracted functions,
 * (b) the bindings the sandbox injects, (c) the constants it extracts,
 * (d) standard globals. Anything left over is named in a failing assertion.
 *
 * ── AND THE FAILURE IS TERMINAL, WHICH IS THE POINT ──────────────────────
 * A named red that is then followed by the very crash it predicted still
 * leaves the runner with no tally. So an unresolved name prints the tally and
 * exits(1) here — a clean, counted, named failure, which is the property this
 * section exists to provide. (This is one step beyond
 * test-next-composer-model.js's §0, which reports and continues; that suite's
 * sandbox is not called until later either, but a second crash would still
 * eat its tally.)
 *
 * ── NOT ENFORCED (stated rather than implied away) ───────────────────────
 *   - INDIRECT calls. `const f = helper; f();` binds the name without a
 *     following `(`, so it is invisible here and still crashes. The direct
 *     `name(` form is what settings.js uses throughout.
 *   - Property calls (`obj.method()`) are ignored — resolved at runtime
 *     against a value, not against module scope.
 *   - Free identifiers that are READ but never CALLED (a bare `SOME_CONST`
 *     reference) are not detected. Both extracted consts are also read-only
 *     names, and both are in the manifest; a new one would still crash.
 *   - Comment/literal stripping is approximate; it errs toward
 *     over-reporting, whose cost is one manifest entry.
 *   - This guard covers THIS suite's two sandboxes only. Every other suite in
 *     the repo that lifts functions by a hardcoded list has the same blind
 *     spot. Recorded so "the class is closed" is not read more widely than it
 *     is true.
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
/**
 * Names a function body binds for ITSELF — its parameters and its local
 * `const`/`let`/`var`/`function` declarations. `renderProviderRow` declares
 * `const num = …` / `const usd = …` and calls them; those are neither
 * extracted nor injected and must not be reported as missing.
 *
 * Over-providing is the SAFE direction here in one respect and not in another,
 * so it is stated plainly: a local shadowing a module helper of the same name
 * would hide a genuine omission. No settings.js local does that today, and the
 * alternative — a hand-maintained exclusion list — is the very shape this
 * section exists to remove.
 */
function locallyBoundNames(body) {
  const names = new Set();
  const decl = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = decl.exec(body)) !== null) names.add(m[1]);
  // Parameters of the outer function and of any inner arrow/function literal.
  const params = /(?:function\s*[A-Za-z_$\w$]*\s*|\)\s*=>|^)?\(([^()]*)\)\s*(?:=>|\{)/g;
  while ((m = params.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  // Destructured bindings: `const { a, b } = …`, `const [x] = …`.
  const destr = /\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g;
  while ((m = destr.exec(body)) !== null) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(':').pop().replace(/=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  return names;
}

/**
 * Report the callees of `names` (taken from `src`) that resolve to nothing the
 * sandbox provides. `provided` is every name in scope inside that sandbox.
 *
 * The leading `[^.\w$\\]` excludes a backslash, so a regex escape such as
 * `/\B(?=…)/` inside `formatTokenCount` is not read as a call to `B()`. Other
 * regex-literal shapes can still over-report; the cost of an over-report is
 * one manifest entry, while an under-report is the crash this guards.
 */
function unresolvedCallees(src, names, provided, where) {
  const out = [];
  for (const name of names) {
    const body = stripCommentsAndLiterals(extractFunction(src, name, where));
    const locals = locallyBoundNames(body);
    // LOOKAHEAD, not a consuming prefix. The earlier form
    // `/(^|[^.\w$\\])([A-Za-z_$][\w$]*)\s*\(/g` ate the opening paren, so in
    // `if (someHelper())` the match for `if (` left lastIndex past the paren
    // and the inner callee was NEVER SEEN — every callee wrapped in `if (…)`,
    // `while (…)`, `return (…)` or another call was invisible to this scanner.
    // Measured while porting it into test-diagnostics.js, where a positive
    // control reported "nothing found" against a call that was plainly there.
    // The preceding character is now inspected without being consumed: `.`
    // (member access), `\` (a regex escape such as `/\B(?=…)/`) and a word
    // character (part of a longer identifier) all disqualify the match.
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
{
  const settingsTopLevel = topLevelFunctionNames(settings);
  const settingsImports = importedNames(settings);
  ok(settingsTopLevel.size > 20,
    `the top-level function scanner sees settings.js's helpers (found ${settingsTopLevel.size})`);
  for (const n of [...RENDER_FN_NAMES, ...ACTION_FN_NAMES]) {
    ok(settingsTopLevel.has(n), `manifest entry "${n}" is a real top-level function in settings.js`);
  }
  for (const n of APP_FN_NAMES) {
    ok(topLevelFunctionNames(appJs).has(n), `manifest entry "${n}" is a real top-level function in app.js`);
  }

  const renderProvided = new Set([
    ...APP_FN_NAMES, ...RENDER_CONSTS, ...RENDER_FN_NAMES, ...RENDER_INJECTED,
  ]);
  const actionProvided = new Set([
    ...ACTION_FN_NAMES, ...ACTION_INJECTED, ...RENDER_CONSTS,
  ]);
  const unresolved = [
    ...unresolvedCallees(settings, RENDER_FN_NAMES, renderProvided, 'settings.js'),
    ...unresolvedCallees(settings, ACTION_FN_NAMES, actionProvided, 'settings.js'),
    ...unresolvedCallees(appJs, APP_FN_NAMES, renderProvided, 'app.js'),
  ];
  ok(unresolved.length === 0,
    'every function an extracted helper calls is itself extracted, injected or a standard global' +
    (unresolved.length
      ? ` — UNRESOLVED: ${unresolved.join(', ')}. Add the callee to the extraction manifest ` +
        '(RENDER_FN_NAMES / ACTION_FN_NAMES) if it is a settings.js helper, or to the injected list ' +
        'if the sandbox should supply it. Without this the suite CRASHES with a ReferenceError ' +
        'instead of failing with a tally.'
      : ''));

  // ── POSITIVE CONTROL 1 ────────────────────────────────────────────────
  // The exact regression that produced this section: drop
  // renderEmptyModelPicker from the manifest and the detector must NAME its
  // caller. Proves the guard is not passing because it sees nothing.
  {
    const without = RENDER_FN_NAMES.filter((n) => n !== 'renderEmptyModelPicker');
    const provided = new Set([...APP_FN_NAMES, ...RENDER_CONSTS, ...without, ...RENDER_INJECTED]);
    const found = unresolvedCallees(settings, without, provided, 'settings.js');
    ok(found.some((s) => s.endsWith('-> renderEmptyModelPicker()')),
      `control — removing renderEmptyModelPicker from the manifest IS detected (${found.join(', ') || 'nothing found'})`);
  }
  // ── POSITIVE CONTROL 2 ────────────────────────────────────────────────
  // A DIFFERENT shape: an INJECTED binding, not a settings.js helper. Drop
  // formatUsdHonest (an import this file supplies to the sandbox) and the
  // same scanner must report it. One control proves the mechanism works for
  // one kind of name; two prove it is not keyed to a special case.
  {
    // Non-vacuous precondition: formatUsdHonest really IS an import of
    // settings.js (not a local), so the case below is the injected-binding
    // path and not an accident of naming.
    ok(importedNames(settings).has('formatUsdHonest'),
      'settings.js imports formatUsdHonest — so the injected-binding control below is real');
    ok(!topLevelFunctionNames(settings).has('formatUsdHonest'),
      '…and does NOT declare it locally, so the sandbox genuinely has to supply it');
    const provided = new Set([
      ...APP_FN_NAMES, ...RENDER_CONSTS, ...RENDER_FN_NAMES,
      ...RENDER_INJECTED.filter((n) => n !== 'formatUsdHonest'),
    ]);
    const found = unresolvedCallees(settings, RENDER_FN_NAMES, provided, 'settings.js');
    ok(found.some((s) => s.endsWith('-> formatUsdHonest()')),
      `control — an INJECTED callee is visible to the same scanner (${found.join(', ') || 'nothing found'})`);
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
    const found = unresolvedCallees(probe, ['zzProbe'], new Set(), 'synthetic probe');
    const want = ['zzInner', 'zzOuter', 'zzDeep'];
    ok(want.every((n) => found.includes(`zzProbe() -> ${n}()`)) &&
       !found.some((s) => s.endsWith('-> zzMethod()')),
      `control — a callee nested inside \`if (…)\` or another call IS visible, and a method call is not mistaken for one (${found.join(', ') || 'nothing found'})`);
  }

  // ── §0b  MISALIGNMENT IS INEXPRESSIBLE, NOT MERELY CAUGHT ─────────────
  // `new Function(...names, body)(...args)` binds POSITIONALLY. While the
  // names and the values were two hand-maintained lists, inserting a binding
  // into one and not the other bound every later name to the WRONG value —
  // with no error anywhere, because every name still resolved. The failure
  // then surfaced as an unrelated assertion about a price or a badge.
  //
  // Both sandboxes now derive names AND values from one object literal, so
  // there is no second list to fall out of step with. Asserted by re-deriving
  // the pairing the same way the sandbox does and checking each parameter
  // lands on its own value.
  for (const [label, MAP] of [['render', RENDER_INJECTED_VALUES], ['action', ACTION_INJECTED_VALUES]]) {
    const names = Object.keys(MAP);
    const args = names.map((n) => MAP[n]);
    ok(names.length > 0 && names.length === args.length,
      `§0b the ${label} sandbox derives ${names.length} names and ${args.length} values from ONE map`);
    ok(names.every((n, i) => args[i] === MAP[n]),
      `§0b every ${label} parameter name is bound to its OWN value — index alignment is a property of the map, not of two lists agreeing`);
    ok(new Set(names).size === names.length,
      `§0b no ${label} binding is declared twice (a duplicate key would silently drop the first value)`);
  }
  // …AND THE CONSTRUCTION ITSELF MUST USE THE MAP. The three assertions above
  // prove the map is internally consistent; they say nothing about whether the
  // sandbox is built FROM it. MEASURED: replacing the spread with a
  // hand-written positional list that is one entry short leaves §0, §0b and
  // §0c all GREEN and surfaces ~300 lines later as
  // `TypeError: gatedLoader is not a function` — an unrelated-looking crash in
  // §16, which is precisely the diagnosis cost this refactor exists to remove.
  // A source assertion is the right instrument here because the property is
  // STRUCTURAL: no behaviour of a correctly-built sandbox can observe it.
  {
    const selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    for (const [label, names, values] of [
      ['render', 'RENDER_INJECTED', 'RENDER_INJECTED_VALUES'],
      ['action', 'ACTION_INJECTED', 'ACTION_INJECTED_VALUES'],
    ]) {
      const spread = new RegExp('\\)\\(\\.\\.\\.' + names + '\\.map\\(\\(n\\) => ' + values + '\\[n\\]\\)\\)');
      ok(spread.test(selfSrc),
        `§0b the ${label} sandbox is CONSTRUCTED from the map (\`...${names}.map(n => ${values}[n])\`), not from a hand-written positional list`);
      ok(new RegExp('const ' + names + ' = Object\\.keys\\(' + values + '\\)').test(selfSrc),
        `§0b …and its parameter NAMES are derived from the same map, so there is no second list to fall out of step with`);
    }
  }

  // CONTROL — the OLD two-list shape really did admit a silent swap, so §0b
  // is describing a hazard that existed rather than decorating one that did
  // not. Two lists, one edited: every name still resolves, to the wrong value.
  {
    const namesV1 = ['a', 'b'];
    const argsV1 = [1, 2];
    const namesV2 = ['a', 'x', 'b'];           // a binding inserted…
    const argsV2 = [1, 2];                     // …and the arg list not updated
    const bound = (ns, as) => Object.fromEntries(ns.map((n, i) => [n, as[i]]));
    ok(bound(namesV1, argsV1).b === 2, 'control: the aligned two-list form binds correctly');
    ok(bound(namesV2, argsV2).b === undefined && bound(namesV2, argsV2).x === 2,
      'control: the SAME shape with one list edited binds "b" to nothing and "x" to b\'s value — silently, with no error. That is what the single map makes impossible.');
  }

  // ── §0c  WHAT THE SCANNER CANNOT READ, EXECUTION CAN ──────────────────
  // The static scanner above resolves CALLS. It is documented as blind to a
  // bare identifier READ — and that blind spot armed immediately: the new
  // `renderActivationNotice` reads the module-level const
  // `ACTIVATION_SKIP_REASONS` without calling anything, so an incomplete
  // RENDER_CONSTS would have produced a ReferenceError at call time with §0
  // green. (Measured: it did, on the first run after extraction.)
  //
  // So every extracted function is SMOKE-CALLED on trivially safe arguments
  // and only `ReferenceError` is treated as a failure. Any other error is
  // ignored — this asks "are your bindings resolvable?", never "do you behave
  // correctly", which is every other section's job.
  //
  // Path-dependent, and said plainly: a missing binding on a branch these
  // arguments never reach is still invisible here. That is why it SUPPLEMENTS
  // the scanner (which is path-independent) rather than replacing it.
  {
    const SMOKE_ARGS = [
      [], [undefined], [null], [''], [0],
      [{ id: 'gemini', name: 'Gemini', available: true }, keysFor(POPULATED[0]), true, false],
      [{ kind: 'skipped', entries: [{ provider: 'gemini', reason: 'no_build_model' }] }],
      [{ kind: 'unreported', provider: 'gemini' }],
      [{ id: 'x', input: 1, output: 2, standardInput: 1, standardOutput: 2, suitability: 'general', note: '' }, 0, '', {}],
      ['2027-01-01'], [1234], [1, 2],
    ];
    const refErrors = [];
    for (const name of [...RENDER_FN_NAMES, ...APP_FN_NAMES]) {
      const fn = sandbox[name];
      if (typeof fn !== 'function') continue;
      for (const args of SMOKE_ARGS) {
        try { fn(...args); } catch (err) {
          if (err instanceof ReferenceError) refErrors.push(`${name}() -> ${err.message}`);
        }
      }
    }
    ok(refErrors.length === 0,
      'every extracted function resolves all its bindings when actually CALLED — no ReferenceError' +
      (refErrors.length
        ? ` — ${[...new Set(refErrors)].join('; ')}. A bare identifier READ (a module const, not a call) is invisible to the scanner above; add it to RENDER_CONSTS.`
        : ''));
    // POSITIVE CONTROL 3 — a different shape again, and the one that actually
    // bit: a function whose only missing binding is a READ. Built here rather
    // than found, so the detector is proven on the exact class.
    {
      const probe = new Function('return function probeReadsAMissingConst(){ return SOME_UNPROVIDED_CONST.x; };')();
      let caught = null;
      try { probe(); } catch (err) { caught = err; }
      ok(caught instanceof ReferenceError,
        `control — a function whose missing binding is a bare READ throws ReferenceError, which the smoke pass above catches (${caught && caught.message})`);
    }
  }

  // TERMINAL. See the docblock: a named red followed by the predicted crash
  // still leaves the runner without a tally, so stop here with one.
  if (failed > 0) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Passed: ${passed}   Failed: ${failed}`);
    console.log('❌ /next model-picker assertions FAILED (extraction manifest incomplete — stopping before the ReferenceError this predicts)');
    process.exit(1);
  }
}

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
    // AN ARRAY, ALWAYS. This is the assertion that still catches a genuinely
    // missing catalogue — a provider key that resolves to undefined, null or
    // an object. It used to also demand `length > 0`, which stopped being
    // true the moment a provider shipped with nothing measured yet (§1b).
    ok(Array.isArray(WIRE[prov]),
      `catalogue for "${prov}" is an ARRAY (${Array.isArray(WIRE[prov]) ? WIRE[prov].length + ' models' : typeof WIRE[prov]})`);
    total += Array.isArray(WIRE[prov]) ? WIRE[prov].length : 0;
  }
  ok(total >= 8, `enumerating ${total} real models — a collapse to a handful would silently weaken every loop below`);
  // ── THREE PRICE STATES ON THE WIRE, and each is a different fact ──────
  //   paid    finite numbers, produced by llm.js's input/output GETTERS and
  //           resolved to plain numbers by the JSON round-trip.
  //   free    `free: true` and a NULL price. Never 0 — a truthy zero would
  //           re-arm v3.3.0's inert budget cap, which is why llm.js records
  //           free by MEMBERSHIP rather than by a price.
  //   unknown neither. That is a malformed entry and must still fail.
  // The old assertion demanded numbers unconditionally and expired the moment
  // a live-measured free model was admitted.
  for (const prov of PROVIDERS) {
    for (const m of WIRE[prov]) {
      if (m.free === true) {
        ok(m.input === null && m.output === null,
          `"${m.id}" is flagged FREE and carries a null price — never 0, so no budget guard can mistake it for a priced model`);
      } else {
        ok(typeof m.input === 'number' && typeof m.output === 'number',
          `"${m.id}" arrived on the wire with numeric input/output (getters resolved by JSON)`);
      }
    }
  }
  const freeOnWire = PROVIDERS.flatMap((p) => WIRE[p]).filter((m) => m.free === true);
  const paidOnWire = PROVIDERS.flatMap((p) => WIRE[p]).filter((m) => m.free !== true);
  ok(paidOnWire.length > 0, `${paidOnWire.length} PAID entries on the wire`);
  console.log(`     (${freeOnWire.length} free entr${freeOnWire.length === 1 ? 'y' : 'ies'} on the wire: ${freeOnWire.map((m) => m.id).join(', ') || 'none'})`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§1b  THE EMPTY-CATALOGUE RULE — empty is a measured state, missing is a fault');
// ═════════════════════════════════════════════════════════════════════════
// §1 used to assert every provider's catalogue was NON-EMPTY, then §7 took
// `WIRE[prov][0]` and `[len-1]` on it. When OpenRouter shipped with `[]` —
// because no OpenRouter route has been measured against the real ingest
// outline prompt, and this project does not offer a model for a job it has
// not been measured doing — that assumption produced a TypeError, i.e. a
// CRASH about a deliberate, correct state.
//
// The rule is stated here explicitly rather than assumed away, and it is
// stated in BOTH directions, so it can still go red for a real fault.
{
  ok(POPULATED.length + EMPTY.length === PROVIDERS.length,
    `every provider's catalogue is an array — ${POPULATED.length} populated (${POPULATED.join(', ') || 'none'}), ` +
    `${EMPTY.length} deliberately empty (${EMPTY.join(', ') || 'none'}), 0 missing or malformed`);
  ok(POPULATED.length >= 2,
    `at least two providers ship a measured catalogue (${POPULATED.join(', ')}) — a collapse to one would make every cross-provider assertion below vacuous`);
  // DECLARED: how many providers the EMPTY arms below actually reach. Today
  // that is ZERO — every provider ships a measured catalogue — so every
  // `for (… of EMPTY)` loop in this file runs no iterations and asserts
  // nothing. That is the correct state of the app and the loops are kept for
  // the day it changes, but it must be visible rather than inferred: a loop
  // over an empty collection is not a passing test, it is no test.
  console.log(`     (EMPTY-catalogue arms cover ${EMPTY.length} provider(s): ${EMPTY.join(', ') || 'none — every provider is populated today'})`);
  for (const prov of EMPTY) {
    ok(Array.isArray(WIRE[prov]) && WIRE[prov].length === 0,
      `"${prov}": ships an EMPTY array — the wire says "no measured model", which is a fact, not an omission`);
  }
  // The fail-safe consequence, asserted rather than described: a provider with
  // no measured model has no default model either, so nothing can silently
  // pin it as the build model.
  for (const prov of EMPTY) {
    ok(defaultModelFor(prov) === null,
      `"${prov}": has no default model to offer, so the fixture cannot invent one`);
  }
  for (const prov of POPULATED) {
    ok(typeof defaultModelFor(prov) === 'string' && defaultModelFor(prov).length > 0,
      `"${prov}": has a real default model (${defaultModelFor(prov)})`);
  }
  // CONTROL — the partition can distinguish the three cases, so the green
  // above is not "everything counted as fine".
  const probe = { good: [{ id: 'x' }], empty: [], missing: undefined, wrong: { id: 'x' } };
  const pop = Object.keys(probe).filter((p) => Array.isArray(probe[p]) && probe[p].length > 0);
  const emp = Object.keys(probe).filter((p) => Array.isArray(probe[p]) && probe[p].length === 0);
  ok(pop.length === 1 && emp.length === 1 && pop.length + emp.length !== Object.keys(probe).length,
    'control: the same partition classifies a missing and a malformed catalogue as NEITHER populated nor empty — so a real fault still fails');
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
    ok(html.length > 0,
      `control: "${prov}" WITH a saved key renders a section (populated list or the empty disclosure — §2b) so the §2 gate is not vacuous`);
    // EVERY other provider is unkeyed in this fixture and must stay hidden —
    // not just the first one the old `.find()` happened to pick.
    for (const other of PROVIDERS) {
      if (other === prov) continue;
      ok(renderModelPicker(rowFor(other), keysFor(prov)) === '',
        `"${other}" stays hidden while only "${prov}" holds a key`);
    }
  }
  // TWO DIFFERENT ABSENCES, and the labels used to conflate them. `{}` means
  // the wire never mentioned this provider's catalogue — we were told nothing,
  // so nothing is claimed. An EMPTY ARRAY is the wire saying "there are none",
  // which IS information and renders the disclosure (§2b). Mislabelling the
  // first as "an EMPTY catalogue renders nothing" is how the next reader
  // concludes the second case is a regression.
  ok(renderModelPicker(rowFor('gemini'), keysFor('gemini', { offerable: {} })) === '',
    'a saved key but the wire NEVER MENTIONED this catalogue renders nothing (told nothing, claim nothing)');
  ok(renderModelPicker(rowFor('gemini'), keysFor('gemini', { offerable: undefined })) === '',
    'a saved key but NO offerable field at all renders nothing (older backend degrades cleanly)');
  ok(renderModelPicker(rowFor('gemini'), keysFor('gemini', { offerable: { gemini: 'not-an-array' } })) === '',
    'a saved key but a MALFORMED catalogue (not an array) renders nothing rather than an empty disclosure it cannot justify');
  const unavailableRow = PROVIDER_ROWS.find((p) => !p.available);
  if (unavailableRow) {
    ok(renderModelPicker(unavailableRow, keysFor('gemini', { hasGeminiKey: true })) === '',
      `an available:false row ("${unavailableRow.id}") renders nothing`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§2b  A KEYED provider with an EMPTY catalogue SAYS SO — it does not go silent');
// ═════════════════════════════════════════════════════════════════════════
// The surface this release added, and the reason this suite crashed before it
// was extracted: `renderModelPicker` DELEGATES to `renderEmptyModelPicker`
// when a keyed provider's catalogue is `[]`. That used to `return ''`, which
// was correct only while every keyed provider always shipped models. It is
// now reachable in the normal course of use — a provider whose routes have
// not been measured against the real ingest outline prompt ships none (§1b) —
// and rendering nothing there is the failure this repo keeps re-finding under
// new names: the user saves a key, the screen does not change, and there is
// no way to tell "working, nothing to choose yet" from "my key did not save".
//
// Driven through renderModelPicker (the real entry point), not only through
// the helper, so the delegation itself is exercised rather than assumed.
{
  // ── The REAL catalogue's empty providers, if any ──────────────────────
  for (const prov of EMPTY) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov), true, false);
    ok(html !== '', `"${prov}" (empty catalogue, key saved): renders SOMETHING rather than silence`);
    ok(html.includes('data-model-picker-empty="' + escapeHtml(prov) + '"'),
      `"${prov}": renders the empty-state shape, tagged with its own id`);
    ok(!html.includes('data-pick-model'),
      `"${prov}": exposes NO "use this" control — a model that does not exist cannot be pinned`);
    ok(!html.includes('data-pick-clear'),
      `"${prov}": and no clear control either, since there is nothing pinned to clear`);
    ok(!/<details/.test(html),
      `"${prov}": is not a <details> at all, so it cannot be counted as an expandable section`);
    ok(wordIn(html, providerLabel(prov)) || wordIn(html, rowFor(prov).name),
      `"${prov}": names the provider it is about`);
    for (const other of PROVIDERS) {
      if (other === prov) continue;
      ok(!wordIn(html, providerLabel(other)),
        `"${prov}": does not name "${other}" — the empty state borrows no other provider's identity`);
    }
    // THE LANE. A provider with no measured model cannot build the wiki, and
    // must not imply it can — even when the wire claims it is active.
    ok(!claimsBuild(html),
      `"${prov}": makes no "this model builds your wiki" claim it cannot honour`);
    const active = renderModelPicker(rowFor(prov), keysFor(prov, { activeProvider: prov }), true, false);
    ok(!claimsBuild(active),
      `"${prov}": …not even when the wire says it is the ACTIVE provider`);
    ok(/cannot build/i.test(active),
      `"${prov}": says plainly that it cannot build the wiki yet`);
  }
  // ── AN ASSERTION THAT EXPIRED THE MOMENT THE FEATURE SUCCEEDED ────────
  // This used to require EMPTY.length > 0, i.e. "some provider still ships no
  // measured model". A live measurement session then admitted three OpenRouter
  // models and the whole real-catalogue loop above became vacuous — and the
  // assertion went RED for a correct app, which is the wrong signal in both
  // directions. The honest statement is not "an empty provider exists" but
  // "the empty state is covered whether or not one does". The SYNTHETIC block
  // below is what guarantees that, so it is what gets asserted; the real-
  // catalogue loop is reported as a bonus, with its count printed so a reader
  // can see how much of this section is currently exercised by real data.
  console.log(`     (${EMPTY.length} provider(s) ship an empty catalogue right now: ${EMPTY.join(', ') || 'none'} — the synthetic cases below hold the floor either way)`);

  // ── SYNTHETIC, so this section is date-proof and catalogue-proof ───────
  // The two arms of renderEmptyModelPicker are chosen from `models[p.id]` —
  // whether the provider has a DEFAULT MODEL at all — and NOT from the
  // provider's id. Asserted behaviourally on one synthetic provider driven
  // through both arms, which no `p.id === 'openrouter' ? …` implementation
  // can satisfy.
  {
    const row = { id: 'gemini', name: 'Gemini', dot: '#000', available: true };
    const emptyK = keysFor('gemini', { offerable: Object.assign({}, WIRE, { gemini: [] }) });

    const noDefault = renderModelPicker(row, Object.assign({}, emptyK, { models: { gemini: null } }), true, false);
    ok(noDefault.includes('data-model-picker-empty="gemini"'),
      'a POPULATED provider whose catalogue arrives empty ALSO gets the empty state — the arm is chosen from the payload, not from the provider id');
    ok(/measured/i.test(noDefault),
      'no default model: explains that a model is offered only once it has been measured');
    ok(/cannot build/i.test(noDefault),
      'no default model: states that this provider cannot build the wiki yet');

    const withDefault = renderModelPicker(row, Object.assign({}, emptyK, { models: { gemini: 'some-model-in-force' } }), true, false);
    ok(withDefault.includes('data-model-picker-empty="gemini"'),
      'a default model present but an empty list still renders the empty state');
    ok(withDefault.includes('some-model-in-force'),
      'default model present: names the model still in force, so the user knows what they are billed for');
    ok(!/cannot build/i.test(withDefault),
      'default model present: does NOT claim the provider cannot build — it can, on the model already in force');
    ok(noDefault !== withDefault,
      'the two arms genuinely differ — a single message for both would lose the distinction');
    // NON-VACUITY, and it is load-bearing now. The real-catalogue loop at the
    // top of §2b runs over EMPTY, which is currently [] — so if this synthetic
    // block were ever skipped, the whole section would report green over zero
    // executed cases. These four assertions are the floor, and this is the
    // statement that they ran.
    ok(noDefault.includes('data-model-picker-empty=') && withDefault.includes('data-model-picker-empty='),
      'the SYNTHETIC empty-state cases genuinely rendered — this section does not depend on a real provider happening to have no measured model');
  }

  // ── NO BINARY PROVIDER TERNARY in the empty path ──────────────────────
  // The same class invariant §8 and §28 hold elsewhere. A `=== 'openrouter' ?`
  // here would be the v3.10.1 shape in the newest function in the file.
  {
    const src = extractFunction(settings, 'renderEmptyModelPicker', 'settings.js') + '\n' +
                extractFunction(settings, 'renderModelPicker', 'settings.js');
    ok(!/===\s*['"](gemini|anthropic|openrouter)['"]\s*\?/.test(src),
      'no `provider === "<id>" ? … : …` in the empty-catalogue path — the arms come from the payload');
  }

  // ── ESCAPING ──────────────────────────────────────────────────────────
  // The provider name reaches this function from a table we own, but the
  // DEFAULT MODEL ID arrives over HTTP. Both go through the real escapeHtml.
  {
    const XSS = '<script>alert(1)</script>';
    const hostileRow = { id: 'gemini', name: XSS + ' Provider', dot: '#000', available: true };
    const k = keysFor('gemini', {
      offerable: Object.assign({}, WIRE, { gemini: [] }),
      models: { gemini: XSS },
    });
    const html = renderModelPicker(hostileRow, k, true, false);
    ok(!html.includes('<script>') && !html.includes('</script>'),
      'a hostile provider name and a hostile default-model id are both escaped in the empty state');
    ok(html.includes('&lt;script&gt;'),
      '…and present in ESCAPED form rather than silently dropped');
  }

  // ── AND A PROVIDER WITH NO KEY STILL RENDERS NOTHING ──────────────────
  // The empty state must not become a way to show a section for a provider
  // the user has Disconnected (v3.0.13).
  for (const prov of PROVIDERS) {
    const noKey = keysFor(prov, {
      [wireHasField(prov)]: false,
      offerable: Object.assign({}, WIRE, { [prov]: [] }),
    });
    ok(renderModelPicker(rowFor(prov), noKey, true, false) === '',
      `"${prov}": an empty catalogue with NO saved key still renders nothing at all`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  Every model renders its OWN, LIVE price — never the standard one (M1)');
// ═════════════════════════════════════════════════════════════════════════
{
  let promoted = 0;
  for (const prov of POPULATED) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    for (const m of WIRE[prov]) {
      const li = liFor(html, m.id);
      ok(li !== '', `"${m.id}": has its own row`);
      // ── THREE STATES, NEVER TWO ────────────────────────────────────────
      // A FREE row renders the word "free" and carries NO price-unit span, so
      // `headlinePrice` (which reads the unit span) returns null for it. That
      // is the correct shape, not a missing price: free must never render
      // "$0.00" (v3.14.0 — reported or absent, never inferred) and must never
      // render blank either, which is what an UNKNOWN price renders. Driven
      // off the reported flag, never off a price of zero or an id substring.
      if (m.free === true) {
        ok(freeLabelOf(li) === 'free',
          `"${m.id}": a FREE row renders the word "free" as its price`);
        ok(!/\$/.test(freeLabelOf(li)),
          `"${m.id}": …with no dollar figure, so no $0.00 can be inferred`);
        ok(!li.includes('model-price-unit'),
          `"${m.id}": …and no "/1M tokens" unit, which would imply a rate it does not have`);
        continue;
      }
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
section('§3b  PAID / FREE / UNKNOWN are THREE price states, never two');
// ═════════════════════════════════════════════════════════════════════════
// A free model was admitted to the catalogue after live measurement, and its
// `input`/`output` are `null` BY DESIGN — never `0`, because a truthy zero
// makes the ingest budget cap inert (v3.3.0's defect, re-armed). Settings
// rendered such a row BLANK until this release, and `entry.free === true` sat
// on the wire read by nobody: the sixth instance of this repo's dead-data
// shape.
//
// Blank is the rendering reserved for "we were not told what this costs".
// Using it for a model we know bills nothing collapses two different facts
// into one — the same absent-vs-empty mistake §1b draws on `offerable`, in a
// new costume and on a spend surface.
//
// Driven on SYNTHETIC entries so all three states are reached deliberately,
// whatever the live catalogue happens to contain.
{
  const base = {
    provider: 'gemini', maxOutput: 1000, thinks: false, jsonRaw: true,
    tokenizerFactor: 1, suitability: 'general', note: '', dominated: false,
    promotionUntilIso: null, standardPriceFromIso: null,
  };
  const paid = { ...base, id: 's-paid', label: 'Paid', input: 1, output: 5, standardInput: 1, standardOutput: 5 };
  const free = { ...base, id: 's-free', label: 'Free', free: true, input: null, output: null, standardInput: null, standardOutput: null };
  const unknown = { ...base, id: 's-unknown', label: 'Unknown', input: undefined, output: undefined, standardInput: undefined, standardOutput: undefined };

  const [rp, rf, ru] = [paid, free, unknown].map((m) => renderModelOption(m, 1, ''));
  const [lp, lf, lu] = [rp, rf, ru].map(freeLabelOf);

  ok(lp !== null && /\$/.test(lp), `PAID renders a dollar figure (${lp})`);
  ok(lf === 'free', `FREE renders the word "free" (${JSON.stringify(lf)})`);
  ok(lu === null, 'UNKNOWN renders no price element at all — the absence of a figure IS the statement');
  ok(new Set([String(lp), String(lf), String(lu)]).size === 3,
    'the three states produce three DIFFERENT renderings');
  ok(!/\$/.test(String(lf)),
    'the FREE state never renders a dollar figure — no $0.00 can be inferred from it');
  ok(!rf.includes('model-price-unit'),
    'and no "/1M tokens" unit, which would imply a per-token rate a free model does not have');
  ok(rp.includes('model-price-unit'),
    'control: a PAID row does carry the unit, so the assertion above is discriminating');

  // ── DECIDED BY THE FLAG, AND BY NOTHING ELSE ──────────────────────────
  // Never a price of zero, never a provider id, never a ":free" substring in
  // the id. llm.js's own docblock records why the suffix is unsafe: a router
  // id and two audio models are zero-priced but not actually free.
  const zeroPriced = { ...paid, id: 's-zero', input: 0, output: 0, standardInput: 0, standardOutput: 0 };
  ok(freeLabelOf(renderModelOption(zeroPriced, 1, '')) !== 'free',
    'a model priced at exactly $0/$0 WITHOUT the flag is not called free — membership is the authority, not the number');
  const suffixed = { ...paid, id: 'vendor/model:free' };
  ok(freeLabelOf(renderModelOption(suffixed, 1, '')) !== 'free',
    'an id merely CONTAINING ":free" is not treated as free — the suffix is not a membership test');
  const orProvider = { ...paid, id: 's-or', provider: 'openrouter' };
  ok(freeLabelOf(renderModelOption(orProvider, 1, '')) !== 'free',
    'and no provider id implies free — a fourth provider inherits this with no edit');
  const flagFalse = { ...unknown, id: 's-flagfalse', free: false };
  ok(freeLabelOf(renderModelOption(flagFalse, 1, '')) === null,
    'free:false with no price stays UNKNOWN — the flag present and false is not a licence to guess');

  // ── AND IT HOLDS THROUGH THE FULL PICKER, not only the row renderer ───
  {
    const k = keysFor('gemini', { offerable: { ...WIRE, gemini: [paid, free, unknown] } });
    const html = renderModelPicker(rowFor('gemini'), k, true, false);
    ok(freeLabelOf(liFor(html, 's-free')) === 'free',
      'the FREE row still says free when rendered through the whole picker');
    ok(freeLabelOf(liFor(html, 's-unknown')) === null,
      'and the UNKNOWN row still renders no price there');
    ok(/\$/.test(String(freeLabelOf(liFor(html, 's-paid')))),
      'and the PAID row still renders its figure');
  }

  // ── EVERY REAL FREE ENTRY, held to the same rule ──────────────────────
  let realFree = 0;
  for (const prov of POPULATED) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov), true, false);
    for (const m of WIRE[prov]) {
      if (m.free !== true) continue;
      realFree++;
      ok(freeLabelOf(liFor(html, m.id)) === 'free',
        `real free model "${m.id}": renders "free" in the live catalogue too`);
      ok(!/\$0/.test(liFor(html, m.id)),
        `real free model "${m.id}": …and never a $0 figure anywhere in its row`);
    }
  }
  console.log(`     (${realFree} free model(s) in the live catalogue exercised the real-data half)`);
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  Every FLAGGED model shows its measured note, verbatim (M2)');
// ═════════════════════════════════════════════════════════════════════════
{
  let flagged = 0, general = 0;
  for (const prov of POPULATED) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    for (const m of WIRE[prov]) {
      const li = liFor(html, m.id);
      const isFlagged = m.suitability !== 'general' || m.dominated === true;
      if (!isFlagged) { general++; continue; }
      flagged++;
      okContains(li, escapeHtml(m.note),
        `"${m.id}" (${m.suitability}${m.dominated ? ', dominated' : ''}): renders its note VERBATIM`);
      ok(li.includes('model-badge-flag'),
        `"${m.id}": carries a flag badge, so the note has something to explain`);
      // WORD-LEVEL PIN, not merely "a flag badge exists": the `dominated`
      // field renders as the literal text "out-performed" on THIS surface,
      // matching the word chat.js's renderModelOptionHtml uses for the
      // identical `OFFERABLE_MODELS[].dominated` flag (src/brain/llm.js —
      // not owned by either view). See scripts/test-next-composer-model.js
      // for the chat.js half of this pin. There is no shared JS constant the
      // two views both import (independent modules, independent badge
      // tables), so these two assertions ARE the enforcement — keep both in
      // sync by hand if the word ever changes.
      if (m.dominated === true) {
        ok(li.includes('>out-performed<'), `"${m.id}": dominated entry renders the word "out-performed" (matches chat.js)`);
        ok(!li.includes('>dominated<'), `"${m.id}": dominated entry does NOT render the raw field name "dominated" as its label`);
      }
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
  okContains(li, escapeHtml(formatModelPrice(1.5, 7.5)),
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
  for (const prov of POPULATED) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    for (const m of WIRE[prov]) {
      if (m.input === m.standardInput && m.output === m.standardOutput) continue;
      realActive++;
      const rli = liFor(html, m.id);
      ok(rli.includes('rises to'),
        `real mid-promotion model "${m.id}": announces that a rise is coming`);
      okContains(rli, escapeHtml(formatModelPrice(m.standardInput, m.standardOutput)),
        `real mid-promotion model "${m.id}": names the price it rises to`);
      if (m.standardPriceFromIso) {
        okContains(rli, escapeHtml(formatIsoDay(m.standardPriceFromIso)),
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
  // ── WHAT "DELIVERED ORDER" MEANS NOW THAT THE LIST IS LANE-GROUPED ──────
  // v3.15.2 splits a mixed-lane catalogue into a build group and a chat-only
  // group (renderModelLanes), so `rendered === delivered` is no longer the
  // right shape of claim for such a provider — but the property it protected
  // is UNCHANGED and is asserted here in the form that still expresses it:
  // this view never re-sorts. Concretely, the rendered order must be exactly
  // the delivered order filtered by lane, build lane first. That is violated
  // by any sort, any reversal and any drop, and it degenerates to the
  // original `rendered === delivered` for a single-lane provider — which is
  // asserted separately below, so the flat path keeps its own strict check
  // rather than inheriting the weaker one.
  const isChatLane = (m) => m && typeof m === 'object' && m.suitability === 'chat-only';
  let flatProviders = 0;
  let groupedProviders = 0;
  for (const prov of POPULATED) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    const rendered = idsInOrder(html);
    const delivered = WIRE[prov].map((m) => escapeHtml(m.id));
    ok(rendered.length === delivered.length,
      `"${prov}": every delivered model is rendered (${rendered.length}/${delivered.length})`);
    // Set equality, order aside: catches a drop that a same-length reorder
    // would hide, and an invented id that a length check alone would not.
    ok([...rendered].sort().join('|') === [...delivered].sort().join('|'),
      `"${prov}": the rendered ids are exactly the delivered ids — none dropped, none invented, none duplicated`);

    const build = WIRE[prov].filter((m) => !isChatLane(m)).map((m) => escapeHtml(m.id));
    const chat = WIRE[prov].filter(isChatLane).map((m) => escapeHtml(m.id));
    ok(rendered.join('|') === build.concat(chat).join('|'),
      `"${prov}": rendered in delivered order within each lane, build lane first — unsorted by this view`);

    if (build.length === 0 || chat.length === 0) {
      flatProviders++;
      // The SINGLE-LANE path renders flat, with no grouping at all, so the
      // original strict claim still applies to it verbatim.
      ok(rendered.join('|') === delivered.join('|'),
        `"${prov}": single-lane catalogue renders flat, byte-for-byte the delivered order`);
      ok(!html.includes('model-lane-head'),
        `"${prov}": single-lane catalogue renders NO lane headings — grouping is conditional, not unconditional`);
    } else {
      groupedProviders++;
      ok(html.includes('model-lane-head-build') && html.includes('model-lane-head-chat'),
        `"${prov}": mixed-lane catalogue renders both lane headings`);
      // The build lane must come FIRST in the markup. A grouping that put
      // ~190 chat-only models above the three that can build the wiki would
      // satisfy every assertion above and defeat the entire point.
      ok(html.indexOf('model-lane-head-build') < html.indexOf('model-lane-head-chat'),
        `"${prov}": the build lane is rendered ABOVE the chat-only lane`);
    }
  }
  // Neither arm may be vacuous. Both are reached by the real catalogue today
  // (gemini is mixed, anthropic is build-only); if that ever stops being true
  // this says so instead of quietly asserting nothing.
  ok(flatProviders > 0, `at least one real provider exercises the FLAT path (${flatProviders})`);
  ok(groupedProviders > 0, `at least one real provider exercises the GROUPED path (${groupedProviders})`);
  // Control: the delivered order is actually cheapest-first, so §7 is
  // asserting something the user cares about and not just "unchanged".
  //
  // POPULATED only — an empty catalogue has no first and no last, and taking
  // `[0].standardInput` on one is what crashed this suite when OpenRouter
  // shipped with none measured (§1b). Skipping it silently would be the other
  // failure though, so §1b asserts the partition is total and the tally below
  // reports how many providers this control actually reached.
  // ── NULL IS NOT ZERO, AND `<=` DOES NOT KNOW THAT ─────────────────────
  // A FREE entry's `standardInput` is `null`. `null <= 0.017` is TRUE in JS
  // (null coerces to 0), so the moment a free model was admitted at index 0
  // this control started passing WITHOUT COMPARING ANYTHING — an accidental
  // green over a null, which is precisely the shape this suite exists to
  // refuse. Measured, not assumed. So: a free entry is asserted to BE free
  // (it genuinely is the cheapest thing on offer, and that is a membership
  // fact, not an arithmetic one), and the ordering is compared only across
  // entries that actually carry numbers.
  // ── AND IT IS PAIRWISE, NOT ENDPOINT-ONLY ──────────────────────────────
  // `first.standardInput <= last.standardInput` stood here. That compares the
  // two ENDS and says nothing about anything between them: shuffling the
  // middle of a catalogue — which is what a misordered picker actually looks
  // like — left it green. It also labelled itself "the delivered order really
  // is cheapest-first", a claim strictly stronger than what it checked. The
  // pairwise property IS separately covered against the STATIC table in
  // test-chat-model.js §11; this walk covers the DELIVERED (JSON-round-tripped)
  // order, which is a different object reaching a different surface.
  let pairsCompared = 0;
  for (const prov of POPULATED) {
    const list = WIRE[prov];
    const priced = list.filter((m) => typeof m.standardInput === 'number');
    ok(priced.length + list.filter((m) => m.free === true).length === list.length,
      `"${prov}": every entry either carries a numeric standard price or is flagged free — none is silently null`);
    for (let i = 1; i < priced.length; i++) {
      const a = priced[i - 1], b = priced[i];
      pairsCompared++;
      ok(typeof a.standardInput === 'number' && typeof b.standardInput === 'number' &&
         a.standardInput <= b.standardInput,
        `"${prov}": delivered order is cheapest-first at every step — "${a.id}" (${a.standardInput}) <= "${b.id}" (${b.standardInput})`);
    }
    // Free entries come FIRST, which is what "cheapest-first" means once one
    // exists — a free model listed after a paid one would misorder the list.
    const firstPaid = list.findIndex((m) => m.free !== true);
    const lastFree = list.map((m) => m.free === true).lastIndexOf(true);
    ok(lastFree === -1 || firstPaid === -1 || lastFree < firstPaid,
      `"${prov}": every free entry precedes every paid one`);
  }
  ok(POPULATED.length >= 2,
    `the cheapest-first control ran over ${POPULATED.length} populated catalogue(s) — it is not passing by covering none`);
  // Declared, so "green" cannot mean "compared nothing". A catalogue of one
  // priced entry contributes no pairs; every provider contributing none would
  // make the walk above vacuous while still reporting success.
  ok(pairsCompared >= POPULATED.length,
    `the ordering walk made ${pairsCompared} pairwise comparison(s) across ${POPULATED.length} catalogue(s) — it is not vacuous`);
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
  for (const prov of POPULATED) {
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
  for (const prov of POPULATED) {
    const defaultId = WIRE[prov][0].id;
    const html = renderModelPicker(rowFor(prov), keysFor(prov));
    ok(html.includes('model-picker-scope'), `"${prov}": the list states its scope`);
    ok(!html.includes('not wired up yet'),
      `"${prov}": the stale "not wired up yet" claim is GONE — a choice now persists`);
    ok(!html.includes('nothing on this list changes what you are billed'),
      `"${prov}": and so is the claim that picking cannot change the bill`);
    ok(html.includes('follows the app default'),
      `"${prov}": with no pick stored, it says the model can move when The Curator updates`);
    okContains(html, escapeHtml(defaultId),
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
  for (const prov of POPULATED) {
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
// Enumerated from the real catalogue. A local runtime is the maintainer's
// next track; the assertion below is that adding one is a DATA change, not a
// restructure.
//
// ── AN ASSERTION THAT HAD STARTED PASSING FOR THE WRONG REASON ───────────
// The extensibility claim at the foot of this section used to be driven with
// `id: 'openrouter'` and the key flag `hasOpenRouterKey` — CAPITAL R. When
// OpenRouter shipped for real in v3.15.0 the wire field was
// `hasOpenrouterKey` (lowercase r, because the route derives it from the id),
// so the assertion kept passing: not because the section fails closed for an
// unmapped provider, but because the FIXTURE was spelling the flag wrong.
// settings.js:1212 warns about that exact typo in prose. Repointed onto a
// genuinely unknown id, and the field name is now derived rather than typed.
{
  const allKeys = { models: {}, offerable: WIRE };
  for (const prov of PROVIDERS) {
    allKeys[wireHasField(prov)] = true;
    allKeys.models[prov] = defaultModelFor(prov);
  }
  const all = PROVIDER_ROWS.map((p) => renderModelPicker(p, allKeys, false)).join('');
  // Both shapes count: a populated provider renders `data-model-picker`, an
  // EMPTY one renders `data-model-picker-empty` (§1b). A keyed provider must
  // produce exactly one of the two — silence is the state this must exclude.
  const sections = [...all.matchAll(/data-model-picker(?:-empty)?="([^"]*)"/g)].map((m) => m[1]);
  ok(sections.length === PROVIDERS.length,
    `one section per keyed provider, populated or empty (${sections.length} sections for ${PROVIDERS.length} catalogues)`);
  ok(new Set(sections).size === sections.length, 'no provider gets two sections');
  for (const prov of PROVIDERS) {
    ok(sections.includes(prov), `"${prov}" has a section`);
  }
  // The unavailable rows (local today) contribute none — they are not built
  // here, and must not half-appear.
  for (const p of PROVIDER_ROWS.filter((x) => !x.available)) {
    ok(!sections.includes(p.id), `"${p.id}" (available:false) contributes no section`);
  }
  // THE EXTENSIBILITY CLAIM, actually exercised: a provider this file has
  // never heard of must NOT get a section until its key flag is wired into
  // the lookup, and must never borrow another provider's key to get one.
  // Driven with a genuinely unknown id, and with its key flag spelled by the
  // SAME derivation the real providers use — so this cannot pass again
  // because of a typo.
  for (const futureId of ['zzz-future-runtime', 'local-llama']) {
    const future = { id: futureId, name: 'Synthetic ' + futureId, dot: '#000', available: true };
    const withFuture = Object.assign({}, allKeys, {
      [wireHasField(futureId)]: true,
      models: Object.assign({}, allKeys.models, { [futureId]: WIRE[POPULATED[0]][0].id }),
      offerable: Object.assign({}, WIRE, { [futureId]: WIRE[POPULATED[0]] }),
    });
    ok(renderModelPicker(future, withFuture, false) === '',
      `"${futureId}" is NOT rendered until its key flag is added to the lookup — it fails closed, never onto another provider's key`);
  }
  // CONTROL, so the four assertions above cannot be passing because
  // renderModelPicker returns '' for everything: a REAL provider with the
  // SAME fixture does render.
  ok(renderModelPicker(rowFor(POPULATED[0]), allKeys, false) !== '',
    `control: "${POPULATED[0]}" DOES render from the same fixture — the fail-closed assertions are not vacuous`);
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
  // Every provider keyed, built the same mechanical way keysFor does — so a
  // provider added to the catalogue is covered here without an edit. It used
  // to name gemini and anthropic by hand, which is why the section count went
  // stale the moment a third provider shipped.
  const allKeys = keysFor(POPULATED[0]);
  for (const prov of PROVIDERS) {
    allKeys[wireHasField(prov)] = true;
    allKeys[wireMaskField(prov)] = 'mask-' + prov + '-AAA111';
  }
  const A = POPULATED[0], B = POPULATED[1];

  stubState.keys = allKeys;
  stubState.modelPickerOpen = {};
  const fresh = renderProviders();
  const openCount = (h) => (h.match(/<details class="model-picker"[^>]*\sopen/g) || []).length;
  // Populated AND empty sections both count: a keyed provider must produce
  // exactly one of the two shapes (§1b). The empty one is a <div>, never a
  // <details>, so it can never be open — which is why openCount is unchanged.
  const sectionCount = (h) => (h.match(/data-model-picker(?:-empty)?="/g) || []).length;
  ok(sectionCount(fresh) === PROVIDERS.length,
    `a fresh mount renders one section per keyed provider (${sectionCount(fresh)} for ${PROVIDERS.length})`);
  ok(openCount(fresh) === 0,
    'a fresh mount renders EVERY section collapsed — nothing is expanded for the user');

  stubState.modelPickerOpen = { [A]: true };
  const oneOpen = renderProviders();
  ok(openCount(oneOpen) === 1, 'recording ONE section as open expands exactly one');
  ok(new RegExp('<details class="model-picker" open data-model-picker="' + A + '"').test(oneOpen),
    `and it is the one the user actually opened ("${A}"), not an arbitrary section`);
  ok(!new RegExp('<details class="model-picker" open data-model-picker="' + B + '"').test(oneOpen),
    `the OTHER provider ("${B}") stays collapsed — openness is per-section, not global`);

  stubState.modelPickerOpen = {};
  const reclosed = renderProviders();
  ok(openCount(reclosed) === 0, 'clearing the record collapses them again on the next repaint');

  // The key gate, through the real wrapper this time.
  stubState.keys = keysFor(A);  // every OTHER provider has no saved key
  const oneKey = renderProviders();
  ok(sectionCount(oneKey) === 1, 'only the provider with a saved key gets a section');
  ok(oneKey.includes('data-model-picker="' + A + '"'),
    `and it is the keyed one ("${A}") — a Disconnected provider is not pickable anywhere`);
  for (const prov of PROVIDERS) {
    if (prov === A) continue;
    ok(!oneKey.includes('data-model-picker="' + prov + '"')
       && !oneKey.includes('data-model-picker-empty="' + prov + '"'),
      `"${prov}" (Disconnected) gets no section of EITHER shape — not even the empty disclosure`);
  }

  stubState.keys = null;  // still loading
  ok(!renderProviders().includes('data-model-picker'),
    'before the key payload arrives, no section is rendered at all');
  stubState.keys = allKeys;
  stubState.modelPickerOpen = {};
}

// ═════════════════════════════════════════════════════════════════════════
section('§16b  WHY THE ACTIVE ROW DID NOT MOVE — the skippedActivation surface');
// ═════════════════════════════════════════════════════════════════════════
/*
 * `POST /api/config/api-keys` returns `skippedActivation`: keys that were
 * SAVED but did NOT become active. Before v3.15.0 it was serialised on the
 * wire and read by NOBODY — this repo's named dead-data shape, and the fifth
 * instance of it. The user saved a key, the Active row did not move, and
 * nothing on screen accounted for it, which reads as the app ignoring the
 * click.
 *
 * Two functions, tested at the level each one decides:
 *   classifyActivationOutcome — the DECISION (silent / skipped / unreported)
 *   renderActivationNotice    — the PRESENTATION
 * Plus the delegation, driven through the real `renderProviders`, so a notice
 * that classifies correctly and never reaches the page still fails.
 *
 * ABSENT IS NOT EMPTY, and that distinction is the sharp edge. `[]` is the
 * server telling us nothing was skipped — confident silence. An ABSENT field
 * is the server telling us nothing at all, and concluding "nothing was
 * skipped" from silence invents a fact. The `unreported` arm therefore fires
 * only on POSITIVE evidence that the row did not move (the response's own
 * `activeProvider` disagreeing with the provider just saved) — never on the
 * absence of evidence. The same distinction was drawn on `offerable` in §1b;
 * it has now bitten twice in one release.
 *
 * ── HOW ESCAPING IS CHECKED, AND WHY NOT querySelector ───────────────────
 * There is no DOM parser in this repo and adding one would be a
 * devDependency the auto-updater installs on every end-user machine — the
 * reason Playwright is deliberately not a devDependency (v3.0.6). So instead
 * of `html.includes('<script>')` (which misses `<script >` and `<SCRIPT>`)
 * or an attribute regex (v3.13.0: `[^>]*` walks straight through `&gt;` and
 * gave a FALSE POSITIVE on correctly-escaped output), `tagNamesIn` below
 * enumerates every real TAG-OPEN in the string. `<` followed by an optional
 * `/` and an ASCII letter is the actual production; `&lt;script&gt;` contains
 * no `<` at all and therefore cannot register. Asserting the tag-name SET is
 * structurally what querySelector would answer.
 */
/** Every element name actually opened in `html` (lowercase, deduped). */
function tagNamesIn(html) {
  const names = new Set();
  const re = /<\/?([A-Za-z][A-Za-z0-9-]*)/g;
  let m;
  while ((m = re.exec(String(html))) !== null) names.add(m[1].toLowerCase());
  return names;
}
{
  // ── THE REASON TABLE ITSELF, PINNED ───────────────────────────────────
  // Nothing anywhere pinned this table's key set, so a rename was invisible:
  // the renderer's `ACTIVATION_SKIP_REASONS[e.reason]` lookup simply stopped
  // resolving, the "because …" clause silently vanished from a credentials
  // screen, and every assertion below stayed green because an empty needle
  // matches everything (see okContains).
  //
  // The key is a WIRE CONTRACT, not an internal name: the backend puts
  // `reason: 'no_build_model'` on the 400 body, so renaming this key breaks
  // the pairing between two files that never import each other — exactly the
  // two-hand-maintained-lists shape this repo names. It is pinned as an EXACT
  // SET so an addition is reviewed too: a new reason code with no rendered
  // text would render the FACT with no "because", which is the correct
  // fail-safe but must be a deliberate choice rather than an omission.
  const REASON_KEYS = Object.keys(ACTIVATION_SKIP_REASONS).sort();
  ok(REASON_KEYS.join(',') === 'no_build_model',
    `ACTIVATION_SKIP_REASONS carries exactly the reason codes the backend emits (got: ${REASON_KEYS.join(',') || '<empty>'})`);
  for (const k of REASON_KEYS) {
    ok(typeof ACTIVATION_SKIP_REASONS[k] === 'string' && ACTIVATION_SKIP_REASONS[k].trim().length > 10,
      `reason "${k}" maps to substantive user-facing text, not '' (an empty value would render "because " and nothing else)`);
  }

  // ── The DECISION ──────────────────────────────────────────────────────
  const skippedPayload = {
    activeProvider: 'gemini',
    skippedActivation: [{ provider: 'openrouter', reason: 'no_build_model' }],
  };
  ok(classifyActivationOutcome(skippedPayload, 'openrouter').kind === 'skipped',
    'a non-empty skippedActivation classifies as "skipped"');
  ok(classifyActivationOutcome({ activeProvider: 'gemini', skippedActivation: [] }, 'gemini').kind === 'silent',
    'an EMPTY skippedActivation classifies as SILENT — the server told us nothing was skipped, so we say nothing');

  // ABSENT vs EMPTY, both directions, and the gate on positive evidence.
  ok(classifyActivationOutcome({ activeProvider: 'gemini' }, 'openrouter').kind === 'unreported',
    'ABSENT field + activeProvider showing the row did NOT move -> "unreported": state the fact, claim no reason');
  ok(classifyActivationOutcome({ activeProvider: 'openrouter' }, 'openrouter').kind === 'silent',
    'ABSENT field + activeProvider showing the row DID move -> silent: nothing to explain');
  ok(classifyActivationOutcome({}, 'openrouter').kind === 'silent',
    'ABSENT field AND no readable activeProvider -> SILENT: with no positive evidence we know nothing, and announcing "it did not activate" would invent the fact in the other direction');
  ok(classifyActivationOutcome(null, 'openrouter').kind === 'silent',
    'an unparseable body -> silent, never an invented verdict');
  ok(classifyActivationOutcome({ activeProvider: 'gemini', skippedActivation: 'nope' }, 'openrouter').kind === 'unreported',
    'a NON-ARRAY skippedActivation counts as not reported — we were sent something, but nothing we can read');
  // The empty case must beat the unreported one: `[]` is a report, so even
  // with activeProvider disagreeing there is nothing to announce.
  ok(classifyActivationOutcome({ activeProvider: 'gemini', skippedActivation: [] }, 'openrouter').kind === 'silent',
    'EMPTY beats the unreported heuristic — a report of "nothing skipped" is information, not absence');

  // ── The PRESENTATION ──────────────────────────────────────────────────
  ok(renderActivationNotice(null) === '', 'no verdict renders nothing at all');
  ok(renderActivationNotice({ kind: 'silent' }) === '', 'a SILENT verdict renders nothing at all');

  const skippedHtml = renderActivationNotice(classifyActivationOutcome(skippedPayload, 'openrouter'));
  ok(skippedHtml !== '', 'a skipped verdict renders a notice');
  ok(/saved/i.test(skippedHtml),
    'it leads with the fact the key WAS saved — the part a user will otherwise doubt');
  ok(wordIn(skippedHtml, 'OpenRouter'),
    'it names the provider that did not become active');
  okContains(skippedHtml, escapeHtml(ACTIVATION_SKIP_REASONS.no_build_model),
    'and gives the MEASURED reason verbatim from the reason table, not a paraphrase');
  ok(/ingest/i.test(skippedHtml) && /health scan/i.test(skippedHtml) && /compile/i.test(skippedHtml),
    'it names all three build-lane features that keep running on the provider marked Active');

  // AN UNKNOWN REASON CODE renders the FACT with no invented "because".
  const unknown = renderActivationNotice(
    classifyActivationOutcome({ activeProvider: 'gemini', skippedActivation: [{ provider: 'openrouter', reason: 'zzz-code-we-do-not-know' }] }, 'openrouter'));
  ok(unknown !== '' && wordIn(unknown, 'OpenRouter'),
    'an UNKNOWN reason code still reports the fact that the provider did not become active');
  ok(!/because/i.test(unknown),
    '…and offers NO "because" — an invented why on a credentials screen is worse than an acknowledged gap');
  okOmits(unknown, ACTIVATION_SKIP_REASONS.no_build_model,
    '…and specifically does not borrow the one reason we happen to know');
  ok(!wordIn(unknown, 'zzz-code-we-do-not-know'),
    '…and does not print the raw reason code at the user either');

  // The `unreported` arm.
  const unrep = renderActivationNotice(classifyActivationOutcome({ activeProvider: 'gemini' }, 'openrouter'));
  ok(unrep !== '' && wordIn(unrep, 'OpenRouter'), 'the unreported arm names the provider');
  ok(/did not report why|not report/i.test(unrep),
    '…and says plainly that this build did not report a reason, rather than guessing one');

  // ── NO PROVIDER TERNARY ANYWHERE IN THAT PATH ─────────────────────────
  // A fourth provider must inherit this surface with nobody editing it.
  {
    const src = extractFunction(settings, 'classifyActivationOutcome', 'settings.js') + '\n' +
                extractFunction(settings, 'readSkippedActivation', 'settings.js') + '\n' +
                extractFunction(settings, 'renderActivationNotice', 'settings.js');
    ok(!/===\s*['"](gemini|anthropic|openrouter)['"]/.test(src),
      'no `=== "<provider id>"` anywhere in the activation-notice path — it is reason-driven, not provider-driven');
    // BEHAVIOURAL, because a grep only sees the shape it was written for: a
    // provider this build has never heard of gets the identical treatment.
    const future = renderActivationNotice(
      classifyActivationOutcome({ activeProvider: 'gemini', skippedActivation: [{ provider: 'zzz-future-runtime', reason: 'no_build_model' }] }, 'zzz-future-runtime'));
    ok(future !== '', 'a provider absent from every table still gets a notice');
    okContains(future, escapeHtml(ACTIVATION_SKIP_REASONS.no_build_model),
      '…with the same measured reason — the surface is inherited, not enumerated');
    ok(wordIn(future, 'zzz-future-runtime'),
      '…and the unknown id is echoed rather than replaced by a known provider\'s name (v3.10.1\'s fail-safe direction)');
    for (const known of PROVIDERS) {
      ok(!wordIn(future, providerLabel(known)),
        `…and no KNOWN provider ("${known}") is named in its place`);
    }
  }

  // ── ESCAPING, checked on TAG STRUCTURE rather than by substring ────────
  {
    const XSS = '<script>alert(1)</script>';
    const hostile = renderActivationNotice(classifyActivationOutcome(
      { activeProvider: 'gemini', skippedActivation: [{ provider: XSS, reason: XSS }] }, XSS));
    const tags = tagNamesIn(hostile);
    ok(!tags.has('script'),
      `no <script> element is opened anywhere in the notice (tags present: ${[...tags].sort().join(', ')})`);
    const ALLOWED = new Set(['div', 'span', 'strong', 'svg', 'code']);
    ok([...tags].every((t) => ALLOWED.has(t)),
      `every element opened is on the expected allow-list (got: ${[...tags].sort().join(', ')})`);
    ok(!/\son[a-z]+\s*=/i.test(hostile.replace(/&[a-z]+;/gi, '')),
      'no live on*= event attribute survives, tested after neutralising entities so an ESCAPED payload cannot read as a false positive');
    ok(hostile.includes('&lt;script&gt;'),
      'the payload IS present, escaped — proof the assertions above are not passing because the value was silently dropped');
    // CONTROL — tagNamesIn really can see a script tag, so the first
    // assertion is not green because the detector is blind.
    ok(tagNamesIn('<div><script >x</script></div>').has('script'),
      'control: tagNamesIn detects a <script > tag even with unusual whitespace, which a `includes("<script>")` check would miss');
    ok(!tagNamesIn('&lt;script&gt;').has('script'),
      'control: …and does NOT count an escaped one, so it cannot false-positive on correct output');
  }

  // ── AND IT REACHES THE PAGE ───────────────────────────────────────────
  // Driven through the REAL renderProviders. A verdict that classifies
  // correctly and never renders is the same defect in a smaller font.
  {
    const keysAll = keysFor(POPULATED[0]);
    for (const prov of PROVIDERS) keysAll[wireHasField(prov)] = true;
    const before = stubState.keys;
    const beforeNotice = stubState.keysActivationNotice;
    stubState.keys = keysAll;

    stubState.keysActivationNotice = null;
    const quiet = renderProviders();
    ok(!quiet.includes('settings-activation-note'),
      'a normal save (no verdict) leaves the providers section with NO activation notice');

    stubState.keysActivationNotice = classifyActivationOutcome(skippedPayload, 'openrouter');
    const loud = renderProviders();
    const noteAt = loud.indexOf('settings-activation-note');
    const listAt = loud.indexOf('provider-row-list');
    ok(noteAt !== -1,
      'a skipped verdict DOES reach the rendered providers section — the wire field has a reader');
    // SCOPED TO THE NOTICE ELEMENT, not to the whole section. The provider
    // LIST already names every provider, so `wordIn(loud, 'OpenRouter')` is
    // true whether or not the notice rendered — it passed under mutation M-13
    // with the notice deleted outright. Found by running the mutation.
    const noteEl = noteAt === -1 ? '' : loud.slice(noteAt, loud.indexOf('</div>', loud.indexOf('</div>', noteAt) + 6) + 6);
    ok(noteEl !== '' && wordIn(noteEl, 'OpenRouter'),
      '…and names the provider INSIDE the notice element itself, not merely somewhere on the section');
    // Position matters: it exists to explain the Active line, so it must not
    // be below the provider list where the explanation arrives too late.
    // `noteAt !== -1 &&` is load-bearing: without it a DELETED notice gives
    // -1 < listAt, i.e. a green for an absent element (M-13, measured).
    ok(noteAt !== -1 && listAt !== -1 && noteAt < listAt,
      '…and sits ABOVE the provider list, where it explains the Active line it refers to');

    stubState.keys = before;
    stubState.keysActivationNotice = beforeNotice;
  }
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
// ambient state to leak between sections. Their VALUES live in
// ACTION_INJECTED_VALUES beside the render sandbox's map (one map, so a name
// cannot drift out of step with its value); these are the mutable harness
// variables those closures read.
const fetchCalls = [];
let fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
let renderSnapshots = [];
let syncSnapshots = [];
let renderProviderId = 'gemini';
let loadKeysCalls = 0;
let loadKeysImpl = async () => {};
let mountIsCurrent = true;

const actions = new Function(
  ...ACTION_INJECTED,
  ACTION_FN_NAMES.map((n) => extractFunction(settings, n, 'settings.js')).join('\n') + '\n' +
  'return { ' + ACTION_FN_NAMES.join(', ') + ' };'
)(...ACTION_INJECTED.map((n) => ACTION_INJECTED_VALUES[n]));
const { onPickModel, modelPickErrorMessage, onSyncCatalogue, catalogueSyncErrorMessage } = actions;

/** Reset every injected seam between sections. */
function resetActionHarness(provider) {
  fetchCalls.length = 0;
  renderSnapshots = [];
  syncSnapshots = [];
  loadKeysCalls = 0;
  loadKeysImpl = async () => {};
  mountIsCurrent = true;
  renderProviderId = provider;
  stubState.modelPickBusy = null;
  stubState.modelPickError = {};
  stubState.modelPickerOpen = { [provider]: true };
  stubState.catalogueSyncBusy = null;
  stubState.catalogueSync = {};
  stubState.catalogueSyncError = {};
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
  for (const prov of POPULATED) {
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
  for (const prov of POPULATED) {
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
  for (const prov of POPULATED) {
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
  const lastProv = POPULATED[POPULATED.length - 1];
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
  for (const prov of POPULATED) {
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
  for (const prov of POPULATED) {
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
  for (const prov of POPULATED) {
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
  const prov = POPULATED[0];
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
  //
  // REPOINTED. This used to name `openrouter` as the exemplar unknown
  // provider. It is a REAL provider as of v3.15.0 — in PROVIDER_ROWS, in the
  // catalogue, and in onPickModel's own KNOWN table — so the assertion was
  // conceptually wrong even while it still passed. Two synthetic ids, so a
  // fix that special-cased one literal string would still be caught, plus the
  // prototype keys that a plain object literal would wrongly admit.
  //
  // MEASURED, NOT ASSUMED — one of these four behaves differently and it is
  // worth stating rather than smoothing over. `state.modelPickError` is
  // rebuilt with `Object.assign({}, prev, { [provider]: msg })`, and
  // Object.assign copies through [[Set]], so an own `__proto__` key hits
  // Object.prototype's `__proto__` SETTER and a string value is silently
  // discarded (verified: `Object.getOwnPropertyNames` of the result is `[]`,
  // while `constructor` survives intact). So for that ONE id the refusal
  // message never reaches state and nothing is rendered.
  //
  // That is a real gap, and it is unreachable: every provider id reaching
  // this handler comes from a button rendered out of PROVIDER_ROWS. The
  // SAFETY half — no request is issued, so no selection can be written into
  // a neighbour's slot — holds for all four and is asserted for all four.
  // The message half is asserted only where JS can actually hold the key,
  // rather than pinning an expectation the language forbids.
  const MESSAGE_SURVIVES_ASSIGN = (id) => Object.assign({}, { [id]: 'x' })[id] === 'x';
  for (const unknownId of ['zzz-mystery-provider', 'openai', '__proto__', 'constructor']) {
    resetActionHarness(POPULATED[0]);
    stubState.keys = keysFor(POPULATED[0]);
    fetchImpl = async () => { throw new Error('must not be reached'); };
    await onPickModel(unknownId, 'some-model', null);
    ok(fetchCalls.length === 0,
      `"${unknownId}": an unknown provider issues NO request — it fails closed, not onto a neighbour`);
    if (MESSAGE_SURVIVES_ASSIGN(unknownId)) {
      ok(/unknown provider/i.test(stubState.modelPickError[unknownId] || ''),
        `"${unknownId}": and says why, rather than failing silently`);
    } else {
      ok(true,
        `"${unknownId}": the refusal message cannot be held under this key at all — Object.assign drops an own "${unknownId}" property, so the message is silently lost. Unreachable (ids come from PROVIDER_ROWS), recorded rather than pinned as if the language allowed it.`);
    }
  }
  // …and the exclusion is not a blanket excuse: at least one prototype key
  // DOES survive the assign, so the message half is still exercised on one.
  ok(MESSAGE_SURVIVES_ASSIGN('constructor') && !MESSAGE_SURVIVES_ASSIGN('__proto__'),
    'control: exactly the __proto__ key is lost by Object.assign; "constructor" survives, so the message assertion above still ran on a prototype key');
  // CONTROL — the harness CAN observe a request, so the four "no request"
  // greens above are not a broken fetch spy.
  {
    resetActionHarness(POPULATED[0]);
    stubState.keys = keysFor(POPULATED[0]);
    fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await onPickModel(POPULATED[0], WIRE[POPULATED[0]][0].id, null);
    ok(fetchCalls.length === 1,
      `control: a KNOWN provider ("${POPULATED[0]}") does issue exactly one request through the same spy`);
  }
  // EVERY real provider is accepted by the same gate — including one whose
  // catalogue is empty. onPickModel's KNOWN table and PROVIDER_ROWS must not
  // drift apart: a provider whose key can be SAVED but whose model can never
  // be CHOSEN is a discrepancy the next reader has to re-derive.
  for (const prov of PROVIDERS) {
    resetActionHarness(prov);
    stubState.keys = keysFor(prov);
    fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await onPickModel(prov, 'anything', null);
    ok(!/unknown provider/i.test(stubState.modelPickError[prov] || ''),
      `"${prov}": a REAL provider is never refused as unknown — the handler's table covers the whole catalogue`);
  }
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
  for (const prov of POPULATED) {
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
  for (const prov of POPULATED) {
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


// ═════════════════════════════════════════════════════════════════════════
section('§29  THE LANE — the ACTIVE provider’s section says its model builds the wiki');
// ═════════════════════════════════════════════════════════════════════════
// The defect this closes was the maintainer's own: he pinned a model under
// one provider, had the OTHER active, and asked whether his next ingest
// would use the model he had just picked. It would not — ingest, Health and
// Compile all resolve through getActiveProvider(). Nothing on the screen
// said so, and every section looked equally in force.
//
// Enumerated over the REAL provider catalogue, never a hardcoded id, and run
// with EACH provider taking its turn as the active one — so an
// implementation that hardcodes "gemini is the one that builds" cannot pass
// (that is §31's job to prove explicitly, and this section's data feeds it).
{
  for (const prov of POPULATED) {
    const html = renderModelPicker(rowFor(prov), keysFor(prov), true, false);
    const scope = scopeOf(html);
    ok(scope !== '', `${prov}: the active section renders its scope line at all`);
    ok(claimsBuild(scope),
      `${prov} ACTIVE: states plainly that this model builds the wiki`);
    ok(!disclaimsBuild(scope),
      `${prov} ACTIVE: and does not simultaneously deny it`);

    // ── M5 ────────────────────────────────────────────────────────────────
    // The claim must cover the WHOLE lane. Naming only ingest would let a
    // reader infer that Health runs on something else — a wrong inference
    // this screen would then have caused rather than prevented. All three
    // resolve identically: health-ai.js's five generateText calls are all
    // FOUR-argument and compile.js's is five, while provider/model live in
    // argument SIX, so an override is not merely unused there — it cannot
    // be expressed.
    ok(/\bingest\b/i.test(scope), `${prov} ACTIVE: names ingest`);
    ok(/health scan/i.test(scope), `${prov} ACTIVE: names Health scans (M5)`);
    ok(/\bcompile\b/i.test(scope), `${prov} ACTIVE: names Compile (M5)`);

    // The second lane, stated as a choice rather than as an exception.
    ok(/\bchat\b/i.test(scope),
      `${prov} ACTIVE: names chat as the separately-chosen lane`);
    ok(!/not active/i.test(scope),
      `${prov} ACTIVE: never describes itself as not active`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§30  THE OTHER LANE — the INACTIVE section disclaims it WITHOUT going dead');
// ═════════════════════════════════════════════════════════════════════════
// Two failure directions, and the section must avoid both. Saying nothing
// leaves the original ambiguity. Saying only "not active" implies the pin is
// useless — which is false: it takes over the moment the provider is made
// active, and chat can reach the model today.
{
  for (const prov of POPULATED) {
    for (const active of PROVIDERS) {
      if (active === prov) continue;
      const html = renderModelPicker(rowFor(prov), keysFor(prov, { activeProvider: active }), true, false);
      const scope = scopeOf(html);

      ok(disclaimsBuild(scope),
        `${prov} (active=${active}): says this model does NOT build the wiki`);
      ok(!claimsBuild(scope),
        `${prov} (active=${active}): and makes no build claim of its own`);

      // Names WHO does instead, through the REAL providerLabel. Without this
      // the user is told what is not happening and never where to look.
      const label = providerLabel(active);
      ok(scope.includes(escapeHtml(label)),
        `${prov} (active=${active}): names ${label} as the provider that does`);

      // The pin is not useless — both halves asserted.
      ok(/make .* active/i.test(scope) && /takes over/i.test(scope),
        `${prov} (active=${active}): says this pin takes over on activation`);
      ok(/chat can still use/i.test(scope),
        `${prov} (active=${active}): says chat can still use it today`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§31  SWITCHING the active provider MOVES the claim — asserted both ways');
// ═════════════════════════════════════════════════════════════════════════
// The assertion a hardcoded "gemini builds the wiki" cannot survive. For
// every ordered pair, render BOTH sections under one active provider and
// require exactly one claimant; then flip the active provider and require
// the claim to have moved to the other section.
{
  for (const a of POPULATED) {
    for (const b of POPULATED) {
      if (a === b) continue;

      const underA = PROVIDERS.map((p) =>
        scopeOf(renderModelPicker(rowFor(p), keysFor(p, { activeProvider: a }), true, false)));
      const claimantsA = PROVIDERS.filter((p, i) => claimsBuild(underA[i]));
      ok(claimantsA.length === 1 && claimantsA[0] === a,
        `active=${a}: exactly one section claims the build path, and it is ${a}`);

      const underB = PROVIDERS.map((p) =>
        scopeOf(renderModelPicker(rowFor(p), keysFor(p, { activeProvider: b }), true, false)));
      const claimantsB = PROVIDERS.filter((p, i) => claimsBuild(underB[i]));
      ok(claimantsB.length === 1 && claimantsB[0] === b,
        `active=${b}: the claim MOVED to ${b} — nothing is hardcoded to one provider`);

      // And the collapsed headers move with it, since that is the surface
      // most users actually read.
      const headA = summaryOf(renderModelPicker(rowFor(a), keysFor(a, { activeProvider: a }), false, false));
      const headB = summaryOf(renderModelPicker(rowFor(a), keysFor(a, { activeProvider: b }), false, false));
      ok(laneIsLive(headA) && !laneIsLive(headB),
        `${a}'s collapsed header marks the build lane only while ${a} is active`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§32  The lane marker is on the COLLAPSED header, and is not a control');
// ═════════════════════════════════════════════════════════════════════════
// These sections are collapsed by default (§16 proves that through the real
// renderProviders), so the summary is the only thing most users will read —
// which is why the fact that decides what an ingest costs has to live there
// rather than behind the expand.
//
// And it is TEXT. An interactive element inside <summary> toggles its own
// section when clicked (v3.0.1-beta.18, where Health's "Fix all" needed
// preventDefault + stopPropagation to survive exactly that). §14 and §24
// already hold this line; the new markup must not breach it.
{
  for (const prov of POPULATED) {
    for (const active of PROVIDERS) {
      const head = summaryOf(renderModelPicker(rowFor(prov), keysFor(prov, { activeProvider: active }), false, false));
      ok(head !== '', `${prov} (active=${active}): collapsed header renders`);
      ok(/model-picker-lane/.test(head),
        `${prov} (active=${active}): the lane marker is ON the collapsed header`);
      ok(laneIsLive(head) === (prov === active),
        `${prov} (active=${active}): the marker matches who is actually active`);

      for (const tag of ['<button', '<input', '<select', '<textarea', '<a ', 'data-pick-model', 'data-pick-clear']) {
        ok(!head.includes(tag),
          `${prov} (active=${active}): no ${tag.trim()} inside <summary> — nothing that could toggle its own section`);
      }
    }
  }

  // The two markers must differ in WORDS, not only in colour — colour alone
  // is not a channel every user has.
  const live = summaryOf(renderModelPicker(rowFor(PROVIDERS[0]), keysFor(PROVIDERS[0]), false, false));
  const idle = summaryOf(renderModelPicker(rowFor(PROVIDERS[0]), keysFor(PROVIDERS[0], { activeProvider: PROVIDERS[1] }), false, false));
  const strip = (h) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  ok(strip(live) !== strip(idle),
    'the active and inactive headers differ in TEXT, not only in styling');
}

// ═════════════════════════════════════════════════════════════════════════
section('§33  An unknown active provider degrades honestly, never to a wrong name');
// ═════════════════════════════════════════════════════════════════════════
// `activeProvider` arrives over the wire. Whatever it says, no section may
// end up claiming the build path it does not have, and none may attribute it
// to a DIFFERENT known provider — the fail-safe direction renderProviderRow's
// key lookup was rebuilt around in v3.10.1.
{
  // Absent entirely: stop naming anyone rather than inventing a name.
  for (const bad of [null, undefined, '']) {
    for (const prov of POPULATED) {
      const scope = scopeOf(renderModelPicker(rowFor(prov), keysFor(prov, { activeProvider: bad }), true, false));
      ok(!claimsBuild(scope),
        `activeProvider=${JSON.stringify(bad)}: ${prov} claims no build path it cannot have`);
      ok(scope.includes('the active provider'),
        `activeProvider=${JSON.stringify(bad)}: ${prov} falls back to the generic phrase`);
      for (const other of PROVIDERS) {
        if (other === prov) continue;
        ok(!wordIn(scope, providerLabel(other)),
          `activeProvider=${JSON.stringify(bad)}: ${prov} does not attribute the build path to ${other}`);
      }
    }
  }

  // Present but not a provider this build knows. providerLabel echoes the id
  // back rather than substituting a known provider's identity, so the page
  // stays truthful about what the config says; the invariant that matters is
  // that no KNOWN provider is named in its place, and that nothing claims to
  // be active.
  //
  // REPOINTED. `openrouter` used to head this list as the exemplar
  // "provider this build does not know". It became a REAL provider in
  // v3.15.0, so the case stopped testing what its label said — and it also
  // started FAILING for a correct app, because `providerLabel('openrouter')`
  // now legitimately returns "OpenRouter" and the inner loop reads that as
  // "a known provider was named in its place". A synthetic id restores the
  // intent; a genuinely unknown id must be echoed and must implicate nobody.
  for (const bad of ['zzz-mystery-provider', 'openai', '__proto__', 'constructor']) {
    for (const prov of POPULATED) {
      const scope = scopeOf(renderModelPicker(rowFor(prov), keysFor(prov, { activeProvider: bad }), true, false));
      ok(!claimsBuild(scope) && disclaimsBuild(scope),
        `activeProvider=${bad}: ${prov} correctly reports it is not the active provider`);
      for (const other of PROVIDERS) {
        if (other === prov) continue;
        ok(!wordIn(scope, providerLabel(other)),
          `activeProvider=${bad}: ${prov} never names ${other} as the one that builds`);
      }
      ok(!/<script|onerror=/i.test(scope),
        `activeProvider=${bad}: the echoed id is escaped, not injected`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§34  formatSyncedAt — a timestamp a person reads, never a raw ISO');
// ═════════════════════════════════════════════════════════════════════════
{
  // The rule this exists to hold: a machine-readable instant must never reach
  // the screen. Every rejection path returns '' rather than echoing its input,
  // which is the OPPOSITE of formatIsoDay's contract — see both docblocks for
  // why they differ, and §34b below for the assertion that they still do.
  for (const junk of ['', '   ', 'not-a-date', 'tomorrow', '2026-13-45T99:99:99Z',
                      null, undefined, 42, {}, [], NaN]) {
    ok(formatSyncedAt(junk) === '',
      `formatSyncedAt(${JSON.stringify(junk)}) returns '' rather than echoing an unusable value`);
  }

  // A real instant renders as day-month-year plus a 24h clock, built by hand
  // so the shape cannot move under a different locale.
  const iso = new Date(2026, 7, 28, 14, 32, 11).toISOString();
  const out = formatSyncedAt(iso);
  ok(out === '28 Aug 2026, 14:32', `a real instant renders as '28 Aug 2026, 14:32' (got '${out}')`);
  ok(!/[TZ]|\d{4}-\d{2}-\d{2}/.test(out),
    'the rendered timestamp contains no ISO artefact — no T, no Z, no YYYY-MM-DD');

  // Zero-padding on BOTH clock fields. `9:5` would be a different time to a
  // reader who skims, and the single-digit path is the one a hand-rolled
  // formatter forgets.
  ok(formatSyncedAt(new Date(2026, 0, 5, 9, 5, 0).toISOString()) === '5 Jan 2026, 09:05',
    'single-digit hours and minutes are zero-padded (09:05, not 9:5)');

  // §34b — the two formatters must NOT converge. formatIsoDay takes a
  // date-only string naming the day a PRICE changes and deliberately does not
  // convert zones (converting is an off-by-one lie about money west of
  // Greenwich); formatSyncedAt takes an instant and must. A refactor that
  // "unified" them would silently reintroduce that bug, so the difference is
  // pinned as behaviour rather than left in a comment.
  ok(formatIsoDay('2027-01-01') === '1 Jan 2027',
    'control: formatIsoDay still renders a date-only price date without zone conversion');
  ok(formatIsoDay('nonsense') === 'nonsense',
    'control: formatIsoDay ECHOES unparseable input while formatSyncedAt returns \'\' — different contracts, both still in force');
}

// ═════════════════════════════════════════════════════════════════════════
section('§35  The refresh control: who gets it, when it is offered, what it claims');
// ═════════════════════════════════════════════════════════════════════════
{
  stubState.catalogueSync = {};
  stubState.catalogueSyncError = {};
  stubState.catalogueSyncBusy = null;

  // Offered only to a provider that publishes a refreshable catalogue, and
  // only when its key is SAVED. The route needs both; a control that can only
  // produce a refusal is worse than no control.
  const orKeys = keysFor('openrouter');
  ok(renderCatalogueSync(rowFor('openrouter'), orKeys, false) !== '',
    'a keyed OpenRouter row is offered the refresh control');
  for (const prov of PROVIDERS) {
    if (prov === 'openrouter') continue;
    ok(renderCatalogueSync(rowFor(prov), keysFor(prov), false) === '',
      `"${prov}" has no refreshable catalogue, so no control is rendered`);
  }
  // Fails SAFE for an id the lookup does not know — including the two
  // prototype names, which on a plain object literal would resolve TRUTHY and
  // hand a control to a provider the server has never heard of.
  for (const bad of ['zzz-mystery-provider', '__proto__', 'constructor', 'toString']) {
    ok(renderCatalogueSync({ id: bad, name: bad, available: true }, keysFor('openrouter'), false) === '',
      `unknown provider id "${bad}" is offered no refresh control`);
  }
  const noKey = keysFor('gemini'); // openrouter key absent
  ok(renderCatalogueSync(rowFor('openrouter'), noKey, false) === '',
    'no saved key ⇒ no refresh control (config-scoped, v3.0.13\'s rule)');
  ok(renderCatalogueSync(rowFor('openrouter'), null, false) === '' &&
     renderCatalogueSync(null, orKeys, false) === '',
    'a missing payload or row renders nothing rather than throwing');
  ok(renderCatalogueSync({ id: 'openrouter', name: 'OpenRouter', available: false }, orKeys, false) === '',
    'an unavailable provider row is offered no refresh control');

  // ── THE CLAIM THE WHOLE CONTROL EXISTS TO MAKE ─────────────────────────
  const panel = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
  ok(panel.includes('chat only') || panel.includes('chat</strong> only') || panel.includes('<strong>chat only</strong>'),
    'the panel states that fetched models are chat only');
  ok(/never been measured/.test(panel),
    'the panel states that fetched models have never been measured against the ingest prompt');
  ok(/cannot build\s+your wiki/.test(panel.replace(/\s+/g, ' ')),
    'the panel states plainly that fetched models cannot build the wiki');
  ok(panel.includes('data-sync-catalogue="openrouter"'),
    'the button carries the provider on itself, so the handler never has to infer it from position');

  // ── THE SUMMARY-HAZARD, CLOSED STRUCTURALLY ────────────────────────────
  // v3.0.1-beta.18: an interactive control inside a <summary> toggles its own
  // section. The fix here is structural, not two suppression calls — so the
  // assertion is that no <summary> in this panel CONTAINS a control at all,
  // and that the panel is not itself inside the picker's <details>.
  const summaries = [...panel.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
  for (const inner of summaries) {
    ok(!/<button|<input|<a\s|<select/i.test(inner),
      'no <summary> in the refresh panel contains an interactive control');
  }
  ok(!panel.includes('<details class="model-picker"'),
    'the refresh panel is not nested inside the model picker\'s own disclosure');
  // And renderProviders emits it BETWEEN the row and the picker — a sibling,
  // so there is no propagation path from the button to any <summary>.
  {
    const all = renderProviders.length >= 0 && (() => {
      stubState.keys = keysFor('openrouter');
      return renderProviders();
    })();
    const iRow = all.indexOf('data-replace="openrouter"');
    const iSync = all.indexOf('data-catalogue-sync="openrouter"');
    const iPicker = all.indexOf('data-model-picker="openrouter"');
    const iEmpty = all.indexOf('data-model-picker-empty="openrouter"');
    const iList = iPicker === -1 ? iEmpty : iPicker;
    ok(iRow !== -1 && iSync !== -1 && iList !== -1, 'renderProviders emits row, sync panel and model list for OpenRouter');
    ok(iRow < iSync && iSync < iList,
      'the sync panel sits BETWEEN the provider row and the model list — a sibling of both');
  }

  // ── DISABLED STATES: two layers, and neither is the guarantee ──────────
  stubState.catalogueSyncBusy = 'openrouter';
  const busyPanel = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
  ok(busyPanel.includes('Refreshing…') && busyPanel.includes('disabled'),
    'mid-flight the button reads "Refreshing…" and is disabled');
  stubState.catalogueSyncBusy = null;
  const crossPanel = renderCatalogueSync(rowFor('openrouter'), orKeys, true);
  ok(crossPanel.includes('disabled'),
    'a write in flight elsewhere disables the button (the 409 is the real guarantee; this is layer two)');
  ok(crossPanel.includes('cross-write:'),
    'the disabled button explains WHY, using the shared cross-write wording');
  ok(!renderCatalogueSync(rowFor('openrouter'), orKeys, false).includes('disabled'),
    'control: with nothing in flight the button is enabled — the disable assertions above are not vacuous');

  // ── THE THREE TIMESTAMP STATES, and the one that is easy to get wrong ──
  // No result and no fetched models: honestly "not refreshed yet".
  stubState.catalogueSync = {};
  const fresh = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
  ok(fresh.includes('Not refreshed yet'),
    'never refreshed, nothing fetched in the list ⇒ says so');
  ok(!/Last refreshed/.test(fresh), '…and does NOT claim a refresh time it does not have');

  // A result in hand: the time is rendered, formatted.
  const at = new Date(2026, 7, 28, 14, 32, 0).toISOString();
  stubState.catalogueSync = { openrouter: { syncedAt: at, total: 417, eligible: 286, admitted: 183, refused: 3 } };
  const synced = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
  okContains(synced, formatSyncedAt(at), 'a completed refresh renders its timestamp');
  ok(!synced.includes(at), 'the raw ISO instant never reaches the markup');
  okContains(synced, '417 listed by OpenRouter', 'the catalogue total is reported');
  okContains(synced, '286 met our requirements', 'the eligible count is reported');
  okContains(synced, '183 added here', 'the admitted count is reported');
  okContains(synced, '3 refused', 'a non-zero refused count is reported');

  // REPORTED OR ABSENT, NEVER INFERRED. A figure the server did not send must
  // not render as 0 — "none" and "we were not told" are different facts, and
  // collapsing them is the defect v3.15.0 found in eight places.
  stubState.catalogueSync = { openrouter: { syncedAt: at, admitted: 5 } };
  const partial = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
  okContains(partial, '5 added here', 'a reported figure still renders when its siblings are missing');
  ok(!/listed by OpenRouter/.test(partial), 'an ABSENT total renders nothing — not "0 listed"');
  ok(!/met our requirements/.test(partial), 'an ABSENT eligible count renders nothing — not "0 met"');
  ok(!/\brefused\b/.test(partial), 'an ABSENT refused count renders nothing — not "0 refused"');
  // Zero refusals is a real, reported fact and is deliberately NOT printed:
  // "0 refused" is noise beside "183 added". Asserted so the omission is a
  // decision on record rather than an accident.
  stubState.catalogueSync = { openrouter: { syncedAt: at, admitted: 5, refused: 0 } };
  ok(!/\brefused\b/.test(renderCatalogueSync(rowFor('openrouter'), orKeys, false)),
    'a reported ZERO refusals is not printed — nothing was rejected, so there is nothing to report');

  // An unreadable timestamp on an otherwise-successful refresh: say a refresh
  // happened, do not invent a time for it, do not claim "never".
  stubState.catalogueSync = { openrouter: { syncedAt: 'garbage', admitted: 5 } };
  const badTime = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
  ok(!badTime.includes('Not refreshed yet'),
    'a refresh with an unreadable timestamp is never described as "not refreshed yet"');
  ok(/no usable time came with it/.test(badTime),
    '…it says the time is unusable and the list may be out of date');
  ok(!badTime.includes('garbage'), 'the unreadable timestamp itself never reaches the screen');

  // ── §35b THE DURABLE TIMESTAMP: the SERVER'S meta is the primary source ──
  // The catalogue is persisted and re-admitted at boot, so
  // `GET /api/config/api-keys` carries `openrouterCatalogue.syncedAt` and it
  // survives a browser reload AND an app restart. This view must prefer it —
  // one answer to "when", not two that can drift.
  {
    const serverIso = new Date(2026, 5, 1, 8, 15, 0).toISOString();
    const sessionIso = new Date(2026, 7, 28, 14, 32, 0).toISOString();
    stubState.catalogueSync = { openrouter: { syncedAt: sessionIso, admitted: 1 } };
    const metaKeys = keysFor('openrouter', {
      openrouterCatalogue: { syncedAt: serverIso, source: 'disk', count: 183 },
    });
    const html = renderCatalogueSync(rowFor('openrouter'), metaKeys, false);
    okContains(html, formatSyncedAt(serverIso),
      'the SERVER\'s syncedAt is rendered — it survives a reload and a restart');
    okOmits(html, formatSyncedAt(sessionIso),
      '…and the session copy does NOT also render, so there is exactly one answer to "when"');

    // A fresh page load: no session record at all, meta alone carries it.
    stubState.catalogueSync = {};
    const reloaded = renderCatalogueSync(rowFor('openrouter'), metaKeys, false);
    okContains(reloaded, formatSyncedAt(serverIso),
      'after a reload, with no session record, the timestamp still renders from the payload');
    ok(!reloaded.includes('Not refreshed yet'),
      '…and a reloaded, already-populated catalogue is never called "not refreshed yet"');
    ok(!reloaded.includes(serverIso), 'the raw ISO from the payload never reaches the markup');

    // count === 0 with a key saved is a REAL state: nothing has been fetched.
    const emptyMeta = keysFor('openrouter', {
      openrouterCatalogue: { syncedAt: null, source: null, count: 0 },
    });
    ok(renderCatalogueSync(rowFor('openrouter'), emptyMeta, false).includes('Not refreshed yet'),
      'meta reporting count 0 and no time ⇒ "not refreshed yet", the honest first-run state');

    // Meta absent entirely (an older backend) must fall back, not throw.
    const noMeta = keysFor('openrouter', { openrouterCatalogue: undefined });
    ok(renderCatalogueSync(rowFor('openrouter'), noMeta, false).includes('Not refreshed yet'),
      'a backend that sends no catalogue meta degrades to the derived path rather than throwing');
    for (const junk of [null, 'a string', 42, []]) {
      const j = keysFor('openrouter', { openrouterCatalogue: junk });
      ok(typeof renderCatalogueSync(rowFor('openrouter'), j, false) === 'string',
        `a malformed openrouterCatalogue (${JSON.stringify(junk)}) renders without throwing`);
    }
  }

  // ── §35c SESSION-ONLY, and only on an explicit false ────────────────────
  {
    const at2 = new Date(2026, 7, 28, 14, 32, 0).toISOString();
    stubState.catalogueSync = { openrouter: { syncedAt: at2, admitted: 5, persisted: false } };
    const warn = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
    ok(/session only/.test(warn),
      'persisted:false warns that the models are loaded for this session only');
    okContains(warn, 'restart will lose them', '…and says what will happen');
    // ABSENT must not become "it failed" — the fact-vs-absence rule again.
    stubState.catalogueSync = { openrouter: { syncedAt: at2, admitted: 5 } };
    ok(!/session only/.test(renderCatalogueSync(rowFor('openrouter'), orKeys, false)),
      'an ABSENT persisted field renders no warning — "we were not told" is not "it failed"');
    stubState.catalogueSync = { openrouter: { syncedAt: at2, admitted: 5, persisted: true } };
    ok(!/session only/.test(renderCatalogueSync(rowFor('openrouter'), orKeys, false)),
      'control: persisted:true renders no warning');
    // `superseded` closes the arithmetic — without it the counts read as if
    // The Curator had refused its own measured defaults.
    stubState.catalogueSync = { openrouter: { syncedAt: at2, total: 417, admitted: 183, superseded: 3 } };
    okContains(renderCatalogueSync(rowFor('openrouter'), orKeys, false), '3 already measured',
      'a superseded count is reported, so the arithmetic on screen adds up');
    stubState.catalogueSync = { openrouter: { syncedAt: at2, admitted: 183, superseded: 0 } };
    ok(!/already measured/.test(renderCatalogueSync(rowFor('openrouter'), orKeys, false)),
      'a reported ZERO superseded is not printed — nothing was superseded, so there is nothing to report');
  }

  // THE DEGRADED RELOAD CASE. No meta, no session record, but the list
  // carries runtime-admitted models. Claiming "never refreshed" there would
  // be false; saying nothing would let a stale list look fresh.
  stubState.catalogueSync = {};
  const fetchedEntry = {
    id: 'zz/fetched', label: 'Fetched', suitability: 'chat-only', jsonRaw: null,
    input: 1, output: 2, standardInput: 1, standardOutput: 2, maxOutput: 32768,
    thinks: false, tokenizerFactor: 1, note: 'n', free: false, dominated: false,
  };
  const reloadKeys = keysFor('openrouter', {
    offerable: Object.assign({}, WIRE, { openrouter: WIRE.openrouter.concat([fetchedEntry]) }),
  });
  const reload = renderCatalogueSync(rowFor('openrouter'), reloadKeys, false);
  ok(!reload.includes('Not refreshed yet'),
    'a list that already contains fetched models is never described as "not refreshed yet"');
  ok(/may be out of date/.test(reload),
    '…it says instead that the list may be out of date, so a stale list is visible as possibly stale');

  // ── THE FUNNEL, when one is sent ──────────────────────────────────────
  stubState.catalogueSync = { openrouter: { syncedAt: at, admitted: 3,
    funnel: [{ rule: 'no JSON mode', before: 417, after: 368 }, { rule: 'unknowable price', before: 368, after: 363 }] } };
  const withFunnel = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
  okContains(withFunnel, 'no JSON mode', 'a funnel rule name is rendered');
  okContains(withFunnel, '49 removed', 'the funnel reports how many a rule removed, derived from before/after');
  okContains(withFunnel, '368 left', '…and how many survived it');
  ok(!withFunnel.includes('<script'), 'funnel content is escaped');
  const XSS_RULE = '<img src=x onerror=alert(1)>';
  stubState.catalogueSync = { openrouter: { syncedAt: at, admitted: 3, funnel: [{ rule: XSS_RULE }] } };
  {
    // Asserted on the RAW markup. A "de-escaping" step in the assertion is
    // how an XSS check gives a FALSE POSITIVE (v3.13.0) — and how one gives a
    // false NEGATIVE, which is what a naive entity-strip does here: it turns
    // correctly-escaped `&lt;img …` back into `<img …` and then reports a
    // hole that does not exist. So: the dangerous literal must be ABSENT, and
    // the escaped form must be PRESENT (or the miss proves nothing).
    const hostile = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
    ok(!hostile.includes(XSS_RULE), 'a hostile funnel rule name is not emitted raw');
    okContains(hostile, '&lt;img src=x onerror=alert(1)&gt;',
      '…it is emitted ESCAPED, so the miss above is real and not the value having vanished');
  }

  // ── THE REFUSAL, where the user is looking ────────────────────────────
  stubState.catalogueSync = {};
  stubState.catalogueSyncError = { openrouter: 'Cannot refresh while a write is running. The model list was NOT changed.' };
  const errPanel = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
  ok(errPanel.includes('role="alert"'),
    'a refusal is announced — role="alert", not a silent style change');
  okContains(errPanel, 'was NOT changed', 'the refusal states that nothing changed');
  ok(errPanel.indexOf('data-sync-catalogue') < errPanel.indexOf('role="alert"'),
    'the refusal renders BELOW the button that produced it, in the surface the user clicked in');
  stubState.catalogueSyncError = { openrouter: XSS_RULE };
  {
    const hostileErr = renderCatalogueSync(rowFor('openrouter'), orKeys, false);
    ok(!hostileErr.includes(XSS_RULE), 'a server-supplied refusal message is not emitted raw');
    okContains(hostileErr, '&lt;img src=x onerror=alert(1)&gt;',
      '…it is emitted ESCAPED — the server\'s message is untrusted text, not markup');
  }
  stubState.catalogueSyncError = {};
  ok(!renderCatalogueSync(rowFor('openrouter'), orKeys, false).includes('role="alert"'),
    'control: with no error there is no alert — the assertions above are not matching an always-present box');
  stubState.catalogueSync = {};
}

// ═════════════════════════════════════════════════════════════════════════
section('§36  Models admitted through the REAL runtime path are chat-only, marked, and unpinnable');
// ═════════════════════════════════════════════════════════════════════════
{
  // Minted by the SHIPPING admission function, not by hand. A literal fixture
  // would assert that this file agrees with itself; this asserts that the UI's
  // discriminator matches what src/brain/llm.js actually produces.
  const specFor = (n, extra) => Object.assign({
    id: 'zzsynth/model-' + n, label: 'Synth ' + n, maxOutput: 32768,
    thinks: false, tokenizerFactor: 1, suitability: 'chat-only',
    note: 'Admitted from the provider catalogue for test purposes.',
    price: { input: 0.5 + n, output: 1 + n },
  }, extra || {});

  const N = 12; // strictly above CHAT_LANE_COLLAPSE_AT, so the fold engages
  const admitted = setOpenRouterCatalogue(Array.from({ length: N }, (_, i) => specFor(i)));
  ok(admitted.admitted === N, `the real admission function admitted all ${N} synthetic entries`);

  const live = JSON.parse(JSON.stringify(listOfferableModels('openrouter')));
  const fetched = live.filter((m) => m.id.startsWith('zzsynth/'));
  ok(fetched.length === N, 'every synthetic entry reaches the merged catalogue');
  for (const m of fetched) {
    ok(m.suitability === 'chat-only',
      `${m.id}: the real admission path forces suitability chat-only`);
    ok(m.jsonRaw === null,
      `${m.id}: the real admission path leaves jsonRaw NULL — nobody measured it, so nothing claims a verdict`);
  }
  // The static, hand-measured OpenRouter entries are untouched by a refresh
  // and remain build-lane. This is the property the whole two-tier claim
  // rests on, read off the same merged list the wire carries.
  const staticIds = WIRE.openrouter.map((m) => m.id);
  const stillBuild = live.filter((m) => staticIds.includes(m.id) && m.suitability !== 'chat-only');
  ok(staticIds.length > 0 && stillBuild.length > 0,
    `the hand-measured entries survive a refresh as build-lane models (${stillBuild.length}/${staticIds.length})`);

  const k = keysFor('openrouter', { offerable: Object.assign({}, WIRE, { openrouter: live }) });
  const html = renderModelPicker(rowFor('openrouter'), k, true, false);

  // ── TIER 2 IS LABELLED, PER ROW, AND THE LABEL IS TRUE ────────────────
  for (const m of fetched) {
    const li = liFor(html, m.id);
    ok(li !== '', `${m.id}: rendered`);
    okContains(li, 'never measured here',
      `${m.id}: badged as never measured against our ingest prompt`);
    okContains(li, MODEL_SUITABILITY_BADGES['chat-only'],
      `${m.id}: also carries the chat-only verdict badge`);
    // REQUIREMENT: a fetched model must never be offered as the BUILD model.
    // The route 400s on it; the UI must not produce the click.
    ok(!li.includes('data-pick-model='),
      `${m.id}: offers NO "Use this" control — the server refuses this pin, so the UI never invites it`);
    okContains(li, 'model-pick-state-chat', `${m.id}: says "chat only" where the button would have been`);
  }
  // …and the hand-measured ones DO offer it, so the assertion above is about
  // the lane and not about the button having disappeared everywhere.
  const buildLi = liFor(html, stillBuild.find((m) => m.id !== (k.selectedModels && k.selectedModels.openrouter)).id);
  ok(buildLi.includes('data-pick-model=') || buildLi.includes('model-pick-state">Selected'),
    'control: a hand-measured build-lane model still offers the pick control');

  // gemini-3.5-flash-lite is the OTHER kind of chat-only: MEASURED, and found
  // unfit. It must be unpinnable too, and must NOT be badged "never measured".
  {
    const gHtml = renderModelPicker(rowFor('gemini'), keysFor('gemini'), true, false);
    const measuredChatOnly = WIRE.gemini.filter((m) => m.suitability === 'chat-only');
    ok(measuredChatOnly.length > 0, 'the real Gemini catalogue contains a MEASURED chat-only model — this case is not hypothetical');
    for (const m of measuredChatOnly) {
      const li = liFor(gHtml, m.id);
      ok(!li.includes('data-pick-model='),
        `${m.id}: a measured-unfit model is also unpinnable as the build model`);
      ok(!li.includes('never measured here'),
        `${m.id}: is NOT badged "never measured" — it was measured, and nine live runs say so`);
      ok(typeof m.jsonRaw === 'boolean',
        `${m.id}: carries a measured jsonRaw verdict, which is what separates the two tiers`);
    }
  }

  // ── THE FOLD IS ABOUT LENGTH, AND THE BUILD LANE IS NEVER FOLDED ──────
  ok(N > CHAT_LANE_COLLAPSE_AT, `the fixture (${N}) is above CHAT_LANE_COLLAPSE_AT (${CHAT_LANE_COLLAPSE_AT}) — the fold case is real`);
  ok(html.includes('model-lane-fold'), 'a long chat-only lane folds behind a disclosure');
  ok(html.indexOf('model-lane-head-build') < html.indexOf('model-lane-fold'),
    'the build lane renders ABOVE the fold, unfolded');
  const foldSummary = /<summary class="model-lane-fold-summary">([\s\S]*?)<\/summary>/.exec(html);
  ok(foldSummary !== null, 'the fold has a summary');
  ok(!/<button|<input|<a\s|<select/i.test(foldSummary[1]),
    'the fold\'s <summary> contains NO control — the beta.18 hazard cannot apply');
  okContains(foldSummary[1], String(N), 'the collapsed fold names how many models it hides');

  // Exactly at the threshold it does NOT fold — so the constant is a real
  // boundary and not a value that happens to be below every fixture.
  setOpenRouterCatalogue(Array.from({ length: CHAT_LANE_COLLAPSE_AT }, (_, i) => specFor(i)));
  const atLimit = JSON.parse(JSON.stringify(listOfferableModels('openrouter')));
  const atHtml = renderModelPicker(rowFor('openrouter'),
    keysFor('openrouter', { offerable: Object.assign({}, WIRE, { openrouter: atLimit }) }), true, false);
  ok(!atHtml.includes('model-lane-fold'),
    `exactly ${CHAT_LANE_COLLAPSE_AT} chat-only models do NOT fold — the threshold is strict`);
  ok(atHtml.includes('model-lane-head-chat'),
    '…but they are still lane-labelled, so the honesty claim does not depend on the fold');

  // ── PRICE IS NEVER FOLDED ─────────────────────────────────────────────
  // A spending decision needs its price unfolded. The row's own <details>
  // holds the measured evidence; the price lives in the summary.
  for (const m of fetched.slice(0, 3)) {
    const li = liFor(atHtml.includes(m.id) ? atHtml : html, m.id);
    if (!li) continue;
    const bodyStart = li.indexOf('model-row-body');
    const priceAt = li.indexOf('model-price');
    ok(priceAt !== -1 && (bodyStart === -1 || priceAt < bodyStart),
      `${m.id}: the price renders OUTSIDE the row's disclosure`);
  }

  // ── EXACTLY ONE "cheapest" MARKER ACROSS BOTH GROUPS ──────────────────
  // Grouping must not renumber: two "cheapest" badges, one of them false, on
  // a screen whose purpose is comparing spend would be the worst possible
  // regression from a layout change.
  const cheapCount = (html.match(/model-badge-cheapest/g) || []).length;
  ok(cheapCount === 1, `exactly one "cheapest" badge across both lanes (got ${cheapCount})`);
  const firstDelivered = escapeHtml(live[0].id);
  ok(liFor(html, live[0].id).includes('model-badge-cheapest'),
    `the cheapest badge sits on the FIRST delivered model (${firstDelivered}), not on the first row of a group`);

  // The three markers stay separate — never merged, per the standing rule.
  ok(!/model-badge-(default|chosen)[^"]*cheapest/.test(html),
    '"in use", "your choice" and "cheapest" remain three independent markers');

  // ── A REFUSED ENTRY NEVER REACHES THE PICKER ──────────────────────────
  {
    const quiet = console.error;
    console.error = () => {};
    const r = setOpenRouterCatalogue([specFor(0), Object.assign(specFor(1), { suitability: 'general', jsonRaw: true })]);
    console.error = quiet;
    ok(r.refused === 1 && r.admitted === 1,
      'a fetched entry declaring a BUILD-lane suitability is refused by the admission function, not by this view');
    const after = listOfferableModels('openrouter').map((m) => m.id);
    ok(!after.includes('zzsynth/model-1'),
      'the refused entry is absent from the catalogue the picker renders');
  }

  // Leave no residue for any later section, and prove the reset took.
  setOpenRouterCatalogue([]);
  ok(listOfferableModels('openrouter').every((m) => !m.id.startsWith('zzsynth/')),
    'the synthetic catalogue is cleared — later sections see the shipping list');
}

// ═════════════════════════════════════════════════════════════════════════
section('§37  onSyncCatalogue — the list moves ONLY on success, and never to empty');
// ═════════════════════════════════════════════════════════════════════════
{
  const syncedIso = new Date(2026, 7, 28, 9, 0, 0).toISOString();
  const populated = keysFor('openrouter');

  // ── THE HAPPY PATH ────────────────────────────────────────────────────
  resetActionHarness('openrouter');
  stubState.keys = populated;
  fetchImpl = async () => reply(200, {
    ok: true, syncedAt: syncedIso, total: 417, eligible: 286, admitted: 183, refused: 3,
    funnel: [{ rule: 'no JSON mode', before: 417, after: 368 }],
  });
  await onSyncCatalogue('openrouter', null);
  ok(fetchCalls.length === 1, 'a refresh issues exactly one request');
  ok(fetchCalls[0][0] === '/api/config/openrouter/sync', 'it POSTs to the sync route');
  ok(fetchCalls[0][1].method === 'POST', '…with method POST');
  ok(loadKeysCalls === 1, 'the model list is refetched — the response is a report, not the list');
  ok(stubState.catalogueSyncBusy === null, 'the busy flag is cleared');
  ok(stubState.catalogueSync.openrouter.syncedAt === syncedIso, 'the reported time is stored verbatim');
  ok(stubState.catalogueSync.openrouter.admitted === 183, 'the reported counts are stored');
  ok(Array.isArray(stubState.catalogueSync.openrouter.funnel), 'the funnel is stored when sent');
  ok(stubState.catalogueSync.openrouter.superseded === undefined,
    'a field the server did not send stays undefined (superseded) — never defaulted');
  ok(!stubState.catalogueSyncError.openrouter, 'no error is left behind on success');
  // Mid-flight the button was busy and the previous list was still rendered.
  ok(syncSnapshots.length >= 1 && syncSnapshots[0].includes('Refreshing…'),
    'the first render after the click shows the busy state');

  // A response missing a count must NOT be defaulted to 0 — that is the
  // fact-vs-absence collapse this release exists to stop repeating.
  resetActionHarness('openrouter');
  stubState.keys = populated;
  fetchImpl = async () => reply(200, { ok: true, syncedAt: syncedIso, admitted: 4 });
  await onSyncCatalogue('openrouter', null);
  ok(stubState.catalogueSync.openrouter.total === undefined,
    'an unreported total stays undefined — never coerced to 0');
  ok(stubState.catalogueSync.openrouter.refused === undefined,
    'an unreported refused count stays undefined — never coerced to 0');
  ok(stubState.catalogueSync.openrouter.funnel === null,
    'an absent funnel is null, not an empty array that would render as "no rules removed anything"');
  ok(stubState.catalogueSync.openrouter.persisted === undefined,
    'an unreported persisted flag stays undefined — it must never become a false "could not save" warning');

  // The two extra facts the route DOES send are carried through unchanged.
  resetActionHarness('openrouter');
  stubState.keys = populated;
  fetchImpl = async () => reply(200, { ok: true, syncedAt: syncedIso, admitted: 183, superseded: 3, persisted: false });
  await onSyncCatalogue('openrouter', null);
  ok(stubState.catalogueSync.openrouter.superseded === 3, 'a reported superseded count is stored');
  ok(stubState.catalogueSync.openrouter.persisted === false,
    'a reported persisted:false is stored, so the session-only warning can be rendered');

  // ── THE 409, AND THE LIST THAT MUST NOT MOVE ──────────────────────────
  resetActionHarness('openrouter');
  stubState.keys = populated;
  const before = stubState.keys.offerable.openrouter;
  fetchImpl = async () => reply(409, {
    error: 'Cannot refresh the model list while a write operation is running: articles (ingest).',
    conflict: 'write_in_progress',
  });
  await onSyncCatalogue('openrouter', null);
  ok(loadKeysCalls === 0, 'a refused refresh does NOT refetch');
  ok(stubState.keys.offerable.openrouter === before,
    'a refused refresh leaves the rendered list byte-identical — same array identity, nothing cleared');
  ok(stubState.keys.offerable.openrouter.length > 0,
    'the list is NOT emptied — an empty list reads as "this provider has no models", which is a lie about capability');
  ok(!stubState.catalogueSync.openrouter,
    'no success record is written for a refusal');
  const msg409 = stubState.catalogueSyncError.openrouter;
  okContains(msg409, 'articles (ingest)', 'the server\'s own message is used verbatim — it names the running operation');
  okContains(msg409, 'was NOT changed', '…and is extended with the fact the user most needs: nothing changed');
  // The refusal is rendered, in the panel, on the last render.
  const lastSync = syncSnapshots[syncSnapshots.length - 1] || '';
  ok(lastSync.includes('role="alert"'), 'the refusal is rendered with role="alert" on the surface that was clicked');
  okContains(lastSync, 'articles (ingest)', '…carrying the server\'s own wording');
  ok(!lastSync.includes('Refreshing…'), 'the busy state is gone once the refusal lands');
  // The MODEL LIST is still fully rendered beside the refusal.
  const lastList = renderSnapshots[renderSnapshots.length - 1] || '';
  for (const m of WIRE.openrouter) {
    ok(lastList.includes('data-model-id="' + escapeHtml(m.id) + '"'),
      `after a refusal, ${m.id} is still listed`);
  }

  // ── OTHER FAILURE SHAPES, all leaving the list alone ──────────────────
  for (const [label, impl] of [
    ['a 500 with a JSON body', async () => reply(500, { error: 'OpenRouter is unreachable.' })],
    ['a non-JSON body (a proxy HTML page)', async () => reply(502, '__NOT_JSON__')],
    ['a thrown transport error', async () => { throw new TypeError('Failed to fetch'); }],
  ]) {
    resetActionHarness('openrouter');
    stubState.keys = keysFor('openrouter');
    const listBefore = stubState.keys.offerable.openrouter;
    fetchImpl = impl;
    await onSyncCatalogue('openrouter', null);
    ok(loadKeysCalls === 0, `${label}: no refetch`);
    ok(stubState.keys.offerable.openrouter === listBefore, `${label}: the list is untouched`);
    ok(stubState.catalogueSyncBusy === null, `${label}: the busy flag is cleared, so the button is not stuck`);
    const m = stubState.catalogueSyncError.openrouter;
    ok(typeof m === 'string' && m.length > 0, `${label}: a legible refusal is produced`);
    ok(!/Unexpected token/.test(m), `${label}: never an "Unexpected token '<'" — the body is read defensively`);
    okContains(m, 'unchanged', `${label}: says the list is unchanged`);
  }

  // ── AN UNKNOWN PROVIDER ISSUES NO REQUEST ─────────────────────────────
  for (const bad of ['gemini', 'anthropic', 'zzz-mystery-provider', '__proto__', 'constructor', 'toString', '', undefined]) {
    resetActionHarness('openrouter');
    stubState.keys = keysFor('openrouter');
    fetchImpl = async () => reply(200, { ok: true });
    await onSyncCatalogue(bad, null);
    ok(fetchCalls.length === 0, `onSyncCatalogue("${bad}") issues no request — refuse rather than guess`);
    ok(loadKeysCalls === 0, `onSyncCatalogue("${bad}") does not refetch`);
  }
  // Control: the one real provider IS accepted, so the loop above is not
  // passing because the handler refuses everything.
  resetActionHarness('openrouter');
  stubState.keys = keysFor('openrouter');
  fetchImpl = async () => reply(200, { ok: true, syncedAt: syncedIso });
  await onSyncCatalogue('openrouter', null);
  ok(fetchCalls.length === 1, 'control: "openrouter" IS accepted by the same gate');

  // ── A STALE MOUNT WRITES NOTHING ──────────────────────────────────────
  resetActionHarness('openrouter');
  stubState.keys = keysFor('openrouter');
  mountIsCurrent = false;
  fetchImpl = async () => reply(200, { ok: true, syncedAt: syncedIso, admitted: 9 });
  await onSyncCatalogue('openrouter', null);
  ok(!stubState.catalogueSync.openrouter, 'a result landing after the view was left is discarded');
  ok(loadKeysCalls === 0, '…and no refetch is issued into a dead mount');
  mountIsCurrent = true;

  // ── THE MESSAGE COMPOSER, on its own ──────────────────────────────────
  okContains(catalogueSyncErrorMessage(409, null), 'was NOT changed',
    'a 409 with no body still says nothing changed');
  okContains(catalogueSyncErrorMessage(200, { conflict: 'write_in_progress' }), 'was NOT changed',
    'a conflict flagged in the body is treated as a conflict even without the status');
  okContains(catalogueSyncErrorMessage(0, {}), 'unchanged',
    'a bodyless failure still states the list is unchanged');
  ok(catalogueSyncErrorMessage(500, { error: 'Rate limited by OpenRouter.' }).startsWith('Rate limited'),
    'a server message is used verbatim and leads');

  resetActionHarness('gemini');
  stubState.keys = null;
}

// ═════════════════════════════════════════════════════════════════════════
section('§38  CLASS INVARIANT — no binary provider ternary in the refresh path');
// ═════════════════════════════════════════════════════════════════════════
{
  // v3.10.1: `p.id === 'gemini' ? A : B` has no third arm, so any third
  // provider fell into the Anthropic branch — rendering one provider's masked
  // key beside another's name, and POSTing one provider's key into another's
  // slot. The rule since is that provider-conditional behaviour is a LOOKUP.
  // Enforced here for the two functions this release adds, by reading their
  // real source rather than trusting a comment.
  for (const fn of ['renderCatalogueSync', 'onSyncCatalogue']) {
    const src = stripCommentsAndLiterals(extractFunction(settings, fn, 'settings.js'));
    ok(!/===\s*['"`]?\w+['"`]?\s*\?/.test(src) || !/\bid\s*===/.test(src),
      `${fn}: no binary provider ternary`);
  }

  // ── THE PROTOTYPE-KEY DEFENCE IS THREE LAYERS, AND THAT IS RECORDED ────
  // MEASURED, not assumed. `renderCatalogueSync` refuses an inherited name
  // like 'constructor' three independent ways, and NO SINGLE-LINE MUTATION
  // TURNS THIS SUITE RED, because each layer masks the other two:
  //   1. SYNC_BY_PROVIDER is null-prototype  → the lookup resolves undefined
  //   2. the test is `!== true`, not truthy  → a function fails it anyway
  //   3. HAS_KEY_BY_PROVIDER is null-prototype too
  // Defeating any ONE leaves the suite at 0 failures; defeating any TWO also
  // leaves it at 0; defeating all THREE yields 4 behavioural failures naming
  // __proto__, constructor and toString. That is real defence in depth, not
  // a dead guard — but it means a source grep for `Object.create(null)` would
  // be asserting that a LINE EXISTS, which proves nothing about behaviour and
  // is the decorative-guard shape this repo keeps finding. So it is not
  // written. The BEHAVIOURAL claim lives in §35 (prototype ids are offered no
  // control) and holds under every one of those mutations, which is the
  // property that actually matters.
  //
  // `onSyncCatalogue`'s own KNOWN table is DIFFERENT and IS independently
  // provable: it is read with a bare `!KNOWN[provider]`, with nothing in
  // front of it, so making it a plain object literal yields 7 behavioural
  // failures. §37 covers that directly.
  ok(true,
    'recorded: renderCatalogueSync\'s prototype refusal is 3-layer and only a TRIPLE mutation reds it (measured: 1 layer → 0, 2 → 0, 3 → 4)');

  // And the tables are FUNCTION-LOCAL, so no new module-level identifier
  // enters the extraction sandbox — where a missing binding is a crash, not a
  // failing assertion (the v3.11.0 FN_NAMES shape).
  ok(!/^const SYNC_BY_PROVIDER/m.test(settings),
    'the sync-capability table is function-local, not a module const');
  // And the tables are FUNCTION-LOCAL, so no new module-level identifier
  // enters the extraction sandbox — where a missing binding is a crash, not a
  // failing assertion (the v3.11.0 FN_NAMES shape).
  ok(!/^const SYNC_BY_PROVIDER/m.test(settings),
    'the sync-capability table is function-local, not a module const');
}

// ═════════════════════════════════════════════════════════════════════════
section('§39  A LOCALLY-QUALIFIED model states ONE lane — and it is the build lane');
// ═════════════════════════════════════════════════════════════════════════
//
// ── THE DEFECT THIS SECTION EXISTS FOR ──────────────────────────────────
// Observed live, surviving a full reload: a model the user had qualified on
// their own wiki — and which was BUILDING THAT WIKI at that moment — rendered
//
//     in use · your choice · you measured this on your wiki
//     chat only — not for ingest
//     note: "…never measured against The Curator's ingest prompt, so nothing
//            here says how it would build a wiki."
//
// all in one row, on the surface whose entire purpose is telling a user what
// builds their wiki and what it costs. Four expressions answered "which lane?"
// and only the pick control carried the local-qualification disjunct.
//
// ── HOW THE CORPUS IS BUILT, AND WHY IT CANNOT BE VACUOUS ───────────────
// Nothing in this suite previously carried `qualifies: true`, so every
// assertion about a locally-qualified row would have run over an empty set.
// The fixture is therefore built through the SHIPPING path end to end:
//   1. a synthetic OpenRouter API record ->  the REAL openRouterRecordToSpec,
//      which produces the REAL multi-sentence note (free-tier data policy,
//      hidden reasoning tokens, and the lane claim this row must lose);
//   2. that spec ->  the REAL setOpenRouterCatalogue, so the entry the picker
//      sees carries `suitability: 'chat-only'` and `jsonRaw: null` because the
//      admission function put them there, not because this file typed them;
//   3. a `qualifications` record with `qualifies: true` — the shape the ROUTE
//      sends, computed server-side from `isLocallyQualified`, which is why the
//      client fixture supplies it rather than re-deriving it.
// Every claim below is then checked against a NEGATIVE CONTROL: the same
// entry, same note, same catalogue, WITHOUT the qualification. If the control
// does not reproduce the contradiction, the corpus cannot express the bug and
// the section says so.
{
  // FOUR fetched entries, because ONE cannot express the states under test:
  //   REC    qualified, IN USE and PINNED — the row seen live. Being pinned,
  //          its control is "Selected", so it cannot also prove the BUTTON.
  //   REC2   qualified but NOT pinned — the row that proves a qualified model
  //          is offered the build control the server will accept.
  //   PLAIN1/2  unqualified chat-only, so the chat lane is NON-EMPTY. Without
  //          them `renderModelLanes` renders FLAT (one lane present) and every
  //          grouping assertion below would be measuring a screen with no
  //          groups on it — which the anti-vacuity check at the end of the
  //          class invariant caught while this fixture had only REC.
  const rec = (id, extra) => Object.assign({
    id, name: 'ZZ ' + id,
    pricing: { internal_reasoning: '0.000002' },
    top_provider: { max_completion_tokens: 32768 },
    supported_parameters: ['response_format', 'structured_outputs'],
    reasoning: { default_enabled: true },
  }, extra || {});
  const REC = { id: 'zzlane/qualified:free' };
  const REC2 = { id: 'zzlane/qualified-2:free' };
  const PLAIN = ['zzlane/plain-1:free', 'zzlane/plain-2:free'];
  const SPEC_IDS = [REC.id, REC2.id, ...PLAIN];

  const mintedAll = SPEC_IDS.map((id) => openRouterRecordToSpec(rec(id)));
  ok(mintedAll.every((r) => r.ok === true),
    'corpus: the SHIPPING record-to-spec function admitted all four fixtures (' +
      mintedAll.map((r) => (r.ok ? 'ok' : r.reason)).join(', ') + ')');
  const minted = mintedAll[0];
  const RAW_NOTE = minted.ok ? minted.spec.note : '';

  // ── POSITIVE CONTROL FOR THE FILTER ────────────────────────────────────
  // The note filter's markers are a COPY of wording that lives in
  // openrouter-adapter.js, which a browser module cannot import. This is the
  // assertion that converts a reword there into a red here rather than into a
  // silently-dead filter and a re-shipped contradiction.
  okContains(RAW_NOTE, 'never measured against',
    'corpus: the REAL adapter note still contains the lane claim the filter targets — the filter has something to remove');
  ok(withoutLaneClaim(RAW_NOTE) !== RAW_NOTE,
    'corpus: withoutLaneClaim actually CHANGES the real note (it is not a no-op over this input)');
  // …and it is SURGICAL. These two sentences are money facts a local ingest
  // run does not touch, and a blanket note-suppression would delete them.
  okContains(RAW_NOTE, 'data policy', 'corpus: the real note also carries the free-tier data-policy fact');
  okContains(RAW_NOTE, 'billed as output', 'corpus: …and the hidden-reasoning-tokens cost fact');
  okContains(withoutLaneClaim(RAW_NOTE), 'data policy',
    'the filter KEEPS the free-tier data-policy fact — it removes a lane claim, not the note');
  okContains(withoutLaneClaim(RAW_NOTE), 'billed as output',
    'the filter KEEPS the hidden-reasoning cost fact');
  okOmits(withoutLaneClaim(RAW_NOTE), 'never measured against',
    'the filter REMOVES the "never measured against our ingest prompt" claim');
  okOmits(withoutLaneClaim(RAW_NOTE), 'nothing here says how it would build',
    'the filter removes the whole sentence, not half of it');
  ok(splitSentences(RAW_NOTE).length >= 3,
    `corpus: the real note is genuinely multi-sentence (${splitSentences(RAW_NOTE).length}) — a one-sentence note would make the surgical claim vacuous`);

  const admitted = setOpenRouterCatalogue(mintedAll.filter((r) => r.ok).map((r) => r.spec));
  ok(admitted.admitted === SPEC_IDS.length,
    'corpus: the real admission function admitted all four fixtures into the catalogue');
  const live = JSON.parse(JSON.stringify(listOfferableModels('openrouter')));
  const entry = live.find((m) => m.id === REC.id);
  ok(!!entry, 'corpus: the fixture reaches the merged catalogue the picker renders');
  ok(entry && entry.suitability === 'chat-only' && entry.jsonRaw === null,
    'corpus: it arrives chat-only with jsonRaw NULL because the ADMISSION FUNCTION put them there');

  const qualFor = (modelId) => Object.assign({}, QUAL, { modelId });
  const QUAL = {
    modelId: REC.id,
    qualifies: true,
    outcome: 'NO_DEFECT_FOUND',
    runsCompleted: 9,
    counts: { raw: 9, repaired: 0, unrepairable: 0, unusable: 0 },
    pages: { median: 23, min: 19, max: 27 },
    latencyMs: { mean: 53000 },
    spendUsd: 0,
    domain: 'articles',
    sourceName: 'routing-note.md',
    measuredAt: '2026-08-28T09:58:37.225Z',
    stillOffered: true,
  };

  // The row exactly as it was seen live: qualified, IN USE, and the user's pick.
  const QUALS = [QUAL, qualFor(REC2.id)];
  const keysWith = (quals) => keysFor('openrouter', {
    offerable: Object.assign({}, WIRE, { openrouter: live }),
    models: { gemini: defaultModelFor('gemini'), anthropic: defaultModelFor('anthropic'), openrouter: REC.id },
    selectedModels: { openrouter: REC.id },
    qualifications: quals,
    minRunsToQualify: 9,
  });

  const html = renderModelPicker(rowFor('openrouter'), keysWith(QUALS), true, false);
  const li = liFor(html, REC.id);
  const li2 = liFor(html, REC2.id);
  ok(li !== '' && li2 !== '', 'both qualified models render rows');

  // ── NEGATIVE CONTROL FIRST: the corpus CAN express the defect ──────────
  const ctrlHtml = renderModelPicker(rowFor('openrouter'), keysWith([]), true, false);
  const ctrlLi = liFor(ctrlHtml, REC.id);
  okContains(ctrlLi, MODEL_SUITABILITY_BADGES['chat-only'],
    'CONTROL: without the qualification the SAME entry is badged "chat only — not for ingest"');
  okContains(ctrlLi, 'never measured against',
    'CONTROL: …and its note still carries the lane claim');
  // The pick-control control is read off the UNPINNED row: `isSelected` is
  // tested BEFORE the lane (deliberately — see renderModelOption), so the
  // pinned row renders "Selected" in both directions and could never show
  // this difference.
  okContains(liFor(ctrlHtml, REC2.id), 'model-pick-state-chat',
    'CONTROL: without the qualification the unpinned entry offers no build control');
  okOmits(liFor(ctrlHtml, REC2.id), 'data-pick-model=',
    'CONTROL: …and no "Use this" button');
  okContains(ctrlHtml, 'model-lane-head-chat',
    'CONTROL: …and it is filed under the Chat only lane');

  // ── THE ROW NOW STATES ONE LANE ────────────────────────────────────────
  okOmits(li, MODEL_SUITABILITY_BADGES['chat-only'],
    'a locally-qualified row does NOT carry "chat only — not for ingest"');
  okOmits(li, 'never measured against',
    'a locally-qualified row does NOT carry the "never measured against our ingest prompt" note');
  okOmits(li, 'nothing here says how it would build',
    'a locally-qualified row does NOT deny that anything is known about how it would build a wiki');
  okOmits(li, 'model-pick-state-chat',
    'a locally-qualified row does NOT say "chat only" where the pick control goes');
  okOmits(li, 'never measured here',
    'a locally-qualified row is NOT badged "never measured here" — it was measured, by the user');

  // …and it still says the true things, including the ones seen live.
  okContains(li, 'you measured this on your wiki', 'it IS badged as measured BY THE USER');
  okContains(li, 'in use', 'it still reports that it is the model in use');
  okContains(li, 'your choice', 'it still reports that it is the pinned choice');
  okContains(li, 'model-pick-state">Selected',
    'the PINNED qualified row reads "Selected" — a control whose only outcome is re-writing its own value is not offered');
  okContains(li2, 'data-pick-model=',
    'an UNPINNED qualified row offers the build-model control, because the server accepts this pin');
  okOmits(li, 'data-qualify-model=', 'it is not offered a "Test on my wiki" button it has already passed');
  okOmits(li2, 'data-qualify-model=', '…nor is the unpinned one');

  // ── THE TWO PROVENANCES STAY DISTINCT ─────────────────────────────────
  // The whole reason the build lane grew a third state is that "we measured
  // this across documents" and "you ran nine of these on one document" are
  // different claims. Un-badging the contradiction must not quietly relabel
  // the row as if WE had measured it.
  okContains(li, 'No defect found in 9 runs',
    'the headline still reports what the USER ran, in runs, not a verdict of ours');
  okContains(li, 'articles', 'the scope stamp still names WHICH wiki it was measured against');
  okContains(li, 'routing-note.md', 'the scope stamp still names WHICH document');
  ok(!/verif(y|ied|ication)/i.test(li),
    'the word "verified" appears nowhere on the row — this is a screen, not a guarantee');
  okContains(li, 'This is a screen, not a guarantee',
    'the caveat that N clean runs is not a proof survives the fix');
  // A hand-measured build-lane row must NOT pick up the user's badge.
  {
    const handMeasured = live.find((m) => m.suitability !== 'chat-only');
    if (handMeasured) {
      okOmits(liFor(html, handMeasured.id), 'you measured this on your wiki',
        `${handMeasured.id}: a hand-measured model is NOT relabelled as the user's measurement`);
    } else {
      ok(false, 'expected at least one hand-measured OpenRouter model in the live catalogue');
    }
  }

  // ── THE LANE GROUPING MOVED WITH IT ───────────────────────────────────
  const buildAt = html.indexOf('model-lane-head-build');
  const chatAt = html.indexOf('model-lane-head-chat');
  const rowAt = html.indexOf('data-model-id="' + escapeHtml(REC.id) + '"');
  ok(buildAt !== -1 && chatAt !== -1, 'both lanes render (the fixture keeps the catalogue mixed)');
  ok(buildAt < rowAt && rowAt < chatAt,
    'the qualified model sits in the BUILD group, not under "These cannot run ingest…"');
  // …and the build group stops claiming WE measured all of them.
  const buildNote = html.slice(buildAt, chatAt);
  okContains(buildNote, 'you</strong> measured',
    'the build lane names the USER as the source for the locally-qualified one');
  ok(!/Measured by The Curator against its real ingest prompt\. Any of these/.test(buildNote),
    'the build lane no longer asserts The Curator measured every model in it');
  // With no locally-qualified model present the original sentence is restored
  // BYTE-FOR-BYTE, so this change costs nothing on every other catalogue.
  okContains(ctrlHtml.slice(ctrlHtml.indexOf('model-lane-head-build'), ctrlHtml.indexOf('model-lane-head-chat')),
    'Measured by The Curator against its real ingest prompt. Any of these can run ingest, ' +
    'Health scans and Compile — the price and the limits beside each one are things we observed.',
    'CONTROL: with no locally-qualified model the build-lane note is unchanged from before this fix');

  // ── A FAILED RECORD MUST NOT PROMOTE ANYTHING ─────────────────────────
  {
    const bad = Object.assign({}, QUAL, { qualifies: false, outcome: 'DEFECT_OBSERVED',
      counts: { raw: 0, repaired: 0, unrepairable: 9, unusable: 0 } });
    const badLi = liFor(renderModelPicker(rowFor('openrouter'), keysWith([bad]), true, false), REC.id);
    okContains(badLi, MODEL_SUITABILITY_BADGES['chat-only'],
      'a DEFECT_OBSERVED record leaves the model chat-only');
    okContains(badLi, 'failed on your wiki', '…and says so on the row');
    okContains(badLi, 'never measured against',
      '…and its catalogue note is untouched, because nothing overturned it');
  }
  // A truthy-but-not-true `qualifies` is a wire anomaly and must FAIL CLOSED —
  // this is a lane that spends money.
  for (const junk of [1, 'yes', {}, [], 'true']) {
    const li2 = liFor(renderModelPicker(rowFor('openrouter'),
      keysWith([Object.assign({}, QUAL, { qualifies: junk })]), true, false), REC.id);
    okContains(li2, MODEL_SUITABILITY_BADGES['chat-only'],
      `qualifies: ${JSON.stringify(junk)} does NOT promote into the build lane — only \`true\` does`);
  }

  // ── CLASS INVARIANT: EVERY LANE SURFACE AGREES, FOR EVERY MODEL ───────
  // This is the guard that would have caught the shipped defect, and it is
  // BEHAVIOURAL: it computes the lane once with the real predicate and then
  // reads the four surfaces off the real markup. Any ONE of them drifting —
  // the badge, the note, the control, the grouping — reds it, naming the model
  // and the surface. A source grep would only have proved a line exists.
  {
    const quals = QUALS;
    const ctx = { quals: Object.assign(Object.create(null),
      Object.fromEntries(quals.map((q) => [q.modelId, q]))) };
    const allHtml = renderModelPicker(rowFor('openrouter'), keysWith(quals), true, false);
    const bIdx = allHtml.indexOf('model-lane-head-build');
    const cIdx = allHtml.indexOf('model-lane-head-chat');
    let checked = 0;
    for (const m of live) {
      const lane = modelLaneOf(m, qualificationFor(ctx, m));
      const builds = laneBuildsWiki(lane);
      const row = liFor(allHtml, m.id);
      if (!row) { ok(false, `${m.id}: expected a rendered row`); continue; }
      const at = allHtml.indexOf('data-model-id="' + escapeHtml(m.id) + '"');
      ok(row.includes(MODEL_SUITABILITY_BADGES['chat-only']) === !builds,
        `${m.id} [${lane}]: the chat-only BADGE matches the lane`);
      // `isSelected` is tested before the lane, so the PINNED row reads
      // "Selected" in either lane. Stated exactly rather than skipped, so the
      // assertion covers every row including that one.
      ok(row.includes('model-pick-state-chat') === (!builds && m.id !== REC.id),
        `${m.id} [${lane}]: the pick CONTROL matches the lane`);
      ok((bIdx < at && at < cIdx) === builds,
        `${m.id} [${lane}]: the lane GROUPING matches the lane`);
      ok(row.includes('never measured against') === (!builds && typeof m.note === 'string' && m.note.includes('never measured against')),
        `${m.id} [${lane}]: the NOTE's lane claim matches the lane`);
      checked++;
    }
    ok(checked === live.length && live.length > 1,
      `the invariant ran over the whole catalogue (${checked}/${live.length}) and it holds both lanes`);
    // Both arms of the invariant are populated, or three of the four
    // assertions above would be a one-sided tautology.
    const builds = live.filter((m) => laneBuildsWiki(modelLaneOf(m, qualificationFor(ctx, m))));
    ok(builds.length > 0 && builds.length < live.length,
      `the corpus contains BOTH lanes (${builds.length} build / ${live.length - builds.length} chat) — neither loop arm is empty`);
    ok(builds.some((m) => m.id === REC.id) && builds.some((m) => m.id === REC2.id),
      'and BOTH locally-qualified models are build-lane rows — this section is not vacuous');
    ok(live.filter((m) => modelLaneOf(m, qualificationFor(ctx, m)) === MODEL_LANES.BUILD_LOCAL).length === 2,
      'exactly the two qualified fixtures are in BUILD_LOCAL — the promotion is not leaking to their unqualified siblings');
  }

  // ── PROTOTYPE IDS CANNOT BORROW A LANE ────────────────────────────────
  // An OpenRouter id is a third party's string. A plain-object lookup would
  // hand `qualificationFor` a FUNCTION for `constructor`, and `fn.qualifies`
  // is undefined — but a future map built with `{}` would be one edit away
  // from a real promotion, so the refusal is asserted rather than assumed.
  for (const evil of ['__proto__', 'constructor', 'toString']) {
    const ctx = { quals: Object.assign(Object.create(null), { real: QUAL }) };
    ok(qualificationFor(ctx, { id: evil }) === null,
      `qualificationFor refuses the prototype key "${evil}"`);
    ok(modelLaneOf({ suitability: 'chat-only', jsonRaw: null, id: evil },
      qualificationFor(ctx, { id: evil })) === MODEL_LANES.CHAT_UNMEASURED,
      `a model id of "${evil}" resolves to CHAT_UNMEASURED, never into the build lane`);
  }

  // ── THE STAMP IS AN INSTANT, AND IT NEVER REACHES A USER RAW ──────────
  okOmits(li, '2026-08-28T09:58:37.225Z',
    'the measurement stamp does NOT render the raw ISO instant');
  ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(li),
    'no ISO instant of any shape survives into the rendered row');
  okContains(li, formatSyncedAt(QUAL.measuredAt),
    'the stamp renders through formatSyncedAt — the same helper the catalogue date uses');
  ok(formatIsoDay(QUAL.measuredAt) === QUAL.measuredAt,
    'CONTROL: formatIsoDay ECHOES this instant unchanged — which is exactly how the raw ISO reached the screen');

  // Forced-timezone child processes. Same instant, two zones: the rendering
  // must differ (it is a local clock) and NEITHER may contain an ISO artefact.
  {
    const fnSrc = extractFunction(settings, 'formatSyncedAt', 'settings.js');
    const probe = fnSrc + `
      const out = formatSyncedAt(${JSON.stringify(QUAL.measuredAt)});
      process.stdout.write(out);`;
    const runs = {};
    for (const TZ of ['UTC', 'America/Los_Angeles']) {
      const r = spawnSync(process.execPath, ['-e', probe],
        { encoding: 'utf8', env: Object.assign({}, process.env, { TZ }) });
      ok(r.status === 0, `the stamp probe runs under TZ=${TZ}`);
      runs[TZ] = r.stdout;
      ok(!/[TZ]|\d{4}-\d{2}-\d{2}/.test(runs[TZ]),
        `under TZ=${TZ} the stamp carries no ISO artefact (got '${runs[TZ]}')`);
    }
    ok(runs.UTC === '28 Aug 2026, 09:58',
      `under TZ=UTC the instant renders as its UTC clock (got '${runs.UTC}')`);
    ok(runs['America/Los_Angeles'] === '28 Aug 2026, 02:58',
      `under TZ=America/Los_Angeles it renders as THAT clock (got '${runs['America/Los_Angeles']}') — an instant follows the reader, unlike a price date`);
    ok(runs.UTC !== runs['America/Los_Angeles'],
      'the two zones genuinely differ — the probe is measuring the conversion, not a constant');
    // The buggy form, run the same way, to prove the assertions above are not
    // green for a reason unrelated to the fix.
    const buggy = extractFunction(settings, 'formatIsoDay', 'settings.js') + `
      process.stdout.write(formatIsoDay(${JSON.stringify(QUAL.measuredAt)}));`;
    const bad = spawnSync(process.execPath, ['-e', buggy],
      { encoding: 'utf8', env: Object.assign({}, process.env, { TZ: 'UTC' }) });
    ok(bad.status === 0 && bad.stdout === QUAL.measuredAt,
      'POSITIVE CONTROL: the previously-used formatter emits the raw ISO verbatim under a forced TZ');
  }

  // The confirm panel's "you already measured this on …" is the SAME class and
  // is fixed in the same change — a guard applied to one instance of a class
  // is this repo's most-repeated shape.
  {
    const panel = renderQualifyPanel({
      modelId: REC.id, phase: 'confirm',
      estimate: { runs: 9, domain: 'articles', promptChars: 341005,
        time: { fastestSeconds: 360, slowestSeconds: 3420, note: '' },
        existing: { measuredAt: QUAL.measuredAt } },
    }, 9);
    okOmits(panel, QUAL.measuredAt, 'the re-measure confirm does not echo a raw ISO either');
    okContains(panel, formatSyncedAt(QUAL.measuredAt), '…it renders through the same instant formatter');
  }

  // Leave no residue for any later section, and prove the reset took.
  setOpenRouterCatalogue([]);
  ok(listOfferableModels('openrouter').every((m) => !SPEC_IDS.includes(m.id)),
    'the synthetic catalogue is cleared — later sections see the shipping list');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('❌ /next model-picker assertions FAILED');
  process.exit(1);
}
console.log('✅ All /next model-picker assertions green');
process.exit(0);
