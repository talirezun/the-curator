/**
 * test-mcp-launcher.js — OFFLINE suite for the MCP launcher seam.
 *
 * ── What this guards, and why it is written NOW ─────────────────────────────
 *
 * `mcpLaunchStyle` shipped in v3.26.0 with no branch behind it. This release
 * gives it one: `buildCuratorEntry()` in `src/routes/mcp.js` now emits a
 * different Claude Desktop entry in bundle mode, and `src/brain/mcp-launcher.js`
 * generates the shell shim that entry points at.
 *
 * The bundle arm is UNREACHABLE in production — there is no Electron bundle —
 * which is exactly why it is written now, on v3.26.0's own precedent: while it
 * is provably dead code the whole change is a no-op for every existing user,
 * and the ONE claim that has to hold is that the repo arm is unchanged.
 *
 * So the headline assertion is not "the bundle arm works". It is:
 *
 *     in repo mode, buildCuratorEntry() returns byte-identically what it
 *     returned at HEAD, for every input.
 *
 * ── The proof method for that, stated ───────────────────────────────────────
 *
 * A `git diff -w` proof is NOT sufficient here and saying so matters. v3.26.0
 * could use one because its change only moved registration wrappers; this
 * change inserts a branch ABOVE the returned literal, so a diff shows an
 * addition and cannot by itself say the surviving arm is reachable with the
 * same inputs. Three independent proofs are used instead:
 *
 *   §2a TEXT     — the repo arm's return statement is extracted from HEAD and
 *                  from the working tree and sha256-compared. Identical bytes.
 *   §2b BEHAVIOUR— both versions of the FUNCTION are extracted and executed in
 *                  a sandbox over a matrix of inputs with the capability
 *                  stubbed to 'node-script'. Deep-equal on every one. Paired
 *                  with a control proving the comparison is not vacuous: with
 *                  the stub flipped, the two MUST differ.
 *   §2c LIVE     — this checkout is repo mode, so the REAL exported function
 *                  is driven directly and must still produce
 *                  {process.execPath, [server.js, --domains-path, dir]}.
 *
 * ── Sections ────────────────────────────────────────────────────────────────
 *
 *   §1  isolation — real credential AND real claude_desktop_config fingerprints
 *   §2  the repo arm is unchanged (three proofs, above)
 *   §3  the bundle arm — exact emitted entry, in a CHILD PROCESS against a
 *       materialised bundle-shaped tree, never a stub alone
 *   §4  shim generation — contents, mode, idempotence, quoting
 *   §5  the ephemeral refusals FIRE and write NOTHING
 *   §6  the shim is never written under getDomainsDir()
 *   §7  staleness — the reading that dropping the path argument depends on
 *   §8  the config writer — three input states, the parse_error refusal, other
 *       servers preserved, the .bak, and the launcher-missing refusal
 *   §9  route files enumerated FROM DISK — no route branches on install form
 *   §10 anti-vacuity controls + what is NOT enforced
 *
 * NOTHING here writes to the user's real claude_desktop_config.json. The path
 * is a module constant with no override seam, so every write test injects a
 * `configPath` in a tempdir through the handler's `deps` seam, and §1
 * fingerprints the real file (sha256 + size + existence, never mtime) and
 * re-checks it at the end.
 *
 * Dependency-free beyond what the app already ships. No network, no API key,
 * no writes outside os.tmpdir().
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const same = actual === expected;
  ok(same, `${label}${same ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`);
}
function deepEq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  ok(same, `${label}${same ? '' : `\n        a: ${JSON.stringify(a)}\n        b: ${JSON.stringify(b)}`}`);
}
function section(t) { console.log(`\n${t}`); }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = s => createHash('sha256').update(s).digest('hex');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Isolation — no real credential, and no real Claude Desktop config');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-mcplauncher-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
const TMP_LAUNCHER = path.join(TMP, 'launcherbin');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(TMP_DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
process.env.CURATOR_TEST_MCP_LAUNCHER_DIR = TMP_LAUNCHER;

// sha256 + size + existence ONLY. mtime makes this fail whenever the
// maintainer's live app rewrites config during an ordinary Settings action —
// the false "isolation is broken" that cost two investigations in v3.0.16.
function fingerprint(p) {
  try {
    const buf = fs.readFileSync(p);
    return `${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  } catch { return 'ABSENT'; }
}
const WATCHED = [
  path.join(ROOT, '.curator-config.json'),
  path.join(ROOT, '.sync-config.json'),
  path.join(ROOT, '.sharedbrain-config.json'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
];
const BEFORE = WATCHED.map(fingerprint);
ok(true, `fingerprinted ${WATCHED.length} real files (config x3 + the REAL claude_desktop_config.json)`);

const routes = await import('../src/routes/mcp.js');
const launcher = await import('../src/brain/mcp-launcher.js');
const paths = await import('../src/brain/paths.js');
const installMode = await import('../src/brain/install-mode.js');

eq(installMode.getInstallMode(), 'repo', 'THIS checkout is repo mode — so §2 exercises the arm that must not change');

// ═══════════════════════════════════════════════════════════════════════════
section('§2  THE REPO ARM IS UNCHANGED — three independent proofs');
// ═══════════════════════════════════════════════════════════════════════════

const headRouteSrc = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:src/routes/mcp.js'], { encoding: 'utf8' });
const workRouteSrc = read('src/routes/mcp.js');

// ── §2a TEXT ────────────────────────────────────────────────────────────────
// The repo arm's return statement, transcribed here as a LITERAL rather than
// read out of either file — a check whose expectation comes from the same
// source it is checking cannot fail.
const REPO_ARM_RETURN = [
  '  return {',
  '    command: process.execPath,',
  "    args: [MCP_SERVER_PATH, '--domains-path', domainsDir],",
  '  };',
].join('\n');
ok(headRouteSrc.includes(REPO_ARM_RETURN), '§2a HEAD contains the transcribed repo-arm return statement');
ok(workRouteSrc.includes(REPO_ARM_RETURN), '§2a the working tree contains it too, BYTE-IDENTICALLY');
eq(sha(REPO_ARM_RETURN), sha(REPO_ARM_RETURN), '§2a (control) sha of an identical string matches itself');
ok(sha(REPO_ARM_RETURN) !== sha(REPO_ARM_RETURN.replace('execPath', 'execpath')),
  '§2a CONTROL: flipping one character in the transcribed arm changes its sha256');
// Exactly one occurrence in each — a second copy is the drift this file's own
// docblock says must never exist.
eq((workRouteSrc.match(/args: \[MCP_SERVER_PATH, '--domains-path', domainsDir\]/g) || []).length, 1,
  '§2a exactly ONE construction of the repo-arm args array survives');

// ── §2b BEHAVIOUR through a sandbox ─────────────────────────────────────────
// Extract the whole function from both revisions and RUN them. A text proof
// says the literal is present; only execution says the arm is still reached.
function extractFn(src, name) {
  const start = src.indexOf(`export function ${name}(`);
  if (start === -1) return null;
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1).replace(/^export /, ''); }
  }
  return null;
}
const headFn = extractFn(headRouteSrc, 'buildCuratorEntry');
const workFn = extractFn(workRouteSrc, 'buildCuratorEntry');
ok(!!headFn && !!workFn, '§2b extracted buildCuratorEntry from BOTH revisions');

const FAKE_SERVER_PATH = '/Apps/The Curator/mcp/server.js';
const FAKE_EXEC = '/opt/homebrew/bin/node';
function compile(fnSrc, launchStyle, launcherPath) {
  // eslint-disable-next-line no-new-func
  return new Function('MCP_SERVER_PATH', 'process', 'getCapabilities', 'getMcpLauncherPath',
    `${fnSrc}; return buildCuratorEntry;`
  )(FAKE_SERVER_PATH, { execPath: FAKE_EXEC }, () => ({ mcpLaunchStyle: launchStyle }), () => launcherPath);
}
const headBuild = compile(headFn, 'node-script', '/unused');
const workBuildRepo = compile(workFn, 'node-script', '/unused');
const workBuildBundle = compile(workFn, 'launcher-script', '/Users/x/Library/Application Support/The Curator/bin/my-curator-mcp');

const INPUT_MATRIX = [
  '/Users/x/second-brain/domains',
  '/Users/x/My Drive/The Curator/domains',      // spaces
  '/Users/x/ünïcode/domains',                    // non-ascii
  '',                                            // degenerate
  '/',
];
let allSame = true;
for (const d of INPUT_MATRIX) {
  const a = headBuild(d), b = workBuildRepo(d);
  if (JSON.stringify(a) !== JSON.stringify(b)) allSame = false;
}
ok(allSame, `§2b HEAD and HEAD+change agree on ALL ${INPUT_MATRIX.length} inputs with the capability at 'node-script'`);
deepEq(workBuildRepo(INPUT_MATRIX[0]),
  { command: FAKE_EXEC, args: [FAKE_SERVER_PATH, '--domains-path', INPUT_MATRIX[0]] },
  '§2b the repo arm still emits {node, [server.js, --domains-path, dir]}');

// The control that stops §2b being vacuous: if the two arms produced the same
// thing, "they agree" would be true no matter what the branch did.
let differs = false;
for (const d of INPUT_MATRIX) {
  if (JSON.stringify(headBuild(d)) !== JSON.stringify(workBuildBundle(d))) differs = true;
}
ok(differs, '§2b CONTROL: with the capability flipped to launcher-script the two DISAGREE (so the agreement above is not vacuous)');

// ── §2c LIVE ────────────────────────────────────────────────────────────────
const liveEntry = routes.buildCuratorEntry('/tmp/some/domains');
eq(liveEntry.command, process.execPath, '§2c live: command is the running node binary');
eq(liveEntry.args.length, 3, '§2c live: three args');
eq(liveEntry.args[1], '--domains-path', '§2c live: the path argument is still passed in repo mode');
eq(liveEntry.args[2], '/tmp/some/domains', '§2c live: args[2] is the domains dir');
// Guarded rather than indexed. A mutation that empties `args` must red with a
// NAMED assertion, not a TypeError — a crash leaves the tally wrong and names
// no expectation (the v3.24.1 shape, closed here rather than filed).
ok(typeof liveEntry.args[0] === 'string' && liveEntry.args[0].endsWith(path.join('mcp', 'server.js')),
  '§2c live: args[0] is mcp/server.js');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  The BUNDLE arm — driven in a child process, not only in a stub');
// ═══════════════════════════════════════════════════════════════════════════

// APP_ROOT is fixed at module load, so the only honest way to reach the bundle
// arm is to materialise the tree at a *.app/Contents/... path and import from
// THERE. Technique from test-paths.js §2 / test-install-mode.js §3.
function findNodeModules(from) {
  let d = from;
  for (let i = 0; i < 12; i++) {
    const c = path.join(d, 'node_modules');
    if (fs.existsSync(c)) return c;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function materialise(dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('/bin/sh', ['-c',
    `git -C ${JSON.stringify(ROOT)} archive HEAD | tar -x -C ${JSON.stringify(dest)}`]);
  // Overlay the working-tree versions of everything this change touches — the
  // archive is HEAD, and HEAD does not have the fork yet.
  for (const rel of ['src/routes/mcp.js', 'src/brain/mcp-launcher.js', 'src/brain/paths.js', 'src/brain/install-mode.js']) {
    fs.mkdirSync(path.join(dest, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), read(rel));
  }
  // express et al. — `git archive` carries no node_modules, and in a git
  // WORKTREE there isn't one beside the checkout either (node resolves it by
  // walking up to the main repo root), so it is located rather than assumed.
  const nm = findNodeModules(ROOT);
  if (nm) { try { fs.symlinkSync(nm, path.join(dest, 'node_modules')); } catch {} }
  return dest;
}

const fakeHome = path.join(TMP, 'home');
fs.mkdirSync(fakeHome, { recursive: true });
const bundleTree = materialise(path.join(TMP, 'The Curator.app', 'Contents', 'Resources'));

function probeBundleEntry(appRoot, home, extraEnv = {}) {
  const script = `
    const m = await import(${JSON.stringify('file://' + path.join(appRoot, 'src/routes/mcp.js'))});
    const im = await import(${JSON.stringify('file://' + path.join(appRoot, 'src/brain/install-mode.js'))});
    process.stdout.write(JSON.stringify({
      mode: im.getInstallMode(),
      style: im.getCapabilities().mcpLaunchStyle,
      entry: m.buildCuratorEntry('/some/where/domains'),
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env, HOME: home,
      CURATOR_TEST_USER_DATA_DIR: '', CURATOR_TEST_DOMAINS_DIR: '', CURATOR_TEST_MCP_LAUNCHER_DIR: '',
      ...extraEnv,
    },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],   // swallow the bundle-mode stderr notice
  });
  return JSON.parse(out);
}

const bundleProbe = probeBundleEntry(bundleTree, fakeHome);
eq(bundleProbe.mode, 'bundle', 'a *.app/Contents/... layout really is bundle mode');
eq(bundleProbe.style, 'launcher-script', 'and its capability really is launcher-script');
eq(bundleProbe.entry.command,
  path.join(fakeHome, 'Library', 'Application Support', 'The Curator', 'bin', 'my-curator-mcp'),
  'BUNDLE ARM: command is the launcher shim under Application Support/The Curator/bin');
deepEq(bundleProbe.entry.args, [], 'BUNDLE ARM: args is EMPTY');
ok(!JSON.stringify(bundleProbe.entry).includes('--domains-path'),
  'BUNDLE ARM: the domains-path argument is ABSENT (it outranks the live Settings choice — see the route docblock)');
ok(!JSON.stringify(bundleProbe.entry).includes('server.js'),
  'BUNDLE ARM: no path into the app tree is emitted (mcp/server.js would be inside an asar)');
eq(bundleProbe.entry.command.includes('.app/Contents'), false,
  'BUNDLE ARM: the emitted command does NOT point inside the bundle');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  Shim generation — contents, mode, idempotence, quoting');
// ═══════════════════════════════════════════════════════════════════════════

// Repo mode: a NO-OP that touches nothing. This is the claim that makes the
// whole change a no-op for every user today.
const shimDirBefore = fs.existsSync(TMP_LAUNCHER);
const noop = launcher.ensureMcpLauncherShim();
eq(noop.reason, 'not-needed', 'repo mode: ensureMcpLauncherShim() is a no-op');
eq(noop.written, false, 'repo mode: nothing written');
eq(noop.path, null, 'repo mode: no path is even resolved');
eq(fs.existsSync(TMP_LAUNCHER), shimDirBefore, 'repo mode: the launcher directory is not created');

const SHIM = path.join(TMP_LAUNCHER, 'my-curator-mcp');
const BUNDLE_EXEC = '/Applications/The Curator.app/Contents/MacOS/The Curator';
const UNPACKED = '/Applications/The Curator.app/Contents/Resources/app.asar.unpacked/mcp/server.js';
const goodOpts = {
  launchStyle: 'launcher-script',
  launcherPath: SHIM,
  execPath: BUNDLE_EXEC,
  homeDir: fakeHome,
  serverPath: UNPACKED,
  domainsDir: TMP_DOMAINS,
};

const w1 = launcher.ensureMcpLauncherShim(goodOpts);
eq(w1.reason, 'written', 'bundle mode: the shim is written');
eq(w1.written, true, 'bundle mode: written === true');
ok(fs.existsSync(SHIM), 'the shim exists on disk');
const shimText = fs.readFileSync(SHIM, 'utf8');
ok(shimText.startsWith('#!/bin/sh\n'), 'the shim is a /bin/sh script');
ok(shimText.includes('ELECTRON_RUN_AS_NODE=1'), 'the shim sets ELECTRON_RUN_AS_NODE=1 (otherwise it launches a second copy of the app)');
ok(shimText.includes(`'${BUNDLE_EXEC}'`), 'the shim names the ABSOLUTE app binary path, single-quoted (the real path always has a space in it)');
ok(shimText.includes(`'${UNPACKED}'`), 'the shim names the unpacked mcp/server.js path');
ok(/\bexec\b/.test(shimText), 'the shim uses exec — no shell left between Claude Desktop and the MCP child');
ok(shimText.includes('"$@"'), 'the shim forwards its arguments');
ok(!shimText.includes('--domains-path'), 'the shim does NOT inject the domains-path argument either');
eq((fs.statSync(SHIM).mode & 0o777), 0o700, 'the shim is 0700');
eq((fs.statSync(TMP_LAUNCHER).mode & 0o777), 0o700, 'the launcher directory is 0700');

const w2 = launcher.ensureMcpLauncherShim(goodOpts);
eq(w2.reason, 'unchanged', 'a second identical launch does NOT rewrite the shim');
eq(w2.written, false, 'idempotent: written === false the second time');

// The app moved. The whole reason generation happens at launch.
const MOVED_EXEC = '/Users/x/Applications/The Curator.app/Contents/MacOS/The Curator';
const w3 = launcher.ensureMcpLauncherShim({ ...goodOpts, execPath: MOVED_EXEC });
eq(w3.reason, 'written', 'a MOVED app binary rewrites the shim');
ok(fs.readFileSync(SHIM, 'utf8').includes(`'${MOVED_EXEC}'`), 'the rewritten shim names the NEW binary path');
ok(!fs.readFileSync(SHIM, 'utf8').includes(`'${BUNDLE_EXEC}'`), 'and no longer names the old one');

// POSIX single-quote escaping. A path containing a quote is pathological but
// legal, and an unescaped one turns the shim into arbitrary shell.
const nasty = "/Apps/it's a trap'; echo PWNED; echo '/The Curator";
const script = launcher.buildLauncherScript(nasty, '/x/server.js');
ok(script.includes(`'\\''`), "a single quote in a path is escaped as the POSIX '\\'' form");
// ROUND-TRIP through the real /bin/sh, which is the only honest proof that the
// escaping holds. The payload is a harmless `echo PWNED` rather than anything
// destructive, precisely because the point of the test is that it MIGHT run.
const execLine = script.split('\n').find(l => l.startsWith('exec ')) || '';
const quotedMatch = execLine.match(/ELECTRON_RUN_AS_NODE=1 (.+) '\/x\/server\.js'/);
ok(!!quotedMatch, 'the shim carries a recognisable exec line (guarded — a shape change must red by NAME, not by TypeError)');
if (quotedMatch) {
  // Broken quoting makes /bin/sh EXIT NONZERO on a syntax error, which
  // execFileSync raises — so the throw is itself the finding and must be
  // reported as one rather than killing the run.
  let roundTrip = null, shellError = null;
  try { roundTrip = execFileSync('/bin/sh', ['-c', `printf '%s' ${quotedMatch[1]}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { shellError = e.message; }
  eq(roundTrip, nasty, `a path containing a single quote round-trips through /bin/sh EXACTLY${shellError ? ' (/bin/sh refused the line — the quoting is broken)' : ''}`);
  ok(roundTrip !== null && !/^PWNED/m.test(roundTrip), 'the injected command cannot escape the quoting');
} else {
  failed += 2; console.log('  ✗ (2 quoting assertions skipped — the exec line could not be parsed)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Ephemeral locations — the refusals fire and write NOTHING');
// ═══════════════════════════════════════════════════════════════════════════

// classifyLaunchOrigin is fully parameterised, so every branch is reachable
// without pretending to be a translocated app.
const TRANSLOCATED = '/private/var/folders/kq/xxxx/T/AppTranslocation/8B2C/d/The Curator.app/Contents/MacOS/The Curator';
const DOWNLOADED = path.join(fakeHome, 'Downloads', 'The Curator.app', 'Contents', 'MacOS', 'The Curator');
const DOWNLOADS_CASE = path.join(fakeHome, 'downloads', 'The Curator.app', 'Contents', 'MacOS', 'The Curator');

eq(launcher.classifyLaunchOrigin(TRANSLOCATED, fakeHome).reason, 'app-translocation', 'App Translocation is detected');
eq(launcher.classifyLaunchOrigin(DOWNLOADED, fakeHome).reason, 'downloads-folder', '~/Downloads is detected');
eq(launcher.classifyLaunchOrigin(DOWNLOADS_CASE, fakeHome).reason, 'downloads-folder',
  '~/downloads is detected too — APFS is case-insensitive by default, so a case-sensitive check could be walked past');
eq(launcher.classifyLaunchOrigin('', fakeHome).reason, 'no-exec-path', 'an empty execPath is refused rather than assumed fine');
eq(launcher.classifyLaunchOrigin(BUNDLE_EXEC, fakeHome).ephemeral, false, '/Applications is NOT ephemeral');
eq(launcher.classifyLaunchOrigin(path.join(fakeHome, 'Documents', 'x.app', 'Contents', 'MacOS', 'x'), fakeHome).ephemeral, false,
  'CONTROL: ~/Documents is not refused — only the two named locations are');
eq(launcher.classifyLaunchOrigin('/Apps/AppTranslocation Notes/The Curator.app/Contents/MacOS/x', fakeHome).ephemeral, false,
  'CONTROL: a directory merely NAMED "AppTranslocation Notes" is not a translocation mount (matched as a path component, not a substring)');

for (const [label, exec] of [['translocated', TRANSLOCATED], ['downloads', DOWNLOADED], ['no-exec-path', '']]) {
  const dir = path.join(TMP, 'refuse-' + label.replace(/[^a-z]/g, ''));
  const target = path.join(dir, 'my-curator-mcp');
  const r = launcher.ensureMcpLauncherShim({ ...goodOpts, launcherPath: target, execPath: exec });
  eq(r.ok, false, `${label}: refused`);
  eq(r.written, false, `${label}: written === false`);
  ok(/\/Applications/.test(r.message || ''), `${label}: the message NAMES THE FIX (move it to /Applications)`);
  eq(fs.existsSync(dir), false, `${label}: WROTE NOTHING — the directory was not even created`);
}

// A refusal must not destroy a shim an earlier, healthy launch wrote. An old
// but valid shim is more useful than none.
const survivorBefore = fs.readFileSync(SHIM, 'utf8');
const r4 = launcher.ensureMcpLauncherShim({ ...goodOpts, execPath: TRANSLOCATED });
eq(r4.written, false, 'a refusal against an EXISTING shim still writes nothing');
eq(fs.readFileSync(SHIM, 'utf8'), survivorBefore, 'and leaves the previously-written shim byte-identical');

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The shim is NEVER written under getDomainsDir()');
// ═══════════════════════════════════════════════════════════════════════════

// Reachable, not theoretical: domainsPath is user-settable, and this project
// has shipped machine-local files into the synced git work-tree twice
// (.DS_Store v3.0.16, .write-lock v3.0.15).
const insideDomains = path.join(TMP_DOMAINS, 'bin', 'my-curator-mcp');
const r5 = launcher.ensureMcpLauncherShim({ ...goodOpts, launcherPath: insideDomains, domainsDir: TMP_DOMAINS });
eq(r5.ok, false, 'a launcher path INSIDE the domains dir is refused');
eq(r5.reason, 'inside-domains', 'refusal reason names it');
eq(fs.existsSync(path.dirname(insideDomains)), false, 'and nothing was created there');
ok(/Personal Sync|push/i.test(r5.message || ''), 'the message explains WHY (Personal Sync commits and pushes that tree)');

// Same directory, one level up — the exact-match case, not just the descendant.
const atDomainsRoot = path.join(TMP_DOMAINS, 'my-curator-mcp');
eq(launcher.ensureMcpLauncherShim({ ...goodOpts, launcherPath: atDomainsRoot, domainsDir: TMP_DOMAINS }).reason,
  'inside-domains', 'a launcher directly IN the domains dir is refused too');

// CONTROL: the default resolved location is not inside the domains dir, so the
// guard is not simply refusing everything.
// (execPath: MOVED_EXEC because §4's last write left the shim naming that one —
// so this control proves the guard lets a legitimate path through untouched.)
eq(launcher.ensureMcpLauncherShim({ ...goodOpts, execPath: MOVED_EXEC, launcherPath: SHIM, domainsDir: TMP_DOMAINS }).reason,
  'unchanged', 'CONTROL: the real launcher location is NOT inside the domains dir and still succeeds');
ok(!launcher.isInside(paths.getMcpLauncherDir(), TMP_DOMAINS),
  'CONTROL: getMcpLauncherDir() resolves outside the domains dir');

// And the resolver itself: anchored on Application Support, never on the
// user-data dir (which in repo mode IS the checkout).
process.env.CURATOR_TEST_MCP_LAUNCHER_DIR = '';
delete process.env.CURATOR_TEST_MCP_LAUNCHER_DIR;
eq(paths.getMcpLauncherDir(), path.join(paths.getAppSupportDir(), 'bin'),
  'getMcpLauncherDir() is <Application Support>/The Curator/bin in BOTH install modes');
ok(!launcher.isInside(paths.getMcpLauncherDir(), paths.APP_ROOT),
  'the launcher dir is never inside APP_ROOT — a generated executable must not land in the checkout');
process.env.CURATOR_TEST_MCP_LAUNCHER_DIR = TMP_LAUNCHER;

// ═══════════════════════════════════════════════════════════════════════════
section('§7  Staleness — the reading the dropped path argument depends on');
// ═══════════════════════════════════════════════════════════════════════════

// GET /config computes `stale` by comparing entry.command and
// JSON.stringify(entry.args) against a freshly built entry. Reproduced here
// verbatim, so the claim "nothing left to go stale in bundle mode" is tested
// rather than asserted in prose.
const staleOf = (entry, fresh) =>
  !(entry.command === fresh.command && JSON.stringify(entry.args) === JSON.stringify(fresh.args));

const repoOld = workBuildRepo('/old/domains');
const repoNew = workBuildRepo('/new/domains');
eq(staleOf(repoOld, repoNew), true, 'REPO: moving the knowledge base makes the stored entry stale (unchanged behaviour — the wizard must be re-run)');
eq(staleOf(repoNew, repoNew), false, 'REPO: an unmoved folder is not stale');

const bundleOld = workBuildBundle('/old/domains');
const bundleNew = workBuildBundle('/new/domains');
eq(staleOf(bundleOld, bundleNew), false,
  'BUNDLE: moving the knowledge base does NOT make the entry stale — nothing folder-dependent is in it');
deepEq(bundleOld, bundleNew, 'BUNDLE: the entry is literally identical across two different domains dirs');

// ═══════════════════════════════════════════════════════════════════════════
section('§8  The config writer — the three input states, and what it refuses');
// ═══════════════════════════════════════════════════════════════════════════

// Never `JSON.parse` a value a mutation could turn into null — that is a crash
// with no assertion name attached.
function safeParse(t) { try { return JSON.parse(t); } catch { return {}; } }

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// A fixture carrying SEVERAL other MCP servers, plus a top-level key that is
// not mcpServers — the exact shape whose loss the corrupt-file refusal exists
// to prevent.
const OTHERS = {
  globalShortcut: 'Cmd+Shift+Space',
  mcpServers: {
    filesystem: { command: '/usr/local/bin/node', args: ['/srv/fs.js'] },
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    postgres: { command: 'uvx', args: ['mcp-server-postgres'] },
    'my-curator': { command: '/old/node', args: ['/old/mcp/server.js', '--domains-path', '/old/domains'] },
  },
};

async function runWrite(fixtureText, opts = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'claudecfg-'));
  const cfgPath = path.join(dir, 'claude_desktop_config.json');
  if (fixtureText !== null) fs.writeFileSync(cfgPath, fixtureText);
  const res = fakeRes();
  await routes.writeConfigHandler({}, res, { configPath: cfgPath, ...opts });
  return {
    res, cfgPath, dir,
    after: fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : null,
    bak: fs.existsSync(cfgPath + '.bak') ? fs.readFileSync(cfgPath + '.bak', 'utf8') : null,
  };
}

// --- STATE 1: absent -------------------------------------------------------
const absent = await runWrite(null);
eq(absent.res.statusCode, 200, 'ABSENT: 200');
eq(absent.res.body.ok, true, 'ABSENT: ok');
eq(absent.res.body.created, true, 'ABSENT: reported as created');
eq(absent.res.body.backup_path, null, 'ABSENT: no .bak — there was nothing to back up');
deepEq(Object.keys(safeParse(absent.after).mcpServers || {}), ['my-curator'], 'ABSENT: the file now holds exactly our entry');
eq(absent.bak, null, 'ABSENT: no .bak file on disk');

// --- STATE 2: readable, with other servers ---------------------------------
const readableText = JSON.stringify(OTHERS, null, 2);
const readable = await runWrite(readableText);
eq(readable.res.statusCode, 200, 'READABLE: 200');
eq(readable.res.body.created, false, 'READABLE: reported as replaced, not created');
const afterObj = safeParse(readable.after);
deepEq(Object.keys(afterObj.mcpServers).sort(), ['filesystem', 'github', 'my-curator', 'postgres'],
  'READABLE: all FOUR servers present — the three others are preserved');
deepEq(afterObj.mcpServers.filesystem, OTHERS.mcpServers.filesystem, 'READABLE: another server is byte-for-byte unchanged');
deepEq(afterObj.mcpServers.github, OTHERS.mcpServers.github, 'READABLE: and another');
deepEq(afterObj.mcpServers.postgres, OTHERS.mcpServers.postgres, 'READABLE: and the third');
eq(afterObj.globalShortcut, 'Cmd+Shift+Space', 'READABLE: a NON-mcpServers top-level key survives');
deepEq(afterObj.mcpServers['my-curator'], routes.buildCuratorEntry(TMP_DOMAINS), 'READABLE: our entry is the freshly built one');
eq(readable.bak, readableText, 'READABLE: the .bak holds the ORIGINAL BYTES, not a re-serialisation');
deepEq(readable.res.body.preserved_servers.sort(), ['filesystem', 'github', 'postgres'],
  'READABLE: the response NAMES the servers it preserved rather than asking the user to trust it');
eq(readable.res.body.restart_required, true, 'READABLE: the response says Claude Desktop must be restarted');

// --- STATE 3: corrupt — THE REFUSAL ----------------------------------------
const corruptText = '{\n  "mcpServers": {\n    "filesystem": { "command": "node" },,\n  }\n}';
const corrupt = await runWrite(corruptText);
eq(corrupt.res.statusCode, 409, 'CORRUPT: 409, not a silent success');
eq(corrupt.res.body.ok, false, 'CORRUPT: ok === false');
eq(corrupt.res.body.refused, 'claude_config_parse_error', 'CORRUPT: machine-readable refusal code');
eq(corrupt.res.body.written, false, 'CORRUPT: written === false');
eq(corrupt.after, corruptText, 'CORRUPT: the file is BYTE-IDENTICAL — nothing was written');
eq(corrupt.bak, null, 'CORRUPT: not even a .bak was created');
ok(/other MCP servers/i.test(corrupt.res.body.error), 'CORRUPT: the message explains the harm it is avoiding');

// The same decision, reachable without any filesystem at all.
eq(routes.planConfigWrite({ __parseError: true }, '/d').ok, false, 'planConfigWrite refuses the parse-error sentinel');
eq(routes.planConfigWrite({ __parseError: true }, '/d').refused, 'claude_config_parse_error', 'with the same code');
ok(routes.planConfigWrite(OTHERS, '/d').ok, 'CONTROL: planConfigWrite accepts a readable config (the refusal is not unconditional)');
eq(Object.keys(routes.planConfigWrite(OTHERS, '/d').next.mcpServers).length, 4, 'CONTROL: and its plan keeps all four servers');

// --- The launcher-missing refusal ------------------------------------------
const noLauncher = await runWrite(readableText, {
  launcherState: { required: true, present: false, path: '/nope/my-curator-mcp', message: 'The launcher is missing.' },
});
eq(noLauncher.res.statusCode, 409, 'LAUNCHER MISSING: 409');
eq(noLauncher.res.body.refused, 'launcher_missing', 'LAUNCHER MISSING: named refusal');
eq(noLauncher.after, readableText, 'LAUNCHER MISSING: the config is untouched — a working entry is not replaced by a broken one');
eq(noLauncher.bak, null, 'LAUNCHER MISSING: no .bak either');
ok(routes.planConfigWrite(OTHERS, '/d', { required: true, present: true }).ok,
  'CONTROL: a PRESENT launcher does not refuse');
ok(routes.planConfigWrite(OTHERS, '/d', { required: false, present: true }).ok,
  'CONTROL: repo mode (launcher not required) does not refuse');

// --- Nothing may invoke this automatically ---------------------------------
// It writes ANOTHER APPLICATION's config. It is reachable only from an
// explicit user action; a poll or a page load must never reach it.
const frontendFiles = fs.readdirSync(path.join(ROOT, 'src/public/next/views'))
  .filter(f => f.endsWith('.js'));
ok(frontendFiles.length >= 5, `enumerated ${frontendFiles.length} view files from disk`);
eq((workRouteSrc.match(/router\.post\('\/write-config'/g) || []).length, 1,
  'the writer is registered exactly ONCE, as a POST');
ok(!/router\.get\([^)]*write-config/.test(workRouteSrc),
  'it is not also reachable as a GET (a GET is what a poll or a prefetch would issue)');

// ═══════════════════════════════════════════════════════════════════════════
section('§9  Route files ENUMERATED FROM DISK — no route branches on the FORM');
// ═══════════════════════════════════════════════════════════════════════════

const routeFiles = fs.readdirSync(path.join(ROOT, 'src/routes')).filter(f => f.endsWith('.js')).sort();
ok(routeFiles.length >= 10, `enumerated ${routeFiles.length} route files from disk (never a literal list)`);
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const MODE_BRANCH = /getInstallMode\s*\(\s*\)\s*[!=]==?\s*|isRepoInstall\s*\(|isBundleInstall\s*\(/;
for (const f of routeFiles) {
  ok(!MODE_BRANCH.test(stripComments(read(path.join('src/routes', f)))),
    `src/routes/${f} branches on the CAPABILITY, never on the install form`);
}
ok(MODE_BRANCH.test('if (isBundleInstall()) {}'), 'CONTROL: the mode-branch detector fires on a planted call');
ok(!MODE_BRANCH.test("if (getCapabilities().mcpLaunchStyle === 'launcher-script') {}"),
  'CONTROL: it does NOT fire on correct capability-branching');
ok(/getCapabilities\(\)\.mcpLaunchStyle/.test(stripComments(workRouteSrc)),
  'src/routes/mcp.js does fork on mcpLaunchStyle — the capability v3.26.0 shipped with no branch behind it');

// The brain module may read the mode's capability, but must not read the FORM.
ok(!MODE_BRANCH.test(stripComments(read('src/brain/mcp-launcher.js'))),
  'src/brain/mcp-launcher.js reads the capability too, never isBundleInstall()');

// paths.js's new getter must be a PURE resolver — the per-call-resolution rule.
const pathsSrc = stripComments(read('src/brain/paths.js'));
const launcherGetter = pathsSrc.slice(pathsSrc.indexOf('export function getMcpLauncherDir'));
const getterBody = launcherGetter.slice(0, launcherGetter.indexOf('\n}'));
ok(!/mkdirSync|writeFileSync|chmodSync/.test(getterBody), 'getMcpLauncherDir() creates nothing and writes nothing');
ok(!/const\s+\w+\s*=\s*getMcpLauncherDir\(\)/.test(read('src/brain/mcp-launcher.js')),
  'no module-level snapshot of getMcpLauncherDir() — that would defeat both test seams');

// ═══════════════════════════════════════════════════════════════════════════
section('§10  Anti-vacuity + isolation re-check');
// ═══════════════════════════════════════════════════════════════════════════

// If the extractor silently stopped matching, §2b would report agreement
// forever. Prove it can see a difference.
const sabotaged = compile(workFn.replace("'--domains-path'", "'--domains'"), 'node-script', '/unused');
ok(JSON.stringify(sabotaged('/d')) !== JSON.stringify(headBuild('/d')),
  'CONTROL: the sandbox comparison DOES detect a one-token change to the repo arm');
ok(extractFn('export function nothingHere() { return 1; }', 'buildCuratorEntry') === null,
  'CONTROL: the extractor returns null rather than a false positive when the function is absent');

const AFTER = WATCHED.map(fingerprint);
for (let i = 0; i < WATCHED.length; i++) {
  eq(AFTER[i], BEFORE[i], `real file untouched: ${path.basename(WATCHED[i])} (sha256 + size + existence)`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

/*
 * ── WHAT THIS SUITE DOES **NOT** ENFORCE ────────────────────────────────────
 *
 * 1. THE BUNDLE ARM IS NEVER RUN END TO END, because no bundle exists. §3
 *    materialises a *.app/Contents/Resources tree and drives the REAL
 *    buildCuratorEntry in a child process, which proves the fork, the paths
 *    and the emitted entry — but there is no Electron binary, no asar, and no
 *    Claude Desktop. That the shim actually STARTS an MCP server under
 *    ELECTRON_RUN_AS_NODE is unproven and unprovable here.
 * 2. THE SHIM IS NEVER EXECUTED. Its contents are asserted as text; nothing
 *    runs `/bin/sh` against it. Executing a generated script in a test would
 *    need a fake node on PATH and buys little over the text assertions.
 * 3. TRANSLOCATION IS SIMULATED BY A PATH STRING. Real App Translocation
 *    cannot be produced in a test; the classifier is parameterised so every
 *    branch is reachable, and that is the seam, not the phenomenon.
 * 4. NOTHING PROVES CLAUDE DESKTOP ACCEPTS THE ENTRY. The shape matches what
 *    the wizard has always emitted, and the self-test spawns it — but the
 *    self-test spawns the REPO form, and the bundle form has no self-test
 *    because there is no bundle to run it from.
 * 5. §9's mode-branch scan is TEXTUAL, inherited from test-install-mode.js
 *    §4 along with its blind spots: a computed `caps[someVar]` fork is
 *    invisible, and so is an aliased import.
 * 6. THE WRITER'S CONCURRENCY IS NOT ADDRESSED. Claude Desktop can itself
 *    rewrite claude_desktop_config.json (newer versions edit it when
 *    connectors are toggled). A write that lands between our read and our
 *    write is lost, mitigated only by the .bak. This is an explicit user
 *    action taken while the user is looking at the wizard, so the window is
 *    small, but it is a window.
 * 7. NO UI IS ASSERTED. POST /write-config has no frontend caller yet; the
 *    MCP wizard (src/public/next/views/mcp-wizard.js) is where it belongs,
 *    and that file was outside this change's scope.
 */

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
