#!/usr/bin/env node
/**
 * OFFLINE — get_index's two views and its paging (v3.83.0), and Health's
 * app-only `indexDrift` over the MCP.
 *
 * Why this exists: index.md was returned as ONE string. 146 KB on the largest
 * real wiki today and ~614 KB once Health rebuilds it — a reply a harness
 * moves into a file (Claude Code, above ~25k tokens) and that the dispatcher
 * TRUNCATES mid-row above 400 KB. And index.md lags the files: a model that
 * grounds [[links]] in it misses pages that exist.
 *
 *  §1  a small index requested with no arguments is BYTE-IDENTICAL to the
 *      file (the pre-v3.83.0 reply); view:"index" alone is too.
 *  §2  a large legacy index and a large SECTIONED index: every page's whole
 *      serialised reply ≤ INDEX_PAGE_BYTES (61,440 B, the literal — not the
 *      export); every row on exactly one page, in document order (dumb
 *      cross-check: a regex over the FILE, not the parser); each page valid
 *      markdown (a row run is preceded by its header + separator, and by its
 *      `## ` heading when sectioned); the continuation chain; the refusals.
 *  §3  type filter by CANONICAL PATH on a collision fixture; index_health.
 *  §4  view:"pages" is complete from the files — both sides of every
 *      cross-folder collision, unlinkable names, with an EMPTY or ABSENT
 *      index.md; absent frontmatter fields omitted; order; paging.
 *  §5  scan_wiki_health reports indexDrift as app-only (stubbed scan — the
 *      producer lands in a parallel package); absent field ⇒ nothing reported;
 *      fix_wiki_issue refuses it with reason 'app-only' and writes NOTHING.
 *  §6  determinism, basis, read-only on a mirror, graph cache invalidation.
 *
 * SAFETY — synthetic fixtures in a mkdtemp dir; CURATOR_TEST_DOMAINS_DIR and
 * CURATOR_TEST_USER_DATA_DIR are set BEFORE any import. Never touches domains/.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-get-index-paging-'));
const DOMAINS = path.join(TMP, 'domains');
const USER_DATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'DOMAINS_PATH', 'LLM_MODEL']) delete process.env[k];
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

const { getIndexHandler, getIndexDefinition, INDEX_PAGE_BYTES, MAX_GROUNDING_SLUGS } = await import('../mcp/tools/index-tool.js');
const H = await import('../mcp/tools/health.js');
const { DISMISSIBLE_TYPE_VALUES } = await import('../mcp/tools/dismissed.js').catch(() => ({}));
const { createStorageAdapter } = await import('../mcp/storage/local.js');
const { invalidateGraph } = await import('../mcp/graph.js');
const WI = await import('../src/brain/wiki-index.js');

let passed = 0, failed = 0;
const failures = [];
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 400)}` : ''}`); failures.push(label); }
};
const section = (t) => console.log(`\n── ${t} ──`);

// The bound, as a LITERAL: a mutation of the export must not move the yardstick.
const BOUND = 61_440;
const bytes = (r) => Buffer.byteLength(typeof r === 'string' ? r : JSON.stringify(r, null, 2), 'utf8');
const ROW_RE = /^\| \[\[/;

// ── fixtures ────────────────────────────────────────────────────────────────
function mkDomain(name, { readonly = false } = {}) {
  const root = path.join(DOMAINS, name);
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(root, 'wiki', f), { recursive: true });
  writeFileSync(path.join(root, 'CLAUDE.md'),
    readonly ? `---\nreadonly: true\n---\n\n# Domain: ${name}\n` : `# Domain: ${name}\n`);
  return root;
}
const put = (dom, rel, text) => writeFileSync(path.join(DOMAINS, dom, 'wiki', rel), text);
const pageBody = (title, fm = {}) => {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return (lines.length ? `---\n${lines.join('\n')}\n---\n` : '') + `# ${title}\n\nA page about ${title}. It has a body.\n`;
};
const desc = (i) => `Description number ${i} — a reasonably long one-line summary of the page so rows weigh like real ones.`;

// small: a few pages, a ~1 KB index
mkDomain('small');
put('small', 'entities/alpha.md', pageBody('Alpha', { type: 'entity', created: '2026-01-01' }));
put('small', 'concepts/beta.md', pageBody('Beta', { type: 'concept' }));
const SMALL_INDEX = '# Wiki Index — Small\nLast updated: 2026-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n' +
  '| [[alpha]] | entity | The alpha page. |\n| [[beta]] | concept | The beta page. |\n| [[gone]] | concept | Deleted. |\n';
put('small', 'index.md', SMALL_INDEX);

// big: legacy single table, 1,600 rows (~230 KB), 40 stale rows, files for most rows
mkDomain('big');
const BIG_N = 1600;
let bigIndex = '# Wiki Index — Big\nLast updated: 2026-05-04\n\n| Page | Type | Summary |\n|---|---|---|\n';
for (let i = 0; i < BIG_N; i++) {
  const slug = `concept-${String(i).padStart(4, '0')}`;
  if (i % 40 !== 7) put('big', `concepts/${slug}.md`, pageBody(`Concept ${i}`, { type: 'concept' }));
  bigIndex += `| [[${slug}]] | concept | ${desc(i)} |\n`;
}
for (let i = 0; i < 30; i++) put('big', `summaries/src-${i}.md`, pageBody(`Source ${i}`, { type: 'summary', date: '2026-02-02', created: '2026-02-02', source: `src ${i}.pdf` }));
for (let i = 0; i < 10; i++) bigIndex += `| [[summaries/src-${i}]] | summary | Source ${i} summary. |\n`;
put('big', 'index.md', bigIndex);

// sect: a SECTIONED (rebuilt-format) index, composed by the real rebuild helper
mkDomain('sect');
for (let i = 0; i < 80; i++) put('sect', `summaries/s-${i}.md`, pageBody(`Summary ${i}`, { type: 'summary', created: '2026-03-03' }));
for (let i = 0; i < 400; i++) put('sect', `entities/e-${i}.md`, pageBody(`Entity ${i}`, { type: 'entity' }));
for (let i = 0; i < 1200; i++) put('sect', `concepts/c-${i}.md`, pageBody(`Concept ${i}`, { type: 'concept' }));
{
  const inv = WI.buildInventory({
    entities: readdirSync(path.join(DOMAINS, 'sect/wiki/entities')),
    concepts: readdirSync(path.join(DOMAINS, 'sect/wiki/concepts')),
    summaries: readdirSync(path.join(DOMAINS, 'sect/wiki/summaries')),
  });
  const derived = new Map(inv.paths.map((p, i) => [p, desc(i)]));
  const { text } = WI.rebuildIndexText('# Wiki Index — Sect\nLast updated: 2026-01-01\n', inv, derived, { today: '2026-10-26' });
  put('sect', 'index.md', text);
}

// coll: cross-folder collisions, unlinkable names, missing pages, stale rows
mkDomain('coll');
for (const s of ['x', 'y', 'z']) {
  put('coll', `concepts/${s}.md`, pageBody(`Concept ${s}`));
  put('coll', `summaries/${s}.md`, pageBody(`Summary ${s}`, { type: 'summary', created: '2026-04-04', date: '2026-04-05', source: `${s}.pdf` }));
}
put('coll', 'entities/w.md', pageBody('Entity w'));
put('coll', 'concepts/w.md', pageBody('Concept w'));               // unaddressable twin of entities/w
put('coll', 'concepts/ leading-space.md', pageBody('Leading'));    // unlinkable
put('coll', 'entities/only-on-disk.md', '---\ntitle: "Front Title"\n---\nno heading here\n');
put('coll', 'entities/no-heading.md', 'just text, no frontmatter, no H1\n');
const COLL_INDEX = '# Wiki Index — Coll\nLast updated: 2026-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n' +
  '| [[x]] | concept | Concept x. |\n| [[summaries/x]] | summary | Summary x. |\n| [[y]] | concept | Concept y. |\n' +
  '| [[stale-one]] | concept | Gone. |\n| [[summaries/stale-two]] | summary | Gone too. |\n';
put('coll', 'index.md', COLL_INDEX);

// empty-index / no-index domains with pages on disk
mkDomain('emptyidx');
put('emptyidx', 'index.md', '');
put('emptyidx', 'entities/a.md', pageBody('A'));
put('emptyidx', 'summaries/a.md', pageBody('A summary', { type: 'summary' }));
mkDomain('noidx');
put('noidx', 'concepts/q.md', pageBody('Q'));

// ground: the slugs grounding call (§7)
mkDomain('ground');
put('ground', 'entities/openai.md', pageBody('OpenAI'));
put('ground', 'concepts/agent.md', pageBody('Agent'));
put('ground', 'concepts/policy.md', pageBody('Policy'));
put('ground', 'concepts/box.md', pageBody('Box'));
put('ground', 'concepts/rag.md', pageBody('RAG concept'));
put('ground', 'summaries/rag.md', pageBody('RAG summary', { type: 'summary', created: '2026-06-06' }));
put('ground', 'concepts/context-engineering.md', pageBody('Context engineering'));
put('ground', 'index.md', '# Wiki Index — Ground\n\n| Page | Type | Summary |\n|---|---|---|\n');

// a read-only Shared Brain mirror
mkDomain('shared-mirror', { readonly: true });
put('shared-mirror', 'entities/m.md', pageBody('Mirror page'));
put('shared-mirror', 'index.md', '# Wiki Index — (Shared Brain Mirror)\n\n| Page | Type | Summary |\n|---|---|---|\n');

const storage = createStorageAdapter({ domainsPath: DOMAINS });
const call = (args) => getIndexHandler(args, storage);

/** Walk every page; returns { replies } or { error }. */
async function walk(args) {
  const first = await call(args);
  if (typeof first === 'string' || !first.ok) return { first, replies: [first] };
  const replies = [first];
  for (let p = 2; p <= first.of; p++) replies.push(await call({ ...args, page: p }));
  return { first, replies };
}

/** Every row run in a page's markdown is preceded by header + separator (and a heading if sectioned). */
function pageIsValidMarkdown(content, sectioned) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!ROW_RE.test(lines[i])) continue;
    if (i > 0 && ROW_RE.test(lines[i - 1])) continue;     // inside a run
    // start of a run: the two lines before must be header + separator
    if (i < 2 || !/^\|\s*Page\s*\|/.test(lines[i - 2]) || !/^\|[\s|:-]*-/.test(lines[i - 1])) return `row run at line ${i} lacks a table header`;
    if (sectioned) {
      let h = i - 3;
      while (h >= 0 && lines[h].trim() === '') h--;
      if (h < 0 || !/^## /.test(lines[h])) return `row run at line ${i} lacks its ## heading`;
    }
  }
  return null;
}

try {
  // ── §1 ───────────────────────────────────────────────────────────────────
  section('§1  SMALL INDEX, NO ARGUMENTS — byte-identical to the file');
  {
    const onDisk = readFileSync(path.join(DOMAINS, 'small/wiki/index.md'), 'utf8');
    const r = await call({ domain: 'small' });
    ok(typeof r === 'string', 'the reply is a plain string, as before v3.83.0', typeof r);
    ok(r === onDisk, 'and it is the file, byte for byte (dumb cross-check: readFileSync)');
    ok(r === SMALL_INDEX, 'and equal to the fixture text the suite wrote');
    const r2 = await call({ domain: 'small', view: 'index' });
    ok(r2 === onDisk, 'view:"index" with no type/page is the same raw string');
    const r3 = await call({ domain: 'small', page: 1 });
    ok(r3 && r3.ok === true && r3.of === 1 && r3.content.includes('[[alpha]]'),
      'asking for page 1 explicitly gets the structured shape (one page)');
    ok(r3.index_health && r3.index_health.stale_rows === 1, 'with index_health: the stale [[gone]] row counted', JSON.stringify(r3.index_health));
    ok(await call({ domain: '../etc' }) === 'Invalid domain name "../etc". Use list_domains.', 'a bad domain keeps the old string reply');
    ok(await call({ domain: 'noidx' }) === 'No index found for domain "noidx". Try list_domains first.', 'a missing index keeps the old string reply');
  }

  // ── §2 ───────────────────────────────────────────────────────────────────
  section('§2  LARGE INDEXES ARE PAGED — bound, completeness, order, valid markdown');
  ok(INDEX_PAGE_BYTES === BOUND, `INDEX_PAGE_BYTES is 60 KB (${INDEX_PAGE_BYTES})`);
  for (const [dom, sectioned] of [['big', false], ['sect', true]]) {
    const file = readFileSync(path.join(DOMAINS, dom, 'wiki/index.md'), 'utf8');
    ok(Buffer.byteLength(file) > 3 * BOUND, `${dom}: the fixture index is large (${Buffer.byteLength(file)} B)`);
    const { first, replies } = await walk({ domain: dom });
    ok(first && first.ok === true && first.view === 'index', `${dom}: no-arg call on a large index returns the structured shape`);
    ok(first.of >= 4 && replies.length === first.of, `${dom}: it arrives in ${first.of} pages`);
    const sizes = replies.map(bytes);
    ok(sizes.every((s) => s <= BOUND), `${dom}: EVERY page's serialised reply ≤ 61,440 B (max ${Math.max(...sizes)})`, sizes.join(','));
    ok(sizes.slice(0, -1).every((s) => s > BOUND * 0.8), `${dom}: and pages are FULL, not over-split (every non-last page > 80% of the bound)`, sizes.join(','));
    // dumb cross-check: row lines of the FILE by regex, vs. row lines of the pages
    const fileRows = file.split('\n').filter((l) => ROW_RE.test(l));
    const pageRows = replies.flatMap((r) => r.content.split('\n').filter((l) => ROW_RE.test(l)));
    ok(pageRows.length === fileRows.length, `${dom}: ${pageRows.length} rows across pages === ${fileRows.length} in the file`);
    ok(pageRows.every((l, i) => l === fileRows[i]), `${dom}: every row exactly once, in document order, verbatim`);
    ok(replies.reduce((n, r) => n + r.rows_on_page, 0) === first.rows_total && first.rows_total === fileRows.length,
      `${dom}: rows_on_page sums to rows_total`);
    const bad = replies.map((r) => pageIsValidMarkdown(r.content, sectioned)).find(Boolean);
    ok(!bad, `${dom}: each page is valid markdown on its own — a row run is preceded by its table header${sectioned ? ' and ## heading' : ''}`, bad);
    ok(replies[0].content.startsWith(file.split('\n')[0] + '\n'), `${dom}: page 1 opens with the index's title line`);
    ok(replies.every((r) => r.content.split('\n').filter((l) => /^# /.test(l)).length === (r.page === 1 ? 1 : 0)),
      `${dom}: the title appears on page 1 only`);
    ok(replies.slice(0, -1).every((r, i) => r.continuation && r.continuation.page === i + 2 && r.continuation.of === first.of && r.continuation.remaining === first.of - i - 1),
      `${dom}: every page but the last names the next in continuation`);
    ok(!('continuation' in replies[replies.length - 1]), `${dom}: the last page has no continuation`);
    ok(/PAGED/.test(first.report) && /page: 2/.test(first.report), `${dom}: page 1's report says PAGED and names page: 2`);
    ok(/LAST page/.test(replies[replies.length - 1].report), `${dom}: the last page's report says LAST page`);
    ok(new Set(replies.map((r) => r.basis)).size === 1 && /^[0-9a-f]{12}$/.test(first.basis), `${dom}: one 12-hex basis across all pages`);
    if (sectioned) {
      const heads = replies.flatMap((r) => r.content.split('\n').filter((l) => /^## /.test(l)));
      ok(['## Summaries', '## Entities', '## Concepts'].every((h) => heads.includes(h)), `${dom}: all three section headings are carried`);
    }
    const oor = await call({ domain: dom, page: first.of + 1 });
    ok(oor.ok === false && oor.reason === 'page-out-of-range' && oor.pages === first.of, `${dom}: page of+1 → page-out-of-range with pages: ${first.of}`, JSON.stringify(oor));
  }
  for (const bad of [0, -1, 1.5, '2a', 'two', true]) {
    const r = await call({ domain: 'big', page: bad });
    ok(r.ok === false && r.reason === 'invalid-argument' && /whole number/.test(r.error), `page: ${JSON.stringify(bad)} is refused`, JSON.stringify(r));
  }
  {
    const a = await call({ domain: 'big', page: 2 });
    const b = await call({ domain: 'big', page: '2' });
    ok(JSON.stringify(a) === JSON.stringify(b), 'page: "2" (a digit string) is accepted as 2');
  }
  for (const [k, v] of [['view', 'graph'], ['type', 'entities'], ['type', 'summaries']]) {
    const r = await call({ domain: 'big', [k]: v });
    ok(r.ok === false && r.reason === 'invalid-argument', `${k}: ${JSON.stringify(v)} is refused (not in the enum)`, JSON.stringify(r));
  }

  // ── §3 ───────────────────────────────────────────────────────────────────
  section('§3  TYPE FILTER BY CANONICAL PATH, and index_health');
  {
    const s = await call({ domain: 'coll', type: 'summary' });
    const rows = s.content.split('\n').filter((l) => ROW_RE.test(l));
    ok(s.ok && rows.length === 1 && rows[0].startsWith('| [[summaries/x]]'), 'type:"summary" returns [[summaries/x]] only', rows.join(' / '));
    ok(!rows.some((l) => l.startsWith('| [[x]]')), 'and NOT the concept [[x]] that shares its slug');
    const c = await call({ domain: 'coll', type: 'concept' });
    const crows = c.content.split('\n').filter((l) => ROW_RE.test(l));
    ok(crows.length === 2 && crows[0].startsWith('| [[x]]') && crows[1].startsWith('| [[y]]'), 'type:"concept" returns [[x]] and [[y]]', crows.join(' / '));
    ok(!crows.concat(rows).some((l) => /stale-/.test(l)), 'stale rows never appear in a filtered view');
    const all = await call({ domain: 'coll', page: 1 });
    ok(all.content.includes('[[stale-one]]') && all.content.includes('[[summaries/stale-two]]'), 'stale rows DO appear unfiltered (the index as it is)');
    // index_health vs. an independent count: files on disk that are addressable, minus covered rows
    const inv = WI.buildInventory({
      entities: readdirSync(path.join(DOMAINS, 'coll/wiki/entities')),
      concepts: readdirSync(path.join(DOMAINS, 'coll/wiki/concepts')),
      summaries: readdirSync(path.join(DOMAINS, 'coll/wiki/summaries')),
    });
    // dumb: addressable = all .md minus unlinkable minus unaddressable; covered = x, summaries/x, y
    const addressable = inv.all.length - inv.unlinkable.length - inv.unaddressable.length;
    ok(all.index_health && all.index_health.missing_from_index === addressable - 3 && all.index_health.stale_rows === 2,
      `index_health: missing ${addressable - 3}, stale 2`, JSON.stringify(all.index_health));
    ok(/view: "pages"/.test(all.report), 'the report points at view: "pages" when the index lags');
    const sm = await call({ domain: 'sect', type: 'summary' });
    ok(sm.of === 1 && sm.rows_total === 80 && !sm.index_health, 'sect type:"summary": 80 rows, one page, no index_health on a complete index');
  }

  // ── §4 ───────────────────────────────────────────────────────────────────
  section('§4  view:"pages" — complete from the files, collision-safe');
  for (const dom of ['coll', 'emptyidx', 'noidx', 'big', 'sect']) {
    const { first, replies } = await walk({ domain: dom, view: 'pages' });
    const list = replies.flatMap((r) => r.pages);
    // dumb cross-check: readdir of the three folders
    const onDisk = ['summaries', 'entities', 'concepts'].flatMap((f) =>
      readdirSync(path.join(DOMAINS, dom, 'wiki', f)).filter((n) => n.endsWith('.md')).map((n) => `${f}/${n}`));
    const folderOf = { summary: 'summaries', entity: 'entities', concept: 'concepts' };
    const got = list.map((p) => `${folderOf[p.type]}/${p.slug}.md`);
    ok(first.ok && list.length === onDisk.length && first.pages_total === onDisk.length,
      `${dom}: ${list.length} pages listed === ${onDisk.length} files on disk`);
    ok(new Set(got).size === got.length && onDisk.every((p) => got.includes(p)), `${dom}: each file exactly once`);
    ok(replies.every((r) => bytes(r) <= BOUND), `${dom}: every page ≤ 61,440 B (${replies.length} page${replies.length === 1 ? '' : 's'})`);
    ok(list.every((p) => Object.values(p).every((v) => v !== null && v !== undefined)), `${dom}: no null fields (absent ones are omitted)`);
  }
  {
    const r = await call({ domain: 'coll', view: 'pages' });
    const keys = r.pages.map((p) => `${p.type}:${p.slug}`);
    for (const s of ['x', 'y', 'z']) ok(keys.includes(`concept:${s}`) && keys.includes(`summary:${s}`), `collision ${s}: BOTH concepts/${s} and summaries/${s} are listed`);
    ok(keys.includes('entity:w') && keys.includes('concept:w'), 'entity/concept twin w: both listed');
    ok(keys.includes('concept: leading-space'), 'an unlinkable leading-space filename is listed, slug verbatim');
    const order = r.pages.map((p) => p.type);
    const firstIdx = (t) => order.indexOf(t), lastIdx = (t) => order.lastIndexOf(t);
    ok(lastIdx('summary') < firstIdx('entity') && lastIdx('entity') < firstIdx('concept'), 'order: Summaries, Entities, Concepts');
    const byKey = Object.fromEntries(r.pages.map((p) => [`${p.type}:${p.slug}`, p]));
    ok(JSON.stringify(byKey['summary:x']) === JSON.stringify({ slug: 'x', type: 'summary', title: 'Summary x', created: '2026-04-04', date: '2026-04-05', source: 'x.pdf' }),
      'a summary carries slug, type, title, created, date, source', JSON.stringify(byKey['summary:x']));
    ok(JSON.stringify(byKey['concept:x']) === JSON.stringify({ slug: 'x', type: 'concept', title: 'Concept x' }), 'a page without frontmatter dates OMITS them', JSON.stringify(byKey['concept:x']));
    ok(byKey['entity:only-on-disk'].title === 'Front Title', 'title: frontmatter title wins');
    ok(byKey['entity:no-heading'].title === 'no-heading', 'title: falls back to the slug with no H1');
    ok(/INGESTED|ingested/.test(r.note) && /not when it was written/.test(r.note), 'the note says created/date are ingest dates');
    const s = await call({ domain: 'coll', view: 'pages', type: 'summary' });
    ok(s.pages.length === 3 && s.pages.every((p) => p.type === 'summary'), 'type:"summary" lists the three summaries only');
    const big = await call({ domain: 'sect', view: 'pages', type: 'summary' });
    ok(big.of === 1 && big.pages.length === 80 && bytes(big) <= BOUND, `sect: all 80 summaries in ONE reply (${bytes(big)} B)`);
    const unk = await call({ domain: 'nope', view: 'pages' });
    ok(unk.ok === false && unk.reason === 'unknown-domain', 'an unknown domain is refused on view:"pages"');
    const oor = await call({ domain: 'coll', view: 'pages', page: 2 });
    ok(oor.ok === false && oor.reason === 'page-out-of-range', 'view:"pages" page out of range is refused');
  }

  // ── §5 ───────────────────────────────────────────────────────────────────
  section('§5  HEALTH — indexDrift is reported, app-only, and never fixed over MCP');
  {
    const clean = { domain: 'coll', scannedAt: 'now', counts: { dismissed: 0 },
      brokenLinks: [], orphans: [], folderPrefixLinks: [], crossFolderDupes: [], hyphenVariants: [], missingBacklinks: [] };
    const DRIFT = { missing: 2705, missingByFolder: { entities: 440, concepts: 2224, summaries: 41 }, stale: 39,
      duplicates: 0, repointable: 3, indexExists: true, indexBytes: 145844, sampleMissing: ['summaries/foo.md'], sampleStale: ['[[blockchain]]'] };
    H.__setScanWikiForTest(async () => ({ ...clean, brokenLinks: [{ sourceFile: 'a.md', linkText: 'b', suggestedTarget: 'c' }], orphans: [{ slug: 'o' }], indexDrift: [DRIFT] }));
    const r = await H.scanWikiHealthHandler({ domain: 'coll' }, storage);
    ok(Array.isArray(r.indexDrift) && r.indexDrift.length === 1 && r.indexDrift[0].missing === 2705, 'scan_wiki_health returns indexDrift at the top level');
    ok(r.counts.total_issues === 3 && r.counts.auto_fixable === 1 && r.counts.app_only === 1 && r.counts.review_only === 1,
      'total 3 = 1 auto-fixable + 1 review-only + 1 app-only', JSON.stringify(r.counts));
    ok(/missing 2705 pages and has 39 rows/.test(r.report) && /Rebuild index/.test(r.report) && /cannot be fixed over MCP/.test(r.report) && /view: "pages"/.test(r.report),
      'the report names the numbers, the app action, and view: "pages"', r.report);
    H.__setScanWikiForTest(async () => ({ ...clean, indexDrift: [{ ...DRIFT, missing: 0, stale: 2 }] }));
    const r2 = await H.scanWikiHealthHandler({ domain: 'coll' }, storage);
    ok(/has 2 rows for pages that no longer exist/.test(r2.report) && !/missing 0/.test(r2.report), 'stale-only drift reads naturally', r2.report);
    // absent field ⇒ nothing reported (the producer may not be merged yet)
    H.__setScanWikiForTest(async () => ({ ...clean }));
    const r3 = await H.scanWikiHealthHandler({ domain: 'coll' }, storage);
    ok(Array.isArray(r3.indexDrift) && r3.indexDrift.length === 0 && r3.counts.app_only === 0 && r3.counts.total_issues === 0,
      'a scan WITHOUT indexDrift reports none (defensive read)', JSON.stringify(r3.counts));
    ok(/is clean/.test(r3.report) && !/index\.md/.test(r3.report), 'and the clean report is unchanged');
    H.__setScanWikiForTest(null);
    // the real scan — passes through whatever the producer returns
    const real = await H.scanWikiHealthHandler({ domain: 'coll' }, storage);
    ok(real.ok === true && Array.isArray(real.indexDrift), `the real scan answers (indexDrift ${real.indexDrift.length ? 'present' : 'absent in this build'})`);

    ok(!H.fixWikiIssueDefinition.inputSchema.properties.type.enum.includes('indexDrift'), 'fix_wiki_issue enum does not offer indexDrift');
    if (Array.isArray(DISMISSIBLE_TYPE_VALUES)) ok(!DISMISSIBLE_TYPE_VALUES.includes('indexDrift'), 'and it is not dismissible');
    const fp = (dom) => {
      const h = createHash('sha256');
      const rec = (d) => { for (const n of readdirSync(d).sort()) { const p = path.join(d, n); if (statSync(p).isDirectory()) rec(p); else h.update(p + '\0' + readFileSync(p)); } };
      rec(path.join(DOMAINS, dom)); return h.digest('hex');
    };
    const before = fp('coll');
    const f = await H.fixWikiIssueHandler({ domain: 'coll', type: 'indexDrift', issue: DRIFT }, storage);
    ok(f.ok === false && f.reason === 'app-only' && /Rebuild index/.test(f.error) && /^REFUSED — nothing was written/.test(f.report),
      "fix_wiki_issue {type:'indexDrift'} → reason 'app-only'", JSON.stringify(f));
    ok(fp('coll') === before, 'and the whole domain is byte-identical afterwards (index.md included)');
    const m = await H.fixWikiIssueHandler({ domain: 'shared-mirror', type: 'indexDrift', issue: DRIFT }, storage);
    ok(m.ok === false && /read-only Shared Brain mirror/.test(m.error), 'on a mirror the read-only refusal still comes first');
    ok(/indexDrift/.test(H.scanWikiHealthDefinition.description) && /never try to fix it/.test(H.scanWikiHealthDefinition.description),
      "scan_wiki_health's description says indexDrift is report-only");
  }

  // ── §6 ───────────────────────────────────────────────────────────────────
  section('§6  DETERMINISM, BASIS, MIRRORS, CACHE');
  {
    const a = await call({ domain: 'big', page: 3 });
    const b = await call({ domain: 'big', page: 3 });
    ok(JSON.stringify(a) === JSON.stringify(b), 'the same page twice is identical');
    const before = a.basis;
    put('big', 'index.md', bigIndex + '| [[summaries/src-11]] | summary | One more. |\n');
    const c = await call({ domain: 'big', page: 1 });
    ok(c.basis !== before, 'a rewritten index.md changes basis');
    put('big', 'index.md', bigIndex);
    const mi = await call({ domain: 'shared-mirror' });
    ok(typeof mi === 'string' && mi.includes('Shared Brain Mirror'), 'a mirror index is readable');
    const mp = await call({ domain: 'shared-mirror', view: 'pages' });
    ok(mp.ok && mp.pages.length === 1 && mp.pages[0].slug === 'm', 'a mirror page list is readable');
    // cache: a new file is seen after invalidation (and by the count check)
    put('coll', 'entities/new-one.md', pageBody('New one'));
    const n1 = await call({ domain: 'coll', view: 'pages' });
    ok(n1.pages.some((p) => p.slug === 'new-one'), 'a new file is listed (count-based cache invalidation)');
    put('coll', 'entities/new-one.md', pageBody('Renamed title'));
    invalidateGraph('coll');
    const n2 = await call({ domain: 'coll', view: 'pages' });
    ok(n2.pages.find((p) => p.slug === 'new-one').title === 'Renamed title', 'an edited title is seen after invalidateGraph');
    ok(getIndexDefinition.inputSchema.required.length === 1 && getIndexDefinition.inputSchema.required[0] === 'domain', 'only domain is required');
    ok(/INGESTED/.test(getIndexDefinition.description) && /continuation/.test(getIndexDefinition.description) && /view: "pages"/.test(getIndexDefinition.description),
      'the description names ingest dates, continuation and view: "pages"');
    ok(!/<[a-z_-]+>/i.test(getIndexDefinition.description), 'no <placeholder> in the description');
  }
  // ── §7 ───────────────────────────────────────────────────────────────────
  section('§7  GROUNDING — view:"pages" with slugs: exact matches, not_found, near');
  {
    const g = await call({ domain: 'ground', view: 'pages', slugs: ['openai', 'rag', 'context-engineering'] });
    ok(g.ok && g.of === 1 && Array.isArray(g.not_found) && g.not_found.length === 0, 'three existing slugs: all found, not_found is []', JSON.stringify(g.not_found));
    const keys = g.pages.map((p) => `${p.type}:${p.slug}`);
    ok(JSON.stringify(keys) === JSON.stringify(['entity:openai', 'summary:rag', 'concept:rag', 'concept:context-engineering']),
      'exact matches in the caller\'s order — BOTH sides of the rag collision', keys.join(', '));
    ok(!keys.includes('concept:agent'), 'and nothing that was not asked for');
    const n = await call({ domain: 'ground', view: 'pages', slugs: ['open-ai', 'OpenAI', 'Open_AI', 'agents', 'policies', 'boxes', 'quantum-foam'] });
    const nf = Object.fromEntries(n.not_found.map((x) => [x.slug, x.near.map((e) => e.slug)]));
    ok(n.pages.length === 0 && n.not_found.length === 7, 'seven variants: none exact, all seven not_found', JSON.stringify(n.not_found));
    ok(JSON.stringify(nf['open-ai']) === '["openai"]', 'hyphen rule: open-ai → near openai', JSON.stringify(nf['open-ai']));
    ok(JSON.stringify(nf.OpenAI) === '["openai"]', 'case rule: OpenAI → near openai (exact match is case-sensitive)');
    ok(JSON.stringify(nf.Open_AI) === '["openai"]', 'separator rule: Open_AI → near openai');
    ok(JSON.stringify(nf.agents) === '["agent"]', 'plural -s rule: agents → near agent');
    ok(JSON.stringify(nf.policies) === '["policy"]', 'plural -ies rule: policies → near policy');
    ok(JSON.stringify(nf.boxes) === '["box"]', 'plural -es rule: boxes → near box');
    ok(JSON.stringify(nf['quantum-foam']) === '[]', 'an unrelated slug has no near variants');
    ok(/0 of 7/.test(n.report) && /additional_pages/.test(n.report), 'the report says how many exist and what to do with the rest', n.report);
    const t = await call({ domain: 'ground', view: 'pages', type: 'concept', slugs: ['rag', 'openai'] });
    ok(t.pages.length === 1 && t.pages[0].type === 'concept' && t.not_found.length === 1 && t.not_found[0].slug === 'openai',
      'combinable with type: rag → the concept side only; openai (an entity) is not_found under type:"concept"', JSON.stringify(t));
    const d = await call({ domain: 'ground', view: 'pages', slugs: ['agent', 'agent'] });
    ok(d.pages.length === 1 && d.slugs_checked === 1, 'duplicate candidates are checked once');
    for (const [label, slugs] of [['empty list', []], ['a string', 'openai'], ['a folder prefix', ['summaries/rag']],
      ['a path', ['../x']], ['whitespace', ['open ai']], ['a non-string', [42]], [`${MAX_GROUNDING_SLUGS + 1} items`, Array.from({ length: 201 }, (_, i) => `s-${i}`)]]) {
      const r = await call({ domain: 'ground', view: 'pages', slugs });
      ok(r.ok === false && r.reason === 'invalid-argument', `slugs as ${label} is refused`, JSON.stringify(r).slice(0, 200));
    }
    ok(MAX_GROUNDING_SLUGS === 200, 'the cap is 200');
    const r200 = await call({ domain: 'ground', view: 'pages', slugs: Array.from({ length: 200 }, (_, i) => `s-${i}`) });
    ok(r200.ok === true && r200.not_found.length === 200, 'exactly 200 slugs is accepted');
    const idx = await call({ domain: 'ground', slugs: ['openai'] });
    ok(idx.ok === false && idx.reason === 'invalid-argument', 'slugs with view:"index" is refused');
    // bound: 200 found slugs on a large domain, each with a full entry
    const many = Array.from({ length: 200 }, (_, i) => `c-${i}`);
    const { first, replies } = await walk({ domain: 'sect', view: 'pages', slugs: many });
    ok(first.ok && replies.every((x) => bytes(x) <= BOUND), `200 found slugs: every reply ≤ 61,440 B (${replies.map(bytes).join(', ')})`);
    ok(replies.flatMap((x) => x.pages).length === 200 && first.not_found.length === 0, 'and all 200 come back');
    ok(/slugs:/.test(getIndexDefinition.description) && /near/.test(getIndexDefinition.description), 'the description names slugs and near');
  }
} catch (err) {
  failed++;
  failures.push(`threw: ${err?.stack || err}`);
  console.log(`  ✗ threw: ${err?.stack || err}`);
}

console.log('\n────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
