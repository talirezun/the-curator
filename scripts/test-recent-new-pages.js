#!/usr/bin/env node
/**
 * scripts/test-recent-new-pages.js — OFFLINE
 *
 * Stopping duplicates at ingest, the "ask after writing" stage. Ingest folds nothing
 * beyond a spelling variant. It records which pages it created, outside domains/; the
 * duplicate scan compares those first; and the ingest's result says so in one line.
 *
 * ── WHAT THIS PINS ────────────────────────────────────────────────────────
 *   1. The record: created concepts and entities only, capped, oldest out, gone pages
 *      out, a bad file reads as empty, a failed write only says so on stderr.
 *   2. The order: new pairs go first in estimate and scan alike, each side keeping its
 *      order; no record or a corrupt one gives exactly today's order.
 *   3. findSemanticCandidatePairs is unaffected by the record.
 *   4. New pairs do not starve old ones: once answered, the next scan moves on.
 *   5. A merged or deleted page stops counting at once and leaves the file on a scan.
 *   6. candidatePairsTouching agrees with the full pass (generated names, both
 *      folders, repeated tokens, acronyms, spelling variants, dismissals).
 *   7. A real ingest: records what it created, no extra model call, no extra page in
 *      the wiki, and it survives an unwritable record.
 *   8. The figures reach the done event, the restored panel and a batch's wire record.
 *   9. The line itself, executed from the view: its wording, and no line at zero.
 *
 * ── METHOD ────────────────────────────────────────────────────────────────
 * Real on-disk fixtures and real exported functions, through the `opts.llm` and
 * `opts.generateText` seams. Isolated with CURATOR_TEST_USER_DATA_DIR and
 * CURATOR_TEST_DOMAINS_DIR, set before any app module loads, and
 * __setDomainsDirOverride. The provider key is fake and no call uses it.
 *
 * ── NOT ENFORCED ──────────────────────────────────────────────────────────
 *   • The scroll to Wiki health: the view is not in a browser here.
 *   • Whether the names a pair shares mean anything: a duplicate whose name is unlike
 *     its partner's is never a candidate, as before.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-recent-new-'));
const USER_DIR = path.join(ROOT, 'user');
const DOMAINS_DIR = path.join(ROOT, 'domains');
mkdirSync(USER_DIR);
mkdirSync(DOMAINS_DIR);
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DIR;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS_DIR;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(ROOT, 'instances');
process.env.GEMINI_API_KEY = 'fake-key-never-sent';
process.env.LLM_PROVIDER = 'gemini';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.LLM_MODEL;

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS_DIR);
const rec = await import(path.join(REPO, 'src/brain/recent-new-pages.js'));
const health = await import(path.join(REPO, 'src/brain/health.js'));
const ai = await import(path.join(REPO, 'src/brain/health-ai.js'));
const { addDismissal } = await import(path.join(REPO, 'src/brain/health-dismissed.js'));
const { getRecentNewPagesDir } = await import(path.join(REPO, 'src/brain/paths.js'));
const { ingestFile } = await import(path.join(REPO, 'src/brain/ingest.js'));

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`); }

let seq = 0;
function mkDomain(files = {}) {
  const name = 'recent' + (++seq);
  const wiki = path.join(DOMAINS_DIR, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  mkdirSync(path.join(DOMAINS_DIR, name, 'raw'), { recursive: true });
  writeFileSync(path.join(DOMAINS_DIR, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(wiki, rel), body);
  return { name, wiki };
}
const page = (title) => `---\ntype: concept\n---\n\n# ${title}\n\nAbout ${title}.\n\n## Key Facts\n\n- a fact\n`;
const pagesFrom = (slugs, folder = 'concepts') => Object.fromEntries(slugs.map((s) => [`${folder}/${s}.md`, page(s)]));
const recordFile = (name) => path.join(getRecentNewPagesDir(), name + '.json');
const readRecord = (name) => JSON.parse(readFileSync(recordFile(name), 'utf8')).pages;

function pairsIn(userPrompt) {
  const out = [];
  const re = /--- PAIR (\d+) ---\nA: \[([^\]]+)\]\n[\s\S]*?\nB: \[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(userPrompt))) out.push({ index: Number(m[1]), a: m[2], b: m[3] });
  return out;
}
function fakeLLM() {
  const fn = async (sys, user) => {
    fn.calls++;
    const pairs = pairsIn(user);
    fn.sent.push(...pairs.map((p) => [p.a, p.b]));
    return JSON.stringify({ results: pairs.map((p) => ({ index: p.index, relation: 'different', difference: 'unrelated', canonicalSlug: p.a.split('/')[1], rationale: 'no' })) });
  };
  fn.calls = 0;
  fn.sent = [];
  return fn;
}
const scan = async (name, llm, opts = {}) => {
  const events = [];
  await ai.scanSemanticDuplicates(name, { maxPairs: 500, costCeilingTokens: 10_000_000, generateText: llm, ...opts }, (e) => events.push(e));
  return { events, start: events.find((e) => e.type === 'start'), done: events.find((e) => e.type === 'done') };
};
const treeHash = (dir) => {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(d, f.name);
      h.update(path.relative(dir, full));
      if (f.isDirectory()) walk(full); else h.update(readFileSync(full));
    }
  };
  walk(dir);
  return h.digest('hex');
};
const quiet = async (fn) => {
  const e = console.error, w = console.warn;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  console.warn = (...a) => logged.push(a.join(' '));
  try { return { value: await fn(), logged }; }
  finally { console.error = e; console.warn = w; }
};

// The old stock shares "alpha" and "beta"; the new pages share "gamma", so an unordered
// list puts their pairs after the old ones (a shared-token score sorts by name shape).
const OLD = ['alpha-beta-one', 'alpha-beta-two', 'alpha-beta-tri', 'alpha-beta-four', 'alpha-beta-five', 'alpha-beta-six'];
const NEW = ['gamma-research-notes-long-title', 'gamma-research-study-other-text'];
const touchesNew = ([a, b]) => NEW.some((n) => a === 'concepts/' + n || b === 'concepts/' + n);

try {
  // ──────────────────────────────────────────────────────────────────────────
  section('1. The record');
  {
    eq(rec.createdPageKeys([
      { canonPath: 'concepts/a.md', status: 'created' },
      { canonPath: 'entities/b.md', status: 'created' },
      { canonPath: 'summaries/s.md', status: 'created' },
      { canonPath: 'index.md', status: 'created' },
      { canonPath: 'concepts/old.md', status: 'updated' },
      { canonPath: 'concepts/same.md', status: 'unchanged' },
      null,
    ]), ['concepts/a', 'entities/b'], 'only created concepts and entities, never a summary, the index or an update');
    eq(rec.createdPageKeys(undefined), [], 'no change list, no pages');

    const d = mkDomain(pagesFrom(['p1', 'p2', 'p3']));
    ok(await rec.recordRecentNewPages(d.name, ['concepts/p1', 'concepts/p2'], d.wiki), 'saves');
    await rec.recordRecentNewPages(d.name, ['concepts/p3', 'concepts/p1'], d.wiki);
    eq(readRecord(d.name), ['concepts/p2', 'concepts/p3', 'concepts/p1'], 'newest last, a name appears once');
    ok(!existsSync(path.join(d.wiki, '..', '.recent-new-pages')) && !treeHas(path.join(DOMAINS_DIR, d.name), 'recent-new-pages'), 'nothing is written under domains/');

    // The cap, with a real file for every name: a gone page would otherwise leave first.
    const many = Array.from({ length: rec.RECENT_NEW_PAGES_CAP + 40 }, (_, i) => `n${i}`);
    const big = mkDomain();
    for (const s of many) writeFileSync(path.join(big.wiki, 'concepts', s + '.md'), 'x');
    await rec.recordRecentNewPages(big.name, many.slice(0, 100).map((s) => 'concepts/' + s), big.wiki);
    await rec.recordRecentNewPages(big.name, many.slice(100).map((s) => 'concepts/' + s), big.wiki);
    const capped = readRecord(big.name);
    eq(capped.length, rec.RECENT_NEW_PAGES_CAP, 'capped');
    eq(capped[0], `concepts/n40`, 'the oldest names are the ones that went');
    eq(capped.at(-1), `concepts/n${many.length - 1}`, 'the newest stayed');
    // A file made too long by hand is capped on the way in as well.
    writeFileSync(recordFile(big.name), JSON.stringify({ format: 1, pages: many.map((s) => 'concepts/' + s) }));
    eq((await rec.loadRecentNewPages(big.name)).size, rec.RECENT_NEW_PAGES_CAP, 'an oversized file is capped when read');

    const gone = mkDomain(pagesFrom(['stay', 'go']));
    await rec.recordRecentNewPages(gone.name, ['concepts/stay', 'concepts/go'], gone.wiki);
    rmSync(path.join(gone.wiki, 'concepts/go.md'));
    writeFileSync(path.join(gone.wiki, 'concepts/fresh.md'), page('fresh'));
    await rec.recordRecentNewPages(gone.name, ['concepts/fresh'], gone.wiki);
    eq(readRecord(gone.name), ['concepts/stay', 'concepts/fresh'], 'a later ingest drops a page that has gone');

    const shapes = mkDomain(pagesFrom(['x']));
    mkdirSync(getRecentNewPagesDir(), { recursive: true });
    for (const [label, body] of [
      ['not JSON', '{nope'],
      ['wrong format', JSON.stringify({ format: 99, pages: ['concepts/x'] })],
      ['no list', JSON.stringify({ format: 1, pages: 'concepts/x' })],
      ['null', 'null'],
    ]) {
      writeFileSync(recordFile(shapes.name), body);
      eq([...(await rec.loadRecentNewPages(shapes.name))], [], `a bad file (${label}) reads as empty`);
    }
    writeFileSync(recordFile(shapes.name), JSON.stringify({ format: 1, pages: ['concepts/x', '../../etc/passwd', 'summaries/s', 'concepts/a/b', 7] }));
    eq([...(await rec.loadRecentNewPages(shapes.name))], ['concepts/x'], 'entries that are not pages are ignored');

    // A failed write: reported on stderr, and never on stdout (this module is reachable from mcp/).
    const blocked = mkDomain(pagesFrom(['x']));
    const realStdout = process.stdout.write;
    const realStderr = process.stderr.write;
    let out = '', err = '';
    mkdirSync(recordFile(blocked.name), { recursive: true }); // the file's path is a folder
    process.stdout.write = (s) => { out += s; return true; };
    process.stderr.write = (s) => { err += s; return true; };
    let threw = false, saved = true;
    try { saved = await rec.recordRecentNewPages(blocked.name, ['concepts/x'], blocked.wiki); }
    catch { threw = true; }
    finally { process.stdout.write = realStdout; process.stderr.write = realStderr; }
    rmSync(recordFile(blocked.name), { recursive: true });
    ok(!threw && saved === false, 'a failed write returns false and does not throw');
    ok(out === '' && /could not save/.test(err), 'it says so on stderr and nothing on stdout', `stdout=${JSON.stringify(out)}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('2. New pairs go first, in the estimate and the scan alike');
  {
    const d = mkDomain(pagesFrom([...OLD, ...NEW]));
    const plain = await health.findSemanticCandidatePairs(d.name, Number.MAX_SAFE_INTEGER);
    const plainList = plain.pairs.map((p) => [`${p.folderA}/${p.slugA}`, `${p.folderB}/${p.slugB}`]);
    ok(plainList.length > 6, 'CONTROL: the fixture has more pairs than one small scan sends');
    ok(!touchesNew(plainList[0]), 'CONTROL: without a record the first pair is an old one');
    const newCount = plainList.filter(touchesNew).length;
    ok(newCount > 0, 'CONTROL: the new pages do have pairs');

    // No record at all: exactly today's order.
    const noneLLM = fakeLLM();
    const noneRun = await scan(d.name, noneLLM, { maxPairs: 5 });
    eq(noneLLM.sent.map((p) => p.join(' ')), plainList.slice(0, 5).map((p) => p.join(' ')), 'no record: the scan sends the top of the old order');
    eq(noneRun.start.recentNewPages, { pages: 0, pairs: 0 }, 'no record: nothing is reported as new');

    // Same fixture, unanswered, with a record.
    const d2 = mkDomain(pagesFrom([...OLD, ...NEW]));
    await rec.recordRecentNewPages(d2.name, NEW.map((n) => 'concepts/' + n), d2.wiki);
    const before = await health.findSemanticCandidatePairs(d2.name, Number.MAX_SAFE_INTEGER);
    eq(before.pairs, plain.pairs, 'findSemanticCandidatePairs is identical whatever the record says');

    const est = await ai.estimateSemanticDuplicateScan(d2.name, newCount + 1);
    eq(est.candidatePairs, newCount + 1, 'the estimate prices what will be sent');
    eq(est.recentNewPages, { pages: NEW.length, pairs: newCount }, 'the estimate reports the new pages and their pairs');
    eq(est.totalPairs, plainList.length, 'the record changes the order, never the coverage figures');
    const compareAll = await ai.estimateCompareAll(d2.name);
    eq(compareAll.recentNewPages, { pages: NEW.length, pairs: newCount }, 'Compare all reports them too');

    const llm = fakeLLM();
    const run = await scan(d2.name, llm, { maxPairs: newCount + 1 });
    eq(llm.sent.slice(0, newCount).filter(touchesNew).length, newCount, 'every new pair is sent ahead of any old one');
    ok(!touchesNew(llm.sent[newCount]), 'the old pairs follow');
    eq(llm.sent.filter((p) => !touchesNew(p)).map((p) => p.join(' ')),
      plainList.filter((p) => !touchesNew(p)).slice(0, 1).map((p) => p.join(' ')),
      'the old side keeps its own order');
    eq(run.start.recentNewPages, { pages: NEW.length, pairs: newCount }, 'the scan\'s start event says so');

    // Corrupt: today's order, and no crash.
    const d3 = mkDomain(pagesFrom([...OLD, ...NEW]));
    mkdirSync(getRecentNewPagesDir(), { recursive: true });
    writeFileSync(recordFile(d3.name), '{broken');
    const lost = fakeLLM();
    await scan(d3.name, lost, { maxPairs: 5 });
    eq(lost.sent.map((p) => p.join(' ')), plainList.slice(0, 5).map((p) => p.join(' ')), 'a corrupt record: the old order');
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('3. Spelling variants still lead among the new pairs');
  {
    const d = mkDomain(pagesFrom(['neural-network', 'neural-networks', 'neural-network-layers', 'alpha-beta-one', 'alpha-beta-two']));
    await rec.recordRecentNewPages(d.name, ['concepts/neural-networks'], d.wiki);
    const llm = fakeLLM();
    await scan(d.name, llm, { maxPairs: 1 });
    eq(llm.sent[0].sort(), ['concepts/neural-network', 'concepts/neural-networks'], 'the variant is the first pair sent');
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('4. New pairs do not starve the old ones');
  {
    const d = mkDomain(pagesFrom([...OLD, ...NEW]));
    await rec.recordRecentNewPages(d.name, NEW.map((n) => 'concepts/' + n), d.wiki);
    const first = await ai.estimateSemanticDuplicateScan(d.name, 500);
    const firstNew = first.recentNewPages.pairs;
    const answered = fakeLLM();
    await scan(d.name, answered, { maxPairs: firstNew });
    ok(answered.sent.every(touchesNew) && answered.sent.length === firstNew, 'first scan: the new pairs');
    const after = await ai.estimateSemanticDuplicateScan(d.name, 500);
    eq(after.recentNewPages, { pages: 0, pairs: 0 }, 'answered pairs stop counting as new');
    const next = fakeLLM();
    await scan(d.name, next, { maxPairs: 3 });
    ok(next.sent.length === 3 && !next.sent.some(touchesNew), 'next scan: old pairs, none of the new ones again');
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('5. A merged or deleted page leaves');
  {
    const d = mkDomain(pagesFrom([...OLD, ...NEW, 'gamma-research-study-third-text']));
    await rec.recordRecentNewPages(d.name, NEW.map((n) => 'concepts/' + n), d.wiki);
    const res = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: OLD[0], keepFolder: 'concepts', removeSlug: NEW[0], removeFolder: 'concepts' });
    ok(res && !existsSync(path.join(d.wiki, 'concepts', NEW[0] + '.md')), 'CONTROL: the merge removed the new page');
    const est = await ai.estimateSemanticDuplicateScan(d.name, 500);
    eq(est.recentNewPages.pages, 1, 'a merged page stops counting at once');
    const status = await ai.semanticScanStatus(d.name, 500);
    eq(status.hasChecks, false, 'CONTROL: this domain has no answers, so status answers without a pass');
    await scan(d.name, fakeLLM(), { maxPairs: 1 });
    eq(readRecord(d.name), ['concepts/' + NEW[1]], 'and leaves the file at the next scan');
    const status2 = await ai.semanticScanStatus(d.name, 500);
    eq(status2.recentNewPages && status2.recentNewPages.pages <= 1, true, 'the panel status carries the figure once a domain has answers');

    rmSync(path.join(d.wiki, 'concepts', NEW[1] + '.md'));
    eq((await ai.estimateSemanticDuplicateScan(d.name, 500)).recentNewPages, { pages: 0, pairs: 0 }, 'a page deleted by hand stops counting too');
    const quietPass = await rec.pruneRecentNewPages(d.name, d.wiki);
    ok(quietPass === true && readRecord(d.name).length === 0, 'and a prune empties the file');
    ok(await rec.pruneRecentNewPages(d.name, d.wiki) === false, 'a prune with nothing to do writes nothing');
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('6. The targeted pass agrees with the full pass');
  {
    const WORDS = ['agent', 'memory', 'model', 'context', 'retrieval', 'augmented', 'generation', 'of', 'the', 'network', 'neural', 'a', 'ai', 'learning', 'graph'];
    let s = 12345;
    const rnd = (n) => { // mulberry32: an unlucky generator's short cycle would hang the loop below
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const slugs = new Set(['retrieval-augmented-generation', 'rag', 'neural-network', 'neural-networks', 'hand-off', 'handoff', 'model-model-agent', 'agent-model', 'memory_graph', 'memory-graph', 'gpt-4-1', 'gpt-41', 'x', 'aaa']);
    while (slugs.size < 130) {
      const len = 1 + rnd(4);
      slugs.add(Array.from({ length: len }, () => WORDS[rnd(WORDS.length)]).join('-') + (rnd(5) === 0 ? 's' : ''));
    }
    const all = [...slugs];
    const files = {};
    all.forEach((slug, i) => { files[`${i % 3 === 0 ? 'entities' : 'concepts'}/${slug}.md`] = page(slug); });
    files['entities/same-in-both.md'] = page('same');
    files['concepts/same-in-both.md'] = page('same');
    const d = mkDomain(files);
    const keyOf = (p) => { const a = `${p.folderA}/${p.slugA}`, b = `${p.folderB}/${p.slugB}`; return a < b ? a + '||' + b : b + '||' + a; };

    let compared = 0;
    for (let t = 0; t < 6; t++) {
      const wanted = t === 0 ? ['concepts/same-in-both', 'entities/same-in-both'] : Array.from({ length: 1 + rnd(25) }, () => {
        const f = Object.keys(files)[rnd(Object.keys(files).length)];
        return f.slice(0, -3);
      });
      const set = new Set(wanted);
      const full = (await health.findSemanticCandidatePairs(d.name, Number.MAX_SAFE_INTEGER)).pairs;
      const expect = full.filter((p) => set.has(`${p.folderA}/${p.slugA}`) || set.has(`${p.folderB}/${p.slugB}`)).map(keyOf).sort();
      const got = (await health.candidatePairsTouching(d.name, wanted)).map(keyOf).sort();
      ok(JSON.stringify(got) === JSON.stringify(expect), `round ${t}: the same ${expect.length} pairs`, `missing ${expect.filter((k) => !got.includes(k)).slice(0, 3)}; extra ${got.filter((k) => !expect.includes(k)).slice(0, 3)}`);
      compared += expect.length;
    }
    ok(compared > 100, 'CONTROL: the comparison saw real pairs', String(compared));
    eq((await health.candidatePairsTouching(d.name, [])).length, 0, 'no pages, no pairs');

    const fullList = (await health.findSemanticCandidatePairs(d.name, Number.MAX_SAFE_INTEGER)).pairs;
    const full = fullList.find((p) => p.folderA === p.folderB);
    const mixed = fullList.find((p) => p.folderA !== p.folderB);
    ok((await health.candidatePairsTouching(d.name, [`${full.folderA}/${full.slugA}`])).some((p) => keyOf(p) === keyOf(full)), 'CONTROL: before it is dismissed, the pair is there');
    await addDismissal(d.name, 'semanticDupe', { slugA: full.slugA, folderA: full.folderA, slugB: full.slugB, folderB: full.folderB });
    const page1 = `${full.folderA}/${full.slugA}`;
    const after = await health.candidatePairsTouching(d.name, [page1]);
    ok(!after.some((p) => keyOf(p) === keyOf(full)), 'a dismissed pair is not a candidate here either');
    // Whatever the dismissal store does with a pair across folders, the two passes must agree.
    await addDismissal(d.name, 'semanticDupe', { slugA: mixed.slugA, folderA: mixed.folderA, slugB: mixed.slugB, folderB: mixed.folderB });
    const fullNow = (await health.findSemanticCandidatePairs(d.name, Number.MAX_SAFE_INTEGER)).pairs.some((p) => keyOf(p) === keyOf(mixed));
    const hereNow = (await health.candidatePairsTouching(d.name, [`${mixed.folderA}/${mixed.slugA}`])).some((p) => keyOf(p) === keyOf(mixed));
    eq(hereNow, fullNow, 'a pair dismissed across folders: both passes say the same');

    // Over the scan's page limit no comparison can run, so nothing may promise one.
    const huge = mkDomain();
    for (let i = 0; i <= health.SEMANTIC_DUPE_MAX_DOMAIN_PAGES; i++) writeFileSync(path.join(huge.wiki, 'concepts', `h${i}.md`), '');
    eq(await health.candidatePairsTouching(huge.name, ['concepts/h1']), null, 'over the page limit: null');
    eq(await ai.newPagesToCompare(huge.name, ['concepts/h1']), null, 'and no figure for the result');
    rmSync(path.join(DOMAINS_DIR, huge.name), { recursive: true });
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('7. A real ingest');
  {
    const SOURCE = 'Short notes about gamma research.\n'.repeat(40);
    const sourceFile = (name) => {
      const dir = path.join(ROOT, 'src', String(++seq));
      mkdirSync(dir, { recursive: true });
      const p = path.join(dir, name);
      writeFileSync(p, SOURCE);
      return p;
    };
    const reply = (extra = []) => ({
      title: 'Gamma notes',
      pages: [
        { path: 'summaries/gamma-notes.md', content: '# Gamma notes\n\nSource: gamma-notes.md\n\n## Key Takeaways\n- a point\n\n## Concepts Introduced or Referenced\n- [[gamma-research-notes-long-title]]\n' },
        { path: 'concepts/gamma-research-notes-long-title.md', content: '# Gamma research\n\nTags: t\n\n- a fact\n' },
        { path: 'entities/lonely-zebra-quartet.md', content: '# Lonely zebra quartet\n\nTags: t\n\n- a fact\n' },
        ...extra,
      ],
    });
    const fakeIngest = (r) => {
      const fn = async (schema, prompt, maxTokens, format, onWait, opts) => {
        fn.calls++;
        if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 100, outputTokens: 50, provider: 'fake', model: 'fake-1' });
        return JSON.stringify(r);
      };
      fn.calls = 0;
      return fn;
    };

    const d = mkDomain(pagesFrom(['gamma-research-study-other-text', ...OLD]));
    const llm = fakeIngest(reply());
    const { value: res } = await quiet(() => ingestFile(d.name, sourceFile('gamma-notes.md'), 'gamma-notes.md', false, null, { llm }));
    eq(llm.calls, 1, 'no model call beyond the ingest\'s own');
    eq(readRecord(d.name), ['concepts/gamma-research-notes-long-title', 'entities/lonely-zebra-quartet'], 'the record holds the created concept and entity, not the summary');
    eq(res.newPagesToCompare, {
      newPages: 2, comparable: 1,
      pairs: (await health.candidatePairsTouching(d.name, ['concepts/gamma-research-notes-long-title', 'entities/lonely-zebra-quartet'])).length,
    }, 'the result counts the new pages that have a pair');
    eq(res.newPagesToCompare.pairs >= 1, true, 'CONTROL: and a pair exists');
    const firstEst = await ai.estimateSemanticDuplicateScan(d.name, 500);
    eq(firstEst.recentNewPages.pages, 1, 'the scan agrees about which pages have pairs');
    eq(firstEst.recentNewPages.pairs, res.newPagesToCompare.pairs, 'and how many pairs');

    // The same ingest over the same pages creates nothing new.
    const wikiFilesBefore = readdirSync(path.join(d.wiki, 'concepts')).sort();
    const recordBefore = readFileSync(recordFile(d.name), 'utf8');
    const { value: again } = await quiet(() => ingestFile(d.name, sourceFile('gamma-notes.md'), 'gamma-notes.md', true, null, { llm: fakeIngest(reply()) }));
    eq(again.newPagesToCompare, null, 'a re-ingest that created nothing has no figure');
    eq(readFileSync(recordFile(d.name), 'utf8'), recordBefore, 'and leaves the record alone');
    eq(readdirSync(path.join(d.wiki, 'concepts')).sort(), wikiFilesBefore, 'CONTROL: it wrote no new concept');

    // No candidates: pages counted, nothing comparable.
    const lonely = mkDomain();
    const { value: alone } = await quiet(() => ingestFile(lonely.name, sourceFile('gamma-notes.md'), 'gamma-notes.md', false, null, { llm: fakeIngest(reply()) }));
    eq(alone.newPagesToCompare, { newPages: 2, comparable: 0, pairs: 0 }, 'no close names: nothing comparable, no line');

    // Answered already, by a scan: nothing left to ask about.
    const answered = mkDomain(pagesFrom(['gamma-research-study-other-text']));
    await quiet(() => ingestFile(answered.name, sourceFile('gamma-notes.md'), 'gamma-notes.md', false, null, { llm: fakeIngest(reply()) }));
    await scan(answered.name, fakeLLM());
    eq(await ai.newPagesToCompare(answered.name, ['concepts/gamma-research-notes-long-title']), { newPages: 1, comparable: 0, pairs: 0 }, 'a pair already answered is not asked about');

    // The wiki gains only what the pages themselves did: record or no record, the same files.
    const a = mkDomain(pagesFrom(['gamma-research-study-other-text']));
    const b = mkDomain(pagesFrom(['gamma-research-study-other-text']));
    mkdirSync(recordFile(b.name), { recursive: true }); // b's record cannot be written
    await quiet(() => ingestFile(a.name, sourceFile('gamma-notes.md'), 'gamma-notes.md', false, null, { llm: fakeIngest(reply()) }));
    const realErr = process.stderr.write;
    process.stderr.write = () => true;
    let blocked;
    try { ({ value: blocked } = await quiet(() => ingestFile(b.name, sourceFile('gamma-notes.md'), 'gamma-notes.md', false, null, { llm: fakeIngest(reply()) }))); }
    finally { process.stderr.write = realErr; }
    ok(blocked && blocked.pagesWritten.length === 3, 'an unwritable record does not fail the ingest');
    eq(blocked.newPagesToCompare.comparable, 1, 'and the result still counts');
    rmSync(recordFile(b.name), { recursive: true });
    const names = (w) => ['entities', 'concepts', 'summaries'].flatMap((f) => readdirSync(path.join(w, f)).map((n) => f + '/' + n)).sort();
    eq(names(a.wiki), names(b.wiki), 'the record adds no page');
    ok(!treeHas(path.join(DOMAINS_DIR, a.name), 'recent-new'), 'and no record anywhere under the domain');
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('8. The figures reach the screen\'s data');
  {
    const { ingestDoneEvent } = await import(path.join(REPO, 'src/routes/ingest.js'));
    const figure = { newPages: 4, comparable: 2, pairs: 9 };
    eq(ingestDoneEvent({ title: 't', newPagesToCompare: figure }, 'false').newPagesToCompare, figure, 'the done event carries the figure');
    ok(!('newPagesToCompare' in ingestDoneEvent({ title: 't', newPagesToCompare: null }, 'false')), 'nothing to say: the field is absent, the event as it was');

    const activity = await import(path.join(REPO, 'src/brain/ingest-activity.js'));
    activity.__resetActivityForTests();
    const started = activity.startActivity('wire-domain', 'f.md');
    const id = typeof started === 'string' ? started : started.id;
    activity.observeActivity(id, ingestDoneEvent({ title: 't', changes: [], pagesWritten: [], newPagesToCompare: figure }, 'false'));
    const listed = activity.listActivity();
    const records = Array.isArray(listed) ? listed : (listed.records || listed.activity || listed.items || []);
    const mine = records.find((r) => r.domain === 'wire-domain');
    eq(mine && mine.result && mine.result.newPagesToCompare, figure, 'the restored panel\'s record carries it');

    const queue = await import(path.join(REPO, 'src/brain/ingest-queue.js'));
    const wire = queue.toWire({ jobId: 'j', domain: 'd', items: [{ idx: 0, name: 'a.md', status: 'done', result: { title: 't', pagesWritten: 2, warningCount: 0, newPagesToCompare: figure } }] });
    eq(wire.items[0].result.newPagesToCompare, figure, 'a batch\'s wire record carries it');
  }

  // ──────────────────────────────────────────────────────────────────────────
  section('9. The line, executed from the view');
  {
    const js = readFileSync(path.join(REPO, 'src/public/next/views/ingest.js'), 'utf8');
    const start = js.indexOf('function renderNewPagesLine(c) {');
    ok(start >= 0, 'CONTROL: the view has the line\'s builder');
    const end = js.indexOf('\n}\n', start) + 3;
    const line = new Function(js.slice(start, end) + '\nreturn renderNewPagesLine;')();
    const text = (c) => line(c).replace(/<[^>]+>/g, '');
    eq(text({ newPages: 19, comparable: 6 }), '6 of 19 new pages have names close to other pages. Compare them under Wiki health.', 'some of them');
    eq(text({ newPages: 3, comparable: 3 }), '3 new pages have names close to other pages. Compare them under Wiki health.', 'all of them');
    eq(text({ newPages: 1, comparable: 1 }), '1 new page has a name close to other pages. Compare it under Wiki health.', 'one, alone');
    eq(text({ newPages: 4, comparable: 1 }), '1 of 4 new pages has a name close to other pages. Compare it under Wiki health.', 'one of several');
    for (const c of [null, undefined, {}, { newPages: 5, comparable: 0 }, { newPages: 5, comparable: null }]) {
      eq(line(c), '', `no line for ${JSON.stringify(c)}`);
    }
    const html = line({ newPages: 5, comparable: 2 });
    ok(/data-ing-wiki-health/.test(html) && /<button/.test(html), 'Wiki health is a control');
    ok(!/[$?]|cost|paid|price|duplicate/i.test(text({ newPages: 5, comparable: 2 })), 'no question, no cost, and no claim that anything is a duplicate');
    ok((html.match(/<div/g) || []).length === 1, 'one line');
    ok(!/[<>"]/.test(text({ newPages: '<x>', comparable: 2 })), 'a figure that is not a number is never printed');
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

function treeHas(dir, needle) {
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.name.includes(needle)) return true;
    if (f.isDirectory() && treeHas(path.join(dir, f.name), needle)) return true;
  }
  return false;
}

console.log(`\n${passed} passed, ${failed} failed`);
// Open handles from a route's module graph must not hold the suite open.
process.exit(failed ? 1 : 0);
