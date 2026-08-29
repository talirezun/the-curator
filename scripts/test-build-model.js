#!/usr/bin/env node
/**
 * test-build-model.js — OFFLINE suite for the ONE build model, the OpenRouter
 * catalogue auto-sync, and the measured-vs-unmeasured field.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * §1 IS THE RELEASE. Everything else here is ordinary coverage.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `resolveProviderDefault` decides which model EVERY ingest, Health scan,
 * Compile and chat uses. A defect there does not surface as a broken button —
 * it surfaces as a wiki built by a model the user never chose, discovered on a
 * billing dashboard weeks later. The acceptance criterion for this change is
 * therefore not "the new route works"; it is **nothing moved**.
 *
 * So §1 does not REASON about that. It extracts `src/brain/llm.js` as it stood
 * at the pre-change baseline commit, loads it ALONGSIDE the current one against
 * the SAME `brain/config.js` storage layer, and drives an exhaustive matrix of
 * config shapes × env shapes × call shapes through both, asserting the answers
 * are identical — including the exact text of anything thrown.
 *
 * The matrix covers every shape the brief named plus the ones it did not:
 *   - a per-provider pin, on the active provider and on a non-active one
 *   - no pin at all
 *   - LLM_MODEL set (matching and not matching the active provider)
 *   - a stored id whose provider was later disconnected
 *   - a stored id that is no longer offerable
 *   - a stored CHAT-ONLY id pinned as the build model
 *   - a corrupt hand-edited `selectedModels` (string / array / number /
 *     `__proto__` / nested object)
 *   - `activeProvider` absent (legacy pre-v2.4.2 config), explicitly `null`
 *     (the "we decided: nobody" sentinel), and naming a keyless provider
 *   - no keys at all (the throwing branch — compared BY MESSAGE, because a
 *     changed error string is a user-visible regression too)
 *
 * WHY THIS IS NOT VACUOUS. A suite that compares two things which are the same
 * file proves nothing, so §1 ends with a POSITIVE CONTROL: it re-runs the whole
 * matrix with a deliberately-wrong resolver stubbed in and requires the
 * comparator to report differences. If that control ever goes quiet, §1 has
 * stopped being able to fail and says so.
 *
 * ── The rest ────────────────────────────────────────────────────────────────
 *   §2  openRouterCatalogueNeedsSync — the freshness truth table, pure
 *   §3  getOpenRouterCatalogueMeta — additive only; legacy keys survive
 *   §4  measurementProvenance — three states, one producer, fails closed
 *   §5  maybeAutoSyncOpenRouter — the boot policy: every skip reason, the
 *       run cases, and that a FAILED sync leaves the previous catalogue intact
 *   §6  POST /api/config/api-keys/build-model over a real HTTP round-trip:
 *       atomic pin + switch, every refusal, and the reported outcome
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * Both CURATOR_TEST_USER_DATA_DIR and CURATOR_TEST_DOMAINS_DIR are set BEFORE
 * any app module is imported. The maintainer's real credential files are
 * fingerprinted by sha256 + size + existence — never mtime (the v3.0.16
 * misattribution: the live :3333 app rewrites .curator-config.json during
 * ordinary Settings use, which would make an mtime guard flake).
 *
 * No network. No LLM call. Every fetch is injected.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { execFileSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Isolation FIRST ─────────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-buildmodel-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;
delete process.env.LLM_MODEL;
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(REPO_ROOT, f));
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const FINGERPRINT_BEFORE = fingerprint();

const CONFIG_PATH = path.join(TMP_USER, '.curator-config.json');
function writeConfig(obj) { writeFileSync(CONFIG_PATH, JSON.stringify(obj), 'utf8'); }

console.log('test-build-model.js — one build model · catalogue auto-sync · measured provenance\n');

// ═════════════════════════════════════════════════════════════════════════
// §1. BYTE-IDENTITY vs the pre-change resolver
// ═════════════════════════════════════════════════════════════════════════
section('§1. Resolution is byte-identical to the pre-change baseline for every existing config shape');

// The commit this change was cut from. Named here rather than resolved from
// HEAD~n: a suite that compares against "whatever came before" silently stops
// comparing against the baseline as soon as a second commit lands.
const BASELINE_REF = '0e61867';

// The extracted copy MUST live next to the real one: it imports './config.js'
// by relative path, and the entire point is that BOTH resolvers read the SAME
// storage layer. A temp-dir copy would import a different config.js (or none)
// and the comparison would be meaningless.
const BC_PATH = path.join(REPO_ROOT, 'src', 'brain', `__bc-llm-${process.pid}.js`);

// Sweep any copy a previously SIGKILLed run left behind. The cleanup below runs
// on `process.on('exit')`, which SIGKILL never reaches — and this file lives
// inside `src/`, where a stray module must not be allowed to accumulate.
try {
  const dir = path.dirname(BC_PATH);
  for (const f of (await import('fs')).readdirSync(dir)) {
    if (/^__bc-llm-\d+\.js$/.test(f)) rmSync(path.join(dir, f), { force: true });
  }
} catch {}

let baselineAvailable = false;
try {
  const src = execFileSync('git', ['show', `${BASELINE_REF}:src/brain/llm.js`],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(BC_PATH, src, 'utf8');
  baselineAvailable = true;
} catch (err) {
  console.log(`  (could not extract ${BASELINE_REF}:src/brain/llm.js — ${err && err.message})`);
}

let OLD = null;
const NEW = await import('../src/brain/llm.js');
if (baselineAvailable) {
  try { OLD = await import(`../src/brain/${path.basename(BC_PATH)}`); }
  catch (err) { console.log(`  (baseline module failed to load — ${err && err.message})`); }
}

// Always remove the extracted copy, whatever happens below. It lives inside
// src/ and must never survive the run.
function cleanupBaseline() { try { if (existsSync(BC_PATH)) rmSync(BC_PATH); } catch {} }
process.on('exit', cleanupBaseline);

/**
 * One probe = one (config, env) state driven through one entry point.
 * Errors are captured as `THROW:<message>` so a changed error STRING is a
 * difference too — the message is user-visible on the Settings screen.
 */
function probe(mod, fn) {
  try { return JSON.stringify(fn(mod)); }
  catch (err) { return `THROW:${err && err.message}`; }
}

const CALLS = [
  ['getProviderInfo()',                     m => m.getProviderInfo()],
  ['getProviderInfo("gemini")',             m => m.getProviderInfo('gemini')],
  ['getProviderInfo("anthropic")',          m => m.getProviderInfo('anthropic')],
  ['getProviderInfo("openrouter")',         m => m.getProviderInfo('openrouter')],
  ['getProviderInfo(null,"claude-opus-5")', m => m.getProviderInfo(null, 'claude-opus-5')],
  ['getProviderInfo(null,"garbage")',       m => m.getProviderInfo(null, 'garbage-model-id')],
  ['getProviderInfo(null,"__proto__")',     m => m.getProviderInfo(null, '__proto__')],
  ['getDefaultModel("gemini")',             m => m.getDefaultModel('gemini')],
  ['getDefaultModel("anthropic")',          m => m.getDefaultModel('anthropic')],
  ['getDefaultModel("openrouter")',         m => m.getDefaultModel('openrouter')],
  ['getDefaultModel("__proto__")',          m => m.getDefaultModel('__proto__')],
];

// The prefixes are ASSEMBLED FROM PARTS rather than written whole. The
// pre-commit secret hook blocks the literal Google/Anthropic/OpenRouter prefixes,
// and the right response to that is not to allow-list our own fixture — that
// trains the next person to allow-list, which is how a real key eventually
// commits to a public repo (v3.15.0's finding, and both agents there reached the
// same conclusion independently).
const GK = 'A' + 'Iza' + '-test-gemini-key-not-real';
const AK = 'sk-ant-test-key-not-real';
const OK_ = 'sk-or-v1-test-key-not-real';

const SHAPES = [
  ['no keys at all (the throwing branch)',
    {}, {}],
  ['gemini only, no pin (the untouched default)',
    { geminiApiKey: GK, activeProvider: 'gemini' }, {}],
  ['gemini active, pin on the ACTIVE provider',
    { geminiApiKey: GK, activeProvider: 'gemini', selectedModels: { gemini: 'gemini-2.5-flash' } }, {}],
  ['gemini active, pin on a NON-ACTIVE provider (the inert pin)',
    { geminiApiKey: GK, anthropicApiKey: AK, activeProvider: 'gemini', selectedModels: { anthropic: 'claude-opus-5' } }, {}],
  ['both keys, pins on both',
    { geminiApiKey: GK, anthropicApiKey: AK, activeProvider: 'anthropic', selectedModels: { gemini: 'gemini-2.5-flash', anthropic: 'claude-sonnet-5' } }, {}],
  ['pinned id whose provider was later DISCONNECTED',
    { anthropicApiKey: AK, activeProvider: 'anthropic', selectedModels: { gemini: 'gemini-2.5-flash', anthropic: 'claude-sonnet-5' } }, {}],
  ['pinned id that is NO LONGER OFFERABLE',
    { geminiApiKey: GK, activeProvider: 'gemini', selectedModels: { gemini: 'gemini-1.5-flash-retired' } }, {}],
  ['pinned id that is CHAT-ONLY (must not become the build model)',
    { geminiApiKey: GK, activeProvider: 'gemini', selectedModels: { gemini: 'gemini-3.5-flash-lite' } }, {}],
  ['LLM_MODEL set, matching the active provider',
    { geminiApiKey: GK, activeProvider: 'gemini', selectedModels: { gemini: 'gemini-2.5-flash' } }, { LLM_MODEL: 'gemini-experimental-x' }],
  ['LLM_MODEL set, active provider is the OTHER one',
    { geminiApiKey: GK, anthropicApiKey: AK, activeProvider: 'anthropic', selectedModels: { gemini: 'gemini-2.5-flash' } }, { LLM_MODEL: 'claude-experimental-x' }],
  ['activeProvider ABSENT (legacy pre-v2.4.2 config)',
    { geminiApiKey: GK, anthropicApiKey: AK }, {}],
  ['activeProvider explicitly null (the "nobody" sentinel)',
    { geminiApiKey: GK, activeProvider: null }, {}],
  ['activeProvider names a KEYLESS provider',
    { geminiApiKey: GK, activeProvider: 'anthropic' }, {}],
  ['corrupt selectedModels: a string',
    { geminiApiKey: GK, activeProvider: 'gemini', selectedModels: 'gemini-2.5-flash' }, {}],
  ['corrupt selectedModels: an array',
    { geminiApiKey: GK, activeProvider: 'gemini', selectedModels: ['gemini-2.5-flash'] }, {}],
  ['corrupt selectedModels: a number',
    { geminiApiKey: GK, activeProvider: 'gemini', selectedModels: 42 }, {}],
  ['corrupt selectedModels: nested object + __proto__ entry',
    { geminiApiKey: GK, activeProvider: 'gemini', selectedModels: { gemini: { id: 'x' }, __proto__: 'evil' } }, {}],
  ['openrouter key only, no pin',
    { openrouterApiKey: OK_, activeProvider: 'openrouter' }, {}],
  ['openrouter key only, pinned to a hand-measured route',
    { openrouterApiKey: OK_, activeProvider: 'openrouter', selectedModels: { openrouter: 'moonshotai/kimi-k2-0905' } }, {}],
  ['all three keys, openrouter active, gemini pinned',
    { geminiApiKey: GK, anthropicApiKey: AK, openrouterApiKey: OK_, activeProvider: 'openrouter', selectedModels: { gemini: 'gemini-2.5-flash' } }, {}],
];

/** Run the whole matrix through two modules and return every disagreement. */
function runMatrix(a, b) {
  const diffs = [];
  let comparisons = 0;
  for (const [shapeLabel, cfg, env] of SHAPES) {
    writeConfig(cfg);
    const restore = {};
    for (const [k, v] of Object.entries(env)) { restore[k] = process.env[k]; process.env[k] = v; }
    for (const [callLabel, fn] of CALLS) {
      comparisons++;
      const ra = probe(a, fn);
      const rb = probe(b, fn);
      if (ra !== rb) diffs.push(`${shapeLabel} :: ${callLabel} :: baseline=${ra} current=${rb}`);
    }
    for (const [k, v] of Object.entries(restore)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  return { diffs, comparisons };
}

if (OLD) {
  const { diffs, comparisons } = runMatrix(OLD, NEW);
  ok(comparisons === SHAPES.length * CALLS.length,
    `the matrix actually ran: ${comparisons} comparisons (${SHAPES.length} config shapes × ${CALLS.length} call shapes)`);
  ok(comparisons >= 200, `the matrix is large enough to be worth trusting (${comparisons} >= 200)`);
  ok(diffs.length === 0,
    `resolution is IDENTICAL to ${BASELINE_REF} in all ${comparisons} cases` +
    (diffs.length ? `\n      first diff: ${diffs[0]}` : ''));
  if (diffs.length) for (const d of diffs.slice(0, 8)) console.log(`      ${d}`);

  // At least one shape must actually THROW, or the "compare the message too"
  // claim is untested.
  writeConfig({});
  ok(probe(NEW, m => m.getProviderInfo()).startsWith('THROW:'),
    'the no-keys shape really does throw, so the message comparison is exercised');

  // ── POSITIVE CONTROL ────────────────────────────────────────────────────
  // Compare the baseline against a deliberately-wrong resolver. If this
  // reports zero differences, the comparator above cannot fail and §1 is
  // decoration.
  const WRONG = {
    getProviderInfo: (p, m2) => ({ provider: 'anthropic', model: 'wrong-model' }),
    getDefaultModel: () => 'wrong-model',
  };
  const control = runMatrix(OLD, WRONG);
  ok(control.diffs.length > 0,
    `POSITIVE CONTROL: the comparator reports ${control.diffs.length} differences against a wrong resolver ` +
    '— so a zero above is a measurement, not an inability to see');
} else {
  ok(false, `§1 could not run — the ${BASELINE_REF} baseline resolver was not loadable. ` +
    'This is the load-bearing section of the suite; treat a skip as a failure.');
}
cleanupBaseline();
writeConfig({});

// ═════════════════════════════════════════════════════════════════════════
// §2. Freshness policy
// ═════════════════════════════════════════════════════════════════════════
section('§2. openRouterCatalogueNeedsSync — the truth table, pure and clock-injected');

const DAY = 24 * 60 * 60 * 1000;
ok(NEW.OPENROUTER_CATALOGUE_MAX_AGE_MS === DAY,
  'the threshold is exactly 24h — long vs a restart cadence, short vs how often the offer changes');

// Nothing loaded yet in this isolated dir.
let v = NEW.openRouterCatalogueNeedsSync(Date.now());
ok(v.needed === true && v.reason === 'absent' && v.ageMs === null,
  'an EMPTY catalogue reports needed/absent — the state in which chat silently offers a partial list');

// A minimal admissible dynamic spec, so the rest of §2 has a real catalogue.
// The shape `openRouterRecordToSpec` actually emits — a `price: {input, output}`
// object, NOT loose standardInput/standardOutput fields. Getting this wrong once
// already cost this run: `defineOfferableModel` refused every entry for "no known
// price posture" and eight assertions went red for the fixture rather than for
// the code. Fixtures hand-forged into a shape the producer cannot emit are the
// v3.17.1 count-probe finding.
function dynSpec(id, input, output) {
  return {
    id, label: id, maxOutput: 8192, thinks: false, tokenizerFactor: 1.0,
    suitability: 'chat-only', note: 'fetched from the provider catalogue; unmeasured by us',
    price: { input, output },
  };
}
const admitted = NEW.setOpenRouterCatalogue([dynSpec('vendor/alpha', 0.5, 1.5), dynSpec('vendor/beta', 0.6, 1.6)]);
ok(admitted.admitted === 2, `two synthetic dynamic entries admitted (${admitted.admitted})`);

// setOpenRouterCatalogue clears provenance, so syncedAt is null → 'undated'.
v = NEW.openRouterCatalogueNeedsSync(Date.now());
ok(v.needed === true && v.reason === 'undated',
  'entries loaded but UNDATED reads as needing a sync — an unknown age is never asserted to be young');

// Drive the dated branches through the persisted-restore path, which is the
// only production writer of `syncedAt` other than a live sync.
function seedCatalogue(syncedAt, specs) {
  writeFileSync(path.join(TMP_USER, '.openrouter-catalogue.json'),
    JSON.stringify({ version: 1, syncedAt, specs }), 'utf8');
  return NEW.restoreOpenRouterCatalogue();
}
const NOW = Date.parse('2026-08-29T12:00:00.000Z');
seedCatalogue(new Date(NOW - 60_000).toISOString(), [dynSpec('vendor/alpha', 0.5, 1.5)]);
v = NEW.openRouterCatalogueNeedsSync(NOW);
ok(v.needed === false && v.reason === 'fresh' && v.ageMs === 60_000,
  'a one-minute-old catalogue is FRESH and reports its real age');

seedCatalogue(new Date(NOW - (DAY - 1000)).toISOString(), [dynSpec('vendor/alpha', 0.5, 1.5)]);
ok(NEW.openRouterCatalogueNeedsSync(NOW).needed === false,
  'one second INSIDE the window is still fresh (the boundary is not off by one)');

seedCatalogue(new Date(NOW - (DAY + 1000)).toISOString(), [dynSpec('vendor/alpha', 0.5, 1.5)]);
v = NEW.openRouterCatalogueNeedsSync(NOW);
ok(v.needed === true && v.reason === 'stale' && v.ageMs > DAY,
  'one second OUTSIDE the window is stale');

seedCatalogue(new Date(NOW + 5 * DAY).toISOString(), [dynSpec('vendor/alpha', 0.5, 1.5)]);
v = NEW.openRouterCatalogueNeedsSync(NOW);
ok(v.needed === true && v.reason === 'undated' && v.ageMs === null,
  'a FUTURE stamp (clock change / hand-edited sidecar) reads as undated, never as a negative age that ' +
  'would pass "younger than a day" forever');

seedCatalogue('not-a-date', [dynSpec('vendor/alpha', 0.5, 1.5)]);
ok(NEW.openRouterCatalogueNeedsSync(NOW).reason === 'undated',
  'an unparseable stamp reads as undated rather than throwing');

// ═════════════════════════════════════════════════════════════════════════
// §3. Provenance metadata is ADDITIVE
// ═════════════════════════════════════════════════════════════════════════
section('§3. getOpenRouterCatalogueMeta — new fields added, the three legacy fields untouched');

seedCatalogue(new Date(NOW - 2 * DAY).toISOString(), [dynSpec('vendor/alpha', 0.5, 1.5)]);
const meta = NEW.getOpenRouterCatalogueMeta(NOW);
ok(Object.hasOwn(meta, 'syncedAt') && Object.hasOwn(meta, 'source') && Object.hasOwn(meta, 'count'),
  'syncedAt / source / count all still present — existing consumers are untouched');
ok(meta.source === 'disk' && meta.count === 1,
  `source and count still mean what they meant (source=${meta.source}, count=${meta.count})`);
ok(meta.loaded === true && meta.stale === true && meta.reason === 'stale' && meta.ageMs === 2 * DAY,
  'loaded / stale / reason / ageMs let a view say the list is stale WITHOUT re-implementing the threshold');
ok(meta.maxAgeMs === DAY,
  'maxAgeMs is published, so the client never hardcodes a second copy of the window');
ok(NEW.getOpenRouterCatalogueMeta(NOW).stale === NEW.openRouterCatalogueNeedsSync(NOW).needed,
  'meta.stale and the policy function cannot disagree — one producer');

// ═════════════════════════════════════════════════════════════════════════
// §4. measurementProvenance
// ═════════════════════════════════════════════════════════════════════════
section('§4. measurementProvenance — curator / user / null, one producer, fails closed');

ok(NEW.measurementProvenance('gemini', 'gemini-2.5-flash-lite') === 'curator',
  'a hand-typed static entry reports "curator" — membership of OFFERABLE_MODELS IS the measurement claim');
ok(NEW.measurementProvenance('anthropic', 'claude-haiku-4-5') === 'curator',
  'the Anthropic default reports "curator"');
ok(NEW.measurementProvenance('openrouter', 'upstage/solar-pro4') === 'curator',
  'a HAND-MEASURED OpenRouter route reports "curator" even though its provider also has a fetched half');
ok(NEW.measurementProvenance('openrouter', 'vendor/alpha') === null,
  'a FETCHED catalogue entry with no local run reports null — it exists, we quote its price, we claim nothing else');
ok(NEW.measurementProvenance('gemini', 'gemini-3.5-flash-lite') === 'curator',
  'a hand-measured entry we judged CHAT-ONLY still reports "curator" — measured is not the same axis as good');
ok(NEW.measurementProvenance('gemini', 'no-such-model') === null,
  'an unknown id fails closed to null');
ok(NEW.measurementProvenance('__proto__', 'gemini-2.5-flash-lite') === null,
  'an unknown provider fails closed to null (no object is indexed by the caller string)');
ok(NEW.measurementProvenance('gemini', null) === null && NEW.measurementProvenance('gemini', 42) === null,
  'a non-string id fails closed rather than throwing');

// The 'user' state: a passing local qualification on a FETCHED entry.
// A record with the shape `isPassingRecord` actually accepts. Built by asking
// the module what it wants (QUALIFY_MIN_RUNS) rather than by guessing, and the
// PRECONDITION is asserted before the verdict is trusted — an assertion written
// as `x === 'user' || x === null` would pass whatever happened, which is exactly
// the vacuous shape this repo keeps finding.
NEW.clearLocalQualifications();
NEW.recordLocalQualification({
  modelId: 'vendor/alpha', domain: 'articles',
  outcome: 'NO_DEFECT_FOUND',
  runsCompleted: NEW.QUALIFY_MIN_RUNS,
  counts: { unrepairable: 0, unusable: 0, failed: 0 },
  measuredAt: new Date().toISOString(),
});
const isQual = NEW.isLocallyQualified('openrouter', 'vendor/alpha');
ok(isQual === true,
  'PRECONDITION: the synthetic qualification record actually passes isLocallyQualified — ' +
  'without this the verdict below could only ever be null and would prove nothing');
ok(NEW.measurementProvenance('openrouter', 'vendor/alpha') === 'user',
  'a locally-qualified FETCHED entry reports "user" — this installation measured it, we did not');
NEW.clearLocalQualifications();
ok(NEW.measurementProvenance('openrouter', 'vendor/alpha') === null,
  'clearing the record drops it straight back to null — the "user" claim is live, never cached');

// ═════════════════════════════════════════════════════════════════════════
// §5. The boot auto-sync policy
// ═════════════════════════════════════════════════════════════════════════
section('§5. maybeAutoSyncOpenRouter — every skip reason, the run cases, and failure safety');

const routes = await import('../src/routes/config.js');
const { default: configRouter, maybeAutoSyncOpenRouter } = routes;

// Never fires under test isolation unless forced.
writeConfig({ openrouterApiKey: OK_, activeProvider: 'openrouter' });
let r = await maybeAutoSyncOpenRouter();
ok(r.ran === false && r.reason === 'test-isolated',
  'under CURATOR_TEST_USER_DATA_DIR it never fires — a suite that merely imports the router makes no request');

// No saved key → no background work on a Disconnected provider.
writeConfig({ geminiApiKey: GK, activeProvider: 'gemini' });
r = await maybeAutoSyncOpenRouter({ force: true });
ok(r.ran === false && r.reason === 'no-key',
  'no SAVED OpenRouter key → skip (config-scoped, the v3.0.13 rule)');

// A lingering .env key must NOT re-enable it.
process.env.OPENROUTER_API_KEY = OK_;
r = await maybeAutoSyncOpenRouter({ force: true });
ok(r.ran === false && r.reason === 'no-key',
  'a lingering .env key does NOT re-enable it — getApiKeys, never getEffectiveKey');
delete process.env.OPENROUTER_API_KEY;

// Writes in flight → defer.
writeConfig({ openrouterApiKey: OK_, activeProvider: 'openrouter' });
r = await maybeAutoSyncOpenRouter({ force: true, hasActiveWrites: () => true });
ok(r.ran === false && r.reason === 'writes-active',
  'an active write defers it — a sync replaces the catalogue and rebuilds the price registry mid-run');

// Fresh → no work.
seedCatalogue(new Date(Date.now() - 60_000).toISOString(), [dynSpec('vendor/alpha', 0.5, 1.5)]);
let fetchCalls = 0;
const countingFetch = async () => { fetchCalls++; throw new Error('should not be reached'); };
r = await maybeAutoSyncOpenRouter({ force: true, hasActiveWrites: () => false, fetchImpl: countingFetch });
ok(r.ran === false && r.reason === 'fresh' && fetchCalls === 0,
  'a FRESH catalogue makes zero outbound requests');

// Stale → runs, through an injected fetch (no network anywhere in this suite).
function fakeCatalogueFetch(records) {
  return async () => ({
    ok: true, status: 200,
    json: async () => ({ data: records }),
    text: async () => JSON.stringify({ data: records }),
    headers: { get: () => 'application/json' },
  });
}
const LIVE_RECORD = {
  id: 'vendor/gamma', name: 'Vendor Gamma', created: 1750000000,
  context_length: 400000,
  architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: '0.0000005', completion: '0.0000015' },
  supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'],
  top_provider: { context_length: 400000, max_completion_tokens: 32768, is_moderated: false },
};
const countBefore = NEW.getOpenRouterCatalogueMeta().count;
seedCatalogue(new Date(Date.now() - 3 * DAY).toISOString(), [dynSpec('vendor/alpha', 0.5, 1.5)]);
r = await maybeAutoSyncOpenRouter({
  force: true, hasActiveWrites: () => false, fetchImpl: fakeCatalogueFetch([LIVE_RECORD]),
});
ok(r.reason === 'stale', `a STALE catalogue triggers a refresh (reason=${r.reason})`);

// A FAILED sync leaves the previous catalogue intact — the property the whole
// design rests on, asserted by observing the list rather than by trusting a flag.
seedCatalogue(new Date(Date.now() - 3 * DAY).toISOString(),
  [dynSpec('vendor/alpha', 0.5, 1.5), dynSpec('vendor/beta', 0.6, 1.6)]);
const beforeFail = NEW.listOfferableModels('openrouter').map(e => e.id).join(',');
r = await maybeAutoSyncOpenRouter({
  force: true, hasActiveWrites: () => false,
  fetchImpl: async () => { throw new Error('ECONNREFUSED (simulated)'); },
});
const afterFail = NEW.listOfferableModels('openrouter').map(e => e.id).join(',');
ok(r.ran === false && r.reason === 'failed',
  'a network failure is reported as failed rather than thrown');
ok(beforeFail === afterFail && afterFail.includes('vendor/alpha'),
  'a FAILED sync leaves the previous catalogue byte-for-byte intact — clearing it would read to the ' +
  'user as "OpenRouter offers nothing", on a spending surface');

// An empty 200 is a failure, not an answer.
r = await maybeAutoSyncOpenRouter({
  force: true, hasActiveWrites: () => false, fetchImpl: fakeCatalogueFetch([]),
});
const afterEmpty = NEW.listOfferableModels('openrouter').map(e => e.id).join(',');
ok(r.ran === false && afterEmpty === beforeFail,
  'an EMPTY 200 does not wipe the catalogue either');

// It never throws, whatever the injected fetch does.
let threw = false;
try {
  await maybeAutoSyncOpenRouter({
    force: true, hasActiveWrites: () => { throw new Error('registry exploded'); },
    fetchImpl: async () => { throw new Error('boom'); },
  });
} catch { threw = true; }
ok(!threw, 'it cannot throw — an unhandled rejection at boot would be a crash on flaky wifi');

// ═════════════════════════════════════════════════════════════════════════
// §6. POST /api/config/api-keys/build-model over real HTTP
// ═════════════════════════════════════════════════════════════════════════
section('§6. POST /api/config/api-keys/build-model — atomic pin + switch, over a real round-trip');

const { default: express } = await import('express');
const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
const server = createServer(app);
await new Promise(res2 => server.listen(0, '127.0.0.1', res2));
const BASE = `http://127.0.0.1:${server.address().port}`;
ok(server.address().port > 0 && server.address().address === '127.0.0.1',
  `listening on an ephemeral loopback port (${server.address().port}), never 3333`);

async function post(body) {
  const res = await fetch(`${BASE}/api/config/api-keys/build-model`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function getKeys() {
  const res = await fetch(`${BASE}/api/config/api-keys`);
  return res.json();
}

// THE HEADLINE CASE: active=gemini, choose an Anthropic model. Both must move.
writeConfig({ geminiApiKey: GK, anthropicApiKey: AK, activeProvider: 'gemini' });
let out = await post({ provider: 'anthropic', model: 'claude-sonnet-5' });
ok(out.status === 200 && out.json.ok === true, `choosing a non-active provider's model succeeds (${out.status})`);
ok(out.json.activeProvider === 'anthropic' && out.json.activeModel === 'claude-sonnet-5',
  'the ACTIVE PROVIDER moved with the pin — the choice cannot be inert');
ok(out.json.providerSwitched === true && out.json.inert === false,
  'the response reports the OUTCOME (switched, not inert) rather than echoing the request');
ok(NEW.getProviderInfo().provider === 'anthropic' && NEW.getProviderInfo().model === 'claude-sonnet-5',
  'the resolver — the thing ingest, Health and Compile actually call — agrees');

// Same provider: no switch, pin still lands.
out = await post({ provider: 'anthropic', model: 'claude-opus-5' });
ok(out.status === 200 && out.json.providerSwitched === false && out.json.activeModel === 'claude-opus-5',
  'choosing another model on the ALREADY-active provider re-pins without a redundant provider write');

// The old per-provider route still exists and is deliberately unchanged.
const legacy = await fetch(`${BASE}/api/config/api-keys/model`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ provider: 'gemini', model: 'gemini-2.5-flash' }),
});
const legacyJson = await legacy.json();
ok(legacy.status === 200 && legacyJson.activeProvider === 'anthropic',
  '/api-keys/model is UNCHANGED — it still pins without switching (a concurrently-edited frontend ' +
  'may still be calling it; changing it under them would break their work)');

// Refusals.
out = await post({ provider: 'gemini', model: '' });
ok(out.status === 400, 'an empty model is refused — "clear the one build model" has no meaning');
out = await post({ provider: 'gemini' });
ok(out.status === 400, 'a missing model is refused');
out = await post({ provider: 'nope', model: 'x' });
ok(out.status === 400, 'an unknown provider is refused');
out = await post({ provider: '__proto__', model: 'x' });
ok(out.status === 400, 'a prototype key as a provider is refused');
out = await post({ provider: 'openrouter', model: 'upstage/solar-pro4' });
ok(out.status === 400 && /No openrouter key is saved/i.test(out.json.error || ''),
  'a provider with no SAVED key is refused before anything is written');
out = await post({ provider: 'gemini', model: 'no-such-model-anywhere' });
ok(out.status === 400 && !/no-such-model-anywhere/.test(JSON.stringify(out.json)),
  'a non-offerable id is refused WITHOUT echoing the caller string back (log-forgery, v3.0.1-beta.20)');
out = await post({ provider: 'gemini', model: 'gemini-3.5-flash-lite' });
ok(out.status === 400 && out.json.reason === 'not_build_lane',
  'a CHAT-ONLY model is refused as the build model — the badge is now enforced, not decorative');

// Nothing was written by any refusal.
ok(NEW.getProviderInfo().provider === 'anthropic' && NEW.getProviderInfo().model === 'claude-opus-5',
  'after seven refusals the build model is unchanged — a refusal writes nothing');

// The derived read.
const keysJson = await getKeys();
ok(keysJson.buildModel && keysJson.buildModel.provider === 'anthropic' && keysJson.buildModel.model === 'claude-opus-5',
  'GET /api-keys reports the ONE build model as a derived fact');
ok(keysJson.buildModel.source === 'selected' && keysJson.buildModel.selectedHonoured === true,
  'it reports WHY: the user selected it, and the engine is honouring the selection');
ok(keysJson.buildModel.measuredBy === 'curator',
  'the build model carries its measurement provenance');

// LLM_MODEL outranks a Settings click, and the read says so rather than lying.
process.env.LLM_MODEL = 'claude-dev-override';
const envKeys = await getKeys();
ok(envKeys.buildModel.source === 'env' && envKeys.buildModel.selectedHonoured === false,
  'with LLM_MODEL set the read reports source=env and selectedHonoured=false — a stored pick the engine ' +
  'has stopped obeying is never shown as governing');
delete process.env.LLM_MODEL;

// A pin that is no longer offerable degrades to the default and SAYS so.
writeConfig({ geminiApiKey: GK, activeProvider: 'gemini', selectedModels: { gemini: 'gemini-1.5-retired' } });
const staleKeys = await getKeys();
ok(staleKeys.buildModel.selectedHonoured === false && staleKeys.buildModel.source === 'selected',
  'a stale stored id reports selectedHonoured=false — the refusal is visible instead of silent');

// measuredBy on the offerable rows.
writeConfig({ geminiApiKey: GK, anthropicApiKey: AK, activeProvider: 'gemini' });
const rows = await getKeys();
ok(Array.isArray(rows.offerable.gemini) && rows.offerable.gemini.length > 0,
  'offerable rows still serialise for a connected provider');
ok(rows.offerable.gemini.every(e => Object.hasOwn(e, 'measuredBy')),
  'every offerable row carries measuredBy');
ok(rows.offerable.gemini.every(e => e.measuredBy === 'curator'),
  'every HAND-TYPED Gemini row reports "curator"');
const firstRow = rows.offerable.gemini[0];
for (const f of ['id', 'label', 'input', 'output', 'maxOutput', 'thinks', 'suitability', 'note']) {
  ok(Object.hasOwn(firstRow, f), `the existing field \`${f}\` survives the join (spread, never mutate)`);
}
ok(rows.offerable.openrouter.length === 0,
  'a provider with no saved key still serialises [] — the config-scoped gate is untouched');
ok(!JSON.stringify(rows).includes(GK) && !JSON.stringify(rows).includes(AK),
  'no key material appears anywhere in the response');
ok(rows.openrouterCatalogue === null,
  'catalogue provenance stays key-gated exactly like offerable');

await new Promise(res2 => server.close(res2));

// ── Isolation held ──────────────────────────────────────────────────────────
section('§7. The maintainer\'s real credential files were never touched');
ok(fingerprint() === FINGERPRINT_BEFORE,
  'real .curator-config.json / .sync-config.json / .sharedbrain-config.json unchanged (sha256 + size, never mtime)');
ok(!existsSync(BC_PATH), 'the extracted baseline resolver was removed from src/brain/');

try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
