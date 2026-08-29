/**
 * OpenRouter — OpenAI-compatible chat-completions adapter.
 *
 * WHY THIS IS AN ADAPTER RATHER THAN AN SDK IMPORT. OpenRouter speaks the
 * OpenAI `/v1/chat/completions` wire format, and so do LM Studio, Ollama and
 * llama.cpp. Everything below is therefore written against a CONFIGURABLE BASE
 * URL and a raw `fetch`, so the same class can serve a local model server later
 * by changing one string. Adding the `openai` SDK would have bought nothing here
 * (we use one endpoint) and would have coupled a future local-model story to a
 * hosted vendor's client.
 *
 * WHY `fetchImpl` IS INJECTABLE FROM DAY ONE. `llm.js` has an
 * `__setAnthropicClientFactory` seam for Anthropic and NOTHING equivalent for
 * Gemini, which is why the Gemini branch has never been driven offline. That gap
 * must not be inherited on a third provider: every request this module makes
 * goes through `this._fetch`, so an offline suite can drive the real classifier,
 * the real usage normaliser and the real error paths with no network and no
 * spend. Modelled on `sharedbrain-github-adapter.js`, which does the same.
 *
 * SECURITY.
 *   - The API key lives only on the instance, is used only as the value of the
 *     Authorization header, and is redacted from EVERY string this module can
 *     throw — by exact-value replacement first, then by prefix patterns, and
 *     ALWAYS before any truncation (a key at byte 195 of a 200-char slice would
 *     otherwise survive as a partial leak; that is the exact bug the GitHub
 *     adapter's `sanitizeDetail` was written to close).
 *   - `redactOpenRouterSecrets` is exported so a suite can prove no key bytes
 *     reach any thrown message.
 *
 * CLASSIFICATION IS STRUCTURAL. OpenRouter returns `{"error":{"message","code"}}`
 * where `error.code` is NUMERIC and equals the HTTP status, so every decision
 * below keys off the status. This repo has a recorded finding where a bare
 * `/\b429\b/` substring test matched ingest's own "yielded only 429 characters"
 * message; nothing here classifies by substring.
 *
 * ⚠ MID-STREAM ERRORS ARRIVE WITH HTTP 200. A failure that happens after the
 * response has started is reported in-band as `finish_reason: "error"` (plus an
 * `error` object on the choice). A status-only classifier reads that as success
 * and hands the caller a truncated answer. `parseChatCompletion` refuses it.
 *
 * MEASURED 2026-08-27 over ~60 live calls ($0.086 of real spend). Recorded here
 * because each of these replaced a claim this file used to make that was wrong:
 *   - `usage` (including `usage.cost`) is returned on EVERY call WITHOUT sending
 *     `usage: {include: true}` — 60/60. See `_buildBody`, which used to explain
 *     its own decision with the opposite claim.
 *   - `usage.cost` IS USD 1:1. Our catalogue-derived arithmetic and OpenRouter's
 *     own reported cost agreed to six decimal places per call (computed
 *     $0.001391 vs reported 0.001391284). This was previously listed below as
 *     unverified; it is settled, and `llm.js`'s price table records the same
 *     cross-check at its OpenRouter entries.
 *   - `X-Provider-Name` was NOT SEEN on any of the ~60 calls. It is advertised in
 *     CORS `access-control-expose-headers`, which is a statement about what a
 *     browser may read, NOT evidence that the header is ever sent. Absence is the
 *     measured normal case.
 *   - A 429 is NOT a free-tier phenomenon: 18 consecutive 429s were measured on a
 *     PAID model (`openai/gpt-oss-20b`) at both 1.5s and 45s spacing.
 *   - `provider: {data_collection: 'deny'}` — see the ⚠ block in `_buildBody`.
 *
 * NOT VERIFIED, and deliberately not depended on (see docs/model-lifecycle.md
 * for the standing rule that an unmeasured claim is not a fact):
 *   - `X-Generation-Id`. Captured when present, `null` otherwise, never branched
 *     on. `body.id` is the documented fallback and is what actually arrives.
 *   - Behaviour when `max_tokens` exceeds a model's own ceiling (400 vs clamp).
 *   - The request-timeout ceiling. A 408 exists; the threshold is undocumented.
 *   - Any RATE-LIMIT FIGURE. OpenRouter's docs render that table as JS components
 *     and it came through empty, so this project has never been able to verify a
 *     number and must never print one. `validateKey()` reports the live figures
 *     for the key in hand; that is the only honest source.
 */

// ── THE ONE IMPORT, AND WHY IT DOES NOT FORM A CYCLE ────────────────────────
// This module was deliberately import-free so it could never reach back into
// `llm.js` (which imports it). That property is PRESERVED, not abandoned:
// `openrouter-eligibility.js` is itself import-free, so adapter -> eligibility
// is a leaf edge and no cycle exists. The alternative — re-deriving the
// admissibility rules here — is the two-hand-maintained-copies shape this repo
// names as the cause of the v3.2.0 CRITICAL, on a spend surface.
//
// NAMESPACE import for the reason recorded at the top of `src/routes/config.js`:
// a named import of an export that is absent or renamed throws a SyntaxError AT
// MODULE LOAD and takes down every consumer of this file. `buildOpenRouterCatalogue`
// turns the missing case into a named refusal instead.
import * as eligibilityModule from './openrouter-eligibility.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Default wire endpoint. Overridable so this class can serve a local server. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Optional attribution headers. CONSTANT and NON-IDENTIFYING by construction:
 * the project's public repository URL and its public name, never a username,
 * a local path, a domain name, a wiki title or anything derived from user data.
 * OpenRouter documents these as attribution-only with no routing or rate effect,
 * so sending them can never change what a user is billed.
 *
 * Off unless the caller asks (`attribution: true`) — a local-first app should not
 * announce itself to a third party by default.
 */
export const OPENROUTER_ATTRIBUTION = Object.freeze({
  referer: 'https://github.com/talirezun/the-curator',
  title: 'The Curator',
});

/** Default per-request ceiling. Matches the 600s the Anthropic stream transport uses. */
export const OPENROUTER_DEFAULT_TIMEOUT_MS = 600_000;

// ── Secret redaction ─────────────────────────────────────────────────────────

/**
 * OpenRouter keys carry an `sk-or-v1-` prefix. The exact length and charset are
 * UNDOCUMENTED, so these anchor on the prefix plus a generous run rather than a
 * fixed length — a regex pinned to today's length would silently stop redacting
 * the day the format widens, which is the failure mode that matters here.
 *
 * `Bearer <something>` is matched too, so a proxy echoing our own request header
 * back cannot leak a key shape we did not anticipate.
 */
const SECRET_PATTERNS = [
  /sk-or-v1-[A-Za-z0-9._~+/=-]{8,}/g,
  /sk-or-[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9._~+/=-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * Redact credential-shaped text. `exact` (the live key) is replaced FIRST and by
 * literal string match, so redaction cannot depend on the key matching a pattern
 * we guessed. Exported for the leak audit.
 *
 * @param {unknown} s
 * @param {string|null} [exact] the live key, replaced verbatim wherever it appears
 * @returns {string}
 */
export function redactOpenRouterSecrets(s, exact = null) {
  if (typeof s !== 'string') return '';
  let out = s;
  if (typeof exact === 'string' && exact.length >= 8) {
    out = out.split(exact).join('[redacted-api-key]');
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted-api-key]');
  return out;
}

/**
 * ── THE CENSUS THE NEUTRALISERS BELOW MUST COVER ─────────────────────────────
 *
 * Every MESSAGE SUBSTRING `llm.js`'s retry gate (`is429` / `is503`) keys on.
 * It lives HERE, beside the neutraliser whose whole job is to strip it, and
 * `llm.js` imports it back to prove its classifiers really do trip on each
 * entry — so the two ends of one contract are declared once instead of being
 * hand-mirrored in a prose comment.
 *
 * IT IS DECLARED BECAUSE HAND-MIRRORING IT ALREADY FAILED. This docblock used
 * to enumerate five substrings ("429" / "503" / "overloaded" / "Too Many
 * Requests" / "Service Unavailable") while `is429` keyed on SEVEN — an
 * incomplete census of its own dependency, written in prose where nothing
 * could check it. The missing one was `RESOURCE_EXHAUSTED`, and it leaked:
 * measured, `"quota exceeded: RESOURCE_EXHAUSTED for model X"` passed through
 * this function completely unchanged and satisfied `is429`, so a 402
 * insufficient-credits whose detail carried the token bought ~40 s of retries
 * and then the generic "infrastructure is temporarily overloaded … affects ALL
 * accounts equally" — a user in arrears told the provider was down.
 *
 * Two hand-maintained lists that must agree is this repo's v3.2.0 CRITICAL
 * shape, and it had produced two leaks in this one function pair. One list,
 * one direction of import, one load-time proof.
 */
export const RETRY_CLASSIFIER_TOKENS = Object.freeze([
  '429', 'Too Many Requests', 'RESOURCE_EXHAUSTED',   // is429
  '503', 'Service Unavailable', 'high demand', 'overloaded',   // is503
]);

/**
 * Strip tokens a MESSAGE-SUBSTRING classifier would misread as "transient".
 *
 * `generateText`'s retry gate is `is429`/`is503`, which scan the whole error
 * MESSAGE for the substrings in RETRY_CLASSIFIER_TOKENS above. Our error
 * messages embed the upstream's own `message` field, which is attacker-adjacent
 * text we do not control: a 400 whose detail happens to contain "503" would
 * otherwise burn four retries with ~40s of backoff on a permanently-fatal
 * request.
 *
 * Applied ONLY to the echoed detail of a NON-transient status, and never to the
 * status token we add ourselves. The failure direction is safe: a genuinely
 * transient condition mis-filed as fatal surfaces to the user immediately, which
 * is strictly better than silently retrying something that cannot succeed —
 * which is also why every rule here is deliberately case-INSENSITIVE while
 * `is429`/`is503` are case-SENSITIVE: over-neutralising is the safe direction.
 */
function neutralizeRetrySignals(detail) {
  return detail
    .replace(/\b(?:429|503)\b/g, '###')
    .replace(/too many requests/gi, 'rate-limited')
    .replace(/service unavailable/gi, 'unavailable')
    .replace(/overloaded/gi, 'saturated')
    .replace(/high demand/gi, 'heavy load')
    // The leak this census was written to catch. Replaced with text carrying
    // neither `RESOURCE_EXHAUSTED` nor `429`, in any case.
    .replace(/resource[_\s-]?exhausted/gi, 'quota-spent');
}

// ── Typed errors ─────────────────────────────────────────────────────────────

export class OpenRouterError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'OpenRouterError';
    /** Stable string tag — see classifyOpenRouterStatus. */
    this.code = code;
    if (Number.isFinite(status)) this.status = status;
  }
}

/**
 * HTTP status → stable tag. STRUCTURAL, never substring.
 *
 * Note 401 vs 404: OpenRouter checks the key BEFORE model existence, so a bogus
 * key with a bogus model returns 401 and NOT 404. A caller must therefore never
 * infer "the model is gone" from a failure that did not carry 404.
 */
export function classifyOpenRouterStatus(status) {
  switch (status) {
    case 400: return 'OPENROUTER_BAD_REQUEST';
    case 401: return 'OPENROUTER_AUTH';
    case 402: return 'OPENROUTER_INSUFFICIENT_CREDITS';
    case 403: return 'OPENROUTER_MODERATION';
    case 404: return 'OPENROUTER_MODEL_NOT_FOUND';
    case 408: return 'OPENROUTER_TIMEOUT';
    case 429: return 'OPENROUTER_RATE_LIMIT';
    case 502: return 'OPENROUTER_UPSTREAM_DOWN';
    case 503: return 'OPENROUTER_NO_PROVIDER';
    default:  return status >= 500 ? 'OPENROUTER_SERVER_ERROR' : 'OPENROUTER_HTTP_ERROR';
  }
}

/**
 * Statuses whose message may carry the numeric token that drives the retry loop.
 *
 * 503 WAS HERE AND IS NOT ANY MORE, and the reason is the whole of the 503
 * handling below: with `allow_fallbacks:false` + `require_parameters:true`, a
 * 503 means "no upstream provider met the required parameters", which is a
 * CAPABILITY mismatch, not an availability blip. A capability does not appear
 * mid-backoff, so the request cannot succeed on retry — and in this codebase the
 * literal "HTTP 503" in a message is a WIRE SIGNAL meaning transient
 * (`ingest-queue.js`'s `TRANSIENT_PATTERNS` matches `/\bHTTP\s+503\b/i` as a
 * fallback for a caller that re-wrapped the error and lost the properties).
 * Emitting that sentinel for a deterministic failure is the producer emitting a
 * token it does not mean — the same rule `readsAsRecoverable` states in llm.js.
 *
 * 429 stays: a rate limit genuinely clears with time.
 *
 * ── ⚠ WHAT THE WIRE ACTUALLY DOES, MEASURED — IT IS NOT 503 ────────────────
 * The paragraph above describes the SPEC's assumption, and a live probe
 * contradicts it. When no upstream can satisfy `require_parameters`, OpenRouter
 * answers **404**, not 503, with *"No endpoints found that can handle the
 * requested parameters"*.
 *
 * FIXED, not merely recorded — see `ROUTING_CONSTRAINT_404_CLAUSES` and
 * `classifyNotFoundReason` below for the measurement and the decision, and the
 * 404 branch of `_throwForStatus` for the behaviour. In short: a 404 is now
 * classified from the upstream's own message into constraint / retirement /
 * unknown, and only a measured RETIREMENT is allowed to walk the fallback chain.
 *
 * The 503 handling below is UNCHANGED and still correct. Both statuses can carry
 * a routing-constraint failure and both are therefore tagged
 * `curatorDeterministic`; the difference is only that a 404 additionally has to
 * have its `isModelNotFound` signals withheld, because 503 was never one.
 */
const TRANSIENT_STATUSES = new Set([429]);

/**
 * Strip vocabulary that makes an error read as "the model is gone", which in
 * llm.js drives a FALLBACK-CHAIN WALK — i.e. up to four more paid calls.
 *
 * Applied ONLY to the echoed detail of an IN-BAND (HTTP-200) failure. A real
 * "this model does not exist" arrives as HTTP 404 and is classified from the
 * status, structurally; an in-band 404 on a 200 means the upstream started
 * answering and then claimed the model was missing, which is incoherent — and
 * honouring it would let a third party's prose spend the user's money. The
 * failure direction is safe: at worst a genuinely-missing model surfaces to the
 * user instead of silently walking a chain.
 */
function neutralizeNotFoundSignals(detail) {
  return detail
    .replace(/\bmodel[_\s]not[_\s]found\b/gi, 'model unavailable')
    // ⚠ NO TRAILING \b, AND THAT IS THE FIX. `\b` after "found" cannot match
    // inside `not_found_error`, because `_` is a WORD character — so there is
    // no boundary there and the previous `\bnot[_\s]found\b` left the string
    // completely untouched. `isModelNotFound` has a SEPARATE clause,
    // `'not_found_error' && 'model'`, which nothing here was stripping:
    // measured, `{"error":{"type":"not_found_error","message":"model: …"}}`
    // came out byte-identical and classified as MODEL-NOT-FOUND, i.e. a
    // fallback-chain walk — up to four more paid calls — driven by a third
    // party's own JSON. `not_found_error` is Anthropic's error-type string and
    // OpenRouter proxies Anthropic models, so this is the ordinary shape, not
    // a contrived one.
    //
    // `\w*` swallows any suffix (`_error`, `_exception`, …), so the whole
    // family is closed rather than the one instance that was reported.
    .replace(/\bnot[_\s]found\w*/gi, 'unavailable')
    .replace(/\bis not supported\b/gi, 'is unsupported')
    .replace(/\bdoes not exist\b/gi, 'is unavailable')
    .replace(/\b404\b/g, '###');
}

/**
 * ── `isModelNotFound`'s MESSAGE HALF, AS DATA ────────────────────────────────
 *
 * One inner array per clause; a clause matches when EVERY string in it appears
 * in the lower-cased message. This mirrors `llm.js`'s `isModelNotFound` minus
 * its `err.status === 404` rung, which is structural and never neutralised
 * (a real HTTP 404 SHOULD classify as model-not-found — that is the correct
 * answer, and it is decided from the status, not from prose).
 *
 * The point of expressing it as data rather than prose: the load-time guard
 * below synthesises a probe per clause by joining its conjuncts, so ADDING A
 * CLAUSE AUTOMATICALLY ADDS A PROBE. A conjunction only needs ONE conjunct
 * broken to be defeated, which is why neutralising `model` — a word in almost
 * every message — is neither necessary nor wanted.
 */
export const MODEL_NOT_FOUND_CLAUSES = Object.freeze([
  Object.freeze(['404', 'not found']),
  Object.freeze(['404', 'is not supported']),
  Object.freeze(['model_not_found']),
  Object.freeze(['model not found']),
  Object.freeze(['not_found_error', 'model']),
  Object.freeze(['model', 'does not exist']),
]);

/**
 * ── NOT EVERY 404 MEANS "THIS MODEL IS GONE" ─────────────────────────────────
 *
 * MEASURED LIVE 2026-08-28 against the real endpoint with the real key. Four
 * probes, two of them the pair that matters:
 *
 *   requested                                  wire  upstream message
 *   ─────────────────────────────────────────  ────  ─────────────────────────
 *   poolside/laguna-s-2.1     + response_format 404  "No endpoints found that
 *   tencent/hy-mt2-1.8b       + response_format 404   can handle the requested
 *                                                     parameters."
 *   poolside/laguna-s-2.1     TEXT mode         200  (answers normally)
 *   openai/gpt-3.5-turbo-0301 TEXT mode         404  "No endpoints found for
 *                                                     openai/gpt-3.5-turbo-0301."
 *   acme/totally-not-a-real-model-xyz           400  "… is not a valid model ID"
 *
 * Three facts fall out, and each one changes a decision:
 *
 *  1. A CAPABILITY MISMATCH IS A 404, NOT A 503. The block below `TRANSIENT_
 *     STATUSES` used to assume 503 and recorded its own assumption as wrong
 *     without acting on it. `isModelNotFound()` fires on that 404 twice over
 *     (`err.status === 404`, and `'404' + 'not found'` in our own prose), so
 *     llm.js walked the OpenRouter fallback chain onto a PAID rung. A mismatch
 *     between what we require and what an upstream offers was being silently
 *     converted into a paid substitution the user never asked for. The chain
 *     exists for model RETIREMENT; this is not retirement.
 *  2. THE SAME MODEL ANSWERS FINE IN TEXT MODE. So the 404 is a statement about
 *     the REQUEST, not about the model — it is not gone, and swapping models is
 *     a choice the user should make, not one we should make for them silently.
 *  3. A BOGUS MODEL ID IS A **400**, not a 404. The 404 space is therefore
 *     narrower than assumed: every 404 measured here opens "No endpoints found",
 *     and what follows says whether OpenRouter is talking about THE MODEL
 *     ("… for <id>.") or about OUR ROUTING CONSTRAINTS ("… that can handle the
 *     requested parameters", "… matching your data policy"). Only the first is
 *     a retirement.
 *
 * A THIRD CONSTRAINT SHAPE IS ALREADY DOCUMENTED IN THIS FILE and is REACHABLE
 * TODAY: `_buildBody`'s ⚠ block records that an ACCOUNT-LEVEL data policy 404s a
 * catalogued free model with nothing special sent at all
 * (`nvidia/nemotron-3-super-120b-a12b:free`), and closes with "so a 404 on a
 * `:free` id is not automatically a retired model". `minimax/minimax-m3:free` is
 * a shipped, offerable build-lane model and `FALLBACK_CHAINS.openrouter[0]` is
 * the PAID `ibm-granite/granite-4.0-h-micro`. So this is not only the latent
 * capability case: a user on the free model whose account carries a training
 * policy would have been moved onto a paid model, silently, today.
 *
 * ── WHY THIS IS A TABLE AND NOT AN `if` AT THE CALL SITE ────────────────────
 * Same reason `MODEL_NOT_FOUND_CLAUSES` above is one: this repo's recurring
 * defect is two hand-maintained copies of one guard drifting apart. One table,
 * one classifier, one call site, and the load-time block below probes every
 * clause automatically, so adding a clause adds its own proof.
 *
 * Each entry's `match` is a CONJUNCTION over the lower-cased upstream message.
 * `capability` is the human half — what The Curator asked for that could not be
 * met — because "pick a different model" is only actionable if the user is told
 * what the model failed to do.
 */
export const ROUTING_CONSTRAINT_404_CLAUSES = Object.freeze([
  Object.freeze({
    match: Object.freeze(['no endpoints found', 'requested parameters']),
    capability:
      'the request parameters The Curator requires — structured JSON output on ' +
      'wiki-building calls, and no silent substitution of a different provider',
  }),
  Object.freeze({
    match: Object.freeze(['no endpoints found', 'data policy']),
    capability:
      "this OpenRouter account's data policy — check the privacy settings on " +
      'openrouter.ai, which can make a model unreachable without changing anything here',
  }),
]);

/**
 * The ONE measured shape that means the model itself has no endpoints, i.e. a
 * genuine retirement, i.e. the case `FALLBACK_CHAINS` exists for.
 *
 * SUPPORTING OBSERVATION, deliberately NOT made a second conjunct: this message
 * echoes the REQUESTED MODEL ID and the constraint messages do not, which is why
 * the two are structurally distinguishable rather than merely differently
 * worded. It is not required as a gate because OpenRouter's echo need not be
 * byte-identical to what we sent (a `:free` suffix could plausibly be stripped),
 * and a gate that fails on a real retirement would defeat the safety net this
 * clause exists to preserve.
 */
export const MODEL_RETIRED_404_CLAUSES = Object.freeze([
  Object.freeze(['no endpoints found for']),
]);

/**
 * Why did this 404 happen — our routing constraints, or the model being gone?
 *
 * THREE-VALUED ON PURPOSE, and the third value is the point. This repo's most
 * expensive recurring defect is a FACT AND ITS ABSENCE collapsed into one value
 * (v3.15.0 found it in eight places in one release). "We could not tell" is not
 * "it is a retirement" and it is not "it is a constraint" — it is its own
 * answer, and the caller must be able to act on it differently.
 *
 *   'routing-constraint' — measured: our own requirements could not be met.
 *   'model-retired'      — measured: this model has no endpoints at all.
 *   null                 — the upstream said something we have never measured,
 *                          or said nothing at all (a non-JSON 404 body).
 *
 * CONSTRAINTS ARE TESTED FIRST. The two sets are disjoint today and the load-time
 * block below proves it, but if a future clause ever made a message match both,
 * the safe verdict must win rather than depend on iteration order.
 *
 * @param {unknown} message  the upstream's OWN `error.message`, before any of
 *   our prose is added — the narrowest possible input, so this can never be a
 *   substring test over a whole assembled error string (this repo shipped a bare
 *   `/\b429\b/` that matched ingest's own "yielded only 429 characters").
 * @returns {'routing-constraint'|'model-retired'|null}
 */
export function classifyNotFoundReason(message) {
  if (typeof message !== 'string' || message.length === 0) return null;
  const m = message.toLowerCase();
  for (const c of ROUTING_CONSTRAINT_404_CLAUSES) {
    if (c.match.every(t => m.includes(t))) return 'routing-constraint';
  }
  for (const clause of MODEL_RETIRED_404_CLAUSES) {
    if (clause.every(t => m.includes(t))) return 'model-retired';
  }
  return null;
}

/**
 * ── LOAD-TIME PROOF THAT THE NEUTRALISERS COVER THE CENSUS ───────────────────
 *
 * Runs once, at import, over ~13 short strings. It throws rather than warns
 * because both failure modes it guards are MONEY — an un-neutralised retry
 * token buys ~40 s of pointless backoff, an un-neutralised not-found token
 * buys a fallback-chain walk — and because this module is imported by the MCP
 * child process, where a stray `console.warn` is noise nobody reads and a
 * stdout write would corrupt the JSON-RPC stream outright.
 *
 * It can only fire on a DEVELOPER edit (a token added to one side and not the
 * other); no user data reaches it. That makes a load-time throw the cheapest
 * possible signal: loud, free, and impossible to ship past.
 *
 * ENFORCED: every entry of RETRY_CLASSIFIER_TOKENS is destroyed by
 * `neutralizeRetrySignals`; every clause of MODEL_NOT_FOUND_CLAUSES stops
 * matching after `neutralizeNotFoundSignals`.
 *
 * NOT ENFORCED, stated rather than implied away: that the two lists are
 * COMPLETE with respect to `llm.js`'s classifiers. Nothing can enumerate the
 * substrings a function matches, so a token added to `is429`/`is503`/
 * `isModelNotFound` and to NEITHER list is invisible here. `llm.js` closes the
 * near half of that gap at its own load (every listed token really does trip
 * its classifier — so a list entry can never be a token the classifier stopped
 * caring about); the far half wants a source-extracting assertion in the
 * offline suite, which is where that technique already lives.
 */
{
  const survived = [];
  for (const token of RETRY_CLASSIFIER_TOKENS) {
    // Wrapped in filler so the word-boundary rules see the same shape they see
    // in a real echoed detail, not a lone token at both string edges.
    const out = neutralizeRetrySignals(`upstream said ${token} for this request`);
    if (out.toLowerCase().includes(token.toLowerCase())) survived.push(`retry token "${token}"`);
  }
  for (const clause of MODEL_NOT_FOUND_CLAUSES) {
    const probe = neutralizeNotFoundSignals(clause.join(' ')).toLowerCase();
    if (clause.every(t => probe.includes(t.toLowerCase()))) {
      survived.push(`not-found clause [${clause.join(' + ')}]`);
    }
  }
  // ── THE TWO 404 VERDICTS MUST STAY DISJOINT ────────────────────────────────
  // Only `model-retired` walks the fallback chain, so a constraint clause broad
  // enough to swallow the retirement probe would kill the v2.4.0 safety net,
  // and a retirement clause broad enough to swallow a constraint probe would
  // reopen the paid-substitution defect. Neither is visible by reading two
  // tables side by side once either grows; both are visible here. This is NOT
  // `f(x) === f(x)`: adding `['no endpoints found']` to the constraint table —
  // the single most plausible careless edit, since every measured 404 begins
  // that way — makes the SECOND loop fire, naming the clause.
  for (const c of ROUTING_CONSTRAINT_404_CLAUSES) {
    if (classifyNotFoundReason(c.match.join(' ')) !== 'routing-constraint') {
      survived.push(`constraint clause [${c.match.join(' + ')}] does not classify as routing-constraint`);
    }
  }
  for (const clause of MODEL_RETIRED_404_CLAUSES) {
    if (classifyNotFoundReason(clause.join(' ')) !== 'model-retired') {
      survived.push(`retirement clause [${clause.join(' + ')}] is shadowed by a routing-constraint clause`);
    }
  }
  if (survived.length > 0) {
    throw new Error(
      '[openrouter-adapter] a recovery-classifier signal survives its neutraliser, so an ' +
      'upstream error string could drive retries or a paid fallback-chain walk: ' +
      survived.join('; ') + '. Fix the neutraliser above — do not delete the census.',
    );
  }
}

// ── Exact decimal money arithmetic ───────────────────────────────────────────

/**
 * Convert OpenRouter's per-token price STRING into USD per 1M tokens, EXACTLY.
 *
 * THE BUG THIS EXISTS TO CLOSE, measured live 2026-08-27:
 *
 *     parseFloat('0.0000001') * 1e6  ===  0.09999999999999999   // NOT 0.1
 *
 * `google/gemini-2.5-flash-lite` derives to 0.09999999999999999 / 0.39999999999999997
 * where our own hand-verified table says exactly 0.10 / 0.40. That matters three
 * ways and none of them is cosmetic:
 *   1. `test-next-composer-model.js` §11.1 asserts EXACT-DOLLAR equality between
 *      the real `chargeForItem` and the composer's mirrored copy over 126 cases.
 *      Float noise on one side of a money formula tested by `===` is a red suite.
 *   2. It renders as `$0.0999999…` on a spend surface, in an app whose last
 *      release was entirely about cost honesty.
 *   3. Any `===` between a derived price and a hand-entered constant for the
 *      SAME model fails spuriously, which reads as a real defect.
 *
 * THE FIX IS TEXTUAL, NOT NUMERIC. Multiplying by 1e6 is moving the decimal point
 * six places right, so we move it in the STRING and parse once. `Number('0.1')` is
 * the nearest double to 0.1 — bit-for-bit the same value a hand-typed `0.10`
 * literal produces — so a derived price and a hand-entered price for the same
 * model are `===` by construction, which is the property we actually need.
 *
 * Rejects anything that is not a plain signed decimal (scientific notation
 * included) by returning null, so an unparseable price can never silently become
 * a number.
 *
 * `"-1"` — carried by exactly 5 ROUTER ids (`openrouter/auto`, `auto-beta`,
 * `fusion`, `pareto-code`, `bodybuilder`) and meaning "price unknown until it has
 * routed" — converts like any other decimal, to **-1000000** ($/Mtok, not
 * $/token). It is NOT special-cased here: this function reports what the string
 * says and does not editorialise. REFUSING a non-positive price is the caller's
 * job, and `llm.js`'s `registerDynamicPrice` does exactly that.
 *
 * @param {unknown} s  decimal string, USD per token
 * @returns {number|null} USD per 1M tokens, or null if unparseable
 */
export function usdPerMtokFromPerTokenString(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) return null;
  const sign = m[1];
  const intPart = m[2];
  const frac = m[3] || '';
  // Move the decimal point 6 places right: take 6 fractional digits into the
  // integer part (zero-padded), leave the rest fractional.
  const shifted = frac.slice(0, 6).padEnd(6, '0');
  const newInt = (intPart + shifted).replace(/^0+(?=\d)/, '');
  const newFrac = frac.slice(6).replace(/0+$/, '');
  const out = Number(`${sign}${newInt}${newFrac ? `.${newFrac}` : ''}`);
  return Number.isFinite(out) ? out : null;
}

// ── Signal plumbing ──────────────────────────────────────────────────────────

/**
 * Combine a caller AbortSignal with a local timeout into one signal.
 *
 * Hand-rolled rather than `AbortSignal.any` because that landed in Node 20 and
 * this project's floor is Node 18 (see the `globalThis.fetch` requirement in the
 * GitHub adapter). Returns `{ signal, dispose }`; the caller MUST call
 * `dispose()` in a `finally` or the timer keeps the event loop alive.
 */
/**
 * Why did this transport call fail — a caller CANCEL, our own TIMEOUT, or
 * neither? ONE definition, used at BOTH transport catch sites.
 *
 * ── THE SIGNAL IS AUTHORITATIVE, THE ERROR'S SHAPE IS NOT ──────────────────
 * The first version of this tested `err.name === 'AbortError'`, which is what
 * the fetch phase produces. MEASURED on the body phase, it is not: aborting
 * mid-`res.json()` makes undici throw THE ABORT REASON ITSELF — for a caller
 * passing `ac.abort(new Error('user cancelled'))` that is a plain Error with
 * `name: 'Error'`, no `AbortError` anywhere and no `curatorAborted` flag. A
 * name test therefore sees nothing, and the cancel would have been translated
 * into `OPENROUTER_BAD_RESPONSE`: invisible to `isAbortError()`, and so RETRIED.
 * This is v3.4.0's finding recurring in a new place — there, the Anthropic SDK's
 * `APIUserAbortError` was found to carry `name: 'Error'` too, and the conclusion
 * was the same: the `aborted` flag, not the name, is what tags it.
 *
 * CANCEL AND TIMEOUT ARE DELIBERATELY NOT MERGED, even though `link.signal` is
 * aborted for both. A cancel must never be retried; a timeout is an ordinary
 * transport failure and keeps the exact shape it had before this function
 * existed. Merging them would have made every timeout look like a user cancel.
 * The CALLER's signal is the discriminator, and it is checked FIRST so that if
 * both fire the cancel wins — the more important fact, and the safer verdict.
 */
function classifyTransportFailure(err, callerSignal, linkSignal) {
  if (callerSignal && callerSignal.aborted) return 'cancelled';
  if (err && (err.name === 'AbortError' || err.curatorAborted === true)) return 'cancelled';
  if (linkSignal && linkSignal.aborted) return 'timeout';
  return null;
}

/**
 * An abort error `llm.js`'s `isAbortError()` recognises. Built here rather than
 * imported because llm.js imports THIS module, so reaching back would form a
 * cycle. (This file's single import, `openrouter-eligibility.js`, is itself
 * import-free, so it is a leaf edge and changes nothing about that direction.)
 * Both tags are set: `name` for the standard test and `curatorAborted` for the
 * duck-typed one, so it matches on either.
 */
function makeAdapterAbortError() {
  const e = new Error('OpenRouter request cancelled.');
  e.name = 'AbortError';
  e.curatorAborted = true;
  return e;
}

function linkSignals(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let onAbort = null;

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  }
  if (callerSignal && typeof callerSignal.addEventListener === 'function') {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else {
      onAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      if (onAbort && callerSignal && typeof callerSignal.removeEventListener === 'function') {
        callerSignal.removeEventListener('abort', onAbort);
      }
    },
  };
}

// ── Catalogue (public, no auth) ──────────────────────────────────────────────

/**
 * Fetch OpenRouter's public model catalogue.
 *
 * PUBLIC AND UNAUTHENTICATED — verified 2026-08-27: 417 models, one page,
 * `cache-control: public, max-age=300`. It lives HERE rather than in a route so
 * there is exactly one place that knows OpenRouter's wire shape; two
 * hand-maintained copies of a provider contract is this repo's named cause of
 * the v3.2.0 CRITICAL.
 *
 * Returns the raw `data` array unchanged. Interpretation — which entries are
 * admissible, how a price becomes an offer, what counts as measured — is
 * deliberately NOT done here: this function reports what OpenRouter says, and
 * `llm.js` owns every admission decision.
 *
 * @returns {Promise<Array<object>>}
 */
export async function fetchOpenRouterCatalogue({ fetchImpl = null, baseUrl = OPENROUTER_BASE_URL, signal = null, timeoutMs = 30_000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new OpenRouterError('OPENROUTER_NO_FETCH', 'No fetch implementation available (Node 18+ required).');
  }
  const link = linkSignals(signal, timeoutMs);
  try {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: link.signal,
    });
    if (!res.ok) {
      throw new OpenRouterError(
        classifyOpenRouterStatus(res.status),
        `OpenRouter model catalogue → HTTP ${res.status}`,
        res.status,
      );
    }
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  } finally {
    link.dispose();
  }
}

/**
 * ── THE MAPPER: one OpenRouter API record → one admissible spec, or a refusal ─
 *
 * WHY THIS EXISTS. `llm.js` carries two refusals that had NO PRODUCER and were
 * therefore vacuous — provably so, by execution:
 *
 *   • TIERED PRICING. `hasTieredPricing()` fired only on a `priceTierThreshold-
 *     Tokens` field nobody set, or an empty static Set. `grep -rn
 *     "pricing.overrides" src mcp scripts` returned only COMMENTS. So the real
 *     `anthropic/claude-sonnet-4.5` — which DOUBLES above 200,000 prompt tokens,
 *     $3→$6 in and $15→$22.50 out — was admitted at a flat rate with
 *     `isBuildLaneModel` TRUE, on exactly the large ingests that cross the
 *     threshold.
 *   • MOVING ALIASES. `alias_target` had ZERO hits in the entire tree. Twelve
 *     `*-latest` ids silently change what the user picked, at a price we quoted
 *     for something else.
 *
 * A guard with no producer is a comment. This function is the producer: it is
 * the ONE place an OpenRouter record becomes a spec, so both facts are read off
 * the provider's own payload at the moment of admission and cannot be lost by
 * whoever writes the catalogue-builder later.
 *
 * WHAT IT REFUSES TO DECIDE. It sets `suitability: 'chat-only'` and nothing
 * else, because `suitability` and `note` are COMPARATIVE VERDICTS about how a
 * model behaved on this repo's real ingest prompt, and no API can supply them.
 * `jsonRaw` is OMITTED — it becomes `null`, meaning "not measured", never
 * `false`, which would read as "measured bad". A build-lane entry is written by
 * a HUMAN into the static table from a measurement session; nothing fetched over
 * a network can reach that lane (`setOpenRouterCatalogue` enforces it).
 *
 * SHAPE NOTE, deliberately conservative: the exact JSON of `pricing.overrides`
 * is UNVERIFIED, so this reports PRESENCE (`tiered: true`) and does not invent a
 * threshold. Presence is all the refusal needs, and a guessed threshold would be
 * a number this project made up on a spend surface.
 *
 * @param {object} record  one element of `fetchOpenRouterCatalogue()`'s array
 * @returns {{ok: true, spec: object} | {ok: false, reason: string}}
 */
export function openRouterRecordToSpec(record) {
  const no = (reason) => ({ ok: false, reason });

  if (!record || typeof record !== 'object') return no('not an object');
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return no('missing `id`');

  // REFUSED BY CONSTRUCTION #1 — a moving alias. `~*-latest` ids carry
  // `alias_target`, i.e. the provider itself says this id resolves to a
  // different model. A user picking it does not know what they picked, and the
  // price we quote is the alias's, not the target's.
  if (record.alias_target != null && record.alias_target !== '') {
    return no(`is an alias for "${String(record.alias_target).slice(0, 60)}" — a moving id silently changes what the user picked`);
  }

  // FREE IS THE `:free` SUFFIX, NEVER price === 0. Measured on the live
  // catalogue: 20 ids are zero-priced but only 17 carry `:free`; the 3 extra are
  // two audio models and `openrouter/free`, a ROUTER whose real price is unknown
  // until it has routed. Treating "price is 0" as free would admit a bill we
  // cannot describe.
  const free = /:free$/.test(id);

  const pricing = record.pricing && typeof record.pricing === 'object' ? record.pricing : {};
  let price = null;
  if (!free) {
    const input = usdPerMtokFromPerTokenString(pricing.prompt);
    const output = usdPerMtokFromPerTokenString(pricing.completion);
    // REFUSED BY CONSTRUCTION #2 — an unknown price. This is what catches the
    // five `-1` ROUTER ids (openrouter/auto, auto-beta, fusion, pareto-code,
    // bodybuilder), whose price is genuinely unknowable until the request has
    // routed. `-1` per token converts to -1000000 $/Mtok, so the non-positive
    // test catches it on the number rather than on a magic string.
    if (input === null || output === null) return no('price is missing or unparseable');
    if (input <= 0 || output <= 0) return no('non-positive price — the id is a router whose price is unknown until it has routed');
    price = { input, output };
  }

  // REFUSED BY CONSTRUCTION #3 — no known output ceiling. Ingest asks for 24,576
  // output tokens on the Phase-1 outline alone, so a model whose ceiling we
  // cannot read cannot be sized. 411 of 417 publish one.
  const cap = record.top_provider && typeof record.top_provider === 'object'
    ? record.top_provider.max_completion_tokens : null;
  if (!Number.isFinite(cap) || cap <= 0) return no('no published output ceiling (top_provider.max_completion_tokens)');

  // ── TWO PUBLISHED FACTS, CARRIED FOR SORTING ONLY ─────────────────────────
  // Neither is an admissibility rule and NEITHER MAY REFUSE A RECORD. They are
  // sort keys: a model whose release date the provider does not publish is a
  // model we cannot rank by date, not a model we cannot offer.
  //
  // `created` IS EPOCH SECONDS, and the field is named for its unit. Measured on
  // the live catalogue: 387 of 387 records publish a finite value, spanning
  // 2023-05-28 to 2026-08-28. The failure this field invites is a seconds value
  // read as milliseconds — which renders as the year 55000 — or a zero, which
  // renders as 1970-01-01 and sorts as the oldest thing we have. Both are
  // fabricated dates that look exactly like real ones, so the unit is in the
  // name and the range is checked again in `defineOfferableModel`.
  //
  // CONTEXT COMES FROM `top_provider.context_length`, THE CONSERVATIVE FIELD,
  // AND NEVER FROM THE HEADLINE `context_length`. That is the same field
  // `openrouter-eligibility.js` gates admission on (its DEFAULT `contextField`),
  // and the two disagree on 39 of 387 live records — the headline figure is the
  // MAXIMUM ACROSS PROVIDERS, so ranking on it would sort models by an
  // optimistic number the eligibility filter had already declined to trust.
  // Two opinions about one figure, on precisely the axis that module wrote sixty
  // lines to warn about.
  //
  // AND IT DOES NOT FALL BACK TO THE HEADLINE WHEN THE CONSERVATIVE FIELD IS
  // ABSENT. 6 live records publish `context_length` with no
  // `top_provider.context_length`; a fallback would rank those six as though we
  // knew their size. All six already fail the eligibility filter's
  // CONTEXT_UNKNOWN rule and never reach this function — verified by running the
  // real `buildOpenRouterCatalogue` over the live catalogue, where 0 of the 191
  // admitted specs lacked either field — so the fallback would buy nothing and
  // spend the one guarantee this field has. Unrecognised never resolves to
  // optimistic, which is that module's own rule.
  const createdRaw = record.created;
  const created = Number.isFinite(createdRaw) && createdRaw > 0 ? createdRaw : null;
  const ctxRaw = record.top_provider && typeof record.top_provider === 'object'
    ? record.top_provider.context_length : null;
  const contextLength = Number.isFinite(ctxRaw) && ctxRaw > 0 ? ctxRaw : null;

  // Tiered detection: PRESENCE only. See the shape note above.
  const ov = pricing.overrides;
  const tiered = Array.isArray(ov) ? ov.length > 0 : (!!ov && typeof ov === 'object' && Object.keys(ov).length > 0);

  // `thinks` from provider metadata — reasoning tokens are billed as OUTPUT and
  // are drawn from the same budget as the answer, so this is a COST flag, not a
  // quality one. Provenance is stated in the note: this is read, not measured.
  const reasoning = record.reasoning && typeof record.reasoning === 'object' ? record.reasoning : {};
  const internalReasoningPrice = usdPerMtokFromPerTokenString(pricing.internal_reasoning);
  const thinks = reasoning.mandatory === true
    || reasoning.default_enabled === true
    || (internalReasoningPrice !== null && internalReasoningPrice > 0);

  const label = typeof record.name === 'string' && record.name.trim().length > 0
    ? record.name.trim() : id;

  return {
    ok: true,
    spec: {
      id,
      label,
      // The chat lane, always. A machine may report what a provider published;
      // it may not write the comparative verdict that admits a model to the lane
      // that WRITES the user's wiki.
      suitability: 'chat-only',
      thinks,
      // Display-only, and NOT measured for a fetched entry — the note says so
      // rather than letting 1.0 imply a probe that never happened.
      tokenizerFactor: 1,
      maxOutput: cap,
      // ABSENT MEANS ABSENT. The key is OMITTED rather than set to null or 0, so
      // a record that published nothing produces a spec that carries nothing —
      // and `defineOfferableModel` records `null` (unknown) rather than a figure
      // nobody published. `created` is seconds; see the block above.
      ...(created !== null ? { createdUnixSec: created } : {}),
      ...(contextLength !== null ? { contextLength } : {}),
      ...(free ? { free: true } : { price }),
      ...(tiered ? { tiered: true } : {}),
      // ⚠ The `free` clause used to read "a request cap applies and rises once
      // credits are purchased" — the SAME unverified claim the 429 warning
      // carried, in a second place, and this one renders in the model picker.
      // Fixing only the reported instance would have been this repo's named
      // guard-applied-to-an-instance shape. It states MEASURED facts instead: a
      // free id is gated by the account's data policy (a `:free` model 404s with
      // "No endpoints found matching your data policy (Free model training)"
      // — observed both when we send a deny flag and, for at least one id, on a
      // bare request), and rate limits are real but their figures are not
      // something this project can state (see `_throwForStatus`'s 429 block).
      note:
        `Listed by OpenRouter's public catalogue. ${free ? 'Free tier — rate-limited, and reachable only if your OpenRouter account\'s data policy permits free models; some free ids are refused account-wide. ' : ''}` +
        `${thinks ? 'Spends hidden reasoning tokens, billed as output. ' : ''}` +
        `${tiered ? 'Its published rate CHANGES above a prompt-size threshold, so it is chat-only: chat prompts are bounded and small enough that the quoted flat rate is the rate billed. ' : ''}` +
        `Chat only — never measured against The Curator's ingest prompt, so nothing here says how it would build a wiki.`,
    },
  };
}

/**
 * ── records -> admissible specs, with the funnel that explains the losses ────
 *
 * THE GAP THIS CLOSES. `fetchOpenRouterCatalogue` and `openRouterRecordToSpec`
 * shipped together and had, between them, ZERO production callers: nothing
 * joined "what OpenRouter publishes" to "what the user may pick". The visible
 * consequence was a picker offering 3 OpenRouter models out of a catalogue of
 * hundreds, while a public README promised "hundreds of models".
 *
 * ── THE ELIGIBILITY FILTER IS IMPORTED, NEVER RE-IMPLEMENTED ────────────────
 * `openrouter-eligibility.js` owns every admissibility rule (JSON mode, knowable
 * price, moving aliases, output ceiling, context window, expiry, text output)
 * and the ordered funnel that attributes each loss to the FIRST rule it failed.
 * Re-deriving any of that here would create two hand-maintained copies of one
 * guard — this repo's named cause of the v3.2.0 CRITICAL — and the copies would
 * drift silently on the question of which models a user is allowed to spend
 * money through.
 *
 * NAMESPACE import, not a named one, and the reason is the same one recorded at
 * the top of `src/routes/config.js`: a static `import { filterCatalogue }` of an
 * export that is absent (or renamed while both files are being edited) throws a
 * SyntaxError AT MODULE LOAD and takes down every consumer of this file —
 * `llm.js`, and therefore the whole app and the MCP child. A namespace import
 * degrades to `undefined`, which the explicit check below turns into a named,
 * recoverable refusal.
 *
 * THE MISSING-FILTER CASE REFUSES, IT DOES NOT PASS EVERYTHING THROUGH. Failing
 * open would admit ~380 unfiltered ids — routers with unknowable prices, moving
 * aliases, models with no JSON mode — straight into a spend surface. "We could
 * not check" and "we checked and it passed" are different facts and must not
 * collapse into the same outcome; this is the same rule the app applies to a
 * fallback model's cost tier, where an unrecognised tier resolves to `unknown`
 * and warns rather than resolving to `similar`.
 *
 * DEDUPLICATION BY ID, FIRST WINS. `defineOfferableModel` would happily build
 * two entries with the same id; `findOfferableModel` resolves with `.find()`, so
 * the second would be permanently unreachable while still occupying a row in the
 * picker and a slot in the admitted tally. One id, one offer.
 *
 * @param {Array<object>} records   the `data` array from `fetchOpenRouterCatalogue()`
 * @param {object} [opts]
 * @param {object} [opts.eligibility]  passed through to `filterCatalogue`
 * @param {object} [opts.eligibilityModule]  test seam; defaults to the real module
 * @returns {{total:number, eligible:number, specs:Array<object>,
 *            funnel:Array<{rule:string, before:number, after:number}>,
 *            mapperRefused:number, mapperRefusals:Array<{id:string, reason:string}>}}
 */
export function buildOpenRouterCatalogue(records, opts = {}) {
  const eligibility = opts.eligibilityModule || eligibilityModule;
  const filter = eligibility && eligibility.filterCatalogue;
  if (typeof filter !== 'function') {
    throw new OpenRouterError(
      'OPENROUTER_NO_ELIGIBILITY',
      'The OpenRouter eligibility filter is unavailable, so no model can be admitted. ' +
      'Refusing to offer an unfiltered catalogue.',
    );
  }

  const list = Array.isArray(records) ? records : [];
  const report = filter(list, opts.eligibility);

  // Defensive about the SHAPE of a module another change may be editing: a
  // report we cannot read is the same fact as a filter we cannot call.
  if (!report || !Array.isArray(report.eligible)) {
    throw new OpenRouterError(
      'OPENROUTER_NO_ELIGIBILITY',
      'The OpenRouter eligibility filter returned an unreadable report, so no model can be admitted.',
    );
  }

  const eligibleIds = new Set();
  for (const ev of report.eligible) {
    if (ev && typeof ev.id === 'string' && ev.id.length > 0) eligibleIds.add(ev.id);
  }

  const specs = [];
  const mapperRefusals = [];
  const seen = new Set();
  for (const record of list) {
    const id = record && typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || !eligibleIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    // PER-ENTRY, NEVER ALL-OR-NOTHING: one malformed record in a 380-element
    // response must not take the feature down. `openRouterRecordToSpec` already
    // returns a refusal rather than throwing, but a future edit to it might not,
    // so the call is wrapped too.
    let mapped;
    try {
      mapped = openRouterRecordToSpec(record);
    } catch (err) {
      mapped = { ok: false, reason: `mapper threw: ${err && err.message}` };
    }
    if (mapped && mapped.ok) specs.push(mapped.spec);
    else mapperRefusals.push({ id, reason: (mapped && mapped.reason) || 'unknown' });
  }

  // `{rule, before, after}` is the wire shape the Settings funnel renders. The
  // eligibility module's own field names (`in`/`out`) are NOT reused verbatim:
  // `in` is a reserved word in enough contexts that it invites `report.in`-style
  // mistakes downstream, and `before`/`after` states the cascade in the language
  // the screen uses.
  const funnel = Array.isArray(report.funnel)
    ? report.funnel.map(f => ({
        rule: String(f && f.rule),
        before: Number(f && f.in),
        after: Number(f && f.out),
      }))
    : [];

  // ── DID THE CLOCK ACTUALLY ARRIVE? ────────────────────────────────────────
  // The eligibility module is PURE and may not read a clock, so `opts.now`
  // defaults to null and expiry is then NOT EVALUATED — it does not reject, it
  // abstains. Silently. Measured on the live catalogue: 194 eligible with no
  // clock, 193 with one, and the model that differs expires three days from the
  // day this was written. An option passed by string name that degrades instead
  // of erroring on a typo is the exact fact-vs-absence class this repo keeps
  // finding, so the module's own report of whether it got a clock is read back
  // and surfaced. TRI-STATE: a report that does not say is `null`, never `true`
  // — "we could not confirm" must not resolve to "confirmed".
  const clockSupplied = (report.opts && typeof report.opts.clockSupplied === 'boolean')
    ? report.opts.clockSupplied
    : null;

  return {
    total: Number.isFinite(report.total) ? report.total : list.length,
    eligible: eligibleIds.size,
    specs,
    funnel,
    clockSupplied,
    mapperRefused: mapperRefusals.length,
    mapperRefusals,
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class OpenRouterAdapter {
  /**
   * @param {object} config
   * @param {string}   config.apiKey       `sk-or-v1-…`
   * @param {string}   [config.baseUrl]    default OPENROUTER_BASE_URL; change it to
   *                                       point at LM Studio / Ollama / llama.cpp
   * @param {Function} [config.fetchImpl]  injectable for offline tests
   * @param {boolean}  [config.attribution=false] send the constant HTTP-Referer / X-Title
   * @param {number}   [config.timeoutMs]
   * @param {Function} [config.onWarn]     (message) => void — operational warnings.
   *                                       A throwing callback must never break a call.
   */
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new OpenRouterError('OPENROUTER_CONFIG', 'OpenRouterAdapter: config object is required');
    }
    if (typeof config.apiKey !== 'string' || config.apiKey.length < 8) {
      throw new OpenRouterError('OPENROUTER_CONFIG', 'OpenRouterAdapter: apiKey is required');
    }
    this._apiKey = config.apiKey;
    this.baseUrl = (typeof config.baseUrl === 'string' && config.baseUrl.length > 0
      ? config.baseUrl : OPENROUTER_BASE_URL).replace(/\/+$/, '');
    this._fetch = config.fetchImpl || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new OpenRouterError('OPENROUTER_NO_FETCH', 'OpenRouterAdapter: no fetch implementation available (Node 18+ required)');
    }
    this._attribution = config.attribution === true;
    this._timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : OPENROUTER_DEFAULT_TIMEOUT_MS;
    this._onWarn = typeof config.onWarn === 'function' ? config.onWarn : null;
  }

  /** Redact using the live key first, then the prefix patterns. */
  _redact(s) {
    return redactOpenRouterSecrets(s, this._apiKey);
  }

  /** Never log this object — it contains the key. */
  _headers() {
    const h = {
      'Authorization': `Bearer ${this._apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this._attribution) {
      h['HTTP-Referer'] = OPENROUTER_ATTRIBUTION.referer;
      h['X-Title'] = OPENROUTER_ATTRIBUTION.title;
    }
    return h;
  }

  _warn(message) {
    if (!this._onWarn) return;
    try { this._onWarn(message); } catch { /* a warn callback must never break the call */ }
  }

  /**
   * Build the request body.
   *
   * `provider: { allow_fallbacks: false, require_parameters: true }` is sent on
   * EVERY call and both halves are load-bearing:
   *   • allow_fallbacks — OpenRouter's provider fallback is DEFAULT ON, so
   *     without this the user's chosen model can be served by an upstream they
   *     did not pick, at a price we did not quote.
   *   • require_parameters — this is what stops an upstream SILENTLY DROPPING
   *     our `response_format`. Ingest is JSON mode; a dropped `response_format`
   *     does not error, it just returns prose, which arrives as a parse failure
   *     several layers away with no indication of the real cause.
   *
   * A `models: [...]` array is NEVER sent: that enables MODEL substitution, i.e.
   * the same class of silent swap one rung up.
   *
   * `usage: {include: true}` is NOT sent, and the reason is NOT the one this
   * comment used to give. It claimed the parameter "is what surfaces
   * OpenRouter's own `cost` field". MEASURED 2026-08-27: `usage`, `usage.cost`
   * included, came back on ALL ~60 live calls without it. OpenRouter's own docs
   * agree — `usage: {include: true}` and `stream_options: {include_usage: true}`
   * are DEPRECATED and have no effect; full usage is always returned. So the
   * parameter is a no-op, which is a stronger reason not to send it than the
   * one it replaced: there is nothing to weigh, not merely nothing to gain.
   *
   * ⚠ `provider: {data_collection: 'deny'}` IS NOT SENT, AND MUST NOT BE ADDED
   * UNCONDITIONALLY. It reads like free privacy hardening. It is not. Measured
   * 2026-08-27 — accepted on paid models (never a 400), but a FREE model returns:
   *
   *     HTTP 404 — "No endpoints found matching your data policy (Free model training)"
   *
   * and a 404 is worse here than a plain failure. `llm.js`'s `isModelNotFound()`
   * fires on it TWICE OVER — once on `err.status === 404` and again on our own
   * "model not found" prose — so every free-model request would WALK THE
   * FALLBACK CHAIN, i.e. up to four more calls, because of a policy flag we sent
   * ourselves. Neutralising the message would not help: the status alone is
   * sufficient (verified against the real function, not by reading it).
   *
   * A paid-only conditional form would be safe in principle. It is deliberately
   * NOT built: `_buildBody` is not told whether the model is free, wiring that
   * through is a real change to the request shape on every call, and this
   * project ships less. If it is ever built, the free/paid decision must come
   * from the `:free` suffix rule `openRouterRecordToSpec` already owns — never
   * from a second copy of that rule.
   *
   * Also measured: an ACCOUNT-LEVEL data policy can already make a catalogued
   * free model unreachable with nothing sent at all
   * (`nvidia/nemotron-3-super-120b-a12b:free` 404s on a bare request). So a 404
   * on a `:free` id is not automatically a retired model, and a future
   * catalogue-pruning job must not treat it as one.
   */
  _buildBody({ model, systemPrompt, userPrompt, maxTokens, responseFormat }) {
    const messages = [];
    if (typeof systemPrompt === 'string' && systemPrompt.length > 0) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: typeof userPrompt === 'string' ? userPrompt : '' });

    const body = {
      model,
      messages,
      provider: { allow_fallbacks: false, require_parameters: true },
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    if (responseFormat === 'json') body.response_format = { type: 'json_object' };
    return body;
  }

  /**
   * One non-streaming chat completion.
   *
   * @returns {Promise<{
   *   text: string, model: string|null, finishReason: string|null,
   *   usage: object|null, providerName: string|null, generationId: string|null
   * }>}
   *   `model` is the RESOLVED model from the response body — the model that
   *   actually answered, not the one we asked for. That distinction is the
   *   v3.13.2 lesson: reporting the request rather than the outcome passes every
   *   refusal test and fails only the fallback walk.
   */
  async createChatCompletion({ model, systemPrompt, userPrompt, maxTokens, responseFormat = 'text', signal = null }) {
    if (typeof model !== 'string' || model.length === 0) {
      throw new OpenRouterError('OPENROUTER_CONFIG', 'OpenRouter: a non-empty model id is required');
    }
    // ── THE LINK MUST OUTLIVE THE FETCH, BECAUSE FETCH RESOLVES ON HEADERS ──
    // `dispose()` used to sit in a `finally` attached to the fetch alone. fetch
    // settles as soon as the response HEADERS arrive, so the abort listener and
    // the `timeoutMs` timer were both torn down before `res.json()` — which is
    // where essentially all of the time goes. Instrumented against a live
    // OpenRouter call: headers at 963 ms, abort fired at 1,999 ms, body finished
    // at 39,653 ms — the abort had NO effect, and on a real batch the in-flight
    // Phase-2 call completed and WAS BILLED.
    //
    // Two things were broken by one misplaced brace. v3.4.0's headline promise —
    // "zero LLM calls after the cancel", the release that exists because cancel
    // used to keep spending the user's money — was simply not true for
    // OpenRouter. And `timeoutMs` was dead for the body phase, so a server that
    // sent headers and then stalled would hang forever.
    //
    // The link now spans the whole exchange: request, status handling, and body.
    // Nothing else moves — the redaction ordering in `_detail`, the
    // `curatorDeterministic` 503 handling, and the rule that our message never
    // contains the literal "HTTP 503" are all untouched.
    const link = linkSignals(signal, this._timeoutMs);
    try {
      let res;
      try {
        res = await this._fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify(this._buildBody({ model, systemPrompt, userPrompt, maxTokens, responseFormat })),
          signal: link.signal,
        });
      } catch (err) {
        // A cancel must reach llm.js's isAbortError() intact — one reclassified
        // as a network failure would be RETRIED, the one thing a cancel must not
        // do. A timeout keeps the shape it has always had here.
        const kind = classifyTransportFailure(err, signal, link.signal);
        if (kind === 'cancelled') throw makeAdapterAbortError();
        throw new OpenRouterError(
          'OPENROUTER_NETWORK',
          kind === 'timeout'
            ? `OpenRouter did not respond within ${this._timeoutMs} ms.`
            : `OpenRouter request failed before a response arrived: ${this._redact(String(err && err.message))}`,
        );
      }

      // The model id is passed so a routing-constraint 404 can NAME what failed.
      // The 429 branch's comment records the cost of not having it here: without
      // the id an error can only speak in generalities on the one screen where
      // the user's next action is "pick a different model". `validateKey`'s call
      // site below passes none, and that path degrades to "this model".
      if (!res.ok) await this._throwForStatus(res, 'chat/completions', model);
      let body;
      try {
        body = await res.json();
      } catch (err) {
        // NOW REACHABLE, and that is the point: with the link alive through the
        // body read, an abort lands HERE rather than at the fetch. Reporting it
        // as OPENROUTER_BAD_RESPONSE would hide it from isAbortError() and earn a
        // retry of a call the user just cancelled — so the same classification
        // runs first, from the same single definition.
        const kind = classifyTransportFailure(err, signal, link.signal);
        if (kind === 'cancelled') throw makeAdapterAbortError();
        if (kind === 'timeout') {
          throw new OpenRouterError('OPENROUTER_NETWORK',
            `OpenRouter sent response headers but did not finish the body within ${this._timeoutMs} ms.`);
        }
        throw new OpenRouterError('OPENROUTER_BAD_RESPONSE', 'OpenRouter returned a non-JSON response body.');
      }
      return this.parseChatCompletion(body, res.headers);
    } finally {
      link.dispose();
    }
  }

  /**
   * Turn a 200 response body into our result shape, or throw.
   *
   * Separate from the transport so an offline suite can drive every in-band
   * shape — including the HTTP-200 mid-stream error — without a fetch double.
   *
   * @param {object} body
   * @param {Headers|null} headers
   */
  parseChatCompletion(body, headers = null) {
    // A 200 can still carry a top-level error object.
    if (body && body.error) {
      const status = Number.isFinite(body.error.code) ? body.error.code : 200;
      throw this._buildInBandError(body.error, status);
    }
    const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
    if (!choice) {
      throw new OpenRouterError('OPENROUTER_BAD_RESPONSE', 'OpenRouter returned no choices.');
    }

    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;

    // ⚠ MID-STREAM FAILURE, HTTP 200. OpenRouter reports a failure that happened
    // after the response began in-band, as finish_reason "error" (with an
    // `error` object on the choice when it has one). Without this branch a
    // failed generation is handed back as a successful truncated answer — a
    // silent-data-loss shape this project has hit before.
    //
    // THE SECOND SHAPE, measured 2026-08-27: a 200 can carry
    // `choices[0].error` while `finish_reason` is a perfectly benign "stop".
    // Keying only on the reason returned the partial text with NO throw — a
    // failed generation handed back as a complete answer, which on the ingest
    // path is a wiki page written from a truncated response. So the presence of
    // an error OBJECT on the choice is disqualifying on its own, independent of
    // what the provider called the finish reason. Both conditions are checked
    // because they are genuinely independent: `finish_reason: "error"` can
    // arrive with no error object at all.
    if (finishReason === 'error' || (choice.error && typeof choice.error === 'object')) {
      const err = choice.error || body.error || { message: 'the generation failed after it had started' };
      throw this._buildInBandError(err, Number.isFinite(err.code) ? err.code : 200);
    }

    const content = choice.message?.content;
    const text = typeof content === 'string' ? content : '';

    return {
      text,
      // The resolved model, per OpenRouter's documented response contract.
      model: typeof body.model === 'string' && body.model.length > 0 ? body.model : null,
      finishReason,
      usage: body.usage && typeof body.usage === 'object' ? body.usage : null,
      // UNDOCUMENTED, and "live-evidenced" is what this comment used to claim on
      // the strength of a CORS `access-control-expose-headers` listing. That
      // listing says a browser MAY read the header, not that one is ever sent.
      // MEASURED 2026-08-27: `x-provider-name` was absent on ALL ~60 live calls.
      // Absence is therefore the NORMAL case, not an edge — never branch on
      // these, only report them. `generationId` survives because `body.id` is
      // documented and is what actually arrives.
      providerName: readHeader(headers, 'x-provider-name'),
      generationId: readHeader(headers, 'x-generation-id')
        ?? (typeof body.id === 'string' ? body.id : null),
    };
  }

  /**
   * Build the error for a failure reported IN-BAND on an HTTP 200.
   *
   * `status` here is the PROVIDER-SUPPLIED `error.code`, not a real HTTP status,
   * and that distinction decides two things:
   *
   *   • It still selects the string `code` tag, which is diagnostic only.
   *   • It must NOT be allowed to produce a MODEL-NOT-FOUND signal. `.status =
   *     404` is exactly what `isModelNotFound()` keys on, so an upstream that
   *     echoes `code: 404` inside a 200 body would walk the OpenRouter fallback
   *     chain — up to four more paid calls, driven by a third party's own JSON.
   *     Harmless only while that chain is empty, which is temporary. So the
   *     numeric is withheld from `.status` for 404 specifically, and the same
   *     vocabulary is stripped from the echoed prose, because
   *     `isModelNotFound()` reads the MESSAGE too and fixing only the property
   *     would close half the door.
   *
   * Every other numeric is preserved — an in-band 502 genuinely means the
   * upstream died mid-generation, and that is the most useful thing a log can
   * say about it.
   */
  _buildInBandError(errObj, status) {
    const raw = typeof errObj?.message === 'string' ? errObj.message : 'unknown error';
    const code = classifyOpenRouterStatus(status);
    const safe = this._detail(raw, status, { inBand: true });
    // "in-band" is stated so a reader of a log can tell a 200-with-error apart
    // from a real HTTP failure carrying the same tag.
    const carriesStatus = status !== 404;
    const e = new OpenRouterError(
      code,
      `OpenRouter reported an in-band failure${safe ? `: ${safe}` : '.'}`,
      carriesStatus ? status : undefined,
    );
    return e;
  }

  /**
   * Redact → neutralise (non-transient only) → truncate. Order is load-bearing.
   *
   * ── WHY NOT-FOUND NEUTRALISATION IS NOT LIMITED TO THE IN-BAND PATH ────────
   * It used to be, and the gap was the same one twice. `isModelNotFound` reads
   * `err.status === 404` FIRST, so on a real HTTP failure the STATUS decides —
   * except for every status that is not 404, where the echoed message decides
   * instead. An HTTP 500 or 502 whose body happened to carry `not_found_error`
   * therefore drove a fallback-chain walk exactly as an in-band 404 did, for
   * exactly the same reason, on a path nobody had looked at.
   *
   * 404 is EXCLUDED deliberately, and the exclusion costs nothing: that error
   * already carries `.status = 404`, so it classifies correctly from the
   * structure whatever the prose says — which leaves the prose free to stay
   * accurate and say "model not found" to the human reading the log. Every
   * other status has no such structural signal, so its prose must not be
   * allowed to invent one.
   *
   * ── `keepsStructural404` MAKES THAT EXCLUSION'S PREMISE EXPLICIT ───────────
   * The whole justification above is *"it already carries `.status = 404`"*. A
   * routing-constraint 404 deliberately does NOT (see `_throwForStatus`), so for
   * that one branch the premise is false and the prose must be neutralised like
   * any other status — otherwise the message would re-invent, in text, exactly
   * the signal the property was withheld to suppress. The default reproduces the
   * previous condition EXACTLY (`neutralise ⟺ inBand || status !== 404`), so
   * every other call site is byte-unchanged.
   */
  _detail(raw, status, { inBand = false, keepsStructural404 = (status === 404 && !inBand) } = {}) {
    let d = this._redact(raw);
    if (!TRANSIENT_STATUSES.has(status)) d = neutralizeRetrySignals(d);
    if (!keepsStructural404) d = neutralizeNotFoundSignals(d);
    return d.slice(0, 200);
  }

  async _throwForStatus(res, op, model) {
    let raw = '';
    try {
      const body = await res.json();
      if (body && body.error && typeof body.error.message === 'string') raw = body.error.message;
      else if (typeof body?.message === 'string') raw = body.message;
    } catch { /* non-JSON body */ }

    const status = res.status;
    const detail = this._detail(raw, status);
    const code = classifyOpenRouterStatus(status);

    if (status === 429) {
      const retryAfter = readHeader(res.headers, 'retry-after');
      // ── THREE 429 SHAPES, MEASURED ON THE WIRE 2026-08-29 ──────────────────
      // OpenRouter does not answer a 429 one way. All three were captured live
      // in the same session, from the same key:
      //
      //   • `z-ai/glm-5.2:free`          → `retry-after: 5`, nothing else.
      //   • `google/gemma-4-*:free`      → NO `retry-after`. Instead
      //     `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`
      //     (an ABSOLUTE epoch, in MILLISECONDS), with a body message naming the
      //     window: "Rate limit exceeded: free-models-per-min."
      //   • `google/gemma-4-31b-it:free` → no rate-limit headers at all.
      //
      // The shipped fix read only the first shape, so the maintainer's ORIGINAL
      // report — on a Gemma free model, i.e. the second shape — still fell to
      // the 60 s default three times over: ~180 s of silence. Every value below
      // is therefore read and attached RAW; `llm.js` owns what to do with them,
      // because it owns the precedence and the ceiling.
      const resetMs = readNumericHeader(res.headers, 'x-ratelimit-reset');
      const limit = readNumericHeader(res.headers, 'x-ratelimit-limit');
      const remaining = readNumericHeader(res.headers, 'x-ratelimit-remaining');
      // NO INVENTED FIGURE — AND NO INVENTED TIER. An earlier version said "Free
      // models are capped at 20 requests/minute" on ANY 429, a paid model's
      // included. OpenRouter's own docs render that table as JS components and it
      // came through EMPTY, so the project had never verified the number; the
      // docs refuse to print it and this string had no more right to.
      //
      // ⚠ THAT REASONING STANDS AND ITS PREMISE HAS CHANGED — updated 2026-08-29
      // rather than left contradicting the code beside it. What was unavailable
      // was a number we could VERIFY; the objection was never to printing a
      // figure, it was to printing one nobody had measured. On the Gemma shape
      // the provider now states it per-request, on the 429 itself:
      // `x-ratelimit-limit: 20`, `x-ratelimit-remaining: 0`. That is a REPORTED
      // fact about this exact call, not a docs table we could not read and not a
      // tier we inferred — so it may be repeated, verbatim and attributed.
      //
      // The discipline is unchanged and is what keeps this honest: report it
      // ONLY when the header is present on THIS response. Never remember it,
      // never default it, never carry it to a call that did not send one, and
      // never attach a window to it — the header is a bare number, and the only
      // thing naming the window ("free-models-per-min") is the upstream's own
      // prose, which already reaches the user through `detail`. Reported or
      // absent, never inferred.
      //
      // Removing the DIGITS was not enough, and that is the instructive part: the
      // rewrite kept "free models carry a request cap that rises once credits are
      // purchased" — the same unverified claim with the number filed off — six
      // lines under a comment stating that this function "cannot know whether the
      // model in question is free". A comment contradicting its own string, in
      // the same block. MEASURED 2026-08-27: 18 consecutive 429s on the PAID
      // `openai/gpt-oss-20b`, at 1.5s AND at 45s spacing. So the free-tier lead
      // was not merely unverified, it was wrong exactly when a user most needs
      // this message to be right — they are being rate-limited on something they
      // are paying for and are told it is a free-tier cap.
      //
      // `_throwForStatus` is not told the model id, so it cannot say anything
      // tier-specific even if we wanted it to. What is reported is reported: the
      // upstream's own Retry-After when it sends one, and a pointer at
      // `validateKey()`, which returns the LIVE `limit` / `limit_remaining` /
      // `is_free_tier` for THIS key at zero cost and zero tokens. The v3.14.0
      // rule, applied to a rate limit: reported or absent, never inferred.
      this._warn(
        'OpenRouter rate limit reached.' +
        (retryAfter ? ` OpenRouter asks us to wait ${retryAfter}s.` : '') +
        (limit !== null ? ` ${describeReportedLimit(limit, remaining)}` : '') +
        ' Which limit applies depends on the model and on this key\'s account —' +
        ' System Check reads the live figures from OpenRouter\'s own key endpoint,' +
        ' free and without spending a token.'
      );
      const e = new OpenRouterError(
        code,
        // The literal "429" is OUR token, not the upstream's — llm.js's is429()
        // scans the message, and this is the documented interop contract those
        // classifiers already rely on for both SDK providers.
        `OpenRouter ${op} → HTTP 429 (rate limit)${detail ? `: ${detail}` : ''}`,
        status,
      );
      // ── WHY THESE GO ON THE ERROR AND NOT ONLY INTO `_warn` ────────────────
      // MEASURED 2026-08-29: `_warn` reaches NOBODY on any production LLM path.
      // `onWarn` is optional and `llm.js` constructs this adapter as
      // `new OpenRouterAdapter({ apiKey })` — no callback — so `this._onWarn` is
      // null and `_warn()` is a no-op for chat, ingest, Health and compile
      // alike. A figure reported only there would be this repo's dead-data shape
      // again, which is precisely the defect the `retryAfterSeconds` half of
      // this block was written to close. The error is the one carrier that
      // reaches the user, so every measured figure rides on it.
      //
      // RAW, never derived. `retryAfterSeconds` is a DURATION the provider
      // stated; `rateLimitResetMs` is an ABSOLUTE epoch whose meaning depends on
      // the reader's clock. Collapsing the second into the first here would make
      // a clock-dependent guess indistinguishable from a provider-stated fact
      // one layer up, and `llm.js` ranks them differently on purpose.
      if (retryAfter) e.retryAfterSeconds = Number(retryAfter);
      if (resetMs !== null) e.rateLimitResetMs = resetMs;
      if (limit !== null) e.rateLimitLimit = limit;
      if (remaining !== null) e.rateLimitRemaining = remaining;
      throw e;
    }
    if (status === 503) {
      // 503 with allow_fallbacks:false means "no upstream provider met the
      // routing requirements" — the EXPECTED outcome of our own strictness, not
      // an outage. It is therefore DETERMINISTIC: the same request with the same
      // constraints gets the same answer, because a provider does not acquire
      // JSON support during a 39-second backoff.
      //
      // TWO INDEPENDENT LAYERS, and both are needed:
      //
      //  1. `curatorDeterministic` — the structural signal. generateText's ladder
      //     checks it BEFORE is429/is503, so this is never retried and its
      //     accurate text is never replaced by the generic "infrastructure is
      //     temporarily overloaded … affects ALL accounts equally" outage claim.
      //     Measured before the fix: 4 attempts, ~39s of backoff, then a message
      //     telling the user the provider was down when the real answer was
      //     "pick a different model". On a 40-call multi-phase ingest that is
      //     ~26 minutes of apparent hang — the v3.0.17 complaint.
      //  2. The message no longer carries the "HTTP 503" token. That is not
      //     dodging a classifier, it is refusing to emit a sentinel we do not
      //     mean: `ingest-queue.js` matches /\bHTTP\s+503\b/i as a TEXT FALLBACK
      //     for callers that re-wrap an error and lose its properties, so the
      //     literal is this codebase's wire signal for "transient". Left in, it
      //     would PAUSE THE WHOLE BATCH — and pause again on every Resume,
      //     forever, since the condition never clears. The numeric status stays
      //     on `.status` where a machine reads it structurally.
      //
      // Layer 2 also covers the echoed upstream detail: 503 is no longer in
      // TRANSIENT_STATUSES, so `_detail` neutralises retry vocabulary the
      // upstream's own prose might carry.
      const e = new OpenRouterError(
        code,
        `OpenRouter could not serve this model: no upstream provider met the required parameters ` +
        `(The Curator requires JSON support and refuses provider substitution). Retrying will not ` +
        `help — pick a different model in Settings` +
        `${detail ? `. Upstream said: ${detail}` : '.'}`,
        status,
      );
      e.curatorDeterministic = true;
      throw e;
    }
    if (status === 404) {
      // ── A 404 IS THREE DIFFERENT FACTS, AND ONLY ONE OF THEM MAY SPEND ─────
      // See `ROUTING_CONSTRAINT_404_CLAUSES` for the live measurement. Only a
      // measured RETIREMENT keeps `.status = 404` — the property llm.js's
      // `isModelNotFound()` keys on — and so only a retirement walks the
      // fallback chain onto a model the user did not choose.
      //
      // NOTE 401 is checked upstream of model existence: a bogus key with a
      // bogus model returns 401, so a chain walk never starts from an auth
      // failure — which is correct, that would be four more pointless calls.
      const reason = classifyNotFoundReason(raw);

      if (reason === 'model-retired') {
        // UNCHANGED FROM BEFORE THIS BRANCH EXISTED, deliberately: the v2.4.0
        // safety net is load-bearing and a fix for silent substitution must not
        // become a silent removal of the thing that keeps users working on the
        // day a provider retires their model.
        throw new OpenRouterError(code, `OpenRouter ${op} → model not found${detail ? `: ${detail}` : '.'}`, status);
      }

      // ── FAIL-SAFE DIRECTION, STATED: `null` LANDS HERE, NOT ABOVE ──────────
      // `null` means the upstream said something we have never measured, or
      // sent a body we could not read at all. The two outcomes are not
      // symmetric. Walking on a wrong guess spends the user's money on a model
      // they did not pick, silently, and reports success. NOT walking on a
      // wrong guess costs them one visible error and one click to pick another
      // model — and the OpenRouter chain is exactly ONE rung deep, so what is
      // being given up is small and what is being protected is not.
      //
      // The honest price of this choice: a genuine retirement announced in
      // wording we have not measured surfaces as an error instead of degrading
      // gracefully. That is accepted, and it is why `MODEL_RETIRED_404_CLAUSES`
      // is a table — the fix for a reworded retirement is one clause, not a
      // redesign.
      //
      // TWO LAYERS, both needed, exactly as the 503 branch above:
      //  1. `curatorDeterministic` — the structural signal. `callLLM` refuses to
      //     walk the chain on it and `generateText`'s ladder refuses to retry
      //     it or overwrite its message with a generic outage claim.
      //  2. NO not-found signal is emitted at all: `.status` is withheld (this
      //     mirrors `_buildInBandError`, which withholds it for 404 for exactly
      //     this reason) and the prose is neutralised, because `isModelNotFound`
      //     reads the MESSAGE too and fixing only the property closes half the
      //     door. A caller that re-wraps this error and loses its properties —
      //     the case `ingest-queue.js`'s text fallback exists for — must not be
      //     able to recover a retirement verdict from the text.
      // The numeric status is not destroyed, only moved off the property a
      // classifier reads: `httpStatus` keeps the fact available to a log, so
      // "we withheld it" never becomes "there wasn't one".
      const safeDetail = this._detail(raw, status, { keepsStructural404: false });
      const clause = reason === 'routing-constraint'
        ? ROUTING_CONSTRAINT_404_CLAUSES.find(c => c.match.every(t => raw.toLowerCase().includes(t)))
        : null;
      // Model ids come from our own catalogue (the pin route refuses anything
      // else), but this is echoed prose either way: flattened and capped so it
      // can never reshape the message.
      const shownModel = typeof model === 'string' && model.length > 0
        ? `"${model.replace(/[\r\n]+/g, ' ').slice(0, 80)}"`
        : 'this model';
      const why = clause
        ? `no upstream provider satisfies ${clause.capability}`
        : `OpenRouter reported no usable endpoint and did not say why`;
      const e = new OpenRouterError(
        code,
        `OpenRouter could not serve ${shownModel}: ${why}. Retrying will not help, and ` +
        `The Curator will not substitute a different model on its own — pick another model in Settings` +
        `${safeDetail ? `. Upstream said: ${safeDetail}` : '.'}`,
        undefined,
      );
      e.curatorDeterministic = true;
      e.httpStatus = status;
      throw e;
    }
    if (status === 401) {
      throw new OpenRouterError(
        code,
        `⚠ OpenRouter rejected the API key (HTTP 401). Check the key in Settings — OpenRouter validates ` +
        `the key BEFORE the model, so this says nothing about whether the model exists` +
        `${detail ? `. Upstream said: ${detail}` : '.'}`,
        status,
      );
    }
    if (status === 402) {
      throw new OpenRouterError(
        code,
        `⚠ OpenRouter reports insufficient credits (HTTP 402). A negative balance blocks even free ` +
        `models${detail ? `. Upstream said: ${detail}` : '.'}`,
        status,
      );
    }
    throw new OpenRouterError(
      code,
      `OpenRouter ${op} → HTTP ${status}${detail ? `: ${detail}` : ''}`,
      status,
    );
  }

  /**
   * Validate the key and read the account's limits — FREE and ZERO-TOKEN.
   *
   * `GET /key` costs nothing and generates nothing, which makes it strictly
   * better than the "one tiny LLM call" System Check performs for Gemini and
   * Anthropic. `is_free_tier` and a negative `limit_remaining` are both worth
   * surfacing: a negative balance 402s even on free models.
   *
   * @returns {Promise<{ok: boolean, limit: number|null, limitRemaining: number|null,
   *                    usage: number|null, isFreeTier: boolean|null, error: string|null}>}
   */
  async validateKey({ signal = null } = {}) {
    const link = linkSignals(signal, 30_000);
    try {
      const res = await this._fetch(`${this.baseUrl}/key`, {
        method: 'GET',
        headers: this._headers(),
        signal: link.signal,
      });
      if (!res.ok) {
        try { await this._throwForStatus(res, 'key'); }
        catch (err) { return { ok: false, limit: null, limitRemaining: null, usage: null, isFreeTier: null, error: this._redact(String(err.message)) }; }
      }
      const body = await res.json();
      const d = body?.data && typeof body.data === 'object' ? body.data : {};
      const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      return {
        ok: true,
        limit: num(d.limit),
        limitRemaining: num(d.limit_remaining),
        usage: num(d.usage),
        isFreeTier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
        error: null,
      };
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      return { ok: false, limit: null, limitRemaining: null, usage: null, isFreeTier: null, error: this._redact(String(err && err.message)) };
    } finally {
      link.dispose();
    }
  }
}

/** Headers may be a real Headers, a plain object, or absent. Never throws. */
function readHeader(headers, name) {
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') return headers.get(name) ?? null;
    if (typeof headers === 'object') {
      const hit = Object.entries(headers).find(([k]) => k.toLowerCase() === name);
      return hit ? String(hit[1]) : null;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Read a header as a finite number, or null.
 *
 * Deliberately STRICTER than `Number(...)`: an empty string, whitespace, `null`
 * and `[]` all coerce to 0 under `Number`, and a 0 here is a real, actionable
 * figure ("you have 0 requests left"), so coercing an ABSENT header into one
 * would manufacture a fact. The regex requires at least one digit before the
 * conversion, which is what makes "absent" and "zero" distinguishable — the
 * v3.15.0 fact-vs-absence rule, applied to a header.
 */
function readNumericHeader(headers, name) {
  const raw = readHeader(headers, name);
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The one sentence that repeats a provider-reported rate-limit figure.
 *
 * ── WHY IT LIVES HERE AND IS IMPORTED, NOT COPIED ───────────────────────────
 * It has TWO consumers: this adapter's `_warn`, and `llm.js`'s
 * `buildRateLimitMessage` — the message a user actually reads when the ladder
 * is exhausted. Two hand-maintained copies of one claim is the shape that
 * produced this repo's v3.2.0 CRITICAL, and a claim about a NUMBER is the worst
 * case of it: the copies would not diverge visibly, they would diverge in what
 * they assert. So there is one function, `llm.js` imports it, and `subject`
 * carries the provider name so nothing about it is OpenRouter-specific.
 *
 * ── WHAT IT DELIBERATELY DOES NOT SAY ───────────────────────────────────────
 * No window. `x-ratelimit-limit` is a bare number; naming it "per minute" would
 * be an inference, and the only thing that names the window is the upstream's
 * own prose ("free-models-per-min"), which already reaches the user as `detail`.
 * No tier either — v3.18.0 measured 18 consecutive 429s on a PAID model, so
 * "free tier" was wrong exactly when the user most needed it right.
 *
 * ── WHY A ZERO REMAINING IS SUPPRESSED ──────────────────────────────────────
 * On a 429 `remaining: 0` is the EXPECTED value — it is what a rate limit means.
 * Printing it states the definition of the error back at the reader, the
 * no-information shape v3.18.0 deleted the `chat only` badge for. A NON-zero
 * remaining is the informative case: refused while the counter still shows
 * quota, which tells the user some OTHER limit was reached. That one is kept.
 */
export function describeReportedLimit(limit, remaining, subject = 'OpenRouter') {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return '';
  const rem = (typeof remaining === 'number' && Number.isFinite(remaining) && remaining > 0)
    ? ` with ${remaining} remaining`
    : '';
  return `${subject} reported a limit of ${limit}${rem} on this response.`;
}

/** Test-only surface — the pure helpers, so a suite can drive them directly. */
export const __testing = {
  describeReportedLimit,
  neutralizeRetrySignals,
  neutralizeNotFoundSignals,
  linkSignals,
  readHeader,
  readNumericHeader,
  SECRET_PATTERNS,
  TRANSIENT_STATUSES,
};
