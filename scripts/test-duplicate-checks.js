#!/usr/bin/env node
/**
 * scripts/test-duplicate-checks.js — OFFLINE
 *
 * "Find duplicate pages" on a large domain: a scan checked the top 500 pairs,
 * forgot its answers, showed no progress, and let a look-alike pair reach a
 * page-deleting batch merge. Measured on a 3,407-page domain: 36,333 candidates,
 * 460 of the next scan's 500 already judged and billed again.
 *
 * ── WHAT THIS PINS ────────────────────────────────────────────────────────
 *   1. The spelling-variant test, including the shapes that must stay OUT of a
 *      batch that deletes pages (gpt-4-1 / gpt-41, new / news).
 *   2. Candidates: spelling variants and acronyms exist and rank first, in
 *      linear passes; a dumb O(N²) cross-check agrees with the clever index.
 *   3. A second scan sends only new pairs; an unchanged wiki with nothing left
 *      makes ZERO LLM calls; a `yes` returns free.
 *   4. A changed opening, a changed model re-check; an edit below the opening does not.
 *   5. Only an explicit answer for a valid index is remembered.
 *   6. An interrupted scan keeps earlier batches (read back DURING the scan).
 *   7. Estimate and ceiling count only what will be sent.
 *   8. Reset forgets one domain's answers and keeps dismissals.
 *   9. The server refuses an ineligible batch pair, whatever the client claims.
 *  10. A real scan writes nothing under domains/.
 *  11. No file, a corrupt file, a wrong-shape file: a first scan, never a crash.
 *  12. The MCP tool reports coverage.
 *
 * ── METHOD ────────────────────────────────────────────────────────────────
 * Real on-disk fixtures, real exported functions, a fake LLM through the
 * `opts.generateText` seam. Isolated with CURATOR_TEST_USER_DATA_DIR +
 * CURATOR_TEST_DOMAINS_DIR, set before any app module loads, plus a fake
 * provider key in the environment that no call ever uses.
 *
 * ── NOT ENFORCED ──────────────────────────────────────────────────────────
 *   • Whether a real model judges pairs well. The prompt rule's effect is the
 *     orchestrator's live measurement.
 *   • The view: scripts/test-next-semantic-gate.js and the browser walk.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USER_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-dupchecks-user-'));
const DOMAINS_DIR = mkdtempSync(path.join(os.tmpdir(), 'curator-dupchecks-domains-'));
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DIR;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
process.env.GEMINI_API_KEY = 'fake-key-never-sent';
process.env.LLM_PROVIDER = 'gemini';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.LLM_MODEL;

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS_DIR);
const dc = await import(path.join(REPO, 'src/brain/duplicate-checks.js'));
const health = await import(path.join(REPO, 'src/brain/health.js'));
const ai = await import(path.join(REPO, 'src/brain/health-ai.js'));
const { addDismissal, loadDismissed } = await import(path.join(REPO, 'src/brain/health-dismissed.js'));
const { getDuplicateChecksDir } = await import(path.join(REPO, 'src/brain/paths.js'));

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

let seq = 0;
function mkDomain(files) {
  const name = 'dup' + (++seq);
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(wiki, rel), body);
  return { name, wiki };
}
const page = (title, opening = `About ${title}.`) => `---\ntype: concept\n---\n\n# ${title}\n\n${opening}\n\n## Key Facts\n\n- a fact\n`;

/** Parses the PAIRS out of a batch prompt, the way a provider would see them. */
function pairsIn(userPrompt) {
  const out = [];
  const re = /--- PAIR (\d+) ---\nA: \[([^\]]+)\]\n[\s\S]*?\nB: \[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(userPrompt))) out.push({ index: Number(m[1]), a: m[2], b: m[3] });
  return out;
}

/**
 * A fake LLM. `decide(pair)` returns one result's fields, or null to leave that
 * pair out of the reply. Records every pair it was sent.
 */
function fakeLLM(decide = () => ({ relation: 'different', difference: 'unrelated' })) {
  const fn = async (sys, user, maxTokens) => {
    fn.calls++;
    fn.system = sys;
    fn.user = user;
    fn.maxTokens = maxTokens;
    const pairs = pairsIn(user);
    fn.sent.push(...pairs.map((p) => p.a + ' + ' + p.b));
    const results = [];
    for (const p of pairs) {
      const r = decide(p);
      if (r) results.push({ index: p.index, canonicalSlug: p.a.split('/')[1], rationale: 'because', ...r });
    }
    return JSON.stringify({ results });
  };
  fn.calls = 0;
  fn.sent = [];
  return fn;
}
const yesAll = (confidence = 'high') => () => ({ relation: 'same', difference: 'none', confidence });
const scan = async (name, llm, opts = {}) => {
  const events = [];
  const out = await ai.scanSemanticDuplicates(name, { maxPairs: 500, costCeilingTokens: 10_000_000, generateText: llm, ...opts }, (e) => events.push(e));
  return { ...out, events, start: events.find((e) => e.type === 'start'), done: events.find((e) => e.type === 'done') };
};
const treeHash = (dir) => {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const full = path.join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else { h.update(path.relative(dir, full)); h.update(readFileSync(full)); }
    }
  };
  walk(dir);
  return h.digest('hex');
};
const checksFile = (name) => path.join(getDuplicateChecksDir(), encodeURIComponent(name) + '.json');

// ═══════════════════════════════════════════════════════════════════════════
section('1. The spelling-variant test');
{
  const yes = [
    ['hand-off', 'handoff'], ['e-mail', 'email'], ['open_ai', 'openai'], ['neural-network', 'neural-networks'],
    ['class-index', 'class-indexes'], ['data-box', 'data-boxes'], ['quorum-ledger-0', 'quorum_ledger_0'],
    ['covid-19', 'covid19'], ['Hand-Off', 'handoff'], ['gpt-4-1', 'gpt_4_1'],
  ];
  for (const [a, b] of yes) {
    ok(dc.isSpellingVariant(a, b), `1. ${a} / ${b} is a spelling variant`);
    ok(dc.isSpellingVariant(b, a), `1. …and in the other order`);
  }
  const no = [
    // The measured wrong "high" pairs: the point of this test.
    ['transaction-costs-of-ai', 'transportation-sector-ai'], ['gemini', 'gemini-3.1-flash-lite'], ['context', 'contextual-outcomes'],
    // A separator between digits is part of the name.
    ['gpt-4-1', 'gpt-41'], ['claude-3-5', 'claude-35'],
    // A dot is not a separator.
    ['gemini-2.5', 'gemini-25'],
    // Not plurals, though they look like it.
    ['new', 'news'], ['clas', 'class'], ['iphone-14', 'iphone-14s'], ['do', 'does'],
    ['rag', 'retrieval-augmented-generation'], ['same', 'same'],
  ];
  for (const [a, b] of no) ok(!dc.isSpellingVariant(a, b), `1. ${a} / ${b} is NOT a spelling variant`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. Candidates: variants and acronyms exist and rank first');
{
  // Fillers that crowd the ranking the way a large wiki does: near-identical
  // names whose biased JW score beats a plural's token score.
  const files = {
    'concepts/neural-network.md': page('Neural network'),
    'concepts/neural-networks.md': page('Neural networks'),
    'concepts/rag.md': page('RAG'),
    'concepts/retrieval-augmented-generation.md': page('Retrieval-augmented generation'),
  };
  for (let i = 0; i < 40; i++) files[`concepts/zebrafish-migration-study-${String.fromCharCode(97 + (i % 26))}${i}.md`] = page('Filler ' + i);
  const d = mkDomain(files);
  const { pairs } = await health.findSemanticCandidatePairs(d.name, 1_000_000);
  const key = (p) => [p.slugA, p.slugB].sort().join(' + ');
  const keys = pairs.map(key);
  ok(keys[0] === 'neural-network + neural-networks', '2.1 the plural ranks first', keys.slice(0, 3).join(' | '));
  ok(keys[1] === 'rag + retrieval-augmented-generation', '2.2 the acronym is a candidate, and ranks right behind', keys.slice(0, 3).join(' | '));
  const scores = pairs.map((p) => p.score);
  ok(scores.every((s, i) => i === 0 || s <= scores[i - 1]), '2.3 the list still reads in non-increasing score order');
  ok(pairs.length > 100, `2.4 CONTROL — the fillers really did produce competing pairs (${pairs.length})`);

  // A variant neither earlier pass can see (case hides it from both) is only
  // found after the acronym pass, so insertion order alone would put it second.
  const tiers = mkDomain({ 'concepts/abc.md': page('ABC'), 'concepts/apple-banana-cherry.md': page('ABC long'),
    'concepts/ZETA-FOO-BAR.md': page('Zeta upper'), 'concepts/zetafoobar.md': page('Zeta lower') });
  const tierKeys = (await health.findSemanticCandidatePairs(tiers.name, 1_000_000)).pairs.map(key);
  ok(tierKeys[0] === ['ZETA-FOO-BAR', 'zetafoobar'].sort().join(' + ') && tierKeys[1] === 'abc + apple-banana-cherry',
    '2.3b spelling variants outrank acronyms by tier, not by the order they were found', tierKeys.join(' | '));

  // Dumb cross-check of the clever index: every pair of a mixed name list,
  // tested the slow way, must match what the linear index returns.
  const names = ['hand-off', 'handoff', 'hand_off', 'Hand-Off-s', 'window', 'windows', 'class', 'classes', 'box', 'boxes',
    'gpt-4-1', 'gpt-41', 'gpt_4_1', 'new', 'news', 'iphone-14', 'iphone-14s', 'alpha-beta', 'alphabeta', 'alpha-betas'];
  const slow = new Set();
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    if (dc.isSpellingVariant(names[i], names[j])) slow.add(`${i}|${j}`);
  }
  const fast = new Set(dc.spellingVariantIndexPairs(names).map(([i, j]) => `${i}|${j}`));
  ok(slow.size === fast.size && [...slow].every((k) => fast.has(k)),
    `2.5 the linear index finds exactly what a slow all-pairs loop finds (${slow.size})`,
    `slow ${[...slow]} fast ${[...fast]}`);
  ok(slow.size >= 8, '2.6 CONTROL — the cross-check list really contains variants');

  const acr = dc.acronymIndexPairs(['rag', 'retrieval-augmented-generation', 'red-amber-green', 'ragged', 'wow', 'world-of-warcraft', 'ai', 'artificial-intelligence', 'r-a-g'], new Set(['of']));
  const named = new Set(acr.map(([i, j]) => i + '|' + j));
  ok(named.has('0|1') && named.has('0|2'), '2.7 every multi-word name with those initials pairs with the short name');
  ok(named.has('4|5'), '2.8 initials skip the small words (world-of-warcraft / wow)');
  ok(!named.has('6|7'), '2.9 two letters is too short to be evidence (ai)');
  ok(![...named].some((k) => k.includes('3')), '2.10 a longer word starting with the same letters is not an acronym');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. A second scan sends only new pairs; a yes returns free');
{
  const files = {
    'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff'),
    'concepts/data-pipeline.md': page('Data pipeline'), 'concepts/data-pipelines.md': page('Data pipelines'),
    'concepts/graph-store.md': page('Graph store'), 'concepts/graph-stores.md': page('Graph stores'),
  };
  const d = mkDomain(files);
  const decide = (p) => (p.a.includes('data-pipeline') ? { relation: 'same', confidence: 'high' } : { relation: 'overlap' });

  const first = fakeLLM(decide);
  const r1 = await scan(d.name, first, { maxPairs: 2 });
  ok(first.sent.length === 2, '3.1 the first scan sends the cap', String(first.sent.length));
  ok(r1.done.totalPairs >= 3 && r1.done.checkedPairs === 2 && r1.done.leftPairs === r1.done.totalPairs - 2,
    '3.2 done reports coverage', JSON.stringify(r1.done, ['totalPairs', 'checkedPairs', 'leftPairs']));
  ok(r1.start.candidatePairs === 2 && Number.isInteger(r1.start.totalPairs), '3.3 start carries what will be sent, and coverage');
  ok(r1.pairs.length === 1 && r1.pairs[0].spellingVariant === true && r1.pairs[0].remembered === false, '3.4 the found pair is new, and marked a spelling variant');

  const second = fakeLLM(decide);
  const r2 = await scan(d.name, second, { maxPairs: 2 });
  ok(!second.sent.some((s) => first.sent.includes(s)), '3.5 THE FIX — the second scan sends none of the first scan\'s pairs',
    JSON.stringify({ first: first.sent, second: second.sent }));
  ok(second.sent.length > 0, '3.6 CONTROL — it did send the pairs left over');
  ok(r2.pairs.some((p) => p.remembered === true && [p.keepSlug, p.removeSlug].includes('data-pipelines')),
    '3.7 the pair found earlier is listed again, marked remembered');
  ok(r2.done.rememberedPairs === 1, '3.8 …and counted');

  const third = fakeLLM(decide);
  const r3 = await scan(d.name, third);
  const fourth = fakeLLM(decide);
  const r4 = await scan(d.name, fourth);
  ok(fourth.calls === 0, '3.9 THE FIX — nothing left to send means zero LLM calls', String(fourth.calls));
  ok(r4.done.leftPairs === 0 && r4.done.checkedPairs === r4.done.totalPairs, '3.10 every pair is checked');
  ok(r4.pairs.length === r3.pairs.length && r4.pairs.length >= 1, '3.11 a found pair neither vanishes nor multiplies');
  ok(r4.done.spent.calls === 0 && r4.done.spent.usd === null, '3.12 no spend: spent is the nothing-ran shape');
  const rec = r4.pairs[0];
  const r5 = await scan(d.name, fakeLLM(decide));
  ok(r5.pairs[0].keepSlug === rec.keepSlug, '3.13 a remembered pair never flips direction between runs');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. What makes an answer stop applying');
{
  const long = 'A long opening about the same process. '.repeat(20); // past what the model reads
  const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff', long) });
  const opening = path.join(d.wiki, 'concepts/handoff.md');
  await scan(d.name, fakeLLM());

  // Below the opening: the model never read it.
  writeFileSync(opening, readFileSync(opening, 'utf8') + '\n- a later fact\n');
  const l0 = fakeLLM();
  await scan(d.name, l0);
  ok(l0.calls === 0, '4.1 CONTROL — an edit below what the model read does not re-check', String(l0.calls));

  writeFileSync(opening, page('Handoff', 'A completely different opening.'));
  const l1 = fakeLLM();
  await scan(d.name, l1);
  ok(l1.sent.length === 1, '4.2 a changed opening is checked again');

  const l2 = fakeLLM();
  await scan(d.name, l2);
  ok(l2.calls === 0, '4.3 …once');

  process.env.LLM_MODEL = 'gemini-2.5-flash';
  const l3 = fakeLLM();
  const r3 = await scan(d.name, l3);
  ok(l3.sent.length === 1, '4.4 a changed model is checked again', JSON.stringify(r3.done && r3.done.cost && r3.done.cost.model));
  delete process.env.LLM_MODEL;
  const l4 = fakeLLM();
  await scan(d.name, l4);
  ok(l4.sent.length === 1, '4.5 one record per pair: going back to the first model checks again');

  // Folder is part of identity.
  const k1 = dc.pairKey('entities', 'a', 'concepts', 'b');
  const k2 = dc.pairKey('concepts', 'a', 'concepts', 'b');
  ok(k1 !== k2, '4.6 the same slugs in other folders are a different pair');
  ok(dc.pairKey('concepts', 'b', 'entities', 'a') === k1, '4.7 either order is the same pair');
  ok(dc.openingsHash('concepts', 'b', 'x', 'entities', 'a', 'y') === dc.openingsHash('entities', 'a', 'y', 'concepts', 'b', 'x'),
    '4.8 …with the same openings hash');
  ok(dc.openingsHash('concepts', 'b', 'x', 'entities', 'a', 'y') !== dc.openingsHash('concepts', 'b', 'y', 'entities', 'a', 'x'),
    '4.9 CONTROL — swapping which page says what is a different hash');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. Only an explicit answer for a valid index is remembered');
{
  const reply = (fields) => async () => JSON.stringify({ results: [{ index: 0, difference: 'x', ...fields }] });
  const cases = [
    ['a thrown call', async () => { throw new Error('provider down'); }, 0],
    ['unparseable text', async () => 'not json at all', 0],
    ['a reply with no results array', async () => '{"foo": 1}', 0],
    ['an index out of range', async () => '{"results":[{"index":9,"relation":"different"}]}', 0],
    ['a missing relation', reply({ confidence: 'high', canonicalSlug: 'handoff' }), 0],
    ['an unknown relation', reply({ relation: 'similar', confidence: 'high', canonicalSlug: 'handoff' }), 0],
    ['a relation that is not a string', reply({ relation: true }), 0],
    ['same, with a canonical matching neither side', reply({ relation: 'same', confidence: 'high', canonicalSlug: 'something-else' }), 0],
    ['same, with no canonical', reply({ relation: 'same', confidence: 'high' }), 0],
    ['same, with a confidence that is not a confidence', reply({ relation: 'same', confidence: 'very', canonicalSlug: 'handoff' }), 0],
    ['part', reply({ relation: 'part' }), 1],
    ['version', reply({ relation: 'version' }), 1],
    ['overlap', reply({ relation: 'overlap' }), 1],
    ['different', reply({ relation: 'different' }), 1],
    ['same, low confidence', reply({ relation: 'same', confidence: 'low', canonicalSlug: 'handoff' }), 1],
    ['same, accepted', reply({ relation: 'same', confidence: 'medium', canonicalSlug: 'handoff' }), 1],
  ];
  for (const [label, llm, expected] of cases) {
    const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
    const r = await scan(d.name, llm);
    const size = (await dc.loadDuplicateChecks(d.name)).size;
    ok(size === expected, `5. ${label}: ${expected ? 'remembered' : 'nothing remembered'}`, `size ${size}`);
    ok(r.done.leftPairs === 1 - expected, `5. …and left says so`, String(r.done.leftPairs));
    if (['a thrown call', 'unparseable text', 'a reply with no results array'].includes(label)) {
      ok(r.done.failedPairs === 1, `5. …and ${label} counts as a failed batch, never as "nothing found"`, String(r.done.failedPairs));
      ok(r.events.some((e) => e.type === 'batch-error'), '5. …with a batch-error event');
    }
  }
  // Only "same" is a yes, however confident the rest of the answer sounds.
  const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  const r = await scan(d.name, reply({ relation: 'version', confidence: 'high', canonicalSlug: 'handoff', rationale: 'sure' }));
  ok(r.pairs.length === 0, '5.x a confident "version" is a no, never a merge candidate');
  const rec = [...(await dc.loadDuplicateChecks(d.name)).values()][0];
  ok(rec && rec.verdict === 'no', '5.y …and remembered as a no');
  const cased = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  const rCased = await scan(cased.name, reply({ relation: ' SAME ', confidence: 'High', canonicalSlug: 'handoff', rationale: 'why' }));
  ok(rCased.pairs.length === 1 && rCased.pairs[0].confidence === 'high', '5.y2 a relation in other case is still that relation');
  const noWhy = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  const rNoWhy = await scan(noWhy.name, reply({ relation: 'same', confidence: 'high', canonicalSlug: 'handoff', difference: 'none really' }));
  ok(rNoWhy.pairs[0].rationale === 'none really', '5.y3 a same with no rationale falls back to its difference');
  // Two answers for one index: the first stands, no double card.
  const d2 = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  const dup = '{"index":0,"relation":"same","confidence":"high","canonicalSlug":"handoff"}';
  const r2 = await scan(d2.name, async () => `{"results":[${dup},${dup}]}`);
  ok(r2.pairs.length === 1, '5.z a repeated index yields one pair');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. An interrupted scan keeps what it paid for');
{
  const files = {};
  for (let i = 0; i < 30; i++) {
    files[`concepts/pipeline-stage-${i}.md`] = page('Stage ' + i);
    files[`concepts/pipeline_stage_${i}.md`] = page('Stage alt ' + i);
  }
  const d = mkDomain(files);
  const seenOnDisk = [];
  const inner = fakeLLM();
  const llm = async (...args) => {
    seenOnDisk.push((await dc.loadDuplicateChecks(d.name)).size);
    return inner(...args);
  };
  let progressSeen = 0;
  let threw = false;
  try {
    await ai.scanSemanticDuplicates(d.name, { maxPairs: 60, costCeilingTokens: 10_000_000, generateText: llm }, (e) => {
      if (e.type === 'progress' && ++progressSeen === 2) throw new Error('process died here');
    });
  } catch { threw = true; }
  ok(threw, '6.1 precondition: the scan really stopped after batch 2');
  ok(JSON.stringify(seenOnDisk) === '[0,20]', '6.2 THE FIX — batch 1\'s answers were on disk before batch 2 was sent', JSON.stringify(seenOnDisk));
  const kept = await dc.loadDuplicateChecks(d.name);
  ok(kept.size === 40, '6.3 both finished batches survive the stop', String(kept.size));
  const resume = fakeLLM();
  await scan(d.name, resume);
  ok(resume.sent.length > 0 && !resume.sent.some((s) => inner.sent.slice(0, 40).includes(s)), '6.4 the next scan sends only pairs not answered yet', String(resume.sent.length));

  // A write that fails must not fail the scan.
  const d2 = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  mkdirSync(checksFile(d2.name), { recursive: true }); // a directory where the file belongs
  const r = await scan(d2.name, fakeLLM(yesAll()));
  ok(r.pairs.length === 1 && r.done, '6.5 a scan whose answers cannot be saved still reports them');
  ok(r.done.leftPairs === 0, '6.6 …and its figures for this run stay true');
  rmSync(checksFile(d2.name), { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. The estimate and the ceiling count only what will be sent');
{
  const files = {};
  for (let i = 0; i < 15; i++) {
    files[`concepts/ledger-node-${i}.md`] = page('Node ' + i);
    files[`concepts/ledger_node_${i}.md`] = page('Node alt ' + i);
  }
  const d = mkDomain(files);
  const e0 = await ai.estimateSemanticDuplicateScan(d.name, 10);
  ok(e0.candidatePairs === 10 && e0.truncated === true, '7.1 a fresh estimate is the cap');
  ok(e0.estimatedTokens === 10 * ai.EST_TOKENS_PER_PAIR, '7.2 …priced on what will be sent');
  ok(e0.totalPairs === e0.totalCandidates && e0.checkedPairs === 0 && e0.leftPairs === e0.totalPairs && e0.nextPairs === 10, '7.3 …with coverage');

  await scan(d.name, fakeLLM(), { maxPairs: e0.totalPairs - 3 });
  const e1 = await ai.estimateSemanticDuplicateScan(d.name, 10);
  ok(e1.candidatePairs === 3 && e1.truncated === false, '7.4 after a scan it counts only the three left', JSON.stringify([e1.candidatePairs, e1.truncated]));
  ok(e1.estimatedTokens === 3 * ai.EST_TOKENS_PER_PAIR, '7.5 …and prices only them');
  ok(e1.checkedPairs + e1.leftPairs === e1.totalPairs, '7.6 checked + left = total');

  // Exactly the ceiling for 3 pairs: passes now, though the WHOLE list would refuse.
  const passes = fakeLLM();
  const r = await scan(d.name, passes, { maxPairs: 10, costCeilingTokens: 3 * ai.EST_TOKENS_PER_PAIR });
  ok(passes.sent.length === 3 && r.done, '7.7 the ceiling is tested against what will be sent');

  const d2 = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  let code = null;
  try { await scan(d2.name, fakeLLM(), { costCeilingTokens: 1 }); } catch (err) { code = err.code; }
  ok(code === 'OVER_COST_CEILING', '7.8 CONTROL — over the ceiling still refuses');
  const e2 = await ai.estimateSemanticDuplicateScan(d.name, 10);
  ok(e2.candidatePairs === 0 && e2.leftPairs === 0 && e2.estimatedTokens === 0, '7.9 nothing left: nothing to price');
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. Reset forgets one domain and keeps dismissals');
{
  const files = { 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff'),
    'concepts/data-store.md': page('Data store'), 'concepts/data-stores.md': page('Data stores') };
  const a = mkDomain(files);
  const b = mkDomain(files);
  await scan(a.name, fakeLLM());
  await scan(b.name, fakeLLM());
  const dismissed = { slugA: 'data-store', folderA: 'concepts', slugB: 'data-stores', folderB: 'concepts' };
  await addDismissal(a.name, 'semanticDupe', dismissed);
  const dismissalFile = readFileSync(path.join(a.wiki, '.health-dismissed.jsonl'), 'utf8');

  await dc.forgetDuplicateChecks(a.name);
  ok((await dc.loadDuplicateChecks(a.name)).size === 0, '8.1 this domain\'s answers are gone');
  ok((await dc.loadDuplicateChecks(b.name)).size === 2, '8.2 another domain\'s are not');
  ok(readFileSync(path.join(a.wiki, '.health-dismissed.jsonl'), 'utf8') === dismissalFile && (await loadDismissed(a.name)).keys.size === 1, '8.3 dismissals stay');
  const after = fakeLLM();
  await scan(a.name, after);
  ok(after.sent.length === 1 && !after.sent[0].includes('data-store'), '8.4 the next scan starts over, and a skipped pair stays skipped', JSON.stringify(after.sent));
  await dc.forgetDuplicateChecks(a.name);
  await dc.forgetDuplicateChecks(a.name);
  ok(true, '8.5 forgetting twice is harmless');

  // Status: free, and does not derive the list when nothing is remembered.
  const none = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  const s0 = await ai.semanticScanStatus(none.name);
  ok(s0.hasChecks === false, '8.6 status with nothing remembered says so');
  const yes = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff'),
    'concepts/data-store.md': page('Data store'), 'concepts/data-stores.md': page('Data stores') });
  await scan(yes.name, fakeLLM((p) => (p.a.includes('hand') ? { relation: 'same', confidence: 'high' } : null)));
  const s1 = await ai.semanticScanStatus(yes.name);
  ok(s1.hasChecks === true && s1.pairs.length === 1 && s1.pairs[0].remembered === true, '8.7 status brings back a found pair');
  ok(s1.totalPairs === 2 && s1.checkedPairs === 1 && s1.leftPairs === 1 && s1.nextPairs === 1, '8.8 …and the true figures', JSON.stringify(s1));

  // The derived list must notice what changes it, though it is kept between calls.
  writeFileSync(path.join(yes.wiki, 'concepts/graph-node.md'), page('Graph node'));
  writeFileSync(path.join(yes.wiki, 'concepts/graph-nodes.md'), page('Graph nodes'));
  const s2 = await ai.semanticScanStatus(yes.name);
  ok(s2.totalPairs === 3, '8.9 a new page moves the figures', String(s2.totalPairs));
  await addDismissal(yes.name, 'semanticDupe', { slugA: 'graph-node', folderA: 'concepts', slugB: 'graph-nodes', folderB: 'concepts' });
  const s3 = await ai.semanticScanStatus(yes.name);
  ok(s3.totalPairs === 2, '8.10 a dismissal moves them', String(s3.totalPairs));
  rmSync(path.join(yes.wiki, 'concepts/handoff.md'));
  const s4 = await ai.semanticScanStatus(yes.name);
  ok(s4.pairs.length === 0 && s4.totalPairs === 1, '8.11 a page gone takes its pair with it', JSON.stringify([s4.pairs.length, s4.totalPairs]));
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. The server decides what a batch may delete');
{
  const fixture = () => mkDomain({
    'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff'),
    'concepts/gemini.md': page('Gemini'), 'concepts/gemini-flash.md': page('Gemini Flash'),
    'concepts/data-store.md': page('Data store'), 'concepts/data-stores.md': page('Data stores'),
    'concepts/graph-node.md': page('Graph node'), 'concepts/graph-nodes.md': page('Graph nodes'),
  });
  const VARIANT = { keepSlug: 'hand-off', keepFolder: 'concepts', removeSlug: 'handoff', removeFolder: 'concepts', confidence: 'high' };
  const LOOKALIKE = { keepSlug: 'gemini', keepFolder: 'concepts', removeSlug: 'gemini-flash', removeFolder: 'concepts', confidence: 'high' };
  const MEDIUM = { keepSlug: 'data-store', keepFolder: 'concepts', removeSlug: 'data-stores', removeFolder: 'concepts', confidence: 'high' };
  const UNCHECKED = { keepSlug: 'graph-node', keepFolder: 'concepts', removeSlug: 'graph-nodes', removeFolder: 'concepts', confidence: 'high' };
  const decide = (p) => {
    if (p.a.includes('data-store')) return { relation: 'same', confidence: 'medium' };
    if (p.a.includes('graph')) return null;
    return { relation: 'same', confidence: 'high' };
  };

  const d = fixture();
  await scan(d.name, fakeLLM(decide));
  const progress = [];
  const res = await health.fixSemanticDuplicatesBatch(d.name, [LOOKALIKE, MEDIUM, UNCHECKED, VARIANT], (p) => progress.push(p));
  const statusOf = (slug) => res.results.find((r) => r.removeSlug === slug);
  ok(statusOf('gemini-flash').status === 'ineligible' && statusOf('gemini-flash').reason === 'names-differ',
    '9.1 THE FIX — a "high" look-alike is refused, in its own bucket, though the client said high', JSON.stringify(statusOf('gemini-flash')));
  ok(statusOf('data-stores').status === 'ineligible' && statusOf('data-stores').reason === 'not-high-confidence',
    '9.2 the client\'s word for confidence is not read: this pair was answered medium', JSON.stringify(statusOf('data-stores')));
  ok(statusOf('graph-nodes').status === 'ineligible' && statusOf('graph-nodes').reason === 'not-high-confidence',
    '9.3 a pair nobody ever checked is refused', JSON.stringify(statusOf('graph-nodes')));
  ok(existsSync(path.join(d.wiki, 'concepts/gemini-flash.md')) && existsSync(path.join(d.wiki, 'concepts/data-stores.md')) && existsSync(path.join(d.wiki, 'concepts/graph-nodes.md')),
    '9.4 none of the three was deleted');
  ok(statusOf('handoff').status === 'merged' && !existsSync(path.join(d.wiki, 'concepts/handoff.md')), '9.5 CONTROL — the eligible pair merged');
  ok(res.ineligible === 3 && res.merged === 1 && res.merged + res.stale + res.skipped + res.ineligible + res.errors === res.total, '9.6 the buckets sum to total');
  ok(progress.filter((p) => p.status === 'ineligible').length === 3 && progress.length === 4, '9.7 every refusal is a progress frame too');

  // A Flip is honoured: the answer is about the pair.
  const f = fixture();
  await scan(f.name, fakeLLM(decide));
  const flip = await health.fixSemanticDuplicatesBatch(f.name, [{ keepSlug: 'handoff', keepFolder: 'concepts', removeSlug: 'hand-off', removeFolder: 'concepts' }]);
  ok(flip.merged === 1 && !existsSync(path.join(f.wiki, 'concepts/hand-off.md')), '9.8 a flipped pair still merges, in the flipped direction');

  // The page changed after the answer: the answer was about other text.
  const c = fixture();
  await scan(c.name, fakeLLM(decide));
  writeFileSync(path.join(c.wiki, 'concepts/handoff.md'), page('Handoff', 'Now about a football move, not a process.'));
  const changed = await health.fixSemanticDuplicatesBatch(c.name, [VARIANT]);
  ok(changed.results[0].status === 'ineligible' && changed.results[0].reason === 'page-changed', '9.9 a page changed since the answer is refused', JSON.stringify(changed.results[0]));
  ok(existsSync(path.join(c.wiki, 'concepts/handoff.md')), '9.10 …and kept');

  // No file at all (a reset, another computer): refused, not crashed.
  const n = fixture();
  const none = await health.fixSemanticDuplicatesBatch(n.name, [VARIANT]);
  ok(none.ineligible === 1 && none.merged === 0, '9.11 with nothing remembered every pair is refused');

  // Decided before the first merge: chains inside one batch still run.
  const chain = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff'), 'concepts/handoffs.md': page('Handoffs') });
  await scan(chain.name, fakeLLM((p) => ({ relation: 'same', confidence: 'high', canonicalSlug: 'hand-off' === p.a.split('/')[1] ? 'hand-off' : p.a.split('/')[1] })));
  const chained = await health.fixSemanticDuplicatesBatch(chain.name, [
    { keepSlug: 'hand-off', keepFolder: 'concepts', removeSlug: 'handoff', removeFolder: 'concepts' },
    { keepSlug: 'hand-off', keepFolder: 'concepts', removeSlug: 'handoffs', removeFolder: 'concepts' },
  ]);
  ok(chained.merged === 2, '9.12 an earlier merge rewriting the kept page does not refuse the next pair', JSON.stringify(chained.results));

  // The single merge with its Preview is untouched.
  const s = fixture();
  const single = await health.fixIssue(s.name, 'semanticDupe', LOOKALIKE);
  ok(single.fixed === 1, '9.13 NEGATIVE CONTROL — a single merge is not held to the batch rule');

  // A mirror route refusal is the route's; the guard stays on the route.
  const routes = await import(path.join(REPO, 'src/routes/health.js'));
  const layer = routes.default.stack.find((l) => l.route && l.route.path === '/:domain/semantic-dupes/forget');
  ok(!!layer && !!layer.route.methods.post, '9.14 the forget route is registered as a POST');
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. A real scan writes nothing under domains/');
{
  const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  const before = treeHash(DOMAINS_DIR);
  await scan(d.name, fakeLLM(yesAll()));
  await ai.estimateSemanticDuplicateScan(d.name, 10);
  await ai.semanticScanStatus(d.name);
  ok(treeHash(DOMAINS_DIR) === before, '10.1 the domains folder is byte-identical after scan, estimate and status');
  ok(existsSync(checksFile(d.name)), '10.2 CONTROL — the answers did land, in the user-data dir');
  ok(checksFile(d.name).startsWith(USER_DIR), '10.3 under the user-data dir, resolved through paths.js');
  ok(!checksFile(d.name).startsWith(DOMAINS_DIR), '10.4 never under domains/');
  const gitignore = readFileSync(path.join(REPO, '.gitignore'), 'utf8');
  ok(/^\.duplicate-checks\/$/m.test(gitignore), '10.5 in REPO mode the folder is gitignored: it names the owner\'s pages');
  const rules = readFileSync(path.join(REPO, 'src/brain/sync.js'), 'utf8');
  ok(rules.includes("'.duplicate-checks/'"), '10.6 …and listed for a domains folder that IS the user-data dir');
}

// ═══════════════════════════════════════════════════════════════════════════
section('11. No file, a corrupt file, a wrong shape: a first scan, never a crash');
{
  const bad = [
    ['truncated JSON', '{"format":1,"pairs":{"a":'],
    ['not JSON', 'hello'],
    ['an empty file', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['another format', '{"format":99,"pairs":{}}'],
    ['pairs as an array', '{"format":1,"pairs":[]}'],
  ];
  mkdirSync(getDuplicateChecksDir(), { recursive: true });
  for (const [label, body] of bad) {
    const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
    writeFileSync(checksFile(d.name), body);
    const llm = fakeLLM();
    const r = await scan(d.name, llm);
    ok(llm.sent.length === 1 && r.done.leftPairs === 0, `11. ${label}: behaves as a first scan, and repairs the file`);
    const again = fakeLLM();
    await scan(d.name, again);
    ok(again.calls === 0, '11. …which then works');
  }
  // A garbage record among good ones is dropped, not fatal.
  const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  writeFileSync(checksFile(d.name), JSON.stringify({ format: 1, pairs: {
    [dc.pairKey('concepts', 'hand-off', 'concepts', 'handoff')]: { verdict: 'yes' },
    other: 7,
  } }));
  const r = await ai.estimateSemanticDuplicateScan(d.name, 10);
  ok(r.checkedPairs === 0 && r.leftPairs === 1, '11.x a malformed record is not an answer');
  // A yes whose named pages do not match the pair is not an answer either.
  const open = dc.pageOpening(page('Hand-off'));
  const open2 = dc.pageOpening(page('Handoff'));
  const llmOnce = fakeLLM();
  const { model, provider } = (await ai.estimateSemanticDuplicateScan(d.name, 10));
  await scan(d.name, llmOnce); // learn this build's prompt id from a real save
  const saved = (await dc.loadDuplicateChecks(d.name)).get(dc.pairKey('concepts', 'hand-off', 'concepts', 'handoff'));
  writeFileSync(checksFile(d.name), JSON.stringify({ format: 1, pairs: {
    [dc.pairKey('concepts', 'hand-off', 'concepts', 'handoff')]: { provider, model, prompt: saved.prompt, at: 'x', verdict: 'yes', confidence: 'high',
      keep: 'concepts/someone-else', remove: 'concepts/handoff',
      openings: dc.openingsHash('concepts', 'hand-off', open, 'concepts', 'handoff', open2) },
  } }));
  const tampered = await ai.estimateSemanticDuplicateScan(d.name, 10);
  ok(tampered.leftPairs === 1, '11.y a yes naming other pages does not apply');
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. The MCP tool reports coverage');
{
  const { scanSemanticDuplicatesHandler, scanSemanticDuplicatesDefinition } = await import(path.join(REPO, 'mcp/tools/health.js'));
  const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff'),
    'concepts/data-store.md': page('Data store'), 'concepts/data-stores.md': page('Data stores') });
  const storage = { listDomains: async () => [d.name] };
  const est = await scanSemanticDuplicatesHandler({ domain: d.name, estimate_only: true }, storage);
  ok(est.ok && est.total_pairs === 2 && est.checked_pairs === 0 && est.left_pairs === 2, '12.1 estimate_only carries coverage', JSON.stringify(est).slice(0, 200));
  ok(/0 of 2 possible pairs/.test(est.report), '12.2 …in its report too', est.report);
  ok(/left_pairs/.test(scanSemanticDuplicatesDefinition.description) && /remembers/.test(scanSemanticDuplicatesDefinition.description),
    '12.3 the tool description tells a model about repeat runs');
}

// ═══════════════════════════════════════════════════════════════════════════
section('13. The prompt and the reply it asks for');
{
  const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  const llm = fakeLLM();
  await scan(d.name, llm);
  ok(llm.maxTokens === 6000, '13.1 the output limit is 6000: 2048 overflowed on a batch of 20', String(llm.maxTokens));
  ok(llm.system.startsWith('You are auditing a personal knowledge wiki for pages that should be merged because they are the SAME page written twice.')
    && llm.system.endsWith('When unsure, choose "overlap".\nRespond with ONLY valid JSON.'), '13.2 the measured system text, verbatim');
  for (const f of ['difference', 'relation', 'same|part|version|overlap|different', 'canonicalSlug', 'confidence', 'rationale']) {
    ok(llm.user.includes(f), `13.3 the reply format names ${f}`);
  }
  ok(llm.user.includes('"retrieval-augmented-generation" over "rag"'), '13.4 the rule for choosing the slug to keep is kept');

  // Old answers re-check on their own: a record under other instructions does not apply.
  const key = dc.pairKey('concepts', 'hand-off', 'concepts', 'handoff');
  const rec = (await dc.loadDuplicateChecks(d.name)).get(key);
  await dc.saveDuplicateChecks(d.name, new Map([[key, { ...rec, prompt: 'an-older-prompt' }]]));
  const again = fakeLLM();
  await scan(d.name, again);
  ok(again.sent.length === 1, '13.5 an answer under older instructions is checked again');
}

// ═══════════════════════════════════════════════════════════════════════════
section('14. Real page names can be previewed and merged');
{
  const names = ['claude-opus-4.6', 'talirezun.com', 'kimi-k2.7', 'foo_bar', 'with space', 'café-notes', "o'reilly", 'a&b', 'fifty%off', 'c(1)'];
  for (const name of names) {
    const other = name + '-copy';
    const d = mkDomain({
      [`concepts/${name}.md`]: page('Kept'),
      [`concepts/${other}.md`]: page('Gone'),
      'summaries/hub.md': `# Hub\n\n- [[${other}]] and [[concepts/${other}|alias]]\n`,
    });
    const pair = { keepSlug: name, keepFolder: 'concepts', removeSlug: other, removeFolder: 'concepts' };
    const plan = await health.previewSemanticDuplicateMerge(d.name, pair);
    ok(plan.keepPath === `concepts/${name}.md` && plan.totalLinksRewritten === 2, `14. "${name}": previews, counting its links`, JSON.stringify([plan.keepPath, plan.totalLinksRewritten]));
    const r = await health.fixIssue(d.name, 'semanticDupe', pair);
    const hub = readFileSync(path.join(d.wiki, 'summaries/hub.md'), 'utf8');
    ok(r.fixed === 1 && !existsSync(path.join(d.wiki, `concepts/${other}.md`)), `14. "${name}": merges and deletes the other page`, JSON.stringify(r));
    ok(hub.includes(`[[${name}]]`) && !hub.includes(other), `14. "${name}": links point to the page kept`, hub);
  }

  // The widening must not open a way out of the wiki.
  const d = mkDomain({ 'concepts/inside.md': page('Inside') });
  const outside = path.join(DOMAINS_DIR, 'outside-secret.md');
  writeFileSync(outside, 'secret\n');
  const bad = ['../../outside-secret', '..\\..\\outside-secret', 'a/b', 'a\\b', '..', '.', '.hidden', 'a..b', '', ' lead', 'trail ', 'x\u0000y', 'x\ny', 'a|b', 'a[b', 'a]b', 'a#b',
    '/etc/passwd', 'x'.repeat(241)];
  for (const slug of bad) {
    ok(!dc.isMergeableSlug(slug), `14. ${JSON.stringify(slug.slice(0, 24))} is not a mergeable name`);
    const pair = { keepSlug: 'inside', keepFolder: 'concepts', removeSlug: slug, removeFolder: 'concepts' };
    const r = await health.fixIssue(d.name, 'semanticDupe', pair);
    ok(r.fixed === 0, '14. …and a merge naming it is refused', JSON.stringify(r));
    let threw = false;
    try { await health.previewSemanticDuplicateMerge(d.name, pair); } catch { threw = true; }
    ok(threw, '14. …and so is a preview');
  }
  ok(existsSync(outside) && readFileSync(outside, 'utf8') === 'secret\n', '14. the file outside the wiki was never touched');
  ok(!dc.isMergeableSlug(null) && !dc.isMergeableSlug(7), '14. a name must be a string');

  // Never offered a Merge it cannot perform.
  const odd = mkDomain({ 'concepts/a#b.md': page('Odd'), 'concepts/a-b.md': page('Odd 2'), 'concepts/ab.md': page('Fine'),
    'concepts/x..y.md': page('Dots'), 'concepts/x-y.md': page('Plain'), 'concepts/xy.md': page('Plain 2') });
  const { pairs: oddPairs } = await health.findSemanticCandidatePairs(odd.name, 1000);
  ok(oddPairs.length > 0 && oddPairs.every((q) => dc.isMergeableSlug(q.slugA) && dc.isMergeableSlug(q.slugB)), '14. a name that can never merge is never a candidate', JSON.stringify(oddPairs.map((q) => q.slugA + '+' + q.slugB)));
  for (const q of oddPairs) {
    const plan = await health.previewSemanticDuplicateMerge(odd.name, { keepSlug: q.slugA, keepFolder: q.folderA, removeSlug: q.slugB, removeFolder: q.folderB });
    ok(!!plan.keepPath, `14. …and every candidate previews (${q.slugA} + ${q.slugB})`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('15. The pairs at once, with no candidate pass');
{
  const d = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff'),
    'concepts/data-store.md': page('Data store'), 'concepts/data-stores.md': page('Data stores'),
    'concepts/graph-node.md': page('Graph node'), 'concepts/graph-nodes.md': page('Graph nodes') });
  const none = await ai.semanticRememberedPairs(d.name);
  ok(none.hasChecks === false && none.pairs.length === 0, '15.1 nothing remembered: nothing to show');
  await scan(d.name, fakeLLM(yesAll()));
  const q1 = await ai.semanticRememberedPairs(d.name);
  ok(q1.hasChecks === true && q1.pairs.length === 3 && q1.pairs.every((p) => p.remembered === true && p.spellingVariant === true), '15.2 the found pairs come back', JSON.stringify(q1.pairs.length));
  const full = await ai.semanticScanStatus(d.name);
  const k = (list) => list.map((p) => p.keepSlug + '>' + p.removeSlug).sort().join();
  ok(k(q1.pairs) === k(full.pairs), '15.3 DUMB CROSS-CHECK: the same pairs as the slow pass');
  await addDismissal(d.name, 'semanticDupe', { slugA: 'data-store', folderA: 'concepts', slugB: 'data-stores', folderB: 'concepts' });
  ok((await ai.semanticRememberedPairs(d.name)).pairs.length === 2, '15.4 a skipped pair stays out');
  writeFileSync(path.join(d.wiki, 'concepts/graph-node.md'), page('Graph node', 'Something else entirely.'));
  ok((await ai.semanticRememberedPairs(d.name)).pairs.length === 1, '15.5 a changed opening stays out');
  rmSync(path.join(d.wiki, 'concepts/handoff.md'));
  ok((await ai.semanticRememberedPairs(d.name)).pairs.length === 0, '15.6 a page gone stays out');
  process.env.LLM_MODEL = 'gemini-2.5-flash';
  const d2 = mkDomain({ 'concepts/hand-off.md': page('Hand-off'), 'concepts/handoff.md': page('Handoff') });
  delete process.env.LLM_MODEL;
  await scan(d2.name, fakeLLM(yesAll()));
  process.env.LLM_MODEL = 'gemini-2.5-flash';
  ok((await ai.semanticRememberedPairs(d2.name)).pairs.length === 0, '15.7 another model\'s answer stays out');
  delete process.env.LLM_MODEL;
  writeFileSync(checksFile(d2.name), 'garbage{{{');
  ok((await ai.semanticRememberedPairs(d2.name)).hasChecks === false, '15.8 a corrupt file is nothing remembered');
}

// ═══════════════════════════════════════════════════════════════════════════
__setDomainsDirOverride(null);
console.log('\n' + '='.repeat(62));
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ the duplicate scan remembers, and the batch deletes only what it should');
