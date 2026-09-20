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
import { callSiteCount, checkLiteral } from './test-helpers/source-scan.js';

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
  'hasAnyProject',
  'bridgeHasBeenUsed',
  'factsFrom',
  'deriveDoor',
  'buildSteps',
  'readDismissed',
  'writeDismissed',
  'writeLandingView',
  'shouldShowPanel',
  'progressLabel',
  'targetViewFor',
];
// ORDER MATTERS, and only for one reason: these are emitted as `const`
// declarations in source order, so a const built FROM another (STEP_SETS
// reads STEP_ORDER and AGENT_STEP_ORDER) has to come after it or the
// sandbox throws on a temporal dead zone. It is not an ordering the module
// itself depends on.
const PURE_CONSTS = [
  'DISMISS_KEY', 'LANDING_VIEW_KEY',
  'STEP_ORDER', 'AGENT_STEP_ORDER', 'STEP_SETS',
  'DOORS', 'STEP_COPY', 'AGENT_STEP_COPY', 'UNKNOWN_FACTS',
];

const sandbox = new Function(
  PURE_CONSTS.map((c) => extractConst(ob, c)).join('\n') + '\n' +
  PURE_FNS.map((n) => extractFunction(ob, n)).join('\n\n') + '\n' +
  `return { ${PURE_FNS.join(', ')}, ${PURE_CONSTS.join(', ')} };`
)();

const {
  hasApiKey, hasAnyDomain, hasAnyPage, hasAnyProject, bridgeHasBeenUsed,
  factsFrom, deriveDoor, buildSteps, readDismissed,
  writeDismissed, writeLandingView, shouldShowPanel, progressLabel, targetViewFor,
  DISMISS_KEY, LANDING_VIEW_KEY, STEP_ORDER, AGENT_STEP_ORDER, STEP_SETS, DOORS,
  STEP_COPY, AGENT_STEP_COPY,
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
// GET /api/memory (src/routes/memory.js's index route) — one row per
// PROJECT across every domain since v3.48.0, with `total` the store's own
// count taken before its cap.
function memoryBody(rows, over) {
  return Object.assign({
    ok: true,
    projects: rows || [],
    total: (rows || []).length,
    truncated: false,
    layoutWarning: null,
    domainsScanned: 1,
  }, over || {});
}
function projectRow(domainSlug, project) {
  return { domain: domainSlug, project, distinctScopeCount: 0, savedCopies: 0, latestSavedAt: null };
}
// GET /api/mcp/usage (src/routes/mcp.js's usageHandler) — every catalogue
// row is returned whether used or not, with lastUsedAt null and the counts
// at 0 for a tool that has no line.
function usageBody(over, toolOver) {
  return Object.assign({
    present: false,
    logStartedAt: null,
    logBytes: 0,
    tools: [Object.assign({
      name: 'get_project_context', group: 'read', mutates: false, purpose: 'x',
      lastUsedAt: null, lastOk: null, count7d: 0, countTotal: 0, refusedTotal: 0,
    }, toolOver || {})],
    sessions: { lastBootstrapAt: null, lastSaveAt: null },
  }, over || {});
}
// Visible words, the way docs/design-system-source.md §3's ceiling is
// counted: punctuation is not a word and an em dash is not a word.
function wordCount(s) {
  return String(s).replace(/[—–-]/g, ' ').split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
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
section('1b. The two AGENT-side facts (v3.61.0) — the ones the old panel had no step for');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(hasAnyProject(memoryBody()), false, 'no projects anywhere -> false');
  eq(hasAnyProject(memoryBody([projectRow('projects', 'curator')])), true, 'one project row -> true');
  // `total` is the store's count BEFORE its own cap, so it is read as well
  // as the array — a capped list would otherwise be the only evidence, and
  // a cap is not a measurement (the v3.17.1 rule).
  eq(hasAnyProject(memoryBody([], { total: 7 })), true,
    'an EMPTY array with a non-zero `total` still counts — the list is capped, the count is not');
  eq(hasAnyProject(null), false, 'null body -> false (fetch failed)');
  eq(hasAnyProject({}), false, 'a body with neither field -> false');
  eq(hasAnyProject({ projects: 'curator' }), false, 'a non-array `projects` -> false');
  eq(hasAnyProject({ total: 'lots' }), false, 'a non-numeric `total` -> false');

  // THE POINT OF THIS PREDICATE, stated as an assertion: it must not be
  // `installed` from GET /api/mcp/config, which reads Claude Desktop's
  // config file only. A Claude Code or Cursor user would read false for
  // ever — step 3's never-completing defect, rebuilt.
  eq(bridgeHasBeenUsed(usageBody()), false,
    'a bridge that has never answered a call -> NOT done (present false, no lastUsedAt)');
  eq(bridgeHasBeenUsed(usageBody({ present: true, logStartedAt: '2026-09-01T00:00:00.000Z' })), false,
    'a log that EXISTS but records no call -> still not done ("nothing since this log began" is not a call)');
  eq(bridgeHasBeenUsed(usageBody(
    { present: true }, { lastUsedAt: '2026-09-18T10:00:00.000Z', countTotal: 3 })), true,
    'present + a tool with a lastUsedAt -> done');
  eq(bridgeHasBeenUsed(usageBody({ present: true }, { countTotal: 2 })), true,
    'a count with no timestamp is still evidence of a call');
  eq(bridgeHasBeenUsed(usageBody(
    { present: false }, { lastUsedAt: '2026-09-18T10:00:00.000Z' })), false,
    'a used tool without `present` -> false; both halves are required');
  eq(bridgeHasBeenUsed(usageBody({ present: true, tools: 'lots' })), false, 'a non-array `tools` -> false');
  eq(bridgeHasBeenUsed(usageBody({ present: true, tools: [null] })), false, 'a null row is tolerated');
  eq(bridgeHasBeenUsed(null), false, 'null body -> false (fetch failed)');
  eq(bridgeHasBeenUsed(usageBody({ present: 'yes' }, { countTotal: 9 })), false,
    'a truthy non-boolean `present` does NOT count (strict, like hasApiKey)');
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

  // THE KNOWLEDGE PATH IS UNCHANGED BY v3.61.0, and that is the first
  // audience's whole guarantee. Asserted as an EXACT comparison against a
  // hand-written expectation rather than "still three steps": a shuffled
  // order or edited action label would pass a length check.
  const oneArg = buildSteps({ hasKey: false, hasDomain: true, hasPages: false });
  const withDoor = buildSteps({ hasKey: false, hasDomain: true, hasPages: false }, 'knowledge');
  ok(JSON.stringify(oneArg) === JSON.stringify(withDoor),
    'a ONE-ARGUMENT call is byte-identical to an explicit knowledge call — every pre-v3.61.0 caller still means what it meant');
  // v3.64.0: the ingest step's ACTION reads "Open Domains", not "Open
  // Ingest". The step id, its title and its body are unchanged because the
  // JOB is unchanged — only where the job lives moved (Ingest left the rail
  // and became the ADD SOURCES section of the domain page), and a button
  // that says where it goes is the panel's own rule: every step POINTS at
  // the real surface that owns that job.
  ok(JSON.stringify(oneArg.map((x) => [x.id, x.action, x.done]))
    === JSON.stringify([['api-key', 'Open Settings', false], ['domain', 'Open Domains', true], ['ingest', 'Open Domains', false]]),
    'and the knowledge set is exactly key/domain/ingest with its own actions and its own done-ness');
  eq(STEP_COPY.ingest.title, 'Ingest your first source',
    'the ingest step still SAYS ingest — the job did not change, only where it is done');
  ok(oneArg.every((x) => x.optional === false), 'no knowledge step is marked optional — all three are needed for that path');
  ok(JSON.stringify(buildSteps(null, 'nonsense')) === JSON.stringify(buildSteps(null)),
    'an UNKNOWN door falls back to the shipped knowledge set, never to an empty list');
}

// ═════════════════════════════════════════════════════════════════════════
section('2b. The AGENT step set — four steps, the key LAST and optional');
// ═════════════════════════════════════════════════════════════════════════
{
  const blank = { hasKey: false, hasDomain: false, hasPages: false, hasProject: false, bridgeUsed: false };
  const a = buildSteps(blank, 'agent');
  eq(a.length, 4, 'exactly four steps');
  ok(JSON.stringify(a.map((x) => x.id)) === JSON.stringify(['domain', 'project', 'bridge', 'api-key']),
    'domain -> project -> bridge -> api-key, in that order');
  ok(JSON.stringify(AGENT_STEP_ORDER) === JSON.stringify(['domain', 'project', 'bridge', 'api-key']),
    'AGENT_STEP_ORDER itself is that order');
  ok(STEP_SETS.knowledge === STEP_ORDER && STEP_SETS.agent === AGENT_STEP_ORDER,
    'STEP_SETS names the two orders rather than re-typing them');

  // ── THE DEFECT THIS SET EXISTS TO FIX ──────────────────────────────────
  // The key is LAST and it is flagged optional, because the memory layer
  // and the bridge need no model: mcp/server.js reads and writes markdown
  // directly and never calls a provider.
  eq(a[3].id, 'api-key', 'the key is the LAST step, not the first');
  ok(a[3].optional === true, '…and it is the one step marked optional');
  ok(a.filter((x) => x.optional === true).length === 1,
    'exactly ONE of the four carries the flag — a mark on all of them would carry nothing (v3.16.1)');
  ok(/needed for ingest and chat/i.test(a[3].body),
    'its body names WHAT the key is for rather than claiming nothing works without it');
  ok(!/nothing else works|nothing works/i.test(a[3].body),
    'THE FALSE CLAIM, GUARDED: the agent path never says nothing works without a model');

  // Each new fact drives exactly its own step, both directions.
  const p = buildSteps(Object.assign({}, blank, { hasProject: true }), 'agent');
  ok(p[1].done === true && p[0].done === false && p[2].done === false && p[3].done === false,
    'hasProject completes ONLY the project step');
  const b = buildSteps(Object.assign({}, blank, { bridgeUsed: true }), 'agent');
  ok(b[2].done === true && b[0].done === false && b[1].done === false && b[3].done === false,
    'bridgeUsed completes ONLY the bridge step');
  const all = buildSteps({ hasKey: true, hasDomain: true, hasPages: false, hasProject: true, bridgeUsed: true }, 'agent');
  ok(all.every((x) => x.done === true),
    'THE OTHER HALF OF THE DEFECT: this set CAN complete without a single ingested page (hasPages false)');
  eq(progressLabel(all), '4 of 4 done', 'and the progress line counts four, not three');

  // A done step's copy differs from its todo copy, on the two new steps too.
  ok(p[1].body !== a[1].body && b[2].body !== a[2].body,
    'both new steps read differently once they are done');

  // The SHARED steps are the same steps: same fact, same action, same
  // destination — only the api-key copy is overridden.
  const k = buildSteps(Object.assign({}, blank, { hasDomain: true }), 'knowledge');
  ok(a[0].title === k[1].title && a[0].action === k[1].action,
    'the domain step is the SAME step in both sets, not a second copy of it');
  ok(a[3].title === k[0].title && a[3].action === k[0].action,
    'and so is the key step — the override touches the body and the flag, nothing else');
  ok(a[3].body !== k[0].body, '…but its body IS overridden for this audience');
  const kDone = buildSteps({ hasKey: true, hasDomain: false, hasPages: false }, 'knowledge');
  const aDone = buildSteps(Object.assign({}, blank, { hasKey: true }), 'agent');
  ok(aDone[3].body === kDone[0].body,
    'the DONE copy is shared — a saved key means the same thing to both audiences');
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
  // ── v3.64.0: STEP 3 POINTS AT DOMAINS ───────────────────────────────
  // Not at the (still-registered, still-reachable) full-page Ingest view.
  // This lookup's whole contract is "which view does this step navigate
  // to", and go() calls navigate() with exactly what it returns — a table
  // that answered 'ingest' while go() went to 'domains' would be a lookup
  // that lies, and the pure-lookup shape exists precisely so this suite can
  // assert the mapping without standing up a shell.
  eq(targetViewFor('ingest'), 'domains',
    'step 3 points at Domains, which hosts ADD SOURCES — the Ingest VIEW still exists (app.js HOSTED_VIEWS) and is simply not where a checklist sends anyone');
  {
    const appSrc = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
    ok(/const HOSTED_VIEWS = \[[^\]]*'ingest'/.test(appSrc),
      "…and 'ingest' is in app.js's HOSTED_VIEWS, so retargeting this step did not orphan the view");
  }
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

  // Only the READ endpoints it needs — FOUR since v3.61.0, and the list is
  // exact rather than a floor, because this panel POLLS: an endpoint added
  // here is added to a timer, and two of the four are the reason
  // loadFacts() fetches conditionally at all.
  const fetched = [...obCode.matchAll(/getJson\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
  ok(JSON.stringify(fetched) === JSON.stringify(
    ['/api/config/api-keys', '/api/domains/stats', '/api/mcp/usage', '/api/memory']),
    `it reads exactly the four GET endpoints it needs — found ${JSON.stringify(fetched)}`);

  // ── THE AGENT PAIR IS CONDITIONAL, AND THAT IS EXECUTED ───────────────
  // GET /api/memory walks every domain's state tree, so fetching it twelve
  // times a minute on an install where it cannot change the answer is a
  // real cost on the exact install this panel already polls forever (a
  // populated wiki whose only key lives in .env — this file's header).
  // Driven against the real loadFacts() with a recording getJson.
  const loadFactsSrc = extractFunction(obCode, 'loadFacts');
  function runLoadFacts(chosen, stats) {
    const seen = [];
    const box = new Function('getJson', 'factsFrom', 'hasAnyPage',
      loadFactsSrc + '\nreturn { loadFacts };')(
      (url) => { seen.push(url); return Promise.resolve(url === '/api/domains/stats' ? stats : null); },
      (...args) => args,
      (s) => !!(s && Array.isArray(s.domains) && s.domains.some((d) => Number(d.pageCount) > 0)),
    );
    return box.loadFacts(chosen).then(() => seen.sort());
  }
  const popul = statsBody([domain('articles', 3445)]);
  const bare = statsBody([domain('articles', 0)]);
  const cases = await Promise.all([
    runLoadFacts(null, popul), runLoadFacts(null, bare),
    runLoadFacts('knowledge', bare), runLoadFacts('agent', popul),
  ]);
  ok(JSON.stringify(cases[0]) === JSON.stringify(['/api/config/api-keys', '/api/domains/stats']),
    'no door yet + pages already exist -> the agent pair is NOT fetched (the door is decided by that one fact)');
  ok(cases[1].length === 4 && cases[1].includes('/api/memory') && cases[1].includes('/api/mcp/usage'),
    'no door yet + no pages -> both agent facts ARE fetched, because either could decide the door');
  ok(JSON.stringify(cases[2]) === JSON.stringify(['/api/config/api-keys', '/api/domains/stats']),
    'the KNOWLEDGE door never pays for them — neither fact appears in its step set');
  ok(cases[3].length === 4,
    'the AGENT door always fetches them, pages or not — two of its four ticks are those facts');

  // D-A: never reintroduce the fields v3.0.13 deliberately removed.
  ok(!/geminiUsable|anthropicUsable|getEffectiveKey/.test(obCode),
    'no geminiUsable / anthropicUsable / getEffectiveKey — the config-only rule (CLAUDE.md invariant)');

  // It clicks Domains' OWN create button rather than owning a second one.
  ok(/dm-new-domain-btn/.test(obCode), 'step 2 reaches Domains\u2019 own New-domain button');
  ok(/getElementById\('dm-new-domain-btn'\)\?\./.test(obCode),
    'and does so optionally (?.) so a renamed id degrades to "you are on Domains", never a throw');
  ok(readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8').includes('id="dm-new-domain-btn"'),
    'that id really exists in views/domains.js today (this guard would rot silently otherwise)');

  // ── THE ORDER IS THE MECHANISM, and it is now EXECUTED ────────────────
  // Found by adversarial audit in v3.49.0: swapping go()'s two statements to
  // click-then-navigate left this suite at 161 passed / 0 failed. Step 2 works
  // only because the create button exists by the time the click lands — click
  // first and the `?.` swallows it SILENTLY, so step 2 degrades to "you land
  // on Domains and no form opens", with no error in the console, no failed
  // request, and nothing anywhere to notice.
  //
  // v3.57.0 MADE THAT SILENT FAILURE THE DEFAULT, and that is why this block
  // stopped being a source scan. navigate() gained an exit animation, so the
  // mount now happens ~80ms after it returns instead of before — the ordering
  // of two STATEMENTS says nothing at all about the ordering of the two EVENTS
  // any more. go() therefore queues the click through the shell's
  // afterViewMount(), and what has to be proven is a sequence in time: the
  // click lands AFTER the mount, and it lands EXACTLY ONCE.
  //
  // So go() and goToDomainsCreate() are lifted and RUN, against a document
  // whose button only appears when the mount does. Both arms are driven: the
  // deferred one (motion on) and the immediate one (motion off, or a first
  // navigation, where afterViewMount runs its callback in the same task).
  const goSrc = extractFunction(obCode, 'go') + '\n' + extractFunction(obCode, 'goToDomainsCreate');
  ok(/afterViewMount\(/.test(goSrc),
    'go() hands the create click to the shell’s afterViewMount() rather than calling it inline');
  ok(/import \{[^}]*\bafterViewMount\b[^}]*\} from '\.\.\/app\.js'/.test(obCode),
    '…and imports it from app.js, the one module that knows when a mount has happened');
  ok(/export function afterViewMount\(/.test(
      readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8')),
    '…which app.js really exports today (this guard would rot silently otherwise)');

  /** Run the REAL go() with a document whose #dm-new-domain-btn only exists
   *  once the mount has happened, exactly as the live shell behaves. */
  function runGo(stepId, { deferMount }) {
    const log = [];
    // An ARRAY, because that is what app.js's afterViewMount really keeps. A
    // single-slot stub would silently collapse a double-queue into one call
    // and report the "exactly one click" assertion below as green.
    const queued = [];
    let mounted = false;
    const btn = { click: () => log.push('click') };
    const api = new Function(
      'navigate', 'afterViewMount', 'targetViewFor', 'document', 'refresh', 'panelGen',
      'requestDomainFold', 'ADD_SOURCES_FOLD',
      goSrc + '\nreturn { go };')(
      (v) => { log.push('navigate:' + v); if (!deferMount) mounted = true; },
      (cb) => {
        log.push('afterViewMount');
        if (deferMount) { queued.push(cb); return; }
        cb();
      },
      (id) => (id === 'domain' ? 'domains' : id === 'api-key' ? 'settings'
        : id === 'ingest' ? 'domains' : null),
      { getElementById: (id) => ((id === 'dm-new-domain-btn' && mounted) ? btn : null) },
      () => log.push('refresh'),
      0,
      // v3.64.0: the shell handoff that opens the ADD SOURCES fold. Logged
      // into the SAME array as navigate(), because the ORDER of the two is
      // the behaviour under test — see the ingest block below.
      (id) => log.push('requestDomainFold:' + id),
      'add-sources',
    );
    let threw = null;
    try { api.go(stepId); } catch (e) { threw = e; }
    return {
      log, threw,
      flushMount() { mounted = true; const q = queued.splice(0); for (const c of q) c(); },
    };
  }

  {
    // MOTION ON — the mount is one tick away.
    const r = runGo('domain', { deferMount: true });
    ok(r.threw === null, 'go() does not throw while the mount is still pending');
    ok(!r.log.includes('click'),
      'THE DEFECT, GUARDED: the create button is NOT clicked while the exit animation is still playing — it does not exist yet, and `?.` would swallow the miss in silence');
    r.flushMount();
    ok(r.log.includes('click'), '…and IS clicked once the view has mounted');
    ok(r.log.indexOf('navigate:domains') < r.log.indexOf('click'),
      'the navigation precedes the click (the button only exists after Domains mounts)');
    ok(r.log.filter((e) => e === 'click').length === 1, 'exactly one click — the queue is not replayed');
  }

  {
    // MOTION OFF / FIRST NAVIGATION — afterViewMount runs in the same task,
    // so a user with reduced motion must not wait a frame for their form.
    const r = runGo('domain', { deferMount: false });
    ok(r.log.includes('click'), 'with nothing pending the click happens inside go() itself — no extra frame');
    ok(r.log.indexOf('navigate:domains') < r.log.indexOf('click')
      && r.log.indexOf('click') < r.log.indexOf('refresh'),
      `navigate → click → refresh, in that order (got ${r.log.join(' → ')})`);
  }

  {
    // Only step 2 opens a form, and a missing button is still a no-op.
    const other = runGo('api-key', { deferMount: false });
    ok(!other.log.includes('click'), 'a step that is not step 2 never reaches the create flow');
    ok(other.log.includes('navigate:settings'), 'CONTROL: it did navigate');

    const unknown = runGo('nope', { deferMount: false });
    ok(unknown.log.length === 0, 'an unknown step id navigates nowhere and clicks nothing');
  }

  // ── STEP 3 (v3.64.0): DOMAINS, PLUS A FOLD REQUEST, IN THAT ORDER ─────
  // Ingest left the rail, so the step now sends somebody to the ADD SOURCES
  // section of the domain page. Two things are asserted and only one of
  // them is the destination.
  //
  // THE ORDER IS THE BEHAVIOUR. navigate() does not always defer: with
  // motion off, or on a FIRST navigation, the mount happens inside
  // navigate() itself. A request recorded after that call would be written
  // after the consumer had already looked and found nothing — a step that
  // works with animations on and silently does nothing with them off, which
  // is the worst shape a defect can have (it passes every demo). Both arms
  // are driven, exactly as the create-click pair above is.
  {
    const deferred = runGo('ingest', { deferMount: true });
    ok(deferred.threw === null, 'go("ingest") does not throw');
    ok(deferred.log.includes('navigate:domains'),
      'step 3 navigates to DOMAINS — ADD SOURCES is a section of the domain page now');
    ok(!deferred.log.includes('navigate:ingest'),
      '…and NOT to the full-page Ingest view, which is still registered but is no longer where the feature lives');
    ok(deferred.log.includes('requestDomainFold:add-sources'),
      '…and asks the Domains view to open the ADD SOURCES fold');
    // BOTH INDICES ARE ASSERTED PRESENT before they are compared. Found by
    // mutation: with the request removed entirely, `indexOf` returns -1 and
    // `-1 < 0` is TRUE, so a bare ordering comparison reported "recorded
    // first" about a call that never happened.
    {
      const iFold = deferred.log.indexOf('requestDomainFold:add-sources');
      const iNav = deferred.log.indexOf('navigate:domains');
      ok(iFold >= 0 && iNav >= 0 && iFold < iNav,
        `THE DEFECT, GUARDED: the fold request is recorded BEFORE navigate(), because navigate() can mount synchronously (got ${deferred.log.join(' → ')})`);
    }
    ok(!deferred.log.includes('click'),
      'the fold is OPENED, not CLICKED — a <summary> click toggles, so it would SHUT the fold for anyone who had already opened it');

    // The synchronous arm — motion off / first navigation — is the one the
    // ordering assertion above exists for. Same order, no exceptions.
    const immediate = runGo('ingest', { deferMount: false });
    {
      const iFold = immediate.log.indexOf('requestDomainFold:add-sources');
      const iNav = immediate.log.indexOf('navigate:domains');
      ok(iFold >= 0 && iNav >= 0 && iFold < iNav,
        `…and with the mount happening INSIDE navigate(), the request is still there first (got ${immediate.log.join(' → ')})`);
    }

    // CONTROL: no other step records a fold request, so the line above is
    // measuring step 3 rather than a call that fires on every press.
    for (const other of ['domain', 'api-key']) {
      const r = runGo(other, { deferMount: false });
      ok(!r.log.some((e) => e.startsWith('requestDomainFold')),
        `CONTROL: step "${other}" asks for no fold`);
    }
  }

  // ── THE TWO HALVES OF THE HANDOFF ARE THE SAME STRING ─────────────────
  // The producer is this file and the consumer is views/domains.js: two
  // different packages, so the id is an EXPORTED CONSTANT rather than a
  // literal typed twice. The failure a typed-twice string produces is a
  // step that navigates correctly and then silently does nothing else.
  {
    const appSrc = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');
    ok(/export const ADD_SOURCES_FOLD = '([^']+)';/.test(appSrc),
      'app.js EXPORTS ADD_SOURCES_FOLD, so neither side re-types the id');
    ok(/export function requestDomainFold\(/.test(appSrc)
      && /export function consumeDomainFoldRequest\(/.test(appSrc),
      '…and exports the record/spend pair that carries it');
    const importBlock = (/import \{([\s\S]*?)\} from '\.\.\/app\.js';/.exec(ob) || [])[1] || '';
    ok(/\bADD_SOURCES_FOLD\b/.test(importBlock) && /\brequestDomainFold\b/.test(importBlock),
      'onboarding.js imports both from the shell rather than typing the string');
    ok(!/'add-sources'/.test(ob),
      '…and carries the literal nowhere itself');
  }

  {
    // DEGRADATION CONTRACT: a renamed id is a silent no-op, never a throw.
    const log = [];
    const api = new Function('navigate', 'afterViewMount', 'targetViewFor', 'document', 'refresh', 'panelGen',
      'requestDomainFold', 'ADD_SOURCES_FOLD',
      goSrc + '\nreturn { go };')(
      () => log.push('navigate'), (cb) => cb(), () => 'domains',
      { getElementById: () => null }, () => log.push('refresh'), 0,
      () => {}, 'add-sources');
    let threw = null;
    try { api.go('domain'); } catch (e) { threw = e; }
    ok(threw === null, 'a renamed or removed button leaves the user on Domains rather than throwing');
    ok(log.includes('refresh'), '…and the panel still refreshes afterwards');
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
  // `rows` and `doors` are the two locals that hold BUILT markup, and both
  // are built inside this same function from escapeHtml()/icon() calls the
  // scan below therefore also sees. Nothing else may be interpolated.
  const unguarded = (src) =>
    interpolationsIn(src).filter((x) => !/^escapeHtml\(|^icon\(|^rows$|^doors$|^String\(/.test(x));
  const found = unguarded(renderFn);
  // A FLOOR AND A COUNT. The floor catches a scanner that stopped reaching
  // the function at all; the count catches the subtler thing that nearly
  // happened while v3.61.0's Optional flag was being written — an
  // escapeHtml() site becoming invisible to this scan because a ternary was
  // inserted between it and its closing quote. Ratchet: this may rise with
  // new markup and must never fall silently.
  const escapedSites = interpolationsIn(renderFn).filter((x) => /^escapeHtml\(/.test(x));
  ok(interpolationsIn(renderFn).length >= 5,
    `render() really does interpolate (${interpolationsIn(renderFn).length} sites — a near-zero count means this scanner stopped reaching it)`);
  ok(escapedSites.length >= 8,
    `and ${escapedSites.length} of them are escapeHtml() sites this scan can SEE (>= 8; a drop means one stopped being scanned, not that it stopped existing)`);
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
  ok(/if \(!isFresh\(myGen\) \|\| !root\) return;[\s\S]*await loadFacts\([^)]*\)[\s\S]*if \(!isFresh\(myGen\) \|\| !root\) return;/.test(refresh),
    'one check sits before the await and one after it');

  // Every caller captures synchronously.
  for (const fn of ['go', 'openOnboardingPanel']) {
    const body = extractFunction(ob, fn);
    ok(/const myGen = panelGen;\s*\n\s*refresh\(myGen\)/.test(body) || /refresh\(panelGen\)/.test(body),
      `${fn}() passes the counter into refresh() rather than letting refresh read it`);
  }

  // startRefresh is the THIRD caller and it is now a parameter away from the
  // counter: openPanel captures panelGen synchronously and threads it in, so
  // the timer callback — which fires seconds later, potentially after a
  // close-and-reopen — compares a value frozen at arm time. Asserting the
  // parameter is strictly stronger than the old "captures it itself" check:
  // a startRefresh that re-derived the counter inside its own callback would
  // be the inert-guard shape even though it looked like a capture.
  {
    const sr = extractFunction(obCode, 'startRefresh');
    ok(/^function startRefresh\(myGen\)/.test(sr),
      'startRefresh() takes myGen as a PARAMETER rather than reading panelGen');
    ok(!/panelGen/.test(sr),
      'and never mentions panelGen at all — the armed timer cannot re-derive a fresher counter and wave itself through');
    ok(/isFresh\(myGen\)/.test(sr),
      'the timer callback checks freshness against that frozen value');
    ok(/startRefresh\(panelGen\)/.test(extractFunction(obCode, 'openPanel')),
      'openPanel() supplies it, synchronously, after bumping the counter');
    // A HOLE FOUND BY MUTATION IN v3.61.0, and it predates this release:
    // openPanel has TWO arms — the already-open re-entry (which passes
    // panelGen) and the FIRST open at the end of the function (which passes
    // the local myGen). Deleting the second one left the assertion above
    // green, because the first one still matches the regex — i.e. a panel
    // that opened and then never polled at all, on the automatic first-run
    // path, was not caught by anything. Count both.
    ok(callSiteCount(ob, 'startRefresh', { within: 'openPanel' }) === 2,
      'and BOTH of openPanel’s arms arm the poll — the re-entry and the first open');
  }

  ok(/panelGen \+= 1;/.test(extractFunction(ob, 'openPanel')), 'opening bumps the counter');
  ok(/panelGen \+= 1;/.test(extractFunction(ob, 'closePanel')), 'closing bumps it too, staling every in-flight handler');

  // The refresh loop must be self-terminating, not a forever background poll.
  ok(/clearTimeout\(refreshTimer\)/.test(obCode), 'the pending timer is cleared');
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
  //
  // Run against CODE, not raw text. shell.css's guidance-dock rule has to
  // explain WHY it reserves a strip for this panel, and doing that without
  // naming .obp-root / .obp-panel would make the comment useless to the
  // next reader — while a raw-text scan reads that prose as a rule and
  // fails. Same reasoning, and the same helper, as obCode/appCode above:
  // an absence check must read the code it protects. Stripping cannot hide
  // a real rule (comments are all it removes), and the sanity anchors
  // below fail loudly if the stripper ever over-reaches into one.
  const otherNextCssFiles = ['shell.css', 'views/shared.css', 'views/settings.css', 'views/chat.css',
    'views/domains.css', 'views/ingest.css', 'views/sync.css', 'views/memory.css', 'views/mcp-wizard.css'];
  const otherNextCss = assertStrippedSane(
    stripComments(otherNextCssFiles
      .map((f) => readFileSync(path.join(ROOT, 'src/public/next', f), 'utf8')).join('\n')),
    'the other /next stylesheets',
    ['.main-inner {', '.reader-scrim {', '.chat-composer {']);
  ok(!/\.obp-/.test(otherNextCss), 'no other /next stylesheet defines an .obp- rule');
  // Negative control: the detector can still fail. Without this, the
  // strip above could quietly turn the assertion into a no-op.
  ok(/\.obp-/.test(otherNextCss + '\n.obp-smuggled { color: red; }'),
    'and that detector fires on a real .obp- rule planted in the same text');
  ok(!/obp-/.test(settingsCode), 'settings.js does not reach into the panel\u2019s class namespace');

  // No inline style="" with a var() — test-css-tokens.js §8 walks these.
  ok(!/style="[^"]*var\(/.test(obCode), 'no built HTML string carries a var() inside an inline style attribute');

  // ── v3.61.0's THREE MEASURED CSS DECISIONS, pinned ────────────────────
  // Each of these came out of the running app, and each would go quietly
  // wrong again if the token were swapped back for the obvious one.
  //
  // 1. The Optional chip's outline. --border-subtle measured 1.06:1 against
  //    --surface-overlay in the dark theme — an outline nobody can see.
  //    --control-edge measures 3.24 dark / 3.70 light, over the 3:1 floor
  //    for a non-text graphic (WCAG 1.4.11).
  ok(/\.obp-step-optional \{[^}]*border: 1px solid var\(--control-edge\)/.test(obCssCode),
    'the Optional chip outlines with --control-edge (3.24 dark / 3.70 light), not the invisible --border-subtle (1.06)');
  ok(/--border-subtle was the outline here and it was MEASURED OUT/i.test(obCss),
    '…and the file records the measurement that rejected the other token, so the swap is not re-made by taste');

  // 2. The card's height ceiling. The AGENT set has four steps; at 1024px
  //    wide the card narrows and its copy wraps, measured 699.7px of an
  //    800px viewport — one notch shorter and the last step, the way back
  //    and the dismissal reassurance are off-screen on a `position: fixed`
  //    card. The 24px is .obp-root's own 12px top + 12px bottom padding,
  //    DERIVED rather than guessed, which is the same rule the 28px width
  //    budget follows.
  ok(/\.obp-panel \{[\s\S]*?max-height: calc\(100vh - 24px\)/.test(obCssCode),
    'the panel caps its height at the viewport minus its wrapper’s own padding');
  ok(/\.obp-panel \{[\s\S]*?overflow-y: auto/.test(obCssCode),
    '…and contains the overflow inside the card, so a short window cannot make the last step unreachable');
  ok(/padding: 12px 16px/.test(obCssCode),
    '…and .obp-root really declares the 12px the ceiling is derived from (this guard would rot silently otherwise)');

  // 3. The door buttons' size comes from a TOKEN, never a px literal —
  //    --control-sm IS --hit-min, so the box is the target and no ::before
  //    hit box is needed (the rule test-next-views-kit.js §10 enforces).
  ok(/\.obp-panel \.obp-door-btn \{[^}]*height: var\(--control-sm\)/.test(obCssCode),
    'each door button takes --control-sm, which is --hit-min — the box is the target');
  ok(/\.obp-swap \{[^}]*min-height: var\(--hit-min\)/.test(obCssCode),
    'and the way-back control reaches --hit-min by its box (a text control has no glyph to preserve)');
  ok(!/\.obp-door-btn \{[^}]*height: \d+px/.test(obCssCode) && !/\.obp-swap \{[^}]*height: \d+px/.test(obCssCode),
    'neither of them hard-codes a pixel height');

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

// ═════════════════════════════════════════════════════════════════════════
section('11. The dock — the panel must reserve the strip it sits on');
// ═════════════════════════════════════════════════════════════════════════
// WHAT THIS SECTION EXISTS FOR. `position: fixed` takes no space, so the
// panel USED TO sit on top of the mounted view. Because .obp-panel is
// `pointer-events: auto` that was not cosmetic: measured at 1280x800 with
// document.elementFromPoint, the panel — not the control — was the topmost
// element over Domains' "Ask this domain" button and over Settings'
// "Disconnect" and "Replace" buttons. Settings is where the panel's own
// step 1 sends the user, so the guide covered the controls it points at.
//
// The fix is a HANDSHAKE ACROSS TWO FILES: onboarding.js puts a class on
// <body>, shell.css reserves the gutter for it, and onboarding.css derives
// the card's width from the same custom property so the reservation and
// the card can never mean different numbers.
//
// Every part of that handshake fails SILENTLY if it drifts. A renamed
// class, a renamed custom property, a hardcoded width that stops matching:
// no error, no console warning — the gutter just stops being reserved and
// live controls go back under the card. Nothing else in the suite would
// notice, which is exactly why these assertions are here.
{
  const shellCssRaw = readFileSync(path.join(ROOT, 'src/public/next/shell.css'), 'utf8');
  const shellCss = assertStrippedSane(stripComments(shellCssRaw), 'shell.css',
    ['.main {', '.main-inner {', '.reader-scrim {']);

  // ── The class literal is read from onboarding.js, never typed twice ────
  // Hardcoding 'guide-docked' here would make this suite agree with itself
  // while the two real files disagreed with each other.
  const dockClassDecl = /const DOCK_CLASS = '([a-z0-9-]+)';/.exec(obCode);
  ok(!!dockClassDecl, 'onboarding.js declares a DOCK_CLASS literal');
  const DOCK_CLASS = dockClassDecl && dockClassDecl[1];

  // ── shell.css reserves the gutter for THAT class ──────────────────────
  const dockRule = DOCK_CLASS && new RegExp(
    'body\\.' + DOCK_CLASS + '\\s+\\.main\\s*\\{[^}]*padding-right:\\s*var\\((--[a-z0-9-]+)\\)'
  ).exec(shellCss);
  ok(!!dockRule,
    `shell.css reserves a right gutter on the main column for body.${DOCK_CLASS} ` +
    '— if this fails, the class onboarding.js toggles is not the one the shell listens for');
  const DOCK_VAR = dockRule && dockRule[1];

  // ── and the property it reserves with is really DEFINED ───────────────
  // An undefined custom property makes the declaration invalid at
  // computed-value time and the padding silently evaluates to nothing —
  // the --text-dim class of bug that test-css-tokens.js exists for, landing
  // here as "the gutter is not reserved and nobody is told".
  ok(!!DOCK_VAR && new RegExp('\\' + DOCK_VAR + '\\s*:').test(shellCss),
    `${DOCK_VAR} is defined in shell.css, so the padding is a valid declaration`);

  // ── the card's width is DERIVED from the same property ────────────────
  const panelRule = /\.obp-panel\s*\{([^}]*)\}/.exec(obCssCode);
  ok(!!panelRule, '.obp-panel has a rule block');
  const panelBody = panelRule ? panelRule[1] : '';
  const widthDecl = /width:\s*calc\(\s*var\((--[a-z0-9-]+)\)\s*-\s*(\d+)px\s*\)/.exec(panelBody);
  ok(!!widthDecl, '.obp-panel derives its width from a custom property minus a fixed inset');
  ok(!!widthDecl && widthDecl[1] === DOCK_VAR,
    `and it is the SAME property the shell reserves (${DOCK_VAR}) — not a second copy of the number`);
  ok(!/\b340px\b/.test(panelBody),
    '.obp-panel carries no literal card width — one source of truth, per the header');

  // ── THE GEOMETRIC INVARIANT the whole fix rests on ────────────────────
  // reserved gutter  =  DOCK_VAR
  // card footprint   =  (DOCK_VAR - offset) + .obp-root's right padding
  // so the card fits inside the reservation, with a real gap left over,
  // iff offset > that padding. Both numbers are parsed from the CSS, so a
  // future edit to either one is what this checks — not a restated constant.
  const rootRule = /\.obp-root\s*\{([^}]*)\}/.exec(obCssCode);
  ok(!!rootRule, '.obp-root has a rule block');
  const padDecl = rootRule && /padding:\s*(\d+)px\s+(\d+)px/.exec(rootRule[1]);
  ok(!!padDecl, '.obp-root declares a two-value padding, so its horizontal inset is readable');
  const inset = padDecl ? Number(padDecl[2]) : NaN;
  const offset = widthDecl ? Number(widthDecl[2]) : NaN;
  ok(Number.isFinite(inset) && Number.isFinite(offset) && offset > inset,
    `the card fits inside the reserved strip with room to spare: offset ${offset}px > ` +
    `.obp-root's ${inset}px right inset, leaving a ${offset - inset}px gap to the view's content edge`);

  // A media query that moves .obp-root's horizontal padding changes ONE
  // side of that pair and not the other, so the gap silently shrinks (or
  // goes negative) at some window width and nothing reports it.
  ok(!/@media[^{]*\{[^{}]*\.obp-root\s*\{[^}]*padding/.test(obCssCode),
    'no media query re-declares .obp-root’s padding behind the shell’s back');

  // ── The toggle is wired at both ends, and open wins the race ──────────
  const openBody = extractFunction(ob, 'openPanel');
  const closeBody = extractFunction(ob, 'closePanel');
  ok(/setDocked\(true\)/.test(openBody), 'openPanel() docks');
  ok(/setDocked\(false\)/.test(closeBody), 'closePanel() undocks — dismissing restores the layout');
  // openPanel returns early when the panel is already open (a Settings
  // re-open). Docking after that return would leave the re-open path
  // unducked.
  ok(openBody.indexOf('setDocked(true)') < openBody.indexOf('if (root) {'),
    'and it docks BEFORE the already-open early return, so a re-open cannot skip it');
  ok(!/setDocked\(/.test(extractFunction(ob, 'render')),
    'render() does not touch the dock — the class tracks the panel’s existence, not its content');

  // ── EXECUTABLE: setDocked really adds and removes that exact class ────
  // The assertions above read source. This one RUNS it, against a fake
  // document, so "it says setDocked(true)" and "it actually docks" are two
  // different claims and both are checked.
  {
    const fake = { classList: {
      _on: new Set(),
      toggle(name, force) { if (force) this._on.add(name); else this._on.delete(name); },
    } };
    const run = new Function('document',
      extractConst(ob, 'DOCK_CLASS') + '\n' + extractFunction(ob, 'setDocked') + '\n' +
      'return setDocked;')({ body: fake });
    run(true);
    ok(fake.classList._on.has(DOCK_CLASS), `setDocked(true) adds .${DOCK_CLASS} to <body>`);
    run(false);
    ok(!fake.classList._on.has(DOCK_CLASS), 'setDocked(false) removes it — no stranded gutter');
    run(true); run(true);
    eq(fake.classList._on.size, 1, 'docking twice is idempotent');
  }

  // ── It must never be able to take the shell down ──────────────────────
  // setDocked runs on the boot path (maybeShowOnboarding -> openPanel), and
  // §6's whole subject is that nothing on that path may stop markBooted().
  {
    const run = new Function('document',
      extractConst(ob, 'DOCK_CLASS') + '\n' + extractFunction(ob, 'setDocked') + '\n' +
      'return setDocked;')({ get body() { throw new Error('no body yet'); } });
    let threw = false;
    try { run(true); } catch { threw = true; }
    ok(!threw, 'setDocked swallows a throwing document.body — an unducked panel, never a blank page');
  }

  // ── R7, restated where the dock could break it ────────────────────────
  // The dock reserves horizontally only. A vertical reservation is the one
  // change that could push the bottom-anchored composer off screen.
  const dockRuleBody = DOCK_CLASS && new RegExp(
    'body\\.' + DOCK_CLASS + '\\s+\\.main\\s*\\{([^}]*)\\}'
  ).exec(shellCss);
  ok(!!dockRuleBody && !/padding-(top|bottom)|height|max-height|overflow/.test(dockRuleBody[1]),
    'the dock rule reserves horizontal space ONLY — no vertical or overflow change that could reach the composer');
}

// ─────────────────────────────────────────────────────────────────────────
// ═════════════════════════════════════════════════════════════════════════
section('12. refresh() must not strand focus when it re-renders');
// ═════════════════════════════════════════════════════════════════════════
// render() replaces root.innerHTML, destroying every node inside it. An
// explicit "Show setup guide" focuses the heading; refresh()'s two GETs then
// resolve ~100 ms later and re-render, which dropped focus to <body>.
//
// WHY THIS WAS INVISIBLE, and why it is worth a guard: the AUTOMATIC path
// never takes focus at all (deliberately — someone who opened the app to type
// keeps their caret), so the bug could only ever fire on the explicit,
// keyboard-accessible path. A defect that only manifests for the users who
// depend on focus management is precisely the kind that ships.
//
// SOURCE-LEVEL, and labelled as such: refresh() is async and touches
// document + fetch, so this asserts the ORDERING contract rather than
// executing it. It pins that the active element is captured BEFORE render()
// and a focus restore follows AFTER it — which is the whole property, since
// capturing after the re-render can only ever read <body>.
{
  const refreshBody = extractFunction(ob, 'refresh');
  ok(refreshBody.length > 200, 'sanity: refresh() extracted (a truncated extract would pass the ordering checks vacuously)');

  const iCapture = refreshBody.indexOf('document.activeElement');
  const iRender = refreshBody.lastIndexOf('render()');
  const iRestore = refreshBody.indexOf('.focus()');

  ok(iCapture !== -1, 'refresh() captures document.activeElement');
  ok(iRender !== -1, 'refresh() calls render()');
  ok(iRestore !== -1, 'refresh() restores focus after re-rendering');
  ok(iCapture < iRender,
    `the activeElement capture precedes render() (capture ${iCapture} < render ${iRender}) — capturing after the re-render can only read <body>`);
  ok(iRestore > iRender,
    `the focus restore follows render() (restore ${iRestore} > render ${iRender})`);
  ok(/querySelector\('#'\s*\+/.test(refreshBody) || /getElementById/.test(refreshBody),
    'the restore re-queries by id — the captured NODE cannot survive innerHTML replacement, so restoring the node reference would be inert');
}

// ═════════════════════════════════════════════════════════════════════════
section('13. The re-check must STOP — teardown, stop condition, backoff');
// ═════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS PINS. The panel is appended to document.body, so it
// survives navigate(); its re-check was a setInterval at 5 s; and the
// all-done stop lived inside `if (autoCloseOnComplete)`, which Settings'
// "Show setup guide" sets to FALSE. Net effect on a COMPLETE install: a user
// who clicks that button gets a panel that can never close itself and a poll
// that runs in every view for the life of the page, hitting an endpoint that
// read 598 KB of CLAUDE.md and log.md per request — ~420 MB/hour, growing
// with the wiki.
//
// A poll's absence is invisible, so every assertion here is EXECUTED against
// the real functions where it can be, and scoped with callSiteCount (which
// strips comments and throws rather than passing vacuously) where it cannot.
// The old suite "guarded" this with one file-wide `clearInterval` regex —
// satisfied by a clear that never runs, which is exactly how the leak shipped.
{
  // A SECOND sandbox, because these three functions read module STATE (root,
  // steps, lastRefreshMs) rather than taking arguments — so unlike the pure
  // sandbox above they need those declared around them and settable. The
  // three POLL_* constants are lifted from the real source, never retyped:
  // retyping them is root cause 4, expected-equals-actual by construction.
  // The EXPECTED delays below are hand-written literals checked with
  // checkLiteral, which is where the pinning belongs.
  const POLL_CONSTS = ['POLL_BASE_MS', 'POLL_DUTY', 'POLL_MAX_MS'];
  const POLL_FNS = ['shouldKeepPolling', 'nextPollDelay', 'screenSignature'];
  const pollBox = new Function(
    // autoCloseOnComplete is declared here even though the CORRECT
    // shouldKeepPolling never touches it: a version that regressed to
    // consulting it must fail BEHAVIOURALLY, on the wrong answer, rather than
    // crashing on an undeclared name. A red for the wrong reason is not a
    // guard — it looks identical to a broken test, and the next person
    // deletes it. Set FALSE, which is the Settings "Show setup guide" path,
    // i.e. exactly the case where the shipped defect made the poll permanent.
    // activeDoor / chosenDoor joined the list in v3.61.0 because
    // screenSignature() reads them: the panel's BODY is the two doors when
    // activeDoor is null and the step list otherwise, so a signature blind
    // to the door would let the no-op guard skip the one repaint that
    // matters most. Started at the module's own initial values.
    'let root = null;\nlet steps = [];\nlet lastRefreshMs = 0;\nlet autoCloseOnComplete = false;\n' +
    "let activeDoor = 'knowledge';\nlet chosenDoor = null;\n" +
    POLL_CONSTS.map((c) => extractConst(ob, c)).join('\n') + '\n' +
    POLL_FNS.map((n) => extractFunction(ob, n)).join('\n\n') + '\n' +
    `return { ${POLL_FNS.join(', ')},
       __setRoot(v) { root = v; },
       __setSteps(v) { steps = v; },
       __setDoors(a, c) { activeDoor = a; chosenDoor = c; },
       __setLastRefreshMs(v) { lastRefreshMs = v; } };`
  )();
  const { shouldKeepPolling, nextPollDelay, screenSignature } = pollBox;
  const setRoot = pollBox.__setRoot;
  const setSteps = pollBox.__setSteps;
  const setDoors = pollBox.__setDoors;
  const setLast = pollBox.__setLastRefreshMs;

  // ── The stop condition, driven ────────────────────────────────────────
  setRoot({});
  setSteps([{ id: 'api-key', done: false }, { id: 'domain', done: false }, { id: 'ingest', done: false }]);
  ok(shouldKeepPolling() === true, 'an incomplete checklist keeps polling — the first-run path is not slowed down');

  setSteps([{ id: 'api-key', done: true }, { id: 'domain', done: false }, { id: 'ingest', done: false }]);
  ok(shouldKeepPolling() === true, 'one step done is still incomplete');

  setSteps([{ id: 'api-key', done: true }, { id: 'domain', done: true }, { id: 'ingest', done: true }]);
  ok(shouldKeepPolling() === false,
    'ALL THREE DONE -> STOP. This is the reported defect: a completed checklist has nothing left to find out');

  setRoot(null);
  setSteps([{ id: 'api-key', done: false }, { id: 'domain', done: false }, { id: 'ingest', done: false }]);
  ok(shouldKeepPolling() === false,
    'a CLOSED panel never polls, incomplete or not — the panel outliving navigate() is why this matters');

  // The stop condition must NOT consult autoCloseOnComplete. That flag
  // decides whether a finished panel VANISHES; reading it as if it also
  // decided whether to keep fetching is precisely what made the leak
  // permanent on the path a user reaches deliberately.
  const skpSrc = extractFunction(obCode, 'shouldKeepPolling');
  ok(!/autoCloseOnComplete/.test(skpSrc),
    'shouldKeepPolling() does not consult autoCloseOnComplete — a visible completed panel is still an IDLE one');
  ok(callSiteCount(ob, 'shouldKeepPolling', { within: 'startRefresh' }) >= 1,
    'startRefresh() consults it — a stop condition nothing calls is a comment');

  // ── Teardown ──────────────────────────────────────────────────────────
  // Timer AND listener. The generation bump makes their bodies no-ops, but a
  // listener that is merely pointless is still attached to window forever.
  ok(callSiteCount(ob, 'stopRefresh', { within: 'closePanel' }) === 1,
    'closePanel() clears the pending timer exactly once');
  const closeSrc = extractFunction(obCode, 'closePanel');
  ok(/removeEventListener\('focus', wakeHandler\)/.test(closeSrc),
    'closePanel() removes the focus listener');
  ok(/removeEventListener\('visibilitychange', wakeHandler\)/.test(closeSrc),
    'closePanel() removes the visibilitychange listener');
  ok(/wakeHandler = null/.test(closeSrc),
    'and drops the reference, so a second close cannot remove a listener that is no longer ours');
  const openSrc = extractFunction(obCode, 'openPanel');
  const added = (openSrc.match(/addEventListener\(/g) || []).length;
  const removed = (closeSrc.match(/removeEventListener\(/g) || []).length;
  ok(added === removed && added === 2,
    `every listener openPanel() adds, closePanel() removes (added ${added}, removed ${removed})`);

  // ── setInterval must not come back ────────────────────────────────────
  ok(!/setInterval\s*\(/.test(obCode),
    'no setInterval anywhere in the module — a chain that re-arms after settling cannot stack a second fetch on a slow one');
  ok(/setTimeout\s*\(/.test(extractFunction(obCode, 'startRefresh')),
    'startRefresh() arms a setTimeout');
  ok(callSiteCount(ob, 'startRefresh', { within: 'startRefresh' }) >= 1,
    'and re-arms itself — the chain link');

  // ── Hidden tab ────────────────────────────────────────────────────────
  const srSrc = extractFunction(obCode, 'startRefresh');
  const iHidden = srSrc.indexOf("visibilityState === 'hidden'");
  const iRefresh = srSrc.indexOf('refresh(myGen)');
  ok(iHidden !== -1, 'startRefresh() checks visibilityState');
  ok(iHidden < iRefresh && iRefresh !== -1,
    `the hidden check precedes the fetch (${iHidden} < ${iRefresh}) — a background tab reschedules without hitting the disk`);

  // ── Adaptive delay ────────────────────────────────────────────────────
  // Same shape views/memory.js uses, and for the same reason: this panel is
  // shown on FULLY POPULATED installs (the .env-only-key case this file
  // documents), so a number tuned against an empty one is a busy poll there.
  setLast(0);
  const base = nextPollDelay();
  const vBase = checkLiteral(5000, base,
    'a free re-check waits the base delay — IDENTICAL to the interval it replaces, so first-run responsiveness is unchanged');
  ok(vBase.pass, vBase.message);

  setLast(10);
  ok(nextPollDelay() === 5000, 'a 10 ms re-check still waits the base delay (10 x 20 = 200 < 5000)');

  setLast(500);
  const vDuty = checkLiteral(10000, nextPollDelay(),
    'a 500 ms re-check backs off to 20x its own cost — a big install throttles itself with nothing to tune');
  ok(vDuty.pass, vDuty.message);

  setLast(60000);
  const vCap = checkLiteral(300000, nextPollDelay(),
    'and the backoff is capped, so a pathological measurement cannot park the re-check for a day');
  ok(vCap.pass, vCap.message);

  ok(callSiteCount(ob, 'nextPollDelay', { within: 'startRefresh' }) === 1,
    'startRefresh() derives its delay from it — a computed delay nobody reads is decoration');
  ok(/lastRefreshMs = Date\.now\(\) - startedAt/.test(extractFunction(obCode, 'refresh')),
    'refresh() records what it actually cost, so the backoff tracks the real install rather than an estimate');

  // ── No-op guard ───────────────────────────────────────────────────────
  // render() replaces root.innerHTML wholesale. Unconditional re-rendering
  // destroyed and rebuilt the panel twelve times a minute forever, taking
  // focus with it each time.
  setSteps([{ id: 'api-key', done: false }, { id: 'domain', done: false }, { id: 'ingest', done: false }]);
  const sigA = screenSignature();
  const sigA2 = screenSignature();
  ok(sigA === sigA2 && sigA.length > 0, 'the signature is stable and non-empty for unchanged steps');
  setSteps([{ id: 'api-key', done: true }, { id: 'domain', done: false }, { id: 'ingest', done: false }]);
  ok(screenSignature() !== sigA,
    'a step ticking over CHANGES the signature — a guard that cannot see the change would freeze the panel, which is worse than the re-render');
  setSteps([{ id: 'api-key', done: false }, { id: 'domain', done: true }, { id: 'ingest', done: false }]);
  ok(screenSignature() !== sigA,
    'and so does a DIFFERENT step, so the guard is not keyed on the count alone');

  // ── THE DOOR IS IN THE SIGNATURE (v3.61.0), and it has to be ──────────
  // Same steps, different body. If the signature could not see this, the
  // panel would stay on the question after the facts resolved, or stay on
  // the checklist after the user asked for the question back — the no-op
  // guard reading "nothing changed" about the largest possible change.
  setSteps([{ id: 'api-key', done: false }, { id: 'domain', done: false }, { id: 'ingest', done: false }]);
  setDoors('knowledge', null);
  const sigKnowledge = screenSignature();
  setDoors(null, null);
  const sigDoors = screenSignature();
  ok(sigDoors !== sigKnowledge,
    'flipping to the two doors changes the signature even though the steps did not');
  setDoors('agent', 'agent');
  const sigAgent = screenSignature();
  ok(sigAgent !== sigKnowledge && sigAgent !== sigDoors && sigAgent.length > 0,
    'and so does the door itself — all three bodies are distinguishable');
  setDoors('knowledge', 'knowledge');
  const sigChosen = screenSignature();
  setDoors('knowledge', null);
  ok(screenSignature() !== sigChosen,
    'a PRESSED door differs from a DERIVED one — that is what draws the "Pick a different start" control');
  // An optional flag is on screen too, so it is in the signature.
  setDoors('agent', 'agent');
  setSteps([{ id: 'api-key', done: false, optional: true }]);
  const sigOpt = screenSignature();
  setSteps([{ id: 'api-key', done: false, optional: false }]);
  ok(screenSignature() !== sigOpt, 'the Optional flag is in the signature — it is a visible difference');
  // Restore the state the assertions after this block expect.
  setDoors('knowledge', null);
  setSteps([{ id: 'api-key', done: false }, { id: 'domain', done: false }, { id: 'ingest', done: false }]);

  const refreshSrc = extractFunction(obCode, 'refresh');
  ok(/if \(screenSignature\(\) === renderedSignature\) return;/.test(refreshSrc),
    'refresh() skips render() when nothing on screen would differ');
  ok(refreshSrc.indexOf('screenSignature() === renderedSignature') < refreshSrc.lastIndexOf('render()'),
    'and the guard sits BEFORE the render it is guarding');
  ok(/renderedSignature = screenSignature\(\)/.test(extractFunction(obCode, 'render')),
    'render() stamps the signature itself — stamping at the call site would let a render by another caller leave a stale value that passes the guard');
  ok(callSiteCount(ob, 'screenSignature', { within: 'render' }) === 1,
    'exactly once per paint');

  // ── One re-check at a time ────────────────────────────────────────────
  ok(/if \(refreshing\) return;/.test(refreshSrc),
    'refresh() refuses to overlap itself — go() fires a manual re-check while the chain is armed independently');
  ok(/finally \{\s*refreshing = false;/.test(refreshSrc),
    'and clears the flag in a finally, so a thrown fetch cannot wedge the loop off permanently');
}

// ═════════════════════════════════════════════════════════════════════════
section('14. THE TWO DOORS (v3.61.0) — derived, not stored, and still not a modal');
// ═════════════════════════════════════════════════════════════════════════
// WHAT THIS SECTION EXISTS FOR. The panel taught ONE audience. For the
// other — somebody giving their agents memory — step 1 asserted
// something false about their setup (the memory layer and the bridge need
// no key: mcp/server.js reads and writes markdown under getDomainsDir()
// directly), step 3 could never complete (hasAnyPage, and they have no
// PDFs), and the two steps they needed were in no step at all.
//
// The fix is two doors and two step sets. The thing that must not happen
// while fixing it is the panel becoming a WIZARD — R7 is binding, and §7
// above is the guard on that; this section adds the door-specific half.
{
  // ── DERIVATION, both directions, every rule ───────────────────────────
  const blank = { hasKey: false, hasDomain: false, hasPages: false, hasProject: false, bridgeUsed: false };
  const F = (over) => Object.assign({}, blank, over);

  eq(deriveDoor(blank, null), null,
    'a genuinely blank install -> NULL, which is what puts the two doors on screen');
  eq(deriveDoor(F({ hasKey: true, hasDomain: true }), null), null,
    'THE RULE THAT MATTERS: a key and an empty domain are on BOTH paths, so they carry no signal — still the doors');
  eq(deriveDoor(F({ hasPages: true }), null), 'knowledge', 'a page exists -> knowledge');
  eq(deriveDoor(F({ hasProject: true }), null), 'agent', 'a project exists -> agent');
  eq(deriveDoor(F({ bridgeUsed: true }), null), 'agent', 'a bridge that answered a call -> agent');
  eq(deriveDoor(F({ hasPages: true, hasProject: true, bridgeUsed: true }), null), 'knowledge',
    'BOTH audiences’ facts present -> knowledge wins, deliberately: it is the shipped path and audience 1 must lose nothing');

  // An explicit press beats every fact, or the doors would be decorative.
  eq(deriveDoor(F({ hasPages: true }), 'agent'), 'agent',
    'a PRESSED agent door beats a knowledge fact — the user saying so is better evidence than an inference');
  eq(deriveDoor(F({ hasProject: true }), 'knowledge'), 'knowledge', 'and the same in reverse');
  eq(deriveDoor(blank, 'nonsense'), null, 'an unrecognised choice is ignored rather than trusted');
  eq(deriveDoor(null, null), null, 'null facts -> the doors (a failed fetch must not pick an audience)');
  eq(deriveDoor('nope', null), null, 'a non-object facts value -> the doors');

  // ── DERIVED, NOT STORED: the panel keeps no persona field ─────────────
  ok(!/persona|audience[A-Za-z]*\s*=|'knowledge'\s*\)\s*;?\s*\/\/\s*stored/.test(obCode),
    'nothing in the module stores a persona');
  const keysWritten = [...obCode.matchAll(/setItem\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).sort();
  ok(JSON.stringify([...new Set(keysWritten)]) === JSON.stringify(['DISMISS_KEY', 'LANDING_VIEW_KEY']),
    `it writes exactly two storage keys, both named constants — found ${JSON.stringify(keysWritten)}`);
  eq(LANDING_VIEW_KEY, 'curator-next-view',
    'and the second one is app.js’s EXISTING landing key, not a new key (scripts/test-ui-state.js’s census is the gate)');
  ok(/const VIEW_KEY = 'curator-next-view';/.test(appJs),
    '…which app.js really declares under that literal today (this guard would rot silently otherwise)');
  ok(/pickStartView\(localStorage\.getItem\(VIEW_KEY\)\)/.test(appCode),
    '…and really READS at boot, through pickStartView — which is the only reason writing it means anything');

  // ── THE WRITE ITSELF, executed, including its allow-list ──────────────
  {
    const wrote = [];
    const capture = { setItem: (k, v) => wrote.push([k, v]) };
    eq(writeLandingView(capture, 'memory'), true, 'the agent door’s view is written');
    ok(wrote.length === 1 && wrote[0][0] === LANDING_VIEW_KEY && wrote[0][1] === 'memory',
      'under the landing key, with the view as its value');
    eq(writeLandingView(capture, 'domains'), true, 'and the knowledge door’s view is written');

    // THE ALLOW-LIST. Only a door's own view may be written, so a caller
    // cannot put an arbitrary string into the key app.js boots from.
    eq(writeLandingView(capture, 'settings'), false, 'a view NO door names is refused');
    eq(writeLandingView(capture, ''), false, 'an empty view is refused');
    eq(writeLandingView(capture, '../../evil'), false, 'and so is junk');
    eq(wrote.length, 2, 'the three refusals wrote nothing at all');

    // Best-effort, like writeDismissed: a private window throws on setItem.
    const throwing = { setItem() { throw new Error('SecurityError: storage is disabled'); } };
    eq(writeLandingView(throwing, 'memory'), false,
      'a THROWING storage reports failure instead of throwing out of the click handler');

    // Every door's view must be one app.js can actually navigate to, or the
    // write would be silently discarded by pickStartView on the next boot.
    for (const d of DOORS) {
      ok(new RegExp("'" + d.view + "'").test(
        (appCode.match(/const NAV_VIEWS = \[[^\]]*\]/) || [''])[0]),
        `the ${d.id} door's landing view (${d.view}) is a real NAV_VIEWS entry`);
    }
  }

  // ── THE TWO DOORS' COPY ───────────────────────────────────────────────
  eq(DOORS.length, 2, 'exactly two doors');
  ok(JSON.stringify(DOORS.map((d) => d.id)) === JSON.stringify(['knowledge', 'agent']),
    'knowledge first, then agent');
  ok(/second brain/i.test(DOORS[0].title) && /agents/i.test(DOORS[1].title),
    'their titles name the two things a person comes here to build');
  for (const d of DOORS) {
    ok(wordCount(d.body) <= 13,
      `the ${d.id} door's body is ${wordCount(d.body)} visible words (<= 13, docs/design-system-source.md §3)`);
    ok(d.body.length > 0 && d.title.length > 0, `the ${d.id} door has a title and a body`);
  }
  // CONTROL: the word counter can fail.
  ok(wordCount('one two three four five six seven eight nine ten eleven twelve thirteen fourteen') === 14,
    'CONTROL: the word counter really counts words, so the ceilings above are not vacuous');
  ok(wordCount(STEP_COPY['api-key'].todo) <= 13,
    `step 1's rewritten body is ${wordCount(STEP_COPY['api-key'].todo)} visible words (<= 13)`);

  // ── THE AGENT PATH NAMES NO PRODUCT AND DEMANDS NO KEY ────────────────
  // Naming one MCP client would tell Claude Code and Cursor users the step
  // is not theirs, and the bridge serves all three.
  const agentCopy = JSON.stringify([
    DOORS[1], STEP_COPY.project, STEP_COPY.bridge, AGENT_STEP_COPY,
  ]);
  ok(!/Claude Desktop/i.test(agentCopy),
    'the agent path never says "Claude Desktop" — the bridge is harness-neutral');
  ok(!/Claude Desktop/i.test(obCode), '…and neither does any other string in the module');
  ok(!/nothing else works|you need a key|requires a key/i.test(agentCopy),
    'and it never states a key requirement');
  ok(/MCP bridge/.test(STEP_COPY.bridge.todo),
    'the bridge step names the Settings block it points at, by its shipped label');
  ok(/MCP bridge'\]/.test(settingsCode) || /'mcp',\s*'MCP bridge'/.test(settingsCode),
    '…which views/settings.js really calls that today (this guard would rot silently otherwise)');
  ok(/[Pp]roject/.test(STEP_COPY.project.todo),
    'and the project step says the word "project" — which appeared in NO step before this release');

  // ── DONE-NESS COMES FROM THE HARNESS-NEUTRAL FACT ─────────────────────
  ok(!/api\/mcp\/config/.test(obCode),
    'THE REBUILT-DEFECT GUARD: the bridge step never reads /api/mcp/config, whose `installed` inspects Claude Desktop’s file ONLY');
  ok(/getJson\('\/api\/mcp\/usage'\)/.test(obCode), 'it reads the usage log instead');

  // ── THE NEW STEPS POINT, LIKE EVERY OTHER STEP ────────────────────────
  eq(targetViewFor('project'), 'domains', 'the project step points at Domains, which owns the project list and its form');
  eq(targetViewFor('bridge'), 'settings', 'the bridge step points at Settings, which owns the snippet');
  ok(AGENT_STEP_ORDER.every((id) => targetViewFor(id) !== null), 'every agent step has a destination');
  ok(!/method:\s*'PUT'|method:\s*'PATCH'|method:\s*'DELETE'/.test(obCode),
    'and none of them mutates anything — the panel still only reads');

  // The bridge step opens the SECTION, the same way step 2 opens Domains'
  // create form: through afterViewMount, because v3.57.0's exit animation
  // means the statement order says nothing about the event order.
  {
    const goSrc2 = extractFunction(obCode, 'go') + '\n' +
      extractFunction(obCode, 'goToDomainsCreate') + '\n' +
      extractFunction(obCode, 'goToMcpBridge');
    function runGo2(stepId, { deferMount }) {
      const log = [];
      const queued = [];
      let mounted = false;
      const btn = { click: () => log.push('click') };
      const doc = {
        getElementById: (id) => ((id === 'dm-new-domain-btn' && mounted) ? btn : null),
        querySelector: (sel) => ((sel === '.settings-nav-row[data-section="mcp"]' && mounted) ? btn : null),
      };
      const api = new Function(
        'navigate', 'afterViewMount', 'targetViewFor', 'document', 'refresh', 'panelGen',
        goSrc2 + '\nreturn { go };')(
        (v) => { log.push('navigate:' + v); if (!deferMount) mounted = true; },
        (cb) => { if (deferMount) { queued.push(cb); return; } cb(); },
        targetViewFor,
        doc,
        () => log.push('refresh'),
        0,
      );
      let threw = null;
      try { api.go(stepId); } catch (e) { threw = e; }
      return { log, threw, flushMount() { mounted = true; queued.splice(0).forEach((c) => c()); } };
    }
    const r = runGo2('bridge', { deferMount: true });
    ok(r.threw === null, 'go(\'bridge\') does not throw while the mount is pending');
    ok(!r.log.includes('click'), 'and does NOT click the nav row before Settings has mounted — it does not exist yet');
    r.flushMount();
    ok(r.log.includes('click'), '…and DOES once it has');
    ok(r.log.indexOf('navigate:settings') < r.log.indexOf('click'), 'navigation first, then the section click');
    ok(r.log.filter((e) => e === 'click').length === 1, 'exactly one click');

    const imm = runGo2('bridge', { deferMount: false });
    ok(imm.log.indexOf('navigate:settings') < imm.log.indexOf('click')
      && imm.log.indexOf('click') < imm.log.indexOf('refresh'),
      `motion off: navigate → click → refresh (got ${imm.log.join(' → ')})`);

    // A project step must NOT open the create form — it points at the list.
    const proj = runGo2('project', { deferMount: false });
    ok(proj.log.includes('navigate:domains'), 'the project step navigates to Domains');
    ok(!proj.log.includes('click'),
      'and clicks nothing: it points at the project list rather than opening a form the panel does not own');

    // Degradation contract: a renamed hook is a no-op, never a throw.
    const gone = new Function('navigate', 'afterViewMount', 'targetViewFor', 'document', 'refresh', 'panelGen',
      goSrc2 + '\nreturn { go };')(
      () => {}, (cb) => cb(), targetViewFor,
      { getElementById: () => null, querySelector: () => null }, () => {}, 0);
    let threw2 = null;
    try { gone.go('bridge'); } catch (e) { threw2 = e; }
    ok(threw2 === null,
      'a renamed nav row leaves the user on Settings with the section list in front of them rather than throwing');
  }

  // ── STILL NOT A MODAL, and the doors did not smuggle one in ───────────
  // §7 proves this for the module as a whole. These are the door-specific
  // ways it could have been broken: a door that is the primary action, a
  // question the user cannot get past, or a scrim behind the choice.
  ok(!/btn-primary/.test(obCode),
    'NEITHER door is the primary — a door is a choice between two equal paths, not the action that finishes a block');
  const doorBtns = (obCode.match(/obp-door-btn/g) || []).length;
  ok(doorBtns >= 2, 'the doors are real <button>s with a data-door hook and a click binding');
  ok(/data-door="' \+ escapeHtml\(d\.id\)/.test(obCode), 'their hook carries the door id, escaped');
  ok(/\.obp-door-btn'\)\.forEach/.test(obCode) || /querySelectorAll\('\.obp-door-btn'\)/.test(obCode),
    'and bind() wires every one of them');
  ok(!/obp-scrim|obp-doors-overlay/.test(obCssCode + obCode), 'no scrim came with the doors');
  ok(/id="obp-dismiss"/.test(obCode) && /askingDoor/.test(obCode),
    'the dismiss control is in the SHARED head, so the door state is dismissible exactly like the checklist');
  // The dismiss is not inside the branch — a door state you cannot dismiss
  // is a modal with extra steps.
  const renderSrc = extractFunction(obCode, 'render');
  ok(renderSrc.indexOf('id="obp-dismiss"') > -1
    && renderSrc.indexOf('id="obp-dismiss"') < renderSrc.indexOf('obp-ask')
    && renderSrc.indexOf('id="obp-dismiss"') < renderSrc.indexOf('obp-steps'),
    '…and it is emitted BEFORE either branch of the body, so no state can drop it');

  // ── THE WAY BACK ──────────────────────────────────────────────────────
  ok(/id="obp-swap"/.test(obCode), 'a pressed door can be swapped for the other one');
  ok(/chosenDoor !== null/.test(renderSrc),
    '…and that control is offered only for a PRESSED door, never a derived one (where it would ask a question the facts have answered)');

  // ── chooseDoor(), EXECUTED ────────────────────────────────────────────
  // The behaviour the contract asks for, driven rather than scanned: press
  // a door -> the key is written and the step list swaps; press the way
  // back -> the choice clears and the facts decide again.
  {
    const chooseSrc = extractFunction(obCode, 'chooseDoor');
    function runChoose(startFacts, startChosen) {
      const wrote = [];
      const calls = [];
      // The module's real neighbours are INJECTED — deriveDoor, buildSteps
      // and writeLandingView are the extracted originals, not stand-ins, so
      // this drives the real decision chain and not a model of it. Only the
      // three side-effecting neighbours (render / refresh / startRefresh)
      // and the storage are recorders.
      const box = new Function(
        'DOORS', 'deriveDoor', 'buildSteps', 'writeLandingView', 'landingStorage',
        'render', 'refresh', 'startRefresh', 'panelGen', '__chosen', '__facts',
        'let chosenDoor = __chosen;\nlet activeDoor = null;\nlet lastFacts = __facts;\nlet steps = [];\n' +
        chooseSrc + '\nreturn { chooseDoor, state: () => ({ chosenDoor, activeDoor, steps }) };')(
        DOORS, deriveDoor, buildSteps, writeLandingView,
        () => ({ setItem: (k, v) => wrote.push([k, v]) }),
        () => calls.push('render'), () => calls.push('refresh'), () => calls.push('startRefresh'),
        0, startChosen, startFacts,
      );
      return { chooseDoor: box.chooseDoor, state: box.state, wrote, calls };
    }
    const b1 = runChoose(F({ hasKey: true, hasDomain: true }), null);
    b1.chooseDoor('agent');
    const s1 = b1.state();
    eq(s1.chosenDoor, 'agent', 'pressing the agent door records the choice for this page load');
    eq(s1.activeDoor, 'agent', '…and the panel is now on that door');
    ok(JSON.stringify(s1.steps.map((x) => x.id)) === JSON.stringify(['domain', 'project', 'bridge', 'api-key']),
      '…with the agent step list in place, immediately, off the facts already in hand');
    ok(s1.steps[0].done === true, '…and the shared domain step keeps the tick it had already earned');
    ok(b1.wrote.length === 1 && b1.wrote[0][0] === 'curator-next-view' && b1.wrote[0][1] === 'memory',
      'the landing key is written with the agent door’s view');
    ok(b1.calls.includes('render') && b1.calls.includes('refresh') && b1.calls.includes('startRefresh'),
      'it repaints, re-checks, and RE-ARMS the poll — a set with more unmet steps has something to watch again');
    ok(!b1.calls.includes('navigate'),
      'and it does NOT navigate: the panel points, the steps move (R7). Re-mounting the view under a choosing user would be the panel doing something');

    const b2 = runChoose(F({ hasKey: true }), null);
    b2.chooseDoor('knowledge');
    ok(b2.wrote[0][1] === 'domains' &&
      JSON.stringify(b2.state().steps.map((x) => x.id)) === JSON.stringify(['api-key', 'domain', 'ingest']),
      'pressing the knowledge door writes domains and restores the three shipped steps');

    // The way back: clear the choice and let the facts answer again.
    const b3 = runChoose(F({ hasProject: true }), 'knowledge');
    b3.chooseDoor(null);
    eq(b3.state().chosenDoor, null, '"Pick a different start" clears the pressed choice');
    eq(b3.state().activeDoor, 'agent', '…and the FACTS decide again — here a project exists, so the agent door');
    eq(b3.wrote.length, 0, '…writing nothing: handing the decision back is not choosing a landing view');

    const b4 = runChoose(blank, 'agent');
    b4.chooseDoor(null);
    eq(b4.state().activeDoor, null, 'with no discriminating fact, the way back lands on the two doors');

    const b5 = runChoose(blank, null);
    b5.chooseDoor('nonsense');
    eq(b5.state().chosenDoor, null, 'an unknown door id is refused');
    eq(b5.wrote.length, 0, '…and writes nothing');
    eq(b5.calls.length, 0, '…and repaints nothing');
  }

  // ── THE GATE IS NEVER ASKED ABOUT AN EMPTY LIST ───────────────────────
  // door === null renders the doors, but shouldShowPanel() still has to be
  // handed real steps or it would hide the panel on the one install it
  // exists for. The module stands the knowledge set in, and that cannot
  // mis-gate: door === null implies hasPages === false implies the ingest
  // step is not done.
  ok(/buildSteps\(facts, door \|\| 'knowledge'\)/.test(obCode),
    'the knowledge set stands in for the gate while the doors are on screen');
  const standIn = buildSteps(F({ hasKey: true, hasDomain: true }), deriveDoor(F({ hasKey: true, hasDomain: true }), null) || 'knowledge');
  eq(shouldShowPanel(standIn, false), true,
    'EXECUTED: a key + an empty domain (the doors case) still SHOWS the panel, rather than hiding it as all-done');
  ok(standIn.some((s) => s.done === false), '…because the stand-in list genuinely has an unfinished step in it');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
