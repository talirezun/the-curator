/**
 * test-chat-markdown.js — OFFLINE suite for the chat Markdown renderer.
 *
 * The renderer turns LLM Markdown into safe HTML for the chat bubble. The
 * cardinal rule is XSS safety: escape FIRST, then insert only a fixed set of
 * safe tags. This suite loads the browser file in a Node sandbox and asserts
 * both the safety invariant and the formatting.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '..', 'src/public/markdown.js'), 'utf8');
const fakeWindow = {};
// Run the browser IIFE with a fake window to capture the export (no DOM needed).
new Function('window', src)(fakeWindow);
const { renderChatMarkdown } = fakeWindow;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── 1. XSS safety — the whole point ─────────────────────────────────────────
section('1. XSS safety — raw HTML in the answer never becomes live markup');
{
  const evil = 'Hello <script>alert(1)</script> and <img src=x onerror=alert(2)> world';
  const html = renderChatMarkdown(evil);
  ok(!/<script/i.test(html), 'no live <script> tag');
  ok(!/<img/i.test(html), 'no live <img> tag');
  ok(/&lt;script&gt;/.test(html), 'the script text is escaped (&lt;script&gt;)');
  ok(!/onerror=/.test(html) || /&lt;img/.test(html), 'onerror payload is neutralised (escaped)');

  // A bold-wrapped injection: escaping still wins.
  const evil2 = '**<b>bold</b>**';
  const h2 = renderChatMarkdown(evil2);
  ok(h2.includes('<strong>') && h2.includes('&lt;b&gt;'), 'markdown bold applied, inner HTML still escaped');

  // Attribute-injection attempt via wikilink / source — quotes are escaped to
  // &quot;, so no REAL attribute (name="value" with a live quote) can form.
  const h3 = renderChatMarkdown('[[a" onmouseover="x]] and [source: b" onclick="y]');
  ok(!/ on\w+=["'][^"']*["']/.test(h3), 'no live event-handler attribute forms');
  ok(!/["'] on\w+=/.test(h3), 'no attribute break-out via a live quote');
  ok(!/&quot;/.test(h3) === false, 'the injected quotes are present but escaped (&quot;)');
  ok(!/ href=| src=/i.test(h3), 'renderer never emits href/src attributes');
}

// ── 2. Block formatting ─────────────────────────────────────────────────────
section('2. Block formatting');
{
  const h = renderChatMarkdown('### A heading\n\nSome text.');
  ok(/<div class="md-h">A heading<\/div>/.test(h), 'ATX heading → styled heading div');
  ok(/<p>Some text\.<\/p>/.test(h), 'paragraph wrapped in <p>');

  const bullets = renderChatMarkdown('- one\n- two\n- three');
  ok(/<ul><li>one<\/li><li>two<\/li><li>three<\/li><\/ul>/.test(bullets), 'dash bullets → <ul>');

  const star = renderChatMarkdown('* alpha\n* beta');
  ok(/<ul><li>alpha<\/li><li>beta<\/li><\/ul>/.test(star), 'star bullets → <ul>');

  const nums = renderChatMarkdown('1. first\n2. second');
  ok(/<ol><li>first<\/li><li>second<\/li><\/ol>/.test(nums), 'numbered list → <ol>');

  const code = renderChatMarkdown('```\nconst x = 1 < 2;\n```');
  ok(/<pre><code>const x = 1 &lt; 2;<\/code><\/pre>/.test(code), 'fenced code block, contents escaped, not formatted');

  // A list following a paragraph, both present.
  const mixed = renderChatMarkdown('Intro line.\n\n- a\n- b\n\nOutro.');
  ok(/<p>Intro line\.<\/p>/.test(mixed) && /<ul>/.test(mixed) && /<p>Outro\.<\/p>/.test(mixed),
    'paragraph + list + paragraph all render');
}

// ── 3. Inline formatting ────────────────────────────────────────────────────
section('3. Inline formatting');
{
  ok(/<strong>bold<\/strong>/.test(renderChatMarkdown('**bold**')), '**bold** → <strong>');
  ok(/<em>italic<\/em>/.test(renderChatMarkdown('this is *italic* here')), '*italic* → <em>');
  ok(/<code>x=1<\/code>/.test(renderChatMarkdown('`x=1`')), 'inline `code` → <code>');
  // Bold containing what looks like italic markers should stay bold (no nesting mangle).
  ok(/<strong>a and b<\/strong>/.test(renderChatMarkdown('**a and b**')), 'bold not split by internal spaces');
  // Underscores inside a word (snake_case slug) are NOT italicised.
  const snake = renderChatMarkdown('the file my_cool_page is here');
  ok(!/<em>/.test(snake), 'intra-word underscores are not italic (my_cool_page)');

  // Audit fix: the old code-span placeholder was a forgeable " CODEn " token.
  // The structural-split renderer has no text sentinel, so literal answer text
  // that looks like a placeholder is left completely intact.
  const forge1 = renderChatMarkdown('The variable CODE0 holds state.');
  ok(forge1.includes('CODE0') && !/<code>/.test(forge1) && !/undefined/.test(forge1),
    'literal " CODE0 " token is NOT treated as a code placeholder (no forgery, no undefined)');
  const forge2 = renderChatMarkdown('Here is `real` and also a fake CODE0 token.');
  ok(/<code>real<\/code>/.test(forge2) && forge2.includes('CODE0'),
    'a real code span renders AND the literal CODE0 stays literal (no swap)');
}

// ── 4. Chat-specific tokens ─────────────────────────────────────────────────
section('4. Citation chips + wikilinks');
{
  const cite = renderChatMarkdown('See [source: concepts/rag.md] for details.');
  ok(/<span class="citation-tag">\[source: concepts\/rag\.md\]<\/span>/.test(cite), 'citation chip rendered');

  const wl = renderChatMarkdown('The [[concepts/rag.md]] page and [[tali-rezun|Dr. Rezun]] both apply.');
  ok(/<span class="md-wikilink">rag<\/span>/.test(wl), 'wikilink shows readable slug (folder/.md stripped)');
  ok(/<span class="md-wikilink">Dr\. Rezun<\/span>/.test(wl), 'aliased wikilink shows the alias');
}

// ── 5. Defensive ────────────────────────────────────────────────────────────
section('5. Defensive inputs');
{
  ok(renderChatMarkdown('') === '', 'empty string → empty');
  ok(typeof renderChatMarkdown(null) === 'string', 'null → string (no throw)');
  ok(typeof renderChatMarkdown(undefined) === 'string', 'undefined → string (no throw)');
  ok(renderChatMarkdown('plain sentence.') === '<p>plain sentence.</p>', 'plain text → single paragraph');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat-markdown offline assertions green');
