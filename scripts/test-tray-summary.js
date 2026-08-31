/**
 * test-tray-summary.js — OFFLINE suite for `src/brain/tray-summary.js`, the
 * single call behind the macOS menubar widget.
 *
 * ── WHAT THIS SUITE IS ACTUALLY PROTECTING ────────────────────────────────
 *
 * Three properties, in descending order of "how badly does the user get lied
 * to when it breaks".
 *
 * 1. THE TWO CLOCKS STAY SEPARABLE. `st.mtime` on a synced `current.md` is the
 *    moment of the PULL, not the moment of the save — git rewrites mtime on
 *    checkout. So on a second machine, a handoff written yesterday morning
 *    reads as "just now" if you take the filesystem's word for it. §3 builds
 *    exactly that file (mtime = now, journal `at` = three hours ago) and
 *    asserts the age comes from the AGENT's clock, that `ageSource` says so,
 *    and — the part a field-by-field check would miss — that the row SORTS by
 *    the agent clock too. A panel that labelled the age correctly and still
 *    put the stale row at the top would be wrong in the way that matters.
 *
 * 2. NO NETWORK, STRUCTURALLY. §6 walks the module's transitive import graph
 *    off disk and asserts `src/brain/sync.js` and `child_process` are both
 *    unreachable. That is stronger than "we only call getRemoteStatus when
 *    the cache is warm", and it is the only guarantee available: sync.js
 *    exposes no way to READ its TTL cache without being willing to fill it
 *    (`maxAgeMs: 0` does not help — `remoteCacheTtl` returns 0 for a
 *    successful payload, so the freshness test fails and the call fetches).
 *    A second fetch site is not theoretical here: v3.9.1 added one behind the
 *    sync badge and it aborted the user's own pull 11 times in 12 over a ref
 *    lock. The walker carries a POSITIVE CONTROL — an injected import is
 *    found — so a green §6 cannot mean "the walker sees nothing".
 *
 * 3. A CAP IS NEVER A MEASUREMENT. §5 asserts every truncation carries the
 *    TRUE total beside the shown count, and that counts are taken before the
 *    slice rather than from it.
 *
 * ── NOT ENFORCED — stated rather than implied away ────────────────────────
 *  - Nothing here renders anything. This is the data half; the panel is
 *    `desktop/`'s and has its own suite.
 *  - `remote` is exercised through `noteRemoteStatus()` only. No real remote
 *    check runs, by design (see §6) — so this suite proves what the tray does
 *    with an observation, never that `getRemoteStatus()` produces one.
 *  - The COST claim in the module docblock ("exactly what GET /api/memory
 *    costs") is an argument from shared implementation, not a measurement.
 *    Nothing here counts syscalls.
 *  - `machineId()` is exercised as it really behaves inside an isolated user
 *    data dir, which means this suite mints an installation id in a tempdir.
 *    It does not prove the deferral comment's claim that an EMPTY store skips
 *    minting on a real install; §7 asserts the observable half (an empty
 *    store answers without an identity file) against the tempdir.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra ? `\n        ${extra}` : ''}`); }
}
function eq(actual, expected, label) {
  const same = actual === expected;
  ok(same, label, same ? '' : `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
}
function section(t) { console.log(`\n${t}`); }

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Isolation — nothing here may reach a real credential file or wiki');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tray-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(TMP_DOMAINS, { recursive: true });

// BOTH seams, before any app module is imported. CURATOR_TEST_DOMAINS_DIR
// alone leaves the developer's real .sync-config.json (and its GitHub PAT) in
// reach — see paths.js's docblock.
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
// DOMAINS_PATH still outranks the default inside getDomainsDir(); an inherited
// one would point an "isolated" run at a real wiki.
delete process.env.DOMAINS_PATH;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(ROOT, f));
// sha256 + size + existence ONLY. mtime is deliberately excluded: the
// maintainer's live app rewrites .curator-config.json during ordinary Settings
// use, and an mtime-sensitive guard would report a false "isolation is broken"
// (the v3.0.16 misattribution shape).
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!fs.existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = fs.readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const fpBefore = fingerprint();
ok(fpBefore.length > 0, 'real credential files fingerprinted before the run');

const { getDomainsDir } = await import('../src/brain/config.js');
const wsMod = await import('../src/brain/working-state.js');
const {
  getTraySummary, noteRemoteStatus, __resetRemoteObservation,
  TRAY_DEFAULT_LIMIT, TRAY_MAX_LIMIT, TRAY_MAX_PROJECTS, REMOTE_OBSERVATION_MAX_AGE_MS,
} = await import('../src/brain/tray-summary.js');

// Prove the seam actually took rather than assuming the env var won. A suite
// whose isolation silently lost would run every assertion below against the
// maintainer's real wiki and pass.
ok(getDomainsDir() === TMP_DOMAINS, 'the resolved domains dir IS the tempdir', getDomainsDir());

// ═══════════════════════════════════════════════════════════════════════════
section('§2  Fixture — a store shaped like the two scenarios the widget serves');
// ═══════════════════════════════════════════════════════════════════════════

const SELF = wsMod.machineId();                 // this installation's own segment
const OTHER = 'buildbox-a1b2c3';                // a second machine, arriving over sync
ok(typeof SELF === 'string' && SELF.length > 0, `this installation's machine segment resolved (${SELF})`);
ok(SELF !== OTHER, 'the fixture\'s "other machine" is genuinely not this one');

const SEC = 1000;
const NOW = Date.now();

function mkDomain(name) {
  fs.mkdirSync(path.join(TMP_DOMAINS, name), { recursive: true });
  fs.writeFileSync(path.join(TMP_DOMAINS, name, 'CLAUDE.md'), `# ${name}\n`);
}

/**
 * One (scope, machine) pair.
 * `mtimeAgoSec` drives the FILE clock; `journal` drives the AGENT clock. They
 * are set independently on purpose — that independence IS the bug this module
 * exists to report honestly.
 */
function mkPair(project, scope, machine, { mtimeAgoSec, journal = null, body = 'handoff\n' }) {
  const dir = path.join(TMP_DOMAINS, project, 'state', scope, machine);
  fs.mkdirSync(dir, { recursive: true });
  const cur = path.join(dir, 'current.md');
  fs.writeFileSync(cur, body);
  if (journal) {
    fs.writeFileSync(path.join(dir, 'journal.jsonl'),
      journal.map(o => JSON.stringify(o)).join('\n') + '\n');
  }
  const t = (NOW - mtimeAgoSec * SEC) / 1000;
  fs.utimesSync(cur, t, t);
}

// THE DOMAIN NAMES ARE CHOSEN SO THAT WALK ORDER != RECENCY ORDER, and that
// is load-bearing rather than incidental. `listDomains()` returns readdir
// order, and `listWorkingScopes` walks scope directories the same way — so a
// fixture whose alphabetical order happens to equal its recency order cannot
// tell a working sort from NO SORT AT ALL.
//
// Measured, not assumed: the first draft of this suite used alpha/beta/gamma
// with the newest save in `alpha`, and a mutation DELETING `rows.sort(...)`
// came back GREEN — the ordering assertions, which are the single most
// important thing here (§3), could not fail. `zulu` holds the newest save and
// sorts LAST, so an unsorted result puts the wrong row first.
for (const d of ['alpha', 'beta', 'gamma', 'zulu']) mkDomain(d);
// A directory with no CLAUDE.md. listDomains() must not return it, so the tray
// must never see it — the same invisibility that makes saving there refused.
fs.mkdirSync(path.join(TMP_DOMAINS, 'not-a-domain', 'state', 'main', SELF), { recursive: true });
fs.writeFileSync(path.join(TMP_DOMAINS, 'not-a-domain', 'state', 'main', SELF, 'current.md'), 'x');

// alpha · main — this machine, agent clock 60s old, file clock agrees.
mkPair('alpha', 'main', SELF, {
  mtimeAgoSec: 60,
  journal: [{ at: new Date(NOW - 60 * SEC).toISOString(), headline: 'wired the tray bounds', harness: 'claude-code' }],
});
fs.writeFileSync(path.join(TMP_DOMAINS, 'alpha', 'state', 'project.md'), '# brief\n');
{
  const t = (NOW - 6 * 86400 * SEC) / 1000;
  fs.utimesSync(path.join(TMP_DOMAINS, 'alpha', 'state', 'project.md'), t, t);
}

// beta · pulled — THE REGRESSION FIXTURE. This is what a handoff looks like
// after `git pull` on a second machine: the file landed on this disk seconds
// ago, and the agent wrote it three hours ago on another computer.
mkPair('beta', 'pulled', OTHER, {
  mtimeAgoSec: 2,
  journal: [{ at: new Date(NOW - 3 * 3600 * SEC).toISOString(), headline: 'rewrote the fetch serialiser', harness: 'opencode' }],
});

// beta · nojournal — no journal at all. The file clock is the only one there
// is, and the row must SAY so rather than implying an agent time it lacks.
mkPair('beta', 'nojournal', SELF, { mtimeAgoSec: 600 });

// beta · badstamp — a journal line whose `at` is unusable (hand-edited). Same
// outcome as no journal for the clock, but the headline still arrives.
mkPair('beta', 'badstamp', SELF, {
  mtimeAgoSec: 900,
  journal: [{ at: 'not-a-date', headline: 'hand-edited line', harness: 'claude-code' }],
});

// gamma · main — TWO HARNESSES ALTERNATING in one folder. A B A B is the live
// collision (each has overwritten the other and will again); a single A→B
// transition is a migration and must NOT be reported.
mkPair('gamma', 'main', SELF, {
  mtimeAgoSec: 300,
  journal: [
    { at: new Date(NOW - 340 * SEC).toISOString(), headline: 'a1', harness: 'claude-code' },
    { at: new Date(NOW - 330 * SEC).toISOString(), headline: 'b1', harness: 'opencode' },
    { at: new Date(NOW - 320 * SEC).toISOString(), headline: 'a2', harness: 'claude-code' },
    { at: new Date(NOW - 300 * SEC).toISOString(), headline: 'wrote the collision', harness: 'opencode' },
  ],
});

// zulu · main — the NEWEST save in the whole fixture, in the domain that
// sorts LAST. See the mkDomain block for why that placement is the point.
mkPair('zulu', 'main', SELF, {
  mtimeAgoSec: 10,
  journal: [{ at: new Date(NOW - 10 * SEC).toISOString(), headline: 'the newest thing', harness: 'claude-code' }],
});
// TWO projects carry a brief, with different ages. `alpha`'s is older and its
// project sorts FIRST, so an implementation that returned "the first brief it
// found" rather than "the brief of the project on screen" reports 6 days here
// instead of 2 — and §5 catches it.
fs.writeFileSync(path.join(TMP_DOMAINS, 'zulu', 'state', 'project.md'), '# zulu brief\n');
{
  const t = (NOW - 2 * 86400 * SEC) / 1000;
  fs.utimesSync(path.join(TMP_DOMAINS, 'zulu', 'state', 'project.md'), t, t);
}

const summary = await getTraySummary({ limit: 20 });
ok(summary.ok === true, 'getTraySummary returns ok');
eq(summary.scopes.length, 6, 'six pairs across four domains — the ghost folder is not one of them');
ok(!summary.scopes.some(r => r.project === 'not-a-domain'),
  'a folder with no CLAUDE.md contributes no rows (listDomains() hides it)');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  TWO CLOCKS — the pulled handoff must not read as "just now"');
// ═══════════════════════════════════════════════════════════════════════════

const byScope = Object.fromEntries(summary.scopes.map(r => [r.scope, r]));
const pulled = byScope.pulled;

ok(pulled != null, 'the pulled row is present');
eq(pulled.ageSource, 'agent', 'the pulled row reports the AGENT clock as its source');
ok(pulled.writtenAgeSeconds >= 3 * 3600 - 30 && pulled.writtenAgeSeconds <= 3 * 3600 + 30,
  `the age shown is ~3 hours (the save), not ~2 seconds (the pull) — got ${pulled.writtenAgeSeconds}s`);
ok(pulled.fileChangedAgeSeconds !== null && pulled.fileChangedAgeSeconds < 60,
  `the FILE clock is still reported separately and is fresh — got ${pulled.fileChangedAgeSeconds}s`);
ok(pulled.agentWrittenAt !== pulled.fileChangedAt,
  'the two timestamps are distinguishable — neither was collapsed into the other');
eq(pulled.isThisMachine, false, 'the pulled row is marked as NOT this machine');
eq(pulled.harness, 'opencode', 'the harness rides out of the same journal line');

// ── THE ORDERING HALF, which is where the first draft of this suite was weak.
//
// Labelling the age correctly and then sorting by mtime anyway would put a
// three-hour-old handoff above a ten-second-old one — the same lie, one layer
// down, and invisible to any field-by-field check.
//
// The WHOLE sequence is pinned, not just the head. A head-only assertion goes
// green under a partial sort, and — as measured — under NO SORT at all if the
// fixture's walk order happens to agree. Three independent things now have to
// hold: `zulu` (newest agent clock) is first even though it sorts LAST
// alphabetically; `beta·pulled` is LAST even though it has the NEWEST mtime in
// the fixture; and everything between is in agent-clock order.
const order = summary.scopes.map(r => `${r.project}·${r.scope}`).join(' > ');
eq(order,
  'zulu·main > alpha·main > gamma·main > beta·nojournal > beta·badstamp > beta·pulled',
  'the whole list is ordered by the chosen clock — newest first, walk order ignored');
eq(summary.scopes[0].project, 'zulu',
  'the newest save leads even though its project sorts LAST — so this cannot pass with no sort');
eq(summary.scopes[summary.scopes.length - 1].scope, 'pulled',
  'the pulled row is LAST despite holding the newest mtime in the fixture — so this cannot pass sorting by mtime');
eq(summary.lastSave.scope, 'main', 'lastSave agrees with scopes[0] — they are the same row, re-projected');
eq(summary.lastSave.project, 'zulu', 'lastSave names the same project');
eq(summary.lastSave.ageSource, 'agent', 'lastSave carries its own ageSource');

// ── `lastSave` AND `scopes[0]` CANNOT DISAGREE — asserted, not hoped for.
//
// The panel renders lastSave as its headline and scopes[0] as its first row.
// If those two could name different saves the screen contradicts itself, and
// there is no reading of it that is correct. They are the same record, so the
// binding is asserted FIELD BY FIELD and — the part that matters — at the
// TIGHTEST limit, where a "newest across the whole set" implementation would
// diverge from a "first of the shown window" one.
for (const f of ['project', 'scope', 'machine', 'harness', 'writtenAt', 'writtenAgeSeconds', 'ageSource', 'kind', 'isThisMachine']) {
  eq(summary.lastSave[f], summary.scopes[0][f], `lastSave.${f} IS scopes[0].${f}`);
}
{
  const one = await getTraySummary({ limit: 1 });
  eq(one.scopes.length, 1, 'at limit 1 there is exactly one row…');
  eq(one.lastSave.project + '·' + one.lastSave.scope, one.scopes[0].project + '·' + one.scopes[0].scope,
    '…and lastSave still names it — the limit can never split the headline from the first row');
  eq(one.lastSave.project, 'zulu',
    '…and it is still the genuinely newest save, so binding them together loses nothing');
}

// ── The fallback, and it must NAME itself ──────────────────────────────────
const nojournal = byScope.nojournal;
eq(nojournal.ageSource, 'file', 'a pair with no journal reports the FILE clock as its source');
eq(nojournal.agentWrittenAt, null, '…and its agent timestamp is null, not 0 and not a string');
eq(nojournal.agentWrittenAgeSeconds, null, '…and its agent age is null, not 0');
ok(nojournal.writtenAt === nojournal.fileChangedAt,
  '…and the displayed timestamp IS the file one, so ageSource is not decorative');
eq(nojournal.headline, null, 'no journal means no headline — null, not an empty string');

const badstamp = byScope.badstamp;
eq(badstamp.ageSource, 'file', 'an unusable `at` falls back to the file clock');
eq(badstamp.headline, 'hand-edited line', '…while the headline from that same line still arrives');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  Provenance and the harness collision');
// ═══════════════════════════════════════════════════════════════════════════

eq(byScope.nojournal.isThisMachine, true, 'a row under this installation\'s own segment is marked as such');
const collision = summary.warnings.filter(w => w.code === 'harness-collision');
eq(collision.length, 1, 'exactly one collision warning — the A B A B folder');
eq(collision[0].project, 'gamma', '…and it names the project');
eq(collision[0].scope, 'main', '…and the scope');
ok(collision[0].harnesses.includes('claude-code') && collision[0].harnesses.includes('opencode'),
  '…and both harnesses');
eq(summary.scopes.find(r => r.project === 'gamma').harnessShared, true,
  'the row itself carries harnessShared, so the panel can mark it without reading warnings');
eq(byScope.pulled.harnessShared, false,
  'a single-harness folder is NOT reported as shared (one transition is a migration, not a collision)');

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Bounds — a cap is disclosed with the true total, never as a count');
// ═══════════════════════════════════════════════════════════════════════════

// ── THE DENOMINATOR. Without it a consumer cannot tell "capped at N" from
// "there are exactly N", so the busiest store renders as a complete list —
// a cap read as a measurement, at the one moment the user needs the opposite.
const three = await getTraySummary({ limit: 3 });
eq(three.scopes.length, 3, 'limit is honoured');
eq(three.total, 6, '`total` is the count BEFORE the slice, so 3-of-6 is distinguishable from 3-of-3');
eq(three.truncated, true, '…and `truncated` says so directly');
eq(three.pairsOnDisk, 6, '…with the on-disk pair total beside it');
{
  const all = await getTraySummary({ limit: 20 });
  eq(all.total, 6, 'an UNcapped call reports the same total…');
  eq(all.truncated, false, '…and truncated false — the two states are distinguishable');
  eq(all.total, all.scopes.length, '…because total equals the row count exactly when nothing was cut');
}
const trunc = three.warnings.find(w => w.code === 'scopes-truncated');
ok(trunc != null, 'truncation is DISCLOSED rather than silent');
eq(trunc.shown, 3, '…with the shown count');
eq(trunc.total, 6, '…and the TRUE total beside it, counted before the slice');
ok(trunc.pairsOnDisk >= trunc.total, '…and the on-disk pair total is at least the row total');
ok(new RegExp(`\\b${trunc.shown}\\b`).test(trunc.message) && new RegExp(`\\b${trunc.total}\\b`).test(trunc.message),
  '…and its message names both numbers too (same rule as §5b)');
eq(three.scopes.map(r => r.project).join(','), 'zulu,alpha,gamma',
  'the cap keeps the NEWEST rows, in order — not an arbitrary three');

eq((await getTraySummary({ limit: 0 })).scopes.length, 1, 'limit 0 clamps up to 1, never to zero rows');
eq((await getTraySummary({ limit: -5 })).scopes.length, 1, 'a negative limit clamps to 1');
// NOTE: with only six rows on disk these two cannot distinguish "clamped" from
// "honoured" — the ceiling and the default are both above six. They assert
// only that a junk limit does not CRASH or drop rows; §5b drives the real
// ceilings past their limits. Recorded rather than left to read as coverage.
eq((await getTraySummary({ limit: 'eight' })).scopes.length, 6, 'a non-numeric limit falls back to a default that shows everything here');
eq((await getTraySummary()).scopes.length, 6, 'no options at all is legal');
ok(TRAY_DEFAULT_LIMIT === 8 && TRAY_MAX_LIMIT === 40, 'the two row bounds are the documented ones');
ok(TRAY_MAX_PROJECTS === 200,
  'the project cap MATCHES routes/memory.js MAX_PROJECTS — two surfaces over one store must not disagree about what exists');

// The route's cap is read off disk rather than imported: src/brain must not
// import from src/routes, so the two integers are hand-kept in step and this
// is what stops them drifting.
const memSrc = fs.readFileSync(path.join(ROOT, 'src/routes/memory.js'), 'utf8');
const m = memSrc.match(/export const MAX_PROJECTS\s*=\s*(\d+)/);
ok(m != null, 'routes/memory.js still declares MAX_PROJECTS in the pinned shape');
eq(Number(m[1]), TRAY_MAX_PROJECTS, 'and its value still equals TRAY_MAX_PROJECTS');

// ── The standing brief — one stat, and only for the newest project ─────────
ok(summary.brief != null, 'the brief is reported when one exists');
eq(summary.brief.project, 'zulu', '…for the project of the NEWEST save, which is the one at the top of the panel');
ok(summary.brief.ageSeconds > 1.9 * 86400 && summary.brief.ageSeconds < 2.1 * 86400,
  `…and it is zulu's brief (~2 days), NOT alpha's older one (~6 days) — got ${summary.brief.ageSeconds}s`);
ok(!('text' in summary.brief) && !('bytes' in summary.brief),
  'the brief is STAT-ed, never read — a 32 KB document has no place in a menubar payload');

// ═══════════════════════════════════════════════════════════════════════════
section('§5b AT SCALE — the two ceilings the six-row fixture cannot reach');
// ═══════════════════════════════════════════════════════════════════════════
//
// FOUND BY MUTATION. With six rows on disk, `limit: 1e6` returns six whether
// or not TRAY_MAX_LIMIT is applied — so deleting the ceiling ran GREEN, and
// the assertion claiming it was "clamped, not honoured" could not fail. Same
// for TRAY_MAX_PROJECTS, which nothing reached. Both ceilings exist to stop a
// caller turning a menubar poll into a full index dump, so both are now driven
// past their own limit rather than asserted as constants.
//
// A separate domains root so §2–§5's counts stay exactly what they say.
const SCALE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tray-scale-')));
const { __setDomainsDirOverride: setDomains } = await import('../src/brain/config.js');

// One project, 45 scopes — comfortably past TRAY_MAX_LIMIT (40).
fs.mkdirSync(path.join(SCALE, 'busy'), { recursive: true });
fs.writeFileSync(path.join(SCALE, 'busy', 'CLAUDE.md'), '# busy\n');
for (let i = 0; i < 45; i++) {
  const d = path.join(SCALE, 'busy', 'state', `scope-${String(i).padStart(2, '0')}`, SELF);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'current.md'), 'x');
}
setDomains(SCALE);

const big = await getTraySummary({ limit: 1e6 });
eq(big.scopes.length, TRAY_MAX_LIMIT,
  'an absurd limit is CLAMPED to TRAY_MAX_LIMIT — a caller cannot turn a menubar poll into an index dump');
const bigTrunc = big.warnings.find(w => w.code === 'scopes-truncated');
eq(bigTrunc.total, 45, '…and the clamp is disclosed with the TRUE row count, not the ceiling');
eq(big.total, 45, '…and top-level `total` is that true count, not the 40 that came back');
eq(big.truncated, true, '…with truncated true');
eq(big.lastSave.scope, big.scopes[0].scope,
  '…and lastSave still IS scopes[0] at scale, where a whole-set implementation would diverge');
eq((await getTraySummary()).scopes.length, TRAY_DEFAULT_LIMIT,
  'the DEFAULT limit is honoured when there is plenty to show — 8, the panel\'s row budget');

// Past TRAY_MAX_PROJECTS. These carry no state, so each costs one failed
// readdir — enough to prove the cap fires and is reported.
for (let i = 0; i < TRAY_MAX_PROJECTS + 5; i++) {
  const n = `p${String(i).padStart(4, '0')}`;
  fs.mkdirSync(path.join(SCALE, n), { recursive: true });
  fs.writeFileSync(path.join(SCALE, n, 'CLAUDE.md'), '# x\n');
}
const many = await getTraySummary();
const pTrunc = many.warnings.find(w => w.code === 'projects-truncated');
ok(pTrunc != null, 'passing TRAY_MAX_PROJECTS is DISCLOSED rather than silent');
eq(pTrunc.scanned, TRAY_MAX_PROJECTS, '…with the number actually scanned');
eq(pTrunc.total, TRAY_MAX_PROJECTS + 6, '…and the TRUE project total beside it (205 empties + busy)');
ok(pTrunc.scanned < pTrunc.total, '…so the cap can never be read as a measurement');
// The PROSE too, not only the structured fields. A message naming the cap and
// not the total IS a cap read as a measurement, and a consumer that renders
// `message` verbatim would show exactly that. Found by mutation: dropping the
// true total from this string alone ran green against the fields.
ok(new RegExp(`\\b${pTrunc.scanned}\\b`).test(pTrunc.message)
   && new RegExp(`\\b${pTrunc.total}\\b`).test(pTrunc.message),
  '…and the MESSAGE names both numbers, so rendering it verbatim cannot mislead either');

setDomains(TMP_DOMAINS);
eq((await getTraySummary()).scopes.length, 6, 'the override is released — §6 onward sees the real fixture again');

// ═══════════════════════════════════════════════════════════════════════════
section('§6  NO NETWORK — proved structurally over the import graph');
// ═══════════════════════════════════════════════════════════════════════════

/** Transitive local imports of a module, resolved off disk. */
function importGraph(entry, extraSource = null) {
  const seen = new Set(), external = new Set(), stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (f === entry && extraSource) src += '\n' + extraSource;
    for (const mm of src.matchAll(/^\s*import[^;]*?from\s*['"]([^'"]+)['"]/gm)) {
      const s = mm[1];
      if (s.startsWith('.')) stack.push(path.normalize(path.join(path.dirname(f), s)));
      else external.add(s.replace(/^node:/, ''));
    }
  }
  return { local: seen, external };
}

const g = importGraph('src/brain/tray-summary.js');
ok(g.local.size > 3, `the walker actually resolved a graph (${g.local.size} modules)`);
ok(!g.local.has('src/brain/sync.js'),
  'src/brain/sync.js is UNREACHABLE from tray-summary.js — getRemoteStatus() cannot be called, so no git fetch can be triggered');
ok(!g.external.has('child_process'),
  'child_process is UNREACHABLE — no subprocess, so no `git` of any kind');

// POSITIVE CONTROL. Without it a green above could mean "the walker sees
// nothing", which is exactly the shape this repo has been burned by twice.
const cSync = importGraph('src/brain/tray-summary.js', "import { getRemoteStatus } from './sync.js';");
ok(cSync.local.has('src/brain/sync.js'),
  '(control) an injected sync.js import IS found — the walker can fail');
const cProc = importGraph('src/brain/tray-summary.js', "import { execFile } from 'node:child_process';");
ok(cProc.external.has('child_process'),
  '(control) an injected child_process import IS found, node: prefix and all');

// And the flat text check, which catches a call added through some import
// shape the walker does not model (a dynamic import, a re-export alias).
const traySrc = fs.readFileSync(path.join(ROOT, 'src/brain/tray-summary.js'), 'utf8');
ok(!/getRemoteStatus/.test(traySrc.replace(/^\s*\*.*$/gm, '')),
  'getRemoteStatus is not called anywhere in the module body (comments excluded)');
ok(/getRemoteStatus/.test(traySrc),
  '(control) the name DOES appear in the file — in the comments explaining why it is not called, so the check above is not vacuous');

// ═══════════════════════════════════════════════════════════════════════════
section('§7  `remote` is an OBSERVATION — never a fetch, never a reassuring zero');
// ═══════════════════════════════════════════════════════════════════════════

__resetRemoteObservation();
eq((await getTraySummary()).remote, null,
  'with nobody having checked, remote is null — the honest answer, and the one that costs nothing');

eq(noteRemoteStatus({ configured: false }), false, 'an UNCONFIGURED install records no observation');
eq((await getTraySummary()).remote, null, '…so remote stays null rather than becoming "0 waiting"');

// THE HONESTY RULE, at the one place it is consumed. sync.js sets
// behindFiles: null on a FAILED check, never 0. "We could not ask" and "there
// is nothing waiting" are different facts.
noteRemoteStatus({ configured: true, remoteChecked: false, behindFiles: null, behindCommits: null, checkedAt: '2026-08-31T10:00:00.000Z' });
const failedCheck = (await getTraySummary()).remote;
ok(failedCheck != null, 'a FAILED check is still an observation — the panel is told we tried');
eq(failedCheck.behindFiles, null, '…and behindFiles stays null, never 0');
eq(failedCheck.checkedAt, '2026-08-31T10:00:00.000Z', '…and carries when we tried');

noteRemoteStatus({ configured: true, remoteChecked: true, behindFiles: 14, behindCommits: 2, checkedAt: '2026-08-31T10:05:00.000Z' });
const good = (await getTraySummary()).remote;
eq(good.behindFiles, 14, 'a successful check reports the file count');
eq(good.behindCommits, 2, '…and the commit count');
ok(!('files' in good) && !('remoteError' in good),
  'the preview array and the error string are NOT forwarded — the panel gets three fields, not a sync payload');

// A truthy-but-wrong shape must not become a number.
noteRemoteStatus({ configured: true, behindFiles: '14', behindCommits: 2.5, checkedAt: 99 });
const coerced = (await getTraySummary()).remote;
eq(coerced.behindFiles, null, 'a STRING count is refused, not coerced — it becomes null');
eq(coerced.behindCommits, null, 'a non-integer count is refused too');
eq(coerced.checkedAt, null, 'a non-string timestamp is refused');

// STALENESS. An observation older than the window is dropped rather than shown
// with an age: a menubar line saying "2 waiting" is read as current, and there
// is no room beside it to say it is not.
const t0 = Date.now();
noteRemoteStatus({ configured: true, behindFiles: 3, behindCommits: 1, checkedAt: 'x' }, t0);
ok((await getTraySummary({ now: t0 + 1000 })).remote.behindFiles === 3, 'a fresh observation is shown');
eq((await getTraySummary({ now: t0 + REMOTE_OBSERVATION_MAX_AGE_MS })).remote, null,
  'an observation AT the staleness window is dropped');
eq((await getTraySummary({ now: t0 + REMOTE_OBSERVATION_MAX_AGE_MS + 1 })).remote, null,
  'and past it');
eq(REMOTE_OBSERVATION_MAX_AGE_MS, 5 * 60 * 1000,
  'the window equals sync.js REMOTE_CHECK_TTL_MS — the producer already refuses to reuse an older answer');
eq(noteRemoteStatus(null), false, 'passing null clears the observation');
eq((await getTraySummary()).remote, null, '…and it stays cleared');
__resetRemoteObservation();

// ═══════════════════════════════════════════════════════════════════════════
section('§8  Degradation — an empty or unreadable store answers, never throws');
// ═══════════════════════════════════════════════════════════════════════════

const EMPTY = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tray-empty-')));
// `setDomains` is the in-process, domains-only override imported in §5b —
// NOT process.env.DOMAINS_PATH, which loses to a configured domainsPath and
// silently no-ops on a real install.
setDomains(EMPTY);
const empty = await getTraySummary();
eq(empty.ok, true, 'an empty domains folder still answers ok');
eq(empty.scopes.length, 0, '…with no rows');
eq(empty.lastSave, null, '…lastSave null, not a placeholder row');
eq(empty.total, 0, '…total 0 — and 0 here is a MEASUREMENT (we looked), not "we did not look"');
eq(empty.truncated, false, '…truncated false');
eq(empty.brief, null, '…and no brief');
ok(Array.isArray(empty.warnings), '…and warnings is an array, never undefined');
ok(!fs.existsSync(path.join(EMPTY, '.curator-install-id')),
  'an empty store did not mint an identity file into the domains folder as a side effect of a READ');

const GONE = path.join(TMP, 'does-not-exist');
setDomains(GONE);
const gone = await getTraySummary();
eq(gone.ok, true, 'a MISSING domains folder answers ok rather than throwing at the panel');
eq(gone.scopes.length, 0, '…with no rows');
// listDomains() returns [] on ENOENT rather than throwing, so this is the
// "nothing here" path and not the "unreadable" one. Asserted as what it is.
ok(gone.warnings.every(w => w.code !== 'domains-unreadable'),
  '…and ENOENT is reported as EMPTY, not as unreadable — listDomains() maps it to []');
setDomains(TMP_DOMAINS);

// ═══════════════════════════════════════════════════════════════════════════
section('§9  Isolation held');
// ═══════════════════════════════════════════════════════════════════════════
eq(fingerprint(), fpBefore, 'the real credential files are byte-identical after the run');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(EMPTY, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('\n============================================================');
console.log(`Passed: ${passed}   Failed: ${failed}`);
console.log('============================================================');
process.exit(failed ? 1 : 0);
