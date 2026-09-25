/**
 * test-next-chat-copy.js — OFFLINE suite for two things a user asked for in
 * the Chat view (src/public/next/views/chat.js + chat.css):
 *
 *   §1–§5  THE PER-MESSAGE COPY CONTROL. An icon-only button on every
 *          question and every answer that puts that message's own MARKDOWN on
 *          the clipboard. Asked for by a user; specified by the maintainer as
 *          an icon with no word beside it.
 *   §6–§7  THE COST BREAKDOWN'S MISSING HALF. A user compared two answers to
 *          the same question — Sonnet 5 "$0.10" against Flash Lite 2.5
 *          "$0.0024", 41.7x — where the price table implies about 21x. The
 *          rest is adaptive thinking billed inside `output_tokens`, and the
 *          breakdown behind the figure ("19250 in / 6150 out tokens") could
 *          not say so because `normalizeReportedUsage` dropped the one field
 *          that knows: `reasoningTokens`.
 *
 * WHY A NEW FILE. The existing chat suites each own one subject and say so in
 * their headers: `test-next-chat-streaming.js` owns the in-flight bubble,
 * `test-next-chat-scopebar.js` the scope bar, `test-next-composer-model.js`
 * the model picker and the cost FIGURE. None owns "what a finished message
 * renders beside its eyebrow", and the copy control spans the renderer, the
 * stylesheet and the clipboard handler.
 *
 * TECHNIQUE. Everything here EXECUTES the shipped functions — extracted from
 * the real source by brace matching, run against a fake document and a fake
 * clipboard. Nothing is asserted by grepping for a line, except where the
 * property genuinely IS a source property (a stylesheet rule, an absent
 * `title=`), and those are labelled as source guards rather than implied to be
 * behavioural. A desync in the extractor THROWS rather than degrading into a
 * green suite that tested nothing.
 *
 * NOT ENFORCED, NAMED RATHER THAN IMPLIED AWAY:
 *  · Nothing here renders. Whether the button LANDS on the meta line, at the
 *    right edge, is a browser measurement and was taken separately.
 *  · The real `navigator.clipboard` is not exercised; a host that refuses the
 *    write is modelled by a rejecting promise.
 *  · The 1.5 s reset is driven by an injected clock, never by waiting.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_JS = path.join(ROOT, 'src/public/next/views/chat.js');
const CHAT_CSS = path.join(ROOT, 'src/public/next/views/chat.css');
const BRAIN_CHAT = path.join(ROOT, 'src/brain/chat.js');
const chatSrc = readFileSync(CHAT_JS, 'utf8');
const chatCss = readFileSync(CHAT_CSS, 'utf8');
const brainSrc = readFileSync(BRAIN_CHAT, 'utf8');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
// v3.72.0 (truth audit F2): a message with no recorded `priced` is priced at
// TODAY's catalogue, and the token breakdown says so in its last sentence.
const TODAY = '. At today\u2019s price: this answer was written before prices were recorded with each answer.';
function section(t) { console.log(`\n${t}`); }

// ── Extraction (brace-matched; a desync fails LOUDLY) ─────────────────────
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), depth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') depth++;
    else if (src[p] === ')') { depth--; if (depth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  if (i === -1) throw new Error(`extractFunction: "${name}" has no body`);
  depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" extraction desynced`);
  return out;
}
function extractConst(src, name) {
  const re = new RegExp(`(?:^|\\n)const ${name} = [^\\n]*\\n`);
  const m = re.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found`);
  return m[0].trim();
}
/** Strip comments so a rule's own prose cannot satisfy a CSS assertion. */
function stripCssComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }
/**
 * The same rule for JavaScript. Deliberately crude — it can also blank a `//`
 * inside a string literal — and that is safe in ONE direction only: it can
 * make an assertion demand MORE than it needs, never less. Every use of it
 * below is paired with a CONTROL asserting the stripped text really did lose
 * something, so a stripper that silently stopped working cannot pass quietly.
 */
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function cssBody(sel) {
  const re = new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = re.exec(stripCssComments(chatCss));
  return m ? m[1] : '';
}
/**
 * EVERY rule body whose selector MENTIONS this class — not just the first.
 *
 * `cssBody` returns the first match, and that is a real blind spot rather than
 * a theoretical one: it was FOUND by its own mutation. Adding
 * `.chat-copy-btn { opacity: 0 }` LATER in the sheet — the exact edit that
 * would make the control hover-only again, which is the thing §5b exists to
 * forbid — left every §5b assertion green, because they were all reading the
 * first rule and the first rule was untouched. A "is it visible at rest"
 * question has to be asked of the whole cascade, not of one declaration block.
 *
 * `opts.stateless` drops any rule carrying a pseudo-class or pseudo-element,
 * so `:hover` and `:active` (which are SUPPOSED to change things) are not
 * counted as hiding the resting state.
 */
function cssBodiesFor(cls, opts = {}) {
  const out = [];
  for (const m of stripCssComments(chatCss).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!new RegExp('\\.' + cls + '\\b').test(sel)) continue;
    if (opts.stateless && /::?[a-z-]+/.test(sel)) continue;
    out.push({ sel, body: m[2] });
  }
  return out;
}

const iconStub = (n, px) => `<svg data-icon="${n}" data-px="${px}"></svg>`;

// ═══════════════════════════════════════════════════════════════════════════
section('§0  Harness self-check — this suite can fail');
// ═══════════════════════════════════════════════════════════════════════════
{
  ok(true === true, 'control: ok() passes a true condition');
  let sawThrow = false;
  try { extractFunction(chatSrc, 'noSuchFunctionAnywhere', 'chat.js'); } catch { sawThrow = true; }
  ok(sawThrow, 'control: a missing extraction THROWS rather than yielding an empty, always-green subject');
  ok(cssBody('.chat-copy-btn').length > 0, 'control: the CSS reader finds a real rule body');
  ok(cssBody('.chat-no-such-class-anywhere') === '', 'control: …and returns nothing for a class that does not exist');
}

// ─────────────────────────────────────────────────────────────────────────
// The markup sandbox: the REAL copyControlHtml.
// ─────────────────────────────────────────────────────────────────────────
const markup = new Function('icon',
  extractFunction(chatSrc, 'copyControlHtml', 'chat.js') + '\n' +
  'return { copyControlHtml };')(iconStub);
const { copyControlHtml } = markup;

// ═══════════════════════════════════════════════════════════════════════════
section('§1  The control is an ICON, named for assistive technology, with no title=');
// ═══════════════════════════════════════════════════════════════════════════
{
  const a = copyControlHtml(3, 'answer', { role: 'assistant', content: 'Some **answer**.' });
  const q = copyControlHtml(2, 'question', { role: 'user', content: 'Some question?' });

  ok(/^<button type="button" class="chat-copy-btn"/.test(a),
    'it is a real <button type="button">, not a div with a click handler');
  ok(!/\bdisabled\b/.test(a), '…and never disabled — a disabled control is out of the tab order');
  ok(a.includes('data-copy-msg="3"') && q.includes('data-copy-msg="2"'),
    'each carries its own message INDEX, which is the handle the click handler resolves text through');

  // THE ICON-ONLY REQUIREMENT, asserted as an absence of visible words rather
  // than as the presence of a glyph: a check for the <svg> alone would stay
  // green with the word "Copy" printed beside it.
  const visible = a
    .replace(/<span class="visually-hidden"[^>]*>[\s\S]*?<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  eq(visible, '', 'the button shows NO visible text — the maintainer asked for an icon with no word');
  ok(a.includes('data-icon="copy"'), '…and the glyph is the shared `copy` icon, so Chat and Agent memory read alike');
  ok(a.includes('data-px="13"'), '…at one stated size, so the success swap cannot change the box');

  // NAMED. aria-label plus a visually-hidden label, from the same variable, so
  // the two can never drift apart (WCAG 2.5.3's containment is trivial when
  // the strings are identical).
  ok(a.includes('aria-label="Copy answer"') && a.includes('>Copy answer</span>'),
    'an answer is named "Copy answer" in BOTH the aria-label and the hidden label');
  ok(q.includes('aria-label="Copy question"') && q.includes('>Copy question</span>'),
    'a question is named "Copy question" in both');
  ok(!/title=/.test(a) && !/title=/.test(q),
    'NO title= — a tooltip is the hover-only carrier this repo has been removing since v3.20.0');

  // The live region: present, polite, and OUTSIDE the button.
  ok(a.indexOf('data-copy-status') > a.indexOf('</button>'),
    'the aria-live region is a SIBLING after the button, never inside the control it reports on');
  ok(/role="status" aria-live="polite"/.test(a), '…and is polite, not assertive');
  ok(/<span class="visually-hidden" role="status"[^>]*><\/span>/.test(a),
    '…and starts EMPTY, so nothing is announced before anything is copied');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2  It is offered only where there is something to copy');
// ═══════════════════════════════════════════════════════════════════════════
{
  const nothing = [
    ['no message at all', 0, null],
    ['content missing', 0, { role: 'assistant' }],
    ['content null', 0, { role: 'assistant', content: null }],
    ['content is not a string', 0, { role: 'assistant', content: 42 }],
    ['content empty', 0, { role: 'assistant', content: '' }],
    ['content is whitespace only', 0, { role: 'assistant', content: '   \n\t ' }],
    // The shape an ERRORED turn has: the provider's sentence lives in
    // `m.error`, and it is not an answer.
    ['an errored turn (content empty, error set)', 0, { role: 'assistant', content: '', error: 'Rate limited.' }],
  ];
  for (const [label, i, m] of nothing) {
    eq(copyControlHtml(i, 'answer', m), '', `${label} → no control at all`);
  }
  for (const [label, bad] of [['negative', -1], ['fractional', 1.5], ['NaN', NaN], ['a string', '2']]) {
    eq(copyControlHtml(bad, 'answer', { content: 'x' }), '', `a ${label} index → no control (a broken handle is worse than none)`);
  }
  ok(copyControlHtml(0, 'answer', { content: 'x' }) !== '',
    'CONTROL: index 0 IS valid — the first message in a thread must be copyable');
}

// ─────────────────────────────────────────────────────────────────────────
// The behaviour sandbox: the REAL click path, against a fake DOM, a fake
// clipboard and an injected clock.
// ─────────────────────────────────────────────────────────────────────────
function makeButton() {
  const glyph = { innerHTML: '<svg data-icon="copy" data-px="13"></svg>' };
  const status = { textContent: '', hasAttribute: (n) => n === 'data-copy-status' };
  const classes = new Set();
  return {
    glyph, status,
    attrs: { 'data-copy-msg': '0' },
    getAttribute(n) { return this.attrs[n]; },
    querySelector: (s) => (s === '.chat-copy-glyph' ? glyph : null),
    nextElementSibling: status,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      has: (c) => classes.has(c),
      list: () => [...classes],
    },
  };
}

function makeCopyApi(opts = {}) {
  const timers = [];
  const state = { thread: opts.thread || [{ role: 'assistant', content: 'the **answer**' }] };
  const navigatorStub = opts.navigator === undefined
    ? { clipboard: { writeText: (t) => { written.push(t); return opts.reject ? Promise.reject(new Error('nope')) : Promise.resolve(); } } }
    : opts.navigator;
  const written = [];
  const api = new Function('state', 'icon', 'navigator', 'setTimeout', 'clearTimeout', 'WeakMap',
    extractConst(chatSrc, 'COPY_FEEDBACK_MS') + '\n' +
    extractConst(chatSrc, 'copyResetTimers') + '\n' +
    extractFunction(chatSrc, 'markCopyOutcome', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'copyMessageText', 'chat.js') + '\n' +
    'return { copyMessageText, markCopyOutcome, COPY_FEEDBACK_MS };'
  )(
    state, iconStub, navigatorStub,
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    WeakMap,
  );
  return { api, state, written, timers, runTimers: () => timers.filter((t) => !t.cancelled && !t.ran).forEach((t) => { t.ran = true; t.fn(); }) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// ═══════════════════════════════════════════════════════════════════════════
section('§3  Pressing it writes the message MARKDOWN, then confirms, then resets');
// ═══════════════════════════════════════════════════════════════════════════
{
  const MD = '1. **Attention is scarce**\n[source: summaries/x.md]\n\n2. Second';
  const h = makeCopyApi({ thread: [{ role: 'assistant', content: MD }] });
  const btn = makeButton();

  h.api.copyMessageText(btn);
  await settle();

  eq(h.written.length, 1, 'exactly one clipboard write');
  eq(h.written[0], MD,
    'and it is the RAW MARKDOWN the model wrote — citations as written, not the rendered HTML');
  ok(!/<span|chat-citation-tag|<ol|<li>/.test(h.written[0]),
    '…so no markup this view added can reach the clipboard');

  eq(btn.glyph.innerHTML, '<svg data-icon="check" data-px="13"></svg>',
    'the glyph flips to a check');
  ok(btn.classList.has('is-copied') && !btn.classList.has('is-failed'), '…and the copied class is on');
  eq(btn.status.textContent, 'Copied', 'the live region says "Copied" for a reader who cannot see the glyph');

  // The reset is a TIMER, driven here rather than waited on.
  eq(h.timers.length, 1, 'one reset timer was scheduled');
  eq(h.timers[0].ms, h.api.COPY_FEEDBACK_MS, `…at COPY_FEEDBACK_MS (${h.api.COPY_FEEDBACK_MS} ms)`);
  ok(h.api.COPY_FEEDBACK_MS >= 1000 && h.api.COPY_FEEDBACK_MS <= 3000,
    '…which is inside the "long enough to read, short enough not to linger" band the brief asked for (~1.5 s)');

  h.runTimers();
  eq(btn.glyph.innerHTML, '<svg data-icon="copy" data-px="13"></svg>', 'after the timer the glyph is the copy icon again');
  ok(!btn.classList.has('is-copied'), '…the class is off');
  eq(btn.status.textContent, '', '…and the live region is CLEARED — a region still saying "Copied" is a stale claim');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  A refusal is SHOWN, not swallowed');
// ═══════════════════════════════════════════════════════════════════════════
{
  // writeText rejects: insecure context, unfocused document, denied permission.
  const rejecting = makeCopyApi({ reject: true });
  const b1 = makeButton();
  rejecting.api.copyMessageText(b1);
  await settle();
  eq(b1.glyph.innerHTML, '<svg data-icon="alertCircle" data-px="13"></svg>', 'a rejected write shows the alert glyph');
  ok(b1.classList.has('is-failed') && !b1.classList.has('is-copied'), '…and the failed class, never the copied one');
  eq(b1.status.textContent, 'Could not copy', '…and says so in the live region');

  // No Clipboard API at all (an insecure origin drops `navigator.clipboard`).
  const noApi = makeCopyApi({ navigator: {} });
  const b2 = makeButton();
  let threw = false;
  try { noApi.api.copyMessageText(b2); } catch { threw = true; }
  await settle();
  ok(!threw, 'a host with no Clipboard API does not throw out of a click handler');
  ok(b2.classList.has('is-failed'), '…it reports the failure');
  eq(noApi.written.length, 0, '…and nothing was written');

  // A message that vanished from the thread between paint and click.
  const gone = makeCopyApi({ thread: [] });
  const b3 = makeButton();
  gone.api.copyMessageText(b3);
  await settle();
  eq(gone.written.length, 0, 'an index that no longer resolves writes nothing');
  ok(b3.classList.has('is-failed'), '…and says so rather than silently doing nothing');

  // A second press while the first confirmation is still showing must not
  // leave two timers racing to reset one button.
  const twice = makeCopyApi();
  const b4 = makeButton();
  twice.api.copyMessageText(b4);
  await settle();
  twice.api.copyMessageText(b4);
  await settle();
  eq(twice.timers.filter((t) => !t.cancelled).length, 1,
    'a second press cancels the first reset timer rather than stacking one on top of it');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5  Rendered into the thread: both roles, never the streaming bubble');
// ═══════════════════════════════════════════════════════════════════════════
/* Drives the SHIPPED `renderThreadOnly` against a fake document and reads back
   what it wrote — the same technique test-model-failure-ux.js uses, and for
   the same reason: a guard that exercised copyControlHtml alone would stay
   green if the renderer never called it. */
function renderThread(thread, over = {}) {
  const el = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  const doc = { getElementById: (id) => (id === 'chat-thread' ? el : null), querySelector: () => null };
  const state = Object.assign({
    thread, sending: false, cancelNotice: null,
    activeDomain: 'articles', activeConversationId: 'conv-1',
    domains: [{ slug: 'articles', displayName: 'Articles', pageCount: 12 }],
    offerable: {}, availableProviders: [], modelProvider: null, activeProvider: null, chatModel: null,
  }, over);
  // `sendIsOnScreen` gates the in-flight bubble on an identity match, not on a
  // bare `state.sending` — so a sending state needs a matching abort record or
  // the bubble is (correctly) not painted at all.
  const abort = state.sending
    ? { mountToken: 1, domain: state.activeDomain, conversationId: state.activeConversationId }
    : null;
  const src =
    'let myMountToken = 1;\n' +
    `let sendAbort = ${JSON.stringify(abort)}, sendStream = null, lastRenderedConvId;\n` +
    `const THREAD_FOLLOW_SLACK_PX = ${(/const THREAD_FOLLOW_SLACK_PX = (\d+);/.exec(chatSrc) || [])[1]};\n` +
    extractFunction(chatSrc, 'sendIsOnScreen', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'threadScrollHost', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'isThreadAtBottom', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'stickThreadToBottom', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'wireStreamToggle', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'copyControlHtml', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'renderThreadOnly', 'chat.js') + '\n' +
    'return () => renderThreadOnly(1);';
  new Function(
    'document', 'state', 'isCurrentMount', 'escapeHtml', 'icon', 'renderMarkdown',
    'assistantEyebrowHtml', 'cancelNoticeHtml', 'thinkingBodyHtml', 'folderOfPath',
    'typeChipClass', 'citationLabel', 'openWikiReader', 'openBrowseDialog',
    'reaskButtonHtml', 'refreshCompileCaption', 'failedModelNoteHtml',
    // v3.72.0 (P3, M4): the answer renderer and the per-message source map.
    'answerSources', 'renderAnswer', 'sourcesHtml',
    src,
  )(
    doc, state, () => true,
    (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    iconStub, (s) => `<md>${s}</md>`,
    () => '<div class="chat-msg-eyebrow mono">THE CURATOR</div>',
    () => '', () => '<thinking>', () => 'entities', () => 'chip', (c) => c,
    () => {}, () => {}, () => '', () => {}, () => '',
    new Map(),
    (c, o) => ({ html: `<md>${c}</md>`, sources: ((o && o.citations) || []).map((p, i) => ({ n: i + 1, path: p })) }),
    (src) => (src.length ? '<section class="answer-sources"></section>' : ''),
  )();
  return el.innerHTML;
}
{
  const html = renderThread([
    { role: 'user', content: 'what does my wiki say about RAG?' },
    { role: 'assistant', content: 'It says **plenty**.' },
  ]);
  const buttons = html.match(/<button type="button" class="chat-copy-btn"[^>]*>/g) || [];
  eq(buttons.length, 2, 'a finished question and a finished answer each get exactly ONE copy control');
  ok(buttons[0].includes('aria-label="Copy question"') && buttons[0].includes('data-copy-msg="0"'),
    'the first is the question, indexed 0');
  ok(buttons[1].includes('aria-label="Copy answer"') && buttons[1].includes('data-copy-msg="1"'),
    'the second is the answer, indexed 1');

  // ── THE STREAMING BUBBLE ────────────────────────────────────────────────
  // It is painted from `sendStream` and never pushed into state.thread, so an
  // answer becomes copyable at the moment it becomes final. Asserted by
  // rendering WITH a live stream on screen and counting.
  const streaming = renderThread(
    [{ role: 'user', content: 'a question' }],
    { sending: true },
  );
  ok(streaming.includes('chat-msg-thinking'), 'precondition: the in-flight bubble really is on screen');
  const liveButtons = streaming.match(/class="chat-copy-btn"/g) || [];
  eq(liveButtons.length, 1,
    'while an answer streams there is ONE copy control — the question\'s — and none on the bubble');
  const bubble = streaming.slice(streaming.indexOf('chat-msg-thinking'));
  ok(!bubble.includes('chat-copy-btn'), '…and nothing after the bubble opens carries one');

  // An error renders no control, because there is no answer to copy.
  const errored = renderThread([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', error: 'The provider refused.' },
  ]);
  eq((errored.match(/class="chat-copy-btn"/g) || []).length, 1,
    'an errored turn adds no copy control — only the question keeps one');

  // A compile outcome card is not a message.
  const compiled = renderThread([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
    { role: 'compile', html: '<div>done</div>' },
  ]);
  eq((compiled.match(/class="chat-copy-btn"/g) || []).length, 2,
    'a compile outcome card gets none');

  // The existing affordances still render beside it.
  ok(html.includes('chat-msg-eyebrow'), 'the eyebrow is untouched');
  ok(renderThread([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a', citations: ['summaries/x.md'] },
  ]).includes('answer-sources'), 'and the Sources list still renders (v3.72.0: one list, not a chip row)');
}

// ── §5b — SOURCE GUARDS on the stylesheet (labelled as such) ──────────────
{
  const btn = cssBody('.chat-copy-btn');
  ok(/position:\s*absolute/.test(btn) && /right:\s*0/.test(btn),
    '§5b SOURCE: the control is pinned to the right of the message block');
  ok(/position:\s*relative/.test(cssBody('.chat-msg')),
    '§5b SOURCE: …inside .chat-msg, which is its containing block');
  ok(/padding-right/.test(cssBody('.chat-msg-eyebrow')),
    '§5b SOURCE: the eyebrow reserves its lane, so a long model label cannot run under it');
  ok(/color:\s*var\(--text-3\)/.test(btn),
    '§5b SOURCE: it is visible at REST in the eyebrow\'s own ink — not hover-only (v3.16.1)');

  // VISIBILITY AT REST, ASKED OF THE WHOLE CASCADE. Every stateless rule that
  // mentions the class, not merely the first one — see cssBodiesFor's own note
  // for the mutation that found this reading the wrong block and staying green.
  const resting = cssBodiesFor('chat-copy-btn', { stateless: true });
  ok(resting.length >= 1, `§5b SOURCE: ${resting.length} stateless rule(s) reach the control (precondition)`);
  const hiders = resting.filter((r) =>
    /display:\s*none/.test(r.body) ||
    /visibility:\s*hidden/.test(r.body) ||
    /opacity:\s*0(?:\.0+)?\s*[;}]?/.test(r.body) ||
    /(?:^|[;\s])(?:width|height):\s*0\b/.test(r.body));
  ok(hiders.length === 0,
    hiders.length === 0
      ? '§5b SOURCE: NO stateless rule anywhere in the sheet hides it — it is there before you point at it'
      : '§5b SOURCE: a rule hides the control at rest: ' + hiders.map((r) => r.sel).join(', '));
  // ANTI-VACUITY: the scan must be able to SEE such a rule.
  ok(cssBodiesFor('chat-copy-btn').length > resting.length,
    '§5b CONTROL: the scan does find the :hover/:active rules too, and is excluding them deliberately');
  ok(/transform:\s*scale\(var\(--press-scale-icon\)\)/.test(cssBody('.chat-copy-btn:active')),
    '§5b SOURCE: the press reads a press TOKEN, never a literal amplitude');
  ok(/transform/.test(btn) && /--t-press/.test(btn),
    '§5b SOURCE: …and the class declares a transform transition, or the press would snap');
  ok(stripCssComments(chatCss).includes('.chat-copy-btn:active,'),
    '§5b SOURCE: the reduced-motion block in this same file neutralises that press');
  ok(/user-select:\s*none/.test(btn), '§5b SOURCE: chrome does not drag-select');
  ok(/cursor:\s*default/.test(btn) && !/cursor:\s*pointer/.test(btn),
    '§5b SOURCE: no hand cursor — no AppKit control shows one');
  ok(/var\(--hit-min\)/.test(cssBody('.chat-copy-btn::before')),
    '§5b SOURCE: the 24px glyph is grown to the platform hit minimum by a transparent ::before');
  ok(/width:\s*13px/.test(cssBody('.chat-copy-glyph')) && /height:\s*13px/.test(cssBody('.chat-copy-glyph')),
    '§5b SOURCE: the glyph box is fixed, so copy → check → alert cannot resize the button');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6  The store KEEPS reasoningTokens — optionally, and never as a zero');
// ═══════════════════════════════════════════════════════════════════════════
/* src/brain/chat.js's `normalizeReportedUsage` is an explicit allow-list. It
   kept four fields and dropped the fifth, so the breakdown under a dollar
   figure could not account for reasoning the provider had billed inside
   `output_tokens`. It must stay OPTIONAL: Anthropic reports no such count and
   Gemini's normalizer does not surface one, so requiring it would return null
   for those providers and delete every cost figure in the app. */
{
  const store = new Function(
    extractFunction(brainSrc, 'normalizeReportedUsage', 'src/brain/chat.js') + '\n' +
    'return { normalizeReportedUsage };')();
  const { normalizeReportedUsage } = store;
  const FOUR = { inputTokens: 19250, outputTokens: 6150, cachedReadTokens: 0, cacheWriteTokens: 0 };

  const kept = normalizeReportedUsage({ ...FOUR, reasoningTokens: 4900 });
  eq(kept.reasoningTokens, 4900, 'a reported reasoning count is KEPT (it was dropped before this change)');
  eq(Object.keys(kept).join(','), 'inputTokens,outputTokens,cachedReadTokens,cacheWriteTokens,reasoningTokens',
    '…as a fifth field appended to the four, in a fixed order');

  const anthropic = normalizeReportedUsage(FOUR);
  ok(anthropic !== null, 'a payload with NO reasoning field still normalises — Anthropic and Gemini emit none');
  ok(!('reasoningTokens' in anthropic),
    '…and the field is OMITTED rather than written as 0, so "not reported" stays distinct from "none"');

  for (const bad of [null, undefined, NaN, Infinity, -1, '4900', {}]) {
    const r = normalizeReportedUsage({ ...FOUR, reasoningTokens: bad });
    ok(r !== null, `a malformed reasoningTokens (${JSON.stringify(bad)}) does NOT destroy the usage record`);
    ok(!('reasoningTokens' in r), '…it is simply omitted');
  }
  eq(normalizeReportedUsage({ ...FOUR, reasoningTokens: 0 }).reasoningTokens, 0,
    'a reported ZERO is a report and is kept — the renderer decides what to print');

  // The four required fields keep their all-or-nothing rule.
  ok(normalizeReportedUsage({ inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, reasoningTokens: 5 }) === null,
    'CONTROL: a MISSING required field still refuses the whole record — reasoning did not loosen that');
  ok(normalizeReportedUsage({ inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 7 }) === null,
    'CONTROL: the {0,0,0,0} "provider told us nothing" sentinel is still refused');

  // The stale comment this change also corrected: the caps had tripled and the
  // comment beside them still quoted the old three.
  ok(!/concise 4096 \/ balanced 8192 \/ comprehensive 12288/.test(brainSrc),
    'the stale "concise 4096 / balanced 8192 / comprehensive 12288" comment is gone');
  for (const n of ['12288', '16384', '20480']) {
    ok(new RegExp('maxTokens: ' + n).test(brainSrc), `CONTROL: RESPONSE_STYLES really does carry ${n}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  The breakdown names the hidden reasoning, and the scope');
// ═══════════════════════════════════════════════════════════════════════════
{
  const view = new Function('escapeHtml', 'formatUsdHonest', 'icon', 'resolveChatModel',
    extractFunction(chatSrc, 'messageUsageTokens', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'cacheMultipliers', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'messageCostUsd', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'costMarkHtml', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'assistantCostHtml', 'chat.js') + '\n' +
    'return { messageUsageTokens, assistantCostHtml };')(
    (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    (n) => '$' + n.toFixed(2),
    iconStub,
    // One priced model, resolved the way the real catalogue would.
    (id) => (id === 'anthropic/claude-sonnet-5' ? { entry: { id, label: 'Sonnet 5', input: 2, output: 10 } } : null),
  );
  const { messageUsageTokens, assistantCostHtml } = view;
  const MSG = (usage) => ({ role: 'assistant', content: 'a', model: 'anthropic/claude-sonnet-5', usage });
  const panelText = (h) => {
    const i = h.indexOf('class="chat-cost-panel"');
    return h.slice(h.indexOf('>', i) + 1, h.indexOf('</div>', i));
  };

  // The gate first: the view must carry the field through, or nothing below
  // can be rendered.
  eq(messageUsageTokens(MSG({ inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 9 })).reasoningTokens,
    9, 'messageUsageTokens carries reasoningTokens through to the renderer');
  ok(!('reasoningTokens' in messageUsageTokens(MSG({ inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cacheWriteTokens: 0 }))),
    '…and omits it when the provider reported none');

  // THE REPORTED NUMBERS.
  const withReasoning = assistantCostHtml(
    MSG({ inputTokens: 19250, outputTokens: 6150, cachedReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 4900 }), {}, 0);
  const text = panelText(withReasoning);
  // v3.72.0 (truth audit F2): a message with no recorded `priced` is priced
  // at TODAY's catalogue, and the breakdown says so in its last sentence.
  eq(text, 'This answer: 19,250 in / 6,150 out tokens, of which 4,900 reasoning the model did not show' + TODAY,
    'the breakdown states the hidden reasoning that doubles the bill');
  ok(text.startsWith('This answer:'),
    '…and names the SCOPE, because a later turn costs more only by re-sending the earlier ones');
  ok(withReasoning.includes('title="This answer: 19,250 in / 6,150 out tokens, of which 4,900 reasoning the model did not show' + TODAY + '"'),
    'the tooltip on the focusable control is the SAME string — one variable, so they cannot disagree');

  const noReasoning = panelText(assistantCostHtml(
    MSG({ inputTokens: 998, outputTokens: 247, cachedReadTokens: 0, cacheWriteTokens: 0 }), {}, 0));
  eq(noReasoning, 'This answer: 998 in / 247 out tokens' + TODAY,
    'a provider that reports no reasoning gets no reasoning clause');
  ok(!/reasoning/.test(noReasoning),
    '…and is never told "0 reasoning", which would be a claim the app cannot make');
  eq(panelText(assistantCostHtml(
    MSG({ inputTokens: 998, outputTokens: 247, cachedReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }), {}, 0)),
    'This answer: 998 in / 247 out tokens' + TODAY,
    'a reported ZERO prints nothing either — there is nothing hidden to disclose');

  // The cache clauses are unchanged and still conditional.
  eq(panelText(assistantCostHtml(
    MSG({ inputTokens: 1000, outputTokens: 200, cachedReadTokens: 512, cacheWriteTokens: 64, reasoningTokens: 100 }), {}, 0)),
    'This answer: 1,000 in / 200 out / 512 cached / 64 cache write tokens, of which 100 reasoning the model did not show' + TODAY,
    'cached and cache-write clauses still appear, before the reasoning clause');

  // The figure itself is untouched by any of this.
  ok(/>\$0\.06</.test(withReasoning) || /\$\d/.test(withReasoning),
    'CONTROL: the dollar figure is still rendered — the breakdown was widened, not the price');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8  Gemini reports a count; Anthropic does not, and says so');
// ═══════════════════════════════════════════════════════════════════════════
/* The disclosure has to cover the case that prompted it, and that case is
   Sonnet 5 on Anthropic — where there is no count to show. Two halves:
   §8a  Gemini's `thoughtsTokenCount` is surfaced ADDITIVELY, proven by
        executing the real normalizer over one payload with and without it and
        requiring the four BILLED fields, and the price computed from them, to
        be byte-identical — and by running the REAL ingest accumulator over
        both and requiring its totals not to move.
   §8b  On Anthropic the clause is stated WITHOUT a number, gated on llm.js's
        MEASURED per-model `thinks` flag rather than a hand-written list. */
{
  const llmSrc = readFileSync(path.join(ROOT, 'src/brain/llm.js'), 'utf8');
  const ingestSrc = readFileSync(path.join(ROOT, 'src/brain/ingest.js'), 'utf8');
  const norm = new Function(
    extractFunction(llmSrc, 'normalizeGeminiUsage', 'llm.js') + '\n' +
    extractFunction(llmSrc, 'normalizeAnthropicUsage', 'llm.js') + '\n' +
    'return { normalizeGeminiUsage, normalizeAnthropicUsage };')();

  const BASE = { promptTokenCount: 19250, candidatesTokenCount: 6150, cachedContentTokenCount: 512 };
  const without = norm.normalizeGeminiUsage(BASE);
  const with_ = norm.normalizeGeminiUsage({ ...BASE, thoughtsTokenCount: 4900 });

  eq(with_.reasoningTokens, 4900, '§8a Gemini\'s thoughtsTokenCount is surfaced as reasoningTokens');
  eq(without.reasoningTokens, 0, '§8a …and is 0 when the call did no thinking (Gemini genuinely reports none)');

  // ADDITIVE — the four BILLED fields, byte-identical either way.
  const billed = (x) => JSON.stringify([x.inputTokens, x.outputTokens, x.cachedReadTokens, x.cacheWriteTokens]);
  eq(billed(with_), billed(without),
    '§8a the four billed counts are byte-identical with and without thoughtsTokenCount');
  eq(billed(with_), JSON.stringify([18738, 6150, 512, 0]),
    '§8a CONTROL: …and they are the values the pre-existing arithmetic produced (input still has cached subtracted)');
  // The priced cost, from those four, cannot move either.
  const price = (x) => (x.inputTokens / 1e6) * 0.10 + (x.outputTokens / 1e6) * 0.40 +
    (x.cachedReadTokens / 1e6) * 0.01 + (x.cacheWriteTokens / 1e6) * 0.125;
  eq(price(with_), price(without), '§8a the cost computed from them is unchanged to the last digit');

  // THE REAL INGEST ACCUMULATOR. `accumulateUsage` in src/brain/ingest.js is
  // where a per-call usage payload becomes a running spend total; if a fifth
  // key could move that, this change would be a money change.
  const accSrc = /totals\.calls\+\+;[\s\S]{0,400}?cacheWriteTokens\s*\+=[^\n]*\n/.exec(ingestSrc);
  ok(!!accSrc, '§8a CONTROL: the real accumulator body was found in src/brain/ingest.js');
  const runTotals = (usage) => {
    const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0 };
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    new Function('totals', 'r', 'num', accSrc[0])(totals, usage, num);
    return JSON.stringify(totals);
  };
  eq(runTotals(with_), runTotals(without),
    '§8a the REAL ingest accumulator produces identical totals from both payloads');
  ok(!/reasoningTokens/.test(accSrc[0]),
    '§8a …because it sums four NAMED fields and never spreads the object');

  // ANTHROPIC emits no such field at all.
  const anth = norm.normalizeAnthropicUsage({ input_tokens: 19250, output_tokens: 6150 });
  ok(!('reasoningTokens' in anth),
    '§8b the Anthropic normalizer emits NO reasoning field — the API reports none');
  // COMMENT-STRIPPED, because the function's OWN prose explains why it does not
  // emit `reasoningTokens: 0` — and a raw scan is satisfied by that explanation,
  // the exact shape v3.54.0 records (`test-next-sharedbrain-admin.js` asserted
  // over raw text and was satisfied by a comment recording a deletion).
  ok(!/reasoningTokens:\s*0/.test(stripJsComments(extractFunction(llmSrc, 'normalizeAnthropicUsage', 'llm.js'))),
    '§8b …and specifically does not fake one as 0, which would print "0 reasoning" over an answer that reasoned');
  ok(/reasoningTokens: 0/.test(extractFunction(llmSrc, 'normalizeAnthropicUsage', 'llm.js')),
    '§8b CONTROL: the stripper is doing work — that string IS present, in the comment that explains the decision');

  // ── §8b — THE WORDED CLAUSE, gated on the MEASURED flag ────────────────
  const view = new Function('escapeHtml', 'formatUsdHonest', 'icon', 'resolveChatModel',
    extractFunction(chatSrc, 'messageUsageTokens', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'cacheMultipliers', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'messageCostUsd', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'costMarkHtml', 'chat.js') + '\n' +
    extractFunction(chatSrc, 'assistantCostHtml', 'chat.js') + '\n' +
    'return { assistantCostHtml };')(
    (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    (n) => '$' + n.toFixed(2), iconStub,
    // The measured table, in miniature: one model that thinks and one that does
    // not, exactly as llm.js records them — sonnet-5 thinks 7/7, opus-5 thinks
    // 0/3, one release apart. A hand-written "Sonnet 5 / Opus 5" list would be
    // wrong about the second, which is why the gate reads the flag.
    (id) => ({
      'claude-sonnet-5': { entry: { id, label: 'Sonnet 5', input: 2, output: 10, thinks: true } },
      'claude-opus-5': { entry: { id, label: 'Opus 5', input: 5, output: 25, thinks: false } },
      'claude-haiku-4-5': { entry: { id, label: 'Haiku 4.5', input: 1, output: 5, thinks: false } },
    }[id] || null),
  );
  // The panel body is HTML SOURCE — `costMarkHtml` escapes the title, so an
  // apostrophe is `&#39;` on the way in and an apostrophe on the screen. These
  // assertions are about what a reader SEES, so the entities are decoded back.
  const panelText = (h) => {
    const i = h.indexOf('class="chat-cost-panel"');
    return h.slice(h.indexOf('>', i) + 1, h.indexOf('</div>', i))
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  };
  const ANTH = { inputTokens: 19250, outputTokens: 6150, cachedReadTokens: 0, cacheWriteTokens: 0 };
  const say = (model, usage) => panelText(view.assistantCostHtml(
    { role: 'assistant', content: 'a', model, usage }, {}, 0));

  const NOTE = '. "Out" includes the model\'s hidden reasoning; this provider does not report how much';
  eq(say('claude-sonnet-5', ANTH), 'This answer: 19,250 in / 6,150 out tokens' + NOTE + TODAY,
    '§8b a THINKING model with no reported count states the fact without a number');
  eq(say('claude-opus-5', ANTH), 'This answer: 19,250 in / 6,150 out tokens' + TODAY,
    '§8b a model measured NOT to reason by default gets nothing extra — and opus-5 is exactly that model, released AFTER sonnet-5');
  eq(say('claude-haiku-4-5', ANTH), 'This answer: 19,250 in / 6,150 out tokens' + TODAY,
    '§8b …nor does the cheap default');
  ok(!/\b0\b.*reasoning/.test(say('claude-sonnet-5', ANTH)),
    '§8b the note carries NO number — inventing one would be worse than the silence it replaces');

  // A REPORTED count wins: the day a provider starts reporting one, the number
  // replaces the apology with no second edit.
  eq(say('claude-sonnet-5', { ...ANTH, reasoningTokens: 4900 }),
    'This answer: 19,250 in / 6,150 out tokens, of which 4,900 reasoning the model did not show' + TODAY,
    '§8b a reported count REPLACES the worded note rather than joining it');
  ok(!say('claude-sonnet-5', { ...ANTH, reasoningTokens: 4900 }).includes('does not report'),
    '§8b …so the app never says "we do not know" beside a figure it does know');
  /* WHAT ENFORCES THAT, stated rather than assumed: the TERNARY, not the
     `!u.reasoningTokens` term in `unreportedReasoning`. Deleting that term
     leaves this section green (measured); flattening the ternary into a
     concatenation reds the assertion above. The term is defence in depth and
     is recorded as such beside the code. */

  // An unknown model resolves to no entry, so there is no measured flag to read
  // — and, as it happens, no price either, so the whole cost fragment is
  // withheld (pre-existing behaviour, asserted here so the gate cannot be
  // blamed for it later). Either way NO claim about reasoning is made: absence
  // of a flag is not a measurement.
  eq(view.assistantCostHtml({ role: 'assistant', content: 'a', model: 'zz-not-in-the-catalogue', usage: ANTH }, {}, 0), '',
    '§8b an unresolvable model renders no cost fragment at all, so it makes no claim about reasoning either');

  // ONE SOURCE. The gate must read the flag, never a list of model ids.
  const costSrc = extractFunction(chatSrc, 'assistantCostHtml', 'chat.js');
  ok(/thinks === true/.test(costSrc),
    '§8b the gate reads the measured `thinks` flag');
  ok(!/sonnet-5|opus-5|claude-[a-z0-9-]+/.test(stripJsComments(costSrc)),
    '§8b …and its CODE names no model id at all, so it cannot drift from llm.js');
  ok(/claude-opus-5/.test(costSrc),
    '§8b CONTROL: the stripper is doing work here too — the comment DOES name the model whose flag would make a hand-written list wrong');
  ok(/thinks: spec\.thinks/.test(llmSrc) && /thinks: entry && typeof entry\.thinks === 'boolean'/
      .test(readFileSync(path.join(ROOT, 'src/routes/config.js'), 'utf8')),
    '§8b CONTROL: that flag really does travel from llm.js\'s model table to the browser');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ All chat copy-control and cost-breakdown assertions green');
process.exit(0);
