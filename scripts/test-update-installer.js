/**
 * test-update-installer.js — OFFLINE suite for the `download-installer` update
 * path: `updateStyle`, the release-list check in `src/routes/config.js`, and
 * the Settings verdicts + status box in `src/public/next/views/settings.js`.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * A user who installed the Mac DMG opened Settings → Software update, clicked
 * "Check for updates", and got a RED status box reading:
 *
 *     Couldn’t check for updates
 *     Cannot check for updates in this build of The Curator (Packaged app).
 *     This install does not have the "canSelfUpdateViaGit" capability.
 *
 * MEASURED, not assumed: `updateCheckHandler` refused on the capability
 * (501, `{error, refused, capability, installMode, updateAvailable:false}`),
 * `/next`'s `classifyUpdate` maps ANY `error` field to `kind:'error'`, and
 * `renderUpdateStatus` renders that as `.upd-status.upd-bad`. So the app both
 * looked broken and named an internal identifier at the user. §8a reproduces
 * that exact HTML from HEAD as a control, so the "before" in the report is a
 * measurement rather than a memory.
 *
 * ── WHAT IS BEING CLAIMED, AND HOW ──────────────────────────────────────────
 *
 * The headline claim is NOT "the installer arm works" (though §7 drives it end
 * to end). It is:
 *
 *     in repo mode, `GET /api/config/update-check` behaves EXACTLY as it did
 *     at HEAD — same commands, same network calls, same response bytes.
 *
 * §6 proves that the way `test-install-mode.js` §5b established: the handler is
 * extracted from BOTH revisions, compiled with the same fake collaborators, and
 * run over an input matrix — WITH the control that the two must DISAGREE when
 * the capability record is stubbed to the packaged build. Agreement in both
 * modes would be satisfied by a branch that does nothing, and would prove
 * nothing at all.
 *
 * ── Sections ────────────────────────────────────────────────────────────────
 *
 *   §1  isolation + real-credential fingerprint
 *   §2  `parseVersionCore` was LIFTED out of `compareSemver`, not copied —
 *       proven by running HEAD's comparator and this one over the same matrix
 *   §3  `pickInstallableRelease` — including the REAL measured release payload
 *   §4  `decideInstallerUpdate` — three outcomes, and why it is not the git one
 *   §5  `classifyReleaseFailure` — offline / rate-limited / HTTP / bad shape
 *   §6  THE EQUIVALENCE PROOF for repo mode, plus its disagreement control
 *   §7  the installer arm end to end, through the real exported handler
 *   §8  the frontend: the old failure reproduced, the new verdicts, the git
 *       path proven additive-only, and the wording-distinctness rule
 *   §9  the release-channel tripwire
 *   §10 anti-vacuity controls + what is NOT enforced
 *
 * NO NETWORK. Every fetch in this file is injected. The one real measurement
 * that needed the network (what GitHub's release list actually contains) was
 * taken once, by hand, and is transcribed as a fixture in §3 — public data
 * from a public repo, carrying no credential and no personal path.
 *
 * Dependency-free (node: builtins only), no API key, no writes outside
 * os.tmpdir().
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
function section(t) { console.log(`\n${t}`); }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  Isolation — nothing here may reach a real credential file');
// ═══════════════════════════════════════════════════════════════════════════

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curator-updinst-')));
fs.mkdirSync(path.join(TMP, 'userdata'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'domains'), { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'userdata');
process.env.CURATOR_TEST_DOMAINS_DIR = path.join(TMP, 'domains');
delete process.env.DOMAINS_PATH;

const REAL_FILES = ['.curator-config.json', '.sync-config.json', '.sharedbrain-config.json']
  .map(f => path.join(ROOT, f));
// sha256 + size + existence ONLY — never mtime (the maintainer's live app
// rewrites .curator-config.json during ordinary Settings use, and an
// mtime-sensitive guard reports a false "isolation is broken").
function fingerprint() {
  return REAL_FILES.map(f => {
    if (!fs.existsSync(f)) return `${path.basename(f)}:absent`;
    const buf = fs.readFileSync(f);
    return `${path.basename(f)}:${buf.length}:${createHash('sha256').update(buf).digest('hex')}`;
  }).join('|');
}
const fpBefore = fingerprint();
ok(fpBefore.length > 0, 'real credential files fingerprinted before the run');

// install-mode.js THROWS AT MODULE LOAD if a capability record is not
// exhaustive — the designed loud failure. But an unhandled module-load throw
// kills this run with a raw stack, naming no expectation and leaving the tally
// wrong (the v3.24.1 shape). Found by mutation M18. Caught here so the failure
// is REPORTED as one, then exited, because nothing below can run without it.
let configRoute, installMode, brainConfig;
try {
  configRoute = await import(path.join(ROOT, 'src/routes/config.js'));
  installMode = await import(path.join(ROOT, 'src/brain/install-mode.js'));
  brainConfig = await import(path.join(ROOT, 'src/brain/config.js'));
  ok(true, 'the modules under test load (install-mode.js\'s exhaustiveness check passed at module load)');
} catch (err) {
  ok(false, `a module under test FAILED to load: ${err && err.message}`);
  console.log(`\nPassed: ${passed}   Failed: ${failed}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

const REPO_CAPS = installMode.getCapabilities('repo');
const BUNDLE_CAPS = installMode.getCapabilities('bundle');
eq(REPO_CAPS.updateStyle, 'git-pull', 'repo mode receives updates by pulling its own source');
eq(BUNDLE_CAPS.updateStyle, 'download-installer', 'a packaged build receives updates as a download the user runs');
eq(installMode.getInstallMode(), 'repo',
  'CONTROL: this checkout is repo mode, so nothing here can reach a production installer arm');

// ═══════════════════════════════════════════════════════════════════════════
section('§2  parseVersionCore was LIFTED, not copied — comparator unchanged');
// ═══════════════════════════════════════════════════════════════════════════
//
// `compareSemver` had the parse inline as an arrow function. The installer path
// needs to distinguish UNPARSEABLE from EQUAL, which the comparator collapses
// to the same 0, so the parse was hoisted to an exported function. A hoist is
// invisible to `git diff -w` as a behaviour claim, so it is proven the only way
// that means anything: HEAD's comparator and the working tree's, over one
// matrix, every cell required to agree.

const headConfigSrc = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:src/routes/config.js'], { encoding: 'utf8' });
const workConfigSrc = read('src/routes/config.js');

function braceSlice(src, fromIdx) {
  let i = src.indexOf('{', fromIdx);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(fromIdx, i + 1); }
  }
  return null;
}
function extractExportedFn(src, name, { async: isAsync = false } = {}) {
  const needle = `export ${isAsync ? 'async ' : ''}function ${name}(`;
  const at = src.indexOf(needle);
  if (at === -1) return null;
  const whole = braceSlice(src, at);
  return whole ? whole.replace(/^export /, '') : null;
}

const headCompareSrc = extractExportedFn(headConfigSrc, 'compareSemver');
const workCompareSrc = extractExportedFn(workConfigSrc, 'compareSemver');
ok(!!headCompareSrc && !!workCompareSrc, '§2 extracted compareSemver from BOTH revisions');
// HEAD's is self-contained; the working tree's needs the lifted parse supplied
// by name, exactly as the module supplies it.
const headCompare = new Function(`${headCompareSrc}; return compareSemver;`)();
const workCompare = new Function('parseVersionCore',
  `${workCompareSrc}; return compareSemver;`)(configRoute.parseVersionCore);

const VERSION_SAMPLES = [
  '3.30.0', '3.29.0', '3.9.0', '3.10.0', '3.0.1', '3.0.1-beta.27', '3.0.1+build.5',
  '4.0.0', '3.99.99', '0.0.0', '1', '1.2', '1.2.3.4', '1.2.3.4.5', '',
  '  3.30.0  ', 'v3.30.0', 'nightly', 'main', '3.a.0', '-1.0.0', '3..0',
];
let cmpCells = 0, cmpAgree = 0, cmpDistinct = new Set();
for (const a of VERSION_SAMPLES) {
  for (const b of VERSION_SAMPLES) {
    cmpCells++;
    const h = Math.sign(headCompare(a, b));
    const w = Math.sign(workCompare(a, b));
    cmpDistinct.add(h);
    if (h === w) cmpAgree++;
    else ok(false, `§2 comparator DISAGREEMENT on (${JSON.stringify(a)}, ${JSON.stringify(b)}): head=${h} work=${w}`);
  }
}
eq(cmpAgree, cmpCells, `§2 HEAD and HEAD+change agree on all ${cmpCells} comparator cells`);
// Non-string inputs too — the parse's typeof guard is load-bearing.
for (const v of [null, undefined, 42, {}, [], NaN]) {
  eq(Math.sign(headCompare(v, '3.0.0')), Math.sign(workCompare(v, '3.0.0')),
    `§2 agree on a non-string input ${String(v)}`);
}
ok(cmpDistinct.size >= 3, `§2 CONTROL: the matrix exercises all three outcomes (got ${[...cmpDistinct].sort().join(',')})`);
ok(headCompare('3.30.0', '3.9.0') === 1 && headCompare('3.9.0', '3.30.0') === -1,
  '§2 CONTROL: the comparator under test is not a constant function');

// The new predicate must agree with the comparator's OWN parse, or "we cannot
// compare" and "they are equal" drift apart again. Cross-checked against a
// sentinel no real version reaches rather than against a second copy of the
// parse — a duplicate parse in the test would prove the two copies agree with
// each other, not with the comparator.
const SENTINEL = '999999.999999.999999';
for (const v of VERSION_SAMPLES) {
  const viaComparator = workCompare(v, SENTINEL) < 0;
  eq(configRoute.isComparableVersion(v), viaComparator,
    `§2 isComparableVersion(${JSON.stringify(v)}) agrees with the comparator's own parse`);
}
ok(configRoute.parseVersionCore('3.30.0') instanceof Array, '§2 parseVersionCore returns segments for a real version');
eq(configRoute.parseVersionCore('nightly'), null, '§2 and null for one it cannot read');
eq(configRoute.parseVersionCore('1.2.3.4.5'), null, '§2 and null for an absurd segment count');
eq(configRoute.isComparableVersion(''), false, '§2 an empty string is NOT comparable');
eq(configRoute.isComparableVersion(null), false, '§2 nor is null');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  pickInstallableRelease — against the REAL measured payload');
// ═══════════════════════════════════════════════════════════════════════════
//
// THIS FIXTURE IS THE FINDING. Transcribed from a live, unauthenticated
// `GET /repos/talirezun/the-curator/releases` on 2026-08-31 (trimmed to the
// fields the picker reads). Five releases; EXACTLY ONE carries a `.dmg`, and
// it is flagged `prerelease: true`. Meanwhile `/releases/latest` — which is
// defined as "newest non-draft, non-prerelease" — answers v3.9.0, whose asset
// list is EMPTY.
//
// So the obvious implementation (`/releases/latest`) would have told a v3.30.0
// DMG user they were AHEAD of the published version, forever, and if it had
// ever offered anything it would have pointed at a page with no download. The
// selection rule is therefore "newest release carrying an installer", and the
// pre-release flag is DISCLOSED rather than used as a filter.

const REAL_RELEASES = [
  { tag_name: 'v3.30.0', prerelease: true, draft: false, published_at: '2026-08-31T08:45:24Z',
    name: 'v3.30.0 — first Mac app (unsigned preview)',
    html_url: 'https://github.com/talirezun/the-curator/releases/tag/v3.30.0',
    assets: [{ name: 'TheCurator-3.30.0-arm64-AppleSilicon.dmg' }, { name: 'TheCurator-3.30.0-x64-Intel.dmg' }] },
  { tag_name: 'v3.9.0', prerelease: false, draft: false, published_at: '2026-08-25T21:14:57Z',
    name: 'v3.9.0 — the redesign becomes the app',
    html_url: 'https://github.com/talirezun/the-curator/releases/tag/v3.9.0', assets: [] },
  { tag_name: 'v3.8.0', prerelease: false, draft: false, published_at: '2026-08-24T00:00:00Z',
    name: 'v3.8.0', html_url: 'https://github.com/talirezun/the-curator/releases/tag/v3.8.0', assets: [] },
  { tag_name: 'v3.0.0-beta.1', prerelease: true, draft: false, published_at: '2026-08-01T00:00:00Z',
    name: 'v3.0.0-beta.1', html_url: 'https://github.com/talirezun/the-curator/releases/tag/v3.0.0-beta.1', assets: [] },
  { tag_name: 'v2.1.0', prerelease: false, draft: false, published_at: '2026-07-01T00:00:00Z',
    name: 'v2.1.0', html_url: 'https://github.com/talirezun/the-curator/releases/tag/v2.1.0', assets: [] },
];

const P = configRoute.pickInstallableRelease;
{
  // GUARDED. A picker that returns null here would otherwise take the whole
  // run down with a raw TypeError, leaving the tally wrong and naming no
  // expectation — the v3.24.1 "crash instead of a named assertion" shape.
  // Found by mutation M3.
  const r = P(REAL_RELEASES) || {};
  ok(Object.keys(r).length > 0, '§3 a release is selected from the real payload');
  eq(r.version, '3.30.0', '§3 it is v3.30.0 — the ONLY one carrying an installer');
  eq(r.prerelease, true, '§3 and its pre-release status is REPORTED, not used to exclude it');
  eq(r.url, 'https://github.com/talirezun/the-curator/releases/tag/v3.30.0', '§3 with its own release page');
  eq(r.tagName, 'v3.30.0', '§3 and its tag');
  eq(r.publishedAt, '2026-08-31T08:45:24Z', '§3 and its publication time');
}
{
  // THE CONTROL THAT MAKES THE FINDING NON-VACUOUS: the newest release with NO
  // pre-release flag is v3.9.0, which has no installer. If the picker had used
  // `prerelease === false` as a filter it would return nothing at all here.
  const stable = REAL_RELEASES.filter(r => !r.prerelease);
  eq(P(stable), null,
    '§3 CONTROL: filtering pre-releases out of the REAL payload leaves NOTHING installable — the feature would be dead on arrival');
}

// Ordering is by semver, not by the listing's order.
eq(P([
  { tag_name: 'v3.10.0', draft: false, prerelease: false, html_url: 'https://github.com/a/b/releases/tag/v3.10.0', assets: [{ name: 'x.dmg' }] },
  { tag_name: 'v3.9.0', draft: false, prerelease: false, html_url: 'https://github.com/a/b/releases/tag/v3.9.0', assets: [{ name: 'x.dmg' }] },
].reverse())?.version, '3.10.0', '§3 3.10.0 beats 3.9.0 numerically, whatever order the list arrives in');
eq(P([
  { tag_name: 'v3.9.0', draft: false, prerelease: false, html_url: 'https://github.com/a/b/releases/tag/v3.9.0', assets: [{ name: 'x.dmg' }] },
  { tag_name: 'v3.31.0', draft: false, prerelease: true, html_url: 'https://github.com/a/b/releases/tag/v3.31.0', assets: [{ name: 'x.dmg' }] },
])?.version, '3.31.0', '§3 a newer PRE-RELEASE with an installer wins over an older stable one with an installer');

// Filters.
eq(P([{ tag_name: 'v9.9.9', draft: true, prerelease: false, html_url: 'https://github.com/a/b', assets: [{ name: 'x.dmg' }] }]), null,
  '§3 a DRAFT is skipped');
eq(P([{ tag_name: 'v9.9.9', draft: false, prerelease: false, html_url: 'https://github.com/a/b', assets: [{ name: 'notes.txt' }] }]), null,
  '§3 a release with no installer asset is skipped');
eq(P([{ tag_name: 'v9.9.9', draft: false, prerelease: false, html_url: 'https://github.com/a/b', assets: [{ name: 'App.DMG' }] }])?.version, '9.9.9',
  '§3 the asset match is case-insensitive');

// Malformed shapes DEGRADE, never throw. (An unexpected response is one of the
// three failure modes the brief required to be handled.)
for (const bad of [null, undefined, 42, 'nope', {}, { releases: [] }]) {
  eq(P(bad), null, `§3 a non-array payload (${JSON.stringify(bad)}) yields null rather than throwing`);
}
eq(P([null, undefined, 7, 'x', { assets: null }, { tag_name: 'v1.0.0', assets: 'nope' }]), null,
  '§3 junk members are skipped one by one');
eq(P([{ tag_name: 'v1.0.0', draft: false, assets: [null, 7, {}, { name: 5 }, { name: 'a.dmg' }] }])?.version, '1.0.0',
  '§3 junk ASSETS are skipped without hiding the real one');
{
  // A non-github html_url must not be echoed into an href.
  const r = P([{ tag_name: 'v1.0.0', draft: false, html_url: 'javascript:alert(1)', assets: [{ name: 'a.dmg' }] }]) || {};
  eq(r.url, configRoute.RELEASES_PAGE_URL,
    '§3 a URL that is not an https://github.com/ address falls back to the releases page — never echoed');
}
{
  const r = P([{ tag_name: 'nightly', draft: false, html_url: 'https://github.com/a/b', assets: [{ name: 'a.dmg' }] }]) || {};
  eq(r.version, 'nightly', '§3 an uncomparable tag still selects (the CALLER reports "cannot compare")');
  eq(configRoute.isComparableVersion(r.version), false, '§3 and it is correctly flagged uncomparable');
}
{
  const r = P([
    { tag_name: 'nightly', draft: false, html_url: 'https://github.com/a/b', assets: [{ name: 'a.dmg' }] },
    { tag_name: 'v2.0.0', draft: false, html_url: 'https://github.com/a/b', assets: [{ name: 'a.dmg' }] },
  ]) || {};
  eq(r.version, '2.0.0', '§3 a COMPARABLE tag is preferred over an uncomparable one when both carry installers');
}
eq(configRoute.versionFromTag('v3.30.0'), '3.30.0', '§3 versionFromTag strips a leading v');
eq(configRoute.versionFromTag('3.30.0'), '3.30.0', '§3 and leaves a bare version alone');
eq(configRoute.versionFromTag('version-3'), 'version-3', '§3 and does NOT strip a v that is not a version prefix');
eq(configRoute.versionFromTag(''), null, '§3 and refuses an empty tag');

// ═══════════════════════════════════════════════════════════════════════════
section('§4  decideInstallerUpdate — three outcomes, not two');
// ═══════════════════════════════════════════════════════════════════════════
//
// It is NOT `decideUpdateAvailable`. That one has a commit dimension and a
// deliberate STRING-INEQUALITY fallback for uncomparable versions, because on
// the git path `commitsDiffer` still exists to fall back on. Here there are no
// commits and the offer is a download link, so a string inequality would
// present a sideways move as an update.

const DI = configRoute.decideInstallerUpdate;
{
  const v = DI({ current: '3.30.0', latest: '3.31.0' });
  ok(v.updateAvailable && !v.localAhead && v.comparable, '§4 remote newer -> update available');
}
{
  const v = DI({ current: '3.31.0', latest: '3.30.0' });
  ok(!v.updateAvailable && v.localAhead, '§4 local newer -> localAhead, and NOT an update (never a downgrade link)');
}
{
  const v = DI({ current: '3.30.0', latest: '3.30.0' });
  ok(!v.updateAvailable && !v.localAhead && v.comparable, '§4 equal -> nothing to do');
}
{
  const v = DI({ current: '3.30.0', latest: 'nightly' });
  eq(v.comparable, false, '§4 an unreadable published version is reported as NOT COMPARABLE');
  eq(v.updateAvailable, false, '§4 and is never offered as an update');
  eq(v.localAhead, false, '§4 and is never guessed to be behind us either');
}
{
  // THE DIVERGENCE FROM THE GIT VERDICT, asserted directly rather than argued.
  const args = { current: '3.30.0', latest: '3.30.0-rc1' };
  eq(configRoute.decideUpdateAvailable({ ...args, localCommit: null, remoteCommit: null }).updateAvailable, true,
    '§4 CONTROL: the GIT verdict calls equal-core/different-string an update (its string fallback, correct there)');
  eq(DI(args).updateAvailable, false,
    '§4 the INSTALLER verdict does not — a sideways move must never render as a download offer');
}
eq(DI({ current: null, latest: '3.30.0' }).comparable, false, '§4 an unreadable LOCAL version is also not comparable');

// ═══════════════════════════════════════════════════════════════════════════
section('§5  classifyReleaseFailure — and the rule it exists to keep');
// ═══════════════════════════════════════════════════════════════════════════
//
// THE RULE: "you are up to date" and "we could not check" must never share
// wording or a code path that makes them indistinguishable. Every failure body
// here carries an `error` field — which is what BOTH frontends key their
// failure box on — and carries NO `updateAvailable`, so nothing downstream can
// read a failure as a reassuring false.

const CF = configRoute.classifyReleaseFailure;
const FAILURES = [
  ['network', CF('network')],
  ['403 rate limit', CF('http', 403, new Map([['x-ratelimit-remaining', '0']]))],
  ['429 rate limit', CF('http', 429, new Map([['x-ratelimit-remaining', '0']]))],
  ['500 upstream', CF('http', 500, new Map([['x-ratelimit-remaining', '58']]))],
  ['403 not rate limit', CF('http', 403, new Map([['x-ratelimit-remaining', '58']]))],
  ['bad shape', CF('shape')],
];
for (const [name, f] of FAILURES) {
  ok(typeof f.body.error === 'string' && f.body.error.length > 20, `§5 ${name}: carries an actionable error sentence`);
  ok(f.body.updateAvailable === undefined, `§5 ${name}: carries NO updateAvailable — it cannot read as "you're fine"`);
  ok(typeof f.body.reason === 'string', `§5 ${name}: carries a machine-readable reason code`);
  ok(!/up to date|up-to-date/i.test(f.body.error), `§5 ${name}: shares no wording with the up-to-date message`);
  eq(f.status, 502, `§5 ${name}: is a 502 — an upstream failure, not a local one`);
}
eq(CF('network').body.reason, 'unreachable', '§5 offline is reported as `unreachable`');
eq(CF('http', 403, new Map([['x-ratelimit-remaining', '0']])).body.reason, 'rate-limited',
  '§5 a 403 WITH x-ratelimit-remaining:0 is reported as rate-limited');
eq(CF('http', 403, new Map([['x-ratelimit-remaining', '58']])).body.reason, 'http-error',
  '§5 a 403 WITHOUT the exhausted header is NOT called a rate limit (the header is what tells them apart)');
eq(CF('http', 429, new Map([['x-ratelimit-remaining', '0']])).body.reason, 'rate-limited',
  '§5 the newer 429 form is caught too');
ok(/within an hour/i.test(CF('http', 429, new Map([['x-ratelimit-remaining', '0']])).body.error),
  '§5 and the rate-limit message says the wait is bounded');
eq(CF('shape').body.reason, 'unexpected-response', '§5 an unreadable body is its own reason');
// Header access must work for a plain object as well as a Headers/Map — a
// fetch stub that returns `{headers:{...}}` is the common shape.
eq(CF('http', 403, { 'x-ratelimit-remaining': '0' }).body.reason, 'rate-limited',
  '§5 the header reader handles a plain object as well as a Headers-like');
eq(CF('http', 403, null).body.reason, 'http-error', '§5 and absent headers degrade rather than throw');
// Every distinct reason has DISTINCT prose.
{
  const msgs = FAILURES.map(([, f]) => f.body.error);
  const byReason = new Map();
  for (const [, f] of FAILURES) byReason.set(f.body.reason, f.body.error);
  eq(new Set(byReason.values()).size, byReason.size,
    '§5 every distinct reason code has its own distinct sentence (no two failures read the same)');
  ok(msgs.every(m => !/capability/i.test(m)),
    '§5 and none of them names an internal capability identifier at the user (the whole defect)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  REPO MODE IS UNCHANGED — proven by running both revisions');
// ═══════════════════════════════════════════════════════════════════════════
//
// Inserting a branch above a body shows in a diff as a pure insertion, and a
// pure insertion looks reassuring. It says nothing about whether the surviving
// arm is still REACHED with the same inputs. So: extract the handler from HEAD
// and from the working tree, compile both with the SAME fakes, run the SAME
// matrix — and require them to DISAGREE when the caps are stubbed to the
// packaged build, or the agreement above is satisfied by a branch that does
// nothing.

const headCheck = extractExportedFn(headConfigSrc, 'updateCheckHandler', { async: true });
const workCheck = extractExportedFn(workConfigSrc, 'updateCheckHandler', { async: true });
ok(!!headCheck && !!workCheck, '§6 extracted updateCheckHandler from BOTH revisions');
ok(/^async function updateCheckHandler/.test(headCheck || '') &&
   /^async function updateCheckHandler/.test(workCheck || ''),
  '§6 both extractions are callable function sources (a desynced matcher would not be)');

function fakeRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// One compiler for both revisions. Every collaborator is supplied by name, so
// HEAD (which reads them from module scope) and the working tree (which reads
// them through `deps ||` defaults) close over the SAME fakes. Nothing here
// touches a real file or the network. `installerUpdateCheck` is module-private
// in the working tree and does not exist at HEAD, so it is supplied as a
// recording stub — which is also what makes the disagreement control legible.
function compileCheck(fnSrc, io) {
  // eslint-disable-next-line no-new-func
  const make = new Function(
    'getCapabilities', 'capabilityRefusal', 'defaultExec', 'defaultFetch',
    'readFileSync', 'path', 'PROJECT_ROOT', 'SUBPROCESS_ENV',
    'decideUpdateAvailable', 'getReleaseRef', 'installerUpdateCheck',
    `${fnSrc}; return updateCheckHandler;`
  );
  return make(
    () => io.caps,
    installMode.capabilityRefusal,
    io.exec, io.fetch,
    () => JSON.stringify({ version: io.localVersion }),
    { join: (...p) => p.join('/') },
    '/APP', { PATH: '/usr/bin' },
    configRoute.decideUpdateAvailable,
    () => ({ channel: 'stable', branch: 'main' }),
    async (res) => { io.installerCalls.push(1); return res.json({ INSTALLER_ARM: true }); },
  );
}
const CHECK_INPUTS = [
  { name: 'remote newer', localVersion: '3.25.0', remoteVersion: '3.26.0', localSha: 'aaaaaaa', remoteSha: 'bbbbbbb' },
  { name: 'identical', localVersion: '3.26.0', remoteVersion: '3.26.0', localSha: 'aaaaaaa', remoteSha: 'aaaaaaa' },
  { name: 'local ahead', localVersion: '3.31.0', remoteVersion: '3.30.0', localSha: 'aaaaaaa', remoteSha: 'bbbbbbb' },
  { name: 'same version, new commits', localVersion: '3.30.0', remoteVersion: '3.30.0', localSha: 'aaaaaaa', remoteSha: 'bbbbbbb' },
  { name: 'unparseable local', localVersion: 'nightly', remoteVersion: '3.30.0', localSha: 'aaaaaaa', remoteSha: 'bbbbbbb' },
  { name: 'not a git repo', localVersion: '3.30.0', remoteVersion: '3.31.0', gitThrows: true, remoteSha: 'bbbbbbb' },
  { name: 'raw.githubusercontent is down', localVersion: '3.30.0', rawNotOk: true, localSha: 'aaaaaaa' },
  { name: 'commit API is down', localVersion: '3.30.0', remoteVersion: '3.31.0', localSha: 'aaaaaaa', commitThrows: true },
  { name: 'commit API answers non-ok', localVersion: '3.30.0', remoteVersion: '3.31.0', localSha: 'aaaaaaa', commitNotOk: true },
  { name: 'network is entirely down', localVersion: '3.30.0', fetchThrows: true, localSha: 'aaaaaaa' },
];
async function runCheck(fnSrc, caps, input) {
  const calls = { exec: [], fetch: [] };
  const installerCalls = [];
  const io = {
    caps, localVersion: input.localVersion, installerCalls,
    exec: async (cmd) => {
      calls.exec.push(cmd);
      if (input.gitThrows) throw new Error('not a git repository');
      return { stdout: `${input.localSha}\n` };
    },
    fetch: async (url) => {
      calls.fetch.push(String(url));
      if (input.fetchThrows) throw new Error('ENOTFOUND');
      if (String(url).includes('raw.githubusercontent.com')) {
        if (input.rawNotOk) return { ok: false, status: 503 };
        return { ok: true, status: 200, json: async () => ({ version: input.remoteVersion }) };
      }
      if (input.commitThrows) throw new Error('api down');
      if (input.commitNotOk) return { ok: false, status: 500 };
      return { ok: true, status: 200, text: async () => `${input.remoteSha}0000000000` };
    },
  };
  const fn = compileCheck(fnSrc, io);
  const res = fakeRes();
  let threw = null;
  try { await fn({}, res, null); } catch (e) { threw = e.message; }
  return { status: res.statusCode, body: res.body, calls, installer: installerCalls.length, threw };
}

let checkSame = true;
const checkDiffs = [];
for (const input of CHECK_INPUTS) {
  const a = await runCheck(headCheck, REPO_CAPS, input);
  const b = await runCheck(workCheck, REPO_CAPS, input);
  if (JSON.stringify(a) !== JSON.stringify(b)) { checkSame = false; checkDiffs.push(input.name); }
}
ok(checkSame,
  `§6 HEAD and HEAD+change agree on ALL ${CHECK_INPUTS.length} inputs in repo mode — same status, same response body, ` +
  `same git commands, same URLs, in order` + (checkSame ? '' : ` — differed on: ${checkDiffs.join('; ')}`));

// THE CONTROL. Agreement in BOTH modes would mean the branch does nothing.
let checkDiffers = 0;
for (const input of CHECK_INPUTS) {
  const a = await runCheck(headCheck, BUNDLE_CAPS, input);
  const b = await runCheck(workCheck, BUNDLE_CAPS, input);
  if (JSON.stringify(a) !== JSON.stringify(b)) checkDiffers++;
}
eq(checkDiffers, CHECK_INPUTS.length,
  '§6 CONTROL: with the capability record stubbed to the packaged build the two DISAGREE on EVERY input (so the agreement above is not vacuous)');
{
  const a = await runCheck(headCheck, BUNDLE_CAPS, CHECK_INPUTS[0]);
  const b = await runCheck(workCheck, BUNDLE_CAPS, CHECK_INPUTS[0]);
  eq(a.status, 501, '§6 and the disagreement is the RIGHT one: HEAD answered 501…');
  eq(a.body.capability, 'canSelfUpdateViaGit', '§6 …naming the capability at the user…');
  eq(b.installer, 1, '§6 …while the working tree routes to the installer arm exactly once');
  eq(b.calls.exec.length, 0, '§6 and runs no subprocess getting there');
  eq(b.calls.fetch.length, 0, '§6 and makes no git-arm network call getting there');
}
// The third arm — neither git nor installer — must still refuse. Not a mode
// that exists today, which is exactly why it needs a test and not a belief.
{
  const NEITHER = { ...BUNDLE_CAPS, updateStyle: 'package-manager' };
  const r = await runCheck(workCheck, NEITHER, CHECK_INPUTS[0]);
  eq(r.status, 501, '§6 an install with neither update route still refuses');
  eq(r.installer, 0, '§6 and does NOT fall through to the installer arm');
  eq(r.calls.exec.length, 0, '§6 and runs no subprocess');
}
// And the whole thing is inert in production here.
ok(/updateCheckHandler\(req, res\)/.test(workConfigSrc),
  '§6 the production registration passes NO deps — the seam is null in production');

// ═══════════════════════════════════════════════════════════════════════════
section('§7  The installer arm, end to end, through the REAL exported handler');
// ═══════════════════════════════════════════════════════════════════════════
//
// §6 proves the fork happens. This drives the real shipped handler — the one
// registered on the router — with only `fetch` injected.

async function realCheck(fetchImpl, caps = BUNDLE_CAPS, releaseRef = undefined) {
  const execCalls = [];
  const res = fakeRes();
  // TRIPWIRE (v3.30.0's lesson). An offline suite that silently falls through
  // to the REAL `fetch` is green while testing nothing it claims — that shape
  // shipped once in this repo and passed only because undici refused the port.
  // Here the global is replaced for the duration of the call, so an
  // implementation that ignores the injected seam hits an assertion rather
  // than the network. Mutation M21 confirms it fires.
  const realFetch = globalThis.fetch;
  let escaped = 0;
  globalThis.fetch = async (...a) => { escaped++; throw new Error('ESCAPED TO THE REAL NETWORK'); };
  try {
    await configRoute.updateCheckHandler({}, res, {
      caps,
      execAsync: async (cmd) => { execCalls.push(cmd); return { stdout: '' }; },
      fetch: fetchImpl,
      ...(releaseRef ? { releaseRef } : {}),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  if (escaped) ok(false, '§7 TRIPWIRE: the handler escaped the injected fetch and reached the real network');
  return { status: res.statusCode, body: res.body, execCalls, escaped };
}
const okJson = (payload, extra = {}) => async () => ({
  ok: true, status: 200, headers: new Map(), json: async () => payload, ...extra,
});

{
  const seen = [];
  const r = await realCheck(async (url, opts) => {
    seen.push({ url: String(url), opts });
    return { ok: true, status: 200, headers: new Map(), json: async () => REAL_RELEASES };
  });
  eq(r.status, 200, '§7 the real handler ANSWERS 200 on the installer arm');
  eq(r.body.updateStyle, 'download-installer', '§7 and names the mechanism it used');
  eq(r.body.latest, '3.30.0', '§7 and reports the newest installable version');
  eq(r.body.prerelease, true, '§7 and discloses that it is a pre-release');
  eq(r.body.releaseUrl, 'https://github.com/talirezun/the-curator/releases/tag/v3.30.0', '§7 and its page');
  eq(r.body.releasesPageUrl, configRoute.RELEASES_PAGE_URL, '§7 and a fallback page');
  eq(r.body.channel, 'stable', '§7 and the RESOLVED release channel, so the answer stays inspectable');
  eq(r.body.localCommit, null, '§7 and null commit fields — this path has no commit dimension');
  eq(r.execCalls.length, 0, '§7 ZERO subprocesses run — no git, ever, on this arm');
  eq(seen.length, 1, '§7 exactly ONE network call is made');
  // GUARDED for the same reason §3 is: mutations M1 and M2 (which stop the
  // installer arm being reached at all) made every dereference below throw,
  // killing the run with a raw TypeError after four honest reds. A defect must
  // produce NAMED failures. `req` stands in so each assertion still runs and
  // still fails.
  const req = seen[0] || { url: '(no request was made)', opts: { headers: {} } };
  eq(req.url, configRoute.RELEASES_API_URL, '§7 to the release list, pinned');

  // NO USER DATA ON THE WIRE. The brief's rule, asserted rather than asserted-about.
  const wire = JSON.stringify(req);
  ok(!/produkcija|talirezun\/second-brain|\/Users\//.test(wire),
    '§7 the request carries no home path, no account name and no local identifier');
  ok(req.opts && !('body' in req.opts), '§7 it is a bare GET with no body');
  ok(!/Authorization|token|Bearer/i.test(JSON.stringify((req.opts || {}).headers || {})),
    '§7 and no credential of any kind — it works unauthenticated by design');
  eq(((req.opts || {}).headers || {})['User-Agent'], configRoute.RELEASES_USER_AGENT,
    '§7 the User-Agent is a fixed constant carrying no version and no hostname');
  ok((req.opts || {}).signal && typeof req.opts.signal.aborted === 'boolean',
    '§7 and the call is bounded by an abort signal rather than hanging forever');
  ok(!req.url.includes('?') || /^\?per_page=\d+$/.test(req.url.slice(req.url.indexOf('?'))),
    '§7 the only query parameter is a page size — nothing personal is ever put in a URL');
}
{
  const r = await realCheck(okJson([]));
  eq(r.status, 200, '§7 an EMPTY release list is not an error');
  eq(r.body.noInstallableRelease, true, '§7 it is its own fact');
  ok(r.body.error === undefined, '§7 with no `error` field, so no frontend renders it as a failure');
  eq(r.body.updateAvailable, false, '§7 and nothing is offered');
  eq(r.body.latest, null, '§7 and `latest` is null rather than a fabricated version');
}
{
  const r = await realCheck(async () => { throw new Error('ENOTFOUND api.github.com'); });
  eq(r.status, 502, '§7 offline is a 502');
  eq(r.body.reason, 'unreachable', '§7 with the `unreachable` reason');
  ok(r.body.updateAvailable === undefined, '§7 and NO updateAvailable field — it can never read as "up to date"');
  ok(!/ENOTFOUND/.test(JSON.stringify(r.body)), '§7 and the raw transport error never reaches the user');
  eq(r.body.current, '3.30.0', '§7 but the version the user IS running is still reported');
}
{
  const r = await realCheck(async () => ({ ok: false, status: 403, headers: new Map([['x-ratelimit-remaining', '0']]) }));
  eq(r.status, 502, '§7 a rate limit is a 502');
  eq(r.body.reason, 'rate-limited', '§7 with its own reason code');
  ok(/rate-limit/i.test(r.body.error), '§7 and its own sentence');
}
{
  const r = await realCheck(okJson({ message: 'Not Found' }));
  eq(r.body.reason, 'unexpected-response', '§7 a non-array body is an unexpected-response, not a crash');
  eq(r.status, 502, '§7 reported as an upstream failure');
}
{
  const r = await realCheck(async () => ({ ok: true, status: 200, headers: new Map(), json: async () => { throw new Error('bad json'); } }));
  eq(r.body.reason, 'unexpected-response', '§7 an unparseable body degrades the same way');
}
{
  const r = await realCheck(async () => null);
  eq(r.body.reason, 'http-error', '§7 a fetch stub returning nothing at all degrades rather than throwing');
}
{
  // The local-ahead case a DMG user would hit running a build newer than any
  // published one. It must NOT offer a link that installs backwards.
  const ahead = [{ tag_name: 'v1.0.0', draft: false, prerelease: false,
    html_url: 'https://github.com/talirezun/the-curator/releases/tag/v1.0.0', assets: [{ name: 'a.dmg' }] }];
  const r = await realCheck(okJson(ahead));
  eq((r.body || {}).localAhead, true, '§7 a copy newer than anything published reports localAhead');
  eq((r.body || {}).updateAvailable, false, '§7 and is NOT offered a download that would move it backwards');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  The Settings view — the old failure, the new verdicts, the copy');
// ═══════════════════════════════════════════════════════════════════════════

const headSettingsSrc = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:src/public/next/views/settings.js'], { encoding: 'utf8' });
const workSettingsSrc = read('src/public/next/views/settings.js');
function extractLocalFn(src, name) {
  const at = src.search(new RegExp(`(^|\\n)function ${name}\\s*\\(`));
  if (at === -1) return null;
  const start = src.indexOf(`function ${name}`, at);
  return braceSlice(src, start);
}
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── §8a  THE DEFECT, REPRODUCED FROM HEAD ──────────────────────────────────
// The "before" in the report is a measurement, not a memory: HEAD's real
// classifier and renderer, fed HEAD's real 501 body.
{
  const headSandbox = new Function('escapeHtml', 'state', 'crossWriteBusy', `
    ${extractLocalFn(headSettingsSrc, 'compareSemver')}
    ${extractLocalFn(headSettingsSrc, 'classifyUpdate')}
    ${extractLocalFn(headSettingsSrc, 'box')}
    ${extractLocalFn(headSettingsSrc, 'renderUpdateStatus')}
    return { classifyUpdate, renderUpdateStatus };`);
  const refusal = installMode.capabilityRefusal('canSelfUpdateViaGit', 'check for updates', {
    updateAvailable: false,
    hint: 'Packaged builds update through the app’s own updater, not this checkout-only git flow.',
  }).body;
  const state = {
    updatePhase: 'idle',
    // exactly what onCheckForUpdates does: `data.error ? { error: data.error } : data`
    updateCheck: { error: refusal.error },
    version: { version: '3.30.0', onDiskVersion: '3.30.0', restartRequired: false },
  };
  const s = headSandbox(escapeHtml, state, () => false);
  const html = s.renderUpdateStatus();
  eq(s.classifyUpdate(state.updateCheck, state.version).kind, 'error',
    '§8a BEFORE: a packaged build\'s 501 classified as a failed check');
  ok(/upd-bad/.test(html), '§8a BEFORE: rendered in the DANGER variant — the app looked broken');
  ok(/Couldn’t check for updates/.test(html), '§8a BEFORE: headline "Couldn’t check for updates"');
  ok(/canSelfUpdateViaGit/.test(html),
    '§8a BEFORE: with the internal capability identifier printed at the user (this is the defect)');
  // The word "install" DOES appear in that HTML — inside "This install does
  // not have the … capability", which is the problem rather than the remedy.
  // So the assertion is about ACTIONABILITY: no link, no page, no next step.
  ok(!/<a /.test(html), '§8a BEFORE: with no link out of the dead end');
  ok(!/github\.com/.test(html), '§8a BEFORE: and no page to go to');
  ok(!/download/i.test(html), '§8a BEFORE: and the word "download" appears nowhere');
}

// ── §8b  THE GIT PATH IS ADDITIVE-ONLY ─────────────────────────────────────
// The working tree's classifyUpdate gains a `style` field. Every key HEAD
// emitted must still be present with an IDENTICAL value, and `style` must be
// the ONLY addition, and always 'git-pull' on this path.
const headClassify = new Function(`
  ${extractLocalFn(headSettingsSrc, 'compareSemver')}
  ${extractLocalFn(headSettingsSrc, 'classifyUpdate')}
  return classifyUpdate;`)();
const workClassify = new Function(`
  ${extractLocalFn(workSettingsSrc, 'compareSemver')}
  ${extractLocalFn(workSettingsSrc, 'updateStyleOf')}
  ${extractLocalFn(workSettingsSrc, 'classifyInstallerUpdate')}
  ${extractLocalFn(workSettingsSrc, 'classifyUpdate')}
  return classifyUpdate;`)();

const CLASSIFY_INPUTS = [
  [null, null],
  [{ error: 'Could not reach GitHub' }, null],
  [{ current: '3.25.0', latest: '3.26.0', updateAvailable: true }, null],
  [{ current: '3.26.0', latest: '3.26.0', updateAvailable: false }, null],
  [{ current: '3.31.0', latest: '3.30.0', updateAvailable: true, localAhead: true }, null],
  [{ current: '3.30.0', latest: '3.30.0', updateAvailable: true, localCommit: 'aaa', remoteCommit: 'bbb' }, null],
  [{ current: 'nightly', latest: '3.30.0', updateAvailable: true }, null],
  [{ current: '3.30.0', latest: '3.31.0', updateAvailable: true },
   { version: '3.30.0', onDiskVersion: '3.31.0', restartRequired: true }],
  [{ error: 'boom' }, { version: '1', onDiskVersion: '2', restartRequired: true }],
];
let addSame = 0, addExtra = new Set();
for (const [check, ver] of CLASSIFY_INPUTS) {
  const h = headClassify(check, ver);
  const w = workClassify(check, ver);
  let identical = true;
  for (const k of Object.keys(h)) {
    if (JSON.stringify(h[k]) !== JSON.stringify(w[k])) {
      identical = false;
      ok(false, `§8b field "${k}" changed for ${JSON.stringify(check)}: ${JSON.stringify(h[k])} -> ${JSON.stringify(w[k])}`);
    }
  }
  for (const k of Object.keys(w)) if (!Object.hasOwn(h, k)) addExtra.add(k);
  if (identical) addSame++;
  ok(w.style === 'git-pull' || w.kind === 'idle',
    `§8b and the verdict for ${JSON.stringify(check)} stays on the git path`);
}
eq(addSame, CLASSIFY_INPUTS.length,
  `§8b every field HEAD's classifyUpdate emitted is unchanged across all ${CLASSIFY_INPUTS.length} git-path inputs`);
eq([...addExtra].sort().join(','), 'style', '§8b and `style` is the ONLY field added');
// Anti-vacuity: the matrix must actually reach several verdicts, or "unchanged"
// is satisfied by a matrix that only ever produces `idle`.
ok(new Set(CLASSIFY_INPUTS.map(([c, v]) => headClassify(c, v).kind)).size >= 5,
  '§8b CONTROL: the matrix reaches at least five distinct verdicts');

// ── §8c  THE INSTALLER VERDICTS AND THEIR RENDERING ────────────────────────
const view = new Function('escapeHtml', `
  ${extractLocalFn(workSettingsSrc, 'compareSemver')}
  ${extractLocalFn(workSettingsSrc, 'updateStyleOf')}
  ${extractLocalFn(workSettingsSrc, 'classifyInstallerUpdate')}
  ${extractLocalFn(workSettingsSrc, 'classifyUpdate')}
  ${extractLocalFn(workSettingsSrc, 'box')}
  ${extractLocalFn(workSettingsSrc, 'renderInstallerUpdateStatus')}
  return { classifyUpdate, renderInstallerUpdateStatus };`)(escapeHtml);

const INSTALLER_BASE = {
  updateStyle: 'download-installer', current: '3.30.0', channel: 'stable',
  releasesPageUrl: 'https://github.com/talirezun/the-curator/releases',
};
const SCENARIOS = {
  available: { ...INSTALLER_BASE, latest: '3.31.0', updateAvailable: true, localAhead: false, comparable: true,
    prerelease: true, releaseName: 'v3.31.0 — preview',
    releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/v3.31.0' },
  current: { ...INSTALLER_BASE, latest: '3.30.0', updateAvailable: false, localAhead: false, comparable: true,
    prerelease: true, releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/v3.30.0' },
  'local-ahead': { ...INSTALLER_BASE, latest: '3.29.0', updateAvailable: false, localAhead: true, comparable: true,
    releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/v3.29.0' },
  'no-release': { ...INSTALLER_BASE, latest: null, updateAvailable: false, localAhead: false, comparable: false,
    noInstallableRelease: true, releaseUrl: INSTALLER_BASE.releasesPageUrl },
  'unknown-version': { ...INSTALLER_BASE, latest: 'nightly', updateAvailable: false, localAhead: false,
    comparable: false, releaseUrl: 'https://github.com/talirezun/the-curator/releases/tag/nightly' },
};
const rendered = {};
for (const [kind, check] of Object.entries(SCENARIOS)) {
  const v = view.classifyUpdate(check, null);
  eq(v.kind, kind, `§8c a "${kind}" payload classifies as "${kind}"`);
  eq(v.style, 'download-installer', `§8c and stays on the installer path`);
  rendered[kind] = view.renderInstallerUpdateStatus(v);
  ok(rendered[kind].includes('upd-status'), `§8c and renders a status box`);
  // NOT the git button. Reaching it POSTs /api/config/update, which a packaged
  // build answers 501 — the user would see "Update failed" with a capability
  // string in it for clicking something that should not have existed.
  ok(!rendered[kind].includes('btn-apply-update'),
    `§8c "${kind}" never emits the git Install-update button`);
  ok(!rendered[kind].includes('btn-update-restart'),
    `§8c "${kind}" never emits the restart button either`);
  ok(!/capability|canSelfUpdateViaGit|updateStyle/.test(rendered[kind]),
    `§8c "${kind}" names no internal identifier at the user`);
}
// THE RULE. Five outcomes, five distinct headlines — a fact and its absence
// never share wording.
{
  const heads = Object.entries(rendered).map(([k, h]) => [k, (h.match(/upd-headline">([^<]*)</) || [])[1]]);
  for (const [k, h] of heads) ok(!!h, `§8c "${k}" has a headline`);
  eq(new Set(heads.map(([, h]) => h)).size, heads.length,
    `§8c all ${heads.length} outcomes have DISTINCT headlines (${heads.map(([, h]) => h).join(' / ')})`);
  const upToDate = heads.find(([k]) => k === 'current')[1];
  const noRelease = heads.find(([k]) => k === 'no-release')[1];
  ok(upToDate !== noRelease, '§8c "up to date" and "nothing published yet" are never the same sentence');
  ok(!/up to date/i.test(noRelease), '§8c and the second does not borrow the first\'s words');
}
// The download link.
{
  const html = rendered.available;
  ok(/<a class="btn btn-primary btn-xs" href="https:\/\/github\.com\/talirezun\/the-curator\/releases\/tag\/v3\.31\.0"/.test(html),
    '§8c the available box offers a LINK to the release page, styled with the existing .btn variants');
  ok(/target="_blank"/.test(html), '§8c opening in a new context — which desktop/main.js turns into shell.openExternal');
  ok(/rel="noopener noreferrer"/.test(html), '§8c with both rel tokens');
  ok(/pre-release/i.test(html), '§8c and the pre-release status is DISCLOSED, not hidden');
  ok(/can’t install this for itself/i.test(html), '§8c and it says plainly that the app will not do it for you');
  ok(!/box-shadow/.test(html), '§8c and adds no inline shadow to a focusable control');
  ok(!/style="/.test(html), '§8c and no inline styles at all — no new colour literals');
}
{
  ok(!/pre-release/i.test(rendered['local-ahead']), '§8c the local-ahead box does not mention a pre-release it is not offering');
  ok(/nothing to install/i.test(rendered['local-ahead']), '§8c it says there is nothing to install');
  ok(!/push it|unpushed/i.test(rendered['local-ahead']),
    '§8c and it does NOT tell a DMG user to push their unpushed work (the git arm\'s copy, nonsense here)');
}
// Escaping: everything the server sends is attacker-influenceable in principle
// (it is a release title on a public host).
{
  const v = view.classifyUpdate({ ...SCENARIOS.available,
    releaseName: '<img src=x onerror=alert(1)>',
    releaseUrl: 'https://github.com/a/b"><script>alert(1)</script>' }, null);
  const html = view.renderInstallerUpdateStatus(v);
  ok(!/<img|<script/.test(html), '§8c a hostile release name and URL are escaped, never interpolated raw');
  ok(html.includes('&lt;img'), '§8c and the escaped form is what lands in the document');
}
// A payload with no URL at all must not emit a dead link.
{
  const v = view.classifyUpdate({ ...SCENARIOS.available, releaseUrl: null, releasesPageUrl: null }, null);
  const html = view.renderInstallerUpdateStatus(v);
  ok(!/<a /.test(html), '§8c with no URL the box renders NO link rather than an href to nothing');
  ok(/upd-status/.test(html), '§8c but still tells the user an update exists');
}

// THE CALL SITE, not just the function. Everything above drives
// `renderInstallerUpdateStatus` directly, which is satisfied by a renderer
// nothing reaches — this repo's recorded "function executed but its call site
// never asserted" shape (v3.26.0 M6). `renderUpdateStatus` is what the view
// actually calls, so it is driven here, through real `state`.
{
  const mkStatus = (state) => new Function('escapeHtml', 'state', 'crossWriteBusy', `
    ${extractLocalFn(workSettingsSrc, 'compareSemver')}
    ${extractLocalFn(workSettingsSrc, 'updateStyleOf')}
    ${extractLocalFn(workSettingsSrc, 'classifyInstallerUpdate')}
    ${extractLocalFn(workSettingsSrc, 'classifyUpdate')}
    ${extractLocalFn(workSettingsSrc, 'box')}
    ${extractLocalFn(workSettingsSrc, 'renderInstallerUpdateStatus')}
    ${extractLocalFn(workSettingsSrc, 'renderUpdateStatus')}
    return renderUpdateStatus;`)(escapeHtml, state, () => false);

  const ver = { version: '3.30.0', onDiskVersion: '3.30.0', restartRequired: false };
  const html = mkStatus({ updatePhase: 'idle', updateCheck: SCENARIOS.available, version: ver })();
  eq(html, rendered.available,
    '§8c CALL SITE: renderUpdateStatus DISPATCHES an installer payload to the installer renderer, byte for byte');
  ok(!html.includes('btn-apply-update'),
    '§8c CALL SITE: so the git Install-update button is unreachable for a packaged build');

  // …and the git payload still reaches the git renderer, unchanged.
  const gitHtml = mkStatus({ updatePhase: 'idle',
    updateCheck: { current: '3.25.0', latest: '3.26.0', updateAvailable: true }, version: ver })();
  ok(gitHtml.includes('btn-apply-update'),
    '§8c CALL SITE CONTROL: a git payload still renders the Install-update button (the dispatch is a fork, not a takeover)');
  ok(!gitHtml.includes('<a '), '§8c CALL SITE CONTROL: and no download link appears on the git path');
}

// ── §8d  THE COPY THAT MUST BE RIGHT BEFORE ANY CHECK RUNS ─────────────────
{
  const stripped = workSettingsSrc;
  ok(/UPDATE_RECOVERY_INFO_INSTALLER/.test(stripped),
    '§8d the "how to go back" panel has an installer variant');
  const gitInfo = (stripped.match(/const UPDATE_RECOVERY_INFO =\s*([\s\S]*?);\n/) || [])[1] || '';
  const instInfo = (stripped.match(/const UPDATE_RECOVERY_INFO_INSTALLER =\s*([\s\S]*?);\n/) || [])[1] || '';
  ok(gitInfo.length > 100 && instInfo.length > 100, '§8d both variants have real text');
  ok(/git checkout|git fetch/.test(gitInfo), '§8d CONTROL: the git variant really is git advice');
  ok(!/git |checkout|npm install|~\/the-curator/.test(instInfo),
    '§8d and the installer variant contains NO git command, no checkout and no app-folder path — none of which exist there');
  // The recorded trap: revert copy describing a path that does not exist.
  ok(!/you can go back to|revert/i.test(instInfo),
    '§8d and it never promises a rollback — only ONE release carries an installer today, so a promise would be false');
  ok(/releases/.test(instInfo), '§8d it points at the page that is the authority on what can be reinstalled');
}
{
  const fn = extractLocalFn(workSettingsSrc, 'installUpdateStyle') || '';
  ok(/capabilities/.test(fn) && /download-installer/.test(fn),
    '§8d installUpdateStyle reads the CAPABILITY off /api/version, not the install form');
  const style = new Function('state', `${fn}; return installUpdateStyle;`);
  eq(style({ version: { capabilities: { updateStyle: 'download-installer' } } })(), 'download-installer',
    '§8d a packaged build resolves to the installer copy');
  eq(style({ version: null })(), 'git-pull', '§8d and an absent /api/version falls to git-pull — the fail-safe direction');
  eq(style({ version: { capabilities: {} } })(), 'git-pull', '§8d as does a capability record without the key');
  eq(style({ version: { capabilities: { updateStyle: '__proto__' } } })(), 'git-pull',
    '§8d and a prototype key is not a mechanism');
}
{
  // onApplyUpdate must refuse the installer path even though its button is
  // never emitted — a second, independent refusal, because the first one is a
  // rendering decision and rendering decisions get edited.
  const src = workSettingsSrc.slice(workSettingsSrc.indexOf('function onApplyUpdate('));
  const body = braceSlice(src, 0);
  ok(/v\.style !== 'git-pull'/.test(body),
    '§8d onApplyUpdate refuses anything that is not the git path before it can POST /api/config/update');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9  The release-channel tripwire');
// ═══════════════════════════════════════════════════════════════════════════
//
// `stable` is the only channel this build defines, and it maps to a git
// BRANCH, which means nothing to a release listing. The installer arm is
// therefore channel-independent TODAY, and that is a fact with an expiry date:
// the day a second channel exists, "which releases count as this channel's"
// becomes a real question with a real answer, and this is one of the two sites
// that must gain a branch (the other is the `git fetch` refspec, whose trap is
// written up in src/brain/config.js). This fails the moment that day arrives.
{
  const names = brainConfig.releaseChannelNames();
  eq(names.length, 1,
    `§9 exactly one release channel is defined (${names.join(', ')}) — if this fails, the installer arm in ` +
    'src/routes/config.js must decide whether a second channel changes which releases it offers, ' +
    'and this assertion must be replaced by that decision');
  eq(names[0], 'stable', '§9 and it is `stable`');
  eq(brainConfig.getReleaseRef().channel, 'stable', '§9 which is what getReleaseRef resolves to');
  // ── M19 CAME BACK GREEN, AND THIS IS THE FIX ────────────────────────────
  // Replacing `const { channel } = getReleaseRef()` with a hardcoded
  // `'stable'` changed NOTHING observable — every assertion passed, because
  // `stable` is the only channel that exists and the two agree on every input
  // reachable today. A source scan could not close it either: `getReleaseRef`
  // is also called by the git arm, so the regex matches whether the installer
  // arm resolves or not. What closes it is DRIVING the resolution seam and
  // requiring the answer to move: a hardcoded literal cannot echo a channel it
  // was never handed.
  const echoed = await realCheck(okJson([]), BUNDLE_CAPS, { channel: 'zzchannel', branch: 'zzbranch' });
  eq(echoed.body.channel, 'zzchannel',
    '§9 the installer arm REPORTS the channel it resolved, rather than a literal it was born with');
  const dflt = await realCheck(okJson([]), BUNDLE_CAPS);
  eq(dflt.body.channel, 'stable',
    '§9 CONTROL: and with no injection it resolves to the real one, so the assertion above is not testing the seam alone');
}
{
  // The fail-safe: a channel written by a newer build must not break the check.
  eq(brainConfig.resolveReleaseChannel('canary'), 'stable', '§9 an unknown channel resolves to stable, never refuses');
  eq(brainConfig.resolveReleaseChannel('__proto__'), 'stable', '§9 and a prototype key is not a channel');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§10  Anti-vacuity, and what is NOT enforced');
// ═══════════════════════════════════════════════════════════════════════════

// The handlers under test are the real exported ones, not stubs.
ok(typeof configRoute.updateCheckHandler === 'function' && configRoute.updateCheckHandler.length === 2,
  '§10 updateCheckHandler is the real exported handler with the (req, res, deps) signature');
for (const name of ['pickInstallableRelease', 'decideInstallerUpdate', 'classifyReleaseFailure',
  'parseVersionCore', 'isComparableVersion', 'versionFromTag']) {
  ok(typeof configRoute[name] === 'function', `§10 ${name} is exported and executable (not source-scanned)`);
}
eq(configRoute.RELEASES_API_URL.startsWith('https://api.github.com/'), true, '§10 the API URL is https and GitHub');
eq(configRoute.RELEASES_PAGE_URL, 'https://github.com/talirezun/the-curator/releases', '§10 the page URL is pinned');
ok(configRoute.RELEASES_TIMEOUT_MS > 0 && configRoute.RELEASES_TIMEOUT_MS <= 30000,
  '§10 the timeout is bounded and non-zero');
ok(Object.isFrozen(configRoute.INSTALLER_ASSET_EXTENSIONS), '§10 the installer extension list is frozen');

// The extractors must have found real code, or every §6 and §8 comparison is a
// comparison of two empty strings.
ok((headCheck || '').length > 800 && (workCheck || '').length > 800,
  `§10 CONTROL: both extracted handlers are substantial (head ${(headCheck || '').length}B, work ${(workCheck || '').length}B) — an empty extraction would make §6 vacuous`);
ok((extractLocalFn(headSettingsSrc, 'renderUpdateStatus') || '').length > 500,
  '§10 CONTROL: HEAD\'s renderUpdateStatus extracted (§8a would be vacuous otherwise)');
ok(headSettingsSrc !== workSettingsSrc, '§10 CONTROL: the two settings.js revisions genuinely differ');
ok(!headConfigSrc.includes('pickInstallableRelease'),
  '§10 CONTROL: HEAD really predates this change, so §6\'s pre/post comparison is meaningful');

// ── WHAT THIS SUITE DOES NOT PROVE. Named, not implied away. ───────────────
//
//  1. THE INSTALLER ARM HAS NEVER RUN INSIDE A REAL PACKAGED BUILD. This
//     checkout is repo mode (asserted in §1), `desktop/` has its own agent, and
//     nothing here launches Electron. The fork is proven; the environment it
//     forks for is simulated by a capability record.
//  2. NO BROWSER RENDERS ANY OF §8. The HTML is compared as strings. Contrast,
//     cascade, focus ring and the reduced-motion behaviour of the new link are
//     NOT measured — the box reuses `.upd-status` and `.btn`, both of which
//     already have live coverage, and the only new CSS is one
//     `text-decoration` declaration.
//  3. `shell.openExternal` IS NOT EXERCISED. That the packaged app opens the
//     link in the user's own browser rests on reading
//     `desktop/main.js`'s `setWindowOpenHandler`, which this agent may not
//     touch and did not run.
//  4. THE LIVE GITHUB RESPONSE IS A TRANSCRIPTION. §3's fixture was measured
//     once, by hand, on 2026-08-31. If GitHub changes the field names this
//     suite stays green and the feature breaks — the shape guards in §3 and §7
//     bound the DAMAGE (it degrades to "unexpected response"), not the risk.
//  5. RATE-LIMIT DETECTION IS TESTED AGAINST A SIMULATED HEADER. No real 403
//     was provoked.
//  6. `/old` (`src/public/app.js`) IS UNTOUCHED AND STILL BROKEN HERE. It reads
//     `data.updateAvailable` with no style awareness, so a packaged build
//     serving `/old` would still show the git flow. It is the frozen bundle and
//     was out of scope; this is a report, not a fix.

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
const fpAfter = fingerprint();
ok(fpAfter === fpBefore, 'the real credential files are byte-identical after the run (sha256 + size + existence)');
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
