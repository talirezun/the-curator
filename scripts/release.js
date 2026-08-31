#!/usr/bin/env node
/**
 * release.js — cut a release of The Curator in one command, and REFUSE when a
 * precondition fails.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * Three facts about this project, each verified rather than assumed:
 *
 *   1. `main` has NO branch protection and NO rulesets — `gh api
 *      repos/talirezun/the-curator/branches/main/protection` returns
 *      {"message":"Branch not protected","status":"404"} and
 *      `gh api repos/talirezun/the-curator/rulesets` returns `[]`.
 *      So **a push to `main` IS the deploy.** CI is a report card that
 *      arrives afterwards and can block nothing.
 *   2. The in-app auto-updater (`POST /api/config/update`) runs
 *      `git fetch origin main` + `git reset --hard origin/main` + `npm install`
 *      + a `.app` rebuild. Whatever is on `main` reaches real machines on
 *      their next update check, green or red.
 *   3. Until now the release sequence lived only in CONTRIBUTING.md prose, and
 *      was performed by hand, differently, several times in one session — with
 *      a suite-count reconciliation, a changelog row, three version fields and
 *      a leanness ratchet all easy to forget in a different order.
 *
 * ── THE GATE ──────────────────────────────────────────────────────────────
 * Fact (1) is what a RELEASE BRANCH fixes, without a PR the maintainer would
 * be reviewing on himself:
 *
 *     release/vX.Y.Z  ->  push  ->  CI (~8 min)  ->  green?  ->  main ff's to it
 *
 * `main` therefore only ever receives a commit CI has already validated, and
 * the annotated tag is created AFTER the merge, on the commit `main` points
 * at — so a tag can never name a commit that failed CI. A red gate leaves
 * `main` untouched and the branch in place, so the fix is a commit ON TOP
 * rather than a re-cut.
 *
 * **The merge is `--ff-only`, and that is load-bearing rather than stylistic.**
 * A merge commit would make `main` a SHA that no CI run ever executed on,
 * which is precisely the property the gate exists to provide. `main` is always
 * the exact verified commit, byte for byte.
 *
 * **The gate is the `offline` job.** `.github/workflows/test.yml` gates `live`
 * to push-`main` plus manual dispatch, so it does not run on a release branch
 * at all — and that is the right split rather than a gap: `live` spends real
 * money, takes up to 20 minutes, and is DELIBERATELY flake-tolerant through
 * `scripts/ci-flake.js`. A required check designed to tolerate its own
 * transient failures is the wrong thing to block a green tree on. `live` still
 * runs on `main` after the merge, exactly as today; `--watch-main` waits for
 * it and reports, and never changes the exit code.
 *
 * ── THE OPERATOR'S FLOW ───────────────────────────────────────────────────
 *   1. Land the work on `main` (commits, tests green).
 *   2. Write the release's row into CLAUDE.md's full-row changelog table.
 *      Leave `- **Version:** X.Y.Z` ALONE — this script moves it, together
 *      with package.json and package-lock.json, so the three cannot disagree.
 *   3. `node scripts/release.js 3.29.0 --dry-run`   ← every check, no writes
 *   4. `node scripts/release.js 3.29.0 --yes`       ← the release
 *
 * ── WHAT IT DELIBERATELY WILL NOT DO ──────────────────────────────────────
 *   • It never force-pushes, never deletes a tag, and never moves a tag that
 *     already exists. `assertSafeCommand()` refuses those argv shapes
 *     structurally, so no code path can reach them by accident. The ONE
 *     deletion it performs is a merged `release/vX.Y.Z` branch, whose commit
 *     is reachable from both `main` and the tag; the exception is written as
 *     narrowly as that sentence and nothing else can satisfy it.
 *   • It never merges anything but `--ff-only`; that is refused structurally
 *     too, in the same place.
 *   • It has exactly ONE override, `--skip-tests`, and that override is LOUD:
 *     it prints a banner, and it is recorded permanently in the annotated tag
 *     message, so the release record itself says the gate was bypassed. There
 *     is no flag that makes a FAILING check pass.
 *   • It does not write the changelog row. A row is the only durable record of
 *     why a release exists; a generated one would be worthless.
 *   • It does not publish a GitHub Release. Tags are created now so that
 *     `electron-updater` has something to depend on later; wiring a
 *     tag-triggered release workflow before anything consumes it would be
 *     shipping an unwired parameter.
 *
 * ── THE INJECTED SEAM ─────────────────────────────────────────────────────
 * `release(argv, deps = null)` takes a trailing defaulted `deps` — the pattern
 * this repo already uses for `compile.js`'s `opts.generateText` and
 * `test-install-mode.js`'s recording exec. `deps` is NULL in production. The
 * guard suite (`scripts/test-release-preconditions.js`) injects a `run` that
 * RECORDS commands and executes none, so no test can ever git-push, tag, or
 * spend two minutes on `npm test`.
 *
 * As a second, non-cosmetic belt: when `CURATOR_RELEASE_TEST=1` is set in the
 * environment, `release()` THROWS if `deps` is null. The guard suite sets it
 * for its whole process, so a call site that forgot to inject cannot silently
 * fall through to the real git. That is a mechanism, not a source scan.
 *
 * Zero dependencies — node: builtins only.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

// ── Constants the checks are built from ───────────────────────────────────

/**
 * The only files a release commit is allowed to have dirty when the script
 * starts. Anything else modified or untracked means unfinished work is about
 * to be swept into a release commit, which is a refusal.
 *
 * CHANGELOG-ARCHIVE.md and CONTRIBUTING.md are here because a release that
 * archives an old row, or that adjusts the suite count, legitimately touches
 * them in the same change.
 */
export const RELEASE_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  'CHANGELOG-ARCHIVE.md',
  'CONTRIBUTING.md',
]);

/**
 * `.github/workflows/test.yml` runs three jobs. Two gate correctness; the
 * third is advisory BY DESIGN and its own in-file comment says so ("If branch
 * protection is ever added to `main`, explicitly EXCLUDE 'Dependency audit'
 * from the required-checks list to keep it advisory rather than blocking").
 *
 * A workflow RUN's conclusion is `failure` if ANY job failed, so reading the
 * run conclusion alone would report a red release when only the advisory
 * dependency audit went red. The CI watch therefore reads per-JOB conclusions
 * and treats the names below as advisory.
 */
export const ADVISORY_JOBS = Object.freeze(['Dependency audit (advisory)']);

/** Fallback only — the authoritative cap is parsed out of the suite below. */
const FULL_ROW_CAP_FALLBACK = 6;

/**
 * Every refusal this script can produce, with the one-line reason. The guard
 * suite asserts that each id here is REACHABLE (a refusal nothing can trigger
 * is a check that has stopped checking), so adding an entry without a code
 * path that produces it goes red.
 */
export const REFUSALS = Object.freeze({
  'bad-usage':                'the command line could not be understood',
  'bad-version':              'the target version is not plain semver X.Y.Z (no -beta suffixes — see the versioning policy)',
  'not-a-git-repo':           'not inside a git working tree',
  'wrong-branch':             'not on main — a push to main IS the deploy, so a release is cut from main',
  'dirty-tree':               'a file outside the release-metadata set is modified or untracked',
  'fetch-failed':             'git fetch origin main failed, so the remote state is unknown',
  'behind-remote':            'origin/main carries commits this checkout does not have',
  'diverged':                 'this checkout and origin/main have both moved — a release must be a fast-forward',
  'nothing-to-release':       'HEAD is already pushed and no release-metadata file is dirty',
  'version-not-forward':      'the target version is not greater than the current package.json version',
  'tag-exists':               'the tag for this version already exists — this script never moves or deletes a tag',
  'release-branch-exists':    'release/vX.Y.Z already exists locally or on origin — a re-cut would hide the first attempt',
  'ci-not-reachable':         'the workflow would not run on a release branch, so the CI gate would pass on nothing',
  'branch-create-failed':     'could not create or switch to the release branch',
  'remote-moved':             'origin/main advanced while CI ran, so main can no longer fast-forward to the CI-verified commit',
  'ff-failed':                'main could not be fast-forwarded to the release branch',
  'changelog-row-missing':    'CLAUDE.md has no full changelog row for the version being cut',
  'claude-version-line':      'CLAUDE.md does not carry exactly one `- **Version:** X.Y.Z` line',
  'version-fields-disagree':  'package.json, package-lock.json (both fields) and CLAUDE.md do not agree on one version',
  'leanness-cap-exceeded':    'CLAUDE.md carries more full changelog rows than the ratchet allows',
  'suite-counts-stale':       'scripts/check-doc-suite-counts.js failed — CONTRIBUTING.md disagrees with run-tests.js',
  'bump-failed':              'npm version --no-git-tag-version did not produce the expected version',
  'lock-diff-too-large':      'the version bump changed more of package-lock.json than the two version fields',
  'claude-rewrite-failed':    'rewriting CLAUDE.md\'s version line did not produce exactly the intended one-line change',
  'tests-failed':             'npm test went red',
  'unsafe-command':           'a command was constructed that this script refuses to run (force-push, tag move, delete)',
  'commit-message-refused':   'the derived commit subject would be rejected by .githooks/commit-msg',
  'not-confirmed':            'the operator did not confirm, and --yes was not passed',
  'commit-failed':            'git commit failed',
  'push-failed':              'git push failed',
  // NOTE: there is deliberately no 'tag-failed'. The tag is created AFTER main
  // has been pushed, so by then the release is live and a failed tag is a
  // WARNING with a retry command — reporting it as a failed release would be a
  // lie about what actually happened.
});

/** Exit codes — distinct so an agent can branch on the outcome. */
export const EXIT = Object.freeze({
  OK: 0,
  REFUSED: 1,        // stopped before anything irreversible
  CI_RED: 2,         // the gate went RED — main was NOT updated, nothing deployed
  CI_UNKNOWN: 3,     // the gate's outcome could not be observed — main NOT updated
});

/**
 * Jobs that run on `main` but not on a release branch, so the gate cannot see
 * them. Read `.github/workflows/test.yml`: the `live` job is gated to
 * push-`main` plus manual dispatch. It is therefore NOT part of the gate, and
 * that is deliberate rather than an oversight — see `--watch-main` below.
 */
export const POST_MERGE_ONLY_JOBS = Object.freeze(['Live API tests (Gemini + Anthropic)']);

/** The release branch for a version. One shape, used by every step. */
export const releaseBranchFor = (version) => `release/v${version}`;

// ── Command safety ────────────────────────────────────────────────────────

/**
 * Structural refusal of the argv shapes that are irreversible on a remote.
 * This is not advice in a comment — every command goes through `exec()`, which
 * calls this first, so there is no path in this file that can force-push or
 * remove a ref even if a future edit tries to build one.
 */
export function assertSafeCommand(argv) {
  const a = argv.map(String);
  const joined = a.join(' ');
  const bad = (why) => { const e = new Error(`refusing to run: ${joined} — ${why}`); e.refusal = 'unsafe-command'; throw e; };

  // The ONE deletion this script performs, and the exception is deliberately
  // as narrow as the job: a merged `release/vX.Y.Z` branch, whose commit is
  // reachable from BOTH `main` and the annotated tag, so nothing is orphaned.
  // Anything else — a branch not matching this shape, or a force-delete — is
  // refused, so the exception cannot widen into "this script deletes refs".
  const MERGED_RELEASE_BRANCH = /^release\/v\d+\.\d+\.\d+$/;
  const isReleaseBranchDeletion =
    a[0] === 'git' &&
    ((a[1] === 'push' && a[2] === 'origin' && a[3] === '--delete' && a.length === 5 && MERGED_RELEASE_BRANCH.test(a[4])) ||
     (a[1] === 'branch' && a[2] === '-d' && a.length === 4 && MERGED_RELEASE_BRANCH.test(a[3])));
  if (isReleaseBranchDeletion) return;

  if (a[0] !== 'git') return;                      // npm / gh carry none of these hazards
  if (a.includes('--force') || a.includes('-f') || a.includes('--force-with-lease')) {
    bad('this script never forces anything');
  }
  if (a[1] === 'push') {
    if (a.includes('--delete') || a.includes('-d')) bad('this script deletes no remote ref but a merged release/vX.Y.Z branch');
    // A leading '+' on a refspec is a force push spelled without --force.
    if (a.slice(2).some((t) => t.startsWith('+') || t.includes(':+'))) bad('a "+" refspec is a force push');
  }
  if (a[1] === 'branch' && (a.includes('-d') || a.includes('-D') || a.includes('--delete'))) {
    bad('this script deletes no branch but a merged release/vX.Y.Z, and never with -D');
  }
  if (a[1] === 'tag' && (a.includes('-d') || a.includes('--delete'))) bad('this script never deletes a tag');
  if (a[1] === 'merge' && !a.includes('--ff-only')) {
    bad('a release merge must be --ff-only, so main is the exact SHA CI verified');
  }
  if (a[1] === 'reset' && a.includes('--hard')) bad('this script never hard-resets the operator\'s checkout');
}

// ── Default (production) dependencies ─────────────────────────────────────

function realRun(argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // `stream: true` is used for `npm test`, whose value to the operator is
    // watching it run. Its exit status is still what the check reads.
    stdio: opts.stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) return { status: -1, stdout: '', stderr: String(r.error.message) };
  return { status: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function realPrompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function defaultDeps() {
  return {
    run: realRun,
    assertSafe: assertSafeCommand,
    readFile: (p) => readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), 'utf8'),
    writeFile: (p, s) => writeFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), s),
    exists: (p) => existsSync(path.isAbsolute(p) ? p : path.join(ROOT, p)),
    log: (line) => console.log(line),
    prompt: realPrompt,
    isTTY: () => Boolean(process.stdin.isTTY),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
  };
}

// ── Argument parsing ──────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = {
    version: null,
    dryRun: false,
    yes: false,
    push: true,
    watch: true,
    skipTests: false,
    keepBranch: false,
    watchMain: false,
    message: null,
    help: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--no-push') out.push = false;
    else if (a === '--no-watch') out.watch = false;
    else if (a === '--keep-branch') out.keepBranch = true;
    else if (a === '--watch-main') out.watchMain = true;
    else if (a === '--skip-tests') out.skipTests = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '-m' || a === '--message') { out.message = argv[++i] ?? null; if (out.message === null) out.error = 'missing value for --message'; }
    else if (a.startsWith('--message=')) out.message = a.slice('--message='.length);
    else if (a.startsWith('-')) out.error = `unrecognised option "${a}"`;
    else if (out.version === null) out.version = a;
    else out.error = `unexpected extra argument "${a}"`;
  }
  return out;
}

const USAGE = `
Usage:  node scripts/release.js <version> [options]

  <version>          plain semver X.Y.Z (no -beta suffixes)

  -n, --dry-run      run every check, write nothing, create and push nothing
  -y, --yes          do not prompt (required when not a TTY)
      --no-push      commit on the release branch locally, push nothing
      --no-watch     push the release branch but do NOT wait for CI. main is
                     left untouched — you must merge it yourself once green.
      --keep-branch  do not delete release/vX.Y.Z after a successful merge
      --watch-main   also wait for main's own run (which adds the paid live
                     suites). Advisory: it never changes the exit code.
      --skip-tests   LOUD override: skip npm test. Recorded in the tag message.
  -m, --message      commit subject (default: derived from the CLAUDE.md row)
  -h, --help         this text

THE GATE:  release/vX.Y.Z -> push -> CI -> green? -> main fast-forwards to it.
main only ever receives a commit CI has already validated, and the tag is
created AFTER the merge on the commit main points at, so a tag can never name
a commit that failed CI. A red gate leaves main untouched and the branch in
place, so the fix is a commit on top rather than a re-cut.

Before running: land the work on main, then write the release's row into
CLAUDE.md's full-row changelog table. Leave the "- **Version:**" line alone —
this script moves it together with package.json and package-lock.json.
`.trimStart();

// ── Small parsers over the repo's own files ───────────────────────────────

export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

export function cmpSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (!A || !B) return NaN;
  return (A.major - B.major) || (A.minor - B.minor) || (A.patch - B.patch);
}

/**
 * Rows of CLAUDE.md's FULL-ROW changelog table (header `| Commit | What it
 * fixed |`), as `{ id, row }`. The INDEX table below it has a different header
 * (`| Release | Headline …`) and is deliberately not read here: an index line
 * is a pointer, never the record, so a release whose only presence is an index
 * line has no row and must be refused.
 */
export function fullChangelogRows(claudeSrc) {
  const lines = claudeSrc.split('\n');
  const h = lines.findIndex((l) => /^\|\s*Commit\s*\|\s*What it fixed\s*\|/.test(l));
  if (h < 0) return null;
  if (!/^\|\s*-{2,}/.test(lines[h + 1] || '')) return null;
  const rows = [];
  for (let i = h + 2; i < lines.length; i++) {
    if (!lines[i].startsWith('| ')) break;
    const m = /^\|\s*`([^`]+)`\s*\|/.exec(lines[i]);
    rows.push({ id: m ? m[1] : null, row: lines[i] });
  }
  return rows;
}

/**
 * The headline of a changelog row: its first **bolded** run, cleaned of
 * markdown and clipped at a word boundary. Derived rather than stored, so
 * there is no second place for the release's one-line description to rot.
 */
export function headlineFromRow(row, limit = 72) {
  const m = /\*\*(.+?)\*\*/s.exec(row || '');
  if (!m) return null;
  let s = m[1]
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.:;,—-]+$/, '');
  if (!s) return null;
  if (s.length > limit) {
    const cut = s.slice(0, limit);
    const sp = cut.lastIndexOf(' ');
    s = (sp > limit * 0.5 ? cut.slice(0, sp) : cut).replace(/[.:;,—-]+$/, '');
  }
  return s || null;
}

/**
 * Would `.github/workflows/test.yml` actually run on a push to a release
 * branch? The whole gate rests on this, and the failure mode is the dangerous
 * kind: if the workflow were restricted to `main`, pushing a release branch
 * would produce NO run, the watch would time out, and — with a less careful
 * design than this one — the gate would "pass" on nothing at all.
 *
 * The check is deliberately conservative rather than a full YAML parse. Today
 * the trigger is a bare `push:` with only `paths-ignore`, which GitHub applies
 * to EVERY branch. If a `branches:` or `branches-ignore:` key ever appears
 * under it, this refuses and asks a human to look, rather than trying to
 * evaluate GitHub's glob semantics and getting it subtly wrong.
 *
 * @returns {{ok: boolean, reason: string}}
 */
export function ciReachesReleaseBranches(workflowSrc) {
  if (typeof workflowSrc !== 'string' || !workflowSrc.trim()) {
    return { ok: false, reason: '.github/workflows/test.yml is missing or empty — there is no CI to gate on' };
  }
  const lines = workflowSrc.split('\n');
  // Find the `on:` mapping, then the `push:` key inside it, then read that
  // key's own indented block.
  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIdx < 0) return { ok: false, reason: 'no top-level `on:` block found in .github/workflows/test.yml' };

  let pushIdx = -1, pushIndent = 0;
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') break;   // left the `on:` block
    const m = /^(\s+)push:\s*$/.exec(lines[i]);
    if (m) { pushIdx = i; pushIndent = m[1].length; break; }
  }
  if (pushIdx < 0) return { ok: false, reason: 'the workflow has no `push:` trigger, so pushing a release branch would run nothing' };

  for (let i = pushIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= pushIndent) break;                              // left the `push:` block
    if (/^\s*branches(-ignore)?\s*:/.test(line)) {
      return {
        ok: false,
        reason: `the push trigger carries "${line.trim()}" — a branch filter. ` +
                'Confirm by hand that it matches `release/v*`; this script will not ' +
                'guess at GitHub glob semantics on the one check the whole gate rests on.',
      };
    }
  }
  return { ok: true, reason: 'the push trigger carries no branch filter, so it fires on every branch' };
}

/** The leanness ratchet's cap, read from the suite that enforces it. */
export function readFullRowCap(suiteSrc) {
  const all = [...String(suiteSrc || '').matchAll(/const\s+CAP\s*=\s*(\d+)\s*;/g)];
  if (all.length !== 1) return { cap: FULL_ROW_CAP_FALLBACK, derived: false };
  return { cap: Number(all[0][1]), derived: true };
}

/**
 * The one shape .githooks/commit-msg refuses. Checked here so a derived
 * subject that would be bounced is reported as a refusal with a remedy,
 * rather than as a mysterious hook failure halfway through a release.
 */
export function commitSubjectRefusedReason(subject) {
  const s = String(subject || '');
  if (!s.replace(/\s/g, '')) return 'the commit subject is empty';
  if (/^\s*co-authored-by:/im.test(s)) return 'it carries a Co-Authored-By trailer';
  if (/generated with|co-created with|authored by (claude|chatgpt|copilot|gemini)|\u{1F916}/iu.test(s)) {
    return 'it carries a third-party attribution phrase';
  }
  return null;
}

// ── The release ───────────────────────────────────────────────────────────

/**
 * @param {string[]} argv   process.argv.slice(2)
 * @param {object|null} deps  TEST-ONLY seam. NULL in production.
 * @returns {Promise<{code:number, refusal:string|null, warnings:string[], commands:string[][]}>}
 */
export async function release(argv, deps = null) {
  if (process.env.CURATOR_RELEASE_TEST === '1' && deps === null) {
    throw new Error(
      'release() was called with no injected deps while CURATOR_RELEASE_TEST=1. ' +
      'The guard suite sets that variable precisely so an un-injected call ' +
      'cannot silently reach real git/npm/gh. Inject deps.'
    );
  }
  const d = { ...defaultDeps(), ...(deps || {}) };

  const commands = [];
  const warnings = [];
  const out = (l = '') => d.log(l);

  /**
   * Every external command goes through here: safety-checked, then recorded,
   * then run — in that order, so a refused argv never reaches `run`.
   *
   * The safety check is called through `d.assertSafe` rather than directly.
   * That is not decoration: with a direct call, DELETING the check leaves the
   * guard suite entirely green, because no code path in this file constructs
   * an unsafe command today — the check exists for the edit that has not been
   * made yet, and a guard whose removal nothing notices is not a guard. Going
   * through the seam lets the suite prove the check is WIRED (called once per
   * command, with that command's own argv) and that a refusal stops the
   * command before it runs. The default is the real function, so production
   * behaviour is unchanged.
   */
  const exec = (cmdArgv, opts = {}) => {
    d.assertSafe(cmdArgv);
    commands.push(cmdArgv.slice());
    return d.run(cmdArgv, opts);
  };

  let refusal = null;
  const refuse = (id, detail, remedy) => {
    refusal = id;
    out('');
    out(`✗ REFUSED (${id}) — ${REFUSALS[id] || 'no description'}`);
    if (detail) for (const line of String(detail).split('\n')) out(`    ${line}`);
    if (remedy) { out(''); out('  Do this:'); for (const line of String(remedy).split('\n')) out(`    ${line}`); }
    out('');
    return { code: EXIT.REFUSED, refusal: id, warnings, commands };
  };
  const step = (label) => out(`• ${label}`);
  const pass = (label) => out(`  ✓ ${label}`);
  const warn = (label) => { warnings.push(label); out(`  ⚠ ${label}`); };

  // ─────────────────────────────────────────────────────────────────────
  // 0. Arguments
  // ─────────────────────────────────────────────────────────────────────
  const opts = parseArgs(argv);
  if (opts.help) { out(USAGE); return { code: EXIT.OK, refusal: null, warnings, commands }; }
  if (opts.error) return refuse('bad-usage', opts.error, USAGE);
  if (!opts.version) return refuse('bad-usage', 'no version given', USAGE);
  if (!parseSemver(opts.version)) {
    return refuse('bad-version',
      `got "${opts.version}"`,
      'Use plain semver, e.g. 3.29.0. The -beta line was retired in v3.0.2:\n' +
      'it shipped 27 consecutive "previews" straight to production via the\n' +
      'auto-updater, so the suffix carried no meaning.');
  }
  const target = opts.version;
  const tag = `v${target}`;

  out('');
  out(`The Curator — release ${tag}${opts.dryRun ? '   [DRY RUN — nothing will be written or pushed]' : ''}`);
  out('─'.repeat(72));

  if (opts.skipTests) {
    out('');
    out('  ' + '!'.repeat(66));
    out('  !!  --skip-tests: the npm test gate is BYPASSED for this release.');
    out('  !!  `main` has no branch protection, so nothing downstream will');
    out('  !!  catch what this skips before it reaches users through the');
    out('  !!  auto-updater. This is recorded in the annotated tag message.');
    out('  ' + '!'.repeat(66));
    warnings.push('npm test was skipped via --skip-tests');
  }

  // ─────────────────────────────────────────────────────────────────────
  // 1. Git preconditions
  // ─────────────────────────────────────────────────────────────────────
  step('Repository state');

  const inRepo = exec(['git', 'rev-parse', '--is-inside-work-tree']);
  if (inRepo.status !== 0 || !/true/.test(inRepo.stdout)) {
    return refuse('not-a-git-repo', inRepo.stderr.trim() || inRepo.stdout.trim());
  }

  const branchR = exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchR.stdout.trim();
  if (branch !== 'main') {
    return refuse('wrong-branch',
      `on "${branch}"`,
      'git switch main    # then merge your work into it and re-run');
  }
  pass('on main');

  // Hooks are hygiene, not correctness, so this warns rather than refuses —
  // but it is worth saying, because the release commit is the one commit whose
  // attribution is most visible on a public repo.
  const hooksR = exec(['git', 'config', 'core.hooksPath']);
  if (hooksR.stdout.trim() !== '.githooks') {
    warn('core.hooksPath is not .githooks — the attribution and secret hooks will not run. ' +
         'Fix with: git config core.hooksPath .githooks');
  } else {
    pass('git hooks installed (.githooks)');
  }

  const statusR = exec(['git', 'status', '--porcelain']);
  if (statusR.status !== 0) return refuse('not-a-git-repo', statusR.stderr.trim());
  const dirty = statusR.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, '').replace(/^.*? -> /, ''));
  const strays = dirty.filter((f) => !RELEASE_FILES.includes(f));
  if (strays.length) {
    return refuse('dirty-tree',
      `these are modified or untracked and are not release-metadata files:\n  ${strays.join('\n  ')}`,
      'Commit them, stash them, or remove them. A release commit must contain\n' +
      'the release and nothing else — the alternative is unreviewed work\n' +
      'reaching every user through the auto-updater.');
  }
  pass(dirty.length
    ? `clean apart from the release-metadata files (${dirty.join(', ')})`
    : 'clean');

  const fetchR = exec(['git', 'fetch', 'origin', 'main']);
  if (fetchR.status !== 0) {
    return refuse('fetch-failed', fetchR.stderr.trim(),
      'Check the network and your remote, then re-run. Releasing without\n' +
      'knowing the remote state risks a non-fast-forward push.');
  }
  const countsR = exec(['git', 'rev-list', '--left-right', '--count', 'HEAD...origin/main']);
  const [aheadStr, behindStr] = countsR.stdout.trim().split(/\s+/);
  const ahead = Number(aheadStr), behind = Number(behindStr);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
    return refuse('fetch-failed', `could not read HEAD...origin/main counts (got "${countsR.stdout.trim()}")`);
  }
  if (behind > 0 && ahead > 0) {
    return refuse('diverged',
      `HEAD is ${ahead} ahead and ${behind} behind origin/main`,
      'git pull --rebase origin main    # then re-run');
  }
  if (behind > 0) {
    return refuse('behind-remote',
      `origin/main has ${behind} commit(s) this checkout does not`,
      'git pull --ff-only origin main    # then re-run');
  }
  if (ahead === 0 && dirty.length === 0) {
    return refuse('nothing-to-release',
      'HEAD equals origin/main and no release-metadata file is dirty',
      'Write the release row into CLAUDE.md first (see CONTRIBUTING.md\n' +
      '§ "Cutting a release"), or land the work you meant to release.');
  }
  pass(`up to date with origin/main (${ahead} commit(s) ahead, 0 behind)`);

  // ─────────────────────────────────────────────────────────────────────
  // 2. Version and tag
  // ─────────────────────────────────────────────────────────────────────
  step('Version');

  let pkg;
  try { pkg = JSON.parse(d.readFile('package.json')); }
  catch (e) { return refuse('version-fields-disagree', `package.json is not readable JSON: ${e.message}`); }
  const current = pkg.version;

  const alreadyBumped = current === target;
  if (!alreadyBumped && !(cmpSemver(target, current) > 0)) {
    return refuse('version-not-forward',
      `package.json is ${current}; you asked to cut ${target}`,
      `Pick a version greater than ${current}. PATCH for a normal release,\n` +
      'MINOR for a feature milestone.');
  }

  const tagLocal = exec(['git', 'tag', '--list', tag]);
  if (tagLocal.stdout.trim() === tag) {
    return refuse('tag-exists', `${tag} exists locally`,
      `That version has already been cut. Choose the next one.\n` +
      `This script never moves or deletes a tag — if ${tag} is genuinely\n` +
      'wrong, that is a deliberate manual decision, not a release step.');
  }
  const tagRemote = exec(['git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`]);
  if (tagRemote.status === 0 && tagRemote.stdout.trim()) {
    return refuse('tag-exists', `${tag} exists on origin`,
      'That version has already been cut and pushed. Choose the next one.');
  }
  pass(`${tag} does not exist locally or on origin`);

  // The release branch must not already exist. If it does, an earlier attempt
  // is sitting there — quite possibly one whose CI went red — and re-cutting
  // over it would hide that rather than fix it.
  const relBranch = releaseBranchFor(target);
  const branchLocal = exec(['git', 'branch', '--list', relBranch]);
  const branchRemote = exec(['git', 'ls-remote', '--heads', 'origin', `refs/heads/${relBranch}`]);
  if (branchLocal.stdout.trim() || (branchRemote.status === 0 && branchRemote.stdout.trim())) {
    return refuse('release-branch-exists',
      `${relBranch} exists ${branchLocal.stdout.trim() ? 'locally' : ''}${branchLocal.stdout.trim() && branchRemote.stdout.trim() ? ' and ' : ''}${branchRemote.stdout.trim() ? 'on origin' : ''}`,
      'An earlier attempt at this version is still open — very possibly one whose\n' +
      'CI went red. Fix it with a COMMIT ON TOP of that branch and push again,\n' +
      'which is what the gate is for. Re-cutting over it would hide the failure.\n' +
      `If it is genuinely stale: git branch -d ${relBranch} && git push origin --delete ${relBranch}`);
  }
  pass(`${relBranch} does not exist yet`);

  // The gate is only a gate if CI actually runs on the branch it watches.
  const wfPath = '.github/workflows/test.yml';
  const reach = ciReachesReleaseBranches(d.exists(wfPath) ? d.readFile(wfPath) : '');
  if (!reach.ok) {
    return refuse('ci-not-reachable', reach.reason,
      `Fix ${wfPath} so a push to \`${relBranch}\` triggers the workflow, then re-run.\n` +
      'Until then the gate would wait for a run that never starts — which is worse\n' +
      'than having no gate, because it looks like one.');
  }
  pass(`CI will run on ${relBranch} (${reach.reason})`);

  // ─────────────────────────────────────────────────────────────────────
  // 3. CLAUDE.md — the row, the version line, the ratchet
  // ─────────────────────────────────────────────────────────────────────
  step('CLAUDE.md');

  const claudeSrc = d.readFile('CLAUDE.md');
  const rows = fullChangelogRows(claudeSrc);
  if (rows === null) {
    return refuse('changelog-row-missing',
      'could not find the full-row table (header "| Commit | What it fixed |") in CLAUDE.md',
      'The table shape changed. Fix CLAUDE.md, or this script\'s parser.');
  }
  const row = rows.find((r) => r.id === tag);
  if (!row) {
    return refuse('changelog-row-missing',
      `no row whose first cell is \`${tag}\` in CLAUDE.md's full-row table\n` +
      `(newest rows present: ${rows.slice(0, 3).map((r) => r.id).join(', ')})`,
      `Add the ${tag} row to the top of that table first. A release without its\n` +
      'row is the one thing this project\'s memory cannot afford: the row is the\n' +
      'only durable record of what changed, why, and how it was verified.');
  }
  pass(`full changelog row for ${tag} present (${row.row.length} chars)`);

  const versionLineRe = /^- \*\*Version:\*\* (\d+\.\d+\.\d+)[ \t]*$/gm;
  const versionLines = [...claudeSrc.matchAll(versionLineRe)];
  if (versionLines.length !== 1) {
    return refuse('claude-version-line',
      `found ${versionLines.length} "- **Version:** X.Y.Z" lines (expected exactly 1)`,
      'Restore exactly one such line. scripts/test-next-recovery-and-badge.js\n' +
      'asserts it agrees with package.json, so a missing or duplicated line\n' +
      'would red npm test anyway.');
  }
  const claudeVersion = versionLines[0][1];

  // Two states are acceptable, and nothing between them: everything still on
  // the OLD version (this script moves all three together), or everything
  // already on the TARGET (someone pre-bumped). A half-bumped tree is the
  // exact drift that makes `npm test` go red mid-release for a reason that
  // reads like a test failure, so it is caught here with the remedy.
  const lockSrc = d.readFile('package-lock.json');
  let lock;
  try { lock = JSON.parse(lockSrc); }
  catch (e) { return refuse('version-fields-disagree', `package-lock.json is not readable JSON: ${e.message}`); }
  const lockTop = lock.version;
  const lockPkg = lock.packages && lock.packages[''] ? lock.packages[''].version : undefined;

  const fieldSet = new Set([current, lockTop, lockPkg, claudeVersion]);
  if (fieldSet.size !== 1) {
    return refuse('version-fields-disagree',
      `package.json = ${current}\n` +
      `package-lock.json (top level) = ${lockTop}\n` +
      `package-lock.json (packages[""]) = ${lockPkg}\n` +
      `CLAUDE.md "- **Version:**" = ${claudeVersion}`,
      'All four must read the same version before a release starts — either all\n' +
      `at the current version (this script moves them to ${target}) or all\n` +
      `already at ${target}. If the lock is the odd one out, that is v3.24.1's\n` +
      'bug: it sat six releases stale in both fields.');
  }
  pass(`package.json, both package-lock fields and CLAUDE.md all read ${current}`);

  const capInfo = readFullRowCap(
    d.exists('scripts/test-changelog-completeness.js')
      ? d.readFile('scripts/test-changelog-completeness.js') : '');
  if (!capInfo.derived) {
    warn(`could not read the leanness cap out of scripts/test-changelog-completeness.js — ` +
         `using the fallback of ${capInfo.cap}. npm test remains authoritative.`);
  }
  if (rows.length > capInfo.cap) {
    return refuse('leanness-cap-exceeded',
      `CLAUDE.md carries ${rows.length} full changelog rows against a cap of ${capInfo.cap}`,
      'Move the oldest row to CHANGELOG-ARCHIVE.md BYTE-FOR-BYTE and add one\n' +
      'index line for it in CLAUDE.md. npm test would red on this anyway —\n' +
      'this refusal just tells you now instead of two minutes from now.');
  }
  if (rows.length === capInfo.cap) {
    warn(`CLAUDE.md is AT the leanness cap (${rows.length} of ${capInfo.cap} full rows). ` +
         `This release still goes out, but THE NEXT ONE MUST ARCHIVE first: add its row ` +
         `and npm test goes red at ${capInfo.cap + 1}.`);
  } else {
    pass(`${rows.length} full changelog rows (cap ${capInfo.cap})`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 4. The bump — all three fields, together
  // ─────────────────────────────────────────────────────────────────────
  step(`Version bump ${current} → ${target}`);

  if (alreadyBumped) {
    pass('already at the target version — nothing to bump');
  } else if (opts.dryRun) {
    out(`  (dry run) would run: npm version --no-git-tag-version ${target}`);
    out(`  (dry run) would rewrite CLAUDE.md's version line to ${target}`);
    out('  (dry run) npm test below therefore runs against the CURRENT, self-consistent');
    out(`            tree at ${current} — which is exactly why this script refuses a`);
    out('            half-bumped tree above, so that this remains a true reading.');
  } else {
    // npm owns package-lock.json. Hand-editing it is what v3.24.1 had to do
    // very carefully; `npm version --no-git-tag-version` updates BOTH version
    // fields and creates no commit and no tag. Verified against a throwaway
    // repo with a dirty working tree: it does not require a clean tree.
    const bump = exec(['npm', 'version', '--no-git-tag-version', target]);
    if (bump.status !== 0) {
      return refuse('bump-failed', (bump.stderr || bump.stdout).trim(),
        `Restore with: git checkout -- package.json package-lock.json`);
    }
    // Re-read from disk. Never trust the command's own report.
    const pkg2 = JSON.parse(d.readFile('package.json'));
    const lock2 = JSON.parse(d.readFile('package-lock.json'));
    if (pkg2.version !== target || lock2.version !== target ||
        !lock2.packages || lock2.packages[''].version !== target) {
      return refuse('bump-failed',
        `after npm version: package.json=${pkg2.version}, lock.version=${lock2.version}, ` +
        `lock.packages[""].version=${lock2.packages && lock2.packages[''] && lock2.packages[''].version}`,
        'Restore with: git checkout -- package.json package-lock.json');
    }

    // v3.24.1 edited the lock DIRECTLY rather than regenerating it, because
    // `npm install --package-lock-only` can re-resolve the tree and this repo
    // ships through an auto-updater. `npm version` should touch only the two
    // version lines; this asserts that it did, rather than assuming it.
    const numstat = exec(['git', 'diff', '--numstat', '--', 'package.json', 'package-lock.json']);
    const lockStat = numstat.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => l.split(/\s+/))
      .find((p) => p[2] === 'package-lock.json');
    if (!lockStat || lockStat[0] !== '2' || lockStat[1] !== '2') {
      return refuse('lock-diff-too-large',
        `package-lock.json diff is +${lockStat ? lockStat[0] : '?'}/-${lockStat ? lockStat[1] : '?'} lines; ` +
        'exactly +2/-2 (the two version fields) was expected',
        'npm re-resolved the tree rather than only stamping the version. Restore\n' +
        'with: git checkout -- package.json package-lock.json\n' +
        'then bump the two "version" fields by hand, as v3.24.1 did (+2/-2).');
    }
    pass(`npm version wrote ${target} to package.json and both package-lock fields (+2/-2)`);

    // CLAUDE.md: exactly one line changes, and that is asserted rather than
    // hoped for. This file is ~700 KB of the project's memory; a regex that
    // matched more than intended would be a very expensive mistake.
    const before = claudeSrc;
    const after = before.replace(versionLineRe, `- **Version:** ${target}`);
    const bl = before.split('\n'), al = after.split('\n');
    const changedLines = bl.length === al.length
      ? bl.reduce((n, l, i) => n + (l === al[i] ? 0 : 1), 0)
      : -1;
    if (changedLines !== 1) {
      return refuse('claude-rewrite-failed',
        `rewriting the version line changed ${changedLines} line(s) (expected exactly 1)`,
        'Nothing was written. Fix CLAUDE.md by hand and re-run.');
    }
    d.writeFile('CLAUDE.md', after);
    const readBack = d.readFile('CLAUDE.md');
    const rb = [...readBack.matchAll(/^- \*\*Version:\*\* (\d+\.\d+\.\d+)[ \t]*$/gm)];
    if (rb.length !== 1 || rb[0][1] !== target) {
      return refuse('claude-rewrite-failed',
        `after writing, CLAUDE.md reads ${rb.length} version line(s)` +
        (rb.length ? ` and the first says ${rb[0][1]}` : ''),
        'Restore with: git checkout -- CLAUDE.md');
    }
    pass(`CLAUDE.md version line rewritten to ${target} (exactly one line changed)`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // 5. The document guards
  // ─────────────────────────────────────────────────────────────────────
  step('Documentation guards');

  const counts = exec([process.execPath, path.join(ROOT, 'scripts/check-doc-suite-counts.js')]);
  if (counts.status !== 0) {
    return refuse('suite-counts-stale',
      (counts.stdout + counts.stderr).split('\n').filter((l) => /✗|STALE|FATAL/.test(l)).join('\n')
        || 'check-doc-suite-counts.js exited non-zero',
      'CONTRIBUTING.md\'s "N suites total — N OFFLINE + N LIVE_CI + N LIVE_LOCAL"\n' +
      'line disagrees with scripts/run-tests.js. Correct the DOC to the measured\n' +
      'numbers printed above — never do that arithmetic by hand, and never edit\n' +
      'run-tests.js to match the doc.');
  }
  pass('CONTRIBUTING.md suite counts match scripts/run-tests.js');

  // ─────────────────────────────────────────────────────────────────────
  // 6. The test gate
  // ─────────────────────────────────────────────────────────────────────
  step('Test gate');
  if (opts.skipTests) {
    warn('npm test SKIPPED (--skip-tests)');
  } else {
    out('  running npm test …');
    const tests = exec(['npm', 'test'], { stream: true });
    if (tests.status !== 0) {
      return refuse('tests-failed',
        `npm test exited ${tests.status}`,
        (alreadyBumped || opts.dryRun
          ? 'Fix the failures and re-run.'
          : 'Fix the failures, then re-run. To undo this run\'s version bump:\n' +
            '  git checkout -- package.json package-lock.json CLAUDE.md'));
    }
    pass('npm test green');
  }

  // ─────────────────────────────────────────────────────────────────────
  // 7. Commit subject
  // ─────────────────────────────────────────────────────────────────────
  const headline = opts.message || (() => {
    const h = headlineFromRow(row.row);
    return h ? `${tag}: ${h}` : tag;
  })();
  const subjectProblem = commitSubjectRefusedReason(headline);
  if (subjectProblem) {
    return refuse('commit-message-refused',
      `subject: ${headline}\nreason: ${subjectProblem}`,
      'Pass an explicit subject with -m "…". .githooks/commit-msg would bounce\n' +
      'this one, and being bounced halfway through a release is worse than\n' +
      'being told now.');
  }

  // ─────────────────────────────────────────────────────────────────────
  // 8. Dry run stops here
  // ─────────────────────────────────────────────────────────────────────
  if (opts.dryRun) {
    out('');
    out('─'.repeat(72));
    out('DRY RUN COMPLETE — every check above ran; nothing was written, created or pushed.');
    out('');
    out('The real run would then:');
    out(`  1. npm version --no-git-tag-version ${target}   (package.json + both lock fields)`);
    out(`  2. rewrite CLAUDE.md's version line to ${target}`);
    out(`  3. git switch -c ${relBranch}   and commit -m "${headline}"`);
    if (!opts.push) {
      out('  4. (--no-push) nothing would be pushed; main would be untouched');
    } else {
      out(`  4. git push -u origin ${relBranch}`);
      if (!opts.watch) {
        out('  5. (--no-watch) stop there. main stays untouched until you merge it yourself.');
      } else {
        out(`  5. WAIT for CI on ${relBranch} — the gate (~8 min)`);
        out('     RED     -> stop. main untouched, branch kept, nothing deployed.');
        out('     GREEN   -> re-fetch, confirm main can still fast-forward, then:');
        out(`  6. git switch main && git merge --ff-only ${relBranch} && git push origin main`);
        out(`  7. git tag -a ${tag} on that same commit, and push it`);
        out(opts.keepBranch
          ? `  8. (--keep-branch) leave ${relBranch} in place`
          : `  8. delete ${relBranch} locally and on origin (its commit is reachable from main and ${tag})`);
        if (opts.watchMain) out("  9. (--watch-main) also wait for main's own run, advisory only");
      }
    }
    if (warnings.length) {
      out('');
      out('Warnings to read before you do:');
      for (const w of warnings) out(`  ⚠ ${w}`);
    }
    out('');
    return { code: EXIT.OK, refusal: null, warnings, commands };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 9. Confirmation
  // ─────────────────────────────────────────────────────────────────────
  if (!opts.yes) {
    if (!d.isTTY()) {
      return refuse('not-confirmed',
        'not a TTY and --yes was not passed',
        'Add --yes to release non-interactively. The flag is required rather\n' +
        'than assumed so an unattended script cannot push to main by omission.');
    }
    out('');
    out(opts.push
      ? `About to commit on ${relBranch} and push it. main moves ONLY if CI goes green.`
      : `About to commit on ${relBranch} locally. Nothing will be pushed.`);
    out(`  subject: ${headline}`);
    const answer = await d.prompt('Type the version to confirm: ');
    if (String(answer).trim() !== target) {
      return refuse('not-confirmed', `expected "${target}", got "${String(answer).trim()}"`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 10. Commit, tag, push
  // ─────────────────────────────────────────────────────────────────────
  step(`Release branch ${relBranch}`);
  const sw = exec(['git', 'switch', '-c', relBranch]);
  if (sw.status !== 0) {
    return refuse('branch-create-failed', (sw.stderr || sw.stdout).trim(),
      'Nothing has been committed. The version bump is still in your working tree;\n' +
      'undo it with: git checkout -- package.json package-lock.json CLAUDE.md');
  }
  pass(`created and switched to ${relBranch} (the bump came across uncommitted)`);

  step('Commit');
  const toAdd = RELEASE_FILES.filter((f) => d.exists(f));
  const add = exec(['git', 'add', '--', ...toAdd]);
  if (add.status !== 0) return refuse('commit-failed', add.stderr.trim());
  const commit = exec(['git', 'commit', '-m', headline]);
  if (commit.status !== 0) {
    return refuse('commit-failed', (commit.stderr || commit.stdout).trim(),
      'If .githooks refused it, fix the cause — do not reach for --no-verify.');
  }
  const shaR = exec(['git', 'rev-parse', 'HEAD']);
  const sha = shaR.stdout.trim();
  pass(`${sha.slice(0, 7)} ${headline}`);

  if (!opts.push) {
    out('');
    out('─'.repeat(72));
    out(`--no-push: ${relBranch} is committed LOCALLY. Nothing was pushed, main is`);
    out('untouched, and no tag exists — a tag is created only after a green gate.');
    out('When you are ready, re-run without --no-push, or drive it by hand:');
    out(`  git push -u origin ${relBranch}     # then wait for CI`);
    out(`  git switch main && git merge --ff-only ${relBranch} && git push origin main`);
    out(`  git tag -a ${tag} -m "The Curator ${tag}" && git push origin ${tag}`);
    out('');
    return { code: EXIT.OK, refusal: null, warnings, commands, sha, branch: relBranch };
  }

  step(`Push ${relBranch}`);
  const pushBranch = exec(['git', 'push', '-u', 'origin', relBranch]);
  if (pushBranch.status !== 0) {
    return refuse('push-failed', (pushBranch.stderr || pushBranch.stdout).trim(),
      `NOTHING has been deployed — main is untouched and no tag exists.\n` +
      `The commit is safe on ${relBranch}. Fix the cause and re-push that branch.`);
  }
  pass(`pushed ${relBranch} — main is still untouched`);

  // ─────────────────────────────────────────────────────────────────────
  // 11. THE GATE — CI on the release branch decides whether main moves
  // ─────────────────────────────────────────────────────────────────────
  if (!opts.watch) {
    out('');
    out('─'.repeat(72));
    out(`--no-watch: ${relBranch} is pushed and CI is running. main is UNTOUCHED and`);
    out('no tag exists. Nothing is deployed until you finish the merge yourself:');
    out('  https://github.com/talirezun/the-curator/actions');
    out(`  git switch main && git merge --ff-only ${relBranch} && git push origin main`);
    out(`  git tag -a ${tag} -m "The Curator ${tag}" && git push origin ${tag}`);
    out('');
    return { code: EXIT.OK, refusal: null, warnings, commands, sha, branch: relBranch };
  }

  step(`CI gate on ${relBranch}`);
  out('  This is the gate. main moves only if it goes green (~8 min).');
  const ci = await watchCi(sha, { exec, out, sleep: d.sleep, branch: relBranch });

  if (ci.state === 'red') {
    out('');
    out('─'.repeat(72));
    out(`✗ THE GATE REFUSED ${tag}. NOTHING HAS BEEN DEPLOYED.`);
    out(`  failing job(s): ${ci.failed.join(', ')}`);
    if (ci.url) out(`  ${ci.url}`);
    out('');
    out(`  main is untouched, no tag exists, and ${relBranch} is still there.`);
    out('  Fix it with a COMMIT ON TOP of that branch and push again — that is what');
    out('  the branch is for. Do not delete it and re-cut: a re-cut hides the failure,');
    out('  and this script refuses to release over an existing release branch.');
    out('');
    out('  When it is green:');
    out(`    git switch main && git merge --ff-only ${relBranch} && git push origin main`);
    out(`    git tag -a ${tag} -m "The Curator ${tag}" && git push origin ${tag}`);
    out('');
    return { code: EXIT.CI_RED, refusal: null, warnings, commands, sha, ci, branch: relBranch };
  }
  if (ci.state !== 'green') {
    out('');
    out('─'.repeat(72));
    out(`⚠ THE GATE'S OUTCOME COULD NOT BE OBSERVED: ${ci.reason}`);
    out('  main is untouched and no tag exists — an unobservable gate fails CLOSED,');
    out('  because the whole point is that main only ever receives a verified commit.');
    out('  Look for yourself: https://github.com/talirezun/the-curator/actions');
    out(`  If it is green: git switch main && git merge --ff-only ${relBranch} && git push origin main`);
    out('');
    return { code: EXIT.CI_UNKNOWN, refusal: null, warnings, commands, sha, ci, branch: relBranch };
  }
  pass('the gate is GREEN');
  if (ci.advisoryFailed.length) out(`  (advisory job(s) red, not gating: ${ci.advisoryFailed.join(', ')})`);
  if (ci.skipped.length) out(`  (not run on a release branch, by design: ${ci.skipped.join(', ')})`);

  // ─────────────────────────────────────────────────────────────────────
  // 12. Fast-forward main to the exact commit CI verified
  // ─────────────────────────────────────────────────────────────────────
  step('Merge to main');

  // CI took minutes. Someone may have pushed to main in the meantime, and if
  // they did, main can no longer fast-forward to this commit. Rebasing onto
  // the new main would produce a SHA CI has never seen, which destroys the one
  // property this whole gate exists to provide — so it refuses instead.
  const refetch = exec(['git', 'fetch', 'origin', 'main']);
  if (refetch.status !== 0) {
    return refuse('fetch-failed', refetch.stderr.trim(),
      `The gate was green and ${relBranch} is pushed. Nothing is deployed.\n` +
      `Re-run the merge by hand once the network is back:\n` +
      `  git switch main && git merge --ff-only ${relBranch} && git push origin main`);
  }
  const ancestor = exec(['git', 'merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
  if (ancestor.status !== 0) {
    return refuse('remote-moved',
      'origin/main is no longer an ancestor of the release commit — someone pushed while CI ran',
      `NOTHING has been deployed. ${relBranch} is pushed and CI-green at ${sha.slice(0, 7)}.\n` +
      'Do NOT force and do NOT rebase this branch onto the new main: rebasing\n' +
      'produces a commit CI has never seen, which is exactly the property this\n' +
      'gate exists to hold. Instead, merge the new main INTO the release branch\n' +
      'and let CI run again on the result:\n' +
      `  git merge origin/main            # you are on ${relBranch}\n` +
      `  git push origin ${relBranch}\n` +
      '  # wait for that run to go green, then:\n' +
      `  git switch main && git merge --ff-only ${relBranch} && git push origin main\n` +
      `  git tag -a ${tag} -m "The Curator ${tag}" && git push origin ${tag}`);
  }
  pass('origin/main has not moved — the release commit is a clean fast-forward');

  const backToMain = exec(['git', 'switch', 'main']);
  if (backToMain.status !== 0) {
    return refuse('ff-failed', (backToMain.stderr || backToMain.stdout).trim(),
      `Nothing deployed. Finish by hand:\n  git switch main && git merge --ff-only ${relBranch} && git push origin main`);
  }
  const ff = exec(['git', 'merge', '--ff-only', relBranch]);
  if (ff.status !== 0) {
    return refuse('ff-failed', (ff.stderr || ff.stdout).trim(),
      'Nothing deployed. A release merge is fast-forward ONLY — a merge commit\n' +
      'would make main a SHA that CI never ran on. Investigate rather than\n' +
      'reaching for a plain `git merge`.');
  }
  const mainSha = exec(['git', 'rev-parse', 'HEAD']).stdout.trim();
  if (mainSha !== sha) {
    return refuse('ff-failed',
      `main is at ${mainSha.slice(0, 7)} but CI verified ${sha.slice(0, 7)}`,
      'The fast-forward reported success and did not land on the verified commit.\n' +
      'Nothing has been pushed. Investigate before doing anything else.');
  }
  pass(`main fast-forwarded to ${sha.slice(0, 7)} — the exact commit CI verified`);

  const pushMain = exec(['git', 'push', 'origin', 'main']);
  if (pushMain.status !== 0) {
    return refuse('push-failed', (pushMain.stderr || pushMain.stdout).trim(),
      'Nothing deployed. If this was rejected as non-fast-forward, someone pushed\n' +
      'in the last few seconds. Do NOT force. Re-run:\n' +
      `  git fetch origin main   # then re-check, or merge origin/main into ${relBranch} and re-gate`);
  }
  pass('pushed main — this release is now live for every auto-updater client');

  // ─────────────────────────────────────────────────────────────────────
  // 13. Tag — AFTER the merge, on the commit main points at
  // ─────────────────────────────────────────────────────────────────────
  step('Tag');
  const tagBody = [
    `The Curator ${tag}`,
    '',
    `Cut by scripts/release.js on ${d.now().toISOString()}.`,
    `Gated on CI at ${relBranch}; main fast-forwarded to ${sha}.`,
    opts.skipTests
      ? 'WARNING: cut with --skip-tests. The local npm test gate was BYPASSED for this release.'
      : 'npm test: green (offline suites, locally).',
    ...(warnings.length ? ['', 'Warnings at release time:', ...warnings.map((w) => `  - ${w}`)] : []),
  ].join('\n');
  const tagR = exec(['git', 'tag', '-a', tag, '-m', tagBody]);
  if (tagR.status !== 0) {
    warn(`main is pushed but creating ${tag} failed: ${(tagR.stderr || tagR.stdout).trim()}. ` +
         `Create and push it by hand: git tag -a ${tag} -m "The Curator ${tag}" && git push origin ${tag}`);
  } else {
    pass(`annotated tag ${tag} created on the merged commit`);
    const pushTag = exec(['git', 'push', 'origin', tag]);
    if (pushTag.status !== 0) {
      warn(`main is pushed but the tag push failed: ${(pushTag.stderr || pushTag.stdout).trim()}. ` +
           `Retry with: git push origin ${tag}`);
    } else {
      pass(`pushed ${tag}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 14. The release branch has done its job
  // ─────────────────────────────────────────────────────────────────────
  if (opts.keepBranch) {
    out(`  (--keep-branch) ${relBranch} left in place`);
  } else {
    // Safe to delete: this commit is reachable from BOTH main and the
    // annotated tag, so nothing is orphaned and the branch carries no history
    // of its own. `-d` (never `-D`) additionally refuses an unmerged branch,
    // so the local delete is itself a check that the merge really happened.
    const delLocal = exec(['git', 'branch', '-d', relBranch]);
    const delRemote = delLocal.status === 0 ? exec(['git', 'push', 'origin', '--delete', relBranch]) : null;
    if (delLocal.status !== 0) {
      warn(`could not delete ${relBranch} locally: ${(delLocal.stderr || delLocal.stdout).trim()}. Harmless — delete it when convenient.`);
    } else if (delRemote && delRemote.status !== 0) {
      warn(`deleted ${relBranch} locally but not on origin: ${(delRemote.stderr || delRemote.stdout).trim()}. ` +
           `Tidy up with: git push origin --delete ${relBranch}`);
    } else {
      pass(`deleted ${relBranch} (its commit lives on in main and in ${tag})`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 15. main's own run — ADVISORY, never the gate
  // ─────────────────────────────────────────────────────────────────────
  let mainCi = null;
  if (opts.watchMain) {
    step("main's own run (advisory)");
    // Everything the gate checked has already passed on this exact SHA. The
    // only NEW information here is the `live` job, which spends real money,
    // takes up to 20 minutes, and is explicitly flake-tolerant via
    // scripts/ci-flake.js. Blocking a release on a check designed to tolerate
    // its own transient failures is the failure mode to avoid, so this never
    // changes the exit code.
    mainCi = await watchCi(sha, { exec, out, sleep: d.sleep, branch: 'main' });
    if (mainCi.state === 'red') {
      warn(`main's own run went red on: ${mainCi.failed.join(', ')}. ${mainCi.url || ''} ` +
           (mainCi.failed.some((f) => POST_MERGE_ONLY_JOBS.some((j) => f.startsWith(j)))
             ? 'That is the LIVE suite, which the gate deliberately does not include and which ' +
               'scripts/ci-flake.js tolerates transient failures from — re-run it before treating it as real.'
             : 'That job also ran GREEN on the release branch at this exact SHA, so this is infrastructure ' +
               'or flake rather than the tree. If it reproduces, see CONTRIBUTING.md § "When a release is bad".'));
    } else if (mainCi.state === 'green') {
      pass("main's own run is green, live suites included");
    } else {
      warn(`main's own run could not be observed: ${mainCi.reason}`);
    }
  }

  out('');
  out('─'.repeat(72));
  out(`✓ ${tag} released. main is the exact commit CI verified (${sha.slice(0, 7)}).`);
  if (!opts.watchMain) {
    out("  main's own run (which adds the paid live suites) is starting now:");
    out('  https://github.com/talirezun/the-curator/actions');
  }
  if (warnings.length) { out(''); for (const w of warnings) out(`  ⚠ ${w}`); }
  out('');
  return { code: EXIT.OK, refusal: null, warnings, commands, sha, ci, mainCi, branch: relBranch };
}

// ── CI watch ──────────────────────────────────────────────────────────────

/**
 * Poll `gh` for the workflow run belonging to `sha`, then read its PER-JOB
 * conclusions. Reading the run's own conclusion would report a red release
 * whenever the advisory dependency audit went red, which is the one job the
 * workflow's own comment says must never gate anything.
 *
 * Degrades rather than fails: `gh` missing, unauthenticated, or simply slow
 * yields state 'unknown'. The push has already happened by the time this runs,
 * so turning an observation problem into a release failure would misreport
 * what actually occurred.
 */
export async function watchCi(sha, { exec, out, sleep, branch = 'main', maxWaitMs = 25 * 60_000, pollMs = 15_000, appearMs = 120_000 }) {
  const advisoryFailed = [];
  const skipped = [];
  const which = exec(['gh', '--version']);
  if (which.status !== 0) {
    return { state: 'unknown', reason: 'gh is not installed or not on PATH', advisoryFailed, skipped, failed: [] };
  }

  // Bounded by ATTEMPTS, not by wall clock. A wall-clock loop spins as fast as
  // the machine allows whenever the sleep is short or instant — which is not
  // only a test artefact: a `sleep` that returns early for any reason turns a
  // two-minute wait into millions of `gh` invocations. Attempts are also what
  // makes this deterministic to test.
  const appearAttempts = Math.max(1, Math.ceil(appearMs / pollMs));
  const pollAttempts = Math.max(1, Math.ceil(maxWaitMs / pollMs));
  let runId = null, url = null;

  for (let attempt = 0; attempt < appearAttempts && runId === null; attempt++) {
    const list = exec(['gh', 'run', 'list', '--branch', branch, '--limit', '10',
                       '--json', 'databaseId,headSha,status,conclusion,url']);
    if (list.status !== 0) {
      return { state: 'unknown', reason: `gh run list failed: ${(list.stderr || '').trim()}`, advisoryFailed, skipped, failed: [] };
    }
    let runs = [];
    try { runs = JSON.parse(list.stdout || '[]'); } catch { runs = []; }
    const mine = runs.find((r) => r.headSha === sha);
    if (mine) { runId = mine.databaseId; url = mine.url; break; }
    out(`  waiting for a CI run on ${sha.slice(0, 7)} …`);
    await sleep(pollMs);
  }

  if (runId === null) {
    return {
      state: 'unknown',
      reason: `no workflow run appeared for ${sha.slice(0, 7)} within ${appearAttempts} poll(s) / ~${Math.round(appearMs / 1000)}s ` +
              '(note: .github/workflows/test.yml sets paths-ignore for **.md and docs/**, ' +
              'though a release always touches package.json and so should trigger)',
      advisoryFailed, skipped, failed: [],
    };
  }
  out(`  run ${runId}: ${url}`);

  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    const view = exec(['gh', 'run', 'view', String(runId), '--json', 'status,conclusion,jobs']);
    if (view.status !== 0) {
      return { state: 'unknown', reason: `gh run view failed: ${(view.stderr || '').trim()}`, url, advisoryFailed, skipped, failed: [] };
    }
    let run;
    try { run = JSON.parse(view.stdout || '{}'); } catch { run = {}; }
    const jobs = Array.isArray(run.jobs) ? run.jobs : [];
    if (run.status === 'completed') {
      const failed = [];
      for (const j of jobs) {
        // A job that did not run is REPORTED, not silently treated as passing.
        // On a release branch the `live` job is skipped by its own `if:`, and
        // the gate must say which checks it did not see rather than implying
        // it saw them all.
        if (j.conclusion === 'skipped' || (j.status === 'completed' && !j.conclusion)) { skipped.push(j.name); continue; }
        if (j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'neutral') {
          (ADVISORY_JOBS.includes(j.name) ? advisoryFailed : failed).push(`${j.name} (${j.conclusion})`);
        }
      }
      // No job list at all is not evidence of success — fall back to the run's
      // own conclusion rather than reporting green off an empty array.
      if (jobs.length === 0) {
        return run.conclusion === 'success'
          ? { state: 'green', url, advisoryFailed, skipped, failed: [] }
          : { state: 'unknown', reason: `run concluded "${run.conclusion}" but reported no jobs`, url, advisoryFailed, skipped, failed: [] };
      }
      return failed.length
        ? { state: 'red', url, failed, advisoryFailed, skipped }
        : { state: 'green', url, failed: [], advisoryFailed, skipped };
    }
    const running = jobs.filter((j) => j.status !== 'completed').map((j) => j.name);
    out(`  ${run.status}${running.length ? ` — ${running.join(', ')}` : ''}`);
    await sleep(pollMs);
  }
  return { state: 'unknown', reason: `still running after ${pollAttempts} poll(s) / ~${Math.round(maxWaitMs / 60000)} minutes`, url, advisoryFailed, skipped, failed: [] };
}

// ── CLI entry ─────────────────────────────────────────────────────────────
// The seam defaults to null here: production injects nothing.

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  release(process.argv.slice(2))
    .then((r) => process.exit(r.code))
    .catch((e) => {
      console.error('');
      console.error(`✗ release aborted: ${e && e.message ? e.message : e}`);
      if (e && e.refusal) console.error(`  (${e.refusal})`);
      console.error('');
      process.exit(EXIT.REFUSED);
    });
}
