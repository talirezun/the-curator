/**
 * The Setup check's endpoints (v3.77.0).
 *
 *   GET  /api/setup/machine                         → Settings › MCP bridge › Tools on this Mac
 *   GET  /api/setup/projects/:domain/:project       → Context › project › step 5 "Setup"
 *   PUT  /api/setup/projects/:domain/:project/repo  → {path} | {path: null} — this machine only
 *   PUT  /api/setup/tools                           → {ids: [...]} — the "+ Add a tool" choice
 *   POST /api/setup/reveal                          → {path} — Finder; only a path a check listed
 *   GET  /api/setup/skills/:name.zip                → the current skill folder, zipped
 *
 * READ-ONLY OVER EVERYTHING THAT IS NOT THE APP'S OWN CONFIG. The GETs read
 * harness config files (booleans and our own entry only — see
 * src/brain/setup-check.js), a project's repository (its marker and
 * instruction files, and read-only git with no fetch), the store's scope index
 * and the last remote check the app already made. The two PUTs write
 * `.curator-config.json` — the app's own, per-machine, never synced — and
 * nothing else. No route here writes a harness config, a skill folder, a
 * repository file or a git ref.
 */
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { appPath } from '../brain/paths.js';
import { describeInstall } from '../brain/install-mode.js';
import {
  getDomainsDir, getProjectRepo, setProjectRepo, getSetupTools, setSetupTools,
} from '../brain/config.js';
import { listDomains } from '../brain/files.js';
import * as workingState from '../brain/working-state.js';
import {
  collectMachineSetup, collectProjectSetup, inspectMarker, SKILL_NAMES, STATES,
} from '../brain/setup-check.js';
import { adapterFor, listHarnesses, mcpEntryFor } from '../brain/harness-adapters.js';
import { TEMPLATE } from '../public/next/shared/agent-instructions.js';
import { buildCuratorEntry } from './mcp.js';

const router = express.Router();

// ── Test seams (never set in production) ───────────────────────────────────
let homeOverride = null;
let revealer = (target, cb) => execFile('open', ['-R', target], (err) => cb(err || null));
/** TEST-ONLY: read harness files under this folder instead of the user's home. */
export function __setSetupHomeOverride(p) { homeOverride = p || null; }
/** TEST-ONLY: replace the Finder call. */
export function __setRevealer(fn) { revealer = typeof fn === 'function' ? fn : revealer; }

function home() {
  if (homeOverride) return homeOverride;
  if (process.env.CURATOR_TEST_SETUP_HOME) return process.env.CURATOR_TEST_SETUP_HOME;
  try { return os.homedir(); } catch { return ''; }
}

function appVersion() {
  try { return JSON.parse(readFileSync(appPath('package.json'), 'utf8')).version || null; } catch { return null; }
}

function skillsDir() {
  const d = appPath('skills');
  return existsSync(d) ? d : null;
}

/** `~/…` for a path under home — a display string only; `file` stays absolute. */
function tilde(p) {
  const h = home();
  return typeof p === 'string' && h && (p === h || p.startsWith(`${h}/`)) ? `~${p.slice(h.length)}` : p;
}

// Paths a check has LISTED, so reveal can only open one of them.
const revealable = new Set();
function withDisplay(v) {
  if (Array.isArray(v)) return v.map(withDisplay);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = withDisplay(x);
    if (typeof v.file === 'string') { o.display = tilde(v.file); revealable.add(v.file); }
    if (typeof v.dir === 'string') { o.dirDisplay = tilde(v.dir); revealable.add(v.dir); }
    return o;
  }
  return v;
}

async function thisMachineIds() {
  const ids = [];
  try {
    const { candidateUsageLogPaths } = await import('../brain/mcp-usage.js');
    const dirs = [...new Set(candidateUsageLogPaths().map((f) => path.dirname(f)))];
    for (const dir of dirs) {
      try {
        const v = readFileSync(path.join(dir, workingState.MACHINE_ID_FILENAME), 'utf8').trim();
        if (v) ids.push({ dir, id: v });
      } catch { /* not minted in this folder */ }
    }
  } catch { /* none */ }
  return ids;
}

async function hookSummary(project = null) {
  try {
    const { readHookLines, summariseHookActivity } = await import('../brain/hook-log.js');
    const { lines } = await readHookLines();
    return summariseHookActivity(lines, { project });
  } catch { return {}; }
}

function copyEntries(rows) {
  let launch = null;
  try { launch = buildCuratorEntry(getDomainsDir()); } catch { launch = null; }
  const out = {};
  for (const r of rows) {
    if (!launch) break;
    const e = mcpEntryFor(r.id, launch);
    if (e && e.ok && typeof e.text === 'string') out[r.id] = e.text;
  }
  return out;
}

const PROJECT_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
async function checkProject(req, res) {
  const { domain, project } = req.params;
  if (!PROJECT_RE.test(domain || '') || !PROJECT_RE.test(project || '') || !workingState.isSafeSegment(project)) {
    res.status(400).json({ ok: false, reason: 'invalid_project', error: 'That is not a usable domain/project name.' });
    return null;
  }
  const domains = await listDomains();
  if (!domains.includes(domain)) {
    res.status(404).json({ ok: false, reason: 'unknown_domain', error: `Unknown domain: ${domain}` });
    return null;
  }
  return { domain, project };
}

// ── GET /machine ──────────────────────────────────────────────────────────
router.get('/machine', async (_req, res) => {
  try {
    const rows = collectMachineSetup({
      home: home(), repo: '', skillsDir: skillsDir(), domainsDir: getDomainsDir(),
      hookSummary: await hookSummary(),
    });
    let bridgeProcesses = null;
    try {
      const { detectBridgeProcesses, STALE_REMEDY } = await import('../brain/mcp-bridge-status.js');
      const bp = await detectBridgeProcesses();
      bridgeProcesses = { checked: bp.checked !== false, running: bp.running || 0, stale: (bp.stale || []).map((p) => ({ pid: p.pid, startedAt: p.startedAt })), codeChangedAt: bp.codeChangedAt || null, remedy: STALE_REMEDY };
    } catch { bridgeProcesses = { checked: false }; }
    const ids = await thisMachineIds();
    // Only harnesses with SOMETHING on this machine — a config file, a
    // skill folder, a hook file — or that the user added. Never all fifteen.
    const added = new Set(getSetupTools());
    const shown = rows.filter((r) => added.has(r.id)
      || r.files.some((f) => f.present) || r.skills.installed.length || r.hooks.files.some((f) => f.present));
    res.json(withDisplay({
      ok: true,
      checkedAt: new Date().toISOString(),
      version: appVersion(),
      // The install's own label ("Mac app" / "source install"), described
      // through install-mode.js — this route never branches on the form.
      install: (() => { try { return describeInstall().installModeLabel; } catch { return null; } })(),
      skillsShipped: skillsDir() !== null,
      machine: { ids: ids.map((x) => x.id), split: new Set(ids.map((x) => x.id)).size > 1 },
      bridgeProcesses,
      harnesses: shown,
      copyEntries: copyEntries(shown),
      addable: listHarnesses().filter((id) => !shown.some((r) => r.id === id)).map((id) => ({ id, label: adapterFor(id).label })),
    }));
  } catch (err) {
    console.error('Setup machine check error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /projects/:domain/:project ────────────────────────────────────────
router.get('/projects/:domain/:project', async (req, res) => {
  try {
    const ctx = await checkProject(req, res);
    if (!ctx) return;
    const { domain, project } = ctx;
    const repoPath = getProjectRepo(domain, project);
    let repo = null;
    let marker = null;
    if (repoPath) {
      let exists = false;
      try { exists = statSync(repoPath).isDirectory(); } catch { exists = false; }
      repo = { path: repoPath, source: 'set', exists };
      if (exists) marker = await inspectMarker(repoPath, { domain, project });
    }
    const machineRows = collectMachineSetup({
      home: home(), repo: repo?.exists ? repoPath : '', skillsDir: skillsDir(), domainsDir: getDomainsDir(),
      hookSummary: await hookSummary(`${domain}/${project}`),
    });
    let pairs = [];
    try {
      const idx = await workingState.listWorkingScopes(domain, { project, withSaveTimes: true });
      if (idx && idx.ok && Array.isArray(idx.scopes)) pairs = idx.scopes;
    } catch { pairs = []; }
    let sync = { configured: false };
    try {
      const { getStatus } = await import('../brain/sync.js');
      const st = await getStatus();
      sync = { configured: st.configured === true, lastSync: st.lastSync || null, pending: Number.isInteger(st.changesCount) ? st.changesCount : null };
      if (sync.configured) {
        const { readRemoteIncoming } = await import('../brain/tray-summary.js');
        const inc = readRemoteIncoming();
        sync.incoming = inc && inc.ok ? inc.files : null;
        sync.incomingCheckedAt = inc ? inc.checkedAt : null;
        sync.behindFiles = inc && inc.ok ? inc.behindFiles : null;
      }
    } catch { sync = { configured: false, error: true }; }
    const ids = await thisMachineIds();
    const result = collectProjectSetup({
      domain, project, pairs, machine: { ids: ids.map((x) => x.id) }, machineRows,
      repo, marker, template: TEMPLATE, addedTools: getSetupTools(), sync, thisVersion: appVersion(),
    });
    // The repository's own files are revealable too: the folder, and every
    // instruction file a listed tool reads (it may not exist yet — reveal then
    // opens the folder, which is where the owner creates it).
    if (repo?.exists) {
      revealable.add(repoPath);
      for (const t of result.tools) for (const n of adapterFor(t.id)?.instructionFile?.names || []) revealable.add(path.join(repoPath, n));
      if (result.repo) result.repo.display = tilde(repoPath);
    }
    const suggestions = repoPath ? [] : await workingState.foundationFolderSources(domain, project);
    res.json(withDisplay({
      ok: true,
      checkedAt: new Date().toISOString(),
      ...result,
      repoSuggestions: suggestions.map((s) => ({ ...s, rootDisplay: tilde(s.root) })),
      machine: { ids: ids.map((x) => x.id), split: new Set(ids.map((x) => x.id)).size > 1 },
      markerLine: `${domain}/${project}`,
      addedTools: getSetupTools(),
      addable: listHarnesses().filter((id) => !result.tools.some((t) => t.id === id) && adapterFor(id)?.instructionFile?.names?.length)
        .map((id) => ({ id, label: adapterFor(id).label })),
      states: STATES,
    }));
  } catch (err) {
    console.error('Setup project check error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /projects/:domain/:project/repo ───────────────────────────────────
router.put('/projects/:domain/:project/repo', async (req, res) => {
  try {
    const ctx = await checkProject(req, res);
    if (!ctx) return;
    const raw = req.body && Object.hasOwn(req.body, 'path') ? req.body.path : undefined;
    if (raw === null || raw === '') {
      setProjectRepo(ctx.domain, ctx.project, null);
      return res.json({ ok: true, path: null });
    }
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({ ok: false, reason: 'invalid_path', error: 'Send {"path": "/absolute/folder"} or {"path": null}.' });
    }
    let p = raw.trim();
    if (p.startsWith('~/')) p = path.join(home(), p.slice(2));
    if (!path.isAbsolute(p) || p.length > 1024 || p.includes('\0')) {
      return res.status(400).json({ ok: false, reason: 'invalid_path', error: 'The folder must be an absolute path, like /Users/you/code/ott.' });
    }
    p = path.resolve(p);
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      return res.status(409).json({ ok: false, reason: 'not_found', error: `There is no folder at ${tilde(p)} on this computer.` });
    }
    const saved = setProjectRepo(ctx.domain, ctx.project, p);
    res.json({ ok: true, path: saved, display: tilde(saved) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /tools ────────────────────────────────────────────────────────────
router.put('/tools', (req, res) => {
  const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
  if (!ids || ids.some((x) => !adapterFor(x))) {
    return res.status(400).json({ ok: false, reason: 'invalid_tools', error: 'Send {"ids": [...]} with known tool ids.' });
  }
  res.json({ ok: true, ids: setSetupTools(ids) });
});

// ── POST /reveal ──────────────────────────────────────────────────────────
router.post('/reveal', (req, res) => {
  const p = req.body && typeof req.body.path === 'string' ? req.body.path : '';
  // ONLY a path a check has listed (a config file, a skill folder, a hook
  // file, an instruction file) or a folder the owner set as a repository.
  if (!p || !path.isAbsolute(p) || !revealable.has(p)) {
    return res.status(400).json({ ok: false, reason: 'not_listed', error: 'Only a file the Setup check listed can be revealed.' });
  }
  const target = existsSync(p) ? p : path.dirname(p);
  revealer(target, (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, revealed: target });
  });
});

/** Called by the project GET so a repository's own files are revealable too. */
export function __revealable() { return revealable; }

// ── GET /skills/:name.zip ─────────────────────────────────────────────────
router.get('/skills/:file', (req, res) => {
  const m = /^([a-z-]+)\.zip$/.exec(req.params.file || '');
  const name = m ? m[1] : null;
  if (!name || !SKILL_NAMES.includes(name)) {
    return res.status(404).json({ ok: false, reason: 'unknown_skill', error: `Skills: ${SKILL_NAMES.join(', ')}.` });
  }
  const dir = skillsDir();
  if (!dir || !existsSync(path.join(dir, name, 'SKILL.md'))) {
    return res.status(404).json({ ok: false, reason: 'not_shipped', error: 'This install carries no copy of the skills.' });
  }
  if (process.platform !== 'darwin') {
    return res.status(501).json({ ok: false, reason: 'unsupported', error: 'The zip is made with macOS’s ditto; copy the folder instead.', folder: path.join(dir, name) });
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'curator-skill-'));
  const zip = path.join(tmp, `${name}.zip`);
  execFile('ditto', ['-c', '-k', '--keepParent', path.join(dir, name), zip], { timeout: 15000 }, (err) => {
    if (err) { rmSync(tmp, { recursive: true, force: true }); return res.status(500).json({ ok: false, error: err.message }); }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    const s = createReadStream(zip);
    s.on('close', () => rmSync(tmp, { recursive: true, force: true }));
    s.pipe(res);
  });
});

export default router;
