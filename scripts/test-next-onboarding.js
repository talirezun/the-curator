/**
 * test-next-onboarding.js — OFFLINE suite for the /next first-run guidance
 * panel (src/public/next/views/onboarding.js + views/onboarding.css + the
 * app.js boot hook and the views/settings.js re-open seam).
 *
 * No network, no API key, no server, no browser. The panel's decision logic
 * is written as pure functions with no DOM and no fetch precisely so it can
 * be driven here; they are extracted from the REAL source by brace-matching
 * and evaluated standalone with `new Function` — the technique
 * scripts/test-next-mcp-wizard.js and scripts/test-chat-markdown.js already
 * use. Wiring, modality discipline and the CSS/HTML seams are checked with
 * source-level guards against the real files.
 *
 * ── What this suite ACTUALLY covers ─────────────────────────────────────
 * COVERED, behaviourally (the real function is executed, both directions):
 *   - hasApiKey / hasAnyDomain / hasAnyPage against real response shapes
 *     AND against null / malformed / partial bodies.
 *   - buildSteps(): every combination of the three facts, and the ORDER,
 *     which is load-bearing (R7: key -> domain -> ingest).
 *   - readDismissed(): including the case where the storage read THROWS,
 *     which MUST fail SAFE by SHOWING the panel. That is the single most
 *     important assertion in this file (§4).
 *   - shouldShowPanel(): all-done beats dismissed; dismissed hides;
 *     incomplete-and-not-dismissed shows.
 *   - targetViewFor() / progressLabel().
 *
 * COVERED, as source-level guards (stated as such, not as behaviour):
 *   - No role="dialog", no aria-modal, no focus trap anywhere in the
 *     module — this is a REGION, not a modal (D-E).
 *   - No POST of any kind, and specifically no POST /api/domains — the
 *     /next tree is allowed exactly one create-domain call site and it is
 *     views/domains.js's (scripts/test-next-chat-compile.js pins the count).
 *   - The boot-hook call site in app.js cannot prevent markBooted() from
 *     running (§6 — read that section's own preamble for exactly what it
 *     does and does not prove).
 *   - CSS token/theming hygiene and prefix ownership.
 *
 * NOT COVERED here (stated rather than implied):
 *   - Rendering, focus movement, the dismiss click, and the refresh
 *     interval. All of those need a DOM; they were verified in a real
 *     browser instead and that verification is not reproducible from here.
 *   - Whether the panel visually overlaps anything in a given view at a
 *     given window size. Browser-only.
 *   - Anything about the backend endpoints themselves.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const OB_PATH = path.join(ROOT, 'src/public/next/views/onboarding.js');
const ob = readFileSync(OB_PATH, 'utf8');
const obCss = readFileSync(path.join(ROOT, 'src/public/next/views/onboarding.css'), 'utf8');
const appJs = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
const settings = readFileSync(path.join(ROOT, 'src/public/next/views/settings.js'), 'utf8');
const nextIndex = readFileSync(path.join(ROOT, 'src/public/next/index.html'), 'utf8');

// ── Comment stripping for the source guards ─────────────────────────────
// Every ABSENCE check below (no role="dialog", no aria-modal, no focus
// trap, no POST) has to run against CODE, because this module's own header
// deliberately QUOTES the strings being asserted absent while explaining
// why they are absent. Run against raw text, those guards would be reading
// a comment — this repo's named failure shape, "a check that stopped
// reaching the thing it protects".
//
// Conservative on purpose: /* … */ blocks and whole-line // comments only.
// End-of-line comments need a real lexer to distinguish from a // inside a
// string, and for an ABSENCE check the safe direction is to leave too much
// in (a false FAILURE somebody must look at), never too little.
//
// ORDER IS LOAD-BEARING, and it is the opposite of the order
// scripts/test-next-mcp-wizard.js uses. Line comments are removed FIRST.
// app.js's own prose says things like "every views/*.js imports THIS
// module" — inside a // comment. Strip blocks first and that `/*` opens a
// fake block comment that runs on for 27,000 characters until it finds the
// next `*/`, swallowing boot() and markBooted() whole. Caught here by
// assertStrippedSane(), which is exactly what that tripwire is for; if the
// two suites' strippers ever get merged, keep THIS order.
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

// The anchors below are STRUCTURAL (declarations that must exist for this
// suite to have a subject at all) and deliberately exclude anything an
// assertion elsewhere in this file also checks. Mutation-found: `role=
// "region"` was in this list, so the mutation that turns the panel INTO a
// dialog made the tripwire throw before a single assertion ran — a red for
// the wrong reason, which proves nothing. Sanity anchors and assertions
// must not overlap.
const obCode = assertStrippedSane(stripComments(ob), 'onboarding.js', [
  'export async function maybeShowOnboarding()',
  'export function openOnboardingPanel()',
  'function shouldShowPanel(steps, dismissed)',
  'function targetViewFor(stepId)',
]);
const appCode = assertStrippedSane(stripComments(appJs), 'app.js', [
  'function boot() {',
  'maybeShowOnboarding();',
  'function markBooted() {',
]);
const settingsCode = assertStrippedSane(stripComments(settings), 'settings.js', [
  'openOnboardingPanel',
  'btn-show-setup-guide',
]);
const obCssCode = assertStrippedSane(stripComments(obCss), 'onboarding.css', [
  '.obp-root {',
  '.obp-panel {',
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
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in onboarding.js`);
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
  // Desync tripwire: a truncated extraction must fail LOUDLY here rather
  // than later as a confusing SyntaxError out of new Function().
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" extraction does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

// Stops at the first `;` that ends a LINE, allowing a trailing // comment
// after it. The tripwire turns a desync into a named failure.
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} =[\\s\\S]*?;[ \\t]*(?://[^\\n]*)?\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in onboarding.js`);
  const extracted = m[0].trim();
  if (/\bfunction\s/.test(extracted)) {
    throw new Error(`extractConst: "${name}" extraction swallowed a function — the terminator desynced`);
  }
  return extracted;
}

const PURE_FNS = [
  'hasApiKey',
  'hasAnyDomain',
  'hasAnyPage',
  'factsFrom',
  'buildSteps',
  'readDismissed',
  'writeDismissed',
  'shouldShowPanel',
  'progressLabel',
  'targetViewFor',
];
const PURE_CONSTS = ['DISMISS_KEY', 'STEP_ORDER', 'STEP_COPY', 'UNKNOWN_FACTS'];

const sandbox = new Function(
  PURE_CONSTS.map((c) => extractConst(ob, c)).join('\n') + '\n' +
  PURE_FNS.map((n) => extractFunction(ob, n)).join('\n\n') + '\n' +
  `return { ${PURE_FNS.join(', ')}, ${PURE_CONSTS.join(', ')} };`
)();

const {
  hasApiKey, hasAnyDomain, hasAnyPage, factsFrom, buildSteps, readDismissed,
  writeDismissed, shouldShowPanel, progressLabel, targetViewFor,
  DISMISS_KEY, STEP_ORDER,
} = sandbox;

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

// ═════════════════════════════════════════════════════════════════════════
section('1. The three fact predicates — driven BOTH ways, plus junk input');
// ═════════════════════════════════════════════════════════════════════════
{
  // D-A: CONFIG-ONLY. hasGeminiKey/hasAnthropicKey, never a `usable` notion.
  eq(hasApiKey(keysBody()), false, 'no key configured -> false');
  eq(hasApiKey(keysBody({ hasGeminiKey: true })), true, 'a Gemini key alone -> true');
  eq(hasApiKey(keysBody({ hasAnthropicKey: true })), true, 'an Anthropic key alone -> true');
  eq(hasApiKey(keysBody({ hasGeminiKey: true, hasAnthropicKey: true })), true, 'both keys -> true');

  // Strict boolean, so a truthy-but-not-true value from a future shape
  // cannot quietly complete the step.
  eq(hasApiKey({ hasGeminiKey: 'yes' }), false, 'a truthy non-boolean does NOT count as a key');
  eq(hasApiKey(null), false, 'null body -> false (fetch failed)');
  eq(hasApiKey(undefined), false, 'undefined body -> false');
  eq(hasApiKey('nope'), false, 'a non-object body -> false');
  eq(hasApiKey({}), false, 'an empty object -> false');

  eq(hasAnyDomain(statsBody()), false, 'zero domains -> false');
  eq(hasAnyDomain(statsBody([domain('articles', 0)])), true, 'one domain -> true');
  eq(hasAnyDomain(null), false, 'null stats -> false');
  eq(hasAnyDomain({ domains: 'articles' }), false, 'a non-array `domains` -> false');
  eq(hasAnyDomain({}), false, 'stats with no `domains` key -> false');

  // THE trap this predicate exists to avoid: createDomain() writes index.md
  // and log.md into wiki/, and getDomainStats()'s pageCount EXCLUDES exactly
  // those two. A brand-new empty domain must therefore read as 0 pages, or
  // step 3 would tick itself the moment step 2 completed.
  eq(hasAnyPage(statsBody([domain('articles', 0)])), false,
    'a freshly-created, never-ingested domain has 0 pages -> step 3 NOT done');
  eq(hasAnyPage(statsBody([domain('articles', 1)])), true, 'one page anywhere -> true');
  eq(hasAnyPage(statsBody([domain('a', 0), domain('b', 12)])), true, 'ANY domain with pages -> true');
  eq(hasAnyPage(statsBody()), false, 'no domains at all -> false');
  eq(hasAnyPage(null), false, 'null stats -> false');

  // getDomainStats() failures come back as { slug, error } with NO
  // pageCount. Number(undefined) is NaN and NaN > 0 is false, so a broken
  // domain can never falsely complete the step.
  eq(hasAnyPage(statsBody([{ slug: 'broken', error: 'EACCES' }])), false,
    'a domain whose stats FAILED (no pageCount) does not complete the step');
  eq(hasAnyPage({ domains: [null, undefined] }), false, 'null entries in the list are tolerated');
  eq(hasAnyPage(statsBody([domain('a', -3)])), false, 'a negative pageCount does not count');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. buildSteps() — the ORDER is the design (R7), and it is pinned');
// ═════════════════════════════════════════════════════════════════════════
{
  // R7's rationale, restated so a future edit knows what it is breaking:
  // nothing works without a model, so pointing at domain creation first
  // makes the user build an empty domain and hit a wall — an error before
  // a success.
  const s = buildSteps({ hasKey: false, hasDomain: false, hasPages: false });
  eq(s.length, 3, 'exactly three steps');
  eq(s[0].id, 'api-key', 'step 1 is the API key');
  eq(s[1].id, 'domain', 'step 2 is the first domain');
  eq(s[2].id, 'ingest', 'step 3 is the first ingest');
  ok(JSON.stringify(STEP_ORDER) === JSON.stringify(['api-key', 'domain', 'ingest']),
    'STEP_ORDER itself is key -> domain -> ingest');
  ok(s.every((x) => x.done === false), 'a blank install has nothing done');
  ok(s.every((x) => typeof x.title === 'string' && x.title.length > 0), 'every step has a title');
  ok(s.every((x) => typeof x.body === 'string' && x.body.length > 0), 'every step has one line of copy');
  ok(s.every((x) => typeof x.action === 'string' && x.action.length > 0), 'every step has an action label');

  // Each fact drives exactly its own step, both directions.
  const k = buildSteps({ hasKey: true, hasDomain: false, hasPages: false });
  ok(k[0].done === true && k[1].done === false && k[2].done === false, 'hasKey completes ONLY step 1');
  const d = buildSteps({ hasKey: false, hasDomain: true, hasPages: false });
  ok(d[0].done === false && d[1].done === true && d[2].done === false, 'hasDomain completes ONLY step 2');
  const p = buildSteps({ hasKey: false, hasDomain: false, hasPages: true });
  ok(p[0].done === false && p[1].done === false && p[2].done === true, 'hasPages completes ONLY step 3');

  const all = buildSteps({ hasKey: true, hasDomain: true, hasPages: true });
  ok(all.every((x) => x.done === true), 'all three facts -> all three done');

  // A done step's copy must differ from its todo copy, or "done" would be
  // invisible to a user reading rather than scanning the tick.
  ok(all[0].body !== s[0].body, 'a done step shows different copy from a todo step');

  // Defensive shapes.
  ok(buildSteps(null).length === 3, 'null facts still yields three steps');
  ok(buildSteps(null).every((x) => x.done === false), 'null facts -> nothing done (fail-safe: SHOW)');
  ok(buildSteps({ hasKey: 'true' }).every((x) => x.done === false), 'a truthy non-boolean fact does not complete a step');

  // factsFrom() is the join between the two responses and the three steps.
  const f = factsFrom(keysBody({ hasGeminiKey: true }), statsBody([domain('a', 4)]));
  ok(f.hasKey === true && f.hasDomain === true && f.hasPages === true, 'factsFrom() maps both bodies');
  const f2 = factsFrom(null, null);
  ok(f2.hasKey === false && f2.hasDomain === false && f2.hasPages === false,
    'factsFrom(null, null) — a total request failure — is all-false, which SHOWS the panel');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. shouldShowPanel() — the auto-path gate, both rules, both ways');
// ═════════════════════════════════════════════════════════════════════════
{
  const none = buildSteps({ hasKey: false, hasDomain: false, hasPages: false });
  const some = buildSteps({ hasKey: true, hasDomain: false, hasPages: false });
  const all = buildSteps({ hasKey: true, hasDomain: true, hasPages: true });

  eq(shouldShowPanel(none, false), true, 'nothing done + not dismissed -> SHOW');
  eq(shouldShowPanel(some, false), true, 'partly done + not dismissed -> SHOW');
  eq(shouldShowPanel(none, true), false, 'nothing done + dismissed -> hide');

  // D-D: completing setup IS the dismissal. Nobody should have to click ×
  // to get rid of a checklist they have finished.
  eq(shouldShowPanel(all, false), false, 'all done -> hide even though never dismissed');
  eq(shouldShowPanel(all, true), false, 'all done + dismissed -> hide');

  // `dismissed` is compared strictly, so an undefined/absent value reads as
  // "not dismissed" — the SHOW direction, matching the fail-safe rule.
  eq(shouldShowPanel(none, undefined), true, 'an absent dismissed value -> SHOW (fail-safe)');
  eq(shouldShowPanel(none, 'yes'), true, 'a truthy non-boolean does NOT count as dismissed');

  eq(shouldShowPanel([], false), false, 'an empty step list -> hide (nothing to say)');
  eq(shouldShowPanel(null, false), false, 'a null step list -> hide rather than render nothing');

  eq(progressLabel(none), '0 of 3 done', 'progress label counts nothing done');
  eq(progressLabel(some), '1 of 3 done', 'progress label counts one done');
  eq(progressLabel(all), '3 of 3 done', 'progress label counts all done');
  eq(progressLabel(null), '0 of 0 done', 'progress label survives a null list');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. readDismissed() — THE fail-safe. A THROWING read must SHOW.');
// ═════════════════════════════════════════════════════════════════════════
// This is the single most important assertion in this file, so it is driven
// against the REAL extracted function with a storage object that genuinely
// throws — the behaviour a private-mode browser actually has — rather than
// asserted with a source regex.
//
// The direction is deliberately the OPPOSITE of a consent. v3.6.0
// established that a consent fails CLOSED (ask again). This is guidance:
// re-appearing is harmless, while permanently hiding first-run setup has NO
// VISIBLE SYMPTOM — the user simply never learns the app needs a key.
{
  const throwing = {
    getItem() { throw new Error('SecurityError: storage is disabled'); },
    setItem() { throw new Error('SecurityError: storage is disabled'); },
    removeItem() { throw new Error('SecurityError: storage is disabled'); },
  };
  eq(readDismissed(throwing), false,
    'a THROWING localStorage read reports NOT dismissed — i.e. the panel SHOWS (fail-safe)');

  // …and prove that verdict actually reaches the gate, rather than only
  // being a nice return value in isolation.
  const none = buildSteps(null);
  eq(shouldShowPanel(none, readDismissed(throwing)), true,
    'end to end: storage throws -> gate says SHOW');

  // A storage that returns undefined/null (key absent) is the ordinary
  // first-launch case and must behave identically.
  eq(readDismissed({ getItem: () => null }), false, 'key absent -> not dismissed');
  eq(readDismissed({ getItem: () => undefined }), false, 'undefined -> not dismissed');

  // The stored form is an exact match, so a stray value cannot be read as a
  // dismissal by accident.
  eq(readDismissed({ getItem: () => '1' }), true, 'the stored marker "1" -> dismissed');
  eq(readDismissed({ getItem: () => 'true' }), false, 'any OTHER value is not a dismissal');
  eq(readDismissed({ getItem: () => '' }), false, 'an empty string is not a dismissal');

  // The key it reads is the one the writer writes, and it is namespaced the
  // way every other /next key is.
  let wrote = null;
  const capture = { setItem: (k, v) => { wrote = [k, v]; } };
  eq(writeDismissed(capture), true, 'writeDismissed reports success on a working storage');
  ok(wrote && wrote[0] === DISMISS_KEY, 'it writes the SAME key readDismissed reads');
  ok(wrote && wrote[1] === '1', 'and the value readDismissed accepts');
  ok(readDismissed({ getItem: (k) => (k === DISMISS_KEY ? wrote[1] : null) }) === true,
    'round trip: what was written reads back as dismissed');
  eq(DISMISS_KEY, 'curator-next-onboarding-dismissed-v1', 'the key is namespaced curator-next-*');

  // A refused WRITE is best-effort — it must not throw out of the dismiss
  // handler; the panel simply returns next launch.
  eq(writeDismissed(throwing), false, 'a throwing write reports failure instead of throwing');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. Every step POINTS. Nothing here writes anything.');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(targetViewFor('api-key'), 'settings', 'step 1 points at Settings (its freshState opens on Providers & keys)');
  eq(targetViewFor('domain'), 'domains', 'step 2 points at Domains');
  eq(targetViewFor('ingest'), 'ingest', 'step 3 points at Ingest');
  eq(targetViewFor('nope'), null, 'an unknown step id points nowhere (no accidental navigation)');
  eq(targetViewFor(undefined), null, 'an absent step id points nowhere');
  ok(STEP_ORDER.every((id) => targetViewFor(id) !== null), 'every real step has a destination');

  // No writes of any kind. The create-domain rule is the sharp one: the
  // /next tree is allowed exactly ONE POST /api/domains call site
  // (views/domains.js), pinned by scripts/test-next-chat-compile.js. A
  // second one — even a "shared helper" both surfaces call — re-creates the
  // duplicate create-path collision v3.7.0 deleted.
  ok(!/method:\s*['"`]POST['"`]/.test(obCode), 'onboarding.js issues NO POST at all');
  ok(!/\/api\/domains['"`]\s*,/.test(obCode), 'and no POST-shaped call to /api/domains');
  ok(!/POST/.test(obCode), 'the string POST does not appear in the module code');

  // Only the two READ endpoints it needs.
  const fetched = [...obCode.matchAll(/getJson\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
  ok(JSON.stringify(fetched) === JSON.stringify(['/api/config/api-keys', '/api/domains/stats']),
    `it reads exactly the two GET endpoints it needs — found ${JSON.stringify(fetched)}`);

  // D-A: never reintroduce the fields v3.0.13 deliberately removed.
  ok(!/geminiUsable|anthropicUsable|getEffectiveKey/.test(obCode),
    'no geminiUsable / anthropicUsable / getEffectiveKey — the config-only rule (CLAUDE.md invariant)');

  // It clicks Domains' OWN create button rather than owning a second one.
  ok(/dm-new-domain-btn/.test(obCode), 'step 2 reaches Domains\u2019 own New-domain button');
  ok(/getElementById\('dm-new-domain-btn'\)\?\./.test(obCode),
    'and does so optionally (?.) so a renamed id degrades to "you are on Domains", never a throw');
  ok(readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8').includes('id="dm-new-domain-btn"'),
    'that id really exists in views/domains.js today (this guard would rot silently otherwise)');

  // ── THE ORDER IS THE MECHANISM, and it was unpinned ────────────────────
  // Found by adversarial audit: swapping go()'s two statements to
  // click-then-navigate left this suite at 161 passed / 0 failed. Step 2
  // works ONLY because navigate(view) runs FIRST — Domains' render() →
  // renderSidebar() → setSidebar() chain is synchronous, so the
  // `!state.loaded` branch has already emitted and bound #dm-new-domain-btn
  // by the time the click lands. Click first and the button does not exist
  // yet; the `?.` then swallows it SILENTLY and step 2 degrades to "you land
  // on Domains and no form opens", with no error in the console, no failed
  // request, and nothing anywhere to notice.
  //
  // The six-line comment in onboarding.js reasons about this correctly and
  // is verified correct — but a comment is not a guard, and this is exactly
  // the "correct today, untested" shape that rots on the next refactor of
  // Domains' mount path. Asserted on the extracted body of go() rather than
  // on the whole file, so an unrelated navigate( elsewhere cannot satisfy
  // it. Mutation-proven immediately below.
  const goBody = extractFunction(obCode, 'go');
  const iNav = goBody.indexOf('navigate(');
  const iCreate = goBody.indexOf('goToDomainsCreate(');
  ok(iNav >= 0, 'go() calls navigate()');
  ok(iCreate >= 0, 'go() reaches the create flow via goToDomainsCreate()');
  ok(iNav >= 0 && iCreate >= 0 && iNav < iCreate,
    'go() navigates BEFORE opening the create form — the button only exists after Domains mounts');
  // Covers the inlined variant too: if the click site is ever moved into
  // go() directly, it must still sit after the navigate.
  const iBtn = goBody.indexOf('dm-new-domain-btn');
  ok(iBtn === -1 || iBtn > iNav,
    'if the button is ever reached from inside go() directly, it is still after navigate()');

  // Mutation proof (in memory — this suite never writes to disk): reproduce
  // the exact swap the audit used and confirm the assertion above goes RED.
  {
    const swapped = goBody
      .replace(/\n(\s*)navigate\(view\);\n(\s*)if \(stepId === 'domain'\) goToDomainsCreate\(\);\n/,
        "\n$2if (stepId === 'domain') goToDomainsCreate();\n$1navigate(view);\n");
    ok(swapped !== goBody, 'the mutation actually LANDED in the copy (a no-op replace would prove nothing)');
    const mNav = swapped.indexOf('navigate(');
    const mCreate = swapped.indexOf('goToDomainsCreate(');
    ok(!(mNav >= 0 && mCreate >= 0 && mNav < mCreate),
      'CONFIRMED RED: click-then-navigate in a copy of go() trips the ordering assertion the real source passes');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('6. THE BLANK-PAGE RISK — the boot hook cannot stop markBooted()');
// ═════════════════════════════════════════════════════════════════════════
// app.js calls markBooted() immediately after boot() returns, and
// next/index.html's inline <head> guard treats an unset
// window.__curatorBooted at DOMContentLoaded as proof the module died — it
// then paints a full-page recovery panel to EVERY user. A boot hook that
// can throw synchronously therefore ships a blank page.
//
// WHAT THIS SECTION PROVES: that the call site has the SHAPE that cannot
// throw synchronously — not awaited, boot() not async, wrapped in
// try/catch, and the callee declared async.
// WHAT IT DOES NOT PROVE: that the browser actually boots. Only loading the
// page and reading window.__curatorBooted does that, and that was done
// separately, in a browser. This is a shape guard, deliberately labelled.
{
  // Deliberately tolerant of `async` here even though the next assertion
  // forbids it. Mutation-found: an extraction that only matches the CORRECT
  // form leaves bootBody empty on the very mutation this section exists to
  // catch, and "the call is NOT awaited" then passes VACUOUSLY over an
  // empty string. The body must be extracted whatever shape boot() has, so
  // the await assertion is a real read of real code.
  const bootM = /\n(?:async )?function boot\(\) \{([\s\S]*?)\n\}\n/.exec(appCode);
  ok(!!bootM, 'boot() is found in app.js');
  const bootBody = bootM ? bootM[1] : '';
  ok(bootBody.length > 100, 'and its body was really extracted (not an empty match the guards below would skate over)');

  ok(/^function boot\(\)/m.test(appCode), 'boot() is NOT declared async');
  ok(!/\basync function boot\(\)/.test(appCode), 'and nothing made it async');
  ok(bootBody.includes('maybeShowOnboarding()'), 'boot() calls maybeShowOnboarding()');

  // THE assertion. `await maybeShowOnboarding()` is the exact regression
  // this exists to catch — it would require boot() to become async, and it
  // would let a rejection propagate before markBooted() runs.
  ok(!/await\s+maybeShowOnboarding\s*\(/.test(bootBody),
    'the call is NOT awaited');
  ok(!/\bawait\b/.test(bootBody), 'boot() contains no await at all');

  // Layer 3: the call site's own try/catch.
  ok(/try\s*\{\s*maybeShowOnboarding\(\);\s*\}\s*catch/.test(bootBody),
    'the call is wrapped in its own try/catch at the call site');

  // Layer 2: an async callee cannot throw synchronously at all.
  ok(/export async function maybeShowOnboarding\(\)/.test(obCode),
    'maybeShowOnboarding is declared async, so it can only ever REJECT, never throw synchronously');

  // And the whole body of that function is itself inside a try/catch, so it
  // does not even reject.
  const mso = extractFunction(ob, 'maybeShowOnboarding');
  ok(/\{\s*\n\s*try \{/.test(mso), 'its body opens with try { — it swallows its own failures');
  ok(/catch \(err\) \{[\s\S]*console\.error/.test(mso), 'and reports them to the console rather than rethrowing');

  // Ordering: markBooted() still runs after boot(), unchanged.
  ok(/boot\(\);\s*\n?\s*markBooted\(\);/.test(appCode.replace(/\n\s+/g, '\n  ')) ||
     /boot\(\); markBooted\(\);/.test(appCode.replace(/\s+/g, ' ')),
    'markBooted() is still called immediately after boot()');

  // The import is a plain named import for its EXPORT, not a
  // registerView() side effect — onboarding.js is not a view.
  ok(/import \{ maybeShowOnboarding \} from '\.\/views\/onboarding\.js';/.test(appCode),
    'app.js imports the hook by name from views/onboarding.js');
  ok(!/registerView\(/.test(obCode), 'onboarding.js registers no view (it is shell-level, not a view)');

  // ── Mutation self-check: prove these assertions can actually go red ────
  // A guard that cannot fail is worth nothing. Run the same predicates over
  // a synthetic boot() carrying the exact regression, in memory — this
  // suite never writes to disk.
  const badBoot = 'async function boot() {\n  renderRail();\n  await maybeShowOnboarding();\n}\n';
  const badBody = /\nasync function boot\(\) \{([\s\S]*?)\n\}\n/.exec('\n' + badBoot)[1];
  ok(/await\s+maybeShowOnboarding\s*\(/.test(badBody), 'detector FIRES on a bare `await maybeShowOnboarding()`');
  ok(!/try\s*\{\s*maybeShowOnboarding\(\);\s*\}\s*catch/.test(badBody), 'detector FIRES on a missing try/catch');
  ok(/\basync function boot\(\)/.test(badBoot), 'detector FIRES on an async boot()');
}

// ═════════════════════════════════════════════════════════════════════════
section('7. It is a REGION, not a dialog (D-E) — no modality, no trap');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/role="region"/.test(obCode), 'the panel carries role="region"');
  ok(/aria-labelledby="obp-title"/.test(obCode), 'labelled by its own heading');
  ok(/id="obp-title"/.test(obCode), 'and that heading really has that id');

  ok(!/role="dialog"/.test(obCode), 'NO role="dialog" — it does not block, so it must not claim to');
  ok(!/aria-modal/.test(obCode), 'NO aria-modal');
  ok(!/aria-hidden="true"[\s\S]{0,40}app-shell/.test(obCode), 'it never hides the rest of the app from assistive tech');

  // Focus trapping. The two real wizards install a document-level keydown
  // handler in capture phase to trap Tab; this must not.
  ok(!/Tab/.test(obCode), 'no Tab handling — there is no focus trap');
  ok(!/document\.addEventListener\('keydown'/.test(obCode), 'no document-level keydown handler at all');
  ok(!/preventDefault/.test(obCode), 'it never preventDefaults a key or a click');
  ok(!/inert|\.showModal\(/.test(obCode), 'no inert / showModal modality');

  // Escape must NOT be handled here — app.js already owns Escape (it closes
  // the reader), and a second handler would make Escape ambiguous.
  ok(!/Escape/.test(obCode), 'Escape is left to the shell (app.js closes the reader with it)');

  // A real <button> with an accessible name for dismissal.
  ok(/<button type="button" class="obp-dismiss"[\s\S]{0,120}aria-label="Dismiss the setup guide"/.test(obCode),
    'dismiss is a real <button> with an accessible name');
  ok(/aria-live="polite"/.test(obCode), 'the updating progress line is aria-live="polite"');
  ok(!/aria-live="assertive"/.test(obCode), 'and never assertive — guidance must not interrupt');

  // Must not steal focus on the automatic path.
  ok(/openPanel\(next, \{ focus: false \}\)/.test(obCode),
    'the AUTOMATIC path opens with focus: false — it never steals the caret');
  ok(/openPanel\(steps, \{ focus: true, autoCloseOnComplete: false \}\)/.test(obCode),
    'the EXPLICIT (Settings) path opens with focus: true');

  // Dismiss must not strand focus on a removed node.
  ok(/root\.contains\(document\.activeElement\)/.test(obCode),
    'close() checks whether focus was inside the panel before removing it');
  ok(/restore\.isConnected/.test(obCode),
    'and only restores a previous focus target that is still in the document');

  // Escaping discipline: nothing reaches innerHTML unescaped. Scoped to the
  // ONE function that builds markup — scanning the whole module produced a
  // false positive on progressLabel(), which concatenates a plain string
  // (and whose OUTPUT is escaped at its render call site anyway). A guard
  // that cries wolf on non-markup gets weakened by the next person to touch
  // it; keeping it aimed at markup keeps it credible.
  const renderFn = extractFunction(ob, 'render');
  const interpolationsIn = (src) =>
    [...src.matchAll(/'\s*\+\s*([A-Za-z_$][\w$.()\[\]]*)\s*\+\s*'/g)].map((m) => m[1]);
  const unguarded = (src) =>
    interpolationsIn(src).filter((x) => !/^escapeHtml\(|^icon\(|^rows$|^String\(/.test(x));
  const found = unguarded(renderFn);
  ok(interpolationsIn(renderFn).length >= 5,
    `render() really does interpolate (${interpolationsIn(renderFn).length} sites — a near-zero count means this scanner stopped reaching it)`);
  ok(found.length === 0,
    `every value interpolated into markup goes through escapeHtml()/icon() — unguarded: ${JSON.stringify(found)}`);
  // Negative control: the detector can actually fail.
  ok(unguarded(`x = '<b>' + s.title + '</b>' + escapeHtml(y) + '';`).length === 1,
    'the escaping detector fires on a raw `+ s.title +` interpolation');
}

// ═════════════════════════════════════════════════════════════════════════
section('8. The Settings re-open seam (D-C) and the ownership asymmetry');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/import \{ openOnboardingPanel \} from '\.\/onboarding\.js';/.test(settingsCode),
    'settings.js imports openOnboardingPanel');
  ok(/id="btn-show-setup-guide"/.test(settingsCode), 'the General section renders a Show setup guide button');
  ok(/getElementById\('btn-show-setup-guide'\)/.test(settingsCode), 'and wires it');
  ok(/openOnboardingPanel\(\)\)/.test(settingsCode), 'the click calls openOnboardingPanel()');

  // Exactly ONE re-open control across the whole /next tree — R7 asks for a
  // way back, not several competing ones.
  const reopenSites = (settingsCode.match(/openOnboardingPanel\(\)/g) || []).length;
  eq(reopenSites, 1, 'exactly one call site for the re-open control');

  // THE ASYMMETRY: the MCP wizard IS closed by this view's teardown; the
  // onboarding panel must NOT be. It is shell-level and has to survive
  // navigate() — closing it on leaving Settings would make step 2 and 3
  // unreachable the instant the user followed step 1.
  ok(/closeMcpWizardIfOpen\(\);/.test(settingsCode), 'the MCP wizard IS still closed by settings teardown');
  ok(!/closeOnboarding/.test(settingsCode), 'settings.js never closes the onboarding panel');
  ok(!/closeOnboarding/.test(obCode.replace(/closePanel/g, '')), 'and the module exports no close for it to call');
  const exports = [...obCode.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]).sort();
  ok(JSON.stringify(exports) === JSON.stringify(['maybeShowOnboarding', 'openOnboardingPanel']),
    `the module exports exactly the two entry points — found ${JSON.stringify(exports)}`);

  // Clicking "Show setup guide" must clear the dismissal, or the button
  // would do nothing for the one user who needs it.
  ok(/clearDismissed\(storage\(\)\)/.test(obCode), 'the explicit re-open clears the dismissed flag');
}

// ═════════════════════════════════════════════════════════════════════════
section('9. Staleness discipline (D-F) — captured LOCALLY, compared live');
// ═════════════════════════════════════════════════════════════════════════
// The panel DOES do async work that touches the DOM (the background
// re-check), so it needs a generation counter. HANDOFF bug #8 was a token
// stored in a module variable and read LIVE on BOTH sides, so it always
// compared equal and the guard was inert.
{
  ok(/let panelGen = 0;/.test(obCode), 'a module-level generation counter exists');
  ok(/function isFresh\(myGen\) \{ return myGen === panelGen; \}/.test(obCode),
    'isFresh compares a PASSED-IN value against the live counter');

  const refresh = extractFunction(ob, 'refresh');
  ok(/^async function refresh\(myGen\)/.test(refresh),
    'refresh() takes myGen as a PARAMETER — it never re-reads the module variable after an await');
  ok(!/const myGen = panelGen/.test(refresh),
    'and specifically does not re-capture it inside itself (that is the inert-guard shape)');
  const checks = (refresh.match(/isFresh\(myGen\)/g) || []).length;
  ok(checks >= 2, `refresh() re-checks freshness ${checks} times — before and after the await`);
  ok(/if \(!isFresh\(myGen\) \|\| !root\) return;[\s\S]*await loadFacts\(\)[\s\S]*if \(!isFresh\(myGen\) \|\| !root\) return;/.test(refresh),
    'one check sits before the await and one after it');

  // Every caller captures synchronously.
  for (const fn of ['go', 'openOnboardingPanel', 'startRefresh']) {
    const body = extractFunction(ob, fn);
    ok(/const myGen = panelGen;\s*\n\s*refresh\(myGen\)/.test(body) || /refresh\(panelGen\)/.test(body),
      `${fn}() passes the counter into refresh() rather than letting refresh read it`);
  }

  ok(/panelGen \+= 1;/.test(extractFunction(ob, 'openPanel')), 'opening bumps the counter');
  ok(/panelGen \+= 1;/.test(extractFunction(ob, 'closePanel')), 'closing bumps it too, staling every in-flight handler');

  // The refresh loop must be self-terminating, not a forever background poll.
  ok(/clearInterval\(refreshTimer\)/.test(obCode), 'the interval is cleared');
  ok(/stopRefresh\(\);/.test(extractFunction(ob, 'closePanel')), 'closing the panel stops the loop');
  ok(/document\.visibilityState === 'hidden'/.test(obCode), 'and it does nothing while the tab is hidden');
}

// ═════════════════════════════════════════════════════════════════════════
section('10. CSS — tokens, [data-theme], prefix ownership, no scrim');
// ═════════════════════════════════════════════════════════════════════════
{
  // The stylesheet must be LINKED, or it is both unstyled in the browser
  // AND invisible to test-css-tokens.js §5, which discovers /next
  // stylesheets only from index.html's <link> tags.
  ok(/href="\/next\/views\/onboarding\.css"/.test(nextIndex),
    'onboarding.css is linked from next/index.html');
  ok(!/href="views\/onboarding\.css"/.test(nextIndex),
    'and the ref is ROOT-ABSOLUTE, matching the cutover rule test-next-asset-paths.js pins');

  ok(!/prefers-color-scheme/.test(obCssCode), 'theming is [data-theme] only, never prefers-color-scheme');

  // No modality chrome. This is the CSS half of D-E.
  ok(!/obp-scrim/.test(obCssCode), 'there is NO scrim class');
  ok(!/inset:\s*0/.test(obCssCode), 'and nothing covers the whole viewport');
  ok(!/backdrop-filter/.test(obCssCode), 'no backdrop blur — that is modal chrome');
  const zIndexes = [...obCssCode.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  ok(zIndexes.length > 0 && zIndexes.every((z) => z < 40),
    `every z-index is below the reader overlay's 40 — found ${JSON.stringify(zIndexes)}`);

  // It must not swallow clicks meant for the view underneath.
  ok(/pointer-events:\s*none/.test(obCssCode), 'the full-width wrapper is pointer-events: none');
  ok(/pointer-events:\s*auto/.test(obCssCode), 'and only the card itself takes pointer events back');

  // The composer rule (R7). Anchored to the TOP so it provably cannot cover
  // the bottom-anchored chat composer.
  ok(/\.obp-root \{[\s\S]*?top:\s*0;/.test(obCssCode), '.obp-root is anchored to the TOP');
  ok(!/\.obp-root \{[\s\S]*?\n\s*bottom:/.test(obCssCode),
    '.obp-root has NO bottom anchor — the chat composer lives at the bottom and must never be covered');
  ok(/left:\s*calc\(60px \+ var\(--app-sidebar-w\)\)/.test(obCssCode),
    'it is clipped to the main column with the same grid geometry .reader-scrim uses');

  // Prefix ownership: `obp-` belongs to this pair of files only.
  const otherNextCss = ['shell.css', 'views/shared.css', 'views/settings.css', 'views/chat.css',
    'views/domains.css', 'views/ingest.css', 'views/sync.css', 'views/memory.css', 'views/mcp-wizard.css']
    .map((f) => readFileSync(path.join(ROOT, 'src/public/next', f), 'utf8')).join('\n');
  ok(!/\.obp-/.test(otherNextCss), 'no other /next stylesheet defines an .obp- rule');
  ok(!/obp-/.test(settingsCode), 'settings.js does not reach into the panel\u2019s class namespace');

  // No inline style="" with a var() — test-css-tokens.js §8 walks these.
  ok(!/style="[^"]*var\(/.test(obCode), 'no built HTML string carries a var() inside an inline style attribute');

  // Every var(--x) this file references must be defined somewhere in the
  // /next token universe. test-css-tokens.js enforces this globally; a
  // local copy here means a broken token fails the OWN suite too.
  const tokenSrc = readdirSync(path.join(ROOT, 'src/public/next/tokens'))
    .filter((f) => f.endsWith('.css') && f !== 'fonts.css')
    .map((f) => readFileSync(path.join(ROOT, 'src/public/next/tokens', f), 'utf8')).join('\n')
    + readFileSync(path.join(ROOT, 'src/public/next/shell.css'), 'utf8');
  const defined = new Set([...tokenSrc.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const referenced = [...new Set([...obCssCode.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  const undef = referenced.filter((n) => !defined.has(n));
  ok(referenced.length > 10, `the stylesheet really uses tokens (${referenced.length} distinct refs)`);
  ok(undef.length === 0, `every var(--x) resolves — undefined: ${JSON.stringify(undef)}`);

  // Negative control: the detector above can actually fail.
  ok(['--nope-not-a-token'].filter((n) => !defined.has(n)).length === 1,
    'the token detector fires on a deliberately fake token name');
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
