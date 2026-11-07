#!/usr/bin/env node
/**
 * test-tidy-links-skip-fences.js — OFFLINE. Ingest's (and compile's) post-write
 * link tidy, `tidyWrittenLinks`, leaves code fences and YAML frontmatter
 * byte-identical and still tidies the links in the body.
 *
 * WHY. A link inside a fence is an example the model or the user wrote on
 * purpose (`[[concepts/rag]]` in a "how to link" snippet), and frontmatter is
 * metadata other tools parse. Before this suite the tidy rewrote both: the
 * by-name pass, the folder-prefix and `.md` passes, and the variant passes all
 * ran over the whole file. Health's repairs already stayed out of fences
 * (`fenceRuns` in files.js, shared with health.js); this is the same rule on
 * the ingest path. The dedup that follows the rewrite must not let an
 * untouched fenced or frontmatter bullet "hold" a key and drop a body bullet.
 *
 * Every expected page is typed out by hand below: no module parser decides
 * what the right answer is.
 *
 * Isolated: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR set before any
 * app import, plus __setDomainsDirOverride. Never touches a real domain.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? '\n' + String(detail).slice(0, 1500) : ''}`); }
}

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-tidy-fences-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');
delete process.env.DOMAINS_PATH;

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const { tidyWrittenLinks } = await import('../src/brain/files.js');

const DOMAIN = 'tidy';
const WIKI = path.join(DOMAINS, DOMAIN, 'wiki');
for (const d of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(WIKI, d), { recursive: true });
writeFileSync(path.join(WIKI, 'entities', 'model-context-protocol.md'), '# Model Context Protocol\n');
writeFileSync(path.join(WIKI, 'concepts', 'rag.md'), '# RAG\n');

const put = (rel, text) => writeFileSync(path.join(WIKI, rel), text);
const get = (rel) => readFileSync(path.join(WIKI, rel), 'utf8');
const diff = (want, got) => `--- want ---\n${want}\n--- got ---\n${got}`;

try {
  // ── 1. One page with every kind of block ───────────────────────────────────
  console.log('\n── 1. fences and frontmatter stay, the body is tidied ──');
  const FM = [
    '---',
    'type: summary',
    'related: "[[Model Context Protocol]]"',
    'see: [[concepts/rag]]',
    'file: [[RAG.md]]',
    '---',
  ].join('\n');
  const BACKTICK = [
    '```markdown',
    'See [[Model Context Protocol]] and [[concepts/rag]] and [[RAG.md]].',
    '- [[Model Context Protocol]]',
    '```',
  ].join('\n');
  const TILDE = [
    '~~~',
    'Link with [[entities/model-context-protocol]] or [[Model Context Protocol]].',
    '~~~',
  ].join('\n');
  const INDENTED = [
    '  ```',
    '  Indented: [[concepts/rag]] and [[Model Context Protocol]]',
    '  ```',
  ].join('\n');
  const LONG = [
    '````',
    '```',
    'Inner fence line is not a close: [[concepts/rag]]',
    '```',
    'Still fenced: [[RAG.md]]',
    '````',
  ].join('\n');
  const UNCLOSED = [
    '```',
    'An unclosed fence runs to the end: [[Model Context Protocol]] [[concepts/rag]]',
  ].join('\n');

  const before = [
    FM,
    '# A summary',
    '',
    'The body names [[Model Context Protocol]] and [[concepts/rag]] and [[RAG.md]].',
    '',
    BACKTICK,
    '',
    'Between fences: [[entities/model-context-protocol]].',
    '',
    TILDE,
    '',
    INDENTED,
    '',
    LONG,
    '',
    '## Entities Mentioned',
    '- [[Model Context Protocol]]',
    '',
    UNCLOSED,
    '',
  ].join('\n');
  const want = [
    FM,
    '# A summary',
    '',
    'The body names [[model-context-protocol|Model Context Protocol]] and [[rag]] and [[rag]].',
    '',
    BACKTICK,
    '',
    'Between fences: [[model-context-protocol]].',
    '',
    TILDE,
    '',
    INDENTED,
    '',
    LONG,
    '',
    '## Entities Mentioned',
    '- [[model-context-protocol]]',
    '',
    UNCLOSED,
    '',
  ].join('\n');
  put('summaries/all.md', before);
  const n1 = await tidyWrittenLinks(DOMAIN, ['summaries/all.md']);
  const got1 = get('summaries/all.md');
  ok(got1 === want, '1.1 the page equals the hand-written result', diff(want, got1));
  ok(got1.startsWith(FM + '\n'), '1.2 frontmatter is byte-identical');
  for (const [name, block] of [['backtick', BACKTICK], ['tilde', TILDE], ['indented', INDENTED], ['four-backtick', LONG], ['unclosed', UNCLOSED]]) {
    ok(got1.includes(block), `1.3 the ${name} fence is byte-identical`);
  }
  ok(n1 === 1, '1.4 the page counts as changed', n1);
  const n1b = await tidyWrittenLinks(DOMAIN, ['summaries/all.md']);
  ok(n1b === 0 && get('summaries/all.md') === want, '1.5 a second run changes nothing');

  // ── 2. A page that is only fences and frontmatter is not written at all ──
  console.log('\n── 2. nothing to tidy outside the blocks: no write ──');
  const onlyBlocks = [FM, '# Code only', '', BACKTICK, '', TILDE, ''].join('\n');
  put('summaries/only.md', onlyBlocks);
  const n2 = await tidyWrittenLinks(DOMAIN, ['summaries/only.md']);
  ok(n2 === 0, '2.1 reported unchanged', n2);
  ok(get('summaries/only.md') === onlyBlocks, '2.2 byte-identical', diff(onlyBlocks, get('summaries/only.md')));

  // ── 3. The dedup: a fenced or frontmatter bullet never drops a body bullet ──
  console.log('\n── 3. the dedup ignores fenced and frontmatter bullets ──');
  const dedupBefore = [
    '---',
    'type: summary',
    'links:',
    '- [[model-context-protocol]]',
    '---',
    '- [[Model Context Protocol]]',
    '',
    '## Entities Mentioned',
    '```',
    '- [[rag]]',
    '# not a heading',
    '- [[model-context-protocol]]',
    '```',
    '- [[RAG.md]]',
    '- [[Model Context Protocol]]',
    '',
  ].join('\n');
  const dedupWant = [
    '---',
    'type: summary',
    'links:',
    '- [[model-context-protocol]]',
    '---',
    '- [[model-context-protocol]]',
    '',
    '## Entities Mentioned',
    '```',
    '- [[rag]]',
    '# not a heading',
    '- [[model-context-protocol]]',
    '```',
    '- [[rag]]',
    '- [[model-context-protocol]]',
    '',
  ].join('\n');
  put('summaries/dedup.md', dedupBefore);
  await tidyWrittenLinks(DOMAIN, ['summaries/dedup.md']);
  const got3 = get('summaries/dedup.md');
  ok(got3 === dedupWant, '3.1 body bullets kept, blocks byte-identical', diff(dedupWant, got3));

  // ── 4. The dedup still works in the body ─────────────────────────────────
  console.log('\n── 4. two body spellings of one link still become one row ──');
  const bodyDup = [
    '## Entities Mentioned',
    '- [[model-context-protocol]]',
    '- [[Model Context Protocol]]',
    '',
  ].join('\n');
  put('summaries/bodydup.md', bodyDup);
  await tidyWrittenLinks(DOMAIN, ['summaries/bodydup.md']);
  const want4 = ['## Entities Mentioned', '- [[model-context-protocol]]', ''].join('\n');
  ok(get('summaries/bodydup.md') === want4, '4.1 one row', diff(want4, get('summaries/bodydup.md')));

  // ── 5. CRLF pages ───────────────────────────────────────────────────────
  console.log('\n── 5. CRLF ──');
  const crlf = ['---', 'see: [[concepts/rag]]', '---', 'Body [[concepts/rag]].', '```', '[[concepts/rag]]', '```', ''].join('\r\n');
  const crlfWant = ['---', 'see: [[concepts/rag]]', '---', 'Body [[rag]].', '```', '[[concepts/rag]]', '```', ''].join('\r\n');
  put('summaries/crlf.md', crlf);
  await tidyWrittenLinks(DOMAIN, ['summaries/crlf.md']);
  ok(get('summaries/crlf.md') === crlfWant, '5.1 CRLF frontmatter and fence kept, body tidied', diff(JSON.stringify(crlfWant), JSON.stringify(get('summaries/crlf.md'))));

  // ── 6. A page opening with a rule that is not frontmatter keeps its tidy ──
  console.log('\n── 6. no frontmatter: the whole body is tidied ──');
  const plain = ['# Title', '', 'See [[concepts/rag]].', ''].join('\n');
  put('summaries/plain.md', plain);
  await tidyWrittenLinks(DOMAIN, ['summaries/plain.md']);
  ok(get('summaries/plain.md') === ['# Title', '', 'See [[rag]].', ''].join('\n'), '6.1 tidied');
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
