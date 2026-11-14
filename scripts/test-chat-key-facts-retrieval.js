#!/usr/bin/env node
/**
 * Chat retrieval sees a summary's `## Key Facts` section (2026-11-14). Offline.
 *
 * Ingest keeps a data source's figures in a Key Facts section on its summary, below
 * chat's 600-character scoring head, so "what is the cancellation fee?" scored the
 * page 0 and it was never loaded. scorePage now adds the section's query tokens once
 * each (1x, like the head), on summaries only. This suite holds:
 *   1. a page with no Key Facts section scores EXACTLY as before, over a fixture wiki
 *      and many queries (against an independent copy of the old formula), and the
 *      selection order is unchanged;
 *   2. an entity page with Key Facts (the business/tech templates have long had one)
 *      scores as before: summaries only;
 *   3. the summary whose section holds the answer is now selected; the same text under
 *      another heading is not (control);
 *   4. each token counts once; the head is not counted twice; the scan is capped.
 */
import { tokenize } from '../src/brain/sharedbrain-delta.js';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, label) => ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = (t) => console.log(`\n${t}`);

const chat = await import('../src/brain/chat.js');
const { scorePage } = chat.__testing;
const { selectRelevantPages } = chat;

// The v3.97.1 formula, written out independently: slug 3x, title 2x, 600-char head 1x.
function oldScore(page, q) {
  if (q.size === 0) return 0;
  let s = 0;
  for (const t of page.path.split('/').pop().replace(/\.md$/, '').split('-').filter((x) => x.length > 1)) if (q.has(t)) s += 3;
  const m = page.content.match(/^#{1,3}\s+(.+)/m);
  if (m) for (const t of tokenize(m[1])) if (q.has(t)) s += 2;
  for (const t of tokenize(page.content.slice(0, 600))) if (q.has(t)) s += 1;
  return s;
}

const filler = (n) => Array.from({ length: n }, (_, i) => `- Point ${i} about orchards, rivers and harbour trade routes.`).join('\n');
const WIKI = [
  { path: 'entities/harbour-board.md', content: `# Harbour Board\n\n## Summary\nThe harbour board sets fees.\n\n${filler(20)}\n\n## Key Facts\n- Mooring fee (2028): €40 a night\n- Cancellation fee: 30% of the deposit\n` },
  { path: 'concepts/trade-routes.md', content: `# Trade Routes\n\n## Definition\nHow goods move by river.\n\n${filler(15)}\n` },
  { path: 'concepts/orchards.md', content: `# Orchards\n\n${filler(30)}\n\n## Notes\n- Cancellation fee for orchard tours: €12\n` },
  { path: 'summaries/river-essay.md', content: `---\ntype: summary\n---\n# River Essay\n\n## Key Takeaways\n${filler(25)}\n` },
  { path: 'summaries/tour-pricing-2028.md', content: `---\ntype: summary\nsource: tour-pricing-2028.md\n---\n# Tour Pricing 2028\n\n## Key Takeaways\n${filler(12)}\n\n## Key Facts\n- Participant price (2028): €2,000 per participant\n- Cancellation fee: 30% of the minimum (€1,680), after the 21-day deadline\n- fee fee fee fee fee fee fee fee fee fee\n` },
];
const QUERIES = ['What is the cancellation fee?', 'How much would I earn with 14 participants?', 'tell me about orchards', 'harbour board fees',
  'trade routes and rivers', 'river essay summary', 'what does the mooring cost', 'deadline', 'point 3', ''];

// ── 1 ────────────────────────────────────────────────────────────────────────
section('1. a page without Key Facts scores exactly as before');
{
  let checked = 0, diff = 0;
  for (const p of WIKI.filter((x) => !/^## Key Facts/m.test(x.content))) for (const q of QUERIES) {
    const qt = new Set(tokenize(q));
    checked++;
    if (scorePage(p, qt) !== oldScore(p, qt)) diff++;
  }
  eq(diff, 0, `0 of ${checked} (page, query) scores differ from the v3.97.1 formula`);
  const plain = WIKI.filter((x) => !/^## Key Facts/m.test(x.content));
  for (const q of QUERIES) {
    const got = selectRelevantPages(plain, q).selected.map((s) => s.page.path).join();
    const qt = new Set(tokenize(q));
    const want = plain.map((page) => ({ page, score: oldScore(page, qt) })).filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path)).map((s) => s.page.path).join();
    if (want) eq(got, want, `selection unchanged for "${q}"`);
  }
}

// ── 2 ────────────────────────────────────────────────────────────────────────
section('2. entity pages with Key Facts score as before (summaries only)');
{
  const ent = WIKI[0];
  for (const q of QUERIES) { const qt = new Set(tokenize(q)); eq(scorePage(ent, qt), oldScore(ent, qt), `entity page, "${q}"`); }
}

// ── 3 ────────────────────────────────────────────────────────────────────────
section('3. the summary that holds the answer is loaded');
{
  const sum = WIKI[4];
  ok(sum.content.indexOf('## Key Facts') > 600, 'CONTROL: the section starts past the 600-character head');
  const q = new Set(tokenize('What is the cancellation fee?'));
  eq(oldScore(sum, q), 0, 'CONTROL: the old formula scores it 0 (the measured failure)');
  eq(scorePage(sum, q), 2, 'now "cancellation" and "fee" count, once each');
  const sel = selectRelevantPages(WIKI, 'What is the cancellation fee?').selected.map((s) => s.page.path);
  ok(sel.includes('summaries/tour-pricing-2028.md'), 'selectRelevantPages loads it', sel.join());
  ok(!selectRelevantPages(WIKI, 'How much would I earn with 14 participants?').selected.some((s) => s.page.path === 'summaries/tour-pricing-2028.md'),
    'KNOWN: tokens match exactly, with no stemming: "participants" does not find "participant"');
  const renamed = { ...sum, content: sum.content.replace('## Key Facts', '## Figures') };
  eq(scorePage(renamed, q), 0, 'CONTROL: the same text under another heading is not scored');
}

// ── 4 ────────────────────────────────────────────────────────────────────────
section('4. bounded: once per token, no double count, capped scan');
{
  const q = new Set(['fee']);
  const sum = WIKI[4];
  eq(scorePage(sum, q), 1, 'ten repetitions of "fee" in the section still count once');
  const early = { path: 'summaries/s.md', content: `# S\n\n## Key Facts\n- fee: €5\n` };
  eq(scorePage(early, q), oldScore(early, q), 'a section inside the head is not counted again');
  const far = { path: 'summaries/f.md', content: `# F\n\n## Key Facts\n${'- filler line with no match at all here\n'.repeat(200)}- fee: €5\n` };
  eq(scorePage(far, q), 0, 'text past the 6,000-character scan cap is not read');
  const next = { path: 'summaries/n.md', content: `# N\n\n${filler(12)}\n\n## Key Facts\n- price €5\n\n## Notes\n- fee here\n` };
  eq(scorePage(next, q), 0, 'the section ends at the next heading');
}

console.log(`\n${'─'.repeat(60)}\nPassed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat Key Facts retrieval assertions green');
