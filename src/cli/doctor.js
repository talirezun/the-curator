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
import {
  harnessTargets as setupHarnessTargets, inspectMcpFile, inspectHookFile, inspectSkills,
  repoSkillHashes as setupRepoSkillHashes,
} from '../brain/setup-check.js';
import { markerDir } from './hook.js';

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
  // MOVED to src/brain/setup-check.js (v3.77.0) so the app's Setup check and
  // this command read ONE derivation. `readAlso` files (Claude Code's
  // observed Claude Desktop config) ride beside the row as `mcpAlso`.
  return setupHarnessTargets({ home: HOME, project: cwd });
}

/** The inspectors moved with it; re-exported so existing importers keep working. */
export { inspectHookFile, inspectSkills };

/** The shipped skills, file by file — this install's own `skills/` folder. */
export function repoSkillHashes(skillsDir = fileURLToPath(new URL('../../skills/', import.meta.url))) {
  return setupRepoSkillHashes(skillsDir);
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

/**
 * EVIDENCE THAT A HOOK RAN, read from the only trace one leaves on this
 * machine: the loop-guard markers `my-curator hook` writes under
 * `markerDir()` (one JSON file per harness session, `{harness, startedAt,
 * askedAt}`). Grouped by harness, newest time first.
 *
 * Why this exists (v3.77.0): the row used to print the table's hook STATE
 * word — `hooks: verified` — which means "the hook FORMAT is documented", yet
 * reads as "the hooks were checked and work". Antigravity's row printed it
 * two lines above "have NOT been run yet". A state word is about the vendor's
 * format; whether a hook RAN is a separate fact, and this is the only place
 * it can come from.
 *
 * The evidence is ONE-SIDED, and the wording keeps it so: a marker proves the
 * hook command ran for that harness; NO marker proves nothing, because the
 * folder is under the OS temp directory (cleared on restart) and a stop that
 * decides not to ask writes nothing. Unreadable files are skipped, never fatal.
 */
export function readHookRuns(dir = markerDir()) {
  const byHarness = {};
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { dir, byHarness }; }
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!j || typeof j !== 'object' || typeof j.harness !== 'string') continue;
    const times = [j.startedAt, j.askedAt].map((t) => Date.parse(t)).filter(Number.isFinite);
    if (!times.length) continue;
    const at = Math.max(...times);
    const cur = byHarness[j.harness];
    if (!cur) byHarness[j.harness] = { lastRunAt: new Date(at).toISOString(), markers: 1, asked: j.askedAt ? 1 : 0 };
    else {
      cur.markers++;
      if (j.askedAt) cur.asked++;
      if (at > Date.parse(cur.lastRunAt)) cur.lastRunAt = new Date(at).toISOString();
    }
  }
  return { dir, byHarness };
}

/**
 * The words a harness row prints about its hooks. NEVER the bare state word:
 * the FORMAT (what the vendor documents) and the RUN (what this machine has
 * seen) are two phrases, and no combination can read as "the hooks ran" unless
 * a marker says so. Pure, so the suite can drive every combination.
 */
export const HOOK_FORMAT_LABEL = Object.freeze({
  verified: 'hook format documented',
  unverified: 'hook format unmeasured',
  'present-useless': 'hooks cannot carry the ask',
  none: 'no hook mechanism',
});

export function hookStatusBits(h) {
  if (!h.hookState) return [];
  const bits = [HOOK_FORMAT_LABEL[h.hookState] || `hook state ${h.hookState}`];
  if (h.hookState === 'none' || h.hookState === 'present-useless') return bits;
  const ours = (h.hooks || []).filter((x) => x.ours);
  if (!ours.length) return [...bits, 'hooks not installed'];
  // A marker counts only if it is NEWER than the hook file it would have come
  // from: the folder also holds markers from test runs and manual invocations
  // (measured on the maintainer's Mac: over a hundred, left by 2026-09-19 suites,
  // for harnesses with no hook installed). What a marker proves is that the
  // hook COMMAND ran for this harness — so that is what the row says.
  // THE HOOK ACTIVITY LOG FIRST (v3.77.0). It records every invocation with
  // its decision and survives a restart; the markers below are cleared on
  // restart and polluted by old test runs, so they are only the fallback.
  const act = h.hookActivity;
  if (act && (act.start || act.stop)) {
    const at = (x) => `${x.at.slice(0, 16).replace('T', ' ')} UTC`;
    const words = [];
    if (act.start) words.push(`start hook observed firing ${at(act.start)}`);
    if (act.stop) words.push(`stop hook observed firing ${at(act.stop)}`);
    return [...bits, `hooks installed · ${words.join(' · ')} (hook log)`];
  }
  const installedAt = Math.min(...ours.map((x) => (Number.isFinite(x.mtimeMs) ? x.mtimeMs : Infinity)));
  const last = h.hookRuns?.lastRunAt ? Date.parse(h.hookRuns.lastRunAt) : NaN;
  if (Number.isFinite(last) && Number.isFinite(installedAt) && last >= installedAt) {
    bits.push(`hooks installed · the hook command ran for it ${h.hookRuns.lastRunAt.slice(0, 16).replace('T', ' ')} UTC (marker)`);
  } else bits.push('hooks installed · not yet seen running on this machine');
  return bits;
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
  // and two `.curator-machine-id` files, `alices-macbook-pro-9a8b7c` against
  // `alices-macbook-pro-4d3e2f`. The consequence is real and was invisible: the
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
  let hookActivity = {};
  try {
    const { readHookLines, summariseHookActivity } = await import('../brain/hook-log.js');
    const { lines, files } = await readHookLines();
    hookActivity = summariseHookActivity(lines);
    report.hookLog = { files, lines: lines.length };
  } catch (err) { report.hookLog = { error: err.message }; }
  let hookRuns = { dir: null, byHarness: {} };
  try { hookRuns = readHookRuns(opts.hookMarkerDir || undefined); } catch { /* reported as no evidence */ }
  report.hookMarkerDir = hookRuns.dir;
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
      // Evidence a hook RAN here (a marker), or null. Never inferred.
      hookRuns: hookRuns.byHarness[h.id] || null,
    };
    // Installed skills, for a harness whose table row says where they live.
    const roots = skillRootsFor(h.id, { home: HOME, project: cwd });
    if (roots.length) {
      try {
        row.skills = { roots, repoComparable: repoSkills !== null, installed: inspectSkills(roots, repoSkills) };
      } catch (err) { row.skills = { roots, error: err.message }; }
    }
    for (const t of h.mcp) {
      // `projectsKey` + the cwd: Claude Code's local-scope entry lives under
      // `projects["<repo>"]` in ~/.claude.json (v3.77.0).
      const r = inspectMcpFile(t, { projectsKey: h.projectsKey, repo: cwd });
      row.mcp.push({ file: t.file, ...r });
    }
    // Files read FOR this row but owned by another client (Claude Code's
    // observed Claude Desktop config, v3.77.0). Reported apart from `mcp` so
    // "configured in its own file" and "configured only via another's" stay
    // two facts.
    row.mcpAlso = (h.mcpAlso || []).map((t) => ({ file: t.file, ...inspectMcpFile(t) }));
    if (row.mcpAlso.length) row.mcpAlsoNote = adapter?.mcpConfig?.readAlsoNote || null;
    row.skillsAccountHeld = adapter?.skillsTree?.accountHeld === true;
    // The hook activity log's evidence (v3.77.0), and which hook file this
    // harness is observed NOT to load.
    row.hookActivity = hookActivity[h.id] || null;
    row.hookScopeObservations = adapter?.hooks?.scopeObservations || null;
    for (const t of h.hooks) {
      if (t.kind === 'dir') {
        let present = false;
        try { present = existsSync(t.file) && statSync(t.file).isDirectory(); } catch { present = false; }
        row.hooks.push({ file: t.file, present, dir: true });
      } else {
        const rec = { file: t.file, scope: t.scope, ...inspectHookFile(h.id, t.file) };
        // When the file last changed — the floor a run marker must clear.
        if (rec.ours) { try { rec.mtimeMs = statSync(t.file).mtimeMs; } catch { /* no floor: no run claimed */ } }
        row.hooks.push(rec);
      }
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
  L.push('  (the hook FORMAT is what the vendor documents; whether a hook RAN is read only from the markers '
    + `\`my-curator hook\` leaves in ${r.hookMarkerDir || 'the temp folder'}, counted only when newer than the hook file. `
    + 'The folder is cleared on restart, so NO marker proves nothing)');
  for (const h of r.harnesses) {
    const bits = [];
    if (h.noMcpClient) bits.push('no MCP client at all — a shell wrapper is the only capture here');
    const mcpNamed = h.mcp.filter((m) => m.named);
    const mcpPresent = h.mcp.filter((m) => m.present);
    const alsoNamed = (h.mcpAlso || []).filter((m) => m.named);
    if (mcpNamed.length) bits.push(`bridge configured (${mcpNamed.length} file)`);
    else if (alsoNamed.length) bits.push('bridge configured only in another client\'s file (see below)');
    else if (mcpPresent.length) bits.push('config present, bridge NOT configured');
    else if (h.mcp.length) bits.push('not configured');
    const hooked = h.hooks.filter((x) => x.ours);
    if (hooked.length) bits.push(`${hooked.length} Curator hook file`);
    bits.push(...hookStatusBits(h));
    L.push(`  ${h.label} — ${bits.join(' · ') || 'nothing to configure'}`);
    if (h.hookState && h.hookState !== 'verified' && h.hookState !== 'none' && h.hookReason) {
      L.push(`    ${HOOK_FORMAT_LABEL[h.hookState] || `hook state ${h.hookState}`}: ${h.hookReason}`);
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
      else if (!h.skills.installed.length && h.skillsAccountHeld) {
        L.push(`    skills: none under ${h.skills.roots.join(' or ')} — can't check from here: skills added to your `
          + 'Claude account reach the app from the account and leave no local copy');
      } else if (!h.skills.installed.length) {
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
    for (const m of h.mcpAlso || []) {
      if (m.named) L.push(`    ${m.file} — names my-curator, and this harness was observed using it · ${h.mcpAlsoNote || ''}`.trimEnd());
    }
    for (const x of h.hooks) {
      const nl = x.ours && h.hookScopeObservations && x.scope ? h.hookScopeObservations[x.scope] : null;
      if (x.ours) L.push(`    ${x.file} — Curator hooks present · events in this file: ${(x.events || []).join(', ') || '(none)'}${nl ? ` · ${nl}` : ''}`);
      if (x.parseError) L.push(`    ! ${x.file} — could not be parsed (${x.parseError})`);
      for (const i of x.inert || []) L.push(`    ! ${x.file} — present and USELESS: ${i}`);
    }
    // THE HOOK ACTIVITY LOG (v3.77.0) — what `my-curator hook` recorded doing.
    if (h.hookActivity) {
      const a = h.hookActivity;
      if (a.start) L.push(`    hook log · start hook observed firing ${a.start.at.slice(0, 16).replace('T', ' ')} UTC (${a.starts} logged)`);
      if (a.stop) {
        L.push(`    hook log · stop hook observed firing ${a.stop.at.slice(0, 16).replace('T', ' ')} UTC — `
          + (a.stop.decision === 'ask' ? 'asked for a save' : `did not ask: rung ${a.stop.rung ?? '?'}, ${a.stop.why || 'no reason recorded'}`)
          + (a.stop.bound ? ` (window from the ${a.stop.bound === 'marker' ? 'conversation marker' : 'logged session start'})` : ''));
      } else if (a.start) L.push('    hook log · no stop hook logged for this harness');
    } else if (h.hooks.some((x) => x.ours)) {
      L.push('    hook log · installed, not yet observed firing (`my-curator hook-log` shows the last invocations)');
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
