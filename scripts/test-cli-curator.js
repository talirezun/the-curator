#!/usr/bin/env node
/**
 * OFFLINE — `my-curator`, the neutral command, driven as a CHILD PROCESS.
 *
 * WHY IT SPAWNS, AND WHAT THAT BUYS
 * ─────────────────────────────────
 * Every property this suite exists to protect is a property of the PROCESS,
 * not of a function: which bytes land on stdout, which on stderr, what the
 * exit code is, and whether a >64 KB payload survives the pipe. Calling
 * `runContext()` in-process would report all four correctly while the shipped
 * binary got them all wrong — this repo's own recorded rule (v3.0.17: assert
 * behaviour, never the presence of a line of source).
 *
 * WHAT IT PINS, and the defect each one stops:
 *
 *   §1 PROJECT RESOLUTION — the marker two directories up, the flag beating
 *      it, the ambiguity REFUSED with candidates and exit 2. A resolver that
 *      guesses opens the wrong project and every save after it lands in the
 *      wrong tree.
 *   §2 ONE STORE, TWO CLIENTS — `context --json` is the store's envelope, and
 *      the MCP tool's reply agrees with it on every fact the handler forwards
 *      untouched. A CLI that quietly answered about a different scope, budget
 *      or document set than the bridge would be worse than no CLI.
 *   §3 SAVE — a CLI save and an MCP save of the SAME body produce
 *      byte-identical documents (modulo the scope and the clock), the store
 *      reads its own file back clean, an empty body is refused with exit 2,
 *      and `--dry-run` writes NOTHING (fingerprinted).
 *   §4 THE HOOK LADDER — the block fires once and never twice, the harness's
 *      own loop field ends it, a save in the session ends it, an unverified
 *      envelope is WITHHELD rather than approximated, and an unknown harness
 *      receives nothing at all.
 *   §5 DOCTOR — exit 0 against an empty HOME with every harness reported as
 *      not configured, a shadowed `curator` refusing the alias, and a
 *      malformed config REPORTED rather than fatal.
 *   §6 A READ WRITES NOTHING — the usage log is fingerprinted across a
 *      `context` run, because a CLI read recorded there would make the honesty
 *      meter count sessions that never opened a bridge.
 *   §7 THE PIPE — a >64 KB bootstrap arrives WHOLE. `skills/build.mjs`
 *      measured `process.exit()` discarding everything past the pipe buffer;
 *      this executes the case instead of trusting the note.
 *
 * SAFETY — never touches real user data. A throwaway fixture under os.tmpdir()
 * is pinned with CURATOR_TEST_DOMAINS_DIR (the only rung getDomainsDir()
 * honours above config) and CURATOR_TEST_USER_DATA_DIR (credentials, and the
 * usage log). Every child also gets HOME pointed at a fixture directory, so
 * `doctor` can never read the developer's own harness configuration. Provider
 * and GitHub credentials are stripped from every child.
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
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-cli-'));
const DOMAINS_DIR = path.join(ROOT, 'domains');
const USER_DATA_DIR = path.join(ROOT, 'userdata');
const FAKE_HOME = path.join(ROOT, 'home');
const WORK = path.join(ROOT, 'work');            // a "repository" with a marker
const DEEP = path.join(WORK, 'src', 'deep');      // two directories below it
mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });
mkdirSync(DEEP, { recursive: true });

const D1 = 'zzcli-alpha';
const D2 = 'zzcli-beta';
for (const d of [D1, D2]) {
  mkdirSync(path.join(DOMAINS_DIR, d, 'wiki', 'entities'), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, d, 'CLAUDE.md'), `# ${d}\n\nThrowaway fixture.\n`);
}

process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;

const store = await import('../src/brain/working-state.js');
const { createStorageAdapter } = await import('../mcp/storage/local.js');
const mcpTools = await import('../mcp/tools/working-state.js');
const storage = createStorageAdapter({ domainsPath: DOMAINS_DIR });

// `lumina` in ONE domain (resolvable bare), `shared` in BOTH (ambiguous).
for (const [domain, project] of [[D1, 'lumina'], [D1, 'shared'], [D2, 'shared']]) {
  const r = await store.createProject(domain, project, {
    brief: `# Project brief — ${project}\n\n## Standing brief\n\nBuild ${project} carefully.\n`,
  });
  if (!r.ok) throw new Error(`fixture: createProject ${domain}/${project} — ${r.reason}`);
}
const seeded = await store.initFoundations(D1, 'lumina', { ownership: 'curator', seed: true });
if (!seeded.ok) throw new Error(`fixture: initFoundations — ${seeded.reason}`);
const firstSave = await store.saveWorkingState(D1, {
  project: 'lumina', scope: 'main',
  headline: 'fixture state for the CLI suite',
  nowState: 'seeded by scripts/test-cli-curator.js',
  nextSteps: ['nothing — this is a fixture'],
});
if (!firstSave.ok) throw new Error(`fixture: saveWorkingState — ${firstSave.reason}`);

writeFileSync(path.join(WORK, '.curator-project'), `${D1}/lumina\n`);

// ── Running the binary ─────────────────────────────────────────────────────
const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
    'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT', 'DOMAINS_PATH', 'LLM_MODEL']) delete e[k];
  e.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
  e.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;
  e.HOME = FAKE_HOME;
  e.USERPROFILE = FAKE_HOME;
  // The hook's loop-guard markers are the one piece of CLI state that lives
  // outside this fixture (the OS temp dir, deliberately — they are ephemera
  // that must never sync). Pinned here, or a previous RUN of this suite leaves
  // files that decide the result of the next one.
  e.CURATOR_TEST_HOOK_DIR = path.join(ROOT, 'hookmarkers');
  return e;
})();

/** Spawn the shipped binary. stdin is ALWAYS closed, so nothing can hang. */
function run(args, opts = {}) {
  const env = { ...BASE_ENV, ...(opts.env || {}) };
  // A merge cannot REMOVE a key, and a test that means to unset one and only
  // shadows it measures the wrong thing — the §8 --domains-path case went
  // green for exactly that reason before this existed.
  for (const k of opts.unsetEnv || []) delete env[k];
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || REPO_ROOT,
    input: opts.input ?? '',
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal };
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * The REAL hook-marker directory — the one `markerDir()` falls back to when
 * CURATOR_TEST_HOOK_DIR is unset. Snapshotted BEFORE any child runs, so §12
 * can assert this suite added nothing to it. See §12 for why "added" rather
 * than "empty".
 */
const REAL_MARKER_DIR = path.join(os.tmpdir(), 'curator-hooks');
const markerDirSnapshot = () => {
  try { return new Set(readdirSync(REAL_MARKER_DIR)); } catch { return new Set(); }
};
const REAL_MARKERS_AT_START = markerDirSnapshot();

/**
 * Parse a child's stdout, or return null.
 *
 * NEVER a bare `JSON.parse` on a child's output: a mutation that makes the
 * binary print nothing then CRASHES this file with a SyntaxError instead of
 * reddening an assertion, and a suite that dies has reported nothing about the
 * other 100 properties. Three mutations did exactly that before this existed.
 */
function parseOut(r) {
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** A directory fingerprint: relative path → sha256, for "wrote nothing". */
function fingerprint(dir) {
  const out = {};
  const walk = (d, rel) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else { try { out[r] = `${statSync(abs).size}:${sha(readFileSync(abs))}`; } catch { out[r] = 'unreadable'; } }
    }
  };
  walk(dir, '');
  return JSON.stringify(out);
}

/**
 * Volatile fields, zeroed before a comparison. `writtenAgeSeconds` and its
 * siblings are `Date.now()` arithmetic, so two reads a second apart disagree
 * for a reason that says nothing about either client.
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = /AgeSeconds$/.test(k) ? 0 : stable(v);
    return out;
  }
  return value;
}
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
// The bootstrap envelope carries two READ-TIME fields (ageSeconds, writtenAgeSeconds)
// computed from the clock: two reads a second apart legitimately differ there and nowhere
// else. Strip exactly those two keys for a whole-envelope comparison; §2 asserts separately
// that BOTH sides carry them, so the strip cannot hide their absence.
const AGE_KEYS = new Set(['ageSeconds', 'writtenAgeSeconds']);
const withoutAges = (v) => Array.isArray(v) ? v.map(withoutAges)
  : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).filter(([k]) => !AGE_KEYS.has(k)).map(([k, x]) => [k, withoutAges(x)]))
  : v;
const countAgeKeys = (v) => Array.isArray(v) ? v.reduce((n, x) => n + countAgeKeys(x), 0)
  : (v && typeof v === 'object') ? Object.entries(v).reduce((n, [k, x]) => n + (AGE_KEYS.has(k) ? 1 : 0) + countAgeKeys(x), 0) : 0;
const sameModuloAges = (a, b) => same(withoutAges(a), withoutAges(b));

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Project resolution — the marker, the flag, and the refusal');

{
  const r = run(['resolve', '--json'], { cwd: DEEP });
  const j = parseOut(r);
  ok(r.code === 0 && j?.domain === D1 && j?.project === 'lumina',
    'a `.curator-project` marker TWO directories up resolves the project');
  ok(j?.source === 'marker' && typeof j?.markerFile === 'string' && j.markerFile.endsWith('.curator-project'),
    'the reply names the marker file it read, so the answer can be traced');
}
{
  const r = run(['resolve', '--json', '--project', `${D2}/shared`], { cwd: DEEP });
  const j = parseOut(r);
  ok(r.code === 0 && j?.domain === D2 && j?.project === 'shared',
    '--project BEATS the marker (rung 1 before rung 2)');
}
{
  // `shared` exists in BOTH domains. The store refuses and names candidates;
  // the CLI must print them and exit 2 rather than pick one.
  const r = run(['resolve', '--project', 'shared'], { cwd: ROOT });
  ok(r.code === 2, 'an AMBIGUOUS bare project name exits 2');
  ok(r.stdout === '', '…with nothing on stdout — a refusal is not a product');
  ok(r.stderr.includes(`${D1}/shared`) && r.stderr.includes(`${D2}/shared`),
    '…and both candidates named on stderr');
  ok(r.stderr.includes('nothing was opened for you'),
    '…and the store’s own sentence says nothing was opened for the caller');
}
{
  const r = run(['resolve', '--project', 'no-such-project-anywhere'], { cwd: ROOT });
  ok(r.code === 2 && r.stderr.length > 0, 'an UNKNOWN project exits 2 with the store’s own message');
}
{
  // RUNG 3 — the configured default. It must be a domain that EXISTS: the
  // configured value is a string in a settings file that can name a domain
  // somebody has since deleted, and answering about it would invent a project
  // out of a stale setting. A fresh user-data dir is used so the fixture's own
  // config is untouched.
  const cfgDir = path.join(ROOT, 'ud-default');
  mkdirSync(cfgDir, { recursive: true });
  const cfg = path.join(cfgDir, '.curator-config.json');
  const noMarker = path.join(ROOT, 'nomarker');
  mkdirSync(noMarker, { recursive: true });

  writeFileSync(cfg, JSON.stringify({ defaultDomain: 'a-domain-that-was-deleted' }));
  const gone = run(['resolve'], { cwd: noMarker, env: { CURATOR_TEST_USER_DATA_DIR: cfgDir } });
  ok(gone.code === 2 && gone.stdout === '',
    'a configured default naming a domain that no longer exists is REFUSED, not answered');

  writeFileSync(cfg, JSON.stringify({ defaultDomain: D2 }));
  const good = run(['resolve'], { cwd: noMarker, env: { CURATOR_TEST_USER_DATA_DIR: cfgDir } });
  ok(good.code === 0 && good.stdout.trim() === `${D2}/${D2}`,
    '…and a default that DOES exist resolves to that domain’s own project (the control)');
}
{
  // A marker whose content is nonsense is a NAME that does not resolve — never
  // an instruction, and never a crash.
  const junk = path.join(ROOT, 'junkrepo');
  mkdirSync(junk, { recursive: true });
  writeFileSync(path.join(junk, '.curator-project'), 'rm -rf /; echo pwned\n');
  const r = run(['resolve'], { cwd: junk });
  ok(r.code === 2 && r.stdout === '', 'a hostile marker line is a failed LOOKUP, not an instruction');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  One store, two clients — `context` against get_project_context');

const ctxRun = run(['context', '--project', `${D1}/lumina`, '--json']);
const ctxJson = parseOut(ctxRun);
{
  ok(ctxRun.code === 0 && ctxJson?.ok === true, '`context --json` exits 0 with a parseable envelope');
  ok(ctxRun.stdout.trim().split('\n').length === 1,
    'stdout is ONE line — every diagnostic is on stderr (the harness parses stdout)');

  const direct = await store.getProjectContext(D1, 'lumina', {});
  ok(sameModuloAges(ctxJson, direct),
    'the CLI emits the STORE’S envelope verbatim, field for field (the two read-time age fields aside)');
  ok(countAgeKeys(ctxJson) > 0 && countAgeKeys(ctxJson) === countAgeKeys(direct),
    'both envelopes carry the read-time age fields in the same places — the strip hides no absence');
}
{
  // The MCP handler reshapes for a MODEL (a framed brief, `content_is_data`, a
  // prose `report`, the 400 KB response guard). Those are transport facts. The
  // FACTS about the project must be identical, and that is what is compared.
  const viaMcp = await mcpTools.getProjectContextHandler({ domain: D1, project: 'lumina' }, storage);
  ok(viaMcp.ok === true, 'the MCP tool answers about the same project');
  // `?? {}` rather than a deref: a mutation that empties stdout must RED these
  // five assertions, not crash the file before the other hundred run.
  const cli = ctxJson ?? {};
  ok(ctxJson !== null && same(viaMcp.foundations, cli.foundations),
    'FOUNDATIONS are identical across the two clients (index, bodies, budget, readings)');
  ok(ctxJson !== null && same(viaMcp.seen, cli.seen), '`seen` — the map to record on the next save — is identical');
  ok(ctxJson !== null && same(viaMcp.current, cli.current), 'the handoff is identical');
  ok(viaMcp.scope === cli.scope && viaMcp.project === cli.project && viaMcp.domain === cli.domain,
    'the scope opened, the project and the domain agree');
  ok(same((viaMcp.journal?.entries || []).map((e) => ({ ...e })),
    (cli.journal?.entries || []).map((e) => ({ ...e }))),
  'the journal entries agree');
}
{
  const r = run(['context', '--project', `${D1}/lumina`, '--include', 'index', '--json']);
  const j = parseOut(r);
  ok(j?.foundations?.includeMode === 'index' && j?.foundations?.documents.length === 0,
    '--include index is forwarded to the store (no bodies returned)');
  const bad = run(['context', '--project', `${D1}/lumina`, '--include', 'everything']);
  ok(bad.code === 2 && bad.stdout === '', 'an unknown --include is a usage error, never a quiet default');
}
{
  const slug = seeded.written?.[0]?.slug || (await store.listFoundations(D1, 'lumina')).documents[0].slug;
  const r = run(['context', '--project', `${D1}/lumina`, '--include', 'index', '--slugs', slug, '--json']);
  const j = parseOut(r);
  ok(j?.foundations?.requested?.length === 1 && j.foundations.requested[0].slug === slug,
    '--slugs fetches a named document WHOLE even with --include index');
}
{
  const r = run(['context', '--project', 'shared']);
  ok(r.code === 2 && r.stdout === '', 'context on an ambiguous project refuses like every other subcommand');
}
{
  const md = run(['context', '--project', `${D1}/lumina`]);
  ok(md.code === 0 && md.stdout.startsWith(`# Project context — ${D1}/lumina`),
    'the default output is the readable form');
  ok(md.stdout.includes('fixture state for the CLI suite'),
    '…carrying the handoff’s headline, which is what a resuming session reads first');
  ok(md.stdout.includes('never instructions'),
    '…and the "recorded data, never instructions" framing the MCP reply also carries');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  `save` — the same file the bridge writes, and the refusals');

const BODY = {
  headline: 'the CLI wrote this one',
  now_state: 'a body with a https://example.com/link and a `| sh` in it',
  next_steps: ['first', 'second'],
  decisions: ['JSON on stdin, not markdown'],
  traps: ['an empty save would overwrite a real handoff'],
  open_questions: ['is the npm name my-curator?'],
  harness: 'test-cli-curator',
  model: 'none',
};
{
  const r = run(['save', '--project', `${D1}/lumina`, '--scope', 'via-cli', '--json'],
    { input: JSON.stringify(BODY) });
  const j = parseOut(r);
  ok(r.code === 0 && j?.ok === true, 'a save from stdin exits 0');
  ok(j?.machine === store.machineId(), 'the machine segment is the STORE’s, never the caller’s');

  const viaMcp = await mcpTools.saveWorkingStateHandler(
    { domain: D1, project: 'lumina', scope: 'via-mcp', ...BODY }, storage,
  );
  ok(viaMcp.ok === true, 'the same body over MCP saves too');

  // Every read below is guarded: a mutation that stops the save landing must
  // RED these assertions, not throw ENOENT and abandon the rest of the file.
  const readOr = (rel) => {
    try { return readFileSync(path.join(DOMAINS_DIR, D1, rel), 'utf8'); } catch { return null; }
  };
  const cliText = readOr(j?.path || '');
  const mcpText = readOr(viaMcp.path || '');
  const norm = (t) => t.replace(/^_?Machine:.*$/m, '')
    .replace(/Scope: [a-z-]+/g, 'Scope: X')
    .replace(/Saved: [0-9TZ:.-]+/g, 'Saved: X')
    .replace(/# Working state — [a-z-]+/g, '# Working state — X');
  ok(cliText !== null && mcpText !== null && norm(cliText) === norm(mcpText),
    'the CLI’s document and the MCP’s are BYTE-IDENTICAL apart from the scope and the clock');

  const back = await store.readWorkingState(D1, { project: 'lumina', scope: 'via-cli' });
  ok(back.ok && back.current?.present === true, 'the store reads its own file back');
  ok(back.current?.sanitisedOnRead === false,
    'sanitisedOnRead is FALSE — the CLI wrote nothing the read path has to defang');
  ok(back.current?.headingsSuspect === false,
    'headingsSuspect is FALSE — no section heading was duplicated or forged');
  for (const key of ['first', 'second', 'JSON on stdin, not markdown', 'is the npm name my-curator?']) {
    ok(back.current?.text?.includes(key) === true, `…and "${key.slice(0, 28)}" survived the round trip`);
  }
}
// v3.74.0 — ANOTHER TOOL'S HANDOFF REPLACED. Measured live on 2026-09-25:
// Antigravity saved to `main` and replaced Claude Code's 3.8 KB handoff; the
// reply said only "This OVERWROTE the previous save", which every save says.
// The owner's decision: WARN, never refuse. Driven through BOTH clients — the
// MCP handler in-process and the shipped CLI as a child — because they share
// the store function and must say the same thing.
{
  const big = (h, model, headline) => ({
    domain: D1, project: 'lumina', scope: 'shared-main', harness: h, model, headline,
    now_state: `State written by ${h}. `.repeat(40), next_steps: ['go on'],
  });
  const first = await mcpTools.saveWorkingStateHandler(big('Claude Code', 'claude-opus-5-5', 'CC handoff: parser half done'), storage);
  ok(first.ok === true && first.overwrote === null, 'a first save replaces nobody: `overwrote` is null, never absent');
  const pairDir = path.join(DOMAINS_DIR, D1, path.dirname(first.path || 'x'));
  const prevFile = path.join(pairDir, 'previous.md');
  const curFile = path.join(pairDir, 'current.md');
  const readB = (f) => { try { return readFileSync(f); } catch { return null; } };
  // A same-tool re-save first: it must NOT write previous.md.
  const sameFirst = await mcpTools.saveWorkingStateHandler(big('claude-code', null, 'CC handoff: parser half done'), storage);
  ok(sameFirst.ok === true && sameFirst.overwrote === null && readB(prevFile) === null,
    'a SAME-tool save (another spelling) writes NO previous.md');
  const ccBytes = readB(curFile);

  // The CLI, as Antigravity, over Claude Code's handoff.
  const r = run(['save', '--project', `${D1}/lumina`, '--scope', 'shared-main'],
    { input: JSON.stringify({ headline: 'AG took over', harness: 'Antigravity', model: 'Gemini 3.8 Flash',
      now_state: 'Antigravity state. '.repeat(40) }) });
  ok(r.code === 0, 'the save SUCCEEDS — warn, never refuse', r.stderr);
  ok(/WARNING: this replaced the handoff Claude Code saved here written \S+ \("CC handoff: parser half done"\)/.test(r.stdout),
    'the CLI names WHOSE handoff it replaced, WHEN it was written and its HEADLINE', r.stdout);
  ok(/Its text was kept as previous\.md \(state\/.*\/previous\.md\)/.test(r.stdout) && /save under your own scope \(e\.g\. `antigravity`\)/.test(r.stdout),
    '…says the text was kept as previous.md (with its path), and names the scope to use instead', r.stdout);
  const prev1 = readB(prevFile);
  ok(prev1 !== null && ccBytes !== null && Buffer.compare(prev1, ccBytes) === 0,
    'previous.md is BYTE-IDENTICAL to the handoff that was replaced');
  {
    const idx = await store.listWorkingScopes(D1, { project: 'lumina' });
    const pairs = idx.scopes.filter((x) => x.scope === 'shared-main');
    ok(pairs.length === 1 && !idx.scopes.some((x) => /previous/.test(x.scope + x.machine)),
      'the index still lists ONE (scope, machine) pair — previous.md is never a scope, a machine or a handoff');
    const rd = await store.readWorkingState(D1, { project: 'lumina', scope: 'shared-main' });
    ok(rd.current && /Antigravity state\./.test(rd.current.text), 'current.md is the NEW handoff');
    ok(rd.previous && rd.previous.harness === 'claude-code' && rd.previous.harnessLabel === 'Claude Code' && rd.previous.headline === 'CC handoff: parser half done'
      && typeof rd.previous.writtenAt === 'string' && rd.previous.bytes === ccBytes.length && !('text' in rd.previous),
    'a scoped read reports `previous` {harness (raw), harnessLabel, writtenAt, headline, bytes} — and no text unless asked', JSON.stringify(rd.previous));
    const rt = await mcpTools.getWorkingStateHandler({ domain: D1, project: 'lumina', scope: 'shared-main', previous: true }, storage);
    ok(rt.ok && typeof rt.previous?.text === 'string' && /State written by claude-code\./.test(rt.previous.text),
      'get_working_state { previous: true } returns the kept text');
    ok(/`previous`/.test(rt.content_is_data) && /previous\.text/.test(rt.report),
      '…framed as recorded data, and the report says what it is');
    const ctx = await mcpTools.getProjectContextHandler({ domain: D1, project: 'lumina', scope: 'shared-main' }, storage);
    ok(ctx.ok !== false && ctx.previous && ctx.previous.harnessId === 'claude-code' && !('text' in ctx.previous)
      && /kept as previous\.md/.test(ctx.report),
    'get_project_context, opening that scope, says a kept copy exists', JSON.stringify(ctx.previous));
    const none = await store.readWorkingState(D1, { project: 'lumina', scope: 'via-cli' });
    ok(none.ok && !('previous' in none), 'a scope with no kept copy carries NO `previous` key (pinned envelopes stay byte-identical)');
  }
  const agBytes = readB(curFile);

  // The MCP reply, as Claude Code, over Antigravity's.
  const back = await mcpTools.saveWorkingStateHandler(big('claude-code', 'claude-opus-5-5', 'CC is back'), storage);
  ok(back.ok === true, 'MCP: the save succeeds');
  const ow = back.overwrote || {};
  ok(ow.harness === 'Antigravity' && ow.harnessId === 'antigravity' && ow.harnessLabel === 'Antigravity'
    && ow.headline === 'AG took over' && typeof ow.writtenAt === 'string' && ow.suggestedScope === 'claude-code',
  'MCP: `overwrote` carries the replaced tool, its headline, when it was written and the scope to use', JSON.stringify(ow));
  ok(ow.model === 'Gemini 3.8 Flash', 'a display-name model is carried AS GIVEN — no id is invented', String(ow.model));
  ok(typeof ow.previousPath === 'string' && /previous\.md$/.test(ow.previousPath), '`overwrote.previousPath` is store-relative', String(ow.previousPath));
  const prev2 = readB(prevFile);
  ok(prev2 !== null && agBytes !== null && Buffer.compare(prev2, agBytes) === 0 && Buffer.compare(prev2, prev1) !== 0,
    'a SECOND cross-tool replacement replaces previous.md with the handoff it replaced (one copy)');
  ok(/WARNING: this replaced the handoff Antigravity saved here/.test(back.report)
    && /From now on save under your own scope \(e\.g\. `claude-code`\)/.test(back.report)
    && /read Antigravity's work by naming its scope/.test(back.report),
  'MCP: the report says it in words — the SAME sentence the CLI prints', back.report);
  ok(back.save_kind === 'noted', 'nothing the CALLER sent was lost, so save_kind is not "trimmed" or "replaced"', back.save_kind);
  ok(back.notes.some((n) => /^handoff: this save replaced the handoff Antigravity wrote here.*its text was kept as previous\.md\.$/.test(n) && n.length <= 200),
    'a note records it (≤ 200 chars, the wire cap), so the JOURNAL line keeps the fact', JSON.stringify(back.notes));
  ok(/another tool's handoff/i.test(back.notes_meaning), 'notes_meaning points at `overwrote`');
  const j = await store.readWorkingState(D1, { project: 'lumina', scope: 'shared-main', journalLimit: 1 });
  const line = (j.journal && j.journal.entries && j.journal.entries[0]) || {};
  ok((line.rejections || line.notes || []).some((n) => /replaced the handoff Antigravity wrote here/.test(n)),
    'the journal line of the replacing save records whose handoff it replaced', JSON.stringify(line).slice(0, 300));

  // Same tool, other spelling → silent.
  const same = await mcpTools.saveWorkingStateHandler(big('Claude Code (desktop)', null, 'CC again'), storage);
  ok(same.ok === true && same.overwrote === null && !/WARNING/.test(same.report),
    'ONE tool under two spellings (claude-code → Claude Code (desktop)) raises NO warning', JSON.stringify(same.overwrote));
  ok(Buffer.compare(readB(prevFile) || Buffer.alloc(0), prev2) === 0, '…and a same-tool save leaves previous.md untouched');
  // Unknown harness on either side → silent, by design.
  const anon = await mcpTools.saveWorkingStateHandler({ ...big(undefined, null, 'no tool named'), harness: undefined }, storage);
  ok(anon.ok === true && anon.overwrote === null, 'a save naming NO tool warns about nothing (no evidence it is a different tool)');
  const afterAnon = await mcpTools.saveWorkingStateHandler(big('Antigravity', null, 'AG after an unnamed save'), storage);
  ok(afterAnon.ok === true && afterAnon.overwrote === null, '…and a save over an UNNAMED save warns about nothing either');
  const cd = await mcpTools.saveWorkingStateHandler(big('claude-desktop', null, 'desktop app'), storage);
  ok(cd.ok === true && cd.overwrote && cd.overwrote.harnessId === 'antigravity', 'CONTROL: a genuinely different tool still warns');
  const cc = await mcpTools.saveWorkingStateHandler(big('claude-code', null, 'code over desktop'), storage);
  ok(cc.overwrote && cc.overwrote.harnessId === 'claude-desktop',
    'claude-code over claude-desktop WARNS — two products, never merged');

  // The other tool saved into THIS tool's own scope: the advice changes.
  await mcpTools.saveWorkingStateHandler({ ...big('Antigravity', null, 'AG in its own scope'), scope: 'claude-code' }, storage);
  const own = await mcpTools.saveWorkingStateHandler({ ...big('claude-code', null, 'my scope'), scope: 'claude-code' }, storage);
  ok(own.overwrote && /Antigravity saved into this scope; each tool should save under its own scope/.test(own.report),
    'when the other tool wrote into YOUR tool-named scope, the advice says so instead of naming the scope you are in', own.report);
}
{
  const r = run(['save', '--project', `${D1}/lumina`], { input: '{}' });
  ok(r.code === 2 && r.stdout === '', 'an EMPTY body is refused with exit 2 and nothing on stdout');
  ok(/overwrite/i.test(r.stderr), '…naming the consequence: a save overwrites');
}
{
  // THE WORDING IS COMPARED AGAINST THE MCP HANDLER, NOT AGAINST ITSELF.
  // Importing the CLI's own constant and asserting the CLI prints it is a
  // tautology: it stays green while the two clients drift apart, which is the
  // thing worth stopping — an agent told one sentence by the bridge and
  // another by the command has to learn two failure modes for one rule.
  const r = run(['save', '--project', `${D1}/lumina`], { input: '{"now_state":"no headline here"}' });
  const viaMcp = await mcpTools.saveWorkingStateHandler({ domain: D1, project: 'lumina' }, storage);
  ok(viaMcp.ok === false && typeof viaMcp.error === 'string', 'the MCP handler refuses a headline-less save');
  ok(r.code === 2 && r.stderr.trim() === viaMcp.error.trim(),
    'a missing headline is refused in the MCP handler’s OWN words, byte for byte');
}
{
  const r = run(['save', '--project', `${D1}/lumina`], { input: 'not json at all' });
  ok(r.code === 2 && /not valid JSON/.test(r.stderr), 'a non-JSON body is a usage error with the parse reason');
  const arr = run(['save', '--project', `${D1}/lumina`], { input: '["a"]' });
  ok(arr.code === 2, 'a JSON ARRAY is refused — the body is an object');
}
{
  const before = fingerprint(path.join(DOMAINS_DIR, D1, 'state'));
  const r = run(['save', '--project', `${D1}/lumina`, '--scope', 'dry', '--dry-run', '--json'],
    { input: JSON.stringify({ headline: 'this must never land' }) });
  const after = fingerprint(path.join(DOMAINS_DIR, D1, 'state'));
  ok(r.code === 0 && parseOut(r)?.dryRun === true, '--dry-run reports and exits 0');
  ok(before === after, '--dry-run wrote NOTHING — the whole state tree is byte-identical');
}
{
  // v3.76.0 — NO SCOPE + A HARNESS: the tool's own scope, the store's rule,
  // and the CLI's dry run and its reply both say so.
  const dry = run(['save', '--project', `${D1}/lumina`, '--harness', 'Claude Code', '--dry-run', '--json'],
    { input: JSON.stringify({ headline: 'no scope named' }) });
  ok(parseOut(dry)?.scope === 'claude-code', '★ a dry run with no --scope and --harness "Claude Code" names claude-code, as the real save will');
  const real = run(['save', '--project', `${D1}/lumina`, '--harness', 'Antigravity'],
    { input: JSON.stringify({ headline: 'saved under the tool scope', now_state: 'x' }) });
  ok(real.code === 0 && /scope 'antigravity'/.test(real.stdout)
    && /No scope was given, so it was saved under your tool's own scope `antigravity`/.test(real.stdout),
  '★ the real save lands in the tool\'s scope and says why', real.stdout + real.stderr);
  const main = run(['save', '--project', `${D1}/lumina`, '--scope', 'main', '--harness', 'Antigravity', '--json'],
    { input: JSON.stringify({ headline: 'explicit main', now_state: 'y' }) });
  ok(parseOut(main)?.scope === 'main' && parseOut(main)?.scopeChosenBy === 'given', 'an explicit --scope main is honoured');
}
{
  // The store's own refusal, surfaced verbatim, with exit 1 — a DIFFERENT code
  // from a usage error, so a script can tell "you asked wrong" from "the store
  // said no".
  const r = run(['save', '--project', `${D1}/lumina`, '--scope', 'foundations'],
    { input: JSON.stringify({ headline: 'a reserved scope' }) });
  ok(r.code === 1, 'a STORE refusal exits 1, not 2');
  ok(/reserved/.test(r.stderr) && /reason: reserved-scope/.test(r.stderr),
    '…with the store’s wording and its reason code');
}
{
  const flags = run(['save', '--project', `${D1}/lumina`, '--scope', 'flagged',
    '--headline', 'from flags alone', '--next-steps', 'alpha', '--next-steps', 'beta', '--json'],
  { input: '' });
  ok(flags.code === 0, 'flags alone can carry a save (no stdin at all)');
  const back = await store.readWorkingState(D1, { project: 'lumina', scope: 'flagged' });
  ok(back.current?.text?.includes('- alpha') && back.current?.text?.includes('- beta'),
    '…and a REPEATED flag collects into a list rather than overwriting itself');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The hook ladder — ask once, never twice, never a borrowed shape');

const USAGE_LOG = path.join(USER_DATA_DIR, '.mcp-usage.jsonl');
const usageLine = (tool, extra = {}) => JSON.stringify({
  ts: new Date().toISOString(), tool, domain: D1, ok: true, refused: false, ms: 4, ...extra,
});

function freshSession(harness, sid, cwd = WORK) {
  // A real session-start clears the marker and records when the session began.
  return run(['hook', 'session-start', '--harness', harness], {
    cwd, input: JSON.stringify({ session_id: sid, cwd }),
  });
}

{
  const r = freshSession('claude-code', 'S-A');
  const j = parseOut(r);
  ok(r.code === 0 && j?.hookSpecificOutput?.hookEventName === 'SessionStart',
    'session-start emits Claude Code’s OWN envelope');
  ok(typeof j?.hookSpecificOutput?.additionalContext === 'string'
    && j.hookSpecificOutput.additionalContext.includes('Project context'),
  '…carrying the bootstrap, resolved from the marker in cwd');
}
{
  const r = run(['hook', 'session-start', '--harness', 'cursor'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-CUR' }),
  });
  const j = parseOut(r);
  ok(typeof j?.additional_context === 'string' && j?.hookSpecificOutput === undefined,
    'Cursor gets `additional_context` — never Claude Code’s shape');
}
{
  const r = run(['hook', 'session-start', '--harness', 'claude-code'], {
    cwd: ROOT, input: JSON.stringify({ session_id: 'S-NOWHERE', cwd: ROOT }),
  });
  ok(r.code === 0, 'session-start with NO resolvable project still exits 0');
  ok(r.stdout === '', '…and emits nothing — a first-run user never sees an error from a hook they did not ask for');
}

{
  // Rung 4: the log shows no bridge session at all → do not nag about a tool
  // this agent is not using.
  writeFileSync(USAGE_LOG, '');
  freshSession('claude-code', 'S-B');
  const r = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-B' }),
  });
  ok(r.code === 0 && r.stdout === '', 'RUNG 4 — no bridge session in the window: no ask');
  ok(/rung 4/.test(r.stderr), '…and the rung is recorded on stderr');
}
{
  // Rung 5: the session READ state and did not save it.
  freshSession('claude-code', 'S-C');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const first = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-C' }),
  });
  ok(first.code === 2, 'RUNG 5 — an unsaved session is BLOCKED (exit 2)');
  ok(first.stdout === '', '…with stdout EMPTY: an exit-2 block carries no envelope');
  ok(first.stderr.includes('save_working_state') && first.stderr.includes(`${D1}/lumina`),
    '…and the reason names the tool and the project');

  const second = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-C' }),
  });
  ok(second.code === 0, 'THE SAME SESSION IS NEVER ASKED TWICE — the CLI’s own marker ends it');

  // RUNG 1, with its own CONTROL. The flagged call and the unflagged one are
  // the SAME session in the SAME state, so the only difference between exit 0
  // and exit 2 is the field — without the control this assertion passes on a
  // session that was never going to be asked at all, which is what it did
  // before a mutation caught it.
  freshSession('claude-code', 'S-D');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const withFlag = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-D', stop_hook_active: true }),
  });
  ok(withFlag.code === 0 && withFlag.stdout === '',
    'RUNG 1 — `stop_hook_active` ends it before anything else is read');
  const control = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-D' }),
  });
  ok(control.code === 2,
    '…and the CONTROL: the same session WITHOUT the field is asked, so rung 1 is what ended it');
}
{
  freshSession('claude-code', 'S-E');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n${usageLine('save_working_state')}\n`);
  const r = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-E' }),
  });
  ok(r.code === 0 && r.stdout === '', 'RUNG 3 — a save in this session: no ask');
  ok(/rung 3/.test(r.stderr), '…and it says so');

  freshSession('claude-code', 'S-E2');
  writeFileSync(USAGE_LOG,
    `${usageLine('get_project_context')}\n${usageLine('save_working_state', { ok: false, refused: true })}\n`);
  const refused = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-E2' }),
  });
  ok(refused.code === 2, 'a REFUSED save is not a save — the ask still fires');

  freshSession('claude-code', 'S-E3');
  writeFileSync(USAGE_LOG,
    `${usageLine('get_project_context', { via: 'self-test' })}\n${usageLine('save_working_state', { via: 'self-test' })}\n`);
  const selfTest = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-E3' }),
  });
  ok(selfTest.code === 0 && /rung 4/.test(selfTest.stderr),
    'SELF-TEST lines are excluded — a button the user pressed is not a session that saved');
}
{
  freshSession('cursor', 'S-F');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const r = run(['hook', 'stop', '--harness', 'cursor'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-F' }),
  });
  ok(r.code === 0, 'Cursor is never BLOCKED — its shape submits a message instead');
  const j = parseOut(r);
  ok(typeof j?.followup_message === 'string' && j.followup_message.includes('save_working_state'),
    '…emitting `followup_message`, the gentler of the two shapes');

  // The log line must be written AFTER the session start: the window opens at
  // the start, and a line older than it is a call from a previous session.
  freshSession('cursor', 'S-G');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const looped = run(['hook', 'stop', '--harness', 'cursor'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-G', loop_count: 1 }),
  });
  ok(looped.code === 0 && looped.stdout === '', 'Cursor’s `loop_count` ends the ladder at rung 1');
  const loopControl = run(['hook', 'stop', '--harness', 'cursor'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-G' }),
  });
  ok(parseOut(loopControl)?.followup_message,
    '…and the CONTROL: the same session with no `loop_count` IS asked');
}
{
  freshSession('gemini-cli', 'S-H');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const r = run(['hook', 'stop', '--harness', 'gemini-cli'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-H' }),
  });
  ok(r.code === 0 && r.stdout === '',
    'an UNVERIFIED envelope (Gemini’s AfterAgent) is WITHHELD, never approximated');
  ok(/unverified/.test(r.stderr), '…with the reason recorded rather than silently doing nothing');
}
{
  const r = run(['hook', 'stop', '--harness', 'some-future-harness'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-I' }),
  });
  ok(r.code === 0 && r.stdout === '',
    'an UNKNOWN harness receives NOTHING — never a shape built for another one');
  ok(/not a harness this build knows/.test(r.stderr), '…and is told so on stderr');
}
{
  freshSession('codex', 'S-J');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context')}\n`);
  const r = run(['hook', 'pre-compact', '--harness', 'codex'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-J' }),
  });
  ok(r.code === 0 && parseOut(r)?.continue === false,
    'Codex’s pre-compact refusal is the documented `{"continue": false}`');
  ok(Object.keys(parseOut(r) || { a: 1, b: 2 }).length === 1,
    '…and NO key is invented beside it — the sentence goes to stderr');
  ok(r.stderr.includes('save_working_state'), '…where the sentence is');
}
{
  const r = run(['hook', 'session-end', '--harness', 'goose'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-K' }),
  });
  ok(r.code === 0 && r.stdout === '', 'session-end RECORDS and exits — no save is ever driven from it');
}
{
  const r = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: 'not json at all{{{',
  });
  ok(r.code === 0 || r.code === 2, 'an unparseable payload never crashes the hook');
  ok(!/Error|at Object|\.js:\d+/.test(r.stderr.split('\n')[0] || ''),
    '…and never prints a stack trace at a harness');
}
{
  const r = run(['hook', 'not-an-event', '--harness', 'claude-code'], { cwd: WORK, input: '{}' });
  ok(r.code === 2 && r.stdout === '', 'an unknown EVENT is a usage error');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  `doctor` — reports, never fails, never writes');

{
  const before = fingerprint(ROOT);
  const r = run(['doctor', '--project', `${D1}/lumina`], { cwd: WORK });
  const after = fingerprint(ROOT);
  ok(r.code === 0, 'doctor exits 0 — a doctor that fails is a doctor nobody runs');
  ok(before === after, 'doctor wrote NOTHING anywhere under the fixture root');
  ok(/Claude Code — not configured/.test(r.stdout) && /Cursor — not configured/.test(r.stdout),
    'every harness on an EMPTY home reads "not configured"');
  ok(/Aider — no MCP client at all/.test(r.stdout), 'Aider is named as having no MCP client, not as unconfigured');
  ok(new RegExp(`${D1}/lumina`).test(r.stdout), 'the project resolved from cwd is reported');
  ok(/curator on PATH/.test(r.stdout), 'both binary names are reported (the Elastic collision)');
}
{
  const j = parseOut(run(['doctor', '--json'], { cwd: WORK })) || { harnesses: [], usageLog: {}, domains: {} };
  ok(j.harnesses.length >= 12, 'the JSON form lists every harness the matrix knows');
  ok(j.usageLog.path.startsWith(USER_DATA_DIR), 'the usage-log path resolves through paths.js, inside the fixture');
  ok(j.domains.path === DOMAINS_DIR, 'the domains folder resolves through config.js, inside the fixture');
}
{
  // A config file that does not parse is REPORTED, never fatal, and never
  // silently treated as "no server configured" — Decision L's reading half.
  const cursorDir = path.join(FAKE_HOME, '.cursor');
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(path.join(cursorDir, 'mcp.json'), '{ this is not json');
  const r = run(['doctor'], { cwd: WORK });
  ok(r.code === 0, 'an unparseable harness config does not fail the doctor');
  ok(/could not be parsed/.test(r.stdout), '…it is reported by name');
  rmSync(cursorDir, { recursive: true, force: true });
}
{
  // A `curator` on PATH that is NOT this package is the Elastic case: the
  // alias step must REFUSE and say what it found.
  const fakeBin = path.join(ROOT, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  const shadow = path.join(fakeBin, 'curator');
  writeFileSync(shadow, '#!/bin/sh\necho elasticsearch-curator\n', { mode: 0o755 });
  const r = run(['doctor', '--alias'], { cwd: WORK, env: { PATH: `${fakeBin}:${BASE_ENV.PATH}` } });
  ok(r.code === 0 && /REFUSED/.test(r.stdout), '--alias REFUSES when `curator` resolves elsewhere');
  ok(r.stdout.includes(shadow), '…naming the exact file it found');
  ok(!/\bln -s\b/.test(r.stdout), '…and never printing a command that would shadow it');

  const plain = run(['doctor'], { cwd: WORK, env: { PATH: `${fakeBin}:${BASE_ENV.PATH}` } });
  ok(/NOT this package/.test(plain.stdout), 'doctor says plainly that the short name is somebody else’s');
}
{
  // THE CATCH-ALL, EXECUTED. "Exit 0 always" is this command's whole promise,
  // and the one branch that keeps it when everything else has failed cannot be
  // reached from a command line without breaking the machine. It is driven
  // IN-PROCESS through the `deps.collect` seam — the exit code is not a
  // process property here, it is the return value the bin assigns.
  const { runDoctor } = await import('../src/cli/doctor.js');
  const realWrite = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let outBytes = '';
  let errBytes = '';
  process.stdout.write = (s) => { outBytes += s; return true; };
  process.stderr.write = (s) => { errBytes += s; return true; };
  let code;
  try {
    code = await runDoctor({ _: [], flags: {} }, {
      collect: async () => { throw new Error('the machine is on fire'); },
    });
  } finally {
    process.stdout.write = realWrite;
    process.stderr.write = realErr;
  }
  ok(code === 0, 'doctor exits 0 even when collection THROWS — a doctor that fails is a doctor nobody runs');
  ok(outBytes === '', '…writing nothing to stdout');
  ok(/on fire/.test(errBytes), '…and saying on stderr why it could not complete');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  A read writes nothing — including the usage log');

{
  writeFileSync(USAGE_LOG, `${usageLine('get_node')}\n`);
  const logBefore = `${statSync(USAGE_LOG).size}:${sha(readFileSync(USAGE_LOG))}`;
  const stateBefore = fingerprint(path.join(DOMAINS_DIR, D1, 'state'));
  run(['context', '--project', `${D1}/lumina`, '--json']);
  run(['resolve', '--project', `${D1}/lumina`]);
  run(['doctor'], { cwd: WORK });
  const logAfter = `${statSync(USAGE_LOG).size}:${sha(readFileSync(USAGE_LOG))}`;
  ok(logBefore === logAfter,
    'context + resolve + doctor leave the MCP usage log BYTE-IDENTICAL');
  ok(stateBefore === fingerprint(path.join(DOMAINS_DIR, D1, 'state')),
    '…and the state tree untouched');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  The pipe — a large bootstrap arrives whole');

{
  // 150 KB of document, read back through a pipe. `process.exit()` would
  // discard everything past the pipe buffer (~64 KB), which is precisely the
  // defect skills/build.mjs measured and recorded.
  const big = `# big\n\n${'The quick brown fox jumps over the lazy dog. '.repeat(3400)}`;
  const bytes = Buffer.byteLength(big);
  const w = await store.saveFoundation(D1, 'lumina', {
    slug: 'big.md', title: 'A large canonical document', role: 'architecture',
    text: big, commissionedByOwner: true, instructedBy: 'user', replace: true,
  });
  ok(w.ok === true && bytes > 128 * 1024, `a ${Math.round(bytes / 1024)} KB document is stored`);

  const r = run(['context', '--project', `${D1}/lumina`, '--include', 'index',
    '--slugs', 'big.md', '--json']);
  ok(r.code === 0, 'the CLI exits 0 on a payload far past the pipe buffer');
  const j = parseOut(r);
  ok(j !== null, 'every byte arrived — the JSON still parses');
  const doc = j?.foundations?.requested?.find((d) => d.slug === 'big.md');
  ok(doc && Buffer.byteLength(doc.text) === bytes,
    '…and the document is WHOLE, byte for byte, not cut at 64 KB');
  ok(r.stdout.length > 128 * 1024, `…on ${Math.round(r.stdout.length / 1024)} KB of stdout`);

  // v3.67.0 — THE OWNER'S READING BUDGET, through the real binary. The
  // Markdown says whose budget chose the texts, and a caller's --budget is
  // still the override and says so.
  const md0 = run(['context', '--project', `${D1}/lumina`]);
  ok(md0.code === 0 && md0.stdout.includes('Reading budget: 120 KB — the default'),
    '`my-curator context` prints "Reading budget: 120 KB — the default" on an untouched project');
  const setB = await store.setReadingBudget(D1, 'lumina', 65536);
  ok(setB.ok === true, 'PRECONDITION: the owner sets 64 KB (the app\u2019s store call)');
  const md1 = run(['context', '--project', `${D1}/lumina`]);
  ok(md1.stdout.includes("Reading budget: 64 KB — the owner's"), '…and "Reading budget: 64 KB — the owner\'s" once one is set');
  const j1 = parseOut(run(['context', '--project', `${D1}/lumina`, '--json']));
  ok(j1?.foundations?.budget?.source === 'owner' && j1?.foundations?.planned === true && j1?.readingBudgetBytes === 65536,
    '--json is the store envelope: budget.source "owner", planned, readingBudgetBytes 65536');
  const j2 = parseOut(run(['context', '--project', `${D1}/lumina`, '--json', '--budget', '150000']));
  ok(j2?.foundations?.budget?.source === 'caller' && j2?.foundations?.budget?.maxBytes === 150000,
    '--budget stays the caller override, and is reported as `caller`');
  await store.setReadingBudget(D1, 'lumina', null);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  The command surface itself');

{
  const r = run([]);
  ok(r.code === 2 && r.stdout.includes('my-curator context'), 'a bare invocation prints usage and exits 2');
  const h = run(['help']);
  ok(h.code === 0, '`help` exits 0');
  const bad = run(['frobnicate']);
  ok(bad.code === 2 && bad.stdout === '' && /unknown command/.test(bad.stderr),
    'an unknown command refuses on stderr with exit 2');
  const v = run(['version']);
  ok(v.code === 0 && /^\d+\.\d+\.\d+$/.test(v.stdout.trim()), '`version` prints the package version');
}
{
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  ok(pkg.bin && Object.keys(pkg.bin).length === 1 && pkg.bin['my-curator'] === 'bin/curator.js',
    'package.json declares EXACTLY ONE bin, `my-curator` — `curator` is never claimed');
  ok(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node'), 'the bin carries a shebang');
  ok((statSync(BIN).mode & 0o111) !== 0, 'the bin is executable');
}
{
  // `--domains-path` must be installed BEFORE anything resolves a path, the
  // same ordering mcp/server.js records. A second, EMPTY domains folder proves
  // it: the project vanishes only if the flag really took effect.
  const other = path.join(ROOT, 'other-domains');
  mkdirSync(other, { recursive: true });
  const unsetEnv = ['CURATOR_TEST_DOMAINS_DIR'];
  const r = run(['resolve', '--project', `${D1}/lumina`, '--domains-path', other], { cwd: ROOT, unsetEnv });
  ok(r.code === 2 && /not a domain in this Curator/.test(r.stderr),
    '--domains-path is honoured — the project is not in the other folder');
  const back = run(['resolve', '--project', `${D1}/lumina`, '--domains-path', DOMAINS_DIR], { cwd: ROOT, unsetEnv });
  ok(back.code === 0 && back.stdout.trim() === `${D1}/lumina`, '…and pointing it back finds it again');
}
{
  // A SOURCE scan, and therefore one that must not read its own comments. The
  // header of every one of these files DISCUSSES `process.exit()` and names
  // `src/routes/mcp.js`; a naive scan reds on the explanation rather than on
  // the code, which is the "measuring the wrong thing" shape this repo keeps
  // recording. Comments are stripped first, and the control below proves the
  // stripper did not simply eat everything.
  const files = ['resolve.js', 'context.js', 'save.js', 'hook.js', 'doctor.js']
    .map((f) => path.join(REPO_ROOT, 'src', 'cli', f)).concat([BIN]);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const code = files.map((f) => strip(readFileSync(f, 'utf8'))).join('\n');
  ok(/process\.exitCode/.test(code) && code.length > 10_000,
    'the comment stripper left the code behind (the control for the three scans below)');
  // `process.exit()` is the one call that can truncate the product on a pipe,
  // and `console.log` is how a diagnostic ends up in a harness's parser.
  ok(!/\bprocess\.exit\s*\(/.test(code), 'no `process.exit()` anywhere in the CLI — only `process.exitCode`');
  ok(!/\bconsole\.log\s*\(/.test(code), 'no `console.log` — stdout is written deliberately or not at all');
  // Decision B, as a structural fact rather than a promise: a route importing
  // the CLI, or the CLI importing a route, is what would make this the app.
  const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  ok(specifiers.length >= 8, `…and ${specifiers.length} import specifiers were found to check`);
  ok(!specifiers.some((s) => s.includes('/routes/') || s.includes('/public/')),
    'the CLI imports nothing from src/routes or src/public — it is a local client, not the app');

  // AND THE OTHER DIRECTION, which is the half that actually matters: a route
  // importing this command would make a browser request reach a tier-2 write
  // path, and the single-writer argument the whole store rests on assumes the
  // app is READ-ONLY there. Scanned over every route file, with a control so
  // an empty scan cannot pass for a clean one.
  const routeDir = path.join(REPO_ROOT, 'src', 'routes');
  const routeFiles = readdirSync(routeDir).filter((f) => f.endsWith('.js'));
  ok(routeFiles.length >= 8, `…and ${routeFiles.length} route files were found to scan (the control)`);
  const offenders = routeFiles.filter((f) => {
    const t = strip(readFileSync(path.join(routeDir, f), 'utf8'));
    return [...t.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
      .some((m) => m[1].includes('/cli/') || m[1].includes('bin/curator'));
  });
  ok(offenders.length === 0,
    `no Express route imports the CLI${offenders.length ? ` — found in ${offenders.join(', ')}` : ''}`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  The two short flags — and the HANG they were bought with');

{
  // MEASURED 2026-09-20: `my-curator save -f <file>` hung forever. `parseArgv`
  // had no `-x` arm, so `-f` and its path fell into the POSITIONALS; `runSave`
  // saw no `--file`, took its stdin arm, and waited on a terminal that was
  // never going to close. `save`'s own usage text had printed `-f <file>` and
  // `runSave` had read `flagStr(flags, 'f')` since the day it shipped. A hang
  // is the worst refusal shape this CLI has: no exit code, nothing on stderr,
  // and inside a hook it does not fail the turn, it stops it.
  //
  // EVERY case below runs under `run()`, which passes `input: ''` and closes
  // stdin — so a regression cannot hang this suite; it reds it, because the
  // body arrives from stdin as empty and the refusal changes.
  const bodyFile = path.join(ROOT, 'handoff.json');
  writeFileSync(bodyFile, JSON.stringify({
    headline: 'saved from a file, through -f',
    now_state: 'driven by §9 of test-cli-curator.js',
  }));

  const short = run(['save', '--project', `${D1}/lumina`, '--scope', 'shortflag', '-f', bodyFile, '--json'], { cwd: ROOT });
  ok(short.code === 0, '`-f <file>` is READ — the hang is closed');
  const j = parseOut(short);
  ok(j?.ok === true && j?.scope === 'shortflag', '…and the store wrote the scope the body asked for');

  const long = run(['save', '--project', `${D1}/lumina`, '--scope', 'longflag', '--file', bodyFile, '--json'], { cwd: ROOT });
  const jl = parseOut(long);
  ok(jl?.ok === true, '`--file` still works');
  ok(jl?.headline === j?.headline || (j && jl && jl.ok === j.ok),
    '…and `-f` is an ALIAS of it, not a second code path');

  // `-h` is the other half of the pair and nothing else is.
  const h = run(['save', '-h']);
  ok(h.code === 0 && h.stdout.includes('my-curator save'), '`-h` prints the usage and exits 0');
  const hd = run(['doctor', '-h']);
  ok(hd.code === 0 && hd.stdout.includes('my-curator doctor'), '…on every subcommand, not just save');

  // NOT a general short-option parser. A bare `-` is documented as "read
  // stdin" and must stay a POSITIONAL, and an unknown `-x` must not silently
  // become a flag named x.
  const { parseArgv, SHORT_FLAGS } = await import('../src/cli/resolve.js');
  ok(Object.keys(SHORT_FLAGS).join(',') === '-f,-h',
    `exactly two short flags are recognised (${Object.keys(SHORT_FLAGS).join(', ')})`);
  ok(parseArgv(['save', '-']). _.includes('-'), 'a bare `-` stays a positional');
  ok(parseArgv(['save', '-x', 'v']).flags.x === undefined, 'an unknown `-x` is NOT turned into a flag');
  ok(parseArgv(['save', '-fx']).flags.file === undefined, 'clustered short flags are not parsed');
  ok(parseArgv(['save', '--', '-f', 'z'])._.join(',') === 'save,-f,z',
    'after `--`, `-f` is literal text like everything else');
  // A valueless flag followed by `-f` must not swallow it as its value.
  const two = parseArgv(['save', '--json', '-f', 'a.json']);
  ok(two.flags.json === true && two.flags.file === 'a.json',
    'a short flag ENDS the previous flag\'s value, exactly as `--` does');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  Two installs, one machine — the usage log and the machine id');

{
  // MEASURED 2026-09-20: a checkout and the installed `.app` resolve DIFFERENT
  // user-data dirs, so there are two `.mcp-usage.jsonl` files and two
  // `.curator-machine-id` values (`alices-macbook-pro-17d23c` against
  // `…-acb035`). The stop hook read only its own log, never saw a save the
  // bridge had logged, and therefore asked at the end of every turn including
  // the ones that had just saved.
  const usage = await import('../src/brain/mcp-usage.js');

  // The isolation arm FIRST, because it is what keeps this suite honest: under
  // CURATOR_TEST_USER_DATA_DIR the second candidate must NEVER be offered, or
  // every assertion here would depend on the maintainer's real log.
  const isolated = usage.candidateUsageLogPaths();
  ok(isolated.length === 1, 'under test isolation there is exactly ONE candidate log');
  ok(isolated[0].startsWith(USER_DATA_DIR), '…and it is the fixture\'s');

  // The two real arms, driven through the seam rather than by being a
  // different install.
  const both = usage.candidateUsageLogPaths({
    primary: '/w/checkout/.mcp-usage.jsonl',
    bundleDir: '/Users/x/Library/Application Support/The Curator',
    userDataDir: '/w/checkout',
    appRoot: '/w/checkout',
    isBundle: false,
    env: {},
    exists: () => true,
  });
  ok(both.length === 2, 'a repo install WITH a bundle log beside it offers both');
  ok(both[1] === '/Users/x/Library/Application Support/The Curator/.mcp-usage.jsonl',
    '…the second being the bundle\'s, at the BASENAME taken from the first');
  const none = usage.candidateUsageLogPaths({
    primary: '/w/checkout/.mcp-usage.jsonl',
    bundleDir: '/Users/x/Library/Application Support/The Curator',
    userDataDir: '/w/checkout', appRoot: '/w/checkout', isBundle: false, env: {}, exists: () => false,
  });
  ok(none.length === 1, 'a bundle log that does not exist is not offered');
  const inBundle = usage.candidateUsageLogPaths({
    primary: '/Users/x/Library/Application Support/The Curator/.mcp-usage.jsonl',
    bundleDir: '/Users/x/Library/Application Support/The Curator',
    userDataDir: '/Users/x/Library/Application Support/The Curator',
    appRoot: '/Applications/The Curator.app/Contents/Resources/app',
    isBundle: true, env: {}, exists: () => true,
  });
  ok(inBundle.length === 1, 'a BUNDLE install offers one — the candidate IS its primary');

  // AND THE HOOK ACTUALLY READS THE UNION. A save recorded in the SECOND log
  // and nowhere else must silence the ask (rung 3). Driven with a real second
  // log injected through the seam-free path: a bundle-shaped directory the
  // helper is pointed at.
  const { tallyUsageLines, readUsageLines } = await import('../src/cli/hook.js');
  const since = Date.now() - 60_000;
  const merged = tallyUsageLines([
    JSON.parse(usageLine('get_project_context', { sid: 'aaaaaaaaaaaa', project: 'lumina' })),
    JSON.parse(usageLine('save_working_state', { sid: 'aaaaaaaaaaaa', project: 'lumina' })),
  ], { since, domain: D1, project: 'lumina' });
  ok(merged.saves === 1 && merged.bootstraps === 1,
    'the tally counts a read and a save from lines that came from either file');
  const r = await readUsageLines();
  ok(Array.isArray(r.files) && r.files.length >= 1,
    'readUsageLines reports WHICH files it read, so a reading can show its work');
  ok(r.files.every((f) => f.startsWith(USER_DATA_DIR)),
    '…and under isolation every one of them is inside the fixture');
  // BEHAVIOURAL, not a source scan: the hook must read EXACTLY the list the
  // one owner of that list produces. A `includes('candidateUsageLogPaths')`
  // check was written first and a mutation walked straight through it — the
  // DOCBLOCK names the function, so the scan passed while the call was gone.
  // An assertion satisfied by a comment is worse than none.
  ok(r.files.join('|') === usage.candidateUsageLogPaths().join('|'),
    '…and they are EXACTLY candidateUsageLogPaths()\'s list, not a second derivation');

  // The DEAD PROBE is gone: `summariseSessions()` called with no argument
  // never returned a `lines` array, so the branch that preferred it could not
  // be taken. A branch that cannot be taken cannot be tested.
  const hookSrc = readFileSync(path.join(REPO_ROOT, 'src/cli/hook.js'), 'utf8');
  ok(!/mod\.summariseSessions|s\.lines/.test(hookSrc), 'the unreachable summariseSessions probe was removed, not repaired');

  // ── END TO END: A SAVE IN THE OTHER LOG SILENCES THE ASK ──────────────
  //
  // The defect in one sentence: the agent saved, the bridge logged it in the
  // .app's log, the hook read the checkout's, found nothing, and asked again.
  // Driven through the SHIPPED BINARY with a second log the suite owns, so it
  // is the spawned process's own reading that is measured — the unit arms
  // above cannot see a process boundary, and this is where the bug lived.
  const otherLogDir = path.join(ROOT, 'otherinstall');
  mkdirSync(otherLogDir, { recursive: true });
  const otherLog = path.join(otherLogDir, '.mcp-usage.jsonl');

  freshSession('claude-code', 'S-UNION');
  // This install's own log records the READ but no save — rung 5 territory.
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context', { project: 'lumina' })}\n`);
  writeFileSync(otherLog, '');
  const asks = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-UNION' }),
    env: { CURATOR_TEST_BUNDLE_LOG_DIR: otherLogDir },
  });
  ok(asks.code === 2, 'CONTROL: with no save in EITHER log the hook still asks');

  // Now the save exists — but ONLY in the other install's log.
  freshSession('claude-code', 'S-UNION2');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context', { project: 'lumina' })}\n`);
  writeFileSync(otherLog, `${usageLine('save_working_state', { project: 'lumina' })}\n`);
  const quiet = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-UNION2' }),
    env: { CURATOR_TEST_BUNDLE_LOG_DIR: otherLogDir },
  });
  ok(quiet.code === 0 && quiet.stdout === '',
    'a save logged by the OTHER install silences the ask — the union is read across the process boundary');
  ok(/rung 3/.test(quiet.stderr), '…at rung 3, which is the rung that could never fire before');

  // AND ACROSS A ROTATION. The log rotates at 1 MB to one previous
  // generation, and a save made just before the roll is still a save — a
  // reader that skips `<path>.1` re-asks for something already done, which is
  // the same defect one file later.
  freshSession('claude-code', 'S-UNION3');
  writeFileSync(USAGE_LOG, `${usageLine('get_project_context', { project: 'lumina' })}\n`);
  writeFileSync(otherLog, '');
  writeFileSync(`${otherLog}.1`, `${usageLine('save_working_state', { project: 'lumina' })}\n`);
  const rotated = run(['hook', 'stop', '--harness', 'claude-code'], {
    cwd: WORK, input: JSON.stringify({ session_id: 'S-UNION3' }),
    env: { CURATOR_TEST_BUNDLE_LOG_DIR: otherLogDir },
  });
  ok(rotated.code === 0 && /rung 3/.test(rotated.stderr),
    'a save that has already been ROTATED into <path>.1 still counts');

  // DOCTOR DISCLOSES BOTH, and mints NOTHING. Driven through the collect seam
  // with a two-install report, because a suite cannot be two installs.
  const { runDoctor } = await import('../src/cli/doctor.js');
  const realWrite = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = (x) => { out += x; return true; };
  try {
    await runDoctor({ _: [], flags: {} }, {
      collect: async () => ({
        ok: true, cwd: '/w', binaries: { myCurator: ['/usr/local/bin/my-curator'], curator: [], curatorIsOurs: false },
        domains: { path: '/w/domains', exists: true, writable: true, source: 'default' },
        usageLog: {
          path: '/w/.mcp-usage.jsonl', present: true, rotated: false, split: true,
          candidates: [
            { path: '/w/.mcp-usage.jsonl', present: true, rotated: false },
            { path: '/Users/x/Library/Application Support/The Curator/.mcp-usage.jsonl', present: true, rotated: false },
          ],
        },
        identity: {
          split: true,
          dirs: [
            { dir: '/w', machineId: 'alices-macbook-pro-17d23c', installId: '17d23c' },
            { dir: '/Users/x/Library/Application Support/The Curator', machineId: 'alices-macbook-pro-acb035', installId: 'acb035' },
          ],
        },
        install: { bundle: false, appRoot: '/w' },
        project: { ok: true, domain: D1, project: 'lumina', resolvedBy: 'marker', source: 'marker', marker: '/w/.curator-project' },
        bridgeProcesses: { checked: true, running: 0, stale: [], codeChangedAt: null, serverPath: '/w/mcp/server.js' },
        harnesses: [], readingPlan: null,
      }),
    });
  } finally { process.stdout.write = realWrite; }
  ok(out.includes('also on this machine:'), 'doctor names the SECOND usage log');
  ok(out.includes('alices-macbook-pro-17d23c') && out.includes('alices-macbook-pro-acb035'),
    '…and BOTH machine ids');
  ok(/ONE computer, TWO machine ids/.test(out),
    '…saying in one line what that costs — two <machine> folders for one computer');
  ok(/reported, not repaired/.test(out),
    '…and that nothing was changed, because minting is not this command\'s to move');

  // It reads the identity FILES; it must never call the getters, which MINT.
  // Comments stripped first — the docblock that explains this rule names both
  // functions, and a scan that reds on its own explanation gets deleted.
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const docSrc = stripComments(readFileSync(path.join(REPO_ROOT, 'src/cli/doctor.js'), 'utf8'));
  ok(docSrc.includes('readId('), 'the doctor source was read (the scan\'s own control)');
  ok(!/\bmachineId\s*\(|\binstallId\s*\(/.test(docSrc),
    'doctor never CALLS machineId()/installId() — both mint a file when one is missing');
  ok(docSrc.includes('MACHINE_ID_FILENAME') && docSrc.includes('INSTALL_ID_FILENAME'),
    '…it reads the two filenames from the store rather than typing them');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§11  The packaged app ships no command — doctor says so, once');

{
  // MEASURED 2026-09-20: `/Applications/The Curator.app/Contents/Resources/app`
  // has no `bin/` directory at all. The only executable the bundle installs is
  // the MCP launcher shim under Application Support. So an .app-only user has
  // no `my-curator`, and `install-hooks` is unreachable for them — which is
  // worth one line on the command whose subject is what is wired.
  const { runDoctor } = await import('../src/cli/doctor.js');
  const base = {
    ok: true, cwd: '/w', domains: {}, usageLog: {}, identity: { dirs: [] },
    project: { ok: false, message: 'not resolved in this fixture', candidates: [], marker: null },
    bridgeProcesses: { checked: false, reason: 'not looked', running: 0, stale: [] },
    harnesses: [], readingPlan: null,
  };
  const render = async (report) => {
    const realWrite = process.stdout.write.bind(process.stdout);
    let out = '';
    process.stdout.write = (x) => { out += x; return true; };
    try { await runDoctor({ _: [], flags: {} }, { collect: async () => report }); }
    finally { process.stdout.write = realWrite; }
    return out;
  };

  const bundleNoCli = await render({
    ...base, binaries: { myCurator: [], curator: [], curatorIsOurs: false },
    install: { bundle: true, appRoot: '/Applications/The Curator.app/Contents/Resources/app' },
  });
  ok(/ships no command-line tool/.test(bundleNoCli), 'in bundle mode with no `my-curator`, doctor says so');
  ok(/install-hooks/.test(bundleNoCli), '…naming the command that is therefore unreachable');

  const bundleWithCli = await render({
    ...base, binaries: { myCurator: ['/usr/local/bin/my-curator'], curator: [], curatorIsOurs: false },
    install: { bundle: true, appRoot: '/Applications/The Curator.app/Contents/Resources/app' },
  });
  ok(!/ships no command-line tool/.test(bundleWithCli),
    '…and NOT when the npm package is installed beside it — the line is about the absence, not the bundle');

  const repoNoCli = await render({
    ...base, binaries: { myCurator: [], curator: [], curatorIsOurs: false },
    install: { bundle: false, appRoot: '/w' },
  });
  ok(!/ships no command-line tool/.test(repoNoCli),
    '…nor in a checkout, where `node bin/curator.js` is right there');

  // EXIT 0 EVEN WHEN THE RENDER FAILS. §5 proves the COLLECTION throwing is
  // survived; this is the other half, and it was a real crash: a report
  // missing a field `renderDoctor` reads killed the process with a stack trace
  // and a non-zero exit. "Exit 0 always" cannot stop at the halfway point.
  {
    const { runDoctor: rd } = await import('../src/cli/doctor.js');
    const realWrite = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    let o = ''; let e = '';
    process.stdout.write = (x) => { o += x; return true; };
    process.stderr.write = (x) => { e += x; return true; };
    let code;
    try {
      code = await rd({ _: [], flags: {} }, { collect: async () => ({ ok: true, cwd: '/w' }) });
    } finally { process.stdout.write = realWrite; process.stderr.write = realErr; }
    ok(code === 0, 'a report too partial to RENDER still exits 0');
    ok(/could not render/.test(e), '…saying on stderr that it could not render, rather than dying with a stack');
  }

  // ── AND WHAT DOCTOR MAY SAY ABOUT A HARNESS'S REACH ───────────────────
  //
  // Nothing of its own. `hooks.state` and `measured` come off
  // `src/brain/harness-adapters.js`, whose `measured` fields are another
  // package's to fill; doctor prints them VERBATIM or prints NOT MEASURED. A
  // sentence composed here would be a second copy of a fact somebody else is
  // measuring — Decision J from the side that only reads.
  const withMeasure = await render({
    ...base, binaries: { myCurator: ['/x/my-curator'], curator: [], curatorIsOurs: false },
    install: { bundle: false, appRoot: '/w' },
    harnesses: [{
      id: 'claude-code', label: 'Claude Code', mcp: [], hooks: [], instructions: [],
      hookState: 'verified', hookReason: null,
      measured: { 'turn-end ask': 'interactive sessions only; not observed headless (2026-09-20)' },
    }],
  });
  ok(withMeasure.includes('interactive sessions only; not observed headless (2026-09-20)'),
    'a measured row is printed word for word, not paraphrased');
  ok(!/NOT MEASURED/.test(withMeasure), '…and the not-measured line is then withheld');

  const withoutMeasure = await render({
    ...base, binaries: { myCurator: ['/x/my-curator'], curator: [], curatorIsOurs: false },
    install: { bundle: false, appRoot: '/w' },
    harnesses: [{
      id: 'claude-code', label: 'Claude Code', mcp: [], hooks: [], instructions: [],
      hookState: 'verified', hookReason: null, measured: null,
    }],
  });
  ok(/NOT MEASURED/.test(withoutMeasure),
    'a harness with no measurement row reads NOT MEASURED — never as reach it has not earned');

  // And the row is genuinely DERIVED from the table rather than re-typed.
  const { collectDoctor } = await import('../src/cli/doctor.js');
  const A = await import('../src/brain/harness-adapters.js');
  const real = await collectDoctor({ cwd: WORK });
  // EVERY row, not one: `claude-code`'s state happens to be `verified`, so a
  // mutation that hardcodes that word walks past a single-harness check. The
  // table carries all four states (Cursor verified, Codex unverified, OpenCode
  // present-useless, Zed none) and the comparison has to see them all.
  const stateDrift = real.harnesses.filter((x) => x.hookState !== (A.adapterFor(x.id)?.hooks?.state || null));
  ok(stateDrift.length === 0,
    `every harness's hook state IS the adapter table's value${stateDrift.length ? ` — drifted: ${stateDrift.map((x) => x.id).join(', ')}` : ''}`);
  ok(new Set(real.harnesses.map((x) => x.hookState)).size >= 3,
    `…over ${new Set(real.harnesses.map((x) => x.hookState)).size} distinct states (the control — one word would pass a weaker check)`);
  ok(real.harnesses.every((x) => x.measured === (A.adapterFor(x.id)?.measured || null)),
    '…and so is `measured`, which is null on every entry until a verdict exists');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§12  This suite leaves NOTHING in the real hook-marker directory');

{
  // MEASURED 2026-09-20: the real marker directory held 116 files, among them
  // this suite's own session keys (`S-C`, `S-F`, `S-J`, and a
  // `no-session:…/curator-cli-*/work`) from a run made before BASE_ENV pinned
  // CURATOR_TEST_HOOK_DIR. Markers decide the ladder's rung 1, so leftovers
  // from one run can decide the result of the next — the exact failure
  // `markerDir()`'s own docblock records ("one mutation in this package's
  // battery went green: the assertion was passing on a leftover file").
  //
  // The guard is a snapshot taken at IMPORT time (top of this file) compared
  // here, so it covers every case above rather than the ones somebody
  // remembered. It asserts on files ADDED, never on the directory being empty:
  // a real Claude Code session on this machine writes here legitimately while
  // the suite runs, and reddening on somebody else's file would be a guard
  // that cries wolf until it is deleted.
  const now = markerDirSnapshot();
  const added = [...now].filter((f) => !REAL_MARKERS_AT_START.has(f));
  ok(added.length === 0,
    `no file was added to ${REAL_MARKER_DIR}${added.length ? ` — leaked ${added.join(', ')}` : ''}`);

  // THE CONTROL: the guard is worthless if the suite never exercised a hook.
  // The fixture directory must hold the markers the run above wrote.
  let fixtureMarkers = [];
  try { fixtureMarkers = readdirSync(path.join(ROOT, 'hookmarkers')); } catch { fixtureMarkers = []; }
  ok(fixtureMarkers.length >= 4,
    `…and ${fixtureMarkers.length} markers DID land in the fixture (the control — the guard is not vacuous)`);
}

// ── Done ───────────────────────────────────────────────────────────────────
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${failed === 0 ? '✓' : '✗'} test-cli-curator: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
