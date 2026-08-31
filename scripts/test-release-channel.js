/**
 * test-release-channel.js — OFFLINE suite for the `releaseChannel` resolver in
 * `src/brain/config.js` and the two update paths in `src/routes/config.js`
 * that consult it.
 *
 * ── WHAT SHIPPED, AND WHAT THIS SUITE IS ACTUALLY PROTECTING ───────────────
 * The recorded gap is "rollback is forward-only" (v3.18.0, v3.19.0, v3.20.0).
 * A release channel does not fix that — it buys CONTAINMENT, and containment
 * needs a pre-release branch. `origin` has none. So exactly ONE channel is
 * defined, there is no setter, and what actually ships is the RESOLVER and its
 * fail-safe asymmetry.
 *
 * That makes the headline assertion here the same shape as
 * test-install-mode.js's:
 *
 *     an install with NO releaseChannel key — every install that exists today —
 *     issues the SAME commands, in the SAME order, with the SAME strings, and
 *     fetches the SAME URLs, as it did before this change.
 *
 * and the second one, which is the part that has to survive version skew:
 *
 *     an install whose config names a channel THIS BUILD HAS NEVER HEARD OF
 *     also issues those same strings, rather than refusing or interpolating
 *     the unknown name into a git command.
 *
 * §4 pins the command strings and URLs as LITERALS TRANSCRIBED INTO THIS FILE.
 * They are never read back out of `src/routes/config.js` — an expected value
 * read from the code under test is a test that cannot fail. They were captured
 * by running the PRE-CHANGE handler (`git show HEAD:src/routes/config.js`)
 * through this same seam and recording what it issued.
 *
 * ── WHY §3 EXISTS: THE SECOND CHANNEL IS NOT A TABLE ROW ───────────────────
 * install.sh clones with `git clone --depth 1`, and `--depth 1` implies
 * `--single-branch`, so a standard install's refspec is exactly
 * `+refs/heads/main:refs/remotes/origin/main`. Measured on such a clone: 1
 * commit, 0 tags, and `refs/remotes` holding only origin/HEAD and origin/main.
 * Consequence, measured against a throwaway origin that DID have a `beta`
 * branch:
 *
 *     git fetch origin beta         ->  " * branch  beta -> FETCH_HEAD"
 *     git reset --hard origin/beta  ->  fatal: ambiguous argument 'origin/beta'
 *
 * The fetch REPORTS SUCCESS and the reset then fails. So the obvious
 * implementation of a second channel — swap the branch name into the two
 * commands updateHandler already runs — is broken on every standard install,
 * and broken in the way most likely to convince someone it worked.
 *
 * §3 therefore asserts the channel table still has exactly one entry. It is
 * MEANT to go red the day someone adds a second one. That is not a bug in this
 * suite: it is the tripwire that makes the person adding `beta` read the
 * measurement in src/brain/config.js and fetch with an explicit refspec
 * (`+refs/heads/<b>:refs/remotes/origin/<b>`, measured working) instead.
 *
 * ── NOT ENFORCED — stated rather than implied away ─────────────────────────
 *  - This suite never runs git. It asserts which command STRINGS the handler
 *    issues, not what git does with them. The single-branch/shallow findings
 *    above came from real clones driven by hand; nothing here re-measures
 *    them, and nothing here would notice if GitHub changed that behaviour.
 *  - It does not prove a second channel would work. It proves one has not been
 *    added without reading why that is harder than it looks.
 *  - It does not check the Settings UI renders the recovery text, only that
 *    the string exists and makes no claim this project has been burned by
 *    before. No offline suite in this repo measures real rendering.
 *  - The recovery PROCEDURE in that string was verified by hand against a real
 *    shallow clone (fetch tag -> checkout -> back to main). This suite pins the
 *    claims the string may not make; it cannot re-run the procedure offline.
 *  - Unknown-key preservation is asserted over the setters this suite calls,
 *    not over every writer in config.js. They all share readRaw/writeRaw, but
 *    a future setter that rebuilt the object literally would not be caught.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const same = actual === expected;
  ok(same, `${label}${same ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`);
}
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, `${label}${a === e ? '' : `\n        expected: ${e}\n        actual:   ${a}`}`);
}
function section(t) { console.log(`\n${t}`); }

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Isolation — nothing here may reach a real credential file');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-relchan-')));
const TMP_USER = path.join(TMP, 'userdata');
const TMP_DOMAINS = path.join(TMP, 'domains');
fs.mkdirSync(TMP_USER, { recursive: true });
fs.mkdirSync(TMP_DOMAINS, { recursive: true });

// BOTH seams, before any app module is imported. CURATOR_TEST_DOMAINS_DIR alone
// leaves the developer's real .sync-config.json (and its GitHub PAT) in reach.
process.env.CURATOR_TEST_USER_DATA_DIR = TMP_USER;
process.env.CURATOR_TEST_DOMAINS_DIR = TMP_DOMAINS;
// DOMAINS_PATH still outranks the default inside getDomainsDir(); an inherited
// one would point an "isolated" run at a real wiki (see paths.js's docblock).
delete process.env.DOMAINS_PATH;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(ROOT, f));

// sha256 + size + existence ONLY. mtime is deliberately excluded: the
// maintainer's live app rewrites .curator-config.json during ordinary Settings
// use, and an mtime-sensitive guard would then report a false "isolation is
// broken" (the v3.0.16 misattribution shape).
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!fs.existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = fs.readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const fpBefore = fingerprint();
ok(typeof fpBefore === 'string' && fpBefore.length > 0, 'real credential files fingerprinted before the run');

const ISOLATED_CONFIG = path.join(TMP_USER, '.curator-config.json');
function writeConfig(obj) {
  if (obj === null) { if (fs.existsSync(ISOLATED_CONFIG)) fs.rmSync(ISOLATED_CONFIG); return; }
  fs.writeFileSync(ISOLATED_CONFIG, JSON.stringify(obj, null, 2) + '\n');
}
function readConfig() {
  return fs.existsSync(ISOLATED_CONFIG) ? JSON.parse(fs.readFileSync(ISOLATED_CONFIG, 'utf8')) : null;
}

// Prove the isolation actually took, rather than assuming the env vars won.
// A suite whose seam silently lost would run every assertion below against the
// developer's own config file and report them all green.
// config.js THROWS AT MODULE LOAD if DEFAULT_RELEASE_CHANNEL names a channel
// RELEASE_CHANNELS does not define — that throw is the designed loud failure.
// But an unhandled module-load throw kills the run with a raw stack, naming no
// expectation and leaving the tally wrong (the v3.24.1 shape, and exactly what
// mutating the default to 'beta' produced before the invariant was added).
// Caught here so it is REPORTED as a failure, then exited, because nothing
// below can run without the module.
let cfg;
try {
  cfg = await import(path.join(ROOT, 'src/brain/config.js'));
  ok(true, 'src/brain/config.js loads (its release-channel invariant passed at module load)');
} catch (err) {
  ok(false, `src/brain/config.js FAILED to load: ${err && err.message}`);
  console.log(`\nPassed: ${passed}   Failed: ${failed}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}
writeConfig({ __isolationProbe: true });
ok(readConfig().__isolationProbe === true, 'the isolated config file is the one this suite writes');
const cfgRoute = await import(path.join(ROOT, 'src/routes/config.js'));
ok(typeof cfgRoute.updateHandler === 'function', 'src/routes/config.js exports updateHandler');
ok(typeof cfgRoute.updateCheckHandler === 'function', 'src/routes/config.js exports updateCheckHandler');

// ═══════════════════════════════════════════════════════════════════════════
section('§2  The fail-safe: absent or unrecognised resolves to `stable`');
// ═══════════════════════════════════════════════════════════════════════════

eq(cfg.resolveReleaseChannel('stable'), 'stable', 'the one defined channel resolves to itself');

// The whole point of the asymmetry: everything else lands on stable. `beta` is
// in this list ON PURPOSE — it is the value a future build will write, and an
// older build reading it must keep updating from the ref it has always used.
for (const bad of [
  undefined, null, '', '   ', 'beta', 'Beta', 'STABLE', 'canary', 'nightly', 'main',
  0, 1, true, false, NaN, [], {}, ['stable'], { channel: 'stable' },
]) {
  eq(cfg.resolveReleaseChannel(bad), 'stable',
    `resolveReleaseChannel(${JSON.stringify(bad) ?? String(bad)}) -> stable`);
}

// Prototype keys — the v3.0.9 normalizeResponseStyle bug (a truthiness gate let
// inherited keys through to an undefined record), closed by construction AND by
// check.
//
// MEASURED, because "both is deliberate" is the kind of claim that gets one half
// deleted as dead code later. The two defences are INDIVIDUALLY REDUNDANT and
// JOINTLY LOAD-BEARING — only the pair is observable:
//   - swap Object.hasOwn for a truthiness gate, keep the null prototype -> GREEN
//   - drop the null prototype, keep Object.hasOwn                       -> GREEN
//   - drop BOTH                                                          -> RED, 6
//     failures naming __proto__, constructor, toString, hasOwnProperty,
//     valueOf and the on-disk case
// So neither mutation alone proves anything, and neither half is dead.
for (const proto of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
  eq(cfg.resolveReleaseChannel(proto), 'stable', `prototype key "${proto}" -> stable`);
}

// And through the file, not just the pure function.
writeConfig({});
eq(cfg.getReleaseChannel(), 'stable', 'a config with NO releaseChannel key -> stable');
writeConfig(null);
eq(cfg.getReleaseChannel(), 'stable', 'NO CONFIG FILE AT ALL -> stable');
writeConfig({ releaseChannel: 'canary' });
eq(cfg.getReleaseChannel(), 'stable', 'a channel this build has never heard of -> stable');
writeConfig({ releaseChannel: '__proto__' });
eq(cfg.getReleaseChannel(), 'stable', 'a prototype key ON DISK -> stable');
writeConfig({ releaseChannel: 'stable' });
eq(cfg.getReleaseChannel(), 'stable', 'an explicit "stable" on disk -> stable');

// getReleaseRef is what the update paths actually call.
writeConfig({ releaseChannel: 'canary' });
deepEq(cfg.getReleaseRef(), { channel: 'stable', branch: 'main' },
  'getReleaseRef() on an unknown channel yields the stable ref, never the unknown name');
ok(typeof cfg.getReleaseRef().branch === 'string' && cfg.getReleaseRef().branch.length > 0,
  'the branch is always a non-empty string — never undefined, which would build "origin/undefined"');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  ONE channel today — this is a tripwire, and it is meant to fire');
// ═══════════════════════════════════════════════════════════════════════════
// If you are here because this section went red, you added a channel. Read the
// release-channel block in src/brain/config.js FIRST: a standard install is a
// single-branch shallow clone, so `git reset --hard origin/<yours>` cannot
// resolve, and the `git fetch origin <yours>` before it will look like it
// worked. Fetch with an explicit refspec instead. Then update these two
// assertions deliberately.

const names = cfg.releaseChannelNames();
ok(Array.isArray(names), 'releaseChannelNames() returns an array');
deepEq(names, ['stable'],
  'exactly ONE channel is defined — adding a second needs the explicit-refspec fix, not a table row');
eq(cfg.getReleaseRef().branch, 'main', 'the only channel tracks `main`');

// Anti-vacuity: a resolver that returned its default unconditionally would
// satisfy every assertion in §2. Prove it can still return a real name.
ok(names.every(n => cfg.resolveReleaseChannel(n) === n),
  'every DEFINED channel name resolves to ITSELF (so §2 is not passing vacuously)');
// There is deliberately no setter — a setter with one legal value is a control
// that cannot change anything. Pin that, so adding one is a decision.
eq(typeof cfg.setReleaseChannel, 'undefined',
  'no setReleaseChannel is exported — the channel is config-file-only while one channel exists');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  Byte-equivalence: the commands and URLs an install issues today');
// ═══════════════════════════════════════════════════════════════════════════
// LITERALS, transcribed. Captured by running `git show HEAD:src/routes/config.js`
// through this same seam and recording what it issued. Never read back out of
// the file under test.

const EXPECTED_UPDATE_COMMANDS = [
  'git --version',
  'git fetch origin main',
  'git rev-parse HEAD',
  'git reset --hard origin/main',
  'git rev-parse HEAD',
  'npm install --silent --no-audit --no-fund',
  'bash scripts/build-app.sh',
];
const EXPECTED_CHECK_COMMANDS = ['git rev-parse --short HEAD'];
const EXPECTED_CHECK_URLS = [
  'https://raw.githubusercontent.com/talirezun/the-curator/main/package.json',
  'https://api.github.com/repos/talirezun/the-curator/commits/main',
];

const CAPS = { canSelfUpdateViaGit: true, canRunNpmInstall: true };

function recorder() {
  const commands = [], urls = [];
  return {
    commands, urls,
    // NEVER the real exec. A real run here would `git reset --hard origin/main`
    // the developer's own worktree.
    execAsync: async (cmd) => {
      commands.push(cmd);
      if (/rev-parse/.test(cmd)) return { stdout: 'abc1234\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    fetch: async (url) => {
      urls.push(String(url));
      if (/package\.json/.test(String(url))) return { ok: true, json: async () => ({ version: '9.9.9' }) };
      return { ok: true, text: async () => 'deadbeefcafe' };
    },
  };
}
function fakeRes() {
  const out = { statusCode: 200, body: null };
  return { status(c) { out.statusCode = c; return this; }, json(b) { out.body = b; return this; }, _out: out };
}

async function runUpdate() {
  const r = recorder(), res = fakeRes();
  await cfgRoute.updateHandler({}, res, { caps: CAPS, execAsync: r.execAsync });
  return { commands: r.commands, status: res._out.statusCode, body: res._out.body };
}
async function runCheck() {
  const r = recorder(), res = fakeRes();
  await cfgRoute.updateCheckHandler({}, res, { caps: CAPS, execAsync: r.execAsync, fetch: r.fetch });
  return { commands: r.commands, urls: r.urls, status: res._out.statusCode, body: res._out.body };
}

// (a) The no-op proof for every install that exists today: no key at all.
writeConfig({});
let u = await runUpdate();
deepEq(u.commands, EXPECTED_UPDATE_COMMANDS,
  'NO releaseChannel key: POST /api/config/update issues the seven pre-change commands, in order');
eq(u.status, 200, 'NO releaseChannel key: the update still answers 200');
deepEq(u.body, { ok: true, restarting: true, from: 'abc1234', to: 'abc1234' },
  'NO releaseChannel key: the update response body is unchanged');

let c = await runCheck();
deepEq(c.commands, EXPECTED_CHECK_COMMANDS, 'NO releaseChannel key: update-check issues the one pre-change command');
deepEq(c.urls, EXPECTED_CHECK_URLS, 'NO releaseChannel key: update-check fetches the two pre-change URLs');

// (b) The same, with the file absent entirely — a fresh install before any save.
writeConfig(null);
u = await runUpdate();
deepEq(u.commands, EXPECTED_UPDATE_COMMANDS, 'NO CONFIG FILE: the same seven commands');
c = await runCheck();
deepEq(c.urls, EXPECTED_CHECK_URLS, 'NO CONFIG FILE: the same two URLs');

// (c) Version skew: a channel a NEWER build wrote must not reach a git command
//     or a URL. This is the assertion that would catch an interpolation bug —
//     `git reset --hard origin/canary`, or a fetch of .../commits/canary.
writeConfig({ releaseChannel: 'canary' });
u = await runUpdate();
deepEq(u.commands, EXPECTED_UPDATE_COMMANDS,
  'UNKNOWN channel on disk: still the seven `main` commands — the unknown name never reaches git');
ok(!u.commands.some(x => x.includes('canary')), 'UNKNOWN channel on disk: "canary" appears in NO command');
c = await runCheck();
deepEq(c.urls, EXPECTED_CHECK_URLS, 'UNKNOWN channel on disk: still the two `main` URLs');
ok(!c.urls.some(x => x.includes('canary')), 'UNKNOWN channel on disk: "canary" appears in NO URL');

// (d) A hostile-shaped value. The resolver is an allow-list, so this can only
//     ever land on stable — but assert it, because the failure mode of getting
//     it wrong is a shell string built from config-file content.
writeConfig({ releaseChannel: 'main; rm -rf /' });
u = await runUpdate();
deepEq(u.commands, EXPECTED_UPDATE_COMMANDS, 'a shell-shaped channel value cannot reach the command line');

// (e) The additive fields, and the pre-existing shape underneath them.
writeConfig({});
c = await runCheck();
for (const k of ['current', 'latest', 'localCommit', 'remoteCommit', 'updateAvailable', 'localAhead']) {
  ok(Object.hasOwn(c.body, k), `update-check response still carries the pre-change field "${k}"`);
}
eq(c.body.updateAvailable, true, 'update-check still computes updateAvailable from the same inputs');
eq(c.body.localAhead, false, 'update-check still computes localAhead from the same inputs');
eq(c.body.latest, '9.9.9', 'update-check still reads `latest` from the fetched package.json');
eq(c.body.channel, 'stable', 'update-check reports the RESOLVED channel');
eq(c.body.branch, 'main', 'update-check reports the ref it actually used');

// (f) The refusal arm is untouched — a build that cannot self-update must not
//     reach the channel logic at all.
{
  const r = recorder(), res = fakeRes();
  await cfgRoute.updateHandler({}, res, { caps: { canSelfUpdateViaGit: false, canRunNpmInstall: false }, execAsync: r.execAsync });
  ok(res._out.statusCode !== 200, 'a build that cannot self-update via git is still refused');
  deepEq(r.commands, [], 'the refusal runs NO commands — the channel lookup never happens');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Unknown-key preservation — what makes version skew survivable');
// ═══════════════════════════════════════════════════════════════════════════
// setApiKeys does readRaw() -> mutate named fields -> writeRaw(cfg). So an
// OLDER install must not strip a `releaseChannel` a NEWER one wrote. That is
// the property that lets a repo install and a future packaged install share a
// config file; it is asserted rather than assumed.

writeConfig({
  geminiApiKey: 'seed-key',
  releaseChannel: 'canary',
  someFutureKey: { nested: [1, 2, 3] },
});

cfg.setApiKeys({ anthropicApiKey: 'added-later' });
let after = readConfig();
eq(after.releaseChannel, 'canary', 'setApiKeys PRESERVES an unrecognised releaseChannel');
deepEq(after.someFutureKey, { nested: [1, 2, 3] }, 'setApiKeys PRESERVES an unknown nested key');
eq(after.anthropicApiKey, 'added-later', 'setApiKeys still wrote the field it was asked to write');
eq(after.geminiApiKey, 'seed-key', 'setApiKeys left the other key alone');

cfg.setSharedBrainEnabled(true);
cfg.setDefaultDomain('articles');
after = readConfig();
eq(after.releaseChannel, 'canary', 'setSharedBrainEnabled + setDefaultDomain PRESERVE releaseChannel');
deepEq(after.someFutureKey, { nested: [1, 2, 3] }, '...and the unknown nested key');
eq(after.sharedBrainEnabled, true, '...while still writing their own fields');
eq(after.defaultDomain, 'articles', '...both of them');

// Anti-vacuity: prove this check could SEE a strip. If the assertions above
// passed against a writer that dropped the key, they would be worthless.
{
  const stripped = { ...readConfig() };
  delete stripped.releaseChannel;
  fs.writeFileSync(ISOLATED_CONFIG, JSON.stringify(stripped, null, 2) + '\n');
  ok(readConfig().releaseChannel === undefined,
    'CONTROL: with the key deliberately removed, this check reads it as absent — so it can detect a strip');
}

// And the resolver still copes with the stripped file rather than throwing.
eq(cfg.getReleaseChannel(), 'stable', 'a config that LOST the key resolves to stable, not to a throw');

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The recovery text may not make a claim nobody verified');
// ═══════════════════════════════════════════════════════════════════════════
// This project shipped "anything can be reverted from the Sync tab" at EIGHT
// sites (v3.9.1) for a feature that never existed, and cut a "so nothing is
// lost" line in v3.24.0 that was false twice over. The Settings string is
// therefore guarded BY SHAPE — the forbidden claims below fail wherever they
// are worded — and PAIRED with a positive assertion that the ABSENCE of an
// in-app revert is stated, so the guard cannot be satisfied by deleting the
// sentence.

const settingsSrc = fs.readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
const recoveryMatch = settingsSrc.match(/const UPDATE_RECOVERY_INFO\s*=\s*([\s\S]*?);\n/);
ok(!!recoveryMatch, 'UPDATE_RECOVERY_INFO is found in views/settings.js');
// If the const is renamed or reformatted past this parser, FAIL LOUDLY rather
// than fall through to "0 claims checked, nothing wrong" — the silent-blindness
// shape this repo keeps re-learning (test-frontend-null-safety.js).
const recovery = recoveryMatch ? recoveryMatch[1] : '';
ok(recovery.length > 200, 'the recovery text was actually extracted (not an empty match reported as a pass)');

for (const [claim, why] of [
  [/nothing is lost/i, 'v3.24.0 cut this exact phrasing as false'],
  [/anything can be reverted/i, 'the v3.9.1 eight-site false promise'],
  [/revert (it )?from the (sync|settings) tab/i, 'no route in this app exposes a revert'],
  [/\bone[- ]click\b/i, 'recovery is a Terminal procedure, not a button'],
  [/\bautomatic(ally)? (roll ?back|revert)/i, 'nothing rolls back automatically'],
  [/\bprevious version\b/i, 'not every release is tagged — the newest tag can be several releases back'],
]) {
  ok(!claim.test(recovery), `the recovery text does NOT claim ${claim} (${why})`);
}

// Positive half — the guard must not be satisfiable by saying nothing.
ok(/no in-app way to undo|only moves forward/i.test(recovery),
  'the recovery text STATES that updating only moves forward / cannot be undone in-app');
ok(/--depth 1/.test(recovery),
  'the recovery text names the shallow-clone step — without it `git checkout <tag>` fails outright');
ok(/git fetch --depth 1 origin tag/.test(recovery), 'it gives the tag-fetch command that was measured working');
ok(/git checkout/.test(recovery), 'it gives the checkout command');
ok(/tags/.test(recovery), 'it points at the tag list as the authority on what can be recovered');
ok(/not touched|not every build is tagged/i.test(recovery), 'it states the limits rather than only the happy path');
// No version number may be baked in: it goes stale the moment a tag is pushed,
// and a stale example reads as a claim about what is newest.
ok(!/v\d+\.\d+\.\d+/.test(recovery), 'no version number is hardcoded in the recovery text');

// The mark is rendered where the update flow is, and is a real control.
ok(settingsSrc.includes("infoMark('settings-update-recovery-info'"),
  'the recovery text is rendered through infoMark (a focusable button + a hidden panel)');
ok(settingsSrc.includes('recovery.btn') && settingsSrc.includes('recovery.panel'),
  'BOTH fragments are emitted — a btn with no panel is an inert control');
// settings.js hand-rolls its own infoMark; its ids must stay in the settings-*
// namespace so they cannot collide with shared/text.js's derived tx-vh-info-*
// ids (the v3.24.0 duplicate-id defect, where getElementById returned the
// FIRST match and one panel became unreachable by anyone).
ok(/infoMark\('settings-/.test(settingsSrc) && !/infoMark\('tx-vh-info-/.test(settingsSrc),
  'every hand-rolled info panel id stays in the settings-* namespace');

// ═══════════════════════════════════════════════════════════════════════════
section('§7  Isolation held');
// ═══════════════════════════════════════════════════════════════════════════

eq(fingerprint(), fpBefore, 'the real credential files are byte-identical after the run (sha256 + size + existence)');
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
