#!/usr/bin/env node
/**
 * OFFLINE — the per-harness adapter table.
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
 *   §6 THE FIVE REFUSALS, each driven as a first-class outcome, with the whole
 *      fixture tree fingerprinted — a refusal that writes a file is this
 *      package's worst outcome.
 *
 * The hook WRITERS are package H2 and join this same file when they land; this
 * commit is the table, the MCP entries, the snippets and the refusals — which
 * is already what makes `my-curator doctor` and the matrix honest.
 *
 * SAFETY — never touches real user data or a real harness config. Nothing here
 * writes at all, and §6 proves it by fingerprinting the whole fixture tree
 * across every refusal. `CURATOR_TEST_DOMAINS_DIR` and
 * `CURATOR_TEST_USER_DATA_DIR` are pinned to a tempdir. No network.
 */
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

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
for (const d of [DOMAINS_DIR, USER_DATA_DIR, FAKE_HOME, WORK]) mkdirSync(d, { recursive: true });
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

// Pinned even though nothing here spawns a child yet: the fixture's whole
// point is that no real harness configuration can be reached.
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;

// ── Modules under test ─────────────────────────────────────────────────────
const A = await import('../src/brain/harness-adapters.js');
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

// ── Done ───────────────────────────────────────────────────────────────────
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${failed === 0 ? '✓' : '✗'} test-harness-adapters: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
