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
const REQUIRED_FIELDS = {
  id: 'string', label: 'string', input: 'number', output: 'number',
  maxOutput: 'number', thinks: 'boolean', jsonRaw: 'boolean', tokenizerFactor: 'number',
};

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
  for (let i = 1; i < list.length; i++) {
    if (typeof list[i - 1]?.input !== 'number' || typeof list[i]?.input !== 'number') return false;
    if (list[i - 1].input > list[i].input) return false;
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
}

// Obviously-fake, clearly-synthetic key material — never a real credential
// shape, never printed, only scanned for ABSENCE in response bodies below.
const FAKE_GEMINI_KEY = 'FAKE-TEST-GEMINI-KEY-do-not-use-1234567890abcdef';
const FAKE_ANTHROPIC_KEY = 'FAKE-TEST-ANTHROPIC-KEY-do-not-use-abcdef1234567890';

section('§2c. After saving both keys (real POST /api-keys route, isolated config)');
{
  const saveRes = await saveApiKeys({ geminiApiKey: FAKE_GEMINI_KEY, anthropicApiKey: FAKE_ANTHROPIC_KEY });
  ok(saveRes.status === 200 && saveRes.body.ok === true, 'POST /api-keys (real route) accepts both fake keys against the isolated config');
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
  ok(Object.keys(body.models).sort().join(',') === 'anthropic,gemini',
    '`models` carries exactly the two provider keys it always has — no accidental extra keys from this change');

  ok(Object.hasOwn(body, 'hasGeminiKey'), 'HAS-KEY REGRESSION CHECK: `hasGeminiKey` is present (its absence re-fires the un-skippable onboarding overlay for an already-configured user)');
  ok(Object.hasOwn(body, 'hasAnthropicKey'), 'HAS-KEY REGRESSION CHECK: `hasAnthropicKey` is present');
  ok(body.hasGeminiKey === true && body.hasAnthropicKey === true, 'both hasXKey flip true once both keys are saved (config-scoped, matches getApiKeys())');

  // ── The new field ──
  section('§4b. `offerable` — shape, gating, and (once shipped) contract completeness + ordering');
  ok(!!body.offerable && typeof body.offerable === 'object', 'response carries `offerable`');
  ok(Array.isArray(body.offerable.gemini), 'offerable.gemini is an array');
  ok(Array.isArray(body.offerable.anthropic), 'offerable.anthropic is an array');

  const realTableShipped = llmModule.OFFERABLE_MODELS !== undefined;
  console.log(`  ℹ llm.js OFFERABLE_MODELS export ${realTableShipped ? 'IS' : 'is NOT YET'} present at test time`);

  for (const provider of ['gemini', 'anthropic']) {
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

section('§5. No API key material reaches the response');
{
  const serialized = JSON.stringify(liveResponseBody);
  ok(!serialized.includes(FAKE_GEMINI_KEY), 'the raw Gemini key string never appears anywhere in the response body');
  ok(!serialized.includes(FAKE_ANTHROPIC_KEY), 'the raw Anthropic key string never appears anywhere in the response body');
  ok(liveResponseBody.geminiApiKey !== FAKE_GEMINI_KEY, 'geminiApiKey field itself is masked, not the raw key');
  ok(liveResponseBody.anthropicApiKey !== FAKE_ANTHROPIC_KEY, 'anthropicApiKey field itself is masked, not the raw key');
  // Self-test: prove this assertion can actually fail (mirrors M5) by
  // scanning a body that WOULD contain the key, so a green run above isn't
  // just "the substring check never runs".
  const poisonedBody = JSON.stringify({ ...liveResponseBody, debugLeak: FAKE_GEMINI_KEY });
  ok(poisonedBody.includes(FAKE_GEMINI_KEY), 'self-test: the substring check itself would catch a leaked key if one were present (M5 is not vacuous)');
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
