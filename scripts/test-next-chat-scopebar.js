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
    // v3.64.0 — the project group. Defaults to a ready list with nothing
    // pinned, which is the state every existing user is in the first time
    // they open Chat after updating.
    projectRows: [{ project: 'curator', ageSeconds: 3600 }, { project: 'lumina', ageSeconds: null }],
    projectsFor: 'articles',
    projectsState: 'ready',
    activeProject: null,
    projectLastUsed: null,
  }, over);

  const captured = { html: null, token: null };
  const src =
    'let myMountToken = 1;\n' +
    extractConst(chatSrc, 'COMPILE_MIN_USER_MESSAGES') + '\n' +
    extractFunction(chatSrc, 'renderCompileButtonHtml') + '\n' +
    extractFunction(chatSrc, 'compileMessageCount') + '\n' +
    extractFunction(chatSrc, 'compileTurnCounts') + '\n' +
    extractFunction(chatSrc, 'compileCaptionText') + '\n' +
    extractFunction(chatSrc, 'compileControlHtml') + '\n' +
    /* v3.64.0 — the project group is built from the REAL functions too, so
       §6's assertions are about the markup the browser would build rather
       than about a fixture that happens to look like it. `pendingListboxes`
       is the module-level queue the real code pushes a cfg onto; it is
       declared here because the sandbox has no module scope. */
    'const pendingListboxes = [];\n' +
    extractFunction(chatSrc, 'activeProjectRow') + '\n' +
    extractFunction(chatSrc, 'projectFigureText') + '\n' +
    extractFunction(chatSrc, 'projectListboxCfg') + '\n' +
    extractFunction(chatSrc, 'projectGroupHtml') + '\n' +
    extractFunction(chatSrc, 'projectInfoPanelHtml') + '\n' +
    extractFunction(chatSrc, 'renderMain') + '\n' +
    'return { renderMain, compileControlHtml, compileCaptionText, compileMessageCount, compileTurnCounts, projectGroupHtml, pendingListboxes };';

  const api = new Function(
    'document', 'state', 'isCurrentMount', 'setMain', 'escapeHtml', 'icon',
    'renderViewHeader', 'gatedLoader', 'bootGate', 'emptyCard', 'navigate',
    'renderComposerHtml', 'wireComposer', 'renderThreadOnly', 'renderComposerPickers',
    'startCompile', 'switchDomain', 'reportAsyncActionFailure',
    'renderListboxHtml', 'formatAge', 'freshnessTier', 'selectChatProject', 'mountListbox',
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
    /* The listbox's own markup is shared/listbox.js's and has its own suite
       (test-next-listbox.js). What matters HERE is that the trigger is a
       child of the project group and nothing else, so the stub emits the one
       class name the structural assertions name. */
    (cfg) => '<span class="lb" data-lb-root="' + cfg.id + '"><button class="lb-btn" id="' + cfg.id + '"></button></span>',
    (sec) => (sec === null ? 'unknown' : Math.round(sec / 60) + ' min ago'),
    (sec) => (sec === null ? 'unknown' : sec < 3600 ? 'recent' : 'today'),
    /* The commit handler is behaviour, exercised by the browser pass and by
       the real listbox's own suite; this file is about structure. */
    () => {},
    /* Mounting is shared/listbox.js's job and needs a real document. That the
       QUEUE is drained at all is what this file cares about — §6 asserts it
       is emptied, so the composer's own pass cannot inherit a stale cfg. */
    () => {},
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
  /* FOUR since v3.64.0, not five loose ones. The project group is a SECOND
     GROUP in the left half — it joins the structure rather than dissolving
     it — so what this assertion has always guarded still holds: the groups
     are groups, the spacer is between them, and the compile control is
     alone on the far side. The number is stated as a literal rather than
     `>= 3` so that a fifth loose child, which is the defect this suite
     exists for, still reds. */
  ok(kids.length === 4, `the bar has exactly four children, not five loose ones (got ${kids.length}: ${kids.join(' | ')})`);
  eq(kids[0], 'chat-scope-group', 'first child: the domain scope group');
  eq(kids[1], 'chat-scope-group.chat-project-group', 'second child: the project group, in the SAME left half and built from the same group class');
  eq(kids[2], 'chat-scope-spacer', 'third child: the spacer that holds the two halves apart');
  eq(kids[3], 'chat-compile-group', 'fourth child: the compile group, alone on the right');

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
  /* `chat-compile-pill`, not `chat-compile-btn`. The button is
     `btn btn-ai btn-xs chat-compile-pill` now — the money tier from
     shell.css plus a layout-only modifier for the pill radius the scope bar
     needs. What is left of the old name is the element ID, which is
     unchanged and is what the click handler and the busy-state patch use.
     THE ID IS WHY THIS HAD TO MOVE RATHER THAN BE LEFT ALONE: an
     `html.indexOf('chat-compile-btn')` still matched — against
     `id="chat-compile-btn"` — so three of the ordering assertions below
     would have stayed green while the class they name had ceased to exist.
     Every structural assertion here now names the CLASS explicitly. */
  const button = findByClass(tree, 'chat-compile-pill');
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
  ok(!siblingClasses(count).includes('chat-compile-pill'),
    'the readout is not a sibling of the Compile button');
  ok(!siblingClasses(count).includes('chat-compile-group'),
    '…nor of the compile group');
  ok(!siblingClasses(caption).includes('chat-scope-count'),
    'and the caption is not a sibling of the readout');

  // Reading order: the readout comes first, attached to what it describes, and
  // the compile control is last. A reader scanning left to right meets
  // "1,406 pages in scope" beside the pills and "Compile to Wiki / Saves this
  // conversation…" beside each other.
  ok(html.indexOf('chat-scope-count') < html.indexOf('chat-compile-pill'),
    'the readout is rendered BEFORE the Compile button, not after it');
  ok(html.indexOf('chat-compile-pill') < html.indexOf('chat-compile-caption'),
    'and the caption follows its own button');
  ok(html.indexOf('chat-scope-spacer') > html.indexOf('chat-scope-count') &&
     html.indexOf('chat-scope-spacer') < html.indexOf('chat-compile-pill'),
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
  eq(cap.text.trim(), 'Saves this conversation — 2 questions and 2 answers — as wiki pages',
    'a four-message thread is described as the two questions and two answers it is');

  // THE SIX-MESSAGE CASE THE REPORT NAMED. The caption said "(2 messages)"
  // beside a sidebar row saying "6 messages" for the same thread. The WORDING
  // half is asserted here; the WHEN half — the caption was painted once and
  // never repainted — is §3b below.
  const six = render({
    thread: [
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' }, { role: 'assistant', content: 'f' },
    ],
  });
  eq(findByClass(six.tree, 'chat-compile-caption').text.trim(),
    'Saves this conversation — 3 questions and 3 answers — as wiki pages',
    'the reported six-message thread reads as 3 questions and 3 answers — units the reader can count on screen');
  ok(!findByClass(six.tree, 'chat-compile-caption').text.includes('message'),
    '…and never as "N messages", the unit nobody counts');
  eq(six.api.compileTurnCounts().questions + six.api.compileTurnCounts().answers,
    six.api.compileMessageCount(),
    'questions + answers IS the message count, so the caption cannot claim a different total from the compile input');

  const one = render({ thread: [{ role: 'user', content: 'a' }] });
  eq(findByClass(one.tree, 'chat-compile-caption').text.trim(),
    'Saves this conversation — 1 question and no answers yet — as wiki pages',
    'one question is not pluralised, and "0 answers" is stated as the state it is');

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
    'Saves this conversation — 1 question and 1 answer — as wiki pages',
    'a compile outcome card is neither a question nor an answer');

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
section('§3b — The caption TICKS with the thread, and does so without a repaint');
// ═════════════════════════════════════════════════════════════════════════
/* THE REPORTED DEFECT, and it is a WHEN, not a WHAT. `renderMain` builds the
   caption; an ordinary turn never reaches it (sendCurrentMessage's not-new
   branch calls renderThreadOnly + renderSidebarConversationsOnly and patches
   the sidebar row's count with bumpMessageCountForTurn). So the sidebar ticked
   2 → 4 → 6 while the caption held the number it was first painted with — the
   "(2 messages)" beside "6 messages" the user photographed.

   Driven against a fake element rather than read out of the source, because a
   grep for the call site proves a line exists and not what it does (this
   repo's own v3.0.17 rule). The fake caption node records every write. */
{
  const writes = [];
  const capNode = { textContent: 'Saves this conversation — 1 question and 1 answer — as wiki pages' };
  Object.defineProperty(capNode, 'textContent', {
    get() { return writes.length ? writes[writes.length - 1] : ''; },
    set(v) { writes.push(v); },
  });
  const thread = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const state = { thread };
  let selector = null;
  const doc = { querySelector: (s) => { selector = s; return capNode; } };
  const api = new Function('document', 'state',
    extractFunction(chatSrc, 'compileTurnCounts') + '\n' +
    extractFunction(chatSrc, 'compileCaptionText') + '\n' +
    extractFunction(chatSrc, 'refreshCompileCaption') + '\n' +
    'return { refreshCompileCaption };')(doc, state);

  api.refreshCompileCaption();
  eq(selector, '.chat-compile-caption', 'it resolves the caption by its own class, not by a stale captured node');
  eq(capNode.textContent, 'Saves this conversation — 1 question and 1 answer — as wiki pages',
    'the first refresh states the thread it was given');

  thread.push({ role: 'user', content: 'c' }, { role: 'assistant', content: 'd' });
  api.refreshCompileCaption();
  thread.push({ role: 'user', content: 'e' }, { role: 'assistant', content: 'f' });
  api.refreshCompileCaption();
  eq(capNode.textContent, 'Saves this conversation — 3 questions and 3 answers — as wiki pages',
    'after two more turns it reads 3 and 3 — the number the sidebar reports as "6 messages"');
  eq(writes.length, 3, 'one targeted write per refresh, and nothing else touched');

  // A `textContent` write, NEVER an innerHTML one: the caption is text, and
  // a markup write here would be a second, unescaped path for a string the
  // renderer already escapes.
  const refSrc = extractFunction(chatSrc, 'refreshCompileCaption');
  ok(/\.textContent = compileCaptionText\(\)/.test(refSrc) && !/innerHTML/.test(refSrc),
    'the refresh writes textContent, never innerHTML');
  ok(!/setMain\(|renderMain\(|renderShell\(/.test(refSrc),
    'and it never repaints a section — the v3.53.1 defect was a section re-rendering itself on a tick');

  // ABSENT ELEMENT: a no-op, not a crash. The Compile control is not rendered
  // for a conversation with no user turn, and renderThreadOnly calls this on
  // every paint regardless.
  const bare = new Function('document', 'state',
    extractFunction(chatSrc, 'compileTurnCounts') + '\n' +
    extractFunction(chatSrc, 'compileCaptionText') + '\n' +
    extractFunction(chatSrc, 'refreshCompileCaption') + '\n' +
    'return { refreshCompileCaption };')({ querySelector: () => null }, { thread: [] });
  let threw = false;
  try { bare.refreshCompileCaption(); } catch { threw = true; }
  ok(!threw, 'with no caption on screen it does nothing and throws nothing');

  // THE CALL SITE, asserted where it must be: renderThreadOnly is the one
  // function every turn goes through.
  const rto = extractFunction(chatSrc, 'renderThreadOnly');
  ok(/refreshCompileCaption\(\)/.test(rto),
    'renderThreadOnly — the path an ordinary turn takes — calls it');
  ok(rto.indexOf('refreshCompileCaption()') > rto.indexOf('el.innerHTML = state.thread.map'),
    '…after the thread has been repainted from the same state the caption counts');
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
  /* WAS: `/CORRECTED \(v3\.49\.0\)/` — the marker on a note that quoted its
     own superseded wording verbatim, so an absence check could not be used.
     That quoted wording is gone with the rule it described: `.chat-compile-btn`
     no longer exists and its note was rewritten around the variant that
     replaced it. The correction DISCIPLINE is what this line guards, so it
     now asserts the surviving form of it — the note says the class was
     retired and what took its place, which is what a reader grepping
     chat.css for `.chat-compile-btn` needs to find instead of silence. */
  ok(/`?\.chat-compile-btn`? IS GONE/.test(chatCss) && /btn-ai/.test(chatCss),
    '…and the note records that .chat-compile-btn was RETIRED and names the variant that replaced it, ' +
    'so the class disappearing from this file is an answer rather than a gap');
}

// ════════════════════════════════════════════════════════════════════════
section('§7 — THE PROJECT GROUP (v3.64.0): a second group, not a second domain selector');
// ════════════════════════════════════════════════════════════════════════
{
  const { tree, html } = render();
  const group = findByClass(tree, 'chat-project-group');
  ok(!!group, 'the project group is rendered');
  const inGroup = group.children.map((c) => c.classes.join('.'));
  ok(inGroup.includes('chat-scope-eyebrow.mono'), 'it carries its own PROJECT eyebrow');
  ok(/PROJECT/.test(html), '…and that eyebrow says PROJECT');

  /* THE ONE THING THIS GROUP MUST NOT BE. A second set of `data-scope-domain`
     pills here would be a second domain selector — two controls answering the
     same question, one of which does not work. */
  ok(!group.children.some((c) => c.classes.includes('chat-scope-pills')),
    'it holds NO domain pills — it is not a second domain selector');
  const domainButtons = (html.match(/data-scope-domain=/g) || []).length;
  eq(domainButtons, 1, 'there is exactly one domain pill in the whole bar (one domain in the fixture), so the project group added none');

  /* THE PICKER IS INSIDE THIS GROUP AND NOWHERE ELSE, stated as a PATH. */
  const trigger = findByClass(tree, 'lb-btn');
  ok(!!trigger && ancestorClasses(trigger).includes('chat-project-group'),
    'the project picker is INSIDE the project group');
  ok(!ancestorClasses(trigger).includes('chat-compile-group'),
    '…and inside no part of the compile control');
  ok(nearestCommonAncestor(trigger, findByClass(tree, 'chat-scope-count')).classes.includes('chat-scopebar'),
    'the nearest container holding the picker and the page-count readout is the bar itself');

  /* READING ORDER: domain, then project, then the spacer, then compile. */
  ok(html.indexOf('chat-scope-count') < html.indexOf('chat-project-group'),
    'the domain group is rendered before the project group');
  ok(html.indexOf('chat-project-group') < html.indexOf('chat-scope-spacer'),
    '…and the project group before the spacer, so both sit in the LEFT half');

  /* THE ⓘ IS A REAL DISCLOSURE, not a title attribute: it names the panel it
     controls, says whether it is open, and carries an accessible name of its
     own (the visible glyph is not one). */
  const info = findByClass(tree, 'chat-project-info');
  ok(!!info, 'the group carries an ⓘ');
  eq(info.attrs['data-tx-info'], 'chat-project-info',
    '…wired to shared/text.js\'s ONE delegated listener, not to a second hand-written handler');
  eq(info.attrs['aria-expanded'], 'false', '…reporting its collapsed state');
  eq(info.attrs['aria-controls'], 'chat-project-info', '…and naming the panel it controls');
  ok(typeof info.attrs['aria-label'] === 'string' && info.attrs['aria-label'].length > 0,
    '…with an accessible name, because "ⓘ" is not one');
  const panel = findByClass(tree, 'chat-project-panel');
  ok(!!panel, 'the panel it controls is rendered');
  /* ── NOT INSIDE THE BAR, AND THAT IS A MEASUREMENT ───────────────────────
     The first cut put the panel inside the project group, positioned
     absolutely. In the browser it reported itself OPEN at a sane rectangle
     and drew NOTHING: `.chat-scopebar` is `overflow-x: auto`, so per CSS its
     overflow-y resolves to `auto` too, and it clipped a descendant hanging
     below it. No z-index reaches out of a scroll container. The panel is now
     a SIBLING of the bar, in flow; `data-tx-info` matches by id anywhere in
     the document, so the button and its panel need not be siblings. */
  ok(!ancestorClasses(panel).includes('chat-scopebar'),
    '…OUTSIDE the scope bar, which is a scroll container and would clip it');
  ok(!ancestorClasses(panel).includes('chat-project-group'),
    '…and outside the group whose button opens it');
  ok(html.indexOf('chat-scopebar') < html.indexOf('chat-project-panel'),
    '…rendered immediately after the bar, so it reads as belonging to it');
  /* Asserted on the MARKUP, not on the parsed attrs: this file's tree parser
     only captures `name="value"` pairs, and `hidden` is a bare boolean
     attribute — so a parsed-attrs check would be vacuously false here and
     vacuously TRUE if someone wrote `hidden="false"`, which is still hidden
     in HTML. The regex pins the real thing: this element, closing with a
     bare `hidden`. */
  ok(/class="chat-project-panel"[^>]*\shidden>/.test(html),
    '…and it is rendered HIDDEN, so a browser with no JS never shows a permanently-open panel');
  /* ≤ 60 words is the brief's ceiling, and the sentence that has to be in
     there is the one a user cannot infer: nothing is written back. */
  const words = panel.text.trim().split(/\s+/).filter(Boolean).length;
  ok(words > 0 && words <= 60, `the ⓘ text is ${words} words, at or under the 60-word ceiling`);
  ok(/never writes/i.test(panel.text), '…and it says Chat never writes to the project');
  ok(/recorded data/i.test(panel.text), '…and that what it reads is recorded data');
}

// ════════════════════════════════════════════════════════════════════════
section('§8 — THE PROJECT GROUP\'S THREE STATES, told apart rather than merged');
// ════════════════════════════════════════════════════════════════════════
{
  const loading = render({ projectsState: 'loading', projectRows: [] });
  ok(!findByClass(loading.tree, 'lb-btn'), 'WHILE LOADING: no picker is offered');
  ok(/Reading projects/.test(loading.html), '…and the group says it is reading');

  const none = render({ projectsState: 'ready', projectRows: [] });
  ok(!findByClass(none.tree, 'lb-btn'), 'WITH NO PROJECTS: no picker is offered');
  ok(/No projects in this domain yet/.test(none.html),
    '…and the group says so — "asked, and there are none" is not the same fact as "not asked yet"');
  ok(!/Reading projects/.test(none.html), 'CONTROL: the two states do not render the same words');

  const failed_ = render({ projectsState: 'error', projectRows: [] });
  ok(/could not be read/i.test(failed_.html),
    'ON A FAILED READ: the group says so rather than showing an empty picker that silently sends nothing');

  /* THE FRESHNESS MARK exists only for a PINNED project — a dot beside
     "No project" would be a fact about nothing — and it is the SHARED scale:
     a `fresh-<tier>` class from shared/freshness.css, with the age in WORDS
     beside it so colour is never the only carrier. */
  const unpinned = render();
  ok(!findByClass(unpinned.tree, 'chat-project-readout'),
    'UNPINNED: no freshness readout, because there is nothing for it to be about');

  const pinned = render({ activeProject: 'curator' });
  const readout = findByClass(pinned.tree, 'chat-project-readout');
  ok(!!readout, 'PINNED: the readout appears');
  const dot = readout.children.find((c) => c.classes.includes('fresh-dot'));
  ok(!!dot, '…with the shared freshness dot');
  ok(dot.classes.some((c) => /^fresh-(live|recent|today|week|dormant|unknown)$/.test(c)),
    '…carrying a tier from the app-wide scale and not a private one');
  eq(dot.attrs['aria-hidden'], 'true', '…marked aria-hidden, because the words beside it say the same thing');
  ok(/saved/.test(readout.text), '…and the age is in WORDS, so colour is never the only carrier');

  /* A PROJECT THAT HAS NEVER BEEN SAVED TO is a third fact, and it must not
     be painted as "just now". */
  const neverSaved = render({ activeProject: 'lumina' });
  ok(/no saves yet/.test(findByClass(neverSaved.tree, 'chat-project-readout').text),
    'A NEVER-SAVED project reads "no saves yet", never an age it does not have');

  /* THE MEASURED READING of the last turn rides the readout, in its OWN
     addressable node — `sendCurrentMessage` patches that one element's text
     when an answer lands rather than repainting the group, so the id is part
     of the contract and not an incidental hook. */
  const withReading = render({ activeProject: 'curator', projectLastUsed: { chars: 12288 } });
  const fig = findByClass(withReading.tree, 'chat-project-figure');
  ok(!!fig, 'the measured reading has its own node');
  eq(fig.attrs.id, 'chat-project-figure',
    '…with the id the post-turn patch addresses, so the patch has a target that cannot move silently');
  ok(ancestorClasses(fig).includes('chat-project-readout'), '…inside the readout it belongs to');
  ok(/12 KB read/.test(fig.text),
    'after a turn it states what the project context actually contributed');
  const emptyFig = findByClass(pinned.tree, 'chat-project-figure');
  ok(!!emptyFig && emptyFig.text.trim() === '',
    'CONTROL: before any turn the node is present but EMPTY — no figure at all rather than a zero');
  ok(!/KB read/.test(findByClass(pinned.tree, 'chat-project-readout').text + (emptyFig.text || '')),
    'CONTROL: and nothing anywhere in the readout claims a reading');

  /* ONE PRODUCER for the figure. The renderer and the post-turn patch must
     not print it two ways, which is what a second format string here would
     mean — the duplication shape this repo records most often. */
  ok((chatSrc.match(/projectFigureText\(/g) || []).length >= 3,
    'the figure comes from ONE producer, called by both the renderer and the post-turn patch');
  ok(/figureEl\.textContent = projectFigureText\(/.test(chatSrc),
    '…and the post-turn update is a TARGETED patch, not a repaint of the group');
  ok(!/patchProjectGroup\(mountToken\)/.test(chatSrc),
    'CONTROL: a turn does NOT repaint the project group — that would rebuild the picker, and close an open menu, to move one figure');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat scope-bar assertions green');
