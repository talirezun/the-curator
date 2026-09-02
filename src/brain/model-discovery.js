/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MODEL DISCOVERY — "your providers are publishing models this app has never
 *  heard of", stated as a FACT and never acted on.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * `OFFERABLE_MODELS` is hand-typed and has NO staleness mechanism. Measured on
 * 2026-09-02: Anthropic's `/v1/models` listed 11 live ids while the app offered
 * 7, and two of the four missing — `claude-fable-5-1` and `claude-fable-5` —
 * were in neither `OFFERABLE_MODELS` nor `AWAITING_MEASUREMENT`. They were not
 * refused, not deferred, not recorded: they were INVISIBLE, and nothing in the
 * repository would ever have said so. Worse, `anthropic/claude-fable-5.1` IS
 * offered through OpenRouter — the same model reachable with one key and not
 * with the other, for no reason anybody decided.
 *
 * ── WHAT THIS IS NOT, AND THE RULES IT IS BOUND BY ─────────────────────────
 *
 * IT NEVER OFFERS ANYTHING. The result is a list of ids and the date each was
 * first seen. Nothing here writes to `OFFERABLE_MODELS`, `AWAITING_MEASUREMENT`
 * or any catalogue, and no code path turns a finding into a selectable model.
 * That is the project's standing rule — *"a model may not be offered for a
 * feature it has never been measured against"* — and an automated discovery
 * feed is precisely the mechanism that would erode it if it were allowed to
 * write. Adding a discovered model to the offer table is a human act that
 * requires a measurement first.
 *
 * "NOT OFFERED" MEANS UNMEASURED, NEVER BETTER AND NEVER WORSE. A newly
 * published id says nothing about quality, price or fitness; `z-ai/glm-4.7`
 * passed every metadata filter this project has and returned 0 usable outlines
 * in 9 real runs. So the wording anywhere this surfaces must stay at the level
 * of "your provider lists this and we have not looked at it".
 *
 * ── WHY `firstSeen` IS STICKY, AND WHY THAT IS THE WHOLE POINT ──────────────
 *
 * The useful question is not "what is unoffered today" — that answer is stable
 * and boring — but "what APPEARED, and when". So `firstSeen` is carried forward
 * across refreshes for any id already known. A refresh that restamped every id
 * with today's date would make everything look new forever, which is the same
 * failure as a notification badge that never clears: after a week nobody reads
 * it. An id that DISAPPEARS from a provider's list is dropped entirely rather
 * than kept with a "last seen" — this file answers one question.
 *
 * ── COST: FREE, AND CACHED ANYWAY ──────────────────────────────────────────
 *
 * All three endpoints are list endpoints: no tokens, no generation, no charge.
 * They are still cached for 24 hours, matching `OPENROUTER_CATALOGUE_MAX_AGE_MS`
 * exactly — the same argument applies (much longer than an app restart, much
 * shorter than the interval over which a provider's line-up moves) and having
 * the two ages agree means a user never sees one list refresh without the
 * other. Free is not the same as unlimited: these are rate-limited endpoints on
 * an account the user needs for real work.
 *
 * ── ONE FAILING PROVIDER MUST NOT LOSE THE OTHER TWO ───────────────────────
 *
 * Each provider is fetched independently and a failure is recorded PER PROVIDER
 * as an error string. A provider that could not be checked reports
 * `checked: false` and never an empty list, because "we asked and there is
 * nothing new" and "we could not ask" are different facts and this project's own
 * rule is that *"we could not check" must never be served as "we checked"*.
 */

import { readFileSync } from 'fs';
import { userDataPath } from './paths.js';
import { writeFileAtomicSync } from './atomic-write.js';
import { scrubPaths } from './scrub-paths.js';
import { getApiKeys } from './config.js';
// NAMESPACE imports, the same degradation posture the rest of this layer uses:
// a not-yet-shipped export resolves to `undefined` and is handled, rather than
// failing module load.
import * as llmModule from './llm.js';
import * as eligibilityModule from './openrouter-eligibility.js';
import { fetchOpenRouterCatalogue } from './openrouter-adapter.js';

const DISCOVERY_FILENAME = '.model-discovery.json';

/** Resolved PER CALL, never snapshotted at module load — v3.1.0's source rule. */
function discoveryPath() {
  return userDataPath(DISCOVERY_FILENAME);
}

/**
 * 24 hours, deliberately the SAME figure as OPENROUTER_CATALOGUE_MAX_AGE_MS.
 * Kept as its own constant rather than imported, because these are two policies
 * that happen to agree today; tying them together would mean a future change to
 * catalogue freshness silently changed how often a user's providers are polled.
 */
export const MODEL_DISCOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Per-request network budget. Generous: these are cold list endpoints. */
const DISCOVERY_TIMEOUT_MS = 15000;

/**
 * Every model id this app already has a RECORD of for a provider — offered,
 * deferred, defaulted, or reachable as a fallback rung.
 *
 * ALL FOUR SOURCES, and the reason is `AWAITING_MEASUREMENT`: an id we have
 * looked at and deliberately not offered is NOT a discovery. Reporting it would
 * mean this feed re-raises, every day, a decision somebody already made and
 * wrote down — which is how a signal becomes noise.
 */
export function knownModelIds(provider) {
  const out = new Set();
  const offerable = typeof llmModule.listOfferableModels === 'function'
    ? llmModule.listOfferableModels(provider) : [];
  for (const e of offerable) if (e && typeof e.id === 'string') out.add(e.id);
  const awaiting = llmModule.AWAITING_MEASUREMENT || {};
  for (const id of Object.keys(awaiting)) out.add(id);
  const chains = llmModule.__testing && llmModule.__testing.FALLBACK_CHAINS;
  for (const id of (chains && chains[provider]) || []) out.add(id);
  const def = typeof llmModule.getDefaultModel === 'function' ? llmModule.getDefaultModel(provider) : null;
  if (typeof def === 'string' && def) out.add(def);
  return out;
}

/** A bounded, newline-free rendering of a thrown error, safe to put on the wire. */
function errText(err) {
  const raw = (err && err.message) ? String(err.message) : String(err);
  return scrubPaths(raw).replace(/[\r\n]+/g, ' ').slice(0, 200);
}

async function getJson(url, headers, fetchImpl, timeoutMs) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('No fetch implementation is available.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || DISCOVERY_TIMEOUT_MS);
  try {
    const res = await f(url, { headers, signal: ctrl.signal });
    if (!res || typeof res.status !== 'number') throw new Error('The provider returned no readable response.');
    if (res.status < 200 || res.status >= 300) {
      // The STATUS only. A provider's error body can echo a request header, and
      // this string is rendered in the app and pasted into bug reports.
      throw new Error(`The provider answered HTTP ${res.status}.`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The ids Anthropic currently lists.
 *
 * `max_input_tokens` is read alongside the id because it is the same figure the
 * static table's `contextLength` is transcribed from — carrying it means a
 * finding can be acted on without a second manual lookup.
 */
export async function fetchAnthropicModels(key, opts = {}) {
  const body = await getJson(
    (opts.baseUrl || 'https://api.anthropic.com') + '/v1/models?limit=100',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    opts.fetchImpl, opts.timeoutMs,
  );
  const rows = Array.isArray(body && body.data) ? body.data : null;
  if (rows === null) throw new Error('Anthropic returned a body with no `data` array.');
  return rows
    .filter(r => r && typeof r.id === 'string')
    .map(r => ({
      id: r.id,
      label: typeof r.display_name === 'string' ? r.display_name : null,
      contextLength: Number.isFinite(r.max_input_tokens) ? r.max_input_tokens : null,
      created: typeof r.created_at === 'string' ? r.created_at : null,
    }));
}

/**
 * The ids Gemini currently lists, filtered to those that can actually generate.
 *
 * AUTHENTICATED BY HEADER, never by `?key=`. Google accepts both; the query form
 * puts a live credential into a URL, which is the one place it can reach a log,
 * a redirect or an error message that quotes the request line.
 */
export async function fetchGeminiModels(key, opts = {}) {
  const body = await getJson(
    (opts.baseUrl || 'https://generativelanguage.googleapis.com') + '/v1beta/models?pageSize=200',
    { 'x-goog-api-key': key },
    opts.fetchImpl, opts.timeoutMs,
  );
  const rows = Array.isArray(body && body.models) ? body.models : null;
  if (rows === null) throw new Error('Gemini returned a body with no `models` array.');
  return rows
    .filter(r => r && typeof r.name === 'string'
      && Array.isArray(r.supportedGenerationMethods)
      && r.supportedGenerationMethods.includes('generateContent'))
    .map(r => ({
      // The API namespaces ids as `models/<id>`; every id this app stores is the
      // bare form, so strip it HERE rather than at each comparison site.
      id: r.name.replace(/^models\//, ''),
      label: typeof r.displayName === 'string' ? r.displayName : null,
      contextLength: Number.isFinite(r.inputTokenLimit) ? r.inputTokenLimit : null,
      created: null,
    }));
}

/**
 * ── THE OPENROUTER ARM ASKS A DIFFERENT QUESTION, DELIBERATELY ──────────────
 *
 * Gemini and Anthropic are hand-typed, so ANY unlisted id is a discovery. The
 * OpenRouter catalogue is synced wholesale, so "published but not offered" is
 * the NORMAL state of ~200 ids that the eligibility filter correctly rejects —
 * reporting those would bury the one case that matters under two hundred that
 * do not.
 *
 * So this arm reports only ids that PASS the eligibility filter and are still
 * not offered. That is a meaningful and narrow signal: it means the synced
 * catalogue is stale, i.e. a model the user could pick today is missing because
 * nobody has pressed Sync. The rejected-and-unoffered population is reported as
 * a COUNT, so the arithmetic on screen adds up without listing it.
 */
export async function fetchOpenRouterDiscoveries(key, opts = {}) {
  // `key` is NOT passed on: OpenRouter's `/models` is a PUBLIC endpoint and the
  // shipped fetcher sends no credential. The parameter is kept so the caller's
  // gate stays uniform across the three providers — the key still decides
  // WHETHER we ask, because a user who has not connected OpenRouter has not
  // asked us to talk to it.
  const records = await fetchOpenRouterCatalogue({
    fetchImpl: opts.fetchImpl || null,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(Number.isFinite(opts.timeoutMs) ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('OpenRouter returned no models.');
  }
  const filter = eligibilityModule && eligibilityModule.filterCatalogue;
  if (typeof filter !== 'function') {
    throw new Error('The OpenRouter eligibility filter is unavailable, so nothing can be classified.');
  }
  // A CLOCK IS SUPPLIED so the expiry rule is live. Without it the rule abstains
  // silently, and this feed would nominate models that are about to be retired.
  const report = filter(records, { now: opts.now || new Date() });
  const known = knownModelIds('openrouter');
  const byId = new Map(records.filter(r => r && typeof r.id === 'string').map(r => [r.id, r]));
  const eligibleUnoffered = report.eligible
    .filter(ev => ev.id && !known.has(ev.id))
    .map(ev => {
      const r = byId.get(ev.id);
      return {
        id: ev.id,
        label: r && typeof r.name === 'string' ? r.name : null,
        contextLength: ev.facts && ev.facts.context ? ev.facts.context.value : null,
        created: null,
      };
    });
  return {
    models: eligibleUnoffered,
    // Published, not offered, and REJECTED by the filter for a stated reason.
    // A number rather than a list: these are not discoveries, and the count only
    // exists so "listed 421, offered 216" does not look like unexplained loss.
    rejectedUnoffered: report.rejected.filter(ev => ev.id && !known.has(ev.id)).length,
    listed: report.total,
  };
}

/** Read the sidecar, or an empty shape. NEVER throws: a corrupt cache must not
 * be able to break a status read, and a fresh fetch will overwrite it. */
function readCache() {
  try {
    const parsed = JSON.parse(readFileSync(discoveryPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
      return parsed;
    }
  } catch { /* absent, unreadable or malformed — all mean "no cache" */ }
  return { version: 1, checkedAt: null, providers: {} };
}

function writeCache(payload) {
  try {
    writeFileAtomicSync(discoveryPath(), JSON.stringify(payload, null, 0), 'utf8');
    return true;
  } catch (err) {
    // stderr, never stdout — this module sits on the graph the MCP child
    // imports, which reserves stdout for JSON-RPC frames.
    console.error(`[model-discovery] could not persist the discovery cache: ${errText(err)}`);
    return false;
  }
}

/**
 * Is the cached answer still good enough?
 *
 * PURE — takes the clock as an argument. An UNDATED cache is treated as STALE,
 * not fresh: an unknown age cannot be asserted to be young, and the cost of
 * being wrong is one free GET.
 */
export function discoveryNeedsRefresh(cache, nowMs) {
  if (!cache || !cache.checkedAt) return { needed: true, reason: 'never checked', ageMs: null };
  const t = Date.parse(cache.checkedAt);
  if (!Number.isFinite(t)) return { needed: true, reason: 'undated cache', ageMs: null };
  const ageMs = nowMs - t;
  if (ageMs < 0) {
    // A cache stamped in the FUTURE (a clock moved back, or a synced file from
    // a machine running ahead). Treated as stale rather than as infinitely
    // fresh, which is the direction that costs one free request instead of
    // never refreshing again.
    return { needed: true, reason: 'stamped in the future', ageMs };
  }
  if (ageMs >= MODEL_DISCOVERY_MAX_AGE_MS) return { needed: true, reason: 'older than 24 hours', ageMs };
  return { needed: false, reason: 'fresh', ageMs };
}

/**
 * The whole check: fetch what each CONNECTED provider lists, subtract everything
 * this app already has a record of, and report the remainder with the date each
 * id was first seen.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]      refresh even if the cache is fresh
 * @param {Function} [opts.fetchImpl] injected for offline tests
 * @param {Date|number} [opts.now]    injected clock
 * @param {object} [opts.keys]        injected keys, for tests
 * @returns {Promise<object>} the same shape whether it fetched or served cache
 */
export async function getNewModels(opts = {}) {
  const nowMs = opts.now instanceof Date ? opts.now.getTime()
    : (Number.isFinite(opts.now) ? opts.now : Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const cache = readCache();
  const freshness = discoveryNeedsRefresh(cache, nowMs);

  if (!freshness.needed && !opts.force) {
    return { ...cache, cached: true, ageMs: freshness.ageMs, maxAgeMs: MODEL_DISCOVERY_MAX_AGE_MS };
  }

  // CONFIG-SCOPED KEYS, never getEffectiveKey/.env — the v3.0.13 rule. A
  // provider the user has Disconnected in Settings must not be polled with a
  // lingering .env key: they told us to stop using it.
  const keys = opts.keys || getApiKeys();
  const gate = {
    gemini: keys.geminiApiKey,
    anthropic: keys.anthropicApiKey,
    openrouter: keys.openrouterApiKey,
  };

  const providers = {};
  for (const provider of ['gemini', 'anthropic', 'openrouter']) {
    const key = gate[provider];
    if (!key) {
      // NOT AN ERROR, and not an empty result either. There is nothing to check.
      providers[provider] = {
        connected: false, checked: false, error: null,
        models: [], listed: null, rejectedUnoffered: null,
      };
      continue;
    }
    const prior = new Map(
      ((cache.providers[provider] && cache.providers[provider].models) || [])
        .filter(m => m && typeof m.id === 'string')
        .map(m => [m.id, m.firstSeen]),
    );
    try {
      let found, listed = null, rejectedUnoffered = null;
      if (provider === 'anthropic') {
        const all = await fetchAnthropicModels(key, opts);
        listed = all.length;
        const known = knownModelIds('anthropic');
        found = all.filter(m => !known.has(m.id));
      } else if (provider === 'gemini') {
        const all = await fetchGeminiModels(key, opts);
        listed = all.length;
        const known = knownModelIds('gemini');
        found = all.filter(m => !known.has(m.id));
      } else {
        const r = await fetchOpenRouterDiscoveries(key, opts);
        found = r.models;
        listed = r.listed;
        rejectedUnoffered = r.rejectedUnoffered;
      }
      providers[provider] = {
        connected: true,
        checked: true,
        error: null,
        listed,
        rejectedUnoffered,
        // STICKY firstSeen — see this file's docblock. An id already in the
        // cache keeps the date it was first observed; only a genuinely new id
        // gets today's.
        models: found.map(m => ({ ...m, firstSeen: prior.get(m.id) || nowIso })),
      };
    } catch (err) {
      // ONE PROVIDER'S FAILURE IS ONE PROVIDER'S FAILURE. `checked: false` with
      // an empty `models` must never be read as "nothing new" — the field pair
      // is what distinguishes the two, and every consumer is required to read
      // both.
      providers[provider] = {
        connected: true, checked: false, error: errText(err),
        models: [], listed: null, rejectedUnoffered: null,
      };
    }
  }

  const payload = { version: 1, checkedAt: nowIso, providers };
  const persisted = writeCache(payload);
  return { ...payload, cached: false, ageMs: 0, maxAgeMs: MODEL_DISCOVERY_MAX_AGE_MS, persisted };
}

/** Test-only: forget the cached answer. Never called in production. */
export function __clearDiscoveryCache() {
  try { writeFileAtomicSync(discoveryPath(), JSON.stringify({ version: 1, checkedAt: null, providers: {} }), 'utf8'); }
  catch { /* best effort */ }
}
