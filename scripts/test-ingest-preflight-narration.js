#!/usr/bin/env node
/**
 * test-ingest-preflight-narration.js — OFFLINE suite for the three ingest
 * changes that came out of the maintainer's two-instances report:
 *
 *   §2  the PRE-FLIGHT size warning, emitted BEFORE the first paid call
 *   §3  Phase 2 NARRATION — batch N of M, elapsed, and the AI call count
 *   §4  the retry-wait message carrying batch context
 *   §5  the OUTLINE-FAILURE message, reordered to lead with the measured cause
 *   §6  the other-instance sentence appended to that failure
 *
 * ══ WHY IT IS DRIVEN THROUGH THE REAL ingestFile ═══════════════════════════
 *
 * The claim being tested is an ORDERING claim — "the user is told the source
 * is at the size cap before any money is spent" — and ordering is exactly what
 * a source-level assertion cannot see. CLAUDE.md's v3.0.17 rule was written
 * about this precise shape: a test that proves a line exists proves nothing
 * about what it does, and the release that recorded it had shipped a
 * green source assertion over a value that was always wrong.
 *
 * So the fake LLM RECORDS the progress messages that had already been emitted
 * at the moment of its FIRST invocation. If the warning moved below the first
 * call, that snapshot is empty of it and §2 reds — no source string is read.
 *
 * The seam is `opts.llm` on ingestFile (test-only, defaulted to the real
 * generateText — the same pattern as compile.js's `opts.generateText` and
 * ingestMultiPhase's trailing `llm`). It costs nothing and reaches no network.
 *
 * ══ ISOLATION ══════════════════════════════════════════════════════════════
 *
 * `CURATOR_TEST_USER_DATA_DIR` + `__setDomainsDirOverride`, both set before
 * any module is imported. The real `.curator-config.json` is fingerprinted
 * (sha256 + size + existence, never mtime) and re-checked at the end.
 *
 * ══ NOT ENFORCED ══════════════════════════════════════════════════════════
 *
 *   • No real provider is called, so nothing here says whether an 80,000-char
 *     source ACTUALLY overflows a real model's outline budget. The pre-flight
 *     warning is a risk statement sized from MULTI_PHASE_OUTLINE_TOKENS'
 *     recorded measurements, not from a run.
 *   • The elapsed clock is asserted for SHAPE (m:ss present and growing),
 *     never for a specific duration — a wall-clock assertion in a test is a
 *     flake waiting for a slow machine.
 */

import path from 'path';
import os from 'os';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)})`); }
function section(t) { console.log(`\n${t}`); }

// ── Isolation BEFORE any import ────────────────────────────────────────────
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-ingest-preflight-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
// The instance registry must never touch the maintainer's Application Support
// tree — ingestFile now reads it, so the seam has to be in force here too.
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');

function fingerprint(file) {
  if (!existsSync(file)) return { exists: false };
  const buf = readFileSync(file);
  return { exists: true, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}
const REAL_CONFIG = path.join(REPO_ROOT, '.curator-config.json');
const REAL_CONFIG_BEFORE = fingerprint(REAL_CONFIG);

const { ingestFile, formatElapsed, __testing, makeUsageAccumulator } =
  await import('../src/brain/ingest.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);

// ── Domain fixture ─────────────────────────────────────────────────────────
const DOMAIN = 'preflight';
const domainDir = path.join(DOMAINS, DOMAIN);
for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw']) {
  mkdirSync(path.join(domainDir, d), { recursive: true });
}
writeFileSync(path.join(domainDir, 'CLAUDE.md'), '# Test domain schema\n', 'utf8');
writeFileSync(path.join(domainDir, 'wiki', 'index.md'),
  '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n', 'utf8');
writeFileSync(path.join(domainDir, 'wiki', 'log.md'), '# Log\n\n', 'utf8');

const TEXT_CAP = 80_000;

/** A source of a chosen size, in plausible prose rather than one repeated char. */
function makeSource(chars) {
  const para = 'The measurement was taken twice and the second reading agreed with the first. ';
  let s = '';
  while (s.length < chars) s += para;
  return s.slice(0, chars);
}

/** Pull the batch's requested page paths back out of the Phase 2 prompt. */
function requestedPaths(prompt) {
  const m = /EXACTLY these wiki pages \(no others\):\s*\[\n([\s\S]*?)\n\]/.exec(prompt);
  if (!m) return [];
  return [...m[1].matchAll(/"path":\s*"([^"]+)"/g)].map(x => x[1]);
}

const SUMMARY_SLUG = 'summaries/big-source.md';
const OUTLINE_PAGES = [
  SUMMARY_SLUG,
  'entities/alpha-labs.md', 'entities/beta-corp.md', 'entities/gamma-institute.md',
  'entities/delta-group.md', 'concepts/first-idea.md', 'concepts/second-idea.md',
  'concepts/third-idea.md', 'concepts/fourth-idea.md',
];

/**
 * Run a real ingest against a fake provider.
 *
 * `hooks.onFirstCall` receives the progress messages recorded SO FAR at the
 * instant the provider is first invoked — the ordering evidence §2 rests on.
 * `hooks.waitOnCall` makes the fake fire llm.js's own `onWait` callback on a
 * chosen call, which is how a rate-limit pause is reproduced without one.
 */
async function runIngest({ sourceChars, name = 'big-source.md', hooks = {} }) {
  const srcPath = path.join(TMP_ROOT, name);
  writeFileSync(srcPath, makeSource(sourceChars), 'utf8');

  const events = [];
  const messages = () => events.map(e => e.message);
  let calls = 0;
  let firstCallSnapshot = null;

  const llm = async (schema, prompt, maxTokens, format, onWait, opts) => {
    calls++;
    if (calls === 1) firstCallSnapshot = messages();
    if (opts && typeof opts.onUsage === 'function') {
      opts.onUsage({ inputTokens: 100, outputTokens: 50, provider: 'fake', model: 'fake-1' });
    }
    if (hooks.waitOnCall === calls && typeof onWait === 'function') {
      onWait('rate limited — retrying in 42s… (attempt 1/3)');
    }
    if (calls === 1) {
      return JSON.stringify({
        title: 'Big Source',
        pages: OUTLINE_PAGES.map(p => ({ path: p, summary: `about ${p}` })),
      });
    }
    const batch = requestedPaths(prompt);
    return JSON.stringify({
      pages: batch.map(p => ({
        path: p,
        content: `# ${p}\n\nTags: test\n\n- one measured bullet\n`,
        summary: `about ${p}`,
      })),
    });
  };

  const realWarn = console.warn, realErr = console.error;
  console.warn = () => {}; console.error = () => {};
  let result = null, thrown = null;
  try {
    result = await ingestFile(DOMAIN, srcPath, name, false,
      (ev) => events.push(ev), { llm });
  } catch (e) { thrown = e; }
  finally { console.warn = realWarn; console.error = realErr; }

  return { result, thrown, events, messages: messages(), firstCallSnapshot, calls };
}

// ── §1. formatElapsed ──────────────────────────────────────────────────────
section('1. formatElapsed — the m:ss the "hour-long ingest" report needed');
{
  eq(formatElapsed(0), '0:00', 'zero');
  eq(formatElapsed(9_000), '0:09', 'seconds are zero-padded');
  eq(formatElapsed(65_000), '1:05', 'a minute and change');
  eq(formatElapsed(3_599_000), '59:59', 'just under an hour stays in m:ss');
  eq(formatElapsed(3_600_000), '1:00:00', 'an hour rolls into h:mm:ss — the maintainer\'s actual case');
  eq(formatElapsed(3_723_000), '1:02:03', 'and keeps both fields padded');
  eq(formatElapsed(-5_000), '0:00', 'a negative duration (clock skew) reads as zero, never as garbage');
  eq(formatElapsed(undefined), '0:00', 'and an absent one does not throw');
}

// ── §2. The pre-flight warning, and its ORDER ──────────────────────────────
section('2. Pre-flight size warning — emitted BEFORE the first paid call');
let big;
{
  big = await runIngest({ sourceChars: 98_000 });
  ok(!big.thrown, `a 98,000-char source ingests under the fake provider${big.thrown ? ' — ' + big.thrown.message : ''}`);

  ok(Array.isArray(big.firstCallSnapshot),
    'CONTROL: the provider really was called, so the snapshot below is a measurement');
  const preflightInSnapshot = big.firstCallSnapshot.filter(m =>
    /page-planning step/.test(m) && /split the source/.test(m));
  eq(preflightInSnapshot.length, 1,
    'the warning had ALREADY been emitted when the first provider call was made');
  ok(/98,000 characters/.test(preflightInSnapshot[0]),
    'it states the measured size of THIS source, not a generic caution');
  ok(/80,000-character limit/.test(preflightInSnapshot[0]),
    'and names the limit it is being compared against');
  ok(/over the/.test(preflightInSnapshot[0]),
    'a source past the cap is described as over it');

  const w = big.result.warnings.filter(x => /page-planning step/.test(x));
  eq(w.length, 1, 'and it also reaches the result panel through the warnings[] contract');

  // The existing truncation warning is a DIFFERENT statement (what was
  // dropped, not what may fail) and must survive alongside it.
  ok(big.result.warnings.some(x => /only the first 80,000 were processed/.test(x)),
    'the pre-existing truncation warning is untouched — the two say different things');

  // Deliberately NOT emitted per-ingest: the second-instance sentence. The
  // banner is where that is said; repeating it in every ingest's warnings
  // would make a deliberate configuration read as a per-ingest defect.
  ok(!big.result.warnings.some(x => /same knowledge folder/.test(x)),
    'a running second instance does NOT add a warning to every ingest');
}

// ── §2b. The threshold is real ─────────────────────────────────────────────
section('2b. ANTI-VACUITY — a source below the threshold gets no warning');
{
  // 40,000 chars: comfortably past MULTI_PHASE_INPUT_THRESHOLD (15,000) so it
  // takes the SAME multi-phase path, and comfortably under 90% of the cap. If
  // §2 passed because the warning fires unconditionally, this reds.
  const small = await runIngest({ sourceChars: 40_000, name: 'small-source.md' });
  ok(!small.thrown, 'a 40,000-char source ingests too');
  ok(!small.messages.some(m => /page-planning step/.test(m)),
    'no pre-flight warning is emitted for a source well under the cap');
  ok(!small.result.warnings.some(x => /page-planning step/.test(x)),
    'and none reaches the warnings list either');

  // And the boundary itself: 72,000 is exactly cap - 10%.
  const edge = await runIngest({ sourceChars: 72_000, name: 'edge-source.md' });
  ok(edge.result.warnings.some(x => /page-planning step/.test(x)),
    'a source at exactly 90% of the cap DOES get the warning');
  ok(edge.result.warnings.some(x => /close to the 80,000-character limit/.test(x)),
    'and one merely NEAR the cap is described as close to it, not over it');
  ok(!edge.result.warnings.some(x => /only the first 80,000 were processed/.test(x)),
    'CONTROL: it was not truncated, so the truncation warning correctly stays away');
}

// ── §3. Phase 2 narration ──────────────────────────────────────────────────
section('3. Phase 2 narration — batch N of M, elapsed, and the AI call count');
{
  const phase2 = big.messages.filter(m => /^Phase 2: writing content/.test(m));
  ok(phase2.length >= 2, `a 9-page outline produced ${phase2.length} batch messages (BATCH_SIZE 4 -> 3 batches)`);

  const withBatch = phase2.filter(m => /batch \d+ of \d+/.test(m));
  eq(withBatch.length, phase2.length, 'EVERY batch message says which batch of how many');

  const withElapsed = phase2.filter(m => /· \d+:\d\d(:\d\d)? elapsed/.test(m));
  eq(withElapsed.length, phase2.length,
    'every batch message carries elapsed time — the thing an hour-long run needed');

  const withCalls = phase2.filter(m => /· \d+ AI calls?/.test(m));
  eq(withCalls.length, phase2.length, 'and the number of AI calls made so far');

  // The call count must be LIVE, not a snapshot: batch 1 is emitted after the
  // outline call, batch 3 after two more. A closed-over number would repeat.
  const counts = phase2.map(m => Number(/· (\d+) AI calls?/.exec(m)[1]));
  ok(counts[counts.length - 1] > counts[0],
    `the call count GROWS across batches (${counts.join(' -> ')}) — it is read at emission, not captured`);
  ok(counts[0] >= 1, 'and it already includes the outline call by the first batch');

  // Phase 1 is deliberately NOT decorated on its own (it is one call and
  // 0:00 elapsed says nothing) — only its WAIT is, which §4 covers.
  ok(big.messages.some(m => /^Phase 1: planning wiki structure/.test(m)),
    'CONTROL: Phase 1 still announces itself in the same words as before');
}

// ── §4. A retry wait says WHERE in the ingest it is waiting ────────────────
section('4. Retry waits carry batch context');
{
  // Call 2 is the first Phase 2 batch, so this reproduces llm.js firing its
  // onWait during batch 1 of 3.
  const waited = await runIngest({ sourceChars: 98_000, name: 'wait-source.md', hooks: { waitOnCall: 2 } });
  const waits = waited.events.filter(e => e.type === 'wait');
  ok(waits.length >= 1, `a wait event was emitted (${waits.length})`);
  const w = waits.find(e => /rate limited/.test(e.message));
  ok(w, 'the provider\'s own wait text is still relayed verbatim inside the message');
  ok(/^Batch 1 of 3 — /.test(w.message),
    `the wait names the batch it is stuck on (got: ${JSON.stringify(w.message)})`);
  ok(/retrying in 42s/.test(w.message),
    'without discarding what llm.js said — the two are composed, not replaced');
  ok(/· \d+:\d\d(:\d\d)? elapsed/.test(w.message),
    'and it carries the elapsed clock, so a long pause is legible as it happens');

  // The SSE event SHAPE is unchanged — only the message text grew, which is
  // why views/ingest.js needs no edit (it renders ev.message verbatim).
  eq(JSON.stringify(Object.keys(w).sort()), JSON.stringify(['message', 'pct', 'type']),
    'the wait event still carries exactly {type, pct, message}');
  ok(typeof w.pct === 'number', 'with a numeric pct, as before');
}

// ── §5. The outline-failure message leads with the measured cause ──────────
section('5. Outline failure — the cause order, and the remedies that match it');
const tokenLimitError = () =>
  new Error('⚠ Gemini hit the output token limit (24576 tokens) on this call.');
async function failingOutline(narrate) {
  const acc = makeUsageAccumulator();
  const warnings = [];
  const llm = async () => { throw tokenLimitError(); };
  const realWarn = console.warn, realErr = console.error;
  console.warn = () => {}; console.error = () => {};
  try {
    await __testing.ingestMultiPhase(
      'schema', '2026-09-04', '', { entities: [], concepts: [] }, 'dense.md',
      'Some dense source text.', false, () => {}, 'summaries/dense.md', warnings,
      [], { entities: [], concepts: [] }, acc.onUsage, llm, null, narrate);
  } catch (e) { return e.message; }
  finally { console.warn = realWarn; console.error = realErr; }
  return null;
}
{
  const msg = await failingOutline(null);
  ok(msg, 'both outline attempts failing still throws');

  const overflowAt = msg.indexOf('response-length');
  const transientAt = msg.search(/provider hiccup|transient/i);
  ok(overflowAt > -1, 'the message names the response-length overflow');
  ok(transientAt > -1, 'and still mentions the provider-hiccup alternative');
  ok(overflowAt < transientAt,
    'but the MEASURED cause is named FIRST — the old wording led with "usually a transient AI-provider issue"');
  ok(!/usually a transient AI-provider issue/.test(msg),
    'and that exact claim is gone');

  const splitAt = msg.indexOf('split the source');
  const retryAt = msg.indexOf('try Ingest');
  const providerAt = msg.indexOf('different AI provider');
  ok(splitAt > -1 && retryAt > -1 && providerAt > -1, 'all three remedies survive');
  ok(splitAt < retryAt && retryAt < providerAt,
    'and they are ordered to match the lead cause: split first, retry second, switch provider third');
  ok(/\(1\)/.test(msg) && /\(2\)/.test(msg) && /\(3\)/.test(msg),
    'still numbered, so the panel reads as a checklist');
}

// ── §6. …and names a second instance when one was running ─────────────────
section('6. The second-instance sentence is appended, and only then');
{
  const clean = await failingOutline({ startedAt: Date.now(), calls: () => 2, otherInstances: [] });
  ok(!/same knowledge folder/.test(clean),
    'with no other instance, nothing about instances is said');

  const dirty = await failingOutline({
    startedAt: Date.now(), calls: () => 2,
    otherInstances: [{ pid: 1, port: 3333, kind: 'a terminal checkout' }],
  });
  ok(/another Curator \(a terminal checkout on port 3333\) was running/.test(dirty),
    'with one running, the failure names it in the same words the banner uses');
  ok(/one rate-limit quota/.test(dirty),
    'and says WHY it matters — two copies share one key and one quota');
  ok(dirty.indexOf('same knowledge folder') > dirty.indexOf('split the source'),
    'appended AFTER the remedies, because it is a contributing condition and not the cause');
}

// ── §7. Isolation held ─────────────────────────────────────────────────────
section('7. Isolation held');
{
  const after = fingerprint(REAL_CONFIG);
  eq(JSON.stringify(after), JSON.stringify(REAL_CONFIG_BEFORE),
    'the real .curator-config.json is byte-identical (sha256 + size + existence)');
  console.log(REAL_CONFIG_BEFORE.exists
    ? `  · a real config WAS present (${REAL_CONFIG_BEFORE.size} bytes) — the comparison above is load-bearing`
    : '  · no .curator-config.json in this checkout — the comparison above proves only that none was CREATED');
  ok(existsSync(path.join(domainDir, 'wiki', 'summaries')),
    'CONTROL: the ingest really wrote into the TEMP domain, so the run was not a no-op');
}

try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(`\n${'─'.repeat(62)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log('❌ Ingest pre-flight / narration assertions failed');
  process.exit(1);
}
console.log('✅ All ingest pre-flight / narration assertions green');
