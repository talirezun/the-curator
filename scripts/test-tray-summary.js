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
  getTraySummary, getHandoffMarkdown, noteRemoteStatus, __resetRemoteObservation,
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

// Past TRAY_MAX_PROJECTS. Each carries a standing brief and nothing else —
// the cheapest thing that IS a project. An empty domain is deliberately not
// one: since v3.48.0 the store omits a domain's own project when it has
// neither a brief nor a save, because a row describing an empty tree is noise
// on a screen whose job is "which project". A fixture of empty domains would
// therefore prove the cap fires by never reaching it.
for (let i = 0; i < TRAY_MAX_PROJECTS + 5; i++) {
  const n = `p${String(i).padStart(4, '0')}`;
  fs.mkdirSync(path.join(SCALE, n, 'state'), { recursive: true });
  fs.writeFileSync(path.join(SCALE, n, 'CLAUDE.md'), '# x\n');
  fs.writeFileSync(path.join(SCALE, n, 'state', 'project.md'), '# brief\n');
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
ok(g.local.has('src/brain/mcp-usage.js'),
  'v3.66.0: mcp-usage.js IS in the walked graph — so the two lines above prove it too reaches no fetch site');

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

// ── `ok` — THE THIRD STATE, WITHOUT WHICH THE FIRST TWO COLLAPSED ─────────
//
// This module always kept "could not ask" apart from "nothing waiting". Its
// ONLY consumer, tray-model.js's remoteNotice(), branches on `remote.ok ===
// false` — and nothing here ever emitted an `ok`, so a failed check reached
// the menu as `{behindFiles: null, …}`, took the "no number to show" exit and
// rendered as NOTHING: byte-identical to never having checked. The distinction
// survived the store and died one layer up.
//
// Absence was honest while nothing ever triggered a check. It stops being
// honest now the tray asks on its own, because then silence reads as an answer.
eq(failedCheck.ok, false, 'a failed check now SAYS it failed, in the field the model actually branches on');
noteRemoteStatus({ configured: true, remoteChecked: true, behindFiles: 0, behindCommits: 0, checkedAt: 'x' });
eq((await getTraySummary()).remote.ok, true, 'a successful check reports ok:true, even when the answer is zero');
// STRICT for failure, lenient otherwise: only an explicit `false` is an
// accusation, so a payload of some other shape is not said to have failed.
noteRemoteStatus({ configured: true, behindFiles: 1, behindCommits: 1, checkedAt: 'x' });
eq((await getTraySummary()).remote.ok, true, 'a payload with no remoteChecked field is not ACCUSED of having failed');

noteRemoteStatus({ configured: true, remoteChecked: true, behindFiles: 14, behindCommits: 2, checkedAt: '2026-08-31T10:05:00.000Z' });
const good = (await getTraySummary()).remote;
eq(good.behindFiles, 14, 'a successful check reports the file count');
eq(good.behindCommits, 2, '…and the commit count');
ok(!('files' in good) && !('remoteError' in good),
  'the preview array and the error string are NOT forwarded — the panel gets four small fields, not a sync payload');
eq(Object.keys(good).sort().join(','), 'behindCommits,behindFiles,checkedAt,ok',
  '…and it is exactly those four, so a future sync field cannot leak into a menubar payload by accident');

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
section('§8b PROJECTS — the legacy tree, read as a project named for its domain');
// ═══════════════════════════════════════════════════════════════════════════
//
// v3.48.0 splits DOMAIN from PROJECT. Everything above this line is driven
// against a REAL ON-DISK store in the pre-v3.48.0 layout, which is what every
// existing install has and what a Mac still on v3.47.0 keeps syncing here — so
// this section asserts what the data layer says about THAT tree, on disk,
// through the REAL store, and `scripts/test-tray-projects.js` drives the
// grouping and the caps through an injected fake.
setDomains(TMP_DOMAINS);
{
  const s = await getTraySummary({ limit: 20 });
  const row = s.scopes.find((r) => r.scope === 'main' && r.project === 'zulu');
  ok(row != null, 'CONTROL — the fixture row is present');
  eq(row.domain, 'zulu', 'a legacy tree\'s row names its DOMAIN…');
  eq(row.project, 'zulu', '…and its PROJECT, whose slug IS the domain name — that is what a pre-v3.48.0 tree means');
  eq(row.isDefaultProject, true,
    '…and it is MARKED as the domain\'s own project, which is what decides its on-disk path downstream rather than a guess made there');
  eq(row.projectLabel, 'zulu',
    'the label does NOT read `zulu / zulu`: the domain holds one project, so the qualifier distinguishes nothing');
  eq(row.projectsInDomain, 1, '…and the count that decided it is carried too, so a consumer can re-derive rather than re-walk');

  // The brief still resolves at the state ROOT (`<domain>/state/project.md`).
  ok(s.brief != null, 'the standing brief is still found in a legacy tree');
  eq(s.brief.domain, 'zulu', '…named by domain…');
  eq(s.brief.project, 'zulu', '…and project');
  eq(s.brief.authoredBy, null,
    '…with NO recorded author, because a pre-v3.48.0 brief carries no provenance comment and guessing one would be worse than the absence');
  ok(!('text' in s.brief) && !('bytes' in s.brief),
    'and it is still STAT-ed rather than read — a 32 KB document has no place in a menubar payload');

  // The collision warning names the project by the same label the widget's
  // header uses, and carries the domain so two domains' `main` cannot collide.
  const c = s.warnings.find((w) => w.code === 'harness-collision');
  ok(c != null, 'CONTROL — the collision warning is still emitted');
  eq(c.domain, 'gamma', '…and now carries the domain…');
  eq(c.projectLabel, 'gamma', '…and the same label the group header will show');
  ok(c.message.includes('gamma') && c.message.includes('main'),
    '…so the notice and the header name one identity, not two');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8c PROJECTS — a NAMED project, on disk, through the real store');
// ═══════════════════════════════════════════════════════════════════════════
//
// ── WHY THIS SECTION EXISTS, IN ONE SENTENCE ─────────────────────────────
//
// The store takes the DOMAIN positionally and the project on its options
// object; this module thinks in (domain, project) pairs; and getting that wrong
// DOES NOT THROW. A project name passed where an options object is expected is
// read as `{}`, `opts.project` comes back undefined, and the store answers —
// correctly, and about the DEFAULT project. Every named project in the menu
// would then render the domain's own state under someone else's name, with
// every existing assertion in this file still green, because every fixture
// above this line has only default projects.
//
// So this is the one place where a NAMED project exists on disk and the real
// store is asked for it through the real adapter.
const PROJ = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tray-proj-')));
{
  fs.mkdirSync(path.join(PROJ, 'workshop'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'workshop', 'CLAUDE.md'), '# workshop\n');
  // The domain's own project, at the state root.
  const rootPair = path.join(PROJ, 'workshop', 'state', 'housekeeping', SELF);
  fs.mkdirSync(rootPair, { recursive: true });
  fs.writeFileSync(path.join(rootPair, 'current.md'), '# Working state\n\n## Headline\n\nthe default one\n');
  // …and a NAMED project one level deeper, written LAST so it sorts first.
  const namedPair = path.join(PROJ, 'workshop', 'state', 'lumina', 'main', SELF);
  fs.mkdirSync(namedPair, { recursive: true });
  fs.writeFileSync(path.join(namedPair, 'current.md'), '# Working state\n\n## Headline\n\nthe named one\n');
  fs.writeFileSync(path.join(PROJ, 'workshop', 'state', 'lumina', 'project.md'), '# lumina\n');
  setDomains(PROJ);

  const s = await getTraySummary({ limit: 20 });
  const named = s.scopes.find((r) => r.project === 'lumina');
  const dflt = s.scopes.find((r) => r.project === 'workshop');
  ok(named != null, 'the NAMED project\'s pair is listed');
  ok(dflt != null, 'CONTROL — and the domain\'s own project is listed beside it, so this is two projects and not one read twice');
  eq(named.scope, 'main', '…with the named project\'s OWN scope');
  eq(dflt.scope, 'housekeeping',
    '…and the default project\'s own scope — the two are distinct, which is what a positional/options mix-up would collapse');
  eq(named.domain, 'workshop', 'the named row carries the domain…');
  eq(named.isDefaultProject, false, '…and is NOT the domain\'s own project, so its path keeps the project segment');
  eq(dflt.isDefaultProject, true, '…while the default one is, so its path has none');
  eq(named.projectLabel, 'workshop / lumina',
    'the label qualifies with the domain, because this domain now holds two projects');
  eq(named.projectsInDomain, 2, '…and the count that decided it is carried');

  // The brief belongs to the project of the NEWEST save, and it is the NAMED
  // project's own file — `state/lumina/project.md`, not `state/project.md`.
  ok(s.brief != null && s.brief.project === 'lumina',
    'the standing brief reported is the newest project\'s own');

  // And the handoff read goes to the named project's file, not the default's.
  const h = await getHandoffMarkdown('workshop', 'lumina', 'main', SELF);
  ok(h.ok === true, 'the handoff for the named project reads');
  ok(h.current != null && h.current.includes('the named one'),
    '…and it is the NAMED project\'s handoff — reading "the default one" here is exactly the silent mix-up this section exists for');
}
setDomains(TMP_DOMAINS);

// ═══════════════════════════════════════════════════════════════════════════
section('§8d Tier 0\'s counts ride on the row — the v3.60.0 mark was inert');
// ═══════════════════════════════════════════════════════════════════════════
//
// `desktop/lib/tray-model.js` learned in v3.60.0 to read `row.foundations`
// and print "· N docs stale" on the headline's second line — and this
// module, the PRODUCER, carried no such field on any row, so the mark could
// never fire. This section drives the REAL store end to end: a genuine
// repo-owned foundations tier, refreshed via `refreshFoundationsFromRepo`
// and then edited so one document reads STALE by a real sha256 comparison —
// the same mechanism `test-foundations.js` §6d proves against
// `listFoundations` directly. The question here is narrower and is the whole
// gap: does `getTraySummary` PICK IT UP, attach it to every row of the right
// project, exactly once per project, and survive the call throwing.
const eqJSON = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, label, a === e ? '' : `expected: ${e}\n        actual:   ${a}`);
};
const PROJ3 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tray-found-')));
const REPO3 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tray-found-repo-')));
{
  fs.mkdirSync(path.join(PROJ3, 'workshop'), { recursive: true });
  fs.writeFileSync(path.join(PROJ3, 'workshop', 'CLAUDE.md'), '# workshop\n');
  // 'lumina' — THREE saved work-streams, so a per-ROW call would be 3x a
  // per-PROJECT one and §8d.3 below can tell the difference.
  for (const [scope, ageSec] of [['session-a', 60], ['session-b', 600], ['session-c', 6000]]) {
    const dir = path.join(PROJ3, 'workshop', 'state', 'lumina', scope, SELF);
    fs.mkdirSync(dir, { recursive: true });
    const cur = path.join(dir, 'current.md');
    fs.writeFileSync(cur, `# Working state\n\n## Headline\n\n${scope}\n`);
    const t = (NOW - ageSec * SEC) / 1000;
    fs.utimesSync(cur, t, t);
  }
  // 'atlas' — one work-stream, NO foundations tier at all. Aged to 300s so
  // it sits between lumina's two newest saves rather than at "now" (a bare
  // writeFileSync mtime), which would otherwise make it — not lumina — the
  // newest save in the fixture and starve §8d.2's lastSave assertion.
  const atlasDir = path.join(PROJ3, 'workshop', 'state', 'atlas', 'main', SELF);
  fs.mkdirSync(atlasDir, { recursive: true });
  const atlasCur = path.join(atlasDir, 'current.md');
  fs.writeFileSync(atlasCur, '# Working state\n\n## Headline\n\natlas work\n');
  { const t = (NOW - 300 * SEC) / 1000; fs.utimesSync(atlasCur, t, t); }

  setDomains(PROJ3);

  // A real repo-owned foundations tier for 'lumina', refreshed once, then
  // edited so the mirror is genuinely stale — `computeFreshness` does a real
  // sha256 comparison against this file, nothing simulated.
  fs.mkdirSync(path.join(REPO3, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(REPO3, 'docs', 'architecture.md'), '# Architecture\n\nv1\n'.repeat(20));
  const refreshed = await wsMod.refreshFoundationsFromRepo('workshop', 'lumina', REPO3, {
    files: [{ path: 'docs/architecture.md', role: 'architecture' }],
  });
  ok(refreshed.ok === true, 'PRECONDITION: the foundations tier refreshed against a real repo dir', refreshed.message);
  fs.writeFileSync(path.join(REPO3, 'docs', 'architecture.md'), '# Architecture\n\nv2, edited\n'.repeat(20));
  const idxCheck = await wsMod.listFoundations('workshop', 'lumina');
  ok(idxCheck.staleCount === 1, 'PRECONDITION: listFoundations itself reads one stale document', JSON.stringify(idxCheck));

  // §8d.1 — ABSENT TIER READS AS ZEROS, never null and never an error.
  const plain = await getTraySummary({ limit: 20 });
  const atlasRows = plain.scopes.filter((r) => r.project === 'atlas');
  eq(atlasRows.length, 1, 'CONTROL: the atlas row is present');
  eqJSON(atlasRows[0].foundations, { staleCount: 0, unreachableCount: 0 },
    'a project with no foundations tier at all reports zeros, never null');
  eq(atlasRows[0].foundationsError, null, '…and no error, because absence is not a failure');

  // §8d.2 — THE REAL STALE COUNT RIDES ON EVERY ROW OF THE RIGHT PROJECT.
  const luminaRows = plain.scopes.filter((r) => r.project === 'lumina');
  eq(luminaRows.length, 3, 'CONTROL: all three lumina work-streams are present');
  for (const r of luminaRows) {
    eqJSON(r.foundations, { staleCount: 1, unreachableCount: 0 },
      `row "${r.scope}" carries the real stale count computed off disk`);
    eq(r.foundationsError, null, `…and no error on row "${r.scope}"`);
  }
  ok(luminaRows.every((r) => r.foundations === luminaRows[0].foundations),
    'the SAME object rides every row of one project — one computation, not one per row');
  eq(plain.lastSave.project, 'lumina', 'CONTROL: the newest save in the fixture is a lumina row, so the headline exercises this too');
  eqJSON(plain.lastSave.foundations, { staleCount: 1, unreachableCount: 0 },
    'lastSave — the headline\'s own source — carries the same counts, not just the row list');

  // §8d.3 — listFoundations IS CALLED ONCE PER PROJECT, NEVER ONCE PER ROW.
  //
  // Wired through the SAME store seam `getTraySummary({store})` already
  // exposes for `storeAdapter` — a real delegate to the real store for
  // everything, with `listFoundations` counted on the way through. This is
  // not a second opinion about what the store computes, only about how many
  // times it is asked, so it is the seam the module already uses rather than
  // a new one.
  {
    const calls = [];
    const spyStore = {
      listAllProjects: (...a) => wsMod.listAllProjects(...a),
      listWorkingScopes: (...a) => wsMod.listWorkingScopes(...a),
      readWorkingState: (...a) => wsMod.readWorkingState(...a),
      listFoundations: (domain, project) => {
        calls.push(`${domain}/${project}`);
        return wsMod.listFoundations(domain, project);
      },
    };
    const spied = await getTraySummary({ store: spyStore, limit: 20 });
    eq(spied.scopes.filter((r) => r.project === 'lumina').length, 3, 'CONTROL: three lumina rows, through the spy too');
    eq(calls.filter((c) => c === 'workshop/lumina').length, 1,
      `listFoundations was called exactly ONCE for lumina despite three rows (calls: ${JSON.stringify(calls)})`);
    eq(calls.filter((c) => c === 'workshop/atlas').length, 1,
      'and exactly once for atlas too — whose single row alone could not distinguish "once" from "once per row"');
  }

  // §8d.4 — A THROWING listFoundations COSTS ONE PROJECT'S ROWS A ZERO AND A
  // NAMED ERROR, NEVER THE WHOLE SUMMARY. The same store seam, this time
  // failing on exactly the project under test so the control (atlas) proves
  // the failure did not leak sideways.
  {
    const throwingStore = {
      listAllProjects: (...a) => wsMod.listAllProjects(...a),
      listWorkingScopes: (...a) => wsMod.listWorkingScopes(...a),
      readWorkingState: (...a) => wsMod.readWorkingState(...a),
      listFoundations: (domain, project) => {
        if (domain === 'workshop' && project === 'lumina') throw new Error('synthetic foundations failure');
        return wsMod.listFoundations(domain, project);
      },
    };
    const broken = await getTraySummary({ store: throwingStore, limit: 20 });
    eq(broken.ok, true, 'a throwing listFoundations never fails the whole summary');
    const brokenLumina = broken.scopes.filter((r) => r.project === 'lumina');
    eq(brokenLumina.length, 3, '…and lumina\'s rows are still all present');
    for (const r of brokenLumina) {
      eqJSON(r.foundations, { staleCount: 0, unreachableCount: 0 },
        `row "${r.scope}" degrades to zeros, not a stale count it never computed`);
      ok(typeof r.foundationsError === 'string' && /synthetic foundations failure/.test(r.foundationsError),
        `…and names the failure (${r.foundationsError})`);
    }
    const brokenAtlas = broken.scopes.filter((r) => r.project === 'atlas');
    eqJSON(brokenAtlas[0].foundations, { staleCount: 0, unreachableCount: 0 }, 'atlas, whose call did not throw, is unaffected');
    eq(brokenAtlas[0].foundationsError, null, '…with no error either');
  }
}
// ═══════════════════════════════════════════════════════════════════════════
section('§8e v3.66.0 — documents, capture and per-domain pages: the widget’s three bars');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { documentsReading, captureFor, TRAY_CAPTURE_WINDOW_DAYS } = await import('../src/brain/tray-summary.js');
  const usageMod = await import('../src/brain/mcp-usage.js');
  const pathsMod = await import('../src/brain/paths.js');
  const filesMod = await import('../src/brain/files.js');

  // A wiki page so the per-domain count is not trivially zero.
  fs.mkdirSync(path.join(PROJ3, 'workshop', 'wiki', 'entities'), { recursive: true });
  fs.writeFileSync(path.join(PROJ3, 'workshop', 'wiki', 'entities', 'alpha.md'), '# Alpha\n');
  fs.writeFileSync(path.join(PROJ3, 'workshop', 'wiki', 'entities', 'beta.md'), '# Beta\n');
  fs.mkdirSync(path.join(PROJ3, 'workshop', 'wiki', 'summaries'), { recursive: true });
  fs.writeFileSync(path.join(PROJ3, 'workshop', 'wiki', 'summaries', 'source-one.md'), '# Source one\n');

  // ── (1) DOCUMENTS: the same listFoundations answer, one budget named ─────
  usageMod.__clearUsageCache();
  const s1 = await getTraySummary({ limit: 20 });
  const idx = await wsMod.listFoundations('workshop', 'lumina');
  const lum = s1.scopes.filter((r) => r.project === 'lumina');
  const d = lum[0] ? lum[0].documents : null;
  ok(d && d.count === 1, 'lumina rows carry documents with count 1', JSON.stringify(d));
  eq(d && d.totalBytes, idx.totalBytes, 'totalBytes IS listFoundations’ own figure, not a second derivation');
  eq(d && d.basis, 'stored', 'nothing flagged read-first → the bar is STORED bytes…');
  eq(d && d.applicableBudgetBytes, wsMod.FOUNDATIONS_BUDGET_BYTES, '…against the 200 KB PROJECT budget');
  eq(d && d.readFirstBudgetBytes, wsMod.CONTEXT_MAX_BYTES_DEFAULT, 'the 120 KB reading budget rides beside it, named apart');
  ok(lum.every((r) => r.documents === lum[0].documents), 'the SAME documents object rides every row of one project');
  eq(s1.lastSave && s1.lastSave.documents, lum[0] && lum[0].documents, 'lastSave (the widget’s "open project") carries it too');
  const atl = s1.scopes.find((r) => r.project === 'atlas');
  ok(atl && atl.documents && atl.documents.count === 0 && atl.documents.totalBytes === 0 && atl.documents.exceeded === false,
    'a project with NO documents is a MEASURED zero, not null', JSON.stringify(atl && atl.documents));

  // Flag the one document read-first: the basis switches to the app's rule.
  const slug = idx.documents[0].slug;
  const flag = await wsMod.setFoundationReadFirst('workshop', 'lumina', slug, true);
  ok(flag && flag.ok === true, 'PRECONDITION: the document is flagged read-first through the real store');
  const s2 = await getTraySummary({ limit: 20 });
  const d2 = (s2.scopes.find((r) => r.project === 'lumina') || {}).documents;
  eq(d2 && d2.basis, 'read-first', 'one flagged document → the bar is the READ-FIRST set…');
  eq(d2 && d2.applicableBudgetBytes, wsMod.CONTEXT_MAX_BYTES_DEFAULT, '…against the 120 KB per-session budget (foundationsBudgetWarning’s rule)');
  eq(d2 && d2.amountBytes, d2 && d2.readFirstBytes, '…and its amount is the read-first bytes');
  // v3.67.0 — THE OWNER'S READING BUDGET reaches the widget with NO tray
  // change: `listFoundations` fills `readFirstBudgetBytes` with the owner's
  // number, and the bar's denominator is that field. Set through the real
  // store, read back through the real summary.
  const setB = await wsMod.setReadingBudget('workshop', 'lumina', 32768);
  ok(setB && setB.ok === true, 'PRECONDITION: the owner sets a 32 KB reading budget through the real store', JSON.stringify(setB));
  const sRb = await getTraySummary({ limit: 20 });
  const d3 = (sRb.scopes.find((r) => r.project === 'lumina') || {}).documents;
  eq(d3 && d3.readFirstBudgetBytes, 32768, 'the tray\u2019s readFirstBudgetBytes FOLLOWS the owner\u2019s budget');
  eq(d3 && d3.applicableBudgetBytes, 32768, '…and so does the read-first bar\u2019s denominator');
  await wsMod.setReadingBudget('workshop', 'lumina', 0);
  const d4 = (((await getTraySummary({ limit: 20 })).scopes.find((r) => r.project === 'lumina')) || {}).documents;
  ok(d4 && d4.readFirstBudgetBytes === 0 && d4.exceeded === true,
    'Index only (0): the budget reads 0 and a flagged set is over it — the widget says none of that text is handed over', JSON.stringify(d4));
  await wsMod.setReadingBudget('workshop', 'lumina', null);
  eq(((((await getTraySummary({ limit: 20 })).scopes.find((r) => r.project === 'lumina')) || {}).documents || {}).readFirstBudgetBytes,
    wsMod.CONTEXT_MAX_BYTES_DEFAULT, 'cleared: back to the 120 KB default');
  await wsMod.setFoundationReadFirst('workshop', 'lumina', slug, false);

  // The pure rule, driven over both arms of an over-run.
  const base = { ok: true, totalBytes: 250000, budgetBytes: 204800, readFirstCount: 0, readFirstBytes: 0, readFirstBudgetBytes: 122880, count: 3 };
  const over1 = documentsReading(base);
  ok(over1.basis === 'stored' && over1.exceeded === true && over1.budgetExceeded === true, 'stored over 200 KB, nothing flagged → exceeded');
  const over2 = documentsReading({ ...base, totalBytes: 150000, readFirstCount: 2, readFirstBytes: 130000 });
  ok(over2.basis === 'read-first' && over2.exceeded === true && over2.budgetExceeded === false,
    'under 200 KB stored but 130 KB flagged → exceeded against 120 KB (the two budgets never collapse)');
  const fine = documentsReading({ ...base, totalBytes: 250000, readFirstCount: 1, readFirstBytes: 10000 });
  ok(fine.basis === 'read-first' && fine.exceeded === false && fine.budgetExceeded === true,
    'over 200 KB stored but a small flagged set → the BAR is not over (the app warns about the read-first set only)');
  eq(documentsReading({ ...base, manifestError: 'bad json' }), null, 'an unreadable manifest → null (its zeros are defaults, not a measurement)');
  eq(documentsReading({ ok: false, reason: 'x' }), null, 'a refused index → null');
  eq(documentsReading({ ...base, totalBytes: undefined }), null, 'a missing figure → null, never a fabricated 0');

  // ── (2) CAPTURE: no log → null; a log → the capture meter's own numbers ──
  const LOGF = pathsMod.getMcpUsageLogPath();
  try { fs.rmSync(LOGF, { force: true }); fs.rmSync(`${LOGF}.1`, { force: true }); } catch { /* absent */ }
  usageMod.__clearUsageCache();
  const s3 = await getTraySummary({ limit: 20 });
  eq(s3.capture && s3.capture.logPresent, false, 'no usage log → capture.logPresent false');
  eq(s3.capture && s3.capture.busiestSaved, null, '…busiestSaved null (a denominator of an untaken reading is not 0)');
  ok(s3.scopes.every((r) => r.capture === null), '…and every row’s capture is null — NOT MEASURED, never 0');
  eq(s3.capture && s3.capture.windowDays, 30, 'the capture window is 30 days');
  const routeSrc = fs.readFileSync(path.join(ROOT, 'src/routes/memory.js'), 'utf8');
  ok(/CAPTURE_DEFAULT_SINCE_MS = 30 \* 24 \* 60 \* 60 \* 1000/.test(routeSrc) && TRAY_CAPTURE_WINDOW_DAYS === 30,
    'the widget’s window is the Context capture meter’s default window (routes/memory.js), pinned');

  const iso = (ms) => new Date(NOW - ms).toISOString();
  const log = [
    { ts: iso(3600e3), tool: 'get_project_context', domain: 'workshop', project: 'lumina', ok: true, refused: false, ms: 1, sid: 'f1f1f1f1f1f1' },
    { ts: iso(3500e3), tool: 'save_working_state', domain: 'workshop', project: 'lumina', ok: true, refused: false, ms: 1, sid: 'f1f1f1f1f1f1' },
    { ts: iso(7200e3), tool: 'get_project_context', domain: 'workshop', project: 'lumina', ok: true, refused: false, ms: 1, sid: 'f2f2f2f2f2f2' },
    { ts: iso(100e3), tool: 'save_working_state', domain: 'workshop', project: 'lumina', ok: true, refused: false, ms: 1, sid: 'f3f3f3f3f3f3', via: 'self-test' },
    { ts: iso(40 * 86400e3), tool: 'save_working_state', domain: 'workshop', project: 'lumina', ok: true, refused: false, ms: 1, sid: 'f4f4f4f4f4f4' },
  ];
  fs.writeFileSync(LOGF, log.map((o) => JSON.stringify(o)).join('\n') + '\n');
  usageMod.__clearUsageCache();
  const s4 = await getTraySummary({ limit: 20 });
  const lc = (s4.scopes.find((r) => r.project === 'lumina') || {}).capture;
  const ref = usageMod.summariseSessions((await usageMod.readUsageLines({ noCache: true })).records,
    { project: 'lumina', since: NOW - 30 * 86400e3 }).totals;
  ok(lc && lc.sessions === ref.sessions && lc.sessionsSaved === ref.sessionsSaved && lc.sessionsRead === ref.sessionsRead,
    `lumina’s capture equals the capture route’s own reading (${lc && lc.sessions}/${lc && lc.sessionsSaved} vs ${ref.sessions}/${ref.sessionsSaved})`);
  eq(lc && lc.sessions, 2, 'two agent sessions in 30 days (the self-test and the 40-day-old one excluded)');
  eq(lc && lc.sessionsSaved, 1, 'one of them saved');
  const ac = (s4.scopes.find((r) => r.project === 'atlas') || {}).capture;
  ok(ac && ac.sessions === 0 && ac.sessionsSaved === 0, 'atlas, never in the PRESENT log, is a MEASURED 0', JSON.stringify(ac));
  eq(s4.capture.logPresent, true, 'capture.logPresent true');
  eq(s4.capture.busiestSaved, 1, 'busiestSaved is the max sessions-that-saved over every scanned project');
  eq(s4.capture.selfTestLines, 1, 'the self-test line is disclosed as excluded');
  eq(s4.lastSave && s4.lastSave.capture, (s4.scopes[0] || {}).capture, 'lastSave carries its project’s capture');
  // Atlas becomes the busiest (two saving sessions), while the ONE row a
  // limit of 1 keeps is lumina's — so a denominator taken from the shown rows
  // would read 1 here, and the true one is 2.
  fs.appendFileSync(LOGF, [
    { ts: iso(5000e3), tool: 'save_working_state', domain: 'workshop', project: 'atlas', ok: true, refused: false, ms: 1, sid: 'a9a9a9a9a9a9' },
    { ts: iso(6000e3), tool: 'save_working_state', domain: 'workshop', project: 'atlas', ok: true, refused: false, ms: 1, sid: 'a8a8a8a8a8a8' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  usageMod.__clearUsageCache();
  const one = await getTraySummary({ limit: 1 });
  eq(one.scopes.length === 1 ? one.scopes[0].project : null, 'lumina', 'CONTROL: limit 1 keeps only lumina’s row');
  eq(one.capture.busiestSaved, 2, 'busiestSaved is taken over EVERY scanned project (atlas: 2), never the rows left after limit');
  ok(Array.isArray(one.projects) && one.projects.length === 2, 'projects[] lists every scanned project, whatever the limit');
  const pl = one.projects.find((p) => p.project === 'lumina') || {};
  ok(pl.documents && pl.capture && pl.projectLabel, 'a projects[] entry carries documents, capture and its label');
  eq(captureFor(new Map(), false, 'x', 'y'), null, 'captureFor with no log → null');
  const mm = captureFor(new Map([['y', { sessions: 1, sessionsRead: 1, sessionsSaved: 1, lastSessionAt: null, domains: ['other'] }]]), true, 'x', 'y');
  eq(mm.domainMismatch, true, 'a name the log attributes only to another domain is flagged, not hidden');
  const sizeBefore = fs.statSync(LOGF).size;
  await getTraySummary({ limit: 20 });
  eq(fs.statSync(LOGF).size, sizeBefore, 'the summary writes NOTHING to the usage log');
  fs.rmSync(LOGF, { force: true });
  usageMod.__clearUsageCache();

  // ── (3) PER-DOMAIN PAGES: the app's own count, in the install's order ─────
  const s5 = await getTraySummary({ limit: 20 });
  const names = await filesMod.listDomains();
  ok(Array.isArray(s5.domains) && s5.domains.map((x) => x.domain).join(',') === names.join(','),
    'domains[] is in listDomains() order (a tie-break only — the colour is each row\'s recorded `slot`, v3.76.0)');
  const ws0 = s5.domains.find((x) => x.domain === 'workshop') || {};
  const stats = await filesMod.getDomainStats('workshop');
  eq(ws0.pageCount, stats.pageCount, 'pageCount IS getDomainStats’ (what GET /api/domains/stats answers) — one count, two surfaces');
  eq(ws0.pageCount, 3, '…and it counted the three fixture pages (two entities, one summary)');
  ok(ws0.entities === 2 && ws0.concepts === 0 && ws0.summaries === 1, 'the per-type split rides beside it', JSON.stringify(ws0));
  eq(ws0.index, names.indexOf('workshop'), 'index is the install’s own domain index');
}

setDomains(TMP_DOMAINS);

// ═══════════════════════════════════════════════════════════════════════════
section('§8f v3.66.0 — getStoreActivity’s pulse IS the widget’s pulse');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { getStoreActivity } = await import('../src/brain/tray-summary.js');
  const at = NOW;
  const full = await getTraySummary({ limit: 20, now: at });
  const act = await getStoreActivity({ now: at });
  ok(full.pulse !== null, 'CONTROL: the main fixture has journals, so the widget draws a pulse');
  eq(JSON.stringify(act.pulse), JSON.stringify(full.pulse),
    'getStoreActivity().pulse is byte-identical to getTraySummary().pulse — the app’s "saves, last 7 days" is the widget’s number');
  eq(act.ok, true, 'ok');
  ok(Array.isArray(act.projects) && act.projects.length > 0
    && act.projects.every((p) => typeof p.domain === 'string' && typeof p.project === 'string' && typeof p.projectLabel === 'string'),
    'it lists every project with its label');
  const calls = [];
  const spy = {
    listAllProjects: (...a) => wsMod.listAllProjects(...a),
    listWorkingScopes: (...a) => wsMod.listWorkingScopes(...a),
    readWorkingState: (...a) => { calls.push('read'); return wsMod.readWorkingState(...a); },
    listFoundations: (...a) => { calls.push('foundations'); return wsMod.listFoundations(...a); },
  };
  await getStoreActivity({ store: spy, now: at });
  eq(calls.length, 0, 'it never calls listFoundations or readWorkingState — the polled route pays for no hashing');
  const bad = await getStoreActivity({ store: { listAllProjects: () => { throw new Error('gone'); } } });
  ok(bad.ok === false && bad.pulse === null && bad.projects === null, 'an unreadable store answers not-measured (nulls), never an empty pulse');
}

try { fs.rmSync(PROJ3, { recursive: true, force: true }); } catch { /* best effort */ }
try { fs.rmSync(REPO3, { recursive: true, force: true }); } catch { /* best effort */ }

// ═══════════════════════════════════════════════════════════════════════════
section('§8g v3.74.0 — latest per tool (D3), lanes per tool (D4), the capture window (D5), D7');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { getStoreActivity } = await import('../src/brain/tray-summary.js');
  // Deep equality by serialisation — this suite's `eq` is `===`.
  const deq = (a, e, label) => eq(JSON.stringify(a), JSON.stringify(e), label);
  const V74 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tray-v374-')));
  const MIN = 60 * SEC, HOUR = 3600 * SEC, DAY = 86400 * SEC;
  const isoAgo = (ms) => new Date(NOW - ms).toISOString();
  function pair(domain, scope, machine, { mtimeAgo, lines }) {
    const dir = path.join(V74, domain, 'state', scope, machine);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'current.md'), `# ${scope}\n`);
    if (lines) {
      fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.map((l) => JSON.stringify({
        at: isoAgo(l.ago), scope, machine, headline: l.headline, harness: l.harness, model: l.model || null, rejections: [],
      })).join('\n') + '\n');
    }
    const t = (NOW - mtimeAgo) / 1000;
    fs.utimesSync(path.join(dir, 'current.md'), t, t);
  }
  for (const d of ['ott', 'idle']) {
    fs.mkdirSync(path.join(V74, d), { recursive: true });
    fs.writeFileSync(path.join(V74, d, 'CLAUDE.md'), `# ${d}\n`);
  }
  pair('ott', 'claude-code', SELF, { mtimeAgo: 8 * MIN, lines: [{ ago: 8 * MIN, headline: 'OTT-CC', harness: 'Claude Code (desktop)', model: 'claude-opus-5-5' }] });
  // An OLDER Claude Code save whose FILE is the newest on disk (a pull) — the
  // per-tool pick must still be OTT-CC, by the agent's clock.
  pair('ott', 'old-cc', OTHER, { mtimeAgo: 1 * SEC, lines: [{ ago: 2 * DAY, headline: 'OTT-OLD', harness: 'claude-code' }] });
  pair('ott', 'antigravity', OTHER, { mtimeAgo: 2 * SEC, lines: [{ ago: 3 * HOUR, headline: 'OTT-AG', harness: 'Antigravity', model: 'gemini-3.7-flash' }] });
  pair('ott', 'noname', SELF, { mtimeAgo: 1 * DAY, lines: [{ ago: 1 * DAY, headline: 'OTT-NONAME' }] });
  // One tool typed three ways, alternating — must NOT be a collision.
  pair('ott', 'drift', SELF, { mtimeAgo: 4 * DAY, lines: [
    { ago: 6 * DAY, headline: 'd1', harness: 'Claude Code' }, { ago: 5 * DAY, headline: 'd2', harness: 'claude-code' },
    { ago: 4 * DAY, headline: 'd3', harness: 'Claude Code (worker agent)' }] });
  // Two tools really taking turns — MUST still be a collision.
  pair('ott', 'shared', SELF, { mtimeAgo: 5 * DAY, lines: [
    { ago: 7 * DAY, headline: 's1', harness: 'Claude Code' }, { ago: 6 * DAY, headline: 's2', harness: 'Antigravity' },
    { ago: 5 * DAY, headline: 's3', harness: 'claude-code' }] });
  pair('idle', 'main', OTHER, { mtimeAgo: 9 * DAY, lines: [{ ago: 9 * DAY, headline: 'IDLE', harness: 'Claude Code' }] });
  setDomains(V74);

  // ── D7: the shell's call ──────────────────────────────────────────────
  const s = await getTraySummary({ limit: 1, now: NOW, sessionStart: false });
  eq(s.sessionStart, null, 'D7: sessionStart:false → the field is null (not measured), and no warning claims a failure');
  ok(!s.warnings.some((w) => w.code === 'session-start-unavailable'), '…no session-start warning');
  const withSS = await getTraySummary({ limit: 1, now: NOW });
  ok(withSS.sessionStart !== null, 'CONTROL: without the switch the reading IS taken, so the switch is what turned it off');

  // ── D3: latest per tool, for EVERY project ─────────────────────────────
  eq(s.scopes.length, 1, 'CONTROL: limit 1 → one row, so an idle project has NO row…');
  const idle = (s.projects || []).find((p) => p.project === 'idle');
  ok(idle && Array.isArray(idle.latest) && idle.latest.length === 1, '…yet its newest save is still known (projects[].latest)', JSON.stringify(idle && idle.latest));
  const il = (idle && idle.latest[0]) || {};
  deq([il.harness, il.harnessId, il.harnessRaw, il.headline, il.scope, il.machine, il.isThisMachine, il.ageSource],
    ['Claude Code', 'claude-code', 'Claude Code', 'IDLE', 'main', OTHER, false, 'agent'], 'the idle entry carries tool, headline, scope, machine, identity and clock');
  eq(il.writtenAt, isoAgo(9 * DAY), '…on the agent\'s clock');
  const ott = (s.projects || []).find((p) => p.project === 'ott');
  const ids = ott ? ott.latest.map((e) => e.harnessId) : null;
  deq(ids, ['claude-code', 'antigravity', null], 'ott: ONE entry per tool, newest first; a save naming no tool is its own entry');
  const cc = ott.latest[0];
  eq(cc.headline, 'OTT-CC', 'the Claude Code entry is the NEWER save (8 min), although the older save\'s FILE has the newer mtime');
  deq([cc.harness, cc.harnessRaw, cc.harnessVariant, cc.model, cc.kind], ['Claude Code', 'Claude Code (desktop)', 'desktop', 'claude-opus-5-5', 'complete'],
    '…label normalised, raw spelling and variant kept, model and save kind carried');
  deq([cc.isThisMachine, cc.isThisHost === true || cc.isThisHost === false], [true, true], '…with machine identity');
  const ag = ott.latest[1];
  deq([ag.headline, ag.writtenAt, ag.ageSource, ag.isThisMachine], ['OTT-AG', isoAgo(3 * HOUR), 'agent', false],
    'the Antigravity entry dates by its journal (3 h), not by its pulled mtime (2 s)');
  eq(ott.latestTruncated, false, 'latestTruncated false when the index was not capped');
  ok(s.projects.every((p) => Array.isArray(p.latest)), 'every scanned project carries latest');

  // ── D1 on the rows and the collision notice ────────────────────────────
  const rows = (await getTraySummary({ limit: 40, now: NOW, sessionStart: false })).scopes;
  const r0 = rows.find((r) => r.scope === 'claude-code');
  deq([r0.harness, r0.harnessId, r0.harnessLabel], ['Claude Code (desktop)', 'claude-code', 'Claude Code'], 'rows keep the raw harness and ADD harnessId / harnessLabel');
  deq([s.lastSave.harnessId, s.lastSave.harnessLabel], ['claude-code', 'Claude Code'], 'lastSave carries them too');
  const coll = s.warnings.filter((w) => w.code === 'harness-collision').map((w) => w.scope);
  deq(coll, ['shared'], 'a real A-B-A raises the collision; one tool spelled three ways ("drift") does NOT');

  // ── D4: lanes per tool ─────────────────────────────────────────────────
  const pu = s.pulse;
  eq(pu.harnessCount, 2, 'harnessCount counts TOOLS (Claude Code + Antigravity), not the five spellings in the window');
  deq(pu.harnesses, ['claude-code', 'antigravity'], 'pulse.harnesses: the lanes, newest-seen first');
  eq(pu.byHarness['claude-code'].label, 'Claude Code', 'a lane is labelled with the canonical name');
  const ccEvents = pu.byHarness['claude-code'].events, agEvents = pu.byHarness.antigravity.events;
  eq(ccEvents, 1 + 1 + 3 + 1, 'the Claude Code lane: OTT-CC, OTT-OLD, drift ×3, shared s3 (s1 at 7 d is on the window edge — outside)');
  eq(agEvents, 2, 'the Antigravity lane: OTT-AG and shared s2');
  eq(ccEvents + agEvents + pu.eventsWithoutHarness, pu.events, 'lanes + unnamed = every event in the window');
  eq(pu.byHarness.antigravity.lastSeenAt, isoAgo(3 * HOUR), 'lastSeenAt is the newest save read for that tool');
  const act = await getStoreActivity({ now: NOW });
  eq(JSON.stringify(act.pulse), JSON.stringify(pu), 'the app\'s getStoreActivity pulse carries the same lanes (parity)');

  // ── D5: the capture window the log really covers ──────────────────────
  const rec = (agoMs, project, sid, tool = 'save_working_state') => ({ at: NOW - agoMs, tool, domain: project, project, ok: true, refused: false, ms: 1, sid });
  const short = { present: true, files: 1, records: [
    rec(5 * DAY, 'ott', 'aaaaaaaaaaaa', 'get_project_context'),
    rec(1 * HOUR, 'ott', 'bbbbbbbbbbbb'), rec(1 * HOUR, 'idle', 'bbbbbbbbbbbb'),
  ] };
  const c1 = await getTraySummary({ limit: 1, now: NOW, sessionStart: false, usage: short });
  eq(c1.capture.windowDays, 30, 'the window ASKED for is still 30 days…');
  deq([c1.capture.logStartsAt, c1.capture.windowStartsAt, c1.capture.windowDaysCovered, c1.capture.windowCovered],
    [isoAgo(5 * DAY), isoAgo(5 * DAY), 5, false], '…but a log that began 5 days ago says so: the reading covers 5 days, not 30');
  eq(c1.capture.unit, 'mcp-bridge-process', 'the unit is named: a bridge process, not an agent session');
  const oc = (c1.projects.find((p) => p.project === 'ott') || {}).capture;
  const ic = (c1.projects.find((p) => p.project === 'idle') || {}).capture;
  deq([oc.bridgeRuns, oc.bridgeRunsSaved, oc.bridgeRuns === oc.sessions], [2, 1, true], 'bridgeRuns is the old `sessions` figure under an honest name (old field kept)');
  deq([ic.bridgeRuns, ic.bridgeRunsSaved], [1, 1], 'ONE bridge process that touched two projects counts on both — which is why it is not "sessions"');
  const long = { present: true, files: 1, records: [rec(40 * DAY, 'ott', 'cccccccccccc'), rec(1 * HOUR, 'ott', 'dddddddddddd')] };
  const c2 = await getTraySummary({ limit: 1, now: NOW, sessionStart: false, usage: long });
  deq([c2.capture.windowCovered, c2.capture.windowDaysCovered, c2.capture.windowStartsAt, c2.capture.logStartsAt],
    [true, 30, new Date(NOW - 30 * DAY).toISOString(), isoAgo(40 * DAY)], 'a log older than the window covers all 30 days');
  const none = await getTraySummary({ limit: 1, now: NOW, sessionStart: false, usage: { present: false, files: 0, records: [] } });
  deq([none.capture.logStartsAt, none.capture.windowDaysCovered, none.capture.windowCovered], [null, null, null], 'no log → the window facts are null, never 0');

  setDomains(TMP_DOMAINS);
  try { fs.rmSync(V74, { recursive: true, force: true }); } catch { /* best effort */ }
}

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
