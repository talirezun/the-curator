/**
 * test-background-mode.js — OFFLINE suite for the `backgroundMode` preference:
 * the resolver, getter and setter in `src/brain/config.js`, and the two routes
 * in `src/routes/config.js` that read and write it.
 *
 * ── WHAT THIS SUITE IS ACTUALLY PROTECTING ────────────────────────────────
 *
 * 1. THE FAIL-SAFE DIRECTION. Absent, unrecognised, a number, a prototype key,
 *    or a mode written by a NEWER build all resolve to `window` — no menubar
 *    icon, Dock unchanged, i.e. exactly what every install does today. That is
 *    the same asymmetry paths.js takes for install-mode detection and
 *    releaseChannel takes for its channel, and it is what makes this change a
 *    provable no-op for every existing user. §2.
 *
 * 2. LENIENT READ, STRICT WRITE. The resolver coerces; the SETTER refuses.
 *    Coercing on the write path would let the Settings screen report
 *    "tray-only saved" while the file holds `window` — a screen asserting
 *    something false about the user's own choice. §3 asserts the refusal is
 *    OBSERVABLE (`ok: false`, a named reason, and the mode STILL IN FORCE in
 *    the same object) rather than a silent no-op somebody later reads as
 *    success. §5 asserts the route turns it into a 400 that still carries the
 *    real mode.
 *
 * 3. IT IS NOT A `ui.*` FIELD, AND CANNOT BECOME ONE BY ACCIDENT. §4 drives
 *    the real `setUiState` and asserts every field in UI_STATE_SPEC is
 *    one-way — which is precisely why a two-way toggle does not belong there.
 *    The argument is in config.js; this is the measurement behind it, so a
 *    future "tidy this into the allow-list" has to read a red test first.
 *
 * 4. THE CREDENTIAL FILE IS NOT DAMAGED. The value lands in
 *    `.curator-config.json`, which holds the user's API keys. §6 asserts
 *    unknown keys and existing keys survive a write, and that a refused value
 *    writes NOTHING AT ALL.
 *
 * ── NOT ENFORCED — stated rather than implied away ────────────────────────
 *  - Nothing here creates a tray, a window or a Dock icon. `desktop/` owns
 *    that and has its own suite; this proves only what the shell will READ.
 *  - The `{tray, dock}` capability record is asserted as a table, not as
 *    observed behaviour. Today it is three literals; the day it forks on
 *    anything, this stops being sufficient.
 *  - The Settings control is not rendered or clicked. No offline suite in
 *    this repo measures real rendering.
 *  - The write-guard exemption for POST /background-mode lives in
 *    scripts/test-route-write-guards.js, which owns that invariant. It is not
 *    duplicated here.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import { createServer } from 'http';

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
section('§1  Isolation — nothing here may reach a real credential file');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-bgmode-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(TMP_DOMAINS, { recursive: true });

process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
delete process.env.DOMAINS_PATH;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(ROOT, f));
// sha256 + size + existence ONLY — mtime moves under the maintainer's live app.
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!fs.existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = fs.readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const fpBefore = fingerprint();
ok(fpBefore.length > 0, 'real credential files fingerprinted before the run');

const cfgMod = await import('../src/brain/config.js');
const {
  resolveBackgroundMode, getBackgroundMode, setBackgroundMode,
  backgroundModeNames, getBackgroundModeCaps, setUiState, uiStateSpec,
} = cfgMod;

const ISOLATED = path.join(TMP_USER, '.curator-config.json');
function writeConfig(obj) {
  if (obj === null) { if (fs.existsSync(ISOLATED)) fs.rmSync(ISOLATED); return; }
  fs.writeFileSync(ISOLATED, JSON.stringify(obj, null, 2) + '\n');
}
function readConfig() {
  return fs.existsSync(ISOLATED) ? JSON.parse(fs.readFileSync(ISOLATED, 'utf8')) : null;
}

// Prove the seam took. A suite whose isolation silently lost would write the
// maintainer's real config and still report green.
writeConfig({ probe: 1 });
setBackgroundMode('tray');
ok(readConfig().backgroundMode === 'tray' && readConfig().probe === 1,
  'writes land in the ISOLATED config file, and it is the one this suite can read');
writeConfig(null);

// ═══════════════════════════════════════════════════════════════════════════
section('§2  THE FAIL-SAFE — anything unrecognised resolves to `window`');
// ═══════════════════════════════════════════════════════════════════════════

eq(resolveBackgroundMode(undefined), 'window', 'absent resolves to window');
eq(resolveBackgroundMode(null), 'window', 'null resolves to window');
eq(resolveBackgroundMode(''), 'window', 'empty string resolves to window');
eq(resolveBackgroundMode(0), 'window', 'a number resolves to window');
eq(resolveBackgroundMode(true), 'window', 'a boolean resolves to window');
eq(resolveBackgroundMode({}), 'window', 'an object resolves to window');
eq(resolveBackgroundMode(['tray']), 'window', 'an array resolves to window');
eq(resolveBackgroundMode('Tray'), 'window', 'a case variant is NOT a mode');
eq(resolveBackgroundMode(' tray '), 'window', 'a padded name is NOT silently trimmed into a mode');
// A config written by a NEWER build. This is the case the asymmetry exists
// for: the install must keep launching, not refuse and not guess.
eq(resolveBackgroundMode('tray-compact'), 'window', 'a mode this build has never heard of resolves to window');

// Prototype keys. An object literal inherits from Object.prototype, so a
// truthiness gate on the table would resolve these to a mode — the v3.0.9
// normalizeResponseStyle bug. Closed by Object.create(null) AND Object.hasOwn.
for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
  eq(resolveBackgroundMode(k), 'window', `the prototype key "${k}" is not a mode`);
}

eq(resolveBackgroundMode('window'), 'window', 'the real names resolve to themselves: window');
eq(resolveBackgroundMode('tray'), 'tray', '…tray');
eq(resolveBackgroundMode('tray-only'), 'tray-only', '…tray-only');
ok(resolveBackgroundMode(resolveBackgroundMode('nonsense')) === 'window',
  'resolution is IDEMPOTENT, so re-resolving at the point of use is a no-op on every real input');

// ── The DEFAULT is off, and it is off for an EXISTING install too ──────────
writeConfig(null);
eq(getBackgroundMode(), 'window', 'no config file at all → window');
writeConfig({ geminiApiKey: 'k', sharedBrainEnabled: true, defaultDomain: 'articles' });
eq(getBackgroundMode(), 'window',
  'a config that predates this field → window, so every existing install is unchanged with ONE code path');
writeConfig({ backgroundMode: 'tray-compact' });
eq(getBackgroundMode(), 'window', 'a junk value on disk → window, not a throw');

eq(backgroundModeNames().join(','), 'window,tray,tray-only',
  'the three names, in the order the Settings control renders them (Off / On / On+hide Dock)');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  LENIENT READ, STRICT WRITE — the setter REFUSES, observably');
// ═══════════════════════════════════════════════════════════════════════════

writeConfig({ apiProbe: 'keep-me' });
eq(setBackgroundMode('tray').mode, 'tray', 'a legal value is stored…');
eq(getBackgroundMode(), 'tray', '…and read back');
eq(setBackgroundMode('tray-only').mode, 'tray-only', 'and the toggle goes BOTH ways — this is not a consent');
eq(setBackgroundMode('window').mode, 'window', '…all the way back off');
eq(setBackgroundMode('tray').ok, true, '…and on again, as many times as the user likes');

const refused = setBackgroundMode('tray-compact');
eq(refused.ok, false, 'an unrecognised value is REFUSED, not coerced');
eq(refused.reason, 'invalid_value', '…with a named reason');
eq(refused.mode, 'tray',
  '…and the returned mode is the one STILL IN FORCE, so a caller that renders it shows the truth even if it ignores `ok`');
eq(getBackgroundMode(), 'tray', '…and nothing on disk changed');

for (const bad of [undefined, null, 42, true, {}, ['tray'], '__proto__', 'Tray']) {
  eq(setBackgroundMode(bad).ok, false, `setBackgroundMode(${JSON.stringify(bad)}) is refused`);
}
eq(getBackgroundMode(), 'tray', 'after eight refusals the stored mode is untouched');

// THE ASYMMETRY, stated as one assertion: the same string the READ path
// happily coerces is the string the WRITE path refuses.
ok(resolveBackgroundMode('tray-compact') === 'window' && setBackgroundMode('tray-compact').ok === false,
  'read coerces, write refuses — the same input, two deliberately different answers');

// ── The capability record the desktop shell branches on ────────────────────
setBackgroundMode('window');
eq(JSON.stringify(getBackgroundModeCaps()), JSON.stringify({ mode: 'window', tray: false, dock: true }),
  'window → no tray, Dock kept');
setBackgroundMode('tray');
eq(JSON.stringify(getBackgroundModeCaps()), JSON.stringify({ mode: 'tray', tray: true, dock: true }),
  'tray → tray and Dock');
setBackgroundMode('tray-only');
eq(JSON.stringify(getBackgroundModeCaps()), JSON.stringify({ mode: 'tray-only', tray: true, dock: false }),
  'tray-only → tray, no Dock');
writeConfig({ backgroundMode: 'tray-compact' });
eq(JSON.stringify(getBackgroundModeCaps()), JSON.stringify({ mode: 'window', tray: false, dock: true }),
  'a junk value yields the SAFE record rather than throwing at the shell\'s startup path');
// The illegal fourth combination — no tray AND no Dock, an app with no way to
// reach it — is unrepresentable because the enum is one field, not two booleans.
ok(!Object.values(['window', 'tray', 'tray-only'].map(m => {
  writeConfig({ backgroundMode: m });
  return getBackgroundModeCaps();
})).some(c => !c.tray && !c.dock),
  'no mode yields "no tray AND no Dock" — the unreachable-app combination cannot be expressed');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  WHY IT IS NOT A `ui.*` FIELD — measured, not asserted');
// ═══════════════════════════════════════════════════════════════════════════

const spec = uiStateSpec();
const names = Object.keys(spec);
ok(names.length > 0, `UI_STATE_SPEC has fields (${names.join(', ')})`);
ok(names.every(f => spec[f].monotonic === true || spec[f].writeOnce === true || spec[f].clearable === true),
  'EVERY field in UI_STATE_SPEC is monotonic, write-once, or a one-way clearable dismissal');
ok(!names.includes('backgroundMode'), 'backgroundMode is NOT in the spec');
eq(setUiState({ backgroundMode: 'tray' }).refused[0].reason, 'unknown_field',
  'and the allow-list refuses it BY NAME if anyone routes it there — it cannot arrive by accident');

// The behavioural proof that the shape genuinely does not fit: drive a real
// monotonic field twice and watch the second write refuse. A two-way toggle
// implemented on that mechanism could be turned ON once and never off.
writeConfig({});
const mono = names.find(f => spec[f].monotonic === true);
ok(mono != null, `a monotonic field exists to demonstrate against (${mono})`);
const first = setUiState({ [mono]: spec[mono].values[0] });
eq(first.refused.length, 0, `the FIRST write of ${mono} is accepted`);
const second = setUiState({ [mono]: null });
eq(second.refused[0].reason, 'not_clearable',
  `…and it can never be turned back off — which is exactly why backgroundMode cannot live here`);

// ═══════════════════════════════════════════════════════════════════════════
section('§5  The routes — GET reports the RESOLVED mode, POST refuses with a 400');
// ═══════════════════════════════════════════════════════════════════════════

const express = (await import('express')).default;
const configRouter = (await import('../src/routes/config.js')).default;
const app = express();
app.use(express.json());
app.use('/api/config', configRouter);
const server = createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function get(p) { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; }
async function post(p, body) {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

writeConfig({ backgroundMode: 'tray-compact', geminiApiKey: 'k' });
const g1 = await get('/api/config');
eq(g1.status, 200, 'GET /api/config answers 200');
eq(g1.body.backgroundMode, 'window',
  'the GET reports the RESOLVED mode — so Settings can never show a mode the app would not actually do');
eq(JSON.stringify(g1.body.backgroundModes), JSON.stringify(['window', 'tray', 'tray-only']),
  'the legal names ride along, so the control renders what this build understands rather than a hardcoded triple');
ok('domainsPath' in g1.body && 'releaseChannel' in g1.body,
  'every pre-existing field on this endpoint keeps its name — the change is additive');

const p1 = await post('/api/config/background-mode', { backgroundMode: 'tray-only' });
eq(p1.status, 200, 'a legal POST answers 200');
eq(p1.body.backgroundMode, 'tray-only', '…and echoes the stored mode');
eq((await get('/api/config')).body.backgroundMode, 'tray-only', '…which the GET then reports');

const p2 = await post('/api/config/background-mode', { backgroundMode: 'tray-compact' });
eq(p2.status, 400, 'an unknown mode is a 400, not a silent 200');
eq(p2.body.reason, 'invalid_value', '…with the named reason');
eq(p2.body.backgroundMode, 'tray-only',
  '…and the body still carries the mode STILL IN FORCE, so a client that renders it cannot show a lie');
ok(/window/.test(p2.body.error) && /tray-only/.test(p2.body.error),
  '…and the error NAMES the legal set rather than saying "invalid"');
eq((await get('/api/config')).body.backgroundMode, 'tray-only', 'the refused POST changed nothing on disk');

for (const bad of [{}, { backgroundMode: null }, { backgroundMode: 5 }, { backgroundMode: ['tray'] }, { other: 'tray' }]) {
  eq((await post('/api/config/background-mode', bad)).status, 400,
    `a malformed body ${JSON.stringify(bad)} is refused`);
}
eq((await get('/api/config')).body.backgroundMode, 'tray-only', 'five malformed bodies later, still untouched');

// A body that is not an object at all must not throw its way to a 500.
{
  const r = await fetch(base + '/api/config/background-mode', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(['tray']),
  });
  eq(r.status, 400, 'an ARRAY body is a 400, not a 500');
}

await new Promise((r) => server.close(r));

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The credential file survives — this writes beside API keys');
// ═══════════════════════════════════════════════════════════════════════════

writeConfig({
  geminiApiKey: 'secret-g', anthropicApiKey: 'secret-a',
  sharedBrainEnabled: true, defaultDomain: 'articles',
  ui: { onboardingDismissed: '1' },
  somethingAFutureBuildWrote: { nested: [1, 2] },
});
setBackgroundMode('tray');
const after = readConfig();
eq(after.geminiApiKey, 'secret-g', 'the Gemini key survives a mode write');
eq(after.anthropicApiKey, 'secret-a', 'the Anthropic key survives');
eq(after.sharedBrainEnabled, true, 'sharedBrainEnabled survives');
eq(after.defaultDomain, 'articles', 'defaultDomain survives');
eq(after.ui.onboardingDismissed, '1', 'the ui.* block survives');
eq(JSON.stringify(after.somethingAFutureBuildWrote), '{"nested":[1,2]}',
  'a key written by a FUTURE build survives — the setter merges, it does not rebuild the object');
eq(after.backgroundMode, 'tray', '…and the mode is there');

// A REFUSED write must not touch the file at all — not a rewrite, not a
// re-serialisation. Fewer atomic-write windows over a file holding API keys.
const bytesBefore = fs.readFileSync(ISOLATED);
setBackgroundMode('tray-compact');
ok(Buffer.compare(bytesBefore, fs.readFileSync(ISOLATED)) === 0,
  'a REFUSED value leaves the credential file BYTE-IDENTICAL — no write attempted at all');

// The file's permissions are the reason all of this matters.
{
  const mode = fs.statSync(ISOLATED).mode & 0o777;
  eq(mode, 0o600, 'the config file is still 0600 after a mode write');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  Isolation held');
// ═══════════════════════════════════════════════════════════════════════════
eq(fingerprint(), fpBefore, 'the real credential files are byte-identical after the run');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('\n============================================================');
console.log(`Passed: ${passed}   Failed: ${failed}`);
console.log('============================================================');
process.exit(failed ? 1 : 0);
