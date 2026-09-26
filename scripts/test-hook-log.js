#!/usr/bin/env node
/**
 * test-hook-log.js — v3.77.0. The hook activity log and what reads it.
 *
 * Measured 2026-09-26: an Antigravity Stop hook produced no reminder, and
 * nothing on the machine could say whether it had fired, what id it carried,
 * or why it decided what it decided. This suite drives the REAL `my-curator
 * hook` as a child process against a fixture (HOME, domains, user data and
 * the marker folder all under the OS temp dir) and asserts:
 *
 *   §1 one line per invocation, CONTENT-FREE: a sentinel planted in every
 *      payload value never reaches the file; key NAMES do; the id is hashed.
 *   §2 the Stop window's FALLBACK bound: a Stop whose conversation id matches
 *      no marker is bounded by this tool's logged session start for the
 *      project (within 12 h) and ASKS — instead of refusing at rung 2 — and the
 *      line records `bound: start-log`. A repeat PreInvocation never bounds.
 *   §3 `CURATOR_HOOK_LOG=0` writes nothing; a hook whose log cannot be written
 *      still answers.
 *   §4 rotation at MAX_HOOK_LOG_BYTES keeps one generation.
 *   §5 `my-curator hook-log` and `doctor` read it back ("stop hook observed
 *      firing … — did not ask: …").
 *   §6 install-hooks for Antigravity: the user-scope warning (observed not
 *      loaded), the absolute-path note, and `--git-exclude` writing
 *      .git/info/exclude idempotently — never .gitignore.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
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
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-hooklog-'));
const DOMAINS_DIR = path.join(ROOT, 'domains');
const USER_DATA_DIR = path.join(ROOT, 'userdata');
const FAKE_HOME = path.join(ROOT, 'home');
const HOOK_DIR = path.join(ROOT, 'hookmarkers');
const WORK = path.join(ROOT, 'work');
for (const d of [USER_DATA_DIR, FAKE_HOME, WORK]) mkdirSync(d, { recursive: true });
const D = 'zzhl-alpha';
mkdirSync(path.join(DOMAINS_DIR, D, 'wiki', 'entities'), { recursive: true });
writeFileSync(path.join(DOMAINS_DIR, D, 'CLAUDE.md'), `# ${D}\n`);
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;
const store = await import('../src/brain/working-state.js');
{
  const r = await store.createProject(D, 'ott', { brief: '# Project brief — ott\n\n## Standing brief\n\nFixture.\n' });
  if (!r.ok) throw new Error(`fixture: ${r.reason}`);
  await store.saveWorkingState(D, { project: 'ott', scope: 'main', headline: 'fixture', nowState: 'x', nextSteps: ['y'] });
}
writeFileSync(path.join(WORK, '.curator-project'), `${D}/ott\n`);

const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'DOMAINS_PATH', 'CURATOR_HOOK_LOG']) delete e[k];
  Object.assign(e, {
    CURATOR_TEST_DOMAINS_DIR: DOMAINS_DIR, CURATOR_TEST_USER_DATA_DIR: USER_DATA_DIR,
    CURATOR_TEST_HOOK_DIR: HOOK_DIR, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME,
  });
  return e;
})();
function run(args, { cwd = ROOT, input = '', env = {} } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, input, env: { ...BASE_ENV, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const LOG = path.join(USER_DATA_DIR, '.hook-activity.jsonl');
const USAGE_LOG = path.join(USER_DATA_DIR, '.mcp-usage.jsonl');
const readLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const SENTINEL = 'ZZSENTINEL-4471';
const payload = (conversationId, extra = {}) => JSON.stringify({
  ...(conversationId ? { conversationId } : {}),
  workspacePaths: [WORK],
  transcriptPath: `/tmp/${SENTINEL}/transcript.jsonl`,
  artifactDirectoryPath: `/tmp/${SENTINEL}/a`,
  modelName: SENTINEL,
  userPrompt: `please ${SENTINEL}`,
  ...extra,
});
const start = (id, env) => run(['hook', 'session-start', '--harness', 'antigravity'], { input: payload(id), env });
const stop = (id, extra = {}, env) => run(['hook', 'stop', '--harness', 'antigravity'], {
  input: payload(id, { executionNum: 1, terminationReason: 'model_stop', fullyIdle: true, error: SENTINEL, ...extra }), env,
});
const usageLine = (tool) => JSON.stringify({ ts: new Date().toISOString(), tool, domain: D, ok: true, refused: false, ms: 3 });

const HL = await import('../src/brain/hook-log.js');

section('§1  one content-free line per invocation');
{
  const s = start('conv-aaa');
  ok(s.code === 0 && /injectSteps/.test(s.stdout), 'the session-start still injects', s.stderr);
  const lines = readLog();
  ok(lines.length === 1, 'exactly one line after one invocation', lines.length);
  const l = lines[0] || {};
  ok(l.harness === 'antigravity' && l.event === 'session-start' && l.decision === 'inject', 'harness, event and decision recorded', l);
  ok(l.idKey === 'conversationId' && /^[0-9a-f]{12}$/.test(l.sid || ''), 'which field carried the id, and a 12-hex hash of it', l);
  ok(l.sid === HL.hashSessionId('conv-aaa') && !readFileSync(LOG, 'utf8').includes('conv-aaa'), 'the raw id is never written');
  ok(Array.isArray(l.keys) && l.keys.includes('conversationId') && l.keys.includes('workspacePaths') && l.keys.includes('userPrompt'), 'the payload\'s key NAMES are recorded', l.keys);
  ok(l.project === `${D}/ott`, 'the resolved project (an identifier) is recorded');
  const s2 = start('conv-aaa');
  const rep = readLog()[1] || {};
  ok(s2.stdout.trim() === '{}' && rep.decision === 'none' && /already injected/.test(rep.why || ''), 'a repeat PreInvocation is logged as "already injected", decision none', rep);
}

section('§2  Stop: the marker bound, and the fallback when the id matches nothing');
{
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const s = stop('conv-aaa');
  const j = (() => { try { return JSON.parse(s.stdout); } catch { return null; } })();
  ok(j?.decision === 'continue', 'same conversation, read and no save: asked', s.stdout || s.stderr);
  const l = readLog().at(-1);
  ok(l.event === 'stop' && l.decision === 'ask' && l.rung === 5 && l.bound === 'marker', 'logged: ask, rung 5, bounded by the marker', l);
  ok(l.term === 'model_stop', 'terminationReason recorded — a whitelisted word, the only VALUE ever logged');

  // A Stop carrying an id no start ever saw (a renamed field, a different id):
  // before v3.77.0 this refused at rung 2. Now the logged start bounds it.
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const s2 = stop('conv-NEVER-STARTED');
  const j2 = (() => { try { return JSON.parse(s2.stdout); } catch { return null; } })();
  const l2 = readLog().at(-1);
  ok(j2?.decision === 'continue' && l2.bound === 'start-log' && l2.rung === 5,
    'an unmatched id is bounded by this tool\'s logged session start and asks — not "rung 2, window cannot be bounded"', { out: s2.stdout, l2 });

  // No injecting start for this project in the log at all: rung 2, as before.
  const other = path.join(ROOT, 'other');
  mkdirSync(other, { recursive: true });
  await store.createProject(D, 'solo', { brief: '# Project brief — solo\n\n## Standing brief\n\nx\n' });
  writeFileSync(path.join(other, '.curator-project'), `${D}/solo\n`);
  const s3 = run(['hook', 'stop', '--harness', 'antigravity'], { input: JSON.stringify({ conversationId: 'conv-solo', workspacePaths: [other], terminationReason: 'model_stop' }) });
  const l3 = readLog().at(-1);
  ok(s3.stdout.trim() === '{}' && l3.rung === 2 && l3.bound === null, 'a project with no logged start still refuses at rung 2 — the fallback never invents a window', l3);

  // Error stops and absent ids still logged with their reason.
  const s4 = stop('conv-aaa', { terminationReason: 'error' });
  const l4 = readLog().at(-1);
  ok(s4.stdout.trim() === '{}' && l4.decision === 'none' && l4.rung === 1 && l4.term === 'error', 'an error stop: logged, rung 1, term "error"', l4);
  const noId = run(['hook', 'stop', '--harness', 'antigravity'], { input: JSON.stringify({ workspacePaths: [WORK], terminationReason: 'model_stop' }) });
  const l5 = readLog().at(-1);
  ok(noId.code === 0 && l5.sid === null && l5.idKey === null, 'a payload with no id: logged with sid null and idKey null — the gap is visible', l5);

  const all = readFileSync(LOG, 'utf8');
  ok(!all.includes(SENTINEL), 'no payload VALUE (prompt, paths, model, error) ever reached the log', all.split('\n').find((x) => x.includes(SENTINEL)));
  ok(!all.includes(WORK) && !all.includes(ROOT), 'no filesystem path reached the log');
}

section('§3  switched off, and never fatal');
{
  const n = readLog().length;
  start('conv-off', { CURATOR_HOOK_LOG: '0' });
  ok(readLog().length === n, 'CURATOR_HOOK_LOG=0 writes nothing');
  const blocked = path.join(ROOT, 'blocked');
  writeFileSync(blocked, 'a file where a folder should be');
  const r = run(['hook', 'session-start', '--harness', 'antigravity'], {
    input: payload('conv-blocked'), env: { CURATOR_TEST_USER_DATA_DIR: path.join(blocked, 'sub') },
  });
  ok(r.code === 0 && r.stdout.trim().startsWith('{'), 'an unwritable log folder: the hook still answers with a JSON object', r.stderr);
}

section('§4  rotation');
{
  const f = path.join(ROOT, 'rot', 'h.jsonl');
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, 'x'.repeat(HL.MAX_HOOK_LOG_BYTES));
  HL.appendHookLine(HL.buildHookLine({ harness: 'antigravity', event: 'stop' }), f);
  ok(existsSync(`${f}.1`) && readFileSync(f, 'utf8').split('\n').filter(Boolean).length === 1, 'past the cap: one previous generation, a fresh file');
  const { lines } = await HL.readHookLines([f]);
  ok(lines.length === 1, 'the reader skips the rotated junk line and reads the good one');
}

section('§5  hook-log and doctor read it back');
{
  const r = run(['hook-log', '--limit', '3']);
  ok(r.code === 0 && /antigravity stop/.test(r.stdout) && /payload keys:/.test(r.stdout), 'my-curator hook-log prints the last lines, with key names', r.stdout);
  const j = (() => { try { return JSON.parse(run(['hook-log', '--json', '--limit', '2']).stdout); } catch { return null; } })();
  ok(j?.ok && j.lines.length === 2, 'hook-log --json: the last 2 lines');
  // Install the project hooks so doctor has a hook file to talk about.
  const d = run(['doctor'], { cwd: WORK });
  ok(/hook log · start hook observed firing/.test(d.stdout) && /hook log · stop hook observed firing .* — (asked for a save|did not ask:)/.test(d.stdout),
    'doctor prints the start and stop evidence from the log', d.stdout.split('\n').filter((x) => /hook log/.test(x)).join(' | '));
  // The log is the PRIMARY evidence on the harness line once a hook file is
  // installed; the temp-dir markers are only the fallback.
  const agLine = d.stdout.split('\n').find((x) => /^\s+Antigravity —/.test(x)) || '';
  ok(!/Curator hook file/.test(agLine) || /observed firing .*\(hook log\)/.test(agLine),
    'with a hook file installed, the harness line cites the hook log, not the markers', agLine);
  const words = HL.hookEvidenceWords(null, { installed: true });
  ok(words.join() === 'installed, not yet observed firing', 'no log lines + installed: "installed, not yet observed firing"');
}

section('§6  install-hooks for Antigravity');
{
  execFileSync('git', ['init', '-q'], { cwd: WORK });
  const u = run(['install-hooks', 'antigravity', '--scope', 'user', '--bin', BIN], { cwd: WORK });
  ok(/NOTE: a hook in .* ran once \(2026-09-26\) but its injection was not seen used/.test(u.stderr) && !/not loaded|ignored/i.test(u.stderr),
    'user scope: the dated observation, no stronger — never "not loaded"', u.stderr);
  const p = run(['install-hooks', 'antigravity', '--bin', BIN], { cwd: WORK });
  ok(p.code === 0 && existsSync(path.join(WORK, '.agents', 'hooks.json')), 'the default scope is project: <repo>/.agents/hooks.json', p.stderr);
  ok(/absolute path/.test(p.stderr) && /--git-exclude/.test(p.stderr), '…with a note that it holds an absolute path and how to keep it out of git');
  const exclude = path.join(WORK, '.git', 'info', 'exclude');
  const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  ok(!before.includes('/.agents/hooks.json'), 'nothing was added to the exclude file without the flag');
  const x = run(['install-hooks', 'antigravity', '--bin', BIN, '--git-exclude'], { cwd: WORK });
  const after = readFileSync(exclude, 'utf8');
  ok(/is now listed/.test(x.stderr) && after.includes('/.agents/hooks.json'), '--git-exclude adds /.agents/hooks.json to .git/info/exclude', x.stderr);
  run(['install-hooks', 'antigravity', '--bin', BIN, '--git-exclude'], { cwd: WORK });
  ok(readFileSync(exclude, 'utf8').split('/.agents/hooks.json').length === 2, '…idempotently');
  ok(!existsSync(path.join(WORK, '.gitignore')), 'no .gitignore was created (that one is committed)');
  const st = execFileSync('git', ['status', '--porcelain'], { cwd: WORK, encoding: 'utf8' });
  ok(!st.includes('.agents'), 'git no longer offers .agents/hooks.json for commit', st);
  // Now a hook file IS installed. A logged start OLDER than the file is not
  // evidence (the markers' own floor) — so the line falls back first…
  const d1 = run(['doctor'], { cwd: WORK });
  const agLine1 = d1.stdout.split('\n').find((x) => /^\s+Antigravity —/.test(x)) || '';
  ok(!/\(hook log\)/.test(agLine1), 'a logged start from BEFORE the install is not cited as evidence the installed hooks ran', agLine1);
  // …and a start AFTER the install is cited, from the log.
  const tick = Date.now(); while (Date.now() - tick < 20) { /* the file's mtime and the next line must differ */ }
  start('conv-after-install');
  const d2 = run(['doctor'], { cwd: WORK });
  const agLine2 = d2.stdout.split('\n').find((x) => /^\s+Antigravity —/.test(x)) || '';
  ok(/Curator hook file/.test(agLine2) && /start hook observed firing .*\(hook log\)/.test(agLine2),
    'installed hooks + a logged start: the harness line cites the hook log (markers are only the fallback)', agLine2);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failed ? '✗' : '✓'} test-hook-log: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
