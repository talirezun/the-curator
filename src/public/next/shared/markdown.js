// Shared: the /next Markdown renderer.
//
// ONE renderer, two surfaces. It renders chat answers (views/chat.js) AND
// wiki page bodies in the reader overlay (views/domains.js). It used to live
// inside views/chat.js, where a second surface could not reach it without
// importing another view's internals — so the wiki-browse reader shipped
// escaped Markdown SOURCE inside a <pre> instead. Copying an escape-first
// security guard into a second file was the wrong answer to that (two
// hand-maintained copies of a guard is the shape that produced the v3.2.0
// CRITICAL, and this repo pins duplicated frontend helpers with a drift
// suite precisely because such copies rot). Lifting it here is the right
// one: there is exactly one copy, and scripts/test-next-markdown.js §0 goes
// RED if a second declaration ever reappears anywhere in /next. That guard
// WALKS the whole src/public/next tree rather than checking a list of files
// that someone remembered to name. It WAS such a list — three paths — and an
// audit defeated it by pasting a renderer into a fourth view while the suite
// stayed green, so the sentence above was untrue for exactly as long as it
// was unenforced. Matched now: plain / exported / `export default` / async
// function declarations, and const/let/var function expressions.
//
// NOT ENFORCED, deliberately and explicitly — because a guard that overstates
// its reach is what produced the bug above. It is NAME-scoped, not
// algorithm-scoped: a copy pasted under a different name (`renderPageBody`)
// evades it entirely, as do a class method, an object property, a
// `globalThis` assignment, and an aliased re-export
// (`export { renderMd as renderMarkdown }`). It walks `.js` only. So it
// proves "no second thing CALLED renderMarkdown", not "no second copy of
// this algorithm". Same convention as health.js §8c.
//
// The algorithm is the shipping app's src/public/markdown.js, plus two
// /next-only additions recorded below. Both files are maintained; they are
// NOT byte-identical and are not asserted to be (the shipping one is a
// window-attaching IIFE loaded by a <script> tag, this one is an ES module).
//
// ── THE CARDINAL RULE — never violate this with an edit here ─────────────
// Escape the WHOLE string FIRST (escHtml below), then insert only a small,
// FIXED allow-list of tags by matching Markdown syntax in the ALREADY-
// ESCAPED text. Because step 1 ran first, an injected `<script>` is already
// `&lt;script&gt;` by the time any pass looks at it, and every pass below
// only ever emits literal, known tags. No input text is EVER interpolated
// into an attribute or a URL, and this renderer emits no href/src sink at
// all — so there is nothing for a `javascript:` payload to reach.
//
// ── WHY THAT MATTERS MORE NOW THAN IT DID IN views/chat.js ───────────────
// This renderer's input surface WIDENED when the wiki reader started using
// it. It used to see only LLM chat answers. It now also sees WIKI PAGE
// BODIES, which are LLM-authored AND hand-editable in Obsidian AND arrive
// over Personal Sync and Shared Brain mirrors — i.e. content another
// person's machine wrote. Treat every argument to renderMarkdown() as
// hostile input, because some of it now genuinely is. A wiki page is also
// exactly the kind of document that legitimately contains raw HTML in its
// prose, so "escape first" is load-bearing on ordinary content, not only on
// attacks. scripts/test-next-markdown.js §8 runs that battery.
//
// ── THE EMITTED CLASS NAMES KEEP THEIR chat- PREFIX, DELIBERATELY ────────
// `chat-md-h` / `chat-wikilink` / `chat-citation-tag` / `chat-cite-path`
// read as chat-specific now that the wiki reader emits them too. They were
// NOT renamed, and the reason is the lift itself: renaming would change this
// renderer's output in the same change that moved it, and the proof the move
// was safe is that its output is byte-identical for a 98-input corpus before
// and after. A rename is a separate, mechanical change that can be made on
// its own evidence. THREE of them — `chat-md-h`, `chat-wikilink`,
// `chat-citation-tag` — are styled UNSCOPED in views/chat.css (which
// index.html loads globally), so they already reach the reader overlay; that
// file also carries the supplemental `.reader-body-text` rules the reader
// needs. See the "SHARED MARKDOWN RENDERER" section there. `chat-cite-path`
// has NO rule anywhere and is not meant to: it is a SELECTOR HOOK for the
// click handler in views/chat.js, holding the path as text content rather
// than an attribute (the M3 fix below), and it inherits its look from the
// `.chat-citation-tag` parent. An earlier version of this note said all four
// were styled; that was false, harmlessly, and is corrected here rather than
// left to mislead the next reader.
//
// `icon` is the only thing this module takes from the shell. The import is
// safe despite app.js importing the views that import this file: it is only
// ever CALLED at render time, never during module evaluation, so the ESM
// cycle is resolved long before the binding is read.
import { icon } from '../app.js';

// ── /next addition 1 ─────────────────────────────────────────────────────
// Citation spans carry their path in a nested `.chat-cite-path` TEXT node
// (never an attribute — see the M3 note inside formatSegment) so a single
// delegated click handler on the chat thread can open the reader from an
// inline "[source: ...]" mention. The wiki reader emits the same markup but
// wires no handler, so the chip is inert there; chat.css turns off its
// pointer cursor inside `.reader-body-text` so it does not advertise a
// click that does nothing.
//
// ── /next addition 2 ─────────────────────────────────────────────────────
// The citation pass runs LAST in formatSegment rather than first (the
// shipping renderer's order). That ordering is a fix, not a preference —
// the reasons are recorded in full at the call site and must be read before
// reordering anything in that function.

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── WHY THE TWO WIKI-TOKEN PASSES CARRY A LENGTH BOUND ───────────────────
// The wikilink and citation regexes below use `{1,512}` where the obvious
// spelling is `+`. That is a ReDoS fix, and the bound is MEASURED, not
// guessed — do not "tidy" it back to `+`, and do not tighten it without
// re-running the measurement recorded here.
//
// THE PROBLEM. `\[\[([^\]|]+)…\]\]` on a string of UNCLOSED brackets is
// quadratic: at every `[[` the greedy class runs to end-of-input hunting a
// `]]` that never arrives, then backtracks the whole way. n start positions
// × O(n) work each = O(n²). Measured on this module, before the bound.
// THESE ARE THE REPRODUCIBLE FIGURES — taken in isolated node processes on
// an IDLE machine, and independently reproduced three times to within 1%:
//     '[['.repeat(8000)        (16 KB)  →       120 ms
//     '[['.repeat(16000)       (32 KB)  →       469 ms   (2× input, 3.9× time)
//     '[['.repeat(32000)       (64 KB)  →     1,890 ms   (2× input, 4.0× time)
//     '[source:'.repeat(32000) (256 KB) →     3,300 ms
//     '[source:'.repeat(128000)( 1 MB)  →    ~70 s
// After the bound, every one of those doubles rather than quadruples.
//
// An earlier draft of this block recorded the `[[` numbers ~10× HIGHER
// (1,367 / 19,194 ms, and ">5 minutes" for the 1 MB case, which also
// contradicted the 69,422 ms the test suite recorded for the SAME input in
// the same change). Those were measured on a machine running a 300k-input
// fuzz, twelve test-suite invocations and a browser concurrently. Recorded
// here because the same contention produced a FALSE RETRACTION of this whole
// finding: a re-measurement taken against the already-bounded file concluded
// the renderer had always been linear. Take timings in isolated processes on
// an idle box, and note the SCALING EXPONENT — it survives contention, and a
// single wall-clock pair does not.
// Benign prose of the same size is milliseconds. `renderMarkdown` runs
// SYNCHRONOUSLY on the main thread straight into innerHTML, so that is a
// frozen tab, not a slow one.
//
// WHY IT IS A FINDING NOW, THOUGH THE ALGORITHM IS OLD. The identical
// algorithm sits in the shipping src/public/markdown.js and is not a fix
// there, because that renderer only ever sees the user's OWN LLM chat
// answers. Lifting this renderer to serve the wiki reader widened its input
// to WIKI PAGE BODIES — hand-editable in Obsidian and arriving over Personal
// Sync and Shared Brain mirrors from other machines and other people. The
// change is not the algorithm, it is WHO CAN REACH IT: one hostile page in a
// mirror freezes a victim's tab. Bounding the quantifiers turns O(n²) into
// O(bound·n), which is linear in page size.
//
// THE FLOOR — WHY 512 AND NOT 200. Measured against the maintainer's real
// corpus (5,221 wiki pages, 36,910 wikilinks, 53 chat conversations):
//     longest real wikilink TARGET   241 chars ("knowledge-preservation-and-…")
//     longest real wikilink ALIAS     40 chars
//     longest real [source:] path    205 chars (an LLM wrote TWO comma-joined
//                                     summary paths inside one [source: …])
//     page bytes  median 1,097 · p99 6,990 · max 314,971
// A 200-char bound — the intuitive round number — would have SILENTLY broken
// a real link in that wiki and a real citation in those conversations. 512 is
// ~2.1× the longest observed token, and is applied POST-escape (escHtml has
// already run, so an `&` in a token costs 5 characters here, not 1).
//
// THE DEGRADATION IS SAFE. A token longer than the bound simply fails to
// match and renders as literal text — no partial match, no half-formed span:
// the leading `[[` is the only anchor, and once it fails the scan moves past
// it. Nothing about the escape-first cardinal rule is weakened, because the
// bound only ever makes the renderer emit LESS markup, never more.
function formatSegment(t) {
  // Wikilinks: [[target]] or [[target|alias]] -> readable, non-interactive
  // styled span (matches the shipping renderer's behaviour — resolving a
  // bare wikilink to a folder+slug would require guessing which of
  // entities/concepts it lives in, which the shipping app also declines
  // to do here). `{1,512}` on both capture groups: see the bound note above.
  t = t.replace(/\[\[([^\]|]{1,512})(?:\|([^\]]{1,512}))?\]\]/g, (_, target, alias) => {
    const label = (alias != null ? alias : String(target).split('/').pop().replace(/\.md$/, '')).trim();
    return '<span class="chat-wikilink">' + label + '</span>';
  });
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  // Citation chips: [source: path] -> clickable styled span. MUST run LAST
  // in this function (adversarial-audit finding M1, verified against the
  // real HTML parser): every pass above scans the WHOLE string for its own
  // syntax, including HTML this function has already emitted. When this
  // ran FIRST, a crafted `[source: x[[y] tail]]` made the wikilink pass's
  // `[[...]]` match START INSIDE this span's data-cite="..." attribute
  // value and END at the "]]" much later in the string — its replacement
  // deleted everything in between, including the closing `">` and
  // `</span>`, leaving the attribute unterminated for the rest of the
  // document (a real attribute-breakout; not exploitable today only
  // because nothing downstream of this span carries a second attribute or
  // a URL sink — one added attribute away from live XSS). Running this
  // pass last means nothing downstream ever re-scans its output, so no
  // ordering of characters inside `path` can reach into markup this
  // function already emitted.
  //
  // No `\s*` adjacent to the capture group (avoids backtracking on an
  // unclosed tag); the leading space after "source:" is trimmed below.
  // `path` is extracted from `t`, which was already HTML-escaped ONCE by
  // renderMarkdown's top-level escHtml(raw) before any pass ran — do NOT
  // escape it again here (that was the separate L5 bug: a citation path
  // containing "&" got re-escaped from "&amp;" to "&amp;amp;", which the
  // browser only unescapes one level on click, so the fetch 404'd on a
  // filename that actually existed).
  // M3 fix (re-audit finding): this used to drop `path` straight into a
  // `data-cite="..."` ATTRIBUTE. Citation must stay LAST in this function
  // (see the big comment above — moving it earlier reopens the M1 bracket-
  // consumption bug), which means by the time this pass runs, `path` can
  // already contain markup the wikilink pass emitted a moment ago (e.g. a
  // citation string that itself embeds a `[[...]]` sequence). That markup
  // carries real `"` characters as part of `class="chat-wikilink"` — reading
  // it into an attribute value lets those quotes close the attribute early.
  // Verified: `[source: [[a]] onerror=alert(1) ]` produced
  // `data-cite="<span class="chat-wikilink">a</span> onerror=alert(1)">` —
  // the attribute terminates at the FIRST `"`, right after `class=`, leaving
  // the rest as loose, unintended markup. Not live script execution today
  // (nothing downstream reads that broken value as a URL/handler), but it is
  // one added attribute away from it, and it already lets a crafted citation
  // repoint or corrupt what the click handler treats as a path.
  //
  // Fix: keep `path` in TEXT CONTENT instead (mirrors the shipping
  // renderer's approach — src/public/markdown.js:36 — adjusted for this
  // file's citation-LAST ordering). Text content is never re-parsed as
  // markup by the browser, so no character sequence inside it can break out
  // of anything; the click handler below reads it back via `.textContent`
  // on the dedicated `.chat-cite-path` child instead of a data attribute.
  //
  // `{1,512}` rather than `+`: same ReDoS bound as the wikilink pass, same
  // derivation — see the bound note above formatSegment. The longest real
  // citation path measured is 205 chars, so this is ~2.5× the observed max.
  t = t.replace(/\[source:([^\]]{1,512})\]/g, (_, p) => {
    const path = p.trim();
    return '<span class="chat-citation-tag">' + icon('dot', 7) +
      '<span class="chat-cite-path">' + path + '</span></span>';
  });
  return t;
}

function renderInline(text) {
  const parts = String(text).split(/(`[^`\n]+`)/g);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) out += '<code>' + parts[i].slice(1, -1) + '</code>';
    else out += formatSegment(parts[i]);
  }
  return out;
}

export function renderMarkdown(raw) {
  const escaped = escHtml(raw);
  const lines = escaped.split('\n');
  const out = [];

  let inCode = false;
  let codeBuf = [];
  let listType = null;
  let listBuf = [];
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.map(renderInline).join('<br>') + '</p>'); para = []; }
  };
  const flushList = () => {
    if (listType) { out.push('<' + listType + '>' + listBuf.join('') + '</' + listType + '>'); listBuf = []; listType = null; }
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    if (/^\s*```/.test(line)) {
      if (inCode) { out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>'); codeBuf = []; inCode = false; }
      else { flushPara(); flushList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }

    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push('<div class="chat-md-h">' + renderInline(h[2]) + '</div>'); continue; }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listBuf.push('<li>' + renderInline(bullet[1]) + '</li>');
      continue;
    }

    const num = line.match(/^\s*\d+\.\s+(.*)$/);
    if (num) {
      flushPara();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listBuf.push('<li>' + renderInline(num[1]) + '</li>');
      continue;
    }

    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  if (inCode) out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>');

  return out.join('');
}
