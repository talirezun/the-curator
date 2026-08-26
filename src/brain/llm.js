/**
 * LLM abstraction layer — supports Anthropic Claude and Google Gemini.
 *
 * Provider selection (automatic):
 *   1. .curator-config.json keys (set via Settings UI)
 *   2. .env file keys (developer fallback)
 *   Gemini takes priority if both providers have keys.
 *
 * Optional override:
 *   LLM_MODEL=<model-id>   override the default model for whichever provider is active
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getEffectiveKey, getActiveProvider } from './config.js';

// DELIBERATELY UNCHANGED in the 2026-08-24 chain repair. Both ids were probed
// live that day and both remain the CHEAPEST working model on their provider
// (gemini-2.5-flash-lite $0.10/$0.40; claude-haiku-4-5 $1/$5 — every live
// alternative on each provider costs strictly more). Project policy is explicit
// that the fallback chain is INSURANCE, not a migration: repairing dead rungs
// must never quietly move users onto a newer or costlier default. Bump these
// only when the pinned model is actually retired, or on a deliberate, separately
// justified cost/quality decision.
const DEFAULTS = {
  gemini:    'gemini-2.5-flash-lite',
  // Haiku is the low-cost tier, matching the cost profile of
  // gemini-2.5-flash-lite. See docs/model-lifecycle.md for rationale.
  //
  // ⚠ JSON FENCING (measured 2026-08-26 with the real buildOutlinePrompt via
  // ingest.js's __testing export): claude-haiku-4-5 wraps its ingest-outline
  // response in ```json fences 3/3 live runs, so raw JSON.parse fails 3/3 and
  // every ingest on this default depends on parseJSON's jsonrepair fallback to
  // strip the fence. claude-sonnet-4-5 and claude-opus-4-5 showed the same 3/3
  // fenced behaviour; everything 4.6-and-later (claude-sonnet-4-6,
  // claude-sonnet-5) returned bare JSON and parsed raw 3/3. This is benign
  // today — parseJSON is deliberately lenient for exactly this reason — but it
  // means the fence-stripping path is not a rare edge case on Anthropic, it is
  // the normal case for the pinned default. Do not "simplify" parseJSON to a
  // bare JSON.parse without re-measuring this.
  anthropic: 'claude-haiku-4-5',
};

/**
 * CONSERVATIVE default output cap for an Anthropic model we do not recognise.
 *
 * Our ingest/compile call sites request 65536 (correct for Gemini 2.5 Flash,
 * which allows it) and the Anthropic API rejects anything above the model's own
 * ceiling with "max_tokens: N > <cap>" — so the Anthropic branch clamps.
 * Anthropic is the ONLY provider clamped; Gemini keeps the full 65536.
 *
 * The value 64000 is the cap of the Curator's Anthropic default
 * (claude-haiku-4-5) and is deliberately the FALLBACK for any id absent from
 * the table below. The asymmetry is the whole point: guessing HIGH produces a
 * hard 400 that fails the call outright, while guessing LOW merely truncates —
 * and truncation already degrades gracefully (handleOutputTokenLimit returns a
 * partial answer in text mode, and ingest/compile have fallback ladders in JSON
 * mode). An unknown model must therefore resolve to this, never to 128000.
 *
 * The symbol keeps its original name, value and meaning so every existing
 * consumer is unaffected; per-model caps are read via anthropicMaxOutputTokens().
 */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 64000;

/**
 * Per-model output ceilings, keyed by EXACT model id.
 *
 * Scope mirrors MODEL_PRICES_USD_PER_MTOK: DEFAULTS.anthropic, every rung of
 * FALLBACK_CHAINS.anthropic, every entry of OFFERABLE_MODELS.anthropic, plus the
 * dated snapshot each alias resolves to (a user can pin one through the
 * LLM_MODEL dev override). `defineOfferableModel` REFUSES to build an entry for
 * an id absent from this map, so "offerable but uncapped" is unrepresentable.
 *
 * A flat 64000 constant was correct while Haiku was the only Anthropic model the
 * app could ever run. It is NOT correct now that the fallback chain lands on
 * Sonnet: claude-sonnet-5 and claude-sonnet-4-6 both allow 128,000, so a flat
 * clamp silently halved their real ceiling. Verified 2026-08-24 against the live
 * API — both `GET /v1/models/{id}`.max_tokens and the API's own validation error
 * ("max_tokens: 999999 > 128000") agree, and a 128000 request through the app's
 * exact messages.stream() shape was accepted.
 *
 * NOTE the ceiling is NOT monotonic with recency: claude-sonnet-4-5 is newer than
 * Haiku 3.5 yet caps at 64,000 like Haiku 4.5, while the older-numbered
 * claude-sonnet-4-6 allows 128,000. Do not infer a cap from a family or version
 * word — look it up, exactly as the price table exists for the same reason.
 */
const ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS = {
  'claude-haiku-4-5':           64000,   // current default
  'claude-haiku-4-5-20251001':  64000,   // dated snapshot the alias resolves to
  'claude-sonnet-5':           128000,   // fallback rung 1
  'claude-sonnet-4-6':         128000,   // fallback rung 2
  'claude-sonnet-4-5':          64000,   // fallback rung 3 — NOT 128k, despite being Sonnet
  'claude-sonnet-4-5-20250929': 64000,   // dated snapshot the alias resolves to
  // Offerable-only ids (never reached by the fallback chain, pickable by a user).
  // The pattern here is GENERATIONAL, not chronological: everything in the "4.5
  // generation" caps at 64,000 and everything 4.6-and-later at 128,000 — which is
  // why claude-opus-4-5 sits at 64,000 while the numerically-adjacent
  // claude-opus-4-8 doubles it. Verified against the provider's published caps
  // 2026-08-26. Still keyed EXACTLY, never derived from the version word: the
  // moment a cap is inferred from a family name it is a heuristic, and this repo
  // has already been bitten twice by exactly that (the price-tier heuristic below,
  // and the pre-2026-08-24 flat 64000 clamp that silently halved Sonnet's ceiling).
  'claude-opus-5':             128000,
  'claude-opus-4-8':           128000,
  'claude-opus-4-5':            64000,   // NOT 128k — the 4.5 generation caps low
};
Object.freeze(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS);

/**
 * Per-model output ceilings for Gemini.
 *
 * ⚠ READ THIS BEFORE WIRING IT INTO callProvider: it is DECLARATIVE DATA for the
 * offerable-model catalogue only, and is deliberately NOT used to clamp a Gemini
 * request. Gemini CLAMPS an over-large `maxOutputTokens` server-side rather than
 * rejecting it (the Anthropic API returns a hard 400 — "max_tokens: 65536 >
 * 64000" — which is the entire reason the Anthropic clamp exists). Adding a
 * client-side Gemini clamp would be a behaviour change with no failure to fix,
 * so this map exists so the UI can TELL a user what ceiling a model has, and for
 * nothing else.
 *
 * Every Flash-line model probed on 2026-08-26 reported the same 65,536 ceiling.
 * The map is still per-id rather than one shared constant for the same reason
 * the Anthropic map is: the day a Gemini model ships with a different ceiling,
 * a constant would be silently wrong for it while a missing key makes
 * `defineOfferableModel` refuse the model outright.
 */
const GEMINI_MODEL_MAX_OUTPUT_TOKENS = {
  'gemini-2.5-flash-lite': 65536,   // current default
  'gemini-3.1-flash-lite': 65536,
  'gemini-3.5-flash-lite': 65536,
  'gemini-2.5-flash':      65536,
  'gemini-3.7-flash':      65536,
  'gemini-3.6-flash':      65536,
  'gemini-3.5-flash':      65536,
};
Object.freeze(GEMINI_MODEL_MAX_OUTPUT_TOKENS);

/**
 * The output ceiling to clamp to for a given Anthropic model id.
 *
 * Unknown / non-string / prototype-key input returns ANTHROPIC_MAX_OUTPUT_TOKENS
 * — the CONSERVATIVE value. `Object.hasOwn` rather than a truthiness check so
 * `'__proto__'` and `'constructor'` cannot resolve through the plain object and
 * yield a bogus ceiling (the v3.0.9 normalizeResponseStyle bug shape).
 */
export function anthropicMaxOutputTokens(modelId) {
  if (typeof modelId !== 'string') return ANTHROPIC_MAX_OUTPUT_TOKENS;
  return Object.hasOwn(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS, modelId)
    ? ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS[modelId]
    : ANTHROPIC_MAX_OUTPUT_TOKENS;
}

/**
 * Model-lifecycle safety net.
 *
 * When a provider retires the pinned default (e.g., Google removes
 * `gemini-2.5-flash-lite` in a future release), we don't want end-user
 * installations to break before the next Curator update lands. On a
 * model-not-found error, we try a small ordered chain of next-best models.
 * Successful fallback is logged and exposed via getFallbackStatus() so the
 * Settings UI can prompt the user to update.
 *
 * Order: FORWARD IN TIME, cheapest-first. A chain exists because the primary
 * was RETIRED, so escalating backwards to an older generation is the wrong
 * direction — an older model is more likely to be retired than the one that
 * just replaced it. Each rung is therefore the closest-priced live successor
 * first, then progressively pricier ones, so a user whose default disappears
 * lands on the cheapest still-working model rather than on one that is also
 * dead. Note "closest-priced" is not "same-priced": every Gemini rung costs
 * MORE than the default, which is why getFallbackStatus() reports a costTier.
 *
 * Rate-limit (429) and service-unavailable (503) errors DO NOT trigger
 * fallback — those are handled by the existing retry loop.
 */
const FALLBACK_CHAINS = {
  // Verified against the live Gemini API (2026-08-22) with the Curator's exact
  // call shape (JSON mode + maxOutputTokens: 65536). The previous chain's
  // `gemini-1.5-flash` and `gemini-1.5-flash-latest` rungs both 404 — two of
  // three rungs were already dead — and have been removed.
  //
  // ⚠ `gemini-3.5-flash-lite` was REMOVED here on 2026-08-26 — not a reorder,
  // a deletion, so the chain stays cheapest-first ($0.25 → $0.30). It is
  // STRICTLY DOMINATED by `gemini-2.5-flash`, the rung that now follows it
  // directly: identical price ($0.30/$2.50 on both), but measurably worse on
  // both axes that matter for a fallback rung. Measured live against this
  // repo's REAL buildOutlinePrompt (src/brain/ingest.js __testing export, not
  // a toy prompt) over 9 runs each:
  //   - JSON reliability: 2 of 9 runs produced JSON that neither JSON.parse
  //     NOR jsonrepair can fix (a dropped object key —
  //     `{ "concepts/knowledge-graph.md", "summary": "..." }` — unrecoverable
  //     because repair would have to invent the "path": key). finishReason
  //     was STOP both times, i.e. NOT truncation — a genuine generation
  //     defect, not a budget problem `isOutputTokenLimit` could route around.
  //     3.1-flash-lite and 2.5-flash were 3/3 and 3/3 clean on the same probe.
  //   - Outline coverage on an identical source: 3.1-flash-lite planned 5-12
  //     pages, 2.5-flash planned 17-19 pages, and 3.5-flash-lite sat in
  //     between at 12-16 — so it does not even fill a coverage gap between
  //     its neighbours.
  // In production this rung fired ingest's Phase-1 stricter-retry ladder on
  // ~22% of the runs that reached it — silent extra latency and cost on a
  // rung that was never the cheapest option available at its price point.
  // Do NOT re-add it without re-measuring live with the real ingest prompt —
  // a toy "return this JSON" probe will not reproduce the failure (see the
  // Anthropic thinking-block lesson in docs/model-lifecycle.md for why prompt
  // realism matters when probing a fallback rung).
  gemini: [
    'gemini-3.1-flash-lite',        // closest live successor — verified drop-in, but 2.5x in / 3.75x out
    // ⚠ THINKING TOKENS: gemini-2.5-flash spends hidden reasoning tokens out of
    // the SAME maxOutputTokens budget, and they are billed as output. Probed
    // 2026-08-24: at maxOutputTokens 30 it returned finishReason MAX_TOKENS with
    // ZERO visible tokens and 26 thoughtsTokenCount — the entire budget consumed
    // before a single character of answer; at 64 it produced 2 visible against 58
    // thoughts. The flash-lite rung and the default showed 0-2 thought tokens on
    // the same prompts, so this rung alone behaves differently. Nothing here
    // compensates for it (a budget nudge would be guesswork), but a caller
    // debugging "MAX_TOKENS with an empty response on the last fallback rung"
    // should know the budget is shared, not reserved for visible output.
    'gemini-2.5-flash',             // higher (costlier) tier — last resort
  ],
  // Repaired 2026-08-24. FOUR of the five previous rungs were dead — probed with
  // the Curator's exact call shape (messages.stream().finalMessage()), all four
  // returned 404 not_found_error, and none appear in GET /v1/models:
  //   claude-3-5-haiku-latest · claude-3-5-haiku-20241022
  //   claude-3-7-sonnet-latest · claude-3-5-sonnet-latest
  // This is the v3.0.15 Gemini bug repeating on the Anthropic side. It failed
  // SAFE (404 → skip → land on Sonnet 4.5) but not CHEAP: the chain's documented
  // promise is the cheapest still-working model, and it was delivering the
  // priciest of the three live options at 3x the default.
  //
  // There is NO cheaper live Haiku — the entire 3.5 family is retired and 4.5 is
  // the default itself — so the chain must jump straight to Sonnet. Ordered
  // cheapest-first among models verified alive today; 4.6 and 4.5 tie on price,
  // and the forward-in-time rule breaks the tie toward 4.6 (which also carries
  // the larger 128k output ceiling).
  anthropic: [
    'claude-sonnet-5',              // $2/$10 — cheapest live non-Haiku AND the newest
    'claude-sonnet-4-6',            // $3/$15 — tie on price with 4.5, newer, 128k output
    'claude-sonnet-4-5',            // $3/$15 — oldest live rung, 64k output
  ],
};

/**
 * Published API prices, USD per 1M tokens, keyed by EXACT model id.
 *
 * ⚠ THESE ARE STANDARD PRICES. Where a model is currently on a promotional rate
 * the STANDARD (post-promotional) number lives here and the discount lives in
 * PROMOTIONAL_PRICES below, resolved by date. Never write a promotional price
 * into this table — see the long note on PROMOTIONAL_PRICES for why.
 *
 * Scope is the ids this app can actually run — DEFAULTS, every rung of
 * FALLBACK_CHAINS, and every entry of OFFERABLE_MODELS (the models a user may
 * pick for themselves). Those are ids WE choose and change
 * deliberately, so staleness is bounded by our own release process (see the
 * release checklist in docs/model-lifecycle.md: adding a rung means adding its
 * price here). Symmetrically, REMOVING a rung means removing its price entry
 * too — the offline invariant in test-chat-model.js §5 asserts this table has
 * no entries beyond the ids currently shipped, precisely so a dead-weight
 * price for a model we no longer run can't linger unnoticed (see the
 * `gemini-3.5-flash-lite` removal below).
 *
 * This replaced a family-name heuristic (flash-lite/flash, haiku/sonnet) that
 * looked reasonable and was structurally wrong: the family word is stable
 * ACROSS generations while the price is not. It scored
 * gemini-2.5-flash-lite → gemini-3.1-flash-lite as "same tier" when that
 * successor is 2.5x the input and 3.75x the output price — i.e. it stayed
 * silent on the exact rung the chain reaches FIRST. Only an exact-id table can
 * see a within-family price change.
 *
 * ⚠ THESE NUMBERS ARE NOW USER-VISIBLE. Until the multi-model work they fed only
 * the fallback banner's costlier/similar/unknown ordering, so a stale absolute
 * value was harmless. They now surface through OFFERABLE_MODELS into a picker
 * whose entire purpose is showing a user what a model costs BEFORE they choose
 * it, so an absolute value being right matters as much as the ordering does.
 *
 * Verified 2026-08-26 against ai.google.dev/gemini-api/docs/pricing and
 * platform.claude.com/docs/en/about-claude/pricing (standard tier, text) — the
 * LIVE pages, never a cached table. That is a standing rule, not a formality:
 * a cached copy asserting a scheduled Sonnet 5 price RISE that had in fact been
 * cancelled would have inverted the Anthropic chain's cost ordering a week after
 * shipping, silently (see the claude-sonnet-5 note below).
 */
const MODEL_PRICES_USD_PER_MTOK = {
  // ── Gemini ──
  'gemini-2.5-flash-lite':     { input: 0.10, output: 0.40 },   // current default
  'gemini-3.1-flash-lite':     { input: 0.25, output: 1.50 },   // 2.5x in / 3.75x out vs default
  'gemini-2.5-flash':          { input: 0.30, output: 2.50 },
  // gemini-3.5-flash-lite is priced again as of 2026-08-26 — NOT a reversal of
  // its removal from FALLBACK_CHAINS, which stands. It is priced because it is
  // OFFERABLE (a user may pick it deliberately, with its measured JSON defect
  // shown) while remaining banned from the chain (which picks FOR the user).
  // Those are two different lists with two different rules; see DOMINATED_MODELS.
  'gemini-3.5-flash-lite':     { input: 0.30, output: 2.50 },
  // ⚠ PROMOTIONAL — the numbers here are the STANDARD prices that take effect
  // 2027-01-01. Both models bill at $0.75/$3.75 through 2026-12-31; that
  // discount lives in PROMOTIONAL_PRICES and getModelPrice() switches over on
  // the date by itself.
  'gemini-3.7-flash':          { input: 1.50, output: 7.50 },
  'gemini-3.6-flash':          { input: 1.50, output: 7.50 },
  'gemini-3.5-flash':          { input: 1.50, output: 9.00 },
  // ── Anthropic ── (re-verified 2026-08-24; the four retired 3.x rungs and their
  // prices were removed together with the dead chain entries)
  'claude-haiku-4-5':          { input: 1.00, output: 5.00 },   // current default
  // ⚠ Sonnet 5 is CHEAPER than both Sonnet 4.6 and Sonnet 4.5 despite being the
  // newest of the three — a within-family price DROP, the mirror image of the
  // Gemini flash-lite rise above, and the second independent proof that only an
  // exact-id table can be trusted here.
  //
  // Read the source carefully before touching this number: $2/$10 launched in
  // June 2026 labelled INTRODUCTORY through 2026-08-31, and a cached copy of the
  // pricing table still carries that wording. Anthropic announced on 2026-08-10
  // that it is now the standard price and the scheduled 2026-09-01 rise to
  // $3/$15 will NOT occur — confirmed against the live pricing page. Had the
  // introductory framing been current, hard-coding $2/$10 would have inverted
  // this chain's cost ordering one week later.
  'claude-sonnet-5':           { input: 2.00, output: 10.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-sonnet-4-5':         { input: 3.00, output: 15.00 },
  // Offerable-only (never a fallback rung). ⚠ The headline $5 UNDERSTATES what
  // these cost against a Haiku baseline for two of the three: claude-opus-5 and
  // claude-opus-4-8 use a newer tokenizer measured at 1.329x more input tokens
  // on real Curator prose, so $5/1M is really ~$6.65/1M of the same text. That
  // multiplier is carried per-model as `tokenizerFactor` on the OFFERABLE_MODELS
  // entry rather than folded into the price here, because it is a property of
  // the TEXT-to-token conversion, not of the published rate — folding it in
  // would make this table disagree with the provider's own invoice.
  'claude-opus-5':             { input: 5.00, output: 25.00 },
  'claude-opus-4-8':           { input: 5.00, output: 25.00 },
  'claude-opus-4-5':           { input: 5.00, output: 25.00 },
};

// Frozen at definition: this table is exported through `__testing` for the
// offline price-coverage invariant, and a test that mutated it would corrupt
// every later cost comparison in the same process. Entries are frozen too, so
// `MODEL_PRICES_USD_PER_MTOK['x'].input = 0` is a no-op rather than a silent
// cross-test leak.
for (const price of Object.values(MODEL_PRICES_USD_PER_MTOK)) Object.freeze(price);
Object.freeze(MODEL_PRICES_USD_PER_MTOK);

/**
 * Time-limited promotional prices, keyed by EXACT model id.
 *
 * WHY THIS EXISTS AS A MECHANISM RATHER THAN A COMMENT. `gemini-3.6-flash` and
 * `gemini-3.7-flash` bill at $0.75/$3.75 through 2026-12-31 and DOUBLE to
 * $1.50/$7.50 on 2027-01-01. There were three ways to handle that and only one
 * of them is safe:
 *
 *   • Hard-code $0.75/$3.75 as if permanent. REJECTED. This is v3.6.0's recorded
 *     near-miss in the opposite direction — there, a cached table claimed a
 *     Sonnet 5 price RISE that had actually been cancelled, and trusting it would
 *     have inverted the fallback chain's cost ordering one week after shipping,
 *     silently. A promotional number frozen into the standard table is the same
 *     failure with the clock running the other way: on 2027-01-01 the picker
 *     would quote every user HALF of what they are actually billed, on the one
 *     surface whose entire job is cost honesty, and no ordering assertion would
 *     notice (the array order happens to survive the doubling, so a
 *     cheapest-first test stays green over a wrong number — this project's named
 *     "green over a wrong number" shape).
 *   • Don't offer the two models at all. REJECTED as over-correction: they are
 *     the modern non-lite Flash tier at a genuinely good rate today, and
 *     excluding them for four months only to add them back later trades a real
 *     capability for a problem that is nine lines of code to solve properly.
 *   • Resolve by DATE, and state the expiry in the record. CHOSEN, and both
 *     halves are load-bearing: the date resolution means nobody has to remember
 *     to ship a release on New Year's Day, and the stated expiry means a human
 *     reading the entry cannot mistake $0.75 for a stable price.
 *
 * FAIL-SAFE DIRECTION. The standard (HIGHER) price is the one in
 * MODEL_PRICES_USD_PER_MTOK, and a promotion is a narrowing exception applied on
 * top. So every way this can break — a wrong system clock, this table being
 * dropped, an id typo'd here — degrades to quoting the HIGHER price. That is
 * deliberate and matches the direction this repo already takes on money
 * (v3.9.0: an unrecognised cost tier resolves to 'unknown', never 'similar',
 * "because the fail-safe direction on money is to warn"). A user who is quoted
 * more than they are billed picks a cheaper model than they needed; a user
 * quoted less than they are billed was lied to.
 *
 * `untilMs` is INCLUSIVE and pinned to UTC. A promotion is a published calendar
 * fact, not a local-time one, so parsing it in the machine's timezone would make
 * two users disagree about the price for up to a day.
 */
const PROMOTIONAL_PRICES = {
  'gemini-3.7-flash': {
    price: Object.freeze({ input: 0.75, output: 3.75 }),
    untilIso: '2026-12-31',
    untilMs: Date.parse('2026-12-31T23:59:59.999Z'),
    standardFromIso: '2027-01-01',
  },
  'gemini-3.6-flash': {
    price: Object.freeze({ input: 0.75, output: 3.75 }),
    untilIso: '2026-12-31',
    untilMs: Date.parse('2026-12-31T23:59:59.999Z'),
    standardFromIso: '2027-01-01',
  },
};
for (const promo of Object.values(PROMOTIONAL_PRICES)) Object.freeze(promo);
Object.freeze(PROMOTIONAL_PRICES);

/**
 * Price for an exact model id AT A GIVEN INSTANT, or null if we don't ship it.
 *
 * Exported (rather than kept private behind getModelPrice) so the offline suite
 * can assert BOTH sides of a promotional boundary today, instead of asserting
 * one side and hoping someone re-reads the comment in January. A guard that can
 * only be exercised on the day it matters is a comment, not a guard.
 *
 * @param {string} modelId
 * @param {number} [atMs]  epoch ms; defaults to now. Non-finite input falls back
 *   to now rather than throwing — a bad clock must not take down an LLM call.
 * @returns {null | {input: number, output: number}}
 */
export function resolveModelPrice(modelId, atMs = Date.now()) {
  if (typeof modelId !== 'string') return null;
  if (!Object.hasOwn(MODEL_PRICES_USD_PER_MTOK, modelId)) return null;
  const standard = MODEL_PRICES_USD_PER_MTOK[modelId];
  if (!Object.hasOwn(PROMOTIONAL_PRICES, modelId)) return standard;
  const promo = PROMOTIONAL_PRICES[modelId];
  const t = Number.isFinite(atMs) ? atMs : Date.now();
  return t <= promo.untilMs ? promo.price : standard;
}

/**
 * Published price for an exact model id RIGHT NOW, or null if we don't ship it.
 * Signature and return shape unchanged from before promotional pricing existed,
 * so all existing consumers (health-ai.js, ingest-queue.js, the fallback cost
 * banner) keep working untouched and simply become date-correct for free.
 * @returns {null | {input: number, output: number}}
 */
export function getModelPrice(modelId) {
  return resolveModelPrice(modelId, Date.now());
}

/**
 * ── DOMINATED: alive, fairly priced, and measurably worse than a same-priced
 *    sibling ────────────────────────────────────────────────────────────────
 *
 * The companion to the RETIRED list in test-chat-model.js §9, and deliberately a
 * SEPARATE concept:
 *
 *   RETIRED   — the id 404s. Shipping it does nothing at all.
 *   DOMINATED — the id works and is honestly priced, but another model at the
 *               SAME price measured better on every axis we tested. Shipping it
 *               works; it just costs the user quality for no saving.
 *
 * THE TWO LISTS THIS CONSTRAINS ARE NOT THE SAME LIST, and the distinction is
 * the whole reason this exists rather than a single ban:
 *
 *   FALLBACK_CHAINS — the app picks FOR the user, silently, on the worst day
 *     (their pinned default has just been retired). A dominated rung there is
 *     indefensible: nobody chose it, nobody was told, and its documented promise
 *     is "the cheapest model that still WORKS". A DOMINATED id must therefore
 *     never appear in a chain — asserted in test-chat-model.js.
 *   OFFERABLE_MODELS — the USER picks, deliberately, with the measured reason on
 *     screen. Hiding a working model there would be deciding for someone what
 *     they may spend their own API key on. The honest answer is to show it and
 *     label it, which is what `suitability` + `note` + this list are for.
 *
 * So DOMINATED ∩ FALLBACK_CHAINS = ∅, while DOMINATED ⊆ OFFERABLE is fine.
 *
 * `gemini-3.5-flash-lite` is the founding entry: it was pulled from the Gemini
 * chain on 2026-08-26 by an ad-hoc pair of assertions naming it specifically.
 * Those assertions are folded into this list, so the next dominated model is
 * caught by the same invariant instead of needing its own bespoke pair.
 */
export const DOMINATED_MODELS = Object.freeze({
  'gemini-3.5-flash-lite': Object.freeze({
    dominatedBy: 'gemini-2.5-flash',
    reason:
      'Identical published price ($0.30/$2.50) to gemini-2.5-flash, but 2 of 9 live runs against ' +
      'this repo\'s REAL ingest outline prompt returned JSON that neither JSON.parse nor jsonrepair ' +
      'could fix — a dropped object key, with finishReason STOP, so a generation defect rather than ' +
      'truncation that the output-token-limit ladder could route around. gemini-2.5-flash was 3/3 ' +
      'clean on the identical probe and plans wider outlines (17-19 pages vs 12-16).',
  }),
  'claude-opus-4-5': Object.freeze({
    dominatedBy: 'claude-opus-5',
    reason:
      'Identical published price ($5/$25) to claude-opus-5 and behind it on all three measured axes: ' +
      'half the output ceiling (64,000 vs 128,000), fenced JSON that only parses via jsonrepair ' +
      '(3/3) where opus-5 returned bare JSON (3/3), and 12-13 outline pages against opus-5\'s 25-27. ' +
      'It also plans more thinly than claude-sonnet-5 does at two-fifths of the price.',
  }),
});

/**
 * ── AWAITING MEASUREMENT: real models we deliberately do NOT offer ───────────
 *
 * Price and output ceiling for both were read off the provider's documentation,
 * but neither has been probed live against this repo's real ingest outline
 * prompt. That is disqualifying, not a formality — a model may not be offered
 * for a feature it has never been measured against, and the sharpest evidence
 * for that rule is in the data this table was built from:
 *
 *   THINKING BEHAVIOUR IS PER-MODEL, NOT PER-GENERATION. `claude-opus-5` was
 *   released AFTER `claude-sonnet-5` and thinks 0/3, while sonnet-5 thinks 7/7.
 *   Two models one release apart, opposite behaviour. So for any unprobed id the
 *   `thinks` flag is genuinely UNKNOWN, and a guess there is a guess about
 *   billed output tokens drawn from the same budget as the answer.
 *
 * These ids must not be offerable, must not be a default, must not be a fallback
 * rung, and must carry no price entry — all four asserted in test-chat-model.js.
 * To promote one: probe it live with the REAL prompt (a toy "return this JSON"
 * probe will not reproduce the failures this table records), then add its price,
 * cap and measured fields together.
 */
export const AWAITING_MEASUREMENT = Object.freeze({
  'claude-opus-4-7': Object.freeze({
    reason:
      'Provider docs give $5/$25 and a 128,000 output ceiling, and describe the newer 1.329x ' +
      'tokenizer — but it has never been run against the real ingest outline prompt, so its JSON ' +
      'reliability, outline coverage and thinking behaviour are all unmeasured.',
  }),
  'claude-opus-4-6': Object.freeze({
    reason:
      'Provider docs give $5/$25 and a 128,000 output ceiling; never probed live. Same gap as ' +
      'claude-opus-4-7 — nothing about its behaviour under a real ingest prompt is known.',
  }),
});

/**
 * The three suitability verdicts an offerable model can carry.
 *
 * These describe FITNESS FOR A FEATURE and nothing else. Cost lives in the price
 * fields, and hidden reasoning spend lives in `thinks` — deliberately kept as
 * separate axes, because folding "this is expensive" or "this thinks" into
 * `caution` would put five of seven Gemini models in the same bucket and the
 * label would stop meaning anything.
 *
 *   'general'   — measured clean for every feature, ingest included.
 *   'chat-only' — measured UNFIT for ingest specifically. Ingest is JSON mode;
 *                 chat is text mode and is unaffected by a JSON defect, so the
 *                 model stays genuinely useful for chat rather than being hidden.
 *   'caution'   — usable everywhere, but carries a measured downside (a scheduled
 *                 price rise, thinner outlines than a cheaper model, a
 *                 same-priced sibling that beat it) the user must see BEFORE
 *                 choosing it.
 */
const OFFERABLE_SUITABILITY = Object.freeze(['general', 'chat-only', 'caution']);

/**
 * Build one frozen OFFERABLE_MODELS entry, or REFUSE to build it.
 *
 * This is the structural half of "a model may not be offerable unless it is
 * fully specified". Every required field is checked here and a missing one
 * throws AT MODULE LOAD — so an under-specified model does not merely fail a
 * test, it fails to exist, and the app refuses to boot rather than shipping a
 * picker entry with a blank price or an unknown output ceiling. The table is
 * static, so this is unreachable in production by construction; it is a
 * developer-time tripwire that cannot be forgotten the way a convention can.
 *
 * PRICE AND CEILING ARE DERIVED, NEVER RE-TYPED. `input`/`output` come from
 * MODEL_PRICES_USD_PER_MTOK and `maxOutput` from the provider's cap map. Copying
 * either number into the entry would create two hand-maintained copies of the
 * same fact — this repo's named cause of the v3.2.0 CRITICAL — and the copies
 * would drift silently, in a picker, on the numbers a user makes a spending
 * decision from.
 *
 * `input`/`output` are GETTERS, not snapshots, so a promotional price that
 * expires while the process is running resolves correctly on the next read
 * rather than serving a stale number until the next restart. JSON.stringify
 * invokes them, so the route serialises plain numbers to the wire exactly as if
 * they were data properties.
 */
function defineOfferableModel(provider, spec) {
  const id = spec && typeof spec.id === 'string' ? spec.id : '(no id)';
  const where = `OFFERABLE_MODELS.${provider} entry "${id}"`;
  const need = (cond, what) => {
    if (!cond) throw new Error(`[llm] ${where} is not offerable: ${what}`);
  };

  need(spec && typeof spec === 'object', 'spec must be an object');
  need(typeof spec.id === 'string' && spec.id.length > 0, 'missing `id`');
  need(typeof spec.label === 'string' && spec.label.length > 0, 'missing `label`');
  need(typeof spec.thinks === 'boolean',
    'missing measured `thinks` — it is PER-MODEL and cannot be inferred from a family or a release date (claude-opus-5 is newer than claude-sonnet-5 and thinks 0/3 where sonnet-5 thinks 7/7)');
  need(typeof spec.jsonRaw === 'boolean',
    'missing measured `jsonRaw` — whether a raw JSON.parse of the ingest outline succeeds without the jsonrepair fallback');
  need(typeof spec.tokenizerFactor === 'number' && Number.isFinite(spec.tokenizerFactor) && spec.tokenizerFactor >= 1,
    'missing/invalid `tokenizerFactor` (>= 1; 1.0 means no measured premium over its provider baseline)');
  need(OFFERABLE_SUITABILITY.includes(spec.suitability),
    `\`suitability\` must be one of ${OFFERABLE_SUITABILITY.join(' | ')}`);
  need(typeof spec.note === 'string' && spec.note.trim().length > 0,
    'missing `note` — the measured reason shown to the user. A model nobody has measured must not be offered at all');

  need(Object.hasOwn(MODEL_PRICES_USD_PER_MTOK, spec.id),
    'no entry in MODEL_PRICES_USD_PER_MTOK — a model may not be offerable unless it is priced');
  const standard = MODEL_PRICES_USD_PER_MTOK[spec.id];

  const caps = provider === 'gemini' ? GEMINI_MODEL_MAX_OUTPUT_TOKENS : ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS;
  need(Object.hasOwn(caps, spec.id),
    'no entry in the provider output-cap map — a model may not be offerable unless its output ceiling is known');
  const maxOutput = caps[spec.id];

  const promo = Object.hasOwn(PROMOTIONAL_PRICES, spec.id) ? PROMOTIONAL_PRICES[spec.id] : null;

  const entry = {
    id: spec.id,
    provider,
    label: spec.label,
    /** Hard output ceiling for this model, in tokens. */
    maxOutput,
    /** Measured: does it spend hidden reasoning tokens (billed as OUTPUT, drawn from the same budget as the answer)? */
    thinks: spec.thinks,
    /** Measured: does a raw JSON.parse of the ingest outline succeed, or is the jsonrepair fallback load-bearing? */
    jsonRaw: spec.jsonRaw,
    /**
     * Measured INPUT-side token multiplier against this provider's older
     * tokenizer, on real Curator prose. 1.0 = no premium. It is deliberately NOT
     * applied to `output` anywhere: the 1.329x figure was measured on prompt
     * text, and silently extending an input measurement to output would be
     * over-claiming. It is also PROVIDER-RELATIVE — it compares models within one
     * provider and says nothing about Gemini-vs-Anthropic token counts.
     */
    tokenizerFactor: spec.tokenizerFactor,
    /** 'general' | 'chat-only' | 'caution' — see OFFERABLE_SUITABILITY. */
    suitability: spec.suitability,
    /** The measured reason behind `suitability`, written to be shown verbatim to a user. */
    note: spec.note,
    /** Price after any promotion ends. Equal to input/output when there is no promotion. */
    standardInput: standard.input,
    standardOutput: standard.output,
    /** Last day of the current promotional price (ISO date), or null. */
    promotionUntilIso: promo ? promo.untilIso : null,
    /** First day the standard price applies (ISO date), or null. */
    standardPriceFromIso: promo ? promo.standardFromIso : null,
    /** True when a same-priced sibling measured better — see DOMINATED_MODELS. */
    dominated: Object.hasOwn(DOMINATED_MODELS, spec.id),
  };

  // Resolved at READ time, so a promotion expiring mid-process cannot serve a
  // stale price. Enumerable + JSON-visible; see the docblock above.
  Object.defineProperty(entry, 'input', {
    enumerable: true, configurable: false,
    get: () => resolveModelPrice(spec.id).input,
  });
  Object.defineProperty(entry, 'output', {
    enumerable: true, configurable: false,
    get: () => resolveModelPrice(spec.id).output,
  });

  return Object.freeze(entry);
}

/**
 * ── OFFERABLE_MODELS: the models a user may pick with their own key ─────────
 *
 * Until this table existed The Curator could run exactly two models, one per
 * provider, both the cheapest tier. That kept ingestion of large libraries
 * affordable and it stays the DEFAULT — but it also meant a user who wanted more
 * capability out of a big wiki, and was willing to pay for it on their own key,
 * had no way to ask. This table is that ask: every model here was probed live on
 * 2026-08-26 with this repo's REAL buildOutlinePrompt on real prose, and every
 * entry carries what that probe measured so the cost and the trade-off are both
 * visible at the moment of choosing.
 *
 * SHAPE IS A PUBLIC CONTRACT. `src/routes/config.js` serialises these entries
 * VERBATIM onto `GET /api/config/api-keys` → `offerable`, so every field here is
 * user-facing wire format. Add fields freely (additive); never rename or remove
 * one without checking that route and its consumers.
 *
 * ORDER IS CHEAPEST-FIRST within each provider and is asserted, because a picker
 * that leads with the priciest model is a cost trap. Ordering is on the STANDARD
 * price so the array cannot silently re-order itself when a promotion expires;
 * the suite additionally checks the order holds at the promotional price too.
 * Ties are broken by suitability (general before caution before chat-only) and
 * then newest-first — the same forward-in-time tie-break FALLBACK_CHAINS uses.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *   • Gemini Pro — the maintainer's call, and the measured picture agrees: it is
 *     a different price class again and nothing in this list is coverage-starved.
 *   • claude-opus-4-7 / claude-opus-4-6 — real, documented, never probed. See
 *     AWAITING_MEASUREMENT.
 *   • Every RETIRED id (test-chat-model.js §9) — those 404.
 */
export const OFFERABLE_MODELS = Object.freeze({
  gemini: Object.freeze([
    defineOfferableModel('gemini', {
      id: 'gemini-2.5-flash-lite',
      label: 'Flash Lite 2.5',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'general',
      note:
        'The default, and the cheapest model on either provider. Measured 3/3 clean raw JSON, no ' +
        'hidden reasoning tokens, and the widest outline coverage of any Gemini model probed ' +
        '(18-20 pages on the reference source). Nothing here beats it on value for ingest.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.1-flash-lite',
      label: 'Flash Lite 3.1',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'caution',
      note:
        '2.5x the input and 3.75x the output price of the default, and measured THINNER than it: ' +
        '5-12 outline pages where the default plans 18-20 on the same source. Clean JSON (3/3) and ' +
        'no hidden reasoning tokens, so it is safe — just a worse deal for ingest. It is here ' +
        'because it is the closest live successor to the default and the first fallback rung.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-2.5-flash',
      label: 'Flash 2.5',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'general',
      note:
        'Clean raw JSON 3/3 and 17-19 outline pages — coverage on a par with the default at 3x the ' +
        'input price. Spends 1,700-2,629 hidden reasoning tokens per call: those are billed as ' +
        'OUTPUT and drawn from the SAME output budget as the answer, so leave headroom.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.5-flash-lite',
      label: 'Flash Lite 3.5',
      thinks: false, jsonRaw: false, tokenizerFactor: 1.0,
      suitability: 'chat-only',
      note:
        'Not recommended for ingest. 2 of 9 live runs against the real ingest outline prompt ' +
        'returned JSON that neither JSON.parse nor jsonrepair could repair (a dropped object key, ' +
        'finishReason STOP — a generation defect, not truncation). Chat is text mode and is ' +
        'unaffected, so it stays pickable there. gemini-2.5-flash costs exactly the same and was ' +
        '3/3 clean on the identical probe.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.7-flash',
      label: 'Flash 3.7',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'caution',
      note:
        'PROMOTIONAL PRICE: $0.75/$3.75 per 1M tokens through 2026-12-31, then $1.50/$7.50 from ' +
        '2027-01-01 — the standard price is what standardInput/standardOutput carry, and it applies ' +
        'itself on the date. Measured 3/3 clean raw JSON and 12-16 outline pages (thinner than the ' +
        'far cheaper default). Spends 915-1,066 hidden reasoning tokens per call, billed as output ' +
        '— the least of any thinking model here.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.6-flash',
      label: 'Flash 3.6',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'caution',
      note:
        'PROMOTIONAL PRICE: $0.75/$3.75 per 1M tokens through 2026-12-31, then $1.50/$7.50 from ' +
        '2027-01-01. Measured 3/3 clean raw JSON and 12-16 outline pages. Spends 1,293-1,573 hidden ' +
        'reasoning tokens per call, billed as output — more than gemini-3.7-flash for the same ' +
        'measured coverage and the same price.',
    }),
    defineOfferableModel('gemini', {
      id: 'gemini-3.5-flash',
      label: 'Flash 3.5',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'caution',
      note:
        'The most expensive Gemini model here and not the strongest: 15x the input and 22.5x the ' +
        'output price of the default, yet measured THINNER than it at 8-14 outline pages against ' +
        '18-20. Clean JSON 3/3, but it also spends 1,614-2,067 hidden reasoning tokens per call, ' +
        'billed as output. Pick it only for a specific reason.',
    }),
  ]),
  anthropic: Object.freeze([
    defineOfferableModel('anthropic', {
      id: 'claude-haiku-4-5',
      label: 'Haiku 4.5',
      thinks: false, jsonRaw: false, tokenizerFactor: 1.0,
      suitability: 'general',
      note:
        'The default and the cheapest Anthropic model. No hidden reasoning tokens, but it wraps its ' +
        'ingest-outline JSON in ```json fences 3/3, so every ingest on it depends on the jsonrepair ' +
        'fence-stripping fallback (benign — that is what the fallback is for). Its outline coverage ' +
        'is the MOST VARIABLE measured, 5 to 13 pages on the same source, so a long document may be ' +
        'planned much more thinly on one run than the next. That variability is the single best ' +
        'reason to reach for a stronger model on a big wiki.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-sonnet-5',
      label: 'Sonnet 5',
      thinks: true, jsonRaw: true, tokenizerFactor: 1.329,
      suitability: 'general',
      note:
        'The strongest value here: cheaper than both Sonnet 4.6 and 4.5 while measuring better than ' +
        'either — 7/7 clean raw JSON, a steady 16-18 outline pages, and a 128,000 output ceiling. ' +
        'Two costs the headline price hides: it is the only model measured running adaptive thinking ' +
        'on every single call (7/7, billed as output), and its newer tokenizer produced 1.329x more ' +
        'input tokens than Haiku 4.5 on the same prose — so $2 per 1M input is really ~$2.66 of the ' +
        'same text.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-sonnet-4-6',
      label: 'Sonnet 4.6',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.0,
      suitability: 'general',
      note:
        'The most predictable model measured: 3/3 clean raw JSON, no hidden reasoning tokens at all, ' +
        'a 128,000 output ceiling and a steady 17-page outline every run. At $3/$15 it is 50% dearer ' +
        'than claude-sonnet-5, which measured stronger — choose this when you specifically want zero ' +
        'thinking-token spend and no tokenizer premium.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-sonnet-4-5',
      label: 'Sonnet 4.5',
      thinks: false, jsonRaw: false, tokenizerFactor: 1.0,
      suitability: 'caution',
      note:
        'Same $3/$15 as claude-sonnet-4-6 but behind it on three measured axes: half the output ' +
        'ceiling (64,000 vs 128,000), fenced JSON rather than raw, and 15-16 outline pages against ' +
        '17. claude-sonnet-5 is cheaper AND measured stronger than both. It is here because it is ' +
        'the last rung of the Anthropic fallback chain; there is no reason to choose it deliberately.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-opus-5',
      label: 'Opus 5',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.329,
      suitability: 'general',
      note:
        'The richest planner measured — 25-27 outline pages where the default plans 5-13 on the same ' +
        'source — with 3/3 clean raw JSON, no hidden reasoning tokens and a 128,000 output ceiling. ' +
        'Also the most expensive: $5/$25 headline, and its newer tokenizer produced 1.329x more input ' +
        'tokens than Haiku 4.5 on the same prose, so the real input cost is ~$6.65 per 1M ' +
        'Haiku-equivalent tokens — 6.6x the default, not the 5x the headline implies.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-opus-4-8',
      label: 'Opus 4.8',
      thinks: false, jsonRaw: true, tokenizerFactor: 1.329,
      suitability: 'caution',
      note:
        'Priced identically to claude-opus-5 ($5/$25), same 128,000 ceiling, same clean raw JSON, no ' +
        'thinking, same 1.329x tokenizer premium — but measured 19-20 outline pages against opus-5\'s ' +
        '25-27 on the identical source. No axis measured better than opus-5. Flagged rather than ' +
        'listed as dominated because that verdict rests on outline coverage alone from a small ' +
        'sample, and an over-claimed domination is worth less than an honest number.',
    }),
    defineOfferableModel('anthropic', {
      id: 'claude-opus-4-5',
      label: 'Opus 4.5',
      thinks: false, jsonRaw: false, tokenizerFactor: 1.0,
      suitability: 'caution',
      note:
        'Dominated by claude-opus-5 at the identical $5/$25: half the output ceiling (64,000 vs ' +
        '128,000), fenced JSON rather than raw, and 12-13 outline pages against 25-27 — thinner than ' +
        'claude-sonnet-5 plans at two-fifths of the price. Offered because the choice is yours, but ' +
        'nothing measured supports paying $5 per 1M for it.',
    }),
  ]),
});

/**
 * Is this exact model id one the user is allowed to select on this provider?
 *
 * THE ALLOW-LIST LIVES HERE AND IS APPLIED IN getProviderInfo(), the single
 * producer of the model string both SDKs receive — NOT at a route. There are
 * seven other entry points into generateText (ingest, compile, chat, query,
 * health-ai, shared-brain, diagnostics), so validating at one route would leave
 * the rest open and create a second hand-maintained copy of the guard, which is
 * exactly what produced the v3.2.0 CRITICAL.
 *
 * The lookup is an array scan comparing with `===`, so `'__proto__'`,
 * `'constructor'` and `'toString'` are structurally unable to resolve to
 * anything — there is no object indexed by the caller's string at any point
 * (the v3.0.9 normalizeResponseStyle bug shape, closed by construction rather
 * than by remembering to call Object.hasOwn).
 */
export function isOfferableModel(provider, modelId) {
  if (provider !== 'gemini' && provider !== 'anthropic') return false;
  if (typeof modelId !== 'string' || modelId.length === 0) return false;
  return OFFERABLE_MODELS[provider].some(entry => entry.id === modelId);
}

/**
 * Compare what the user CONFIGURED against what they are actually being billed
 * for right now. Three states, because two would force us to lie:
 *
 *   'costlier' — confirmed higher on input and/or output. Warn plainly.
 *   'similar'  — confirmed same-or-cheaper. Say nothing about cost.
 *   'unknown'  — at least one id is not in the price table. NEVER imply parity
 *                here: any fallback means the user is off the model they chose,
 *                so the honest line is "pricing may differ", not silence.
 *
 * @returns {'costlier'|'similar'|'unknown'}
 */
export function compareModelCost(requestedModel, usingModel) {
  const a = getModelPrice(requestedModel);
  const b = getModelPrice(usingModel);
  if (!a || !b) return 'unknown';
  return (b.input > a.input || b.output > a.output) ? 'costlier' : 'similar';
}

/**
 * Boolean form of the 'costlier' verdict. Kept as a separate export because the
 * fallback payload carries `costlier` for backwards compatibility; new code
 * should prefer compareModelCost() so the 'unknown' state isn't collapsed into
 * a misleading `false`.
 */
export function isCostlierModel(requestedModel, usingModel) {
  return compareModelCost(requestedModel, usingModel) === 'costlier';
}

/**
 * Module-level snapshot of the most recent fallback event.
 * null when the primary model is working; populated when a fallback is in use.
 * Cleared automatically when a subsequent primary call succeeds.
 */
let _activeFallback = null;

/**
 * @returns {null | {provider: string, requestedModel: string, usingModel: string,
 *                   at: string, costTier: 'costlier'|'similar'|'unknown',
 *                   costlier: boolean}}
 *
 * `costlier` is DERIVED here (not stored on _activeFallback) so the flag always
 * reflects the current tier heuristic, and so the stored record keeps the exact
 * shape it has had since v2.4.0. It is additive: every pre-existing field is
 * returned unchanged, and `/api/config/api-keys` passes this object straight
 * through, so the frontend gets the flag with no route change.
 */
export function getFallbackStatus() {
  if (!_activeFallback) return null;
  const costTier = compareModelCost(_activeFallback.requestedModel, _activeFallback.usingModel);
  return {
    ..._activeFallback,
    costTier,
    // Legacy boolean kept so anything reading `costlier` keeps working. It
    // collapses 'similar' and 'unknown' into false, which is exactly why the
    // banner drives off costTier instead.
    costlier: costTier === 'costlier',
  };
}

/**
 * The default model id for a provider (respecting a global LLM_MODEL override
 * only for the currently-active provider). Exported so the UI can display the
 * CURRENT model per provider — when we bump DEFAULTS to a newer model, the
 * chat model selector's label updates automatically with no frontend change.
 */
export function getDefaultModel(provider) {
  if (provider !== 'gemini' && provider !== 'anthropic') return null;
  // LLM_MODEL is a single global dev override tied to the active provider; only
  // surface it for that provider so we never label Gemini with a Claude id.
  if (process.env.LLM_MODEL && getActiveProvider() === provider) return process.env.LLM_MODEL;
  return DEFAULTS[provider];
}

/**
 * Apply a caller's per-call MODEL choice on top of the resolved provider default,
 * enforcing the OFFERABLE_MODELS allow-list.
 *
 * REFUSAL IS A FALL-BACK, NOT A THROW, and the direction is chosen deliberately.
 * A stored selection can outlive the model it names — a user picks Opus 4.8, we
 * later pull it after a bad live probe, and their saved preference now points at
 * an id we refuse. Throwing would hard-fail every chat and every ingest for that
 * user until they noticed a picker somewhere; falling back to the provider's
 * default keeps them working. It is also the safe direction on money: a refusal
 * resolves to the CHEAPEST model on that provider, so the worst case is spending
 * less than the user asked for, never more. This mirrors normalizeChatProvider
 * (invalid provider -> null -> global) and anthropicMaxOutputTokens (unknown id
 * -> conservative cap), both of which fail toward the safe outcome rather than
 * toward an error.
 *
 * Callers who need to KNOW a refusal happened can see it directly: getProviderInfo
 * returns the model it actually resolved, so `result.model !== requested` is the
 * signal. The return shape is deliberately unchanged (no new field) because
 * `{provider, model}` is destructured at ~15 call sites across src/ and mcp/.
 */
function applyModelOverride(provider, defaultModel, preferModel) {
  if (preferModel === null || preferModel === undefined) return defaultModel;
  if (isOfferableModel(provider, preferModel)) return preferModel;
  // Bounded and newline-stripped: this string is caller-supplied and this repo
  // has a recorded log-forgery finding (v3.0.1-beta.20, connection labels).
  // stderr, never stdout — llm.js is imported by the MCP child process, which
  // reserves stdout for JSON-RPC frames (v2.5.2/v3.9.1).
  const shown = String(preferModel).replace(/[\r\n]+/g, ' ').slice(0, 80);
  console.error(
    `[llm] Refusing model "${shown}" for provider "${provider}" — not in OFFERABLE_MODELS. ` +
    `Using the provider default "${defaultModel}" instead.`
  );
  return defaultModel;
}

/**
 * @param {('gemini'|'anthropic'|null)} preferProvider - optional per-call
 *   provider override (e.g. the chat model selector). Used ONLY if that
 *   provider has a usable key; otherwise falls through to the global active
 *   provider.
 * @param {(string|null)} preferModel - optional per-call MODEL override (the
 *   multi-model picker). Honoured ONLY if it is in OFFERABLE_MODELS for the
 *   resolved provider; anything else falls back to that provider's default (see
 *   applyModelOverride). It is applied LAST, so an explicit user choice also
 *   outranks the LLM_MODEL dev override — a deliberate ordering: LLM_MODEL exists
 *   to reshape the DEFAULT, and a developer who set it would be surprised to find
 *   it silently overriding a selection made in the UI.
 */
export function getProviderInfo(preferProvider = null, preferModel = null) {
  const base = resolveProviderDefault(preferProvider);
  return { provider: base.provider, model: applyModelOverride(base.provider, base.model, preferModel) };
}

/**
 * Provider + its DEFAULT model, with no model override applied. Split out of
 * getProviderInfo verbatim so the allow-list has exactly one application point;
 * the body below is unchanged, including which branch throws.
 */
function resolveProviderDefault(preferProvider) {
  // Per-call override (v3.0.11: chat model selector). Never honours a stale
  // override whose key is missing — falls through to the global logic below.
  if ((preferProvider === 'gemini' || preferProvider === 'anthropic') && getEffectiveKey(preferProvider)) {
    return { provider: preferProvider, model: getDefaultModel(preferProvider) };
  }
  // Honour the user's last-saved active provider (v2.4.2+). Falls back to
  // Gemini-first-if-both behaviour for legacy configs via getActiveProvider().
  const active = getActiveProvider();
  if (active === 'gemini' && getEffectiveKey('gemini')) {
    return { provider: 'gemini', model: process.env.LLM_MODEL || DEFAULTS.gemini };
  }
  if (active === 'anthropic' && getEffectiveKey('anthropic')) {
    return { provider: 'anthropic', model: process.env.LLM_MODEL || DEFAULTS.anthropic };
  }
  // Defensive fallback: active provider is stored but its key is missing.
  // Prefer whichever provider still has a usable key.
  if (getEffectiveKey('gemini')) {
    return { provider: 'gemini', model: process.env.LLM_MODEL || DEFAULTS.gemini };
  }
  if (getEffectiveKey('anthropic')) {
    return { provider: 'anthropic', model: process.env.LLM_MODEL || DEFAULTS.anthropic };
  }
  throw new Error(
    'No LLM API key found. Add one in Settings, or set GEMINI_API_KEY / ANTHROPIC_API_KEY in .env.'
  );
}

/**
 * Extract the retry-after delay in milliseconds from a 429 error.
 * The Gemini API embeds this in the error message as e.g. "retry in 27.136s"
 * or in a structured RetryInfo field.
 */
function parseRetryDelay(err) {
  const msg = err?.message ?? '';

  // Structured: "retryDelay":"27s" or "retryDelay": "27.136533819s"
  const structuredMatch = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  if (structuredMatch) return Math.ceil(parseFloat(structuredMatch[1]) * 1000);

  // Plain text: "Please retry in 27.136533819s"
  const plainMatch = msg.match(/retry in ([\d.]+)s/i);
  if (plainMatch) return Math.ceil(parseFloat(plainMatch[1]) * 1000);

  // Default fallback: 60 seconds
  return 60_000;
}

function is429(err) {
  const msg = err?.message ?? '';
  return msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('RESOURCE_EXHAUSTED');
}

function is503(err) {
  const msg = err?.message ?? '';
  return msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('high demand') || msg.includes('overloaded');
}

/**
 * ── Cancellation (v3.3.x, batch-ingest queue) ────────────────────────────────
 *
 * `opts.signal` threads an AbortSignal from the caller (the ingest queue's
 * per-item AbortController) down to the provider SDKs, so a user's Cancel
 * stops at the NEXT LLM call boundary — seconds — instead of after the current
 * FILE finishes, which on a large multi-phase ingest is minutes of API spend
 * the user has already asked us to stop.
 *
 * Everything cancellation-related is tagged with `curatorAborted === true` so
 * callers can tell "the user stopped this" apart from every other failure.
 * That distinction is load-bearing in ingest.js: its three recovery ladders
 * (Phase 1 stricter retry, Phase 2 page-by-page, single-pass -> multi-phase)
 * all exist to DEGRADE rather than fail, and a cancel that got "recovered"
 * would keep spending and write stub pages — the exact opposite of a cancel.
 *
 * NOTE (honest scope): an AbortSignal is client-side. It stops us WAITING for
 * an in-flight response and, far more importantly, stops every SUBSEQUENT call
 * — which is where the money is on a 10-40 call multi-phase ingest. The single
 * in-flight request may still be billed by the provider.
 */
export const ABORT_MESSAGE = '⚠ Cancelled — the operation was stopped before the AI call finished.';

/**
 * The canonical cancellation error. The message deliberately contains none of
 * the substrings any other classifier keys on — not "output token limit"
 * (isOutputTokenLimit), not 429/503/"overloaded" (is429/is503 and the queue's
 * TRANSIENT_PATTERNS), not "not found"/"model" (isModelNotFound) — so a cancel
 * can never be mistaken for a recoverable condition and retried.
 */
export function makeAbortError() {
  const e = new Error(ABORT_MESSAGE);
  e.curatorAborted = true;
  e.name = 'AbortError';
  return e;
}

/**
 * True for our own tagged cancellation AND for a raw `AbortError` thrown by a
 * provider SDK / undici before we get a chance to translate it. Deliberately
 * wide in the SAFE direction: a false positive propagates a fatal error the
 * user sees, while a false negative would let a cancel fall into a recovery
 * ladder and silently produce stub pages.
 */
export function isAbortError(err) {
  if (!err) return false;
  if (err.curatorAborted === true) return true;
  return err.name === 'AbortError';
}

/** Duck-typed so a test double works without constructing a real AbortSignal. */
function normalizeSignal(signal) {
  return (signal && typeof signal.aborted === 'boolean'
    && typeof signal.addEventListener === 'function') ? signal : null;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError();
}

/**
 * `signal` is optional and, when present, makes the wait itself cancellable.
 * That matters: the 429/503 ladder below waits up to ~40s across its retries,
 * and a cancel that had to sit out a 27-second backoff would look exactly like
 * the "Cancelling…" hang this whole change exists to remove.
 */
function sleep(ms, signal = null) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(makeAbortError()); return; }
    let timer = null;
    const onAbort = () => { if (timer) clearTimeout(timer); reject(makeAbortError()); };
    timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Call the active LLM with a system prompt and user message.
 * Automatically retries on:
 *   - 429 rate-limit errors (respects the Retry-After delay from the API)
 *   - 503 service unavailable (exponential backoff: 3 s → 9 s → 27 s)
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} maxTokens
 * @param {'text'|'json'} responseFormat  - 'json' enables native JSON mode (Gemini only)
 * @param {function|null} onWait          - optional callback(message) called before each retry wait
 * @param {object} opts                   - {provider, onUsage, cachePrefixChars} — all optional
 * @returns {Promise<string>}  the model's text. The RETURN TYPE IS A BARE STRING
 *   and must stay that way: ~18 call sites across src/ and mcp/ depend on it.
 *   Token usage is delivered out-of-band via opts.onUsage instead.
 */
export async function generateText(systemPrompt, userPrompt, maxTokens = 8192, responseFormat = 'text', onWait = null, opts = {}) {
  const MAX_RETRIES = 4; // up to 4 attempts (3 retries)
  // v3.0.11: optional per-call provider override (chat model selector). Ignored
  // unless it names a provider with a usable key (getProviderInfo enforces this).
  const providerOverride = (opts && (opts.provider === 'gemini' || opts.provider === 'anthropic'))
    ? opts.provider : null;
  // Per-call MODEL override (multi-model picker). Only a non-empty string is
  // even a candidate; getProviderInfo then enforces the OFFERABLE_MODELS
  // allow-list and falls back to the provider default if it does not pass.
  const modelOverride = (opts && typeof opts.model === 'string' && opts.model.length > 0)
    ? opts.model : null;

  // v3.0.16: observability + cost controls, both additive and both optional.
  //   onUsage          — real token counts, once per completed provider call
  //                      (retries and fallback rungs included, so the callback
  //                      sees TOTAL spend, not just the successful attempt).
  //   cachePrefixChars — caller-declared stable-prefix length for Anthropic
  //                      prompt caching. The caller owns the "is this prefix
  //                      reused enough to beat the 1.25x write premium?"
  //                      decision; llm.js only enforces the size floor.
  const callOpts = {
    onUsage: typeof opts?.onUsage === 'function' ? opts.onUsage : null,
    cachePrefixChars: Number.isInteger(opts?.cachePrefixChars) ? opts.cachePrefixChars : 0,
    // v3.3.x: optional AbortSignal. null when absent, so every branch below
    // behaves exactly as it did before for callers that pass no signal.
    signal: normalizeSignal(opts?.signal),
    // Read by callLLM when it resolves the provider; ignored by callProvider,
    // which is handed the already-resolved model id as a positional argument.
    model: modelOverride,
  };
  const signal = callOpts.signal;

  // Resolve provider name once for consistent error messaging. If this fails
  // (e.g. no key configured), let the underlying call throw the original
  // "No LLM API key found" message — don't shadow it here.
  let providerName = 'AI provider';
  try {
    const info = getProviderInfo(providerOverride, modelOverride);
    providerName = info.provider === 'gemini' ? 'Gemini' : info.provider === 'anthropic' ? 'Claude' : 'AI provider';
  } catch { /* surface real error from callLLM below */ }

  // Already cancelled before we even dispatch: never spend on a call the user
  // has already asked us to stop.
  throwIfAborted(signal);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callLLM(systemPrompt, userPrompt, maxTokens, responseFormat, providerOverride, callOpts);
    } catch (err) {
      // ABORT WINS OVER EVERYTHING, and must be checked BEFORE is429/is503:
      // an aborted fetch can surface with a message we would otherwise
      // classify as retryable, and retrying is precisely what a cancel must
      // not do. Normalised to our tagged error so callers get one shape.
      if (isAbortError(err) || (signal && signal.aborted)) throw makeAbortError();
      const retryable = is429(err) || is503(err);
      if (!retryable || attempt === MAX_RETRIES) {
        // Out of retries or non-retryable error — surface a clean message that
        // makes clear whether the issue is in The Curator or upstream at the
        // AI provider, and what the user should do next (v3.0.1-beta.4).
        if (is429(err)) {
          const delaySec = Math.ceil(parseRetryDelay(err) / 1000);
          // v3.2.x (batch-ingest queue): tag the error so a caller that only
          // sees the final thrown Error (not the raw provider error) can
          // still tell "retries exhausted, upstream limit" apart from any
          // other failure — e.g. the queue worker pauses the whole batch on
          // a rate limit instead of failing just the one item. Message text
          // is UNCHANGED (existing tests assert on it); this only adds
          // properties.
          const e = new Error(
            `⚠ Rate limit hit on ${providerName} (HTTP 429). This is an upstream limit on your API account, ` +
            `not an issue with The Curator. Free tiers cap at ~15 requests/min and ~20–50 requests/day; ` +
            `paid plans have much higher limits but can still be reached during bulk operations. ` +
            `Please wait ${delaySec} seconds and try again. If you are on the free tier, consider upgrading at https://ai.google.dev/pricing.`
          );
          e.curatorTransient = 'rate_limit';
          e.curatorRetryAfterMs = parseRetryDelay(err);
          throw e;
        }
        if (is503(err)) {
          const e = new Error(
            `⚠ ${providerName} infrastructure is temporarily overloaded (HTTP 503). This is a transient backend ` +
            `issue on the provider's side — it affects ALL accounts equally (free and paid), and is NOT a ` +
            `problem with The Curator or your API key. The Curator already retried 4 times with backoff over ` +
            `~40 seconds. What to do: wait 2–3 minutes and try again; if the issue persists, check ` +
            `https://status.cloud.google.com or temporarily switch to a different provider in Settings.`
          );
          e.curatorTransient = 'service_unavailable';
          throw e;
        }
        throw err;
      }

      // Calculate delay: 429 respects API hint; 503 uses exponential backoff (3s, 9s, 27s)
      const delayMs = is429(err)
        ? parseRetryDelay(err)
        : Math.min(3000 * Math.pow(3, attempt - 1), 60_000);

      const delaySec = Math.ceil(delayMs / 1000);
      const reason = is429(err) ? 'Rate limit' : 'Service busy';
      console.warn(
        `[llm] ${reason} (attempt ${attempt}/${MAX_RETRIES}). Waiting ${delaySec}s...`
      );
      onWait?.(`${reason} — retrying in ${delaySec}s… (attempt ${attempt}/${MAX_RETRIES - 1})`);
      // Abortable: rejects immediately on cancel instead of serving out a
      // backoff of up to 60s.
      await sleep(delayMs, signal);
    }
  }
}

/**
 * Detect "model not found" errors across both provider SDKs.
 *
 * Anthropic throws `NotFoundError` with status 404 and a message containing
 * "not_found_error" / "model".
 * Gemini returns an error whose message includes "404", "not found",
 * "is not supported", or "model_not_found" depending on the API surface.
 *
 * Rate limits (429) and service-unavailable (503) are deliberately excluded —
 * those go through the existing retry path, not the fallback chain.
 */
function isModelNotFound(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('404') && (msg.includes('not found') || msg.includes('is not supported'))) return true;
  if (msg.includes('model_not_found') || msg.includes('model not found')) return true;
  if (msg.includes('not_found_error') && msg.includes('model')) return true;
  if (msg.includes('model') && msg.includes('does not exist')) return true;
  return false;
}

/**
 * Minimum length, in CHARACTERS, of a stable prompt prefix before it is worth
 * marking with an Anthropic `cache_control` breakpoint.
 *
 * Anthropic's minimum cacheable prefix is model-dependent and NOT monotonic
 * across generations: it is 4096 tokens on claude-haiku-4-5 — the Curator's
 * Anthropic default — and 1024 on every CURRENT fallback rung (sonnet-5,
 * sonnet-4-6, sonnet-4-5), i.e. four times LOWER, not higher. (This comment
 * previously cited 2048 on the claude-3-5-haiku rungs; those were removed in
 * 2026-08 after a live probe found all four returned 404.) Note the floor
 * below is applied without reference to the active model, so a cacheable
 * Sonnet prefix between ~4k and 16k chars is skipped — benign while Sonnet is
 * only ever a fallback, worth revisiting if that changes. A prefix
 * below the model's minimum is silently NOT cached (no error, no write charge,
 * `cache_creation_input_tokens: 0`), so a too-short breakpoint is harmless but
 * pointless. 16,000 chars is ~4,000 tokens at the ~4 chars/token typical of
 * English prose, i.e. the floor at which the default model can cache at all.
 * Being wrong in either direction is cheap: too low → a no-op marker, too high
 * → we skip a cache we could have had.
 *
 * The COSTLY mistake is caching a prefix that is used exactly once — a cache
 * write is billed at 1.25x the base input rate (5-minute TTL), so a single-use
 * breakpoint makes the call 25% MORE expensive. That decision (is this prefix
 * reused?) belongs to the caller, which is why llm.js only enforces the size
 * floor and never sets a breakpoint on its own. Break-even is two calls:
 * 1.25x + 0.1x = 1.35x versus 2.0x uncached.
 */
export const ANTHROPIC_CACHE_MIN_PREFIX_CHARS = 16_000;

/**
 * Build the Anthropic user-message content for a prompt, optionally splitting it
 * into [stable prefix | volatile suffix] with a cache breakpoint on the prefix.
 *
 * Returns the plain string (i.e. today's exact payload) unless ALL hold:
 *   • cachePrefixChars is a positive integer strictly inside the prompt, and
 *   • the prefix is at least ANTHROPIC_CACHE_MIN_PREFIX_CHARS long.
 * Concatenating the two blocks reproduces the original prompt byte for byte.
 *
 * Exported for offline testing.
 */
export function buildAnthropicUserContent(userPrompt, cachePrefixChars) {
  const text = typeof userPrompt === 'string' ? userPrompt : '';
  const n = Number.isInteger(cachePrefixChars) ? cachePrefixChars : 0;
  if (n < ANTHROPIC_CACHE_MIN_PREFIX_CHARS) return text;
  if (n >= text.length) return text;             // nothing volatile left to vary
  return [
    { type: 'text', text: text.slice(0, n), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: text.slice(n) },
  ];
}

/**
 * THE CURATOR'S USAGE CONVENTION (both providers, no exceptions):
 *
 *   inputTokens       tokens processed at FULL price — CACHED TOKENS EXCLUDED
 *   cachedReadTokens  tokens served from cache (~0.1x on Anthropic)
 *   cacheWriteTokens  tokens written to cache (1.25x on Anthropic)
 *
 *   total prompt size = inputTokens + cachedReadTokens + cacheWriteTokens
 *
 * The two providers disagree on the wire and a consumer must never have to know
 * that: Gemini's `promptTokenCount` INCLUDES `cachedContentTokenCount`, while
 * Anthropic's `input_tokens` EXCLUDES its cached counterpart. We normalise to
 * the EXCLUSIVE (Anthropic) convention, so `inputTokens` means one thing
 * everywhere and a cost calculation never has to branch on provider. Keeping
 * both wire conventions would have made `inputTokens + cachedReadTokens * 0.1`
 * double-count on Gemini — silently, in whatever meters this first.
 *
 * Normalise Gemini's `usageMetadata` into that shape. Every field is optional on
 * the wire (older responses, partial candidates), so anything missing degrades
 * to 0 rather than throwing.
 */
export function normalizeGeminiUsage(md) {
  const u = md && typeof md === 'object' ? md : {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cached = num(u.cachedContentTokenCount);
  return {
    // Subtract the cached portion so this field carries the same meaning as
    // Anthropic's input_tokens. Clamped at 0 — a provider that ever reports
    // cached > prompt must not produce a negative that corrupts a running total.
    inputTokens:      Math.max(0, num(u.promptTokenCount) - cached),
    outputTokens:     num(u.candidatesTokenCount),
    cachedReadTokens: cached,
    // Gemini 2.5 implicit caching has no separate write charge, and the explicit
    // context-cache API (which does) is deliberately not used here.
    cacheWriteTokens: 0,
  };
}

/**
 * Normalise Anthropic's `usage` block into the same shape. Anthropic already
 * uses the exclusive convention documented on normalizeGeminiUsage —
 * `input_tokens` counts only what was billed at full price — so this is a
 * straight field rename.
 */
export function normalizeAnthropicUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    inputTokens:      num(u.input_tokens),
    outputTokens:     num(u.output_tokens),
    cachedReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
  };
}

/**
 * Invoke an optional usage callback. Contract (mirrors the v3.0.4 adapter
 * `onWarn` rule): a throwing callback must NEVER break the LLM call — usage
 * reporting is observability, not correctness. Diagnostics go to stderr because
 * this module is imported by the MCP child process, which reserves stdout for
 * JSON-RPC frames (v2.5.2).
 */
function reportUsage(onUsage, payload) {
  if (typeof onUsage !== 'function') return;
  try { onUsage(payload); }
  catch (err) { console.error(`[llm] onUsage callback threw (ignored): ${err && err.message}`); }
}

/**
 * Handle an output-token-limit (MAX_TOKENS) truncation, uniformly across
 * providers and response formats. Exported for offline unit testing.
 *
 * The behaviour DIFFERS by responseFormat, which is the whole point:
 *
 *   • JSON mode — a truncated JSON body is unparseable garbage, so we THROW.
 *     The message deliberately keeps the phrase "output token limit" so that
 *     `isOutputTokenLimit(err)` in ingest.js (and its consumers compile.js /
 *     the single-pass→multi-phase switch) keeps firing and the fallback
 *     ladders recover. The wording is CONTEXT-NEUTRAL — it no longer tells the
 *     caller to "split the source by chapter and ingest each separately" or to
 *     tune "the Phase 2 batch size in src/brain/ingest.js", because this single
 *     chokepoint is shared by chat, query, health-AI, shared-brain, compile and
 *     ingest. Callers that want feature-specific guidance (ingest, compile) add
 *     it at their own level.
 *
 *   • Text mode — a truncated PROSE answer is still useful (a 95%-complete chat
 *     answer beats a hard error). We RETURN the partial text with a clear,
 *     human-readable note appended, instead of discarding it. This is why the
 *     Chat tab used to surface the misleading ingest error on a long question
 *     (see the v3.0.7 fix): chat is text mode, and text mode should degrade,
 *     not fail.
 *
 * @param {string} providerName  'Gemini' | 'Claude'
 * @param {number} maxTokens     the budget that was hit (post-clamp for Anthropic)
 * @param {'text'|'json'} responseFormat
 * @param {string} partialText   whatever text was generated before truncation
 * @returns {string}             text-mode partial answer + note (json mode throws)
 */
export function handleOutputTokenLimit(providerName, maxTokens, responseFormat, partialText) {
  if (responseFormat === 'json') {
    throw new Error(
      `⚠ ${providerName} hit the output token limit (${maxTokens} tokens) on this call. ` +
      `The structured response was cut off before it could be completed and cannot be parsed. ` +
      `This is not a transient error — retrying identically will hit the same limit.`
    );
  }
  const text = typeof partialText === 'string' ? partialText : '';
  const note =
    `\n\n_[⚠ This answer was cut off because it reached the response length limit ` +
    `(${maxTokens} tokens). Ask a more specific or narrower question to see the rest.]_`;
  return text.trimEnd() + note;
}

/**
 * Extract the assistant's answer text from an Anthropic `Message.content` array.
 *
 * THE BUG THIS EXISTS TO CLOSE (v3.9.1). Both call sites used to read
 * `content[0].text`. That is only correct while the FIRST block is the text
 * block — and on `claude-sonnet-5` it routinely is not:
 *
 *   • The Curator never sends a `thinking` parameter. On Sonnet 5 (and the
 *     Opus 4.7+/Fable family) omitting it runs ADAPTIVE thinking, so the model
 *     decides per-prompt whether to think. On `claude-sonnet-4-6` and
 *     `claude-haiku-4-5` omitting it means no thinking at all. That asymmetry
 *     is the whole defect: measured over 3 trials with an ingest-shaped JSON
 *     prompt, sonnet-5 returned [thinking, text] 3/3 while 4-6 and haiku-4-5
 *     returned [text] 3/3.
 *   • A `thinking` block carries `.thinking`, never `.text`, so `content[0].text`
 *     was `undefined` and EVERY call threw the "returned no text content" error.
 *   • `claude-sonnet-5` is FALLBACK_CHAINS.anthropic[0]. The chain exists to keep
 *     users working the day the default is retired; rung 1 was dead on arrival.
 *   • It went uncaught because adaptive thinking is PROMPT-DEPENDENT: a trivial
 *     `Return {"ok":true}` smoke probe returns [text] and passes green while a
 *     real ingest prompt fails. Do not "verify" this path with a toy prompt.
 *
 * WHY IT CONCATENATES rather than taking the first text block. One response can
 * legitimately carry SEVERAL text blocks — citations split a reply into multiple
 * text blocks, and a server-side refusal fallback interleaves a `fallback` block
 * between them. Taking only the first would silently truncate: unparseable JSON
 * in json mode, and a partial prose answer presented as complete in text mode —
 * i.e. paid-for content dropped with a green result, this project's recorded
 * silent-data-loss shape. Blocks are contiguous pieces of one string, so they
 * join with '' (a separator would corrupt JSON). With a single text block this
 * is byte-identical to picking that block, so the common path is unchanged.
 *
 * Matching is on `type === 'text'`, the documented discriminant of the content
 * union — NOT on "has a .text string". A future block type that happens to carry
 * a `.text` field would otherwise be spliced into the answer.
 *
 * @param {unknown} content  `message.content`
 * @returns {string|null}  concatenated text, or null when there is NO text-typed
 *   block at all. null is the caller's signal to throw: a tool-use-only or empty
 *   response is a real failure and must never degrade to a silent empty string.
 *   A present-but-empty text block returns '' — matching the pre-fix behaviour
 *   for that shape, which is a genuine (if odd) model output, not an absence.
 */
export function extractAnthropicText(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length === 0 ? null : parts.join('');
}

/**
 * TEST-ONLY seam. Replaces the Anthropic client constructor so an OFFLINE suite
 * can drive the real generateText → callLLM → callProvider path (retry loop and
 * fallback chain included) against synthetic `finalMessage()` shapes, with no
 * network and no spend. Null in production, where `new Anthropic(...)` is used
 * exactly as before — same pattern and rationale as config.js's
 * `__setDomainsDirOverride` and compile.js's `opts.generateText`.
 *
 * Resolved PER CALL, never snapshotted at module load: a top-level
 * `const client = ...` would make the override silently import-order dependent
 * (the v3.1.0 finding).
 */
let _anthropicClientFactoryOverride = null;
export function __setAnthropicClientFactory(factory) {
  _anthropicClientFactoryOverride = typeof factory === 'function' ? factory : null;
}

/**
 * Invoke a specific provider+model. No retry/fallback here — pure dispatch.
 * Called by `callLLM` which handles fallback, and by the retry loop in `generateText`.
 *
 * @param {{onUsage?: function, cachePrefixChars?: number}} [opts]
 *   onUsage          — invoked once per COMPLETED provider call with normalised
 *                      token counts (see reportUsage). Fired before the
 *                      truncation check, because a truncated response is a call
 *                      that ran and was billed.
 *   cachePrefixChars — Anthropic only. Length of the stable leading portion of
 *                      userPrompt; a `cache_control` breakpoint is placed there
 *                      when it clears ANTHROPIC_CACHE_MIN_PREFIX_CHARS. Gemini
 *                      ignores it (2.5-family models do implicit prefix caching
 *                      with no API change).
 */
async function callProvider(provider, model, systemPrompt, userPrompt, maxTokens, responseFormat, opts = {}) {
  // v3.3.x: null unless the caller threaded one through generateText.
  const signal = opts.signal || null;
  // Cheapest possible cancellation point — before the client is even built.
  throwIfAborted(signal);

  // ── Google Gemini ────────────────────────────────────────────────────────
  if (provider === 'gemini') {
    const genAI = new GoogleGenerativeAI(getEffectiveKey('gemini'));
    const geminiModel = genAI.getGenerativeModel({
      model,
      systemInstruction: systemPrompt,
    });
    const generationConfig = { maxOutputTokens: maxTokens };
    if (responseFormat === 'json') {
      // Forces Gemini to output structurally valid JSON, preventing
      // unescaped markdown characters (backticks, quotes) from breaking parsing.
      generationConfig.responseMimeType = 'application/json';
    }
    // The two-branch call (rather than passing `{signal: undefined}`) keeps the
    // no-signal path byte-identical to the pre-cancellation code: the SDK sees
    // exactly the same one-argument invocation it always did.
    const geminiRequest = {
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig,
    };
    const result = signal
      ? await geminiModel.generateContent(geminiRequest, { signal })
      : await geminiModel.generateContent(geminiRequest);
    // v3.0.1-beta.8: detect output-budget truncation. Gemini returns
    // `finishReason: "MAX_TOKENS"` on the first candidate when its response
    // exceeded `maxOutputTokens`. Pre-fix this surfaced as the
    // "AI returned malformed JSON twice in a row" message at parseJSON time —
    // misleadingly framed as "transient" when in fact the next attempt would
    // hit the same wall.
    //
    // v3.0.7: routed through handleOutputTokenLimit — JSON mode still throws
    // (so ingest/compile fallbacks recover), but TEXT mode (chat, query) now
    // returns the partial answer with a note instead of hard-failing on a
    // misleading ingest-specific error.
    reportUsage(opts.onUsage, {
      provider: 'gemini', model,
      ...normalizeGeminiUsage(result?.response?.usageMetadata),
    });
    const finishReason = result?.response?.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      let partial = '';
      try { partial = result.response.text(); } catch { /* candidate had no text part */ }
      return handleOutputTokenLimit('Gemini', maxTokens, responseFormat, partial);
    }
    return result.response.text();
  }

  // ── Anthropic Claude ─────────────────────────────────────────────────────
  // Note: Anthropic's API has no native JSON mode equivalent. Prompts that ask
  // for JSON rely on the "Return ONLY valid JSON" directive in the system prompt
  // plus the jsonrepair fallback in parseJSON (see src/brain/ingest.js).
  const anthropicOptions = { apiKey: getEffectiveKey('anthropic') };
  const client = _anthropicClientFactoryOverride
    ? _anthropicClientFactoryOverride(anthropicOptions)
    : new Anthropic(anthropicOptions);

  // Clamp to THIS model's hard output cap. Call sites pass 65536 (right for
  // Gemini), which the Anthropic API rejects outright as "max_tokens: 65536 >
  // 64000" on Haiku. Per-model since 2026-08-24: a flat 64000 silently halved
  // the real 128,000 ceiling of the Sonnet 5 / Sonnet 4.6 fallback rungs. An
  // unrecognised id resolves to the conservative 64000 — see
  // anthropicMaxOutputTokens.
  const effectiveMaxTokens = Math.min(maxTokens, anthropicMaxOutputTokens(model));

  // Use the streaming transport, NOT messages.create(). The SDK (>=0.39) throws
  // "Streaming is strongly recommended for operations that may take longer than
  // 10 minutes" for ANY non-streaming call whose max_tokens implies a computed
  // timeout over 10 min — which fires for any budget above ~21,333 tokens,
  // regardless of model or actual response time. messages.stream() uses a fixed
  // 600s timeout and skips that guard. .finalMessage() assembles and returns the
  // identical Message object, so the stop_reason / content checks below are
  // unchanged. (Compile + single-pass ingest both request 65536 → both hit this
  // on Anthropic before this fix.)
  const anthropicBody = {
    model,
    max_tokens: effectiveMaxTokens,
    system: systemPrompt,
    // Either the plain prompt string (unchanged payload) or a two-block split
    // with a cache breakpoint on the stable prefix — see buildAnthropicUserContent.
    messages: [{ role: 'user', content: buildAnthropicUserContent(userPrompt, opts.cachePrefixChars) }],
  };
  // Same two-branch shape as the Gemini call above, and for the same reason:
  // with no signal the SDK is invoked exactly as before. `RequestOptions.signal`
  // is honoured by messages.stream() (SDK 0.39) and aborts the HTTP request.
  const message = await (signal
    ? client.messages.stream(anthropicBody, { signal })
    : client.messages.stream(anthropicBody)
  ).finalMessage();
  // `.finalMessage()` assembles the streamed events into the same Message object
  // a non-streaming call returns, including the accumulated `usage` block.
  reportUsage(opts.onUsage, {
    provider: 'anthropic', model,
    ...normalizeAnthropicUsage(message?.usage),
  });
  // v3.0.1-beta.8: detect Anthropic output-budget truncation. When the model
  // hits `max_tokens` mid-response, Anthropic returns
  // `stop_reason: "max_tokens"` and the `text` field contains the partial
  // JSON. Pre-fix this manifested as a deterministic JSON parse failure that
  // the v3.0.1-beta.7 retry-with-stricter-JSON path could never resolve
  // (because the underlying issue was budget, not prompt obedience).
  //
  // Especially impactful for Anthropic users because they have no JSON-mode
  // safety net — Gemini's MAX_TOKENS check (above) catches the analogous
  // condition there.
  // v3.0.7: routed through handleOutputTokenLimit — JSON mode still throws
  // (preserving the "output token limit" phrase isOutputTokenLimit matches on,
  // so ingest/compile fallbacks recover), but TEXT mode (chat, query) returns
  // the partial answer with a note instead of a misleading ingest error.
  if (message.stop_reason === 'max_tokens') {
    // Position-independent: a truncated Sonnet 5 response is [thinking, text],
    // so first-block indexing handed handleOutputTokenLimit an EMPTY partial and
    // a cut-off-but-useful chat answer arrived as nothing but the truncation note.
    const partial = extractAnthropicText(message?.content) ?? '';
    return handleOutputTokenLimit('Claude', effectiveMaxTokens, responseFormat, partial);
  }
  // Defensive: there may be no text block at all if the assistant produced only
  // tool-use blocks (shouldn't happen for these prompts, but better to
  // surface a clear error than to throw an obscure "undefined.text"). This is
  // the ONLY remaining throw case — a text block that is merely not first is a
  // normal response and now extracts correctly.
  const answerText = extractAnthropicText(message?.content);
  if (answerText === null) {
    throw new Error(
      `⚠ Claude returned no text content (stop_reason: ${message.stop_reason || 'unknown'}). ` +
      `This is rare and usually transient — try again. If it persists, switch ` +
      `provider in Settings.`
    );
  }
  return answerText;
}

/**
 * Call the active LLM with automatic fallback on model-not-found errors.
 *
 * Order of attempts:
 *   1. Primary model from DEFAULTS / LLM_MODEL env override
 *   2. Each entry in FALLBACK_CHAINS[provider]
 *
 * Only "model not found" errors trigger the next attempt. Any other error
 * (auth, rate-limit, network, 5xx) is re-thrown immediately so the outer
 * retry loop or caller can handle it appropriately.
 */
async function callLLM(systemPrompt, userPrompt, maxTokens, responseFormat, providerOverride = null, opts = {}) {
  // opts.model is the caller's per-call model choice, already narrowed to a
  // non-empty string by generateText and allow-listed inside getProviderInfo.
  // The fallback chain below is deliberately the PROVIDER's chain either way: if
  // a user-picked model is retired mid-session, the right recovery is still the
  // cheapest live model on that provider, not silence.
  const { provider, model } = getProviderInfo(providerOverride, opts.model || null);
  // Deduped: a user-picked model that is ALSO a fallback rung (e.g. a deliberate
  // claude-sonnet-5) would otherwise be retried against its own 404 before the
  // walk moved on. A no-op for the default path — no chain contains its own
  // provider's default (asserted in test-chat-model.js §9).
  const chain = [...new Set([model, ...(FALLBACK_CHAINS[provider] || [])])];
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i];
    try {
      const result = await callProvider(provider, candidate, systemPrompt, userPrompt, maxTokens, responseFormat, opts);

      if (i === 0) {
        // Primary succeeded — clear any previous fallback state for this provider.
        // Diagnostics use console.error so this module is safe to import from
        // the MCP child process (stdout reserved for JSON-RPC) — v2.5.2.
        if (_activeFallback && _activeFallback.provider === provider) {
          console.error(`[llm] Primary model "${model}" is available again — clearing fallback state.`);
          _activeFallback = null;
        }
      } else {
        // A fallback succeeded — record for the UI to surface
        _activeFallback = {
          provider,
          requestedModel: chain[0],
          usingModel: candidate,
          at: new Date().toISOString(),
        };
        console.warn(
          `[llm] Primary model "${chain[0]}" is unavailable; using fallback "${candidate}". ` +
          `Please run "Check for Updates" in Settings to upgrade to a current model.`
        );
      }
      return result;
    } catch (err) {
      // Checked BEFORE isModelNotFound: walking the fallback chain on a cancel
      // would issue MORE provider calls (up to 5 more rungs) after the user
      // asked us to stop — the single worst thing this code could do here.
      if (isAbortError(err) || (opts.signal && opts.signal.aborted)) throw makeAbortError();
      if (isModelNotFound(err) && i < chain.length - 1) {
        console.warn(`[llm] Model "${candidate}" returned "not found"; trying fallback "${chain[i + 1]}"...`);
        lastErr = err;
        continue;
      }
      // Non-deprecation error, or out of fallbacks — propagate
      throw err;
    }
  }
  // Should be unreachable — the loop either returns or throws — but be safe
  throw lastErr || new Error(`All ${provider} models failed`);
}

/**
 * Test-only surface. Lets an offline suite assert the standing invariants that
 * EVERY model id this app can run — default, fallback rung, or user-offerable —
 * is present in the price table and the output-cap map, so adding one without
 * its price fails the suite instead of silently downgrading the user's cost
 * warning to 'unknown', and adding one without its cap fails instead of
 * silently clamping to a conservative guess.
 */
export const __testing = {
  DEFAULTS, FALLBACK_CHAINS, MODEL_PRICES_USD_PER_MTOK, reportUsage,
  ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS, GEMINI_MODEL_MAX_OUTPUT_TOKENS,
  PROMOTIONAL_PRICES, OFFERABLE_SUITABILITY,
  // Exposed so the suite can attempt to build a deliberately under-specified
  // entry and assert the factory REFUSES it — proving "a model may not be
  // offerable unless it is fully specified" is structural, not a convention.
  defineOfferableModel,
};
