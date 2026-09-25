/**
 * test-next-answer.js — OFFLINE suite for a chat ANSWER's rendering (v3.72.0,
 * DESIGN.md §5, package P2): shared/answer.js (numbered citations by first
 * appearance → { html, sources }, and the ONE Sources list), shared/answer.css
 * and shared/page-chip.css (the ONE page chip, shared with the reader).
 *
 * The Markdown passes themselves (quote, rule, heading levels, nesting, the
 * citation split) are proven in scripts/test-next-markdown.js §12; this suite
 * proves what answer.js builds on top of them, with the REAL renderer — not a
 * stub — so a change on either side goes red here.
 *
 * TECHNIQUE. Both modules are ES modules; markdown.js imports `icon` from the
 * /next shell, which needs a DOM. So each is loaded as TEXT, its import line
 * removed and its `export` keywords dropped, and evaluated with the imports
 * injected (the same technique test-next-memory-view.js uses for markdown.js).
 * A failed load THROWS — it never degrades into a green suite that tested
 * nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// ── Load the real modules ─────────────────────────────────────────────────
const mdText = read('shared/markdown.js');
const mdImport = /^import\s+\{\s*icon\s*\}\s+from\s+'\.\.\/app\.js';\s*$/m;
if (!mdImport.test(mdText)) throw new Error('markdown.js no longer imports exactly { icon } from ../app.js — update this loader');
const MD = new Function('icon', mdText.replace(mdImport, '').replace(/^export\s+/gm, '') +
  '\nreturn { renderMarkdown, escHtml };')(() => '<svg data-icon="dot"></svg>');

const anText = read('shared/answer.js');
const anImport = /^import\s+\{\s*renderMarkdown,\s*escHtml\s*\}\s+from\s+'\.\/markdown\.js';\s*$/m;
if (!anImport.test(anText)) throw new Error('answer.js no longer imports { renderMarkdown, escHtml } from ./markdown.js — update this loader');
if (/^import\s/m.test(anText.replace(anImport, ''))) throw new Error('answer.js gained a second import — it is meant to be pure');
const A = new Function('renderMarkdown', 'escHtml', anText.replace(anImport, '').replace(/^export\s+/gm, '') +
  '\nreturn { renderAnswer, sourcesHtml, sourceByNumber, pageTypeOf };')(MD.renderMarkdown, MD.escHtml);

const realTags = (h) => String(h).match(/<[^>]*>/g) || [];
const attrNames = (h) => realTags(h).flatMap((t) => [...t.matchAll(/\s([a-zA-Z:-]+)=/g)].map((m) => m[1]));
const liveAttr = (h) => realTags(h).some((t) => /\son[a-z]+\s*=/i.test(t) || /\s(?:href|src|style|title|formaction)\s*=/i.test(t));
// What a sighted reader sees: tags and visually-hidden text removed.
const face = (h) => String(h).replace(/<span class="visually-hidden">[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '');

// ═════════════════════════════════════════════════════════════════════════
section('1. Numbering — by first appearance, one number per page');
// ═════════════════════════════════════════════════════════════════════════
{
  const raw = 'Intro [source: concepts/b.md] then [source: entities/a.md, concepts/b.md].\n\n' +
              '- item [source: summaries/c.md]\n- again [source: entities/a.md]';
  const { html, sources } = A.renderAnswer(raw);
  ok(JSON.stringify(sources.map((s) => s.path)) === '["concepts/b.md","entities/a.md","summaries/c.md"]',
    'sources are listed in order of FIRST appearance');
  ok(JSON.stringify(sources.map((s) => s.n)) === '[1,2,3]', 'numbered 1..N');
  const nums = [...html.matchAll(/data-cite-n="(\d+)"/g)].map((m) => +m[1]);
  ok(JSON.stringify(nums) === '[1,2,1,3,2]', `inline markers carry those numbers, repeats re-use theirs (${nums})`);
  ok(nums.every((n) => sources[n - 1]), 'every inline number resolves to a listed source');
  ok(!/\.md/.test(face(html)), 'NO raw path on the answer face');
  ok(!/chat-citation-tag|chat-cite-path/.test(html), 'the legacy inline path tag is gone from an answer');

  // CROSS-CHECK the clever numbering with a dumb one: scan the raw text.
  const dumb = [];
  for (const m of raw.matchAll(/\[source:([^\]]*)\]/g)) for (const p of m[1].split(',')) {
    const k = p.trim(); if (k && !dumb.includes(k)) dumb.push(k);
  }
  ok(JSON.stringify(dumb) === JSON.stringify(sources.map((s) => s.path)), 'cross-check: a plain regex scan agrees on the order');

  const none = A.renderAnswer('No citations at all.');
  ok(none.sources.length === 0 && none.html === '<p>No citations at all.</p>', 'an uncited answer: no sources, plain html');
  ok(A.renderAnswer('').html === '' && A.renderAnswer(null).sources.length === 0, 'empty and null input do not throw');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. The server\'s citation list, titles and types');
// ═════════════════════════════════════════════════════════════════════════
{
  const { sources } = A.renderAnswer('See [source: entities/a.md].', {
    citations: ['entities/a.md', 'summaries/x.md, concepts/y.md', 42, null],
    titles: { 'entities/a.md': '  Dr A  ', 'concepts/y.md': '' },
  });
  ok(JSON.stringify(sources.map((s) => s.path)) === '["entities/a.md","summaries/x.md","concepts/y.md"]',
    'server citations are APPENDED after the inline ones, deduped, and a comma entry is split');
  ok(sources[0].title === 'Dr A', 'a server title is used, trimmed');
  ok(sources[1].title === 'X' && sources[2].title === 'Y', 'no title (or a blank one) → the humanised basename (the shipped fallback)');
  ok(A.renderAnswer('[source: summaries/how-i-built-it.md]').sources[0].title === 'How I Built It',
    'the fallback is character-for-character citationLabel\'s (views/chat.js)');
  const proto = A.renderAnswer('[source: constructor]', { titles: {} }).sources[0];
  ok(proto.title === 'Constructor', 'a path named `constructor` does not read a function off the prototype');

  const t = (p) => JSON.stringify(A.pageTypeOf(p));
  ok(t('entities/a.md') === '{"folder":"entities","type":"entity"}', 'pageTypeOf: entities');
  ok(t('concepts/a.md') === '{"folder":"concepts","type":"concept"}', 'pageTypeOf: concepts');
  ok(t('summaries/a.md') === '{"folder":"summaries","type":"summary"}', 'pageTypeOf: summaries');
  ok(t('a.md') === '{"folder":null,"type":"other"}' && t('__proto__/x') === '{"folder":null,"type":"other"}',
    'pageTypeOf: anything else is other');

  const { sources: s2 } = A.renderAnswer('[source: summaries/r&d.md]');
  ok(s2[0].path === 'summaries/r&d.md', 'a source path is RAW (`&`), ready for the reader fetch — never `&amp;`');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. sourceByNumber — the click resolves through the list, bounded');
// ═════════════════════════════════════════════════════════════════════════
{
  const { sources } = A.renderAnswer('[source: a.md, b.md]');
  ok(A.sourceByNumber(sources, 1).path === 'a.md' && A.sourceByNumber(sources, '2').path === 'b.md',
    'a marker\'s number (string from a dataset, or number) resolves to its page');
  for (const bad of [0, 3, -1, 1.5, 'x', '', null, undefined, '__proto__', '2" onclick="x']) {
    ok(A.sourceByNumber(sources, bad) === null, `sourceByNumber(${JSON.stringify(bad)}) cannot index outside the list`);
  }
  ok(A.sourceByNumber(null, 1) === null, 'no list → null');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. sourcesHtml — the ONE Sources list');
// ═════════════════════════════════════════════════════════════════════════
{
  const { sources } = A.renderAnswer('[source: entities/a.md, concepts/b.md, summaries/c.md, misc/d.md]');
  const h = A.sourcesHtml(sources);
  ok(h.includes('Sources · 4 pages'), 'the head counts the pages');
  ok(A.sourcesHtml(sources.slice(0, 1)).includes('Sources · 1 page<'), '…singular for one');
  ok(A.sourcesHtml([]) === '' && A.sourcesHtml(null) === '', 'no sources → no block at all');
  ok((h.match(/<button type="button" class="page-chip /g) || []).length === 4, 'one <button> page chip per source');
  for (const [ty, n] of [['entity', 1], ['concept', 2], ['summary', 3], ['other', 4]]) {
    ok(h.includes(`class="page-chip page-chip-${ty}" data-source-n="${n}"`), `source ${n} is drawn in the ${ty} colour`);
  }
  ok(!/\.md/.test(face(h)), 'no raw path on the face of the Sources list');
  ok(/<span class="visually-hidden">, concept page, concepts\/b\.md<\/span>/.test(h),
    'each chip\'s accessible name carries its type in words and its path');
  ok(!/\stitle=/.test(h), 'no title= tooltip (test-next-title-affordances): the path is in the accessible name');
  ok(/answer-legend[^>]*aria-hidden="true"/.test(h) && (h.match(/answer-legend-item/g) || []).length === 3,
    'the legend names the three page types present and is hidden from assistive tech (chips say it in words)');
  ok((A.sourcesHtml(A.renderAnswer('[source: entities/a.md]').sources).match(/answer-legend-item/g) || []).length === 1,
    'the legend names only the types on screen');

  // XSS — titles and paths are hostile input (a page's H1 is hand-editable).
  const evil = A.sourcesHtml([
    { n: 1, path: 'entities/<img src=x onerror=alert(1)>.md', type: 'entity', title: '<script>alert(1)</script>' },
    { n: 2, path: 'a" onclick="x', type: 'constructor', title: '" onmouseover="y' },
    { n: '3" onclick="z', path: 'b.md', type: 'summary', title: 'ok' },
    null,
  ]);
  ok(!/<script|<img/i.test(evil) && !liveAttr(evil), 'hostile titles/paths/types/numbers emit no live tag or attribute');
  ok(evil.includes('&lt;script&gt;') && evil.includes('&lt;img'), '…they are shown as escaped text, not dropped');
  ok(/page-chip-other" data-source-n="2"/.test(evil), 'an unknown or prototype-named type falls back to `other`');
  ok(/data-source-n="0"/.test(evil) && !/data-source-n="3"/.test(evil), 'a non-integer number is replaced, never interpolated');
  const attrs = [...new Set(attrNames(evil))].sort();
  ok(JSON.stringify(attrs) === '["aria-hidden","aria-label","class","data-source-n","type"]',
    `only fixed attributes are emitted (${attrs.join(',')})`);
  ok(realTags(evil).every((t) => !/data-source-n="[^"]*[^0-9"]/.test(t)), 'every data-source-n is digits only');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. The answer end to end — hostile input');
// ═════════════════════════════════════════════════════════════════════════
{
  const raw = '# <img src=x onerror=alert(1)>\n\n> <script>x</script>\n> — [source: a.md, [[b]]]\n\n' +
              '1. [source: " onclick="y.md]\n   - [source: <svg/onload=1>]\n\n---';
  const { html, sources } = A.renderAnswer(raw);
  ok(!liveAttr(html) && !/<(img|script|svg\/)/i.test(html), 'no live tag or attribute anywhere in a hostile answer');
  ok(sources.every((s) => !s.path.includes('<span')), 'no source path was built from renderer markup');
  ok(!sources.some((s) => s.path.includes(',')), 'no source path is comma-joined');
  const sh = A.sourcesHtml(sources);
  ok(!liveAttr(sh) && !/<(img|script)/i.test(sh), 'and its Sources list is inert too');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. Styles — answer.css, page-chip.css, the reader chip block');
// ═════════════════════════════════════════════════════════════════════════
{
  const index = read('index.html');
  const answerCss = stripComments(read('shared/answer.css'));
  const chipCss = stripComments(read('shared/page-chip.css'));
  const shell = stripComments(read('shell.css'));

  ok(/<link rel="stylesheet" href="\/next\/shared\/answer\.css">/.test(index), 'index.html links shared/answer.css');
  ok(/<link rel="stylesheet" href="\/next\/shared\/page-chip\.css">/.test(index), 'index.html links shared/page-chip.css');
  const at = (f) => index.indexOf('<link rel="stylesheet" href="/next/' + f + '">');
  ok(at('shared/page-chip.css') > 0 && at('shared/page-chip.css') < at('views/chat.css') &&
     at('shared/answer.css') > 0 && at('shared/answer.css') < at('views/chat.css'),
    'both load before the view stylesheets (the shared-component layer)');

  // The answer body is PRIMARY text (C7), and wins over chat.css's inherited --text-2.
  ok(/\.chat-msg-assistant \.chat-answer\s*\{[^}]*color:\s*var\(--text\);/.test(answerCss),
    'the answer body is --text (was inheriting --text-2 from .chat-msg-assistant — "less vivid")');
  ok(/\.chat-msg-assistant \.chat-answer\s*\{[^}]*max-width:\s*min\(var\(--prose-max\), 100%\)/.test(answerCss),
    'the answer column is the prose measure');

  // Heading levels out-rank chat.css's base `.chat-md-h` (loaded later).
  for (const lvl of [1, 2, 3, 4]) {
    ok(new RegExp('\\.chat-md-h\\.chat-md-h' + lvl + '\\b').test(answerCss), `.chat-md-h${lvl} is styled at (0,2,0), above the base class`);
  }
  ok(/\.chat-md-hr\s*\{[^}]*border-top:\s*1px solid var\(--border-subtle\)/.test(answerCss), 'the rule is a 1px --border-subtle line');
  ok(/blockquote\.chat-md-quote\s*\{[^}]*border-left:\s*2px solid var\(--border-strong\)/.test(answerCss), 'the quote has its 2px --border-strong rule');
  ok(/p\.chat-md-attrib\s*\{[^}]*color:\s*var\(--text-2\)/.test(answerCss), 'the attribution is one step back, --text-2');

  // The marker: a small glyph with a --hit-min TARGET (the sanctioned technique).
  ok(/\.chat-cite-n\s*\{[^}]*position:\s*relative/.test(answerCss) &&
     /\.chat-cite-n::before\s*\{[^}]*inset:\s*calc\(\(var\(--hit-min\) - 16px\) \/ -2\)/.test(answerCss),
    'the 16px marker grows its pointer target to --hit-min with a positioned ::before');
  ok(/\.chat-cite-n\s*\{[^}]*color:\s*var\(--text-2\)/.test(answerCss), 'the marker number is --text-2 (AA), not --text-3');

  // ONE page chip: type is the dot, label is neutral — for Chat AND the reader.
  ok(/\.page-chip,\s*\.reader-tag-chip\s*\{/.test(chipCss), 'the reader\'s chip is GROUPED onto the one .page-chip rule');
  for (const t of ['entity', 'concept', 'summary']) {
    ok(new RegExp('\\.page-chip-' + t + ',\\s*\\.reader-chip-' + t + '\\s*\\{\\s*background:\\s*var\\(--type-' + t + '-tint\\);\\s*\\}').test(chipCss),
      `${t}: one rule gives both surfaces the ${t} tint and NOTHING else`);
    ok(new RegExp('\\[data-theme="light"\\] \\.page-chip-' + t + '\\s+\\.page-chip-dot').test(chipCss),
      `${t}: the light-theme dot is darkened to clear 3:1`);
  }
  ok(!/color:\s*var\(--type-/.test(chipCss), 'no chip LABEL takes a type colour (the AA failure on light)');
  ok(/button\.page-chip\s*\{[^}]*height:\s*var\(--hit-min\)/.test(chipCss), 'a chip that is a button meets --hit-min');
  ok(!/\.reader-chip-(entity|concept|summary|plain)\s*\{/.test(shell) && !/\.reader-tag-chip\s*\{/.test(shell),
    'shell.css no longer declares the reader chips (one declaration, not two kept in step)');
  ok(/\.reader-tags\s*\{/.test(shell) && /\.reader-type-dot\s*\{/.test(shell),
    'CONTROL: shell.css\'s neighbouring reader rules are untouched');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All answer-rendering assertions green');
process.exit(0);
