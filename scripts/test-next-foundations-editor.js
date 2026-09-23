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

// ── THE SESSION BUDGET, OFF LIVE SOURCE (v3.62.0) ─────────────────────────
// `foundationsFacts` falls back to it when the server sends no
// `readFirstBudgetBytes`, so every rig that lifts the facts has to inject it —
// an undefined identifier inside a lifted function is a CRASH rather than a
// failing assertion. NOT `FOUNDATIONS_BUDGET_BYTES`: that is what a project
// may STORE (200 KB), this is what an agent RECEIVES in a session (120 KB).
const READ_FIRST_BUDGET_SRC = (() => {
  const m = /^const READ_FIRST_BUDGET_BYTES = ([^;]+);$/m.exec(viewSrc);
  if (!m) throw new Error('READ_FIRST_BUDGET_BYTES not found in memory.js — the rigs below would crash');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[1] + ');')();
})();
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

// ── THE IMPORT ALLOW-LIST, CHECKED BEFORE THE IMPORT ────────────────────
//
// It has to run FIRST. The contract is that this module imports nothing that
// reaches a DOM at import time — and an import that breaks it THROWS while the
// module is being evaluated, which kills this file before any assertion runs.
// A crash is a signal, but it is not a NAMED one: the same exit looks like a
// syntax error, a missing file or a bad path. Checked here, against the source
// text, a violation is one red line saying which import did it.
//
// `shared/age.js` is the allow-list, and the reason is in the module's own
// header: it touches no `document`, and it is the app's single age ladder —
// `formatAge`'s body is deliberately byte-identical in three places, so a
// fourth hand-kept copy here would have needed a fourth pin.
{
  const lines = initSrc.match(/^import\s[^\n]*/gm) || [];
  // v3.65.2: `./monitor.js` joins the allow-list. It has NO imports and
  // touches no DOM (asserted just below, off its own source), and the add
  // panel needs its depth cell and monitor line rather than a hand-built copy.
  const bad = lines.filter((line) => !/from '\.\/(age|monitor)\.js'/.test(line));
  if (bad.length) {
    console.log('  ✗ shared/foundations-init.js imports something outside the DOM-free kit — '
      + JSON.stringify(bad));
    console.log('\n' + '─'.repeat(60));
    console.log('Passed: 0   Failed: 1');
    process.exit(1);
  }
}

// The REAL shared module. Nothing DOM-bound on its import graph, so it runs in Node.
{
  // THE SECOND ALLOWED IMPORT MUST STAY DOM-FREE, or the allow-list above is
  // a door rather than a wall: shared/monitor.js may import nothing at all.
  const monSrc = readFileSync(join(NEXT, 'shared/monitor.js'), 'utf8');
  if ((monSrc.match(/^import\s/gm) || []).length) {
    console.log('  ✗ shared/monitor.js grew an import, so foundations-init.js may no longer take it');
    process.exit(1);
  }
}
const FI = await import('../src/public/next/shared/foundations-init.js');
const { renderInfoMark: realRenderInfoMark } = await import('../src/public/next/shared/text.js');

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

  // ── THE IMPORT ALLOW-LIST (v3.61.1) ──────────────────────────────────
  //
  // This was `no imports AT ALL` until v3.61.1, and the letter of it was
  // never the point: the contract is that nothing this module imports may
  // reach a DOM at import time, which is what lets a plain Node suite import
  // it and what stops it dragging `app.js` in. `shared/age.js` satisfies that
  // by its own header ("Nothing here touches `document`") and is the app's
  // SINGLE age ladder — `formatAge`'s body is deliberately byte-identical in
  // three places precisely because copying it is the failure mode, so a
  // fourth copy here would have needed a fourth pin.
  //
  // Asserted as an ALLOW-LIST rather than as an absence, so the property that
  // matters is the one measured: every import line, if there is one, names
  // `./age.js`. An import of a view, the shell or the listbox reddens this.
  ok('shared/foundations-init.js imports ONLY from the DOM-free kit (./age.js, ./monitor.js)',
    initSrc.match(/^import\s[^\n]*/gm) === null
      || initSrc.match(/^import\s[^\n]*/gm).every((line) => /from '\.\/(age|monitor)\.js'/.test(line)),
    JSON.stringify(initSrc.match(/^import\s[^\n]*/gm)));
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
  // ── THE DEFAULT IS THE ARM THAT WRITES NOTHING, WHERE THERE IS ONE
  //    (v3.61.0, maintainer's call on Q1) ─────────────────────────────────
  // The fail-safe direction decides it. On the CREATE FORM the documents
  // choice is one field of a bigger form, and the arm that writes four
  // documents is not the safe answer on a form somebody has not read —
  // `later` is: nothing is written, and the Foundations block asks the same
  // question again in the place the answer is missing. Where there is NO third
  // answer (the Memory block, which IS the later) the default stays `curator`,
  // because it is the only arm that works with no preconditions: mirroring
  // needs a folder on THIS computer at a path the owner can type, and a
  // first-time user has neither to hand.
  const later = FI.freshChooser({ allowLater: true });
  eq('on the create form, where postponing is an answer, the default POSTPONES',
    later.ownership, 'later');
  eq('...and postponing sends no `foundations` key at all', FI.chooserBody(later), null);
  const c = FI.freshChooser({});
  eq('where there is no third answer, the default is the arm that needs nothing '
    + 'set up first', c.ownership, 'curator');
  eq('...and that host offers no "decide later" to reach', c.allowLater, false);
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
    // `.hidden.md` rather than `.hidden`: the KIND check runs first now
    // (v3.61.0, contract §10) and a bare `.hidden` is refused for not being
    // markdown, which is a true refusal but not the one this assertion is
    // about. A dotfile's stem is still the thing under test — the store's
    // grammar needs a leading alphanumeric, so `.hidden.md` would become the
    // slug `hidden.md`, a name the owner never chose.
    const got = await FI.readPickedFile(file('.hidden.md', 'x'), reader);
    ok('a file whose name yields no legal slug is refused with a reason, not renamed for the '
      + 'owner', /no usable file name/.test(got.error), got.error);
  }

  // ── A PDF IS REFUSED, AND IS NEVER READ (v3.61.0, contract §10) ─────────
  //
  // The store mirrors `.md` and `.txt` only, and a foundation is text an agent
  // reads VERBATIM — so extracting a PDF would be a transformation, which is
  // the one thing this tier exists not to do. The refusal is checked BEFORE
  // the size (kind is the more specific fact: a 40 MB PDF is not "too large",
  // it is the wrong kind) and before any read, and it is checked at all rather
  // than left to the `accept` attribute because every file dialog on every
  // platform offers an "All files" escape from it.
  {
    let read = 0;
    const counting = async () => { read++; return 'x'; };
    const got = await FI.readPickedFile(file('notes.pdf', 'x', 4096), counting);
    eq('a PDF is never read', read, 0);
    eq('...and carries no text', got.text, '');
    // A COMPLETE SENTENCE, not a fragment: the hosts render `error` inside a
    // row as "<name> <error>." and `refusal` unfolded where the picker is, and
    // a file refused on kind never becomes a row at all.
    eq('...and the refusal is the maintainer\u2019s exact sentence, naming both '
      + 'ways forward rather than only the rule',
    got.refusal,
    'Documents are kept word for word; a PDF needs converting. Ingest it into the wiki, '
      + 'or export it as Markdown first.');
    ok('...and a row fragment as well, for a host that lists it',
      /is a PDF/.test(got.error), got.error);
    // A 40 MB PDF is refused for its KIND, not its size — the specific fact.
    const huge = await FI.readPickedFile(file('big.pdf', 'x', FI.MAX_FOUNDATION_BYTES + 1), counting);
    ok('an oversized PDF is refused for being a PDF, not for being large',
      /a PDF needs converting/.test(huge.refusal || ''), huge.refusal);
    eq('...and is still never read', read, 0);
  }
  {
    let read = 0;
    const counting = async () => { read++; return 'x'; };
    const got = await FI.readPickedFile(file('notes.docx', 'x', 4096), counting);
    eq('any other non-text kind is refused too, unread', read, 0);
    ok('...with the file named in the sentence', /notes\.docx is neither/.test(got.refusal || ''),
      got.refusal);
    // A 4 KB FILENAME MUST NOT BECOME THE WHOLE PANEL.
    const long = await FI.readPickedFile(file('x'.repeat(4000) + '.docx', 'y', 10), counting);
    ok('...and a pathological filename is bounded rather than printed whole',
      String(long.refusal).length < 300, String(long.refusal).length);
  }
  {
    // CONTROL: the four kinds the store accepts are read.
    for (const name of ['a.md', 'a.txt', 'a.markdown', 'a.mdown']) {
      const got = await FI.readPickedFile(file(name, 'body'), reader);
      eq(name + ' is read, not refused on kind', got.refusal, null);
    }
    // AND `refusal` IS AN EXPLICIT null ON EVERY OTHER ARM, so a consumer
    // tests the FIELD rather than its absence.
    eq('a size refusal carries refusal: null, so the host lists it as a row',
      (await FI.readPickedFile(file('big.md', 'x', FI.MAX_FOUNDATION_BYTES + 1), reader)).refusal, null);
    eq('...and so does a read that succeeded',
      (await FI.readPickedFile(file('a.md', 'x'), reader)).refusal, null);
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
    + 'not only in a colour', /data-fnd-own="later" aria-pressed="true"/.test(full));
  // ── EACH LINE NAMES WHAT YOU DO NEXT (v3.61.1) ────────────────────────
  //
  // THE DEFECT, in the maintainer's words on the shipped v3.61.0 arm: "I
  // don't see any scan feature anywhere." Both lines described the END STATE
  // of a decision ("Copied byte for byte. You edit them in the folder, never
  // here.") and neither said what the arm would ask of him — so the step that
  // makes a mirror, PICKING WHICH FILES, was invisible until the card was
  // pressed. The mirror line now says it, and the words "You pick which
  // files" are pinned by name here for that reason.
  //
  // Where a mirrored document is EDITED is mechanism and lives in the hosts'
  // ⓘ ("A mirrored document belongs to its repository, so it is changed
  // THERE and re-copied here").
  ok('each answer carries its CONSEQUENCE — the reading a person needs before pressing',
    /Four skeletons to fill/.test(full)
    && /Copied byte for byte from a folder/.test(full)
    && /Nothing is written now/.test(full), full.slice(0, 900));
  ok('...and the mirror line says WHO PICKS THE FILES, which is the step the '
    + 'maintainer could not find', /You pick which files\./.test(full), full.slice(0, 900));
  // ≤ 13 VISIBLE WORDS EACH (design-system §3). Counted from the RENDERED
  // text rather than from a literal typed in this file, so a rewrite that
  // pushes a line over the ceiling reddens on the line itself.
  //
  // COUNTED THE WAY THE APP COUNTS. The filter is
  // test-next-settings-sections.js's `visibleWords` verbatim — a token counts
  // only if it holds a letter or a digit — so an em dash between two clauses
  // is punctuation here exactly as it is there. Two counters with two answers
  // to "how long is this lede" would be the drift this borrows to avoid.
  for (const line of full.match(/<span class="fnd-init-opt-line">([^<]*)<\/span>/g) || []) {
    const txt = line.replace(/<[^>]*>/g, '');
    const words = txt.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    ok('option line is at most 13 visible words (' + words.length + '): ' + txt,
      words.length <= 13, String(words.length));
  }
  // ── THE OWNER IS NAMED FIRST, AND THE WORD IS FOLDER ──────────────────
  // P1-12: a person can start a project here with NO agent and no repository
  // and write the first document by hand, so no line may presume an agent; and
  // where both ways in are named the owner's comes first.
  // P1-9: `resolveRepoRoot` requires only an absolute, reachable DIRECTORY, so
  // a label saying "repository" turns away everybody whose documents live in
  // ~/Documents/lumina-docs. That a git checkout additionally records the
  // commit is mechanism, and it belongs in the host's ⓘ.
  ok('the curator arm names the owner before the agent',
    full.indexOf('by you') >= 0 && full.indexOf('by you') < full.indexOf('or an agent'),
    full.slice(0, 900));
  // ── THE WORD IS FOLDER ON THE LOCAL ARM, AND ONLY THERE (v3.65.0) ─────
  // The rule this assertion carries is P1-9's and is unchanged: a label
  // saying "repository" on the LOCAL arm turns away everybody whose documents
  // live in ~/Documents/lumina-docs, because `resolveRepoRoot` requires only
  // an absolute, reachable DIRECTORY. A GitHub mirror is a different source
  // and the word is not a euphemism there — it IS a repository, named by
  // owner and repo — so the ban narrows from "anywhere" to "the local arm",
  // which is where it always meant something.
  const localArm = FI.renderFoundationsChooser({ id: 'x',
    choice: { ...FI.freshChooser({ allowLater: true }), ownership: 'repo' } });
  ok('...and the LOCAL mirror arm says "folder", never "repository"',
    !/repositor/i.test(localArm.slice(localArm.indexOf('fnd-init-arm'))),
    localArm.slice(localArm.indexOf('fnd-init-arm'), localArm.indexOf('fnd-init-arm') + 800));
  ok('...and the mirror arm says "folder"', /Mirror a folder on this Mac/.test(full));
  // ── AND THE THIRD CARD IS THE ONE THAT MAY SAY IT ────────────────────
  ok('the GitHub card is offered beside the other two',
    /data-fnd-own="remote"/.test(full) && /Mirror a GitHub repository/.test(full),
    full.slice(0, 1400));
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
  // ── THE RUNNING TOTAL (v3.61.1) ───────────────────────────────────────
  // Ticks AND bytes, against the project budget. The tick count alone cannot
  // tell somebody they are about to mirror nine times what an agent will
  // receive, which is what happened on the maintainer's own repository: 25
  // documents, 1,875 KB, every one of them ticked by default.
  ok('the count line says how many of what, AND what it costs',
    /1 of 1 ticked · 4 KB of a 200 KB budget/.test(scanned), scanned.slice(-800));
  ok('...and the over-budget warning is EMITTED and `hidden` under the budget, so the tick '
    + 'that crosses the line can reveal it without a re-render',
  /class="fnd-init-note fnd-init-note-loud fnd-init-budget" id="x-budget" hidden/.test(scanned),
  scanned.slice(-800));
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
  // ── A REAL BUTTON, AND AN INPUT THAT IS `hidden` (v3.61.0, P1-7) ──────
  //
  // The first cut wrapped a `.visually-hidden` input in a <label> wearing the
  // button classes. A visually-hidden input is STILL FOCUSABLE: a keyboard
  // user's focus lands on something invisible while the thing that looks like
  // a button cannot be focused at all and can never paint `--ring-focus` — the
  // token that exists precisely because the one state that must be findable
  // was the hardest thing on the page to find. `hidden` takes the input out of
  // the tab order entirely and a `<button>` clicks it, which is the pattern
  // views/ingest.js's drop zone has shipped for releases.
  ok('the control is a real <button> wearing the kit\'s classes',
    /<button type="button" class="btn btn-secondary btn-xs fnd-init-file" id="x-files-btn">/.test(cur),
    cur.slice(0, 1800));
  ok('...and the input is `hidden`, so it is out of the tab order rather than '
    + 'merely invisible and still focusable',
  /<input type="file" id="x-files"[^>]* hidden/.test(cur), cur.slice(0, 1800));
  ok('...and NOT visually-hidden inside a label, which is the shape that put '
    + 'focus on something nobody can see',
  !/class="visually-hidden" id="x-files"/.test(cur)
    && !/<label class="btn[^"]*fnd-init-file"/.test(cur), cur.slice(0, 1800));
  ok('...accepting markdown and text only', /accept="\.md,\.txt,text\/markdown,text\/plain"/.test(cur));
  ok('...MULTIPLE on the create form, where each file becomes one document',
    /id="x-files"[^>]*multiple/.test(cur));

  // ── THE HINT'S "UNTIL…" CLAUSE IS HOST-DEPENDENT (v3.62.0) ─────────────
  //
  // On the create form the project genuinely does not exist yet, so "nothing
  // is uploaded until you create the project" is true as written — that is
  // `cur` above, built with no `existingProject`, the module's own default.
  // In Agent memory the project this chooser is attached to already exists;
  // what has not happened yet is the DOCUMENTS, so the same clause there
  // would be false. `existingProject` is the one flag the chooser's cfg
  // object carries for the difference, threaded through to `curatorArm`
  // rather than the two hosts each composing their own hint text.
  ok('CREATE FORM (no existingProject): the hint says "create the project"',
    /nothing is uploaded until you create the project\./.test(cur), cur.slice(0, 2000));
  ok('...and NOT the Agent-memory wording',
    !/until you set up documents/.test(cur));
  const curExisting = FI.renderFoundationsChooser({
    id: 'x', choice: FI.freshChooser({}), existingProject: true,
  });
  ok('AGENT MEMORY (existingProject: true): the hint says "set up documents"',
    /nothing is uploaded until you set up documents\./.test(curExisting),
    curExisting.slice(0, 2000));
  ok('...and NOT the create-form wording, which would be false there — the '
    + 'project already exists',
  !/until you create the project/.test(curExisting));
  // CONTROL: every other byte of the chooser is untouched by the flag — the
  // two only differ in the clause after "until you". Normalised with a plain
  // regex rather than a sentinel byte, so nothing unusual lands in this file's
  // own bytes (test-source-scan-helpers.js §9 checks for exactly that).
  ok('CONTROL: the flag touches ONLY the hint clause, nothing else in the chooser',
    cur.replace(/until you create the project\./, 'until you CLAUSE.')
      === curExisting.replace(/until you set up documents\./, 'until you CLAUSE.'),
    'cur: ' + cur.length + ' bytes, curExisting: ' + curExisting.length + ' bytes');

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
    getAttribute(k) {
      if (this._attrs && Object.hasOwn(this._attrs, k)) return this._attrs[k];
      return this.dataset[k.replace(/^data-/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase())];
    },
    // `aria-expanded` is written by the binder as an ATTRIBUTE, on the one
    // control whose state a screen reader reads out of the accessibility tree
    // rather than out of a class. Without this the shipped call is skipped by
    // its own `typeof` guard and the assertion for it measures nothing.
    setAttribute(k, v) { (this._attrs = this._attrs || {})[k] = String(v); },
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
  const roleOpen = node({ dataset: { fndRoleOpen: 'docs/a.md' }, textContent: 'architecture' });
  const roleBtn = node({ dataset: { fndRole: 'guide', fndRoleScope: 'docs/a.md' } });
  // ── THE ROW, THE COUNT AND THE WARNING (v3.61.1) ──────────────────────
  //
  // A tick no longer repaints anything: the binder writes the state and
  // PATCHES the nodes that read it, which is what keeps a reader of a 44-row
  // list where they were. So the model has to carry those nodes, and the
  // assertions below read them rather than counting renders.
  //
  // `roleSlot` is the per-row element the seven options are written INTO
  // (`innerHTML`), which is how one row's control opens without the list
  // being rebuilt around it.
  const roleSlot = node({ dataset: { fndRoleslot: 'docs/a.md' }, innerHTML: '' });
  const candRow = node({
    dataset: { fndCandRow: 'docs/a.md' },
    querySelector: (sel) => ({
      '[data-fnd-roleslot]': roleSlot,
      '[data-fnd-role-open]': roleOpen,
      '[data-fnd-cand]': cand,
    }[sel] || null),
  });
  const countNode = node({ textContent: '' });
  const budgetSpan = node({ textContent: '' });
  const budgetNode = node({ hidden: true, querySelector: () => budgetSpan });
  const shell = node({
    querySelector: (sel) => ({
      '[data-fnd-cand-row="docs/a.md"]': candRow,
      '.fnd-init-count': countNode,
    }[sel] || null),
    querySelectorAll: (s) => ({
      '[data-fnd-own]': [curBtn, repoBtn],
      '[data-fnd-extra-role]': [extraRole],
      '[data-fnd-extra-drop]': [],
      '[data-fnd-import-drop]': [],
    }[s] || []),
  });
  const doc = {
    ...docModel({
      'x-root': root, 'x-scan': scan, 'x-extra': extra, 'x-extra-add': extraAdd,
      'x-seed': seed, 'x-files': null, 'x-count': countNode, 'x-budget': budgetNode,
      'x-why': node({ hidden: false, querySelector: () => node({ textContent: '' }) }),
      'x-extra-as': node({ hidden: true }),
    }, { '[data-fnd-init="x"]': [shell] }),
  };
  let scanned = null;
  const selectReasons = [];
  FI.bindFoundationsChooser({
    doc, id: 'x', choice,
    onChange: () => { renders++; },
    // The host's own patch hook: what it is handed is the sentence under its
    // commit control, and '' means "the control is live".
    onSelect: (reason) => { selectReasons.push(reason); },
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
  // NOTHING IS TICKED (v3.65.3). v3.61.0 ticked everything, v3.61.1 the four
  // canonical roles; the maintainer: "default should be unticked, then you
  // select what you need." A first set-up is no exception — `docs/a.md` is an
  // `architecture` candidate, exactly the kind the old rule pre-ticked.
  eq('a first-set-up scan ticks NOTHING, not even a canonical-role candidate',
    JSON.stringify(choice.picks), '{}');
  ok('...and the one over the cap is not ticked either', !('docs/big.md' in choice.picks),
    JSON.stringify(choice.picks));
  // Tick it by hand so the patch assertions below run against a real tick.
  choice.picks['docs/a.md'] = true;
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

  // ══════════════════════════════════════════════════════════════════════
  // A TICK PATCHES; IT DOES NOT RENDER (v3.61.1)
  // ══════════════════════════════════════════════════════════════════════
  //
  // ── THE DEFECT, AND WHAT IT COST ──────────────────────────────────────
  // The maintainer, mirroring a real repository: "when I select or deselect a
  // document I'm always thrown at the top — confusing with 50 documents."
  // Measured in a real browser on a 44-candidate folder BEFORE the fix: the
  // list's own scrollTop went 1105 -> 0, the scroll container came back a
  // DIFFERENT NODE, and the focused checkbox lost focus. Every tick called
  // the host's `onChange`, which in Agent memory is `render(token)` — a full
  // view render for one boolean in a map.
  //
  // The listeners are DELEGATED on the chooser's root now (the role options
  // are written into a row AFTER binding, so a per-node listener would never
  // see them), so these assertions fire on the SHELL carrying a target,
  // exactly as a browser would.
  renders = 0;
  shell.fire('click', { target: roleOpen });
  eq('pressing a role opens that row\'s options', choice.roleOpenFor, 'docs/a.md');
  eq('...and NO repaint: the seven options are written into that row\'s own slot', renders, 0);
  ok('...the slot really holds them', /data-fnd-role="guide"/.test(roleSlot.innerHTML),
    roleSlot.innerHTML.slice(0, 120));
  eq('...with the row\'s control reporting itself expanded IN THE ACCESSIBILITY TREE',
    roleOpen.getAttribute('aria-expanded'), 'true');
  shell.fire('click', { target: roleBtn });
  eq('picking one records it', choice.roles['docs/a.md'], 'guide');
  eq('...closes the row', choice.roleOpenFor, null);
  eq('...emptying the slot rather than rebuilding the list', roleSlot.innerHTML, '');
  eq('...and saying so in the accessibility tree', roleOpen.getAttribute('aria-expanded'), 'false');
  eq('...and TICKS the file, because picking a role is also a statement that it is wanted',
    choice.picks['docs/a.md'], true);
  eq('...with the row\'s own label rewritten in place', roleOpen.textContent, 'guide');
  eq('...and STILL no repaint', renders, 0);

  cand.checked = false;
  shell.fire('change', { target: cand });
  ok('unticking removes the pick outright rather than storing a false',
    !('docs/a.md' in choice.picks), JSON.stringify(choice.picks));
  eq('A TICK REPAINTS NOTHING — the whole point of the change', renders, 0);
  ok('...and the count line is rewritten in place instead',
    /0 of 1 ticked · 0 bytes of a 200 KB budget/.test(countNode.textContent),
    countNode.textContent);
  // THE HOST'S COMMIT IS THE ONE THING THE CHOOSER CANNOT PATCH ITSELF: it
  // emits no primary (the other host has its own), so the reason travels back
  // through `onSelect` and the host writes its own two nodes.
  ok('the host is handed the reason its commit is off, on the same tick',
    selectReasons[selectReasons.length - 1] === 'Tick at least one document.',
    JSON.stringify(selectReasons));
  cand.checked = true;
  shell.fire('change', { target: cand });
  eq('...and handed the empty string when the reason goes away',
    selectReasons[selectReasons.length - 1], '');
  ok('...and the count line moved again, in place',
    /1 of 1 ticked/.test(countNode.textContent), countNode.textContent);
  // THE OVER-BUDGET WARNING is revealed by the same patch, never by a render.
  {
    const fat = FI.freshChooser({});
    fat.ownership = 'repo';
    fat.candidates = [{ path: 'docs/a.md', bytes: 300 * 1024, suggestedRole: 'architecture' }];
    fat.picks = { 'docs/a.md': true };
    // v3.65.3: "the rest is dropped" was FALSE — the store omits a document
    // from the session-start reading and keeps it in the index, fetched by
    // name. The sentence names the two budgets and what really happens.
    ok('over the 200 KB budget, the warning names what REALLY happens: 120 KB of text at '
      + 'session start, everything else listed and fetched by name',
      FI.budgetWarning(fat) === 'Over the 200 KB project budget. Agents are handed up to 120 KB '
        + 'of document text at session start (only the read-first ones, if any are flagged); '
        + 'every other document stays listed and is fetched by name when needed.',
      FI.budgetWarning(fat));
    ok('...and never again claims anything is dropped', !/dropped/i.test(FI.budgetWarning(fat)),
      FI.budgetWarning(fat));
    fat.picks = {};
    eq('...and says nothing at all under the budget', FI.budgetWarning(fat), '');
  }

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
    // ── THE SKELETON PREDICATE, LIFTED (v3.61.0, P1-2) ──────────────────
    // `foundationsFacts` and `foundationReaderContent` both ask it whether a
    // document is still a set of PROMPTS, and it reads the store's `skeleton`
    // FLAG and nothing else — never the banner's own sentence, which the owner
    // is invited to delete the moment they answer the prompts. Lifted rather
    // than stubbed: a stub would let the reader's most consequential note go
    // missing with every assertion here green.
    extractFunction(viewSrc, 'skeletonOf') + '\n' +
    extractFunction(viewSrc, 'fndStats') + '\n' +
    extractFunction(viewSrc, 'fndSlugError') + '\n' +
    extractFunction(viewSrc, 'fndShrinkWarn') + '\n' +
    extractFunction(viewSrc, 'briefDismissDecision') + '\n' +
    extractFunction(viewSrc, 'renderFoundationEditor') + '\n' +
    extractFunction(viewSrc, 'renderFoundationsInit') + '\n' +
    extractFunction(viewSrc, 'foundationReaderContent') + '\n' +
    extractFunction(viewSrc, 'formatAge') + '\n' +
    'return { foundationsFacts, skeletonOf, fndStats, fndSlugError, fndShrinkWarn, '
    + 'briefDismissDecision, renderFoundationEditor, renderFoundationsInit, '
    + 'foundationReaderContent };';
  // eslint-disable-next-line no-new-func
  return new Function('state', 'escapeHtml', 'icon', 'renderMarkdown', 'renderStatus',
    'renderDescription', 'renderReadout',
    'FOUNDATION_SLUG_RE', 'FOUNDATION_ROLES', 'MAX_FOUNDATION_BYTES', 'FOUNDATIONS_BUDGET_BYTES',
    // ── THE SESSION BUDGET (v3.62.0) ──────────────────────────────────────
    // `foundationsFacts` falls back to it when the server sends no
    // `readFirstBudgetBytes`. It is NOT `FOUNDATIONS_BUDGET_BYTES`: that is
    // what a project may STORE (200 KB), this is what an agent RECEIVES in a
    // session (120 KB), and conflating them warns about the wrong set.
    // Declared LAST, beside the value it is bound to, because these two lists
    // are positional and a name inserted in the middle of one silently shifts
    // every argument after it.
    'renderRoleOptions', 'renderFoundationsChooser', 'freshChooser', 'formatBytes',
    // ── ONE PREDICATE FOR THE COMMIT (v3.61.1) ────────────────────────────
    // `renderFoundationsInit` asks the SHARED module whether its primary can
    // be pressed, and paints the reason when it cannot. Passed in rather than
    // stubbed: a stub returning '' would leave the button armed in exactly the
    // state the sentence exists for, with every assertion here green.
    'commitBlockedReason', 'READ_FIRST_BUDGET_BYTES',
    // ── v3.65.2: THE ONE REASON LINE AND THE PRIMARY'S COUNT ─────────────
    // `renderFoundationsInit` reads the first unmet step through the shared
    // `nextStepReason`, counts the primary with `pickedFiles`, and composes
    // two ⓘ marks. All REAL, appended LAST for the positional reason above.
    'nextStepReason', 'pickedFiles', 'READ_WITH_INFO_HTML', 'renderInfoMark',
    body)(
    stateBox, escapeHtml, () => '<svg></svg>', (t) => '<md>' + escapeHtml(t) + '</md>',
    (o) => '<div class="tx-status tx-status-' + o.state + '"><b>' + escapeHtml(o.title)
      + '</b><i>' + escapeHtml(o.detail || '') + '</i></div>',
    (t) => '<p class="tx-desc">' + escapeHtml(t) + '</p>',
    (o) => '<div class="tx-readout">' + escapeHtml(o.label) + ': ' + escapeHtml(o.value) + '</div>',
    FI.FOUNDATION_SLUG_RE, FI.FOUNDATION_ROLES, FI.MAX_FOUNDATION_BYTES,
    FI.FOUNDATIONS_BUDGET_BYTES, FI.renderRoleOptions, FI.renderFoundationsChooser,
    FI.freshChooser, FI.formatBytes, FI.commitBlockedReason,
    // Off LIVE SOURCE, for the reason every other mirror here is: a copy typed
    // in this file could agree with every assertion while the shipped block
    // warned at another number.
    READ_FIRST_BUDGET_SRC,
    FI.nextStepReason, FI.pickedFiles, FI.READ_WITH_INFO_HTML, realRenderInfoMark);
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
  // ── THE OPENER IS `btn-danger`, NOT `btn-ghost` (v3.61.0, P1-5) ───────
  // The taxonomy is explicit: `.btn-danger` = DESTROYS DATA, tinted, never
  // filled. A ghost face on the one control in this editor that removes a
  // document makes it read as quiet-and-harmless, which is the opposite of
  // what it is — and `domains.js`'s surviving `.dm-delete-btn { color:
  // var(--danger-text) }` is the last hand-built override of exactly this
  // kind, which this release does not extend.
  ok('Delete wears the DANGER face, and sits in the footer rather than beside '
    + 'Save — it destroys a document and must not be one mis-click from the commit',
  /btn-danger btn-xs mem-fnd-delete" id="mem-fnd-delete"/.test(html), html.slice(-700));
  ok('...tinted, never filled — the filled face is reserved for the confirm',
    !/btn-danger-solid[^>]*id="mem-fnd-delete"/.test(html));
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
  // v3.66.0 (design §0.8): it used to say the 200 KB was what "an agent reads
  // in one call" and that "the read is what gets trimmed" — both false. It now
  // names the PROJECT budget, and says what an agent is handed, against the
  // READING budget the payload carries (never the constant), in the same true
  // words `foundationsBudgetWarning` uses under the row.
  const budgFlat = budg.replace(/\s+/g, ' ');
  ok('...and it names the budget it crossed: the 200 KB PROJECT budget',
    /over the 200 KB project budget/.test(budgFlat), budgFlat.slice(0, 400));
  ok('...and says what actually happens: saved, and agents are handed up to the READING budget '
    + 'in reading order, the rest listed and fetched by name',
    /It will still be saved — agents are handed up to 120 KB of document text at session start, in reading order; every other document stays listed and is fetched by name when needed\./
      .test(budgFlat), budgFlat.slice(0, 600));
  ok('...and none of the three false claims survives: "reads in one call", "gets trimmed", "oldest-listed"',
    !/reads in one call|gets trimmed|oldest-listed/.test(budgFlat));
  // The reading budget is the PAYLOAD's: a project whose store reports 64 KB
  // is told 64 KB, so the day the store sends a project's own budget this
  // sentence follows with no view change.
  const ownBudget = factsOf([aDoc({ bytes: FI.FOUNDATIONS_BUDGET_BYTES })]);
  ownBudget.readFirstBudgetBytes = 64 * 1024;
  const budg64 = renderers.renderFoundationEditor(ownBudget).replace(/\s+/g, ' ');
  ok('...its reading-budget figure comes from the facts, not the view constant (64 KB here)',
    /handed up to 64 KB of document text/.test(budg64) && !/handed up to 120 KB/.test(budg64),
    budg64.slice(0, 600));

  // ── THE SHRINK STRIP ──────────────────────────────────────────────────
  setState({ activeDomain: 'acme', activeProject: 'lumina',
    fndEdit: anEdit({ loaded: 'x'.repeat(4096), text: 'x'.repeat(1000), confirmShrink: true }) });
  const shrink = renderers.renderFoundationEditor(facts);
  ok('the shrink strip names BOTH sizes', /4 KB/.test(shrink) && /1000 bytes/.test(shrink), shrink.slice(0, 200));
  ok('...and how much shorter, as the figure a person actually weighs',
    /% shorter/.test(shrink), shrink.slice(0, 400));
  ok('...says the save replaces rather than adds', /Saving replaces it/.test(shrink));
  ok('...and offers both ways out', /id="mem-fnd-shrink-go"/.test(shrink)
    && /id="mem-fnd-shrink-no"/.test(shrink));
  ok('...in flow, not in a dialog — the text the owner would lose stays on screen while they '
    + 'decide', !shrink.includes('<dialog'));
  // ── EXACTLY ONE PRIMARY, AND IT IS ALWAYS THE CONTROL THAT COMMITS
  //    (v3.61.0, P1-6) ──────────────────────────────────────────────────
  // The first cut left Save in place beside this strip, which gives the card
  // either two primaries or a DISABLED primary next to a live secondary that
  // actually writes — the tier-1 slot lying about itself. Save is WITHHELD
  // while the strip is up, not disabled: a disabled control still claims the
  // slot.
  ok('the strip\u2019s confirm is the card\u2019s ONE primary',
    (shrink.match(/btn-primary/g) || []).length === 1
    && /btn-primary btn-xs" id="mem-fnd-shrink-go"/.test(shrink), shrink.slice(0, 900));
  ok('...and Save is WITHHELD while it stands, not merely disabled',
    !/id="mem-fnd-save"/.test(shrink), shrink.slice(-800));
  ok('...and the confirm is labelled for what it does, not "Save anyway"',
    /Replace with the shorter version/.test(shrink));

  // ── THE DELETE STRIP ──────────────────────────────────────────────────
  setState({ activeDomain: 'acme', activeProject: 'lumina', fndEdit: anEdit({ confirmDelete: true }) });
  const del = renderers.renderFoundationEditor(facts);
  ok('the delete strip NAMES the document — "are you sure?" over six rows is a question about '
    + 'none of them', /architecture\.md/.test(del) && /Delete <b>/.test(del));
  ok('...says what it costs, in words',
    /removed from this project and from your agents\u2019 next session/.test(del), del.slice(0, 900));
  // ── AND WHAT RECOVERY THERE IS, BOTH HALVES ──────────────────────────
  // "It cannot be undone" alone is FALSE for a user with Personal Sync
  // configured and TRUE for everyone else, so both are stated rather than one
  // of them guessed at — the v3.9.1 finding, where a false safety promise
  // shipped at 14 sites on a page that DELETES.
  ok('...and that The Curator has no undo, while a git client may still have one',
    /cannot be undone from inside The Curator/.test(del) && /git client/.test(del), del.slice(0, 900));
  // ── THE ONE SANCTIONED USE OF THE FILLED DANGER FACE (v3.61.0, P1-5) ──
  // `.btn-danger-solid` is reserved by the taxonomy for a confirm whose
  // PRIMARY ACTION IS THE DELETION, which is exactly this strip: the question
  // has been asked, the document is named, and this is the control that
  // answers yes. The opener in the footer stays tinted.
  ok('the confirm uses the FILLED danger face, which is what a confirm whose '
    + 'primary action is the deletion is for',
  /btn-danger-solid btn-xs" id="mem-fnd-delete-go"/.test(del), del.slice(0, 900));
  ok('...labelled permanently, so the word matches the consequence',
    /Delete permanently<\/button>/.test(del), del.slice(0, 900));
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
  // ── A REAL BUTTON AND A `hidden` INPUT (v3.61.0, P1-7) ───────────────
  // A `.visually-hidden` input inside a `<label class="btn">` is focusable
  // while the thing that looks like a button is not, so focus lands on
  // something invisible and `--ring-focus` never paints.
  ok('...through a real <button> that clicks a `hidden` input',
    /<button type="button" class="btn btn-secondary btn-xs fnd-init-file" id="mem-fnd-file-btn"/.test(add)
    && /<input type="file" id="mem-fnd-file"[^>]* hidden/.test(add), add.slice(0, 1800));
  ok('...and NOT a label around a visually-hidden input',
    !/class="visually-hidden" id="mem-fnd-file"/.test(add));
  // ── AND THE OWNER'S WAY IN COMES FIRST (v3.61.0, P1-12) ──────────────
  // For the person who started a project here with no agent and no
  // repository, WRITING the document is the primary way in — and the order of
  // two equal-looking affordances is the only thing on screen that says so.
  ok('...and the sentence leads with the box rather than with the file',
    add.indexOf('Write the document in the box below') > 0
    && add.indexOf('Write the document in the box below') < add.indexOf('Choose a file'),
    add.slice(0, 1800));
  ok('...saying out loud that nothing is sent until the owner saves',
    /Nothing is sent until you\s+save|nothing is sent until you save/i.test(add.replace(/\s+/g, ' ')),
    add.slice(0, 1800));
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
  // ── THE PRIMARY IS THE HOST'S, AND IT NAMES THE STEP (v3.61.0, P2-6) ─
  // The shared chooser emits NO primary of its own, because the other host —
  // the "New project" form — already has one ("Create project") and a card
  // with two primaries has not decided what it is asking for. Here the commit
  // belongs to this block, so this block emits it, and it is labelled for the
  // STEP rather than for whichever arm happens to be selected: a label that
  // changes as the form is answered moves the control the person is aiming at.
  ok('...with the block\u2019s own commit, labelled for the step',
    /Set up documents<\/button>/.test(unchosen), unchosen.slice(-500));
  ok('...and exactly one primary on the card',
    (unchosen.match(/btn-primary/g) || []).length === 1, unchosen.slice(-700));
  // IRREVERSIBILITY NEVER FOLDS (§3.10): the store refuses a mismatch on every
  // later write, so the set-once clause is painted in flow above the chooser.
  ok('...and the set-once cost is stated unfolded, above the choice',
    /Set once — a project is mirrored or kept here, never both/.test(unchosen)
    && unchosen.indexOf('Set once') < unchosen.indexOf('data-fnd-own='), unchosen.slice(0, 500));
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
  // P1-9: the word is FOLDER. `resolveRepoRoot` requires only an absolute,
  // reachable DIRECTORY, so "repository" turns away everybody whose documents
  // live in ~/Documents/lumina-docs.
  ok('...labelled for what it does', /Add from folder<\/button>/.test(armOnly), armOnly.slice(-400));
  ok('...and its lede is an instruction, not a definition',
    /Point at the folder/.test(armOnly));
  ok('...and nothing in this arm says "repository"', !/repositor/i.test(armOnly), armOnly.slice(0, 900));
  // AND THE SET-ONCE CLAUSE IS WITHHELD HERE: the ownership is already
  // settled, so restating that it cannot be changed is a warning about a
  // decision nobody is about to take.
  ok('...and the set-once note is withheld, because the answer is already given',
    !/Set once/.test(armOnly));

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
    'Mirrored from the folder — edit it there, then refresh.');
  // ── THE OWNERSHIP FIELD THE ROUTE ACTUALLY SENDS (found in the BROWSER) ─
  // `GET …/foundations/:slug` does NOT send `ownership` — that is a property
  // of the MANIFEST — and the per-document fact it DOES send is
  // `source.kind`. Reading `doc.ownership` alone made the reader print the
  // MIRROR sentence over every curator-owned document in the app, and every
  // assertion here stayed green because the payloads written below carry a
  // field the real server never sends. So the REAL shape is driven first, and
  // the explicit form is driven after it as the thing that still wins.
  {
    const asRouteSends = renderers.foundationReaderContent({
      slug: 'architecture.md', title: 'Architecture', role: 'architecture',
      text: '# A', freshness: 'n/a', skeleton: true,
      source: { kind: 'curator' } }, 'lumina');
    eq('a payload in the ROUTE\'s real shape — source.kind and no ownership field — '
      + 'says where it IS edited, not that it is mirrored',
    asRouteSends.readonlyNote, 'Edit this in the Documents table behind this panel.');
    ok('...and its ownership chip agrees',
      asRouteSends.tags.includes('Curator-authored')
      && !asRouteSends.tags.includes('mirrored from a folder'),
    JSON.stringify(asRouteSends.tags));
    const repoShape = renderers.foundationReaderContent({
      slug: 'architecture.md', title: 'Architecture', role: 'architecture',
      text: '# A', freshness: 'fresh',
      source: { kind: 'repo', path: 'docs/architecture.md' } }, 'lumina');
    ok('CONTROL: the same shape with source.kind repo takes the mirror sentence',
      /Mirrored from the folder/.test(repoShape.readonlyNote), repoShape.readonlyNote);
  }
  const cur = renderers.foundationReaderContent({
    slug: 'architecture.md', title: 'Architecture', role: 'architecture',
    text: '# A', ownership: 'curator', freshness: 'n/a',
    source: { kind: 'curator', path: null } }, 'lumina');
  eq('a CURATOR-owned one points at the table it came from', cur.readonlyNote,
    'Edit this in the Documents table behind this panel.');
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
    // THE REAL REFUSAL VOCABULARY (v3.65.0). `initFoundations` maps a store
    // refusal code to a sentence naming the token's SOURCE before it prints
    // one; injected real rather than stubbed, because the whole property
    // under test is which words reach the screen.
    'MAX_FOUNDATION_BYTES', 'freshChooser', 'chooserBody', 'remoteRefusalText',
    'JSON', 'TextEncoder', body)(
    st,
    () => { calls.render++; },
    () => true,
    async (url, init) => { calls.urls.push(String(url)); calls.inits.push(init || null);
      return responder(String(url), init); },
    (d, p) => { calls.forgot.push(d + '/' + p); },
    async () => { calls.reloaded++; },
    async () => {},
    () => {},
    async (t, files, repoRoot) => { calls.refreshed++; calls.refreshFiles = files;
      calls.refreshRoot = repoRoot; },
    async () => ({ data: { scopes: [], brief: { present: false } } }),
    { getItem: () => null, setItem: () => {} },
    FI.FOUNDATION_ROLES, FI.FOUNDATION_SLUG_RE, FI.MAX_FOUNDATION_BYTES,
    FI.freshChooser, FI.chooserBody, FI.remoteRefusalText, JSON, TextEncoder);
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
  // THE SAME PROPERTY, THE NEW MECHANISM (v3.64.1). The force is a TRANSIENT
  // now: through v3.64.0 this press wrote `openFolds.foundations = true` and
  // PERSISTED it, so one Edit press marked the fold open on every later visit
  // and — with `renderFoundations` re-forcing `open` from `editing` on every
  // paint — the toggle listener recorded the forced value as the user's own,
  // which is the fold that reopened itself however often it was closed.
  eq('the fold is forced open, or the press would visibly do nothing',
    st.fndForceOpen, true);
  eq('...and the force does NOT touch the persisted preference',
    st.openFolds && st.openFolds.foundations !== undefined
      ? st.openFolds.foundations : '<absent>', '<absent>');
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
  // ── A REMOTE REFUSAL NAMES THE TOKEN'S SOURCE, NEVER THE TOKEN (v3.65.0)
  // The store answers a failed remote read with one of nine codes; printing
  // the code would show a person a word from a protocol. And the ONE thing a
  // view is in a position to get wrong here is putting a credential on
  // screen — so the sentence names the FILE and the assertion says so.
  {
    const r2 = writeRig(() => ({ ok: false, status: 403, json: async () => ({
      ok: false, error: 'unauthorised', message: 'unauthorised' }) }));
    r2.st.fndInit = { domain: 'acme', project: 'lumina', busy: false, error: null, refused: [],
      choice: { ...FI.freshChooser({}), ownership: 'remote', remote: 'o/r', tokenSource: 'sync',
        candidates: [{ path: 'a.md', bytes: 1, suggestedRole: 'other' }], picks: { 'a.md': true } } };
    await r2.api.initFoundations(1, { present: false, ownership: null });
    const msg = String(r2.st.fndInit && r2.st.fndInit.error);
    ok('a remote refusal is a SENTENCE, not the store\'s code',
      !/unauthorised$/.test(msg) && /refused by GitHub/.test(msg), msg);
    ok('...naming WHICH stored token was used', /Personal Sync’s token/.test(msg), msg);
    ok('...and the request carried the token SOURCE and no token',
      /"tokenSource":"sync"/.test(String(r2.calls.inits[0].body))
      && !/"token"/.test(String(r2.calls.inits[0].body)), String(r2.calls.inits[0].body));
    ok('...and the repository, as the store\'s own argument',
      /"remote":"o\/r"/.test(String(r2.calls.inits[0].body)), String(r2.calls.inits[0].body));
    // A CODE THIS TABLE DOES NOT KNOW falls back to the PRODUCER's message
    // rather than to a guess — the collapse this repo keeps paying for is a
    // consumer inventing an answer where the producer already gave one.
    const r3 = writeRig(() => ({ ok: false, status: 400, json: async () => ({
      ok: false, error: 'something_new', message: 'the producer said this' }) }));
    r3.st.fndInit = { domain: 'acme', project: 'lumina', busy: false, error: null, refused: [],
      choice: { ...FI.freshChooser({}), ownership: 'remote', remote: 'o/r',
        candidates: [{ path: 'a.md', bytes: 1, suggestedRole: 'other' }], picks: { 'a.md': true } } };
    await r3.api.initFoundations(1, { present: false, ownership: null });
    eq('an unrecognised code falls back to the producer\'s own sentence',
      String(r3.st.fndInit && r3.st.fndInit.error), 'the producer said this');
  }
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
    // v3.62.0: step ③'s two doors and the sidebar's pointer. `navigate` was
    // reached from `bindFoundationRows` before this release and is called
    // directly by `wire()` now; `requestDomain` and `goToChatScoped` are the
    // shell pair and the lifted chat wrapper. All three are stubbed in that
    // suite's PREAMBLE.
    'requestDomain', 'goToChatScoped', 'navigate',
    // ── v3.65.0, P10: step ③'s picker and its removes ─────────────────
    // ONE new name, and the arithmetic is the point: the wiring is a BINDER
    // (`bindKnowledgeRows`), exactly as tier 0's rows and the work-stream
    // table are, so `wire()` gains one free identifier rather than the three
    // it would gain by composing the cfg, mounting the component and calling
    // the save inline. One name is one stub in the companion suite's
    // preamble.
    'bindKnowledgeRows',
    // ── v3.65.0, R4: the step head ────────────────────────────────────
    // `renderProject` composes its three numbered steps through this view's
    // own `memStep` rather than through shared/block.js's `renderBlock`,
    // because that component emits its ⓘ INSIDE a lede and emits nothing at
    // all without one — and there is no lede on this page any more.
    'memStep',
    // ── v3.67.0: the fold binder left wire() unchanged, and the release's
    // own controls are bound in one place — both are in the stub set
    // test-agent-instructions.js needs (PATCH-v367-view-test-agent-instructions.diff).
    'bindFoldToggles', 'bindSessionAndPlan',
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
  // The EDITOR still invents no key: it joins the FOUNDATIONS fold that
  // already exists, which is what this assertion has always been about. The
  // list grew by one in v3.62.0 — `streams`, when the work-stream table became
  // a fold of its own inside step ② — and by one again in v3.63.0 — `capture`,
  // the honesty meter's session list inside the same step. Neither is the
  // editor's, which is the whole claim; the thing that must not move is the
  // localStorage KEY (`curator-memory-folds-v1`), which is the registry
  // scripts/test-ui-state.js holds and is untouched.
  const foldKeys = /const FOLD_KEYS = (\[[^\]]*\]);/.exec(viewSrc);
  eq('FOLD_KEYS carries the foundations fold the editor reuses, beside the '
    + 'other six, and no key of the editor\'s own',
  foldKeys && foldKeys[1].replace(/\s+/g, ''),
  // v3.67.0: step ④'s three rows (none of them the editor's).
  "['brief','journal','foundations','streams','capture','saved','knowledge','receives','window','reach']");
  ok('...and the localStorage key itself is unmoved, which is the registry that '
    + 'matters', /const FOLDS_KEY = 'curator-memory-folds-v1';/.test(viewSrc));
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — "COPY THE DRAFTING REQUEST", DRIVEN (v3.61.0, P2-8)');
// ═════════════════════════════════════════════════════════════════════════
//
// ── WHAT THIS SECTION IS FOR ────────────────────────────────────────────
// A curator-owned project with four skeletons is a project with four questions
// and no obvious way to get them answered. The owner can write them by hand
// (the editor above) or tell an agent to — and the second needs a sentence
// naming the tool, the project and the approval gate, which a user who has to
// compose it usually does not.
//
// The sentence has ONE source: `composeDraftingAsk` in
// shared/agent-instructions.js, sha-pinned there beside its three siblings and
// IMPORTED here rather than stubbed. A stub would let this suite agree that
// something was copied while the shipped control put the wrong text — or a
// second copy of the text — on the clipboard, which is this repository's most
// reliably recurring defect with model-read prose.
{
  const { composeDraftingAsk } = await import('../src/public/next/shared/agent-instructions.js');
  const rig = (clipboardOk, docs, over) => {
    const calls = { render: 0, clipboard: [] };
    const st = {
      activeDomain: 'acme', activeProject: 'lumina', copied: null,
      projectRead: { scopes: [], brief: { present: false }, foundations: {
        present: true, ownership: 'curator', budgetBytes: FI.FOUNDATIONS_BUDGET_BYTES,
        totalBytes: 0, documents: docs, orphanFiles: [], manifestError: null, ...(over || {}) } },
    };
    const body =
      extractFunction(viewSrc, 'skeletonOf') + '\n' +
      extractFunction(viewSrc, 'foundationsFacts') + '\n' +
      extractFunction(viewSrc, 'copyDraftingAsk') + '\n' +
      'return { copyDraftingAsk };';
    // eslint-disable-next-line no-new-func
    const api = new Function('state', 'render', 'isCurrentMount', 'navigator',
      // `READ_FIRST_BUDGET_BYTES` travels with `foundationsFacts` (v3.62.0):
      // it is the fallback the facts use when the server sends no
      // `readFirstBudgetBytes`, and an undefined identifier there is a CRASH
      // rather than a failing assertion.
      'composeDraftingAsk', 'FOUNDATIONS_BUDGET_BYTES', 'READ_FIRST_BUDGET_BYTES', body)(
      st,
      () => { calls.render++; },
      () => true,
      { clipboard: { writeText: async (t) => {
        if (!clipboardOk) throw new Error('denied');
        calls.clipboard.push(t);
      } } },
      composeDraftingAsk, FI.FOUNDATIONS_BUDGET_BYTES, READ_FIRST_BUDGET_SRC);
    return { api, st, calls };
  };
  const skel = (slug, role) => ({ slug, role, title: role, bytes: 100, skeleton: true,
    freshness: 'n/a', source: { kind: 'curator', path: null } });
  const done = (slug, role) => ({ ...skel(slug, role), skeleton: false });

  {
    // ── THE DOCUMENTS IT NAMES ARE THE PROJECT'S OWN (Q8) ───────────────
    // Three skeletons, so the sentence asks for three. A fixed guess at four
    // would send an agent looking for a document that does not exist, and the
    // whole point of composing from the manifest is that it cannot.
    const { api, st, calls } = rig(true, [
      skel('architecture.md', 'architecture'),
      skel('decisions.md', 'decisions'),
      skel('roadmap.md', 'roadmap'),
      done('conventions.md', 'conventions'),
    ]);
    await api.copyDraftingAsk(1);
    eq('one thing reached the clipboard', calls.clipboard.length, 1);
    eq('...and it is EXACTLY what the one shared composer produces for the '
      + 'project\u2019s UNFILLED documents — never a second copy of the sentence',
    calls.clipboard[0], composeDraftingAsk({ domain: 'acme', project: 'lumina', documents: [
      { slug: 'architecture.md', role: 'architecture', title: 'architecture' },
      { slug: 'decisions.md', role: 'decisions', title: 'decisions' },
      { slug: 'roadmap.md', role: 'roadmap', title: 'roadmap' },
    ] }));
    ok('...naming the three unfilled ones and NOT the written one',
      /architecture, decisions and roadmap/.test(calls.clipboard[0])
      && !/conventions/.test(calls.clipboard[0]), calls.clipboard[0]);
    ok('...and the tool, so an agent knows what to call', /save_foundation/.test(calls.clipboard[0]));
    ok('...and the approval gate', /Show me each document before saving/.test(calls.clipboard[0]));
    // STAMPED with the pair it was pressed on, and with the KIND, so the
    // confirmation cannot describe the other copy control's text.
    eq('the outcome is stamped with the domain', st.copied.domain, 'acme');
    eq('...and the project', st.copied.project, 'lumina');
    eq('...and the KIND, so one confirmation cannot describe two different texts',
      st.copied.kind, 'draft');
    eq('...and records that it worked', st.copied.ok, true);
    ok('...and the page repainted to show it', calls.render >= 1);
  }
  {
    // EVERY DOCUMENT WRITTEN: asking for a rewrite of a NAMED set is
    // legitimate, and asking for a rewrite of "the foundations" is not
    // actionable — so the written ones are named rather than nothing.
    const { api, calls } = rig(true, [done('architecture.md', 'architecture')]);
    await api.copyDraftingAsk(1);
    ok('with everything written, the named set is the written documents',
      /architecture/.test(calls.clipboard[0]), calls.clipboard[0]);
  }
  {
    // NO DOCUMENTS AT ALL: the composer's own fallback names the four default
    // roles a seeded project carries, which is the right answer for a project
    // whose owner unticked the seeding — and it is the COMPOSER's decision,
    // not a second one taken here.
    const { api, calls } = rig(true, []);
    await api.copyDraftingAsk(1);
    eq('an empty project defers to the composer\u2019s own fallback',
      calls.clipboard[0], composeDraftingAsk({ domain: 'acme', project: 'lumina', documents: [] }));
  }
  {
    // ── A CLIPBOARD REFUSAL PRINTS THE TEXT (never a button that silently
    //    did nothing) ──────────────────────────────────────────────────────
    const { api, st, calls } = rig(false, [skel('architecture.md', 'architecture')]);
    await api.copyDraftingAsk(1);
    eq('nothing reached the clipboard', calls.clipboard.length, 0);
    eq('...the outcome records the refusal rather than swallowing it', st.copied.ok, false);
    ok('...and KEEPS the text, so the refusal can hand it over to be selected by hand',
      typeof st.copied.text === 'string' && /save_foundation/.test(st.copied.text),
      String(st.copied.text).slice(0, 120));
    eq('...still stamped as the drafting request', st.copied.kind, 'draft');
  }
  {
    // ── THE COMPOSER REFUSES AN EMPTY PROJECT, AND NOTHING IS CLAIMED ────
    // `composeDraftingAsk` THROWS rather than composing a sentence telling an
    // agent to save into a project that cannot exist. Reaching that means the
    // view is painting a project it has no name for, which is a bug
    // elsewhere — so nothing is copied and no outcome is recorded.
    const { api, st, calls } = rig(true, [skel('architecture.md', 'architecture')]);
    st.activeProject = '';
    await api.copyDraftingAsk(1);
    eq('nothing is copied', calls.clipboard.length, 0);
    eq('...and no outcome is invented', st.copied, null);
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§11 — THE FILE BUTTON REALLY OPENS THE HIDDEN INPUT (P1-7)');
// ═════════════════════════════════════════════════════════════════════════
//
// A `hidden` input is out of the tab order AND unclickable by the user, so the
// whole arrangement rests on ONE line: the button's handler calling `.click()`
// on it. Asserting the markup proves the input is hidden; only DRIVING the
// handler proves it can still be reached — and a lost click there is a picker
// that is simply gone, with every markup assertion above it green.
//
// A DOM MODEL, not jsdom (this repo ships zero devDeps): `bindFoundationsChooser`
// takes its `doc` as an argument precisely so it can be driven against one.
{
  const clicks = [];
  const mk = (id, extra) => ({
    id, _l: {}, dataset: {}, files: null, disabled: false, value: '',
    addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    fire(t, ev) { (this._l[t] || []).forEach((fn) => fn(ev || {})); },
    click() { clicks.push(id); this.fire('click', {}); },
    getAttribute() { return null; },
    ...extra,
  });
  const byId = {};
  const doc = {
    getElementById: (i) => byId[i] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  byId['fnd-init-files'] = mk('fnd-init-files');
  byId['fnd-init-files-btn'] = mk('fnd-init-files-btn');
  const choice = FI.freshChooser({});
  FI.bindFoundationsChooser({ doc, id: 'fnd-init', choice, onChange: () => {} });
  ok('SETUP: the button\u2019s click handler was bound at all',
    (byId['fnd-init-files-btn']._l.click || []).length === 1,
    JSON.stringify(Object.keys(byId['fnd-init-files-btn']._l)));
  byId['fnd-init-files-btn'].fire('click');
  ok('pressing the button clicks the hidden input — the one line the whole '
    + '`hidden`-plus-<button> arrangement rests on',
  clicks.includes('fnd-init-files'), JSON.stringify(clicks));
  // AND IT IS DEFENSIVE about a host that has no `.click`: the same binder
  // runs against a DOM model in a suite and a real document in a browser.
  const clicks2 = [];
  const byId2 = { 'fnd-init-files': { addEventListener() {} },
    'fnd-init-files-btn': mk('fnd-init-files-btn') };
  FI.bindFoundationsChooser({ doc: { getElementById: (i) => byId2[i] || null,
    querySelector: () => null, querySelectorAll: () => [] },
  id: 'fnd-init', choice, onChange: () => {} });
  let threw = null;
  try { byId2['fnd-init-files-btn'].fire('click'); } catch (err) { threw = err; }
  ok('...and an input with no `.click` is a no-op rather than a throw',
    !threw, threw ? threw.message : 'ok');
}

// ═════════════════════════════════════════════════════════════════════════
section('§12 — v3.61.1: THE RHYTHM, THE PICKER, THE DEFAULT TICKS, THE AGE');
// ═════════════════════════════════════════════════════════════════════════
//
// Everything in this section answers one of the maintainer's five reports on
// the shipped v3.61.0 block. They are pinned here, in the module's own suite,
// because every one of them is a property of the SHARED chooser and therefore
// of both hosts.
{
  // ── (1) THE ARM IS A GROUP, WITH ITS OWN INSTRUCTION ─────────────────
  // "very cramped together", with a screenshot of six items in one flat list
  // at one indent. The px rhythm is CSS and is measured in the browser pass;
  // what this suite can hold is the STRUCTURE the rhythm is applied to: the
  // arm's controls are inside `.fnd-init-arm`, and the arm opens with an
  // instruction rather than with a control.
  const cur = FI.renderFoundationsChooser({ id: 'x', choice: FI.freshChooser({}) });
  const armOf = (html) => {
    const i = html.indexOf('<div class="fnd-init-arm">');
    return i < 0 ? '' : html.slice(i);
  };
  ok('the CURATOR arm holds its seed tick and its file row',
    /class="fnd-init-arm"/.test(cur) && /fnd-init-seed/.test(armOf(cur))
      && /fnd-init-file/.test(armOf(cur)), cur.slice(0, 200));
  ok('...and the option cards are OUTSIDE it, so the arm can be indented under the '
    + 'one that opened it', cur.indexOf('data-fnd-own=') < cur.indexOf('fnd-init-arm'));

  const repo = FI.renderFoundationsChooser({
    id: 'x', choice: { ...FI.freshChooser({}), ownership: 'repo' } });
  ok('the MIRROR arm opens with an instruction naming the two steps in order',
    /<p class="fnd-init-armhd">Point at the folder, then tick the documents to copy\.<\/p>/
      .test(repo), armOf(repo).slice(0, 200));
  {
    const txt = /<p class="fnd-init-armhd">([^<]*)</.exec(repo)[1];
    const words = txt.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    ok('...at most 13 visible words (' + words.length + ')', words.length <= 13, txt);
  }

  // ── (2) THE FILE HINT IS A ONE-LINE NOTE, AND THE MECHANICS MOVED ────
  ok('the curator arm’s hint is a .tx-note, not a paragraph beside the button',
    /class="tx-note fnd-init-why"><span>Optional/.test(cur), cur.slice(-600));
  {
    const txt = /class="tx-note fnd-init-why"><span>([^<]*)</.exec(cur)[1];
    const words = txt.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    ok('...of at most 13 visible words (' + words.length + '): ' + txt, words.length <= 13);
  }
  ok('...and the 22-word version is gone — "read on this computer" and "each file becomes '
    + 'one document" are mechanism and live in the hosts’ ⓘ',
  !/read on this computer/.test(cur) && !/Each file becomes one document/.test(cur),
  cur.slice(-600));

  // ── (3) THE NATIVE FOLDER PICKER ─────────────────────────────────────
  ok('the mirror arm offers a folder picker beside the typed field',
    /class="btn btn-secondary btn-xs fnd-init-pick" id="x-pick"/.test(repo), armOf(repo).slice(0, 700));
  ok('...and the typed field stays, as the fallback that always works',
    /id="x-root"/.test(repo));
  const noDialog = FI.renderFoundationsChooser({
    id: 'x', choice: { ...FI.freshChooser({}), ownership: 'repo',
      pickUnavailable: 'This build cannot open a folder picker (no desktop bridge).' } });
  ok('WITHHELD WITH ITS REASON where there is no picker — never silently absent (v3.16.1)',
    !/fnd-init-pick/.test(noDialog)
      && /This build cannot open a folder picker/.test(noDialog), noDialog.slice(0, 900));
  const picking = FI.renderFoundationsChooser({
    id: 'x', choice: { ...FI.freshChooser({}), ownership: 'repo', picking: true } });
  ok('...and while the dialog is open the control says so and is disabled',
    /id="x-pick" disabled>Choosing…</.test(picking), picking.slice(0, 900));

  // THE CLIENT half, against a fake fetch. Four answers, keyed on `reason`.
  {
    const call = async (status, body) => FI.pickFolder(async () => ({
      ok: status < 400, status, json: async () => body }));
    const a = await call(200, { ok: true, path: '  /Users/x/p  ' });
    ok('pickFolder: a path comes back trimmed', a.ok && a.path === '/Users/x/p', JSON.stringify(a));
    const b = await call(200, { ok: false, reason: 'cancelled' });
    eq('pickFolder: a cancel is a cancel', b.reason, 'cancelled');
    const c = await call(501, { ok: false, reason: 'no-dialog', message: 'no bridge', hint: 'type it' });
    ok('pickFolder: 501 is the one answer that withholds the button, and it carries the words',
      c.reason === 'no-dialog' && /no bridge type it/.test(c.message), JSON.stringify(c));
    const d = await call(500, { ok: false, reason: 'failed', message: 'boom' });
    eq('pickFolder: anything else is a FAILED ATTEMPT, which must not delete a control that '
      + 'works for other people', d.reason, 'failed');
    // A ROUTE THAT IS NOT THERE (an older server) is a failure, not a verdict
    // about this build — except for the 501 the route itself answers with.
    const e = await FI.pickFolder(async () => ({ ok: false, status: 404, json: async () => { throw new Error('html'); } }));
    eq('pickFolder: a 404 from an older server is `failed`, not `no-dialog`', e.reason, 'failed');
    const f = await FI.pickFolder(async () => { throw new Error('offline'); });
    eq('pickFolder: a throwing fetch never escapes', f.reason, 'failed');
  }

  // ── (4) THE DEFAULT TICKS: NONE (v3.65.3) ────────────────────────────
  //
  // v3.61.0 ticked all 25 candidates on the maintainer's repository (1,875 KB
  // against 200 KB); v3.61.1 ticked the four canonical roles; the remote arm
  // kept that rule and a real repository whose files all sit under
  // documentation/architecture/ arrived 22 of 32 ticked, 2,351 KB. Now every
  // scan starts with nothing ticked. `untickedPicks` is the one rule.
  eq('a fresh scan\u2019s picks are EMPTY', JSON.stringify(FI.untickedPicks()), '{}');
  ok('...a new object each time, so one chooser\u2019s ticks never leak into another\u2019s',
    FI.untickedPicks() !== FI.untickedPicks());
  ok('the role-based tick rule is gone from the module, not merely unused',
    FI.defaultPicks === undefined && FI.DEFAULT_TICK_ROLES === undefined
      && FI.ticksByDefault === undefined);

  // ── (5) THE RUNNING TOTAL AND THE BUDGET ─────────────────────────────
  {
    const c = { ...FI.freshChooser({}), ownership: 'repo',
      candidates: [{ path: 'a.md', bytes: 120 * 1024, suggestedRole: 'architecture' },
        { path: 'b.md', bytes: 90 * 1024, suggestedRole: 'decisions' },
        { path: 'big.md', bytes: 900000, suggestedRole: 'other', tooLarge: true }],
      picks: { 'a.md': true } };
    eq('the total counts the ticked candidates and nothing else',
      FI.tickedBytes(c), 120 * 1024);
    ok('the count line reads ticks, bytes and the budget in one line',
      FI.countLineText(c) === '1 of 2 ticked · 120 KB of a 200 KB budget', FI.countLineText(c));
    eq('...and under the budget there is no warning', FI.budgetWarning(c), '');
    c.picks['b.md'] = true;
    eq('a second tick crosses the budget', FI.tickedBytes(c), 210 * 1024);
    ok('...and the warning names what an agent will actually receive',
      /^Over the 200 KB project budget\. Agents are handed up to 120 KB of document text at session start/
        .test(FI.budgetWarning(c)), FI.budgetWarning(c));
    // A TYPED EXTRA HAS NO SIZE, so it is disclosed rather than counted as 0 —
    // the figure would otherwise read as a measurement when it is a floor.
    c.extras = [{ path: 'notes/x.md', role: 'other' }];
    ok('a typed path is disclosed beside the figure, never counted as zero bytes',
      /1 added by path, size not known yet/.test(FI.countLineText(c)), FI.countLineText(c));
    eq('...and does not move the byte total', FI.tickedBytes(c), 210 * 1024);
  }

  // ── (6) THE REASON A CONTROL IS OFF ──────────────────────────────────
  eq('with no folder named, the scan’s reason is the sentence that arms it',
    FI.scanBlockedReason({ repoRoot: '' }), 'Type or choose the folder first.');
  eq('...and nothing once one is', FI.scanBlockedReason({ repoRoot: '/r' }), '');
  eq('...and nothing WHILE a scan is running, where the control says "Looking…" instead',
    FI.scanBlockedReason({ repoRoot: '', scanning: true }), '');
  ok('the note is EMITTED and `hidden`, so the field’s own input handler can reveal it '
    + 'without a render taking the caret',
  /<div class="tx-note fnd-init-why" id="x-why"><span>Type or choose the folder first\./
    .test(repo), armOf(repo).slice(0, 900));
  {
    const armed = FI.renderFoundationsChooser({
      id: 'x', choice: { ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r' } });
    ok('...and is present-but-hidden once the field is filled',
      /id="x-why" hidden><span><\/span>/.test(armed), armOf(armed).slice(0, 900));
  }
  // THE COMMIT'S OWN REASON, which is the host's control and the module's rule.
  {
    const c = { ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r' };
    eq('BEFORE a scan, pointing at a folder is a complete answer — documents can be added later',
      FI.commitBlockedReason(c), '');
    c.candidates = [{ path: 'a.md', bytes: 10, suggestedRole: 'architecture' }];
    eq('AFTER a scan with nothing ticked, the commit says why it is off',
      FI.commitBlockedReason(c), 'Tick at least one document.');
    c.picks = { 'a.md': true };
    eq('...and goes quiet when something is', FI.commitBlockedReason(c), '');
    c.picks = {};
    c.extras = [{ path: 'notes/x.md', role: 'other' }];
    eq('a typed path counts as a document, so the reason lifts', FI.commitBlockedReason(c), '');
    eq('the curator arm never carries this reason — it has nothing to tick',
      FI.commitBlockedReason({ ...FI.freshChooser({}), ownership: 'curator' }), '');
  }

  // ── (7) THE ROLE CHIPS BELONG TO THE TYPED-PATH FIELD ────────────────
  const scanned2 = FI.renderFoundationsChooser({ id: 'x', choice: {
    ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r',
    candidates: [{ path: 'docs/a.md', bytes: 10, suggestedRole: 'architecture' }],
    picks: { 'docs/a.md': true } } });
  ok('the seven chips sit INSIDE the typed-path group, behind the word "as"',
    /<div class="fnd-init-extra-as" id="x-extra-as" hidden><span class="fnd-init-as-word">as<\/span>/
      .test(scanned2), scanned2.slice(-900));
  ok('...hidden while the field is empty, because there is no file to give a role to',
    /id="x-extra-as" hidden/.test(scanned2));
  {
    const drafted = FI.renderFoundationsChooser({ id: 'x', choice: {
      ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r', extraPath: 'notes/x.md',
      candidates: [], picks: {} } });
    ok('...and shown once it has text', /id="x-extra-as"><span/.test(drafted), drafted.slice(-700));
  }
  ok('a CANDIDATE row keeps its own role control, which is a different question',
    /data-fnd-role-open="docs\/a\.md"/.test(scanned2));

  // ── (8) THE LIST IS THE ARM'S MAIN CONTENT, UNDER ONE INSTRUCTION ────
  // v3.65.2: the heading TELLS THE TRUTH. It said "Tick the documents an agent
  // must read first." — but a tick COPIES; "read first" is a separate flag set
  // per row in the documents table afterwards, and `pickedFiles` sends none.
  ok('the candidate list is introduced by what a tick MEANS — a copy',
    /<p class="fnd-init-listhd">Tick the files to copy into this project\.<\/p>/
      .test(scanned2), scanned2.slice(0, 1400));
  ok('...and nothing on the arm says a tick means "read first" any more',
    !/an agent must read first/.test(scanned2));
  ok('...above the list itself', scanned2.indexOf('fnd-init-listhd') < scanned2.indexOf('fnd-init-cands'));

  // ── (9) THE SOURCE FILE'S AGE, ON THE SHARED SCALE ───────────────────
  {
    const iso = new Date(Date.now() - 3 * 86400 * 1000).toISOString();
    const html = FI.candidateAgeHtml(iso);
    ok('an age carries the shared dot AND the word — colour is never the only signal',
      /class="fresh-dot fresh-week"/.test(html) && /3 days ago/.test(html), html);
    ok('...on the hook tickAges walks, so a picker left open does not drift',
      html.includes('data-mem-age-at="' + iso + '"'), html);
    ok('...inside a wrapper of this component’s own, because shared/freshness.css owns the '
      + '`fresh-` prefix outright', /class="fnd-init-cand-age"/.test(html), html);
    eq('no timestamp renders NOTHING rather than a dashed ring beside the word "unknown"',
      FI.candidateAgeHtml(null), '');
    eq('...and so does a string that is not a date', FI.candidateAgeHtml('not-a-date'), '');
    const row = FI.renderFoundationsChooser({ id: 'x', choice: {
      ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r',
      candidates: [{ path: 'docs/a.md', bytes: 10, suggestedRole: 'architecture', modifiedAt: iso }],
      picks: {} } });
    ok('a candidate row shows it', /fnd-init-cand-age/.test(row) && /3 days ago/.test(row),
      row.slice(0, 1600));
    // SORTED AS BEFORE. The maintainer asked to SEE the age, not to have the
    // rows rearranged by it — the store sorts by role rank then path and this
    // component must not re-sort.
    const two = FI.renderFoundationsChooser({ id: 'x', choice: {
      ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r',
      candidates: [
        { path: 'docs/architecture.md', bytes: 1, suggestedRole: 'architecture',
          modifiedAt: new Date(Date.now() - 400 * 86400 * 1000).toISOString() },
        { path: 'docs/decisions.md', bytes: 1, suggestedRole: 'decisions',
          modifiedAt: new Date(Date.now() - 60 * 1000).toISOString() }],
      picks: {} } });
    ok('...and the OLDEST document still comes first when its role ranks first — the rows are '
      + 'not re-sorted by age',
    two.indexOf('docs/architecture.md') < two.indexOf('docs/decisions.md'));
  }

  // ── (10) THE STORE AND THE ROUTE REALLY SEND IT ──────────────────────
  // The field is mirrored from `scanRepoForFoundations`, so a copy that drifts
  // renders an age for a value nobody sends. Checked against the two files
  // rather than trusted.
  ok('the store’s scan records the source file’s mtime as `modifiedAt`',
    /modifiedAt: st\.mtime && Number\.isFinite\(st\.mtime\.getTime\(\)\)/.test(storeSrc),
    'src/brain/working-state.js');
  {
    const routeSrc = readFileSync(join(ROOT, 'src/routes/memory.js'), 'utf8');
    const i = routeSrc.indexOf("router.get('/repo-scan'");
    const seg = routeSrc.slice(i, i + 3000);
    ok('...and the route forwards it through its per-field allow-list, never a spread',
      /modifiedAt: typeof c\.modifiedAt === 'string'/.test(seg) && !/\.\.\.c[,\s}]/.test(seg),
      seg.slice(0, 200));
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§13 — v3.61.1: THE PICK BUTTON, WIRED (fill the field, then scan)');
// ═════════════════════════════════════════════════════════════════════════
{
  // One gesture: somebody who has just chosen a folder in a dialog has
  // answered "which folder", and a second button press to find out what is in
  // it is the step that made the arm read as having no scan at all.
  const choice = FI.freshChooser({});
  choice.ownership = 'repo';
  let renders = 0;
  const mk = () => ({ dataset: {}, disabled: false, value: '', hidden: false, _l: {},
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    fire(t, e) { (this._l[t] || []).forEach((f) => f(e || {})); },
    querySelector: () => null, setAttribute() {} });
  const pick = mk();
  const scan = mk();
  const rootEl = mk();
  const byId = { 'x-pick': pick, 'x-scan': scan, 'x-root': rootEl };
  const urls = [];
  const doc = { getElementById: (i) => byId[i] || null,
    querySelector: () => null, querySelectorAll: () => [] };
  FI.bindFoundationsChooser({ doc, id: 'x', choice, onChange: () => { renders++; },
    fetchImpl: async (url, opts) => {
      urls.push(url);
      if (String(url).indexOf('/api/config/pick-path') === 0) {
        ok('the pick request names the prompt by KEY, never by sentence — the route’s repo '
          + 'arm interpolates it into a shell command',
        /"prompt":"foundations"/.test(String(opts && opts.body)), String(opts && opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true, path: '/Users/x/p' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, root: '/Users/x/p',
        truncated: false, candidates: [
          { path: 'docs/architecture.md', bytes: 10, suggestedRole: 'architecture' },
          { path: 'README.md', bytes: 10, suggestedRole: 'guide' }] }) };
    } });
  pick.fire('click');
  await new Promise((r) => setTimeout(r, 5));
  eq('picking fills the field', choice.repoRoot, '/Users/x/p');
  ok('...and runs the scan in the same gesture',
    urls.some((u) => String(u).indexOf('/api/memory/repo-scan') === 0), JSON.stringify(urls));
  eq('...finding what is there', (choice.candidates || []).length, 2);
  ok('...with NOTHING ticked, not even the canonical-role candidate (v3.65.3)',
    JSON.stringify(choice.picks) === '{}', JSON.stringify(choice.picks));

  // NO DIALOG: the fact is recorded so the renderer can withhold the control.
  const c2 = FI.freshChooser({});
  c2.ownership = 'repo';
  const pick2 = mk();
  FI.bindFoundationsChooser({ doc: { getElementById: (i) => ({ 'x-pick': pick2 }[i] || null),
    querySelector: () => null, querySelectorAll: () => [] },
  id: 'x', choice: c2, onChange: () => {},
  fetchImpl: async () => ({ ok: false, status: 501,
    json: async () => ({ ok: false, reason: 'no-dialog', message: 'no bridge here' }) }) });
  pick2.fire('click');
  await new Promise((r) => setTimeout(r, 5));
  ok('a build with no picker records the REASON, which is what withholds the button',
    /no bridge here/.test(String(c2.pickUnavailable)), String(c2.pickUnavailable));
  eq('...and nothing was typed into the field on its behalf', c2.repoRoot, '');
  eq('...and no failure is reported, because this is not one', c2.pickError, null);

  // A CANCEL SAYS NOTHING AT ALL.
  const c3 = FI.freshChooser({});
  c3.ownership = 'repo';
  const pick3 = mk();
  FI.bindFoundationsChooser({ doc: { getElementById: (i) => ({ 'x-pick': pick3 }[i] || null),
    querySelector: () => null, querySelectorAll: () => [] },
  id: 'x', choice: c3, onChange: () => {},
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, reason: 'cancelled' }) }) });
  pick3.fire('click');
  await new Promise((r) => setTimeout(r, 5));
  ok('a dismissed dialog leaves no error, no path and no withheld control',
    c3.pickError === null && c3.pickUnavailable === null && c3.repoRoot === '' && c3.picking === false,
    JSON.stringify({ e: c3.pickError, u: c3.pickUnavailable, r: c3.repoRoot, p: c3.picking }));
}

// ═════════════════════════════════════════════════════════════════════════
section('§14 — EVERY `hidden` ELEMENT THIS MODULE EMITS REALLY HIDES');
// ═════════════════════════════════════════════════════════════════════════
//
// ── THE DEFECT CLASS (design-system §9, v3.56.0) ────────────────────────
// `[hidden] { display: none }` lives in the USER-AGENT stylesheet, and an
// author rule beats a UA rule at every specificity. So the moment a class on
// an element declares `display`, the `hidden` attribute stops doing anything —
// the element is visible in every state it will ever have, and every markup
// assertion about it stays GREEN, because the markup was never wrong.
//
// This module leans on that attribute three times, and it has to: each of
// those elements sits beside a field that writes into state WITHOUT a render
// (a render rebuilds the input and takes the caret with it), so the only way
// they appear and disappear is a binder toggling `hidden` on the live node.
//
// A mutation removing the counter-rule was GREEN against every other suite in
// this repository, which is what this section is for. It is written as a
// MEASUREMENT rather than a list of three class names: every element the
// module renders with a `hidden` attribute is found in the OUTPUT, each of its
// classes is looked up in the real stylesheets, and if any of them declares
// `display` then one of them must also carry a `[hidden]` counter-rule.
{
  const cssFiles = {
    'shared/foundations-init.css': readFileSync(join(NEXT, 'shared/foundations-init.css'), 'utf8'),
    'shared/text.css': readFileSync(join(NEXT, 'shared/text.css'), 'utf8'),
  };
  const allCss = Object.values(cssFiles).join('\n');
  // Does any STATELESS rule for `.cls` declare `display`? Stateless, because a
  // `display` inside `.cls[hidden]` or `.cls:empty` is the counter-rule itself
  // or a state, not the thing that defeats the attribute.
  const declaresDisplay = (cls) => {
    const re = new RegExp('(^|[\\s,])\\.' + cls.replace(/[-]/g, '\\-') + '(?![\\w-])([^{,]*)\\{([^}]*)\\}', 'g');
    let m;
    while ((m = re.exec(allCss))) {
      const between = m[2] || '';
      if (/\[|:/.test(between)) continue;            // a state or an attribute selector
      if (/(^|;|\s)display\s*:/.test(m[3])) return true;
    }
    return false;
  };
  const hasCounterRule = (cls) => new RegExp('\\.' + cls.replace(/[-]/g, '\\-')
    + '\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none').test(allCss);

  // Every state this module can render, so the sweep sees every hidden element
  // it is capable of emitting rather than the ones one fixture happens to hit.
  const states = [
    FI.renderFoundationsChooser({ id: 'h', choice: FI.freshChooser({}) }),
    FI.renderFoundationsChooser({ id: 'h', choice: FI.freshChooser({ allowLater: true }) }),
    FI.renderFoundationsChooser({ id: 'h', choice: { ...FI.freshChooser({}), ownership: 'repo' } }),
    FI.renderFoundationsChooser({ id: 'h', choice: { ...FI.freshChooser({}), ownership: 'repo',
      repoRoot: '/r', extraPath: 'notes/x.md',
      candidates: [{ path: 'a.md', bytes: 10, suggestedRole: 'architecture' }], picks: {} } }),
  ];
  let checked = 0;
  const seen = new Set();
  for (const html of states) {
    for (const tag of html.match(/<div[^>]*\shidden[^>]*>/g) || []) {
      const cls = (/class="([^"]*)"/.exec(tag) || ['', ''])[1].split(/\s+/).filter(Boolean);
      const key = cls.join(' ');
      if (!cls.length || seen.has(key)) continue;
      seen.add(key);
      const needs = cls.filter(declaresDisplay);
      if (!needs.length) continue;
      checked++;
      ok('`hidden` really hides <div class="' + key + '"> — one of its classes carries the '
        + '[hidden] counter-rule that `display: ' + '…' + '` on ' + JSON.stringify(needs)
        + ' would otherwise defeat',
      cls.some(hasCounterRule), 'declares display: ' + JSON.stringify(needs));
    }
  }
  // WITHOUT THIS CONTROL the sweep above is satisfied by finding nothing —
  // which is exactly what a renderer that stopped emitting `hidden` elements
  // would produce, and that is a change this section must not bless silently.
  ok('CONTROL: the sweep really found `hidden` elements whose classes set `display` ('
    + checked + ')', checked >= 2, String(checked));
  // AND THE MEASUREMENT ITSELF IS NOT VACUOUS: a class nobody gave a
  // counter-rule must be reported as missing one.
  ok('CONTROL: `hasCounterRule` says NO for a class that has none',
    !hasCounterRule('fnd-init-opt'), 'fnd-init-opt');
  ok('CONTROL: `declaresDisplay` finds the `display` on .tx-note, which is what makes the '
    + 'counter-rule necessary in the first place', declaresDisplay('tx-note'));
}

// ═════════════════════════════════════════════════════════════════════════
section('§15 — v3.65.0: THE GITHUB ARM (record §D.7)');
// ═════════════════════════════════════════════════════════════════════════
//
// THE GAP IT CLOSES, in the store's own words: `initFoundations` refused
// anything that was not an absolute path on THIS machine, so a computer with
// no checkout could REFRESH a mirror somebody else started and could never
// START one. The maintainer asked for it twice.
//
// THE ONE THING A VIEW IS IN A POSITION TO GET WRONG HERE is putting a
// credential on screen or on the wire, so that is what most of this section
// is about. Every arm is driven with `fetch` intercepted; nothing reaches the
// network.
{
  const remoteChoice = (over) => ({ ...FI.freshChooser({ allowLater: true }),
    ownership: 'remote', ...over });

  // ── THE BODY ──────────────────────────────────────────────────────────
  eq('a remote mirror is still `ownership: repo` — the store keeps ONE '
    + 'ownership per project and a remote mirror IS a mirror',
  JSON.stringify(FI.chooserBody(remoteChoice({ remote: 'o/r' }))),
  JSON.stringify({ ownership: 'repo', tokenSource: 'config', remote: 'o/r' }));
  ok('...and it carries NO repoRoot — the store refuses the two together by '
    + 'name, because a mirror has one source',
  !('repoRoot' in FI.chooserBody(remoteChoice({ remote: 'o/r', repoRoot: '/x' }))));
  eq('a ref or a path makes `remote` the OBJECT the store also accepts',
    JSON.stringify(FI.chooserBody(remoteChoice({ remote: 'o/r', remoteRef: 'main',
      remotePath: 'docs/' })).remote),
    JSON.stringify({ owner: 'o', repo: 'r', ref: 'main', path: 'docs/' }));
  ok('...and a URL form is handed over UNPARSED rather than guessed at',
    FI.chooserBody(remoteChoice({ remote: 'https://github.com/o/r.git', remoteRef: 'v2' }))
      .remote.repo === 'https://github.com/o/r.git');
  eq('an absent ref and an absent path are OMITTED, never sent empty — the '
    + 'store reads absent as "the default branch" and "the whole repository"',
  JSON.stringify(FI.chooserBody(remoteChoice({ remote: 'o/r', remoteRef: '', remotePath: '' }))),
  JSON.stringify({ ownership: 'repo', tokenSource: 'config', remote: 'o/r' }));
  eq('with no repository named there is no body at all', FI.chooserBody(remoteChoice({})), null);
  eq('the token SOURCE rides, filtered to the two the store names',
    FI.chooserBody(remoteChoice({ remote: 'o/r', tokenSource: 'sync' })).tokenSource, 'sync');
  eq('...and an unknown word becomes `config` rather than being sent — the '
    + 'store REFUSES an unrecognised one and this call records a decision',
  FI.chooserBody(remoteChoice({ remote: 'o/r', tokenSource: 'made-up' })).tokenSource, 'config');
  // THE ASSERTION THIS SECTION EXISTS FOR.
  // THE SAME PLANT ON THE BODY: a choice carrying a token must not put one on
  // the wire, and a fixture with no token could not tell the two apart.
  for (const c of [remoteChoice({ remote: 'o/r' }),
    remoteChoice({ remote: 'o/r', remoteRef: 'main', tokenSource: 'sync',
      token: 'ghp_PLANTED_SECRET_0000' })]) {
    ok('NO body from this arm carries a token, under any key or any value',
      !JSON.stringify(FI.chooserBody(c)).includes('"token"')
      && !/PLANTED|ghp_|github_pat/.test(JSON.stringify(FI.chooserBody(c))),
    JSON.stringify(FI.chooserBody(c)));
  }

  // ── THE MARKUP ────────────────────────────────────────────────────────
  const arm = FI.renderFoundationsChooser({ id: 'x',
    choice: remoteChoice({ remote: 'o/r', remoteRef: 'main' }) });
  ok('three fields: the repository, the ref and the folder',
    /id="x-remote"/.test(arm) && /id="x-remote-ref"/.test(arm) && /id="x-remote-path"/.test(arm),
    arm.slice(0, 900));
  ok('...and NO field for a token, in any shape at all',
    !/type="password"/.test(arm) && !/name="token"/.test(arm) && !/id="x-token"/.test(arm)
    && !/Paste/.test(arm), arm);
  ok('the token source is two radios naming two FILES',
    /data-fnd-token="config"/.test(arm) && /data-fnd-token="sync"/.test(arm), arm.slice(0, 1600));
  ok('...and the form says outright that the token is never typed here',
    /never typed here/.test(arm));
  ok('a blank ref and a blank folder say what blank MEANS rather than nothing',
    /placeholder="the default branch"/.test(arm) && /placeholder="the whole repository"/.test(arm),
    arm.slice(0, 1200));

  // ── THE DISABLED CONTROL STATES ITS REASON (v3.61.1's finding) ─────────
  eq('with nothing named, the scan says why it is off',
    FI.scanBlockedReason(remoteChoice({})), 'Name the repository first.');
  ok('...and with no read token on this build it says which one to add',
    /add one in Settings/.test(FI.scanBlockedReason(
      remoteChoice({ remote: 'o/r', hasReadToken: false }))));
  ok('...and Personal Sync not being connected is a DIFFERENT sentence',
    /Personal Sync is not connected/.test(FI.scanBlockedReason(
      remoteChoice({ remote: 'o/r', tokenSource: 'sync', hasSyncToken: false }))));
  eq('CONTROL: a build that does not report availability blocks NOTHING — '
    + '"we did not look" must not be rendered as "not set"',
  FI.scanBlockedReason(remoteChoice({ remote: 'o/r' })), '');

  // ── AND THE COMMIT ────────────────────────────────────────────────────
  eq('a remote mirror with nothing found cannot be committed — a remote init '
    + 'with no files performs NO network call, so it would record an ownership '
    + 'pointing at a repository nobody has proved exists',
  FI.commitBlockedReason(remoteChoice({ remote: 'o/r' })), 'Find the documents first.');
  eq('...and one found but nothing ticked says so',
    FI.commitBlockedReason(remoteChoice({ remote: 'o/r',
      candidates: [{ path: 'a.md', bytes: 1 }], picks: {} })), 'Tick at least one document.');
  eq('...and a ticked one is committable',
    FI.commitBlockedReason(remoteChoice({ remote: 'o/r',
      candidates: [{ path: 'a.md', bytes: 1, suggestedRole: 'other' }],
      picks: { 'a.md': true } })), '');

  // ── THE SCAN: ONE READ, AND NO TOKEN ON THE WIRE ──────────────────────
  {
    const urls = [];
    const fake = async (u) => { urls.push(String(u)); return { ok: true,
      json: async () => ({ ok: true, remote: { owner: 'o', repo: 'r' }, commit: 'abc',
        candidates: [{ path: 'docs/a.md', bytes: 10, suggestedRole: 'architecture',
          firstHeading: null, modifiedAt: null }], truncated: false }) }; };
    // A TOKEN IS PLANTED IN THE ARGUMENTS, and that is the whole point of
    // this fixture rather than a flourish: a scan driven with NO token cannot
    // tell a function that refuses to forward one from a function that would
    // have. The mutation adding `token=` to the query string was GREEN
    // against the token-less fixture and reds against this one.
    const got = await FI.scanRemote({ remote: 'o/r', ref: 'main', path: 'docs',
      tokenSource: 'sync', token: 'ghp_PLANTED_SECRET_0000' }, fake);
    eq('exactly one request', urls.length, 1);
    ok('...to the repo-scan route, in REMOTE mode, with the repository escaped',
      urls[0].startsWith('/api/memory/repo-scan?source=remote&remote=o%2Fr'), urls[0]);
    ok('...carrying the ref, the folder and the token SOURCE',
      /[?&]ref=main/.test(urls[0]) && /[?&]path=docs/.test(urls[0])
      && /[?&]tokenSource=sync/.test(urls[0]), urls[0]);
    ok('...and NOT the token planted in its own arguments — the store reads a '
      + 'token from a FILE, and a token in an argument neither authorises a '
      + 'read nor appears in an answer',
    !/PLANTED/.test(urls[0]) && !/ghp_|github_pat/.test(urls[0])
      && !/[?&]token=/.test(urls[0]), urls[0]);
    eq('the candidates come back', got.candidates.length, 1);
    eq('...and a remote row carries NO age, uniformly — a git tree has no '
      + 'timestamps, so "not read" is the honest answer and a fake age would '
      + 'be worse than either', got.candidates[0].modifiedAt, null);
    eq('...which the row renderer respects', FI.candidateAgeHtml(null), '');
    // ── AND THE ARM SAYS SO ONCE, ABOVE THE LIST ──────────────────────
    // Twenty-five rows each carrying a dash is noise, and a FAKE age would be
    // worse than either — so the omission is DISCLOSED rather than left to be
    // noticed. Asserted over the rendered arm with a scan in hand, because
    // the sentence only appears once there is a list for it to qualify.
    const listed = FI.renderFoundationsChooser({ id: 'x', choice: remoteChoice({
      remote: 'o/r', candidates: got.candidates, picks: {} }) });
    ok('the remote arm discloses that no row carries an age',
      /Age is unknown for a remote scan/.test(listed), listed.slice(-900));
    ok('...and no row invents one', !/fnd-init-cand-age/.test(listed), listed.slice(-900));
    // CONTROL: the LOCAL arm, whose rows DO carry an age, says no such thing.
    const localListed = FI.renderFoundationsChooser({ id: 'x', choice: {
      ...FI.freshChooser({}), ownership: 'repo', repoRoot: '/r', picks: {},
      candidates: [{ path: 'docs/a.md', bytes: 10, suggestedRole: 'other',
        modifiedAt: new Date(Date.now() - 3600_000).toISOString() }] } });
    ok('CONTROL: the local arm makes no such disclosure, because its rows have ages',
      !/Age is unknown/.test(localListed) && /fnd-init-cand-age/.test(localListed),
      localListed.slice(-900));
  }
  {
    // EVERY REFUSAL IS A SENTENCE, AND EVERY SENTENCE NAMES THE SOURCE.
    const refuse = async (code) => FI.scanRemote({ remote: 'o/r', tokenSource: 'config' },
      async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: code }) }));
    ok('an unauthorised read names WHICH stored token was refused',
      /read-only token in Settings was refused/i.test((await refuse('unauthorised')).error),
      (await refuse('unauthorised')).error);
    ok('a missing token says which file is empty, not "auth failed"',
      /no token to read with/.test((await refuse('no-token')).error));
    ok('a truncated tree says what to DO — the store throws before the first '
      + 'blob rather than mirroring part of a repository',
    /Name a folder inside it/.test((await refuse('remote-tree-truncated')).error));
    ok('a rate limit is told apart from a refusal',
      /rate-limiting/.test((await refuse('rate-limited')).error));
    for (const code of ['unauthorised', 'no-token', 'rate-limited', 'remote-not-found',
      'remote-tree-truncated', 'remote-too-large', 'invalid-remote', 'invalid-token-source',
      'remote-unreachable', 'remote-http', 'remote-unavailable']) {
      const msg = (await refuse(code)).error;
      ok('`' + code + '` is a sentence a person can act on, not a protocol word',
        typeof msg === 'string' && msg.length > 20 && !msg.includes(code), msg);
    }
    const unknown = await FI.scanRemote({ remote: 'o/r' },
      async () => ({ ok: false, status: 400,
        json: async () => ({ ok: false, error: 'brand_new', message: 'the producer said this' }) }));
    eq('an unrecognised code falls back to the PRODUCER\'s own message rather '
      + 'than to a guess', unknown.error, 'the producer said this');
    const broke = await FI.scanRemote({ remote: 'o/r' }, async () => { throw new Error('offline'); });
    eq('a thrown fetch is caught and disclosed', broke.error, 'offline');
    eq('CONTROL: no repository named is refused before any request',
      (await FI.scanRemote({}, async () => { throw new Error('should not be called'); })).error,
      'name the repository first');
  }

  // ── THE BINDER: THE SAME TICK DEFAULT AS THE LOCAL ARM — NONE ─────────
  // The maintainer's screenshot 4 (v3.65.2): a repository whose documents all
  // sit under documentation/architecture/ arrived 22 of 32 ticked, because
  // the remote arm still ticked by role. It is DRIVEN here through the shipped
  // binder and a scan press, not read off a helper.
  {
    const choice = remoteChoice({ remote: 'o/r' });
    const scan = node({});
    const why = node({ hidden: true, querySelector: () => node({}) });
    const doc = docModel({ 'x-scan': scan, 'x-why': why,
      'x-remote': node({ value: 'o/r' }), 'x-remote-ref': node({ value: '' }),
      'x-remote-path': node({ value: '' }) }, {});
    FI.bindFoundationsChooser({ doc, id: 'x', choice, onChange: () => {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true,
        candidates: [
          { path: 'docs/architecture.md', bytes: 10, suggestedRole: 'architecture' },
          { path: 'docs/notes.md', bytes: 10, suggestedRole: 'other' },
        ], truncated: false }) }) });
    scan.fire('click');
    await new Promise((r) => setTimeout(r, 0));
    eq('the scan landed', Array.isArray(choice.candidates) ? choice.candidates.length : -1, 2);
    ok('...and NOTHING is ticked — not the architecture candidate either, exactly as the '
      + 'local arm — "default should be unticked, then you select what you need"',
    JSON.stringify(choice.picks) === '{}', JSON.stringify(choice.picks));
    eq('...so the commit is off with its reason until the owner ticks one',
      FI.commitBlockedReason(choice), 'Tick at least one document.');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§16 — v3.65.1: THE ARM IS SYMMETRIC, AND ITS HOST IS ONE BOX');
// ═════════════════════════════════════════════════════════════════════════
//
// THE REPORTED DEFECT, in the maintainer's words: *"an inner box narrower than
// the card, buttons clipped at the right edge"* — and nothing was clipped in
// the CSS sense (document overflow measured 0 at 1370 and at 1100). What he was
// reading is an ASYMMETRY: `.fnd-init-arm` declared
// `padding: var(--space-4) 0 var(--space-4) var(--space-8)` — 8px 0 8px 16px,
// ZERO on the right — over an `--accent-tint` ground with a visible edge, so
// "Find documents" and "Add" ended at x=1299 flush against that edge while the
// left had 16px. A control touching a visible edge reads as cut off.
//
// ASSERTED AS A MEASUREMENT, not as a literal: the two horizontal values are
// parsed out of the shipped rule and compared to each other, so the fix cannot
// be undone by re-writing the same asymmetry with different tokens, and the
// values may still be tuned.
{
  const css = readFileSync(join(NEXT, 'shared/foundations-init.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.fnd-init-arm\s*\{([^}]*)\}/.exec(css);
  ok('CONTROL: the arm\'s rule was found (the scan is not vacuous)', !!rule, 'no rule');
  const pad = rule && /padding:\s*([^;]+);/.exec(rule[1]);
  ok('CONTROL: and it declares a padding', !!pad, rule ? rule[1].slice(0, 200) : '');
  if (pad) {
    // CSS shorthand: 1 value = all, 2 = block/inline, 3 = top/inline/bottom,
    // 4 = top/right/bottom/left.
    const parts = pad[1].trim().split(/\s+/);
    const right = parts.length === 1 ? parts[0] : parts[1];
    const left = parts.length <= 2 ? right : parts.length === 3 ? parts[1] : parts[3];
    eq('the tinted arm\'s horizontal padding is SYMMETRIC — a control flush '
      + 'against a visible tinted edge is what "clipped at the right" was',
    String(right), String(left));
    ok('...and the right padding is not zero, which is the exact value that '
      + 'shipped through v3.65.0', right !== '0' && right !== '0px', String(right));
  }

  // AND ITS HOST IS ONE BOX, on Wiki health's Quick-maintenance anatomy. The
  // five properties are views/domains.css's own values, copied deliberately
  // rather than shared — promoting a kit panel is recorded for v3.66.0 — so
  // the assertion is that all five are declared, not that they match a literal.
  const memCss = readFileSync(join(NEXT, 'views/memory.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const panel = /\.mem-fnd-panel\s*\{([^}]*)\}/.exec(memCss);
  ok('the Add-from-folder panel is ONE box with a rule of its own', !!panel, 'no rule');
  if (panel) {
    for (const prop of ['padding', 'border-radius', 'border', 'background']) {
      ok('...declaring ' + prop + ', as .dm-quick does',
        new RegExp('(^|;|\\s)' + prop + '\\s*:').test(panel[1]), panel[1].slice(0, 200));
    }
    const p = /padding:\s*([^;]+);/.exec(panel[1]);
    eq('...and its padding is ONE value, so the box is symmetric on all four '
      + 'sides — three nested boxes at 405 / 421 / 436 is what it replaces',
    p ? p[1].trim().split(/\s+/).length : 0, 1);
  }
  // AND THE SPECIFICITY PATCH THAT CARD NEEDED IS GONE WITH IT.
  ok('the reserve-undo rule is deleted — there is no 46px pencil reserve to '
    + 'undo in a box with one symmetric padding',
  !/\.mem-fold-flat\s*>\s*\.mem-fold-body\.mem-fnd-init-body/.test(memCss),
  'the patch survives its card');
}

// ═════════════════════════════════════════════════════════════════════════
section('§17 — v3.65.1 D1: the chooser says "Documents", not "Foundations"');
// ═════════════════════════════════════════════════════════════════════════
//
// The shared chooser has TWO hosts — the Context view's step ① and the "New
// project" form on the Domains page — and it carries one sentence naming the
// block that will ask again. That sentence is the last place the old noun
// survived outside a comment, and it is reachable from neither host's own
// vocabulary census, because this module composes it. FOUND BY MUTATION.
{
  const later = FI.renderFoundationsChooser({
    id: 'x', choice: FI.freshChooser({ allowLater: true }),
  });
  // NOTE THE ARGUMENT ORDER: `ok(label, cond, detail)` in THIS file, and
  // `ok(cond, label, detail)` in scripts/test-next-monitor-kit.js. Writing the
  // wrong one does not fail — it passes a non-empty STRING as the condition, so
  // every assertion is vacuously green. It happened twice while this release
  // was built, once in each direction.
  ok('the "decide later" card names the block by its v3.65.1 word',
    /Documents asks again when you are ready\./.test(later), later.slice(0, 600));
  ok('...and the old noun is gone from every card this module renders',
    !/Foundations/.test(later), (later.match(/.{0,60}Foundations.{0,60}/) || [''])[0]);
  ok('CONTROL: the "decide later" card was really rendered (the scan is not vacuous)',
    /data-fnd-own="later"/.test(later), later.slice(0, 200));
}

// ═════════════════════════════════════════════════════════════════════════
section('§18 — v3.65.2: THE HOST-OWNED REASON, THE DOOR, AND ADD MODE, DRIVEN');
// ═════════════════════════════════════════════════════════════════════════
//
// The binder half of C1 and C2. Every behaviour below is the SHIPPED
// `bindFoundationsChooser` running against a DOM model — the same harness §5
// and §15 use — because every one of these defects was green in markup and
// wrong in behaviour: two nodes sharing one id rendered correctly and the
// patch reached the wrong one.
{
  // ── (1) ONE REASON, REPORTED TO THE HOST ──────────────────────────────
  const choice = { ...FI.freshChooser({}), ownership: 'remote' };
  const remote = node({ value: '' });
  const scan = node({ disabled: true });
  const chooserWhy = node({ hidden: true, querySelector: () => node({}) });
  const reasons = [];
  const doc = docModel({ 'x-remote': remote, 'x-scan': scan, 'x-why': chooserWhy,
    'x-remote-ref': node({}), 'x-remote-path': node({}) }, {});
  FI.bindFoundationsChooser({ doc, id: 'x', choice, reasons: 'host', onChange: () => {},
    onSelect: (r) => reasons.push(r) });
  remote.value = 'o/r';
  remote.fire('input');
  eq('with `reasons: host`, a keystroke hands the host the FIRST UNMET STEP',
    reasons[reasons.length - 1], 'Find the documents first.');
  eq('...arms the scan on the live node', scan.disabled, false);
  eq('...and never writes a chooser `-why` node (there is none in this host)',
    chooserWhy.hidden, true);
  choice.hasReadToken = false;
  remote.fire('input');
  eq('a missing read-only token is the next step before the scan',
    reasons[reasons.length - 1], 'No read-only token yet — add one in Settings, or read with Personal Sync’s token.');
  eq('...and it disables the scan with it', scan.disabled, true);
  remote.value = '';
  remote.fire('input');
  eq('an emptied repository field is the first step again', reasons[reasons.length - 1],
    'Name the repository first.');

  // CONTROL — THE CREATE FORM KEEPS ITS OWN NODE. No `reasons: host`, so the
  // chooser's `-why` is patched and the host hook is not the channel.
  const c2 = { ...FI.freshChooser({}), ownership: 'remote' };
  const r2 = node({ value: '' });
  const whySpan = node({ textContent: '' });
  const why2 = node({ hidden: true, querySelector: () => whySpan });
  FI.bindFoundationsChooser({ doc: docModel({ 'x-remote': r2, 'x-scan': node({}), 'x-why': why2 }, {}),
    id: 'x', choice: c2, onChange: () => {} });
  r2.value = '';
  r2.fire('input');
  ok('CONTROL: without `reasons: host` the chooser still patches its own reason node',
    why2.hidden === false && whySpan.textContent === 'Name the repository first.', whySpan.textContent);
}
{
  // ── (2) THE DOOR TO SETTINGS IS THE HOST'S ────────────────────────────
  const door = node({});
  let opened = 0;
  FI.bindFoundationsChooser({ doc: docModel({ 'x-token-door': door }, {}), id: 'x',
    choice: { ...FI.freshChooser({}), ownership: 'remote', hasReadToken: false },
    onChange: () => {}, onOpenTokenSettings: () => { opened++; } });
  door.fire('click');
  eq('"Add one in Settings" calls the host\'s door, once', opened, 1);
  // The markup half: a host that cannot open Settings gets no door at all.
  const noDoor = FI.renderFoundationsChooser({ id: 'x', optionsHidden: true,
    choice: { ...FI.freshChooser({}), ownership: 'remote', hasReadToken: false } });
  ok('...and a host that passes no `tokenDoor` renders no door — a button that goes nowhere is worse than none',
    !/fnd-init-token-door/.test(noDoor) && /fnd-init-token-state">not saved yet</.test(noDoor));
  const create = FI.renderFoundationsChooser({ id: 'x',
    choice: { ...FI.freshChooser({}), ownership: 'remote' } });
  ok('the CREATE FORM is unchanged where it has no ⓘ: its framed arm and its in-flow token note stay',
    /class="fnd-init-arm">/.test(create) && /<p class="fnd-init-note"><span>The token is never typed here/.test(create)
    && /id="x-why"/.test(create));
}
{
  // ── (3) ADD MODE: THE SCAN RUNS ON OPEN, AGAINST THE RECORDED FOLDER ───
  const mk = (responder, over) => {
    const choice = { ...FI.freshChooser({}), ownership: 'repo', addMode: true,
      fixedRoot: '/rec/root', mirrored: ['docs/a.md'], projectBytes: 1000, ...over };
    const urls = [];
    let renders = 0;
    FI.bindFoundationsChooser({ doc: docModel({}, {}), id: 'x', choice, autoScan: true,
      onChange: () => { renders++; },
      fetchImpl: async (url) => { urls.push(url); return responder(url); } });
    return { choice, urls, renders: () => renders };
  };
  const ok200 = () => ({ ok: true, json: async () => ({ ok: true, root: '/rec/root', truncated: false,
    candidates: [
      { path: 'docs/a.md', bytes: 10, suggestedRole: 'architecture' },
      { path: 'docs/b.md', bytes: 20, suggestedRole: 'architecture' },
    ] }) });
  const a = mk(ok200);
  await new Promise((r) => setTimeout(r, 0));
  eq('opening the panel scans the RECORDED folder, once, with no press',
    a.urls.join(' '), '/api/memory/repo-scan?root=%2Frec%2Froot');
  ok('...and NOTHING is ticked by default — not even a canonical role',
    Object.keys(a.choice.picks).length === 0, JSON.stringify(a.choice.picks));
  eq('...so the ONE reason is "Tick at least one file."', FI.nextStepReason(a.choice),
    'Tick at least one file.');
  // A REPAINT BINDS AGAIN — and must never scan again by itself.
  FI.bindFoundationsChooser({ doc: docModel({}, {}), id: 'x', choice: a.choice, autoScan: true,
    onChange: () => {}, fetchImpl: async (url) => { a.urls.push(url); return ok200(); } });
  await new Promise((r) => setTimeout(r, 0));
  eq('...and a second bind (a repaint) does NOT scan again', a.urls.length, 1);

  const b = mk(() => ({ ok: false, status: 400, json: async () => ({ ok: false,
    reason: 'unreachable-root', error: 'That folder is not on this computer.' }) }));
  await new Promise((r) => setTimeout(r, 0));
  eq('a recorded folder that is NOT here brings the field back', b.choice.rootEditable, true);
  eq('...prefilled with the recorded path, so it can be corrected rather than retyped',
    b.choice.repoRoot, '/rec/root');
  eq('...and the one reason names the one thing to do', FI.nextStepReason(b.choice),
    'That folder is not on this computer. Point at your copy of it.');
  const field = FI.renderFoundationsChooser({ id: 'x', choice: b.choice, optionsHidden: true,
    flat: true, reasons: 'host' });
  ok('...the field is rendered, prefilled', /id="x-root" type="text"[^>]*value="\/rec\/root"/.test(field),
    (field.match(/id="x-root"[^>]*>/) || [''])[0]);
  const noScan = mk(ok200, { rootEditable: true, repoRoot: '/typed' });
  await new Promise((r) => setTimeout(r, 0));
  eq('CONTROL: once the field is shown nothing scans by itself — the person presses Find',
    noScan.urls.length, 0);
}
{
  // ── (4) "+ A FILE THAT ISN'T LISTED" — PATCHED IN PLACE ────────────────
  const choice = { ...FI.freshChooser({}), ownership: 'repo', addMode: true, fixedRoot: '/r',
    mirrored: ['docs/a.md'], projectBytes: 0, picks: {},
    candidates: [{ path: 'docs/a.md', bytes: 10, suggestedRole: 'architecture' },
      { path: 'docs/b.md', bytes: 20, suggestedRole: 'decisions' }] };
  const inserted = [];
  const extraRow = node({ innerHTML: FI.extraRowHtml('x', choice, false),
    insertAdjacentHTML(where, html) { inserted.push([where, html]); } });
  const input = node({ dataset: { fndExtraField: '1' }, value: '', focus() { this.focused = true; } });
  const addBtn = node({ dataset: { fndExtraAdd: '1' }, disabled: true });
  const countNode = node({ dataset: { fndCountRich: '1' }, innerHTML: '' });
  const openBtn = node({ dataset: { fndExtraOpen: '1' } });
  const box = node({ checked: false });
  const rowB = node({ querySelector: (sel) => (sel === '[data-fnd-cand]' ? box : null) });
  const scope = node({
    querySelector: (sel) => (sel === '[data-fnd-cand-row="docs/b.md"]' ? rowB : null),
    querySelectorAll: () => [],
  });
  const reasons = [];
  let renders = 0;
  FI.bindFoundationsChooser({
    doc: docModel({ 'x-extra-row': extraRow, 'x-extra': input, 'x-extra-add': addBtn,
      'x-count': countNode }, { '[data-fnd-init="x"]': [scope] }),
    id: 'x', choice, reasons: 'host', onChange: () => { renders++; },
    onSelect: (r) => reasons.push(r) });
  scope.fire('click', { target: openBtn });
  ok('pressing the row OPENS it in place — a labelled field and "Add to list"',
    /Path inside this folder<\/label>/.test(extraRow.innerHTML) && /Add to list<\/button>/.test(extraRow.innerHTML),
    extraRow.innerHTML);
  eq('...without a repaint of the list (which would throw a reader back to the top)', renders, 0);
  ok('...and focus goes to the field it opened', input.focused === true);
  input.value = 'notes/architecture.md';
  scope.fire('input', { target: input });
  eq('typing arms "Add to list" on the live node', addBtn.disabled, false);
  scope.fire('click', { target: addBtn });
  eq('the added path is ONE ordinary row, inserted above the extra row',
    inserted.length + ':' + (inserted[0] && inserted[0][0]), '1:beforebegin');
  ok('...ticked, with the same role control as its neighbours, and marked as added by path',
    /data-fnd-cand="notes\/architecture\.md" checked/.test(inserted[0][1])
    && /data-fnd-role-open="notes\/architecture\.md"/.test(inserted[0][1])
    && /added by path/.test(inserted[0][1]) && /size not known/.test(inserted[0][1]), inserted[0][1]);
  ok('...it is on the wire with the role its name suggests',
    JSON.stringify(FI.pickedFiles(choice)) === JSON.stringify([{ path: 'notes/architecture.md', role: 'architecture' }]),
    JSON.stringify(FI.pickedFiles(choice)));
  ok('...the count says its size is not known yet rather than counting it as zero',
    /size of 1 added by path not known yet/.test(countNode.innerHTML), countNode.innerHTML);
  eq('...the host is told the copy is now possible', reasons[reasons.length - 1], '');
  ok('...and the row closes again', /data-fnd-extra-open="1"/.test(extraRow.innerHTML));
  // THE SAME PATH AS A LISTED CANDIDATE IS A TICK, NOT A SECOND ROW.
  scope.fire('click', { target: openBtn });
  input.value = 'docs/b.md';
  scope.fire('input', { target: input });
  scope.fire('click', { target: addBtn });
  eq('adding a path already in the list ticks it — no second row', inserted.length, 1);
  eq('...on the live checkbox', box.checked, true);
  // AN ALREADY-MIRRORED PATH IS NEVER ADDED.
  scope.fire('click', { target: openBtn });
  input.value = 'docs/a.md';
  scope.fire('input', { target: input });
  scope.fire('click', { target: addBtn });
  ok('adding a path that is already mirrored changes nothing',
    inserted.length === 1 && !FI.pickedFiles(choice).some((f) => f.path === 'docs/a.md'));
}
{
  // ── (4b) A FIELD'S INPUT IS ITS NATURAL HEIGHT — FOUND BY LOOKING ─────────
  // `.fnd-init-path` carries `flex: 1 1 260px` for the ROW it sits in beside
  // its buttons. Inside `.fnd-init-field`, a flex COLUMN, the first cut
  // measured each GitHub input at 260px TALL in the browser — every markup
  // assertion green. The counter-rule is read off the live, comment-stripped
  // stylesheet.
  const css = readFileSync(join(NEXT, 'shared/foundations-init.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('`.fnd-init-field` is a flex column (the case the counter-rule exists for)',
    /\.fnd-init-field\s*\{[^}]*flex-direction:\s*column/.test(css));
  ok('...and an input inside it gives up the row\'s 260px basis',
    /\.fnd-init-field\s*>\s*\.fnd-init-path\s*\{[^}]*flex:\s*none/.test(css));
  ok('the three remote fields are three equal tracks, not an auto-fit that lays labels out as fields',
    /\.fnd-init-remote-fields\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/.test(css)
    && /\.fnd-init-remote-fields\s*\{[^}]*align-items:\s*start/.test(css));
  ok('the flat arm drops its frame — no tint, no rule, no padding',
    /\.fnd-init-arm\.fnd-init-arm-flat\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*none/.test(css));
}
{
  // ── (5) scanRemote KEYS ON `reason` (the route's CODE), NOT ON PROSE ────
  const got = await FI.scanRemote({ remote: 'o/r', tokenSource: 'config' },
    async () => ({ ok: false, status: 409, json: async () => ({ ok: false, reason: 'no-token',
      error: 'No token in .curator-config.json.' }) }));
  ok('a refusal whose CODE is in `reason` and whose PROSE is in `error` becomes the sentence '
    + 'for the code — the wire\'s real shape', /no token to read with/.test(got.error), got.error);
}
{
  // ── (6) THE COPY IS SENT AGAINST THE FOLDER THAT WAS SCANNED ─────────────
  const run = async (over) => {
    const { api, st, calls } = writeRig(() => ({ ok: true, json: async () => ({ ok: true }) }));
    const choice = { ...FI.freshChooser({}), ownership: 'repo', addMode: true, fixedRoot: '/rec',
      repoRoot: '/rec', candidates: [{ path: 'docs/b.md', bytes: 1, suggestedRole: 'other' }],
      picks: { 'docs/b.md': true }, ...over };
    st.fndInit = { domain: 'acme', project: 'lumina', choice, busy: false, adding: true };
    await api.initFoundations(1, { present: true, ownership: 'repo' });
    return calls;
  };
  const fixed = await run({});
  eq('the recorded folder: the refresh carries the files and NO repoRoot — the route reads the manifest\'s',
    JSON.stringify([fixed.refreshFiles, fixed.refreshRoot]),
    JSON.stringify([[{ path: 'docs/b.md', role: 'other' }], undefined]));
  const typed = await run({ rootEditable: true, repoRoot: '/my/copy' });
  eq('a folder TYPED because the recorded one is missing is SENT — the path scanned is the path copied from',
    typed.refreshRoot, '/my/copy');
}

// ═════════════════════════════════════════════════════════════════════════
section('§19 — v3.65.3: READ WITH NAMES EACH TOKEN, AND THE DEFAULT IS DERIVED');
// ═════════════════════════════════════════════════════════════════════════
//
// The maintainer, with a read-only token saved and tested: "two options … not
// clear which is which", Personal Sync's token shown SELECTED, and "connected"
// floating at the panel's far right edge. Each option now says what it is and
// where it lives, carries its state beside it, and the checked radio is
// derived from the facts until the owner presses one.
{
  const base = () => ({ ...FI.freshChooser({}), ownership: 'remote' });
  eq('a fresh chooser has NOT chosen a token (null), so the facts decide',
    FI.freshChooser({}).tokenSource, null);
  eq('a saved read-only token → the read-only token is selected',
    FI.selectedTokenSource({ ...base(), hasReadToken: true, hasSyncToken: true }), 'config');
  eq('NO read-only token (a fact) → NOTHING is selected, never Personal Sync silently',
    FI.selectedTokenSource({ ...base(), hasReadToken: false, hasSyncToken: true }), null);
  eq('unknown (nobody looked, or the read failed) → the read-only token, as before',
    FI.selectedTokenSource(base()), 'config');
  eq('the owner’s own press wins over the facts: Sync stays Sync',
    FI.selectedTokenSource({ ...base(), tokenSource: 'sync', hasReadToken: true }), 'sync');
  eq('...and an explicit read-only press stays, even with no token saved (the reason says why)',
    FI.selectedTokenSource({ ...base(), tokenSource: 'config', hasReadToken: false }), 'config');

  const mk = (over) => FI.renderFoundationsChooser({ id: 'x', optionsHidden: true,
    choice: { ...base(), remote: 'o/r', ...over }, tokenDoor: true });
  const checkedOf = (html) => {
    const m = html.match(/value="(config|sync)" data-fnd-token="\1"[^>]*\bchecked\b/g) || [];
    return m.map((x) => x.match(/value="(config|sync)"/)[1]);
  };
  const saved = mk({ hasReadToken: true, readTokenLast4: 'rxRQ', hasSyncToken: true });
  eq('RENDERED: with a saved read-only token exactly ONE radio is checked, the read-only one',
    JSON.stringify(checkedOf(saved)), '["config"]');
  const none = mk({ hasReadToken: false, hasSyncToken: true });
  eq('RENDERED: with no read-only token NO radio is checked', JSON.stringify(checkedOf(none)), '[]');
  ok('...and the door to Settings is there instead',
    /<\/label><button type="button" class="btn btn-secondary btn-xs fnd-init-token-door"/.test(none));

  // Each option names WHAT and WHERE, and its state sits INSIDE its own label.
  const optOf = (html, v) => {
    const i = html.indexOf('value="' + v + '"');
    return i < 0 ? '' : html.slice(i, html.indexOf('</label>', i));
  };
  const cfg = optOf(saved, 'config');
  const syn = optOf(saved, 'sync');
  ok('the read-only option says what it is and where it lives',
    /fnd-init-token-name">Read-only token</.test(cfg)
      && /fnd-init-token-where">— Settings › Knowledge base</.test(cfg), cfg);
  ok('...and its last four sit in ITS OWN label', /fnd-init-token-state">ends in …rxRQ</.test(cfg), cfg);
  ok('the Personal Sync option says which token that is',
    /fnd-init-token-name">Personal Sync’s token</.test(syn)
      && /fnd-init-token-where">— the one that syncs your knowledge base</.test(syn), syn);
  ok('...and plainly why it is not the default', /every repository its account can see/.test(syn)
    && /which is why it is not the default/.test(syn), syn);
  ok('..."connected" sits inside the Personal Sync label, beside its name — not elsewhere',
    /fnd-init-token-state">connected</.test(syn) && !/fnd-init-token-state">connected</.test(cfg), syn);
  // EXACTLY ONE state word per option, and it is INSIDE that option's own
  // <label> — a second copy floating after the label (the v3.65.2 shape: a
  // word a panel's width from its option) is the defect, not a variant of it.
  const lines = saved.split('<div class="fnd-init-token-line">').slice(1);
  eq('CONTROL: two option lines rendered', lines.length, 2);
  for (const ln of lines) {
    const v = (ln.match(/value="(config|sync)"/) || [, '?'])[1];
    const inLabel = ln.slice(0, ln.indexOf('</label>'));
    const total = (ln.match(/class="fnd-init-token-state"/g) || []).length;
    const inside = (inLabel.match(/class="fnd-init-token-state"/g) || []).length;
    ok('option ' + v + ': exactly one state word, and it is inside its own label',
      total === 1 && inside === 1, 'total ' + total + ', inside ' + inside);
  }
  ok('a last-four that is not token characters is not printed',
    !/ends in/.test(optOf(mk({ hasReadToken: true, readTokenLast4: '<b>' }), 'config')));

  // THE LAYOUT HALF: the label hugs its text and the state word is not pushed
  // to the far edge. Read from the comment-stripped stylesheet.
  const css = readFileSync(join(NEXT, 'shared/foundations-init.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleOf = (sel) => {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    let out = ''; let m; while ((m = re.exec(css))) out += m[1];
    return out;
  };
  ok('the option label no longer stretches across the panel (no flex-grow)',
    /flex:\s*0 1 auto/.test(ruleOf('.fnd-init-token-line > .fnd-init-token-opt'))
      && !/flex:\s*1/.test(ruleOf('.fnd-init-token-line > .fnd-init-token-opt')),
    ruleOf('.fnd-init-token-line > .fnd-init-token-opt'));
  ok('the state word is not pushed to the far edge (no margin-left:auto)',
    !/margin-left:\s*auto/.test(ruleOf('.fnd-init-token-state')), ruleOf('.fnd-init-token-state'));
}
{
  // ── DRIVEN: NOTHING SELECTED MEANS NO REQUEST; A PRESS DECIDES ─────────
  const choice = { ...FI.freshChooser({}), ownership: 'remote', remote: 'o/r',
    hasReadToken: false, hasSyncToken: true };
  const scan = node({});
  const syncRadio = node({ dataset: { fndToken: 'sync' } });
  const urls = [];
  const reasons = [];
  const doc = docModel({ 'x-scan': scan, 'x-remote': node({ value: 'o/r' }),
    'x-remote-ref': node({ value: '' }), 'x-remote-path': node({ value: '' }) },
  { '[data-fnd-token]': [syncRadio] });
  FI.bindFoundationsChooser({ doc, id: 'x', choice, reasons: 'host', onChange: () => {},
    onSelect: (r) => reasons.push(r),
    fetchImpl: async (u) => { urls.push(String(u)); return { ok: true, json: async () => ({ ok: true,
      candidates: [{ path: 'a.md', bytes: 1, suggestedRole: 'architecture' }], truncated: false }) }; } });
  scan.fire('click');
  await new Promise((r) => setTimeout(r, 0));
  eq('with nothing selected, a scan press sends NO request', urls.length, 0);
  eq('...and the reason names the missing token', FI.nextStepReason(choice),
    'No read-only token yet — add one in Settings, or read with Personal Sync’s token.');
  syncRadio.fire('change');
  eq('pressing Personal Sync records THE OWNER’s choice', choice.tokenSource, 'sync');
  scan.fire('click');
  await new Promise((r) => setTimeout(r, 0));
  ok('...and the scan then reads with Personal Sync’s token, named on the URL',
    urls.length === 1 && /[?&]tokenSource=sync\b/.test(urls[0]), JSON.stringify(urls));
  ok('...and the body a commit would send names the chosen source',
    FI.chooserBody(choice).tokenSource === 'sync', JSON.stringify(FI.chooserBody(choice)));
  const saved = { ...FI.freshChooser({}), ownership: 'remote', remote: 'o/r', hasReadToken: true };
  eq('with a saved read-only token and no press, the commit body reads with it',
    FI.chooserBody(saved).tokenSource, 'config');
}

// ── Done ─────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed === 0) console.log('✅ All foundations chooser + editor assertions green');
else console.log('❌ ' + failed + ' foundations assertion(s) failed');
process.exit(failed === 0 ? 0 : 1);
