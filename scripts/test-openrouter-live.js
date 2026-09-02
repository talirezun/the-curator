#!/usr/bin/env node
/**
 * test-openrouter-live.js — the LIVE suite for the OpenRouter provider.
 *
 * OpenRouter shipped in v3.15.0 and grew a synced catalogue (v3.16.0) and a
 * streaming + reasoning path (v3.23.0) with NO live coverage at all: every
 * offline OpenRouter suite drives the adapter through an injected `fetchImpl`,
 * so nothing in this repository had ever proved that the real wire agrees with
 * the shapes those doubles assert. This suite closes that, on four real calls.
 *
 * ── WHAT IT PROVES, AND WHY EACH ONE IS A LIVE QUESTION ────────────────────
 *   §1 TEXT MODE. A chat-shaped `generateText` answers, and the id it reports
 *      is the id that ANSWERED — read back off the response body, which is the
 *      v3.13.2 rule and the one thing a fetch double cannot vouch for.
 *   §2 JSON MODE — THE BUILD LANE. A real `ingestFile` on a synthetic ~1.5 KB
 *      source in an isolated temp domain. This is the lane that writes the
 *      user's wiki, so it is exercised through `ingestFile` itself rather than
 *      through a bare `generateText(…, 'json')`: the thing at risk is the whole
 *      parse-and-write pipeline, not the transport.
 *   §2b THE EMPTY-CONTENT TRAP (v3.23.0). REPLAY, not a fifth call — see below.
 *   §3 STREAMING. Deltas arrive in more than one piece, the concatenation is
 *      byte-identical to the authoritative return value, and — on a model
 *      measured `thinks: false` — NO reasoning is invented.
 *   §4 REFUSAL. A model id that does not exist is classified, not stack-traced,
 *      and does NOT walk the fallback chain onto a paid rung.
 *   §5 MONEY. The model used must have a `MODEL_PRICES_USD_PER_MTOK` entry, and
 *      the price this repo types by hand must equal the bill OpenRouter reports.
 *
 * ── THE MODEL, AND WHY IT IS NOT THE PINNED DEFAULT ────────────────────────
 * `ibm-granite/granite-4.0-h-micro` — the CHEAPEST hand-measured model The
 * Curator offers anywhere ($0.017/$0.112 per 1M), build-lane eligible
 * (`jsonRaw: true`, 9 of 9 clean runs), and the sole rung of
 * `FALLBACK_CHAINS.openrouter`. `DEFAULTS.openrouter` is `upstage/solar-pro4`
 * and is asserted as a FACT in §5 without being called: a live gate should not
 * bill 4x for a transport question, and the two models take byte-identical
 * paths through the adapter. Nothing here ever reaches an UNMEASURED model —
 * the runtime catalogue is never synced or restored by this suite, so the
 * offerable set is the static hand-measured one.
 *
 * ── ISOLATION: STRICTER THAN THE SIBLING LIVE SUITES, DELIBERATELY ─────────
 * `CURATOR_TEST_USER_DATA_DIR` + `CURATOR_TEST_DOMAINS_DIR` both point at
 * tempdirs, set before any app module is imported. That isolates all four
 * credential files AND `domains/`, and §0 ASSERTS it (the resolved config path
 * must live under the tempdir) before a single byte is spent.
 *
 * The consequence is stated rather than hidden: this suite CANNOT read a key
 * out of your `.curator-config.json`, so `OPENROUTER_API_KEY` must be in the
 * environment (or `.env`). That is the same shape CI supplies, and it is the
 * price of never touching the maintainer's real config — `test-beta8-live-llm.js`
 * MOVES that file aside for the duration of its run, which is a data-loss
 * hazard the moment the runner SIGKILLs it on timeout (the v3.9.1 finding). No
 * file outside the two tempdirs is written, moved or deleted by this suite.
 *
 * ── WHY §2b AND THE SECOND HALF OF §4 ARE REPLAYS ──────────────────────────
 * Both need a provider response this suite cannot make the provider produce on
 * demand: an empty `content` string on a clean `finish_reason: "stop"`, and the
 * fallback-chain decision that follows a refusal. So the REAL wire bytes are
 * captured through a recording `fetchImpl` on the REAL adapter, ONE field is
 * changed, and the same bytes are fed back through the REAL adapter and the
 * REAL `callOpenRouter`. That is not a mock of the provider's behaviour — it is
 * the provider's own response, replayed. Each replay carries a CONTROL proving
 * the unmodified body still succeeds, so a harness that always threw would go
 * red rather than look green.
 *
 * ── TRANSIENT FAILURES AND THE GATE ────────────────────────────────────────
 * Every error message is printed verbatim, so `scripts/ci-flake.js` can see the
 * markers it recognises and the runner reports INCONCLUSIVE rather than red: a
 * 429 keeps its literal "429" (the adapter's `TRANSIENT_STATUSES` deliberately
 * exempts it from neutralisation), and a transport failure carries undici's own
 * "fetch failed" / "ETIMEDOUT" text.
 *
 * ⚠ ONE HONEST GAP, recorded rather than papered over: an OpenRouter 502/503
 * arrives with its status token STRIPPED, because with
 * `allow_fallbacks:false, require_parameters:true` a 503 means "no upstream met
 * the routing constraints" — a deterministic capability failure, and the
 * adapter refuses to emit a transient sentinel it does not mean. So a genuine
 * provider-side routing outage on this one model WILL red this gate. Fixing
 * that by printing "Service Unavailable" ourselves would be this repo's own
 * named defect (a producer emitting a token it does not mean), so the failure
 * prints `code` and `status` instead and a human reads them in one line.
 *
 * COST: ~$0.0002 per run, measured. The total reported spend is printed at the
 * end and §5 fails the suite if it exceeds one cent.
 *
 * Run: OPENROUTER_API_KEY=… node scripts/test-openrouter-live.js
 * Self-skips (exit 0) with no key.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config(); // standalone script — .env is not loaded via server.js here

// ── §0a ISOLATION, BEFORE ANY APP MODULE IS IMPORTED ───────────────────────
// Every app module resolves these PER CALL (the v3.1.0 rule: no top-level
// `const X = getter()`), so setting them here is sufficient — but the imports
// below are still dynamic, so this holds even if a module ever regresses to
// snapshotting at load time.
const USER_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'curator-orlive-ud-'));
const DOMAINS_DIR = mkdtempSync(path.join(tmpdir(), 'curator-orlive-dom-'));
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA_DIR;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
// DOMAINS_PATH outranks the tempdir in getDomainsDir()'s chain and would point
// an "isolated" run at a real wiki (paths.js says so in as many words).
delete process.env.DOMAINS_PATH;
// The other two providers are removed from this PROCESS's environment so
// provider resolution is unambiguous: with no config file and one key, the
// active provider can only be openrouter. Without this, a developer's .env
// (loaded one line above) would make an ingest run on Gemini — the wrong
// provider, the wrong bill, and a green suite that tested nothing.
delete process.env.GEMINI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const MODEL = 'ibm-granite/granite-4.0-h-micro';
// LLM_MODEL is llm.js's documented single global model override, honoured only
// for the ACTIVE provider. It is how the ingest in §2 — which has no per-call
// model parameter — runs on the cheapest measured model instead of the pinned
// default. Process-local; nothing on disk is changed.
process.env.LLM_MODEL = MODEL;

let passed = 0, failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function fail(label, detail) {
  failed++; failures.push({ label, detail });
  console.log(`  ✗ ${label}`);
  if (detail) console.log(`    └─ ${detail}`);
}
function assertTrue(cond, label, detail) { if (cond) ok(label); else fail(label, detail); }

function cleanup() {
  try { rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(DOMAINS_DIR, { recursive: true, force: true }); } catch {}
}

/** Total USD OpenRouter itself reported for this run, summed off the wire. */
let reportedSpendUsd = 0;
/**
 * Every HTTP request that actually reached openrouter.ai, INCLUDING §4's
 * refusal — which bypasses the recording factory and would otherwise be
 * invisible to a count taken from `calls`. Reporting a partial count as the
 * call budget is this repo's own recorded defect (a CAP reported as a
 * MEASUREMENT), so the two numbers are kept separate and both are printed.
 */
let liveRequests = 0;

try {
  const KEY = process.env.OPENROUTER_API_KEY || '';
  if (!KEY) {
    // No assertion tally is printed on this path — run-tests.js classifies a
    // suite as SKIPPED only when it announces a skip AND reports no tally.
    console.log('⏭  SKIP: OPENROUTER_API_KEY not set.');
    console.log('   (This suite isolates every user-data path to a tempdir, so it deliberately');
    console.log('    cannot read a key out of .curator-config.json — put it in the environment.)');
    cleanup();
    process.exit(0);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  OpenRouter LIVE suite — real API, cheapest measured model');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log(`  Model:       ${MODEL}`);
  console.log(`  User data:   ${USER_DATA_DIR}`);
  console.log(`  Domains:     ${DOMAINS_DIR}\n`);

  // Late imports so the isolation above is in effect for every path resolution.
  const paths = await import('../src/brain/paths.js');
  const { getEffectiveKey } = await import('../src/brain/config.js');
  const llm = await import('../src/brain/llm.js');
  const { OpenRouterAdapter, OpenRouterError } = await import('../src/brain/openrouter-adapter.js');

  // ── §0b ISOLATION IS ASSERTED, NOT ASSUMED ──────────────────────────────
  console.log('§0  Isolation and provider resolution (before any spend)\n');
  const cfgFile = paths.getCuratorConfigFile();
  assertTrue(cfgFile.startsWith(USER_DATA_DIR),
    'the resolved .curator-config.json path is inside the tempdir (the real one is unreachable)',
    `resolved to ${cfgFile}`);
  assertTrue(!existsSync(cfgFile),
    'no config file exists there, so every key must come from the environment');
  assertTrue(getEffectiveKey('gemini') === null && getEffectiveKey('anthropic') === null,
    'neither Gemini nor Anthropic is keyed in this process (no cross-provider ambiguity)');
  assertTrue(getEffectiveKey('openrouter') !== null,
    'the OpenRouter key resolves through the real getEffectiveKey');
  const info = llm.getProviderInfo();
  assertTrue(info.provider === 'openrouter' && info.model === MODEL,
    `getProviderInfo() → openrouter · ${MODEL}`,
    `got ${JSON.stringify(info)}`);
  // A refusal here means we are about to bill the wrong provider. Stop.
  if (info.provider !== 'openrouter') {
    throw new Error(`ABORTING BEFORE SPEND — active provider resolved to "${info.provider}", not openrouter.`);
  }

  // ── THE CAPTURE SEAM ─────────────────────────────────────────────────────
  // The REAL adapter, with a recording `fetchImpl` and a delegating wrapper.
  // Nothing about the request, the transport, the SSE parsing or the error
  // classification is replaced — the wrapper only remembers what went past, so
  // §5 can price the run off the provider's own numbers and §2b/§4 can replay
  // genuine wire bytes instead of a hand-written fixture.
  const calls = [];      // {params, result} per adapter call
  const rawBodies = [];  // raw NON-STREAMING response text, exactly as received
  const recordingFetch = async (url, init) => {
    const res = await fetch(url, init);
    let isStream = false;
    try { isStream = JSON.parse(init.body).stream === true; } catch { /* not our body */ }
    // A streaming body is passed through UNTOUCHED: buffering it here would
    // destroy the very chunking §3 exists to measure.
    if (isStream || !res.ok) return res;
    const text = await res.text();
    rawBodies.push(text);
    return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  llm.__setOpenRouterAdapterFactory(({ apiKey }) => {
    const real = new OpenRouterAdapter({ apiKey, fetchImpl: recordingFetch });
    return {
      createChatCompletion: async (params) => {
        const result = await real.createChatCompletion(params);
        calls.push({ params, result });
        liveRequests++;
        if (result.usage && typeof result.usage.cost === 'number') reportedSpendUsd += result.usage.cost;
        return result;
      },
    };
  });

  // ── §1 TEXT MODE ─────────────────────────────────────────────────────────
  console.log('\n§1  Text mode — a tiny chat-shaped call\n');
  const usage1 = [];
  const answer1 = await llm.generateText(
    'You are a connectivity test. Reply with exactly the word OK.',
    'Reply now.', 16, 'text', null,
    { provider: 'openrouter', onUsage: (u) => usage1.push(u) },
  );
  assertTrue(typeof answer1 === 'string' && answer1.trim().length > 0,
    'a non-empty answer came back', `got ${JSON.stringify(answer1)}`);
  assertTrue(calls.length === 1, 'exactly one provider call was made', `made ${calls.length}`);

  const r1 = calls[0].result;
  // THE v3.13.2 RULE. `model` is read back off the response body — the id that
  // ANSWERED and is BILLED, never the id we asked for. Reporting the request
  // passes every refusal test and fails only the fallback walk, which is why it
  // has to be checked against a real router.
  assertTrue(r1.model === MODEL,
    `the response body names the model that answered, and it is the one requested (${MODEL})`,
    `body said ${JSON.stringify(r1.model)}`);
  assertTrue(usage1.length === 1 && usage1[0].provider === 'openrouter' && usage1[0].model === MODEL,
    'onUsage fired once and names the served model (this is what the app displays)',
    JSON.stringify(usage1));
  assertTrue(usage1[0].inputTokens > 0 && usage1[0].outputTokens > 0,
    `onUsage carries real token counts (${usage1[0]?.inputTokens} in / ${usage1[0]?.outputTokens} out)`);
  assertTrue(usage1[0].reasoningTokens === 0 && usage1[0].cachedReadTokens === 0,
    'the remaining normalised usage fields are present and zero on this model, not undefined',
    JSON.stringify(usage1[0]));
  assertTrue(r1.usage && typeof r1.usage.cost === 'number' && r1.usage.cost > 0,
    `the adapter surfaces OpenRouter's own billed cost ($${r1.usage?.cost})`,
    JSON.stringify(r1.usage));
  assertTrue(r1.finishReason === 'stop',
    `finishReason is a real value off the wire (${r1.finishReason})`);
  assertTrue(typeof r1.generationId === 'string' && r1.generationId.length > 0,
    'a generation id came back (the billing handle)');

  // ── §5a THE PRICE TABLE IS CHECKED AGAINST THE BILL ─────────────────────
  // The static table's own comment claims computed cost matched `usage.cost`
  // "to six decimal places". That claim is only ever true or false LIVE, and
  // nothing in the repository re-checked it after v3.15.0. Here it is, per call.
  const price = llm.getModelPrice(MODEL);
  assertTrue(price !== null && price.input > 0 && price.output > 0,
    `MODEL_PRICES_USD_PER_MTOK has an entry for ${MODEL} ($${price?.input}/$${price?.output} per 1M)`);
  const computed1 = (r1.usage.prompt_tokens / 1e6) * price.input
                  + (r1.usage.completion_tokens / 1e6) * price.output;
  assertTrue(Math.abs(computed1 - r1.usage.cost) < 1e-9,
    `the hand-typed price reproduces the provider's bill (computed ${computed1.toExponential(4)} vs reported ${r1.usage.cost.toExponential(4)})`,
    `difference ${Math.abs(computed1 - r1.usage.cost)}`);
  // ⚠ THE ABSOLUTE TOLERANCE ABOVE IS WEAK ON A 31-TOKEN CALL and is kept only
  // because it is the first thing a reader wants to see. A 31-token call is so
  // cheap that a 0.1% error in the table hides under 1e-9, so the assertion
  // that actually has teeth is §5's, which is RELATIVE and runs over every
  // billed call in the run — including the ~3,000-token ingest.

  // ── §2 JSON MODE — THE BUILD LANE, THROUGH THE REAL INGEST ──────────────
  console.log('\n§2  JSON mode — a real ingest into an isolated temp domain\n');
  const { createDomain } = await import('../src/brain/files.js');
  const { ingestFile } = await import('../src/brain/ingest.js');
  await createDomain('orlive', 'OpenRouter Live', 'Scratch domain for the OpenRouter live suite', 'tech');

  // Synthetic on purpose: a committed real article would make this suite's
  // assertions depend on a file somebody may edit, and a personal one is the
  // reason test-ingest-real-llm.js is LIVE_LOCAL. Everything below is invented.
  const SOURCE = `# The Ashby Kiln Project

The Ashby Kiln Project is a research programme run by the Meridian Institute in
Trondheim. It studies low-temperature ceramic sintering for structural building
components. The programme was founded in 2021 by Dr. Ingrid Solheim, a materials
scientist who had previously worked on geopolymer cements.

## Method

The core technique is called cold-phase vitrification. Rather than firing clay
at 1200 degrees, cold-phase vitrification uses an alkali activator and a
72-hour cure at 90 degrees. The result is a body with roughly 80 percent of the
compressive strength of fired brick at about 15 percent of the embodied energy.

The activator is a sodium silicate solution. Its ratio to the clay body is the
single most sensitive variable: below 0.28 the body crumbles, above 0.41 it
develops efflorescence within a year.

## Collaborators

The Meridian Institute works with Brannvik Tegl, a Norwegian brickworks, which
supplies the raw clay and runs the pilot kiln line. A second partner, the
Copenhagen firm Lyshus Arkitekter, has specified the material in two social
housing projects.

## Open problems

Freeze-thaw durability is unproven beyond four winters. Dr. Solheim has stated
that a ten-year field record is the threshold for building-code adoption in
Norway. A separate question is colour consistency: cold-phase bodies vary in
tone batch to batch, which Lyshus Arkitekter has treated as a design feature
rather than a defect.
`;
  const staged = path.join(DOMAINS_DIR, 'ashby-kiln.md');
  writeFileSync(staged, SOURCE);

  const callsBefore = calls.length;
  const ingestStarted = Date.now();
  const result = await ingestFile('orlive', staged, 'ashby-kiln.md', false, null);
  console.log(`  (ingest completed in ${((Date.now() - ingestStarted) / 1000).toFixed(1)}s)\n`);

  const jsonCalls = calls.slice(callsBefore);
  assertTrue(jsonCalls.length >= 1 && jsonCalls.every(c => c.params.responseFormat === 'json'),
    `every ingest call went out in JSON mode (${jsonCalls.length} call(s))`,
    JSON.stringify(jsonCalls.map(c => c.params.responseFormat)));
  assertTrue(jsonCalls.every(c => c.result.finishReason !== 'length'),
    'no ingest call was truncated at the output ceiling',
    JSON.stringify(jsonCalls.map(c => c.result.finishReason)));
  // The JSON PARSED is the real assertion, and pages on disk are the only
  // honest proof of it: `supported_parameters` says a model ACCEPTS JSON mode,
  // never that the JSON parses (the v3.15.0 finding).
  assertTrue(Array.isArray(result.pagesWritten) && result.pagesWritten.length > 0,
    `the structured response parsed and wrote ${result.pagesWritten?.length} page(s)`);
  assertTrue(Array.isArray(result.changes) && result.changes.every(c => typeof c.canonPath === 'string'),
    'every change record carries a canonical path');
  const wikiDir = path.join(DOMAINS_DIR, 'orlive', 'wiki');
  assertTrue(existsSync(path.join(wikiDir, 'index.md')) && existsSync(path.join(wikiDir, 'log.md')),
    'index.md and log.md exist in the isolated domain');
  const summaries = existsSync(path.join(wikiDir, 'summaries'))
    ? readdirSync(path.join(wikiDir, 'summaries')).filter(f => f.endsWith('.md')) : [];
  assertTrue(summaries.length === 1, `exactly one summary page was written (${summaries.join(', ')})`);
  assertTrue(readFileSync(path.join(wikiDir, 'summaries', summaries[0]), 'utf8').length > 0,
    'the summary page is non-empty on disk');

  // ── §2b THE EMPTY-CONTENT-STRING TRAP ───────────────────────────────────
  // v3.23.0: OpenRouter sends `content` PRESENT BUT EMPTY, and a completion
  // that finishes normally with no content at all is a real failure that must
  // never degrade into a silent empty answer written to a wiki page. The guard
  // lives in llm.js's callOpenRouter, NOT in the adapter — the adapter's job is
  // to report what arrived, and it correctly reports an empty string. Both
  // halves are asserted, so a future refactor that moves the refusal into the
  // adapter and drops it from llm.js still goes red here.
  //
  // Driven on the REAL body captured in §1, with exactly one field changed.
  console.log('\n§2b Empty-content trap — REPLAY of the §1 wire body, no network, no spend\n');
  assertTrue(rawBodies.length >= 1, 'a raw non-streaming response body was captured off the wire');
  const realBody = JSON.parse(rawBodies[0]);
  assertTrue(typeof realBody.choices?.[0]?.message?.content === 'string'
    && realBody.choices[0].message.content.length > 0,
    'the captured body really did carry non-empty content (the control for what follows)');

  const replayAdapterFor = (body) => new OpenRouterAdapter({
    // The repo's own already-allowlisted synthetic value (see
    // .githooks/secret-allowlist). Inventing a fresh key-shaped string here
    // would trip the pre-commit secret guard and earn a new allowlist entry for
    // nothing. It is never sent: `fetchImpl` below answers without a network.
    apiKey: 'sk-or-v1-fixture-not-a-real-key',
    fetchImpl: async () => new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  });

  const emptyBody = JSON.parse(rawBodies[0]);
  emptyBody.choices[0].message.content = '';
  emptyBody.choices[0].finish_reason = 'stop';   // a CLEAN finish — the trap's whole point

  // (a) the adapter itself reports the empty string rather than throwing…
  const adapterOnEmpty = await replayAdapterFor(emptyBody).createChatCompletion({
    model: MODEL, systemPrompt: 's', userPrompt: 'u', maxTokens: 16, responseFormat: 'text',
  });
  assertTrue(adapterOnEmpty.text === '' && adapterOnEmpty.finishReason === 'stop',
    'the adapter reports the empty content string faithfully (it does not invent text)',
    JSON.stringify(adapterOnEmpty.text));

  // (b) …and the app path REFUSES it.
  llm.__setOpenRouterAdapterFactory(() => replayAdapterFor(emptyBody));
  let emptyErr = null;
  try {
    await llm.generateText('s', 'u', 16, 'text', null, { provider: 'openrouter' });
  } catch (err) { emptyErr = err; }
  assertTrue(emptyErr !== null, 'generateText THREW rather than returning an empty answer');
  assertTrue(!!emptyErr && /returned an empty response/.test(emptyErr.message),
    'the refusal names the condition',
    emptyErr && emptyErr.message);
  assertTrue(!!emptyErr && /finish reason: stop/.test(emptyErr.message),
    'the refusal echoes the provider-supplied finish reason while it is inert',
    emptyErr && emptyErr.message);

  // CONTROL — the identical harness with the UNMODIFIED body must SUCCEED.
  // Without this, a replay adapter that threw on everything would look green.
  llm.__setOpenRouterAdapterFactory(() => replayAdapterFor(realBody));
  const replayedOk = await llm.generateText('s', 'u', 16, 'text', null, { provider: 'openrouter' });
  assertTrue(replayedOk === realBody.choices[0].message.content,
    'CONTROL: the same replay harness returns the real text when the body is unmodified',
    JSON.stringify(replayedOk));

  // Back to the live adapter for §3 and §4.
  llm.__setOpenRouterAdapterFactory(({ apiKey }) => {
    const real = new OpenRouterAdapter({ apiKey, fetchImpl: recordingFetch });
    return {
      createChatCompletion: async (params) => {
        const r = await real.createChatCompletion(params);
        calls.push({ params, result: r });
        liveRequests++;
        if (r.usage && typeof r.usage.cost === 'number') reportedSpendUsd += r.usage.cost;
        return r;
      },
    };
  });

  // ── §3 STREAMING ────────────────────────────────────────────────────────
  console.log('\n§3  Streaming — the real SSE path through generateText(opts.onDelta)\n');
  const deltas = [];
  const usage3 = [];
  const streamStarted = Date.now();
  const streamed = await llm.generateText(
    'You are a test. Answer in three short sentences, one per line.',
    'Name three primary colours, one per sentence.',
    200, 'text', null,
    { provider: 'openrouter', onDelta: (d) => deltas.push({ ...d, at: Date.now() - streamStarted }), onUsage: (u) => usage3.push(u) },
  );
  const contentDeltas = deltas.filter(d => d.type === 'content');
  const reasoningDeltas = deltas.filter(d => d.type === 'reasoning');
  console.log(`  (${deltas.length} delta(s) in ${Date.now() - streamStarted}ms; first at ${deltas[0]?.at}ms)\n`);

  const streamCall = calls[calls.length - 1];
  assertTrue(streamCall.params.stream === true,
    'llm.js asked the adapter to stream (the request really was `stream: true`)');
  assertTrue(contentDeltas.length > 1,
    `the answer arrived in more than one chunk (${contentDeltas.length} content deltas)`,
    `only ${contentDeltas.length} — a single-chunk answer proves nothing about streaming`);
  // THE AUTHORITATIVE-RETURN RULE (v3.23.0): the return value is complete and
  // the deltas are a preview OF IT. A consumer replaces its draft with the
  // return value, so if these two ever disagree every streamed answer is wrong.
  assertTrue(contentDeltas.map(d => d.text).join('') === streamed,
    'the concatenated content deltas are byte-identical to the authoritative return value');
  assertTrue(deltas.every(d => d.type === 'content' || d.type === 'reasoning'),
    'every delta carries one of exactly two normalised types');
  assertTrue(deltas.every(d => typeof d.text === 'string' && d.text.length > 0),
    'no empty delta was emitted (the ~110-empty-frames trap on the reasoning phase)');
  // `ibm-granite/granite-4.0-h-micro` is measured `thinks: false`. The v3.23.0
  // rule is that an absent thinking region is reported as ABSENT and never
  // invented, so the assertion is the ABSENCE — and it is anchored to the
  // catalogue entry so a future model swap makes this section change on purpose.
  const spec = llm.listOfferableModels('openrouter').find(m => m.id === MODEL);
  assertTrue(spec && spec.thinks === false,
    `the catalogue records ${MODEL} as a non-reasoning model (thinks: false)`);
  assertTrue(reasoningDeltas.length === 0,
    'no reasoning delta was invented for a model measured not to think',
    `got ${reasoningDeltas.length}`);
  assertTrue(usage3.length === 1 && usage3[0].reasoningTokens === 0,
    'the streamed call reports zero reasoning tokens, not a missing field',
    JSON.stringify(usage3));
  // Usage on the streaming path rides the final chunk; nothing extra is
  // requested for it. If it ever stopped arriving, every streamed answer would
  // silently become unpriceable.
  assertTrue(usage3[0].inputTokens > 0 && usage3[0].outputTokens > 0,
    `usage survived the SSE reassembly (${usage3[0]?.inputTokens} in / ${usage3[0]?.outputTokens} out)`);
  assertTrue(streamCall.result.model === MODEL,
    'the streamed body names the served model, exactly as the non-streaming one does',
    JSON.stringify(streamCall.result.model));

  // ── §4 REFUSAL ──────────────────────────────────────────────────────────
  console.log('\n§4  Refusal — a model id that does not exist\n');
  const BOGUS = 'curator-nonexistent/model-does-not-exist-zzz';
  // Sent through the adapter DIRECTLY and never through generateText: the
  // allow-list in applyModelOverride would silently substitute the provider
  // default, so `generateText(…, {model: BOGUS})` would answer normally and
  // bill for a model this section is not testing.
  let refusal = null;
  liveRequests++;   // counted here because this one bypasses the recording factory
  try {
    await new OpenRouterAdapter({ apiKey: KEY }).createChatCompletion({
      model: BOGUS, systemPrompt: 'x', userPrompt: 'y', maxTokens: 8, responseFormat: 'text',
    });
  } catch (err) { refusal = err; }
  assertTrue(refusal instanceof OpenRouterError,
    'the failure is a typed OpenRouterError, not a raw SDK/undici throw',
    refusal && `${refusal.name}: ${refusal.message}`);
  assertTrue(!!refusal && typeof refusal.code === 'string' && refusal.code.startsWith('OPENROUTER_'),
    `it carries a stable classification tag (${refusal && refusal.code})`);
  // MEASURED 2026-09-02, and it contradicts the obvious expectation: a bogus
  // model id is HTTP 400 ("… is not a valid model ID"), NOT 404. v3.15.1
  // recorded the same thing from the other direction — the 404 space is
  // narrower than assumed. The assertion admits either, because which one it is
  // is the provider's choice; what must hold is that it is classified.
  assertTrue(!!refusal && [400, 404].includes(refusal.status),
    `the HTTP status came back structurally (${refusal && refusal.status})`);
  assertTrue(!!refusal && !/\n/.test(refusal.message) && refusal.message.startsWith('OpenRouter '),
    'the message is one composed line, not a stack trace',
    refusal && JSON.stringify(refusal.message.slice(0, 160)));
  // Redaction is the adapter's headline security claim and it is only ever
  // testable against a message built from a real response.
  assertTrue(!!refusal && !refusal.message.includes(KEY) && !/sk-or-v1-/.test(refusal.message),
    'no key bytes appear anywhere in the surfaced message');

  // Does the app WALK THE FALLBACK CHAIN on this? Answering that needs the
  // error to travel through llm.js's ladder, which cannot be done with a bogus
  // id (see above). So the REAL error is replayed through a counting adapter:
  // the classification is the provider's, the decision is llm.js's, and the
  // count is the answer. A walk here would bill up to four more paid calls on a
  // model the user did not choose — the v3.15.1 money defect.
  //
  // ⚠ LLM_MODEL IS REMOVED FIRST, AND THAT IS LOAD-BEARING RATHER THAN TIDY.
  // With it set, the primary model IS `FALLBACK_CHAINS.openrouter`'s only rung,
  // so callLLM dedupes the two and a WALK would also make exactly one attempt —
  // the assertion below would be true no matter what llm.js decided, i.e. an
  // assertion that could not fail. Dropping it resolves the primary to
  // `upstage/solar-pro4`, leaving the granite rung distinct, so a walk is
  // observable as a second attempt. The §4b control proves it actually is.
  delete process.env.LLM_MODEL;
  const chainLength = llm.__testing.FALLBACK_CHAINS.openrouter.length;
  assertTrue(llm.getProviderInfo().model !== llm.__testing.FALLBACK_CHAINS.openrouter[0]
    && chainLength >= 1,
    'the primary and the fallback rung are now DIFFERENT models, so a chain walk would be visible',
    `primary=${llm.getProviderInfo().model} chain=${JSON.stringify(llm.__testing.FALLBACK_CHAINS.openrouter)}`);

  const countingFactory = (errToThrow, counter) => () => ({
    createChatCompletion: async () => { counter.n++; throw errToThrow; },
  });

  const refusalCount = { n: 0 };
  llm.__setOpenRouterAdapterFactory(countingFactory(refusal, refusalCount));
  let laddered = null;
  try {
    await llm.generateText('s', 'u', 16, 'text', null, { provider: 'openrouter' });
  } catch (err) { laddered = err; }
  assertTrue(laddered !== null, 'generateText surfaced the refusal instead of returning text');
  assertTrue(refusalCount.n === 1,
    'the refusal was NOT retried and did NOT walk the fallback chain (exactly one attempt)',
    `made ${refusalCount.n} attempts — a walk would bill paid rungs the user never chose`);
  assertTrue(!!laddered && typeof laddered.message === 'string' && laddered.message.length > 0
    && !laddered.message.includes(KEY),
    'the surfaced error is a message, carries no key, and reaches the caller intact');

  // ── §4b THE CONTROL FOR §4 ──────────────────────────────────────────────
  // A counter that can only ever report 1 proves nothing. This drives the SAME
  // harness with a synthetic MODEL-RETIRED error — the one 404 shape v3.15.1
  // decided is still allowed to walk — and requires the walk to be observed.
  // Synthetic on purpose: nothing can make OpenRouter retire a model to order,
  // and this control is about the counter, not about the provider.
  console.log('\n§4b Control — the walk detector can actually see a walk\n');
  const retired = new OpenRouterError(
    'OPENROUTER_MODEL_NOT_FOUND',
    'OpenRouter chat/completions → HTTP 404: model not found',
    404,
  );
  const retiredCount = { n: 0 };
  llm.__setOpenRouterAdapterFactory(countingFactory(retired, retiredCount));
  try {
    await llm.generateText('s', 'u', 16, 'text', null, { provider: 'openrouter' });
  } catch { /* every rung throws — the count is the measurement */ }
  assertTrue(retiredCount.n === 1 + chainLength,
    `a model-retired 404 DOES walk the chain (${retiredCount.n} attempts = primary + ${chainLength} rung(s)) — so §4's count of 1 is a measurement, not a constant`,
    `got ${retiredCount.n}, expected ${1 + chainLength}`);
  process.env.LLM_MODEL = MODEL;

  // ── §5 MONEY ────────────────────────────────────────────────────────────
  console.log('\n§5  Money\n');
  // The pinned default is asserted as a FACT without being billed — see the
  // header for why this suite runs on the cheapest rung instead.
  assertTrue(llm.getDefaultModel !== undefined
    && llm.__testing.DEFAULTS.openrouter === 'upstage/solar-pro4',
    'DEFAULTS.openrouter is still the pinned upstage/solar-pro4 (asserted, not called)',
    llm.__testing.DEFAULTS.openrouter);
  assertTrue(llm.isBuildLaneModel('openrouter', MODEL),
    `${MODEL} is build-lane eligible — this suite never touches an unmeasured model`);
  assertTrue(llm.getModelPrice(MODEL) !== null,
    `${MODEL} has a MODEL_PRICES_USD_PER_MTOK entry (the offline invariant, re-checked here)`);

  // ── THE PRICE TABLE AGAINST THE BILL, ON EVERY BILLED CALL ──────────────
  // RELATIVE, not absolute: on the 31-token call in §1 a 0.1% error in the
  // table is worth 7e-10 and would slide under any absolute floor loose enough
  // to survive float noise. A relative bound is the same strength at every
  // call size, and 1e-4 is chosen against the failure it must catch — the two
  // candidates v3.15.0 REJECTED were out by 64% and by 44%, and a mis-typed
  // rate is off by a factor, never by a rounding step. It is deliberately not
  // tighter than the ~9 significant figures OpenRouter reports.
  const relDiff = (u, p) => {
    const computed = (u.prompt_tokens / 1e6) * p.input + (u.completion_tokens / 1e6) * p.output;
    return { computed, rel: Math.abs(computed - u.cost) / u.cost };
  };
  let maxRelDiff = 0;
  let worst = null;
  let biggestCallTokens = 0;
  let checked = 0;
  for (const c of calls) {
    const u = c.result.usage;
    if (!u || typeof u.cost !== 'number' || u.cost <= 0) continue;
    const p = llm.getModelPrice(c.result.model || MODEL);
    if (!p) continue;
    checked++;
    biggestCallTokens = Math.max(biggestCallTokens, u.prompt_tokens + u.completion_tokens);
    const { computed, rel } = relDiff(u, p);
    if (rel > maxRelDiff) { maxRelDiff = rel; worst = { computed, reported: u.cost, u }; }
  }
  assertTrue(checked === calls.length && checked > 0,
    `every billed call was price-checked (${checked} of ${calls.length}), the largest at ${biggestCallTokens} tokens`,
    `checked ${checked} of ${calls.length}`);
  assertTrue(maxRelDiff < 1e-4,
    `the hand-typed rate reproduces OpenRouter's own bill on every billed call ` +
    `(worst relative difference ${maxRelDiff.toExponential(3)})`,
    worst ? `computed ${worst.computed} vs reported ${worst.reported}` : 'no call to check');
  // CONTROL — the bound is not something every number passes. Recomputed from
  // the SAME real usage with the input rate nudged 1%, which is an order of
  // magnitude smaller than any real mis-pricing this check exists to catch (the
  // two candidates v3.15.0 rejected billed 1.64x and 0.57x their headline).
  const nudged = relDiff(worst.u, { input: price.input * 1.01, output: price.output });
  assertTrue(nudged.rel >= 1e-4,
    `CONTROL: a 1% error in the input rate WOULD breach the bound (${nudged.rel.toExponential(3)}) — the check can fail`,
    `a 1% error scored ${nudged.rel.toExponential(3)}, under the 1e-4 bound: this assertion is vacuous`);
  assertTrue(reportedSpendUsd > 0,
    `the provider reported a non-zero bill for this run ($${reportedSpendUsd.toFixed(8)})`);
  assertTrue(reportedSpendUsd < 0.01,
    `the whole run stayed under one cent ($${reportedSpendUsd.toFixed(8)})`,
    `spent $${reportedSpendUsd.toFixed(6)} — a live gate must not become an expense`);
  assertTrue(liveRequests <= 5,
    `at most five requests reached openrouter.ai (${liveRequests}: ${calls.length} billed + ${liveRequests - calls.length} refused)`,
    `made ${liveRequests}`);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Live requests: ${liveRequests}  (${calls.length} billed, ${liveRequests - calls.length} refused before billing)`);
  console.log(`  TOTAL SPEND:  $${reportedSpendUsd.toFixed(8)}  (reported by OpenRouter, not estimated)`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.label}`);
      if (f.detail) console.log(`      ${f.detail}`);
    }
  }
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  // The raw message is printed VERBATIM so ci-flake.js can see a transient
  // marker ("429", "fetch failed", "ETIMEDOUT", …) and the runner reports this
  // inconclusive rather than red. `code`/`status` are printed beside it because
  // a 502/503 from this adapter deliberately carries no transient token — see
  // the header.
  console.log(`\n  ✗ FATAL — the suite could not complete`);
  console.log(`    └─ ${err && err.message}`);
  if (err && err.code) console.log(`       code=${err.code}`);
  if (err && err.status !== undefined) console.log(`       status=${err.status}`);
  if (err && err.stack) console.error(err.stack);
  console.log(`\nPassed: ${passed}   Failed: ${failed + 1}`);
  console.log(`TOTAL SPEND: $${reportedSpendUsd.toFixed(8)}`);
  cleanup();
  process.exit(1);
}
