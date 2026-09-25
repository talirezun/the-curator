#!/usr/bin/env node
/**
 * test-row-actions.js — OFFLINE suite that pins THE ONE ROW-ACTION RULE,
 * app-wide (v3.72.0, package P5; v372-design/DESIGN.md §4, decision M3,
 * final):
 *
 *   A row action is a neutral ghost icon button, visible at rest.
 *   Colour arrives only at the confirm.
 *
 * DESIGN.md §4 found THREE different row-action idioms already shipping —
 * Context's Documents rows (neutral, always visible — the pattern this rule
 * generalises), Chat's conversation delete (`display:none` until hover, then
 * `--danger-text` red on hover — finding C8), and Ingest's queue remove
 * (visible, but ALSO red on hover — finding C8). Two independent defects,
 * so two independent checks, each over every /next stylesheet:
 *
 *   1. No row-action selector may reference a `--danger*` token on
 *      :hover/:focus/:focus-visible/:active. Destructive colour belongs on
 *      the CONFIRM button that a row action's click opens
 *      (`.btn-danger`/`confirmThen({tone:'danger'})`), never the trigger.
 *   2. No row-action selector may be `display:none`/`visibility:hidden` at
 *      rest (the hover/focus-reveals-it idiom) — a row action is visible to
 *      a pointer, a keyboard and a touch screen alike, per the research
 *      DESIGN.md §1 "Row actions" cites (NN/g on hover-only discoverability
 *      and touch, Primer/Apple HIG on where destructive weight belongs).
 *
 * `shared/row-action.css`'s new `.row-act` class is the ONE definition of
 * this treatment; any current or future class matching it is covered
 * automatically (§ "generic" below). A short, curated list of selectors
 * that predate this release and are NOT YET converted is also covered by
 * name, so a fourth idiom cannot land unnoticed even before it adopts
 * `.row-act` outright. P5 shipped with ONE named, dated exception — Chat's
 * `.chat-conv-delete` (hover-only, red on hover) — for P3 to remove in the
 * same release. P3 did (v3.72.0): Chat's rows emit `.row-act chat-conv-act`
 * and EXCEPTIONS is empty. It stays as a list, asserted to still match what
 * it excuses, so the next exception is written there, named and dated.
 *
 * A separate section pins THE ONE TRASH GLYPH (C9): before this release,
 * `shared/foundations-sources.js` drew its own inline trash outline,
 * different from `app.js`'s `ICON_BODY.trash`. `deleteIconHtml` now emits a
 * path pinned byte-identical to `ICON_BODY.trash`'s `d` attribute — compared
 * as SOURCE TEXT, never by importing `app.js` (which reaches `document` at
 * module load and cannot run under plain Node — see the comment above
 * `TRASH_PATH_D` in foundations-sources.js). The suite also asserts exactly
 * one `deleteIconHtml` definition exists in the whole /next tree, and that
 * the pre-v3.72.0 distinct shape (`M4 7h16`) is gone.
 *
 * Every check below carries its own POSITIVE CONTROL: a small synthetic CSS
 * fixture, built so the checker MUST red, is run through the same function
 * first — the class of bug this repo has hit before (test-css-tokens.js's
 * header, test-frontend-null-safety.js's history) is a scanner that quietly
 * stops matching and reports all-green having checked nothing.
 *
 * Offline; source scan only. No DOM, no network, nothing written.
 * Run with:  node scripts/test-row-actions.js   (exit 0 = all green)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ─────────────────────────────────────────────────────────────────────────
// Minimal CSS block extractor: strips /* */ comments, then walks the text
// tracking brace depth (never assuming a fixed line shape) to pull out
// every LEAF rule as { selector, body, file }. An @-rule (e.g. @media,
// @supports) is recursed into rather than treated as a leaf, so a
// dark-mode override nested inside @media still surfaces its own rules.
// ─────────────────────────────────────────────────────────────────────────
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractBlocks(text, file, out) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open === -1) break;
    const selector = text.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    if (selector.startsWith('@')) {
      extractBlocks(body, file, out);
    } else if (selector) {
      out.push({ selector, body, file });
    }
    i = j;
  }
  return out;
}

function blocksOf(cssPath) {
  const raw = readFileSync(cssPath, 'utf8');
  return extractBlocks(stripComments(raw), cssPath, []);
}

function walkCssFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkCssFiles(p));
    else if (extname(entry.name) === '.css') out.push(p);
  }
  return out;
}

const relPath = (p) => p.slice(NEXT.length + 1);

// ─────────────────────────────────────────────────────────────────────────
// Section 0 — self-test: prove the two checkers actually catch what they
// are built to catch, against small synthetic fixtures with known answers,
// BEFORE trusting either one against the real tree.
// ─────────────────────────────────────────────────────────────────────────
section('0. Self-test: the checkers themselves');
{
  const dangerFixture = `
    .row-act { color: var(--text-3); }
    .row-act:hover { background: var(--danger-tint); color: var(--danger-text); }
  `;
  const blocks = extractBlocks(stripComments(dangerFixture), 'fixture.css', []);
  const hoverBlock = blocks.find((b) => /:hover/.test(b.selector));
  ok(!!hoverBlock && /var\(--danger/i.test(hoverBlock.body),
    'self-test: planted --danger-tint hover is found by the extractor (positive control)');

  const cleanFixture = `.row-act:hover { background: var(--mat-row-hover); color: var(--text); }`;
  const cleanBlocks = extractBlocks(stripComments(cleanFixture), 'fixture.css', []);
  ok(cleanBlocks.length === 1 && !/var\(--danger/i.test(cleanBlocks[0].body),
    'self-test: a clean hover rule reads as clean (negative control)');

  const hiddenFixture = `
    .row-act { display: none; }
    .row-row:hover .row-act { display: inline-flex; }
  `;
  const hiddenBlocks = extractBlocks(stripComments(hiddenFixture), 'fixture.css', []);
  const base = hiddenBlocks.find((b) => b.selector === '.row-act');
  ok(!!base && /display\s*:\s*none/i.test(base.body),
    'self-test: planted display:none-at-rest is found by the extractor (positive control)');

  const mediaFixture = `@media (prefers-color-scheme: dark) { .row-act:hover { background: var(--danger-tint); } }`;
  const mediaBlocks = extractBlocks(stripComments(mediaFixture), 'fixture.css', []);
  ok(mediaBlocks.length === 1 && /var\(--danger/i.test(mediaBlocks[0].body),
    'self-test: a rule nested inside @media is still reached (recursion works)');
}

// ─────────────────────────────────────────────────────────────────────────
// The row-action selector registry. `.row-act` (shared/row-action.css)
// covers every current and future adopter generically. The remaining
// entries are the SPECIFIC bare-icon row actions DESIGN.md §4 found living
// under their own class names, so this suite catches them even before (or
// instead of) a `.row-act` rename:
//   - `.fnd-delete` (Context Documents, shared/foundations-sources.js) —
//     already conformed before this release; kept pinned so it cannot drift.
//   - `.ing-queue-file-remove` (Ingest queue remove) — P5 fixes it in this
//     release (views/ingest.css).
//   - `.chat-conv-delete` (Chat conversation delete) — GONE in v3.72.0 (P3):
//     Chat's rows emit `.row-act chat-conv-act`, so the generic `.row-act`
//     coverage holds them.
// A labelled, worded button (e.g. `.btn-danger` with a text "Delete…", or
// `.dm-delete-btn`/`.mem-fnd-delete` — a full sentence-length control that
// OPENS a confirm rather than a bare icon that IS the row) is out of scope:
// Primer's own guidance (DESIGN.md §1) puts destructive weight at the
// confirm/committed step, and a labelled opener already carries its own
// warning in words, which is exactly what an icon-only row action cannot.
// ─────────────────────────────────────────────────────────────────────────
const ROW_ACTION_CLASSES = ['row-act', 'fnd-delete', 'ing-queue-file-remove'];

// NAMED, DATED exceptions (DESIGN.md §4: "Chat adopts the rule in P3.").
// Each entry names the file, the class, who owns the fix, and why — so it
// reads as a live TODO, not a silent carve-out. `mustStillMatch: true` means
// this suite REDS if the pattern is no longer found, so the list cannot
// outlive what it excuses.
// EMPTIED in v3.72.0 by P3, as the entry required: Chat's conversation rows
// adopted `.row-act` (views/chat-list.js) and `.chat-conv-delete` — hover-only,
// red on hover — no longer exists anywhere in /next. Kept as an empty list so
// the next exception is written HERE, named and dated, not invented elsewhere.
const EXCEPTIONS = [];

function isExcepted(file, className, kind) {
  return EXCEPTIONS.some((e) => e.file === file && e.className === className);
}

// ─────────────────────────────────────────────────────────────────────────
// Section 1 — no --danger* on a row action's hover/focus/active.
// ─────────────────────────────────────────────────────────────────────────
section('1. No row action uses --danger* on hover/focus/active');
{
  const cssFiles = walkCssFiles(NEXT);
  ok(cssFiles.length >= 30, `found a plausible number of stylesheets to scan (${cssFiles.length})`);

  const seenExceptionHits = new Set();

  for (const cssPath of cssFiles) {
    const file = relPath(cssPath);
    const blocks = blocksOf(cssPath);
    for (const { selector, body } of blocks) {
      if (!/:(hover|focus(-visible)?|active)\b/.test(selector)) continue;
      const parts = selector.split(',').map((s) => s.trim());
      for (const part of parts) {
        if (!/:(hover|focus(-visible)?|active)\b/.test(part)) continue;
        const classMatch = part.match(/\.([a-zA-Z0-9_-]+)/);
        if (!classMatch) continue;
        const className = classMatch[1];
        const isRowAction = ROW_ACTION_CLASSES.includes(className);
        const exception = EXCEPTIONS.find((e) => e.file === file && e.className === className);
        if (!isRowAction && !exception) continue;
        const usesDanger = /var\(\s*--danger/i.test(body);
        if (exception) {
          if (usesDanger) seenExceptionHits.add(exception.className);
          // Excepted: allowed through, but only via the sanctioned name.
          continue;
        }
        ok(!usesDanger, `${file}: "${part}" (row action) does not use --danger* on hover/focus/active`);
      }
    }
  }

  for (const e of EXCEPTIONS) {
    if (e.mustStillMatch) {
      ok(seenExceptionHits.has(e.className),
        `named exception "${e.className}" (${e.file}, added ${e.addedDate}, owner: ${e.owner}) `
        + `still matches something real — remove the exception once it no longer does`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Section 2 — no row action is display:none/visibility:hidden at rest.
// ─────────────────────────────────────────────────────────────────────────
section('2. No row action is hidden at rest (hover/focus-only visibility)');
{
  const cssFiles = walkCssFiles(NEXT);
  for (const cssPath of cssFiles) {
    const file = relPath(cssPath);
    const blocks = blocksOf(cssPath);
    for (const { selector, body } of blocks) {
      // A "base" rule: no pseudo-class, no combinator reaching outside a
      // single class (so "`.row-act`" counts, "`.row .row-act`" does not —
      // that shape is a DESCENDANT rule, e.g. hover-reveal from an ancestor,
      // which is exactly what section 2's exception carve-out is for and is
      // caught by matching the ancestor's compound selector below instead).
      const parts = selector.split(',').map((s) => s.trim());
      for (const part of parts) {
        if (/:(hover|focus|active)\b/.test(part)) continue;
        const soleClassMatch = part.match(/^\.([a-zA-Z0-9_-]+)$/);
        if (!soleClassMatch) continue;
        const className = soleClassMatch[1];
        const isRowAction = ROW_ACTION_CLASSES.includes(className);
        const exception = EXCEPTIONS.find((e) => e.file === file && e.className === className);
        if (!isRowAction && !exception) continue;
        const hiddenAtRest = /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(body);
        if (exception) continue; // named, dated, reasoned above.
        ok(!hiddenAtRest, `${file}: ".${className}" (row action) is not display:none/visibility:hidden at rest`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Section 3 — shared/row-action.css itself conforms to its own rule (the
// class every current/future row action is meant to adopt must not, by
// construction, violate the thing it exists to enforce).
// ─────────────────────────────────────────────────────────────────────────
section('3. shared/row-action.css defines .row-act, and it conforms');
{
  const rowActionCssPath = join(NEXT, 'shared/row-action.css');
  const rowActionBlocks = blocksOf(rowActionCssPath);
  const bareRowAct = rowActionBlocks.find((b) => b.selector.trim() === '.row-act');
  ok(!!bareRowAct, 'shared/row-action.css defines a bare .row-act rule');
  const rowActHoverBlocks = rowActionBlocks.filter((b) =>
    b.selector.split(',').map((s) => s.trim()).some((p) => p === '.row-act:hover' || p === '.row-act:focus-visible' || p === '.row-act:active'));
  ok(rowActHoverBlocks.length > 0
    && rowActHoverBlocks.every((b) => !/var\(\s*--danger/i.test(b.body)),
    'shared/row-action.css never pairs .row-act hover/focus/active with --danger*');
  ok(!!bareRowAct && !/(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(bareRowAct.body),
    '.row-act itself is not display:none/visibility:hidden at rest');

  // index.html links it, or test-css-tokens.js's own stylesheet-discovery
  // (and every scan above) never sees it at all.
  const indexHtml = readFileSync(join(NEXT, 'index.html'), 'utf8');
  ok(/href="\/next\/shared\/row-action\.css"/.test(indexHtml),
    'index.html links shared/row-action.css');
}

// ─────────────────────────────────────────────────────────────────────────
// Section 4 — the queue's row action (Ingest) adopted the rule: no
// --danger* on its hover, and it stays visible at rest (regression control:
// this section fails loudly if a future edit reintroduces the red hover
// section 1 would otherwise also catch — kept explicit because this is the
// one finding P5 was asked to fix directly, not just guard against).
// ─────────────────────────────────────────────────────────────────────────
section('4. Ingest queue remove: fixed directly by this release');
{
  const ingestCss = stripComments(readFileSync(join(NEXT, 'views/ingest.css'), 'utf8'));
  ok(!/\.ing-queue-file-remove:hover\s*\{[^}]*var\(\s*--danger/i.test(ingestCss),
    'views/ingest.css: .ing-queue-file-remove:hover no longer uses --danger*');
  ok(/\.ing-queue-file-remove\s*\{[^}]*display\s*:\s*inline-flex/i.test(ingestCss),
    'views/ingest.css: .ing-queue-file-remove is still visible (display:inline-flex) at rest');
}

// ─────────────────────────────────────────────────────────────────────────
// Section 5 — THE ONE TRASH GLYPH (C9). Compared as source text (no DOM
// import — see the long comment above TRASH_PATH_D in
// shared/foundations-sources.js for why app.js cannot be imported here).
// ─────────────────────────────────────────────────────────────────────────
section('5. Exactly one trash glyph (C9)');
{
  const appJs = readFileSync(join(NEXT, 'app.js'), 'utf8');
  const fsrcJs = readFileSync(join(NEXT, 'shared/foundations-sources.js'), 'utf8');

  const appTrashMatch = appJs.match(/\btrash:\s*'((?:[^'\\]|\\.)*)'/);
  ok(!!appTrashMatch, 'app.js: ICON_BODY.trash is found (parser did not silently miss it)');

  const fsrcConstMatch = fsrcJs.match(/TRASH_PATH_D\s*=\s*'((?:[^'\\]|\\.)*)'/);
  ok(!!fsrcConstMatch, 'shared/foundations-sources.js: TRASH_PATH_D is found (parser did not silently miss it)');

  if (appTrashMatch && fsrcConstMatch) {
    // app.js's ICON_BODY.trash is a full <path d="...">, possibly with more
    // than one <path>; foundations-sources.js's TRASH_PATH_D is the bare
    // `d` attribute value of that one path. Pull the `d="..."` out of the
    // app.js side for a like-for-like comparison.
    const dAttrMatch = appTrashMatch[1].match(/d="([^"]*)"/);
    ok(!!dAttrMatch, 'app.js: ICON_BODY.trash has a path d="..." to compare');
    if (dAttrMatch) {
      ok(dAttrMatch[1] === fsrcConstMatch[1],
        'app.js ICON_BODY.trash and foundations-sources.js TRASH_PATH_D are byte-identical (one canonical shape)');
    }
  }

  // TRASH_PATH_D must actually be USED by deleteIconHtml, not merely defined.
  ok(/deleteIconHtml[\s\S]{0,600}TRASH_PATH_D/.test(fsrcJs),
    'shared/foundations-sources.js: deleteIconHtml actually renders TRASH_PATH_D');

  // deleteIconHtml must EMIT .row-act (the row is what makes it a row
  // action at all — a trash glyph with the right shape but the wrong class
  // never gets shared/row-action.css's neutral hover/focus treatment).
  const deleteIconFnMatch = fsrcJs.match(/function deleteIconHtml\([\s\S]*?\n\}/);
  ok(!!deleteIconFnMatch, 'shared/foundations-sources.js: deleteIconHtml function body is found');
  ok(!!deleteIconFnMatch && /class="[^"]*\brow-act\b[^"]*"/.test(deleteIconFnMatch[0]),
    'shared/foundations-sources.js: deleteIconHtml emits class="…row-act…"');

  // Exactly one deleteIconHtml DEFINITION in the whole /next tree.
  function walkJsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkJsFiles(p));
      else if (extname(entry.name) === '.js') out.push(p);
    }
    return out;
  }
  let definitionCount = 0;
  const definitionFiles = [];
  for (const jsPath of walkJsFiles(NEXT)) {
    const raw = readFileSync(jsPath, 'utf8');
    const matches = raw.match(/function\s+deleteIconHtml\s*\(/g);
    if (matches) { definitionCount += matches.length; definitionFiles.push(relPath(jsPath)); }
  }
  ok(definitionCount === 1,
    `exactly one deleteIconHtml() definition exists in src/public/next (found ${definitionCount}: ${definitionFiles.join(', ')})`);

  // Regression control: the pre-v3.72.0 second shape must be gone.
  ok(!fsrcJs.includes('M4 7h16'),
    'shared/foundations-sources.js no longer carries the old, distinct trash outline (M4 7h16)');
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
