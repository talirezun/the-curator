#!/usr/bin/env node
/**
 * OFFLINE — the two TRUTH defects in the memory layer, and the surface that
 * answers "am I saved?".
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 * ═════════════════════════════════════════════════════════════════════════
 * Two things the shipped Agent-memory surfaces were stating confidently and
 * wrongly, plus the reading that was added because of them.
 *
 * ── DEFECT 1: TWO HARNESSES, ONE HANDOFF FILE ────────────────────────────
 * State lives at `state/<scope>/<machine>/`, and `<machine>` is
 * `<hostname-slug>-<install-id>` — per INSTALLATION, not per process. So two
 * agent tools on one computer (opencode and Claude Code, say) resolve to the
 * SAME folder. `skills/curator-continuity` tells both of them to "reuse an
 * existing scope whenever the work continues", so both land on `main`, and a
 * save OVERWRITES: the second one wins and nothing warns anybody. The one
 * guard that could refuse it (`would-replace-larger-state`) fires only under
 * REPLACE_RATIO of the stored body, and two working handoffs are both
 * substantial — §3 reproduces that non-refusal rather than asserting it.
 *
 * The fix is a READING, not a path change, and the reason is recorded here so
 * a later pass does not "improve" it into a migration: adding a `<harness>`
 * segment would change the layout of a SYNCED store that already has data on
 * real machines, and the per-machine segment is load-bearing for the
 * sync-merge guarantee in docs/working-state.md. The journal survives the
 * collision — it is append-only and every line already carries `harness` — so
 * the condition is detectable at zero additional I/O, which §2 pins.
 *
 * ── DEFECT 2: EVERY PULLED SCOPE READ AS BRAND NEW ───────────────────────
 * `ageSeconds`, `lastWriteAt` and `current.savedAt` all come from `st.mtime`,
 * and git sets mtime to the moment IT wrote the file locally. On a machine
 * that pulls state from another, every handoff therefore carried the age of
 * the PULL. §4 reproduces that mechanism without git — by writing state and
 * then setting its mtime forward, which is exactly what a checkout does to
 * these files — and requires the store to keep reporting the AGENT'S clock.
 *
 * ── THE SURFACE ──────────────────────────────────────────────────────────
 * §6-§8 execute the shipped `renderSaveStatus` out of live source. The
 * assertion that carries the most weight is §7's: a save the store had to TRIM
 * may never be rendered as a bare age. "Saved 2 minutes ago" over a truncated
 * handoff is a comforting lie, and the fact was already on disk — it just
 * stopped one layer short of any surface that answers the question.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHAT IT DELIBERATELY DOES NOT COVER
 * ═════════════════════════════════════════════════════════════════════════
 *  · REAL GIT. `scripts/test-working-state-sync.js` owns that, with real
 *    clones and a real bare remote. §4 reproduces the mtime MECHANISM with
 *    `utimes`, which is what a checkout does to a file's timestamps; it does
 *    not prove git does it. That measurement lives in the research pass.
 *  · CSS RENDERING. The pip's five steps are asserted as CLASSES on rendered
 *    output; whether they are perceptibly different is a browser question and
 *    this suite makes no claim about it.
 *  · WHETHER TWO HARNESSES ARE RUNNING RIGHT NOW. The store reports what the
 *    journal recorded. A harness that never sends `harness` is invisible to
 *    this, and §2 asserts the blind half is COUNTED rather than assumed away.
 *
 * SAFETY — never touches real user data. Domains and user-data are both
 * pinned into a throwaway tempdir BEFORE any module that resolves a path is
 * imported, and §9 walks the tree to prove every file this suite produced is
 * inside it.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync,
  utimesSync, statSync } from 'node:fs';
const statMtime = (p) => statSync(p).mtimeMs;
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { renderMonitor } from '../src/public/next/shared/monitor.js';
import { freshnessTier } from '../src/public/next/shared/age.js';
// v4.2.0 fix: lifted renderers name machines by the REAL shared/machine-name.js
// (a free name in `new Function` code resolves on globalThis).
import * as MACHINE_NAME_MOD from '../src/public/next/shared/machine-name.js';
globalThis.machineDisplayName = MACHINE_NAME_MOD.machineDisplayName;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NEXT = join(ROOT, 'src/public/next');

// ── Isolation, established BEFORE any import that resolves a path ─────────
const TMP = mkdtempSync(join(tmpdir(), 'curator-memtruth-'));
const DOMAINS = join(TMP, 'domains');
const USER_DATA = join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete process.env[k];

function cleanup() {
  try {
    const rel = relative(tmpdir(), TMP);
    if (rel && !rel.startsWith('..') && !rel.includes('/')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
}
process.on('exit', cleanup);

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const WS = await import('../src/brain/working-state.js');

function makeDomain(slug) {
  mkdirSync(join(DOMAINS, slug, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(DOMAINS, slug, 'CLAUDE.md'), '# ' + slug + '\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'log.md'), '# Log\n');
}
makeDomain('proj');

// ═════════════════════════════════════════════════════════════════════════
section('§1 — classifySaveNotes: "saved" and "saved COMPLETELY" are two facts');
// ═════════════════════════════════════════════════════════════════════════
//
// The whole point of the four verdicts is that no two of them may be
// collapsed. The one that must never be lost is `null` — "there is no journal
// line, so we do not know" — because the alternative reading of an absent
// verdict is "fine", which is the fact-and-absence collapse this module exists
// to refuse.
const { classifySaveNotes, journalFacts } = WS;

eq('no journal line at all is NULL — never "complete"', classifySaveNotes(null), null);
eq('...and a non-array is null for the same reason', classifySaveNotes('nope'), null);
eq('a line with no notes is complete', classifySaveNotes([]), 'complete');
eq('an over-budget omission is TRIMMED',
  classifySaveNotes(['nextSteps: 3 item(s) omitted over the state size budget']), 'trimmed');
eq('a dropped item is TRIMMED',
  classifySaveNotes(['traps: dropped 2 empty/oversized/non-string item(s)']), 'trimmed');
eq('a deliberate replace is its OWN verdict, not a loss and not "complete"',
  classifySaveNotes(['replace: deliberately overwrote a larger handoff (4000 → 200 body bytes)']), 'replaced');
eq('an observation stamped with the save time is NOTED — nothing was lost',
  classifySaveNotes(['observations: 1 item(s) stamped with the save time']), 'noted');
eq('the machine-identity warning is NOTED — it is about the folder, not the content',
  classifySaveNotes([WS.INSTALL_ID_UNAVAILABLE_NOTE]), 'noted');
eq('loss OUTRANKS a replace when a save did both',
  classifySaveNotes(['replace: deliberately overwrote a larger handoff',
    'decisions: 4 item(s) omitted over the state size budget']), 'trimmed');
ok('empty strings do not make an empty note list read as noted',
  classifySaveNotes(['', null, undefined]) === 'complete');

// ═════════════════════════════════════════════════════════════════════════
section('§2 — journalFacts: the harness-sharing rule is ALTERNATION, not a clock');
// ═════════════════════════════════════════════════════════════════════════
//
// A window ("two harnesses saved within N minutes") needs a tuned constant and
// will be wrong on somebody's machine. The structural test needs none: a user
// who MIGRATED between tools produces exactly one transition ever, while two
// tools working the same scope interleave. So the verdict requires two
// distinct harnesses AND at least two transitions, and one transition is
// reported without being escalated.
const line = (at, harness, extra = {}) => ({ at, harness, headline: 'h', ...extra });
const NOW = Date.parse('2026-08-30T12:00:00.000Z');

{
  const migration = journalFacts([
    line('2026-08-01T10:00:00.000Z', 'cursor'),
    line('2026-08-02T10:00:00.000Z', 'cursor'),
    line('2026-08-03T10:00:00.000Z', 'claude-code'),
    line('2026-08-04T10:00:00.000Z', 'claude-code'),
  ], NOW);
  eq('a one-way MIGRATION between tools is not reported as sharing', migration.harnessShared, false);
  eq('...but the single transition is still counted, not hidden', migration.harnessSwitches, 1);
  ok('...and both tools are named', JSON.stringify(migration.harnesses) === '["claude-code","cursor"]',
    JSON.stringify(migration.harnesses));

  const interleaved = journalFacts([
    line('2026-08-30T10:00:00.000Z', 'claude-code'),
    line('2026-08-30T10:20:00.000Z', 'opencode'),
    line('2026-08-30T10:40:00.000Z', 'claude-code'),
  ], NOW);
  eq('two tools INTERLEAVING in one folder IS reported', interleaved.harnessShared, true);
  eq('...with the transition count that made it a verdict', interleaved.harnessSwitches, 2);
  ok('...newest-first, so the tool that wrote last is named first',
    JSON.stringify(interleaved.harnesses) === '["claude-code","opencode"]',
    JSON.stringify(interleaved.harnesses));

  // THE VERDICT'S FIRST CLAUSE IS REDUNDANT, AND THAT IS ON THE RECORD RATHER
  // THAN DISCOVERED LATER: `distinct.length > 1 && switches >= 2` cannot be
  // told apart from `switches >= 2` by any input, because a switch already
  // implies two distinct values among the named entries. A mutation deleting
  // the first clause runs GREEN across every suite. It is kept because it
  // states the rule, and because it is what survives if the transition count
  // is ever loosened — the same call views/memory.js records for
  // refreshScopeList's `!state.scope` guard. Asserted here so the redundancy
  // is a measurement rather than a claim.
  {
    // Driven over generated sequences rather than argued: for every journal
    // this function can be handed, "two distinct harnesses AND two switches"
    // and "two switches" give the same answer.
    const alphabet = [null, 'a', 'b', 'c'];
    let disagreements = 0; let sharedSeen = 0; let cases = 0;
    for (let n = 0; n <= 4; n++) {
      const total = Math.pow(alphabet.length, n);
      for (let k = 0; k < total; k++) {
        let x = k; const seq = [];
        for (let i = 0; i < n; i++) { seq.push(alphabet[x % alphabet.length]); x = Math.floor(x / alphabet.length); }
        const f = journalFacts(seq.map((h, i) => line('2026-08-30T1' + i + ':00:00.000Z', h)), NOW);
        cases++;
        if (f.harnessShared) sharedSeen++;
        if (f.harnessShared !== (f.harnessSwitches >= 2)) disagreements++;
      }
    }
    ok('the verdict\'s first clause is REDUNDANT over every journal this function can receive — '
      + 'recorded because a mutation deleting it runs green', disagreements === 0,
      disagreements + ' disagreements over ' + cases + ' generated journals');
    ok('...and the corpus was not vacuous — it produced real sharing verdicts',
      sharedSeen > 0 && cases > 300, sharedSeen + ' shared of ' + cases);
  }

  const one = journalFacts([line('2026-08-30T10:00:00.000Z', 'claude-code'),
    line('2026-08-30T11:00:00.000Z', 'claude-code')], NOW);
  eq('one tool saving repeatedly is never sharing', one.harnessShared, false);
  eq('...and produces no transitions at all', one.harnessSwitches, 0);
}

// THE BLIND HALF IS COUNTED, NEVER ASSUMED AWAY. A harness that sends no
// `harness` field is invisible to this signal, and an unnamed save must not
// manufacture a transition out of silence by breaking an A…A run.
{
  const withGaps = journalFacts([
    line('2026-08-30T10:00:00.000Z', 'claude-code'),
    line('2026-08-30T10:10:00.000Z', null),
    line('2026-08-30T10:20:00.000Z', 'claude-code'),
  ], NOW);
  eq('an unnamed save does not break an A…A run into two transitions', withGaps.harnessSwitches, 0);
  eq('...and it is counted, so a caller can see how blind the window was',
    withGaps.entriesWithoutHarness, 1);
  eq('...and the scanned window size is reported beside every verdict',
    withGaps.entriesScanned, 3);
  const allBlind = journalFacts([line('2026-08-30T10:00:00.000Z', null),
    line('2026-08-30T10:10:00.000Z', null)], NOW);
  eq('a journal where NOTHING names a harness reports no sharing', allBlind.harnessShared, false);
  eq('...and says so by counting every entry as blind', allBlind.entriesWithoutHarness, 2);
}

// The true clock, and the shapes that must not become a number.
{
  const f = journalFacts([line('2026-08-30T11:00:00.000Z', 'claude-code')], NOW);
  eq('writtenAt is the journal line\'s own stamp', f.writtenAt, '2026-08-30T11:00:00.000Z');
  eq('...and the age is derived from it', f.writtenAgeSeconds, 3600);
  const bad = journalFacts([line('not a date', 'x')], NOW);
  eq('an unusable `at` is NULL, never 0 and never "now"', bad.writtenAt, null);
  eq('...and so is its age', bad.writtenAgeSeconds, null);
  const future = journalFacts([line('2026-08-30T13:00:00.000Z', 'x')], NOW);
  eq('a save stamped in the future (a skewed clock arriving over sync) clamps to 0, not negative',
    future.writtenAgeSeconds, 0);
  const none = journalFacts([], NOW);
  eq('no entries: the verdict is null and nothing is invented', none.lastSaveKind, null);
  eq('...and no harness is claimed', none.harness, null);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — REPRODUCING DEFECT 1: two full handoffs, neither refused');
// ═════════════════════════════════════════════════════════════════════════
//
// The premise the fix rests on, executed rather than quoted: the existing
// destructive-save guard does NOT cover this case. Both saves are substantial,
// so `would-replace-larger-state` never fires and the second silently wins.
const bigBody = (who) => ({
  nowState: 'A real session of work by ' + who + '. '.repeat(20),
  nextSteps: ['Ship the ' + who + ' change.', 'Re-run the suite.'],
  decisions: ['Do not re-litigate the ' + who + ' approach.'],
});

const a1 = await WS.saveWorkingState('proj', {
  scope: 'main', headline: 'claude-code did some work', harness: 'claude-code',
  model: 'opus-5', ...bigBody('claude-code'),
});
const b1 = await WS.saveWorkingState('proj', {
  scope: 'main', headline: 'opencode did other work', harness: 'opencode',
  model: 'gpt-5', ...bigBody('opencode'),
});
const a2 = await WS.saveWorkingState('proj', {
  scope: 'main', headline: 'claude-code came back', harness: 'claude-code',
  model: 'opus-5', ...bigBody('claude-code-again'),
});

ok('all three saves succeeded — the existing guard refuses none of them',
  a1.ok === true && b1.ok === true && a2.ok === true,
  JSON.stringify([a1.reason, b1.reason, a2.reason]));
ok('...and all three landed in ONE folder, which is the collision',
  a1.path === b1.path && b1.path === a2.path, a1.path + ' / ' + b1.path + ' / ' + a2.path);

{
  const cur = readFileSync(join(DOMAINS, 'proj', a1.path.replace(/^state\//, 'state/')), 'utf8');
  ok('the surviving current.md holds ONLY the last writer\'s work',
    cur.includes('claude-code-again') && !cur.includes('by opencode'), cur.slice(0, 200));
}

{
  const idx = await WS.listWorkingScopes('proj');
  const row = idx.scopes.find((s) => s.scope === 'main');
  eq('the index reports the collision from the journal that survived it', row.harnessShared, true);
  ok('...naming both tools', JSON.stringify(row.harnesses) === '["claude-code","opencode"]',
    JSON.stringify(row.harnesses));
  eq('...and the newest save\'s harness is the one that wrote what is on disk',
    row.harness, 'claude-code');
  ok('the scanned-window size rides along, so a cap can never read as a census',
    typeof row.journalEntriesScanned === 'number' && row.journalEntriesScanned === 3,
    String(row.journalEntriesScanned));
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — REPRODUCING DEFECT 2: mtime moves, the agent\'s clock does not');
// ═════════════════════════════════════════════════════════════════════════
//
// A checkout rewrites a file's timestamps to the moment it wrote them. That is
// reproduced here directly with `utimes` — the same observable effect on the
// same two fields — so the store's behaviour is proven without this suite
// needing a git binary or a network. Real git is proven in
// scripts/test-working-state-sync.js.
await WS.saveWorkingState('proj', {
  scope: 'pulled', headline: 'written long before it arrived', harness: 'claude-code',
  nowState: 'This was authored on another computer.',
});

const pulledDir = (() => {
  const base = join(DOMAINS, 'proj', 'state', 'pulled');
  const m = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory())[0].name;
  return join(base, m);
})();

// Backdate the JOURNAL LINE to a year ago, then leave both files' mtimes at
// now — exactly the shape a pull produces: old content, brand-new mtime.
{
  const jp = join(pulledDir, 'journal.jsonl');
  const lines = readFileSync(jp, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  rec.at = '2025-08-30T09:00:00.000Z';
  writeFileSync(jp, lines.slice(0, -1).concat(JSON.stringify(rec)).join('\n') + '\n');
  const now = new Date();
  utimesSync(join(pulledDir, 'current.md'), now, now);
  utimesSync(jp, now, now);
}

{
  const idx = await WS.listWorkingScopes('proj');
  const row = idx.scopes.find((s) => s.scope === 'pulled');
  ok('BEFORE THE FIX THIS ROW READ AS BRAND NEW: mtime really is seconds old',
    row.ageSeconds < 120, String(row.ageSeconds));
  ok('...and the agent\'s clock says it is a year old',
    row.writtenAgeSeconds > 300 * 24 * 3600, String(row.writtenAgeSeconds));
  eq('...carried as the journal\'s own stamp', row.writtenAt, '2025-08-30T09:00:00.000Z');
  ok('BOTH facts survive — neither replaces the other, because "when did it arrive" is real too',
    typeof row.lastWriteAt === 'string' && typeof row.writtenAt === 'string');
}

{
  const read = await WS.readWorkingState('proj', { scope: 'pulled' });
  ok('the scoped read carries the agent\'s clock on `current`',
    read.current.writtenAt === '2025-08-30T09:00:00.000Z', String(read.current.writtenAt));
  ok('...beside the filesystem time under a name that says what it is',
    read.current.arrivedAt === read.current.savedAt && typeof read.current.arrivedAt === 'string');
  ok('...and the SHIPPED name is untouched, so no pinned consumer changes meaning',
    read.current.savedAt !== read.current.writtenAt);
  ok('the machine list carries it too — the picker\'s whole job is which computer, and when',
    read.machines.length === 1 && read.machines[0].writtenAt === '2025-08-30T09:00:00.000Z',
    JSON.stringify(read.machines));
}

// A FOLDER WITH NO USABLE JOURNAL TIME MUST DEGRADE TO NULL, NOT TO A GUESS.
{
  mkdirSync(join(DOMAINS, 'proj', 'state', 'nojournal', 'boxq'), { recursive: true });
  writeFileSync(join(DOMAINS, 'proj', 'state', 'nojournal', 'boxq', 'current.md'),
    '# Working state — nojournal\n\n## Where things stand\n\nHand-written, no journal.\n');
  const idx = await WS.listWorkingScopes('proj');
  const row = idx.scopes.find((s) => s.scope === 'nojournal');
  eq('no journal at all: writtenAt is NULL, never the file\'s time in disguise', row.writtenAt, null);
  eq('...and the completeness verdict is null too, because we did not see a save',
    row.lastSaveKind, null);
  ok('...while the filesystem time is still reported, so the row is not blank',
    typeof row.lastWriteAt === 'string');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — THE ROUTE forwards both clocks, and stays cheap');
// ═════════════════════════════════════════════════════════════════════════
const routerMod = await import('../src/routes/memory.js');
function routesOf(r) {
  return (r.stack || []).filter((l) => l.route).map((l) => ({
    path: l.route.path,
    methods: Object.keys(l.route.methods || {}).filter((m) => l.route.methods[m]),
    handle: l.route.stack[l.route.stack.length - 1].handle,
  }));
}
const ROUTES = routesOf(routerMod.default);
async function call(path, { params = {}, query = {} } = {}) {
  const route = ROUTES.find((x) => x.path === path);
  if (!route) throw new Error('route not found: ' + path);
  let status = 200; let body; let settled = false;
  const res = { status(c) { status = c; return res; }, json(b) { body = b; settled = true; return res; } };
  await route.handle({ params, query }, res, (e) => { throw e || new Error('next() called'); });
  if (!settled) await new Promise((r) => setImmediate(r));
  return { status, body };
}

// A project whose newest pair is an ordinary save, so the row's fields are
// deterministic. `proj`'s newest pair is the hand-made journal-less folder
// from §4, which is asserted separately below precisely because it is the
// shape where a row must report NULLS rather than invent values.
makeDomain('fresh');
await WS.saveWorkingState('fresh', {
  scope: 'main', headline: 'one ordinary save', harness: 'claude-code', model: 'opus-5',
  nowState: 'Nothing unusual here.',
});

{
  const { body } = await call('/');
  const f = body.projects.find((x) => x.project === 'fresh');
  ok('the index row carries the agent\'s clock', typeof f.writtenAt === 'string', JSON.stringify(f.writtenAt));
  ok('...and the filesystem clock beside it', typeof f.lastWriteAt === 'string');
  ok('...and which tool wrote the newest save', f.harness === 'claude-code', String(f.harness));
  ok('...and whether that save was complete', f.lastSaveKind === 'complete', String(f.lastSaveKind));
  ok('a project with no collision says so rather than staying silent', f.harnessShared === false);

  // THE SAME ROW SHAPE OVER A PAIR WITH NO JOURNAL: nulls, never a guess.
  const p0 = body.projects.find((x) => x.project === 'proj');
  ok('a newest pair with no journal reports a NULL agent clock rather than mtime in disguise',
    p0.writtenAt === null && p0.harness === null && p0.lastSaveKind === null,
    JSON.stringify([p0.writtenAt, p0.harness, p0.lastSaveKind]));
  ok('...while still reporting the filesystem time, so the row is not blank',
    typeof p0.lastWriteAt === 'string');

  const p = p0;
  eq('the collision reaches the index route', p.harnessShared, true);
  ok('...naming the scope it is happening in, not just a boolean',
    p.harnessSharedScopes.length === 1 && p.harnessSharedScopes[0].scope === 'main',
    JSON.stringify(p.harnessSharedScopes));
  ok('...and saying how many pairs were actually scanned, so the cap cannot read as a census',
    p.harnessScanned === body.projects.find((x) => x.project === 'proj').savedCopies,
    p.harnessScanned + ' scanned of ' + p.savedCopies + ' pairs');
}

// COUNTS BEFORE THE SLICE. The recorded defect is deriving a work-stream count
// from a capped array, which reports a CAP as a measurement. The new fields
// must not reintroduce it: `harnessScanned` is honest about being the scanned
// set, and `distinctScopeCount` is still the uncapped one.
{
  const { body } = await call('/');
  const p = body.projects.find((x) => x.project === 'proj');
  eq('distinctScopeCount still counts work-streams over the UNCAPPED list', p.distinctScopeCount, 3);
  eq('...and scopeCount agrees with it on this route', p.scopeCount, 3);
  eq('...while savedCopies counts (scope, machine) pairs', p.savedCopies, 3);
}

// The route must not have become expensive: this is what the navbar badge
// polls. Driven rather than argued — the whole index is answered from disk in
// a bounded time, with no provider module loaded at all.
{
  const t0 = Date.now();
  await call('/');
  const ms = Date.now() - t0;
  ok('GET /api/memory answers the whole index in well under a second', ms < 900, ms + 'ms');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — THE VIEW: effectiveSave and the five freshness steps');
// ═════════════════════════════════════════════════════════════════════════
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start); let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out;
}

const viewSrc = readFileSync(join(NEXT, 'views/memory.js'), 'utf8');
const viewCss = readFileSync(join(NEXT, 'views/memory.css'), 'utf8');
const { renderDescription, renderStatus, renderReadout, renderExplainer } =
  await import('../src/public/next/shared/text.js');
const escapeHtml = new Function(extractFunction(
  readFileSync(join(NEXT, 'app.js'), 'utf8'), 'escapeHtml', 'app.js') + '\nreturn escapeHtml;')();

// `freshnessStep` MOVED to shared/age.js when the freshness scale became
// app-wide, so it is lifted from THERE. Left in this list pointing at
// memory.js, extractFunction would have thrown `"freshnessStep" not found in
// memory.js` and taken the whole suite down — and a one-line
// `export { freshnessStep } from '../shared/age.js'` in memory.js would have
// thrown the same way, because this extractor matches on a `function <name>(`
// declaration and a re-export is not one. Re-pointing the lift is the only
// option that keeps this suite executing the REAL shipped function rather
// than a copy of it.
// v3.55.0: renderSaveStatus grew the "Working on" headline (which reads
// `freshnessStep` and `state.projects`) and the tray's newer-elsewhere reading
// (`newerOnAnotherMachine`), so both travel with it. A lift list that is short
// by one collaborator is a ReferenceError, not a failing assertion.
const LIFT_VIEW = ['formatAge', 'effectiveSave', 'newestPair', 'harnessOf',
  'newerOnAnotherMachine',
  // `saveLine` IS GONE (v3.65.0): every qualification under the save reading
  // is a `renderMonitor` LINE or `loud` entry now, so the collaborator this
  // list has to carry is the COMPONENT rather than a local sentence builder.
  // `freshnessTier` joins it for the same reason — the pip was deleted for the
  // app-wide `.fresh-dot`, which is cut on the tier rather than on the step.
  'firstNote'];
// PHASE 2 (2026-11-27): renderSaveStatus went with the five-step page; the
// Now tab's verdicts are views/projects/model.js nowNotices (§7 below
// drives it, and test-save-kind.js §6 pins the clipped/trimmed words).
const LIFT_AGE = ['freshnessStep'];
const LIFT = [...LIFT_VIEW, ...LIFT_AGE];
const ageSrc = readFileSync(join(NEXT, 'shared/age.js'), 'utf8');
function lifted(stateObj) {
  const body = LIFT_VIEW.map((n) => extractFunction(viewSrc, n, 'memory.js'))
    .concat(LIFT_AGE.map((n) => extractFunction(ageSrc, n, 'shared/age.js')))
    .join('\n') +
    '\nreturn { ' + LIFT.join(', ') + ' };';
  return new Function('state', 'escapeHtml', 'icon', 'renderReadout', 'renderMonitor',
    'freshnessTier', body)(
    stateObj, escapeHtml, (n) => '<svg data-icon="' + n + '"></svg>', renderReadout,
    renderMonitor, freshnessTier);
}
const V = lifted({});

// effectiveSave — WHICH CLOCK, said out loud.
{
  const now = Date.parse('2026-08-30T12:00:00.000Z');
  const agent = V.effectiveSave({ writtenAt: '2026-08-30T11:00:00.000Z', savedAt: '2026-08-30T11:59:00.000Z' }, now);
  eq('the agent\'s clock wins when it is there', agent.source, 'agent');
  eq('...and it is the one measured', agent.seconds, 3600);
  const fs = V.effectiveSave({ savedAt: '2026-08-30T11:00:00.000Z' }, now);
  eq('with no journal time it falls back to the file\'s', fs.source, 'filesystem');
  eq('...and SAYS it fell back, rather than presenting one clock as the other', fs.seconds, 3600);
  const none = V.effectiveSave({}, now);
  eq('nothing at all is null, never 0', none.seconds, null);
  eq('...and the source is null too, so "unknown" cannot masquerade as "file time"', none.source, null);
  eq('a null row does not throw', V.effectiveSave(null, now).seconds, null);
  const idx = V.effectiveSave({ writtenAgeSeconds: 42, ageSeconds: 1 }, now);
  eq('an index row\'s precomputed agent age is used as-is', idx.seconds, 42);
}

// freshnessStep — five steps, cut on formatAge's own bands so the mark and the
// word can never contradict each other.
{
  const cases = [[0, 4], [59, 4], [60, 3], [3599, 3], [3600, 2], [86399, 2],
    [86400, 1], [604799, 1], [604800, 0], [99999999, 0]];
  let allGood = true;
  for (const [secs, step] of cases) if (V.freshnessStep(secs) !== step) allGood = false;
  ok('the five steps land exactly on formatAge\'s unit boundaries', allGood,
    JSON.stringify(cases.map(([s]) => [s, V.freshnessStep(s)])));
  eq('an UNKNOWN age is null, not step 0 — "we do not know" is not "long ago"',
    V.freshnessStep(null), null);
  eq('...and neither is a negative one', V.freshnessStep(-5), null);

  // THE BOUNDARY THAT WAS ASKED FOR, pinned by name: "5 minutes ago" and
  // "4 hours ago" have to be distinguishable without reading.
  ok('5 minutes and 4 hours are DIFFERENT steps',
    V.freshnessStep(300) !== V.freshnessStep(4 * 3600),
    V.freshnessStep(300) + ' vs ' + V.freshnessStep(4 * 3600));
}

// ── THE PIP IS DELETED, AND THE DOT IS WHAT IS LEFT (v3.65.0, R13) ───────
//
// This block used to require a CSS rule per step — a step with no class is an
// invisible pip — plus that the ink came from the app-wide `--fresh-*` family
// rather than from brand violet. Both were the right guards while TWO marks
// existed for ONE quantity: `.mem-save-pip` on this reading, `.fresh-dot` on
// the rail's rows, the work-stream table, the overview strip and step ③, on
// the same page.
//
// There is one mark now. `freshnessStep` survives — the five steps above are
// still the boundaries `formatAge` cuts on, and the tray reads them — but
// nothing in this view paints them. So what is asserted is the deletion,
// in both directions: no pip rule and no `.fresh-` rule in this view's
// stylesheet, and the reading really does wear the SHARED dot, cut on
// `freshnessTier`, which is the function the rest of the page uses.
{
  const pipCss = viewCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const survivors = [0, 1, 2, 3, 4].filter((n) => pipCss.includes('.mem-save-pip-s' + n));
  ok('not one of the five pip rules survives — one quantity, one mark',
    survivors.length === 0, JSON.stringify(survivors));
  ok('...nor the unknown state\'s', !pipCss.includes('.mem-save-pip-unknown'));
  ok('...and this view declares no `.fresh-` rule either, so the ladder is '
    + 'reached by deletion rather than re-declared under another name',
    !/\.fresh-[a-z]+\s*\{/.test(pipCss));
  ok('CONTROL — the stripped copy still holds this view\'s own rules, so the '
    + 'three assertions above are not green over an empty string',
    /\.mem-fold-summary[^{]*\{/.test(pipCss) && pipCss.length > 2000);
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — "SAVED" MAY NEVER BE SAID OVER AN INCOMPLETE SAVE');
// ═════════════════════════════════════════════════════════════════════════
//
// PHASE 2 (2026-11-27): the five-step page's renderSaveStatus and its strip
// (§8, §8b here before) went with that page. The claim moves with the fact:
// the Now tab's verdicts are views/projects/model.js nowNotices — the REAL
// code, imported — and the rule is the same: a trimmed save is loud and
// quotes the store's note; a replace is stated but never called a loss; a
// complete or noted save says nothing; nothing ever claims "you are saved".
{
  const MODEL = await import('../src/public/next/views/projects/model.js');
  const say = (o) => MODEL.nowNotices(o).map((n) => n.tone + ': ' + n.title + ' ' + (n.line || '')).join(' | ');
  const clean = say({ lastSaveKind: 'complete' });
  eq('a healthy save paints NOTHING here', clean, '');
  const trimmed = say({ lastSaveKind: 'trimmed', lastSaveNote: 'nextSteps: 3 item(s) omitted over the state size budget' });
  ok('a TRIMMED save is an ERROR notice (role=alert, never folded)', /^error: /.test(trimmed), trimmed);
  ok('...and the store\'s own note is quoted rather than paraphrased', trimmed.includes('nextSteps: 3 item(s) omitted over the state size budget'), trimmed);
  const replaced = say({ lastSaveKind: 'replaced', lastSaveNote: 'replace: deliberately overwrote a larger handoff' });
  ok('a deliberate REPLACE is stated but NOT called a loss, and not in the error tone',
    /replaced a larger handoff/.test(replaced) && /^info: /.test(replaced) && !/did not survive/.test(replaced), replaced);
  eq('a NOTED save says nothing extra — re-warning on every normalisation is the defect this replaces', say({ lastSaveKind: 'noted' }), '');
  const page = readFileSync(join(NEXT, 'views/projects/model.js'), 'utf8') + readFileSync(join(NEXT, 'views/projects/page.js'), 'utf8');
  ok('nothing on the page claims you ARE saved — it cannot know whether anything changed since',
    !/\bYou are saved\b/i.test(page) && !/\bAll saved\b/i.test(page));
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 —The store\'s own vocabulary, and nothing wrote outside the tempdir');
// ═════════════════════════════════════════════════════════════════════════
//
// classifySaveNotes reads TEXT, which is sound only because the store never
// uses a loss word in a note that is not a loss. That invariant is asserted
// over notes the REAL save path produced, not over strings typed here.
{
  const normalised = await WS.saveWorkingState('proj', {
    scope: 'feature/slashes', headline: 'a normalised scope name',
    nowState: 'x', harness: 'claude-code',
    observations: [{ statement: 'the suite was at 148 green', observedAt: 'not a date' }],
  });
  ok('the real save path produced disclosure notes to classify',
    normalised.ok && normalised.notes.length > 0, JSON.stringify(normalised.notes));
  ok('...and NONE of them uses a loss word, because nothing was lost',
    classifySaveNotes(normalised.notes) === 'noted',
    classifySaveNotes(normalised.notes) + ' ' + JSON.stringify(normalised.notes));
  eq('...which the store agrees with: nothing was truncated', normalised.truncated, false);

  // The positive half: a genuinely over-budget save must classify as loss.
  const huge = await WS.saveWorkingState('proj', {
    scope: 'oversize', headline: 'far too much', harness: 'claude-code',
    nowState: 'x'.repeat(4000),
    nextSteps: Array.from({ length: 40 }, (_, i) => 'step ' + i + ' ' + 'y'.repeat(500)),
    decisions: Array.from({ length: 40 }, (_, i) => 'decision ' + i + ' ' + 'z'.repeat(500)),
    traps: Array.from({ length: 40 }, (_, i) => 'trap ' + i + ' ' + 'w'.repeat(500)),
  });
  ok('an over-budget save really was trimmed by the store', huge.ok && huge.truncated === true,
    JSON.stringify([huge.ok, huge.truncated, huge.notes]));
  eq('...and its notes classify as TRIMMED, not as a normalisation',
    classifySaveNotes(huge.notes), 'trimmed');

  // ...and it reaches the surface through the index, which is the whole point.
  const idx = await WS.listWorkingScopes('proj');
  const row = idx.scopes.find((s) => s.scope === 'oversize');
  eq('the index row carries the trim verdict', row.lastSaveKind, 'trimmed');
  ok('...with the store\'s own note, so the surface never has to paraphrase',
    row.lastSaveNotes.some((n) => /omitted over the state size budget/.test(n)),
    JSON.stringify(row.lastSaveNotes));
}

// ═════════════════════════════════════════════════════════════════════════
section('§G6 — "newest" is chosen on the AGENT\'s clock, not on mtime (v3.74.0)');
// ═════════════════════════════════════════════════════════════════════════
//
// Audit G6: `scope: "latest"`, the machine a scope-only read opens, a project
// row's newest save and the project list's order were all chosen by
// `current.md`'s mtime. A Personal Sync pull writes an OLDER handoff from
// another machine with a brand-new mtime, so it won — `get_project_context`
// with no scope opened it over a newer local save. Each fixture below is the
// shape a pull leaves (old journal `at`, new mtime), written directly so the
// two clocks are set independently; the FIXTURE assertions prove the mtime
// order really is the wrong one, so a pass cannot be an accident of order.
{
  const SELF = WS.machineId();
  const OTHER = 'otherbox-a1b2c3';
  const T = Date.now();
  const MIN = 60000;
  const iso = (ms) => new Date(ms).toISOString();
  function pair(domain, rel, scope, machine, { writtenAgoMs, mtimeAgoMs, headline, harness = 'Claude Code' }) {
    const dir = join(DOMAINS, domain, 'state', ...(rel ? [rel] : []), scope, machine);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'current.md'),
      `# Working state — ${scope}\n\n## Where things stand\n\n${headline} BODY\n`);
    if (writtenAgoMs !== null) {
      writeFileSync(join(dir, 'journal.jsonl'), JSON.stringify({
        at: iso(T - writtenAgoMs), scope, machine, headline, harness, model: 'm', rejections: [],
      }) + '\n');
    }
    const t = new Date(T - mtimeAgoMs);
    utimesSync(join(dir, 'current.md'), t, t);
  }
  const mtimeOf = (domain, rel, scope, machine) => statMtime(join(DOMAINS, domain, 'state', ...(rel ? [rel] : []), scope, machine, 'current.md'));

  // ── 1 · `latest` across scopes, and the machine inside one scope ─────────
  makeDomain('gsix');
  pair('gsix', null, 'claude-code', SELF, { writtenAgoMs: 10 * MIN, mtimeAgoMs: 10 * MIN, headline: 'LOCAL-NEWER' });
  pair('gsix', null, 'antigravity', OTHER, { writtenAgoMs: 120 * MIN, mtimeAgoMs: 5000, headline: 'PULLED-OLDER', harness: 'Antigravity' });
  pair('gsix', null, 'main', SELF, { writtenAgoMs: 20 * MIN, mtimeAgoMs: 20 * MIN, headline: 'LOCAL-MAIN' });
  pair('gsix', null, 'main', OTHER, { writtenAgoMs: 180 * MIN, mtimeAgoMs: 4000, headline: 'PULLED-MAIN' });
  ok('FIXTURE: the pulled, OLDER handoff has the NEWER file mtime — what a checkout leaves',
    mtimeOf('gsix', null, 'antigravity', OTHER) > mtimeOf('gsix', null, 'claude-code', SELF));

  const idx = await WS.listWorkingScopes('gsix');
  eq('the index lists the agent-newest pair first, not the freshest file',
    `${idx.scopes[0].scope}/${idx.scopes[0].machine}`, `claude-code/${SELF}`);
  ok('…and the pulled pair, newest by mtime, is ranked by its agent time (last)',
    idx.scopes[idx.scopes.length - 1].headline === 'PULLED-MAIN', JSON.stringify(idx.scopes.map((x) => x.headline)));
  ok('…with no internal sort key leaked', idx.scopes.every((x) => !('mtimeMs' in x)));

  const latest = await WS.readWorkingState('gsix', { scope: 'latest' });
  eq('scope "latest" opens the agent-newest work-stream (the G6 probe)', latest.scope, 'claude-code');
  eq('…says it chose it', latest.scopeResolvedBy, 'latest');
  ok('…and returns ITS handoff, not the pulled one', /LOCAL-NEWER BODY/.test(latest.current.text), latest.current.text);

  const main = await WS.readWorkingState('gsix', { scope: 'main' });
  eq('a scope-only read opens the agent-newest MACHINE, not the one a pull just wrote', main.machine, SELF);
  ok('…with that machine\'s handoff', /LOCAL-MAIN BODY/.test(main.current.text));
  eq('…and the machine list is in the same order', main.machines.map((m) => m.machine).join(','), `${SELF},${OTHER}`);
  ok('…with no internal sort key leaked', main.machines.every((m) => !('mtimeMs' in m)));
  const pinned = await WS.readWorkingState('gsix', { scope: 'main', machine: OTHER });
  ok('the pulled machine is still openable by name', /PULLED-MAIN BODY/.test(pinned.current.text));

  const projRow = (await WS.listProjects('gsix')).projects.find((r) => r.project === 'gsix');
  eq('the project row speaks for the agent-newest save', projRow && projRow.newestScope, 'claude-code');
  eq('…with its headline', projRow && projRow.headline, 'LOCAL-NEWER');
  eq('…and its writtenAt', projRow && projRow.writtenAt, iso(T - 10 * MIN));

  // ── 2 · the fallback: a pair with no journal time competes on its file time
  makeDomain('gsixb');
  pair('gsixb', null, 'journaled', SELF, { writtenAgoMs: 10 * MIN, mtimeAgoMs: 10 * MIN, headline: 'J' });
  pair('gsixb', null, 'nojournal', SELF, { writtenAgoMs: null, mtimeAgoMs: 5 * MIN, headline: 'N' });
  pair('gsixb', null, 'pulled', OTHER, { writtenAgoMs: 300 * MIN, mtimeAgoMs: 1000, headline: 'P' });
  const b = await WS.readWorkingState('gsixb', { scope: 'latest' });
  eq('a pair with NO journal still wins on its file time when that is the newest reading (the fallback is load-bearing)',
    b.scope, 'nojournal');
  eq('…and the listing agrees', (await WS.listWorkingScopes('gsixb')).scopes.map((x) => x.scope).join(','),
    'nojournal,journaled,pulled');

  // ── 3 · when the clocks AGREE, the order is exactly the old mtime order ──
  makeDomain('gsixc');
  pair('gsixc', null, 'older', SELF, { writtenAgoMs: 30 * MIN, mtimeAgoMs: 30 * MIN, headline: 'O' });
  pair('gsixc', null, 'newer', SELF, { writtenAgoMs: 20 * MIN, mtimeAgoMs: 20 * MIN, headline: 'N' });
  pair('gsixc', null, 'tie-a', SELF, { writtenAgoMs: 40 * MIN, mtimeAgoMs: 41 * MIN, headline: 'TA' });
  pair('gsixc', null, 'tie-b', SELF, { writtenAgoMs: 40 * MIN, mtimeAgoMs: 40 * MIN, headline: 'TB' });
  eq('clocks that agree keep the mtime order; an exact agent-time TIE falls to mtime',
    (await WS.listWorkingScopes('gsixc')).scopes.map((x) => x.scope).join(','), 'newer,older,tie-b,tie-a');

  // ── 4 · the PROJECT LIST's order ─────────────────────────────────────────
  makeDomain('gsixd');
  ok('fixture: two named projects', (await WS.createProject('gsixd', 'fresh')).ok && (await WS.createProject('gsixd', 'stale')).ok);
  pair('gsixd', 'fresh', 'main', SELF, { writtenAgoMs: 10 * MIN, mtimeAgoMs: 10 * MIN, headline: 'FRESH' });
  pair('gsixd', 'stale', 'main', OTHER, { writtenAgoMs: 600 * MIN, mtimeAgoMs: 1000, headline: 'STALE' });
  const listed = (await WS.listProjects('gsixd')).projects.map((r) => r.project).filter((x) => x !== 'gsixd');
  eq('the project list puts the project saved most recently BY THE AGENT first, not the one a pull touched',
    listed.join(','), 'fresh,stale');
  const all = (await WS.listAllProjects()).projects.filter((r) => r.domain === 'gsixd').map((r) => r.project);
  eq('…and so does the all-domains list', all.slice(0, 2).join(','), 'fresh,stale');
}

// Nothing escaped the tempdir: every path this suite touched is under it, and
// the only writes are the ones it made itself.
{
  function walk(d, out = []) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
  }
  const files = walk(TMP);
  ok('every file this suite produced is inside its own tempdir',
    files.every((f) => f.startsWith(TMP + '/')), String(files.length));
  ok('...and it produced a real tree rather than nothing (non-vacuity)',
    files.length > 8, String(files.length));
}

// ── Done ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ All memory-truth assertions green');
else console.log('❌ ' + failed + ' memory-truth assertion(s) failed');
cleanup();
process.exit(failed === 0 ? 0 : 1);
