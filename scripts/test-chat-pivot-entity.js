#!/usr/bin/env node
/**
 * A pivot's own entity page is always loaded, first, however large it is (2026-11-14). Offline.
 *
 * When a question names an entity, chat force-loads that entity page and the summaries
 * it links. An attempted fix for crowding (deferring every priority page over 12 KB to
 * the end of the list) deferred the PIVOT ENTITY page itself when it was large, and it
 * then no longer fit: an audit of "What is <entity>?" over all 1,417 real entities lost
 * the entity page in 31 cases (a 39 KB person page, large company pages). That change
 * was withdrawn; this suite pins the property so no later reordering can break it.
 * Synthetic fixtures only.
 *
 *   1. a 40 KB entity page whose linked summaries alone exceed the budget is loaded, first;
 *   2. over generated wikis, the first (strongest) pivot's entity page, when it fits
 *      the budget on its own, is loaded and is the first page selected.
 *
 * NOT pinned, because main does not guarantee it: with several pivots, a LATER pivot's
 * entity page comes after the earlier pivot's linked summaries and can be crowded out
 * (211 of 1,200 generated cases). Loading every pivot entity page first is a change
 * to chat's selection that has not been measured on real answers.
 */
let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);
const { selectRelevantPages, detectEntityPivots } = await import('../src/brain/chat.js');

let seed = 31337;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const W = ['orchard', 'harbour', 'ledger', 'falcon', 'quarry', 'meadow', 'beacon', 'cipher', 'lantern', 'glacier'];
const body = (title, len) => { let b = `# ${title}\n\n`; while (b.length < len) b += `${W[Math.floor(rnd() * W.length)]} ${W[Math.floor(rnd() * W.length)]} line.\n`; return b; };
const entity = (slug, len, links) => ({ path: `entities/${slug}.md`, content: `${body(slug, len)}\n## Sources\n${links.map((s) => `- [[summaries/${s}]]`).join('\n')}\n` });

section('1. a large pivot entity page is loaded, first');
{
  const links = Array.from({ length: 8 }, (_, i) => `zephyr-note-${i}`);
  const pages = [entity('zephyrlink', 40000, links), ...links.map((s) => ({ path: `summaries/${s}.md`, content: body(s, 9000) }))];
  const r = selectRelevantPages(pages, 'What is Zephyrlink?');
  ok(r.selected[0]?.page.path === 'entities/zephyrlink.md', 'the 40 KB entity page is the first page loaded', r.selected.map((s) => s.page.path).join(', '));
  ok(r.selected[0]?.page.content === pages[0].content, 'whole, not cut');
}

section('2. the first pivot\'s entity page is always loaded, first');
{
  let cases = 0, lost = 0, notFirst = 0;
  for (let w = 0; w < 300; w++) {
    const nS = 4 + Math.floor(rnd() * 12);
    const sums = Array.from({ length: nS }, (_, i) => ({ path: `summaries/s${i}-${W[i % W.length]}.md`, content: body(`s${i}`, 500 + rnd() * (rnd() < 0.3 ? 30000 : 9000)) }));
    const names = ['zephyrlink', 'north-quarry'];
    const ents = names.map((n) => entity(n, 1000 + rnd() * (rnd() < 0.5 ? 45000 : 8000), sums.filter(() => rnd() < 0.7).map((p) => p.path.slice(10, -3))));
    const pages = [...ents, ...sums];
    for (const q of ['What is zephyrlink?', 'tell me about the north quarry', 'zephyrlink and north quarry ledger']) {
      const pivots = detectEntityPivots(q, pages);
      const sel = selectRelevantPages(pages, q).selected.map((s) => s.page.path);
      const pv = pivots[0];
      if (pv && pv.page.content.length + pv.page.path.length + 30 <= 60000) { cases++; if (!sel.includes(pv.page.path)) lost++; }
      if (pivots.length && sel[0] !== pivots[0].page.path) notFirst++;
    }
  }
  ok(cases > 400, `${cases} pivot entity pages checked`);
  ok(lost === 0, 'not one of them is left out', `${lost} lost`);
  ok(notFirst === 0, 'the first pivot\'s entity page is always the first page selected', `${notFirst}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
