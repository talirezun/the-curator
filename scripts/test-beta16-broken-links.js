#!/usr/bin/env node
/**
 * scripts/test-beta16-broken-links.js — OFFLINE
 *
 * The bulk AI broken-link fixer: the gate that decides whether a broken
 * `[[wikilink]]` is REPOINTED at an existing page or has its brackets
 * STRIPPED, and the two places that gate now runs.
 *
 * ── WHY THIS CORPUS WAS REBUILT (v3.9.1) ──────────────────────────────────
 *
 * The previous version of this file reported `36 passed, 0 failed, exit 0`
 * against an implementation that accepted, among others:
 *
 *     claude-sonnet-4.5 → claude-sonnet-3.5    Jaccard 0.500   ACCEPT
 *     q1-2025-results   → q1-2024-results      Jaccard 0.500   ACCEPT
 *     data-retained     → data-not-retained    SUBSET          ACCEPT
 *     whisper-ai        → ai                   Jaccard 0.500   ACCEPT
 *
 * In a wiki about AI models, the first of those is factual corruption written
 * into every page that referenced the link.
 *
 * It was not a missing test CASE. It was a missing HALF OF THE INPUT SPACE.
 * The gate's rule is `subset OR Jaccard ≥ 0.5`, and the highest Jaccard
 * anywhere on the old corpus's reject side was **0.400** — every negative
 * probe was "two topics that barely share vocabulary", which is the region
 * where the formula is correct by construction. Nothing above the threshold
 * was ever tested, so nothing above the threshold was ever guarded.
 *
 * So this corpus is built to a different rule, and the rule is the point:
 *
 *   1. §2c/§2d probe ABOVE the threshold on the REJECT side, and §2g asserts
 *      mechanically that they do — if the reject corpus's maximum Jaccard
 *      ever drops back under 0.5, the suite fails and says why. That region
 *      cannot silently fall out of coverage again.
 *   2. §2e asserts a STRUCTURAL LAW over generated inputs, not a case list.
 *      Two n-token slugs differing in exactly one numeric token must reject
 *      for every n in 3..8 — and each probe is asserted to sit at Jaccard
 *      ≥ 0.5 first, so a green cannot mean "the probe was never dangerous".
 *      A case list is what produced the original blind spot; enumerating
 *      versions we happen to have seen would reproduce it in a new shape.
 *   3. §2g carries NEGATIVE CONTROLS: pairs that score above 0.5 and SHOULD
 *      still accept. A fix that simply refused everything at or above the
 *      threshold would satisfy every rejection assertion in this file; these
 *      are what stop that passing.
 *   4. §2h RECORDS the half of the class that is still open, rather than
 *      letting the docblock imply the whole class is closed.
 *
 * ── WHAT ELSE IS COVERED ──────────────────────────────────────────────────
 *   §1  buildLinkResolver — the deterministic (free) pre-pass.
 *   §3  groupBrokenLinks — occurrence grouping by unique linkText.
 *   §4  slugifyText.
 *   §5  applyBrokenLinkFixes re-runs the gate SERVER-SIDE (real files).
 *   §6  fixBrokenLink refuses a target that does not exist (real files).
 *   §7  CLASS INVARIANT — every count applyBrokenLinkFixes returns must reach
 *       the wire (behavioural: drives the real express route) and must be read
 *       by BOTH frontends or be named, with a reason, in §7's NOT_RENDERED
 *       allow-list. Written as a class because v3.9.1's `downgraded` was this
 *       repo's THIRD dead-data field; a `downgraded`-shaped assertion would
 *       close instance three and do nothing about instance four.
 *
 * The live AI plan is covered by test-beta16-production.js (real LLM,
 * throwaway domain).
 *
 * Run: node scripts/test-beta16-broken-links.js   (exit 0 = all green)
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { __setDomainsDirOverride } from '../src/brain/config.js';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-beta16-'));
__setDomainsDirOverride(ROOT);

const { __testing, isLexicalVariant: isLexicalVariantExported } = await import('../src/brain/health-ai.js');
const { applyBrokenLinkFixes, fixIssue } = await import('../src/brain/health.js');
const { isLexicalVariant, buildLinkResolver, groupBrokenLinks, slugifyText } = __testing;

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, detail = '') { cond ? (passed++, console.log(`  ✓ ${label}`)) : (failed++, failures.push(`${label} — ${detail}`), console.log(`  ✗ ${label} — ${detail}`)); }

/**
 * Jaccard over the same tokenisation the gate uses, computed here from the
 * EXPORTED slugifyText rather than from the gate itself. It is the corpus's
 * measuring stick — used to prove a probe is in the dangerous region — so it
 * must not be able to agree with a broken gate by construction.
 */
function jaccard(a, b) {
  const tok = (s) => slugifyText(String(s || '').replace(/^summaries\//, '')).split('-').filter(Boolean);
  const A = tok(a), B = tok(b);
  if (!A.length || !B.length) return 0;
  const bs = new Set(B);
  const inter = A.filter(t => bs.has(t)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}
const j = (a, b) => jaccard(a, b).toFixed(3);

// Fixture plumbing for §5/§6 — a real domain on disk under the tempdir.
function mkDomain(name, files) {
  const wiki = path.join(ROOT, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(ROOT, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(wiki, rel), body);
  return wiki;
}
const read = (wiki, rel) => readFileSync(path.join(wiki, rel), 'utf8');

// ── 1. Deterministic resolver ─────────────────────────────────────────────────
console.log('\n1. buildLinkResolver — free formatting fixes');
{
  const resolve = buildLinkResolver(
    ['tali-rezun', 'openai', 'the-curator'],        // entities
    ['artificial-intelligence', 'machine-learning'], // concepts
    ['the-energy-and-water-footprint']               // summaries (bare)
  );
  assert(resolve('artificial intelligence') === 'artificial-intelligence', 'space → hyphen slug resolves');
  assert(resolve('tali-rezun.md') === 'tali-rezun', '.md suffix stripped + resolves');
  assert(resolve('The Curator') === 'the-curator', 'caps + space → existing slug');
  assert(resolve('concepts/machine-learning') === 'machine-learning', 'folder prefix stripped');
  assert(resolve('summaries/the-energy-and-water-footprint') === 'summaries/the-energy-and-water-footprint', 'summary prefixed link resolves');
  assert(resolve('energy-and-water-footprint') === 'summaries/the-energy-and-water-footprint', 'article-prefix-tolerant summary match');
  assert(resolve('Artificial Intelligence') === 'artificial-intelligence', 'mixed case resolves');
  assert(resolve('nonexistent-thing') === null, 'genuinely missing → null (no deterministic match)');
  assert(resolve('') === null, 'empty → null');
}

// ── 2a. Lexical-variant gate — TRUE variants still retarget ───────────────────
console.log('\n2a. isLexicalVariant — true same-page variants still ACCEPT');
{
  // Drawn from the real articles-domain run. Every one of these was green
  // before the v3.9.1 hardening and must stay green after it: a fix that
  // tightens the gate by rejecting more is only a fix if these survive.
  assert(isLexicalVariant('rezun-tali', 'tali-rezun'), 'reordering is a variant');
  assert(isLexicalVariant('iot', 'iot-and-ai'), 'token-subset (acronym topic) is a variant');
  assert(isLexicalVariant('mcp', 'model-context-protocol-mcp'), 'acronym contained in target is a variant');
  assert(isLexicalVariant('big data', 'big-data-and-ai'), 'space-form + topic suffix is a variant');
  assert(isLexicalVariant('software-development-efficiency-enhancement', 'software-development-efficiency'), 'superset is a variant');
  assert(isLexicalVariant('NEO Cotruglian Triple Entry (NCTE)', 'neo-cotrugli-triple-entry-ncte'), 'caps/punctuation slugify + overlap is a variant');
  assert(isLexicalVariant('artificial-intelligence-defined', 'artificial-intelligence-definition'), 'jaccard ≥ 0.5 is a variant');
  assert(isLexicalVariant('gpt', 'gpt-family-of-models'), '"gpt" (3 chars) still a variant');
  assert(isLexicalVariant('summaries/the-paper', 'summaries/the-paper'), 'identical summary → variant');
}

// ── 2b. FALSE — different concepts, BELOW the threshold ───────────────────────
console.log('\n2b. isLexicalVariant — unrelated concepts strip (the pre-v3.9.1 corpus)');
{
  // These are the whole of the original negative corpus. Note the scores: the
  // highest is 0.400 against a 0.500 threshold, which is why they all passed
  // while the gate was inverted. Kept, but they are no longer the coverage.
  assert(!isLexicalVariant('context-window', 'agent-memory'), 'context-window ≠ agent-memory (strip)');
  assert(!isLexicalVariant('big-data', 'ai-and-weather-forecasting-improvement'), 'big-data ≠ weather (strip)');
  assert(!isLexicalVariant('healthcare', 'ai-applications-in-medical-care'), 'healthcare ≠ medical-care page (strip)');
  assert(!isLexicalVariant('productivity', 'ai-as-a-force-multiplier'), 'productivity ≠ force-multiplier (strip)');
  assert(!isLexicalVariant('responsible-ai-development', 'agency-in-ai-development'), 'jaccard 0.4 < 0.5 → strip');
}

// ── 2c. VERSION / NUMBER discrimination — ABOVE the threshold ─────────────────
console.log('\n2c. isLexicalVariant — a version or number difference REJECTS (above 0.5)');
{
  // THE HEADLINE DEFECT. Every pair here scored at or above the gate's own
  // threshold and was ACCEPTED before v3.9.1. Each assertion is paired with a
  // measurement of its Jaccard so a reader can see it is in the region the
  // formula gets wrong, not the region it gets right.
  const above = [
    ['claude-sonnet-4.5', 'claude-sonnet-3.5', 'the dot is DELETED by slugify → tokens {claude,sonnet,45} vs {claude,sonnet,35}'],
    ['claude-sonnet-4-5', 'claude-sonnet-3-5', 'hyphenated version form'],
    ['q1-2025-results',   'q1-2024-results',   'year'],
    ['gpt-4o-benchmarks', 'gpt-4-benchmarks',  'model suffix'],
    ['api-v2-migration',  'api-v3-migration',  'v-prefixed version'],
    ['q1-revenue-report', 'q2-revenue-report', 'quarter'],
  ];
  for (const [a, b, why] of above) {
    assert(jaccard(a, b) >= 0.5, `PROBE IS DANGEROUS: ${a} vs ${b} scores ≥ 0.5 (${j(a, b)}) — ${why}`, `scored ${j(a, b)}`);
    assert(!isLexicalVariant(a, b), `${a} ↛ ${b} — a version difference is not a spelling variant`, `J=${j(a, b)}`);
  }
  // Below the threshold too — it rejected before only by ACCIDENT (2 tokens),
  // and must now reject for a reason.
  assert(!isLexicalVariant('gpt-4', 'gpt-5'), 'gpt-4 ↛ gpt-5 (rejected by the version rule, not by arithmetic)', `J=${j('gpt-4', 'gpt-5')}`);
  // A version present on BOTH sides is shared context, not a discriminator.
  assert(isLexicalVariant('gpt-4-turbo-pricing', 'gpt-4-pricing-turbo'),
    'a version shared by both slugs does NOT block a genuine reordering', `J=${j('gpt-4-turbo-pricing', 'gpt-4-pricing-turbo')}`);
}

// ── 2d. POLARITY / NEGATION discrimination ────────────────────────────────────
console.log('\n2d. isLexicalVariant — a polarity difference REJECTS');
{
  // `data-retained` → `data-not-retained` is a SUBSET relation, so no threshold
  // change of any size reaches it: it needed its own discriminator.
  const flips = [
    ['data-retained',        'data-not-retained',        'negation marker, via the SUBSET branch'],
    ['deterministic-output', 'non-deterministic-output', 'hyphenated non-'],
    ['secure-token-storage', 'insecure-token-storage',   'morphological in-'],
    ['valid-token-handling', 'invalid-token-handling',   'morphological in-'],
    ['code-generation',      'no-code-generation',       '"no" marker'],
    ['pattern-catalogue',    'anti-pattern-catalogue',   '"anti" marker'],
    ['data-input-format',    'data-output-format',       'polarity pair input/output'],
    ['file-read-api',        'file-write-api',           'polarity pair read/write'],
    ['feature-enabled-flag', 'feature-disabled-flag',    'polarity pair enabled/disabled'],
  ];
  // EVERY probe is asserted to sit above the threshold FIRST, not just one of
  // them. An earlier draft checked only the maximum, and a mutation run showed
  // why that is not enough: `secure-storage` vs `insecure-storage` is a 2-token
  // pair scoring 0.333, so deleting the morphological rule left its assertion
  // GREEN — it was passing for the §2b reason and proving nothing.
  for (const [a, b, why] of flips) {
    assert(jaccard(a, b) >= 0.5, `PROBE IS DANGEROUS: ${a} vs ${b} scores ≥ 0.5 (${j(a, b)}) — ${why}`, `scored ${j(a, b)} — this probe would prove nothing`);
    assert(!isLexicalVariant(a, b), `${a} ↛ ${b} (${why})`, `J=${j(a, b)}`);
  }
  // Negation vocabulary shared by both sides is not a difference.
  assert(isLexicalVariant('non-deterministic-output-format', 'non-deterministic-format-output'),
    'a negation shared by both slugs does NOT block a genuine reordering');
  // `in-` is a preposition far more often than a negation, so it is NOT a
  // standalone marker — only a prefix on a real stem.
  assert(isLexicalVariant('ai-in-medicine-today', 'ai-medicine-today-in'),
    '"in" as an ordinary preposition does not trip the negation rule');
}

// ── 2e. THE STRUCTURAL LAW (generated, not enumerated) ────────────────────────
console.log('\n2e. isLexicalVariant — the law: one differing numeric token always rejects');
{
  // The defect was never "we forgot claude-sonnet". It was that Jaccard is a
  // token COUNT: for n-token slugs sharing n−1, J = (n−1)/(n+1), which crosses
  // 0.5 at n = 3 and only climbs. So the guarantee has to be stated over ALL n,
  // and generated rather than listed — a list of the versions we happened to
  // think of is the original blind spot wearing a different hat.
  const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
  let lawChecked = 0;
  for (let n = 3; n <= 8; n++) {
    for (const pos of [0, Math.floor(n / 2), n - 1]) {          // first, middle, last
      const mk = (num) => { const t = WORDS.slice(0, n - 1); t.splice(pos, 0, num); return t.join('-'); };
      const a = mk('2024'), b = mk('2025');
      if (a === b) continue;
      lawChecked++;
      assert(jaccard(a, b) >= 0.5,
        `LAW PRECONDITION n=${n} pos=${pos}: the pair sits in the accept region (J=${j(a, b)})`,
        `${a} vs ${b} scored ${j(a, b)} — this probe would prove nothing`);
      assert(!isLexicalVariant(a, b),
        `LAW n=${n} pos=${pos}: ${n}-token slugs differing in one numeric token reject`,
        `${a} → ${b}  J=${j(a, b)}`);
    }
  }
  assert(lawChecked >= 15, 'ANTI-VACUITY: the law was actually exercised across n and position', `only ${lawChecked} probes ran`);
}

// ── 2f. The M4 generic-token guard is LOAD-BEARING, not decorative ────────────
console.log('\n2f. isLexicalVariant — the short-generic-token guard actually decides');
{
  // v3.0.1-beta.17 added "a 1-token subset side must be ≥3 chars". It looked
  // effective for eight releases because the ONE case its test pinned used a
  // long target (`ai` vs a 5-token slug, J=0.200). It was decorative: it
  // skipped the subset branch, and the Jaccard line immediately below then
  // accepted anyway at exactly 0.500 whenever the other slug had two tokens.
  const generic = [
    ['whisper-ai', 'ai'],
    ['ai-models',  'ai'],
    ['ai-systems', 'ai'],
    ['ml',         'ml-ops'],
    ['ux',         'ux-writing'],
  ];
  for (const [a, b] of generic) {
    assert(jaccard(a, b) >= 0.5, `PROBE IS DANGEROUS: ${a} vs ${b} scores ≥ 0.5 (${j(a, b)})`, `scored ${j(a, b)}`);
    assert(!isLexicalVariant(a, b), `${a} ↛ ${b} — a 2-char generic token is not a page identity (M4)`, `J=${j(a, b)}`);
  }
  // The cases the original M4 test pinned — still rejected, now for a reason
  // that survives the target getting shorter.
  assert(!isLexicalVariant('ai', 'ai-and-weather-forecasting-improvement'), 'generic "ai" ⊄ long slug → strip (M4, original case)');
  assert(!isLexicalVariant('ml', 'ml-ops-platform-comparison'), 'generic "ml" (2 chars) → strip (M4, original case)');
  // …and the ≥3-char acronyms the guard exists to PRESERVE.
  assert(isLexicalVariant('iot', 'iot-and-ai'), '"iot" (3 chars) still a variant');
  assert(isLexicalVariant('rag', 'rag-pipelines'), '"rag" (3 chars) still a variant');
}

// ── 2g. CORPUS COVERAGE — the property the old suite lacked ───────────────────
console.log('\n2g. corpus coverage — the reject side reaches above the threshold');
{
  // The old corpus's reject side topped out at 0.400 against a 0.500
  // threshold, so the entire dangerous region was untested and the suite could
  // not have gone red. This asserts the region is covered, mechanically, so it
  // cannot silently drop out again.
  const REJECT_CORPUS = [
    ['claude-sonnet-4.5', 'claude-sonnet-3.5'], ['q1-2025-results', 'q1-2024-results'],
    ['data-retained', 'data-not-retained'],     ['whisper-ai', 'ai'],
    ['ml', 'ml-ops'],                           ['data-input-format', 'data-output-format'],
    ['context-window', 'agent-memory'],         ['responsible-ai-development', 'agency-in-ai-development'],
  ];
  for (const [a, b] of REJECT_CORPUS) {
    assert(!isLexicalVariant(a, b), `reject corpus: ${a} ↛ ${b}`, `J=${j(a, b)}`);
  }
  const maxReject = Math.max(...REJECT_CORPUS.map(([a, b]) => jaccard(a, b)));
  assert(maxReject >= 0.5,
    `COVERAGE: the reject corpus contains a pair scoring ≥ 0.5 (max ${maxReject.toFixed(3)}) — without this, every negative probe sits where the formula is already correct`,
    `max was only ${maxReject.toFixed(3)}`);

  // NEGATIVE CONTROLS. Every assertion above is a rejection, and "reject
  // everything at or above 0.5" would satisfy all of them. These are pairs in
  // the same region that must still ACCEPT, so that fix fails here.
  const ACCEPT_ABOVE_THRESHOLD = [
    ['artificial-intelligence-defined', 'artificial-intelligence-definition'],
    ['knowledge-graph-design',          'knowledge-graph-designs'],
    ['prompt-caching-strategy',         'prompt-caching-tactics'],
    ['gpt-4-turbo-pricing',             'gpt-4-pricing-turbo'],
  ];
  for (const [a, b] of ACCEPT_ABOVE_THRESHOLD) {
    assert(jaccard(a, b) >= 0.5, `CONTROL IS IN-REGION: ${a} vs ${b} scores ≥ 0.5 (${j(a, b)})`, `scored ${j(a, b)}`);
    assert(isLexicalVariant(a, b), `NEGATIVE CONTROL: ${a} → ${b} still accepts (a blanket ≥0.5 refusal would fail here)`, `J=${j(a, b)}`);
  }
}

// ── 2h. RECORDED, NOT FIXED — the generic-parent subset gap ───────────────────
console.log('\n2h. KNOWN GAP (recorded, not fixed) — specific → generic parent');
{
  // ⚠ THESE ASSERTIONS PIN A KNOWN DEFECT, ON PURPOSE.
  //
  // The dominant real-world failure is NOT versions. Measured across the
  // maintainer's six domains: of 57 broken links with at least one
  // gate-approved target, 33 are a SPECIFIC concept approved onto its GENERIC
  // PARENT. No version rule, no polarity rule and no threshold change touches
  // them, because they are subset relations with a ≥3-char parent token —
  // structurally identical to `iot` ⊂ `iot-and-ai`, which §2a asserts is a
  // legitimate PASS. Narrowing that changes intended semantics; it is a
  // product decision for the maintainer, not a bug fix to slip into a
  // correctness release.
  //
  // They are asserted rather than merely listed so the record cannot rot. IF
  // YOU DELIBERATELY NARROW THE SUBSET BRANCH, THIS BLOCK GOES RED FOR A GOOD
  // REASON — flip these to `!isLexicalVariant`, and delete this comment.
  const KNOWN_STILL_ACCEPTED = [
    ['agent-memory',        'memory'],
    ['human-amplification', 'human'],
    ['auto-loop',           'loop'],
    ['email-automation',    'automation'],
    ['microsoft-research',  'microsoft'],
  ];
  for (const [a, b] of KNOWN_STILL_ACCEPTED) {
    assert(isLexicalVariant(a, b), `KNOWN GAP still open: ${a} → ${b} is approved (specific → generic parent)`, `J=${j(a, b)}`);
  }
  console.log(`     ↳ ${KNOWN_STILL_ACCEPTED.length} recorded gap cases; see isLexicalVariant's NOT ENFORCED block.`);
}

// ── 2i. Defensive ─────────────────────────────────────────────────────────────
console.log('\n2i. isLexicalVariant — defensive inputs');
{
  assert(!isLexicalVariant('', 'tali-rezun'), 'empty broken → false');
  assert(!isLexicalVariant('foo', ''), 'empty target → false');
  assert(!isLexicalVariant(null, undefined), 'null/undefined → false (no throw)');
  assert(!isLexicalVariant('---', '---'), 'punctuation-only slugs → false');
  assert(typeof isLexicalVariantExported === 'function' && isLexicalVariantExported === isLexicalVariant,
    'isLexicalVariant is a real named export, and __testing exposes the SAME function (no second copy)');
}

// ── 3. Grouping ───────────────────────────────────────────────────────────────
console.log('\n3. groupBrokenLinks — occurrence grouping');
{
  const groups = groupBrokenLinks([
    { sourceFile: 'a.md', linkText: 'mcp' },
    { sourceFile: 'b.md', linkText: 'mcp' },
    { sourceFile: 'a.md', linkText: 'mcp' },     // same file repeat
    { sourceFile: 'c.md', linkText: 'rag' },
    { sourceFile: 'd.md', linkText: '' },         // empty → skipped
  ]);
  const mcp = groups.find(g => g.linkText === 'mcp');
  const rag = groups.find(g => g.linkText === 'rag');
  assert(groups.length === 2, 'two unique targets (empty skipped)', `got ${groups.length}`);
  assert(mcp.occurrences === 3, 'mcp counted 3 occurrences', `got ${mcp.occurrences}`);
  assert(mcp.sourceFiles.length === 2 && mcp.sourceFiles.includes('a.md') && mcp.sourceFiles.includes('b.md'), 'mcp source files deduped to 2');
  assert(rag.occurrences === 1, 'rag counted once');
}

// ── 4. slugifyText sanity ─────────────────────────────────────────────────────
console.log('\n4. slugifyText');
{
  assert(slugifyText('Artificial Intelligence') === 'artificial-intelligence', 'caps+space');
  assert(slugifyText('tali-rezun.md') === 'tali-rezun', '.md stripped');
  assert(slugifyText('NEO Cotruglian Triple Entry (NCTE)') === 'neo-cotruglian-triple-entry-ncte', 'punctuation removed');
  assert(slugifyText('a__b') === 'a-b', 'underscores → hyphen, collapsed');
  assert(slugifyText('claude-sonnet-4.5') === 'claude-sonnet-45',
    'a DOT IS DELETED, not converted — "4.5" becomes the single token "45" (this is why the changelog\'s {claude,sonnet,4,5}/0.6 arithmetic was wrong)');
}

// ── 5. The gate runs SERVER-SIDE at apply time ────────────────────────────────
console.log('\n5. applyBrokenLinkFixes — the gate is re-run on the submitted plan');
{
  // Until v3.9.1 the gate ran ONCE, in the planner. This function's plan
  // arrives in a POST body, and the preview the user approves is client-side,
  // so a plan that never met the gate — or met an older, weaker one — was
  // applied verbatim. These fixtures drive the REAL function against REAL
  // files, so they fail if the call is removed, not merely if a string moves.
  {
    const wiki = mkDomain('regate', {
      'concepts/claude-sonnet-3.5.md': '# Claude Sonnet 3.5\n',
      'entities/e.md': '# E\n\nUses [[claude-sonnet-4.5]] heavily.\n',
    });
    const r = await applyBrokenLinkFixes('regate', [
      { linkText: 'claude-sonnet-4.5', action: 'retarget', target: 'claude-sonnet-3.5' },
    ]);
    const body = read(wiki, 'entities/e.md');
    assert(r.retargeted === 0, 'a version-differing retarget is NOT applied', JSON.stringify(r));
    assert(r.downgraded === 1, '…it is reported as downgraded, not silently dropped', JSON.stringify(r));
    assert(r.stripped === 1 && body.includes('Uses claude-sonnet-4.5 heavily'),
      '…and it degrades to a strip, keeping the readable text', body.trim());
    assert(!body.includes('claude-sonnet-3.5'), '…the wrong link was never written to disk');
  }
  {
    // The DETERMINISTIC tier must survive the re-gate. Pure formatting repairs
    // share no whole token with their target (`r-a-g` vs `rag` scores Jaccard
    // 0), so a blanket re-gate downgrades every free fix to `strip`. The first
    // cut of this change did exactly that; section 8d of test-wiki-page.js
    // caught it. The exemption is re-derived server-side from the same
    // resolver, never trusted from the plan's `source` field.
    const wiki = mkDomain('deterministic', {
      'concepts/rag.md': '# RAG\n',
      'entities/email.md': '# Email\n',
      'entities/e.md': '# E\n\nSee [[r-a-g]] and [[e-mail]].\n',
    });
    assert(jaccard('r-a-g', 'rag') === 0, 'PRECONDITION: r-a-g vs rag scores Jaccard 0 — the lexical gate alone would refuse it', `J=${j('r-a-g', 'rag')}`);
    const r = await applyBrokenLinkFixes('deterministic', [
      { linkText: 'r-a-g',  action: 'retarget', target: 'rag' },
      { linkText: 'e-mail', action: 'retarget', target: 'email' },
    ]);
    const body = read(wiki, 'entities/e.md');
    assert(r.retargeted === 2 && r.downgraded === 0,
      'a hyphen-normalisation repair the free resolver itself produces is EXEMPT and still applies', JSON.stringify(r));
    assert(body.includes('[[rag]]') && body.includes('[[email]]'), '…and both landed on disk', body.trim());
  }
  {
    // The exemption cannot be used to smuggle a wrong target past the gate:
    // it only fires when the resolver independently produces that exact target.
    const wiki = mkDomain('nosmuggle', {
      'concepts/rag.md': '# RAG\n',
      'concepts/claude-sonnet-3.5.md': '# CS 3.5\n',
      'entities/e.md': '# E\n\nSee [[claude-sonnet-4.5]].\n',
    });
    const r = await applyBrokenLinkFixes('nosmuggle', [
      // `source` claims the deterministic tier; the server does not believe it.
      { linkText: 'claude-sonnet-4.5', action: 'retarget', target: 'claude-sonnet-3.5', source: 'deterministic' },
    ]);
    assert(r.retargeted === 0 && r.downgraded === 1,
      'a plan claiming source:"deterministic" is still gated — the exemption is re-derived, not trusted', JSON.stringify(r));
    assert(!read(wiki, 'entities/e.md').includes('3.5'), '…nothing wrong reached disk');
  }
}

// ── 6. fixBrokenLink validates the target exists ──────────────────────────────
console.log('\n6. fixIssue(brokenLinks) — a target that does not exist is refused');
{
  // The MCP `fix_wiki_issue` tool hands this an issue object composed by an
  // LLM, and its description used to call brokenLinks "SAFE to apply without
  // asking". The only check was `if (!issue.suggestedTarget)` — a truthiness
  // test — so a model could retarget links wiki-wide to a page that does not
  // exist, manufacturing the defect the tool exists to repair.
  const wiki = mkDomain('mcpguard', {
    'concepts/rag.md': '# RAG\n',
    'entities/e.md': '# E\n\nSee [[r-a-g]] and [[whatever]].\n',
  });
  const bad = await fixIssue('mcpguard', 'brokenLinks',
    { sourceFile: 'entities/e.md', linkText: 'whatever', suggestedTarget: 'a-page-that-does-not-exist' });
  assert(bad.fixed === 0, 'a suggestedTarget naming no real page is refused', JSON.stringify(bad));
  assert(read(wiki, 'entities/e.md').includes('[[whatever]]'), '…the file is untouched');

  const good = await fixIssue('mcpguard', 'brokenLinks',
    { sourceFile: 'entities/e.md', linkText: 'r-a-g', suggestedTarget: 'rag' });
  assert(good.fixed === 1 && read(wiki, 'entities/e.md').includes('[[rag]]'),
    'CONTROL: a target that DOES exist still applies (the refusal is not blanket)', JSON.stringify(good));

  const traversal = await fixIssue('mcpguard', 'brokenLinks',
    { sourceFile: 'entities/e.md', linkText: 'whatever', suggestedTarget: '../../../etc/passwd' });
  assert(traversal.fixed === 0, 'a path-shaped target is refused too (it names no page in the inventory)', JSON.stringify(traversal));
  assert(!read(wiki, 'entities/e.md').includes('passwd'), '…and nothing path-shaped was written into a link');
}

// ── 7. CLASS INVARIANT — no count may reach the user through nobody ───────────
console.log('\n7. every count applyBrokenLinkFixes returns must reach the wire AND a reader');
{
  // ── WHY THIS IS A CLASS INVARIANT AND NOT A `downgraded` CHECK ──────────
  // v3.9.1 added `downgraded` — the count the server-side lexical gate produces
  // when it REFUSES a proposed retarget and degrades it to a strip. It was
  // computed, documented in the @returns, and read by NOTHING: neither frontend
  // mentioned it, so a link refused because the AI proposed a factually wrong
  // target was folded into the "brackets removed" total, indistinguishable from
  // a link that never had a candidate at all. The safety mechanism worked and
  // the user was never told it fired.
  //
  // That is this repo's named DEAD-DATA shape, and this was its THIRD instance:
  // v3.6.1 finding 5 (six new API fields reaching no consumer), v3.6.2 (BOTH
  // backend fixes added result fields with no consumer), now this — inside the
  // release's own fix. The recorded lesson each time is that the mechanism gets
  // fixed and the purpose left broken. A test asserting "`downgraded` is
  // rendered" would close instance three and do nothing about instance four.
  //
  // So the field list is ENUMERATED FROM THE REAL RETURN VALUE, never written
  // out here. Add a count to applyBrokenLinkFixes tomorrow and it is checked
  // automatically: it must reach the wire, and it must either be rendered by
  // both frontends or be named in NOT_RENDERED below with a reason. There is no
  // third option, which is what makes a fourth instance impossible rather than
  // merely unlikely.
  //
  // Counts that deliberately reach no renderer. A blanket "every field must be
  // shown" would be a bad invariant — it pressures people to dump numbers on
  // screen. This list is the escape valve, and adding to it is a deliberate act.
  const NOT_RENDERED = {
    totalActions: 'the number of distinct links in the plan — the user already approved exactly this in the preview card before applying.',
    occurrencesReplaced: 'the SUM of retargeted + stripped occurrences, both of which are rendered separately and more informatively. /next used to render this ALONE, under the single label "Repointed", which reported bracket removals as repoints.',
  };

  // ── (a) the producer's own shape, from both of its return paths ─────────
  const wiki7 = mkDomain('classinv', {
    'concepts/claude-sonnet-3.5.md': '# CS\n',
    'entities/e.md': '# E\n\n[[claude-sonnet-4.5]] and [[claude-sonnet-4.5]].\n',
  });
  const applied = await applyBrokenLinkFixes('classinv', [
    { linkText: 'claude-sonnet-4.5', action: 'retarget', target: 'claude-sonnet-3.5' },
  ]);
  // The early-return path (nothing actionable) must carry the SAME keys. A field
  // present on one return path and absent on the other makes the wire shape
  // CONDITIONAL, so a renderer reads undefined only for some runs — the hardest
  // version of this bug to notice.
  const empty = await applyBrokenLinkFixes('classinv', [{ linkText: 'nope', action: 'bogus' }]);
  const keys = Object.keys(applied).sort();
  const emptyKeys = Object.keys(empty).sort();
  assert(keys.length > 0, 'PRECONDITION: the producer returns at least one count', JSON.stringify(applied));
  assert(keys.join(',') === emptyKeys.join(','),
    'both return paths carry an IDENTICAL key set — the wire shape is never conditional',
    `main=[${keys}] early=[${emptyKeys}]`);
  // Guards the guard: if this ever enumerated an empty/degenerate set it would
  // pass every assertion below while checking nothing.
  assert(keys.includes('downgraded'),
    'PRECONDITION: the enumeration actually reaches the v3.9.1 gate count', JSON.stringify(keys));

  // ── (b) WIRE — behavioural. Drives the REAL express route. ──────────────
  // Not a source scan: it invokes the registered POST handler and parses the
  // SSE frames it writes. The route currently spreads (`send({ type: 'done',
  // ...result })`), so every count reaches the client for free — which is
  // exactly why this needs pinning. v3.0.17 is the precedent: ingestFile
  // returned `result.tokenUsage` and routes/ingest.js dropped it purely by
  // building its payload field-by-field. One refactor from spread to explicit
  // pick silently kills every count not named, with no error anywhere.
  const routerMod = await import('../src/routes/health.js');
  const layer = routerMod.default.stack.find(
    (l) => l.route && l.route.path === '/:domain/broken-links/apply' && l.route.methods.post);
  assert(!!layer, 'PRECONDITION: the apply route is registered and reachable for driving');
  const wiki7b = mkDomain('classwire', {
    'concepts/claude-sonnet-3.5.md': '# CS\n',
    'entities/e.md': '# E\n\n[[claude-sonnet-4.5]].\n',
  });
  const written = [];
  const fakeRes = {
    setHeader() {}, flushHeaders() {}, status() { return this; }, json() { return this; },
    write(chunk) { written.push(chunk); }, end() {},
  };
  await new Promise((resolve) => {
    fakeRes.end = () => resolve();
    layer.route.stack[layer.route.stack.length - 1].handle(
      { params: { domain: 'classwire' },
        body: { plan: [{ linkText: 'claude-sonnet-4.5', action: 'retarget', target: 'claude-sonnet-3.5' }] } },
      fakeRes, () => resolve());
  });
  const doneFrame = written.join('').split('\n\n')
    .map((c) => c.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean).find((e) => e.type === 'done');
  assert(!!doneFrame, 'the route emits a done frame at all', written.join('').slice(0, 200));
  for (const k of keys) {
    assert(doneFrame && k in doneFrame,
      `wire: the done frame carries "${k}"`, JSON.stringify(doneFrame));
  }

  // ── (c) READERS — SOURCE SCAN. Stated plainly, not dressed up. ──────────
  // ENFORCED: each non-exempt count appears in EXECUTABLE code inside the
  //   function that handles the apply result, in BOTH frontends. Comments are
  //   stripped first and the strip is proven below by a negative control, so a
  //   mention in a docblock cannot satisfy it — which matters here because the
  //   comments this release added say "downgraded" repeatedly.
  //
  // NOT ENFORCED — and these are real holes, not hypotheticals:
  //   • that the read reaches the DOM. `const dg = Number(result.downgraded)||0`
  //     with the rendering line deleted stays GREEN.
  //   • aliasing: a field destructured and rendered under another name is
  //     invisible if the original identifier disappears.
  //   • correctness of the wording, or of which number goes with which label.
  //     That is precisely how /next shipped `occurrencesReplaced` labelled
  //     "Repointed" — a source scan would have called that a reader.
  //
  // Why not behavioural: src/public/app.js is ONE ES module of ~6,800 lines with
  // ~90 top-level getElementById constants — importing it in Node dereferences a
  // missing element at module scope and throws (that is the blank-page failure
  // test-frontend-null-safety.js exists for). /next's view imports the shell,
  // which is equally DOM-bound. Refactoring either for testability is a bigger
  // and riskier change than the defect being closed, and app.js is the file this
  // repo has documented as its most dangerous. So: scoped, honest, and labelled.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Whole-line comments only. Deliberately NOT a general // stripper: this
    // repo has twice shipped a lexer that desynced on template literals and
    // regexes and then reported every assertion green while seeing 78 of 90
    // declarations. A line whose first non-space characters are // cannot be
    // mid-template-literal in either scanned body (asserted by the control).
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  // Brace-match the enclosing function, the same technique v3.9.0 used to
  // enumerate every delete call's enclosing scope.
  const bodyOf = (src, needle) => {
    const at = src.indexOf(needle);
    if (at === -1) return null;
    const open = src.indexOf('{', at);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
  };

  const readers = [
    { label: '/old (src/public/app.js)', file: '../src/public/app.js', fn: 'async function applyBrokenLinkPlan(' },
    { label: '/next (src/public/next/views/domains.js)', file: '../src/public/next/views/domains.js', fn: 'async function applyPendingPlan(' },
  ];
  for (const r of readers) {
    const src = readFileSync(new URL(r.file, import.meta.url), 'utf8');
    const raw = bodyOf(src, r.fn);
    assert(!!raw, `PRECONDITION: found the apply handler in ${r.label}`, r.fn);
    if (!raw) continue;
    const code = stripComments(raw);
    // NEGATIVE CONTROL for the stripper, on this exact body: "v3.9.1" appears
    // in these files ONLY inside the comments added by this release. If it
    // survives, the stripper is not stripping and every assertion below is
    // being satisfied by prose.
    assert(raw.includes('v3.9.1') && !code.includes('v3.9.1'),
      `CONTROL: comments really are stripped from ${r.label} (a comment mention cannot pass)`,
      `presentBefore=${raw.includes('v3.9.1')} presentAfter=${code.includes('v3.9.1')}`);
    for (const k of keys) {
      if (k in NOT_RENDERED) continue;
      assert(new RegExp('\\b' + k + '\\b').test(code),
        `${r.label} reads "${k}" in code`,
        `not found outside comments in ${r.fn}`);
    }
  }
}

// ── 8. An EMPTY plan is a NORMAL outcome, not an error ────────────────────────
console.log('\n8. empty plan: normal outcome in both frontends, backstop 400 at the route');
{
  // ── THE DEFECT ───────────────────────────────────────────────────────────
  // The maintainer clicked "Rescue 3 orphans $0.0026" on his real 3,361-page
  // `articles` domain and got a RED banner reading
  //
  //     Could not apply the plan — Missing plan[] to apply
  //
  // Nothing had gone wrong. The orphan rescuer is CONSERVATIVE BY DESIGN — it
  // proposes a home only where there is a genuine relationship, and drops
  // anything below medium confidence, hallucinated, or self-linking. On the same
  // wiki in v3.0.1-beta.17 it placed 391 of 604 orphans and deliberately left
  // 213 for manual review. With three stubborn orphans remaining, "no home for
  // any of them" is the EXPECTED answer. The app took its own correct behaviour,
  // POSTed an empty plan anyway, and rendered the route's internal assertion at
  // the user.
  //
  // ── THE FULL ENUMERATION (four plan→apply flows, not one) ────────────────
  // Fixing only the reported flow is this project's named failure shape, so all
  // four were driven. What was actually found:
  //   /next  orphans       — RED ERROR (reported).
  //   /next  broken links  — IDENTICAL defect, same code path, unreported.
  //   /old   broken links  — "Apply — fix 0 broken links" rendered live, and the
  //                          handler's `if (!_blPlan.length) return` made the
  //                          click a SILENT no-op: no error, no message, nothing
  //                          to distinguish it from a click that did not land.
  //   /old   orphans       — ALREADY CORRECT since v3.0.1-beta.17, with exactly
  //                          the "left for manual review" message /next lacks.
  // So this is a PARITY REGRESSION as much as a bug: /next dropped a behaviour
  // the shipping app had, and v3.9.0's parity sweep did not catch it.
  //
  // ── WHY `batchErrors` IS PART OF THE FIX AND NOT SCOPE CREEP ─────────────
  // Both planners swallow a failed AI batch (`batch-error`, then `continue`
  // without pushing) so a flaky provider can never bias a plan toward deleting
  // brackets. That means an empty plan has TWO causes that are opposite in
  // meaning: the AI answered and declined everything, or the AI was never
  // reached. `/old`'s existing message asserts the first — "The AI found no
  // confident home" — which, on a run where no batch completed, states a
  // judgement no model ever made and sends the user off to triage by hand
  // instead of retrying. A "fixed" message that is still untrue is not fixed.
  // `batch-error` frames were already on the wire and read by NOTHING in /next.
  const SYNTH = (plan, summary, batchErrors = 0) => {
    const f = [];
    for (let i = 0; i < batchErrors; i++) f.push({ type: 'batch-error', batch: i, error: 'boom' });
    f.push({ type: 'done', plan, summary, cost: { provider: 'gemini', model: 'm' } });
    return f;
  };

  // ── (a) /next — behavioural, real source ─────────────────────────────────
  const nextSrc = readFileSync(new URL('../src/public/next/views/domains.js', import.meta.url), 'utf8');
  const grab = (src, needle) => {
    const at = src.indexOf(needle);
    if (at === -1) throw new Error('extract failed: ' + needle);
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
    }
    throw new Error('unbalanced: ' + needle);
  };
  const NEXT_FNS = ['function emptyPlanNotice(', 'async function runBrokenLinksPlan(',
    'async function runOrphansPlan(', 'async function applyPendingPlan('];
  const nextBodies = NEXT_FNS.map((n) => grab(nextSrc, n));
  // PRECONDITION: extraction is real. A silently-empty sandbox would satisfy
  // nothing while reporting green — the failure mode this repo has shipped
  // twice (a lexer seeing 78 of 90 declarations, all assertions still green).
  assert(nextBodies.every((b) => b && b.length > 80),
    'PRECONDITION: all four /next functions extracted from real source',
    nextBodies.map((b) => (b || '').length).join(','));

  function buildNext() {
    const calls = [];
    const preamble = `
      let state = { busyKey: null, progressText: null, aiProgress: null, pendingPlan: null, banner: null };
      let myMountToken = 1;
      let mountValid = true;
      const isCurrentMount = () => mountValid;
      const render = () => {};
      const noteAiProgress = () => {};
      const pluralize = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
      const inFlightWriteSlugs = new Set();
      const beginDomainWrite = () => () => {};
      const loadHealth = async () => {};
      let __frames = [];
      let __applyResult = { type: 'done', rescued: 1, skipped: 0, retargeted: 0, stripped: 0, filesChanged: 1, downgraded: 0 };
      async function streamSSE(url, body, on) {
        __calls.push({ url, body });
        const frames = url.endsWith('/apply') ? [__applyResult] : __frames;
        for (const ev of frames) on(ev.type, ev);
      }
    `;
    const api = `return {
      emptyPlanNotice, runBrokenLinksPlan, runOrphansPlan, applyPendingPlan,
      __state: () => state, __setPending: (p) => { state.pendingPlan = p; },
      __setFrames: (f) => { __frames = f; },
      __setMountValid: (v) => { mountValid = v; },
    };`;
    return new Function('__calls', preamble + nextBodies.join('\n\n') + '\n' + api)(calls).__attach === undefined
      ? Object.assign(new Function('__calls', preamble + nextBodies.join('\n\n') + '\n' + api)(calls), { __calls: calls })
      : null;
  }

  // ── (a1) the reported case: orphans, empty plan ──────────────────────────
  {
    const s = buildNext();
    s.__setFrames(SYNTH([], { rescuable: 0, noHome: 3, orphans: 3 }));
    await s.runOrphansPlan('articles');
    const st = s.__state();
    assert(st.pendingPlan === null,
      '/next orphans: an empty plan is NOT stored as a pending plan (no live "Apply" button over 0 actions)',
      JSON.stringify(st.pendingPlan));
    assert(st.banner && st.banner.tone === 'info',
      '/next orphans: an empty plan produces an INFO banner, not the red error the maintainer saw',
      JSON.stringify(st.banner));
    assert(st.banner && !/Missing plan/i.test(st.banner.text) && !/could not/i.test(st.banner.text),
      '/next orphans: the message does not read as a failure', JSON.stringify(st.banner));
    assert(st.banner && /manual review/i.test(st.banner.text) && /3 orphan pages/.test(st.banner.text),
      '/next orphans: the message says what actually happened, with the real count',
      JSON.stringify(st.banner));
    assert(s.__calls.length === 1 && s.__calls[0].url.endsWith('/orphans/plan'),
      '/next orphans: exactly ONE request — the plan; no apply was attempted',
      JSON.stringify(s.__calls.map((c) => c.url)));
  }

  // ── (a2) the CONTROL — a non-empty plan still behaves exactly as before ──
  // Without this, a fix that simply refused every plan would pass everything
  // above. This is the assertion that stops "always show the notice" passing.
  {
    const s = buildNext();
    s.__setFrames(SYNTH([{ orphanSlug: 'x', target: 'y', description: 'd' }],
      { rescuable: 1, noHome: 2, orphans: 3 }));
    await s.runOrphansPlan('articles');
    const st = s.__state();
    assert(st.pendingPlan && st.pendingPlan.kind === 'orphans' && st.pendingPlan.plan.length === 1,
      'CONTROL /next orphans: a NON-empty plan is still stored and offered for apply',
      JSON.stringify(st.pendingPlan));
    assert(!st.banner, 'CONTROL /next orphans: a real plan raises no banner', JSON.stringify(st.banner));
    await s.applyPendingPlan('articles');
    assert(s.__calls.length === 2 && s.__calls[1].url.endsWith('/orphans/apply'),
      'CONTROL /next orphans: applying a real plan DOES POST to the apply route',
      JSON.stringify(s.__calls.map((c) => c.url)));
    // Read defensively: a mutation that removes the apply POST must produce a
    // clean RED here, not a TypeError that aborts the run before the remaining
    // sections get to speak. A suite that dies mid-way reports a crash, and a
    // crash is a red for the wrong reason.
    const sent = s.__calls[1] && s.__calls[1].body;
    assert(!!sent && Array.isArray(sent.plan) && sent.plan.length === 1,
      'CONTROL /next orphans: the real plan is what gets sent', JSON.stringify(sent));
  }

  // ── (a3) the same defect in the SIBLING flow nobody reported ─────────────
  {
    const s = buildNext();
    s.__setFrames(SYNTH([], { retarget: 0, strip: 0, retargetOccurrences: 0, stripOccurrences: 0 }));
    await s.runBrokenLinksPlan('articles');
    const st = s.__state();
    assert(st.pendingPlan === null,
      '/next broken links: an empty plan is NOT stored either (the unreported half of the defect)',
      JSON.stringify(st.pendingPlan));
    assert(st.banner && st.banner.tone === 'info' && /nothing was written/i.test(st.banner.text),
      '/next broken links: informational, and says the wiki is unchanged', JSON.stringify(st.banner));
    assert(s.__calls.length === 1, '/next broken links: no apply attempted', String(s.__calls.length));
  }

  // ── (a4) a done frame with NO plan key takes the same branch ─────────────
  // `!result.plan.length` on a bare read throws TypeError here; the fix reads
  // through Array.isArray so a malformed done frame degrades to the notice.
  {
    const s = buildNext();
    s.__setFrames([{ type: 'done', summary: { orphans: 2 } }]);
    await s.runOrphansPlan('articles');
    const st = s.__state();
    assert(st.pendingPlan === null && st.banner && st.banner.tone === 'info',
      '/next: a done frame carrying no plan[] at all degrades to the notice, not a crash',
      JSON.stringify(st.banner));
  }

  // ── (a5) honesty: "the AI declined" vs "the AI never answered" ───────────
  {
    const s = buildNext();
    s.__setFrames(SYNTH([], { rescuable: 0, noHome: 3, orphans: 3 }, 2));
    await s.runOrphansPlan('articles');
    const t = (s.__state().banner || {}).text || '';   // see the defensive-read note above
    assert(/did not answer/i.test(t) && /2 batches/.test(t),
      '/next: when every AI batch failed, the message says the AI did not answer', t);
    assert(!/no confident home/i.test(t),
      '/next: and does NOT assert a judgement the model never made', t);
    assert(/unchanged/i.test(t), '/next: and states the wiki is unchanged', t);
  }

  // ── (a6) the SECOND layer: applyPendingPlan itself refuses an empty plan ─
  // Independent of (a1): `state` is module-scoped and outlives the view, so a
  // pendingPlan can arrive here from a run the user has already left behind.
  // Asserted separately rather than trusting layer 1 to cover it — v3.4.0
  // records two guards that each stayed green because the other masked them.
  {
    const s = buildNext();
    s.__setPending({ kind: 'orphans', plan: [], summary: { orphans: 3 } });
    await s.applyPendingPlan('articles');
    assert(s.__calls.length === 0,
      '/next: applyPendingPlan sends NOTHING for an empty plan — no POST, no file lock, no spend',
      JSON.stringify(s.__calls));
    const st = s.__state();
    assert(st.banner && st.banner.tone === 'info',
      '/next: and it is not a SILENT no-op — the user is told why nothing happened',
      JSON.stringify(st.banner));
    assert(st.pendingPlan === null, '/next: the dead plan is discarded', JSON.stringify(st.pendingPlan));
  }

  // ── (b) /old — behavioural, real source ──────────────────────────────────
  const oldSrc = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const oldBodies = ['function renderBrokenLinkPreview(', 'function renderOrphanPreview(']
    .map((n) => grab(oldSrc, n));
  assert(oldBodies.every((b) => b && b.length > 200),
    'PRECONDITION: both /old preview renderers extracted from real source',
    oldBodies.map((b) => b.length).join(','));

  function buildOld() {
    // querySelector returns a listener-accepting stub: the NON-empty control
    // path wires click handlers, and a null here would make that control fail
    // for a reason unrelated to what it is testing.
    const el = () => ({ innerHTML: '', classList: { add() {}, remove() {} },
      querySelector: () => ({ addEventListener() {} }) });
    const preamble = `
      let _blPlan = null, _orphPlan = null;
      const blProgress = __el.blProgress, blResults = __el.blResults;
      const orphProgress = __el.orphProgress, orphResults = __el.orphResults;
      const formatHealthCost = () => '$0.0000';
      // Mirrors the real module-scope constants in app.js. Deliberately NOT
      // copies of the sentences: §9 asserts the real strings; here they only
      // need to exist so the renderers evaluate.
      const GIT_UNDO_NOTE = '<<NOTE>>';
      const GIT_UNDO_WARN = '<<WARN>>';
      const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    `;
    const els = { blProgress: el(), blResults: el(), orphProgress: el(), orphResults: el() };
    const api = `return { renderBrokenLinkPreview, renderOrphanPreview,
      __setBl: (p) => { _blPlan = p; }, __setOrph: (p) => { _orphPlan = p; } };`;
    const s = new Function('__el', preamble + oldBodies.join('\n\n') + '\n' + api)(els);
    s.__el = els;
    return s;
  }

  // ── (b1) the silent dead button ─────────────────────────────────────────
  {
    const s = buildOld();
    s.__setBl([]);
    s.renderBrokenLinkPreview({ retarget: 0, strip: 0, retargetOccurrences: 0, stripOccurrences: 0,
      deterministic: 0, ai: 0 }, {}, 0);
    const html = s.__el.blResults.innerHTML;
    assert(!/Apply/.test(html),
      '/old broken links: an empty plan renders NO Apply button (it used to render a dead one saying "fix 0 broken links")',
      html.slice(0, 200));
    assert(/nothing was written/i.test(html) && /unchanged/i.test(html),
      '/old broken links: it says plainly that nothing happened', html.slice(0, 200));
  }
  // ── (b2) CONTROL — a real plan still renders the Apply button ────────────
  {
    const s = buildOld();
    s.__setBl([{ linkText: 'a', action: 'strip', target: null, occurrences: 2 }]);
    s.renderBrokenLinkPreview({ retarget: 0, strip: 1, retargetOccurrences: 0, stripOccurrences: 2,
      deterministic: 0, ai: 1 }, {}, 0);
    const html = s.__el.blResults.innerHTML;
    assert(/broken-links-apply-btn/.test(html),
      'CONTROL /old broken links: a real plan still offers Apply', html.slice(0, 200));
  }
  // ── (b3) /old orphans was ALREADY right — pin it so it stays right ───────
  {
    const s = buildOld();
    s.__setOrph([]);
    s.renderOrphanPreview({ rescuable: 0, noHome: 3, orphans: 3 }, {}, 0);
    const html = s.__el.orphResults.innerHTML;
    assert(/no confident home/i.test(html) && /manual review/i.test(html),
      '/old orphans: the correct v3.0.1-beta.17 message is preserved (this is what /next was missing)',
      html.slice(0, 200));
    assert(!/Apply/.test(html), '/old orphans: and no Apply button', html.slice(0, 200));
  }
  // ── (b4) the same honesty fix in /old ───────────────────────────────────
  {
    const s = buildOld();
    s.__setOrph([]);
    s.renderOrphanPreview({ rescuable: 0, noHome: 3, orphans: 3 }, {}, 2);
    const html = s.__el.orphResults.innerHTML;
    assert(/did not answer/i.test(html) && !/no confident home/i.test(html),
      '/old orphans: an all-batches-failed run no longer claims the AI made a judgement', html.slice(0, 200));
  }

  // ── (b5) THE WIRING, not just the renderer ──────────────────────────────
  // FOUND BY A MUTATION THAT STAYED GREEN, and closed rather than filed.
  // Deleting `orphBatchErrors++` from /old's SSE loop left the suite at
  // 239 passed / 0 failed: (b4) hands `batchErrors` to renderOrphanPreview as an
  // ARGUMENT, so it proves the renderer branches correctly and proves nothing
  // about whether anything ever counts. The frame could stop being counted, the
  // renderer would be handed 0 forever, and an all-batches-failed run would go
  // back to claiming "The AI found no confident home" — a judgement no model
  // made. That is this repo's dead-data shape with the halves reversed: a reader
  // that works, wired to a producer nobody checks.
  //
  // /next did not have this hole — §(a4) drives the real runOrphansPlan over
  // synthetic frames — so this is /old-only, and it is here because the two
  // frontends must be held to the same standard.
  //
  // The planners are driven over a stubbed fetch that emits REAL SSE bytes
  // (`data: {...}\n\n`), so the frame parsing, the buffer splitting and the
  // counting are all exercised; only the network and the DOM are stubbed. The
  // renderers are replaced with recorders — what is asserted is the ARGUMENT
  // they receive, which is precisely the wiring (b1)–(b4) cannot see.
  {
    const planners = ['async function runBrokenLinkPlan(', 'async function runOrphanPlan(']
      .map((n) => grab(oldSrc, n));
    assert(planners.every((b) => b && b.length > 400),
      'PRECONDITION: both /old plan runners extracted from real source',
      planners.map((b) => b.length).join(','));

    function buildOldPlanners(frames) {
      const seen = { bl: null, orph: null };
      const el = () => ({ innerHTML: '', textContent: '', style: {},
        classList: { add() {}, remove() {} },
        querySelector: () => ({ style: {}, textContent: '', addEventListener() {} }) });
      const els = { blProgress: el(), blResults: el(), orphProgress: el(), orphResults: el(), blBtn: el() };
      const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
      const preamble = `
        let _blPlan = null, _orphPlan = null, _blBusy = false, _orphBusy = false;
        const _healthDomain = 'articles';
        const blProgress = __x.els.blProgress, blResults = __x.els.blResults, blBtn = __x.els.blBtn;
        const orphProgress = __x.els.orphProgress, orphResults = __x.els.orphResults;
        const healthStatusEl = __x.els.blResults;
        const document = { getElementById: () => ({ classList: { add(){}, remove(){} }, scrollIntoView(){} }) };
        const showStatus = () => {};
        // Recorders. The third argument IS the assertion target.
        const renderBrokenLinkPreview = (s, c, n) => { __x.seen.bl = n; };
        const renderOrphanPreview = (s, c, n) => { __x.seen.orph = n; };
        const fetch = async () => ({ ok: true, body: { getReader: () => {
          let sent = false;
          return { read: async () => sent ? { done: true } :
            (sent = true, { done: false, value: new TextEncoder().encode(__x.body) }) };
        } } });
      `;
      const api = 'return { runBrokenLinkPlan, runOrphanPlan };';
      const ctx = { els, seen, body };
      return { fns: new Function('__x', preamble + planners.join('\n\n') + '\n' + api)(ctx), seen };
    }

    {
      const h = buildOldPlanners([
        { type: 'start', total: 4 },
        { type: 'batch-error', batch: 0, error: 'boom' },
        { type: 'batch-error', batch: 1, error: 'boom' },
        { type: 'done', plan: [], summary: { rescuable: 0, orphans: 3 }, cost: {} },
      ]);
      await h.fns.runOrphanPlan();
      assert(h.seen.orph === 2,
        '/old orphans: batch-error frames are COUNTED off the wire and reach the renderer (not merely handled once there)',
        `renderer received ${h.seen.orph}`);
      await h.fns.runBrokenLinkPlan();
      assert(h.seen.bl === 2,
        '/old broken links: same — the count is produced by the SSE loop, not assumed',
        `renderer received ${h.seen.bl}`);
    }
    // CONTROL: with no batch-error frames the count is 0, so the assertion
    // above cannot be satisfied by a recorder that simply never changes.
    {
      const h = buildOldPlanners([
        { type: 'done', plan: [], summary: { rescuable: 0, orphans: 3 }, cost: {} },
      ]);
      await h.fns.runOrphanPlan();
      await h.fns.runBrokenLinkPlan();
      assert(h.seen.orph === 0 && h.seen.bl === 0,
        'CONTROL: a clean run reports zero failed batches (the counter is not stuck)',
        `orph=${h.seen.orph} bl=${h.seen.bl}`);
    }
  }

  // ── (c) the route KEEPS its 400 — deliberately, as a backstop ────────────
  // Decision recorded here because a future reader will ask why the frontends
  // and the route both handle this. Letting an empty plan through would mean
  // taking the domain's file lock and write registration to emit a done frame
  // of zeros, which both frontends would render as a completed fix that never
  // ran — trading an unactionable error for a quiet untruth. The refusal stays;
  // what changed is that it now reads like English, and that no frontend can
  // reach it.
  const routerMod2 = await import('../src/routes/health.js');
  const applyLayer = (p) => routerMod2.default.stack.find(
    (l) => l.route && l.route.path === p && l.route.methods.post);
  const drive400 = async (p, body) => {
    const layer = applyLayer(p);
    let code = 200, out = null;
    const res = { setHeader() {}, flushHeaders() {}, status(c) { code = c; return this; },
      json(b) { out = b; return this; }, write() {}, end() {} };
    await layer.route.stack[layer.route.stack.length - 1].handle(
      { params: { domain: 'emptyplan' }, body }, res, () => {});
    return { code, out };
  };
  mkDomain('emptyplan', { 'entities/a.md': '# A\n' });
  for (const p of ['/:domain/orphans/apply', '/:domain/broken-links/apply']) {
    const empty = await drive400(p, { plan: [] });
    const missing = await drive400(p, {});
    assert(empty.code === 400, `${p}: an empty plan is still refused (backstop kept)`, JSON.stringify(empty));
    assert(!/plan\[\]/.test(empty.out.error),
      `${p}: the refusal is no longer an internal assertion ("Missing plan[] to apply")`, empty.out.error);
    assert(/nothing to apply/i.test(empty.out.error) && /nothing was written/i.test(empty.out.error),
      `${p}: it reads as English and states no write occurred`, empty.out.error);
    assert(missing.code === 400 && missing.out.error !== empty.out.error,
      `${p}: a MISSING plan and an EMPTY plan are distinguished, not merged into one message`,
      `missing=${missing.out.error} empty=${empty.out.error}`);
    assert(!existsSync(path.join(ROOT, 'emptyplan', '.write-lock')),
      `${p}: the refusal happens BEFORE the file lock is taken (no lock left behind)`);
  }
}

// ── 9. CLASS INVARIANT — the app may not promise a control it does not have ──
console.log('\n9. no user-facing string may claim a revert/undo control that does not exist');
{
  // ── THE DEFECT ───────────────────────────────────────────────────────────
  // The Health action bar said, directly above the buttons that delete pages:
  //
  //     "Every AI action shows its cost before it runs.
  //      All changes are git-tracked and revertable from Sync."
  //
  // The second sentence is FALSE. COUNTED with the detector below against
  // `git show HEAD:` rather than by reading: SIX executable claims in /old, SIX
  // in /next, and TWO more in src/public/index.html — fourteen, not the
  // "thirteen" an earlier draft of this comment asserted from a hand count.
  // Twelve are fixed here; index.html is not this change's file and is reported
  // to the orchestrator instead (see NOT ENFORCED at the end of this section).
  // There is no revert. §(a) below proves it from the router itself
  // rather than asserting it, so that if a revert endpoint is ever added this
  // invariant fails and points at the copy that should be updated — the premise
  // is pinned, not assumed.
  //
  // Written as a CLASS rather than as fourteen string fixes: the false claim
  // reached fourteen places by being copy-pasted between neighbouring hints, so
  // fourteen corrections would leave the fifteenth free to be pasted in
  // tomorrow. This fails on the CLAIM, in any wording, anywhere in either
  // frontend — and the one instance a hand count missed was found by the
  // rebuilt detector, not by a reviewer.

  // ── (a) PREMISE, measured: the sync router has no revert-shaped route ────
  const syncRouter = (await import('../src/routes/sync.js')).default;
  const syncPaths = syncRouter.stack.filter((l) => l.route).map((l) => l.route.path);
  assert(syncPaths.length > 0, 'PRECONDITION: the sync router exposes routes at all', JSON.stringify(syncPaths));
  const revertish = syncPaths.filter((p) => /revert|discard|restore|undo|rollback|checkout/i.test(p));
  assert(revertish.length === 0,
    'the sync router really has NO revert/discard/restore/undo route — the premise of this section',
    JSON.stringify(syncPaths));

  // ── (b) neither frontend claims otherwise, in executable code ───────────
  // Comments are stripped first (and the strip is controlled below), because
  // the fix deliberately leaves long explanatory comments that use the word
  // "revert" to say the control does not exist.
  const stripComments9 = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const NOTE = 'If you use GitHub Sync, changes can be undone with a git client — the app has no Undo button yet.';
  const WARN = 'There is no Undo button in the app. If you use GitHub Sync this is recoverable with a git client; otherwise it cannot be undone.';

  // The claim, in any of the phrasings the codebase actually used:
  //   "revertable from Sync" / "can be reverted from Sync" / "revert from the
  //   Sync tab" / "revert it" next to Sync. Matched as "a revert word within a
  //   short distance of Sync", which is wording-independent.
  //
  // THE DETECTOR WAS DECORATIVE FOR ONE LIVE INSTANCE AND IS REBUILT HERE.
  // Its first version used `[^.<>]{0,80}` as the gap and listed `undo` in only
  // ONE of its two directions. Both choices had a reason and both were wrong:
  //   • excluding `<` and `>` was meant to stop a match running across markup,
  //     but these are HTML-emitting template literals, so a tag BETWEEN the two
  //     words is the normal case, not the exotic one; and
  //   • the reverse direction omitted `undo`, so "Sync … undo" read as clean.
  // Together they let this survive, green, in /old's batch-merge confirm — the
  // single most destructive control in the shipping app, which DELETES pages:
  //     "If you use GitHub Sync, you can undo it from the
  //      <strong>Sync</strong> tab if anything looks wrong."
  // Found by reading the two files rather than by trusting this section. The
  // gap now accepts a WHOLE TAG as one unit (`<[^<>]{0,40}>`) while still
  // refusing a bare `<` or `>`, so it crosses markup without running away, and
  // both directions carry the full verb set. Control (d) pins that exact
  // sentence so the regression cannot come back silently.
  const VERB9 = '(?:revert(?:able|ed|ing)?|undo|discard|roll ?back)';
  const GAP9 = '(?:[^.<>]|<[^<>]{0,40}>){0,90}?';
  const CLAIM = new RegExp(`\\b${VERB9}\\b${GAP9}\\bSync\\b|\\bSync\\b${GAP9}\\b${VERB9}\\b`, 'i');

  // The two HONEST sentences are removed before scanning, and this is
  // load-bearing rather than a convenience: NOTE itself reads
  // "…GitHub Sync, changes can be undone … the app has no Undo button yet",
  // which is a verb near Sync and therefore matches the detector. Without the
  // scrub the invariant is UNSATISFIABLE — every honest fix would red it, and
  // the only way back to green would be to weaken the regex until it missed
  // real claims again. Control (d) proves the scrub does real work by asserting
  // NOTE matches before it and not after.
  //
  // Deliberate consequence, not a side effect: a NEW sentence that paraphrases
  // the honest copy instead of interpolating GIT_UNDO_NOTE / GIT_UNDO_WARN will
  // fail here. That is the enforcement — thirteen copies of a false sentence is
  // how this defect happened, and thirteen copies of a true one is how the next
  // one would.
  const scrubHonest = (src) => [NOTE, WARN].reduce((s, h) => s.split(h).join(' [honest-copy] '), src);
  const frontends = [
    { label: '/old (src/public/app.js)', file: '../src/public/app.js' },
    { label: '/next (src/public/next/views/domains.js)', file: '../src/public/next/views/domains.js' },
  ];
  for (const f of frontends) {
    const raw = readFileSync(new URL(f.file, import.meta.url), 'utf8');
    const code = scrubHonest(stripComments9(raw));
    // CONTROL: the stripper works on THIS file. Both files carry the word
    // "revert" only inside the v3.9.1 explanatory comments now, so if the
    // stripper no-ops the assertion below fails for a real reason.
    assert(/never has/i.test(raw) && !/never has/i.test(code),
      `CONTROL: comments really are stripped from ${f.label}`,
      `before=${/never has/i.test(raw)} after=${/never has/i.test(code)}`);
    const hit = code.match(CLAIM);
    assert(!hit, `${f.label}: no executable string promises a revert from Sync`,
      hit ? JSON.stringify(hit[0]) : '');
  }

  // ── (c) and the honest wording IS present in both ───────────────────────
  // Removing the claim by deleting the sentence would satisfy (b) while leaving
  // the user with no idea what recovery exists. The replacement is CONDITIONAL
  // on GitHub Sync on purpose: `.knowledge-git` is created by sync setup and by
  // nothing else, so a user who never configured it has no history at all, and
  // an unconditional "it's git-tracked" would be the same false comfort in a
  // new coat.
  const nextRaw = readFileSync(new URL('../src/public/next/views/domains.js', import.meta.url), 'utf8');
  const oldRaw = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  // NOTE / WARN are declared once, above (b), because the detector's scrub
  // needs them too — two copies here and there is the drift this whole section
  // exists to forbid.
  for (const [label, src] of [['/next', nextRaw], ['/old', oldRaw]]) {
    assert(src.includes(NOTE), `${label}: carries the honest informational wording`);
    assert(src.includes(WARN), `${label}: carries the honest destructive-action wording`);
    assert(/no Undo button/.test(src), `${label}: says plainly that the app has no Undo button`);
  }
  // The one place /next must inline WARN rather than reference the constant
  // (test-next-semantic-gate.js's sandbox has a fixed const allow-list this
  // release does not own) must stay BYTE-IDENTICAL to the constant, or the two
  // drift into disagreeing about what recovery exists.
  const inlineCount = nextRaw.split(WARN).length - 1;
  assert(inlineCount >= 2,
    '/next: the semantic-merge confirm inlines the SAME sentence as GIT_UNDO_WARN, byte-for-byte',
    `occurrences=${inlineCount}`);
  assert(new RegExp('const GIT_UNDO_WARN = \'' + WARN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\'').test(nextRaw),
    '/next: GIT_UNDO_WARN is the source that copy must match');

  // ── (d) NEGATIVE CONTROL — the detector can actually fire ───────────────
  // Without this, a CLAIM regex that matched nothing (a stray escape, a typo)
  // would report every assertion above as green while checking nothing. This is
  // the shape v3.0.15's CSS-token baseline and v3.1.0's null-safety lexer both
  // shipped in.
  const planted = 'x = "All changes are git-tracked and revertable from Sync."; ';
  assert(CLAIM.test(planted), 'CONTROL: the detector fires on the exact removed sentence', planted);
  assert(CLAIM.test('y = "if anything looks wrong, revert from the Sync tab before pushing";'),
    'CONTROL: it fires on the other phrasing this codebase used');
  // THE ONE THAT WAS MISSED. A tag between the verb and "Sync", and the verb on
  // the far side of it — the shape that sat green in /old's page-deleting
  // batch-merge confirm until v3.9.1. Pinned verbatim: if either the tag-aware
  // gap or `undo` in the reverse direction is ever removed, this control fails
  // and names the sentence, instead of the suite quietly going back to blind.
  const missedShape = 'If you use GitHub Sync, you can undo it from the <strong>Sync</strong> tab if anything looks wrong.';
  assert(CLAIM.test(missedShape),
    'CONTROL: it fires ACROSS an HTML tag, and on "Sync … undo" (the instance the first detector missed)',
    missedShape);
  // The scrub is a mechanism, not a formality: NOTE itself is a verb near
  // "Sync", so it matches the raw detector. Asserting BOTH halves proves the
  // scrub is doing real work — a no-op scrub would make the first of these
  // fail, and a detector too weak to see NOTE would make it fail too.
  assert(CLAIM.test('z = "' + NOTE + '";'),
    'CONTROL: the honest NOTE *does* match the raw detector — which is why the scrub exists', NOTE);
  assert(!CLAIM.test(scrubHonest('z = "' + NOTE + '";')),
    'CONTROL: and does NOT fire once the honest copy is scrubbed (otherwise it would be unsatisfiable)', NOTE);
  assert(!CLAIM.test(scrubHonest('z = "' + WARN + '";')),
    'CONTROL: nor on the scrubbed destructive-action wording', WARN);
  assert(!CLAIM.test('w = "Go to Sync to push the cleanup.";'),
    'CONTROL: nor on an ordinary mention of Sync');

  // ── NOT ENFORCED, stated rather than implied ────────────────────────────
  //   • Only these two files are scanned. src/public/index.html carries the
  //     same false claim twice (lines ~845, ~869, the AI-tool confirm modals)
  //     and is NOT owned by this release's change — it is reported, not fixed,
  //     and this suite would not catch a fifteenth instance appearing there.
  //   • The regex is a proximity heuristic over source text. A claim split
  //     across a template-literal boundary, built from concatenated fragments,
  //     or worded without either "revert" or "Sync" evades it.
  //   • Nothing here proves the honest sentence is RENDERED — only that it is
  //     in the source. Same limit §7 records for its reader scan.
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(48)}`);
console.log(`beta.16 offline: ${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); failures.forEach(f => console.log('  • ' + f)); process.exit(1); }
console.log('All green ✓');
