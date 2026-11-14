#!/usr/bin/env node
/**
 * MCP search ranks by whole words, rarity and dampened repeats; an exact name ranks first (2026-11-14). Offline.
 *
 * search_wiki and search_cross_domain scored a page by RAW substring counts (+3 slug
 * substring, +2 tag substring), so a big hub page repeating common words won, "ai"
 * matched "chain", and search_cross_domain merged raw scores from domains of different
 * sizes. mcp/search-score.js now ranks: whole-word terms, (1 + ln count) x idf per
 * term, +3 per slug word and +2 per tag word (flat), and a page whose slug or title IS
 * the query first. search_cross_domain merges on each score relative to its own
 * domain's best. Synthetic fixtures only.
 *
 * Sections:
 *   1. whole words: "ai" no longer matches "chain"; a page holding a term only inside a
 *      longer word no longer matches (the deliberate matching-set change);
 *   2. an exact slug or title ranks first, even when a hub page outscores it;
 *   3. a big page repeating common words no longer outranks a small page holding the
 *      rare words (the old scorer, copied independently, put the hub first);
 *   4. order is by the UNROUNDED score with ties in page order; the returned scores
 *      never increase down the list (below the exact-name block);
 *   5. search_cross_domain: a small domain's best result is not buried under a large
 *      domain's raw scores; an exact name is first across domains;
 *   6. output shape unchanged (same keys, types, empty-query and no-result replies);
 *   7. the scorer writes nothing to stdout.
 */
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, label) => ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = (t) => console.log(`\n${t}`);

const ROOT = await mkdtemp(path.join(os.tmpdir(), 'curator-search-rank-'));
process.env.CURATOR_TEST_DOMAINS_DIR = ROOT;
process.env.CURATOR_TEST_USER_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'curator-search-rank-ud-'));
process.env.CURATOR_NO_OPEN = '1';

const { createStorageAdapter } = await import('../mcp/storage/local.js');
const { searchWikiHandler } = await import('../mcp/tools/search.js');
const { searchCrossHandler } = await import('../mcp/tools/cross.js');
const { buildGraph } = await import('../mcp/graph.js');
const { rankNodes, terms, displayScore } = await import('../mcp/search-score.js');

async function domain(name, pages) {
  const d = path.join(ROOT, name);
  for (const f of ['entities', 'concepts', 'summaries']) await mkdir(path.join(d, 'wiki', f), { recursive: true });
  await writeFile(path.join(d, 'CLAUDE.md'), '# Test schema\n');
  await writeFile(path.join(d, 'wiki', 'index.md'), '# Index\n');
  await writeFile(path.join(d, 'wiki', 'log.md'), '# Log\n');
  for (const [p, body, tags = []] of pages) {
    await writeFile(path.join(d, 'wiki', p), `---\ntype: ${p.split('/')[0].replace(/ies$/, 'y').replace(/s$/, '')}\ntags: [${tags.join(', ')}]\n---\n${body}`);
  }
}
const rep = (w, n) => Array.from({ length: n }, () => w).join(' ');
const filler = (n) => Array.from({ length: n }, (_, i) => `Line ${i} about harbours, orchards and meadows.`).join('\n');

await domain('alpha', [
  ['entities/zephyr.md', '# Zephyr\n\nZephyr is a courier relay.\n'],
  ['summaries/zephyr-hub-roundup.md', `# Zephyr hub roundup\n\n${rep('zephyr relay file default storage', 300)}\n${filler(400)}\n`],
  ['summaries/drop-architecture.md', '# Drop architecture\n\n- The drop keeps each file as ciphertext until expiry after seven days.\n'],
  ['concepts/chain-notes.md', '# Chain notes\n\nA blockchain is a chain of blocks.\n', ['blockchain']],
  ['concepts/ai-basics.md', '# AI basics\n\nAI means machine intelligence.\n'],
  ['concepts/agents-only.md', '# Field crews\n\nThe agents work in crews.\n'],
  ['concepts/agent-desk.md', '# Desk\n\nOne agent works the desk.\n'],
  ['concepts/vault-encryption.md', '# Vault encryption\n\nThe vault uses encryption at rest.\n'],
  ['concepts/api-pagination.md', '# API pagination\n\nResults come back with pagination cursors.\n'],
  ['concepts/aim-notes.md', '# Aim notes\n\nWe aim high.\n'],
  ['concepts/ledger-notes.md', '# Smart Ledgers\n\nNotes on ledgers.\n'],
  ['concepts/smart-ledgers-history.md', `# History of smart ledgers\n\n${rep('smart ledgers', 80)}\n`],
  ['concepts/quokka-farm.md', '# Quokka farm\n\nThe quokka farm pays a quokka tariff.\n'],
  ...Array.from({ length: 4 }, (_, i) => [`concepts/note-${i}.md`, `# Note ${i}\n\nA quokka tariff, a quokka tariff, a quokka tariff.\n`]),
  ['concepts/twin-a.md', '# Twin\n\nquokka meadow\n'],
  ['concepts/twin-b.md', '# Twin\n\nquokka meadow\n'],
  ...Array.from({ length: 40 }, (_, i) => [`concepts/common-${i}.md`, `# Common ${i}\n\nA file with a default value and storage.\n${filler(30)}\n`]),
]);
await domain('gamma', [
  ['concepts/gamma-misc.md', '# Misc\n\nA quokka was seen once.\n'],
  ...Array.from({ length: 30 }, (_, i) => [`concepts/gamma-${i}.md`, `# Gamma ${i}\n\nA quokka page.\n`]),
]);
await domain('beta', [
  ['concepts/quokka-tariffs.md', '# Quokka tariffs\n\nThe quokka tariff is set yearly.\n'],
  ['concepts/beta-other.md', '# Other\n\nNothing to see.\n'],
]);
const storage = createStorageAdapter({ domainsPath: ROOT });
const search = (query, domain = 'alpha', max_results = 50) => searchWikiHandler({ query, domain, max_results }, storage);
const slugs = (r) => r.results.map((x) => x.slug);

// The pre-change scorer, copied independently (raw substring counts).
function oldRank(nodes, query) {
  const t = query.toLowerCase().split(/\s+/).filter(Boolean);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hits = [];
  for (const n of nodes) {
    const hay = (n.slug + '\n' + n.body).toLowerCase();
    let s = 0;
    for (const x of t) { const m = hay.match(new RegExp(esc(x), 'g')); if (m) s += m.length; if (n.slug.toLowerCase().includes(x)) s += 3; if (n.tags.some((g) => g.toLowerCase().includes(x))) s += 2; }
    if (s > 0) hits.push({ slug: n.slug, s });
  }
  return hits.sort((a, b) => b.s - a.s).map((h) => h.slug);
}
const alphaNodes = [...(await buildGraph('alpha', storage)).nodes.values()];

// ── 1 ────────────────────────────────────────────────────────────────────────
section('1. whole words only');
{
  const r = await search('ai');
  ok(!slugs(r).includes('chain-notes'), '"ai" no longer matches a page that has it only inside "chain"');
  ok(oldRank(alphaNodes, 'ai').includes('chain-notes'), 'control: the old scorer matched it');
  eq(slugs(r)[0], 'ai-basics', 'the page about AI is found, first');
  ok(!slugs(await search('gent')).includes('agents-only'), 'a term INSIDE a word never matches ("gent" does not find "agents")');
  ok(!slugs(await search('ai')).includes('aim-notes'), 'a term under 4 letters matches whole words only ("ai" does not find "aim")');
  ok(slugs(await search('Blockchain!')).includes('chain-notes'), 'punctuation around a query word is ignored; a tag word matches');
  eq(terms('End-to-end, C++ & node.js').join(' '), 'end to c node js', 'terms are the query\'s distinct words');
}

// ── 1b ───────────────────────────────────────────────────────────────────────
section('1b. a word PREFIX matches, at lower weight than the whole word');
{
  ok(slugs(await search('encrypt')).includes('vault-encryption'), '"encrypt" finds a page that only says "encryption"');
  ok(slugs(await search('paginate')).includes('api-pagination'), '"paginate" finds "pagination" (a trailing e is dropped for the prefix)');
  const a = slugs(await search('agent'));
  ok(a.includes('agents-only'), '"agent" finds a page that only says "agents"');
  ok(a.indexOf('agent-desk') < a.indexOf('agents-only'), 'the page with the whole word ranks above the page with only the prefix', a.join(', '));
  const r = rankNodes(alphaNodes, 'agent');
  const w = r.find((x) => x.node.slug === 'agent-desk').score, p = r.find((x) => x.node.slug === 'agents-only').score;
  ok(p < w / 2, `a prefix-only page scores well under the whole-word page (${p.toFixed(2)} vs ${w.toFixed(2)})`);
}

// ── 2 ────────────────────────────────────────────────────────────────────────
section('2. an exact name ranks first');
{
  const r = await search('zephyr');
  eq(slugs(r)[0], 'zephyr', '"zephyr" puts zephyr.md first');
  const ranked = rankNodes(alphaNodes, 'zephyr');
  const hub = ranked.find((x) => x.node.slug === 'zephyr-hub-roundup'), page = ranked.find((x) => x.node.slug === 'zephyr');
  ok(hub.score > page.score, 'control: the hub page has the higher score, so the exact-name rule is what puts the page first', `${hub.score.toFixed(2)} vs ${page.score.toFixed(2)}`);
  eq(slugs(await search('Smart Ledgers'))[0], 'ledger-notes', 'a title equal to the query ranks first ("Smart Ledgers" → ledger-notes.md)');
  const rh = rankNodes(alphaNodes, 'smart ledgers');
  ok(rh.find((x) => x.node.slug === 'smart-ledgers-history').score > rh.find((x) => x.node.slug === 'ledger-notes').score, 'control: the history page outscores it');
  eq(slugs(await search('ZEPHYR'))[0], 'zephyr', 'case does not matter');
  eq(slugs(await search('smart ledger'))[0], 'ledger-notes', 'one trailing "s" per word is ignored for the exact name ("smart ledger" names "Smart Ledgers")');
}

// ── 3 ────────────────────────────────────────────────────────────────────────
section('3. repeats and common words no longer decide');
{
  const q = 'ciphertext expiry file default storage';
  eq(oldRank(alphaNodes, q)[0], 'zephyr-hub-roundup', 'control: the old scorer put the big hub first');
  eq(slugs(await search(q))[0], 'drop-architecture', 'the small page with the rare words ranks first now');
  const r = rankNodes(alphaNodes, 'default');
  const hub = r.find((x) => x.node.slug === 'zephyr-hub-roundup'), one = r.find((x) => x.node.slug === 'common-0');
  ok(hub.score / one.score < 7, `300 repeats score ${(hub.score / one.score).toFixed(1)}x one mention (raw counts: 300x)`);
}

// ── 4 ────────────────────────────────────────────────────────────────────────
section('4. order: unrounded score, ties in page order, scores non-increasing');
{
  const r = rankNodes(alphaNodes, 'quokka meadow');
  const ta = r.findIndex((x) => x.node.slug === 'twin-a'), tb = r.findIndex((x) => x.node.slug === 'twin-b');
  const ga = alphaNodes.findIndex((n) => n.slug === 'twin-a'), gb = alphaNodes.findIndex((n) => n.slug === 'twin-b');
  ok(r[ta].score === r[tb].score && (ta < tb) === (ga < gb), 'two identical pages keep the graph\'s page order');
  for (const q of ['zephyr relay file', 'harbours orchards', 'smart ledgers notes', 'default storage value']) {
    const res = await search(q);
    const ranked = rankNodes(alphaNodes, q);
    eq(slugs(res).join(','), ranked.slice(0, 50).map((x) => x.node.slug).join(','), `"${q}": the tool returns the scorer's order`);
    const nonExact = res.results.filter((_, i) => !ranked[i].exact);
    ok(nonExact.every((x, i) => i === 0 || nonExact[i - 1].score >= x.score), `"${q}": returned scores never increase`);
  }
  eq(displayScore(1.23456), 1.23, 'the returned score is rounded to 2 places');
}

// ── 5 ────────────────────────────────────────────────────────────────────────
section('5. search_cross_domain does not bury a small domain');
{
  const q = 'quokka tariff yearly';
  const r = await searchCrossHandler({ query: q, max_results_per_domain: 5 }, storage);
  const order = r.results.map((x) => `${x.domain}/${x.slug}`);
  const iBeta = order.indexOf('beta/quokka-tariffs');
  const alphaRows = r.results.filter((x) => x.domain === 'alpha');
  ok(iBeta >= 0 && iBeta <= 1, 'the small domain\'s best result is among the first two', order.join(', '));
  ok(alphaRows.length >= 2 && order.indexOf(`alpha/${alphaRows[1].slug}`) > iBeta, 'ahead of the large domain\'s second result');
  const rawFirst = [...r.results].sort((a, b) => b.score - a.score).map((x) => `${x.domain}/${x.slug}`);
  ok(rawFirst.indexOf('beta/quokka-tariffs') > iBeta, 'control: merged on raw scores it would sit lower', rawFirst.join(', '));
  // Not a round robin: a domain whose best page only mentions one common word once
  // (gamma: "quokka" on every page) does not jump ahead of a strong match elsewhere.
  const iGamma = order.findIndex((o) => o.startsWith('gamma/'));
  ok(iGamma === -1 || iGamma > order.indexOf(`alpha/${alphaRows[1].slug}`), 'a weak domain\'s best does not jump ahead of a strong domain\'s second result', order.join(', '));
  const firstSix = new Set(r.results.slice(0, 6).map((x) => x.domain));
  ok(firstSix.size < Math.min(6, r.results.length), 'the first results are not one per domain');
  const e = await searchCrossHandler({ query: 'zephyr', max_results_per_domain: 5 }, storage);
  eq(`${e.results[0].domain}/${e.results[0].slug}`, 'alpha/zephyr', 'an exact name is first across domains');
  const perDomain = (await search(q, 'alpha', 5)).results.map((x) => x.slug).join(',');
  eq(alphaRows.map((x) => x.slug).join(','), perDomain, 'each domain\'s rows are that domain\'s search_wiki top results, in order');
}

// ── 6 ────────────────────────────────────────────────────────────────────────
section('6. output shape unchanged');
{
  const r = await search('default', 'alpha', 3);
  eq(Object.keys(r).join(','), 'query,domain,total_matches,returned,results', 'search_wiki top-level keys');
  eq(Object.keys(r.results[0]).join(','), 'slug,path,type,tags,score,outgoing_count,backlink_count,excerpt', 'search_wiki result keys');
  ok(r.returned === 3 && r.total_matches >= 3 && typeof r.results[0].score === 'number', 'counts and score types');
  eq(await search('   '), 'Empty query.', 'an empty query is refused as before');
  const p = await search('???');
  ok(typeof p === 'object' && p.total_matches === 0 && p.results.length === 0, 'a query with no words returns an empty result, not an error');
  const c = await searchCrossHandler({ query: 'zephyr' }, storage);
  eq(Object.keys(c).join(','), 'query,domains_searched,total_matches,results', 'search_cross_domain top-level keys');
  eq(Object.keys(c.results[0]).join(','), 'domain,slug,type,tags,score,excerpt', 'search_cross_domain result keys');
  ok(/^No results found/.test(await searchCrossHandler({ query: 'xylophonequartz' }, storage)), 'no match anywhere: the same message');
}

// ── 7 ────────────────────────────────────────────────────────────────────────
section('7. no stdout');
{
  const orig = process.stdout.write.bind(process.stdout);
  let wrote = 0;
  process.stdout.write = (...a) => { wrote++; return true; };
  try { rankNodes(alphaNodes, 'zephyr relay'); await search('zephyr'); await searchCrossHandler({ query: 'quokka' }, storage); }
  finally { process.stdout.write = orig; }
  eq(wrote, 0, 'ranking and both tools write nothing to stdout');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
