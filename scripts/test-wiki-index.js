#!/usr/bin/env node
/**
 * scripts/test-wiki-index.js — OFFLINE
 *
 * src/brain/wiki-index.js (v3.83.0): index.md as data. The pure parser,
 * resolver, coverage, rebuild composer and add-only merge, plus the small fs
 * wrapper (readPageInventory / ensurePagesInIndex) that ingest, compile and
 * the MCP's compile_to_wiki call after every write.
 *
 * WHY. index.md had drifted on every real wiki: 2,705 of 3,472 articles pages
 * had no row, because the merge only added rows for status === 'created' and
 * matched rows by BASENAME (a concept and a summary sharing a slug looked
 * indexed when only one was). The claims this file pins, each behaviourally:
 *
 *  §1 helpers — cellSafe, compareSlugs (code units, NEVER localeCompare),
 *     linkFor / rowFor, isLinkableSlug.
 *  §2 parse — every row shape in the wild and in code (alias, escaped alias,
 *     anchor, escaped pipe, no trailing pipe, prefixed link, legacy vs
 *     sectioned, `## New pages`, prose, a non-page table, CRLF).
 *  §3 coverage by CANONICAL PATH (the Health rule), with stale, duplicate,
 *     repointable, unlinkable and unaddressable pages.
 *  §4 rebuild — descriptions byte-for-byte, stale out, duplicates merged
 *     first-wins, repoints keep their description, prose kept in order, type
 *     cells corrected, idempotent, sorted by code unit; a DUMB cross-check (a
 *     plain regex over the output, not the parser) that every addressable page
 *     appears exactly once; a large synthetic fixture.
 *  §5 ensureRowsInIndex — add-only, sorted insert, legacy append, fresh header,
 *     Last updated only on add, null when nothing to add, existing lines
 *     byte-identical and in order, idempotent; ensure-then-rebuild agreement.
 *  §6 deriveDescription — no `## Overview` leak, no `[[`, ≤160, no `|`.
 *  §7 indexEntriesFrom — every status, aligned with pages[i].
 *  §8 fs wrapper on an isolated domains dir — inventory filtering, ensure
 *     derives from disk, re-reads index.md at merge time, creates a missing
 *     index, writes nothing when nothing is missing, and never writes stdout.
 *
 * Fixtures are synthetic and live in a temp dir (CURATOR_TEST_USER_DATA_DIR
 * set before any src/brain import; __setDomainsDirOverride for domains). The
 * real domains/ is never read or written.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'fs';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-wiki-index-'));
const ROOT = path.join(TMP, 'domains');
const USER_DATA = path.join(TMP, 'user-data');
mkdirSync(ROOT, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
const W = await import(path.join(REPO, 'src/brain/wiki-index.js'));
const {
  INDEX_TABLE_HEADER, INDEX_TABLE_SEPARATOR, INDEX_DESCRIPTION_MAX, INDEX_SECTIONS,
  cellSafe, compareSlugs, linkFor, rowFor, isLinkableSlug, buildInventory, parseIndex,
  resolveTarget, indexCoverage, deriveDescription, ensureRowsInIndex, rebuildIndexText,
  indexEntriesFrom, readPageInventory, ensurePagesInIndex,
} = W;

let passed = 0;
let failed = 0;
function assert(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`); }
const sha = (s) => createHash('sha256').update(s).digest('hex');
const TODAY = '2026-10-26';

/** DUMB row reader: a plain regex, deliberately not the module's parser. */
function dumbRows(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\| \[\[([^\]]+)\]\] \| ([a-z]+) \| (.*) \|$/.exec(line);
    if (m) out.push({ link: m[1], type: m[2], description: m[3] });
  }
  return out;
}
/** DUMB expected key for a canonical path, by string surgery alone. */
function dumbKey(p) {
  const [folder, name] = p.split('/');
  const slug = name.replace(/\.md$/, '');
  const type = folder === 'entities' ? 'entity' : folder === 'concepts' ? 'concept' : 'summary';
  return `${type}:${folder === 'summaries' ? 'summaries/' + slug : slug}`;
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('§1 helpers');
  {
    assert(INDEX_TABLE_HEADER === '| Page | Type | Summary |' && INDEX_TABLE_SEPARATOR === '|------|------|---------|',
      '1.1 table header and separator constants');
    assert(INDEX_DESCRIPTION_MAX === 160 && INDEX_SECTIONS.map((s) => s.folder).join() === 'summaries,entities,concepts'
      && Object.isFrozen(INDEX_SECTIONS), '1.2 description cap 160; sections Summaries, Entities, Concepts (frozen)');
    assert(cellSafe('a | b\nc\r\nd   e') === 'a b c d e', '1.3 cellSafe: pipes/CR/LF → space, whitespace collapsed');
    assert(cellSafe(null) === '' && cellSafe(undefined) === '', '1.4 cellSafe(null|undefined) → ""');
    const long = cellSafe('x'.repeat(400));
    assert(long.length === 160, '1.5 cellSafe caps at 160');
    const emoji = cellSafe('a'.repeat(159) + '😀tail');
    assert(emoji.length === 159 && !/[\ud800-\udbff]$/.test(emoji), '1.6 cellSafe never splits a surrogate pair at the cap');

    const words = ['é', 'Z', 'a', '_x', 'B', 'b'];
    const sorted = [...words].sort(compareSlugs);
    assert(JSON.stringify(sorted) === JSON.stringify(['_x', 'a', 'B', 'b', 'Z', 'é']),
      '1.7 compareSlugs: case-folded UTF-16 code units, ties by raw code unit (B before b)', JSON.stringify(sorted));
    // Dumb cross-check: a hand-rolled code-unit comparison over the lowercased strings.
    const dumb = [...words].sort((x, y) => {
      const a = x.toLowerCase(), b = y.toLowerCase();
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (a.charCodeAt(i) !== b.charCodeAt(i)) return a.charCodeAt(i) - b.charCodeAt(i);
      }
      if (a.length !== b.length) return a.length - b.length;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    assert(JSON.stringify(sorted) === JSON.stringify(dumb), '1.8 compareSlugs agrees with a hand-rolled charCodeAt comparison');
    const locale = [...words].sort((x, y) => x.localeCompare(y));
    assert(JSON.stringify(sorted) !== JSON.stringify(locale),
      '1.9 the fixture DISTINGUISHES code-unit order from localeCompare (so a localeCompare regression goes red)', JSON.stringify(locale));

    assert(linkFor('entities/x.md') === 'x' && linkFor('concepts/x.md') === 'x' && linkFor('summaries/x.md') === 'summaries/x',
      '1.10 linkFor: bare for entities/concepts, summaries/ prefixed');
    assert(rowFor('concepts/llm.md', 'Large | language\nmodels') === '| [[llm]] | concept | Large language models |',
      '1.11 rowFor: type from folder, description cell-safe');
    assert(rowFor('summaries/s.md', '') === '| [[summaries/s]] | summary |  |', '1.12 rowFor with an empty description');
    let threw = false; try { linkFor('index.md'); } catch { threw = true; }
    assert(threw, '1.13 linkFor refuses a non-page path');
    assert(isLinkableSlug('ok-slug') && isLinkableSlug('café') && isLinkableSlug('a.b'), '1.14 ordinary slugs are linkable');
    assert(![' lead', 'trail ', 'a|b', 'a[b', 'a]b', 'a#b', 'a^b', 'a\nb', ''].some(isLinkableSlug),
      '1.15 leading/trailing space, | [ ] # ^ newline and "" are unlinkable');
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§2 parseIndex — row shapes');
  {
    const text = [
      '# Wiki Index — Shapes',
      'Last updated: 2026-01-01',
      '',
      'Intro prose line.',
      '',
      '| Page | Type | Summary |',
      '|---|---|---|',
      '| [[plain]] | concept | Plain description |',
      '| [[aliased|Shown]] | entity | Raw-pipe alias |',
      '| [[esc\\|Shown]] | entity | Table-escaped alias |',
      '| [[anch#Heading]] | concept | With anchor |',
      '| [[pipey]] | concept | a \\| b inside |',
      '| [[notrail]] | concept | no trailing pipe',
      '| [[entities/pref]] | entity | Prefixed |',
      '| [[summaries/sum]] | summary | A summary |',
      '| [[a]] and [[b]] | concept | not a page row |',
      '| [[  spaced  ]] | concept | trimmed target |',
      '',
      '## Notes',
      '',
      'Some notes.',
      '| Name | Value |',
      '|---|---|',
      '| k | v |',
      '',
      '## New pages',
      '',
      '| Page | Type | Summary |',
      '|---|---|---|',
      '| [[later]] | concept | From the fallback |',
      '',
    ].join('\n');
    const p = parseIndex(text);
    const by = new Map(p.rows.map((r) => [r.target, r]));
    assert(p.title && p.title.text === '# Wiki Index — Shapes' && p.lastUpdated && p.lastUpdated.line === 1,
      '2.1 title and Last updated found');
    assert(by.get('plain')?.description === 'Plain description' && by.get('plain')?.typeCell === 'concept', '2.2 plain row');
    assert(by.get('aliased')?.alias === 'Shown' && by.get('aliased')?.description === 'Raw-pipe alias',
      '2.3 [[x|y]]: target x, alias y, description intact');
    assert(by.get('esc')?.alias === 'Shown' && by.get('esc')?.description === 'Table-escaped alias',
      '2.4 [[x\\|y]]: the table-escaped alias form', JSON.stringify(by.get('esc')));
    assert(by.get('anch')?.anchor === 'Heading', '2.5 [[x#h]]: anchor split off');
    assert(by.get('pipey')?.description === 'a \\| b inside', '2.6 an escaped pipe stays inside the description');
    assert(by.get('notrail')?.description === 'no trailing pipe', '2.7 a row without a trailing pipe is accepted');
    assert(by.has('entities/pref') && by.has('summaries/sum'), '2.8 prefixed targets kept as written');
    assert(!p.rows.some((r) => r.target === 'a' || r.target === 'b'), '2.9 a first cell with two links is not a page row');
    assert(by.has('spaced'), '2.10 target whitespace trimmed');
    assert(by.has('later'), '2.11 rows under "## New pages" are parsed');
    assert(p.rows.length === 10, '2.12 ten page rows (the two-link line is not one)', String(p.rows.length));
    const notes = p.blocks.find((b) => b.headingText === '## Notes');
    const newPages = p.blocks.find((b) => b.headingText === '## New pages');
    assert(notes && !notes.absorbable, '2.13 a block with prose and a non-page table is NOT absorbable');
    assert(newPages && newPages.absorbable && newPages.sectionFolder === null, '2.14 "## New pages" is absorbable (only a page table)');
    assert(!p.sectioned, '2.15 legacy single-table index is not "sectioned"');
    const nonPage = p.lines.findIndex((l) => l === '| k | v |');
    assert(nonPage > 0 && !p.pageTableLines.has(nonPage) && !p.pageTableLines.has(nonPage - 2),
      '2.16 a non-page table\'s lines are not page-table lines');

    const sectioned = '# T\nLast updated: x\n\n## Summaries\n\n' + INDEX_TABLE_HEADER + '\n' + INDEX_TABLE_SEPARATOR +
      '\n\n## Entities\n\n' + INDEX_TABLE_HEADER + '\n' + INDEX_TABLE_SEPARATOR + '\n| [[e]] | entity | E |\n';
    const ps = parseIndex(sectioned);
    assert(ps.sectioned && ps.blocks.some((b) => b.sectionFolder === 'summaries') && ps.blocks.some((b) => b.sectionFolder === 'entities'),
      '2.17 sectioned index: empty and non-empty section tables both recognised');

    const crlf = parseIndex('# T\r\n| Page | Type | Summary |\r\n|---|---|---|\r\n| [[c]] | concept | CRLF desc |\r\n');
    assert(crlf.rows.length === 1 && crlf.rows[0].description === 'CRLF desc', '2.18 CRLF lines parse; no \\r in the description');
    assert(parseIndex('').rows.length === 0 && parseIndex(null).blocks.length === 1, '2.19 empty / null text parse to nothing');
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§3 resolution and coverage by canonical path');
  {
    const inv = buildInventory({
      entities: ['alice.md', 'shared.md', 'notes.txt'],
      concepts: ['x.md', 'shared.md', 'rag.md', ' leading.md', 'only-c.md'],
      summaries: ['x.md', 'lonely.md', 'trail .md'],
    });
    assert(!inv.all.includes('entities/notes.txt'), '3.1 non-.md files are not pages');
    assert(inv.unlinkable.join() === 'summaries/trail .md,concepts/ leading.md', '3.2 unlinkable listed', inv.unlinkable.join());
    assert(inv.unaddressable.join() === 'concepts/shared.md', '3.3 concepts/x with entities/x is unaddressable', inv.unaddressable.join());
    assert(!inv.paths.includes('concepts/shared.md') && inv.paths.includes('summaries/x.md') && inv.paths.includes('concepts/x.md'),
      '3.4 addressable paths include both sides of a summary/concept collision');

    const r = (t) => resolveTarget(t, inv);
    assert(r('alice').path === 'entities/alice.md' && !r('alice').repointed, '3.5 bare → entities');
    assert(r('rag').path === 'concepts/rag.md', '3.6 bare → concepts when no entity');
    assert(r('shared').path === 'entities/shared.md', '3.7 bare collision → the entity (the Health rule)');
    assert(r('summaries/x').path === 'summaries/x.md' && r('summaries/x').link === 'summaries/x', '3.8 summaries/x → summaries');
    assert(r('x').path === 'concepts/x.md', '3.9 bare x with concepts/x and summaries/x → concepts/x');
    assert(r('lonely').path === 'summaries/lonely.md' && r('lonely').repointed && r('lonely').link === 'summaries/lonely',
      '3.10 bare x with only summaries/x → REPOINT to [[summaries/x]]');
    assert(r('entities/rag').path === 'concepts/rag.md' && r('entities/rag').repointed && r('entities/rag').link === 'rag',
      '3.11 prefixed entities/x → bare canonical, repointed to [[x]]');
    assert(r('concepts/alice').path === 'entities/alice.md' && r('concepts/alice').link === 'alice', '3.12 prefixed concepts/x → bare canonical');
    assert(r('entities/lonely').path === null, '3.13 prefixed link to a summary-only slug is stale (no cross repoint)');
    assert(r('nope').path === null && r('foo/alice').path === null && r('summaries/a/b').path === null, '3.14 unknown targets are stale');
    assert(r('leading').path === null && r(' leading').path === null, '3.15 an unlinkable file is never covered');
    assert(r('ALICE').path === null, '3.16 no case folding / fuzzy matching');

    // NFC: an NFD target resolves to an NFC filename and vice versa.
    const nfcName = 'café', nfdName = 'café';
    const inv2 = buildInventory({ concepts: [nfcName + '.md'], entities: [], summaries: [] });
    assert(resolveTarget(nfdName, inv2).path === `concepts/${nfcName}.md`, '3.17 targets compare NFC-normalised');

    // THE canonical-path claim (C2): [[x]] + concepts/x + summaries/x → summaries/x missing.
    const parsed = parseIndex('| Page | Type | Summary |\n|---|---|---|\n| [[x]] | concept | The concept |\n');
    const cov = indexCoverage(parsed, buildInventory({ concepts: ['x.md'], summaries: ['x.md'] }));
    assert(cov.missing.length === 1 && cov.missing[0] === 'summaries/x.md',
      '3.18 [[x]] covers concepts/x.md ONLY — summaries/x.md is missing (canonical path, not basename)', JSON.stringify(cov.missing));

    const p2 = parseIndex([
      '| Page | Type | Summary |', '|---|---|---|',
      '| [[alice]] | person | First |',
      '| [[alice]] | entity | Second |',
      '| [[gone]] | concept | Gone page |',
      '| [[lonely]] | summary | Repointed one |',
      '| [[summaries/lonely]] | summary | Dup after repoint |',
      '| [[rag|RAG]] | concept | Aliased |',
    ].join('\n'));
    const c2 = indexCoverage(p2, inv);
    assert(c2.stale.map((x) => x.target).join() === 'gone', '3.19 stale = rows resolving to no file');
    assert(c2.duplicates.length === 2 && c2.covered.get('entities/alice.md') === p2.rows[0].line,
      '3.20 duplicates: the FIRST row covers, later ones are duplicates');
    assert(c2.repointable.length === 1 && c2.repointable[0].target === 'lonely', '3.21 repointable counted');
    assert(c2.typeCellsWrong === 1, '3.22 a wrong type cell ("person") counted on the kept row', String(c2.typeCellsWrong));
    assert(c2.aliasesDropped === 1, '3.23 aliases on kept rows counted');
    assert(JSON.stringify(c2.missing) === JSON.stringify(['summaries/x.md', 'entities/shared.md', 'concepts/only-c.md', 'concepts/x.md']),
      '3.24 missing in section order then compareSlugs', JSON.stringify(c2.missing));
    assert(c2.missing.includes('entities/shared.md'), '3.25 entities/shared.md is missing (no row names it)');
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§4 rebuildIndexText');
  {
    const inv = buildInventory({
      entities: ['alice.md', 'Zed.md', 'shared.md', '_under.md', 'émile.md'],
      concepts: ['x.md', 'shared.md', 'rag.md', ' leading.md', 'new-c.md'],
      summaries: ['x.md', 'lonely.md'],
    });
    const original = [
      '# Wiki Index — Fixture',
      'Last updated: 2026-01-01',
      '',
      'This index is maintained by The Curator.',
      '',
      '| Page | Type | Summary |',
      '|---|---|---|',
      '| [[rag]] | concept | Retrieval-augmented generation — kept  verbatim, even  odd spacing |',
      '| [[alice]] | company | Alice the author |',
      '| [[alice]] | entity | Duplicate of alice |',
      '| [[gone]] | concept | A page that was deleted |',
      '| [[lonely]] | summary | Repointed summary keeps this |',
      '| [[x|The X]] | concept | Concept x |',
      '| [[entities/Zed]] | entity | Zed via prefix |',
      '| [[esc]] | concept | a \\| b',
      '',
      '## Notes',
      '',
      'Keep this note.',
      '',
      '## New pages',
      '',
      '| Page | Type | Summary |',
      '|---|---|---|',
      '',
      '## Footer',
      'Footer line.',
      '',
    ].join('\n');
    const derived = new Map([
      ['summaries/x.md', 'Derived summary x'],
      ['entities/_under.md', 'Under | piped\nderived'],
      ['entities/émile.md', 'Émile derived'],
      ['entities/shared.md', 'Shared entity'],
      ['concepts/new-c.md', 'New concept'],
      // A derived description for a page that already HAS a row must be ignored.
      ['concepts/rag.md', 'SHOULD NOT REPLACE'],
    ]);
    const { text, summary, samples } = rebuildIndexText(original, inv, derived, { today: TODAY, displayName: 'Ignored' });
    const lines = text.split('\n');

    assert(lines[0] === '# Wiki Index — Fixture' && lines[1] === `Last updated: ${TODAY}`,
      '4.1 existing title kept; Last updated set to today');
    assert(text.endsWith('\n') && !text.endsWith('\n\n'), '4.2 ends with exactly one newline');
    assert(text.includes('| [[rag]] | concept | Retrieval-augmented generation — kept  verbatim, even  odd spacing |'),
      '4.3 an existing description is kept BYTE-FOR-BYTE (double spaces included), not re-derived');
    assert(!text.includes('SHOULD NOT REPLACE'), '4.4 a derived description never replaces an existing one');
    assert(text.includes('| [[alice]] | entity | Alice the author |') && !text.includes('Duplicate of alice'),
      '4.5 duplicate merged first-wins; type cell corrected company → entity');
    assert(!text.includes('[[gone]]') && !text.includes('[[esc]]'), '4.6 stale rows removed');
    assert(text.includes('| [[summaries/lonely]] | summary | Repointed summary keeps this |'),
      '4.7 a repointed row keeps its description');
    assert(text.includes('| [[x]] | concept | Concept x |') && !text.includes('The X'), '4.8 alias dropped, row kept');
    assert(text.includes('| [[Zed]] | entity | Zed via prefix |'), '4.9 prefixed [[entities/Zed]] repointed to [[Zed]]');
    assert(text.includes('| [[summaries/x]] | summary | Derived summary x |'), '4.10 collision: summaries/x gets its own row');
    assert(text.includes('| [[_under]] | entity | Under piped derived |'), '4.11 derived descriptions are cell-safe');
    assert(!text.includes('[[ leading]]') && !text.includes('leading'), '4.12 unlinkable page not written');
    assert((text.match(/\[\[shared\]\]/g) || []).length === 1 && text.includes('| [[shared]] | entity | Shared entity |'),
      '4.13 unaddressable concepts/shared not written; entities/shared once');

    const iS = lines.indexOf('## Summaries'), iE = lines.indexOf('## Entities'), iC = lines.indexOf('## Concepts');
    assert(iS > 0 && iS < iE && iE < iC, '4.14 sections in order Summaries, Entities, Concepts');
    assert(lines[iS + 2] === INDEX_TABLE_HEADER && lines[iS + 3] === INDEX_TABLE_SEPARATOR, '4.15 each section has the exact header');
    const entityRows = lines.slice(iE, iC).filter((l) => l.startsWith('| [[')).map((l) => /\[\[([^\]]+)\]\]/.exec(l)[1]);
    assert(JSON.stringify(entityRows) === JSON.stringify(['_under', 'alice', 'shared', 'Zed', 'émile']),
      '4.16 rows sorted by code unit (case-folded): _under, alice, shared, Zed, émile', JSON.stringify(entityRows));
    assert(lines.indexOf('This index is maintained by The Curator.') === 3 && lines[2] === '',
      '4.17 preamble prose kept, after the header');
    const iNotes = lines.indexOf('## Notes'), iFooter = lines.indexOf('## Footer');
    assert(iNotes > iC && iFooter > iNotes && lines.includes('Keep this note.') && lines.includes('Footer line.'),
      '4.18 prose blocks preserved verbatim, in original order, after the tables');
    assert(!text.includes('## New pages'), '4.19 an all-table "## New pages" block is absorbed (heading dropped)');

    assert(summary.indexExists === true && summary.rowsBefore === 8 && summary.rowsAfter === inv.paths.length,
      '4.20 summary rowsBefore/rowsAfter', JSON.stringify(summary));
    assert(summary.add === 5 && summary.addByFolder.summaries === 1 && summary.addByFolder.entities === 3 && summary.addByFolder.concepts === 1,
      '4.21 summary.add / addByFolder', JSON.stringify(summary.addByFolder));
    assert(summary.removeStale === 2 && summary.mergeDuplicates === 1 && summary.repoint === 2,
      '4.22 removeStale / mergeDuplicates / repoint');
    assert(summary.aliasesDropped === 1 && summary.typeCellsCorrected === 1, '4.23 aliasesDropped / typeCellsCorrected');
    assert(summary.keepDescriptions === 5 && summary.deriveDescriptions === 5 && summary.emptyDescriptions === 0,
      '4.24 keep / derive / empty description counts', JSON.stringify(summary));
    assert(summary.unlinkable === 1 && summary.unaddressable === 1 && summary.preservedProseLines === 5,
      '4.25 unlinkable / unaddressable / preservedProseLines', JSON.stringify(summary));
    assert(summary.bytesBefore === Buffer.byteLength(original) && summary.bytesAfter === Buffer.byteLength(text), '4.26 byte counts');
    assert(samples.add.length === 5 && samples.add[0].path === 'summaries/x.md' && samples.removeStale[0].target === 'gone'
      && samples.unlinkable[0] === 'concepts/ leading.md' && samples.unaddressable[0] === 'concepts/shared.md',
      '4.27 samples shapes', JSON.stringify(samples));

    // Idempotence.
    const again = rebuildIndexText(text, inv, new Map(), { today: TODAY });
    assert(again.text === text, '4.28 rebuild(rebuild(x)) === rebuild(x)');
    assert(again.summary.add === 0 && again.summary.removeStale === 0 && again.summary.typeCellsCorrected === 0
      && again.summary.repoint === 0 && again.summary.keepDescriptions === 10,
      '4.29 the second rebuild finds nothing to do and keeps all ten descriptions', JSON.stringify(again.summary));

    // Dumb cross-check: each addressable page exactly once, by plain regex.
    const counts = new Map();
    for (const row of dumbRows(text)) counts.set(`${row.type}:${row.link}`, (counts.get(`${row.type}:${row.link}`) || 0) + 1);
    const expected = inv.all.filter((p) => !inv.unlinkable.includes(p) && !inv.unaddressable.includes(p));
    assert(expected.every((p) => counts.get(dumbKey(p)) === 1) && [...counts.values()].reduce((a, b) => a + b, 0) === expected.length,
      '4.30 DUMB cross-check: every addressable page appears exactly once, and nothing else', JSON.stringify([...counts]));

    // Missing index.
    const fresh = rebuildIndexText(null, inv, new Map(), { today: TODAY, displayName: 'Fresh Domain' });
    assert(fresh.text.startsWith(`# Wiki Index — Fresh Domain\nLast updated: ${TODAY}\n\n## Summaries\n`) && fresh.summary.indexExists === false,
      '4.31 missing index.md: title from displayName, indexExists false');
    assert(fresh.summary.emptyDescriptions === inv.paths.length, '4.32 no derived text → empty description cells counted');
    const empty = rebuildIndexText('', buildInventory({}), new Map(), { today: TODAY, displayName: 'E' });
    assert(empty.text.split('\n').filter((l) => l === INDEX_TABLE_HEADER).length === 3,
      '4.33 an empty domain still gets all three section tables');

    // Real-shape header-only index (the research domain's shape) with no prose.
    const headerOnly = '# Wiki Index — Research\nLast updated: —\n\n| Page | Type | Summary |\n|------|------|---------|\n';
    const ho = rebuildIndexText(headerOnly, buildInventory({ concepts: ['a.md'] }), new Map([['concepts/a.md', 'A']]), { today: TODAY });
    assert(ho.text === `# Wiki Index — Research\nLast updated: ${TODAY}\n\n## Summaries\n\n${INDEX_TABLE_HEADER}\n${INDEX_TABLE_SEPARATOR}\n\n## Entities\n\n${INDEX_TABLE_HEADER}\n${INDEX_TABLE_SEPARATOR}\n\n## Concepts\n\n${INDEX_TABLE_HEADER}\n${INDEX_TABLE_SEPARATOR}\n| [[a]] | concept | A |\n`,
      '4.34 the exact rebuilt format (§2.3) on a header-only index', JSON.stringify(ho.text));
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§4b large synthetic fixture');
  {
    const ent = [], con = [], sum = [];
    for (let i = 0; i < 600; i++) ent.push(`entity-${String(i).padStart(4, '0')}.md`);
    for (let i = 0; i < 2800; i++) con.push(`concept-${String(i).padStart(4, '0')}.md`);
    for (let i = 0; i < 100; i++) sum.push(`summary-${String(i).padStart(3, '0')}.md`);
    for (let i = 0; i < 50; i++) { con.push(`collide-${i}.md`); sum.push(`collide-${i}.md`); }
    con.push(' gartner-a.md', ' gartner-b.md', 'ünïcode.md', 'Ångström.md');
    ent.push('ÉCOLE.md');
    const inv = buildInventory({ entities: ent, concepts: con, summaries: sum });
    const rows = [];
    for (let i = 0; i < 700; i++) rows.push(`| [[concept-${String(i).padStart(4, '0')}]] | concept | Concept ${i} has a long-ish description that pads the index ${'.'.repeat(400)} |`);
    for (let i = 0; i < 40; i++) rows.push(`| [[deleted-${i}]] | concept | stale ${i} |`);
    rows.push('| [[concept-0001]] | concept | duplicate |');
    for (let i = 0; i < 3; i++) rows.push(`| [[summary-00${i}]] | summary | bare summary ${i} |`);
    rows.push('| [[entity-0001|Entity One]] | entity | aliased |');
    rows.push('| [[entity-0002]] | entity | no trailing pipe');
    rows.push('| [[ünïcode]] | concept | non-ascii |');
    for (let i = 0; i < 50; i++) rows.push(`| [[collide-${i}]] | concept | collision concept ${i} |`);
    const big = `# Wiki Index — Large\nLast updated: 2026-05-04\n\n| Page | Type | Summary |\n|---|---|---|\n${rows.join('\n')}\n`;
    assert(big.length > 300_000, '4b.1 fixture index is large', String(big.length));
    const t0 = Date.now();
    const parsed = parseIndex(big);
    const cov = indexCoverage(parsed, inv);
    const r1 = rebuildIndexText(big, inv, new Map(cov.missing.map((p) => [p, `Derived ${p}`])), { today: TODAY });
    const ms = Date.now() - t0;
    assert(cov.stale.length === 40 && cov.duplicates.length === 1 && cov.repointable.length === 3,
      '4b.2 stale 40, duplicate 1, repointable 3', JSON.stringify([cov.stale.length, cov.duplicates.length, cov.repointable.length]));
    assert(inv.unlinkable.length === 2, '4b.3 two leading-space filenames unlinkable');
    // Dumb counts: pages on disk minus unlinkable minus rows that cover something.
    const expectedMissing = (600 + 1) + (2800 + 50 + 2) + (100 + 50) - (700 + 3 + 2 + 1 + 50);
    assert(cov.missing.length === expectedMissing, '4b.4 missing count equals a hand count', `${cov.missing.length} vs ${expectedMissing}`);
    assert(cov.missing.filter((p) => p.startsWith('summaries/collide-')).length === 50,
      '4b.5 all 50 summary sides of the collisions are missing despite a same-basename row');
    const r2 = rebuildIndexText(r1.text, inv, new Map(), { today: TODAY });
    assert(r2.text === r1.text, '4b.6 idempotent on the large fixture');
    const counts = new Map();
    for (const row of dumbRows(r1.text)) counts.set(`${row.type}:${row.link}`, (counts.get(`${row.type}:${row.link}`) || 0) + 1);
    const expected = inv.all.filter((p) => !inv.unlinkable.includes(p) && !inv.unaddressable.includes(p));
    assert(expected.every((p) => counts.get(dumbKey(p)) === 1) && dumbRows(r1.text).length === expected.length,
      '4b.7 DUMB cross-check on the large fixture: every page once', `${dumbRows(r1.text).length} vs ${expected.length}`);
    assert(ms < 3000, `4b.8 parse + coverage + rebuild of ${inv.all.length} pages in ${ms} ms (< 3000)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§5 ensureRowsInIndex');
  {
    // Legacy single table: append after the last row (today's behaviour), Last updated bumped.
    const legacy = '# Wiki Index — L\nLast updated: 2026-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n| [[zeta]] | concept | Zeta |\n| [[alpha]] | concept | Alpha |\n\n## Notes\nA note.\n';
    const e1 = ensureRowsInIndex(legacy, [
      { canonPath: 'concepts/mid.md', description: 'Mid' },
      { canonPath: 'entities/bob.md', description: 'Bob | the builder' },
    ], { today: TODAY });
    const l1 = e1.text.split('\n');
    assert(JSON.stringify(e1.added) === JSON.stringify(['entities/bob.md', 'concepts/mid.md']), '5.1 added lists the new paths', JSON.stringify(e1.added));
    assert(l1[6] === '| [[alpha]] | concept | Alpha |' && l1[7] === '| [[bob]] | entity | Bob the builder |' && l1[8] === '| [[mid]] | concept | Mid |',
      '5.2 legacy: appended right after the last table row, cell-safe', JSON.stringify(l1));
    assert(l1[1] === `Last updated: ${TODAY}`, '5.3 Last updated rewritten when rows are added');
    const before = legacy.split('\n');
    const keptOrder = before.filter((l, i) => i !== 1);
    let k = 0;
    for (const l of l1) if (k < keptOrder.length && l === keptOrder[k]) k++;
    assert(k === keptOrder.length, '5.4 every pre-existing line (bar Last updated) survives byte-identical and in order');
    assert(ensureRowsInIndex(e1.text, [{ canonPath: 'concepts/mid.md', description: 'Other' }, { canonPath: 'entities/bob.md' }], { today: '2099-01-01' }).text === null,
      '5.5 idempotent: the same entries again → text null (and no date change)');
    assert(ensureRowsInIndex(legacy, [{ canonPath: 'concepts/alpha.md', description: 'New text' }], { today: TODAY }).text === null,
      '5.6 an already-listed page is never re-added nor its row edited');
    assert(ensureRowsInIndex(legacy, [{ canonPath: 'entities/zeta.md', description: 'z' }], { today: TODAY }).text === null,
      '5.7 without an inventory, [[zeta]] counts for entities/zeta too (link-key coverage)');
    const sumAdd = ensureRowsInIndex(legacy, [{ canonPath: 'summaries/zeta.md', description: 'Summary zeta' }], { today: TODAY });
    assert(sumAdd.text && sumAdd.text.includes('| [[summaries/zeta]] | summary | Summary zeta |'),
      '5.8 …but [[zeta]] never covers summaries/zeta (canonical path, not basename)');
    assert(ensureRowsInIndex(legacy, [{ canonPath: 'concepts/ lead.md', description: 'x' }, { canonPath: 'index.md' }, { canonPath: '../x.md' }], { today: TODAY }).text === null,
      '5.9 unlinkable slugs and non-page paths are skipped');

    // '' → a full header and a sectioned body.
    const e2 = ensureRowsInIndex('', [{ canonPath: 'concepts/llm.md', description: 'LLMs' }], { today: TODAY, displayName: 'New Domain' });
    assert(e2.text === rebuildIndexText(null, buildInventory({ concepts: ['llm.md'] }), new Map([['concepts/llm.md', 'LLMs']]), { today: TODAY, displayName: 'New Domain' }).text,
      '5.10 ensure on "" produces exactly what a rebuild of the same disk state would');
    assert(e2.text.startsWith('# Wiki Index — New Domain\nLast updated: '), '5.11 fresh header carries the display name');
    assert(ensureRowsInIndex('', [], { today: TODAY }).text === null, '5.12 nothing to add on "" → null (no index created for nothing)');

    // The createDomain stub (no table, no trailing newline).
    const stub = '# Wiki Index — Stub\nLast updated: —\n\n_No pages yet._';
    const e3 = ensureRowsInIndex(stub, [{ canonPath: 'summaries/s.md', description: 'S' }], { today: TODAY });
    assert(e3.text.startsWith(`# Wiki Index — Stub\nLast updated: ${TODAY}\n\n_No pages yet._\n\n## Summaries\n\n${INDEX_TABLE_HEADER}\n${INDEX_TABLE_SEPARATOR}\n| [[summaries/s]] | summary | S |\n\n## Entities`)
      && e3.text.endsWith('\n'), '5.13 no table: a fresh sectioned body appended after the existing text', JSON.stringify(e3.text));
    assert(parseIndex(e3.text).sectioned, '5.14 …which is then a sectioned index');

    // Sectioned: sorted insert; ensure-then-compare with a full rebuild of the new disk state.
    const files = { entities: ['b.md', 'd.md'], concepts: ['m.md', 'z.md'], summaries: [] };
    const base = rebuildIndexText(null, buildInventory(files), new Map([
      ['entities/b.md', 'B'], ['entities/d.md', 'D'], ['concepts/m.md', 'M'], ['concepts/z.md', 'Z'],
    ]), { today: '2026-01-01', displayName: 'S' }).text;
    const files2 = { entities: ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'], concepts: ['m.md', 'z.md', 'Q.md'], summaries: ['s.md'] };
    const inv2 = buildInventory(files2);
    const newEntries = [
      { canonPath: 'entities/e.md', description: 'E' }, { canonPath: 'entities/a.md', description: 'A' },
      { canonPath: 'entities/c.md', description: 'C' }, { canonPath: 'concepts/Q.md', description: 'Q' },
      { canonPath: 'summaries/s.md', description: 'Sum' },
    ];
    const e4 = ensureRowsInIndex(base, newEntries, { today: TODAY, inventory: inv2 });
    const rebuilt = rebuildIndexText(base, inv2, new Map(newEntries.map((e) => [e.canonPath, e.description])), { today: TODAY }).text;
    assert(e4.text === rebuilt, '5.15 sectioned: ensure inserts each row at its sorted position — byte-identical to a full rebuild', `${JSON.stringify(e4.text)}\n      vs ${JSON.stringify(rebuilt)}`);
    const baseRows = base.split('\n').filter((l) => l.startsWith('| [['));
    assert(baseRows.every((l) => e4.text.split('\n').includes(l)), '5.16 every pre-existing row line unchanged (sha-identical lines)');
    assert(baseRows.map(sha).every((h) => e4.text.split('\n').map(sha).includes(h)), '5.17 …checked by sha too');

    // Sectioned index with a section missing: created in INDEX_SECTIONS order.
    const onlyConcepts = `# T\nLast updated: x\n\n## Concepts\n\n${INDEX_TABLE_HEADER}\n${INDEX_TABLE_SEPARATOR}\n| [[m]] | concept | M |\n`;
    const e5 = ensureRowsInIndex(onlyConcepts, [{ canonPath: 'entities/a.md', description: 'A' }, { canonPath: 'summaries/s.md', description: 'S' }], { today: TODAY });
    const l5 = e5.text.split('\n');
    assert(l5.indexOf('## Summaries') > 0 && l5.indexOf('## Summaries') < l5.indexOf('## Entities') && l5.indexOf('## Entities') < l5.indexOf('## Concepts'),
      '5.18 missing sections created in Summaries, Entities, Concepts order', JSON.stringify(e5.text));
    assert(parseIndex(e5.text).blocks.filter((b) => b.sectionFolder).length === 3, '5.19 …each a real section table');
    const onlySummaries = `# T\nLast updated: x\n\n## Summaries\n\n${INDEX_TABLE_HEADER}\n${INDEX_TABLE_SEPARATOR}\n| [[summaries/s]] | summary | S |\n`;
    const e6 = ensureRowsInIndex(onlySummaries, [{ canonPath: 'concepts/c.md', description: 'C' }], { today: TODAY });
    assert(e6.text.endsWith(`| [[summaries/s]] | summary | S |\n\n## Concepts\n\n${INDEX_TABLE_HEADER}\n${INDEX_TABLE_SEPARATOR}\n| [[c]] | concept | C |\n`),
      '5.20 a later section appended after the last earlier one', JSON.stringify(e6.text));

    // With an inventory: canonical-path coverage, repoint-aware, on-disk only.
    const inv3 = buildInventory({ entities: ['shared.md'], concepts: ['shared.md', 'x.md'], summaries: ['lonely.md', 'x.md'] });
    const idx3 = '| Page | Type | Summary |\n|---|---|---|\n| [[lonely]] | summary | bare summary row |\n| [[x]] | concept | X |\n';
    assert(ensureRowsInIndex(idx3, [{ canonPath: 'summaries/lonely.md' }], { today: TODAY, inventory: inv3 }).text === null,
      '5.21 inventory: a bare row that resolves to the summary covers it (no duplicate added)');
    assert(ensureRowsInIndex(idx3, [{ canonPath: 'concepts/shared.md', description: 'c' }], { today: TODAY, inventory: inv3 }).text === null,
      '5.22 inventory: an unaddressable concept is never written');
    assert(ensureRowsInIndex(idx3, [{ canonPath: 'concepts/ghost.md', description: 'g' }], { today: TODAY, inventory: inv3 }).text === null,
      '5.23 inventory: a page not on disk is never written (no stale row created)');
    const e7 = ensureRowsInIndex(idx3, [{ canonPath: 'summaries/x.md', description: 'SX' }], { today: TODAY, inventory: inv3 });
    assert(e7.text && e7.text.includes('| [[summaries/x]] | summary | SX |'), '5.24 inventory: the summary side of a collision is added');

    // CRLF files keep CRLF on every line.
    const crlf = '# T\r\nLast updated: 2026-01-01\r\n\r\n| Page | Type | Summary |\r\n|---|---|---|\r\n| [[a]] | concept | A |\r\n';
    const e8 = ensureRowsInIndex(crlf, [{ canonPath: 'concepts/b.md', description: 'B' }], { today: TODAY });
    assert(e8.text === `# T\r\nLast updated: ${TODAY}\r\n\r\n| Page | Type | Summary |\r\n|---|---|---|\r\n| [[a]] | concept | A |\r\n| [[b]] | concept | B |\r\n`,
      '5.25 CRLF index: inserted lines and the date line keep \\r\\n', JSON.stringify(e8.text));

    // Header + separator only (the test-ingest-fixes Case D shape): rows go under it.
    const e9 = ensureRowsInIndex('| Page | Type | Summary |\n|---|---|---|\n', [{ canonPath: 'entities/alice.md', description: 'Updated alice' }], { today: TODAY });
    assert(e9.text === '| Page | Type | Summary |\n|---|---|---|\n| [[alice]] | entity | Updated alice |\n', '5.26 rows land under a bare header table', JSON.stringify(e9.text));

    const dupEntries = ensureRowsInIndex('', [{ canonPath: 'concepts/a.md', description: '' }, { canonPath: 'concepts/a.md', description: 'Later' }], { today: TODAY });
    assert(dupEntries.added.length === 1 && dupEntries.text.includes('| [[a]] | concept | Later |'),
      '5.27 duplicate entries collapse to one row, keeping the first non-empty description');
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§6 deriveDescription');
  {
    const curator = '---\ntype: concept\ntags: [type/concept]\ncreated: 2026-01-01\n---\n# Aria Platform\n\n## Overview\nARIA is a platform for avatars. It does many things.\n';
    const d1 = deriveDescription(curator, 'concepts/aria.md');
    assert(d1 === 'ARIA is a platform for avatars.', '6.1 entity/concept: first body sentence; "## Overview" never leaks in (the projects bug)', d1);
    const sum = '---\ntype: summary\nsource: a.pdf\n---\n# The Source Title\n\n## Key Takeaways\n- First takeaway.\n';
    assert(deriveDescription(sum, 'summaries/a.md') === 'The Source Title', '6.2 summary: the H1 first');
    assert(deriveDescription('---\ntitle: "Quoted Title"\n---\n# H1 here\nBody.\n', 'summaries/q.md') === 'Quoted Title',
      '6.3 summary: a frontmatter title: wins when present (user pre-formatted pages)');
    assert(deriveDescription('---\ntitle: T\n---\n# H\n\n', 'concepts/t.md') === 'T', '6.4 concept with no body: falls back to title:');
    assert(deriveDescription('# Only Heading\n', 'entities/o.md') === 'Only Heading', '6.5 …then the H1');
    assert(deriveDescription('', 'entities/e.md') === '' && deriveDescription(null, 'entities/e.md') === '', '6.6 empty page → ""');
    const linky = '# L\n\n- Works with [[openai|OpenAI]] and [[anthropic]] on [[summaries/x]] via **bold** `code` [site](https://a.b/c|d).\n';
    const d2 = deriveDescription(linky, 'entities/l.md');
    assert(d2 === 'Works with OpenAI and anthropic on summaries/x via bold code site.', '6.7 links, emphasis, code and list markers stripped', d2);
    assert(!d2.includes('[[') && !d2.includes('|'), '6.8 no [[ and no | in the output');
    const broken = deriveDescription('Text with [[unclosed and | pipe\nnext', 'concepts/b.md');
    assert(!broken.includes('[[') && !broken.includes('|'), '6.9 a broken link still leaves no [[ or |', broken);
    const longBody = '# T\n' + 'word '.repeat(200) + '\n';
    const d3 = deriveDescription(longBody, 'concepts/t.md');
    assert(d3.length <= INDEX_DESCRIPTION_MAX && d3.endsWith('…') && !/\s…$/.test(d3), '6.10 over the cap: cut at a word boundary with an ellipsis, ≤160', d3);
    assert(deriveDescription('Phase two, as described by Dr. Tali Rezun, is applied. Next.', 'concepts/p.md')
      === 'Phase two, as described by Dr. Tali Rezun, is applied.', '6.11 "Dr." does not end the sentence');
    assert(deriveDescription('Short. But the rest is the real sentence here.', 'concepts/s.md') === 'Short. But the rest is the real sentence here.',
      '6.12 a cut that would leave < 20 chars is not taken');
    assert(deriveDescription('Type: concept\nTags: a, b\nSource: x\nThe actual line.', 'concepts/c.md') === 'The actual line.',
      '6.13 inline Type:/Tags:/Source: metadata lines skipped');
    assert(deriveDescription('﻿---\r\ntype: entity\r\n---\r\n# E\r\n\r\nCRLF body line.\r\n', 'entities/e.md') === 'CRLF body line.',
      '6.14 BOM and CRLF handled');
    assert(deriveDescription('# T\n\n| a | b |\n|---|---|\n\n---\n\n> Quoted line here.\n', 'concepts/t.md') === 'Quoted line here.',
      '6.15 tables and horizontal rules skipped, quote marker stripped');
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§7 indexEntriesFrom');
  {
    const pages = [
      { path: 'entities/a.md', summary: 'A | one\ntwo' },
      { path: 'concepts/b.md' },
      { path: 'index.md', summary: 'x' },
      { path: 'concepts/google.md', summary: 'Redirected' },
      { path: 'x.md', summary: 'no record' },
      { path: 'entities/a.md', summary: 'second write of a' },
    ];
    const recs = [
      { originalPath: 'entities/a.md', record: { canonPath: 'entities/a.md', status: 'created' } },
      { originalPath: 'concepts/b.md', record: { canonPath: 'concepts/b.md', status: 'unchanged' } },
      { originalPath: 'index.md', record: { canonPath: 'index.md', status: 'updated' } },
      { originalPath: 'concepts/google.md', record: { canonPath: 'entities/google.md', status: 'updated' } },
      null,
      { originalPath: 'entities/a.md', record: { canonPath: 'entities/a.md', status: 'updated' } },
    ];
    const out = indexEntriesFrom(pages, recs);
    assert(JSON.stringify(out) === JSON.stringify([
      { canonPath: 'entities/a.md', description: 'A one two' },
      { canonPath: 'concepts/b.md', description: null },
      { canonPath: 'entities/google.md', description: 'Redirected' },
    ]), '7.1 every status counts; index.md excluded; aligned by index; redirect keeps the summary; dedup', JSON.stringify(out));
    assert(indexEntriesFrom(null, null).length === 0 && indexEntriesFrom([], [{ record: null }]).length === 0, '7.2 null-safe');
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('§8 fs wrapper (isolated domains dir)');
  {
    __setDomainsDirOverride(ROOT);
    const D = 'fixture';
    const wiki = path.join(ROOT, D, 'wiki');
    for (const f of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(wiki, f), { recursive: true });
    writeFileSync(path.join(ROOT, D, 'CLAUDE.md'), '# Domain: Fixture Domain\n\nSchema.\n');
    const page = (title, body) => `---\ntype: concept\ntags: [type/concept]\ncreated: 2026-01-01\n---\n# ${title}\n\n## Overview\n${body}\n`;
    writeFileSync(path.join(wiki, 'concepts', 'listed.md'), page('Listed', 'Listed body.'));
    writeFileSync(path.join(wiki, 'concepts', 'updated-missing.md'), page('Updated Missing', 'This page was updated but never indexed.'));
    writeFileSync(path.join(wiki, 'entities', 'ent.md'), page('Ent', 'An entity on disk.'));
    writeFileSync(path.join(wiki, 'summaries', 'listed.md'), '---\ntype: summary\n---\n# Listed Source\n');
    writeFileSync(path.join(wiki, 'concepts', 'notes.txt'), 'not a page');
    mkdirSync(path.join(wiki, 'concepts', 'folder.md'));
    const outside = path.join(TMP, 'outside.md');
    writeFileSync(outside, '# Outside\nSecret.\n');
    let symlinked = false;
    try { symlinkSync(outside, path.join(wiki, 'concepts', 'escape.md')); symlinked = true; } catch { /* fs without symlinks */ }

    const inv = await readPageInventory(D);
    assert(inv.all.includes('concepts/listed.md') && inv.all.includes('summaries/listed.md') && inv.all.includes('entities/ent.md'),
      '8.1 readPageInventory lists the .md pages of the three folders');
    assert(!inv.all.some((p) => p.endsWith('notes.txt') || p.endsWith('folder.md')), '8.2 non-.md files and a directory named x.md are skipped');
    if (symlinked) assert(!inv.all.includes('concepts/escape.md'), '8.3 a symlink resolving outside the wiki is skipped');
    assert((await readPageInventory('no-such-domain')).all.length === 0, '8.4 a missing domain reads as an empty inventory');

    const indexFile = path.join(wiki, 'index.md');
    writeFileSync(indexFile, '# Wiki Index — Fixture Domain\nLast updated: 2026-01-01\n\n| Page | Type | Summary |\n|---|---|---|\n| [[listed]] | concept | Listed by hand |\n');

    // Stdout purity: nothing in the wrapper (or writePage underneath) may write stdout.
    const realWrite = process.stdout.write.bind(process.stdout);
    let stdoutBytes = 0;
    process.stdout.write = (chunk, ...rest) => { stdoutBytes += String(chunk).length; return true; };
    let rec1, rec2, rec3;
    let outsideBefore;
    try {
      outsideBefore = readFileSync(outside, 'utf8');
      rec1 = await ensurePagesInIndex(D, [
        { canonPath: 'concepts/listed.md', description: null },
        { canonPath: 'concepts/updated-missing.md', description: null },
        { canonPath: 'summaries/listed.md', description: 'Given summary text' },
        { canonPath: 'concepts/escape.md', description: null },
        { canonPath: 'concepts/ghost.md', description: null },
      ], { today: TODAY });
      rec2 = await ensurePagesInIndex(D, [{ canonPath: 'concepts/updated-missing.md', description: null }], { today: '2099-01-01' });
      // Fresh re-read: a foreign row lands on disk after the caller's own read.
      const callerCopy = readFileSync(indexFile, 'utf8');
      writeFileSync(indexFile, callerCopy.replace(/\n$/, '\n| [[foreign]] | concept | Written by another process |\n'));
      rec3 = await ensurePagesInIndex(D, [{ canonPath: 'entities/ent.md', description: null }], { today: TODAY });
    } finally {
      process.stdout.write = realWrite;
    }
    assert(stdoutBytes === 0, '8.5 the fs wrapper writes NOTHING to stdout (reachable from mcp/)', String(stdoutBytes));
    const after1 = readFileSync(indexFile, 'utf8');
    assert(rec1 && rec1.canonPath === 'index.md' && ['updated', 'created'].includes(rec1.status),
      '8.6 returns writePage\'s change record for index.md', JSON.stringify(rec1));
    assert(after1.includes('| [[listed]] | concept | Listed by hand |'), '8.7 the existing row is untouched');
    assert(after1.includes('| [[updated-missing]] | concept | This page was updated but never indexed. |'),
      '8.8 a missing page with no description gets one derived FROM DISK (not the ## Overview heading)');
    assert(after1.includes('| [[summaries/listed]] | summary | Given summary text |'), '8.9 a given description is used; the summary side of the collision added');
    assert(!after1.includes('escape') && !after1.includes('ghost') && !after1.includes('Secret'),
      '8.10 a symlink out of the wiki and a page not on disk get no row');
    if (symlinked) assert(readFileSync(outside, 'utf8') === outsideBefore, '8.11 the file outside the wiki is byte-identical');
    assert(rec2 === null, '8.12 nothing missing → null, no write');
    assert(after1.includes(`Last updated: ${TODAY}`), '8.13 …and the date was not bumped by the no-op call');
    const after3 = readFileSync(indexFile, 'utf8');
    assert(after3.includes('[[foreign]]') && after3.includes('| [[ent]] | entity | An entity on disk. |'),
      '8.14 index.md re-read at merge time: a row written by someone else in between survives', after3);
    assert(rec3 && rec3.status === 'updated', '8.15 the merge after the foreign write is an update');
    const shaAfter = sha(after3);
    assert(await ensurePagesInIndex(D, indexEntriesFrom(
      [{ summary: 'x' }, {}], [{ record: { canonPath: 'entities/ent.md', status: 'unchanged' } }, { record: { canonPath: 'concepts/listed.md', status: 'updated' } }],
    )) === null && sha(readFileSync(indexFile, 'utf8')) === shaAfter, '8.16 a second identical run writes nothing (index sha unchanged)');

    // Missing index.md → created with the CLAUDE.md display name.
    const D2 = 'fresh';
    mkdirSync(path.join(ROOT, D2, 'wiki', 'concepts'), { recursive: true });
    writeFileSync(path.join(ROOT, D2, 'CLAUDE.md'), '# Domain: Fresh Name\n');
    writeFileSync(path.join(ROOT, D2, 'wiki', 'concepts', 'first.md'), page('First', 'The first page.'));
    const rec4 = await ensurePagesInIndex(D2, [{ canonPath: 'concepts/first.md', description: null }], { today: TODAY });
    const fresh = readFileSync(path.join(ROOT, D2, 'wiki', 'index.md'), 'utf8');
    assert(rec4 && rec4.status === 'created' && fresh.startsWith(`# Wiki Index — Fresh Name\nLast updated: ${TODAY}\n`)
      && fresh.includes('| [[first]] | concept | The first page. |'), '8.17 a missing index.md is created, titled from CLAUDE.md', fresh);
    assert(await ensurePagesInIndex(D2, [], {}) === null && await ensurePagesInIndex(D2, null, {}) === null, '8.18 no entries → null');
    assert(!existsSync(path.join(ROOT, D, 'wiki', 'log.md')), '8.19 no log entry is written');
  }
} catch (err) {
  failed++;
  console.log(`  ✗ suite threw: ${err && err.stack || err}`);
} finally {
  __setDomainsDirOverride(null);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
