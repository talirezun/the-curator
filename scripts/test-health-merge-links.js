#!/usr/bin/env node
/**
 * scripts/test-health-merge-links.js — OFFLINE
 *
 * Wiki Health: a merge must never leave a dangling [[link]].
 *
 * ── THE DEFECT THIS PINS ──────────────────────────────────────────────────
 *
 * Exactly three handlers in src/brain/health.js delete a page after merging
 * it into another. Until this suite existed, only ONE of them repointed the
 * links that pointed at the deleted page — it carried its own inline copy of
 * that logic, and its two siblings had none:
 *
 *   fixCrossFolderDupe   merge → write → rm            (no repointing)
 *   fixHyphenVariant     merge → write → rm            (no repointing)
 *   fixSemanticDuplicate merge → write → rm + REPOINT  (inline "Step 3")
 *
 * Both unguarded handlers are in AUTO_FIXABLE **and** in fixAllSafe's TYPES,
 * so the "Fix N safe issues" button — presented as free, local, structural
 * repair — orphaned links. A user reported Health going from 5 issues to 50
 * after one click on "Fix all 1" under Hyphen variants.
 *
 * ── WHY THE ASSERTIONS ARE SHAPED THE WAY THEY ARE ────────────────────────
 *
 * 1. "Zero dangling links" is asserted by running the REAL `scanWiki`, never
 *    by grepping the files. The scanner's resolution rules are subtle and
 *    asymmetric — a bare `[[X]]` resolves against entities/ OR concepts/,
 *    while `[[concepts/X]]` resolves ONLY against concepts/ — and a grep
 *    would encode a second, drifting copy of those rules. scanWiki is what
 *    the user sees, so scanWiki is the oracle.
 *
 * 2. The cross-folder case was MEASURED, not reasoned about. It has two
 *    distinct shapes, and only one is obvious:
 *      • same slug (concepts/google → entities/google): the bare form still
 *        resolves, but the folder-PREFIXED form does not. 2 broken links.
 *      • different slug (concepts/e-mail → entities/email): crossFolderDupes
 *        matches on the hyphen-NORMALISED key, so the slug CAN change, and
 *        the bare form breaks too. 3 broken links.
 *    Both are covered, because a fix that only handled the first would look
 *    correct on the fixture anyone would think to write.
 *
 * 3. Section 5 is a CLASS-level guard, not a list of three function names.
 *    It brace-matches the enclosing function of every DELETE CALL in
 *    health.js and requires a non-inert `repointInboundLinks(` call at an
 *    earlier offset. A new page-deleting handler that forgets to repoint
 *    fails the build. Precedent: test-route-write-guards.js (route
 *    enumeration) and v3.4.0's mechanical enumeration of catch sites in
 *    ingest.js — in both cases a hand-maintained list is what let a sibling
 *    slip through. Section 5 carries its own NEGATIVE CONTROLS: synthetic
 *    page-deleting handlers are injected into a copy of the source and the
 *    guard must fire on each.
 *
 *    IT IS KEYED ON THE ACT, NOT ON ONE SPELLING OF THE VERB. The first
 *    version matched the literal `await rm(`, and an audit's mutation matrix
 *    walked straight past `await unlink(v)`, `rmSync(v)`, an un-awaited
 *    `rm(v)`, `rm` inside a `.map()`, and `fsp.rm(v)` — with `unlink` being
 *    a sibling export of the fs/promises import already at the top of
 *    health.js. It now matches every fs delete verb, refuses an INERT
 *    repoint (an empty `retired` array returns 0 before touching a file),
 *    and forbids importing a delete verb under an alias, which no text scan
 *    can follow. Each of those shapes has its own negative control (5.8-5.10).
 *
 * 4. Section 7b covers splitWikiRef's CONDITIONS, not just its use. An audit
 *    found the two were not the same thing: deleting the `if (!keepRef ||
 *    !removeRef)` call site goes RED at 7.5, but replacing each of the
 *    function's own seven guards with `if (false)` left this suite at 89/0
 *    for six of them, and CRASHED on the seventh (a TypeError, which proves
 *    nothing about a guard). All seven now produce a clean behavioural RED —
 *    including the two that needed chasing rather than reporting: the
 *    segment check is masked by the folder and suffix guards for every
 *    obvious fixture, so 7b.6b supplies the input where it is the ONLY thing
 *    standing between a 3-segment ref and a wrong-page link rewrite.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HEALTH_SRC_PATH = path.join(REPO, 'src', 'brain', 'health.js');

const { __setDomainsDirOverride } = await import(path.join(REPO, 'src/brain/config.js'));
const { scanWiki, fixIssue, fixAllSafe, AUTO_FIXABLE } =
  await import(path.join(REPO, 'src/brain/health.js'));

let passed = 0;
let failed = 0;
function assert(cond, label, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`); }

// ── Fixture plumbing ───────────────────────────────────────────────────────
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-merge-links-'));
__setDomainsDirOverride(ROOT);

function page(title, type, related = '') {
  return `---
type: ${type}
tags: [type/${type}]
---

# ${title}

## Key Facts

- a fact about ${title}

## Related

${related}`;
}

function mkDomain(name, files) {
  const wiki = path.join(ROOT, name, 'wiki');
  for (const f of ['entities', 'concepts', 'summaries']) {
    mkdirSync(path.join(wiki, f), { recursive: true });
  }
  writeFileSync(path.join(ROOT, name, 'CLAUDE.md'), '# schema\n');
  writeFileSync(path.join(wiki, 'index.md'), '# Index\n');
  writeFileSync(path.join(wiki, 'log.md'), '# Log\n');
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(path.join(wiki, rel), body);
  }
  return wiki;
}

const read = (wiki, rel) => readFileSync(path.join(wiki, rel), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
section('1. Hyphen variant — the reported defect (slug CHANGES)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const wiki = mkDomain('hyphen', {
    'entities/tali-rezun.md': page('Tali Rezun', 'entity'),
    'entities/dr-tali-rezun.md': page('Dr Tali Rezun', 'entity',
      '- self-ref [[dr-tali-rezun]]\n'),
    'entities/hub.md': page('Hub', 'entity',
      '- bare [[dr-tali-rezun]]\n'
      + '- aliased [[dr-tali-rezun|Dr Rezun]]\n'
      + '- folder-prefixed [[entities/dr-tali-rezun]]\n'
      + '- unrelated [[dr-tali-rezun-institute]]\n'),
    'entities/dr-tali-rezun-institute.md': page('Institute', 'entity'),
    'summaries/paper.md': page('Paper', 'summary', '- [[dr-tali-rezun]]\n'),
  });

  const before = await scanWiki('hyphen');
  assert(before.brokenLinks.length === 0,
    '1.1 PRECONDITION — the fixture starts with zero broken links',
    JSON.stringify(before.brokenLinks));
  assert(before.hyphenVariants.length === 1
    && before.hyphenVariants[0].suggestedSlug === 'tali-rezun',
    '1.2 PRECONDITION — scanWiki reports the variant group, canonical = tali-rezun',
    JSON.stringify(before.hyphenVariants));

  const r = await fixIssue('hyphen', 'hyphenVariants', before.hyphenVariants[0]);
  assert(r.fixed === 1, '1.3 the fix reports success (return contract unchanged)', JSON.stringify(r));
  assert(!existsSync(path.join(wiki, 'entities/dr-tali-rezun.md')),
    '1.4 the duplicate page really was deleted (the destructive half still happens)');

  const after = await scanWiki('hyphen');
  assert(after.brokenLinks.length === 0,
    '1.5 THE DEFECT — zero dangling links after the merge, per the REAL scanWiki',
    JSON.stringify(after.brokenLinks.map((b) => `${b.sourceFile}::${b.linkText}`)));
  assert(after.hyphenVariants.length === 0, '1.6 …and the variant group is gone');

  const hub = read(wiki, 'entities/hub.md');
  assert(hub.includes('- bare [[tali-rezun]]'), '1.7 the bare link was repointed', hub);
  assert(hub.includes('- aliased [[tali-rezun|Dr Rezun]]'),
    '1.8 ALIAS PRESERVED — [[dr-tali-rezun|Dr Rezun]] → [[tali-rezun|Dr Rezun]]', hub);
  assert(hub.includes('- folder-prefixed [[tali-rezun]]'),
    '1.9 the folder-prefixed form was repointed to the bare convention', hub);
  assert(hub.includes('[[dr-tali-rezun-institute]]'),
    '1.10 A LONGER SLUG SHARING THE PREFIX IS UNTOUCHED — [[dr-tali-rezun-institute]] '
    + 'must not be eaten by a retired `dr-tali-rezun` (the closing ]] is required)', hub);
  assert(read(wiki, 'summaries/paper.md').includes('[[tali-rezun]]'),
    '1.11 links from a SUMMARY were repointed too (the walk is domain-wide)');

  // The merged body carries the duplicate's own self-reference. If the merged
  // content were written AFTER the repoint it would reinstate [[dr-tali-rezun]]
  // on the surviving page — which is exactly what scanWiki would then flag.
  const canon = read(wiki, 'entities/tali-rezun.md');
  assert(!canon.includes('[[dr-tali-rezun]]'),
    '1.12 ORDERING — the merged body\'s own self-reference was repointed, so the '
    + 'canonical page does not reinstate the dangling link', canon);
}

// ═══════════════════════════════════════════════════════════════════════════
section('1b. WHITESPACE-PADDED links — seen by the scanner, missed by the repoint');
// ═══════════════════════════════════════════════════════════════════════════
// scanWiki's link scan does `m[1].trim()`, so `[[ dr-tali-rezun ]]` is a LIVE
// inbound link in the user's Health report. repointInboundLinks' pattern had
// no whitespace allowance, so the merge deleted the page and left the padded
// link dangling. MEASURED on the single-type `hyphenVariants` path (the
// literal reported click): broken links 1 -> 2, with a new
// `entities/hub.md::dr-tali-rezun`.
//
// It self-heals under fixAllSafe, which is why it hid: that path runs
// `brokenLinks` LAST and the prefix-tolerant suggestion resolver puts the
// slug back. An accident of ordering, not coverage — the same masking
// already labelled at 6.3 — so this section drives the UNMASKED path.
{
  const wiki = mkDomain('padded', {
    'entities/tali-rezun.md': page('Tali Rezun', 'entity'),
    'entities/dr-tali-rezun.md': page('Dr Tali Rezun', 'entity'),
    'entities/hub.md': page('Hub', 'entity',
      '- padded [[ dr-tali-rezun ]]\n'
      + '- padded aliased [[ dr-tali-rezun | Dr Rezun ]]\n'
      + '- padded folder-prefixed [[ entities/dr-tali-rezun ]]\n'
      + '- tab-padded [[\tdr-tali-rezun\t]]\n'
      + '- unpadded control [[dr-tali-rezun]]\n'
      + '- longer slug, padded [[ dr-tali-rezun-institute ]]\n'),
    'entities/dr-tali-rezun-institute.md': page('Institute', 'entity'),
  });

  const before = await scanWiki('padded');
  assert(before.brokenLinks.length === 0,
    '1b.1 PRECONDITION — the scanner TRIMS, so every padded link resolves and the '
    + 'fixture starts with zero broken links (this is what makes them real inbound links)',
    JSON.stringify(before.brokenLinks.map((b) => `${b.sourceFile}::${b.linkText}`)));

  const r = await fixIssue('padded', 'hyphenVariants', null);
  assert(r.fixed === 1, '1b.2 the fix-all-of-type branch reports success', JSON.stringify(r));

  const after = await scanWiki('padded');
  assert(after.brokenLinks.length === 0,
    '1b.3 THE DEFECT — a whitespace-padded inbound link is repointed, not orphaned',
    JSON.stringify(after.brokenLinks.map((b) => `${b.sourceFile}::${b.linkText}`)));

  const hub = read(wiki, 'entities/hub.md');
  assert(hub.includes('- padded [[tali-rezun]]'), '1b.4 the padded bare link was repointed', hub);
  assert(/- padded aliased \[\[tali-rezun\| Dr Rezun \]\]/.test(hub),
    '1b.5 ALIAS PRESERVED VERBATIM — including its own padding, which is the alias '
    + 'text the user wrote and is not ours to normalise', hub);
  assert(hub.includes('- padded folder-prefixed [[tali-rezun]]'),
    '1b.6 the padded FOLDER-PREFIXED form was repointed to the bare convention', hub);
  assert(hub.includes('- tab-padded [[tali-rezun]]'),
    '1b.7 tabs count as padding too (the scanner\'s slug class admits them)', hub);
  assert(hub.includes('- unpadded control [[tali-rezun]]'),
    '1b.8 CONTROL — the unpadded form still works (the allowance did not break it)', hub);
  assert(hub.includes('[[ dr-tali-rezun-institute ]]'),
    '1b.9 a LONGER slug sharing the prefix is still untouched when padded — the '
    + 'padding allowance must not let `dr-tali-rezun` eat `dr-tali-rezun-institute`', hub);
}

// The allowance is deliberately `[^\S\n]*`, not `\s*`. A newline cannot appear
// inside a link the SCANNER recognises (its slug class is `[^\]|#\n]`), so a
// `\s*` here would rewrite a construct Health never counted as a link —
// making the repoint and the scanner disagree in the other direction.
{
  const wiki = mkDomain('nlpad', {
    'entities/tali-rezun.md': page('Tali Rezun', 'entity'),
    'entities/dr-tali-rezun.md': page('Dr Tali Rezun', 'entity'),
    'entities/hub.md': page('Hub', 'entity', '- newline inside [[dr-tali-rezun\n]]\n'),
  });
  const before = await scanWiki('nlpad');
  const sawIt = before.brokenLinks.some((b) => b.linkText && b.linkText.includes('dr-tali-rezun'))
    || (before.hyphenVariants.length > 0 && false);
  assert(!sawIt,
    '1b.10 PRECONDITION — the scanner does NOT see `[[slug\\n]]` as a link at all');
  await fixIssue('nlpad', 'hyphenVariants', null);
  assert(read(wiki, 'entities/hub.md').includes('[[dr-tali-rezun\n]]'),
    '1b.11 …so the repoint leaves it alone too — the two agree, which is the point '
    + 'of matching the scanner\'s own character class rather than using \\s',
    read(wiki, 'entities/hub.md'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. Hyphen variant — a group of THREE (multi-delete in one fix)');
// ═══════════════════════════════════════════════════════════════════════════
{
  const wiki = mkDomain('hyphen3', {
    'entities/tali-rezun.md': page('Tali Rezun', 'entity'),
    'entities/dr-tali-rezun.md': page('Dr Tali Rezun', 'entity'),
    'entities/talirezun.md': page('Talirezun', 'entity'),
    'entities/hub.md': page('Hub', 'entity',
      '- a [[dr-tali-rezun]]\n- b [[talirezun]]\n- c [[talirezun|Short]]\n'),
  });
  const before = await scanWiki('hyphen3');
  assert(before.hyphenVariants.length === 1 && before.hyphenVariants[0].files.length === 3,
    '2.1 PRECONDITION — one group of three variants',
    JSON.stringify(before.hyphenVariants));

  await fixIssue('hyphen3', 'hyphenVariants', before.hyphenVariants[0]);
  const after = await scanWiki('hyphen3');
  assert(after.brokenLinks.length === 0,
    '2.2 zero dangling links when TWO pages are deleted in one fix',
    JSON.stringify(after.brokenLinks.map((b) => b.linkText)));
  const hub = read(wiki, 'entities/hub.md');
  assert(hub.includes('- a [[tali-rezun]]') && hub.includes('- b [[tali-rezun]]')
    && hub.includes('- c [[tali-rezun|Short]]'),
    '2.3 both retired slugs repointed, alias preserved', hub);
  assert(!existsSync(path.join(wiki, 'entities/dr-tali-rezun.md'))
    && !existsSync(path.join(wiki, 'entities/talirezun.md')),
    '2.4 both duplicates deleted');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. Cross-folder duplicate — MEASURED, both shapes');
// ═══════════════════════════════════════════════════════════════════════════
// Shape A: slug UNCHANGED (concepts/google → entities/google).
// Measured on the pre-fix code: the bare [[google]] still resolved, but
// [[concepts/google]] became broken — 2 dangling links, not zero. So this
// handler WAS broken, just not in the form the name suggests.
{
  const wiki = mkDomain('xfoldA', {
    'entities/google.md': page('Google', 'entity'),
    'concepts/google.md': page('Google', 'concept'),
    'entities/hub.md': page('Hub', 'entity',
      '- bare [[google]]\n'
      + '- concept-prefixed [[concepts/google]]\n'
      + '- entity-prefixed [[entities/google]]\n'
      + '- aliased-prefixed [[concepts/google|Big G]]\n'
      + '- unrelated [[google-cloud]]\n'),
    'entities/google-cloud.md': page('Google Cloud', 'entity'),
  });
  const before = await scanWiki('xfoldA');
  assert(before.brokenLinks.length === 0, '3.1 PRECONDITION — zero broken links to start',
    JSON.stringify(before.brokenLinks));
  assert(before.crossFolderDupes.length === 1
    && before.crossFolderDupes[0].keep === 'entities/google.md'
    && before.crossFolderDupes[0].remove === 'concepts/google.md',
    '3.2 PRECONDITION — the pair is detected, keeping the entity',
    JSON.stringify(before.crossFolderDupes));

  const r = await fixIssue('xfoldA', 'crossFolderDupes', before.crossFolderDupes[0]);
  assert(r.fixed === 1, '3.3 the fix reports success', JSON.stringify(r));
  assert(!existsSync(path.join(wiki, 'concepts/google.md')), '3.4 the concept page was deleted');

  const after = await scanWiki('xfoldA');
  assert(after.brokenLinks.length === 0,
    '3.5 MEASURED CASE A — same slug, yet [[concepts/google]] dangled before this fix; '
    + 'now zero broken links',
    JSON.stringify(after.brokenLinks.map((b) => b.linkText)));
  const hub = read(wiki, 'entities/hub.md');
  assert(hub.includes('- concept-prefixed [[google]]'),
    '3.6 [[concepts/google]] → [[google]] (bare, per the wiki link convention)', hub);
  assert(hub.includes('- aliased-prefixed [[google|Big G]]'),
    '3.7 alias preserved through a folder-prefixed rewrite', hub);
  assert(hub.includes('[[google-cloud]]'),
    '3.8 [[google-cloud]] untouched by a retired `google`', hub);
}

// Shape B: slug CHANGES. crossFolderDupes matches on the hyphen-NORMALISED
// key, so concepts/e-mail.md pairs with entities/email.md — and the bare form
// breaks. This shape is easy to miss when reasoning about the handler.
{
  const wiki = mkDomain('xfoldB', {
    'entities/email.md': page('Email', 'entity'),
    'concepts/e-mail.md': page('E-Mail', 'concept'),
    'entities/hub.md': page('Hub', 'entity',
      '- bare [[e-mail]]\n- prefixed [[concepts/e-mail]]\n- aliased [[e-mail|Electronic Mail]]\n'),
  });
  const before = await scanWiki('xfoldB');
  assert(before.brokenLinks.length === 0, '3.9 PRECONDITION — zero broken links to start',
    JSON.stringify(before.brokenLinks));
  assert(before.crossFolderDupes.length === 1
    && before.crossFolderDupes[0].remove === 'concepts/e-mail.md',
    '3.10 PRECONDITION — the hyphen-normalised cross-folder pair is detected '
    + '(THIS is why the slug can change)', JSON.stringify(before.crossFolderDupes));

  await fixIssue('xfoldB', 'crossFolderDupes', before.crossFolderDupes[0]);
  const after = await scanWiki('xfoldB');
  assert(after.brokenLinks.length === 0,
    '3.11 MEASURED CASE B — slug changed (e-mail → email), bare links repointed',
    JSON.stringify(after.brokenLinks.map((b) => b.linkText)));
  const hub = read(wiki, 'entities/hub.md');
  assert(hub.includes('- bare [[email]]') && hub.includes('- prefixed [[email]]')
    && hub.includes('- aliased [[email|Electronic Mail]]'),
    '3.12 all three forms repointed to the surviving slug', hub);
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. Semantic duplicate — the handler that already repointed');
// ═══════════════════════════════════════════════════════════════════════════
// This one HAD the logic inline. The point of this section is that lifting it
// into the shared helper did not regress it — including the summary-link case
// its own docblock calls out.
{
  const wiki = mkDomain('semdupe', {
    'concepts/rag.md': page('RAG', 'concept'),
    'concepts/retrieval-augmented-generation.md':
      page('Retrieval Augmented Generation', 'concept'),
    'entities/hub.md': page('Hub', 'entity',
      '- bare [[retrieval-augmented-generation]]\n'
      + '- aliased [[retrieval-augmented-generation|RAG]]\n'
      + '- prefixed [[concepts/retrieval-augmented-generation]]\n'),
    'summaries/paper.md': page('Paper', 'summary',
      '- [[retrieval-augmented-generation]]\n'),
  });
  const issue = {
    keepSlug: 'rag', keepFolder: 'concepts',
    removeSlug: 'retrieval-augmented-generation', removeFolder: 'concepts',
  };
  const r = await fixIssue('semdupe', 'semanticDupe', issue);
  assert(r.fixed === 1, '4.1 the merge reports success', JSON.stringify(r));
  assert(!existsSync(path.join(wiki, 'concepts/retrieval-augmented-generation.md')),
    '4.2 the duplicate was deleted');
  const after = await scanWiki('semdupe');
  assert(after.brokenLinks.length === 0, '4.3 zero dangling links (no regression)',
    JSON.stringify(after.brokenLinks.map((b) => b.linkText)));
  const hub = read(wiki, 'entities/hub.md');
  assert(hub.includes('- bare [[rag]]') && hub.includes('- aliased [[rag|RAG]]')
    && hub.includes('- prefixed [[rag]]'), '4.4 all three forms repointed', hub);
  assert(read(wiki, 'summaries/paper.md').includes('[[rag]]'),
    '4.5 the SUMMARY link was repointed (its docblock promises this)');
  assert(read(wiki, 'concepts/rag.md').includes('a fact about Retrieval Augmented Generation'),
    '4.6 the merge itself still happened — the duplicate\'s facts survive on the survivor');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. CLASS GUARD — every DELETE CALL is preceded by a real repoint');
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Enumerate every `await rm(` in a source string, brace-match its enclosing
 * top-level function, and report whether that function calls
 * `repointInboundLinks(` at an EARLIER offset than the delete.
 *
 * Deliberately mechanical: the failure this whole change fixes is one guard
 * living inside one of several siblings, so a checker that names the three
 * handlers it knows about would reproduce the defect the next time a fourth
 * is added.
 */
function auditDeleteSites(src) {
  // Blank comments and string/template literals so a `rm(` inside prose or a
  // docblock is never counted — this file's own docblocks mention `await rm(`.
  const lines = src.split('\n');
  let inBlock = false;
  const code = lines.map((line) => {
    let l = line;
    if (inBlock) {
      const end = l.indexOf('*/');
      if (end === -1) return ' '.repeat(l.length);
      l = ' '.repeat(end + 2) + l.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = l.indexOf('/*');
      if (start === -1) break;
      const end = l.indexOf('*/', start + 2);
      if (end === -1) { l = l.slice(0, start) + ' '.repeat(l.length - start); inBlock = true; break; }
      l = l.slice(0, start) + ' '.repeat(end + 2 - start) + l.slice(end + 2);
    }
    const cut = l.indexOf('//');
    if (cut >= 0) l = l.slice(0, cut) + ' '.repeat(l.length - cut);
    return l.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, (m) => ' '.repeat(m.length));
  }).join('\n');

  // Top-level function declarations only — every fix handler in health.js is
  // one. Body extent found by brace matching from the opening `{`.
  const fns = [];
  const declRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = declRe.exec(code)) !== null) {
    const open = code.indexOf('{', m.index + m[0].length - 1);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    fns.push({ name: m[1], start: open, end });
  }

  const sites = [];
  // ── THE VERB HAS SIBLINGS, AND THEY ARE ONE WORD AWAY ─────────────────
  // The first version of this matched the literal `await rm(`. Every
  // DECLARATION form fails safe (an unrecognised binding makes the enumerator
  // find nothing to attribute), but an audit's mutation matrix showed six
  // real delete shapes passing this guard undetected:
  //
  //     await unlink(v)        rmSync(v)        rm(v)          [no await]
  //     Promise.all(vs.map(p => rm(p)))         await fsp.rm(v)
  //     import { rm as deletePage }  →  await deletePage(v)
  //
  // `unlink` is not hypothetical: it is a sibling export of the very
  // `fs/promises` import already at the top of health.js, so reaching for it
  // is a one-word edit — while this guard's docblock claims a forgetful
  // handler "cannot ship". A guard keyed on one spelling of a verb is a guard
  // keyed on a habit.
  //
  // So: every delete verb in the fs surface, with or without `await`, with or
  // without a namespace qualifier. `\b(?:…)\s*\(` also matches the
  // `fsp.rm(` / `fs.promises.rm(` forms because the verb itself is what is
  // anchored. Aliasing at the import is closed separately, below the
  // enumerator — a rename there makes the verb unrecognisable to any text
  // scan, so it is refused outright rather than chased.
  const rmRe = /\b(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/g;
  while ((m = rmRe.exec(code)) !== null) {
    const at = m.index;
    // Innermost enclosing top-level function (they do not nest here, but pick
    // the tightest span so a future nested declaration is handled).
    let owner = null;
    for (const f of fns) {
      if (at > f.start && at < f.end) {
        if (!owner || (f.end - f.start) < (owner.end - owner.start)) owner = f;
      }
    }
    const line = code.slice(0, at).split('\n').length;
    if (!owner) { sites.push({ line, fn: '<top level>', guarded: false }); continue; }
    const body = code.slice(owner.start, at);
    sites.push({ line, fn: owner.name, guarded: hasRealRepoint(body) });
  }
  return sites;
}

/**
 * Does this function body contain a repoint call that could actually DO
 * something before the delete?
 *
 * Not merely `/repointInboundLinks\s*\(/`. The audit's own second negative
 * control — `repointInboundLinks(wikiDir, [], "x", "entities")` — satisfied
 * a presence test while being provably INERT: the function's first act is
 * `if (slugs.length === 0) return 0`, so an empty `retired` array rewrites
 * nothing. A handler could therefore delete pages, leave every inbound link
 * dangling, and pass the class invariant by writing the call and passing it
 * nothing. That is the "decorative guard" shape this repo keeps finding, and
 * a guard that accepts a decorative call is itself decorative.
 *
 * A literal `[]` in the `retired` position is refused. Anything else — a
 * variable, a `.map(...)`, a literal with entries — is accepted: the point is
 * to reject a call that CANNOT work, not to prove one does.
 */
function hasRealRepoint(body) {
  const re = /\brepointInboundLinks\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const after = body.slice(m.index + m[0].length);
    // Second argument: skip the first arg up to its top-level comma.
    let depth = 0;
    let i = 0;
    for (; i < after.length; i++) {
      const c = after[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) { i++; break; }
    }
    const rest = after.slice(i).replace(/^\s+/, '');
    if (/^\[\s*\]/.test(rest)) continue; // inert: an empty retired list
    return true;
  }
  return false;
}

{
  const healthSrc = readFileSync(HEALTH_SRC_PATH, 'utf8');
  const sites = auditDeleteSites(healthSrc);

  // Anti-vacuity: a checker that finds nothing passes everything.
  assert(sites.length >= 3,
    '5.1 ANTI-VACUITY — the enumerator actually finds the delete sites in health.js',
    `found ${sites.length}: ${JSON.stringify(sites)}`);

  const owners = new Set(sites.map((s) => s.fn));
  assert(owners.has('fixCrossFolderDupe') && owners.has('fixHyphenVariant')
    && owners.has('fixSemanticDuplicate'),
    '5.2 …and attributes each one to its real enclosing handler',
    [...owners].join(', '));

  const unguarded = sites.filter((s) => !s.guarded);
  assert(unguarded.length === 0,
    '5.3 CLASS INVARIANT — every fs delete call in health.js is preceded, inside its '
    + 'own function, by a NON-INERT call to repointInboundLinks() — a page-deleting '
    + 'handler cannot forget to repoint links',
    unguarded.map((s) => `${s.fn} @ line ${s.line}`).join('; '));

  // ── NEGATIVE CONTROL ────────────────────────────────────────────────────
  // Inject a synthetic page-deleting handler that does NOT repoint. If the
  // guard above cannot see it, 5.3 is decoration.
  const injected = healthSrc.replace(
    'async function fixCrossFolderDupe(wikiDir, issue) {',
    'async function fixBrandNewMergeHandler(wikiDir, issue) {\n'
    + '  const victimPath = wikiFile(wikiDir, issue.remove);\n'
    + '  await rm(victimPath);\n'
    + '  return true;\n'
    + '}\n\n'
    + 'async function fixCrossFolderDupe(wikiDir, issue) {'
  );
  assert(injected !== healthSrc, '5.4 the negative-control injection actually applied');
  const injectedSites = auditDeleteSites(injected);
  const caught = injectedSites.filter((s) => !s.guarded);
  assert(caught.length === 1 && caught[0].fn === 'fixBrandNewMergeHandler',
    '5.5 NEGATIVE CONTROL — an injected page-deleting handler with no repoint is '
    + 'CAUGHT (and nothing else is falsely flagged)',
    JSON.stringify(caught));

  // A second negative control: the guard must key on ORDER, not mere presence.
  const reordered = healthSrc.replace(
    'async function fixCrossFolderDupe(wikiDir, issue) {',
    'async function fixAfterTheFactHandler(wikiDir, issue) {\n'
    + '  const victimPath = wikiFile(wikiDir, issue.remove);\n'
    + '  await rm(victimPath);\n'
    + '  await repointInboundLinks(wikiDir, [], "x", "entities");\n'
    + '  return true;\n'
    + '}\n\n'
    + 'async function fixCrossFolderDupe(wikiDir, issue) {'
  );
  const lateSites = auditDeleteSites(reordered).filter((s) => !s.guarded);
  assert(lateSites.length === 1 && lateSites[0].fn === 'fixAfterTheFactHandler',
    '5.6 NEGATIVE CONTROL — repointing AFTER the delete is still caught (the links '
    + 'would be rewritten against a file that is already gone)',
    JSON.stringify(lateSites));

  // And a positive control on the checker's comment-blindness: this very file
  // mentions `await rm(` in prose; health.js's own docblock mentions it too.
  const proseOnly = 'const x = 1;\n/**\n * mentions await rm( in a docblock\n */\n// and await rm( in a line comment\n';
  assert(auditDeleteSites(proseOnly).length === 0,
    '5.7 the enumerator ignores `await rm(` inside comments (health.js\'s own '
    + 'docblock names it)');

  // ── 5.8 THE VERB'S SIBLINGS ────────────────────────────────────────────
  // Each of these deletes a page and repoints nothing, and each one PASSED
  // the original `\bawait\s+rm\s*\(` guard. `unlink` in particular is a
  // sibling export of the fs/promises import already at the top of
  // health.js. Injected as real code into a copy of the real source, so a
  // shape that stops being caught fails here rather than in review.
  const deleteShapes = [
    ['await unlink(v)',        '  await unlink(victimPath);'],
    ['rmSync(v)',              '  rmSync(victimPath);'],
    ['rm(v) with no await',    '  rm(victimPath);'],
    ['rm inside a .map()',     '  await Promise.all([victimPath].map((p) => rm(p)));'],
    ['namespaced fsp.rm(v)',   '  await fsp.rm(victimPath);'],
    ['await unlinkSync(v)',    '  unlinkSync(victimPath);'],
    ['await rmdir(v)',         '  await rmdir(victimPath);'],
  ];
  for (const [label, stmt] of deleteShapes) {
    const src = healthSrc.replace(
      'async function fixCrossFolderDupe(wikiDir, issue) {',
      'async function fixShapeHandler(wikiDir, issue) {\n'
      + '  const victimPath = wikiFile(wikiDir, issue.remove);\n'
      + stmt + '\n'
      + '  return true;\n'
      + '}\n\n'
      + 'async function fixCrossFolderDupe(wikiDir, issue) {'
    );
    // A mutation that did not apply proves nothing — check it landed.
    if (src === healthSrc) { assert(false, `5.8 injection for "${label}" did not apply`); continue; }
    const caught = auditDeleteSites(src).filter((s) => !s.guarded);
    assert(caught.length === 1 && caught[0].fn === 'fixShapeHandler',
      `5.8 NEGATIVE CONTROL — a page-deleting handler written as \`${label}\` is CAUGHT`,
      JSON.stringify(caught));
  }

  // ── 5.9 AN INERT REPOINT IS NOT A REPOINT ──────────────────────────────
  // repointInboundLinks' first act is `if (slugs.length === 0) return 0`, so
  // a call passing an empty `retired` array rewrites nothing. Under a mere
  // presence test a handler could delete pages, orphan every inbound link,
  // and satisfy the class invariant by writing a call that cannot work.
  const inert = healthSrc.replace(
    'async function fixCrossFolderDupe(wikiDir, issue) {',
    'async function fixInertRepointHandler(wikiDir, issue) {\n'
    + '  const victimPath = wikiFile(wikiDir, issue.remove);\n'
    + '  await repointInboundLinks(wikiDir, [], "x", "entities");\n'
    + '  await rm(victimPath);\n'
    + '  return true;\n'
    + '}\n\n'
    + 'async function fixCrossFolderDupe(wikiDir, issue) {'
  );
  assert(inert !== healthSrc, '5.9a the inert-repoint injection actually applied');
  const inertCaught = auditDeleteSites(inert).filter((s) => !s.guarded);
  assert(inertCaught.length === 1 && inertCaught[0].fn === 'fixInertRepointHandler',
    '5.9 NEGATIVE CONTROL — a repoint call with an EMPTY `retired` list is inert and '
    + 'does NOT satisfy the guard (it returns 0 before touching a file)',
    JSON.stringify(inertCaught));

  // ANTI-VACUITY for 5.9: a real, non-empty second argument must still pass,
  // or the refinement would simply have broken the guard for everyone.
  const genuine = healthSrc.replace(
    'async function fixCrossFolderDupe(wikiDir, issue) {',
    'async function fixGenuineHandler(wikiDir, issue) {\n'
    + '  const victimPath = wikiFile(wikiDir, issue.remove);\n'
    + '  await repointInboundLinks(wikiDir, [{ folder: "entities", slug: "x" }], "y", "entities");\n'
    + '  await rm(victimPath);\n'
    + '  return true;\n'
    + '}\n\n'
    + 'async function fixCrossFolderDupe(wikiDir, issue) {'
  );
  assert(auditDeleteSites(genuine).filter((s) => !s.guarded).length === 0,
    '5.9b ANTI-VACUITY — a repoint with a REAL retired list still satisfies the guard '
    + '(the empty-literal refusal is narrow, not a blanket rejection)');

  // ── 5.10 ALIASING IS REFUSED, NOT CHASED ───────────────────────────────
  // `import { rm as deletePage }` makes the verb unrecognisable to ANY text
  // scan — there is no regex that recovers it, so the honest answer is to
  // forbid it at the import rather than pretend the enumerator can see it.
  // Read from the raw source's import lines (aliasing is only expressible
  // there for these bindings).
  const DELETE_VERBS = ['rm', 'rmSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync'];
  const importLines = healthSrc.split('\n').filter((l) => /^\s*import\s/.test(l));
  assert(importLines.some((l) => /from\s+'fs\/promises'/.test(l)),
    '5.10a PRECONDITION — health.js really does import from fs/promises (a renamed '
    + 'module would make the check below vacuous)');
  const aliased = importLines.filter((l) =>
    DELETE_VERBS.some((v) => new RegExp(`\\b${v}\\s+as\\s+`).test(l)));
  assert(aliased.length === 0,
    '5.10 NO ALIASING — no delete verb is imported under another name. An alias '
    + 'defeats every text-based enumeration of delete sites, including this one, '
    + 'so it is forbidden outright rather than pattern-matched around.',
    aliased.join(' | '));
  // Negative control: the alias detector can actually fail.
  const fakeImport = "import { readFile, rm as deletePage } from 'fs/promises';";
  assert(DELETE_VERBS.some((v) => new RegExp(`\\b${v}\\s+as\\s+`).test(fakeImport)),
    '5.10b NEGATIVE CONTROL — the alias detector fires on a real aliased import');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. fixAllSafe — the button that triggered the report');
// ═══════════════════════════════════════════════════════════════════════════
{
  const wiki = mkDomain('safeall', {
    'entities/tali-rezun.md': page('Tali Rezun', 'entity'),
    'entities/dr-tali-rezun.md': page('Dr Tali Rezun', 'entity'),
    'entities/google.md': page('Google', 'entity'),
    'concepts/google.md': page('Google', 'concept'),
    'entities/hub.md': page('Hub', 'entity',
      '- [[dr-tali-rezun]]\n- [[concepts/google]]\n- [[dr-tali-rezun|Doc]]\n'),
  });
  assert(AUTO_FIXABLE.has('hyphenVariants') && AUTO_FIXABLE.has('crossFolderDupes'),
    '6.1 PRECONDITION — both page-deleting types are AUTO_FIXABLE, so fix-all-safe '
    + 'really does reach them');
  const before = await scanWiki('safeall');
  assert(before.brokenLinks.length === 0, '6.2 PRECONDITION — zero broken links to start',
    JSON.stringify(before.brokenLinks));

  await fixAllSafe('safeall');
  const after = await scanWiki('safeall');
  // HONEST LABEL — this assertion is MASKED and is not independently
  // load-bearing. Measured: with the repoint call deleted from
  // fixHyphenVariant, 6.3 stayed GREEN. fixAllSafe runs `brokenLinks` LAST,
  // and the scanner's prefix-tolerant `normKey` suggestion resolves
  // `dr-tali-rezun` back to `tali-rezun`, so the bulk path silently repairs
  // the damage the merge caused. That self-healing is real but accidental: it
  // only works while the retired slug is normKey-derivable from the survivor.
  // 6.5 below is the unmaskable version. This one is kept because it pins the
  // end-to-end outcome of the button the user actually pressed.
  assert(after.brokenLinks.length === 0,
    '6.3 (MASKED — see 6.5) "Fix N safe issues" leaves zero dangling links end-to-end',
    JSON.stringify(after.brokenLinks.map((b) => `${b.sourceFile}::${b.linkText}`)));
  const hub = read(wiki, 'entities/hub.md');
  assert(hub.includes('[[tali-rezun]]') && hub.includes('[[tali-rezun|Doc]]')
    && hub.includes('[[google]]'), '6.4 every link repointed by the bulk path', hub);
}

// The literal reported click: Health → Hyphen variants → "Fix all 1", which is
// `fixIssue(domain, type, null)` — a DIFFERENT branch of fixIssue from the
// per-issue calls in sections 1-4, and the one with no brokenLinks pass after
// it to paper over the damage.
{
  const wiki = mkDomain('fixalltype', {
    'entities/tali-rezun.md': page('Tali Rezun', 'entity'),
    'entities/dr-tali-rezun.md': page('Dr Tali Rezun', 'entity'),
    'entities/hub.md': page('Hub', 'entity',
      '- [[dr-tali-rezun]]\n- [[dr-tali-rezun|Doc]]\n'),
  });
  const before = await scanWiki('fixalltype');
  assert(before.brokenLinks.length === 0 && before.hyphenVariants.length === 1,
    '6.5a PRECONDITION — one variant group, zero broken links');

  const r = await fixIssue('fixalltype', 'hyphenVariants', null);
  assert(r.fixed === 1 && r.total === 1,
    '6.5b the fix-all-of-type branch reports success (return contract unchanged)',
    JSON.stringify(r));
  const after = await scanWiki('fixalltype');
  assert(after.brokenLinks.length === 0,
    '6.5 UNMASKED — the exact reported click ("Fix all 1" under Hyphen variants) '
    + 'leaves zero dangling links. Nothing runs after it to repair them.',
    JSON.stringify(after.brokenLinks.map((b) => `${b.sourceFile}::${b.linkText}`)));
  assert(read(wiki, 'entities/hub.md').includes('[[tali-rezun|Doc]]'),
    '6.6 …with the alias intact');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. Refusals stay refusals — no path escapes, contract unchanged');
// ═══════════════════════════════════════════════════════════════════════════
{
  const wiki = mkDomain('refuse', {
    'entities/keep.md': page('Keep', 'entity'),
    'concepts/keep.md': page('Keep', 'concept'),
  });
  const outside = path.join(ROOT, 'VICTIM.md');
  writeFileSync(outside, 'do not delete me\n');

  const bad = [
    ['traversal in remove', { keep: 'entities/keep.md', remove: '../../VICTIM.md' }],
    ['absolute remove', { keep: 'entities/keep.md', remove: outside }],
    ['nested (3-segment) remove', { keep: 'entities/keep.md', remove: 'concepts/sub/keep.md' }],
    ['unknown folder', { keep: 'entities/keep.md', remove: 'people/keep.md' }],
    ['no .md suffix', { keep: 'entities/keep.md', remove: 'concepts/keep' }],
    ['non-string remove', { keep: 'entities/keep.md', remove: 42 }],
  ];
  // Each payload must be REFUSED, and refused by returning — not by throwing.
  // These shapes arrive from the MCP fix_wiki_issue tool, i.e. from an LLM,
  // and a raw TypeError there is an unhandled 500 rather than a refusal.
  // Catching per-item is also what keeps a regression here a FAILED
  // ASSERTION instead of an exception that kills the whole suite before the
  // later sections run (measured: disabling splitWikiRef's typeof guard used
  // to crash this file at this loop, which proves nothing about the guard).
  let refusals = 0;
  for (const [label, issue] of bad) {
    let threw = null, r = null;
    try { r = await fixIssue('refuse', 'crossFolderDupes', issue); }
    catch (err) { threw = err; }
    assert(threw === null, `7.0 ${label} is refused by RETURNING, never by throwing`,
      threw ? `${threw.name}: ${threw.message}` : '');
    if (r && r.fixed === 0) refusals++;
    else if (threw === null) assert(false, `7.x ${label} was NOT refused`, JSON.stringify(r));
  }
  // HONEST LABEL: 7.1 is a NON-REGRESSION assertion, not proof of the new
  // ref-splitter. Measured — deleting the `if (!keepRef || !removeRef) return
  // false` guard leaves all six of these GREEN, because `wikiFile()`'s
  // containment gate and the `existsSync` checks already refuse every one of
  // them. What it pins is that adding the splitter did not weaken any existing
  // refusal. 7.5 below is the case that is NOT masked.
  assert(refusals === bad.length,
    `7.1 (NON-REGRESSION — see 7.5) all ${bad.length} malformed crossFolderDupes `
    + 'payloads are still refused (fixed: 0)');
  assert(existsSync(outside), '7.2 the file outside the wiki still exists');
  assert(existsSync(path.join(wiki, 'concepts/keep.md')),
    '7.3 …and a refusal deleted nothing inside the wiki either');

  // The valid payload still works — a refusal test that refuses everything
  // (e.g. because splitWikiRef were too strict) would pass 7.1 vacuously.
  const before = await scanWiki('refuse');
  const r = await fixIssue('refuse', 'crossFolderDupes', before.crossFolderDupes[0]);
  assert(r.fixed === 1 && !existsSync(path.join(wiki, 'concepts/keep.md')),
    '7.4 ANTI-VACUITY — the valid payload is still accepted and still merges',
    JSON.stringify(r));
}

// The unmasked refusal: a NESTED page that really exists on disk. wikiFile()
// resolves it (it is inside the wiki) and existsSync passes, so every
// pre-existing guard lets it through — only the ref-splitter stands between an
// MCP-crafted payload and a delete whose links can never be repointed, because
// `concepts/sub/keep.md` has no (folder, slug) the link syntax can express.
{
  const wiki = mkDomain('refuse2', {
    'entities/keep.md': page('Keep', 'entity'),
    'entities/hub.md': page('Hub', 'entity', '- [[keep]]\n'),
  });
  mkdirSync(path.join(wiki, 'concepts', 'sub'), { recursive: true });
  writeFileSync(path.join(wiki, 'concepts', 'sub', 'keep.md'), page('Keep', 'concept'));

  const issue = { keep: 'entities/keep.md', remove: 'concepts/sub/keep.md' };
  let threw = null;
  let res = null;
  try { res = await fixIssue('refuse2', 'crossFolderDupes', issue); }
  catch (err) { threw = err; }

  assert(threw === null,
    '7.5a the nested-path payload does not CRASH the handler',
    threw ? `${threw.name}: ${threw.message}` : '');
  assert(res && res.fixed === 0,
    '7.5 UNMASKED — a nested page that exists on disk and passes wikiFile() is still '
    + 'refused, because its (folder, slug) is not expressible as a [[link]] and its '
    + 'inbound links could therefore never be repointed',
    JSON.stringify(res));
  assert(existsSync(path.join(wiki, 'concepts', 'sub', 'keep.md')),
    '7.6 …and the nested page was not deleted');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7b. splitWikiRef — every condition, driven directly');
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS SECTION EXISTS, stated plainly: an audit found that splitWikiRef's
// USE was covered (deleting `if (!keepRef || !removeRef) return false;` goes
// RED at 7.5) while its CONDITIONS were not. MEASURED here, by replacing each
// of its seven guards with `if (false) return null;` in a copy of the real
// source and re-running this suite:
//
//   parts.length !== 2 ................ 89/0   decorative
//   folder allow-list ................. 89/0   decorative
//   .md suffix ........................ 89/0   decorative
//   empty / >200-char slug ............ 89/0   decorative
//   '.' / '..' / backslash ............ 89/0   decorative
//   [\r\n\[\]|] delimiter chars ....... 89/0   decorative
//   typeof rel !== 'string' ........... CRASH  (a TypeError, not an assertion —
//                                              a red for the wrong reason, so
//                                              uncovered as a GUARD)
//
// Six of seven had no test that could fail, on the LAST gate before a delete
// whose inbound links can never be repointed. The repo's convention is that
// an uncovered guard is either covered or labelled NOT ENFORCED; covering is
// cheap here because splitWikiRef is a pure function, so it is covered.
//
// HONEST SCOPE: this drives an EXTRACTED COPY of the function (brace-matched
// out of the real source and evaluated with `new Function` — the technique
// scripts/test-cutover.js and scripts/test-chat-markdown.js use), because it
// is not exported. What that gives is "each condition does what it says".
// What it does NOT give is "this function is on the destructive path" —
// §7.5 already proves that behaviourally, through the real fixIssue, and the
// two together are the claim. The extraction is anchored so it fails loudly
// if the function is renamed or restructured rather than silently testing
// nothing.
{
  const healthSrc = readFileSync(HEALTH_SRC_PATH, 'utf8');
  const start = healthSrc.indexOf('function splitWikiRef(rel) {');
  assert(start !== -1,
    '7b.0 ANCHOR — splitWikiRef is still declared in health.js under that name '
    + '(a rename must fail here, not silently skip the section)');

  let splitWikiRef = null;
  if (start !== -1) {
    let depth = 0, end = -1;
    for (let i = healthSrc.indexOf('{', start); i < healthSrc.length; i++) {
      if (healthSrc[i] === '{') depth++;
      else if (healthSrc[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const src = healthSrc.slice(start, end);
    // Tripwire: a desynced brace match would extract something short and every
    // assertion below would then be testing a stub.
    assert(end !== -1 && src.length > 300 && src.includes('return { folder, slug };'),
      '7b.0b the extraction is the WHOLE function, not a truncated fragment',
      `${src.length} chars`);
    splitWikiRef = new Function(src + '\nreturn splitWikiRef;')();
  }

  const S = splitWikiRef || (() => null);
  const okRef = (rel, folder, slug, label) => {
    const r = S(rel);
    assert(r && r.folder === folder && r.slug === slug, label, JSON.stringify(r));
  };

  // ANTI-VACUITY first: if every input returned null these assertions would
  // all pass while proving nothing.
  okRef('entities/tali-rezun.md', 'entities', 'tali-rezun', '7b.1 ANTI-VACUITY — a valid entities ref splits');
  okRef('concepts/rag.md', 'concepts', 'rag', '7b.2 …a valid concepts ref splits');
  okRef('summaries/paper.md', 'summaries', 'paper', '7b.3 …a valid summaries ref splits');
  okRef('entities/petar-urdešić.md', 'entities', 'petar-urdešić',
    '7b.4 …and a NON-ASCII slug splits (the deliberate absence of a character class — see §8)');

  // GUARD 1 — typeof. Must return null, NOT throw: the payload can come from
  // an LLM-crafted MCP fix_wiki_issue object, and a TypeError there is an
  // unhandled 500 rather than a refusal. Disabling this guard did not fail an
  // assertion, it CRASHED the suite.
  for (const bad of [42, null, undefined, {}, [], true, Symbol('x')]) {
    let threw = null, r;
    try { r = S(bad); } catch (e) { threw = e; }
    assert(threw === null && r === null,
      `7b.5 GUARD typeof — ${String(typeof bad)} input is REFUSED (null), not thrown`,
      threw ? `${threw.name}: ${threw.message}` : JSON.stringify(r));
  }

  // GUARD 2 — exactly two segments. One segment has no folder; three or more
  // is the nested case §7.5 proves is genuinely reachable on disk, and whose
  // (folder, slug) no [[link]] can express.
  //
  // MEASURED AND CHASED, not reported as coverage: the obvious fixtures below
  // are all MASKED. Disabling this guard alone left the suite at 129/0,
  // because 'concepts/sub/keep.md' is then caught by the .md-suffix guard
  // (file becomes "sub"), and 'tali-rezun.md' / '' / '/' by the folder
  // allow-list (folder becomes the whole string, or ""). They are kept —
  // they pin the OUTCOME a caller depends on — but they do not make this
  // guard load-bearing on their own.
  for (const bad of ['tali-rezun.md', 'concepts/sub/keep.md', 'a/b/c/d.md', '', '/', 'entities/']) {
    assert(S(bad) === null, `7b.6 GUARD segments — ${JSON.stringify(bad)} is refused`, JSON.stringify(S(bad)));
  }
  // THE UNMASKED CASE, and the one that shows why the guard is not tidiness:
  // every later guard PASSES for this input (folder "entities", file "x.md"
  // ending in .md, slug "x" clean), so with the segment check disabled it
  // splits to { entities, x } — a THREE-segment reference silently reported
  // as the two-segment page `entities/x.md`. The caller would then repoint
  // every [[x]] in the domain while `wikiFile()` resolves the delete against
  // the original, different path: link rewriting aimed at the wrong page.
  for (const bad of ['entities/x.md/y.md', 'entities/keep.md/sub', 'concepts/a.md/b/c']) {
    assert(S(bad) === null,
      `7b.6b GUARD segments UNMASKED — ${JSON.stringify(bad)} is refused even though every `
      + 'OTHER guard would let it through', JSON.stringify(S(bad)));
  }

  // GUARD 3 — folder allow-list. `people/` was a real pre-v2 folder, and
  // `..` as a folder is the traversal shape.
  for (const bad of ['people/x.md', 'raw/x.md', '../x.md', 'Entities/x.md', 'wiki/x.md']) {
    assert(S(bad) === null, `7b.7 GUARD folder — ${JSON.stringify(bad)} is refused`, JSON.stringify(S(bad)));
  }

  // GUARD 4 — .md suffix.
  for (const bad of ['entities/x', 'entities/x.markdown', 'entities/x.MD', 'entities/x.md.txt']) {
    assert(S(bad) === null, `7b.8 GUARD suffix — ${JSON.stringify(bad)} is refused`, JSON.stringify(S(bad)));
  }

  // GUARD 5 — empty and over-long slugs. The slug is regex-ESCAPED into a
  // generated pattern, so length is about a runaway pattern, not traversal.
  assert(S('entities/.md') === null, '7b.9 GUARD empty slug — "entities/.md" is refused');
  assert(S('entities/' + 'a'.repeat(200) + '.md') !== null,
    '7b.10 BOUNDARY — a 200-char slug is accepted (the limit is not off-by-one against real data)');
  assert(S('entities/' + 'a'.repeat(201) + '.md') === null,
    '7b.11 GUARD length — a 201-char slug is refused');

  // GUARD 6 — '.', '..' and backslash: the two slugs that would name a
  // DIRECTORY rather than a page. The inputs are counted out rather than
  // guessed, because `.slice(0, -3)` strips exactly ".md": "entities/..md"
  // leaves slug ".", and "entities/...md" leaves "..". (A first draft of
  // this section had them one dot apart and failed — the fixture was wrong,
  // not the guard.)
  assert(S('entities/..md') === null, '7b.12 GUARD dot — a slug of "." is refused');
  assert(S('entities/...md') === null, '7b.13 GUARD dotdot — a slug of ".." is refused');
  // …and only those two. "..." is not a traversal token, and refusing it
  // would be the ASCII-slug over-strictness §8 exists to prevent.
  okRef('entities/....md', 'entities', '...',
    '7b.13b BOUNDARY — a slug of "..." is NOT refused (the guard names two exact tokens, it is not a dot heuristic)');
  assert(S('entities/a\\b.md') === null, '7b.14 GUARD backslash — a backslash in the slug is refused');

  // GUARD 7 — characters that could never appear in a real [[wikilink]] and
  // would produce a nonsense generated pattern.
  for (const ch of ['\r', '\n', '[', ']', '|']) {
    const bad = `entities/a${ch}b.md`;
    assert(S(bad) === null,
      `7b.15 GUARD delimiters — ${JSON.stringify(ch)} in the slug is refused`, JSON.stringify(S(bad)));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. Non-ASCII slugs are not silently refused');
// ═══════════════════════════════════════════════════════════════════════════
// entities/petar-urdešić.md and entities/snežana-ilić.md exist in real user
// wikis today. An ASCII-only slug rule in the new ref-splitter would refuse
// the merge — which reads as "the fix did nothing" — or, worse, would skip the
// repoint while the delete proceeded.
{
  const wiki = mkDomain('nonascii', {
    'entities/petar-urdešić.md': page('Petar Urdešić', 'entity'),
    'concepts/petar-urdešić.md': page('Petar Urdešić', 'concept'),
    'entities/hub.md': page('Hub', 'entity',
      '- bare [[petar-urdešić]]\n- prefixed [[concepts/petar-urdešić]]\n'),
  });
  const before = await scanWiki('nonascii');
  assert(before.crossFolderDupes.length === 1,
    '8.1 PRECONDITION — the non-ASCII cross-folder pair is detected',
    JSON.stringify(before.crossFolderDupes));
  const r = await fixIssue('nonascii', 'crossFolderDupes', before.crossFolderDupes[0]);
  assert(r.fixed === 1, '8.2 the merge is NOT refused for a non-ASCII slug', JSON.stringify(r));
  const after = await scanWiki('nonascii');
  assert(after.brokenLinks.length === 0,
    '8.3 …and its links were repointed too',
    JSON.stringify(after.brokenLinks.map((b) => b.linkText)));
  assert(read(wiki, 'entities/hub.md').includes('- prefixed [[petar-urdešić]]'),
    '8.4 the folder-prefixed non-ASCII link was rewritten');
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. /next per-section "Fix all" confirms before running');
// ═══════════════════════════════════════════════════════════════════════════
{
  const dm = readFileSync(path.join(REPO, 'src/public/next/views/domains.js'), 'utf8');
  assert(/confirmFixAllOfType\(domain\.slug, btn\.dataset\.fixall\)/.test(dm),
    '9.1 the per-section Fix-all button routes through a confirm, not straight to '
    + 'fixAllOfType');
  assert(!/\.then\(\(\) => fixAllOfType\(domain\.slug/.test(dm),
    '9.2 …and the un-gated direct call is gone');
  assert(/function confirmFixAllOfType\([\s\S]{0,1400}state\.confirm = \{/.test(dm),
    '9.3 the gate reuses the existing state.confirm plumbing (no new dialog mechanism)');
  assert(/DESTRUCTIVE_FIX_TYPES = new Set\(\['crossFolderDupes', 'hyphenVariants'\]\)/.test(dm),
    '9.4 the two page-DELETING types are named, so their copy can say so');
  assert(/DELETES the duplicate page/.test(dm),
    '9.5 …and the destructive copy actually says a page will be deleted');

  // ── 9b. THE COUNT IN THAT SENTENCE MUST BE PAGES, NOT ISSUES ───────────
  // AN ISSUE IS NOT A PAGE. Measured against the real scanWiki + fixIssue:
  //
  //   crossFolderDupes  { keep, remove }          -> 1 delete per issue
  //   hyphenVariants    { files: [a, b, c], … }   -> files.length - 1 = 2
  //
  // The dialog used `issues.length` for both, so a three-slug variant group
  // announced "1 page will be deleted" and the wiki went 6 pages -> 4.
  // Under-report = groupSize - 2, unbounded. This is the operation that
  // produced the original bug report and the dialog is the only thing
  // standing between a user and it, so the arithmetic is driven here rather
  // than eyeballed: the real function is extracted and executed.
  const dcStart = dm.indexOf('function deletedPageCount(');
  assert(dcStart !== -1,
    '9b.0 ANCHOR — domains.js still has deletedPageCount() (a rename must fail here)');
  if (dcStart !== -1) {
    let depth = 0, end = -1;
    for (let i = dm.indexOf('{', dcStart); i < dm.length; i++) {
      if (dm[i] === '{') depth++;
      else if (dm[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const deletedPageCount = new Function(dm.slice(dcStart, end) + '\nreturn deletedPageCount;')();

    // The exact live repro: ONE issue, THREE files, TWO deletions.
    const group3 = [{ files: ['dr-tali-rezun', 'tali-rezun', 'talirezun'], suggestedSlug: 'tali-rezun' }];
    assert(deletedPageCount('hyphenVariants', group3) === 2,
      '9b.1 THE DEFECT — one hyphen-variant GROUP of three slugs reports TWO deletions, '
      + 'not one (measured: 6 pages -> 4 on the real fixIssue)',
      String(deletedPageCount('hyphenVariants', group3)));
    assert(group3.length === 1,
      '9b.2 …and the ISSUE count really is 1, so the title and the sentence are '
      + 'genuinely different numbers (this is not a distinction without a difference)');

    // A pair still reports one — the fix must not over-count the common case.
    assert(deletedPageCount('hyphenVariants',
      [{ files: ['dr-tali-rezun', 'tali-rezun'], suggestedSlug: 'tali-rezun' }]) === 1,
      '9b.3 a two-slug group still reports ONE deletion');
    // Groups sum.
    assert(deletedPageCount('hyphenVariants', [
      { files: ['a', 'b', 'c'] }, { files: ['d', 'e'] }, { files: ['f', 'g', 'h', 'i'] },
    ]) === 2 + 1 + 3, '9b.4 multiple groups sum their deletions (2 + 1 + 3 = 6)');

    // crossFolderDupes is a PAIR — determined by measurement, not assumed.
    assert(deletedPageCount('crossFolderDupes', [
      { keep: 'entities/google.md', remove: 'concepts/google.md' },
      { keep: 'entities/e-mail.md', remove: 'concepts/email.md' },
    ]) === 2, '9b.5 crossFolderDupes is a PAIR shape — one deletion per issue');

    // Degenerate shapes ROUND UP. A destructive confirm that understates is
    // worse than one that overstates.
    assert(deletedPageCount('hyphenVariants', [{ suggestedSlug: 'x' }]) === 1,
      '9b.6 an unrecognisable issue shape rounds UP to 1, never down to 0 — a '
      + 'destructive confirm must never understate');
    assert(deletedPageCount('hyphenVariants', [{ files: [] }, { files: ['solo'] }]) === 0,
      '9b.7 …but a genuinely empty group contributes 0 (no invented deletions)');
    assert(deletedPageCount('hyphenVariants', []) === 0, '9b.8 no issues -> no deletions');
  }

  // The copy has to match the SHAPE too: one hyphen-variant issue can hold
  // three or more slugs, so "each pair" was wrong about more than the count.
  assert(!/MERGES each pair/.test(dm),
    '9b.9 the destructive copy no longer says "each pair" — a variant issue is a GROUP');
  assert(/MERGES each group/.test(dm),
    '9b.10 …it says "group"');
  assert(/deletedPageCount\(type, issues\)/.test(dm),
    '9b.11 and the sentence consumes the PAGE count, not issues.length');
}

// ── Cleanup ────────────────────────────────────────────────────────────────
try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
__setDomainsDirOverride(null);

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
