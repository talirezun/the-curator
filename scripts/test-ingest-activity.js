/**
 * test-ingest-activity.js — OFFLINE guards for the single-file ingest's
 * server-backed activity record (src/brain/ingest-activity.js) and the
 * read endpoint that exposes it (GET /api/ingest/activity).
 *
 * ── WHAT THIS SUITE IS FOR ──────────────────────────────────────────────
 * The defect: a single-file ingest that ran while the Ingest view was not
 * mounted left NO trace a returning user could see — not its progress while
 * running, and nothing at all once finished. The events were arriving and
 * being dropped by a mount-token gate (this repo's dead-data shape). The fix
 * is that the server remembers. So the properties worth pinning are the ones
 * that make "the server remembers" true and safe:
 *
 *   §2  A record tracks a run start-to-finish, through the ONE event shape
 *       the route actually emits.
 *   §3  A second start CANNOT displace a running record. The route's
 *       per-domain file lock already allows only one at a time; if this
 *       disagreed with the lock, a refused request would clobber the record
 *       belonging to the run that holds it.
 *   §4  A record cannot outlive its request. A stuck `running` record is not
 *       cosmetic — the view treats it as "this domain is busy", so it becomes
 *       a stuck Ingest button until the app restarts.
 *   §5  TTL applies to SETTLED records ONLY. Expiring a live one would
 *       re-create the exact defect being fixed.
 *   §6  The wire shape is an ALLOW-LIST. v3.3.0 shipped a `...rest` spread in
 *       the ingest queue that echoed every unrecognised field and returned a
 *       measured 50,002,001-byte response. Same data class, same posture.
 *   §7  ABSOLUTE PATHS DO NOT LEAVE. `rec.error` and `rec.message` can carry
 *       a raw `fs` error, and a raw `fs` error embeds the user's home
 *       directory and cloud-storage layout.
 *   §8  Truncation is DISCLOSED. A count derived from a silently-shortened
 *       array under-states the user's own ingest.
 *   §9  The store cannot fail an ingest. Hostile input — including a getter
 *       that throws — must be swallowed, not propagated.
 *   §10 The route answers, and answers safely.
 *
 * ── METHOD ──────────────────────────────────────────────────────────────
 * The real module is imported and EXECUTED — no re-implementation, no
 * fixtures standing in for the thing under test. §0 is a positive control
 * that runs FIRST and fails loudly if the module did not import, rather than
 * letting later sections compare `undefined` and pass (the failure shape
 * test-frontend-null-safety.js records for its own lexer desync).
 *
 * The route section mounts the REAL router in a real Express app on an
 * ephemeral port (port 0 — never 3333, which is the maintainer's live app).
 *
 * ── NOT ENFORCED, stated rather than implied away ───────────────────────
 *  - Nothing here proves the ROUTE calls the store. That is a wiring
 *    question about src/routes/ingest.js's POST handler, which needs a real
 *    multipart upload and a real ingest; it is covered by §11's source guards
 *    and, properly, by the end-to-end run recorded in the release notes.
 *  - Time is controlled by reaching into the record via the test seam rather
 *    than by injecting a clock. A clock seam would be production surface
 *    existing only for tests; the seam used here is already marked
 *    __forTests and cannot be reached by the route.
 *  - The store is in-memory by design (see the module header). Nothing here
 *    asserts anything about a restart, because there is nothing to assert.
 */

import http from 'node:http';
import express from 'express';

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label + ` (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// ── §0  POSITIVE CONTROL ────────────────────────────────────────────────
console.log('\n§0  POSITIVE CONTROL — the module under test actually loaded');

let mod = null;
try {
  mod = await import('../src/brain/ingest-activity.js');
} catch (err) {
  console.log('  ✗ FATAL: could not import src/brain/ingest-activity.js — ' + err.message);
  process.exit(1);
}

const {
  startActivity, observeActivity, settleAbandoned, listActivity,
  TERMINAL_TTL_MS, MAX_CHANGES, MAX_PAGES_WRITTEN, MAX_WARNINGS, MAX_TRACKED_DOMAINS,
  __resetActivityForTests, __peekActivityForTests,
} = mod;

for (const [name, fn] of Object.entries({
  startActivity, observeActivity, settleAbandoned, listActivity,
  __resetActivityForTests, __peekActivityForTests,
})) {
  ok(typeof fn === 'function', `${name} is exported and callable`);
}
ok(Number.isFinite(TERMINAL_TTL_MS) && TERMINAL_TTL_MS > 0, 'TERMINAL_TTL_MS is a real positive number');

// A control that must fire: if the store did nothing at all, §2 would still
// pass on a permissive assertion. Prove the empty state is genuinely empty
// first, so "a record appeared" later means something.
__resetActivityForTests();
eq(listActivity().activity.length, 0, 'CONTROL: an empty store lists nothing');

// ── §1  THE EVENT SHAPES ARE THE ROUTE'S OWN ────────────────────────────
// Built once and reused, so every section below drives the store with the
// exact objects src/routes/ingest.js emits — not a convenient approximation.
const EV_PROGRESS = (pct, message) => ({ type: 'progress', pct, message });
const EV_WAIT = (pct, message) => ({ type: 'wait', pct, message });
const EV_DONE = (over) => ({
  type: 'done',
  title: 'A Real Article',
  pagesWritten: ['entities/openai.md', 'concepts/rag.md'],
  changes: [
    { canonPath: 'entities/openai.md', status: 'created', bytesBefore: 0, bytesAfter: 412, sectionsChanged: [], bulletsAdded: 0 },
    { canonPath: 'concepts/rag.md', status: 'updated', bytesBefore: 300, bytesAfter: 512, sectionsChanged: ['Key Facts'], bulletsAdded: 2 },
  ],
  warnings: ['3 of 90 wikilinks do not resolve'],
  truncated: false,
  wasOverwrite: !!over,
  tokenUsage: { provider: 'gemini', model: 'gemini-2.5-flash-lite', calls: 4, inputTokens: 120, outputTokens: 40, cachedReadTokens: 0, cacheWriteTokens: 0 },
});

// ── §2  A RUN, START TO FINISH ──────────────────────────────────────────
console.log('\n§2  A run is tracked start to finish, through the real event shapes');
{
  __resetActivityForTests();
  const id = startActivity('articles', 'report.pdf');
  ok(typeof id === 'string' && id.length > 10, 'startActivity returns an id');

  let wire = listActivity();
  eq(wire.activity.length, 1, 'the run appears immediately, before any progress event');
  eq(wire.activity[0].status, 'running', 'it starts as running');
  eq(wire.activity[0].filename, 'report.pdf', 'the FILE NAME is carried — "is THIS article in?" is the question');
  eq(wire.activity[0].domain, 'articles', 'the domain is carried');
  ok(Number.isFinite(wire.serverNow), 'serverNow is sent so a client can subtract without reasoning about clock skew');

  observeActivity(id, EV_PROGRESS(20, 'AI is analyzing the document…'));
  wire = listActivity();
  eq(wire.activity[0].pct, 20, 'a progress event moves pct');
  eq(wire.activity[0].message, 'AI is analyzing the document…', 'and carries the phase message');
  eq(wire.activity[0].waiting, false, 'a plain progress event is not a wait');

  const phaseAtProgress = __peekActivityForTests('articles').phaseStartedAt;

  observeActivity(id, EV_WAIT(20, 'Rate limited — retrying in 5s'));
  wire = listActivity();
  eq(wire.activity[0].waiting, true, 'a wait event sets waiting');
  eq(wire.activity[0].pct, 20, 'a wait re-sends the SAME pct, so the ring does not advance');
  eq(__peekActivityForTests('articles').phaseStartedAt, phaseAtProgress,
    'a WAIT does not restart the phase clock — v3.0.17 made a stalled phase keep counting on purpose');

  observeActivity(id, EV_DONE(false));
  wire = listActivity();
  eq(wire.activity[0].status, 'done', 'the done event settles the record');
  eq(wire.activity[0].pct, 100, 'and pins pct at 100');
  eq(wire.activity[0].waiting, false, 'and clears waiting');
  ok(Number.isFinite(wire.activity[0].finishedAt), 'finishedAt is stamped');
  eq(wire.activity[0].result.title, 'A Real Article', 'the title survives');
  eq(wire.activity[0].result.changes.length, 2, 'the change records survive');
  eq(wire.activity[0].result.changes[1].bulletsAdded, 2, 'per-change detail survives (bulletsAdded)');
  eq(wire.activity[0].result.changes[1].sectionsChanged[0], 'Key Facts', 'sectionsChanged survives');
  eq(wire.activity[0].result.warnings.length, 1, 'warnings survive — they are most of what the panel says');
  eq(wire.activity[0].result.tokenUsage.model, 'gemini-2.5-flash-lite', 'tokenUsage survives (the cost line)');

  // A LATE event from a settled run must not reopen it. Without this a
  // trailing frame could flip a finished ingest back to "running", which the
  // view reads as "this domain is busy" — a dead Ingest button.
  observeActivity(id, EV_PROGRESS(50, 'zombie'));
  eq(listActivity().activity[0].status, 'done', 'a late event cannot reopen a settled record');
  eq(listActivity().activity[0].pct, 100, 'and cannot move its pct');
}

// ── §3  A RUNNING RECORD CANNOT BE DISPLACED ────────────────────────────
console.log('\n§3  startActivity refuses to displace a RUNNING record');
{
  __resetActivityForTests();
  const first = startActivity('articles', 'first.pdf');
  const second = startActivity('articles', 'second.pdf');
  eq(second, null, 'a second start on a busy domain returns null');
  eq(listActivity().activity.length, 1, 'and creates nothing');
  eq(listActivity().activity[0].filename, 'first.pdf',
    'the LIVE run keeps its record — the route\'s file lock would refuse the second request, and clobbering here would erase the run that holds the lock');

  // A null id must make every later call a harmless no-op, so a caller never
  // has to branch on it.
  observeActivity(second, EV_PROGRESS(90, 'from the refused request'));
  settleAbandoned(second);
  eq(listActivity().activity[0].pct, 0, 'a null id is a no-op for observeActivity');
  eq(listActivity().activity[0].status, 'running', 'a null id is a no-op for settleAbandoned');

  // Once SETTLED, a new run legitimately replaces it — the newer run is what
  // the user is now waiting on.
  observeActivity(first, EV_DONE(false));
  const third = startActivity('articles', 'third.pdf');
  ok(typeof third === 'string', 'a settled record CAN be replaced by a new run');
  eq(listActivity().activity[0].filename, 'third.pdf', 'and the new run is what is reported');

  // Different domains are independent — one lock per domain.
  const other = startActivity('projects', 'other.md');
  ok(typeof other === 'string', 'a different domain is unaffected by a busy one');
  eq(listActivity().activity.length, 2, 'both domains are tracked');
}

// ── §4  A RECORD CANNOT OUTLIVE ITS REQUEST ─────────────────────────────
console.log('\n§4  settleAbandoned closes a record whose request ended without a result');
{
  __resetActivityForTests();
  const id = startActivity('articles', 'orphan.pdf');
  observeActivity(id, EV_PROGRESS(30, 'planning'));
  settleAbandoned(id);
  const rec = listActivity().activity[0];
  eq(rec.status, 'error', 'a still-running record is closed as an error');
  ok(typeof rec.error === 'string' && rec.error.length > 0, 'and says something actionable rather than nothing');
  ok(/re-ingest/i.test(rec.error), 'the message tells the user what to do next');

  // The common case: already settled, so this is a no-op that must not
  // overwrite a real result with a failure.
  __resetActivityForTests();
  const id2 = startActivity('articles', 'fine.pdf');
  observeActivity(id2, EV_DONE(false));
  settleAbandoned(id2);
  eq(listActivity().activity[0].status, 'done', 'settleAbandoned NEVER overwrites a real outcome');
  eq(listActivity().activity[0].result.title, 'A Real Article', 'and leaves the result intact');
}

// ── §5  TTL APPLIES TO SETTLED RECORDS ONLY ─────────────────────────────
console.log('\n§5  TTL expires SETTLED records and never a running one');
{
  __resetActivityForTests();
  const id = startActivity('articles', 'old.pdf');
  observeActivity(id, EV_DONE(false));
  // Age it past the TTL by reaching into the record. Time is moved rather
  // than waited for; a suite that sleeps 30 minutes is not a suite.
  __peekActivityForTests('articles').finishedAt = Date.now() - TERMINAL_TTL_MS - 1000;
  eq(listActivity().activity.length, 0, 'a settled record past its TTL is swept');

  // The one that matters. A RUNNING record has no finishedAt and must survive
  // any age — an ingest is allowed to take a long time, and expiring a live
  // one would re-create the very defect this module fixes.
  __resetActivityForTests();
  const live = startActivity('articles', 'long.pdf');
  const recLive = __peekActivityForTests('articles');
  recLive.startedAt = Date.now() - (TERMINAL_TTL_MS * 10);
  recLive.phaseStartedAt = recLive.startedAt;
  eq(listActivity().activity.length, 1, 'a RUNNING record older than 10x the TTL is NOT swept');
  eq(listActivity().activity[0].status, 'running', 'and is still reported as running');
  observeActivity(live, EV_PROGRESS(40, 'still going'));
  eq(listActivity().activity[0].pct, 40, 'and still accepts events');

  // A settled record INSIDE its TTL stays — that is the whole point.
  __resetActivityForTests();
  const fresh = startActivity('articles', 'fresh.pdf');
  observeActivity(fresh, EV_DONE(false));
  __peekActivityForTests('articles').finishedAt = Date.now() - Math.floor(TERMINAL_TTL_MS / 2);
  eq(listActivity().activity.length, 1, 'a settled record HALF-WAY through its TTL is kept');
}

// ── §6  THE WIRE SHAPE IS AN ALLOW-LIST ─────────────────────────────────
console.log('\n§6  Wire shape is an ALLOW-LIST, not a spread');
{
  __resetActivityForTests();
  const id = startActivity('articles', 'x.pdf');
  observeActivity(id, EV_DONE(false));

  // Plant fields the shape does not name, at both levels. A `...rest` spread
  // echoes them; an allow-list cannot. This is the v3.3.0 defect reproduced
  // as a test rather than described in a comment.
  const raw = __peekActivityForTests('articles');
  raw.stagedPath = '/Users/someone/Library/Caches/tmp/staged-upload.bin';
  raw.internalSecret = 'SHOULD-NEVER-APPEAR';
  raw.result.internalSecret = 'ALSO-SHOULD-NEVER-APPEAR';

  const wire = listActivity().activity[0];
  ok(!Object.hasOwn(wire, 'stagedPath'), 'an unrecognised top-level field does not reach the wire');
  ok(!Object.hasOwn(wire, 'internalSecret'), 'nor does a planted secret');
  ok(!Object.hasOwn(wire.result, 'internalSecret'), 'nor one planted inside result');
  const asJson = JSON.stringify(wire);
  ok(!asJson.includes('SHOULD-NEVER-APPEAR'), 'no planted value survives anywhere in the payload');
  ok(!asJson.includes('staged-upload.bin'), 'nor the staged path');

  // The named fields DO survive — an allow-list that dropped everything would
  // pass every assertion above while being useless.
  ok(asJson.includes('A Real Article'), 'CONTROL: the fields that SHOULD survive still do');
  ok(asJson.includes('entities/openai.md'), 'CONTROL: change paths still survive');
}

// ── §7  ABSOLUTE PATHS DO NOT LEAVE ─────────────────────────────────────
console.log('\n§7  Absolute paths are scrubbed out of every string that reaches HTTP');
{
  // The shapes that actually leak, taken from scrub-paths.js's own measured
  // table: a quoted fs error, a spaced home directory, a cloud-storage layout.
  const LEAKS = [
    `ENOENT: no such file or directory, open '/Users/alice smith/Google Drive/My Drive/wiki/log.md'`,
    `EACCES: permission denied, open '/Users/bob/Dropbox (Personal)/second-brain/domains/articles/raw/x.pdf'`,
  ];
  for (const msg of LEAKS) {
    __resetActivityForTests();
    const id = startActivity('articles', 'x.pdf');
    observeActivity(id, { type: 'error', message: msg });
    const wire = listActivity().activity[0];
    const json = JSON.stringify(wire);
    ok(!json.includes('alice smith') && !json.includes('/Users/'),
      'no home directory survives an error message: ' + msg.slice(0, 40) + '…');
    ok(!json.includes('Google Drive') && !json.includes('Dropbox'),
      'no cloud-storage layout survives it either');
    ok(/log\.md|x\.pdf/.test(wire.error || ''),
      'CONTROL: the BASENAME survives, so the message stays useful');
  }

  // A path in a PROGRESS message leaks the same way an error does.
  __resetActivityForTests();
  const id = startActivity('articles', 'x.pdf');
  observeActivity(id, EV_PROGRESS(10, `Reading '/Users/carol/Documents/private/thing.pdf'`));
  ok(!JSON.stringify(listActivity().activity[0]).includes('/Users/carol'),
    'a progress message is scrubbed too, not just an error');

  // And in a change path, which is the field most likely to be an absolute
  // path if writePage's normalisation ever regressed.
  __resetActivityForTests();
  const id2 = startActivity('articles', 'x.pdf');
  observeActivity(id2, {
    ...EV_DONE(false),
    changes: [{ canonPath: '/Users/dave/second-brain/domains/articles/wiki/entities/a.md', status: 'created', bytesBefore: 0, bytesAfter: 10, sectionsChanged: [], bulletsAdded: 0 }],
    pagesWritten: ['/Users/dave/second-brain/domains/articles/wiki/entities/a.md'],
  });
  // Two DISTINCT fields, checked separately. An earlier draft asserted the
  // same stringified blob twice under two labels — two assertions reporting
  // one measurement, which is a count that overstates its own coverage.
  const r2 = listActivity().activity[0].result;
  ok(!r2.changes[0].canonPath.includes('/Users/dave'), 'an absolute change path is scrubbed');
  ok(r2.changes[0].canonPath.includes('a.md'), 'CONTROL: its basename survives');
  ok(!r2.pagesWritten[0].includes('/Users/dave'), 'an absolute pagesWritten entry is scrubbed');
  ok(r2.pagesWritten[0].includes('a.md'), 'CONTROL: its basename survives too');

  // Length cap: a pathological message must not become the response.
  __resetActivityForTests();
  const id3 = startActivity('articles', 'x.pdf');
  observeActivity(id3, { type: 'error', message: 'E'.repeat(500000) });
  const errLen = (listActivity().activity[0].error || '').length;
  ok(errLen < 5000, `a half-megabyte error message is capped (got ${errLen} chars)`);
}

// ── §8  TRUNCATION IS DISCLOSED ─────────────────────────────────────────
console.log('\n§8  Oversized arrays are capped AND the true total is reported');
{
  __resetActivityForTests();
  const id = startActivity('articles', 'runaway.pdf');
  const many = MAX_CHANGES + 250;   // v3.16.0 measured a real 903-page runaway
  observeActivity(id, {
    ...EV_DONE(false),
    changes: Array.from({ length: many }, (_, i) => ({
      canonPath: `concepts/c${i}.md`, status: 'created', bytesBefore: 0, bytesAfter: 10, sectionsChanged: [], bulletsAdded: 0,
    })),
    pagesWritten: Array.from({ length: MAX_PAGES_WRITTEN + 100 }, (_, i) => `concepts/c${i}.md`),
    warnings: Array.from({ length: MAX_WARNINGS + 50 }, (_, i) => `warning ${i}`),
  });
  const r = listActivity().activity[0].result;
  eq(r.changes.length, MAX_CHANGES, 'the changes array is capped');
  eq(r.changesTotal, many, 'and the TRUE total is reported alongside it');
  ok(r.changesTotal > r.changes.length,
    'so a client rendering counts from the array can SAY it is showing fewer — silently shortening under-states the user\'s own ingest');
  eq(r.pagesWritten.length, MAX_PAGES_WRITTEN, 'pagesWritten is capped');
  eq(r.pagesWrittenTotal, MAX_PAGES_WRITTEN + 100, 'with its true total');
  eq(r.warnings.length, MAX_WARNINGS, 'warnings are capped');
  eq(r.warningsTotal, MAX_WARNINGS + 50, 'with its true total');

  // The normal case must NOT claim truncation — a note that fires when
  // nothing was dropped is a false statement in the reassuring direction's
  // opposite, and teaches people to ignore it.
  __resetActivityForTests();
  const id2 = startActivity('articles', 'normal.pdf');
  observeActivity(id2, EV_DONE(false));
  const r2 = listActivity().activity[0].result;
  eq(r2.changesTotal, r2.changes.length, 'CONTROL: a normal ingest reports total === shown (no truncation claimed)');
}

// ── §9  THE STORE CANNOT FAIL AN INGEST ─────────────────────────────────
console.log('\n§9  Hostile input is swallowed — bookkeeping must never break an ingest');
{
  __resetActivityForTests();

  // Every export, called with everything a caller could get wrong.
  const junk = [null, undefined, 0, '', false, NaN, [], {}, Symbol('x')];
  let threw = null;
  try {
    for (const v of junk) {
      startActivity(v, v);
      observeActivity(v, v);
      settleAbandoned(v);
    }
    listActivity();
  } catch (err) { threw = err; }
  ok(threw === null, 'no export throws on null/undefined/wrong-typed input' + (threw ? ` — threw ${threw.message}` : ''));

  // The sharp case: an object whose property ACCESS throws. A defensive
  // `typeof` check does not save you from this; only a try/catch does.
  __resetActivityForTests();
  const id = startActivity('articles', 'x.pdf');
  const booby = { get type() { throw new Error('boom'); } };
  let threw2 = null;
  try { observeActivity(id, booby); } catch (err) { threw2 = err; }
  ok(threw2 === null, 'observeActivity swallows a getter that throws');
  eq(listActivity().activity[0].status, 'running', 'and leaves the record intact');

  // A booby-trapped VALUE inside an otherwise-fine event.
  let threw3 = null;
  try {
    observeActivity(id, { type: 'progress', pct: 10, get message() { throw new Error('boom2'); } });
  } catch (err) { threw3 = err; }
  ok(threw3 === null, 'observeActivity swallows a throwing field getter');

  // And a poisoned RECORD must not take down the read for every other domain.
  __resetActivityForTests();
  startActivity('good', 'fine.pdf');
  let threw4 = null;
  let out = null;
  try { out = listActivity(); } catch (err) { threw4 = err; }
  ok(threw4 === null, 'listActivity does not throw');
  ok(out && Array.isArray(out.activity), 'and always returns a usable shape');
}

// ── §10  THE MAP IS BOUNDED ─────────────────────────────────────────────
console.log('\n§10  The record map is bounded, and never evicts a running run');
{
  // AGES MUST BE RECENT. A first draft of this section stamped finishedAt as
  // `1000 + i` — a 1970 timestamp — so the TTL sweep emptied the map and the
  // assertion `length <= MAX` passed at ZERO. A cap test that passes because
  // nothing is there is the guard-that-cannot-fail shape; recorded here so
  // the next person does not "simplify" it back.
  const OVERFILL = MAX_TRACKED_DOMAINS + 25;
  const ageOrdered = (i) => Date.now() - (OVERFILL - i) * 1000; // recent, oldest first

  __resetActivityForTests();
  for (let i = 0; i < OVERFILL; i++) {
    const id = startActivity('d' + i, 'f.pdf');
    observeActivity(id, EV_DONE(false));
    __peekActivityForTests('d' + i).finishedAt = ageOrdered(i);
  }
  const capped = listActivity().activity;
  ok(capped.length > 0, 'CONTROL: the fixtures are inside the TTL, so this measures the CAP and not the sweep');
  eq(capped.length, MAX_TRACKED_DOMAINS, 'the map is held at exactly MAX_TRACKED_DOMAINS');
  ok(!capped.some((a) => a.domain === 'd0'), 'the OLDEST settled record is the one evicted');
  ok(capped.some((a) => a.domain === 'd' + (OVERFILL - 1)), 'and the newest is kept');

  // A RUNNING record must survive eviction pressure — evicting one would make
  // a live ingest invisible, which is the defect this module exists to fix.
  __resetActivityForTests();
  const liveId = startActivity('the-live-one', 'live.pdf');
  ok(typeof liveId === 'string', 'setup: a live run exists');
  for (let i = 0; i < OVERFILL; i++) {
    const id = startActivity('d' + i, 'f.pdf');
    observeActivity(id, EV_DONE(false));
    __peekActivityForTests('d' + i).finishedAt = ageOrdered(i);
  }
  const after = listActivity().activity;
  eq(after.length, MAX_TRACKED_DOMAINS, 'CONTROL: eviction genuinely ran (the map is at its cap)');
  const stillThere = after.find((a) => a.domain === 'the-live-one');
  ok(!!stillThere, 'the RUNNING record survives eviction pressure');
  eq(stillThere && stillThere.status, 'running', 'and is still running');
}

// ── §11  THE ROUTE ──────────────────────────────────────────────────────
console.log('\n§11  GET /api/ingest/activity — the real router, on an ephemeral port');
{
  __resetActivityForTests();
  const id = startActivity('articles', 'wired.pdf');
  observeActivity(id, EV_PROGRESS(35, 'Writing wiki pages…'));

  const { default: ingestRouter } = await import('../src/routes/ingest.js');
  const app = express();
  app.use('/api/ingest', ingestRouter);

  // Port 0 = ephemeral. NEVER 3333: that is the maintainer's live app.
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  ok(port !== 3333, 'the test server is NOT on 3333 (the live app\'s port)');

  const res = await fetch(`http://127.0.0.1:${port}/api/ingest/activity`);
  eq(res.status, 200, 'the endpoint answers 200');
  const body = await res.json();
  eq(body.ok, true, 'and reports ok');
  ok(Number.isFinite(body.serverNow), 'and carries serverNow');
  eq(body.activity.length, 1, 'and lists the live record');
  eq(body.activity[0].filename, 'wired.pdf', 'which is the REAL store\'s record, not a fixture');
  eq(body.activity[0].pct, 35, 'with the progress the store was told about');

  // It is a READ. Calling it must not change anything.
  const before = JSON.stringify(listActivity().activity);
  await fetch(`http://127.0.0.1:${port}/api/ingest/activity`);
  eq(JSON.stringify(listActivity().activity), before, 'the endpoint mutates nothing');

  await new Promise((resolve) => server.close(resolve));
  __resetActivityForTests();
}

// ── §12  SOURCE GUARDS ──────────────────────────────────────────────────
// TEXT scans. They fail in the SAFE direction (a false red), never by
// silently permitting — and they cannot see a call moved behind an alias.
console.log('\n§12  Source guards on the route wiring');
{
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const routeSrc = readFileSync(path.join(ROOT, 'src/routes/ingest.js'), 'utf8');
  const storeSrc = readFileSync(path.join(ROOT, 'src/brain/ingest-activity.js'), 'utf8');

  ok(/observeActivity\(activityId, data\)/.test(routeSrc),
    'the ONE emit() closure folds every event into the record — one integration point, not four call sites');
  ok(/try \{ observeActivity\(activityId, data\); \} catch/.test(routeSrc),
    'and the call is wrapped: a bookkeeping side-channel must never fail an ingest (second layer)');
  ok(/settleAbandoned\(activityId\)/.test(routeSrc),
    'the finally settles an abandoned record, so a record cannot outlive its request');

  // ORDER IS LOAD-BEARING and a text scan CAN see it: startActivity must come
  // AFTER the file lock is acquired, or a lock-refused request would clobber
  // the record of the run that actually holds the lock.
  const lockIdx = routeSrc.indexOf('acquireFileLock(domainPath(domain)');
  const startIdx = routeSrc.indexOf('startActivity(domain, req.file.originalname)');
  ok(lockIdx > 0 && startIdx > 0 && startIdx > lockIdx,
    'startActivity is called AFTER acquireFileLock — a refused request must not clobber the live run\'s record');

  // The store must stay a LEAF. scrub-paths.js's own header records why
  // dragging the ingest queue (and through it llm.js/health.js) into another
  // module's graph is a hazard rather than a convenience.
  const imports = [...storeSrc.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  ok(imports.every((i) => i === 'node:crypto' || i === './wire-safe.js'),
    'the store imports ONLY node:crypto and ./wire-safe.js — it stays a leaf (got: ' + imports.join(', ') + ')');

  // ONE copy of the scrubbing guard. wireStr is not a formatter, it is the
  // single place that decides a string leaving this process is safe.
  ok(/from '\.\/wire-safe\.js'/.test(storeSrc), 'the store IMPORTS wireStr rather than carrying a copy');
  const queueSrc = readFileSync(path.join(ROOT, 'src/brain/ingest-queue.js'), 'utf8');
  ok(/import \{ wireStr[^}]*\} from '\.\/wire-safe\.js'/.test(queueSrc),
    'and so does ingest-queue.js — one copy of the guard, not two');
  ok(!/^function wireStr\(/m.test(queueSrc),
    'ingest-queue.js no longer carries its own wireStr definition');
  ok(!/^function wireStr\(/m.test(storeSrc),
    'and neither does the activity store');
}

console.log(`\n  ────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
console.log(`  ────────────────────────────────────────\n`);
process.exit(failed === 0 ? 0 : 1);
