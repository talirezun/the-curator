/**
 * The Setup check's endpoints (v3.77.0; v3.78.0 additions marked).
 *
 *   GET  /api/setup/machine                         → Settings › MCP bridge › Tools on this Mac
 *   GET  /api/setup/projects/:domain/:project       → Context › project › step 5 "Setup"
 *   GET  /api/setup/projects/:domain/:project/file?name=  (v3.79.0) → one repository file's text,
 *                                                     for the reader; its OWN allow-list (see there)
 *   PUT  /api/setup/projects/:domain/:project/repo  → {path} | {path: null} — this machine only
 *   PUT  /api/setup/tools                           → {ids: [...]} — the "+ Add a tool" choice
 *                                                     {custom: {name}} | {removeCustom: name} (v3.78.0)
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
 *
 * v3.78.0 READS THREE MORE THINGS, each reduced before it leaves:
 *   - `.curator-machine-id` / `.curator-install-id` in every Curator install
 *     found on this Mac (the app's user-data folder, the Mac app's
 *     Application Support folder, a set repository that is a Curator
 *     checkout, and the install each my-curator MCP entry launches) — so a
 *     Mac app and a source checkout on one laptop read as ONE computer;
 *   - ~/.claude.json's `projects` KEYS (folder paths) — only a key whose
 *     folder's `.curator-project` names this project ever leaves
 *     (`findRepoCandidates`), and no value under any key is read at all;
 *   - the hook activity log's session-start `repo` paths for this project.
 */
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  closeSync, createReadStream, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync,
} from 'node:fs';
import { APP_SUPPORT_DIR_NAME, appPath, getUserDataDir } from '../brain/paths.js';
import { describeInstall } from '../brain/install-mode.js';
import {
  getDomainsDir, getProjectRepo, setProjectRepo, getSetupTools, setSetupTools,
  getSetupCustomTools, setSetupCustomTools, SETUP_CUSTOM_TOOL_RE, SETUP_CUSTOM_TOOLS_MAX,
} from '../brain/config.js';
import { listDomains } from '../brain/files.js';
import * as workingState from '../brain/working-state.js';
import {
  analyseInstructionText, collectMachineSetup, collectProjectSetup, findRepoCandidates, inspectGitFile, inspectMarker,
  readJsonFile, SKILL_NAMES, STATES, TRAVELS,
} from '../brain/setup-check.js';
import { adapterFor, displayTemplate, listHarnesses, mcpEntryFor, MCP_SERVER_NAME } from '../brain/harness-adapters.js';
import { normaliseHarness } from '../brain/harness-names.js';
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

/** Every path a project result offers to reveal: fix buttons and evidence. */
function listRevealPaths(result) {
  for (const f of result.toFix || []) {
    for (const x of [f.fix, ...(Array.isArray(f.fixes) ? f.fixes : [])]) {
      if (x && x.kind === 'reveal' && typeof x.path === 'string' && path.isAbsolute(x.path)) revealable.add(x.path);
    }
  }
  for (const t of result.tools || []) {
    for (const e of t.evidence || []) if (typeof e.reveal === 'string' && path.isAbsolute(e.reveal)) revealable.add(e.reveal);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// THIS MAC (v3.78.0): every Curator install found here, and its identity
// ─────────────────────────────────────────────────────────────────────────

const MACHINE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/** The Mac app's Application Support folder, under THIS route's home (a test seam). */
function appSupportDir() {
  // An isolated suite that did not name a fake home must not be handed the
  // maintainer's real install identity (candidateUsageLogPaths' rule).
  if (process.env.CURATOR_TEST_USER_DATA_DIR && !homeOverride && !process.env.CURATOR_TEST_SETUP_HOME) return null;
  const h = home();
  return h ? path.join(h, 'Library', 'Application Support', APP_SUPPORT_DIR_NAME) : null;
}

/** A folder that is a checkout of this repository (its package.json names it). */
function isCuratorCheckout(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'the-curator' && existsSync(path.join(dir, 'bin', 'curator.js'));
  } catch { return false; }
}

/**
 * The folder holding an install's `.curator-machine-id`, from OUR MCP entry
 * in a harness config: a source checkout keeps it at its root (user data IS
 * the checkout); the Mac app keeps it in Application Support, which its
 * launcher shim lives under (`…/The Curator/bin/…`).
 */
function installDirFromEntry(f) {
  const out = [];
  const support = appSupportDir();
  if (typeof f.serverScript === 'string' && f.serverScript.startsWith('/')) {
    const root = path.resolve(f.serverScript, '..', '..');
    if (/\.app\/Contents\//.test(`${root}/`)) { if (support) out.push({ dir: support, kind: 'app' }); }
    else if (isCuratorCheckout(root)) out.push({ dir: root, kind: 'source' });
  }
  if (typeof f.command === 'string' && f.command.startsWith('/')) {
    const binDir = path.dirname(f.command);
    if (path.basename(binDir) === 'bin' && path.basename(path.dirname(binDir)) === APP_SUPPORT_DIR_NAME) {
      out.push({ dir: path.dirname(binDir), kind: 'app' });
    }
  }
  return out;
}

/**
 * Every Curator install on this Mac: `[{dir, kind, machineId, installId}]`.
 * Read-only; a folder with neither id file contributes nothing.
 */
async function localInstalls({ repoPath = null, machineRows = [], candidatePaths = [] } = {}) {
  const support = appSupportDir();
  const dirs = [];
  const add = (dir, kind) => { if (dir) dirs.push({ dir, kind }); };
  const kindOf = (dir) => (support && dir === support ? 'app' : 'source');
  // The kind is read off WHERE the folder is (the Mac app keeps user data in
  // Application Support), never off the install form — this route does not
  // branch on the form (test-install-mode.js).
  try { const d = getUserDataDir(); add(d, kindOf(d)); } catch { /* none */ }
  try {
    const { candidateUsageLogPaths } = await import('../brain/mcp-usage.js');
    for (const f of candidateUsageLogPaths()) { const d = path.dirname(f); add(d, kindOf(d)); }
  } catch { /* none */ }
  add(support, 'app');
  if (repoPath && isCuratorCheckout(repoPath)) add(repoPath, 'source');
  // A repository CANDIDATE that is a Curator checkout is on this Mac by
  // construction (it exists here), so its machine id is this computer's too —
  // without it, a project with no repository set read the checkout's saves as
  // a second computer (orchestrator screen review, 2026-09-28). Only the
  // candidates already found; the search is not widened.
  for (const p of candidatePaths) if (isCuratorCheckout(p)) add(p, 'source');
  for (const r of machineRows) {
    for (const f of r.files || []) if (f.named) for (const x of installDirFromEntry(f)) add(x.dir, x.kind);
  }
  const seen = new Set();
  const out = [];
  for (const { dir, kind } of dirs) {
    let real = dir;
    try { real = realpathSync(dir); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    let machineId = null;
    let installId = null;
    try {
      const v = readFileSync(path.join(real, workingState.MACHINE_ID_FILENAME), 'utf8').trim();
      if (MACHINE_ID_RE.test(v)) machineId = v;
    } catch { /* not minted here */ }
    try {
      const v = readFileSync(path.join(real, workingState.INSTALL_ID_FILENAME), 'utf8').trim();
      if (workingState.INSTALL_ID_RE.test(v)) installId = v;
    } catch { /* not minted here */ }
    if (machineId || installId) out.push({ dir: real, kind, machineId, installId });
  }
  return out;
}

function machineFacts(installs) {
  const ids = [...new Set(installs.map((x) => x.machineId).filter(Boolean))];
  return {
    ids,
    installIds: [...new Set(installs.map((x) => x.installId).filter(Boolean))],
    installs: installs.map((x) => ({ installId: x.installId, machineId: x.machineId, kind: x.kind })),
  };
}

async function hookSummary(project = null) {
  try {
    const { readHookLines, summariseHookActivity } = await import('../brain/hook-log.js');
    const { lines } = await readHookLines();
    return summariseHookActivity(lines, { project });
  } catch { return {}; }
}

function launchLine() {
  try { return buildCuratorEntry(getDomainsDir()); } catch { return null; }
}

function copyEntries(rows) {
  const launch = launchLine();
  const out = {};
  for (const r of rows) {
    if (!launch) break;
    const e = mcpEntryFor(r.id, launch);
    if (e && e.ok && typeof e.text === 'string') out[r.id] = e.text;
  }
  return out;
}

/**
 * The generic `mcpServers` entry for a tool no adapter knows (v3.78.0): the
 * ONE launch line (`buildCuratorEntry`), in the shape most MCP clients read.
 */
function genericSnippet(launch) {
  if (!launch) return null;
  const entry = { command: launch.command };
  if (Array.isArray(launch.args) && launch.args.length) entry.args = launch.args;
  return { format: 'json', text: `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: entry } }, null, 2)}\n` };
}

/** The "+ Add a tool" menu (v3.78.0): every adapter the app can write an MCP entry for. */
function addableFor(shownIds) {
  const shown = new Set(shownIds);
  const known = listHarnesses()
    .filter((id) => !shown.has(id) && adapterFor(id)?.mcpConfig)
    .map((id) => {
      const a = adapterFor(id);
      const cfg = a.mcpConfig;
      const paths = [...(cfg.user || []), ...(cfg.project || [])].map(displayTemplate);
      const measured = cfg.verified === true && paths.length > 0;
      const names = a.instructionFile?.names || [];
      const detail = [
        measured ? `MCP entry in ${paths.join(' or ')}` : 'config location not measured — copy the entry by hand',
        names.length ? `reads ${names.join(' and ')}` : 'reads no instruction file The Curator knows',
      ].join(' · ');
      // v3.80.0 (additive): the menu's two-line row reads these, not `detail`
      // — `reads` for "reads AGENTS.md", `configPaths` (the tool's own user
      // paths first) for "MCP config in ~/.codex". `detail` stays for a
      // v3.79.0 view.
      return { id, label: a.label, group: 'known', detail, measured, reads: [...names], configPaths: measured ? paths : [] };
    });
  return [...known, { id: '__custom', label: 'Custom tool…', group: 'other', detail: 'Any other MCP client: a generic entry, AGENTS.md and the skill .zip files.', measured: false, reads: ['AGENTS.md'], configPaths: [] }];
}

function customToolIds() {
  return getSetupCustomTools().map((n) => {
    const h = normaliseHarness(n);
    return h ? { id: h.id, label: h.label } : null;
  }).filter(Boolean);
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

/**
 * Repository candidates for a project with none set (v3.78.0), in the
 * contract's detection order. See `findRepoCandidates` for what may leave.
 */
async function repoCandidates(domain, project) {
  const h = home();
  const sources = [];
  // 1. The folders Claude Code has opened — KEYS only.
  try {
    const cj = readJsonFile(path.join(h, '.claude.json'));
    const pj = cj.status === 'ok' && cj.json && typeof cj.json.projects === 'object' && !Array.isArray(cj.json.projects) ? cj.json.projects : null;
    if (pj) for (const k of Object.keys(pj).slice(0, 1000)) sources.push({ path: k, why: 'claude-code' });
  } catch { /* none */ }
  // 2. The project's recorded foundation folders that are here.
  try {
    for (const s of await workingState.foundationFolderSources(domain, project)) if (s.reachable) sources.push({ path: s.root, why: 'foundations' });
  } catch { /* none */ }
  // 3. The folders a Curator hook started a session in for this project.
  try {
    const { readHookLines } = await import('../brain/hook-log.js');
    const { lines } = await readHookLines();
    for (const l of [...lines].reverse()) {
      if (l.event === 'session-start' && l.project === `${domain}/${project}` && typeof l.repo === 'string') sources.push({ path: l.repo, why: 'hook-log' });
    }
  } catch { /* none */ }
  // 4. GitHub repositories the foundations mirror, for a git-remote match.
  let githubRepos = [];
  try {
    const f = await workingState.listFoundations(domain, project);
    if (f && f.ok && Array.isArray(f.sources)) githubRepos = f.sources.filter((s) => s.remote).map((s) => `${s.remote.owner}/${s.remote.repo}`);
  } catch { githubRepos = []; }
  return findRepoCandidates({ home: h, domain, project, sources, githubRepos });
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
    const installs = await localInstalls({ machineRows: rows });
    const mf = machineFacts(installs);
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
      machine: { ids: mf.ids, split: mf.ids.length > 1, installIds: mf.installIds, installs: mf.installs },
      bridgeProcesses,
      harnesses: shown,
      copyEntries: copyEntries(shown),
      customTools: getSetupCustomTools(),
      addable: addableFor(shown.map((r) => r.id)),
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
    res.json(await projectPayload(ctx.domain, ctx.project));
  } catch (err) {
    console.error('Setup project check error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** The whole project check, as the GET answers it (also run by the file reader when it has no tool list yet). */
async function projectPayload(domain, project) {
  {
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
      // `pending` counts EVERY domain's changes, and Sync now pushes and
      // pulls the whole knowledge folder — `scope` says so (v3.78.0), so a
      // view never words it as this project's count.
      sync = { configured: st.configured === true, scope: 'all-domains', lastSync: st.lastSync || null, pending: Number.isInteger(st.changesCount) ? st.changesCount : null };
      if (sync.configured) {
        const { readRemoteIncoming } = await import('../brain/tray-summary.js');
        const inc = readRemoteIncoming();
        sync.incoming = inc && inc.ok ? inc.files : null;
        sync.incomingCheckedAt = inc ? inc.checkedAt : null;
        sync.behindFiles = inc && inc.ok ? inc.behindFiles : null;
        // The remote check keeps at most 20 file paths; past that, a waiting
        // handoff may not be named — say the list is partial.
        sync.incomingCapped = !!(inc && inc.ok && (Number.isInteger(inc.behindFiles)
          ? inc.behindFiles > inc.files.length : inc.files.length >= 20));
      }
    } catch { sync = { configured: false, scope: 'all-domains', error: true }; }
    // Candidates first: a candidate that is a Curator checkout is an install
    // on this Mac, and its machine id must be known before saves are grouped.
    const candidates = repoPath ? [] : await repoCandidates(domain, project);
    const installs = await localInstalls({
      repoPath: repo?.exists ? repoPath : null, machineRows, candidatePaths: candidates.map((c) => c.path),
    });
    const mf = machineFacts(installs);
    // v3.79.0 — each instruction file's git standing (read-only, no fetch),
    // so a line can say "current here but not pushed". Only files that exist,
    // and only when the folder is a git repository.
    const instructionGit = {};
    if (repo?.exists && marker?.git?.repo) {
      for (const n of instructionFileNames()) {
        let isFile = false;
        try { isFile = statSync(path.join(repoPath, n)).isFile(); } catch { isFile = false; }
        if (isFile) instructionGit[n] = await inspectGitFile(repoPath, n);
      }
    }
    const result = collectProjectSetup({
      domain, project, pairs, machine: mf, machineRows, home: home(),
      repo, marker, template: TEMPLATE, addedTools: getSetupTools(), customTools: customToolIds(),
      sync, thisVersion: appVersion(), instructionGit,
    });
    listedTools.set(`${domain}/${project}`, result.tools.map((t) => ({ id: t.id, label: t.label, custom: !!t.custom })));
    // Copyable entries and skill links on each row (v3.78.0).
    const launch = launchLine();
    const zips = skillsDir() ? SKILL_NAMES.map((n) => ({ name: n, href: `/api/setup/skills/${n}.zip` })) : [];
    for (const t of result.tools) {
      if (t.custom) {
        t.mcpSnippet = genericSnippet(launch);
        t.skillZips = zips;
      } else if (launch) {
        const e = mcpEntryFor(t.id, launch);
        if (e && e.ok) t.mcpSnippet = { format: e.format, text: e.text };
        const cfg = adapterFor(t.id)?.mcpConfig;
        t.measured = !!(cfg && cfg.verified === true && ((cfg.user || []).length + (cfg.project || []).length) > 0);
      }
    }
    // Fix buttons that need what only the route knows (v3.79.0): the entry
    // text for "Copy MCP entry", and whether this install carries the skill
    // zips. A button that cannot work is dropped, never shown dead.
    const snippets = new Map(result.tools.map((t) => [t.id, t.mcpSnippet?.text || null]));
    for (const f of result.toFix) {
      if (!Array.isArray(f.fixes)) continue;
      f.fixes = f.fixes.map((x) => (x.kind === 'copy-snippet' ? (snippets.get(x.tool) ? { ...x, text: snippets.get(x.tool) } : null) : x))
        .filter((x) => x && !(x.kind === 'download-skill' && !zips.length));
      f.fix = f.fixes[0] || null;
    }
    // The repository's own files are revealable too: the folder, and every
    // instruction file a listed tool reads (it may not exist yet — reveal then
    // opens the folder, which is where the owner creates it).
    if (repo?.exists) {
      revealable.add(repoPath);
      for (const t of result.tools) {
        const names = t.custom ? ['AGENTS.md'] : (adapterFor(t.id)?.instructionFile?.names || []);
        for (const n of names) revealable.add(path.join(repoPath, n));
      }
      if (result.repo) result.repo.display = tilde(repoPath);
    }
    listRevealPaths(result);
    return withDisplay({
      ok: true,
      checkedAt: new Date().toISOString(),
      ...result,
      repoCandidates: candidates,
      // v3.77.0's field, same data, kept for one release (v3.78.0).
      repoSuggestions: candidates.map((c) => ({ root: c.path, reachable: true, inGit: existsSync(path.join(c.path, '.git')), rootDisplay: c.display })),
      machine: { ids: mf.ids, split: mf.ids.length > 1, installIds: mf.installIds, installs: mf.installs },
      markerLine: `${domain}/${project}`,
      addedTools: getSetupTools(),
      customTools: getSetupCustomTools(),
      addable: addableFor(result.tools.map((t) => t.id)),
      states: STATES,
      travels: TRAVELS,
    });
  }
}

// ── GET /projects/:domain/:project/file?name= (v3.79.0) ───────────────────
//
// The reader for ONE repository file: `.curator-project` or an instruction
// file. SECURITY — this route returns file TEXT, which nothing else here does:
//   - the folder comes ONLY from getProjectRepo (this machine's config),
//     never from the request;
//   - `name` must be one of READABLE_NAMES exactly — its OWN narrow list,
//     never the reveal set (that set holds ~/.claude.json and MCP configs,
//     which carry other servers' keys);
//   - both the folder and the file are realpath'd; the file must resolve
//     INSIDE the folder (defeats `..`, absolute names and symlinks leading
//     out), and the file it resolves to must itself carry an allowed name (a
//     symlink AGENTS.md → CLAUDE.md is fine; AGENTS.md → .claude.json in a
//     folder set to ~ is refused);
//   - a regular file only; at most FILE_TEXT_CAP bytes of text go out.
const FILE_TEXT_CAP = 256 * 1024;
const FILE_ANALYSE_CAP = 4 * 1024 * 1024;

/** Every instruction-file name any tool reads, plus AGENTS.md (the custom-tool convention). */
function instructionFileNames() {
  const out = new Set(['AGENTS.md']);
  for (const id of listHarnesses()) for (const n of adapterFor(id)?.instructionFile?.names || []) out.add(n);
  return [...out];
}

/**
 * The reader's allow-list: the marker, and the instruction-file names of the
 * tools this project LISTS (AGENTS.md for a custom tool). A name no listed
 * tool reads is refused, even if some other adapter reads it.
 */
function readableNames(listed) {
  const out = new Set(['.curator-project']);
  for (const t of listed) {
    const names = t.custom ? ['AGENTS.md'] : (adapterFor(t.id)?.instructionFile?.names || []);
    for (const n of names) out.add(n);
  }
  return out;
}

/** Tools listed for a project in its last check, keyed `domain/project`. */
const listedTools = new Map();

router.get('/projects/:domain/:project/file', async (req, res) => {
  try {
    const ctx = await checkProject(req, res);
    if (!ctx) return;
    const { domain, project } = ctx;
    const refuse = (status, reason, error) => res.status(status).json({ ok: false, reason, error });
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    const key = `${domain}/${project}`;
    const repoPath = getProjectRepo(domain, project);
    if (!repoPath) return refuse(409, 'repo_not_set', 'Set this project’s folder first.');
    if (!listedTools.has(key)) await projectPayload(domain, project);
    const listed = listedTools.get(key) || [];
    const allowed = readableNames(listed);
    if (!name || !allowed.has(name)) return refuse(400, 'not_allowed', 'Only .curator-project and the instruction files a listed tool reads can be opened here.');
    let realRepo;
    try {
      realRepo = realpathSync(repoPath);
      if (!statSync(realRepo).isDirectory()) throw new Error('not a folder');
    } catch { return refuse(409, 'repo_missing', 'The folder set for this project is not on this computer.'); }
    const base = {
      ok: true, name, travels: TRAVELS.PROJECT_GIT, repoDisplay: tilde(repoPath),
    };
    // What a tool reading this name caps it at: the smallest cap among the
    // LISTED tools that read it.
    const capOf = () => {
      let best = null;
      for (const t of listed) {
        const f = t.custom ? null : adapterFor(t.id)?.instructionFile;
        if (f && f.cap && (f.names || []).includes(name) && (!best || f.cap < best.bytes)) best = { bytes: f.cap, tool: t.label, toolId: t.id };
      }
      return best;
    };
    const candidate = path.join(realRepo, name);
    let realFile = null;
    try { realFile = realpathSync(candidate); } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        // Not there (or a dangling link): the reader explains what goes here.
        return res.json({ ...base, exists: false, text: '', bytes: 0, mtime: null, mtimeMs: null, truncated: false, block: null, cap: name === '.curator-project' ? null : capOf(), ...(name === '.curator-project' ? { marker: { present: false } } : {}) });
      }
      return refuse(403, 'unreadable', 'That file could not be opened.');
    }
    const rel = path.relative(realRepo, realFile);
    if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
      return refuse(403, 'outside_folder', 'That file is outside the project’s folder.');
    }
    if (!allowed.has(rel) && !allowed.has(path.basename(realFile))) {
      return refuse(403, 'not_allowed', 'That name points at a file that is not an instruction file.');
    }
    let fd = null;
    let buf;
    let st;
    try {
      fd = openSync(realFile, 'r');
      st = fstatSync(fd);
      if (!st.isFile()) return refuse(403, 'not_a_file', 'That is not a file.');
      const want = Math.min(st.size, FILE_ANALYSE_CAP);
      buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const n = readSync(fd, buf, got, want - got, got);
        if (n <= 0) break;
        got += n;
      }
      buf = buf.subarray(0, got);
    } catch { return refuse(403, 'unreadable', 'That file could not be read.'); }
    finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
    const raw = buf.toString('utf8');
    const norm = raw.replace(/\r\n/g, '\n');
    const normBuf = Buffer.from(norm);
    const truncated = st.size > FILE_TEXT_CAP || normBuf.length > FILE_TEXT_CAP;
    const text = normBuf.length > FILE_TEXT_CAP ? normBuf.subarray(0, FILE_TEXT_CAP).toString('utf8').replace(/�+$/, '') : norm;
    const out = {
      ...base, exists: true, text, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), mtimeMs: st.mtimeMs, truncated,
      block: null, cap: null,
    };
    if (name === '.curator-project') {
      const mk = await inspectMarker(realRepo, { domain, project });
      out.marker = {
        present: mk.present, line: mk.line, namesThis: mk.namesThis,
        committed: mk.git?.repo ? mk.git.committed ?? null : null,
        pushed: mk.git?.repo ? mk.git.pushed ?? null : null,
        gitRepo: !!mk.git?.repo,
      };
      return res.json(out);
    }
    const cap = capOf();
    const a = analyseInstructionText(raw, { domain, project, template: TEMPLATE, cap: cap ? cap.bytes : null });
    if (a.hasBlock && Number.isInteger(a.blockStart)) {
      const state = a.wrongProject ? 'wrong-project' : !a.current ? 'outdated' : (cap && a.blockPastCap) ? 'past-cap' : 'current';
      out.block = {
        start: a.blockStart, end: a.blockEnd, state, pill: state === 'current' ? 'ok' : 'fix',
        namesProject: a.namesProject, startBytes: a.blockStartBytes, endBytes: a.blockEndBytes,
      };
    } else if (a.hasBlock) {
      out.block = { start: null, end: null, state: a.wrongProject ? 'wrong-project' : a.current ? 'current' : 'outdated', pill: a.current && !a.wrongProject ? 'ok' : 'fix', namesProject: a.namesProject };
    }
    if (cap) {
      // The char offset in `text` where the tool stops reading, or null when
      // the whole file fits.
      let at = null;
      if (st.size > cap.bytes) {
        const prefix = buf.subarray(0, cap.bytes).toString('utf8').replace(/�+$/, '');
        at = prefix.replace(/\r\n/g, '\n').length;
      }
      out.cap = { ...cap, at };
    }
    out.git = await inspectGitFile(realRepo, rel).then((g) => ({ committed: g.committed ?? null, pushed: g.pushed ?? null, gitRepo: !!g.repo }));
    res.json(out);
  } catch (err) {
    console.error('Setup file read error:', err);
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
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // v3.78.0 — a tool the user NAMES ("Custom tool…").
  if (Object.hasOwn(body, 'custom')) {
    const name = body.custom && typeof body.custom.name === 'string' ? body.custom.name.trim() : '';
    if (!SETUP_CUSTOM_TOOL_RE.test(name)) {
      return res.status(400).json({ ok: false, reason: 'invalid_name', error: 'A tool name is 1–40 characters: letters, digits, spaces, dot, underscore or hyphen.' });
    }
    const n = normaliseHarness(name);
    // A name that IS a known tool ("claude code", "DSH") joins the known list.
    if (n && adapterFor(n.id)) {
      const ids = setSetupTools([...getSetupTools(), n.id]);
      return res.json({ ok: true, ids, custom: getSetupCustomTools(), added: { id: n.id, known: true } });
    }
    const current = getSetupCustomTools();
    if (current.some((x) => normaliseHarness(x)?.id === n.id)) {
      return res.json({ ok: true, ids: getSetupTools(), custom: current, added: { id: n.id, known: false } });
    }
    if (current.length >= SETUP_CUSTOM_TOOLS_MAX) {
      return res.status(409).json({ ok: false, reason: 'too_many', error: `At most ${SETUP_CUSTOM_TOOLS_MAX} custom tools. Remove one first.` });
    }
    const custom = setSetupCustomTools([...current, n.label]);
    return res.json({ ok: true, ids: getSetupTools(), custom, added: { id: n.id, known: false } });
  }
  if (Object.hasOwn(body, 'removeCustom')) {
    const name = typeof body.removeCustom === 'string' ? body.removeCustom.trim() : '';
    const n = name ? normaliseHarness(name) : null;
    if (!n) return res.status(400).json({ ok: false, reason: 'invalid_name', error: 'Send {"removeCustom": "<name>"}.' });
    const custom = setSetupCustomTools(getSetupCustomTools().filter((x) => normaliseHarness(x)?.id !== n.id));
    return res.json({ ok: true, ids: getSetupTools(), custom });
  }
  const ids = Array.isArray(body.ids) ? body.ids : null;
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
