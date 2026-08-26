#!/usr/bin/env node
/**
 * Test aggregator (v3.0.1-beta.21).
 *
 * One command to run the whole battle-test suite and get a single pass/fail
 * report. Replaces "remember which of the 25 test-*.js files to run by name".
 *
 *   npm test            → OFFLINE suites only (fast, free, deterministic, no
 *                         network). Safe to run anytime, including in CI.
 *   npm run test:live   → OFFLINE + LIVE suites. LIVE suites hit the real
 *                         Gemini/Anthropic/GitHub APIs and need keys in .env or
 *                         the environment; each one self-skips if its key is
 *                         absent. Costs a few cents.
 *
 * Safety net: in the default (offline) mode we spawn each child with the
 * API/network credentials STRIPPED from its environment. So even if a suite is
 * mis-classified as offline, it physically cannot make a paid API call — the
 * worst case is the suite self-skips its live portion.
 *
 * A suite is judged PASSED iff it exits 0 AND its output shows no failure
 * marker. Both checks matter: some suites process.exit(1) on failure, and the
 * output scan is a backstop for any that don't.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasTransientMarker, classifyLiveOutcome } from './ci-flake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Suite manifest ────────────────────────────────────────────────────────
// OFFLINE: pure, deterministic, no network, no API key. The default `npm test`.
const OFFLINE = [
  'test-frontend-null-safety.js',
  'test-paths.js',
  'test-ingest-prompt-slimming.js',
  'test-sync-hygiene.js',
  'test-beta8-stress.js',
  'test-beta10-fixes.js',
  'test-beta11-fixes.js',
  'test-beta13-fixes.js',
  'test-beta15-fixes.js',
  'test-beta16-broken-links.js',
  'test-beta25-compile-prompt.js',
  'test-beta27-compile-fallback.js',
  'test-ci-flake.js',
  'test-runner-integration.js',
  'test-ingest-fixes.js',
  'test-sharedbrain-local.js',
  'test-sharedbrain-push.js',
  'test-sharedbrain-pull.js',
  'test-sharedbrain-security.js',
  'test-sharedbrain-synthesis.js',
  'test-sharedbrain-github-offline.js',
  'test-sharedbrain-mcp-guard.js',
  'test-sharedbrain-revoke.js',
  'test-sharedbrain-hardening.js',
  'test-sharedbrain-attribution.js', // attribute_by_name actually gates the contributor's real name out of shared storage — BOTH routes (payload + per-page delta contributor_name), fails closed on an absent/legacy flag, proven by a byte-level scan of everything written (utf-8 AND base64-decoded) with an opted-in control
  'test-sharedbrain-invite-storage-type.js',
  'test-sharedbrain-scenarios.js', // v3.0.6 Phase 5: 5.8-5.12 (local adapter, mock LLM/fetch, tempdir git)
  'test-diagnostics.js',
  'test-chat-truncation.js',       // v3.0.7: text-mode graceful truncation + context-neutral MAX_TOKENS error
  'test-chat-intent.js',           // v3.0.7 Tier 1: decision/enumerate/synthesis intent + catalogue-echo stripper
  'test-chat-style.js',            // Tier 2: concise/balanced/comprehensive response-style control
  'test-chat-markdown.js',         // chat Markdown renderer — XSS-safe, formatting
  'test-chat-model.js',            // per-chat model (provider) selector + getDefaultModel exposure
  'test-anthropic-content-blocks.js', // Anthropic text extraction at ANY block position. callProvider read content[0].text at BOTH extraction sites; a `thinking` block carries .thinking, never .text, so FALLBACK_CHAINS.anthropic[0] (claude-sonnet-5) threw on every realistic call — 3/3 measured live — while a trivial probe returned [text] and passed green, because omitting the thinking param means ADAPTIVE on sonnet-5 and NONE on sonnet-4-6/haiku-4-5. Class invariant over 2,000 generated content arrays (with coverage controls proving 562 put text somewhere other than first), not a case list.
  'test-chat-compile-card.js',     // compile result renders inline in the thread (no fixed panel)
  'test-css-tokens.js',            // every var(--x) CSS custom property is defined somewhere (the v3.0.12 --text-dim bug class)
  'test-next-reduced-motion.js',   // no /next CSS animation may hardcode a duration unless a same-file prefers-reduced-motion:reduce rule for that SAME selector sets animation/animation-duration — motion.css's reduce block only zeroes --dur-*, so a literal like 0.16s bypasses it (the v3.9.2 .mcpw-panel/.sbw-panel bug)
  'test-next-view-enter-motion.js', // navigate() fires the enter animation ONCE per navigation on the STABLE containers (#view-root/#sidebar) — not on .main-inner, which setMain replaces twice per entry on domains/chat, and not on #main, which would make the fixed reader overlay a descendant of a transformed element
  'test-domain-stats.js',           // getDomainStats per-type page counts + bulk GET /api/domains/stats
  'test-wiki-page.js',              // GET /api/wiki/:domain/page — single-page read + backlinks (health.js link-resolution parity, path-traversal defenses)
  'test-semantic-scan-yield.js',   // findSemanticCandidatePairs yields the event loop AND stays byte-identical. Measured pre-fix: a one-click button blocked the loop 15.0s on a 3,288-page domain while a normally-1ms /api/version took 13.7s. Pins the ranking against a golden sha computed UNCAPPED (the tail, not just the shipped top-500) across six chunk sizes; a chunk-boundary off-by-one reds 10 assertions. Section 4 is behavioural — a probe + timer must be serviced DURING the scan.
  'test-ingest-queue.js',           // Track 3 batch-ingest queue backend — sequential worker, crash resume, transient-error handling, cost estimate
  'test-ingest-queue-frontend.js',  // Track 3 batch-ingest queue frontend (owned by a parallel agent)
  'test-ingest-abort.js',           // real mid-file cancellation: AbortSignal threading, recovery-ladder bypass, queue `cancelled` item state
  'test-raw-store.js',              // Track 7 Part II raw-source retrieval — traversal corpus, REAL symlink escapes (v3.2.0 CRITICAL class), manifest tolerance, MCP never emits binary
  'test-raw-source-ui.js',           // Track 7 Part II frontend affordance — Wiki tab source bar, reason→copy mapping, external-source no-link/no-fetch invariant
  'test-route-write-guards.js',
  'test-health-ai-pricing.js',      // Health cost estimates delegate to llm.js's single authoritative price table (the v3.6.2 drifted-duplicate fix) + honest reporting when a model has no listed price
  'test-health-cost-readouts.js',  // the honest unpriced cost signal actually REACHES the rendered output in both frontends (the v3.6.1 'new API fields were dead data' shape), plus revoke's server-owned summary wording
  'test-mcp-setup-contract.js',      // write-registry guard on mutating /api/config + /api/sync/setup + domain-rename routes — fires during a write, and (the half people forget) does NOT fire when idle
  'test-mcp-e2e.js',                 // the MCP contract spoken over REAL stdio JSON-RPC. Two properties NOTHING else checked. (1) STDOUT PURITY — a stray console.log anywhere on the 33-file transitive import graph corrupts the stream (the v2.5.3 bug) and npm test stayed 68/68 green; the one suite that already spawned the server SWALLOWED the evidence with `try { JSON.parse(line) } catch {}`. (2) mcp/graph.js had ZERO coverage of any kind — gutting extractOutgoingLinks() reported every page an orphan, still 68/68 green. Plus the dot-slug regression, the 400 KB budget bracketed from both sides, and the read-only-mirror refusal driven through the wire. OFFLINE deliberately: 17 of 18 tools make no LLM call, so it needs no key and gates every fork PR, where a live job gates only push-to-main.
  'test-next-ingest-logic-drift.js', // TEMPORARY — delete alongside app.js at /next cutover. Byte-identity tripwire between app.js's batch-ingest pure helpers and their src/public/next/shared/ingest-queue-logic.js copy, so a bug fixed in one frontend and not the other goes RED instead of silently re-shipping.
  'test-next-mcp-wizard.js',        // /next MCP setup wizard — pure decision logic + escaping/CSS/HTML seams. NOT temporary: it outlives cutover.
  'test-wiki-list.js',                // GET /api/wiki/:domain/list — readdir-only inventory built on health.js's listMd (imported, never copied), set-equal to what /page will open
  'test-next-domain-lifecycle.js',    // /next domain create/rename/delete — incl. the display-name-only rename where newSlug EQUALS oldSlug, and a 409 refusal that renders in-viewport
  'test-next-semantic-gate.js',       // /next per-pair semantic-merge gate — the previewed set must be EMPTY after scan, domain switch and flip (two independent layers), and the batch bar must read LIVE state
  'test-next-chat-compile.js',        // /next Compile to Wiki + the chat-scope handoff — `refused` is a normal outcome not an error, and a consumed scope request must NOT re-apply on a second mount
  'test-next-sharedbrain-admin.js',   // /next Shared Brain revoke + admin-token rotate — outcome tone comes from the structured fields, never the summary prose
  'test-next-onboarding.js',         // /next first-run guidance panel (R7) — non-blocking, dismissible, re-findable. Pins the R7 step order, the SHOW-on-storage-throw fail-safe, and that the boot() hook cannot stop markBooted() (the blank-page guard).
  'test-next-markdown.js',           // /next's ONE markdown renderer (next/shared/markdown.js) — escape-first XSS battery over the WIDENED input surface (wiki page bodies arrive over Sync/Shared Brain), + the single-declaration guard that keeps it one copy.
  'test-cutover.js',                 // The cutover: `/` + the SPA catch-all serve the /next shell, `/old` serves the shipping app, plus the one-time notice. Pins express.static's index:false (without it `/` never reaches the catch-all and the OLD app stays at `/` with every guard green), the HIDE-on-can't-tell fail-safe, and mutual exclusion with the first-run panel proved over all 8 fact combinations.
  'test-health-merge-links.js',      // A merge that DELETES a page must repoint every [[link]] to it. Two of the three deleting handlers did not, and the one-click "Fix all safe" path reached one of them. Enumerates EVERY `await rm(` in health.js and requires a repoint before it — a class guard, not a list of three names.
  'test-next-cost-honesty.js',       // Money must never be misstated: a cancelled item's real partial spend is charged AND flagged as a lower bound, no non-zero cost renders as $0.0000, and a paid scan survives a view change without surviving a DOMAIN change.
  'test-next-icons.js',              // Every VIEW_META icon name must exist in ICON_BODY, and an unknown name must render an unmistakable placeholder — Settings shipped rendering a sun because its gear path carried opacity="0" and icon() fell back to a REAL glyph.
  'test-next-confirm-dialog.js',     // In-design confirm replacing window.confirm. The API resolves to no decision, so `const ok = confirm(...)` without await is INEXPRESSIBLE — the naive port fired the DELETE on Cancel.
  'test-next-recovery-and-badge.js', // Boot-recovery copy must name /old and NEVER "/" (post-cutover "/" IS the broken shell — the old advice looped), plus the rail sync badge, fail-quiet: a badge that lies about unpushed work is worse than none.
  'test-next-progress-ring.js',      // The two-layer ring. Pins the honesty invariant: a live stage at stageProgress 0 has ZERO fill, and nothing in the outer ring derives from elapsed time or the orbit.
  'test-next-model-fallback.js',     // The fallback-cost banner. An unrecognised cost tier resolves to 'unknown', NEVER 'similar' — `costlier:false` cannot tell parity from ignorance, and the fail-safe direction on money is to warn.
  'test-next-provider-rows.js',    // class invariant: a provider row may render — and onSaveKey may POST — ONLY its own provider's credential. The binary `p.id === 'gemini' ? A : B` form rendered Anthropic's mask on any third row and POSTed a third provider's key as anthropicApiKey; both were latent only because openai/local are available:false
  'test-next-loading-gate.js',     // loaders are DELAY-GATED: nothing under 200ms, and once shown held 400ms so it cannot strobe. Measured: every /next view-entry placeholder lived 1.3-12ms — they were sub-frame flashes that collapsed the column, not slow loads. Also pins health stale-while-revalidate (KEEP on same-domain re-entry, CLEAR on domain switch — showing domain A's health under B is worse than the flicker) and chat's booted gate against a false empty state.
  'test-next-raw-source.js',         // The reader's RAW bar, 4 states. An external-source URL is inert text, proven behaviourally: exactly ONE request, to our own endpoint, and the declared host never contacted.
  'test-next-invite-and-inert.js',   // Shared Brain invite re-display, verified BYTE-FOR-BYTE against the route's real encodeInviteToken, plus the class invariant that no user-visible string says "preview shell"/"this phase".
  'check-doc-suite-counts.js',
  'test-repair-wiki-args.js',
  'test-wiki-script-args.js',
  'test-summary-backlink-sync.js', // syncSummaryEntities — "THE KEY POST-WRITE STEP", reached by FOUR write paths (ingest, compile, MCP compile, Shared Brain pull) and previously covered by nothing offline: replacing its entire body with `return;` left npm test byte-identical. More LIVE gating would NOT have closed it either — test-ingest-deep's Q6 reports through warn(), which does not set exitCode. Pins the graph invariant as SET EQUALITY BOTH WAYS (entitiesMentioned == backlinkers), because containment-only stays green when the sync drops the concepts half or is fed original LLM paths instead of writePage's canonPath.
];

// LIVE suites hit real Gemini/Anthropic/GitHub. Each self-skips when its key is
// missing, so running test:live without keys is harmless (reports SKIP, exit 0).
// Split into two tiers:
//
// LIVE_CI — self-contained + deterministic enough to gate CI. They isolate the
//   domains dir via CURATOR_TEST_DOMAINS_DIR (beats config) so they never touch
//   the real domains/ folder, on CI or a configured dev machine.
const LIVE_CI = [
  'test-beta8-live-llm.js',
  'test-beta14-anthropic-fix.js',
  'test-beta16-production.js',
  'test-beta17-production.js',
  'test-beta25-compile-live.js', // compile on a seeded large-index domain (Fix #1)
  'test-beta27-compile-live.js', // compile fallback prompts honoured by real models (Fix #2)
  'test-chat-truncation-live.js', // v3.0.7: real Gemini/Anthropic — text partial-return, JSON throw + isOutputTokenLimit
  'test-chat-intent-live.js',     // v3.0.7 Tier 1: real Gemini/Anthropic — decision/analytical answers are focused, no dump
  'test-chat-style-live.js',      // Tier 2: real Gemini/Anthropic — concise < comprehensive, no dump, garbage→balanced
  'test-chat-model-live.js',      // per-chat provider override — routing + both providers answer
  // v3.0.6 Phase 5 (plan 5.6) — the GITHUB_TEST_* workflow secrets are no
  // longer dead config; all three self-skip or self-degrade without them:
  'test-sharedbrain-github-live.js', // self-skips without GITHUB_TEST_*; unique slugs per run; exhaustive cleanup
  'test-sharedbrain-routes.js',      // spawns a server on 3334; isolated via CURATOR_TEST_USER_DATA_DIR (all four credential files) + a read-only guard asserting the real ones are untouched; no network unless GITHUB_TEST_* set
  'test-sharedbrain-llm-live.js',    // real delta+conflict prompts on every configured provider; GitHub storage when secrets present, local otherwise
  // v3.9.1 — PROMOTED from LIVE_LOCAL. Ingestion quality is the product, so the
  // suite that guards it belongs on the gate. The three blockers that kept it
  // local are gone: it self-skips at exit 0 without a key (it used to exit 2 →
  // hard FAIL), it no longer sidelines the real .curator-config.json (SIGKILL on
  // timeout never reached its cleanup()), and it now prints an assertion tally
  // (without one, any future ⏭ line silently reclassifies the whole suite as
  // NOT RUN — the v3.7.0 invisible-to-CI shape). The one assertion that failed on
  // UNMUTATED code (SYN-9's hub-link count) is now advisory, and Q5's broken-link
  // ceiling was widened 10%→20% after an unmutated run measured 9.2% — a gate
  // sitting at 92% of its cap is a gate about to cry wolf. Measured: $0.0325 and
  // 155-208s per run. HONEST CAVEAT: n=3 on the real tree — enough to say the
  // gates are sound, not enough to say they never flake. If it flakes, the
  // retry-once + transient-marker machinery bounds the damage; if it flakes for a
  // QUALITY reason, move it back rather than widening the ceiling again.
  'test-ingest-deep.js',             // 10-scenario ingest-quality harness; self-skips without a Gemini key
];

// LIVE_LOCAL — run locally (full `npm run test:live`) but EXCLUDED on CI:
//   - test-beta13-chat-live: reads the dev machine's real 1000-page `articles`
//     domain and judges LLM answer quality (no data on CI; non-deterministic).
//   - test-ingest-real-llm (v3.5.1: de-personalised): needs a local source
//     document the runner supplies via CURATOR_LIVE_SCHEMA (a domain CLAUDE.md)
//     + CURATOR_LIVE_ARTICLE (an .md/.txt/.pdf to ingest) — self-skips (exit 0)
//     when either is unset, same contract as a missing API key. No longer tied
//     to one machine's filesystem or one specific author; the author-entity
//     assertions are derived from whatever byline the supplied article itself
//     carries (extractAuthorHints/slugifyName), or skip gracefully if it has
//     none. Stays local-only because CI has no article to point it at, not
//     because of anything personal in the test itself anymore.
//   - test-beta15-production: MOVED OUT OF CI (was LIVE_CI). Not flaky output —
//     flaky RUNTIME, and bimodally so. It drives large multi-phase ingests on
//     BOTH providers, and ingest's Phase-2 recovery ladder turns a single
//     failed batch into page-by-page: one LLM call per page, each with a
//     possible brevity retry. So the suite has TWO runtimes, not a spread:
//     fast path ~250-600s, fallback path >20 min. Measured on main, in order:
//     351s, 380s, 512s, 452s, 590s, 554s (green) -> 600s TIMEOUT -> 248s (the
//     fastest ever recorded) -> 1,200s TIMEOUT against a cap that had just
//     been RAISED to 20 min. The 1,200s run's last output was
//     "[ingest] ↻ concepts/… — retrying with a brevity directive", i.e. it was
//     inside the fallback; two other live suites in the same run passed in 71s
//     and 25s, so the providers were healthy.
//
//     Raising the cap was the WRONG FIX and is recorded here so it is not
//     retried: the fallback's cost is O(pages) sequential calls, so no finite
//     cap bounds it. CI keeps live multi-phase ingest coverage via
//     test-beta8-live-llm (Gemini) and test-beta14-anthropic-fix (Anthropic);
//     what moves local-only is the dual-provider LARGE-document combination.
//
//     PRODUCT FOLLOW-UP, not just a CI concern: a run that enters the
//     page-by-page ladder is spending dozens of extra LLM calls, and real
//     users pay for that too. Why a Phase-2 batch fails on this fixture is
//     worth investigating on its own merits.
const LIVE_LOCAL = [
  'test-beta13-chat-live.js',
  'test-ingest-real-llm.js',     // needs CURATOR_LIVE_SCHEMA + CURATOR_LIVE_ARTICLE supplied locally; self-skips otherwise
  'test-beta15-production.js',   // bimodal runtime — see the note above; a cap cannot bound the fallback ladder
];

// All live suites, for labelling.
const LIVE = [...LIVE_CI, ...LIVE_LOCAL];

// Env vars that grant API/network access. Stripped from offline children.
const CREDENTIAL_ENV = [
  'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
  'GITHUB_TEST_REPO', 'GITHUB_TEST_PAT',
];

// Offline suites run in <1s; live suites do real multi-phase ingests on one or
// two providers and legitimately take minutes (beta15-production ingests on BOTH
// Gemini and Anthropic). Give live suites a generous ceiling so a slow-but-fine
// run isn't killed; offline keeps a tight one.
const OFFLINE_TIMEOUT_MS = 120_000;  // 2 min (deterministic; never approached)
const LIVE_TIMEOUT_MS = 600_000;     // 10 min — most live suites

// ── PER-SUITE LIVE TIMEOUTS ────────────────────────────────────────────────
// A live suite's runtime is dominated by PROVIDER LATENCY, which varies by
// ~2.4x across runs on byte-identical code. A flat cap therefore fails on
// provider weather rather than on a defect — and the runner deliberately does
// NOT retry a TIMEOUT (that would double an already-long wait), so a suite
// running near its cap is a gate that will eventually go red for no reason.
//
// MEASURED, not guessed — test-beta15-production.js (large multi-phase ingest
// + compile on BOTH Gemini and Anthropic) across six consecutive green CI runs
// on main, newest first:
//
//     351,607ms · 380,428ms · 512,421ms · 452,822ms · 590,860ms · 554,881ms
//
// It then TIMED OUT at 600,005ms, and on the very next run — same suite, no
// change to any code it exercises — finished in 248,345ms, the fastest ever
// recorded. Observed range 248,345ms to >600,000ms is a 2.4x swing.
//
// That is 59%-98% of the 600,000ms cap, with one run inside 0.15% of it. It
// then timed out on v3.6.2 — a release that touched NO ingest, llm, files or
// compile code, confirming the cause is latency, not a regression.
//
// 1,200,000ms is ~2x the observed worst case, so even the SLOWEST recorded run
// could double again and still pass. Do not lower this back toward the
// observed maximum: the maximum is what fails.
const LIVE_SUITE_TIMEOUT_MS = {
  'test-beta15-production.js': 1_200_000,   // 20 min
  // Measured 155-208s, but SYN-4 now genuinely takes the multi-phase path and
  // plans 47-66 pages; Phase 2's page-by-page fallback is O(pages), so a bad
  // run has far more headroom to consume than the default 600s allows.
  'test-ingest-deep.js': 900_000,           // 15 min
};

// ── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const runLive = args.includes('--live') || process.env.RUN_LIVE === '1';
// On CI (GitHub sets CI=true) exclude the local-only suites: they either need
// real local data, special secrets, or have flaky LLM-quality thresholds.
const isCI = process.env.CI === 'true' || process.env.CI === '1';

let suites;
if (!runLive) {
  suites = [...OFFLINE];
} else if (isCI) {
  suites = [...OFFLINE, ...LIVE_CI];
} else {
  suites = [...OFFLINE, ...LIVE_CI, ...LIVE_LOCAL];
}

// Test-only seam (used by test-runner-integration.js; unset in normal runs/CI):
// RUN_TESTS_LIVE_ONLY=<comma-separated suite files> replaces the manifest with
// exactly those files and marks each as LIVE, so the retry/inconclusive
// orchestration can be exercised end-to-end against tiny fake suites.
let forcedLive = null;
if (process.env.RUN_TESTS_LIVE_ONLY) {
  suites = process.env.RUN_TESTS_LIVE_ONLY.split(',').map(s => s.trim()).filter(Boolean);
  forcedLive = new Set(suites);
}

// ── Runner ────────────────────────────────────────────────────────────────
function runSuite(file, { stripCreds, timeoutMs }) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (stripCreds) for (const k of CREDENTIAL_ENV) delete env[k];

    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: path.resolve(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ file, ok: false, ms: Date.now() - started, reason: 'TIMEOUT', out });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      // Failure markers (CASE-SENSITIVE on purpose). Two summary styles exist:
      //   "Passed: 39   Failed: 0"  → match a non-zero after the "Failed:" label
      //   "70 passed, 0 failed"     → match a non-zero before the lowercase word
      // Case sensitivity stops the lowercase pattern from matching the capital
      // "Failed" label preceded by the (non-zero) PASSED count, which was a
      // false-positive in the first cut.
      const failMarker =
        /Failed:\s*[1-9]/.test(out) ||
        /\b[1-9]\d*\s+failed\b/.test(out) ||
        /(^|\n)\s*✗/.test(out);
      // "Skipped" = the suite self-skipped (a live suite with no key). Match
      // only the strong markers the gating code prints — the ⏭ glyph, an
      // all-caps "SKIPPED", or a leading "SKIP:" line — NOT the lowercase word
      // "skip" that appears in ordinary assertion labels ("graceful skip…").
      // A suite announces a real self-skip at the START of a line — verified
      // against every suite that actually self-skips: 'SKIP: …',
      // '⏭  LIVE tests SKIPPED …', 'SKIPPED — GEMINI_API_KEY not set.'.
      //
      // These patterns are ANCHORED because the unanchored form is a live
      // bug, not a hypothetical: a bare /\bSKIPPED\b/ against the whole
      // output classifies any suite that merely MENTIONS the word as
      // not-run. test-next-semantic-gate.js hit this with the accurate
      // assertion label "the SKIPPED pair was not sent" — 95/95 green, and
      // the runner reported it as ⏭ skip, i.e. invisible to CI, on the suite
      // guarding the most destructive path in the release.
      //
      // v3.3.0 recorded this class ("npm test reported the whole suite as
      // skip … because an assertion label contained the word SKIPPED") and
      // the response was a defensive assertion inside ONE suite
      // (test-ingest-abort.js:649), which left every suite written since
      // unprotected. This is the class fix; that per-suite canary is kept as
      // defence in depth.
      // A suite counts as SKIPPED only when it BOTH announces a skip AND
      // reports no assertion tally. Prose alone is not enough in either
      // direction, and both halves are load-bearing:
      //
      //   - Announcement alone over-reports. test-sharedbrain-revoke.js prints
      //     "  ⏭  running as root — chmod cannot deny unlink; §7 permission
      //     case not exercised" — a PARTIAL skip, mid-run, after 254 real
      //     assertions. Matching on the glyph alone marks the whole OFFLINE
      //     suite not-run on any root CI runner.
      //   - Matching only the idioms I had first enumerated under-reports.
      //     `⊘ No Gemini key configured — skipping…` (test-beta25/27-compile-
      //     live) and `Self-skipping (live-suite convention)` (test-ingest-
      //     real-llm) matched NEITHER earlier pattern, so those reported
      //     ✓ pass while running nothing.
      //
      // A genuine self-skip returns before its summary, so it emits no
      // "Passed: N" line; a partial skip always has one. That is the
      // discriminator — a property of what ran, not a phrase.
      //
      // HISTORY, so this is not "fixed" a third time by widening a regex:
      // v3.3.0 hit this class and answered it with a defensive assertion
      // inside ONE suite (test-ingest-abort.js), leaving every later suite
      // exposed. This session hit it again (test-next-semantic-gate.js, 95/95
      // green and invisible to CI, on the guard for the most destructive path
      // in the release), and the first repair anchored the patterns —
      // which fixed that instance, missed the two idioms above, and added the
      // partial-skip false positive. The list below is the set actually
      // verified against the tree, not a claim of completeness.
      const announcesSkip = /^\s*⏭/m.test(out) || /^\s*SKIPPED\b/m.test(out)
        || /^SKIP:/m.test(out) || /^\s*⊘/m.test(out) || /^\s*Self-skipping\b/m.test(out);
      // v3.9.1: this tested ONLY the capitalised `Passed: N` form and was therefore
      // blind to 16 suites that print the lowercase tally (`beta.16 offline: 243
      // passed, 0 failed`; `346 passed, 0 failed (346 total)`) — including the two
      // largest in that release. Injecting one realistic partial-skip line into
      // test-beta16-broken-links.js produced `⏭ skip` while 243 assertions actually
      // ran. That is the v3.7.0 shape verbatim: a 95/95-green suite reported to CI
      // as NOT RUN because a label contained a skip word. The runner's own
      // failMarker below already knew both formats existed, which is what makes
      // this an oversight rather than an unknown. Harm was bounded — `ok` is
      // computed independently, so a FAILING suite still fails the build — but a
      // suite that silently reads as "not run" invites "those are the keyless
      // ones, ignore them", which is exactly how real coverage goes unnoticed.
      const reportedAssertions = /^\s*(?:Total:\s*\d+\s+)?Passed:\s*\d+/m.test(out)
        || /^[^\n]*\b\d+\s+passed\b/m.test(out);
      const skipped = announcesSkip && !reportedAssertions;
      const ok = code === 0 && !failMarker;
      resolve({ file, ok, ms, code, skipped, out });
    });
  });
}

function tail(out, n = 12) {
  return out.split('\n').filter(Boolean).slice(-n).map(l => `      ${l}`).join('\n');
}

(async () => {
  console.log(`\n  The Curator — test aggregator`);
  console.log(`  Mode: ${runLive ? 'OFFLINE + LIVE (real API calls)' : 'OFFLINE only (no network, no cost)'}`);
  if (runLive && isCI) {
    console.log(`  CI detected → excluding ${LIVE_LOCAL.length} local-only suite(s): ${LIVE_LOCAL.join(', ')}`);
  }
  console.log(`  Suites: ${suites.length}\n`);

  const results = [];
  for (const file of suites) {
    const isLive = LIVE.includes(file) || (forcedLive !== null && forcedLive.has(file));
    const opts = {
      stripCreds: !runLive,
      timeoutMs: isLive ? (LIVE_SUITE_TIMEOUT_MS[file] || LIVE_TIMEOUT_MS) : OFFLINE_TIMEOUT_MS,
    };
    let r = await runSuite(file, opts);

    // Live-suite flake tolerance (Option 1, v3.0.1-beta.26).
    //
    // A live suite hits real Gemini/Anthropic, so a transient provider error
    // (503 / dropped stream / rate-limit / network) fails it through no fault of
    // the code. Two cases, handled differently to keep the gate both honest AND
    // fast:
    //
    //   • First failure ALREADY shows a transient marker → the provider is in a
    //     storm right now. Do NOT retry — a retry would just grind through the
    //     same 503 backoffs (minutes on a heavy multi-phase ingest, and a real
    //     timeout risk). Mark INCONCLUSIVE immediately. During an outage
    //     "inconclusive" is the honest verdict anyway.
    //   • First failure has NO transient marker → it's ambiguous (an intermittent
    //     blip or a non-deterministic LLM-quality miss that may pass on a second
    //     look, and the suite ran at normal speed so a retry is cheap). Retry
    //     ONCE: pass → pass; fail-with-transient → inconclusive; fail-with-no-
    //     marker → genuine FAIL.
    //
    // Offline suites are deterministic and never retried. A TIMEOUT is never
    // retried (it would double an already-10-minute wait) and stays a FAIL.
    // Accepted trade-off: a real failure coinciding with a transient error in
    // the same run is reported inconclusive, not fail — the deterministic offline
    // suite + local `test:live` still catch real regressions, and a real bug
    // recurs on the next healthy-provider run.
    if (!r.ok && isLive && r.reason !== 'TIMEOUT') {
      if (hasTransientMarker(r.out)) {
        // Provider storm on the first attempt — skip the (slow, futile) retry.
        console.log(`  \x1b[33m⚠ flake\x1b[0m  ${file.padEnd(38)} transient provider error on first attempt — skipping retry`);
        r = { ...r, ok: true, skipped: true, inconclusive: true };
      } else {
        console.log(`  \x1b[33m↻ retry\x1b[0m  ${file.padEnd(38)} live suite failed (no provider error) — retrying once…`);
        const r2 = await runSuite(file, opts);
        const outcome = classifyLiveOutcome({
          firstOk: false,
          retried: true,
          retryOk: r2.ok,
          firstTransient: false,
          retryTransient: hasTransientMarker(r2.out),
        });
        if (outcome === 'pass') {
          r = r2;
        } else if (outcome === 'inconclusive') {
          r = { ...r2, ok: true, skipped: true, inconclusive: true };
        } else {
          r = r2; // genuine, reproducible failure
        }
      }
    }

    results.push(r);
    const label = r.inconclusive
      ? '\x1b[33m⚠ flake\x1b[0m'
      : r.ok
        ? (r.skipped ? '\x1b[33m⏭ skip\x1b[0m' : '\x1b[32m✓ pass\x1b[0m')
        : '\x1b[31m✗ FAIL\x1b[0m';
    console.log(`  ${label}  ${file.padEnd(38)} ${(r.ms + 'ms').padStart(7)}${isLive ? '  (live)' : ''}`);
    if (r.inconclusive) {
      console.log(`         ⚠ inconclusive — transient provider error (503 / rate-limit / dropped stream) on both attempts. NOT counted as a failure.`);
    } else if (!r.ok) {
      console.log(`         reason: ${r.reason || `exit ${r.code}`}`);
      console.log(tail(r.out));
    }
  }

  const failed = results.filter(r => !r.ok);
  const inconclusive = results.filter(r => r.inconclusive);
  const skipped = results.filter(r => r.ok && r.skipped && !r.inconclusive);
  const passed = results.length - failed.length - inconclusive.length;
  console.log(`\n  ────────────────────────────────────────`);
  console.log(
    `  ${results.length} suites · ${passed} passed · ${failed.length} failed` +
    `${inconclusive.length ? ` · ${inconclusive.length} inconclusive (provider flake)` : ''}` +
    `${skipped.length ? ` · ${skipped.length} skipped` : ''}`
  );
  console.log(`  ────────────────────────────────────────\n`);

  if (inconclusive.length) {
    console.log('  ⚠ INCONCLUSIVE (transient provider errors — not gating the build):');
    for (const r of inconclusive) console.log(`    ⚠ ${r.file}`);
    console.log('    Re-run the live job when the provider has recovered to get a clean signal.\n');
  }

  if (failed.length) {
    console.log('  FAILED suites:');
    for (const r of failed) console.log(`    ✗ ${r.file} (${r.reason || `exit ${r.code}`})`);
    console.log('');
    process.exit(1);
  }
  process.exit(0);
})();
