/**
 * test-next-chat-scopebar.js — OFFLINE suite for the Chat scope bar: the
 * DOMAINS readout, the PROJECT group and the COMPILE control
 * (src/public/next/views/chat.js). The eyebrow over the domain chips read
 * "SCOPE" until v3.64.1; the CLASS names (`.chat-scope-*`) keep the old word
 * and are pinned by two suites, so only the visible string moved.
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
 *   §6  The CSS rungs the two captions take.
 *   §7  The PROJECT group, and its ⓘ — which, since v3.64.1, opens UNDER its
 *       own button rather than at the column's left margin.
 *   §8  The project group's three states.
 *   §9  THE BAR WRAPS (v3.64.1) — the rule that makes clipping an action
 *       impossible, plus the anti-vacuity control over the pre-fix rule.
 *   §10 The eyebrow says DOMAINS, not SCOPE — a scope is a work-stream.
 *   §11 The saved-age readout stays in the BAR, not in the picker's menu.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/* THE REAL `renderReadout`, imported rather than stubbed. shared/text.js
   imports nothing and touches no browser global, so it loads in Node as it
   loads in the browser — which makes §11's footer assertions statements about
   the markup a user is served, not about a fixture that resembles it. */
import { renderReadout, renderReadoutGroup } from '../src/public/next/shared/text.js';
// THE IDENTITY MAPPING, REAL AND INJECTED (v3.65.1). `scopePillHtml` colours
// each domain chip through the kit's one mapping now — it was an inline
// `style="background:var(--accent)"`, the same violet on every chip — and a
// module-level import in views/chat.js is NOT visible inside a body lifted by
// brace-matching, so the name is a constructor parameter below. The REAL
// function, so §15's markup assertions stay assertions about what ships.
import { identityDotClass } from '../src/public/next/shared/sidebar.js';
// v3.66.0 P4 — the REAL depth bar, from its public address, so the footer's
// documents reading is asserted as the markup a user is served.
import { renderDepthCell } from '../src/public/next/shared/depth-bar.js';
// v3.71.1 — the project ⓘ is the SHARED mark now (CHAT_PROJECT_INFO =
// explainerMark('chat-project-info', 'chat.project')), so the REAL kit is
// injected under the name chat.js imports it by. Import-free and headless.
import { explainerHtml, explainerMark } from '../src/public/next/shared/explainer.js';
import { EXPLAINERS } from '../src/public/next/shared/explainers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_JS = path.join(ROOT, 'src/public/next/views/chat.js');
const chatSrc = readFileSync(CHAT_JS, 'utf8');
const textSrc = readFileSync(path.join(ROOT, 'src/public/next/shared/text.js'), 'utf8');

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
/* v3.66.0 P4 — the three helpers `projectFootHtml` now calls. Lifted
   wherever the footer is, so every sandbox builds the REAL footer; a new
   helper missing here fails as a ReferenceError naming it, never silently. */
function FOOT_HELPERS() {
  return ['formatCharsShort', 'projectDocumentOmissions', 'projectDocumentsReadout']
    .map((n) => extractFunction(chatSrc, n)).join('\n') + '\n';
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
/** v3.71.1: the project ⓘ's rendered panel, wrapper included, as markup. */
function projectInfoPanelOf(html) {
  const i = html.indexOf('<div class="chat-project-panel">');
  if (i === -1) return '';
  let depth = 0; const re = /<div\b|<\/div>/g; re.lastIndex = i; let m;
  while ((m = re.exec(html))) { depth += m[0] === '</div>' ? -1 : 1; if (depth === 0) return html.slice(i, re.lastIndex); }
  return '';
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
  /* WHAT `mountListbox` WAS HANDED. The queue itself is drained by renderMain
     (§6 asserts that), so it is empty by the time a section could read it —
     and the cfg is the contract for anything the kit renders from a FIELD
     rather than from markup (`footHtml`, §11). Recording at the mount point
     catches exactly the object the real kit would have closed over. */
  const mounted = [];
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
    /* v3.65.0 — the module-level handle on the MOUNTED picker's cfg. It is
       declared here for the same reason `pendingListboxes` is: the sandbox has
       no module scope, and an undeclared assignment inside a lifted body would
       silently create a global in sloppy mode instead of failing. */
    'let projectLbCfg = null;\n' +
    extractFunction(chatSrc, 'activeProjectRow') + '\n' +
    extractFunction(chatSrc, 'projectFigureText') + '\n' +
    /* v3.65.0, P10 — the knowledge-domain disclosure. All REAL: the set, the
       chip producer and the readout, so §15's assertions are about the markup
       a user is served rather than about a fixture shaped like it. */
    extractFunction(chatSrc, 'projectKnowledgeSet') + '\n' +
    extractFunction(chatSrc, 'scopePillLabelFor') + '\n' +
    extractFunction(chatSrc, 'scopePillAriaFor') + '\n' +
    extractFunction(chatSrc, 'scopePillHtml') + '\n' +
    extractFunction(chatSrc, 'projectKnowledgeReadout') + '\n' +
    FOOT_HELPERS() +
    extractFunction(chatSrc, 'projectFootHtml') + '\n' +
    extractFunction(chatSrc, 'projectListboxCfg') + '\n' +
    // v3.71.1: the project ⓘ is the shared mark, a module const
    // projectGroupHtml and projectInfoPanelHtml both reference.
    extractConst(chatSrc, 'CHAT_PROJECT_INFO') + '\n' +
    extractFunction(chatSrc, 'projectGroupHtml') + '\n' +
    extractFunction(chatSrc, 'projectInfoPanelHtml') + '\n' +
    extractFunction(chatSrc, 'renderMain') + '\n' +
    'return { renderMain, compileControlHtml, compileCaptionText, compileMessageCount, compileTurnCounts, projectGroupHtml, projectFootHtml, pendingListboxes, peekProjectLbCfg: () => projectLbCfg };';

  const api = new Function(
    'document', 'state', 'isCurrentMount', 'setMain', 'escapeHtml', 'icon',
    'renderViewHeader', 'gatedLoader', 'bootGate', 'emptyCard', 'navigate',
    'renderComposerHtml', 'wireComposer', 'renderThreadOnly', 'renderComposerPickers',
    'startCompile', 'switchDomain', 'reportAsyncActionFailure',
    'renderListboxHtml', 'formatAge', 'freshnessTier', 'selectChatProject', 'mountListbox',
    'renderReadoutGroup', 'identityDotClass', 'renderDepthCell', 'explainerMark',
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
       is emptied, so the composer's own pass cannot inherit a stale cfg — and
       WHICH cfgs were handed over, which is §11's subject. */
    (cfg) => { mounted.push(cfg); },
    /* NOT a stub: the real kit function, imported at the top of this file. */
    renderReadoutGroup, identityDotClass, renderDepthCell, explainerMark,
  );

  api.renderMain(1);
  return { state, api, mounted, html: captured.html, tree: parseTree(captured.html || '') };
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

  /* ── WHICH GROUPS MAY SHRINK, AND WHY THE ANSWER CHANGED (v3.64.1) ─────
     This asserted `flex: none` on BOTH, with the reason "the bar scrolls
     horizontally, so a shrinkable group would compress its own label". The
     bar WRAPS now, and that reason inverted for one of the two. MEASURED at
     568px, where the rail (72) and this view's sidebar (272) leave the bar
     224px: a `flex: none` domain group sat at its ~530px max-content width and
     its pill row ran to x=869 against a bar ending at 568 — clipped, with no
     scroll left to recover it. `flex-wrap` alone could not help, because a
     wrapping flex container's max-content width IS its single-line width.

     So the DOMAIN group shrinks and wraps, and the other two do not:
     `.chat-project-group` holds a picker with a minimum width and a one-line
     readout, `.chat-compile-group` holds the action this whole section exists
     to keep whole. Both still take the next ROW rather than compressing. */
  ok(/display:\s*flex/.test(bodyOf('.chat-scope-group')), '.chat-scope-group is a flex row');
  ok(/flex:\s*0 1 auto/.test(bodyOf('.chat-scope-group')) && /min-width:\s*0/.test(bodyOf('.chat-scope-group')),
    '…and it SHRINKS, which is what lets its pills wrap instead of being clipped at 568px');
  ok(/display:\s*flex/.test(bodyOf('.chat-compile-group')), '.chat-compile-group is a flex row');
  ok(/flex:\s*none/.test(bodyOf('.chat-compile-group')),
    '…and does NOT shrink — a squeezed Compile button is the same defect by another route');
  ok(/flex:\s*none/.test(bodyOf('.chat-project-group')),
    'and the project group opts back out of shrinking too, so its picker keeps a readable width');
  ok(/flex:\s*0 1 auto/.test(bodyOf('.chat-scope-pills')) && /min-width:\s*0/.test(bodyOf('.chat-scope-pills')),
    'the pill row shrinks with its group — `flex: none` there would hold the single-line width regardless');
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
  /* TWO ROWS since v3.64.1: a `.chat-project-controls` row, then the ⓘ's
     panel. The group is a COLUMN, which is what puts the panel under the
     control rather than beside it — the measurement is in chat.css's own note.
     So the eyebrow is a child of the CONTROLS row, not of the group. */
  const controls = group.children.find((c) => c.classes.includes('chat-project-controls'));
  ok(!!controls, 'the group holds a controls row');
  const inGroup = controls.children.map((c) => c.classes.join('.'));
  ok(inGroup.includes('chat-scope-eyebrow.mono'), 'it carries its own PROJECT eyebrow');
  ok(group.children.length === 2,
    `the group is exactly the controls row and the panel (got ${group.children.length})`);
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
  /* v3.71.1: the button is shared/text.js's (through shared/explainer.js's
     explainerMark), not a hand-rolled `.chat-project-info` — so it is found
     by its unchanged id and asserted to BE the shared mark. */
  let info = null;
  walk(tree, (n) => { if (!info && n.attrs.id === 'chat-project-info-btn') info = n; });
  ok(!!info, 'the group carries an ⓘ');
  ok(!!info && info.classes.includes('tx-vh-info'),
    '…and it is shared/text.js\'s mark (class tx-vh-info), not a local copy');
  ok(!!info && ancestorClasses(info).includes('chat-project-controls'),
    '…sitting in the project controls row, beside the picker');
  eq(info.attrs['data-tx-info'], 'chat-project-info',
    '…wired to shared/text.js\'s ONE delegated listener, not to a second hand-written handler');
  eq(info.attrs['aria-expanded'], 'false', '…reporting its collapsed state');
  eq(info.attrs['aria-controls'], 'chat-project-info', '…and naming the panel it controls');
  eq(info.attrs['aria-label'], EXPLAINERS['chat.project'].label,
    '…with the explainer\'s accessible name, because "ⓘ" is not one');
  ok(!html.includes('>ⓘ<'), 'the typed "ⓘ" CHARACTER is gone — the button renders an SVG, not text');
  /* v3.71.0 pinned a LOCAL glyph copy (CHAT_PROJECT_INFO_GLYPH) byte-equal
     to shared/text.js's; v3.71.1 deleted the copy, so the pin becomes: there
     is no copy to drift. The glyph now comes from the one INFO_GLYPH. */
  ok(!/CHAT_PROJECT_INFO_GLYPH/.test(chatSrc), 'chat.js carries no local copy of the ⓘ glyph any more');
  ok(!/<svg/.test(extractFunction(chatSrc, 'projectGroupHtml')),
    '…and projectGroupHtml hand-writes no SVG — the mark is the shared one');
  const panel = findByClass(tree, 'chat-project-panel');
  ok(!!panel, 'the panel it controls is rendered');
  /* ── UNDER ITS OWN BUTTON. TWO MEASUREMENTS, AND THE SECOND ONE MOVED IT
        BACK (v3.64.1) ──────────────────────────────────────────────────────
     v3.64.0's first cut put the panel inside the project group, positioned
     `absolute`. In the browser it reported itself OPEN at a sane rectangle and
     drew NOTHING: `.chat-scopebar` was `overflow-x: auto`, so per CSS its
     overflow-y resolved to `auto` too and it clipped a descendant hanging
     below it. No z-index reaches out of a scroll container. It was moved OUT,
     to a sibling of the bar, in flow — and THAT is what was then reported from
     production: "the ⓘ opens somewhere on the left." A block in flow under the
     bar starts at the column's left margin while its button sits wherever the
     project group lands, so the panel appeared under the DOMAIN chips.

     v3.64.1 removes the cause rather than trading one symptom for the other:
     the bar wraps and no longer clips anything (§9), so the panel lives inside
     the group again — IN FLOW, taking a row of its own, NOT absolutely
     positioned and NOT inside the picker's menu. The assertions therefore
     REVERSE, and they are stated as a path so a future "tidy-up" that floats
     it or folds it into the listbox cannot pass. */
  ok(ancestorClasses(panel).includes('chat-project-group'),
    '…INSIDE the group whose button opens it, so it can only open under that button');
  ok(ancestorClasses(panel).includes('chat-scopebar'),
    '…which puts it inside the bar — safe only because §9 proves the bar no longer clips');
  ok(html.indexOf('chat-project-info-btn') < html.indexOf('chat-project-panel'),
    '…and it is rendered AFTER its own button, so it reads as that button\'s disclosure');
  /* THE ⓘ IS NOT A CONTROL INSIDE A FOLD. docs/design-system-source.md §3
     refuses that outright, and the concrete cost is shared/listbox.js's roving
     focus: a button inside `.lb-menu` is unreachable by the component's own
     keyboard model and brings a second Escape handler to fight the first. The
     menu only exists while open, so this is asserted on the markup the
     renderer emits — the trigger is here, the ⓘ is its SIBLING, and neither
     the button nor the panel is inside a `lb-` container. */
  ok(!ancestorClasses(info).some((c) => /^lb-/.test(c)),
    'the ⓘ button is not inside any listbox container — a control may never go inside a fold');
  ok(!ancestorClasses(panel).some((c) => /^lb-/.test(c)),
    '…and neither is its panel, which would otherwise exist only while the menu is open');
  /* Asserted on the MARKUP, not on the parsed attrs: this file's tree parser
     only captures `name="value"` pairs, and `hidden` is a bare boolean
     attribute — so a parsed-attrs check would be vacuously false here and
     vacuously TRUE if someone wrote `hidden="false"`, which is still hidden
     in HTML. The regex pins the real thing: this element, closing with a
     bare `hidden`. */
  /* v3.71.1: `.chat-project-panel` is now a WRAPPER (chat.css owns it); the
     disclosure inside it is the shared tx-vh-panel, id unchanged, hidden. */
  ok(/<div class="chat-project-panel"><div class="tx-vh-panel" id="chat-project-info" role="group"[^>]*\shidden>/.test(html),
    '…and it is rendered HIDDEN, so a browser with no JS never shows a permanently-open panel');
  /* THE PANEL IS THE EXPLAINER. Its old prose (≤ 60 words, "never writes",
     "recorded data") moved into EXPLAINERS['chat.project'], whose shape
     test-explainers owns; here the pin is that what ships IS that entry. */
  eq(projectInfoPanelOf(html),
    '<div class="chat-project-panel">' + explainerMark('chat-project-info', 'chat.project').panel + '</div>',
    'the panel is the wrapper around the shared mark\'s panel, byte for byte');
  ok(projectInfoPanelOf(html).includes(explainerHtml('chat.project')),
    '…whose body byte-equals explainerHtml(\'chat.project\')');
  ok(/never writes/i.test(explainerHtml('chat.project')), '…and it says Chat never writes to the project');
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

  /* THE BAR CARRIES NAMES ONLY (v3.65.0). The freshness mark and the measured
     reading used to sit on the controls row; they are the picker's footer now
     (§11 proves where they went and that they still update). What this section
     pins is the ABSENCE — an element whose rule has been deleted must not be
     re-emitted by a later edit, in any of the four project states. */
  for (const [label, over] of [
    ['UNPINNED', {}],
    ['PINNED', { activeProject: 'curator' }],
    ['NEVER SAVED', { activeProject: 'lumina' }],
    ['AFTER A TURN', { activeProject: 'curator', projectLastUsed: { chars: 12288 } }],
  ]) {
    const r = render(over);
    ok(!findByClass(r.tree, 'chat-project-readout'),
      `${label}: no readout in the BAR — the group is an eyebrow and a control`);
    ok(!/id="chat-project-figure"/.test(r.html),
      `${label}: …and no figure node in the bar either`);
    ok(!/characters read|KB read/.test(r.html), `${label}: …nothing in the bar claims a reading`);
    ok(!/fresh-dot/.test(r.html), `${label}: …and no freshness dot`);
  }

  /* ONE PRODUCER for the figure, and ONE for the footer that carries it. A
     second format string, or a second place that builds the footer, is the
     duplication shape this repo records most often. */
  ok((chatSrc.match(/projectFigureText\(/g) || []).length >= 2,
    'the figure comes from ONE producer');
  eq((chatSrc.match(/formatCharsShort\(used\.chars\)/g) || []).length, 1,
    '…and the whole-block arithmetic appears exactly once in the file');
  /* v3.66.0 — THE MISLABEL IS GONE. `chars` is a UTF-16 LENGTH; `/ 1024 + ' KB'`
     called thousands of characters kilobytes. Neither the division nor the
     unit may come back anywhere in the view. */
  eq((chatSrc.match(/used\.chars \/ 1024/g) || []).length, 0,
    '…and no character count is divided by 1024 and called KB (the v3.65.x mislabel)');
  ok(!/' KB read/.test(chatSrc), '…and no "KB read" string survives in the view');
  eq((chatSrc.match(/footHtml = projectFootHtml\(\)|footHtml: projectFootHtml\(\)/g) || []).length, 2,
    'the footer has ONE builder, used by the cfg and by the post-turn update — and by nothing else');
  ok(!/patchProjectGroup\(mountToken\)/.test(chatSrc),
    'CONTROL: a turn does NOT repaint the project group — that would rebuild the picker, and close an open menu, to move one figure');
}


// ════════════════════════════════════════════════════════════════════════
section('§9 — THE BAR WRAPS, SO NO ACTION CAN BE CLIPPED (v3.64.1)');
// ════════════════════════════════════════════════════════════════════════
// ── THE DEFECT THIS SECTION EXISTS FOR ───────────────────────────────────
// Reported from production against v3.64.0, at an ordinary 1370px window: the
// Compile control was cut in half by the right edge of the column. MEASURED
// CAUSE, and it is one cause for two defects: `.chat-scopebar` was
// `overflow-x: auto` with its scrollbar deliberately hidden, and every group
// in it is `flex: none` — so the moment the four groups exceeded the width,
// the LAST one neither wrapped nor shrank. It went into a scroll region with
// no scrollbar to reveal it. The same rule (a box whose overflow-x is not
// `visible` resolves overflow-y to `auto`) is what made the project ⓘ's panel
// paint nothing in v3.64.0's first cut.
//
// WHAT CAN AND CANNOT BE ASSERTED OFFLINE, SAID PLAINLY: there is no layout
// engine here, so "the button is fully visible at 1370px" is NOT available and
// is not claimed. What IS available is the rule that decides it — the bar's
// own overflow and wrap declarations, and the action's presence in the normal
// flow of the bar rather than behind a scroll region. The browser pass at
// 1370 / 1024 / 568 is the other half and is recorded in the commit message.
{
  const chatCss = readFileSync(path.join(ROOT, 'src/public/next/views/chat.css'), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodyOf = (sel) => {
    const m = new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
      .exec(strip(chatCss));
    return m ? m[1] : '';
  };

  const bar = bodyOf('.chat-scopebar');
  ok(bar !== '', 'CONTROL: the bar rule was found (an empty body would make every line below vacuous)');
  ok(/flex-wrap:\s*wrap/.test(bar),
    'the bar WRAPS — a group that does not fit takes the next row instead of leaving the column');
  ok(/overflow:\s*visible/.test(bar),
    '…and declares `overflow: visible`, which is what stops it being a scroll container at all');
  ok(!/overflow-x:\s*auto/.test(bar),
    '…and no longer sets `overflow-x: auto`, the declaration that hid the Compile button');
  ok(/row-gap:/.test(bar),
    '…with a row gap, so a wrapped second row is spaced rather than touching the first');

  /* THE PILLS WRAP TOO, and that is not cosmetic. A flex item is never shrunk
     below its min-content width, so a nowrap row of one pill per domain would
     be the single child wide enough to push an overflow back onto the bar —
     re-creating the defect from inside the first group. */
  ok(/flex-wrap:\s*wrap/.test(bodyOf('.chat-scope-pills')),
    'the domain pills wrap as well, so the first group can never be the child that overflows the bar');

  /* THE ACTION IS IN THE BAR'S NORMAL FLOW. `flex: none` used to mean "the bar
     scrolls, so do not let a group compress its own label"; it now means "a
     group takes the next row WHOLE". Either way the compile group must not be
     shrinkable — a squeezed Compile button is the same defect by another
     route. */
  ok(/flex:\s*none/.test(bodyOf('.chat-compile-group')),
    'the compile group does not shrink — it wraps whole or not at all');

  /* ── THE ⓘ PANEL TAKES A ROW OF ITS OWN, IN FLOW ───────────────────────
     It lives inside `.chat-project-group` (§7), which is a flex row. Without
     a full-width basis it would sit BESIDE the picker as a fourth item and
     open as a sliver; with one, it forces a break and opens directly under
     the ⓘ. That pair of declarations — the group wraps, the panel claims the
     whole line — is what replaces the absolute positioning the bar used to
     clip, so both halves are pinned. */
  ok(/flex-wrap:\s*wrap/.test(bodyOf('.chat-scope-group')),
    'the groups wrap internally, so a long row of chips never overflows the bar');
  /* ── THE PANEL'S OWN ROW IS A COLUMN, NOT A WRAP. MEASURED. ────────────
     The first cut made the project group a wrapping ROW and gave the panel
     `flex: 0 0 100%`. It did NOT take a line of its own: the group is
     `flex: none`, so its main size is content-based and a percentage basis
     against an indefinite containing block resolves to content size — at
     1370px the panel sat BESIDE the picker, x=633 against an ⓘ at x=610, on
     one 93px-tall line. `flex-direction: column` + `align-self: stretch` needs
     no percentage and cannot do that, so BOTH are pinned here. */
  ok(/flex-direction:\s*column/.test(bodyOf('.chat-project-group')),
    'the project group is a COLUMN — controls on one row, the ⓘ panel on the next');
  ok(/align-self:\s*stretch/.test(bodyOf('.chat-project-panel')),
    '…and the panel spans that column, so it opens UNDER the ⓘ rather than beside the picker');
  ok(/align-items:\s*flex-start/.test(bodyOf('.chat-project-group')),
    '…left-aligned, so the picker does not slide sideways when the wider panel opens under it');
  ok(/display:\s*flex/.test(bodyOf('.chat-project-controls')),
    'CONTROL: the controls row is still a row, so the picker and its readout stay on one line');
  ok(!/position:\s*absolute/.test(bodyOf('.chat-project-panel')),
    '…IN FLOW: not absolutely positioned, so there is no overlay layer and nothing to clip it');
  // v3.71.1: the [hidden] element is the shared tx-vh-panel INSIDE the
  // wrapper, so the wrapper's counter-rule is `:has(> [hidden])` — without it
  // a closed ⓘ would still leave an empty row in the group.
  ok(/display:\s*none/.test(bodyOf('.chat-project-panel:has(> [hidden])')),
    'CONTROL: the [hidden] counter-rule is still there — the wrapper takes no row while its panel is closed');

  /* ANTI-VACUITY. Run the same three predicates over the PRE-FIX declarations
     and require them to fail, so a green above is evidence rather than a
     tautology about a regex that matches anything. */
  const preFix = 'display: flex; align-items: center; overflow-x: auto; scrollbar-width: none;';
  ok(!/flex-wrap:\s*wrap/.test(preFix) && /overflow-x:\s*auto/.test(preFix),
    'CONTROL: the pre-fix bar declarations fail the wrap predicate and match the scroll one');

  /* THE TWO SCROLLBAR-HIDE DECLARATIONS STAY, and this says why rather than
     leaving a reader to wonder: scripts/test-next-scrollbars.js §6 pins them
     by name and is not this package's file. They are inert while the bar is
     `overflow: visible`, which is stated in the CSS comment itself — the
     honest record of a rule kept for a reason outside its own file. */
  ok(/scrollbar-width:\s*none/.test(bar),
    'the scrollbar hide is kept (pinned by name in test-next-scrollbars.js §6, inert while overflow is visible)');
  ok(/INERT/.test(chatCss),
    '…and the CSS says so in as many words, so the next reader is not left to discover it');
}

// ════════════════════════════════════════════════════════════════════════
section('§10 — THE EYEBROW SAYS DOMAINS, BECAUSE THE CHIPS ARE DOMAINS (v3.64.1)');
// ════════════════════════════════════════════════════════════════════════
section('§11 — THE READING MOVED INTO THE PICKER\'S FOOTER, AND STILL UPDATES (v3.65.0)');
// ════════════════════════════════════════════════════════════════════════
// THIS SECTION REVERSES ITS OWN v3.64.1 SELF, and the previous text is the
// reason this one is as long as it is. It read: "The v3.65.0 design pass
// proposes moving this readout into the listbox's `cfg.footHtml` slot. That
// slot renders inside `.lb-menu`, which exists ONLY while the menu is open —
// so the freshness of the pinned project would be invisible until you opened
// a picker to change it, and `#chat-project-figure`, which sendCurrentMessage
// patches after every turn, would not be in the document to patch. That is a
// deliberate v3.65.0 trade with a guard designed for it."
//
// BOTH HALVES OF THAT OBJECTION ARE TRUE AND BOTH ARE ANSWERED HERE.
//  • The FRESHNESS half is a real cost and is paid, not argued away: the
//    pinned project's age is now one press from the bar instead of on it. It
//    is not lost — every option row already carries its own project's age as
//    `detail` (§11c drives that), so the press that hides it also shows the
//    ages of ALL of them. Recorded so the trade is a decision on the record.
//  • The PATCH half is the guard, and §11d executes it rather than reading
//    for it: the post-turn update writes `cfg.footHtml` FIRST — which is what
//    the next menu build reads — and touches the DOM only if a footer happens
//    to be live. Without that ordering the figure would freeze the moment the
//    picker closed, which is every moment but one.
{
  // ── §11a — THE FOOTER IS A CFG FIELD, WHICH IS THE REAL CONTRACT ──────
  // shared/listbox.js reads `cfg.footHtml` when it BUILDS the menu, so the
  // string on the cfg IS what a user is served. The sandbox's listbox stub
  // cannot render it (the menu is the kit's, on <body>), so these assertions
  // read the queued cfg — the same object `mountListbox` is handed.
  const pinned = render({ activeProject: 'curator' });
  const cfg = pinned.mounted[0];
  ok(!!cfg && cfg.id === 'chat-project-lb', 'the project picker queues its cfg');
  ok(typeof cfg.footHtml === 'string' && cfg.footHtml.length > 0,
    'PINNED: the cfg carries a footer');
  ok(/tx-readout/.test(cfg.footHtml),
    '…rendered through shared/text.js\'s readout, not a hand-built row');
  ok(/saved/.test(cfg.footHtml), '…stating the age in WORDS');
  ok(/fresh-dot fresh-(live|recent|today|week|dormant|unknown)/.test(cfg.footHtml),
    '…with a tier from the app-wide freshness scale and not a private one');
  ok(/aria-hidden="true"/.test(cfg.footHtml),
    '…and the dot is aria-hidden, because the words beside it say the same thing');
  ok(/>curator</.test(cfg.footHtml), '…and it names the project it is about');

  // ── §11b — THREE STATES, AND THE ABSENCES ARE THE INTERESTING ONES ────
  const unpinned = render();
  const cfgU = unpinned.mounted[0];
  eq(cfgU.footHtml, '',
    'UNPINNED: no footer at all — with nothing pinned there is no reading to take, ' +
    'and shared/listbox.js omits `.lb-foot` entirely for an empty string');
  const never = render({ activeProject: 'lumina' });
  ok(/no saves yet/.test(never.mounted[0].footHtml),
    'A NEVER-SAVED project reads "no saves yet", never an age it does not have');
  ok(!/characters read|KB read/.test(pinned.mounted[0].footHtml),
    'CONTROL: before any turn the footer claims NO reading — no zero, no placeholder');
  const after = render({ activeProject: 'curator', projectLastUsed: { chars: 12288 } });
  ok(/whole block 12\.3k characters read last turn/.test(after.mounted[0].footHtml),
    'AFTER A TURN: the footer states what the project context actually contributed');
  ok(/tx-readout-prov/.test(after.mounted[0].footHtml),
    '…in the readout\'s provenance slot, which is what that slot is for');
  ok(!/tx-readout-prov/.test(pinned.mounted[0].footHtml),
    'CONTROL: and that slot does not exist before there is a measurement to put in it');

  // ── §11c — THE COST IS BOUNDED: THE MENU ALREADY SHOWS EVERY AGE ──────
  // This is what makes hiding the pinned project's mark a trade rather than a
  // loss, so it is asserted rather than asserted-about-in-a-comment.
  const rows = after.mounted[0].options.filter((o) => o.value);
  ok(rows.length >= 2, 'the picker offers every project in the domain');
  ok(rows.every((o) => typeof o.detail === 'string' && o.detail.length > 0),
    '…each row carrying its OWN age, so the press that hides one mark reveals all of them');
  ok(rows.some((o) => o.detail === 'no saves'),
    '…including "no saves" for a project that has never been saved to');

  // ── §11e — THE HANDLE IS DROPPED WHEN THERE IS NO PICKER ────────────
  // Three of the group's four states render no picker at all. The cfg handle
  // must go with the trigger that is leaving the document, or a turn landing
  // afterwards would republish onto a dead object — and, worse, read as
  // though a picker were mounted when none is.
  /* DRIVEN AS A TRANSITION, NOT AS A FRESH RENDER, and mutation M11 is why:
     a new sandbox starts with the handle already null, so rendering a
     no-picker state into a FRESH one passes whether the drop exists or not.
     The defect is a picker that WAS mounted and then was not, so the sequence
     has to be exactly that — one sandbox, one state object, two renders. */
  for (const [label, over] of [
    ['WHILE LOADING', { projectsState: 'loading', projectRows: [] }],
    ['WITH NO PROJECTS', { projectsState: 'ready', projectRows: [] }],
    ['ON A FAILED READ', { projectsState: 'error', projectRows: [] }],
  ]) {
    const r = render({ activeProject: 'curator' });
    ok(!!r.api.peekProjectLbCfg(), `${label} — CONTROL: a picker was mounted first, so there IS a handle to drop`);
    Object.assign(r.state, over);
    r.api.renderMain(1);
    eq(r.api.peekProjectLbCfg(), null,
      `${label}: the cfg handle is dropped, so nothing republishes onto a trigger that has left`);
  }

  // ── §11d — THE GUARD, DRIVEN ───────────────────────────────
  // The real `patchProjectFooter`, against a document that models the ONE
  // thing that matters: whether a menu is in it. Both arms are executed — the
  // common one (shut: the cfg is updated and nothing is touched) and the rare
  // one (open: the live footer is rewritten too).
  {
    const state = {
      activeDomain: 'articles', activeProject: 'curator',
      projectLastUsed: null,
      projectsState: 'ready',
      projectRows: [{ project: 'curator', ageSeconds: 600 }],
    };
    const src =
      extractFunction(chatSrc, 'activeProjectRow') + '\n' +
      extractFunction(chatSrc, 'projectFigureText') + '\n' +
      extractFunction(chatSrc, 'projectKnowledgeReadout') + '\n' +
      FOOT_HELPERS() +
    extractFunction(chatSrc, 'projectFootHtml') + '\n' +
      extractFunction(chatSrc, 'patchProjectFooter') + '\n' +
      'return { patchProjectFooter, projectFootHtml };';
    const make = (doc, cfgHandle) => new Function(
      'document', 'state', 'projectLbCfg', 'formatAge', 'freshnessTier', 'renderReadoutGroup',
      'renderDepthCell',
      src,
    )(doc, state, cfgHandle,
      (sec) => (sec === null ? 'unknown' : Math.round(sec / 60) + ' min ago'),
      (sec) => (sec === null ? 'unknown' : 'today'),
      renderReadoutGroup, renderDepthCell);

    /* CONTROL FIRST: with no picker mounted there is nothing to republish and
       nothing may be touched. A `patchProjectFooter` that assumed a cfg would
       throw here, on a domain whose projects failed to read. */
    let touched = 0;
    const blindDoc = { getElementById: () => { touched++; return null; } };
    /* CAUGHT, not allowed to propagate. Without the guard this THROWS on
       `null.footHtml` — which is the production behaviour too, on a domain
       whose project read failed — and an uncaught throw here would abort the
       whole run instead of reporting one failed assertion. Mutation M6
       (the guard deleted) is what made this distinction worth writing down. */
    let threw = null;
    try { make(blindDoc, null).patchProjectFooter(); } catch (e) { threw = e; }
    ok(threw === null,
      'NO PICKER MOUNTED: the update returns instead of throwing' + (threw ? ` (threw ${threw.message})` : ''));
    eq(touched, 0, '…and before it looks for anything');

    /* THE COMMON ARM: the menu is SHUT, so there is no `.lb-foot` in the
       document. The cfg must still be brought up to date, because that string
       is what the next open renders. */
    const cfgShut = { footHtml: 'STALE' };
    const shutDoc = { getElementById: () => null };
    state.projectLastUsed = { chars: 12288 };
    make(shutDoc, cfgShut).patchProjectFooter();
    ok(/whole block 12\.3k characters read last turn/.test(cfgShut.footHtml),
      '★ MENU SHUT: the cfg is republished anyway — the next open shows the new figure');
    ok(!/STALE/.test(cfgShut.footHtml), '…and the stale string is gone');

    /* THE RARE ARM: an answer lands while the picker is open. */
    const foot = { innerHTML: 'STALE' };
    const menu = { querySelector: (sel) => (sel === '.lb-foot' ? foot : null) };
    const openDoc = { getElementById: (id) => (id === 'chat-project-lb-menu' ? menu : null) };
    const cfgOpen = { footHtml: 'STALE' };
    make(openDoc, cfgOpen).patchProjectFooter();
    ok(/whole block 12\.3k characters read last turn/.test(foot.innerHTML),
      '★ MENU OPEN: the live footer is rewritten too, so an open picker does not show yesterday\'s figure');
    ok(foot.innerHTML === cfgOpen.footHtml,
      '…with the SAME string the cfg got — one producer, so the two cannot disagree');

    /* THE MENU'S ID IS THE KIT'S OWN PUBLIC CONTRACT (`cfg.id + '-menu'`, what
       the trigger's aria-controls names), so the view may construct it. Pinned
       because a rename in the kit must break this loudly rather than leave the
       open-menu arm silently dead. */
    ok(/chat-project-lb-menu/.test(chatSrc),
      'the open-menu arm addresses the menu by the kit\'s documented id');
    ok(/aria-controls="' \+ escapeHtml\(id\) \+ '-menu"/.test(
      readFileSync(path.join(ROOT, 'src/public/next/shared/listbox.js'), 'utf8')),
      '…and that id really is what the kit names on the trigger, read from the kit itself');
  }
}


// ════════════════════════════════════════════════════════════════════════
section('§12 — AN OPEN ⓘ SURVIVES A BACKGROUND REPAINT OF ITS GROUP (v3.64.1)');
// ════════════════════════════════════════════════════════════════════════
// The panel is a child of `.chat-project-group` now, which is the element
// `patchProjectGroup` rewrites wholesale whenever the project list is re-read
// — a fetch the user did not ask for and does not see. Without this, opening
// the ⓘ and waiting a moment would snap it shut mid-sentence for no visible
// reason, which is worse than the placement it fixes.
//
// DRIVEN, NOT SCANNED: the real `patchProjectGroup` runs against a document
// small enough to model exactly what it touches — one host element, and the
// two nodes the disclosure's state lives on.
{
  /* ── THE FAKE DOCUMENT MODELS THE ONE THING THAT MATTERS HERE ───────────
     `host.innerHTML = …` REPLACES the nodes. The first version of this fake
     kept its attribute maps across that assignment, so a repaint left the old
     open/closed state lying around and the section passed with the preserve
     logic DELETED — a green-first mutation, caught by running it. The setter
     now discards the maps and re-seeds them FROM THE MARKUP the renderer just
     produced (`aria-expanded="…"`, and the bare `hidden` attribute), which is
     what a browser does: the panel comes back closed unless something puts it
     back. */
  function fakeDoc() {
    let attrs = new Map();       // id -> { 'aria-expanded': '…' }
    let hiddenFlags = new Map(); // id -> boolean
    const reseed = (html) => {
      attrs = new Map();
      hiddenFlags = new Map();
      const tagRe = /<[a-z]+\b([^>]*)>/gi;
      let m;
      while ((m = tagRe.exec(html))) {
        const idM = /\bid="([^"]+)"/.exec(m[1]);
        if (!idM) continue;
        const id = idM[1];
        const ae = /\baria-expanded="([^"]*)"/.exec(m[1]);
        if (ae) attrs.set(id, { 'aria-expanded': ae[1] });
        hiddenFlags.set(id, /\shidden(\s|$|=)/.test(m[1]));
      }
    };
    let html = '';
    const host = {
      id: 'chat-project-group',
      get innerHTML() { return html; },
      set innerHTML(v) { html = v; reseed(v); },
    };
    const nodeFor = (id) => {
      if (html.indexOf('id="' + id + '"') === -1) return null;
      return {
        getAttribute: (k) => (attrs.has(id) ? attrs.get(id)[k] : undefined),
        setAttribute: (k, v) => { attrs.set(id, Object.assign(attrs.get(id) || {}, { [k]: v })); },
        get hidden() { return hiddenFlags.has(id) ? hiddenFlags.get(id) : true; },
        set hidden(v) { hiddenFlags.set(id, v); },
      };
    };
    return {
      host,
      getElementById: (id) => (id === 'chat-project-group' ? host : nodeFor(id)),
      querySelectorAll: () => [],
      // The state shared/text.js writes when the user presses the ⓘ: the two
      // attributes, on the two nodes, together.
      open() { attrs.set('chat-project-info-btn', { 'aria-expanded': 'true' }); hiddenFlags.set('chat-project-info', false); },
    };
  }

  function makePatcher(doc, state) {
    const calls = { closed: 0, mounted: 0 };
    const src =
      'const pendingListboxes = [];\n' +
      'let projectLbCfg = null;\n' +
      extractFunction(chatSrc, 'activeProjectRow') + '\n' +
      extractFunction(chatSrc, 'projectFigureText') + '\n' +
      extractFunction(chatSrc, 'projectKnowledgeReadout') + '\n' +
      FOOT_HELPERS() +
    extractFunction(chatSrc, 'projectFootHtml') + '\n' +
      extractFunction(chatSrc, 'projectListboxCfg') + '\n' +
      extractConst(chatSrc, 'CHAT_PROJECT_INFO') + '\n' +
      extractFunction(chatSrc, 'projectInfoPanelHtml') + '\n' +
      extractFunction(chatSrc, 'projectGroupHtml') + '\n' +
      extractFunction(chatSrc, 'patchProjectGroup') + '\n' +
      'return { patchProjectGroup };';
    const api = new Function(
      'document', 'state', 'isCurrentMount', 'escapeHtml', 'closeAllListboxes',
      'renderListboxHtml', 'formatAge', 'freshnessTier', 'selectChatProject', 'mountListbox',
      'renderReadoutGroup', 'renderDepthCell', 'explainerMark',
      src
    )(
      doc, state, () => true, escapeHtmlStub,
      () => { calls.closed++; },
      (cfg) => '<span class="lb"><button class="lb-btn" id="' + cfg.id + '"></button></span>',
      (sec) => (sec === null ? 'unknown' : Math.round(sec / 60) + ' min ago'),
      (sec) => (sec === null ? 'unknown' : 'today'),
      () => {},
      () => { calls.mounted++; },
      renderReadoutGroup, renderDepthCell, explainerMark,
    );
    return { api, calls };
  }

  const state = {
    activeDomain: 'articles', activeProject: 'curator', projectLastUsed: null,
    projectsState: 'ready', projectRows: [{ project: 'curator', ageSeconds: 600 }],
  };

  // CLOSED stays closed — the ordinary case, and the control that proves the
  // restore below is not simply forcing the panel open every time.
  const dShut = fakeDoc();
  const pShut = makePatcher(dShut, state);
  pShut.api.patchProjectGroup(1);
  ok(/chat-project-panel/.test(dShut.host.innerHTML),
    'control: the repaint really did rebuild the group, panel and all');
  ok(dShut.getElementById('chat-project-info-btn').getAttribute('aria-expanded') !== 'true',
    'a CLOSED panel stays closed across a repaint');
  ok(dShut.getElementById('chat-project-info').hidden === true, '…and stays hidden');

  // OPEN survives.
  const dOpen = fakeDoc();
  const pOpen = makePatcher(dOpen, state);
  pOpen.api.patchProjectGroup(1);          // first paint, so the nodes exist
  dOpen.open();                            // the user presses the ⓘ
  ok(dOpen.getElementById('chat-project-info').hidden === false, 'control: it is open');
  pOpen.api.patchProjectGroup(1);          // a background project fetch lands
  ok(dOpen.getElementById('chat-project-info-btn').getAttribute('aria-expanded') === 'true',
    '★ an OPEN panel is still reported open after the group is repainted under it');
  ok(dOpen.getElementById('chat-project-info').hidden === false,
    '★ and is still shown — a fetch the user did not ask for cannot close what they opened');
  ok(pOpen.calls.closed === 2,
    'CONTROL: the repaint still closes any open LISTBOX menu each time — that trigger really has left the document');
}

// ════════════════════════════════════════════════════════════════════════
section('§13 — ONE SELECTOR PARADIGM: THE PICKER WEARS THE CHIP\'S FACE (v3.65.0)');
// ════════════════════════════════════════════════════════════════════════
// THE REPORT: "the domain chips and the project dropdown are two paradigms
// side by side." The chips stay the always-visible selector; the picker takes
// their FACE. Two things are asserted here and the SECOND is the load-bearing
// one — the face is copied into a class of its own and `.chat-scope-pill` is
// NOT reused, because that class carries a press transform and
// shared/listbox.css refuses a transform on a trigger for a measured reason
// (the open menu is held in place by a rAF loop watching the trigger's rect,
// and a transform is in that rect). scripts/test-next-press-motion.js pins the
// two families on opposite sides of that line, so one element carrying both
// classes would sit under `moves: true` and `moves: false` at once.
{
  const { html } = render();
  const chatCss = readFileSync(path.join(ROOT, 'src/public/next/views/chat.css'), 'utf8');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodyOf = (sel) => {
    const m = new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
      .exec(strip(chatCss));
    return m ? m[1] : '';
  };

  const cfg = render({ activeProject: 'curator' }).mounted[0];
  ok(/\bchat-project-pill\b/.test(String(cfg.triggerClass)),
    'the trigger asks for the chip face by class');
  ok(!/\bchat-scope-pill\b/.test(String(cfg.triggerClass)),
    '★ …and NOT `chat-scope-pill`: that class presses with a transform, which ' +
    'shared/listbox.css refuses on a trigger because the open menu is positioned from its rect');
  ok(!/\bchat-lb\b/.test(String(cfg.triggerClass)),
    'CONTROL: the composer\'s 220px-capped face is gone from this trigger — it is a pill now, not a field');
  ok(/\blb-sm\b/.test(String(cfg.triggerClass)),
    'it keeps the kit\'s small SIZE variant rather than inventing a third height');

  const face = bodyOf('.chat-project-lb-root .lb-btn.chat-project-pill');
  ok(face !== '', 'CONTROL: the face rule was found (an empty body makes every line below vacuous)');
  const chip = bodyOf('.chat-scope-pill');
  for (const [prop, why] of [
    ['border-radius', 'the pill radius'],
    ['height', 'the 28px box'],
    ['border', 'the hairline'],
  ]) {
    const a = (new RegExp(prop + ':\\s*([^;]+)').exec(face) || [])[1];
    const b = (new RegExp(prop + ':\\s*([^;]+)').exec(chip) || [])[1];
    ok(!!a && !!b && a.trim() === b.trim(),
      `${why} is the chips' own value, not a second one (${String(a).trim()} vs ${String(b).trim()})`);
  }
  ok(/background:\s*transparent/.test(face),
    '…on the chips\' transparent ground, not the kit\'s inset fill');
  ok(!/transform/.test(face) && !/transform/.test(bodyOf('.chat-project-lb-root .lb-btn.chat-project-pill:hover:not(:disabled)')),
    'and NOTHING here declares a transform — see the rAF argument above');

  /* THE GROUP KEEPS ITS EYEBROW AND ITS HAIRLINE. "One paradigm" is about the
     two controls looking alike, not about erasing the statement that they
     select different kinds of thing. */
  ok(/PROJECT/.test(html), 'the group still carries its PROJECT eyebrow');
  ok(/border-left:\s*1px solid/.test(bodyOf('.chat-project-group')),
    '…and its left hairline, which is what says these are two kinds of selection');
  ok(/min-width:\s*9\.5rem/.test(bodyOf('.chat-project-lb-root .lb-btn')),
    '…and the trigger keeps its min-width, so a long slug does not move what is beside it');
}

// ════════════════════════════════════════════════════════════════════════
section('§14 — THE VIOLET LEFT LINE IS GONE FROM THE CONVERSATION ROWS (R10)');
// ════════════════════════════════════════════════════════════════════════
// The maintainer, on the Settings sidebar: "if I select General I get a violet
// line on the left; we don't get this in Domains or Context — make it the same
// as Domains, we don't need this line, it is a completely other design which
// got in during development." `.settings-nav-row::before` and
// `.chat-conv-row::before` were ONE paradigm, so they go together; Settings'
// half lands in the same release (scripts/test-next-press-motion.js:603's
// EDGE_SELECTORS holds both names and is that package's file).
//
// WHAT IS ASSERTED: the rule is GONE, and what replaces it is the Domains
// sidebar's own pair — the overlay fill plus a title that changes weight AND
// ink. Both halves, because a fill alone at this alpha is a 1.3:1 step and the
// text is what carries the state at a legible contrast.
{
  const chatCss = readFileSync(path.join(ROOT, 'src/public/next/views/chat.css'), 'utf8');
  // `.dm-row.active` moved out of views/domains.css into shared/sidebar.css
  // as `.cur-sb-row.active` (P2, v3.65.0) — the row rule is the kit's now,
  // with `dm-row` riding only as an alias token on the element. The
  // reference for this comparison follows the rule to where it actually
  // lives, so a further change to it still moves this pin with it.
  const dmCss = readFileSync(path.join(ROOT, 'src/public/next/shared/sidebar.css'), 'utf8');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
  const bare = strip(chatCss);

  ok(!/\.chat-conv-row::before\s*\{/.test(bare),
    '★ there is no `.chat-conv-row::before` rule left');
  ok(!/\.chat-conv-row\.active::before/.test(bare),
    '★ …and none on the active row either');
  ok(!/\.chat-conv-row::before/.test(strip(chatCss).replace(/@media[^{]*\{/g, '')),
    '…including inside the reduced-motion block, whose entry went with it');
  ok(/chat-conv-row::before/.test(chatCss),
    'CONTROL: the removal is EXPLAINED in a comment — an unexplained deletion is how a rule comes back');

  /* THE REPLACEMENT IS THE DOMAINS PATTERN, READ FROM DOMAINS. Not a
     hand-copied expectation: the assertion compares the two files, so a change
     to the reference moves this pin with it. */
  const decl = (css, sel, prop) => {
    const m = new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
      .exec(strip(css));
    if (!m) return null;
    const d = new RegExp(prop + ':\\s*([^;]+)').exec(m[1]);
    return d ? d[1].trim() : null;
  };
  eq(decl(chatCss, '.chat-conv-row.active', 'background'),
     decl(dmCss, '.cur-sb-row.active', 'background'),
     'the active conversation row is filled with the SAME token the Domains sidebar\'s active row uses');
  eq(decl(chatCss, '.chat-conv-row.active .chat-conv-title', 'font-weight'),
     decl(dmCss, '.cur-sb-row.active .cur-sb-name', 'font-weight'),
     '…and its title takes the same weight step');
  ok(decl(chatCss, '.chat-conv-row.active .chat-conv-title', 'color') === 'var(--text)',
    '…and steps its INK too, so the state is not carried by a 1.3:1 fill alone');
  ok(decl(chatCss, '.chat-conv-title', 'color') !== 'var(--text)',
    'CONTROL: an inactive title really is quieter, so that step is a difference and not a no-op');
}

// ════════════════════════════════════════════════════════════════════════
section('§15 — THE PINNED PROJECT\'S KNOWLEDGE DOMAINS (v3.65.0, P10)');
// ════════════════════════════════════════════════════════════════════════
// The store gained `knowledgeDomains` / `knowledgeDomainsDefaulted` on
// `GET /api/memory/:domain/:project`. The design record asks Chat to
// "pre-select those domain chips when the project is pinned (retrieval across
// them, the existing multi-domain scope)".
//
// THERE IS NO MULTI-DOMAIN SCOPE IN CHAT, and §15d EXECUTES the two reasons
// rather than asserting them in prose. So this view DISCLOSES the set and
// MARKS those chips; it does not move the selection. Everything below pins
// that distinction from both sides — the mark is rendered, and the selection
// is not touched.
{
  const KN = (over) => Object.assign({
    project: 'curator', domains: ['articles'], defaulted: true, missing: [], error: false,
  }, over);

  // ── §15a — THE DEFAULT IS NOT A CHOICE, AND IS NOT MARKED ───────────────
  {
    const r = render({ activeProject: 'curator', projectKnowledge: KN({ domains: ['articles'], defaulted: true }) });
    ok(!/in-project/.test(r.html),
      '★ A DEFAULTED list marks NOTHING — it names the domain the chips are already on, and marking it ' +
      'would dress "nobody has chosen" up as a choice');
    const foot = r.mounted[0].footHtml;
    ok(/the default/.test(foot) && /nobody has chosen/.test(foot),
      '…and the footer says so in those words, because the store keeps the two facts apart on purpose');
    ok(!/aria-label=/.test(r.html.slice(r.html.indexOf('chat-scope-pills'), r.html.indexOf('chat-scope-count'))),
      'CONTROL: no chip gains an accessible name it does not need');
  }

  // ── §15b — A CHOSEN SET IS MARKED, AND THE SELECTION IS UNTOUCHED ───────
  {
    const r = render({
      domains: [
        { slug: 'articles', displayName: 'Articles', pageCount: 1406 },
        { slug: 'research', displayName: 'Research', pageCount: 30 },
        { slug: 'business', displayName: 'Business', pageCount: 50 },
      ],
      activeDomain: 'articles',
      activeProject: 'curator',
      projectKnowledge: KN({ domains: ['research', 'business'], defaulted: false }),
    });
    const pills = [...r.tree.children[0].children ? [] : []]; // (tree walked by class below)
    const marked = (r.html.match(/class="chat-scope-pill in-project"/g) || []).length;
    eq(marked, 2, 'both chosen domains are marked');
    ok(/data-scope-domain="research"[^>]*aria-label="Research — in this project/.test(r.html)
       || /aria-label="Research — in this project[^"]*"[^>]*data-scope-domain="research"/.test(r.html),
      '★ …and the mark is in the accessible NAME too, so colour is never the only carrier');
    ok(/aria-label="Research — in this/.test(r.html),
      '…with the visible label as its PREFIX, so "label in name" still holds');
    eq((r.html.match(/chat-scope-pill active/g) || []).length, 1,
      '★ THE SELECTION IS UNTOUCHED: exactly ONE chip is active');
    ok(/class="chat-scope-pill active" data-scope-domain="articles"/.test(r.html),
      '…and it is still the domain the user was on, NOT one the project named');
    // ── THE IDENTITY DOT (v3.65.1, decision 7) ───────────────────────────
    // THREE CHANNELS, THREE SHAPES, and this one is the domain's IDENTITY:
    // `.active`'s fill is SELECTION, `.in-project`'s dashed edge is
    // MEMBERSHIP, the dot is WHICH DOMAIN. It was `.chat-type-dot` with an
    // inline `style="background:var(--accent)"` — the same violet on every
    // chip, a mark that answered no question. The slot is recomputed from the
    // kit's own mapping against the domain's position in `state.domains`, the
    // install's order, so a chip coloured from anything else fails.
    {
      const chipDots = [...r.html.matchAll(
        /<button class="chat-scope-pill[^"]*" data-scope-domain="([a-z-]+)"[^>]*>\s*<span class="([^"]*)">/g)];
      eq(chipDots.length, 3, 'CONTROL — all three chips were found with a leading mark');
      ['articles', 'research', 'business'].forEach((slug, i) => {
        const hit = chipDots.find((m) => m[1] === slug);
        ok(!!hit, `the "${slug}" chip is present`);
        if (!hit) return;
        const tokens = hit[2].split(/\s+/);
        ok(tokens.includes('cur-sb-dot') && tokens.includes(identityDotClass(i)),
          `…and its dot is the kit's glyph on slot ${identityDotClass(i).slice(-1)} — `
          + "the same colour as that domain's row on the Domains rail", hit[2]);
      });
      ok(!/style="background/.test(r.html),
        '★ NO chip carries an inline colour — every chip was violet before v3.65.1');
      const slots = chipDots.map((m) => (/cur-sb-dot-(\d)/.exec(m[2]) || [])[1]);
      eq(new Set(slots.filter(Boolean)).size, 3,
        'CONTROL — the three chips take three different slots');
    }

    const foot = r.mounted[0].footHtml;
    ok(/2 domains/.test(foot), 'the footer names how many domains the project reads');
    ok(/research/.test(foot) && /business/.test(foot), '…and names them');
    ok(/chosen for this project/.test(foot), '…and says the owner chose them');
    // v3.71.1: this line now carries the sentence the ⓘ used to append.
    ok(/its knowledge lives in another domain \u2014 this chat reads only articles/.test(foot),
      '★ …and states what THIS conversation is actually reading, which is the fact the mark could be misread as');
    /* TWO READOUTS, NOT ONE LINE. The turn's reading and the project's domains
       are different facts; this file exists because two unrelated facts went
       adjacent once and a user misread one as the other. */
    ok(/tx-readout-group/.test(foot), 'the footer is a readout GROUP, so the two facts keep their own labels');
    eq((foot.match(/class="tx-readout"/g) || []).length, 2, '…and there are exactly two of them');
  }

  // ── §15b2 — THE MARK IS NOT A SELECTION, IN CSS TOO ───────────────
  // Mutation F14 is why this exists: turning the mark into `--accent-tint` +
  // `--accent-text` — i.e. making a named chip look exactly like the selected
  // one — left every markup assertion above green, because the markup was
  // still right. The claim "a marked chip does not read as selected" is about
  // the RULE, so it is asserted on the rule.
  {
    const chatCss = readFileSync(path.join(ROOT, 'src/public/next/views/chat.css'), 'utf8');
    const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
    const bodyOf = (sel) => {
      const m = new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
        .exec(strip(chatCss));
      return m ? m[1] : '';
    };
    const mark = bodyOf('.chat-scope-pill.in-project');
    ok(mark !== '', 'CONTROL: the mark rule was found (an empty body makes the lines below vacuous)');
    ok(!/background/.test(mark),
      '★ the mark declares NO background — the ground belongs to `.active`, which is the one chip whose wiki is read');
    ok(!/(^|[^-])color\s*:/.test(mark),
      '★ …and no text colour either, for the same reason');
    const active = bodyOf('.chat-scope-pill.active');
    ok(/background/.test(active),
      'CONTROL: `.active` really does own a ground, so the two states are told apart by more than a border');
    ok(/border-style:\s*dashed/.test(mark),
      'the mark is a DASHED edge — "belongs to a set", not "selected"');
    ok(!/border-style:\s*dashed/.test(active),
      'CONTROL: and the selected chip is not dashed, so the two never look alike');
    /* ── THE MARK MUST NOT BE THE PLAIN CHIP'S OWN COLOUR ─────────────────
       FOUND IN THE BROWSER, not by this suite: the first cut used
       `--accent-border`, which composited to 1.65:1 against the bar where the
       plain chip's edge is 1.27:1 — a mark you cannot find, and in the
       SELECTED chip's own hue. A mark that measures like no mark is the
       failure mode here, so the token is pinned by name and separated from
       both neighbours. */
    const plainDecl = /border:\s*1px\s+solid\s+var\(([^)]+)\)/.exec(bodyOf('.chat-scope-pill'));
    ok(!!plainDecl, 'CONTROL: the plain chip declares its own border token');
    const markColor = (/border-color:\s*var\(([^)]+)\)/.exec(mark) || [])[1];
    ok(!!markColor && markColor.trim() !== plainDecl[1].trim(),
      `★ the mark's colour is NOT the plain chip's (${markColor} vs ${plainDecl[1]})`);
    const activeColor = (/border-color:\s*var\(([^)]+)\)/.exec(active) || [])[1];
    ok(!!activeColor && markColor.trim() !== activeColor.trim(),
      `★ …and NOT the selected chip's either (${markColor} vs ${activeColor}) — "marked" and "selected" ` +
      'are different states and must not share an edge colour');
    ok(/border-color:\s*var\(--accent\)\s*;?\s*$|border-color:\s*var\(--accent\)\s*;/.test(mark.trim() + ';'),
      '…and it is the full-strength accent, which measured 4.41:1 against the bar (the 3:1 floor for a mark)');
  }

  // ── §15c — A DOMAIN THAT IS NOT ON THIS COMPUTER ────────────────────────
  {
    const r = render({
      domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 1406 },
                { slug: 'research', displayName: 'Research', pageCount: 30 }],
      activeDomain: 'articles',
      activeProject: 'curator',
      projectKnowledge: KN({ domains: ['research', 'gone'], defaulted: false, missing: ['gone'] }),
    });
    eq((r.html.match(/in-project/g) || []).length, 1,
      'a domain with no chip marks nothing — it is skipped, not invented');
    const foot = r.mounted[0].footHtml;
    ok(/gone is not on this computer/.test(foot), '★ …and the footer says the project named a domain that is gone');
    // v3.71.1: the ⓘ no longer repeats it — an explainer carries no STATE,
    // so the footer is the one place this is said (§15c2 pins the panel).
    ok(!/not on this computer/.test(projectInfoPanelOf(r.html)),
      '★ …and the ⓘ does NOT repeat it — the explainer is static; the footer says it');
  }

  // ── §15c2 — THE ⓘ IS THE SAME EXPLAINER IN EVERY STATE (v3.71.1) ───────
  // Until v3.71.0 the panel appended up to two conditional notes, under a
  // 60-word standing budget + 15 per note. v3.71.1 made it the shared
  // explainer, which may carry no state: both notes moved to the footer. So
  // the word budgets are the explainer's (test-explainers owns them) and the
  // pin here is that NO project state reaches the panel.
  const BASE_PANEL = projectInfoPanelOf(render().html);
  ok(BASE_PANEL.includes(explainerHtml('chat.project')),
    'CONTROL: the base panel is found and carries the chat.project explainer');
  for (const [label, over] of [
    ['knowledge elsewhere', { activeProject: 'curator', projectKnowledge: KN({ domains: ['research'], defaulted: false }) }],
    ['a missing domain', { activeProject: 'curator', projectKnowledge: KN({ domains: ['research', 'gone'], defaulted: false, missing: ['gone'] }) }],
    ['both at once', { activeProject: 'curator', projectKnowledge: KN({ domains: ['gone'], defaulted: false, missing: ['gone'] }) }],
  ]) {
    const r = render(over);
    eq(projectInfoPanelOf(r.html), BASE_PANEL,
      `ⓘ variant "${label}": the panel is byte-identical to the base — state lives in the footer`);
    ok(!/press a chip|switch to/i.test(projectInfoPanelOf(r.html) + r.mounted[0].footHtml),
      `ⓘ variant "${label}" never tells the user to press a chip — that would undo the pin (§15d)`);
  }

  // ── §15c3 — A FAILED READ SAYS SO, AND INVENTS NOTHING ──────────────────
  {
    const r = render({ activeProject: 'curator',
      projectKnowledge: { project: 'curator', domains: [], defaulted: false, missing: [], error: true } });
    const foot = r.mounted[0].footHtml;
    ok(/could not be read/.test(foot), 'a failed read is stated');
    ok(!/in-project/.test(r.html), '…and nothing is marked on a list nobody has');
    const r2 = render({ activeProject: 'curator', projectKnowledge: null });
    ok(!/Knowledge|domains/.test(r2.mounted[0].footHtml),
      'NOT ASKED YET renders no knowledge row at all — "not told" is not "none"');

    /* ── `error` IS CHECKED FIRST, and this probe is what makes that testable ─
       Mutation A5 (the loader's error record reporting `defaulted: true`)
       stayed GREEN, and correctly so: on a failed read `defaulted` cannot
       reach any surface, because every consumer tests `error` before it. That
       makes the FIELD inert — and an inert field is not worth pinning. What IS
       worth pinning is the ORDER that makes it inert, and the ordinary error
       record cannot show it: its `domains` is empty, so `projectKnowledgeSet`
       would return null from the empty-list check even with the error test
       deleted, and the section would pass while the guard was gone.
       So the probe is a record the loader never builds: a failed read that
       still carries a full, plausible list. If `error` stopped winning, this
       would mark two chips and announce a choice nobody made. */
    const hostile = { project: 'curator', domains: ['research', 'business'],
      defaulted: false, missing: [], error: true };
    const h = render({
      domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 1406 },
                { slug: 'research', displayName: 'Research', pageCount: 30 },
                { slug: 'business', displayName: 'Business', pageCount: 50 }],
      activeDomain: 'articles', activeProject: 'curator', projectKnowledge: hostile,
    });
    ok(!/in-project/.test(h.html),
      '★ an ERRORED record marks nothing even when it carries a full list — `error` is tested first');
    ok(/could not be read/.test(h.mounted[0].footHtml),
      '★ …and the footer states the failure rather than the list it happens to be holding');
    ok(!/chosen for this project/.test(h.mounted[0].footHtml),
      '★ …and never announces a choice nobody could confirm');
    ok(!/knowledge lives in another domain/.test(projectInfoPanelOf(h.html) + h.mounted[0].footHtml),
      '★ …and neither the ⓘ nor the footer adds a note about a list it does not trust');
  }

  // ── §15c4 — A RECORD FOR A DIFFERENT PROJECT IS NEVER SHOWN ─────────────
  {
    /* THE DOMAIN LIST MUST CONTAIN THE RECORD'S DOMAIN, or this section is
       vacuous — mutation F2 proved it. With only `articles` installed there is
       no `research` chip to mark, so deleting the project-identity guard left
       the assertion green: it was measuring the absence of a chip, not the
       presence of a guard. `research` is installed here, so a chip EXISTS and
       only the guard keeps it unmarked. */
    const domains = [
      { slug: 'articles', displayName: 'Articles', pageCount: 1406 },
      { slug: 'research', displayName: 'Research', pageCount: 30 },
    ];
    const control = render({ domains, activeProject: 'curator',
      projectKnowledge: KN({ project: 'curator', domains: ['research'], defaulted: false }) });
    ok(/in-project/.test(control.html),
      'CONTROL: with the SAME project named, the research chip IS marked — so a chip really is available to mark');
    ok(/research/.test(control.mounted[0].footHtml), 'CONTROL: …and the footer really does name it');

    const r = render({ domains, activeProject: 'lumina',
      projectKnowledge: KN({ project: 'curator', domains: ['research'], defaulted: false }) });
    ok(!/in-project/.test(r.html),
      '★ a record carrying ANOTHER project\'s name marks nothing — the stale-reading-beside-a-fresh-pill refusal');
    ok(!/research/.test(r.mounted[0].footHtml),
      '★ …and the FOOTER says nothing about it either (a separate guard, in projectKnowledgeReadout)');
  }
}

// ════════════════════════════════════════════════════════════════════════
section('§15d — WHY THE CHIPS ARE NOT MOVED: the two blockers, EXECUTED');
// ════════════════════════════════════════════════════════════════════════
// The design record's parenthetical ("retrieval across them, the existing
// multi-domain scope") describes a capability this app does not have. Rather
// than record that as an opinion, both halves are driven here. If either ever
// becomes false — a pin that survives a domain switch, or a route that
// resolves a project across domains — these assertions red and the pre-select
// becomes buildable. That is the point of writing them this way.
{
  /* ── BLOCKER 1: switchDomain CLEARS THE PIN. The REAL function. ───────── */
  const state = {
    activeDomain: 'projects', activeProject: 'curator', activeProjectScope: 'latest',
    activeConversationId: 'c1', thread: [{ role: 'user', content: 'q' }],
    searchQuery: 'x', selectedConvIds: new Set(['c1']), bulkNotice: {}, cancelNotice: {},
    projectRows: [{ project: 'curator', ageSeconds: 60 }], projectsFor: 'projects',
    projectsState: 'ready', projectLastUsed: { chars: 4694 }, projectKnowledge: null,
    domains: [], booted: true, loadError: null,
  };
  const calls = { loadProjects: [], loadConvs: [] };
  const api = new Function(
    'state', 'localStorage', 'LS_DOMAIN', 'myMountToken', 'cancelSearchTimer',
    'loadDomainConversations', 'loadProjectsForDomain', 'renderShell', 'reportAsyncActionFailure',
    extractFunction(chatSrc, 'switchDomain') + '\nreturn { switchDomain };',
  )(
    state, { setItem() {} }, 'k', 1, () => {},
    async (...a) => { calls.loadConvs.push(a); },
    async (...a) => { calls.loadProjects.push(a); },
    () => {}, () => {},
  );

  ok(state.activeProject === 'curator', 'control: a project is pinned before the switch');
  api.switchDomain('research');     // the move a chip pre-select would make
  ok(state.activeDomain === 'research', 'control: the domain really did move');
  ok(state.activeProject === null,
    '★ BLOCKER 1: switchDomain CLEARS the pin — moving the chips to a project\'s knowledge domain ' +
    'un-pins the project that asked for the move');
  ok(state.activeProjectScope === null && state.projectLastUsed === null,
    '…along with its work-stream and its last measured reading');
  eq(calls.loadProjects.length, 1,
    '…and the NEW domain\'s project list is fetched, which is what would then reconcile the pin away');
  eq(calls.loadProjects[0][0], 'research',
    '…for the domain just switched to, where a project living in another domain does not appear');

  /* ── BLOCKER 2: the ROUTE resolves the project against the URL's domain ─
     A SOURCE assertion, and labelled as one: driving Express is this file's
     neighbour's job (test-chat-project-context.js owns the route). What is
     pinned here is the coupling itself, anchored on the refusal a user would
     meet. If the route ever resolves across domains this goes red and the
     comment above it stops being true, which is exactly when someone should
     re-read it. */
  const routeSrc = readFileSync(path.join(ROOT, 'src/routes/chat.js'), 'utf8');
  ok(/listProjects\(domain, \{ namesOnly: true \}\)/.test(routeSrc),
    '★ BLOCKER 2: the route checks the project against the URL\'s OWN domain');
  ok(/reason: 'project_not_found'/.test(routeSrc) && /has no project called/.test(routeSrc),
    '…and refuses with 400 project_not_found BEFORE the stream opens');
  ok(/router\.post\('\/:domain'/.test(routeSrc),
    'CONTROL: there is exactly one domain in the chat URL — no multi-domain send exists to widen to');
  const brainSrc = readFileSync(path.join(ROOT, 'src/brain/chat.js'), 'utf8');
  ok(/export async function sendMessage\(domain, conversationId/.test(brainSrc),
    'CONTROL: and sendMessage takes ONE domain, so retrieval could not span two even if the bar offered it');
}

// ════════════════════════════════════════════════════════════════════════
section('§15e — THE READ: once per project per mount, and never for "No project"');
// ════════════════════════════════════════════════════════════════════════
{
  const mkState = () => ({
    activeDomain: 'projects', activeProject: 'curator', projectKnowledge: null,
    domains: [{ slug: 'projects' }, { slug: 'research' }],
  });
  const make = (state, payloads) => {
    const fetches = [];
    const patched = { group: 0, marks: 0 };
    const api = new Function(
      'state', 'fetch', 'isCurrentMount', 'patchProjectGroup', 'patchScopePillMarks',
      'projectKnowledgeCache', 'MAX_PROJECT_KNOWLEDGE_CACHE',
      extractFunction(chatSrc, 'ensureProjectKnowledge') + '\nreturn { ensureProjectKnowledge };',
    )(
      state,
      async (url) => { fetches.push(url); const p = payloads.shift();
        if (p === 'boom') throw new Error('network');
        return { ok: p.status !== 400, json: async () => p }; },
      () => true,
      () => { patched.group++; }, () => { patched.marks++; },
      new Map(), 24,
    );
    return { api, fetches, patched };
  };

  {
    const st = mkState();
    const h = make(st, [
      { ok: true, knowledgeDomains: ['research', 'business'], knowledgeDomainsDefaulted: false },
    ]);
    await h.api.ensureProjectKnowledge('projects', 'curator', 1);
    eq(h.fetches.length, 1, 'ONE request for a newly pinned project');
    eq(h.fetches[0], '/api/memory/projects/curator', '…to the project\'s own detail route');
    ok(st.projectKnowledge && st.projectKnowledge.domains.join() === 'research,business',
      '…and the list lands on the state');
    eq(st.projectKnowledge.missing.join(), 'business',
      '★ a named domain this install does not have is computed HERE, with no second request');
    /* THE FLAG IS READ FROM THE SERVER, NOT ASSUMED. The orchestrator's audit
       found `defaulted: data.knowledgeDomainsDefaulted === true` could be
       replaced by `defaulted: true` with this file still green: every section
       that renders a record BUILT one by hand, and this section drove the
       loader without ever reading the field. Two halves each covered, the
       SEAM between them not. §15g drives the whole chain; this is the
       cheap half, naming the field at the point it is derived. */
    eq(st.projectKnowledge.defaulted, false,
      '★ `knowledgeDomainsDefaulted: false` from the server lands as `defaulted: false`');
    ok(h.patched.group === 1 && h.patched.marks === 1,
      '…and both targeted patches run — the group for the footer, the chips for the marks');
    await h.api.ensureProjectKnowledge('projects', 'curator', 1);
    eq(h.fetches.length, 1, '★ the SECOND read of the same project on the same mount is a cache HIT');
    await h.api.ensureProjectKnowledge('projects', 'curator', 2);
    eq(h.fetches.length, 2,
      '★ …but a NEW MOUNT misses, so knowledge edited in Context is fresh when the user comes back');
  }
  {
    // THE OTHER VALUE of the same field, through the same path — so the
    // assertion above is a measurement and not a coincidence.
    const st = mkState();
    const h = make(st, [{ ok: true, knowledgeDomains: ['projects'], knowledgeDomainsDefaulted: true }]);
    await h.api.ensureProjectKnowledge('projects', 'curator', 1);
    eq(st.projectKnowledge.defaulted, true,
      '★ …and `true` lands as `true`, so the two answers are told apart rather than collapsed');
  }
  {
    const st = mkState();
    const h = make(st, []);
    await h.api.ensureProjectKnowledge('projects', null, 1);
    eq(h.fetches.length, 0, '"No project" makes NO request — there is nothing it could answer');
    eq(st.projectKnowledge, null, '…and clears any record left by the previous pin');
  }
  {
    const st = mkState();
    const h = make(st, ['boom']);
    await h.api.ensureProjectKnowledge('projects', 'curator', 1);
    ok(st.projectKnowledge && st.projectKnowledge.error === true,
      'A FAILED READ records the failure rather than an empty list');
    ok(st.projectKnowledge.domains.length === 0, '…and invents no domains');
  }
  {
    // AN OLDER SERVER, or any answer without the field: "not told" must not
    // become "none". This is the store's own recorded defect class, from the
    // other end — a consumer inventing a value for a field it was not sent.
    const st = mkState();
    const h = make(st, [{ ok: true }]);
    await h.api.ensureProjectKnowledge('projects', 'curator', 1);
    eq(st.projectKnowledge, null,
      '★ an answer with NO knowledgeDomains leaves the record null — not an empty list');
  }
  {
    // The pin moved while the request was in flight.
    const st = mkState();
    const h = make(st, [{ ok: true, knowledgeDomains: ['research'], knowledgeDomainsDefaulted: false }]);
    const p = h.api.ensureProjectKnowledge('projects', 'curator', 1);
    st.activeProject = 'lumina';
    await p;
    eq(st.projectKnowledge, null,
      '★ an answer that arrives after the pin changed is DISCARDED — never attached to the project it is not about');
  }
}

// ════════════════════════════════════════════════════════════════════════
section('§15f — THE MARK PATCH TOUCHES MARKS AND NOTHING ELSE');
// ════════════════════════════════════════════════════════════════════════
// The chips live in `.chat-scope-group`, which `patchProjectGroup` does not
// repaint — and a `renderMain()` to move a class would destroy the thread, the
// draft and the scroll position. Driven against a document that models exactly
// what the patch touches.
{
  const mkBtn = (slug, active) => {
    const classes = new Set(['chat-scope-pill']);
    if (active) classes.add('active');
    const attrs = {};
    return {
      dataset: { scopeDomain: slug },
      classList: {
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
        has: (c) => classes.has(c),
      },
      setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: (k) => { delete attrs[k]; },
      _classes: classes, _attrs: attrs,
    };
  };
  const btns = [mkBtn('articles', true), mkBtn('research', false), mkBtn('business', false)];
  const state = {
    activeDomain: 'articles', activeProject: 'curator',
    domains: [{ slug: 'articles', displayName: 'Articles' }, { slug: 'research', displayName: 'Research' },
              { slug: 'business', displayName: 'Business' }],
    projectKnowledge: { project: 'curator', domains: ['research', 'business'], defaulted: false, missing: [], error: false },
  };
  const api = new Function(
    'document', 'state',
    extractFunction(chatSrc, 'projectKnowledgeSet') + '\n' +
    extractFunction(chatSrc, 'scopePillLabelFor') + '\n' +
    extractFunction(chatSrc, 'scopePillAriaFor') + '\n' +
    extractFunction(chatSrc, 'patchScopePillMarks') + '\nreturn { patchScopePillMarks };',
  )({ querySelectorAll: () => btns }, state);

  api.patchScopePillMarks();
  ok(btns[1]._classes.has('in-project') && btns[2]._classes.has('in-project'), 'the two named chips are marked');
  ok(!btns[0]._classes.has('in-project'), '…and the one the project did not name is not');
  ok(btns[0]._classes.has('active') && !btns[1]._classes.has('active') && !btns[2]._classes.has('active'),
    '★ THE SELECTION IS UNTOUCHED by the patch — `active` is exactly where it was');
  eq(btns[1]._attrs['aria-label'], 'Research — in this project\'s knowledge',
    '…and the marked chip gains the accessible name');
  ok(btns[0]._attrs['aria-label'] === undefined, '…while an unmarked chip gains none');

  // UN-PIN: the marks must come off, including the accessible names.
  state.activeProject = null;
  state.projectKnowledge = null;
  api.patchScopePillMarks();
  ok(!btns[1]._classes.has('in-project') && !btns[2]._classes.has('in-project'),
    '★ un-pinning removes every mark');
  ok(btns[1]._attrs['aria-label'] === undefined,
    '★ …and the accessible name with it — a stale name is a lie a screen reader cannot see past');
  ok(btns[0]._classes.has('active'), 'CONTROL: and the selection is STILL untouched');
}

// ════════════════════════════════════════════════════════════════════════
section('§15g — THE SEAM: one server answer, the real loader, the real renderer');
// ════════════════════════════════════════════════════════════════════════
// ── WHAT A GREEN MUTATION TAUGHT ────────────────────────────────────────
// The orchestrator's audit replaced `defaulted: data.knowledgeDomainsDefaulted
// === true` with `defaulted: true` — i.e. made EVERY project's knowledge read
// as "nobody has chosen", which erases the store's own second field and un-
// marks every chip — and this file stayed at 292 passed / 0 failed.
//
// THE CAUSE WAS NOT A MISSING ASSERTION; IT WAS A MISSING JOIN. §15a-c drive
// the REAL renderer but with a record BUILT BY HAND (`KN({...})`), and §15e
// drives the REAL loader but never read `defaulted` off what it produced. Each
// half was covered. The seam between them — the server's field becoming the
// record's field becoming the mark on a chip — was not, so a lie told at the
// seam was invisible from both sides.
//
// So this section owns the seam, and the arms differ in EXACTLY ONE BIT: the
// same envelope, the same two domains, the same install, `knowledgeDomains-
// Defaulted` true in one and false in the other. Anything that stops the flag
// deciding the outcome — ignoring it, inverting it, deriving the mark from the
// list's length instead — has to show up here.
{
  /** Run the REAL loader against one intercepted answer; return its record. */
  async function loadRecord(envelope, domains) {
    const st = {
      activeDomain: 'projects', activeProject: 'curator', projectKnowledge: null,
      domains,
    };
    const api = new Function(
      'state', 'fetch', 'isCurrentMount', 'patchProjectGroup', 'patchScopePillMarks',
      'projectKnowledgeCache', 'MAX_PROJECT_KNOWLEDGE_CACHE',
      extractFunction(chatSrc, 'ensureProjectKnowledge') + '\nreturn { ensureProjectKnowledge };',
    )(
      st,
      async () => ({ ok: true, json: async () => envelope }),
      () => true, () => {}, () => {}, new Map(), 24,
    );
    await api.ensureProjectKnowledge('projects', 'curator', 1);
    return st.projectKnowledge;
  }

  const DOMAINS = [
    { slug: 'projects', displayName: 'Projects', pageCount: 30 },
    { slug: 'research', displayName: 'Research', pageCount: 30 },
    { slug: 'business', displayName: 'Business', pageCount: 50 },
  ];
  // ONE envelope, ONE bit apart.
  const CHOSEN = { ok: true, knowledgeDomains: ['research', 'business'], knowledgeDomainsDefaulted: false };
  const DEFAULTED = { ok: true, knowledgeDomains: ['research', 'business'], knowledgeDomainsDefaulted: true };

  const chosenRec = await loadRecord(CHOSEN, DOMAINS);
  const defaultRec = await loadRecord(DEFAULTED, DOMAINS);

  ok(!!chosenRec && !!defaultRec, 'control: the real loader produced a record for both answers');
  eq(chosenRec.domains.join(), defaultRec.domains.join(),
    'control: the two records carry the SAME domains — so nothing below can be explained by the list');
  ok(chosenRec.defaulted === false && defaultRec.defaulted === true,
    '★ …and differ in exactly the one bit the server sent');

  const base = { domains: DOMAINS, activeDomain: 'projects', activeProject: 'curator' };
  // THE RENDERER IS GIVEN THE LOADER'S OWN OUTPUT, not a hand-built stand-in.
  const chosen = render(Object.assign({}, base, { projectKnowledge: chosenRec }));
  const defaulted = render(Object.assign({}, base, { projectKnowledge: defaultRec }));

  eq((chosen.html.match(/chat-scope-pill in-project/g) || []).length, 2,
    '★ CHOSEN, end to end: the server said false, and TWO chips are marked');
  ok(/data-scope-domain="research"/.test(chosen.html) && /data-scope-domain="business"/.test(chosen.html),
    '…the two the envelope named');
  eq((defaulted.html.match(/in-project/g) || []).length, 0,
    '★ DEFAULTED, end to end: the SAME two domains, the flag flipped, and NOTHING is marked');

  const chosenFoot = chosen.mounted[0].footHtml;
  const defaultFoot = defaulted.mounted[0].footHtml;
  ok(/chosen for this project/.test(chosenFoot),
    '★ …and the footer says the owner chose them');
  ok(/the default/.test(defaultFoot) && /nobody has chosen/.test(defaultFoot),
    '★ …while the other says nobody did');
  ok(!/nobody has chosen/.test(chosenFoot) && !/chosen for this project/.test(defaultFoot),
    'CONTROL: neither footer prints the other\'s sentence, so the two are told apart rather than both printed');
  ok(chosenFoot !== defaultFoot,
    'CONTROL: one bit really does change what a user is served');

  /* AND THE ⓘ. Until v3.71.0 its conditional note keyed off this flag and
     was pinned silent on the DEFAULTED arm. v3.71.1 made the panel the
     static explainer, so it cannot differ between the arms; the "knowledge
     lives in another domain" sentence moved to the footer (§15). NOTE: the
     footer's version is gated on the domain list only, NOT on `defaulted` —
     it is not pinned either way on the defaulted arm here; see the v3.71.1
     wiring report. */
  eq(projectInfoPanelOf(chosen.html), projectInfoPanelOf(defaulted.html),
    'the ⓘ is the same static explainer on both arms — it carries no state');
  ok(/knowledge lives in another domain/.test(chosenFoot),
    'the FOOTER names the situation on the CHOSEN arm');
}

section('§20 — P4 (v3.66.0): documents read vs the 40,000-character project budget');
// The footer's documents reading, EXECUTED through the real footer builder,
// the real readout kit and the real depth bar. What a user is served is the
// cfg's footHtml string (§11a's reason), so that is what every line reads.
{
  const foot = (used) => render({ activeProject: 'curator', projectLastUsed: used }).mounted[0].footHtml;
  // The ONE readout labelled "Documents", cut out of the footer string.
  const docReadout = (html) => {
    const m = html.match(/<div class="tx-readout"><span class="tx-readout-label">Documents<\/span>[\s\S]*?<\/div>/);
    return m ? m[0] : null;
  };
  const width = (html) => { const m = /cur-depth-bar[^"]*" style="width:([\d.]+)%"/.exec(html || ''); return m ? Number(m[1]) : null; };

  // ── THE NUMERATOR IS documentChars, NOT chars ────────────────────────
  // 31,234 characters of WHOLE block, 18,400 of them documents: a bar built
  // from `chars` would read 78.1%; the honest one reads 46%.
  const html = foot({ chars: 31234, documentChars: 18400, budgetChars: 40000, notes: [] });
  const d = docReadout(html);
  ok(!!d, 'AFTER A TURN with documentChars: the footer carries a "Documents" readout');
  eq(width(d), 46, '★ the bar is documentChars ÷ budgetChars (18,400 ÷ 40,000 = 46%), never chars ÷ budgetChars (78.1%)');
  ok(/class="cur-depth-value">18\.4k</.test(d), '…the figure on the bar is 18.4k');
  ok(/of 40k characters/.test(d), '…and the denominator is NAMED in words beside it — "of 40k characters"');
  ok(/visually-hidden"> 18,400 of 40,000 characters of documents</.test(d),
    '…and a screen reader hears the whole sentence, exact figures');
  ok(/whole block 31\.2k characters read last turn/.test(html),
    '★ the WHOLE-block figure stays, separate and labelled as the whole block, in characters');
  ok(!/whole block/.test(d), 'CONTROL: …and it is not inside the Documents readout (two facts, two readouts)');
  ok(!/cur-depth/.test(html.replace(d, '')), '…and the whole-block figure carries NO bar — it has no denominator');

  // ── NEVER DANGER ─────────────────────────────────────────────────────
  const full = docReadout(foot({ chars: 60000, documentChars: 40000, budgetChars: 40000, notes: [] }));
  eq(width(full), 100, 'a budget-filling read draws a full bar');
  ok(!/cur-depth-danger/.test(full), '★ …and is NOT danger: the server enforces the budget by omission, so full is not over');

  // ── ABSENT IS NOT ZERO ───────────────────────────────────────────────
  /* THE REAL OLDER SERVER: v3.65.x sends `budgetChars` but no
     `documentChars`. A fixture without budgetChars could not tell "absent"
     from "no denominator" — mutation M2' (absent read as a measured 0) stayed
     green against it, which is why this one carries the budget. */
  const old = foot({ chars: 12288, budgetChars: 40000, documents: 2, notes: [] });
  eq(docReadout(old), null, '★ a reading WITHOUT documentChars (a v3.65.x server, budgetChars present) renders NO Documents readout — never a "0"');
  ok(!/cur-depth/.test(old), '…and no bar anywhere');
  eq(docReadout(foot({ chars: 900, documentChars: 5000 })), null,
    '…nor without budgetChars: no denominator, no bar and no half-reading');
  const zero = docReadout(foot({ chars: 900, documentChars: 0, budgetChars: 40000, notes: [] }));
  ok(!!zero && /class="cur-depth-value">0</.test(zero), 'a MEASURED zero (read, held no documents) renders "0"');
  eq(width(zero), 0, '…with a zero-length bar');
  eq(docReadout(foot(null) || ''), null, 'no turn yet: no Documents readout');

  // ── WHAT WAS LEFT OUT, IN WORDS ──────────────────────────────────────
  const one = docReadout(foot({ chars: 45000, documentChars: 39000, budgetChars: 40000,
    notes: ['1 canonical document(s) did not fit the reading budget and were omitted: decisions.'] }));
  ok(/tx-readout-prov">1 document left out</.test(one), '★ one omitted document is said in words: "1 document left out"');
  const two = docReadout(foot({ chars: 45000, documentChars: 39000, budgetChars: 40000,
    notes: ['2 canonical document(s) did not fit the reading budget and were omitted: a, b.',
            'A canonical document was cut at the reading budget.'] }));
  ok(/2 documents left out · 1 document cut short/.test(two), '…plurals, and a cut document, each in words');
  const unrelated = docReadout(foot({ chars: 45000, documentChars: 39000, budgetChars: 40000,
    notes: ['The handoff was cut at the store\'s size cap.', '3 canonical document(s) are STALE against the repository'] }));
  ok(!!unrelated && !/tx-readout-prov/.test(unrelated),
    'CONTROL: notes about OTHER things (a trimmed handoff, stale mirrors) put nothing on the documents readout');
}
{
  // THE FORMATTER, EXECUTED: thousands of CHARACTERS, one decimal, no ".0".
  const f = new Function(extractFunction(chatSrc, 'formatCharsShort') + '\nreturn formatCharsShort;')();
  for (const [n, want] of [[0, '0'], [999, '999'], [1000, '1k'], [12288, '12.3k'], [18400, '18.4k'], [40000, '40k'], [31234, '31.2k']]) {
    eq(f(n), want, `formatCharsShort(${n})`);
  }
  eq(f(NaN), null, 'no number, no figure');
  eq(f(-1), null, 'a negative count is not a figure');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat scope-bar assertions green');
