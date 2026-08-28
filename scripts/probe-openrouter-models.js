#!/usr/bin/env node
/**
 * probe-openrouter-models.js — MANUAL measurement harness deciding which
 * OpenRouter models real users may be OFFERED. NOT a test suite; deliberately
 * NOT registered in scripts/run-tests.js. It spends money when run live.
 *
 * WHAT IT MEASURES, AND WHY THE OBVIOUS VERSION OF IT IS WORTHLESS
 * ────────────────────────────────────────────────────────────────
 * The question is: can this model do the ONE job ingest asks of it — read the
 * real Phase-1 outline prompt (a ~341,000-char request that is ~99% the user's
 * own index.md and slug inventory) and return JSON we can plan a wiki from?
 *
 * TWO TRAPS ARE BUILT INTO THIS REPO'S OWN CODE, AND EITHER ONE SILENTLY TURNS
 * THIS HARNESS INTO A RUBBER STAMP:
 *
 *   TRAP 1 — `parseJSON` (ingest.js) ERASES THE DISTINCTION WE ARE MEASURING.
 *   It has four ordered branches (raw JSON.parse → strip ```json fences →
 *   extract outermost {…} → jsonrepair) and returns NO provenance flag. A
 *   harness that only calls parseJSON records `jsonRaw: true` for every model
 *   that ever succeeds, and the entire measurement is a constant. So this file
 *   calls `JSON.parse(rawText)` ITSELF first, in its own try/catch, and only
 *   then falls back to parseJSON. See classifyResponse().
 *
 *   TRAP 2 — "PARSES" IS NOT "USABLE". parseJSON is lenient by design: jsonrepair
 *   turns the bare text `not json at all` into the STRING "not json at all",
 *   which is truthy. The real production gate is `usablePageArray(parsed)`,
 *   which returns null unless `.pages` is a non-empty array holding at least one
 *   object with a non-empty string `path`. A run that parses but fails that gate
 *   is a FAILURE here, exactly as it is in ingest. classifyResponse() applies the
 *   REAL usablePageArray, imported from ingest.js's __testing — never a local
 *   re-implementation that could drift.
 *
 * Both traps are covered by `--self-test`, which runs offline and free and is
 * the answer to "what input would make this check report a failure?". Run it
 * before trusting any live number.
 *
 * THE CALL SHAPE IS THE PRODUCTION ONE. Requests go through the real
 * OpenRouterAdapter, so they carry `provider: {allow_fallbacks:false,
 * require_parameters:true}`, `response_format: {type:'json_object'}` and the
 * real `MULTI_PHASE_OUTLINE_TOKENS` budget read from ingest.js. Building a
 * private fetch here would reproduce the toy-probe error at the transport layer.
 *
 * IT DOES NOT GO THROUGH `generateText`, and that is deliberate, not laziness:
 *   • getProviderInfo() enforces the OFFERABLE_MODELS allow-list, so an
 *     UNMEASURED candidate — the only kind worth probing — would be refused and
 *     silently demoted to the provider default. We would measure solar-pro4
 *     nine times and file the result under the candidate's name.
 *   • The 429/503 retry loop and the fallback chain would confound latency,
 *     spend and model identity.
 *   • The truncation ladder converts `finish_reason: "length"` into a throw, so
 *     the budget-exhaustion signal — the most expensive failure mode there is —
 *     would arrive as an opaque error instead of a measurement.
 * We therefore measure the FIRST ATTEMPT ONLY, which is what characterises a
 * model. Production's recovery ladders sit on top of that and are out of scope.
 *
 * READ-ONLY WITH RESPECT TO THE WIKI. It assembles a prompt and calls a model.
 * It never calls writePage, never runs ingestFile, never writes a wiki page.
 * (measure-ingest-prompt.js's `--live` mode DOES run a real ingest — that half
 * was deliberately not copied.) Both CURATOR_TEST_USER_DATA_DIR and
 * CURATOR_TEST_DOMAINS_DIR are pointed at tempdirs before any live call: the
 * domains-only variable still leaves the process holding the real GitHub PAT.
 *
 * ISOLATION IS PROVEN, NOT ASSERTED. The prompt is assembled TWICE — once from
 * the real domain (read-only, before isolation) and once from the tempdir
 * snapshot — and the two must be BYTE-IDENTICAL or the run aborts. That is what
 * licenses the snapshot to hold zero-byte placeholder files for the 3,292 entity
 * and concept pages: only their FILENAMES reach the prompt, and the byte
 * comparison is what proves it rather than a comment claiming it.
 *
 * SECRETS. The API key is read from the real .curator-config.json, lives only in
 * memory and in the Authorization header, and every line written to disk or
 * printed to a stream passes through assertNoSecret() first. That guard is
 * positive-controlled in --self-test.
 *
 * USAGE
 *   node scripts/probe-openrouter-models.js --self-test
 *   node scripts/probe-openrouter-models.js --dry-run --domain=articles
 *   node scripts/probe-openrouter-models.js --models=upstage/solar-pro4 --runs=9
 *   node scripts/probe-openrouter-models.js --models-file=candidates.txt --runs=12
 *
 * FLAGS
 *   --models=a,b,c        comma-separated model ids
 *   --models-file=PATH    one id per line (# comments and blanks ignored)
 *   --runs=N              runs per model                        (default 9)
 *   --domain=NAME         domain the prompt is assembled from   (default articles)
 *   --source=PATH         source document                       (default below)
 *   --out=DIR             directory for the JSONL + summary     (default: $CURATOR_PROBE_OUT,
 *                                                               else <tmpdir>/curator-probe)
 *   --tag=NAME            basename for the output files         (default timestamp)
 *   --dry-run             assemble and report sizes; NO network, NO spend
 *   --self-test           offline classifier + leak-guard controls; NO network
 *   --resume              continue an existing JSONL, skipping completed (model,run)
 *   --spacing-ms=N        delay between calls                   (default 1500)
 *   --timeout-ms=N        per-request ceiling                   (default adapter's)
 *   --abort-after=N       consecutive budget-burn runs before aborting a model (default 3)
 *   --rate-limit-retries=N  retries for a 429 before recording NOT_MEASURED (default 1)
 *   --price-in / --price-out   USD per Mtok, for a cross-check of OpenRouter's own cost
 */

import { readFile, writeFile, mkdir, readdir, mkdtemp, cp, rm, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import { getDomainsDir } from '../src/brain/config.js';
import { getCuratorConfigFile } from '../src/brain/paths.js';
import { readIndex, readSchema, wikiPath } from '../src/brain/files.js';
import {
  capExistingFilesForPrompt,
  computeSummarySlugFromSource,
  extractText,
  parseJSON,
  __testing as ingestTesting,
} from '../src/brain/ingest.js';
import { OpenRouterAdapter } from '../src/brain/openrouter-adapter.js';

const { buildOutlinePrompt, usablePageArray, MULTI_PHASE_OUTLINE_TOKENS, TEXT_CAP } = ingestTesting;

// ── args ─────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=([\s\S]*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  })
);

if (args.help || args.h) {
  console.log(await readFile(new URL(import.meta.url)).then(b =>
    b.toString('utf8').split('\n').slice(1).join('\n').split('*/')[0]));
  process.exit(0);
}

/**
 * Where results land when --out is not given.
 *
 * This was hardcoded to one agent session's scratchpad — an absolute path
 * carrying the maintainer's macOS username, his uid and a session UUID, in a
 * PUBLIC repo, and functionally broken for everyone else because the
 * directory exists on exactly one machine.
 *
 * The durable lesson is WHY it survived every personal-data sweep: the
 * username was hyphen-encoded inside the path segment
 * (`-Users-<name>-second-brain`), so it matched no `/Users/<name>/` pattern
 * anyone was grepping for. When scanning for leaked paths, search for the
 * bare username too, not only for path-shaped strings containing it.
 */
const DEFAULT_SCRATCH = process.env.CURATOR_PROBE_OUT
  || path.join(os.tmpdir(), 'curator-probe');

/**
 * The live snapshot directory, at module scope so the SINGLE cleanup in the
 * `finally` at the bottom of this file can reach it from EVERY exit path.
 *
 * It used to be cleaned by six separate `await rm(tmpRoot, …)` calls scattered
 * through main(), and the byte-identity guard threw BEFORE its copy ran — so an
 * aborted run left a snapshot on disk (measured: two orphans after the mutation
 * runs). Six hand-written copies of one invariant with one of them missing is
 * the shape this repo keeps re-finding; the answer is one copy that cannot be
 * forgotten, not a seventh.
 */
let TMP_ROOT = null;

const CFG = {
  domain: String(args.domain || 'articles'),
  runs: Number.isFinite(Number(args.runs)) ? Math.max(1, Math.trunc(Number(args.runs))) : 9,
  outDir: String(args.out || DEFAULT_SCRATCH),
  tag: String(args.tag || `probe-${new Date().toISOString().replace(/[:.]/g, '-')}`),
  spacingMs: Number.isFinite(Number(args['spacing-ms'])) ? Number(args['spacing-ms']) : 1500,
  timeoutMs: Number.isFinite(Number(args['timeout-ms'])) ? Number(args['timeout-ms']) : null,
  abortAfter: Number.isFinite(Number(args['abort-after'])) ? Number(args['abort-after']) : 3,
  rateLimitRetries: Number.isFinite(Number(args['rate-limit-retries'])) ? Number(args['rate-limit-retries']) : 1,
  priceIn: Number.isFinite(Number(args['price-in'])) ? Number(args['price-in']) : null,
  priceOut: Number.isFinite(Number(args['price-out'])) ? Number(args['price-out']) : null,
  resume: args.resume === true || args.resume === 'true',
};

/**
 * Default source. It must be long enough to hit TEXT_CAP, because "source at the
 * 80,000 cap" is what makes one run comparable to another — a shorter source
 * silently shrinks the prompt and moves every number. Overridable with --source;
 * whichever is used, its sha256 is recorded per run so two files of results can
 * be told apart rather than averaged together.
 *
 * NOTE for anyone picking a PDF: most of this wiki's raw/ PDFs are image-only
 * Medium exports that extract to under 200 chars (measured: 102 and 16 on the
 * two largest). They are unusable as probe sources and ingest itself refuses
 * them. Prefer a markdown source.
 */
const DEFAULT_SOURCE = 'domains/projects/raw/PROJECT_OVERVIEW.md';

// ── secret handling ──────────────────────────────────────────────────────────

/**
 * Credential shapes that must never reach disk or a stream. The OpenRouter
 * prefix is the one that matters here; the others are present because this
 * repo's config file holds a Gemini and an Anthropic key too, and an error
 * echoing the wrong file would sail past a single-prefix guard.
 *
 * ⚠ THESE LITERALS ARE SAFE AT COMMIT TIME, AND THAT IS NOT AN ACCIDENT — DO NOT
 * "TIDY" THEM. The pre-commit hook refuses staged content matching
 * `sk-or-v1-[0-9A-Za-z_-]{20,}` (and the equivalents for the others): a prefix
 * followed by 20+ credential characters. Each prefix below is followed
 * immediately by `[`, which is not in that class, so the hook finds nothing —
 * VERIFIED by running the hook's own pattern against this file, with a positive
 * control proving the scanner detects a real-shaped value. Rewriting any of
 * these to sit next to a long alphanumeric run would make the file uncommittable.
 *
 * The alternative — adding an entry to .git/hooks/secret-allowlist — was
 * rejected on this repo's own recorded reasoning from v3.15.0: allow-listing our
 * own fixture trains the next person to allow-list, and the next file may hold a
 * real key. The synthetic key in --self-test is assembled from parts at runtime
 * for the same reason.
 */
const SECRET_PATTERNS = [
  /sk-or-v1-[A-Za-z0-9._~+/=-]{8,}/,
  /\bsk-ant-[A-Za-z0-9._~+/=-]{8,}/,
  /\bAIza[A-Za-z0-9._~+/=-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
];

/**
 * THROW if `s` carries anything credential-shaped, or the live key verbatim.
 *
 * This is the guard that must be able to fire. It is exercised in --self-test
 * against a synthetic key (assembled from parts so the literal prefix never sits
 * in this file as a committable string — the pre-commit hook blocks `sk-or-v1-`,
 * and allow-listing our own fixture would teach the next person to allow-list).
 * A clean string is checked too, so a guard that always threw would also fail.
 */
function assertNoSecret(s, liveKey, where) {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  if (typeof liveKey === 'string' && liveKey.length >= 8 && str.includes(liveKey)) {
    throw new Error(`SECRET LEAK BLOCKED in ${where}: the live API key appeared verbatim.`);
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(str)) {
      throw new Error(`SECRET LEAK BLOCKED in ${where}: credential-shaped text matched ${re}.`);
    }
  }
  return str;
}

// ── classification — the heart of the harness ────────────────────────────────

/**
 * Classify one raw model response.
 *
 * `parse_class` is exactly one of:
 *   'raw'          bare JSON.parse(rawText) succeeded — branch 1 of parseJSON only.
 *                  THIS is what "9 of 9 raw JSON, no repair pass" means.
 *   'repaired'     bare parse threw, but parseJSON returned something.
 *   'unrepairable' parseJSON threw.
 *
 * `usable` is the REAL production gate (usablePageArray), applied independently
 * of parse_class. A 'repaired' run with usable:false is a failure, and so is a
 * 'raw' one — the two axes are reported separately because they fail separately.
 */
function classifyResponse(rawText) {
  const out = {
    parse_class: 'unrepairable',
    usable: false,
    page_count: null,
    text_len: typeof rawText === 'string' ? rawText.length : 0,
    parse_error: null,
  };
  if (typeof rawText !== 'string' || rawText.length === 0) {
    out.parse_error = 'empty response text';
    return out;
  }

  let parsed = null;
  // TRAP 1: this bare parse is the ONLY thing that can distinguish raw from
  // repaired. parseJSON's own branch 1 does the same work and then throws the
  // answer away, which is why it cannot be reused here.
  try {
    parsed = JSON.parse(rawText);
    out.parse_class = 'raw';
  } catch {
    try {
      parsed = parseJSON(rawText);
      out.parse_class = 'repaired';
    } catch (err) {
      out.parse_class = 'unrepairable';
      out.parse_error = String(err && err.message).slice(0, 300);
      return out;
    }
  }

  // TRAP 2: parseJSON returning something is not success. The real gate decides.
  const pages = usablePageArray(parsed);
  out.usable = pages !== null;
  out.page_count = pages ? pages.length : 0;
  if (!out.usable) {
    out.parse_error = `parsed as ${Array.isArray(parsed) ? 'array' : typeof parsed}`
      + ` but usablePageArray() refused it (no non-empty pages[] with a string path)`;
  }
  return out;
}

/** OpenAI-compatible usage block → the fields we record. Missing ⇒ null, never 0. */
function readUsage(u) {
  const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (!u || typeof u !== 'object') {
    return { input_tokens: null, output_tokens: null, reasoning_tokens: null, cached_tokens: null, reported_cost_usd: null };
  }
  return {
    input_tokens: n(u.prompt_tokens),
    output_tokens: n(u.completion_tokens),
    reasoning_tokens: n(u.completion_tokens_details?.reasoning_tokens),
    cached_tokens: n(u.prompt_tokens_details?.cached_tokens),
    // MEASURED 2026-08-27 in openrouter-adapter.js: usage.cost is USD 1:1 and
    // agreed with catalogue arithmetic to six decimal places. It is therefore the
    // authoritative spend figure here — a candidate has no catalogue entry yet.
    reported_cost_usd: n(u.cost),
  };
}

/**
 * Did this run burn the output budget and produce nothing we can use?
 *
 * This is the `nex-agi/nex-n2-mini` shape: it advertises reasoning as OPTIONAL,
 * then spends the ENTIRE 24,576-token budget on hidden reasoning and returns
 * nothing parseable, at ~160s a go. It is the single most expensive failure mode
 * and it is exactly where the reasoning-capable open-weight families live.
 *
 * DELIBERATE DEVIATION FROM THE BRIEF, stated rather than smuggled: two
 * different things produce "full budget, nothing usable" and this reports them
 * apart instead of filing both under reasoning burn.
 *   'reasoning'  — the model emitted (almost) no visible text, or the provider
 *                  attributes most of the output to reasoning tokens.
 *   'truncation' — the model emitted a lot of visible text and simply ran out of
 *                  budget mid-JSON. Also disqualifying, also aborts, but calling
 *                  it reasoning burn would be a claim the evidence does not
 *                  support, and an over-claimed diagnosis is worth less than an
 *                  honest one.
 */
function budgetBurn(run) {
  const budget = MULTI_PHASE_OUTLINE_TOKENS;
  const out = run.output_tokens;
  const atCeiling = run.finish_reason === 'length'
    || (typeof out === 'number' && budget > 0 && out >= budget * 0.95);
  if (!atCeiling || run.usable) return null;
  const visible = typeof run.text_len === 'number' ? run.text_len : 0;
  const reasoningHeavy = typeof run.reasoning_tokens === 'number'
    && typeof out === 'number' && out > 0 && run.reasoning_tokens >= out * 0.5;
  return (visible < 200 || reasoningHeavy) ? 'reasoning' : 'truncation';
}

/** Error → a stable class plus a redacted message. */
function classifyError(err, liveKey) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  const status = err && Number.isFinite(err.status) ? err.status : null;
  let cls = code || (err && err.name === 'AbortError' ? 'ABORTED' : 'UNKNOWN_ERROR');
  // A rate limit is NOT a defect and NOT a pass. Measured on a PAID model: 18
  // consecutive 429s at both 1.5s and 45s spacing, while a trivial prompt to the
  // same id succeeded. Free ids additionally draw on a shared upstream pool —
  // one free model answered 8/8 while three of its free siblings answered 0/8.
  if (status === 429 || code === 'OPENROUTER_RATE_LIMIT') cls = 'RATE_LIMITED';
  let msg = '';
  try { msg = String(err && err.message || err); } catch { msg = 'unstringifiable error'; }
  // Redact before truncating: a key at byte 195 of a 200-char slice would
  // otherwise survive as a partial leak.
  for (const re of SECRET_PATTERNS) msg = msg.replace(new RegExp(re.source, re.flags + 'g'), '[redacted]');
  if (typeof liveKey === 'string' && liveKey.length >= 8) msg = msg.split(liveKey).join('[redacted]');
  return { error_class: cls, http_status: status, error_message: msg.slice(0, 400) };
}

// ── prompt assembly ──────────────────────────────────────────────────────────

/**
 * Assemble the REAL Phase-1 outline prompt for `domain`, resolving through
 * whatever getDomainsDir() currently points at. Called twice (real, then
 * snapshot) so the two can be compared byte for byte.
 */
async function assemble(domain, sourcePath, sourceText) {
  const wikiDir = wikiPath(domain);
  const existingFiles = {
    entities: await readdir(path.join(wikiDir, 'entities'))
      .then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
    concepts: await readdir(path.join(wikiDir, 'concepts'))
      .then(f => f.filter(x => x.endsWith('.md'))).catch(() => []),
  };
  const index = await readIndex(domain).catch(() => '');
  const schema = await readSchema(domain).catch(() => '');
  const text = sourceText.slice(0, TEXT_CAP);
  const originalName = path.basename(sourcePath);
  const capped = capExistingFilesForPrompt(existingFiles, text);
  const summaryPath = `summaries/${computeSummarySlugFromSource(originalName)}.md`;
  const today = '2026-01-01';                  // FIXED: a live date would make two
                                               // runs differ by a byte and defeat
                                               // the snapshot-equality proof.
  const userPrompt = buildOutlinePrompt(today, index, capped.files, originalName, text, false, summaryPath);
  const invChars = capped.files.entities.reduce((n, f) => n + f.length + 12, 0)
                 + capped.files.concepts.reduce((n, f) => n + f.length + 12, 0);
  return {
    systemPrompt: schema, userPrompt, index, text, capped, existingFiles, invChars,
    scaffold: userPrompt.length - index.length - invChars - text.length,
  };
}

const sha = s => createHash('sha256').update(s).digest('hex');
const kb = n => `${(n / 1024).toFixed(1)} KB`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── self-test: the controls that stop this being a rubber stamp ──────────────

async function selfTest() {
  let pass = 0, fail = 0;
  const ok = (cond, label, detail = '') => {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ''}`); }
  };

  console.log('\nSELF-TEST — offline, free, no network.\n');
  console.log('§1 classifyResponse — the raw/repaired/unrepairable axis (TRAP 1)');
  const bare = '{"pages":[{"path":"concepts/a.md","summary":"x"},{"path":"entities/b.md"}]}';
  const c1 = classifyResponse(bare);
  ok(c1.parse_class === 'raw', 'bare JSON classifies as raw', `got ${c1.parse_class}`);
  ok(c1.usable === true && c1.page_count === 2, 'bare JSON is usable with 2 pages',
    `usable=${c1.usable} pages=${c1.page_count}`);

  const fenced = '```json\n' + bare + '\n```';
  const c2 = classifyResponse(fenced);
  ok(c2.parse_class === 'repaired', 'fenced JSON classifies as repaired — NOT raw', `got ${c2.parse_class}`);
  ok(c2.usable === true, 'fenced JSON is still usable');
  // The control that proves the axis is not a constant. If this ever reports
  // 'raw', TRAP 1 has reopened and every jsonRaw figure in the report is a lie.
  ok(c1.parse_class !== c2.parse_class, 'raw and repaired are actually distinguished');

  const c3 = classifyResponse('{{{ not json');
  ok(c3.parse_class === 'unrepairable', 'garbage classifies as unrepairable', `got ${c3.parse_class}`);
  ok(c3.usable === false, 'garbage is not usable');

  console.log('\n§2 usablePageArray — "parses" is not "usable" (TRAP 2)');
  // jsonrepair turns this into the STRING "not json at all", which is truthy.
  // Whatever parse_class it lands in, usable MUST be false.
  const c4 = classifyResponse('not json at all');
  ok(c4.usable === false, 'bare prose is NOT usable even though jsonrepair may "fix" it',
    `parse_class=${c4.parse_class} usable=${c4.usable}`);
  console.log(`     (for the record: 'not json at all' classified as ${c4.parse_class})`);
  const c5 = classifyResponse('{"pages":[]}');
  ok(c5.parse_class === 'raw' && c5.usable === false, 'empty pages[] parses raw but is NOT usable');
  const c6 = classifyResponse('{"pages":[{"summary":"no path here"}]}');
  ok(c6.usable === false, 'pages[] with no `path` is NOT usable');
  const c7 = classifyResponse('{"pages":"a string"}');
  ok(c7.usable === false, 'pages as a string is NOT usable');
  ok(classifyResponse('').usable === false, 'empty text is not usable');

  console.log('\n§3 budgetBurn — the abort signal must fire, and must not over-fire');
  const B = MULTI_PHASE_OUTLINE_TOKENS;
  ok(budgetBurn({ finish_reason: 'length', output_tokens: B, usable: false, text_len: 0, reasoning_tokens: B })
    === 'reasoning', 'full budget + no visible text ⇒ reasoning burn');
  ok(budgetBurn({ finish_reason: 'length', output_tokens: B, usable: false, text_len: 40000, reasoning_tokens: null })
    === 'truncation', 'full budget + lots of visible text ⇒ truncation, NOT reasoning burn');
  ok(budgetBurn({ finish_reason: 'stop', output_tokens: 900, usable: true, text_len: 4000 })
    === null, 'a healthy run is not a burn');
  ok(budgetBurn({ finish_reason: 'stop', output_tokens: 900, usable: false, text_len: 20 })
    === null, 'a small unusable answer is a plain failure, not a burn');
  ok(budgetBurn({ finish_reason: 'length', output_tokens: B, usable: true, text_len: 40000 })
    === null, 'usable output is never a burn even at the ceiling');

  console.log('\n§4 assertNoSecret — the leak guard, positive AND negative control');
  // Assembled from parts: the literal prefix must not sit in this file as a
  // committable string, and allow-listing our own fixture would teach the next
  // person to allow-list.
  const fake = ['sk', 'or', 'v1', 'a'.repeat(48)].join('-');
  let threw = false;
  try { assertNoSecret(`error body: ${fake} trailing`, null, 'selftest'); } catch { threw = true; }
  ok(threw, 'a synthetic OpenRouter key IS blocked (guard can fire)');
  threw = false;
  try { assertNoSecret('{"model":"upstage/solar-pro4","usable":true}', null, 'selftest'); } catch { threw = true; }
  ok(!threw, 'a clean JSONL line is NOT blocked (guard is not always-on)');
  threw = false;
  try { assertNoSecret('token=ZZZ-not-a-key-shape', 'ZZZ-not-a-key-shape', 'selftest'); } catch { threw = true; }
  ok(threw, 'the live key is blocked verbatim even when it matches no pattern');

  console.log('\n§5 constants come from ingest.js, not from this file');
  ok(MULTI_PHASE_OUTLINE_TOKENS > 0 && Number.isInteger(MULTI_PHASE_OUTLINE_TOKENS),
    `MULTI_PHASE_OUTLINE_TOKENS read from ingest.js = ${MULTI_PHASE_OUTLINE_TOKENS}`);
  ok(TEXT_CAP === 80_000, `TEXT_CAP read from ingest.js = ${TEXT_CAP}`);
  ok(typeof usablePageArray === 'function', 'the REAL usablePageArray is imported, not re-implemented');

  console.log(`\nSELF-TEST: ${pass} passed, ${fail} failed.\n`);
  return fail === 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (args['self-test']) {
    process.exit((await selfTest()) ? 0 : 1);
  }

  // ── 1. Resolve the REAL locations BEFORE any isolation is applied ──────────
  const realDomainsDir = getDomainsDir();
  const realConfigFile = getCuratorConfigFile();
  const sourcePath = path.resolve(String(args.source || DEFAULT_SOURCE));
  await stat(sourcePath);                            // fail loudly, not silently
  const sourceText = await extractText(sourcePath);
  if (sourceText.length < 200) {
    throw new Error(`Source extracted to only ${sourceText.length} chars — ingest itself refuses `
      + `anything under 200. Most raw/ PDFs here are image-only; use a markdown source.`);
  }

  // ── 2. Assemble from the real domain (READ-ONLY) ──────────────────────────
  const real = await assemble(CFG.domain, sourcePath, sourceText);
  if (!real.userPrompt || real.userPrompt.length < 1000) {
    throw new Error(`Prompt assembly produced ${real.userPrompt.length} chars — domain "${CFG.domain}" `
      + `does not look real under ${realDomainsDir}.`);
  }

  // ── 3. Snapshot into tempdirs, then isolate ───────────────────────────────
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'curator-probe-'));
  TMP_ROOT = tmpRoot;                    // registered BEFORE anything can throw
  const tmpUserData = path.join(tmpRoot, 'userdata');
  const tmpDomains = path.join(tmpRoot, 'domains');
  const snapWiki = path.join(tmpDomains, CFG.domain, 'wiki');
  await mkdir(tmpUserData, { recursive: true, mode: 0o700 });
  await mkdir(path.join(snapWiki, 'entities'), { recursive: true });
  await mkdir(path.join(snapWiki, 'concepts'), { recursive: true });
  await cp(path.join(realDomainsDir, CFG.domain, 'CLAUDE.md'), path.join(tmpDomains, CFG.domain, 'CLAUDE.md'));
  await cp(path.join(realDomainsDir, CFG.domain, 'wiki', 'index.md'), path.join(snapWiki, 'index.md'));
  // Zero-byte placeholders: only the FILENAMES reach the prompt. The byte-equality
  // check below is what proves that, rather than this comment claiming it.
  for (const folder of ['entities', 'concepts']) {
    await Promise.all(real.existingFiles[folder].map(f =>
      writeFile(path.join(snapWiki, folder, f), '')));
  }

  process.env.CURATOR_TEST_USER_DATA_DIR = tmpUserData;
  process.env.CURATOR_TEST_DOMAINS_DIR = tmpDomains;

  // Both are resolved per call (v3.1.0 rule), so this takes effect immediately.
  if (path.resolve(getDomainsDir()) !== path.resolve(tmpDomains)) {
    throw new Error(`Isolation FAILED: getDomainsDir() is ${getDomainsDir()}, expected ${tmpDomains}.`);
  }
  if (!path.resolve(getCuratorConfigFile()).startsWith(path.resolve(tmpUserData))) {
    throw new Error(`Isolation FAILED: config file resolves to ${getCuratorConfigFile()}.`);
  }

  const snap = await assemble(CFG.domain, sourcePath, sourceText);
  if (snap.userPrompt !== real.userPrompt || snap.systemPrompt !== real.systemPrompt) {
    throw new Error('Snapshot prompt is NOT byte-identical to the real one — refusing to measure. '
      + `(user ${snap.userPrompt.length} vs ${real.userPrompt.length}, `
      + `system ${snap.systemPrompt.length} vs ${real.systemPrompt.length})`);
  }

  const promptSha = sha(snap.systemPrompt + ' ' + snap.userPrompt);
  const sourceSha = sha(sourceText);

  // ── 4. Report the assembly ────────────────────────────────────────────────
  const totalChars = snap.systemPrompt.length + snap.userPrompt.length;
  console.log('─'.repeat(78));
  console.log(`domain         : ${CFG.domain}   (real: ${realDomainsDir})`);
  console.log(`snapshot       : ${tmpDomains}  (prompt compared byte-for-byte against the real domain: equal)`);
  console.log(`source         : ${path.basename(sourcePath)}  ${sourceText.length} chars extracted`
    + `${sourceText.length > TEXT_CAP ? ` → capped to ${TEXT_CAP}` : ' (BELOW the cap)'}`);
  console.log(`source sha256  : ${sourceSha.slice(0, 16)}…`);
  console.log('─'.repeat(78));
  console.log('PHASE-1 OUTLINE PROMPT (the real one, buildOutlinePrompt)');
  console.log(`  index.md          : ${String(snap.index.length).padStart(7)}  ${kb(snap.index.length)}`);
  console.log(`  slug inventory    : ${String(snap.invChars).padStart(7)}  ${kb(snap.invChars)}`
    + `   (${snap.capped.files.entities.length} entity + ${snap.capped.files.concepts.length} concept filenames)`);
  console.log(`  source text       : ${String(snap.text.length).padStart(7)}  ${kb(snap.text.length)}`);
  console.log(`  fixed scaffold    : ${String(snap.scaffold).padStart(7)}  ${kb(snap.scaffold)}`);
  console.log(`  ── user prompt    : ${String(snap.userPrompt.length).padStart(7)}  ${kb(snap.userPrompt.length)}`);
  console.log(`  system (CLAUDE.md): ${String(snap.systemPrompt.length).padStart(7)}  ${kb(snap.systemPrompt.length)}`);
  console.log(`  ══ TOTAL SENT     : ${String(totalChars).padStart(7)}  ${kb(totalChars)}   (~${Math.round(totalChars / 4)} tok est.)`);
  console.log(`  output budget     : ${MULTI_PHASE_OUTLINE_TOKENS} tok (MULTI_PHASE_OUTLINE_TOKENS, read from ingest.js)`);
  console.log(`  prompt sha256     : ${promptSha.slice(0, 16)}…`);
  for (const w of snap.capped.warnings) console.log(`  ⚠ ${w}`);
  console.log('─'.repeat(78));

  if (args['dry-run']) {
    console.log('\nDRY RUN — nothing was sent, nothing was spent, nothing was written to the wiki.');
    return;
  }

  // ── 5. Models ─────────────────────────────────────────────────────────────
  let models = [];
  if (args['models-file']) {
    models = (await readFile(String(args['models-file']), 'utf8'))
      .split('\n').map(l => l.split('#')[0].trim()).filter(Boolean);
  }
  if (args.models) models.push(...String(args.models).split(',').map(s => s.trim()).filter(Boolean));
  models = [...new Set(models)];
  if (!models.length) {
    throw new Error('No models given. Use --models=a,b or --models-file=PATH, or --dry-run.');
  }

  // ── 6. Credentials — read from the REAL config, by explicit path ──────────
  const rawCfg = JSON.parse(await readFile(realConfigFile, 'utf8'));
  const apiKey = rawCfg.openrouterApiKey;
  if (typeof apiKey !== 'string' || apiKey.length < 20) {
    throw new Error(`No usable openrouterApiKey in ${realConfigFile}.`);
  }

  // ── 7. Output file + resume guard ─────────────────────────────────────────
  await mkdir(CFG.outDir, { recursive: true });
  const jsonlPath = path.join(CFG.outDir, `${CFG.tag}.jsonl`);
  const done = new Set();
  if (existsSync(jsonlPath)) {
    const prior = (await readFile(jsonlPath, 'utf8')).split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    // A GUARD THAT CAN ACTUALLY FIRE: appending runs taken against a different
    // prompt into the same file would silently average two incomparable
    // populations. Refuse rather than mix.
    const foreign = prior.find(r => r.prompt_sha256 && r.prompt_sha256 !== promptSha);
    if (foreign) {
      throw new Error(`${jsonlPath} holds runs from a DIFFERENT prompt `
        + `(${String(foreign.prompt_sha256).slice(0, 16)}… vs ${promptSha.slice(0, 16)}…). `
        + `Use --tag=<new> rather than mixing incomparable measurements.`);
    }
    if (!CFG.resume) {
      throw new Error(`${jsonlPath} already exists. Pass --resume to continue it, or --tag=<new>.`);
    }
    for (const r of prior) if (r.model && Number.isFinite(r.run)) done.add(`${r.model}#${r.run}`);
    console.log(`RESUME: ${done.size} completed (model,run) pairs already in ${path.basename(jsonlPath)}.`);
  }

  const adapterOpts = { apiKey };
  if (CFG.timeoutMs) adapterOpts.timeoutMs = CFG.timeoutMs;
  const adapter = new OpenRouterAdapter(adapterOpts);

  const emit = async record => {
    const line = assertNoSecret(JSON.stringify(record), apiKey, 'JSONL record');
    await appendFile(jsonlPath, line + '\n');
  };

  console.log(`\nLIVE — ${models.length} model(s) × up to ${CFG.runs} run(s). Output: ${jsonlPath}\n`);

  const results = {};
  for (const model of models) {
    const rows = [];
    let consecutiveBurn = 0, consecutive429 = 0, aborted = null;
    for (let run = 1; run <= CFG.runs; run++) {
      if (done.has(`${model}#${run}`)) { console.log(`  ${model} run ${run}: (already recorded, skipped)`); continue; }

      let attempt = 0, rec = null;
      // A 429 gets ONE cheap re-try by default, which distinguishes a transient
      // burst from a wall. It is never treated as a defect and never as a pass.
      while (attempt <= CFG.rateLimitRetries) {
        const t0 = Date.now();
        const base = {
          ts: new Date().toISOString(), model, run, attempt,
          prompt_sha256: promptSha, source_sha256: sourceSha,
          source: path.basename(sourcePath), domain: CFG.domain,
          prompt_chars: totalChars, max_tokens: MULTI_PHASE_OUTLINE_TOKENS,
        };
        try {
          const res = await adapter.createChatCompletion({
            model,
            systemPrompt: snap.systemPrompt,
            userPrompt: snap.userPrompt,
            maxTokens: MULTI_PHASE_OUTLINE_TOKENS,
            responseFormat: 'json',
          });
          const cls = classifyResponse(res.text);
          rec = {
            ...base,
            outcome: 'COMPLETED',
            latency_ms: Date.now() - t0,
            resolved_model: res.model,
            // deepseek-v4-flash-0731 has 29 provider endpoints where the others
            // have 1-5, and 3 of the 29 do not serve `response_format`. These two
            // are the only handles we have on WHICH endpoint answered, so they are
            // recorded even though `providerName` is measured-absent on ~60 live
            // calls (OpenRouter lists x-provider-name in CORS expose-headers, which
            // says a browser MAY read it, not that it is ever sent). Recorded,
            // never branched on.
            provider_name: res.providerName,
            generation_id: res.generationId,
            finish_reason: res.finishReason,
            raw_parse_ok: cls.parse_class === 'raw',
            repaired_ok: cls.parse_class === 'repaired',
            unrepairable: cls.parse_class === 'unrepairable',
            parse_class: cls.parse_class,
            usable: cls.usable,
            page_count: cls.page_count,
            text_len: cls.text_len,
            parse_error: cls.parse_error,
            ...readUsage(res.usage),
            error_class: null, http_status: null, error_message: null,
          };
          rec.budget_burn = budgetBurn(rec);
          break;
        } catch (err) {
          const e = classifyError(err, apiKey);
          rec = {
            ...base,
            outcome: e.error_class === 'RATE_LIMITED' ? 'NOT_MEASURED' : 'FAILED',
            latency_ms: Date.now() - t0,
            resolved_model: null, finish_reason: null,
            raw_parse_ok: false, repaired_ok: false, unrepairable: false,
            parse_class: null, usable: false, page_count: null, text_len: 0, parse_error: null,
            input_tokens: null, output_tokens: null, reasoning_tokens: null,
            cached_tokens: null, reported_cost_usd: null, budget_burn: null,
            ...e,
          };
          if (e.error_class === 'RATE_LIMITED' && attempt < CFG.rateLimitRetries) {
            attempt++; console.log(`  ${model} run ${run}: 429 — retrying once in 20s`);
            await sleep(20_000);
            continue;
          }
          break;
        }
      }

      await emit(rec);
      rows.push(rec);
      const tail = rec.outcome === 'COMPLETED'
        ? `${rec.parse_class}${rec.usable ? `, usable, ${rec.page_count} pages` : ', UNUSABLE'}`
          + `, finish=${rec.finish_reason}, out=${rec.output_tokens}${rec.budget_burn ? `, BURN(${rec.budget_burn})` : ''}`
        : `${rec.outcome} ${rec.error_class}`;
      console.log(`  ${model} run ${run}: ${tail}  (${(rec.latency_ms / 1000).toFixed(1)}s)`);

      if (rec.budget_burn) consecutiveBurn++; else consecutiveBurn = 0;
      if (rec.error_class === 'RATE_LIMITED') consecutive429++; else consecutive429 = 0;

      if (consecutiveBurn >= CFG.abortAfter) {
        const kind = rows.filter(r => r.budget_burn).slice(-CFG.abortAfter)
          .every(r => r.budget_burn === 'reasoning') ? 'ABORTED_REASONING_BURN' : 'ABORTED_BUDGET_EXHAUSTION';
        aborted = kind;
        console.log(`  ⛔ ${model}: ${kind} after ${consecutiveBurn} consecutive budget-burn runs — stopping.`);
        break;
      }
      if (consecutive429 >= CFG.abortAfter) {
        aborted = 'NOT_MEASURED_RATE_LIMITED';
        console.log(`  ⛔ ${model}: ${consecutive429} consecutive 429s — NOT MEASURED (not a defect, not a pass).`);
        break;
      }
      if (run < CFG.runs) await sleep(CFG.spacingMs);
    }
    results[model] = { rows, aborted };
  }

  // ── Summarise from the JSONL ON DISK, not from this session's rows ────────
  // On --resume the loop SKIPS completed (model,run) pairs, so `rows` holds only
  // what this invocation happened to run. Summarising from it would silently
  // report a 2-run tail as if it were the whole 9-run measurement — worst
  // precisely after a rate-limit wall, which is when resume is used. Reading the
  // file back also means the printed summary is derived from the evidence a
  // reviewer can re-derive it from, rather than from state only this process saw.
  const onDisk = (await readFile(jsonlPath, 'utf8')).split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  for (const model of Object.keys(results)) {
    const fileRows = onDisk.filter(r => r.model === model);
    if (fileRows.length >= results[model].rows.length) results[model].rows = fileRows;
  }

  // A CROSS-MODEL COMPARISON OVER DIFFERENT DOCUMENTS IS NOT A COMPARISON.
  // Page count is a property of the model AND the source; latency and spend are
  // properties of the model AND the prompt length. The per-file resume guard
  // already refuses a foreign prompt on APPEND, but that only fires when a run is
  // added — this asserts it over the finished set, including rows seeded from an
  // earlier session, so a calibration row measured on another document cannot sit
  // in the same table as the candidates.
  const shas = [...new Set(onDisk.map(r => r.prompt_sha256))];
  const srcs = [...new Set(onDisk.map(r => r.source_sha256))];
  if (shas.length !== 1 || srcs.length !== 1) {
    throw new Error(`Rows in ${jsonlPath} span ${shas.length} prompt(s) and ${srcs.length} source(s). `
      + `Every row in one table must be the same prompt on the same document — refusing to summarise.`);
  }
  console.log(`\nAll rows share prompt ${shas[0].slice(0, 16)}… on source ${srcs[0].slice(0, 16)}… — one document, one prompt.`);

  // ── 8. Summary ────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(78));
  console.log('PER-MODEL SUMMARY');
  console.log('═'.repeat(78));
  let grandCost = 0, anyCostMissing = false;
  for (const [model, { rows, aborted }] of Object.entries(results)) {
    const completed = rows.filter(r => r.outcome === 'COMPLETED');
    const raw = completed.filter(r => r.raw_parse_ok).length;
    const rep = completed.filter(r => r.repaired_ok).length;
    const unrep = completed.filter(r => r.unrepairable).length;
    const usable = completed.filter(r => r.usable).length;
    const notMeasured = rows.filter(r => r.outcome === 'NOT_MEASURED').length;
    const failed = rows.filter(r => r.outcome === 'FAILED').length;
    const pages = completed.filter(r => r.usable).map(r => r.page_count);
    const lat = rows.map(r => r.latency_ms).filter(Number.isFinite);
    const cost = rows.reduce((n, r) => n + (r.reported_cost_usd || 0), 0);
    if (rows.some(r => r.outcome === 'COMPLETED' && r.reported_cost_usd === null)) anyCostMissing = true;
    grandCost += cost;
    const tin = rows.reduce((n, r) => n + (r.input_tokens || 0), 0);
    const tout = rows.reduce((n, r) => n + (r.output_tokens || 0), 0);

    console.log(`\n${model}${aborted ? `   ⛔ ${aborted}` : ''}`);
    console.log(`  runs attempted   : ${rows.length} of ${CFG.runs}`);
    console.log(`  raw / repaired / unrepairable : ${raw} / ${rep} / ${unrep}`);
    console.log(`  USABLE (usablePageArray)      : ${usable} of ${completed.length} completed`);
    console.log(`  unusable-but-parsed           : ${completed.length - usable - unrep}`);
    console.log(`  failed / not-measured(429)    : ${failed} / ${notMeasured}`);
    console.log(`  outline pages   : median ${median(pages) ?? 'n/a'}`
      + (pages.length ? `  range ${Math.min(...pages)}–${Math.max(...pages)}  (n=${pages.length})` : ''));
    console.log(`  latency         : mean ${lat.length ? (lat.reduce((a, b) => a + b, 0) / lat.length / 1000).toFixed(1) : 'n/a'}s`
      + (lat.length ? `  range ${(Math.min(...lat) / 1000).toFixed(1)}–${(Math.max(...lat) / 1000).toFixed(1)}s` : ''));
    console.log(`  tokens          : in ${tin}  out ${tout}`);
    // ⚠ MEASURED 2026-08-28, and it moves the money: a probe sends a BYTE-IDENTICAL
    // prompt every run, so an upstream prompt cache can fire. On the solar-pro4
    // positive control 2 of 9 runs came back with 73,984 of 74,521 input tokens
    // served from cache and cost $0.00059 instead of $0.00237 — a 75% discount —
    // which pulled the 9-run total 17% BELOW list price. A real user's ingests each
    // carry a different source and a growing index, so they will not see that.
    // MEASURED SPEND ON A REPEATED PROMPT IS THEREFORE A FLOOR, NOT A FORECAST.
    // Reported here rather than buried in the JSONL, because a cheap-looking
    // candidate could simply have been luckier with the cache than its rivals.
    const cachedRuns = completed.filter(r => (r.cached_tokens || 0) > 0);
    const cachedTok = completed.reduce((n, r) => n + (r.cached_tokens || 0), 0);
    console.log(`  prompt-cache    : ${cachedRuns.length} of ${completed.length} runs hit an upstream cache`
      + (cachedRuns.length ? `  (${cachedTok} input tok served cached — spend below is BELOW list price)` : ''));
    console.log(`  spend (OpenRouter usage.cost, AS BILLED) : $${cost.toFixed(6)}`
      + (cachedRuns.length ? '   ⚠ FLOOR — cache-discounted' : ''));
    if (CFG.priceIn !== null && CFG.priceOut !== null) {
      const derived = (tin / 1e6) * CFG.priceIn + (tout / 1e6) * CFG.priceOut;
      // A POSITIVE Δ is expected and benign when the cache fired; a NEGATIVE Δ
      // means we were billed MORE than list price and is worth investigating.
      const delta = derived - cost;
      console.log(`  list price @ $${CFG.priceIn}/$${CFG.priceOut} per Mtok, UNCACHED : $${derived.toFixed(6)}`
        + `  (Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(6)}`
        + `${delta > 0 ? ' — billed less than list, consistent with cache hits' : delta < 0 ? ' — ⚠ BILLED MORE THAN LIST PRICE' : ''})`);
    }
    // ── THE DECISION RULE OF RECORD ───────────────────────────────────────
    // ANY unrepairable OR ANY unusable in N runs => REJECT for the build lane.
    // The asymmetry is deliberate: a false rejection costs a candidate, a false
    // acceptance ships a model that silently writes broken wikis and bills the
    // user for it. `repaired` is NOT a gate — claude-haiku-4-5, the shipping
    // Anthropic default, fences its JSON 3/3 and depends entirely on the repair
    // path. raw-vs-repaired is a recorded fact and a tiebreak, nothing more.
    const unusableRuns = completed.length - usable;
    let call, why;
    if (aborted && aborted.startsWith('NOT_MEASURED')) { call = 'NOT MEASURED'; why = 'rate-limited — a fact about the shared upstream pool, not about the model'; }
    else if (aborted) { call = 'REJECT'; why = aborted; }
    else if (unrep > 0) { call = 'REJECT'; why = `${unrep} unrepairable`; }
    else if (unusableRuns > 0) { call = 'REJECT'; why = `${unusableRuns} parsed but unusable`; }
    else if (completed.length === 0) { call = 'NOT MEASURED'; why = 'no completed runs'; }
    else if (failed > 0) { call = 'REJECT'; why = `${failed} failed call(s) — see error_class (an HTTP error is a CAPABILITY finding, not an output-quality one)`; }
    else { call = 'NO DEFECT FOUND'; why = `${completed.length}/${completed.length} usable`; }
    console.log(`  ► ${call}  (${why})`);

    const perRunIn = completed.length ? Math.round(tin / completed.length) : 0;
    if (perRunIn) {
      console.log(`  projection — input tokens/run ≈ ${perRunIn}:`);
      for (const p of [0.10, 0.25, 0.60]) {
        console.log(`      $${p.toFixed(2)}/Mtok in  →  9 runs ≈ $${((perRunIn * 9 / 1e6) * p).toFixed(4)}`
          + `   ·  12 runs ≈ $${((perRunIn * 12 / 1e6) * p).toFixed(4)}   (input only)`);
      }
    }
  }
  console.log('\n' + '─'.repeat(78));
  console.log(`TOTAL MEASURED SPEND (as billed): $${grandCost.toFixed(6)}`
    + (anyCostMissing ? '   ⚠ at least one completed call reported NO cost — LOWER BOUND' : ''));
  console.log('Size the real pass from the per-model UNCACHED projections above, not from this figure:');
  console.log('a probe repeats one prompt and can be cache-discounted where a real ingest cannot.');
  console.log('');
  console.log('⚠ WHAT "NO DEFECT FOUND" DOES AND DOES NOT MEAN — read before quoting any row above.');
  console.log(`  This is a SCREEN, not a certificate. By the rule of three, ${CFG.runs} clean runs are`);
  console.log(`  consistent with a true failure rate as high as ~${(300 / CFG.runs).toFixed(0)}% at 95% confidence.`);
  console.log('  Detection power at 9 runs: ~89% against a 22%-failure model, ~61% at 10%, ~37% at 5%.');
  console.log('  So a clean row means NO GROSS DEFECT WAS OBSERVED on this one document. It is not');
  console.log('  proof the model is sound, and nothing here should be described as having been proven.');
  console.log('  A REJECT row is the stronger statement: a defect was actually observed.');
  console.log(`Raw per-run evidence: ${jsonlPath}`);
  console.log('─'.repeat(78));

}

let exitCode = 0;
try {
  await main();
} catch (err) {
  // Redact before printing: a thrown adapter error could carry echoed request text.
  let m = String(err && (err.stack || err.message) || err);
  for (const re of SECRET_PATTERNS) m = m.replace(new RegExp(re.source, re.flags + 'g'), '[redacted]');
  console.error(`\n✗ ${m}`);
  exitCode = 1;
} finally {
  // THE ONLY CLEANUP. Runs on success, on a thrown guard, and on a mid-run
  // failure alike — which the six inline copies it replaced did not.
  if (TMP_ROOT) {
    try {
      await rm(TMP_ROOT, { recursive: true, force: true });
      console.log(`Temp snapshot removed: ${TMP_ROOT}`);
    } catch (e) {
      console.error(`⚠ could not remove temp snapshot ${TMP_ROOT}: ${e && e.message}`);
    }
  }
}
process.exit(exitCode);
