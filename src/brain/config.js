/**
 * Persistent app configuration — stored in .curator-config.json in the user-data
 * directory (see src/brain/paths.js; the project root for a repo install).
 * Priority order for domainsPath:
 *   1. .curator-config.json  (set via UI)
 *   2. DOMAINS_PATH env var  (set in .env)
 *   3. <user-data dir>/domains (default — see src/brain/paths.js)
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { writeFileAtomicSync } from './atomic-write.js';
import { getCuratorConfigFile, getDefaultDomainsDir } from './paths.js';

// v3.1.0+: these resolve through paths.js instead of this file's own location.
// In a repo install getUserDataDir() === APP_ROOT, so both are byte-identical
// to the previous `path.join(PROJECT_ROOT, …)`. In a (future) packaged .app
// they move to ~/Library/Application Support/The Curator, which is writable.
//
// Resolved PER CALL, not snapshotted into a const at module load. A snapshot
// would be taken at import time and would silently defeat paths.js's test seams
// (__setUserDataDirOverride / CURATOR_TEST_USER_DATA_DIR) for any test that
// imports this module before setting them — which would mean the test reading
// and WRITING the developer's real .curator-config.json.
const configFile = () => getCuratorConfigFile();

function readRaw() {
  const f = configFile();
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); }
  catch { return {}; }
}

// v3.0.1-beta.8: atomic write so a kill-mid-write of .curator-config.json
// cannot wipe the user's API keys / domainsPath. Sync variant required —
// callers in this module don't await.
// v3.0.1-beta.20: 0600 — this file holds the Gemini/Anthropic API keys, so it
// must not be readable by other local users.
function writeRaw(data) {
  writeFileAtomicSync(configFile(), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// Test-only override. Production code NEVER sets this — it stays null, so
// getDomainsDir's real precedence (config → env → default) is unchanged.
// Battle tests use it to point the domains dir at a throwaway tempdir WITHOUT
// mutating the user's real .curator-config.json. The env-var path can't serve
// this role because a real install almost always has `domainsPath` in config,
// which (correctly) wins over the env var.
let _domainsDirOverride = null;

/** Test seam — see _domainsDirOverride. Pass null to clear. */
export function __setDomainsDirOverride(p) {
  _domainsDirOverride = p || null;
}

/** Returns the resolved, absolute path to the domains folder. */
export function getDomainsDir() {
  // In-process test override (set by __setDomainsDirOverride).
  if (_domainsDirOverride) return path.resolve(_domainsDirOverride);
  // Cross-process test override (env). Unlike DOMAINS_PATH, this BEATS config —
  // it exists so battle tests (including ones that spawn a child server, e.g.
  // test-sharedbrain-routes) can point the domains dir at a throwaway tempdir
  // even on a machine whose .curator-config.json sets domainsPath. Test-only;
  // never set in production. The legacy DOMAINS_PATH (below, loses to config)
  // remains for the documented developer fallback.
  if (process.env.CURATOR_TEST_DOMAINS_DIR) return path.resolve(process.env.CURATOR_TEST_DOMAINS_DIR);
  const cfg = readRaw();
  if (cfg.domainsPath) return path.resolve(cfg.domainsPath);
  if (process.env.DOMAINS_PATH) return path.resolve(process.env.DOMAINS_PATH);
  return getDefaultDomainsDir();
}

/** Persists a new domains path to .curator-config.json. */
export function setDomainsDir(newPath) {
  const cfg = readRaw();
  cfg.domainsPath = path.resolve(newPath);
  writeRaw(cfg);
}

/** Returns config object for the UI. */
export function getConfig() {
  const cfg = readRaw();
  const source = cfg.domainsPath ? 'ui'
               : process.env.DOMAINS_PATH ? 'env'
               : 'default';
  return {
    domainsPath: getDomainsDir(),
    domainsPathSource: source,
  };
}

// ── API Keys ────────────────────────────────────────────────────────────────

/**
 * The providers this app can hold a credential for, in the ONE order that
 * governs every "which provider do we fall back to" question in this file:
 * `getActiveProvider`'s legacy ladder and `clearApiKey`'s reassignment.
 *
 * v3.15.0 (OpenRouter): `openrouter` is APPENDED, never inserted. Both readers
 * scan this list in order and stop at the first provider that holds a key, so
 * appending is provably behaviour-preserving for every config written before
 * this release: such a config has no `openrouterApiKey` field at all, so the
 * third rung is unreachable and resolution is byte-identical to v3.14.0. An
 * INSERT would have retroactively re-resolved existing users onto a provider
 * they never chose — which changes what every subsequent ingest costs, the
 * exact class v3.14.0 shipped a whole feature to make visible.
 *
 * Frozen, and every lookup keyed on it goes through `providerFields()` below,
 * which gates on `Array.prototype.includes` (a `===` scan) BEFORE the string
 * indexes anything — so `'__proto__'`, `'constructor'` and `'toString'` are
 * structurally unable to resolve to a field name (the v3.0.9 shape, closed by
 * construction rather than by remembering to call Object.hasOwn).
 */
const PROVIDER_ORDER = Object.freeze(['gemini', 'anthropic', 'openrouter']);

/**
 * Per-provider credential locations: the `.curator-config.json` field, and the
 * `.env` variable that acts as the documented DEVELOPER fallback.
 */
const PROVIDER_KEY_FIELDS = Object.freeze({
  gemini:     Object.freeze({ config: 'geminiApiKey',     env: 'GEMINI_API_KEY' }),
  anthropic:  Object.freeze({ config: 'anthropicApiKey',  env: 'ANTHROPIC_API_KEY' }),
  openrouter: Object.freeze({ config: 'openrouterApiKey', env: 'OPENROUTER_API_KEY' }),
});

/** Field names for a provider, or null if it is not a provider we know. */
function providerFields(provider) {
  if (!PROVIDER_ORDER.includes(provider)) return null;
  return PROVIDER_KEY_FIELDS[provider];
}

/** Read API keys from .curator-config.json (not .env). */
export function getApiKeys() {
  const cfg = readRaw();
  return {
    geminiApiKey:     cfg.geminiApiKey     || '',
    anthropicApiKey:  cfg.anthropicApiKey  || '',
    openrouterApiKey: cfg.openrouterApiKey || '',
  };
}

/**
 * Save API keys to .curator-config.json. Partial update — only overwrites provided keys.
 *
 * Saving a non-empty key for a provider ALSO sets it as the active provider.
 * This implements "last-saved-wins": users don't juggle priorities, they just
 * paste the key they want to use. If both fields are submitted in one save,
 * whichever non-empty key is encountered last takes the active slot (the
 * current frontend sends {geminiApiKey, anthropicApiKey, openrouterApiKey} in
 * that order, so the last non-empty one in that order wins a multi-save —
 * deterministic, rare edge case).
 *
 * ── `opts.canActivate` IS REQUIRED FOR ACTIVATION, AND ITS ABSENCE MEANS NO ──
 * A provider may become active ONLY if `opts.canActivate(provider)` returns
 * true. It is INJECTED rather than computed here because the answer lives in
 * llm.js (which model resolves, and whether that model may serve the build
 * lane) and llm.js imports THIS file — so importing it back would form a cycle.
 * That is not a stylistic preference: the invariant is asserted offline
 * ("config.js does not import llm.js — no import cycle") and its comment states
 * the architecture directly, that validation belongs where the catalogue lives.
 * `src/routes/config.js` already namespace-imports llm.js and passes the real
 * predicate on every call.
 *
 * WITH NO PREDICATE, THIS FUNCTION ACTIVATES NOTHING — and note the exact
 * claim, because a looser one was written here and was FALSE. It used to read
 * "WITH NO PREDICATE, NOTHING IS ACTIVATED", which is a statement about
 * `getActiveProvider()`, and measured on an empty config `setApiKeys({geminiApiKey})`
 * with no opts at all returned `activeProvider: 'gemini'` while ALSO reporting
 * gemini in `skippedActivation` — because refusing meant leaving the field
 * absent, and an absent field is precisely what the legacy ladder infers from.
 * What this function guarantees is that it will not ASSIGN; the resolved answer
 * is now held still by the explicit pin at the end of the loop.
 *
 * That is fail-safe, and the two failure directions are wildly unequal:
 *   • Skipping an activation that should have happened -> the key saves but
 *     does not become active. Mildly annoying, VISIBLE, and undone by one click
 *     on the existing Set-active control.
 *   • Activating a provider that cannot build -> ingest, Health and Compile all
 *     throw on the next call with NOTHING on screen saying so, because the
 *     route swallows getProviderInfo()'s throw in a catch commented "no key
 *     configured yet" — while a key IS configured. That is the v3.15.0 P0 this
 *     contract exists to prevent, reproduced before it was fixed: a user with a
 *     WORKING Gemini install who merely SAVED an OpenRouter key lost the entire
 *     build lane.
 * Defaulting to "activate" would make that P0 the default behaviour, which is
 * exactly backwards. A caller that forgets the predicate gets the annoying
 * outcome, never the broken one.
 *
 * A predicate that THROWS is treated as a refusal, for the same reason.
 *
 * Returns { activeProvider, skippedActivation } where skippedActivation is a
 * (usually empty) array of { provider, reason } — keys that were SAVED but did
 * not become active. The save still succeeded; this is the signal the UI needs
 * to explain why the Active row did not move.
 */
export function setApiKeys({ geminiApiKey, anthropicApiKey, openrouterApiKey }, opts = {}) {
  const cfg = readRaw();
  const skippedActivation = [];
  // NO PREDICATE MEANS NO ACTIVATION — see the docblock above.
  const canActivate = typeof opts.canActivate === 'function' ? opts.canActivate : null;
  // Snapshotted BEFORE anything is written, because "the refusal must not move
  // the build lane" is a statement about the lane as it stood when the user
  // clicked Save. See the pin below.
  const activeBefore = getActiveProvider();

  // Ordered so "last non-empty key wins" is decided by this list, not by the
  // order the caller happened to put fields in the body.
  const saves = [
    ['gemini',     'geminiApiKey',     geminiApiKey],
    ['anthropic',  'anthropicApiKey',  anthropicApiKey],
    ['openrouter', 'openrouterApiKey', openrouterApiKey],
  ];

  for (const [provider, field, value] of saves) {
    if (value === undefined) continue;
    cfg[field] = value;                      // the key is ALWAYS saved
    if (!value) continue;                    // clearing never activates
    let allowed = false;
    try { allowed = !!(canActivate && canActivate(provider)); } catch { allowed = false; }
    if (allowed) {
      cfg.activeProvider = provider;         // last-saved-wins, unchanged
    } else {
      skippedActivation.push({ provider, reason: 'no_build_model' });
    }
  }

  // ── A REFUSAL MUST BE OBSERVABLE, NOT MERELY UN-WRITTEN ───────────────────
  // Refusing used to mean "do not assign `cfg.activeProvider`" — and an ABSENT
  // field is exactly what `getActiveProvider`'s legacy ladder reads as "infer
  // from whichever key exists". So the key we had just saved supplied the very
  // inference the refusal was meant to prevent. MEASURED on an empty config:
  //
  //   setApiKeys({openrouterApiKey}, {canActivate: () => false})
  //     -> returned   { activeProvider: 'openrouter', skippedActivation: [...] }
  //     -> on disk    activeProvider: undefined
  //     -> resolved   getActiveProvider() === 'openrouter'
  //
  // i.e. a payload that contradicted itself, and a no-op guard, on every fresh
  // install (any config holding no earlier-ranked provider key). Unexercised
  // only because all three shipped providers currently pass `providerCanBuild`
  // — `local` is scaffolded to hit it for real, and the frontend already renders
  // copy asserting the refusal happened.
  //
  // Omission cannot carry two meanings, so the sentinel does: an activeProvider
  // field that is PRESENT AND `null` means "we decided, and the answer is
  // nobody". An ABSENT field still means "written before this field existed" and
  // still runs the ladder, so a pre-v3.15.0 config resolves byte-identically —
  // that back-compat is load-bearing and separately asserted. A field holding
  // GARBAGE (hand-edited) also still falls through to the ladder, unchanged:
  // degrading a corrupt config to inference is deliberate, and only the exact
  // `null` we write here is read as a decision.
  //
  // The pin is `activeBefore`, not a blanket null: the promise is "this save did
  // not MOVE the lane", so a user who already had a working provider keeps it.
  // Only when the pre-save answer was genuinely nobody do we record nobody. And
  // it is applied ONLY when nothing was activated in this call and no explicit
  // pin already exists — so a successful activation, and an existing pinned
  // choice, both win over it.
  if (skippedActivation.length > 0 && !PROVIDER_ORDER.includes(cfg.activeProvider)) {
    cfg.activeProvider = activeBefore;
  }

  writeRaw(cfg);
  return { activeProvider: getActiveProvider(), skippedActivation };
}



/**
 * Clear a specific provider's stored key. Used by the Settings "Disconnect"
 * button so users can wipe a key without having to add a new one.
 *
 * If the cleared key was the ACTIVE provider, active moves to the first
 * remaining provider (in PROVIDER_ORDER) that still holds a SAVED key, or is
 * deleted entirely when none does.
 *
 * ── Why this is a scan and not a ternary (v3.15.0) ──────────────────────────
 * Until OpenRouter there were exactly two providers, so this encoded a PAIRWISE
 * fallback — "if the cleared one was active, activate the other one". With
 * three providers there is no "the other one", and a naive third arm would make
 * the destination depend on which branch happened to be written first. The
 * reassignment is a SPENDING decision (it decides which provider every
 * subsequent ingest, Health scan and Compile is billed to), so it must be
 * deterministic and stated, not emergent.
 *
 * The order is PROVIDER_ORDER — deliberately the SAME list `getActiveProvider`
 * walks, so "which provider do we fall back to" has ONE definition in this file
 * rather than two that can drift apart. Behaviour for a config holding only the
 * two legacy providers is byte-identical to v3.14.0: clearing gemini picks
 * anthropic iff it has a key; clearing anthropic picks gemini iff it has a key;
 * otherwise the field is deleted.
 *
 * CONFIG keys only — `.env` is deliberately NOT consulted here, exactly as
 * before. Disconnect is a Settings action about Settings state; letting a
 * lingering `.env` key silently hold a provider active after the user
 * disconnected it is the v3.0.13 bug.
 *
 * ── `opts.canActivate` HERE IS OPTIONAL, AND ABSENT MEANS ALLOW ─────────────
 * This is the THIRD of the three functions in this file that can move the build
 * lane, and it had no build-lane check at all: disconnecting the active provider
 * handed the lane to the next provider holding a key, whether or not that
 * provider has a model that can build a wiki. MEASURED — a config holding a
 * Gemini key and an OpenRouter key, active gemini, `clearApiKey('gemini')`
 * resolved to **openrouter**, and there was no parameter through which a caller
 * could have said no.
 *
 * The default is ALLOW, matching `setActiveProvider` and NOT `setApiKeys`,
 * because here the two failure directions are inverted. Refusing by default
 * would mean a bare `clearApiKey('gemini')` on a config holding a working
 * Anthropic key hands the lane to NOBODY — a user who disconnected one of two
 * good providers silently loses ingest, Health and Compile. That is the same P0
 * `setApiKeys`' refuse-by-default exists to prevent, arriving from the other
 * side. Preserving today's behaviour for a caller that passes nothing is
 * therefore the fail-safe choice, and the real guarantee is the caller supplying
 * the predicate.
 *
 * ⚠ NOT YET SUPPLIED BY THE ROUTE. `src/routes/config.js` (a different owner)
 * still calls this with one argument, so the check is inert on the shipping
 * path today. It is a one-argument change there — that file already namespace-
 * imports llm.js and already builds `providerCanBuild` for `setApiKeys`.
 */
export function clearApiKey(provider, opts = {}) {
  const fields = providerFields(provider);
  if (!fields) return;
  // ABSENT MEANS ALLOW — see this function's docblock for why it is NOT
  // setApiKeys' default.
  const canActivate = typeof opts.canActivate === 'function' ? opts.canActivate : null;
  const cfg = readRaw();
  cfg[fields.config] = '';
  if (cfg.activeProvider === provider) {
    const candidates = PROVIDER_ORDER.filter(
      p => p !== provider && !!cfg[PROVIDER_KEY_FIELDS[p].config]
    );
    let next = candidates[0] ?? null;
    let refusedAll = false;
    if (canActivate && candidates.length > 0) {
      next = candidates.find(p => { try { return !!canActivate(p); } catch { return false; } }) ?? null;
      refusedAll = next === null;
    }
    if (next) cfg.activeProvider = next;
    // Candidates existed and every one of them was refused: record the DECISION
    // (`null`), not the absence. Deleting the field here would hand the question
    // straight back to the legacy ladder, which would re-pick the first keyed
    // provider — the same no-op-refusal shape `setApiKeys` had.
    else if (refusedAll) cfg.activeProvider = null;
    // No candidate at all — nothing was refused, there was simply nobody to
    // consider. The field is REMOVED, unchanged from before, so the documented
    // `.env` developer fallback in `getActiveProvider` still applies.
    else delete cfg.activeProvider;
  }
  writeRaw(cfg);
}

/**
 * Explicitly set the active provider WITHOUT re-saving its key. Powers the
 * Settings provider toggle: a user holding both a Gemini and an Anthropic key
 * can flip which one is live with one click, instead of re-pasting a key
 * (which the "last-saved-wins" path in setApiKeys requires) or disconnecting
 * the other (which deletes a key).
 *
 * Refuses to activate a provider that has no stored key — switching to a
 * provider with no key would break every subsequent LLM call. Returns the
 * resulting active provider (unchanged if the switch was refused).
 *
 * ── `opts.canActivate` here is OPTIONAL, and ABSENT MEANS ALLOW ─────────────
 * Deliberately the OPPOSITE default to setApiKeys, and the asymmetry is stated
 * rather than left to be discovered:
 *   • setApiKeys activation is IMPLICIT — a side effect of saving a key. A user
 *     who never asked for it cannot miss it not happening, so refusing by
 *     default costs nothing.
 *   • This function is EXPLICIT — the user clicked "use this provider". Making
 *     it a silent no-op because a caller forgot an argument is not fail-safe,
 *     it is fail-broken: the click appears to do nothing and the user cannot
 *     tell why. Three existing callers (the live chat suites, which force a
 *     provider they hold a real key for) are legitimate and would break.
 *
 * SAY IT PLAINLY: WITH NO PREDICATE THERE IS NO BUILD-LANE BACKSTOP HERE. The
 * key-existence check above is all this function enforces on its own. The real
 * guarantee for the user-facing path is POST /api/config/api-keys/active, which
 * evaluates providerCanBuild and returns an actionable 400 BEFORE calling this.
 * Do not read the presence of `opts` as protection that is always on.
 */
export function setActiveProvider(provider, opts = {}) {
  const fields = providerFields(provider);
  if (!fields) return getActiveProvider();
  const cfg = readRaw();
  const hasKey = !!(cfg[fields.config] || process.env[fields.env]);
  if (!hasKey) return getActiveProvider();
  // Build-lane check, when the caller supplies one. ABSENT MEANS ALLOW here,
  // the opposite of setApiKeys — see this function's docblock for why.
  if (typeof opts.canActivate === 'function') {
    let allowed = false;
    try { allowed = !!opts.canActivate(provider); } catch { allowed = false; }
    if (!allowed) return getActiveProvider();
  }
  cfg.activeProvider = provider;
  writeRaw(cfg);
  return provider;
}

/**
 * Returns the provider the user most recently activated via the Settings UI.
 * For legacy configs (pre-v2.4.2) that don't have an activeProvider field,
 * falls back to the previous "Gemini-first if both are set" behaviour so
 * existing installations keep working without any action.
 *
 * ── The legacy ladder is APPEND-ONLY (v3.15.0) ──────────────────────────────
 * This ladder RE-RESOLVES configs that were written before the field existed,
 * so its order is not a style choice — it decides, retroactively, which
 * provider an existing user is billed to. `openrouter` therefore sits LAST in
 * PROVIDER_ORDER and is reached only after both legacy providers have failed,
 * i.e. only in cases that returned `null` before. A pre-v3.15.0 config cannot
 * contain `openrouterApiKey` at all, so every such config resolves BYTE-
 * IDENTICALLY to v3.14.0. Inserting anywhere earlier would silently move real
 * users onto a different provider — and therefore a different bill — with no
 * on-screen signal, which is exactly what v3.14.0's build-lane labelling exists
 * to prevent.
 *
 * Config beats env for the whole ladder (config rung, then env rung), matching
 * the pre-v3.15.0 sequencing.
 */
export function getActiveProvider() {
  const cfg = readRaw();
  if (PROVIDER_ORDER.includes(cfg.activeProvider)) {
    return cfg.activeProvider;
  }
  // ── "NEVER SET" AND "DELIBERATELY NOT SET" ARE DIFFERENT FACTS ────────────
  // An ABSENT field means the config predates the field (or `clearApiKey`
  // removed it because there was no candidate at all) — infer, exactly as
  // before. An EXPLICIT `null` is a DECISION recorded by `setApiKeys` /
  // `clearApiKey`: candidates existed and were refused because none of them can
  // build the wiki. Inferring there would re-derive the very answer that was
  // just refused, which is what made the refusal a no-op.
  //
  // `=== null` and nothing looser. `undefined` (absent) does not match it, and
  // neither does a garbage string from a hand-edited file — that keeps falling
  // through to the ladder, so "a corrupt config degrades to the defaults" is
  // unchanged. JSON round-trips `null` faithfully and cannot store `undefined`,
  // so the two states stay distinguishable on disk.
  if (cfg.activeProvider === null) return null;
  // Legacy priority: whichever key exists, in PROVIDER_ORDER, config before env.
  for (const p of PROVIDER_ORDER) {
    if (cfg[PROVIDER_KEY_FIELDS[p].config]) return p;
  }
  for (const p of PROVIDER_ORDER) {
    if (process.env[PROVIDER_KEY_FIELDS[p].env]) return p;
  }
  return null;
}

// ── Selected model per provider ──────────────────────────────────────────────

/**
 * The providers a model may be stored for. Every read and write below is gated
 * on membership BEFORE the string is ever used to index anything, so
 * `'__proto__'`, `'constructor'` and `'toString'` cannot reach an object lookup
 * (the v3.0.9 shape, closed by construction rather than by remembering to call
 * Object.hasOwn).
 *
 * DELIBERATELY the same frozen list as the credential providers, not a second
 * copy of it: a provider you can hold a key for is exactly a provider you can
 * pin a model for, and two hand-maintained copies of that membership in one
 * file is this repo's v3.2.0 drift shape. Only membership is load-bearing here
 * — the ORDER matters to `getActiveProvider`/`clearApiKey`, while these three
 * consumers use it purely as a set (plus JSON key insertion order in the
 * stored `selectedModels` map, which is cosmetic).
 */
const MODEL_PROVIDERS = PROVIDER_ORDER;

/**
 * Sanitise whatever `.curator-config.json` holds under `selectedModels` into a
 * fresh NULL-PROTOTYPE map carrying only non-empty strings under the two known
 * provider keys.
 *
 * This file is user-editable and hand-editing it is a documented recovery path,
 * so every degenerate shape has to degrade to "nothing stored" rather than
 * throw: a string, `null`, an array, a nested object, a number, a boolean, or a
 * `__proto__` entry that JSON.parse materialises as an OWN data property. A
 * throw here would take the server down at the first LLM call — this value is
 * consulted by ingest, Health, compile and chat alike.
 *
 * The result is Object.create(null) so that even a caller who somehow reached
 * this with an unvalidated key cannot pull `toString`/`constructor` off
 * Object.prototype.
 *
 * ONE implementation, shared by the getter and the setter — a second
 * hand-maintained sanitiser is the v3.2.0 CRITICAL shape.
 */
function sanitizeSelectedModels(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const p of MODEL_PROVIDERS) {
    if (!Object.prototype.hasOwnProperty.call(raw, p)) continue;
    const v = raw[p];
    if (typeof v === 'string' && v) out[p] = v;
  }
  return out;
}

/**
 * The model id this user picked for `provider` in Settings, or null.
 *
 * NOT validated against OFFERABLE_MODELS here, deliberately — config.js is the
 * storage layer and llm.js imports IT, so importing llm.js back would be a
 * cycle. The allow-list is applied on the READ side in llm.js, which is where
 * it has to be anyway: a stored id can stop being offerable AFTER it was
 * validly written (we pull a model after a bad live probe), so validating only
 * at write time would leave the stale value honoured forever.
 *
 * Read FRESH per call. A module-level snapshot would be taken at import time
 * and would mean a Settings change could not take effect until restart — and,
 * worse, would defeat the paths.js test seams for anything importing this
 * module early (see §7 of test-paths.js).
 */
export function getSelectedModel(provider) {
  if (!MODEL_PROVIDERS.includes(provider)) return null;
  return sanitizeSelectedModels(readRaw().selectedModels)[provider] || null;
}

/**
 * Persist the user's model choice for one provider. Pass an empty string or
 * null to CLEAR it (back to the provider default).
 *
 * Writes through writeRaw → writeFileAtomicSync with mode 0600, the same single
 * writer every other field in this file uses — this file holds the API keys, so
 * a second writer that forgot the mode would silently widen them.
 *
 * Rebuilds the stored map from the SANITISED view rather than mutating what was
 * on disk, so a hand-edited `__proto__` / array / junk entry is dropped on the
 * next write instead of being carried forward. Deletes the key entirely when
 * nothing is selected, so a user who never picks a model keeps a config file
 * byte-identical to today's.
 *
 * Returns the stored id (or null) so a caller can echo back what actually took.
 */
export function setSelectedModel(provider, modelId) {
  if (!MODEL_PROVIDERS.includes(provider)) return null;
  const cfg = readRaw();
  const clean = sanitizeSelectedModels(cfg.selectedModels);
  const next = {};
  for (const p of MODEL_PROVIDERS) if (clean[p]) next[p] = clean[p];
  if (typeof modelId === 'string' && modelId) next[provider] = modelId;
  else delete next[provider];
  if (Object.keys(next).length) cfg.selectedModels = next;
  else delete cfg.selectedModels;
  writeRaw(cfg);
  return next[provider] || null;
}

// ── AI Health settings (v2.4.5+) ─────────────────────────────────────────────

const DEFAULT_AI_HEALTH = {
  costCeilingTokens:    50_000, // hard-stops semantic-dupe scan before LLM calls
  semanticDupeMaxPairs: 500,    // candidate-pair cap out of the pre-filter
};

/**
 * Returns the persisted AI Health settings, falling back to defaults for
 * missing fields so new installs pick up sensible values without needing
 * a config migration.
 */
export function getAiHealthSettings() {
  const cfg = readRaw();
  const stored = cfg.aiHealth || {};
  return {
    costCeilingTokens:    Number.isInteger(stored.costCeilingTokens) && stored.costCeilingTokens > 0
                          ? stored.costCeilingTokens : DEFAULT_AI_HEALTH.costCeilingTokens,
    semanticDupeMaxPairs: Number.isInteger(stored.semanticDupeMaxPairs) && stored.semanticDupeMaxPairs > 0
                          ? stored.semanticDupeMaxPairs : DEFAULT_AI_HEALTH.semanticDupeMaxPairs,
  };
}

/**
 * Partial update — pass only the fields you want to change. Non-numeric or
 * non-positive values are ignored (UI enforces sane ranges; this is the
 * last line of defence).
 */
export function setAiHealthSettings({ costCeilingTokens, semanticDupeMaxPairs } = {}) {
  const cfg = readRaw();
  const next = { ...(cfg.aiHealth || {}) };
  if (Number.isFinite(costCeilingTokens) && costCeilingTokens > 0) {
    next.costCeilingTokens = Math.round(costCeilingTokens);
  }
  if (Number.isFinite(semanticDupeMaxPairs) && semanticDupeMaxPairs > 0) {
    next.semanticDupeMaxPairs = Math.round(semanticDupeMaxPairs);
  }
  cfg.aiHealth = next;
  writeRaw(cfg);
  return getAiHealthSettings();
}

// ── Default domain (v2.5.2+) ─────────────────────────────────────────────────
// Used by the MCP write tools when the user says "my wiki" without naming a
// domain. If unset, MCP tools must require an explicit domain argument and
// can use list_domains to enumerate.

/** Returns the user's preferred default domain slug, or null if unset. */
export function getDefaultDomain() {
  const cfg = readRaw();
  const v = cfg.defaultDomain;
  return typeof v === 'string' && v ? v : null;
}

/** Sets or clears the default domain. Pass null/empty to unset. */
export function setDefaultDomain(slug) {
  const cfg = readRaw();
  if (slug && typeof slug === 'string') {
    cfg.defaultDomain = slug;
  } else {
    delete cfg.defaultDomain;
  }
  writeRaw(cfg);
  return getDefaultDomain();
}

// ── Shared Brain feature flag (v3.0.0+) ─────────────────────────────────────
// When false (default), Shared Brain routes return 404 and the UI hides the
// section. Circuit-breaker: if a Shared Brain bug ships, a hotfix can flip
// the flag globally without rolling back any code. See docs/shared-brain-design.md.

/** Returns true if the Shared Brain feature is enabled for this install. */
export function getSharedBrainEnabled() {
  const cfg = readRaw();
  return cfg.sharedBrainEnabled === true;
}

/** Enables or disables the Shared Brain feature. */
export function setSharedBrainEnabled(enabled) {
  const cfg = readRaw();
  cfg.sharedBrainEnabled = !!enabled;
  writeRaw(cfg);
  return getSharedBrainEnabled();
}

/**
 * Returns the effective API key for a provider.
 * Priority: .curator-config.json → process.env → null
 *
 * ── Why OpenRouter DOES get an `OPENROUTER_API_KEY` env fallback (v3.15.0) ───
 * The alternative considered was a config-only third branch, on the reasoning
 * that `.env` is what made a Disconnected provider still callable in v3.0.13.
 * It was rejected: that bug was in the SELECTORS, not here. The fix v3.0.13
 * shipped was to gate the chat provider picker, `hasXKey`, `selectedModels` and
 * `offerable` on `getApiKeys()` (config only) while leaving `getEffectiveKey`
 * as the uniform config→env→null resolver for the GLOBAL provider — which is
 * still exactly how it is used, and those selectors remain config-scoped for
 * OpenRouter too (see routes/config.js `GET /api-keys`).
 *
 * Given that, an asymmetric third branch would buy no safety and cost a trap:
 * the next reader would take the docblock above at face value for all three
 * providers and be wrong about one of them. A uniform resolver keeps the
 * documented developer fallback working for OpenRouter exactly as it does for
 * the other two, and `.env` still cannot make a Disconnected provider appear in
 * any picker, because no picker reads this function.
 *
 * Note the deliberate asymmetry that DOES exist and is documented at its own
 * site: `getActiveProvider`'s legacy env rung puts OpenRouter LAST, so an
 * `OPENROUTER_API_KEY` in a developer's `.env` can never out-rank an existing
 * user's stored Gemini/Anthropic credential.
 */
export function getEffectiveKey(provider) {
  const keys = getApiKeys();
  if (provider === 'gemini') {
    return keys.geminiApiKey || process.env.GEMINI_API_KEY || null;
  }
  if (provider === 'anthropic') {
    return keys.anthropicApiKey || process.env.ANTHROPIC_API_KEY || null;
  }
  if (provider === 'openrouter') {
    return keys.openrouterApiKey || process.env.OPENROUTER_API_KEY || null;
  }
  return null;
}
