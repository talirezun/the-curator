/**
 * openrouter-qualify.js — MEASURE one OpenRouter model against the user's OWN
 * wiki, so a model the provider merely LISTS can be judged on whether it can do
 * the one job the build lane asks of it.
 *
 * ── WHY THIS EXISTS, AND WHY IT WAS PREVIOUSLY REFUSED ──────────────────────
 *
 * `docs/model-lifecycle.md` rejects on-demand qualification in four parts. Three
 * of them still hold and this module is SHAPED by them; exactly one does not
 * apply here, and that is the whole opening:
 *
 *   (a) "Metadata says a model ACCEPTS JSON mode. It cannot say the JSON
 *       PARSES." — HOLDS, and is why a probe must exist at all. The case of
 *       record is `z-ai/glm-4.7`: 204,800 context, 131,072 output ceiling, JSON
 *       mode advertised, a real price, no alias, no expiry — it passes EVERY
 *       structural filter this app has, and it is FAST (38 s). Measured against
 *       the real outline prompt it returned, in 9 of 9 runs, JSON that neither
 *       `JSON.parse` nor `jsonrepair` could recover. Without a probe a user
 *       pinning it discovers that by watching their wiki fill with stub pages.
 *
 *   (b) "A probe a new user could run would be a toy probe." — TRUE OF A FRESH
 *       INSTALL, AND FALSE OF THE USER WHO WANTS THIS. That objection is a
 *       statement about the PROMPT: ~99% of the real 341,005-char outline
 *       request is the user's own index.md and slug inventory, and a fresh
 *       install has neither. A user asking to build their second brain with a
 *       different model HAS a wiki by definition. So this module never
 *       synthesises a prompt: it assembles the REAL `buildOutlinePrompt` from
 *       the user's own domain, read-only. If the domain is too thin to produce
 *       one, we REFUSE rather than probe with a toy (see assembleProbePrompt).
 *
 *   (c) "One probe cannot see a 2-in-9 defect." — HOLDS, and is why
 *       `QUALIFY_MIN_RUNS` is 9 and why fewer runs are recorded but do not
 *       qualify anything.
 *
 *   (d) "`suitability` and `note` are COMPARATIVE." — HOLDS, and is the rule
 *       this module obeys most strictly: IT EMITS FACTS AND NEVER A VERDICT.
 *       "9 of 9 usable, median 23 pages, 41 s mean, $0.04" is a fact.
 *       "better than X" is a comparative judgement a machine may not write, so
 *       nothing here ranks, recommends, or compares two models. The outcome
 *       vocabulary is deliberately `NO_DEFECT_FOUND` — never "passed", never
 *       "verified" — because 9 clean runs are consistent with a true failure
 *       rate up to ~33% at 95% confidence (the rule of three) and the UI is
 *       required to say so.
 *
 * ── A MEASUREMENT IS A STATEMENT ABOUT A MOMENT, AND CARRIES ITS OWN SCOPE ──
 * An OpenRouter id routes over upstream hosts that can change, so a result can
 * go stale WITHOUT the id changing. Every record is therefore stamped with WHICH
 * WIKI (`domain`, plus the prompt's sha256) and WHEN (`measuredAt`), and those
 * are rendered, not just stored. A record is never a global claim about a model.
 *
 * ── THE TWO TRAPS, INHERITED FROM scripts/probe-openrouter-models.js ────────
 * That file is the validated research harness this module reproduces, and it
 * documents two ways the obvious implementation becomes a rubber stamp:
 *
 *   TRAP 1 — `parseJSON` (ingest.js) ERASES THE DISTINCTION BEING MEASURED. It
 *   tries raw parse, then fence-strip, then `jsonrepair`, and returns NO
 *   provenance. A qualifier that only calls parseJSON records every model as
 *   clean and the whole feature is worthless. So `classifyResponse` calls bare
 *   `JSON.parse` ITSELF first, and only then falls back to parseJSON.
 *
 *   TRAP 2 — "PARSES" IS NOT "USABLE". `jsonrepair` turns the bare text
 *   `not json at all` into the truthy STRING "not json at all". The real
 *   production gate is `usablePageArray`, imported here from ingest.js's
 *   `__testing` rather than re-implemented, so it cannot drift from what ingest
 *   actually accepts.
 *
 * Both traps are covered by executable controls in the suite, which is the
 * answer to "what input would make this check report a failure?".
 *
 * ── DUPLICATION, STATED RATHER THAN HIDDEN ─────────────────────────────────
 * `scripts/probe-openrouter-models.js` holds an independent copy of this
 * classification. Two hand-maintained copies of one rule is this repo's named
 * cause of the v3.2.0 CRITICAL, and the right end state is for that script to
 * import from here. It was NOT changed in this release because a live
 * measurement was running against it at the time. The suite pins this module's
 * classifier against the same corpus that script's `--self-test` uses, so a
 * drift between the two surfaces as a failure rather than as silence.
 *
 * ── IT DOES NOT GO THROUGH `generateText`, AND THAT IS LOAD-BEARING ─────────
 * `getProviderInfo()` enforces the offerable allow-list and the build-lane
 * gate, so a candidate — a chat-only model, which is the only kind worth
 * qualifying — would be REFUSED and silently demoted to the provider default.
 * We would measure `upstage/solar-pro4` nine times and file the result under the
 * candidate's name. `generateText` would also fold in the 429/503 retry loop and
 * the fallback chain (confounding latency, spend AND model identity) and would
 * convert `finish_reason: "length"` into a throw, turning the single most
 * expensive failure mode into an opaque error instead of a measurement.
 *
 * So this drives the PRODUCTION adapter directly, first attempt only, which is
 * what characterises a model. Production's recovery ladders sit on top of that.
 *
 * ── READ-ONLY WITH RESPECT TO THE WIKI ─────────────────────────────────────
 * It assembles a prompt and calls a model. It never calls writePage, never runs
 * ingestFile, never writes a wiki page. The ONLY thing persisted is the record,
 * written by llm.js into user-data, never into `domains/` (which is Personal
 * Sync's git work-tree — the v3.3.0 rule that kept the ingest queue out of the
 * user's public GitHub repo).
 *
 * ── INJECTED SEAMS ─────────────────────────────────────────────────────────
 * `opts.callModel` and `opts.now` are injected so the whole ladder — including
 * the abort classifier and the rate-limit path — is driveable OFFLINE and FREE
 * with a fake. They default to the real adapter and the real clock.
 */

import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { readIndex, readSchema, wikiPath, rawPath } from './files.js';
import {
  capExistingFilesForPrompt,
  computeSummarySlugFromSource,
  extractText,
  parseJSON,
  __testing as ingestTesting,
} from './ingest.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';
// ONE DEFINITION, and it lives in llm.js because it is part of the definition of
// the BUILD LANE, which has exactly one home. The mechanical reason is also
// decisive: this module imports ingest.js, and ingest.js imports llm.js, so
// defining the predicate here and importing it there would close a module cycle.
// Re-exported below so callers have a single name for it.
import { QUALIFY_MIN_RUNS, isPassingRecord } from './llm.js';

const { buildOutlinePrompt, usablePageArray, MULTI_PHASE_OUTLINE_TOKENS, TEXT_CAP } = ingestTesting;

/**
 * ── HOW MANY RUNS A QUALIFICATION NEEDS, AND WHY IT IS NOT NEGOTIABLE ───────
 *
 * Nine. One run cannot distinguish a model that emits clean JSON from one that
 * got lucky, and the defect class this exists to catch showed up in this
 * project's own Gemini catalogue at 2-in-9: a single probe passes such a model
 * about 78% of the time, which would launder a coin-flip into a badge.
 *
 * FEWER RUNS ARE RECORDED BUT QUALIFY NOTHING. A 2-run record is a real
 * measurement of something (the plumbing works, the model answered) and is
 * displayed honestly with its run count; it simply does not satisfy
 * `isPassingRecord`. That asymmetry is the point — the record is evidence, and
 * the gate reads the evidence rather than the user's intent in gathering it.
 *
 * The constant and the predicate are RE-EXPORTED from llm.js rather than
 * redefined: two hand-maintained copies of a gate is this repo's named cause of
 * the v3.2.0 CRITICAL, and here the two copies would be a money decision.
 */
export { QUALIFY_MIN_RUNS, isPassingRecord };

export const QUALIFY_DEFAULT_RUNS = 9;

/** Consecutive budget-burn runs before a candidate is abandoned. */
export const QUALIFY_ABORT_AFTER = 3;

/** Consecutive 429s before we stop and record NOT_MEASURED. */
export const QUALIFY_RATE_LIMIT_ABORT_AFTER = 3;

/** Delay between runs, so a probe does not itself look like an attack. */
export const QUALIFY_SPACING_MS = 1_500;

/**
 * MEASURED per-call latency across candidate models, used ONLY to quote an
 * honest RANGE before the user commits — never as a prediction for a specific
 * model, which we cannot make and do not pretend to.
 *
 *   upstage/solar-pro4               ~53 s   (the shipping OpenRouter default)
 *   z-ai/glm-4.7                     ~38 s
 *   z-ai/glm-5.3-flash              ~289 s
 *   deepseek/deepseek-v4-flash-0731 ~382 s   (6.4 MINUTES for ONE outline call)
 *
 * ⚠ 382 s IS NOT THE WORST CASE, AND THIS CONSTANT MUST NOT QUOTE IT AS ONE.
 * The same measurement session recorded TWO calls that did not finish at all:
 * deepseek's second run and glm-5.3-flash's ninth both hit the adapter's 600 s
 * ceiling (the latter at 988 s of wall clock). So `slow` is set to that CEILING,
 * not to the slowest call that happened to SUCCEED. The difference matters
 * because this is the number the confirm dialog leads with: an estimate built
 * from successes alone is systematically optimistic exactly where the user most
 * needs it not to be, and quoting 57 minutes for a run that can take 90 is the
 * under-quote this whole feature exists to avoid. 600 s is a bound the adapter
 * ENFORCES, so unlike a sampled maximum it cannot be exceeded by the next model
 * nobody has measured yet.
 *
 * TIME, NOT MONEY, IS THE BINDING CONSTRAINT HERE and the confirm must say so.
 * Nine runs at ~85k input tokens costs roughly $0.08-$0.38; nine runs at 382 s
 * apiece is 57 MINUTES. A user quoted a price and not a duration will start a
 * run they cannot afford in the only currency that matters.
 */
export const QUALIFY_OBSERVED_CALL_SECONDS = Object.freeze({ fast: 38, slow: 600 });

const sha256 = s => createHash('sha256').update(s).digest('hex');

function makeCancelled() {
  const e = new Error('Qualification cancelled.');
  e.code = 'QUALIFY_CANCELLED';
  return e;
}

/**
 * A cancel is not a measurement, and it arrives in two shapes: our own
 * `QUALIFY_CANCELLED` from the inter-run sleep, and the transport's
 * `AbortError` from a fetch that was already in flight. Both must be recognised
 * BEFORE the error classifier runs, or an aborted fetch is filed as a model
 * FAILURE — recording a defect against a model the user merely stopped asking
 * about. `signal.aborted` is checked alongside the name because this repo has a
 * recorded finding that the Anthropic SDK's abort error carries `name: 'Error'`.
 */
export function isCancelledError(err) {
  return !!err && (err.code === 'QUALIFY_CANCELLED' || err.name === 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(makeCancelled());
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { cleanup(); reject(makeCancelled()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ── classification — the heart of the measurement ────────────────────────────

/**
 * Classify one raw model response.
 *
 * `parseClass` is exactly one of:
 *   'raw'          bare JSON.parse(rawText) succeeded — no repair pass at all.
 *   'repaired'     bare parse threw, but parseJSON recovered something.
 *   'unrepairable' parseJSON threw too.
 *
 * `usable` is the REAL production gate (`usablePageArray`), applied
 * INDEPENDENTLY of parseClass, because the two fail separately: a 'raw' run can
 * be unusable (an empty pages array parses perfectly and plans nothing) and a
 * 'repaired' run is usually fine.
 *
 * ── `repaired` IS NOT A FAILURE, AND THAT IS MEASURED, NOT CHARITABLE ───────
 * `claude-haiku-4-5` — the shipping Anthropic default — fences its outline in a
 * markdown code block 3 times out of 3, so a raw parse fails on 100% of its
 * responses and every Anthropic ingest depends entirely on the repair path.
 * Rejecting on `repaired` would reject the model this app ships. raw-vs-repaired
 * is a recorded fact and a tiebreak; only `unrepairable` and `unusable` are
 * defects.
 */
export function classifyResponse(rawText) {
  const out = {
    parseClass: 'unrepairable',
    usable: false,
    pageCount: null,
    textLen: typeof rawText === 'string' ? rawText.length : 0,
    parseError: null,
  };
  if (typeof rawText !== 'string' || rawText.length === 0) {
    out.parseError = 'empty response text';
    return out;
  }

  let parsed = null;
  // TRAP 1. This bare parse is the ONLY thing that can distinguish raw from
  // repaired. parseJSON's own first branch does the same work and then throws
  // the answer away, which is why it cannot be reused here.
  try {
    parsed = JSON.parse(rawText);
    out.parseClass = 'raw';
  } catch {
    try {
      parsed = parseJSON(rawText);
      out.parseClass = 'repaired';
    } catch (err) {
      out.parseClass = 'unrepairable';
      out.parseError = String(err && err.message).slice(0, 300);
      return out;
    }
  }

  // TRAP 2. parseJSON returning something is not success — the real gate decides.
  const pages = usablePageArray(parsed);
  out.usable = pages !== null;
  out.pageCount = pages ? pages.length : 0;
  if (!out.usable) {
    out.parseError = `parsed as ${Array.isArray(parsed) ? 'array' : typeof parsed}`
      + ' but usablePageArray() refused it (no non-empty pages[] with a string path)';
  }
  return out;
}

/**
 * OpenAI-compatible usage block -> the fields we record.
 *
 * A MISSING FIELD IS `null`, NEVER `0`. This is v3.15.0's eight-places defect in
 * its original form: `0` is truthy in an object test, falsy in arithmetic, and
 * renders as `$0.00` — so "we were not told the cost" silently becomes "this
 * cost nothing", which is the one confusion this project has already shipped.
 */
export function readUsage(u) {
  const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (!u || typeof u !== 'object') {
    return { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null, reportedCostUsd: null };
  }
  return {
    inputTokens: n(u.prompt_tokens),
    outputTokens: n(u.completion_tokens),
    reasoningTokens: n(u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens),
    cachedTokens: n(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens),
    // OpenRouter reports `usage.cost` in USD 1:1 and it agreed with catalogue
    // arithmetic to six decimal places when measured. It is the authoritative
    // spend figure here, because a candidate has no catalogue entry of ours yet.
    reportedCostUsd: n(u.cost),
  };
}

/**
 * Did this run burn the output budget and produce nothing usable?
 *
 * This is the `nex-agi/nex-n2-mini` shape: reasoning advertised as OPTIONAL,
 * then the ENTIRE output budget spent on hidden reasoning with nothing parseable
 * returned, at ~160 s a go. It is the most expensive failure mode available and
 * it lives exactly where the reasoning-capable open-weight families are.
 *
 * TWO CAUSES ARE REPORTED APART rather than both filed as reasoning burn:
 *   'reasoning'  — (almost) no visible text, or the provider attributes at
 *                  least half the output to reasoning tokens. POSITIVE evidence.
 *   'truncation' — plenty of visible text; the model simply ran out of budget
 *                  mid-JSON. Equally disqualifying, equally aborting, but
 *                  calling it reasoning burn would be a claim the evidence does
 *                  not support, and an over-claimed diagnosis is worth less than
 *                  an honest one.
 */
export function budgetBurn(run) {
  const budget = MULTI_PHASE_OUTLINE_TOKENS;
  const out = run.outputTokens;
  const atCeiling = run.finishReason === 'length'
    || (typeof out === 'number' && budget > 0 && out >= budget * 0.95);
  if (!atCeiling || run.usable) return null;
  const visible = typeof run.textLen === 'number' ? run.textLen : 0;
  const reasoningHeavy = typeof run.reasoningTokens === 'number'
    && typeof out === 'number' && out > 0 && run.reasoningTokens >= out * 0.5;
  return (visible < 200 || reasoningHeavy) ? 'reasoning' : 'truncation';
}

/**
 * Error -> a stable class plus a message safe to show.
 *
 * A RATE LIMIT IS NOT A DEFECT AND NOT A PASS. Free ids draw on a SHARED
 * upstream pool, so whether one answers is not a property of the user's account:
 * measured over a ten-minute poll, one free model answered 8 of 8 while three of
 * its free siblings answered 0 of 8, same account, same moment. Classifying a
 * 429 as a failure would blame the model for the queue; classifying it as a pass
 * would qualify a model we never measured. It gets its own outcome.
 *
 * Classification is STRUCTURAL — on the numeric status and the adapter's own
 * error code — never a substring match on prose. This repo's `/\b429\b/` once
 * matched its own sentence about "429 characters".
 */
export function classifyProbeError(err) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  const status = err && Number.isFinite(err.status) ? err.status : null;
  let errorClass = code || (err && err.name === 'AbortError' ? 'ABORTED' : 'UNKNOWN_ERROR');
  if (status === 429 || code === 'OPENROUTER_RATE_LIMIT') errorClass = 'RATE_LIMITED';
  let message = '';
  try { message = String((err && err.message) || err); } catch { message = 'unstringifiable error'; }
  return { errorClass, httpStatus: status, errorMessage: message.slice(0, 300) };
}

// ── prompt assembly, from the user's OWN domain ──────────────────────────────

/**
 * Only this many candidate sources are opened, so a domain full of unreadable
 * files cannot turn a free estimate into a long scan.
 */
const MAX_SOURCE_ATTEMPTS = 5;
const TEXT_EXTS = new Set(['.md', '.txt', '.markdown']);

/**
 * Choose the source document the probe reads.
 *
 * A probe prompt is only realistic if it carries a real source at (or near)
 * ingest's own 80,000-char cap, so we prefer the LARGEST readable file in the
 * domain's `raw/`.
 *
 * TEXT FILES FIRST, AND THAT IS MEASURED RATHER THAN TIDY: most `raw/` PDFs in
 * real wikis here are image-only exports that extract to under 200 chars (two of
 * the largest measured at 102 and 16), which ingest itself refuses. Trying PDFs
 * first would spend seconds of extraction to arrive at a refusal.
 */
export async function pickProbeSource(domain, opts = {}) {
  const dir = rawPath(domain);
  let names = [];
  try { names = await readdir(dir); } catch { names = []; }
  const sized = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const ext = path.extname(name).toLowerCase();
    if (!TEXT_EXTS.has(ext) && ext !== '.pdf') continue;
    try {
      const st = await stat(path.join(dir, name));
      if (st.isFile()) sized.push({ name, size: st.size, isText: TEXT_EXTS.has(ext) });
    } catch { /* unreadable entry — skip; never fail a probe on one bad file */ }
  }
  // Text before PDF, then largest first, then by name so two estimates of the
  // same domain agree rather than depending on readdir order.
  sized.sort((a, b) =>
    (Number(b.isText) - Number(a.isText)) || (b.size - a.size) || a.name.localeCompare(b.name));

  const extract = opts.extractText || extractText;
  const tried = [];
  for (const cand of sized.slice(0, MAX_SOURCE_ATTEMPTS)) {
    let text = '';
    try {
      text = await extract(path.join(dir, cand.name));
    } catch (err) {
      tried.push(`${cand.name}: ${err && err.message}`);
      continue;
    }
    if (typeof text === 'string' && text.length >= 200) {
      return { name: cand.name, filePath: path.join(dir, cand.name), text };
    }
    tried.push(`${cand.name}: extracted only ${typeof text === 'string' ? text.length : 0} chars`);
  }
  const e = new Error(
    `The "${domain}" domain has no readable source document in its raw/ folder, so a realistic ` +
    'ingest prompt cannot be built for it. Ingest a text or markdown source into this domain first, ' +
    'then try again.' + (tried.length ? ` (Tried: ${tried.slice(0, 3).join('; ')})` : ''),
  );
  e.code = 'QUALIFY_NO_SOURCE';
  throw e;
}

/**
 * ── WE REFUSE TO PROBE WITH A TOY PROMPT ───────────────────────────────────
 * The whole reason on-wiki qualification is honest where on-install
 * qualification is not is that the prompt is REAL. A domain with no index and no
 * slug inventory produces exactly the small synthetic prompt
 * `docs/model-lifecycle.md` forbids — one that returns a shape which passes
 * green while the real prompt returns one that fails. So a prompt below this
 * floor is a REFUSAL, not a cheaper measurement.
 */
export const MIN_REALISTIC_PROMPT_CHARS = 20_000;

/**
 * Assemble the REAL Phase-1 outline prompt for `domain`. READ-ONLY.
 *
 * Assembled ONCE per qualification and reused verbatim for every run, so the
 * runs are byte-identical to each other and therefore comparable to each other.
 * Re-assembling per run would let the date — or a concurrent edit — move the
 * prompt underneath the measurement.
 */
export async function assembleProbePrompt(domain, opts = {}) {
  const source = opts.source || await pickProbeSource(domain, opts);
  const wikiDir = wikiPath(domain);
  const readFolder = async folder => {
    try {
      const f = await readdir(path.join(wikiDir, folder));
      return f.filter(x => x.endsWith('.md'));
    } catch { return []; }
  };
  const existingFiles = { entities: await readFolder('entities'), concepts: await readFolder('concepts') };
  const index = await readIndex(domain).catch(() => '');
  const schema = await readSchema(domain).catch(() => '');
  const text = source.text.slice(0, TEXT_CAP);
  const capped = capExistingFilesForPrompt(existingFiles, text);
  const summaryPath = `summaries/${computeSummarySlugFromSource(source.name)}.md`;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const userPrompt = buildOutlinePrompt(today, index, capped.files, source.name, text, false, summaryPath);

  const invChars = capped.files.entities.reduce((n, f) => n + f.length + 12, 0)
                 + capped.files.concepts.reduce((n, f) => n + f.length + 12, 0);
  const promptChars = schema.length + userPrompt.length;

  if (promptChars < MIN_REALISTIC_PROMPT_CHARS) {
    const e = new Error(
      `The "${domain}" domain is too small to measure a model against: its real ingest prompt is only ` +
      `${promptChars.toLocaleString()} characters. A meaningful result needs a wiki with a real index and ` +
      'page inventory behind it — measuring against a nearly-empty domain would produce a number that ' +
      'says nothing about how the model behaves on yours. Ingest more sources first.',
    );
    e.code = 'QUALIFY_DOMAIN_TOO_THIN';
    throw e;
  }

  return {
    domain,
    systemPrompt: schema,
    userPrompt,
    promptChars,
    promptSha256: sha256(schema + ' ' + userPrompt),
    sourceName: source.name,
    sourceSha256: sha256(source.text),
    sourceChars: source.text.length,
    indexChars: index.length,
    inventoryChars: invChars,
    entityCount: capped.files.entities.length,
    conceptCount: capped.files.concepts.length,
    maxTokens: MULTI_PHASE_OUTLINE_TOKENS,
  };
}

// ── the estimate: free, local, no network, no LLM ────────────────────────────

/**
 * What one qualification will cost in TIME and in MONEY, before anything is spent.
 *
 * ── TIME LEADS, AND IT IS A RANGE BECAUSE WE CANNOT PREDICT IT ─────────────
 * We do not know how slow a model is until we measure it — that is the point of
 * measuring. Inventing a per-model figure would be exactly the shape this
 * project keeps refusing. So the estimate quotes the MEASURED RANGE ACROSS
 * MODELS (`QUALIFY_OBSERVED_CALL_SECONDS`: 38 s to 382 s per call, i.e. roughly
 * 6 to 60 minutes for nine runs) and says plainly that it cannot say which. The
 * moment run 1 lands, `projectRemainingMs` gives a real projection from a real
 * measurement, and that is what the progress stream shows instead.
 *
 * ── MONEY IS TRI-STATE, NEVER COERCED ─────────────────────────────────────
 *   free     — `isFreeModel` says so. Cost is exactly zero and is SAID to be
 *              zero. This is the one case where $0.00 is the truth, and v3.15.0
 *              shipped a button reading "cost unknown" on precisely the model
 *              whose cost is known exactly.
 *   priced   — a real figure derived from `getModelPrice`.
 *   unknown  — no price posture at all. Rendered as unknown, NEVER as $0.00 and
 *              never inferred. `getModelPrice` returns null for a FREE model BY
 *              DESIGN, which is why freeness is asked FIRST and separately: read
 *              in the other order, every free model reports "cost unknown".
 *
 * Output tokens are unknown ahead of time (they are what we are measuring), so
 * the money figure is explicitly INPUT-ONLY and labelled as a floor.
 */
export function estimateQualification({ prompt, runs, modelId, isFree, price }) {
  const n = Number.isFinite(runs) ? Math.max(1, Math.trunc(runs)) : QUALIFY_DEFAULT_RUNS;
  // ~4 chars/token, the same approximation the eligibility module uses to
  // resolve an effective price at ingest prompt size.
  const inputTokensPerRun = Math.round(prompt.promptChars / 4);
  const totalInputTokens = inputTokensPerRun * n;

  let cost;
  if (isFree === true) {
    cost = { kind: 'free', usd: 0, note: 'This model is free — the run costs nothing.' };
  } else if (price && Number.isFinite(price.input)) {
    cost = {
      kind: 'priced',
      usd: (totalInputTokens / 1e6) * price.input,
      note: 'Input only. Output is what we are measuring, so it cannot be priced in advance — '
          + 'treat this as a floor.',
    };
  } else {
    // NEVER 0 here. "We have no price for this model" and "this model is free"
    // are different facts, and collapsing them is the defect this branch exists
    // to avoid.
    cost = {
      kind: 'unknown',
      usd: null,
      note: 'No price is published for this model, so the cost cannot be estimated in advance.',
    };
  }

  const { fast, slow } = QUALIFY_OBSERVED_CALL_SECONDS;
  return {
    modelId,
    runs: n,
    minRunsToQualify: QUALIFY_MIN_RUNS,
    promptChars: prompt.promptChars,
    inputTokensPerRun,
    totalInputTokens,
    cost,
    time: {
      // A RANGE, from models actually measured — not a prediction for this one.
      fastestSeconds: fast * n,
      slowestSeconds: slow * n,
      note: 'We cannot predict how slow this particular model is until we measure it. Across the '
          + 'models measured so far, one outline call took between 38 seconds and 6.4 minutes — so '
          + 'nine runs land somewhere between about 6 minutes and an hour. You can stop at any time.',
    },
  };
}

/** A real projection, from a real measurement, once at least one run has landed. */
export function projectRemainingMs(latenciesMs, runsRemaining) {
  const ok = (latenciesMs || []).filter(v => Number.isFinite(v) && v >= 0);
  if (!ok.length || !Number.isFinite(runsRemaining) || runsRemaining <= 0) return null;
  const mean = ok.reduce((a, b) => a + b, 0) / ok.length;
  return Math.round((mean + QUALIFY_SPACING_MS) * runsRemaining);
}

// ── summarising a set of runs into the record ────────────────────────────────

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Reduce raw per-run rows to the record that is stored and shown.
 *
 * THE DECISION RULE OF RECORD: ANY unrepairable, ANY parsed-but-unusable, ANY
 * outright failure, or a burn abort => `DEFECT_OBSERVED`. The asymmetry is
 * deliberate — a false rejection costs a candidate, a false acceptance ships a
 * model that silently writes broken wikis and bills the user for it.
 *
 * `NO_DEFECT_FOUND` is the strongest thing this function is permitted to say and
 * it is deliberately weaker than "pass". A `DEFECT_OBSERVED` is the stronger
 * claim of the two: a defect was actually observed.
 */
export function summariseRuns(rows, meta = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const completed = list.filter(r => r.outcome === 'COMPLETED');
  const raw = completed.filter(r => r.parseClass === 'raw').length;
  const repaired = completed.filter(r => r.parseClass === 'repaired').length;
  const unrepairable = completed.filter(r => r.parseClass === 'unrepairable').length;
  const usableRuns = completed.filter(r => r.usable).length;
  // Parsed (raw or repaired) but refused by usablePageArray. Kept DISTINCT from
  // `unrepairable`: they are different defects with different causes, and the
  // one that parses cleanly is the more surprising of the two.
  const unusable = completed.length - usableRuns - unrepairable;
  const notMeasured = list.filter(r => r.outcome === 'NOT_MEASURED').length;
  const failed = list.filter(r => r.outcome === 'FAILED').length;

  const pages = completed.filter(r => r.usable).map(r => r.pageCount).filter(Number.isFinite);
  const lats = list.map(r => r.latencyMs).filter(Number.isFinite);

  // SPEND: sum what was REPORTED, and say whether anything was missing. A
  // completed run that reported no cost makes the total a LOWER BOUND, which is
  // a different fact from the total being unknown, and both differ from free.
  const costed = completed.filter(r => Number.isFinite(r.reportedCostUsd));
  const spendUsd = costed.reduce((n, r) => n + r.reportedCostUsd, 0);
  const spendComplete = completed.length > 0 && costed.length === completed.length;
  // An identical prompt on every run can hit an upstream prompt cache, which a
  // real ingest (different source each time, growing index) will not. Measured
  // on the reference harness: 2 of 9 runs came back 75% cache-discounted,
  // pulling a 9-run total 17% BELOW list price. So measured spend is a FLOOR,
  // and saying so is the difference between a number and a forecast.
  const cacheHitRuns = completed.filter(r => Number.isFinite(r.cachedTokens) && r.cachedTokens > 0).length;

  const aborted = meta.aborted || null;
  let outcome;
  if (meta.cancelled) outcome = 'CANCELLED';
  else if (aborted === 'NOT_MEASURED_RATE_LIMITED') outcome = 'NOT_MEASURED';
  else if (aborted) outcome = 'DEFECT_OBSERVED';
  else if (unrepairable > 0 || unusable > 0 || failed > 0) outcome = 'DEFECT_OBSERVED';
  else if (completed.length === 0) outcome = 'NOT_MEASURED';
  else outcome = 'NO_DEFECT_FOUND';

  return {
    version: 1,
    provider: 'openrouter',
    modelId: meta.modelId || null,
    // WHICH WIKI and WHEN. Not decoration: an OpenRouter id routes over upstream
    // hosts that change, so a measurement is a statement about a moment and a
    // corpus, never a global claim about the model.
    domain: meta.domain || null,
    measuredAt: meta.measuredAt || null,
    promptChars: Number.isFinite(meta.promptChars) ? meta.promptChars : null,
    promptSha256: meta.promptSha256 || null,
    sourceName: meta.sourceName || null,
    runsRequested: Number.isFinite(meta.runsRequested) ? meta.runsRequested : null,
    runsAttempted: list.length,
    runsCompleted: completed.length,
    counts: { raw, repaired, unrepairable, unusable, notMeasured, failed },
    pages: {
      median: median(pages),
      min: pages.length ? Math.min(...pages) : null,
      max: pages.length ? Math.max(...pages) : null,
      n: pages.length,
    },
    latencyMs: {
      mean: lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null,
      min: lats.length ? Math.min(...lats) : null,
      max: lats.length ? Math.max(...lats) : null,
      n: lats.length,
    },
    spendUsd: costed.length ? spendUsd : null,
    spendComplete,
    spendIsLowerBound: cacheHitRuns > 0,
    cacheHitRuns,
    aborted,
    cancelled: !!meta.cancelled,
    outcome,
    minRunsToQualify: QUALIFY_MIN_RUNS,
  };
}

// ── the run ──────────────────────────────────────────────────────────────────

/**
 * The default transport: the PRODUCTION adapter, so the request carries the same
 * routing refusal, `require_parameters`, JSON response format and output budget
 * a real ingest sends. Building a private fetch here would reproduce the
 * toy-probe error at the transport layer instead of at the prompt layer.
 */
function defaultCallModel(apiKey, timeoutMs) {
  const adapter = new OpenRouterAdapter(
    Number.isFinite(timeoutMs) ? { apiKey, timeoutMs } : { apiKey },
  );
  return args => adapter.createChatCompletion(args);
}

/**
 * Measure `modelId` against `domain`, `runs` times.
 *
 * @param {object}      o
 * @param {string}      o.modelId
 * @param {string}      o.domain
 * @param {string}      [o.apiKey]      only used by the default transport
 * @param {number}      [o.runs]
 * @param {Function}    [o.callModel]   INJECTED transport (offline tests)
 * @param {Function}    [o.now]         INJECTED clock (offline tests)
 * @param {Function}    [o.onProgress]
 * @param {AbortSignal} [o.signal]      cancellation
 * @param {object}      [o.prompt]      pre-assembled prompt (skips re-assembly)
 * @param {number}      [o.spacingMs]
 * @returns {Promise<{record: object, runs: Array}>}
 */
export async function qualifyModel(o) {
  const runs = Number.isFinite(o.runs) ? Math.max(1, Math.trunc(o.runs)) : QUALIFY_DEFAULT_RUNS;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const emit = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const signal = o.signal || null;
  const spacingMs = Number.isFinite(o.spacingMs) ? o.spacingMs : QUALIFY_SPACING_MS;

  const prompt = o.prompt || await assembleProbePrompt(o.domain, o);
  const callModel = o.callModel || defaultCallModel(o.apiKey, o.timeoutMs);

  emit({
    type: 'start',
    modelId: o.modelId,
    domain: o.domain,
    runs,
    promptChars: prompt.promptChars,
    sourceName: prompt.sourceName,
    minRunsToQualify: QUALIFY_MIN_RUNS,
  });

  const rows = [];
  const latencies = [];
  let consecutiveBurn = 0;
  let consecutive429 = 0;
  let aborted = null;
  let cancelled = false;

  for (let run = 1; run <= runs; run++) {
    if (signal && signal.aborted) { cancelled = true; break; }

    const t0 = now();
    let row;
    try {
      const res = await callModel({
        model: o.modelId,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        maxTokens: prompt.maxTokens,
        responseFormat: 'json',
        signal,
      });
      const cls = classifyResponse(res && res.text);
      row = {
        run,
        outcome: 'COMPLETED',
        latencyMs: now() - t0,
        resolvedModel: (res && res.model) || null,
        finishReason: (res && res.finishReason) || null,
        parseClass: cls.parseClass,
        usable: cls.usable,
        pageCount: cls.pageCount,
        textLen: cls.textLen,
        parseError: cls.parseError,
        ...readUsage(res && res.usage),
        errorClass: null, httpStatus: null, errorMessage: null,
      };
      row.budgetBurn = budgetBurn(row);
    } catch (err) {
      // A CANCEL IS NOT A MEASUREMENT, and it must be recognised BEFORE the
      // error classifier runs — otherwise an aborted in-flight fetch is filed as
      // a model FAILURE, recording a defect against a model the user merely
      // stopped asking about.
      if (isCancelledError(err) || (signal && signal.aborted)) { cancelled = true; break; }
      const e = classifyProbeError(err);
      row = {
        run,
        outcome: e.errorClass === 'RATE_LIMITED' ? 'NOT_MEASURED' : 'FAILED',
        latencyMs: now() - t0,
        resolvedModel: null, finishReason: null,
        parseClass: null, usable: false, pageCount: null, textLen: 0, parseError: null,
        inputTokens: null, outputTokens: null, reasoningTokens: null,
        cachedTokens: null, reportedCostUsd: null, budgetBurn: null,
        ...e,
      };
    }

    rows.push(row);
    if (Number.isFinite(row.latencyMs)) latencies.push(row.latencyMs);
    emit({
      type: 'run',
      run,
      of: runs,
      outcome: row.outcome,
      parseClass: row.parseClass,
      usable: row.usable,
      pageCount: row.pageCount,
      latencyMs: row.latencyMs,
      budgetBurn: row.budgetBurn,
      errorClass: row.errorClass,
      // A REAL projection from a REAL measurement, replacing the pre-run range
      // the moment there is any evidence at all to project from.
      etaMs: projectRemainingMs(latencies, runs - run),
    });

    if (row.budgetBurn) consecutiveBurn++; else consecutiveBurn = 0;
    if (row.errorClass === 'RATE_LIMITED') consecutive429++; else consecutive429 = 0;

    if (consecutiveBurn >= QUALIFY_ABORT_AFTER) {
      const recent = rows.filter(r => r.budgetBurn).slice(-QUALIFY_ABORT_AFTER);
      aborted = recent.every(r => r.budgetBurn === 'reasoning')
        ? 'ABORTED_REASONING_BURN'
        : 'ABORTED_BUDGET_EXHAUSTION';
      break;
    }
    if (consecutive429 >= QUALIFY_RATE_LIMIT_ABORT_AFTER) {
      aborted = 'NOT_MEASURED_RATE_LIMITED';
      break;
    }

    if (run < runs && spacingMs > 0) {
      try { await sleep(spacingMs, signal); } catch { cancelled = true; break; }
    }
  }

  const record = summariseRuns(rows, {
    modelId: o.modelId,
    domain: o.domain,
    measuredAt: new Date(now()).toISOString(),
    promptChars: prompt.promptChars,
    promptSha256: prompt.promptSha256,
    sourceName: prompt.sourceName,
    runsRequested: runs,
    aborted,
    cancelled,
  });

  emit({ type: 'done', record, qualifies: isPassingRecord(record) });
  return { record, runs: rows };
}

export const __testing = { median, sleep, defaultCallModel, MAX_SOURCE_ATTEMPTS, makeCancelled };
