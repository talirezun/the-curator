#!/usr/bin/env node
/**
 * test-release-preconditions.js — OFFLINE suite over `scripts/release.js`.
 *
 * ── WHAT IS BEING GUARDED, AND WHY IT NEEDS A GUARD AT ALL ────────────────
 * `main` has no branch protection and no rulesets (verified: the protection
 * endpoint 404s with "Branch not protected" and the rulesets endpoint returns
 * `[]`), and the in-app auto-updater does `git reset --hard origin/main`. So a
 * push to `main` IS the deploy, and `scripts/release.js` is the ONLY gate
 * between a broken tree and every user's machine. A refusal in that script
 * that has quietly stopped refusing is therefore not a test-coverage gap — it
 * is the deploy gate silently open.
 *
 * `release.js` gates through a RELEASE BRANCH: it pushes `release/vX.Y.Z`,
 * waits for that branch's CI run, and fast-forwards `main` onto it only when
 * the run is green. §7 is built around the one property that whole design
 * exists to provide, and it is stated as an ABSENCE rather than a recovery:
 * **a red gate must issue no `switch main`, no `merge`, no `push origin main`
 * and no tag at all.** Not "roll main back" — never touch it. §7 also pins
 * that an UNOBSERVABLE gate fails CLOSED, which is the property the old
 * push-to-main-then-watch shape could not have: an unknown outcome used to
 * mean "already deployed, go look" and now means "not deployed, go look".
 *
 * This suite drives the real `release()` — never a re-implementation — through
 * an INJECTED seam, once per refusal, and asserts the refusal FIRES and NAMES
 * ITSELF. §8 then closes the loop: every id declared in `REFUSALS` must have
 * been produced by some scenario in this file. Delete a precondition and two
 * things go red — the scenario that expected it, and the coverage assertion
 * that names the now-unreachable id.
 *
 * §2 additionally reads the REAL `.github/workflows/test.yml` — the only file
 * on disk this suite reads rather than fixtures — because the gate is worth
 * nothing if the workflow would not run on a release branch. That failure mode
 * is the dangerous kind: it does not break loudly, it produces no run at all.
 *
 * ── NEVER THE REAL THING ──────────────────────────────────────────────────
 * A test that actually pushed or tagged would be a catastrophe, so this is
 * enforced by mechanism rather than by discipline:
 *
 *   1. Every call injects `deps`, whose `run` RECORDS argv and executes
 *      nothing. No child process is ever spawned by this suite.
 *   2. `CURATOR_RELEASE_TEST=1` is set for this whole process, and
 *      `release()` THROWS when `deps` is null under that flag. A call site
 *      that forgets to inject cannot fall through to real git — §0 proves the
 *      throw fires, so this is a live mechanism and not a comment.
 *   3. §0 also asserts every command the script issued went through the fake
 *      (recorded count === fake invocation count), so a code path that reached
 *      `child_process` directly would show up as a gap.
 *   4. The filesystem is virtual too: `readFile`/`writeFile`/`exists` are
 *      injected over an in-memory map, so nothing in the real repo is read as
 *      state or written at all.
 *
 * ── BEHAVIOUR, NOT SOURCE ─────────────────────────────────────────────────
 * v3.0.17 records a suite that asserted a CALL SITE with a source regex while
 * the value that call site reported was always wrong. Nothing here asserts
 * that a line of `release.js` exists. Every assertion runs `release()` and
 * reads what it returned, what it recorded, and what it wrote.
 *
 * ── NOT ENFORCED (stated so a green run is not over-read) ─────────────────
 *   • Real `git`, `npm` and `gh` behaviour. The fake returns canned output, so
 *     this suite cannot prove that `npm version --no-git-tag-version` really
 *     updates both lock fields on a dirty tree (measured by hand against a
 *     throwaway repo: it does), nor that `gh run view --json jobs` keeps its
 *     current shape. If `gh`'s JSON keys change, the watch degrades to
 *     `unknown` — which is the fail-safe direction — and nothing here reds.
 *   • The ORDER-INDEPENDENCE of the checks. §6 pins the command sequence of a
 *     nominal release, which incidentally pins ordering, but there is no
 *     assertion that check N cannot be reordered before check N-1.
 *   • That a refusal's REMEDY text is correct. The text is printed and the
 *     suite reads only the id.
 *   • Anything about the GitHub side: this suite cannot tell whether branch
 *     protection exists, and deliberately makes no network call. §2 reads the
 *     workflow FILE and can prove its trigger is unrestricted; it cannot prove
 *     GitHub honours it, that Actions is enabled, or that a run really starts.
 *   • That `--ff-only` really produces the CI-verified SHA on a real repo. The
 *     fake reports success and the script then RE-READS `git rev-parse HEAD`
 *     and refuses on a mismatch (asserted), but only real git can prove the
 *     merge itself behaves.
 *   • Timing. The gate's ~8-minute wait, `pollMs`, and the interaction between
 *     a slow run and the `maxWaitMs` ceiling are not exercised against a clock;
 *     `sleep` is instant and the loops are bounded by ATTEMPTS.
 *   • Interactive behaviour beyond the injected `prompt` — a real TTY, ^C
 *     handling, and terminal rendering are untested.
 *   • ONE mutation reds by CRASHING rather than by a named assertion, and that
 *     is stated rather than presented as coverage: restoring `watchCi`'s
 *     wall-clock loop bound makes the poll spin without terminating, so the
 *     process dies out of memory before any assertion runs. A non-terminating
 *     loop cannot be caught by an assertion; in `npm test` it would surface as
 *     the runner's 2-minute offline TIMEOUT. §7's `listCalls === 8` is the
 *     positive statement of the bound, and it is what a subtler off-by-one
 *     would fail on.
 *
 * Zero dependencies — node: builtins only, no network, no API key.
 */

process.env.CURATOR_RELEASE_TEST = '1';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  release, parseArgs, parseSemver, cmpSemver, fullChangelogRows, headlineFromRow,
  readFullRowCap, commitSubjectRefusedReason, assertSafeCommand, watchCi,
  ciReachesReleaseBranches, releaseBranchFor,
  REFUSALS, EXIT, RELEASE_FILES, ADVISORY_JOBS, POST_MERGE_ONLY_JOBS,
} from './release.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label}${actual === expected ? '' : ` — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
function section(t) { console.log(`\n${t}`); }

// Everything a scenario produced a refusal for, so §7 can prove each declared
// id is reachable rather than decorative.
const seenRefusals = new Set();

// ─────────────────────────────────────────────────────────────────────────
// The harness: a virtual repo + a recording `run`.
// ─────────────────────────────────────────────────────────────────────────

const TARGET = '3.29.0';
const TAG = `v${TARGET}`;
const CURRENT = '3.28.0';
const SHA = '1a2b3c4d5e6f70819293a4b5c6d7e8f901234567';
const BRANCH = releaseBranchFor(TARGET);

// A workflow whose push trigger carries no branch filter — the shape the real
// .github/workflows/test.yml has, and the one the gate depends on.
const WORKFLOW_OK = [
  'name: Tests', '',
  '# a comment mentioning branches: [main] to prove comments are not read as keys',
  'on:',
  '  push:',
  '    paths-ignore:',
  "      - '**.md'",
  '  pull_request:',
  '  workflow_dispatch:', '',
  'jobs:',
  '  offline:',
  '    runs-on: ubuntu-latest',
].join('\n');

function claudeMd({ versions = [TAG, 'v3.28.0', 'v3.27.0', 'v3.26.0', 'v3.25.0'], versionLine = CURRENT, versionLines = null } = {}) {
  const rows = versions.map((v) => `| \`${v}\` | **Headline for ${v}, which is long enough to be clipped by the headline extractor at some point.** More prose. |`);
  const lines = [
    '# The Curator — Development Guide',
    '',
    '| Commit | What it fixed |',
    '|---|---|',
    ...rows,
    '',
    '### Archived releases — one line each',
    '',
    '| Release | Headline (one line) |',
    '|---|---|',
    '| `v3.24.2` | archived |',
    '',
  ];
  if (versionLines === null) lines.push(`- **Version:** ${versionLine}`);
  else for (const v of versionLines) lines.push(`- **Version:** ${v}`);
  lines.push('');
  return lines.join('\n');
}

function defaultFiles(over = {}) {
  return {
    'package.json': JSON.stringify({ name: 'the-curator', version: CURRENT }, null, 2) + '\n',
    'package-lock.json': JSON.stringify({
      name: 'the-curator', version: CURRENT, lockfileVersion: 3,
      packages: { '': { name: 'the-curator', version: CURRENT } },
    }, null, 2) + '\n',
    'CLAUDE.md': claudeMd(),
    'CHANGELOG-ARCHIVE.md': '# archive\n',
    'CONTRIBUTING.md': '# contributing\n',
    'scripts/test-changelog-completeness.js': 'section("3. LEANNESS");\n  const CAP = 6;\n',
    '.github/workflows/test.yml': WORKFLOW_OK,
    ...over,
  };
}

/** Reduce an argv to a stable short key the scenarios can override by name. */
function keyFor(argv) {
  const j = argv.join(' ');
  if (/check-doc-suite-counts\.js/.test(j)) return 'doc-counts';
  if (j === 'git rev-parse --is-inside-work-tree') return 'in-repo';
  if (j === 'git rev-parse --abbrev-ref HEAD') return 'branch';
  if (j === 'git rev-parse HEAD') return 'sha';
  if (j === 'git config core.hooksPath') return 'hooks';
  if (j === 'git status --porcelain') return 'status';
  if (j.startsWith('git fetch')) return 'fetch';
  if (j.startsWith('git rev-list')) return 'counts';
  if (j.startsWith('git tag --list')) return 'tag-list';
  if (j.startsWith('git branch --list')) return 'branch-list';
  if (j.startsWith('git ls-remote --tags')) return 'ls-remote';
  if (j.startsWith('git ls-remote --heads')) return 'ls-remote-heads';
  if (j.startsWith('git switch -c')) return 'switch-new';
  if (j === 'git switch main') return 'switch-main';
  if (j.startsWith('git merge-base')) return 'merge-base';
  if (j.startsWith('git merge')) return 'merge-ff';
  if (j.startsWith('git branch -d')) return 'branch-del-local';
  if (j.includes('push origin --delete')) return 'branch-del-remote';
  if (j.startsWith('git push -u origin release/')) return 'push-branch';
  if (j.startsWith('npm version')) return 'npm-version';
  if (j.startsWith('git diff --numstat')) return 'numstat';
  if (j === 'npm test') return 'npm-test';
  if (j.startsWith('git add')) return 'add';
  if (j.startsWith('git commit')) return 'commit';
  if (argv[0] === 'git' && argv[1] === 'tag' && argv[2] === '-a') return 'tag-a';
  if (j === 'git push origin main') return 'push-main';
  if (argv[0] === 'git' && argv[1] === 'push') return 'push-tag';
  if (j === 'gh --version') return 'gh';
  if (j.startsWith('gh run list')) return 'gh-list';
  if (j.startsWith('gh run view')) return 'gh-view';
  return j;
}

const R = (stdout = '', status = 0, stderr = '') => ({ stdout, status, stderr });

function makeHarness(over = {}) {
  const files = defaultFiles(over.files);
  const snapshot = JSON.stringify(files);
  const commands = [];
  const logLines = [];
  let runCalls = 0;
  const writes = [];
  const responses = over.run || {};

  // The real shape on a release branch: `live` is SKIPPED by its own `if:`.
  const ghJobs = over.ghJobs || [
    { name: 'Offline tests (free)', status: 'completed', conclusion: 'success' },
    { name: 'Live API tests (Gemini + Anthropic)', status: 'completed', conclusion: 'skipped' },
    { name: 'Dependency audit (advisory)', status: 'completed', conclusion: 'success' },
  ];

  const defaults = {
    'in-repo': () => R('true\n'),
    'branch': () => R('main\n'),
    'sha': () => R(`${SHA}\n`),
    'hooks': () => R('.githooks\n'),
    'status': () => R(' M CLAUDE.md\n'),
    'fetch': () => R(''),
    'counts': () => R('1\t0\n'),
    'tag-list': () => R(''),
    'branch-list': () => R(''),
    'ls-remote': () => R(''),
    'ls-remote-heads': () => R(''),
    'switch-new': () => R(''),
    'switch-main': () => R(''),
    'merge-base': () => R(''),           // exit 0 = origin/main IS an ancestor
    'merge-ff': () => R(''),
    'push-branch': () => R(''),
    'branch-del-local': () => R(''),
    'branch-del-remote': () => R(''),
    'npm-version': (argv) => {
      // Model the real side effect: package.json + BOTH lock fields.
      const v = argv[argv.length - 1];
      const p = JSON.parse(files['package.json']); p.version = v;
      files['package.json'] = JSON.stringify(p, null, 2) + '\n';
      const l = JSON.parse(files['package-lock.json']); l.version = v; l.packages[''].version = v;
      files['package-lock.json'] = JSON.stringify(l, null, 2) + '\n';
      return R(`v${v}\n`);
    },
    'numstat': () => R('1\t1\tpackage.json\n2\t2\tpackage-lock.json\n'),
    'doc-counts': () => R('✅ CONTRIBUTING.md suite count matches scripts/run-tests.js\n'),
    'npm-test': () => R(''),
    'add': () => R(''),
    'commit': () => R(''),
    'tag-a': () => R(''),
    'push-main': () => R(''),
    'push-tag': () => R(''),
    'gh': () => R('gh version 2.0.0\n'),
    'gh-list': () => R(JSON.stringify([{ databaseId: 42, headSha: SHA, status: 'completed', conclusion: 'success', url: 'https://example/42' }])),
    'gh-view': () => R(JSON.stringify({ status: 'completed', conclusion: 'success', jobs: ghJobs })),
  };

  const deps = {
    run(argv, opts) {
      runCalls++;
      const key = keyFor(argv);
      const h = Object.prototype.hasOwnProperty.call(responses, key) ? responses[key] : defaults[key];
      if (!h) return R('', 0);
      const r = typeof h === 'function' ? h(argv, opts) : h;
      return { stdout: r.stdout ?? '', status: r.status ?? 0, stderr: r.stderr ?? '' };
    },
    readFile(p) {
      if (!(p in files)) { const e = new Error(`ENOENT (virtual): ${p}`); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
    writeFile(p, s) {
      writes.push(p);
      if (over.swallowWrites) return;   // models "the edit reported success and did not survive"
      files[p] = s;
    },
    exists: (p) => p in files,
    log: (l) => logLines.push(String(l)),
    prompt: async () => (over.answer === undefined ? TARGET : over.answer),
    isTTY: () => over.isTTY !== false,
    sleep: async () => {},
    now: () => new Date('2026-08-31T00:00:00.000Z'),
  };
  // Left off unless a scenario supplies one, so the REAL assertSafeCommand is
  // what runs in every other scenario.
  if (over.assertSafe) deps.assertSafe = over.assertSafe;

  return {
    deps, files, commands, logLines, writes,
    get runCalls() { return runCalls; },
    unchanged: () => JSON.stringify(files) === snapshot,
    keys: () => commands.map(keyFor),
  };
}

/** Run the real release() through the harness and record what came back. */
async function run(argv, over = {}) {
  const h = makeHarness(over);
  // Wrap `run` so the harness records what release() issued, in order. The
  // recorded list is release()'s own `commands`, but capturing here too lets
  // §0 compare the two and prove nothing bypassed the seam.
  const inner = h.deps.run;
  h.deps.run = (argv2, opts) => { h.commands.push(argv2.slice()); return inner(argv2, opts); };
  let result, thrown = null;
  try { result = await release(argv, h.deps); }
  catch (e) { thrown = e; result = { code: EXIT.REFUSED, refusal: e && e.refusal ? e.refusal : null, warnings: [], commands: [] }; }
  if (result.refusal) seenRefusals.add(result.refusal);
  return { ...h, result, thrown, out: h.logLines.join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────
section('§0  CONTROLS — the seam is real, and nothing here can reach real git');
// ─────────────────────────────────────────────────────────────────────────
{
  const nominal = await run([TARGET, '--yes']);
  eq(nominal.result.code, EXIT.OK, 'a nominal release through the harness succeeds (positive control — if this failed, every refusal below could be passing for the wrong reason)');
  ok(nominal.commands.length > 10, `the fake run was exercised (${nominal.commands.length} commands recorded)`);
  eq(nominal.runCalls, nominal.commands.length,
    'every command release() issued went through the injected run — a path reaching child_process directly would leave these unequal');
  eq(nominal.result.commands.length, nominal.commands.length,
    "release()'s own command log agrees with the harness's — the recorder is not seeing a subset");

  // The mechanism that stops an un-injected call reaching real git.
  let threw = null;
  try { await release([TARGET, '--dry-run'], null); } catch (e) { threw = e; }
  ok(threw !== null && /CURATOR_RELEASE_TEST/.test(String(threw && threw.message)),
    'release() with deps=null THROWS under CURATOR_RELEASE_TEST=1 — a forgotten injection cannot silently run the real thing');

  // Anti-vacuity on the throw: it must be the FLAG doing it, not a broken call.
  // This is the one call in the suite that runs with deps = null, so it is
  // deliberately given an argument that refuses on the VERSION — the very
  // first check, before any git command is issued. console.log is swapped for
  // a collector because the default deps log through it, and a line-initial
  // "✗" in a suite's stdout is a failure marker to scripts/run-tests.js.
  const saved = process.env.CURATOR_RELEASE_TEST;
  delete process.env.CURATOR_RELEASE_TEST;
  const realLog = console.log;
  const leaked = [];
  console.log = (...a) => leaked.push(a.join(' '));
  let threw2 = null, result2 = null;
  try { result2 = await release(['not-a-version'], null); } catch (e) { threw2 = e; }
  console.log = realLog;
  process.env.CURATOR_RELEASE_TEST = saved;
  ok(threw2 === null,
    'without the flag, release() does NOT throw on a deps-less call (proving the throw above came from the flag, not from an unrelated crash)');
  eq(result2 && result2.refusal, 'bad-version',
    '…and that deps-less call refuses on the version before issuing a single git command');
  eq(result2 && result2.commands.length, 0,
    '…having issued zero commands, which is what makes running it with real deps safe');
  ok(leaked.some((l) => /REFUSED \(bad-version\)/.test(l)),
    "…and it logged through console.log, proving defaultDeps().log really is console.log rather than a stub the injected tests would never notice");
}

// ─────────────────────────────────────────────────────────────────────────
section('§1  assertSafeCommand — the irreversible argv shapes are refused structurally');
// ─────────────────────────────────────────────────────────────────────────
{
  const refused = (argv) => {
    try { assertSafeCommand(argv); return null; } catch (e) { if (e.refusal) seenRefusals.add(e.refusal); return e.refusal || 'threw'; }
  };
  eq(refused(['git', 'push', '--force', 'origin', 'main']), 'unsafe-command', 'git push --force is refused');
  eq(refused(['git', 'push', '-f', 'origin', 'main']), 'unsafe-command', 'git push -f is refused');
  eq(refused(['git', 'push', '--force-with-lease', 'origin', 'main']), 'unsafe-command', 'git push --force-with-lease is refused');
  eq(refused(['git', 'push', 'origin', '+main']), 'unsafe-command', 'a "+refspec" force push is refused even without a --force flag');
  eq(refused(['git', 'push', 'origin', '--delete', TAG]), 'unsafe-command', 'deleting a remote ref is refused');
  eq(refused(['git', 'tag', '-d', TAG]), 'unsafe-command', 'deleting a tag is refused');
  eq(refused(['git', 'reset', '--hard', 'origin/main']), 'unsafe-command', "hard-resetting the operator's checkout is refused");

  eq(refused(['git', 'merge', 'release/v1.2.3']), 'unsafe-command',
    'a merge without --ff-only is refused — a merge commit would make main a SHA no CI run ever executed on, which is the property the gate exists to hold');
  eq(refused(['git', 'branch', '-D', BRANCH]), 'unsafe-command', 'force-deleting a branch is refused even for a release branch');
  eq(refused(['git', 'push', 'origin', '--delete', 'main']), 'unsafe-command', 'deleting main is refused');
  eq(refused(['git', 'branch', '-d', 'main']), 'unsafe-command', 'deleting main locally is refused');
  eq(refused(['git', 'push', 'origin', '--delete', 'release/experiment']), 'unsafe-command',
    'the deletion exception matches release/vX.Y.Z ONLY — a branch merely under release/ does not satisfy it');

  eq(refused(['git', 'push', 'origin', 'main']), null, 'an ordinary branch push is allowed');
  eq(refused(['git', 'push', 'origin', TAG]), null, 'an ordinary tag push is allowed');
  eq(refused(['git', 'push', '-u', 'origin', BRANCH]), null, 'pushing the release branch is allowed');
  eq(refused(['git', 'tag', '-a', TAG, '-m', 'x']), null, 'creating an annotated tag is allowed');
  eq(refused(['git', 'merge', '--ff-only', BRANCH]), null, 'a fast-forward-only merge is allowed');
  eq(refused(['git', 'branch', '-d', BRANCH]), null, 'safe-deleting the merged release branch is allowed');
  eq(refused(['git', 'push', 'origin', '--delete', BRANCH]), null, 'deleting it on origin is allowed');
  eq(refused(['npm', 'test']), null, 'npm commands are not subject to the git argv rules');

  const nominal = await run([TARGET, '--yes']);
  ok(!nominal.commands.some((c) => c.includes('--force') || c.includes('-f') || c.some((t) => t.startsWith('+'))),
    'a full nominal release issues NO command carrying a force flag or a "+" refspec');

  // ── The guard must be WIRED, not merely correct ────────────────────────
  // This section exists because of a mutation that came back GREEN: deleting
  // the safety call from exec() changed nothing observable, since no code path
  // in release.js constructs an unsafe command today. The check is there for
  // the edit that has not been made yet — a `git push --force` added to some
  // future retry path — so what has to be provable is that EVERY command goes
  // through it, not that today's commands happen to be safe.
  const seen = [];
  const wired = await run([TARGET, '--yes'], { assertSafe: (argv) => { seen.push(argv.slice()); } });
  eq(seen.length, wired.commands.length,
    'the safety check is called exactly once per command issued — deleting the call from exec() leaves this at 0');
  ok(seen.length > 0 && seen.every((a, i) => a.join(' ') === wired.commands[i].join(' ')),
    '…and is handed each command\'s OWN argv, in order — not a copy of something else');

  // And a refusal must stop the command, not merely be recorded alongside it.
  const blockedAt = [];
  const blocked = await run([TARGET, '--yes'], {
    assertSafe: (argv) => {
      if (argv.join(' ') === 'git push origin main') {
        blockedAt.push(argv);
        const e = new Error('refused by the test'); e.refusal = 'unsafe-command'; throw e;
      }
    },
  });
  eq(blockedAt.length, 1, 'the safety check saw the push');
  eq(blocked.result.refusal, 'unsafe-command', 'a refusal from the safety check aborts the release rather than being swallowed');
  ok(!blocked.keys().includes('push-main'),
    '…and the refused command NEVER REACHED run — the check runs BEFORE execution, which is the whole point of it');
}

// ─────────────────────────────────────────────────────────────────────────
section('§2  The small parsers');
// ─────────────────────────────────────────────────────────────────────────
{
  eq(parseArgs(['3.1.0']).version, '3.1.0', 'a bare argument is the version');
  eq(parseArgs(['3.1.0', '--dry-run']).dryRun, true, '--dry-run parses');
  eq(parseArgs(['3.1.0', '-n']).dryRun, true, '-n parses');
  eq(parseArgs(['3.1.0', '--yes']).yes, true, '--yes parses');
  eq(parseArgs(['3.1.0', '--no-push']).push, false, '--no-push parses');
  eq(parseArgs(['3.1.0', '--no-watch']).watch, false, '--no-watch parses');
  eq(parseArgs(['3.1.0', '-m', 'hi']).message, 'hi', '-m takes a value');
  eq(parseArgs(['3.1.0', '--message=hi']).message, 'hi', '--message= takes a value');
  ok(parseArgs(['3.1.0', '--wat']).error !== null, 'an unrecognised option is an error, never silently skipped');
  ok(parseArgs(['3.1.0', '3.2.0']).error !== null, 'a second positional argument is an error');
  eq(parseArgs([]).version, null, 'no version is null, not a default');

  ok(parseSemver('3.29.0') !== null, 'plain semver parses');
  eq(parseSemver('3.29.0-beta.1'), null, 'a -beta suffix does NOT parse — the pre-release line was retired');
  eq(parseSemver('v3.29.0'), null, 'a leading v does not parse (the tag carries the v, the version field does not)');
  ok(cmpSemver('3.29.0', '3.28.0') > 0, '3.29.0 > 3.28.0');
  ok(cmpSemver('3.9.0', '3.10.0') < 0, '3.9.0 < 3.10.0 (numeric, not lexical — the trap this comparison exists for)');
  eq(cmpSemver('3.28.0', '3.28.0'), 0, 'equal versions compare 0');

  const rows = fullChangelogRows(claudeMd());
  eq(rows.length, 5, 'the full-row table is read, and stops at the table end (the INDEX table below is not folded in)');
  eq(rows[0].id, TAG, 'the newest row is first');
  eq(fullChangelogRows('# no table here\n'), null, 'a missing table returns null rather than an empty list — "nothing to check" must never read as "nothing wrong"');

  eq(headlineFromRow('| `v1` | **A short headline.** rest |'), 'A short headline',
    'the headline is the first bold run, with trailing punctuation trimmed');
  const long = headlineFromRow('| `v1` | **' + 'word '.repeat(40) + '** rest |');
  ok(long.length <= 72 && !long.endsWith(' '), `a long headline is clipped at a word boundary (${long.length} chars)`);
  eq(headlineFromRow('| `v1` | no bold here |'), null, 'no bold run yields null, so the caller falls back to the bare tag');

  eq(readFullRowCap('const CAP = 6;').cap, 6, 'the leanness cap is read out of the suite that enforces it');
  eq(readFullRowCap('const CAP = 6;').derived, true, 'and reports that it was derived');
  eq(readFullRowCap('nothing here').derived, false, 'an unreadable cap reports derived:false so the caller can warn rather than silently using a stale literal');
  eq(readFullRowCap('const CAP = 6;\nconst CAP = 9;').derived, false, 'an ambiguous cap (two declarations) also reports derived:false rather than guessing');

  eq(commitSubjectRefusedReason('v3.29.0: a fine subject'), null, 'an ordinary subject is fine');
  ok(commitSubjectRefusedReason('x\nCo-Authored-By: someone') !== null, 'a Co-Authored-By trailer is refused (the commit-msg hook would bounce it)');
  ok(commitSubjectRefusedReason('Generated with a tool') !== null, 'a third-party attribution phrase is refused');
  ok(commitSubjectRefusedReason('   ') !== null, 'an empty subject is refused');

  ok(RELEASE_FILES.includes('package.json') && RELEASE_FILES.includes('CLAUDE.md'),
    'the release-metadata allow-list names the files a release genuinely touches');
  ok(ADVISORY_JOBS.includes('Dependency audit (advisory)'),
    "the advisory job is named exactly as .github/workflows/test.yml names it — a mismatch would make the audit job gate releases, which its own comment says it must never do");

  eq(releaseBranchFor('3.29.0'), 'release/v3.29.0', 'the release branch has one derivation, used by every step');

  // ── The gate's foundation, checked against the REAL workflow on disk ────
  // This is the one place the suite reads a real file rather than a fixture,
  // and it has to: the whole gate rests on the workflow actually firing for a
  // release branch, and a fixture cannot prove anything about the file that
  // ships. If someone adds `branches: [main]` to the push trigger, this reds
  // here as well as refusing at release time.
  const realWorkflow = readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  const realReach = ciReachesReleaseBranches(realWorkflow);
  ok(realReach.ok,
    realReach.ok
      ? `the SHIPPED .github/workflows/test.yml would run on a release branch (${realReach.reason})`
      : `THE GATE IS BROKEN: ${realReach.reason}. A release branch would get no CI run, and a gate waiting on a run that never starts is worse than no gate.`);
  ok(/DO NOT ADD A `branches:` FILTER/.test(realWorkflow),
    'the workflow says in its own text that the missing branch filter is load-bearing — a comment is not a guard, but this one stops a tidy-up that the guard would only catch at release time');
  ok(/Live API tests \(Gemini \+ Anthropic\)/.test(realWorkflow),
    'the live job name POST_MERGE_ONLY_JOBS refers to really exists in the workflow');
  ok(/Dependency audit \(advisory\)/.test(realWorkflow),
    'the advisory job name ADVISORY_JOBS refers to really exists in the workflow');

  // Anti-vacuity in both directions: the parser must actually be able to say no.
  ok(!ciReachesReleaseBranches(WORKFLOW_OK.replace('  push:\n', '  push:\n    branches: [main]\n')).ok,
    'the reachability parser DETECTS a branches: filter (a parser that always says yes would pass the assertion above forever)');
  ok(ciReachesReleaseBranches(WORKFLOW_OK).ok, '…and accepts an unfiltered push trigger');
  ok(!ciReachesReleaseBranches('').ok, '…and refuses an empty/missing workflow');
  ok(ciReachesReleaseBranches(WORKFLOW_OK).ok,
    'a COMMENT containing the words "branches: [main]" does not trip the parser — the fixture above carries exactly that line as a control');
}

// ─────────────────────────────────────────────────────────────────────────
section('§3  Every precondition REFUSES — one scenario each, driven through the real release()');
// ─────────────────────────────────────────────────────────────────────────

async function refusesWith(id, label, argv, over) {
  const r = await run(argv, over);
  eq(r.result.refusal, id, label);
  if (r.result.refusal === id) {
    ok(r.result.code === EXIT.REFUSED, `  …and exits ${EXIT.REFUSED} (REFUSED), not 0`);
    ok(new RegExp(`REFUSED \\(${id}\\)`).test(r.out), '  …and says so by name in its output');
  } else { failed += 2; console.log('  ✗   …(dependent assertions skipped — the refusal did not fire)'); }
  return r;
}

await refusesWith('bad-usage', 'no version at all refuses', ['--yes'], {});
await refusesWith('bad-usage', 'an unrecognised option refuses rather than being ignored', [TARGET, '--turbo'], {});
await refusesWith('bad-version', 'a -beta suffix refuses', ['3.29.0-beta.1'], {});
await refusesWith('bad-version', 'a two-part version refuses', ['3.29'], {});
await refusesWith('not-a-git-repo', 'a non-repo refuses', [TARGET], { run: { 'in-repo': () => R('', 128, 'not a git repository') } });
await refusesWith('wrong-branch', 'cutting from a non-main branch refuses', [TARGET], { run: { branch: () => R('feature-x\n') } });
await refusesWith('dirty-tree', 'an unrelated modified file refuses', [TARGET], { run: { status: () => R(' M src/brain/llm.js\n M CLAUDE.md\n') } });
await refusesWith('dirty-tree', 'an untracked stray file refuses', [TARGET], { run: { status: () => R('?? scratch.txt\n') } });
await refusesWith('fetch-failed', 'a failed fetch refuses rather than releasing blind', [TARGET], { run: { fetch: () => R('', 1, 'could not resolve host') } });
await refusesWith('fetch-failed', 'an unparseable ahead/behind count refuses rather than being read as 0/0', [TARGET], { run: { counts: () => R('nonsense\n') } });
await refusesWith('behind-remote', 'being behind origin/main refuses', [TARGET], { run: { counts: () => R('0\t3\n') } });
await refusesWith('diverged', 'a diverged history refuses', [TARGET], { run: { counts: () => R('2\t3\n') } });
await refusesWith('nothing-to-release', 'nothing ahead and nothing dirty refuses', [TARGET], { run: { counts: () => R('0\t0\n'), status: () => R('') } });
await refusesWith('version-not-forward', 'a backwards version refuses', ['3.27.0'], {});
await refusesWith('tag-exists', 'an existing LOCAL tag refuses', [TARGET], { run: { 'tag-list': () => R(`${TAG}\n`) } });
await refusesWith('tag-exists', 'an existing REMOTE tag refuses', [TARGET], { run: { 'ls-remote': () => R(`abc123\trefs/tags/${TAG}\n`) } });
await refusesWith('changelog-row-missing', 'no row for the version being cut refuses', [TARGET],
  { files: { 'CLAUDE.md': claudeMd({ versions: ['v3.28.0', 'v3.27.0'] }) } });
await refusesWith('changelog-row-missing', 'a version present ONLY as an index line refuses — an index line is a pointer, never the record', [TARGET],
  { files: { 'CLAUDE.md': claudeMd({ versions: ['v3.28.0'] }).replace('| `v3.24.2` | archived |', `| \`${TAG}\` | archived |`) } });
await refusesWith('changelog-row-missing', 'a missing full-row table refuses', [TARGET],
  { files: { 'CLAUDE.md': `# doc\n\n- **Version:** ${CURRENT}\n` } });
await refusesWith('claude-version-line', 'zero version lines refuses', [TARGET],
  { files: { 'CLAUDE.md': claudeMd({ versionLines: [] }) } });
await refusesWith('claude-version-line', 'two version lines refuses', [TARGET],
  { files: { 'CLAUDE.md': claudeMd({ versionLines: [CURRENT, CURRENT] }) } });

// The half-bumped tree. This is the state that makes `npm test` go red in the
// middle of a release for a reason that reads like a test failure, so it is
// caught here with the remedy instead.
await refusesWith('version-fields-disagree', 'CLAUDE.md bumped but package.json not (a half-bumped tree) refuses', [TARGET],
  { files: { 'CLAUDE.md': claudeMd({ versionLine: TARGET }) } });
await refusesWith('version-fields-disagree', "a stale package-lock (v3.24.1's bug, which sat six releases stale) refuses", [TARGET],
  { files: { 'package-lock.json': JSON.stringify({ version: '3.18.0', packages: { '': { version: '3.18.0' } } }, null, 2) } });
await refusesWith('version-fields-disagree', 'a lock whose TWO fields disagree with each other refuses', [TARGET],
  { files: { 'package-lock.json': JSON.stringify({ version: CURRENT, packages: { '': { version: '3.18.0' } } }, null, 2) } });
await refusesWith('version-fields-disagree', 'an unparseable package.json refuses', [TARGET],
  { files: { 'package.json': '{ not json' } });

await refusesWith('leanness-cap-exceeded', 'seven full changelog rows refuses BEFORE npm test spends two minutes discovering it', [TARGET],
  { files: { 'CLAUDE.md': claudeMd({ versions: [TAG, 'v3.28.0', 'v3.27.0', 'v3.26.0', 'v3.25.0', 'v3.24.2', 'v3.22.0'] }) } });

await refusesWith('suite-counts-stale', "a stale CONTRIBUTING.md suite count refuses", [TARGET],
  { run: { 'doc-counts': () => R('  ✗ CONTRIBUTING.md:79 — STALE: OFFLINE count says 132\n', 1) } });

await refusesWith('bump-failed', 'npm version failing refuses', [TARGET], { run: { 'npm-version': () => R('', 1, 'npm ERR!') } });
await refusesWith('bump-failed', 'npm version reporting success while the lock still reads the old version refuses — the report is never trusted, the files are re-read',
  [TARGET], { run: { 'npm-version': () => R('v3.29.0\n', 0) } });   // no side effect: files unchanged
await refusesWith('lock-diff-too-large', 'a lock diff bigger than the two version fields refuses (npm re-resolved the tree)', [TARGET],
  { run: { numstat: () => R('1\t1\tpackage.json\n412\t397\tpackage-lock.json\n') } });
await refusesWith('lock-diff-too-large', 'a MISSING lock entry in the diff refuses rather than being read as "no change"', [TARGET],
  { run: { numstat: () => R('1\t1\tpackage.json\n') } });

await refusesWith('claude-rewrite-failed', 'a write that reports success and does not survive on disk refuses — the file is always read back', [TARGET],
  { swallowWrites: true });

await refusesWith('tests-failed', 'npm test going red refuses', [TARGET], { run: { 'npm-test': () => R('', 1) } });

await refusesWith('commit-message-refused', 'a derived subject the commit-msg hook would bounce refuses UP FRONT', [TARGET],
  { files: { 'CLAUDE.md': claudeMd().replace('**Headline for v3.29.0', '**\u{1F916} Headline for v3.29.0') } });
await refusesWith('commit-message-refused', 'an explicit -m the hook would bounce refuses', [TARGET, '-m', 'Generated with a tool'], {});

await refusesWith('not-confirmed', 'no --yes and no TTY refuses — an unattended script cannot push to main by omission', [TARGET], { isTTY: false });
await refusesWith('not-confirmed', 'a wrong answer at the confirmation prompt refuses', [TARGET], { answer: 'yes' });

await refusesWith('release-branch-exists', 'an existing LOCAL release branch refuses — a re-cut would hide a failed first attempt', [TARGET],
  { run: { 'branch-list': () => R(`  ${BRANCH}\n`) } });
await refusesWith('release-branch-exists', 'an existing REMOTE release branch refuses', [TARGET],
  { run: { 'ls-remote-heads': () => R(`abc\trefs/heads/${BRANCH}\n`) } });

// The gate's own foundation. If CI would not run on the release branch, the
// watch waits for a run that never starts — worse than no gate, because it
// looks like one.
await refusesWith('ci-not-reachable', 'a workflow restricted to main refuses — the gate would wait on a run that never starts', [TARGET],
  { files: { '.github/workflows/test.yml': WORKFLOW_OK.replace('  push:\n', '  push:\n    branches: [main]\n') } });
await refusesWith('ci-not-reachable', 'a workflow with a branches-ignore filter refuses rather than being evaluated by guesswork', [TARGET],
  { files: { '.github/workflows/test.yml': WORKFLOW_OK.replace('  push:\n', "  push:\n    branches-ignore: ['release/**']\n") } });
await refusesWith('ci-not-reachable', 'a workflow with NO push trigger refuses', [TARGET],
  { files: { '.github/workflows/test.yml': 'on:\n  workflow_dispatch:\n' } });
await refusesWith('ci-not-reachable', 'a MISSING workflow file refuses — there is no CI to gate on', [TARGET],
  { files: { '.github/workflows/test.yml': undefined } });

await refusesWith('commit-failed', 'a failed commit refuses', [TARGET, '--yes'], { run: { commit: () => R('', 1, 'hook refused') } });
await refusesWith('branch-create-failed', 'a failed branch create refuses BEFORE anything is committed', [TARGET, '--yes'],
  { run: { 'switch-new': () => R('', 128, 'fatal: cannot create branch') } });
await refusesWith('push-failed', 'a rejected release-branch push refuses, and does NOT retry with force', [TARGET, '--yes'],
  { run: { 'push-branch': () => R('', 1, '! [rejected]') } });
await refusesWith('remote-moved', 'origin/main advancing DURING CI refuses rather than rebasing onto a SHA CI never saw', [TARGET, '--yes'],
  { run: { 'merge-base': () => R('', 1) } });
await refusesWith('ff-failed', 'a merge that is not a clean fast-forward refuses', [TARGET, '--yes'],
  { run: { 'merge-ff': () => R('', 1, 'fatal: Not possible to fast-forward') } });
await refusesWith('ff-failed', 'a fast-forward that reports success and lands on the WRONG commit refuses — the SHA is re-read, never assumed', [TARGET, '--yes'],
  { run: { sha: (() => { let n = 0; return () => R(n++ === 0 ? `${SHA}\n` : 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n'); })() } });
await refusesWith('push-failed', 'a rejected main push refuses', [TARGET, '--yes'],
  { run: { 'push-main': () => R('', 1, '! [rejected] main -> main (fetch first)') } });

// ─────────────────────────────────────────────────────────────────────────
section('§4  Warnings that are NOT refusals — a release still goes out, loudly');
// ─────────────────────────────────────────────────────────────────────────
{
  const atCap = await run([TARGET, '--yes'],
    { files: { 'CLAUDE.md': claudeMd({ versions: [TAG, 'v3.28.0', 'v3.27.0', 'v3.26.0', 'v3.25.0', 'v3.24.2'] }) } });
  eq(atCap.result.code, EXIT.OK, 'exactly AT the leanness cap still releases');
  ok(atCap.result.warnings.some((w) => /AT the leanness cap/.test(w)),
    '…and warns that the NEXT release must archive first, rather than letting someone discover it mid-release');

  const noHooks = await run([TARGET, '--yes'], { run: { hooks: () => R('\n') } });
  eq(noHooks.result.code, EXIT.OK, 'missing git hooks warns rather than refusing (hygiene, not correctness)');
  ok(noHooks.result.warnings.some((w) => /core\.hooksPath/.test(w)), '…and names the fix');

  const tagPushFailed = await run([TARGET, '--yes'], { run: { 'push-tag': () => R('', 1, 'tag push rejected') } });
  eq(tagPushFailed.result.code, EXIT.OK,
    'main pushed but the tag push failing is a WARNING, not a failure — the deploy already happened, and reporting it as a failed release would be a lie about what occurred');
  ok(tagPushFailed.result.warnings.some((w) => /tag push failed/.test(w)), '…and says how to retry the tag push');

  const tagFailed = await run([TARGET, '--yes'], { run: { 'tag-a': () => R('', 1, 'bad tag') } });
  eq(tagFailed.result.code, EXIT.OK,
    'the tag FAILING TO BE CREATED is likewise a warning, for the same reason — it happens after main is pushed, so the release is already live');
  ok(tagFailed.result.warnings.some((w) => new RegExp(`creating ${TAG} failed`).test(w)), '…and names the manual command');

  const delFailed = await run([TARGET, '--yes'], { run: { 'branch-del-local': () => R('', 1, 'not fully merged') } });
  eq(delFailed.result.code, EXIT.OK, 'failing to delete the release branch is harmless and warns');
  ok(!delFailed.keys().includes('branch-del-remote'),
    '…and the REMOTE delete is not attempted when the local one refused — `git branch -d` refuses an unmerged branch, so its failure is itself a signal not to go further');

  const keep = await run([TARGET, '--yes', '--keep-branch']);
  eq(keep.result.code, EXIT.OK, '--keep-branch releases');
  ok(!keep.keys().some((x) => x.startsWith('branch-del')), '…and deletes nothing');

  const skipped = await run([TARGET, '--yes', '--skip-tests']);
  eq(skipped.result.code, EXIT.OK, '--skip-tests still releases');
  ok(!skipped.keys().includes('npm-test'), '…and genuinely does not run npm test');
  ok(skipped.result.warnings.some((w) => /skip-tests/.test(w)), '…and the override is recorded as a warning');
  ok(/!!.*BYPASSED/s.test(skipped.out), '…and prints a loud banner');
  const tagCmd = skipped.commands.find((c) => keyFor(c) === 'tag-a');
  ok(tagCmd && /BYPASSED/.test(tagCmd[tagCmd.length - 1]),
    '…and the bypass is written into the ANNOTATED TAG, so the release record itself says the gate was skipped');
}

// ─────────────────────────────────────────────────────────────────────────
section('§5  --dry-run performs every check and writes NOTHING');
// ─────────────────────────────────────────────────────────────────────────
{
  const dry = await run([TARGET, '--dry-run']);
  eq(dry.result.code, EXIT.OK, 'a dry run of a releasable tree succeeds');
  ok(dry.unchanged(), 'the virtual filesystem is byte-identical afterwards');
  eq(dry.writes.length, 0, 'writeFile was never called');
  const k = dry.keys();
  for (const forbidden of ['npm-version', 'switch-new', 'add', 'commit', 'push-branch',
                           'switch-main', 'merge-ff', 'push-main', 'tag-a', 'push-tag',
                           'branch-del-local', 'branch-del-remote', 'gh-list']) {
    ok(!k.includes(forbidden), `a dry run issues no "${forbidden}" command`);
  }
  // "Genuinely complete" is the point of the mode, so the expensive checks
  // must actually run rather than being skipped to make the mode fast.
  for (const required of ['in-repo', 'branch', 'status', 'fetch', 'counts', 'tag-list', 'ls-remote',
                          'branch-list', 'ls-remote-heads', 'doc-counts', 'npm-test']) {
    ok(k.includes(required), `a dry run still runs "${required}"`);
  }
  // The whole gate path has to be DESCRIBED even though none of it is done,
  // or the rehearsal is not a rehearsal of the thing that actually happens.
  for (const [needle, what] of [
    [`git switch -c ${BRANCH}`, 'the release branch it would create'],
    [`git push -u origin ${BRANCH}`, 'the branch push'],
    ['WAIT for CI', 'the gate'],
    ['main untouched', 'what a red gate means'],
    [`git merge --ff-only ${BRANCH}`, 'the fast-forward merge'],
    [`git tag -a ${TAG}`, 'the tag, created after the merge'],
    [`delete ${BRANCH}`, 'the branch cleanup'],
  ]) {
    ok(dry.out.includes(needle), `a dry run names ${what} ("${needle}")`);
  }
  ok(/DRY RUN COMPLETE/.test(dry.out), 'it says so');
  ok(/npm version --no-git-tag-version 3\.29\.0/.test(dry.out), 'and prints the bump the real run would perform');

  // The reason the half-bumped refusal exists: a dry run's `npm test` reads
  // the CURRENT tree, so that tree has to be self-consistent for the reading
  // to mean anything. Assert the dry run left package.json on the OLD version.
  eq(JSON.parse(dry.files['package.json']).version, CURRENT,
    'package.json is still on the old version after a dry run — which is why a half-bumped tree is refused rather than tolerated');

  // A dry run of an UNRELEASABLE tree must still refuse, or the mode is theatre.
  const dryBad = await run([TARGET, '--dry-run'], { run: { branch: () => R('feature-x\n') } });
  eq(dryBad.result.refusal, 'wrong-branch', 'a dry run refuses exactly as the real run does');
}

// ─────────────────────────────────────────────────────────────────────────
section('§6  The nominal release — the exact commands, in order, and nothing else');
// ─────────────────────────────────────────────────────────────────────────
{
  const r = await run([TARGET, '--yes']);
  eq(r.result.code, EXIT.OK, 'a nominal release succeeds');
  const k = r.keys();
  const expected = [
    'in-repo', 'branch', 'hooks', 'status', 'fetch', 'counts',
    'tag-list', 'ls-remote', 'branch-list', 'ls-remote-heads',
    'npm-version', 'numstat',
    'doc-counts', 'npm-test',
    'switch-new', 'add', 'commit', 'sha',
    'push-branch',
    'gh', 'gh-list', 'gh-view',              // ← THE GATE, on the release branch
    'fetch', 'merge-base', 'switch-main', 'merge-ff', 'sha', 'push-main',
    'tag-a', 'push-tag',
    'branch-del-local', 'branch-del-remote',
  ];
  eq(k.join(' > '), expected.join(' > '), 'the command sequence is exactly the intended one, in order');

  // The bump is verified on the FILES, not on npm's report.
  eq(JSON.parse(r.files['package.json']).version, TARGET, 'package.json ends on the target version');
  eq(JSON.parse(r.files['package-lock.json']).version, TARGET, 'package-lock.json top-level field ends on the target version');
  eq(JSON.parse(r.files['package-lock.json']).packages[''].version, TARGET, 'package-lock.json packages[""] field ends on the target version — the field v3.24.1 found six releases stale');
  ok(new RegExp(`^- \\*\\*Version:\\*\\* ${TARGET.replace(/\./g, '\\.')}$`, 'm').test(r.files['CLAUDE.md']),
    "CLAUDE.md's version line ends on the target version");

  // Exactly ONE line of a ~700 KB file may change.
  const before = claudeMd().split('\n'), after = r.files['CLAUDE.md'].split('\n');
  eq(after.length, before.length, 'CLAUDE.md gained and lost no lines');
  eq(before.reduce((n, l, i) => n + (l === after[i] ? 0 : 1), 0), 1, 'exactly one line of CLAUDE.md changed');

  // The commit subject is DERIVED from the row, so there is no second place
  // for the release's one-line description to rot.
  const commit = r.commands.find((c) => keyFor(c) === 'commit');
  ok(commit[commit.length - 1].startsWith(`${TAG}: `), `the commit subject starts with "${TAG}: " (got "${commit[commit.length - 1]}")`);
  ok(/Headline for v3\.29\.0/.test(commit[commit.length - 1]), '…and carries the headline taken from the changelog row');

  const add = r.commands.find((c) => keyFor(c) === 'add');
  ok(!add.includes('-A') && !add.includes('.'), 'git add names the release files explicitly — never -A, which would sweep in whatever the dirty-tree check happened to allow');
  for (const f of RELEASE_FILES) ok(add.includes(f), `git add includes ${f}`);

  const tagArgv = r.commands.find((c) => keyFor(c) === 'tag-a');
  eq(tagArgv[2], '-a', 'the tag is ANNOTATED (-a), which is what a GitHub Release will later need');
  eq(tagArgv[3], TAG, `the tag is ${TAG}`);

  const pushes = r.commands.filter((c) => c[0] === 'git' && c[1] === 'push');
  eq(pushes.length, 4, 'exactly four pushes: the release branch, main, the tag, and the branch deletion');
  eq(pushes[0].join(' '), `git push -u origin ${BRANCH}`, 'the RELEASE BRANCH is pushed first — it is what CI runs on');
  eq(pushes[1].join(' '), 'git push origin main', 'main is pushed only after the gate');
  eq(pushes[2].join(' '), `git push origin ${TAG}`, 'then the tag');
  eq(pushes[3].join(' '), `git push origin --delete ${BRANCH}`, 'then the merged branch is cleaned up');

  // Explicit override of the subject.
  const custom = await run([TARGET, '--yes', '-m', 'v3.29.0: something specific']);
  const c2 = custom.commands.find((c) => keyFor(c) === 'commit');
  eq(c2[c2.length - 1], 'v3.29.0: something specific', '-m overrides the derived subject');

  // --no-push stops before the deploy.
  const noPush = await run([TARGET, '--yes', '--no-push']);
  eq(noPush.result.code, EXIT.OK, '--no-push succeeds');
  ok(noPush.keys().includes('commit'), '…and commits on the release branch locally');
  ok(!noPush.keys().some((x) => x.startsWith('push')), '…and pushes nothing');
  ok(!noPush.keys().includes('tag-a'),
    '…and creates NO tag: a tag is only ever made after a green gate and the merge, so it can never name an unverified commit');
  ok(!noPush.keys().includes('merge-ff'), '…and does not touch main');

  const noWatch = await run([TARGET, '--yes', '--no-watch']);
  eq(noWatch.result.code, EXIT.OK, '--no-watch succeeds');
  ok(noWatch.keys().includes('push-branch'), '…and pushes the release branch so CI starts');
  ok(!noWatch.keys().some((x) => x.startsWith('gh')), '…and waits for nothing');
  ok(!noWatch.keys().includes('push-main') && !noWatch.keys().includes('tag-a'),
    '…and still does NOT touch main or tag — skipping the wait skips the merge too, rather than merging unverified');

  // Already-bumped tree: the second accepted starting state.
  const pre = await run([TARGET, '--yes'], {
    files: {
      'package.json': JSON.stringify({ version: TARGET }, null, 2),
      'package-lock.json': JSON.stringify({ version: TARGET, packages: { '': { version: TARGET } } }, null, 2),
      'CLAUDE.md': claudeMd({ versionLine: TARGET }),
    },
  });
  eq(pre.result.code, EXIT.OK, 'a fully pre-bumped tree releases without re-bumping');
  ok(!pre.keys().includes('npm-version'), '…and does not run npm version again');
}

// ─────────────────────────────────────────────────────────────────────────
section('§6b  The closing banner does not imply the installers are published');
// ─────────────────────────────────────────────────────────────────────────
//
// THE DEFECT THIS GUARDS. `release.js` bumps, gates, merges and tags, then
// prints `✓ vX.Y.Z released.` and stops. It does NOT publish a GitHub Release
// — `.github/workflows/desktop-dmg.yml` does that, on the tag push. Between
// v3.31.0 (when the in-app updater shipped and began resolving "the newest
// release carrying an installer" from the Releases API) and v3.38.0 nothing
// published one at all, so a green banner meant "tagged", while every
// installed copy reported "up to date" and ran the previous version. The
// script's own header said publishing was deliberate because nothing consumed
// a release yet; that justification had expired six releases earlier.
//
// The fix in `release.js` is deliberately TEXT rather than a check — polling
// GitHub from inside the release gate would add a network dependency to the
// one script that must not grow more. So the guard is on the text, and on the
// one thing the text is conditional on: whether the tag actually reached
// origin, because the workflow triggers on that and nothing else.
{
  const r = await run([TARGET, '--yes']);
  eq(r.result.tagPushed, true, 'a nominal release reports the tag reached origin');
  ok(/desktop-dmg\.yml/.test(r.out),
     'the closing banner NAMES the workflow that publishes the installers');
  ok(/still building|not been published|INSTALLERS/i.test(r.out),
     '…and says the installers are not out yet');
  ok(r.out.includes(`https://github.com/talirezun/the-curator/releases/tag/${TAG}`),
     '…and gives the exact URL to confirm the release on');
  // Anti-vacuity: the banner must be part of the SUCCESS path, not something
  // only a warning shape produces.
  ok(r.out.includes(`✓ ${TAG} released.`),
     'CONTROL — this is the same run that printed the success line');

  // A tag that never reached origin starts no workflow, so the banner must not
  // promise one. This is the arm that would have been wrong to hardcode.
  const noTag = await run([TARGET, '--yes'], { run: { 'push-tag': () => R('', 1, 'remote rejected') } });
  eq(noTag.result.code, EXIT.OK, 'a failed tag push is a warning, not a refusal — main is already deployed');
  eq(noTag.result.tagPushed, false, '…and the script knows the tag did not reach origin');
  ok(/NO INSTALLERS WILL BE BUILT/.test(noTag.out),
     '…and the banner says no installers will be built rather than pointing at a release that cannot appear');
  ok(!noTag.out.includes(`https://github.com/talirezun/the-curator/releases/tag/${TAG}`),
     '…and does NOT hand out a release URL that will 404');

  // MUTUALLY EXCLUSIVE, both directions. Without these a banner printing both
  // paragraphs unconditionally would satisfy every assertion above.
  //
  // Written this way after a weaker control was measured and found to pass for
  // the wrong reason: comparing the two runs' whole tails found them different
  // because the failed run also prints a WARNING, which has nothing to do with
  // the banner. That control stayed green through a mutation that deleted the
  // banner outright.
  ok(!r.out.includes('NO INSTALLERS WILL BE BUILT'),
     'CONTROL — the nominal run does NOT also print the no-installers wording');
  ok(!/still building/.test(noTag.out),
     'CONTROL — the failed-tag-push run does NOT also print the installers-are-building wording');
}

// ─────────────────────────────────────────────────────────────────────────
section('§7  CI watch — the advisory job must never gate a release');
// ─────────────────────────────────────────────────────────────────────────
{
  const advisoryRed = await run([TARGET, '--yes'], {
    ghJobs: [
      { name: 'Offline tests (free)', status: 'completed', conclusion: 'success' },
      { name: 'Dependency audit (advisory)', status: 'completed', conclusion: 'failure' },
    ],
  });
  eq(advisoryRed.result.code, EXIT.OK,
    'the advisory dependency audit going red does NOT report a red release — the workflow run\'s own conclusion would say "failure", so per-JOB conclusions are what is read');
  ok(/advisory job\(s\) red/.test(advisoryRed.out), '…and it is still reported');

  // ── THE CENTRAL PROPERTY ───────────────────────────────────────────────
  // A red gate must leave main exactly as it was. Not "roll it back" — never
  // touch it. Everything else in this file is a precondition; this is the
  // guarantee the whole release-branch design exists to provide.
  const gateRed = await run([TARGET, '--yes'], {
    ghJobs: [
      { name: 'Offline tests (free)', status: 'completed', conclusion: 'failure' },
      { name: 'Dependency audit (advisory)', status: 'completed', conclusion: 'success' },
    ],
  });
  eq(gateRed.result.code, EXIT.CI_RED, 'a red gate exits CI_RED (2), distinct from a refusal (1)');
  const gk = gateRed.keys();
  for (const forbidden of ['switch-main', 'merge-ff', 'push-main', 'tag-a', 'push-tag', 'branch-del-local', 'branch-del-remote']) {
    ok(!gk.includes(forbidden), `a red gate issues NO "${forbidden}" — main is untouched and NOTHING is deployed`);
  }
  ok(gk.includes('push-branch'), '…while the release branch IS pushed, so the failure is visible and fixable on it');
  ok(/NOTHING HAS BEEN DEPLOYED/.test(gateRed.out), '…and the report says so unambiguously');
  ok(/COMMIT ON TOP/.test(gateRed.out), '…and tells the operator to fix it with a commit on top rather than a re-cut');
  ok(!/git revert/.test(gateRed.out),
    '…and does NOT print revert instructions, because there is nothing on main to revert — that would be the old, wrong story');

  // Unknown must fail CLOSED. This is the property the pre-gate design could
  // not have: an unobservable outcome used to mean "already deployed, go look";
  // it now means "not deployed, go look".
  const noGh = await run([TARGET, '--yes'], { run: { gh: () => R('', 127, 'command not found') } });
  eq(noGh.result.code, EXIT.CI_UNKNOWN, 'gh missing exits CI_UNKNOWN (3)');
  ok(!noGh.keys().includes('push-main'), '…and main is NOT pushed — an unobservable gate fails CLOSED');
  ok(!noGh.keys().includes('tag-a'), '…and no tag is created, so a tag can never name an unverified commit');

  const noRun = await run([TARGET, '--yes'], { run: { 'gh-list': () => R('[]') } });
  eq(noRun.result.code, EXIT.CI_UNKNOWN, 'no workflow run appearing for the pushed sha exits CI_UNKNOWN, never green');
  ok(!noRun.keys().includes('push-main'), '…and main is untouched — which is exactly the "CI would not run on this branch" case, failing safe');

  // The gate watches the RELEASE BRANCH, not main. Watching main would find
  // main's PREVIOUS run and read it as this release's verdict.
  const listArgv = gateRed.commands.find((c) => keyFor(c) === 'gh-list');
  ok(listArgv.includes(BRANCH) && !listArgv.includes('main'),
    `the gate polls --branch ${BRANCH}, never main — polling main would read main's PREVIOUS run as this release's verdict`);

  // The live job does not run on a release branch; that must be REPORTED, not
  // silently counted as a pass.
  const green = await run([TARGET, '--yes']);
  ok(/not run on a release branch, by design/.test(green.out) && /Live API tests/.test(green.out),
    'a skipped job is NAMED in the report rather than silently treated as green — the gate says which checks it did not see');
  ok(POST_MERGE_ONLY_JOBS.includes('Live API tests (Gemini + Anthropic)'),
    'the live job is declared post-merge-only, matching its `if:` in .github/workflows/test.yml');
  // --watch-main is advisory and must never change the exit code.
  const watchMainRed = await run([TARGET, '--yes', '--watch-main'], {
    run: {
      'gh-view': (() => {
        let n = 0;
        return () => R(JSON.stringify(n++ === 0
          ? { status: 'completed', conclusion: 'success', jobs: [{ name: 'Offline tests (free)', status: 'completed', conclusion: 'success' }] }
          : { status: 'completed', conclusion: 'failure', jobs: [{ name: 'Live API tests (Gemini + Anthropic)', status: 'completed', conclusion: 'failure' }] }));
      })(),
    },
  });
  eq(watchMainRed.result.code, EXIT.OK,
    "--watch-main is ADVISORY: main's own run going red on the LIVE suite does not change the exit code, because that job is deliberately outside the gate and ci-flake.js tolerates its transient failures");
  ok(watchMainRed.result.warnings.some((w) => /ci-flake/.test(w)), '…and the warning names ci-flake.js rather than implying a real regression');
  ok(watchMainRed.keys().filter((x) => x === 'gh-list').length === 2, '…having polled main as a SECOND run, not reused the gate\'s');

  const noWatchMain = await run([TARGET, '--yes']);
  eq(noWatchMain.keys().filter((x) => x === 'gh-list').length, 1,
    'without --watch-main only the gate is watched — the default does not block for up to 20 minutes on the paid live suites');

  // The empty-job-list case is ASYMMETRIC, and the asymmetry is the point.
  // GitHub's own run conclusion of "success" means every job succeeded, the
  // advisory one included — that is unambiguous, so it is green even with no
  // job list to read. A conclusion of "failure" is ambiguous: it is exactly
  // what an advisory-only failure looks like, and with no jobs there is no way
  // to tell. Reporting CI_RED there would print revert instructions for a
  // dependency-audit warning, so it degrades to UNKNOWN instead.
  const noJobsGreen = await run([TARGET, '--yes'], { ghJobs: [] });
  eq(noJobsGreen.result.code, EXIT.OK,
    'a completed run with no job list but conclusion "success" is green — success is unambiguous, because it covers the advisory job too');
  const noJobsRed = await run([TARGET, '--yes'], {
    ghJobs: [],
    run: { 'gh-view': () => R(JSON.stringify({ status: 'completed', conclusion: 'failure', jobs: [] })) },
  });
  eq(noJobsRed.result.code, EXIT.CI_UNKNOWN,
    'a completed run with no job list and conclusion "failure" is UNKNOWN, never CI_RED — that is indistinguishable from an advisory-only failure, and printing revert instructions for a dependency-audit warning would be worse than saying "go look"');

  // The bound that stops the watch spinning. Found by this suite: the loop was
  // wall-clock-bounded, so an instant `sleep` — or a sleep that returns early
  // for any reason — turned a two-minute wait into millions of gh invocations
  // and an out-of-memory crash. It is bounded by ATTEMPTS now.
  let listCalls = 0;
  const bounded = await watchCi(SHA, {
    exec: (argv) => {
      const k = keyFor(argv);
      if (k === 'gh') return R('gh 2.0\n');
      if (k === 'gh-list') { listCalls++; return R('[]'); }
      return R('');
    },
    out: () => {}, sleep: async () => {}, appearMs: 120_000, pollMs: 15_000,
  });
  eq(bounded.state, 'unknown', 'a run that never appears ends UNKNOWN');
  eq(listCalls, 8, 'and polls exactly ceil(appearMs / pollMs) = 8 times — bounded by attempts, not by a wall clock an instant sleep can outrun');

  // watchCi in isolation: a run that is still in progress must be polled, not
  // read once and reported. Two views, second completed.
  let views = 0;
  const seq = watchCi(SHA, {
    exec: (argv) => {
      const k = keyFor(argv);
      if (k === 'gh') return R('gh 2.0\n');
      if (k === 'gh-list') return R(JSON.stringify([{ databaseId: 7, headSha: SHA, url: 'u' }]));
      if (k === 'gh-view') {
        views++;
        return R(JSON.stringify(views === 1
          ? { status: 'in_progress', jobs: [{ name: 'Offline tests (free)', status: 'in_progress' }] }
          : { status: 'completed', conclusion: 'success', jobs: [{ name: 'Offline tests (free)', status: 'completed', conclusion: 'success' }] }));
      }
      return R('');
    },
    out: () => {}, sleep: async () => {},
  });
  const seqR = await seq;
  eq(seqR.state, 'green', 'watchCi polls an in-progress run until it completes');
  eq(views, 2, '…and really polled twice rather than reading once');
}

// ─────────────────────────────────────────────────────────────────────────
section('§8  COVERAGE — every declared refusal is reachable, and every refusal fired is declared');
// ─────────────────────────────────────────────────────────────────────────
{
  const declared = Object.keys(REFUSALS);
  ok(declared.length >= 20, `REFUSALS declares ${declared.length} ids (anti-vacuity: an empty map would make both directions below trivially true)`);
  ok(seenRefusals.size >= 20, `${seenRefusals.size} distinct refusals were actually produced by the scenarios above`);

  const unreachable = declared.filter((id) => !seenRefusals.has(id));
  ok(unreachable.length === 0,
    unreachable.length === 0
      ? 'every id declared in REFUSALS was produced by a scenario in this file'
      : `UNREACHABLE REFUSAL(S): ${unreachable.join(', ')} — either the precondition was removed (the deploy gate is now open on that case) or a scenario for it was never written. Both are the same red.`);

  const undeclared = [...seenRefusals].filter((id) => !declared.includes(id));
  ok(undeclared.length === 0,
    undeclared.length === 0
      ? 'every refusal produced is declared in REFUSALS'
      : `UNDECLARED REFUSAL(S): ${undeclared.join(', ')} — a refusal with no entry has no description for the operator.`);

  ok(Object.values(REFUSALS).every((v) => typeof v === 'string' && v.length > 10),
    'every refusal carries a real one-line description, not a placeholder');
  ok(new Set(Object.values(EXIT)).size === Object.keys(EXIT).length,
    'the exit codes are distinct, so an agent can branch on the outcome (REFUSED / CI_RED / CI_UNKNOWN are not the same number)');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ scripts/release.js refuses on every precondition it claims to');
