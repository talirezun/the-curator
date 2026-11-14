#!/usr/bin/env node
/**
 * Chat reads an oversized page as a section digest when the budget is full (2026-11-14). Offline.
 *
 * A named entity force-loads its page and every summary it links, in link order, and
 * one large summary could take most of the 60 KB, so the small page holding the answer
 * was skipped. Three reorderings were withdrawn (choosing WHOLE pages inside one budget
 * trades one set of questions for another). Now, only when the whole-page pass left a
 * candidate out, a second pass keeps every page the first pass loaded, loads each one
 * over DIGEST_THRESHOLD_CHARS (not a pivot entity page) as a query-focused digest, and
 * lets the room that frees admit the skipped candidates in the same order. Synthetic
 * fixtures only. This suite holds:
 *   1. when everything fits (or nothing new would get in), the result is today's: an
 *      independent copy of the v3.98.3 selection loop agrees, same page objects, no
 *      digest, and buildPrompt's note is unchanged;
 *   2. when something was left out, every page the old loop loaded is still loaded, in
 *      the old candidate order, and the freed room admits the skipped small page;
 *   3. a pivot entity page is never digested, however large;
 *   4. a digest holds the opening, Key Takeaways, Key Facts and the best-matching
 *      section, in page order, no frontmatter, a "[sections omitted: …]" marker, within
 *      the cap; a heading inside a code fence is not a section;
 *   5. budgets are never exceeded (60 KB, 50 pages), over generated wikis;
 *   6. pages are never changed (frozen input), the prompt names the page, citations resolve.
 */
import { tokenize } from '../src/brain/sharedbrain-delta.js';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);

const chat = await import('../src/brain/chat.js');
const { selectRelevantPages, digestPage, detectEntityPivots, extractSummaryBacklinks, buildCitedPages,
  DIGEST_THRESHOLD_CHARS, DIGEST_CAP_CHARS } = chat;
const { scorePage, buildPrompt } = chat.__testing;

// ── The v3.98.3 selection, written out independently ──────────────────────────
function oldSelect(pages, q) {
  const qt = new Set(tokenize(q));
  const cp = pages.filter((p) => p.path !== 'index.md' && p.path !== 'log.md');
  const pivots = detectEntityPivots(q, cp);
  const pri = new Set();
  for (const pv of pivots) { pri.add(pv.page.path); for (const s of extractSummaryBacklinks(pv.page.content)) pri.add(`summaries/${s}.md`); }
  const prio = [...pri].map((path) => cp.find((p) => p.path === path)).filter(Boolean);
  const scored = cp.filter((p) => !pri.has(p.path)).map((p) => ({ p, s: scorePage(p, qt) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.p.path.localeCompare(b.p.path)).map((x) => x.p);
  let cands = [...prio, ...scored];
  if (cands.length === 0) cands = cp.map((p) => ({ p, s: (p.content.match(/\[\[/g) || []).length })).sort((a, b) => b.s - a.s).slice(0, 10).map((x) => x.p);
  const sel = []; let used = 0; let skipped = false;
  for (const p of cands) {
    if (sel.length >= 50) break;
    const c = p.content.length + p.path.length + 30;
    if (used + c > 60000) { skipped = true; continue; }
    sel.push(p); used += c;
  }
  return { sel, used, skipped, cands };
}

let seed = 4242;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const W = ['orchard', 'harbour', 'ledger', 'falcon', 'quarry', 'meadow', 'beacon', 'cipher', 'lantern', 'glacier', 'tundra', 'pylon'];
const w = () => W[Math.floor(rnd() * W.length)];
const filler = (len, tag = '') => { let b = ''; let i = 0; while (b.length < len) b += `- ${tag}item ${i++}: ${w()} ${w()} and ${w()} notes.\n`; return b; };
const page = (path, title, len, extra = '') => ({ path, content: `# ${title}\n\nLead paragraph for ${title}.\n\n## Details\n${filler(len)}${extra}` });
const entity = (slug, len, links) => ({ path: `entities/${slug}.md`, content: `# ${slug}\n\nAbout ${slug}.\n\n${filler(len)}\n## Sources\n${links.map((s) => `- [[summaries/${s}]]`).join('\n')}\n` });

// A big summary with a deep answer section, plus the usual ingest shape.
function bigSummary(slug, len) {
  const sections = [];
  for (let k = 0; sections.join('').length < len; k++) sections.push(`## Chapter ${k}\n${filler(1800, `c${k}-`)}\n`);
  return { path: `summaries/${slug}.md`, content: `---\ntype: summary\nsource: ${slug}.md\nsecretfrontmatter: zz-front-zz\n---\n# ${slug}\n\nOpening line of ${slug}.\n\n## Key Takeaways\n- Takeaway one of ${slug}.\n- Takeaway two of ${slug}.\n\n${sections.slice(0, 6).join('')}## Refund Policy\n- The refund window is 14 days for tours.\n\n${sections.slice(6).join('')}## Key Facts\n- Founded: 2031\n\n## Entities Mentioned\n- [[x]]\n` };
}

// ── 1 ────────────────────────────────────────────────────────────────────────
section('1. everything fits (or nothing new gets in): today\'s result, byte for byte');
{
  const pages = [entity('zephyrlink', 900, ['zl-a', 'zl-b']), page('summaries/zl-a.md', 'ZL A', 3000), page('summaries/zl-b.md', 'ZL B', 20000),
    page('concepts/orchard-trade.md', 'Orchard Trade', 1200), page('concepts/harbour.md', 'Harbour', 25000)];
  let same = 0, n = 0;
  for (const q of ['What is Zephyrlink?', 'orchard trade', 'harbour', 'tell me about ledger falcon', 'nothing matches xyzzy']) {
    const o = oldSelect(pages, q);
    const r = selectRelevantPages(pages, q);
    n++;
    if (!o.skipped && r.selected.length === o.sel.length && r.selected.every((s, i) => s.page === o.sel[i]) && !r.selected.some((s) => s.digest)
      && r.contentBytes === o.used && !('digestCount' in r)) same++;
  }
  ok(same === n, `fit cases: same page objects, same bytes, no digest (${same}/${n})`);
  const p = buildPrompt('d', pages, [], 'What is Zephyrlink?');
  ok(/Loaded 3 pages in full \(/.test(p) && !/section digest/.test(p) && !/\[Long page/.test(p), 'fit case: the prompt note is the old one, no digest marker');

  // Skipped, but nothing new can get in: still today's result (no large page was loaded).
  const smalls = Array.from({ length: 20 }, (_, i) => page(`concepts/basalt-${i}.md`, `Basalt ${i}`, 2800));
  const pages2 = [...smalls, { path: 'concepts/stone-pit.md', content: `# Stone Pit\n\nA basalt mention.\n\n${filler(30000)}` }];
  const o2 = oldSelect(pages2, 'basalt');
  const r2 = selectRelevantPages(pages2, 'basalt');
  ok(o2.skipped, 'control: the old loop skipped a page');
  ok(r2.selected.length === o2.sel.length && r2.selected.every((s, i) => s.page === o2.sel[i]) && !('digestCount' in r2),
    'skipped but nothing new admitted: the old result unchanged');
}

// ── 2 ────────────────────────────────────────────────────────────────────────
section('2. something left out: old pages kept, in order; the freed room admits the small page');
{
  const ent = entity('zephyrlink', 1000, ['zl-overview', 'zl-guide', 'zl-release']);
  const pages = [ent, bigSummary('zl-overview', 30000), bigSummary('zl-guide', 25200),
    { path: 'summaries/zl-release.md', content: '# ZL release\n\nZephyrlink v0.1.1 was released on 18 October.\n' + filler(2500) }];
  const q = 'When was Zephyrlink v0.1.1 released?';
  const o = oldSelect(pages, q);
  const r = selectRelevantPages(pages, q);
  const paths = r.selected.map((s) => s.page.path);
  ok(o.skipped && !o.sel.some((p) => p.path === 'summaries/zl-release.md'), 'control: today the release page is skipped', `${o.sel.map((p) => p.path)} ${o.used} ${o.cands.map((p) => p.path + ':' + p.content.length)}`);
  ok(paths.includes('summaries/zl-release.md'), 'now the release page is loaded', paths.join(', '));
  ok(o.sel.every((p) => paths.includes(p.path)), 'every page the old loop loaded is still loaded');
  const idx = (p) => o.cands.findIndex((c) => c.path === p);
  ok(paths.every((p, i) => i === 0 || idx(paths[i - 1]) < idx(p)), 'pages stay in the old candidate order');
  ok(r.selected.filter((s) => s.digest).map((s) => s.page.path).join() === 'summaries/zl-overview.md,summaries/zl-guide.md', 'only the pages over the threshold are digests');
  ok(r.selected.filter((s) => !s.digest).every((s) => pages.includes(s.page)), 'other pages are the original objects, whole');
  ok(r.contentBytes <= 60000 && r.digestCount === 2, `within budget (${r.contentBytes})`);
  const p = buildPrompt('d', pages, [], q);
  ok(p.includes('--- FILE: summaries/zl-overview.md ---') && /1 in full|2 in full/.test(p) && /2 long pages as a section digest/.test(p), 'the prompt names the digested page and says it is a digest');
  ok(buildCitedPages(['summaries/zl-overview.md'], pages).join() === 'summaries/zl-overview.md', 'a citation of the digested page resolves to the page');
}

// ── 3 ────────────────────────────────────────────────────────────────────────
section('3. a pivot entity page is never digested');
{
  const ent = entity('zephyrlink', 20000, ['zl-a', 'zl-b', 'zl-c']);
  const pages = [ent, bigSummary('zl-a', 25000), page('summaries/zl-b.md', 'ZL B', 9000), page('summaries/zl-c.md', 'ZL C', 9000)];
  const r = selectRelevantPages(pages, 'What is Zephyrlink?');
  ok(r.selected[0].page === ent && !r.selected[0].digest, 'the 20 KB pivot entity page is first and whole');
  ok(r.selected.some((s) => s.digest && s.page.path === 'summaries/zl-a.md'), 'the large linked summary is the digest');
}

// ── 4 ────────────────────────────────────────────────────────────────────────
section('4. what a digest holds');
{
  const big = bigSummary('orchard-handbook', 40000);
  const d = digestPage(big.content, 'What is the refund window for tours?');
  const t = d.content;
  ok(d && t.length <= DIGEST_CAP_CHARS, `within the cap (${t.length} <= ${DIGEST_CAP_CHARS})`);
  ok(!t.includes('zz-front-zz') && !t.startsWith('---'), 'no frontmatter');
  ok(t.includes('# orchard-handbook') && t.includes('Opening line of orchard-handbook.'), 'the opening is kept');
  ok(t.includes('## Key Takeaways') && t.includes('Takeaway two of orchard-handbook.'), 'Key Takeaways kept');
  ok(t.includes('## Key Facts') && t.includes('Founded: 2031'), 'Key Facts kept');
  ok(t.includes('The refund window is 14 days for tours.'), 'the matching section deep in the page is kept');
  ok(/^\[Long page \([\d.]+ KB\) shown as a digest/.test(t), 'first line says it is a digest');
  const m = t.match(/\[sections omitted: ([^\]]+)\]/);
  ok(m && m[1].includes('Chapter') && !m[1].includes('Refund Policy'), 'a marker names the omitted sections', m && m[1].slice(0, 80));
  const order = ['Opening line', '## Key Takeaways', '## Refund Policy', '## Key Facts'].map((s) => t.indexOf(s));
  ok(order.every((v, i) => v >= 0 && (i === 0 || order[i - 1] < v)), 'kept parts appear in page order');
  ok(/\[… \d+ more items? in this section omitted\]|\[…\]/.test(t) || t.includes('[sections omitted:'), 'omissions inside sections are marked');
  const d2 = digestPage(big.content, 'chapter 3 item 5 c3-item');
  ok(d2.content.includes('c3-item 5:'), 'another question picks another section');
  ok(digestPage('# small\n\nshort page', 'x') === null, 'a page under the cap is not digested');
  const fenced = `# Fenced\n\nLead.\n\n## Code\n\`\`\`\n## not a heading\nzz-in-fence\n\`\`\`\n${filler(16000)}\n## Tail\nend\n`;
  const df = digestPage(fenced, 'zz-in-fence code');
  ok(!/sections omitted: [^\]]*not a heading/.test(df.content) && df.content.includes('```\n## not a heading\nzz-in-fence\n```'), 'a heading inside a code fence is not a section; the fence stays whole');
  // Many long headings: the markers alone could overrun a small cap if it were not enforced.
  const many = `# Many\n\nLead.\n\n${Array.from({ length: 300 }, (_, i) => `## ${'Section heading with a long descriptive name number '.repeat(2)}${i}\n- short ${i} basalt\n`).join('\n')}`;
  for (const cap of [3000, 5000, 12000]) {
    const dm = digestPage(many, 'basalt short', cap);
    ok(dm && dm.content.length <= cap, `the cap holds with long omission markers (cap ${cap}: ${dm && dm.content.length})`);
  }
  // The threshold decides which pages are digests, not the cap.
  const pagesT = [entity('zephyrlink', 800, ['zl-mid', 'zl-large', 'zl-small']), page('summaries/zl-mid.md', 'ZL mid', 15000),
    bigSummary('zl-large', 36000), page('summaries/zl-small.md', 'ZL small', 9500)];
  const rt = selectRelevantPages(pagesT, 'What is Zephyrlink?', { digestThreshold: 20000 });
  const dg = rt.selected.filter((s) => s.digest).map((s) => s.page.path).join();
  ok(dg === 'summaries/zl-large.md' && rt.selected.some((s) => s.page.path === 'summaries/zl-mid.md' && !s.digest), 'with a 20 KB threshold a 15 KB page stays whole, a 37 KB one is a digest', dg);
}

// ── 5 ────────────────────────────────────────────────────────────────────────
section('5. budgets are never exceeded, over generated wikis');
{
  let worst = 0, maxN = 0, dup = 0, superset = 0, cases = 0, digested = 0, identical = 0, noSkip = 0;
  for (let k = 0; k < 120; k++) {
    const small = k % 4 === 0;
    const nS = small ? 3 : 3 + Math.floor(rnd() * 30);
    const links = Array.from({ length: nS }, (_, i) => `s${k}-${i}`);
    const pages = [entity('zephyrlink', 500 + Math.floor(rnd() * 20000), links),
      ...links.map((s) => (!small && rnd() < 0.3 ? bigSummary(s, 12000 + Math.floor(rnd() * 70000)) : page(`summaries/${s}.md`, s, 300 + Math.floor(rnd() * 9000)))),
      ...Array.from({ length: small ? 4 : 40 }, (_, i) => page(`concepts/${w()}-${i}.md`, `${w()} ${i}`, 200 + Math.floor(rnd() * 6000)))];
    for (const q of ['What is Zephyrlink?', `${w()} ${w()}`, 'refund window zephyrlink']) {
      const r = selectRelevantPages(pages, q);
      const o = oldSelect(pages, q);
      cases++;
      const real = r.selected.reduce((a, s) => a + s.page.content.length + s.page.path.length + 30, 0);
      worst = Math.max(worst, real, r.contentBytes);
      maxN = Math.max(maxN, r.selected.length);
      if (new Set(r.selected.map((s) => s.page.path)).size !== r.selected.length) dup++;
      if (o.sel.every((p) => r.selected.some((s) => s.page.path === p.path))) superset++;
      if (r.selected.some((s) => s.digest)) digested++;
      if (!o.skipped) noSkip++;
      if (!o.skipped && r.selected.every((s, i) => s.page === o.sel[i]) && r.selected.length === o.sel.length) identical++;
      if (real !== r.contentBytes) worst = Infinity;
    }
  }
  ok(worst <= 60000, `content never over 60,000 and contentBytes is the real cost (worst ${worst})`);
  ok(maxN <= 50, `never more than 50 pages (max ${maxN})`);
  ok(dup === 0, 'no page loaded twice');
  ok(superset === cases, `every page the old loop loaded is still loaded (${superset}/${cases})`);
  ok(digested > 20, `the digest path ran in many cases (${digested}/${cases})`);
  ok(identical === noSkip, `every case where nothing was skipped is identical (${identical}/${noSkip})`);
}

// ── 6 ────────────────────────────────────────────────────────────────────────
section('6. pages are never changed');
{
  const deepFreeze = (o) => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return o; };
  const pages = deepFreeze([entity('zephyrlink', 1000, ['zl-overview', 'zl-guide', 'zl-release']), bigSummary('zl-overview', 30000), bigSummary('zl-guide', 27000),
    { path: 'summaries/zl-release.md', content: '# ZL release\n\nv0.1.1 released.\n' + filler(2500) }]);
  const before = JSON.stringify(pages);
  let threw = null;
  try { selectRelevantPages(pages, 'When was Zephyrlink v0.1.1 released?'); buildPrompt('d', pages, [], 'When was Zephyrlink v0.1.1 released?'); } catch (e) { threw = e; }
  ok(threw === null && JSON.stringify(pages) === before, 'frozen pages: no write attempted, content identical', threw && threw.message);
  ok(DIGEST_THRESHOLD_CHARS === 12000 && DIGEST_CAP_CHARS === 12000, 'the measured threshold and cap (12,000 / 12,000)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
