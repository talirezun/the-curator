#!/usr/bin/env node
/**
 * test-memory-capture-route.js — OFFLINE. Package U: the honesty-meter route,
 * `GET /api/memory/:domain/:project/capture` (v3.63.0).
 *
 * ── WHY THIS SUITE EXISTS ────────────────────────────────────────────────
 * The route itself does no work — `readUsageLines`/`summariseSessions`
 * (src/brain/mcp-usage.js) are already pinned by test-mcp-usage.js §12 over a
 * hand-built log carrying every case. What ONLY a real Express dispatch over
 * a real socket can show, and what this suite exists for, is:
 *
 *   1. THE ROUTE'S OWN CONTRACT. The exact key set on the envelope and on
 *      each session row — package V codes against this shape in parallel,
 *      so an ADDED key must red here before it can silently drift.
 *   2. DOMAIN/PROJECT VALIDATION, reusing the sibling routes' own guards
 *      (`requireDomain`, `validProjectName`, the `projectExists` check) —
 *      driven against the REAL working-state store on a tempdir, the same
 *      way test-next-memory-routes-live.js drives its neighbours.
 *   3. THAT THE ROUTE NEVER WRITES. A usage-log READ that could corrupt the
 *      file it reads would be worse than the feature it reports on; the log's
 *      sha256 is compared before and after every request this suite makes.
 *   4. `since`/`limit` are BEST-EFFORT (an unparseable/out-of-range value
 *      falls back to its default rather than 400ing), and `totals` is taken
 *      over the UNCAPPED session list — the store's own rule
 *      (`distinctScopeCount`) restated for this reading: a count taken after
 *      a display cap is a cap wearing a measurement's clothes.
 *   5. NO 403 ON A READONLY MIRROR. The brief this package shipped against
 *      said "reuse the existing guards" and named 403 among them, but the
 *      guard that returns 403 (`refuseMirror`) is called ONLY by this
 *      router's WRITE routes (grep confirms: every `refuseMirror` call site
 *      sits on a POST/PUT/PATCH/DELETE handler) — the sibling READ routes
 *      (`GET .../foundations/:slug`, `GET /:domain/:project`) never call it
 *      and simply report `readonly` as an informational field, or nothing at
 *      all. This route is a pure read of MCP call history, not of domain
 *      content, so it follows the READ convention: a Shared Brain mirror's
 *      usage history is still real history and is served, not refused. §2
 *      drives this as a POSITIVE control rather than assuming it.
 *   6. NO REGISTRATION COLLISION with a project literally named `capture`
 *      (§ the CAPTURE COLLISION CONTROL) — the two-segment detail route and
 *      this three-segment suffix route cannot shadow each other by
 *      construction, and this is driven rather than argued.
 *
 * SAFETY — never touches real user data. CURATOR_TEST_USER_DATA_DIR and
 * CURATOR_TEST_DOMAINS_DIR are set to a fresh tempdir BEFORE anything
 * imports the store, `__setDomainsDirOverride` belt-and-braces on top; the
 * server listens on an EPHEMERAL port (`listen(0)`) on 127.0.0.1 and is
 * closed in `finally`. No network, no LLM call, no real credential file.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const TMP = mkdtempSync(join(tmpdir(), 'curator-capture-route-'));
const USER_DATA = join(TMP, 'userdata');
const DOMAINS = join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
// BOTH, and BEFORE the store or the usage log module is imported — the same
// two-seam isolation test-next-memory-routes-live.js and test-mcp-usage.js
// both use, for the same reason: the user-data seam is what keeps the usage
// log itself off the developer's real machine.
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;

let passed = 0; let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);

const paths = await import('../src/brain/paths.js');
const usage = await import('../src/brain/mcp-usage.js');
const express = (await import('express')).default;
const router = (await import('../src/routes/memory.js')).default;

const LOG = paths.getMcpUsageLogPath();

function makeDomain(slug, extraFrontmatter) {
  mkdirSync(join(DOMAINS, slug, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(DOMAINS, slug, 'CLAUDE.md'), `${extraFrontmatter || ''}# ${slug}\n`);
  writeFileSync(join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'log.md'), '# Log\n');
}
/** A NAMED project's own directory — the one thing `projectExists` checks. */
function makeProject(domain, project) {
  mkdirSync(join(DOMAINS, domain, 'state', project), { recursive: true });
}
function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
function writeLog(rows) {
  writeFileSync(LOG, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  usage.__clearUsageCache();
}
function clearLog() {
  try { rmSync(LOG); } catch { /* absent already */ }
  usage.__clearUsageCache();
}
/**
 * A log FILE that exists but carries no session in it — a legacy line (no
 * `sid`) is the honest shape for that: present, but with nothing this window
 * can call a session. Distinct from `clearLog()` (no file at all), which is
 * the OTHER honest shape `noSessionsButSaves` must tell apart (v3.65.1 §D4)
 * — a log a bridge never opened can't have "logged no sessions".
 */
function writePresentEmptyLog() {
  writeFileSync(LOG, `${JSON.stringify({
    ts: new Date(Date.now() - 60 * 60_000).toISOString(), tool: 'legacy_probe',
  })}\n`, 'utf8');
  usage.__clearUsageCache();
}
function hasKeyDeep(obj, key) {
  if (!obj || typeof obj !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  return Object.values(obj).some((v) => hasKeyDeep(v, key));
}
function eqKeys(obj, expected, label) {
  const got = JSON.stringify(Object.keys(obj).sort());
  const exp = JSON.stringify([...expected].sort());
  eq(got, exp, label);
}

makeDomain('alpha');
makeProject('alpha', 'proj1');
makeProject('alpha', 'capture'); // the collision control — a project literally named "capture"
makeDomain('shared-mirror', '---\nreadonly: true\n---\n\n');

// ── A REAL SERVER, on an ephemeral port ──────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/memory', router);
const server = await new Promise((resolve) => {
  const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
});
const BASE = `http://127.0.0.1:${server.address().port}/api/memory`;

async function GET(path) {
  const res = await fetch(BASE + path);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body: body || {} };
}

const NOW = Date.now();
const T = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

// `newestSaveAt` and `noSessionsButSaves` joined in v3.64.1 — the two fields
// that let a caller tell an HONEST ZERO ("nobody worked on this project this
// month") from the contradiction the maintainer reported on the day v3.64.0
// shipped: "saved 47 min ago" on the reading directly above this meter and
// "no agent session in the last 30 days" on the meter itself, both true.
const TOP_KEYS = [
  'ok', 'domain', 'project', 'since', 'logPresent', 'lineCeiling', 'lineCeilingLabel',
  'totals', 'sessions', 'sessionsShown', 'sessionsTruncated', 'newestSaveAt',
  'noSessionsButSaves', 'note',
];
const TOTALS_KEYS = [
  'sessions', 'sessionsRead', 'sessionsSaved', 'sessionsReadNotSaved', 'legacyLines', 'selfTestLines',
];
const SESSION_KEYS = ['sid', 'client', 'startedAt', 'endedAt', 'calls', 'read', 'saved'];

console.log('test-memory-capture-route.js — GET /api/memory/:domain/:project/capture\n');

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('§1  Domain/project validation — reusing the sibling routes’ guards');
  // ═══════════════════════════════════════════════════════════════════════
  clearLog();
  {
    const r = await GET('/no-such-domain/proj1/capture');
    eq(r.status, 404, 'an unknown domain is a 404');
    eq(r.body.reason, 'unknown_domain', '…with the reason the sibling routes use');
  }
  {
    const r = await GET('/alpha/UP-PER-not-safe!!/capture');
    eq(r.status, 400, 'an unusable project name is a 400');
    eq(r.body.reason, 'invalid_project', '…with the reason the sibling routes use');
  }
  {
    const r = await GET('/alpha/ghost-project/capture');
    eq(r.status, 404, 'a syntactically valid but NEVER-CREATED project is a 404');
    eq(r.body.reason, 'project_not_found', '…distinguished from an invalid NAME');
  }
  {
    const r = await GET('/alpha/proj1/capture');
    eq(r.status, 200, 'a real, empty-of-usage project answers 200');
  }
  {
    // THE DOMAIN'S OWN PROJECT always exists — its tree IS the state root —
    // so it never 404s even though nobody called makeProject for it.
    const r = await GET('/alpha/alpha/capture');
    eq(r.status, 200, 'the domain’s own project (no makeProject call) still answers 200');
  }
  {
    // NO 403 ON A READONLY MIRROR (see the header note — this is a read of
    // MCP call history, not of domain content, and `refuseMirror` is a
    // write-route guard). Positive control, not an assumption.
    const r = await GET('/shared-mirror/shared-mirror/capture');
    eq(r.status, 200, 'a Shared Brain mirror domain is NOT refused — reads are always served');
    eq(r.body.logPresent, false, '…and it reads the same (empty, here) global usage log as any other domain');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§2  The exact key set — what package V codes against');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const r = await GET('/alpha/proj1/capture');
    eq(r.status, 200, 'answers 200');
    eqKeys(r.body, TOP_KEYS, 'the top-level envelope carries EXACTLY these keys, no more, no fewer');
    eqKeys(r.body.totals, TOTALS_KEYS, '…and `totals` carries exactly these');
    ok(!hasKeyDeep(r.body, 'path'), 'no `path` key anywhere in the answer — the log’s location is never leaked here');
    ok(!hasKeyDeep(r.body, 'logPath'), '…under either spelling');
    eq(r.body.lineCeiling, usage.MAX_LINE_BYTES, 'lineCeiling is the store’s own constant');
    eq(r.body.lineCeilingLabel, usage.MAX_LINE_BYTES_LABEL, 'lineCeilingLabel is the store’s own label');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§3  An absent log — present:false, zeroed, never an error');
  // ═══════════════════════════════════════════════════════════════════════
  {
    clearLog();
    const r = await GET('/alpha/proj1/capture');
    eq(r.status, 200, 'an absent log is still 200, never an error');
    eq(r.body.logPresent, false, '…reported honestly');
    eq(r.body.totals.sessions, 0, '…with every total zeroed');
    eq(r.body.totals.sessionsRead, 0, '', );
    eq(r.body.totals.sessionsSaved, 0, '', );
    eq(r.body.totals.sessionsReadNotSaved, 0, '', );
    eq(r.body.totals.legacyLines, 0, '', );
    eq(r.body.totals.selfTestLines, 0, '', );
    eq(r.body.sessions.length, 0, '…and an empty sessions array');
    eq(r.body.sessionsShown, 0, '', );
    eq(r.body.sessionsTruncated, false, '', );
    eq(r.body.note, 'no usage log yet — the meter starts counting with the first bridge session on v3.63.0',
      '…with the note naming exactly this');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§4  The three states of §D.5, and legacy/self-test lines');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const P = 'proj1';
    const rows = [
      // S1 — read then saved. STATE 3: ran and saved.
      { ts: T(300), ev: 'session', sid: '111111111111', client: 'claude-code' },
      { ts: T(299), tool: 'get_project_context', domain: 'alpha', ok: true, refused: false, ms: 9, sid: '111111111111', project: P },
      { ts: T(240), tool: 'save_working_state', domain: 'alpha', ok: true, refused: false, ms: 12, sid: '111111111111', project: P },
      // S2 — read, never saved. STATE 2: THE READING THAT MATTERS.
      { ts: T(200), ev: 'session', sid: '222222222222', client: 'codex' },
      { ts: T(199), tool: 'get_working_state', domain: 'alpha', ok: true, refused: false, ms: 5, sid: '222222222222', project: P },
      // S3 — a REFUSED save is not a save.
      { ts: T(150), ev: 'session', sid: '333333333333', client: 'cursor' },
      { ts: T(149), tool: 'save_working_state', domain: 'alpha', ok: false, refused: true, ms: 1, sid: '333333333333', project: P },
      // ANOTHER PROJECT — must not leak into proj1's reading.
      { ts: T(100), ev: 'session', sid: '444444444444', client: 'zed' },
      { ts: T(99), tool: 'get_project_context', domain: 'alpha', ok: true, refused: false, ms: 6, sid: '444444444444', project: 'other-project' },
      { ts: T(98), tool: 'save_working_state', domain: 'alpha', ok: true, refused: false, ms: 6, sid: '444444444444', project: 'other-project' },
      // A SELF-TEST run — excluded from sessions, counted apart.
      { ts: T(60), ev: 'session', sid: '555555555555', client: 'other', via: 'self-test' },
      { ts: T(59), tool: 'get_project_context', domain: 'alpha', ok: true, refused: false, ms: 4, sid: '555555555555', project: P, via: 'self-test' },
      { ts: T(58), tool: 'save_working_state', domain: 'alpha', ok: true, refused: false, ms: 4, sid: '555555555555', project: P, via: 'self-test' },
      // LEGACY — written before v3.63.0. No sid, so no session, ever.
      { ts: T(500), tool: 'get_project_context', domain: 'alpha', ok: true, refused: false, ms: 9 },
      { ts: T(499), tool: 'save_working_state', domain: 'alpha', ok: true, refused: false, ms: 9 },
    ];
    writeLog(rows);
    const before = sha(LOG);

    const r = await GET('/alpha/proj1/capture');
    eq(r.status, 200, 'answers 200');
    eq(r.body.logPresent, true, 'the log is present');
    eq(r.body.totals.sessions, 3, 'three sessions touched proj1 (S1, S2, S3 — S4 is another project, S5 is self-test)');
    eq(r.body.totals.sessionsRead, 2, 'two of them bootstrapped before their first save (S1, S2)');
    eq(r.body.totals.sessionsSaved, 1, 'one saved successfully (S1 — S3’s save was REFUSED)');
    eq(r.body.totals.sessionsReadNotSaved, 1, 'ONE read and did not save — the reading that matters (S2)');
    eq(r.body.totals.legacyLines, 2, 'the two pre-v3.63.0 lines are counted as legacy, never as a session');
    eq(r.body.totals.selfTestLines, 3, '…and the self-test run’s three lines (session + 2 calls) are counted apart');
    eq(r.body.note, '2 lines predate session ids and are not counted', 'the note names the legacy count, pluralised');

    const by = Object.fromEntries(r.body.sessions.map((s) => [s.sid, s]));
    eq(Object.keys(by).length, 3, 'one row per session, in the response too');
    ok(!by['555555555555'], 'the self-test session is not in the list at all');
    ok(!by['444444444444'], '…and neither is the other project’s');
    eqKeys(by['111111111111'], SESSION_KEYS, 'a session row carries exactly these keys — no `project` (the route is already scoped)');
    eq(by['111111111111'].read, true, 'S1 read…');
    eq(by['111111111111'].saved, true, '…and saved');
    eq(by['111111111111'].client, 'claude-code', '…under the client its session line named');
    eq(by['222222222222'].read, true, 'S2 read…');
    eq(by['222222222222'].saved, false, '…and did NOT save — STATE 2, the reading that matters');
    eq(by['333333333333'].read, false, 'S3 never bootstrapped…');
    eq(by['333333333333'].saved, false, '…and its refused save is not a save');

    // Newest-first by each session's LAST line: S3's refused save (T149) is
    // more recent than S2's only call (T199), which is more recent than S1's
    // save (T240) — S1 bootstrapped earliest but also finished earliest.
    eq(r.body.sessions[0].sid, '333333333333', 'newest-first by each session’s OWN last line, not by when it started');
    eq(r.body.sessions[2].sid, '111111111111', '…oldest (by last line) sorts last');

    // STATE 1 — no bridge session ran at all, for a project with real usage
    // elsewhere in the SAME log.
    const none = await GET('/alpha/capture/capture');
    eq(none.status, 200, 'STATE 1 — a real project the log never mentions still answers 200');
    eq(none.body.totals.sessions, 0, '…zero sessions, not an error');
    // `legacyLines` is a fact about the LOG, not about one project (the store's
    // own rule — mcp-usage.js: "the number is therefore about the LOG"), so
    // the note still fires here even though THIS project has no lines at all.
    eq(none.body.note, '2 lines predate session ids and are not counted',
      '…and the legacy note still fires — it describes the log, not this project’s own (empty) slice of it');

    ok(sha(LOG) === before, 'the log is byte-for-byte unchanged after every read above — the route writes nothing');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§5  `since` — default window, an explicit one, and a malformed one');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const P = 'proj1';
    const rows = [
      // Recent — inside the default 30-day window.
      { ts: T(60), ev: 'session', sid: 'aaaaaaaaaaaa', client: 'claude-code' },
      { ts: T(59), tool: 'get_project_context', domain: 'alpha', ok: true, refused: false, ms: 5, sid: 'aaaaaaaaaaaa', project: P },
      { ts: T(58), tool: 'save_working_state', domain: 'alpha', ok: true, refused: false, ms: 5, sid: 'aaaaaaaaaaaa', project: P },
      // 40 days ago — outside the default 30-day window, whole.
      { ts: T(40 * 24 * 60), ev: 'session', sid: 'bbbbbbbbbbbb', client: 'codex' },
      { ts: T(40 * 24 * 60 - 1), tool: 'get_project_context', domain: 'alpha', ok: true, refused: false, ms: 5, sid: 'bbbbbbbbbbbb', project: P },
      { ts: T(40 * 24 * 60 - 2), tool: 'save_working_state', domain: 'alpha', ok: true, refused: false, ms: 5, sid: 'bbbbbbbbbbbb', project: P },
    ];
    writeLog(rows);

    const withDefault = await GET('/alpha/proj1/capture');
    eq(withDefault.body.totals.sessions, 1, 'the default 30-day window excludes the 40-day-old session');
    eq(withDefault.body.sessions[0].sid, 'aaaaaaaaaaaa', '…keeping only the recent one');
    ok(Date.now() - Date.parse(withDefault.body.since) >= 29 * 24 * 60 * 60 * 1000
      && Date.now() - Date.parse(withDefault.body.since) <= 31 * 24 * 60 * 60 * 1000,
      '`since` in the answer is ~30 days ago when the query omits it', withDefault.body.since);

    const wide = await GET(`/alpha/proj1/capture?since=${encodeURIComponent(T(45 * 24 * 60))}`);
    eq(wide.body.totals.sessions, 2, 'an explicit wider `since` includes the older session too');
    eq(wide.body.since, new Date(Date.parse(T(45 * 24 * 60))).toISOString(),
      '…and `since` in the answer is the resolved boundary, not a default');

    const junk = await GET('/alpha/proj1/capture?since=not-a-real-date');
    eq(junk.status, 200, 'an unparseable `since` is BEST-EFFORT — 200, never a 400');
    eq(junk.body.totals.sessions, 1, '…and falls back to the default 30-day window rather than including everything');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§6  `limit` — truncation, with totals over the UNCAPPED set');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const P = 'proj1';
    const rows = [];
    const SESSION_COUNT = 25;
    for (let i = 0; i < SESSION_COUNT; i++) {
      const sid = i.toString(16).padStart(12, '0');
      rows.push({ ts: T(i * 2 + 1), ev: 'session', sid, client: 'claude-code' });
      rows.push({ ts: T(i * 2), tool: 'get_project_context', domain: 'alpha', ok: true, refused: false, ms: 3, sid, project: P });
    }
    writeLog(rows);

    const def = await GET('/alpha/proj1/capture');
    eq(def.body.totals.sessions, SESSION_COUNT, 'totals.sessions is the UNCAPPED count — 25');
    eq(def.body.sessionsShown, 20, 'the default limit shows 20');
    eq(def.body.sessions.length, 20, '…and the array itself is that long');
    eq(def.body.sessionsTruncated, true, '…disclosed as truncated');

    const five = await GET('/alpha/proj1/capture?limit=5');
    eq(five.body.totals.sessions, SESSION_COUNT, 'totals.sessions is STILL 25 with limit=5 — a cap reported as a measurement is the defect this pins against');
    eq(five.body.sessionsShown, 5, 'sessionsShown honours the requested limit');
    eq(five.body.sessionsTruncated, true, '…still truncated');

    const over = await GET('/alpha/proj1/capture?limit=9999');
    eq(over.body.sessionsShown, SESSION_COUNT, 'a limit above the 25 actual sessions shows all of them');
    eq(over.body.sessionsTruncated, false, '…and is NOT truncated — clamped to 200, not to 9999, but 25 < 200 either way');

    const zero = await GET('/alpha/proj1/capture?limit=0');
    eq(zero.body.sessionsShown, 20, 'limit=0 is out of range and falls back to the default (20), not to zero rows');

    const neg = await GET('/alpha/proj1/capture?limit=-5');
    eq(neg.body.sessionsShown, 20, 'a negative limit falls back to the default the same way');

    const junk = await GET('/alpha/proj1/capture?limit=banana');
    eq(junk.status, 200, 'a non-numeric limit is BEST-EFFORT — 200, never a 400');
    eq(junk.body.sessionsShown, 20, '…and falls back to the default');
  }
  {
    // THE CEILING ITSELF, not just the default: with fewer than 200 real
    // sessions, `limit=9999` and `limit=200` answer identically whether or
    // not the code actually clamps at 200 — a positive test with only 25
    // sessions cannot tell "clamped to 200" from "not clamped at all". Over
    // 200 real sessions is the only fixture that can.
    const P = 'proj1';
    const rows = [];
    const SESSION_COUNT = 220;
    for (let i = 0; i < SESSION_COUNT; i++) {
      const sid = i.toString(16).padStart(12, '0');
      rows.push({ ts: T(i * 2 + 1), ev: 'session', sid, client: 'claude-code' });
      rows.push({ ts: T(i * 2), tool: 'get_project_context', domain: 'alpha', ok: true, refused: false, ms: 3, sid, project: P });
    }
    writeLog(rows);

    const huge = await GET('/alpha/proj1/capture?limit=99999');
    eq(huge.body.totals.sessions, SESSION_COUNT, 'totals.sessions is the uncapped 220 even with an enormous limit');
    eq(huge.body.sessionsShown, 200, 'sessionsShown is CLAMPED at CAPTURE_MAX_LIMIT (200), not at the requested 99999');
    eq(huge.body.sessions.length, 200, '…and the array itself is exactly 200 long, not 220 and not 99999');
    eq(huge.body.sessionsTruncated, true, '…and truncation is disclosed (220 real sessions, 200 shown)');

    const atCeiling = await GET('/alpha/proj1/capture?limit=200');
    eq(atCeiling.body.sessionsShown, 200, 'an explicit limit=200 (the ceiling itself) shows exactly 200');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§7  The registration-order control — a project literally named "capture"');
  // ═══════════════════════════════════════════════════════════════════════
  {
    // Two-segment: the ordinary DETAIL route for a project named "capture".
    const detail = await GET('/alpha/capture');
    eq(detail.status, 200, 'GET /alpha/capture (2 segments) reaches the DETAIL route');
    eq(detail.body.project, 'capture', '…about the project literally called "capture"');
    ok(!('totals' in detail.body), '…and it is NOT the capture meter (no `totals` field)', JSON.stringify(Object.keys(detail.body)));

    // Three-segment: THIS route, for that same project.
    const meter = await GET('/alpha/capture/capture');
    eq(meter.status, 200, 'GET /alpha/capture/capture (3 segments) reaches the CAPTURE route');
    eq(meter.body.project, 'capture', '…about the same project');
    ok('totals' in meter.body, '…and it IS the meter this time', JSON.stringify(Object.keys(meter.body)));
    ok(!('brief' in meter.body), '…with none of the detail route’s fields', JSON.stringify(Object.keys(meter.body)));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§8  Performance — a 1 MB usage-log fixture');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const P = 'proj1';
    const rows = [];
    let bytes = 0;
    let i = 0;
    let sid = 0;
    const TARGET_BYTES = 1024 * 1024;
    while (bytes < TARGET_BYTES) {
      const sidHex = sid.toString(16).padStart(12, '0');
      const client = sid % 4 === 0 ? 'codex' : sid % 4 === 1 ? 'claude-code' : sid % 4 === 2 ? 'cursor' : 'goose';
      const sessionLine = JSON.stringify({ ts: T(i += 1), ev: 'session', sid: sidHex, client });
      rows.push(sessionLine); bytes += sessionLine.length + 1;
      const calls = 4 + (sid % 6);
      for (let c = 0; c < calls && bytes < TARGET_BYTES; c++) {
        const tool = c === 0 ? 'get_project_context' : (c === calls - 1 ? 'save_working_state' : 'search_wiki');
        const line = JSON.stringify({
          ts: T(i += 1), tool, domain: 'alpha', ok: true, refused: false, ms: 5, sid: sidHex,
          project: sid % 3 === 0 ? 'other-project' : P,
        });
        rows.push(line); bytes += line.length + 1;
      }
      sid++;
    }
    writeLog(rows);
    const sizeMB = (statSync(LOG).size / (1024 * 1024)).toFixed(2);

    const t0 = Date.now();
    const r = await GET(`/alpha/${P}/capture?limit=50`);
    const ms = Date.now() - t0;
    eq(r.status, 200, `the route answers 200 over a ${sizeMB} MB log (${rows.length} lines, ${sid} sessions)`);
    console.log(`    measured: ${ms} ms end-to-end (HTTP round trip) over a ${sizeMB} MB / ${rows.length}-line log`);
    ok(ms < 3000, `well under a generous 3 s ceiling (measured ${ms} ms)`, `${ms}ms`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§9  foundationsWire forwards the four v3.63.0 remote readings (out-of-band item)');
  // ═══════════════════════════════════════════════════════════════════════
  // Not this route's own subject, but assigned to this package because it
  // was the only builder left in src/routes/memory.js when package G landed
  // `listFoundations`'s four new project-level facts (`remoteMirror` /
  // `remoteChecked` / `remoteCommit` / `remoteError`). Driven over the REAL
  // detail route (`GET /:domain/:project`), which is what rides `foundations`
  // on every project switch — a hand-built manifest is the cheapest way to
  // put a `repo.remote` on disk without a real GitHub round trip.
  {
    mkdirSync(join(DOMAINS, 'alpha', 'state', 'proj-remote', 'foundations'), { recursive: true });
    writeFileSync(
      join(DOMAINS, 'alpha', 'state', 'proj-remote', 'foundations', 'manifest.json'),
      JSON.stringify({
        version: 1,
        ownership: 'repo',
        repo: {
          root: '/tmp/not-a-real-checkout',
          remote: { owner: 'acme', repo: 'widgets', ref: 'main', path: null },
          lastRefreshAt: null,
          lastRefreshCommit: 'abcdef0123456789abcdef0123456789abcdef01',
        },
        documents: [],
      }),
    );
    const withRemote = await GET('/alpha/proj-remote');
    eq(withRemote.status, 200, 'the detail route answers 200 for a project with a repo.remote manifest');
    const f1 = withRemote.body.foundations || {};
    eq(f1.remoteMirror, true, 'remoteMirror forwards true — a GitHub repository IS recorded for this mirror');
    eq(f1.remoteChecked, false, 'remoteChecked forwards false — this plain read asked GitHub nothing');
    eq(f1.remoteCommit, 'abcdef0123456789abcdef0123456789abcdef01', 'remoteCommit forwards the manifest’s lastRefreshCommit');
    eq(f1.remoteError, null, 'remoteError forwards null — a call that was not made cannot fail');

    // ABSENT — the keys are still PRESENT with their null/false values,
    // exactly as the store returns them (never omitted, never a spread).
    mkdirSync(join(DOMAINS, 'alpha', 'state', 'proj-noremote'), { recursive: true });
    const withoutRemote = await GET('/alpha/proj-noremote');
    eq(withoutRemote.status, 200, 'the detail route answers 200 for a project with NO foundations manifest at all');
    const f2 = withoutRemote.body.foundations || {};
    ok('remoteMirror' in f2, 'remoteMirror is PRESENT even with no manifest', JSON.stringify(Object.keys(f2)));
    ok('remoteChecked' in f2, 'remoteChecked is PRESENT too');
    ok('remoteCommit' in f2, 'remoteCommit is PRESENT too');
    ok('remoteError' in f2, 'remoteError is PRESENT too');
    eq(f2.remoteMirror, false, '…with remoteMirror false — no repository is recorded');
    eq(f2.remoteChecked, false, '…remoteChecked false');
    eq(f2.remoteCommit, null, '…remoteCommit null');
    eq(f2.remoteError, null, '…remoteError null');
  }

  // ═════════════════════════════════════════════════════════════════════
  section('§11  Saves with no session to account for them (v3.64.1)');
  // ═════════════════════════════════════════════════════════════════════
  //
  // REPORTED FROM PRODUCTION on the day v3.64.0 shipped, and the reason this
  // route gained two fields. Step ②'s "Last saved" reading said `saved 47 min
  // ago`; this meter, four pixels below it, said `no agent session in the last
  // 30 days`. BOTH WERE TRUE — the saves came through a bridge process that
  // writes no session line, so the store held the saves and the log held no
  // session to attribute them to — and the screen left the user to reconcile
  // them.
  //
  // THE ROUTE IS THE SIDE THAT CAN SEE BOTH, and it already reads the
  // project's state for the existence check, so the clause costs NO second
  // store call. What it must never do is explain away an HONEST ZERO: "nobody
  // worked on this project this month" is exactly the reading the meter exists
  // to report, and telling a user to restart Claude Desktop over it would be
  // the app apologising for a true answer.
  {
    const store = await import('../src/brain/working-state.js');
    makeProject('alpha', 'saved');
    const saved = await store.saveWorkingState('alpha', {
      project: 'saved', scope: 'session-x', headline: 'a real save',
      now: 'things are green', next: 'ship it',
    });
    ok(saved && saved.ok === true, 'CONTROL: a real handoff was written through the store',
      JSON.stringify(saved && (saved.error || saved.reason)));

    {
      // THE CONTRADICTION, PROPERLY: a log EXISTS — a bridge did run — and it
      // logged no session for this window, while the store shows a save in
      // it. Only a PRESENT log can have "logged no sessions"; §D4 below is
      // the sibling case where there is no log to have logged anything.
      writePresentEmptyLog();
      const r = await GET('/alpha/saved/capture');
      eq(r.status, 200, 'answers 200 with saves present and a log with zero sessions in it');
      eq(r.body.logPresent, true, 'CONTROL: the log really is present');
      eq(r.body.totals.sessions, 0, 'CONTROL: and it really reports no session');
      ok(typeof r.body.newestSaveAt === 'string' && Number.isFinite(Date.parse(r.body.newestSaveAt)),
        'newestSaveAt is the project\'s own save clock, as an ISO stamp',
        JSON.stringify(r.body.newestSaveAt));
      eq(r.body.noSessionsButSaves, true, 'the contradiction is reported as a fact, not as prose only');
      ok(/bridge that logged no sessions/.test(r.body.note || ''),
        '...and the note names it, with the remedy', JSON.stringify(r.body.note));
      ok(!/no usage log yet/.test(r.body.note || ''),
        '...outranking the absent-log note, which explains a figure rather than a contradiction',
        JSON.stringify(r.body.note));
    }

    {
      // ═══ §D4 (v3.65.1) — NO LOG AT ALL IS NOT "A BRIDGE THAT LOGGED
      // NOTHING" ═══ Found by the Context builder (REPORT-v3651-context.md
      // §11 D4): the route's `noSessionsButSaves` carried no term for the
      // usage log EXISTING, so a machine with saves on disk that never
      // opened a bridge took the contradiction arm ahead of the `!present`
      // arm directly below it and painted the loud restart-Claude-Desktop
      // note over an honest "no usage log yet" — a false alarm. This is the
      // control the block above needed: same save, same zero sessions, but
      // the log file itself is ABSENT rather than present-and-empty.
      clearLog();
      const r = await GET('/alpha/saved/capture');
      eq(r.status, 200, 'answers 200 with saves present and NO log at all');
      eq(r.body.logPresent, false, 'CONTROL: there really is no log on this machine');
      eq(r.body.totals.sessions, 0, 'CONTROL: so of course it reports no session');
      ok(typeof r.body.newestSaveAt === 'string' && Number.isFinite(Date.parse(r.body.newestSaveAt)),
        'CONTROL: and the store still shows the save, same as the block above',
        JSON.stringify(r.body.newestSaveAt));
      eq(r.body.noSessionsButSaves, false,
        'an absent log is never "a bridge that logged no sessions" — nothing was asked to log anything');
      ok(/no usage log yet/.test(r.body.note || ''),
        '...the ordinary absent-log note applies instead', JSON.stringify(r.body.note));
      ok(!/bridge that logged no sessions/.test(r.body.note || ''),
        '...never the restart-Claude-Desktop remedy, which would blame a bridge that was never asked',
        JSON.stringify(r.body.note));
    }

    {
      // THE HONEST ZERO. A project with no save at all: same empty log, same
      // zero sessions, and the clause MUST stay silent.
      clearLog();
      const r = await GET('/alpha/proj1/capture');
      eq(r.body.totals.sessions, 0, 'CONTROL: still no sessions');
      eq(r.body.newestSaveAt, null, 'CONTROL: and this project has never been saved');
      eq(r.body.noSessionsButSaves, false, 'an honest zero is NOT dressed as a stale bridge');
      ok(/no usage log yet/.test(r.body.note || ''),
        '...and the ordinary note is the one that applies', JSON.stringify(r.body.note));
    }

    {
      // ── THE CLOCK IS THE FILE'S, NOT THE AGENT'S, AND THAT IS THE POINT ──
      // The note exists to reconcile two readings the user is looking at, and
      // the one directly above it — step ②'s "Last saved" — is derived from
      // `lastWriteAt`, the file's own stamp. `writtenAt` is the AGENT'S
      // declared clock and can sit well outside the window while the file it
      // wrote landed inside it: a handoff written on a laptop yesterday and
      // synced to this machine ten minutes ago is exactly that. A note that
      // named a save the figure beside it does not show would be worse than
      // no note, so this drives the two clocks APART and requires the route
      // to follow the one on screen. A PRESENT log, deliberately (v3.65.1):
      // this block is testing the file-vs-agent clock, not log presence —
      // §D4 above already covers an absent log on its own.
      writePresentEmptyLog();
      // `<scope>/<machine>/journal.jsonl` — the machine segment is minted per
      // install, so it is discovered rather than guessed.
      const scopeDir = join(DOMAINS, 'alpha', 'state', 'saved', 'session-x');
      const machine = readdirSync(scopeDir)[0];
      ok(!!machine, 'CONTROL: the save really wrote a machine folder', String(machine));
      const jl = join(scopeDir, machine, 'journal.jsonl');
      const lines = readFileSync(jl, 'utf8').trim().split('\n')
        .map((l) => { const o = JSON.parse(l); o.at = '2020-01-02T03:04:05.000Z'; return JSON.stringify(o); });
      writeFileSync(jl, `${lines.join('\n')}\n`, 'utf8');
      const r = await GET('/alpha/saved/capture');
      const detail = await GET('/alpha/saved');
      const agentClock = (detail.body.scopes || []).map((x) => x.writtenAt).filter(Boolean);
      ok(agentClock.every((t) => Date.parse(t) < Date.now() - 365 * 24 * 3600_000),
        'CONTROL: the agent clock really is years outside the window',
        JSON.stringify(agentClock));
      eq(r.body.noSessionsButSaves, true,
        'the clause still fires — the FILE clock is what the reading beside it shows');
      ok(Date.parse(r.body.newestSaveAt) > Date.now() - 3600_000,
        'and newestSaveAt is the file clock, not the agent\'s',
        String(r.body.newestSaveAt));
    }

    {
      // A SAVE OLDER THAN THE WINDOW is not a contradiction either: the meter
      // only claims there were no sessions IN the window. A PRESENT log
      // again (v3.65.1), to isolate the window logic from log presence.
      writePresentEmptyLog();
      const r = await GET(`/alpha/saved/capture?since=${encodeURIComponent(
        new Date(Date.now() + 60_000).toISOString())}`);
      eq(r.body.noSessionsButSaves, false,
        'a save from before the window opened does not fire the clause');
    }

    {
      // AND A SESSION IN THE WINDOW SETTLES IT: the log can account for the
      // saves, so there is nothing left to reconcile.
      const sid = 'aa11bb22cc33';
      writeLog([
        { ts: new Date(Date.now() - 5 * 60_000).toISOString(), ev: 'session', sid, client: 'claude-code' },
        { ts: new Date(Date.now() - 5 * 60_000).toISOString(), tool: 'save_working_state',
          domain: 'alpha', project: 'saved', ok: true, refused: false, ms: 3, sid },
      ]);
      const r = await GET('/alpha/saved/capture');
      eq(r.body.totals.sessions, 1, 'CONTROL: the session was counted');
      eq(r.body.noSessionsButSaves, false, 'one session in the window closes the contradiction');
      clearLog();
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  section('§12  v3.66.0 — the meter reads the UNION of this machine’s usage logs');
  // ═════════════════════════════════════════════════════════════════════
  //
  // A checkout's server and the installed .app's bridge write two different
  // logs (the v3.64.0 measurement). The meter used to read only its own, so
  // it could say "no session" about sessions the other one logged — and the
  // menubar widget and the MCP bridge page (which read the union) would then
  // disagree with it about one project. The TEST-ONLY seam
  // CURATOR_TEST_BUNDLE_LOG_DIR plays the second log.
  {
    makeProject('alpha', 'union');
    const BUNDLE = join(TMP, 'bundle-log');
    mkdirSync(BUNDLE, { recursive: true });
    const BLOG = join(BUNDLE, LOG.split('/').pop());
    writeLog([{ ts: T(10), tool: 'save_working_state', domain: 'alpha', project: 'union', ok: true, refused: false, ms: 1, sid: '0a0a0a0a0a0a' }]);
    writeFileSync(BLOG, `${JSON.stringify({ ts: T(20), tool: 'save_working_state', domain: 'alpha', project: 'union', ok: true, refused: false, ms: 1, sid: '0b0b0b0b0b0b' })}\n`);
    const alone = await GET('/alpha/union/capture');
    eq(alone.body.totals.sessions, 1, 'CONTROL: with no second log on the machine, one session');
    process.env.CURATOR_TEST_BUNDLE_LOG_DIR = BUNDLE;
    try {
      usage.__clearUsageCache();
      const both = await GET('/alpha/union/capture');
      eq(both.body.totals.sessions, 2, 'with a second log, the meter counts BOTH Curators’ sessions');
      eq(both.body.totals.sessionsSaved, 2, '…and both saves');
      eqKeys(both.body, TOP_KEYS, 'the envelope is still EXACTLY the pinned key set (no path, no new field)');
      ok(!JSON.stringify(both.body).includes(BUNDLE), 'no on-disk path of either log reaches the envelope');
    } finally {
      delete process.env.CURATOR_TEST_BUNDLE_LOG_DIR;
      usage.__clearUsageCache();
    }
    clearLog();
  }

  // ═════════════════════════════════════════════════════════════════════
  section('§13  v3.66.0 — stateBudgetBytes on the project detail envelope');
  // ═════════════════════════════════════════════════════════════════════
  //
  // The handoff budget a save is trimmed at (MAX_STATE_BYTES, 48 KB), sent so
  // a view can draw each handoff's `bytes` against it. It is a CEILING, never
  // an over-run: an over-budget save is trimmed and disclosed, not refused.
  {
    const store = await import('../src/brain/working-state.js');
    makeProject('alpha', 'budget');
    const big = 'lorem ipsum dolor sit amet '.repeat(4000);          // ~108 KB of prose
    const saved = await store.saveWorkingState('alpha', {
      project: 'budget', scope: 'big', headline: 'an oversized handoff', now: big, next: big,
    });
    ok(saved && saved.ok === true, 'CONTROL: an over-budget handoff is SAVED (trimmed), not refused',
      JSON.stringify(saved && (saved.error || saved.reason)));
    const idx = await GET('/alpha/budget');
    eq(idx.body.stateBudgetBytes, store.MAX_STATE_BYTES, 'the detail envelope carries stateBudgetBytes = MAX_STATE_BYTES');
    eq(idx.body.stateBudgetBytes, 48 * 1024, '…which is 48 KB');
    const rows = Array.isArray(idx.body.scopes) ? idx.body.scopes : [];
    ok(rows.length > 0 && rows.every((r) => Number.isInteger(r.bytes) && r.bytes <= idx.body.stateBudgetBytes),
      'every handoff’s bytes sits at or under it — the ceiling cannot be overrun, so no bar here may turn danger',
      JSON.stringify(rows.map((r) => r.bytes)));
    const opened = await GET('/alpha/budget?open=newest');
    eq(opened.body.open && opened.body.open.stateBudgetBytes, store.MAX_STATE_BYTES,
      '`open` carries it too — it is byte-for-byte the scoped answer, which carries it');
    const scoped = await GET('/alpha/budget?scope=big');
    eq(scoped.body.stateBudgetBytes, store.MAX_STATE_BYTES, 'the scoped request carries it');
    const own = await GET('/alpha/alpha');
    eq(own.body.stateBudgetBytes, store.MAX_STATE_BYTES, 'a project with NO handoff still states its budget (a constant, never null)');
    const meter = await GET('/alpha/budget/capture');
    ok(!('stateBudgetBytes' in meter.body), 'the capture meter’s pinned envelope does NOT gain it');
  }
} finally {
  await new Promise((r) => server.close(r));
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) console.log('✅ The capture route’s contract, guards and cost all hold');
process.exit(failed > 0 ? 1 : 0);
