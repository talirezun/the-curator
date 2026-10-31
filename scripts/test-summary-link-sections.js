#!/usr/bin/env node
/**
 * test-summary-link-sections.js — OFFLINE suite for v3.84.0's summary link
 * sections: prevention (syncSummaryEntities, writePage's post-rewrite dedup,
 * Health's rewriters, injectFrontmatter's `Source:` matching) and the repair
 * for existing wikis (Health issue `summaryLinkSections`).
 *
 * WHY. Measured read-only on copies of the maintainer's real domains:
 * articles had 2,969 of 4,936 "Entities Mentioned" links resolving to
 * CONCEPT pages (syncSummaryEntities put every written page there), and
 * articles + projects carried 200 identical duplicate lines in those
 * sections (writePage deduplicated BEFORE its link rewrites turned distinct
 * lines into identical ones; Health's rewriters never deduplicated at all).
 *
 *   §1  the pure tidy — folder decides section, repeated lines go, aliases and
 *       prose are never lost, nothing outside the two sections changes,
 *       idempotent. Checked with an INDEPENDENT link-set parser.
 *   §2  the HARD GUARD — summaryTidyGuard on its own, and wired: a lossy
 *       composition (test seam) is refused by the Health fix AND by
 *       syncSummaryEntities, with the file byte-identical.
 *   §3  writePage deduplicates AFTER the 5b/5b2/5c link rewrites; link-only
 *       `[[x]]` and `[[x|Alias]]` are one bullet; prose bullets are not merged.
 *   §4  Health's rewriters (fixBrokenLink, folderPrefixLinks, repointInboundLinks
 *       via a merge, applyBrokenLinkFixes) never leave an identical copy.
 *   §5  syncSummaryEntities files pages by folder, tidies the model's misfiling,
 *       and still backlinks concepts.
 *   §6  injectFrontmatter: `source:` / `**Source:**` / `**Source**:` on summaries.
 *   §7  Health over the REAL health router on Express: scan rows equal an
 *       independent count, /fix, /fix-all, /fix-all-safe, cache ON rescan clean,
 *       every page's link set unchanged, non-summary pages byte-identical,
 *       mirror skipped + refused, not dismissible, HEALTH_ISSUE_KEYS.
 *   §8  MCP: scan_wiki_health counts it as auto-fixable; fix_wiki_issue applies it.
 *
 * Isolated: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR set before any
 * app import, plus __setDomainsDirOverride. Never touches a real domain.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ✗ ${label}${detail !== undefined ? ' — ' + String(detail).slice(0, 600) : ''}`); }
}
const section = (n) => console.log(`\n── ${n} ──`);

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-summary-links-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');
delete process.env.DOMAINS_PATH;

const { __setDomainsDirOverride, getDomainsDir } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const files = await import('../src/brain/files.js');
const health = await import('../src/brain/health.js');
const hs = await import('../src/brain/health-summary.js');
const { default: healthRouter } = await import('../src/routes/health.js');
const { default: express } = await import('express');
const mcpHealth = await import('../mcp/tools/health.js');

const realErr = console.error, realWarn = console.warn;
const quiet = () => { console.error = () => {}; console.warn = () => {}; };
const loud = () => { console.error = realErr; console.warn = realWarn; };

// ── Independent helpers (NOT the module under test's parsers) ──────────────
/** Every [[target]] in text, alias and surrounding space stripped, as a sorted unique list. */
function linkSetOf(text) {
  const out = new Set();
  let i = 0;
  while ((i = text.indexOf('[[', i)) !== -1) {
    const j = text.indexOf(']]', i + 2);
    if (j === -1) break;
    const inner = text.slice(i + 2, j);
    if (!inner.includes('\n')) {
      const t = inner.split('|')[0].trim();
      if (t) out.add(t);
    }
    i = j + 2;
  }
  return [...out].sort().join('\n');
}
/** `- ` lines directly under the named `## ` heading (until any next heading). */
function bulletsUnder(content, name) {
  const out = [];
  let on = false;
  for (const line of content.split('\n')) {
    if (/^#{1,6}\s/.test(line)) { on = line.replace(/^##\s+/, '').trim().toLowerCase() === name.toLowerCase() && /^##\s/.test(line); continue; }
    if (on && line.startsWith('- ')) out.push(line);
  }
  return out;
}
const E = 'Entities Mentioned', C = 'Concepts Introduced or Referenced';
function mkDomain(name, schema = `# Domain: ${name}\n`) {
  const dd = path.join(DOMAINS, name);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), schema, 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n', 'utf8');
  const wiki = path.join(dd, 'wiki');
  return {
    name, wiki,
    put: (rel, body) => writeFileSync(path.join(wiki, rel), body, 'utf8'),
    read: (rel) => readFileSync(path.join(wiki, rel), 'utf8'),
  };
}
function readTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.set(path.relative(root, p).split(path.sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return out;
}
const slugs = (ents, cons) => ({ entitySlugs: new Set(ents), conceptSlugs: new Set(cons) });

try {
  section('§0 Isolation');
  ok(getDomainsDir() === path.resolve(DOMAINS), '0.1 the domains dir is the temp dir', getDomainsDir());

  // ══════════════════════════════════════════════════════════════════════
  section('§1 The pure tidy');
  {
    const S = slugs(['openai', 'nvidia', 'both-ent'], ['rag', 'fine-tuning', 'agents']);
    const src =
      '# Report\n\n## Key Takeaways\n- [[rag]] matters\n- [[rag]] matters\n- [[openai]] ships\n\n' +
      '## Concepts Introduced or Referenced\n- [[agents]]\n- [[nvidia]]\n\n' +
      '## Entities Mentioned\n- [[openai]]\n- [[openai]]\n- [[rag]]\n- [[fine-tuning|FT]]\n- [[fine-tuning]]\n' +
      '- [[agents]]\n- [[nvidia]] — makes chips\n- [[nvidia]]\n- [[summaries/other]]\n- [[ghost-page]]\n- [[ghost-page]]\n' +
      '- [[openai]] and [[rag]] together\n- [[openai]] — maker of [[nvidia]]\n- [[concepts/rag]]\n\nA prose line in the section.\n\n' +
      '## Notes\nKeep [[openai]] here.\n';
    const r = files.tidySummaryLinkSections(src, S);
    const out = r.content;
    const ents = bulletsUnder(out, E), cons = bulletsUnder(out, C);
    ok(r.changed && !r.refused, '1.1 an untidy summary is changed and not refused', JSON.stringify(r.refused));
    ok(cons.includes('- [[rag]]') && !ents.includes('- [[rag]]'), '1.2 a concept link filed under Entities Mentioned moves to the concepts section');
    ok(cons.includes('- [[fine-tuning|FT]]') && !ents.some(l => l.includes('fine-tuning')), '1.3 …an aliased concept link moves too, with its alias');
    ok(!cons.includes('- [[fine-tuning]]'), '1.4 the PLAIN [[fine-tuning]] goes: the aliased line already carries that link (alias kept, not dropped)');
    ok(ents.includes('- [[nvidia]] — makes chips') && !cons.some(l => /\[\[nvidia\]\]/.test(l) && !l.includes('makes')),
      '1.5 an entity link filed under the concepts section moves to Entities Mentioned (a page\'s FOLDER decides)', cons.join(' | '));
    ok(ents.filter(l => l === '- [[nvidia]]').length === 0, '1.6 a plain [[nvidia]] goes when a prose bullet there already starts with [[nvidia]]');
    ok(ents.filter(l => l === '- [[ghost-page]]').length === 1, '1.7 an identical line appears once (even for a broken link, which never moves)');
    ok(ents.filter(l => l === '- [[openai]]').length === 0 && ents.includes('- [[openai]] — maker of [[nvidia]]'),
      '1.7b plain [[openai]] (twice) goes: prose bullets there already start with [[openai]]');
    ok(ents.includes('- [[summaries/other]]') && ents.includes('- [[ghost-page]]'), '1.8 summary links and broken links are never moved');
    ok(ents.includes('- [[openai]] and [[rag]] together'), '1.9 a bullet mixing an entity and a concept stays where it is');
    ok(ents.includes('- [[openai]] — maker of [[nvidia]]'), '1.10 an all-entity prose bullet stays in Entities Mentioned');
    ok(cons.includes('- [[concepts/rag]]'), '1.11 a folder-prefixed concept link moves by its explicit folder (and is not merged with bare [[rag]] — different link text)');
    ok(cons.filter(l => l === '- [[agents]]').length === 1, '1.12 a link already in the concepts section is not duplicated by the move');
    ok(out.includes('A prose line in the section.'), '1.13 a non-bullet line inside the section is kept');
    ok(out.includes('- [[rag]] matters\n- [[rag]] matters'), '1.14 Key Takeaways is NEVER touched — even its identical lines stay');
    ok(out.includes('## Notes\nKeep [[openai]] here.'), '1.15 text after the sections is untouched');
    ok(linkSetOf(out) === linkSetOf(src), '1.16 the page\'s link set is identical (independent parser)');
    ok(r.stats.conceptsToMove === 5 && r.stats.entitiesToMove === 1,
      `1.17 stats count the moves (concepts ${r.stats.conceptsToMove}, entities ${r.stats.entitiesToMove})`);
    const r2 = files.tidySummaryLinkSections(out, S);
    ok(!r2.changed && r2.content === out, '1.18 IDEMPOTENT — a second tidy changes nothing');

    // Section creation
    const noC = '# X\n\n## Entities Mentioned\n- [[openai]]\n- [[rag]]\n\n## Notes\nn\n';
    const rc = files.tidySummaryLinkSections(noC, S).content;
    ok(/## Concepts Introduced or Referenced\n- \[\[rag\]\]\n\n## Entities Mentioned\n- \[\[openai\]\]\n/.test(rc),
      '1.19 a missing concepts section is CREATED, just above Entities Mentioned', rc);
    const noE = '# X\n\n## Concepts Introduced or Referenced\n- [[rag]]\n- [[openai]]\n';
    const re = files.tidySummaryLinkSections(noE, S).content;
    ok(/## Concepts Introduced or Referenced\n- \[\[rag\]\]\n\n## Entities Mentioned\n- \[\[openai\]\]/.test(re),
      '1.20 a missing Entities section is created after the concepts section (at end of file)', re);
    const clean = '# X\n\n## Concepts Introduced or Referenced\n- [[rag]]\n\n## Entities Mentioned\n- [[openai]]\n';
    ok(!files.tidySummaryLinkSections(clean, S).changed, '1.21 a tidy summary is left alone');
    ok(!files.tidySummaryLinkSections('# No sections\n\nJust [[rag]].\n', S).changed, '1.22 a page with neither section is left alone');
    const second = '# X\n\n## Entities Mentioned\n- [[openai]] — maker of [[rag]]\n- [[rag]]\n';
    ok(files.tidySummaryLinkSections(second, S).content.includes('- [[rag]]'),
      '1.23 a link that is only a SECOND link of another bullet keeps its own bullet (backlinks use first links)');
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§2 The hard guard');
  {
    const before = '# X\n\n## Key Takeaways\n- t\n\n## Entities Mentioned\n- [[a]]\n- [[b]]\n';
    ok(files.summaryTidyGuard(before, before.replace('- [[b]]\n', '')) === 'link-set-changed', '2.1 dropping a link is refused (link-set-changed)');
    ok(files.summaryTidyGuard(before, before.replace('- t', '- t2')) === 'outside-text-changed', '2.2 changing Key Takeaways is refused (outside-text-changed)');
    ok(files.summaryTidyGuard(before, before.replace('- t\n', '- t\nnew prose\n')) === 'outside-text-changed', '2.3 adding prose outside the sections is refused');
    ok(files.summaryTidyGuard(before, before.replace('[[b]]', '[[c]]')) === 'link-set-changed', '2.4 retargeting a link is refused');
    ok(files.summaryTidyGuard(before, before.replace('- [[a]]\n- [[b]]', '- [[b]]\n- [[a]]\n- [[a]]')) === null, '2.5 reordering / repeating within the sections passes');

    // Wired: a lossy composition (seam) must be refused end to end.
    const D = mkDomain('guard');
    D.put('entities/alpha.md', '# Alpha\n');
    D.put('concepts/beta.md', '# Beta\n');
    const MESSY = '# G\n\n## Entities Mentioned\n- [[alpha]]\n- [[alpha]]\n- [[beta]]\n';
    D.put('summaries/g.md', MESSY);
    files.__setSummaryTidyComposeForTest((text) => ({ content: text.replace('- [[beta]]\n', ''), stats: { duplicateLines: 1, conceptsToMove: 0, entitiesToMove: 0, sampleConcepts: [], sampleEntities: [] } }));
    let r;
    try { r = await health.fixIssue('guard', 'summaryLinkSections', { summary: 'summaries/g.md' }); }
    finally { files.__setSummaryTidyComposeForTest(null); }
    ok(r.fixed === 0 && r.reason === 'link-guard', '2.6 the Health fix REFUSES a lossy tidy (reason link-guard)', JSON.stringify(r));
    ok(D.read('summaries/g.md') === MESSY, '2.7 …and the page is byte-identical');

    files.__setSummaryTidyComposeForTest((text) => ({ content: text.replace(/- \[\[beta\]\]\n/g, ''), stats: {} }));
    quiet();
    try { await files.syncSummaryEntities('guard', 'summaries/g.md', ['summaries/g.md']); }
    finally { files.__setSummaryTidyComposeForTest(null); loud(); }
    ok(D.read('summaries/g.md').includes('[[beta]]'), '2.8 syncSummaryEntities never writes a lossy tidy either (the guard is inside the tidy)');
    r = await health.fixIssue('guard', 'summaryLinkSections', { summary: 'summaries/g.md' });
    ok(r.fixed === 1 && linkSetOf(D.read('summaries/g.md')) === linkSetOf(MESSY), '2.9 with the real composition the same page is fixed, links intact', JSON.stringify(r));
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§3 writePage deduplicates AFTER its link rewrites');
  {
    const D = mkDomain('wp');
    D.put('concepts/rag.md', '# RAG\n');
    D.put('entities/tali-rezun.md', '# Tali\n');
    quiet();
    await files.writePage('wp', 'entities/host.md',
      '# Host\n\n## Related\n- [[concepts/rag]]\n- [[rag]]\n- [[rag.md]]\n- [[talirezun]]\n- [[tali-rezun]]\n- [[rag|RAG]]\n\n' +
      '## Key Facts\n- [[rag]] is one idea\n- [[rag]] is another idea\n');
    loud();
    const host = D.read('entities/host.md');
    const rel = bulletsUnder(host, 'Related');
    ok(rel.filter(l => /^- \[\[rag(\|RAG)?\]\]$/.test(l)).length === 1,
      '3.1 [[concepts/rag]], [[rag]], [[rag.md]] and [[rag|RAG]] leave ONE rag bullet after the rewrites', rel.join(' | '));
    ok(rel.filter(l => l === '- [[tali-rezun]]').length === 1, '3.2 the hyphen-variant rewrite ([[talirezun]] → [[tali-rezun]]) leaves one bullet', rel.join(' | '));
    ok(host.includes('- [[rag]] is one idea'), '3.3 prose bullets keep the historical first-link key (not widened by the alias change)');
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§4 Health rewriters never leave an identical copy');
  {
    const D = mkDomain('hr');
    D.put('concepts/rag.md', '# RAG\n');
    D.put('entities/tali-rezun.md', '# Tali\n\n## Key Facts\n- a\n');
    D.put('entities/dr-tali-rezun.md', '# Dr Tali\n\n## Key Facts\n- b\n');
    D.put('entities/p1.md', '# P1\n\n## Related\n- [[ragg]]\n- [[rag]]\n- [[ragg]] is distinct prose\n- [[rag]] is other prose\n');
    D.put('entities/p2.md', '# P2\n\n## Related\n- [[concepts/rag]]\n- [[rag]]\n- [[concepts/rag|R]]\n');
    D.put('entities/p3.md', '# P3\n\n## Related\n- [[dr-tali-rezun]]\n- [[tali-rezun]]\n- [[dr-tali-rezun|Doc]]\n');
    D.put('entities/p4.md', '# P4\n\n## Related\n- [[rag-x]]\n- [[rag]]\n');
    quiet();
    const r1 = await health.fixIssue('hr', 'brokenLinks', { sourceFile: 'entities/p1.md', linkText: 'ragg', suggestedTarget: 'rag' });
    const r2 = await health.fixIssue('hr', 'folderPrefixLinks', { sourceFile: 'entities/p2.md', linkText: 'concepts/rag' });
    const r3 = await health.fixIssue('hr', 'hyphenVariants', { files: ['tali-rezun', 'dr-tali-rezun'], suggestedSlug: 'tali-rezun' });
    const r4 = await health.applyBrokenLinkFixes('hr', [{ linkText: 'rag-x', action: 'retarget', target: 'rag' }]);
    loud();
    const p1 = bulletsUnder(D.read('entities/p1.md'), 'Related');
    ok(r1.fixed === 1 && p1.filter(l => l === '- [[rag]]').length === 1, '4.1 fixBrokenLink: the retargeted copy of - [[rag]] is dropped', p1.join(' | '));
    ok(p1.includes('- [[rag]] is distinct prose') && p1.includes('- [[rag]] is other prose'), '4.2 …prose bullets that now share a first link are BOTH kept');
    const p2 = bulletsUnder(D.read('entities/p2.md'), 'Related');
    ok(r2.fixed === 1 && p2.filter(l => l === '- [[rag]]').length === 1 && p2.includes('- [[rag|R]]'),
      '4.3 folderPrefixLinks: one - [[rag]], the aliased line kept', p2.join(' | '));
    const p3 = bulletsUnder(D.read('entities/p3.md'), 'Related');
    ok(r3.fixed === 1 && p3.filter(l => l === '- [[tali-rezun]]').length === 1 && p3.includes('- [[tali-rezun|Doc]]'),
      '4.4 a merge\'s repoint (repointInboundLinks): one - [[tali-rezun]], the alias kept', p3.join(' | '));
    const p4 = bulletsUnder(D.read('entities/p4.md'), 'Related');
    ok(r4.retargeted === 1 && p4.filter(l => l === '- [[rag]]').length === 1, '4.5 applyBrokenLinkFixes: one - [[rag]]', p4.join(' | '));
    ok(files.dedupRewrittenBullets('a\n- x\n- y', 'a\n- x\n- x') === 'a\n- x', '4.6 dedupRewrittenBullets drops only the line the rewrite changed into a copy');
    ok(files.dedupRewrittenBullets('- x\n- x', '- x\n- x') === '- x\n- x', '4.7 …and never pre-existing duplicates the rewrite did not create');
    ok(files.dedupRewrittenBullets('## A\n- x\n## B\n- y', '## A\n- x\n## B\n- x') === '## A\n- x\n## B\n- x', '4.8 …and only within one section');
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§5 syncSummaryEntities files by folder, tidies, and still backlinks concepts');
  {
    const D = mkDomain('sync');
    const page = (t) => `# ${t}\n\n## Related\n`;
    quiet();
    const s = await files.writePage('sync', 'summaries/rep.md',
      '# Rep\n\n## Key Takeaways\n- k\n\n## Entities Mentioned\n- [[openai]]\n- [[rag]]\n- [[old-concept]]\n');
    const paths = [s.canonPath];
    paths.push((await files.writePage('sync', 'entities/openai.md', page('OpenAI'))).canonPath);
    paths.push((await files.writePage('sync', 'concepts/rag.md', page('RAG'))).canonPath);
    paths.push((await files.writePage('sync', 'concepts/agents.md', page('Agents'))).canonPath);
    D.put('concepts/old-concept.md', page('Old'));      // existed before, not written this ingest
    await files.syncSummaryEntities('sync', s.canonPath, paths);
    loud();
    const out = D.read('summaries/rep.md');
    const ents = bulletsUnder(out, E), cons = bulletsUnder(out, C);
    ok(ents.includes('- [[openai]]') && !cons.some(l => l.includes('openai')), '5.1 the written entity is under Entities Mentioned only');
    ok(cons.includes('- [[rag]]') && cons.includes('- [[agents]]') && !ents.some(l => /rag|agents/.test(l)),
      '5.2 written concepts are under Concepts Introduced or Referenced only', out);
    ok(cons.includes('- [[old-concept]]') && !ents.some(l => l.includes('old-concept')),
      '5.3 a concept the MODEL filed under Entities Mentioned is moved by the tidy');
    ok(out.split('\n').filter(l => l.startsWith('## ')).filter(l => l === `## ${C}`).length === 1, '5.4 exactly one concepts heading');
    for (const slug of ['openai', 'rag', 'agents', 'old-concept']) {
      const folder = slug === 'openai' ? 'entities' : 'concepts';
      ok(bulletsUnder(D.read(`${folder}/${slug}.md`), 'Related').some(l => l.includes('[[summaries/rep]]')),
        `5.5.${slug} ${folder}/${slug} carries the backlink`);
    }
    // The tidy above would MASK an injection that still filed concepts under
    // Entities Mentioned (measured: that mutation stayed green). So the
    // injection is pinned on its own, with the tidy neutralised by the seam.
    {
      const D3 = mkDomain('sync-raw');
      quiet();
      const s3 = await files.writePage('sync-raw', 'summaries/raw.md', '# Raw\n\n## Entities Mentioned\n');
      const p3 = [s3.canonPath,
        (await files.writePage('sync-raw', 'entities/e1.md', page('E1'))).canonPath,
        (await files.writePage('sync-raw', 'concepts/c1.md', page('C1'))).canonPath];
      files.__setSummaryTidyComposeForTest((text) => ({ content: text, stats: {} }));
      try { await files.syncSummaryEntities('sync-raw', s3.canonPath, p3); }
      finally { files.__setSummaryTidyComposeForTest(null); loud(); }
      const raw = D3.read('summaries/raw.md');
      ok(bulletsUnder(raw, C).includes('- [[c1]]') && !bulletsUnder(raw, E).includes('- [[c1]]') && bulletsUnder(raw, E).includes('- [[e1]]'),
        '5.7 the INJECTION itself files by folder (tidy neutralised): c1 under Concepts, e1 under Entities', raw);
      ok(/## Concepts Introduced or Referenced\n[\s\S]*## Entities Mentioned/.test(raw), '5.8 …and a created concepts section sits above Entities Mentioned', raw);
    }
    const scan = await health.scanWiki('sync');
    ok(scan.summaryLinkSections.length === 0 && scan.missingBacklinks.length === 0,
      '5.6 a freshly synced summary raises no Health row (prevention and repair agree)', JSON.stringify([scan.summaryLinkSections, scan.missingBacklinks]));
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§6 injectFrontmatter — the Source line, any case, bold or not');
  {
    mkDomain('fm');
    quiet();
    const cases = [
      ['lower', 'source: lower.pdf', 'lower.pdf'],
      ['bold-in', '**Source:** bold-in.pdf', 'bold-in.pdf'],
      ['bold-out', '**Source**: bold-out.pdf', 'bold-out.pdf'],
      ['upper', 'SOURCE: upper.pdf', 'upper.pdf'],
      ['classic', 'Source: classic.pdf', 'classic.pdf'],
    ];
    for (const [slug, line, want] of cases) {
      await files.writePage('fm', `summaries/${slug}.md`, `# T ${slug}\n${line}\nDate Ingested: 2026-10-31\n\n## Key Facts\n- **Source control:** private repo\n`);
      const t = readFileSync(path.join(DOMAINS, 'fm', 'wiki', 'summaries', `${slug}.md`), 'utf8');
      const fmEnd = t.indexOf('\n---\n', 4);
      const fm = t.slice(0, fmEnd), body = t.slice(fmEnd + 5);
      ok(new RegExp(`^source: ${want.replace('.', '\\.')}$`, 'm').test(fm) && !body.includes(line) && /^date: 2026-10-31$/m.test(fm),
        `6.${slug} "${line}" becomes frontmatter source: ${want} and leaves the body`, t);
      ok(t.includes('- **Source control:** private repo'), `6.${slug}b a "- **Source control:**" bullet is never taken for the field`);
    }
    await files.writePage('fm', 'entities/ent.md', '# Ent\nsource: stays.pdf\n');
    ok(readFileSync(path.join(DOMAINS, 'fm', 'wiki', 'entities', 'ent.md'), 'utf8').includes('source: stays.pdf\n'),
      '6.entity a lowercase "source:" line on a NON-summary page is left as it was (historical behaviour unchanged)');
    loud();
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§7 Health over the real router');
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }); let j = null; try { j = await res.json(); } catch {} return { status: res.status, body: j }; };
  const get = async (p) => { const res = await fetch(BASE + p); let j = null; try { j = await res.json(); } catch {} return { status: res.status, body: j }; };
  try {
    const D = mkDomain('big');
    const ENTS = [], CONS = [];
    for (let i = 0; i < 300; i++) { ENTS.push(`ent-${i}`); D.put(`entities/ent-${i}.md`, `# Ent ${i}\n\n## Related\n`); }
    for (let i = 0; i < 900; i++) { CONS.push(`con-${i}`); D.put(`concepts/con-${i}.md`, `# Con ${i}\n\n## Related\n`); }
    // 60 summaries: 40 messy in known ways, 20 clean.
    const expected = new Map(); // rel → { dup, toC, toE }
    for (let s = 0; s < 60; s++) {
      const e = ENTS.slice(s * 3, s * 3 + 3), c = CONS.slice(s * 9, s * 9 + 9);
      let body = `# Summary ${s}\n\n## Key Takeaways\n- [[${c[0]}]] point\n- [[${c[0]}]] point\n\n`;
      if (s < 40) {
        // messy: 2 concepts in Entities (one also already in Concepts), 1 entity in Concepts, 1 identical dup.
        body += `## Concepts Introduced or Referenced\n- [[${c[0]}]]\n- [[${e[2]}]]\n\n`;
        body += `## Entities Mentioned\n- [[${e[0]}]]\n- [[${e[0]}]]\n- [[${e[1]}]]\n- [[${c[0]}]]\n- [[${c[1]}]] — described\n\n## Notes\nn\n`;
        expected.set(`summaries/s-${s}.md`, { dup: 2, toC: 2, toE: 1 });
      } else {
        body += `## Concepts Introduced or Referenced\n- [[${c[0]}]]\n\n## Entities Mentioned\n- [[${e[0]}]]\n\n## Notes\nn\n`;
      }
      D.put(`summaries/s-${s}.md`, body);
    }
    const before = readTree(D.wiki);
    const scan = await get('/api/health/big');
    const rows = scan.body.summaryLinkSections;
    ok(scan.status === 200 && Array.isArray(rows), '7.1 GET scan returns a summaryLinkSections array', scan.status);
    ok(rows.length === expected.size && rows.every(r => expected.has(r.summary)),
      `7.2 one row per messy summary, matching the fixture's own count (${rows.length} vs ${expected.size})`);
    ok(rows.every(r => { const x = expected.get(r.summary); return x && r.duplicateLines === x.dup && r.conceptsToMove === x.toC && r.entitiesToMove === x.toE; }),
      '7.3 each row\'s counts equal the fixture\'s construction (2 repeated, 2 concepts to move, 1 entity to move)', JSON.stringify(rows[0]));
    ok(rows.every(r => Array.isArray(r.sampleConcepts) && r.sampleConcepts.length === 2 && r.sampleEntities.length === 1), '7.4 rows carry samples');
    ok(hs.countOpenIssues(scan.body) >= rows.length && hs.HEALTH_ISSUE_KEYS.includes('summaryLinkSections'),
      '7.5 HEALTH_ISSUE_KEYS includes summaryLinkSections, so the stored health mark counts it');

    const one = await post('/api/health/big/fix', { type: 'summaryLinkSections', issue: { summary: rows[0].summary } });
    ok(one.status === 200 && one.body.fixed === 1, '7.6 POST /fix tidies one summary', JSON.stringify(one.body));
    const again = await post('/api/health/big/fix', { type: 'summaryLinkSections', issue: { summary: rows[0].summary } });
    ok(again.body.fixed === 0 && again.body.reason === 'already-tidy', '7.7 …a second /fix of it reports already-tidy', JSON.stringify(again.body));
    const bad = await post('/api/health/big/fix', { type: 'summaryLinkSections', issue: { summary: 'entities/ent-1.md' } });
    ok(bad.body.fixed === 0 && bad.body.reason === 'summary-invalid', '7.8 a non-summary path is refused (summary-invalid)', JSON.stringify(bad.body));
    const gone = await post('/api/health/big/fix', { type: 'summaryLinkSections', issue: { summary: 'summaries/nope.md' } });
    ok(gone.body.fixed === 0 && gone.body.reason === 'summary-not-found', '7.9 a missing summary is refused (summary-not-found)', JSON.stringify(gone.body));

    const t0 = Date.now();
    const all = await post('/api/health/big/fix-all', { type: 'summaryLinkSections' });
    const fixAllMs = Date.now() - t0;
    ok(all.status === 200 && all.body.fixed === expected.size - 1 && all.body.total === expected.size - 1,
      `7.10 POST /fix-all tidies the rest (${all.body.fixed}/${all.body.total}, ${fixAllMs} ms)`, JSON.stringify(all.body));
    const after = readTree(D.wiki);
    let linkDiff = 0, otherChanged = 0, summariesChanged = 0;
    for (const [rel, b] of before) {
      const a = after.get(rel);
      if (linkSetOf(a) !== linkSetOf(b)) linkDiff++;
      if (a !== b) { if (rel.startsWith('summaries/')) summariesChanged++; else otherChanged++; }
    }
    ok(after.size === before.size && linkDiff === 0, `7.11 every page's link set is unchanged (${linkDiff} differ)`);
    ok(otherChanged === 0 && summariesChanged === expected.size, `7.12 only the messy summaries changed (${summariesChanged}; non-summary pages changed: ${otherChanged})`);
    const sample = after.get('summaries/s-0.md');
    ok(sample.includes('- [[con-0]] point\n- [[con-0]] point'), '7.13 Key Takeaways untouched on disk');
    const rescan = await get('/api/health/big');
    ok(rescan.body.summaryLinkSections.length === 0, '7.14 rescan WITH the cache on is clean (the fix changed the signature)');
    const idem = await post('/api/health/big/fix-all', { type: 'summaryLinkSections' });
    ok(idem.body.fixed === 0 && idem.body.total === 0, '7.15 a second fix-all finds nothing (idempotent)');

    // fix-all-safe includes it
    const D2 = mkDomain('safe');
    D2.put('entities/a.md', '# A\n\n## Related\n- [[summaries/x]] — X\n');
    D2.put('concepts/b.md', '# B\n\n## Related\n- [[summaries/x]] — X\n');
    D2.put('summaries/x.md', '# X\n\n## Entities Mentioned\n- [[a]]\n- [[b]]\n- [[a]]\n');
    const safe = await post('/api/health/safe/fix-all-safe', {});
    ok(safe.status === 200 && safe.body.byType.summaryLinkSections && safe.body.byType.summaryLinkSections.fixed === 1,
      '7.16 "Fix N safe issues" includes summaryLinkSections', JSON.stringify(safe.body.byType));
    ok(bulletsUnder(D2.read('summaries/x.md'), C).includes('- [[b]]'), '7.17 …and the concept moved on disk');

    // Mirror: skipped + refused
    const M = mkDomain('shared-mirror', '---\nreadonly: true\n---\n# Domain: Mirror\n');
    M.put('entities/a.md', '# A\n');
    M.put('concepts/b.md', '# B\n');
    const MIRROR_BODY = '# X\n\n## Entities Mentioned\n- [[a]]\n- [[b]]\n- [[a]]\n';
    M.put('summaries/x.md', MIRROR_BODY);
    const ms = await get('/api/health/shared-mirror');
    ok(Array.isArray(ms.body.summaryLinkSections) && ms.body.summaryLinkSections.length === 0, '7.18 a read-only mirror reports no summaryLinkSections row');
    const mf = await post('/api/health/shared-mirror/fix', { type: 'summaryLinkSections', issue: { summary: 'summaries/x.md' } });
    const mfa = await post('/api/health/shared-mirror/fix-all', { type: 'summaryLinkSections' });
    ok(mf.status === 400 && mfa.status === 400 && M.read('summaries/x.md') === MIRROR_BODY, '7.19 /fix and /fix-all on a mirror are refused (400), nothing written', `${mf.status} ${mfa.status}`);
    const dis = await post('/api/health/big/dismiss', { type: 'summaryLinkSections', issue: { summary: 'summaries/s-0.md' } });
    ok(dis.status === 400, '7.20 NOT dismissible — a fix row, not review-only (400)', dis.status);
  } finally {
    await new Promise((r) => server.close(r));
  }

  // ══════════════════════════════════════════════════════════════════════
  section('§8 MCP');
  {
    const D = mkDomain('mcpd');
    D.put('entities/a.md', '# A\n');
    D.put('concepts/b.md', '# B\n');
    D.put('summaries/x.md', '# X\n\n## Entities Mentioned\n- [[a]]\n- [[b]]\n');
    const storage = { listDomains: async () => readdirSync(DOMAINS), appendToWriteAudit: async () => {} };
    const sc = await mcpHealth.scanWikiHealthHandler({ domain: 'mcpd' }, storage);
    ok(sc.ok && sc.summaryLinkSections.length === 1 && sc.counts.auto_fixable >= 1 && sc.counts.total_issues >= 1,
      '8.1 scan_wiki_health returns the row and counts it as auto-fixable', JSON.stringify(sc.counts));
    ok(mcpHealth.fixWikiIssueDefinition.inputSchema.properties.type.enum.includes('summaryLinkSections')
      && /summaryLinkSections/.test(mcpHealth.fixWikiIssueDefinition.description)
      && /summaryLinkSections/.test(mcpHealth.scanWikiHealthDefinition.description),
      '8.2 both tool descriptions and the enum name it');
    const fx = await mcpHealth.fixWikiIssueHandler({ domain: 'mcpd', type: 'summaryLinkSections', issue: sc.summaryLinkSections[0] }, storage);
    ok(fx.ok && fx.fixed === 1 && bulletsUnder(D.read('summaries/x.md'), C).includes('- [[b]]'), '8.3 fix_wiki_issue applies the scan row passed through unchanged', JSON.stringify(fx));
    const fx2 = await mcpHealth.fixWikiIssueHandler({ domain: 'mcpd', type: 'summaryLinkSections', issue: sc.summaryLinkSections[0] }, storage);
    ok(fx2.fixed === 0 && fx2.reason === 'already-tidy' && /already resolved/.test(fx2.report), '8.4 …again: already-tidy, with an honest report');
    const md = readFileSync(new URL('../skills/my-curator/maintenance.md', import.meta.url), 'utf8');
    ok(/summaryLinkSections/.test(md) && /link-guard/.test(md), '8.5 skills/my-curator/maintenance.md documents it (the second canonical source)');
  }
} catch (err) {
  loud();
  ok(false, 'unexpected throw', err && (err.stack || err.message));
} finally {
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
if (failed) { console.log('\nFailures:'); for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
console.log('\nAll summary-link-sections tests green.');
