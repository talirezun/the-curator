#!/usr/bin/env node
/**
 * One oversized linked page can no longer crowd a pivot's small pages out of chat (2026-11-14). Offline.
 *
 * When a question names an entity, chat force-loads the entity page and every
 * summary it links, in LINK ORDER, greedily, skipping what no longer fits the 60 KB
 * budget. A 50 KB overview linked early took the budget and the 2.4 KB summary with
 * the answer, linked later, was never loaded. deferOversizedPriority (src/brain/chat.js)
 * now moves an oversized linked page (> OVERSIZE_SHARE of the budget) to the end of the
 * priority list, ONLY when the priority pages do not all fit, and only when the page's
 * slug or title names no question word other than its pivot's own. Nothing else moves.
 *
 * Sections (synthetic fixtures only; no real page text):
 *   1. whenever the priority pages fit, OR none of them is oversized, the selection is
 *      EXACTLY the pre-change one (paths, order, scores, flags, bytes) over generated
 *      wikis x queries, against an independent copy of the old loop; a positive
 *      control proves the comparator sees the crowded case;
 *   2. the crowded case: the small answer page is loaded, the entity stays first, and
 *      no page is ever cut (every selected page is byte-identical to its source);
 *   3. a deferred page is still loaded WHOLE when it fits after the smaller pages;
 *   4. the exception: an oversized page named by another question word stays in link
 *      order; the same page without that word is deferred; a digit does not count;
 *   5. no keyword-scored page is ever admitted ahead of a priority page;
 *   6. the budgets: over 1,500 generated crowded wikis the selection never exceeds 60 KB
 *      or 50 pages (nor a custom budget), and contentBytes is the sum of the costs;
 *   7. deferOversizedPriority itself: the list returned as it came when everything fits,
 *      otherwise a permutation that keeps relative order within each half.
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
const { selectRelevantPages, detectEntityPivots, extractSummaryBacklinks, deferOversizedPriority, OVERSIZE_SHARE } = chat;
const { scorePage } = chat.__testing;
const BUDGET = 60000, MAXP = 50;
const cost = (p) => p.content.length + p.path.length + 30;

// ── The pre-change selection, written out independently ─────────────────────
function oldSelect(pages, queryText, { contentBudget = BUDGET, maxPages = MAXP } = {}) {
  const q = new Set(tokenize(queryText));
  const content = pages.filter((p) => p.path !== 'index.md' && p.path !== 'log.md');
  const pivots = detectEntityPivots(queryText, content);
  const prio = new Set();
  for (const pv of pivots) { prio.add(pv.page.path); for (const s of extractSummaryBacklinks(pv.page.content)) prio.add(`summaries/${s}.md`); }
  const pc = [];
  for (const p of prio) { const page = content.find((x) => x.path === p); if (page) pc.push({ page, score: 1000, priority: true }); }
  const scored = content.filter((p) => !prio.has(p.path)).map((page) => ({ page, score: scorePage(page, q) }))
    .filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path));
  const cands = (pc.length === 0 && scored.length === 0)
    ? content.map((page) => ({ page, score: (page.content.match(/\[\[/g) || []).length })).sort((a, b) => b.score - a.score).slice(0, 10)
    : [...pc, ...scored];
  const sel = []; let used = 0;
  for (const { page, score, priority } of cands) {
    if (sel.length >= maxPages) break;
    if (used + cost(page) > contentBudget) continue;
    sel.push({ page, score, priority: priority === true }); used += cost(page);
  }
  const prioCost = pc.reduce((n, c) => n + cost(c.page), 0);
  const fits = prioCost <= contentBudget && pc.length <= maxPages;
  const anyOversized = pc.some((c) => cost(c.page) > OVERSIZE_SHARE * contentBudget);
  return { sel, used, fits, anyOversized };
}
const sig = (sel) => sel.map((s) => `${s.page.path}:${s.score}:${s.priority}:${s.page.content.length}`).join('|');

let seed = 90210;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const WORDS = ['orchard', 'harbour', 'ledger', 'falcon', 'quarry', 'meadow', 'beacon', 'cipher', 'lantern', 'glacier', 'tariff', 'relay', 'storage', 'expiry', 'contract', 'vault', 'notary', 'registry'];
const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
const body = (title, len) => { let b = `# ${title}\n\n`; while (b.length < len) b += `${words(10)}.\n`; return b; };
function genWiki(scale, bigChance, manyMedium = false) {
  const pages = [];
  const sums = [];
  const nS = manyMedium ? 12 + Math.floor(rnd() * 7) : 3 + Math.floor(rnd() * 9);
  for (let i = 0; i < nS; i++) {
    const slug = `s${i}-${pick(WORDS)}`;
    const big = rnd() < bigChance;
    // manyMedium: many pages each just UNDER the oversize share, so the priority
    // pages overflow the budget while none of them is oversized.
    const len = Math.floor(manyMedium ? 5000 + rnd() * 6500 : big ? 13000 + rnd() * 45000 : (200 + rnd() * 9000) * scale);
    pages.push({ path: `summaries/${slug}.md`, content: body(slug.replace(/-/g, ' '), len) });
    sums.push(slug);
  }
  for (const e of ['zephyrlink', 'north-quarry']) {
    const linked = sums.filter(() => rnd() < 0.7);
    pages.push({ path: `entities/${e}.md`, content: `# ${e}\n\n${words(30)}\n\n## Sources\n${linked.map((s) => `- [[summaries/${s}]]`).join('\n')}\n` });
  }
  for (let i = 0; i < 14; i++) {
    const a = pick(WORDS), b = pick(WORDS);
    pages.push({ path: `concepts/${a}-${b}-${i}.md`, content: body(`${a} ${b}`, 200 + rnd() * 3000 * scale) });
  }
  return pages;
}
const QUERIES = () => [`what does zephyrlink do with ${pick(WORDS)}?`, `north quarry ${pick(WORDS)} ${pick(WORDS)}`,
  `zephyrlink and the north quarry ${pick(WORDS)}`, `${pick(WORDS)} ${pick(WORDS)}`, `tell me about ${pick(WORDS)} 2028`];

// ── 1 ────────────────────────────────────────────────────────────────────────
section('1. when the priority pages fit, or none is oversized, the selection is exactly as before');
{
  let checked = 0, diff = 0, fitCases = 0, notOversizedOverflow = 0, firstDiff = '';
  let crowdedSeen = 0, crowdedDiffers = 0;
  for (let w = 0; w < 300; w++) {
    const pages = w % 3 === 2 ? genWiki(1, 0, true) : genWiki(0.3 + rnd() * 2.5, rnd() < 0.5 ? 0 : 0.25);
    for (const q of QUERIES()) {
      const old = oldSelect(pages, q);
      const now = selectRelevantPages(pages, q);
      const same = sig(old.sel) === sig(now.selected) && old.used === now.contentBytes;
      if (old.fits || !old.anyOversized) {
        checked++;
        if (old.fits) fitCases++; else notOversizedOverflow++;
        if (!same) { diff++; if (!firstDiff) firstDiff = q; }
      } else { crowdedSeen++; if (!same) crowdedDiffers++; }
    }
  }
  ok(checked > 1000, `checked ${checked} wiki x query pairs (${fitCases} fit, ${notOversizedOverflow} overflow with no oversized page)`);
  ok(notOversizedOverflow > 50, 'the overflow-without-oversized path was exercised', `${notOversizedOverflow}`);
  eq(diff, 0, 'not one of them differs from the pre-change selection');
  if (firstDiff) console.log(`    first differing query: ${firstDiff}`);
  ok(crowdedSeen > 50 && crowdedDiffers > 0, `positive control: the comparator sees the crowded case differ (${crowdedDiffers} of ${crowdedSeen})`);
}

// ── shared fixture for 2-5 ───────────────────────────────────────────────────
const ENTITY = (links) => ({ path: 'entities/zephyrlink.md', content: `${body('Zephyrlink', 4300)}\n## Sources\n${links.map((s) => `- [[summaries/${s}]]`).join('\n')}\n` });
const S = (slug, len, extra = '') => ({ path: `summaries/${slug}.md`, content: body(slug.replace(/-/g, ' '), len) + extra });
const ANSWER = S('relay-architecture', 2400, '\n## Key Facts\n- The drop keeps ciphertext for 7 days.\n');
function crowdedWiki(overviewSlug = 'zephyrlink-overview') {
  return [
    ENTITY(['zephyrlink-guide', overviewSlug, 'hub-roundup', 'zephyrlink-020', 'relay-architecture']),
    S('zephyrlink-guide', 3900), S(overviewSlug, 50500), S('hub-roundup', 13500), S('zephyrlink-020', 1700), ANSWER,
    { path: 'concepts/harbour-ledger.md', content: body('harbour ledger', 1500) },
    { path: 'concepts/relay-drop.md', content: body('relay drop', 1200) + '\nzephyrlink drop expiry\n' },
  ];
}
const Q = 'In Zephyrlink, how long does the drop keep files?';

// ── 2 ────────────────────────────────────────────────────────────────────────
section('2. the crowded case: the small answer page is loaded, nothing is cut');
{
  const pages = crowdedWiki();
  const old = oldSelect(pages, Q);
  ok(!old.sel.some((s) => s.page.path === ANSWER.path), 'control: the pre-change selection skipped the answer page');
  const r = selectRelevantPages(pages, Q);
  const paths = r.selected.map((s) => s.page.path);
  ok(paths.includes(ANSWER.path), 'the answer page is loaded now', paths.join(', '));
  eq(paths[0], 'entities/zephyrlink.md', 'the entity page is still first');
  const byPath = new Map(pages.map((p) => [p.path, p]));
  ok(r.selected.every((s) => s.page === byPath.get(s.page.path) && s.page.content === byPath.get(s.page.path).content), 'every selected page is the source page, whole (nothing cut)');
  ok(!paths.includes('summaries/zephyrlink-overview.md'), 'the 50 KB overview did not fit after the smaller pages and is not loaded (never partly)');
  ok(r.contentBytes <= BUDGET, `within the budget (${r.contentBytes})`);
  ok(['summaries/zephyrlink-guide.md', 'summaries/zephyrlink-020.md'].every((p) => paths.includes(p)), 'the other small linked pages are loaded too');
}

// ── 3 ────────────────────────────────────────────────────────────────────────
section('3. a deferred page is loaded whole when it still fits');
{
  const pages = [ENTITY(['a-first', 'big-middle', 'c-last']), S('a-first', 9000), S('big-middle', 40000), S('c-last', 14000),
    { path: 'concepts/relay-drop.md', content: body('relay drop', 900) }];
  // 9 + 40 + 14 KB (+ entity) > 60 KB, so the rule acts; c-last (14 KB) is oversized too.
  const r = selectRelevantPages(pages, 'zephyrlink relay');
  const paths = r.selected.map((s) => s.page.path);
  const old = oldSelect(pages, 'zephyrlink relay');
  ok(old.sel.some((s) => s.page.path === 'summaries/big-middle.md') && !old.sel.some((s) => s.page.path === 'summaries/c-last.md'), 'control: before, the 40 KB page went in and the last one was shut out');
  ok(paths.includes('summaries/big-middle.md'), 'the 40 KB page is still loaded, after the smaller page', paths.join(', '));
  const big = r.selected.find((s) => s.page.path === 'summaries/big-middle.md');
  eq(big.page.content.length, pages[2].content.length, 'and loaded whole');
  ok(paths.indexOf('summaries/a-first.md') < paths.indexOf('summaries/big-middle.md'), 'deferred pages keep their relative order after the kept ones');
}

// ── 4 ────────────────────────────────────────────────────────────────────────
section('4. the exception: an oversized page named by another question word stays in place');
{
  const named = crowdedWiki('zephyrlink-drop-handbook');
  const r = selectRelevantPages(named, Q);
  const paths = r.selected.map((s) => s.page.path);
  eq(paths[2], 'summaries/zephyrlink-drop-handbook.md', 'the 50 KB page whose slug names "drop" keeps its link-order place');
  const old = oldSelect(named, Q);
  eq(sig(r.selected), sig(old.sel), 'identical to the pre-change selection');
  // The same word counts in the TITLE as well as the slug.
  const titled = crowdedWiki('zephyrlink-handbook');
  titled[2] = { path: 'summaries/zephyrlink-handbook.md', content: body('Zephyrlink drop handbook', 50500) };
  eq(selectRelevantPages(titled, Q).selected[2].page.path, 'summaries/zephyrlink-handbook.md', 'a title naming "drop" keeps it in place too');
  // The pivot's own word does not count, and a digit does not count.
  const digits = crowdedWiki('zephyrlink-2028-overview');
  const rd = selectRelevantPages(digits, 'In Zephyrlink, how long does the drop keep files in 2028?');
  ok(rd.selected.some((s) => s.page.path === ANSWER.path), 'a slug naming only the pivot word and a year is deferred (the answer page loads)');
  // A word of ANOTHER pivot counts for a page that came in through the first pivot.
  const two = [...crowdedWiki('falcon-harbour-campaign'), { path: 'entities/falcon-harbour.md', content: '# Falcon Harbour\n\nA place.\n' }];
  const r2 = selectRelevantPages(two, 'Zephyrlink and Falcon Harbour: how long does it keep files?');
  const p2 = r2.selected.map((s) => s.page.path);
  const iCamp = p2.indexOf('summaries/falcon-harbour-campaign.md'), iHub = p2.indexOf('summaries/hub-roundup.md');
  ok(iCamp > 0 && iHub === -1, 'a page named by the second pivot keeps its link-order place when it came in through the first', p2.join(', '));
}

// ── 5 ────────────────────────────────────────────────────────────────────────
section('5. no keyword page is admitted ahead of a priority page');
{
  let checked = 0, bad = 0;
  for (let w = 0; w < 300; w++) {
    const pages = genWiki(0.5 + rnd() * 2, 0.35);
    for (const q of QUERIES()) {
      const sel = selectRelevantPages(pages, q).selected;
      const lastPrio = sel.map((s) => s.priority).lastIndexOf(true);
      const firstOther = sel.findIndex((s) => !s.priority);
      if (lastPrio >= 0 && firstOther >= 0) { checked++; if (firstOther < lastPrio) bad++; }
    }
  }
  ok(checked > 300, `checked ${checked} selections holding both kinds`);
  eq(bad, 0, 'every priority page precedes every keyword page');
  const r = selectRelevantPages(crowdedWiki(), Q);
  const i = r.selected.findIndex((s) => s.page.path === 'concepts/relay-drop.md');
  ok(i === -1 || r.selected.slice(0, i).every((s) => s.priority), 'in the crowded fixture, the matching concept page comes after the pivot pages');
}

// ── 6 ────────────────────────────────────────────────────────────────────────
section('6. the budgets are never exceeded');
{
  let n = 0, over = 0, overPages = 0, badSum = 0, overCustom = 0;
  for (let w = 0; w < 300; w++) {
    const pages = genWiki(1 + rnd() * 3, 0.5);
    // Many tiny linked pages too, to press on the page cap.
    const tiny = Array.from({ length: 60 }, (_, i) => `t${i}`);
    pages.push({ path: 'entities/lantern.md', content: `# Lantern\n\n## Sources\n${tiny.map((s) => `- [[summaries/${s}]]`).join('\n')}\n` });
    for (const s of tiny) pages.push(S(s, 100 + Math.floor(rnd() * 400)));
    for (const q of [...QUERIES(), 'lantern zephyrlink', 'lantern']) {
      n++;
      const r = selectRelevantPages(pages, q);
      if (r.contentBytes > BUDGET) over++;
      if (r.selected.length > MAXP) overPages++;
      if (r.selected.reduce((a, s) => a + cost(s.page), 0) !== r.contentBytes) badSum++;
      const c = selectRelevantPages(pages, q, { contentBudget: 20000, maxPages: 5 });
      if (c.contentBytes > 20000 || c.selected.length > 5) overCustom++;
    }
  }
  ok(n >= 1500, `${n} selections on crowded generated wikis`);
  eq(over, 0, 'never more than 60 KB of content');
  eq(overPages, 0, 'never more than 50 pages');
  eq(badSum, 0, 'contentBytes is exactly the sum of the selected pages\' costs');
  eq(overCustom, 0, 'a custom budget (20 KB, 5 pages) is never exceeded either');
}

// ── 7 ────────────────────────────────────────────────────────────────────────
section('7. deferOversizedPriority');
{
  const mk = (len, path) => ({ page: { path, content: 'x'.repeat(len) }, score: 1000, priority: true, via: { matched: ['zephyrlink'] } });
  const fits = [mk(20000, 'summaries/a.md'), mk(30000, 'summaries/b.md')];
  ok(deferOversizedPriority(fits, new Set(['zephyrlink']), BUDGET, MAXP) === fits, 'everything fits: the same list object comes back');
  const list = [mk(1000, 'summaries/a.md'), mk(30000, 'summaries/big1.md'), mk(2000, 'summaries/c.md'), mk(20000, 'summaries/big2.md'), mk(3000, 'summaries/d.md'), mk(11953, 'summaries/edge.md')];
  const out = deferOversizedPriority(list, new Set(['zephyrlink']), BUDGET, MAXP).map((c) => c.page.path);
  eq(out.join(','), 'summaries/a.md,summaries/c.md,summaries/d.md,summaries/edge.md,summaries/big1.md,summaries/big2.md', 'oversized pages move to the end, both halves in their original order');
  eq(OVERSIZE_SHARE, 0.2, 'the share is 0.2 of the budget');
  const capped = Array.from({ length: 51 }, (_, i) => mk(i === 3 ? 13000 : 100, `summaries/p${i}.md`));
  eq(deferOversizedPriority(capped, new Set(), BUDGET, MAXP)[50].page.path, 'summaries/p3.md', 'more than maxPages priority pages also counts as not fitting');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
