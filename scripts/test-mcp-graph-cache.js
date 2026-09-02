#!/usr/bin/env node
/**
 * test-mcp-graph-cache.js
 *
 * Three guards over the MCP read/write seam, all driven through the REAL
 * handlers against an isolated temp domain. No network, no LLM, no API key.
 *
 * §1–§3  mcp/graph.js cache invalidation.
 *        The cache's file-count invalidation was UNREACHABLE: the TTL early
 *        return fired first and never called listWikiFiles, so for the whole
 *        10-minute window — the life of a Claude Desktop conversation — the
 *        graph was frozen while compile_to_wiki and fix_wiki_issue changed
 *        the wiki underneath it. The headline assertion is therefore
 *        BEHAVIOURAL and crosses the seam: write with the real compile
 *        handler, then read with the real get_node / search_wiki handlers,
 *        in one process, and require the new page to be visible.
 *
 * §4      mcp/storage/local.js path guard, which was lexical-only: a symlink
 *        inside the domains folder pointing outside it passed every check.
 *
 * §5      the >10-pages refusal must name the recovery path, because the
 *        obvious one (same title, two calls) silently writes two summaries.
 *
 * ISOLATION: CURATOR_TEST_DOMAINS_DIR (the MCP adapter's rung 1) plus
 * __setDomainsDirOverride() (the app-side resolver the write path uses) both
 * point at one mkdtemp. The real .curator-config.json is fingerprinted at both
 * ends and asserted unchanged. Nothing here touches the developer's domains/.
 */

import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { createHash as hash } from 'crypto';
import os from 'os';
import path from 'path';

let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

// ── Isolation must be installed BEFORE anything under src/brain is imported,
//    because config.js reads the env seam per call but paths are resolved from
//    the first write onward.
const ROOT = await mkdtemp(path.join(os.tmpdir(), 'curator-graphcache-'));
process.env.CURATOR_TEST_DOMAINS_DIR = ROOT;
process.env.CURATOR_TEST_USER_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), 'curator-graphcache-ud-'));

const { createStorageAdapter } = await import('../mcp/storage/local.js');
const { buildGraph, invalidateGraph, __cachedDomains } = await import('../mcp/graph.js');
const { compileToWikiHandler } = await import('../mcp/tools/compile.js');
const { fixWikiIssueHandler } = await import('../mcp/tools/health.js');
const { getNodeHandler } = await import('../mcp/tools/nodes.js');
const { searchWikiHandler } = await import('../mcp/tools/search.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');

__setDomainsDirOverride(ROOT);

// Fingerprint the real credential files: this suite must never touch them.
const HOME = os.homedir();
const REAL_FILES = [
  path.join(process.cwd(), '.curator-config.json'),
  path.join(process.cwd(), '.sync-config.json'),
];
const fingerprint = () => REAL_FILES.map(f => {
  if (!existsSync(f)) return `${path.basename(f)}:absent`;
  const b = readFileSync(f);
  return `${path.basename(f)}:${b.length}:${hash('sha256').update(b).digest('hex').slice(0, 16)}`;
}).join('|');
const FP_BEFORE = fingerprint();

const DOMAIN = 'zztest-graphcache';
const domDir = path.join(ROOT, DOMAIN);

async function seed() {
  await mkdir(path.join(domDir, 'wiki', 'entities'), { recursive: true });
  await mkdir(path.join(domDir, 'wiki', 'concepts'), { recursive: true });
  await mkdir(path.join(domDir, 'wiki', 'summaries'), { recursive: true });
  await writeFile(path.join(domDir, 'CLAUDE.md'), '# Test schema\n');
  await writeFile(path.join(domDir, 'wiki', 'index.md'), '# Index\n\n| Page | Description |\n|---|---|\n');
  await writeFile(path.join(domDir, 'wiki', 'log.md'), '# Log\n');
  await writeFile(
    path.join(domDir, 'wiki', 'entities', 'seed-corp.md'),
    '---\ntype: entity\ntags: [type/entity]\n---\n# Seed Corp\n\n## Key Facts\n- an existing page\n'
  );
}

console.log('\n=== test-mcp-graph-cache ===\n');
await seed();

const storage = createStorageAdapter({ domainsPath: ROOT });

// ── §1 ──────────────────────────────────────────────────────────────────
console.log('§1  A page written through the real compile handler is visible to the real read handlers');
{
  // Warm the cache exactly as a Claude Desktop conversation does: a read
  // FIRST, then a write, then another read — all inside the 10-minute TTL.
  const g0 = await buildGraph(DOMAIN, storage);
  ok('warm-up graph built', g0.nodes.has('seed-corp'), `nodes=${g0.nodes.size}`);
  ok('the domain is cached', __cachedDomains().includes(DOMAIN));

  const res = await compileToWikiHandler({
    domain: DOMAIN,
    title: 'Cache Invalidation Findings',
    summary_content: '# Cache Invalidation Findings\n\n## Summary\nWe found the TTL hid the count check.\n\n## Entities Mentioned\n- [[seed-corp]]\n',
    additional_pages: [
      { path: 'concepts/stale-read.md', content: '# Stale Read\n\n## Definition\nA read served from a cache built before a write.\n' },
    ],
  }, storage);

  ok('compile_to_wiki reported ok', res.ok === true, res.ok ? `pages=${res.pages_written.length}` : String(res.error));
  const summaryPath = res.summary_path;
  ok('a summary page was written to disk', existsSync(path.join(domDir, 'wiki', summaryPath)), summaryPath);
  ok('the concept page was written to disk', existsSync(path.join(domDir, 'wiki', 'concepts', 'stale-read.md')));

  // THE HEADLINE ASSERTION. Same process, same storage adapter, well inside
  // the 10-minute TTL. Before the fix this returned "not found" for a page
  // the tool had just reported writing.
  // get_node returns the node object on success and a PLAIN STRING
  // ("Page ... not found ...") on failure, so the type is the verdict.
  const node = await getNodeHandler({ domain: DOMAIN, slug: 'stale-read' }, storage);
  ok('get_node finds a page compiled moments ago (the defect)',
    typeof node === 'object' && node !== null && node.slug === 'stale-read',
    typeof node === 'string' ? node.slice(0, 120) : `slug=${node && node.slug}`);

  const found = await searchWikiHandler({ domain: DOMAIN, query: 'served from a cache built before' }, storage);
  const hits = (found && (found.results || found.matches)) || [];
  ok('search_wiki finds text from the page compiled moments ago',
    Array.isArray(hits) && hits.length > 0, `hits=${Array.isArray(hits) ? hits.length : 'n/a'}`);

  // And the backlink direction: the summary links [[seed-corp]], so the
  // EXISTING page's graph entry must have changed too — the case a naive
  // "just re-read the new file" fix would miss.
  const seed = await getNodeHandler({ domain: DOMAIN, slug: 'seed-corp' }, storage);
  const seedBacklinks = (typeof seed === 'object' && seed && seed.backlinks) || [];
  ok('the pre-existing page gained the new backlink',
    seedBacklinks.some(b => String(b.slug || b).includes('cache-invalidation-findings')),
    JSON.stringify(seedBacklinks).slice(0, 200));
}

// ── §1b ─────────────────────────────────────────────────────────────────
console.log("\n§1b  ...and it is compile_to_wiki's OWN invalidation doing it, not the count backstop");
{
  // WHY THIS SECTION EXISTS. Deleting the invalidateGraph() call from
  // compile.js left §1 entirely GREEN. The reason is real and worth writing
  // down rather than patching over: a successful compile ALWAYS creates at
  // least one file (the summary slug carries a content hash, so an
  // already-existing slug is refused by the idempotency guard instead), so
  // the file count ALWAYS moves and the §2 backstop always catches it. §1
  // was therefore proving the backstop, not the invalidation.
  //
  // The invalidation is still not redundant, and this section is where that
  // is shown: the backstop only exists for adapters that can count cheaply.
  // The adapter interface is explicitly a swappable one — mcp/storage/local.js
  // opens by naming an r2.js adapter as the next implementation — and
  // buildGraph deliberately falls back to plain TTL behaviour when
  // countWikiFiles is absent rather than paying 173 ms per tool call. On such
  // an adapter, the tool's own invalidation is the ONLY thing between the
  // user and a wiki that appears not to have been written to.
  //
  // So: same flow as §1, driven through an adapter with no countWikiFiles.
  const blind = { ...storage };
  delete blind.countWikiFiles;
  invalidateGraph();

  const warm = await buildGraph(DOMAIN, blind);
  ok('warm-up graph built through the count-blind adapter', warm.nodes.has('seed-corp'));

  const res = await compileToWikiHandler({
    domain: DOMAIN,
    title: 'Blind Adapter Findings',
    summary_content: '# Blind Adapter Findings\n\n## Summary\nAn adapter that cannot count cheaply.\n\n## Entities Mentioned\n- [[seed-corp]]\n',
    additional_pages: [
      { path: 'concepts/blind-adapter.md', content: '# Blind Adapter\n\n## Definition\nA storage adapter with no cheap staleness probe.\n' },
    ],
  }, storage);
  ok('compile_to_wiki reported ok', res.ok === true, res.ok ? '' : String(res.error));

  const node = await getNodeHandler({ domain: DOMAIN, slug: 'blind-adapter' }, blind);
  ok('get_node through a count-blind adapter still sees the page (invalidation is the ONLY mechanism here)',
    typeof node === 'object' && node !== null && node.slug === 'blind-adapter',
    typeof node === 'string' ? node.slice(0, 110) : `slug=${node && node.slug}`);

  // ANTI-VACUITY: prove that adapter really is blind, i.e. that the assertion
  // above cannot be passing because something else invalidated. A write that
  // NO tool announced stays invisible to it inside the TTL.
  const warm2 = await buildGraph(DOMAIN, blind);
  await writeFile(path.join(domDir, 'wiki', 'entities', 'unannounced.md'),
    '---\ntype: entity\n---\n# Unannounced\n');
  const stillWarm = await buildGraph(DOMAIN, blind);
  ok('CONTROL: the same blind adapter does NOT see an unannounced write',
    stillWarm === warm2 && !stillWarm.nodes.has('unannounced'));

  invalidateGraph();
}

// ── §2 ──────────────────────────────────────────────────────────────────
console.log('\n§2  invalidateGraph is a real drop, and the count backstop is reachable');
{
  const before = await buildGraph(DOMAIN, storage);
  const again = await buildGraph(DOMAIN, storage);
  ok('CONTROL: two consecutive builds with no change return the SAME object (cache is real)',
    before === again);

  invalidateGraph(DOMAIN);
  ok('after invalidateGraph the domain is no longer cached', !__cachedDomains().includes(DOMAIN));
  const rebuilt = await buildGraph(DOMAIN, storage);
  ok('the next build is a genuinely new object', rebuilt !== before);
  ok('the rebuilt graph has the same content', rebuilt.nodes.size === before.nodes.size,
    `${rebuilt.nodes.size} vs ${before.nodes.size}`);

  invalidateGraph();                       // no argument = clear everything
  ok('invalidateGraph() with no argument clears every domain', __cachedDomains().length === 0);

  // The count backstop: add a file BEHIND the tools' backs (as an Obsidian
  // edit or a git pull would) and require the very next build to see it,
  // inside the TTL, with nothing having called invalidateGraph.
  const warm = await buildGraph(DOMAIN, storage);
  await writeFile(path.join(domDir, 'wiki', 'entities', 'appeared-behind-our-back.md'),
    '---\ntype: entity\n---\n# Appeared\n\n## Key Facts\n- written outside every tool\n');
  const after = await buildGraph(DOMAIN, storage);
  ok('a file appearing outside the tools invalidates the cache inside the TTL',
    after !== warm && after.nodes.has('appeared-behind-our-back'),
    `nodes ${warm.nodes.size} -> ${after.nodes.size}`);

  // Anti-vacuity: the count probe must actually be the mechanism, i.e. an
  // adapter WITHOUT countWikiFiles falls back to the TTL and keeps serving
  // the stale graph. If this passed, §2's previous assertion would be
  // passing for some other reason.
  const blind = { ...storage };
  delete blind.countWikiFiles;
  const warm2 = await buildGraph(DOMAIN, storage);
  await writeFile(path.join(domDir, 'wiki', 'entities', 'invisible-to-a-blind-adapter.md'),
    '---\ntype: entity\n---\n# Invisible\n');
  const blindRead = await buildGraph(DOMAIN, blind);
  ok('CONTROL: an adapter with no countWikiFiles keeps the TTL behaviour',
    blindRead === warm2 && !blindRead.nodes.has('invisible-to-a-blind-adapter'));
  invalidateGraph();
}

// ── §3 ──────────────────────────────────────────────────────────────────
console.log('\n§3  countWikiFiles agrees with listWikiFiles, which is what makes the check meaningful');
{
  const listed = await storage.listWikiFiles(DOMAIN);
  const counted = await storage.countWikiFiles(DOMAIN);
  ok('the two walks agree exactly', counted === listed.length, `count=${counted}, list=${listed.length}`);
  ok('and the number is not trivially zero', counted > 3, `count=${counted}`);
  ok('an unknown domain counts 0, it does not throw', (await storage.countWikiFiles('no-such-domain')) === 0);
  ok('a traversal-shaped domain counts 0', (await storage.countWikiFiles('../..')) === 0);
}

// ── §4 ──────────────────────────────────────────────────────────────────
console.log('\n§4  The storage path guard refuses a symlink that leaves the domains folder');
{
  const outside = await mkdtemp(path.join(os.tmpdir(), 'curator-outside-'));
  const secretPath = path.join(outside, 'id_rsa');
  await writeFile(secretPath, 'PRETEND-PRIVATE-KEY-NOT-A-REAL-CREDENTIAL\n');

  // A symlink INSIDE the domains folder pointing at a file outside it. Every
  // lexical check passes: the request string never contains `..` and is not
  // absolute.
  const escapeLink = path.join(domDir, 'wiki', 'entities', 'escape.md');
  await symlink(secretPath, escapeLink);
  ok('the symlink really is there and really does point outside',
    existsSync(escapeLink) && (await readFile(escapeLink, 'utf8')).includes('PRETEND-PRIVATE-KEY'));

  const viaAdapter = await storage.readFile(path.join(DOMAIN, 'wiki', 'entities', 'escape.md'));
  ok('storage.readFile REFUSES the escaping symlink', viaAdapter === null,
    viaAdapter === null ? '' : `leaked ${String(viaAdapter).slice(0, 40)}`);

  const listedNow = await storage.listWikiFiles(DOMAIN);
  ok('listWikiFiles does not return the escaping symlink',
    !listedNow.some(f => f.path.endsWith('escape.md')));
  ok('and its content is nowhere in the listing',
    !listedNow.some(f => f.content.includes('PRETEND-PRIVATE-KEY')));
  const countNow = await storage.countWikiFiles(DOMAIN);
  ok('countWikiFiles does not count it either (the two walks stay in step)',
    countNow === listedNow.length, `count=${countNow}, list=${listedNow.length}`);

  // A symlinked DIRECTORY pointing outside — the ancestor case.
  const escapeDir = path.join(domDir, 'wiki', 'concepts', 'outside-dir');
  await symlink(outside, escapeDir);
  const viaDir = await storage.readFile(path.join(DOMAIN, 'wiki', 'concepts', 'outside-dir', 'id_rsa'));
  ok('a symlinked ANCESTOR directory is refused too', viaDir === null);

  // CONTROLS — the guard must still allow everything legitimate, or it is
  // just a broken adapter rather than a hardened one.
  const legit = await storage.readFile(path.join(DOMAIN, 'wiki', 'entities', 'seed-corp.md'));
  ok('CONTROL: an ordinary nested page still reads', typeof legit === 'string' && legit.includes('Seed Corp'));
  const deepDir = path.join(domDir, 'wiki', 'entities', 'nested', 'deeper');
  await mkdir(deepDir, { recursive: true });
  await writeFile(path.join(deepDir, 'deep-page.md'), '# Deep\n');
  const deep = await storage.readFile(path.join(DOMAIN, 'wiki', 'entities', 'nested', 'deeper', 'deep-page.md'));
  ok('CONTROL: a legitimately DEEP nested path still reads', typeof deep === 'string' && deep.includes('Deep'));

  // A symlink that stays INSIDE the base must still work — otherwise the
  // guard is "no symlinks", which is a different (and lazier) rule.
  const insideLink = path.join(domDir, 'wiki', 'concepts', 'alias-to-seed.md');
  await symlink(path.join(domDir, 'wiki', 'entities', 'seed-corp.md'), insideLink);
  const aliased = await storage.readFile(path.join(DOMAIN, 'wiki', 'concepts', 'alias-to-seed.md'));
  ok('CONTROL: a symlink that resolves back INSIDE the base is allowed',
    typeof aliased === 'string' && aliased.includes('Seed Corp'));

  ok('CONTROL: absolute paths are still refused', (await storage.readFile('/etc/hosts')) === null);
  ok('CONTROL: ../ traversal is still refused', (await storage.readFile('../../../etc/hosts')) === null);

  await rm(escapeLink, { force: true });
  await rm(escapeDir, { force: true });
  await rm(insideLink, { force: true });
  await rm(outside, { recursive: true, force: true });
}

// ── §5 ──────────────────────────────────────────────────────────────────
console.log('\n§5  The >MAX_PAGES refusal names the recovery path and its trap');
{
  const many = Array.from({ length: 12 }, (_, i) => ({
    path: `concepts/overflow-${i}.md`,
    content: `# Overflow ${i}\n\n## Definition\nfiller\n`,
  }));
  const res = await compileToWikiHandler({
    domain: DOMAIN,
    title: 'Way Too Many Pages',
    summary_content: '# Way Too Many Pages\n\n## Summary\nfiller\n',
    additional_pages: many,
  }, storage);

  ok('the call is refused', res.ok === false, String(res.error).slice(0, 60));
  const err = String(res.error || '');
  ok('it still states the numbers', /13 requested/.test(err) && /max 10/.test(err), err.slice(0, 80));
  ok('it tells the caller to split by topic', /split/i.test(err) && /topic/i.test(err));
  ok('it demands DISTINCT titles', /distinct/i.test(err) && /title/i.test(err));
  ok('it warns that reusing the title writes a SECOND summary page',
    /second summary/i.test(err), err.slice(-160));
  ok('it says entity/concept pages are safe to spread across calls',
    /merge on write/i.test(err));

  // And the trap it warns about is REAL, not folklore: two calls with the
  // SAME title and different page sets produce two different summary slugs.
  const a = await compileToWikiHandler({
    domain: DOMAIN,
    title: 'Split Trap Demo',
    summary_content: '# Split Trap Demo\n\n## Summary\npart one\n',
    additional_pages: [{ path: 'concepts/split-part-one.md', content: '# Part One\n' }],
  }, storage);
  const b = await compileToWikiHandler({
    domain: DOMAIN,
    title: 'Split Trap Demo',
    summary_content: '# Split Trap Demo\n\n## Summary\npart one\n',
    additional_pages: [{ path: 'concepts/split-part-two.md', content: '# Part Two\n' }],
  }, storage);
  ok('both same-title calls succeed', a.ok === true && b.ok === true);
  ok('and they wrote TWO DIFFERENT summary pages — the trap the copy warns about',
    a.ok && b.ok && a.summary_path !== b.summary_path,
    `${a.summary_path} vs ${b.summary_path}`);

  // CONTROL: the idempotency guard DOES still fire when nothing changed, so
  // the assertion above is about the corpus hash, not a broken guard.
  const c = await compileToWikiHandler({
    domain: DOMAIN,
    title: 'Split Trap Demo',
    summary_content: '# Split Trap Demo\n\n## Summary\npart one\n',
    additional_pages: [{ path: 'concepts/split-part-two.md', content: '# Part Two\n' }],
  }, storage);
  ok('CONTROL: an identical repeat IS refused by the idempotency guard',
    c.ok === false && /Already compiled/.test(String(c.error)), String(c.error).slice(0, 70));
}

// ── §7 ──────────────────────────────────────────────────────────────────
console.log('\n§7  A fix applied through the real fix_wiki_issue handler is visible to the real read handlers');
{
  // folderPrefixLinks is chosen deliberately over the delete-shaped fixes:
  // it rewrites a page's CONTENT and leaves the file count IDENTICAL, so the
  // count backstop cannot see it. Only the explicit invalidation can — which
  // is the point, and is what makes this section a guard rather than a
  // restatement of §2.
  await writeFile(
    path.join(domDir, 'wiki', 'concepts', 'prefix-user.md'),
    '---\ntype: concept\n---\n# Prefix User\n\n## Related\n- [[entities/seed-corp]]\n'
  );
  invalidateGraph();

  const beforeNode = await getNodeHandler({ domain: DOMAIN, slug: 'prefix-user' }, storage);
  const countBefore = await storage.countWikiFiles(DOMAIN);
  ok('the page starts with a folder-prefixed link',
    typeof beforeNode === 'object' && beforeNode.body.includes('[[entities/seed-corp]]'));

  const fixed = await fixWikiIssueHandler({
    domain: DOMAIN,
    type: 'folderPrefixLinks',
    issue: { sourceFile: 'concepts/prefix-user.md' },
  }, storage);
  ok('fix_wiki_issue reported a fix', fixed.ok === true && fixed.fixed === 1,
    JSON.stringify({ ok: fixed.ok, fixed: fixed.fixed, reason: fixed.reason }));
  ok('the fix landed on disk',
    (await readFile(path.join(domDir, 'wiki', 'concepts', 'prefix-user.md'), 'utf8')).includes('[[seed-corp]]'));
  ok('and the FILE COUNT did not move — the backstop is blind to this fix',
    (await storage.countWikiFiles(DOMAIN)) === countBefore, `count=${countBefore}`);

  const afterNode = await getNodeHandler({ domain: DOMAIN, slug: 'prefix-user' }, storage);
  ok('get_node reflects the fix immediately (the defect)',
    typeof afterNode === 'object' && afterNode.body.includes('[[seed-corp]]')
      && !afterNode.body.includes('[[entities/seed-corp]]'),
    typeof afterNode === 'string' ? afterNode.slice(0, 100) : afterNode.body.replace(/\n/g, ' ').slice(0, 120));
}

// ── isolation check ─────────────────────────────────────────────────────
console.log('\n§6  Isolation');
{
  ok('the real credential files are byte-identical', fingerprint() === FP_BEFORE);
  ok('everything was written under the temp root', existsSync(path.join(ROOT, DOMAIN)));
}

await rm(ROOT, { recursive: true, force: true });
await rm(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true, force: true });

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
