#!/usr/bin/env node
/**
 * test-working-state-sync.js — OFFLINE battle test for the ONE claim the
 * memory layer rests on and that nothing had ever executed:
 *
 *   "The `<machine>` segment is NOT decorative. This folder SYNCS ... Sync
 *    resolves with `git pull -X theirs`, which on a CONFLICTING HUNK keeps
 *    origin and discards the local write, silently. A per-machine path means
 *    two machines never write the same file, so there is no conflicting hunk
 *    and nothing is discarded. Do not collapse this segment."
 *        — src/brain/working-state.js module docblock (also docs/working-state.md,
 *          also the CLAUDE.md v3.17.0 row, which records that a bare hostname
 *          "DESTROYED EACH OTHER'S HANDOFF ... three hours of a session, gone")
 *
 * WHY THIS SUITE EXISTS. Every working-state suite to date simulates "another
 * machine" by PLANTING a folder — `saveWorkingState(P, { machine: 'boxb' })`
 * against one filesystem. That tests the reader's arithmetic. It cannot test
 * the merge, because there is no second repository, no divergent history and
 * no merge driver anywhere in it. So the data-loss MECHANISM the whole design
 * exists to prevent — the thing that justifies a path segment appearing in
 * every state path, in the index, in the MCP payload and in three documents —
 * had never once been run. This suite runs it, with REAL git: real clones, a
 * real bare remote, real divergent commits, and the app's OWN `push()`/`pull()`
 * rather than a hand-written `git merge` that could quietly differ from what
 * ships.
 *
 * WHAT IT PROVES
 *   §1  THE GUARANTEE. Two clones with DIFFERENT machine identities writing the
 *       same scope from the same base commit: both handoffs survive a full
 *       round-trip, byte-identical, both addressable by name. No conflict.
 *   §2  THE POSITIVE CONTROL — the half that makes §1 mean something. Force
 *       the two clones to share ONE machine folder (the pre-v3.17.0 bare-
 *       hostname layout) and run the IDENTICAL sequence. Data loss reproduces,
 *       silently, exit 0, clean tree. Without this, §1 is compatible with a
 *       segment that does nothing and the design's central justification would
 *       be unevidenced. §1 and §2 together are the mutation pair: one variable
 *       changed — whether the machine segment distinguishes — and §1 asserts as
 *       a precondition that the pre-v3.17.0 identity (`hostSlug()`) is
 *       IDENTICAL on both machines, so §2's collapsed layout is exactly what
 *       those two computers would have had before the install id existed.
 *   §3  THE DOCUMENTED EXCEPTION, pinned. `state/project.md` (tier 1) has no
 *       machine segment, and working-state.js says so in its own docblock:
 *       "THAT ARGUMENT COVERS TIERS 2 AND 3 ONLY ... two machines that both
 *       edit the brief DO produce the conflicting hunk". Proven, so nobody
 *       later "simplifies" tiers 2/3 into the brief's layout believing the
 *       per-machine argument covers it — and so nobody adds a second frequent
 *       writer to the brief without seeing what that costs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT MEASUREMENT CHANGED — the docs are RIGHT that the segment is
 * load-bearing, and UNDERSTATE what happens without it
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Three documents describe the failure as "`-X theirs` keeps origin and
 * discards the local write" — one handoff replaced by the other. That is only
 * ONE of the two outcomes, and it is the milder one. `-X theirs` is not "take
 * their whole file"; it is a conflict-resolution PREFERENCE inside an ordinary
 * three-way line merge. It applies only to hunks BOTH sides changed. A hunk
 * only ONE side touched merges in cleanly from that side, `-X theirs`
 * notwithstanding.
 *
 * So when one machine leaves a section unchanged since the common ancestor —
 * which is the NORMAL case for "Firm decisions — do not re-litigate", a
 * section whose entire purpose is to persist across saves, and which the
 * capture skill instructs every save to re-send in full — the merge SPLICES.
 * Measured in §2b: the resulting current.md carries machine A's headline,
 * A's provenance line, A's timestamp and A's prose, with machine B's firm
 * decisions substituted in. A document that existed on neither computer,
 * correctly formatted, internally coherent, misattributed by its own header,
 * and flagged by nothing: `headingsSuspect` is false and `sanitisedOnRead` is
 * false, because both of those detect a MALFORMED file and this one is
 * perfectly well formed. §3b shows the same mechanism on the standing brief,
 * where it is worse still, because the brief is returned on EVERY read.
 *
 * A destroyed handoff at least leaves a self-consistent document and a human
 * who notices their work is missing. A spliced one is the thing the next agent
 * acts on. Both are reproduced below; neither is currently documented.
 *   §4  THE JOURNAL across machines: append-only, per-machine, no loss and no
 *       duplication through a round-trip — and (in the collapsed layout) lost
 *       alongside current.md, which is the "and the journal with it" clause of
 *       the v3.17.0 finding.
 *   §5  THE PREMISES the argument silently depends on: that `state/` is
 *       genuinely TRACKED (if it were gitignored none of this would matter),
 *       and that `.curator-install-id` is NOT in the synced tree (committing
 *       it makes two clones resolve to the SAME machine folder and re-creates
 *       §2 — recorded in CLAUDE.md as the fifth instance of that class).
 *       Plus deletion propagation, measured rather than assumed.
 *
 * METHOD NOTES — why it is built this way
 *
 *  - THE STORE IS DRIVEN, NEVER FORGED. Every state file here is produced by
 *    the real `saveWorkingState` / `saveProjectBrief`. Hand-writing the
 *    markdown would test a shape the product cannot emit — a trap this repo
 *    hit in this very release cycle, where a count probe returned all zeros
 *    because its fixtures were forged into an impossible shape.
 *  - THE TWO IDENTITIES ARE REAL. Machine A and machine B differ the way two
 *    real installations differ: same hostname, different `.curator-install-id`
 *    in different user-data directories. `machineId()` is not stubbed. §1
 *    asserts as a PRECONDITION that the two hostnames DO collide, so the run
 *    is genuinely the collision case the install id exists to survive — a
 *    green §1 on two machines with different hostnames would prove nothing.
 *  - ASSERT ON CONTENT, NEVER ON AN EXIT CODE. `-X theirs` discarding a side
 *    is a SUCCESS as far as git is concerned; the silence is the entire point
 *    of the finding. Every loss assertion here compares sha256 of file
 *    content, and mtime is never consulted.
 *  - NO grep FOR NEGATIVES. This machine has returned false zero-hits for a
 *    pattern that was present 11 times; every "X is absent" assertion below
 *    reads the file and tests the string in-process.
 *
 * ISOLATION. Both test seams are set: the env pair (`CURATOR_TEST_USER_DATA_DIR`
 * / `CURATOR_TEST_DOMAINS_DIR`) as a floor before any brain module is imported,
 * so a path that somehow bypassed an override still lands in a tempdir rather
 * than the maintainer's real second brain; and the in-process overrides
 * (`__setUserDataDirOverride` / `__setDomainsDirOverride` / sync.js's
 * `__setSyncTestOverrides`), which outrank the env and are what switch between
 * machine A and machine B. The real `domains/`, `.curator-config.json`,
 * `.knowledge-git` and `.sync-config.json` are never referenced.
 *
 * Pure offline: no network, no API key, no GitHub. The "remote" is a local
 * `git init --bare`. Runs in `npm test` on a machine with no credentials.
 *
 * Run: node scripts/test-working-state-sync.js
 * Exit 0 if all green; 1 on any failure.
 */

import { execSync } from 'child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';

// ── Isolation floor. MUST precede every brain import: paths.js memoises its
// install-form detection on first resolve, and we never want that first
// resolve to be the real repo root.
const ENV_FLOOR = await mkdtemp(path.join(tmpdir(), 'wss-envfloor-'));
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(ENV_FLOOR, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(ENV_FLOOR, 'domains');
await mkdir(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });
await mkdir(process.env.CURATOR_TEST_DOMAINS_DIR, { recursive: true });

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
const {
  __setSyncTestOverrides, push, pull, __testing: syncTesting,
} = await import('../src/brain/sync.js');
const {
  saveWorkingState, saveProjectBrief, readWorkingState, listScopeMachines,
  machineId, hostSlug, installId, installIdAvailable, __resetInstallIdCache,
  STATE_DIRNAME, BRIEF_FILENAME, CURRENT_FILENAME, JOURNAL_FILENAME,
} = await import('../src/brain/working-state.js');

const { DOMAINS_GITIGNORE_RULES } = syncTesting;

// ── Reporting ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) {
  failed++; failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail !== undefined) console.log(`    └─ ${detail}`);
}
function assertTrue(cond, label, detail) { return cond ? ok(label) : fail(label, detail); }
function assertEq(actual, expected, label) {
  if (actual === expected) return ok(label);
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(title) { console.log(`\n${title}\n`); }

// ── Tempdir registry. A single variable that gets reassigned per scenario is
// how this repo once accumulated 37,353 stale temp directories; every dir this
// run creates is pushed here and swept in a finally that runs BEFORE exit.
const cleanupDirs = [ENV_FLOOR];
async function mktemp(prefix) {
  const d = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}
async function sweep() {
  for (const d of cleanupDirs) {
    try { await rm(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── git helpers ─────────────────────────────────────────────────────────────
// Repo-local config so nothing here depends on the developer's global git
// settings: identity (or a commit fails outright), gpgsign off (a global
// commit.gpgsign=true would invoke gpg on every commit in this suite), and
// autocrlf off so content hashes are line-ending independent.
function sh(gitDir, workTree, cmd) {
  return execSync(
    `git --git-dir="${gitDir}" --work-tree="${workTree}" ${cmd}`,
    { stdio: 'pipe' },
  ).toString('utf8');
}
function configureRepo(gitDir, workTree) {
  sh(gitDir, workTree, 'config user.email "sync-test@example.invalid"');
  sh(gitDir, workTree, 'config user.name "Sync Test"');
  sh(gitDir, workTree, 'config commit.gpgsign false');
  sh(gitDir, workTree, 'config tag.gpgsign false');
  sh(gitDir, workTree, 'config core.autocrlf false');
}
async function makeBareRemote() {
  const dir = await mktemp('wss-remote-');
  execSync(`git init -q --bare -b main "${dir}"`, { stdio: 'pipe' });
  return dir;
}
function trackedFiles(gitDir, workTree) {
  return execSync(
    `git -c core.quotePath=false --git-dir="${gitDir}" --work-tree="${workTree}" ls-files`,
    { stdio: 'pipe' },
  ).toString('utf8').split('\n').filter(Boolean);
}
function porcelain(gitDir, workTree) {
  return sh(gitDir, workTree, 'status --porcelain').trim();
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function readText(p) {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

/**
 * One simulated computer: its own clone, its own work-tree (the domains dir),
 * its own sync config, and — the part that matters — its OWN user-data dir
 * holding its OWN .curator-install-id. That file is what makes machineId()
 * differ between two boxes whose hostnames are identical, which is the exact
 * situation the v3.17.0 finding describes (two default-named macOS laptops).
 */
async function makeMachine(tag, remoteDir, { installIdHex, clone = false } = {}) {
  const gitDir = await mktemp(`wss-git-${tag}-`);
  const domainsDir = await mktemp(`wss-domains-${tag}-`);
  const userData = await mktemp(`wss-ud-${tag}-`);
  const configFile = path.join(await mktemp(`wss-cfg-${tag}-`), 'sync-config.json');
  await writeFile(configFile, JSON.stringify({ repoUrl: remoteDir, token: '' }));
  // The install id lives OUTSIDE the synced tree, in user-data — see §5.
  if (installIdHex) await writeFile(path.join(userData, '.curator-install-id'), `${installIdHex}\n`);

  if (clone) {
    sh(gitDir, domainsDir, 'init -q -b main');
    configureRepo(gitDir, domainsDir);
    sh(gitDir, domainsDir, `remote add origin "${remoteDir}"`);
    sh(gitDir, domainsDir, 'fetch origin -q');
    sh(gitDir, domainsDir, 'checkout -q -B main origin/main');
  } else {
    sh(gitDir, domainsDir, 'init -q -b main');
    configureRepo(gitDir, domainsDir);
    sh(gitDir, domainsDir, `remote add origin "${remoteDir}"`);
  }
  return { tag, gitDir, domainsDir, userData, configFile, remoteDir };
}

/** Point every seam at this machine. Called before any store or sync call. */
function activate(m) {
  __setUserDataDirOverride(m.userData);
  __setDomainsDirOverride(m.domainsDir);
  __setSyncTestOverrides({ gitDir: m.gitDir, configFile: m.configFile });
  __resetInstallIdCache();   // the cache is keyed on dir, but be explicit
}

/** A minimal but REAL domain — CLAUDE.md is required or checkProjectWritable
 *  refuses, and sync.pull()'s pruneGhostDomainDirs() would rm -rf the folder. */
async function seedDomain(domainsDir, slug) {
  await mkdir(path.join(domainsDir, slug, 'wiki'), { recursive: true });
  await writeFile(path.join(domainsDir, slug, 'CLAUDE.md'), '# schema\n');
  await writeFile(path.join(domainsDir, slug, 'wiki', 'index.md'), '# index\n');
}

const PROJECT = 'memtest';

/** A handoff big enough to clear MIN_PROTECTED_BODY_BYTES (1024) so the D1
 *  near-empty guard never fires and refuses a save mid-scenario. */
function handoff(who, n, over = {}) {
  return {
    headline: `handoff from ${who} #${n}`,
    nowState: `${who} was here at ${n}. `.repeat(120),
    decisions: [`${who} decided thing ${n}`, `${who} decided another thing`],
    traps: [`${who} hit trap ${n}`],
    nextSteps: [`${who} next step ${n}`],
    ...over,
  };
}

function statePath(domainsDir, scope, machine, file = CURRENT_FILENAME) {
  return path.join(domainsDir, PROJECT, STATE_DIRNAME, scope, machine, file);
}

console.log('\n=== working-state × Personal Sync: the <machine> segment, with real git ===');

try {

  // ═════════════════════════════════════════════════════════════════════════
  // §1 — THE GUARANTEE
  // ═════════════════════════════════════════════════════════════════════════
  section('1. Two REAL machine identities, one scope, divergent commits — both handoffs must survive');
  let mA, mB, idA, idB;
  {
    const remote = await makeBareRemote();
    mA = await makeMachine('1a', remote, { installIdHex: 'a1a1a1' });
    await seedDomain(mA.domainsDir, PROJECT);

    activate(mA);
    idA = machineId();
    const hostA = hostSlug();
    // Machine A establishes origin/main.
    const sA1 = await saveWorkingState(PROJECT, { scope: 'main', ...handoff('A', 1) });
    assertTrue(sA1.ok === true, 'A saves an initial handoff through the real store', sA1.message);
    const p1 = await push();
    assertTrue(p1.pushed === true, 'A pushes; origin/main now carries A\'s state');

    // Machine B clones the SAME remote — a second computer, same hostname.
    mB = await makeMachine('1b', remote, { installIdHex: 'b2b2b2', clone: true });
    activate(mB);
    idB = machineId();
    const hostB = hostSlug();

    // PRECONDITION. If the two hostnames did not collide, a green §1 would
    // prove nothing about the collision the install id exists to survive.
    assertEq(hostB, hostA, 'precondition: both machines slugify to the SAME hostname (the collision case)');
    // Closing the chain to §2 explicitly rather than by inference: the
    // pre-v3.17.0 machineId() WAS hostSlug(), so these two computers would
    // have addressed one folder — the layout §2 measures the damage of.
    assertTrue(hostA === hostB && idA !== idB,
      'so the PRE-v3.17.0 identity (bare hostSlug) would have collapsed these two into one folder',
      `hostSlug=${hostA} on both; machineId=${idA} vs ${idB}`);
    assertTrue(idA !== idB, 'the install id — not the hostname — is what separates them', `${idA} vs ${idB}`);
    assertTrue(idA.startsWith(`${hostA}-`) && idB.startsWith(`${hostB}-`),
      'both machine ids are <hostname-slug>-<install-id>, per the documented layout', `${idA} / ${idB}`);
    assertTrue(installIdAvailable() === true, 'the collision guard reports itself ARMED on both machines');
    assertTrue(existsSync(statePath(mB.domainsDir, 'main', idA)),
      'B\'s clone received A\'s state folder over the wire');

    // ── The divergence. Both machines now write the SAME scope from the SAME
    // base commit, neither having seen the other's write. This is the exact
    // shape that produces a merge; with per-machine paths it must produce a
    // clean tree-level union instead of a conflicting hunk.
    activate(mA);
    const sA2 = await saveWorkingState(PROJECT, { scope: 'main', ...handoff('A', 2) });
    assertTrue(sA2.ok === true, 'A writes a second handoff (still unpushed)', sA2.message);
    const aText = await readText(statePath(mA.domainsDir, 'main', idA));

    activate(mB);
    const sB1 = await saveWorkingState(PROJECT, { scope: 'main', ...handoff('B', 1) });
    assertTrue(sB1.ok === true, 'B writes its own handoff to the SAME scope, unaware of A', sB1.message);
    assertEq(sB1.scope, 'main', 'both machines really did target one scope');
    assertTrue(sB1.machine === idB && sA2.machine === idA,
      'and the store routed them to two DIFFERENT machine folders');
    const bText = await readText(statePath(mB.domainsDir, 'main', idB));
    assertTrue(!!aText && !!bText && sha256(aText) !== sha256(bText),
      'corpus non-vacuous: the two handoffs genuinely differ');

    // A publishes first; B then syncs (pull auto-commits B's work, then merges
    // with the shipped `--no-rebase -X theirs`) and publishes.
    activate(mA);
    const p2 = await push();
    assertTrue(p2.pushed === true, 'A pushes its second handoff');

    activate(mB);
    const rB = await pull();
    assertTrue(rB.pulled === true, 'B pulls — the real merge, real -X theirs');
    assertEq(porcelain(mB.gitDir, mB.domainsDir), '', 'B\'s tree is clean after the merge (no unmerged paths)');
    const pB = await push();
    assertTrue(pB.pushed === true, 'B pushes the merged result');

    activate(mA);
    const rA = await pull();
    assertTrue(rA.pulled === true, 'A pulls B\'s work back');

    // ── THE ASSERTIONS THAT MATTER. Both handoffs, byte-identical, on both
    // machines, after a full round-trip.
    for (const m of [mA, mB]) {
      const a = await readText(statePath(m.domainsDir, 'main', idA));
      const b = await readText(statePath(m.domainsDir, 'main', idB));
      assertTrue(a !== null && sha256(a) === sha256(aText),
        `${m.tag}: A's handoff survives byte-identical`);
      assertTrue(b !== null && sha256(b) === sha256(bText),
        `${m.tag}: B's handoff survives byte-identical`);
      assertTrue(!!a && !a.includes('<<<<<<<') && !!b && !b.includes('<<<<<<<'),
        `${m.tag}: neither file carries a conflict marker`);
    }

    // And both are ADDRESSABLE — surviving on disk is worth nothing if the
    // reader cannot reach them.
    activate(mA);
    const idx = await listScopeMachines(PROJECT, 'main');
    assertEq(idx.total, 2, 'the scope index on A lists exactly two machines');
    const readA = await readWorkingState(PROJECT, { scope: 'main', machine: idA });
    const readB = await readWorkingState(PROJECT, { scope: 'main', machine: idB });
    assertTrue(readA.current?.present === true && /handoff from A #2/.test(readA.current.text || ''),
      'reading by A\'s machine name returns A\'s handoff');
    assertTrue(readB.current?.present === true && /handoff from B #1/.test(readB.current.text || ''),
      'reading by B\'s machine name returns B\'s handoff — from A\'s computer');
    assertEq(readA.machineCount, 2, 'and the read reports both machines');
    assertTrue(readA.machineIsThisMachine === true && readB.machineIsThisMachine === false,
      'A can tell its own folder from B\'s');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // §2 — THE POSITIVE CONTROL
  // ═════════════════════════════════════════════════════════════════════════
  //
  // §1 alone is compatible with a segment that does nothing. This is the half
  // that makes it mean something: run the IDENTICAL sequence with the segment
  // collapsed (the pre-v3.17.0 bare-hostname layout) and measure the damage.
  //
  // MEASURED RESULT, and it is WORSE than what the docs describe. The docblock
  // says `-X theirs` "keeps origin and discards the local write". That is true
  // only of a hunk BOTH sides changed. `-X theirs` is not "take their whole
  // file" — it is a conflict-resolution PREFERENCE inside an ordinary
  // three-way line merge, so a hunk only ONE side touched is applied cleanly
  // from that side whichever side it is. Both outcomes are reachable from an
  // ordinary sequence of saves, and both are exercised below:
  //
  //   2a  Every field differs on both sides → every hunk conflicts → origin
  //       wins wholesale, the local handoff is destroyed entire. This is the
  //       documented behaviour, and it reproduces.
  //   2b  One machine leaves a section UNCHANGED since the base — which is the
  //       normal case for "Firm decisions — do not re-litigate", a section
  //       whose whole purpose is to persist across saves — and the other
  //       machine changes it. Git then applies the change cleanly, and the
  //       merged file is a SPLICE: a handoff that existed on NEITHER machine,
  //       carrying one machine's decisions under the other's headline,
  //       provenance line and timestamp. Nothing in the document says so.
  //
  // 2b is the more dangerous of the two and is documented nowhere. A destroyed
  // handoff at least leaves a self-consistent document; a spliced one is
  // internally coherent, correctly formatted, MISATTRIBUTED, and the thing an
  // agent then acts on.
  // ═════════════════════════════════════════════════════════════════════════
  section('2. POSITIVE CONTROL — collapse the segment and measure what the merge actually does');
  {
    const SHARED = 'macbook-pro';   // what a bare hostname produced, pre-v3.17.0

    // ── 2a: every hunk conflicts → the documented wholesale loss ────────────
    {
      const remote = await makeBareRemote();
      const cA = await makeMachine('2a', remote, { installIdHex: 'c3c3c3' });
      await seedDomain(cA.domainsDir, PROJECT);

      activate(cA);
      // A base distinct from BOTH later handoffs, so every line differs on
      // both sides and every hunk is a genuine conflict.
      const s0 = await saveWorkingState(PROJECT, {
        scope: 'main', machine: SHARED,
        headline: 'seed', nowState: 'seed prose. '.repeat(120),
        decisions: ['seed decision'], traps: ['seed trap'], nextSteps: ['seed step'],
      });
      assertTrue(s0.ok === true && s0.machine === SHARED,
        'an explicit machine name is taken verbatim — no install id appended (the legacy layout)');
      await push();

      const cB = await makeMachine('2b', remote, { installIdHex: 'd4d4d4', clone: true });

      activate(cA);
      const sA = await saveWorkingState(PROJECT, { scope: 'main', machine: SHARED, ...handoff('A', 9), replace: true });
      assertTrue(sA.ok === true, 'A writes its handoff into the shared folder', sA.message);
      const aText = await readText(statePath(cA.domainsDir, 'main', SHARED));

      activate(cB);
      const sB = await saveWorkingState(PROJECT, { scope: 'main', machine: SHARED, ...handoff('B', 9), replace: true });
      assertTrue(sB.ok === true, 'B writes ITS handoff into the same shared folder', sB.message);
      const bText = await readText(statePath(cB.domainsDir, 'main', SHARED));
      assertTrue(!!aText && !!bText && sha256(aText) !== sha256(bText),
        'corpus non-vacuous: the two handoffs genuinely differ');
      assertEq(sA.path, sB.path, 'and BOTH resolved to the identical state path');

      activate(cA);
      await push();

      // B syncs. One ordinary click of "Sync now".
      activate(cB);
      let pulled = null, threw = null;
      try { pulled = await pull(); } catch (e) { threw = e; }
      assertTrue(threw === null, '2a: B\'s pull does not throw', threw && String(threw.message).slice(0, 160));
      assertTrue(pulled?.pulled === true, '2a: B\'s pull REPORTS SUCCESS — this is the silence the finding describes');
      assertEq(porcelain(cB.gitDir, cB.domainsDir), '',
        '2a: git status is clean — nothing anywhere says a handoff was replaced');

      const after = await readText(statePath(cB.domainsDir, 'main', SHARED));
      assertTrue(after !== null, '2a: a current.md still exists at the shared path');
      assertTrue(!after.includes('<<<<<<<'), '2a: and it carries NO conflict marker — the merge "succeeded"');

      const isA = sha256(after) === sha256(aText);
      const isB = sha256(after) === sha256(bText);
      assertTrue(isA !== isB,
        '2a: DATA LOSS REPRODUCED — the survivor is exactly one handoff, the other is gone entire',
        `matchesA=${isA} matchesB=${isB}`);
      assertTrue(!after.includes(isA ? 'handoff from B #9' : 'handoff from A #9'),
        `2a: the losing machine's handoff is absent from the merged file`,
        `${Buffer.byteLength(isA ? bText : aText, 'utf8')} bytes destroyed, exit 0, clean tree`);
      // Direction as its own fact. On a pull, `-X theirs` merges FETCH_HEAD
      // into local HEAD, so "theirs" is ORIGIN — the docblock's "keeps origin
      // and discards the local write".
      assertTrue(isA,
        '2a: direction matches the docblock — origin (A) wins, the LOCAL write (B) is discarded',
        `matchesA=${isA}`);

      // "…and the journal with it" (CLAUDE.md v3.17.0 finding 7b).
      const jnl = await readText(statePath(cB.domainsDir, 'main', SHARED, JOURNAL_FILENAME));
      assertTrue(jnl !== null, '2a: the shared journal.jsonl also still exists');
      const jLines = (jnl || '').split('\n').filter(Boolean);
      const headlines = jLines.map(l => { try { return JSON.parse(l).headline; } catch { return null; } });
      assertTrue(!jLines.some(l => l.includes('<<<<<<<')), '2a: the journal carries no conflict marker either');
      assertTrue(!(headlines.includes('handoff from A #9') && headlines.includes('handoff from B #9')),
        '2a: the append-only journal did NOT union — one machine\'s entries are gone too',
        `headlines: ${JSON.stringify(headlines)}`);

      activate(cB);
      const rd = await readWorkingState(PROJECT, { scope: 'main' });
      assertTrue(rd.ok === true && rd.current?.present === true, '2a: the reader happily returns the survivor');
      assertEq(rd.machineCount, 1, '2a: and sees ONE machine where two computers were writing');
      assertTrue(!/replac|lost|discard|conflict/i.test(String(rd.message || '')),
        '2a: nothing in the read payload mentions the loss — it is not knowable from here', rd.message);
    }

    // ── 2b: a STICKY section splices → a handoff that never existed ─────────
    //
    // The realistic shape. "Firm decisions — do not re-litigate" is designed to
    // persist unchanged across saves, and the skill instructs every save to be
    // COMPLETE rather than a delta — so re-sending an unchanged decisions list
    // is not an edge case, it is the intended usage.
    {
      const remote = await makeBareRemote();
      const dA = await makeMachine('2c', remote, { installIdHex: 'e7e7e7' });
      await seedDomain(dA.domainsDir, PROJECT);

      const STICKY = ['ship the memory layer before the picker', 'single writer per scope'];

      activate(dA);
      const base = await saveWorkingState(PROJECT, {
        scope: 'main', machine: SHARED, ...handoff('A', 0, { decisions: STICKY }),
      });
      assertTrue(base.ok === true, '2b: A establishes a base carrying the sticky decisions', base.message);
      await push();

      const dB = await makeMachine('2d', remote, { installIdHex: 'f8f8f8', clone: true });

      // A moves everything on EXCEPT the decisions — they have not changed.
      activate(dA);
      const sA = await saveWorkingState(PROJECT, {
        scope: 'main', machine: SHARED, ...handoff('A', 1, { decisions: STICKY }), replace: true,
      });
      assertTrue(sA.ok === true, '2b: A saves again, re-sending the SAME decisions unchanged', sA.message);
      const aText = await readText(statePath(dA.domainsDir, 'main', SHARED));

      // B, meanwhile, actually changes a decision — the one thing a decisions
      // list exists to record.
      activate(dB);
      const sB = await saveWorkingState(PROJECT, {
        scope: 'main', machine: SHARED,
        ...handoff('B', 1, { decisions: ['REVERSED: two writers per scope after all', 'B added this'] }),
        replace: true,
      });
      assertTrue(sB.ok === true, '2b: B saves with a genuinely CHANGED decisions list', sB.message);
      const bText = await readText(statePath(dB.domainsDir, 'main', SHARED));
      assertTrue(sha256(aText) !== sha256(bText), '2b: corpus non-vacuous: the two handoffs differ');

      activate(dA);
      await push();
      activate(dB);
      const pulled = await pull();
      assertTrue(pulled?.pulled === true, '2b: B\'s pull reports success');
      assertEq(porcelain(dB.gitDir, dB.domainsDir), '', '2b: clean tree, no conflict markers, no warning');

      const after = await readText(statePath(dB.domainsDir, 'main', SHARED));
      assertTrue(!after.includes('<<<<<<<'), '2b: the merged file carries no conflict marker');

      // THE FINDING. Not "one side lost" — a third document.
      assertTrue(sha256(after) !== sha256(aText) && sha256(after) !== sha256(bText),
        '2b: FINDING — the merged handoff matches NEITHER machine: a document that never existed',
        `A=${sha256(aText).slice(0, 12)} B=${sha256(bText).slice(0, 12)} merged=${sha256(after).slice(0, 12)}`);
      assertTrue(after.includes('handoff from A #1'),
        '2b: it carries A\'s headline (that hunk conflicted, so origin won)');
      assertTrue(after.includes(`Saved: ${sA.savedAt}`),
        '2b: and A\'s provenance line — machine, scope and timestamp all say "this is A\'s save"');
      assertTrue(after.includes('REVERSED: two writers per scope after all'),
        '2b: but the FIRM DECISIONS are B\'s — that hunk was one-sided, so -X theirs never applied');
      assertTrue(!after.includes(STICKY[0]),
        '2b: A\'s actual standing decision is gone, replaced by a decision A never made');
      assertTrue(after.includes('A was here at 1.') && !after.includes('B was here at 1.'),
        '2b: while the prose body is A\'s — the two halves come from different computers');

      // What an agent then reads. This is the whole product surface.
      activate(dB);
      const rd = await readWorkingState(PROJECT, { scope: 'main' });
      assertTrue(rd.current?.present === true, '2b: the reader returns the spliced document as normal state');
      assertTrue(/REVERSED: two writers/.test(rd.current.text || ''),
        '2b: an agent reads B\'s reversed decision as a firm, do-not-re-litigate constraint');
      assertEq(rd.current.headingsSuspect, false,
        '2b: and headingsSuspect is FALSE — the splice is undetectable by the file\'s own integrity check');
      assertTrue(rd.current.sanitisedOnRead === false,
        '2b: nothing on the read path flags it either');
    }
  }


  // ═════════════════════════════════════════════════════════════════════════
  // §3 — THE DOCUMENTED EXCEPTION (tier 1)
  // ═════════════════════════════════════════════════════════════════════════
  section('3. state/project.md has NO machine segment — the docblock says it IS exposed. Pinning that.');
  {
    const remote = await makeBareRemote();
    const bA = await makeMachine('3a', remote, { installIdHex: 'e5e5e5' });
    await seedDomain(bA.domainsDir, PROJECT);

    activate(bA);
    const b0 = await saveProjectBrief(PROJECT, { brief: 'the original mission '.repeat(40) });
    assertTrue(b0.ok === true, 'A writes the standing brief', b0.message);
    assertEq(b0.path, `${STATE_DIRNAME}/${BRIEF_FILENAME}`,
      'STRUCTURAL FACT: the brief path contains no <machine> segment');
    await push();

    const bB = await makeMachine('3b', remote, { installIdHex: 'f6f6f6', clone: true });

    // Two machines edit the brief from the same base — the exception the
    // docblock names. Note both are on their AUTO-DETECTED identity here:
    // distinct machine ids do not help, because tier 1 has no machine segment.
    activate(bA);
    const bAedit = await saveProjectBrief(PROJECT, { brief: 'A rewrote the mission '.repeat(40) });
    assertTrue(bAedit.ok === true, 'A edits the brief', bAedit.message);
    const aBrief = await readText(path.join(bA.domainsDir, PROJECT, STATE_DIRNAME, BRIEF_FILENAME));

    activate(bB);
    const bBedit = await saveProjectBrief(PROJECT, { brief: 'B rewrote the mission '.repeat(40) });
    assertTrue(bBedit.ok === true, 'B edits the brief', bBedit.message);
    const bBrief = await readText(path.join(bB.domainsDir, PROJECT, STATE_DIRNAME, BRIEF_FILENAME));
    assertEq(bBedit.path, bAedit.path, 'both edits resolved to the identical file — no per-machine split');
    assertTrue(sha256(aBrief) !== sha256(bBrief), 'corpus non-vacuous: the two briefs differ');

    activate(bA);
    await push();
    activate(bB);
    const rp = await pull();
    assertTrue(rp.pulled === true, 'B syncs and the pull reports success');

    const merged = await readText(path.join(bB.domainsDir, PROJECT, STATE_DIRNAME, BRIEF_FILENAME));
    assertTrue(!merged.includes('<<<<<<<'), 'the merged brief carries no conflict marker');
    const keptA = sha256(merged) === sha256(aBrief);
    const keptB = sha256(merged) === sha256(bBrief);
    assertTrue(keptA !== keptB, 'exactly one of the two brief edits survived', `keptA=${keptA} keptB=${keptB}`);
    assertTrue(!merged.includes(keptA ? 'B rewrote the mission' : 'A rewrote the mission'),
      'THE DOCUMENTED EXCEPTION IS REAL: one machine\'s brief edit is silently discarded',
      'working-state.js: "two machines that both edit the brief DO produce the conflicting hunk"');
    assertTrue(keptA, 'and it is again the LOCAL edit that loses, origin that wins');

    // The compensating property, so the exposure is recorded accurately rather
    // than alarmingly: tier 2/3 written in the SAME sync round-trip is intact.
    activate(bB);
    const st = await saveWorkingState(PROJECT, { scope: 'main', ...handoff('B', 3) });
    assertTrue(st.ok === true, 'B can still save session state after the brief was clobbered', st.message);
    const rd = await readWorkingState(PROJECT, { scope: 'main' });
    assertTrue(rd.brief?.present === true, 'the brief is still readable (clobbered, not corrupted)');
    assertTrue(rd.current?.present === true, 'and tier 2 is unaffected by the tier-1 collision');
  }

  // ── 3b: the brief splices too, and this is the worst place for it ─────────
  //
  // Tier 1 is returned on EVERY read and carries "Firm decisions — do not
  // re-litigate". The 2b mechanism applies here unchanged, and the docblock's
  // wording ("resolves it by discarding the local edit") understates it in the
  // same way: two machines editing DIFFERENT sections of the brief do not lose
  // one edit — they produce a brief neither person wrote, and every future
  // session on both machines reads it as the project's standing truth.
  section('3b. The brief splices as well — two machines editing different sections of it');
  {
    const remote = await makeBareRemote();
    const sA = await makeMachine('3c', remote, { installIdHex: 'a7a7a7' });
    await seedDomain(sA.domainsDir, PROJECT);

    const STANDING = ['no second writer to the brief', 'state supersedes, knowledge accumulates'];

    activate(sA);
    const b0 = await saveProjectBrief(PROJECT, {
      brief: 'original mission text. '.repeat(30), decisions: STANDING,
    });
    assertTrue(b0.ok === true, '3b: A establishes a brief with standing decisions', b0.message);
    await push();

    const sB = await makeMachine('3d', remote, { installIdHex: 'b8b8b8', clone: true });

    // A rewrites only the prose, re-sending the decisions unchanged.
    activate(sA);
    const eA = await saveProjectBrief(PROJECT, {
      brief: 'A rewrote the mission entirely. '.repeat(30), decisions: STANDING,
    });
    assertTrue(eA.ok === true, '3b: A edits the prose, decisions unchanged', eA.message);
    const aBrief = await readText(path.join(sA.domainsDir, PROJECT, STATE_DIRNAME, BRIEF_FILENAME));

    // B changes only a decision, re-sending the prose unchanged.
    activate(sB);
    const eB = await saveProjectBrief(PROJECT, {
      brief: 'original mission text. '.repeat(30),
      decisions: ['REVERSED: a second writer to the brief is fine', 'B added this'],
    });
    assertTrue(eB.ok === true, '3b: B changes a decision, prose unchanged', eB.message);
    const bBrief = await readText(path.join(sB.domainsDir, PROJECT, STATE_DIRNAME, BRIEF_FILENAME));
    assertTrue(sha256(aBrief) !== sha256(bBrief), '3b: corpus non-vacuous: the two briefs differ');

    activate(sA);
    await push();
    activate(sB);
    const rp = await pull();
    assertTrue(rp.pulled === true, '3b: B\'s pull reports success');
    assertEq(porcelain(sB.gitDir, sB.domainsDir), '', '3b: clean tree, no warning');

    const merged = await readText(path.join(sB.domainsDir, PROJECT, STATE_DIRNAME, BRIEF_FILENAME));
    assertTrue(!merged.includes('<<<<<<<'), '3b: no conflict marker');
    assertTrue(sha256(merged) !== sha256(aBrief) && sha256(merged) !== sha256(bBrief),
      '3b: FINDING — the merged BRIEF matches neither machine',
      `A=${sha256(aBrief).slice(0, 12)} B=${sha256(bBrief).slice(0, 12)} merged=${sha256(merged).slice(0, 12)}`);
    assertTrue(merged.includes('A rewrote the mission entirely.'),
      '3b: it carries A\'s prose (that hunk conflicted, origin won)');
    assertTrue(merged.includes('REVERSED: a second writer to the brief is fine'),
      '3b: and B\'s reversed decision (that hunk was one-sided)');
    assertTrue(!merged.includes(STANDING[0]),
      '3b: the standing decision both machines still believed in is GONE from the brief');

    // And this is what every future session on this project now reads first.
    const rd = await readWorkingState(PROJECT);
    assertTrue(rd.brief?.present === true, '3b: the spliced brief is returned on a scope-less read');
    assertTrue(/REVERSED: a second writer/.test(rd.brief.text || ''),
      '3b: so every future session on BOTH machines inherits a decision neither project owner recorded');
    assertEq(rd.brief.headingsSuspect, false, '3b: and the brief\'s own integrity check does not flag it');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // §4 — THE JOURNAL ACROSS MACHINES
  // ═════════════════════════════════════════════════════════════════════════
  section('4. journal.jsonl is append-only and per-machine: a round-trip loses nothing and duplicates nothing');
  {
    const remote = await makeBareRemote();
    const jA = await makeMachine('4a', remote, { installIdHex: '111aaa' });
    await seedDomain(jA.domainsDir, PROJECT);
    activate(jA);
    const jIdA = machineId();
    for (let i = 1; i <= 3; i++) {
      const r = await saveWorkingState(PROJECT, { scope: 'work', ...handoff('A', i) });
      assertTrue(r.ok === true && r.journalWritten === true, `A journal append ${i} succeeds`, r.message);
    }
    await push();

    const jB = await makeMachine('4b', remote, { installIdHex: '222bbb', clone: true });
    activate(jB);
    const jIdB = machineId();
    for (let i = 1; i <= 2; i++) {
      const r = await saveWorkingState(PROJECT, { scope: 'work', ...handoff('B', i) });
      assertTrue(r.ok === true && r.journalWritten === true, `B journal append ${i} succeeds`, r.message);
    }
    await pull();
    await push();
    activate(jA);
    // A also appends again AFTER B published, so the round-trip is genuinely
    // interleaved rather than a one-way copy.
    await saveWorkingState(PROJECT, { scope: 'work', ...handoff('A', 4) });
    await pull();
    await push();

    const countLines = async (dir, mid) => {
      const t = await readText(statePath(dir, 'work', mid, JOURNAL_FILENAME));
      return (t || '').split('\n').filter(Boolean);
    };
    for (const m of [jA, jB]) {
      activate(m);
      if (m === jB) await pull();
      const la = await countLines(m.domainsDir, jIdA);
      const lb = await countLines(m.domainsDir, jIdB);
      assertEq(la.length, 4, `${m.tag}: A's journal has all 4 of A's entries and only A's`);
      assertEq(lb.length, 2, `${m.tag}: B's journal has all 2 of B's entries and only B's`);
      const parsed = [...la, ...lb].map(l => { try { return JSON.parse(l); } catch { return null; } });
      assertTrue(parsed.every(Boolean), `${m.tag}: every journal line is still valid JSON after the merge`);
      const ats = parsed.map(p => `${p.machine}|${p.at}|${p.headline}`);
      assertEq(new Set(ats).size, ats.length, `${m.tag}: no journal entry was duplicated by the merge`);
      assertTrue(la.every(l => l.includes(jIdA)) && lb.every(l => l.includes(jIdB)),
        `${m.tag}: no cross-contamination between the two machines' journals`);
    }

    // The reader's own view of the journal, per machine.
    activate(jA);
    const rd = await readWorkingState(PROJECT, { scope: 'work', machine: jIdB, journalLimit: 50 });
    assertEq(rd.journal?.total, 2, 'reading B\'s journal from A returns exactly B\'s two entries');
    assertTrue(rd.journal.entries.every(e => /from B/.test(e.headline || '')),
      'and none of A\'s entries leak into it');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // §5 — THE PREMISES, and anything else a real round-trip surfaces
  // ═════════════════════════════════════════════════════════════════════════
  section('5. Premises the whole argument rests on, plus deletion propagation');
  {
    const remote = await makeBareRemote();
    const pA = await makeMachine('5a', remote, { installIdHex: '333ccc' });
    await seedDomain(pA.domainsDir, PROJECT);
    activate(pA);
    const pid = machineId();
    await saveWorkingState(PROJECT, { scope: 'main', ...handoff('A', 1) });
    await saveProjectBrief(PROJECT, { brief: 'mission '.repeat(50) });
    await push();

    // PREMISE 1: state/ actually syncs. If it were gitignored, the machine
    // segment would be protecting against a merge that never happens — the
    // argument would be moot rather than wrong, and §2 would be unreachable.
    const tracked = trackedFiles(pA.gitDir, pA.domainsDir);
    const relCur = `${PROJECT}/${STATE_DIRNAME}/main/${pid}/${CURRENT_FILENAME}`;
    const relJnl = `${PROJECT}/${STATE_DIRNAME}/main/${pid}/${JOURNAL_FILENAME}`;
    const relBrief = `${PROJECT}/${STATE_DIRNAME}/${BRIEF_FILENAME}`;
    assertTrue(tracked.includes(relCur), 'PREMISE: current.md is genuinely TRACKED by the sync repo', relCur);
    assertTrue(tracked.includes(relJnl), 'PREMISE: journal.jsonl is genuinely TRACKED');
    assertTrue(tracked.includes(relBrief), 'PREMISE: project.md is genuinely TRACKED');
    // Read the generated .gitignore and test in-process — never grep, which
    // has returned false zero-hits on this machine.
    const gi = await readText(path.join(pA.domainsDir, '.gitignore'));
    assertTrue(gi !== null, 'the domains .gitignore exists after a push');
    assertTrue(!gi.split('\n').some(l => l.trim() === 'state/' || l.trim() === `*/${STATE_DIRNAME}/`),
      'and carries no rule excluding state/ — matching the docblock\'s claim');
    assertTrue(!DOMAINS_GITIGNORE_RULES.some(r => String(r).includes(STATE_DIRNAME)),
      'DOMAINS_GITIGNORE_RULES names no state/ rule (asserted against the real array, not a copy)');

    // PREMISE 2: the install id must NOT be in the synced tree. Committing it
    // makes two clones resolve to the SAME machine folder, which is §2.
    assertTrue(!tracked.some(f => f.includes('.curator-install-id')),
      'PREMISE: .curator-install-id is NOT tracked — committing it would re-create the §2 collision');
    assertTrue(!existsSync(path.join(pA.domainsDir, '.curator-install-id')),
      'and it does not live under the domains tree at all (it is user-data)');
    assertTrue(existsSync(path.join(pA.userData, '.curator-install-id')),
      'it lives in the user-data dir, outside the work-tree');
    assertEq(installId(), '333ccc', 'the store reads that file as this installation\'s identity');

    // PREMISE 3 (D10): the REMEMBERED FOLDER NAME must not be in the synced
    // tree either, and this one is worse than PREMISE 2 if it leaks. The
    // install id is only HALF the folder name, so a clone that inherited it
    // could still differ by hostname; the remembered name is the WHOLE path
    // segment, so two clones sharing it write to a byte-identical
    // `state/<scope>/<machine>/` with nothing left to separate them — §2's
    // silent `-X theirs` loss, with the guard's own file as the cause.
    assertTrue(!tracked.some(f => f.includes('.curator-machine-id')),
      'PREMISE: .curator-machine-id is NOT tracked — it is the whole machine path segment');
    assertTrue(!existsSync(path.join(pA.domainsDir, '.curator-machine-id')),
      'and it does not live under the domains tree at all (it is user-data)');
    assertTrue(existsSync(path.join(pA.userData, '.curator-machine-id')),
      'it lives in the user-data dir, outside the work-tree, beside the install id');

    // The state file must not be classified BINARY by git — a binary blob is
    // invisible to `git diff` and to the recovery path the docs point at.
    const attrs = execSync(
      `git --git-dir="${pA.gitDir}" --work-tree="${pA.domainsDir}" ` +
      `-c core.quotePath=false diff --numstat --cached HEAD~1 2>/dev/null || true`,
      { stdio: 'pipe' },
    ).toString('utf8');
    assertTrue(!attrs.includes(`-\t-\t${relCur}`),
      'current.md is not treated as a binary blob by git (it stays diffable/recoverable)');

    // DELETION PROPAGATION, measured rather than assumed. A machine folder
    // deleted on one computer should disappear on the other — otherwise a
    // retired laptop's stale handoff haunts the index forever.
    const pB = await makeMachine('5b', remote, { installIdHex: '444ddd', clone: true });
    activate(pB);
    assertTrue(existsSync(statePath(pB.domainsDir, 'main', pid)), 'B receives A\'s machine folder');
    activate(pA);
    await rm(path.join(pA.domainsDir, PROJECT, STATE_DIRNAME, 'main', pid), { recursive: true, force: true });
    const pd = await push();
    assertTrue(pd.pushed === true, 'A deletes its machine folder and pushes');
    activate(pB);
    await pull();
    assertTrue(!existsSync(statePath(pB.domainsDir, 'main', pid)),
      'FINDING: the deletion propagates — B no longer sees the retired machine\'s current.md');
    const idxAfter = await listScopeMachines(PROJECT, 'main');
    assertEq(idxAfter.total, 0, 'and the scope index on B agrees the machine is gone');
  }

} catch (err) {
  fail('UNCAUGHT — the suite aborted before finishing', `${err && err.stack ? err.stack : err}`);
} finally {
  await sweep();
}

console.log(`\n${'='.repeat(62)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.label}`);
    if (f.detail !== undefined) console.log(`      ${f.detail}`);
  }
}
process.exit(failed ? 1 : 0);
