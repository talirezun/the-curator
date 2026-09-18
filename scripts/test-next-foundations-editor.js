#!/usr/bin/env node
/**
 * test-next-foundations-editor.js — OFFLINE suite. No network, no API key, no
 * LLM, and it writes nothing anywhere.
 *
 * Guards v3.61.0's start-a-project flow on the VIEW side: the ownership
 * chooser shared by the "New project" form and the Agent-memory Foundations
 * block (src/public/next/shared/foundations-init.js), and the foundation
 * EDITOR that made tier 0 writable by its owner for the first time
 * (src/public/next/views/memory.js).
 *
 * ── WHY THIS IS A SUITE OF ITS OWN ───────────────────────────────────────
 * scripts/test-next-memory-view.js already runs over a thousand assertions
 * and owns the block's READ surface — the facts, the word, the table, the
 * reader. What lands here is the WRITE surface: the four routes the view can
 * now reach, the wall it refuses at, the grammar it validates a name against,
 * and the file a person picks off their own disk.
 *
 * ── EVERYTHING DRIVES REAL CODE ──────────────────────────────────────────
 * shared/foundations-init.js takes NO imports (the shared/text.js contract), so
 * it is IMPORTED rather than lifted. views/memory.js registers a view and
 * reaches for a DOM at import time, so its functions are lifted by
 * brace-matching and executed against injected collaborators — the technique
 * test-next-memory-view.js and test-next-domain-projects.js both use, and for
 * the reason this repo keeps re-learning: a test that proves a line of source
 * exists proves nothing about what it does.
 *
 * ── ENFORCED ─────────────────────────────────────────────────────────────
 *  · THE FOUR STORE MIRRORS ARE THE STORE'S. The slug grammar, the seven role
 *    names, the 512 KB per-document wall and the 200 KB project budget are
 *    compared against src/brain/working-state.js, not against literals typed
 *    here. A view refusing at a DIFFERENT figure from the server either blocks
 *    a save the server would accept or offers one it refuses with a 400 the
 *    owner cannot act on.
 *  · THE EDITOR LOADS RAW BYTES, AND THE ROUND TRIP IS BYTE-EXACT. The read
 *    path defangs protocol-shaped text; the write path is verbatim. Load the
 *    defanged read into an editor and the first save writes it back — the
 *    document is corrupted by the act of opening it. Pinned by sha256 over a
 *    document full of exactly the text the sanitiser touches.
 *  · THE WALL IS A WALL AND THE BUDGET IS A DISCLOSURE. Over 512 KB Save is
 *    disabled with both numbers shown; over the 200 KB project budget the save
 *    is OFFERED and the overrun is stated, because the store accepts it and a
 *    UI must not refuse what the store accepts.
 *  · A SHRINK IS CONFIRMED, WITH BOTH SIZES NAMED. The route passes
 *    `replace: true` (the store's own guard is advice a person in a browser
 *    cannot take), so the honesty is here.
 *  · A LATE REPLY IS DROPPED and A FAILURE KEEPS THE DRAFT — the draft is the
 *    only copy.
 *  · NOTHING IS UPLOADED when a file is chosen from disk: the wall is checked
 *    on `file.size` BEFORE the read, the text lands in the FIELD, and the save
 *    is the ordinary PUT.
 *  · THE READER SAYS WHY it cannot be edited there, per ownership, and the
 *    default is the pre-v3.61.0 sentence byte-for-byte.
 *
 * ── NOT ENFORCED (named, not implied away) ───────────────────────────────
 *  · There is no DOM engine here (this repo ships zero devDeps). §7 and §10
 *    build a DOM MODEL and dispatch at the shipped listeners; layout, the two
 *    themes, and what Chromium does with a focused node removed mid-edit are
 *    the orchestrator's Browser-pane pass.
 *  · `FileReader` is a browser global with no honest Node stand-in, so
 *    `readPickedFile` takes a reader seam (the shape `compileConversation`'s
 *    `opts.generateText` is). What is proven is what the shipped code does
 *    with the bytes, not that Chromium decodes UTF-8.
 *  · The ROUTES are not exercised: they are another work package's file. Every
 *    URL, method and body asserted here is the wire shape both packages built
 *    to, and scripts/test-next-memory-projects.js owns the server half.
 *  · THE ROLE TABLE'S EQUALITY WITH THE STORE'S is asserted only when the
 *    store's own scan is present on disk — see §2's own note. It is the one
 *    pin in this file that can be INERT, and it says so out loud rather than
 *    passing quietly.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NEXT = join(ROOT, 'src/public/next');
const viewSrc = readFileSync(join(NEXT, 'views/memory.js'), 'utf8');
const initSrc = readFileSync(join(NEXT, 'shared/foundations-init.js'), 'utf8');
const appSrc = readFileSync(join(NEXT, 'app.js'), 'utf8');
const storeSrc = readFileSync(join(ROOT, 'src/brain/working-state.js'), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected),
    'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) {
  console.log('\n═════════════════════════════════════════════════════════');
  console.log(t);
  console.log('═════════════════════════════════════════════════════════');
}
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── Extraction ───────────────────────────────────────────────────────────
// Brace-matched and THROWS on a missing name or a desynced match, rather than
// handing the sandbox something that fails later as a bare SyntaxError.
function extractFunction(source, name) {
  const marker = new RegExp('(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ' + name + '\\s*\\(');
  const m = marker.exec(source);
  if (!m) throw new Error('extractFunction: "' + name + '" not found');
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  let pd = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') pd++;
    else if (source[p] === ')') { pd--; if (pd === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  let d = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') d++;
    else if (source[i] === '}') { d--; if (d === 0) { i++; break; } }
  }
  const out = source.slice(start, i);
  if (out.includes('\n') && !/\n\}$/.test(out)) throw new Error('extractFunction: "' + name + '" desynced');
  // `export` is stripped: a lifted function is executed inside `new Function`,
  // where an export declaration is a SyntaxError — and whether a function
  // happens to be exported from the module is not a property this suite has
  // any business depending on.
  return out.replace(/^export\s+/, '');
}

// The REAL shared module. No imports of its own, so it runs in Node.
const FI = await import('../src/public/next/shared/foundations-init.js');

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ═════════════════════════════════════════════════════════════════════════
section('§1 — THE FOUR STORE MIRRORS ARE THE STORE\'S');
// ═════════════════════════════════════════════════════════════════════════
//
// Precedent: views/memory.js's `BRIEF_MAX_BYTES` has been compared against the
// store's exported `MAX_BRIEF_BYTES` since v3.48.0, for the reason that makes
// this section worth having at all — a view enforcing a DIFFERENT number from
// the server either blocks a save the server would accept, or offers one it
// refuses with a 400 the owner cannot act on.
{
  const num = (name) => {
    const m = new RegExp('export const ' + name + ' = ([^;]+);').exec(storeSrc);
    if (!m) throw new Error(name + ' not found in working-state.js — this pin would be a paraphrase');
    // eslint-disable-next-line no-new-func
    return new Function('return (' + m[1] + ');')();
  };
  eq('the per-document WALL is the store\'s MAX_FOUNDATION_BYTES',
    FI.MAX_FOUNDATION_BYTES, num('MAX_FOUNDATION_BYTES'));
  eq('the project BUDGET is the store\'s FOUNDATIONS_BUDGET_BYTES',
    FI.FOUNDATIONS_BUDGET_BYTES, num('FOUNDATIONS_BUDGET_BYTES'));
  ok('the wall is genuinely 512 KB and the budget 200 KB, so a silent swap of the two '
    + 'would red here as well as above',
  FI.MAX_FOUNDATION_BYTES === 512 * 1024 && FI.FOUNDATIONS_BUDGET_BYTES === 200 * 1024,
  FI.MAX_FOUNDATION_BYTES + ' / ' + FI.FOUNDATIONS_BUDGET_BYTES);

  // THE SLUG GRAMMAR, compared as SOURCE TEXT. `RegExp.prototype.source` is
  // the only honest comparison: two patterns that differ by a single quantifier
  // accept different names, and there is no way to enumerate the difference.
  const storeRe = /const FOUNDATION_SLUG_RE = (\/[^\n]*\/);/.exec(storeSrc);
  ok('the store declares FOUNDATION_SLUG_RE (the pin is not vacuous)', !!storeRe, String(storeRe));
  // eslint-disable-next-line no-new-func
  const storePattern = storeRe ? new Function('return (' + storeRe[1] + ');')() : null;
  eq('the view\'s mirrored slug grammar is the store\'s, character for character',
    FI.FOUNDATION_SLUG_RE.source, storePattern && storePattern.source);
  eq('...and carries the same flags', FI.FOUNDATION_SLUG_RE.flags, storePattern && storePattern.flags);

  // THE SEVEN ROLES, in the store's ORDER — the manifest's reading order is
  // derived from it, so a reordered copy would put a document in a different
  // place in the reading plan than the table the owner picked it in.
  const rolesM = /export const FOUNDATION_ROLES = Object\.freeze\((\[[\s\S]*?\])\);/.exec(storeSrc);
  ok('the store declares FOUNDATION_ROLES', !!rolesM);
  // eslint-disable-next-line no-new-func
  const storeRoles = rolesM ? new Function('return (' + rolesM[1] + ');')() : null;
  eq('the view\'s mirrored role list is the store\'s, in the store\'s order',
    JSON.stringify([...FI.FOUNDATION_ROLES]), JSON.stringify(storeRoles));

  // The four skeleton slugs. The skeleton TEXT lives in the store and no view
  // carries a copy (the release's D1); what the view needs without a round
  // trip is which slugs the seeding writes, so an import landing on one can be
  // reported as REPLACING a skeleton rather than leaving the owner to work out
  // which of the two won.
  eq('the four skeleton slugs are the four the release seeds',
    JSON.stringify([...FI.SKELETON_SLUGS]),
    JSON.stringify(['architecture.md', 'decisions.md', 'conventions.md', 'roadmap.md']));
  ok('every one of them is a name the store\'s own grammar accepts',
    FI.SKELETON_SLUGS.every((s) => FI.FOUNDATION_SLUG_RE.test(s)));
  ok('the view carries NO copy of any skeleton BODY — that lives in the store',
    !/Skeleton — not yet written/.test(viewSrc) && !/Skeleton — not yet written/.test(initSrc));

  // The module takes no imports, which is what lets this suite import it. Said
  // as an assertion because it is a contract, not a coincidence: an import here
  // would reach app.js and the module would stop being runnable in Node.
  ok('shared/foundations-init.js takes NO imports, the shared/text.js contract',
    !/^import\s/m.test(initSrc), (/^import[^\n]*/m.exec(initSrc) || [''])[0]);
  // Its local escapeHtml is byte-compared against the shell's, so the two
  // cannot drift into escaping different characters.
  {
    const local = /function escapeHtml\(s\) \{[\s\S]*?\n\}/.exec(initSrc);
    ok('it carries a local escapeHtml (the no-imports consequence)', !!local);
    ok('...escaping exactly the five characters the shell\'s does',
      local && /&amp;/.test(local[0]) && /&lt;/.test(local[0]) && /&gt;/.test(local[0])
      && /&quot;/.test(local[0]) && /&#39;/.test(local[0]), local ? local[0] : 'none');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — A FILENAME IN: the slug, the role and the title');
// ═════════════════════════════════════════════════════════════════════════
{
  eq('a plain name is its own slug', FI.slugForFilename('architecture.md'), 'architecture.md');
  eq('the directories go — a slug is FLAT', FI.slugForFilename('docs/notes/Arch.md'), 'arch.md');
  eq('...including a Windows path', FI.slugForFilename('C:\\docs\\Arch.md'), 'arch.md');
  eq('case folds down, because the grammar is lowercase',
    FI.slugForFilename('ARCHITECTURE.MD'), 'architecture.md');
  eq('underscores and spaces become hyphens',
    FI.slugForFilename('My_Architecture Notes.md'), 'my-architecture-notes.md');
  eq('a .txt becomes a .md, because the store stores markdown',
    FI.slugForFilename('conventions.txt'), 'conventions.md');
  eq('runs of junk collapse rather than stacking hyphens',
    FI.slugForFilename('a---b   c__d.md'), 'a-b-c-d.md');
  eq('a name with no extension still lands on .md', FI.slugForFilename('README'), 'readme.md');
  // NULL RATHER THAN A BEST EFFORT. A slug the store will refuse is a 400 the
  // owner cannot act on, so the field is pre-filled only when the derivation
  // lands inside the grammar and is left for them to type otherwise.
  eq('a dotfile has no usable name — the grammar needs a leading alphanumeric, and '
    + '`md.md` is a name the owner never chose', FI.slugForFilename('.md'), null);
  eq('...and neither has a name that is only punctuation', FI.slugForFilename('---.md'), null);
  eq('...nor an empty one', FI.slugForFilename(''), null);
  ok('every slug it DOES return is one the store\'s own grammar accepts',
    ['architecture.md', 'docs/a b.txt', 'ADR_0003.md', 'x'.repeat(200) + '.md']
      .map((n) => FI.slugForFilename(n))
      .every((s) => s === null || FI.FOUNDATION_SLUG_RE.test(s)));
  eq('...including one long enough to need the 63-character cut',
    FI.slugForFilename('x'.repeat(200) + '.md'), 'x'.repeat(63) + '.md');

  // ── THE ROLE TABLE ────────────────────────────────────────────────────
  const ROLE_CASES = [
    ['architecture.md', 'architecture'], ['ARCHITECTURE-v2.md', 'architecture'],
    ['decisions.md', 'decisions'], ['adr-0003-use-sqlite.md', 'decisions'],
    ['ADR.md', 'decisions'], ['conventions.md', 'conventions'],
    ['CONTRIBUTING.md', 'conventions'], ['styleguide.md', 'conventions'],
    ['roadmap.md', 'roadmap'], ['plan-2026.md', 'roadmap'],
    ['api.md', 'api'], ['api-reference.md', 'api'],
    ['README.md', 'guide'], ['user-guide.md', 'guide'], ['handbook.md', 'guide'],
    ['notes.md', 'other'], ['', 'other'],
  ];
  for (const [name, role] of ROLE_CASES) {
    eq('role of ' + (name || '<empty>') + ' is ' + role, FI.roleForBasename(name), role);
  }
  // ORDER IS PART OF THE TABLE, and these two are the cases that prove it:
  // `contributing.md` would match `guide` if `conventions` were not tested
  // first, and an ADR filename has no word in common with "decisions".
  eq('CONTRIBUTING matches conventions BEFORE it can reach guide',
    FI.roleForBasename('CONTRIBUTING-guide.md'), 'conventions');
  ok('every role it returns is one of the store\'s seven',
    ROLE_CASES.every(([n]) => FI.FOUNDATION_ROLES.includes(FI.roleForBasename(n))));

  // ── THE ONE THING THIS FILE CANNOT YET PIN, STATED RATHER THAN FAKED ──
  //
  // The store's repo scan derives the SAME role from the SAME basenames, and
  // the table above is a mirror of it: the IMPORT path never reaches that scan
  // (a file picked off disk is read in the browser and PUT as text, so the
  // server never sees its original name), so two tables answer one question.
  // That is exactly the drift §1 exists to catch — and it cannot be caught
  // until `scanRepoForFoundations` is on disk, which is another work package's
  // file.
  //
  // It is reported as a LINE, not as an assertion. A green assertion over an
  // absent subject is the shape this repo has recorded twice as worse than no
  // assertion at all, and a red one would report another package's schedule as
  // this package's defect. When the scan lands, the assertion below it goes
  // live; until then this is the honest record.
  {
    const hasScan = /function scanRepoForFoundations\s*\(/.test(storeSrc);
    if (hasScan) {
      const roleWords = ['architecture', 'decision', 'adr', 'convention', 'contributing',
        'style', 'roadmap', 'plan', 'api', 'readme', 'guide', 'handbook'];
      const missing = roleWords.filter((w) => !new RegExp(w, 'i').test(storeSrc));
      ok('the store\'s own role heuristic names every basename word this mirror does',
        missing.length === 0, 'the store never mentions: ' + JSON.stringify(missing));
    } else {
      console.log('  → NOT VERIFIED (no assertion): src/brain/working-state.js carries no '
        + '`scanRepoForFoundations` in this checkout, so the view↔store role-table equality '
        + 'is unpinned. The table above is pinned EXACTLY; what is missing is the comparison '
        + 'against the store\'s copy of it.');
    }
  }

  // ── THE TITLE ─────────────────────────────────────────────────────────
  eq('the title is the document\'s own first `# ` heading',
    FI.titleFromText('# How it fits\n\nbody', 'a.md'), 'How it fits');
  eq('...whitespace around it trimmed',
    FI.titleFromText('#    Spaced   \n', 'a.md'), 'Spaced');
  eq('...taken even when prose comes first',
    FI.titleFromText('intro line\n\n# Real Title\n', 'a.md'), 'Real Title');
  eq('a `## ` heading is NOT a title — a document whose first heading is "## Overview" '
    + 'has not named itself', FI.titleFromText('## Overview\n\nbody', 'my-doc.md'), 'my-doc');
  eq('with no heading the basename is the fallback, which is worse than the document\'s own '
    + 'title and better than nothing', FI.titleFromText('no heading', 'docs/my-doc.md'), 'my-doc');
  eq('...and an empty everything still answers something',
    FI.titleFromText('', ''), 'Untitled');
  ok('a title is capped so a 40 KB first line cannot become a heading',
    FI.titleFromText('# ' + 'x'.repeat(500), 'a.md').length === 120);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — THE CHOICE, AS A REQUEST BODY');
// ═════════════════════════════════════════════════════════════════════════
{
  const c = FI.freshChooser({ allowLater: true });
  eq('a fresh choice defaults to the answer that works with no preconditions',
    c.ownership, 'curator');
  eq('...with the four skeletons ticked', c.seed, true);
  eq('the curator arm sends the ownership and nothing else',
    JSON.stringify(FI.chooserBody(c)), '{"ownership":"curator"}');
  // `true` is the server's own default and re-stating a default is one more
  // thing to disagree about; `false` is a departure and must cross.
  c.seed = false;
  eq('unticking the seeding is the ONE thing that travels',
    JSON.stringify(FI.chooserBody(c)), '{"ownership":"curator","seed":false}');
  c.seed = true;
  ok('the curator arm never sends a repoRoot, which the route refuses on it',
    (c.repoRoot = '/tmp/x', !('repoRoot' in FI.chooserBody(c))), JSON.stringify(FI.chooserBody(c)));

  // ── "DECIDE LATER" SENDS NOTHING AT ALL ───────────────────────────────
  // NULL rather than `{ownership: 'later'}`: the route's body is an allow-list,
  // a project with no manifest is the state the Agent-memory chooser exists to
  // resolve, and "later" would be a fourth ownership the store has never heard
  // of.
  c.ownership = 'later';
  eq('"decide later" is NULL, so the key is absent from the body entirely',
    FI.chooserBody(c), null);
  eq('an unknown ownership is null too, never passed through',
    FI.chooserBody({ ownership: 'whatever' }), null);
  eq('...and so is nothing at all', FI.chooserBody(null), null);

  // ── THE MIRROR ARM ────────────────────────────────────────────────────
  const m = FI.freshChooser({});
  m.ownership = 'repo';
  eq('the mirror arm with no root sends just the ownership — the store resolves the root '
    + 'from the manifest where there is one', JSON.stringify(FI.chooserBody(m)), '{"ownership":"repo"}');
  m.repoRoot = '   /Users/x/code/p   ';
  eq('a typed root is TRIMMED', FI.chooserBody(m).repoRoot, '/Users/x/code/p');
  ok('...and `files` is omitted while nothing is ticked, because an empty array asks the '
    + 'server to mirror nothing, which reads on the wire as a mistake',
  !('files' in FI.chooserBody(m)), JSON.stringify(FI.chooserBody(m)));

  m.candidates = [
    { path: 'docs/a.md', bytes: 10, suggestedRole: 'architecture' },
    { path: 'docs/b.md', bytes: 10, suggestedRole: 'guide' },
    { path: 'docs/big.md', bytes: 900000, suggestedRole: 'other', tooLarge: true },
  ];
  m.picks = { 'docs/a.md': true, 'docs/big.md': true };
  m.roles = { 'docs/a.md': 'conventions' };
  eq('the ticked files cross with the role the OWNER chose over the one the scan suggested, '
    + 'and a file over the per-document cap is refused here rather than on the wire',
  JSON.stringify(FI.pickedFiles(m)), JSON.stringify([{ path: 'docs/a.md', role: 'conventions' }]));

  // ── D21: A FILE THE SCAN MISSED, TYPED ────────────────────────────────
  m.extras = [{ path: './notes/adr-1.md', role: 'decisions' }, { path: '/abs/x.md' }];
  const files = FI.pickedFiles(m);
  const at = (i, k) => (files[i] ? files[i][k] : '<no such entry>');
  eq('a typed path joins files[], normalised', at(1, 'path'), 'notes/adr-1.md');
  eq('...with the role the owner picked', at(1, 'role'), 'decisions');
  eq('an absolute path loses its leading slash — the store resolves INSIDE the root, so an '
    + 'absolute path is the one shape that is certainly wrong', at(2, 'path'), 'abs/x.md');
  eq('...and with no role chosen it takes the basename heuristic', at(2, 'role'), 'other');
  // A typed path that duplicates a ticked candidate is dropped rather than
  // sent twice: the server would mirror it once and report it once, and the
  // count line would then disagree with the outcome.
  m.extras.push({ path: 'docs/a.md', role: 'guide' });
  eq('a typed path that duplicates a ticked candidate is sent ONCE',
    FI.pickedFiles(m).filter((x) => x.path === 'docs/a.md').length, 1);
  eq('normaliseRelPath tidies without validating — the store\'s sourceDigest is the authority',
    FI.normaliseRelPath('  ./a/../b.md  '), 'a/../b.md');

  // ── THE OUTCOME WORDS COME FROM THE SERVER'S ANSWER ───────────────────
  eq('four seeded skeletons', FI.chooserOutcomeWords({ seeded: ['a', 'b', 'c', 'd'] }),
    ' · 4 skeletons seeded');
  eq('...singular when one', FI.chooserOutcomeWords({ seeded: ['a'] }), ' · 1 skeleton seeded');
  eq('mirrored documents are added + refreshed',
    FI.chooserOutcomeWords({ refresh: { added: ['a'], refreshed: ['b'] } }),
    ' · 2 documents mirrored');
  eq('a refusal is counted, never hidden inside the success',
    FI.chooserOutcomeWords({ refresh: { added: ['a'], refused: [{ path: 'x' }] } }),
    ' · 1 document mirrored · 1 refused');
  eq('imported files are their own clause',
    FI.chooserOutcomeWords({ imported: ['a.md', 'b.md'] }), ' · 2 documents imported');
  eq('a skeleton an import replaced is NAMED, so the owner knows which of the two won',
    FI.chooserOutcomeWords({ imported: ['architecture.md'], replacedSkeletons: ['architecture.md'] }),
    ' · 1 document imported · 1 skeleton replaced by an imported file (architecture.md)');
  eq('a server that reports nothing about tier 0 produces NO clause at all, so a caller can '
    + 'append it unconditionally', FI.chooserOutcomeWords({ ok: true }), '');
  eq('...unless the CHOICE was to postpone, which is the one clause the request owns',
    FI.chooserOutcomeWords({ ok: true }, { ownership: 'later' }), ' · documents: decide later');
  eq('a request that asked for four and got three reports THREE',
    FI.chooserOutcomeWords({ seeded: ['a', 'b', 'c'] }, { ownership: 'curator', seed: true }),
    ' · 3 skeletons seeded');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — A FILE FROM DISK: the wall before the read (D18)');
// ═════════════════════════════════════════════════════════════════════════
{
  // A fake File: `name` and `size` are all the shipped code reads
  // synchronously, and the reader seam supplies the bytes.
  const file = (name, text, size) => ({ name, size: size == null ? text.length : size, _text: text });
  const reader = async (f) => f._text;

  {
    const got = await FI.readPickedFile(file('Architecture.md', '# Arch\n\nbody'), reader);
    eq('the text arrives BYTE-IDENTICAL, which is the whole point of reading it here',
      got.text, '# Arch\n\nbody');
    eq('...and its sha256 matches the source exactly', sha(got.text), sha('# Arch\n\nbody'));
    eq('the slug comes from the basename', got.slug, 'architecture.md');
    eq('the title comes from the document\'s own heading', got.title, 'Arch');
    eq('the role comes from the basename heuristic', got.role, 'architecture');
    eq('and there is no error', got.error, null);
  }
  {
    // NON-ASCII SURVIVES. A document full of em-dashes and arrows is ordinary,
    // and a reader that mangled them would be corrupting a canonical document.
    const text = '# Décisions — ✓ → ✗\n\nnaïve façade “quotes”\n';
    const got = await FI.readPickedFile(file('décisions.md', text), reader);
    eq('non-ASCII text round-trips byte for byte', sha(got.text), sha(text));
    eq('...and a non-ASCII filename still yields a legal slug', got.slug, 'd-cisions.md');
  }
  {
    // ── THE WALL IS CHECKED BEFORE THE READ, NOT AFTER IT ───────────────
    // `file.size` is synchronous and the store refuses anything over the
    // per-document cap, so a 40 MB file is refused with both numbers and is
    // NEVER read. A reader that is called at all here is the defect.
    let read = 0;
    const counting = async (f) => { read++; return f._text; };
    const got = await FI.readPickedFile(file('giant.md', 'x', FI.MAX_FOUNDATION_BYTES + 1), counting);
    eq('a file over the per-document cap is NEVER READ', read, 0);
    // BOTH NUMBERS, AND IN BYTES: the KB figures alone are useless at the
    // boundary — "is 512 KB, over the 512 KB cap" states a refusal and then
    // contradicts it.
    ok('...and is refused with BOTH exact byte counts, not two identical KB figures',
      String(got.error).includes((FI.MAX_FOUNDATION_BYTES + 1).toLocaleString('en-US'))
      && String(got.error).includes(FI.MAX_FOUNDATION_BYTES.toLocaleString('en-US')), String(got.error));
    eq('...carrying no text at all', got.text, '');
    ok('CONTROL: a file one byte UNDER the cap is read',
      (await FI.readPickedFile(file('ok.md', 'y', FI.MAX_FOUNDATION_BYTES), counting)).error === null
      && read === 1);
  }
  {
    const got = await FI.readPickedFile(file('.hidden', 'x'), reader);
    ok('a file whose name yields no legal slug is refused with a reason, not renamed for the '
      + 'owner', /no usable file name/.test(got.error), got.error);
  }
  {
    const boom = async () => { throw new Error('the disk said no'); };
    const got = await FI.readPickedFile(file('a.md', 'x'), boom);
    eq('a reader that throws becomes a refusal on the row, never an unhandled rejection',
      got.error, 'the disk said no');
  }
  {
    // A SEED COLLISION IS REPORTABLE WITHOUT A ROUND TRIP, which is why the
    // four slugs are mirrored at all.
    const got = await FI.readPickedFile(file('architecture.md', '# A'), reader);
    ok('an import landing on a seeded slug is detectable in the browser',
      FI.SKELETON_SLUGS.includes(got.slug), got.slug);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — THE CHOOSER, RENDERED, IN BOTH HOSTS');
// ═════════════════════════════════════════════════════════════════════════
{
  const c = FI.freshChooser({ allowLater: true });
  const full = FI.renderFoundationsChooser({ id: 'x', choice: c });
  ok('THREE answers on the create form', full.includes('data-fnd-own="curator"')
    && full.includes('data-fnd-own="repo"') && full.includes('data-fnd-own="later"'));
  ok('the chosen one carries aria-pressed, so the selection is in the accessibility tree and '
    + 'not only in a colour', /data-fnd-own="curator" aria-pressed="true"/.test(full));
  ok('each answer carries its CONSEQUENCE — the reading a person needs before pressing',
    /Seeds four skeleton documents/.test(full) && /byte for byte/.test(full), full.slice(0, 900));
  ok('no ⓘ of its own: both hosts already carry one on the block that contains it, and a '
    + 'third mark beside them would be a third voice', !/tx-vh-info/.test(full));
  ok('and NO native <select> anywhere — v3.18.0 purged those from /next because the popup a '
    + '<select> paints is an OS surface outside the design system', !/<select/.test(full));

  const two = FI.renderFoundationsChooser({ id: 'x', choice: FI.freshChooser({}) });
  ok('TWO answers in the Agent-memory block — "decide later" is meaningless on the surface '
    + 'somebody opened in order to decide', !two.includes('data-fnd-own="later"'));

  const armOnly = FI.renderFoundationsChooser({
    id: 'x', choice: { ...FI.freshChooser({}), ownership: 'repo' }, optionsHidden: true });
  ok('a project whose ownership is ALREADY set gets the arm and no choice: the store refuses '
    + 'a change, so painting the question would offer a decision that cannot be made',
  !armOnly.includes('data-fnd-own=') && armOnly.includes('id="x-root"'), armOnly.slice(0, 300));

  // THE SCAN'S CANDIDATE ROWS.
  const scanned = FI.renderFoundationsChooser({ id: 'x', choice: {
    ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r',
    candidates: [
      { path: 'docs/a.md', bytes: 4096, suggestedRole: 'architecture', firstHeading: 'How it fits' },
      { path: 'docs/big.md', bytes: 900000, suggestedRole: 'other', tooLarge: true },
    ],
    picks: { 'docs/a.md': true },
  } });
  ok('a row shows the path in the CODE face through a named class, never the `mono` utility — '
    + 'a path is DATA with a role, and test-next-views-kit ratchets that utility',
  /class="fnd-init-cand-path"/.test(scanned) && !/class="mono/.test(scanned));
  ok('...the document\'s own first heading beside it (D21)', scanned.includes('How it fits'));
  ok('...its size', scanned.includes('4 KB'));
  ok('...and its role as a control that opens the seven options',
    /data-fnd-role-open="docs\/a\.md"/.test(scanned));
  ok('a refused row is DISABLED with the reason on its own row rather than counted into a '
    + 'summary — the reason this one file cannot be copied is a fact about this one file',
  /data-fnd-cand="docs\/big\.md"[^>]* disabled/.test(scanned) && /per-document cap/.test(scanned));
  ok('the refused row is NEVER ticked', !/data-fnd-cand="docs\/big\.md"[^>]* checked/.test(scanned));
  ok('the count line says how many of what', /1 of 2 found, 0 added by path/.test(scanned),
    scanned.slice(-400));
  ok('D21\'s typed path is offered whenever a root is named, not only after a scan found '
    + 'nothing', scanned.includes('id="x-extra"') && /Add a file the scan missed/.test(scanned));
  ok('...with the seven roles as option buttons', /data-fnd-extra-role="decisions"/.test(scanned));
  ok('the Add control is DISABLED with an empty field',
    /id="x-extra-add"[^>]* disabled/.test(scanned), scanned.slice(-900));

  // A SCAN REFUSAL IS PAINTED IN FLOW, NEVER FOLDED (v3.16.1).
  const failedScan = FI.renderFoundationsChooser({ id: 'x', choice: {
    ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r', scanError: 'that folder is not here' } });
  ok('a scan refusal is painted under the field the person typed into',
    /Nothing was read: that folder is not here/.test(failedScan));
  ok('...outside any <details>', !failedScan.includes('<details'));

  // THE FILE PICKER WEARS THE KIT'S BUTTON.
  const cur = FI.renderFoundationsChooser({ id: 'x', choice: FI.freshChooser({}) });
  ok('the file input is visually hidden inside a <label> carrying the kit\'s button classes — '
    + 'a native file button is the one control a browser will not let you style',
  /<label class="btn btn-secondary btn-xs fnd-init-file">/.test(cur)
    && /class="visually-hidden" id="x-files"/.test(cur), cur.slice(0, 1800));
  ok('...accepting markdown and text only', /accept="\.md,\.txt,text\/markdown,text\/plain"/.test(cur));
  ok('...MULTIPLE on the create form, where each file becomes one document',
    /id="x-files"[^>]*multiple/.test(cur));

  // HOSTILE TEXT, through the real renderer.
  const XSS = '<img src=x onerror=alert(1)>';
  const hostile = FI.renderFoundationsChooser({ id: 'x', choice: {
    ...FI.freshChooser({}), ownership: 'repo', repoRoot: XSS,
    candidates: [{ path: XSS, bytes: 1, suggestedRole: 'other', firstHeading: XSS }],
    picks: {}, scanError: XSS, extras: [{ path: XSS, role: 'other' }] } });
  ok('every string that arrives from a filesystem or a server is escaped',
    !hostile.includes('<img src=x'), hostile.slice(0, 400));
  ok('...including inside an attribute, where a quote would break out',
    !/value="[^"]*"[^>]*onerror/.test(hostile));

  // THE REFUSED LIST (D21), shared by both hosts.
  const refused = FI.renderRefusedList([
    { path: 'notes/x.md', reason: 'is outside the repository root' },
    { path: 'y.txt', reason: 'is not a markdown file' },
  ]);
  ok('a refusal list names each path AND the store\'s own reason',
    /notes\/x\.md — is outside the repository root/.test(refused)
    && /y\.txt — is not a markdown file/.test(refused), refused);
  ok('...as a loud note in flow, never inside a fold',
    /fnd-init-note-loud/.test(refused) && !refused.includes('<details'));
  eq('nothing refused renders nothing at all', FI.renderRefusedList([]), '');
  eq('...and a missing field is not a crash', FI.renderRefusedList(null), '');
  ok('a long list is capped with a count rather than printing forty lines',
    /… and 2 more/.test(FI.renderRefusedList(
      Array.from({ length: 8 }, (_, i) => ({ path: 'p' + i, reason: 'no' })))));
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — THE CHOOSER, WIRED (a DOM model, the shipped listeners)');
// ═════════════════════════════════════════════════════════════════════════
//
// No DOM engine here (this repo ships zero devDeps), so this is a MODEL: nodes
// with the handful of properties the shipped binder reads, and real listener
// dispatch. It is still a model, and the note at the top of this file says what
// that leaves to the Browser-pane pass.
function node(attrs) {
  const n = {
    dataset: {}, files: null, value: '', checked: false, disabled: false,
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    fire(t, ev) { (this._listeners[t] || []).forEach((f) => f(ev || {})); },
    getAttribute(k) { return this.dataset[k.replace(/^data-/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase())]; },
    ...attrs,
  };
  return n;
}
function docModel(byId, bySel) {
  return {
    getElementById: (id) => byId[id] || null,
    querySelector: (s) => (bySel[s] ? bySel[s][0] : null),
    querySelectorAll: (s) => bySel[s] || [],
  };
}
{
  const choice = FI.freshChooser({ allowLater: true });
  let renders = 0;
  const curBtn = node({ dataset: { fndOwn: 'curator' } });
  const repoBtn = node({ dataset: { fndOwn: 'repo' } });
  const root = node({ value: '/r' });
  const scan = node({});
  const extra = node({ value: '' });
  const extraAdd = node({});
  const extraRole = node({ dataset: { fndExtraRole: 'decisions' } });
  const seed = node({ checked: true });
  const cand = node({ dataset: { fndCand: 'docs/a.md' }, checked: true });
  const roleOpen = node({ dataset: { fndRoleOpen: 'docs/a.md' } });
  const roleBtn = node({ dataset: { fndRole: 'guide', fndRoleScope: 'docs/a.md' } });
  const shell = node({
    querySelectorAll: (s) => ({
      '[data-fnd-own]': [curBtn, repoBtn],
      '[data-fnd-cand]': [cand],
      '[data-fnd-role-open]': [roleOpen],
      '[data-fnd-role]': [roleBtn],
      '[data-fnd-extra-role]': [extraRole],
      '[data-fnd-extra-drop]': [],
      '[data-fnd-import-drop]': [],
    }[s] || []),
  });
  const doc = {
    ...docModel({
      'x-root': root, 'x-scan': scan, 'x-extra': extra, 'x-extra-add': extraAdd,
      'x-seed': seed, 'x-files': null,
    }, { '[data-fnd-init="x"]': [shell] }),
  };
  let scanned = null;
  FI.bindFoundationsChooser({
    doc, id: 'x', choice,
    onChange: () => { renders++; },
    fetchImpl: async (url) => {
      scanned = url;
      return { ok: true, json: async () => ({ ok: true, root: '/r', truncated: false,
        candidates: [
          { path: 'docs/a.md', bytes: 10, suggestedRole: 'architecture' },
          { path: 'docs/big.md', bytes: 900000, suggestedRole: 'other', tooLarge: true },
        ] }) };
    },
  });

  repoBtn.fire('click');
  eq('pressing an answer records it', choice.ownership, 'repo');
  eq('...and repaints, because it changes which controls are on screen', renders, 1);

  // THE PATH FIELD WRITES STRAIGHT INTO STATE WITH NO REPAINT — a render
  // rebuilds the input and takes the caret with it. The only thing on screen it
  // changes is the scan button's disabled state, set on the LIVE node.
  renders = 0;
  root.value = '/Users/x/p';
  scan.disabled = true;
  root.fire('input');
  eq('typing a path repaints NOT AT ALL', renders, 0);
  eq('...but is recorded', choice.repoRoot, '/Users/x/p');
  eq('...and arms the scan on the live node', scan.disabled, false);

  scan.fire('click');
  await new Promise((r) => setTimeout(r, 0));
  eq('the scan asks the repo-scan route, with the root ESCAPED',
    scanned, '/api/memory/repo-scan?root=%2FUsers%2Fx%2Fp');
  eq('what it found is recorded', choice.candidates.length, 2);
  // EVERYTHING USABLE IS TICKED: the person pressed "Find documents" in order
  // to mirror what is there, and making them tick eight boxes afterwards is
  // the friction, not the safety.
  eq('every usable candidate is ticked', choice.picks['docs/a.md'], true);
  ok('...and the one over the cap is NOT', !('docs/big.md' in choice.picks),
    JSON.stringify(choice.picks));
  eq('the scan cleared any earlier error', choice.scanError, null);

  // A LATE SCAN REPLY FOR A ROOT THE PERSON HAS SINCE CORRECTED IS DROPPED.
  {
    const c2 = FI.freshChooser({});
    c2.ownership = 'repo';
    c2.repoRoot = '/first';
    const s2 = node({});
    const r2 = node({ value: '/first' });
    let release;
    const gate = new Promise((res) => { release = res; });
    const d2 = docModel({ 'x-root': r2, 'x-scan': s2 }, { '[data-fnd-init="x"]': [node({
      querySelectorAll: () => [] })] });
    FI.bindFoundationsChooser({ doc: d2, id: 'x', choice: c2, onChange: () => {},
      fetchImpl: async () => { await gate; return { ok: true, json: async () => ({
        ok: true, candidates: [{ path: 'late.md', bytes: 1, suggestedRole: 'other' }] }) }; } });
    s2.fire('click');
    c2.repoRoot = '/second';            // the person corrected the path meanwhile
    release();
    await new Promise((r) => setTimeout(r, 0));
    eq('a scan answer for a root that is no longer typed is DROPPED — a corrected path must '
      + 'not have the first answer land on top of the second', c2.candidates, null);
  }

  // THE ROLE CONTROL: one row's options at a time.
  renders = 0;
  roleOpen.fire('click');
  eq('pressing a role opens that row\'s options', choice.roleOpenFor, 'docs/a.md');
  roleBtn.fire('click');
  eq('picking one records it', choice.roles['docs/a.md'], 'guide');
  eq('...closes the row', choice.roleOpenFor, null);
  eq('...and TICKS the file, because picking a role is also a statement that it is wanted',
    choice.picks['docs/a.md'], true);

  cand.checked = false;
  cand.fire('change');
  ok('unticking removes the pick outright rather than storing a false',
    !('docs/a.md' in choice.picks), JSON.stringify(choice.picks));

  // D21's TYPED PATH.
  renders = 0;
  extra.value = ' notes/adr-1.md ';
  extraAdd.disabled = true;
  extra.fire('input');
  eq('typing a path repaints NOT AT ALL here either', renders, 0);
  eq('...and arms Add on the live node', extraAdd.disabled, false);
  extraRole.fire('click');
  eq('the role for it is recorded', choice.extraRole, 'decisions');
  extraAdd.fire('click');
  eq('Add appends it, normalised', choice.extras[0].path, 'notes/adr-1.md');
  eq('...with the chosen role', choice.extras[0].role, 'decisions');
  eq('...and clears the field so the next one can be typed', choice.extraPath, '');
  eq('...while KEEPING the role, so three ADRs do not need it picked three times',
    choice.extraRole, 'decisions');
  ok('the typed path reaches the request body',
    ((FI.chooserBody(choice) || {}).files || [])
      .some((x) => x.path === 'notes/adr-1.md' && x.role === 'decisions'),
    JSON.stringify(FI.chooserBody(choice)));

  seed.checked = false;
  seed.fire('change');
  eq('unticking the seeding is recorded', choice.seed, false);

  // SWITCHING ARMS KEEPS THE OTHER ARM'S WORK. Somebody who scans, reads the
  // list and presses the other answer to compare has not asked to throw the
  // scan away — and `chooserBody` reads only the chosen arm's fields, so
  // nothing leaks onto the wire from the arm that is not showing.
  curBtn.fire('click');
  eq('switching to the curator arm keeps the scan', choice.candidates.length, 2);
  ok('...and the body carries no root or files at all',
    !('repoRoot' in FI.chooserBody(choice)) && !('files' in FI.chooserBody(choice)),
    JSON.stringify(FI.chooserBody(choice)));
}
{
  // THE FILE INPUT: several files, each read, and a refused one still LISTED
  // with its reason — a file that silently did not arrive is the worst outcome
  // for somebody who picked six and got five.
  const choice = FI.freshChooser({ allowLater: true });
  const files = node({ files: [
    { name: 'a.md', size: 5, _t: '# A\n' },
    { name: 'giant.md', size: FI.MAX_FOUNDATION_BYTES + 1, _t: '' },
  ] });
  const doc = docModel({ 'x-files': files }, { '[data-fnd-init="x"]': [node({ querySelectorAll: () => [] })] });
  let renders = 0;
  FI.bindFoundationsChooser({ doc, id: 'x', choice, onChange: () => { renders++; },
    readerImpl: async (f) => f._t });
  files.fire('change');
  await new Promise((r) => setTimeout(r, 0));
  eq('both files are listed', choice.imports.length, 2);
  eq('the readable one carries its text', choice.imports[0].text, '# A\n');
  ok('the refused one is listed WITH its reason rather than dropped',
    choice.imports[1].error && /per-document cap/.test(choice.imports[1].error),
    String(choice.imports[1].error));
  eq('...and one repaint covers the batch', renders, 1);
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — THE EDITOR, RENDERED (the shipped renderers)');
// ═════════════════════════════════════════════════════════════════════════

const stateBox = { value: null };
const renderers = (() => {
  const body =
    extractFunction(viewSrc, 'foundationsFacts') + '\n' +
    extractFunction(viewSrc, 'fndStats') + '\n' +
    extractFunction(viewSrc, 'fndSlugError') + '\n' +
    extractFunction(viewSrc, 'fndShrinkWarn') + '\n' +
    extractFunction(viewSrc, 'briefDismissDecision') + '\n' +
    extractFunction(viewSrc, 'renderFoundationEditor') + '\n' +
    extractFunction(viewSrc, 'renderFoundationsInit') + '\n' +
    extractFunction(viewSrc, 'foundationReaderContent') + '\n' +
    extractFunction(viewSrc, 'formatAge') + '\n' +
    'return { foundationsFacts, fndStats, fndSlugError, fndShrinkWarn, briefDismissDecision, '
    + 'renderFoundationEditor, renderFoundationsInit, foundationReaderContent };';
  // eslint-disable-next-line no-new-func
  return new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'renderStatus',
    'renderDescription', 'renderReadout',
    'FOUNDATION_SLUG_RE', 'FOUNDATION_ROLES', 'MAX_FOUNDATION_BYTES', 'FOUNDATIONS_BUDGET_BYTES',
    'renderRoleOptions', 'renderFoundationsChooser', 'freshChooser', 'formatBytes',
    body)(
    stateBox, escapeHtml, () => '<svg></svg>', (t) => '<md>' + escapeHtml(t) + '</md>',
    (o) => '<div class="tx-status tx-status-' + o.state + '"><b>' + escapeHtml(o.title)
      + '</b><i>' + escapeHtml(o.detail || '') + '</i></div>',
    (t) => '<p class="tx-desc">' + escapeHtml(t) + '</p>',
    (o) => '<div class="tx-readout">' + escapeHtml(o.label) + ': ' + escapeHtml(o.value) + '</div>',
    FI.FOUNDATION_SLUG_RE, FI.FOUNDATION_ROLES, FI.MAX_FOUNDATION_BYTES,
    FI.FOUNDATIONS_BUDGET_BYTES, FI.renderRoleOptions, FI.renderFoundationsChooser,
    FI.freshChooser, FI.formatBytes);
})();
// The sandbox's `state` is a fixed OBJECT the shipped functions read through,
// so fields are assigned onto it rather than the binding being replaced.
const setState = (o) => { for (const k of Object.keys(stateBox)) delete stateBox[k];
  Object.assign(stateBox, o); };

const factsOf = (docs, over) => renderers.foundationsFacts({
  foundations: { present: true, ownership: 'curator', budgetBytes: FI.FOUNDATIONS_BUDGET_BYTES,
    totalBytes: docs.reduce((a, d) => a + (d.bytes || 0), 0), documents: docs,
    orphanFiles: [], manifestError: null, ...over },
});
const aDoc = (over) => ({ slug: 'architecture.md', role: 'architecture', title: 'Architecture',
  bytes: 4096, updatedAt: '2026-09-17T09:00:00.000Z', source: { kind: 'curator', path: null },
  freshness: 'n/a', skeleton: false, ...over });
const anEdit = (over) => ({ domain: 'acme', project: 'lumina', slug: 'architecture.md',
  isNew: false, loading: false, loaded: '# A\n\nbody', text: '# A\n\nbody',
  title: 'Architecture', role: 'architecture', busy: false, error: null, preview: false,
  confirmDiscard: false, confirmShrink: false, confirmDelete: false, deleting: false,
  importError: null, ...over });

{
  // ── THE THREE PURE DECISIONS ──────────────────────────────────────────
  eq('the counter measures BYTES, which is what the route measures — a document full of '
    + 'em-dashes runs out sooner than its character count suggests',
  renderers.fndStats('—').bytes, 3);
  eq('...and words, which is the unit a writer thinks in', renderers.fndStats('a b c').words, 3);
  ok('over the wall is over', renderers.fndStats('x'.repeat(FI.MAX_FOUNDATION_BYTES + 1)).over === true);
  ok('...and exactly at it is NOT', renderers.fndStats('x'.repeat(FI.MAX_FOUNDATION_BYTES)).over === false);

  eq('an empty name is refused with an instruction',
    /ending in \.md/.test(renderers.fndSlugError('', null)), true);
  ok('a name outside the store\'s grammar is refused, with the grammar in words',
    /lowercase letters, digits and hyphens/.test(renderers.fndSlugError('My Doc', null)));
  eq('a legal name is accepted', renderers.fndSlugError('architecture.md', []), null);
  ok('a name that already exists is refused BY NAME, pointing at the row that has it',
    /already has a document called architecture\.md/
      .test(renderers.fndSlugError('architecture.md', ['architecture.md'])));
  ok('the view refuses exactly what the store\'s grammar refuses, and nothing else',
    ['a.md', 'a-b-c.md', '0.md'].every((s) => renderers.fndSlugError(s, []) === null)
    && ['A.md', 'a.txt', '-a.md', 'a b.md', 'a.md.md']
      .every((s) => renderers.fndSlugError(s, []) !== null));

  // THE SHRINK (D5). Two conditions, and the second is what stops it firing
  // constantly: cutting a 200-byte stub in half is ordinary editing.
  eq('a small document shrinking is not worth asking about',
    renderers.fndShrinkWarn({ loaded: 'x'.repeat(500), text: '' }), null);
  eq('a 1 KB document losing 11% IS',
    JSON.stringify(renderers.fndShrinkWarn({ loaded: 'x'.repeat(2048), text: 'x'.repeat(1800) })),
    JSON.stringify({ before: 2048, after: 1800 }));
  eq('...losing 9% is not', renderers.fndShrinkWarn({ loaded: 'x'.repeat(2048), text: 'x'.repeat(1900) }), null);
  eq('GROWING is never a shrink', renderers.fndShrinkWarn({ loaded: 'x'.repeat(2048), text: 'x'.repeat(9000) }), null);
  eq('nothing at all is not a shrink either', renderers.fndShrinkWarn(null), null);

  // ESCAPE'S THREE ANSWERS, through the SAME function the brief editor uses —
  // parametrised over the record rather than copied, because a draft is a
  // draft whichever tier it belongs to, and two answers to "may I close this?"
  // is how a draft gets destroyed by the safer-looking control.
  eq('an in-flight save BLOCKS the close — the reply cannot be cancelled and the owner would '
    + 'not know whether their text reached disk',
  renderers.briefDismissDecision(anEdit({ busy: true })), 'blocked');
  eq('a dirty draft raises a CONFIRM', renderers.briefDismissDecision(anEdit({ text: 'changed' })), 'confirm');
  eq('an unchanged one just CLOSES', renderers.briefDismissDecision(anEdit()), 'close');
}
{
  // ── THE EDITOR'S SURFACE ──────────────────────────────────────────────
  const facts = factsOf([aDoc()]);
  setState({ activeDomain: 'acme', activeProject: 'lumina', fndEdit: anEdit() });
  const html = renderers.renderFoundationEditor(facts);
  ok('the heading names the document and its role, so the owner can see WHICH of six is in '
    + 'the box', /Architecture/.test(html) && /class="fnd-role">architecture</.test(html));
  ok('one textarea, named', (html.match(/<textarea/g) || []).length === 1
    && /id="mem-fnd-text"/.test(html));
  ok('...taking the code face from CSS and never from the `mono` utility class',
    /class="mem-fnd-text"/.test(html) && !/class="[^"]*\bmono\b/.test(html), html.slice(0, 400));
  ok('the TITLE and the ROLE of an existing document are editable — both are manifest fields '
    + 'the PUT carries', /id="mem-fnd-title"/.test(html) && /data-fnd-edit-role="roadmap"/.test(html));
  ok('the FILE NAME is not: a rename is a delete plus a create, and neither the store nor '
    + 'this editor pretends otherwise', !/id="mem-fnd-slug"/.test(html));
  ok('exactly ONE primary — the card\'s one commit (design-system §1)',
    (html.match(/btn-primary/g) || []).length === 1 && /id="mem-fnd-save"/.test(html));
  ok('Preview only changes what is displayed, so it is secondary',
    /id="mem-fnd-preview"[^>]*/.test(html) && /btn-secondary btn-xs" id="mem-fnd-preview"/.test(html));
  ok('Cancel is quiet', /btn-ghost" id="mem-fnd-cancel"/.test(html));
  ok('Delete is a GHOST in the footer rather than beside Save — it destroys a document and '
    + 'must not be one mis-click from the commit',
  /btn-ghost btn-xs mem-fnd-delete" id="mem-fnd-delete"/.test(html));
  ok('the write is stated where the button is, not behind a click: saving REPLACES',
    /Saving replaces the whole document, byte for byte/.test(html));
  ok('...and that sentence is not inside a <details>', !html.includes('<details'));
  ok('no hover-only title= anywhere — this view\'s tooltip budget is 1 and may not grow',
    !/title="/.test(html), html.slice(0, 200));

  // THE COUNTER IS ADDRESSABLE, because the keystroke handler updates it
  // WITHOUT a render — a render would rebuild the field under the caret.
  for (const k of ['dirty', 'words', 'bytes']) {
    ok('the counter\'s ' + k + ' is addressable by a data hook',
      new RegExp('data-fnd-stat="' + k + '"').test(html));
  }
  ok('the wall is emitted ALWAYS and merely hidden, so the input handler can flip it',
    /id="mem-fnd-over"[^>]* hidden/.test(html), html.slice(0, 200));

  // ── THE WALL (D6) ─────────────────────────────────────────────────────
  setState({ activeDomain: 'acme', activeProject: 'lumina',
    fndEdit: anEdit({ text: 'x'.repeat(FI.MAX_FOUNDATION_BYTES + 10) }) });
  const over = renderers.renderFoundationEditor(facts);
  ok('over the wall the wall is SHOWN', !/id="mem-fnd-over"[^>]* hidden/.test(over));
  ok('...with BOTH numbers', over.includes(String(FI.MAX_FOUNDATION_BYTES))
    && over.includes(String(FI.MAX_FOUNDATION_BYTES + 10)));
  ok('...and Save DISABLED, because a refusal the owner could have seen coming is a refusal '
    + 'that should not have been offered', /id="mem-fnd-save" disabled/.test(over));
  ok('...and it says WHY a document cannot simply be trimmed for them',
    /cannot be trimmed for you/.test(over));

  // ── THE BUDGET IS A DISCLOSURE, NEVER A WALL (D6) ─────────────────────
  // The store ACCEPTS a save that crosses it and says so, so a UI that refused
  // would be the only thing standing between the owner and their own document.
  const bigProject = factsOf([aDoc({ bytes: FI.FOUNDATIONS_BUDGET_BYTES })]);
  setState({ activeDomain: 'acme', activeProject: 'lumina',
    fndEdit: anEdit({ loaded: '', text: 'x'.repeat(4096), isNew: true, slug: 'new.md' }) });
  const budg = renderers.renderFoundationEditor(bigProject);
  ok('crossing the project budget is DISCLOSED with the figure',
    /over the 200 KB/.test(budg), budg.slice(0, 200));
  ok('...and Save is NOT disabled for it', !/id="mem-fnd-save" disabled/.test(budg));
  ok('...and it says what actually happens: the READ gets trimmed, not the save',
    /the read is what gets\s+trimmed/.test(budg.replace(/\s+/g, ' ')) || /read is what gets/.test(budg));

  // ── THE SHRINK STRIP ──────────────────────────────────────────────────
  setState({ activeDomain: 'acme', activeProject: 'lumina',
    fndEdit: anEdit({ loaded: 'x'.repeat(4096), text: 'x'.repeat(1000), confirmShrink: true }) });
  const shrink = renderers.renderFoundationEditor(facts);
  ok('the shrink strip names BOTH sizes', /4 KB/.test(shrink) && /1000 bytes/.test(shrink), shrink.slice(0, 200));
  ok('...says the save replaces the WHOLE document', /the whole document, not an addition/.test(shrink));
  ok('...and offers both ways out', /id="mem-fnd-shrink-go"/.test(shrink)
    && /id="mem-fnd-shrink-no"/.test(shrink));
  ok('...in flow, not in a dialog — the text the owner would lose stays on screen while they '
    + 'decide', !shrink.includes('<dialog'));

  // ── THE DELETE STRIP ──────────────────────────────────────────────────
  setState({ activeDomain: 'acme', activeProject: 'lumina', fndEdit: anEdit({ confirmDelete: true }) });
  const del = renderers.renderFoundationEditor(facts);
  ok('the delete strip NAMES the document — "are you sure?" over six rows is a question about '
    + 'none of them', /architecture\.md/.test(del) && /Delete <b>/.test(del));
  ok('...says what it costs, in the model\'s own words', /agents stop reading it/.test(del));
  ok('...uses the DANGER variant, tinted and never filled (the taxonomy reserves the filled '
    + 'one for a confirm DIALOG)', /btn-danger btn-xs" id="mem-fnd-delete-go"/.test(del)
    && !/btn-danger-solid/.test(del));
  ok('...and Save is disabled while it stands, so one stray press cannot commit instead',
    /id="mem-fnd-save" disabled/.test(del));

  // ── THE ADD FORM ──────────────────────────────────────────────────────
  setState({ activeDomain: 'acme', activeProject: 'lumina',
    fndEdit: anEdit({ isNew: true, slug: '', loaded: '', text: '', title: '' }) });
  const add = renderers.renderFoundationEditor(facts);
  ok('"Add" asks for a file name', /id="mem-fnd-slug"/.test(add));
  ok('...refuses an empty one before any request', /ending in \.md/.test(add));
  ok('...with Save disabled until it is legal', /id="mem-fnd-save" disabled/.test(add));
  ok('...offers "Choose a file…" beside the empty box (D18)',
    /id="mem-fnd-file"/.test(add) && /Choose a file…/.test(add));
  ok('...saying out loud that nothing is sent until the owner saves',
    /nothing is sent until you save/.test(add));
  ok('...and offers NO Delete, because there is nothing to delete yet',
    !/id="mem-fnd-delete"/.test(add));
  setState({ activeDomain: 'acme', activeProject: 'lumina',
    fndEdit: anEdit({ isNew: true, slug: 'notes.md', text: 'x', title: 'N' }) });
  ok('a legal new name arms Save',
    !/id="mem-fnd-save" disabled/.test(renderers.renderFoundationEditor(facts)));

  // ── THE LOADING FRAME, AND THE FAILURE ────────────────────────────────
  setState({ activeDomain: 'acme', activeProject: 'lumina', fndEdit: anEdit({ loading: true }) });
  const loading = renderers.renderFoundationEditor(facts);
  ok('the press is acknowledged with a busy frame rather than an empty box',
    /aria-busy="true"/.test(loading) && /Reading the document/.test(loading));
  setState({ activeDomain: 'acme', activeProject: 'lumina',
    fndEdit: anEdit({ error: 'repo_owned', text: 'my unsaved words' }) });
  const failed = renderers.renderFoundationEditor(facts);
  ok('a failure renders the reason as a danger status', /tx-status-danger/.test(failed)
    && /Not saved/.test(failed) && /repo_owned/.test(failed));
  ok('...and the draft is STILL IN THE BOX, because it is the only copy',
    failed.includes('my unsaved words'));

  // HOSTILE TEXT, through the real renderer.
  const XSS = '<img src=x onerror=alert(1)>';
  setState({ activeDomain: 'acme', activeProject: 'lumina',
    fndEdit: anEdit({ slug: XSS, title: XSS, text: XSS, error: XSS, isNew: true }) });
  ok('every interpolated string is escaped', !renderers.renderFoundationEditor(facts).includes('<img src=x'));
}
{
  // ── THE CHOOSER, INSIDE THE BLOCK ─────────────────────────────────────
  setState({ activeDomain: 'acme', activeProject: 'lumina', fndInit: null });
  const unchosen = renderers.renderFoundationsInit(
    renderers.foundationsFacts({ foundations: { present: false, ownership: null, documents: [] } }));
  ok('a project that has never answered gets the chooser, painted from NOTHING — the block '
    + 'renders its own first frame without a click',
  unchosen.includes('data-fnd-init="mem-fnd-init"'), unchosen.slice(0, 200));
  ok('...with the commit labelled for the DEFAULT answer rather than generically',
    /Seed the skeletons<\/button>/.test(unchosen), unchosen.slice(-500));
  ok('...enabled, because the curator arm needs nothing typed',
    !/id="mem-fnd-init-go" disabled/.test(unchosen));

  setState({ activeDomain: 'acme', activeProject: 'lumina', fndInit: {
    domain: 'acme', project: 'lumina', busy: false, error: null, refused: [],
    choice: { ...FI.freshChooser({}), ownership: 'repo', repoRoot: '' } } });
  const needsRoot = renderers.renderFoundationsInit(
    renderers.foundationsFacts({ foundations: { present: false, ownership: null, documents: [] } }));
  ok('the mirror arm cannot be committed with no root typed',
    /id="mem-fnd-init-go" disabled/.test(needsRoot), needsRoot.slice(-500));

  const mirrorFacts = renderers.foundationsFacts({
    foundations: { present: true, ownership: 'repo', documents: [] } });
  setState({ activeDomain: 'acme', activeProject: 'lumina', fndInit: null });
  const armOnly = renderers.renderFoundationsInit(mirrorFacts);
  ok('an already-owned mirror shows the arm and NOT the question',
    !armOnly.includes('data-fnd-own=') && armOnly.includes('id="mem-fnd-init-root"'));
  ok('...labelled for what it does', /Add from repository<\/button>/.test(armOnly), armOnly.slice(-400));
  ok('...and its lede is an instruction, not a definition',
    /Point at the checkout/.test(armOnly));

  setState({ activeDomain: 'acme', activeProject: 'lumina', fndInit: {
    domain: 'acme', project: 'lumina', busy: true, error: null, refused: [],
    choice: FI.freshChooser({}) } });
  ok('while it is working the commit says so and is disabled',
    /id="mem-fnd-init-go" disabled>Setting up…/.test(
      renderers.renderFoundationsInit(renderers.foundationsFacts(
        { foundations: { present: false, ownership: null, documents: [] } }))));
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — THE READER SAYS WHY, PER OWNERSHIP');
// ═════════════════════════════════════════════════════════════════════════
//
// `readonly: true` stays true on BOTH ownership modes, and still does now that
// a curator-owned document is editable — because the READER is not where it is
// edited (D2): it patches `.reader-body.innerHTML` without rebinding and has no
// dirty guard, so a field inside it would lose its listeners on the next patch
// and its draft on the next Escape.
//
// What was WRONG is that `readonly` made app.js print "Read-only Shared Brain
// mirror" — a sentence about a different feature — over every canonical
// document in the app.
{
  setState({});
  const repo = renderers.foundationReaderContent({
    slug: 'architecture.md', title: 'Architecture', role: 'architecture',
    text: '# A', ownership: 'repo', freshness: 'fresh',
    source: { kind: 'repo', path: 'docs/architecture.md' } }, 'lumina');
  eq('READONLY, ALWAYS — the reader is not the editor', repo.readonly, true);
  eq('a MIRRORED document says where it IS edited', repo.readonlyNote,
    'Mirrored from the repository — edit it there and refresh');
  const cur = renderers.foundationReaderContent({
    slug: 'architecture.md', title: 'Architecture', role: 'architecture',
    text: '# A', ownership: 'curator', freshness: 'n/a',
    source: { kind: 'curator', path: null } }, 'lumina');
  eq('a CURATOR-owned one points at the table it came from', cur.readonlyNote,
    'Edit it from the Foundations table');
  ok('neither of them mentions Shared Brain, which is a different feature',
    !/Shared Brain/.test(String(repo.readonlyNote)) && !/Shared Brain/.test(String(cur.readonlyNote)));

  // THE DEFAULT IN app.js IS THE OLD SENTENCE, BYTE FOR BYTE — which is what
  // makes this additive rather than a rename: every caller that passes no note
  // is unchanged.
  ok('app.js still carries the pre-v3.61.0 sentence as the fallback, byte for byte',
    appSrc.includes("'Read-only Shared Brain mirror'"), 'the fallback sentence is gone');
  ok('...reached only when no note is supplied, and only when `readonly` is set — so a caller '
    + 'cannot use the note to caption an EDITABLE page',
  /p\.readonly[\s\S]{0,400}p\.readonlyNote[\s\S]{0,200}Read-only Shared Brain mirror/.test(appSrc),
  'the note is not gated on readonly');
  ok('...and the note is ESCAPED, because it is caller-supplied',
    /escapeHtml\(typeof p\.readonlyNote/.test(appSrc));
  ok('the reader\'s documented payload names the new field, so the next caller can find it',
    /readonlyNote\s+string/.test(appSrc));
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — THE FOUR WRITES, DRIVEN (a fake fetch, the shipped functions)');
// ═════════════════════════════════════════════════════════════════════════

function writeRig(responder) {
  const calls = { render: 0, urls: [], inits: [], forgot: [], reloaded: 0, refreshed: 0 };
  const st = { activeDomain: 'acme', activeProject: 'lumina', fndEdit: null, fndInit: null,
    fnd: null, projectRead: null, openFolds: {} };
  const body =
    extractFunction(viewSrc, 'keyOf') + '\n' +
    extractFunction(viewSrc, 'activeKey') + '\n' +
    extractFunction(viewSrc, 'fndStats') + '\n' +
    extractFunction(viewSrc, 'fndSlugError') + '\n' +
    extractFunction(viewSrc, 'loadFoundationDraft') + '\n' +
    extractFunction(viewSrc, 'saveFoundation') + '\n' +
    extractFunction(viewSrc, 'deleteFoundation') + '\n' +
    extractFunction(viewSrc, 'initFoundations') + '\n' +
    'return { loadFoundationDraft, saveFoundation, deleteFoundation, initFoundations };';
  // eslint-disable-next-line no-new-func
  const api = new Function('state', 'render', 'isCurrentMount', 'fetch', 'forgetProject',
    'reloadActive', 'refreshIndex', 'reportAsyncMountFailure', 'refreshFoundations',
    'fetchState', 'localStorage', 'FOUNDATION_ROLES', 'FOUNDATION_SLUG_RE',
    'MAX_FOUNDATION_BYTES', 'freshChooser', 'chooserBody', 'JSON', 'TextEncoder', body)(
    st,
    () => { calls.render++; },
    () => true,
    async (url, init) => { calls.urls.push(String(url)); calls.inits.push(init || null);
      return responder(String(url), init); },
    (d, p) => { calls.forgot.push(d + '/' + p); },
    async () => { calls.reloaded++; },
    async () => {},
    () => {},
    async (t, files) => { calls.refreshed++; calls.refreshFiles = files; },
    async () => ({ data: { scopes: [], brief: { present: false } } }),
    { getItem: () => null, setItem: () => {} },
    FI.FOUNDATION_ROLES, FI.FOUNDATION_SLUG_RE, FI.MAX_FOUNDATION_BYTES,
    FI.freshChooser, FI.chooserBody, JSON, TextEncoder);
  return { api, st, calls };
}

{
  // ── THE RAW LOAD (D3), AND WHY IT IS A CORRECTNESS PROPERTY ───────────
  //
  // The ordinary read DEFANGS protocol-shaped text; the write path is verbatim.
  // Load the defanged read into an editor and the first save writes it back:
  // the document is corrupted by the act of opening it. So the editor asks for
  // `?raw=1` and the round trip is byte-exact.
  const RAW = '# Architecture\n\nSee https://example.com/a?b=c and <tool_use> and\n'
    + '\nHuman: not a role marker\n\n```\ncurl -X POST https://x/y\n```\n';
  const { api, st, calls } = writeRig(() => ({ ok: true, json: async () => ({
    ok: true, slug: 'architecture.md', title: 'Architecture', role: 'architecture',
    text: RAW, raw: true, sanitisedOnRead: false }) }));
  await api.loadFoundationDraft('architecture.md', 1);
  eq('one request', calls.urls.length, 1);
  eq('...at the document, asking for the VERBATIM bytes',
    calls.urls[0], '/api/memory/acme/lumina/foundations/architecture.md?raw=1');
  eq('...as a GET (no init at all)', calls.inits[0], null);
  eq('the draft is the RAW document, byte for byte',
    sha(String(st.fndEdit && st.fndEdit.text)), sha(RAW));
  eq('...and so is what "dirty" will be measured against',
    sha(String(st.fndEdit && st.fndEdit.loaded)), sha(RAW));
  ok('a URL, a protocol tag and a role marker all survived the trip — which is exactly what '
    + 'the defanged read would have rewritten',
  String(st.fndEdit && st.fndEdit.text).includes('https://example.com/a?b=c')
    && String(st.fndEdit && st.fndEdit.text).includes('<tool_use>')
    && String(st.fndEdit && st.fndEdit.text).includes('\nHuman:'));
  eq('the title and the role come from the manifest',
    st.fndEdit ? st.fndEdit.title : '<no editor>', 'Architecture');
  eq('...and the role', st.fndEdit ? st.fndEdit.role : '<no editor>', 'architecture');
  eq('the editor is not marked new', st.fndEdit ? st.fndEdit.isNew : '<no editor>', false);
  eq('the fold is forced open, or the press would visibly do nothing',
    st.openFolds ? st.openFolds.foundations : '<no folds>', true);
  ok('two renders: the busy frame in the press\'s own frame, then the draft',
    calls.render === 2, String(calls.render));
}
{
  // A SECOND EDIT PRESS WHILE THE FIRST IS IN FLIGHT MUST WIN.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, st } = writeRig(async (url) => {
    if (url.includes('architecture.md')) await gate;
    return { ok: true, json: async () => ({ ok: true,
      slug: url.includes('architecture') ? 'architecture.md' : 'decisions.md',
      title: url.includes('architecture') ? 'Architecture' : 'Decisions',
      role: 'other', text: url.includes('architecture') ? 'FIRST' : 'SECOND' }) };
  });
  const first = api.loadFoundationDraft('architecture.md', 1);
  await api.loadFoundationDraft('decisions.md', 1);
  release();
  await first;
  eq('the SECOND press owns the editor', st.fndEdit ? st.fndEdit.slug : '<no editor>', 'decisions.md');
  eq('...and the first reply is dropped rather than overwriting it',
    st.fndEdit ? st.fndEdit.text : '<no editor>', 'SECOND');
}
{
  // ── THE PUT ───────────────────────────────────────────────────────────
  const { api, st, calls } = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
  const TEXT = '# A\n\nwith https://x and <tool_use>\n';
  st.fndEdit = anEdit({ text: TEXT, loaded: TEXT, title: 'Arch', role: 'architecture' });
  await api.saveFoundation(1);
  eq('one request', calls.urls.length, 1);
  eq('...at the document', calls.urls[0], '/api/memory/acme/lumina/foundations/architecture.md');
  eq('...as a PUT', calls.inits[0].method, 'PUT');
  const sent = JSON.parse(calls.inits[0].body);
  eq('the bytes cross UNCHANGED — a canonical document is stored verbatim',
    sha(sent.text), sha(TEXT));
  eq('...with the title', sent.title, 'Arch');
  eq('...and the role', sent.role, 'architecture');
  eq('THREE fields and no more, so there is no field through which a browser could forge an '
    + 'agent\'s provenance line', Object.keys(sent).sort().join(','), 'role,text,title');
  eq('the editor closes on success', st.fndEdit, null);
  ok('the cached read is dropped BEFORE the re-read — this is the one moment the view knows '
    + 'its own copy is wrong before any server says so', calls.forgot[0] === 'acme/lumina');
  eq('...and the project is re-read from the server rather than patched in place', calls.reloaded, 1);
}
{
  // A FAILURE KEEPS THE DRAFT, because it is the only copy.
  const { api, st } = writeRig(() => ({ ok: false, status: 400,
    json: async () => ({ ok: false, error: 'repo_owned',
      message: 'mirrored from the repository — edit it there and refresh' }) }));
  st.fndEdit = anEdit({ text: 'the words I typed' });
  await api.saveFoundation(1);
  ok('the editor STAYS OPEN', st.fndEdit !== null);
  eq('...with the draft intact', st.fndEdit ? st.fndEdit.text : '<editor closed>', 'the words I typed');
  ok('...and the server\'s own sentence above it, not a status code',
    /edit it there and refresh/.test(String(st.fndEdit && st.fndEdit.error)),
    String(st.fndEdit && st.fndEdit.error));
  eq('...and not busy any more', st.fndEdit ? st.fndEdit.busy : '<editor closed>', false);
}
{
  // A LATE REPLY IS DROPPED. A save is a round trip over a whole-document
  // write, so a switch mid-flight is ordinary rather than exotic.
  let release;
  const gate = new Promise((r) => { release = r; });
  const { api, st, calls } = writeRig(async () => { await gate;
    return { ok: true, json: async () => ({ ok: true }) }; });
  st.fndEdit = anEdit({ text: 'x' });
  const p = api.saveFoundation(1);
  st.fndEdit = anEdit({ slug: 'decisions.md', text: 'different document' });
  release();
  await p;
  eq('a reply for a document the owner has left does NOT close the editor they are in now',
    st.fndEdit ? st.fndEdit.slug : '<editor closed>', 'decisions.md');
  eq('...and does not re-read on their behalf', calls.reloaded, 0);
}
{
  // THE WALL AND THE SLUG ARE REFUSED LOCALLY, BEFORE ANY REQUEST.
  const over = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
  over.st.fndEdit = anEdit({ text: 'x'.repeat(FI.MAX_FOUNDATION_BYTES + 1) });
  await over.api.saveFoundation(1);
  eq('a draft over the per-document wall issues NO request', over.calls.urls.length, 0);
  const bad = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
  bad.st.fndEdit = anEdit({ isNew: true, slug: 'Bad Name', text: 'x' });
  await bad.api.saveFoundation(1);
  eq('an illegal new file name issues NO request either', bad.calls.urls.length, 0);
  const busy = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
  busy.st.fndEdit = anEdit({ busy: true });
  await busy.api.saveFoundation(1);
  eq('a second save while one is in flight issues no request — the last to arrive would win, '
    + 'which is not what pressing twice means', busy.calls.urls.length, 0);
}
{
  // ── THE DELETE ────────────────────────────────────────────────────────
  const { api, st, calls } = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
  st.fndEdit = anEdit({ confirmDelete: true });
  await api.deleteFoundation(1);
  eq('...at the document', calls.urls[0], '/api/memory/acme/lumina/foundations/architecture.md');
  eq('...as a DELETE', calls.inits[0].method, 'DELETE');
  eq('the slug travels as its own typed confirmation, so a client that skipped the strip '
    + 'deletes nothing', JSON.parse(calls.inits[0].body).confirm, 'architecture.md');
  eq('the editor closes', st.fndEdit, null);
  eq('...the cache is dropped', calls.forgot[0], 'acme/lumina');
  eq('...and the project re-read', calls.reloaded, 1);
}
{
  const { api, st } = writeRig(() => ({ ok: false, status: 400,
    json: async () => ({ ok: false, message: 'repo_owned' }) }));
  st.fndEdit = anEdit({ confirmDelete: true });
  await api.deleteFoundation(1);
  ok('a refused delete closes the STRIP and keeps the editor, with the reason',
    !!st.fndEdit && st.fndEdit.confirmDelete === false
    && /repo_owned/.test(String(st.fndEdit && st.fndEdit.error)), JSON.stringify(st.fndEdit));
  const isNew = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
  isNew.st.fndEdit = anEdit({ isNew: true, slug: 'x.md', confirmDelete: true });
  await isNew.api.deleteFoundation(1);
  eq('a document that was never saved cannot be deleted — there is nothing there',
    isNew.calls.urls.length, 0);
}
{
  // ── THE INIT ──────────────────────────────────────────────────────────
  const { api, st, calls } = writeRig(() => ({ ok: true, json: async () => ({
    ok: true, seeded: ['architecture.md', 'decisions.md', 'conventions.md', 'roadmap.md'],
    foundations: { present: true, ownership: 'curator', documents: [] } }) }));
  st.fndInit = { domain: 'acme', project: 'lumina', busy: false, error: null, refused: [],
    choice: FI.freshChooser({}) };
  await api.initFoundations(1, { present: false, ownership: null });
  eq('...at the init route', calls.urls[0], '/api/memory/acme/lumina/foundations/init');
  eq('...as a POST', calls.inits[0].method, 'POST');
  eq('the body is the one the SHARED module built, not one composed here',
    calls.inits[0].body, JSON.stringify({ ownership: 'curator' }));
  eq('the choice is dropped once it has been taken',
    st.fndInit ? st.fndInit.choice : '<record gone>', null);
  eq('...the cache with it, because a manifest and four documents now exist that did not',
    calls.forgot[0], 'acme/lumina');
}
{
  // A REFUSAL KEEPS THE CHOICE. A path typed, a scan read and eight boxes
  // ticked are not thrown away because the server said no.
  const { api, st } = writeRig(() => ({ ok: false, status: 400, json: async () => ({
    ok: false, error: 'ownership_set', message: 'this project already has a manifest' }) }));
  const choice = { ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r',
    candidates: [{ path: 'a.md', bytes: 1, suggestedRole: 'other' }], picks: { 'a.md': true } };
  st.fndInit = { domain: 'acme', project: 'lumina', busy: false, error: null, refused: [], choice };
  await api.initFoundations(1, { present: false, ownership: null });
  ok('the refusal is reported', /already has a manifest/.test(String(st.fndInit && st.fndInit.error)));
  eq('...and the scan the person read is STILL THERE',
    st.fndInit && st.fndInit.choice ? st.fndInit.choice.candidates.length : '<choice gone>', 1);
  eq('...with their ticks',
    st.fndInit && st.fndInit.choice ? st.fndInit.choice.picks['a.md'] : '<choice gone>', true);
}
{
  // AN ALREADY-OWNED MIRROR TAKES THE REFRESH ROUTE, which has its own outcome
  // rendering and its own stamped record — so this hands off rather than
  // duplicating it.
  const { api, st, calls } = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
  st.fndInit = { domain: 'acme', project: 'lumina', busy: false, error: null, refused: [],
    choice: { ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r',
      candidates: [{ path: 'docs/a.md', bytes: 1, suggestedRole: 'guide' }],
      picks: { 'docs/a.md': true } } };
  await api.initFoundations(1, { present: true, ownership: 'repo' });
  eq('an already-owned mirror never reaches the init route', calls.urls.length, 0);
  eq('...it goes through the REFRESH, which is the only route that may touch it', calls.refreshed, 1);
  eq('...carrying the files the owner chose',
    JSON.stringify(calls.refreshFiles), JSON.stringify([{ path: 'docs/a.md', role: 'guide' }]));
  eq('"decide later" commits nothing at all', await (async () => {
    const r = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
    r.st.fndInit = { domain: 'acme', project: 'lumina', busy: false, error: null, refused: [],
      choice: { ...FI.freshChooser({ allowLater: true }), ownership: 'later' } };
    await r.api.initFoundations(1, { present: false, ownership: null });
    return r.calls.urls.length;
  })(), 0);
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — THE BINDER: wire() grows no new identifier');
// ═════════════════════════════════════════════════════════════════════════
//
// `wire()` is LIFTED by brace-matching and EXECUTED against a hand-written set
// of stubs in scripts/test-agent-instructions.js, so any module-level helper
// NAMED inside it that the stub set does not carry is a ReferenceError there —
// a CRASH rather than a failing assertion, which is the v3.11.0 shape
// views/memory.js warns about four times. That suite belongs to another work
// package, so the constraint is absolute rather than negotiable.
//
// Everything v3.61.0 adds is therefore bound inside `bindFoundationRows`,
// which that stub set already carries. This is the assertion that keeps it
// true: the set of identifiers `wire()` names may not grow.
{
  const wireSrc = extractFunction(viewSrc, 'wire');
  const STUBBED = new Set([
    // The stub set in scripts/test-agent-instructions.js, transcribed. A name
    // here that is NOT there is the crash this assertion exists to prevent.
    'state', 'mounted', 'clipboardOk', 'calls', 'escapeHtml', 'icon', 'render',
    'isCurrentMount', 'reportAsyncMountFailure', 'renderStatus', 'loadGate', 'gatedLoader',
    'unlistedCount', 'renderUnlistedNote', 'renderSaveStatus', 'renderStaleNotice',
    'renderEmptyProject', 'aboutInfoHtml', 'renderNoProjects', 'renderViewHeader',
    'mainHtml', 'setMain', 'renderBriefOnlyNotice', 'renderWorkStreams', 'workStreamCounts',
    'renderBlock', 'handoffReaderContent', 'bindWorkStreamRows', 'showMoreWorkStreams',
    'openWorkStream', 'wsShownCount', 'workStreamOrder', 'WS_WINDOW', 'renderJournal',
    'renderBrief', 'renderFoundations', 'renderFoundationsStatus', 'bindFoundationRows',
    'refreshFoundations', 'keyOf', 'activeKey', 'selectProject', 'saveBrief', 'refreshIndex',
    'reloadActive', 'loadScope', 'briefDismissDecision', 'docsLinkHtml', 'JOURNAL_PAGE',
    'JOURNAL_MORE', 'document', 'navigator',
    // Module constants and functions that suite ALSO supplies, plus the
    // globals every JS engine has.
    'BRIEF_TEMPLATE', 'BRIEF_MAX_BYTES', 'briefStats', 'localStorage', 'JSON', 'Promise',
    'console', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Math', 'Date', 'Set', 'Map',
    'TextEncoder', 'copyAgentInstructions', 'captureFocus', 'patchOpenPair', 'wire',
  ]);
  // COMMENTS STRIPPED FIRST. Proven necessary by running it: the docblocks in
  // `wire()` contain prose like "BOTH, because…" and "(the v3.11.0 shape)",
  // and a bare scan read six English words as call sites. A guard that a
  // comment can break is a guard about prose.
  const wireCode = wireSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  // Names DECLARED inside wire() are not collaborators — they are locals, and
  // the stub set has no business carrying them.
  const locals = new Set([...wireCode.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)]
    .map((m) => m[1]));
  // Every bare identifier that is CALLED in wire(), which is the only way it
  // can reach a collaborator at all.
  const called = new Set([...wireCode.matchAll(/(?<![.\w$'"])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)]
    .map((m) => m[1])
    .filter((n) => !locals.has(n))
    .filter((n) => !['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
      'new', 'await', 'forEach', 'addEventListener'].includes(n)));
  const unstubbed = [...called].filter((n) => !STUBBED.has(n));
  ok('wire() calls NOTHING that scripts/test-agent-instructions.js does not stub — a free '
    + 'identifier there is a CRASH, not a failing assertion',
  unstubbed.length === 0, 'unstubbed: ' + JSON.stringify(unstubbed));
  ok('CONTROL: the scanner really found wire()\'s call sites (it is not vacuous)',
    called.size >= 8, 'found ' + called.size);
  // AND THE TIER-0 BINDER IS WHERE THE NEW WIRING WENT.
  const binderSrc = extractFunction(viewSrc, 'bindFoundationRows');
  for (const id of ['mem-fnd-add', 'mem-fnd-save', 'mem-fnd-cancel', 'mem-fnd-delete',
    'mem-fnd-delete-go', 'mem-fnd-shrink-go', 'mem-fnd-init-go', 'mem-fnd-file',
    'mem-fnd-text', 'mem-fnd-title', 'mem-fnd-slug', 'mem-fnd-preview']) {
    ok('bindFoundationRows binds ' + id, binderSrc.includes("'" + id + "'"), 'not bound');
  }
  ok('...and the row Edit controls', binderSrc.includes('[data-fnd-edit]'));
  ok('...and the shared chooser', binderSrc.includes('bindFoundationsChooser('));
  ok('wire() itself still names only the two tier-0 entry points it always did',
    /bindFoundationRows\(document, token\)/.test(wireSrc)
    && /refreshFoundations\(token\)/.test(wireSrc));
}
{
  // ── EVERY CONTROL THAT REMOVES ITSELF HAS SOMEWHERE FOR FOCUS TO GO ────
  // setMain replaces innerHTML, so a control restored "by id" that is no
  // longer there drops focus to <body> and the next Tab restarts from the
  // rail. A control that removes itself on click therefore needs a FALLBACK,
  // not just an entry in FOCUSABLE_IDS.
  const ids = /const FOCUSABLE_IDS = \[([\s\S]*?)\n\];/.exec(viewSrc);
  const fbk = /const FOCUS_FALLBACK = \{([\s\S]*?)\n\};/.exec(viewSrc);
  ok('FOCUSABLE_IDS and FOCUS_FALLBACK were both found (the scan is not vacuous)',
    !!ids && !!fbk);
  const CAPTURED = ['mem-fnd-add', 'mem-fnd-addrepo', 'mem-fnd-slug', 'mem-fnd-title',
    'mem-fnd-text', 'mem-fnd-save', 'mem-fnd-cancel', 'mem-fnd-preview', 'mem-fnd-discard',
    'mem-fnd-keep', 'mem-fnd-delete', 'mem-fnd-delete-go', 'mem-fnd-delete-no',
    'mem-fnd-shrink-go', 'mem-fnd-shrink-no', 'mem-fnd-init-go'];
  for (const id of CAPTURED) {
    ok('FOCUSABLE_IDS knows ' + id, ids && ids[1].includes("'" + id + "'"));
  }
  // The ones that genuinely disappear when pressed.
  const REMOVES_ITSELF = ['mem-fnd-add', 'mem-fnd-addrepo', 'mem-fnd-save', 'mem-fnd-cancel',
    'mem-fnd-discard', 'mem-fnd-keep', 'mem-fnd-delete', 'mem-fnd-delete-go',
    'mem-fnd-delete-no', 'mem-fnd-shrink-go', 'mem-fnd-shrink-no', 'mem-fnd-init-go'];
  for (const id of REMOVES_ITSELF) {
    ok('...and FOCUS_FALLBACK has somewhere for ' + id + ' to send focus',
      fbk && fbk[1].includes("'" + id + "'"), 'no fallback');
  }
  // The FOLD registry is UNTOUCHED: the editor joins the fold that already
  // exists rather than inventing a fourth key, so scripts/test-ui-state.js's
  // localStorage registry does not move.
  const foldKeys = /const FOLD_KEYS = (\[[^\]]*\]);/.exec(viewSrc);
  eq('FOLD_KEYS is still exactly the three it was — the editor reuses the foundations fold '
    + 'rather than inventing a key, so the localStorage registry does not move',
  foldKeys && foldKeys[1].replace(/\s+/g, ''), "['brief','journal','foundations']");
}

// ── Done ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ All foundations chooser + editor assertions green');
else console.log('❌ ' + failed + ' foundations assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
