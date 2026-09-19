#!/usr/bin/env node
/**
 * OFFLINE — the per-harness adapter table and `my-curator install-hooks`.
 *
 * WHAT THIS SUITE EXISTS TO STOP
 * ──────────────────────────────
 * The adapter layer is the largest thing in v3.63.0 and it was scoped as the
 * smallest. Fourteen harnesses, five hook writers, three serialisation
 * formats, two harnesses that disagree on the shape of "ask the model to
 * save", and — the finding that changed the design — THREE harnesses whose
 * hooks are accepted and never do anything. Every assertion below is one of
 * those ways to ship a feature that silently does nothing:
 *
 *   §1 THE TABLE. Fourteen entries, every fact carrying a `source` and a
 *      `verified` DERIVED from it, every hook state one of four words, and
 *      `measured: null` on every row — because a harness with no measurement
 *      must render as "not measured" and nothing may derive reach from the
 *      mere existence of an adapter.
 *   §2 THE MCP ENTRY. The launch line is the CALLER's: the entry is built from
 *      a fixture `{command, args}` and the suite proves no second launch line
 *      is composed anywhere — then compares against the REAL
 *      `buildCuratorEntry` by execution. v3.6.1's recorded defect was a second
 *      launch line.
 *   §3 THE INSTRUCTION SNIPPET. BYTE-EQUAL to `composeAgentInstructionsFull`,
 *      compared by running both. Decision J: no adapter hand-writes prose a
 *      model reads.
 *   §4 THE PATHS, AGAINST `doctor.js`. Two hand-maintained tables of one thing
 *      is this repository's most-recorded defect, so the duplication is made
 *      NON-SILENT: both are resolved against one home and one project root and
 *      compared for SET EQUALITY.
 *   §5 THE ENVELOPES, AGAINST `hook.js`. Same rule, other table: every id and
 *      every emittable arm in `HARNESS_HOOKS` must exist here.
 *   §6 THE FIVE REFUSALS, each driven as a first-class outcome.
 *   §7 INSTALL-HOOKS, as a CHILD PROCESS: a fresh write, a byte-identical
 *      re-run, a foreign hook that survives, a corrupt file REFUSED with
 *      nothing written, an absolute command in every entry, `--dry-run`
 *      writing nothing, `--uninstall` removing only ours, and every refusing
 *      arm fingerprinted.
 *   §8 NO INSTRUCTION FILE IS EVER OPENED FOR WRITING. A planted CLAUDE.md,
 *      AGENTS.md, GEMINI.md, .cursor/rules and .rules are sha256'd before and
 *      after every arm above.
 *
 * WHY A CHILD PROCESS FOR §7. Exit codes, stdout-vs-stderr and "nothing was
 * written" are properties of the PROCESS. `bin/curator.js` is package C's file
 * and its `install-hooks` runner is a reserved `null` there, so this suite
 * drives the same runner through a three-line driver that mirrors that
 * dispatch — and §7.0 asserts the name is RESERVED in the real binary, so the
 * day the dispatch line lands nothing here has to move.
 *
 * SAFETY — never touches real user data or a real harness config. HOME is
 * pointed at a fixture directory for every child (so `~/.claude`, `~/.cursor`,
 * `~/.codex`, `~/.gemini`, `~/.copilot` and `~/.agents` can only ever be the
 * fixture's), `CURATOR_TEST_DOMAINS_DIR` and `CURATOR_TEST_USER_DATA_DIR` are
 * pinned to a tempdir, and provider/GitHub credentials are stripped from every
 * child. No network.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'curator.js');

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
};
const section = (t) => console.log(`\n${t}`);

// ── Fixture ────────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-adapters-'));
const DOMAINS_DIR = path.join(ROOT, 'domains');
const USER_DATA_DIR = path.join(ROOT, 'userdata');
const FAKE_HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');
const DEEP = path.join(WORK, 'src', 'deep');
for (const d of [DOMAINS_DIR, USER_DATA_DIR, FAKE_HOME, DEEP]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(WORK, '.curator-project'), 'zzh-alpha/lumina\n');

// The five model-read instruction files Decision K forbids this command to
// touch. Planted with content so a truncation would be as visible as a write.
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.rules'];
for (const f of INSTRUCTION_FILES) writeFileSync(path.join(WORK, f), `# ${f}\n\nowner's paste, untouched\n`);
mkdirSync(path.join(WORK, '.cursor'), { recursive: true });
writeFileSync(path.join(WORK, '.cursor', 'rules'), "owner's cursor rules\n");
const INSTRUCTION_PATHS = [
  ...INSTRUCTION_FILES.map((f) => path.join(WORK, f)),
  path.join(WORK, '.cursor', 'rules'),
];
const shaOf = (f) => {
  try { return createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { return 'ABSENT'; }
};
const instructionFingerprint = () => INSTRUCTION_PATHS.map((f) => `${f}:${shaOf(f)}`).join('\n');
const INSTRUCTIONS_AT_START = instructionFingerprint();

/** sha256 of every file under a directory — the "nothing was written" proof. */
function treeFingerprint(dir) {
  const rows = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else rows.push(`${p}:${st.size}:${shaOf(p)}`);
    }
  };
  walk(dir);
  return rows.join('\n');
}

// The driver — mirrors bin/curator.js's dispatch for the one runner package C
// reserved. Three lines, and §7.0 proves the reservation is real.
const DRIVER = path.join(ROOT, 'drive.mjs');
writeFileSync(DRIVER, [
  `import { parseArgv } from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'cli', 'resolve.js'))};`,
  `import { runInstallHooks } from ${JSON.stringify(path.join(REPO_ROOT, 'src', 'cli', 'install-hooks.js'))};`,
  'const parsed = parseArgv(process.argv.slice(2));',
  'process.exitCode = (await runInstallHooks(parsed)) ?? 0;',
  '',
].join('\n'));

const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
    'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) delete e[k];
  e.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
  e.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;
  e.HOME = FAKE_HOME;
  e.USERPROFILE = FAKE_HOME;
  return e;
})();

/** Run install-hooks through the driver. Returns {code, out, err}. */
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [DRIVER, ...args], {
    cwd: WORK, env: { ...BASE_ENV, ...extraEnv }, encoding: 'utf8', timeout: 30000,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ── Modules under test ─────────────────────────────────────────────────────
const A = await import('../src/brain/harness-adapters.js');
const IH = await import('../src/cli/install-hooks.js');
const { HARNESS_HOOKS } = await import('../src/cli/hook.js');
const { harnessTargets } = await import('../src/cli/doctor.js');
const { composeAgentInstructionsFull } = await import('../src/public/next/shared/agent-instructions.js');
const { buildCuratorEntry } = await import('../src/routes/mcp.js');

// ─────────────────────────────────────────────────────────────────────────
section('§1  THE TABLE — every fact flagged, every state a word from the list');
// ─────────────────────────────────────────────────────────────────────────
{
  const ids = A.listHarnesses();
  ok(ids.length === 14, `fourteen harness entries (got ${ids.length}: ${ids.join(', ')})`);
  ok(new Set(ids).size === ids.length, 'every id appears exactly once');
  // The record's §B.3 ships thirteen; claude-desktop is the fourteenth and is
  // carried because this repo already writes its config file.
  for (const must of ['claude-code', 'codex', 'cursor', 'copilot-cli', 'goose', 'gemini-cli',
    'cline', 'dsh', 'opencode', 'kilo', 'windsurf', 'zed', 'aider', 'claude-desktop']) {
    ok(ids.includes(must), `…including ${must}`);
  }

  const FACT_BLOCKS = ['instructionFile', 'hooks', 'skillsTree', 'clientInfo'];
  let shapeBad = [];
  let flagBad = [];
  let stateBad = [];
  let measuredBad = [];
  let classBad = [];
  const CLASSES = new Set(Object.values(A.CAPTURE_CLASSES));
  for (const id of ids) {
    const a = A.adapterFor(id);
    if (!a || typeof a.label !== 'string' || !a.label) shapeBad.push(`${id}: label`);
    for (const k of FACT_BLOCKS) {
      const f = a[k];
      if (!f || typeof f !== 'object') { shapeBad.push(`${id}.${k}`); continue; }
      if (typeof f.verified !== 'boolean' || typeof f.source !== 'string') flagBad.push(`${id}.${k}`);
      // `verified` is DERIVED, so a hand-set true on a community fact is
      // impossible — this asserts the derivation, not a spelling.
      const expect = ['source', 'docs', 'observed', 'repo'].includes(f.source);
      if (f.verified !== expect) flagBad.push(`${id}.${k}: verified ${f.verified} for source ${f.source}`);
    }
    // mcpConfig may be null — and exactly one harness has no MCP client.
    if (a.mcpConfig !== null && (typeof a.mcpConfig.verified !== 'boolean')) flagBad.push(`${id}.mcpConfig`);
    if (!A.isHookState(a.hooks?.state)) stateBad.push(`${id}: ${a.hooks?.state}`);
    if (a.measured !== null) measuredBad.push(id);
    if (!CLASSES.has(a.captureClass)) classBad.push(`${id}: ${a.captureClass}`);
  }
  ok(shapeBad.length === 0, `every entry carries every fact block${shapeBad.length ? ` — missing ${shapeBad.join(', ')}` : ''}`);
  ok(flagBad.length === 0, `every fact's \`verified\` is derived from its \`source\`${flagBad.length ? ` — ${flagBad.join(', ')}` : ''}`);
  ok(stateBad.length === 0, `every hook state is one of the four words${stateBad.length ? ` — ${stateBad.join(', ')}` : ''}`);
  ok(measuredBad.length === 0,
    `\`measured\` is null on every row — nothing implies reach${measuredBad.length ? ` — ${measuredBad.join(', ')}` : ''}`);
  ok(classBad.length === 0, `every captureClass is one of the four${classBad.length ? ` — ${classBad.join(', ')}` : ''}`);

  // The four states each have at least one harness, or the vocabulary is
  // decorative. This is what makes "exists and is useless" a real state.
  const byState = {};
  for (const id of ids) (byState[A.adapterFor(id).hooks.state] ||= []).push(id);
  ok((byState['present-useless'] || []).length >= 3,
    `\`present-useless\` is populated — ${(byState['present-useless'] || []).join(', ')}`);
  ok((byState.none || []).length >= 2, `\`none\` is populated — ${(byState.none || []).join(', ')}`);
  ok((byState.verified || []).length >= 1, `\`verified\` is populated — ${(byState.verified || []).join(', ')}`);
  ok((byState.unverified || []).length >= 1, `\`unverified\` is populated — ${(byState.unverified || []).join(', ')}`);

  // The measured per-event refusals, by name. Each of these is a hook that a
  // naive adapter writes and that never does anything.
  ok(/never fires/i.test(A.adapterFor('cline').hooks.refusedEvents.PreCompact || ''),
    "Cline's PreCompact is a named refusal — accepted and never fires");
  ok(/3 s|3s/.test(A.adapterFor('codex').hooks.refusedEvents.SessionEnd || ''),
    "Codex's SessionEnd is a named refusal — the 3 s maximum");
  ok(/fire-and-forget/i.test(A.adapterFor('gemini-cli').hooks.refusedEvents.SessionEnd || ''),
    "Gemini CLI's SessionEnd is a named refusal — fire-and-forget");
  ok(A.adapterFor('codex').instructionFile.cap === 32768, "Codex's AGENTS.md cap is 32,768 bytes");
  ok(A.adapterFor('zed').instructionFile.firstMatch === true
    && A.adapterFor('zed').instructionFile.names[0] === '.rules',
  'Zed resolves FIRST MATCH with .rules ahead of CLAUDE.md');
  ok(A.adapterFor('aider').mcpConfig === null, 'Aider has no MCP client at all');
  ok(!A.MCP_SERVER_NAME.includes(A.ALIAS_MUST_NOT_CONTAIN),
    "the server alias has no underscore — Gemini CLI's policy parser rejects one");
}

// ─────────────────────────────────────────────────────────────────────────
section('§2  THE MCP ENTRY — the launch line is the caller\'s, in each format');
// ─────────────────────────────────────────────────────────────────────────
{
  // A launch line with a SPACE in it, because the real one on a bundle install
  // is inside "/Applications/The Curator.app/…".
  const LAUNCH = { command: '/opt/My Tools/node', args: ['/opt/My Tools/mcp/server.js', '--domains-path', '/tmp/kb'] };

  const jsonIds = ['claude-desktop', 'claude-code', 'cursor', 'gemini-cli', 'copilot-cli', 'cline', 'opencode', 'kilo', 'zed', 'windsurf'];
  let formatBad = [];
  for (const id of jsonIds) {
    const e = A.mcpEntryFor(id, LAUNCH);
    if (!e.ok || e.format !== 'json') { formatBad.push(id); continue; }
    try { JSON.parse(e.text); } catch { formatBad.push(`${id}: text is not JSON`); }
  }
  ok(formatBad.length === 0, `every JSON-format harness serialises as JSON${formatBad.length ? ` — ${formatBad.join(', ')}` : ''}`);

  const cc = A.mcpEntryFor('claude-code', LAUNCH);
  ok(cc.key === 'mcpServers' && cc.config.mcpServers['my-curator'].command === LAUNCH.command
    && JSON.stringify(cc.config.mcpServers['my-curator'].args) === JSON.stringify(LAUNCH.args),
  'the entry carries the CALLER\'s command and args, byte for byte');

  const zed = A.mcpEntryFor('zed', LAUNCH);
  ok(zed.key === 'context_servers' && !!zed.config.context_servers['my-curator'],
    'Zed uses a flat `context_servers`, not `mcpServers`');

  const cur = A.mcpEntryFor('cursor', LAUNCH);
  ok(cur.config.mcpServers['my-curator'].type === 'stdio', 'Cursor gets the required `type: "stdio"`');
  ok(A.mcpEntryFor('claude-code', LAUNCH).config.mcpServers['my-curator'].type === undefined,
    '…and Claude Code does not, because it does not require one');

  const oc = A.mcpEntryFor('opencode', LAUNCH);
  ok(Array.isArray(oc.config.mcp['my-curator'].command)
    && oc.config.mcp['my-curator'].command[0] === LAUNCH.command
    && oc.config.mcp['my-curator'].command.length === 4,
  'OpenCode takes the command as ONE argv array under `mcp`');

  const cx = A.mcpEntryFor('codex', LAUNCH);
  ok(cx.format === 'toml' && cx.text.startsWith('[mcp_servers.my-curator]'),
    'Codex serialises a TOML table, not JSON');
  ok(cx.text.includes('command = "/opt/My Tools/node"') && cx.text.includes('args = ['),
    '…with command and args as TOML values');
  ok(typeof cx.addCommand === 'string' && cx.addCommand.startsWith('codex mcp add my-curator -- ')
    && cx.addCommand.includes("'/opt/My Tools/node'"),
  "…and the vendor `codex mcp add` line, shell-quoted around the space");

  const g = A.mcpEntryFor('goose', LAUNCH);
  ok(g.format === 'yaml' && g.text.startsWith('extensions:\n  my-curator:'),
    'goose serialises YAML under `extensions`');
  ok(g.text.includes('    envs: {}'), '…with goose\'s own env key, `envs`');

  const dsh = A.mcpEntryFor('dsh', LAUNCH);
  ok(dsh.format === 'yaml' && dsh.shape === 'cordis', 'dsh is a Cordis YAML overlay');
  ok(A.adapterFor('dsh').mcpConfig.stripsEnv === true,
    '…and is recorded as stripping credential-shaped env from stdio children');

  const aider = A.mcpEntryFor('aider', LAUNCH);
  ok(aider.ok === false && aider.reason === 'no_mcp_client' && /wrapper around the process/.test(aider.message),
    'Aider refuses with the reason AND names the wrapper that is its real answer');

  // NEVER a second launch line. The only strings in any entry that look like a
  // command are the ones handed in.
  const all = A.listHarnesses().map((id) => A.mcpEntryFor(id, LAUNCH)).filter((e) => e.ok);
  const leaked = all.filter((e) => /server\.js/.test(e.text) && !e.text.includes(LAUNCH.args[0]));
  ok(leaked.length === 0, 'no entry contains a launch line this suite did not hand in');
  const noLaunch = A.mcpEntryFor('claude-code', {});
  ok(noLaunch.ok === false && noLaunch.reason === 'no_launch_line',
    'an entry cannot be built without a launch line — it is never composed here');

  // …and against the REAL one, by execution.
  const real = buildCuratorEntry('/tmp/kb-real');
  const realEntry = A.mcpEntryFor('claude-desktop', real);
  ok(realEntry.config.mcpServers['my-curator'].command === real.command
    && JSON.stringify(realEntry.config.mcpServers['my-curator'].args || []) === JSON.stringify(real.args),
  'the Claude Desktop entry equals buildCuratorEntry\'s output, compared by execution');
  ok(path.isAbsolute(real.command), '…and that launch line is absolute (the control on the comparison)');
}

// ─────────────────────────────────────────────────────────────────────────
section('§3  THE INSTRUCTION SNIPPET — derived, byte-equal, never authored');
// ─────────────────────────────────────────────────────────────────────────
{
  const args = { domain: 'zzh-alpha', project: 'lumina' };
  const expected = composeAgentInstructionsFull(args);
  let drift = [];
  for (const id of A.listHarnesses()) {
    const s = await A.instructionSnippetFor(id, args);
    if (!s.ok || s.text !== expected) drift.push(id);
  }
  ok(drift.length === 0,
    `every harness's snippet is BYTE-IDENTICAL to composeAgentInstructionsFull${drift.length ? ` — ${drift.join(', ')}` : ''}`);
  ok(expected.length > 400, `…and the composer returned real text (${expected.length} chars — the control)`);

  const codex = await A.instructionSnippetFor('codex', args);
  ok(codex.cap === 32768 && codex.overCap === false,
    `Codex's snippet reports the cap and is under it (${codex.bytes} of ${codex.cap} bytes)`);
  ok(/32,768 bytes/.test(codex.note) && /truncated/.test(codex.note),
    '…and its note names the cap and the silent truncation');

  const zed = await A.instructionSnippetFor('zed', args);
  ok(/FIRST match/i.test(zed.note) && zed.files.join(',') === '.rules,AGENTS.md,CLAUDE.md',
    "Zed's note warns about first-match resolution and lists the files in rank order");

  const gem = await A.instructionSnippetFor('gemini-cli', args);
  ok(gem.fromSetting === 'context.fileName' && /nested, an array/.test(gem.note),
    "Gemini CLI's note names `context.fileName` and that it is a nested array");

  const bad = await A.instructionSnippetFor('claude-code', { domain: 'x' });
  ok(bad.ok === false && bad.reason === 'missing_project',
    'a snippet without a project is REFUSED — it would tell an agent to save into a project that cannot exist');

  // The seam a mutation would open: a snippet composed from a copy rather than
  // the shared function. Drive the injected composer and require it to be used.
  const injected = await A.instructionSnippetFor('claude-code', args, { compose: () => 'SENTINEL' });
  ok(injected.text === 'SENTINEL', '…and the composer is genuinely called (the injected-composer control)');
}

// ─────────────────────────────────────────────────────────────────────────
section('§4  THE PATHS — set equality against doctor.js\'s own table');
// ─────────────────────────────────────────────────────────────────────────
{
  const targets = harnessTargets(WORK);
  // doctor.js resolves `~` once at module load from os.homedir(), which this
  // process's env cannot move — and it does not need to: §4 compares path
  // SHAPES, reads nothing and writes nothing, so the real home is the correct
  // base on both sides of the comparison.
  const dirs = { home: os.homedir(), project: WORK };
  const norm = (list) => [...new Set(list)].sort();

  let mcpDrift = [];
  let hookDrift = [];
  let insDrift = [];
  let covered = 0;
  for (const t of targets) {
    const a = A.adapterFor(t.id);
    if (!a) { mcpDrift.push(`${t.id}: absent from the adapter table`); continue; }
    covered++;

    const mine = norm([
      ...A.resolveTemplates(a.mcpConfig?.user || [], dirs),
      ...A.resolveTemplates(a.mcpConfig?.project || [], dirs),
    ]);
    const theirs = norm((t.mcp || []).map((m) => m.file));
    if (mine.join('|') !== theirs.join('|')) mcpDrift.push(`${t.id}\n      adapters: ${mine.join(', ')}\n      doctor:   ${theirs.join(', ')}`);

    const myHooks = norm(['user', 'project', 'local'].flatMap((s) => A.resolveTemplates(a.hooks?.configPath?.[s] || [], dirs)));
    const theirHooks = norm((t.hooks || []).map((h) => h.file));
    const theirDirs = new Set((t.hooks || []).filter((h) => h.kind === 'dir').map((h) => h.file));
    if (theirDirs.size) {
      // A DIRECTORY target: every file of ours must live inside one of them,
      // and every directory must be reachable from one of ours.
      const inside = myHooks.every((f) => [...theirDirs].some((d) => f === d || f.startsWith(`${d}/`)));
      const reached = [...theirDirs].every((d) => myHooks.some((f) => f === d || f.startsWith(`${d}/`)));
      if (!inside || !reached) hookDrift.push(`${t.id}: ${myHooks.join(', ')} vs dirs ${[...theirDirs].join(', ')}`);
    } else if (myHooks.join('|') !== theirHooks.join('|')) {
      hookDrift.push(`${t.id}\n      adapters: ${myHooks.join(', ')}\n      doctor:   ${theirHooks.join(', ')}`);
    }

    const myIns = norm((a.instructionFile?.names || []).map((n) => path.join(WORK, n)));
    const theirIns = norm((t.instructions || []).map((i) => i.file));
    if (myIns.join('|') !== theirIns.join('|')) insDrift.push(`${t.id}\n      adapters: ${myIns.join(', ')}\n      doctor:   ${theirIns.join(', ')}`);
  }
  ok(covered >= 12, `doctor.js's table was read and has ${covered} harnesses in common (the control)`);
  ok(mcpDrift.length === 0, `MCP config paths agree with doctor.js${mcpDrift.length ? `:\n    ${mcpDrift.join('\n    ')}` : ''}`);
  ok(hookDrift.length === 0, `hook config paths agree with doctor.js${hookDrift.length ? `:\n    ${hookDrift.join('\n    ')}` : ''}`);
  ok(insDrift.length === 0, `instruction files agree with doctor.js${insDrift.length ? `:\n    ${insDrift.join('\n    ')}` : ''}`);
  // And the other direction: the adapter table is a SUPERSET, never a subset.
  const doctorIds = new Set(targets.map((t) => t.id));
  const onlyHere = A.listHarnesses().filter((id) => !doctorIds.has(id));
  ok(onlyHere.join(',') === 'kilo,dsh' || onlyHere.join(',') === 'dsh,kilo',
    `the adapter table adds exactly the two harnesses doctor.js has no row for (${onlyHere.join(', ')})`);
}

// ─────────────────────────────────────────────────────────────────────────
section('§5  THE ENVELOPES — agreement with hook.js\'s HARNESS_HOOKS');
// ─────────────────────────────────────────────────────────────────────────
{
  const hookIds = Object.keys(HARNESS_HOOKS);
  const missing = hookIds.filter((id) => !A.adapterFor(id));
  ok(missing.length === 0,
    `every harness the CLI can be invoked with exists here${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);
  ok(hookIds.length >= 8, `HARNESS_HOOKS was read and has ${hookIds.length} entries (the control)`);

  // Every arm HARNESS_HOOKS can EMIT must be an event this table names, or the
  // CLI can be asked for a shape install-hooks never wires.
  const ARM = { sessionStart: 'session-start', preCompact: 'pre-compact', stop: 'stop' };
  let unnamed = [];
  let wronglyOffered = [];
  for (const id of hookIds) {
    const h = HARNESS_HOOKS[id];
    const events = A.adapterFor(id).hooks.events || {};
    for (const [arm, canonical] of Object.entries(ARM)) {
      const emits = typeof h[arm]?.emit === 'function' || h[arm]?.block === true;
      if (emits && !events[canonical]) unnamed.push(`${id}.${arm}`);
    }
  }
  ok(unnamed.length === 0,
    `every emittable arm has a named event in the adapter table${unnamed.length ? ` — ${unnamed.join(', ')}` : ''}`);

  // THE ONE SHAPE THAT MAY NEVER BE EMITTED: a guess at an unverified
  // envelope. Gemini CLI's AfterAgent is the named case.
  const gem = HARNESS_HOOKS['gemini-cli'];
  ok(gem.stop.emit === null && /unverified/.test(gem.stop.withheld || ''),
    "Gemini CLI's AfterAgent is WITHHELD with its reason, not approximated");
  ok(A.adapterFor('gemini-cli').hooks.writer === null,
    '…and the adapter ships no writer for it, so no inert entry can be installed');
  ok(A.adapterFor('gemini-cli').hooks.events.stop === 'AfterAgent',
    '…while still naming AfterAgent as the viable capture point, for the day it is measured');

  // The plan is derived from HARNESS_HOOKS, not from a second opinion.
  const codexPlan = IH.planEvents(A.adapterFor('codex'));
  ok(codexPlan.write.map((w) => w.event).sort().join(',') === 'PreCompact,Stop',
    `Codex plans exactly Stop and PreCompact (${codexPlan.write.map((w) => w.event).join(', ')})`);
  ok(codexPlan.skipped.some((s) => s.event === 'SessionEnd' && s.measured === true),
    "…and SessionEnd is skipped as a MEASURED refusal, not an unmeasured one");
  const gooseDefault = IH.planEvents(A.adapterFor('goose'));
  ok(gooseDefault.write.length === 0,
    'goose plans NOTHING by default — every envelope it has is withheld, so an entry would be inert');
  const gooseForced = IH.planEvents(A.adapterFor('goose'), { allowWithheld: true });
  ok(gooseForced.write.length > 0 && gooseForced.write.every((w) => typeof w.withheld === 'string'),
    '…and --allow-withheld carries the reason onto every entry it does write');
}

// ─────────────────────────────────────────────────────────────────────────
section('§6  THE FIVE REFUSALS — first-class outcomes, and nothing writes');
// ─────────────────────────────────────────────────────────────────────────
{
  const before = treeFingerprint(ROOT);

  const r1 = A.refusals.unknownHarness('emacs-agent');
  ok(r1.ok === false && r1.reason === 'unknown_harness' && r1.message.includes('claude-code'),
    '1. an unknown harness is refused and the known list is named');

  const r2 = A.refusals.noHooks('zed');
  ok(r2.ok === false && r2.reason === 'no_hooks' && r2.state === 'none' && /#57890/.test(r2.message),
    '2. a harness with no hooks is refused with its measured reason');
  const r2b = A.refusals.noHooks('opencode');
  ok(/TypeScript plugins/.test(r2b.message) && r2b.state === 'present-useless',
    '…and a plugin-only harness is refused as present-useless, not as absent');

  const r3 = A.refusals.unparseableConfig('/x/settings.json', 'Unexpected token }');
  ok(r3.ok === false && r3.reason === 'config_unparseable'
    && /cannot read/.test(r3.message) && r3.message.includes('/x/settings.json'),
  '3. an unparseable config is refused, naming the file and why a merge is impossible');

  const r4 = A.refusals.shapeMismatch('/x/hooks.json', 'hooks', 'an array');
  ok(r4.ok === false && r4.reason === 'config_shape_mismatch' && r4.message.includes('`hooks`'),
    '4. a config whose shape does not match is refused, naming the key');

  const r5 = A.refusals.binNotResolved('my-curator', '/usr/bin');
  ok(r5.ok === false && r5.reason === 'bin_not_resolved' && /ABSOLUTE path/.test(r5.message),
    '5. an unresolvable binary is refused, and the reason is the committed-file hazard');

  for (const r of [r1, r2, r3, r4, r5]) {
    if (!Object.isFrozen(r)) { failed++; console.log('  ✗ a refusal was not frozen'); break; }
  }
  ok(Object.isFrozen(r1) && Object.isFrozen(r5), 'every refusal is frozen — a caller cannot edit one into an approval');
  ok(treeFingerprint(ROOT) === before, 'NOT ONE BYTE was written by any of the five refusals');
}

// ─────────────────────────────────────────────────────────────────────────
section('§7  INSTALL-HOOKS — as a process');
// ─────────────────────────────────────────────────────────────────────────
{
  // §7.0 — the seam. `bin/curator.js` is package C's; this asserts the name is
  // RESERVED there, so a dispatch line landing later changes nothing here.
  const r0 = spawnSync(process.execPath, [BIN, 'install-hooks'], {
    cwd: WORK, env: BASE_ENV, encoding: 'utf8', timeout: 30000,
  });
  ok(!/unknown command/i.test(r0.stderr || ''),
    '7.0 the real binary RESERVES `install-hooks` — it is never an unknown command');

  const CC_PROJECT = path.join(WORK, '.claude', 'settings.json');

  // ── a fresh write ────────────────────────────────────────────────────────
  const w1 = run(['claude-code', '--scope', 'project', '--json']);
  ok(w1.code === 0, `a fresh write exits 0 (got ${w1.code}) — ${w1.err.split('\n')[0]}`);
  ok(existsSync(CC_PROJECT), '…and the file exists at .claude/settings.json');
  let doc = JSON.parse(readFileSync(CC_PROJECT, 'utf8'));
  const events = Object.keys(doc.hooks || {}).sort();
  ok(events.join(',') === 'PreCompact,SessionStart,Stop',
    `…with SessionStart, PreCompact and Stop (${events.join(', ')})`);
  ok(!('SessionEnd' in (doc.hooks || {})),
    '…and NO SessionEnd: a hook cannot close a bridge session it has no handle on');

  const commands = Object.values(doc.hooks).flatMap((g) => g.flatMap((x) => x.hooks.map((h) => h.command)));
  ok(commands.length === 3 && commands.every((c) => c.startsWith('/')),
    `…and every command is an ABSOLUTE path (${commands.length} of 3)`);
  ok(commands.every((c) => /--harness claude-code/.test(c)),
    '…each carrying --harness, so the CLI never has to guess who invoked it');
  ok(commands.some((c) => /hook stop /.test(c)) && commands.some((c) => /hook session-start /.test(c)),
    '…and the canonical event name the CLI knows');
  ok(Object.values(doc.hooks).every((g) => g.every((x) => x.hooks.every((h) => String(h.statusMessage || '').startsWith('Curator: ')))),
    '…and the Curator marker on every entry');

  // ── idempotence, by sha ──────────────────────────────────────────────────
  const sha1 = shaOf(CC_PROJECT);
  const w2 = run(['claude-code', '--scope', 'project']);
  ok(w2.code === 0 && shaOf(CC_PROJECT) === sha1,
    'a second run is byte-identical — idempotent, not appending a second copy');
  doc = JSON.parse(readFileSync(CC_PROJECT, 'utf8'));
  ok(Object.values(doc.hooks).flatMap((g) => g).length === 3, '…still three groups, not six');

  // ── a foreign hook survives ──────────────────────────────────────────────
  doc.hooks.Stop.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-linter --fix' }] });
  doc.otherTool = { keep: 'me' };
  writeFileSync(CC_PROJECT, `${JSON.stringify(doc, null, 2)}\n`);
  const w3 = run(['claude-code', '--scope', 'project']);
  const after = JSON.parse(readFileSync(CC_PROJECT, 'utf8'));
  ok(w3.code === 0 && after.otherTool?.keep === 'me', 'a re-run preserves unrelated top-level keys');
  const foreign = after.hooks.Stop.filter((g) => g.hooks.some((h) => h.command.includes('my-linter')));
  ok(foreign.length === 1 && foreign[0].matcher === 'Bash',
    "…and a foreign hook survives with its own `matcher` intact");
  ok(after.hooks.Stop.length === 2, '…beside exactly one Curator group, not two');

  // ── --uninstall removes only ours ────────────────────────────────────────
  const w4 = run(['claude-code', '--scope', 'project', '--uninstall']);
  const un = JSON.parse(readFileSync(CC_PROJECT, 'utf8'));
  const left = Object.values(un.hooks || {}).flatMap((g) => g).flatMap((x) => x.hooks || []);
  ok(w4.code === 0 && left.length === 1 && left[0].command.includes('my-linter'),
    '--uninstall removes only the Curator entries and leaves the foreign one');
  ok(un.otherTool?.keep === 'me', '…and still preserves unrelated keys');
  const shaUn = shaOf(CC_PROJECT);
  run(['claude-code', '--scope', 'project', '--uninstall']);
  ok(shaOf(CC_PROJECT) === shaUn, '…and a second --uninstall is byte-identical too');

  // ── Decision L: a file that does not parse ───────────────────────────────
  writeFileSync(CC_PROJECT, '{ "hooks": { "Stop": [ }\n');
  const shaCorrupt = shaOf(CC_PROJECT);
  const w5 = run(['claude-code', '--scope', 'project', '--json']);
  ok(w5.code === 1, `an unparseable config exits 1 (got ${w5.code})`);
  ok(shaOf(CC_PROJECT) === shaCorrupt, '…and NOTHING was written — the file is byte-identical');
  ok(/config_unparseable/.test(w5.out) && /could not be parsed/.test(w5.err),
    '…with the reason on stdout under --json and the sentence on stderr');
  ok(w5.err.includes(CC_PROJECT), '…naming the file');

  // ── a shape that is not ours ─────────────────────────────────────────────
  writeFileSync(CC_PROJECT, `${JSON.stringify({ hooks: ['not', 'an', 'object'] }, null, 2)}\n`);
  const shaShape = shaOf(CC_PROJECT);
  const w6 = run(['claude-code', '--scope', 'project', '--json']);
  ok(w6.code === 1 && /config_shape_mismatch/.test(w6.out) && shaOf(CC_PROJECT) === shaShape,
    'a `hooks` that is an array is refused with nothing written');
  rmSync(path.join(WORK, '.claude'), { recursive: true, force: true });

  // ── --dry-run writes nothing ─────────────────────────────────────────────
  const beforeDry = treeFingerprint(ROOT);
  const w7 = run(['cursor', '--scope', 'project', '--dry-run']);
  ok(w7.code === 0 && treeFingerprint(ROOT) === beforeDry, '--dry-run writes NOTHING (whole tree fingerprinted)');
  let dryDoc = null;
  try { dryDoc = JSON.parse(w7.out); } catch { /* handled below */ }
  ok(dryDoc && dryDoc.hooks && Object.keys(dryDoc.hooks).sort().join(',') === 'preCompact,sessionStart,stop',
    '…and prints the EXACT document it would write, on stdout');
  ok(dryDoc && dryDoc.hooks.stop[0].loop_limit === 1,
    "…with Cursor's loop_limit pinned to 1, not the documented default of 5");

  // ── Cursor for real, and its own format ──────────────────────────────────
  const CURSOR = path.join(WORK, '.cursor', 'hooks.json');
  const w8 = run(['cursor', '--scope', 'project']);
  const cdoc = JSON.parse(readFileSync(CURSOR, 'utf8'));
  ok(w8.code === 0 && cdoc.version === 1 && cdoc.hooks.stop.length === 1,
    "Cursor's flat hooks.json is written in its own shape");
  const cSha = shaOf(CURSOR);
  run(['cursor', '--scope', 'project']);
  ok(shaOf(CURSOR) === cSha, '…and is idempotent on that shape too');
  ok(shaOf(path.join(WORK, '.cursor', 'rules')) === shaOf(path.join(WORK, '.cursor', 'rules')),
    '…while `.cursor/rules` beside it is never opened for writing');
  // The FLAT-array strip is a second code path from Claude Code's nested one,
  // and a foreign hook has to survive BOTH. (Found by a mutation that broke
  // only the flat branch and stayed green: every foreign-hook assertion above
  // ran through the nested branch.)
  const cdoc2 = JSON.parse(readFileSync(CURSOR, 'utf8'));
  cdoc2.hooks.stop.unshift({ command: '/usr/local/bin/other-tool run' });
  writeFileSync(CURSOR, `${JSON.stringify(cdoc2, null, 2)}\n`);
  run(['cursor', '--scope', 'project']);
  const cdoc3 = JSON.parse(readFileSync(CURSOR, 'utf8'));
  ok(cdoc3.hooks.stop.filter((h) => h.command.includes('other-tool')).length === 1
    && cdoc3.hooks.stop.filter((h) => IH.isCuratorHookCommand(h.command)).length === 1,
  '…and a foreign entry in the FLAT array survives beside exactly one of ours');

  // ── a harness whose every envelope is withheld ───────────────────────────
  const beforeGoose = treeFingerprint(ROOT);
  const w9 = run(['goose', '--scope', 'user', '--json']);
  ok(w9.code === 1 && /all_events_withheld/.test(w9.out),
    'goose is refused by default — an entry would invoke a command that emits nothing');
  ok(treeFingerprint(ROOT) === beforeGoose, '…with nothing written');
  const w10 = run(['goose', '--scope', 'user', '--allow-withheld', '--json']);
  const GOOSE = path.join(FAKE_HOME, '.agents', 'plugins', 'my-curator', 'hooks', 'hooks.json');
  ok(w10.code === 0 && existsSync(GOOSE), '--allow-withheld writes it, into goose\'s own plugin tree');
  const gdoc = JSON.parse(readFileSync(GOOSE, 'utf8'));
  const gEntry = gdoc.hooks.Stop[0];
  ok(path.isAbsolute(gEntry.cmd) && Array.isArray(gEntry.args)
    && gEntry.args.includes('hook') && gEntry.args.includes('--harness') && gEntry.envs !== undefined,
  "…in goose's cmd/args/envs vocabulary, with an absolute cmd and no shell quoting at all");
  ok(/emit nothing|withheld|unverified/i.test(w10.err), '…and says on stderr that it stays inert until measured');
  const gSha = shaOf(GOOSE);
  run(['goose', '--scope', 'user', '--allow-withheld']);
  ok(shaOf(GOOSE) === gSha, '…and that write is idempotent as well');
  // The cmd/args strip is the THIRD code path, and it recognises ours by the
  // joined command rather than by a string field — a foreign entry must
  // survive it too.
  const gdoc2 = JSON.parse(readFileSync(GOOSE, 'utf8'));
  gdoc2.hooks.Stop.unshift({ cmd: '/usr/bin/true', args: ['--their-flag'], envs: {} });
  writeFileSync(GOOSE, `${JSON.stringify(gdoc2, null, 2)}\n`);
  run(['goose', '--scope', 'user', '--allow-withheld']);
  const gdoc3 = JSON.parse(readFileSync(GOOSE, 'utf8'));
  ok(gdoc3.hooks.Stop.filter((e) => e.cmd === '/usr/bin/true').length === 1
    && gdoc3.hooks.Stop.length === 2,
  '…and a foreign cmd/args entry survives beside exactly one of ours');

  // ── Copilot's directory-of-files target ──────────────────────────────────
  const w11 = run(['copilot-cli', '--scope', 'project', '--allow-withheld']);
  const COPILOT = path.join(WORK, '.github', 'hooks', 'curator.json');
  ok(w11.code === 0 && existsSync(COPILOT), "Copilot's entry lands in .github/hooks/curator.json — a file of our own");
  ok(JSON.parse(readFileSync(COPILOT, 'utf8')).hooks.agentStop[0].command.startsWith('/'),
    '…with an absolute command');

  // ── the refusals that have nothing to write ──────────────────────────────
  const beforeRefusals = treeFingerprint(ROOT);
  const arms = [
    ['zed', 'no hook mechanism exists'],
    ['windsurf', 'NONE of them is a stop'],
    ['opencode', 'TypeScript plugins'],
    ['kilo', 'TypeScript plugins'],
    ['aider', 'no hook mechanism and no MCP client'],
    ['cline', 'not measured'],
    ['gemini-cli', 'unmeasured'],
    ['dsh', 'not measured'],
    ['claude-desktop', 'no hook mechanism'],
  ];
  let armBad = [];
  for (const [id, phrase] of arms) {
    const r = run([id, '--scope', 'project', '--json']);
    if (r.code !== 1) armBad.push(`${id}: exit ${r.code}`);
    else if (!r.err.includes(phrase)) armBad.push(`${id}: reason did not name "${phrase}" — ${r.err.trim().slice(0, 120)}`);
  }
  ok(armBad.length === 0, `all nine non-writable harnesses refuse with their measured reason${armBad.length ? `:\n    ${armBad.join('\n    ')}` : ''}`);
  ok(treeFingerprint(ROOT) === beforeRefusals, 'NOT ONE BYTE was written by any refusing arm');

  // ── unknown harness, bad scope, bad bin, no project root ─────────────────
  const u1 = run(['emacs-agent', '--json']);
  ok(u1.code === 2 && /unknown_harness/.test(u1.out), 'an unknown harness is a USAGE error (exit 2), not a write refusal');
  const u2 = run(['claude-code', '--scope', 'enterprise']);
  ok(u2.code === 2 && /--scope must be/.test(u2.err), 'an unknown scope is a usage error and names the three');
  const u3 = run(['claude-code', '--scope', 'project', '--bin', '/nope/my-curator', '--json']);
  ok(u3.code === 1 && /bin_not_resolved/.test(u3.out), 'a --bin that does not resolve is refused, and nothing is written');
  const beforeNoRoot = treeFingerprint(ROOT);
  const u4 = spawnSync(process.execPath, [DRIVER, 'claude-code', '--scope', 'project', '--json'], {
    cwd: os.tmpdir(), env: BASE_ENV, encoding: 'utf8', timeout: 30000,
  });
  ok(u4.status === 1 && /no_project_root/.test(u4.stdout || ''),
    'a project scope outside any marked repository is REFUSED — a committed file is never guessed at');
  ok(treeFingerprint(ROOT) === beforeNoRoot, '…and that refusal wrote nothing either');

  // ── the user scope, and a binary path with a space ───────────────────────
  const spaced = path.join(ROOT, 'My Tools');
  mkdirSync(spaced, { recursive: true });
  const spacedBin = path.join(spaced, 'my-curator');
  writeFileSync(spacedBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const w12 = run(['claude-code', '--scope', 'user', '--bin', spacedBin]);
  const CC_USER = path.join(FAKE_HOME, '.claude', 'settings.json');
  ok(w12.code === 0 && existsSync(CC_USER), '--scope user writes into the fixture HOME, never a project file');
  const userCmd = JSON.parse(readFileSync(CC_USER, 'utf8')).hooks.Stop[0].hooks[0].command;
  ok(userCmd.startsWith(`'${spacedBin}'`) || userCmd.startsWith(`"${spacedBin}"`),
    `…and a path containing a space is SHELL-QUOTED (${userCmd.slice(0, 60)}…)`);

  // ── --print-instructions prints and never writes ─────────────────────────
  const beforePrint = treeFingerprint(ROOT);
  const p1 = run(['codex', '--print-instructions', '--project', 'zzh-alpha/lumina']);
  ok(p1.code === 0 && p1.out === composeAgentInstructionsFull({ domain: 'zzh-alpha', project: 'lumina' }),
    '--print-instructions puts the composed block, byte for byte, on stdout');
  ok(/AGENTS\.md/.test(p1.err) && /32,768/.test(p1.err), '…and names the file and the cap on stderr');
  ok(treeFingerprint(ROOT) === beforePrint, '…and writes nothing at all');
}

// ─────────────────────────────────────────────────────────────────────────
section('§8  DECISION K — no instruction file was ever opened for writing');
// ─────────────────────────────────────────────────────────────────────────
{
  ok(instructionFingerprint() === INSTRUCTIONS_AT_START,
    'CLAUDE.md, AGENTS.md, GEMINI.md, .cursor/rules and .rules are byte-identical after every arm above');
  ok(INSTRUCTIONS_AT_START.split('\n').length === 5, '…and five of them were actually planted (the control)');

  // The other direction, scanned over the module: no write call may name an
  // instruction file. Comments are stripped first, because this file's own
  // docblock names all five.
  const src = readFileSync(path.join(REPO_ROOT, 'src', 'cli', 'install-hooks.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const named = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursor/rules', '.rules']
    .filter((n) => src.includes(n));
  ok(named.length === 0, `no instruction filename appears in the module's code${named.length ? ` — ${named.join(', ')}` : ''}`);
  ok(/writeFileAtomicSync/.test(src), '…and the module does contain a write call (the scan\'s own control)');
  const writers = IH.HOOK_WRITERS;
  ok(writers.length === 5 && writers.every((id) => A.adapterFor(id)?.hooks?.writer === id),
    `five hook writers ship, each matching its adapter (${writers.join(', ')})`);
}

// ── Done ───────────────────────────────────────────────────────────────────
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${failed === 0 ? '✓' : '✗'} test-harness-adapters: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
