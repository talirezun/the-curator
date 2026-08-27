#!/usr/bin/env node
/**
 * test-offerable-models-route.js — OFFLINE suite for the `offerable` field
 * added to GET /api/config/api-keys.
 *
 * ── What this pins ───────────────────────────────────────────────────────
 *
 * `GET /api/config/api-keys` gained an additive `offerable: { gemini: [...],
 * anthropic: [...] }` field surfacing llm.js's `OFFERABLE_MODELS` catalogue
 * (cheapest-first, one entry per pickable model) for a future model-picker UI.
 * Two existing, load-bearing response shapes had to survive the change
 * UNTOUCHED, both verified here BEHAVIOURALLY (a real route handler + a real
 * HTTP round-trip — never a source regex, per this repo's own house rule that
 * "a test that proves a line exists proves nothing about what it does"):
 *
 *   1. `models: { gemini: '<id>', anthropic: '<id>' }` MUST stay a map of
 *      STRINGS. The shipping /old frontend (src/public/app.js) renders
 *      `escHtml(models[p] || '')` in the chat model-selector dropdown, and
 *      `escHtml` begins `String(str)` — so an object/array here renders the
 *      literal text "[object Object]" in production for every /old user.
 *      Section 3 asserts `typeof res.models.gemini === 'string'` by name,
 *      and Mutation M1 (see the bottom of this file's header) proves the
 *      assertion can actually catch the regression.
 *
 *   2. `hasGeminiKey` / `hasAnthropicKey` MUST keep existing. Their absence
 *      makes the app's first-run check believe no key is configured, which
 *      re-fires the 4-step onboarding overlay (no Escape, no backdrop close,
 *      no X, no Skip on step 1 — a hard block) on every load for an
 *      already-configured user. Mutation M2 proves this.
 *
 * Also covered:
 *   - `offerable.<provider>` is an array, gated the SAME config-scoped way as
 *     hasGeminiKey/hasAnthropicKey (off getApiKeys(), never getEffectiveKey()
 *     / .env) — a Disconnected provider must not appear pickable.
 *   - Every entry in a non-empty offerable array carries the full contract
 *     shape (id, label, input, output, maxOutput, thinks, jsonRaw,
 *     tokenizerFactor, plus at least one measured-reason field beyond those
 *     eight) and the array is ordered cheapest-first by `input`.
 *   - `resolveOfferableModels()` (the exported lookup helper) cannot be made
 *     to reach `Object.prototype` / `Function.prototype` members via
 *     `__proto__` / `constructor` / `toString` / `hasOwnProperty`, and
 *     degrades to `[]` (never throws) when llm.js's OFFERABLE_MODELS export
 *     is absent, non-object, missing the requested provider key, or the
 *     provider's value is not an array.
 *   - The response never contains the actual configured key material.
 *
 * ── Why `OFFERABLE_MODELS` may not exist yet ─────────────────────────────
 *
 * This route was built to a fixed contract while a separate, concurrent
 * change adds `export const OFFERABLE_MODELS` to src/brain/llm.js. This
 * suite is written to pass in BOTH states:
 *   - if the export doesn't exist yet, `offerable.<provider>` is `[]` for a
 *     configured provider (checked explicitly in §3), and the
 *     completeness/ordering checks in §4 run only against a SYNTHETIC
 *     fixture built in this file (so they are never vacuous — see §4's own
 *     self-test, mirroring test-css-tokens.js §9b's convention that a check
 *     which can only ever report zero problems must prove elsewhere that it
 *     CAN fail);
 *   - once the export exists, §3 additionally re-runs those same validators
 *     against the REAL `offerable.gemini` / `offerable.anthropic` arrays
 *     returned over the wire, so the integration is exercised for real the
 *     moment both changes land together.
 *
 * ── Isolation ─────────────────────────────────────────────────────────────
 * CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR point at a fresh
 * tempdir, set BEFORE any app module is imported (dynamic `await import`,
 * matching test-route-write-guards.js's convention). The real credential
 * files are fingerprinted (sha256 + size + existence — no mtime, per the
 * v3.0.16 misattribution lesson) before and after the whole run and asserted
 * byte-identical. Two synthetic, obviously-fake API key strings are saved
 * into the ISOLATED config; they are never printed, only scanned-for-absence
 * in response bodies. The router is mounted on an EPHEMERAL port (`listen(0,
 * ...)`) that this same process closes before exit — never port 3333, never
 * a fixed port, no server survives the test.
 *
 * ── Mutation proof (performed manually against config.js during this
 *    session, NOT executed by this file — see the session report) ─────────
 *   M1  `models.gemini` becomes an object          → RED (§3, [object Object] hazard)
 *   M2  `hasGeminiKey` removed from the response    → RED (§3)
 *   M3  An offerable entry ships missing a field    → RED (§4)
 *   M4  Cheapest-first ordering broken              → RED (§4)
 *   M5  Raw key material leaked into the response   → RED (§5)
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { createServer } from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
/**
 * Equality assertion that PRINTS BOTH SIDES on failure. `ok(a === b, '…')`
 * tells you a pin moved but not what it moved to, so the first thing anyone
 * does with that red is re-run it by hand. Uses Object.is so a stray NaN or -0
 * cannot read as equal.
 */
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), Object.is(actual, expected)
    ? label
    : `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// Isolation FIRST — before any app module is imported.
// ─────────────────────────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-offerable-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });

process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;

const REAL_FILES = [
  '.curator-config.json', '.sync-config.json', '.sharedbrain-config.json',
].map(f => path.join(REPO_ROOT, f));

function fingerprint() {
  // sha256 + size + existence ONLY — no mtime (v3.0.16 misattribution lesson:
  // the maintainer's live :3333 app rewrites .curator-config.json during
  // ordinary use, which would make an mtime-sensitive guard flake).
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

const { default: configRouter, resolveOfferableModels } = await import('../src/routes/config.js');
const llmModule = await import('../src/brain/llm.js');
const { default: express } = await import('express');

console.log('test-offerable-models-route.js — GET /api/config/api-keys `offerable` field\n');

// ─────────────────────────────────────────────────────────────────────────
// §1. resolveOfferableModels() — pure-function hardening
// ─────────────────────────────────────────────────────────────────────────
section('§1. resolveOfferableModels() — safe lookup, never throws, never leaks the prototype chain');

const GOOD_ENTRY_GEMINI = Object.freeze({
  id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite',
  input: 0.10, output: 0.40, maxOutput: 65536,
  thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
  chatSuitabilityReason: 'measured: cheapest model that stayed under the 4096-token chat cap on all 20 sample questions',
});
const GOOD_ENTRY_GEMINI_2 = Object.freeze({
  id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite',
  input: 0.25, output: 1.50, maxOutput: 65536,
  thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
  chatSuitabilityReason: 'measured: 2.5x/3.75x costlier than the default but the next verified-live rung',
});
const SYNTHETIC_TABLE = Object.freeze({
  gemini: Object.freeze([GOOD_ENTRY_GEMINI, GOOD_ENTRY_GEMINI_2]),
  anthropic: Object.freeze([
    Object.freeze({
      id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5',
      input: 1.00, output: 5.00, maxOutput: 64000,
      thinks: false, jsonRaw: false, tokenizerFactor: 1.361,
      chatSuitabilityReason: 'measured: current default, cheapest verified-live Anthropic model',
    }),
  ]),
});

{
  const g = resolveOfferableModels(SYNTHETIC_TABLE, 'gemini');
  ok(Array.isArray(g) && g.length === 2, 'well-formed table: returns the real gemini array');
  ok(g[0] === GOOD_ENTRY_GEMINI && g[1] === GOOD_ENTRY_GEMINI_2, 'well-formed table: entries are the exact objects, in order (no copying/reordering)');

  const a = resolveOfferableModels(SYNTHETIC_TABLE, 'anthropic');
  ok(Array.isArray(a) && a.length === 1, 'well-formed table: returns the real anthropic array');
}

ok(Array.isArray(resolveOfferableModels(undefined, 'gemini')) && resolveOfferableModels(undefined, 'gemini').length === 0,
  'undefined table (OFFERABLE_MODELS not yet exported by llm.js) -> [] for gemini, never throws');
ok(Array.isArray(resolveOfferableModels(undefined, 'anthropic')) && resolveOfferableModels(undefined, 'anthropic').length === 0,
  'undefined table -> [] for anthropic, never throws');
ok(resolveOfferableModels(null, 'gemini').length === 0, 'null table -> []');
ok(resolveOfferableModels('not an object', 'gemini').length === 0, 'string table -> []');
ok(resolveOfferableModels(42, 'gemini').length === 0, 'numeric table -> []');
ok(resolveOfferableModels({}, 'gemini').length === 0, 'table missing the provider key entirely -> []');
ok(resolveOfferableModels({ gemini: 'not-an-array' }, 'gemini').length === 0, "table['gemini'] is a non-array value -> []");
ok(resolveOfferableModels({ gemini: null }, 'gemini').length === 0, "table['gemini'] is null -> []");
ok(resolveOfferableModels(SYNTHETIC_TABLE, 'openai').length === 0, 'a provider outside gemini/anthropic -> [] (not looked up at all)');
ok(resolveOfferableModels(SYNTHETIC_TABLE, '').length === 0, 'empty-string provider -> []');
ok(resolveOfferableModels(SYNTHETIC_TABLE, null).length === 0, 'null provider -> []');
ok(resolveOfferableModels(SYNTHETIC_TABLE, undefined).length === 0, 'undefined provider -> []');

section('§1b. Prototype-pollution vectors cannot reach the lookup');
// If a future call site threads untrusted input into `provider`, these are
// the classic escape attempts: walk onto Object.prototype / Function.prototype
// members instead of getting the "not a real provider" refusal. The provider
// check happens BEFORE the table is even inspected, so all of these must
// return [] regardless of what `table` looks like — proven against both the
// well-formed synthetic table AND a table that itself carries a poisoned
// own-property, so the guard is the provider check, not an accident of the
// fixture's shape.
const POISON_TABLE = Object.freeze({
  gemini: Object.freeze([GOOD_ENTRY_GEMINI]),
  __proto__: ['should-never-surface'],
  constructor: ['should-never-surface'],
});
for (const badProvider of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
  const rGood = resolveOfferableModels(SYNTHETIC_TABLE, badProvider);
  const rPoison = resolveOfferableModels(POISON_TABLE, badProvider);
  ok(Array.isArray(rGood) && rGood.length === 0,
    `provider="${badProvider}" against a clean table -> [] (no Object.prototype/Function.prototype member surfaces)`);
  ok(Array.isArray(rPoison) && rPoison.length === 0,
    `provider="${badProvider}" against a table with a matching own/poisoned property -> [] (the provider allowlist wins, not the table's shape)`);
}
// Object.create(null)-based table (no prototype chain at all) still works for
// the two real providers — the hardening must not break the legitimate path.
{
  const bare = Object.create(null);
  bare.gemini = [GOOD_ENTRY_GEMINI];
  ok(resolveOfferableModels(bare, 'gemini').length === 1, 'a prototype-less table (Object.create(null)) still resolves the real provider correctly');
}

// ─────────────────────────────────────────────────────────────────────────
// Contract validators — used both against the synthetic fixture (self-test,
// §4a) and against the REAL wire response when llm.js has shipped
// OFFERABLE_MODELS (§4b). Kept as plain functions so both call sites share
// one definition of "complete" and "cheapest-first".
// ─────────────────────────────────────────────────────────────────────────
// The eight core fields. `input`/`output` are handled SEPARATELY below because
// their legal shape depends on the entry's price POSTURE — see PRICE_FIELDS.
const REQUIRED_FIELDS = {
  id: 'string', label: 'string',
  maxOutput: 'number', thinks: 'boolean', tokenizerFactor: 'number',
};

/**
 * ── THE PRICE FIELDS ARE POSTURE-DEPENDENT, AND null IS CORRECT FOR FREE ────
 *
 * This validator required `input`/`output` to be NUMBERS, full stop. That was
 * right while every offerable model was paid. A FREE model sends `null` — by
 * llm.js's deliberate design, and the design is the important part:
 * `{input: 0, output: 0}` is TRUTHY, so it makes `usdHigh` zero, `createJob`
 * accepts a budget cap it believes it can enforce, and spend tracks at zero
 * forever while every flag reports success. That is v3.3.0's inert-cap defect
 * re-armed. So `getModelPrice()` returns null for a free model and the wire
 * carries null.
 *
 * The guard is therefore SPLIT rather than relaxed. Its real purpose — a PAID
 * model must never lose its price — is preserved exactly: `null` is refused
 * unless `free === true`. And the free case is tightened in the other
 * direction: a free entry must send `null` specifically, so it cannot smuggle
 * the zero pair back in under cover of being free. Both directions are
 * exercised in the §4a self-test; neither is a branch nobody drives.
 */
const PRICE_FIELDS = ['input', 'output'];

/** Returns a list of problem strings; empty means the entry is contract-complete. */
function entryProblems(entry) {
  const problems = [];
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  for (const [field, type] of Object.entries(REQUIRED_FIELDS)) {
    if (!Object.hasOwn(entry, field)) { problems.push(`missing required field "${field}"`); continue; }
    const v = entry[field];
    if (typeof v !== type) { problems.push(`field "${field}" has type ${typeof v}, expected ${type}`); continue; }
    if (type === 'number' && !Number.isFinite(v)) problems.push(`field "${field}" is not a finite number`);
    if (type === 'string' && v.length === 0) problems.push(`field "${field}" is an empty string`);
  }
  // ── `jsonRaw` IS ALSO POSTURE-DEPENDENT ───────────────────────────────────
  // It measures whether a RAW JSON.parse of the ingest outline succeeds — a
  // question that does not arise for a model that may never serve ingest. So a
  // BUILD-LANE entry must carry a real boolean, while a 'chat-only' entry may
  // carry `null`, meaning NOT MEASURED. That is a different fact from `false`
  // ("measured bad"), and coercing one into the other would put a warning on a
  // model nobody has tested. Caught here by a real chat-only entry driven
  // through this validator over the wire in §4c, not by anticipating it.
  if (!Object.hasOwn(entry, 'jsonRaw')) {
    problems.push('missing required field "jsonRaw"');
  } else if (entry.suitability === 'chat-only') {
    if (!(typeof entry.jsonRaw === 'boolean' || entry.jsonRaw === null)) {
      problems.push(`chat-only entry: field "jsonRaw" is ${JSON.stringify(entry.jsonRaw)}, expected a boolean or null ("not measured")`);
    }
  } else if (typeof entry.jsonRaw !== 'boolean') {
    problems.push(`build-lane entry: field "jsonRaw" has type ${typeof entry.jsonRaw}, expected boolean (only a chat-only entry may leave it unmeasured)`);
  }

  const isFree = entry.free === true;
  for (const field of PRICE_FIELDS) {
    if (!Object.hasOwn(entry, field)) { problems.push(`missing required field "${field}"`); continue; }
    const v = entry[field];
    if (isFree) {
      // A free entry must send null — NOT 0, and not a number of any kind.
      if (v !== null) problems.push(`free entry: field "${field}" is ${JSON.stringify(v)}, expected null (a zero price is truthy and makes a budget cap inert)`);
    } else {
      if (typeof v !== 'number') { problems.push(`field "${field}" has type ${typeof v}, expected number (only a free entry may send null)`); continue; }
      if (!Number.isFinite(v)) problems.push(`field "${field}" is not a finite number`);
      if (v <= 0) problems.push(`paid entry: field "${field}" is ${v}, expected a positive price`);
    }
  }
  // At least one field BEYOND the eight core ones must carry a non-empty
  // measured-reason string (the contract's "per-feature suitability field
  // carrying a MEASURED REASON string"). Checked one level deep too, in case
  // the real shape nests reasons under a `suitability: {...}` object rather
  // than flat fields — this validator doesn't assume which the real llm.js
  // export picked.
  const extraKeys = Object.keys(entry).filter(k => !Object.hasOwn(REQUIRED_FIELDS, k));
  const hasReasonString = extraKeys.some(k => {
    const v = entry[k];
    if (typeof v === 'string') return v.length > 0;
    if (v && typeof v === 'object') return Object.values(v).some(vv => typeof vv === 'string' && vv.length > 0);
    return false;
  });
  if (extraKeys.length === 0) problems.push('no field beyond the 8 required ones — missing the measured-reason/suitability field');
  else if (!hasReasonString) problems.push('has extra field(s) beyond the 8 required ones, but none carries a non-empty measured-reason string');
  return problems;
}

/** True iff `list` is sorted cheapest-first by `input` (non-decreasing, ties allowed). */
function isCheapestFirstByInput(list) {
  // A FREE entry has `input: null` and is, unarguably, the cheapest thing in
  // the list — so it sorts as 0 here. This is the ONE place a free model's
  // price may be treated as a number, and it is safe because the value is used
  // only to compare ORDER, never to compute a bill. Everywhere money is
  // actually calculated, `getModelPrice()` keeps returning null.
  const priceOf = (e) => (e && e.free === true && e.input === null) ? 0 : e?.input;
  for (let i = 1; i < list.length; i++) {
    const a = priceOf(list[i - 1]), b = priceOf(list[i]);
    if (typeof a !== 'number' || typeof b !== 'number') return false;
    if (a > b) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// §4a. Self-test — the validators above are NOT vacuous (mirrors
// test-css-tokens.js §9b's convention: a check that can only ever report
// zero problems has not proven anything).
// ─────────────────────────────────────────────────────────────────────────
section('§4a. Self-test — the contract validators can actually detect a violation');

ok(entryProblems(GOOD_ENTRY_GEMINI).length === 0, 'self-test: a well-formed entry reports zero problems');
{
  const missingField = { ...GOOD_ENTRY_GEMINI };
  delete missingField.maxOutput;
  const p = entryProblems(missingField);
  ok(p.length > 0 && p.some(s => s.includes('maxOutput')), 'self-test: an entry missing "maxOutput" is caught by name (M3 shape)');
}
{
  const wrongType = { ...GOOD_ENTRY_GEMINI, thinks: 'no' };
  const p = entryProblems(wrongType);
  ok(p.some(s => s.includes('thinks') && s.includes('expected boolean')), 'self-test: a wrong-typed field ("thinks" as a string) is caught');
}
{
  const noReason = { ...GOOD_ENTRY_GEMINI };
  delete noReason.chatSuitabilityReason;
  const p = entryProblems(noReason);
  ok(p.some(s => s.includes('measured-reason')), 'self-test: an entry with no field beyond the 8 required ones is caught (missing suitability reason)');
}
{
  const emptyReason = { ...GOOD_ENTRY_GEMINI, chatSuitabilityReason: '' };
  const p = entryProblems(emptyReason);
  ok(p.some(s => s.includes('measured-reason')), 'self-test: a present-but-empty-string reason field is still caught (not just presence-checked)');
}
ok(isCheapestFirstByInput([GOOD_ENTRY_GEMINI, GOOD_ENTRY_GEMINI_2]) === true, 'self-test: correctly-ordered [0.10, 0.25] passes');

// ── Self-tests for the POSTURE-DEPENDENT fields (price + jsonRaw) ────────────
// Both branches of each rule are driven, in both directions. A validator that
// only ever sees the shape it accepts has proven nothing about what it rejects.
{
  const FREE_OK = { ...GOOD_ENTRY_GEMINI, id: 'v/free:free', free: true, input: null, output: null };
  eq(entryProblems(FREE_OK).length, 0,
    'self-test: a FREE entry sending input/output null is CONTRACT-COMPLETE — null is the correct wire value for a free model');

  const FREE_ZERO = { ...FREE_OK, input: 0, output: 0 };
  ok(entryProblems(FREE_ZERO).some(x => x.includes('expected null')),
    'self-test: a free entry sending {input:0,output:0} is REJECTED — that pair is truthy and makes createJob\'s budget cap inert (v3.3.0 re-armed), which is the whole reason free is null and not zero');

  const PAID_NULL = { ...GOOD_ENTRY_GEMINI, input: null };
  ok(entryProblems(PAID_NULL).some(x => x.includes('only a free entry may send null')),
    'self-test: a PAID entry sending null is still REJECTED — the guard\'s original purpose (a paid model must never lose its price) is preserved exactly, not relaxed');

  const PAID_ZERO = { ...GOOD_ENTRY_GEMINI, input: 0 };
  ok(entryProblems(PAID_ZERO).some(x => x.includes('expected a positive price')),
    'self-test: a paid entry with a zero price is REJECTED');

  const BUILD_UNMEASURED = { ...GOOD_ENTRY_GEMINI, suitability: 'general', jsonRaw: null };
  ok(entryProblems(BUILD_UNMEASURED).some(x => x.includes('only a chat-only entry may leave it unmeasured')),
    'self-test: a BUILD-LANE entry with jsonRaw null is REJECTED — ingest reliability may not be left unmeasured for a model that builds wikis');

  const CHAT_UNMEASURED = { ...GOOD_ENTRY_GEMINI, suitability: 'chat-only', jsonRaw: null };
  eq(entryProblems(CHAT_UNMEASURED).length, 0,
    'self-test: a CHAT-ONLY entry with jsonRaw null is ACCEPTED — "not measured" is a different fact from "measured bad", and only one of them is a reason to warn');

  ok(isCheapestFirstByInput([FREE_OK, GOOD_ENTRY_GEMINI, GOOD_ENTRY_GEMINI_2]) === true,
    'self-test: a FREE entry sorts FIRST — it is unarguably the cheapest, and a null input must not break the ordering check');
  ok(isCheapestFirstByInput([GOOD_ENTRY_GEMINI, FREE_OK]) === false,
    'self-test: a free entry placed AFTER a paid one is still caught as mis-ordered — free-sorts-as-zero is an ordering rule, not an exemption');
}
ok(isCheapestFirstByInput([GOOD_ENTRY_GEMINI_2, GOOD_ENTRY_GEMINI]) === false, 'self-test: reversed [0.25, 0.10] is caught (M4 shape — ordering CAN fail)');
ok(isCheapestFirstByInput([GOOD_ENTRY_GEMINI, GOOD_ENTRY_GEMINI, GOOD_ENTRY_GEMINI]) === true, 'self-test: equal-price ties are accepted (non-decreasing, not strictly increasing)');

// ─────────────────────────────────────────────────────────────────────────
// §2. HTTP integration — the real route, mounted in-process on an ephemeral
// port. Never touches port 3333; this process closes the listener itself.
// ─────────────────────────────────────────────────────────────────────────
section('§2. HTTP integration setup');

const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
ok(server.address().port > 0 && server.address().address === '127.0.0.1', `server listening on an ephemeral loopback port (${server.address().port}), never 3333`);

async function getApiKeys() {
  const res = await fetch(BASE + '/api/config/api-keys');
  const json = await res.json();
  return { status: res.status, body: json };
}
async function saveApiKeys(body) {
  const res = await fetch(BASE + '/api/config/api-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

section('§2b. Before any key is saved — offerable is gated closed for both providers');
{
  const { status, body } = await getApiKeys();
  ok(status === 200, 'GET /api-keys returns 200 with no config on disk yet');
  ok(body.hasGeminiKey === false && body.hasAnthropicKey === false, 'no keys saved -> both hasXKey are false');
  ok(!!body.offerable && typeof body.offerable === 'object', 'response carries an `offerable` object');
  ok(Array.isArray(body.offerable.gemini) && body.offerable.gemini.length === 0,
    'no gemini key saved -> offerable.gemini is [] (config-scoped gate closed, matching hasGeminiKey)');
  ok(Array.isArray(body.offerable.anthropic) && body.offerable.anthropic.length === 0,
    'no anthropic key saved -> offerable.anthropic is [] (config-scoped gate closed)');
  ok(body.hasOpenrouterKey === false, 'no openrouter key saved -> hasOpenrouterKey is false');
  ok(Array.isArray(body.offerable.openrouter) && body.offerable.openrouter.length === 0,
    'no openrouter key saved -> offerable.openrouter is [] (config-scoped gate closed, third provider)');
}

// Obviously-fake, clearly-synthetic key material — never a real credential
// shape, never printed, only scanned for ABSENCE in response bodies below.
const FAKE_GEMINI_KEY = 'FAKE-TEST-GEMINI-KEY-do-not-use-1234567890abcdef';
const FAKE_ANTHROPIC_KEY = 'FAKE-TEST-ANTHROPIC-KEY-do-not-use-abcdef1234567890';
// Deliberately NOT shaped like a real OpenRouter key. The point is to exercise
// the config-scoped gate, not the key format, and a realistic-looking string in
// a public repo is how a secret scanner earns a false positive.
const FAKE_OPENROUTER_KEY = 'FAKE-TEST-OPENROUTER-KEY-do-not-use-0987654321fedcba';

section('§2c. After saving all three keys (real POST /api-keys route, isolated config)');
{
  const saveRes = await saveApiKeys({
    geminiApiKey: FAKE_GEMINI_KEY,
    anthropicApiKey: FAKE_ANTHROPIC_KEY,
    openrouterApiKey: FAKE_OPENROUTER_KEY,
  });
  ok(saveRes.status === 200 && saveRes.body.ok === true, 'POST /api-keys (real route) accepts all three fake keys against the isolated config');
}

let liveResponseBody = null;
{
  const { status, body } = await getApiKeys();
  liveResponseBody = body;
  ok(status === 200, 'GET /api-keys returns 200 after keys are saved');

  // ── The two must-not-regress shapes ──
  section('§3. The two load-bearing pre-existing shapes are untouched');
  ok(typeof body.models === 'object' && body.models !== null && !Array.isArray(body.models),
    '`models` is still a plain object (not an array, not null)');
  ok(typeof body.models.gemini === 'string',
    '[object Object] HAZARD CHECK: typeof res.models.gemini === "string" — src/public/app.js renders `escHtml(models[p] || \'\')` for the /old chat model dropdown, and escHtml starts with String(str), so anything but a string here renders the literal text "[object Object]" in production');
  ok(typeof body.models.anthropic === 'string',
    '[object Object] HAZARD CHECK: typeof res.models.anthropic === "string" (same /old dropdown hazard, other provider)');
  // ── The `models` key set is PINNED, not merely bounded ────────────────────
  // This read 'anthropic,gemini' and its job was to catch an ACCIDENTAL extra
  // key appearing in a map the /old frontend indexes. v3.15.0 adds a third
  // provider deliberately, so the pin is RE-PINNED to the new exact set — it is
  // not softened to `length >= 2`, because a bounds check cannot tell a reviewed
  // addition from an accident, which is the entire value of the original.
  ok(Object.keys(body.models).sort().join(',') === 'anthropic,gemini,openrouter',
    '`models` carries exactly the three provider keys it is supposed to — an unreviewed fourth key, or a lost one, reds here');
  // The /old [object Object] hazard, restated as a RULE over every key rather
  // than two hand-listed ones. `escHtml` begins `String(str)`, so an object or
  // array renders the literal text "[object Object]" in production. null is
  // legitimate ONLY because /old renders `escHtml(models[p] || '')` — an empty
  // string, not the word "null" — and because getDefaultModel() returns null
  // for a provider with no measured build-lane default (DEFAULTS.openrouter).
  for (const [p, v] of Object.entries(body.models)) {
    ok(typeof v === 'string' || v === null,
      `[object Object] HAZARD CHECK: models.${p} is a string or null — never an object/array (src/public/app.js renders escHtml(models[p] || ''), and escHtml starts with String(str))`);
    ok(!(v !== null && typeof v === 'object'),
      `models.${p} is specifically NOT an object (the exact shape that renders as "[object Object]" for every /old user)`);
  }
  // The two providers /old actually enumerates must still resolve to a STRING.
  // A null there would blank that provider's model label in the shipping app.
  ok(typeof body.models.gemini === 'string' && body.models.gemini.length > 0,
    'models.gemini is a NON-EMPTY string — /old indexes exactly this key for its chat model dropdown');
  ok(typeof body.models.anthropic === 'string' && body.models.anthropic.length > 0,
    'models.anthropic is a NON-EMPTY string — same /old dropdown, other provider');
  // OpenRouter is null TODAY and that is the honest state, not an omission:
  // DEFAULTS.openrouter is deliberately null because no OpenRouter route has
  // been measured against this repo's real ingest outline prompt. Pinned so
  // that the day a default IS pinned, this reds and forces the reviewer to
  // confirm the measurement happened rather than a plausible id being typed in.
  // RE-POINTED. This pinned `null` and said "the day a default is added, this
  // reds and the measurement must be shown". The measurement was shown — 9 runs
  // against the real 341,005-char ingest prompt, 9/9 raw JSON — and
  // `upstage/solar-pro4` was pinned. The assertion now guards the populated
  // state: a NON-EMPTY string, and specifically the id llm.js resolves, so the
  // wire cannot drift from the engine.
  ok(typeof body.models.openrouter === 'string' && body.models.openrouter.length > 0,
    'models.openrouter is a non-empty string — OpenRouter now has a MEASURED build-lane default');
  eq(body.models.openrouter, llmModule.getDefaultModel('openrouter'),
    'models.openrouter is exactly what llm.js resolves — the wire is derived from the engine, never a second copy');

  ok(Object.hasOwn(body, 'hasGeminiKey'), 'HAS-KEY REGRESSION CHECK: `hasGeminiKey` is present (its absence re-fires the un-skippable onboarding overlay for an already-configured user)');
  ok(Object.hasOwn(body, 'hasAnthropicKey'), 'HAS-KEY REGRESSION CHECK: `hasAnthropicKey` is present');
  ok(body.hasGeminiKey === true && body.hasAnthropicKey === true, 'both hasXKey flip true once both keys are saved (config-scoped, matches getApiKeys())');
  ok(body.hasOpenrouterKey === true, 'hasOpenrouterKey flips true once the third key is saved (additive beside the two /old depends on)');

  // ── The new field ──
  section('§4b. `offerable` — shape, gating, and (once shipped) contract completeness + ordering');
  ok(!!body.offerable && typeof body.offerable === 'object', 'response carries `offerable`');
  ok(Array.isArray(body.offerable.gemini), 'offerable.gemini is an array');
  ok(Array.isArray(body.offerable.anthropic), 'offerable.anthropic is an array');
  ok(Array.isArray(body.offerable.openrouter), 'offerable.openrouter is an array');

  const realTableShipped = llmModule.OFFERABLE_MODELS !== undefined;
  console.log(`  ℹ llm.js OFFERABLE_MODELS export ${realTableShipped ? 'IS' : 'is NOT YET'} present at test time`);

  // ── The provider list is DERIVED, never hand-typed ────────────────────────
  // This loop read `['gemini', 'anthropic']`. A hardcoded member list is the
  // shape that has twice let a new member sail past a guard in this repo, and
  // here it would mean a third provider's entries were never contract-checked
  // or ordering-checked at all — silently, with the suite green. It now walks
  // whatever `offerable` actually carries, and asserts that set matches the
  // providers llm.js knows about, so neither side can drift alone.
  const offerableProviders = Object.keys(body.offerable).sort();
  eq(offerableProviders.join(','),
    [...(llmModule.__testing?.KNOWN_PROVIDERS ?? ['gemini', 'anthropic', 'openrouter'])].sort().join(','),
    '`offerable` carries one key per provider llm.js knows about — no provider is silently unchecked below');

  for (const provider of offerableProviders) {
    const list = body.offerable[provider];
    if (list.length === 0) {
      ok(!realTableShipped || (llmModule.OFFERABLE_MODELS[provider] || []).length === 0,
        `offerable.${provider} is empty — consistent with OFFERABLE_MODELS not shipping entries for ${provider} yet`);
      continue;
    }
    const problems = list.flatMap((e, i) => entryProblems(e).map(p => `entry[${i}] (${e?.id ?? '?'}): ${p}`));
    ok(problems.length === 0,
      `offerable.${provider}: every one of ${list.length} live entries is contract-complete` +
      (problems.length ? ` — FIRST PROBLEM: ${problems[0]}` : ''));
    ok(isCheapestFirstByInput(list), `offerable.${provider}: ${list.length} live entries are ordered cheapest-first by input price`);
  }
}

// ── §4c. The route serves the UNION accessor, not the static table ───────────
//
// RECORDED FINDING, NOW CLOSED — and the assertion is re-pointed from the gap
// to the fix. llm.js grew a second source of offerable OpenRouter entries: a
// runtime overlay populated by `setOpenRouterCatalogue()`, with
// `listOfferableModels(provider)` as the accessor that unions it with the
// frozen static table. llm.js's own docblock calls that "the accessor every
// consumer should read (including the route that serialises the picker)".
//
// The route used to read `resolveOfferableModels(OFFERABLE_MODELS, provider)` —
// the STATIC table only. While both were empty the outputs were identical and
// there was no live defect, so this was pinned as a tripwire on the measured
// population rather than asserted as a failure on another agent's file. It now
// delegates to `listOfferableModels`, so the property can be asserted directly.
//
// DRIVEN, NOT READ. The overlay is populated with a synthetic entry and the
// REAL route is re-fetched over HTTP: if the route still read the static table,
// that entry could never appear. That is the difference between proving the
// route calls a function and proving the caller gets the union.
section('§4c. `offerable` is served from the UNION accessor (static table + runtime overlay)');
{
  const staticList = (llmModule.OFFERABLE_MODELS?.openrouter) ?? [];
  const unionList  = typeof llmModule.listOfferableModels === 'function'
    ? llmModule.listOfferableModels('openrouter') : staticList;

  ok(staticList.length > 0,
    `MEASURED: OFFERABLE_MODELS.openrouter is populated (${staticList.length} hand-measured entries) — the empty-state tripwire this replaces has served its purpose`);
  eq(unionList.length, staticList.length,
    'with the overlay empty, the union equals the static table (baseline for the injection below)');

  const SYNTH_ID = 'zz-route-probe/overlay-only';
  const before = (await getApiKeys()).body.offerable.openrouter;
  ok(!before.some(e => e.id === SYNTH_ID), 'precondition: the synthetic id is not already on the wire');

  const res = llmModule.setOpenRouterCatalogue([{
    id: SYNTH_ID, label: 'Overlay Probe', thinks: false, tokenizerFactor: 1.0,
    suitability: 'chat-only', maxOutput: 32768, price: { input: 0.05, output: 0.2 },
    note: 'Synthetic overlay entry, used only to prove the route serves the union accessor rather than the frozen static table.',
  }]);
  eq(res.admitted, 1, 'the synthetic overlay entry was admitted by llm.js');

  const during = (await getApiKeys()).body.offerable.openrouter;
  ok(during.some(e => e.id === SYNTH_ID),
    'THE FIX, PROVEN OVER THE WIRE: an entry that exists ONLY in the runtime overlay reaches `offerable` — the route reads listOfferableModels, not the frozen static table');
  eq(during.length, staticList.length + 1,
    'and the union is the static table PLUS the overlay, not one replacing the other');
  const synth = during.find(e => e.id === SYNTH_ID);
  eq(entryProblems(synth).length, 0,
    `a dynamically-admitted entry is contract-complete on the wire too${entryProblems(synth).length ? ` — FIRST: ${entryProblems(synth)[0]}` : ''}`);
  // A chat-only entry may carry jsonRaw: null ("not measured"), which is a
  // different fact from `false` ("measured bad"). Driving one through the real
  // validator is what stops that branch being a rule nobody exercises.
  ok(synth && (typeof synth.jsonRaw === 'boolean' || synth.jsonRaw === null),
    'a chat-only entry carries a measured jsonRaw or null — never undefined');

  llmModule.setOpenRouterCatalogue([]);
  const after = (await getApiKeys()).body.offerable.openrouter;
  ok(!after.some(e => e.id === SYNTH_ID), 'clearing the overlay removes it from the wire again — no synthetic id leaks into module state');
  eq(after.length, staticList.length, 'and the wire returns to exactly the hand-measured static entries');
}

section('§5. No API key material reaches the response');
{
  const serialized = JSON.stringify(liveResponseBody);
  ok(!serialized.includes(FAKE_GEMINI_KEY), 'the raw Gemini key string never appears anywhere in the response body');
  ok(!serialized.includes(FAKE_ANTHROPIC_KEY), 'the raw Anthropic key string never appears anywhere in the response body');
  ok(!serialized.includes(FAKE_OPENROUTER_KEY), 'the raw OpenRouter key string never appears anywhere in the response body');
  ok(liveResponseBody.geminiApiKey !== FAKE_GEMINI_KEY, 'geminiApiKey field itself is masked, not the raw key');
  ok(liveResponseBody.anthropicApiKey !== FAKE_ANTHROPIC_KEY, 'anthropicApiKey field itself is masked, not the raw key');
  ok(liveResponseBody.openrouterApiKey !== FAKE_OPENROUTER_KEY, 'openrouterApiKey field itself is masked, not the raw key');
  // Self-test: prove this assertion can actually fail (mirrors M5) by
  // scanning a body that WOULD contain the key, so a green run above isn't
  // just "the substring check never runs".
  const poisonedBody = JSON.stringify({ ...liveResponseBody, debugLeak: FAKE_GEMINI_KEY });
  ok(poisonedBody.includes(FAKE_GEMINI_KEY), 'self-test: the substring check itself would catch a leaked key if one were present (M5 is not vacuous)');
}

// ── §5b. THE BUILD LANE, enforced at the route ────────────────────────────────
//
// THE HOLE THIS CLOSES (live until v3.15.0). `suitability: 'chat-only'` was read
// in exactly three places, ALL of them badge rendering. Nothing enforced it.
// This route gated on `isOfferableModel` plus a saved key and nothing else — so
// a user could pin `gemini-3.5-flash-lite`, measured emitting JSON that neither
// the parser nor the repair pass could fix in 2 of 9 real ingest runs and badged
// "not for ingest" on the very screen they clicked, as the model that BUILDS
// THEIR WIKI. The badge said one thing and the button did another.
//
// This is the ROUTE half. The RESOLVER half (a stored chat-only pin must not
// silently become the build model even if it was allow-listed when it was
// saved) is asserted in test-openrouter-model-layer.js §4. Both layers are
// needed and each is proven separately, because either one alone makes the
// other look sufficient.
section('§5b. POST /api-keys/model — a chat-only model cannot be pinned as the BUILD model');
{
  async function pinModel(body) {
    const res = await fetch(BASE + '/api/config/api-keys/model', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const all = llmModule.OFFERABLE_MODELS ?? {};
  const chatOnly = Object.values(all).flat().find(m => m && m.suitability === 'chat-only');
  const general  = Object.values(all).flat().find(m => m && m.suitability !== 'chat-only');
  ok(!!chatOnly, 'fixture sanity: the shipped catalogue contains a chat-only model to refuse (without one this section would pass vacuously)');
  ok(!!general,  'fixture sanity: the shipped catalogue contains a build-lane model to accept');

  if (chatOnly && general) {
    // CONTROL FIRST — a build-lane model is ACCEPTED, so the refusal below is
    // the lane talking and not the route rejecting everything.
    const okRes = await pinModel({ provider: general.provider, model: general.id });
    ok(okRes.status === 200, `control: pinning the build-lane model "${general.id}" is ACCEPTED (HTTP ${okRes.status})`);
    ok(okRes.body.selectedModel === general.id, 'control: the accepted pin is what gets stored');
    ok(okRes.body.effectiveModel === general.id, 'control: and it becomes the EFFECTIVE model the app will actually use');

    // THE REFUSAL.
    const bad = await pinModel({ provider: chatOnly.provider, model: chatOnly.id });
    ok(bad.status === 400, `pinning the chat-only model "${chatOnly.id}" is REFUSED with 400 (got ${bad.status})`);
    ok(typeof bad.body.error === 'string' && /chat-only/i.test(bad.body.error),
      'the refusal SAYS it is a chat-only verdict — a user who is not told why reads the picker as broken');
    ok(/still choose this one per-conversation in chat|in chat/i.test(bad.body.error || ''),
      'the refusal also says the model is still usable in CHAT — the lane is a restriction on one job, not a ban');
    ok((bad.body.error || '').includes(chatOnly.id),
      'the refusal NAMES the refused model — safe to echo here because this branch is reached only AFTER isOfferableModel confirmed the string is one of OUR catalogue ids, so it is our own literal, not the caller\'s');

    // AND THE WRITE DID NOT HAPPEN. A 400 that still stored the value would be
    // the worst of both worlds; the v3.13.0 rule is that a model choice is a
    // SPENDING decision and state moves only on the success path.
    const after = await getApiKeys();
    ok(after.body.selectedModels[chatOnly.provider] !== chatOnly.id,
      'the refused model was NOT stored — a 400 must not leave the pin behind');
    ok(after.body.models[general.provider] === general.id,
      'the previously-accepted build-lane pin survives the refusal untouched');

    // A model that is not in the catalogue at all is refused by the allow-list,
    // and that refusal must NOT echo the caller's string (log-forgery, v3.0.1-beta.20).
    const bogus = await pinModel({ provider: general.provider, model: 'zz-not-a-model\nInjected: line' });
    ok(bogus.status === 400, 'an id absent from the catalogue is refused by the allow-list');
    ok(!(bogus.body.error || '').includes('Injected'),
      'the allow-list refusal does NOT echo the caller\'s string back — the two refusals differ deliberately, and only the one that has already validated the string may name it');
  }
}

await new Promise(r => server.close(r));

// ─────────────────────────────────────────────────────────────────────────
// Cleanup + isolation proof
// ─────────────────────────────────────────────────────────────────────────
section('§6. Cleanup + isolation proof');
const FINGERPRINT_AFTER = fingerprint();
ok(FINGERPRINT_BEFORE === FINGERPRINT_AFTER, 'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json are byte-identical before and after this run');

delete process.env.CURATOR_TEST_USER_DATA_DIR;
delete process.env.CURATOR_TEST_DOMAINS_DIR;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort tempdir cleanup */ }
ok(!existsSync(TMP), 'the isolated tempdir (holding the two fake keys) is removed');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All offerable-models route assertions green');
