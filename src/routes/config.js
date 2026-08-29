import { Router } from 'express';
import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getConfig, setDomainsDir, getApiKeys, setApiKeys, clearApiKey, setActiveProvider, getActiveProvider, getDefaultDomain, setDefaultDomain, getSelectedModel, setSelectedModel, getEffectiveKey } from '../brain/config.js';
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
import { scrubPaths } from '../brain/scrub-paths.js';
import { wikiPath } from '../brain/files.js';
import { stat as fsStat } from 'node:fs/promises';
import {
  assembleProbePrompt,
  estimateQualification,
  qualifyModel,
  isCancelledError,
  QUALIFY_DEFAULT_RUNS,
  QUALIFY_MIN_RUNS,
} from '../brain/openrouter-qualify.js';

const execAsync = promisify(exec);

// ── BOOT: re-admit the persisted OpenRouter catalogue ───────────────────────
//
// This module is imported by `src/server.js` during boot, so this runs once,
// before any request is served — which is what makes "a user who syncs and then
// restarts does not silently lose their models" true.
//
// IT IS NOT A TRUSTED LOAD. Every persisted spec goes back through
// `setOpenRouterCatalogue` -> `defineOfferableModel({dynamic:true})`, the same
// admission the network path uses, so a model that has since become
// inadmissible is dropped rather than grandfathered, and a hand-edited file
// cannot promote an entry into the lane that WRITES the user's wiki.
//
// WRAPPED, because a throw at module scope in a route file takes down every
// route in it — the failure shape `paths.js`'s per-call resolution rule and this
// file's own namespace-import comment both exist to avoid. A corrupt cache file
// must cost the user a re-sync, never a boot.
try {
  if (typeof llmModule.restoreOpenRouterCatalogue === 'function') {
    const r = llmModule.restoreOpenRouterCatalogue();
    if (r && r.restored) {
      // stderr, never stdout (v2.5.3: the MCP child reserves stdout for
      // JSON-RPC; this file is not on that graph, but the rule is house-wide).
      console.error(`[config] restored ${r.admitted} OpenRouter model(s) from the persisted catalogue` +
        (r.refused ? ` (${r.refused} refused on re-admission)` : ''));
    }
  }
} catch (err) {
  console.error(`[config] could not restore the persisted OpenRouter catalogue: ${err && err.message}`);
}

// ── BOOT: re-admit the user's own model qualifications ──────────────────────
//
// SEPARATE try/catch from the catalogue restore above, deliberately: these are
// two independent caches and one being corrupt must not cost the user the other.
// A shared block would let a malformed qualifications file silently discard a
// perfectly good 190-model catalogue.
//
// The same "not a trusted load" posture applies — `restoreLocalQualifications`
// drops any record that is not structurally sound, and a record only ever grants
// the build lane through `isLocallyQualified`, which re-checks live that the
// model is still offerable, still chat-only, and still one WE have never
// measured. A hand-edited file cannot promote a model we found unfit.
try {
  if (typeof llmModule.restoreLocalQualifications === 'function') {
    const q = llmModule.restoreLocalQualifications();
    if (q && q.restored) {
      console.error(`[config] restored ${q.count} local model qualification(s)` +
        (q.dropped ? ` (${q.dropped} malformed record(s) dropped)` : ''));
    }
  }
} catch (err) {
  console.error(`[config] could not restore local model qualifications: ${err && err.message}`);
}

// ── BOOT: refresh the OpenRouter catalogue when it is absent or stale ───────
//
// THE DEFECT THIS CLOSES. Until now the catalogue was populated ONLY by a user
// pressing Sync in Settings. Before that press, chat offered the 5 hand-measured
// OpenRouter routes; after it, ~190. Nothing anywhere said which state you were
// in, so the same app showed two very different lists on two machines — reported
// as "sometimes they show, other times they do not". A list that is silently
// partial is worse than a short one, because the user cannot tell it is partial.
//
// ── EVERY PROPERTY BELOW IS A REFUSAL TO MAKE BOOT WORSE ────────────────────
//
// IT DOES NOT BLOCK BOOT. Scheduled on a timer and never awaited, so module
// evaluation finishes and the server binds regardless. `.unref()` so a pending
// timer cannot hold the process open — which matters for the CLI/test paths that
// import this module and expect to exit.
//
// IT CANNOT THROW. The timer callback is wrapped, and the promise carries its
// own `.catch`. An unhandled rejection from a boot-time network call would be a
// crash on a machine with flaky wifi, for a refresh nobody asked for.
//
// A FAILURE LEAVES THE PREVIOUS CATALOGUE INTACT. Not a property of this block —
// a property of `syncOpenRouterCatalogue`, which reaches `setOpenRouterCatalogue`
// only after a fetch AND a build have both succeeded, and which refuses a
// zero-record response outright. Clearing on failure would read to a user as
// "OpenRouter no longer offers anything", on the screen where they choose what
// to spend through. This block adds nothing to that and takes nothing away.
//
// IT IS KEY-GATED CONFIG-ONLY. `getApiKeys()`, never `getEffectiveKey()` — the
// v3.0.13 rule. A provider the user Disconnected in Settings must not have
// background work done on its behalf, and `offerable.openrouter` is itself
// key-gated, so syncing without a saved key would populate state no screen shows.
// The key is read for TRUTHINESS ONLY: OpenRouter's /models endpoint is public
// and unauthenticated, so no credential enters this path.
//
// IT DEFERS TO ANY WRITE IN FLIGHT. A sync REPLACES the catalogue and REBUILDS
// the price and free registries, which mid-ingest changes what `getProviderInfo`
// resolves for the next call and what the queue prices the last one at — the
// reason `POST /openrouter/sync` carries `guardConcurrent`. A boot-time write is
// unlikely (the ingest queue recovers to `paused`, never running) but "unlikely"
// is not a guard, and this is the one place the HTTP guard cannot reach.
//
// IT IS SKIPPED UNDER TEST. `CURATOR_TEST_USER_DATA_DIR` is this repo's "this is
// a test" seam; a suite that merely imports this router must never make an
// unannounced outbound request. Suites drive `maybeAutoSyncOpenRouter` directly
// with an injected fetch instead.
//
// Exported so the policy is testable without a timer and without a network.
export async function maybeAutoSyncOpenRouter(opts = {}) {
  const skip = (reason) => ({ ran: false, reason });
  if (!opts.force && process.env.CURATOR_TEST_USER_DATA_DIR) return skip('test-isolated');
  if (typeof llmModule.openRouterCatalogueNeedsSync !== 'function'
      || typeof llmModule.syncOpenRouterCatalogue !== 'function') {
    return skip('unsupported');
  }
  let saved = '';
  try { saved = getApiKeys().openrouterApiKey || ''; } catch { return skip('config-unreadable'); }
  if (!saved) return skip('no-key');
  // Read through the injected accessor when a suite supplies one, so the
  // deferral can be exercised without standing up a real write.
  const busy = typeof opts.hasActiveWrites === 'function' ? opts.hasActiveWrites : hasActiveWrites;
  try { if (busy()) return skip('writes-active'); } catch { /* treat as idle */ }
  const verdict = llmModule.openRouterCatalogueNeedsSync(
    Number.isFinite(opts.now) ? opts.now : Date.now(),
  );
  if (!verdict.needed) return { ran: false, reason: verdict.reason, ageMs: verdict.ageMs };
  try {
    const result = await llmModule.syncOpenRouterCatalogue({
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    console.error(`[config] auto-synced the OpenRouter catalogue (${verdict.reason}): ` +
      `${result.admitted} model(s) admitted of ${result.total} published`);
    return { ran: true, reason: verdict.reason, admitted: result.admitted, total: result.total };
  } catch (err) {
    // Deliberately quiet and non-fatal: the previous catalogue is still live and
    // still selectable, and the Sync button in Settings remains the explicit,
    // reportable path. A boot-time toast about a refresh nobody requested would
    // train users to ignore the one that matters.
    console.error(`[config] OpenRouter catalogue auto-sync failed (${verdict.reason}); ` +
      `keeping the existing list: ${err && err.message}`);
    return { ran: false, reason: 'failed', error: err && err.message };
  }
}

// ── THE TRIGGER LIVES IN server.js, NOT AT MODULE SCOPE HERE ────────────────
//
// The first draft fired this from a `setTimeout` at module load, next to the two
// restore blocks above. That was wrong, and the reason is worth keeping: a suite
// that imports this router is NOT booting the app. `test-beta10-fixes.js` pulls
// `classifyNpmError` out of this file and does not isolate its user-data dir, so
// module-scope firing would have made an OFFLINE suite reach the network AND
// persist a catalogue sidecar into the maintainer's real user-data directory.
// The `CURATOR_TEST_USER_DATA_DIR` guard inside the function does not save it —
// that suite never sets the variable.
//
// Binding the trigger to `src/server.js` makes the distinction structural rather
// than a list of suites to remember: only an actual server boot syncs. The env
// guard stays as a second layer for the suites that DO spawn a real server.
// See `src/server.js` for the call.
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
 * wins flipped `activeProvider` to a provider that, AT THAT MOMENT, had no
 * build-lane model — OpenRouter's default and its hand-measured catalogue were
 * both still empty, because this release's rule is that a model may not be
 * offered for a job nobody has measured it doing. So the next
 * `getProviderInfo()` threw. Worse, the GET route swallows that throw in a
 * `catch` that used to be commented "no key configured yet" — but a key IS
 * configured — so nothing on screen said the app was broken.
 *
 * ⚠ DO NOT READ THE ABOVE AS THE CURRENT STATE. This comment previously
 * asserted, in the present tense, that "`DEFAULTS.openrouter` is null and the
 * catalogue is empty BY DESIGN" — and BOTH halves became false within this same
 * release, once three OpenRouter models were measured and admitted. Verified by
 * execution at the time of writing: `getDefaultModel('openrouter')` resolves a
 * real id, and `OFFERABLE_MODELS.openrouter` is non-empty. That is precisely why
 * the paragraph above is now written in the past tense and no live value is
 * restated here: a comment asserting the opposite of its own file is this
 * repo's most reliable early-warning shape, and this one had already turned.
 * The predicate below is the single source of truth — read it, do not read a
 * remembered value out of prose.
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
 * `offerableFor`, with ONE additive field per entry: `measuredBy`.
 *
 * ── WHY IT IS JOINED HERE AND NOT STAMPED ON THE FROZEN ENTRY ───────────────
 * It has three values — 'curator' (we measured it against the real ingest
 * prompt), 'user' (this installation measured it on its own pages via "Test on
 * my wiki"), and null (nobody has) — and the middle one depends on live
 * per-installation state a frozen catalogue cannot know. Stamping two of the
 * three onto the entry and letting the client join the third back on would put
 * one field name on two different quantities, which is the defect v3.17.1
 * records. So llm.js owns the single producer (`measurementProvenance`) and
 * this is the only place its answer is attached.
 *
 * The entries are still serialised verbatim — this SPREADS rather than mutates,
 * so the frozen objects `listOfferableModels` returns are untouched and every
 * existing field keeps its existing meaning. `suitability`, `dominated`,
 * `caution`, `jsonRaw`, `medianLatencyMs` and `outlinePages*` are all left
 * alone: suites pin them, and this field answers a question none of them does.
 *
 * IT IS NOT A QUALITY SCORE. `null` means UNMEASURED, never BAD — a
 * hand-measured model may be flagged `caution` and a fetched one may be
 * excellent and simply unprobed. Price stays a displayed FACT and is not
 * consulted here at all.
 *
 * Degrades to the plain list when the export is absent, the same
 * namespace-import contract as `knownProvider` / `isBuildLaneAllowed`: a
 * missing field reads as "we do not know", which is the safe direction.
 */
function withMeasurement(provider) {
  const list = offerableFor(provider);
  if (typeof llmModule.measurementProvenance !== 'function') return list;
  return list.map(e => ({ ...e, measuredBy: llmModule.measurementProvenance(provider, e.id) }));
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
  // TWO DIFFERENT FACTS REACH THE CATCH BELOW, and the comment that used to sit
  // here named only one of them ("no key configured yet"), which is why the
  // build-lane P0 documented at providerCanBuild was invisible on screen:
  //   (a) genuinely no key anywhere — the honest first-run case;
  //   (b) a key IS configured, but `activeProvider` resolves to a provider
  //       with no build-lane model, or to the explicit `null` sentinel
  //       ("we decided: nobody" — recorded by setApiKeys / clearApiKey when
  //       every candidate was refused). getProviderInfo throws for both.
  // Swallowing is still right HERE — this is a status read, and a 500 on the
  // screen the user opens to fix their keys would be worse than a null. What
  // is NOT right is calling it (a). The response already carries the honest
  // signal for both: `activeProvider: null` plus `hasGeminiKey` /
  // `hasAnthropicKey` / `hasOpenrouterKey`, so a caller can tell "no key" from
  // "keys, but nobody can build" without a new field.
  try {
    provider = getProviderInfo();
  } catch { /* see the two cases above — deliberately not distinguished here */ }

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
      gemini:     keys.geminiApiKey     ? withMeasurement('gemini')     : [],
      anthropic:  keys.anthropicApiKey  ? withMeasurement('anthropic')  : [],
      openrouter: keys.openrouterApiKey ? withMeasurement('openrouter') : [],
    },
    // ── THE ONE BUILD MODEL, DERIVED ─────────────────────────────────────────
    // What actually builds the wiki right now: one provider, one model, and
    // where the value came from. NOTHING NEW IS STORED for this — it is read
    // straight off the same resolution ingest, Health and Compile use, so it
    // cannot disagree with them, and there is no second field to migrate or to
    // drift. `POST /api-keys/build-model` is the write side.
    //
    // `source` answers the question the old per-provider picker could not: WHY
    // this model. 'env' means LLM_MODEL is overriding everything (the developer
    // escape hatch, which outranks a Settings click by design); 'selected' means
    // the user picked it; 'default' means nobody picked and this is the pinned
    // cheapest model on the active provider. Reported as a fact rather than
    // inferred client-side, because a client re-deriving the precedence ladder
    // would be a second copy of it.
    //
    // Null when no provider can resolve at all — the same honest state
    // `activeProvider: null` above reports, not an error.
    buildModel: (() => {
      const p = provider?.provider || null;
      if (!p) return null;
      const selected = getSelectedModel(p);
      const envModel = (process.env.LLM_MODEL && p === getActiveProvider())
        ? process.env.LLM_MODEL : null;
      return {
        provider: p,
        model: provider?.model || null,
        source: envModel ? 'env' : (selected ? 'selected' : 'default'),
        // Does the STORED pick actually govern? False when LLM_MODEL is
        // overriding it, or when the pick was refused on read (stale id, model
        // pulled after a bad probe, chat-only pinned as build). A picker that
        // shows a stored choice the engine has stopped obeying is this repo's
        // named dead-data shape, in the direction the user notices least.
        selectedHonoured: !!selected && selected === (provider?.model || null),
        measuredBy: typeof llmModule.measurementProvenance === 'function'
          ? llmModule.measurementProvenance(p, provider?.model || null)
          : null,
      };
    })(),
    // Provenance for the OpenRouter half of `offerable` above — when the live
    // catalogue was fetched and how many entries it holds. Deliberately NOT a
    // second catalogue surface: the models themselves stay in `offerable`, and
    // this only answers "how fresh is that list", which the sync button needs in
    // order to say anything truthful about its own last run. Key-gated exactly
    // like `offerable`, and ADDITIVE — `/old` reads `models` and the
    // `hasXKey` booleans and ignores unknown fields (the v3.12.0 precedent that
    // added `offerable` itself).
    openrouterCatalogue: keys.openrouterApiKey && typeof llmModule.getOpenRouterCatalogueMeta === 'function'
      ? llmModule.getOpenRouterCatalogueMeta()
      : null,
    // ── THE USER'S OWN MEASUREMENTS ──────────────────────────────────────────
    // Records produced by "Test on my wiki", keyed by model id so the picker can
    // join them onto `offerable` without a second request.
    //
    // A SEPARATE FIELD, NOT A MUTATION OF `offerable`. The catalogue entries are
    // frozen and are serialised verbatim; more importantly, a locally-qualified
    // model must keep reporting `suitability: 'chat-only'` on the wire, so the
    // UI can badge "you measured this" differently from "we measured this".
    // Folding the qualification into `suitability` would collapse two different
    // epistemic claims into one badge — the thing this whole design exists to
    // prevent.
    //
    // `qualifies` is computed SERVER-SIDE from the same predicate the build-lane
    // gate uses, rather than left for the client to re-derive from the counts. A
    // client-side re-derivation would be a second copy of a money-relevant rule
    // and could disagree with the server about whether a pin will be accepted —
    // this repo's named dead-data shape, in the direction where the user sees a
    // button that is guaranteed to 400.
    //
    // Key-gated exactly like `offerable`, and ADDITIVE (the `/old` shell reads
    // `models` plus the hasXKey booleans and ignores unknown fields).
    qualifications: keys.openrouterApiKey && typeof llmModule.listLocalQualifications === 'function'
      ? llmModule.listLocalQualifications().map(r => ({
          ...r,
          // Whether this record CURRENTLY grants the build lane. Recomputed on
          // every read, never stored, because it depends on the live catalogue:
          // a model that has left the eligible list stops qualifying the instant
          // it leaves, while the evidence the user paid for is kept and shown.
          qualifies: typeof llmModule.isLocallyQualified === 'function'
            ? llmModule.isLocallyQualified('openrouter', r.modelId)
            : false,
          stillOffered: typeof llmModule.isOfferableModel === 'function'
            ? llmModule.isOfferableModel('openrouter', r.modelId)
            : false,
        }))
      : [],
    minRunsToQualify: QUALIFY_MIN_RUNS,
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
 *  Body: { provider: 'gemini' | 'anthropic' | 'openrouter' }
 *  If the disconnected key was active, active switches to the next provider
 *  that still has a key AND can serve the build lane, or to null.
 *
 * ── THE THIRD BUILD-LANE MOVER, and the last one to be guarded ──────────────
 * Disconnecting the ACTIVE provider REASSIGNS the build lane (ingest, Wiki
 * Health, Compile) to whichever remaining provider holds a key. That is the
 * same reassignment `setApiKeys` and `/api-keys/active` above already gate on
 * `providerCanBuild`, and this call site was the one that did not: it passed a
 * single argument, so `clearApiKey`'s `opts.canActivate` guard — which exists
 * for exactly this and documents this file as the fix — was INERT on the only
 * path a user can reach.
 *
 * NOT an argument-count mismatch: the parameter is defaulted, nothing threw,
 * nothing was undefined. It was an UN-SUPPLIED GUARD, which is why it left no
 * trace. Absent, `clearApiKey` allows unconditionally and hands the lane to the
 * first keyed provider in PROVIDER_ORDER. Measured before this line changed: a
 * config holding a Gemini key and an OpenRouter key, active gemini,
 * `clearApiKey('gemini')` resolved to openrouter with nothing consulted.
 *
 * Harmless only BY LUCK today, because every provider that can hold a key
 * happens to have a build-lane default. It becomes live the moment one does not
 * — `local` is scaffolded to be precisely that (no API key at all), and an
 * OpenRouter whose default is pulled is the same shape. Then: disconnecting one
 * provider silently hands the build lane to a provider that cannot serve it,
 * the next `getProviderInfo()` throws, and the GET route swallows it — so
 * ingest, Health and Compile all break with nothing on screen saying why.
 *
 * The default in `clearApiKey` is ALLOW (not refuse, unlike `setApiKeys`) and
 * that asymmetry is deliberate and documented there — which is exactly why the
 * guarantee has to be the caller supplying the predicate. Never drop this
 * second argument.
 */
router.post('/api-keys/disconnect', guardConcurrent('disconnect an API key'), (req, res) => {
  const { provider } = req.body || {};
  if (!knownProvider(provider)) return badProvider(res);
  try {
    clearApiKey(provider, { canActivate: providerCanBuild });
    let info = null;
    // This catch became REACHABLE-WITH-KEYS-CONFIGURED the moment the guard
    // above was supplied: when every remaining candidate is refused,
    // `activeProvider` is the explicit `null` decision and getProviderInfo
    // throws. Swallowing is correct (the disconnect itself succeeded, and a 500
    // would misreport that), and `activeProvider: null` below is the honest
    // report of the outcome. Do not re-label this as "no key configured" — that
    // mislabelling on the GET route is what hid this whole P0.
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
      // The message now names the WAY OUT as well as the rule, because for an
      // OpenRouter model there is one: measure it on your own wiki. Without that
      // sentence the refusal reads as a dead end on the exact screen the user
      // opened in order to change their model.
      const canBeMeasured = provider === 'openrouter'
        && typeof llmModule.getLocalQualification === 'function'
        && !llmModule.getLocalQualification(model);
      return res.status(400).json({
        error: `"${model}" has not been measured for building a wiki, so it cannot be the model that ` +
               'runs ingest, Health and Compile. You can still choose it per-conversation in chat.' +
               (canBeMeasured
                 ? ` To use it here, run "Test on my wiki" on its row first — that measures it against ` +
                   `your own pages ${QUALIFY_MIN_RUNS} times and reports what it actually did.`
                 : ' Pick a general-purpose model here instead.'),
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

/**
 * POST /api/config/api-keys/build-model — choose THE model that builds the wiki.
 * Body: { provider: 'gemini'|'anthropic'|'openrouter', model: '<id>' }
 *
 * ── WHY THIS EXISTS: A PIN THAT COULD BE INERT ──────────────────────────────
 * `/api-keys/model` above stores a pin PER PROVIDER and deliberately does not
 * touch `activeProvider`. Only the ACTIVE provider's pin governs ingest, Health
 * and Compile, so a user with two connected providers could pick a model, see
 * it marked as chosen, and have it govern nothing — documented in
 * `docs/user-guide.md` as the likeliest user-facing surprise in the whole
 * router. There is exactly ONE build model, and choosing it is one act.
 *
 * So this route names PROVIDER AND MODEL TOGETHER and applies both. It cannot
 * produce an inert selection, because after it returns the pinned model always
 * belongs to the active provider.
 *
 * ── IT ADDS NO NEW STORAGE, AND THAT IS THE SAFETY ARGUMENT ─────────────────
 * The obvious implementation is a new `buildModel: {provider, model}` config
 * key. It was rejected: `activeProvider` + `selectedModels[activeProvider]`
 * ALREADY expresses exactly this, so a second field would be a second source of
 * truth for one fact — the two-hand-maintained-copies shape that produced this
 * repo's v3.2.0 CRITICAL — and it would need a migration, a precedence rule
 * against the old field, and a resolver branch. Instead this route performs the
 * two EXISTING writes atomically from the user's point of view.
 *
 * The consequence is the acceptance criterion for the whole change:
 * `resolveProviderDefault`, `defaultModelFor`, `applyModelOverride`,
 * `storedSelection` and `getDefaultModel` are BYTE-UNCHANGED, so every existing
 * config shape — a per-provider pin, no pin, `LLM_MODEL` set, a stored id whose
 * provider was later disconnected, a stored id no longer offerable, a corrupt
 * hand-edited file — resolves exactly as it did before this route existed.
 * Nothing moves until the user makes a new choice HERE. `test-build-model.js`
 * proves that against the pre-change resolver rather than arguing it.
 *
 * ── WRITE ORDER IS LOAD-BEARING: MODEL FIRST, THEN PROVIDER ─────────────────
 * The two writes are separate `writeRaw` calls, so a crash can land between
 * them. Model-then-provider means the interrupted state is "pin stored, provider
 * not switched" — which is EXACTLY today's behaviour, an inert pin: no worse
 * than the baseline, and repaired by clicking again. The reverse order would
 * leave the provider switched with no pin, silently moving the user onto a
 * different provider's DEFAULT model — a spend change they never asked for.
 *
 * ── IT CANNOT HAND THE BUILD LANE TO A PROVIDER THAT CANNOT BUILD ───────────
 * v3.15.1 records that P0: `clearApiKey` handed the lane onward without the
 * `canActivate` predicate. Here it is closed BY CONSTRUCTION, not by a
 * predicate: the provider is only switched to after this route has already
 * established that it has a key SAVED IN SETTINGS and that `model` is
 * build-lane-eligible for it — so the very model being pinned is the proof that
 * the provider can build. `providerCanBuild` is still passed to
 * `setActiveProvider` for defence in depth, and is re-evaluated AFTER the pin
 * lands so it reads the post-write state rather than the pre-write one.
 *
 * ── guardConcurrent, config-scoped keys, and the 409 ────────────────────────
 * Both inherited unchanged from the two routes this replaces the pair of. The
 * guard is the sharper of the two reasons stated on `/api-keys/model`: this
 * route can change the provider AND the model mid-ingest, so unguarded it could
 * plan an outline on one provider and write Phase-2 batches on another.
 */
router.post('/api-keys/build-model', guardConcurrent('change the AI model'), (req, res) => {
  const { provider, model } = req.body || {};
  if (!knownProvider(provider)) return badProvider(res);
  // Deliberately NO clearing arm, unlike /api-keys/model. "Clear the one build
  // model" has no meaning: something must build the wiki. A user who wants the
  // app default back clears the per-provider pin through the older route, which
  // is still the surface for that.
  if (typeof model !== 'string' || !model) {
    return res.status(400).json({ error: 'model must be a non-empty string' });
  }
  try {
    const keys = getApiKeys();
    // CONFIG-scoped (getApiKeys, never getEffectiveKey/.env) — the v3.0.13 rule,
    // and the same frozen field table `/api-keys/model` uses rather than a
    // ternary, for the v3.10.1 reason.
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
    // Never echo the caller's string here: unvalidated at this point, and this
    // repo has a recorded log-forgery finding from echoing an attacker-supplied
    // value into a user-facing refusal (v3.0.1-beta.20).
    if (!llmModule.isOfferableModel(provider, model)) {
      return res.status(400).json({
        error: `That model is not available for ${provider}. Pick one from the list in Settings.`,
      });
    }
    // Past this line `model` is one of OUR catalogue ids, so naming it is safe.
    if (!isBuildLaneAllowed(provider, model)) {
      const canBeMeasured = provider === 'openrouter'
        && typeof llmModule.getLocalQualification === 'function'
        && !llmModule.getLocalQualification(model);
      return res.status(400).json({
        error: `"${model}" has not been measured for building a wiki, so it cannot be the model that ` +
               'runs ingest, Health and Compile. You can still choose it per-conversation in chat.' +
               (canBeMeasured
                 ? ' To use it here, run "Test on my wiki" on its row first — that measures it against ' +
                   `your own pages ${QUALIFY_MIN_RUNS} times and reports what it actually did.`
                 : ' Pick a general-purpose model here instead.'),
        reason: 'not_build_lane',
      });
    }

    const providerBefore = getActiveProvider();
    const stored = setSelectedModel(provider, model);      // write 1 — see order note
    const activeAfter = provider === providerBefore
      ? providerBefore
      : setActiveProvider(provider, { canActivate: providerCanBuild });  // write 2

    // REPORT THE OUTCOME, NOT THE REQUEST. `setActiveProvider` returns the
    // resulting provider and is a no-op when it refuses, so a switch that did
    // not take is visible here rather than being asserted by us — the v3.13.2
    // "report the outcome" rule. A refusal is not an error: the pin landed and
    // is simply still inert, which is strictly the pre-change behaviour.
    let info = null;
    try { info = getProviderInfo(); } catch {}
    // What this provider will ACTUALLY use now — resolved, not assumed.
    const effectiveModel = getDefaultModel(provider);

    // ── `inert` MEANS "THE PIN IS NOT IN FORCE", AND IT HAD ONE BLIND SPOT ───
    // It used to test the provider switch ALONE, so it answered only half the
    // question. `getDefaultModel` resolves LLM_MODEL ahead of the stored pin
    // (documented precedence: per-call > LLM_MODEL > stored > DEFAULTS) and
    // `defaultModelFor` returns that env value with no validation, so with
    // LLM_MODEL set this route replied 200 / `inert: false` — asserting the
    // user's choice was in force — while `effectiveModel` in the same body was
    // a DIFFERENT model, potentially a Gemini id sitting under `anthropic`.
    // A spend surface affirming a pin it is not honouring is this repo's named
    // dead-data shape.
    //
    // THE PRECEDENCE IS DELIBERATELY UNCHANGED. LLM_MODEL is a documented dev
    // override and legitimately wins; validating or ignoring it here would make
    // this route disagree with llm.js about which model runs. The fix is to
    // REPORT the outcome, which is what the surrounding code already does for
    // the provider switch: derive from the resolved values rather than
    // restating the request.
    //
    // AND THE APP ALREADY KNEW THIS. `GET /api-keys` computes
    // `buildModel.selectedHonoured` — "does the STORED pick actually govern?
    // False when LLM_MODEL is overriding it" — with a docblock naming the same
    // dead-data hazard. `pinHonoured` below is that identical question asked of
    // the same two values, so the READ surface and the WRITE surface can no
    // longer disagree about one fact. They did: GET said not honoured while
    // POST replied `inert: false` about the very write that produced it.
    //
    // The two arms are asked in the order the user experiences them — a pin
    // under a provider that never activated is inert whatever the model layer
    // then resolves.
    const providerActive = (info?.provider || null) === provider;
    const pinHonoured = effectiveModel === stored;
    const inertReason = !providerActive ? 'provider-not-active'
      : !pinHonoured ? 'model-overridden'
      : null;

    res.json({
      ok: true,
      provider,
      selectedModel: stored,
      effectiveModel,
      activeProvider: info?.provider || null,
      activeModel:    info?.model || null,
      providerSwitched: activeAfter !== providerBefore,
      // The honest failure modes of this route, named rather than implied away:
      //  provider-not-active — the pin landed but the provider did not move.
      //    Only reachable if `setActiveProvider` refused after our own checks
      //    passed (a key that vanished between the two writes).
      //  model-overridden    — the provider IS active and something ahead of the
      //    stored pin in the precedence chain won. LLM_MODEL is the only cause
      //    that exists today; the test is on the RESOLVED value rather than on
      //    `process.env`, so a future rung is covered without being predicted.
      inert: !providerActive || !pinHonoured,
      // STATED LIMIT: no shipping surface reads `inertReason` yet — the /next
      // Settings view branches on `inert` alone and, for the new arm, shows a
      // remediation hint about the provider key that is imprecise for an env
      // override. That is strictly better than the previous behaviour, which
      // said nothing at all and left the user believing the pin took effect.
      inertReason,
    });
  } catch (err) {
    // Raw `fs` and config errors embed absolute paths — on a real install the
    // user's home directory and their cloud-storage layout — and this body is
    // rendered in Settings and pasted into bug reports. `scrubPaths` is the
    // v3.3.0 scrubber, imported from its single home rather than re-derived;
    // it keeps the basename, which is the half that helps.
    res.status(500).json({ error: scrubPaths(String((err && err.message) || 'Unexpected error')) });
  }
});

// ── OpenRouter catalogue sync ───────────────────────────────────────────────

/**
 * POST /api/config/openrouter/sync
 *
 * Refresh the live OpenRouter chat catalogue: fetch the provider's public model
 * list, run it through the eligibility filter, admit what survives, persist it,
 * and report the funnel that explains every loss.
 *
 * ── THIS ROUTE IS THE MISSING JOIN, AND THAT IS THE WHOLE POINT ─────────────
 * `fetchOpenRouterCatalogue`, `openRouterRecordToSpec` and
 * `setOpenRouterCatalogue` all shipped fully tested with ZERO production
 * callers, so the app offered 3 OpenRouter models out of a catalogue of
 * hundreds. Nothing else in the tree calls the sync; if this handler is deleted
 * the feature silently reverts to that state, which is why the suite asserts on
 * the ROUTE and not merely on the brain function.
 *
 * ── guardConcurrent IS LOAD-BEARING, NOT COPIED FOR SYMMETRY ────────────────
 * A successful sync REPLACES `_openrouterCatalogue` and REBUILDS the dynamic
 * price and free registries wholesale. Mid-ingest that changes what
 * `getProviderInfo` will resolve for the next call and what `chargeForItem`
 * will price the last one at — the same reasoning that put the guard on
 * `/api-keys/model` (a mid-run model change plans the outline on one model and
 * writes Phase-2 batches on another) and on `/api-keys/active`.
 *
 * ── THE KEY GATE IS CONFIG-SCOPED, AND THE KEY IS NEVER SENT ANYWHERE ───────
 * `getApiKeys()`, never `getEffectiveKey()` — the v3.0.13 rule: a provider the
 * user Disconnected in Settings must not be usable, whatever lingers in `.env`.
 * The gate exists because `offerable.openrouter` on GET /api-keys is itself
 * key-gated, so syncing without a saved key would populate state no screen can
 * show.
 *
 * The key is read for TRUTHINESS ONLY and is never passed onward: OpenRouter's
 * `/models` endpoint is public and unauthenticated (verified live 2026-08-27),
 * so no credential enters this code path at all. That is a stronger property
 * than redaction — there is nothing to redact — and the suite asserts it by
 * spying on every outbound request.
 */
router.post('/openrouter/sync', guardConcurrent('sync the OpenRouter model catalogue'), async (_req, res) => {
  try {
    const keys = getApiKeys();
    if (!keys.openrouterApiKey) {
      return res.status(400).json({
        error: 'No OpenRouter key is saved in Settings — connect one before syncing the model list.',
      });
    }
  } catch (err) {
    return res.status(500).json({ error: `Could not read your saved API keys: ${err.message}` });
  }

  if (typeof llmModule.syncOpenRouterCatalogue !== 'function') {
    // Same degradation posture as the namespace import at the top of this file:
    // a missing export must produce a real message, never a bare 500.
    return res.status(500).json({
      error: 'The OpenRouter model sync is unavailable in this build. Restart The Curator, then try again.',
    });
  }

  try {
    const r = await llmModule.syncOpenRouterCatalogue();
    res.json({
      ok: true,
      syncedAt: r.syncedAt,
      total: r.total,
      eligible: r.eligible,
      admitted: r.admitted,
      refused: r.refused,
      // Models the provider lists that we have already hand-measured, so the
      // fetched copy is dropped in favour of the measured one. Reported so the
      // arithmetic on screen adds up without calling our own defaults refused.
      superseded: Number.isFinite(r.superseded) ? r.superseded : 0,
      // False means "this session only" — the models work now but a restart
      // loses them. Surfaced rather than swallowed so the UI can say so.
      persisted: r.persisted !== false,
      funnel: Array.isArray(r.funnel) ? r.funnel : [],
    });
  } catch (err) {
    // A FAILED SYNC HAS ALREADY LEFT THE PREVIOUS CATALOGUE INTACT — nothing is
    // replaced until fetch AND build have both succeeded — so the message says
    // so. Without that sentence a user reads a red error beside a still-working
    // model list and cannot tell which of the two to believe.
    const msg = (err && err.message) ? String(err.message) : 'Unknown error';
    const status = (err && (err.code === 'OPENROUTER_EMPTY_CATALOGUE'
                         || err.code === 'OPENROUTER_NO_ELIGIBILITY'))
      ? 502
      : (Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? 502 : 500);
    res.status(status).json({
      error: msg,
      // The catalogue that is still loaded, so the UI never has to guess whether
      // the failure cost the user their models.
      unchanged: true,
      ...(typeof llmModule.getOpenRouterCatalogueMeta === 'function'
        ? { catalogue: llmModule.getOpenRouterCatalogueMeta() }
        : {}),
    });
  }
});

// ── On-wiki model qualification ─────────────────────────────────────────────

/**
 * Shared preflight for both qualification routes.
 *
 * Every clause is a refusal the user can act on, and the ORDER is chosen so the
 * cheapest and most likely failure is reported first.
 *
 * THE DOMAIN IS VALIDATED BY MEMBERSHIP, NOT BY A REGEX. `wikiPath`/`rawPath`
 * build their paths with a bare `path.join(getDomainsDir(), domain, ...)`, so a
 * `domain` of `../..` would escape. `listDomains()` is the same chokepoint
 * health.js uses (`assertDomain`), and membership in a directory listing is a
 * stronger guarantee than any pattern.
 */
async function preflightQualify(body) {
  const provider = 'openrouter';
  const modelId = body && typeof body.model === 'string' ? body.model : '';
  const domain = body && typeof body.domain === 'string' ? body.domain : '';

  if (!modelId) return { error: 'model is required.', status: 400 };
  // `domain` is OPTIONAL and is resolved below — an earlier version required it
  // here, which made every call from the Settings picker (which sends only a
  // model) fail with "domain is required". Found by driving the real UI, not by
  // reading: the two halves were each correct and disagreed about the contract.

  // CONFIG-SCOPED, never getEffectiveKey/.env — the v3.0.13 rule. A provider the
  // user Disconnected in Settings must not be usable, whatever lingers in .env,
  // and `offerable.openrouter` is gated the same way, so a probe without a saved
  // key would measure a model no screen can offer.
  let keys;
  try { keys = getApiKeys(); } catch (err) {
    return { error: `Could not read your saved API keys: ${err.message}`, status: 500 };
  }
  if (!keys.openrouterApiKey) {
    return { error: 'No OpenRouter key is saved in Settings — connect one before testing a model.', status: 400 };
  }

  // ── THE MODEL MUST BE ELIGIBLE RIGHT NOW ─────────────────────────────────
  // Not "was in some catalogue once". A measurement of a model we do not offer
  // could never be acted on, so taking the user's money and an hour of their
  // time to produce one would be dishonest. Never echoes the caller's string
  // back: this repo has a recorded log-forgery finding from doing exactly that.
  if (!llmModule.isOfferableModel(provider, modelId)) {
    return {
      error: `That model is not in your current OpenRouter model list. Sync the list in Settings, then try again.`,
      status: 400,
    };
  }

  // Measuring a model we have ALREADY hand-measured, or one already in the build
  // lane, is spending for nothing — our verdict governs either way (see
  // isLocallyQualified). Refuse rather than let it run and then quietly not count.
  if (llmModule.isBuildLaneModel(provider, modelId)
      && typeof llmModule.isLocallyQualified === 'function'
      && !llmModule.isLocallyQualified(provider, modelId)) {
    return {
      error: `"${modelId}" is already measured for building your wiki — there is nothing to test.`,
      status: 400,
    };
  }

  let domains;
  try { domains = await listDomains(); } catch (err) {
    return { error: `Could not read your domains: ${err.message}`, status: 500 };
  }
  if (!domains.length) {
    return { error: 'You have no domains yet, so there is no wiki to measure a model against.', status: 400 };
  }

  // ── THE DOMAIN IS OPTIONAL, AND THE DEFAULT IS THE BIGGEST WIKI ──────────
  // A measurement is only worth what its prompt is worth, and the prompt is
  // ~99% the user's own index and slug inventory. Measuring against a nearly
  // empty domain produces exactly the toy probe `docs/model-lifecycle.md`
  // forbids. So when the caller does not name one we pick the domain with the
  // LARGEST index.md — the cheapest available proxy for "most realistic
  // prompt", one stat() per domain rather than a full assembly each.
  //
  // Deliberately NOT `getDefaultDomain()`: that setting means "which domain do
  // MCP write tools assume", which is a different question and is frequently a
  // small scratch domain.
  const chosen = domain || await largestDomainByIndex(domains);
  if (!domains.includes(chosen)) {
    return { error: 'Unknown domain.', status: 404 };
  }

  return { provider, modelId, domain: chosen, apiKey: keys.openrouterApiKey };
}

/**
 * The domain whose index.md is largest. Ties break by name so two calls agree.
 * An unreadable domain counts as 0 rather than failing the request — one bad
 * folder must not make the feature unreachable.
 */
async function largestDomainByIndex(domains) {
  let best = domains[0];
  let bestSize = -1;
  for (const d of domains) {
    let size = 0;
    try { size = (await fsStat(path.join(wikiPath(d), 'index.md'))).size; } catch { size = 0; }
    if (size > bestSize || (size === bestSize && d.localeCompare(best) < 0)) { best = d; bestSize = size; }
  }
  return best;
}

/**
 * Turn a prompt-assembly failure into a message the user can act on.
 *
 * `QUALIFY_NO_SOURCE` and `QUALIFY_DOMAIN_TOO_THIN` are REFUSALS BY DESIGN, not
 * errors: they are how the module keeps its central promise that the probe uses
 * a REAL prompt. Both already carry a full explanation, so they pass through
 * verbatim at 400. Anything else is a genuine failure and gets a 500.
 */
function qualifyPromptStatus(err) {
  return (err && (err.code === 'QUALIFY_NO_SOURCE' || err.code === 'QUALIFY_DOMAIN_TOO_THIN')) ? 400 : 500;
}

/**
 * GET /api/config/openrouter/qualify/estimate?model=<id>&domain=<name>
 *
 * FREE. No network, no LLM, no spend — it assembles the real prompt from the
 * user's own wiki (read-only) and reports what a run would cost in TIME and in
 * MONEY. This is the app's established confirm-before-spend pattern (Health
 * scans and the ingest queue both do it) and it is more load-bearing here than
 * in either, because the cost that hurts is measured in minutes.
 *
 * NOT guarded by guardConcurrent, deliberately: it is a read-only estimate, and
 * refusing it mid-ingest would deny the user the one screen that tells them what
 * a run would cost — the same reasoning `/api-keys/validate` is exempted on.
 */
router.get('/openrouter/qualify/estimate', async (req, res) => {
  const pre = await preflightQualify({ model: req.query.model, domain: req.query.domain });
  if (pre.error) return res.status(pre.status).json({ error: pre.error });

  let prompt;
  try {
    prompt = await assembleProbePrompt(pre.domain);
  } catch (err) {
    return res.status(qualifyPromptStatus(err)).json({ error: err.message, code: err.code || null });
  }

  const runs = QUALIFY_DEFAULT_RUNS;
  // ── FREE AND UNPRICED ARE ASKED SEPARATELY, AND IN THIS ORDER ────────────
  // `getModelPrice` returns null for a FREE model BY DESIGN, so reading price
  // first would report every free model as "cost unknown" — which is the exact
  // defect v3.15.0 found on Health's spend button, where the one model whose
  // cost is known exactly was the one labelled unknown.
  const isFree = typeof llmModule.isFreeModel === 'function'
    ? llmModule.isFreeModel(pre.modelId) : false;
  const price = (!isFree && typeof llmModule.getModelPrice === 'function')
    ? llmModule.getModelPrice(pre.modelId) : null;

  const estimate = estimateQualification({ prompt, runs, modelId: pre.modelId, isFree, price });
  res.json({
    ok: true,
    ...estimate,
    domain: pre.domain,
    sourceName: prompt.sourceName,
    indexChars: prompt.indexChars,
    entityCount: prompt.entityCount,
    conceptCount: prompt.conceptCount,
    // The record this run would REPLACE, if any — so the confirm can say "you
    // already measured this on 28 Aug" rather than letting a user pay twice.
    existing: typeof llmModule.getLocalQualification === 'function'
      ? llmModule.getLocalQualification(pre.modelId)
      : null,
  });
});

/**
 * POST /api/config/openrouter/qualify   (SSE: start | run | done | error)
 *
 * Measure one model against the user's own wiki and store the result.
 *
 * ── guardConcurrent IS LOAD-BEARING ─────────────────────────────────────────
 * A completed run can promote a model into the BUILD LANE, which changes what
 * `resolveProviderDefault` returns for every subsequent ingest, Health scan and
 * Compile call. That is the same hazard `/api-keys/model` is guarded for — a
 * mid-run change plans an outline on one model and writes Phase-2 batches on
 * another — reached through a different door. It also spends the user's key
 * concurrently with whatever is already spending it.
 *
 * ── IT DOES *NOT* registerWrite, AND THAT IS DELIBERATE ────────────────────
 * The probe writes NO wiki page: it assembles a prompt read-only and calls a
 * model. Registering it would hold the process-wide write gate for up to an
 * hour, blocking Sync, Update and Delete — a far worse outcome than the risk it
 * would remove. The accepted consequence is named rather than hidden: a user who
 * starts an ingest during a probe may 429 it, and a 429 is recorded as
 * NOT_MEASURED, which is neither a defect nor a pass.
 *
 * ── CANCELLATION IS A FEATURE, NOT A NICETY ────────────────────────────────
 * Measured per-call latency ranges from 38 s to 382 s, so nine runs is anywhere
 * from ~6 minutes to ~57. A user who cannot abort a run they started by accident
 * will kill the server instead, and this app has a documented history of a stuck
 * operation reading as "my click didn't register". Closing the SSE connection
 * aborts the in-flight call and settles the run as CANCELLED — which is stored
 * as its own outcome and NEVER as a model defect.
 */
router.post('/openrouter/qualify', guardConcurrent('test a model on your wiki'), async (req, res) => {
  const pre = await preflightQualify(req.body || {});
  if (pre.error) return res.status(pre.status).json({ error: pre.error });

  const runs = Number.isFinite(Number(req.body && req.body.runs))
    ? Math.max(1, Math.min(QUALIFY_DEFAULT_RUNS, Math.trunc(Number(req.body.runs))))
    : QUALIFY_DEFAULT_RUNS;

  let prompt;
  try {
    prompt = await assembleProbePrompt(pre.domain);
  } catch (err) {
    return res.status(qualifyPromptStatus(err)).json({ error: err.message, code: err.code || null });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // The client hanging up IS the cancel. There is no separate cancel endpoint,
  // and that is the simpler contract: the connection carrying the progress is
  // the connection that owns the run, so there is no id to get wrong and no way
  // for a cancel to land on somebody else's run.
  const controller = new AbortController();
  let clientGone = false;
  req.on('close', () => { clientGone = true; controller.abort(); });

  try {
    const { record } = await qualifyModel({
      modelId: pre.modelId,
      domain: pre.domain,
      apiKey: pre.apiKey,
      runs,
      prompt,
      signal: controller.signal,
      onProgress: send,
    });

    // ── A CANCELLED RUN IS NOT STORED ───────────────────────────────────────
    // It measured nothing conclusive, and persisting it would overwrite a real
    // earlier measurement with a stub — losing evidence the user already paid
    // for, to record that they changed their mind.
    let stored = null;
    if (!record.cancelled) {
      stored = typeof llmModule.recordLocalQualification === 'function'
        ? llmModule.recordLocalQualification(record)
        : { stored: false, reason: 'unavailable in this build' };
    }

    if (!clientGone) {
      send({
        type: 'stored',
        record,
        stored,
        // Recomputed through the REAL gate rather than re-derived from the
        // counts here: one definition of "may this build", read by the UI and by
        // the pin route alike, so the button the user sees next cannot disagree
        // with the server about whether it will be accepted.
        qualifies: typeof llmModule.isLocallyQualified === 'function'
          ? llmModule.isLocallyQualified(pre.provider, pre.modelId)
          : false,
      });
    }
  } catch (err) {
    if (!clientGone && !isCancelledError(err)) {
      send({ type: 'error', error: (err && err.message) || 'Unknown error', code: (err && err.code) || null });
    }
  } finally {
    res.end();
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
