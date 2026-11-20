#!/usr/bin/env node
/**
 * scripts/test-health-merge-link-forms.js — OFFLINE
 *
 * A Health merge deletes a page; every link to it, in EVERY form a foreign vault
 * writes, must then name the kept page (2026-11-14, src/brain/health-links.js).
 *
 * Before this, only `[[x]]` and `[[x|alias]]` were repointed. Left pointing at the
 * deleted page were: `[[x#Heading]]`, `[[x#^block]]`, `[[x#Heading|alias]]`,
 * `![[x]]` with an anchor, `[[x.md]]`, markdown links `[t](x.md)` and
 * `[t](../folder/x.md#anchor)` (encoded spaces, angle brackets, titles),
 * reference definitions, and an Obsidian canvas's file nodes and text cards.
 *
 * Every merge path is driven for real (fixIssue for one pair, cross-folder and
 * hyphen merges, the batch, the MCP's fix_wiki_issue), and each linking file is
 * compared BYTE FOR BYTE with the text it must become: a form that is not
 * repointed, or a line that is touched and should not be (code fences, inline
 * code, URLs, a different page of a similar name, frontmatter outside its links,
 * `.obsidian`, `.trash`), fails here. The real scanWiki is the second oracle (no
 * new broken link), and Undo must put every file back byte for byte.
 *
 * Synthetic fixtures only; isolated domains and user data; never the real wiki.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-link-forms-'));
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
const undo = await import(pathToFileURL(path.join(REPO, 'src/brain/health-undo.js')).href);
const links = await import(pathToFileURL(path.join(REPO, 'src/brain/health-links.js')).href);
const { fenceRuns } = await import(pathToFileURL(path.join(REPO, 'src/brain/files.js')).href);
const dc = await import(pathToFileURL(path.join(REPO, 'src/brain/duplicate-checks.js')).href);

let passed = 0, failed = 0;
function ok(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 1600)}` : ''}`); }
}
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`);

let seq = 0;
function mkDomain(files) {
  const name = 'lf' + (++seq);
  const wiki = path.join(DOMAINS, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(wiki, rel)), { recursive: true });
    writeFileSync(path.join(wiki, rel), body);
  }
  return { name, wiki };
}
const read = (d, rel) => readFileSync(path.join(d.wiki, rel), 'utf8');

/** Every file under the wiki (dot-folders too), rel → sha, so a tree compares exactly. */
function tree(wiki) {
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(wiki, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(wiki);
  return out;
}

const page = (title, type, body = '') =>
  `---\ntype: ${type}\ntags: [type/${type}]\n---\n# ${title}\n\n## Key Facts\n- a fact about ${title} ^fact-${title.toLowerCase().replace(/\W+/g, '')}\n\n${body}`;

/**
 * The lines a linking page holds, for a target written five ways: `w` the wikilink
 * name, `pf` the folder-prefixed wikilink, `r` the path relative to the linking page,
 * `p` the path from the wiki's root, `b` the bare file name.
 */
function linkLines(t) {
  return [
    `- [[${t.w}]] plain`,
    `- [[${t.w}|Alias]] alias`,
    `- [[${t.w}#Key Facts]] heading`,
    `- [[${t.w}#^blk1]] block`,
    `- [[${t.w}#Key Facts|Alias]] heading and alias`,
    `- [[${t.w}#Gone Heading]] a heading no page has`,
    `- ![[${t.w}]] embed`,
    `- ![[${t.w}#Key Facts]] embedded section`,
    `- [[${t.pf}]] folder prefix`,
    `- [[${t.w}.md]] with extension`,
    `- [a](${t.r}) relative`,
    `- [b](${t.r}#key-facts) relative with anchor`,
    `- [c](${t.r} "A title") with a title`,
    `- ![img](${t.r}) embedded markdown link`,
    `- [d](${t.p}) from the root`,
    `- [e](${t.b}) bare file name`,
    `- [f](<${t.r}>) angle brackets`,
    `- prose with [[${t.w}]] and [g](${t.r}#Gone%20Heading) inside a sentence`,
    '',
    `[ref]: ${t.r}#Key%20Facts`,
  ].join('\n');
}
/** Lines that name the old page and must never change. */
function stayLines(old) {
  return [
    `- \`[[${old}]]\` inline code`,
    `- \`\`a \`[[${old}]]\` in double backticks\`\` stays`,
    `- [u](https://example.com/${old}.md) a URL`,
    `- [[${old}-older]] a different page`,
    `- [[summaries/${old}]] another folder's page`,
    '',
    '```',
    `[[${old}]] in a fence`,
    `[x](${old}.md)`,
    '```',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. One pair (semanticDupe): every form, every folder, canvas, frontmatter');
{
  const front = (w) => `---\ntype: concept\nrelated: "[[${w}]]"\nup: [[${w}#Key Facts]]\nlist: ["[[${w}]]", "[[other]]"]\ncreated: 2026-01-02\n---\n`;
  const at = (fromDir, w) => ({
    w, pf: `entities/${w}`,
    r: path.posix.relative(fromDir, `entities/${w}.md`),
    p: `entities/${w}.md`, b: `${w}.md`,
  });
  const linker = (fromDir, w, old) => `${linkLines(at(fromDir, w))}\n\n${stayLines(old)}\n`;
  const canvas = (file, text) => JSON.stringify({ nodes: [
    { id: 'a', type: 'file', file, subpath: '#Key Facts', x: 0, y: 0, width: 400, height: 400 },
    { id: 'b', type: 'text', text, x: 500, y: 0, width: 200, height: 100 },
    { id: 'c', type: 'file', file: 'concepts/other.md', x: 0, y: 500 },
  ], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] }, null, '\t');
  const before = {
    'entities/alpha.md': page('Alpha', 'entity', '## Related\n- [[alpha-old]] its duplicate\n'),
    'entities/alpha-old.md': page('Alpha Old', 'entity', '## History\nOnce. ^blk1\n'),
    'entities/alpha-old-older.md': page('Alpha Old Older', 'entity'),
    'concepts/other.md': page('Other', 'concept'),
    'concepts/linker.md': front('alpha-old') + '# Linker\n\n' + linker('concepts', 'alpha-old', 'alpha-old'),
    'summaries/sum.md': '---\ntype: summary\n---\n# Sum\n\n' + linker('summaries', 'alpha-old', 'alpha-old'),
    'Notes/Deep/note.md': '# A note outside the wiki folders\n\n' + linker('Notes/Deep', 'alpha-old', 'alpha-old'),
    'root-note.md': linker('.', 'alpha-old', 'alpha-old'),
    'board.canvas': canvas('entities/alpha-old.md', 'A card: [[alpha-old#Key Facts]] and `[[alpha-old]]`'),
    'Boards/vault-root.canvas': canvas('wiki/entities/alpha-old.md', '[[alpha-old]]'),
    '.obsidian/workspace.md': '[[alpha-old]] [a](entities/alpha-old.md)\n',
    '.trash/old.md': '[[alpha-old]]\n',
  };
  const d = mkDomain(before);
  const treeBefore = tree(d.wiki);
  const brokenBefore = (await health.scanWiki(d.name, { noCache: true })).brokenLinks.length;

  const issue = { keepSlug: 'alpha', keepFolder: 'entities', removeSlug: 'alpha-old', removeFolder: 'entities' };
  const preview = await health.previewSemanticDuplicateMerge(d.name, issue);
  const r = await health.fixIssue(d.name, 'semanticDupe', issue);
  ok(r.fixed === 1, '1.0 the merge ran', JSON.stringify(r));
  ok(!existsSync(path.join(d.wiki, 'entities/alpha-old.md')), '1.0b the removed page is gone');

  const expect = {
    'concepts/linker.md': front('alpha') + '# Linker\n\n' + linker('concepts', 'alpha', 'alpha-old').replace('- [[entities/alpha]] folder prefix', '- [[alpha]] folder prefix'),
    'summaries/sum.md': '---\ntype: summary\n---\n# Sum\n\n' + linker('summaries', 'alpha', 'alpha-old').replace('- [[entities/alpha]] folder prefix', '- [[alpha]] folder prefix'),
    'Notes/Deep/note.md': '# A note outside the wiki folders\n\n' + linker('Notes/Deep', 'alpha', 'alpha-old').replace('- [[entities/alpha]] folder prefix', '- [[alpha]] folder prefix'),
    'root-note.md': linker('.', 'alpha', 'alpha-old').replace('- [[entities/alpha]] folder prefix', '- [[alpha]] folder prefix'),
    'board.canvas': canvas('entities/alpha.md', 'A card: [[alpha#Key Facts]] and `[[alpha-old]]`'),
    'Boards/vault-root.canvas': canvas('wiki/entities/alpha.md', '[[alpha]]'),
  };
  for (const [rel, want] of Object.entries(expect)) {
    const got = read(d, rel);
    const diff = got.split('\n').map((l, i) => (l === want.split('\n')[i] ? null : `got  ${l}\n      want ${want.split('\n')[i]}`)).filter(Boolean);
    ok(got === want, `1.1 ${rel}: every form repointed, nothing else touched`, diff.slice(0, 6).join('\n      '));
  }
  ok(read(d, '.obsidian/workspace.md') === before['.obsidian/workspace.md'] && read(d, '.trash/old.md') === before['.trash/old.md'],
    '1.2 .obsidian and .trash are never edited');
  ok(read(d, 'entities/alpha-old-older.md') === before['entities/alpha-old-older.md'], '1.3 a page of a similar name is untouched');
  const kept = read(d, 'entities/alpha.md');
  ok(kept.includes('## Merged from alpha-old') && /\^blk1\s*$/m.test(kept) && /^#{2,6} History$/m.test(kept),
    '1.4 the removed page\'s heading and block id now live on the kept page', kept.slice(-300));
  ok(!/\[\[alpha-old\]\]/.test(kept.replace(/`[^`]*`/g, '')), '1.4b the kept page\'s own link to its duplicate is repointed too');

  // Fourteen repointable lines per linking page and three by the scan's count of
  // anchors; the count the merge reports is the count the preview promised.
  ok(r.links && r.links.links === preview.totalLinksRewritten,
    '1.5 the merge repointed exactly as many links as the preview said', JSON.stringify({ links: r.links, preview: preview.totalLinksRewritten }));
  ok(r.links && r.links.files === preview.affectedCount,
    '1.6 …in as many files', JSON.stringify({ files: r.links && r.links.files, preview: preview.affectedCount }));
  // `#Gone Heading` (wikilink) and `#Gone%20Heading` (markdown) on each of 4 pages: 8.
  ok(r.links && r.links.anchorsUnresolved === 8,
    '1.7 the outcome counts the anchors the kept page shows nothing for (8: two per linking page)', JSON.stringify(r.links));
  ok(r.links && r.links.anchors > r.links.anchorsUnresolved, '1.8 …and only those: Key Facts, ^blk1 and the canvas subpath resolve');

  const after = await health.scanWiki(d.name, { noCache: true });
  // The scan and the merge share one idea of code (health-links.js codeSegments): a
  // link written as code is neither counted nor rewritten, so none is left behind.
  const toOld = after.brokenLinks.filter((b) => /^(entities\/)?alpha-old$/.test(b.linkText));
  ok(toOld.length === 0, '1.9 the real scan sees no link to the deleted page', JSON.stringify(toOld.map((b) => b.sourceFile)));
  ok(after.brokenLinks.length <= brokenBefore, '1.10 and no broken link more than before', `${brokenBefore} → ${after.brokenLinks.length}`);

  // Undo: every file back, byte for byte, the canvases included.
  const changes = await undo.listHealthChanges(d.name);
  ok(changes.length === 1 && changes[0].pageList.includes('board.canvas') && changes[0].pageList.includes('Notes/Deep/note'),
    '1.11 Recent changes lists the canvas and the note outside the wiki folders', JSON.stringify(changes[0] && changes[0].pageList));
  await undo.undoHealthChange(d.name, changes[0].id);
  const restored = tree(d.wiki);
  const differ = Object.keys({ ...treeBefore, ...restored }).filter((k) => treeBefore[k] !== restored[k]);
  ok(differ.length === 0, '1.12 Undo puts the whole tree back byte for byte', differ.join(', '));
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. Names with spaces: encoded and angle-bracket markdown links');
{
  const d = mkDomain({
    'entities/New Name.md': page('New Name', 'entity'),
    'entities/Old Name.md': page('Old Name', 'entity', '## More\nText. ^blk1\n'),
    'concepts/c.md': '# C\n\n- [a](../entities/Old%20Name.md#Key%20Facts)\n- [b](<../entities/Old Name.md>)\n- [[Old Name#^blk1]]\n- [c](Old%20Name.md)\n',
    'map.canvas': '{"nodes":[{"id":"1","type":"file","file":"entities/Old Name.md","x":0,"y":0}],"edges":[]}',
  });
  const r = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'New Name', keepFolder: 'entities', removeSlug: 'Old Name', removeFolder: 'entities' });
  ok(r.fixed === 1, '2.0 the merge ran', JSON.stringify(r));
  ok(read(d, 'concepts/c.md') === '# C\n\n- [a](../entities/New%20Name.md#Key%20Facts)\n- [b](<../entities/New Name.md>)\n- [[New Name#^blk1]]\n- [c](New%20Name.md)\n',
    '2.1 the encoded link stays encoded, the angle link stays in angle brackets', read(d, 'concepts/c.md'));
  ok(read(d, 'map.canvas') === '{"nodes":[{"id":"1","type":"file","file":"entities/New Name.md","x":0,"y":0}],"edges":[]}',
    '2.2 a compact canvas keeps its layout byte for byte, its file field repointed', read(d, 'map.canvas'));
  ok(r.links.anchorsUnresolved === 0, '2.3 Key Facts and ^blk1 both resolve on the kept page', JSON.stringify(r.links));
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. Same name in two folders (crossFolderDupes): the folder forms');
{
  const d = mkDomain({
    'entities/gamma.md': page('Gamma', 'entity'),
    'concepts/gamma.md': page('Gamma', 'concept', '## Theory\nText. ^t1\n'),
    'summaries/s.md': '# S\n\n- [[gamma]] bare\n- [[concepts/gamma#Theory]] prefixed with heading\n- [[concepts/gamma|G]] prefixed alias\n- [t](../concepts/gamma.md#^t1) markdown\n- [u](../entities/gamma.md) already the kept one\n',
    'g.canvas': JSON.stringify({ nodes: [{ id: '1', type: 'file', file: 'concepts/gamma.md' }], edges: [] }),
  });
  const r = await health.fixIssue(d.name, 'crossFolderDupes', { keep: 'entities/gamma.md', remove: 'concepts/gamma.md' });
  ok(r.fixed === 1, '3.0 the merge ran', JSON.stringify(r));
  ok(read(d, 'summaries/s.md') === '# S\n\n- [[gamma]] bare\n- [[gamma#Theory]] prefixed with heading\n- [[gamma|G]] prefixed alias\n- [t](../entities/gamma.md#^t1) markdown\n- [u](../entities/gamma.md) already the kept one\n',
    '3.1 the concepts/ forms name the kept page; the bare form already did', read(d, 'summaries/s.md'));
  ok(JSON.parse(read(d, 'g.canvas')).nodes[0].file === 'entities/gamma.md', '3.2 the canvas file node follows');
  ok(r.links.anchorsUnresolved === 0, '3.3 Theory and ^t1 moved with the text', JSON.stringify(r.links));
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. Nearly the same name (hyphenVariants)');
{
  const d = mkDomain({
    'entities/tali-rezun.md': page('Tali Rezun', 'entity'),
    'entities/dr-tali-rezun.md': page('Dr Tali Rezun', 'entity'),
    'concepts/c.md': '# C\n\n- [[dr-tali-rezun#Key Facts|Dr]]\n- ![[dr-tali-rezun]]\n- [x](../entities/dr-tali-rezun.md)\n- `[[dr-tali-rezun]]`\n',
  });
  const r = await health.fixIssue(d.name, 'hyphenVariants', { files: ['tali-rezun', 'dr-tali-rezun'], suggestedSlug: 'tali-rezun' });
  ok(r.fixed === 1, '4.0 the merge ran', JSON.stringify(r));
  ok(read(d, 'concepts/c.md') === '# C\n\n- [[tali-rezun#Key Facts|Dr]]\n- ![[tali-rezun]]\n- [x](../entities/tali-rezun.md)\n- `[[dr-tali-rezun]]`\n',
    '4.1 every form repointed, inline code left alone', read(d, 'concepts/c.md'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. The batch of spelling variants');
{
  const d = mkDomain({
    'entities/hand-off.md': page('Hand-off', 'entity'),
    'entities/handoff.md': page('Handoff', 'entity'),
    'concepts/c.md': '# C\n\n- [[handoff#Key Facts]]\n- [x](../entities/handoff.md)\n',
  });
  const open = (rel) => dc.pageOpening(read(d, rel + '.md'));
  await dc.saveDuplicateChecks(d.name, new Map([[dc.pairKey('entities', 'hand-off', 'entities', 'handoff'), {
    provider: 'p', model: 'm', prompt: 'x', verdict: 'yes', confidence: 'high', keep: 'entities/hand-off', remove: 'entities/handoff', at: 'now',
    openings: dc.openingsHash('entities', 'hand-off', open('entities/hand-off'), 'entities', 'handoff', open('entities/handoff')),
  }]]));
  const res = await health.fixSemanticDuplicatesBatch(d.name, [{ keepSlug: 'hand-off', keepFolder: 'entities', removeSlug: 'handoff', removeFolder: 'entities' }]);
  ok(res.merged === 1, '5.0 the batch merged', JSON.stringify(res));
  ok(read(d, 'concepts/c.md') === '# C\n\n- [[hand-off#Key Facts]]\n- [x](../entities/hand-off.md)\n', '5.1 the batch repoints every form too', read(d, 'concepts/c.md'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. A link that reaches a DIFFERENT page of the same name is left alone');
{
  const d = mkDomain({
    'entities/delta.md': page('Delta (the company)', 'entity'),
    'concepts/delta.md': page('Delta', 'concept'),
    'concepts/delta-v.md': page('Delta V', 'concept'),
    'summaries/s.md': '# S\n\n- [[delta]] reaches entities/delta\n- [[concepts/delta#Key Facts]] the concept\n- [x](../concepts/delta.md) the concept\n- [y](../entities/delta.md) the company\n',
  });
  const r = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'delta-v', keepFolder: 'concepts', removeSlug: 'delta', removeFolder: 'concepts' });
  ok(r.fixed === 1, '6.0 the merge ran', JSON.stringify(r));
  ok(read(d, 'summaries/s.md') === '# S\n\n- [[delta]] reaches entities/delta\n- [[delta-v#Key Facts]] the concept\n- [x](../concepts/delta-v.md) the concept\n- [y](../entities/delta.md) the company\n',
    '6.1 a bare [[delta]] names the entity (the scan\'s order) and stays; the concept forms move', read(d, 'summaries/s.md'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. The MCP: fix_wiki_issue preview, then the merge, says what moved');
{
  const { fixWikiIssueHandler } = await import(pathToFileURL(path.join(REPO, 'mcp/tools/health.js')).href);
  const { createStorageAdapter } = await import(pathToFileURL(path.join(REPO, 'mcp/storage/local.js')).href);
  const storage = createStorageAdapter({ domainsPath: DOMAINS });
  const d = mkDomain({
    'entities/epsilon.md': page('Epsilon', 'entity'),
    'entities/epsilon-old.md': page('Epsilon Old', 'entity'),
    'concepts/c.md': '# C\n\n- [[epsilon-old#Nowhere]]\n- [x](../entities/epsilon-old.md)\n',
  });
  const issue = { keepSlug: 'epsilon', keepFolder: 'entities', removeSlug: 'epsilon-old', removeFolder: 'entities' };
  const pv = await fixWikiIssueHandler({ domain: d.name, type: 'semanticDupe', issue, preview: true }, storage);
  ok(pv.ok && pv.plan && pv.plan.totalLinksRewritten === 2, '7.0 the preview counts both forms', JSON.stringify(pv.plan && { t: pv.plan.totalLinksRewritten, a: pv.plan.affectedCount }));
  const done = await fixWikiIssueHandler({ domain: d.name, type: 'semanticDupe', issue }, storage);
  ok(done.fixed === 1, '7.1 the merge ran', JSON.stringify(done).slice(0, 300));
  ok(read(d, 'concepts/c.md') === '# C\n\n- [[epsilon#Nowhere]]\n- [x](../entities/epsilon.md)\n', '7.2 both forms repointed through the MCP');
  ok(/Repointed 2 links in 1 file/.test(done.report) && /1 of them names a heading or block the kept page does not show/.test(done.report),
    '7.3 the report says how many links moved and that one anchor may not resolve', done.report);
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. The pieces: code spans and anchors');
{
  const seg = (t) => links.codeSegments(t).map((s) => (s.code ? `<${s.text}>` : s.text)).join('');
  ok(seg('a `b` c') === 'a <`b`> c', '8.1 one backtick span');
  ok(seg('a ``b ` c`` d') === 'a <``b ` c``> d', '8.2 a double-backtick span holds a single backtick');
  ok(seg('a `b c') === 'a `b c', '8.3 an unclosed backtick is text');
  ok(seg('a `b\n\nc` d') === 'a `b\n\nc` d', '8.4 a span never crosses a blank line');
  ok(seg('| ` | x |\n| [[l]] | y |\n| ` | z |\n') === '| ` | x |\n| [[l]] | y |\n| ` | z |\n', '8.4b nor table rows');
  ok(seg('- a ` b\n- [[l]]\n- c ` d\n') === '- a ` b\n- [[l]]\n- c ` d\n', '8.4c nor list items');
  ok(seg('| `a|b` |\n') === '| `a|b` |\n', '8.4d nor a table cell');
  ok(seg('p\n\n    [[x]] code\n\nq') === 'p\n\n<    [[x]] code\n\n>q', '8.4e a 4-space indented block after a blank line is code');
  ok(seg('- item\n\n    [[x]] more of the item\n') === '- item\n\n    [[x]] more of the item\n', '8.4f but not the indented paragraph of a list item');
  ok(seg('---\na: `x\nb: [[y]]\n---\nz') === '---\na: `x\nb: [[y]]\n---\nz', '8.4g frontmatter is never code');
  ok(seg('a \\`b` c') === 'a \\`b` c', '8.5 an escaped backtick opens nothing');
  ok(seg('x\n```\n`y`\n```\nz `w`') === 'x\n<```\n`y`\n```\n>z <`w`>', '8.6 a fence is code as a whole');
  const pg = '# T\n\n## Key Facts\n### Merged Section Two\nline ^abc-1\n```\n## In A Fence\n```\n';
  ok(links.anchorResolves(pg, '#Key Facts', fenceRuns) && links.anchorResolves(pg, '#key-facts', fenceRuns) && links.anchorResolves(pg, '#Key%20Facts', fenceRuns),
    '8.7 a heading resolves as written, as a slug, or URL-encoded');
  ok(links.anchorResolves(pg, '#Merged Section Two', fenceRuns), '8.8 at any level (a moved heading drops one)');
  ok(links.anchorResolves(pg, '#^abc-1', fenceRuns) && !links.anchorResolves(pg, '#^abc', fenceRuns), '8.9 a block id resolves exactly');
  ok(!links.anchorResolves(pg, '#In A Fence', fenceRuns) && !links.anchorResolves(pg, '#Nope', fenceRuns), '8.10 a heading in a fence, or none, does not');
  ok(links.anchorResolves(pg, '#T#Key Facts', fenceRuns), '8.11 a heading path is judged by its last heading');
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. The audit\'s cases: code means one thing, and the forms it found');
{
  const d = mkDomain({
    'entities/hand-off.md': page('Hand-off', 'entity'),
    'entities/handoff.md': page('Handoff', 'entity'),
    'entities/hub.md': [
      '# Hub', '',
      'Write it as `[[handoff]]` in your notes.', '',
      '| key | meaning |', '|---|---|', '| ` | the backtick key |', '| [[handoff]] | a live link |', '| ` | again |', '',
      '- quote with a ` mark', '- see [[handoff]] and [doc](handoff.md)', '- another ` mark', '',
      '| a | b |', '|---|---|', '| [[handoff\\|the handoff]] | table alias |', '',
      '[[Handoff]] case · [n](handoff) no extension · https://example.com/a](handoff.md) a URL', '',
      '> [!note] A callout', '> [r]: handoff.md', '',
      '[^1]: handoff.md', '',
      '    [[handoff]] indented code', '',
      '- item', '', '    [[handoff]] the item goes on', '',
      '[[handoff|two', 'lines]]', '',
    ].join('\n'),
    'b.canvas': '{"nodes":[{"id":"1","type":"file","file":"entities/handoff.md"},{"id":"2","type":"file","file":"entities/Handoff.md"}],"edges":[{"id":"e","fromNode":"1","toNode":"2","text":"[[handoff]]","file":"entities/handoff.md"}],"meta":{"file":"entities/handoff.md"}}',
  });
  const scan0 = await health.scanWiki(d.name, { noCache: true });
  ok(!scan0.brokenLinks.some((b) => b.linkText.endsWith('\\')), '10.0 the scan reads a table alias `[[x\\|a]]` as a link to x', JSON.stringify(scan0.brokenLinks));
  const r = await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'hand-off', keepFolder: 'entities', removeSlug: 'handoff', removeFolder: 'entities' });
  ok(r.fixed === 1, '10.1 the merge ran', JSON.stringify(r));
  const hub = read(d, 'entities/hub.md');
  const has = (line, label) => ok(hub.split('\n').includes(line), label, hub);
  has('Write it as `[[handoff]]` in your notes.', '10.2 inline code is left alone…');
  const after = await health.scanWiki(d.name, { noCache: true });
  ok(after.brokenLinks.length === 0, '10.3 …and the scan does not count it, so nothing reads as broken', JSON.stringify(after.brokenLinks));
  has('| [[hand-off]] | a live link |', '10.4 a link between two stray backticks in a table is repointed');
  has('- see [[hand-off]] and [doc](hand-off.md)', '10.5 …and between two in a list');
  has('| [[hand-off\\|the handoff]] | table alias |', '10.6 a table alias keeps its backslash');
  has('[[hand-off]] case · [n](hand-off) no extension · https://example.com/a](handoff.md) a URL', '10.7 another case and no extension are repointed; a URL is not');
  has('> [r]: hand-off.md', '10.8 a reference definition in a callout is repointed');
  has('[^1]: handoff.md', '10.9 a footnote is not');
  has('    [[handoff]] indented code', '10.10 an indented code block is not');
  has('    [[hand-off]] the item goes on', '10.11 a list item\'s indented paragraph is');
  ok(hub.includes('[[hand-off|two\nlines]]'), '10.12 an alias over two lines is repointed');
  const canvas = JSON.parse(read(d, 'b.canvas'));
  ok(canvas.nodes[0].file === 'entities/hand-off.md' && canvas.nodes[1].file === 'entities/hand-off.md', '10.13 canvas file nodes, any case, follow');
  ok(canvas.edges[0].text === '[[handoff]]' && canvas.edges[0].file === 'entities/handoff.md' && canvas.meta.file === 'entities/handoff.md',
    '10.14 an edge and the canvas metadata are not nodes, and keep every byte', read(d, 'b.canvas'));
}
{
  // The free repair goes where the scan points and nowhere else: never inside code.
  const d = mkDomain({
    'entities/email.md': page('Email', 'entity'),
    'concepts/c.md': '# C\n\n- [[e-mail]] live\n- `[[e-mail]]` code\n\n| [[e-mail\\|mail]] |\n',
  });
  const scan = await health.scanWiki(d.name, { noCache: true });
  ok(scan.brokenLinks.length === 2 && scan.brokenLinks.every((b) => b.suggestedTarget === 'email'), '10.15 the scan sees the two live links, with a target', JSON.stringify(scan.brokenLinks));
  await health.fixIssue(d.name, 'brokenLinks', null);
  ok(read(d, 'concepts/c.md') === '# C\n\n- [[email]] live\n- `[[e-mail]]` code\n\n| [[email\\|mail]] |\n', '10.16 Fix broken links repairs both and leaves the code alone', read(d, 'concepts/c.md'));
}
{
  // The new link must reach the kept page: concepts/bar is kept while entities/bar exists.
  const d = mkDomain({
    'entities/foo.md': page('Foo', 'entity'), 'concepts/bar.md': page('Bar', 'concept'), 'entities/bar.md': page('Bar E', 'entity'),
    'entities/l.md': '# L\n\n- [[foo]]\n- [a](foo.md)\n',
  });
  await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'bar', keepFolder: 'concepts', removeSlug: 'foo', removeFolder: 'entities' });
  ok(read(d, 'entities/l.md') === '# L\n\n- [[concepts/bar]]\n- [a](../concepts/bar.md)\n', '10.17 a bare [[bar]] would reach entities/bar, so the link names its folder', read(d, 'entities/l.md'));
  const scan = await health.scanWiki(d.name, { noCache: true });
  ok(scan.folderPrefixLinks.length === 0, '10.18 …and the scan does not call that folder name a mistake', JSON.stringify(scan.folderPrefixLinks));
}

// ═══════════════════════════════════════════════════════════════════════════
section('11. The re-audit\'s cases');
{
  const d = mkDomain({
    'entities/hand-off.md': page('Hand-off', 'entity'),
    'entities/handoff.md': page('Handoff', 'entity'),
    'entities/hub.md': [
      '# Hub', '',
      'Alias with code: [[handoff|`hand off`]] here.', '',
      'Code link text: [`handoff`](handoff.md) done.', '',
      '[Note]: handoff happens at night', '[Q]: handoff', '[N2]: handoff.md is where it lives', '', '[real]: handoff.md "Title"', '',
      '# Heading with ` tick', '[[handoff]] after heading `', '',
      '> quote `code [[handoff]]', '> still code` and [[handoff]] live', '',
    ].join('\n'),
  });
  const s0 = await health.scanWiki(d.name, { noCache: true });
  await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'hand-off', keepFolder: 'entities', removeSlug: 'handoff', removeFolder: 'entities' });
  const s1 = await health.scanWiki(d.name, { noCache: true });
  const hub = read(d, 'entities/hub.md');
  const has = (line, label) => ok(hub.split('\n').includes(line), label, hub);
  ok(s1.brokenLinks.length <= s0.brokenLinks.length && s1.brokenLinks.length === 0, '11.0 nothing reads as broken after the merge', JSON.stringify(s1.brokenLinks));
  has('Alias with code: [[hand-off|`hand off`]] here.', '11.1 a link whose alias holds code is a link, repointed, its code kept');
  has('Code link text: [`handoff`](hand-off.md) done.', '11.2 a markdown link whose text is code is repointed, its code kept');
  has('[Note]: handoff happens at night', '11.3 a sentence after `[Note]:` is prose, never a destination');
  has('[Q]: handoff', '11.4 a definition with no .md is left alone');
  has('[N2]: handoff.md is where it lives', '11.4b nor one followed by words');
  has('[real]: hand-off.md "Title"', '11.5 a real definition is repointed, its title kept');
  has('[[hand-off]] after heading `', '11.6 a heading is one line: its backtick opens nothing on the next');
  has('> quote `code [[handoff]]', '11.7 a code span over two quote lines is code…');
  has('> still code` and [[hand-off]] live', '11.8 …and the link after it is repointed');
}
{
  // Another case: one loose match ACROSS all folders, or none.
  const d = mkDomain({
    'entities/hand-off.md': page('Hand-off', 'entity'),
    'entities/handoff.md': page('Handoff', 'entity'),
    'concepts/Handoff.md': page('Another Handoff', 'concept'),
    'summaries/s.md': '# S\n\n- [[HANDOFF]] two pages have this name loosely\n- [[handoff]] exact\n',
  });
  await health.fixIssue(d.name, 'semanticDupe', { keepSlug: 'hand-off', keepFolder: 'entities', removeSlug: 'handoff', removeFolder: 'entities' });
  ok(read(d, 'summaries/s.md') === '# S\n\n- [[HANDOFF]] two pages have this name loosely\n- [[hand-off]] exact\n',
    '11.9 a loose name two folders share reaches neither, and stays', read(d, 'summaries/s.md'));
}
{
  // A later ingest's link tidy keeps the folder a merge wrote on purpose.
  const files = await import(pathToFileURL(path.join(REPO, 'src/brain/files.js')).href);
  const d = mkDomain({
    'concepts/bar.md': page('Bar', 'concept'), 'entities/bar.md': page('Bar E', 'entity'), 'concepts/baz.md': page('Baz', 'concept'),
    'entities/l.md': '# L\n\n- [[concepts/bar]] the concept\n- [[concepts/baz]] a plain prefix\n- [[entities/bar]] the entity\n',
  });
  await files.tidyWrittenLinks(d.name, ['entities/l.md']);
  ok(read(d, 'entities/l.md') === '# L\n\n- [[concepts/bar]] the concept\n- [[baz]] a plain prefix\n- [[bar]] the entity\n',
    '11.10 tidyWrittenLinks keeps [[concepts/bar]] beside an entity bar, and strips the rest', read(d, 'entities/l.md'));
}

ok(fp(REAL_CONFIG) === CONFIG_BEFORE, '9. the real .curator-config.json is byte-identical');
console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
