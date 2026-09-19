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
import { existsSync, readFileSync, statSync, accessSync, constants as FS } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT_OK, out, note, flagStr, flagBool, findMarker, resolveProjectForCli } from './resolve.js';

export const DOCTOR_USAGE = 'my-curator doctor [--project <domain/project>] [--json] [--alias]';

const MCP_SERVER_NAME = 'my-curator';
/** Codex truncates its instruction file at this many bytes, silently. */
export const CODEX_DOC_MAX_BYTES = 32 * 1024;

const HOME = (() => { try { return os.homedir(); } catch { return ''; } })();
const home = (...p) => (HOME ? path.join(HOME, ...p) : '');

/**
 * Where each harness keeps its MCP servers, its hooks, and the file it will
 * actually read for instructions. Paths are the ones §2 of the design record
 * measured; a harness whose path was not verified is named as unverified
 * rather than guessed at, because a doctor that reports "not configured" for a
 * file it looked for in the wrong place is worse than one that says it did not
 * look.
 */
export function harnessTargets(cwd) {
  const P = (...p) => path.join(cwd, ...p);
  return [
    {
      id: 'claude-desktop', label: 'Claude Desktop',
      mcp: [
        { file: home('Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), kind: 'json', key: 'mcpServers' },
        { file: home('.config', 'Claude', 'claude_desktop_config.json'), kind: 'json', key: 'mcpServers' },
      ],
      hooks: [], instructions: [],
    },
    {
      id: 'claude-code', label: 'Claude Code',
      mcp: [
        { file: home('.claude.json'), kind: 'json', key: 'mcpServers' },
        { file: P('.mcp.json'), kind: 'json', key: 'mcpServers' },
      ],
      hooks: [
        { file: home('.claude', 'settings.json'), kind: 'json' },
        { file: P('.claude', 'settings.json'), kind: 'json' },
        { file: P('.claude', 'settings.local.json'), kind: 'json' },
      ],
      instructions: [{ file: P('CLAUDE.md') }],
    },
    {
      id: 'codex', label: 'OpenAI Codex CLI',
      mcp: [
        { file: home('.codex', 'config.toml'), kind: 'toml', tomlKey: `[mcp_servers.${MCP_SERVER_NAME}]` },
        { file: P('.codex', 'config.toml'), kind: 'toml', tomlKey: `[mcp_servers.${MCP_SERVER_NAME}]` },
      ],
      hooks: [
        { file: home('.codex', 'hooks.json'), kind: 'json' },
        { file: P('.codex', 'hooks.json'), kind: 'json' },
      ],
      // 32 KiB cap, silently truncated past it.
      instructions: [{ file: P('AGENTS.md'), maxBytes: CODEX_DOC_MAX_BYTES }],
    },
    {
      id: 'gemini-cli', label: 'Gemini CLI',
      mcp: [
        { file: home('.gemini', 'settings.json'), kind: 'json', key: 'mcpServers' },
        { file: P('.gemini', 'settings.json'), kind: 'json', key: 'mcpServers' },
      ],
      hooks: [
        { file: home('.gemini', 'settings.json'), kind: 'json' },
        { file: P('.gemini', 'settings.json'), kind: 'json' },
      ],
      // `context.fileName` is a NESTED ARRAY and has replaced the old flat
      // `contextFileName`; `AGENTS.md` is opt-in and not read by default.
      instructions: [{ file: P('GEMINI.md'), fromSetting: 'context.fileName' }],
    },
    {
      id: 'cursor', label: 'Cursor',
      mcp: [
        { file: home('.cursor', 'mcp.json'), kind: 'json', key: 'mcpServers' },
        { file: P('.cursor', 'mcp.json'), kind: 'json', key: 'mcpServers' },
      ],
      hooks: [
        { file: home('.cursor', 'hooks.json'), kind: 'json' },
        { file: P('.cursor', 'hooks.json'), kind: 'json' },
      ],
      instructions: [{ file: P('.cursor', 'rules') }, { file: P('AGENTS.md') }],
    },
    {
      id: 'copilot-cli', label: 'GitHub Copilot CLI',
      mcp: [
        { file: home('.copilot', 'mcp-config.json'), kind: 'json', key: 'mcpServers' },
        { file: P('.github', 'mcp.json'), kind: 'json', key: 'mcpServers' },
        { file: P('.mcp.json'), kind: 'json', key: 'mcpServers' },
      ],
      hooks: [{ file: home('.copilot', 'hooks'), kind: 'dir' }, { file: P('.github', 'hooks'), kind: 'dir' }],
      instructions: [{ file: P('CLAUDE.md') }, { file: P('GEMINI.md') }],
    },
    {
      id: 'cline', label: 'Cline',
      // The docs say `~/.cline/mcp.json`; the SOURCE says the settings path.
      // Source wins, and both are checked.
      mcp: [
        { file: home('.cline', 'data', 'settings', 'cline_mcp_settings.json'), kind: 'json', key: 'mcpServers' },
        { file: home('.cline', 'mcp.json'), kind: 'json', key: 'mcpServers' },
      ],
      hooks: [], instructions: [],
    },
    {
      id: 'opencode', label: 'OpenCode',
      mcp: [
        { file: home('.config', 'opencode', 'opencode.json'), kind: 'json', key: 'mcp' },
        { file: P('opencode.json'), kind: 'json', key: 'mcp' },
      ],
      // Hooks are TypeScript PLUGINS, not shell commands — nothing to install.
      hooks: [], instructions: [{ file: P('AGENTS.md') }, { file: P('CLAUDE.md') }],
    },
    {
      id: 'goose', label: 'goose',
      mcp: [{ file: home('.config', 'goose', 'config.yaml'), kind: 'opaque' }],
      hooks: [{ file: home('.agents', 'plugins'), kind: 'dir' }],
      instructions: [],
    },
    {
      id: 'windsurf', label: 'Windsurf / Devin Desktop',
      mcp: [{ file: home('.codeium', 'windsurf', 'mcp_config.json'), kind: 'json', key: 'mcpServers' }],
      // 12 hooks, none of them a stop, session-end or pre-compaction hook.
      hooks: [], instructions: [],
    },
    {
      id: 'zed', label: 'Zed',
      // A FLAT `context_servers`, not `mcpServers`.
      mcp: [{ file: home('.config', 'zed', 'settings.json'), kind: 'json', key: 'context_servers' }],
      hooks: [],
      // FIRST MATCH, and `.rules` and `AGENTS.md` OUTRANK `CLAUDE.md` — a block
      // pasted into CLAUDE.md in a repo that has AGENTS.md is dead text here.
      instructions: [{ file: P('.rules') }, { file: P('AGENTS.md') }, { file: P('CLAUDE.md') }],
      firstMatch: true,
    },
    {
      id: 'aider', label: 'Aider',
      mcp: [], hooks: [], instructions: [],
      noMcpClient: true,
    },
  ];
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
  const ours = /my-curator hook|curator hook/.test(text);
  const events = [];
  const hooks = r.json?.hooks && typeof r.json.hooks === 'object' ? r.json.hooks : r.json;
  if (hooks && typeof hooks === 'object') for (const k of Object.keys(hooks)) events.push(k);
  const inert = [];
  if (harnessId === 'cline' && events.some((e) => /precompact/i.test(e))) {
    inert.push('PreCompact — Cline accepts this hook and maps it to `undefined`, so it NEVER fires');
  }
  if (harnessId === 'codex' && events.some((e) => /sessionend/i.test(e))) {
    inert.push('SessionEnd — Codex allows 1 s by default and 3 s at most, which cannot complete an MCP round trip');
  }
  return { present: true, ours, events, inert };
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
  const report = { ok: true, cwd, binaries: {}, domains: {}, project: {}, usageLog: {}, harnesses: [], readingPlan: null };

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

  try {
    const { getMcpUsageLogPath } = await import('../brain/paths.js');
    const f = getMcpUsageLogPath();
    report.usageLog = { path: f, present: existsSync(f), rotated: existsSync(`${f}.1`) };
  } catch (err) { report.usageLog = { error: err.message }; }

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
  for (const h of harnessTargets(cwd)) {
    const row = { id: h.id, label: h.label, mcp: [], hooks: [], instructions: [], noMcpClient: !!h.noMcpClient };
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
    L.push(`  ${h.label} — ${bits.join(' · ') || 'nothing to configure'}`);
    for (const m of h.mcp) {
      if (m.parseError) L.push(`    ! ${m.file} — could not be parsed (${m.parseError}); nothing was read from it`);
      else if (m.named && m.domainsPath && r.domains.path && m.domainsPath !== r.domains.path) {
        L.push(`    ! ${m.file} — launches with --domains-path ${m.domainsPath}, but this machine resolves ${r.domains.path}`);
      }
    }
    for (const x of h.hooks) {
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
  if (flagBool(flags, 'json')) out(JSON.stringify(report));
  else out(renderDoctor(report));
  return EXIT_OK;
}
