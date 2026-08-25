#!/usr/bin/env node
/**
 * Shared Brain — contributor-name attribution gate (v3.6.2)
 *
 * OFFLINE. No network, no LLM, no real config, no real domains folder.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * Both wizards ask "attribute my contributions by name?" and print, as the
 * LAST line of the consent review, either "show name" or "anonymous UUID
 * (default)". The default is `false`. Until v3.6.2 `attribute_by_name` had
 * writers and ZERO readers, so the default path told the contributor
 * "anonymous UUID" and then wrote their real display name into shared storage
 * on every push — through TWO routes, not one:
 *
 *   A) payload.fellow_display_name          (sharedbrain.js, contribution payload)
 *   B) delta.contributor_name               (sharedbrain-delta.js, per page,
 *                                            carried into shared storage inside
 *                                            payload.deltas)
 *
 * Route B is the one a "gate the obvious line" fix misses. That is why the
 * load-bearing assertions in §3 do NOT inspect the in-memory payload object:
 * they run a REAL push through the REAL LocalFolderStorageAdapter and then
 * search every BYTE of every file written under the storage root. A test that
 * asserts on the object it just constructed can pass while a second code path
 * writes the name somewhere else on disk.
 *
 * Every suppression assertion is paired with a CONTROL at
 * `attribute_by_name: true` that MUST find the name. Without the control, a
 * green could simply mean the test never wrote anything.
 *
 * Run with:  node scripts/test-sharedbrain-attribution.js
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

import { pushDomain, contributorNameForStorage, groupMembers } from '../src/brain/sharedbrain.js';
import { LocalFolderStorageAdapter } from '../src/brain/sharedbrain-local-adapter.js';
import { __testing as configTesting } from '../src/brain/sharedbrain-config.js';

const { validateConnection } = configTesting;

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err}`); }
function assert(cond, label) { cond ? ok(label) : fail(label, 'expected truthy'); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  a === e ? ok(label) : fail(label, `expected ${e}, got ${a}`);
}
function section(name) { console.log(`\n── ${name} ──`); }

// The name every assertion hunts for. Deliberately absurd: nothing else in a
// wiki page, a slug, a UUID or a timestamp can collide with it, so a match is
// always a real leak and a miss is never a false negative from over-matching.
const SECRET_NAME = 'Zorbnax Quillfeather';

const tmpRoots = [];
function newTmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

// ── Byte-level storage scanner ─────────────────────────────────────────────

/** Recursively collect every file path under `dir`. */
function walkFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) walkFiles(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

/**
 * Search the RAW BYTES of every file under `root` for `needle`.
 *
 * Two passes per file:
 *   1. the utf-8 bytes as written (what the LocalFolder adapter produces);
 *   2. a best-effort base64 DECODE of the whole file, because the GitHub
 *      adapter base64-encodes its bodies and a future adapter swap must not
 *      be able to hide a leak behind an encoding.
 *
 * Pass 2 decodes rather than encoding the needle: base64 is 3-byte aligned, so
 * `base64(needle)` is a substring of `base64(document)` only when the needle
 * happens to start at an offset divisible by 3. Encoding the needle therefore
 * MISSES roughly two thirds of real leaks. §2b pins the decode behaviour.
 *
 * @returns {{hits: string[], filesScanned: number, bytesScanned: number}}
 */
function scanStorageForName(root, needle) {
  const files = walkFiles(root);
  const hits = [];
  let bytesScanned = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    bytesScanned += buf.length;
    const s = buf.toString('utf-8');
    let hit = s.includes(needle);
    if (!hit) {
      const compact = s.replace(/\s+/g, '');
      if (compact.length >= 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
        try {
          if (Buffer.from(compact, 'base64').toString('utf-8').includes(needle)) hit = true;
        } catch { /* not base64 after all */ }
      }
    }
    if (hit) hits.push(path.relative(root, f));
  }
  return { hits, filesScanned: files.length, bytesScanned };
}

// ── Fixture builders ───────────────────────────────────────────────────────

function makeDomainsDir() {
  const root = newTmp('curator-attr-domains-');
  const wiki = path.join(root, 'work-ai', 'wiki');
  mkdirSync(path.join(wiki, 'entities'), { recursive: true });
  mkdirSync(path.join(wiki, 'concepts'), { recursive: true });
  writeFileSync(path.join(wiki, 'entities', 'anthropic.md'),
    '# Anthropic\n\n## Key Facts\n- Builds Claude.\n', 'utf-8');
  writeFileSync(path.join(wiki, 'concepts', 'rag.md'),
    '# RAG\n\n## Definition\n- Retrieval augmented generation.\n', 'utf-8');
  return root;
}

/**
 * Build a connection. `attributeByName` is passed through VERBATIM (including
 * `undefined`, which omits the key entirely) so the malformed-value cases can
 * exercise the real shape a hand-edited config produces.
 */
function makeConnection(storageRoot, attributeByName) {
  const conn = {
    id: randomUUID(),
    label: 'Attribution Test Brain',
    storage_type: 'local',
    local_storage_path: storageRoot,
    fellow_id: randomUUID(),
    fellow_display_name: SECRET_NAME,
    shared_domain: 'work-ai',
    shared_brain_slug: 'attr-cohort',
    local_domains: ['work-ai'],
    last_push_at: null,
    pending_retry: {},
    permanent_skip: [],
    enabled: true,
  };
  if (arguments.length >= 2) conn.attribute_by_name = attributeByName;
  return conn;
}

/** Mock LLM — never called with the display name; returns a canned delta. */
const mockLLM = async (_system, user) => {
  const m = user.match(/PAGE PATH:\s*(\S+)/);
  const slug = (m ? m[1] : 'x').replace(/^(entities|concepts|summaries)\//, '').replace(/\.md$/, '');
  return JSON.stringify({
    title: slug,
    new_facts: [`Default fact about ${slug}.`],
    stable_facts: [], new_links: [], removed_links: [], key_entities: [],
  });
};

const noopPatch = () => null;

/**
 * Run one real push into a fresh storage root and scan the written bytes.
 * `attributeByName` semantics match makeConnection: omit the argument to
 * simulate a connection that has no such key at all.
 */
async function pushAndScan(...args) {
  const storageRoot = newTmp('curator-attr-storage-');
  const domainsDir = makeDomainsDir();
  const conn = args.length ? makeConnection(storageRoot, args[0]) : makeConnection(storageRoot);
  const result = await pushDomain(conn, 'work-ai', {
    llmFn: mockLLM,
    domainsDir,
    patchFn: noopPatch,
  });
  const scan = scanStorageForName(storageRoot, SECRET_NAME);
  return { result, scan, storageRoot, conn };
}

// ══════════════════════════════════════════════════════════════════════════
// 1. contributorNameForStorage — the predicate, in isolation
// ══════════════════════════════════════════════════════════════════════════

section('1. contributorNameForStorage — strict-equals-true, fail closed');

assertEq(
  contributorNameForStorage({ attribute_by_name: true, fellow_display_name: SECRET_NAME }),
  SECRET_NAME,
  '1a: boolean true → the name is returned (the ONLY attributing case)'
);

// The whole point of the release: the DEFAULT path must suppress.
assertEq(
  contributorNameForStorage({ attribute_by_name: false, fellow_display_name: SECRET_NAME }),
  null,
  '1b: boolean false → null'
);

// A connection persisted before v3.6.2 may simply not have the key.
assertEq(
  contributorNameForStorage({ fellow_display_name: SECRET_NAME }),
  null,
  '1c: key absent (pre-v3.6.2 connection) → null'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: undefined, fellow_display_name: SECRET_NAME }),
  null,
  '1d: explicit undefined → null'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: null, fellow_display_name: SECRET_NAME }),
  null,
  '1e: null → null'
);

// THE TRAP. `"false"` is a TRUTHY string. A truthiness gate would ATTRIBUTE a
// connection whose stored value literally reads "false".
assertEq(
  contributorNameForStorage({ attribute_by_name: 'false', fellow_display_name: SECRET_NAME }),
  null,
  '1f: STRING "false" (truthy!) → null — a truthiness gate would leak here'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: 'true', fellow_display_name: SECRET_NAME }),
  null,
  '1g: STRING "true" → null (only a real boolean attributes)'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: 1, fellow_display_name: SECRET_NAME }),
  null,
  '1h: number 1 → null'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: 0, fellow_display_name: SECRET_NAME }),
  null,
  '1i: number 0 → null'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: {}, fellow_display_name: SECRET_NAME }),
  null,
  '1j: object → null'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: [true], fellow_display_name: SECRET_NAME }),
  null,
  '1k: array → null'
);

// Non-object / missing connection must not throw.
assertEq(contributorNameForStorage(null),      null, '1l: null connection → null (no throw)');
assertEq(contributorNameForStorage(undefined), null, '1m: undefined connection → null (no throw)');
assertEq(contributorNameForStorage('x'),       null, '1n: string connection → null (no throw)');

// Opted IN but no usable name → still null, so nothing writes an empty slot.
assertEq(
  contributorNameForStorage({ attribute_by_name: true, fellow_display_name: '' }),
  null,
  '1o: opted in but empty name → null'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: true, fellow_display_name: '   ' }),
  null,
  '1p: opted in but whitespace-only name → null'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: true, fellow_display_name: 42 }),
  null,
  '1q: opted in but non-string name → null'
);
assertEq(
  contributorNameForStorage({ attribute_by_name: true }),
  null,
  '1r: opted in but no name field → null'
);

// ══════════════════════════════════════════════════════════════════════════
// 2. Scanner self-test — prove the detector CAN fail
// ══════════════════════════════════════════════════════════════════════════

section('2. Byte scanner — negative control (the detector must be able to fire)');

{
  const probe = newTmp('curator-attr-probe-');
  mkdirSync(path.join(probe, 'nested', 'deeper'), { recursive: true });
  writeFileSync(path.join(probe, 'nested', 'deeper', 'plain.json'),
    JSON.stringify({ who: SECRET_NAME }), 'utf-8');
  const s1 = scanStorageForName(probe, SECRET_NAME);
  assertEq(s1.hits, ['nested/deeper/plain.json'],
    '2a: scanner finds a plaintext name nested two directories deep');

  // Every 3-byte alignment phase, because base64 is 3-byte aligned: encoding
  // the needle and substring-matching would find only the phase-0 case.
  for (const pad of ['', 'x', 'xy']) {
    const probe2 = newTmp('curator-attr-probe-');
    writeFileSync(path.join(probe2, 'b64.txt'),
      Buffer.from(JSON.stringify({ pad, who: SECRET_NAME }), 'utf-8').toString('base64'), 'utf-8');
    assertEq(scanStorageForName(probe2, SECRET_NAME).hits, ['b64.txt'],
      `2b: scanner finds a base64-encoded name at alignment phase ${pad.length} (GitHub-adapter body shape)`);
  }

  const probe3 = newTmp('curator-attr-probe-');
  writeFileSync(path.join(probe3, 'clean.json'), JSON.stringify({ who: 'Somebody Else' }), 'utf-8');
  assertEq(scanStorageForName(probe3, SECRET_NAME).hits, [],
    '2c: scanner reports clean when the name is genuinely absent');
}

// ══════════════════════════════════════════════════════════════════════════
// 3. THE LOAD-BEARING TEST — real push, real adapter, written bytes
// ══════════════════════════════════════════════════════════════════════════

section('3. Real push through LocalFolderStorageAdapter — written bytes');

// ── 3A. CONTROL: opted IN. The name MUST appear, or this suite proves nothing.
{
  const { result, scan, storageRoot } = await pushAndScan(true);
  assert(result.ok, '3A-i: CONTROL push succeeded');
  assertEq(result.pushed, 2, '3A-ii: CONTROL pushed 2 pages');
  assert(scan.filesScanned > 0, `3A-iii: CONTROL wrote ${scan.filesScanned} file(s) to storage`);
  assert(scan.bytesScanned > 0, `3A-iv: CONTROL storage holds ${scan.bytesScanned} bytes`);
  assert(scan.hits.length > 0,
    '3A-v: CONTROL — the name IS present in written bytes when opted in ' +
    '(if this ever fails, every suppression assertion below is vacuous)');

  // Both routes must carry it when opted in — so a suppression pass has two
  // things to prove, not one.
  const adapter = new LocalFolderStorageAdapter({ storage_root: storageRoot });
  const contribs = await adapter.listContributionsSince(null);
  assertEq(contribs.length, 1, '3A-vi: CONTROL one contribution on disk');
  assertEq(contribs[0].payload.fellow_display_name, SECRET_NAME,
    '3A-vii: CONTROL route A — payload.fellow_display_name carries the name');
  assert(contribs[0].payload.deltas.every(d => d.contributor_name === SECRET_NAME),
    '3A-viii: CONTROL route B — every delta.contributor_name carries the name');
}

// ── 3B. THE DEFAULT PATH: opted out. Nothing anywhere.
{
  const { result, scan, storageRoot } = await pushAndScan(false);
  assert(result.ok, '3B-i: opted-out push still succeeded (privacy must not break push)');
  assertEq(result.pushed, 2, '3B-ii: opted-out push contributed the same 2 pages');
  assert(scan.filesScanned > 0,
    `3B-iii: opted-out push DID write ${scan.filesScanned} file(s) — the scan is not empty by accident`);
  assertEq(scan.hits, [],
    '3B-iv: ★ the display name appears in ZERO bytes written to shared storage');

  const adapter = new LocalFolderStorageAdapter({ storage_root: storageRoot });
  const contribs = await adapter.listContributionsSince(null);
  assertEq(contribs.length, 1, '3B-v: the contribution itself is still stored');
  assert(!('fellow_display_name' in contribs[0].payload),
    '3B-vi: route A — the fellow_display_name KEY is omitted entirely, not written as null');
  assertEq(contribs[0].payload.deltas.length, 2, '3B-vii: both deltas present');
  assert(contribs[0].payload.deltas.every(d => !d.contributor_name),
    '3B-viii: route B — no delta carries a contributor_name');
  // The pseudonymous identifiers must SURVIVE — suppressing the name must not
  // break attribution-by-UUID, which is what the collective actually uses.
  assertEq(contribs[0].payload.fellow_id, contribs[0].fellowId,
    '3B-ix: fellow_id (the real identity) is untouched');
  assert(contribs[0].payload.deltas.every(d => d.contributor_id === contribs[0].fellowId),
    '3B-x: delta.contributor_id (UUID) is untouched — anonymity, not anonymity-loss');
}

// ── 3C. Key absent — a connection persisted before v3.6.2.
{
  const { result, scan, conn } = await pushAndScan();
  assert(!('attribute_by_name' in conn),
    '3C-i: fixture really has NO attribute_by_name key (pre-v3.6.2 shape)');
  assert(result.ok, '3C-ii: push with the key absent succeeded');
  assert(scan.filesScanned > 0, '3C-iii: files were written');
  assertEq(scan.hits, [],
    '3C-iv: ★ absent flag fails CLOSED — name in zero bytes');
}

// ── 3D. The string "false" — truthy, and it must still suppress.
{
  const { result, scan } = await pushAndScan('false');
  assert(result.ok, '3D-i: push with attribute_by_name:"false" succeeded');
  assert(scan.filesScanned > 0, '3D-ii: files were written');
  assertEq(scan.hits, [],
    '3D-iii: ★ STRING "false" suppresses — a truthiness gate would leak here');
}

// ── 3E. null.
{
  const { result, scan } = await pushAndScan(null);
  assert(result.ok, '3E-i: push with attribute_by_name:null succeeded');
  assert(scan.filesScanned > 0, '3E-ii: files were written');
  assertEq(scan.hits, [], '3E-iii: ★ null suppresses');
}

// ── 3F. The string "true" — also not a boolean, also suppressed.
{
  const { result, scan } = await pushAndScan('true');
  assert(result.ok, '3F-i: push with attribute_by_name:"true" succeeded');
  assert(scan.filesScanned > 0, '3F-ii: files were written');
  assertEq(scan.hits, [], '3F-iii: ★ STRING "true" suppresses (only a real boolean attributes)');
}

// ══════════════════════════════════════════════════════════════════════════
// 4. Downstream readers degrade gracefully
// ══════════════════════════════════════════════════════════════════════════

section('4. groupMembers — the admin member directory with no name on file');

{
  const fid = randomUUID();
  const members = groupMembers([
    {
      fellowId: fid,
      submissionId: 's1',
      // Exactly the payload shape v3.6.2 writes when opted out: no name key.
      payload: { fellow_id: fid, contributed_at: '2026-08-01T00:00:00.000Z', deltas: [{}, {}] },
    },
  ]);
  assertEq(members.length, 1, '4a: one member grouped');
  assertEq(members[0].display_name, null,
    '4b: display_name stays null — the UI falls back to the short-ID label');
  assertEq(members[0].short_id, fid.replace(/-/g, '').slice(0, 8),
    '4c: short_id still identifies the contributor for the revoke picker');
  assertEq(members[0].pages, 2, '4d: page count unaffected');

  // Mixed cohort: one attributed, one not — both must appear.
  const fid2 = randomUUID();
  const mixed = groupMembers([
    { fellowId: fid,  submissionId: 's1', payload: { contributed_at: '2026-08-01T00:00:00.000Z', deltas: [] } },
    { fellowId: fid2, submissionId: 's2', payload: { contributed_at: '2026-08-02T00:00:00.000Z', fellow_display_name: 'Opted In', deltas: [] } },
  ]);
  assertEq(mixed.length, 2, '4e: mixed cohort — both members listed');
  assertEq(mixed.find(m => m.fellow_id === fid).display_name, null, '4f: opted-out member has no name');
  assertEq(mixed.find(m => m.fellow_id === fid2).display_name, 'Opted In', '4g: opted-in member keeps their name');
}

// ══════════════════════════════════════════════════════════════════════════
// 5. validateConnection — attribute_by_name must be a boolean
// ══════════════════════════════════════════════════════════════════════════

section('5. validateConnection — boolean-only attribute_by_name (defence in depth)');

function baseValidConn(extra = {}) {
  return {
    id: randomUUID(),
    label: 'V',
    storage_type: 'local',
    local_storage_path: '/tmp/whatever',
    fellow_id: randomUUID(),
    fellow_display_name: 'Someone',
    shared_domain: 'work-ai',
    shared_brain_slug: 'cohort',
    local_domains: ['work-ai'],
    ...extra,
  };
}
function validates(conn) {
  try { validateConnection(conn); return true; } catch { return false; }
}

assert(validates(baseValidConn()), '5a: connection with NO attribute_by_name still validates (back-compat)');
assert(validates(baseValidConn({ attribute_by_name: true })),  '5b: true validates');
assert(validates(baseValidConn({ attribute_by_name: false })), '5c: false validates');
assert(!validates(baseValidConn({ attribute_by_name: 'false' })), '5d: string "false" refused at save');
assert(!validates(baseValidConn({ attribute_by_name: 'true' })),  '5e: string "true" refused at save');
assert(!validates(baseValidConn({ attribute_by_name: null })),    '5f: null refused at save');
assert(!validates(baseValidConn({ attribute_by_name: 1 })),       '5g: number refused at save');

// ══════════════════════════════════════════════════════════════════════════
// 6. Source guards — the gate cannot be quietly removed
// ══════════════════════════════════════════════════════════════════════════

section('6. Source guards');

{
  const src = readFileSync(new URL('../src/brain/sharedbrain.js', import.meta.url), 'utf-8');

  // The two former leak sites must no longer read `connection.fellow_display_name`
  // directly. Only the gate function may touch that field.
  const rawReads = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /connection\.fellow_display_name/.test(line))
    .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line));
  assertEq(rawReads.map(r => r.n), [],
    '6a: no un-gated read of connection.fellow_display_name survives in sharedbrain.js');

  assert(/const attributedName = contributorNameForStorage\(connection\);/.test(src),
    '6b: pushDomain resolves the decision exactly once, via the gate');
  assertEq((src.match(/contributorNameForStorage\(connection\)/g) || []).length, 1,
    '6c: exactly ONE call site — two would be free to drift apart');
  assert(/\.\.\.\(attributedName === null \? \{\} : \{ fellow_display_name: attributedName \}\)/.test(src),
    '6d: the payload omits the key (spread) rather than writing null');
  assert(/fellowDisplayName: attributedName === null \? '' : attributedName,/.test(src),
    '6e: the delta call is fed from the SAME resolved value');
  assert(/if \(conn\.attribute_by_name !== true\) return null;/.test(src),
    '6f: the predicate is strict !== true (no truthiness test, no permissive else arm)');
}

// ── Cleanup + report ───────────────────────────────────────────────────────

for (const d of tmpRoots) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }

console.log(`\n${'='.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}: ${f.err}`);
  process.exit(1);
}
console.log('All attribution-gate assertions green.');
process.exit(0);
