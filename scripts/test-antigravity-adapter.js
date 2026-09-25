#!/usr/bin/env node
/**
 * test-antigravity-adapter.js — v3.76.0 (W2). Antigravity as a first-class
 * harness in the tooling: its adapter row, its two hooks, its install-hooks
 * writer, its doctor row, and its (unidentified) MCP client label.
 *
 * Everything here runs against a FIXTURE: a temp HOME, a temp domains folder,
 * a temp user-data folder and a temp hook-marker folder. No real `~/.gemini`
 * file is read or written — HOME is pointed away for every child, and §0
 * asserts it.
 *
 * What it exists to stop:
 *   §1 an adapter row that claims more than the vendor docs say — the hooks
 *      are documented-not-measured (`measured: null`, `shapeVerified: false`),
 *      the client label is NOT seeded, the instruction files are AGENTS.md and
 *      GEMINI.md and never CLAUDE.md.
 *   §2 a session-start hook that injects on EVERY model call. Antigravity's
 *      PreInvocation fires before each one; the CLI must inject once per
 *      conversation id and emit `{}` after — and still inject when no id is
 *      sent (nothing to key "once" on).
 *   §3 a Stop hook that nags, loops, fires on an error stop, or leaves stdout
 *      empty (the vendor contract says a JSON object, always).
 *   §4 an install-hooks writer that clobbers somebody else's named hook, is
 *      not idempotent, or writes into a file it cannot parse.
 *   §5 a doctor row that does not see the MCP files, the hook file, the
 *      skills (and whether they match this version, by hash), or the block.
 *   §6 a label that is guessed: Antigravity's sessions stay `other` until the
 *      name it sends is observed.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, readdirSync, statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'curator.js');

let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const shaOf = (f) => { try { return sha(readFileSync(f)); } catch { return 'ABSENT'; } };

// ── Fixture ────────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-agy-'));
const DOMAINS_DIR = path.join(ROOT, 'domains');
const USER_DATA_DIR = path.join(ROOT, 'userdata');
const FAKE_HOME = path.join(ROOT, 'home');
const HOOK_DIR = path.join(ROOT, 'hookmarkers');
const WORK = path.join(ROOT, 'work');
const ELSEWHERE = path.join(ROOT, 'elsewhere');
for (const d of [USER_DATA_DIR, FAKE_HOME, WORK, ELSEWHERE]) mkdirSync(d, { recursive: true });

const D = 'zzagy-alpha';
mkdirSync(path.join(DOMAINS_DIR, D, 'wiki', 'entities'), { recursive: true });
writeFileSync(path.join(DOMAINS_DIR, D, 'CLAUDE.md'), `# ${D}\n\nThrowaway fixture.\n`);
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;

const store = await import('../src/brain/working-state.js');
{
  const r = await store.createProject(D, 'lumina', {
    brief: '# Project brief — lumina\n\n## Standing brief\n\nBuild lumina carefully.\n',
  });
  if (!r.ok) throw new Error(`fixture: createProject — ${r.reason}`);
  const s = await store.saveWorkingState(D, {
    project: 'lumina', scope: 'main', headline: 'fixture state for the Antigravity suite',
    nowState: 'seeded', nextSteps: ['nothing'],
  });
  if (!s.ok) throw new Error(`fixture: saveWorkingState — ${s.reason}`);
}
writeFileSync(path.join(WORK, '.curator-project'), `${D}/lumina\n`);

const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete e[k];
  e.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
  e.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;
  e.CURATOR_TEST_HOOK_DIR = HOOK_DIR;
  e.HOME = FAKE_HOME;
  e.USERPROFILE = FAKE_HOME;
  return e;
})();

function run(args, { cwd = ROOT, input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, input, env: { ...BASE_ENV, ...env }, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const parse = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

const USAGE_LOG = path.join(USER_DATA_DIR, '.mcp-usage.jsonl');
const usageLine = (tool, extra = {}) => JSON.stringify({
  ts: new Date().toISOString(), tool, domain: D, ok: true, refused: false, ms: 4, ...extra,
});

/** An Antigravity hook payload: camelCase, `workspacePaths`, no `cwd`. */
const payload = (conversationId, extra = {}) => JSON.stringify({
  ...(conversationId ? { conversationId } : {}),
  workspacePaths: [WORK],
  transcriptPath: path.join(WORK, '.gemini', 'antigravity', 'transcript.jsonl'),
  modelName: 'auto',
  ...extra,
});

const A = await import('../src/brain/harness-adapters.js');
const { HARNESS_HOOKS, payloadCwd } = await import('../src/cli/hook.js');
const clients = await import('../src/brain/mcp-clients.js');

// ═══════════════════════════════════════════════════════════════════════════
section('§0  The fixture never touches the real home');
{
  ok(BASE_ENV.HOME === FAKE_HOME && FAKE_HOME.startsWith(os.tmpdir()), 'every child runs with HOME inside the temp fixture');
  ok(!FAKE_HOME.includes('.gemini'), '…and nothing under it is a real ~/.gemini');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  The adapter row says what the vendor docs say, and no more');
{
  const a = A.adapterFor('antigravity');
  ok(a && a.label === 'Antigravity', 'an `antigravity` row exists, labelled Antigravity');
  ok(a.instructionFile.names.join(',') === 'AGENTS.md,GEMINI.md', 'instruction files: AGENTS.md and GEMINI.md');
  ok(!a.instructionFile.names.includes('CLAUDE.md'), '…and NEVER CLAUDE.md (measured 2026-09-25: it does not read it)');
  ok(a.instructionFile.cap === 24000, 'the 24,000-byte per-rule-file cap is carried');
  const mcp = A.resolveTemplates(a.mcpConfig.user, { home: '/h', project: '/p' });
  ok(mcp.join('|') === '/h/.gemini/config/mcp_config.json|/h/.gemini/antigravity/mcp_config.json|/h/.gemini/antigravity-ide/mcp_config.json',
    'all three MCP config files are looked at (documented global + the two observed app folders)', mcp.join(', '));
  ok(a.hooks.events['session-start'] === 'PreInvocation' && a.hooks.events.stop === 'Stop',
    'hooks: PreInvocation carries the session start, Stop carries the ask');
  ok(a.hooks.firstInvocationOnly === true, '…and the table says PreInvocation fires on every call, so it is once-only');
  ok(a.hooks.shapeVerified === false && a.measured === null,
    'DOCUMENTED, NOT MEASURED: shapeVerified is false and `measured` is null');
  ok(a.hooks.writer === 'antigravity' && A.canWriteHooks('antigravity'), 'a hook writer ships for it');
  ok(A.hookConfigPaths('antigravity', 'user').map(A.displayTemplate).join() === '~/.gemini/config/hooks.json'
    && A.hookConfigPaths('antigravity', 'project').map(A.displayTemplate).join() === '.agents/hooks.json',
  'hook files: ~/.gemini/config/hooks.json (user) and .agents/hooks.json (project)');
  ok(a.clientInfo.verified === false && a.clientInfo.names.length === 0,
    'the MCP client name is NOT seeded — nothing observed, nothing claimed');
  ok(Array.isArray(a.observations) && a.observations.length >= 2 && Object.isFrozen(a.observations)
    && a.observations.every((o) => typeof o === 'string') && !a.observations.join(' ').includes('%'),
  'single live sessions are frozen sentences, not counts');
  ok(A.skillRootsFor('antigravity', { home: '/h', project: '/p' }).join('|') === '/h/.gemini/config|/p/.agents',
    'skill roots: ~/.gemini/config and .agents');
  ok(A.skillRootsFor('claude-code', { home: '/h', project: '/p' }).length === 0,
    '…and a harness whose row carries no roots gets none (the control)');
  const hn = await import('../src/brain/harness-names.js');
  ok(hn.harnessId('Antigravity') === 'antigravity' && hn.normaliseHarness('antigravity').label === a.label,
    "the tool-name table and the adapter agree on the id and the label");
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  session-start (PreInvocation): once per conversation, in its own envelope');
{
  ok(payloadCwd({ workspacePaths: ['/w'] }) === '/w' && payloadCwd({ cwd: '/c', workspacePaths: ['/w'] }) === '/c'
    && payloadCwd({}) === null, 'the working folder comes from `workspacePaths` when no `cwd` is sent');

  // The hook runs in the folder that HOLDS hooks.json (here: ELSEWHERE, no
  // marker) — the project must come from the payload, not from process.cwd().
  const first = run(['hook', 'session-start', '--harness', 'antigravity'], { cwd: ELSEWHERE, input: payload('agy-conv-1') });
  const j = parse(first);
  const text = j?.injectSteps?.[0]?.ephemeralMessage;
  ok(first.code === 0 && Array.isArray(j?.injectSteps) && j.injectSteps.length === 1,
    'the first call emits `injectSteps` with one step', first.stdout.slice(0, 200) || first.stderr);
  ok(typeof text === 'string' && text.startsWith(`# Project context — ${D}/lumina`),
    '…an `ephemeralMessage` carrying the framed bootstrap, resolved from workspacePaths');
  ok(j && Object.keys(j).join() === 'injectSteps' && !('userMessage' in (j.injectSteps[0] || {})),
    '…and never a `userMessage` — recorded state is not put in the user\'s mouth');
  ok(!('hookSpecificOutput' in (j || {})) && !('additional_context' in (j || {})),
    '…and never another harness\'s shape');

  const second = run(['hook', 'session-start', '--harness', 'antigravity'], { cwd: ELSEWHERE, input: payload('agy-conv-1', { invocationNum: 2 }) });
  ok(second.code === 0 && second.stdout.trim() === '{}',
    'the SECOND model call in the same conversation gets `{}` — no re-injection', second.stdout.slice(0, 120));
  ok(/already injected/.test(second.stderr), '…and says why on stderr');

  const other = run(['hook', 'session-start', '--harness', 'antigravity'], { cwd: ELSEWHERE, input: payload('agy-conv-2') });
  ok(parse(other)?.injectSteps?.length === 1, 'a NEW conversation id is injected again (the control)');

  const noId1 = run(['hook', 'session-start', '--harness', 'antigravity'], { cwd: WORK, input: payload(null) });
  const noId2 = run(['hook', 'session-start', '--harness', 'antigravity'], { cwd: WORK, input: payload(null) });
  ok(parse(noId1)?.injectSteps && parse(noId2)?.injectSteps,
    'with NO conversation id both calls inject — there is nothing to key "once" on');

  const nowhere = run(['hook', 'session-start', '--harness', 'antigravity'], {
    cwd: ELSEWHERE, input: JSON.stringify({ conversationId: 'agy-nowhere', workspacePaths: [ELSEWHERE] }),
  });
  ok(nowhere.code === 0 && nowhere.stdout.trim() === '{}',
    'no resolvable project: exit 0 and `{}` — the documented JSON object, never an empty stdout');

  const ctx = run(['context', '--for-hook', '--harness', 'antigravity', '--project', `${D}/lumina`]);
  ok(typeof parse(ctx)?.injectSteps?.[0]?.ephemeralMessage === 'string',
    '`my-curator context --for-hook --harness antigravity` emits the same envelope');
  // v3.76.0: the injection says whose work-stream it opened and where saves go.
  ok(/Opened the newest work-stream, scope 'main' \(.*\) — not Antigravity's own\. Antigravity's saves go to its own scope 'antigravity'/.test(text || ''),
    "the bootstrap says it opened `main`, not Antigravity's own, and that Antigravity's saves go to `antigravity`",
    (text || '').split('\n').find((l) => /saves go/.test(l)));
  ok(/Antigravity's saves go to its own scope 'antigravity'/.test(parse(ctx)?.injectSteps?.[0]?.ephemeralMessage || ''),
    '…and `context --for-hook` carries the same line');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  Stop: ask once, only on a model stop, always a JSON object');
{
  const start = (id) => run(['hook', 'session-start', '--harness', 'antigravity'], { cwd: ELSEWHERE, input: payload(id) });
  const stop = (id, extra = {}) => run(['hook', 'stop', '--harness', 'antigravity'], {
    cwd: ELSEWHERE, input: payload(id, { executionNum: 1, terminationReason: 'model_stop', fullyIdle: true, ...extra }),
  });

  start('agy-stop-1');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const s1 = stop('agy-stop-1');
  const j1 = parse(s1);
  ok(s1.code === 0 && j1?.decision === 'continue', 'a session that read and did not save gets `decision: "continue"`', s1.stdout || s1.stderr);
  ok(typeof j1?.reason === 'string' && j1.reason.includes('save_working_state') && j1.reason.includes(`${D}/lumina`),
    '…with the ask as `reason`, naming the tool and the project');
  ok(j1 && Object.keys(j1).sort().join() === 'decision,reason', '…and no invented third key');
  // v3.76.0: the ask names ANTIGRAVITY'S OWN scope — the fixture's only (and
  // so newest) work-stream is `main`, which a scope-less Antigravity save
  // would never land in.
  ok(typeof j1?.reason === 'string' && j1.reason.includes("scope `antigravity` (Antigravity's own)") && !j1.reason.includes('`main`'),
    "…and the scope it names is Antigravity's own, not the project's newest (`main`)", j1?.reason);
  const s1b = stop('agy-stop-1');
  ok(s1b.code === 0 && s1b.stdout.trim() === '{}', 'the SAME conversation is never asked twice — `{}` (marker, rung 1)');

  start('agy-stop-2');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const err = stop('agy-stop-2', { terminationReason: 'error', error: 'boom' });
  ok(err.code === 0 && err.stdout.trim() === '{}' && /not by a model stop/.test(err.stderr),
    'a loop that ended on an ERROR is not forced back into motion');
  const maxed = stop('agy-stop-2', { terminationReason: 'max_steps_exceeded' });
  ok(maxed.stdout.trim() === '{}', '…nor one that hit the step limit');
  const control = stop('agy-stop-2');
  ok(parse(control)?.decision === 'continue', '…and the CONTROL: the same conversation on a model stop IS asked');

  start('agy-stop-3');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n${usageLine('save_working_state')}\n`);
  const saved = stop('agy-stop-3');
  ok(saved.stdout.trim() === '{}' && /rung 3/.test(saved.stderr), 'a save in the conversation: no ask, `{}`');

  start('agy-stop-4');
  writeFileSync(USAGE_LOG, '');
  const noBridge = stop('agy-stop-4');
  ok(noBridge.stdout.trim() === '{}' && /rung 4/.test(noBridge.stderr),
    'no bridge session in the window: no ask (the ladder is the shared one)');

  const pc = run(['hook', 'pre-compact', '--harness', 'antigravity'], { cwd: ELSEWHERE, input: payload('agy-stop-1') });
  ok(pc.code === 0 && pc.stdout.trim() === '{}', 'pre-compact (not documented on Antigravity) emits only `{}`');

  ok(HARNESS_HOOKS.antigravity.stop.block !== true, 'Antigravity is never exit-2 blocked — its contract is a JSON decision');
  // The claude-code path is untouched by the empty-envelope rule.
  const cc = run(['hook', 'session-start', '--harness', 'claude-code'], {
    cwd: ELSEWHERE, input: JSON.stringify({ session_id: 'cc-x', cwd: ELSEWHERE }),
  });
  ok(cc.code === 0 && cc.stdout === '', "…and Claude Code still gets an EMPTY stdout when nothing is injected (the control)");
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  install-hooks antigravity — a named hook, merged, never clobbering');
{
  const USER_FILE = path.join(FAKE_HOME, '.gemini', 'config', 'hooks.json');
  const w1 = run(['install-hooks', 'antigravity', '--scope', 'user', '--json'], { cwd: WORK });
  ok(w1.code === 0 && existsSync(USER_FILE), 'user scope writes ~/.gemini/config/hooks.json (in the fixture home)', w1.stderr);
  let doc = JSON.parse(readFileSync(USER_FILE, 'utf8'));
  ok(Object.keys(doc).join() === 'my-curator', '…one named hook, `my-curator`');
  ok(Object.keys(doc['my-curator']).sort().join() === 'PreInvocation,Stop', '…with PreInvocation and Stop, nothing else');
  const hs = [...doc['my-curator'].PreInvocation, ...doc['my-curator'].Stop];
  ok(hs.every((h) => h.type === 'command' && path.isAbsolute(h.command.split(' ')[0]) && typeof h.timeout === 'number'),
    '…FLAT handlers ({type, command, timeout}), each command an absolute path');
  ok(hs.every((h) => /--harness antigravity/.test(h.command)) && /hook session-start /.test(hs[0].command) && /hook stop /.test(hs[1].command),
    '…carrying --harness antigravity and the canonical event');
  ok(!hs.some((h) => 'matcher' in h || 'hooks' in h), '…never wrapped in a matcher group (that is PreToolUse\'s shape)');
  ok(/not measured/.test(w1.stderr) && /PostInvocation/.test(w1.stderr), 'stderr says documented-not-measured and names the refused PostInvocation');

  const s1 = shaOf(USER_FILE);
  run(['install-hooks', 'antigravity', '--scope', 'user'], { cwd: WORK });
  ok(shaOf(USER_FILE) === s1, 'a re-run is byte-identical');

  doc = JSON.parse(readFileSync(USER_FILE, 'utf8'));
  doc['lint-checker'] = { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh', timeout: 10 }] }] };
  doc.reminder = { enabled: false, PreInvocation: [{ type: 'command', command: './reminder.sh' }] };
  writeFileSync(USER_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  run(['install-hooks', 'antigravity', '--scope', 'user'], { cwd: WORK });
  const after = JSON.parse(readFileSync(USER_FILE, 'utf8'));
  ok(after['lint-checker']?.PostToolUse?.[0]?.matcher === 'run_command' && after.reminder?.enabled === false
    && after.reminder.PreInvocation[0].command === './reminder.sh',
  'a re-run leaves every other named hook exactly as found (its matcher, its `enabled`)');
  ok(after['my-curator'].PreInvocation.length === 1 && after['my-curator'].Stop.length === 1, '…beside ONE copy of ours');

  const un = run(['install-hooks', 'antigravity', '--scope', 'user', '--uninstall'], { cwd: WORK });
  const undoc = JSON.parse(readFileSync(USER_FILE, 'utf8'));
  ok(un.code === 0 && !('my-curator' in undoc) && 'lint-checker' in undoc && 'reminder' in undoc,
    '--uninstall removes our named hook and only ours');

  writeFileSync(USER_FILE, '{ "my-curator": { "Stop": [ }');
  const bad = shaOf(USER_FILE);
  const r = run(['install-hooks', 'antigravity', '--scope', 'user', '--json'], { cwd: WORK });
  ok(r.code === 1 && /config_unparseable/.test(r.stdout) && shaOf(USER_FILE) === bad,
    'an unparseable hooks.json is REFUSED and left byte-identical');
  writeFileSync(USER_FILE, JSON.stringify({ someone: ['not', 'a', 'hook'] }));
  const bad2 = shaOf(USER_FILE);
  const r2 = run(['install-hooks', 'antigravity', '--scope', 'user', '--json'], { cwd: WORK });
  ok(r2.code === 1 && /config_shape_mismatch/.test(r2.stdout) && shaOf(USER_FILE) === bad2,
    'a top-level value that is not a named hook is refused, nothing written');
  rmSync(USER_FILE, { force: true });

  const PROJECT_FILE = path.join(WORK, '.agents', 'hooks.json');
  const dry = run(['install-hooks', 'antigravity', '--scope', 'project', '--dry-run'], { cwd: WORK });
  ok(dry.code === 0 && !existsSync(PROJECT_FILE) && parse(dry)?.['my-curator']?.Stop,
    'project scope --dry-run prints the .agents/hooks.json document and writes nothing');
  const wp = run(['install-hooks', 'antigravity', '--scope', 'project'], { cwd: WORK });
  ok(wp.code === 0 && existsSync(PROJECT_FILE), 'project scope writes .agents/hooks.json at the marked root');

  const pr = run(['install-hooks', 'antigravity', '--print-instructions', '--project', `${D}/lumina`], { cwd: WORK });
  ok(pr.code === 0 && /AGENTS\.md and GEMINI\.md/.test(pr.stderr) && /24,000/.test(pr.stderr),
    '--print-instructions names AGENTS.md and GEMINI.md and the 24,000-byte cap');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  doctor — MCP files, hook file, skills by hash, the AGENTS.md block');
{
  // Three MCP files, one named, one not, one absent.
  const g = (...p) => path.join(FAKE_HOME, '.gemini', ...p);
  mkdirSync(g('config'), { recursive: true });
  mkdirSync(g('antigravity'), { recursive: true });
  writeFileSync(g('config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'my-curator': { command: '/bin/node', args: ['x.js', '--domains-path', DOMAINS_DIR] } } }));
  writeFileSync(g('antigravity', 'mcp_config.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  run(['install-hooks', 'antigravity', '--scope', 'user'], { cwd: WORK });

  // Skills: one byte-identical copy, one stale copy with a missing companion.
  const plug = g('config', 'plugins', 'the-curator', 'skills');
  mkdirSync(plug, { recursive: true });
  cpSync(path.join(REPO_ROOT, 'skills', 'my-curator'), path.join(plug, 'my-curator'), { recursive: true });
  cpSync(path.join(REPO_ROOT, 'skills', 'curator-continuity'), path.join(plug, 'curator-continuity'), { recursive: true });
  writeFileSync(path.join(plug, 'curator-continuity', 'SKILL.md'), `${readFileSync(path.join(plug, 'curator-continuity', 'SKILL.md'), 'utf8')}\nhand edit\n`);
  rmSync(path.join(plug, 'curator-continuity', 'examples.md'));
  writeFileSync(path.join(WORK, 'AGENTS.md'), '# rules\n\nCall get_project_context first; save_working_state before stopping.\n');

  const before = readdirSync(FAKE_HOME, { recursive: true }).map((f) => {
    const p = path.join(FAKE_HOME, f);
    return statSync(p).isFile() ? `${f}:${shaOf(p)}` : f;
  }).sort().join('\n');
  const r = run(['doctor', '--json', '--cwd', WORK], { cwd: WORK });
  const j = parse(r);
  const row = j?.harnesses?.find((h) => h.id === 'antigravity');
  ok(r.code === 0 && row, 'doctor exits 0 and has an Antigravity row', r.stderr);
  ok(row.mcp.length === 3 && row.mcp.filter((m) => m.named).length === 1 && row.mcp.filter((m) => m.present).length === 2,
    '…MCP: three files looked at, two present, one naming my-curator');
  ok(row.hooks.some((h) => h.ours && h.events.join() === 'PreInvocation,Stop'),
    '…hooks: the user hooks.json carries our entries, events read one level below the hook NAME');
  const sk = row.skills?.installed || [];
  const mc = sk.find((s) => s.skill === 'my-curator');
  const cc = sk.find((s) => s.skill === 'curator-continuity');
  ok(row.skills?.repoComparable === true && mc?.match === true, '…skills: my-curator matches this version, by sha256 of every file');
  ok(cc?.match === false && cc.differs.includes('SKILL.md') && cc.missing.includes('examples.md'),
    '…and curator-continuity is STALE, naming the file that differs and the companion that is missing');
  const ag = row.instructions.find((i) => i.file === path.join(WORK, 'AGENTS.md'));
  ok(ag?.present && ag.hasBlock === true, '…instructions: AGENTS.md in the project carries the block');
  ok(!row.instructions.some((i) => /CLAUDE\.md$/.test(i.file)), '…and CLAUDE.md is not listed for Antigravity');
  ok(row.observations.length >= 2 && row.measured === null, '…observations carried verbatim, measured still null');

  const txt = run(['doctor', '--cwd', WORK], { cwd: WORK }).stdout;
  // The Antigravity row runs until the next harness row (Cursor follows it in table order).
  const block = txt.slice(txt.indexOf('  Antigravity —'), txt.indexOf('  Cursor —'));
  ok(block.length > 0 && block.startsWith('  Antigravity —'), 'the text report carries an Antigravity row');
  ok(/Antigravity — bridge configured \(1 file\) · 2 Curator hook file · hooks: verified/.test(block), 'the text row reads configured, hooked (user + project hooks.json)', block.split('\n')[0]);
  ok(/skill my-curator: matches this version/.test(block) && /skill curator-continuity: STALE — differs: SKILL\.md · missing: examples\.md/.test(block),
    '…and says which skill is stale and why');
  ok(/capture: NOT MEASURED/.test(block) && /observed · 2026-09-25/.test(block), '…NOT MEASURED, with the dated observations');

  // Our named hook switched off is present and INERT.
  const uf = g('config', 'hooks.json');
  const d2 = JSON.parse(readFileSync(uf, 'utf8'));
  d2['my-curator'].enabled = false;
  writeFileSync(uf, JSON.stringify(d2));
  const off = parse(run(['doctor', '--json', '--cwd', WORK], { cwd: WORK }))?.harnesses?.find((h) => h.id === 'antigravity');
  ok(off?.hooks?.some((h) => (h.inert || []).some((i) => /switched off/.test(i))), 'a disabled `my-curator` hook is reported present and inert');

  const afterFp = readdirSync(FAKE_HOME, { recursive: true }).map((f) => {
    const p = path.join(FAKE_HOME, f);
    return statSync(p).isFile() ? `${f}:${shaOf(p)}` : f;
  }).sort().join('\n');
  ok(before.replace(/hooks\.json:[0-9a-f]+/, '') === afterFp.replace(/hooks\.json:[0-9a-f]+/, ''),
    'doctor wrote nothing under the fixture home (only this suite edited hooks.json)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The client label — not guessed');
{
  for (const guess of ['antigravity', 'Antigravity', 'google-antigravity', 'antigravity-mcp-client']) {
    ok(clients.labelForClient(guess) === 'other', `"${guess}" is labelled \`other\` — no Antigravity row until the name is observed`);
  }
  ok(!clients.CLIENT_IDS.includes('antigravity'), 'no `antigravity` id is seeded in mcp-clients.js');
  ok(clients.labelForClient('claude-code') === 'claude-code', '…while an observed name still labels (the control)');
}

try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(`\n${failed === 0 ? '✓' : '✗'} test-antigravity-adapter: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
