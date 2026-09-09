/**
 * test-next-chat-scopebar.js — OFFLINE suite for the Chat scope bar's two
 * groups: the SCOPE readout and the COMPILE control (src/public/next/views/
 * chat.js).
 *
 * No network, no API key, no server, no browser, no LLM call. The REAL
 * `renderMain` is extracted by brace-matching and EXECUTED; the markup it hands
 * to `setMain` is captured and parsed into an element tree, so every assertion
 * here is about the DOM the browser would build — not about a substring of a
 * source file.
 *
 * ── THE DEFECT THIS SUITE EXISTS FOR ─────────────────────────────────────
 * Reported by a power user on a mature domain and reproduced from the shipped
 * markup. The scope bar rendered five loose flex children, ending:
 *
 *     … <div class="chat-scope-spacer"></div>
 *       <button class="chat-compile-btn">Compile to Wiki</button>
 *       <span class="chat-scope-count">1,406 pages in scope</span>
 *
 * so the right-hand end of the toolbar read `Compile to Wiki  1,406 pages in
 * scope` as ONE phrase. He read the number as the button's caption — "pressing
 * this will touch 1,406 pages" — and did not press it. Both facts were true and
 * neither was about the other: the count is how much wiki the CONVERSATION can
 * see; a compile writes a handful of pages from one thread.
 *
 * ── WHY THE ASSERTIONS ARE STRUCTURAL AND NOT TEXTUAL ────────────────────
 * A test that pinned the words would go green the moment someone reworded the
 * readout and left it exactly where it was — which is the arrangement that
 * caused the report. So §2 asserts the DOM PATH of each: the readout is inside
 * `.chat-scope-group` and the caption inside `.chat-compile-group`, their
 * nearest common ancestor is the bar itself, and neither is a sibling of the
 * other's control. §5 runs the same predicates over the PRE-FIX markup and
 * requires them to fail, so a green here is evidence rather than a tautology.
 *
 *   §0  Harness self-check — ok() can fail, and the tree parser really parses.
 *   §1  The bar's own shape: two groups with the spacer between them.
 *   §2  THE DOM PATH — the readout's, the caption's, and their separation.
 *   §3  The caption states the real message count, and only real messages.
 *   §4  The caption does NOT restate the cost gate.
 *   §5  ANTI-VACUITY — the pre-fix markup fails §2's own predicates.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_JS = path.join(ROOT, 'src/public/next/views/chat.js');
const chatSrc = readFileSync(CHAT_JS, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}
function section(t) { console.log(`\n${t}`); }

// ── Extraction (brace-matched; a desync fails LOUDLY, never silently) ─────
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in chat.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start);
  let parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) throw new Error(`extractFunction: "${name}" extraction desynced`);
  return extracted;
}
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [^\\n]*\\n`);
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found`);
  return m[0].trim();
}

/* The real shell escaper's contract, reproduced rather than imported (app.js is
   an ES module full of browser globals). §3's hostile-value control proves an
   unescaped caption would be observable, so this is not a pass-through. */
function escapeHtmlStub(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────
// A small element-tree parser. It models exactly what these assertions need:
// which node contains which, in what order. Attribute values cannot contain
// `>` (the renderer escapes it — §0 proves the parser sees a hostile value as
// TEXT, not as structure), so the tag bound is safe.
// ─────────────────────────────────────────────────────────────────────────
const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

function parseTree(html) {
  const root = { tag: '#root', attrs: {}, classes: [], children: [], parent: null, text: '' };
  let cur = root;
  const re = /<\/([a-z][a-z0-9]*)\s*>|<([a-z][a-z0-9]*)((?:"[^"]*"|[^>])*?)(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) { cur.text += m[5]; continue; }
    if (m[1] !== undefined) {                    // closing tag
      if (cur.parent) cur = cur.parent;
      continue;
    }
    const tag = m[2].toLowerCase();
    const attrs = {};
    const aRe = /([a-z-]+)="([^"]*)"/gi;
    let a;
    while ((a = aRe.exec(m[3]))) attrs[a[1].toLowerCase()] = a[2];
    const node = {
      tag, attrs,
      classes: (attrs.class || '').split(/\s+/).filter(Boolean),
      children: [], parent: cur, text: '',
    };
    cur.children.push(node);
    if (!m[4] && !VOID_TAGS.has(tag)) cur = node;
  }
  return root;
}
function walk(node, fn) { fn(node); node.children.forEach((c) => walk(c, fn)); }
function findByClass(root, cls) {
  let hit = null;
  walk(root, (n) => { if (!hit && n.classes.includes(cls)) hit = n; });
  return hit;
}
/** The chain of class names from a node up to (and excluding) the root. */
function classPath(node) {
  const out = [];
  for (let n = node; n && n.parent; n = n.parent) out.unshift(n.classes.join('.') || n.tag);
  return out;
}
function ancestorClasses(node) {
  const out = [];
  for (let n = node.parent; n && n.parent; n = n.parent) out.push(...n.classes);
  return out;
}
function nearestCommonAncestor(a, b) {
  const chain = new Set();
  for (let n = a; n; n = n.parent) chain.add(n);
  for (let n = b; n; n = n.parent) if (chain.has(n)) return n;
  return null;
}
function siblingClasses(node) {
  if (!node.parent) return [];
  return node.parent.children.filter((c) => c !== node).flatMap((c) => c.classes);
}

// ─────────────────────────────────────────────────────────────────────────
// The sandbox: the REAL renderMain, its REAL compile-control builders, and
// stubs only at the edges it reaches out through.
// ─────────────────────────────────────────────────────────────────────────
function render(over = {}) {
  const state = Object.assign({
    booted: true,
    loadError: null,
    domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 1406 }],
    activeDomain: 'articles',
    activeConversationId: 'conv-1',
    thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
    compileBusy: false,
    compilePct: 0,
  }, over);

  const captured = { html: null, token: null };
  const src =
    'let myMountToken = 1;\n' +
    extractConst(chatSrc, 'COMPILE_MIN_USER_MESSAGES') + '\n' +
    extractFunction(chatSrc, 'renderCompileButtonHtml') + '\n' +
    extractFunction(chatSrc, 'compileMessageCount') + '\n' +
    extractFunction(chatSrc, 'compileCaptionText') + '\n' +
    extractFunction(chatSrc, 'compileControlHtml') + '\n' +
    extractFunction(chatSrc, 'renderMain') + '\n' +
    'return { renderMain, compileControlHtml, compileCaptionText, compileMessageCount };';

  const api = new Function(
    'document', 'state', 'isCurrentMount', 'setMain', 'escapeHtml', 'icon',
    'renderViewHeader', 'gatedLoader', 'bootGate', 'emptyCard', 'navigate',
    'renderComposerHtml', 'wireComposer', 'renderThreadOnly', 'renderComposerPickers',
    'startCompile', 'switchDomain', 'reportAsyncActionFailure',
    src
  )(
    {
      // renderMain only ever LOOKS UP nodes it has just rendered, to wire
      // handlers onto them. Returning null from both is the honest answer for
      // a document that was never attached: nothing is wired, and nothing in
      // this suite asserts on wiring (test-next-chat-filter.js does).
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    state,
    () => true,
    (html, token) => { captured.html = html; captured.token = token; },
    escapeHtmlStub,
    () => '<span class="icon-stub"></span>',
    () => '<header class="view-header-stub"></header>',
    () => '<div class="loader-stub"></div>',
    null,
    () => '<div class="empty-card-stub"></div>',
    () => {},
    () => '<div class="composer-stub"></div>',
    () => {}, () => {}, () => {},
    () => {}, () => {}, () => {},
  );

  api.renderMain(1);
  return { state, api, html: captured.html, tree: parseTree(captured.html || '') };
}

// ═════════════════════════════════════════════════════════════════════════
section('§0 — Harness self-check');
// ═════════════════════════════════════════════════════════════════════════
{
  let sawFail = false;
  const realOk = ok;
  // eslint-disable-next-line no-func-assign
  ok = (c) => { if (!c) sawFail = true; };
  ok(false, 'probe');
  // eslint-disable-next-line no-func-assign
  ok = realOk;
  ok(sawFail, 'control: ok() can fail — the assertions below are not decorative');

  const t = parseTree('<div class="a"><span class="b">x</span><span class="c"></span></div>');
  const b = findByClass(t, 'b');
  ok(!!b, 'the parser finds a nested node by class');
  ok(ancestorClasses(b).includes('a'), '…and reports its ancestor');
  ok(siblingClasses(b).includes('c'), '…and its sibling');
  ok(findByClass(t, 'nope') === null, 'control: an absent class returns null, so a missing node cannot pass as present');
  const hostile = parseTree('<span class="x" title="a&gt;b">t</span>');
  eq(findByClass(hostile, 'x').children.length, 0,
    'control: an escaped `>` inside an attribute does not create a phantom child (the escaping the renderer does is what makes the tag bound safe)');
  const r = render();
  ok(typeof r.html === 'string' && r.html.length > 0, 'the REAL renderMain produced markup through setMain');
  ok(!!findByClass(r.tree, 'chat-scopebar'), '…and it contains the scope bar');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — The bar is two groups with the spacer between them');
// ═════════════════════════════════════════════════════════════════════════
{
  const { tree } = render();
  const bar = findByClass(tree, 'chat-scopebar');
  const kids = bar.children.map((c) => c.classes.join('.'));
  ok(kids.length === 3, `the bar has exactly three children, not five loose ones (got ${kids.length}: ${kids.join(' | ')})`);
  eq(kids[0], 'chat-scope-group', 'first child: the scope group');
  eq(kids[1], 'chat-scope-spacer', 'second child: the spacer that holds the two apart');
  eq(kids[2], 'chat-compile-group', 'third child: the compile group');

  const scopeGroup = findByClass(tree, 'chat-scope-group');
  const inScope = scopeGroup.children.map((c) => c.classes.join('.'));
  ok(inScope.includes('chat-scope-eyebrow.mono'), 'the SCOPE eyebrow is in the scope group');
  ok(inScope.includes('chat-scope-pills'), 'so are the domain pills');
  ok(inScope.includes('chat-scope-count'), 'and so is the readout the eyebrow and pills describe');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — THE DOM PATH: the readout and the caption cannot be read together');
// ═════════════════════════════════════════════════════════════════════════
{
  const { html, tree } = render();
  const count = findByClass(tree, 'chat-scope-count');
  const caption = findByClass(tree, 'chat-compile-caption');
  const button = findByClass(tree, 'chat-compile-btn');
  ok(!!count && !!caption && !!button, 'all three nodes are present (precondition for everything below)');

  // The path, stated as a path rather than as a substring.
  ok(ancestorClasses(count).includes('chat-scope-group'),
    `the readout is INSIDE the scope group (path: ${classPath(count).join(' > ')})`);
  ok(!ancestorClasses(count).includes('chat-compile-group'),
    '…and inside no part of the compile control');
  ok(ancestorClasses(caption).includes('chat-compile-group'),
    `the caption is INSIDE the compile group (path: ${classPath(caption).join(' > ')})`);
  ok(!ancestorClasses(caption).includes('chat-scope-group'),
    '…and inside no part of the scope readout');

  // Nearest common ancestor is the BAR, i.e. they share no container below it.
  const nca = nearestCommonAncestor(count, caption);
  ok(nca && nca.classes.includes('chat-scopebar'),
    `the nearest container holding both is the bar itself (got ${nca ? nca.classes.join('.') : 'none'})`);
  const ncaBtn = nearestCommonAncestor(count, button);
  ok(ncaBtn && ncaBtn.classes.includes('chat-scopebar'),
    'and the same is true of the readout and the Compile BUTTON');

  // Adjacency, the thing that was actually read as one phrase.
  ok(!siblingClasses(count).includes('chat-compile-btn'),
    'the readout is not a sibling of the Compile button');
  ok(!siblingClasses(count).includes('chat-compile-group'),
    '…nor of the compile group');
  ok(!siblingClasses(caption).includes('chat-scope-count'),
    'and the caption is not a sibling of the readout');

  // Reading order: the readout comes first, attached to what it describes, and
  // the compile control is last. A reader scanning left to right meets
  // "1,406 pages in scope" beside the pills and "Compile to Wiki / Saves this
  // conversation…" beside each other.
  ok(html.indexOf('chat-scope-count') < html.indexOf('chat-compile-btn'),
    'the readout is rendered BEFORE the Compile button, not after it');
  ok(html.indexOf('chat-compile-btn') < html.indexOf('chat-compile-caption'),
    'and the caption follows its own button');
  ok(html.indexOf('chat-scope-spacer') > html.indexOf('chat-scope-count') &&
     html.indexOf('chat-scope-spacer') < html.indexOf('chat-compile-btn'),
    'the spacer lies between them, so the two never render shoulder to shoulder');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — The caption states the real message count');
// ═════════════════════════════════════════════════════════════════════════
{
  const four = render({
    thread: [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
    ],
  });
  const cap = findByClass(four.tree, 'chat-compile-caption');
  eq(cap.text.trim(), 'Saves this conversation (4 messages) as wiki pages',
    'a four-message thread is described as four messages');

  const one = render({ thread: [{ role: 'user', content: 'a' }] });
  eq(findByClass(one.tree, 'chat-compile-caption').text.trim(),
    'Saves this conversation (1 message) as wiki pages',
    'one message is not pluralised');

  // The synthetic outcome cards runCompile pushes into state.thread are NOT
  // messages. Counting them would make a second compile of the same thread
  // claim one more message than the first with nothing said in between.
  const withCard = render({
    thread: [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'compile', html: '<div>done</div>' },
    ],
  });
  eq(findByClass(withCard.tree, 'chat-compile-caption').text.trim(),
    'Saves this conversation (2 messages) as wiki pages',
    'a compile outcome card is not counted as a message');

  // A hole in the thread is neither counted nor fatal. Driven against
  // compileMessageCount DIRECTLY rather than through renderMain, and the
  // reason is a finding rather than convenience: renderCompileButtonHtml —
  // which predates this change and is pinned by two other suites — reads
  // `m.role` with no guard, so it would throw before the counter was ever
  // reached. That is a latent defect in the sibling function (a conversation
  // file holding `[null]` blanks the whole Chat view), reported rather than
  // fixed here, because hardening a function this brief does not own is a
  // change nobody asked for in code two suites pin. The counter's own guard is
  // real and is what this asserts.
  {
    const r = render();
    r.state.thread = [null, { role: 'user', content: 'a' }, undefined, { role: 'compile', html: '' }];
    eq(r.api.compileMessageCount(), 1, 'a null or undefined thread entry is neither counted nor fatal');
  }

  // The caption appears and disappears WITH the button — a caption for a
  // control that is not there describes nothing.
  const noConv = render({ activeConversationId: null });
  ok(!findByClass(noConv.tree, 'chat-compile-btn'), 'with no active conversation the button is absent (precondition)');
  ok(!findByClass(noConv.tree, 'chat-compile-caption'), '…and so is the caption');
  ok(!findByClass(noConv.tree, 'chat-compile-group'), '…and so is the group that would have held it');
  const noUserTurn = render({ thread: [{ role: 'assistant', content: 'hello' }] });
  ok(!findByClass(noUserTurn.tree, 'chat-compile-btn'), 'below COMPILE_MIN_USER_MESSAGES the button is absent');
  ok(!findByClass(noUserTurn.tree, 'chat-compile-caption'), '…and the caption goes with it');

  // The readout is the SCOPE's number and stays that whatever the thread does.
  ok(findByClass(four.tree, 'chat-scope-count').text.includes('1,406 pages in scope'),
    'the scope readout still states the domain page count, formatted');
  ok(!findByClass(four.tree, 'chat-compile-caption').text.includes('1,406'),
    'and the caption never repeats it — that collapse is the whole defect');

  // Escaping: the caption goes through escapeHtml like every other string here.
  const capSrc = extractFunction(chatSrc, 'compileControlHtml');
  ok(/escapeHtml\(compileCaptionText\(\)\)/.test(capSrc),
    'the caption is emitted through escapeHtml, not interpolated raw');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — The caption does NOT restate the cost gate');
// ═════════════════════════════════════════════════════════════════════════
{
  /* v3.27.0 made Compile stop spending silently: startCompile fetches
     /api/compile/estimate and puts the answer through confirmThen, which
     states a real price, a free model, an unpriced model or no provider as
     four different sentences. A price on the toolbar would be a SECOND copy of
     that fact, stale by construction — it would have to be rendered before the
     estimate has been asked for. The caption says what the button does; the
     dialog says what it costs. */
  const text = render().api.compileCaptionText();
  for (const forbidden of ['$', 'cost', 'Cost', 'estimat', 'free', 'price', '¢']) {
    ok(!text.includes(forbidden), `the caption carries no "${forbidden}" — the dialog owns that sentence`);
  }
  const gate = extractFunction(chatSrc, 'startCompile');
  ok(/api\/compile\/estimate/.test(gate) && /confirmThen\(/.test(gate),
    'CONTROL: the estimate-then-confirm gate really is where the cost is stated, so the omission above is a division of labour and not a hole');
  ok(/Saves this conversation/.test(text) && /as wiki pages/.test(text),
    'and the caption does say what the control does, in the dialog\'s own vocabulary');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — ANTI-VACUITY: the pre-fix markup fails §2’s own predicates');
// ═════════════════════════════════════════════════════════════════════════
{
  /* The exact arrangement that was reported, rebuilt by hand and run through
     the same three predicates §2 uses. If these came back green, §2 would be
     asserting nothing. */
  const legacy = parseTree(
    '<div class="chat-scopebar">' +
      '<span class="chat-scope-eyebrow mono">SCOPE</span>' +
      '<div class="chat-scope-pills"><button class="chat-scope-pill">Articles</button></div>' +
      '<div class="chat-scope-spacer"></div>' +
      '<button class="chat-compile-btn"><span>Compile to Wiki</span></button>' +
      '<span class="chat-scope-count">1,406 pages in scope</span>' +
    '</div>'
  );
  const legacyCount = findByClass(legacy, 'chat-scope-count');
  ok(!ancestorClasses(legacyCount).includes('chat-scope-group'),
    'CONFIRMED RED on the old markup: the readout was in no scope group');
  ok(siblingClasses(legacyCount).includes('chat-compile-btn'),
    'CONFIRMED RED: it WAS a sibling of the Compile button');
  ok(!findByClass(legacy, 'chat-compile-caption'),
    'CONFIRMED RED: there was no caption for the button to be read with instead');
  ok(legacy.children[0].children.length === 5,
    'CONFIRMED RED: the bar really did have five loose children');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — SOURCE GUARD: the caption is SECONDARY text, on the kit’s rungs');
// ═════════════════════════════════════════════════════════════════════════
{
  /* Not extractable behaviourally — a computed colour needs a layout engine.
     The property being pinned is that the caption EXPLAINS a control rather
     than competing with it: the same --text-3 / --text-xs rung the scope
     readout takes, which is the "secondary text" of this kit. */
  const chatCss = readFileSync(path.join(ROOT, 'src/public/next/views/chat.css'), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodyOf = (sel) => {
    const m = new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
      .exec(strip(chatCss));
    return m ? m[1] : '';
  };
  const cap = bodyOf('.chat-compile-caption');
  const readout = bodyOf('.chat-scope-count');
  ok(/font-size:\s*var\(--text-xs\)/.test(cap), 'the caption is set at --text-xs');
  ok(/color:\s*var\(--text-3\)/.test(cap), '…in --text-3');
  ok(/font-size:\s*var\(--text-xs\)/.test(readout) && /color:\s*var\(--text-3\)/.test(readout),
    'CONTROL: the scope readout takes the same two, so "secondary text" here names one rung and not two');
  ok(/font-variant-numeric:\s*var\(--numeric-tabular\)/.test(cap),
    'the caption takes tabular figures — its count TICKS with every turn, which is the exact reason section 6 of test-next-views-kit.js gives for this token');
  ok(!/font-family:\s*var\(--font-mono\)/.test(cap),
    '…and is NOT in the code face: a sentence about a button is prose, and chat.js\'s mono budget is itemised and full');

  // The two groups exist as rules, and neither may shrink: the bar scrolls
  // horizontally, so a shrinkable group would compress its own label instead.
  for (const sel of ['.chat-scope-group', '.chat-compile-group']) {
    const b = bodyOf(sel);
    ok(/display:\s*flex/.test(b), `${sel} is a flex row`);
    ok(/flex:\s*none/.test(b), `…and does not shrink (${sel})`);
  }
  ok(/flex:\s*1/.test(bodyOf('.chat-scope-spacer')),
    'CONTROL: the spacer between them is the one thing that DOES flex');

  /* THE STALE NOTE, CORRECTED — and asserted in the only direction that can
     honestly be asserted. chat.css's `.chat-compile-btn` comment said the
     button "spends real money with no estimate and no confirm (still open in
     CLAUDE.md's audit queue)" and called the press "NOT a substitute for the
     missing cost estimate". That has been false since v3.27.0. A negative
     assertion ("this file must not contain that phrase") is NOT available
     here: the correction quotes the old wording verbatim, which is the right
     way to record a correction and would defeat any absence check. So what is
     pinned is that the note now NAMES the gate, which is what stops the next
     reader adding a confirm that already exists. */
  ok(/startCompile/.test(chatCss) && /compile\/estimate/.test(chatCss),
    'the .chat-compile-btn note names startCompile and /api/compile/estimate — the gate that has existed since v3.27.0');
  ok(/CORRECTED \(v3\.49\.0\)/.test(chatCss),
    '…and marks itself as a correction, so the quoted old wording cannot be read as current');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat scope-bar assertions green');
