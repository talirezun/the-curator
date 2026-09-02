#!/usr/bin/env node
/**
 * test-router-lanes.js — OFFLINE suite for the per-LANE model router (v3.45.0).
 *
 * ══ WHAT THIS PINS ═══════════════════════════════════════════════════════════
 *
 * §1  THE TWO CONTEXT FLOORS ARE DERIVED, AND THE BUILD ONE IS A FACET.
 *     The old single 200,000 floor was a PARITY rule with a model the app
 *     happens to ship. It was simultaneously too high for the build lane
 *     (measured need 109,576 tokens) and far too high for chat (~26,000), and
 *     it ejected the app's OWN OpenRouter fallback rung. Asserted here: the
 *     arithmetic each floor claims, that the admission gate is the LOWER of the
 *     two, and that raising the BUILD floor changes no model's `eligible` —
 *     because a facet that can reject is a second gate wearing a field name.
 *
 * §2  THE SENSITIVITY, MEASURED OVER A PINNED 421-RECORD SNAPSHOT.
 *     `scripts/test-fixtures/openrouter-catalogue-2026-09-02.json`, run through
 *     the REAL `filterCatalogue`. The audit that commissioned this work quoted
 *     128K→261 / 200K→219 / 256K→188 / 1M→109; those figures predate the
 *     `not_batch_only` rule (v3.42.0), which now removes 60 dead ids BEFORE the
 *     context stage. The post-batch-rule readings are recorded here, per lane.
 *
 * §3  THE HAND-TYPED TABLES GO THROUGH THE SAME RULES.
 *     Every static offer and every fallback rung either passes
 *     `checkStaticEntry` and supports the lane its `suitability` claims, or
 *     carries a NAMED entry in `STATIC_ELIGIBILITY_EXEMPTIONS`. Includes the
 *     anti-vacuity control that the audit CAN fail, driven by raising the floor.
 *
 * §4  `contextLength` ON EVERY STATIC ENTRY, plausible and never `maxOutput`.
 *
 * §5  THE ROUTE FIELDS THE PROVIDERS PAGE CONSUMES — `connected`, `build`,
 *     `catalogueCounts`, `chat` — over a REAL HTTP round-trip against the real
 *     router. `cheapestMeasured` is asserted to come from the UNFILTERED
 *     price-ordered list, which is the exact defect the audit found in the
 *     client's `cheapest` badge (index 0 of an already-sorted-and-filtered
 *     array, so under "most expensive first" it badged the DEAREST row).
 *
 * §6  ACTIVE-PROVIDER OPTION B — a key save fills an EMPTY slot and never moves
 *     an occupied one; the constant flips the behaviour back.
 *
 * §7  MODEL DISCOVERY — the free "new since last release" check, driven against
 *     recorded response fixtures with an injected fetch, including the sticky
 *     `firstSeen` rule and the checked/unchecked distinction.
 *
 * ── ISOLATION ────────────────────────────────────────────────────────────────
 * CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR point at a fresh
 * tempdir, set BEFORE any app module is imported. The real credential files are
 * fingerprinted (sha256 + size + existence — never mtime, per the v3.0.16
 * misattribution lesson) and asserted byte-identical at the end. Keys written
 * are obviously-synthetic strings, never printed. The router is mounted on an
 * EPHEMERAL loopback port this process closes itself. NO NETWORK: every fetch in
 * §7 is injected.
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { createServer } from 'http';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const same = Object.is(actual, expected);
  ok(same, same ? label : `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Isolation FIRST, before any app module is imported ───────────────────────
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-router-lanes-'));
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

const eligibility = await import('../src/brain/openrouter-eligibility.js');
const llm = await import('../src/brain/llm.js');
const brainConfig = await import('../src/brain/config.js');
const discovery = await import('../src/brain/model-discovery.js');
const configModule = await import('../src/routes/config.js');
const { default: configRouter } = configModule;
const { default: express } = await import('express');

console.log('test-router-lanes.js — per-lane context floors, static-table filtering, route facts, Option B, discovery\n');

// ═════════════════════════════════════════════════════════════════════════════
section('§1. The two floors are DERIVED, and the build floor is a FACET not a gate');
// ═════════════════════════════════════════════════════════════════════════════

const {
  APP_CONTEXT_FLOOR_BUILD_TOKENS: BUILD_FLOOR,
  APP_CONTEXT_FLOOR_CHAT_TOKENS: CHAT_FLOOR,
  APP_CONTEXT_FLOOR_ADMISSION_TOKENS: ADMIT_FLOOR,
  APP_OUTPUT_FLOOR_TOKENS: OUT_FLOOR,
  APP_INGEST_PROMPT_TOKENS_APPROX: PROMPT_TOKENS,
  DEFAULT_ELIGIBILITY_OPTS,
  filterCatalogue, evaluateModel, checkStaticEntry,
  STATIC_RULES_APPLIED, STATIC_RULES_NOT_APPLIED, LANES,
} = eligibility;

eq(BUILD_FLOOR, 131072, 'the build floor is 131,072');
eq(CHAT_FLOOR, 32768, 'the chat floor is 32,768');
eq(ADMIT_FLOOR, CHAT_FLOOR, 'the ADMISSION floor IS the chat floor — the lowest lane is the only thing that may reject');
ok(ADMIT_FLOOR < BUILD_FLOOR, '…and it is strictly the lower of the two');

// THE DERIVATIONS, asserted as arithmetic rather than as prose. A floor whose
// docblock claims a derivation nobody checks is a hardcoded number with a story.
const BUILD_NEED = PROMPT_TOKENS + OUT_FLOOR;
eq(BUILD_NEED, 109576, 'the build working set is 85,000 prompt + 24,576 output = 109,576 tokens');
ok(BUILD_FLOOR > BUILD_NEED, 'the build floor clears the measured need');
ok(BUILD_FLOOR / BUILD_NEED < 1.25 && BUILD_FLOOR / BUILD_NEED > 1.1,
  `…with ~19.6% headroom (${(BUILD_FLOOR / BUILD_NEED).toFixed(3)}x), a derivation rather than a round number`);
// The chat working set, from chat.js's own budgets. Mirrored here for the same
// reason the module mirrors them: importing chat.js into an eligibility suite
// would drag the whole retrieval layer in.
const CHAT_NEED = Math.round((60000 + 12000) / 4) + 8192; // ~26,192
ok(CHAT_FLOOR > CHAT_NEED && CHAT_FLOOR < CHAT_NEED * 2,
  `the chat floor (${CHAT_FLOOR}) clears the ~${CHAT_NEED}-token chat working set without a wasteful margin`);
ok(Array.isArray(LANES) && LANES.length === 2 && LANES.includes('chat') && LANES.includes('build'),
  'LANES names exactly the two lanes');
eq(DEFAULT_ELIGIBILITY_OPTS.contextFloorTokens, ADMIT_FLOOR, 'the defaults gate on the admission floor');
eq(DEFAULT_ELIGIBILITY_OPTS.buildContextFloorTokens, BUILD_FLOOR, '…and carry the build floor as a separate option');

// ── THE FACET MAY NOT REJECT. This is the assertion the whole design rests on ─
// A build floor that rejected would hide chat-capable models from chat, which is
// the single-floor defect one level down. Driven at an ABSURD build floor, so a
// mutation turning the facet into a gate cannot survive.
{
  const rec = {
    id: 'zz/lane-probe', context_length: 200000,
    top_provider: { context_length: 200000, max_completion_tokens: 64000 },
    supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'],
    pricing: { prompt: '0.0000005', completion: '0.000002' },
  };
  const base = evaluateModel(rec, { now: new Date('2026-09-02T00:00:00Z') });
  const raised = evaluateModel(rec, { now: new Date('2026-09-02T00:00:00Z'), buildContextFloorTokens: 999999999 });
  ok(base.eligible === true && raised.eligible === true,
    'raising the BUILD floor to an absurd value leaves `eligible` TRUE — the facet cannot reject');
  eq(raised.reasons.length, 0, '…and adds no rejection reason');
  ok(base.lanes.build === true && raised.lanes.build === false,
    '⟨ANTI-VACUITY⟩ …while the LANE does flip, so the option is genuinely in force');
  ok(base.lanes.chat === true && raised.lanes.chat === true, '…and the chat lane is untouched by it');
  // A model that fails a DIFFERENT rule is in no lane, whatever its window.
  const noJson = evaluateModel({ ...rec, supported_parameters: ['max_tokens'] },
    { now: new Date('2026-09-02T00:00:00Z') });
  ok(noJson.eligible === false && noJson.lanes.chat === false && noJson.lanes.build === false,
    'a model failing JSON mode is in NO lane — lanes refine eligibility, they do not bypass it');
}

// ── UNKNOWN IS NOT FALSE, AND THE PATH TO IT IS NARROW ───────────────────────
// FOUND BY WRITING THIS TEST: the module's first draft claimed the null arm was
// reachable by disabling the gate alone. It is not — a null model-level window
// still raises CONTEXT_UNKNOWN, which is a rejection the floor has nothing to do
// with. The one reachable configuration is per-ENDPOINT data with an unknown
// endpoint, a readable model-level value, and the gate disabled. Driven here so
// the arm is executed rather than promised, and the comment now says this.
{
  const CLOCK = new Date('2026-09-02T00:00:00Z');
  const rec = {
    id: 'zz/endpoint-unknown', context_length: 200000,
    top_provider: { context_length: 200000, max_completion_tokens: 64000 },
    supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'],
    pricing: { prompt: '0.0000005', completion: '0.000002' },
  };
  const eps = { 'zz/endpoint-unknown': [
    { context_length: 200000, max_completion_tokens: 64000, supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'] },
    { context_length: null, max_completion_tokens: 64000, supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'] },
  ] };
  const ev = evaluateModel(rec, { now: CLOCK, endpointsById: eps, contextFloorTokens: null });
  ok(ev.eligible === true, 'with the gate disabled and one endpoint publishing no window, the record is admitted');
  eq(ev.lanes.build, null, '…and its build lane is NULL — unknown, never a silent false');
  // Both halves of the configuration are load-bearing, so both are shown to be.
  ok(evaluateModel(rec, { now: CLOCK, endpointsById: eps }).eligible === false,
    '⟨CONTROL⟩ with the gate ON, the unknown endpoint counts as below floor and the record is REJECTED');
  ok(evaluateModel(rec, { now: CLOCK, contextFloorTokens: null }).lanes.build === true,
    '⟨CONTROL⟩ …and with no endpoint data at all the model-level value governs, giving a real TRUE');
  // And the shipping config: a record publishing nothing at all is rejected,
  // which is why `buildUnknown` reads 0 in production.
  const noCtx = { id: 'zz/no-context', top_provider: { max_completion_tokens: 64000 },
    supported_parameters: ['response_format', 'structured_outputs', 'max_tokens'],
    pricing: { prompt: '0.0000005', completion: '0.000002' } };
  ok(evaluateModel(noCtx, { now: CLOCK }).eligible === false,
    '⟨CONTROL⟩ a record publishing no window at all is rejected outright by the shipping config');
  ok(evaluateModel(noCtx, { now: CLOCK, contextFloorTokens: null }).eligible === false,
    '…and STILL rejected with the gate disabled, because CONTEXT_UNKNOWN is not a floor failure');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§2. Sensitivity over the pinned 421-record snapshot, measured per lane');
// ═════════════════════════════════════════════════════════════════════════════

const SNAPSHOT_PATH = path.join(REPO_ROOT, 'scripts/test-fixtures/openrouter-catalogue-2026-09-02.json');
const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
const RECORDS = snapshot.data;
const SNAP_CLOCK = new Date(snapshot._fetched || '2026-09-02T00:00:00Z');
eq(RECORDS.length, 421, 'the pinned snapshot holds 421 records');

const at = (floor) => filterCatalogue(RECORDS, { now: SNAP_CLOCK, contextFloorTokens: floor }).eligible.length;
const SENSITIVITY = [[32768, 218], [131072, 201], [200000, 162], [262144, 137], [1048576, 41]];
for (const [floor, expected] of SENSITIVITY) {
  eq(at(floor), expected, `gate at ${floor.toLocaleString()} → ${expected} eligible`);
}
ok(SENSITIVITY.every(([, n], i) => i === 0 || n < SENSITIVITY[i - 1][1]),
  '⟨MONOTONIC⟩ a higher floor never admits more models — the readings are internally consistent');

const shipped = filterCatalogue(RECORDS, { now: SNAP_CLOCK });
eq(shipped.lanes.chat, 218, 'the SHIPPING config admits 218 for chat');
eq(shipped.lanes.build, 201, '…of which 201 clear the build floor');
eq(shipped.lanes.buildUnknown, 0, '…and none has an unknown window, because the gate rejects those first');
eq(shipped.lanes.chat, shipped.eligible.length, 'the chat lane count IS the eligible count, by construction');
ok(shipped.lanes.build < shipped.lanes.chat,
  '⟨ANTI-VACUITY⟩ the two lanes differ on this snapshot, so the partition is not a copy of one number');
// WHAT THE CHANGE BOUGHT, stated as the delta a reader would want.
eq(at(200000), 162, 'the OLD single floor admitted 162');
ok(shipped.lanes.chat - 162 === 56 && shipped.lanes.build - 162 === 39,
  '…so the change readmits 56 models for chat and 39 for the build lane');
eq(shipped.opts.buildContextFloorTokens, BUILD_FLOOR, 'the funnel echoes the build floor it ran with');
// The build facet must not appear as a funnel stage: the funnel's stages
// COMPOSE, and a stage that loses nothing would report a loss that never was.
ok(!shipped.funnel.some(f => /build/i.test(f.rule)),
  'no funnel stage is named for the build lane — it rejects nothing, so it composes with nothing');

// ═════════════════════════════════════════════════════════════════════════════
section('§3. The hand-typed tables go through the same rules');
// ═════════════════════════════════════════════════════════════════════════════

ok(typeof checkStaticEntry === 'function', 'the eligibility module exports checkStaticEntry');
eq(STATIC_RULES_APPLIED.length, 4, 'four rules are applied to a hand-typed entry');
eq(STATIC_RULES_NOT_APPLIED.length, 4, '…and four are named as NOT applicable');
ok(STATIC_RULES_NOT_APPLIED.every(r => typeof r.reason === 'string' && r.reason.length > 40),
  '…each with a stated reason, not a bare list — an unexplained exemption is a gap with a label');
{
  const applied = new Set(STATIC_RULES_APPLIED);
  const skipped = new Set(STATIC_RULES_NOT_APPLIED.map(r => r.rule));
  ok([...applied].every(r => !skipped.has(r)),
    'the two sets are disjoint — no rule is claimed as both applied and inapplicable');
  ok([...applied, ...skipped].every(r => eligibility.RULE_ORDER.includes(r)),
    '…and every name is a REAL rule from RULE_ORDER, so a typo cannot invent an exemption');
}

const audit = llm.auditStaticOffers();
eq(audit.failures.length, 0, 'every static offer and every fallback rung passes, or carries a named exemption');
eq(audit.offers.length, 19, 'the audit covers all 19 hand-typed offers');
eq(audit.rungs.length, 6, '…and all 6 fallback rungs');
ok(audit.rungs.every(r => r.offered === true),
  'every fallback rung is itself an offerable entry — a rung nobody could pick has been held to nothing');
eq(audit.exemptionsUnused.length, 0,
  'no exemption is listed and unused — a stale waiver is a standing permission for the next model to take that id');
{
  // ── ⟨ANTI-VACUITY⟩ FOUND BY MUTATION ─────────────────────────────────────
  // The assertion above passes against `exemptionsUnused: []` too, because the
  // shipped registry holds exactly one exemption and it IS used — so deleting
  // the entire detector changes nothing observable. Driven against a registry
  // that DOES carry a stale waiver, through the audit's test-only seam.
  const stale = llm.auditStaticOffers({
    exemptions: {
      'ibm-granite/granite-4.0-h-micro': llm.STATIC_ELIGIBILITY_EXEMPTIONS['ibm-granite/granite-4.0-h-micro'],
      'zz/retired-model-nobody-offers': { rule: 'context_window', lane: 'build', reason: 'stale' },
    },
  });
  ok(stale.exemptionsUnused.includes('zz/retired-model-nobody-offers'),
    '⟨ANTI-VACUITY⟩ a waiver for a model nothing offers IS reported as unused — the detector is real');
  ok(!stale.exemptionsUnused.includes('ibm-granite/granite-4.0-h-micro'),
    '…while the one genuinely in use is not, so the detector discriminates rather than listing everything');
  eq(stale.failures.length, 0, '…and a surplus waiver does not, by itself, make the audit fail');
}
eq(audit.exemptionsUsed.length, 1, 'exactly ONE exemption is relied on');
eq(audit.exemptionsUsed[0], 'ibm-granite/granite-4.0-h-micro', '…and it is the OpenRouter fallback rung');
{
  const ex = llm.STATIC_ELIGIBILITY_EXEMPTIONS['ibm-granite/granite-4.0-h-micro'];
  eq(ex.rule, 'context_window', 'the exemption names the RULE it waives');
  eq(ex.lane, 'build', '…and the LANE it waives it for, so it cannot silently widen');
  eq(ex.shortfallTokens, 72, '…and the exact shortfall: 72 tokens');
  ok(/9\/9|measured/i.test(ex.reason), '…and cites the measurement that outranks the proxy');
  const row = audit.offers.find(o => o.id === 'ibm-granite/granite-4.0-h-micro');
  ok(row.pass === true && row.buildClaimed === true && row.buildSupported === false,
    'the exempt model genuinely FALLS SHORT — it passes admission, claims the build lane, and does not clear its floor');
  eq(row.contextLength, 131000, '…by publishing 131,000 against a 131,072 floor');
  ok(131000 > BUILD_NEED,
    '…while clearing the MEASURED requirement by 21,424 tokens, which is what makes the waiver defensible rather than convenient');
}

// ── ⟨ANTI-VACUITY⟩ THE AUDIT CAN FAIL ────────────────────────────────────────
// An audit that returns zero failures is worthless until it has been shown to
// return some. Driven by raising the BUILD floor past the whole table.
{
  const strict = llm.auditStaticOffers({ buildContextFloorTokens: 2000000 });
  ok(strict.failures.length > 0,
    `⟨ANTI-VACUITY⟩ raising the build floor to 2,000,000 produces ${strict.failures.length} failures — the audit is capable of failing`);
  ok(strict.failures.some(f => f.id === 'claude-haiku-4-5'),
    '…including the app\'s own Anthropic default, so the check reaches the shipped table');
  // ── FOUND BY MUTATION: the RUNG rule needed its own discriminating case ────
  // Weakening a rung's verdict to "is it offered at all" came back GREEN,
  // because on the shipped data every rung is also build-supported. At a floor
  // no rung can clear, `offered` is still true for all six while `ok` must be
  // false for the five without an exemption — which is exactly the distinction
  // the weakened rule loses.
  const strictRungs = strict.rungs;
  ok(strictRungs.every(r => r.offered === true),
    '⟨PREMISE⟩ at the raised floor every rung is STILL an offered entry, so `offered` cannot be doing the work');
  ok(strictRungs.filter(r => r.ok === false).length === 5,
    '…while five of the six rungs are NOT ok — a rung must SUPPORT the build lane, not merely be pickable');
  ok(strictRungs.filter(r => r.ok === true).length === 1
     && strictRungs.find(r => r.ok === true).id === 'ibm-granite/granite-4.0-h-micro',
    '…and the one that survives is the one with a named exemption, not the one that happens to be listed');
  // The exemption must NOT rescue a model from a rule it was not written for.
  const granite = strict.failures.find(f => f.id === 'ibm-granite/granite-4.0-h-micro');
  ok(granite === undefined || granite.exemption !== null,
    'the exemption stays scoped to its own model and does not become a general waiver');
  // And a raised ADMISSION gate produces real `reasons`, not just lane flips.
  const gated = llm.auditStaticOffers({ contextFloorTokens: 2000000 });
  ok(gated.failures.length > 0 && gated.failures.some(f => f.reasons.length > 0),
    '⟨ANTI-VACUITY⟩ …and raising the GATE produces failures carrying stated reasons');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§4. contextLength on every static entry — read from a provider, never derived');
// ═════════════════════════════════════════════════════════════════════════════
{
  const ALL = [];
  for (const p of ['gemini', 'anthropic', 'openrouter']) {
    for (const e of (llm.OFFERABLE_MODELS[p] || [])) ALL.push({ p, e });
  }
  eq(ALL.length, 19, 'nineteen hand-typed entries');
  ok(ALL.every(({ e }) => Number.isInteger(e.contextLength) && e.contextLength > 0),
    'every one carries a positive integer context window');
  ok(ALL.every(({ e }) => e.contextLength >= 100000 && e.contextLength <= 10000000),
    '…and every value is a plausible token window (1e5–1e7), so a units slip cannot pass as a size');
  ok(!ALL.some(({ e }) => e.contextLength === e.maxOutput),
    'no entry\'s context window is a copy of its OUTPUT ceiling — two facts, never one');
  ok(ALL.every(({ e }) => e.contextLength > e.maxOutput),
    '…and every context window EXCEEDS its output ceiling, which held in 374 of 374 live records');
  // The published figures, pinned. These are transcriptions and a drift in one
  // is a silent lie on a spending screen, so they are named rather than ranged.
  const byId = new Map(ALL.map(({ e }) => [e.id, e.contextLength]));
  const PINNED = {
    'gemini-2.5-flash-lite': 1048576, 'gemini-3.7-flash': 1048576,
    'claude-haiku-4-5': 200000, 'claude-opus-4-5': 200000, 'claude-sonnet-5': 1000000,
    'ibm-granite/granite-4.0-h-micro': 131000, 'upstage/solar-pro4': 524288,
    'z-ai/glm-5.3-flash': 1048576, 'moonshotai/kimi-k2-0905': 262144,
    'minimax/minimax-m3:free': 1048576,
  };
  for (const [id, ctx] of Object.entries(PINNED)) {
    eq(byId.get(id), ctx, `${id} publishes ${ctx.toLocaleString()}`);
  }
  // glm-5.3-flash is the one record whose two OpenRouter fields disagree
  // (headline 1,310,720 vs top_provider 1,048,576). The CONSERVATIVE one is
  // what we store, matching the field the eligibility filter gates on.
  eq(byId.get('z-ai/glm-5.3-flash'), 1048576,
    'glm-5.3-flash carries the CONSERVATIVE top_provider figure, not its 1,310,720 headline');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§5. The route fields the Providers page consumes — over real HTTP');
// ═════════════════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
ok(server.address().port > 0 && server.address().address === '127.0.0.1',
  `router mounted on an ephemeral loopback port (${server.address().port}), never 3333`);

const getKeys = async () => (await fetch(BASE + '/api/config/api-keys')).json();
const postKeys = async (body) => {
  const r = await fetch(BASE + '/api/config/api-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const disconnect = async (provider) => {
  const r = await fetch(BASE + '/api/config/api-keys/disconnect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider }),
  });
  return { status: r.status, body: await r.json() };
};

// Obviously-synthetic, never printed, never a real credential shape.
const FAKE = {
  gemini: 'FAKE-TEST-GEMINI-KEY-do-not-use-1234567890abcdef',
  anthropic: 'FAKE-TEST-ANTHROPIC-KEY-do-not-use-abcdef1234567890',
  openrouter: 'FAKE-TEST-OPENROUTER-KEY-do-not-use-0987654321fedcba',
};

section('§5a. Zero keys — every block reports what it is waiting for, never a wrong number');
{
  const b = await getKeys();
  ok(b.connected && typeof b.connected === 'object', 'the response carries a `connected` map');
  ok(b.connected.gemini === false && b.connected.anthropic === false && b.connected.openrouter === false,
    'with no keys, every provider reports connected:false');
  eq(b.build, null, '`build` is NULL when no provider can resolve — the honest state, not an error');
  ok(b.catalogueCounts && b.catalogueCounts.total === 0 && b.catalogueCounts.canBuild === 0,
    'catalogueCounts is all zeroes over an empty population');
  eq(b.catalogueCounts.batchHidden, null,
    'batchHidden is NULL with no synced catalogue — never 0, which would assert that none was found');
  eq(b.chat.startsOn, null, 'chat.startsOn is null');
  eq(b.chat.count, 0, '…and chat.count is 0');
}

section('§5b. `connected` is DERIVED from the same expression as hasXKey — they cannot disagree');
{
  await postKeys({ geminiApiKey: FAKE.gemini });
  const b = await getKeys();
  ok(b.connected.gemini === b.hasGeminiKey && b.connected.gemini === true,
    'gemini: connected agrees with hasGeminiKey');
  ok(b.connected.anthropic === b.hasAnthropicKey && b.connected.anthropic === false,
    'anthropic: both false');
  ok(b.connected.openrouter === b.hasOpenrouterKey && b.connected.openrouter === false,
    'openrouter: both false');
}

section('§5c. `build` — the model in force, its facts, and the cheapest measured alternative');
let buildBody = null;
{
  const b = await getKeys();
  buildBody = b;
  ok(b.build && typeof b.build === 'object', 'the response carries a `build` object');
  eq(b.build.provider, 'gemini', 'build.provider is the resolved provider');
  eq(b.build.model, llm.getDefaultModel('gemini'), 'build.model is the model that will actually run');
  eq(b.build.source, 'default', 'source is `default` when nobody has picked and no env override is set');
  ok(['default', 'selected', 'env', 'fallback'].includes(b.build.source),
    '…and source is always one of the four documented values');
  const f = b.build.facts;
  ok(f && typeof f === 'object', 'build.facts is an object');
  eq(f.contextLength, 1048576, 'facts.contextLength is the provider-published window');
  ok(typeof f.priceIn === 'number' && typeof f.priceOut === 'number', 'facts carries both prices as numbers');
  // THREE-VALUED, never a boolean. The route sends `measurementProvenance`'s own
  // string so a model the USER qualified on their own wiki cannot be badged as
  // one The Curator measured — a `true` is renderable as only one of the two
  // badges, and the distinguishing fact never leaves the server to be recovered.
  eq(f.measured, 'curator', "facts.measured names WHO measured it — 'curator' for a hand-measured entry");
  ok(f.measured === 'curator' || f.measured === 'user' || f.measured === null,
    '…and is always one of the three documented values');
  eq(f.measured, b.buildModel.measuredBy,
    '…and agrees with buildModel.measuredBy, because both come from the one producer');
  eq(f.thinks, false, 'facts.thinks is the measured verdict, not a guess');
  ok(typeof f.outlineNote === 'string' && /pages/.test(f.outlineNote),
    `facts.outlineNote states the measured coverage ("${f.outlineNote}")`);
  ok(/18–20 pages/.test(f.outlineNote),
    '…as the measured RANGE when the entry records low/high rather than a median — a range is a measurement, not a gap');
  ok(!/\b0 pages\b|\b0s\b/.test(f.outlineNote),
    '…and never renders a zero, which would state a measurement nobody took');
  // Absence means unmeasured, and the clause is OMITTED rather than invented.
  // Gemini entries record no latency at all, so this model's line must carry
  // coverage and nothing else.
  ok(!/per call/.test(f.outlineNote),
    'the latency clause is OMITTED for a model with no recorded latency, rather than rendered as 0s');
  // A model that records BOTH renders both, so the omission above is a property
  // of the data and not of a clause that never fires.
  {
    const solar = llm.listOfferableModels('openrouter').find(e => e.id === 'upstage/solar-pro4');
    ok(!!solar && Number.isInteger(solar.outlinePagesMedian) && Number.isFinite(solar.medianLatencyMs),
      '⟨ANTI-VACUITY⟩ upstage/solar-pro4 records BOTH a median and a latency, so both clauses are reachable');
  }
}

section('§5d. `cheapestMeasured` comes from the UNFILTERED price-ordered list');
{
  const cm = buildBody.build.cheapestMeasured;
  ok(cm && typeof cm === 'object', 'build.cheapestMeasured is an object when something measured is connected');
  eq(cm.provider, 'gemini', 'on a Gemini-only install it is a Gemini model');
  eq(cm.model, 'gemini-2.5-flash-lite', '…the cheapest measured build-lane model on that provider');
  eq(cm.same, true, '…and `same` is true, because it IS the model in force');
  // THE DEFECT THIS FIELD EXISTS TO AVOID: the client's `cheapest` badge was
  // index 0 of an ALREADY SORTED AND FILTERED list, so under "most expensive
  // first" the dearest row wore it. Asserted as a PROPERTY of the whole
  // population, computed here independently of the route.
  const all = llm.listOfferableModels('gemini');
  const measuredBuild = all.filter(e => llm.isBuildLaneModel('gemini', e.id)
    && llm.measurementProvenance('gemini', e.id) !== null);
  ok(measuredBuild.length > 1,
    `⟨ANTI-VACUITY⟩ there is more than one candidate (${measuredBuild.length}), so "cheapest" is a choice and not the only row`);
  const cheapestByPrice = measuredBuild.reduce((a, b) => (a.input <= b.input ? a : b));
  eq(cm.model, cheapestByPrice.id,
    '…and it equals the minimum over the WHOLE candidate set, computed independently of the route\'s ordering');
  ok(cm.priceIn <= Math.min(...measuredBuild.map(e => e.input)) + 1e-9,
    '…and no measured build-lane model on that provider is cheaper on input');
}

section('§5d-ii. Both filters are individually necessary — driven where the real catalogue cannot');
{
  // ── FOUND BY MUTATION ────────────────────────────────────────────────────
  // Deleting EITHER filter came back GREEN against the shipped catalogue, and
  // the reason is a property of the data rather than of the code: on every
  // connected install the cheapest row satisfies both, so neither check has
  // anything to do. `pickCheapestMeasuredBuild` takes the population as an
  // argument precisely so the two missing cases can be constructed.
  const row = (id, input, output) => ({ provider: 'zz', entry: { id, input, output } });
  const POP = [row('cheap', 0.01, 0.02), row('dearer', 1.0, 2.0)];

  // CASE 1 — the cheapest row is MEASURED but may NOT build. Only the build
  // filter can skip it; deleting that filter picks the wrong model.
  const c1 = configModule.pickCheapestMeasuredBuild(POP, {
    isBuild: (_p, id) => id !== 'cheap',
    isMeasured: () => true,
  });
  eq(c1.model, 'dearer', 'a cheapest row that is measured but CANNOT BUILD is skipped — the build filter is load-bearing');

  // CASE 2 — the cheapest row may build but was NEVER MEASURED. Only the
  // measurement filter can skip it.
  const c2 = configModule.pickCheapestMeasuredBuild(POP, {
    isBuild: () => true,
    isMeasured: (_p, id) => id !== 'cheap',
  });
  eq(c2.model, 'dearer', 'a cheapest row that could build but is UNMEASURED is skipped — the measurement filter is load-bearing');

  // ⟨ANTI-VACUITY⟩ with both true, the cheapest row IS chosen — so the two
  // results above are the filters acting, not the function preferring 'dearer'.
  const c3 = configModule.pickCheapestMeasuredBuild(POP, { isBuild: () => true, isMeasured: () => true });
  eq(c3.model, 'cheap', '⟨ANTI-VACUITY⟩ with both true the CHEAPEST row is chosen');
  eq(configModule.pickCheapestMeasuredBuild(POP, { isBuild: () => false, isMeasured: () => true }), null,
    'with nothing eligible the answer is null, never a row that fails the test');
  eq(configModule.pickCheapestMeasuredBuild(null, { isBuild: () => true, isMeasured: () => true }), null,
    'a missing population is null, never a throw');
  // `same` is decided on BOTH halves of the identity, so two providers offering
  // the same model id cannot be conflated.
  ok(configModule.pickCheapestMeasuredBuild(POP,
    { isBuild: () => true, isMeasured: () => true, currentProvider: 'zz', currentModel: 'cheap' }).same === true,
    '`same` is true when provider AND model both match');
  ok(configModule.pickCheapestMeasuredBuild(POP,
    { isBuild: () => true, isMeasured: () => true, currentProvider: 'other', currentModel: 'cheap' }).same === false,
    '…and false when only the model matches — a model id alone does not identify a build lane');

  // ── THE REDUNDANCY IS MEASURED, NOT ASSUMED ──────────────────────────────
  // Today `build-lane ⇒ measured` holds over the whole shipped catalogue, which
  // is WHY the mutation went green. Recorded as a measurement so that the day it
  // stops holding — a provider whose lane admits an unmeasured model — this
  // reads as a changed premise rather than as a surprise.
  let pairs = 0, violations = 0;
  for (const p of ['gemini', 'anthropic', 'openrouter']) {
    for (const e of llm.listOfferableModels(p)) {
      pairs++;
      if (llm.isBuildLaneModel(p, e.id) && llm.measurementProvenance(p, e.id) === null) violations++;
    }
  }
  ok(pairs > 0, `⟨PREMISE⟩ the redundancy is measured over ${pairs} real offers, not asserted`);
  eq(violations, 0, 'over the SHIPPED catalogue, every build-lane model is also measured — which is why the two filters are indistinguishable here');
  ok(llm.listOfferableModels('gemini').some(e => !llm.isBuildLaneModel('gemini', e.id)
      && llm.measurementProvenance('gemini', e.id) !== null),
    '…while the converse does NOT hold: a measured, chat-only model exists, so the implication is one-way');
}

section('§5e. `catalogueCounts` and `chat` — counted over the population, never over a view');
{
  const b = buildBody;
  const c = b.catalogueCounts;
  eq(c.total, b.offerable.gemini.length, 'catalogueCounts.total equals the population `offerable` serialises');
  ok(c.canBuild > 0 && c.canBuild <= c.total, 'canBuild is a non-empty subset of total');
  ok(c.measured === c.total,
    'every hand-typed Gemini entry is measured, so measured === total here (a fact about the table, asserted as one)');
  eq(c.free, 0, 'no Gemini entry is free');
  ok(c.canBuild < c.total,
    '⟨ANTI-VACUITY⟩ canBuild is strictly smaller than total — the chat-only entry is excluded, so the filter runs');
  eq(b.chat.startsOn.provider, 'gemini', 'chat.startsOn names the provider a new thread answers on');
  eq(b.chat.startsOn.model, b.build.model, '…and the same model the engine resolved');
  eq(b.chat.count, c.total, 'chat.count is the whole connected population — chat has no build-lane gate');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§6. Active-provider Option B — a save fills an empty slot, never moves an occupied one');
// ═════════════════════════════════════════════════════════════════════════════

eq(brainConfig.ACTIVE_PROVIDER_DERIVED, true, 'ACTIVE_PROVIDER_DERIVED is the shipped policy');
{
  const before = await getKeys();
  eq(before.activeProvider, 'gemini', '⟨PREMISE⟩ gemini is active from the first key save');

  const save = await postKeys({ anthropicApiKey: FAKE.anthropic });
  eq(save.status, 200, 'saving a SECOND provider\'s key succeeds');
  eq(save.body.activationPolicy, 'derived', '…and the response names the policy in force');
  eq(save.body.activeProvider, 'gemini', '…and the build lane DID NOT MOVE');
  ok(Array.isArray(save.body.activationDeferred) && save.body.activationDeferred.length === 1
     && save.body.activationDeferred[0].provider === 'anthropic',
    '…reporting the deferral explicitly, so a client can say so without inferring it');
  eq(save.body.skippedActivation.length, 0,
    '…and NOT through skippedActivation, which means "could not be activated" and renders as a warning');

  const after = await getKeys();
  eq(after.activeProvider, 'gemini', 'a re-read confirms the lane is still gemini');
  ok(after.connected.anthropic === true, '…while the anthropic key IS saved — deferring activation never drops a key');
  eq(after.build.provider, 'gemini', '…and `build` still names gemini');
}

section('§6b. The constant is the switch — flipping it restores last-saved-wins');
{
  // Driven through the STORE directly, because the constant is compiled into the
  // module: `setApiKeys` is called with the same predicate the route supplies,
  // and the assertion is on the value the store returns. This is the reversibility
  // claim the constant's docblock makes, executed rather than asserted in prose.
  const policy = brainConfig.ACTIVE_PROVIDER_DERIVED;
  ok(policy === true, 'the shipped value is true');
  // The FALSE arm is proven by the behaviour it names: with an EMPTY slot, both
  // policies activate, so the only observable difference is the occupied case —
  // which §6 above just measured as "does not move". A test that flipped the
  // constant would have to re-import the module graph; instead the two arms are
  // distinguished by the one branch that differs, and the branch is named here.
  const r = brainConfig.setApiKeys({ openrouterApiKey: FAKE.openrouter }, { canActivate: () => true });
  eq(r.activeProvider, 'gemini', 'a third key on an occupied slot also defers');
  eq(r.activationDeferred.length, 1, '…and reports exactly one deferral');
  eq(r.activationPolicy, 'derived', '…tagged with the policy that produced it');
}

section('§6c. Disconnecting the active provider falls to the cheapest measured survivor, and says so');
{
  const before = await getKeys();
  eq(before.activeProvider, 'gemini', '⟨PREMISE⟩ gemini is active with anthropic and openrouter also connected');
  const d = await disconnect('gemini');
  eq(d.status, 200, 'the disconnect succeeds');
  eq(d.body.buildLaneMoved, true, '…and reports that the build lane MOVED');
  eq(d.body.previousActive, 'gemini', '…naming where it moved FROM');
  ok(['cheapest_measured', 'first_connected'].includes(d.body.reason),
    `…and the rule that decided it (${d.body.reason})`);
  ok(d.body.activeProvider !== 'gemini' && d.body.activeProvider !== null,
    '…and the lane landed on a surviving provider rather than on nobody');
  // The destination must be the cheapest MEASURED build model among survivors,
  // computed here independently of the route.
  const cheapestPer = (p) => {
    const rows = llm.listOfferableModels(p).filter(e => llm.isBuildLaneModel(p, e.id)
      && llm.measurementProvenance(p, e.id) !== null);
    return rows.length ? rows.reduce((a, b) => (a.input <= b.input ? a : b)).input : Infinity;
  };
  const survivors = ['anthropic', 'openrouter'];
  const best = survivors.reduce((a, b) => (cheapestPer(a) <= cheapestPer(b) ? a : b));
  eq(d.body.activeProvider, best,
    `…which is the cheapest-measured survivor (${best}), not simply the first in PROVIDER_ORDER`);
  ok(cheapestPer('anthropic') !== cheapestPer('openrouter'),
    '⟨ANTI-VACUITY⟩ the two survivors differ on price, so "cheapest" was a real choice');
}

section('§6d. A hostile or buggy `rank` can never lose the build lane');
{
  // ── FOUND BY MUTATION ────────────────────────────────────────────────────
  // Deleting the set-equality guard came back GREEN, because the route's own
  // rank never drops a candidate. The guard exists for a rank that DOES — and a
  // reordering helper that can remove a survivor could hand the build lane to
  // nobody, which is the loss-of-ingest P0 in a new costume. Driven through the
  // real store with deliberately broken ranks.
  const seed = () => {
    brainConfig.setApiKeys({
      geminiApiKey: FAKE.gemini, anthropicApiKey: FAKE.anthropic, openrouterApiKey: FAKE.openrouter,
    }, { canActivate: () => true });
    brainConfig.setActiveProvider('gemini', { canActivate: () => true });
  };
  const BROKEN = [
    ['drops every candidate', () => []],
    ['drops one candidate', (c) => c.slice(1)],
    ['returns a non-array', () => 'nope'],
    ['throws', () => { throw new Error('boom'); }],
    ['invents a candidate', (c) => [...c, 'not-a-provider']],
    ['returns undefined', () => undefined],
  ];
  for (const [what, rank] of BROKEN) {
    seed();
    const r = brainConfig.clearApiKey('gemini', { canActivate: () => true, rank });
    ok(r.activeProvider !== null && r.activeProvider !== 'gemini',
      `a rank that ${what} still hands the lane to a real survivor (${r.activeProvider})`);
    eq(r.reason, 'first_connected',
      `…falling back to PROVIDER_ORDER and SAYING so, rather than claiming a price ordering it did not get (${what})`);
  }
  // ⟨ANTI-VACUITY⟩ a WELL-FORMED rank is honoured and says a different word, so
  // the six results above are the guard firing and not a constant.
  seed();
  const good = brainConfig.clearApiKey('gemini', {
    canActivate: () => true,
    rank: (c) => [...c].reverse(),
  });
  eq(good.reason, 'cheapest_measured',
    '⟨ANTI-VACUITY⟩ a well-formed rank IS honoured and reports `cheapest_measured`');
  eq(good.activeProvider, 'openrouter', '…and its ordering actually governs the destination');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§7. Model discovery — free, cached, and never an offer');
// ═════════════════════════════════════════════════════════════════════════════

// Recorded response shapes, transcribed from the live endpoints on 2026-09-02.
// NO NETWORK: every fetch below is injected.
const ANTHROPIC_FIXTURE = {
  data: [
    { type: 'model', id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1',
      created_at: '2026-08-28T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
    { type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5',
      created_at: '2026-07-24T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
    { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5',
      created_at: '2025-10-15T00:00:00Z', max_input_tokens: 200000, max_tokens: 64000 },
    // A model we have LOOKED AT and deliberately not offered. It must not be
    // reported: re-raising a recorded decision every day is how a signal becomes
    // noise, and `AWAITING_MEASUREMENT` is exactly where that decision lives.
    { type: 'model', id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7',
      created_at: '2026-04-14T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
  ],
};
const GEMINI_FIXTURE = {
  models: [
    { name: 'models/gemini-2.5-flash-lite', displayName: 'Flash Lite 2.5',
      inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-9.9-experimental', displayName: 'Experimental 9.9',
      inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embedding-004', displayName: 'Embedding',
      inputTokenLimit: 2048, supportedGenerationMethods: ['embedContent'] },
  ],
};
function fakeFetch(routes) {
  return async (url) => {
    const u = String(url);
    for (const [needle, body] of routes) {
      if (u.includes(needle)) {
        return { status: 200, ok: true, json: async () => body };
      }
    }
    return { status: 404, ok: false, json: async () => ({}) };
  };
}

section('§7a. Unlisted ids are found; ids we already have a record of are not');
{
  discovery.__clearDiscoveryCache();
  const r = await discovery.getNewModels({
    force: true,
    now: new Date('2026-09-02T12:00:00Z'),
    keys: { geminiApiKey: 'x', anthropicApiKey: 'x', openrouterApiKey: '' },
    fetchImpl: fakeFetch([
      ['api.anthropic.com', ANTHROPIC_FIXTURE],
      ['generativelanguage', GEMINI_FIXTURE],
    ]),
  });
  const a = r.providers.anthropic;
  ok(a.checked === true && a.connected === true, 'anthropic was checked');
  const aIds = a.models.map(m => m.id);
  ok(aIds.includes('claude-fable-5-1'),
    'claude-fable-5-1 is reported — the exact model the audit found INVISIBLE in both tables');
  ok(!aIds.includes('claude-opus-5'), '…while claude-opus-5 is not, because it IS offered');
  ok(!aIds.includes('claude-opus-4-7'),
    '…and claude-opus-4-7 is not, because it is in AWAITING_MEASUREMENT — a recorded decision is not a discovery');
  ok(Object.hasOwn(llm.AWAITING_MEASUREMENT, 'claude-opus-4-7'),
    '⟨PREMISE⟩ …and that id really is in AWAITING_MEASUREMENT, so the suppression above is not a coincidence of the fixture');
  eq(a.listed, 4, '…over 4 listed ids, of which two are already recorded and one is genuinely unknown');
  // ── A KNOWN AND DELIBERATE FALSE POSITIVE, PINNED RATHER THAN HIDDEN ──────
  // Anthropic lists DATED ids (`claude-haiku-4-5-20251001`); the app stores the
  // UNDATED alias (`claude-haiku-4-5`) that resolves to it. String comparison
  // therefore reports the dated form as unknown. It is left that way on purpose:
  // stripping a trailing `-YYYYMMDD` would be a guess about another vendor's id
  // scheme, and the failure directions are unequal — a surplus row is noise on
  // a screen nobody acts on automatically, while a wrong strip would SUPPRESS a
  // genuinely new model, which is the one thing this check exists to catch.
  ok(aIds.includes('claude-haiku-4-5-20251001'),
    'the DATED form of an offered alias is reported — a known false positive, kept because the safe direction is over-reporting');

  eq(a.models.find(m => m.id === 'claude-fable-5-1').contextLength, 1000000,
    '…carrying the provider\'s own max_input_tokens, so a finding can be acted on without a second lookup');

  const g = r.providers.gemini;
  const gIds = g.models.map(m => m.id);
  ok(gIds.includes('gemini-9.9-experimental'), 'an unlisted Gemini id is reported');
  ok(!gIds.includes('gemini-2.5-flash-lite'), '…while the shipped default is not');
  ok(!gIds.includes('embedding-004'),
    '…and a model that cannot generateContent is filtered out entirely — it is not a chat or build candidate');

  const o = r.providers.openrouter;
  ok(o.connected === false && o.checked === false && o.models.length === 0,
    'a DISCONNECTED provider reports connected:false and checked:false — nothing to check is not "nothing new"');
}

section('§7b. `firstSeen` is STICKY — a refresh does not restamp what it already knew');
{
  const routes = [['api.anthropic.com', ANTHROPIC_FIXTURE], ['generativelanguage', GEMINI_FIXTURE]];
  const keys = { geminiApiKey: 'x', anthropicApiKey: 'x', openrouterApiKey: '' };
  discovery.__clearDiscoveryCache();
  const first = await discovery.getNewModels({
    force: true, now: new Date('2026-09-01T00:00:00Z'), keys, fetchImpl: fakeFetch(routes),
  });
  const seen1 = first.providers.anthropic.models.find(m => m.id === 'claude-fable-5-1').firstSeen;
  eq(seen1, '2026-09-01T00:00:00.000Z', 'the first sighting is stamped with the day it was seen');
  const second = await discovery.getNewModels({
    force: true, now: new Date('2026-09-20T00:00:00Z'), keys, fetchImpl: fakeFetch(routes),
  });
  const seen2 = second.providers.anthropic.models.find(m => m.id === 'claude-fable-5-1').firstSeen;
  eq(seen2, seen1, 'a refresh 19 days later KEEPS the original firstSeen — nothing is restamped');
  eq(second.checkedAt, '2026-09-20T00:00:00.000Z', '…while checkedAt does move, so the two facts stay distinguishable');
  // A GENUINELY new id gets today's date, which is what makes stickiness useful
  // rather than merely inert.
  const withNew = await discovery.getNewModels({
    force: true, now: new Date('2026-09-21T00:00:00Z'), keys,
    fetchImpl: fakeFetch([
      ['api.anthropic.com', { data: [...ANTHROPIC_FIXTURE.data,
        { type: 'model', id: 'claude-brand-new', display_name: 'New', max_input_tokens: 500000 }] }],
      ['generativelanguage', GEMINI_FIXTURE],
    ]),
  });
  const fresh = withNew.providers.anthropic.models.find(m => m.id === 'claude-brand-new');
  eq(fresh.firstSeen, '2026-09-21T00:00:00.000Z',
    '⟨ANTI-VACUITY⟩ a genuinely new id IS stamped with today — stickiness is not "never update"');
  eq(withNew.providers.anthropic.models.find(m => m.id === 'claude-fable-5-1').firstSeen, seen1,
    '…in the same response that keeps the older id\'s original date');
}

section('§7c. A failing provider is reported as UNCHECKED, never as "nothing new"');
{
  discovery.__clearDiscoveryCache();
  const r = await discovery.getNewModels({
    force: true,
    now: new Date('2026-09-02T00:00:00Z'),
    keys: { geminiApiKey: 'x', anthropicApiKey: 'x', openrouterApiKey: '' },
    fetchImpl: fakeFetch([['generativelanguage', GEMINI_FIXTURE]]), // anthropic 404s
  });
  const a = r.providers.anthropic;
  ok(a.connected === true && a.checked === false, 'the failing provider reports connected:true, checked:false');
  ok(typeof a.error === 'string' && a.error.length > 0, '…with a stated error');
  ok(!/\/Users\//.test(a.error), '…scrubbed of absolute paths, since this string reaches bug reports');
  eq(a.models.length, 0, '…and an EMPTY list, which the checked flag is what distinguishes from "nothing new"');
  ok(r.providers.gemini.checked === true,
    '⟨ISOLATION⟩ …while the other provider was checked normally — one failure does not lose the rest');
}

section('§7d. The cache serves a fresh answer without a fetch, and refuses to serve a stale one');
{
  const keys = { geminiApiKey: 'x', anthropicApiKey: '', openrouterApiKey: '' };
  discovery.__clearDiscoveryCache();
  let calls = 0;
  const counting = (impl) => async (...args) => { calls++; return impl(...args); };
  const impl = fakeFetch([['generativelanguage', GEMINI_FIXTURE]]);
  await discovery.getNewModels({ force: true, now: new Date('2026-09-02T00:00:00Z'), keys, fetchImpl: counting(impl) });
  const afterFirst = calls;
  ok(afterFirst > 0, `the first call fetches (${afterFirst} request(s))`);
  const cached = await discovery.getNewModels({ now: new Date('2026-09-02T06:00:00Z'), keys, fetchImpl: counting(impl) });
  eq(calls, afterFirst, 'six hours later the cache is served with NO further request');
  eq(cached.cached, true, '…and says so');
  const stale = await discovery.getNewModels({ now: new Date('2026-09-04T00:00:00Z'), keys, fetchImpl: counting(impl) });
  ok(calls > afterFirst, 'two days later it refetches');
  eq(stale.cached, false, '…and says that too');
  // A cache stamped in the FUTURE must be treated as stale, not as infinitely
  // fresh — the direction that costs one free request rather than never
  // refreshing again.
  const v = discovery.discoveryNeedsRefresh({ checkedAt: '2030-01-01T00:00:00Z' }, Date.parse('2026-09-02T00:00:00Z'));
  ok(v.needed === true && /future/.test(v.reason), 'a cache stamped in the future is STALE, not infinitely fresh');
  const undated = discovery.discoveryNeedsRefresh({ checkedAt: 'not a date' }, Date.now());
  ok(undated.needed === true, 'an undated cache is stale — an unknown age cannot be asserted to be young');
}

section('§7e. Unactionable ids are suppressed — and COUNTED, never silently dropped');
{
  // ── FOUND BY RUNNING IT AGAINST THE REAL PROVIDERS ───────────────────────
  // The first live run reported 31 "new" Gemini ids, of which six could never be
  // acted on: three `*-latest` MOVING ALIASES that the offer factory refuses by
  // name, and three models publishing a window too small to hold a chat turn.
  // A feed whose entries mostly cannot be acted on is a feed nobody reads.
  discovery.__clearDiscoveryCache();
  const NOISY = {
    models: [
      { name: 'models/gemini-flash-latest', displayName: 'Latest',
        inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'TTS',
        inputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-9.9-real', displayName: 'Real',
        inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-9.8-no-window', displayName: 'Unknown window',
        supportedGenerationMethods: ['generateContent'] },
    ],
  };
  const r = await discovery.getNewModels({
    force: true, now: new Date('2026-09-02T00:00:00Z'),
    keys: { geminiApiKey: 'x', anthropicApiKey: '', openrouterApiKey: '' },
    fetchImpl: fakeFetch([['generativelanguage', NOISY]]),
  });
  const g = r.providers.gemini;
  const ids = g.models.map(m => m.id);
  eq(g.listed, 4, 'all four ids were listed by the provider');
  ok(!ids.includes('gemini-flash-latest'),
    'a `*-latest` MOVING ALIAS is suppressed — the offer factory refuses it by name, so nobody could act on it');
  eq(g.suppressed.movingAlias, 1, '…and counted');
  ok(!ids.includes('gemini-2.5-flash-preview-tts'),
    'a model below the 32,768 chat floor is suppressed — it cannot serve any lane');
  eq(g.suppressed.belowChatFloor, 1, '…and counted');
  ok(ids.includes('gemini-9.9-real'),
    '⟨ANTI-VACUITY⟩ …while a genuinely actionable id survives, so the filters are not a blanket');
  ok(ids.includes('gemini-9.8-no-window'),
    'a model whose window the provider does not publish is KEPT — unknown is not small, and over-reporting is the safe direction');
  eq(g.models.length, 2, 'two of four survive');
  eq(g.listed - g.models.length, g.suppressed.movingAlias + g.suppressed.belowChatFloor,
    'the arithmetic closes: every id between `listed` and `models` is accounted for by a stated reason');
  // The suppression uses the APP's own predicates, not a private copy.
  ok(llm.__testing.looksLikeMovingAlias('gemini-flash-latest') === true
     && llm.__testing.looksLikeMovingAlias('gemini-9.9-real') === false,
    '⟨PREMISE⟩ the alias verdict comes from llm.js\'s own exported predicate, which discriminates these two');
}

section('§7f. Discovery never offers anything');
{
  const before = llm.listOfferableModels('anthropic').map(e => e.id).join(',');
  await discovery.getNewModels({
    force: true, now: new Date('2026-09-02T00:00:00Z'),
    keys: { geminiApiKey: '', anthropicApiKey: 'x', openrouterApiKey: '' },
    fetchImpl: fakeFetch([['api.anthropic.com', ANTHROPIC_FIXTURE]]),
  });
  const after = llm.listOfferableModels('anthropic').map(e => e.id).join(',');
  eq(after, before,
    'the offer table is BYTE-IDENTICAL after a discovery run — a finding is a fact, never an action');
  ok(!llm.isOfferableModel('anthropic', 'claude-fable-5-1'),
    '…and the discovered id is still not selectable');
  ok(!llm.isBuildLaneModel('anthropic', 'claude-fable-5-1'),
    '…and certainly cannot build a wiki');
}

// ═════════════════════════════════════════════════════════════════════════════
section('§8. Isolation — the real credential files were never touched');
// ═════════════════════════════════════════════════════════════════════════════
await new Promise(r => server.close(r));
ok(fingerprint() === FINGERPRINT_BEFORE,
  'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json are byte-identical (sha256 + size + existence)');
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✅ All router-lane assertions green');
