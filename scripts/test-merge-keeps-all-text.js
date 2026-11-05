#!/usr/bin/env node
/**
 * scripts/test-merge-keeps-all-text.js — OFFLINE
 *
 * A merge that deletes a page must never lose text.
 *
 * ── THE DEFECT THIS PINS ──────────────────────────────────────────────────
 *
 * Every Health merge took the LONGER page as the base and copied only the other
 * page's `- ` bullets in eleven named sections. The shorter page's opening and
 * every non-bullet section vanished. If the removed page was longer, the kept
 * page's own title, frontmatter and prose vanished under the kept name.
 *
 * ── THE SHAPE OF THE PROOF ────────────────────────────────────────────────
 *
 * §1 is a hand-written fixed pair with the whole expected page typed out: the
 * dumb cross-check, which cannot share a bug with any generator.
 * §2 runs one generated corpus through the REAL exported paths: fixIssue for
 * each of the three handlers, fix-all, fixAllSafe, the batch, and the MCP's
 * fix_wiki_issue in a spawned server. The oracle walks raw lines and uses
 * nothing from page-merge.js.
 * §3 preview = the bytes on disk. §4 idempotence and no repetition. §5 Flip.
 * §6 refusals: the cross-check and the same-file guard. §7 a later ingest.
 * §8 named shapes and links. §9 real runs of the manual repair scripts.
 *
 * Isolation: __setDomainsDirOverride plus CURATOR_TEST_USER_DATA_DIR. Nothing
 * here reads a real domain, config or credential, and no provider is called.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'merge-text-'));
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = path.join(TMP, 'user-data');
mkdirSync(process.env.CURATOR_TEST_USER_DATA_DIR, { recursive: true });

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
__setDomainsDirOverride(DOMAINS);
const health = await import(path.join(REPO, 'src/brain/health.js'));
const { composeMergedPage, findLostLines } = await import(path.join(REPO, 'src/brain/page-merge.js'));
const { mergeWikiPage } = await import(path.join(REPO, 'src/brain/files.js'));
const dc = await import(path.join(REPO, 'src/brain/duplicate-checks.js'));

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ${name}${detail !== undefined ? '\n       ' + String(detail).slice(0, 900) : ''}`);
}
const section = (s) => console.log(`\n${s}`);

let seq = 0;
function mkDomain(files) {
  const name = 'm' + (++seq);
  const wiki = path.join(DOMAINS, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
  writeFileSync(path.join(DOMAINS, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of Object.entries(files)) writeFileSync(path.join(wiki, rel), body);
  return { name, wiki, read: (rel) => readFileSync(path.join(wiki, rel), 'utf8'), has: (rel) => existsSync(path.join(wiki, rel)) };
}
const pair = (keep, remove, kf = 'concepts', rf = 'concepts') =>
  ({ keepSlug: keep, keepFolder: kf, removeSlug: remove, removeFolder: rf });

// ── §1 The fixed pair, typed out by hand ────────────────────────────────────
section('§1 A hand-written pair, whole page compared');
{
  const KEEP = [
    '---', 'type: concept', 'tags: [type/concept, keep-tag]', 'created: 2026-01-01', '---',
    '# Data Privacy', '',
    'The kept opening, which is the shorter one.', '',
    '## Key Facts', '- A kept fact', '- [[alice]] founded it', '',
    '## History', 'Kept history prose.', '',
  ].join('\n');
  const REMOVE = [
    '---', 'type: concept', 'tags: [type/concept, remove-tag]', 'created: 2025-05-05', 'aliases: [privacy]', '---',
    '# Privacy and Data Protection', '',
    'The removed opening, which is much longer than the kept one, on purpose, so that the old rule would have made this page the base of the merge.', '',
    '## Key Facts', '- A removed fact', '- A kept fact', '- [[alice]] left in 2005', '',
    '## History', 'Removed history prose.', '',
    '## Enforcement', '| Who | What |', '|---|---|', '| EU | GDPR |', '',
    '```bash', '# a comment, not a heading', '## also not a heading', '- not a bullet', '```', '',
  ].join('\n');
  const EXPECTED = [
    '---', 'type: concept', 'tags: [type/concept, keep-tag, remove-tag]', 'created: 2026-01-01', 'aliases: [privacy]', '---',
    '# Data Privacy', '',
    'The kept opening, which is the shorter one.', '',
    '## Key Facts', '- A kept fact', '- [[alice]] founded it', '- A removed fact', '',
    '## History', 'Kept history prose.', '',
    '## Merged from privacy-and-data-protection', '',
    '### Privacy and Data Protection', '',
    'The removed opening, which is much longer than the kept one, on purpose, so that the old rule would have made this page the base of the merge.', '',
    '### Key Facts', '',
    '- [[alice]] left in 2005', '',
    '### History', '',
    'Removed history prose.', '',
    '### Enforcement', '',
    '| Who | What |', '|---|---|', '| EU | GDPR |', '',
    '```bash', '# a comment, not a heading', '## also not a heading', '- not a bullet', '```', '',
  ].join('\n');

  const d = mkDomain({ 'concepts/data-privacy.md': KEEP, 'concepts/privacy-and-data-protection.md': REMOVE });
  const r = await health.fixIssue(d.name, 'semanticDupe', pair('data-privacy', 'privacy-and-data-protection'));
  ok(r.fixed === 1, '1.1 the merge ran', JSON.stringify(r));
  ok(d.read('concepts/data-privacy.md') === EXPECTED, '1.2 the kept page is exactly the page typed out above', d.read('concepts/data-privacy.md'));
  ok(!d.has('concepts/privacy-and-data-protection.md'), '1.3 the removed file is gone');
  ok(readFileSync(path.join(d.wiki, 'concepts/data-privacy.md'), 'utf8').startsWith('---\ntype: concept\ntags: [type/concept, keep-tag, remove-tag]\ncreated: 2026-01-01'),
    '1.4 the kept page keeps its own created date');
}

// ── §2 The property test: every line survives, through every deleting path ──
section('§2 Generated pairs through every deleting path');

function rng(seed) {
  let x = seed >>> 0 || 1;
  return (n) => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
}

/** Lines are unique by marker, so "present" can only be true if that line survived. */
function genPage(r, tag, opts) {
  const m = () => `${tag}${opts.seed}x${opts.n++}`;
  const lines = [];
  const prefix = opts.long ? ' padded with words to make this the longer of the two pages by a clear margin' : '';
  const blocks = {
    prose: () => [`Prose ${m()}${prefix}.`, `A second line of it ${m()}.`],
    table: () => ['| Col A | Col B |', '|---|---|', `| ${m()} | ${m()} |`, `| ${m()} | ${m()} |`],
    fence: () => ['```js', `// ${m()}`, '', `# ${m()} not a heading`, `## ${m()} not a section`, `- ${m()} not a bullet`, '```'],
    tilde: () => ['~~~', `${m()} in a tilde fence`, '~~~'],
    bullets: () => [`- bullet ${m()}`, `- bullet ${m()} with [[third-page]]`, `- [[link${m()}]] — described ${m()}`],
    nested: () => [`- parent ${m()}`, `  - child ${m()}`, `    continued ${m()}`],
    ordered: () => [`1. ordered ${m()}`, `2. ordered ${m()}`],
    quote: () => [`> quoted ${m()}`],
    star: () => [`* star bullet ${m()}`],
  };
  const kinds = Object.keys(blocks);
  const body = () => {
    const out = [];
    const count = 1 + r(3);
    for (let i = 0; i < count; i++) out.push(...blocks[kinds[r(kinds.length)]](), '');
    return out;
  };

  if (opts.empty) return opts.whitespace ? '  \n\n' : '';
  if (r(4) !== 0) {
    const ft = r(3);
    lines.push('---', `type: ${opts.type}`);
    if (ft === 0) lines.push(`tags: [type/${opts.type}, tag-${m()}]`);
    if (ft === 1) lines.push('tags:', `  - tag-${m()}`, `  - tag-${m()}`);
    lines.push(`note-${tag}: ${m()}`, '---');
  }
  if (r(5) !== 0) lines.push(`# Title ${m()}`, '');
  if (r(3) !== 0) lines.push(...body());
  const SECTIONS = ['Key Facts', 'Related', 'Examples', 'Definition', `Only ${m()}`, 'History', 'Open Questions'];
  const sectionCount = opts.noSections ? 0 : r(5);
  for (let i = 0; i < sectionCount; i++) {
    lines.push(`## ${SECTIONS[r(SECTIONS.length)]}`, ...body());
    if (r(4) === 0) lines.push(`### Sub ${m()}`, ...body());
  }
  if (opts.long) for (let i = 0; i < 12; i++) lines.push(`Filler ${m()}${prefix}.`, '');
  let text = lines.join('\n');
  if (opts.crlf) text = text.replace(/\n/g, '\r\n');
  return text;
}

function genPair(seed) {
  const r = rng(seed * 2654435761);
  const opts = { seed, n: 0 };
  const shape = seed % 9;
  const keepLong = shape === 1;
  const removeLong = shape === 2;
  const keepEmpty = shape === 3;
  const removeEmpty = shape === 4;
  const keep = genPage(r, 'K', { ...opts, n: 1000, type: 'concept', long: keepLong, empty: keepEmpty, noSections: shape === 5, crlf: shape === 6 || shape === 8 });
  const remove = genPage(r, 'R', { ...opts, n: 2000, type: 'concept', long: removeLong, empty: removeEmpty, whitespace: seed % 2 === 0, noSections: shape === 7, crlf: shape === 6 });
  return { keep, remove };
}

/**
 * The oracle. Raw lines, trimmed, compared as whole lines. Knows no sections and
 * no fences. A heading may change level, but only outside a code fence, and
 * that is checked separately in §1 and §4.
 */
function missingLines(source, merged) {
  const out = [];
  const have = new Set(merged.split(/\r?\n/).map((l) => l.trim()));
  const haveNoHash = new Set([...have].map((l) => l.replace(/^#{1,6}\s+/, '')));
  let lines = source.split(/\r?\n/);
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) lines = [...lines.slice(1, close).filter((l) => !/^(type|tags):/.test(l) && !/^\s+- tag-/.test(l)), ...lines.slice(close + 1)];
  }
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (have.has(t)) continue;
    if (/^#{1,6}\s/.test(t) && haveNoHash.has(t.replace(/^#{1,6}\s+/, ''))) continue;
    out.push(t);
  }
  return out;
}
function missingTags(source, merged) {
  const fm = (t) => {
    const lines = t.split(/\r?\n/);
    if (lines[0] !== '---') return [];
    const close = lines.indexOf('---', 1);
    return close > 0 ? lines.slice(1, close) : [];
  };
  const tags = fm(source).join('\n').match(/tag-[A-Za-z0-9]+/g) || [];
  const target = fm(merged).join('\n');
  return tags.filter((t) => !target.includes(t));
}

function checkPair(label, seed, keepText, removeText, merged, removed) {
  const lostK = missingLines(keepText, merged);
  const lostR = missingLines(removeText, merged);
  const lostT = [...missingTags(keepText, merged), ...missingTags(removeText, merged)];
  ok(lostK.length === 0, `${label} seed ${seed}: every kept line survives`, JSON.stringify(lostK.slice(0, 3)));
  ok(lostR.length === 0, `${label} seed ${seed}: every removed line survives`, JSON.stringify(lostR.slice(0, 3)));
  ok(lostT.length === 0, `${label} seed ${seed}: tags are the union`, JSON.stringify(lostT.slice(0, 3)));
  ok(removed, `${label} seed ${seed}: the removed page is gone`);
  if (keepText.trim()) {
    // A kept page with no frontmatter may gain one (the union of tags needs a home).
    const bodyLines = (t) => {
      const ls = t.split(/\r?\n/);
      if (ls[0] !== '---') return ls.filter((l) => l.trim());
      return ls.slice(ls.indexOf('---', 1) + 1).filter((l) => l.trim());
    };
    if (bodyLines(keepText)[0]) {
      ok(bodyLines(merged)[0] === bodyLines(keepText)[0], `${label} seed ${seed}: the kept page still starts as itself`, merged.slice(0, 160));
    }
  }
  const fences = merged.split(/\r?\n/).filter((l) => /^(```|~~~)/.test(l)).length;
  ok(fences % 2 === 0, `${label} seed ${seed}: code fences stay balanced`, merged);
}

const SEEDS = 180;

// Pure composer plus cross-check over more shapes, including an unclosed fence.
for (let seed = 1; seed <= SEEDS; seed++) {
  const { keep, remove } = genPair(seed);
  const merged = composeMergedPage(keep, remove, { sourceLabel: 'old-page', keepFolder: 'concepts' });
  ok(findLostLines(keep, remove, merged).length === 0, `pure seed ${seed}: the cross-check agrees`, JSON.stringify(findLostLines(keep, remove, merged).slice(0, 2)));
  checkPair('pure', seed, keep, remove, merged, true);
}

// semanticDupe, single.
for (let seed = 1; seed <= 60; seed++) {
  const { keep, remove } = genPair(seed);
  const d = mkDomain({ 'concepts/keep-page.md': keep, 'concepts/old-page.md': remove });
  const r = await health.fixIssue(d.name, 'semanticDupe', pair('keep-page', 'old-page'));
  ok(r.fixed === 1, `semantic seed ${seed}: merged`, JSON.stringify(r));
  checkPair('semantic', seed, keep, remove, d.read('concepts/keep-page.md'), !d.has('concepts/old-page.md'));
}

// crossFolderDupes, single and through fixAllSafe. Kept in entities/, so the
// removed concept page's type must not leak.
for (let seed = 1; seed <= 30; seed++) {
  const { keep, remove } = genPair(seed + 500);
  const entityKeep = keep.replace(/type: concept/g, 'type: entity').replace(/type\/concept/g, 'type/entity');
  const d = mkDomain({ 'entities/acme.md': entityKeep, 'concepts/acme.md': remove });
  const report = await health.scanWiki(d.name);
  const issue = report.crossFolderDupes[0];
  ok(issue && issue.keep === 'entities/acme.md' && issue.remove === 'concepts/acme.md', `cross seed ${seed}: the scan offers it`, JSON.stringify(report.crossFolderDupes));
  const r = await health.fixIssue(d.name, 'crossFolderDupes', issue);
  ok(r.fixed === 1, `cross seed ${seed}: merged`, JSON.stringify(r));
  const merged = d.read('entities/acme.md');
  checkPair('cross', seed, entityKeep, remove, merged, !d.has('concepts/acme.md'));
  const fmEnd = merged.indexOf('\n---', 3);
  if (merged.startsWith('---') && fmEnd > 0) {
    ok(!/type: concept|type\/concept/.test(merged.slice(0, fmEnd)), `cross seed ${seed}: type follows the kept folder`, merged.slice(0, fmEnd));
  }
  if (seed === 1) ok(/## Merged from concepts\/acme/.test(merged) || !remove.trim(), 'cross: a same-slug merge names the folder too', merged);
}
for (let seed = 1; seed <= 15; seed++) {
  const { keep, remove } = genPair(seed + 700);
  const d = mkDomain({ 'entities/acme.md': keep.replace(/type: concept/g, 'type: entity'), 'concepts/acme.md': remove });
  await health.fixAllSafe(d.name);
  ok(!d.has('concepts/acme.md'), `fixAllSafe seed ${seed}: the concept page is gone`);
  const merged = d.read('entities/acme.md');
  ok(missingLines(remove, merged).filter((l) => !/\[\[/.test(l)).length === 0, `fixAllSafe seed ${seed}: the removed page's text survives`, JSON.stringify(missingLines(remove, merged).slice(0, 3)));
}

// hyphenVariants: two variants into one canonical, in one call and via fix-all.
for (let seed = 1; seed <= 30; seed++) {
  const a = genPair(seed + 900);
  const b = genPair(seed + 1300);
  const keep = a.keep.replace(/type: concept/g, 'type: entity');
  const d = mkDomain({ 'entities/tali-rezun.md': keep, 'entities/talirezun.md': a.remove, 'entities/dr-tali-rezun.md': b.remove });
  const report = await health.scanWiki(d.name);
  const issue = report.hyphenVariants[0];
  ok(issue && issue.suggestedSlug === 'tali-rezun', `hyphen seed ${seed}: the scan offers it`, JSON.stringify(report.hyphenVariants));
  const r = seed % 2 ? await health.fixIssue(d.name, 'hyphenVariants', issue) : await health.fixIssue(d.name, 'hyphenVariants');
  ok(r.fixed === 1, `hyphen seed ${seed}: merged`, JSON.stringify(r));
  const merged = d.read('entities/tali-rezun.md');
  checkPair('hyphen-1', seed, keep, a.remove, merged, !d.has('entities/talirezun.md'));
  checkPair('hyphen-2', seed, keep, b.remove, merged, !d.has('entities/dr-tali-rezun.md'));
}

// The batch: spelling variants with a remembered answer about the openings now.
{
  // Letters only: a plural of a stem ending in a digit is not a spelling variant.
  const stem = (n) => 'batch-page-' + String.fromCharCode(97 + (n % 26)) + String.fromCharCode(97 + ((n * 7) % 26)) + 'x';
  const entries = [];
  const files = {};
  for (let seed = 1; seed <= 26; seed++) {
    const { keep, remove } = genPair(seed + 1700);
    files[`concepts/${stem(seed)}.md`] = keep;
    files[`concepts/${stem(seed)}s.md`] = remove;
    entries.push({ seed, keep, remove });
  }
  const d = mkDomain(files);
  const memory = new Map();
  const list = [];
  for (const { seed, keep, remove } of entries) {
    const a = stem(seed);
    const b = `${stem(seed)}s`;
    memory.set(dc.pairKey('concepts', a, 'concepts', b), {
      provider: 'p', model: 'm', prompt: 'x', verdict: 'yes', confidence: 'high', keep: `concepts/${a}`, remove: `concepts/${b}`, at: 'now',
      openings: dc.openingsHash('concepts', a, dc.pageOpening(keep), 'concepts', b, dc.pageOpening(remove)),
    });
    list.push(pair(a, b));
  }
  await dc.saveDuplicateChecks(d.name, memory);
  const r = await health.fixSemanticDuplicatesBatch(d.name, list);
  ok(r.merged === list.length, `batch: all ${list.length} pairs merged`, JSON.stringify({ ...r, results: r.results.filter((x) => x.status !== 'merged').slice(0, 3) }));
  for (const { seed, keep, remove } of entries) {
    checkPair('batch', seed, keep, remove, d.read(`concepts/${stem(seed)}.md`), !d.has(`concepts/${stem(seed)}s.md`));
  }
}

// ── §2b The MCP's fix_wiki_issue, in a real spawned server ──────────────────
section('§2b The MCP fix_wiki_issue tool');
{
  const cases = [];
  const files = {};
  for (let seed = 1; seed <= 12; seed++) {
    const { keep, remove } = genPair(seed + 2100);
    files[`concepts/mcp-keep-${seed}.md`] = keep;
    files[`concepts/mcp-old-${seed}.md`] = remove;
    cases.push({ seed, keep, remove });
  }
  const crossKeep = '---\ntype: entity\ntags: [type/entity]\n---\n# Gamma\n\nKept gamma opening.\n';
  const crossRemove = '---\ntype: concept\ntags: [type/concept, gamma-tag]\n---\n# Gamma concept\n\nRemoved gamma opening.\n\n## Notes\nGamma notes.\n';
  files['entities/gamma.md'] = crossKeep;
  files['concepts/gamma.md'] = crossRemove;
  const hyphenKeep = '---\ntype: entity\ntags: [type/entity]\n---\n# Bob Ray\n\nKept bob opening.\n';
  const hyphenRemove = '---\ntype: entity\ntags: [type/entity]\n---\n# Bobray\n\nRemoved bob opening.\n';
  files['entities/bob-ray.md'] = hyphenKeep;
  files['entities/bobray.md'] = hyphenRemove;
  const d = mkDomain(files);

  const child = spawn(process.execPath, [path.join(REPO, 'mcp/server.js'), '--domains-path', DOMAINS], {
    env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_USER_DATA_DIR: process.env.CURATOR_TEST_USER_DATA_DIR },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buf = '';
  let id = 0;
  const waiting = new Map();
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const timer = setTimeout(() => reject(new Error('MCP timeout on ' + method)), 30000);
    waiting.set(myId, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const call = async (args) => {
    const res = await rpc('tools/call', { name: 'fix_wiki_issue', arguments: { domain: d.name, ...args } });
    return JSON.parse(res.result.content[0].text);
  };
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'merge-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  try {
    for (const { seed, keep, remove } of cases) {
      const issue = pair(`mcp-keep-${seed}`, `mcp-old-${seed}`);
      await call({ type: 'semanticDupe', issue, preview: true });
      const r = await call({ type: 'semanticDupe', issue, preview: false });
      ok(r.fixed === 1, `mcp semantic seed ${seed}: merged`, JSON.stringify(r));
      checkPair('mcp', seed, keep, remove, d.read(`concepts/mcp-keep-${seed}.md`), !d.has(`concepts/mcp-old-${seed}.md`));
    }
    const rc = await call({ type: 'crossFolderDupes', issue: { keep: 'entities/gamma.md', remove: 'concepts/gamma.md' } });
    ok(rc.fixed === 1, 'mcp cross-folder: merged', JSON.stringify(rc));
    checkPair('mcp-cross', 0, crossKeep, crossRemove, d.read('entities/gamma.md'), !d.has('concepts/gamma.md'));
    const rh = await call({ type: 'hyphenVariants', issue: { suggestedSlug: 'bob-ray', files: ['bob-ray', 'bobray'] } });
    ok(rh.fixed === 1, 'mcp hyphen: merged', JSON.stringify(rh));
    checkPair('mcp-hyphen', 0, hyphenKeep, hyphenRemove, d.read('entities/bob-ray.md'), !d.has('entities/bobray.md'));
  } finally {
    child.kill();
  }
}

// ── §3 The preview is the page ──────────────────────────────────────────────
section('§3 Preview shows what Merge writes');
for (let seed = 1; seed <= 40; seed++) {
  const { keep, remove } = genPair(seed + 2500);
  const removeWithLink = remove + '\nThe page links [[old-page]] and [[ keep-page ]].\n';
  const d = mkDomain({
    'concepts/keep-page.md': keep + '\n## Related\n- [[old-page]] — the duplicate\n',
    'concepts/old-page.md': removeWithLink,
    'entities/hub.md': '# Hub\n\n- [[old-page]]\n',
  });
  const issue = pair('keep-page', 'old-page');
  const plan = await health.previewSemanticDuplicateMerge(d.name, issue);
  const before = d.read('concepts/old-page.md');
  ok(before === removeWithLink, `preview seed ${seed}: the preview wrote nothing`);
  await health.fixIssue(d.name, 'semanticDupe', issue);
  const onDisk = d.read('concepts/keep-page.md');
  ok(plan.mergedLength === onDisk.length, `preview seed ${seed}: mergedLength is the length on disk`, `${plan.mergedLength} vs ${onDisk.length}`);
  ok(onDisk.startsWith(plan.mergedPreview), `preview seed ${seed}: mergedPreview is the bytes on disk`, plan.mergedPreview.slice(0, 400) + '\n----\n' + onDisk.slice(0, 400));
  ok(!/\[\[old-page\]\]/.test(plan.mergedPreview), `preview seed ${seed}: the preview shows links already repointed`);
  ok(!/\[\[old-page\]\]/.test(d.read('entities/hub.md')), `preview seed ${seed}: the hub link repointed`);
}

// ── §4 Idempotent, and nothing repeats ──────────────────────────────────────
section('§4 Idempotence');
for (let seed = 1; seed <= SEEDS; seed++) {
  const { keep, remove } = genPair(seed + 3000);
  const opts = { sourceLabel: 'old-page', keepFolder: 'concepts' };
  const once = composeMergedPage(keep, remove, opts);
  const twice = composeMergedPage(once, remove, opts);
  ok(twice === once, `seed ${seed}: merging the same page again changes nothing`, `--- once\n${once}\n--- twice\n${twice}`);
  const self = composeMergedPage(keep, keep, opts);
  ok(missingLines(keep, self).length === 0 && self.split('\n').length <= keep.split('\n').length + 1,
    `seed ${seed}: a page merged with itself adds nothing`, self);
  // Headings aside: a page may repeat a heading, and text under each stays under it.
  const dupes = once.split(/\r?\n/).filter((l) => /(K|R)\d+x\d+/.test(l) && !/^#/.test(l)).map((l) => l.trim());
  ok(new Set(dupes).size === dupes.length, `seed ${seed}: no marked line appears twice`,
    dupes.filter((l, i) => dupes.indexOf(l) !== i).slice(0, 2).join(' | '));
}
{
  const page = '---\ntype: concept\ntags: [type/concept]\n---\n# Same\n\nSame opening.\n\n## Key Facts\n- A fact\n';
  ok(composeMergedPage(page, page, { sourceLabel: 'x', keepFolder: 'concepts' }) === page, '4.1 identical pages leave the bytes alone');
  const k = '# K\n\n## Key Facts\n- Case Fact\n- [[alice]]\n';
  const r = '# K\n\n## Key Facts\n- case fact\n- [[ALICE]]\n';
  ok(composeMergedPage(k, r, { sourceLabel: 'x' }) === k, '4.2 a bullet differing only in case, or a bare repeat of a link, adds nothing');
}

// ── §5 Flip really changes the result ───────────────────────────────────────
section('§5 Flip');
{
  const A = '---\ntype: concept\ntags: [a]\n---\n# Page A\n\nOpening A.\n';
  const B = '---\ntype: concept\ntags: [b]\n---\n# Page B\n\nOpening B, longer than the other one by some way.\n';
  const d1 = mkDomain({ 'concepts/page-a.md': A, 'concepts/page-b.md': B });
  const d2 = mkDomain({ 'concepts/page-a.md': A, 'concepts/page-b.md': B });
  await health.fixIssue(d1.name, 'semanticDupe', pair('page-a', 'page-b'));
  await health.fixIssue(d2.name, 'semanticDupe', pair('page-b', 'page-a'));
  const keptA = d1.read('concepts/page-a.md');
  const keptB = d2.read('concepts/page-b.md');
  ok(keptA.includes('\n# Page A\n') && !keptA.includes('\n# Page B\n'), '5.1 keeping A leaves A\'s title as the title', keptA);
  ok(keptB.includes('\n# Page B\n') && !keptB.includes('\n# Page A\n'), '5.2 keeping B leaves B\'s title as the title', keptB);
  ok(keptA.indexOf('Opening A.') < keptA.indexOf('Opening B'), '5.3 keeping A puts A\'s opening first');
  ok(keptB.indexOf('Opening B') < keptB.indexOf('Opening A.'), '5.4 keeping B puts B\'s opening first');
  ok(keptA !== keptB, '5.5 the two directions differ');
  ok(/tags: \[a, b\]/.test(keptA) && /tags: \[b, a\]/.test(keptB), '5.6 tags are the union, the kept page\'s first');
}

// ── §6 Refusals ─────────────────────────────────────────────────────────────
section('§6 Nothing is deleted on a refusal');
{
  ok(findLostLines('# K\n\nKept text.\n', '# R\n\nRemoved text.\n', '# K\n\nKept text.\n').length === 2,
    '6.1 the cross-check names what is missing');
  ok(findLostLines('# K\n\nKept text.\n', '', '# Other\n').some((x) => x.page === 'kept'),
    '6.2 it checks the kept page as well');

  const d = mkDomain({ 'concepts/same.md': '# Same\n\nOnly copy.\n' });
  const r1 = await health.fixIssue(d.name, 'crossFolderDupes', { keep: 'concepts/same.md', remove: 'concepts/same.md' });
  ok(r1.fixed === 0 && r1.reason === 'merge-same-file', '6.3 a page merged into itself is refused', JSON.stringify(r1));
  ok(d.has('concepts/same.md') && d.read('concepts/same.md').includes('Only copy.'), '6.4 and the only copy is still there');

  // A kept name that is a link to the removed file: deleting the file would
  // leave nothing. stat follows the link, lstat on the remove side does not.
  const d2 = mkDomain({ 'concepts/real.md': '# Real\n\nOnly copy.\n' });
  symlinkSync(path.join(d2.wiki, 'concepts/real.md'), path.join(d2.wiki, 'concepts/alias.md'));
  const r2 = await health.fixIssue(d2.name, 'semanticDupe', pair('alias', 'real'));
  ok(r2.fixed === 0 && r2.reason === 'merge-same-file', '6.5 a kept name that links to the removed file is refused', JSON.stringify(r2));
  ok(d2.read('concepts/real.md').includes('Only copy.'), '6.6 and the file is still there');
  const r3 = await health.fixIssue(d2.name, 'semanticDupe', pair('real', 'alias'));
  ok(r3.fixed === 1 && d2.has('concepts/real.md') && !d2.has('concepts/alias.md'), '6.7 removing a link that points at the kept page works as before', JSON.stringify(r3));
  ok(d2.read('concepts/real.md').includes('Only copy.'), '6.8 and the text is intact');

  // On a case-insensitive disk two spellings reach one file. Only meaningful there.
  const d3 = mkDomain({ 'concepts/casey.md': '# Casey\n\nOnly copy.\n' });
  if (d3.has('concepts/CASEY.md')) {
    const r4 = await health.fixIssue(d3.name, 'semanticDupe', pair('casey', 'CASEY'));
    ok(r4.fixed === 0 && r4.reason === 'merge-same-file', '6.9 two spellings of one file are refused', JSON.stringify(r4));
    ok(d3.read('concepts/casey.md').includes('Only copy.'), '6.10 and the file is still there');
  }
}

// ── §7 The text outlives the next ingest ────────────────────────────────────
section('§7 A later ingest keeps the moved text');
{
  const merged = composeMergedPage(
    '# K\n\nKept opening.\n\n## Overview\nKept overview.\n',
    '# R\n\nRemoved opening.\n\n## Enforcement\nRemoved enforcement.\n\n## Overview\nRemoved overview.\n',
    { sourceLabel: 'r', keepFolder: 'concepts' });
  const after = mergeWikiPage(merged, '# K\n\nA rewrite of the opening.\n\n## Overview\nA rewritten overview.\n\n## Enforcement\nA new section of the same name.\n');
  for (const t of ['Removed opening.', 'Removed enforcement.', 'Removed overview.']) {
    ok(after.includes(t), `7.1 "${t}" survives mergeWikiPage, because it sits under one heading`, after);
  }
  const titles = merged.split('\n').filter((l) => /^# /.test(l));
  ok(titles.length === 1, '7.2 the merged page has one title, since `# ` ends a section for mergeWikiPage', titles.join(' | '));
}

// ── §8 Shapes worth naming, and links ───────────────────────────────────────
section('§8 Named shapes');
{
  const o = { sourceLabel: 'old', keepFolder: 'concepts' };
  const code = composeMergedPage('# K\n', '# R\n\n## Setup\n```bash\n# install\n## twice\n```\n', o);
  ok(code.includes('```bash\n# install\n## twice\n```'), '8.1 hashes inside a fence are not headings and are not demoted', code);

  const tbl = composeMergedPage('# K\n\n## Key Facts\n| a | b |\n|---|---|\n| 1 | 2 |\n', '## Key Facts\n- new fact\n', o);
  ok(tbl.includes('| 1 | 2 |\n\n- new fact'), '8.2 a bullet added after a table gets a blank line, or it would read as a table row', tbl);

  const split = composeMergedPage('# K\n', '# R\n\n## Key Facts\nIntro line.\n- one\n- two\n\n| x |\n|---|\n| y |\n', o);
  ok(/## Key Facts\n- one\n- two/.test(split), '8.3 bullets go to a created accumulating section', split);
  ok(split.includes('Intro line.') && split.includes('| x |\n|---|\n| y |'), '8.4 the table stays whole', split);

  const unclosed = composeMergedPage('# K\n\n```\nkept code\n', '# R\n\nRemoved text.\n', o);
  ok(unclosed.includes('kept code\n```\n') && unclosed.includes('Removed text.'), '8.5 an unclosed kept fence is closed before text is added after it', unclosed);
  const unclosed2 = composeMergedPage('# K\n\nKept.\n', '# R\n\n```\nremoved code\n## not a section\n', o);
  ok(unclosed2.includes('removed code\n## not a section\n```'), '8.6 an unclosed removed fence stays whole and is closed', unclosed2);

  const crlf = composeMergedPage('# K\r\n\r\nKept.\r\n', '# R\n\nRemoved.\n', o);
  ok(!/[^\r]\n/.test(crlf), '8.7 a CRLF kept page stays CRLF', JSON.stringify(crlf));

  const empty = composeMergedPage('', '---\ntype: entity\ntags: [t]\n---\n# R\n\nRemoved.\n', o);
  ok(empty.startsWith('---\ntype: concept\ntags: [t]\n---\n') && empty.includes('Removed.'), '8.8 an empty kept page gets the removed text and the kept folder\'s type', empty);
  ok(composeMergedPage('# K\n', '', o) === '# K\n', '8.9 an empty removed page changes nothing');

  const hr = composeMergedPage('# K\n', '---\nnot frontmatter, a sentence\n---\nBody.\n', o);
  ok(hr.includes('not frontmatter, a sentence') && hr.includes('Body.'), '8.10 a rule pair that is not YAML is treated as text', hr);

  const conflict = composeMergedPage('---\ntype: concept\nsource: a.pdf\n---\n# K\n', '---\ntype: concept\nsource: b.pdf\n---\n# K\n', o);
  ok(conflict.includes('source: a.pdf') && conflict.includes('```yaml\nsource: b.pdf\n```'), '8.11 a frontmatter value that conflicts is kept as text', conflict);

  const links = composeMergedPage('## Related\n- [[alpha]]\n', '## Related\n- [[alpha|Alias]]\n- [[alpha]] — with words\n- [[alpha]]\n', o);
  ok(links.includes('- [[alpha|Alias]]') && links.includes('- [[alpha]] — with words'), '8.12 an alias or words next to a known link survive', links);

  const chained = composeMergedPage(composeMergedPage('# K\n', '# A\n\nFrom A.\n', { sourceLabel: 'a' }), '# B\n\nFrom B.\n', { sourceLabel: 'b' });
  ok(chained.includes('## Merged from a') && chained.includes('## Merged from b'), '8.13 two merges, two headings', chained);
  const again = composeMergedPage(composeMergedPage('# K\n', '# A\n\nFrom A.\n', { sourceLabel: 'a' }), '# A\n\nMore from A.\n', { sourceLabel: 'a' });
  ok((again.match(/## Merged from a/g) || []).length === 1 && again.includes('More from A.'),
    '8.14 a second page with that name reuses the heading (a duplicate heading would lose one in mergeWikiPage)', again);

  // The inbound links, end to end, with the real scanner as the oracle.
  const d = mkDomain({
    'concepts/keep-page.md': '# Keep\n\nKept.\n',
    'concepts/old-page.md': '# Old\n\nSee [[old-page]] and [[concepts/old-page|the alias]].\n',
    'entities/hub.md': '# Hub\n\n- [[old-page]]\n- [[concepts/old-page|label]]\n',
    'summaries/s.md': '# S\n\n## Concepts Introduced or Referenced\n- [[old-page]]\n',
  });
  await health.fixIssue(d.name, 'semanticDupe', pair('keep-page', 'old-page'));
  const scan = await health.scanWiki(d.name);
  ok(scan.brokenLinks.length === 0, '8.15 no broken links after the merge', JSON.stringify(scan.brokenLinks));
  ok(d.read('entities/hub.md').includes('- [[keep-page|label]]'), '8.16 an alias keeps its label');
  ok(d.read('concepts/keep-page.md').includes('[[keep-page|the alias]]'), '8.17 links in the moved text are repointed too');
}

// ── §9 The manual repair scripts ────────────────────────────────────────────
section('§9 Manual repair scripts');
{
  const run = (script, args) => spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...args], {
    cwd: TMP, encoding: 'utf8',
    env: { ...process.env, CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_USER_DATA_DIR: process.env.CURATOR_TEST_USER_DATA_DIR },
  });
  // Real runs against this suite's own domains folder (the env var outranks every
  // other way these scripts find a domains folder).
  const KEEP = '---\ntype: concept\ntags: [type/concept, kept-tag]\n---\n# Kept\n\nKept opening.\n\n## Key Facts\n- Kept fact\n';
  const GONE = '---\ntype: concept\ntags: [type/concept, gone-tag]\n---\n# Gone\n\nGone opening, and a lot longer than the kept opening is.\n\n## Key Facts\n- Gone fact\n\n## Notes\nGone notes.\n';
  const check = (label, d, keepRel, goneRel) => {
    const merged = d.read(keepRel);
    ok(!d.has(goneRel), `9 ${label}: the page is deleted`);
    for (const t of ['# Kept', 'Kept opening.', 'Kept fact', 'Gone opening', 'Gone fact', 'Gone notes.', 'gone-tag', 'kept-tag']) {
      ok(merged.includes(t), `9 ${label}: "${t}" is on the kept page`, merged);
    }
    ok(merged.indexOf('Kept opening.') < merged.indexOf('Gone opening'), `9 ${label}: the kept page is the base`, merged);
  };

  const d1 = mkDomain({ 'entities/acme.md': KEEP.replace(/concept/g, 'entity'), 'concepts/acme.md': GONE });
  const r1 = run('repair-wiki.js', [d1.name]);
  ok(r1.status === 0, '9 repair-wiki.js ran', r1.stderr);
  check('repair-wiki.js', d1, 'entities/acme.md', 'concepts/acme.md');

  const d2 = mkDomain({ 'concepts/retrieval.md': KEEP, 'concepts/retrieval-augmented-long.md': GONE });
  const r2 = run('fix-wiki-duplicates.js', [d2.name]);
  ok(r2.status === 0, '9 fix-wiki-duplicates.js ran', r2.stderr);
  check('fix-wiki-duplicates.js', d2, 'concepts/retrieval.md', 'concepts/retrieval-augmented-long.md');

  const d3 = mkDomain({ 'entities/ada.md': KEEP.replace(/concept/g, 'entity') });
  mkdirSync(path.join(d3.wiki, 'people'), { recursive: true });
  writeFileSync(path.join(d3.wiki, 'people/ada.md'), GONE);
  const r3 = run('fix-wiki-structure.js', [d3.name]);
  ok(r3.status === 0, '9 fix-wiki-structure.js ran', r3.stderr);
  check('fix-wiki-structure.js', d3, 'entities/ada.md', 'people/ada.md');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
