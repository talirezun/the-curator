#!/usr/bin/env node
/**
 * Chat reads an oversized page as a section digest when the budget is full (2026-11-14). Offline.
 *
 * A named entity force-loads its page and every summary it links, in link order, and
 * one large summary could take most of the 60 KB, so the small page holding the answer
 * was skipped. Three reorderings were withdrawn (choosing WHOLE pages inside one budget
 * trades one set of questions for another). Now, only when the whole-page pass left a
 * candidate out, a second pass keeps every page the first pass loaded and shortens a
 * loaded page over DIGEST_THRESHOLD_CHARS to a query-focused digest ONLY where that
 * admits a skipped candidate scoring at least as high (never the top-scoring page, a
 * pivot entity page or a page the question names; at most DIGEST_MAX_PAGES). Revised
 * 2026-11-15 after an independent audit found real right-to-wrong answers in the first
 * version (a 38 KB person page named as "Režun" was shortened; a Notes line was cut).
 * Synthetic fixtures only. Sections 1-6 hold the frame (fit case identical, old pages
 * kept, budgets, frozen input), 7-9 each protection on its own, 4 and 7 the digest's
 * content, 8 the bounds.
 */
import { tokenize } from '../src/brain/sharedbrain-delta.js';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const section = (t) => console.log(`\n${t}`);
const pages0 = (list, path) => list.find((p) => p.path === path);

const chat = await import('../src/brain/chat.js');
const { selectRelevantPages, digestPage, detectEntityPivots, extractSummaryBacklinks, buildCitedPages,
  DIGEST_THRESHOLD_CHARS, DIGEST_CAP_CHARS, DIGEST_MAX_PAGES } = chat;
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
  const dg2 = r.selected.filter((s) => s.digest);
  ok(dg2.length === 1 && dg2[0].page.path === 'summaries/zl-guide.md', 'only as many long pages are shortened as the release page needs (one, the later on a tie)', dg2.map((s) => s.page.path).join());
  ok(r.selected.filter((s) => !s.digest).every((s) => pages.includes(s.page)), 'other pages are the original objects, whole');
  ok(r.contentBytes <= 60000 && r.digestCount === 1, `within budget (${r.contentBytes})`);
  const p = buildPrompt('d', pages, [], q);
  ok(p.includes('--- FILE: summaries/zl-guide.md ---') && /Loaded 4 pages \(1 long page in part, gaps marked …\)/.test(p), 'the prompt names the shortened page and says, neutrally, that it is in part');
  ok(!/digest/i.test(p), 'the prompt never uses the word "digest"');
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
  ok(t.startsWith('# orchard-handbook'), 'no label line: the page starts with its own title');
  ok(!/digest|omitted|\[/i.test(t.replace(/\[\[[^\]]*\]\]/g, '')), 'no wording that invites talk about a digest: gaps are a bare …');
  ok(d.omittedSections.some((h) => h.startsWith('Chapter')) && !d.omittedSections.includes('Refund Policy'), 'the omitted headings are recorded beside the text');
  const order = ['Opening line', '## Key Takeaways', '## Refund Policy', '## Key Facts'].map((s) => t.indexOf(s));
  ok(order.every((v, i) => v >= 0 && (i === 0 || order[i - 1] < v)), 'kept parts appear in page order');
  ok(/^…$/m.test(t), 'omissions are marked with …');
  const d2 = digestPage(big.content, 'chapter 3 item 5 c3-item');
  ok(d2.content.includes('c3-item 5:'), 'another question picks another section');
  const d3 = digestPage(big.content, 'what about c19-item notes?');
  ok(d3.content.includes('c19-item 5:') && !d3.content.includes('c18-item 5:'), 'a long matching section late in the page is kept by its words, not by page order');
  ok(digestPage('# small\n\nshort page', 'x') === null, 'a page under the cap is not digested');
  const fenced = `# Fenced\n\nLead.\n\n## Code\n\`\`\`\n## not a heading\nzz-in-fence\n\`\`\`\n${filler(16000)}\n## Tail\nend\n`;
  const df = digestPage(fenced, 'zz-in-fence code');
  ok(!df.omittedSections.includes('not a heading') && df.content.includes('```\n## not a heading\nzz-in-fence\n```'), 'a heading inside a code fence is not a section; the fence stays whole');
  // Many long headings: the markers alone could overrun a small cap if it were not enforced.
  const many = `# Many\n\nLead.\n\n${Array.from({ length: 300 }, (_, i) => `## ${'Section heading with a long descriptive name number '.repeat(2)}${i}\n- short ${i} basalt\n`).join('\n')}`;
  for (const cap of [3000, 5000, 12000]) {
    const dm = digestPage(many, 'basalt short', cap);
    ok(dm && dm.content.length <= cap, `the cap holds with long omission markers (cap ${cap}: ${dm && dm.content.length})`);
  }
  // The threshold decides which pages are digests, not the cap.
  const pagesT = [entity('zephyrlink', 800, ['zl-large', 'zl-mid', 'zl-small']), page('summaries/zl-mid.md', 'ZL mid', 15000),
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

// ── 9 ────────────────────────────────────────────────────────────────────────
section('9. each protection, on its own');
{
  const plain = (path, title, len, tag) => ({ path, content: `# ${title}\n\n${title.toLowerCase()}.\n\n## Body\n${filler(len, tag)}` });
  // A second pivot's entity page is long, loaded, and the only page that could be shortened.
  const e1 = { path: 'entities/alphon-group-plc.md', content: `# Alphon Group Holdings\n\nAbout alphon.\n` };
  const e2 = { path: 'entities/betron-labs-inc.md', content: `# Betron Labs Incorporated\n\nAbout betron.\n\n${filler(40000)}\n## Sources\n- [[summaries/be-a]]\n- [[summaries/be-b]]\n` };
  const pv = [e1, e2, plain('summaries/be-a.md', 'Be A', 10000, 'ba-'), plain('summaries/be-b.md', 'Be B', 10000, 'bb-')];
  const qv = 'What do alphon group and betron labs do?';
  const ov = oldSelect(pv, qv), rv = selectRelevantPages(pv, qv);
  ok(ov.skipped && rv.selected.length === ov.sel.length && rv.selected.every((x, i) => x.page === ov.sel[i]), 'a pivot entity page is not shortened even when it is the only long page');
  // The top-scoring loaded page is long and the only one that could be shortened.
  const ta = { path: 'summaries/zeta-report-alpha.md', content: `# Zeta Report Alpha\n\nzeta report.\n\n## Body\n${filler(52000, 'za-')}` };
  const tb = { path: 'summaries/zeta-report-beta.md', content: `# Zeta Report Beta\n\nzeta report.\n\n## Body\n${filler(9000, 'zb-')}` };
  const ot = oldSelect([ta, tb], 'zeta report'), rt2 = selectRelevantPages([ta, tb], 'zeta report');
  ok(ot.skipped && rt2.selected.length === 1 && rt2.selected[0].page === ta, 'the top-scoring page is not shortened to admit an equal one');
  // A page the question names with a diacritic ("Režun"), not a pivot, not the top page.
  const topN = { path: 'summaries/birthplace-of-tali.md', content: `# Birthplace of Tali\n\nbirthplace tali.\n\n${filler(9000, 'bp-')}` };
  const named = { path: 'entities/tali-rezun.md', content: `# Tali Rezun\n\ntali.\n\n## Life\n${filler(45000, 'tl-')}` };
  const other = { path: 'summaries/tali-notes.md', content: `# Tali Notes\n\ntali.\n\n${filler(9000, 'tn-')}` };
  const qn = 'Where is Tali Režun\'s birthplace?';
  const on = oldSelect([topN, named, other], qn), rn = selectRelevantPages([topN, named, other], qn);
  ok(on.skipped && on.sel.includes(named) && rn.selected.every((x) => !x.digest), 'a page named with a diacritic stays whole', rn.selected.map((x) => x.page.path + (x.digest ? '*' : '')).join());
  // A loaded long page that scores HIGHER than the skipped page is not shortened for it.
  const hi = [{ path: 'summaries/kelvo-index-north.md', content: `# Kelvo Index North\n\nkelvo index.\n\n## Body\n${filler(30000, 'k1-')}` },
    { path: 'summaries/kelvo-index-south.md', content: `# Kelvo Index South\n\nkelvo index.\n\n## Body\n${filler(27000, 'k2-')}` }];
  const lo = { path: 'concepts/misc.md', content: `# Misc\n\nkelvo.\n\n${filler(4000, 'mi-')}` };
  const oh = oldSelect([...hi, lo], 'kelvo index'), rh = selectRelevantPages([...hi, lo], 'kelvo index');
  ok(oh.skipped && !oh.sel.includes(lo) && rh.selected.length === oh.sel.length, 'a lower-scoring skipped page does not shorten a higher-scoring loaded one');
  // After a page is shortened, a skipped page scoring below it is not admitted.
  const vx = (slug, title, len, tag) => ({ path: `summaries/${slug}.md`, content: `# ${title}\n\nvexa.\n\n## Body\n${filler(len, tag)}` });
  const pf = [vx('vexa-guide', 'Vexa Guide', 9000, 'v1-'), vx('vexa-manual', 'Vexa Manual', 40000, 'v2-'), vx('vexa-memo', 'Vexa Memo', 12500, 'v3-'),
    ...[1, 2, 3].map((i) => ({ path: `concepts/low-${i}.md`, content: `# Low ${i}\n\nvexa.\n\n${filler(4000, `l${i}-`)}` }))];
  const of = oldSelect(pf, 'vexa'), rf = selectRelevantPages(pf, 'vexa');
  const fpaths = rf.selected.map((x) => x.page.path + (x.digest ? '*' : '')).join();
  ok(rf.selected.some((x) => x.digest) && rf.selected.some((x) => x.page.path === 'summaries/vexa-memo.md'), 'control: the manual is shortened to admit the equally relevant memo', fpaths);
  ok(of.sel.every((p) => p.path !== 'concepts/low-3.md') && !rf.selected.some((x) => x.page.path === 'concepts/low-3.md'), 'a lower-scoring page skipped by the old pass is not let in by the room a shortening freed', fpaths);
}

// ── 7 ────────────────────────────────────────────────────────────────────────
section('7. a page is shortened only where it pays');
{
  // Keyword-scored pages: a long page is shortened only for a skipped page that scores at least as high.
  const lowTail = Array.from({ length: 6 }, (_, i) => ({ path: `concepts/tail-${i}.md`, content: `# Tail ${i}\n\nbasalt.\n${filler(1500)}` }));
  const longs = [0, 1, 2].map((i) => ({ path: `summaries/basalt-granite-guide-${i}.md`, content: `# Basalt Granite Guide ${i}\n\nbasalt granite.\n\n## Part\n${filler(19000, `g${i}-`)}` }));
  const pagesA = [...longs, ...lowTail];
  const oA = oldSelect(pagesA, 'basalt granite guide');
  const rA = selectRelevantPages(pagesA, 'basalt granite guide');
  ok(oA.skipped && rA.selected.every((s, i) => s.page === oA.sel[i]) && rA.selected.length === oA.sel.length,
    'skipped pages that score lower than every long loaded page do not get in: the old result');

  // The single highest-scoring loaded page is never shortened.
  const topPage = { path: 'summaries/basalt-granite-atlas.md', content: `# Basalt Granite Atlas\n\nbasalt granite atlas.\n\n## Part\n${filler(30000, 'top-')}` };
  const second = { path: 'summaries/basalt-granite-memo.md', content: `# Basalt Granite Memo\n\nbasalt granite atlas.\n\n## Part\n${filler(25000, 'sec-')}` };
  const third = { path: 'summaries/basalt-granite-notes.md', content: `# Basalt Granite Notes\n\nbasalt granite atlas.\n\n## Part\n${filler(9000, 'th-')}` };
  const rB = selectRelevantPages([topPage, second, third], 'basalt granite atlas');
  const top = rB.selected.find((s) => s.page.path === topPage.path);
  ok(top && !top.digest, 'the highest-scoring loaded page stays whole');
  ok(rB.selected.some((s) => s.digest && s.page.path === second.path) && rB.selected.some((s) => s.page.path === third.path && !s.digest), "a lower-scoring long page is shortened to admit an equally relevant skipped page", rB.selected.map((s) => s.page.path + (s.digest ? "*" : "")).join());

  // A page the question names, diacritics folded, is never shortened.
  const person = { path: 'entities/tali-rezun.md', content: `# Tali Rezun\n\nA person.\n\n## Background\n${filler(26000, 'tr-')}\n## Key Facts\n- Born: 1977\n` };
  const linked = Array.from({ length: 4 }, (_, i) => ({ path: `summaries/rezun-essay-${i}.md`, content: `# Rezun essay ${i}\n\nby tali rezun.\n\n## Body\n${filler(14000, `e${i}-`)}` }));
  const rC = selectRelevantPages([person, ...linked], 'What is Tali Režun\'s birthplace and birth year?');
  const pc = rC.selected.find((s) => s.page.path === person.path);
  ok(pc && !pc.digest, '"Režun" names tali-rezun: that page stays whole');

  // Key Facts stay whole however long, and before anything else is kept.
  const facts = Array.from({ length: 120 }, (_, i) => `- Fact ${i}: value ${i * 7}`).join('\n');
  const kf = { path: 'summaries/kf.md', content: `# KF\n\nLead.\n\n## Key Takeaways\n${filler(6000, 'kt-')}\n## Body\n${filler(20000, 'b-')}\n## Key Facts\n${facts}\n` };
  const dk = digestPage(kf.content, 'unrelated question about pylons');
  ok(Array.from({ length: 120 }, (_, i) => `- Fact ${i}: value ${i * 7}`).every((l) => dk.content.includes(l)), 'all 120 Key Facts lines survive');
  ok(dk.content.includes('kt-item 0:') && dk.content.length <= DIGEST_CAP_CHARS, 'Key Takeaways come before the body, and the cap holds');
  // A short section (a summary's Notes) is kept even when Key Takeaways alone would fill the cap.
  const ov = { path: 'summaries/ov.md', content: `# OV\n\nLead.\n\n## Key Takeaways\n${filler(40000, 'kt-')}\n## Entities Mentioned\n- [[x]]\n- [[y]]\n\n## Notes\nSource documentation for Zephyr v0.4.12.\n` };
  const dov = digestPage(ov.content, 'which release do the docs describe?');
  ok(dov.content.includes('Source documentation for Zephyr v0.4.12.') && dov.content.length <= DIGEST_CAP_CHARS, 'a short Notes section survives a Key Takeaways section larger than the cap');
}

// ── 8 ────────────────────────────────────────────────────────────────────────
section('8. the work and the page count stay bounded');
{
  ok(DIGEST_MAX_PAGES === 3, 'at most 3 pages shortened per question');
  const ent = entity('zephyrlink', 600, Array.from({ length: 30 }, (_, i) => `zl-${i}`));
  const many = Array.from({ length: 30 }, (_, i) => bigSummary(`zl-${i}`, 20000));
  const r = selectRelevantPages([ent, ...many], 'What is Zephyrlink?');
  ok(r.selected.filter((s) => s.digest).length <= DIGEST_MAX_PAGES, `no more than ${DIGEST_MAX_PAGES} digests (${r.selected.filter((s) => s.digest).length})`);
  const L4 = ['m1', 'm2', 'm3', 'm4'].map((x) => ({ path: `summaries/${x}.md`, content: `# M ${x}\n\nm ${x}.\n\n## Body\n${filler(13300, x + '-')}` }));
  const p8 = [entity('zorbit', 100, ['m1', 'm2', 'm3', 'm4', 'm5']), ...L4, { path: 'summaries/m5.md', content: `# M m5\n\nm m5.\n\n## Body\n${filler(9000, 'm5-')}` }];
  const has5 = (o) => selectRelevantPages(p8, 'What is zorbit?', o).selected.some((x) => x.page.path === 'summaries/m5.md');
  ok(!has5({ maxDigests: 1 }) && has5({ maxDigests: 2 }), 'a page needing two shortenings is admitted only when two are allowed');
  const p9 = [entity('quorbit', 100, ['big0', 'r1', 'r2']), { path: 'summaries/big0.md', content: `# Big\n\nbig.\n\n## Body\n${filler(35000, 'b0-')}` },
    ...['r1', 'r2'].map((x) => ({ path: `summaries/${x}.md`, content: `# R ${x}\n\nr ${x}.\n\n## Body\n${filler(26000, x + '-')}` }))];
  const r9 = selectRelevantPages(p9, 'What is quorbit?', { maxDigests: 1 });
  ok(r9.selected.filter((x) => x.digest).length === 1, 'a skipped long page shortening itself counts toward the bound', r9.selected.map((x) => x.page.path + (x.digest ? '*' : '')).join());
  // 50-page cap in the second pass: 49 small pages fit, a long one and 10 small skipped ones follow.
  const smalls = Array.from({ length: 47 }, (_, i) => ({ path: `summaries/zx-${String(i).padStart(2, '0')}.md`, content: `# zx ${i}\n\n${filler(500)}` }));
  const longP = { path: 'summaries/zx-long.md', content: `# zx long\n\n${'## S\n' + filler(30000)}` };
  const after = Array.from({ length: 10 }, (_, i) => ({ path: `summaries/zx-after-${i}.md`, content: `# zx after ${i}\n\n${filler(3000)}` }));
  const ent2 = entity('zephyrlink', 300, ['zx-long', ...smalls.map((p) => p.path.slice(10, -3)), ...after.map((p) => p.path.slice(10, -3))]);
  const all = [ent2, longP, ...smalls, ...after];
  const r2 = selectRelevantPages(all, 'What is Zephyrlink?');
  const o2 = oldSelect(all, 'What is Zephyrlink?');
  ok(o2.skipped, 'control: the old loop skipped pages here');
  ok(r2.selected.length === 50 && o2.sel.length === 49, `the second pass fills to the 50-page cap and stops there (${o2.sel.length} -> ${r2.selected.length})`);
  const big = Array.from({ length: 3500 }, (_, i) => ({ path: `summaries/p-${i}.md`, content: `# Page ${i} pricing\n\nLead about pricing.\n${filler(20000)}` }));
  const t0 = Date.now();
  selectRelevantPages(big, 'What is the pricing for the orchard ledger?');
  const ms = Date.now() - t0;
  ok(ms < 2000, `3,500 pages of 20 KB that all match: ${ms} ms (bounded)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
