import { Router } from 'express';
import { existsSync, readFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { getConfig, setDomainsDir, getApiKeys, setApiKeys, clearApiKey, setActiveProvider, getActiveProvider, getDefaultDomain, setDefaultDomain, getSelectedModel, setSelectedModel, getEffectiveKey, getUiState, setUiState, getReleaseChannel, getReleaseRef, getBackgroundMode, setBackgroundMode, backgroundModeNames } from '../brain/config.js';
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
  isUpdateInProgress,
} from '../brain/write-registry.js';
import { APP_ROOT } from '../brain/paths.js';
import { getCapabilities, capabilityRefusal } from '../brain/install-mode.js';
import { getDesktopHook } from '../brain/desktop-host.js';
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

// ── Test seams for the two capability-forked update handlers ────────────────
//
// These two aliases exist so the forked handlers can resolve `execAsync` and
// `fetch` from an INJECTED deps object while every call site inside their
// bodies stays byte-identical to the pre-fork source. The handlers declare
// function-scoped `const execAsync` / `const fetch` that shadow the module
// binding and the global; those consts need a default that is NOT the name
// they shadow (that would be a TDZ reference), hence the aliases.
//
// This is the same shape as compile.js's `opts.generateText` and
// ingestMultiPhase's trailing `llm`: null in production, and the ONLY way an
// offline suite can drive `POST /api/config/update` without running
// `git reset --hard` against the real checkout.
const defaultExec = execAsync;
const defaultFetch = (...args) => globalThis.fetch(...args);

/**
 * What to say when `git` is not on the subprocess PATH.
 *
 * Deliberately duplicated rather than shared with the sibling message in
 * `src/brain/sync.js`: the two name DIFFERENT actions ("update" vs "sync"), and
 * the only part that must not drift is the remedy. `scripts/test-install-mode.js`
 * asserts BOTH carry `xcode-select --install` and that NEITHER can be answered
 * with sync.js's "Repository not found" catch-all.
 */
const GIT_MISSING_MESSAGE =
  'Git is not available to The Curator, so it cannot update itself. ' +
  'On macOS, open Terminal and run `xcode-select --install`, then try again. ' +
  'If git is installed somewhere unusual, launching The Curator from a terminal ' +
  '(`npm start`) will pick up your shell PATH.';

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

/** GET /api/config — returns current app configuration
 *
 * `releaseChannel` is the RESOLVED name, never the raw file value: an absent
 * or unrecognised key reads as `stable` here exactly as it does in the update
 * paths, so this endpoint can never disagree with the ref those actually use.
 * Additive — every pre-existing field keeps its name and meaning.
 *
 * `backgroundMode` is resolved the same way and for the same reason: absent or
 * unrecognised reads as `window`, which is what the desktop shell will
 * actually do, so this endpoint cannot tell the Settings screen one thing
 * while the app does another.
 *
 * `backgroundModes` is the list of legal names, shipped BESIDE the value so
 * the Settings control renders whatever this build understands rather than a
 * hardcoded triple. Same discipline as the text-size presets: adding a mode is
 * one edit in one file and can never leave a control offering an option the
 * server would refuse.
 */
router.get('/', (_req, res) => {
  res.json({
    ...getConfig(),
    defaultDomain: getDefaultDomain(),
    releaseChannel: getReleaseChannel(),
    backgroundMode: getBackgroundMode(),
    backgroundModes: backgroundModeNames(),
  });
});

/**
 * POST /api/config/background-mode — set the app's background/menubar mode.
 * Body: { backgroundMode: 'window' | 'tray' | 'tray-only' }
 *
 * ── DELIBERATELY NOT BEHIND guardConcurrent ────────────────────────────────
 * Following POST /ui-state directly above, and for the same reason rather than
 * by symmetry. The routes in this file that guard do so because they change
 * something an in-flight ingest, sync or update could be READING mid-run —
 * `getDomainsDir()` and `getProviderInfo()` both resolve fresh per call, so a
 * change landing mid-ingest splits a document across two roots or finishes it
 * on a different model.
 *
 * Nothing on any write path reads `backgroundMode`. Its only consumer is the
 * desktop shell, which reads it once before it creates the tray or the window
 * and again when the user flips it. A 409 here would fire precisely while a
 * long ingest is running — i.e. it would refuse to let the user turn off a
 * menu bar icon because the app is busy doing something the icon has no
 * bearing on.
 *
 * Not registered as a write with the write-registry, for the same reason: it
 * would make a Settings save or a Sync refuse while a preference is recorded.
 *
 * ── WHAT BOUNDS THE WRITE ──────────────────────────────────────────────────
 * `setBackgroundMode()`'s allow-list. The value lands in `.curator-config.json`,
 * which holds the user's API keys, so the endpoint accepts three literal
 * strings and refuses everything else — no attacker-chosen string can reach
 * that file through here. Mutating requests also pass server.js's
 * cross-origin guard.
 *
 * A refused value is a 400 that NAMES the legal set, and the body still
 * carries the mode still in force — so a client that renders the response
 * shows the truth even if it ignores the status.
 */
router.post('/background-mode', (req, res) => {
  try {
    const requested = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
      ? req.body.backgroundMode
      : undefined;
    const result = setBackgroundMode(requested);
    if (!result.ok) {
      return res.status(400).json({
        error: `Unknown background mode. Expected one of: ${backgroundModeNames().join(', ')}.`,
        reason: result.reason,
        backgroundMode: result.mode,
        backgroundModes: backgroundModeNames(),
      });
    }
    res.json({ ok: true, backgroundMode: result.mode, backgroundModes: backgroundModeNames() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── Durable UI state (v3.28.0) ──────────────────────────────────────────────
//
// The four pieces of /next state whose loss is a correctness or trust failure
// rather than a per-device inconvenience. See src/brain/config.js's UI_STATE
// section for the triage and for why they live in .curator-config.json.
//
// DELIBERATELY NOT BEHIND guardConcurrent. Every other POST in this file
// guards, and the reason those do is that they change something an in-flight
// ingest, sync or update could be reading. These four fields are read by
// nothing on any write path — they exist only so a browser can remember what
// the user has already been told. A 409 here would fire precisely when the
// user is mid-ingest and the app is trying to record that they dismissed a
// panel, which re-creates the very "the app forgot me" symptom the endpoint
// exists to prevent. The same reasoning src/routes/ingest.js records for
// GET /api/ingest/activity, applied to the write side and stated rather than
// inherited.
//
// It is also NOT registered as a write with the write-registry, for the same
// reason: registering makes a Settings save or a Sync refuse while a dismissal
// is being recorded, which is a much worse trade than the one it buys.
//
// Mutating requests already pass through server.js's cross-origin guard, and
// setUiState()'s allow-list is what stops anything reaching the credential
// file that is not one of five literal strings.

/** GET /api/config/ui-state — the durable UI state, every field always present. */
router.get('/ui-state', (_req, res) => {
  try {
    res.json({ ok: true, ui: getUiState() });
  } catch (err) {
    // Never 500 on a read the client uses to decide whether to re-ask for a
    // consent: an error body with no `ui` makes every consumer fall back to
    // its own documented fail-safe direction, which is the point.
    res.status(200).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/config/ui-state — record durable UI state.
 * Body: a partial map of { field: <literal> }. Unknown fields and values
 * outside the allow-list are refused and NAMED in the response; a recorded
 * consent or provenance verdict is never overwritten.
 */
router.post('/ui-state', (req, res) => {
  try {
    const patch = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const { state, refused } = setUiState(patch);
    res.json({ ok: true, ui: state, refused });
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

/**
 * POST /api/config/pick-folder — ask the user for their knowledge folder.
 *
 * Guarded because this route does NOT merely return a path for the client to
 * submit to /domains-path — it calls setDomainsDir() itself (below), so it is
 * a mutation in its own right and needs the same protection.
 *
 * ── FORKED on `folderPickerStyle` (see src/brain/install-mode.js) ───────────
 *
 * REPO ARM ('osascript') — byte-identical to every version that has shipped.
 * `osascript … choose folder` on the server's own machine.
 *
 * BUNDLE ARM ('native-dialog') — the desktop shell's `pickFolder` hook, from
 * `src/brain/desktop-host.js`. The route can reach Electron's own dialog
 * because `desktop/main.js` imports `src/server.js` INTO THE ELECTRON MAIN
 * PROCESS — one realm, no child, no IPC — which is the fact that makes this a
 * branch rather than a refusal. Read that module's header before changing it.
 *
 * WHY THE BUNDLE ARM DOES NOT KEEP osascript AS A FALLBACK, which is the whole
 * point of forking rather than adding a try/catch: under the hardened runtime
 * notarization requires, a missing `NS*FolderUsageDescription` does not deny
 * the read, it KILLS THE PROCESS. There is no error to catch and fall back
 * from — the app is simply gone, mid-first-run, on the one action an existing
 * user must complete to see a wiki they already have. A refusal that names the
 * typed-path route is recoverable; a dead process is not.
 *
 * ── WHAT BOTH ARMS SHARE, and why that is structural ───────────────────────
 *
 * Everything after a path comes back — existence, the concurrency re-check,
 * the mutation, the response shape — lives in ONE closure below, so the bundle
 * arm cannot acquire a different set of post-pick rules by being written
 * separately. The hook's whole contract is "return a path or null"; it
 * validates nothing and decides nothing.
 *
 * `deps` is the test-only seam: null in production. It is the only way an
 * offline suite can drive this handler without opening a real Finder dialog
 * on the developer's screen or repointing their real knowledge folder.
 */
export async function pickFolderHandler(_req, res, deps = null) {
  const caps = (deps && deps.caps) || getCapabilities();
  const execAsync = (deps && deps.execAsync) || defaultExec;
  const pathExists = (deps && deps.existsSync) || existsSync;
  const busy = (deps && deps.hasActiveWrites) || hasActiveWrites;
  const applyDomainsDir = (deps && deps.setDomainsDir) || setDomainsDir;
  const pickHook = (deps && Object.hasOwn(deps, 'pickFolderHook'))
    ? deps.pickFolderHook
    : getDesktopHook('pickFolder');

  // The ONE set of post-pick rules. Shared by both arms — see the docblock.
  const accept = (picked) => {
    if (picked) {
      if (!pathExists(picked)) {
        return res.status(400).json({ error: `Folder does not exist: ${picked}` });
      }
      // Re-check immediately before the mutation. The middleware above only
      // proves the state at the moment the dialog OPENED, and this dialog
      // blocks for up to 60 s — long enough for the batch-ingest queue to pick
      // up its next item, or for a second tab to start an ingest, while the
      // user is still browsing for a folder. Deliberately NOT merged into the
      // `cancelled` branch: the shipping frontend checks `data.cancelled`
      // BEFORE `res.ok`, so a refusal must never carry that field.
      if (busy()) {
        const { status, body } = conflictResponse('change the knowledge folder');
        return res.status(status).json(body);
      }
      applyDomainsDir(picked);
      res.json({ ok: true, path: picked });
    } else {
      res.json({ cancelled: true });
    }
  };

  if (caps.folderPickerStyle === 'native-dialog') {
    if (typeof pickHook !== 'function') {
      // NOT a fallback to osascript — see the docblock. The hint names the
      // route that has always existed and needs no dialog at all, so the
      // user's first-run task is still completable.
      const { status, body } = capabilityRefusal('folderPickerStyle', 'open a folder picker', {
        folderPickerStyle: caps.folderPickerStyle,
        hint: 'Type or paste the full path to your knowledge folder instead — ' +
              'the Knowledge base field in Settings accepts one directly.',
      });
      return res.status(status).json(body);
    }
    let picked;
    try {
      picked = await pickHook({ prompt: 'Select your Knowledge Base folder:' });
    } catch (err) {
      // Deliberately NOT routed through the osascript classifier below: an
      // exit code and an AppleScript -128 mean nothing here, and reading a
      // shell error's vocabulary onto a native dialog is exactly the
      // mis-reporting that classifier exists to stop.
      return res.status(500).json({
        error: (err && err.message) || 'The folder picker failed.',
        hint: 'The Curator asked the desktop app to show a folder chooser and it ' +
              'reported an error. You can type or paste the full path instead.',
      });
    }
    // A hook that returns null/'' cancelled. Anything else is a path, and goes
    // through exactly the same rules the osascript arm's output does.
    return accept(typeof picked === 'string' ? picked.trim() : '');
  }

  try {
    const { stdout } = await execAsync(
      `osascript -e 'POSIX path of (choose folder with prompt "Select your Knowledge Base folder:")'`,
      { timeout: 60000, env: SUBPROCESS_ENV }
    );
    const picked = stdout.trim();
    accept(picked);
  } catch (err) {
    // A REAL cancel is AppleScript error -128. `osascript` exits 1 on ANY
    // script error, so treating a bare exit-1 as Cancel reports a PERMISSION
    // FAILURE as "the user changed their mind" — the hardest thing to diagnose
    // from a support conversation, and it lands on the one action an existing
    // user must complete on their first screen: pointing the app at their
    // knowledge folder. Under a hardened runtime (which notarization requires)
    // this becomes likely rather than theoretical: a TCC refusal, a missing
    // NSDesktopFolderUsageDescription, or a denied automation prompt all exit 1.
    //
    // So: -128 is a cancel, a timeout is a cancel (the dialog was left open),
    // and an exit-1 carrying any OTHER stderr is an ERROR the user gets to see.
    const stderr = String(err.stderr || '');
    const userCancelled = stderr.includes('-128') || err.killed === true;
    if (userCancelled) {
      res.json({ cancelled: true });
    } else if (err.code === 1 && !stderr.trim()) {
      // Exit 1 with nothing on stderr: no evidence either way. Treat as a
      // cancel rather than inventing an error message, but say which it was.
      res.json({ cancelled: true, inferred: true });
    } else {
      res.status(500).json({
        error: stderr.trim() || err.message,
        hint: 'The folder picker could not run. If The Curator was recently ' +
              'installed or moved, macOS may be blocking folder access — check ' +
              'System Settings > Privacy & Security > Files and Folders.',
      });
    }
  }
}

// Registered by reference and with NO deps — the seam is null in production.
router.post('/pick-folder', guardConcurrent('change the knowledge folder'),
  (req, res) => pickFolderHandler(req, res));

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
    // shipping pre-redesign frontend's first-run check used to read exactly
    // these two — that shell (reachable at /old, `src/public/app.js`) was
    // deleted in v3.41.0 and /old now just redirects to / — but the field
    // names stay pinned to what any client, present or future, would
    // reasonably expect: their absence would make a first-run check believe
    // no key is configured and re-fire onboarding for an already-configured
    // user, which was the shape of the historical /old defect this guards
    // against. hasOpenrouterKey is purely ADDITIVE beside them.
    hasGeminiKey:     !!keys.geminiApiKey,
    hasAnthropicKey:  !!keys.anthropicApiKey,
    hasOpenrouterKey: !!keys.openrouterApiKey,
    activeProvider:  provider?.provider || null,
    activeModel:     provider?.model || null,
    // Current default model id per provider, so the chat model selector's label
    // stays in sync with DEFAULTS automatically when we bump to a newer model.
    //
    // DELIBERATELY a { gemini: '<id>', anthropic: '<id>' } map of STRINGS ONLY —
    // never touch this shape. The shipping pre-redesign frontend (src/public/app.js,
    // `chat-dd-opt-desc` in the model-selector dropdown) used to render it as
    // `escHtml(models[p] || '')`, and `escHtml` starts with `String(str)` — so
    // an object or array here would have rendered the literal text
    // "[object Object]" in production for every user on that shell. That shell
    // (reachable at /old) was deleted in v3.41.0 and /old now just redirects
    // to /, but the shape stays pinned for whatever client reads it next. The
    // new offerable catalogue below is deliberately a SEPARATE, additive field
    // for exactly this reason.
    //
    // v3.15.0: `openrouter` is added as a third STRING-OR-NULL entry. Two facts
    // made that safe for /old while it was still live, and both were checked
    // rather than assumed:
    // (a) /old never enumerated this map — it built its own provider list from
    //     hasGeminiKey/hasAnthropicKey and only ever indexed models[p] for those
    //     two, so a third key was invisible there. /old therefore would not have
    //     offered OpenRouter at all, which was the documented limit at the time.
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
    // like `offerable`, and ADDITIVE — the pre-redesign shell (deleted in
    // v3.41.0; /old now redirects to /) used to read only `models` and the
    // `hasXKey` booleans and ignore unknown fields (the v3.12.0 precedent that
    // added `offerable` itself), a pattern kept here for whatever other client
    // reads this response.
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
    // Key-gated exactly like `offerable`, and ADDITIVE (the pre-redesign shell,
    // deleted in v3.41.0 — /old now redirects to / — used to read `models`
    // plus the hasXKey booleans and ignore unknown fields).
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
 * Store a finished qualification, EXCEPT where storing it would destroy better
 * evidence than it carries.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `runs` on this endpoint clamps to `[1, QUALIFY_DEFAULT_RUNS]`, the store keeps
 * exactly ONE record per model id (`_localQualifications.set`), and
 * `isPassingRecord` needs `runsCompleted >= QUALIFY_MIN_RUNS` — which is 9. So
 * `{"runs": 3}` spent real money on a measurement that could never qualify AND
 * OVERWROTE a stored 9-run pass, silently demoting a model out of the build
 * lane. The user paid twice: once for the nine runs, once for the three that
 * destroyed them.
 *
 * ── WHY THE GUARD IS HERE AND NOT A 400 ON `runs < QUALIFY_MIN_RUNS` ────────
 *
 * Refusing short runs would contradict the contract this feature is built on.
 * `openrouter-qualify.js` states it in its own words: *"FEWER RUNS ARE RECORDED
 * BUT QUALIFY NOTHING. A 2-run record is a real measurement of something (the
 * plumbing works, the model answered) and is displayed honestly with its run
 * count; it simply does not satisfy `isPassingRecord`."* A short run is a
 * legitimate, cheaper thing to ask for. What is not legitimate is letting it
 * erase a longer one.
 *
 * The precedent is thirty lines below, in this same handler, in the same words:
 * a cancelled run is not stored because *"persisting it would overwrite a real
 * earlier measurement with a stub — losing evidence the user already paid for"*.
 * This is that rule applied to the case that reaches it through a body field
 * rather than through a closed connection.
 *
 * ── THE RULE, AND WHAT IT DELIBERATELY DOES NOT BLOCK ───────────────────────
 *
 * A stored PASSING record is never replaced by one with FEWER completed runs.
 * That is the whole rule, and it is stated in runs rather than in outcomes so
 * that a full-length run showing a DEFECT still lands: **equal** run counts
 * overwrite. Demotion on real evidence must stay possible — the asymmetry this
 * feature rests on is that a false acceptance is worse than a false rejection,
 * and blocking a 9-run defect report would invert it.
 *
 * A refused store is REPORTED, never silent: the `stored` field carries
 * `{stored: false, reason}` and the SSE `stored` frame already forwards it, so
 * the caller learns that its short run measured something and changed nothing.
 */
export function storeQualification(record) {
  if (typeof llmModule.recordLocalQualification !== 'function') {
    return { stored: false, reason: 'unavailable in this build' };
  }
  const existing = typeof llmModule.getLocalQualification === 'function'
    ? llmModule.getLocalQualification(record && record.modelId)
    : null;
  const existingPasses = existing
    && typeof llmModule.isPassingRecord === 'function'
    && llmModule.isPassingRecord(existing);
  if (existingPasses) {
    const wasRuns = Number(existing.runsCompleted);
    const nowRuns = Number(record && record.runsCompleted);
    if (Number.isFinite(wasRuns) && Number.isFinite(nowRuns) && nowRuns < wasRuns) {
      return {
        stored: false,
        reason: `kept the existing ${wasRuns}-run measurement, which qualifies this model; `
              + `a ${nowRuns}-run test cannot qualify anything and would have replaced it. `
              + `Run the full ${QUALIFY_MIN_RUNS}-run test to change the stored result.`,
        keptExisting: true,
        existingRuns: wasRuns,
      };
    }
  }
  return llmModule.recordLocalQualification(record);
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
      stored = storeQualification(record);
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

/**
 * Compare two dotted version strings. >0 if `a` is newer, <0 if older, 0 if
 * equal OR UNCOMPARABLE.
 *
 * This is a deliberate, byte-for-byte port of `compareSemver` in
 * `src/public/next/views/settings.js`. The two MUST agree, because /next
 * applies its own local-ahead guard on top of this route's verdict and a
 * disagreement would produce a UI that contradicts itself — so the algorithm
 * is copied rather than re-derived. (It is not imported: that file is browser
 * ESM served to the client and this is a server route; the ~20 lines are
 * cheaper than a shared browser/server module for one function. The guard
 * suite asserts the two implementations agree on a shared table.)
 *
 * "Uncomparable collapses to 0" is the fail-safe direction: a positive result
 * SUPPRESSES the update offer, so guessing "local is newer" from a string we
 * could not parse would hide a real, wanted update. Falling to 0 leaves the
 * pre-existing commit comparison in charge — i.e. the old behaviour.
 *
 * Only the numeric core is compared, so a pre-release suffix (the retired
 * `3.0.1-beta.27` line) makes the cores equal and returns 0.
 */
/**
 * The parse half of `compareSemver`, LIFTED OUT rather than copied.
 *
 * It was an inner arrow function until the installer update path needed to ask
 * a question `compareSemver` structurally cannot answer: *is this version
 * string comparable at all?* The comparator collapses UNPARSEABLE and EQUAL to
 * the same `0` — deliberately, and the reasoning is directly below — so a
 * caller that needs "we cannot compare these" as a distinct outcome from "they
 * are the same" has to see the parse itself. That is this repo's own rule that
 * a fact and its ABSENCE are never the same value (v3.15.0), applied to the
 * comparator rather than around it.
 *
 * Lifted, NOT duplicated: a second copy of a version parser is the shape that
 * produced the two-copies-of-a-money-constant finding in v3.27.0.
 * `compareSemver`'s BEHAVIOUR is unchanged by the extraction, and that is
 * proven rather than asserted — `scripts/test-update-installer.js` §2 runs
 * HEAD's comparator and this one over the same matrix and requires every cell
 * to agree.
 *
 * Returns `number[]` (1–4 numeric segments) or `null`.
 */
export function parseVersionCore(v) {
  if (typeof v !== 'string') return null;
  const core = v.trim().split('-')[0].split('+')[0];
  const parts = core.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

/** True when `parseVersionCore` can read this string — i.e. when a comparison
 *  against it MEANS something. The only honest way to tell `compareSemver`'s
 *  "equal" apart from its "I could not parse that". */
export function isComparableVersion(v) {
  return parseVersionCore(v) !== null;
}

export function compareSemver(a, b) {
  const parse = parseVersionCore;
  const av = parse(a), bv = parse(b);
  if (!av || !bv) return 0;
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] || 0, y = bv[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * The update verdict, as a pure function — DOM-free, fetch-free, exported so
 * the guard suite executes it directly instead of asserting on the shape of
 * the source that calls it (v3.0.17's rule).
 *
 * ── The bug this fixes ───────────────────────────────────────────────────
 *
 * This route used to compute `const versionDiffers = latest !== current` — a
 * PLAIN INEQUALITY, which is true in BOTH directions. A checkout whose local
 * version is AHEAD of the published one (a release committed but not yet
 * pushed — the maintainer's own routine state) therefore reported
 * `updateAvailable: true`, and the button behind that verdict runs
 * `git reset --hard origin/main`: a DOWNGRADE, offered as an update.
 *
 * `/next` added a client-side guard for exactly this (`classifyUpdate`'s
 * 'local-ahead' arm). The pre-redesign shell (`/old`, `src/public/app.js`,
 * deleted in v3.41.0 — `/old` now just redirects to `/`) had NO guard at
 * all — it read `data.updateAvailable` and offered the button. So the
 * verdict was wrong at source and only one of the two frontends papered
 * over it.
 *
 * ── Why the commit comparison is subordinated rather than kept ───────────
 *
 * `commitsDiffer` alone is the LEGITIMATE case that must keep working: same
 * version, new commits on main, so pull them. But when the local version is
 * strictly newer, the commits differ BY CONSTRUCTION (that is what being
 * ahead means), so leaving `|| commitsDiffer` in place would have left the
 * defect fully intact in the exact state that triggers it. `localAhead`
 * therefore vetoes, and only there.
 *
 * ── Why `versionDiffers` is not simply `cmp < 0` ────────────────────────
 *
 * `compareSemver` returns 0 for EQUAL **and** for UNCOMPARABLE, and those are
 * different facts. A first draft used `cmp < 0` alone; a 24-cell A/B against
 * the pre-change expression then showed **12** cells changing rather than the
 * 6 that were intended. The extra six were `nightly` vs `3.25.0`, and
 * `3.0.1-beta.27` vs `3.0.1`, with matching or unknown commits: the old code
 * offered an update (the strings differ) and the draft SUPPRESSED it. That is
 * the harmful direction — hiding a real, wanted update behind a version string
 * the comparator could not parse.
 *
 * So an uncomparable-or-equal pair falls back to the ORIGINAL string
 * inequality. With that, the A/B changes exactly the six local-ahead cells and
 * nothing else. (Both of those inputs are near-unreachable in production —
 * `current` and `latest` both come from a `package.json` — but "unreachable"
 * is not a reason to ship the wrong fallback direction.)
 *
 * `localAhead` is returned rather than folded away because `updateAvailable:
 * false` now covers two different situations — "you are current" and "you are
 * ahead of what is published" — and a client that cannot tell them apart
 * would report the second as the first.
 */
export function decideUpdateAvailable({ current, latest, localCommit, remoteCommit }) {
  const cmp = compareSemver(current, latest);
  const localAhead = cmp > 0;
  const versionDiffers = cmp < 0 || (cmp === 0 && latest !== current);
  const commitsDiffer = Boolean(localCommit && remoteCommit && localCommit !== remoteCommit);
  return {
    updateAvailable: !localAhead && (versionDiffers || commitsDiffer),
    localAhead,
    versionDiffers,
    commitsDiffer,
  };
}

// ── The download-installer update path (bundle installs) ───────────────────
//
// ── THE DEFECT THIS EXISTS FOR ─────────────────────────────────────────────
//
// A user who installed the DMG clicked Settings → "Check for updates" and got
// a RED status box reading:
//
//     Couldn’t check for updates
//     Cannot check for updates in this build of The Curator (Packaged app).
//     This install does not have the "canSelfUpdateViaGit" capability.
//
// — because `updateCheckHandler` refused on the capability and `/next`'s
// `classifyUpdate` maps any `error` field to its failure box. So the app both
// looked broken and named an internal identifier at the user. That is the
// whole reason this arm is written; it is not a new feature so much as the
// missing other half of the v3.26.0 fork.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
//
// It does not download and it does not install. electron-updater / Squirrel.Mac
// need the paid Apple Developer enrolment and a signed, notarized app, and
// neither exists — the first DMGs ship with auto-update DISABLED by decision.
// There is therefore no half-wired field here for a downloader to fill in
// later: the contract is "tell the user, and open the page".
//
// ── WHY THE `latest` RELEASE IS NOT `/releases/latest` ─────────────────────
//
// GitHub's `/releases/latest` returns the newest release that is neither a
// draft nor a PRE-RELEASE. Measured against the live API on 2026-08-31:
//
//     GET /releases/latest   ->  v3.9.0   prerelease:false   assets: []
//     GET /releases          ->  5 releases; exactly ONE carries a .dmg:
//                                v3.30.0  prerelease:TRUE    2 assets
//
// So `/releases/latest` would have (a) compared a v3.30.0 DMG user against
// v3.9.0 and told them they were AHEAD of the published version, forever, and
// (b) if it had ever offered anything, pointed them at a release page with
// nothing to download. The feature would have been dead on arrival, and dead
// in the silent direction.
//
// The selection rule is therefore: **the newest release that actually carries
// an installer asset**, pre-release or not. That is the question the user is
// asking — *what is the newest version I can install?* — and the pre-release
// status is DISCLOSED in the UI rather than hidden, because today the only way
// to have the Mac app at all is an unsigned preview build. When signed stable
// DMGs start shipping they become the newest installable release on their own,
// with no code change here.
//
// A release with no installer asset is skipped rather than reported: there is
// nothing for the user to do with it. Drafts are filtered defensively — an
// unauthenticated request cannot see them anyway.
//
// ── THE RELEASE CHANNEL ────────────────────────────────────────────────────
//
// `stable` is the only channel this build defines and it maps to a git BRANCH,
// which means nothing to a release listing. The resolved channel name is
// carried on the wire so the answer stays inspectable, and `getReleaseRef()`
// is called for the same fail-safe resolution the git arm gets — but the
// selection rule above is channel-independent today. THE DAY A SECOND CHANNEL
// EXISTS, THIS IS ONE OF THE TWO SITES THAT MUST GAIN A BRANCH (the other is
// the `git fetch` refspec, whose trap is written up in src/brain/config.js).
// `scripts/test-update-installer.js` §7 fails if `releaseChannelNames()` ever
// returns more than one name without this site changing.

/** Where the release listing is read from. One call, unauthenticated, no user
 *  data of any kind — not in a header, not in a query string. `per_page=30` is
 *  GitHub's default page size and comfortably covers a repo with five
 *  releases; the newest installable one is selected by SEMVER over the page
 *  rather than by trusting the listing's order. */
export const RELEASES_API_URL =
  'https://api.github.com/repos/talirezun/the-curator/releases?per_page=30';

/** Where the user is sent when there is nothing more specific to open. */
export const RELEASES_PAGE_URL = 'https://github.com/talirezun/the-curator/releases';

/** A fixed, content-free User-Agent. GitHub's API requires one; this carries no
 *  version, no hostname and nothing else that could identify an install. */
export const RELEASES_USER_AGENT = 'the-curator-update-check';

/** How long to wait before calling it unreachable. */
export const RELEASES_TIMEOUT_MS = 8000;

/** What counts as "you can install this". macOS-only today, which is also the
 *  only platform the packaged app ships for; a Windows/Linux installer would
 *  add its own extension here AND need a platform argument, so this is
 *  deliberately a list rather than a single literal. */
export const INSTALLER_ASSET_EXTENSIONS = Object.freeze(['.dmg']);

function hasInstallerAsset(release) {
  const assets = release && Array.isArray(release.assets) ? release.assets : [];
  return assets.some((a) => {
    const name = a && typeof a.name === 'string' ? a.name.toLowerCase() : '';
    return INSTALLER_ASSET_EXTENSIONS.some((ext) => name.endsWith(ext));
  });
}

/** `v3.30.0` → `3.30.0`. A leading `v` is the only thing stripped; anything
 *  else is handed to the comparator as-is so an odd tag surfaces as
 *  "not comparable" rather than being silently coerced. */
export function versionFromTag(tagName) {
  if (typeof tagName !== 'string') return null;
  const t = tagName.trim();
  if (!t) return null;
  return /^v\d/.test(t) ? t.slice(1) : t;
}

/**
 * Pure. Given whatever GitHub returned, pick the newest release the user could
 * actually install, or `null`.
 *
 * Defensive about the shape at every step (rule: an unexpected response
 * degrades, it never throws): a non-array, a member that is not an object, a
 * missing `assets`, a missing `tag_name` and a missing `html_url` are all just
 * "not a candidate".
 *
 * Ordering is by SEMVER, not by the listing's order or by `published_at`.
 * GitHub does return newest-first, but a re-published or back-dated release
 * would then decide which version the user is offered, and the listing's order
 * is not part of any contract worth depending on. Ties (identical comparable
 * cores) keep the earlier entry, i.e. GitHub's own newest-first order.
 * A release whose tag is not comparable can still WIN if nothing comparable
 * exists — the caller reports that as a distinct "cannot compare" outcome
 * rather than as "up to date".
 */
export function pickInstallableRelease(releases) {
  if (!Array.isArray(releases)) return null;
  const candidates = [];
  for (const r of releases) {
    if (!r || typeof r !== 'object') continue;
    if (r.draft === true) continue;
    if (!hasInstallerAsset(r)) continue;
    const version = versionFromTag(r.tag_name);
    if (!version) continue;
    candidates.push({
      version,
      tagName: String(r.tag_name),
      prerelease: r.prerelease === true,
      name: typeof r.name === 'string' && r.name ? r.name : String(r.tag_name),
      url: typeof r.html_url === 'string' && /^https:\/\/github\.com\//.test(r.html_url)
        ? r.html_url
        : RELEASES_PAGE_URL,
      publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    });
  }
  if (candidates.length === 0) return null;
  const comparable = candidates.filter((c) => isComparableVersion(c.version));
  const pool = comparable.length ? comparable : candidates;
  let best = pool[0];
  for (const c of pool.slice(1)) {
    if (compareSemver(c.version, best.version) > 0) best = c;
  }
  return best;
}

/**
 * Pure. The verdict for the installer path.
 *
 * NOT `decideUpdateAvailable`, and the difference is the point. That function
 * has a commit dimension and a deliberate STRING-INEQUALITY fallback for
 * uncomparable versions, because on the git path an uncomparable pair still
 * has `commitsDiffer` to fall back on and suppressing the offer would hide a
 * real update. Here there are no commits and the offer is a DOWNLOAD LINK, so
 * a string inequality would happily present a sideways move (`3.30.0` vs
 * `3.30.0-rc1`, equal cores, different strings) as an update.
 *
 * So this path has THREE outcomes rather than two, and they never share
 * wording downstream:
 *
 *   comparable:false          we cannot tell — a release exists, its version
 *                             cannot be read
 *   updateAvailable:true      a newer installable version exists
 *   localAhead:true           you are running something newer than anything
 *                             published; nothing to install
 *   otherwise                 you are on the newest installable version
 */
export function decideInstallerUpdate({ current, latest }) {
  const comparable = isComparableVersion(current) && isComparableVersion(latest);
  if (!comparable) {
    return { comparable: false, updateAvailable: false, localAhead: false };
  }
  const cmp = compareSemver(current, latest);
  return { comparable: true, updateAvailable: cmp < 0, localAhead: cmp > 0 };
}

/**
 * Pure. Turn an upstream failure into `{ status, body }`.
 *
 * Every arm here carries a `reason` code AND a sentence the user can act on,
 * and NONE of them can be mistaken for "you are up to date": the body has an
 * `error` field, which is what both frontends key their failure box on, and
 * carries no `updateAvailable` at all rather than a reassuring `false`.
 */
export function classifyReleaseFailure(kind, statusCode, headers) {
  const get = (h) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(h);
    return headers[h] ?? null;
  };
  if (kind === 'network') {
    return {
      status: 502,
      body: {
        error: 'Could not reach GitHub to check for a new version. Check your internet connection and try again.',
        reason: 'unreachable',
      },
    };
  }
  if (kind === 'http') {
    // GitHub answers an exhausted unauthenticated quota with 403 (older) or
    // 429 (newer) AND `x-ratelimit-remaining: 0`. The remaining header is what
    // separates it from an ordinary refusal, so it is read rather than assumed
    // from the status code alone.
    const remaining = get('x-ratelimit-remaining');
    if ((statusCode === 403 || statusCode === 429) && String(remaining) === '0') {
      return {
        status: 502,
        body: {
          error: 'GitHub is rate-limiting update checks from this network. It clears within an hour — ' +
                 'try again later, or check the releases page directly.',
          reason: 'rate-limited',
          releasesPageUrl: RELEASES_PAGE_URL,
        },
      };
    }
    return {
      status: 502,
      body: {
        error: `GitHub answered ${statusCode} when asked for the release list. Try again later, ` +
               'or check the releases page directly.',
        reason: 'http-error',
        releasesPageUrl: RELEASES_PAGE_URL,
      },
    };
  }
  return {
    status: 502,
    body: {
      error: 'GitHub’s release list could not be read — the response was not in the expected form. ' +
             'Check the releases page directly.',
      reason: 'unexpected-response',
      releasesPageUrl: RELEASES_PAGE_URL,
    },
  };
}

/**
 * The `updateStyle: 'download-installer'` arm of `GET /api/config/update-check`.
 *
 * Read-only, one unauthenticated network call, no subprocess, no write. Split
 * out as its own function rather than inlined so the guard suite can drive it
 * without going anywhere near the git arm.
 */
async function installerUpdateCheck(res, deps) {
  const fetchImpl = (deps && deps.fetch) || defaultFetch;
  const { channel } = (deps && deps.releaseRef) || getReleaseRef();

  let current;
  try {
    current = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;
  } catch (err) {
    return res.status(500).json({ error: err.message, reason: 'local-version-unreadable' });
  }

  let response;
  try {
    response = await fetchImpl(RELEASES_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': RELEASES_USER_AGENT },
      signal: AbortSignal.timeout(RELEASES_TIMEOUT_MS),
    });
  } catch {
    // The caught error is deliberately not read, let alone echoed: it carries
    // nothing a user can act on beyond "we couldn't reach it", and not
    // touching it is the strongest guarantee nothing derived from the request
    // reaches the response. Same rule as the OpenRouter key validator above.
    const f = classifyReleaseFailure('network');
    return res.status(f.status).json({ ...f.body, current, updateStyle: 'download-installer', channel });
  }

  if (!response || !response.ok) {
    const f = classifyReleaseFailure('http', response && response.status, response && response.headers);
    return res.status(f.status).json({ ...f.body, current, updateStyle: 'download-installer', channel });
  }

  let payload;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!Array.isArray(payload)) {
    const f = classifyReleaseFailure('shape');
    return res.status(f.status).json({ ...f.body, current, updateStyle: 'download-installer', channel });
  }

  const release = pickInstallableRelease(payload);

  // NOT an error, and NOT "you are up to date": no installable build has been
  // published at all. Three different facts, three different answers.
  if (!release) {
    return res.json({
      current,
      latest: null,
      updateAvailable: false,
      localAhead: false,
      comparable: false,
      noInstallableRelease: true,
      updateStyle: 'download-installer',
      channel,
      releaseUrl: RELEASES_PAGE_URL,
      releasesPageUrl: RELEASES_PAGE_URL,
      releaseName: null,
      prerelease: false,
      publishedAt: null,
      localCommit: null,
      remoteCommit: null,
    });
  }

  const verdict = decideInstallerUpdate({ current, latest: release.version });
  return res.json({
    current,
    latest: release.version,
    updateAvailable: verdict.updateAvailable,
    localAhead: verdict.localAhead,
    comparable: verdict.comparable,
    noInstallableRelease: false,
    updateStyle: 'download-installer',
    channel,
    releaseUrl: release.url,
    releasesPageUrl: RELEASES_PAGE_URL,
    releaseName: release.name,
    releaseTag: release.tagName,
    prerelease: release.prerelease,
    publishedAt: release.publishedAt,
    // Explicitly null rather than absent: `/next` renders a commit pair when
    // the versions match, and an ABSENT field and a null one read the same to
    // it — but a future client should see that this path has no commit
    // dimension at all, rather than infer it from a missing key.
    localCommit: null,
    remoteCommit: null,
  });
}

/** GET /api/config/update-check — compare local vs remote version AND git commit
 *
 * FORKED on `canSelfUpdateViaGit` (see src/brain/install-mode.js). The repo arm
 * below is the pre-fork body, unchanged — the capability check is an EARLY
 * RETURN above it, so `git diff -w` on this hunk is pure insertion rather than
 * a reindent. A build that cannot self-update must not report an update as
 * available: the button that would follow cannot work, and the honest answer is
 * "this build updates a different way", not "up to date".
 *
 * `deps` is the test-only seam (see defaultExec/defaultFetch above): null in
 * production, so both `execAsync` and `fetch` resolve exactly as before.
 */
export async function updateCheckHandler(_req, res, deps = null) {
  const caps = (deps && deps.caps) || getCapabilities();
  // FORK ONE — `updateStyle`: how does this install RECEIVE a new version?
  // Checked FIRST, and above the git capability, because it is the question
  // that has an answer for every install form; `canSelfUpdateViaGit` only says
  // what one of them cannot do. In repo mode `updateStyle` is 'git-pull', so
  // control falls straight through and every line below is reached with the
  // same inputs it always was.
  if (caps.updateStyle === 'download-installer') {
    return installerUpdateCheck(res, deps);
  }
  // FORK TWO — unchanged. Still reachable, and still the right answer for an
  // install that can neither pull nor be replaced by an installer (the
  // git-less tarball drop this table exists to make someone decide about).
  if (!caps.canSelfUpdateViaGit) {
    const { status, body } = capabilityRefusal('canSelfUpdateViaGit', 'check for updates', {
      updateAvailable: false,
      hint: 'Packaged builds update through the app’s own updater, not this checkout-only git flow.',
    });
    return res.status(status).json(body);
  }
  const execAsync = (deps && deps.execAsync) || defaultExec;
  const fetch = (deps && deps.fetch) || defaultFetch;
  // The ref this install tracks. `stable` resolves to `main`, so both URLs
  // below are byte-identical to the hardcoded ones they replaced — the
  // acceptance criterion for the release-channel change, pinned by
  // scripts/test-release-channel.js against the literals recorded from the
  // pre-change handler. An absent or unrecognised channel resolves to
  // `stable` inside getReleaseRef, so this line cannot yield an empty or
  // attacker-chosen path segment.
  const { channel, branch } = (deps && deps.releaseRef) || getReleaseRef();
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
      'https://raw.githubusercontent.com/talirezun/the-curator/' + branch + '/package.json'
    );
    if (!response.ok) throw new Error('Could not reach GitHub');
    const remote = await response.json();
    const latest = remote.version;

    // Get remote git commit hash
    let remoteCommit = null;
    try {
      const commitRes = await fetch(
        'https://api.github.com/repos/talirezun/the-curator/commits/' + branch,
        { headers: { 'Accept': 'application/vnd.github.v3.sha' } }
      );
      if (commitRes.ok) {
        const sha = await commitRes.text();
        remoteCommit = sha.trim().slice(0, 7);
      }
    } catch { /* GitHub API unavailable — fall back to version comparison only */ }

    const verdict = decideUpdateAvailable({ current, latest, localCommit, remoteCommit });

    // `channel` and `branch` are ADDITIVE — every field above keeps its name,
    // type and meaning, so a client written before this release reads the same
    // payload it always did. They are here so the resolved channel is
    // INSPECTABLE (a support answer, and the only way to tell "resolved to
    // stable because the key is absent" from "resolved to stable because the
    // key said something this build has never heard of" is to see the resolved
    // value beside the raw file). There is deliberately no control that writes
    // it — see the release-channel block in src/brain/config.js.
    res.json({
      current,
      latest,
      localCommit,
      remoteCommit,
      updateAvailable: verdict.updateAvailable,
      localAhead: verdict.localAhead,
      channel,
      branch,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

router.get('/update-check', (req, res) => updateCheckHandler(req, res));

// ── The IN-APP update path (bundle installs with a desktop updater attached) ─
//
// ── WHAT CHANGED AND WHY ───────────────────────────────────────────────────
//
// v3.31.0 shipped the bundle arm of `GET /update-check` as CHECK-AND-TELL: it
// finds the newest release carrying an installer and opens the download page.
// That was the right call while nothing could download or verify anything. The
// maintainer then updated v3.31.0 -> v3.32.0 by hand and called the experience
// "terrible":
//
//     "update the app in the app itself like it is done for professional apps.
//      When you click update, some progress bar shows that you download the
//      app, and then the app restarts and that's it."
//
// The download / verify / stage / swap / relaunch engine lives in the DESKTOP
// SHELL, not here — it needs Electron's own process, filesystem and relaunch.
// It reaches this process through `src/brain/desktop-host.js`, the plain module
// registry that works because `desktop/main.js` imports `src/server.js` into
// the Electron main process: one Node realm, no IPC. Read that module's header
// before changing anything below.
//
// THIS ROUTE OWNS EXACTLY THREE THINGS and deliberately nothing else:
//   1. the capability fork, so repo mode is untouched;
//   2. the refusals — write-in-flight, no engine attached, nothing staged;
//   3. turning the engine's progress into an SSE stream, and its NAMED
//      failure reasons into sentences a non-developer can act on.
//
// ── THE CONTRACT WITH THE ENGINE ───────────────────────────────────────────
//
// Two hooks, because staging and swapping are different decisions:
//
//   prepareUpdate({ onProgress, signal })
//       Resolves, downloads, verifies and STAGES. Replaces nothing. Resolves
//       {ok:true, token, version, current, bytes, verifiedDigest, prerelease,
//       warning} — or {ok:false, reason, message}. A FAILURE IS A RESOLVED
//       VALUE, not a rejection. A rejection is still handled below, as an
//       engine-contract violation rather than as an expected outcome.
//
//   installUpdate({ token, onProgress }) -> Promise<never>
//       Swaps the staged bundle in and relaunches. Not expected to return.
//
// ── THE TOKEN IS OPAQUE, AND THAT IS A SECURITY PROPERTY ───────────────────
//
// `installUpdate` takes the token `prepareUpdate` produced and NEVER a path.
// This route's caller is a RENDERER: a hook accepting {stagedPath, targetPath}
// would be a "replace any directory with any other" primitive reachable from a
// page. So the token is stored on the job, passed straight back, and NEVER put
// on the wire — `updateJobToWire()`'s allow-list is what enforces that, and the
// suite asserts it. No filesystem path is constructed, logged or rendered
// anywhere on these paths.
//
// ── WHAT `signal` IS FOR, AND WHY IT IS NEVER FIRED HERE ───────────────────
//
// The hook accepts one, so a real AbortSignal is passed rather than undefined,
// and the engine's own guards see a well-formed object. This route NEVER
// aborts it — see the navigate-away argument below. That is a deliberately
// quiescent parameter with its reason written down, not a half-wired cancel:
// there is no cancel, and nothing here pretends otherwise.
//
// SPLITTING THEM IS THE FEATURE, not tidiness. A single hook would make the
// window vanish mid-progress with no way to say "ready — restarting now", and
// would relaunch the app out from under an ingest that started during the
// download. The split lets the second step be re-checked against
// `hasActiveWrites()` at the moment it actually matters.
//
// ── WHY THE CLIENT HANGING UP DOES *NOT* CANCEL ────────────────────────────
//
// `POST /openrouter/qualify` in this same file takes the opposite position —
// "the client hanging up IS the cancel" — and that is right there, because the
// run costs money per call and produces nothing until it finishes.
//
// It would be wrong here. A 140 MB download that dies because the user clicked
// Chat is a worse outcome than one that finishes unwatched: the bytes are free
// to keep, the work is resumable by nobody, and the user asked for it. So the
// stream is a VIEW of the job, not the job itself. Navigating away, or
// reloading the page outright, leaves the download running; `GET
// /update-progress` is how a returning client finds it again.
//
// The consequence is stated rather than hidden: there is no cancel. Adding one
// means an engine-side abort signal, which is the engine's to own.

/** The hook names this route asks `desktop-host.js` for.
 *
 *  CONSTANTS RATHER THAN LITERALS because they are a CONTRACT ACROSS TWO
 *  FILES this route does not own. `getDesktopHook()` returns null for a name
 *  that is not in its own frozen list, so a mismatch fails in the safe
 *  direction — the route refuses with `no-updater`, names it, and points the
 *  user at the download page they have always had. It cannot half-work. */
export const UPDATE_STAGE_HOOK = 'prepareUpdate';
export const UPDATE_APPLY_HOOK = 'installUpdate';

/** The phases the engine may report, in order.
 *
 *  This is the OUTER RING'S SEGMENT LIST as well as a validation set — the UI
 *  renders one segment per phase — so the order is load-bearing and the list is
 *  frozen. An unrecognised phase name is IGNORED rather than displayed: the UI
 *  has one sentence per phase and no sentence for a name nobody wrote, and a
 *  progress display that renders a phase it cannot describe is worse than one
 *  that keeps showing the last phase it could. */
export const UPDATE_PHASES = Object.freeze([
  'resolving', 'downloading', 'verifying', 'staging', 'installing',
]);

/** The `updateStyle` values this file serves through the installer arms.
 *
 *  A LIST rather than an `=== 'download-installer'`, and that is the whole
 *  point: `scripts/test-update-in-app.js` cross-checks it against every
 *  `updateStyle` value in `install-mode.js`'s capability table and fails if a
 *  value exists that NEITHER arm handles. Adding a third install form (a
 *  Homebrew cask, a Windows MSI) then reddens a test here instead of silently
 *  falling through to the git arm, which would run `git reset --hard` in a
 *  packaged app. */
export const INSTALLER_UPDATE_STYLES = Object.freeze(['download-installer']);

/** True when this install receives updates as a downloadable build. */
function usesInstallerUpdates(caps) {
  return INSTALLER_UPDATE_STYLES.includes(caps && caps.updateStyle);
}

/**
 * The failures THIS ROUTE owns, and the sentence each one gets.
 *
 * ── THE ENGINE OWNS ITS OWN COPY, AND THIS TABLE DELIBERATELY DOES NOT ─────
 *
 * `prepareUpdate` resolves `{ok:false, reason, message}` across the reasons
 * enumerated in `UPDATE_FAILURES` in `desktop/lib/update-plan.js`, and
 * `message` is ALREADY a user-facing sentence written by the side that knows
 * what actually happened. This route relays it verbatim. Writing a second
 * sentence per reason here would be a second copy of the same fact, free to
 * drift from the first — the shape this project has paid for twice (five
 * private copies of one scrim value; two copies of a money constant).
 *
 * COUNT THAT TABLE, DO NOT TRUST A NUMBER IN PROSE. This block said "34 named
 * reasons" while it held 36, and so did `test-update-in-app.js`; a figure in a
 * comment is exactly the thing nothing can fail on. What IS enforced is the
 * rule the figure was standing in for — that suite executes both tables and
 * reds if a single reason appears in both.
 *
 * What is left is only what the engine cannot say because it was never
 * reached: the refusals this route makes on its own. Plus one total fallback,
 * for an engine that reports a failure with nothing to say.
 *
 * `reason` is for branching and for logs. It is NOT surfaced to the user — a
 * slug beside a sentence is an internal identifier shown to a person, which is
 * the v3.31.0 defect this whole release exists to undo.
 */
export const UPDATE_FAILURE_COPY = Object.freeze({
  'no-updater': {
    error: 'This build of The Curator has no built-in updater attached, so it cannot install an update for itself.',
    hint: 'Download the installer from the release page and run it — it replaces this copy.',
  },
  'nothing-staged': {
    error: 'There is no downloaded update waiting to be installed.',
    hint: 'Check for updates again to download one.',
  },
});

/**
 * Pure, TOTAL. `(reason, engineMessage?)` -> `{ reason, error, hint }`.
 *
 * The engine's `message` wins whenever there is one, which is every failure
 * that actually reached the engine. The fallback covers the rest and says the
 * two things true of every `prepareUpdate` failure by construction: nothing
 * was replaced, and there is another way to get the update.
 *
 * `reason` is echoed on the wire — for the client's branching and for logs,
 * never for display — and an unrecognised code is echoed rather than flattened
 * to "unknown", so a fact and its absence stay different values.
 */
export function updateFailureCopy(reason, engineMessage) {
  const code = typeof reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(reason) ? reason : 'unknown';
  const msg = typeof engineMessage === 'string' && engineMessage.trim() ? engineMessage.trim() : null;
  if (msg) {
    return {
      reason: code,
      error: msg,
      hint: 'You can also download the installer from the release page and run it yourself.',
    };
  }
  const known = Object.hasOwn(UPDATE_FAILURE_COPY, code) ? UPDATE_FAILURE_COPY[code] : null;
  if (known) return { reason: code, error: known.error, hint: known.hint };
  return {
    reason: code,
    error: 'The update stopped before it finished, and nothing was replaced — this copy of The Curator still works.',
    hint: 'Try again, or download the installer from the release page and run it yourself.',
  };
}

/**
 * Pull a named reason off whatever the engine rejected with, WITHOUT ever
 * reading its message.
 *
 * Not reading `err.message` is the point, and it is the same discipline
 * `installerUpdateCheck`'s network catch already applies in this file: an
 * exception message can carry an absolute path, a temp directory, a URL with a
 * token in it, or a Node errno string, and none of that is something a user can
 * act on. The engine's whole contract is that failures are NAMED; a rejection
 * with no name is itself a fact worth reporting as `unknown` rather than
 * papering over with the raw text.
 */
export function reasonFromError(err) {
  if (err && typeof err === 'object' && typeof err.reason === 'string') return err.reason;
  return 'unknown';
}

/**
 * Pure. Normalise one `onProgress` payload from the engine into the four
 * fields the wire carries, or `null` if it says nothing usable.
 *
 * ── WHY `percent` IS COMPUTED HERE AND NOT TRUSTED ─────────────────────────
 *
 * The engine may send `percent`, or bytes, or both. Bytes are the measurement;
 * a percent without bytes behind it is a claim. So when both byte counts are
 * present the percent is DERIVED from them and any supplied percent is
 * discarded — two numbers on screen that disagree is worse than one.
 *
 * ── WHY AN UNKNOWN TOTAL PRODUCES `percent: null`, NOT 0 ───────────────────
 *
 * A server that omits `content-length` is common. `percent: 0` would render as
 * a bar sitting at the far left for two minutes — indistinguishable from a
 * hang, which is the exact report this app has already had (v3.0.17, ingest
 * Phase 1). `null` is a different fact and the UI renders it as a different
 * thing: bytes received, no proportion claimed.
 */
export function normaliseUpdateProgress(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const phase = UPDATE_PHASES.includes(raw.phase) ? raw.phase : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const receivedBytes = num(raw.receivedBytes);
  const totalBytes = num(raw.totalBytes) || null;   // 0 total is "unknown", not "empty"
  let percent = null;
  if (receivedBytes !== null && totalBytes) {
    percent = Math.max(0, Math.min(100, (receivedBytes / totalBytes) * 100));
  } else if (typeof raw.percent === 'number' && Number.isFinite(raw.percent)) {
    percent = Math.max(0, Math.min(100, raw.percent));
  }
  if (phase === null && receivedBytes === null && percent === null) return null;
  return { phase, receivedBytes, totalBytes, percent };
}

// ── The job record ─────────────────────────────────────────────────────────
//
// Module-level and process-local, exactly like `src/brain/ingest-activity.js`:
// it dies with the process, which is correct because the thing it describes
// dies with the process too. It is deliberately NOT persisted — a staged
// bundle that survived a restart would be a claim this route cannot verify.
//
// ONE JOB AT A TIME, because there is one app to replace.
let updateJob = null;

/** Explicit ALLOW-LIST, never a spread — the v3.3.0 `toWire()` rule. The job
 *  never holds anything but these fields today, and the allow-list is what
 *  keeps that true after somebody stashes an error object on it. */
function updateJobToWire(job) {
  if (!job) return null;
  return {
    state: job.state,
    phase: job.phase,
    receivedBytes: job.receivedBytes,
    totalBytes: job.totalBytes,
    percent: job.percent,
    version: job.version,
    prerelease: job.prerelease,
    warning: job.warning,
    startedAt: job.startedAt,
    reason: job.reason,
    error: job.error,
    hint: job.hint,
    // `token` is ABSENT, and its absence is the security property this
    // allow-list exists for. Do not add it.
  };
}

/** TEST-ONLY. Clears the job so a suite can drive the refusing arm and the
 *  running arm in the same process, in either order. Same rationale as
 *  `__resetDesktopHost()`: the only thing it can achieve in production is a
 *  fresh start, which is the fail-safe direction. */
export function __resetUpdateJob() { updateJob = null; }

/**
 * GET /api/config/update-progress — what the in-app updater is doing.
 *
 * READ-ONLY, in-memory, no lock, no filesystem, no network. Deliberately NOT
 * behind `guardConcurrent` and NOT registered as a write, for the reason
 * `src/routes/ingest.js` records about `GET /activity` and this file records
 * about `/validate-key`: a 409 here would fire precisely when a write IS in
 * progress, which is exactly the moment someone is asking "is my update still
 * going?".
 *
 * THIS IS THE ANSWER TO "what if they navigate away". The stream is a view;
 * this is how a client that lost the view — switched section, switched tab,
 * reloaded the page — finds the job again.
 *
 * ── `updaterAttached` IS NOT DECORATION ────────────────────────────────────
 *
 * It is the only way the UI can know whether to offer a BUTTON that installs
 * or the LINK that has always opened the download page. Without it the app
 * would have to show a button, POST, and discover from a 501 that this build
 * has no engine — i.e. advertise an action it cannot perform, which is the
 * exact defect v3.31.0 was written to fix, wearing the opposite hat.
 *
 * It reports a BOOLEAN and never the hook, matching `describeDesktopHost()`'s
 * own wire-safety rule. It is derived live rather than cached, because a shell
 * may register after the server starts (see desktop-host.js's ordering note).
 */
router.get('/update-progress', (_req, res) => {
  res.json({
    ok: true,
    updaterAttached: typeof getDesktopHook(UPDATE_STAGE_HOOK) === 'function',
    job: updateJobToWire(updateJob),
  });
});

/**
 * The `download-installer` arm of `POST /api/config/update`. SSE.
 *
 * Events (this list is the documentation in `docs/api-reference.md`, and the
 * suite asserts the route emits these and ONLY these — the compile route once
 * documented a `wait` event it has never emitted, and that is the mistake this
 * comment exists to not repeat):
 *
 *   progress  { type, phase, receivedBytes, totalBytes, percent }
 *   staged    { type, version }
 *   error     { type, reason, error, hint }
 *
 * There is no `done`. "Staged" is not "done" — the bundle is verified and
 * sitting beside the running app, and NOTHING HAS BEEN REPLACED. Calling it
 * `done` would be the same collapse of two facts into one word that this file
 * refuses everywhere else; `POST /update/apply` is the step that finishes.
 */
async function installerUpdateApply(res, deps) {
  const busy = (deps && deps.hasActiveWrites) || hasActiveWrites;
  const updating = (deps && deps.isUpdateInProgress) || isUpdateInProgress;
  const hook = (deps && Object.hasOwn(deps, 'prepareUpdateHook'))
    ? deps.prepareUpdateHook
    : getDesktopHook(UPDATE_STAGE_HOOK);

  // Refusals FIRST, all as plain JSON, all before a single SSE header is sent.
  // Once `flushHeaders()` has run the status code is spent and every refusal
  // has to be expressed inside the stream, where the client's `res.ok` check
  // has already passed — the failure shape src/routes/ingest.js warns about in
  // its own error middleware.
  //
  // ONE CHECK FOR TWO REFUSALS, and it is the SHARED `conflictResponse` rather
  // than a hand-rolled 409 — which `scripts/test-route-write-guards.js`
  // enforces over this whole file, and is right to: a refusal that looks
  // different from every other refusal in the app is one the frontend has to
  // learn separately. `conflictResponse` already words the two cases
  // differently on its own (it reads the update flag), so "a write is running"
  // and "an update is already running" arrive as different sentences without
  // this route choosing either.
  if (busy() || updating()) {
    const { status, body } = conflictResponse('update the app');
    return res.status(status).json({ ...body, reason: updating() ? 'already-running' : 'write-in-flight' });
  }
  if (typeof hook !== 'function') {
    // NOT a fallback, and not a dead end either. `desktop-host.js`'s no-fallback
    // rule forbids quietly doing something else; it does not forbid telling the
    // user the thing that has always worked. This is v3.31.0's check-and-tell
    // behaviour, surfaced as a named refusal instead of silence.
    const copy = updateFailureCopy('no-updater');
    return res.status(501).json({
      ...copy,
      refused: 'updater_unavailable',
      updateStyle: 'download-installer',
      releasesPageUrl: RELEASES_PAGE_URL,
    });
  }

  // Same flag the git arm sets: an ingest arriving during the download is
  // refused with a clear 409 rather than racing a process that is about to be
  // replaced. Cleared in `finally` on every path.
  beginUpdate();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event) => {
    if (res.writableEnded) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  updateJob = {
    state: 'running',
    phase: 'resolving',
    receivedBytes: null,
    totalBytes: null,
    percent: null,
    version: null,
    prerelease: false,
    warning: null,
    startedAt: Date.now(),
    reason: null,
    error: null,
    hint: null,
    // OPAQUE, and absent from `updateJobToWire()`'s allow-list on purpose. See
    // the token block in this file's header: it is the engine's handle on the
    // staged bundle, and it must never be reachable from a renderer.
    token: null,
  };

  // DELIBERATELY NO `req.on('close')` HANDLER. See the header block above: the
  // stream is a view of the job, not the job. A closed connection stops the
  // writes (via `res.writableEnded`) and changes nothing else.
  // Passed so the hook's `{onProgress, signal}` destructure sees a real signal.
  // NEVER aborted here — see the header. Held in a const so the intent is
  // visible at the call site rather than inferred from an inline expression.
  const abort = new AbortController();

  try {
    const result = await hook({
      signal: abort.signal,
      onProgress: (raw) => {
        const p = normaliseUpdateProgress(raw);
        if (!p) return;
        // An unrecognised phase leaves the previous one standing rather than
        // blanking it — a display with no sentence for what it is showing is
        // worse than one showing the last phase it could describe.
        if (p.phase) updateJob.phase = p.phase;
        updateJob.receivedBytes = p.receivedBytes;
        updateJob.totalBytes = p.totalBytes;
        updateJob.percent = p.percent;
        send({
          type: 'progress',
          phase: updateJob.phase,
          receivedBytes: updateJob.receivedBytes,
          totalBytes: updateJob.totalBytes,
          percent: updateJob.percent,
        });
      },
    });

    // A FAILURE IS A RESOLVED VALUE on this contract, not a rejection. Checked
    // for `ok === false` explicitly rather than for falsiness: an engine that
    // resolved `undefined` is a contract violation, not a success, and the
    // arm below must catch it rather than reporting a staged update that does
    // not exist.
    if (!result || result.ok !== true) {
      const copy = updateFailureCopy(result && result.reason, result && result.message);
      updateJob.state = 'failed';
      updateJob.reason = copy.reason;
      updateJob.error = copy.error;
      updateJob.hint = copy.hint;
      send({ type: 'error', ...copy });
      return;
    }
    updateJob.state = 'staged';
    updateJob.phase = 'staging';
    updateJob.version = typeof result.version === 'string' ? result.version : null;
    updateJob.prerelease = result.prerelease === true;
    updateJob.warning = typeof result.warning === 'string' && result.warning ? result.warning : null;
    updateJob.token = result.token ?? null;
    send({
      type: 'staged',
      version: updateJob.version,
      prerelease: updateJob.prerelease,
      warning: updateJob.warning,
      // NO TOKEN, no path, no digest. The client has no use for any of them
      // and each one is a handle it should not be able to hold.
    });
  } catch (err) {
    // A REJECTION IS AN ENGINE-CONTRACT VIOLATION on this contract, not an
    // expected outcome — failures are supposed to arrive as resolved values.
    // Still handled, because a route that crashes on an unexpected throw
    // leaves the user on a progress ring that will never move again.
    const copy = updateFailureCopy(reasonFromError(err));
    updateJob.state = 'failed';
    updateJob.reason = copy.reason;
    updateJob.error = copy.error;
    updateJob.hint = copy.hint;
    send({ type: 'error', ...copy });
  } finally {
    endUpdate();
    res.end();
  }
}

/**
 * POST /api/config/update/apply — swap the staged bundle in and relaunch.
 *
 * ── WHY THIS IS A SECOND REQUEST ───────────────────────────────────────────
 *
 * Because the answer to "may I restart now?" is only knowable at the moment of
 * restarting. The download can take minutes; an ingest started during it would
 * be truncated by a relaunch authorised before it began. `hasActiveWrites()`
 * is therefore re-checked HERE, against the state that actually exists when the
 * swap happens — the same reasoning `pick-folder` records for re-checking after
 * its 60-second dialog, and the same reason the engine contract splits staging
 * from swapping at all.
 *
 * ── WHY IT DOES NOT RESPOND FIRST ──────────────────────────────────────────
 *
 * `POST /api/restart` can answer first because respawning a Node process cannot
 * really fail in a way the user needs told about. Replacing an application
 * bundle can: a read-only volume, a translocated copy, a revoked permission.
 * So the hook is AWAITED. On success it does not return — the process is gone
 * and the client's fetch rejects, which is precisely what the restart poller
 * already treats as normal. On rejection there IS a response, naming what went
 * wrong, and the old app is still running and still works.
 */
export async function updateApplyHandler(_req, res, deps = null) {
  const caps = (deps && deps.caps) || getCapabilities();
  const busy = (deps && deps.hasActiveWrites) || hasActiveWrites;
  const hook = (deps && Object.hasOwn(deps, 'installUpdateHook'))
    ? deps.installUpdateHook
    : getDesktopHook(UPDATE_APPLY_HOOK);

  if (!usesInstallerUpdates(caps)) {
    // A git checkout finishes an update through POST /api/restart and always
    // has. Naming that route matters more than naming the capability: the
    // v3.31.0 defect was a refusal that told the user an internal identifier
    // and no way forward.
    const { status, body } = capabilityRefusal('updateStyle', 'install a downloaded update', {
      updateStyle: caps.updateStyle,
      hint: 'This install updates by pulling its own source. Use Check for updates, which finishes with a restart.',
    });
    return res.status(status).json(body);
  }
  if (busy()) {
    const { status, body } = conflictResponse('restart to finish the update');
    return res.status(status).json(body);
  }
  if (!updateJob || updateJob.state !== 'staged') {
    // 412 AND NOT 409, and the distinction is not pedantry. Every 409 in this
    // app means "somebody else is using this right now, try later" and carries
    // `conflictResponse`'s shape, which the frontend reads as exactly that. But
    // "there is nothing staged" is not a contended resource — waiting will
    // never make it true. A precondition of this request is simply not met, so
    // it says so with its own status and its own reason code, and cannot be
    // mistaken for a queue to wait in.
    return res.status(412).json({
      error: 'There is no downloaded update waiting to be installed.',
      reason: 'nothing-staged',
    });
  }
  if (typeof hook !== 'function') {
    const copy = updateFailureCopy('no-updater');
    return res.status(501).json({ ...copy, refused: 'updater_unavailable', releasesPageUrl: RELEASES_PAGE_URL });
  }

  const token = updateJob.token;
  updateJob.state = 'applying';
  updateJob.phase = 'installing';
  beginUpdate();
  try {
    // The token, straight back, unread and unmodified. This route does not
    // know what is in it and must not: a path here would be a
    // replace-any-directory primitive reachable from a page.
    const result = await hook({ token, onProgress: () => {} });
    // BOTH FAILURE SHAPES. The contract specifies a resolved `{ok:false,
    // reason, message}` for `prepareUpdate`; `installUpdate` is documented only
    // as "swap and relaunch", so it may reject instead. A resolved failure is
    // recognised here and its `message` — written for a user by the side that
    // knows what happened — is relayed. A REJECTION's `.message` is NOT mined,
    // because a rejection can also be an ordinary TypeError whose message
    // carries a path.
    if (result && result.ok === false) return applyFailed(res, result.reason, result.message);
    // Reached only if the shell chose not to end the process. Harmless, and an
    // honest thing to be able to say, so it is said rather than assumed away.
    return res.json({ ok: true, relaunching: true, version: updateJob.version });
  } catch (err) {
    return applyFailed(res, reasonFromError(err), null);
  } finally {
    endUpdate();
  }
}

/**
 * One place that records a failed swap, so the resolved-failure arm and the
 * rejection arm cannot land the job in two different states.
 *
 * Back to `staged`, NOT `failed`: the verified bundle is still on disk and
 * still installable, so the honest state is "downloaded, not yet in place",
 * and the button that finishes it is still the right offer.
 */
function applyFailed(res, reason, message) {
  const copy = updateFailureCopy(reason, message);
  updateJob.state = 'staged';
  updateJob.phase = 'staging';
  updateJob.reason = copy.reason;
  updateJob.error = copy.error;
  updateJob.hint = copy.hint;
  return res.status(500).json({ ...copy, releasesPageUrl: RELEASES_PAGE_URL });
}

// `guardConcurrent` on the REGISTRATION *and* a re-check inside the handler —
// the same two layers `pick-folder` carries, for the same reason. The
// middleware proves the state when the request arrived; the handler's own
// check is the one that matters, because it is the last thing that happens
// before an application bundle is swapped underneath a running ingest.
router.post('/update/apply', guardConcurrent('restart to finish the update'), (req, res) => updateApplyHandler(req, res));


/** POST /api/config/update — fetch latest code, hard-sync to origin/main, install deps, rebuild .app
 *
 * We use `fetch + reset --hard` instead of `pull` because `npm install` commonly
 * regenerates `package-lock.json` with machine-specific diffs, which make plain
 * `git pull` abort with "local changes would be overwritten". The app directory
 * is meant to track `main` verbatim — user data (domains/, .curator-config.json,
 * .sync-config.json) is all gitignored, so hard-reset is safe.
 *
 * FORKED on `canSelfUpdateViaGit` (see src/brain/install-mode.js). Every step
 * below — `git fetch`, `git reset --hard`, `npm install`, and re-running
 * `scripts/build-app.sh` (which ends in an ad-hoc `codesign --force --deep
 * --sign -`) — is impossible or actively destructive in a signed bundle. The
 * capability check is an EARLY RETURN above the pre-fork body, which is
 * otherwise unchanged: `git diff -w` on this hunk is pure insertion.
 *
 * The refusal is checked BEFORE the write-registry 409. In repo mode
 * `canSelfUpdateViaGit` is true, so control falls straight through to the same
 * `hasActiveWrites()` check as before and behaviour is unchanged; in bundle
 * mode "this build cannot do that at all" is the more useful answer than "not
 * right now".
 *
 * `deps` is the test-only seam: null in production. It is the ONLY reason an
 * offline suite can drive this handler — calling it for real runs
 * `git reset --hard origin/main` against the developer's own checkout.
 *
 * ── FORK ONE, ADDED FOR THE IN-APP UPDATER ─────────────────────────────────
 *
 * `updateStyle` is now checked FIRST, in the same shape and the same order as
 * `updateCheckHandler` above, and for the same reason: it has an answer for
 * every install form, while `canSelfUpdateViaGit` only says what one of them
 * cannot do. In repo mode `updateStyle` is 'git-pull', so control falls
 * straight through and every line below runs with the inputs it always had —
 * an EARLY RETURN above an otherwise unchanged body.
 *
 * That equivalence is proved BEHAVIOURALLY rather than by reading a diff:
 * `scripts/test-update-in-app.js` §2 extracts this function from
 * `git show HEAD:` and from the working tree and drives both through the same
 * `deps` seam over a repo-mode matrix, requiring the identical command
 * sequence and the identical response on every input.
 */
export async function updateHandler(_req, res, deps = null) {
  const caps = (deps && deps.caps) || getCapabilities();
  // FORK ONE — `updateStyle`. See the docblock above.
  if (usesInstallerUpdates(caps)) return installerUpdateApply(res, deps);
  // FORK TWO — unchanged.
  if (!caps.canSelfUpdateViaGit) {
    const { status, body } = capabilityRefusal('canSelfUpdateViaGit', 'update the app', {
      hint: 'Packaged builds are replaced by the installer, not by pulling this checkout.',
    });
    return res.status(status).json(body);
  }
  const execAsync = (deps && deps.execAsync) || defaultExec;
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

  // The ref this install tracks. On `stable` the branch is `main`, so the two
  // commands built from it below are the byte-identical strings this handler
  // has always run — proved differentially against the pre-change handler on
  // the same seam, and pinned as literals by scripts/test-release-channel.js.
  //
  // DO NOT extend this to a second channel by swapping the name into these two
  // commands: `git reset --hard origin/<b>` cannot resolve on a standard
  // install, which is a single-branch shallow clone. The measurement and the
  // command shape that does work are recorded in src/brain/config.js.
  const { branch } = (deps && deps.releaseRef) || getReleaseRef();

  // Flag this domain-global operation so an ingest that arrives during the
  // git-reset / npm-install window is refused with a clear 409 (see the
  // matching check in src/routes/ingest.js). Cleared in `finally`.
  beginUpdate();
  try {
    // 0. PREFLIGHT: is git reachable at all? The six commands below all assume
    //    it. Without this, a machine with no git (Xcode CLT never installed, or
    //    removed) fails at step 1 with the shell's own text —
    //    "/bin/sh: git: command not found" — which names no remedy. The same
    //    class is worse in Personal Sync, where `friendlyError`'s
    //    `msg.includes('not found')` catch-all renders it as "Repository not
    //    found. Check the URL — it must be a private repo you own." (a
    //    confidently wrong diagnosis; fixed at source in src/brain/sync.js).
    //
    //    This ADDS one command to the sequence and changes none of the six.
    //    ~5 ms against a flow that already takes minutes.
    try {
      await execAsync('git --version', execOpts({ timeout: 5000 }));
    } catch {
      throw new Error(GIT_MISSING_MESSAGE);
    }

    // 1. Fetch before resetting so we never hard-reset to a stale ref if the remote is unreachable.
    await execAsync('git fetch origin ' + branch, execOpts({ timeout: 30000 }));

    // 2. Record before/after SHAs so the response explains what changed.
    const before = await execAsync('git rev-parse HEAD', execOpts({ timeout: 5000 }));
    beforeSha = before.stdout.trim().slice(0, 7);

    // 3. Hard-sync to origin/main. Discards any local modifications to tracked files
    //    (including the common `package-lock.json` regeneration) without touching gitignored data.
    await execAsync('git reset --hard origin/' + branch, execOpts({ timeout: 10000 }));
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
}

router.post('/update', (req, res) => updateHandler(req, res));

export default router;
