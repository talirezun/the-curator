/**
 * test-cutover.js — OFFLINE suite for the cutover: the release where "/"
 * stops serving the shipping frontend and starts serving the /next shell,
 * the shipping app moves to "/old", and an existing user gets a one-time
 * dismissible notice with a way back.
 *
 * No network, no API key, no server, no browser. The notice's decision logic
 * is written as pure functions with no DOM and no fetch precisely so it can
 * be driven here; they are extracted from the REAL source by brace matching
 * and evaluated standalone with `new Function` — the technique
 * scripts/test-next-onboarding.js and scripts/test-chat-markdown.js use.
 *
 * ── WHAT "THE CUTOVER IS COVERED" DOES AND DOES NOT MEAN ────────────────
 * READ THIS BEFORE TREATING A GREEN RUN AS PROOF THE CUTOVER WORKS.
 *
 * THIS FILE NEVER ISSUES AN HTTP REQUEST. It does not start a server, does
 * not open a socket, and does not render a page. Everything about routing in
 * §7 is READ OUT OF src/server.js AS TEXT: the guarantee is "these route
 * registrations, in this order, with these arguments, are present in the
 * source", NOT "a GET / returns the /next shell".
 *
 * That is a real guarantee and not decoration — it was thrown three separate
 * reverts of the cutover (the "/" handler removed, "/old" removed, the static
 * mount's `index: false` removed) and caught all three. But the gap is
 * specific and worth naming, because a green run here is what somebody will
 * point at on cutover day:
 *
 *   • A NEW middleware registered ABOVE the static mount or the "/" handler
 *     would intercept the request and this file would not notice — nothing
 *     here models Express's matching order beyond the two positions §7
 *     explicitly compares.
 *   • A change to how the shell is BUILT (a broken sendFile path that still
 *     matches the asserted string, a file that no longer exists on disk, a
 *     Content-Type regression) is invisible: no file is opened at the path
 *     the route names.
 *   • Anything only observable in a browser — the bar rendering, the dismiss
 *     click, whether it covers a control at a given window size.
 *
 * The live half was done by hand and is NOT reproducible from here: curl and
 * a real browser against a server on a throwaway port, with
 * document.elementFromPoint over the CENTRE of real controls. When the
 * cutover behaviour changes, that browser pass has to be REDONE — a green
 * `npm test` does not stand in for it.
 *
 * ── What this suite ACTUALLY covers ─────────────────────────────────────
 * COVERED, behaviourally (the real functions are executed, both directions):
 *   - hasApiKey / hasAnyDomain / hasAnyPage / isExistingUser against real
 *     response shapes AND against null / malformed / partial bodies.
 *   - readDismissed(), including the case where the storage read THROWS,
 *     which MUST fail SAFE by HIDING — the OPPOSITE of onboarding.js's
 *     choice, and the single most important assertion in this file (§2).
 *   - shouldShowNotice(): shown for an existing user, hidden when dismissed,
 *     hidden in the can't-tell case (both GETs failed -> factsFrom(null,null)),
 *     and hidden for a POST-cutover install however complete its setup.
 *   - The PROVENANCE gate (§3b): classifyOrigin/readOrigin/writeOrigin are
 *     executed over the full new-user and existing-user timelines, which is
 *     where the ordering argument behind the gate is checked rather than
 *     asserted in prose.
 *   - MUTUAL EXCLUSION (§4): BOTH modules' real functions are executed over
 *     all eight fact combinations in BOTH origins and asserted never
 *     both-true. This is the load-bearing property, and it is proved by
 *     execution, not by reading. NOTE it is an IMPLICATION, not a partition:
 *     in the post-cutover arm a fully-set-up install shows NEITHER surface,
 *     deliberately.
 *
 * COVERED, as source-level guards (stated as such, not as behaviour):
 *   - The three shared predicates are BYTE-IDENTICAL across the two modules
 *     (§5) — the exclusion in §4 is a claim about them agreeing, so drift
 *     would silently unpick it.
 *   - The boot-hook call site cannot prevent markBooted() from running, and
 *     the guidance check has exactly ONE call site, inside the "the notice
 *     did not show" branch (§6).
 *   - The route table: "/" and the catch-all resolve to the NEXT shell,
 *     "/old" to the OLD one, "/next" still works, and the static mount runs
 *     with `index: false` — without which "/" is answered by a directory
 *     index and never reaches the catch-all at all (§7).
 *   - Non-modality, CSS prefix ownership, the two cross-file class contracts,
 *     and that the bar RESERVES its strip rather than floating over the
 *     shell (§8).
 *
 * NOT COVERED here (stated rather than implied):
 *   - Rendering, the dismiss click, and whether the bar actually covers a
 *     control at a given window size. All need a DOM; verified in a real
 *     browser with document.elementFromPoint instead, and that verification
 *     is not reproducible from here.
 *   - That an HTTP request really returns the shell this file says it does.
 *     See the block above: §7 reads the route table as TEXT and nothing here
 *     opens a socket.
 *   - Anything about the shipping frontend's own behaviour at /old beyond
 *     the route that serves it.
 *   - That the two surfaces cannot be on screen together when the user asks
 *     for one. §4 is about the AUTOMATIC predicates. Settings' "Show setup
 *     guide" calls onboarding.js's exported openOnboardingPanel() directly,
 *     bypassing shouldShowPanel() by design, so the bar and the panel CAN
 *     coexist by explicit user action — verified in a browser as harmless
 *     (the bar reserves its strip; 0 controls covered), not asserted here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CV_PATH = path.join(ROOT, 'src/public/next/views/cutover-notice.js');
const cv = readFileSync(CV_PATH, 'utf8');
const cvCss = readFileSync(path.join(ROOT, 'src/public/next/views/cutover-notice.css'), 'utf8');
const ob = readFileSync(path.join(ROOT, 'src/public/next/views/onboarding.js'), 'utf8');
const obCss = readFileSync(path.join(ROOT, 'src/public/next/views/onboarding.css'), 'utf8');
const appJs = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
const server = readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
const nextIndex = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8');
const shellCss = readFileSync(path.join(ROOT, 'src/public/next/shell.css'), 'utf8');

// ── Comment stripping for the source guards ─────────────────────────────
// Every ABSENCE check below has to run against CODE: cutover-notice.js's own
// header QUOTES the strings being asserted absent (role="dialog", aria-modal)
// while explaining why they are absent, and src/server.js's cutover comment
// quotes `src="app.js"` and `index: 'index.html'`. Run against raw text those
// guards would be reading a COMMENT — this repo's named failure shape, "a
// check that stopped reaching the thing it protects".
//
// Conservative on purpose: /* … */ blocks and whole-line // comments only.
// End-of-line comments need a real lexer to tell them from a // inside a
// string, and for an ABSENCE check the safe direction is to leave too much in
// (a false FAILURE somebody must look at), never too little.
//
// ORDER IS LOAD-BEARING and is the same order scripts/test-next-onboarding.js
// uses, for the same reason: line comments FIRST. app.js's prose contains
// `/*`-looking text inside // comments, and stripping blocks first would open
// a fake block comment that runs on for thousands of characters and swallows
// boot() whole. assertStrippedSane() below is the tripwire for exactly that.
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

// The anchors are STRUCTURAL (declarations that must exist for this suite to
// have a subject at all) and deliberately exclude anything an assertion
// elsewhere in this file also checks — an overlap makes the very mutation a
// section exists to catch throw in the tripwire instead, which is a red for
// the wrong reason and proves nothing. (Found the hard way in
// scripts/test-next-onboarding.js; not repeated here.)
const cvCode = assertStrippedSane(stripComments(cv), 'cutover-notice.js', [
  'export async function maybeShowCutoverNotice()',
  'function shouldShowNotice(facts, dismissed, origin)',
  'function isExistingUser(facts)',
  'function openBar()',
]);
const appCode = assertStrippedSane(stripComments(appJs), 'app.js', [
  'function boot() {',
  'maybeShowCutoverNotice()',
  'function markBooted() {',
]);
// NOTE the anchors here deliberately do NOT include "app.get('/old'" or
// "app.get('*'". Both are things §7 ASSERTS, and a sanity anchor that
// overlaps an assertion turns the very mutation the section exists to catch
// into a THROWN tripwire instead of a failed assertion — a red for the wrong
// reason, which proves nothing. Found exactly that way: deleting the /old
// route made this line throw before a single assertion ran.
const serverCode = assertStrippedSane(stripComments(server), 'server.js', [
  'const app = express();',
  'res.sendFile(',
]);
const cvCssCode = assertStrippedSane(stripComments(cvCss), 'cutover-notice.css', [
  '.cvn-bar {',
  '#app-shell {',
]);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extract the pure functions from the real source ──────────────────────
// Brace-matched, so nested braces in a body cannot truncate the extraction.
// A missing name THROWS rather than silently testing nothing.
function extractFunction(src, name, label) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  // Skip the PARAMETER LIST before hunting for the body brace — a
  // destructured parameter would otherwise latch the brace-matcher onto the
  // parameter pattern and "end" the function at the closing paren.
  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i);
  // Desync tripwire: a truncated extraction must fail LOUDLY here rather than
  // later as a confusing SyntaxError out of new Function().
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced (${label})`);
  }
  return extracted;
}

// Stops at the first `;` that ends a LINE, allowing a trailing // comment
// after it. The tripwire turns a desync into a named failure.
function extractConst(src, name, label) {
  const re = new RegExp(`(?:^|\\n)const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in ${label}`);
  const extracted = m[0].trim();
  if (/\bfunction\s/.test(extracted)) {
    throw new Error(`extractConst: "${name}" extraction swallowed a function — the terminator desynced (${label})`);
  }
  return extracted;
}

// Brace-matched extraction of an `app.get(...)` block, from the literal
// `needle` to the brace that closes its handler. Used instead of a flat
// regex because a handler body containing `})` (none do today, but that is
// exactly the kind of thing that changes) would truncate one.
function extractBlock(src, needle, label) {
  const start = src.indexOf(needle);
  if (start === -1) throw new Error(`extractBlock: "${needle}" not found in ${label}`);
  let i = src.indexOf('{', start);
  if (i === -1) throw new Error(`extractBlock: "${needle}" has no body in ${label}`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const block = src.slice(start, i);
  if (block.length < needle.length + 4) {
    throw new Error(`extractBlock: "${needle}" extraction is implausibly short — the matcher desynced (${label})`);
  }
  return block;
}

// ── Sandbox 1: the cutover notice's pure logic ───────────────────────────
const CV_FNS = ['hasApiKey', 'hasAnyDomain', 'hasAnyPage', 'factsFrom',
  'isExistingUser', 'readDismissed', 'writeDismissed', 'shouldShowNotice',
  'readOrigin', 'writeOrigin', 'classifyOrigin'];
const CV_CONSTS = ['DISMISS_KEY', 'ORIGIN_KEY', 'UNKNOWN_FACTS', 'DOCK_CLASS', 'ONBOARDING_ROOT_CLASS'];

const cvBox = new Function(
  CV_CONSTS.map((c) => extractConst(cv, c, 'cutover-notice.js')).join('\n') + '\n' +
  CV_FNS.map((n) => extractFunction(cv, n, 'cutover-notice.js')).join('\n\n') + '\n' +
  `return { ${CV_FNS.join(', ')}, ${CV_CONSTS.join(', ')} };`
)();

const {
  hasApiKey, hasAnyDomain, hasAnyPage, factsFrom, isExistingUser,
  readDismissed, writeDismissed, shouldShowNotice,
  readOrigin, writeOrigin, classifyOrigin,
  DISMISS_KEY, ORIGIN_KEY, DOCK_CLASS, ONBOARDING_ROOT_CLASS,
} = cvBox;

// ── Sandbox 2: onboarding.js's real gate, for the exclusion proof ────────
const OB_FNS = ['hasApiKey', 'hasAnyDomain', 'hasAnyPage', 'factsFrom',
  'buildSteps', 'shouldShowPanel'];
const OB_CONSTS = ['STEP_ORDER', 'STEP_COPY', 'UNKNOWN_FACTS'];

const obBox = new Function(
  OB_CONSTS.map((c) => extractConst(ob, c, 'onboarding.js')).join('\n') + '\n' +
  OB_FNS.map((n) => extractFunction(ob, n, 'onboarding.js')).join('\n\n') + '\n' +
  `return { ${OB_FNS.join(', ')} };`
)();

const obBuildSteps = obBox.buildSteps;
const obShouldShowPanel = obBox.shouldShowPanel;

// Realistic bodies, shaped from the actual routes:
//   GET /api/config/api-keys  (src/routes/config.js)
//   GET /api/domains/stats    (src/routes/domains.js -> getDomainStats)
function keysBody(over) {
  return Object.assign({
    geminiApiKey: null, anthropicApiKey: null,
    hasGeminiKey: false, hasAnthropicKey: false,
    activeProvider: null, activeModel: null,
    models: { gemini: 'gemini-2.5-flash-lite', anthropic: 'claude-haiku-4-5' },
    fallback: null,
  }, over || {});
}
function statsBody(domains) {
  return { domains: domains || [], readonlyDomains: [] };
}
function domain(slug, pageCount) {
  return {
    slug, displayName: slug, pageCount, conversationCount: 0, lastIngestDate: null,
    pageCounts: { entities: 0, concepts: 0, summaries: 0, other: 0 },
  };
}
function fakeStorage(value) {
  return { getItem: () => value, setItem: () => {} };
}
function throwingStorage() {
  return {
    getItem() { throw new Error('SecurityError: storage disabled'); },
    setItem() { throw new Error('SecurityError: storage disabled'); },
  };
}

// ═════════════════════════════════════════════════════════════════════════
section('1. The three facts, executed against real and malformed bodies');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(hasApiKey(keysBody({ hasGeminiKey: true })), true, 'a saved Gemini key counts');
  eq(hasApiKey(keysBody({ hasAnthropicKey: true })), true, 'a saved Anthropic key counts');
  eq(hasApiKey(keysBody()), false, 'no saved key');
  eq(hasApiKey(null), false, 'a failed /api/config/api-keys (null) reads as no key');
  eq(hasApiKey('nope'), false, 'a non-object body reads as no key');
  // v3.0.13: config-only. A truthy non-boolean must not sneak through.
  eq(hasApiKey({ hasGeminiKey: 'yes' }), false, 'a truthy NON-boolean does not count as a key');

  eq(hasAnyDomain(statsBody([domain('articles', 3)])), true, 'one domain counts');
  eq(hasAnyDomain(statsBody([])), false, 'zero domains');
  eq(hasAnyDomain(null), false, 'a failed /api/domains/stats (null) reads as no domain');
  eq(hasAnyDomain({ domains: 'articles' }), false, 'a non-array domains field reads as no domain');

  eq(hasAnyPage(statsBody([domain('articles', 3)])), true, 'a domain with pages counts');
  eq(hasAnyPage(statsBody([domain('articles', 0)])), false, 'a freshly-created, never-ingested domain does NOT count');
  eq(hasAnyPage(statsBody([{ slug: 'broken', error: 'EACCES' }])), false,
    'a domain whose stats FAILED (no pageCount -> NaN) never falsely counts as used');
  eq(hasAnyPage(statsBody([domain('a', 0), domain('b', 12)])), true, 'any one domain with pages is enough');

  // The predicate itself. All three, `=== true` on each.
  eq(isExistingUser({ hasKey: true, hasDomain: true, hasPages: true }), true, 'all three facts -> existing user');
  eq(isExistingUser({ hasKey: true, hasDomain: true, hasPages: false }), false, 'key + domain but NO page -> not recognised as existing');
  eq(isExistingUser({ hasKey: false, hasDomain: true, hasPages: true }), false, 'pages but no key -> not recognised (cannot tell)');
  eq(isExistingUser({ hasKey: true, hasPages: true }), false, 'a missing field reads as cannot-tell, not as yes');
  eq(isExistingUser({ hasKey: 1, hasDomain: 1, hasPages: 1 }), false, 'truthy non-booleans do NOT satisfy the predicate');
  eq(isExistingUser(null), false, 'null facts -> not existing');
  eq(isExistingUser('yes'), false, 'a non-object -> not existing');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. FAIL-SAFE DIRECTION — a throwing storage must HIDE (the opposite of onboarding.js)');
// ═════════════════════════════════════════════════════════════════════════
// THE most important assertion in this file. onboarding.js's readDismissed()
// returns FALSE (show) when storage throws, because guidance that never
// appears leaves a user stuck with no visible symptom. Here the costs are
// inverted: a spurious "the interface changed" bar tells someone who has
// never seen the old interface that something they never used has changed,
// and offers them a link INTO a deprecated app — at the exact moment the
// guidance panel is trying to walk them through setup. So this one HIDES.
{
  eq(readDismissed(fakeStorage('1')), true, 'a stored "1" reads as dismissed');
  eq(readDismissed(fakeStorage(null)), false, 'nothing stored reads as not dismissed');
  eq(readDismissed(fakeStorage('0')), false, 'any other value reads as not dismissed');
  eq(readDismissed(throwingStorage()), true,
    'a storage read that THROWS reads as DISMISSED — fail-safe HIDE, deliberately the opposite of onboarding.js');

  // And prove the two really are opposite, by executing onboarding's own
  // readDismissed on the same throwing storage. If someone "makes them
  // consistent", this goes red with the reason attached.
  const obReadDismissed = new Function(
    extractConst(ob, 'DISMISS_KEY', 'onboarding.js') + '\n' +
    extractFunction(ob, 'readDismissed', 'onboarding.js') + '\nreturn readDismissed;'
  )();
  eq(obReadDismissed(throwingStorage()), false,
    "onboarding.js's readDismissed still fails the OTHER way (show) — the two directions are deliberate, not an oversight");

  eq(writeDismissed(fakeStorage(null)), true, 'a working storage records the dismissal');
  eq(writeDismissed(throwingStorage()), false,
    'a storage that refuses the write returns false rather than throwing over a dismissal click');

  ok(/-v1$/.test(DISMISS_KEY), `the localStorage key is versioned (${DISMISS_KEY})`);
  ok(DISMISS_KEY.startsWith('curator-next-'), 'and namespaced curator-next-* like every other key in this shell');
  ok(DISMISS_KEY !== 'curator-next-onboarding-dismissed-v1', 'and is NOT the onboarding key');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. shouldShowNotice — both directions, including can\'t-tell');
// ═════════════════════════════════════════════════════════════════════════
{
  const existing = factsFrom(keysBody({ hasGeminiKey: true }), statsBody([domain('articles', 3336)]));
  eq(existing.hasKey && existing.hasDomain && existing.hasPages, true, 'sanity: the seeded "existing user" bodies produce all three facts');

  eq(shouldShowNotice(existing, false, 'pre'), true, 'an existing user who has not dismissed it SEES the notice');
  eq(shouldShowNotice(existing, true, 'pre'), false, 'a dismissal hides it');

  const brandNew = factsFrom(keysBody(), statsBody([]));
  eq(shouldShowNotice(brandNew, false, 'pre'), false, 'a brand-new install does NOT see it');

  const halfSetUp = factsFrom(keysBody({ hasGeminiKey: true }), statsBody([domain('articles', 0)]));
  eq(shouldShowNotice(halfSetUp, false, 'pre'), false, 'a key + an empty domain is not enough — no page means the app was never used');

  // THE can't-tell case: getJson() returns null for a failed request, a
  // non-JSON body, or the SPA catch-all answering HTML at 200.
  const cannotTell = factsFrom(null, null);
  eq(shouldShowNotice(cannotTell, false, 'pre'), false,
    'both requests failed -> we cannot tell -> the notice does NOT show (fail-safe HIDE)');
  const halfKnown = factsFrom(keysBody({ hasGeminiKey: true }), null);
  eq(shouldShowNotice(halfKnown, false, 'pre'), false, 'one request failed -> still cannot tell -> hidden');

  // ── THE PROVENANCE GATE (the post-cutover-new-user false positive) ─────
  // The reported defect: isExistingUser() has no time component, so a user
  // who installs AFTER the cutover and completes setup satisfies all three
  // facts and was shown a notice about an interface they have never seen,
  // with a link into it, forever.
  eq(shouldShowNotice(existing, false, 'post'), false,
    'DEFECT — a POST-cutover install with all three facts does NOT see the notice');
  eq(shouldShowNotice(existing, false, null), false,
    'an unrecorded origin is not "pre" -> hidden (fail-safe)');
  eq(shouldShowNotice(existing, false, undefined), false,
    'a call site that forgets the argument entirely -> hidden, never the pre-fix behaviour');
  eq(shouldShowNotice(existing, false, 'PRE'), false,
    'the comparison is exact — a near-miss value does not open the gate');
}

// ═════════════════════════════════════════════════════════════════════════
section('3b. classifyOrigin / readOrigin — the record is made ONCE');
// ═════════════════════════════════════════════════════════════════════════
// The soundness of the gate is an ORDERING argument, and this is where it is
// executed rather than asserted in prose:
//
//   an EXISTING user has key+domain+pages on their FIRST load of this shell;
//   a NEW user can only acquire them BY USING this shell, by which time the
//   origin has already been recorded 'post'.
{
  const existing = factsFrom(keysBody({ hasGeminiKey: true }), statsBody([domain('articles', 3336)]));
  const brandNew = factsFrom(keysBody(), statsBody([]));

  eq(classifyOrigin(null, existing), 'pre',
    'first load, all three facts already true -> PRE-cutover install');
  eq(classifyOrigin(null, brandNew), 'post',
    'first load, nothing set up yet -> POST-cutover install');

  // The load-bearing one: the verdict is never re-decided, so a new user's
  // later ingests cannot promote them to 'pre'.
  eq(classifyOrigin('post', existing), 'post',
    'a recorded POST origin survives the user later satisfying all three facts');
  eq(classifyOrigin('pre', brandNew), 'pre',
    'and a recorded PRE origin survives the user later deleting everything');

  // Unrecognised stored values are re-decided, not trusted.
  for (const junk of ['', 'yes', '1', 'PRE', null, undefined, 0]) {
    eq(classifyOrigin(junk, brandNew), 'post',
      `an unrecognised stored value ${JSON.stringify(junk)} is re-decided from facts`);
  }

  // The full new-user timeline, driven through the real functions.
  {
    const store = new Map();
    const s = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    // Load 1: brand-new install, nothing set up.
    let stored = readOrigin(s);
    let origin = classifyOrigin(stored, brandNew);
    if (stored === null) writeOrigin(s, origin);
    eq(shouldShowNotice(brandNew, false, origin), false, 'new user, load 1 (empty install): no bar');
    // Load 2..n: they have now added a key, a domain and ingested — the
    // exact state that used to trip the bar on every load, forever.
    stored = readOrigin(s);
    origin = classifyOrigin(stored, existing);
    eq(origin, 'post', 'the origin recorded on load 1 is still POST');
    eq(shouldShowNotice(existing, false, origin), false,
      'new user, load 2 (key + domain + an ingest): STILL no bar — the reported defect');
  }

  // The existing-user timeline, so the gate is not passing by killing the bar.
  {
    const store = new Map();
    const s = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    const stored = readOrigin(s);
    const origin = classifyOrigin(stored, existing);
    if (stored === null) writeOrigin(s, origin);
    eq(origin, 'pre', 'existing user: first load records PRE');
    eq(shouldShowNotice(existing, false, origin), true, 'existing user, load 1: the bar SHOWS');
    // And it keeps showing until dismissed — a bare "seen this shell" flag
    // would have made it a one-load-only surface.
    const origin2 = classifyOrigin(readOrigin(s), existing);
    eq(shouldShowNotice(existing, false, origin2), true,
      'existing user, load 2 with no dismissal: it still shows (the record is a VERDICT, not a seen-flag)');
    eq(shouldShowNotice(existing, true, origin2), false, '...and a dismissal still ends it');
  }

  // FAIL-SAFE: a storage that throws on read must HIDE, like readDismissed.
  {
    const throwing = { getItem() { throw new Error('no storage'); }, setItem() { throw new Error('no storage'); } };
    eq(readOrigin(throwing), 'post',
      'a THROWING storage reads as POST — the value that hides the bar (fail-safe HIDE)');
    eq(writeOrigin(throwing, 'pre'), false, 'and a throwing write is reported, not raised');
  }

  ok(ORIGIN_KEY.startsWith('curator-next-') && /-v1$/.test(ORIGIN_KEY),
    `the origin key is namespaced and versioned (${ORIGIN_KEY})`);
  ok(ORIGIN_KEY !== DISMISS_KEY, 'and is a different key from the dismissal');

  // ── WHY THE ORIGIN IS A KEY OF OUR OWN, evidenced not asserted ─────────
  // The obvious cheaper design — "read a localStorage key only the SHIPPING
  // frontend ever writes" — does not exist. /next writes all three of
  // app.js's keys too, so any of them would re-arm the same false positive
  // the moment a new user touches /next's composer or accepts its AI
  // disclosure. Pinned against the real sources so the idea is not
  // re-proposed on the strength of the comment alone.
  const nextChat = readFileSync(path.join(ROOT, 'src/public/next/views/chat.js'), 'utf8');
  const nextDomains = readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
  const shipping = readFileSync(path.join(ROOT, 'src/public/app.js'), 'utf8');
  for (const key of ['curator-chat-response-style', 'curator-chat-model-provider']) {
    ok(shipping.includes(key), `shipping app.js knows ${key}`);
    ok(nextChat.includes(key), `...and so does /next chat.js — ${key} is NOT shipping-only`);
  }
  ok(shipping.includes('curator-ai-health-disclosure-seen-v1')
     && nextDomains.includes('curator-ai-health-disclosure-seen-v1'),
    '...and the AI-disclosure key is written by BOTH frontends too');
  ok(/setItem\(\s*LS_STYLE/.test(nextChat) || /localStorage\.setItem\(LS_STYLE/.test(nextChat),
    '/next does not merely READ those keys — it WRITES one on an ordinary composer action');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. MUTUAL EXCLUSION — proved by executing BOTH modules over all 8 fact combinations');
// ═════════════════════════════════════════════════════════════════════════
// The load-bearing property, and the reason isExistingUser() requires all
// three facts rather than the looser "has a domain OR a key" the brief
// suggested: the strict predicate is the exact logical complement of
// onboarding.js's "all steps done -> never show" rule, so the two surfaces
// cannot both be true for ANY install, whatever either dismissal flag says.
//
// Driven through the REAL functions of BOTH modules — not a restatement of
// the rule — so a change to either one's definition of "done" fails here.
// PRECISION added with the provenance gate: the relation is an IMPLICATION
// (the bar showing => the panel does not auto-show), not a partition. In the
// POST-cutover arm a fully-set-up install shows NEITHER, which is the whole
// point of the gate. The partition property is therefore asserted where it
// still holds — the PRE arm — and the post arm gets its own, stronger claim:
// the bar shows for ZERO fact combinations.
{
  let both = 0, neitherPre = 0, checked = 0, barShowsPost = 0;
  for (const origin of ['pre', 'post']) {
    for (const hasKey of [false, true]) {
      for (const hasDomain of [false, true]) {
        for (const hasPages of [false, true]) {
          const facts = { hasKey, hasDomain, hasPages };
          // Worst case for exclusion: NEITHER surface has been dismissed, so
          // each is as eager as it can be.
          const noticeShows = shouldShowNotice(facts, false, origin) === true;
          const panelShows = obShouldShowPanel(obBuildSteps(facts), false) === true;
          checked++;
          if (noticeShows && panelShows) {
            both++;
            ok(false, `origin ${origin}, facts ${JSON.stringify(facts)}: BOTH surfaces want the screen`);
          }
          if (origin === 'pre' && !noticeShows && !panelShows) neitherPre++;
          if (origin === 'post' && noticeShows) barShowsPost++;
        }
      }
    }
  }
  eq(checked, 16, 'all eight fact combinations were evaluated in BOTH origins');
  eq(both, 0, 'no fact combination, in either origin, puts both the cutover bar and the guidance panel on screen');
  // Guards against the degenerate "exclusion" where one surface simply never
  // shows: that would satisfy the check above vacuously.
  eq(neitherPre, 0,
    'in the PRE-cutover arm every combination shows exactly ONE of them — the exclusion is a partition there, not one surface being dead');
  eq(barShowsPost, 0,
    'in the POST-cutover arm the bar shows for ZERO fact combinations — a new install can never reach it, however complete its setup');

  // Spot-check the ends explicitly so a reader can see which is which.
  const allDone = { hasKey: true, hasDomain: true, hasPages: true };
  eq(shouldShowNotice(allDone, false, 'pre'), true, 'fully set-up PRE-cutover install: the cutover bar shows');
  eq(obShouldShowPanel(obBuildSteps(allDone), false), false, '...and the guidance panel does not');
  eq(shouldShowNotice(allDone, false, 'post'), false, 'fully set-up POST-cutover install: NEITHER surface shows — by design');
  const nothing = { hasKey: false, hasDomain: false, hasPages: false };
  eq(shouldShowNotice(nothing, false, 'pre'), false, 'brand-new install: the cutover bar does not show');
  eq(obShouldShowPanel(obBuildSteps(nothing), false), true, '...and the guidance panel does');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. DRIFT GUARD — the three shared predicates are byte-identical across the two modules');
// ═════════════════════════════════════════════════════════════════════════
// §4's exclusion is a claim about the two modules agreeing on the same three
// facts. They are separate copies (importing would mean making onboarding.js
// export internals it deliberately keeps private), so the copies are pinned
// character for character — the answer this repo already uses for duplicated
// PURE helpers, v3.6.0's test-next-ingest-logic-drift.js. Whitespace counts:
// a reformat is a change, and a silent divergence here unpicks §4.
{
  for (const name of ['hasApiKey', 'hasAnyDomain', 'hasAnyPage']) {
    const a = extractFunction(cv, name, 'cutover-notice.js');
    const b = extractFunction(ob, name, 'onboarding.js');
    ok(a.length > 40, `sanity: ${name} really extracted from cutover-notice.js (${a.length} chars)`);
    ok(a === b, `${name}() is byte-identical in cutover-notice.js and onboarding.js`);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('6. THE BLANK-PAGE RISK — the boot hook cannot stop markBooted(), and the chain is ordered');
// ═════════════════════════════════════════════════════════════════════════
// app.js calls markBooted() immediately after boot() returns, and
// next/index.html's <head> guard treats an unset window.__curatorBooted at
// DOMContentLoaded as proof the module died — it then paints a full-page
// recovery panel to EVERY user. A boot hook that can throw synchronously
// therefore ships a blank page.
//
// WHAT THIS SECTION PROVES: the call site has the SHAPE that cannot throw
// synchronously, and the guidance check runs only when the notice did not.
// WHAT IT DOES NOT PROVE: that the browser actually boots. Only loading the
// page and reading window.__curatorBooted does that; done separately, in a
// browser, and reported as an observed value.
{
  // Deliberately tolerant of `async` here even though the next assertion
  // forbids it: an extraction that only matches the CORRECT form leaves the
  // body empty on the very mutation this section exists to catch, and the
  // await assertion would then pass VACUOUSLY over an empty string.
  const bootM = /\n(?:async )?function boot\(\) \{([\s\S]*?)\n\}\n/.exec(appCode);
  ok(!!bootM, 'boot() is found in app.js');
  const bootBody = bootM ? bootM[1] : '';
  ok(bootBody.length > 200, 'and its body was really extracted (an empty match would make every guard below vacuous)');

  ok(/^function boot\(\)/m.test(appCode), 'boot() is NOT declared async');
  ok(!/\basync function boot\(\)/.test(appCode), 'and nothing made it async');
  ok(!/\bawait\b/.test(bootBody), 'boot() contains no await at all');

  ok(bootBody.includes('maybeShowCutoverNotice()'), 'boot() calls maybeShowCutoverNotice()');
  ok(/Promise\.resolve\(\)/.test(bootBody),
    'the chain starts from Promise.resolve(), so even a synchronous throw from the first call becomes a rejection');
  ok(/\.catch\(/.test(bootBody), 'the chain has its own .catch');
  ok(/try\s*\{[\s\S]*Promise\.resolve\(\)[\s\S]*\}\s*catch/.test(bootBody),
    'and the whole chain is additionally inside a try/catch at the call site');
  ok(/export async function maybeShowCutoverNotice\(\)/.test(cvCode),
    'maybeShowCutoverNotice is declared async, so it can only ever REJECT, never throw synchronously');
  ok(/^\s*try \{/m.test(extractFunction(cv, 'maybeShowCutoverNotice', 'cutover-notice.js')),
    'and its whole body is inside a try/catch, so it does not even reject');

  // THE ordering assertion. The guidance check must be reachable ONLY from
  // the "the notice did not show" branch.
  ok(/if\s*\(\s*shownCutover\s*!==\s*true\s*\)\s*runGuidanceCheck\(\)/.test(bootBody),
    'the guidance check runs only when the notice did NOT show');
  const iNotice = bootBody.indexOf('maybeShowCutoverNotice()');
  const iGuidance = bootBody.indexOf('runGuidanceCheck()');
  ok(iNotice !== -1 && iGuidance !== -1 && iNotice < iGuidance,
    `the notice is decided BEFORE the guidance check (${iNotice} < ${iGuidance})`);

  // Exactly one call site for the guidance check, so there is no second,
  // ungated path that reintroduces both-on-screen.
  const guidanceCalls = (appCode.match(/maybeShowOnboarding\(/g) || []).length;
  eq(guidanceCalls, 1, 'maybeShowOnboarding has exactly ONE call site in app.js');
  ok(/try \{ maybeShowOnboarding\(\); \} catch/.test(bootBody),
    'and it keeps its own try/catch at that call site (scripts/test-next-onboarding.js §6 reads this exact shape)');

  // openBar() last, so "returned false or rejected" reliably means "nothing
  // was rendered" and the fall-through to onboarding is safe.
  const bodyCv = extractFunction(cv, 'maybeShowCutoverNotice', 'cutover-notice.js');
  ok(/openBar\(\);\s*return true;/.test(bodyCv),
    'openBar() is the last thing maybeShowCutoverNotice() does before returning true');
  ok(/return false;/.test(bodyCv), 'and every other path returns false');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. THE ROUTE TABLE — "/" and the catch-all serve NEXT, "/old" serves the shipping app');
// ═════════════════════════════════════════════════════════════════════════
{
  // `index: false` is the non-obvious half. express.static defaults to
  // index:'index.html', so before the cutover "/" was answered by the STATIC
  // MOUNT from src/public/index.html and never reached the catch-all at all.
  // Flipping the catch-all alone would have left the old app at "/".
  // Measured live before the change: GET / returned the shipping app's title
  // AND returned 200 with `Host: evil.com` (the mount sits above the Host
  // guard). Both were re-measured after: NEXT's title, and 403.
  // Matched to the statement terminator, not to the first ")": the first
  // ")" closes path.join(), so a lazy [^)]* capture stops BEFORE the options
  // object and the assertion below passes/fails on text it never saw.
  const staticM = /app\.use\(express\.static\([\s\S]*?\);/.exec(serverCode);
  ok(!!staticM, 'the express.static mount is found');
  ok(!!staticM && staticM[0].includes('path.join'),
    'sanity: the whole mount statement was captured, options object included');
  ok(/index:\s*false/.test(staticM ? staticM[0] : ''),
    'the static mount runs with { index: false } — without it "/" is answered by a directory index and the catch-all never runs');

  // Presence is ASSERTED before extraction, never assumed: extractBlock
  // throws on a missing needle, and a throw here would replace every
  // assertion below with a stack trace.
  const hasCatchAll = serverCode.includes("app.get('*'");
  ok(hasCatchAll, 'a SPA catch-all route exists');
  const catchAll = hasCatchAll ? extractBlock(serverCode, "app.get('*'", 'server.js') : '';
  ok(/'next',\s*'index\.html'/.test(catchAll),
    'the SPA catch-all serves src/public/next/index.html');
  ok(catchAll !== '' && !/__dirname,\s*'public',\s*'index\.html'/.test(catchAll),
    'and NOT the shipping app\'s index.html');

  const hasOldRoute = serverCode.includes("app.get('/old'");
  ok(hasOldRoute,
    "a /old route exists — without it the catch-all swallows /old and the shipping app becomes unreachable");
  const oldRoute = hasOldRoute ? extractBlock(serverCode, "app.get('/old'", 'server.js') : '';
  ok(/__dirname,\s*'public',\s*'index\.html'/.test(oldRoute),
    '/old serves the shipping app\'s src/public/index.html');
  ok(!/'next'/.test(oldRoute), 'and not the next shell');
  // The shipping index.html uses BARE-RELATIVE asset refs, so the URL's
  // directory decides where they resolve: at "/old" that is "/", giving
  // "/app.js" (served); at "/old/" it would be "/old/app.js" (not a file),
  // which the catch-all answers with HTML at 200 and the browser parses as
  // JavaScript. Reproduced live: a separate app.get('/old/') route ALSO
  // matched "/old" (express's router is non-strict by default) and redirected
  // "/old" to itself — an endless loop where the shipping app used to be.
  ok(/req\.path\s*!==\s*'\/old'/.test(oldRoute),
    "/old redirects the trailing-slash form via a req.path test inside ONE handler (a second route would match '/old' too and self-redirect)");
  ok(/redirect\(302/.test(oldRoute), 'and the redirect is 302, not a permanently-cached 301');
  ok(!/app\.get\('\/old\/'/.test(serverCode), 'there is no separate /old/ route to reintroduce the loop');
  ok(/src="app\.js"/.test(readFileSync(path.join(ROOT, 'src/public/index.html'), 'utf8')),
    'sanity: the shipping index.html really does use a bare-relative script ref (the reason the trailing slash matters)');

  const hasNextRoute = serverCode.includes("app.get(['/next', '/next/']");
  ok(hasNextRoute, 'the /next route still exists');
  const nextRoute = hasNextRoute ? extractBlock(serverCode, "app.get(['/next', '/next/']", 'server.js') : '';
  ok(/'next',\s*'index\.html'/.test(nextRoute), '/next still serves the same shell (bookmarks keep working)');

  // Ordering: the /old route must be registered BEFORE the catch-all, or the
  // catch-all swallows it.
  ok(serverCode.indexOf("app.get('/old'") < serverCode.indexOf("app.get('*'"),
    '/old is registered before the catch-all');
  ok(serverCode.indexOf("app.get(['/next', '/next/']") < serverCode.indexOf("app.get('*'"),
    '/next is registered before the catch-all');

  // The shipping frontend must still EXIST — /old is a route to a real file.
  ok(/<title>/.test(readFileSync(path.join(ROOT, 'src/public/index.html'), 'utf8')),
    'src/public/index.html is still present — the cutover deprecates the old frontend, it does not delete it');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. The bar is non-modal, RESERVES its strip, and owns its prefix');
// ═════════════════════════════════════════════════════════════════════════
{
  // Non-modal. This is a notice a user may ignore forever.
  ok(!/role="dialog"/.test(cvCode), 'no role="dialog"');
  ok(!/aria-modal/.test(cvCode), 'no aria-modal');
  ok(!/\.focus\(/.test(cvCode), 'nothing calls focus() — the caret stays where the user left it');
  ok(!/scrim|backdrop/i.test(cvCode), 'no scrim / backdrop');
  ok(/role', 'region'|role",\s*"region"/.test(cvCode) || /setAttribute\('role',\s*'region'\)/.test(cvCode),
    'it is a labelled region');
  // It writes no user data anywhere.
  ok(!/fetch\([^)]*,\s*\{[^}]*method/.test(cvCode) && !/'POST'|"POST"/.test(cvCode),
    'the module POSTs nothing');
  // Every string reaches the DOM through textContent, never innerHTML.
  ok(!/innerHTML/.test(cvCode), 'no innerHTML anywhere');
  ok(/textContent/.test(cvCode), 'strings are set with textContent');

  // The way back is a REAL anchor with a real href, so it is middle-clickable
  // and copyable and does not depend on a click handler having been wired.
  ok(/createElement\('a'\)/.test(cvCode), 'the way back is an <a> element');
  ok(/\.href\s*=\s*'\/old'/.test(cvCode), "and its href is exactly '/old'");

  // CSS: the reservation, not a float. A `position: fixed` card with
  // pointer-events:auto is what made onboarding.js swallow clicks on
  // Domains' primary action and Settings' Disconnect/Replace buttons.
  const reservation = /body\.cutover-docked #app-shell \{([\s\S]*?)\}/.exec(cvCssCode);
  ok(!!reservation, 'cutover-notice.css reserves the strip on #app-shell');
  ok(!!reservation && /margin-top:\s*var\(--cutover-bar-h\)/.test(reservation[1]),
    'the shell is pushed down by exactly the bar height');
  ok(!!reservation && /height:\s*calc\(100vh - var\(--cutover-bar-h\)\)/.test(reservation[1]),
    'and shortened by the same amount, so nothing is pushed off a page that cannot scroll');
  ok(/--cutover-bar-h:/.test(cvCssCode), 'the bar height is defined once as a custom property');
  const barRule = /\.cvn-bar \{([\s\S]*?)\}/.exec(cvCssCode);
  ok(!!barRule && /height:\s*var\(--cutover-bar-h\)/.test(barRule[1]),
    'and the bar itself consumes that same variable — the two cannot disagree');

  // CROSS-FILE CONTRACT 1: the dock class literal. If the module's constant
  // and the stylesheet's selector drift, the failure is SILENT — no error,
  // the strip simply stops being reserved and the bar covers live controls.
  ok(cvCssCode.includes('body.' + DOCK_CLASS + ' #app-shell'),
    `the stylesheet's selector matches the module's DOCK_CLASS ("${DOCK_CLASS}")`);

  // CROSS-FILE CONTRACT 2: onboarding.js's own root class. Read by this
  // module (to refuse opening on top of it) and by this stylesheet (to stack
  // the two if the panel is re-opened by hand from Settings). A rename over
  // there must fail loudly here rather than silently re-allowing an overlap.
  ok(ob.includes("className = 'obp-root'"),
    `onboarding.js still uses the class this module guards against ("${ONBOARDING_ROOT_CLASS}")`);
  eq(ONBOARDING_ROOT_CLASS, 'obp-root', 'and the constant still names it');
  ok(cvCssCode.includes('body.' + DOCK_CLASS + ' .obp-root'),
    'the stylesheet offsets that panel too, so an explicitly re-opened guide stacks below the bar instead of overlapping it');

  // Prefix ownership: `cvn-` must appear in no other stylesheet in the shell.
  ok(!/\bcvn-/.test(obCss), 'the cvn- prefix does not appear in onboarding.css');
  ok(!/\bcvn-/.test(shellCss), 'nor in shell.css');
  ok(!/\bobp-/.test(cvCssCode.replace(/body\.cutover-docked \.obp-root \{[\s\S]*?\}/, '')),
    'and cutover-notice.css touches obp- only in the one documented stacking rule');

  // Theming discipline: [data-theme] only, never prefers-color-scheme.
  // Against the STRIPPED text: this file's own header says the words
  // "never prefers-color-scheme" in a comment while explaining the rule.
  ok(!/prefers-color-scheme/.test(cvCssCode), 'no prefers-color-scheme (the shell sets [data-theme])');

  // The stylesheet must be LINKED, or it is unstyled in the browser AND
  // invisible to scripts/test-css-tokens.js §5, which discovers /next
  // stylesheets only from index.html's <link> tags.
  // ── The asset-path landmine, found live at "/" ──────────────────────
  // v3.6.1 root-absolutised all 18 refs in next/index.html and pinned them
  // with scripts/test-next-asset-paths.js. That suite scans index.html, so a
  // ref BUILT IN JAVASCRIPT was outside its reach — and app.js built exactly
  // one, for the rail brand mark. A relative src resolves against the current
  // URL's directory, so at "/next/" it was right by accident and at "/" it
  // resolved to "/assets/…", which the SPA catch-all answers with the shell's
  // own HTML at 200 text/html. Measured in a browser at "/": naturalWidth 0,
  // a broken image, and NO 404 in the console to notice.
  const jsAssetRefs = appCode.match(/['"][^'"\n]*assets\/[^'"\n]*['"]/g) || [];
  ok(jsAssetRefs.length > 0, `sanity: app.js does build asset paths in JS (${jsAssetRefs.length} found)`);
  for (const ref of jsAssetRefs) {
    ok(/^['"]\/next\/assets\//.test(ref),
      `asset path built in app.js is root-absolute under /next/: ${ref}`);
  }

  ok(/href="\/next\/views\/cutover-notice\.css"/.test(nextIndex),
    'next/index.html links the stylesheet');
  ok(!/href="views\/cutover-notice\.css"/.test(nextIndex),
    'and the ref is root-absolute, not bare-relative (v3.6.1: a bare-relative ref at "/" resolves to the WRONG tree)');
}

// ═════════════════════════════════════════════════════════════════════════
section('9. Page titles must suit a PRIMARY app, not a preview');
// ═════════════════════════════════════════════════════════════════════════
// Caught by the orchestrator's own spot-check, after an agent had verified
// the routes and I had verified them again: the /next shell's <title> still
// read "The Curator — Next (preview)". Correct while it lived at /next;
// after cutover it is what every browser tab, window switcher and NEW
// BOOKMARK says, i.e. the app telling every user it is a preview. Nothing
// asserted it, because nothing had reason to until the shell became primary.
{
  const nextHtml = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8');
  const oldHtml = readFileSync(path.join(ROOT, 'src/public/index.html'), 'utf8');
  const titleOf = (h) => (h.match(/<title>([^<]*)<\/title>/) || [])[1];

  const nextTitle = titleOf(nextHtml);
  const oldTitle = titleOf(oldHtml);
  ok(!!nextTitle, 'sanity: the /next shell has a <title> (a missing one would pass the negative checks vacuously)');
  ok(!!oldTitle, 'sanity: the shipping shell has a <title>');

  ok(!/preview|next|beta|wip|todo/i.test(nextTitle),
    `the primary shell's title carries no preview/beta marker (got ${JSON.stringify(nextTitle)})`);
  ok(/curator/i.test(nextTitle), `the primary shell's title still names the product (got ${JSON.stringify(nextTitle)})`);
  ok(nextTitle !== oldTitle,
    `the two shells are distinguishable by title, so a user at /old can tell where they are (next ${JSON.stringify(nextTitle)} vs old ${JSON.stringify(oldTitle)})`);
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
