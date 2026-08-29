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
ok(/if \(state\.trigger\.disabled\) return;/.test(lbJs),
  'with an independent second refusal inside open()');

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
  // `open` is NESTED inside mountListbox and therefore indented, which
  // extractFunction's line-anchored marker cannot see. Brace-matched here
  // directly rather than loosening that shared helper's anchor.
  const openAt = lbJs.indexOf('function open() {');
  let depth = 0, end = openAt;
  for (let i = lbJs.indexOf('{', openAt); i < lbJs.length; i++) {
    if (lbJs[i] === '{') depth++;
    else if (lbJs[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const openBody = openAt >= 0 ? lbJs.slice(openAt, end) : '';
  ok(openAt >= 0 && openBody.length > 200,
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
const ADOPTERS = ['memory.js', 'ingest.js', 'settings.js'];

// A whole-tree walk, never a hardcoded file list: a hardcoded list is how a
// previous guard in this repo went blind (v3.9.2).
let selectOffenders = [];
for (const f of viewFiles) {
  const src = readFileSync(path.join(VIEWS, f), 'utf8');
  // chat.js is the ONE deliberate exclusion and it is named, not silent. Its
  // composer carries its own click-only menu with listbox roles and NO
  // keyboard support — the highest-value remaining adoption, recorded as a
  // gap rather than swept under a passing assertion. It renders no <select>
  // either, so this exclusion costs nothing today; it exists so that adding
  // one there would still be caught.
  if (/<select/.test(src)) selectOffenders.push(f);
}
ok(selectOffenders.length === 0,
  'NO view under /next contains a <select>, in markup OR in a comment' +
  (selectOffenders.length ? ' — found: ' + selectOffenders.join(', ') : ''));

const expectAdoptions = { 'memory.js': 2, 'ingest.js': 2, 'settings.js': 2 };
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
ok(total === 6, `SIX adoptions across three views (found ${total})`);

// The render -> wire handoff. This is the assertion that makes "one
// component" mean something: markup and behaviour must come from ONE object.
for (const f of ['memory.js', 'settings.js']) {
  const src = readFileSync(path.join(VIEWS, f), 'utf8');
  ok(/const pendingListboxes = \[\]/.test(src),
    `${f} uses the render -> wire handoff array`);
  ok(/pendingListboxes\.length = 0/.test(src),
    `${f} clears it before rendering, so a branch that emits no picker leaves nothing to mount`);
  ok(/for \(const cfg of pendingListboxes\)[\s\S]{0,900}mountListbox\(cfg\)/.test(src),
    `${f} mounts from the SAME cfg objects the markup came from`);
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

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('Failing assertions:');
  for (const f of failures) console.log('  - ' + f);
  console.log('❌ /next listbox assertions FAILED');
  process.exit(1);
}
console.log('✅ /next shared listbox + six adoptions green');
