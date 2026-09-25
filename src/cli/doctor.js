/**
 * `my-curator doctor` — what is wired on this machine, and what is not.
 *
 * It PRINTS and it WRITES NOTHING, including the harness config files it
 * reads. Wiring a harness is `my-curator install-hooks` (package H); this
 * command's whole job is to report, so that a user whose capture is not
 * working can see which of the six things it depends on is missing.
 *
 * **Exit 0 always. A doctor that fails is a doctor nobody runs.** Every
 * reader below is wrapped: an unreadable file, an unparseable config, a
 * missing home directory and a store that refuses are all REPORTED, never
 * fatal and never a non-zero exit.
 *
 * ── THE ELASTIC COLLISION, REPORTED RATHER THAN CAUSED ─────────────────────
 * `elasticsearch-curator` is ≈57k downloads a week and owns `/usr/bin/curator`
 * on Debian; `config-curator` ships a `curator` bin on npm. This package
 * therefore declares ONE bin, `my-curator`, and never links `curator` — no
 * postinstall, no silent alias. `--alias` prints the command to make the short
 * name yourself and REFUSES to print it when `curator` already resolves
 * somewhere else, naming what it found.
 *
 * ── WHAT IT DOES NOT DO, STATED ────────────────────────────────────────────
 * It compares a harness entry's recorded `--domains-path` against the resolved
 * domains folder, which catches the common staleness (the folder moved). It
 * does NOT re-derive the whole launch line: `buildCuratorEntry` in
 * `src/routes/mcp.js` is the one source for that, a second copy here would be
 * exactly the drift v3.6.1 recorded, and this command must not pull the
 * Express graph into a CLI's startup. The stale-entry comparison the wizard
 * makes is the wizard's.
 */
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants as FS } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  MCP_SERVER_NAME, adapterFor, listHarnesses, resolveTemplates, skillRootsFor,
} from '../brain/harness-adapters.js';
import { STALE_REMEDY } from '../brain/mcp-bridge-status.js';
import { EXIT_OK, out, note, flagStr, flagBool, findMarker, resolveProjectForCli } from './resolve.js';

export const DOCTOR_USAGE = 'my-curator doctor [--project <domain/project>] [--json] [--alias]';

/**
 * Codex truncates its instruction file at this many bytes, silently.
 *
 * Kept as a named export because two suites import it, but it is no longer the
 * value this file USES: the cap that reaches a report comes off the adapter
 * table's `instructionFile.cap`, and the assertion below is what stops the two
 * drifting rather than a comment asking somebody to remember.
 */
export const CODEX_DOC_MAX_BYTES = 32 * 1024;

const HOME = (() => { try { return os.homedir(); } catch { return ''; } })();
const home = (...p) => (HOME ? path.join(HOME, ...p) : '');

/**
 * Where each harness keeps its MCP servers, its hooks, and the file it will
 * actually read for instructions — DERIVED, since v3.64.0, from
 * `src/brain/harness-adapters.js` rather than typed out a second time here.
 *
 * ── WHY THE COPY IS GONE ───────────────────────────────────────────────────
 *
 * Until v3.64.0 this function hand-listed about forty absolute paths that had
 * to agree, file by file, with the adapter table's own. That table's docblock
 * named the seam in terms — "the right end state is that `doctor.js` imports
 * `harnessTargets` from THIS file" — and `scripts/test-harness-adapters.js` §4
 * existed only to make the drift non-silent by comparing the two for set
 * equality. Two hand-maintained copies of one thing is the defect this
 * repository records most often; the copy is what has been removed, not the
 * check. (§4 now asserts that the derivation is faithful rather than that two
 * authors stayed in step — a weaker but honest reading, and it is the
 * orchestrator's call whether to re-point it.)
 *
 * The adapter table imports NO Node builtin, by design, so this costs a CLI
 * startup nothing but a frozen object graph.
 *
 * ── WHICH HARNESSES GET A ROW, AND WHY THAT IS A RULE RATHER THAN A LIST ───
 *
 * A harness is reported when doctor has somewhere to LOOK — at least one
 * measured MCP config location — or when it has no MCP client at all
 * (`mcpConfig === null`, which today is Aider alone, and saying so is the
 * whole content of its row).
 *
 * `kilo` and `dsh` fail both tests: the table carries a config FORMAT for each
 * and zero paths, because their file locations are unmeasured and it says so.
 * They are therefore exactly the harnesses this command cannot look for, and
 * reporting "not configured" about a file nobody looked for is the failure
 * this file's original docblock already refused. Those two are excluded by the
 * rule, not by name — measure a path for either and its row appears.
 *
 * ── THE THREE SHAPES THAT ARE DERIVED RATHER THAN CARRIED ──────────────────
 *
 *   kind   — the config FORMAT decides how the file is inspected: `json` is
 *            parsed, `toml` is line-scanned (this package ships no TOML
 *            reader), anything else is `opaque` — present or absent and no
 *            claim about its contents. Goose's YAML is the only `opaque` one.
 *   tomlKey— `[<key>.<server name>]`, composed from the table's own `key`, so
 *            a harness that renames its table needs no edit here.
 *   dir    — a hook target with NO file extension is a DIRECTORY (Copilot
 *            CLI's `~/.copilot/hooks`); one with an extension is a file
 *            (goose's `hooks.json`). A rule over the shape, because the table
 *            does not carry the distinction and inventing a field in it would
 *            be editing a file this package does not own.
 */
export function harnessTargets(cwd) {
  const dirs = { home: HOME, project: cwd };
  const kindFor = (format) => (format === 'json' ? 'json' : format === 'toml' ? 'toml' : 'opaque');
  const rows = [];
  for (const id of listHarnesses()) {
    const a = adapterFor(id);
    if (!a) continue;
    const cfg = a.mcpConfig || null;
    const mcpFiles = cfg
      ? [...resolveTemplates(cfg.user || [], dirs), ...resolveTemplates(cfg.project || [], dirs)]
      : [];
    if (cfg && mcpFiles.length === 0) continue;   // nowhere measured to look
    const kind = cfg ? kindFor(cfg.format) : 'json';
    const row = {
      id: a.id,
      label: a.label,
      mcp: mcpFiles.map((file) => ({
        file,
        kind,
        key: cfg?.key || null,
        tomlKey: kind === 'toml' ? `[${cfg.key}.${MCP_SERVER_NAME}]` : undefined,
      })),
      hooks: ['user', 'project', 'local']
        .flatMap((scope) => resolveTemplates(a.hooks?.configPath?.[scope] || [], dirs))
        .map((file) => ({ file, kind: path.extname(file) ? 'json' : 'dir' })),
      instructions: (a.instructionFile?.names || []).map((name) => {
        const rec = { file: path.join(cwd, name) };
        if (a.instructionFile.cap) rec.maxBytes = a.instructionFile.cap;
        if (a.instructionFile.fromSetting) rec.fromSetting = a.instructionFile.fromSetting;
        return rec;
      }),
    };
    if (a.instructionFile?.firstMatch) row.firstMatch = true;
    if (!cfg) row.noMcpClient = true;
    rows.push(row);
  }
  return rows;
}

function readJsonFile(file) {
  try {
    if (!existsSync(file)) return { present: false };
    const text = readFileSync(file, 'utf8');
    try { return { present: true, json: JSON.parse(text), bytes: Buffer.byteLength(text) }; }
    catch (err) { return { present: true, parseError: err.message, bytes: Buffer.byteLength(text) }; }
  } catch (err) { return { present: false, readError: err.message }; }
}

/** Does this JSON config name the my-curator MCP server, and where does it point? */
function inspectMcpFile(target) {
  if (target.kind === 'toml') {
    // A LINE SCAN, not a TOML parse — Node ships no TOML reader and this
    // package adds no dependency. It answers one question (is the table
    // there?) and says so; it cannot report a malformed file.
    try {
      if (!existsSync(target.file)) return { present: false };
      const text = readFileSync(target.file, 'utf8');
      const named = text.split('\n').some((l) => l.trim().startsWith(target.tomlKey));
      return { present: true, named, scan: 'line-scan (no TOML parser — a malformed file cannot be detected)' };
    } catch (err) { return { present: false, readError: err.message }; }
  }
  if (target.kind === 'dir') {
    try { return { present: existsSync(target.file) && statSync(target.file).isDirectory() }; }
    catch { return { present: false }; }
  }
  if (target.kind === 'opaque') {
    return { present: existsSync(target.file), opaque: true };
  }
  const r = readJsonFile(target.file);
  if (!r.present || r.parseError) return r;
  const servers = r.json?.[target.key];
  const entry = servers && typeof servers === 'object' ? servers[MCP_SERVER_NAME] : undefined;
  if (!entry) return { present: true, named: false };
  const args = Array.isArray(entry.args) ? entry.args : [];
  const i = args.indexOf('--domains-path');
  return {
    present: true, named: true,
    command: typeof entry.command === 'string' ? entry.command : null,
    domainsPath: i !== -1 && typeof args[i + 1] === 'string' ? args[i + 1] : null,
  };
}

/** A Curator hook command, in any form install-hooks writes. */
const OUR_HOOK_RE = /curator(?:\.js)?['"]?\s+hook\s/;

/**
 * Curator hook entries in a harness config, and the two that are ACCEPTED AND
 * INERT: a Cline `PreCompact` (accepted, maps to `undefined`, never fires) and
 * a Codex `SessionEnd` (1 s default, 3 s maximum — not an MCP round trip).
 * Reported as present and useless with the measured reason, because a config
 * that looks wired and is not is worse than one that is plainly empty.
 */
export function inspectHookFile(harnessId, file) {
  const r = readJsonFile(file);
  if (!r.present || r.parseError) return r;
  const text = JSON.stringify(r.json);
  // `curator.js hook` too: install-hooks writes `<node> <repo>/bin/curator.js
  // hook …` when no `my-curator` is on PATH, and the older pattern missed
  // exactly that form (found v3.76.0, on the first Antigravity file).
  const ours = OUR_HOOK_RE.test(text);
  const events = [];
  const inert = [];
  const spec = adapterFor(harnessId)?.hooks;
  if (spec?.fileShape === 'named-hooks') {
    // Top-level keys are hook NAMES; the events are one level down. A named
    // hook switched off with `"enabled": false` runs none of its handlers,
    // which makes a Curator entry inside it present and inert.
    const doc = r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? r.json : {};
    for (const [name, hook] of Object.entries(doc)) {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) continue;
      for (const k of Object.keys(hook)) if (k !== 'enabled' && !events.includes(k)) events.push(k);
      if (hook.enabled === false && OUR_HOOK_RE.test(JSON.stringify(hook))) {
        inert.push(`"${name}" — this named hook is switched off (\`"enabled": false\`), so its Curator handlers never run`);
      }
    }
    return { present: true, ours, events, inert };
  }
  const hooks = r.json?.hooks && typeof r.json.hooks === 'object' ? r.json.hooks : r.json;
  if (hooks && typeof hooks === 'object') for (const k of Object.keys(hooks)) events.push(k);
  if (harnessId === 'cline' && events.some((e) => /precompact/i.test(e))) {
    inert.push('PreCompact — Cline accepts this hook and maps it to `undefined`, so it NEVER fires');
  }
  if (harnessId === 'codex' && events.some((e) => /sessionend/i.test(e))) {
    inert.push('SessionEnd — Codex allows 1 s by default and 3 s at most, which cannot complete an MCP round trip');
  }
  return { present: true, ours, events, inert };
}

/**
 * The repo's own skills, file by file: `skills/<skill>/<file>` → sha256.
 * Read from THIS install's tree, so a packaged app without a `skills/`
 * folder answers `null` and the doctor says it could not compare rather
 * than calling every installed copy stale.
 */
const SKILL_NAMES = ['my-curator', 'curator-continuity'];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function repoSkillHashes(skillsDir = fileURLToPath(new URL('../../skills/', import.meta.url))) {
  if (!skillsDir) return null;
  const out = {};
  for (const name of SKILL_NAMES) {
    const dir = path.join(skillsDir, name);
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return null; }
    out[name] = Object.fromEntries(files.map((f) => [f, sha256(readFileSync(path.join(dir, f)))]));
  }
  return out;
}

/**
 * Every installed copy of the repo's skills under a harness's skill roots —
 * `<root>/skills/<skill>/` and `<root>/plugins/<plugin>/skills/<skill>/` —
 * compared file by file against the repo's. `match` is true only when every
 * repo file is present with the same bytes; a missing companion counts as
 * drift, because a SKILL.md pointing at a file that is not there is worse
 * than no mention of it.
 */
export function inspectSkills(roots, repo) {
  const found = [];
  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'skills'));
    let plugins = [];
    try { plugins = readdirSync(path.join(root, 'plugins')).sort(); } catch { plugins = []; }
    for (const p of plugins) candidates.push(path.join(root, 'plugins', p, 'skills'));
  }
  for (const dir of candidates) {
    for (const name of SKILL_NAMES) {
      const at = path.join(dir, name);
      try { if (!statSync(at).isDirectory()) continue; } catch { continue; }
      const rec = { skill: name, dir: at, match: null, differs: [], missing: [] };
      if (repo && repo[name]) {
        for (const [f, h] of Object.entries(repo[name])) {
          let got = null;
          try { got = sha256(readFileSync(path.join(at, f))); } catch { got = null; }
          if (got === null) rec.missing.push(f);
          else if (got !== h) rec.differs.push(f);
        }
        rec.match = rec.differs.length === 0 && rec.missing.length === 0;
      }
      found.push(rec);
    }
  }
  return found;
}

/** Executables named `name` on PATH, in PATH order. */
export function whichAll(name, env = process.env) {
  const found = [];
  const raw = env.PATH || env.Path || '';
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      accessSync(file, FS.X_OK);
      found.push(file);
    } catch { /* not there, or not executable */ }
  }
  return found;
}

function writable(dir) {
  try { accessSync(dir, FS.W_OK); return true; } catch { return false; }
}

export async function collectDoctor(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const report = {
    ok: true, cwd, binaries: {}, domains: {}, project: {}, usageLog: {},
    identity: {}, install: {}, bridgeProcesses: null, harnesses: [], readingPlan: null,
  };

  // ── The two names ────────────────────────────────────────────────────────
  const mine = whichAll('my-curator');
  const short = whichAll('curator');
  let selfPath = null;
  try { selfPath = path.resolve(new URL('../../bin/curator.js', import.meta.url).pathname); } catch { selfPath = null; }
  report.binaries = {
    myCurator: mine,
    curator: short,
    // `curator` resolving to something that is not this package is the Elastic
    // case, and it is NOT a defect — it is the reason this package never takes
    // that name.
    curatorIsOurs: short.length > 0 ? short.some((f) => {
      try { return readFileSync(f, 'utf8').includes('my-curator'); } catch { return false; }
    }) : false,
    selfPath,
  };

  // ── The store ────────────────────────────────────────────────────────────
  try {
    const { getDomainsDir, getConfig } = await import('../brain/config.js');
    const dir = getDomainsDir();
    let source = null;
    try { source = getConfig()?.domainsPathSource || null; } catch { source = null; }
    report.domains = { path: dir, exists: existsSync(dir), writable: existsSync(dir) && writable(dir), source };
  } catch (err) { report.domains = { error: err.message }; }

  // ── The usage log(s) — plural, on any machine that has two installs ──────
  //
  // `candidateUsageLogPaths()` owns the argument (src/brain/mcp-usage.js). The
  // first entry stays `path`, unchanged in name and meaning, because §5 of
  // scripts/test-cli-curator.js asserts on it and because "the log THIS
  // process writes" is still a useful, separate fact from "every log on this
  // machine".
  try {
    const { candidateUsageLogPaths } = await import('../brain/mcp-usage.js');
    const files = candidateUsageLogPaths();
    const stat1 = (f) => ({ path: f, present: existsSync(f), rotated: existsSync(`${f}.1`) });
    report.usageLog = {
      ...stat1(files[0]),
      candidates: files.map(stat1),
      split: files.length > 1,
    };
  } catch (err) { report.usageLog = { error: err.message }; }

  // ── THE TWO IDENTITIES, WHEN THERE ARE TWO ───────────────────────────────
  //
  // Measured 2026-09-20: one Mac, one user, two Curators — a checkout and the
  // installed `.app` — and therefore two user-data directories, two usage logs
  // and two `.curator-machine-id` files, `alices-macbook-pro-17d23c` against
  // `alices-macbook-pro-acb035`. The consequence is real and was invisible: the
  // state tree gains a SECOND `<machine>` folder for what is one computer, so
  // a handoff saved through the bridge and a handoff saved through the CLI do
  // not supersede each other — they sit side by side, and `scope: 'latest'`
  // answers with whichever was written last.
  //
  // It is DISCLOSED and nothing here acts on it. Minting is
  // `working-state.js`'s and how (or whether) the two should converge is the
  // maintainer's open question — a doctor that quietly rewrote an identity
  // file would move every folder that names it.
  //
  // The files are READ DIRECTLY rather than via `machineId()`/`installId()`,
  // which MINT one when it is missing. This command writes nothing, and that
  // includes not calling a getter with a side effect.
  try {
    const { INSTALL_ID_FILENAME, MACHINE_ID_FILENAME } = await import('../brain/working-state.js');
    const readId = (dir, name) => {
      try {
        const v = readFileSync(path.join(dir, name), 'utf8').trim();
        return v || null;
      } catch { return null; }
    };
    const dirs = [...new Set((report.usageLog.candidates || []).map((c) => path.dirname(c.path)))];
    const identities = dirs.map((dir) => ({
      dir,
      machineId: readId(dir, MACHINE_ID_FILENAME),
      installId: readId(dir, INSTALL_ID_FILENAME),
    }));
    const names = new Set(identities.map((i) => i.machineId).filter(Boolean));
    report.identity = { dirs: identities, split: names.size > 1 };
  } catch (err) { report.identity = { error: err.message }; }

  // ── Which install this command IS ────────────────────────────────────────
  try {
    const { isBundleInstall, APP_ROOT } = await import('../brain/paths.js');
    report.install = { bundle: isBundleInstall(), appRoot: APP_ROOT };
  } catch (err) { report.install = { error: err.message }; }

  // ── Bridge processes: is something still running yesterday's code? ───────
  try {
    const { detectBridgeProcesses } = await import('../brain/mcp-bridge-status.js');
    report.bridgeProcesses = await detectBridgeProcesses();
  } catch (err) {
    report.bridgeProcesses = { checked: false, reason: err.message, running: 0, stale: [] };
  }

  // ── The project, from this directory ─────────────────────────────────────
  const marker = findMarker(cwd);
  try {
    const r = await resolveProjectForCli({ project: opts.project || null, domain: opts.domain || null, cwd });
    report.project = r.ok
      ? { ok: true, domain: r.domain, project: r.project, resolvedBy: r.resolvedBy, source: r.source, marker: marker?.file || null }
      : { ok: false, message: r.message, candidates: r.candidates || [], marker: marker?.file || null };
  } catch (err) { report.project = { ok: false, message: err.message, marker: marker?.file || null }; }

  // ── The reading plan, against the bootstrap budget ───────────────────────
  // `readFirst` is the owner's lever and the honest answer to a hook budget a
  // project keeps blowing: flag less, do not raise the number.
  if (report.project.ok) {
    try {
      const { listFoundations, CONTEXT_MAX_BYTES_DEFAULT } = await import('../brain/working-state.js');
      const idx = await listFoundations(report.project.domain, report.project.project);
      if (idx.ok) {
        report.readingPlan = {
          count: idx.count,
          readFirstCount: idx.readFirstCount,
          onRequestCount: idx.onRequestCount,
          readFirstBytes: idx.readFirstBytes,
          budgetBytes: idx.readFirstBudgetBytes ?? CONTEXT_MAX_BYTES_DEFAULT,
          budgetExceeded: idx.readFirstBudgetExceeded === true,
          staleCount: idx.staleCount,
          unreachableCount: idx.unreachableCount,
        };
      } else report.readingPlan = { error: idx.reason || 'unreadable' };
    } catch (err) { report.readingPlan = { error: err.message }; }
  }

  // ── Every harness ────────────────────────────────────────────────────────
  let repoSkills = null;
  try { repoSkills = repoSkillHashes(); } catch { repoSkills = null; }
  for (const h of harnessTargets(cwd)) {
    const adapter = adapterFor(h.id);
    const row = {
      id: h.id, label: h.label, mcp: [], hooks: [], instructions: [],
      noMcpClient: !!h.noMcpClient,
      // FROM THE TABLE, never authored here (v3.64.0). `hooks.state` is one of
      // four words and `measured` is the campaign's own row — both belong to
      // `src/brain/harness-adapters.js`, and a sentence written here would be
      // a second copy of a fact somebody else is measuring. `measured` is
      // `null` on every entry until a verdict exists; when one does, this
      // prints it VERBATIM rather than paraphrasing it.
      hookState: adapter?.hooks?.state || null,
      hookReason: adapter?.hooks?.reason || null,
      measured: adapter?.measured || null,
      observations: Array.isArray(adapter?.observations) ? [...adapter.observations] : [],
    };
    // Installed skills, for a harness whose table row says where they live.
    const roots = skillRootsFor(h.id, { home: HOME, project: cwd });
    if (roots.length) {
      try {
        row.skills = { roots, repoComparable: repoSkills !== null, installed: inspectSkills(roots, repoSkills) };
      } catch (err) { row.skills = { roots, error: err.message }; }
    }
    for (const t of h.mcp) {
      const r = inspectMcpFile(t);
      row.mcp.push({ file: t.file, ...r });
    }
    for (const t of h.hooks) {
      if (t.kind === 'dir') {
        let present = false;
        try { present = existsSync(t.file) && statSync(t.file).isDirectory(); } catch { present = false; }
        row.hooks.push({ file: t.file, present, dir: true });
      } else row.hooks.push({ file: t.file, ...inspectHookFile(h.id, t.file) });
    }
    let firstHit = false;
    for (const t of h.instructions) {
      let present = false; let bytes = 0; let hasBlock = false;
      try {
        present = existsSync(t.file) && statSync(t.file).isFile();
        if (present) {
          const text = readFileSync(t.file, 'utf8');
          bytes = Buffer.byteLength(text);
          // Detected by the TOOL NAMES, not by the block's prose: the prose is
          // a byte-pinned model-read constant owned elsewhere, and matching it
          // here would be a second copy of it (Decision J from the side that
          // only reads).
          hasBlock = text.includes('save_working_state') && text.includes('get_project_context');
        }
      } catch { /* unreadable — reported as absent */ }
      const rec = { file: t.file, present, bytes, hasBlock };
      if (t.maxBytes && bytes > t.maxBytes) {
        rec.overCap = true;
        rec.capNote = `${bytes} bytes is over this harness's ${t.maxBytes}-byte cap — the rest is truncated SILENTLY.`;
      }
      if (h.firstMatch) {
        rec.wins = present && !firstHit;
        if (present) firstHit = true;
      }
      if (t.fromSetting) rec.fromSetting = t.fromSetting;
      row.instructions.push(rec);
    }
    report.harnesses.push(row);
  }
  return report;
}

function renderDoctor(r) {
  const L = [];
  const yn = (b) => (b ? 'yes' : 'no');
  L.push('my-curator doctor');
  L.push(`  cwd: ${r.cwd}`);
  L.push('');
  L.push('COMMAND');
  L.push(`  my-curator on PATH: ${r.binaries.myCurator.length ? r.binaries.myCurator.join(', ') : 'NOT FOUND'}`);
  // Measured 2026-09-20: the shipped `.app` carries no `bin/` at all — only
  // the MCP launcher shim under Application Support — so an .app-only user
  // has no `my-curator` to run and `install-hooks` is unreachable for them.
  // Said in one line, here, because this is the command they would have run.
  if (r.install?.bundle && !r.binaries.myCurator.length) {
    L.push('    ^ this is the packaged app, which ships no command-line tool, so `my-curator '
      + 'install-hooks` cannot be run from it — install the npm package to wire a harness\'s hooks.');
  }
  if (r.binaries.curator.length) {
    L.push(`  curator on PATH:    ${r.binaries.curator.join(', ')}`);
    if (!r.binaries.curatorIsOurs) {
      L.push('    ^ that is NOT this package. `curator` is also the bin of Elastic\'s elasticsearch-curator');
      L.push('      (~57k downloads/week, /usr/bin/curator on Debian) and of npm\'s config-curator.');
      L.push('      This package never links that name. Use `my-curator`.');
    }
  } else {
    L.push('  curator on PATH:    not found (nothing is shadowed; run `my-curator doctor --alias` for the short name)');
  }
  L.push('');
  L.push('STORE');
  L.push(`  domains folder: ${r.domains.path || `(unresolved: ${r.domains.error})`}`);
  if (r.domains.path) L.push(`    exists: ${yn(r.domains.exists)} · writable: ${yn(r.domains.writable)}${r.domains.source ? ` · from ${r.domains.source}` : ''}`);
  L.push(`  usage log: ${r.usageLog.path || `(unresolved: ${r.usageLog.error})`}${r.usageLog.path ? ` · present: ${yn(r.usageLog.present)}` : ''}`);
  for (const c of (r.usageLog.candidates || []).slice(1)) {
    L.push(`  also on this machine: ${c.path} · present: ${yn(c.present)}`);
  }
  if (r.usageLog.split) {
    L.push('    ^ TWO installs of The Curator write two logs on this computer. Every reader here '
      + 'takes the union, so a save made through one is visible to the other.');
  }
  const ids = r.identity?.dirs || [];
  if (ids.length > 1) {
    L.push('  machine id:');
    for (const i of ids) L.push(`    ${i.machineId || '(none in this folder)'}  \u2190 ${i.dir}`);
  } else if (ids.length === 1) {
    L.push(`  machine id: ${ids[0].machineId || '(not minted yet — it is written on the first save)'}`);
  }
  if (r.identity?.split) {
    L.push('    ^ ONE computer, TWO machine ids, because the two installs keep separate identity '
      + 'files. Handoffs saved through each land in DIFFERENT state/<scope>/<machine>/ folders and '
      + 'do not supersede one another. Nothing here changes that — it is reported, not repaired.');
  }
  L.push('');
  L.push('BRIDGE PROCESSES');
  const bp = r.bridgeProcesses;
  if (!bp || bp.checked !== true) {
    L.push(`  not checked — ${bp?.reason || 'no reading was taken'}`);
  } else if (!bp.stale.length) {
    L.push(`  ${bp.running} running from this install · none started before its current code`);
  } else {
    L.push(`  ${bp.running} running from this install · ${bp.stale.length} started BEFORE the code on disk`);
    for (const p of bp.stale) L.push(`    pid ${p.pid} · started ${p.startedAt} · code changed ${bp.codeChangedAt}`);
    L.push(`    ^ ${STALE_REMEDY} A bridge keeps running the version it was launched with, `
      + 'so an update does not reach it — only its own client can.');
  }
  L.push('');
  L.push('PROJECT');
  if (r.project.ok) {
    L.push(`  ${r.project.domain}/${r.project.project} (resolved by ${r.project.resolvedBy || r.project.source})`);
    L.push(`  marker: ${r.project.marker
      ? `${r.project.marker}${r.project.source === 'marker' ? '' : ' (present, but the project was named instead)'}`
      : 'none in this directory or any parent'}`);
  } else {
    L.push(`  NOT RESOLVED — ${r.project.message}`);
    for (const c of r.project.candidates || []) L.push(`    candidate: ${c.domain}/${c.project}`);
  }
  if (r.readingPlan && !r.readingPlan.error) {
    const p = r.readingPlan;
    L.push(`  reading plan: ${p.readFirstCount} read-first · ${p.onRequestCount} on request · `
      + `${p.readFirstBytes} of ${p.budgetBytes} bytes${p.budgetExceeded ? ' — OVER the reading budget' : ''}`);
    if (p.staleCount || p.unreachableCount) {
      L.push(`    ${p.staleCount} stale · ${p.unreachableCount} with an unreachable source`);
    }
    if (p.budgetExceeded) {
      L.push('    The lever is the FLAG, not a bigger number: un-flag what a session does not need first.');
    }
  }
  L.push('');
  L.push('HARNESSES');
  for (const h of r.harnesses) {
    const bits = [];
    if (h.noMcpClient) bits.push('no MCP client at all — a shell wrapper is the only capture here');
    const mcpNamed = h.mcp.filter((m) => m.named);
    const mcpPresent = h.mcp.filter((m) => m.present);
    if (mcpNamed.length) bits.push(`bridge configured (${mcpNamed.length} file)`);
    else if (mcpPresent.length) bits.push('config present, bridge NOT configured');
    else if (h.mcp.length) bits.push('not configured');
    const hooked = h.hooks.filter((x) => x.ours);
    if (hooked.length) bits.push(`${hooked.length} Curator hook file`);
    if (h.hookState) bits.push(`hooks: ${h.hookState}`);
    L.push(`  ${h.label} — ${bits.join(' · ') || 'nothing to configure'}`);
    if (h.hookState && h.hookState !== 'verified' && h.hookState !== 'none' && h.hookReason) {
      L.push(`    hooks ${h.hookState}: ${h.hookReason}`);
    }
    // THE MEASUREMENT, VERBATIM OR NOT AT ALL. A harness with no row renders
    // as NOT MEASURED — the adapter table's own rule, and the reason `doctor`
    // composes no sentence of its own about reach. When package M fills a row
    // in (e.g. Claude Code's turn-end ask, measured interactive-only on
    // 2026-09-20), that wording appears here unchanged.
    if (h.measured && typeof h.measured === 'object') {
      for (const [k, v] of Object.entries(h.measured)) {
        if (typeof v === 'string' && v) L.push(`    measured · ${k}: ${v}`);
      }
    } else if (h.hookState && h.hookState !== 'none') {
      L.push('    capture: NOT MEASURED — no capture run has been recorded for this harness.');
    }
    // Single live sessions, VERBATIM from the table — never a count.
    for (const o of h.observations || []) L.push(`    observed · ${o}`);
    if (h.skills) {
      if (h.skills.error) L.push(`    skills: could not be read (${h.skills.error})`);
      else if (!h.skills.installed.length) {
        L.push(`    skills: none installed under ${h.skills.roots.join(' or ')}`);
      } else {
        for (const s of h.skills.installed) {
          let verdict;
          if (s.match === null) verdict = 'installed — not compared (this install carries no skills/ folder to compare with)';
          else if (s.match) verdict = 'matches this version';
          else {
            const bits = [];
            if (s.differs.length) bits.push(`differs: ${s.differs.join(', ')}`);
            if (s.missing.length) bits.push(`missing: ${s.missing.join(', ')}`);
            verdict = `STALE — ${bits.join(' · ')}`;
          }
          L.push(`    skill ${s.skill}: ${verdict} (${s.dir})`);
        }
      }
    }
    for (const m of h.mcp) {
      if (m.parseError) L.push(`    ! ${m.file} — could not be parsed (${m.parseError}); nothing was read from it`);
      else if (m.named && m.domainsPath && r.domains.path && m.domainsPath !== r.domains.path) {
        L.push(`    ! ${m.file} — launches with --domains-path ${m.domainsPath}, but this machine resolves ${r.domains.path}`);
      }
    }
    for (const x of h.hooks) {
      if (x.ours) L.push(`    ${x.file} — Curator hooks present · events in this file: ${(x.events || []).join(', ') || '(none)'}`);
      if (x.parseError) L.push(`    ! ${x.file} — could not be parsed (${x.parseError})`);
      for (const i of x.inert || []) L.push(`    ! ${x.file} — present and USELESS: ${i}`);
    }
    for (const i of h.instructions) {
      if (!i.present) continue;
      const marks = [];
      marks.push(i.hasBlock ? 'the Curator block IS in it' : 'the Curator block is NOT in it');
      if (i.wins === true) marks.push('this is the file this harness reads FIRST');
      if (i.wins === false) marks.push('SHADOWED — this harness takes the first match above');
      if (i.overCap) marks.push(i.capNote);
      if (i.fromSetting) marks.push(`(the real list comes from ${i.fromSetting})`);
      L.push(`    ${i.file} — ${marks.join(' · ')}`);
    }
  }
  return L.join('\n');
}

/** `--alias`: print the command, or refuse and say what `curator` already is. */
function renderAlias(r) {
  if (r.binaries.curator.length && !r.binaries.curatorIsOurs) {
    return 'REFUSED — `curator` already resolves to '
      + `${r.binaries.curator[0]}, which is not this package.\n`
      + 'That name belongs to Elastic\'s elasticsearch-curator on many machines (it runs index retention), '
      + 'and shadowing it is a real operational harm rather than a naming quibble.\n'
      + 'Nothing was written. Use `my-curator`.';
  }
  if (!r.binaries.myCurator.length) {
    return 'my-curator is not on PATH yet, so there is nothing to alias. Install the package first.';
  }
  return 'Nothing is shadowed. To make the short name yourself, run ONE of these — this command '
    + 'never writes it for you:\n'
    + `  ln -s ${r.binaries.myCurator[0]} "$(dirname ${r.binaries.myCurator[0]})/curator"\n`
    + '  alias curator=my-curator      # in your shell profile';
}

/**
 * `deps.collect` is a TEST-ONLY seam, the same shape and for the same reason as
 * `compileConversation`'s `opts.generateText` and `ingestMultiPhase`'s trailing
 * `llm`: the catch-all below is the one branch that cannot be reached from the
 * command line without breaking the machine, and an untested exit code on the
 * command whose whole promise is "it always exits 0" is exactly the promise
 * worth executing. It defaults to the real collector and is null in production.
 */
export async function runDoctor(parsed, deps = {}) {
  const { flags } = parsed;
  if (flagBool(flags, 'help')) { out(DOCTOR_USAGE); return EXIT_OK; }
  const collect = typeof deps.collect === 'function' ? deps.collect : collectDoctor;
  let report;
  try {
    report = await collect({
      cwd: flagStr(flags, 'cwd') || process.cwd(),
      project: flagStr(flags, 'project'),
      domain: flagStr(flags, 'domain'),
    });
  } catch (err) {
    // Even a total failure reports and exits 0.
    note(`my-curator doctor could not complete: ${err.message}`);
    return EXIT_OK;
  }
  if (flagBool(flags, 'alias')) {
    out(renderAlias(report));
    return EXIT_OK;
  }
  // RENDERING IS INSIDE THE PROMISE TOO (v3.64.0). `runDoctor` wrapped only the
  // COLLECTION, so a report missing a field `renderDoctor` reads — a partial
  // one from a future collector, or one built by a caller — crashed the
  // process with a stack trace and a non-zero exit. "Exit 0 always" is this
  // command's whole promise and it cannot stop at the halfway point; found by
  // §11 of scripts/test-cli-curator.js driving the `collect` seam.
  try {
    if (flagBool(flags, 'json')) out(JSON.stringify(report));
    else out(renderDoctor(report));
  } catch (err) {
    note(`my-curator doctor could not render its report: ${err.message}`);
  }
  return EXIT_OK;
}
