/**
 * "My Curator in your tools" — status, plan and apply (v3.85.0, macOS only).
 *
 *   GET  /api/mcp/install/status  → every MCP-capable tool on this Mac and whether
 *                                   it is connected. READ-ONLY.
 *   POST /api/mcp/install/plan    → {action: 'install'|'remove'|'restore', ids: [...]}
 *                                   → a preview and a single-use token. READS ONLY.
 *   POST /api/mcp/install/apply   → {token} → re-plans from disk, verifies every
 *                                   basis, writes, reports one line per file.
 *
 * The write rules live in `src/brain/mcp-install.js` (read its header first).
 * This file adds the HTTP gate:
 *
 *   - ORIGIN REQUIRED on all three POSTs. The global guard in server.js lets a
 *     request with NO Origin through (curl, scripts); this surface writes other
 *     applications' files, so it is reachable only from the app's own page:
 *     missing Origin → 403 `origin_required`, a foreign one → 403
 *     `origin_refused`. The allowed origins are the loopback origins of the
 *     port the request actually arrived on.
 *   - macOS only: anything else → 409 `platform_unsupported`.
 *   - BODY ALLOW-LIST: only the named keys, ids from a fixed list. A path, an
 *     entry or any unknown key → 400 `bad_request`. Paths come only from the
 *     adapter table resolved against home.
 *   - ONE APPLY IN FLIGHT (409 `busy`), tokens single-use, 10-minute TTL, in
 *     memory, bound to the planned basis set.
 *   - Never called on load or poll: GET /status is the only read the panel
 *     makes on its own, and it writes nothing.
 *
 * `usedAt` comes from the usage log's canonical client ids. It is a LABEL
 * (src/brain/mcp-clients.js): it never changes a status or an offer.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { getDomainsDir } from '../brain/config.js';
import { getMcpLauncherPath } from '../brain/mcp-launcher.js';
import { adapterFor, mcpEntryFor } from '../brain/harness-adapters.js';
import { tildeUnder } from '../brain/setup-check.js';
import { readUsageLinesUnion, summariseSessions } from '../brain/mcp-usage.js';
import { detectRunning, detectTools } from '../brain/harness-detect.js';
import {
  ACTIONS, INSTALL_IDS, TOKEN_RE, TOKEN_TTL_MS, executeItem, inspectTool, installActionFor, installAppsDirs,
  installHome, installPlatform, isInstallCapable, mcpHarnessIds, newToken, planTool, publicItem, readManifest,
  reasonText, restoreCandidate, statusFor, targetsFor, defaultIO,
} from '../brain/mcp-install.js';
import { buildCuratorEntry } from './mcp.js';

const router = express.Router();

// ── Test seams (never set in production) ───────────────────────────────────
let _detectDeps = null;
let _io = null;
/** TEST-ONLY: inject the detector's probes (runPs, runShell, appsDirs, …). */
export function __setDetectDeps(d) { _detectDeps = d || null; }
/** TEST-ONLY: inject the executor's IO (e.g. a backup write that throws). */
export function __setInstallIO(io) { _io = io || null; }

function io() { return _io || defaultIO(); }

function detectDeps(home) {
  if (_detectDeps) return _detectDeps;
  const appsDirs = installAppsDirs(home);
  const deps = {};
  if (appsDirs) deps.appsDirs = appsDirs;
  // An isolated test process must never run the user's login shell or ps.
  if (process.env.CURATOR_TEST_INSTALL_HOME) {
    deps.runShell = async () => '';
    deps.runPs = async () => { throw new Error('ps disabled under test'); };
  }
  return deps;
}

/**
 * The launch line (ONLY from buildCuratorEntry) and whether it needs the
 * launcher shim. Derived from the line itself — the bundle arm's command IS
 * the launcher path — so this route does not fork on a capability a second
 * time: routes/mcp.js's fork (owned by test-mcp-launcher.js) is the only one.
 */
function launchNow() {
  const launch = buildCuratorEntry(getDomainsDir());
  const launcherPath = getMcpLauncherPath();
  const usesLauncher = launch.command === launcherPath;
  const style = usesLauncher ? 'launcher-script' : 'node-script';
  let launcherState = { required: false, present: true, message: null };
  if (usesLauncher) {
    const present = existsSync(launcherPath);
    launcherState = {
      required: true,
      present,
      message: present ? null
        : 'The launcher The Curator writes for other tools is missing. If The Curator is running from your Downloads '
          + 'folder or from a temporary copy, move it to /Applications and reopen it.',
    };
  }
  return { launch, style, launcherState };
}

function isMac() { return installPlatform() === 'darwin'; }

function restartHint(id, label, running) {
  if (id === 'claude-desktop') {
    return running.checked && running.running
      ? 'Quit Claude Desktop first for the safest install — it rewrites its own config file — then reopen it.'
      : 'Claude Desktop rewrites its own config file: quit it first for the safest install, then open it.';
  }
  if (running.checked && running.running) return `Quit and reopen ${label}`;
  if (running.checked) return `Open ${label} to load the change`;
  return `Quit and reopen ${label} if it is open`;
}

/** Last time a session from this harness's canonical client id used the bridge. LABEL ONLY. */
async function usedAtById() {
  try {
    const u = await readUsageLinesUnion();
    if (!u.present) return {};
    const { sessions } = summariseSessions(u.records || []);
    const out = {};
    for (const s of sessions || []) {
      if (!s.client || !s.endedAt) continue;
      if (!out[s.client] || s.endedAt > out[s.client]) out[s.client] = s.endedAt;
    }
    return out;
  } catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────
// GET /status
// ─────────────────────────────────────────────────────────────────────────

export async function buildStatus() {
  const home = installHome();
  const platform = installPlatform();
  const mac = platform === 'darwin';
  const { launch, style, launcherState } = launchNow();
  const theIO = io();
  const configFiles = {};
  for (const id of INSTALL_IDS) configFiles[id] = home ? targetsFor(id, home, theIO).map((t) => t.file) : [];
  const [detected, running, used] = await Promise.all([
    detectTools({ home, configFiles, deps: detectDeps(home) }),
    mac ? detectRunning(detectDeps(home)) : Promise.resolve({ checked: false, byId: {} }),
    usedAtById(),
  ]);
  const manifestRows = readManifest(theIO).rows;

  const tools = [];
  const notFound = [];
  const manualSnippets = {};
  for (const id of mcpHarnessIds()) {
    const a = adapterFor(id);
    const label = a.label;
    const entry = mcpEntryFor(id, launch);
    if (entry.ok) manualSnippets[id] = entry.text;
    const det = detected[id]?.detected || null;
    const capable = isInstallCapable(id) && mac;
    const run = { checked: running.checked && id in (running.byId || {}), running: !!(running.byId || {})[id] };
    const row = {
      id, label,
      status: 'manual',
      installer: a.mcpConfig.installer || 'manual',
      detected: det ? { by: det.by, path: tildeUnder(home, det.path) } : { by: null, path: null },
      running: run,
      files: [],
      reason: null,
      note: null,
      usedAt: used[id] || null,
      restartHint: null,
      restorable: false,
    };
    if (capable && home) {
      const insp = inspectTool(id, { home, launch, io: theIO });
      row.files = insp.files.map((f) => ({
        // Absolute, for Settings' Reveal (POST /api/setup/reveal). That route
        // reveals only paths its own GET /api/setup/machine listed; this field
        // does not widen its allow-set.
        file: f.file,
        display: tildeUnder(home, f.file),
        role: f.role,
        action: installActionFor(f),
        state: f.read.state === 'missing' ? 'missing'
          : f.read.state === 'cant-read' ? 'cant-read'
            : f.entryState === 'match' ? 'connected' : f.entryState === 'differs' ? 'differs' : 'no-entry',
        reason: f.read.state === 'cant-read' ? f.read.reason : null,
      }));
      const named = insp.files.some((f) => f.entryState === 'match' || f.entryState === 'differs');
      if (!det && !named && insp.files.every((f) => f.read.state === 'missing')) {
        notFound.push({ id, label });
        continue;
      }
      row.status = statusFor(insp.files);
      const bad = insp.files.find((f) => f.read.state === 'cant-read');
      if (bad) row.reason = { code: bad.read.reason, message: `${tildeUnder(home, bad.file)} ${reasonText(bad.read.reason) || 'could not be read'}.` };
      if (row.status !== 'cant-read' && launcherState.required && !launcherState.present) {
        row.reason = { code: 'launcher_missing', message: launcherState.message };
      }
      row.restartHint = restartHint(id, label, run);
      row.restorable = insp.files.some((f) => f.read.state !== 'cant-read'
        && restoreCandidate(manifestRows, id, f.file, f.read.sha).eligible);
      if (id === 'antigravity' && insp.files.some((f) => f.role === 'observed')) {
        row.note = 'Antigravity keeps more than one MCP file on this Mac; each one that exists is kept in step.';
      }
    } else {
      if (!det) { notFound.push({ id, label }); continue; }
      row.reason = !mac
        ? { code: 'platform_unsupported', message: 'One-click install is macOS-only in this version. Copy the entry in by hand.' }
        : a.mcpConfig.installer === 'cli'
          ? { code: 'installer_cli', message: `${label} has its own command for this — one-click install comes in a later version. Copy the entry for now.` }
          : { code: 'installer_manual', message: `Copy the entry into ${label}'s settings by hand.` };
    }
    tools.push(row);
  }

  return {
    platform,
    writable: mac && !!home && !(launcherState.required && !launcherState.present),
    launch: { style, command: launch.command, argsCount: Array.isArray(launch.args) ? launch.args.length : 0 },
    tools,
    notFound,
    manualSnippets,
  };
}

router.get('/status', async (_req, res) => {
  try {
    res.json(await buildStatus());
  } catch (err) {
    res.status(500).json({ error: `Could not read the tools on this Mac: ${err && err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// The gate for the POSTs
// ─────────────────────────────────────────────────────────────────────────

export function gate(req, res, next) {
  const origin = req.get('origin');
  const port = req.socket && req.socket.localPort;
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (!origin) {
    return res.status(403).json({ ok: false, reason: 'origin_required', error: 'This action can only be started from The Curator\'s own window.' });
  }
  if (!allowed.has(origin)) {
    return res.status(403).json({ ok: false, reason: 'origin_refused', error: 'Cross-origin request blocked.' });
  }
  if (!isMac()) {
    return res.status(409).json({ ok: false, reason: 'platform_unsupported', error: 'One-click install is macOS-only in this version. Copy the entry in by hand.' });
  }
  next();
}

function badRequest(res, error) {
  return res.status(400).json({ ok: false, reason: 'bad_request', error });
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }

/** `{action, ids}` or a string error. Only these two keys; ids from the fixed list. */
export function validatePlanBody(body) {
  if (!isPlainObject(body)) return 'The request body must be a JSON object.';
  const extra = Object.keys(body).filter((k) => k !== 'action' && k !== 'ids');
  if (extra.length) return `Unexpected field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 5).join(', ')}.`;
  if (!ACTIONS.includes(body.action)) return 'action must be install, remove or restore.';
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > INSTALL_IDS.length) return 'ids must list one or more tools.';
  if (!body.ids.every((x) => typeof x === 'string' && INSTALL_IDS.includes(x))) return 'ids may only name tools The Curator can install for.';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Plans and tokens
// ─────────────────────────────────────────────────────────────────────────

const tokens = new Map(); // token -> {action, ids, expiresAt, basis: Map(key -> {basis, entryText, action})}
const TOKEN_MAX = 32;
let applyInFlight = false;

/** TEST-ONLY. */
export function __tokenCount() { return tokens.size; }
export function __expireAllTokens() { for (const t of tokens.values()) t.expiresAt = 0; }

const itemKey = (it) => `${it.id}\u0000${it.file || ''}`;

async function makePlan(action, ids) {
  const home = installHome();
  const { launch, launcherState } = launchNow();
  const theIO = io();
  const manifestRows = readManifest(theIO).rows;
  const configFiles = {};
  for (const id of ids) configFiles[id] = home ? targetsFor(id, home, theIO).map((t) => t.file) : [];
  const detected = await detectTools({ home, configFiles, deps: detectDeps(home) });
  const items = [];
  for (const id of [...new Set(ids)]) {
    items.push(...planTool(id, action, {
      home, launch, launcherState, detected: !!detected[id]?.detected, manifestRows, io: theIO,
    }));
  }
  return { home, items };
}

export async function planHandler(req, res) {
  const err = validatePlanBody(req.body);
  if (err) return badRequest(res, err);
  const { action, ids } = req.body;
  let plan;
  try { plan = await makePlan(action, ids); } catch (e) {
    return res.status(500).json({ ok: false, reason: 'plan_failed', error: e && e.message });
  }
  const now = Date.now();
  for (const [t, v] of tokens) if (v.expiresAt <= now) tokens.delete(t);
  while (tokens.size >= TOKEN_MAX) tokens.delete(tokens.keys().next().value);
  const token = newToken();
  const expiresAt = now + TOKEN_TTL_MS;
  tokens.set(token, {
    action, ids: [...new Set(ids)], expiresAt,
    basis: new Map(plan.items.map((it) => [itemKey(it), { basis: it.basis, entryText: it.entryText, action: it.action, refused: !!it.refused }])),
  });
  res.json({ ok: true, token, expiresAt: new Date(expiresAt).toISOString(), action, items: plan.items.map(publicItem) });
}

export async function applyHandler(req, res) {
  const body = req.body;
  if (!isPlainObject(body) || Object.keys(body).length !== 1 || typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) {
    return badRequest(res, 'The request body must be {token}.');
  }
  if (applyInFlight) return res.status(409).json({ ok: false, reason: 'busy', error: 'An install is already running.' });
  const rec = tokens.get(body.token);
  if (!rec) return res.status(409).json({ ok: false, reason: 'token_invalid', error: 'This plan was already used or is unknown. Plan again.' });
  tokens.delete(body.token); // single use, whatever happens next
  if (rec.expiresAt <= Date.now()) return res.status(409).json({ ok: false, reason: 'token_expired', error: 'This plan is more than 10 minutes old. Plan again.' });

  applyInFlight = true;
  try {
    const plan = await makePlan(rec.action, rec.ids);
    const theIO = io();
    const results = [];
    const seen = new Set();
    for (const it of plan.items) {
      const k = itemKey(it);
      seen.add(k);
      const was = rec.basis.get(k);
      const pub = { id: it.id, label: it.label, file: it.display || null };
      let r;
      if (!was || was.basis !== it.basis) {
        r = { outcome: 'refused', reason: 'config_changed', message: `${it.display || it.label} changed after the plan was made. Nothing was written — plan again.` };
      } else if (was.action !== it.action || was.entryText !== it.entryText) {
        r = { outcome: 'refused', reason: 'plan_changed', message: `What would be written to ${it.display || it.label} changed after the plan was made. Nothing was written — plan again.` };
      } else {
        r = executeItem(it, { home: plan.home, io: theIO });
      }
      const restart = (r.outcome === 'written' || r.outcome === 'created')
        ? `Quit and reopen ${it.label}` : null;
      results.push({ ...pub, action: it.action, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}), message: r.message, ...(r.backup ? { backup: r.backup } : {}), restart });
    }
    for (const k of rec.basis.keys()) {
      if (seen.has(k)) continue;
      const [id, file] = k.split('\u0000');
      results.push({ id, label: adapterFor(id)?.label || id, file: file ? tildeUnder(plan.home, file) : null, action: 'none', outcome: 'refused', reason: 'config_changed', message: 'A file in the plan is no longer there. Nothing was written to it — plan again.', restart: null });
    }
    res.json({ ok: true, action: rec.action, results });
  } catch (e) {
    res.status(500).json({ ok: false, reason: 'apply_failed', error: e && e.message });
  } finally {
    applyInFlight = false;
  }
}

/** TEST-ONLY: hold the in-flight flag to observe the 409. */
export function __setApplyInFlight(v) { applyInFlight = !!v; }

router.post('/plan', gate, planHandler);
router.post('/apply', gate, applyHandler);

export default router;
