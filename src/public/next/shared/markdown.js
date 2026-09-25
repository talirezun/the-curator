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

// ── /next addition 3 ─────────────────────────────────────────────────────
// GFM TABLES. The shipping renderer has no table pass and neither did this
// one, so a model that emitted a perfectly ordinary Markdown table got its
// rows dumped into a single <p> joined by <br> — pipes, dashes and all.
// Reported from real use against a table an LLM wrote correctly; the bug was
// entirely ours, which is why the fix belongs HERE, in the one renderer both
// surfaces share, rather than in a prompt. Wiki pages carry tables too (this
// repo's own CLAUDE.md is mostly one), so the reader gains them in the same
// change.
//
// The parse is deliberately NOT a regex over the whole block. Cells are
// split by a LINEAR character scan (splitTableRow) and the delimiter row is
// validated cell-by-cell against a single anchored pattern — no alternation,
// no nesting, nothing that can backtrack. That is the same discipline the
// ReDoS note above forced on the two token passes, applied before it could
// become a finding rather than after.

// ── /next addition 4 (v3.72.0) ───────────────────────────────────────────
// The answer overhaul (DESIGN.md §5, package P2). Five block/inline shapes a
// real answer uses and this renderer used to print literally or flatten:
//   · `> quote` became a literal `&gt; …` paragraph — the core shape of a
//     "give me ten quotes" answer. Now a <blockquote class="chat-md-quote">,
//     with a trailing "— Name" line kept inside it as `.chat-md-attrib`.
//   · `---` / `***` / `___` were a literal paragraph. Now <hr class="chat-md-hr">.
//   · `#`–`######` all collapsed into one `.chat-md-h`. Each heading keeps that
//     class AND gains a level class (`chat-md-h1` … `chat-md-h4`, where 4
//     covers 4–6), so hierarchy survives without changing the base class the
//     reader's own rules select.
//   · A nested bullet split an <ol> into ol / ul / ol start=2. ONE level of
//     nesting is now honoured (an indented marker inside an open list), and an
//     indented non-marker line directly under an item continues that item.
//   · `[source: a.md, b.md]` became ONE tag holding the comma-joined string,
//     which opened the reader on a path that does not exist. It is now split
//     on commas into one marker per path — see citationMarkup().
// Every one of these passes runs on the ALREADY-ESCAPED text, exactly like the
// passes before them; none of them interpolates input into an attribute. The
// only new attribute VALUES are literals of this file and an integer the
// caller's citation hook returned (validated below). scripts/test-next-
// markdown.js §12 carries an XSS case per new pass.
//
// Exported so shared/answer.js escapes titles with the SAME function rather
// than a second hand-maintained copy of it.
export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The exact inverse of escHtml, for ONE purpose: handing a citation path to the
// caller's hook as the string the model wrote, so a path containing `&` is not
// fetched as `&amp;` (the L5 bug, recorded in formatSegment). It is only ever
// applied to text escHtml produced and no pass has since wrapped in markup
// (citationMarkup refuses a path containing `<`), so every `&` in it begins
// one of the five entities below. `&amp;` is undone LAST, or `&amp;lt;`
// (an input that literally said "&lt;") would be decoded twice.
function unescHtml(s) {
  return String(s)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
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
function formatSegment(t, cite) {
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
  t = t.replace(/\[source:([^\]]{1,512})\]/g, (_, p) => citationMarkup(p, cite));
  return t;
}

// ── ONE CITATION, ONE MARKER PER PATH (v3.72.0) ───────────────────────────
// `p` is the text between `[source:` and `]`, ALREADY ESCAPED, and — because
// this pass runs last — possibly carrying markup an earlier pass emitted (a
// `[[wikilink]]` inside the brackets). Every real `<` in it is therefore OURS:
// input `<` became `&lt;` before any pass ran.
//
// TWO MODES, chosen by the caller:
//   · no hook (the wiki reader, Context's documents, and chat until the view
//     adopts shared/answer.js): the inert legacy tag, one per path. A single
//     path renders BYTE-IDENTICALLY to before, so every reader surface is
//     unchanged; a comma list now renders one tag per path instead of one tag
//     holding "a.md, b.md".
//   · a `cite` hook (shared/answer.js): the hook is handed the RAW path and
//     returns the marker's number. Only a positive integer is accepted — the
//     number is the ONLY caller-supplied value that reaches an attribute, and
//     it is re-stringified from a Number here, never taken as text. Each
//     marker is a real <button> (keyboard-reachable), shows only its number,
//     and names its path in visually-hidden text; the path never sits in an
//     attribute. The page it opens is resolved by the NUMBER from the list the
//     hook built, never read back out of the DOM.
//
// A capture that contains markup is refused as a path in BOTH modes' sense:
// splitting it on commas could cut through a tag we emitted (a wikilink alias
// may itself contain a comma), and its text is a LABEL, not a path. With no
// hook it keeps the legacy single tag (byte-identical, inert on every reader
// surface). With a hook it becomes inert text with no marker, so nothing ever
// opens a comma-joined or label-derived path.
function citationMarkup(p, cite) {
  const hooked = typeof cite === 'function';
  if (p.indexOf('<') !== -1) {
    if (hooked) return '<span class="chat-cite-unresolved">[source:' + p + ']</span>';
    return legacyCitationTag(p.trim());
  }
  const parts = p.split(',').map((s) => s.trim()).filter(Boolean);
  if (!hooked) {
    // One part (the overwhelming case) or none: exactly the old output.
    if (parts.length <= 1) return legacyCitationTag(p.trim());
    return parts.map(legacyCitationTag).join(' ');
  }
  let out = '';
  for (const part of parts) {
    const n = cite(unescHtml(part));
    if (Number.isInteger(n) && n > 0 && n < 100000) {
      const num = String(n);
      out += '<button type="button" class="chat-cite-n" data-cite-n="' + num + '">' +
        '<span aria-hidden="true">' + num + '</span>' +
        '<span class="visually-hidden">Source ' + num + ': ' + part + '</span></button>';
    } else {
      out += '<span class="chat-cite-unresolved">' + part + '</span>';
    }
  }
  return out;
}

// The pre-v3.72.0 citation tag, unchanged, for surfaces that pass no hook.
function legacyCitationTag(path) {
  return '<span class="chat-citation-tag">' + icon('dot', 7) +
    '<span class="chat-cite-path">' + path + '</span></span>';
}

function renderInline(text, cite) {
  const parts = String(text).split(/(`[^`\n]+`)/g);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) out += '<code>' + parts[i].slice(1, -1) + '</code>';
    else out += formatSegment(parts[i], cite);
  }
  return out;
}

// ── GFM TABLE SUPPORT ────────────────────────────────────────────────────
// Three small pure helpers, used only by renderMarkdown's block loop below.
// They run on text escHtml() has ALREADY escaped, exactly like every other
// pass in this file — `|`, `\` and `:` are untouched by escaping, so the
// grammar is intact while `<`, `>`, `&`, `"` and `'` are already inert.
//
// scripts/test-next-markdown.js extracts these by name, and its §0b guard
// fails if a helper renderMarkdown calls is missing from that list — the
// v3.14.0 "hardcoded FN list" blind spot, closed for this file rather than
// left to surface as a ReferenceError crash in a later change.

// Split ONE table row into its cells. A linear scan, never a regex: the
// obvious spelling needs a lookbehind or an alternation to skip escaped
// pipes, and this file already carries a measured ReDoS note explaining why
// that shape is not welcome here. A backslash escapes the character after
// it, so `\|` is a literal pipe INSIDE a cell and `\\` a literal backslash.
//
// GFM's leading/trailing pipes are optional and are stripped as DELIMITERS
// before the split — exactly one of each, never by dropping empty cells
// afterwards. That distinction is load-bearing: `| | b |` has a genuinely
// empty FIRST COLUMN, and a "drop empty edge cells" shortcut silently eats
// it and shifts every remaining cell one column left, misaligning the whole
// row against its header.
function splitTableRow(line) {
  let s = String(line).trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  // `\|` at the end is an ESCAPED pipe belonging to the last cell, not the
  // row's closing delimiter.
  if (s.length && s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);

  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === '\\' && i + 1 < s.length) {
      const next = s.charAt(i + 1);
      if (next === '|' || next === '\\') { cur += next; i++; continue; }
      cur += ch;
      continue;
    }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

// A delimiter cell is `---`, `:--`, `--:` or `:-:`. Anchored, one quantifier,
// no alternation — linear in the cell length whatever is thrown at it.
function isTableDelimiterCell(cell) {
  return /^:?-+:?$/.test(cell);
}

// Alignment is read off the delimiter cell and mapped to ONE OF FOUR fixed
// class names. The parsed text itself NEVER reaches the attribute — the
// return value here is a literal from this function, which is what keeps the
// cardinal rule intact while still emitting a class attribute at all.
function tableAlignClass(delimCell) {
  const left = delimCell.charAt(0) === ':';
  const right = delimCell.charAt(delimCell.length - 1) === ':';
  if (left && right) return ' class="chat-md-al-center"';
  if (right) return ' class="chat-md-al-right"';
  if (left) return ' class="chat-md-al-left"';
  return '';
}

// ── v3.72.0 BLOCK HELPERS ─────────────────────────────────────────────────
// Pure, and run on escaped text like everything above. Listed by name in
// scripts/test-next-markdown.js's FNS (its §0b guard fails on a missing one).

// Leading-whitespace width, a tab counting as four columns (CommonMark's tab
// stop). Used only to tell a nested item or a continuation line from a
// top-level one; the threshold is 2.
function indentWidth(lead) {
  return String(lead).replace(/\t/g, '    ').length;
}

// A thematic break: three or more of ONE of `-`, `*`, `_`, spaces allowed
// between them. Tested on the space-stripped line with an anchored,
// single-quantifier pattern — no alternation inside a repeat, nothing that can
// backtrack. Must be asked BEFORE the bullet test: `* * *` is also a bullet.
function isRule(line) {
  const s = String(line).replace(/[ \t]/g, '');
  return s.length >= 3 && (/^-+$/.test(s) || /^\*+$/.test(s) || /^_+$/.test(s));
}

// A blockquote line. `>` was escaped to `&gt;` before any pass ran, so that is
// the marker this renderer sees — and why `&gt;` in the INPUT (someone writing
// the entity literally) is escaped to `&amp;gt;` and never starts a quote.
function isQuoteLine(line) {
  return /^\s*&gt;/.test(line);
}
function stripQuoteMarker(line) {
  return String(line).replace(/^\s*&gt;[ \t]?/, '');
}

// "— Name" under a quote: an em dash, en dash, horizontal bar or `--`, then
// text. Not a bullet: a bullet needs ONE marker character followed by a space.
function isAttribution(line) {
  return /^\s*(?:—|–|―|--)\s*\S/.test(line);
}

// One blockquote from its inner lines (markers already stripped). Blank inner
// lines separate paragraphs. The LAST line becomes the attribution when it is
// "— Name" and is not the quote's only line (a quote that is ONLY a dash line
// is quoted text, not a credit for nothing). Nested `>` stays literal text:
// one level is what an answer needs, and a second is a second grammar.
function renderQuote(inner, cite) {
  const blocks = [];
  let cur = [];
  for (const l of inner) {
    if (/^\s*$/.test(l)) { if (cur.length) { blocks.push(cur); cur = []; } }
    else cur.push(l);
  }
  if (cur.length) blocks.push(cur);
  let attrib = null;
  const last = blocks[blocks.length - 1];
  if (last && isAttribution(last[last.length - 1]) && !(blocks.length === 1 && last.length === 1)) {
    attrib = last.pop();
    if (!last.length) blocks.pop();
  }
  let html = '<blockquote class="chat-md-quote">';
  for (const b of blocks) html += '<p>' + b.map((l) => renderInline(l.trim(), cite)).join('<br>') + '</p>';
  if (attrib) html += '<p class="chat-md-attrib">' + renderInline(attrib.trim(), cite) + '</p>';
  return html + '</blockquote>';
}

// A list item's own lines: text runs joined by <br> (a one-line item renders
// exactly as it always did), and any run of quote lines — plus a "— Name" line
// directly under it — as a blockquote inside the item.
function renderItemBody(lines, cite) {
  let html = '';
  let run = [];
  const flush = () => {
    if (run.length) { html += run.map((l) => renderInline(l, cite)).join('<br>'); run = []; }
  };
  for (let i = 0; i < lines.length; i++) {
    if (!isQuoteLine(lines[i])) { run.push(lines[i]); continue; }
    flush();
    const q = [];
    while (i < lines.length && isQuoteLine(lines[i])) { q.push(stripQuoteMarker(lines[i])); i++; }
    if (i < lines.length && isAttribution(lines[i])) { q.push(lines[i]); i++; }
    i--;
    html += renderQuote(q, cite);
  }
  flush();
  return html;
}

// A list and, for each item, its ONE level of nested lists. `start` is the
// Number the opening item carried (see the ordered-list note in
// renderMarkdown), re-stringified here — a literal of ours, never input text.
// Nested lists are built with `subs: null` items, so this recursion is two
// levels deep at most.
function renderList(list, cite) {
  const attr = (list.type === 'ol' && list.start !== 1) ? ' start="' + list.start + '"' : '';
  let html = '<' + list.type + attr + '>';
  for (const it of list.items) {
    html += '<li>' + renderItemBody(it.lines, cite) +
      (it.subs ? it.subs.map((sub) => renderList(sub, cite)).join('') : '') + '</li>';
  }
  return html + '</' + list.type + '>';
}

// `opts.cite` — OPTIONAL, and only shared/answer.js passes it: a function
// handed each citation path (raw, unescaped) that returns the marker's number.
// Every other caller passes nothing and gets the inert legacy citation tag.
export function renderMarkdown(raw, opts) {
  const cite = (opts && typeof opts.cite === 'function') ? opts.cite : null;
  const escaped = escHtml(raw);
  const lines = escaped.split('\n');
  const out = [];

  let inCode = false;
  let codeBuf = [];
  // The open list, or null: `{ type, start, items }`, each item
  // `{ lines, subs }`, where `subs` holds the item's ONE level of nested lists
  // (v3.72.0). `start` is the number the list was OPENED with — see the note
  // above the list branch below. It lives on the list object now (it was a
  // separate `listStart` variable whose reset in flushList was recorded as
  // defence in depth); a fresh object per list makes inheriting the previous
  // list's number structurally impossible rather than merely reset.
  let list = null;
  // The item an indented continuation line belongs to: the last item added,
  // at whichever level it was added.
  let lastItem = null;
  let para = [];

  const flushPara = () => {
    // NOT `para.map(renderInline)`: map would hand renderInline the INDEX as
    // its second argument, i.e. as the citation hook.
    if (para.length) { out.push('<p>' + para.map((l) => renderInline(l, cite)).join('<br>') + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list) {
      // `start` is emitted ONLY when the list did not open at 1, so the
      // overwhelming majority of lists render byte-identically to before this
      // change. `start` is a Number this function produced from a
      // `\d{1,9}` capture and then re-stringified — it is a literal of ours by
      // the time it reaches the attribute, in the same sense
      // tableAlignClass()'s return value is, so the cardinal rule (never
      // interpolate INPUT TEXT into an attribute) is intact.
      out.push(renderList(list, cite));
      list = null; lastItem = null;
    }
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

    // Headings keep the base `chat-md-h` class (the reader's own rules select
    // it) and gain a level class from a FIXED set of four — the level is the
    // length of a `#{1,6}` run, never text. 4 covers 4–6.
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const lvl = Math.min(h[1].length, 4);
      out.push('<div class="chat-md-h chat-md-h' + lvl + '">' + renderInline(h[2], cite) + '</div>');
      continue;
    }

    // Thematic break. Before the table test (`---` has no pipe, so it could
    // never be a table header, but a `---` line is also never a paragraph)
    // and, load-bearingly, before the bullet test, which `* * *` would match.
    if (isRule(line)) { flushPara(); flushList(); out.push('<hr class="chat-md-hr">'); continue; }

    // ── GFM table ────────────────────────────────────────────────────────
    // Two conditions, and BOTH matter. The header row must contain at least
    // one `|`, which stops a `Some text` / `-------` pair — a setext H2 this
    // renderer does not support and which would otherwise be swallowed as a
    // one-column table. And the delimiter row's cell count must EQUAL the
    // header's, which is GFM's own rule and additionally rejects ordinary
    // prose that merely happens to mention a pipe above a horizontal rule.
    if (line.indexOf('|') !== -1 && li + 1 < lines.length) {
      const headerCells = splitTableRow(line);
      const delimCells = splitTableRow(lines[li + 1]);
      if (headerCells.length > 0 && delimCells.length === headerCells.length &&
          delimCells.every(isTableDelimiterCell)) {
        flushPara(); flushList();
        const aligns = delimCells.map(tableAlignClass);
        let tbl = '<div class="chat-md-table-wrap"><table class="chat-md-table"><thead><tr>';
        for (let c = 0; c < headerCells.length; c++) {
          tbl += '<th' + aligns[c] + '>' + renderInline(headerCells[c], cite) + '</th>';
        }
        tbl += '</tr></thead><tbody>';
        let r = li + 2;
        for (; r < lines.length; r++) {
          const rowLine = lines[r];
          // The table ends at a blank line, at a line carrying no pipe, or at
          // a fence. The fence case is not defensive tidiness: ``` is handled
          // by a branch ABOVE this one, and eating it here would swallow an
          // entire code block into a table cell.
          if (/^\s*$/.test(rowLine)) break;
          if (/^\s*```/.test(rowLine)) break;
          if (rowLine.indexOf('|') === -1) break;
          const cells = splitTableRow(rowLine);
          tbl += '<tr>';
          for (let c = 0; c < headerCells.length; c++) {
            // GFM: a short row is PADDED and a long one TRUNCATED, both
            // against the header's column count. Never render a ragged table.
            tbl += '<td' + aligns[c] + '>' + (c < cells.length ? renderInline(cells[c], cite) : '') + '</td>';
          }
          tbl += '</tr>';
        }
        tbl += '</tbody></table></div>';
        out.push(tbl);
        li = r - 1; // the outer loop's own li++ lands us exactly on `r`
        continue;
      }
    }


    // ── ORDERED LISTS CARRY THE NUMBER THEY WERE OPENED WITH ─────────────
    // Reported from real use (Robin Good, with screenshots): an answer whose
    // items were numbered 1. 2. 3. rendered "1." four times, while the same
    // question to a different model rendered 1, 2, 3. REPRODUCED OFFLINE
    // against this function, and the cause is NOT that the model repeated
    // "1." — it is that ANY non-list line between two items ends the list
    // here, and each following item then opened a FRESH <ol> with no `start`,
    // which the browser restarts at 1. The model in the screenshot had put
    // its own `[source: …]` citation on a line of its own after each item
    // (that line is the model's, not something this app inserts), so every
    // item became a one-item list.
    //
    // Measured on the maintainer's real corpus (5,575 rendered documents —
    // every wiki page, every raw source, every stored chat message across six
    // domains): 21 documents (0.38 %) render differently with `start`, and
    // every one of them was a genuinely mis-numbered list — including one
    // that restarted at 1 after item 5.
    //
    // THE HONEST LIMIT, STATED RATHER THAN IMPLIED: this makes the rendered
    // numbers agree with the numbers the author WROTE, which is CommonMark's
    // rule (the first item's number sets `start`; later numbers are ignored).
    // It does NOT re-join the broken list. A model that writes "1." for every
    // item AND breaks between them still renders 1, 1, 1 — because that is
    // what it numbered. The fuller fix is CommonMark's loose-list and lazy-
    // continuation rules, which WERE built and measured here and are NOT
    // shipped: they change 108 of the same 5,575 documents, and while 76 of
    // those are two adjacent lists correctly merging, 23 swallow a following
    // paragraph into the last list item — including the "Warnings:" heading
    // in every domain's own wiki/log.md. That is a separate change with its
    // own evidence to gather, not a rider on this one.
    //
    // `\d{1,9}` rather than `\d+`: the value is re-emitted as an attribute, so
    // it is bounded to something an <ol> can actually count from. A longer run
    // of digits simply fails to match and renders as ordinary text.
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const num = bullet ? null : line.match(/^(\s*)(\d{1,9})\.\s+(.*)$/);
    if (bullet || num) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      const indent = indentWidth(bullet ? bullet[1] : num[1]);
      const item = { lines: [bullet ? bullet[2] : num[3]], subs: null };
      // Only the item that OPENS a list sets its number. Once the list is
      // open, later numbers are ignored — CommonMark's own rule, and what
      // already made a contiguous "1. 1. 1." render as 1, 2, 3.
      const opening = num ? Number(num[2]) : 1;

      // ── ONE LEVEL OF NESTING (v3.72.0) ─────────────────────────────────
      // An INDENTED marker (2+ columns) inside an open list nests under the
      // list's last item, instead of closing the list and reopening it at
      // start=2 (the "ol / ul / ol" split). Deeper indentation lands on the
      // same nested level: one level is the whole grammar.
      if (list && indent >= 2 && list.items.length) {
        const parent = list.items[list.items.length - 1];
        if (!parent.subs) parent.subs = [];
        let sub = parent.subs[parent.subs.length - 1];
        if (!sub || sub.type !== type) { sub = { type, start: opening, items: [] }; parent.subs.push(sub); }
        sub.items.push(item);
        lastItem = item;
        continue;
      }
      if (list && list.type !== type) flushList();
      if (!list) list = { type, start: opening, items: [] };
      list.items.push(item);
      lastItem = item;
      continue;
    }

    // ── CONTINUATION: an INDENTED line directly under an item ──────────────
    // belongs to that item (CommonMark), which is how "1. > quote" followed by
    // "   — Name" stays one item. INDENTED only: the lazy, unindented form was
    // measured and rejected (see the ordered-list note above), and a blank
    // line has already closed the list before this is reached.
    if (list && lastItem && indentWidth(line.match(/^\s*/)[0]) >= 2) {
      lastItem.lines.push(line.trim());
      continue;
    }

    // ── BLOCKQUOTE ────────────────────────────────────────────────────────
    // Consecutive quote lines are one quote; a "— Name" line directly under
    // them is its attribution. See renderQuote.
    if (isQuoteLine(line)) {
      flushPara(); flushList();
      const q = [];
      let j = li;
      while (j < lines.length && isQuoteLine(lines[j])) { q.push(stripQuoteMarker(lines[j])); j++; }
      if (j < lines.length && isAttribution(lines[j])) { q.push(lines[j]); j++; }
      out.push(renderQuote(q, cite));
      li = j - 1; // the loop's own li++ lands on `j`
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
