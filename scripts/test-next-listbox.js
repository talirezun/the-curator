/**
 * test-next-listbox.js — OFFLINE guard on next/shared/listbox.js, the ONE
 * dropdown surface in /next, and on the six adoptions of it.
 *
 * ── Why this component exists ────────────────────────────────────────────
 *
 * Six controls were native <select>s with `appearance: none` and a CSS-drawn
 * chevron. That got the CLOSED control on-design and could never reach the
 * OPEN one: the popup a <select> paints is an OS surface, outside the
 * document, and no stylesheet in this repo can reach it. THREE view
 * stylesheets said exactly that in a comment and left it there.
 *
 * Owning the open menu means giving up what the platform control did for
 * free, and OWING IT BACK. That debt is what most of this suite is about.
 *
 * ── ENFORCED HERE (offline) ──────────────────────────────────────────────
 *
 *   • The RENDER half is EXECUTED, not read: renderListboxHtml and its
 *     helpers are brace-matched out of the live source and driven, so the
 *     escaping and ARIA assertions observe real output.
 *   • The ADOPTIONS: all six call sites, one shared component, no <select>
 *     left anywhere under src/public/next/views/.
 *   • The render -> wire handoff: markup and behaviour come from ONE cfg
 *     object per control, never two literals that can drift.
 *   • The BEHAVIOURAL contract of mountListbox is source-scanned, clause by
 *     clause, with each assertion naming the behaviour rather than the
 *     string it happens to match.
 *
 * ── NOT ENFORCED (stated rather than implied away) ───────────────────────
 *
 *   • mountListbox is NOT executed here. It needs a DOM, and importing the
 *     module in Node fails outright ("document is not defined") because it
 *     imports next/app.js, which touches document at module scope. Every
 *     keyboard, focus, positioning and disabled behaviour was verified with
 *     REAL trusted key events in a browser instead; §4 is a source scan that
 *     can only catch a clause being DELETED, not one being subtly broken.
 *   • Nothing here measures contrast, layout, flip-up, or that the menu is
 *     unclipped. Those were browser-measured. A Node suite asserting them
 *     would be measuring a paraphrase.
 *   • The chat composer's own dropdowns are NOT adopted yet and are
 *     deliberately excluded from §5's sweep — see the comment there. That is
 *     a recorded gap, not an oversight.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const NEXT = path.join(ROOT, 'src/public/next');

const lbJs = readFileSync(path.join(NEXT, 'shared/listbox.js'), 'utf8');
const lbCss = readFileSync(path.join(NEXT, 'shared/listbox.css'), 'utf8');
const appJs = readFileSync(path.join(NEXT, 'app.js'), 'utf8');
const indexHtml = readFileSync(path.join(NEXT, 'index.html'), 'utf8');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; failures.push(label); console.log('  ✗ ' + label); }
}
function section(t) { console.log('\n' + t); }

/** Brace-matched extraction of a real function from live source. Throws
 *  loudly on a desync rather than producing a confusing SyntaxError later.
 *  (Same helper as scripts/test-next-memory-view.js.) */
function extractFunction(src, name, where) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in ${where}`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start), parenDepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parenDepth++;
    else if (src[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced in ${where}`);
  return out;
}

/**
 * Comments stripped, so a source scan cannot be satisfied by PROSE.
 *
 * MEASURED, twice, in this repo: §5 below records that deleting a real
 * `closeAllListboxes()` call left a bare scan green because a comment two lines
 * above mentioned it. Every scan in §4 that is about CODE now reads `lbCode`;
 * the ones that are deliberately about the recorded REASONING still read the
 * raw source, and say so.
 *
 * `[^:]` in front of `//` keeps a `https://` inside a string intact — an
 * over-strip there would only ever cost a false red, which is the safe error.
 */
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const lbCode = stripJsComments(lbJs);

/**
 * Brace-match a NESTED function (one declared inside `mountListbox`, so it is
 * indented and the line-anchored `extractFunction` above cannot see it).
 *
 * Exists because a file-wide regex is not a scope. Proven necessary by
 * mutation: `if (state.trigger.disabled) return;` appears IDENTICALLY in
 * `open()` and in `onKeyDown()`, so deleting it from open() — the refusal that
 * stops a programmatic `api.open()` on a disabled control — left the suite
 * GREEN, satisfied by the other function's copy. The same file-wide-versus-
 * function-scoped shape was already fixed in this section for `position();`
 * and not for this.
 */
function nestedFunctionBody(src, decl, where) {
  const at = src.indexOf(decl);
  if (at === -1) throw new Error(`nestedFunctionBody: "${decl}" not found in ${where} — the anchor has moved`);
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`nestedFunctionBody: "${decl}" desynced in ${where}`);
  return src.slice(at, end);
}

// ═══════════════════════════════════════════════════════════════════════
section('§1  The render half, EXECUTED — not read');

// The REAL escapeHtml from app.js, lifted rather than reimplemented, so a
// change there cannot leave this suite testing a copy that no longer matches.
const escapeHtml = new Function(extractFunction(appJs, 'escapeHtml', 'app.js') + '\nreturn escapeHtml;')();
ok(escapeHtml('<a>&"') === '&lt;a&gt;&amp;&quot;', 'the real escapeHtml was lifted and works');

const render = new Function('escapeHtml', 'icon',
  extractFunction(lbJs, 'normaliseOptions', 'listbox.js') + '\n' +
  extractFunction(lbJs, 'findOption', 'listbox.js') + '\n' +
  extractFunction(lbJs, 'triggerLabelFor', 'listbox.js') + '\n' +
  extractFunction(lbJs, 'renderListboxHtml', 'listbox.js') + '\n' +
  extractFunction(lbJs, 'optionRowHtml', 'listbox.js') + '\n' +
  extractFunction(lbJs, 'menuHtml', 'listbox.js') + '\n' +
  'return { renderListboxHtml, menuHtml, normaliseOptions };'
)(escapeHtml, (n, s) => '<svg data-icon="' + n + '" width="' + s + '"></svg>');

const OPTS = [
  { value: 'articles', label: 'Articles' },
  { value: 'business', label: 'Business', detail: '3 min ago' },
  { value: 'research', label: 'Research', disabled: true },
];
const trigger = render.renderListboxHtml({ id: 'zz', ariaLabel: 'Domain', value: 'business', options: OPTS });
const menu = render.menuHtml('zz', render.normaliseOptions(OPTS), 'business', '');

ok(/<button[^>]*type="button"/.test(trigger), 'the trigger is a <button> — so `disabled` is a real, platform-enforced state');
ok(/id="zz"/.test(trigger), 'and carries the caller-supplied id');
ok(/>Business</.test(trigger), 'the closed control shows the SELECTED option\'s label, not the first one');

// ═══════════════════════════════════════════════════════════════════════
section('§2  The ARIA contract — the debt owed for dropping the native control');

ok(/role="combobox"/.test(trigger),
  'the trigger is role=combobox (APG select-only combobox) — the pattern that ' +
  'lets focus STAY on the trigger, which is why "focus returns to the trigger ' +
  'on close" is structural here rather than a thing to remember');
ok(/aria-haspopup="listbox"/.test(trigger), 'aria-haspopup=listbox');
ok(/aria-expanded="false"/.test(trigger), 'aria-expanded starts false');
ok(/aria-controls="zz-menu"/.test(trigger), 'aria-controls names the menu it opens');
ok(/aria-label="Domain"/.test(trigger), 'and the control has a real accessible NAME — a <label> cannot label a button');
ok(/setAttribute\('role', 'listbox'\)/.test(lbJs),
  'the menu is given role=listbox when it is created');
ok((menu.match(/role="option"/g) || []).length === 3, 'every row is role=option');
ok(/aria-selected="true"[^>]*data-lb-value="business"|data-lb-value="business"[^>]*aria-selected="true"/.test(menu) ||
   /id="zz-opt-1"[\s\S]{0,120}aria-selected="true"/.test(menu),
  'the selected row carries aria-selected=true');
ok((menu.match(/aria-selected="false"/g) || []).length === 2, 'and the others carry an explicit false');
ok(/aria-disabled="true"/.test(menu), 'a disabled option is announced as disabled, not merely dimmed');
ok(/id="zz-opt-0"/.test(menu) && /id="zz-opt-2"/.test(menu),
  'every row has a stable id — which is what aria-activedescendant points AT');
ok(/setAttribute\('aria-activedescendant', el\.id\)/.test(lbJs),
  'and the trigger publishes the active row via aria-activedescendant');
ok(/removeAttribute\('aria-activedescendant'\)/.test(lbJs),
  'cleared on close — a stale activedescendant points a screen reader at a node that no longer exists');

// A group heading must NOT be an option, or arrow navigation and type-ahead
// would land on it. Structural, so it cannot be forgotten by a filter.
const grouped = render.menuHtml('zz', render.normaliseOptions([
  { value: 'a', label: 'A', group: 'Gemini' }, { value: 'b', label: 'B', group: 'Anthropic' },
]), 'a', '');
ok((grouped.match(/class="lb-group"/g) || []).length === 2, 'group headings render');
// COUNTED, not pattern-matched around the class name. Proven necessary by
// mutation: an earlier version tested /lb-group[^>]*role="option"/ and a
// mutation that put `role` BEFORE the class attribute left it 88/0 GREEN —
// a guard that was only order-sensitive, chased rather than filed.
ok((grouped.match(/role="option"/g) || []).length === 2,
  'exactly TWO role=option in a 2-option 2-group menu — a group heading is ' +
  'NOT an option, so arrow keys and type-ahead skip it BY CONSTRUCTION rather ' +
  'than by a filter a later edit can drop');

// ═══════════════════════════════════════════════════════════════════════
section('§3  Escaping — every interpolated value, through the REAL renderer');

const XSS = '<img src=x onerror=alert(1)>';
const ATTR = '" onmouseover="alert(1)';
const hostile = render.renderListboxHtml({
  id: ATTR, ariaLabel: XSS, value: XSS, triggerClass: ATTR, rootClass: ATTR,
  options: [{ value: XSS, label: ATTR, detail: XSS, group: XSS }],
});
const hostileMenu = render.menuHtml('zz', render.normaliseOptions([
  { value: XSS, label: ATTR, detail: XSS, group: XSS },
]), XSS, '');
for (const [name, html] of [['trigger', hostile], ['menu', hostileMenu]]) {
  ok(!html.includes('<img src=x'), `${name}: a hostile value cannot inject a tag`);
  // PRECISE, and deliberately not a blunt /\son\w+=/ scan: the component's own
  // markup legitimately contains attribute names, and an over-broad regex
  // matched them and reported a false positive on correctly-escaped output —
  // the v3.13.0 lesson (an XSS check that gave a FALSE POSITIVE because
  // `[^>]*` walked straight through `&gt;`). What matters is that the hostile
  // payload survives ONLY in escaped form.
  ok(!html.includes('" onmouseover='), `${name}: the attribute-breakout payload never appears unescaped`);
  ok(html.includes('&quot; onmouseover=') || !html.includes('onmouseover='),
    `${name}: …and where it appears at all, it appears escaped`);
  ok(!/"\s+onmouseover=/.test(html), `${name}: nor break out of an attribute`);
}
// `html` is the ONE escape hatch, and it is documented as caller-owned.
const raw = render.menuHtml('zz', render.normaliseOptions([
  { value: 'a', label: 'A', html: '<span class="badge">caution</span>' },
]), 'a', '');
ok(raw.includes('<span class="badge">caution</span>'),
  'an option\'s `html` is passed through VERBATIM — the escape hatch that lets ' +
  'a caller own a rich row (badges, prices, notes) while this component still ' +
  'owns the row ELEMENT and therefore all of the keyboard and ARIA behaviour');
ok(/`html` lets a caller own the whole row body/.test(lbJs),
  '…and the source SAYS the caller owns escaping there, rather than leaving it to be discovered');

// ═══════════════════════════════════════════════════════════════════════
section('§4  The behavioural contract (SOURCE SCAN — see NOT ENFORCED in the header)');

const KEYBOARD = [
  ["case 'ArrowDown'", 'ArrowDown — opens when closed, moves down when open'],
  ["case 'ArrowUp'", 'ArrowUp'],
  ["case 'PageDown'", 'PageDown — pages down, the way the native popup does'],
  ["case 'PageUp'", 'PageUp'],
  ["case 'Home'", 'Home — first enabled option'],
  ["case 'End'", 'End — last enabled option'],
  ["case 'Enter'", 'Enter — commits the active option'],
  ["case 'Escape'", 'Escape'],
  ["case 'Tab'", 'Tab — closes and lets focus move on'],
];
for (const [needle, label] of KEYBOARD) ok(lbJs.includes(needle), label);

ok(/function typeAhead\(/.test(lbJs) && /startsWith\(q\)/.test(lbJs),
  'TYPE-AHEAD exists and matches on a PREFIX — the behaviour that makes a ' +
  '193-row model list navigable at all');
ok(/const repeat = state\.typeBuf\.length === 1 && state\.typeBuf === ch/.test(lbJs),
  'a repeated single character CYCLES through matches rather than re-selecting the same one');
ok(/TYPEAHEAD_MS = 800/.test(lbJs), 'with a buffer that expires, so a later search starts fresh');

// ── PAGING, and the fact that a page is MEASURED rather than guessed ────
// The component shipped with no case for either key: on the 193-row model list
// the only way down was 193 presses of ArrowDown. Verified with REAL key
// events in a browser before the fix — `aria-activedescendant` did not move —
// and again after.
{
  const kd = nestedFunctionBody(lbCode, 'function onKeyDown(e) {', 'listbox.js');
  ok(/case 'PageDown':[\s\S]{0,160}move\(pageStep\(\)\)/.test(kd),
    'PageDown moves by a PAGE, from inside onKeyDown — not merely a `case` label ' +
    'somewhere in the file');
  ok(/case 'PageUp':[\s\S]{0,160}move\(-pageStep\(\)\)/.test(kd),
    '…and PageUp moves the other way');
  ok(/case 'PageDown':\s*\n\s*if \(!isOpen\) return;/.test(kd) &&
     /case 'PageUp':\s*\n\s*if \(!isOpen\) return;/.test(kd),
    'both act ONLY while open, exactly like Home/End — and without preventDefault ' +
    'when closed, so a closed trigger does not swallow the page scroll the user ' +
    'was asking the document for');
  const step = nestedFunctionBody(lbCode, 'function pageStep() {', 'listbox.js');
  ok(/menu\.clientHeight/.test(step) && /offsetHeight/.test(step),
    'the page size is DERIVED from what is on screen (menu height / row height) — ' +
    'a hardcoded 10 would overshoot a short menu and crawl a tall one');
  ok(/Math\.max\(1,/.test(step), '…and can never be 0, which would make the key silently inert');
}

// Escape must CANCEL, and the cancel must be structural rather than a manual
// rollback that a later edit can get wrong.
const commitBody = extractFunction(lbJs, 'mountListbox', 'listbox.js');
ok(/state\.value = value;/.test(commitBody) &&
   (commitBody.match(/state\.value = /g) || []).length <= 2,
  'state.value is written in commit() (and setOptions) and NOWHERE ELSE — so ' +
  'Escape restores the previous value BY CONSTRUCTION: arrow keys move the ' +
  'ACTIVE row and can never move the selected one');
ok(/Tab means "I am done here", and a native menulist does not commit/.test(lbJs),
  'and Tab deliberately does not commit a merely-highlighted row, with the reason recorded');

// Disabled must be REAL.
ok(/\(disabled \? ' disabled' : ''\)/.test(lbJs),
  'the trigger emits the native `disabled` ATTRIBUTE — the browser refuses the ' +
  'click and drops it from the tab order');
// ── SCOPED TO open()'s OWN BODY ────────────────────────────────────────
// This assertion was `/if \(state\.trigger\.disabled\) return;/.test(lbJs)` —
// file-wide — and `onKeyDown` carries a byte-identical line. Proven by
// mutation: DELETING the refusal from open() left the suite GREEN, satisfied
// by a different function. A file-wide regex is not a function scope, and this
// section had already learned that once for `position();` two assertions below
// without the lesson being carried across.
//
// The production line stays: the trigger also emits the native `disabled`
// ATTRIBUTE, which is what actually refuses a pointer or keyboard interaction,
// so this is the guard on the PROGRAMMATIC path — `api.open()` is exported, and
// a caller reaching for it must not be able to open a menu the view has
// disabled (Ingest disables its picker for the duration of a submit). Stated as
// defence in depth rather than as the only barrier, which is what it is.
{
  const openBody = nestedFunctionBody(lbCode, 'function open() {', 'listbox.js');
  ok(/if \(state\.trigger\.disabled\) return;/.test(openBody),
    'open() ITSELF refuses on a disabled trigger — asserted inside open()\'s ' +
    'brace-matched body, not file-wide, because onKeyDown carries the identical line');
}

// The <body>-append trap and its cleanup.
ok(/document\.body\.appendChild\(menu\)/.test(lbJs), 'the menu is appended to <body>');
ok(/containing block for every `position: fixed` DESCENDANT/.test(lbJs),
  'and the TRANSFORM TRAP is recorded in the component — #view-root is ' +
  'transformed by the view-enter animation, and v3.10.0 measured a fixed probe ' +
  'moving 340px through exactly that');
ok(/if \(!document\.contains\(state\.trigger\)\) \{ close\(/.test(lbJs),
  'a menu whose trigger has been repainted away CLOSES ITSELF — the leak a ' +
  'body-appended menu invites, and the one settings.js\'s wholesale innerHTML ' +
  'repaint would otherwise cause every render');
ok(/cancelAnimationFrame\(state\.raf\)/.test(lbJs), 'closing cancels the rAF loop');
ok(/removeEventListener\('pointerdown', onDocPointer, true\)/.test(lbJs),
  'and removes the document listener — a leaked one of either is the whole ' +
  'reason a body-appended menu is riskier than an in-flow one');
ok(/state\.raf = requestAnimationFrame\(tick\)/.test(lbJs) &&
   (lbJs.match(/requestAnimationFrame\(tick\)/g) || []).length === 2,
  'the loop is armed on open and re-armed only from inside itself — it cannot run while closed');

// Four defects found by driving it in a browser, each now carrying its measurement.
ok(/const keepScroll = state\.menu\.scrollTop;/.test(lbJs) &&
   /state\.menu\.scrollTop = keepScroll;/.test(lbJs),
  'position() SAVES AND RESTORES scrollTop around lifting the max-height cap — ' +
  'measured: without it the rAF loop\'s next reposition snapped a 193-row menu ' +
  'back to the top, one frame after it had correctly opened on the selection');
ok(/function scrollRowIntoView\(/.test(lbJs) && !/scrollIntoView\(\{ block: 'nearest' \}\)/.test(lbJs),
  'the active row is scrolled into view ARITHMETICALLY, not via scrollIntoView — ' +
  'measured: at open() time scrollIntoView did nothing and the menu opened with ' +
  'the selected row 6,514px above the fold');
// SCOPED TO open()'s OWN BODY. Proven necessary by mutation: an earlier
// version compared indexOf() over the WHOLE file, and `position();` also
// appears in tick() and setOptions() — so deleting the call from open()
// entirely left it 89/0 GREEN. A file-wide indexOf is not an ordering guard.
{
  // COMMENTS STRIPPED (`lbCode`): open()'s body carries a paragraph about why
  // `position()` runs first, and it contains the literal `position();` — so an
  // ordering check over the RAW body could be satisfied by the prose explaining
  // the ordering rather than by the ordering.
  const openBody = nestedFunctionBody(lbCode, 'function open() {', 'listbox.js');
  ok(openBody.length > 200,
    'open() was located and brace-matched (a desync here would make the three ' +
    'ordering assertions below vacuous rather than red)');
  const pos = openBody.indexOf('position();');
  const act = openBody.indexOf('setActive(');
  ok(pos >= 0, 'open() positions the menu');
  ok(act >= 0, 'open() sets an initial active row');
  ok(pos >= 0 && act >= 0 && pos < act,
    'and position() runs BEFORE that first setActive — until the menu is sized ' +
    'and placed there is nothing to scroll within, and the measured consequence ' +
    'was a 193-row menu opening with the selected row 6,514px above the fold');
}
// The CALL SITE, not merely the declaration. Proven necessary by mutation:
// deleting the call left the function defined-and-unused and this suite
// stayed 88/0 GREEN — a decorative guard, chased rather than filed.
ok(/cfg\.onChange\(value, opt\);\s*\n\s*restoreFocusAfterRerender\(\);/.test(lbJs) &&
   /function restoreFocusAfterRerender\(/.test(lbJs) &&
   /document\.activeElement !== document\.body/.test(lbJs),
  'focus is restored BY ID after a handler that repaints its own view — measured: ' +
  'committing with Enter left focus on <body>, the v3.17.1 finding-8 shape; and ' +
  'it is GATED on focus having been lost, so a handler that deliberately moved ' +
  'focus is not overridden');

ok(/export function closeAllListboxes/.test(lbJs),
  'closeAllListboxes is exported for view teardowns — navigate() closes the ' +
  'reader but explicitly does NOT reach into view-owned popovers');

// ═══════════════════════════════════════════════════════════════════════
section('§5  The adoptions — ONE component, six call sites');

const VIEWS = path.join(NEXT, 'views');
const viewFiles = readdirSync(VIEWS).filter((f) => f.endsWith('.js'));
const ADOPTERS = ['memory.js', 'ingest.js', 'settings.js', 'chat.js'];

// A whole-tree walk, never a hardcoded file list: a hardcoded list is how a
// previous guard in this repo went blind (v3.9.2).
let selectOffenders = [];
for (const f of viewFiles) {
  const src = readFileSync(path.join(VIEWS, f), 'utf8');
  // chat.js WAS the one deliberate exclusion — its composer carried a
  // click-only menu with listbox roles and no keyboard support at all, recorded
  // here as a gap rather than swept under a passing assertion. It has now been
  // adopted (§5 counts it below), so there is no exclusion left in this walk.
  if (/<select/.test(src)) selectOffenders.push(f);
}
ok(selectOffenders.length === 0,
  'NO view under /next contains a <select>, in markup OR in a comment' +
  (selectOffenders.length ? ' — found: ' + selectOffenders.join(', ') : ''));

// chat.js: the composer's MODEL picker and its LENGTH picker.
const expectAdoptions = { 'memory.js': 2, 'ingest.js': 2, 'settings.js': 2, 'chat.js': 2 };
let total = 0;
for (const f of ADOPTERS) {
  const src = readFileSync(path.join(VIEWS, f), 'utf8');
  const n = (src.match(/renderListboxHtml\(/g) || []).length;
  total += n;
  ok(n === expectAdoptions[f], `${f}: ${expectAdoptions[f]} adoption(s) (found ${n})`);
  ok(/from '\.\.\/shared\/listbox\.js'/.test(src),
    `${f} imports the shared component — not a local copy of it`);
  // COMMENTS STRIPPED FIRST. Proven necessary by mutation: settings.js has a
  // comment mentioning `closeAllListboxes()` two lines above the real call,
  // so deleting the CALL left a bare source scan 89/0 GREEN. A guard that a
  // comment can satisfy is a guard about prose, not about code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ok((code.match(/closeAllListboxes\(\)/g) || []).length >= 1,
    `${f} closes any open menu on teardown/repaint (in CODE, not in a comment)`);
}
ok(total === 8, `EIGHT adoptions across four views (found ${total})`);

// The render -> wire handoff. This is the assertion that makes "one
// component" mean something: markup and behaviour must come from ONE object.
for (const f of ['memory.js', 'settings.js', 'chat.js']) {
  const src = readFileSync(path.join(VIEWS, f), 'utf8');
  ok(/const pendingListboxes = \[\]/.test(src),
    `${f} uses the render -> wire handoff array`);
  ok(/pendingListboxes\.length = 0/.test(src),
    `${f} clears it before rendering, so a branch that emits no picker leaves nothing to mount`);
  ok(/for \(const cfg of pendingListboxes\)[\s\S]{0,900}mountListbox\(cfg\)/.test(src),
    `${f} mounts from the SAME cfg objects the markup came from`);
}
{
  // chat.js: TWO builders, one per control, each used by BOTH halves. Same
  // property ingest.js is held to below, for the same reason — an inline second
  // cfg literal is the two-copies drift this component exists to remove, and on
  // this surface the two copies would be describing which model spends money.
  const src = readFileSync(path.join(VIEWS, 'chat.js'), 'utf8');
  ok(/function modelListboxCfg\(/.test(src) && /function lengthListboxCfg\(/.test(src),
    'chat.js has ONE cfg builder per composer picker');
  const lbCalls = src.match(/renderListboxHtml\([^)]*/g) || [];
  ok(lbCalls.length === 2
    && lbCalls.some(c => c.includes('cfg'))
    && lbCalls.every(c => !/\{/.test(c)),
    'BOTH renderListboxHtml calls pass a builder\'s output (a `cfg` binding), never an inline literal ' +
    '(found: ' + lbCalls.length + ' calls)');
  ok(/mountListbox\(cfg\)/.test(src),
    'and the wiring pass mounts from the SAME cfg objects the markup came from');
}
{
  const src = readFileSync(path.join(VIEWS, 'ingest.js'), 'utf8');
  ok(/function domainListboxCfg\(/.test(src),
    'ingest.js has ONE cfg builder for its two domain pickers — they previously ' +
    'carried two hand-written copies of the same <option> loop');
  // EVERY renderListboxHtml call in this view must pass the builder's OUTPUT.
  // Proven necessary by mutation: replacing ONE of the two with an inline cfg
  // literal — the exact two-copies drift this component exists to remove —
  // left a `>= 3` occurrence count GREEN. Chased rather than filed.
  const lbCalls = src.match(/renderListboxHtml\([^)]*/g) || [];
  ok(lbCalls.length === 2 && lbCalls.every((c) => c.includes('domainListboxCfg(')),
    'BOTH renderListboxHtml calls pass domainListboxCfg(...) — neither surface ' +
    'may carry an inline cfg literal, which is the two-copies drift this ' +
    'component exists to remove (found: ' + lbCalls.length + ' calls, ' +
    lbCalls.filter((c) => c.includes('domainListboxCfg(')).length + ' via the builder)');
  ok(/mountListbox\(domainListboxCfg\(\)\)/.test(src),
    '…and the wiring pass mounts from it too, so all three cannot drift');
}

// ═══════════════════════════════════════════════════════════════════════
section('§6  The stylesheet — reachable, tokenised, and owning the whole control');

ok(/href="\/next\/shared\/listbox\.css"/.test(indexHtml),
  'listbox.css is <link>ed from next/index.html, ROOT-ABSOLUTE — v3.9.1 shipped ' +
  'a shared stylesheet that existed, was correct, and was NEVER LINKED for a ' +
  'whole release, invisible to two separate guards');
const linkIdx = indexHtml.indexOf('href="/next/shared/listbox.css"');
const firstViewIdx = indexHtml.indexOf('href="/next/views/');
ok(linkIdx > 0 && firstViewIdx > 0 && linkIdx < firstViewIdx,
  'and linked ABOVE the views, so a view may still override placement at equal specificity');

ok(!/appearance:/.test(lbCss),
  'listbox.css declares `appearance` NOWHERE — there is no UA widget left to switch off');
ok(!/:\s*#[0-9a-f]{3,8}\b/i.test(lbCss.replace(/\/\*[\s\S]*?\*\//g, '')),
  'no hardcoded hex colour — every colour is a theme token, so both themes follow for free');
ok((lbCss.match(/var\(--/g) || []).length > 20, 'and it genuinely uses the token set');
ok(/position: fixed/.test(lbCss), 'the menu is fixed-positioned (placed by JS from the trigger rect)');
ok(/@media \(prefers-reduced-motion: reduce\)/.test(lbCss),
  'and it honours prefers-reduced-motion — the v3.9.2 lesson: a hardcoded ' +
  'transition that bypasses the tokens reaches a user who asked for no motion');
ok(/\.lb-btn:focus-visible/.test(lbCss), 'the trigger has a visible focus ring');
ok(/\.lb-btn:disabled/.test(lbCss), 'and a disabled look to match the real disabled state');
ok(/\.lb-opt\.is-active/.test(lbCss) && /\.lb-opt\.is-selected/.test(lbCss),
  'the KEYBOARD position and the COMMITTED value are styled separately — a user ' +
  'arrowing a long list must see both where they are and what is still selected');

// ═══════════════════════════════════════════════════════════════════════
section('§7  NEGATIVE CONTROLS — every detector above can actually fail');

ok(/<select/.test('<div><select class="x"></select></div>'),
  'the <select> detector fires on a document that contains one');
ok(!/<select/.test('<div><button role="combobox"></button></div>'),
  '…and does not fire on the shape that replaced it (no false positive)');
{
  const bad = render.renderListboxHtml({ id: 'zz', ariaLabel: 'X', value: 'a',
    options: [{ value: 'a', label: '<script>x</script>' }] });
  ok(!bad.includes('<script>'), 'control: the escaping assertions are measuring real output');
  ok(bad.includes('&lt;script&gt;'), '…and the escaped form is genuinely present, not merely absent');
}
{
  // A guard that cannot go red is worth nothing: prove the adoption counter
  // reacts to a fixture, not only to the shipped files.
  const fake = "renderListboxHtml({a:1}) renderListboxHtml({b:2}) renderListboxHtml({c:3})";
  ok((fake.match(/renderListboxHtml\(/g) || []).length === 3,
    'control: the adoption counter counts what is actually there');
}

{
  // The new FUNCTION-SCOPED detectors, proven to react to a body rather than
  // to the file. Without these, §4's scoping fix would be a claim rather than
  // a demonstrated property.
  const withGuard = 'function open() {\n  if (state.trigger.disabled) return;\n  position();\n}';
  const without   = 'function open() {\n  position();\n}\nfunction onKeyDown(e) {\n  if (state.trigger.disabled) return;\n}';
  ok(/if \(state\.trigger\.disabled\) return;/.test(nestedFunctionBody(withGuard, 'function open() {', 'fixture')),
    'control: the disabled detector fires on an open() that carries the refusal');
  ok(!/if \(state\.trigger\.disabled\) return;/.test(nestedFunctionBody(without, 'function open() {', 'fixture')),
    '…and does NOT fire on an open() without it, even when an IDENTICAL line sits in ' +
    'another function of the same source — the exact false pass the file-wide regex gave');
  let threw = false;
  try { nestedFunctionBody('nothing here', 'function open() {', 'fixture'); } catch { threw = true; }
  ok(threw, '…and a moved anchor THROWS rather than yielding an empty body every scan would pass');
}

// ═══════════════════════════════════════════════════════════════════════
section('§8  ACTION ROWS — a row that DOES something, not one that IS the value');
// ═══════════════════════════════════════════════════════════════════════
//
// The composer's model menu needs one row that is not a model: "Browse all 213
// models", which opens a search dialog. Without a first-class flag, `commit()`
// writes that sentinel into the control's value and stamps its label onto the
// trigger, and the caller's only recovery is to re-render afterwards to undo a
// label it never asked for — leaving the picker briefly claiming a model that
// does not exist, on the surface whose entire job is naming the model that will
// answer.
{
  const OPTS_A = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' },
    { value: ' browse', label: 'Browse all', action: true },
  ];
  // ── AN ACTION ROW IS DECLARED TWICE, AND THE cfg HAS THE SECOND SAY ────
  // MEASURED: adding `action: true` to Ingest's REAL domain-picker options
  // turned every domain row into an action row — selecting a domain fired
  // onChange and never became the value — and THREE suites stayed green over
  // it. So `action` is now a REQUEST that only takes effect for a value the
  // cfg also names in `actionValues`. The defect is not merely detectable on
  // the seven controls that declare none; it is inexpressible.
  const ACTION_VALUES = [' browse'];
  const norm = render.normaliseOptions(OPTS_A, ACTION_VALUES);
  ok(norm[0].action === false && norm[1].action === false,
    'an ordinary option is NOT an action — the seven other adoptions all take this path');
  ok(norm[2].action === true, 'and the flagged one is, because the cfg names its value');
  ok(render.normaliseOptions([{ value: 'x', label: 'X', action: 'yes' }], ['x'])[0].action === false,
    'only a literal `true` counts — a truthy string does not silently make a row an action');
  ok(render.normaliseOptions(OPTS_A)[2].action === false,
    'THE GATE: `action: true` with NO actionValues is inert — a caller that has not ' +
    'said which row is an action gets ordinary rows, never a menu whose every row ' +
    'silently declines to be chosen');
  ok(render.normaliseOptions(OPTS_A, ['something-else'])[2].action === false,
    '…and it is per-VALUE, so marking a MODEL as an action inside a control that ' +
    'does have one action row is inert too');
  ok(render.normaliseOptions(OPTS_A, new Set([' browse']))[2].action === true,
    'a Set is accepted as well as an array');
  for (const junk of [null, undefined, 'browse', 42, {}, [7, null]]) {
    ok(render.normaliseOptions(OPTS_A, junk)[2].action === false,
      `a malformed actionValues (${JSON.stringify(junk)}) grants nothing — the fail-safe direction`);
  }

  const m = render.menuHtml('zz', norm, 'a', '');
  ok(!/data-lb-action/.test(render.menuHtml('zz', render.normaliseOptions(OPTS_A), 'a', '')),
    '…and an ungranted action row reaches the MARKUP as an ordinary row too');
  ok(/data-lb-action="1"/.test(m), 'an action row is marked in the MARKUP');
  ok((m.match(/data-lb-action/g) || []).length === 1, '…on exactly the one row that carries the flag');
  ok(/class="lb-opt is-action"/.test(m), '…and carries a class, so a caller can style it without :has()');
  // It must never look SELECTED. `aria-selected="true"` on a row that is not the
  // value would tell a screen reader the control holds something it does not.
  const actionRow = m.slice(m.indexOf('data-lb-action'));
  ok(/aria-selected="false"/.test(m.slice(m.lastIndexOf('<div', m.indexOf('data-lb-action')))),
    'an action row is never aria-selected');
  ok(!/is-selected/.test(actionRow.slice(0, actionRow.indexOf('</div>'))),
    '…and never carries the selected class');

  // ── THE BEHAVIOUR, from the REAL commit() ────────────────────────────
  // Extracted and driven, not read: this is the branch that must NOT write the
  // control's value.
  // `commit` is NESTED inside `mountListbox`, so it is indented and the
  // file-level extractor (anchored at a line start) cannot see it. Brace-matched
  // locally rather than by loosening that extractor: an anchor that also matched
  // indented declarations would start matching object-literal methods and
  // nested helpers across every other suite that shares this technique.
  const commitSrc = (() => {
    const at = lbJs.indexOf('function commit(value) {');
    if (at === -1) throw new Error('§8: listbox.js commit() not found — the extraction anchor has moved');
    let i = lbJs.indexOf('{', at), depth = 0;
    for (; i < lbJs.length; i++) {
      if (lbJs[i] === '{') depth++;
      else if (lbJs[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const out = lbJs.slice(at, i);
    if (!/\n  \}$/.test(out)) throw new Error('§8: commit() extraction desynced');
    return out;
  })();
  const runCommit = new Function('opts', 'startValue', 'onChange', 'sink',
    'const state = { options: opts, value: startValue, trigger: { querySelector: () => null, classList: { remove(){}, add(){} } } };\n' +
    'const cfg = { onChange };\n' +
    'function findOption(list, v) { for (const o of list) if (o.value === v) return o; return null; }\n' +
    'function close() { sink.closed = (sink.closed || 0) + 1; }\n' +
    'function restoreFocusAfterRerender() { sink.refocused = (sink.refocused || 0) + 1; }\n' +
    commitSrc + '\n' +
    'return (v) => { commit(v); return state.value; };'
  );
  {
    const sink = {};
    const fired = [];
    const run = runCommit(norm, 'a', (v) => fired.push(v), sink);
    const after = run(' browse');
    ok(after === 'a', 'committing an ACTION row leaves the control\'s value UNCHANGED');
    ok(fired.length === 1 && fired[0] === ' browse', '…while the handler still fires with the sentinel');
    ok(sink.closed === 1, '…and the menu is closed');
    ok(sink.refocused === 1, '…and focus is restored after a handler that may re-render');
  }
  {
    // THE REGRESSION HALF. An ordinary option must still commit normally — this
    // is what proves the new branch did not swallow the shipped path that six
    // other adoptions depend on.
    const sink = {};
    const fired = [];
    const run = runCommit(norm, 'a', (v) => fired.push(v), sink);
    ok(run('b') === 'b', 'an ORDINARY option still becomes the control\'s value');
    ok(fired.length === 1 && fired[0] === 'b', '…and still fires onChange');
  }
  {
    // Re-committing the SAME ordinary value must not fire onChange — unchanged
    // behaviour, asserted here because the action branch sits directly above the
    // `changed` computation and a careless edit could bypass it.
    const sink = {};
    const fired = [];
    const run = runCommit(norm, 'a', (v) => fired.push(v), sink);
    run('a');
    ok(fired.length === 0, 'committing the value it already holds fires nothing (unchanged)');
  }
  {
    // A disabled ACTION row is still refused, so `action` cannot be a way past
    // the disabled gate.
    const dis = render.normaliseOptions([{ value: 'z', label: 'Z', action: true, disabled: true }]);
    const sink = {};
    const fired = [];
    const run = runCommit(dis, null, (v) => fired.push(v), sink);
    run('z');
    ok(fired.length === 0 && !sink.closed, 'a DISABLED action row does nothing at all');
  }
}

// ═══════════════════════════════════════════════════════════════════════
section('§9  ACTION ROWS, ASSERTED OVER THE REAL CALL SITES');
// ═══════════════════════════════════════════════════════════════════════
//
// §8 proves the component's contract against options this suite wrote itself.
// That is exactly the gap that let the defect through: adding `action: true` to
// Ingest's REAL domain-picker options turned every domain row into an action
// row and THREE suites stayed green, because none of them ever looked at what
// the shipped builders actually produce.
{
  // ── 9a. INGEST'S BUILDER, EXECUTED ──────────────────────────────────────
  const ingestSrc = readFileSync(path.join(VIEWS, 'ingest.js'), 'utf8');
  const mkCfg = new Function('state', 'selectDomain',
    extractFunction(ingestSrc, 'domainListboxCfg') + '\nreturn domainListboxCfg;'
  )({ domain: 'business', domains: [
    { slug: 'articles', displayName: 'Articles' },
    { slug: 'business', displayName: 'Business' },
  ] }, () => {});

  const cfg = mkCfg();
  ok(Array.isArray(cfg.options) && cfg.options.length === 2,
    '§9a the REAL domain builder produced its rows (a desync here would make the ' +
    'assertions below vacuous rather than red)');
  ok(cfg.options.every((o) => o.action !== true),
    '§9a no domain row ASKS to be an action row — a domain must BECOME the value, ' +
    'not merely fire a handler and leave the picker on the old one');
  ok(!cfg.actionValues || cfg.actionValues.length === 0,
    '§9a …and the picker GRANTS none, so the request could not be honoured even ' +
    'if a later edit made it');
  const normed = render.normaliseOptions(cfg.options, cfg.actionValues);
  ok(normed.length === 2 && normed.every((o) => o.action === false),
    '§9a through the REAL normaliser, every domain row is an ordinary option');

  // ── 9b. THE COMPOSER'S BUILDER — the one control that HAS an action row ──
  // Not executable here (it reaches the working set, the catalogue and icon()),
  // so brace-matched and scanned with COMMENTS STRIPPED: this file carries
  // paragraphs about action rows, and a scan a comment can satisfy is a guard
  // about prose.
  const chatSrc = readFileSync(path.join(VIEWS, 'chat.js'), 'utf8');
  const mcfg = stripJsComments(nestedFunctionBody(stripJsComments(chatSrc), 'function modelListboxCfg() {', 'chat.js'));
  const actionFlags = (mcfg.match(/action:\s*true/g) || []).length;
  ok(actionFlags === 1, `§9b the model picker declares exactly ONE action row (found ${actionFlags})`);
  ok(/value:\s*BROWSE_MODEL_VALUE,[\s\S]{0,200}action:\s*true/.test(mcfg),
    '§9b …and it is the browse sentinel, not a model');
  ok(/actionValues:\s*\[BROWSE_MODEL_VALUE\]/.test(mcfg),
    '§9b …and the cfg GRANTS that one value and no other, so marking a MODEL as an ' +
    'action is inert — the picker cannot end up offering rows that decline to be chosen');

  // ── 9c. THE CLASS, enumerated from the tree ─────────────────────────────
  // Not a hardcoded pair of filenames: a NEW picker that adds an action row
  // without granting it (or grants one it never uses) is the same defect in a
  // file that does not exist yet.
  const asks = [], grants = [];
  for (const f of viewFiles) {
    const code = stripJsComments(readFileSync(path.join(VIEWS, f), 'utf8'));
    if (/action:\s*true/.test(code)) asks.push(f);
    if (/actionValues:/.test(code)) grants.push(f);
  }
  ok(asks.join(',') === grants.join(','),
    '§9c every view that ASKS for an action row also GRANTS one, and vice versa ' +
    `(asks: ${asks.join(', ') || 'none'} | grants: ${grants.join(', ') || 'none'})`);
  ok(asks.length === 1 && asks[0] === 'chat.js',
    '§9c and today that is exactly one view — the composer\'s model menu');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('Failing assertions:');
  for (const f of failures) console.log('  - ' + f);
  console.log('❌ /next listbox assertions FAILED');
  process.exit(1);
}
console.log('✅ /next shared listbox + eight adoptions green');
