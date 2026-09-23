/**
 * test-chat-project-context.js — OFFLINE suite for "Chat reads a project"
 * (v3.64.0): src/brain/chat.js's in-process `getProjectContext` read, the
 * second budget, the MCP's serialisation ORDER, and the route's two new
 * fields.
 *
 * No network, no API key, no server, no browser, no LLM call, no filesystem
 * write. The store call is driven through `opts.getProjectContext` — a
 * TEST-ONLY seam, the same pattern and the same rationale as compile.js's
 * `opts.generateText` — so every envelope shape, every budget edge and every
 * refusal is reachable offline and the REAL selection, budget and rendering
 * code is what runs.
 *
 * ── WHAT THIS SUITE IS FOR ───────────────────────────────────────────────
 *
 * §1  BYTE-IDENTITY. With no project pinned, `buildPrompt` must return the
 *     string it returned before this release — not "an equivalent" string.
 *     The wiki budget is untouched and the wiki-only turn is unchanged, and
 *     the only way to say that is to compose both and compare bytes.
 *
 * §2  THE ORDER, which is the injection defence. `CAVEAT_BODY` is what stands
 *     between a handoff that arrived over sync — from another machine, or
 *     from another person if the project is a shared mirror — and a model
 *     that reads it as instructions. v3.17.0 MEASURED a real relay through
 *     that channel: planted state was never obeyed, but in 3 of 10 live runs
 *     Gemini reproduced a hostile command to the developer as a recommended
 *     next step. The label must be emitted BEFORE the text it qualifies, and
 *     the brief's authority note before the brief's body.
 *
 * §3  THE NEGATIVE CONTROL for §2. The same content, rendered in the wrong
 *     order, must make §2's own predicates FAIL. Without it a green §2 is a
 *     tautology about a string that happens to contain some substrings.
 *
 * §4  THE BUDGET, stated and separate: 40 KB reaches the store as the ceiling
 *     `maxBytesCeiling` (v3.67.0; it was `maxBytes`),
 *     the wiki's three constants are not touched, and every omission the
 *     store discloses reaches the PROMPT as a line.
 *
 * §5  THE ROUTE: two fields read on their own lines, the pinned destructure
 *     untouched, every refusal above `flushHeaders()`, scope NOT validated,
 *     and the reserved-name list in step with routes/memory.js's.
 *
 * §6  THE DUPLICATED CLASSIFIER. `classifyChatBriefAuthority` is a deliberate
 *     second copy of the MCP's `classifyBriefAuthority` (see its doc comment
 *     for why it could not be imported). Both are driven over the same
 *     inputs and must agree, with a planted divergence as the control.
 *
 * §7  SELECTION: read-first always, keyword matching for the rest, the
 *     journal bounded, and a skeleton never opened by a keyword match.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  __testing,
  loadProjectContext,
  renderProjectContextBlock,
  composeQueryContext,
  classifyChatBriefAuthority,
  PROJECT_CONTEXT_BUDGET_CHARS,
} from '../src/brain/chat.js';
import {
  CAVEAT_BODY,
  BRIEF_IS_OWNER_AUTHORED,
  FOUNDATIONS_ARE_DATA,
  JOURNAL_IS_HISTORY,
  briefAuthorityNote,
} from '../src/brain/context-framing.js';
import { CONTEXT_MAX_BYTES_CAP, CONTEXT_MAX_BYTES_DEFAULT } from '../src/brain/working-state.js';

const {
  buildPrompt,
  selectExtraFoundationSlugs,
  selectJournalEntries,
  projectOmissionNotes,
  PROJECT_CONFLICT_CLAUSE,
  PROJECT_JOURNAL_MAX,
  PROJECT_JOURNAL_FLOOR,
  PROJECT_EXTRA_FOUNDATIONS_MAX,
} = __testing;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const brainSrc = readFileSync(path.join(ROOT, 'src/brain/chat.js'), 'utf8');
const routeSrc = readFileSync(path.join(ROOT, 'src/routes/chat.js'), 'utf8');
const memorySrc = readFileSync(path.join(ROOT, 'src/routes/memory.js'), 'utf8');
const mcpSrc = readFileSync(path.join(ROOT, 'mcp/tools/working-state.js'), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Fixtures ─────────────────────────────────────────────────────────────

const PAGES = [
  { path: 'entities/curator.md', content: '# The Curator\n\nA local wiki builder.' },
  { path: 'concepts/retrieval.md', content: '# Retrieval\n\nQuery-driven page selection.' },
  { path: 'summaries/a-note.md', content: '# A note\n\n[[curator]] is mentioned here.' },
];
const HISTORY = [
  { role: 'user', content: 'what is retrieval' },
  { role: 'assistant', content: 'It selects pages.' },
];

/** A full, well-shaped envelope. Every §'s fixture starts from this. */
function envelope(over = {}) {
  const f = Object.assign({
    present: true, ownership: 'curator', repo: null, manifestError: null, orphanFiles: [],
    count: 3, totalBytes: 3000, budgetBytes: 200 * 1024, budgetExceeded: false,
    staleCount: 0, unreachableCount: 0, skeletonCount: 0,
    readFirstCount: 1, onRequestCount: 2,
    readFirstBytes: 100, readFirstBudgetBytes: CONTEXT_MAX_BYTES_DEFAULT, readFirstBudgetExceeded: false,
    changedCount: 0, includeMode: 'changed', bodySelection: 'read-first', seenSource: 'none',
    index: [
      { slug: 'architecture.md', role: 'architecture', title: 'Architecture', sha256: 'a', bytes: 100, freshness: 'fresh', fileMissing: false, skeleton: false, readFirst: true },
      { slug: 'decisions.md', role: 'decisions', title: 'Decision log', sha256: 'b', bytes: 100, freshness: 'fresh', fileMissing: false, skeleton: false, readFirst: false },
      { slug: 'conventions.md', role: 'conventions', title: 'Conventions', sha256: 'c', bytes: 100, freshness: 'fresh', fileMissing: false, skeleton: false, readFirst: false },
    ],
    documents: [
      { slug: 'architecture.md', role: 'architecture', title: 'Architecture', text: 'ARCH BODY', sha256: 'a', bytes: 9, readFirst: true, skeleton: false },
    ],
    requested: [],
    requestedRefused: [],
    requestedBytes: 0,
    unreadable: [],
    budget: { maxBytes: PROJECT_CONTEXT_BUDGET_CHARS, usedBytes: 9, truncated: false, omitted: [] },
    readingOrder: ['architecture.md', 'decisions.md', 'conventions.md'],
  }, over.foundations || {});

  return Object.assign({
    ok: true,
    project: 'curator',
    domain: 'articles',
    scope: 'session-1',
    brief: { present: true, text: 'BRIEF BODY', bytes: 10, truncated: false, sanitisedOnRead: false, authoredBy: null },
    current: { present: true, text: 'HANDOFF BODY', bytes: 12, truncated: false, savedAt: '2026-09-19T10:00:00.000Z', writtenAt: '2026-09-19T09:58:00.000Z' },
    journal: {
      entries: [
        { at: '2026-09-19T09:58:00.000Z', harness: 'claude-code', model: 'opus', headline: 'shipped the retrieval change', rejections: [] },
        { at: '2026-09-18T09:00:00.000Z', harness: 'claude-code', model: 'opus', headline: 'started the budget work', rejections: [] },
        { at: '2026-09-17T09:00:00.000Z', harness: 'codex', model: 'gpt', headline: 'wrote the conventions document', rejections: [] },
        { at: '2026-09-16T09:00:00.000Z', harness: 'codex', model: 'gpt', headline: 'unrelated plumbing', rejections: [] },
      ],
      returned: 4, total: 4, totalUnknown: false,
    },
    seen: {},
  }, over, { foundations: f });
}

/** A seam that records what it was asked and answers from a script. */
function fakeStore(answers) {
  const calls = [];
  const fn = async (domain, project, opts) => {
    calls.push({ domain, project, opts });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof a === 'function' ? a({ domain, project, opts }) : a;
  };
  fn.calls = calls;
  return fn;
}

// ═════════════════════════════════════════════════════════════════════════
section('§0 — Harness self-check');
// ═════════════════════════════════════════════════════════════════════════
{
  let sawFail = false;
  const realOk = ok;
  // eslint-disable-next-line no-func-assign
  ok = (c) => { if (!c) sawFail = true; };
  ok(false, 'probe');
  // eslint-disable-next-line no-func-assign
  ok = realOk;
  ok(sawFail, 'control: ok() can fail — the assertions below are not decorative');
  ok(typeof loadProjectContext === 'function' && typeof renderProjectContextBlock === 'function',
    'the real functions under test are importable');
  ok(CAVEAT_BODY.length > 100 && BRIEF_IS_OWNER_AUTHORED.length > 100,
    'the framing constants really came from src/brain/context-framing.js');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — BYTE-IDENTITY: no project pinned ⇒ the prompt is unchanged');
// ═════════════════════════════════════════════════════════════════════════
{
  // The whole claim of D-M, and the only honest way to make it: compose both
  // and compare bytes. "Looks the same" is not a measurement.
  const five = buildPrompt('articles', PAGES, HISTORY, 'tell me about retrieval', 'balanced');
  const sixNull = buildPrompt('articles', PAGES, HISTORY, 'tell me about retrieval', 'balanced', null);
  const four = buildPrompt('articles', PAGES, HISTORY, 'tell me about retrieval');
  eq(sixNull, five, 'the 6-arg call with a null project block is BYTE-IDENTICAL to the 5-arg call');
  eq(four, five, '…and the 4-arg default call is byte-identical too, so nothing moved under the older callers');
  ok(!sixNull.includes('Project context'), 'no project ⇒ no project block in the prompt');
  ok(!sixNull.includes(PROJECT_CONFLICT_CLAUSE),
    'no project ⇒ the conflict clause is ABSENT — it is appended, never written into the three intent literals');

  // The CONTROL for the identity assertions: a project block must actually
  // change the string, otherwise the three lines above prove nothing.
  const withBlock = buildPrompt('articles', PAGES, HISTORY, 'tell me about retrieval', 'balanced', '[Project context]\nX');
  ok(withBlock !== five, 'CONTROL: a non-null project block DOES change the prompt');
  ok(withBlock.includes(PROJECT_CONFLICT_CLAUSE),
    '…and brings the "say so and name both" clause with it');
  ok(withBlock.indexOf('[Project context]') < withBlock.indexOf('[Domain catalogue'),
    'the project block sits ABOVE the domain catalogue');

  // The three wiki budgets are what they were. Read off the SOURCE, because
  // they are module-private constants and the claim is that they did not move.
  ok(/const CONTENT_BUDGET_CHARS\s*=\s*60_000;/.test(brainSrc), 'CONTENT_BUDGET_CHARS is still 60_000');
  ok(/const CATALOGUE_BUDGET_CHARS\s*=\s*12_000;/.test(brainSrc), 'CATALOGUE_BUDGET_CHARS is still 12_000');
  ok(/const MAX_PAGES_LOADED\s*=\s*50;/.test(brainSrc), 'MAX_PAGES_LOADED is still 50');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1b — THE RECORDED BASELINE (the assertions above cannot see a change to buildPrompt ITSELF)');
// ═════════════════════════════════════════════════════════════════════════
{
  /* ── WHY THIS SECTION EXISTS, AND IT IS A MUTATION RESULT ────────────────
     §1 compares two CALLS of the SAME function, so it is blind to any change
     INSIDE it: a mutation that made the project section unconditional
     (`${projectBlock || ''}\n\n---\n`, appending a stray separator to every
     wiki-only prompt in the app) left §1 entirely GREEN, because both calls
     grew the same bytes. That is the "a passing test that measures the wrong
     thing is worse than no test" shape this repo has recorded three times.

     So the baseline is RECORDED rather than re-derived: these nine sha256
     digests were taken by EXECUTING `buildPrompt` out of `git show
     main:src/brain/chat.js` — the pre-v3.64.0 function — over the fixtures
     below, one per (style × intent) combination so all three intent blocks
     and all three style directives are covered.

     WHEN A DIGEST MOVES, THAT IS THE POINT. It means the wiki-only prompt
     changed, which may be entirely intended — but it must then be an edit
     someone made on purpose and re-recorded here with the release that made
     it, not something that arrived as a side effect of a project-context
     change. Re-record by running the snippet in this comment against the
     PREVIOUS release's chat.js, never by pasting the new value. */
  const BASELINE = {
    'concise|tell me about retrieval': 'e1837d73f8e261e0cce6af0fd06c3f0808f7411545106e52b305f7577f08c9c6',
    'concise|list every page about the curator': 'f26891a792676a0e07596cdd89683721c27d41c56f34e21f03fc41d966ed9613',
    'concise|should I use retrieval or embeddings': 'fc01831bf5cbf177a79e0da598167c0bbb4b2fad88860423950b89dfae5480ed',
    'balanced|tell me about retrieval': '1f8e084372b8539cc0616dad7cab1d5aabbf441a6b4e24b1eaa65fe543a97a4f',
    'balanced|list every page about the curator': '1956841132157b99937b4d83319d941e179992f3aa4f00f7c87edc5beea1b20b',
    'balanced|should I use retrieval or embeddings': '4de4711d622b27f21c8004a565d0cb19fee0b8743681cf4321f49ce1b7ca5b4c',
    'comprehensive|tell me about retrieval': 'f163fd0cced2df984406b2df9b2c3611e78d18efa00c4d5f2cd3d5120d59277b',
    'comprehensive|list every page about the curator': '09f97408c2514e52b25bf53bf93e6ab0fdc2179086ad28dff62c8e5852ec54e7',
    'comprehensive|should I use retrieval or embeddings': '4678dc038165fdff7cc83a7e5ffda5a62ca99e85aec5c9d72e8fe64b1f5a9c9b',
  };
  const digest = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  for (const [key, want] of Object.entries(BASELINE)) {
    const [style, msg] = key.split('|');
    eq(digest(buildPrompt('articles', PAGES, HISTORY, msg, style)), want,
      `the wiki-only prompt is byte-identical to v3.63.0's — ${style} / "${msg.slice(0, 28)}…"`);
  }
  // CONTROL: the digests really do discriminate. A single added character
  // must move one.
  ok(digest(buildPrompt('articles', PAGES, HISTORY, 'tell me about retrieval', 'balanced') + ' ')
    !== BASELINE['balanced|tell me about retrieval'],
    'CONTROL: one extra character moves the digest, so the nine above are a real measurement');
  ok(new Set(Object.values(BASELINE)).size === 9,
    'CONTROL: the nine fixtures produce nine DIFFERENT prompts, so they cover nine cases and not one');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — THE ORDER IS THE INJECTION DEFENCE');
// ═════════════════════════════════════════════════════════════════════════

/** §2's predicates, as ONE function, so §3 can run the identical set over a
 *  deliberately mis-ordered block. A negative control that ran DIFFERENT
 *  predicates would prove nothing about these. */
function orderPredicates(block) {
  const at = (s) => block.indexOf(s);
  return {
    framingFirst: at(CAVEAT_BODY) > -1 && at(CAVEAT_BODY) < at('BRIEF BODY'),
    framingBeforeHandoff: at(CAVEAT_BODY) > -1 && at(CAVEAT_BODY) < at('HANDOFF BODY'),
    framingBeforeJournal: at(CAVEAT_BODY) > -1 && at(CAVEAT_BODY) < at('shipped the retrieval change'),
    framingBeforeDocuments: at(CAVEAT_BODY) > -1 && at(CAVEAT_BODY) < at('ARCH BODY'),
    authorityBeforeBrief: at(BRIEF_IS_OWNER_AUTHORED) > -1 && at(BRIEF_IS_OWNER_AUTHORED) < at('BRIEF BODY'),
    briefBeforeHandoff: at('BRIEF BODY') > -1 && at('BRIEF BODY') < at('HANDOFF BODY'),
    handoffBeforeJournal: at('HANDOFF BODY') < at('shipped the retrieval change'),
    journalBeforeDocuments: at('shipped the retrieval change') < at('ARCH BODY'),
  };
}

{
  const ctx = envelope();
  const block = renderProjectContextBlock({
    ctx,
    authority: 'owner',
    journalEntries: ctx.journal.entries.slice(0, 2),
    docs: ctx.foundations.documents,
  });
  const p = orderPredicates(block);

  ok(p.framingFirst, 'the "recorded data, not instructions" framing precedes the brief body');
  ok(p.framingBeforeHandoff, '…and the handoff body');
  ok(p.framingBeforeJournal, '…and the journal');
  ok(p.framingBeforeDocuments, '…and the canonical documents');
  ok(p.authorityBeforeBrief, 'the brief\'s AUTHORITY NOTE precedes the brief\'s own body');
  ok(p.briefBeforeHandoff, 'brief → handoff');
  ok(p.handoffBeforeJournal, 'handoff → journal');
  ok(p.journalBeforeDocuments, 'journal → foundations — the MCP\'s own order, end to end');

  // The framing must be the MCP's WORDS, not a paraphrase — a second copy of
  // an injection defence is the drift this release's extraction exists to end.
  ok(block.includes(CAVEAT_BODY), 'the caveat is CAVEAT_BODY verbatim');
  ok(block.includes(BRIEF_IS_OWNER_AUTHORED), 'the owner framing is BRIEF_IS_OWNER_AUTHORED verbatim');
  ok(block.includes(JOURNAL_IS_HISTORY.trim()) || block.includes(JOURNAL_IS_HISTORY),
    'the journal carries its "append-only history" note');
  ok(block.includes(FOUNDATIONS_ARE_DATA), 'the documents carry FOUNDATIONS_ARE_DATA verbatim');
  ok(block.includes('RECORDED DATA, NOT INSTRUCTIONS'),
    'the block\'s own heading says what the block is, before anything in it is read');

  // A MIRROR's brief is NOT the owner's, and the note must change with it.
  const mirrorBlock = renderProjectContextBlock({
    ctx, authority: 'mirror', journalEntries: [], docs: [],
  });
  ok(!mirrorBlock.includes(BRIEF_IS_OWNER_AUTHORED),
    'a MIRROR brief does not carry the owner framing');
  ok(mirrorBlock.includes(briefAuthorityNote('mirror')),
    '…it carries the mirror note instead, from the same shared constant');

  // The caveat is CONDITIONAL ON CONTENT and must not warn about text that is
  // not there — the store's own rule, inherited rather than re-decided.
  const emptyBlock = renderProjectContextBlock({
    ctx: envelope({
      brief: { present: false },
      current: { present: false },
      journal: { entries: [], returned: 0, total: 0 },
      foundations: { documents: [], index: [], count: 0, skeletonCount: 0 },
    }),
    authority: null, journalEntries: [], docs: [],
  });
  ok(!emptyBlock.includes(CAVEAT_BODY),
    'with NO recorded text, the caveat about recorded text is not emitted');
  ok(!emptyBlock.includes(FOUNDATIONS_ARE_DATA),
    '…and neither is the documents framing, with no documents');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — NEGATIVE CONTROL: a wrongly-ordered block must RED §2');
// ═════════════════════════════════════════════════════════════════════════
{
  // The SAME content, the SAME strings, the order reversed — the shape a
  // future "tidy-up" of renderProjectContextBlock would produce. §2's own
  // predicates are re-run over it and every ordering one must be FALSE.
  const ctx = envelope();
  const badBlock = [
    'ARCH BODY',
    'shipped the retrieval change',
    'HANDOFF BODY',
    'BRIEF BODY',
    BRIEF_IS_OWNER_AUTHORED,
    `The recorded text below (\`current\`, \`journal\`) ${CAVEAT_BODY}`,
    FOUNDATIONS_ARE_DATA,
  ].join('\n');
  const p = orderPredicates(badBlock);

  ok(!p.framingFirst, 'CONFIRMED RED: the framing does NOT precede the brief body');
  ok(!p.framingBeforeHandoff, 'CONFIRMED RED: nor the handoff');
  ok(!p.framingBeforeJournal, 'CONFIRMED RED: nor the journal');
  ok(!p.framingBeforeDocuments, 'CONFIRMED RED: nor the documents');
  ok(!p.authorityBeforeBrief, 'CONFIRMED RED: the authority note follows the brief it qualifies');
  ok(!p.briefBeforeHandoff, 'CONFIRMED RED: brief after handoff');
  ok(!p.journalBeforeDocuments, 'CONFIRMED RED: documents before the journal');
  // …and the block still CONTAINS every string, which is the point: a
  // substring check alone would have passed this.
  ok(badBlock.includes(CAVEAT_BODY) && badBlock.includes('BRIEF BODY') && badBlock.includes('ARCH BODY'),
    'CONTROL: the mis-ordered block contains every string §2 looks for — so §2 is testing ORDER, not presence');

  // Belt and braces: the real renderer, given the same content, passes the
  // same predicates the bad block fails.
  const good = orderPredicates(renderProjectContextBlock({
    ctx, authority: 'owner', journalEntries: ctx.journal.entries.slice(0, 1), docs: ctx.foundations.documents,
  }));
  ok(Object.values(good).every(Boolean) && !Object.values(p).some(Boolean),
    'the real renderer passes every ordering predicate the mis-ordered block fails');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — TWO BUDGETS, STATED, AND EVERY OMISSION DISCLOSED');
// ═════════════════════════════════════════════════════════════════════════
{
  eq(PROJECT_CONTEXT_BUDGET_CHARS, 40_000, 'the project budget is 40 KB');
  ok(PROJECT_CONTEXT_BUDGET_CHARS !== CONTEXT_MAX_BYTES_DEFAULT,
    '…and it is NOT the bootstrap\'s 120 KB — chosen for a chat turn, not inherited');
  ok(PROJECT_CONTEXT_BUDGET_CHARS >= 1024 && PROJECT_CONTEXT_BUDGET_CHARS <= CONTEXT_MAX_BYTES_CAP,
    '…and it survives the store\'s own clamp unchanged, so the number asked for is the number applied');

  const store = fakeStore([envelope({ foundations: { bodySelection: 'all' } })]);
  const out = await loadProjectContext('articles', 'curator', {
    queryContext: 'what did we decide', getProjectContext: store,
  });
  ok(out.ok, 'a well-shaped envelope loads');
  eq(store.calls.length, 1, 'ONE store call when nothing is flagged read-first — today\'s shape for every existing project');
  // v3.67.0 — a CEILING, not a caller's budget: `maxBytes` would read as
  // `budget.source: 'caller'` and clamp an owner's Index only (0) up to 1024.
  eq(store.calls[0].opts.maxBytesCeiling, PROJECT_CONTEXT_BUDGET_CHARS, 'the budget reaches the store as the ceiling `maxBytesCeiling`');
  eq(store.calls[0].opts.maxBytes, undefined, '…and NOT as `maxBytes`, so the owner\'s budget still decides under it');
  eq(store.calls[0].opts.include, 'changed', '…with the bootstrap\'s own default include mode');
  eq(store.calls[0].domain, 'articles', '…for the right domain');
  eq(store.calls[0].project, 'curator', '…and the right project');
  eq(out.summary.budgetChars, PROJECT_CONTEXT_BUDGET_CHARS, 'the summary states the budget it was given');
  ok(out.summary.chars > 0, '…and the characters actually spent');

  // SCOPE IS PASSED THROUGH VERBATIM — resolving `latest` is the store's job
  // and this app has already deleted one duplicate of that resolution.
  const s2 = fakeStore([envelope()]);
  await loadProjectContext('articles', 'curator', { scope: 'session-2', queryContext: 'x', getProjectContext: s2 });
  eq(s2.calls[0].opts.scope, 'session-2', 'a named scope reaches the store verbatim');
  const s3 = fakeStore([envelope()]);
  await loadProjectContext('articles', 'curator', { queryContext: 'x', getProjectContext: s3 });
  eq(s3.calls[0].opts.scope, undefined, 'no scope ⇒ undefined, so the STORE decides what "latest" means');

  // EVERY DISCLOSURE REACHES THE PROMPT. Dropping a field the store computed
  // honestly is this repo's most-repeated defect class.
  const noisy = envelope({
    foundations: {
      budget: { maxBytes: PROJECT_CONTEXT_BUDGET_CHARS, usedBytes: 9, truncated: true, omitted: ['conventions.md'] },
      requestedRefused: [{ slug: 'ghost.md', reason: 'not-found' }],
      unreadable: ['broken.md'],
      manifestError: 'bad json',
      budgetExceeded: true, totalBytes: 300000, budgetBytes: 204800,
      staleCount: 2, unreachableCount: 1,
    },
  });
  const notes = projectOmissionNotes(noisy, []);
  const joined = notes.join(' | ');
  ok(/conventions\.md/.test(joined), 'a budget-omitted document is named');
  ok(/ghost\.md/.test(joined) && /not-found/.test(joined), 'a refused document is named WITH its reason');
  ok(/broken\.md/.test(joined), 'an unreadable document is named');
  ok(/manifest/.test(joined), 'a manifest error is disclosed');
  ok(/over its/.test(joined), 'an over-budget project is disclosed');
  ok(/STALE/.test(joined), 'stale documents are disclosed');
  ok(/could not be checked/.test(joined), 'unreachable documents are disclosed');

  const noisyBlock = renderProjectContextBlock({
    ctx: noisy, authority: 'owner', journalEntries: [], docs: [],
  });
  ok(noisyBlock.includes('[What this project context does NOT include]'),
    'the block carries an explicit "what is missing" section');
  for (const n of notes) {
    ok(noisyBlock.includes(n), `…and it carries the note: "${n.slice(0, 48)}…"`);
  }
  // CONTROL: a clean envelope, with EVERY journal entry selected, must not
  // grow a section about nothing. The journal is overridden to two entries
  // and both are passed, because "1 of 4 shown" is itself a real omission
  // and is disclosed — which is the behaviour, not an exception to it.
  const cleanCtx = envelope({
    journal: {
      entries: [
        { at: '2026-09-19T09:58:00.000Z', headline: 'a', rejections: [] },
        { at: '2026-09-18T09:00:00.000Z', headline: 'b', rejections: [] },
      ],
      returned: 2, total: 2, totalUnknown: false,
    },
  });
  const cleanBlock = renderProjectContextBlock({
    ctx: cleanCtx, authority: 'owner', journalEntries: cleanCtx.journal.entries, docs: [],
  });
  ok(!cleanBlock.includes('does NOT include'),
    'CONTROL: with nothing omitted, no "what is missing" section is invented');
  // …and the OTHER direction of the same fact: a journal the block did not
  // show in full says so, because "we read the journal" and "we read two of
  // its twelve entries" are different claims.
  const partial = renderProjectContextBlock({
    ctx: cleanCtx, authority: 'owner', journalEntries: cleanCtx.journal.entries.slice(0, 1), docs: [],
  });
  ok(/Journal: 1 of 2/.test(partial),
    'CONTROL: showing fewer journal entries than were read IS disclosed');

  // A STORE REFUSAL IS A REFUSAL — never a silent wiki-only answer.
  const refusing = fakeStore([{ ok: false, reason: 'not-found', message: 'no such project' }]);
  const bad = await loadProjectContext('articles', 'ghost', { queryContext: 'x', getProjectContext: refusing });
  ok(bad.ok === false, 'a store refusal is returned as a refusal');
  eq(bad.reason, 'not-found', '…carrying the store\'s own reason');
  ok(!('block' in bad), '…and NO block, so a caller cannot accidentally answer from half of one');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — THE ROUTE');
// ═════════════════════════════════════════════════════════════════════════
{
  // THE PINNED LINE. test-chat-model.js:2206 pins this exact destructure with
  // a source regex; the two new fields must NOT have joined it.
  ok(/const \{ message, conversationId, responseStyle, provider, model \} = req\.body;/.test(routeSrc),
    'the pinned destructure at :238 is byte-unchanged');
  ok(/req\.body\.project === 'string'/.test(routeSrc), '`project` is read on its own line');
  ok(/req\.body\.scope === 'string'/.test(routeSrc), '`scope` is read on its own line');

  // EVERY REFUSAL ABOVE flushHeaders(). Positional, because the route's own
  // comment says the ordering IS the guarantee: after flushHeaders a 400 is a
  // no-op and the client is already parsing frames.
  const flushAt = routeSrc.indexOf('res.flushHeaders()');
  ok(flushAt > 0, 'flushHeaders() is where the route says it is');
  for (const reason of ['invalid_project', 'reserved_project', 'project_not_found']) {
    const at = routeSrc.indexOf(`reason: '${reason}'`);
    ok(at > 0 && at < flushAt, `the ${reason} refusal is raised ABOVE flushHeaders()`);
  }
  ok(routeSrc.indexOf('isSafeSegment(wantsProject)') < flushAt,
    'the name check runs above flushHeaders() too');
  ok(routeSrc.indexOf('listProjects(domain, { namesOnly: true })') < flushAt,
    '…and so does the existence check');

  // THE VALIDATORS ARE THE STORE'S, not new ones.
  ok(/import \{ isSafeSegment, listProjects \} from '\.\.\/brain\/working-state\.js';/.test(routeSrc),
    'the route imports the STORE\'s own predicate rather than restating it');

  // SCOPE IS DELIBERATELY NOT VALIDATED.
  ok(!/isSafeSegment\(wantsScope\)/.test(routeSrc) && !/RESERVED.*wantsScope/.test(routeSrc),
    'scope is NOT validated at the route — the store owns what `latest` means');
  ok(/routes\/memory\.js passes `scope` through verbatim|DELIBERATELY NOT VALIDATED/.test(routeSrc),
    '…and the route says why, so the omission reads as a decision');

  // THE RESERVED LIST IS IN STEP WITH routes/memory.js's.
  const parse = (src) => {
    const m = /RESERVED_PROJECT_NAMES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : null;
  };
  const here = parse(routeSrc);
  const there = parse(memorySrc);
  ok(!!here && !!there, 'both reserved-name lists parse');
  eq(JSON.stringify(here), JSON.stringify(there),
    'chat\'s reserved project names are the SAME SET as the memory route\'s — a name refused there cannot be accepted here');

  // CHAT NEVER WRITES TO STATE. Not "does not today" — asserted.
  ok(!/saveWorkingState|saveProjectBrief|saveFoundation|setFoundationReadFirst/.test(routeSrc),
    'the chat route imports no memory-layer WRITE');
  ok(!/saveWorkingState|saveProjectBrief|saveFoundation|setFoundationReadFirst/.test(brainSrc),
    '…and neither does src/brain/chat.js');
  ok(/getProjectContext/.test(brainSrc), 'CONTROL: it does import the READ, so the absence above is not vacuous');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — THE DUPLICATED CLASSIFIER MUST NOT DRIFT');
// ═════════════════════════════════════════════════════════════════════════
{
  // classifyBriefAuthority is not exported from mcp/tools/working-state.js
  // (it is module-private), so it is EXTRACTED by brace-match and executed
  // with `isDomainReadonly` injected. A desync throws rather than silently
  // testing nothing.
  function extractFunction(src, name) {
    const m = new RegExp(`\\nasync function ${name}\\s*\\(`).exec(src);
    if (!m) throw new Error(`classifier "${name}" not found in mcp/tools/working-state.js`);
    const start = m.index + 1;
    let i = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const out = src.slice(start, i);
    if (!/\n\}$/.test(out)) throw new Error(`extraction of "${name}" desynced`);
    return out;
  }
  const mcpClassifier = new Function('isDomainReadonly',
    extractFunction(mcpSrc, 'classifyBriefAuthority') + '\nreturn classifyBriefAuthority;');

  const CASES = [
    ['absent brief', 'articles', { present: false }, null],
    ['suspect headings', 'articles', { present: true, headingsSuspect: true }, 'suspect'],
    ['sanitised on read', 'articles', { present: true, sanitisedOnRead: true }, 'suspect'],
    ['shared- domain', 'shared-cohort', { present: true }, 'mirror'],
    ['owner, no stamp', 'articles', { present: true, authoredBy: null }, 'owner'],
    ['agent-stamped', 'articles', { present: true, authoredBy: { kind: 'agent' } }, 'commissioned'],
    ['unknown stamp', 'articles', { present: true, authoredBy: { kind: 'unknown' } }, 'commissioned'],
    ['human stamp', 'articles', { present: true, authoredBy: { kind: 'human' } }, 'owner'],
  ];
  const mcpFn = mcpClassifier(async () => false);
  for (const [label, domain, brief, expected] of CASES) {
    const mine = await classifyChatBriefAuthority(domain, brief);
    const theirs = await mcpFn(domain, brief);
    eq(mine, expected, `${label}: chat's verdict`);
    eq(theirs, mine, `${label}: the MCP's classifier agrees`);
  }
  // A readonly DOMAIN (not a `shared-` name) is a mirror on both sides.
  const mcpReadonly = mcpClassifier(async () => true);
  eq(await mcpReadonly('cohort', { present: true }), 'mirror',
    'a readonly domain classifies as `mirror` in the MCP');
  // CONTROL: a planted divergence must be visible to this comparison.
  const mcpBroken = mcpClassifier(async () => false);
  const planted = (d, b) => (b?.present ? 'owner' : null);   // ignores every downgrade
  ok(planted('articles', { present: true, headingsSuspect: true })
    !== await mcpBroken('articles', { present: true, headingsSuspect: true }),
    'CONTROL: a classifier that skipped the suspect arm WOULD disagree, so the comparison above can fail');

  // EVERY NOTE COMES FROM THE SHARED CONSTANT, not from a ternary here.
  for (const a of ['owner', 'commissioned', 'mirror', 'suspect', 'unverified']) {
    const note = briefAuthorityNote(a);
    ok(typeof note === 'string' && note.length > 50, `briefAuthorityNote("${a}") returns real prose`);
  }
  ok(briefAuthorityNote('mirror') !== briefAuthorityNote('owner'),
    'CONTROL: the five verdicts are not all the same sentence');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — SELECTION: read-first always, the rest by keyword, all bounded');
// ═════════════════════════════════════════════════════════════════════════
{
  const ctx = envelope();
  const tokens = (s) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  // READ-FIRST ALWAYS. The store sends it; the loader must not drop it.
  const store = fakeStore([ctx, envelope({ foundations: { requested: [] } })]);
  const out = await loadProjectContext('articles', 'curator', {
    queryContext: 'tell me about the architecture', getProjectContext: store,
  });
  ok(out.ok && out.block.includes('ARCH BODY'),
    'the read-first document\'s body is in the block');
  eq(out.summary.documents, 1, '…and counted');

  // KEYWORD MATCHING opens an unflagged document — and only through the
  // store's own `slugs` door.
  const withDecisions = fakeStore([
    envelope(),
    envelope({
      foundations: {
        documents: [],
        requested: [{ slug: 'decisions.md', role: 'decisions', title: 'Decision log', text: 'DECISION BODY', sha256: 'b', bytes: 13 }],
      },
    }),
  ]);
  const out2 = await loadProjectContext('articles', 'curator', {
    queryContext: 'what did we decide about decisions', getProjectContext: withDecisions,
  });
  eq(withDecisions.calls.length, 2, 'a keyword match makes a SECOND store call');
  eq(withDecisions.calls[1].opts.include, 'index',
    '…asking for no bodies, so the read-first set is not read and charged twice');
  ok(Array.isArray(withDecisions.calls[1].opts.slugs) && withDecisions.calls[1].opts.slugs.includes('decisions.md'),
    '…and naming the matched document through the store\'s own `slugs` door');
  ok(out2.block.includes('DECISION BODY'), 'the matched document\'s body reaches the block');
  ok(out2.block.includes('ARCH BODY'), '…alongside the read-first one, not instead of it');
  eq(out2.summary.extraStoreCalls, 1, 'the summary reports the extra call honestly');

  // NO MATCH ⇒ NO SECOND CALL. A chat turn must not pay for a read it has no
  // reason to make.
  const noMatch = fakeStore([envelope()]);
  await loadProjectContext('articles', 'curator', {
    queryContext: 'something about zebras', getProjectContext: noMatch,
  });
  eq(noMatch.calls.length, 1, 'with no keyword match there is ONE call');

  // NOTHING FLAGGED ⇒ ONE CALL, EVER. The store already sent the bodies.
  const flat = fakeStore([envelope({ foundations: { bodySelection: 'all' } })]);
  await loadProjectContext('articles', 'curator', {
    queryContext: 'what did we decide about decisions', getProjectContext: flat,
  });
  eq(flat.calls.length, 1, 'with no read-first flag there is ONE call whatever the question');

  // THE CAP.
  const many = envelope({
    foundations: {
      index: Array.from({ length: 10 }, (_, i) => ({
        slug: `decisions-${i}.md`, role: 'decisions', title: 'Decision log', sha256: String(i),
        bytes: 10, freshness: 'fresh', fileMissing: false, skeleton: false, readFirst: false,
      })),
      documents: [], requested: [],
    },
  });
  const picked = selectExtraFoundationSlugs(many, tokens('decisions decision log'));
  eq(picked.length, PROJECT_EXTRA_FOUNDATIONS_MAX,
    `a keyword match opens at most ${PROJECT_EXTRA_FOUNDATIONS_MAX} unflagged documents`);

  // A SKELETON IS NEVER OPENED BY A KEYWORD MATCH — it is a list of
  // QUESTIONS, so the match would be against the prompts themselves.
  const skeletons = envelope({
    foundations: {
      index: [{ slug: 'decisions.md', role: 'decisions', title: 'Decision log', sha256: 'b', bytes: 10, freshness: 'fresh', fileMissing: false, skeleton: true, readFirst: false }],
      documents: [], requested: [],
    },
  });
  eq(selectExtraFoundationSlugs(skeletons, tokens('decisions decision log')).length, 0,
    'a SKELETON is never opened by a keyword match');

  // A MISSING FILE is never named either.
  const missing = envelope({
    foundations: {
      index: [{ slug: 'decisions.md', role: 'decisions', title: 'Decision log', sha256: 'b', bytes: 10, freshness: 'fresh', fileMissing: true, skeleton: false, readFirst: false }],
      documents: [], requested: [],
    },
  });
  eq(selectExtraFoundationSlugs(missing, tokens('decisions')).length, 0,
    'a document whose file is missing is never requested');

  // A DOCUMENT ALREADY SENT is not requested a second time.
  const alreadySent = envelope({
    foundations: {
      documents: [{ slug: 'decisions.md', text: 'x' }],
      index: [{ slug: 'decisions.md', role: 'decisions', title: 'Decision log', sha256: 'b', bytes: 10, freshness: 'fresh', fileMissing: false, skeleton: false, readFirst: true }],
    },
  });
  eq(selectExtraFoundationSlugs(alreadySent, tokens('decisions')).length, 0,
    'a document whose body is already in hand is not fetched again');

  // THE JOURNAL: matched first, bounded, with a stated floor.
  const matched = selectJournalEntries(ctx, tokens('retrieval'));
  eq(matched.length, 1, 'a keyword match selects the matching journal entries');
  ok(/retrieval/.test(matched[0].headline), '…and it is the right one');
  const floored = selectJournalEntries(ctx, tokens('zebras'));
  eq(floored.length, PROJECT_JOURNAL_FLOOR,
    `with NO match the newest ${PROJECT_JOURNAL_FLOOR} are still included — a wider reading of D-N, and the block states how many of how many`);
  const bigJournal = envelope({
    journal: {
      entries: Array.from({ length: 20 }, (_, i) => ({ at: `2026-09-0${i % 9 + 1}T00:00:00.000Z`, headline: 'retrieval work', rejections: [] })),
      returned: 20, total: 20, totalUnknown: false,
    },
  });
  eq(selectJournalEntries(bigJournal, tokens('retrieval')).length, PROJECT_JOURNAL_MAX,
    `the journal is capped at ${PROJECT_JOURNAL_MAX} entries however many match`);
  const shown = projectOmissionNotes(bigJournal, selectJournalEntries(bigJournal, tokens('retrieval')));
  ok(shown.some((n) => /Journal: 6 of 20/.test(n)),
    '…and the block DISCLOSES that it is showing 6 of 20, rather than implying it read them all');
  eq(selectJournalEntries(envelope({ journal: { entries: [], returned: 0, total: 0 } }), tokens('x')).length, 0,
    'an empty journal yields nothing — never an invented entry');

  // THE QUERY CONTEXT IS THE SAME ONE THE WIKI SCORES AGAINST.
  /* THREE user turns in the fixture, deliberately: with only one, a change
     from `slice(-2)` to `slice(-3)` is invisible — measured, a mutation that
     widened the window stayed GREEN against a one-turn history. The window
     matters because the project selection and the wiki selection must score
     against the SAME text; widening one of them silently widens neither. */
  const LONG = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'a' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'c' },
  ];
  eq(composeQueryContext(LONG, 'now'), 'second third now',
    'the query context is the last TWO user turns plus this message — not three, not one');
  ok(!composeQueryContext(LONG, 'now').includes('first'),
    '…so an older turn is outside the window');
  ok(!composeQueryContext(LONG, 'now').includes('a'),
    '…and assistant turns are never in it');
  eq(composeQueryContext(HISTORY, 'and HNSW?'), 'what is retrieval and HNSW?',
    'the same window on the two-message fixture the rest of this suite uses');
  eq(composeQueryContext([], 'alone'), 'alone', '…and it degrades to the message alone on a fresh thread');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — THE SECOND CALL\'S OWN BUDGET, AND ITS DISCLOSURE');
// ═════════════════════════════════════════════════════════════════════════
{
  // `slugs` is NOT capped by maxBytes at the store — a caller that named a
  // document asked for that document — so the remaining budget is enforced
  // HERE, and a drop must be named rather than silent.
  const huge = 'x'.repeat(PROJECT_CONTEXT_BUDGET_CHARS + 10);
  const store = fakeStore([
    envelope(),
    envelope({
      foundations: {
        documents: [],
        requested: [{ slug: 'decisions.md', role: 'decisions', title: 'Decision log', text: huge, sha256: 'b', bytes: huge.length }],
      },
    }),
  ]);
  const out = await loadProjectContext('articles', 'curator', {
    queryContext: 'decisions decision log', getProjectContext: store,
  });
  eq(store.calls.length, 2, 'the second call was made');
  ok(!out.block.includes(huge), 'an over-budget named document is NOT pasted into the prompt');
  ok(out.block.includes('decisions.md'),
    '…and it is NAMED as omitted, so the model is told what it is not seeing');
  ok(out.summary.notes.some((n) => /decisions\.md/.test(n)),
    '…and the summary carries the same note, for the surface above');

  // A FAILING second call must not take the whole turn down.
  const halfBroken = fakeStore([envelope(), { ok: false, reason: 'io', message: 'disk' }]);
  const out2 = await loadProjectContext('articles', 'curator', {
    queryContext: 'decisions decision log', getProjectContext: halfBroken,
  });
  ok(out2.ok, 'a failed SECOND call still yields the bootstrap it already has');
  ok(out2.block.includes('ARCH BODY'), '…with the read-first body intact');

  // REFUSALS FROM THE SECOND CALL TRAVEL.
  const refusing = fakeStore([
    envelope(),
    envelope({ foundations: { documents: [], requested: [], requestedRefused: [{ slug: 'decisions.md', reason: 'file-missing' }] } }),
  ]);
  const out3 = await loadProjectContext('articles', 'curator', {
    queryContext: 'decisions decision log', getProjectContext: refusing,
  });
  ok(out3.block.includes('file-missing'),
    'a refusal raised by the second call reaches the prompt with its reason');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — SOURCE GUARDS');
// ═════════════════════════════════════════════════════════════════════════
{
  // The framing comes from the EXTRACTED module, never from mcp/.
  ok(/from '\.\/context-framing\.js'/.test(brainSrc),
    'chat.js imports the framing from src/brain/context-framing.js');
  ok(!/from '\.\.\/\.\.\/mcp\//.test(brainSrc) && !/from '.*mcp\/tools/.test(brainSrc),
    'chat.js imports nothing from mcp/ — the direction stays DOWN only');
  // The store is called in-process, not over HTTP.
  ok(/from '\.\/working-state\.js'/.test(brainSrc),
    'the bootstrap is called in-process, by import');
  ok(!/fetch\(.*api\/memory/.test(brainSrc), '…and not over an HTTP hop');
  // The test-only seam is defaulted, so production never depends on it.
  ok(/typeof opts\.getProjectContext === 'function' \? opts\.getProjectContext : storeGetProjectContext/.test(brainSrc),
    'the seam defaults to the real store call — null in production, exactly like compile.js\'s generateText seam');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — documentChars (v3.66.0): the numerator the 40,000-character budget is about');
// ═════════════════════════════════════════════════════════════════════════
{
  // ONE DOCUMENT: its body only — not the brief, the handoff or the framing.
  const s1 = fakeStore([envelope({ foundations: { bodySelection: 'all' } })]);
  const o1 = await loadProjectContext('articles', 'curator', { queryContext: 'x', getProjectContext: s1 });
  eq(o1.summary.documentChars, 'ARCH BODY'.length, 'documentChars is the document body’s length alone (9)');
  ok(o1.summary.chars > o1.summary.documentChars + 'BRIEF BODY'.length + 'HANDOFF BODY'.length,
    '…while `chars` stays the WHOLE block — brief, handoff, journal and framing included — and keeps its meaning');

  // TWO DOCUMENTS, one from the second call: both bodies, nothing else.
  const s2 = fakeStore([
    envelope(),
    envelope({ foundations: { documents: [], requested: [{ slug: 'decisions.md', role: 'decisions', title: 'Decision log', text: 'DECISION BODY', sha256: 'b', bytes: 13 }] } }),
  ]);
  const o2 = await loadProjectContext('articles', 'curator', { queryContext: 'what did we decide about decisions', getProjectContext: s2 });
  eq(o2.summary.documentChars, 'ARCH BODY'.length + 'DECISION BODY'.length,
    'a document the keyword match opened is counted too (9 + 13)');

  // AN OMITTED DOCUMENT IS NOT COUNTED — it never reached the prompt.
  const huge = 'x'.repeat(PROJECT_CONTEXT_BUDGET_CHARS + 10);
  const s3 = fakeStore([
    envelope(),
    envelope({ foundations: { documents: [], requested: [{ slug: 'decisions.md', role: 'decisions', title: 'Decision log', text: huge, sha256: 'b', bytes: huge.length }] } }),
  ]);
  const o3 = await loadProjectContext('articles', 'curator', { queryContext: 'decisions decision log', getProjectContext: s3 });
  eq(o3.summary.documentChars, 'ARCH BODY'.length, 'a document the budget left out is NOT in documentChars');
  ok(o3.summary.documentChars <= o3.summary.budgetChars,
    'documentChars never exceeds budgetChars — a bar drawn from it cannot show an over-run that did not happen');

  // A DOCUMENT FILLING THE BUDGET reads at (not over) it.
  const full = 'y'.repeat(PROJECT_CONTEXT_BUDGET_CHARS);
  const s4 = fakeStore([envelope({ foundations: { bodySelection: 'all', documents: [{ slug: 'architecture.md', role: 'architecture', title: 'Architecture', text: full, sha256: 'a', bytes: full.length, readFirst: true, skeleton: false }] } })]);
  const o4 = await loadProjectContext('articles', 'curator', { queryContext: 'x', getProjectContext: s4 });
  eq(o4.summary.documentChars, PROJECT_CONTEXT_BUDGET_CHARS, 'a budget-filling document reads exactly 40,000');
  ok(o4.summary.chars > PROJECT_CONTEXT_BUDGET_CHARS,
    '…while `chars` passes the budget with nothing cut — why `chars ÷ budgetChars` was a false bar');

  // NO DOCUMENTS → a measured 0, not absent.
  const s5 = fakeStore([envelope({ foundations: { bodySelection: 'all', documents: [] } })]);
  const o5 = await loadProjectContext('articles', 'curator', { queryContext: 'x', getProjectContext: s5 });
  eq(o5.summary.documentChars, 0, 'no documents read → documentChars 0 (the project context WAS read; it held none)');
  eq(o5.summary.documents, 0, '…consistent with documents: 0');

  // THE SHAPE: every earlier key is still there, byte-compatible, plus the one.
  const keys = Object.keys(o1.summary);
  for (const k of ['project', 'domain', 'scope', 'chars', 'briefPresent', 'briefAuthority', 'handoffPresent',
    'journalEntries', 'documents', 'budgetChars', 'extraStoreCalls', 'notes', 'documentChars']) {
    ok(keys.includes(k), `summary still carries \`${k}\``);
  }
  eq(keys.length, 13, 'the summary carries exactly the twelve earlier keys plus documentChars');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat project-context assertions green');
