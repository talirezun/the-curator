/**
 * markdown.js — tiny, dependency-free, XSS-safe Markdown renderer for chat answers.
 *
 * The chat answer is LLM output (from the user's own wiki, but still untrusted
 * input for rendering purposes). The ONLY safe order is:
 *   1. HTML-escape the entire string FIRST, so nothing in the content can ever
 *      become a live tag/attribute.
 *   2. THEN insert a small, fixed set of safe tags (<strong>, <em>, <code>,
 *      <pre>, <ul>/<ol>/<li>, <p>, <br>, and a couple of styled <span>s) by
 *      matching Markdown syntax in the already-escaped text.
 * Because step 1 ran first, an injected `<script>` is already `&lt;script&gt;`
 * and step 2 only ever emits literal, known tags — no user text is interpolated
 * into an attribute or a URL. No external dependencies, no innerHTML of raw
 * content anywhere.
 *
 * Loaded as a plain browser <script> (sets window.renderChatMarkdown) and also
 * evaluated in Node for tests via `new Function('window', src)`.
 */
(function (root) {
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Format the non-code portions of a line (bold, italic, citations, wikilinks).
  // Input is ALREADY html-escaped. Returns safe HTML.
  function formatSegment(t) {
    // ── DELIBERATELY UNBOUNDED — read before widening this renderer's input ──
    // The two regexes below (`[^\]]+` / `[^\]|]+`) are QUADRATIC on a string
    // of unclosed brackets: at every `[` the greedy class runs to end-of-input
    // hunting a closer that never arrives, then backtracks. Measured on the
    // identical algorithm: 64 KB -> ~1,890 ms, 1 MB -> ~70 s, synchronous on
    // the main thread. `/next`'s copy in next/shared/markdown.js IS bounded
    // (`{1,512}`, derived from the real corpus: longest wikilink 241, longest
    // citation path 205).
    //
    // This copy is left unbounded ON PURPOSE, and the reason is the whole
    // point: it only ever renders CHAT ANSWERS — the user's own LLM output,
    // paid for by them. No third party's bytes reach it, so the quadratic is
    // not reachable by an attacker HERE. What made it a real finding in
    // `/next` was not the algorithm but WHO CAN REACH IT: that renderer was
    // widened to wiki page bodies, which arrive over Personal Sync and Shared
    // Brain mirrors from other machines and other people.
    //
    // THEREFORE: if you ever render anything here that did not originate as
    // this user's own chat answer — a wiki page, a synced file, a mirror, an
    // imported document — BOUND THESE FIRST. The divergence from /next is
    // recorded rather than "fixed" because bounding this copy would change
    // live chat rendering (a >512-char token degrades to literal text) for no
    // reachable threat. Maintainer decision, v3.8.0.
    //
    // Citation chips: [source: path] → styled span. No `\s*` adjacent to the
    // capture group (avoids O(n^2) backtracking on an unclosed tag); the leading
    // space after "source:" is trimmed in the callback instead.
    t = t.replace(/\[source:([^\]]+)\]/g,
      function (_, p) { return '<span class="citation-tag">[source: ' + p.trim() + ']</span>'; });
    // Wikilinks: [[target]] or [[target|alias]] → readable styled span.
    t = t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (_, target, alias) {
      var label = (alias != null ? alias : String(target).split('/').pop().replace(/\.md$/, '')).trim();
      return '<span class="md-wikilink">' + label + '</span>';
    });
    // Bold then italic. (** before * so bold isn't eaten by italic.)
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return t;
  }

  // Inline formatting on ALREADY-ESCAPED text. Returns safe HTML.
  // Inline code spans are handled by STRUCTURALLY SPLITTING the text on them
  // (odd segments are the code spans) rather than a text sentinel — so answer
  // text can never forge a placeholder, and code contents are never re-formatted.
  function renderInline(text) {
    var parts = String(text).split(/(`[^`\n]+`)/g);
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) out += '<code>' + parts[i].slice(1, -1) + '</code>';  // the `…` span
      else out += formatSegment(parts[i]);
    }
    return out;
  }

  function renderChatMarkdown(raw) {
    var escaped = escHtml(raw);
    var lines = escaped.split('\n');
    var out = [];

    var inCode = false;
    var codeBuf = [];
    var listType = null;      // 'ul' | 'ol' | null
    var listBuf = [];
    var para = [];

    var flushPara = function () {
      if (para.length) {
        out.push('<p>' + para.map(renderInline).join('<br>') + '</p>');
        para = [];
      }
    };
    var flushList = function () {
      if (listType) {
        out.push('<' + listType + '>' + listBuf.join('') + '</' + listType + '>');
        listBuf = [];
        listType = null;
      }
    };

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];

      if (/^\s*```/.test(line)) {
        if (inCode) {
          out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>');
          codeBuf = [];
          inCode = false;
        } else {
          flushPara();
          flushList();
          inCode = true;
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }

      var h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); flushList(); out.push('<div class="md-h">' + renderInline(h[2]) + '</div>'); continue; }

      var bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        flushPara();
        if (listType && listType !== 'ul') flushList();
        listType = 'ul';
        listBuf.push('<li>' + renderInline(bullet[1]) + '</li>');
        continue;
      }

      var num = line.match(/^\s*\d+\.\s+(.*)$/);
      if (num) {
        flushPara();
        if (listType && listType !== 'ol') flushList();
        listType = 'ol';
        listBuf.push('<li>' + renderInline(num[1]) + '</li>');
        continue;
      }

      // Plain text line → part of a paragraph.
      flushList();
      para.push(line);
    }

    flushPara();
    flushList();
    if (inCode) out.push('<pre><code>' + codeBuf.join('\n') + '</code></pre>');

    return out.join('');
  }

  root.renderChatMarkdown = renderChatMarkdown;
  root.escHtml = root.escHtml || escHtml;
})(typeof window !== 'undefined' ? window : this);
