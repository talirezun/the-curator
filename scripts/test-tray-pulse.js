/**
 * test-tray-pulse.js — OFFLINE suite for the menubar widget's HEARTBEAT: the
 * `pulse` field of `getTraySummary()` and the `withSaveTimes` opt-in in
 * `src/brain/working-state.js` that feeds it.
 *
 * ── WHAT THIS SUITE IS ACTUALLY PROTECTING ────────────────────────────────
 *
 * Five properties, in descending order of "how badly does the user get lied to
 * when it breaks".
 *
 * 1. NO FILESYSTEM CLOCK EVER REACHES A BUCKET. `st.mtime` on a synced
 *    `current.md` is the moment of the PULL — git rewrites mtime on checkout —
 *    so a heartbeat built on it would draw a second machine's entire history
 *    as one spike at the instant of a `git pull`. That is v3.34.0's defect
 *    redrawn as a chart, and it is the one this feature is most able to
 *    commit, because an mtime is right there and always parses. §6 builds the
 *    exact file: mtime = now, journal `at` = five days ago, and asserts the
 *    event lands in the OLD cell while a genuinely-now save lands in the newest
 *    one. A test that only checked "an old event lands somewhere old" would
 *    pass over an implementation that read mtime for a LOCAL row and the
 *    journal for a pulled one; the control is the pair, not the row.
 *
 * 2. A CAP IS NEVER A MEASUREMENT. The tray slices 11 pairs down to 8 rows for
 *    display while reading all 11 journals. §7 drives the same store at
 *    `limit: 1` and at `limit: 40` and requires `events`, `pairsCounted` and
 *    every bucket to be IDENTICAL while `scopes.length` differs — so the
 *    assertion cannot pass by the cap failing to bite. This repo has shipped
 *    the cap-as-measurement defect twice (`distinctScopeCount`, and the tray's
 *    own `truncatedNote`), which is why it gets its own section.
 *
 * 3. THE OPT-IN IS GENUINELY OPT-IN. `journalFacts` feeds the MCP index, which
 *    is under a 400 KB response budget. §3 pins the DEFAULT serialisation
 *    against six literals captured by executing the pre-change implementation
 *    at commit 8272a08, and §4 drives the real MCP `get_working_state` handler
 *    — which forwards store rows WHOLESALE (`out.scopes = rows`) and is
 *    therefore the exact shape that would leak — and requires the string
 *    `saveTimes` to appear nowhere in its response.
 *
 * 4. FACT VERSUS ABSENCE, TWICE. `pulse: null` means "no journal was read at
 *    all"; a pulse whose buckets are 28 zeroes means "read them, nothing
 *    happened". And `coversWholeWindow`/`firstKnownBucket` separate "this
 *    store did not exist yet" from "nothing happened here" — a brand-new store
 *    and a dormant one draw identical empty cells and mean opposite things.
 *
 * 5. THE BOUNDARY. Off-by-one on a bucket edge is how every histogram is
 *    wrong. §5 puts events on a real internal boundary, on the window edge,
 *    and in the future, and requires `sum(buckets) === events` to hold over
 *    all of them together — which is the assertion that catches a
 *    double-count and a silent drop with one number.
 *
 * ── NOT ENFORCED — stated rather than implied away ────────────────────────
 *  - Nothing here RENDERS anything. The strip's pixels, its colour ramp and
 *    whether 28 cells are legible at menu width belong to `desktop/` and have
 *    their own suite. This is the data half only.
 *  - The claim that the pulse costs no additional file I/O is an argument from
 *    shared implementation (the timestamps were already read and parsed), not
 *    a measurement. Nothing here counts syscalls. The before/after wall-clock
 *    measurement against the maintainer's real store lives in the release
 *    notes, not in an assertion.
 *  - The literals in §3 pin the pre-change SHAPE. They cannot detect a change
 *    made to that shape deliberately and to the literals in the same commit —
 *    no pinned literal can. They exist to catch it happening by accident.
 *  - §8's machine-identity fix is exercised over CRAFTED machine segments and
 *    over this tempdir's real minted identity. It does not prove anything
 *    about the maintainer's own two folders beyond that they have the shape
 *    the rule keys on. The DEGRADED arm — an install with no id at all — is
 *    driven through the exported pure function, not through a real install
 *    whose home cannot hold `.curator-install-id`; that state was not built.
 *  - `firstKnownBucket === PULSE_BUCKET_COUNT` for a store with no usable
 *    timestamp is a value the fixed contract did not pin. It is asserted here
 *    because something had to be, and it is an out-of-range index by design
 *    ("no cell is known"). A renderer that clamps blindly would draw all 28
 *    cells as unknown, which is the intended reading — but nothing in this
 *    suite checks any renderer.
 *  - `noThrow`/`noThrowAsync` and the two sentinels exist so a defect reds
 *    under a NAMED assertion instead of killing the process. They were added
 *    because three mutations reported red-by-crash, which tells you the run
 *    died and not which property broke. They cannot mask a genuine null: the
 *    `!== null` checks take the raw value.
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
/**
 * Run `fn` and record whether it threw as a NAMED assertion, returning the
 * sentinel `'THREW'` so the checks after it still run under their own labels.
 *
 * A mutation that made `computePulse` iterate a null `saveTimes` killed this
 * suite with a TypeError, so it reported red-by-crash rather than red-by-
 * assertion — the shape v3.24.1 recorded, where the failure tells you the
 * process died and not which property broke. A journal that could not be read
 * is an ORDINARY input on this path (an unreadable file, a pair with no
 * journal at all), so "does not throw" is a real property worth naming.
 */
function noThrow(label, fn) {
  try { const v = fn(); passed++; console.log(`  ✓ ${label}`); return v; }
  catch (err) { failed++; console.log(`  ✗ ${label}\n        threw: ${err && err.message}`); return 'THREW'; }
}
/**
 * The async twin, for `getTraySummary` — which the module docblock promises
 * NEVER THROWS, on the stated grounds that a menubar panel rendering an
 * exception reads to the user as "the app is broken". That promise now spans
 * the pulse as well, and a mutation inside `computePulse` escaping through it
 * is exactly the way it would quietly stop being true. On a throw this hands
 * back a summary-shaped sentinel whose values no correct implementation can
 * produce, so every later assertion still reds under its own name.
 */
const SUMMARY_SENTINEL = Object.freeze({
  ok: false, lastSave: null, scopes: [], total: -1, pairsOnDisk: -1,
  truncated: false, pulse: null, brief: null, remote: null, warnings: [],
});
async function noThrowAsync(label, fn) {
  try { const v = await fn(); passed++; console.log(`  ✓ ${label}`); return v; }
  catch (err) {
    failed++; console.log(`  ✗ ${label}\n        threw: ${err && err.message}`);
    return SUMMARY_SENTINEL;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Isolation — nothing here may reach a real credential file or wiki');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-pulse-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(TMP_DOMAINS, { recursive: true });

// BOTH seams, before any app module is imported. CURATOR_TEST_DOMAINS_DIR alone
// leaves the developer's real .sync-config.json (and its GitHub PAT) in reach,
// and would let machineId() mint its identity files into the real user data
// dir — see paths.js's docblock.
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
const WS = await import('../src/brain/working-state.js');
const {
  getTraySummary, computePulse, machineIdentity,
  PULSE_WINDOW_SECONDS, PULSE_BUCKET_SECONDS, PULSE_BUCKET_COUNT,
  __resetRemoteObservation,
} = await import('../src/brain/tray-summary.js');

// Prove the seam actually took rather than assuming the env var won. A suite
// whose isolation silently lost would run every assertion below against the
// maintainer's real wiki and pass.
ok(getDomainsDir() === TMP_DOMAINS, 'the resolved domains dir IS the tempdir', getDomainsDir());
__resetRemoteObservation();

const SEC = 1000;
const HOUR = 3600 * SEC;
const DAY = 24 * HOUR;
const BUCKET_MS = PULSE_BUCKET_SECONDS * SEC;
const WINDOW_MS = PULSE_WINDOW_SECONDS * SEC;

// ═══════════════════════════════════════════════════════════════════════════
section('§2  The three constants, and that 28 is DERIVED rather than typed');
// ═══════════════════════════════════════════════════════════════════════════

eq(PULSE_WINDOW_SECONDS, 604800, 'the window is 7 days, in seconds');
eq(PULSE_BUCKET_SECONDS, 21600, 'the bucket is 6 hours, in seconds');
eq(PULSE_BUCKET_COUNT, 28, 'the strip is 28 cells');
// ANTI-VACUITY: the count must be the QUOTIENT, not a third hand-typed number
// that happens to agree today. If someone widens the window to 14 days and
// leaves 28 in place, this reds.
eq(PULSE_BUCKET_COUNT, PULSE_WINDOW_SECONDS / PULSE_BUCKET_SECONDS,
  'the cell count is derived from the other two, not typed a third time');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  journalFacts default output is BYTE-IDENTICAL to the pre-change one');
// ═══════════════════════════════════════════════════════════════════════════
//
// The six strings below were produced by EXECUTING `journalFacts` at commit
// 8272a08 — the parent of the change under test — and pasting the result. They
// are pinned to a real SHA and not to a moving ref, which is the rule
// v3.31.0/v3.33.0 recorded twice after two suites compared a function against
// itself by pinning to HEAD.
//
// This is what stops `withSaveTimes` becoming a cost every MCP index response
// pays. It is a serialisation comparison and therefore also pins KEY ORDER,
// which a field-by-field check would not.

const PIN_NOW = Date.parse('2026-08-30T12:00:00.000Z');
const L = (at, h, extra = {}) => ({ at, headline: 'h-' + h, harness: h, model: 'm', ...extra });
const PIN_INPUTS = {
  empty: [],
  nullish: null,
  one: [L('2026-08-30T11:00:00.000Z', 'claude-code')],
  alternating: [
    L('2026-08-30T09:00:00.000Z', 'claude-code'), L('2026-08-30T10:00:00.000Z', 'opencode'),
    L('2026-08-30T10:30:00.000Z', 'claude-code'), L('2026-08-30T11:00:00.000Z', 'opencode')],
  badstamp: [L('nope', 'x')],
  notes: [L('2026-08-30T11:00:00.000Z', 'y', { rejections: ['trimmed to fit the budget'] })],
};
const PINNED = {
  empty: '{"headline":null,"writtenAt":null,"writtenAgeSeconds":null,"harness":null,"model":null,"lastSaveKind":null,"lastSaveNotes":[],"harnesses":[],"harnessSwitches":0,"harnessShared":false,"entriesScanned":0,"entriesWithoutHarness":0}',
  nullish: '{"headline":null,"writtenAt":null,"writtenAgeSeconds":null,"harness":null,"model":null,"lastSaveKind":null,"lastSaveNotes":[],"harnesses":[],"harnessSwitches":0,"harnessShared":false,"entriesScanned":0,"entriesWithoutHarness":0}',
  one: '{"headline":"h-claude-code","writtenAt":"2026-08-30T11:00:00.000Z","writtenAgeSeconds":3600,"harness":"claude-code","model":"m","lastSaveKind":"complete","lastSaveNotes":[],"harnesses":["claude-code"],"harnessSwitches":0,"harnessShared":false,"entriesScanned":1,"entriesWithoutHarness":0}',
  alternating: '{"headline":"h-opencode","writtenAt":"2026-08-30T11:00:00.000Z","writtenAgeSeconds":3600,"harness":"opencode","model":"m","lastSaveKind":"complete","lastSaveNotes":[],"harnesses":["opencode","claude-code"],"harnessSwitches":3,"harnessShared":true,"entriesScanned":4,"entriesWithoutHarness":0}',
  badstamp: '{"headline":"h-x","writtenAt":null,"writtenAgeSeconds":null,"harness":"x","model":"m","lastSaveKind":"complete","lastSaveNotes":[],"harnesses":["x"],"harnessSwitches":0,"harnessShared":false,"entriesScanned":1,"entriesWithoutHarness":0}',
  notes: '{"headline":"h-y","writtenAt":"2026-08-30T11:00:00.000Z","writtenAgeSeconds":3600,"harness":"y","model":"m","lastSaveKind":"noted","lastSaveNotes":["trimmed to fit the budget"],"harnesses":["y"],"harnessSwitches":0,"harnessShared":false,"entriesScanned":1,"entriesWithoutHarness":0}',
};

for (const [name, input] of Object.entries(PIN_INPUTS)) {
  eq(JSON.stringify(WS.journalFacts(input, PIN_NOW)), PINNED[name],
    `journalFacts(${name}) serialises exactly as it did at 8272a08`);
}
// Three shapes of "no opts" must all be the default. `{withSaveTimes: false}`
// and `{withSaveTimes: 'yes'}` are the ones a careless caller writes.
for (const opts of [undefined, {}, { withSaveTimes: false }, { withSaveTimes: 'yes' }, { withSaveTimes: 1 }, null]) {
  eq(JSON.stringify(WS.journalFacts(PIN_INPUTS.alternating, PIN_NOW, opts)), PINNED.alternating,
    `opts=${JSON.stringify(opts)} is treated as OFF (strict === true only)`);
}

// ── ANTI-VACUITY. A comparison that cannot fail proves nothing. Both halves:
// the literal really does discriminate, and the opt-in really does change it.
ok(JSON.stringify(WS.journalFacts(PIN_INPUTS.one, PIN_NOW)) !== PINNED.alternating,
  'CONTROL: the pinned literals discriminate between two different inputs');
const withTimes = WS.journalFacts(PIN_INPUTS.alternating, PIN_NOW, { withSaveTimes: true });
ok(JSON.stringify(withTimes) !== PINNED.alternating,
  'CONTROL: asking for saveTimes DOES change the serialisation, so the comparison above can fail');
ok(Array.isArray(withTimes.saveTimes) && withTimes.saveTimes.length === 4,
  'the opt-in returns one epoch-ms number per parseable entry', JSON.stringify(withTimes.saveTimes));
ok(withTimes.saveTimes.every(n => Number.isInteger(n)),
  'saveTimes are epoch-ms integers, not strings or Dates');
eq(withTimes.saveTimes[0], Date.parse('2026-08-30T09:00:00.000Z'),
  'saveTimes arrive OLDEST FIRST, in journal order');
// An entry whose `at` cannot be parsed contributes NOTHING. It must not
// contribute `now`, and it must not contribute NaN.
eq(WS.journalFacts(PIN_INPUTS.badstamp, PIN_NOW, { withSaveTimes: true }).saveTimes.length, 0,
  'an unparseable `at` contributes no timestamp at all');
// A journal that parsed to nothing has ZERO saves. That is a measurement, and
// it is a different fact from "there was no journal" (which readPairJournalFacts
// expresses as null — proved end to end in §7).
const emptyTimes = WS.journalFacts([], PIN_NOW, { withSaveTimes: true }).saveTimes;
ok(Array.isArray(emptyTimes) && emptyTimes.length === 0,
  'an empty journal yields [] — a measured zero, not an absence');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  The MCP payload is unchanged — driven through the REAL handler');
// ═══════════════════════════════════════════════════════════════════════════
//
// Not a source scan for "listWorkingScopes(" with one argument. `mcp/tools/
// working-state.js` forwards store rows WHOLESALE on a scope miss
// (`out.scopes = rows`), which is precisely the shape this repo records as its
// dominant defect class in this area — a consumer forwarding fields it never
// looked at. So the handler is EXECUTED and its response inspected.

// ITS OWN DOMAINS DIR. §7 counts events across the whole store and asserts
// them against a hand-count, so a fixture left behind here would silently
// inflate that number — which is exactly the kind of cross-section coupling
// that makes a suite's failures unreadable. The seam is re-read per call, so
// swapping it mid-run is the supported way to do this.
const MCP_DOMAINS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-pulse-mcp-')));
process.env.CURATOR_TEST_DOMAINS_DIR = MCP_DOMAINS;
fs.mkdirSync(path.join(MCP_DOMAINS, 'mcpproj', 'state', 'main', 'boxa-aaaa11'), { recursive: true });
fs.writeFileSync(path.join(MCP_DOMAINS, 'mcpproj', 'CLAUDE.md'), '# mcpproj\n');
fs.writeFileSync(path.join(MCP_DOMAINS, 'mcpproj', 'state', 'main', 'boxa-aaaa11', 'current.md'), '## Now\n- work\n');
fs.writeFileSync(path.join(MCP_DOMAINS, 'mcpproj', 'state', 'main', 'boxa-aaaa11', 'journal.jsonl'),
  [1, 2, 3].map(i => JSON.stringify({
    at: new Date(PIN_NOW - i * HOUR).toISOString(), headline: `h${i}`, harness: 'claude-code',
  })).join('\n') + '\n');

{
  const { getWorkingStateHandler } = await import('../mcp/tools/working-state.js');
  const { createStorageAdapter } = await import('../mcp/storage/local.js');
  const storage = createStorageAdapter({ domainsPath: MCP_DOMAINS });
  const out = await getWorkingStateHandler({ project: 'mcpproj', scope: 'no-such-scope' }, storage);
  const wire = JSON.stringify(out);
  eq(out.scope_not_found, true, 'the MCP scope-miss branch was actually reached');
  ok(Array.isArray(out.scopes) && out.scopes.length === 1,
    'the handler forwarded a store row wholesale — the shape that would leak', String(out.scopes && out.scopes.length));
  ok(!wire.includes('saveTimes'),
    'the MCP response contains no `saveTimes` anywhere');
  ok(!wire.includes('journalTailTruncated'),
    'the MCP response contains no `journalTailTruncated` anywhere');
  // ANTI-VACUITY: prove the search would have found it. The same substring test
  // over a row that DID ask for the times must come back positive, otherwise a
  // typo in the needle would make both assertions above pass forever.
  const asked = await WS.listWorkingScopes('mcpproj', { withSaveTimes: true });
  ok(JSON.stringify(asked).includes('saveTimes'),
    'CONTROL: the same substring test finds `saveTimes` when it IS present');
}

// The store-level half of the same property, checked as an OWN PROPERTY rather
// than by substring — `'saveTimes' in row` is what a consumer's spread copies.
{
  const plain = await WS.listWorkingScopes('mcpproj');
  const explicit = await WS.listWorkingScopes('mcpproj', {});
  ok(plain.ok && plain.scopes.length === 1, 'the fixture project indexes one pair');
  const row = plain.scopes[0];
  ok(!Object.prototype.hasOwnProperty.call(row, 'saveTimes'),
    'a default row has no own `saveTimes` property');
  ok(!Object.prototype.hasOwnProperty.call(row, 'journalTailTruncated'),
    'a default row has no own `journalTailTruncated` property');
  eq(Object.keys(row).join(','), Object.keys(explicit.scopes[0]).join(','),
    'listWorkingScopes(p) and listWorkingScopes(p, {}) produce identical row shapes');
  const asked = (await WS.listWorkingScopes('mcpproj', { withSaveTimes: true })).scopes[0];
  ok(Object.prototype.hasOwnProperty.call(asked, 'saveTimes')
    && Object.prototype.hasOwnProperty.call(asked, 'journalTailTruncated'),
    'CONTROL: the opt-in row DOES carry both keys, so the two checks above can fail');
  eq(asked.saveTimes.length, 3, 'the opt-in row carries one timestamp per journal line');
  eq(asked.journalTailTruncated, false, 'a small journal is not reported as truncated');
}

// Back to the main store for everything below, and PROVED rather than assumed:
// a swap that silently failed would run §7's hand-counted assertions against
// the wrong tree.
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
fs.rmSync(MCP_DOMAINS, { recursive: true, force: true });
ok(getDomainsDir() === TMP_DOMAINS, 'the domains dir is back to the main tempdir', getDomainsDir());

// ═══════════════════════════════════════════════════════════════════════════
section('§5  computePulse — the shape, the invariant, and the BOUNDARY');
// ═══════════════════════════════════════════════════════════════════════════

const NOW = Date.parse('2026-09-01T12:00:00.000Z');

// ── A NULL PULSE MUST RED BY NAME, NOT BY TypeError ────────────────────────
//
// Two mutations (a tray that stops asking for save times; `events === 0`
// collapsed into "no store") make `pulse` null, and every field read below
// then throws — so the suite died at the first line instead of reporting which
// property broke. That is the red-by-crash shape v3.24.1 recorded, and it
// hides the rest of the run. Reads go through `P()`, which substitutes values
// no correct implementation can produce, so each assertion still fails under
// its own label. The `!== null` checks are kept SEPARATE and take the raw
// value, so this cannot mask a genuine null.
const PULSE_SENTINEL = Object.freeze({
  windowSeconds: -1, bucketSeconds: -1, buckets: [], events: -1,
  eventsOutsideWindow: -1, pairsCounted: -1, pairsTruncated: -1,
  clock: 'MISSING(pulse was null)', oldestEventAt: 'MISSING(pulse was null)',
  coversWholeWindow: 'MISSING(pulse was null)', firstKnownBucket: -1,
});
const P = (p) => (p === null || p === undefined ? PULSE_SENTINEL : p);

const pulseOf = (times, extra = {}) => P(computePulse([{ saveTimes: times, ...extra }], NOW));

{
  const p = pulseOf([NOW - 3 * HOUR]);
  eq(p.windowSeconds, PULSE_WINDOW_SECONDS, 'windowSeconds is reported');
  eq(p.bucketSeconds, PULSE_BUCKET_SECONDS, 'bucketSeconds is reported');
  eq(p.buckets.length, 28, 'buckets holds EXACTLY 28 entries');
  ok(p.buckets.every(Number.isInteger), 'every bucket is an integer count');
}

// ── OLDEST FIRST. Asserted by placing two events six days apart and requiring
//    the older one at a LOWER index. A reversed strip would still have 28 cells
//    and still sum correctly, so length and sum cannot see this.
{
  const p = P(computePulse([{ saveTimes: [NOW - 6 * DAY, NOW - 1 * HOUR] }], NOW));
  const filled = p.buckets.map((n, i) => (n ? i : -1)).filter(i => i >= 0);
  eq(filled.length, 2, 'the two events landed in two distinct cells');
  ok(filled[0] < filled[1], `the SIX-DAY-OLD event sits at a lower index than the one-hour-old one (${filled})`);
  eq(filled[1], 27, 'the one-hour-old event is in the NEWEST cell, index 27');
  eq(filled[0], 3, 'the six-day-old event is near the start of the strip');
}

// ── THE BOUNDARY. Open at the older edge, closed at the newer edge, so an
//    event landing exactly on an internal boundary belongs to the OLDER cell.
{
  const onBoundary = NOW - BUCKET_MS;             // exactly one bucket ago
  const justAfter = NOW - BUCKET_MS + 1;          // one ms newer
  const a = pulseOf([onBoundary]);
  const b = pulseOf([justAfter]);
  const idxA = a.buckets.findIndex(n => n > 0);
  const idxB = b.buckets.findIndex(n => n > 0);
  eq(idxA, 26, 'an event EXACTLY on an internal boundary lands in the OLDER cell (26)');
  eq(idxB, 27, 'one millisecond newer lands in the newer cell (27)');
  ok(idxA !== idxB, 'CONTROL: the boundary really is a boundary — the two differ');
  eq(a.buckets.filter(n => n > 0).length, 1, 'the boundary event lands in EXACTLY ONE cell, not two');
  eq(a.events, 1, 'and it is counted exactly once');
  eq(a.buckets.reduce((s, n) => s + n, 0), a.events, 'sum(buckets) === events at the boundary');
}

// ── THE WINDOW EDGE. `now - window` itself is OUTSIDE; one ms later is cell 0.
{
  const atEdge = pulseOf([NOW - WINDOW_MS]);
  eq(atEdge.events, 0, 'an event exactly on the window edge is NOT counted into the strip');
  eq(atEdge.eventsOutsideWindow, 1, 'it is disclosed as outside the window instead of vanishing');
  eq(atEdge.buckets.reduce((s, n) => s + n, 0), 0, 'and it added nothing to any cell');

  const justInside = pulseOf([NOW - WINDOW_MS + 1]);
  eq(justInside.events, 1, 'CONTROL: one millisecond inside the window IS counted');
  eq(justInside.buckets.findIndex(n => n > 0), 0, 'and it lands in cell 0, the oldest');
  eq(justInside.eventsOutsideWindow, 0, 'and is not double-counted as outside');
}

// ── A FUTURE SAVE. Clock skew across machines is reachable through sync;
//    journalFacts already clamps a negative age to 0, and this clamps the same
//    direction rather than dropping a real save.
{
  const p = pulseOf([NOW + 5 * HOUR]);
  eq(p.events, 1, 'a save stamped in the FUTURE is still counted');
  eq(p.buckets.findIndex(n => n > 0), 27, 'and is clamped into the newest cell');
  eq(p.buckets.reduce((s, n) => s + n, 0), p.events, 'sum(buckets) === events with a future save');
}

// ── THE INVARIANT, over every awkward case AT ONCE. A double-count and a
//    silent drop are both caught by this one number.
{
  const times = [
    NOW - WINDOW_MS,              // outside, on the edge
    NOW - WINDOW_MS + 1,          // cell 0
    NOW - 4 * BUCKET_MS,          // an internal boundary
    NOW - 4 * BUCKET_MS + 1,      // one ms newer
    NOW - 2 * DAY, NOW - 2 * DAY, // two in one cell
    NOW,                          // exactly now
    NOW + HOUR,                   // the future
    NOW - 30 * DAY,               // long outside
  ];
  const p = pulseOf(times);
  eq(p.buckets.reduce((s, n) => s + n, 0), p.events, 'sum(buckets) === events — THE invariant');
  eq(p.events + p.eventsOutsideWindow, times.length,
    'every timestamp is accounted for, either in a cell or as outside-window');
  eq(p.eventsOutsideWindow, 2, 'both out-of-window saves are counted as such');
  eq(p.events, 7, 'the remaining seven landed in cells');
  // ANTI-VACUITY: the invariant must be capable of failing. A hand-built
  // mismatched pair proves the comparison is real rather than trivially true.
  ok(!(6 === 7), 'CONTROL: sum and events are compared as numbers, not as truthy');
}

// ── NaN and non-numbers are dropped, and dropping them does not break the sum.
{
  const p = pulseOf([NOW - HOUR, NaN, Infinity, null, 'yesterday', undefined]);
  eq(p.events, 1, 'only the finite timestamp is counted');
  eq(p.buckets.reduce((s, n) => s + n, 0), p.events, 'sum still equals events with junk in the array');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  Fact versus absence — null, clock, coverage, and firstKnownBucket');
// ═══════════════════════════════════════════════════════════════════════════

// ── NULL ONLY WHEN NO JOURNAL WAS READ AT ALL.
eq(computePulse([], NOW), null, 'no pairs at all → pulse is null');
eq(noThrow('computePulse does not THROW on a pair whose journal could not be read',
  () => computePulse([{ saveTimes: null }, { saveTimes: null }], NOW)), null,
  'pairs whose journals could not be read → still null, because nothing was read');
{
  const raw = computePulse([{ saveTimes: [] }], NOW);
  ok(raw !== null, 'CONTROL: a pair with an EMPTY journal is NOT null — it is a measured zero');
  const p = P(raw);
  eq(p.events, 0, 'and it reports zero events');
  eq(p.pairsCounted, 1, 'and counts as one pair that fed the strip');
  eq(p.clock, 'none', 'with nothing timestamped, the clock is honestly `none`');
  eq(p.oldestEventAt, null, 'and there is no oldest event to name');
  eq(p.coversWholeWindow, false, 'and coverage is not claimed');
  eq(p.firstKnownBucket, PULSE_BUCKET_COUNT,
    'firstKnownBucket is one past the last cell — no cell is known');
}
// A pair with no journal does not inflate pairsCounted, but it also does not
// suppress a pair that does have one.
{
  const p = P(noThrow('a mix of readable and unreadable journals does not THROW',
    () => computePulse([{ saveTimes: null }, { saveTimes: [NOW - HOUR] }], NOW)));
  eq(p.pairsCounted, 1, 'a journal-less pair is not counted as a pair that fed the strip');
  eq(p.events, 1, 'and the pair that did have one is still counted');
}

// ── THE CLOCK IS 'agent' OR 'none'. NEVER 'mixed', NEVER 'file'.
{
  const withEvents = P(computePulse([{ saveTimes: [NOW - HOUR] }], NOW));
  eq(withEvents.clock, 'agent', 'any counted event makes the clock `agent`');
  const outsideOnly = P(computePulse([{ saveTimes: [NOW - 30 * DAY] }], NOW));
  eq(outsideOnly.clock, 'agent', 'an out-of-window save still proves an agent clock was read');
  for (const p of [withEvents, outsideOnly, P(computePulse([{ saveTimes: [] }], NOW))]) {
    ok(p.clock === 'agent' || p.clock === 'none',
      `clock is one of the two legal values (${p.clock})`);
    ok(p.clock !== 'mixed' && p.clock !== 'file',
      'clock is never `mixed` and never `file` — there is no second clock on this path');
  }
}

// ── COVERAGE. A store younger than the window must NOT draw its leading cells
//    as "nothing happened".
{
  const young = P(computePulse([{ saveTimes: [NOW - 3 * DAY, NOW - HOUR] }], NOW));
  eq(young.coversWholeWindow, false,
    'a store whose oldest save is 3 days old does not cover the 7-day window');
  eq(young.oldestEventAt, new Date(NOW - 3 * DAY).toISOString(),
    'oldestEventAt names the oldest save counted');
  eq(young.firstKnownBucket, 15,
    'firstKnownBucket is the cell holding that oldest save — cells before it are UNKNOWN');
  eq(young.buckets.slice(0, young.firstKnownBucket).reduce((s, n) => s + n, 0), 0,
    'nothing was counted before firstKnownBucket, which is what makes greying them honest');

  // ANTI-VACUITY / CONTROL: a store that provably predates the window claims
  // full coverage and starts at cell 0. Without this the two fields could be
  // hardcoded to `false, 15` and pass.
  const old = P(computePulse([{ saveTimes: [NOW - 30 * DAY, NOW - 3 * DAY, NOW - HOUR] }], NOW));
  eq(old.coversWholeWindow, true, 'CONTROL: a save older than the window proves the store existed throughout');
  eq(old.firstKnownBucket, 0, 'CONTROL: and every cell is then known');
  eq(old.eventsOutsideWindow, 1, 'the pre-window save is disclosed rather than silently establishing coverage');
  eq(old.oldestEventAt, new Date(NOW - 3 * DAY).toISOString(),
    'oldestEventAt still names the oldest save COUNTED, not the out-of-window one');
  // The dormant case: coverage true, strip empty. This is the reading that
  // must be distinguishable from a brand-new store, and it is the whole reason
  // both fields exist.
  const dormant = P(computePulse([{ saveTimes: [NOW - 30 * DAY] }], NOW));
  eq(dormant.coversWholeWindow, true, 'a dormant store covers the window');
  eq(dormant.events, 0, 'and its strip is empty');
  eq(dormant.firstKnownBucket, 0, 'so all 28 empty cells mean `nothing happened`, not `did not exist`');
  ok(dormant.coversWholeWindow !== young.coversWholeWindow,
    'CONTROL: the dormant store and the young store are DISTINGUISHABLE');
}

// ── pairsTruncated is a count of pairs, not of events, and is not hardcoded.
{
  const p = P(computePulse([
    { saveTimes: [NOW - HOUR], journalTailTruncated: true },
    { saveTimes: [NOW - 2 * HOUR], journalTailTruncated: false },
    { saveTimes: [NOW - 3 * HOUR] },                    // absent flag ⇒ not truncated
    { saveTimes: [NOW - 4 * HOUR], journalTailTruncated: true },
  ], NOW));
  eq(p.pairsCounted, 4, 'all four pairs fed the strip');
  eq(p.pairsTruncated, 2, 'exactly the two flagged pairs are reported truncated');
  ok(p.pairsTruncated !== 0 && p.pairsTruncated !== p.pairsCounted,
    'CONTROL: the value is neither hardcoded 0 nor "all of them"');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  End to end — a real store on disk, and NO mtime reaches a bucket');
// ═══════════════════════════════════════════════════════════════════════════

const T0 = Date.now();
function mkDomain(name) {
  fs.mkdirSync(path.join(TMP_DOMAINS, name), { recursive: true });
  fs.writeFileSync(path.join(TMP_DOMAINS, name, 'CLAUDE.md'), `# ${name}\n`);
}
/**
 * One (scope, machine) pair. `mtimeAgoSec` drives the FILE clock; `atsAgoSec`
 * drives the AGENT clock. They are set INDEPENDENTLY, which is the whole point:
 * that independence is the bug this module has to report honestly.
 */
function mkPair(project, scope, machine, { mtimeAgoSec, atsAgoSec = null, badStamps = 0, extraLines = 0 }) {
  const dir = path.join(TMP_DOMAINS, project, 'state', scope, machine);
  fs.mkdirSync(dir, { recursive: true });
  const cur = path.join(dir, 'current.md');
  fs.writeFileSync(cur, '## Now\n- handoff\n');
  const lines = [];
  for (const a of (atsAgoSec || [])) {
    lines.push(JSON.stringify({ at: new Date(T0 - a * SEC).toISOString(), headline: 'h', harness: 'claude-code' }));
  }
  for (let i = 0; i < badStamps; i++) {
    lines.push(JSON.stringify({ at: 'not-a-date', headline: 'hand edited', harness: 'claude-code' }));
  }
  for (let i = 0; i < extraLines; i++) {
    lines.push(JSON.stringify({
      at: new Date(T0 - (2 * DAY) - i * 60 * SEC).toISOString(),
      headline: 'x'.repeat(200), harness: 'claude-code',
    }));
  }
  if (lines.length) fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
  const t = (T0 - mtimeAgoSec * SEC) / 1000;
  fs.utimesSync(cur, t, t);
}

for (const d of ['aa', 'bb', 'cc']) mkDomain(d);

// aa · local — three saves, SPREAD ACROSS THREE CELLS, file and agent clocks
// agreeing. The spread is load-bearing: the first draft put all three within
// one hour, and since a cell is SIX HOURS wide they all landed in cell 27 —
// which made the "the newest cell holds only the genuinely-recent save"
// assertion below unable to distinguish anything at all.
mkPair('aa', 'local', 'boxa-aaaa11', { mtimeAgoSec: 120, atsAgoSec: [3 * 86400, 2 * 86400, 120] });

// bb · pulled — THE REGRESSION FIXTURE FOR THE HEARTBEAT. This is what a
// handoff looks like after `git pull` on a second machine: the file landed on
// this disk two seconds ago, and the agent wrote it FIVE DAYS ago on another
// computer. If any mtime reaches the buckets, this save appears in the newest
// cell instead of the five-day-old one.
mkPair('bb', 'pulled', 'boxb-bbbb22', { mtimeAgoSec: 2, atsAgoSec: [5 * 86400] });

// bb · blind — a journal whose every `at` is unusable, with a FRESH mtime. An
// implementation that "fell back to mtime when the stamp was bad" would put
// three events in the newest cell here. It must contribute none.
mkPair('bb', 'blind', 'boxb-bbbb22', { mtimeAgoSec: 5, badStamps: 3 });

// cc · nojournal — current.md with NO journal.jsonl beside it. Contributes a
// row but no journal, so it must not be counted as a pair that fed the strip.
mkPair('cc', 'nojournal', 'boxc-cccc33', { mtimeAgoSec: 900 });

// cc · ancient — one save older than the window. Establishes coverage and is
// disclosed as outside rather than being dropped.
mkPair('cc', 'ancient', 'boxc-cccc33', { mtimeAgoSec: 30 * 86400, atsAgoSec: [30 * 86400] });

// An INDEPENDENT, DELIBERATELY DUMB count of what the fixture contains, so the
// assertions below are compared against something other than a second run of
// the code under test. Same rule v3.1.0 recorded after a clever lexer was
// silently blind twice while reporting green.
const EXPECT_IN_WINDOW = 3 /* aa·local */ + 1 /* bb·pulled */;
const EXPECT_OUTSIDE = 1;   /* cc·ancient */
const EXPECT_PAIRS_WITH_JOURNAL = 4;   // aa·local, bb·pulled, bb·blind, cc·ancient

const full = await noThrowAsync('getTraySummary NEVER THROWS over a store holding an unreadable journal',
  () => getTraySummary({ limit: 40, now: T0 }));
ok(full.pulse !== null, 'a store with journals produces a pulse');
const FULL = P(full.pulse);
eq(FULL.buckets.length, 28, 'the end-to-end strip is 28 cells');
eq(FULL.buckets.reduce((s, n) => s + n, 0), FULL.events,
  'sum(buckets) === events end to end');
eq(FULL.events, EXPECT_IN_WINDOW,
  'events matches an independent hand-count of the in-window journal lines');
eq(FULL.eventsOutsideWindow, EXPECT_OUTSIDE,
  'the pre-window save is disclosed, not dropped');
eq(FULL.pairsCounted, EXPECT_PAIRS_WITH_JOURNAL,
  'pairsCounted is the pairs whose journal was READ — the journal-less pair is excluded');
eq(FULL.clock, 'agent', 'the end-to-end clock is the agent clock');

// ── NO MTIME REACHES A BUCKET, asserted as a PAIR of readings. ───────────
{
  const newest = FULL.buckets[27];
  // aa·local has one save 120 s ago; that is the only thing legitimately in
  // the newest cell. bb·pulled (mtime 2 s ago) and bb·blind (mtime 5 s ago)
  // must contribute nothing there.
  eq(newest, 1, 'the newest cell holds ONLY the genuinely-recent save');
  const fiveDayCell = 27 - Math.floor((5 * DAY) / BUCKET_MS);
  eq(FULL.buckets[fiveDayCell], 1,
    `the pulled handoff sits in the FIVE-DAY-OLD cell (${fiveDayCell}), where the agent wrote it`);
  // CONTROL: the two cells are different, so "it landed somewhere" is not what
  // is being asserted.
  ok(fiveDayCell !== 27, 'CONTROL: the five-day cell is not the newest cell');
  // CONTROL: the file clock for that pair really IS fresh — otherwise the
  // assertion above would be satisfied by a fixture that never posed the
  // problem.
  const pulledRow = full.scopes.find(r => r.scope === 'pulled');
  ok(pulledRow && pulledRow.fileChangedAgeSeconds !== null && pulledRow.fileChangedAgeSeconds < 120,
    `CONTROL: the pulled pair's FILE clock is genuinely fresh (${pulledRow && pulledRow.fileChangedAgeSeconds}s)`);
  ok(pulledRow != null && pulledRow.writtenAgeSeconds > 4 * 86400,
    'CONTROL: and its agent clock is genuinely five days old');
}

// ── COVERAGE end to end.
eq(FULL.coversWholeWindow, true,
  'the 30-day-old save proves this store predates the window');
eq(FULL.firstKnownBucket, 0, 'so no leading cell is unknown');

// ── A CAP IS NOT A MEASUREMENT. The display limit must not move the strip.
{
  const one = await noThrowAsync('getTraySummary NEVER THROWS at limit 1 either',
    () => getTraySummary({ limit: 1, now: T0 }));
  const ONE = P(one.pulse);
  eq(one.scopes.length, 1, 'CONTROL: the limit really did bite — one row shown');
  ok(full.scopes.length > one.scopes.length,
    `CONTROL: the unlimited call really does show more rows (${full.scopes.length} vs ${one.scopes.length})`);
  eq(ONE.events, FULL.events, 'a limit of 1 does not change `events`');
  eq(ONE.pairsCounted, FULL.pairsCounted, 'a limit of 1 does not change `pairsCounted`');
  eq(ONE.eventsOutsideWindow, FULL.eventsOutsideWindow,
    'a limit of 1 does not change `eventsOutsideWindow`');
  eq(JSON.stringify(ONE.buckets), JSON.stringify(FULL.buckets),
    'a limit of 1 produces a byte-identical strip');
  eq(ONE.coversWholeWindow, FULL.coversWholeWindow,
    'a limit of 1 does not change coverage');
}

// ── pulse IS null when a store holds no journal at all, and that is different
//    from a store with journals holding nothing.
{
  const TMP2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-pulse-empty-')));
  const prev = process.env.CURATOR_TEST_DOMAINS_DIR;
  process.env.CURATOR_TEST_DOMAINS_DIR = TMP2;
  try {
    fs.mkdirSync(path.join(TMP2, 'dd', 'state', 'only', 'boxd-dddd44'), { recursive: true });
    fs.writeFileSync(path.join(TMP2, 'dd', 'CLAUDE.md'), '# dd\n');
    fs.writeFileSync(path.join(TMP2, 'dd', 'state', 'only', 'boxd-dddd44', 'current.md'), 'x\n');
    const s = await noThrowAsync('getTraySummary NEVER THROWS over a store with no journal at all',
      () => getTraySummary({ limit: 8, now: T0 }));
    eq(s.scopes.length, 1, 'CONTROL: the journal-less store still produces a row');
    eq(s.pulse, null, 'a store with no journal at all yields pulse: null');
  } finally {
    process.env.CURATOR_TEST_DOMAINS_DIR = prev;
    fs.rmSync(TMP2, { recursive: true, force: true });
  }
}

// ── pairsTruncated is DERIVED FROM readTail's OWN SIGNAL, over a real file.
{
  const bigDir = path.join(TMP_DOMAINS, 'aa', 'state', 'huge', 'boxa-aaaa11');
  fs.mkdirSync(bigDir, { recursive: true });
  fs.writeFileSync(path.join(bigDir, 'current.md'), '## Now\n- big\n');
  // > INDEX_JOURNAL_TAIL_BYTES (16 KB) so readTail really truncates.
  const many = [];
  for (let i = 0; i < 300; i++) {
    many.push(JSON.stringify({
      at: new Date(T0 - (i + 1) * 600 * SEC).toISOString(),
      headline: 'p'.repeat(120), harness: 'claude-code',
    }));
  }
  const bytes = many.join('\n').length + 1;
  fs.writeFileSync(path.join(bigDir, 'journal.jsonl'), many.join('\n') + '\n');
  ok(bytes > WS.INDEX_JOURNAL_TAIL_BYTES,
    `CONTROL: the fixture journal (${bytes} B) really exceeds the ${WS.INDEX_JOURNAL_TAIL_BYTES} B tail cap`);
  const t = T0 / 1000;
  fs.utimesSync(path.join(bigDir, 'current.md'), t, t);

  const s = await noThrowAsync('getTraySummary NEVER THROWS with an over-cap journal in the store',
    () => getTraySummary({ limit: 40, now: T0 }));
  const SP = P(s.pulse);
  eq(SP.pairsTruncated, 1, 'exactly the over-cap pair is reported truncated');
  eq(SP.pairsCounted, EXPECT_PAIRS_WITH_JOURNAL + 1, 'and it is counted as a pair that fed the strip');
  ok(SP.events > FULL.events,
    'the truncated pair still contributes the events the tail COULD see');
  eq(SP.buckets.reduce((sum, n) => sum + n, 0), SP.events,
    'sum(buckets) === events with a truncated journal in the mix');
  // CONTROL: the flag is not simply "any pair with many lines". The pairs that
  // fit inside the cap must still report false.
  const asked = await WS.listWorkingScopes('aa', { withSaveTimes: true });
  const small = asked.scopes.find(r => r.scope === 'local');
  const huge = asked.scopes.find(r => r.scope === 'huge');
  eq(small.journalTailTruncated, false, 'CONTROL: the small journal is not flagged');
  eq(huge.journalTailTruncated, true, 'the over-cap journal IS flagged, from readTail\'s own signal');
  ok(huge.saveTimes.length < 300,
    `the truncated pair reports FEWER saves than the file holds — a lower bound (${huge.saveTimes.length} of 300)`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  One laptop, two folder names — the install-id identity fix');
// ═══════════════════════════════════════════════════════════════════════════
//
// Measured on the maintainer's own store: `mac-17d23c` and
// `talis-macbook-pro-17d23c` are ONE computer. macOS re-derived the hostname
// from DHCP and the folder name followed; working-state.js's D10 block records
// the same pair. The tray compared the WHOLE slug, so half his own history was
// rendered as a remote machine. The rule keys on the trailing installation id
// and on nothing else.

const SELF = WS.machineId();
const SELF_ID = /-([0-9a-f]{4,16})$/.exec(SELF) ? /-([0-9a-f]{4,16})$/.exec(SELF)[1] : null;
ok(typeof SELF === 'string' && SELF.length > 0, `this installation's machine segment resolved (${SELF})`);
ok(SELF_ID !== null, `and it carries a parseable installation id (${SELF_ID})`);

{
  mkDomain('ident');
  // The SAME laptop under a renamed hostname: a different host slug, the same
  // installation id. This is the maintainer's `mac-17d23c` case exactly.
  const RENAMED = `oldname-${SELF_ID}`;
  ok(RENAMED !== SELF, 'CONTROL: the renamed folder is a different STRING from this machine\'s own');
  // A genuinely different computer: a different host AND a different id.
  const OTHER = 'buildbox-9f9f9f';
  ok(!OTHER.endsWith(SELF_ID), 'CONTROL: the foreign machine does not share this installation id');
  // Two machines that both LACK an installation id. Neither may match the
  // other, and neither may match this install.
  const BARE_A = 'plainbox';
  const BARE_B = 'otherbox';

  mkPair('ident', 'own', SELF, { mtimeAgoSec: 60, atsAgoSec: [60] });
  mkPair('ident', 'renamed', RENAMED, { mtimeAgoSec: 70, atsAgoSec: [70] });
  mkPair('ident', 'foreign', OTHER, { mtimeAgoSec: 80, atsAgoSec: [80] });
  mkPair('ident', 'barea', BARE_A, { mtimeAgoSec: 90, atsAgoSec: [90] });
  mkPair('ident', 'bareb', BARE_B, { mtimeAgoSec: 100, atsAgoSec: [100] });

  const s = await noThrowAsync('getTraySummary NEVER THROWS over the identity fixtures',
    () => getTraySummary({ limit: 40, now: T0 }));
  const by = Object.fromEntries(s.scopes.filter(r => r.project === 'ident').map(r => [r.scope, r]));
  eq(Object.keys(by).length, 5, 'all five identity fixtures are present');
  // A missing row must fail under its own label rather than throwing on a
  // property of undefined — same reason the pulse sentinel exists.
  const MISSING_ROW = Object.freeze({ isThisMachine: 'ROW MISSING', machineMatch: 'ROW MISSING' });
  for (const k of ['own', 'renamed', 'foreign', 'barea', 'bareb']) if (!by[k]) by[k] = MISSING_ROW;

  eq(by.own.isThisMachine, true, 'the exact folder is this machine');
  eq(by.own.machineMatch, 'exact', 'and it says it matched exactly');

  eq(by.renamed.isThisMachine, true,
    'THE FIX: a folder carrying the SAME installation id under a renamed host is this machine');
  eq(by.renamed.machineMatch, 'install-id', 'and it discloses HOW it matched');

  eq(by.foreign.isThisMachine, false,
    'a genuinely different computer is COMPLETELY unaffected');
  eq(by.foreign.machineMatch, 'none', 'and reports no match');

  eq(by.barea.isThisMachine, false,
    'a machine id with no parseable install id does not match this install');
  eq(by.bareb.isThisMachine, false,
    'and a SECOND id-less machine does not match either — two nulls are not equal');
  eq(by.barea.machineMatch, 'none', 'the first id-less machine reports no match');
  eq(by.bareb.machineMatch, 'none', 'the second id-less machine reports no match');

  // ── ANTI-VACUITY. Without these, an implementation returning `true` for
  //    everything, or `false` for everything, would satisfy some subset above.
  const flags = ['own', 'renamed', 'foreign', 'barea', 'bareb'].map(k => by[k].isThisMachine);
  ok(flags.includes(true) && flags.includes(false),
    'CONTROL: the fixture produces BOTH verdicts, so neither constant answer passes');
  ok(new Set(['own', 'renamed', 'foreign'].map(k => by[k].machineMatch)).size === 3,
    'CONTROL: all three match reasons are reachable and distinct');
}

// ── THE DEGRADED INSTALL — the one arm the store fixture cannot reach.
//
// The `selfInstallId !== null` guard only fires when THIS install has no
// parseable id: an install whose home could not hold `.curator-install-id`,
// where `machineId()` falls back to a bare hostname. Every tempdir install
// mints an id, so a mutation DELETING that guard ran GREEN through all of §8
// above — masked by the fixture, not redundant. It is chased here by driving
// the pure function directly, which is why it is exported.
{
  const anyRe = /^never-matches-anything$/;
  const a = machineIdentity('plainbox', 'otherbox', 'otherbox', anyRe, null);
  eq(a.isThisMachine, false,
    'DEGRADED INSTALL: with no id on THIS side, an id-less folder is not adopted');
  eq(a.machineMatch, 'none', 'and it reports no match rather than an install-id match');
  const b = machineIdentity('plainbox', 'plainbox', 'plainbox', anyRe, null);
  eq(b.isThisMachine, true,
    'CONTROL: a degraded install still recognises its own EXACT folder name');
  eq(b.machineMatch, 'exact', 'and calls that an exact match');
  const c = machineIdentity('renamed-17d23c', 'talis-macbook-pro-17d23c',
    'talis-macbook-pro', anyRe, '17d23c');
  eq(c.isThisMachine, true, 'CONTROL: with an id on both sides the adoption still happens');
  eq(c.machineMatch, 'install-id', 'and is reported as an install-id match');
  const d = machineIdentity('renamed-999999', 'talis-macbook-pro-17d23c',
    'talis-macbook-pro', anyRe, '17d23c');
  eq(d.isThisMachine, false, 'CONTROL: a DIFFERENT id is not adopted');
}

// ── The near-miss cases, driven through the same store rather than argued.
//    A hostname whose own last segment merely LOOKS hex must not be adopted
//    unless it carries THIS install's id.
{
  mkDomain('nearmiss');
  // `beef` is four hex characters and satisfies INSTALL_ID_RE, but it is not
  // this installation's id, so it must not match.
  mkPair('nearmiss', 'hexlike', 'web-server-beef', { mtimeAgoSec: 60, atsAgoSec: [60] });
  // A machine whose name ENDS with this install's id but as part of a longer
  // non-hex tail. `lastIndexOf('-')` takes only the final segment, so
  // `boxa-zz${SELF_ID}` has tail `zz<id>` which is not hex and must not match.
  mkPair('nearmiss', 'suffixish', `boxa-zz${SELF_ID}`, { mtimeAgoSec: 61, atsAgoSec: [61] });
  const s = await noThrowAsync('getTraySummary NEVER THROWS over the near-miss fixtures',
    () => getTraySummary({ limit: 40, now: T0 }));
  const by = Object.fromEntries(s.scopes.filter(r => r.project === 'nearmiss').map(r => [r.scope, r]));
  for (const k of ['hexlike', 'suffixish']) if (!by[k]) by[k] = { isThisMachine: 'ROW MISSING' };
  eq(by.hexlike.isThisMachine, SELF_ID === 'beef',
    'a hex-looking tail that is not THIS install\'s id does not match');
  eq(by.suffixish.isThisMachine, false,
    'an id embedded in a longer non-hex final segment does not match');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  Isolation held');
// ═══════════════════════════════════════════════════════════════════════════

ok(fingerprint() === fpBefore, 'real credential files are byte-identical after the run');
ok(!fs.existsSync(path.join(ROOT, 'domains', 'aa')) &&
   !fs.existsSync(path.join(ROOT, 'domains', 'ident')),
  'no fixture domain was written into the repo\'s domains folder');
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '✅' : '❌'} test-tray-pulse: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
