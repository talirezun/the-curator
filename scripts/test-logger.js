/**
 * test-logger.js — OFFLINE guard for src/brain/logger.js (the app's own log
 * file) and its two integration points: getLogsDir() in src/brain/paths.js
 * and the "Application log" row + POST /api/diagnostics/reveal-log in
 * src/brain/diagnostics.js / src/routes/diagnostics.js.
 *
 * ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
 * The Curator had no logger of its own — `/tmp/the-curator.log` exists only
 * because `scripts/build-app.sh`/`install.sh` redirect the process's stdio
 * with a shell `>>`, which the macOS packaging pivot deletes outright (a
 * signed bundle is not launched via `nohup ... >> file`). logger.js is the
 * real thing several existing comments already talked about as if it
 * existed. This suite pins the properties that make it safe to have:
 *
 *   §1  the log directory resolves through paths.js, honouring BOTH test
 *       seams and their precedence
 *   §2  a written line has the shape callers and a human `cat`-ing the file
 *       can both rely on
 *   §3  absolute paths never reach the file (scrubPaths, reused not
 *       reimplemented)
 *   §4  credential-shaped strings never reach the file — the SAME shapes
 *       this repo's own `.git/hooks/pre-commit` secret guard refuses to let
 *       into the public tree, so "credential-shaped" means one thing
 *       project-wide
 *   §5  a failing write is contained — the module NEVER throws, even when
 *       the log directory cannot be created at all
 *   §6  rotation genuinely bounds the file
 *   §7  the read-only accessors (getLogFilePath/getLogFileStats)
 *   §8  MCP stdout discipline — this module never writes to stdout OR stderr
 *   §9  the "Application log" row in runQuickDiagnostics()
 *   §10 source guards on POST /api/diagnostics/reveal-log — NOT invoked live
 *       (see the note in that section for why)
 *
 * ── METHOD ──────────────────────────────────────────────────────────────
 * The real module is imported and EXECUTED throughout — no re-implementation
 * of the scrubbing or rotation logic. §0 is a positive control that fails
 * loudly if the import itself is broken, rather than letting every later
 * section compare against `undefined` and pass.
 *
 * Every fixture "secret" is a synthetic value with no relationship to a real
 * key. The ones shaped like this repo's own pre-commit secret guard
 * (Gemini/Anthropic/OpenRouter/GitHub/Shared-Brain-admin/PEM) are allow
 * -listed by exact value in `.git/hooks/secret-allowlist` per the
 * `git-hygiene` skill's documented workflow — never by path or pattern.
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────
 *  - §10 does not invoke POST /api/diagnostics/reveal-log for real. It
 *    spawns macOS `open`, which would pop a Finder window on a maintainer
 *    running `npm test` locally and is a no-op-but-still-a-subprocess-call on
 *    CI. Same reasoning src/routes/mcp.js's own reveal-config docblock gives
 *    for excluding ITSELF from live testing — see that file's TESTING NOTE.
 *  - scrubPaths' own documented limits apply unchanged (an unquoted path with
 *    an unusually long space-separated folder name can partially survive) —
 *    see scrub-paths.js's own "NOT ENFORCED" block.
 *  - scrubSecrets matches known credential SHAPES, not arbitrary opaque
 *    secrets. A password or internal id with no recognisable prefix is not
 *    caught by pattern-matching alone.
 *  - §6 proves rotation bounds the file under this module's OWN write path.
 *    It does not prove behaviour if something outside this module ever
 *    truncates or appends to curator.log directly (nothing does today).
 *  - The mkdir-memoisation cache (`_ensuredDir`) is proven to re-verify when
 *    the resolved directory CHANGES (§1/§5), not against a directory that
 *    exists, then is deleted, then recreated at the SAME path mid-process —
 *    the same class of gap paths.js's own getUserDataDir() already carries
 *    and states for the identical reason (a permissions fix mid-process is
 *    not re-probed until the path changes).
 *
 * Dependency-free beyond Node builtins + the shared source-scan helper, no
 * network, no API key, no writes outside os.tmpdir() and this suite's own
 * temp directories.
 */

import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stripComments } from './test-helpers/source-scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(l) { passed++; console.log(`  ✓ ${l}`); }
function bad(l, e) { failed++; fails.push({ l, e }); console.log(`  ✗ ${l}`); if (e) console.log(`    └─ ${e}`); }
function assert(c, l, e) { c ? ok(l) : bad(l, e || 'assertion failed'); }
function eq(actual, expected, label) {
  assert(actual === expected, label,
    actual === expected ? undefined : `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

// ── Real credential-file fingerprint guard ───────────────────────────────────
// This suite never sets __setUserDataDirOverride at all (logger.js does not
// resolve through getUserDataDir() — it has its own SEPARATE seam), so it
// should be structurally impossible for anything here to touch the
// maintainer's real .curator-config.json. Fingerprinted anyway, because a
// guard that only asserts what should be true is not a guard.
const REAL_CREDENTIAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json', '.env']
  .map((rel) => path.join(ROOT, rel));
function fingerprintReal() {
  return REAL_CREDENTIAL_FILES.map((p) => {
    if (!existsSync(p)) return { path: p, exists: false };
    const buf = readFileSync(p);
    return { path: p, exists: true, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  });
}
function fingerprintsMatch(a, b) {
  return a.every((f, i) => f.exists === b[i].exists && (!f.exists || (f.size === b[i].size && f.sha256 === b[i].sha256)));
}
const realBefore = fingerprintReal();

const work = mkdtempSync(path.join(tmpdir(), 'curator-logger-test-'));
function freshDir(name) {
  const d = path.join(work, name);
  mkdirSync(d, { recursive: true });
  return d;
}

const paths = await import(path.join(ROOT, 'src/brain/paths.js'));
const logger = await import(path.join(ROOT, 'src/brain/logger.js'));

try {

// ═══════════════════════════════════════════════════════════════════════════
section('§0  Positive control — the module actually imported');
// ═══════════════════════════════════════════════════════════════════════════
for (const name of ['logInfo', 'logWarn', 'logError', 'scrubSecrets', 'getLogFilePath', 'getLogFileStats',
  '__setMaxLogBytesOverride', 'MAX_LOG_BYTES', 'LOG_FILE_NAME']) {
  assert(name in logger, `logger.js exports ${name}`);
}
assert(typeof paths.getLogsDir === 'function', 'paths.js exports getLogsDir()');
assert(typeof paths.__setLogDirOverride === 'function', 'paths.js exports __setLogDirOverride()');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  getLogsDir() resolves through paths.js, honouring both test seams');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Default, with NEITHER seam active — must never be a tempdir.
  paths.__setLogDirOverride(null);
  delete process.env.CURATOR_TEST_LOG_DIR;
  const dflt = paths.getLogsDir();
  eq(dflt, path.join(os.homedir(), 'Library', 'Logs', 'The Curator'), 'default resolves to ~/Library/Logs/The Curator');
  assert(path.isAbsolute(dflt), 'the default is an absolute path');

  // Env seam alone.
  const envDir = freshDir('env-seam');
  process.env.CURATOR_TEST_LOG_DIR = envDir;
  eq(paths.getLogsDir(), envDir, 'CURATOR_TEST_LOG_DIR alone is honoured');

  // In-process override OUTRANKS the env var — same precedence rule
  // getUserDataDir() already documents for __setUserDataDirOverride.
  const overrideDir = freshDir('override-seam');
  paths.__setLogDirOverride(overrideDir);
  eq(paths.getLogsDir(), overrideDir, '__setLogDirOverride wins over CURATOR_TEST_LOG_DIR when both are set');

  // Clearing the override falls back to the still-set env var, not the default.
  paths.__setLogDirOverride(null);
  eq(paths.getLogsDir(), envDir, 'clearing the override reveals the env seam underneath (not the real default)');

  delete process.env.CURATOR_TEST_LOG_DIR;
}

// From here on, every section works inside an isolated directory.
const isolated = freshDir('isolated-logs');
paths.__setLogDirOverride(isolated);

// ═══════════════════════════════════════════════════════════════════════════
section('§2  A written line has the shape callers can rely on');
// ═══════════════════════════════════════════════════════════════════════════
{
  logger.logInfo('smoke', 'hello world');
  const file = path.join(isolated, 'curator.log');
  assert(existsSync(file), 'the log file was created');
  const contents = readFileSync(file, 'utf8');
  const lines = contents.trim().split('\n');
  eq(lines.length, 1, 'exactly one line was written for one call');
  const line = lines[0];
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] \[smoke\] hello world$/.test(line),
    `line matches ISO-timestamp / level / scope / message shape (got: "${line}")`);
  const ts = new Date(line.slice(0, 24));
  assert(!Number.isNaN(ts.getTime()) && Math.abs(Date.now() - ts.getTime()) < 10_000,
    'the timestamp parses and is genuinely close to now');

  logger.logWarn('smoke', 'a warning');
  logger.logError('smoke', 'an error');
  const after = readFileSync(file, 'utf8').trim().split('\n');
  eq(after.length, 3, 'three calls append three lines, not overwrite');
  assert(after[1].includes('[warn]'), 'the second line carries the warn level');
  assert(after[2].includes('[error]'), 'the third line carries the error level');

  // A scope containing brackets/whitespace cannot forge a second bracketed
  // field and desynchronise a line-oriented parser.
  logger.logInfo('weird ]scope[ here', 'x');
  const weirdLine = readFileSync(file, 'utf8').trim().split('\n').pop();
  assert(/^\S+ \[info\] \[[^\]]*\] x$/.test(weirdLine),
    `a hostile scope cannot inject a stray "]" that breaks the field shape (got: "${weirdLine}")`);

  // A message containing a newline cannot masquerade as multiple log lines.
  const beforeCount = readFileSync(file, 'utf8').trim().split('\n').length;
  logger.logInfo('multi', 'line one\nline two\nline three');
  const afterLines = readFileSync(file, 'utf8').trim().split('\n');
  eq(afterLines.length, beforeCount + 1, 'an embedded newline collapses to ONE record, not three');
  assert(afterLines[afterLines.length - 1].includes('line one ⏎ line two ⏎ line three'),
    'the newlines are visibly flattened rather than silently dropped');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  Absolute paths never reach the file (scrubPaths, reused)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const dir = freshDir('path-scrub');
  paths.__setLogDirOverride(dir);
  const homeLike = '/Users/alice smith/Google Drive/My Drive/domains/articles/wiki/log.md';
  logger.logError('paths', `could not read ${homeLike}`);
  const contents = readFileSync(path.join(dir, 'curator.log'), 'utf8');
  assert(!contents.includes('alice smith'), 'the user\'s name does not reach the file');
  assert(!contents.includes('Google Drive'), 'the cloud-storage folder name does not reach the file');
  assert(contents.includes('.../log.md'), 'the basename survives — the useful half of the message (got: ' + JSON.stringify(contents.trim()) + ')');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  Credential-shaped strings never reach the file');
// ═══════════════════════════════════════════════════════════════════════════
{
  const dir = freshDir('secret-scrub');
  paths.__setLogDirOverride(dir);

  // Every fixture below is synthetic. The ones shaped like this repo's own
  // .git/hooks/pre-commit secret guard are allow-listed there by exact value
  // per the git-hygiene skill's documented workflow.
  const FIXTURES = {
    'Gemini/Google API key':      'AIzaFAKEKEY0FAKEKEY0FAKEKEY0FAKEKEY0FAK',
    'Anthropic key':              'sk-ant-FAKE-NOT-REAL-KEY-00000',
    'OpenRouter key':             'sk-or-v1-fixture-not-a-real-key',
    'GitHub classic PAT':         'ghp_abcd1234efgh5678ijkl',
    'GitHub fine-grained PAT':    'github_pat_UNIT_TEST_SECRET_0123456789',
    'Shared Brain admin token':   'sbat_deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    'generic sk- bearer key':     'sk-FAKEKEY000000000000000',
    'Authorization: Bearer':      'Bearer FAKE-BEARER-TOKEN-000000',
    'PEM private key block':      '-----BEGIN RSA PRIVATE KEY-----\nFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----',
    'URL-embedded PAT (git remote)': 'https://x-access-token:ghp_abcd1234efgh5678ijkl@github.com/example/repo.git',
  };

  for (const [label, secret] of Object.entries(FIXTURES)) {
    const scrubbed = logger.scrubSecrets(secret);
    assert(!scrubbed.includes(secret) || secret.length < 8, `scrubSecrets redacts a ${label} (got: "${scrubbed}")`);

    logger.logWarn('secret-test', `token was: ${secret}`);
    const contents = readFileSync(path.join(dir, 'curator.log'), 'utf8');
    // composeLine() flattens embedded newlines (see §2) BEFORE this check
    // would ever see them, so a multi-line fixture (the PEM block) has to be
    // compared against the SAME flattening — otherwise an unscrubbed secret
    // could still pass this assertion vacuously merely because its newlines
    // no longer match verbatim, which is exactly the shape a naive
    // `!contents.includes(secret)` would miss. Caught by mutation-testing
    // this suite itself (disabling scrubSecrets()), not by review.
    const flattenedSecret = secret.replace(/\r?\n+/g, ' ⏎ ');
    assert(!contents.includes(flattenedSecret), `a ${label} written through the real log path does not reach disk`);
  }

  // A benign message with no credential shape must survive byte-identical
  // (beyond the timestamp/level/scope framing) — over-scrubbing would make
  // the log useless for its actual job.
  const dir2 = freshDir('secret-scrub-benign');
  paths.__setLogDirOverride(dir2);
  logger.logInfo('benign', 'The Curator v3.28.0 started at http://localhost:3333');
  const benign = readFileSync(path.join(dir2, 'curator.log'), 'utf8');
  assert(benign.includes('The Curator v3.28.0 started at http://localhost:3333'),
    'an ordinary message with no secret shape survives untouched');

  paths.__setLogDirOverride(isolated);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  A failing write is CONTAINED — the module never throws');
// ═══════════════════════════════════════════════════════════════════════════
{
  // Point the log dir at a path whose PARENT is a regular file — mkdirSync
  // can never succeed there, on any OS.
  const blockerFile = path.join(work, 'blocker-file');
  writeFileSync(blockerFile, 'not a directory');
  const blockedDir = path.join(blockerFile, 'sub', 'logs');
  paths.__setLogDirOverride(blockedDir);

  let threw = null;
  try { logger.logInfo('blocked', 'should be silently absorbed'); }
  catch (err) { threw = err; }
  assert(threw === null, 'logInfo() does not throw when the log directory cannot be created',
    threw ? `threw: ${threw.message}` : undefined);

  try { logger.logWarn('blocked', 'x'); logger.logError('blocked', 'y'); }
  catch (err) { threw = err; }
  assert(threw === null, 'logWarn()/logError() do not throw either, same blocked directory');

  eq(logger.getLogFileStats(), null, 'getLogFileStats() reports null rather than throwing when the file cannot exist');
  assert(!existsSync(blockedDir), 'confirms nothing was silently created around the blocker — this really was blocked');

  // A SECOND, DIFFERENT failure shape: the directory itself exists (so
  // ensureDir()'s own mkdirSync succeeds trivially — an existing directory
  // needs no write permission on its PARENT to be recreated with
  // {recursive:true}), but the directory is not writable, so appendFileSync
  // is what fails. This is the case ONLY writeLine()'s own try/catch
  // protects against — ensureDir()'s inner catch never even fires here — so
  // it is the scenario mutation-testing this module actually needs to red
  // when the outer try/catch is removed. Root bypasses POSIX permission bits
  // entirely, so this is skipped when running as root (CI images sometimes
  // do) rather than reporting a false failure.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.platform !== 'win32' && !isRoot) {
    const readOnlyDir = freshDir('read-only');
    chmodSync(readOnlyDir, 0o555);
    paths.__setLogDirOverride(readOnlyDir);
    let threw2 = null;
    try { logger.logInfo('readonly', 'should also be silently absorbed'); }
    catch (err) { threw2 = err; }
    chmodSync(readOnlyDir, 0o755); // restore so mkdtemp cleanup can remove it later
    assert(threw2 === null, 'logInfo() does not throw when the directory exists but is not writable (the OTHER failure shape)',
      threw2 ? `threw: ${threw2.message}` : undefined);
    eq(logger.getLogFileStats(), null, 'and nothing was written — getLogFileStats() still reports null');
  } else {
    console.log('  ⊘ skipped (running as root or on win32 — POSIX write-permission bits do not apply)');
  }

  paths.__setLogDirOverride(isolated);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  Rotation genuinely bounds the file');
// ═══════════════════════════════════════════════════════════════════════════
{
  const dir = freshDir('rotation');
  paths.__setLogDirOverride(dir);
  const CAP = 500; // bytes — a test-only cap, forced small so this section is fast
  logger.__setMaxLogBytesOverride(CAP);

  const file = path.join(dir, 'curator.log');
  const backup = file + '.1';
  assert(!existsSync(backup), 'no backup exists before any rotation has happened');

  for (let i = 0; i < 60; i++) {
    logger.logInfo('rot', `padding line number ${i} — enough text to add up quickly`);
  }

  assert(existsSync(file), 'the active file still exists after many writes');
  assert(existsSync(backup), 'a rotation genuinely happened — a backup generation exists');
  const activeSize = statSync(file).size;
  const backupSize = statSync(backup).size;
  // Bounded, not "exactly CAP": the check is lazy (before each write), so the
  // active file may briefly exceed CAP by at most one line's length — see
  // this suite's own "NOT ENFORCED" note.
  assert(activeSize < CAP * 2, `the active file stays well under 2x the cap (got ${activeSize} bytes against a ${CAP}-byte cap)`);
  assert(backupSize < CAP * 2, `the backup stays bounded too (got ${backupSize} bytes)`);
  const entries = readdirSync(dir).filter((f) => f.startsWith('curator.log'));
  eq(entries.length, 2, `exactly two generations exist on disk — active + one backup, never more (got: ${entries.join(', ')})`);

  // A SECOND rotation replaces the backup rather than accumulating a third
  // generation — proves this is single-generation rotation, not unbounded.
  const firstBackupContents = readFileSync(backup, 'utf8');
  for (let i = 0; i < 60; i++) {
    logger.logInfo('rot2', `second wave of padding, line ${i} — more filler text here`);
  }
  const entries2 = readdirSync(dir).filter((f) => f.startsWith('curator.log'));
  eq(entries2.length, 2, 'still exactly two generations after a second rotation wave');
  const secondBackupContents = readFileSync(backup, 'utf8');
  assert(secondBackupContents !== firstBackupContents, 'the backup was genuinely REPLACED by the second rotation, not appended to');

  logger.__setMaxLogBytesOverride(null);
  paths.__setLogDirOverride(isolated);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  Read-only accessors');
// ═══════════════════════════════════════════════════════════════════════════
{
  const dir = freshDir('accessors');
  paths.__setLogDirOverride(dir);
  eq(logger.getLogFilePath(), path.join(dir, 'curator.log'), 'getLogFilePath() matches the directory in effect');
  eq(logger.getLogFileStats(), null, 'getLogFileStats() is null before anything is written');
  logger.logInfo('acc', 'one line');
  const stats = logger.getLogFileStats();
  assert(stats && stats.path === path.join(dir, 'curator.log'), 'getLogFileStats() reports the right path once the file exists');
  assert(typeof stats.bytes === 'number' && stats.bytes > 0, 'and a positive byte count');
  assert(typeof stats.mtimeMs === 'number' && stats.mtimeMs > 0, 'and a real mtime');
  paths.__setLogDirOverride(isolated);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  MCP stdout discipline — this module writes to a FILE only');
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = stripComments(readFileSync(path.join(ROOT, 'src/brain/logger.js'), 'utf8'));
  assert(!/console\s*\.\s*(log|error|warn|info|debug)\s*\(/.test(src),
    'logger.js contains ZERO console.* calls anywhere — real code, not just the docblock');
  assert(!/process\s*\.\s*stdout\s*\.\s*write/.test(src), 'and no direct process.stdout.write either');
  // Confirmed by import graph too: today nothing in mcp/'s reachable set
  // imports logger.js. This is a class guard against ever adding one without
  // re-checking stdout discipline, not a claim that it is already reachable.
  const mcpImports = readdirSync(path.join(ROOT, 'mcp'), { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.js'))
    .map((f) => readFileSync(path.join(ROOT, 'mcp', f), 'utf8'))
    .join('\n');
  assert(!/from ['"](\.\.\/)*src\/brain\/logger\.js['"]/.test(mcpImports),
    'nothing under mcp/ imports logger.js today (if this ever changes, the discipline above is what keeps it safe)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  diagnostics.js — the "Application log" row');
// ═══════════════════════════════════════════════════════════════════════════
{
  const config = await import(path.join(ROOT, 'src/brain/config.js'));
  const diagnostics = await import(path.join(ROOT, 'src/brain/diagnostics.js'));

  const domainsDir = freshDir('diag-domains');
  const userDataDir = freshDir('diag-userdata');
  const logDir = freshDir('diag-logs');
  config.__setDomainsDirOverride(domainsDir);
  paths.__setUserDataDirOverride(userDataDir);
  paths.__setLogDirOverride(logDir);

  try {
    const before = await diagnostics.runQuickDiagnostics();
    const rowBefore = before.checks.find((c) => c.id === 'log');
    assert(!!rowBefore, 'runQuickDiagnostics() includes the "log" check');
    eq(rowBefore.label, 'Application log', 'with the expected label');
    eq(rowBefore.status, 'info', 'status is info — there is no "wrong" state for this row');
    assert(rowBefore.detail.includes(logDir), `before anything is written, the detail names the resolved directory (got: "${rowBefore.detail}")`);
    assert(/not.*written yet/i.test(rowBefore.detail), 'and says so in words, not just a bare path');

    logger.logWarn('diag-integration', 'a line for the diagnostics row to find');
    const after = await diagnostics.runQuickDiagnostics();
    const rowAfter = after.checks.find((c) => c.id === 'log');
    assert(/curator\.log/.test(rowAfter.detail) && /KB\)$/.test(rowAfter.detail),
      `once the file exists, the detail names the file and a size (got: "${rowAfter.detail}")`);
    assert(!rowAfter.detail.includes(os.homedir()) || rowAfter.detail.includes(logDir),
      'the shown path is the isolated one, never leaking a different real path in its place');
  } finally {
    config.__setDomainsDirOverride(null);
    paths.__setUserDataDirOverride(null);
    paths.__setLogDirOverride(isolated);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  POST /api/diagnostics/reveal-log — source guards (NOT invoked live)');
// ═══════════════════════════════════════════════════════════════════════════
// This route spawns macOS `open -R <path>` on success. Actually calling it
// would pop a Finder window on a maintainer running `npm test` locally — the
// same reason src/routes/mcp.js's own reveal-config route documents itself
// as untestable end-to-end (see that file's TESTING NOTE). So this section
// proves the WIRING statically instead: execFile (never exec, so no shell
// interpolation), the path resolved server-side from logger.js rather than
// from the request, and the route registered under the expected path.
{
  const routeSrc = stripComments(readFileSync(path.join(ROOT, 'src/routes/diagnostics.js'), 'utf8'));
  assert(/router\.post\(\s*['"]\/reveal-log['"]/.test(routeSrc), "POST '/reveal-log' is registered");
  assert(/execFile\(\s*['"]open['"]/.test(routeSrc), "it invokes execFile('open', ...) — never exec(), which would allow shell interpretation");
  assert(!/\bexec\(/.test(routeSrc.replace(/execFile/g, '')), 'and no bare exec() call exists anywhere else in the file');
  assert(/getLogFilePath\(\)/.test(routeSrc), 'the path comes from getLogFilePath() — resolved server-side, never from req');
  assert(!/req\.(query|body|params)/.test(functionBodyAround(routeSrc, "'/reveal-log'")),
    'nothing inside the reveal-log handler reads req.query/body/params — no client-supplied path can reach execFile');

  function functionBodyAround(src, marker) {
    const idx = src.indexOf(marker);
    if (idx === -1) return '';
    const open = src.indexOf('{', idx);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return src.slice(open);
  }
}

} catch (err) {
  bad('unexpected throw aborted the suite', `${err.message}\n${err.stack || ''}`);
} finally {
  paths.__setLogDirOverride(null);
  paths.__setUserDataDirOverride(null);
  delete process.env.CURATOR_TEST_LOG_DIR;
  logger.__setMaxLogBytesOverride(null);
  rmSync(work, { recursive: true, force: true });
}

const realAfter = fingerprintReal();
assert(fingerprintsMatch(realBefore, realAfter),
  'the real .curator-config.json / .sync-config.json / .sharedbrain-config.json / .env are byte-identical after this run');

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
