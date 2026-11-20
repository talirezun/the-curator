#!/usr/bin/env node
/**
 * scripts/test-health-large-wiki.js — OFFLINE
 *
 * Wiki health on a very large wiki (2026-11-14). On a generated 22,000-page vault the
 * Health scan blocked the server's event loop for 7.9 s in one piece (12.6 s in all),
 * so every other request in the app waited, and Find duplicates' pass over the page
 * names took 5 minutes (uniform names) or ran out of memory at 1.6 GB (a vault where a
 * few words are in thousands of names). Measured causes, all in src/brain/health.js:
 *
 *   • hyphenVariants compared every pair of entity names, recomputing normKey per pair
 *     (O(n²): 5.4 s of normKey alone at 9,500 entities). Now grouped by key, once.
 *   • missingBacklinks walked every entity and concept for each unresolved bullet, and
 *     re-read a page for every summary naming it. Now one lookup and one read per page.
 *   • findSemanticCandidatePairs ran jaroWinkler (two array allocations each) on all
 *     n²/2 pairs of names and kept every candidate in a Map keyed by strings. Now a
 *     bound that is provably ABOVE jaroWinkler rules most pairs out first, jaroWinkler
 *     reuses two buffers, and past SEMANTIC_MAX_CANDIDATE_PAIRS (100,000) the pass keeps
 *     the most alike by the same ranking (`capped`, `foundPairs`).
 *
 * WHAT IS PINNED. The results must be what they always were, so each fast path is
 * compared with the OLD algorithm, copied below verbatim from v3.98.3 (a reference,
 * not a second implementation the app uses): the scan's variant groups and missing
 * backlinks on a generated wiki, and the candidate pass's whole ranking, byte for byte,
 * on generated names that include Unicode, capitals, digits, spelling variants,
 * acronyms and typos. Past the cap the list must be exactly the reference's first N.
 * Responsiveness is measured, not assumed: the longest stretch the event loop went
 * without running a 5 ms timer, during a scan of 4,000 entities and a pass over 8,000
 * names, must stay under 250 ms (the old code blocked about 1 s and 1.5 s there).
 *
 * NOT ENFORCED: wall-clock totals (CI machines vary), the 22,000-page figures (measured
 * by hand, recorded in docs/dev/decisions-knowledge.md), and serialising a 4 MB
 * report into the HTTP reply (about 150 ms, one block).
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-large-wiki-'));
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'user-data');
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_NO_OPEN = '1';
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });
const REAL_CONFIG = path.join(REPO, '.curator-config.json');
const fp = (f) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent');
const CONFIG_BEFORE = fp(REAL_CONFIG);

const { __setDomainsDirOverride } = await import(pathToFileURL(path.join(REPO, 'src/brain/config.js')).href);
__setDomainsDirOverride(DOMAINS);
const health = await import(pathToFileURL(path.join(REPO, 'src/brain/health.js')).href);
const { isMergeableSlug, acronymIndexPairs, spellingVariantIndexPairs } = await import(pathToFileURL(path.join(REPO, 'src/brain/duplicate-checks.js')).href);

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 1200)}` : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The longest gap between two runs of a 5 ms timer while `fn` runs. */
async function longestBlock(fn) {
  let last = performance.now();
  let worst = 0;
  const iv = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  clearInterval(iv);
  worst = Math.max(worst, performance.now() - last);
  return { result, worst, ms };
}

function mkDomain(name, files) {
  const wiki = path.join(DOMAINS, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of files) writeFileSync(path.join(wiki, rel), body);
  return wiki;
}

// ── The OLD algorithms (v3.98.3), the reference ────────────────────────────
const ARTICLE_PREFIX_RE = /^(the|a|an)-/;
const HONORIFIC_PREFIX_RE = /^(dr|mr|ms|mrs|prof|professor)\.?-/;
const normKey = (slug) => slug.replace(HONORIFIC_PREFIX_RE, '').replace(ARTICLE_PREFIX_RE, '').replace(/-/g, '').toLowerCase();
function oldHyphenVariants(entityFiles) {
  const hyphenVariants = [];
  const seenGroups = new Set();
  for (let i = 0; i < entityFiles.length; i++) {
    const stemA = entityFiles[i].slice(0, -3);
    if (seenGroups.has(stemA)) continue;
    const group = [stemA];
    const normA = normKey(stemA);
    for (let j = i + 1; j < entityFiles.length; j++) {
      const stemB = entityFiles[j].slice(0, -3);
      if (seenGroups.has(stemB)) continue;
      if (normA === normKey(stemB)) { group.push(stemB); seenGroups.add(stemB); }
    }
    if (group.length > 1) {
      const canonical = group.slice().sort((a, b) => {
        const hasHon = (s) => HONORIFIC_PREFIX_RE.test(s) ? 1 : 0;
        const diffHon = hasHon(a) - hasHon(b);
        if (diffHon !== 0) return diffHon;
        const hy = (s) => (s.match(/-/g) || []).length;
        const diff = hy(b) - hy(a);
        return diff !== 0 ? diff : a.length - b.length;
      })[0];
      hyphenVariants.push({ files: group, suggestedSlug: canonical });
      seenGroups.add(stemA);
    }
  }
  return hyphenVariants;
}
function oldDashlessTarget(name, entityFiles, conceptFiles) {
  const norm = name.replace(/-/g, '').toLowerCase();
  for (const f of entityFiles) if (f.replace(/-/g, '').toLowerCase() === norm + '.md') return `entities/${f}`;
  for (const f of conceptFiles) if (f.replace(/-/g, '').toLowerCase() === norm + '.md') return `concepts/${f}`;
  return null;
}

const STOPWORDS = new Set(['a','an','the','of','in','and','or','to','for','is','are','on','at','by','with','from','as','it','this','that','be','was','were','has','have','but','not','if','can','will','its','can','we','our','your','their']);
const tokenizeSlug = (slug) => slug.toLowerCase().split(/[-_]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
function oldJaroWinkler(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatch = new Array(la).fill(false);
  const bMatch = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(lb, i + matchDist + 1);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let p = 0;
  const maxP = Math.min(4, la, lb);
  while (p < maxP && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}
function oldScore(slugA, slugB, sharedTokens) {
  const tokensA = tokenizeSlug(slugA);
  const tokensB = tokenizeSlug(slugB);
  const maxTokens = Math.max(tokensA.length, tokensB.length);
  const tokenOverlap = maxTokens > 0 ? sharedTokens / maxTokens : 0;
  const jw = oldJaroWinkler(slugA, slugB);
  const lenRatio = Math.min(slugA.length, slugB.length) / Math.max(slugA.length, slugB.length);
  return 0.5 * tokenOverlap + 0.35 * jw + 0.15 * lenRatio;
}
function oldRanking(entities, concepts) {
  const allSlugs = [...entities.map((s) => ({ slug: s, folder: 'entities' })), ...concepts.map((s) => ({ slug: s, folder: 'concepts' }))]
    .filter((p) => isMergeableSlug(p.slug));
  const tokenIndex = new Map();
  const slugTokens = allSlugs.map((p, i) => {
    const toks = tokenizeSlug(p.slug);
    for (const t of toks) { if (!tokenIndex.has(t)) tokenIndex.set(t, []); tokenIndex.get(t).push(i); }
    return toks;
  });
  const pairMap = new Map();
  for (let i = 0; i < allSlugs.length; i++) {
    const toks = slugTokens[i];
    if (toks.length === 0) continue;
    const cand = new Set();
    for (const t of toks) for (const j of tokenIndex.get(t)) if (j > i) cand.add(j);
    for (const j of cand) {
      const shared = slugTokens[i].filter((t) => slugTokens[j].includes(t)).length;
      if (shared === 0) continue;
      if (allSlugs[i].slug === allSlugs[j].slug) continue;
      const score = oldScore(allSlugs[i].slug, allSlugs[j].slug, shared);
      if (score < 0.5) continue;
      pairMap.set(`${i}|${j}`, { i, j, score });
    }
  }
  const n = allSlugs.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (pairMap.has(`${i}|${j}`)) continue;
      if (allSlugs[i].slug === allSlugs[j].slug) continue;
      const jw = oldJaroWinkler(allSlugs[i].slug, allSlugs[j].slug);
      if (jw >= 0.85) pairMap.set(`${i}|${j}`, { i, j, score: 0.5 * jw + 0.5 });
    }
  }
  const names = allSlugs.map((s) => s.slug);
  for (const [i, j] of acronymIndexPairs(names, STOPWORDS)) if (names[i] !== names[j]) pairMap.set(`${i}|${j}`, { i, j, score: 1, tier: 1 });
  for (const [i, j] of spellingVariantIndexPairs(names)) pairMap.set(`${i}|${j}`, { i, j, score: 1, tier: 0 });
  const tierOf = (p) => (p.tier === undefined ? 2 : p.tier);
  return [...pairMap.values()].sort((a, b) => (tierOf(a) - tierOf(b)) || (b.score - a.score)).map((p) => ({
    slugA: allSlugs[p.i].slug, folderA: allSlugs[p.i].folder, slugB: allSlugs[p.j].slug, folderB: allSlugs[p.j].folder,
    score: Number(p.score.toFixed(3)),
  }));
}

// ── Generated names ────────────────────────────────────────────────────────
const WORDS = ['agent', 'memory', 'model', 'graph', 'neural', 'network', 'data', 'vector', 'store', 'retrieval', 'augmented',
  'generation', 'context', 'window', 'prompt', 'cache', 'token', 'gpt', 'claude', 'opus', 'llama', 'mistral', 'orchestration',
  'knowledge', 'base', 'search', 'engine', 'čevapi', 'über', 'straße', 'learning', 'deep', 'reinforcement', 'policy', 'value'];
function names(count, seed) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const out = new Set();
  while (out.size < count) {
    const k = 1 + Math.floor(rnd() * 3);
    let s = Array.from({ length: k }, () => pick(WORDS)).join(rnd() < 0.1 ? '_' : '-');
    const r = rnd();
    if (r < 0.06) s = s + 's';                                   // a plural
    else if (r < 0.1) s = s.replace(/-/g, '');                    // hyphens dropped
    else if (r < 0.14 && s.length > 4) { const i = 1 + Math.floor(rnd() * (s.length - 2)); s = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2); } // a typo
    else if (r < 0.17) s = s + '-' + Math.floor(rnd() * 12);     // a version
    else if (r < 0.19) s = s[0].toUpperCase() + s.slice(1);      // a capital
    else if (r < 0.21) s = s.split(/[-_]/).map((w) => w[0]).join(''); // an acronym
    if (s && !s.startsWith('-')) out.add(s);
  }
  return [...out];
}

/** Names from made-up words, as a large vault of distinct topics has: few shared words. Lower case, unique. */
function syllableNames(count, seed) {
  const rnd = mulberry32(seed);
  const SYL = ['ka', 'lo', 'mi', 'ner', 'tor', 'va', 'syn', 'pra', 'dex', 'qui', 'zen', 'mor', 'tal', 'ri', 'bo', 'gen', 'lux', 'pha', 'stra', 'col'];
  const word = () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => SYL[Math.floor(rnd() * SYL.length)]).join('');
  const vocab = Array.from({ length: 1500 }, word);
  const out = new Set();
  while (out.size < count) out.add(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => vocab[Math.floor(rnd() * vocab.length)]).join('-'));
  return [...out];
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. The scan: variant groups and missing links back are what they were');
{
  const rnd = mulberry32(42);
  const ents = names(1500, 1).filter((s) => !s.includes('_'));
  // Variant shapes the old rule groups: honorifics, articles, hyphens and case.
  for (let i = 0; i < 60; i++) {
    const s = ents[i * 7];
    ents.push(['dr-', 'the-', 'prof.-', 'a-'][i % 4] + s, s.replace(/-/g, '').toUpperCase());
  }
  const cons = names(600, 2).map((s) => s + '-idea');
  const files = [];
  for (const s of ents) files.push([`entities/${s}.md`, `# ${s}\n\n## Related\n- [[summaries/sum-${Math.floor(rnd() * 40)}]]\n`]);
  for (const s of cons) files.push([`concepts/${s}.md`, `# ${s}\n\n## Related\n- [[${ents[Math.floor(rnd() * ents.length)]}]]\n`]);
  for (let k = 0; k < 40; k++) {
    const b = [];
    for (let m = 0; m < 25; m++) {
      const t = rnd() < 0.5 ? ents[Math.floor(rnd() * ents.length)] : cons[Math.floor(rnd() * cons.length)];
      // Some bullets name the page without its hyphens or in capitals: only the dashless lookup finds them.
      b.push(`- [[${rnd() < 0.3 ? t.replace(/-/g, '').toUpperCase() : t}]] — mentioned`);
    }
    files.push([`summaries/sum-${k}.md`, `# Sum ${k}\n\n## Entities Mentioned\n${b.join('\n')}\n\n## Concepts Introduced or Referenced\n${b.slice(0, 5).join('\n')}\n`]);
  }
  const wiki = mkDomain('scan-identity', files);
  const report = await health.scanWiki('scan-identity', { noCache: true });
  const entityFiles = await health.listMd(wiki, 'entities');
  const conceptFiles = await health.listMd(wiki, 'concepts');
  const want = oldHyphenVariants(entityFiles);
  ok(want.length >= 60, '1.1 the fixture has variant groups to find', String(want.length));
  ok(JSON.stringify(report.hyphenVariants) === JSON.stringify(want), '1.2 the variant groups are the old pairwise loop\'s, in its order',
    JSON.stringify({ got: report.hyphenVariants.slice(0, 2), want: want.slice(0, 2) }));
  // The dashless lookup, against the old walk, for every name the summaries hold.
  let agree = 0, total = 0;
  const dashless = new Map();
  for (const f of entityFiles) { const k = f.replace(/-/g, '').toLowerCase(); if (!dashless.has(k)) dashless.set(k, `entities/${f}`); }
  const dashlessC = new Map();
  for (const f of conceptFiles) { const k = f.replace(/-/g, '').toLowerCase(); if (!dashlessC.has(k)) dashlessC.set(k, `concepts/${f}`); }
  for (const s of [...ents, ...cons]) {
    const name = s.replace(/-/g, '').toUpperCase();
    const k = name.replace(/-/g, '').toLowerCase() + '.md';
    const got = dashless.get(k) || dashlessC.get(k) || null;
    total++;
    if (got === oldDashlessTarget(name, entityFiles, conceptFiles)) agree++;
  }
  ok(agree === total, `1.3 one lookup finds the page the old walk found, for all ${total} names`, `${agree}/${total}`);
  ok(report.missingBacklinks.length > 100, '1.4 the fixture has missing links back to report', String(report.missingBacklinks.length));
  // Every row the scan reports is one the old rule reports: the summary names the page and the page lacks the link back.
  const bad = report.missingBacklinks.filter((m) => {
    const page = readFileSync(path.join(wiki, m.entity), 'utf8');
    return page.includes(`[[summaries/${m.summarySlug}]]`);
  });
  ok(bad.length === 0, '1.5 no reported page already links back', JSON.stringify(bad.slice(0, 2)));
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. The scan stays responsive on 4,000 entities');
{
  const files = [];
  const ents = syllableNames(4000, 3);
  for (const s of ents) files.push([`entities/${s}.md`, `# ${s}\n\n## Related\n- [[${ents[0]}]]\n`]);
  mkDomain('scan-big', files);
  const { result, worst, ms } = await longestBlock(() => health.scanWiki('scan-big', { noCache: true }));
  console.log(`     ${ents.length} entities · scan ${ms.toFixed(0)} ms · longest block ${worst.toFixed(0)} ms`);
  ok(result.counts.entities === ents.length, '2.1 the scan read every page');
  ok(worst < 250, `2.2 the event loop never waited 250 ms (longest ${worst.toFixed(0)} ms)`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. Find duplicates: the ranking is the old one, byte for byte');
const idEnts = names(800, 11);
const idCons = [...names(400, 12), ...idEnts.slice(0, 30)];      // the same name in both folders too
// The names as the disk lists them: a case-insensitive disk folds `Agent` into `agent`.
const idWiki = mkDomain('dupes-identity', [
  ...idEnts.map((s) => [`entities/${s}.md`, `# ${s}\n`]),
  ...idCons.map((s) => [`concepts/${s}.md`, `# ${s}\n`]),
]);
const stem = (f) => f.slice(0, -3);
const reference = oldRanking((await health.listMd(idWiki, 'entities')).map(stem), (await health.listMd(idWiki, 'concepts')).map(stem));
{
  const ticks = [];
  const r = await health.findSemanticCandidatePairs('dupes-identity', Number.MAX_SAFE_INTEGER, { includeRanked: true, onProgress: (p) => ticks.push(p) });
  ok(reference.length > 2000, '3.1 the fixture has thousands of candidate pairs', String(reference.length));
  const tiers = reference.filter((p) => p.score === 1).length;
  ok(tiers > 20, '3.2 …spelling variants and acronyms among them', String(tiers));
  ok(r.ranked.length === reference.length && JSON.stringify(r.ranked) === JSON.stringify(reference),
    '3.3 every pair, every score and the order are the old algorithm\'s', (() => {
      const k = r.ranked.findIndex((p, i) => JSON.stringify(p) !== JSON.stringify(reference[i]));
      return `lengths ${r.ranked.length}/${reference.length}, first difference at ${k}: ${JSON.stringify(r.ranked[k])} vs ${JSON.stringify(reference[k])}`;
    })());
  ok(r.capped === undefined && r.foundPairs === undefined, '3.4 under the limit the reply has no new fields');
  ok(ticks.length > 0 && ticks.at(-1).done === ticks.at(-1).total && ticks.every((t, i) => i === 0 || t.done >= ticks[i - 1].done),
    '3.5 progress is reported, never goes back, and ends at the total', JSON.stringify(ticks.slice(-2)));
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. Past the limit: the most alike, exactly the old ranking\'s first N');
{
  for (const cap of [1, 37, 500, 1999]) {
    const r = await health.findSemanticCandidatePairs('dupes-identity', Number.MAX_SAFE_INTEGER, { includeRanked: true, maxCandidates: cap });
    ok(r.capped === true && r.foundPairs === reference.length && r.ranked.length === cap
      && JSON.stringify(r.ranked) === JSON.stringify(reference.slice(0, cap)),
    `4.${cap} cap ${cap}: capped, foundPairs is every pair, the list is the reference's first ${cap}`,
    JSON.stringify({ capped: r.capped, found: r.foundPairs, len: r.ranked.length }));
  }
  const all = await health.findSemanticCandidatePairs('dupes-identity', 10, { includeRanked: true, maxCandidates: reference.length });
  ok(!all.capped && all.ranked.length === reference.length && all.pairs.length === 10 && all.truncated === true,
    '4.9 a limit equal to the total cuts nothing, and maxPairs still cuts the reply');
}

// Many pairs with exactly the same score: `topic-10` / `topic-11` and every other pair
// of one topic score alike, so the limit falls inside a run of ties, where the order
// found decides, and the compaction must keep the earliest of them.
{
  const tied = [];
  for (const t of ['alpha', 'gamma', 'sigma']) for (let k = 10; k < 50; k++) tied.push(`${t}-${k}`);
  const tw = mkDomain('dupes-ties', tied.map((x) => [`entities/${x}.md`, '#\n']));
  const ref = oldRanking((await health.listMd(tw, 'entities')).map(stem), []);
  const scores = new Map();
  for (const p of ref) scores.set(p.score, (scores.get(p.score) || 0) + 1);
  ok(Math.max(...scores.values()) > 500, '4.10 the fixture is mostly ties', JSON.stringify([...scores].slice(0, 3)));
  for (const cap of [5, 100, 333, 1000]) {
    const r = await health.findSemanticCandidatePairs('dupes-ties', Number.MAX_SAFE_INTEGER, { includeRanked: true, maxCandidates: cap });
    ok(r.capped === true && JSON.stringify(r.ranked) === JSON.stringify(ref.slice(0, cap)),
      `4.11 cap ${cap} inside a run of ties: the reference's first ${cap}, in its order`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. Find duplicates stays responsive on 8,000 names');
{
  // Names that share almost nothing: nearly every pair is ruled out by the bound and
  // never scored, so only the time-sliced yield can hand the loop back.
  const rnd = mulberry32(77);
  const ABC = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const far = new Set();
  while (far.size < 8000) far.add(Array.from({ length: 18 }, () => ABC[Math.floor(rnd() * ABC.length)]).join(''));
  mkDomain('dupes-far', [...far].map((x) => [`entities/${x}.md`, '#\n']));
  const { worst, ms } = await longestBlock(() => health.findSemanticCandidatePairs('dupes-far', 500));
  console.log(`     8000 unlike names · pass ${ms.toFixed(0)} ms · longest block ${worst.toFixed(0)} ms`);
  ok(worst < 250, `5.0 names the bound rules out still let the loop run (longest ${worst.toFixed(0)} ms)`);
}
{
  const big = syllableNames(8000, 21);
  mkDomain('dupes-big', big.map((s, i) => [`${i % 2 ? 'concepts' : 'entities'}/${s}.md`, '#\n']));
  const { result, worst, ms } = await longestBlock(() => health.findSemanticCandidatePairs('dupes-big', 500));
  console.log(`     ${big.length} names · pass ${ms.toFixed(0)} ms · longest block ${worst.toFixed(0)} ms · ${result.totalCandidates} pairs`);
  ok(result.pageCount === big.length, '5.1 the pass saw every name');
  ok(worst < 250, `5.2 the event loop never waited 250 ms (longest ${worst.toFixed(0)} ms)`);
}

ok(fp(REAL_CONFIG) === CONFIG_BEFORE, '6. the real .curator-config.json is byte-identical');
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
