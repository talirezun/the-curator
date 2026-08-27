import { Router } from 'express';
import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getConfig, setDomainsDir, getApiKeys, setApiKeys, clearApiKey, setActiveProvider, getDefaultDomain, setDefaultDomain, getSelectedModel, setSelectedModel, getEffectiveKey } from '../brain/config.js';
import { listDomains } from '../brain/files.js';
import { getProviderInfo, getFallbackStatus, getDefaultModel } from '../brain/llm.js';
// Namespace import (NOT a named `{ OFFERABLE_MODELS }` import) is deliberate:
// this route is being written concurrently with the llm.js change that adds
// OFFERABLE_MODELS, so at any given moment the named export may not exist yet.
// A static `import { OFFERABLE_MODELS } from ...` would throw a SyntaxError
// ("does not provide an export named 'OFFERABLE_MODELS'") at module-load time
// and take down every route in this file. `llmModule.OFFERABLE_MODELS` is
// simply `undefined` until the export lands — resolveOfferableModels() below
// already treats a missing/non-object table as "no offerable models" rather
// than throwing.
import * as llmModule from '../brain/llm.js';
import {
  hasActiveWrites,
  conflictResponse,
  beginUpdate,
  endUpdate,
} from '../brain/write-registry.js';
import { APP_ROOT } from '../brain/paths.js';

const execAsync = promisify(exec);
// The CODE root — package.json + the git checkout the auto-updater operates on.
// Never user data (see src/brain/paths.js).
const PROJECT_ROOT = APP_ROOT;

/**
 * When The Curator is launched via the .app wrapper, AppleScript's `do shell script`
 * starts the node process with a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`).
 * That finds `git` (Xcode CLT at `/usr/bin/git`) but NOT `npm`, which lives next
 * to the node binary in `/usr/local/bin` or `/opt/homebrew/bin`. Every subprocess
 * the updater spawns inherits this bare PATH, so `npm install` fails with
 * "npm: command not found". We prepend the node binary's directory plus the
 * common Homebrew / system prefixes so the child shells can resolve everything.
 */
const NODE_BIN_DIR = path.dirname(process.execPath);
const SUBPROCESS_PATH = [
  NODE_BIN_DIR,
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  process.env.PATH || '',
].filter(Boolean).join(':');
const SUBPROCESS_ENV = { ...process.env, PATH: SUBPROCESS_PATH };

/**
 * Classify an `npm install` failure into one of a handful of well-known
 * remediation buckets. Returns `{ kind, actionable }` where `actionable`
 * is a user-facing plain-English message with a concrete next step, or
 * `null` when the error doesn't match any known pattern (caller should
 * surface the raw npm output in that case).
 *
 * Exported for unit testing (v3.0.1-beta.10). The classifier itself is
 * a pure function over a string + two SHA strings — no FS, no network,
 * deterministic — so it can be exercised from a stand-alone test
 * script with synthetic npm error strings.
 *
 * Kept narrow on purpose: we only enrich messages we recognise. Unknown
 * errors fall through with `actionable: null` so the user sees the real
 * npm output rather than a wrong-but-confident remediation.
 */
export function classifyNpmError(rawMessage, beforeSha = '', afterSha = '') {
  const msg = (rawMessage || '').toLowerCase();
  if (!msg) return { kind: 'unknown', actionable: null };

  // PATH issue is handled separately by the caller (returns a different
  // shape — partial success rather than failure). Surface it for
  // completeness so test coverage stays explicit.
  if (msg.includes('npm: command not found') || msg.includes('npm: not found')) {
    return { kind: 'path', actionable: null };
  }

  const shaSpan = beforeSha && afterSha ? `${beforeSha} → ${afterSha} ` : '';

  // Corrupted npm cache — partial file in ~/.npm/_cacache blocks the
  // rename(2) of the freshly-downloaded tarball. Diagnosed via Cowork
  // troubleshooting on a user's machine that had been force-quit during
  // a previous install. The canonical recovery is `npm cache clean --force`.
  if (msg.includes('eacces') ||
      msg.includes('errno -13') ||
      msg.includes('permission denied') ||
      (msg.includes('rename') && msg.includes('file exists'))) {
    return {
      kind: 'cache-corrupted',
      actionable:
        `Your npm cache appears to be corrupted (EACCES / permission denied during a rename). ` +
        `This is usually the result of a previous install being interrupted. To recover: ` +
        `open Terminal and run ` +
        '`npm cache clean --force`' +
        ` then click Check for Updates again. ` +
        `Files were ${shaSpan ? 'updated to ' + shaSpan : 'updated '}but dependencies didn't install — ` +
        `your existing app keeps working, only the dependency install was blocked.`,
    };
  }

  // Disk-out-of-space.
  if (msg.includes('enospc') || msg.includes('no space left')) {
    return {
      kind: 'disk-full',
      actionable:
        `Disk is full (ENOSPC) — npm couldn't write to disk. Free some space ` +
        `(at least 500 MB to be safe) and click Check for Updates again. ` +
        `Files were ${shaSpan ? 'updated to ' + shaSpan : 'updated '}but dependencies didn't install.`,
    };
  }

  // Network-related — registry timeouts, dropped connections, DNS.
  if (msg.includes('etimedout') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('enotfound') ||
      msg.includes('network')) {
    return {
      kind: 'network',
      actionable:
        `Network error while downloading dependencies (timeout / connection reset / DNS). ` +
        `Check your connection and click Check for Updates again. ` +
        `Files were ${shaSpan ? 'updated to ' + shaSpan : 'updated '}but dependencies didn't install.`,
    };
  }

  // Lockfile in a bad state — happens when a previous npm install was
  // interrupted between the package.json write and the package-lock.json
  // regeneration. Auto-recovers on retry once user clears node_modules.
  if (msg.includes('eintegrity') || msg.includes('lockfile')) {
    return {
      kind: 'lockfile',
      actionable:
        `npm lockfile is in a bad state. To recover: open Terminal, run ` +
        '`rm -rf node_modules package-lock.json && npm install`' +
        ` and then relaunch The Curator. ` +
        `Files were ${shaSpan ? 'updated to ' + shaSpan : 'updated '}but dependencies didn't reinstall.`,
    };
  }

  return { kind: 'unknown', actionable: null };
}

const router = Router();

/**
 * Refuse a config mutation while any wiki write is in flight.
 *
 * ── Why these routes need it ─────────────────────────────────────────────
 *
 * Two config values are read FRESH on every use, by deliberate design, so a
 * mutation lands instantly on an operation that is already half-finished:
 *
 *   • `getDomainsDir()` re-reads .curator-config.json on EVERY call (the
 *     v3.1.0 per-call-resolution invariant, enforced by a source guard), and
 *     `wikiPath()`/`rawPath()` in files.js call it once per page write. Change
 *     the folder mid-ingest and the REMAINING pages of that document are
 *     written under the new root — one source's pages split across two
 *     locations, with an index and log that each describe only half of it.
 *     Nothing is deleted, but recovery is manual and the cause is invisible.
 *
 *   • `getProviderInfo()` runs per LLM call inside `callProvider`, so changing
 *     or clearing the active key mid-run either fails the ingest partway
 *     through or silently finishes it on a DIFFERENT model. Note this includes
 *     plain saves: v3.0.2's last-saved-wins means saving a key also switches
 *     the active provider.
 *
 * A multi-phase ingest takes minutes, and the shipping frontend's busy gate
 * disables only Update / the four sync buttons / delete-domain — the folder
 * picker and the key controls are NOT in that list, so a user wandering into
 * Settings mid-ingest reaches all of this. The 409 is the canonical safety
 * net, exactly as it is for `POST /update` below.
 *
 * Deliberately NOT guarded: `POST /default-domain`. It only selects which
 * domain MCP write tools assume when the user doesn't name one; an in-flight
 * ingest already has an explicit domain, so changing it cannot affect a write
 * that is already running.
 *
 * Predicate is process-wide (`hasActiveWrites`) rather than per-domain, and
 * that is the correct scope, not an over-broad one: none of these routes take
 * a domain, and both mutations are themselves process-global — a new domains
 * root moves EVERY domain, and a provider switch changes EVERY subsequent LLM
 * call. `isDomainActive` would be a category error here.
 *
 * Same middleware shape as sync.js's `guardConcurrent`, and the response is
 * built by the shared `conflictResponse()` so the status, body shape and
 * message style are identical to every other refusal in the app.
 */
function guardConcurrent(action) {
  return (req, res, next) => {
    if (hasActiveWrites()) {
      const { status, body } = conflictResponse(action);
      return res.status(status).json(body);
    }
    next();
  };
}

/** GET /api/config — returns current app configuration */
router.get('/', (_req, res) => {
  res.json({ ...getConfig(), defaultDomain: getDefaultDomain() });
});

/**
 * GET /api/config/default-domain — returns { defaultDomain, domains[] }.
 * Used by the Settings UI to render the dropdown of available domains.
 */
router.get('/default-domain', async (_req, res) => {
  try {
    const domains = await listDomains();
    res.json({ defaultDomain: getDefaultDomain(), domains });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config/default-domain — set or clear the default domain.
 * Body: { defaultDomain: <slug> | null | "" }
 * The default domain is the wiki MCP write tools (compile_to_wiki, etc.) use
 * when the user says "my wiki" without specifying which one.
 */
router.post('/default-domain', async (req, res) => {
  try {
    const requested = (req.body && typeof req.body.defaultDomain === 'string')
      ? req.body.defaultDomain.trim()
      : null;
    if (requested) {
      // Validate that it's a real domain — refuse silently-broken state
      const domains = await listDomains();
      if (!domains.includes(requested)) {
        return res.status(400).json({ error: `Unknown domain: ${requested}` });
      }
    }
    setDefaultDomain(requested || null);
    res.json({ ok: true, defaultDomain: getDefaultDomain() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/domains-path — set a new domains folder path */
router.post('/domains-path', guardConcurrent('change the knowledge folder'), (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath || typeof newPath !== 'string' || !newPath.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  const trimmed = newPath.trim();
  if (!existsSync(trimmed)) {
    return res.status(400).json({ error: `Folder does not exist: ${trimmed}` });
  }
  try {
    setDomainsDir(trimmed);
    res.json({ ok: true, domainsPath: trimmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/pick-folder — opens native macOS folder picker via osascript.
 *  Guarded because this route does NOT merely return a path for the client to
 *  submit to /domains-path — it calls setDomainsDir() itself (below), so it is
 *  a mutation in its own right and needs the same protection.
 */
router.post('/pick-folder', guardConcurrent('change the knowledge folder'), async (_req, res) => {
  try {
    const { stdout } = await execAsync(
      `osascript -e 'POSIX path of (choose folder with prompt "Select your Knowledge Base folder:")'`,
      { timeout: 60000, env: SUBPROCESS_ENV }
    );
    const picked = stdout.trim();
    if (picked) {
      if (!existsSync(picked)) {
        return res.status(400).json({ error: `Folder does not exist: ${picked}` });
      }
      // Re-check immediately before the mutation. The middleware above only
      // proves the state at the moment the dialog OPENED, and this dialog
      // blocks for up to 60 s — long enough for the batch-ingest queue to pick
      // up its next item, or for a second tab to start an ingest, while the
      // user is still browsing for a folder. Deliberately NOT merged into the
      // `cancelled` branch: the shipping frontend checks `data.cancelled`
      // BEFORE `res.ok`, so a refusal must never carry that field.
      if (hasActiveWrites()) {
        const { status, body } = conflictResponse('change the knowledge folder');
        return res.status(status).json(body);
      }
      setDomainsDir(picked);
      res.json({ ok: true, path: picked });
    } else {
      res.json({ cancelled: true });
    }
  } catch (err) {
    // User pressed Cancel in the picker (exit code 1, error -128)
    if (err.killed || err.code === 1 || String(err.stderr).includes('-128')) {
      res.json({ cancelled: true });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── API Keys ────────────────────────────────────────────────────────────────

/** Mask an API key: show only last 4 chars */
function maskKey(key) {
  if (!key || key.length < 8) return key ? '••••' : '';
  return '••••••••' + key.slice(-4);
}

/**
 * Look up the offerable-model catalogue for one provider out of llm.js's
 * `OFFERABLE_MODELS` table, as a hardened OWN-PROPERTY lookup.
 *
 * `provider` here is always one of the two literal strings this route passes
 * in below — never client input — but the lookup is written as if it might
 * not be, on purpose: a bare `table[provider]` would let a future caller that
 * DOES thread user input through this function reach `__proto__` /
 * `constructor` / `toString` and get back an Object.prototype or
 * Function.prototype member instead of the empty-list refusal. `Object.hasOwn`
 * closes that off at the source rather than relying on every future call site
 * remembering to validate its input first.
 *
 * Also tolerant of `table` being `undefined` (the OFFERABLE_MODELS export not
 * existing yet on whatever commit of llm.js is checked out) or malformed
 * (missing provider key, or a non-array value) — always returns an array,
 * never throws.
 *
 * Exported for direct unit testing against a synthetic table, independent of
 * whatever llm.js ships.
 */
export function resolveOfferableModels(table, provider) {
  if (!knownProvider(provider)) return [];
  if (!table || typeof table !== 'object') return [];
  if (!Object.hasOwn(table, provider)) return [];
  const list = table[provider];
  return Array.isArray(list) ? list : [];
}

/**
 * Can this provider actually serve the BUILD LANE — ingest, Health and Compile?
 *
 * ── The P0 this exists to prevent (v3.15.0) ─────────────────────────────────
 * Reproduced before it was fixed: a user with a WORKING Gemini install who
 * merely SAVED an OpenRouter key lost ingest, Health and Compile. Last-saved-
 * wins flipped `activeProvider` to a provider that has no build-lane model
 * (`DEFAULTS.openrouter` is null and the catalogue is empty BY DESIGN until a
 * model has been measured), so the next `getProviderInfo()` threw. Worse, the
 * GET route swallows that throw in a `catch` commented "no key configured yet"
 * — but a key IS configured — so nothing on screen said the app was broken.
 *
 * The rule is the CLASS, not the instance: THE APP MUST NEVER MAKE A PROVIDER
 * ACTIVE THAT CANNOT SERVE THE BUILD LANE. It stays correct once OpenRouter has
 * measured models, and it is already load-bearing for the next provider added
 * the same way — `local` is scaffolded to be exactly that.
 *
 * Fixing this inside getProviderInfo by falling back instead of throwing would
 * be WRONG: the throw is honest, and silently serving a provider other than the
 * one `activeProvider` names is this project's named dead-data shape.
 *
 * ── Why it lives in the ROUTE and not in brain/config.js ────────────────────
 * The answer is llm.js's (which model resolves, and whether it may build), and
 * llm.js imports brain/config.js — so computing it there needs a cycle. That is
 * forbidden by a standing offline invariant whose comment states the
 * architecture outright: "config.js must not import llm.js (cycle), so
 * validation cannot live there." This file already namespace-imports llm.js for
 * exactly this purpose, so the predicate belongs here and is INJECTED into the
 * storage layer via `opts.canActivate`.
 *
 * ── Degradation is asymmetric ON PURPOSE ────────────────────────────────────
 * The only HARD requirement is that a non-empty model id resolves — precisely
 * the mechanism that broke — and that is decided by `getDefaultModel`, a
 * long-standing export. `isBuildLaneModel` is newer, so when it is absent this
 * falls back to "a model resolved, therefore it can build", which is exactly
 * the truth for Gemini and Anthropic before this release. Making a missing
 * export mean "cannot build" would silently kill last-saved-wins for both, a
 * far worse regression than the bug being fixed.
 */
export function providerCanBuild(provider) {
  if (!knownProvider(provider)) return false;
  if (typeof llmModule.getDefaultModel !== 'function') return true; // see degradation note
  let model = null;
  try { model = llmModule.getDefaultModel(provider); } catch { return false; }
  if (typeof model !== 'string' || !model) return false;
  if (typeof llmModule.isBuildLaneModel === 'function') {
    return !!llmModule.isBuildLaneModel(provider, model);
  }
  return true;
}

/**
 * THE ONE accessor for "which models may this provider offer right now".
 *
 * `OFFERABLE_MODELS` is the frozen STATIC table. For OpenRouter it is a PARTIAL
 * VIEW: `setOpenRouterCatalogue()` admits measured entries into a separate
 * dynamic list, and llm.js's `listOfferableModels` is documented as "the
 * accessor every consumer should read (including the route that serialises the
 * picker)". Reading the static table here would compute a catalogue correctly
 * and then never show it — this project's named dead-data shape. Latent only
 * while both sources are empty; live the moment the measured catalogue lands,
 * which is this same release.
 *
 * ── Why BOTH call sites in this file go through here ────────────────────────
 * The build-lane check and the picker serialiser could defensibly differ:
 * reading the static table fails CLOSED for a build pin (a dynamically-admitted
 * model would be refused) but fails by HIDING for the picker. They do NOT
 * differ, and the reason is not squeamishness — it is that an ACCIDENTAL
 * asymmetry and a DELIBERATE one are indistinguishable six months later, which
 * is how this repo's comment-contradicts-code defects start. One accessor, one
 * rule, stated once.
 *
 * In practice the build-lane path never reaches the fallback anyway:
 * `isBuildLaneAllowed` delegates to llm.js's `isBuildLaneModel`, which resolves
 * through `findOfferableModel` -> `listOfferableModels` and is therefore ALREADY
 * dynamic-aware. This helper's job is to make the DEGRADED path agree with the
 * authoritative one instead of quietly diverging from it.
 *
 * Falls back to the static table only when the export is absent — the same
 * namespace-import degradation contract as knownProvider/isBuildLaneAllowed.
 * Always returns an array, never null.
 */
export function offerableFor(provider) {
  if (typeof llmModule.listOfferableModels === 'function') {
    const list = llmModule.listOfferableModels(provider);
    return Array.isArray(list) ? list : [];
  }
  return resolveOfferableModels(llmModule.OFFERABLE_MODELS, provider);
}

/**
 * Is `provider` a provider this app knows how to talk to?
 *
 * Every mutating route below gates on THIS, not on its own inline
 * `p !== 'gemini' && p !== 'anthropic'` pair. Four hand-maintained copies of a
 * membership list is precisely the shape that produced the v3.2.0 CRITICAL, and
 * v3.10.1 found the two-armed version of it silently writing one provider's key
 * into another provider's slot.
 *
 * llm.js owns the answer (it owns DEFAULTS / FALLBACK_CHAINS / OFFERABLE_MODELS),
 * so this delegates to `isKnownProvider` whenever that export is present. The
 * local list is a load-order fallback for the window in which this file is
 * checked out against an llm.js that has not yet grown the export — the same
 * reason the namespace import at the top of this file exists. It is not a
 * second RULE, only a second copy of a three-string set, and it fails in the
 * SAFE direction: an unknown string is refused either way.
 */
const KNOWN_PROVIDERS_FALLBACK = Object.freeze(['gemini', 'anthropic', 'openrouter']);

export function knownProvider(provider) {
  if (typeof llmModule.isKnownProvider === 'function') {
    return !!llmModule.isKnownProvider(provider);
  }
  return KNOWN_PROVIDERS_FALLBACK.includes(provider);
}

/** Refusal body shared by every provider-shaped route below. */
function badProvider(res) {
  return res.status(400).json({
    error: `provider must be one of: ${KNOWN_PROVIDERS_FALLBACK.join(', ')}`,
  });
}

/**
 * May this model be PINNED as the build model — the one that runs ingest,
 * Health and Compile?
 *
 * ── This closes a live hole, it is not new plumbing (v3.15.0) ───────────────
 * `suitability: 'chat-only'` has, until now, been read in exactly three places,
 * all of them badge rendering. NOTHING enforced it. This route gated on
 * `isOfferableModel` plus a saved key, so a user could pin
 * `gemini-3.5-flash-lite` — measured emitting JSON that neither the parser nor
 * the repair pass could fix in 2 of 9 real ingest runs, and badged "not for
 * ingest" on the very screen they clicked — as the model that builds their
 * wiki. The badge said one thing and the button did another.
 *
 * The lane is llm.js's to define (it holds the catalogue and the measurements),
 * so this delegates to `isBuildLaneModel` when that export is present. The
 * fallback reads the SAME `suitability` field off the SAME catalogue entry
 * rather than re-deriving a rule, and fails CLOSED when the entry cannot be
 * found. See knownProvider() above for why a fallback exists at all.
 *
 * CHAT IS UNAFFECTED — a chat-only model stays fully pickable in the chat
 * composer. This gate is about the build lane only.
 */
export function isBuildLaneAllowed(provider, modelId, offerableTable) {
  if (typeof llmModule.isBuildLaneModel === 'function') {
    return !!llmModule.isBuildLaneModel(provider, modelId);
  }
  // offerableFor, not the static table — see its docblock on why this file has
  // exactly one accessor. `offerableTable` is retained as a parameter purely so
  // a unit test can drive this degraded branch against a synthetic catalogue.
  const entry = (offerableTable === undefined ? offerableFor(provider)
                                              : resolveOfferableModels(offerableTable, provider))
    .find(m => m && typeof m === 'object' && m.id === modelId);
  if (!entry) return false;
  return entry.suitability !== 'chat-only';
}

/** GET /api/config/api-keys — returns masked keys + active provider info */
router.get('/api-keys', (_req, res) => {
  const keys = getApiKeys();
  let provider = null;
  try {
    provider = getProviderInfo();
  } catch { /* no key configured yet */ }

  // llm.js's frozen { gemini: [...], anthropic: [...] } catalogue of models the
  // UI may OFFER a user to pick, cheapest-first, each entry carrying pricing +
  // capability + a measured per-feature suitability reason. Read via the
  // namespace import so a not-yet-shipped export resolves to `undefined`
  // (handled by resolveOfferableModels) instead of crashing module load.
  res.json({
    geminiApiKey:     maskKey(keys.geminiApiKey),
    anthropicApiKey:  maskKey(keys.anthropicApiKey),
    openrouterApiKey: maskKey(keys.openrouterApiKey),
    // Config-only (Settings) key presence. The chat model selector keys off
    // THESE so it mirrors exactly what the user has connected in Settings — a
    // key removed via Disconnect (but still in .env) must not appear or be usable
    // in chat. (getEffectiveKey / .env still drives the GLOBAL provider for the
    // documented dev fallback; the per-chat selector is deliberately config-only.)
    //
    // hasGeminiKey / hasAnthropicKey MUST NOT be renamed or removed. The
    // shipping /old frontend's first-run check reads exactly these two; their
    // absence makes it believe no key is configured and re-fire the 4-step
    // onboarding overlay — which has no Escape, no backdrop close, no X and no
    // Skip on step 1 — on every load, for an already-configured user.
    // hasOpenrouterKey is purely ADDITIVE beside them.
    hasGeminiKey:     !!keys.geminiApiKey,
    hasAnthropicKey:  !!keys.anthropicApiKey,
    hasOpenrouterKey: !!keys.openrouterApiKey,
    activeProvider:  provider?.provider || null,
    activeModel:     provider?.model || null,
    // Current default model id per provider, so the chat model selector's label
    // stays in sync with DEFAULTS automatically when we bump to a newer model.
    //
    // DELIBERATELY a { gemini: '<id>', anthropic: '<id>' } map of STRINGS ONLY —
    // never touch this shape. The shipping /old frontend (src/public/app.js,
    // `chat-dd-opt-desc` in the model-selector dropdown) renders it as
    // `escHtml(models[p] || '')`, and `escHtml` starts with `String(str)` — so
    // an object or array here renders the literal text "[object Object]" in
    // production for every user still on /old. The new offerable catalogue
    // below is deliberately a SEPARATE, additive field for exactly this reason.
    //
    // v3.15.0: `openrouter` is added as a third STRING-OR-NULL entry. Two facts
    // make that safe for /old, and both were checked rather than assumed:
    // (a) /old never enumerates this map — it builds its own provider list from
    //     hasGeminiKey/hasAnthropicKey and only ever indexes models[p] for those
    //     two, so a third key is invisible there. /old therefore will not offer
    //     OpenRouter at all, which is the documented limit for this release.
    // (b) the value it reads is `escHtml(models[p] || '')`, so a null would
    //     render as empty rather than "[object Object]". The invariant this
    //     comment protects is "never an object or array" — null is a legitimate
    //     "this provider has no resolvable default", and is what getDefaultModel
    //     returns for a provider llm.js has not yet grown defaults for.
    models: {
      gemini:     getDefaultModel('gemini'),
      anthropic:  getDefaultModel('anthropic'),
      openrouter: getDefaultModel('openrouter') ?? null,
    },
    // The user's EXPLICIT stored pick per provider, or null where they have not
    // chosen. Additive, and deliberately separate from `models` above: `models`
    // is what the app will actually USE (and now already reflects a stored pick,
    // with no frontend change needed), while this distinguishes "the user chose
    // the default" from "the user chose nothing" — which a picker needs in order
    // to render a selected state honestly. Strings or null only; same shape
    // discipline as `models`.
    //
    // Gated config-only, like `offerable` and hasGeminiKey/hasAnthropicKey: a
    // Disconnected provider reports null here because llm.js will not honour its
    // stored selection either (storedSelection()). The UI must never show a
    // selection the engine has stopped obeying.
    selectedModels: {
      gemini:     keys.geminiApiKey     ? getSelectedModel('gemini')     : null,
      anthropic:  keys.anthropicApiKey  ? getSelectedModel('anthropic')  : null,
      openrouter: keys.openrouterApiKey ? getSelectedModel('openrouter') : null,
    },
    // null if primary model is working; populated when the fallback chain kicked in
    // because the pinned default has been retired by the provider.
    fallback:        getFallbackStatus(),
    // The full pickable-model catalogue per provider (cheapest first), for a
    // future model-picker UI. ADDITIVE — `models` above is untouched.
    //
    // Gated the SAME config-scoped way as hasGeminiKey/hasAnthropicKey (i.e.
    // off `keys.*Key` from getApiKeys(), never getEffectiveKey()/.env): a
    // provider the user has Disconnected in Settings must not appear pickable
    // here either, even if a stale .env key would otherwise let the app call it.
    // offerableFor (NOT the raw OFFERABLE_MODELS table) — for OpenRouter the
    // static table is a partial view and the measured catalogue lives beside it.
    // The `keys.*ApiKey ? … : []` gating is UNCHANGED and load-bearing: a
    // provider with no key SAVED IN SETTINGS serialises an empty array whatever
    // any catalogue holds (the v3.0.13 config-scoped rule).
    offerable: {
      gemini:     keys.geminiApiKey     ? offerableFor('gemini')     : [],
      anthropic:  keys.anthropicApiKey  ? offerableFor('anthropic')  : [],
      openrouter: keys.openrouterApiKey ? offerableFor('openrouter') : [],
    },
  });
});

/** POST /api/config/api-keys — save API keys (partial update).
 *  Saving a non-empty key for a provider also marks it as the active provider
 *  ("last-saved-wins" — see setApiKeys in brain/config.js).
 */
router.post('/api-keys', guardConcurrent('save API keys'), (req, res) => {
  const body = req.body || {};

  // Every field this route may write, so the loop below cannot drift from the
  // set of providers the app supports.
  const KEY_FIELDS = ['geminiApiKey', 'anthropicApiKey', 'openrouterApiKey'];

  const update = {};
  for (const field of KEY_FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;

    // Pre-v3.15.0 this was a bare `raw.trim()`. A non-string value in the body
    // — `{"geminiApiKey": 123}` from any client that is not our own frontend —
    // threw a TypeError out of the handler and surfaced as an HTTP 500 with a
    // stack, rather than the 400 it is. Same class as every other "validate at
    // the boundary" guard in this file.
    if (typeof raw !== 'string') {
      return res.status(400).json({ error: `${field} must be a string` });
    }

    const value = raw.trim();

    // Refuse a MASKED display value being round-tripped back in. GET /api-keys
    // returns `••••••••abcd` for a saved key; if any UI path ever echoed that
    // straight back into a save, the user's real credential would be silently
    // replaced by eight bullets and a fragment of itself — undetectable until
    // the next LLM call failed, and unrecoverable because the original is gone.
    // sharedbrain-config.js has refused exactly this shape (on `…`) since
    // v3.0.6; this is that guard applied to the class rather than to the one
    // route that happened to be audited. A real Gemini/Anthropic/OpenRouter key
    // is ASCII alphanumeric plus dashes/underscores, so no legitimate key
    // contains U+2022.
    if (value && value.includes('••••')) {
      return res.status(400).json({
        error: `${field} looks like the masked value shown in Settings, not a real key. ` +
               'Paste the full key, or leave the field out to keep the one already saved.',
      });
    }

    update[field] = value;
  }

  try {
    // `skippedActivation` is a (usually empty) array of
    // { provider, reason:'no_build_model' } — a key that WAS saved but did not
    // become active because that provider has no build-lane model yet. The save
    // genuinely succeeded, so this is not an error; it is the honest signal the
    // UI needs to explain why the Active row did not move. Without it the user
    // sees a successful save and an unchanged active provider with no reason
    // given, which reads as the app ignoring their click.
    // providerCanBuild is INJECTED, not computed in brain/config.js — that file
    // may not import llm.js (standing no-cycle invariant), and WITHOUT this
    // argument setApiKeys activates NOTHING by design. Never drop it.
    const { skippedActivation } = setApiKeys(update, { canActivate: providerCanBuild });
    let provider = null;
    try { provider = getProviderInfo(); } catch {}
    res.json({
      ok: true,
      activeProvider: provider?.provider || null,
      activeModel:    provider?.model || null,
      skippedActivation,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/api-keys/disconnect — clear one provider's stored key.
 *  Body: { provider: 'gemini' | 'anthropic' }
 *  If the disconnected key was active, active switches to the other provider
 *  (if it still has a key), or to null.
 */
router.post('/api-keys/disconnect', guardConcurrent('disconnect an API key'), (req, res) => {
  const { provider } = req.body || {};
  if (!knownProvider(provider)) return badProvider(res);
  try {
    clearApiKey(provider);
    let info = null;
    try { info = getProviderInfo(); } catch {}
    res.json({
      ok: true,
      activeProvider: info?.provider || null,
      activeModel:    info?.model || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/api-keys/active — switch the active provider WITHOUT
 *  re-saving its key. Body: { provider: 'gemini' | 'anthropic' }
 *  Refuses (400) if the requested provider has no stored key.
 */
router.post('/api-keys/active', guardConcurrent('switch the AI provider'), (req, res) => {
  const { provider } = req.body || {};
  if (!knownProvider(provider)) return badProvider(res);
  try {
    // Was a two-armed `provider === 'gemini' ? … : …` reading the config and
    // env fields inline. That is the v3.10.1 shape — a binary ternary has no
    // third arm, so any provider that is not gemini fell through to the
    // ANTHROPIC branch and would have been judged on Anthropic's credential.
    // getEffectiveKey IS "config or env" for one provider, so calling it here
    // removes the copy rather than adding a third arm to it.
    const hasKey = !!getEffectiveKey(provider);
    if (!hasKey) {
      return res.status(400).json({ error: `No ${provider} key is configured — add one before switching to it.` });
    }
    // Refuse LOUDLY rather than succeeding into a broken app. Activating a
    // provider with no build-lane model leaves ingest, Health and Compile
    // throwing on the next call, with nothing on screen saying so (the P0
    // documented at providerCanBuild above). setActiveProvider
    // refuses this too — that is the storage-layer backstop for any other
    // caller — but a silent no-op here would look like the toggle is broken,
    // so the user gets a reason they can act on.
    if (!providerCanBuild(provider)) {
      return res.status(400).json({
        error: `${provider} has no model available for building your wiki yet, so it cannot be made active — ` +
               'ingest, Health and Compile would stop working. Your current provider is unchanged.',
        reason: 'no_build_model',
      });
    }
    // Passed for defence in depth. Unlike setApiKeys, setActiveProvider treats
    // an ABSENT predicate as "allow", so the 400 above is the real guarantee on
    // this path — see that function's docblock.
    setActiveProvider(provider, { canActivate: providerCanBuild });
    let info = null;
    try { info = getProviderInfo(); } catch {}
    res.json({
      ok: true,
      activeProvider: info?.provider || null,
      activeModel:    info?.model || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/api-keys/model — persist the user's model choice for one
 *  provider, WITHOUT changing which provider is active.
 *  Body: { provider: 'gemini' | 'anthropic', model: '<id>' | '' | null }
 *  An empty/null model CLEARS the selection (back to the provider default).
 *  Refuses (400) if the provider has no key SAVED IN SETTINGS, or if the model
 *  is not in OFFERABLE_MODELS for that provider.
 *
 * ── guardConcurrent is load-bearing here, not copied for symmetry ────────────
 * This is the v3.6.0 "config mutation mid-write" class, and the sharpest
 * instance of it yet. resolveProviderDefault consults the stored selection
 * FRESH ON EVERY CALL (it must — a Settings change has to take effect without a
 * restart), and a multi-phase ingest makes 20+ LLM calls over several minutes.
 * Unguarded, a click here mid-ingest would plan the outline on one model and
 * write Phase-2 batches 3..11 on another — v3.6.0's "silently finish it on a
 * different model", verbatim. It would also invalidate Anthropic's prompt cache
 * mid-run (a different model is a different cache namespace, so every cached
 * prefix READ becomes a WRITE at 1.25x — the v3.0.16 saving inverted into a
 * surcharge) and make the queue's per-item spend arithmetic wrong, since price
 * is looked up per model. Its sibling /api-keys/active is guarded for the
 * provider-shaped version of exactly this; leaving the model-shaped one open
 * would be this repo's named "guard applied to a ROUTE rather than a CLASS"
 * pattern for the fifth time.
 *
 * The gate is CONFIG-ONLY (getApiKeys(), never getEffectiveKey/.env), matching
 * `offerable` on GET /api-keys above and storedSelection() in llm.js: a user can
 * only store a choice for a provider they have actually connected in Settings,
 * and llm.js only honours it while that key remains connected. Both ends of the
 * contract agree, so a Disconnect cannot leave a live orphaned selection.
 *
 * Validation is a READ of the single allow-list predicate (isOfferableModel),
 * not a second copy of it — and it is deliberately not the only gate: llm.js
 * re-checks on read, because a stored id can stop being offerable AFTER it was
 * validly written (we pull a model after a bad live probe). Write-time
 * validation exists to give the user a 400 they can act on; read-time
 * validation is what keeps them safe later.
 */
router.post('/api-keys/model', guardConcurrent('change the AI model'), (req, res) => {
  const { provider, model } = req.body || {};
  if (!knownProvider(provider)) return badProvider(res);
  // Absent / empty / null clears the selection. Anything else must be a string.
  const clearing = model === undefined || model === null || model === '';
  if (!clearing && typeof model !== 'string') {
    return res.status(400).json({ error: 'model must be a string' });
  }
  try {
    const keys = getApiKeys();
    // CONFIG-scoped, deliberately (getApiKeys, never getEffectiveKey/.env) —
    // see the docblock above. Looked up by field name from a frozen table
    // rather than a ternary, for the v3.10.1 reason: a binary ternary silently
    // judges every non-gemini provider on Anthropic's credential.
    const KEY_FIELD_BY_PROVIDER = {
      gemini: 'geminiApiKey', anthropic: 'anthropicApiKey', openrouter: 'openrouterApiKey',
    };
    const savedKey = Object.hasOwn(KEY_FIELD_BY_PROVIDER, provider)
      ? keys[KEY_FIELD_BY_PROVIDER[provider]]
      : '';
    if (!savedKey) {
      return res.status(400).json({
        error: `No ${provider} key is saved in Settings — connect one before choosing a model for it.`,
      });
    }
    if (!clearing && !llmModule.isOfferableModel(provider, model)) {
      // Never echo the caller's string back: this repo has a recorded
      // log-forgery / injected-instruction finding from echoing an
      // attacker-controlled value into a user-facing refusal (v3.0.1-beta.20).
      return res.status(400).json({
        error: `That model is not available for ${provider}. Pick one from the list in Settings.`,
      });
    }
    // THE BUILD LANE (v3.15.0). This route pins the model that runs ingest,
    // Health and Compile — not chat. A model measured as unsuitable for that
    // job must not be pinnable for it, however loudly the badge says so: a
    // badge is a label, and until now nothing enforced the label.
    //
    // Naming the model here is deliberate and is NOT the log-forgery shape the
    // sibling refusal above avoids: this branch is reached only AFTER
    // isOfferableModel has confirmed the string is one of OUR catalogue ids, so
    // it is our own literal being echoed, not the caller's. The user needs to
    // know WHICH pick was refused and that it is still usable in chat —
    // otherwise the refusal reads as the picker being broken.
    if (!clearing && !isBuildLaneAllowed(provider, model)) {
      return res.status(400).json({
        error: `"${model}" is measured as chat-only, so it cannot be the model that builds your wiki ` +
               '(ingest, Health and Compile). Pick a general-purpose model here — ' +
               'you can still choose this one per-conversation in chat.',
      });
    }
    const stored = setSelectedModel(provider, clearing ? '' : model);
    let info = null;
    try { info = getProviderInfo(); } catch {}
    res.json({
      ok: true,
      provider,
      selectedModel: stored,
      // What the app will ACTUALLY use for this provider now — so the UI renders
      // the resolved truth rather than assuming the write took effect verbatim.
      effectiveModel: getDefaultModel(provider),
      activeProvider: info?.provider || null,
      activeModel:    info?.model || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Key validation ──────────────────────────────────────────────────────────

/**
 * How long we wait on the upstream key-check before giving up. A hung TCP
 * connection must not hold an Express handler open indefinitely — the app is
 * single-process and this route is reachable from a Settings click.
 */
const KEY_VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Turn an OpenRouter `GET /api/v1/key` outcome into the verdict this route
 * returns. PURE — takes an HTTP status and an already-parsed body, touches no
 * network, no config, and never sees the key.
 *
 * Extracted rather than inlined for two reasons, both about proof:
 *
 *  1. It makes every branch testable OFFLINE with no credential and no live
 *     provider. The alternative on offer was an env var that redirects the
 *     upstream URL at a test stub — which is a credential-exfiltration
 *     primitive in production (any process that can set an env var could point
 *     the user's key at a host it controls) and was deliberately NOT shipped.
 *  2. It is where the no-leak property lives: `payload` is read for FOUR
 *     numeric/boolean fields and nothing else, and every message is a fixed
 *     literal keyed off `status`. The upstream `error.message` is never read,
 *     so there is no path by which a hostile or buggy upstream can get text of
 *     its choosing into our response — the shape v2.8.0 had to add a redactor
 *     for, closed here by construction instead.
 *
 * Classification is STRUCTURAL (on the numeric status, which OpenRouter also
 * mirrors into `error.code`), never a substring match on a message — this
 * repo's `/\b429\b/` once matched its own prose about "429 characters".
 *
 * `valid` is deliberately TRI-STATE: true / false / null. `null` means "we
 * could not find out" (rate-limited, upstream broken, unreadable), which is a
 * different fact from "this key is bad" and must not be rendered as one.
 * 402 reports valid:TRUE with a warning — the key authenticated; the ACCOUNT is
 * out of credit, and telling the user their key is wrong would send them to
 * regenerate a perfectly good one.
 *
 * @param {number} status  HTTP status from the upstream call.
 * @param {*}      payload Parsed JSON body, or undefined if it did not parse.
 */
export function summariseOpenRouterKeyCheck(status, payload) {
  if (status === 401 || status === 403) {
    return {
      valid: false, reason: 'invalid_key',
      error: 'OpenRouter rejected this key. Check it was pasted in full — keys start with "sk-or-v1-" — ' +
             'and that it has not been revoked at openrouter.ai/keys.',
    };
  }
  if (status === 402) {
    return {
      valid: true, reason: 'no_credits',
      warning: 'This key works, but the account has no remaining credit. Even free models are refused ' +
               'while the balance is negative. Top up at openrouter.ai/credits.',
    };
  }
  if (status === 429) {
    return {
      valid: null, reason: 'rate_limited',
      error: 'OpenRouter is rate-limiting this key right now, so it could not be checked. Try again shortly.',
    };
  }
  if (status < 200 || status >= 300) {
    return {
      valid: null, reason: 'upstream_error',
      error: `OpenRouter returned ${status} — this is an OpenRouter-side problem, not a key problem. Try again shortly.`,
    };
  }
  if (payload === undefined) {
    return {
      valid: null, reason: 'bad_response',
      error: 'OpenRouter returned a response we could not read. Try again shortly.',
    };
  }

  // Documented shape is { data: { limit, limit_remaining, usage, is_free_tier } }.
  // Read defensively and NORMALISE TO null rather than to 0: `limit: null` from
  // OpenRouter means "no cap on this key", and rendering that as 0 would tell
  // the user their key is exhausted. Absent-vs-zero is the v3.14.0 rule
  // (reported or absent, never inferred) applied to somebody else's payload.
  const d = (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object')
    ? payload.data : {};
  const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;

  return {
    valid: true,
    isFreeTier:     typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
    limit:          num(d.limit),
    limitRemaining: num(d.limit_remaining),
    usage:          num(d.usage),
  };
}

/**
 * POST /api/config/api-keys/validate — check a provider key WITHOUT spending
 * anything.
 *
 * Body: { provider: 'openrouter', apiKey?: '<key>' }
 *   apiKey omitted/empty -> validates the key already resolved for that
 *   provider (config, then .env), so this doubles as a "is my saved key still
 *   good?" probe. Supplying one lets Settings verify a key BEFORE saving it,
 *   the same server-proxy shape as sharedbrain's /validate-pat: the key travels
 *   browser -> localhost -> provider once and is NEVER persisted here.
 *
 * ── Why this exists for OpenRouter and not the other two ────────────────────
 * OpenRouter publishes `GET /api/v1/key`, an authenticated endpoint that
 * returns the key's own limits and usage and costs ZERO tokens. Gemini and
 * Anthropic have no equivalent, which is why System Check verifies those by
 * making one deliberately tiny LLM call (~$0.0001) behind an explicit
 * cost-confirm. A free, zero-token check is strictly better where one exists,
 * so this route refuses the other two providers by name and points at the
 * surface that does handle them, rather than silently doing nothing.
 *
 * ── The verdict is a 200 body, not an HTTP error ─────────────────────────────
 * A rejected key means THIS route worked and the answer is "no". Returning 401
 * would be a lie about our own API and, worse, would land in the frontend's
 * generic network-error path where the actionable detail is discarded. Same
 * posture as /api/sharedbrain/validate-pat, deliberately.
 *
 * ── No key bytes may leave this handler ─────────────────────────────────────
 * Every message below is a FIXED literal chosen by HTTP status. The upstream
 * error body is never read and never echoed, even in part. That is not
 * fastidiousness: v2.8.0 found a GitHub error body echoing a credential-shaped
 * string back at us, and shipped `sanitizeDetail()` to redact token prefixes
 * before truncation. Mapping status -> literal removes the need for a redactor
 * at all, and matches the spec's rule that OpenRouter errors are classified
 * STRUCTURALLY (error.code is numeric and equals the HTTP status) and never by
 * substring — this repo's own `/\b429\b/` once matched its own prose.
 *
 * ── DELIBERATELY NOT guardConcurrent — do not "fix" this by symmetry ─────────
 * Every OTHER route on this path carries guardConcurrent, so the missing one
 * here reads like an oversight. It is not. That guard exists to stop a CONFIG
 * MUTATION landing mid-write (a provider or model swap re-resolves what an
 * in-flight ingest is billed to — the v3.6.0 class). This route mutates
 * nothing: it makes one read-only, zero-token call and writes no state, so
 * there is nothing for an in-flight ingest to be corrupted by.
 *
 * Guarding it would be actively harmful. A 409 here fires precisely when a
 * multi-phase ingest is running, i.e. exactly when a user is most likely to be
 * asking "is my key the problem?" — refusing the diagnostic at the moment it
 * is needed. The house already settled this shape twice:
 * `POST /api/sharedbrain/validate-pat` and `POST /api/diagnostics/live` both
 * take a credential and/or hit the network and carry NO concurrency guard.
 *
 * POST (not GET) is still load-bearing and must stay: the server's
 * cross-origin guard only inspects mutating verbs, so a GET here would be
 * reachable from any web page the user has open.
 */
router.post('/api-keys/validate', async (req, res) => {
  const { provider, apiKey } = req.body || {};
  if (!knownProvider(provider)) return badProvider(res);

  if (provider !== 'openrouter') {
    return res.status(400).json({
      error: `${provider} keys cannot be checked for free. Use Settings → System Check → ` +
             'Verify AI connection, which confirms the key with one tiny AI call.',
    });
  }

  let key;
  if (apiKey === undefined || apiKey === null || apiKey === '') {
    key = getEffectiveKey('openrouter');
    if (!key) {
      return res.status(400).json({
        error: 'No OpenRouter key is configured — paste one to test it, or save one first.',
      });
    }
  } else {
    if (typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string' });
    }
    key = apiKey.trim();
    // Length bounds only. OpenRouter documents the `sk-or-v1-` prefix but not
    // the length or charset, so refusing on a guessed format would reject
    // legitimate future keys. The upstream endpoint IS the format authority;
    // these bounds exist only to stop a megabyte of junk becoming an outbound
    // header. Same 20..400 window sharedbrain's PAT validator uses.
    if (key.length < 20 || key.length > 400) {
      return res.status(400).json({ error: 'apiKey does not look like an OpenRouter key (expected 20-400 characters)' });
    }
  }

  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'User-Agent': 'the-curator-key-validator',
      },
      signal: AbortSignal.timeout(KEY_VALIDATION_TIMEOUT_MS),
    });
  } catch {
    // Deliberately swallowing the caught error rather than reporting it. A
    // fetch/abort error carries no diagnostic a user can act on beyond "we
    // couldn't reach it", and not touching it is the strongest possible
    // guarantee that nothing derived from the request can reach the response.
    return res.json({
      ok: true, provider: 'openrouter', valid: null,
      reason: 'unreachable',
      error: 'Could not reach OpenRouter (network error or timeout). Check your connection and try again.',
    });
  }

  // Body is parsed ONLY for a 2xx — an error body is never read, let alone
  // echoed (see summariseOpenRouterKeyCheck). `undefined` signals unreadable.
  let payload;
  if (r.ok) {
    try { payload = await r.json(); } catch { payload = undefined; }
  }

  res.json({ ok: true, provider: 'openrouter', ...summariseOpenRouterKeyCheck(r.status, payload) });
});

// ── Update ──────────────────────────────────────────────────────────────────

/** GET /api/config/update-check — compare local vs remote version AND git commit */
router.get('/update-check', async (_req, res) => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const current = pkg.version;

    // Get local git commit hash
    let localCommit = null;
    try {
      const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, env: SUBPROCESS_ENV });
      localCommit = stdout.trim();
    } catch { /* not a git repo — skip commit comparison */ }

    // Get remote version from GitHub
    const response = await fetch(
      'https://raw.githubusercontent.com/talirezun/the-curator/main/package.json'
    );
    if (!response.ok) throw new Error('Could not reach GitHub');
    const remote = await response.json();
    const latest = remote.version;

    // Get remote git commit hash
    let remoteCommit = null;
    try {
      const commitRes = await fetch(
        'https://api.github.com/repos/talirezun/the-curator/commits/main',
        { headers: { 'Accept': 'application/vnd.github.v3.sha' } }
      );
      if (commitRes.ok) {
        const sha = await commitRes.text();
        remoteCommit = sha.trim().slice(0, 7);
      }
    } catch { /* GitHub API unavailable — fall back to version comparison only */ }

    // Update is available if version differs OR if commits differ
    const versionDiffers = latest !== current;
    const commitsDiffer = localCommit && remoteCommit && localCommit !== remoteCommit;
    const updateAvailable = versionDiffers || commitsDiffer;

    res.json({
      current,
      latest,
      localCommit,
      remoteCommit,
      updateAvailable,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/config/update — fetch latest code, hard-sync to origin/main, install deps, rebuild .app
 *
 * We use `fetch + reset --hard` instead of `pull` because `npm install` commonly
 * regenerates `package-lock.json` with machine-specific diffs, which make plain
 * `git pull` abort with "local changes would be overwritten". The app directory
 * is meant to track `main` verbatim — user data (domains/, .curator-config.json,
 * .sync-config.json) is all gitignored, so hard-reset is safe.
 */
router.post('/update', async (_req, res) => {
  // v3.0.1-beta.8: refuse to update while any wiki write is in flight.
  // The update flow does `git reset --hard origin/main` (safe — only touches
  // tracked app files, domains/ is gitignored) followed by `/api/restart`
  // (NOT safe — kills the Node process, can truncate in-flight wiki writes).
  // The atomic-write fix in this same release makes the truncation
  // recoverable, but the kindest UX is still to refuse the update rather
  // than abort a running ingest.
  if (hasActiveWrites()) {
    const { status, body } = conflictResponse('update the app');
    return res.status(status).json(body);
  }

  // Shared exec options — the env override is what makes `npm` resolvable under
  // the .app wrapper's minimal PATH.
  const execOpts = (extra = {}) => ({ cwd: PROJECT_ROOT, env: SUBPROCESS_ENV, ...extra });
  let beforeSha = null, afterSha = null;

  // Flag this domain-global operation so an ingest that arrives during the
  // git-reset / npm-install window is refused with a clear 409 (see the
  // matching check in src/routes/ingest.js). Cleared in `finally`.
  beginUpdate();
  try {
    // 1. Fetch before resetting so we never hard-reset to a stale ref if the remote is unreachable.
    await execAsync('git fetch origin main', execOpts({ timeout: 30000 }));

    // 2. Record before/after SHAs so the response explains what changed.
    const before = await execAsync('git rev-parse HEAD', execOpts({ timeout: 5000 }));
    beforeSha = before.stdout.trim().slice(0, 7);

    // 3. Hard-sync to origin/main. Discards any local modifications to tracked files
    //    (including the common `package-lock.json` regeneration) without touching gitignored data.
    await execAsync('git reset --hard origin/main', execOpts({ timeout: 10000 }));
    const after = await execAsync('git rev-parse HEAD', execOpts({ timeout: 5000 }));
    afterSha = after.stdout.trim().slice(0, 7);

    // 4. Install deps. Uses the absolute node binary's directory so `npm` resolves
    //    under the .app wrapper's minimal PATH.
    try {
      await execAsync('npm install --silent --no-audit --no-fund', execOpts({ timeout: 120000 }));
    } catch (npmErr) {
      // "npm: command not found" is the classic sign of a pre-v2.3.5 running app:
      // the files on disk already contain the PATH fix, but the currently-running
      // process (which is what spawned this subprocess) doesn't. Restarting picks
      // up the fixed version. Since v2.3.4→v2.3.5 added no dependencies, the
      // existing node_modules is still correct and a restart is sufficient.
      const msg = (npmErr.message || '').toLowerCase();
      const pathIssue = msg.includes('npm: command not found') || msg.includes('npm: not found');
      if (pathIssue) {
        return res.json({
          ok: true,
          restarting: true,
          partial: true,
          from: beforeSha,
          to:   afterSha,
          warning: `Files updated ${beforeSha} → ${afterSha}. ` +
                   `npm couldn't be found under the running app's PATH — a known issue in ` +
                   `older versions that's fixed in the update you just pulled. Restarting will ` +
                   `load the fixed updater. No dependency install is needed for this version bump.`,
        });
      }

      // v3.0.1-beta.10: classify other common npm install failures so the
      // user sees an actionable next step rather than the cryptic
      // "Command failed: npm install --silent --no-audit --no-fund".
      //
      // Reported case that motivated this: a user's `~/.npm/_cacache` had a
      // partial file from a prior force-quit, so every npm install failed
      // with `EACCES: permission denied, rename ...`. The previous error
      // message gave them no hint that `npm cache clean --force` would fix
      // it. The classifier maps each well-known npm-failure pattern to a
      // plain-English remediation that the frontend renders verbatim in
      // the Settings → Updates banner.
      //
      // For genuinely unknown errors we still re-throw the raw npmErr so
      // the user sees the actual text and can google it — never hide an
      // error we don't recognise.
      const classification = classifyNpmError(npmErr.message, beforeSha, afterSha);
      if (classification.actionable) {
        const enriched = new Error(classification.actionable);
        enriched.original = npmErr.message;
        enriched.classification = classification.kind;
        throw enriched;
      }
      throw npmErr;
    }

    // 5. Rebuild the .app so the AppleScript stays current with the code (non-fatal).
    await execAsync('bash scripts/build-app.sh', execOpts({ timeout: 30000 })).catch(() => {});

    res.json({
      ok: true,
      restarting: true,
      from: beforeSha,
      to:   afterSha,
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      from: beforeSha,
      to:   afterSha,
    });
  } finally {
    // v3.0.1-beta.8: ALWAYS clear the update flag — success path leads to a
    // restart anyway, but failure path must release so future ingests aren't
    // blocked. Runs even after the early `return` for the partial-success
    // npm-PATH case.
    endUpdate();
  }
});

export default router;
