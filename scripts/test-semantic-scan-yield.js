/**
 * test-semantic-scan-yield.js — OFFLINE suite guarding the semantic-duplicate
 * pre-filter's TWO independent properties: that it yields the event loop, and
 * that yielding changed nothing about what it finds.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * `findSemanticCandidatePairs` is a synchronous O(N²) character-similarity
 * sweep behind the "✨ Find duplicate pages" button. Measured on a real
 * 3,288-page domain it ran **15.0 s as ONE uninterrupted block**: a concurrent
 * `GET /api/version`, normally 1 ms, took 13.7 s. The entire app was dead for
 * fifteen seconds — one click away in the shipping UI. v3.2.0 removed this
 * scan from automatic view-entry for that exact reason but never made it
 * non-blocking, so the freeze survived as a deliberate click.
 *
 * The fix inserts `setImmediate` yields on a measured budget
 * (`SEMANTIC_SCAN_YIELD_CHUNK`). That is a SCHEDULING change and nothing else.
 *
 * ── WHY THE IDENTITY HALF MATTERS MORE THAN THE YIELDING HALF ────────────
 * This function feeds a DESTRUCTIVE feature: a semantic-duplicate merge
 * deletes a page and rewrites every `[[link]]` to it across the domain. A
 * chunking bug that silently drops a pair, adds one, or reorders the ranking
 * is far worse than the freeze it replaced — it would be invisible, and it
 * would be acted on. So output identity, not responsiveness, is the primary
 * acceptance criterion here.
 *
 * ── WHAT IS ENFORCED ─────────────────────────────────────────────────────
 *   §1  Golden fingerprint. A deterministic fixture corpus produces an EXACT
 *       pair list in an EXACT order — pinned UNCAPPED, so the long tail of
 *       the ranking is covered too, not just its head. Any change to
 *       scoring, thresholds, ordering or the dedup rules moves this hash.
 *   §2  Corpus discrimination. The fixture is proven non-trivial: it produces
 *       pairs from BOTH passes, spans a real score range, exercises the
 *       truncation boundary and the cross-folder branch. A corpus that
 *       yielded two pairs would make §1 green and meaningless.
 *   §3  Chunk-size invariance. The same corpus at chunk sizes 11, 97, 613,
 *       2000 and 10^6 — plus 1 and 2 against a scaled-down twin, where EVERY
 *       comparison becomes a suspension point — must produce byte-identical
 *       output across the FULL uncapped ranking. This is the assertion a
 *       chunking bug trips.
 *   §4  Behavioural yielding — NOT a source grep. The scan runs with a
 *       chained-`setImmediate` probe and a `setTimeout` racing it; both must
 *       be serviced DURING the scan, and the longest observed block must stay
 *       under the 50 ms Long-Tasks threshold.
 *   §5  Negative control for §4. The same probe is run against a deliberately
 *       synchronous busy-loop of comparable duration and must record ZERO
 *       interleavings — proving §4's probe can actually detect blocking and
 *       is not green by construction.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *   • The absolute wall-clock of the scan. It is ~15 s on a 3,288-page domain
 *     and this change deliberately does not reduce it — only its blocking.
 *     A timing threshold here would flake on CI (see the v3.0.1-beta.26
 *     transient-tolerance work and the v3.8.0 finding that deleted a ratio
 *     assertion spanning 0.3–35.9).
 *   • The 50 ms bound in §4 is asserted against a SMALL fixture, where slices
 *     are far below budget. It cannot prove the bound holds on a 20,000-page
 *     domain; that was established by measurement, recorded in the constant's
 *     docblock, and is not re-derivable offline in a fast suite.
 *   • Whether the OTHER health endpoints block. They do (measured); that is a
 *     separate finding, not this suite's subject.
 *   • The TOKEN-PASS yield specifically. Removing it leaves this suite fully
 *     green, because at fixture scale that pass is a few milliseconds. Do not
 *     read that as "the yield is decorative": at production scale it is worth
 *     357 ms, and removing it was measured to produce a 350.5 ms block on a
 *     real 3,288-page domain — 7× over the threshold. The JW-pass yield IS
 *     covered here (removing it alone reds §4 at 75.7 ms). Making the fixture
 *     large enough to cover both would put this suite in the tens of seconds,
 *     which is the wrong trade for an offline suite; the gap is named instead.
 *
 * Dependency-free (node: builtins only). No network, no LLM, no API key.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';

import { __setDomainsDirOverride } from '../src/brain/config.js';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// Fixture corpus — deterministic, no randomness of any kind
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tiny LCG. Seeded and fully deterministic, so the golden hash in §1 is
 * reproducible on any machine and any Node version. Math.random() here would
 * make the pinned fingerprint meaningless.
 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

const HEADS = ['agent', 'vector', 'context', 'prompt', 'token', 'graph', 'memory',
  'retrieval', 'embedding', 'transformer', 'inference', 'orchestration',
  'provenance', 'ingestion', 'lattice', 'quorum', 'telemetry', 'schema'];
const TAILS = ['pipeline', 'window', 'store', 'cache', 'router', 'budget', 'index',
  'policy', 'ledger', 'harness', 'registry', 'boundary', 'scheduler', 'digest'];

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Build a corpus that deliberately contains every shape the pre-filter is
 * supposed to react to, so the golden hash has something to be wrong about
 * and §2's discrimination checks are satisfiable:
 *   • token-sharing pairs                → the FIRST (token-overlap) pass
 *   • character-similar pairs sharing NO
 *     token ≥ 3 chars                    → the SECOND (JW-only) pass
 *   • entity↔concept variants            → the cross-folder branch
 *   • hyphen vs underscore of one name   → the real-world variant case
 *   • unrelated filler                   → must NOT pair at all
 *
 * Family sizes are kept deliberately small and varied. An earlier version of
 * this corpus used two 60-member near-identical families, and the resulting
 * ~1,770 near-tied pairs swamped the ranking: the top 500 contained ZERO
 * JW-only pairs, ZERO cross-folder pairs and only 3 distinct scores. §2
 * caught that, which is the whole reason §2 exists.
 * @param {number} scale — family multiplier; 1 = the main corpus.
 */
function buildCorpus(scale = 1) {
  const rnd = lcg(20260826);
  const entities = [];
  const concepts = [];
  const n = (k) => Math.max(2, Math.round(k * scale));

  // Varied token-overlap fodder — produces a wide spread of real scores.
  for (let i = 0; i < n(90); i++) {
    const h = HEADS[Math.floor(rnd() * HEADS.length)];
    const t = TAILS[Math.floor(rnd() * TAILS.length)];
    entities.push(`${h}-${t}-${i}`);
  }
  // Hyphen vs underscore variants of one name, split ACROSS folders.
  for (let i = 0; i < n(30); i++) {
    entities.push(`quorum-ledger-${i}`);
    concepts.push(`quorum_ledger_${i}`);
  }
  // JW-only family: each pair is ~95 % character-identical but shares NO
  // token of 3+ chars, so the token index can never surface it — it can only
  // come from the second pass. Split across folders as well.
  for (let i = 0; i < n(28); i++) {
    const L = LETTERS[i % LETTERS.length] + LETTERS[(i * 7) % LETTERS.length];
    entities.push(`zynthex${L}q-plurogon${L}m`);
    concepts.push(`zynthex${L}r-plurogon${L}n`);
  }
  // Token-sharing pairs that are NOT character-similar.
  for (let i = 0; i < n(40); i++) {
    const h = HEADS[i % HEADS.length];
    const t = TAILS[i % TAILS.length];
    concepts.push(`${h}-${t}-management-strategy-${i}`);
    concepts.push(`${t}-${h}-governance-framework-${i}`);
  }
  // A separate cluster whose vocabulary is disjoint from every family above.
  // It pairs internally (it shares its own words) but must NEVER cross-pair
  // with the thematic corpus — that is the discrimination §2 checks.
  for (let i = 0; i < n(45); i++) {
    concepts.push(`zzq${i}-unrelated-${(i * 7919) % 997}`);
  }
  return { entities, concepts };
}

function makeDomain(root, domainName, corpus) {
  const wiki = path.join(root, domainName, 'wiki');
  for (const folder of ['entities', 'concepts']) {
    mkdirSync(path.join(wiki, folder), { recursive: true });
  }
  for (const slug of corpus.entities) {
    writeFileSync(path.join(wiki, 'entities', `${slug}.md`), `# ${slug}\n\nBody.\n`);
  }
  for (const slug of corpus.concepts) {
    writeFileSync(path.join(wiki, 'concepts', `${slug}.md`), `# ${slug}\n\nBody.\n`);
  }
  return wiki;
}

/** Canonical serialisation of the result — order-sensitive on purpose. */
function fingerprint(pairs) {
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-semscan-'));
const DOMAIN = 'yieldfixture';        // main corpus — the golden fingerprint
const SMALL  = 'yieldfixturesmall';   // scaled-down twin for the chunk=1 runs

/** No cap. The golden must cover the WHOLE ranking, not just its head. */
const ALL = 1_000_000;

/**
 * GOLDEN FINGERPRINT of the fixture corpus's pair list, in order.
 *
 * This is the regression guard with teeth. It moves if scoring changes, if a
 * threshold moves, if the ranking comparator changes, if the exact-slug or
 * dismissed filters change, if the candidate cap changes — and, critically,
 * if a chunk boundary ever drops or reorders a pair.
 *
 * If a DELIBERATE semantic change to the pre-filter makes this fail, re-derive
 * it, but only after confirming the new pair list is what you intended: this
 * function decides which pages a destructive merge is offered for.
 */
const GOLDEN_SHA256 = 'e59c7fb55a23275cceb821208ffc5324132410f46f0dd0bc628a831c3c786dd3';
const GOLDEN_PAIR_COUNT = 6493;

let health;

try {
  __setDomainsDirOverride(ROOT);
  makeDomain(ROOT, DOMAIN, buildCorpus(1));
  makeDomain(ROOT, SMALL,  buildCorpus(0.22));
  health = await import('../src/brain/health.js');

  const { findSemanticCandidatePairs, SEMANTIC_SCAN_YIELD_CHUNK } = health;

  // ───────────────────────────────────────────────────────────────────────
  section('1. Golden fingerprint — the exact pair list, in the exact order');

  // Pinned UNCAPPED. Hashing only the top 500 would leave the long tail of
  // the ranking — thousands of pairs — completely unguarded, and the tail is
  // exactly where an off-by-one at a chunk boundary would land.
  const base = await findSemanticCandidatePairs(DOMAIN, ALL);
  const baseFp = fingerprint(base.pairs);

  console.log(`     corpus: ${base.pageCount} pages · ${base.totalCandidates} candidates · ` +
              `${base.pairs.length} returned · truncated=${base.truncated}`);
  console.log(`     fingerprint: ${baseFp}`);

  if (GOLDEN_SHA256 === '__PLACEHOLDER__') {
    failed++;
    console.log('  ✗ GOLDEN_SHA256 is still the placeholder — paste the fingerprint above into the constant');
  } else {
    ok(baseFp === GOLDEN_SHA256,
      'the fixture corpus reproduces the pinned pair list byte-for-byte',
      `expected ${GOLDEN_SHA256}, got ${baseFp}`);
    ok(base.pairs.length === GOLDEN_PAIR_COUNT,
      `the fixture returns exactly ${GOLDEN_PAIR_COUNT} pairs`,
      `got ${base.pairs.length}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  section('2. Corpus discrimination — §1 is not green by being trivial');

  ok(base.pairs.length >= 500,
    `the corpus yields a substantial pair list (${base.pairs.length} ≥ 500)`);

  const capped = await findSemanticCandidatePairs(DOMAIN, 500);
  ok(capped.truncated === true && capped.pairs.length === 500,
    'the corpus exercises the truncation boundary at the real default cap',
    `truncated=${capped.truncated} pairs=${capped.pairs.length}`);
  ok(fingerprint(capped.pairs) === fingerprint(base.pairs.slice(0, 500)),
    'the capped result is a strict prefix of the uncapped ranking');

  const scores = base.pairs.map(p => p.score);
  const monotone = scores.every((s, i) => i === 0 || s <= scores[i - 1]);
  ok(monotone, 'pairs are returned in non-increasing score order');
  ok(new Set(scores).size >= 5,
    `scores span a real range, not one constant (${new Set(scores).size} distinct values)`);

  // A pair whose two slugs share NO tokens can only have come from the
  // JW-only second pass; one that shares tokens exercises the first pass.
  const tokensOf = s => new Set(s.toLowerCase().split(/[-_]+/).filter(t => t.length >= 3));
  let fromJwPass = 0, fromTokenPass = 0, crossFolder = 0;
  for (const p of base.pairs) {
    const a = tokensOf(p.slugA), b = tokensOf(p.slugB);
    const shared = [...a].some(t => b.has(t));
    if (shared) fromTokenPass++; else fromJwPass++;
    if (p.folderA !== p.folderB) crossFolder++;
  }
  ok(fromTokenPass > 0, `the token-overlap pass contributes pairs (${fromTokenPass})`);
  ok(fromJwPass > 0, `the JW-only second pass contributes pairs (${fromJwPass})`);
  ok(crossFolder > 0, `entity↔concept cross-folder pairs are produced (${crossFolder})`);
  ok(base.pairs.every(p => !(p.slugA === p.slugB)),
    'exact-slug cross-folder duplicates are excluded (scanWiki already catches those)');
  const crossCluster = base.pairs.filter(
    p => p.slugA.startsWith('zzq') !== p.slugB.startsWith('zzq'));
  ok(crossCluster.length === 0,
    'the vocabulary-disjoint cluster never cross-pairs with the thematic corpus',
    `${crossCluster.length} leaked, e.g. ${JSON.stringify(crossCluster[0] || null)}`);
  const allPossible = (base.pageCount * (base.pageCount - 1)) / 2;
  const kept = base.pairs.length / allPossible;
  ok(kept < 0.25,
    `the filter rejects the overwhelming majority of possible pairs ` +
    `(${base.pairs.length} of ${allPossible} = ${(kept * 100).toFixed(1)} % kept)`);

  // ───────────────────────────────────────────────────────────────────────
  section('3. Chunk-size invariance — the yield budget is a schedule, not a semantic');

  ok(SEMANTIC_SCAN_YIELD_CHUNK === 2000,
    `SEMANTIC_SCAN_YIELD_CHUNK is the measured value 2000 (got ${SEMANTIC_SCAN_YIELD_CHUNK})`);

  // 10^6 exceeds the whole corpus, so both loops run to completion without a
  // single yield; the mid sizes cross boundaries repeatedly. If any boundary
  // dropped, duplicated or reordered a pair, these disagree with the golden.
  for (const chunk of [11, 97, 613, 2000, 1_000_000]) {
    const r = await findSemanticCandidatePairs(DOMAIN, ALL, { yieldChunk: chunk });
    ok(fingerprint(r.pairs) === baseFp,
      `chunk=${chunk} produces byte-identical output over the full ${base.pairs.length}-pair ranking`,
      `got ${fingerprint(r.pairs).slice(0, 16)}… vs ${baseFp.slice(0, 16)}…`);
  }

  // chunk=1 yields on EVERY comparison — the maximum possible boundary
  // density, i.e. every single loop iteration becomes a suspension point.
  // Run against the scaled-down twin so the round-trip cost stays offline-fast
  // while the property tested is identical.
  const smallRef = await findSemanticCandidatePairs(SMALL, ALL);
  ok(smallRef.pairs.length > 20,
    `the small twin is itself non-trivial (${smallRef.pairs.length} pairs)`);
  for (const chunk of [1, 2, 1_000_000]) {
    const r = await findSemanticCandidatePairs(SMALL, ALL, { yieldChunk: chunk });
    ok(fingerprint(r.pairs) === fingerprint(smallRef.pairs),
      `chunk=${chunk} on the small twin — a suspension point at every comparison changes nothing`);
  }

  // Nonsense budgets must not crash or change results — they clamp to >= 1.
  for (const bad of [0, -5, NaN, undefined, null, 'seven', Infinity]) {
    const r = await findSemanticCandidatePairs(DOMAIN, ALL, { yieldChunk: bad });
    ok(fingerprint(r.pairs) === baseFp,
      `a nonsense yieldChunk (${String(bad)}) clamps safely and changes nothing`);
  }
  const noOpts = await findSemanticCandidatePairs(DOMAIN, ALL);
  ok(fingerprint(noOpts.pairs) === baseFp,
    'omitting the opts argument entirely behaves as the default budget (call-site compatibility)');

  // The cap is applied to the same underlying ranking regardless of schedule.
  const cap7a = await findSemanticCandidatePairs(DOMAIN, 7, { yieldChunk: 2 });
  const cap7b = await findSemanticCandidatePairs(DOMAIN, 7, { yieldChunk: 1_000_000 });
  ok(cap7a.pairs.length === 7 && fingerprint(cap7a.pairs) === fingerprint(cap7b.pairs),
    'a small maxPairs cap truncates the same ranking under both schedules');

  // ───────────────────────────────────────────────────────────────────────
  section('4. Behavioural yielding — the loop actually hands the event loop back');

  {
    let ticks = 0, running = true, last = 0;
    const gaps = [];
    const probe = () => {
      const now = performance.now();
      if (last) gaps.push(now - last);
      last = now; ticks++;
      if (running) setImmediate(probe);
    };
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 5);

    last = performance.now();
    setImmediate(probe);
    const ticksBefore = ticks;

    const t0 = performance.now();
    const r = await findSemanticCandidatePairs(DOMAIN, ALL);
    const elapsed = performance.now() - t0;

    // CAPTURE THE TAIL GAP BEFORE STOPPING THE PROBE. Without this the
    // measurement is worthless on exactly the case it exists to catch: a
    // fully synchronous scan services the probe a few times during its
    // opening `await`s on the filesystem, then blocks to completion — and
    // because `running = false` lands before the probe's next turn, the one
    // enormous gap is never recorded and `Math.max(gaps)` reports 0.4 ms.
    // Found by mutation (M4): with yielding reverted this section stayed
    // green until the tail gap was added.
    gaps.push(performance.now() - last);
    running = false;
    clearTimeout(timer);

    const during = ticks - ticksBefore;
    const longest = Math.max(...gaps);

    console.log(`     scan ${elapsed.toFixed(0)} ms · ${during} probe interleavings · ` +
                `longest block ${longest.toFixed(1)} ms`);

    // Threshold is DERIVED, not picked: the JW pass alone performs
    // pageCount*(pageCount-1)/2 comparisons, so the budget implies at least
    // that many / SEMANTIC_SCAN_YIELD_CHUNK yields. Halved for headroom.
    // A synchronous implementation still scores a handful of interleavings
    // from its opening filesystem awaits — that number is FIXED, while this
    // floor scales with the corpus, which is what separates them.
    const jwComparisons = (base.pageCount * (base.pageCount - 1)) / 2;
    const expectedYields = Math.floor(jwComparisons / SEMANTIC_SCAN_YIELD_CHUNK / 2);
    ok(during >= expectedYields,
      `the setImmediate probe was serviced DURING the scan ` +
      `(${during} interleavings, ≥ ${expectedYields} implied by the budget)`,
      'a synchronous scan scores only the few from its opening fs awaits');
    ok(timerFired,
      'a 5 ms setTimeout scheduled before the scan fired while the scan was still running');
    ok(longest < 50,
      `the longest uninterrupted block stayed under the 50 ms Long-Tasks threshold (${longest.toFixed(1)} ms)`);
    ok(fingerprint(r.pairs) === baseFp,
      'the run observed under the probe produced the same pair list');
  }

  // ───────────────────────────────────────────────────────────────────────
  section('5. Negative control — the §4 probe can actually detect blocking');

  {
    // Same instrumentation, pointed at a deliberately synchronous burn of
    // comparable duration. If this ALSO reported interleavings, §4 would be
    // green for the wrong reason and would keep passing after a revert.
    let ticks = 0, running = true;
    const probe = () => { ticks++; if (running) setImmediate(probe); };
    setImmediate(probe);
    await new Promise(resolve => setImmediate(resolve)); // let the probe arm
    const before = ticks;

    const t0 = performance.now();
    let sink = 0;
    while (performance.now() - t0 < 120) sink += Math.sqrt(sink + 1);
    running = false;
    const during = ticks - before;

    ok(during === 0,
      `a 120 ms synchronous block services the probe ZERO times (got ${during}) — ` +
      'the §4 assertion is not vacuous',
      `sink=${sink.toFixed(0)}`);
  }

} finally {
  __setDomainsDirOverride(null);
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ Semantic-scan yielding: responsive AND output-identical');
