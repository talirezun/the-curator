/**
 * test-next-model-fallback.js — OFFLINE suite for the /next model-lifecycle
 * surface (src/public/next/views/settings.js + views/settings.css).
 *
 * No network, no API key, no server, no browser.
 *
 * ── WHAT THIS GUARDS, AND WHY IT IS WORTH A SUITE ───────────────────────
 * `GET /api/config/api-keys` returns `fallback: getFallbackStatus()` and
 * `activeModel`. Before the change this suite covers,
 * `grep -rn "\.fallback\b" src/public/next/` returned ZERO hits and
 * `activeModel` had zero readers — this project's named dead-data shape: a
 * backend field computed, returned, and read by nobody.
 *
 * It is a billing surface, not a cosmetic one. When a provider retires the
 * pinned default, llm.js walks FALLBACK_CHAINS onto the next live model and
 * keeps working — silently changing what the user is charged. Every Gemini
 * rung costs MORE than the default (first rung: 2.5x input / 3.75x output),
 * and v3.6.0 found four of five Anthropic rungs dead, landing users on
 * Sonnet at 3x Haiku's price.
 *
 * ── COVERED, BEHAVIOURALLY (the real functions are executed) ────────────
 *   - classifyFallback() for EVERY costTier value ('costlier' | 'similar' |
 *     'unknown'), driven BOTH ways: each tier's own note is asserted
 *     present AND the other tiers' notes asserted absent, so a copy swap
 *     cannot pass by accident.
 *   - null / undefined / non-object / legacy-shaped `fallback` — the
 *     no-banner case and the never-reassure case.
 *   - §3 specifically: 'unknown' must NOT read as reassuring. Asserted as
 *     behaviour (a note exists, it is not the empty string, it does not
 *     claim parity) rather than as a string match on one adjective.
 *   - activeModelLine() incl. absent provider, absent model, null input.
 *
 * ── COVERED AS SOURCE-LEVEL GUARDS (stated as such, not as behaviour) ───
 *   - §6: /next READS `fallback` and `activeModel` at all — the class-level
 *     assertion that stops this becoming dead data again.
 *   - §7: escaping of every interpolated value; CSS token/theming hygiene;
 *     no prefers-color-scheme.
 *
 * ── NOT COVERED HERE (stated rather than implied) ───────────────────────
 *   - Rendering. renderFallbackBanner()/renderActiveModelLine() call
 *     escapeHtml()/icon() from app.js, so they are not executable here;
 *     §5 executes them against STUBBED helpers, which proves the branching
 *     and the interpolation ORDER but not what a browser paints. Real
 *     rendering was verified in a browser in both themes and that
 *     verification is not reproducible from this file.
 *   - Whether getFallbackStatus() itself is correct — that is llm.js's, and
 *     scripts/test-chat-model.js's, territory.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SETTINGS_PATH = path.join(ROOT, 'src/public/next/views/settings.js');
const settings = readFileSync(SETTINGS_PATH, 'utf8');
const settingsCss = readFileSync(path.join(ROOT, 'src/public/next/views/settings.css'), 'utf8');

// ── Comment stripping for the source guards ─────────────────────────────
// Every source-level guard below has to run against CODE, because the
// module's own docblocks QUOTE the very strings being asserted (the header
// literally contains `grep -rn "\.fallback\b"` and the word
// prefers-color-scheme). Run against raw text those guards would be reading
// a comment — this repo's named failure shape, "a check that stopped
// reaching the thing it protects".
//
// ORDER IS LOAD-BEARING and matches scripts/test-next-onboarding.js: line
// comments FIRST. settings.js's prose contains `/api/config/...` inside //
// comments; strip blocks first and one of those `/*`-less slashes is
// harmless, but a `/*` appearing in prose would open a fake block comment
// that runs until the next `*/` and swallows real code. assertStrippedSane
// is the tripwire for exactly that.
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

// Structural anchors only — declarations this suite needs to exist to have
// a subject at all. Deliberately NO overlap with anything an assertion
// below also checks: an anchor that doubles as an assertion turns a real
// behavioural mutation into a tripwire throw before a single assertion
// runs, which is a red for the wrong reason and proves nothing.
const code = assertStrippedSane(stripComments(settings), 'settings.js', [
  'function classifyFallback(fallback)',
  'function activeModelLine(keys)',
  'function renderFallbackBanner(fallback)',
  'function renderActiveModelLine(k)',
  'function providerLabel(id)',
]);
const cssCode = assertStrippedSane(stripComments(settingsCss), 'settings.css', [
  '.provider-fallback-banner {',
  '.provider-active-line {',
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
  if (!m) throw new Error(`extractFunction: "${name}" not found in settings.js`);
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

const PURE_FNS = ['providerLabel', 'classifyFallback', 'activeModelLine'];

// The two render helpers are NOT pure — they call escapeHtml() and icon()
// from app.js. They are pulled in with STUBS for those two so §5 can drive
// their branching. The stubs are deliberately identity-ish and tagged, so
// an assertion can tell "this text went through escapeHtml" from "this text
// was interpolated raw".
const RENDER_FNS = ['renderFallbackBanner', 'renderActiveModelLine'];

const sandbox = new Function(
  'escapeHtml', 'icon',
  PURE_FNS.concat(RENDER_FNS).map((n) => extractFunction(settings, n)).join('\n\n') + '\n' +
  `return { ${PURE_FNS.concat(RENDER_FNS).join(', ')} };`
)(
  (s) => '⟦esc:' + String(s) + '⟧',
  (name, size) => '<svg data-icon="' + name + '" data-size="' + size + '"></svg>'
);

const { providerLabel, classifyFallback, activeModelLine,
        renderFallbackBanner, renderActiveModelLine } = sandbox;

// The exact payload shape src/brain/llm.js getFallbackStatus() returns.
function fb(over = {}) {
  return {
    provider: 'gemini',
    requestedModel: 'gemini-2.5-flash-lite',
    usingModel: 'gemini-3.1-flash-lite',
    at: '2026-08-25T10:00:00.000Z',
    costTier: 'costlier',
    costlier: true,
    ...over,
  };
}

// ── 1. No fallback ⇒ no banner (the normal, healthy state) ───────────────
section('1. Absent fallback — the normal state renders nothing');
{
  eq(classifyFallback(null).show, false, 'null fallback -> show:false');
  eq(classifyFallback(undefined).show, false, 'undefined fallback -> show:false');
  eq(classifyFallback(0).show, false, 'falsy non-object -> show:false');
  eq(classifyFallback('costlier').show, false, 'a bare STRING is not a payload -> show:false');
  eq(renderFallbackBanner(null), '', 'renderFallbackBanner(null) emits no markup at all');
  eq(renderFallbackBanner(undefined), '', 'renderFallbackBanner(undefined) emits no markup at all');

  // Driven the other way, so the four assertions above cannot pass by the
  // function simply always returning show:false.
  eq(classifyFallback(fb()).show, true, 'a real payload DOES produce a banner (control for the negatives above)');
  ok(renderFallbackBanner(fb()).length > 0, 'renderFallbackBanner(payload) emits markup (control)');
}

// ── 2. costTier: 'costlier' — a money warning, plainly ───────────────────
section("2. costTier 'costlier' — reads as a money warning");
{
  const v = classifyFallback(fb({ costTier: 'costlier', costlier: true }));
  eq(v.costTier, 'costlier', 'tier preserved');
  eq(v.costLevel, 'danger', "costlier escalates past the banner's amber to the danger level");
  ok(typeof v.costNote === 'string' && v.costNote.length > 0, 'a cost note exists');
  ok(/costs more/i.test(v.costNote), 'the note says the model COSTS MORE, in those words');
  ok(/ingest/i.test(v.costNote) && /billed/i.test(v.costNote),
    'the note names the ongoing consequence (every ingest is billed at the higher rate), not just a one-off');
  // Driven the other way: it must NOT carry either sibling tier's copy.
  ok(!/pricing page/i.test(v.costNote), "the costlier note does not fall through to the 'unknown' copy");

  const html = renderFallbackBanner(fb({ costTier: 'costlier' }));
  // The stub escapeHtml tags what it touched, so the class suffix appears
  // as ⟦esc:danger⟧ — which incidentally proves the level went through it too.
  ok(html.includes('provider-fallback-cost-⟦esc:danger⟧'), 'the rendered cost line carries the danger class');
  ok(html.includes('data-cost-tier="⟦esc:costlier⟧"'), 'the tier is exposed on the banner element');
}

// ── 3. costTier: 'unknown' — must NOT read as reassuring ─────────────────
// The single most important section in this file. v3.0.15 deleted a
// family-name cost heuristic precisely because it silently rated a 3.75x
// output jump as "same tier": the family word is stable across model
// generations, the price is not. An 'unknown' verdict that renders as
// silence, or as a soothing "no change expected", reintroduces exactly that
// harm through the UI instead of through the heuristic.
section("3. costTier 'unknown' — never dressed up as safe");
{
  const v = classifyFallback(fb({ costTier: 'unknown', costlier: false }));
  eq(v.costTier, 'unknown', 'tier preserved');
  ok(typeof v.costNote === 'string' && v.costNote.trim().length > 0,
    'unknown DOES produce a cost note — silence would read as "nothing to worry about"');
  eq(v.costLevel, 'attention', 'unknown is rendered at the attention level, not as neutral body text');
  ok(/may differ/i.test(v.costNote), 'the note states the price MAY DIFFER rather than asserting parity');
  ok(/pricing page/i.test(v.costNote) || /check/i.test(v.costNote),
    'the note gives the user something to do about the uncertainty');
  ok(!/same|no change|unchanged|identical|equivalent|cheaper/i.test(v.costNote),
    'the note never claims parity or a saving — the exact reassurance v3.0.15 removed from the cost heuristic');

  const html = renderFallbackBanner(fb({ costTier: 'unknown' }));
  ok(!html.includes('provider-fallback-cost-⟦esc:danger⟧'),
    'unknown does not borrow the danger class (which would over-claim in the other direction)');
  ok(html.includes('provider-fallback-cost-⟦esc:attention⟧'), 'unknown renders at the attention level');
}

// ── 4. costTier: 'similar' + legacy / malformed tiers ────────────────────
section("4. costTier 'similar' is the only silent tier; anything unrecognised warns");
{
  const v = classifyFallback(fb({ costTier: 'similar', costlier: false }));
  eq(v.costTier, 'similar', 'tier preserved');
  eq(v.costNote, null, "'similar' is the one CONFIRMED same-or-cheaper verdict — no cost line");
  eq(v.costLevel, 'none', "'similar' carries no cost level");
  eq(v.show, true, "but the banner itself still shows — the user is still not on the model they chose");
  ok(!renderFallbackBanner(fb({ costTier: 'similar' })).includes('provider-fallback-cost'),
    'no cost line element is emitted for similar');

  // Unrecognised / absent tiers resolve to 'unknown', NOT to 'similar'.
  // The legacy `costlier` boolean collapses 'similar' AND 'unknown' into
  // false (llm.js says so itself), so false does not mean parity.
  eq(classifyFallback({ provider: 'gemini', requestedModel: 'a', usingModel: 'b' }).costTier, 'unknown',
    'a payload with NO costTier at all resolves to unknown, never similar');
  eq(classifyFallback({ provider: 'gemini', requestedModel: 'a', usingModel: 'b', costlier: false }).costTier, 'unknown',
    'legacy costlier:false resolves to unknown — the boolean cannot distinguish similar from unknown');
  eq(classifyFallback({ provider: 'gemini', costlier: true }).costTier, 'costlier',
    'legacy costlier:true is still honoured (an old payload must still warn)');
  eq(classifyFallback(fb({ costTier: 'CHEAPER', costlier: false })).costTier, 'unknown',
    'an unrecognised tier string resolves to unknown, not silently to no-note');
  eq(classifyFallback(fb({ costTier: 'CHEAPER', costlier: true })).costTier, 'costlier',
    'an unrecognised tier with the legacy boolean set still warns — the boolean is the only signal left');
  eq(classifyFallback(fb({ costTier: null, costlier: false })).costTier, 'unknown',
    'a null tier resolves to unknown');
}

// ── 5. The banner names BOTH models and the action ───────────────────────
section('5. The banner says which model replaced which, and what to do');
{
  const v = classifyFallback(fb({ provider: 'anthropic', requestedModel: 'claude-haiku-4-5', usingModel: 'claude-sonnet-5' }));
  eq(v.providerLabel, 'Anthropic', 'anthropic id -> "Anthropic"');
  eq(v.requestedModel, 'claude-haiku-4-5', 'the model the user configured is carried through');
  eq(v.usingModel, 'claude-sonnet-5', 'the model actually in use is carried through');
  eq(classifyFallback(fb({ provider: 'gemini' })).providerLabel, 'Gemini', 'gemini id -> "Gemini"');
  eq(classifyFallback(fb({ provider: 'wat' })).providerLabel, 'wat',
    'an unrecognised provider id is echoed rather than mislabelled as one of the two we know');
  eq(classifyFallback(fb({ provider: null })).providerLabel, 'Your provider',
    'a missing provider still gets a banner with a neutral noun');
  eq(classifyFallback(fb({ requestedModel: undefined })).requestedModel, 'unknown',
    'a missing model id degrades to "unknown" rather than rendering an empty gap');

  ok(/update/i.test(v.action), 'the action tells the user to update');
  ok(!/above/i.test(v.action),
    "the action does not say 'above' — post-cutover, /next's Updates control is in the General SECTION, not directly above this one");
  ok(/General|sidebar/i.test(v.action), 'the action names where the Updates control actually is in /next');

  const html = renderFallbackBanner(fb({ provider: 'anthropic', requestedModel: 'claude-haiku-4-5', usingModel: 'claude-sonnet-5' }));
  const iReq = html.indexOf('claude-haiku-4-5');
  const iUse = html.indexOf('claude-sonnet-5');
  ok(iReq !== -1 && iUse !== -1, 'both model ids reach the markup');
  ok(iReq < iUse, 'the UNAVAILABLE model is named before the one now in use — "X is unavailable; running on Y"');
  ok(html.includes('⟦esc:claude-haiku-4-5⟧') && html.includes('⟦esc:claude-sonnet-5⟧'),
    'BOTH model ids pass through escapeHtml — they originate upstream of this render function');
  ok(html.includes('⟦esc:Anthropic⟧'), 'the provider label is escaped');
  ok(html.includes('data-icon="alertTriangle"'), 'the banner carries a warning glyph, not colour alone');
}

// ── 6. Active provider + resolved model readout ──────────────────────────
section('6. The active-model readout');
{
  const a = activeModelLine({ activeProvider: 'gemini', activeModel: 'gemini-3.1-flash-lite' });
  eq(a.show, true, 'a configured provider produces a readout');
  eq(a.providerLabel, 'Gemini', 'provider is labelled');
  eq(a.model, 'gemini-3.1-flash-lite', 'the RESOLVED model id is carried through');

  eq(activeModelLine({ activeProvider: null, activeModel: null }).show, false,
    'no active provider (no key configured) -> no readout, rather than an empty line');
  eq(activeModelLine(null).show, false, 'null payload -> no readout');
  eq(activeModelLine(undefined).show, false, 'undefined payload -> no readout');
  eq(activeModelLine({ activeProvider: 'gemini', activeModel: null }).model, 'unknown',
    'an active provider with a null model says "unknown" rather than rendering a blank');

  eq(renderActiveModelLine({ activeProvider: null }), '', 'renderActiveModelLine emits nothing without a provider');
  const html = renderActiveModelLine({ activeProvider: 'anthropic', activeModel: 'claude-haiku-4-5' });
  ok(html.includes('⟦esc:claude-haiku-4-5⟧'), 'the resolved model id is escaped into the markup');
  ok(html.includes('⟦esc:Anthropic⟧'), 'the provider label is escaped into the markup');

  // The readout is NOT the same value as the per-row default model. When a
  // fallback is active, models[provider] is still the configured default
  // while activeModel is what is actually being billed — showing only the
  // former is how a silent switch stays invisible.
  eq(activeModelLine({ activeProvider: 'gemini', activeModel: 'gemini-3.1-flash-lite',
                       models: { gemini: 'gemini-2.5-flash-lite' } }).model,
     'gemini-3.1-flash-lite',
     'the readout reports activeModel, NOT models[provider] — the two diverge exactly when a fallback is in play');
}

// ── 7. CLASS-LEVEL: /next reads these fields at all ──────────────────────
// This is the guard that stops the defect returning. The banner and the
// readout can be deleted, refactored, or accidentally dropped from
// renderProviders() and every behavioural assertion above would still pass
// — they execute the functions directly. What made this a cutover blocker
// was not a wrong render, it was NO render: the field was fetched and never
// read anywhere in the tree.
section('7. Class-level: the /next tree actually consumes fallback + activeModel');
{
  ok(/\bfallback\b/.test(code), 'settings.js code (comments stripped) mentions fallback at all');
  ok(/\.fallback\b/.test(code) || /\bfallback\s*\)/.test(code),
    'the fallback field is dereferenced, not merely named');
  ok(/k\.fallback/.test(code) || /keys\.fallback/.test(code) || /state\.keys\.fallback/.test(code),
    'the fallback field is read OFF THE api-keys RESPONSE object, not off some unrelated local');
  ok(/activeModel/.test(code), 'settings.js code reads activeModel');
  ok(/keys\.activeModel|k\.activeModel/.test(code),
    'activeModel is read off the api-keys response object');

  // Wired into the section that renders, not just defined. Both call sites
  // must be inside renderProviders() — a helper nobody calls is the same
  // dead data in a new coat.
  const providersBody = extractFunction(settings, 'renderProviders');
  ok(providersBody.length > 300, 'sanity: renderProviders() extracted (a truncated extract would pass the next two vacuously)');
  ok(providersBody.includes('renderFallbackBanner('),
    'renderProviders() CALLS renderFallbackBanner — the banner is reachable from the rendered section');
  ok(providersBody.includes('renderActiveModelLine('),
    'renderProviders() CALLS renderActiveModelLine');

  // Not behind a disclosure: a <details>/summary wrapper would technically
  // "read" the field while keeping a billing change one click away from
  // invisible.
  const iBanner = providersBody.indexOf('renderFallbackBanner(');
  const iRows = providersBody.indexOf('provider-row-list');
  ok(iBanner !== -1 && iRows !== -1 && iBanner < iRows,
    'the banner is emitted ABOVE the provider list, not appended below it');
  const bannerBody = extractFunction(settings, 'renderFallbackBanner');
  ok(!/<details|<summary/i.test(bannerBody),
    'the banner is not wrapped in a disclosure — a silent billing change must not be one click from invisible');
  ok(!/hidden|display:\s*none/i.test(bannerBody), 'the banner markup does not ship itself hidden');
}

// ── 8. Source-level hygiene: escaping and theming ────────────────────────
section('8. Escaping and CSS/theming hygiene');
{
  const bannerBody = extractFunction(settings, 'renderFallbackBanner');
  const activeBody = extractFunction(settings, 'renderActiveModelLine');
  // Every `+ something +` interpolation in these two must be an
  // escapeHtml(...) call or a fixed literal. Checked as: no interpolation
  // of a bare `v.` / `a.` property.
  ok(!/\+\s*v\.[a-zA-Z]/.test(bannerBody),
    'renderFallbackBanner interpolates no raw payload property — every one goes through escapeHtml()');
  ok(!/\+\s*a\.[a-zA-Z]/.test(activeBody),
    'renderActiveModelLine interpolates no raw payload property');
  ok(/escapeHtml\(/.test(bannerBody) && /escapeHtml\(/.test(activeBody),
    'both render helpers use escapeHtml');

  // Theming. color.css redefines the semantic tokens under [data-theme];
  // a prefers-color-scheme query here would fight that and strand one of
  // the two themes.
  ok(!/prefers-color-scheme/.test(cssCode),
    'settings.css contains no prefers-color-scheme query — theming is [data-theme] only');
  // Whole RULE BLOCKS, not just the selector lines — the declarations are
  // the thing being asserted, and a line filter would match only selectors
  // and then pass the token assertions vacuously against an empty body.
  const ownCss = (cssCode.match(/^\.provider-(?:fallback|active)[^{]*\{[^}]*\}/gm) || []).join('\n');
  ok(ownCss.length > 0, 'sanity: the new rules are present in settings.css');
  const hardcoded = ownCss.match(/#[0-9a-fA-F]{3,8}\b/g);
  ok(!hardcoded, `the new rules hardcode no hex colours (found ${JSON.stringify(hardcoded)})`);
  ok(/--attention-tint/.test(ownCss) && /--attention-text/.test(ownCss),
    'the banner uses the semantic attention tokens');
  ok(/--danger-text/.test(ownCss), 'the costlier cost line uses the semantic danger token');

  // House prefix convention: these rules belong to the providers section.
  const selectors = (ownCss.match(/^\.[a-z-]+/gm) || []);
  ok(selectors.length > 0, 'sanity: selectors found');
  ok(selectors.every((s) => s.startsWith('.provider-')),
    `every new selector uses the .provider- prefix (found ${JSON.stringify(selectors)})`);
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
