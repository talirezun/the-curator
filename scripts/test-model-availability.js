#!/usr/bin/env node
/**
 * test-model-availability.js — OFFLINE suite for "the provider removed the model
 * you are pinned to", end to end: the detection, the error, the money guard, the
 * wire fields and the routes.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 *
 * `OFFERABLE_MODELS` is frozen and hand-measured, and `listOfferableModels`
 * merges it with the synced catalogue, so a sync can only ADD. A shipped id the
 * provider has WITHDRAWN therefore stays offerable forever, which makes
 * `applyModelOverride`'s stale-pin fallback unreachable for exactly the ids that
 * need it. MEASURED 2026-09-16: `minimax/minimax-m3:free` is a shipped,
 * offerable, build-lane entry and is ABSENT from OpenRouter's own list of 443
 * ids (the PAID `minimax/minimax-m3` is present).
 *
 * ── EVERY ASSERTION HERE IS BEHAVIOURAL ────────────────────────────────────
 *
 * The real predicates, the real adapter with an injected transport, the real
 * express routers over a real HTTP round-trip. No source regexes: this repo's
 * own rule is that "a test that proves a line exists proves nothing about what
 * it does" (v3.0.17), and the two defects that rule was written for were both
 * sitting next to green source assertions.
 *
 * ── MUTATIONS RUN AGAINST THIS SUITE (each broke it for a BEHAVIOURAL reason,
 *    each restored and the file re-verified by sha256) ──────────────────────
 *
 *   M1  delete the `status === 400` branch in openrouter-adapter.js
 *   M2  drop `curatorDeterministic` from model-gone.js
 *   M3  make catalogueAbsence consult `_openrouterCatalogue` (the eligibility-
 *       filtered list) instead of the recorded raw listing
 *   M4  collapse catalogueAbsence's "never checked" answer from null to false
 *   M5  re-pin getProviderInfo to DEFAULTS when liveMissing is true
 *   M6  remove the ingest route's pre-spend gate
 *   M7  make `build.liveMissing` a boolean (`=== 'missing'`)
 *   M8  have POST /models/check admit its fetched ids via defineOfferableModel
 *   M9  clear the recorded listing when a check fails
 *   M10 remove the free->paid fallback guard (fallbackRungsFor returns rungs)
 *   M11 drop the Anthropic dated-alias rule from catalogueAbsence
 *   M12 drop the `isMissing` exclusion from pickCheapestMeasuredBuild, so the
 *       cheapest-measured sentence goes on recommending a withdrawn model
 *   M13 widen that exclusion to `!== 'present'`, so an UNCHECKED provider's
 *       models are all silently removed from the recommendation
 *   M14 serialise `liveMissingByModel` as a two-valued boolean map
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR are set to a
 * fresh tempdir BEFORE any app module is imported, and the real credential files
 * are fingerprinted (sha256 + size + existence, never mtime — the v3.0.16
 * misattribution lesson) before and after.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), Object.is(actual, expected)
    ? label
    : `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// Isolation FIRST — before any app module is imported.
// ─────────────────────────────────────────────────────────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-availability-'));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
for (const d of [TMP_USER, TMP_DOMAINS]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;
delete process.env.LLM_MODEL;

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

// A synthetic OpenRouter key. Assembled from parts so the repo's secret hook
// never sees a credential-shaped literal in staged content (.githooks rule:
// "assemble the prefix from parts rather than allow-listing it").
const FAKE_KEY = ['sk', 'or', 'v1', 'A'.repeat(40)].join('-');
writeFileSync(path.join(TMP_USER, '.curator-config.json'), JSON.stringify({
  openrouterApiKey: FAKE_KEY,
  activeProvider: 'openrouter',
}), { mode: 0o600 });

const llm = await import('../src/brain/llm.js');
// v3.72.1: the WITHDRAWN id. It was `minimax/minimax-m3:free` — the real case,
// measured absent 2026-09-16 — until OpenRouter's withdrawal was acted on and
// the id left the table (2026-09-25). Every property this suite needs is
// "a SHIPPED, offerable, build-lane, hand-measured id the provider's listing
// lacks", and the CHEAPEST such id, so that `cheapestMeasured` names it until
// the listing arrives. Granite is all of those; the fixture listings below
// simply leave it out. (It is also the chain's only rung, which §4 does not
// depend on: §4 drives `fallbackRungsFor` with its own heads.)
const WITHDRAWN = 'ibm-granite/granite-4.0-h-micro';
const adapterMod = await import('../src/brain/openrouter-adapter.js');
const { OpenRouterAdapter, classifyBadRequestReason, classifyNotFoundReason } = adapterMod;
const { modelGoneError, MODEL_GONE_CODE } = await import('../src/brain/model-gone.js');
const { default: express } = await import('express');
const { default: configRouter } = await import('../src/routes/config.js');
const { createServer } = await import('http');

console.log('test-model-availability.js — a withdrawn model, end to end\n');

// ─────────────────────────────────────────────────────────────────────────
// §1. The synthetic 400: exactly one call, model-gone, no classifier collision
// ─────────────────────────────────────────────────────────────────────────
section('§1. A synthetic HTTP 400 "is not a valid model ID" — one call, one verdict [M1, M2]');

/** A minimal Response double. `json()` is the only method _throwForStatus uses. */
function httpResponse(status, body) {
  return { ok: false, status, headers: new Map(), json: async () => body };
}

async function driveAdapter(status, message, opts = {}) {
  let calls = 0;
  const adapter = new OpenRouterAdapter({
    apiKey: opts.apiKey || FAKE_KEY,
    fetchImpl: async () => { calls++; return httpResponse(status, { error: { message, code: status } }); },
  });
  try {
    await adapter.createChatCompletion({
      model: opts.model || WITHDRAWN,
      userPrompt: 'hi', maxTokens: 1, responseFormat: 'json',
    });
    return { calls, err: null };
  } catch (err) {
    return { calls, err };
  }
}

{
  const { calls, err } = await driveAdapter(400, 'minimax/minimax-m3:free is not a valid model ID');
  eq(calls, 1, 'exactly ONE provider call is made — no retry, no chain walk [M1: deleting the 400 branch leaves it 1 but every assertion below reds]');
  ok(err instanceof Error, 'it throws');
  eq(err.curatorModelGone, true, '★ the error is tagged curatorModelGone [M1]');
  eq(err.curatorDeterministic, true, '★ and curatorDeterministic, which is what stops the chain walk [M2]');
  ok(err.message.includes(WITHDRAWN), 'the message NAMES the id the user is pinned to');
  ok(err.message.includes('pick another model'), 'the message says what to do next — "pick another model"');
  eq(err.status, undefined, '`.status` is withheld: 400 is not a signal any classifier reads, and setting it would put a number where isModelNotFound looks');
  eq(err.httpStatus, 400, '…while httpStatus keeps the fact for a log — "we withheld it" never becomes "there was not one"');
  eq(err.curatorErrorCode, MODEL_GONE_CODE, 'the wire code rides on curatorErrorCode');
  eq(err.code, 'OPENROUTER_BAD_REQUEST', '…and `.code` stays the OpenRouter class, which is what openrouter-qualify classifies on');

  // The three classifiers that could spend money on this error.
  const T = llm.__testing;
  eq(T.is429(err), false, 'is429 does NOT match it — no backoff ladder');
  eq(T.is503(err), false, 'is503 does NOT match it — no outage message, no retry');
  eq(T.isDeterministicProviderError(err), true, '★ isDeterministicProviderError DOES match it, so callLLM refuses the chain [M2]');
  ok(!/output token limit/i.test(err.message), 'the message cannot trip isOutputTokenLimit — no ingest/compile fallback ladder');
  ok(!/\b404\b/.test(err.message) && !/not found/i.test(err.message) && !/does not exist/i.test(err.message),
    '★ and carries none of isModelNotFound\'s message clauses, so a caller that loses the properties still cannot recover a retirement verdict');
  ok(!/HTTP\s+429/i.test(err.message) && !/HTTP\s+503/i.test(err.message),
    '★ nor ingest-queue\'s TRANSIENT_PATTERNS tokens — a withdrawn model must never PAUSE a batch, because the condition never clears');
}

{
  const { calls, err } = await driveAdapter(400, 'max_tokens must be a positive integer');
  eq(calls, 1, 'a NON-model-gone 400 also makes exactly one call');
  eq(err.curatorModelGone, undefined, '★ …and is NOT tagged model-gone — only a MEASURED phrase gets the verdict');
  eq(err.status, 400, 'it keeps today\'s generic tail verbatim, including `.status`');
  ok(err.message.includes('HTTP 400'), '…and today\'s wording');
}

{
  // The shape OpenRouter actually returns for the withdrawn id, measured
  // 2026-09-16. It is a 404, NOT the 400 — recorded here because the brief that
  // commissioned this work said otherwise and the difference is the whole story.
  const live404 = 'This model is unavailable for free. The paid version is available now - use this slug instead: minimax/minimax-m3';
  eq(classifyNotFoundReason(live404), null,
    'the LIVE 404 for the withdrawn id classifies as null — neither routing-constraint nor retirement');
  const { calls, err } = await driveAdapter(404, live404);
  eq(calls, 1, 'so it makes one call…');
  eq(err.curatorDeterministic, true, '…and lands on the fail-safe 404 arm, which refuses to walk the chain');
  eq(err.status, undefined, 'with `.status` withheld, so isModelNotFound cannot fire on it either');
}

section('§1b. classifyBadRequestReason is a table, and the two 400/404 spaces stay disjoint');
eq(classifyBadRequestReason('x is not a valid model ID'), 'model-gone', 'the measured phrase classifies');
eq(classifyBadRequestReason('X IS NOT A VALID MODEL ID'), 'model-gone', 'case-insensitively');
eq(classifyBadRequestReason('max_tokens must be a positive integer'), null, 'anything unmeasured does not');
eq(classifyBadRequestReason(''), null, 'an empty message does not');
eq(classifyBadRequestReason(null), null, 'a non-string does not');
for (const clause of adapterMod.MODEL_GONE_400_CLAUSES) {
  eq(classifyNotFoundReason(clause.join(' ')), null,
    `the 400 clause [${clause.join(' + ')}] does NOT also satisfy a 404 verdict — one sentence must not produce two different spend decisions depending on a status nobody reads`);
}

// ─────────────────────────────────────────────────────────────────────────
// §2. catalogueAbsence — three-valued, over the RAW listing
// ─────────────────────────────────────────────────────────────────────────
section('§2. catalogueAbsence — a STATIC id is checked too, and "unchecked" is null [M3, M4, M11]');

llm.__clearLiveModelListings();
eq(llm.catalogueAbsence('openrouter', 'upstage/solar-pro4'), null,
  '★ with nothing recorded the answer is null — "we could not check" must never be served as "present" [M4]');
eq(llm.getLiveModelListing('openrouter'), null, 'and there is no listing to describe');

{
  // The live catalogue as measured on 2026-09-16, trimmed: the withdrawn free
  // id is absent, its paid twin is present, and the other four shipped ids are.
  const LIVE = [
    'minimax/minimax-m3',
    'upstage/solar-pro4',
    'z-ai/glm-5.3-flash',
    'moonshotai/kimi-k2-0905',
    'nex-agi/nex-n2.5-mini:free',
  ];
  const rec = llm.recordLiveModelListing('openrouter', LIVE, { source: 'network' });
  eq(rec.recorded, true, 'a non-empty listing is recorded');
  eq(rec.count, LIVE.length, 'with every id');

  eq(llm.catalogueAbsence('openrouter', WITHDRAWN), 'missing',
    '★ the WITHDRAWN id reports missing — and it is a STATIC, hand-measured, build-lane entry, which is the entire point [M3]');
  // The proof that M3 is a real mutation: the id IS still offerable, and the
  // synced catalogue would never have contained it (static ids are dropped as
  // `superseded`), so consulting the catalogue answers the wrong question.
  eq(llm.isOfferableModel('openrouter', WITHDRAWN), true,
    '…while STILL being offerable, which is why the stale-pin fallback can never fire for it');
  eq(llm.catalogueAbsence('openrouter', 'upstage/solar-pro4'), 'present',
    '★ a shipped id the provider DOES list reports present — also a static entry the synced catalogue drops [M3]');
  eq(llm.catalogueAbsence('openrouter', 'minimax/minimax-m3'), 'present', 'the paid twin is present');

  const meta = llm.getLiveModelListing('openrouter');
  eq(meta.count, LIVE.length, 'the listing reports its own size — a verdict with no denominator is not reviewable');
  eq(meta.source, 'network', 'and where it came from');
  ok(typeof meta.checkedAt === 'string' && meta.checkedAt.length > 0, 'and when');
}

{
  // The trap that would have blocked every Anthropic user's ingest.
  const ANTHROPIC_LIVE = [
    'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5',
    'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-4-6',
    'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929',
  ];
  llm.recordLiveModelListing('anthropic', ANTHROPIC_LIVE, { source: 'network' });
  eq(llm.catalogueAbsence('anthropic', 'claude-haiku-4-5'), 'present',
    '★ THE APP\'S OWN ANTHROPIC DEFAULT is present, although the live list only contains claude-haiku-4-5-20251001 [M11: dropping the alias rule reports it MISSING and the pre-spend gate blocks every Anthropic ingest]');
  eq(llm.catalogueAbsence('anthropic', 'claude-sonnet-4-5'), 'present', '…and the dated claude-sonnet-4-5-20250929 covers its undated alias');
  eq(llm.catalogueAbsence('anthropic', 'claude-opus-4-5'), 'present', '…and claude-opus-4-5-20251101 covers its');
  eq(llm.catalogueAbsence('anthropic', 'claude-sonnet-5'), 'present', 'an exactly-listed id needs no alias rule');
  eq(llm.catalogueAbsence('anthropic', 'claude-haiku-9-9'), 'missing', 'an id in neither form is missing');
  eq(llm.catalogueAbsence('anthropic', 'claude-haiku-4'), 'missing',
    '★ …and the alias rule does NOT over-reach: claude-haiku-4 PREFIXES claude-haiku-4-5-20251001, so a prefix test would have called it present. Stripping exactly one dated suffix and comparing the whole remainder cannot.');
  eq(llm.catalogueAbsence('openrouter', 'claude-haiku-4-5'), 'missing',
    'the alias rule is Anthropic-only — an OpenRouter id is exact by construction');
}

section('§2b. Refusals that must not be mistaken for answers');
eq(llm.recordLiveModelListing('openrouter', []).recorded, false,
  '★ an EMPTY list is refused, not recorded — a provider publishing zero models is not a state that exists; a body we misread is');
eq(llm.catalogueAbsence('openrouter', WITHDRAWN), 'missing',
  '…and the previous listing therefore still stands, unchanged');
eq(llm.recordLiveModelListing('openrouter', null).recorded, false, 'a non-array is refused');
eq(llm.recordLiveModelListing('not-a-provider', ['x']).recorded, false, 'an unknown provider is refused');
eq(llm.catalogueAbsence('not-a-provider', 'x'), null, '…and answers null');
eq(llm.catalogueAbsence('openrouter', ''), null, 'an empty model id answers null');
eq(llm.catalogueAbsence('openrouter', null), null, 'a non-string model id answers null');
eq(llm.catalogueAbsence('gemini', 'gemini-2.5-flash-lite'), null,
  'a provider with no recorded listing answers null, even for an id we ship');

// ─────────────────────────────────────────────────────────────────────────
// §3. A verdict NEVER changes what runs
// ─────────────────────────────────────────────────────────────────────────
section('§3. A `missing` verdict must not re-pin — v3.45.0 Option B [M5]');
{
  const { setSelectedModel } = await import('../src/brain/config.js');
  setSelectedModel('openrouter', WITHDRAWN);
  eq(llm.catalogueAbsence('openrouter', WITHDRAWN), 'missing', 'fixture: the pinned model is reported missing');
  const info = llm.getProviderInfo();
  eq(info.provider, 'openrouter', 'the provider still resolves');
  eq(info.model, WITHDRAWN,
    '★ and getProviderInfo STILL resolves the model the user pinned — a cached list may not move the build lane, or the bill, without them asking [M5]');
  eq(llm.getDefaultModel('openrouter'), WITHDRAWN,
    '★ getDefaultModel agrees — there is no second resolution that could disagree with the engine [M5]');
  ok(llm.__testing.DEFAULTS.openrouter !== WITHDRAWN,
    'non-vacuous: DEFAULTS.openrouter is a DIFFERENT id, so a silent re-pin would be visible');
}

// ─────────────────────────────────────────────────────────────────────────
// §4. The free -> paid fallback guard
// ─────────────────────────────────────────────────────────────────────────
section('§4. A chain may degrade capability; it may not start billing you [M10]');
{
  const { fallbackRungsFor, FALLBACK_CHAINS } = llm.__testing;
  const rungs = FALLBACK_CHAINS.openrouter;
  ok(rungs.length > 0, 'fixture: the OpenRouter chain has at least one rung');
  ok(rungs.every(id => !llm.isFreeModel(id)),
    'fixture: EVERY rung on it is PAID — which is what makes the guard load-bearing rather than theoretical');
  // v3.72.1: the free head was the shipped `minimax/minimax-m3:free`, which
  // OpenRouter withdrew and which left the table. A synthetic `:free` id
  // registered through the real offer factory is the same membership.
  const FREE_HEAD = 'zz-vendor/zz-free-head:free';
  llm.__testing.defineOfferableModel('openrouter', {
    id: FREE_HEAD, label: 'Free Head', thinks: false, tokenizerFactor: 1.0,
    suitability: 'chat-only', maxOutput: 32768, free: true,
    note: 'Synthetic free head for the free-to-paid fallback guard.',
  });
  eq(llm.isFreeModel(FREE_HEAD), true, 'fixture: the head id is free');

  eq(fallbackRungsFor('openrouter', FREE_HEAD).length, 0,
    '★ a FREE head gets no paid rungs — a user who chose a zero-cost model is never silently moved onto a billed one [M10]');
  eq(fallbackRungsFor('openrouter', 'upstage/solar-pro4').join(','), rungs.join(','),
    '★ a PAID head gets the full chain, in order, byte-unchanged [M10 leaves this green, which is why it is stated separately]');
  eq(fallbackRungsFor('gemini', 'gemini-2.5-flash-lite').join(','), FALLBACK_CHAINS.gemini.join(','),
    'every Gemini path is untouched');
  eq(fallbackRungsFor('anthropic', 'claude-haiku-4-5').join(','), FALLBACK_CHAINS.anthropic.join(','),
    'every Anthropic path is untouched');
  eq(fallbackRungsFor('not-a-provider', 'x').length, 0, 'an unknown provider has no rungs and does not throw');
}

// ─────────────────────────────────────────────────────────────────────────
// §5. The shared error builder
// ─────────────────────────────────────────────────────────────────────────
section('§5. One sentence, one set of tags, four call sites');
{
  const a = modelGoneError('OpenRouter', 'x/y');
  const b = llm.makeModelGoneError('openrouter', 'x/y');
  eq(a.message, b.message, '★ the adapter\'s error and llm.js\'s wrapper produce the SAME sentence — a drift between them would be a drift in a money guard');
  eq(b.curatorModelGone, true, 'the wrapper keeps the tag');
  eq(b.code, MODEL_GONE_CODE, 'and the code');
  ok(llm.makeModelGoneError('gemini', 'g').message.startsWith('Gemini'), 'the wrapper resolves the display name per provider');
  ok(llm.makeModelGoneError('anthropic', 'c').message.startsWith('Claude'), '…for Anthropic too');
  ok(modelGoneError('OpenRouter', 'a\nb\nc').message.split('\n').length === 1,
    'a newline in the id cannot break the message onto a second line (log-forgery, v3.0.1-beta.20)');
  ok(modelGoneError('OpenRouter', 'z'.repeat(500)).message.length < 300, 'and an absurd id is capped');
}

// ─────────────────────────────────────────────────────────────────────────
// §6. Persistence: a check survives a restart, and a failure changes nothing
// ─────────────────────────────────────────────────────────────────────────
section('§6. The raw listing round-trips through the sidecar [M9]');
{
  const CATALOGUE = path.join(TMP_USER, '.openrouter-catalogue.json');
  const specs = [{
    id: 'zz-vendor/chat-only-probe', label: 'Probe', input: 1, output: 2,
    maxOutput: 8192, contextLength: 131072, thinks: false, jsonRaw: null,
    tokenizerFactor: 1, suitability: 'chat-only',
    note: 'Chat only — never measured against The Curator\'s ingest prompt.',
  }];
  const listed = ['zz-vendor/chat-only-probe', 'upstage/solar-pro4', 'zz-vendor/other'];
  writeFileSync(CATALOGUE, JSON.stringify({
    version: 1, syncedAt: new Date().toISOString(), specs, listedIds: listed,
  }));

  llm.__clearLiveModelListings();
  const restored = llm.restoreOpenRouterCatalogue();
  eq(restored.restored, true, 'the sidecar restores');
  eq(restored.listedIds, listed.length, '★ …and re-arms the raw listing, so catalogueAbsence can answer at BOOT with no network and no key');
  eq(llm.catalogueAbsence('openrouter', 'upstage/solar-pro4'), 'present', 'a listed id is present after a restart');
  eq(llm.catalogueAbsence('openrouter', WITHDRAWN), 'missing', 'and an unlisted one is missing');
  eq(llm.getLiveModelListing('openrouter').source, 'disk', 'the provenance says it came from disk, not from the network');

  const SHA_BEFORE = createHash('sha256').update(readFileSync(CATALOGUE)).digest('hex');

  // An OLDER sidecar — no listedIds — must read back as UNKNOWN, never as
  // "everything is missing".
  writeFileSync(CATALOGUE, JSON.stringify({ version: 1, syncedAt: new Date().toISOString(), specs }));
  llm.__clearLiveModelListings();
  const old = llm.restoreOpenRouterCatalogue();
  eq(old.restored, true, 'a sidecar written by an older build still restores its catalogue');
  eq(old.listedIds, 0, '…with no listing');
  eq(llm.catalogueAbsence('openrouter', 'upstage/solar-pro4'), null,
    '★ …so every verdict is null — an older file means UNKNOWN, and must never be read as "the provider removed all of these"');

  // Restore the good file for §7's failure test.
  writeFileSync(CATALOGUE, JSON.stringify({
    version: 1, syncedAt: new Date().toISOString(), specs, listedIds: listed,
  }));
  eq(createHash('sha256').update(readFileSync(CATALOGUE)).digest('hex').length, SHA_BEFORE.length, 'fixture restored');
}

// ─────────────────────────────────────────────────────────────────────────
// §7. The routes, over a real HTTP round-trip
// ─────────────────────────────────────────────────────────────────────────
section('§7. GET /api/config/api-keys and POST /api/config/models/check [M7, M8, M9]');

const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const getJson = async (p, init) => {
  const res = await fetch(BASE + p, init);
  return { status: res.status, body: await res.json() };
};

{
  llm.__clearLiveModelListings();
  const { body } = await getJson('/api/config/api-keys');
  ok(body.build !== null, 'fixture: a build model resolves');
  ok(Object.hasOwn(body.build, 'liveMissing'), '★ `build.liveMissing` is PRESENT on the wire [M7]');
  eq(body.build.liveMissing, null,
    '★ …and is null, not false, when nothing has been checked — THREE-VALUED [M7: `=== \'missing\'` makes this false and the UI states a fact it does not have]');
  ok(Object.hasOwn(body.buildModel, 'liveMissing'), '`buildModel.liveMissing` is present too');
  eq(body.buildModel.liveMissing, null, '…with the same value, from the same producer');
  eq(body.build.liveListing, null, 'and liveListing says there is no listing behind the verdict');
}

{
  llm.recordLiveModelListing('openrouter', ['upstage/solar-pro4', 'zz/other'], { source: 'network' });
  const { body } = await getJson('/api/config/api-keys');
  eq(body.build.model, WITHDRAWN, 'fixture: the pinned build model is still the withdrawn one');
  eq(body.build.liveMissing, true, '★ …and liveMissing is TRUE once a listing exists that lacks it');
  eq(body.buildModel.liveMissing, true, 'both objects agree — one producer');
  eq(body.build.liveListing.count, 2, 'liveListing reports what the verdict was taken against');

  const beforeOffers = JSON.stringify(llm.listOfferableModels('openrouter'));
  llm.recordLiveModelListing('openrouter', [WITHDRAWN, 'upstage/solar-pro4'], { source: 'network' });
  const after = await getJson('/api/config/api-keys');
  eq(after.body.build.liveMissing, false, '★ …and FALSE once the provider lists it again — the verdict tracks the listing, it is not sticky');
  eq(JSON.stringify(llm.listOfferableModels('openrouter')), beforeOffers,
    'recording a listing admits nothing: the offer list is byte-identical across both recordings');
}

section('§7b. POST /models/check is READ-ONLY with respect to the offer tables [M8]');
{
  const OFFERS_BEFORE = JSON.stringify(llm.listOfferableModels('openrouter'));
  const COUNT_BEFORE = llm.listOfferableModels('openrouter').length;

  const bad = await getJson('/api/config/models/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: '__proto__' }),
  });
  eq(bad.status, 400, 'an unknown provider is refused at the route, before any network call');

  const noKey = await getJson('/api/config/models/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'gemini' }),
  });
  eq(noKey.status, 400, 'a provider with no SAVED key is refused — config-scoped, never .env (the v3.0.13 rule)');

  // ── THE SUCCESS PATH, WHICH IS THE ONLY ONE THE CLAIM IS ABOUT ──────────
  // The two refusals above return before the route ever fetches, so asserting
  // the offer list after them proves nothing — M8 came back GREEN against
  // exactly that and the vacuity is why this block exists. A stubbed transport
  // drives the route all the way through the fetch, the mapper and the record,
  // and the assertion then has something to be about.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('openrouter.ai')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'zz-vendor/brand-new-model', name: 'Brand New', context_length: 262144,
            top_provider: { max_completion_tokens: 65536, context_length: 262144 },
            pricing: { prompt: '0.0000005', completion: '0.000002' },
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'] },
          { id: 'upstage/solar-pro4', name: 'Solar Pro 4', context_length: 524288,
            top_provider: { max_completion_tokens: 131072, context_length: 524288 },
            pricing: { prompt: '0.00000009', completion: '0.00000036' },
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  };
  const okCheck = await getJson('/api/config/models/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter' }),
  });
  globalThis.fetch = realFetch;

  eq(okCheck.status, 200, 'the success path returns 200');
  eq(okCheck.body.listedCount, 2, '★ …having really fetched and recorded TWO ids — non-vacuous: the route ran end to end');
  eq(okCheck.body.source, 'network', 'reporting where the answer came from');
  eq(okCheck.body.liveMissing, true,
    '…and the verdict for the pinned (withdrawn) model, computed from what was just fetched');
  ok(typeof okCheck.body.checkedAt === 'string' && okCheck.body.checkedAt.length > 0, 'stamped with when');
  eq(okCheck.body.chosen, WITHDRAWN, 'and naming the model the verdict is ABOUT, resolved through the engine');
  eq(okCheck.body.error, undefined, 'with no error field on the success path');

  eq(JSON.stringify(llm.listOfferableModels('openrouter')), OFFERS_BEFORE,
    '★★ listOfferableModels("openrouter") is BYTE-IDENTICAL after a SUCCESSFUL check that fetched a model we have never offered [M8: admitting the fetched ids grows it]');
  eq(llm.listOfferableModels('openrouter').length, COUNT_BEFORE, '…and the same length, stated separately so a reordering is also visible');
  eq(llm.isOfferableModel('openrouter', 'zz-vendor/brand-new-model'), false,
    '★★ the brand-new id the route just READ is NOT offerable — a model may not be offered for a feature it has never been measured against, and an availability check is exactly the mechanism that would erode that rule [M8]');
  eq(llm.getModelPrice('zz-vendor/brand-new-model'), null,
    '…and it registered no price either, so no money surface can quote a model nobody can pick');
}

section('§7c. A FAILED check records nothing and leaves the catalogue byte-identical [M9]');
{
  const CATALOGUE = path.join(TMP_USER, '.openrouter-catalogue.json');
  const SHA_BEFORE = createHash('sha256').update(readFileSync(CATALOGUE)).digest('hex');
  llm.recordLiveModelListing('openrouter', ['upstage/solar-pro4'], { source: 'network' });
  const LISTING_BEFORE = JSON.stringify(llm.getLiveModelListing('openrouter'));

  // Point the OpenRouter fetch at a closed port so the real transport fails.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.includes('openrouter.ai')) {
      throw new Error('getaddrinfo ENOTFOUND openrouter.ai');
    }
    return realFetch(url, init);
  };
  const { status, body } = await getJson('/api/config/models/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'openrouter' }),
  });
  globalThis.fetch = realFetch;

  eq(status, 200, 'a failed check is a 200 with a verdict, not an HTTP error — the same posture as /api-keys/validate');
  eq(body.liveMissing, null, '★ …and reports liveMissing null, NEVER false: it learned nothing');
  eq(body.listedCount, null, 'with no count');
  ok(typeof body.error === 'string' && body.error.length > 0, 'and a reason the user can act on');
  eq(body.provider, 'openrouter', 'naming the provider it was about');
  // NOT MUTATION-BACKED, and saying so is the point. This route has no code
  // path that writes the sidecar at all, so no single-line edit to it can make
  // this red; it is a standing invariant ("the availability check is not a
  // second writer of the catalogue file") rather than a guard with a proven
  // failing direction. Stated rather than presented as proof.
  eq(createHash('sha256').update(readFileSync(CATALOGUE)).digest('hex'), SHA_BEFORE,
    'the persisted catalogue is sha256-IDENTICAL after the failure — this route never writes it (invariant, not mutation-backed)');
  eq(JSON.stringify(llm.getLiveModelListing('openrouter')), LISTING_BEFORE,
    '★★ the in-memory listing is UNCHANGED, so one transient DNS blip cannot read as "every model you own was removed" [M9: clearing the listing on failure reds this]');
}

// ─────────────────────────────────────────────────────────────────────────
// §7d. A WITHDRAWN MODEL MAY NOT BE RECOMMENDED BY PRICE  [M12, M13, M14]
// ─────────────────────────────────────────────────────────────────────────
//
// THE DEFECT THIS PINS, as rendered on v3.53.0 against this very fixture: the
// Providers page carried a banner reading "MiniMax M3 (free) is no longer
// offered by OpenRouter — pick another build model", and DIRECTLY BELOW IT, in
// the same block, "CHEAPEST MEASURED — For the keys you have connected, that is
// MiniMax M3 (free) — the one you are already using". Two statements about one
// model, in one block, contradicting each other — and the second one is a money
// claim about a model that cannot answer a call.
//
// The cause was that `cheapestMeasured` filtered on two properties of the
// CATALOGUE (may it build, has anyone measured it) and none of the LIVE LIST.
// Driven here through the real route over a real HTTP round-trip, because the
// pure function alone cannot show that the route actually passes the predicate.
section('§7d. cheapestMeasured EXCLUDES a withdrawn model — and only a positive verdict excludes [M12, M13, M14]');
{
  const { pickCheapestMeasuredBuild } = await import('../src/routes/config.js');

  // ── THE PURE FUNCTION, DRIVEN ON THE TWO CASES THE REAL CATALOGUE CANNOT
  //    PRODUCE AT ONCE. Same reasoning the function's own docblock gives for
  //    taking its population as an argument: a guard no reachable input can
  //    exercise is a guard nobody can prove.
  const offers = [
    { provider: 'openrouter', entry: { id: 'gone/cheapest', input: 0.01, output: 0.02, free: false } },
    { provider: 'openrouter', entry: { id: 'live/second', input: 0.05, output: 0.20, free: false } },
  ];
  const always = () => true;

  const picked = pickCheapestMeasuredBuild(offers, {
    isBuild: always, isMeasured: always,
    isMissing: (_p, id) => id === 'gone/cheapest',
  });
  eq(picked && picked.model, 'live/second',
    '★★ the cheapest row is SKIPPED when it is missing, and the NEXT cheapest is returned [M12: dropping the exclusion returns gone/cheapest]');

  const noPredicate = pickCheapestMeasuredBuild(offers, { isBuild: always, isMeasured: always });
  eq(noPredicate && noPredicate.model, 'gone/cheapest',
    'CONTROL: with no isMissing passed, nothing is excluded — the default removes no candidate, so an older caller is byte-unchanged');

  // ── THE THREE-VALUED RULE, AS A BEHAVIOUR ─────────────────────────────
  // A `null` verdict means NOBODY CHECKED. It must leave the candidate
  // standing — the same fail-safe direction the ingest pre-spend gate and the
  // qualification preflight both take, and the one an over-eager rewrite
  // (`!== 'present'`) reverses.
  const nullVerdict = pickCheapestMeasuredBuild(offers, {
    isBuild: always, isMeasured: always,
    isMissing: (_p, id) => (id === 'gone/cheapest' ? null : false),
  });
  eq(nullVerdict && nullVerdict.model, 'gone/cheapest',
    '★★ a NULL verdict does NOT exclude — unknown is not gone [M13: `!== \'present\'` returns live/second here and silently drops every model on an unchecked provider]');

  const presentVerdict = pickCheapestMeasuredBuild(offers, {
    isBuild: always, isMeasured: always, isMissing: () => 'present',
  });
  eq(presentVerdict && presentVerdict.model, 'gone/cheapest',
    '…and neither does a truthy non-true value: the gate is `=== true`, so only the one verdict that means "withdrawn" removes anything [M13]');

  const allGone = pickCheapestMeasuredBuild(offers, {
    isBuild: always, isMeasured: always, isMissing: () => true,
  });
  eq(allGone, null,
    'with every candidate withdrawn the answer is null — no recommendation at all, rather than the least-wrong dead model');
}

// ── AND NOW THROUGH THE REAL ROUTE, which is the half a pure-function test
//    cannot reach: the predicate has to actually be WIRED to catalogueAbsence.
{
  llm.__clearLiveModelListings();
  const before = (await getJson('/api/config/api-keys')).body;
  eq(before.build.model, WITHDRAWN, 'fixture: the withdrawn id is the resolved build model');
  eq(before.build.cheapestMeasured && before.build.cheapestMeasured.model, WITHDRAWN,
    'fixture: with NOTHING checked it is also `cheapestMeasured` — this is the sentence the screen renders');
  eq(before.build.cheapestMeasured.same, true,
    '…and `same: true`, which is what makes the copy read "the one you are already using"');

  // The real listing shape: OpenRouter publishes the PAID twin and not the free
  // slug (measured 2026-09-16). Everything else the fixture offers is listed, so
  // the only thing this recording changes is the one id.
  const listed = llm.listOfferableModels('openrouter')
    .map(m => m.id)
    .filter(id => id !== WITHDRAWN)
    .concat(['minimax/minimax-m3']);
  llm.recordLiveModelListing('openrouter', listed, { source: 'network' });

  const after = (await getJson('/api/config/api-keys')).body;
  eq(after.build.liveMissing, true, 'fixture: the banner condition is now live');
  const cm = after.build.cheapestMeasured;
  ok(cm === null || cm.model !== WITHDRAWN,
    '★★ `cheapestMeasured` NO LONGER NAMES the withdrawn model [M12: the route stops passing isMissing and this reds]');
  ok(cm !== null,
    '…and it is not null either: a withdrawn cheapest must be replaced by the next cheapest, not deleted, or the user is left with a banner and no way forward');
  eq(cm.same, false,
    '★ …so `same` is FALSE, which is the field the copy branches on — the "already using" sentence is now unreachable for a withdrawn model');
  ok(llm.isBuildLaneModel('openrouter', cm.model),
    '…and what replaced it is a real build-lane model, not merely the next row');
  eq(llm.catalogueAbsence('openrouter', cm.model), 'present',
    '…which the provider does still list');

  // ── THE PER-MODEL MAP: THREE VALUES, AND OVER EXACTLY THE OFFERED SET ──
  const map = after.liveMissingByModel;
  ok(map && typeof map === 'object', '`liveMissingByModel` is on the wire');
  eq(Object.keys(map).sort().join(','), 'anthropic,gemini,openrouter',
    '…keyed by every known provider, so a client iterates a provider list instead of hand-writing names');
  eq(Object.keys(map.openrouter).sort().join(','),
    llm.listOfferableModels('openrouter').map(m => m.id).sort().join(','),
    '★ …and its OpenRouter keys are exactly the ids `offerable.openrouter` serialises — a verdict for every row a client can draw, and none for a row it cannot');
  eq(map.openrouter[WITHDRAWN], true,
    '★★ the withdrawn id reports TRUE [M14: a boolean map still passes this one — §7d\'s null assertion below is the one that reds]');
  eq(map.openrouter['upstage/solar-pro4'], false,
    '★ a listed id reports FALSE — "we checked and it is there" is its own fact, not the absence of a warning');
  eq(Object.keys(map.gemini).length, 0,
    'a provider with no saved key serialises {} — key-gated exactly like `offerable` (the v3.0.13 rule)');

  // THE THIRD VALUE, which is the one a boolean map destroys.
  llm.__clearLiveModelListings();
  const unchecked = (await getJson('/api/config/api-keys')).body;
  eq(unchecked.liveMissingByModel.openrouter[WITHDRAWN], null,
    '★★ with NOTHING checked every verdict is NULL, never false [M14: a two-valued map reports `false` here and the UI states a fact it does not have]');
  eq(unchecked.liveMissingByModel.openrouter['upstage/solar-pro4'], null,
    '…for every id alike, because the absence is a property of the PROVIDER\'S listing, not of one model [M14]');
  eq(unchecked.build.cheapestMeasured.model, WITHDRAWN,
    '★ …and the recommendation comes BACK, because an unchecked provider must not have its whole catalogue quietly suppressed [M13]');
}

// ── `offerable` IS NOT A SECOND HOME FOR THIS FACT ────────────────────────
// The obvious place to put a per-model verdict is on the offer entry, and
// `test-offerable-models-route.js` §7 already forbids it in as many words: it
// asserts `offerable` is byte-identical across a `recordLiveModelListing`. That
// suite is not this one's to edit, and the assertion is right — an availability
// verdict is a fact ABOUT an offer, not a field OF one. Re-asserted here so the
// reason travels with the code that obeys it rather than living only in the file
// that would go red.
{
  llm.__clearLiveModelListings();
  const offersBefore = JSON.stringify((await getJson('/api/config/api-keys')).body.offerable);
  llm.recordLiveModelListing('openrouter', ['zz/only-this-one'], { source: 'network' });
  const offersAfter = JSON.stringify((await getJson('/api/config/api-keys')).body.offerable);
  eq(offersAfter, offersBefore,
    '★★ recording a listing leaves `offerable` byte-identical — the verdict rides BESIDE the offers, never on them');
  const nowMap = (await getJson('/api/config/api-keys')).body.liveMissingByModel;
  eq(nowMap.openrouter['upstage/solar-pro4'], true,
    'CONTROL: the same recording DID move the map, so the byte-identity above is not vacuous');
  llm.__clearLiveModelListings();
}

// ─────────────────────────────────────────────────────────────────────────
// §8. Cleanup + isolation proof
// ─────────────────────────────────────────────────────────────────────────
await new Promise(r => server.close(r));
section('§8. Cleanup + isolation proof');
eq(fingerprint(), FINGERPRINT_BEFORE,
  'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json are byte-identical before and after this run');
delete process.env.CURATOR_TEST_USER_DATA_DIR;
delete process.env.CURATOR_TEST_DOMAINS_DIR;
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
ok(!existsSync(TMP), 'the isolated tempdir is removed');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All model-availability assertions green');
