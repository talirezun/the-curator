/**
 * test-ui-state.js — OFFLINE suite for the DURABLE UI-state layer (v3.28.0).
 *
 * ══ THE PROBLEM THIS GUARDS ══════════════════════════════════════════════
 *
 * Every /next preference lives in localStorage. A native shell (an Electron
 * BrowserWindow) has its OWN storage partition, so on the app's first launch
 * nothing the user's browser held is visible. NEXT-PHASE-PLAN R6 solved the
 * /old -> /next cutover by "reading the same key names"; that does not work
 * here, because the problem is the PARTITION, not the name — reading the same
 * name out of an empty partition still returns null.
 *
 * Four fields therefore moved server-side, into .curator-config.json, which
 * src/brain/paths.js already resolves correctly in both install modes. The
 * triage (four moved, ten stayed) is in src/brain/config.js's UI_STATE
 * section; §1 below enforces it against the tree rather than against prose.
 *
 * ══ WHAT IS COVERED, AND HOW ═════════════════════════════════════════════
 *
 *   §1  KEY CENSUS, ENUMERATED FROM DISK. Every `curator-*` string literal in
 *       src/public/next/** must be classified MOVED or STAYS-with-a-reason.
 *       Never a hardcoded list — the blind spot recorded in v3.14.0, v3.23.0,
 *       v3.24.0 and v3.25.0. Carries anti-vacuity controls: the scanner must
 *       find a plausible number of keys, and a planted key must be SEEN.
 *
 *   §2  THE SERVER STORE, driven against the REAL src/brain/config.js in a
 *       throwaway user-data dir (CURATOR_TEST_USER_DATA_DIR). Allow-list,
 *       monotonic refusal, write-once refusal, the one clearable field, and
 *       the fact-vs-absence rule (null is not 'post').
 *
 *   §3  UNKNOWN-KEY ROUND-TRIP. A config written by a NEWER build must survive
 *       an OLDER one writing to it. This is the property that makes version
 *       skew between a repo install and a DMG install safe, and it is measured
 *       through the real setApiKeys / setUiState, not asserted.
 *
 *   §4  THE MERGE, driven against the REAL client module by importing it —
 *       it has no top-level side effects and touches `window` only inside
 *       try/catch, so Node can execute production code directly instead of
 *       re-implementing it. The table covers ALL server x local combinations
 *       per field, which is how "this is a no-op for existing users" is
 *       proven rather than argued.
 *
 *   §5  CONSENT IS NEVER SILENTLY DOWNGRADED — asserted in BOTH directions
 *       and at BOTH layers (the client merge and the server's refusal), so
 *       neither depends on the other being remembered.
 *
 *   §6  MIGRATION / PROMOTION. A warm install promotes nothing; a migrating
 *       install promotes exactly what it rescued; an unreachable server
 *       promotes nothing (a fact and its ABSENCE must not collapse — the
 *       v3.15.0 defect).
 *
 *   §7  THE CLIENT AND SERVER TABLES AGREE, field for field and value for
 *       value. Two hand-maintained copies of one rule is the v3.2.0 CRITICAL
 *       shape, so the copies are compared rather than trusted.
 *
 *   §8  THE CONSUMERS ARE ACTUALLY WIRED, and each keeps its own documented
 *       fail-safe DIRECTION — which are deliberately opposite between
 *       onboarding (SHOW) and cutover (HIDE).
 *
 *   §9  END-TO-END through durableStorage() with a stubbed transport: the
 *       migrating-partition scenario, and the cutover defect this release
 *       fixes, both driven through the REAL cutover-notice.js functions.
 *
 *  §10  THE ROUTE EXISTS AND IS SHAPED RIGHT (GET + POST, no guardConcurrent
 *       — deliberately, and test-route-write-guards.js carries the reasoned
 *       exemption).
 *
 * ══ WHAT THIS SUITE DOES **NOT** ENFORCE ═════════════════════════════════
 *
 *   • It does not run a browser. Nothing here proves the panels actually
 *     paint or do not paint; it proves the DECISIONS that drive them.
 *   • TWO GUARDS ARE SOURCE-LEVEL AND THAT IS THE WEAKER TOOL, measured
 *     rather than assumed: reverting views/cutover-notice.js's storage() to
 *     raw localStorage, and deleting its `await loadUiState()`, each red on
 *     exactly ONE assertion and it is a regex over source. §9(f) closes half
 *     of the second by measuring the CONSEQUENCE of a premature read
 *     behaviourally, but the call SITE itself is still only read. Driving it
 *     properly needs a DOM and a real boot, which is what the browser pass
 *     for this release does and what no offline suite here can. By contrast
 *     the privacy consent is NOT left in that position — §8b executes the
 *     real views/domains.js functions, so reverting them reds behaviourally.
 *   • §1's census reads STRING LITERALS. A key built by concatenation
 *     (`'curator-' + name`) or held in a variable assembled at runtime is
 *     invisible to it. Every key in the tree today is a plain literal in a
 *     named const, and §1's count control would fire if that stopped being
 *     true for most of them — but a single computed key could slip through.
 *   • It does not resolve which of two POSTs wins if a user clicks two
 *     dismissals in the same tick. Both are monotonic or write-once, so the
 *     outcome is order-independent by construction, but that is an argument
 *     about the spec, not a measurement of concurrent requests.
 *   • It does not test the real HTTP route end to end (no server is spawned).
 *     §10 checks the route's SHAPE and its handler's collaborators;
 *     test-route-write-guards.js is what drives config.js's routes live.
 *   • The promotion POST is fire-and-forget by design, so nothing here (or in
 *     production) reports to the user when a promotion failed. It is retried
 *     on the next load; a permanently unreachable server means the values
 *     simply stay local, which is the pre-change behaviour.
 *
 * Zero dependencies — node: builtins only, no browser, no DOM, no network.
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(Object.is(actual, expected), `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── The REAL client module over a stubbed transport ──────────────────────
//
// `serverMap` is what GET /api/config/ui-state answers; `localMap` is keyed by
// the SHIPPING localStorage key names. Every POST the module makes is appended
// to `posted`, so the promotion can be observed rather than inferred.
//
// This drives production loadUiState() and durableStorage() — it does not
// re-implement them — which is the whole reason ui-state.js was written with
// no top-level side effects and with every `window` touch inside try/catch.
async function makeDurable(serverMap, localMap, posted = []) {
  const full = {
    aiHealthDisclosureSeen: null, onboardingDismissed: null,
    cutoverNoticeDismissed: null, installOrigin: null, ...serverMap,
  };
  const localStore = new Map(Object.entries(localMap || {}));
  globalThis.window = {
    localStorage: {
      getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => localStore.set(k, String(v)),
      removeItem: (k) => localStore.delete(k),
    },
  };
  globalThis.fetch = async (url, init) => {
    if (init && init.method === 'POST') posted.push(JSON.parse(init.body));
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ ok: true, ui: full }),
    };
  };
  client.__resetUiState();
  await client.loadUiState();
  // The promotion POST is deliberately not awaited inside loadUiState (see its
  // docblock), so yield one microtask turn before the caller inspects `posted`.
  await Promise.resolve();
  return client.durableStorage();
}

// ═════════════════════════════════════════════════════════════════════════
// Isolation FIRST, before src/brain/config.js is imported anywhere.
//
// paths.js reads CURATOR_TEST_USER_DATA_DIR per call, but config.js's
// getCuratorConfigFile() indirection is only safe because it resolves per
// call too — setting this before the import is belt and braces, and it is
// what keeps this suite from ever touching the maintainer's real
// .curator-config.json (the v3.1.1 rule).
// ═════════════════════════════════════════════════════════════════════════
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-uistate-'));
process.env.CURATOR_TEST_USER_DATA_DIR = TMP;
const CFG_FILE = path.join(TMP, '.curator-config.json');

const cfgMod = await import(path.join(ROOT, 'src/brain/config.js'));
const client = await import(path.join(ROOT, 'src/public/next/shared/ui-state.js'));

function resetConfig(obj) {
  writeFileSync(CFG_FILE, JSON.stringify(obj || {}, null, 2) + '\n');
}
function readConfig() {
  return existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, 'utf8')) : {};
}

// ═════════════════════════════════════════════════════════════════════════
section('1. KEY CENSUS — every curator-* key in /next is classified, ENUMERATED FROM DISK');
// ═════════════════════════════════════════════════════════════════════════

// The four that MOVED. Derived from the client module's own table, not
// re-typed here — a second hand-maintained list is what this section exists
// to prevent.
const MOVED = new Set(Object.keys(client.UI_STATE_KEYS));

// The keys that deliberately STAY per-device, each with the reason. A key
// that is in NEITHER list fails this section, so a key added later cannot
// quietly inherit "per-device" by default.
const STAYS = {
  'curator-next-theme':
    'cosmetic, visible on the first frame, one click in the rail to restore. It is also the highest-FREQUENCY write in the shell, and the argument for keeping the credential file quiet applies to it more than to anything else.',
  'curator-next-view':
    'which screen was last open — positional, per-device, and arguably CORRECT as per-device: a desktop and a laptop have no business agreeing about it.',
  'curator-next-font-scale':
    'the closest call in the census, and it stays. It is an accessibility setting, so its loss is worse than cosmetic — but it is still visible on the first frame and one control in Settings, and app.js applies it SYNCHRONOUSLY before the first paint precisely so no frame renders at the wrong size. A server read cannot be synchronous, so moving it would mean a localStorage cache plus a reflow on every fresh partition — a second writer for a preference the user can see is wrong.',
  'curator-ingest-activity-ack-v1':
    'REFUTED as a loss. src/brain/ingest-activity.js keeps its records in a module-level Map that dies with the process, and a migration is by definition a new process — so a carried-over ack list would have nothing to acknowledge. views/ingest.js\'s own header already argues this is per-VIEWER state; moving it would buy an observable nothing at the cost of a mutating endpoint.',
  'curator-next-chat-domain':
    'per-device convenience; chat.js already re-validates it against the live domain list and falls back safely when it is absent or stale.',
  'curator-next-chat-model':
    'per-device convenience; re-derived against the live catalogue on every load, with a documented safe fallback when absent.',
  'curator-next-chat-model-recents':
    'derived data — a recency list rebuilds itself from use within a session or two.',
  'curator-next-chat-model-starred':
    'the strongest remaining candidate to move, and DEFERRED rather than dismissed: it is a small user-authored collection, not a preference with a default. It stays because it is written on every star and unstar, and a per-click write to the file that holds the API keys is exactly the churn this design avoids. Recorded as an open item, not as a decision that it never should move.',
  'curator-chat-response-style':
    'per-device convenience with a safe default (balanced); chat.js normalises any absent or unrecognised value.',
  'curator-chat-model-provider':
    'per-device convenience; normalised server-side on every message, so an absent value falls back to the global provider.',
  // Present only inside a PROSE COMMENT in views/domains.js, which records
  // that both were deleted for writing state nothing read. They are counted
  // here so the census does not fail on a key that is already gone.
  'curator-next-chat-first-run-request':
    'DEAD — deleted in an earlier release (views/domains.js records why); the string survives only inside the comment explaining its removal.',
  'curator-next-chat-scope-request':
    'DEAD — deleted in an earlier release; the string survives only inside the comment explaining its removal.',
};

function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walkJs(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const nextFiles = walkJs(path.join(ROOT, 'src/public/next'));
ok(nextFiles.length >= 15, `scanned the /next tree from disk (${nextFiles.length} .js files) — a tiny number would make every check below vacuous`);

const foundKeys = new Map(); // key -> [relative file paths]
for (const f of nextFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/['"](curator-[a-z0-9-]+)['"]/g)) {
    const rel = path.relative(ROOT, f);
    if (!foundKeys.has(m[1])) foundKeys.set(m[1], []);
    if (!foundKeys.get(m[1]).includes(rel)) foundKeys.get(m[1]).push(rel);
  }
}

ok(foundKeys.size >= 12, `the scanner found ${foundKeys.size} distinct curator-* keys — a count near zero would mean the pattern stopped matching and every classification below would pass vacuously`);

// ANTI-VACUITY CONTROL: the scanner must be able to SEE a key it has never
// been told about. Run against a synthetic source, not the tree.
{
  const planted = "const X = 'curator-planted-key-v9';";
  const hits = [...planted.matchAll(/['"](curator-[a-z0-9-]+)['"]/g)].map(m => m[1]);
  ok(hits.includes('curator-planted-key-v9'), 'CONTROL: the key scanner fires on a planted key it has no list entry for');
}

for (const [key, files] of [...foundKeys].sort()) {
  const field = client.UI_STATE_KEYS[key];
  if (field) {
    ok(MOVED.has(key), `MOVED: ${key} -> ${field}  (${files.join(', ')})`);
  } else {
    ok(Object.hasOwn(STAYS, key) && STAYS[key].length > 40,
      `STAYS with a written reason: ${key}  (${files.join(', ')})`);
  }
}

// The other direction: nothing may be classified that no longer exists in the
// tree, or the lists silently rot into fiction.
for (const key of MOVED) {
  ok(foundKeys.has(key), `MOVED key ${key} is still present in the /next tree (a stale entry would be fiction)`);
}
eq(MOVED.size, 4, 'exactly four keys moved — a change here is a product decision and must be argued, not absorbed');

// ═════════════════════════════════════════════════════════════════════════
section('2. THE SERVER STORE — allow-list, monotonic, write-once, clearable');
// ═════════════════════════════════════════════════════════════════════════
{
  resetConfig({});
  const empty = cfgMod.getUiState();
  eq(Object.keys(empty).length, 4, 'getUiState() always returns every field');
  for (const f of Object.keys(empty)) eq(empty[f], null, `an unrecorded field reads as null, not as a default — ${f}`);

  // ALLOW-LIST. These values arrive over HTTP and land in the file holding
  // the user's API keys, so anything outside the list must be refused, not
  // stored.
  let r = cfgMod.setUiState({ installOrigin: '../../evil' });
  eq(r.state.installOrigin, null, 'a value outside the allow-list is NOT stored');
  eq(r.refused[0] && r.refused[0].reason, 'invalid_value', '...and the refusal is NAMED, not merely un-written');
  r = cfgMod.setUiState({ geminiApiKey: 'stolen' });
  eq(r.refused[0] && r.refused[0].reason, 'unknown_field', 'an unknown field is refused by name — a POST cannot reach the credential fields through this door');
  ok(!Object.hasOwn(readConfig(), 'geminiApiKey'), '...and nothing was written to the config file');
  r = cfgMod.setUiState({ aiHealthDisclosureSeen: true });
  eq(r.refused[0] && r.refused[0].reason, 'invalid_value', 'a boolean true is refused — the stored shape is the STRING the browser held, so the no-op claim stays a byte comparison');

  // WRITE-ONCE (installOrigin).
  resetConfig({});
  cfgMod.setUiState({ installOrigin: 'post' });
  eq(cfgMod.getUiState().installOrigin, 'post', 'a first origin is recorded');
  r = cfgMod.setUiState({ installOrigin: 'pre' });
  eq(r.state.installOrigin, 'post', 'a recorded origin is NEVER re-decided — the property views/cutover-notice.js promises in its own header');
  eq(r.refused[0] && r.refused[0].reason, 'already_recorded', '...and the refusal is named');

  // MONOTONIC (the consent) — a clear is refused, by name.
  resetConfig({});
  cfgMod.setUiState({ aiHealthDisclosureSeen: 'yes' });
  r = cfgMod.setUiState({ aiHealthDisclosureSeen: null });
  eq(r.state.aiHealthDisclosureSeen, 'yes', 'a recorded CONSENT cannot be cleared');
  eq(r.refused[0] && r.refused[0].reason, 'not_clearable', '...and the attempt is reported rather than silently ignored');
  r = cfgMod.setUiState({ cutoverNoticeDismissed: null });
  eq(r.refused[0] && r.refused[0].reason, 'not_clearable', 'nor can the cutover dismissal — views/cutover-notice.js has no re-open path');

  // CLEARABLE (the onboarding dismissal) — because Settings offers an
  // explicit "Show setup guide" un-dismiss.
  resetConfig({});
  cfgMod.setUiState({ onboardingDismissed: '1' });
  eq(cfgMod.getUiState().onboardingDismissed, '1', 'the onboarding dismissal records');
  r = cfgMod.setUiState({ onboardingDismissed: null });
  eq(r.state.onboardingDismissed, null, 'and CLEARS — the field backing Settings\' "Show setup guide" is the one field that must');
  eq(r.refused.length, 0, '...with no refusal');

  // Junk on disk reads as ABSENT rather than being trusted.
  resetConfig({ ui: { installOrigin: 'PRE', aiHealthDisclosureSeen: 'YES', onboardingDismissed: 1 } });
  const junk = cfgMod.getUiState();
  eq(junk.installOrigin, null, 'a case-wrong value on disk reads as unrecorded, never as a verdict');
  eq(junk.aiHealthDisclosureSeen, null, 'a case-wrong consent reads as NOT GIVEN — the fail-closed direction');
  eq(junk.onboardingDismissed, null, 'a number where a string belongs reads as unrecorded');
  resetConfig({ ui: 'not-an-object' });
  eq(cfgMod.getUiState().installOrigin, null, 'a `ui` that is not an object degrades to "nothing recorded" rather than throwing');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. UNKNOWN-KEY ROUND-TRIP — version skew between a repo install and a DMG install is safe');
// ═════════════════════════════════════════════════════════════════════════
{
  const future = {
    geminiApiKey: 'gem-keep',
    domainsPath: '/keep/domains',
    ui: { aiHealthDisclosureSeen: 'yes', someFutureUiField: 'x' },
    someFutureTopLevel: { a: 1, b: ['x'] },
  };
  resetConfig(future);
  cfgMod.setUiState({ installOrigin: 'pre' });
  const after = readConfig();
  eq(after.geminiApiKey, 'gem-keep', 'setUiState preserves the API key it has no business touching');
  eq(after.domainsPath, '/keep/domains', '...and domainsPath');
  eq(JSON.stringify(after.someFutureTopLevel), JSON.stringify({ a: 1, b: ['x'] }),
    'an unknown TOP-LEVEL field written by a newer build survives an older build writing here');
  eq(after.ui.someFutureUiField, 'x',
    'an unknown field INSIDE the ui object survives too — the merge is a spread, not a replacement');
  eq(after.ui.aiHealthDisclosureSeen, 'yes', 'and the known sibling is untouched');

  // The same property through the pre-existing writer, so the guarantee is
  // shown to be a property of the FILE and not of the new function alone.
  resetConfig(future);
  cfgMod.setApiKeys({ anthropicApiKey: 'ant-new' }, { canActivate: () => true });
  const after2 = readConfig();
  eq(JSON.stringify(after2.ui), JSON.stringify(future.ui),
    'setApiKeys preserves the whole ui object — an OLDER install cannot strip a field a NEWER one wrote');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. THE MERGE — exhaustive per field, which is how the no-op claim is proven');
// ═════════════════════════════════════════════════════════════════════════
{
  const fields = Object.values(client.UI_STATE_KEYS);
  for (const field of fields) {
    const good = client.UI_STATE_VALUES[field][0];
    eq(client.mergeField(field, null, null), null, `${field}: nothing anywhere -> null (not a default)`);
    eq(client.mergeField(field, null, good), good, `${field}: EXISTING USER — server empty, browser holds it -> the browser value, byte-identical (this is the no-op)`);
    eq(client.mergeField(field, good, null), good, `${field}: MIGRATING USER — fresh partition, server holds it -> recovered`);
    eq(client.mergeField(field, good, good), good, `${field}: both agree -> unchanged`);
    eq(client.mergeField(field, 'garbage', good), good, `${field}: an unrecognised SERVER value is treated as absent, not trusted`);
    eq(client.mergeField(field, null, 'garbage'), null, `${field}: an unrecognised LOCAL value is treated as absent, not trusted`);
  }
  // The one field with two values: the server's recorded verdict wins.
  eq(client.mergeField('installOrigin', 'post', 'pre'), 'post',
    'installOrigin: a recorded server verdict wins over a stale local one — "written ONCE and never re-decided"');
  eq(client.mergeField('installOrigin', 'pre', 'post'), 'pre',
    '...in both directions, so it is server-precedence and not a hardcoded preference for "post"');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. A CONSENT IS NEVER SILENTLY DOWNGRADED — both directions, both layers');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(client.mergeField('aiHealthDisclosureSeen', 'yes', null), 'yes',
    'LAYER 1 (client): an empty browser cannot erase a consent the server holds');
  eq(client.mergeField('aiHealthDisclosureSeen', null, 'yes'), 'yes',
    'LAYER 1 (client): an empty server cannot erase a consent the browser holds');

  resetConfig({});
  cfgMod.setUiState({ aiHealthDisclosureSeen: 'yes' });
  for (const attempt of [null, '', 'no', false, 0, undefined]) {
    const r = cfgMod.setUiState({ aiHealthDisclosureSeen: attempt });
    eq(r.state.aiHealthDisclosureSeen, 'yes',
      `LAYER 2 (server): a downgrade attempt with ${JSON.stringify(attempt)} leaves the consent standing`);
  }

  // The structural half: a monotonic field's value list must contain no
  // falsy literal, so a downgrade is not even EXPRESSIBLE as a value.
  const spec = cfgMod.uiStateSpec();
  for (const [field, s] of Object.entries(spec)) {
    if (!s.monotonic) continue;
    ok(s.values.every(v => typeof v === 'string' && v.length > 0),
      `${field}: its allow-list holds no clearing literal, so a downgrade is inexpressible as a VALUE as well as refused as an ACTION`);
  }
  ok(spec.aiHealthDisclosureSeen.monotonic === true && !spec.aiHealthDisclosureSeen.clearable,
    'the privacy consent is monotonic and NOT clearable — the one field where "ask again" must never be reachable from a bug');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. MIGRATION / PROMOTION — what gets sent, and what must NOT be');
// ═════════════════════════════════════════════════════════════════════════
{
  const local = {
    aiHealthDisclosureSeen: 'yes',
    onboardingDismissed: '1',
    cutoverNoticeDismissed: null,
    installOrigin: 'post',
  };
  const emptyServer = { aiHealthDisclosureSeen: null, onboardingDismissed: null, cutoverNoticeDismissed: null, installOrigin: null };

  const patch = client.promotionPatch(emptyServer, local);
  eq(JSON.stringify(patch), JSON.stringify({ aiHealthDisclosureSeen: 'yes', onboardingDismissed: '1', installOrigin: 'post' }),
    'an EXISTING browser user promotes exactly the three values they hold — and never resets one to "not yet given"');
  ok(!Object.hasOwn(patch, 'cutoverNoticeDismissed'),
    '...and a field nobody has recorded is absent from the patch rather than sent as an explicit null');

  const warmServer = { ...local };
  eq(Object.keys(client.promotionPatch(warmServer, local)).length, 0,
    'a WARM install promotes nothing — no POST, so no needless rewrite of the credential file');

  eq(Object.keys(client.promotionPatch({ ...emptyServer, installOrigin: 'pre' }, local)).length, 3 - 1,
    'a field the server already holds is not re-sent, even when the local value differs');

  const freshPartition = { aiHealthDisclosureSeen: null, onboardingDismissed: null, cutoverNoticeDismissed: null, installOrigin: null };
  eq(Object.keys(client.promotionPatch(warmServer, freshPartition)).length, 0,
    'a MIGRATED install (empty partition, full server) promotes nothing — it only READS');

  const merged = client.mergeState(warmServer, freshPartition);
  eq(merged.installOrigin, 'post', '...and the migrated install recovers the origin, which is the whole fix');
  eq(merged.aiHealthDisclosureSeen, 'yes', '...and the privacy consent');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. THE CLIENT AND SERVER TABLES AGREE — two copies of one rule is the v3.2.0 shape');
// ═════════════════════════════════════════════════════════════════════════
{
  const spec = cfgMod.uiStateSpec();
  const serverFields = Object.keys(spec).sort();
  const clientFields = Object.values(client.UI_STATE_KEYS).sort();
  eq(JSON.stringify(clientFields), JSON.stringify(serverFields), 'the two field sets are identical');
  for (const f of serverFields) {
    eq(JSON.stringify([...client.UI_STATE_VALUES[f]]), JSON.stringify([...spec[f].values]),
      `${f}: the client and server allow-lists are identical`);
  }
  const serverClearable = serverFields.filter(f => spec[f].clearable).sort();
  eq(JSON.stringify([...client.UI_STATE_CLEARABLE].sort()), JSON.stringify(serverClearable),
    'the CLEARABLE set matches — a client that tried to clear a field the server refuses would half-clear it');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. THE CONSUMERS ARE WIRED, and each keeps its OWN fail-safe direction');
// ═════════════════════════════════════════════════════════════════════════
{
  const cvn = readFileSync(path.join(ROOT, 'src/public/next/views/cutover-notice.js'), 'utf8');
  const obd = readFileSync(path.join(ROOT, 'src/public/next/views/onboarding.js'), 'utf8');
  const dms = readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');

  for (const [label, src] of [['cutover-notice.js', cvn], ['onboarding.js', obd], ['domains.js', dms]]) {
    ok(/from '\.\.\/shared\/ui-state\.js'/.test(src), `${label} imports the durable store`);
    ok(/durableStorage/.test(src), `${label} uses durableStorage() rather than window.localStorage directly`);
  }
  ok(/await loadUiState\(\)/.test(cvn), 'cutover-notice.js AWAITS the durable load before its first storage read — otherwise it reads an empty native partition');
  ok(/await loadUiState\(\)/.test(obd), 'onboarding.js does too');
  ok(/loadUiState\(\)/.test(dms), 'domains.js primes it on mount, so the SYNCHRONOUS consent check has an answer by the time a button can be clicked');

  // Neither consumer may have silently adopted the other's direction. These
  // are the two assertions that matter most in this section: the directions
  // are OPPOSITE on purpose and each carries a written cost argument.
  ok(/return true;\s*\n\s*\}\s*\n\}/.test(cvn.slice(cvn.indexOf('function readDismissed'), cvn.indexOf('function writeDismissed'))),
    'cutover-notice.js readDismissed still fails towards HIDE (catch -> true)');
  ok(/catch\s*\{\s*return false;/.test(obd.slice(obd.indexOf('function readDismissed'), obd.indexOf('function writeDismissed'))),
    'onboarding.js readDismissed still fails towards SHOW (catch -> false) — the OPPOSITE, deliberately');
  ok(/function aiDisclosureSeen\(\)\s*\{[\s\S]{0,300}?catch\s*\{\s*return false;/.test(dms),
    'domains.js aiDisclosureSeen still fails CLOSED (catch -> false = ask again) for the privacy consent');

  // The rescue must not have quietly bypassed the storage indirection.
  const cvnAfterImport = cvn.slice(cvn.indexOf('const DISMISS_KEY'));
  ok(!/window\.localStorage/.test(cvnAfterImport), 'cutover-notice.js no longer reaches window.localStorage directly');
  ok(!/localStorage\.(get|set)Item/.test(dms.slice(dms.indexOf('const AI_DISCLOSURE_KEY'), dms.indexOf('function confirmAiAction'))),
    'the AI consent no longer reaches localStorage directly — it would still work, and it would not survive a partition change');
}

// ═════════════════════════════════════════════════════════════════════════
section('9. END TO END — the defect this release fixes, through the REAL cutover functions');
// ═════════════════════════════════════════════════════════════════════════
{
  const cvn = readFileSync(path.join(ROOT, 'src/public/next/views/cutover-notice.js'), 'utf8');
  function fn(name) {
    const i = cvn.indexOf(`function ${name}(`);
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const j = cvn.indexOf('{', i);
    for (let k = j; k < cvn.length; k++) {
      if (cvn[k] === '{') d++;
      else if (cvn[k] === '}') { d--; if (d === 0) return cvn.slice(i, k + 1); }
    }
    throw new Error('unbalanced ' + name);
  }
  function kon(name) { const m = cvn.match(new RegExp(`const ${name} = ('[^']*');`)); return `const ${name} = ${m[1]};`; }
  const M = new Function([
    kon('DISMISS_KEY'), kon('ORIGIN_KEY'),
    fn('isExistingUser'), fn('readDismissed'), fn('readOrigin'), fn('classifyOrigin'), fn('shouldShowNotice'),
    'return {readDismissed,readOrigin,classifyOrigin,shouldShowNotice,DISMISS_KEY,ORIGIN_KEY};',
  ].join('\n'))();

  // The facts a MIGRATING user presents. Every one comes from the SERVER, so
  // every one is true on the native app's very first launch.
  const facts = { hasKey: true, hasDomain: true, hasPages: true };

  // (a) THE DEFECT, reproduced: an empty partition with no durable record.
  const emptyStore = { getItem: () => null, setItem: () => {} };
  eq(M.shouldShowNotice(facts, M.readDismissed(emptyStore), M.classifyOrigin(M.readOrigin(emptyStore), facts)), true,
    'DEFECT REPRODUCED: with nothing recorded anywhere, a migrating user is told "The Curator has a new look" and pointed at /old');

  // (b) THE FIX: the same empty partition, but the durable record survived.
  //     Driven through the REAL loadUiState()/durableStorage() over a stubbed
  //     transport, so the cache these functions read is populated by
  //     production code rather than by hand.
  const durable = await makeDurable({ installOrigin: 'post' }, {});
  eq(M.shouldShowNotice(facts, M.readDismissed(durable), M.classifyOrigin(M.readOrigin(durable), facts)), false,
    'FIXED: the durable origin reaches the same code through durableStorage() and the bar stays away');

  // (c) A genuine pre-cutover user who already dismissed it, migrating.
  const durable2 = await makeDurable({ installOrigin: 'pre', cutoverNoticeDismissed: '1' }, {});
  eq(M.shouldShowNotice(facts, M.readDismissed(durable2), M.classifyOrigin(M.readOrigin(durable2), facts)), false,
    'a pre-cutover user who already pressed "Got it" does not have to press it again after migrating');

  // (d) CONTROL — the fix must not have simply disabled the surface. A real
  //     pre-cutover user who has NOT dismissed it still sees it.
  const durable3 = await makeDurable({ installOrigin: 'pre' }, {});
  eq(M.shouldShowNotice(facts, M.readDismissed(durable3), M.classifyOrigin(M.readOrigin(durable3), facts)), true,
    'CONTROL: a pre-cutover user who has not dismissed it STILL sees the bar — the fix is a rescue, not a mute');

  // (e) THE NO-OP CASE, end to end: an existing BROWSER user whose values are
  //     in localStorage and whose server holds nothing. Nothing about what
  //     they see may change — and the promotion must carry their values up.
  const posted = [];
  const durable4 = await makeDurable({}, { 'curator-next-install-origin-v1': 'post' }, posted);
  eq(M.shouldShowNotice(facts, M.readDismissed(durable4), M.classifyOrigin(M.readOrigin(durable4), facts)), false,
    'NO-OP: an existing browser user sees exactly what they saw before — the localStorage origin still decides');
  eq(JSON.stringify(posted[0] || null), JSON.stringify({ installOrigin: 'post' }),
    '...and their value is PROMOTED to the server, which is what makes the later migration correct');

  // (f) THE AWAIT IS LOAD-BEARING. §8 asserts the `await loadUiState()` call
  //     SITE by reading the source, which is the weaker tool — so the
  //     CONSEQUENCE of dropping it is measured here instead of argued: a read
  //     taken before the load resolves falls through to the (empty) partition
  //     and reproduces the defect exactly.
  client.__resetUiState();
  globalThis.window = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, ui: { installOrigin: 'post' } }) });
  const premature = client.durableStorage();          // NO await — the mutation being modelled
  eq(M.shouldShowNotice(facts, M.readDismissed(premature), M.classifyOrigin(M.readOrigin(premature), facts)), true,
    'the await is LOAD-BEARING: reading before the durable record has landed re-creates the bar, which is why the call sites await');
  await client.loadUiState();
  eq(M.shouldShowNotice(facts, M.readDismissed(premature), M.classifyOrigin(M.readOrigin(premature), facts)), false,
    '...and the SAME adapter instance is correct once it has — so the difference is the ordering, not the adapter');
}

// ═════════════════════════════════════════════════════════════════════════
section('8b. THE PRIVACY CONSENT, BEHAVIOURALLY — the real aiDisclosureSeen/markAiDisclosureSeen');
// ═════════════════════════════════════════════════════════════════════════
//
// §8's checks on this pair are SOURCE-LEVEL. That is the weaker tool, and for
// the one field that is a privacy consent it is not enough on its own — so the
// two functions are extracted from views/domains.js and EXECUTED against the
// real durableStorage(). Reverting either of them to raw localStorage now reds
// here for a behavioural reason, not only because a regex stopped matching.
{
  const dms = readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
  function dFn(name) {
    const i = dms.indexOf(`function ${name}(`);
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const j = dms.indexOf('{', i);
    for (let k = j; k < dms.length; k++) {
      if (dms[k] === '{') d++;
      else if (dms[k] === '}') { d--; if (d === 0) return dms.slice(i, k + 1); }
    }
    throw new Error('unbalanced ' + name);
  }
  const km = dms.match(/const AI_DISCLOSURE_KEY = ('[^']*');/);
  const mk = (durable) => new Function('durableStorage', 'localStorage', [
    `const AI_DISCLOSURE_KEY = ${km[1]};`,
    dFn('aiDisclosureSeen'), dFn('markAiDisclosureSeen'),
    'return {aiDisclosureSeen,markAiDisclosureSeen};',
    // `localStorage` is passed in as a THROWING stand-in on purpose: if the
    // extracted code reaches for it directly instead of going through the
    // adapter, the consent reads false and this section reds. That is what
    // makes reverting to raw localStorage a behavioural failure here.
  ].join('\n'))(() => durable, { getItem() { throw new Error('raw localStorage must not be used'); }, setItem() { throw new Error('raw localStorage must not be used'); } });

  // A MIGRATING user: empty partition, consent recorded server-side.
  const migrated = await makeDurable({ aiHealthDisclosureSeen: 'yes' }, {});
  eq(mk(migrated).aiDisclosureSeen(), true,
    'MIGRATION: the privacy consent is recovered on the native app\'s first launch — the modal is NOT re-shown');

  // An EXISTING browser user: consent in localStorage, server empty.
  const warm = await makeDurable({}, { 'curator-ai-health-disclosure-seen-v1': 'yes' });
  eq(mk(warm).aiDisclosureSeen(), true,
    'NO-OP: an existing browser user\'s consent still reads as given, from exactly where it always was');

  // NOBODY has recorded it — the fail-closed direction.
  const fresh = await makeDurable({}, {});
  const F = mk(fresh);
  eq(F.aiDisclosureSeen(), false,
    'CONTROL: with nothing recorded anywhere the consent reads NOT GIVEN — fail-closed is intact and the two cases above are not vacuous');
  const posted = [];
  const fresh2 = await makeDurable({}, {}, posted);
  const F2 = mk(fresh2);
  F2.markAiDisclosureSeen();
  eq(F2.aiDisclosureSeen(), true, 'accepting records it for the rest of the session');
  await Promise.resolve();
  eq(JSON.stringify(posted[posted.length - 1] || null), JSON.stringify({ aiHealthDisclosureSeen: 'yes' }),
    '...and sends it durably, which is the whole point — a consent given today must survive the move to the native shell');
}

// ═════════════════════════════════════════════════════════════════════════
section('9b. THE EXPLICIT UN-DISMISS — Settings\' "Show setup guide", through the REAL functions');
// ═════════════════════════════════════════════════════════════════════════
//
// This section exists because the bug it guards was nearly shipped. A first
// draft made every durable field monotonic, which left durableStorage() with
// no removeItem — so onboarding.js's clearDismissed() would have swallowed a
// TypeError, reported false, and the server would have kept holding the
// dismissal. The button would have kept opening the panel while silently
// persisting nothing, with no error anywhere.
{
  const obd = readFileSync(path.join(ROOT, 'src/public/next/views/onboarding.js'), 'utf8');
  function obFn(name) {
    const i = obd.indexOf(`function ${name}(`);
    if (i < 0) throw new Error('missing ' + name);
    let d = 0; const j = obd.indexOf('{', i);
    for (let k = j; k < obd.length; k++) {
      if (obd[k] === '{') d++;
      else if (obd[k] === '}') { d--; if (d === 0) return obd.slice(i, k + 1); }
    }
    throw new Error('unbalanced ' + name);
  }
  const km = obd.match(/const DISMISS_KEY = ('[^']*');/);
  const OB = new Function([
    `const DISMISS_KEY = ${km[1]};`,
    obFn('readDismissed'), obFn('writeDismissed'), obFn('clearDismissed'),
    'return {readDismissed,writeDismissed,clearDismissed,DISMISS_KEY};',
  ].join('\n'))();

  const posted = [];
  const store = await makeDurable({ onboardingDismissed: '1' }, {}, posted);
  eq(OB.readDismissed(store), true, 'a migrating user\'s onboarding dismissal is recovered from the durable record');
  eq(OB.clearDismissed(store), true,
    'clearDismissed() SUCCEEDS through durableStorage() — it would report false if the adapter had no removeItem, and the button would silently persist nothing');
  eq(OB.readDismissed(store), false, '...and the panel is armed again immediately');
  await Promise.resolve();
  eq(JSON.stringify(posted[posted.length - 1] || null), JSON.stringify({ onboardingDismissed: null }),
    '...and the clear is sent to the server, so the re-open survives the next load');

  // The write direction, same path.
  const posted2 = [];
  const store2 = await makeDurable({}, {}, posted2);
  eq(OB.writeDismissed(store2), true, 'writeDismissed() succeeds through the adapter');
  await Promise.resolve();
  eq(JSON.stringify(posted2[posted2.length - 1] || null), JSON.stringify({ onboardingDismissed: '1' }),
    '...and records the dismissal durably, not only in the partition that is about to be replaced');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. THE ROUTE — shape only; test-route-write-guards.js drives config.js live');
// ═════════════════════════════════════════════════════════════════════════
{
  const routeSrc = readFileSync(path.join(ROOT, 'src/routes/config.js'), 'utf8');
  ok(/router\.get\('\/ui-state'/.test(routeSrc), 'GET /api/config/ui-state is registered');
  ok(/router\.post\('\/ui-state'/.test(routeSrc), 'POST /api/config/ui-state is registered');
  ok(/getUiState/.test(routeSrc) && /setUiState/.test(routeSrc), 'and both resolve through src/brain/config.js, not their own file read');
  const postBlock = routeSrc.slice(routeSrc.indexOf("router.post('/ui-state'"), routeSrc.indexOf("router.post('/ui-state'") + 400);
  ok(!/guardConcurrent/.test(postBlock),
    'the POST is deliberately NOT behind guardConcurrent — a 409 would fire exactly when a user dismisses a panel mid-ingest, causing the symptom the endpoint prevents (reasoned exemption in test-route-write-guards.js)');
  const getBlock = routeSrc.slice(routeSrc.indexOf("router.get('/ui-state'"), routeSrc.indexOf("router.post('/ui-state'"));
  ok(/status\(200\)/.test(getBlock),
    'the GET never 500s — an error body with no `ui` makes every consumer fall back to its OWN fail-safe direction, which is the point');
}

console.log('\n' + '─'.repeat(62));
console.log(`Passed: ${passed}   Failed: ${failed}`);
rmSync(TMP, { recursive: true, force: true });
if (failed > 0) {
  console.log('❌ Durable UI-state assertions failed');
  process.exit(1);
} else {
  console.log('✅ All durable UI-state assertions green');
}
