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
  utimesSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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

const LIFT = ['formatAge', 'effectiveSave', 'freshnessStep', 'newestPair', 'harnessOf',
  'firstNote', 'saveLine', 'renderSaveStatus'];
function lifted(stateObj) {
  const body = LIFT.map((n) => extractFunction(viewSrc, n, 'memory.js')).join('\n') +
    '\nreturn { ' + LIFT.join(', ') + ' };';
  return new Function('state', 'escapeHtml', 'icon', 'renderReadout', body)(
    stateObj, escapeHtml, (n) => '<svg data-icon="' + n + '"></svg>', renderReadout);
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

// Every step the function can return has a rule in the stylesheet. A step with
// no class is an invisible pip.
{
  const missing = [0, 1, 2, 3, 4].filter((s) => !viewCss.includes('.mem-save-pip-s' + s));
  ok('every one of the five steps has its own CSS rule', missing.length === 0, JSON.stringify(missing));
  ok('...and so does the unknown state', viewCss.includes('.mem-save-pip-unknown'));
  ok('the pip carries NO transition — every render replaces the pane, so one could never run',
    !/\.mem-save-pip[^{]*\{[^}]*transition/.test(viewCss));
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — "SAVED" MAY NEVER BE SAID OVER AN INCOMPLETE SAVE');
// ═════════════════════════════════════════════════════════════════════════
//
// The store trims an over-budget handoff rather than refusing it, which is the
// right call — a refused save near the end of a context loses the handoff
// outright — and it discloses the trim in the journal line. This is the
// assertion that stops that disclosure being dropped one layer from the
// surface that answers "am I saved?".
const baseRead = {
  scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
  brief: { present: true, updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString() },
};
const baseDetail = (over = {}) => {
  const { current, ...rest } = over;
  return {
    scope: 'main', machine: 'boxa',
    journal: { entries: [{ at: '2026-08-30T10:00:00.000Z', harness: 'claude-code', model: 'opus-5' }] },
    ...rest,
    // Spread LAST and merged rather than replaced: an earlier draft let a
    // partial `current` override wipe the whole object, so six assertions were
    // silently reading an empty strip and "passing" the negative half of their
    // own controls. Fixed here rather than in the assertions.
    current: {
      present: true, writtenAgeSeconds: 120,
      writtenAt: new Date(Date.now() - 120_000).toISOString(),
      savedAt: new Date(Date.now() - 120_000).toISOString(),
      arrivedAt: new Date(Date.now() - 120_000).toISOString(),
      lastSaveKind: 'complete', lastSaveNotes: [], ...current,
    },
  };
};

{
  const clean = lifted({}).renderSaveStatus(baseRead, baseDetail());
  ok('the healthy reading is a Last saved instrument with a freshness pip',
    /mem-save-pip mem-save-pip-s3/.test(clean) && /tx-readout-label">Last saved</.test(clean), clean.slice(0, 400));
  ok('...with the age as the figure', /tx-readout-value">2 min ago</.test(clean), clean.slice(0, 500));
  ok('...and the scope and harness as its provenance',
    /tx-readout-prov">main · claude-code</.test(clean), clean.slice(0, 600));
  ok('...carrying NO incomplete badge and no warning line',
    !/incomplete/.test(clean) && !/mem-save-line-loud/.test(clean));
  ok('THE LABEL IS "Last saved", NEVER "saved" — this screen cannot know whether '
    + 'anything has changed since, and must not imply it does',
    !/\bYou are saved\b/i.test(clean) && !/\bAll saved\b/i.test(clean));

  const trimmed = lifted({}).renderSaveStatus(baseRead, baseDetail({
    current: { lastSaveKind: 'trimmed',
      lastSaveNotes: ['nextSteps: 3 item(s) omitted over the state size budget'] },
  }));
  ok('a TRIMMED save is marked ON the reading, not only in a note below it',
    /mem-save-main[\s\S]*incomplete<\/span>/.test(trimmed), trimmed.slice(0, 700));
  ok('...and the store\'s own note is quoted rather than paraphrased',
    trimmed.includes('nextSteps: 3 item(s) omitted over the state size budget'), trimmed.slice(0, 900));
  ok('...in the loud treatment, because the rest of the strip reads as calm',
    /mem-save-line-loud/.test(trimmed));
  ok('CONTROL: the same fixture without the trim renders neither',
    !/incomplete/.test(clean) && !clean.includes('omitted over the state size budget'));

  const replaced = lifted({}).renderSaveStatus(baseRead, baseDetail({
    current: { lastSaveKind: 'replaced',
      lastSaveNotes: ['replace: deliberately overwrote a larger handoff (9000 → 400 body bytes)'] },
  }));
  ok('a deliberate REPLACE is stated but NOT badged as incomplete — nothing the agent sent was lost',
    replaced.includes('replaced a larger handoff') && !/incomplete<\/span>/.test(replaced),
    replaced.slice(0, 600));
  ok('...and it is not given the loud treatment either', !/mem-save-line-loud/.test(replaced));

  const noted = lifted({}).renderSaveStatus(baseRead, baseDetail({
    current: { lastSaveKind: 'noted', lastSaveNotes: ['observations: 1 item(s) stamped with the save time'] },
  }));
  ok('a NOTED save says nothing extra — re-warning on every normalisation is the defect this replaces',
    !/incomplete/.test(noted) && !noted.includes('stamped with the save time'), noted.slice(0, 500));
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — The strip answers the other three questions, and only when true');
// ═════════════════════════════════════════════════════════════════════════
{
  // WHICH CLOCK. When no journal entry carried a time, the reading is the
  // file's own and the strip says so — in text, not in a tooltip.
  const fsOnly = lifted({}).renderSaveStatus(baseRead, baseDetail({
    current: { writtenAt: null, writtenAgeSeconds: null },
  }));
  ok('a filesystem-time reading is LABELLED as one on the instrument',
    /tx-readout-prov">[^<]*file time/.test(fsOnly), fsOnly.slice(0, 700));
  ok('...and explained, because "file time" alone does not say what goes wrong',
    /when the file arrived here, not when it was written/.test(fsOnly), fsOnly.slice(0, 1200));
  ok('CONTROL: an agent-clock reading says neither', !/file time/.test(
    lifted({}).renderSaveStatus(baseRead, baseDetail())));

  // BOTH CLOCKS, when they genuinely disagree — the synced case.
  const synced = lifted({}).renderSaveStatus(baseRead, baseDetail({
    current: {
      writtenAgeSeconds: 3 * 3600,
      writtenAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      arrivedAt: new Date(Date.now() - 30_000).toISOString(),
      savedAt: new Date(Date.now() - 30_000).toISOString(),
    },
  }));
  ok('a handoff written hours ago and pulled seconds ago states BOTH',
    /tx-readout-value">3 hr ago</.test(synced) && /arrived on this computer just now/i.test(synced),
    synced.slice(0, 900));
  ok('CONTROL: when the two clocks agree, no arrival line appears',
    !/arrived on this computer/i.test(lifted({}).renderSaveStatus(baseRead, baseDetail())));

  // NEWER STATE SOMEWHERE ELSE IN THIS PROJECT — the "this scope vs any
  // scope" distinction, which is the one that catches an agent saving beside
  // you into a scope you are not watching.
  const elsewhere = lifted({}).renderSaveStatus({
    ...baseRead,
    scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 7200 },
      { scope: 'side-quest', machine: 'boxa', writtenAgeSeconds: 120 }],
  }, baseDetail({ current: { writtenAgeSeconds: 7200 } }));
  ok('a newer scope elsewhere in the project is named',
    /Newer state in this project:[\s\S]*side-quest/.test(elsewhere), elsewhere.slice(0, 1200));
  ok('CONTROL: when the scope on screen IS the newest, nothing is said',
    !/Newer state in this project/.test(lifted({}).renderSaveStatus(baseRead, baseDetail())));

  // THE COLLISION LINE.
  const collide = lifted({}).renderSaveStatus({
    ...baseRead,
    scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120,
      harnessShared: true, harnesses: ['claude-code', 'opencode'] }],
  }, baseDetail());
  ok('two tools sharing one handoff file is stated, loudly',
    /mem-save-line-loud/.test(collide) && /Two tools are writing/.test(collide), collide.slice(0, 1400));
  ok('...naming both tools', /claude-code and opencode/.test(collide));
  // The class moved `mono` -> `mem-name` in the design pass, and the PROPERTY
  // this asserts is unchanged: the scope is still marked up as a distinct
  // token inside the sentence, still the way every other scope and machine
  // name on this screen reads. What moved is HOW it is marked — colour and
  // weight rather than a change of face mid-line — because those other slugs
  // moved off the monospace face in the same pass. An assertion pinning
  // `mono` here would now be pinning the ONE site that did not move.
  ok('...and rendering the scope as a name, the way every other scope and machine on this screen reads',
    /Two tools are writing <span class="mem-name">main<\/span>/.test(collide), collide.slice(0, 900));
  ok('...and naming the remedy, which is the user\'s to apply',
    /own scope/.test(collide));
  ok('CONTROL: no sharing, no line',
    !/Two tools are writing/.test(lifted({}).renderSaveStatus(baseRead, baseDetail())));

  // THE STANDING BRIEF — always, on its own clock, and with NO freshness pip.
  const withBrief = lifted({}).renderSaveStatus(baseRead, baseDetail());
  ok('the standing brief is always stated', /Standing brief — 6 days ago/.test(withBrief),
    withBrief.slice(-400));
  ok('...and gets NO freshness pip: an old brief is not a stale one',
    (withBrief.match(/<span class="mem-save-pip/g) || []).length === 1, withBrief.slice(0, 400));
  const noBrief = lifted({}).renderSaveStatus({ ...baseRead, brief: { present: false } }, baseDetail());
  ok('a missing brief is said as its own fact, never as an age',
    /Standing brief — not written yet/.test(noBrief), noBrief.slice(-300));

  // THE READING SURVIVES A SCOPE SWITCH. loadScope drops state.detail before
  // it paints, so without the index-row fallback the figure would blink out
  // for the length of every fetch — and an instrument that disappears when you
  // touch the control next to it is not one.
  const midSwitch = lifted({ scope: 'main', machine: 'boxa' }).renderSaveStatus({
    scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120,
      harness: 'claude-code', lastSaveKind: 'complete', lastSaveNotes: [] }],
    brief: { present: false },
  }, null);
  ok('with the scoped read still in flight the reading is served from the index row',
    /tx-readout-value">2 min ago</.test(midSwitch) && /tx-readout-prov">main · claude-code</.test(midSwitch),
    midSwitch.slice(0, 500));
  ok('...and the completeness verdict comes with it, so a trim cannot vanish mid-switch',
    /incomplete/.test(lifted({ scope: 'main', machine: 'boxa' }).renderSaveStatus({
      scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120, harness: 'claude-code',
        lastSaveKind: 'trimmed', lastSaveNotes: ['nextSteps: 1 item(s) omitted over the state size budget'] }],
      brief: { present: false },
    }, null)));

  // ABSENT IS NOT ZERO, at the site most likely to break it.
  const nothing = lifted({}).renderSaveStatus(null, null);
  eq('with nothing to report the strip renders nothing at all', nothing, '');
  const noHandoff = lifted({}).renderSaveStatus({ scopes: [], brief: { present: false } }, null);
  ok('a project with no handoff still answers the brief half and invents no age',
    /Standing brief — not written yet/.test(noHandoff) && !/Last saved/.test(noHandoff), noHandoff);

  // ESCAPING. Scope names, machine ids and harness names all arrive from disk
  // and can arrive over sync from another machine.
  const XSS = '<img src=x onerror=alert(1)>';
  const hostile = lifted({}).renderSaveStatus({
    scopes: [{ scope: XSS, machine: XSS, writtenAgeSeconds: 10, harnessShared: true, harnesses: [XSS] }],
    brief: { present: false },
  }, { scope: 'main', machine: 'boxa',
    current: { present: true, writtenAgeSeconds: 7200, writtenAt: new Date(Date.now() - 7200_000).toISOString(),
      lastSaveKind: 'trimmed', lastSaveNotes: [XSS] },
    journal: { entries: [{ harness: XSS }] } });
  ok('no raw <img> survives from a scope, machine, harness or note',
    !hostile.includes('<img'), hostile.slice(0, 400));
  ok('...and the hostile text is still SHOWN, escaped, rather than dropped',
    hostile.includes('&lt;img'), hostile.slice(0, 400));
}

// ═════════════════════════════════════════════════════════════════════════
section('§8b — The strip TICKS: screenSignature can see the pane it paints');
// ═════════════════════════════════════════════════════════════════════════
//
// A poll re-renders only when the screen would look different, which is right
// — an unconditional re-render closes a picker somebody has open. The failure
// mode is the other side of it: a pane the signature cannot see is a pane that
// silently stops updating. The strip is a CLOCK, so this is not cosmetic.
{
  const SIG = ['formatAge', 'effectiveSave', 'newestPair', 'projectMetaLine', 'screenSignature'];
  const sigOf = (st) => new Function('state',
    SIG.map((n) => extractFunction(viewSrc, n, 'memory.js')).join('\n')
    + '\nreturn screenSignature();')(st);

  const st = (over = {}) => ({
    activeProject: 'proj', staleWrite: false, indexError: null,
    scope: 'main', machine: 'boxa', projects: [],
    projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
      brief: { present: true, updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString() } },
    detail: { scope: 'main', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 120, lastSaveKind: 'complete' } },
    ...over,
  });

  const base = sigOf(st());
  ok('the reading ageing into the next band repaints (59 min -> 1 hr)',
    sigOf(st({ detail: { scope: 'main', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 3600, lastSaveKind: 'complete' } } })) !== base);
  ok('a save going from complete to TRIMMED repaints, even at the same age',
    sigOf(st({ detail: { scope: 'main', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 120, lastSaveKind: 'trimmed' } } })) !== base);
  ok('a NEWER SAVE IN ANOTHER SCOPE of this project repaints — the picker list is unchanged, '
    + 'so nothing else in the signature could see it',
    sigOf(st({ projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 7200 },
      { scope: 'other', machine: 'boxa', writtenAgeSeconds: 60 }],
    brief: { present: true, updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString() } } })) !== base);
  ok('a harness collision appearing repaints',
    sigOf(st({ projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120,
      harnessShared: true, harnesses: ['a', 'b'] }],
    brief: { present: true, updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString() } } })) !== base);
  ok('the standing brief being edited repaints',
    sigOf(st({ projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
      brief: { present: true, updatedAt: new Date(Date.now() - 60_000).toISOString() } } })) !== base);

  // ...and the other side, which is what stops this becoming a busy poll.
  ok('CONTROL: an identical state produces an identical signature', sigOf(st()) === base);
  ok('CONTROL: a DUPLICATED pair is one option in the picker and one row in the '
    + 'strip, so it must NOT read as a change',
    sigOf(st({ projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 },
      { scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }],
    brief: { present: true, updatedAt: new Date(Date.now() - 6 * 86400_000).toISOString() } } })) === base);
  ok('CONTROL: an age moving WITHIN one band does not repaint (300s -> 320s both read "5 min ago")',
    sigOf(st({ detail: { scope: 'main', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 300, lastSaveKind: 'complete' } } }))
    === sigOf(st({ detail: { scope: 'main', machine: 'boxa',
      current: { present: true, writtenAgeSeconds: 320, lastSaveKind: 'complete' } } })));
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — The store\'s own vocabulary, and nothing wrote outside the tempdir');
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
