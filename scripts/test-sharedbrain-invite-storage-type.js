#!/usr/bin/env node
/**
 * Shared Brain — invite tokens are GitHub-only (v3.6.1).
 *
 * The defect this pins (recorded as known gap #3): a `storage_type: "local"`
 * invite token PASSED `decodeInviteToken`, so the contributor wizard walked
 * the user all the way to step 5 — creating a REAL Personal Access Token on
 * github.com on the way — and only then did POST /save refuse with
 * "SharedBrain connection: local_storage_path must be an absolute path",
 * which is meaningless to a contributor and reads as the app being broken.
 * `storage_type: "cloudflare-r2"` was worse: it passed parse AND save, and
 * failed only later at the first Push/Pull inside createStorageAdapter.
 *
 * The fix refuses a non-github storage_type at BOTH ends of the codec —
 * decode (so the contributor learns at step 1, before any PAT exists) and
 * encode (so an admin cannot mint a token every contributor will refuse).
 *
 * This suite asserts BOTH directions. A guard that refuses everything is as
 * broken as one that refuses nothing, so the github happy path — mint, parse,
 * round-trip fidelity, and the absent-storage_type back-compat case — is
 * asserted just as hard as the refusals.
 *
 * Deliberately NOT asserted here, because it is deliberately NOT changed:
 * `validateConnection` and `createStorageAdapter` still accept "local". That
 * backend genuinely works and exists for cohort simulation configured by
 * writing the connection directly. Only the INVITE path is narrowed. §4
 * below pins that non-narrowing so a future "tidy-up" cannot quietly delete
 * the local backend in the name of consistency.
 *
 * Run with:  node scripts/test-sharedbrain-invite-storage-type.js
 * Exit code 0 if all green; non-zero on any failure.
 * OFFLINE: no network, no API key, no real config or domains touched.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { __testing as routesTesting } from '../src/routes/sharedbrain.js';
import { __testing as configTesting } from '../src/brain/sharedbrain-config.js';
import { createStorageAdapter } from '../src/brain/sharedbrain-storage-factory.js';

const { encodeInviteToken, decodeInviteToken, INVITE_PREFIX, INVITE_STORAGE_TYPE } = routesTesting;
const { validateConnection } = configTesting;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Harness ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];
function ok(label)        { passed++; console.log(`  ✓ ${label}`); }
function fail(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${err.message || err}`); }
function assert(cond, label, errMsg) {
  if (cond) ok(label);
  else fail(label, new Error(errMsg || 'assertion failed'));
}
function assertEq(actual, expected, label) {
  assert(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertThrows(fn, snippet, label) {
  let threw = null;
  try { fn(); } catch (err) { threw = err; }
  if (!threw) { fail(label, new Error('expected a throw, got none')); return null; }
  if (snippet && !String(threw.message).includes(snippet)) {
    fail(label, new Error(`message missing "${snippet}" — got: ${threw.message}`));
    return threw;
  }
  ok(label);
  return threw;
}
function section(title) { console.log(`\n${title}`); }

// A token minted by hand, bypassing encodeInviteToken. This is what a real
// hostile / legacy / hand-rolled token looks like on the wire, and it is the
// ONLY way to reach decodeInviteToken with a non-github storage_type now that
// encodeInviteToken refuses to mint one. Without this helper the decode-side
// assertions would be unreachable and would silently pass for the wrong reason.
function mintRawToken(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return INVITE_PREFIX + b64;
}

const BASE = { v: 1, repo: 'acme/cohort-brain', name: 'Acme Cohort', shared_domain: 'cohort', branch: 'main', data_handling_terms: 'contributor_retains' };

// ═══════════════════════════════════════════════════════════════════════════
console.log('Shared Brain — invite tokens are GitHub-only');
console.log('='.repeat(70));

// ── 1. The positive direction: github still works, end to end ─────────────
section('1. github invites still mint, parse, and round-trip');

let githubToken = null;
try {
  githubToken = encodeInviteToken({ repo: 'acme/cohort-brain', name: 'Acme Cohort', shared_domain: 'cohort', storage_type: 'github' });
  ok('encodeInviteToken mints an explicit storage_type: "github" token');
} catch (err) {
  fail('encodeInviteToken mints an explicit storage_type: "github" token', err);
}

assert(typeof githubToken === 'string' && githubToken.startsWith(INVITE_PREFIX),
  'minted github token carries the sbi_ prefix');

if (githubToken) {
  let meta = null;
  try { meta = decodeInviteToken(githubToken); ok('decodeInviteToken accepts a github token'); }
  catch (err) { fail('decodeInviteToken accepts a github token', err); }

  if (meta) {
    assertEq(meta.storage_type, 'github', 'parsed metadata reports storage_type: "github"');
    assertEq(meta.repo, 'acme/cohort-brain', 'parsed metadata returns repo intact');
    assertEq(meta.name, 'Acme Cohort', 'parsed metadata returns display name intact');
    assertEq(meta.shared_domain, 'cohort', 'parsed metadata returns shared_domain intact');
    assertEq(meta.branch, 'main', 'parsed metadata returns branch intact');
    assertEq(meta.data_handling_terms, 'contributor_retains', 'parsed metadata returns data_handling_terms intact');
    assertEq(meta.v, 1, 'parsed metadata returns the version number');
  }
}

// The overwhelmingly common admin call omits storage_type entirely and relies
// on encodeInviteToken's "github" default. If the new guard read the caller's
// raw input instead of the defaulted payload, this would throw.
try {
  const implicit = encodeInviteToken({ repo: 'acme/cohort-brain', name: 'Acme Cohort', shared_domain: 'cohort' });
  const meta = decodeInviteToken(implicit);
  assertEq(meta.storage_type, 'github', 'omitting storage_type still defaults to "github" and parses');
  assertEq(implicit, githubToken, 'omitted and explicit "github" produce the IDENTICAL token (determinism preserved)');
} catch (err) {
  fail('omitting storage_type still defaults to "github" and parses', err);
}

// Back-compat: v2.8.0 tokens predate the storage_type field entirely. An
// ABSENT field must still parse — it means github. This is the one case the
// guard must NOT catch, and getting it wrong would break every legacy invite
// in circulation.
{
  const legacy = mintRawToken({ v: 1, repo: 'acme/cohort-brain', name: 'Acme Cohort', shared_domain: 'cohort' });
  try {
    const meta = decodeInviteToken(legacy);
    ok('a legacy v2.8.0 token with NO storage_type field still parses (back-compat)');
    assert(meta.storage_type === undefined, 'legacy token metadata leaves storage_type absent (not invented)');
  } catch (err) {
    fail('a legacy v2.8.0 token with NO storage_type field still parses (back-compat)', err);
  }
}

// ── 2. The negative direction: decode refuses non-github ──────────────────
section('2. decodeInviteToken refuses a non-github invite (the reported defect)');

for (const st of ['local', 'cloudflare-r2']) {
  const token = mintRawToken({ ...BASE, storage_type: st });
  const err = assertThrows(() => decodeInviteToken(token), st,
    `decodeInviteToken refuses a "${st}" token and names the storage type`);
  if (err) {
    const m = String(err.message);
    // The message is the whole point of this fix: a bare validation error
    // sends the contributor hunting for a fault on their own machine.
    assert(/ask your cohort admin/i.test(m),
      `"${st}" refusal tells the contributor to ask their admin`);
    assert(/github/i.test(m),
      `"${st}" refusal explains that only GitHub-backed brains can issue invites`);
    assert(/token/i.test(m) && /do not create/i.test(m),
      `"${st}" refusal explicitly tells the contributor NOT to create an access token`);
    assert(!/local_storage_path/.test(m),
      `"${st}" refusal does NOT leak the old internal "local_storage_path" wording`);
  }
}

// An unknown storage type must still be refused — the guard is an allow-list
// of exactly one value, not a deny-list of the two known-bad ones.
{
  const token = mintRawToken({ ...BASE, storage_type: 'some-future-backend' });
  assertThrows(() => decodeInviteToken(token), 'some-future-backend',
    'decodeInviteToken refuses an unknown storage_type (allow-list, not deny-list)');
}

// Casing / whitespace must not sneak past: the comparison is exact.
for (const st of ['GitHub', 'GITHUB', ' github', 'github ']) {
  const token = mintRawToken({ ...BASE, storage_type: st });
  assertThrows(() => decodeInviteToken(token), 'Shared Brain',
    `decodeInviteToken refuses near-miss storage_type ${JSON.stringify(st)} (exact match required)`);
}

// ── 3. The class, not the call site: encode refuses too ───────────────────
section('3. encodeInviteToken refuses to MINT a non-github invite');

for (const st of ['local', 'cloudflare-r2', 'some-future-backend']) {
  const err = assertThrows(
    () => encodeInviteToken({ repo: 'acme/cohort-brain', name: 'Acme Cohort', shared_domain: 'cohort', storage_type: st }),
    st,
    `encodeInviteToken refuses to mint a "${st}" token and names the storage type`);
  if (err) {
    assert(/github/i.test(err.message),
      `mint refusal for "${st}" tells the admin to use github`);
  }
}

// The point of guarding the mint side: an admin cannot produce a token that
// every contributor downstream will reject. Prove the two ends agree — there
// is no storage_type that encode will mint and decode will then refuse.
{
  let disagreements = 0;
  for (const st of [undefined, 'github', 'local', 'cloudflare-r2', 'some-future-backend', 'GitHub', '']) {
    let token = null;
    try { token = encodeInviteToken({ repo: 'acme/cohort-brain', name: 'Acme Cohort', shared_domain: 'cohort', storage_type: st }); }
    catch { continue; } // refused at mint — the two ends cannot disagree
    try { decodeInviteToken(token); }
    catch { disagreements++; }
  }
  assertEq(disagreements, 0, 'no storage_type is mintable-but-unparseable (mint and parse agree)');
}

assertEq(INVITE_STORAGE_TYPE, 'github', 'INVITE_STORAGE_TYPE is the single source of truth for both ends');

// ── 4. What was deliberately NOT narrowed ─────────────────────────────────
section('4. The "local" backend itself is untouched (invite path only)');

// If someone later "tidies up" by making validateConnection or the factory
// github-only, these go red — the local backend is a real, working capability
// used by cohort simulation and by eight offline suites. Narrowing the INVITE
// path is not a mandate to delete it.
{
  const localConn = {
    id: randomUUID(),
    label: 'Simulated Cohort',
    storage_type: 'local',
    local_storage_path: path.resolve(__dirname, '..', 'nonexistent-simulation-root'),
    fellow_id: randomUUID(),
    fellow_display_name: 'Tester',
    shared_domain: 'cohort',
    shared_brain_slug: 'cohort',
    local_domains: ['work-ai'],
    enabled: true,
  };
  try { validateConnection(localConn); ok('validateConnection STILL accepts a directly-configured "local" connection'); }
  catch (err) { fail('validateConnection STILL accepts a directly-configured "local" connection', err); }

  try {
    const adapter = createStorageAdapter(localConn);
    assert(!!adapter, 'createStorageAdapter STILL builds an adapter for storage_type "local"');
  } catch (err) {
    fail('createStorageAdapter STILL builds an adapter for storage_type "local"', err);
  }
}

// ── 5. The end-to-end claim: a refused invite never reaches PAT creation ──
section('5. End-to-end: a non-github invite dies at step 1, not at save');

// This models the wizard's actual sequence. Step 1 parses the token; only if
// that succeeds does the wizard walk the user to step 3 to create a PAT and
// step 5 to save. Asserting the parse throws IS the assertion that no PAT is
// ever created — there is no other path to step 3.
for (const st of ['local', 'cloudflare-r2']) {
  const token = mintRawToken({ ...BASE, storage_type: st });
  let reachedPatStep = false;
  try {
    decodeInviteToken(token);   // wizard step 1
    reachedPatStep = true;      // wizard steps 2-3: accept invite, create PAT
  } catch { /* refused before any credential work — the fix */ }
  assert(!reachedPatStep,
    `a "${st}" invite is refused at step 1, so the contributor never reaches PAT creation`);
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(70));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}${f.err ? `: ${f.err.message || f.err}` : ''}`);
  process.exit(1);
}
console.log('All green.');
process.exit(0);
