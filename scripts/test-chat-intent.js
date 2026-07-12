/**
 * test-chat-intent.js — OFFLINE suite for the v3.0.7 Tier 1 chat-quality fix.
 *
 * Community-reported: after the v3.0.7 output-cap fix, a DECISION question
 * ("evaluate these three newsletter topics and recommend one") returned the
 * ENTIRE domain — ~160 sources with duplicates and a trailing raw blob of file
 * paths — and never gave a recommendation. Root causes, both fixed here:
 *
 *   1. Intent misclassification. The word "everything" inside the user's pasted
 *      topic idea tripped the enumerate detector; and analytical "which
 *      concepts have the MOST sources disagreeing?" questions were treated as
 *      list requests. detectQueryIntent now (a) checks DECISION cues first,
 *      (b) dropped the noisy bare "everything" trigger, (c) diverts superlative
 *      / disagreement questions to synthesis.
 *   2. Prompt + output discipline. Enumerate was told "completeness matters
 *      more than synthesis" → dumps. Reshaped to a focused, deduped, capped
 *      list; new DECISION prompt leads with a recommendation; all prompts now
 *      forbid reproducing the catalogue. A post-processor strips any residual
 *      bare-path echo.
 *
 * Deterministic + free (no network).
 */

import { detectQueryIntent, stripCatalogueEcho, extractAsk, __testing } from '../src/brain/chat.js';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) { ok(actual === expected, `${label} (got "${actual}")`); }
function section(t) { console.log(`\n${t}`); }

// Robin's ACTUAL two questions (Q1 abbreviated but preserving every trigger word:
// "everything", "which topic among these would be best to tackle", "Evaluating").
const ROBIN_Q1 =
  'Evaluating next TRUST-able title - I have these possible ideas for the next topic ' +
  'of the TRUSTable newsletter:1) The Content Context. The new game is not producing ' +
  'more content BUT everything that circles around content. Your perspective. Your ' +
  'worldview. 2) Robin Good’s Curation Framework. 3) Why Is It So Useful to Have a ' +
  'Personal Knowledge Base. Based on the content covered so far, and what my readership ' +
  'may prefer to read, which topic among these would be best to tackle?';
const ROBIN_Q2 =
  'Which concepts here have the most sources disagreeing, and what exactly is the disagreement?';

// ── 1. Robin's exact questions now classify correctly ───────────────────────
section('1. detectQueryIntent — the two community-reported questions');
eq(detectQueryIntent(ROBIN_Q1), 'decision',
  'Q1 ("…which topic among these would be best to tackle?") → decision (was enumerate via "everything")');
eq(detectQueryIntent(ROBIN_Q2), 'synthesis',
  'Q2 ("which concepts have the MOST sources DISAGREEING?") → synthesis (analytical override, was enumerate)');

// ── 2. Decision intent matrix ───────────────────────────────────────────────
section('2. detectQueryIntent — decision cues');
for (const q of [
  'Which of these topics should I write next?',
  'Recommend one of these three ideas.',
  'Should I focus on curation or knowledge bases?',
  'Help me choose between these titles.',
  'What is the best topic for my audience?',
  'Evaluate these options and pick the strongest.',
  'Which topic is best to tackle first?',
  'Give me the pros and cons of each idea.',
]) eq(detectQueryIntent(q), 'decision', `decision: "${q.slice(0, 44)}…"`);

// ── 3. Enumerate still works (regression against beta13's own set) ──────────
section('3. detectQueryIntent — genuine list requests stay enumerate');
for (const q of [
  'list articles by Dr. Tali Rezun',
  'What articles have I ingested?',
  'how many sources do I have?',
  'show me all entities',
  'give me a list of concepts',
  'name all the authors',
  'which papers mention RAG?',
  'I want the complete list of summaries',
  'every article in this domain',
  'articles by Prof. Smith',
]) eq(detectQueryIntent(q), 'enumerate', `enumerate: "${q.slice(0, 44)}…"`);

// ── 4. Synthesis / analytical stays synthesis ───────────────────────────────
section('4. detectQueryIntent — synthesis + analytical overrides');
for (const q of [
  'What is HNSW?',
  'How does RAG work?',
  'compare openai and anthropic',
  'why did Tali ditch RAG?',
  'which concepts contradict each other?',        // analytical override
  'which sources have the most disagreement?',     // analytical override
  'what pages differ on the definition of trust?', // analytical override
]) eq(detectQueryIntent(q), 'synthesis', `synthesis: "${q.slice(0, 44)}…"`);

// ── 4b. Audit regressions: list/count commands beat incidental decision words
section('4b. detectQueryIntent — explicit list/count COMMAND beats decision words');
for (const q of [
  'How many articles recommend using RAG?',            // count, not a recommendation
  'list all papers evaluating RAG systems',            // list, despite "evaluating"
  'which sources recommend vector databases?',         // list, despite "recommend"
  "I've collected advice on newsletters. How many sources do I have?", // ask after preamble
  'Show me all entities. I need advice later.',        // list command wins
]) eq(detectQueryIntent(q), 'enumerate', `enumerate-wins: "${q.slice(0, 50)}…"`);

// ── 4c. Audit regressions: analytical override must not over-fire ───────────
section('4c. detectQueryIntent — "most/least/different" in list phrasing stays enumerate');
for (const q of [
  'list at least 10 articles about RAG',               // "at least" ≠ analytical
  'list the most recent articles',                     // "most recent" ≠ analytical
  'show me all the most relevant concepts',            // "most relevant" ≠ analytical
  'list all the different concepts in my wiki',        // "different" ≠ "differ"
]) eq(detectQueryIntent(q), 'enumerate', `not-analytical: "${q.slice(0, 50)}…"`);

// ── 4d. Audit edge #1: enumerate words buried in pasted content don't hijack ─
section('4d. detectQueryIntent — classifies the ASK, not buried pasted content');
{
  // A pasted "List: A, B, C" line must NOT beat the real decision ask.
  eq(detectQueryIntent('Here are my ideas. List: A, B, C. Which of these should I write next?'),
    'decision', 'mid-content "List:" does not override the final decision ask');
  // A pasted enumerate-shaped line must NOT beat a synthesis ask.
  eq(detectQueryIntent('I dumped my notes here. All sources are messy. How does trust actually work?'),
    'synthesis', 'mid-content "All sources…" does not override the final synthesis ask');
  // But a genuine trailing count question is still enumerate (the ask IS the count).
  eq(detectQueryIntent("I've collected advice on newsletters. How many sources do I have?"),
    'enumerate', 'trailing count question is correctly enumerate');
}

// ── 4d-bis. Audit edge (round 3): trailing imperative after a quoted question
section('4d-bis. detectQueryIntent — a trailing command after a quoted question wins');
{
  // The real ask is "List every source…", NOT the quoted "what is trust?".
  eq(detectQueryIntent('The article asks: what is trust? List every source that defines it.'),
    'enumerate', 'trailing "List every source" command beats a quoted preamble question');
  // Abbreviations inside the actual ask must not false-split it away.
  eq(detectQueryIntent('Which is the best approach, e.g. RAG or fine-tuning?'),
    'decision', '"e.g." inside the ask does not break decision classification');
  eq(detectQueryIntent('List the U.S. sources I have on trust.'),
    'enumerate', '"U.S." abbreviation does not break the list command');
}

// ── 4e. extractAsk — focuses on the interrogative / final sentence ──────────
section('4e. extractAsk — focus extraction');
ok(extractAsk('list all articles') === 'list all articles', 'single sentence returned whole');
ok(/which of these should i write next/i.test(
     extractAsk('Here are my ideas. List: A, B, C. Which of these should I write next?')),
   'multi-sentence: picks the question');
ok(!/list: a, b, c/i.test(
     extractAsk('Here are my ideas. List: A, B, C. Which of these should I write next?')),
   'multi-sentence: drops the mid-content "List:" line');
ok(extractAsk('') === '', 'empty → empty');
ok(extractAsk(null) === '', 'null → empty');
{
  const noQuestion = 'Here are my ideas. Recommend the strongest one.';
  ok(/recommend the strongest one/i.test(extractAsk(noQuestion)),
    'no question mark → falls back to the last sentence');
}

// ── 5. "everything" in prose no longer forces enumerate ─────────────────────
section('5. detectQueryIntent — the "everything" false-trigger is gone');
eq(detectQueryIntent('Tell me about everything that circles around content.'), 'synthesis',
  '"everything" in prose → synthesis (not enumerate)');
eq(detectQueryIntent('Summarise everything we know about trust.'), 'synthesis',
  '"everything" in a summarise request → synthesis');

// ── 6. Defensive inputs ─────────────────────────────────────────────────────
section('6. detectQueryIntent — defensive');
eq(detectQueryIntent(null), 'synthesis', 'null → synthesis');
eq(detectQueryIntent(undefined), 'synthesis', 'undefined → synthesis');
eq(detectQueryIntent(''), 'synthesis', 'empty → synthesis');

// ── 7. stripCatalogueEcho — removes the bare-path blob, keeps real content ──
section('7. stripCatalogueEcho — catalogue-echo safety net');
{
  // Reconstruct the tail of Robin's actual answer: a long run of glued bare paths.
  const blob = [
    'summaries/27-be-the-news.md', 'summaries/26-going-in-depth.md',
    'summaries/30-write-to-be-trusted.md', 'concepts/llm-wiki.md',
    'concepts/paradata.md', 'entities/robin-good.md', 'entities/substack.md',
  ].join('');
  const answer = 'I’d go with **The Content Context** [source: summaries/26-going-in-depth.md] because it fits your audience.\n\n' + blob;
  const cleaned = stripCatalogueEcho(answer);
  ok(!/summaries\/27-be-the-news\.md/.test(cleaned) || cleaned.length < answer.length,
    'the glued bare-path blob is removed');
  ok(cleaned.includes('The Content Context') && cleaned.includes('[source: summaries/26-going-in-depth.md]'),
    'the recommendation + its real [source: …] citation are preserved');
  ok(cleaned.length < answer.length, 'answer got shorter (blob stripped)');
}

// A normal formatted citation LIST must survive untouched (paths sit inside
// [source: …] with titles between them → never a 5+ bare run).
{
  const list =
    'Here are the relevant pages:\n' +
    '* [source: summaries/a.md] — Topic A\n' +
    '* [source: summaries/b.md] — Topic B\n' +
    '* [source: concepts/c.md] — Concept C\n' +
    '* [source: entities/d.md] — Entity D\n' +
    '* [source: concepts/e.md] — Concept E\n';
  ok(stripCatalogueEcho(list) === list, 'formatted [source: …] citation list is preserved verbatim');
}

// Plain prose with a few inline paths is untouched.
{
  const prose = 'The page concepts/rag.md explains retrieval, and summaries/x.md covers the rest.';
  ok(stripCatalogueEcho(prose) === prose, 'prose with <5 bare paths is untouched');
}

// Audit fix: comma-separated 5+ paths are a legitimate compact list — preserved.
{
  const commaList = 'Relevant: summaries/a.md, concepts/b.md, entities/c.md, summaries/d.md, concepts/e.md';
  ok(stripCatalogueEcho(commaList) === commaList, 'comma-separated path list is preserved');
}

// Audit fix: a multi-path [source: …] citation (commas) is preserved.
{
  const multiCite = 'See [source: summaries/a.md, concepts/b.md, entities/c.md, summaries/d.md, concepts/e.md] for context.';
  ok(stripCatalogueEcho(multiCite) === multiCite, 'multi-path [source: …] citation is preserved');
}

// Audit fix: when a real blob IS stripped, code-block indentation elsewhere survives
// (we no longer globally collapse runs of spaces/tabs).
{
  const glued = ['summaries/a.md','summaries/b.md','concepts/c.md','entities/d.md','concepts/e.md'].join('');
  const withCode = 'Here is the layout:\n```\n    indented line one\n        deeper indent\n```\n\n' + glued;
  const cleaned = stripCatalogueEcho(withCode);
  ok(!cleaned.includes(glued), 'the glued blob is removed');
  ok(cleaned.includes('    indented line one') && cleaned.includes('        deeper indent'),
    'code-block indentation is preserved (no global space collapse)');
}

// Space-separated (not glued) 5+ bare paths are still a catalogue echo → stripped.
{
  const spaced = 'summaries/a.md summaries/b.md concepts/c.md entities/d.md concepts/e.md';
  const ans = 'Short answer.\n\n' + spaced;
  ok(stripCatalogueEcho(ans).length < ans.length, 'space-separated bare-path run is stripped');
}

// Defensive: empty / non-string.
ok(stripCatalogueEcho('') === '', 'empty string returns empty');
ok(stripCatalogueEcho(null) === null, 'null returns null');
ok(typeof stripCatalogueEcho('no paths here at all') === 'string', 'plain text returns string');

// ── 8. buildPrompt wires the right instruction block per intent ─────────────
section('8. buildPrompt — instruction block per intent + catalogue guard');
{
  const { buildPrompt } = __testing;
  const PAGES = [
    { path: 'concepts/rag.md', content: '# RAG\nRetrieval augmented generation.' },
    { path: 'entities/tali-rezun.md', content: '# Tali Rezun\nAuthor.' },
    { path: 'summaries/x.md', content: '# X\nA summary.' },
  ];

  const decisionPrompt = buildPrompt('articles', PAGES, [], 'Which of these should I write next?');
  ok(decisionPrompt.includes('DECISION / RECOMMENDATION query'), 'decision query → decision prompt');
  ok(decisionPrompt.includes('Lead with a direct recommendation'), 'decision prompt leads with a recommendation');
  ok(!decisionPrompt.includes('ENUMERATION query'), 'decision prompt is not the enumerate prompt');

  const enumPrompt = buildPrompt('articles', PAGES, [], 'list all articles by Tali Rezun');
  ok(enumPrompt.includes('ENUMERATION query'), 'list query → enumerate prompt');
  ok(enumPrompt.includes('the user wants a focused list'), 'enumerate prompt is the focused-list form');
  ok(enumPrompt.includes('DEDUPLICATE'), 'enumerate prompt instructs dedup');
  ok(!enumPrompt.includes('completeness matters more than synthesis'),
    'enumerate prompt dropped the old "completeness over synthesis" dump philosophy');

  const synthPrompt = buildPrompt('articles', PAGES, [], 'how does RAG work?');
  ok(synthPrompt.includes('Lead with the direct answer'), 'synthesis prompt leads with the answer');

  // All three forbid reproducing the catalogue.
  for (const [name, p] of [['decision', decisionPrompt], ['enumerate', enumPrompt], ['synthesis', synthPrompt]]) {
    ok(/Do NOT copy it into your answer|NEVER paste the domain catalogue/.test(p),
      `${name} prompt forbids reproducing the catalogue`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-intent (Tier 1) offline assertions green');
