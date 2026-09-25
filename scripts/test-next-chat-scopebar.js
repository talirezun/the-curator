/**
 * test-next-chat-scopebar.js — OFFLINE suite for Chat's SCOPE: where a
 * conversation's domain, project and Compile live (src/public/next/views/chat.js).
 *
 * ── v3.72.0 (P3): THE SCOPE BAR IS GONE, AND THIS SUITE FOLLOWED IT ─────
 * Through v3.71 this file pinned a sticky, wrapping scope bar: domain chips,
 * a page count, a PROJECT eyebrow + picker + ⓘ, and Compile with a caption.
 * The maintainer's verdict on it (2026-09-25): domains and projects "forced
 * together", and an ⓘ that "pushes/collapses the whole top section". His
 * decision M2 moved the scope:
 *   · a real VIEW HEADER (the one heading rule every other view follows):
 *     eyebrow, the conversation's title, the page ⓘ, Compile in the action
 *     slot, and ONE meta line of live facts;
 *   · the per-question controls on the COMPOSER: the domain (fixed once a
 *     conversation exists), the project, then Length and Model;
 *   · "the ⓘ never pushes the thread".
 * The original defect this suite was written for — a page count read as the
 * Compile button's caption — is still guarded (§2), structurally, against the
 * new markup.
 *
 * No network, no API key, no server, no browser, no LLM call. The REAL
 * `renderMain` is extracted by brace-matching and EXECUTED, with the REAL
 * shared/text.js header; the composer's picker cfgs are built by the REAL
 * builders; the live ages are advanced by the REAL shared/age-ticker.js.
 *
 *   §0  Harness self-check.
 *   §1  The header: eyebrow, title, the page ⓘ, Compile, the meta line.
 *   §2  THE DOM PATH: the page count can never be read as Compile's caption.
 *   §3  Compile's caption states the real counts (and is its description).
 *   §3b …and the header's facts TICK with the thread, without a repaint.
 *   §4  The caption does NOT restate the cost gate.
 *   §5  F1 — a compile's fresh page count reaches every place it is printed.
 *   §6  M2 — the ⓘ never pushes the thread.
 *   §7  The composer's DOMAIN pill: fixed once the conversation exists.
 *   §8  The PROJECT control's three states, and its dropped handle.
 *   §9  F3 — every project age is LIVE.
 *   §10 F3 — the projects are re-read after an answer, quietly.
 *   §11 The pinned project's footer, and its republish guard.
 *   §12 The project ⓘ is retired; its points live in the page ⓘ.
 *   §14 No accent edge on a conversation row.
 *   §15 The pinned project's knowledge domains, in words.
 *   §20 P4 — documents read vs the 40,000-character project budget.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderViewHeader, renderReadoutGroup } from '../src/public/next/shared/text.js';
import { identityDotClass } from '../src/public/next/shared/sidebar.js';
import { renderDepthCell } from '../src/public/next/shared/depth-bar.js';
import { explainerHtml } from '../src/public/next/shared/explainer.js';
import { EXPLAINERS } from '../src/public/next/shared/explainers.js';
import { formatAge, freshnessTier } from '../src/public/next/shared/age.js';
import { ageWordsFor, tickAges } from '../src/public/next/shared/age-ticker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_JS = path.join(ROOT, 'src/public/next/views/chat.js');
const chatSrc = readFileSync(CHAT_JS, 'utf8');
const chatCss = readFileSync(path.join(ROOT, 'src/public/next/views/chat.css'), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

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
// SANDBOX 1: the REAL renderMain, the REAL header helpers and compile
// builders, the REAL shared/text.js header — stubs only at the edges.
// ─────────────────────────────────────────────────────────────────────────
function render(over = {}) {
  const state = Object.assign({
    booted: true,
    loadError: null,
    domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 1406 }],
    activeDomain: 'articles',
    activeConversationId: 'conv-1',
    conversations: [{ id: 'conv-1', domain: 'articles', title: 'Give me 10 quotes', createdAt: '2026-09-25T08:00:00.000Z', messageCount: 2 }],
    thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
    compileBusy: false,
    compilePct: 0,
    compileKeyAttrs: '',
    compileKeyLineHtml: '',
  }, over);
  const captured = { html: null };
  const src =
    'let myMountToken = 1;\n' +
    extractConst(chatSrc, 'COMPILE_MIN_USER_MESSAGES') + '\n' +
    extractConst(chatSrc, 'CHAT_INFO') + '\n' +
    extractFunction(chatSrc, 'renderCompileButtonHtml') + '\n' +
    extractFunction(chatSrc, 'compileTurnCounts') + '\n' +
    extractFunction(chatSrc, 'compileCaptionText') + '\n' +
    extractFunction(chatSrc, 'compileControlHtml') + '\n' +
    extractFunction(chatSrc, 'activeConversationRow') + '\n' +
    extractFunction(chatSrc, 'chatHeadTitle') + '\n' +
    extractFunction(chatSrc, 'lastAnswerProject') + '\n' +
    extractFunction(chatSrc, 'turnCountsText') + '\n' +
    extractFunction(chatSrc, 'chatHeadMetaHtml') + '\n' +
    extractFunction(chatSrc, 'renderMain') + '\n' +
    'return { renderMain, compileControlHtml, compileCaptionText, chatHeadMetaHtml, chatHeadTitle };';
  const api = new Function(
    'document', 'state', 'isCurrentMount', 'setMain', 'escapeHtml', 'icon',
    'renderViewHeader', 'gatedLoader', 'bootGate', 'emptyCard', 'navigate',
    'renderComposerHtml', 'wireComposer', 'renderThreadOnly', 'tickAgesNow',
    'startCompile', 'reportAsyncActionFailure', 'onThreadCitationClick',
    'identityDotClass', 'ageWordsFor', 'explainerHtml',
    src,
  )(
    { getElementById: () => null, querySelectorAll: () => [] },
    state, () => true,
    (html) => { captured.html = html; },
    escapeHtmlStub, () => '<span class="icon-stub"></span>',
    renderViewHeader,
    () => '<div class="loader-stub"></div>', null,
    () => '<div class="empty-card-stub"></div>', () => {},
    () => '<div class="composer-stub"></div>', () => {}, () => {}, () => 0,
    () => {}, () => {}, () => {},
    identityDotClass, ageWordsFor, explainerHtml,
  );
  api.renderMain(1);
  return { state, api, html: captured.html, tree: parseTree(captured.html || '') };
}

// ─────────────────────────────────────────────────────────────────────────
// SANDBOX 2: the composer's pickers — the REAL domain and project builders,
// the REAL footer, the REAL readout kit, depth bar, age vocabulary and ticker.
// ─────────────────────────────────────────────────────────────────────────
const FOOT_FNS = ['activeProjectRow', 'projectFigureText', 'projectKnowledgeReadout', 'formatCharsShort',
  'projectDocumentOmissions', 'projectDocumentsReadout', 'projectAgeSeconds', 'projectSavedAtIso', 'projectFootHtml'];
function picker(over = {}) {
  const state = Object.assign({
    domains: [
      { slug: 'articles', displayName: 'Articles', pageCount: 1406 },
      { slug: 'projects', displayName: 'Projects', pageCount: 30 },
      { slug: 'mirror', displayName: 'Team', pageCount: 9, readonly: true },
    ],
    activeDomain: 'articles',
    activeConversationId: 'conv-1',
    projectRows: [{ project: 'curator', ageSeconds: 600 }, { project: 'lumina', ageSeconds: null }],
    projectsFetchedAt: Date.parse('2026-09-25T10:00:00.000Z'),
    projectsState: 'ready',
    activeProject: null,
    projectLastUsed: null,
    projectKnowledge: null,
  }, over);
  const calls = { switchDomain: [], selectProject: [] };
  const src =
    'const pendingListboxes = [];\nlet projectLbCfg = null;\nlet domainLbCfg = null;\n' +
    FOOT_FNS.map((n) => extractFunction(chatSrc, n)).join('\n') + '\n' +
    extractFunction(chatSrc, 'projectListboxCfg') + '\n' +
    extractFunction(chatSrc, 'projectPickerHtml') + '\n' +
    extractFunction(chatSrc, 'domainPickerCfg') + '\n' +
    'return { projectListboxCfg, projectPickerHtml, domainPickerCfg, projectFootHtml, projectAgeSeconds, projectSavedAtIso, ' +
    'pending: pendingListboxes, peekProjectLbCfg: () => projectLbCfg };';
  const api = new Function(
    'state', 'escapeHtml', 'formatAge', 'freshnessTier', 'renderReadoutGroup', 'renderDepthCell',
    'identityDotClass', 'ageWordsFor', 'renderListboxHtml', 'selectChatProject', 'switchDomain',
    src,
  )(state, escapeHtmlStub, formatAge, freshnessTier, renderReadoutGroup, renderDepthCell,
    identityDotClass, ageWordsFor,
    (cfg) => '<span class="lb" data-lb-root="' + cfg.id + '"><button class="lb-btn" id="' + cfg.id + '"></button></span>',
    (v) => { calls.selectProject.push(v); }, (v) => { calls.switchDomain.push(v); });
  return { state, api, calls };
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
  ok(!!findByClass(t, 'b') && ancestorClasses(findByClass(t, 'b')).includes('a'), 'the parser finds a nested node and its ancestor');
  ok(findByClass(t, 'nope') === null, 'control: an absent class returns null');
  const r = render();
  ok(typeof r.html === 'string' && r.html.length > 0, 'the REAL renderMain produced markup through setMain');
  ok(!!findByClass(r.tree, 'chat-head'), '…and it contains the view header');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1 — The header: the one heading rule, the page ⓘ, Compile, one meta line');
// ═════════════════════════════════════════════════════════════════════════
{
  const r = render();
  const head = findByClass(r.tree, 'chat-head');
  const vh = findByClass(head, 'tx-vh');
  ok(!!vh, '★ the populated Chat view has a REAL view header (C1: it had none)');
  ok(/ask your wiki/.test(r.html), 'its eyebrow says what the view is for');
  const h1 = findByClass(vh, 'tx-vh-title');
  eq(h1 && h1.tag, 'h1', 'the title is the page <h1>');
  eq(h1 && h1.text, 'Give me 10 quotes', '★ …and it is the CONVERSATION\'s title, as the list names it');
  const info = findByClass(vh, 'tx-vh-info');
  ok(!!info && info.attrs['data-tx-info'] === 'tx-vh-info-chat', '★ the page ⓘ is on the populated view, with its own id');
  ok(r.html.includes(explainerHtml('chat.page')), '…opening the chat.page explainer');
  const btn = findByClass(r.tree, 'chat-compile-pill');
  ok(!!btn && ancestorClasses(btn).includes('tx-vh-actions'), '★ Compile sits in the header\'s ACTION slot');

  const meta = findByClass(head, 'chat-head-meta');
  ok(!!meta, 'ONE meta line under the title');
  const metaText = meta.children.map((c) => c.text + c.children.map((k) => k.text).join('')).join(' ');
  ok(/Articles/.test(metaText), 'it names the domain in words');
  ok(/cur-sb-dot cur-sb-dot-1/.test(r.html.slice(r.html.indexOf('chat-head-meta'))), '…beside its identity dot (the one mapping)');
  ok(/1,406 pages/.test(r.html), 'the domain\'s REAL page count');
  ok(/1 question · 1 answer/.test(r.html), 'the thread\'s real counts');
  ok(/data-age-at="2026-09-25T08:00:00.000Z" data-age-prefix="started"/.test(r.html),
    '★ and the conversation\'s START, ticking, said as "started" — never read as last use');
  ok(!/chat-head-project/.test(r.html), 'no project mark when the last answer recorded none');

  const withProj = render({ thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', project: 'curator' }] });
  ok(/<span class="chat-head-project"><span class="chat-pmark" aria-hidden="true"><\/span>curator<\/span>/.test(withProj.html),
    '★ the LAST answer\'s recorded project is named, with the hollow project mark');
  const oldMsg = render({ thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], activeProject: 'curator' });
  ok(!/chat-head-project/.test(oldMsg.html), '★ an answer from before v3.72 (no `project` key) names none — never guessed from the pin');

  const fresh = render({ activeConversationId: null, thread: [] });
  eq(findByClass(fresh.tree, 'tx-vh-title').text, 'New chat', 'a new chat is titled "New chat"');
  ok(!findByClass(fresh.tree, 'chat-compile-pill'), '…with no Compile (nothing to compile yet)');
  ok(!/question/.test(fresh.html.slice(fresh.html.indexOf('chat-head-meta'))), '…and no turn counts');

  const unlisted = render({ conversations: [], thread: [{ role: 'user', content: 'x'.repeat(70) }] });
  eq(findByClass(unlisted.tree, 'tx-vh-title').text, 'x'.repeat(57) + '…',
    'a conversation not in the list (a mirror\'s is never written) is titled by the server\'s own 57-character rule');
  const hostile = render({ conversations: [{ id: 'conv-1', domain: 'articles', title: '<img src=x onerror=1>' }] });
  ok(!/<img/.test(hostile.html), 'a hostile title is escaped');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — THE DOM PATH: the page count can never read as Compile\'s caption');
// ═════════════════════════════════════════════════════════════════════════
// The report this suite was born for: `[Compile to Wiki] 1,406 pages in
// scope` read as ONE phrase, and a user did not press the button. The count
// is the DOMAIN's; Compile writes a handful of pages from one thread.
{
  const r = render();
  const count = findByClass(r.tree, 'chat-head-pages');
  const btn = findByClass(r.tree, 'chat-compile-pill');
  ok(!!count && !!btn, 'both are rendered');
  ok(ancestorClasses(count).includes('chat-head-meta') && !ancestorClasses(count).includes('tx-vh-actions'),
    '★ the count lives in the META line, never in the action slot');
  ok(!siblingClasses(btn).includes('chat-head-pages') && !siblingClasses(count).includes('chat-compile-pill'),
    '★ …and is not the button\'s sibling');
  const nca = nearestCommonAncestor(count, btn);
  ok(!!nca && nca.classes.includes('chat-head'), 'their nearest common ancestor is the header container itself');
  // ANTI-VACUITY: the pre-fix markup fails the same predicate.
  const pre = parseTree('<div class="bar"><div class="spacer"></div><button class="chat-compile-pill">Compile</button><span class="chat-head-pages">1,406 pages in scope</span></div>');
  ok(siblingClasses(findByClass(pre, 'chat-compile-pill')).includes('chat-head-pages'),
    'CONTROL: the pre-fix arrangement IS caught by the sibling predicate');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — Compile\'s caption: the real counts, and the button\'s description');
// ═════════════════════════════════════════════════════════════════════════
{
  const r = render({ thread: [
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
    { role: 'compile', html: '<p>x</p>' },
    { role: 'user', content: 'e' },
  ] });
  eq(r.api.compileCaptionText(), 'Saves this conversation — 3 questions and 2 answers — as wiki pages',
    '★ questions and answers counted off the thread; a compile card is not a message');
  const cap = findByClass(r.tree, 'chat-compile-caption');
  ok(!!cap && cap.classes.includes('visually-hidden') && cap.attrs.id === 'chat-compile-caption',
    'the caption is visually hidden (the meta line shows the counts on the face)…');
  ok(/aria-describedby="chat-compile-caption"/.test(r.html), '★ …and it IS the button\'s description, so it is not lost');
  const noKey = render({ compileKeyAttrs: ' disabled aria-disabled="true" aria-describedby="chat-compile-runline"' });
  ok(!/aria-describedby="chat-compile-caption"/.test(noKey.html) && /aria-describedby="chat-compile-runline"/.test(noKey.html),
    'with no key, the button is described by the no-key line instead — ONE describedby, never two');
  const none = render({ thread: [{ role: 'user', content: 'a' }] });
  ok(/no answers yet/.test(none.api.compileCaptionText()), '"0 answers" reads "no answers yet"');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3b — the header\'s facts TICK with the thread, and nothing repaints');
// ═════════════════════════════════════════════════════════════════════════
{
  const state = {
    domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 12 }],
    activeDomain: 'articles', activeConversationId: 'conv-1',
    conversations: [{ id: 'conv-1', domain: 'articles', title: 'T', createdAt: '2026-09-25T08:00:00.000Z' }],
    thread: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
  };
  const meta = { innerHTML: 'OLD' };
  const title = { textContent: 'T' };
  const cap = { textContent: 'OLD' };
  let renders = 0;
  const doc = {
    getElementById: (id) => (id === 'chat-head-meta' ? meta : id === 'chat-compile-caption' ? cap : null),
    querySelector: (sel) => (sel === '#chat-head .tx-vh-title' ? title : null),
  };
  const api = new Function('document', 'state', 'escapeHtml', 'identityDotClass', 'ageWordsFor', 'renderMain',
    ['activeConversationRow', 'chatHeadTitle', 'lastAnswerProject', 'turnCountsText', 'chatHeadMetaHtml',
      'compileTurnCounts', 'compileCaptionText', 'refreshCompileCaption', 'patchChatHead']
      .map((n) => extractFunction(chatSrc, n)).join('\n') + '\nreturn { patchChatHead };',
  )(doc, state, escapeHtmlStub, identityDotClass, ageWordsFor, () => { renders++; });
  state.thread.push({ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2', project: 'curator' });
  api.patchChatHead();
  ok(/2 questions · 2 answers/.test(meta.innerHTML), '★ the meta line states the new counts');
  ok(/curator/.test(meta.innerHTML), '…and the project the new answer recorded');
  ok(/2 questions and 2 answers/.test(cap.textContent), '…and the caption agrees with it');
  eq(renders, 0, '★ by targeted writes — the header (and its open ⓘ, and Compile\'s focus) is never repainted');
  state.conversations[0].title = 'Renamed';
  api.patchChatHead();
  eq(title.textContent, 'Renamed', 'the title follows the list\'s name for the thread');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — The caption does NOT restate the cost gate');
// ═════════════════════════════════════════════════════════════════════════
{
  const r = render();
  ok(!/\$|cost|price|free/i.test(r.api.compileCaptionText()),
    'no money in the caption — the confirm dialog is the cost gate (v3.27.0), and a price here would be un-estimated');
  ok(!/\$\d/.test(r.html.slice(r.html.indexOf('chat-head-meta'))), 'nor a figure in the meta line');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — F1: a compile\'s fresh page count reaches every place it is printed');
// ═════════════════════════════════════════════════════════════════════════
// The truth audit: after a compile wrote pages, `state.domains` held the new
// count and the screen kept the old one until a domain switch. Every place
// the count is printed is patched in place now — and never by renderMain.
{
  const state = {
    domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 1406 }],
    activeDomain: 'articles', activeConversationId: null, conversations: [], thread: [],
  };
  const meta = { innerHTML: '' };
  const empty = { textContent: 'This domain has 1,406 pages. OLD' };
  const setOptionsCalls = [];
  const lbCfg = { options: [] };
  const doc = {
    getElementById: (id) => (id === 'chat-head-meta' ? meta : null),
    querySelector: (sel) => (sel === '.chat-empty-body' ? empty : null),
  };
  let renders = 0;
  const api = new Function('document', 'state', 'escapeHtml', 'identityDotClass', 'ageWordsFor', 'renderMain',
    'domainLbCfg', 'domainLbApi', 'switchDomain',
    ['activeConversationRow', 'chatHeadTitle', 'lastAnswerProject', 'turnCountsText', 'chatHeadMetaHtml',
      'compileTurnCounts', 'compileCaptionText', 'refreshCompileCaption', 'patchChatHead',
      'emptyThreadBodyText', 'domainPickerCfg', 'patchScopeCount']
      .map((n) => extractFunction(chatSrc, n)).join('\n') + '\nreturn { patchScopeCount };',
  )(doc, state, escapeHtmlStub, identityDotClass, ageWordsFor, () => { renders++; },
    lbCfg, { setOptions: (o) => setOptionsCalls.push(o) }, () => {});
  state.domains = [{ slug: 'articles', displayName: 'Articles', pageCount: 1411 }];
  api.patchScopeCount();
  ok(/1,411 pages/.test(meta.innerHTML), '★ the header\'s meta line shows the NEW count');
  ok(/This domain has 1,411 pages\./.test(empty.textContent), '★ …and so does the empty thread\'s line');
  ok(setOptionsCalls.length === 1 && /1,411 pages/.test(setOptionsCalls[0][0].detail),
    '★ …and the composer\'s domain menu, through the kit\'s own setOptions');
  eq(renders, 0, 'no renderMain — the composer and its draft are untouched');
  const compileSrc = stripJs(extractFunction(chatSrc, 'runCompile'));
  ok(/state\.domains = domainsData\.domains;[\s\S]{0,400}patchScopeCount\(\)/.test(compileSrc),
    'and runCompile calls it right after the post-compile stats read');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — M2: the ⓘ never pushes the thread');
// ═════════════════════════════════════════════════════════════════════════
{
  const css = stripCss(chatCss);
  const rule = /#tx-vh-info-chat\s*\{([^}]*)\}/.exec(css);
  ok(!!rule && /position:\s*absolute/.test(rule[1]), '★ the header\'s panel is laid OVER the thread (position: absolute), not in the flow');
  ok(!!rule && !/background|color|border/.test(rule[1].replace(/box-shadow[^;]*;/, '')),
    '…and the rule sets POSITION (and its lift), never the panel\'s colours — those stay shared/text.css\'s');
  ok(/\.chat-head\s*\{[^}]*position:\s*relative/.test(css), 'anchored to the header, which is its containing block');
  ok(!/\.chat-head\s*\{[^}]*position:\s*sticky/.test(css), 'and the header is NOT sticky — no bar squeezes the thread');
  const r = render();
  ok(/<div class="tx-vh-panel" id="tx-vh-info-chat"/.test(r.html), 'CONTROL: the id the rule targets is the one renderMain gives the panel');
  ok(!/tx-vh-info-chat-boot|tx-vh-info-chat-empty/.test(r.html), '…and not the boot/empty headers\' ids');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — The composer\'s DOMAIN pill: the conversation\'s container');
// ═════════════════════════════════════════════════════════════════════════
{
  const fixed = picker().api.domainPickerCfg();
  ok(/\bis-fixed\b/.test(fixed.triggerClass), '★ once a conversation exists the pill is drawn FIXED');
  ok(/This conversation is in <strong>Articles<\/strong>\. Another domain starts a new chat there\./.test(fixed.footHtml),
    '★ …its menu says which domain the conversation is in, and what another choice does');
  const opts = fixed.options;
  eq(opts.map((o) => o.value).join(), 'articles,projects,mirror', 'every domain is offered, in the install\'s order');
  ok(/^1,406 pages$/.test(opts[0].detail) && /^new chat · 30 pages$/.test(opts[1].detail),
    '★ the current domain shows its pages; every other reads "new chat" — it can never look like a filter over the thread');
  ok(/read-only/.test(opts[2].detail), 'a Shared Brain mirror says it is read-only');
  ok(opts.every((o, i) => o.html.includes('cur-sb-dot ' + identityDotClass(i))), 'each option carries its domain\'s identity dot');
  ok(/Domain: Articles\. This conversation is in Articles/.test(fixed.ariaLabel), 'the fixed state is in the accessible name too');
  const open = picker({ activeConversationId: null }).api.domainPickerCfg();
  ok(!/is-fixed/.test(open.triggerClass) && open.footHtml === '', 'a NEW chat\'s pill is a plain choice, with no foot');
  ok(!/new chat ·/.test(open.options.map((o) => o.detail).join()), '…and no option claims to start a new chat');
  const p = picker();
  p.api.domainPickerCfg().onChange('projects');
  eq(p.calls.switchDomain.join(), 'projects', 'choosing a domain goes through switchDomain (a new chat there)');
  const sw = stripJs(extractFunction(chatSrc, 'switchDomain'));
  ok(/state\.activeConversationId = null/.test(sw) && /state\.thread = \[\]/.test(sw), 'switchDomain lands on an empty new chat');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — The PROJECT control\'s three states, and its dropped handle');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = (over) => picker(over).api.projectPickerHtml();
  ok(/Reading projects…/.test(html({ projectsState: 'loading', projectRows: [] })), 'NOT ASKED YET: "Reading projects…"');
  ok(/>No projects yet</.test(html({ projectsState: 'ready', projectRows: [] })), 'NONE: said as a fact');
  ok(/Projects could not be read\./.test(html({ projectsState: 'error', projectRows: [] })), 'FAILED: said as a failure, never as "none"');
  const p = picker();
  const ready = p.api.projectPickerHtml();
  ok(/data-lb-root="chat-project-lb"/.test(ready) && p.api.pending.length === 1, 'READY: the picker, queued for mounting');
  ok(!!p.api.peekProjectLbCfg(), 'CONTROL: a handle exists while a picker is on screen');
  p.state.projectsState = 'error';
  p.api.projectPickerHtml();
  eq(p.api.peekProjectLbCfg(), null, '★ a picker that WAS mounted and is not any more leaves no handle to republish onto');
  eq(p.api.projectListboxCfg().ariaLabel, 'Project for your next question', 'the project is per QUESTION (M2)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — F3: every project age is LIVE');
// ═════════════════════════════════════════════════════════════════════════
// The truth audit: "saved 4 min ago" read the same an hour later — the rows'
// `ageSeconds` was measured at fetch and never moved. Now the fetch instant
// is kept beside the rows, and the shared ticker advances the words.
{
  const FETCHED = Date.parse('2026-09-25T10:00:00.000Z');
  const p = picker({ projectsFetchedAt: FETCHED, activeProject: 'curator' });
  eq(Math.round(p.api.projectAgeSeconds({ ageSeconds: 600 }, FETCHED + 3000 * 1000)), 3600,
    '★ an age is the server\'s reading PLUS the time since the fetch (600s + 3000s = 1 hr)');
  eq(p.api.projectAgeSeconds({ ageSeconds: null }, FETCHED), null, 'no saves stays null — never a guessed age');
  eq(p.api.projectSavedAtIso({ ageSeconds: 600 }), '2026-09-25T09:50:00.000Z', 'the save instant = fetch − ageSeconds');
  const cfg = p.api.projectListboxCfg();
  const cur = cfg.options.find((o) => o.value === 'curator');
  ok(/data-age-at="2026-09-25T09:50:00.000Z" data-age-text/.test(cur.html), '★ each option\'s age carries the instant the ticker reads');
  ok(!/data-age-at/.test(cfg.options.find((o) => o.value === 'lumina').html), 'a never-saved project carries none — "no saves"');
  ok(/class="chat-project-foot" data-age-at="2026-09-25T09:50:00.000Z" data-age-prefix="saved"/.test(cfg.footHtml),
    '★ the footer\'s "saved …" is a ticking age too');
  // THE REAL TICKER over the real markup: 50 minutes later the words move.
  const el = (html) => {
    const at = /data-age-at="([^"]+)"/.exec(html)[1];
    const prefix = (/data-age-prefix="([^"]+)"/.exec(html) || [])[1] || null;
    const target = { textContent: 'saved 10 min ago' };
    const node = {
      getAttribute: (a) => (a === 'data-age-at' ? at : a === 'data-age-prefix' ? prefix : null),
      hasAttribute: () => false,
      querySelector: (sel) => (sel === '.tx-readout-value' ? target : null),
    };
    return { node, target };
  };
  const f = el(cfg.footHtml);
  const n = tickAges({ querySelectorAll: () => [f.node] }, Date.parse('2026-09-25T10:50:00.000Z'));
  eq(f.target.textContent, 'saved 1 hr ago', '★ the REAL ticker rewrites the footer\'s words an hour after the save');
  eq(n, 1, '…as one text write, never a repaint');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — F3: the projects are re-read after an answer, quietly');
// ═════════════════════════════════════════════════════════════════════════
{
  const mk = (over, payload) => {
    const state = Object.assign({
      activeDomain: 'projects', activeProject: 'curator', activeProjectScope: null, projectLastUsed: null,
      projectRows: [{ project: 'curator', ageSeconds: 600 }], projectsState: 'ready', projectsFetchedAt: 1, projectKnowledge: null,
    }, over);
    const calls = { patch: 0, setOptions: [], unpin: [] };
    const mounted = { options: [], footHtml: 'OLD' };
    const api = new Function('state', 'fetch', 'isCurrentMount', 'patchProjectPicker', 'writePinnedProject',
      'escapeHtml', 'formatAge', 'freshnessTier', 'renderReadoutGroup', 'renderDepthCell', 'ageWordsFor', 'selectChatProject',
      '__mounted', '__api',
      'let projectLbCfg = __mounted;\nlet projectLbApi = __api;\n' +
      FOOT_FNS.map((n) => extractFunction(chatSrc, n)).join('\n') + '\n' +
      extractFunction(chatSrc, 'projectListboxCfg') + '\n' +
      extractFunction(chatSrc, 'refreshProjectsQuietly') + '\nreturn { refreshProjectsQuietly, peek: () => projectLbCfg };',
    );
    return { state, calls, mounted, fn: (d) => api(state,
      async () => ({ ok: true, json: async () => payload }), () => true,
      () => { calls.patch++; }, (d2, p) => calls.unpin.push([d2, p]),
      escapeHtmlStub, formatAge, freshnessTier, renderReadoutGroup, renderDepthCell, ageWordsFor, () => {},
      mounted, { setOptions: (o) => calls.setOptions.push(o) }).refreshProjectsQuietly(d, 1) };
  };
  {
    const h = mk({}, { projects: [{ project: 'curator', ageSeconds: 5 }, { project: 'new-one', ageSeconds: 30 }] });
    await h.fn('projects');
    eq(h.state.projectRows.length, 2, '★ a project an agent created meanwhile is now in the list');
    ok(h.state.projectsFetchedAt > 1, '…with a fresh fetch instant, so the ages restart from the truth');
    eq(h.calls.patch, 0, '★ the picker is NOT repainted (an open menu stays open)…');
    ok(h.calls.setOptions.length === 1 && h.calls.setOptions[0].length === 3, '…its options go in through the kit\'s setOptions');
    ok(h.mounted.footHtml !== 'OLD', '…and the footer onto the SAME cfg object the next menu build reads');
  }
  {
    const h = mk({}, { projects: [{ project: 'other', ageSeconds: 5 }] });
    await h.fn('projects');
    eq(h.state.activeProject, null, '★ a pinned project that has gone is UNPINNED — never sent to a route that would refuse it');
    eq(h.calls.unpin.join(), 'projects,', '…and forgotten for that domain');
    eq(h.calls.patch, 1, '…and that one case repaints, because the pill would otherwise name it');
  }
  {
    const h = mk({ activeDomain: 'articles' }, { projects: [] });
    await h.fn('projects');
    eq(h.state.projectRows.length, 1, 'an answer for a domain the view has left changes nothing');
  }
  const send = stripJs(extractFunction(chatSrc, 'sendCurrentMessage'));
  ok(/refreshProjectsQuietly\(domainAtSend, here\(\)\)/.test(send), 'and a completed turn asks for it, for the domain it was sent in');
}

// ═════════════════════════════════════════════════════════════════════════
section('§11 — the pinned project\'s footer, and its republish guard');
// ═════════════════════════════════════════════════════════════════════════
{
  const pinned = picker({ activeProject: 'curator' }).api.projectListboxCfg();
  ok(/tx-readout/.test(pinned.footHtml) && /saved/.test(pinned.footHtml) && />curator</.test(pinned.footHtml),
    'PINNED: the footer is a readout naming the project and its age in words');
  ok(/fresh-dot fresh-(live|recent|today|week|dormant|unknown)/.test(pinned.footHtml), '…with the app-wide freshness tier');
  eq(picker().api.projectListboxCfg().footHtml, '', 'UNPINNED: no footer at all');
  ok(/no saves yet/.test(picker({ activeProject: 'lumina' }).api.projectListboxCfg().footHtml),
    'a never-saved project reads "no saves yet"');
  ok(/whole block 12\.3k characters read last turn/.test(
    picker({ activeProject: 'curator', projectLastUsed: { chars: 12288 } }).api.projectListboxCfg().footHtml),
    'after a turn, the footer states what the project context contributed');
  const rows = pinned.options.filter((o) => o.value);
  ok(rows.every((o) => o.detail), 'every option row carries its OWN age');
}
{
  // ── §11d — THE GUARD, DRIVEN: the real patchProjectFooter, both arms ───
  const state = {
    activeDomain: 'articles', activeProject: 'curator', projectLastUsed: null,
    projectsState: 'ready', projectRows: [{ project: 'curator', ageSeconds: 600 }], projectsFetchedAt: Date.now(),
  };
  const src = FOOT_FNS.map((n) => extractFunction(chatSrc, n)).join('\n') + '\n' +
    extractFunction(chatSrc, 'patchProjectFooter') + '\nreturn { patchProjectFooter };';
  const make = (doc, cfgHandle) => new Function(
    'document', 'state', 'projectLbCfg', 'formatAge', 'freshnessTier', 'renderReadoutGroup', 'renderDepthCell', 'escapeHtml', src,
  )(doc, state, cfgHandle, formatAge, freshnessTier, renderReadoutGroup, renderDepthCell, escapeHtmlStub);
  let touched = 0;
  let threw = null;
  try { make({ getElementById: () => { touched++; return null; } }, null).patchProjectFooter(); } catch (e) { threw = e; }
  ok(threw === null && touched === 0, 'NO PICKER MOUNTED: the update returns before looking for anything');
  const cfgShut = { footHtml: 'STALE' };
  state.projectLastUsed = { chars: 12288 };
  make({ getElementById: () => null }, cfgShut).patchProjectFooter();
  ok(/whole block 12\.3k characters read last turn/.test(cfgShut.footHtml), '★ MENU SHUT: the cfg is republished anyway — the next open shows it');
  const foot = { innerHTML: 'STALE' };
  const menu = { querySelector: (sel) => (sel === '.lb-foot' ? foot : null) };
  const cfgOpen = { footHtml: 'STALE' };
  make({ getElementById: (id) => (id === 'chat-project-lb-menu' ? menu : null) }, cfgOpen).patchProjectFooter();
  ok(foot.innerHTML === cfgOpen.footHtml && /12\.3k/.test(foot.innerHTML), '★ MENU OPEN: the live footer gets the SAME string');
}

// ═════════════════════════════════════════════════════════════════════════
section('§12 — the project ⓘ is retired; its points live in the page ⓘ');
// ═════════════════════════════════════════════════════════════════════════
{
  const code = stripJs(chatSrc);
  ok(!/chat-project-info|CHAT_PROJECT_INFO|explainerMark\(/.test(code),
    '★ chat.js renders no project ⓘ — the mark that took the thread\'s height inside the sticky bar is gone');
  ok(!Object.prototype.hasOwnProperty.call(EXPLAINERS, 'chat.project'), 'and the `chat.project` explainer entry is retired');
  const page = EXPLAINERS['chat.page'];
  ok(page.points.some((p) => /pinned project/.test(p.text) && /never changed/.test(p.text)),
    '★ its substance moved into `chat.page`: a pinned project is read, never written');
  ok(!page.points.some((p) => /domain chips|which wikis/i.test(p.text)),
    '★ and C2 is fixed: nothing claims the chips choose "wikis" — a conversation reads ONE domain');
}

// ═════════════════════════════════════════════════════════════════════════
section('§14 — no accent edge on a conversation row (R10), and rows are the kit\'s');
// ═════════════════════════════════════════════════════════════════════════
{
  const listCss = stripCss(readFileSync(path.join(ROOT, 'src/public/next/views/chat-list.css'), 'utf8'));
  ok(!/::before/.test(listCss), '★ chat-list.css draws no ::before on anything — no left line can come back through it');
  ok(!/\.chat-conv-row\b/.test(stripCss(chatCss)), 'and chat.css paints no row state of its own — the row is `.cur-sb-row`');
  ok(!/\.cur-sb-row(\.active|:hover)\s*\{/.test(listCss), '…nor does chat-list.css re-paint the kit\'s hover or active');
}

// ═════════════════════════════════════════════════════════════════════════
section('§15 — the pinned project\'s knowledge domains, said in words');
// ═════════════════════════════════════════════════════════════════════════
// v3.72.0: the scope-bar chips that were MARKED as "in this project's
// knowledge" are gone with the bar. The fact survives where it was always
// also said: the project picker's footer.
{
  const KN = (over) => Object.assign({ project: 'curator', domains: ['articles'], defaulted: true, missing: [], error: false }, over);
  const foot = (over) => picker(Object.assign({ activeProject: 'curator' }, over)).api.projectListboxCfg().footHtml;
  ok(/the default/.test(foot({ projectKnowledge: KN() })) && /nobody has chosen/.test(foot({ projectKnowledge: KN() })),
    'a DEFAULTED list says so — "nobody has chosen" is not dressed up as a choice');
  const chosen = foot({ projectKnowledge: KN({ domains: ['research', 'business'], defaulted: false }) });
  ok(/chosen for this project/.test(chosen) && /research · business/.test(chosen), 'a CHOSEN list names its domains');
  ok(/its knowledge lives in another domain — this chat reads only articles/.test(chosen),
    '★ …and says what this chat actually reads, because the two can differ');
  ok(/gone is not on this computer/.test(foot({ projectKnowledge: KN({ domains: ['research', 'gone'], defaulted: false, missing: ['gone'] }) })),
    'a named domain that is not on this computer is said');
  ok(/could not be read/.test(foot({ projectKnowledge: { project: 'curator', domains: ['research'], defaulted: false, missing: [], error: true } })),
    '★ a failed read says so — `error` is tested before the list it may be carrying');
  ok(!/Knowledge|domains/.test(foot({ projectKnowledge: null })), 'NOT ASKED YET: no knowledge row — "not told" is not "none"');
  ok(!/research/.test(picker({ activeProject: 'lumina', projectKnowledge: KN({ domains: ['research'], defaulted: false }) }).api.projectListboxCfg().footHtml),
    '★ a record for ANOTHER project is never shown beside this one');
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
      'state', 'fetch', 'isCurrentMount', 'patchProjectPicker', 'patchScopePillMarks_unused',
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
    ok(h.patched.group === 1 && h.patched.marks === 0,
      '…and the ONE targeted patch runs — the project picker, for its footer (v3.72.0: no chips to mark)');
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


section('§20 — P4 (v3.66.0): documents read vs the 40,000-character project budget');
// The footer's documents reading, EXECUTED through the real footer builder,
// the real readout kit and the real depth bar. What a user is served is the
// cfg's footHtml string (§11a's reason), so that is what every line reads.
{
  const foot = (used) => picker({ activeProject: 'curator', projectLastUsed: used }).api.projectListboxCfg().footHtml;
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
console.log('✅ All chat scope assertions green');
