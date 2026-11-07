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
 * §10 a delete must match the scan's own rule. §11 frontmatter stays byte for byte.
 * §12 a group merged in part says so. §13 case is text. §14 Windows device names.
 * §15 a repair stays out of code fences and other tools' folders.
 *
 * Isolation: __setDomainsDirOverride plus CURATOR_TEST_USER_DATA_DIR. Nothing
 * here reads a real domain, config or credential, and no provider is called.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
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
const { composeMergedPage, composeReusedPage, findLostLines } = await import(path.join(REPO, 'src/brain/page-merge.js'));
const { mergeWikiPage, writePage } = await import(path.join(REPO, 'src/brain/files.js'));
const { isWindowsReservedName } = await import(path.join(REPO, 'src/brain/reserved-names.js'));
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
    // The MCP route to a delete checks the claim, and its report says what happened.
    writeFileSync(path.join(d.wiki, 'entities/stranger-one.md'), '# One\n\nOne.\n');
    writeFileSync(path.join(d.wiki, 'concepts/stranger-two.md'), '# Two\n\nTwo.\n');
    const rx = await call({ type: 'crossFolderDupes', issue: { keep: 'entities/stranger-one.md', remove: 'concepts/stranger-two.md' } });
    ok(rx.fixed === 0 && rx.reason === 'merge-not-related' && /REFUSED/.test(rx.report) && /nothing was deleted/.test(rx.report)
      && d.has('concepts/stranger-two.md') && d.read('entities/stranger-one.md') === '# One\n\nOne.\n',
      'mcp: an unrelated cross-folder pair is refused and nothing moves', JSON.stringify(rx));
    const ry = await call({ type: 'hyphenVariants', issue: { suggestedSlug: 'stranger-one', files: ['stranger-one', 'bob-ray'] } });
    ok(ry.fixed === 0 && ry.reason === 'merge-not-related' && d.has('entities/bob-ray.md'),
      'mcp: an unrelated hyphen group is refused and nothing moves', JSON.stringify(ry));
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
  const m42 = composeMergedPage(k, r, { sourceLabel: 'x' });
  ok(m42.includes('- case fact') && m42.includes('- Case Fact'), '4.2a a bullet differing only in case is text, and stays', m42);
  ok(!m42.includes('[[ALICE]]'), '4.2b a bare repeat of a link, in any case, adds nothing', m42);
  ok(composeMergedPage(m42, r, { sourceLabel: 'x' }) === m42, '4.2c and a second merge adds nothing');
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
  ok(r1.fixed === 0 && r1.reason === 'merge-not-related' && d.read('concepts/same.md') === '# Same\n\nOnly copy.\n',
    '6.3 a page merged into itself is refused', JSON.stringify(r1));
  const dl = mkDomain({ 'entities/link-one.md': '# One\n\nOnly copy.\n' });
  linkSync(path.join(dl.wiki, 'entities/link-one.md'), path.join(dl.wiki, 'concepts/link-one.md'));
  const rl = await health.fixIssue(dl.name, 'crossFolderDupes', { keep: 'entities/link-one.md', remove: 'concepts/link-one.md' });
  ok(rl.fixed === 0 && rl.reason === 'merge-same-file' && dl.has('entities/link-one.md') && dl.has('concepts/link-one.md'),
    '6.3b two names of one file, in two folders, are refused by the same-file guard', JSON.stringify(rl));
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

// ── §10 A delete must match the scan's own rule ─────────────────────────────
section('§10 crossFolderDupes and hyphenVariants check the claim on the server');
{
  const FILES = {
    'entities/openai.md': '# OpenAI\n\nA lab.\n',
    'concepts/photosynthesis.md': '# Photosynthesis\n\nPlants.\n',
    'summaries/openai.md': '# A source about OpenAI\n\nA summary.\n',
    'concepts/openai.md': '# OpenAI, the idea\n\nAn idea.\n',
    'entities/alice-smith.md': '# Alice\n\nA person.\n',
    'entities/bob-jones.md': '# Bob\n\nAnother.\n',
    'entities/alicesmith.md': '# Alice again\n\nThe same person.\n',
  };
  const untouched = (d) => Object.entries(FILES).every(([rel, body]) => d.has(rel) && d.read(rel) === body);
  const REFUSED = [
    ['unrelated names', 'crossFolderDupes', { keep: 'entities/openai.md', remove: 'concepts/photosynthesis.md' }],
    ['a summary of the same name', 'crossFolderDupes', { keep: 'entities/openai.md', remove: 'summaries/openai.md' }],
    ['one folder', 'crossFolderDupes', { keep: 'entities/alice-smith.md', remove: 'entities/alicesmith.md' }],
    ['a path out of the wiki', 'crossFolderDupes', { keep: 'entities/openai.md', remove: 'concepts/../../openai.md' }],
    ['no fields', 'crossFolderDupes', { keep: 'entities/openai.md' }],
    ['a stranger in the group', 'hyphenVariants', { suggestedSlug: 'alice-smith', files: ['alice-smith', 'bob-jones'] }],
    ['a stranger beside a real variant', 'hyphenVariants', { suggestedSlug: 'alice-smith', files: ['alice-smith', 'alicesmith', 'bob-jones'] }],
    ['an empty group', 'hyphenVariants', { suggestedSlug: 'alice-smith', files: [] }],
    ['no list', 'hyphenVariants', { suggestedSlug: 'alice-smith' }],
    ['a non-string in the group', 'hyphenVariants', { suggestedSlug: 'alice-smith', files: ['alicesmith', 7] }],
    ['a path as a name', 'hyphenVariants', { suggestedSlug: 'alice-smith', files: ['../concepts/openai'] }],
    ['a path as the kept name', 'hyphenVariants', { suggestedSlug: '../alice-smith', files: ['../alice-smith'] }],
  ];
  for (const [label, type, issue] of REFUSED) {
    const d = mkDomain(FILES);
    const r = await health.fixIssue(d.name, type, issue);
    ok(r.fixed === 0 && r.reason === 'merge-not-related', `10.1 ${label}: refused with the stable code`, JSON.stringify(r));
    ok(untouched(d), `10.1 ${label}: every page is byte-identical`);
  }

  // What the scan lists still goes through, by the same rule: hyphens aside, either way round.
  const d2 = mkDomain({ 'entities/email.md': '# Email\n\nA.\n', 'concepts/e-mail.md': '# E-mail\n\nB.\n' });
  const rows = (await health.scanWiki(d2.name)).crossFolderDupes;
  ok(rows.length === 1, '10.2 the scan offers concepts/e-mail + entities/email', JSON.stringify(rows));
  const r2 = await health.fixIssue(d2.name, 'crossFolderDupes', rows[0]);
  ok(r2.fixed === 1 && !d2.has('concepts/e-mail.md') && d2.read('entities/email.md').includes('B.'), '10.2 and the row it lists merges', JSON.stringify(r2));
  const d3 = mkDomain({ 'entities/same.md': '# Same\n\nA.\n', 'concepts/same.md': '# Same\n\nB.\n' });
  const r3 = await health.fixIssue(d3.name, 'crossFolderDupes', { keep: 'concepts/same.md', remove: 'entities/same.md' });
  ok(r3.fixed === 1 && !d3.has('entities/same.md') && d3.read('concepts/same.md').includes('A.'), '10.3 the other way round is the same pair', JSON.stringify(r3));

  // The honorific and article rule of the hyphen scan, and names the old private regex refused.
  const d4 = mkDomain({
    'entities/tali-rezun.md': '# Tali\n\nA.\n', 'entities/dr.-tali-rezun.md': '# Dr Tali\n\nB.\n', 'entities/talirezun.md': '# T\n\nC.\n',
    'entities/čapek-karel.md': '# Čapek\n\nD.\n', 'entities/čapekkarel.md': '# Capek\n\nE.\n',
  });
  for (const row of (await health.scanWiki(d4.name)).hyphenVariants) {
    const r = await health.fixIssue(d4.name, 'hyphenVariants', row);
    ok(r.fixed === 1, `10.4 the scan's group ${row.suggestedSlug} merges`, JSON.stringify(r));
  }
  ok(!d4.has('entities/dr.-tali-rezun.md') && !d4.has('entities/talirezun.md') && !d4.has('entities/čapekkarel.md'), '10.4 its variants are gone');
  ok(d4.read('entities/čapek-karel.md').includes('E.'), '10.4 and a name with č merged its text');

  // A page gone since the scan is a different answer from a stranger.
  const d5 = mkDomain({ 'entities/gone-one.md': '# G\n\nA.\n' });
  const r5 = await health.fixIssue(d5.name, 'crossFolderDupes', { keep: 'entities/gone-one.md', remove: 'concepts/gone-one.md' });
  ok(r5.fixed === 0 && r5.reason === 'merge-page-missing' && d5.has('entities/gone-one.md'), '10.5 cross-folder: a gone page is named as gone', JSON.stringify(r5));
  const r6 = await health.fixIssue(d5.name, 'hyphenVariants', { suggestedSlug: 'gone-one', files: ['gone-one', 'goneone'] });
  ok(r6.fixed === 0 && r6.reason === 'merge-page-missing', '10.5 hyphen: nothing left to merge is not "fixed"', JSON.stringify(r6));

  // The route: stable code, plain message, nothing deleted. The screen's bulk call still works.
  const { default: express } = await import('express');
  const { createServer } = await import('node:http');
  const routes = await import(path.join(REPO, 'src/routes/health.js'));
  const app = express();
  app.use(express.json());
  app.use('/api/health', routes.default);
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/health`;
  try {
    const post = async (dom, body) => {
      const res = await fetch(`${base}/${dom}/fix`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };
    const d6 = mkDomain(FILES);
    const a = await post(d6.name, { type: 'crossFolderDupes', issue: { keep: 'entities/openai.md', remove: 'concepts/photosynthesis.md' } });
    ok(a.status === 409 && a.json.code === 'merge-not-related' && a.json.fixed === 0 && /nothing was merged or deleted/.test(a.json.error),
      '10.6 POST /fix: 409, a stable code and a plain message', JSON.stringify(a));
    const b = await post(d6.name, { type: 'hyphenVariants', issue: { suggestedSlug: 'alice-smith', files: ['alice-smith', 'bob-jones'] } });
    ok(b.status === 409 && b.json.code === 'merge-not-related', '10.6 POST /fix, hyphen: the same', JSON.stringify(b));
    ok(untouched(d6), '10.6 every page is byte-identical');
    const c = await post(d6.name, { type: 'crossFolderDupes' });
    ok(c.status === 200 && c.json.fixed === 1 && c.json.total === 1 && !d6.has('concepts/openai.md'), "10.7 the screen's call, the type alone, merges what the scan lists", JSON.stringify(c));
    const e = await post(d6.name, { type: 'hyphenVariants' });
    ok(e.status === 200 && e.json.fixed === 1 && !d6.has('entities/alicesmith.md') && d6.has('entities/bob-jones.md'), "10.7 and so does the hyphen group's", JSON.stringify(e));
    const d7 = mkDomain({ 'entities/fix-safe.md': '# F\n\nA.\n', 'concepts/fix-safe.md': '# F\n\nB.\n' });
    const res = await health.fixAllSafe(d7.name);
    ok(res.byType.crossFolderDupes.fixed === 1 && !d7.has('concepts/fix-safe.md'), '10.7 Fix-all-safe still merges', JSON.stringify(res));
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ── §11 Frontmatter ─────────────────────────────────────────────────────────
section('§11 A foreign block stays byte for byte');
{
  const BLOCKS = {
    'a key with a space': 'due date: 2026-01-01',
    'a key with a dot': 'review.status: open',
    'a non-ASCII key': 'größe: 3',
    'č as a key and a value': 'č: žaba\nčas: "dvě hodiny"',
    'a Japanese key': '日本語: 値',
    'nested YAML': 'author:\n  name: Ada\n  address:\n    city: "Ljubljana, SI"',
    'a list, indented': 'aliases:\n  - Ada\n  - "A. L."',
    'a list at the margin': 'aliases:\n- Ada\n- Lovelace',
    'quoted values': `title: "A: B"\nsub: 'it''s'`,
    'a quoted key': '"my key": 1\n\'other: key\': 2',
    'dates': 'published: 2026-01-01\nat: 2026-01-01T10:00:00Z',
    'a block scalar': 'note: |\n  line one\n  --- not a fence\n\n  line three',
    'a flow map': 'meta: {a: 1, b: [2, 3]}',
    'a comment first': '# from a template\nkey: value',
    'a blank line first': '\nkey: value',
    'odd spacing': 'key :   value   \nother:\t1',
    'a line YAML cannot parse': 'key: value\nthis line has no colon',
    // The foreign-vault run's 31 shapes, as it wrote them.
    plain: 'type: x', date: 'date: 2026-01-01', 'caps key': 'Title: x', underscore: 'a_b: x', hyphen: 'a-b: x',
    'space key': 'due date: 2026-01-01', 'dot key': 'review.status: open', 'umlaut key': 'größe: 3', 'cjk key': '別名: x', 'č key': 'čas: x',
    'digit start': '1st: x', 'quoted key': '"a": 1', 'space before colon': 'a : 1', 'at key': '@type: x', 'dollar key': '$k: x',
    'list indented': 'tags:\n  - a\n  - b', 'list unindented': 'tags:\n- a\n- b', 'flow list': 'tags: [a, b]', 'flow map': 'm: {a: 1}',
    nested: 'n:\n  k: v\n  l:\n    - a', 'block scalar': 'm: |\n  one\n\n  three', folded: 'm: >-\n  one\n  two', 'blank line': 'a: 1\n\nb: 2', comment: '# note\na: 1',
    'inline comment': 'a: 1 # c', 'multiline plain': 'a: one\n  two', 'empty value': 'a:', 'link value': 'up: "[[x]]"', 'url value': 'u: https://x.y/z', 'colon value': 't: "a: b"', 'doc end': 'a: 1\n...',
  };
  const inc = '---\ntype: entity\ntags: [new-tag]\n---\n# X\n\nBody.\n\n## Key Facts\n- one\n- A completely different brand new fact about zebras\n';
  const dashes = (t) => t.split(/\r?\n/).filter((l) => l.trimEnd() === '---').length;
  const untag = (head) => head.replace(/^tags: \[new-tag\]\r?\n/m, '');
  for (const [label, block] of Object.entries(BLOCKS)) {
    const head = `---\n${block}\n---\n`;
    const keep = `${head}# X\n\nBody.\n\n## Key Facts\n- one\n`;
    const wantDashes = dashes(keep);
    for (const [how, compose] of [
      ['reuse', (k) => composeReusedPage(k, inc, { keepFolder: 'concepts', dropped: [] })],
      ['merge', (k) => composeMergedPage(k, inc, { sourceLabel: 'y', keepFolder: 'concepts' })],
    ]) {
      const once = compose(keep);
      const close = once.indexOf('\n---\n', head.indexOf(block) + block.length - 1);
      const gotHead = once.slice(0, close + 5);
      ok(dashes(once) === wantDashes, `11.1 ${label}, ${how}: one frontmatter block, not two`, once);
      // A block with its own `tags` gains the tag inside that entry; everything else, at its foot.
      const ownTags = /^tags:/m.test(block);
      const expected = ownTags ? gotHead.replace(', new-tag]', ']').replace(/^\s*- new-tag\n/m, '') : untag(gotHead);
      ok(expected === head, `11.1 ${label}, ${how}: the block is byte for byte, the new tag aside`, JSON.stringify(gotHead));
      ok(/new-tag/.test(gotHead), `11.1 ${label}, ${how}: the tag joined the block`, once);
      ok(compose(once) === once, `11.1 ${label}, ${how}: a second write changes nothing`, compose(once));
    }
    // With nothing to add the file's bytes stand, whichever path.
    const quiet = '# X\n\nBody.\n\n## Key Facts\n- one\n';
    ok(composeReusedPage(keep, quiet, { keepFolder: 'concepts', dropped: [] }) === keep, `11.2 ${label}: nothing new leaves the bytes alone (reuse)`);
    ok(composeMergedPage(keep, quiet, { sourceLabel: 'y', keepFolder: 'concepts' }) === keep, `11.2 ${label}: nothing new leaves the bytes alone (merge)`);
    ok(findLostLines(keep, inc, composeMergedPage(keep, inc, { sourceLabel: 'y', keepFolder: 'concepts' })).length === 0, `11.2 ${label}: the guard agrees`);
  }

  // Empty frontmatter, in both shapes.
  for (const head of ['---\n---\n', '---\n\n---\n']) {
    const keep = `${head}# X\n\nBody.\n`;
    const quiet = '# X\n\nBody.\n';
    ok(composeReusedPage(keep, quiet, { keepFolder: 'concepts', dropped: [] }) === keep, `11.3 empty ${JSON.stringify(head)}: bytes stand`);
    const m = composeMergedPage(keep, '---\ntags: [t]\n---\n# X\n\nBody.\n', { sourceLabel: 'y', keepFolder: 'concepts' });
    ok(m.startsWith(head.replace(/---\n$/, 'tags: [t]\n---\n')) && dashes(m) === 2, `11.3 empty ${JSON.stringify(head)}: one block, the tag in it`, JSON.stringify(m));
  }

  // Line endings: a CRLF block, a fence with spaces, a block in another ending than its page.
  const crlfHead = '---\r\ndue date: 1\r\nnested:\r\n  a: 1\r\n---\r\n';
  const crlf = composeMergedPage(`${crlfHead}# X\r\n\r\nBody.\r\n`, inc, { sourceLabel: 'y', keepFolder: 'concepts' });
  ok(crlf.startsWith('---\r\ndue date: 1\r\nnested:\r\n  a: 1\r\ntags: [new-tag]\r\n---\r\n'), '11.4 a CRLF block stays CRLF, new line included', JSON.stringify(crlf.slice(0, 80)));
  ok(!/[^\r]\n/.test(crlf), '11.4 no bare LF on a CRLF page', JSON.stringify(crlf));
  const fence = composeMergedPage('---   \nk y: 1\n---  \n# X\n\nBody.\n', '---\ntype: entity\n---\n# X\n\nMore words.\n', { sourceLabel: 'y', keepFolder: 'concepts' });
  ok(fence.startsWith('---   \nk y: 1\n---  \n'), '11.4 fences keep their trailing spaces', JSON.stringify(fence.slice(0, 40)));
  const mixed = composeMergedPage('---\nk y: 1\n---\n# X\r\n\r\nBody.\r\n\r\nAll CRLF.\r\n', '# Z\n\nMore words.\n', { sourceLabel: 'y', keepFolder: 'concepts' });
  ok(mixed.startsWith('---\nk y: 1\n---\n# X\r\n'), '11.4 a block keeps its ending on a page in another', JSON.stringify(mixed.slice(0, 40)));
  const bomKeep = '\ufeff---\nk y: 1\n---\n# X\n\nBody.\n';
  ok(composeMergedPage(bomKeep, '# Z\n\nMore words.\n', { sourceLabel: 'y' }).startsWith(bomKeep.slice(0, 15)), '11.4 a BOM stays');

  // The one tag rule, form by form: what is there keeps its spelling.
  const tagOut = (block, tags = '[new, type/entity]', folder = 'concepts') => {
    const m = composeMergedPage(`---\n${block}\n---\n# X\n`, `---\ntags: ${tags}\n---\n# X\n`, { sourceLabel: 'y', keepFolder: folder });
    return m.slice(4, m.indexOf('\n---\n', 4));
  };
  const FORMS = [
    ['flow', 'tags: [a, b]', 'tags: [a, b, new, type/concept]'],
    ['flow with inner spaces', 'tags: [ a, b ]', 'tags: [ a, b, new, type/concept ]'],
    ['flow, quoted, a comma inside', 'tags: ["a, b", \'c\']', 'tags: ["a, b", \'c\', new, type/concept]'],
    ['flow with a comment', 'tags: [a] # mine', 'tags: [a, new, type/concept] # mine'],
    ['flow over lines', 'tags: [a,\n  b]', 'tags: [a,\n  b, new, type/concept]'],
    ['flow, empty', 'tags: []', 'tags: [new, type/concept]'],
    ['block', 'tags:\n  - a\n  - "b c"', 'tags:\n  - a\n  - "b c"\n  - new\n  - type/concept'],
    ['block at the margin', 'tags:\n- a', 'tags:\n- a\n- new\n- type/concept'],
    ['one word', 'tags: a', 'tags: [a, new, type/concept]'],
    ['no value', 'tags:', 'tags: [new, type/concept]'],
    ['the type tag follows the folder', 'tags: [type/entity, a]', 'tags: [type/concept, a, new]'],
    ['a key in another case', 'Tags: [a]', 'Tags: [a, new, type/concept]'],
    ['a quoted key', '"tags": [a]', '"tags": [a, new, type/concept]'],
  ];
  for (const [label, block, want] of FORMS) {
    ok(tagOut(block) === want, `11.5 tags, ${label}`, JSON.stringify(tagOut(block)));
  }
  ok(tagOut('tags: ["a, b"]', '["a, b"]') === 'tags: ["a, b"]', '11.5 a tag with a comma is one tag: nothing to add, nothing rewritten');
  ok(tagOut('tags: [a]', '["x y: z"]') === 'tags: [a, "x y: z"]', '11.5 a new tag YAML would misread is quoted');

  // `type` moves only when it is plainly the other kind; anything else stands.
  const typed = (line, folder) => composeMergedPage(`---\n${line}\nk y: 1\n---\n# X\n`, '# X\n\nMore words.\n', { sourceLabel: 'y', keepFolder: folder }).split('\n')[1];
  ok(typed('type: entity', 'concepts') === 'type: concept', '11.6 type follows the kept folder');
  ok(typed('type: "entity"', 'concepts') === 'type: "entity"', '11.6 a quoted type is not understood, and stands');
  ok(typed('type: note', 'concepts') === 'type: note', '11.6 a foreign type stands');

  // A tags shape this module cannot add to: never rewritten, and a delete is refused.
  const odd = '---\ntags: {a: 1}\nk y: 2\n---\n# X\n\nBody.\n';
  const oddReuse = composeReusedPage(odd, '---\ntags: [t]\n---\n# X\n\nBody.\n', { keepFolder: 'concepts', dropped: [] });
  ok(oddReuse.startsWith(odd.slice(0, odd.indexOf('# X'))), '11.7 reuse: an unknown tags shape is byte for byte', oddReuse);
  ok(oddReuse.includes('tags: [t]'), '11.7 reuse: what it would have gained is kept as text', oddReuse);
  const dOdd = mkDomain({ 'entities/odd-one.md': odd, 'entities/oddone.md': '---\ntags: [t]\n---\n# X\n\nOther.\n' });
  const rOdd = await health.fixIssue(dOdd.name, 'hyphenVariants', { suggestedSlug: 'odd-one', files: ['odd-one', 'oddone'] });
  ok(rOdd.fixed === 0 && rOdd.reason === 'merge-would-lose-text' && dOdd.has('entities/oddone.md') && dOdd.read('entities/odd-one.md') === odd,
    '11.7 merge: refused, both pages stand', JSON.stringify(rOdd));

  // A rule pair is still text; what opens with a key is the block YAML would call one.
  const hrKeep = '---\nnot frontmatter, a sentence\n---\nBody.\n';
  const hrOut = composeReusedPage(hrKeep, '---\ntags: [t]\n---\n# T\n\nBody.\n', { keepFolder: 'concepts', dropped: [] });
  ok(hrOut.startsWith('---\ntype: concept\ntags: [t]\n---\n') && hrOut.includes('not frontmatter, a sentence'), '11.8 a rule pair with a sentence stays body text', hrOut);

  // The real write path: ingest reuse, through writePage, three times over.
  const FOREIGN = '---\ndue date: 2026-01-01\nreview.status: open\nčas: 3\n日本語: 値\nauthor:\n  name: Ada\ntags: [mine]\ncreated: 2020-01-01\n---\n# Page\n\nOpening.\n\n## Key Facts\n- first\n';
  const dw = mkDomain({ 'concepts/foreign.md': FOREIGN });
  for (const [i, word] of ['zebras gallop', 'walruses dive', 'herons wade'].entries()) {
    await writePage(dw.name, 'concepts/foreign.md', `---\ntype: concept\ntags: [mine]\n---\n# Page\n\n## Key Facts\n- ${word} across wide unfamiliar plains ${i}\n`);
  }
  const onDisk = dw.read('concepts/foreign.md');
  // injectFrontmatter gives every write its `type/` tag: the one tag edit, on the one line.
  ok(onDisk.replace('tags: [mine, type/concept]', 'tags: [mine]').startsWith(FOREIGN.slice(0, FOREIGN.indexOf('# Page'))),
    '11.9 writePage: three reuses leave the block byte for byte, the tag aside', onDisk);
  ok(dashes(onDisk) === 2 && onDisk.includes('herons wade'), '11.9 writePage: one block, and the new text landed', onDisk);

  // And a merge on disk.
  const dm = mkDomain({ 'entities/foreign-page.md': FOREIGN, 'concepts/foreignpage.md': '---\ntags: [mine]\n---\n# Other\n\nMoved text.\n' });
  const rm1 = await health.fixIssue(dm.name, 'crossFolderDupes', { keep: 'entities/foreign-page.md', remove: 'concepts/foreignpage.md' });
  ok(rm1.fixed === 1 && dm.read('entities/foreign-page.md').startsWith(FOREIGN.slice(0, FOREIGN.indexOf('# Page'))), '11.9 fixIssue: a merge leaves the block byte for byte', dm.read('entities/foreign-page.md'));
}

// ── §12 Part of a group ─────────────────────────────────────────────────────
section('§12 A hyphen group merged in part reports the truth');
{
  const seed = () => {
    const d = mkDomain({ 'entities/tali-rezun.md': '# Tali\n\nCanon.\n', 'entities/talirezun.md': '# Variant\n\nFrom variant.\n' });
    // Two names of one file: the same-file guard refuses this variant, and only this one.
    linkSync(path.join(d.wiki, 'entities/tali-rezun.md'), path.join(d.wiki, 'entities/tali-re-zun.md'));
    return d;
  };
  const issue = { suggestedSlug: 'tali-rezun', files: ['tali-rezun', 'talirezun', 'tali-re-zun'] };

  const d = seed();
  const r = await health.fixIssue(d.name, 'hyphenVariants', issue);
  ok(r.fixed === 0, '12.1 not reported as fixed', JSON.stringify(r));
  ok(r.partial === true && r.reason === 'merge-same-file', '12.1 partial, with the reason', JSON.stringify(r));
  ok(JSON.stringify(r.merged) === '["talirezun"]', '12.1 names what merged', JSON.stringify(r));
  ok(r.refused?.length === 1 && r.refused[0].slug === 'tali-re-zun' && r.refused[0].reason === 'merge-same-file', '12.1 names what did not', JSON.stringify(r));
  ok(!d.has('entities/talirezun.md') && d.has('entities/tali-re-zun.md') && d.read('entities/tali-rezun.md').includes('From variant.'), '12.1 and that is what happened on disk');

  const allRefused = mkDomain({ 'entities/one-two.md': '# O\n\nCanon.\n' });
  linkSync(path.join(allRefused.wiki, 'entities/one-two.md'), path.join(allRefused.wiki, 'entities/onetwo.md'));
  const r2 = await health.fixIssue(allRefused.name, 'hyphenVariants', { suggestedSlug: 'one-two', files: ['one-two', 'onetwo'] });
  ok(r2.fixed === 0 && !r2.partial && r2.reason === 'merge-same-file' && r2.refused?.length === 1, '12.2 all refused is a refusal, not partial', JSON.stringify(r2));

  const dBulk = seed();
  const rb = await health.fixIssue(dBulk.name, 'hyphenVariants');
  ok(rb.total === 1 && rb.fixed === 0 && rb.partial === 1, '12.3 bulk: the group does not count as fixed, and is counted as partial', JSON.stringify(rb));
  const dSafe = seed();
  const rs = await health.fixAllSafe(dSafe.name);
  ok(rs.byType.hyphenVariants.fixed === 0 && rs.byType.hyphenVariants.partial === 1, '12.3 Fix-all-safe: the same', JSON.stringify(rs.byType.hyphenVariants));
}

// ── §13 Case is text ────────────────────────────────────────────────────────
section('§13 A line differing only in case is not lost-safe');
{
  const o = { sourceLabel: 'apple-inc', keepFolder: 'entities' };
  const k = '# Apple\n\nThe opening.\n\n## Key Facts\n- apple ships the iphone\n\n## Notes\nsome prose here\n\n```\nmixed code\n```\n';
  const r = '# APPLE\n\nTHE OPENING.\n\n## Key facts\n- Apple ships the iPhone\n\n## Notes\nSOME PROSE HERE\n\n```\nMIXED code\n```\n';
  const m = composeMergedPage(k, r, o);
  for (const line of ['# APPLE', 'THE OPENING.', 'Key facts', '- Apple ships the iPhone', 'SOME PROSE HERE', 'MIXED code']) {
    ok(m.includes(line), `13.1 "${line}" stays`, m);
  }
  ok(findLostLines(k, r, m).length === 0, '13.1 the guard finds nothing lost', JSON.stringify(findLostLines(k, r, m)));
  ok(composeMergedPage(m, r, o) === m, '13.1 a second merge adds nothing');
  ok(m.startsWith(k.slice(0, k.indexOf('## Key Facts'))) && m.includes('## Key Facts\n- apple ships the iphone'), '13.1 the kept page is untouched', m);

  // The dumb check on its own: it must not excuse case, wherever the line is.
  for (const [label, kept, removed, merged] of [
    ['a bullet', '# K\n', '# K\n\n- Name Here\n', '# K\n\n- name here\n'],
    ['prose', '# K\n', '# K\n\nProper Noun.\n', '# K\n\nproper noun.\n'],
    ['a title', '# k\n', '# K\n', '# k\n'],
    ['a kept line', '# K\n\nKept Text.\n', '', '# K\n\nkept text.\n'],
    ['a frontmatter line', '---\nk y: Value\n---\n# K\n', '', '---\nk y: value\n---\n# K\n'],
  ]) {
    ok(findLostLines(kept, removed, merged).length === 1, `13.2 the guard names ${label} that changed case`, JSON.stringify(findLostLines(kept, removed, merged)));
  }
  ok(findLostLines('# K\n\n- [[alice]]\n', '- [[ALICE]]\n', '# K\n\n- [[alice]]\n').length === 0, '13.3 a bare repeat of one link, in another case, is one link');

  // Through the real deleting path.
  const d = mkDomain({ 'entities/nvidia.md': '# NVIDIA\n\nChips.\n', 'concepts/nvidia.md': '# Nvidia\n\nchips.\n' });
  const res = await health.fixIssue(d.name, 'crossFolderDupes', { keep: 'entities/nvidia.md', remove: 'concepts/nvidia.md' });
  const kept = d.read('entities/nvidia.md');
  ok(res.fixed === 1 && kept.includes('Nvidia') && kept.includes('chips.') && kept.startsWith('# NVIDIA\n\nChips.\n'), '13.4 fixIssue: both spellings survive the delete', kept);

  // A page already holding both, in an accumulating section, stays writable by ingest.
  const dw = mkDomain({ 'concepts/both.md': '# Both\n\n## Key Facts\n- Foo Bar\n- foo bar\n' });
  const rec = await writePage(dw.name, 'concepts/both.md', '# Both\n\n## Key Facts\n- walruses dive across wide unfamiliar plains\n');
  const onDisk = dw.read('concepts/both.md');
  ok(rec && onDisk.includes('- Foo Bar') && onDisk.includes('- foo bar') && onDisk.includes('walruses'), '13.5 writePage keeps both lines and takes the new one', onDisk);

  // Reuse still treats a model's reworded capitalisation as a repeat: nothing was on disk to lose.
  const reuse = composeReusedPage('# K\n\n## Key Facts\n- Foo Bar\n', '# K\n\n## Key Facts\n- foo bar\n', { keepFolder: 'concepts', dropped: [] });
  ok(reuse === '# K\n\n## Key Facts\n- Foo Bar\n', '13.6 reuse: the same words in another case add nothing', reuse);
}

// ── §14 Windows device names ────────────────────────────────────────────────
section('§14 A name Windows keeps for a device is never created');
{
  for (const name of ['con', 'CON', 'Con', 'prn', 'aux', 'nul', 'com1', 'COM9', 'lpt1', 'LPT9', 'com0', 'con.txt', 'nul.backup', 'aux.tar.gz', 'conin$', 'conout$', 'com\u00b9']) {
    ok(isWindowsReservedName(name), `14.1 ${name} is reserved`);
  }
  for (const name of ['console', 'con-artist', 'aux-power', 'auxiliary', 'null', 'nullable', 'com10', 'com', 'lpt', 'lpt10', 'prns', 'x.con', 'icon', 'conin', '']) {
    ok(!isWindowsReservedName(name), `14.1 ${JSON.stringify(name)} is not`);
  }
  ok(!isWindowsReservedName(undefined), '14.1 not a string is not reserved');

  const d = mkDomain({});
  for (const rel of ['concepts/con.md', 'concepts/NUL.md', 'entities/aux.md', 'entities/com1.md', 'summaries/lpt1.md', 'concepts/con.txt.md', 'concepts/prn']) {
    const warnings = [];
    const rec = await writePage(d.name, rel, '# Title\n\nThe text.\n', { onWarn: (w) => warnings.push(w) });
    ok(rec === null, `14.2 ${rel}: not written`, JSON.stringify(rec));
    ok(!d.has(rel.endsWith('.md') ? rel : `${rel}.md`), `14.2 ${rel}: no file`);
    ok(warnings.some((w) => /Windows keeps the name/.test(w) && /not saved/.test(w)), `14.2 ${rel}: the user is told`, JSON.stringify(warnings));
  }
  const ordinary = await writePage(d.name, 'concepts/console.md', '# Console\n\nA word.\n');
  ok(ordinary && d.has('concepts/console.md'), '14.3 a name that only begins the same is written');

  // A page already there stays usable, and is not deleted or renamed.
  const existing = mkDomain({ 'concepts/con.md': '# Con\n\nOriginal text.\n\n## Key Facts\n- first\n' });
  const rec = await writePage(existing.name, 'concepts/con.md', '# Con\n\n## Key Facts\n- walruses dive across wide unfamiliar plains\n');
  ok(rec && existing.read('concepts/con.md').includes('Original text.') && existing.read('concepts/con.md').includes('walruses'), '14.4 an existing page is still updated', JSON.stringify(rec));
  const scan = await health.scanWiki(existing.name);
  ok(scan && existing.has('concepts/con.md'), '14.4 and Health leaves it alone');
  const merging = mkDomain({ 'entities/aux.md': '# Aux\n\nA.\n', 'concepts/aux.md': '# Aux\n\nB.\n' });
  const rMerge = await health.fixIssue(merging.name, 'crossFolderDupes', { keep: 'entities/aux.md', remove: 'concepts/aux.md' });
  ok(rMerge.fixed === 1 && merging.read('entities/aux.md').includes('B.'), '14.4 and can still be merged', JSON.stringify(rMerge));

  // A redirect onto an existing page is not a new name.
  const redirected = mkDomain({ 'concepts/null.md': '# Null\n\nThe value.\n' });
  ok(await writePage(redirected.name, 'concepts/null.md', '# Null\n\nThe value.\n') !== null, '14.5 `null` is an ordinary page');
}

// ── §15 What a repair may touch ─────────────────────────────────────────────
section('§15 A repair stays out of code fences and other tools\' folders');
{
  const FENCED = '# P\n\nSee [[concepts/rag]].\n\n```\n[[concepts/in-code]] and [[concepts/rag]]\n```\n\n~~~md\n[[entities/x]]\n```\nstill code [[concepts/rag]]\n~~~\n\nAfter [[concepts/rag|the rag]].\n';
  const WANT = FENCED.replace('See [[concepts/rag]]', 'See [[rag]]').replace('After [[concepts/rag|the rag]]', 'After [[rag|the rag]]');
  const OTHER = 'Old [[concepts/rag]] and [[ragg]].\n';
  const d = mkDomain({ 'concepts/rag.md': '# Rag\n\nA page.\n', 'entities/page.md': FENCED, 'concepts/un.md': '# U\n\n```\n[[concepts/rag]]\n\nA fence that never closes [[concepts/rag]].\n' });
  for (const rel of ['.obsidian/plugins/dv/README.md', '.trash/Deleted Note.md']) {
    mkdirSync(path.dirname(path.join(d.wiki, rel)), { recursive: true });
    writeFileSync(path.join(d.wiki, rel), OTHER);
  }
  const report = await health.scanWiki(d.name);
  ok(report.folderPrefixLinks.every((r) => r.sourceFile === 'entities/page.md' && r.linkText === 'concepts/rag'), '15.1 the scan lists only links outside fences and dot-folders', JSON.stringify(report.folderPrefixLinks));
  ok(!report.brokenLinks.some((r) => r.linkText.includes('in-code') || r.linkText === 'entities/x' || r.sourceFile.startsWith('.')), '15.1 and calls nothing there broken', JSON.stringify(report.brokenLinks));
  const r = await health.fixIssue(d.name, 'folderPrefixLinks');
  ok(r.fixed >= 1, '15.2 the repair ran', JSON.stringify(r));
  ok(d.read('entities/page.md') === WANT, '15.2 outside the fence is repaired, inside is byte for byte', d.read('entities/page.md'));
  ok(d.read('.obsidian/plugins/dv/README.md') === OTHER && d.read('.trash/Deleted Note.md') === OTHER, '15.2 dot-folders are untouched');
  ok(d.read('concepts/un.md').includes('A fence that never closes [[concepts/rag]].'), '15.2 an unclosed fence runs to the end of the page');

  const crafted = await health.fixIssue(d.name, 'folderPrefixLinks', { sourceFile: '.trash/Deleted Note.md', linkText: 'concepts/rag' });
  ok(crafted.fixed === 0 && d.read('.trash/Deleted Note.md') === OTHER, '15.3 a request naming a dot-folder is refused', JSON.stringify(crafted));
  const craftedB = await health.fixIssue(d.name, 'brokenLinks', { sourceFile: '.trash/Deleted Note.md', linkText: 'ragg', suggestedTarget: 'rag' });
  ok(craftedB.fixed === 0 && d.read('.trash/Deleted Note.md') === OTHER, '15.3 the same for a broken link', JSON.stringify(craftedB));

  const d2 = mkDomain({ 'concepts/rag.md': '# Rag\n\nA page.\n', 'entities/b.md': '# B\n\n[[ragg]]\n\n```\n[[ragg]]\n```\n' });
  const rb = await health.fixIssue(d2.name, 'brokenLinks', { sourceFile: 'entities/b.md', linkText: 'ragg', suggestedTarget: 'rag' });
  ok(rb.fixed === 1 && d2.read('entities/b.md') === '# B\n\n[[rag]]\n\n```\n[[ragg]]\n```\n', '15.4 a broken-link repair leaves the fence', d2.read('entities/b.md'));
  await health.applyBrokenLinkFixes(d2.name, [{ linkText: 'ragg', action: 'strip' }]);
  ok(d2.read('entities/b.md').includes('```\n[[ragg]]\n```'), '15.4 and a plan-based fix does too', d2.read('entities/b.md'));
  const d2b = mkDomain({ 'entities/c.md': '# C\n\n[[gone]]\n\n```\n[[gone]]\n```\n' });
  await health.applyBrokenLinkFixes(d2b.name, [{ linkText: 'gone', action: 'strip' }]);
  ok(d2b.read('entities/c.md') === '# C\n\ngone\n\n```\n[[gone]]\n```\n', '15.4 outside it is stripped, inside it is not', d2b.read('entities/c.md'));

  // A merge skips other tools' folders as well.
  const d3 = mkDomain({ 'entities/same.md': '# S\n\nA.\n', 'concepts/same.md': '# S\n\nB.\n' });
  mkdirSync(path.join(d3.wiki, '.trash'), { recursive: true });
  writeFileSync(path.join(d3.wiki, '.trash/n.md'), '[[concepts/same]]\n');
  await health.fixIssue(d3.name, 'crossFolderDupes', { keep: 'entities/same.md', remove: 'concepts/same.md' });
  ok(d3.read('.trash/n.md') === '[[concepts/same]]\n', '15.5 a merge does not repoint inside .trash');
}

// ── §16 The two model-read sources agree on which page stays ────────────────
section('§16 The tool description and the skill do not say the longer page is kept');
{
  const { fixWikiIssueDefinition } = await import(path.join(REPO, 'mcp/tools/health.js'));
  const skill = readFileSync(path.join(REPO, 'skills/my-curator/SKILL.md'), 'utf8');
  for (const [label, text] of [['description', fixWikiIssueDefinition.description], ['skill', skill]]) {
    ok(!/whichever is longer/.test(text), `16.1 ${label}: no "whichever is longer"`);
    ok(/however long the other/.test(text), `16.1 ${label}: says length plays no part`);
    ok(/merge-not-related/.test(text), `16.1 ${label}: names the refusal`);
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
