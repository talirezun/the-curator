#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-shared-block.js — the shared section block, and the copy it has to
 *  agree with byte for byte while both are alive.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT SHIPPED, AND WHY THIS SUITE EXISTS ────────────────────────────────
 *
 * v3.53.0 built the block pattern for Providers & keys — numeral, bold title,
 * a lede of at most twenty visible words, everything longer behind a shared ⓘ
 * fold, one rhythm (24 | hairline | 24) — as `function settingsBlock(...)`
 * inside views/settings.js, a module with ZERO exports. v3.54.0 moved the
 * other four Settings sections onto it. Any OTHER view wanting the same
 * rhythm therefore had exactly one route: copy it. views/domains.js had
 * already taken that route for the ⓘ half, by hand, and the Agent-memory
 * rebuild would have made a third copy.
 *
 * So the block is now src/public/next/shared/block.js (`renderBlock`) and the
 * ⓘ mark is src/public/next/shared/text.js (`renderInfoMark`), beside the
 * delegated listener that already owned the mechanism. The CSS moved from
 * views/settings.css to shell.css, beside `.cur-group`.
 *
 * ── THE COPIES ARE STILL THERE, ON PURPOSE ─────────────────────────────────
 *
 * `settingsBlock` and `infoMark` are NOT deleted from views/settings.js in
 * this pass. Four shipped suites lift them out of that file by brace-matching
 * and EXECUTE them — test-next-title-affordances.js, -settings-sections,
 * test-api-keys-contract.js, test-next-provider-rows.js — so deleting them
 * here would take those with it, in the same release that introduces the
 * replacement. Two live implementations of one component is a real hazard and
 * it is named rather than shrugged at: the hazard is that they DRIFT.
 *
 * §1 removes it. It lifts the REAL `settingsBlock` + `infoMark` + the REAL
 * `TX_INFO_GLYPH` out of views/settings.js, with the REAL `escapeHtml` out of
 * app.js, and compares their output to `renderBlock`'s BYTE FOR BYTE over a
 * fixture matrix. Not "both contain a title", not "both look like a block" —
 * identical strings, or red naming the fixture. A stub anywhere on that path
 * would make this file assert the properties of its own fixtures, which is the
 * shape CLAUDE.md records as worse than no test at all.
 *
 * ── THE GUARDS ─────────────────────────────────────────────────────────────
 *   §1  EXECUTED byte-equality, renderBlock vs settingsBlock, 12 fixtures
 *   §2  the CSS moved: the rhythm is in shell.css and NOT in views/settings.css
 *   §3  renderInfoMark escapes by default; `{html:true}` is the only opt-out
 *   §4  renderBlock THROWS on a missing id or title — the two values whose
 *       absence renders something that looks nearly right
 *   §5  the escapeHtml copies agree, and the two ⓘ glyphs are the same bytes
 *
 * Offline. Reads files off disk and imports two /next shared modules (both
 * import-free of app.js, and text.js guards `typeof document`, so they run
 * headless). No network, no credentials, no writes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderBlock } from '../src/public/next/shared/block.js';
import { renderInfoMark } from '../src/public/next/shared/text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  [32m✓[0m ' + msg); }
  else { failed++; console.log('  [31m✗[0m ' + msg); }
}
function section(t) { console.log('\n[1m' + t + '[0m'); }

const settingsJs = read('views/settings.js');
const appJs = read('app.js');
const shellCss = read('shell.css');
const settingsCss = read('views/settings.css');
const blockJs = read('shared/block.js');
const textJs = read('shared/text.js');

const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

// ── Extraction: brace-matched, LOUD on desync ─────────────────────────────
// The matcher test-next-settings-sections.js and test-next-mcp-wizard.js use.
// A lazy `[\s\S]*?\n\}` stops at the first column-0 closing brace INSIDE the
// function, truncating silently into a syntax error that names nothing.
function extractFunction(source, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  let parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = source.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" did not end at a top-level brace in ${where} — the matcher desynced`);
  }
  return extracted;
}

// ═══════════════════════════════════════════════════════════════════════════
section('§0  THE LIFT — the real functions, out of the real files');
// ═══════════════════════════════════════════════════════════════════════════

const settingsBlockSrc = extractFunction(settingsJs, 'settingsBlock', 'views/settings.js');
const infoMarkSrc = extractFunction(settingsJs, 'infoMark', 'views/settings.js');
const appEscapeSrc = extractFunction(appJs, 'escapeHtml', 'app.js');
const glyphM = /const TX_INFO_GLYPH =([\s\S]*?);\n/.exec(settingsJs);

ok(settingsBlockSrc.includes('settings-job-block'),
  'settingsBlock() was lifted out of views/settings.js and carries the wrapper class');
ok(infoMarkSrc.includes('data-tx-info'),
  'infoMark() was lifted out of views/settings.js and carries the listener hook');
ok(!!glyphM, 'TX_INFO_GLYPH is defined in views/settings.js and was lifted with them');
ok(/[&<>"']/.test(appEscapeSrc) && appEscapeSrc.includes('&amp;'),
  'app.js escapeHtml was lifted — the block helper’s own copy is compared against it in §5');

// The old block, assembled from the real parts and nothing else. TX_INFO_GLYPH
// arrives as a `const` in the same body (not as a parameter) so the lifted
// source is executed exactly as it is written in the view.
const legacyBlock = new Function(
  [appEscapeSrc, 'const TX_INFO_GLYPH =' + glyphM[1] + ';', infoMarkSrc, settingsBlockSrc,
   'return settingsBlock;'].join('\n'))();
ok(typeof legacyBlock === 'function', 'CONTROL: the lifted settingsBlock is callable');

// ═══════════════════════════════════════════════════════════════════════════
section('§1  BYTE-EQUALITY — renderBlock emits what settingsBlock emits');
// ═══════════════════════════════════════════════════════════════════════════
//
// Each fixture is written ONCE, in the new call's object shape, and the legacy
// positional call is derived from it. Two hand-written argument lists would let
// a typo in one of them read as a difference between the implementations.
//
// The optional strings are passed EXPLICITLY as '' rather than omitted, because
// that is the one documented difference between the two: `renderBlock`
// normalises an absent `bodyHtml` to '', while the positional helper would
// concatenate the literal `undefined` into the markup. Normalising is the new
// behaviour and it is strictly better; the equality claim is about the same
// INPUTS, so the fixtures supply them.

const FIXTURES = [
  ['numbered, lede, body, no fold',
    { num: 1, id: 'connect', title: 'Connect a provider',
      ledeHtml: '<strong>Start here.</strong> Paste a key.', bodyHtml: '<div>rows</div>',
      infoText: '', noticeHtml: '' }],
  ['numbered, lede, body, escaped fold',
    { num: 2, id: 'build', title: 'Your AI model',
      ledeHtml: 'One model keeps the bill readable.', bodyHtml: '<table></table>',
      infoText: 'Costs & limits are measured, not "estimated" <here>.', noticeHtml: '' }],
  ['numbered, lede, body, HTML fold carrying an <a> and a <code>',
    { num: 3, id: 'chat', title: 'Chat',
      ledeHtml: 'Pick the model that answers.', bodyHtml: '<ul><li>a</li></ul>',
      infoText: 'See <a href="https://example.invalid/g">the guide</a> and <code>.env</code>.',
      noticeHtml: '', infoHtml: true }],
  ['unnumbered (null), lede, body, fold',
    { num: null, id: 'appearance', title: 'Appearance',
      ledeHtml: 'Light, dark, or whatever the system says.', bodyHtml: '<div>seg</div>',
      infoText: 'The theme follows the OS until you choose one.', noticeHtml: '' }],
  ['unnumbered, NO lede — the fold is suppressed with it',
    { num: null, id: 'syscheck', title: 'System check',
      ledeHtml: '', bodyHtml: '<div>checks</div>',
      infoText: 'This prose has nowhere to hang without a lede.', noticeHtml: '' }],
  ['numbered, with a notice ABOVE the heading and inside the wrapper',
    { num: 2, id: 'build', title: 'Your AI model',
      ledeHtml: 'One model.', bodyHtml: '<table></table>',
      infoText: 'Folded.', noticeHtml: '<div class="provider-gone-banner">Model withdrawn</div>' }],
  ['num 0 — the falsy value a `!= null` test must NOT lose',
    { num: 0, id: 'zero', title: 'Step zero',
      ledeHtml: 'It exists.', bodyHtml: '', infoText: '', noticeHtml: '' }],
  ['num as a STRING, which the helper stringifies either way',
    { num: '12', id: 'twelve', title: 'Twelve',
      ledeHtml: 'Twelve.', bodyHtml: '<p>b</p>', infoText: 'Folded.', noticeHtml: '' }],
  // The apostrophe is deliberate. Mutating block.js’s escapeHtml to drop `'`
  // from its character class left §1 GREEN and only §5 red, because no fixture
  // carried one — and §5 compares the copies to each other, not to what the
  // block RENDERS. Now the rendered markup carries the case too.
  ['an id and a title that both need escaping, apostrophe included',
    { num: 4, id: "a&b\"c'd", title: 'Keys & "models" <all> it\'s',
      ledeHtml: 'Escaped in the class AND in the fold’s aria-label.',
      bodyHtml: '<p>b</p>', infoText: 'Folded & escaped.', noticeHtml: '' }],
  ['everything empty but id and title',
    { num: null, id: 'bare', title: 'Bare', ledeHtml: '', bodyHtml: '', infoText: '', noticeHtml: '' }],
  ['a fold whose text is WHITESPACE ONLY — nothing to say is not a fold',
    { num: 5, id: 'blank', title: 'Blank', ledeHtml: 'A lede.', bodyHtml: '',
      infoText: '   \n  ', noticeHtml: '' }],
  ['infoHtml explicitly FALSE — still escaped, and a <script> stays inert',
    { num: 6, id: 'inert', title: 'Inert', ledeHtml: 'A lede.', bodyHtml: '',
      infoText: '<script>alert(1)</script>', noticeHtml: '', infoHtml: false }],
];

ok(FIXTURES.length >= 8, `the matrix has ${FIXTURES.length} fixtures (floor 8)`);

let allEqual = true;
for (const [label, f] of FIXTURES) {
  const now = renderBlock(f);
  const then = legacyBlock(
    f.num, f.id, f.title, f.ledeHtml, f.bodyHtml, f.infoText, f.noticeHtml,
    f.infoHtml === true ? { html: true } : undefined);
  const same = now === then;
  if (!same) {
    allEqual = false;
    // Name the first differing byte. "They differ" is not a finding.
    let i = 0;
    while (i < now.length && i < then.length && now[i] === then[i]) i++;
    console.log('      at byte ' + i + '\n        new: ' + JSON.stringify(now.slice(i, i + 90)) +
                '\n        old: ' + JSON.stringify(then.slice(i, i + 90)));
  }
  ok(same, `byte-identical — ${label}`);
}
ok(allEqual, 'EVERY fixture matched — the two live implementations have not drifted');

// Anti-vacuity: a comparison that compares nothing passes over anything.
{
  const a = renderBlock(FIXTURES[0][1]);
  const b = renderBlock({ ...FIXTURES[0][1], title: 'Connect a provider ' + '​' });
  ok(a !== b, 'CONTROL: the comparison is a real comparison — a one-character change in the input is visible');
  ok(a.includes('<div class="settings-job-block settings-block settings-block-connect">'),
    'CONTROL: …and what is compared is the real wrapper markup, not an empty string');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  THE CSS MOVED — shell.css owns the rhythm, settings.css keeps no copy');
// ═══════════════════════════════════════════════════════════════════════════
//
// A shared component whose stylesheet is one view's is not shared: index.html
// links views/settings.css LAST of the view sheets, so another view's own rules
// sit EARLIER in the cascade than the component it is borrowing. And a
// relocation that leaves the original behind is not a relocation, it is a
// second copy — the four-unrelated-declarations shape v3.50.0 removed from
// Domains and v3.54.0 removed from Settings.

{
  const shell = stripCssComments(shellCss);
  const settings = stripCssComments(settingsCss);
  ok(/\.settings-job-block \+ \.settings-job-block\s*\{\s*margin-top:\s*var\(--space-12\)\s*;?\s*\}/.test(shell),
    'shell.css carries the ONE adjacent-sibling rule that gives every block break the same gap');
  ok(/\.settings-job-block \{[\s\S]*?padding-top: var\(--space-12\);[\s\S]*?border-top: 1px solid var\(--border\);[\s\S]*?\}/.test(shell),
    '…and the matching padding + hairline above it, so the gap reads 24 | hairline | 24');
  ok(!/\.settings-job-block\s*[{,+]/.test(settings),
    'views/settings.css declares NO .settings-job-block rule — the rhythm has one owner');
  ok(/\.settings-job-block/.test(settingsCss) && !/\.settings-job-block/.test(settings),
    'CONTROL: the stripper is load-bearing — settings.css still QUOTES the adjacency in the comment ' +
    'recording why .catalogue-sync’s hand-tuned pull was deleted, and that is prose, not a rule');

  for (const sel of ['.settings-block-hd', '.settings-block-num', '.settings-block-lede',
                     '.settings-block-body', '.settings-block-info', '.settings-job-title',
                     '.settings-job-lede', '.settings-block-unnumbered']) {
    const inShell = new RegExp('(?:^|,|\\})\\s*' + sel.replace('.', '\\.') + '[\\s,{:.]').test(shell);
    const inSettings = new RegExp('(?:^|,|\\})\\s*' + sel.replace('.', '\\.') + '[\\s,{:.]').test(settings);
    ok(inShell && !inSettings, `${sel} is declared in shell.css and not in views/settings.css`);
  }

  // The arithmetic travelled with the rules. Asserted here as well as in
  // test-next-button-family.js §6 because THIS is the suite that says where
  // the component lives, and a move that silently dropped a rule would leave
  // §6 reading a file that no longer has it.
  ok(/\.settings-block-lede \{ margin-left: 32px; \}/.test(shell) &&
     /\.settings-block-body \{ margin-left: 32px; \}/.test(shell),
    'the 32px prose indent moved UNCHANGED in value — numeral (20px) + gap (12px)');
  ok(/\.settings-job-lede \{[\s\S]*?max-width: 66ch;[\s\S]*?line-height: 1\.55;[\s\S]*?\}/.test(shell),
    'and so did the lede’s 66ch prose cap and its 1.55 leading');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3  renderInfoMark ESCAPES BY DEFAULT — HTML is an explicit opt-in');
// ═══════════════════════════════════════════════════════════════════════════
//
// The fold is the one caller-supplied fragment in a block, so it is the one
// place an injection could enter. The default has to be the safe one, and the
// opt-in has to be `=== true` rather than truthy — a stray string switching
// escaping off is not a theoretical shape in this repo (see shared/text.js's
// `infoHtml`, where the same decision was taken once already).

{
  const evil = '<script>alert(1)</script>';
  const esc = renderInfoMark('p1', 'About', evil);
  ok(esc.panel.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !esc.panel.includes('<script>'),
    'a <script> in the DEFAULT mode is escaped — it renders as text and cannot execute');

  const link = 'Read <a href="https://example.invalid/g">the guide</a>.';
  ok(renderInfoMark('p2', 'About', link).panel.includes('&lt;a href='),
    'an <a> in the default mode is escaped too — the default does not guess at intent');
  ok(renderInfoMark('p3', 'About', link, { html: true }).panel
       .includes('<a href="https://example.invalid/g">the guide</a>'),
    '…and SURVIVES with { html: true }, which is the whole point of the option');
  ok(renderInfoMark('p4', 'About', evil, { html: true }).panel.includes('<script>'),
    'CONTROL: { html: true } really does hand the caller the licence — so the default above is a real default');

  for (const truthy of [{ html: 1 }, { html: 'true' }, { html: 'yes' }, { html: {} }]) {
    ok(renderInfoMark('p5', 'About', link, truthy).panel.includes('&lt;a href='),
      `a TRUTHY \`html\` (${JSON.stringify(truthy)}) does not switch escaping off — the test is === true`);
  }

  ok(renderInfoMark('', 'About', 'text').btn === '' && renderInfoMark('', 'About', 'text').panel === '',
    'no id renders NOTHING, both fragments — a panel with no id is unreachable by the listener');
  ok(renderInfoMark('p6', 'About', '   ').btn === '',
    'whitespace-only prose renders nothing — an empty panel is a visible artefact claiming there is something to read');
  ok(renderInfoMark('p7', '', 'text').btn.includes('aria-label="More information"'),
    'an absent label falls back to "More information" rather than to an empty accessible name');
  ok(renderInfoMark('p8', 'About', 'text').btn.includes('id="p8-btn"') &&
     renderInfoMark('p8', 'About', 'text').panel.includes('id="p8"'),
    'the button takes the panel id + "-btn", which is the pairing shipped suites pin by name');
  ok(renderInfoMark('p9', 'About', 'text').btn.includes('data-tx-info="p9"'),
    'and the hook the ONE delegated listener in shared/text.js keys on');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  renderBlock THROWS on a missing id or title');
// ═══════════════════════════════════════════════════════════════════════════
//
// The opposite direction from renderInfoMark, deliberately. "Nothing to say"
// is a legitimate state for a fold; "no id" is not a legitimate block. Without
// an id, every block on the screen gets the same class AND every fold gets the
// same DOM id — and `document.getElementById` returns the first in document
// order, so a second block's prose exists in the DOM and is reachable by
// nobody. That is v3.54.0's renderViewHeader defect one layer up, and it shipped
// green.

function throwsWith(fn, needle) {
  try { fn(); return false; } catch (e) { return String(e.message).includes(needle); }
}
ok(throwsWith(() => renderBlock({ title: 'A title' }), 'id'),
  'a missing id throws, naming `id`');
ok(throwsWith(() => renderBlock({ id: '', title: 'A title' }), 'id'),
  'an EMPTY id throws too — falsy is not a value here');
ok(throwsWith(() => renderBlock({ id: '   ', title: 'A title' }), 'id'),
  'and a whitespace-only id, which would emit `settings-block-` and a fold id ending in a hyphen');
ok(throwsWith(() => renderBlock({ id: 'ok' }), 'title'),
  'a missing title throws, naming `title` — an empty <h2> is a heading with no text');
ok(throwsWith(() => renderBlock({ id: 'ok', title: '  ' }), 'title'),
  'and a whitespace-only title');
ok(throwsWith(() => renderBlock(), 'id'), 'a bare call throws rather than rendering an anonymous block');
ok(!throwsWith(() => renderBlock({ id: 'ok', title: 'Ok' }), 'id'),
  'CONTROL: id + title alone is enough — everything else really is optional');

// ═══════════════════════════════════════════════════════════════════════════
section('§5  THE COPIES THAT MUST NOT DRIFT — escapeHtml, and the glyph');
// ═══════════════════════════════════════════════════════════════════════════
//
// shared/block.js and shared/text.js each carry a copy of app.js's escapeHtml,
// because app.js touches `document` at import time and cannot be imported by a
// module that has to stay executable in an offline suite. A documented copy is
// only safe while somebody compares it.

{
  const appEscape = new Function(appEscapeSrc + '; return escapeHtml;')();
  const blockEscape = new Function(
    extractFunction(blockJs, 'escapeHtml', 'shared/block.js') + '; return escapeHtml;')();
  const textEscape = new Function(
    extractFunction(textJs, 'escapeHtml', 'shared/text.js') + '; return escapeHtml;')();
  const corpus = ['', 'plain', '<script>alert(1)</script>', 'a & b', '"quoted"', "it's",
    '<a href="x">y</a>', '&amp;', '— em dash', null, undefined, 0, 42, '<>&"\''];
  const bad = corpus.filter((v) => appEscape(v) !== blockEscape(v) || appEscape(v) !== textEscape(v));
  ok(bad.length === 0,
    'block.js, text.js and app.js escapeHtml agree over ' + corpus.length +
    ' inputs (disagreed on: ' + (bad.map((v) => JSON.stringify(v)).join(', ') || 'none') + ')');
  ok(appEscape('<a & b>') === '&lt;a &amp; b&gt;',
    'CONTROL: the comparison is against a real escaper, not three identity functions');

  const textGlyph = /const INFO_GLYPH =([\s\S]*?);\n/.exec(textJs);
  ok(!!textGlyph, 'CONTROL: shared/text.js’s INFO_GLYPH was located');
  ok(textGlyph[1].trim() === glyphM[1].trim(),
    'shared/text.js’s INFO_GLYPH and views/settings.js’s TX_INFO_GLYPH are the same bytes — ' +
    'one circled-i, two declarations, and §1 would go red the moment they differed');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
