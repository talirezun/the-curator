/**
 * test-next-shell-rail.js — OFFLINE guard on the /next rail: its captions,
 * its order, its group divider, its logo-as-Home button, and which view a
 * launch opens.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * v3.49.0 answered a power user's report on v3.48.1, in his own words:
 *
 *   1. He could not tell the people icon (Shared Brain) from the memory
 *      icon and waited for the tooltip; the upload arrow did not read as
 *      "Ingest". → every rail button now carries a one-word caption under
 *      its glyph, in the TEXT face.
 *   2. Ingest was fifth in a column read top-down, behind two surfaces a
 *      new user has neither joined nor populated. → the order is now
 *      chat / ingest / domains, a thin divider, then shared / memory.
 *   3. "The logo is not clickable and there is no home." → the mark is a
 *      real <button> that goes to the Domains overview, and a FIRST launch
 *      lands there too instead of on an unusable Chat composer.
 *
 * Each of those is a property that can regress silently. A caption that
 * quietly went mono would look almost right; a divider that drifted one
 * item would still draw a line; a home button that lost its data-view
 * would still render the mark and still absorb the click, which is the
 * exact defect being fixed. So this suite EXECUTES the real renderRail()
 * from src/public/next/app.js against a recording DOM and reads the markup
 * it actually produced, and executes the real pickStartView() over the
 * values localStorage can actually hand it.
 *
 * ── WHAT IS COVERED, BEHAVIOURALLY ───────────────────────────────────────
 *
 *   §1  Extraction sanity — the anchors are real and the sandbox is live.
 *   §2  Every nav button carries the caption VIEW_META declares, and both
 *       footer buttons do too. Captions are one word.
 *   §3  Rail order, read off the rendered markup: chat, ingest, domains,
 *       shared, memory.
 *   §4  The divider is rendered exactly once, between domains and shared,
 *       and is hidden from assistive technology.
 *   §5  The logo is a <button> with an accessible name, carrying
 *       data-view="domains"; its recorded click handler calls navigate
 *       with 'domains'; and the <img> inside it contributes no second name.
 *   §6  pickStartView: a fresh launch opens HOME_VIEW; a stored view is
 *       restored; a stored view this build no longer has is ignored;
 *       null/''/junk fall to HOME_VIEW.
 *   §7  The mark ref the rail draws is root-absolute and resolves to a
 *       real file on disk, in both themes — the full mark, same as
 *       README/about/the DMG (a simplified rail-only variant was tried
 *       briefly in v3.49.0 and withdrawn at the maintainer's request).
 *   §8  SOURCE GUARD (the one place a source read is the right tool): the
 *       caption's font comes from a token whose family is --font-sans.
 *       A rendered-font check needs a browser; the token indirection does
 *       not, and the failure this guards — the caption silently taking the
 *       machine face — is a token swap, which is exactly what a token read
 *       can see. The rendered computed family is separately measured by
 *       the visual harness.
 *
 * ── NOT ENFORCED (stated rather than implied) ────────────────────────────
 *
 *   • No layout. Caption WIDTHS, whether anything wraps at the Largest text
 *     size, and the 72px rail column were measured in a real browser during
 *     the release and are recorded in shell.css beside --app-rail-w; nothing
 *     here re-measures them, and nothing here would notice a caption being
 *     clipped.
 *   • No pixels and no contrast.
 *   • navigate() itself is not executed — §5 asserts the ARGUMENT the rail
 *     hands it. What navigate does with it is other suites' subject.
 *   • boot() is not executed. §6 covers the view DECISION only; that boot
 *     calls pickStartView with the stored value is a one-line call site.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'src/public/next/app.js');
const SHELL_CSS = path.join(ROOT, 'src/public/next/shell.css');
const TYPO_CSS = path.join(ROOT, 'src/public/next/tokens/typography.css');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
function section(t) { console.log(`\n${t}`); }

const appJs = readFileSync(APP, 'utf8');

// ── Extraction helpers ───────────────────────────────────────────────────
// Brace-matched so nested braces cannot truncate an extraction, and a
// missing name THROWS rather than silently testing nothing. Same discipline
// as scripts/test-next-recovery-and-badge.js, which these are adapted from.
function extractFunction(src, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractFunction: "${name}" not found in next/app.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = src.indexOf('(', start);
  let parens = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') parens++;
    else if (src[p] === ')') { parens--; if (parens === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i);
  if (!/\n?\}$/.test(out)) throw new Error(`extractFunction: "${name}" desynced`);
  // `export` is meaningless (and a SyntaxError) inside new Function — the
  // body is what is under test, not the module boundary.
  return out.replace(/^export\s+/, '');
}
function extractConst(src, name) {
  const marker = new RegExp(`(?:^|\\n)const ${name} = (\\{|\\[|'|")`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in next/app.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const open = m[1];
  if (open === "'" || open === '"') {
    const end = src.indexOf(';', start);
    if (end === -1) throw new Error(`extractConst: "${name}" has no terminator`);
    return src.slice(start, end + 1);
  }
  const close = open === '{' ? '}' : ']';
  let i = src.indexOf(open, start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i) + ';';
}

// ── A recording DOM, big enough for renderRail() and nothing more ────────
//
// renderRail() does exactly four things to the document: it takes #rail,
// assigns its innerHTML, walks `[data-view]` inside it binding clicks, and
// takes #rail-theme-toggle to bind one more. So the shim captures the
// assigned HTML string and answers querySelectorAll by SCANNING that string
// — which means every assertion below reads markup the real function really
// produced, not a re-description of it.
//
// The scanner is deliberately dumb (one regex per opening tag). That is the
// point: a sophisticated parser that desynced would report the wrong
// element set while looking healthy — this repo's named "clever test goes
// blind" failure — whereas a regex that stops matching produces zero
// elements, which §1's floor assertions catch immediately.
function scanTags(html) {
  const out = [];
  const re = /<(\w+)((?:\s+[-\w]+(?:="[^"]*")?)*)\s*\/?>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = {};
    const are = /([-\w]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = are.exec(m[2])) !== null) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    // Text content up to the matching close tag, tags stripped. Good enough
    // for a caption span, which contains no nested markup.
    const close = html.indexOf(`</${m[1]}>`, re.lastIndex);
    const inner = close === -1 ? '' : html.slice(re.lastIndex, close);
    out.push({ tag: m[1], attrs, index: m.index, inner, text: inner.replace(/<[^>]*>/g, '') });
  }
  return out;
}

function makeRail() {
  const clicks = [];
  const rail = {
    _html: '',
    set innerHTML(v) { this._html = v; },
    get innerHTML() { return this._html; },
    querySelectorAll(sel) {
      const tags = scanTags(this._html);
      let match;
      if (sel === '[data-view]') match = (t) => 'data-view' in t.attrs;
      else throw new Error(`rail shim: unsupported selector ${sel}`);
      return tags.filter(match).map((t) => ({
        dataset: { view: t.attrs['data-view'] },
        addEventListener(type, fn) { clicks.push({ type, fn, view: t.attrs['data-view'] }); },
      }));
    },
  };
  return { rail, clicks };
}

// ── Build the sandbox out of the REAL source ─────────────────────────────
const NEEDED_CONSTS = ['NAV_VIEWS', 'FOOTER_VIEWS', 'VIEW_META', 'RAIL_DIVIDER_AFTER', 'HOME_VIEW'];
const NEEDED_FNS = ['renderRail', 'pickStartView', 'escapeHtml'];

let sandbox;
try {
  sandbox = new Function('__env', `
    const { document, icon, syncBadgeTitle, syncBadgeMarkup, renderThemeToggleIcon,
            renderRailActive, applySyncBadge, toggleTheme, navigate, state } = __env;
    let _syncPendingCount = __env.syncPending;
    ${extractConst(appJs, 'NAV_VIEWS')}
    ${extractConst(appJs, 'FOOTER_VIEWS')}
    const ALL_VIEWS = [...NAV_VIEWS, ...FOOTER_VIEWS];
    ${extractConst(appJs, 'RAIL_DIVIDER_AFTER')}
    ${extractConst(appJs, 'HOME_VIEW')}
    ${extractConst(appJs, 'VIEW_META')}
    ${NEEDED_FNS.map((n) => extractFunction(appJs, n)).join('\n\n')}
    return { renderRail, pickStartView, NAV_VIEWS, FOOTER_VIEWS, ALL_VIEWS,
             VIEW_META, RAIL_DIVIDER_AFTER, HOME_VIEW };
  `);
} catch (err) {
  console.log(`  ✗ FATAL: could not build the sandbox from next/app.js — ${err.message}`);
  process.exit(1);
}

/** Run the real renderRail() and hand back the markup plus the click wiring. */
function render({ theme = 'dark', syncPending = 0 } = {}) {
  const { rail, clicks } = makeRail();
  const navigated = [];
  const themeToggle = { addEventListener() {} };
  const api = sandbox({
    state: { theme, view: 'domains' },
    syncPending,
    document: {
      getElementById: (id) => (id === 'rail' ? rail : id === 'rail-theme-toggle' ? themeToggle : null),
      querySelectorAll: () => [],
    },
    icon: (name, size) => `<svg data-icon="${name}" data-size="${size}"></svg>`,
    syncBadgeTitle: () => 'Sync',
    syncBadgeMarkup: (n) => (n > 0 ? `<span class="rail-badge">${n}</span>` : ''),
    renderThemeToggleIcon() {}, renderRailActive() {}, applySyncBadge() {},
    toggleTheme() {},
    navigate: (v) => navigated.push(v),
  });
  api.renderRail();
  return { api, html: rail.innerHTML, tags: scanTags(rail.innerHTML), clicks, navigated };
}

console.log('test-next-shell-rail.js — /next rail captions, order, divider, Home, start view\n');

// ════════════════════════════════════════════════════════════════════════
section('§1  Extraction + sandbox sanity (everything below is vacuous without this)');
// ════════════════════════════════════════════════════════════════════════

const R = render();
ok(R.html.length > 200, `renderRail() produced markup (${R.html.length} chars)`);
ok(R.tags.length >= 12, `the tag scanner resolved ${R.tags.length} elements — a desynced scanner would resolve ~0`);
ok(R.clicks.length >= 8, `renderRail() bound ${R.clicks.length} [data-view] click handlers`);
// CONTROL: the scanner must be able to see an attribute that is NOT there,
// otherwise every negative assertion below passes for free.
{
  const probe = scanTags('<button class="x" data-view="chat"><span class="rail-cap">Chat</span></button><i></i>');
  ok(probe.length === 3 && probe[0].attrs['data-view'] === 'chat' && probe[1].text === 'Chat'
     && !('data-view' in probe[2].attrs),
    'CONTROL: scanTags reads attributes and text, and reports an ABSENT attribute as absent');
}
for (const n of NEEDED_CONSTS) {
  ok(R.api[n] !== undefined, `${n} extracted from the real source`);
}

// ════════════════════════════════════════════════════════════════════════
section('§2  Every rail button carries its caption — the reported defect');
// ════════════════════════════════════════════════════════════════════════

const buttons = R.tags.filter((t) => t.tag === 'button' && 'data-view' in t.attrs && (t.attrs.class || '').includes('rail-btn'));
const captionOf = (view) => {
  const b = buttons.find((x) => x.attrs['data-view'] === view);
  if (!b) return null;
  const m = /<span class="rail-cap"[^>]*>([^<]*)<\/span>/.exec(b.inner);
  return m ? m[1] : null;
};

const ALL = [...R.api.NAV_VIEWS, ...R.api.FOOTER_VIEWS];
eq(buttons.length, ALL.length, 'every nav AND footer view renders exactly one rail button');
for (const v of ALL) {
  const cap = captionOf(v);
  ok(cap !== null && cap.length > 0, `${v} renders a non-empty caption (got ${JSON.stringify(cap)})`);
  eq(cap, R.api.VIEW_META[v].caption, `${v}'s rendered caption is VIEW_META.${v}.caption`);
  ok(!/\s/.test(cap || ' '), `${v}'s caption is ONE word — a two-word caption is what forced "Shared Brain" to "Shared"`);
}
// The two abbreviations are the whole reason `caption` is a separate field
// from `label` and `title`. Pin them by NAME, so shortening a third one
// silently is not possible without this line changing.
eq(R.api.VIEW_META.shared.caption, 'Shared', 'Shared Brain abbreviates to "Shared" on the rail');
eq(R.api.VIEW_META.memory.caption, 'Memory', 'Agent memory abbreviates to "Memory" on the rail');
ok(R.api.VIEW_META.shared.title === 'Shared Brain' && R.api.VIEW_META.memory.title === 'Agent memory',
  'the FULL names survive on `title` — the caption abbreviates the rail, not the app');
for (const v of ALL) {
  const b = buttons.find((x) => x.attrs['data-view'] === v);
  eq(b.attrs['aria-label'], R.api.VIEW_META[v].title,
    `${v}'s aria-label is the full title, not the abbreviated caption`);
}
// The caption must not be announced a second time on top of aria-label.
{
  const capTags = R.tags.filter((t) => (t.attrs.class || '') === 'rail-cap');
  eq(capTags.length, ALL.length, 'one .rail-cap per button');
  ok(capTags.every((t) => t.attrs['aria-hidden'] === 'true'),
    'every caption is aria-hidden — the button already announces the full title');
}

// ════════════════════════════════════════════════════════════════════════
section('§3  Rail order — Ingest is second');
// ════════════════════════════════════════════════════════════════════════

const renderedNav = buttons
  .filter((b) => R.api.NAV_VIEWS.includes(b.attrs['data-view']))
  .sort((a, b) => a.index - b.index)
  .map((b) => b.attrs['data-view']);
ok(JSON.stringify(renderedNav) === JSON.stringify(['chat', 'ingest', 'domains', 'shared', 'memory']),
  `the rendered nav order is chat, ingest, domains, shared, memory (got ${renderedNav.join(', ')})`);
eq(renderedNav[1], 'ingest', 'Ingest is SECOND — it was fifth, behind two surfaces a new user has not set up');
ok(JSON.stringify(renderedNav) === JSON.stringify(R.api.NAV_VIEWS),
  'the rendered order is NAV_VIEWS in NAV_VIEWS order — renderRail adds no ordering of its own');

// ════════════════════════════════════════════════════════════════════════
section('§4  The advanced-group divider');
// ════════════════════════════════════════════════════════════════════════

const dividers = R.tags.filter((t) => (t.attrs.class || '').includes('rail-divider'));
eq(dividers.length, 1, 'exactly one divider is rendered');
if (dividers.length === 1) {
  const d = dividers[0];
  const before = buttons.filter((b) => b.index < d.index).sort((a, b) => b.index - a.index)[0];
  const after = buttons.filter((b) => b.index > d.index).sort((a, b) => a.index - b.index)[0];
  eq(before.attrs['data-view'], R.api.RAIL_DIVIDER_AFTER, 'the divider follows RAIL_DIVIDER_AFTER');
  eq(before.attrs['data-view'], 'domains', 'the everyday group ends at Domains');
  eq(after.attrs['data-view'], 'shared', 'the advanced group starts at Shared Brain');
  eq(d.attrs['aria-hidden'], 'true', 'the divider is hidden from assistive technology');
  eq(d.attrs.role, 'presentation', 'the divider carries role="presentation" — grouping, not a landmark');
}
// The divider is DATA. Prove that by moving it: a boundary hardcoded to an
// index in renderRail() would ignore this and stay where it was.
ok(R.api.NAV_VIEWS.includes(R.api.RAIL_DIVIDER_AFTER),
  `RAIL_DIVIDER_AFTER (${JSON.stringify(R.api.RAIL_DIVIDER_AFTER)}) names a view that is actually in the rail — a name that is not renders no divider at all, silently`);

// ════════════════════════════════════════════════════════════════════════
section('§5  The logo is a Home button — "the logo is not clickable"');
// ════════════════════════════════════════════════════════════════════════

const home = R.tags.find((t) => t.attrs.id === 'rail-home');
ok(!!home, 'the rail renders an element with id="rail-home"');
if (home) {
  eq(home.tag, 'button', 'the logo is a <button> — not an <img> that absorbs the click');
  eq(home.attrs['data-view'], R.api.HOME_VIEW, 'the Home button carries data-view = HOME_VIEW');
  eq(home.attrs['data-view'], 'domains', 'Home is the Domains overview');
  ok((home.attrs['aria-label'] || '').trim().length > 0, `the Home button has an accessible name (${JSON.stringify(home.attrs['aria-label'])})`);
  ok(/home/i.test(home.attrs['aria-label'] || ''), 'and that name says "Home"');
  ok(/home/i.test(home.attrs.title || ''), 'the tooltip says "Home" too');
  ok(home.index < buttons[0].index, 'the Home button is rendered FIRST, above the nav buttons');
}
const mark = R.tags.find((t) => (t.attrs.class || '').includes('rail-mark'));
ok(!!mark && mark.tag === 'img', 'the mark is still an <img> inside that button');
if (mark) {
  eq(mark.attrs.alt, '', 'the <img> has an EMPTY alt — the button owns the accessible name, so an alt would be a second one');
  eq(mark.attrs['aria-hidden'], 'true', 'and is aria-hidden for the same reason');
}
// BEHAVIOUR, not markup: run the handler renderRail actually bound.
{
  const wired = R.clicks.find((c) => c.view === 'domains');
  ok(!!wired, 'a click handler was bound for the Home button\'s data-view');
  const probe = render();
  const homeClick = probe.clicks[0];       // the Home button is the first [data-view] in the markup
  eq(homeClick.view, 'domains', 'the FIRST bound [data-view] is the Home button');
  homeClick.fn();
  ok(probe.navigated.length === 1 && probe.navigated[0] === 'domains',
    `clicking the logo calls navigate('domains') (got ${JSON.stringify(probe.navigated)})`);
}
// One delegation point: nobody may bind a second, divergent handler.
{
  const perView = {};
  for (const c of R.clicks) perView[c.view] = (perView[c.view] || 0) + 1;
  const doubled = Object.entries(perView).filter(([, n]) => n > 1).map(([v]) => v);
  // Home and the Domains nav button legitimately SHARE data-view="domains",
  // so 'domains' is expected twice and nothing else is.
  ok(JSON.stringify(doubled) === JSON.stringify(['domains']),
    `only "domains" is wired twice — the Home button and the Domains nav button (got ${JSON.stringify(doubled)})`);
}

// ════════════════════════════════════════════════════════════════════════
section('§6  Which view a launch opens');
// ════════════════════════════════════════════════════════════════════════

const { pickStartView, HOME_VIEW, ALL_VIEWS } = R.api;
eq(HOME_VIEW, 'domains', 'HOME_VIEW is the Domains overview');
eq(pickStartView(null), HOME_VIEW, 'a FIRST launch (nothing stored) opens HOME_VIEW, not Chat');
eq(pickStartView(undefined), HOME_VIEW, 'storage disabled / read returned undefined opens HOME_VIEW');
eq(pickStartView(''), HOME_VIEW, 'an empty stored value opens HOME_VIEW');
for (const v of ALL_VIEWS) {
  eq(pickStartView(v), v, `a stored "${v}" is RESTORED — the returning user notices no change`);
}
eq(pickStartView('chat'), 'chat', 'a user who left on Chat still lands on Chat');
eq(pickStartView('wiki'), HOME_VIEW, 'a view name from an older build is ignored, not handed to navigate()');
eq(pickStartView('Domains'), HOME_VIEW, 'the check is case-sensitive — a near-miss falls back rather than throwing later');
eq(pickStartView('__proto__'), HOME_VIEW, 'a prototype-shaped name is not resolved through the prototype chain');
eq(pickStartView('constructor'), HOME_VIEW, 'nor is "constructor"');
eq(pickStartView('0'), HOME_VIEW, 'nor is an index-shaped string');
ok(ALL_VIEWS.includes('settings') && ALL_VIEWS.includes('sync'),
  'the restore set is ALL_VIEWS — a footer view is a legitimate place to have quit from');

// ── WHY THE RESTORE SET AND THE META TABLE MUST BE THE SAME SET ──────────
// A mutation swapping `ALL_VIEWS.includes(stored)` for
// `Object.keys(VIEW_META).includes(stored)` came back GREEN while this
// suite was being built. It was chased, and the finding is that the
// mutation is INVALID as written rather than that the guard is weak: the
// two collections hold the same seven names today, so the two programs are
// observably identical and no test could tell them apart.
//
// What the chase produced instead is the invariant that MAKES them
// identical, which nothing had been pinning:
//   • a name in NAV_VIEWS/FOOTER_VIEWS with no VIEW_META entry makes
//     renderRail() throw on `meta.title` — a blank rail, at boot, for
//     every user;
//   • a VIEW_META entry with no view behind it is a name pickStartView
//     would accept if anyone ever did make that swap, and navigate() would
//     then fail to find it in the registry.
// Neither is caught by anything else in this repo.
{
  const metaKeys = Object.keys(R.api.VIEW_META).sort();
  const viewNames = [...ALL_VIEWS].sort();
  ok(JSON.stringify(metaKeys) === JSON.stringify(viewNames),
    `VIEW_META's keys are exactly the rail's views (meta: ${metaKeys.join(',')} | views: ${viewNames.join(',')})`);
  // CONTROL: the comparison can see a difference, so the line above is a
  // measurement rather than two sorts of the same array.
  ok(JSON.stringify(['a', 'b'].sort()) !== JSON.stringify(['a', 'b', 'c'].sort()),
    'CONTROL: the set comparison distinguishes a superset from an exact match');
}

// ════════════════════════════════════════════════════════════════════════
section('§7  The rail mark ref is root-absolute and resolves to a real file');
// ════════════════════════════════════════════════════════════════════════
// A simplified rail-only mark was tried and withdrawn at the maintainer's
// request — the rail draws the same full mark (assets/mark-small-on-*.svg)
// as README/about/the DMG again. What stays load-bearing is the
// root-absolute property itself: see the comment on the markSrc line in
// renderRail() for why a bare-relative ref silently 200s as HTML instead
// of 404ing.

const srcOf = (theme) => {
  const r = render({ theme });
  const img = r.tags.find((t) => (t.attrs.class || '').includes('rail-mark'));
  return img ? img.attrs.src : null;
};
const darkSrc = srcOf('dark');
const lightSrc = srcOf('light');
ok(darkSrc !== lightSrc, `the mark swaps with the theme (${darkSrc} / ${lightSrc})`);
for (const [theme, src] of [['dark', darkSrc], ['light', lightSrc]]) {
  ok(/^\/next\/assets\//.test(src || ''),
    `the ${theme} mark ref is root-absolute — a bare-relative one resolves against the CURRENT path and silently 200s as HTML`);
  const disk = path.join(ROOT, 'src/public', (src || '').replace(/^\//, ''));
  ok(existsSync(disk), `the ${theme} mark exists on disk (${src})`);
}
ok(darkSrc === '/next/assets/mark-small-on-dark.svg', 'the rail draws the full mark, not a reduced one');

// ════════════════════════════════════════════════════════════════════════
section('§8  The caption takes the TEXT face, not the machine face');
// ════════════════════════════════════════════════════════════════════════
//
// This is the v3.44.0 queued "sidebar captions off monospace" item. The
// check is a token read rather than a render because the failure mode is a
// token swap: `font: var(--type-eyebrow)` instead of `var(--type-caption)`
// is one word's difference and looks almost right. The rendered computed
// family is measured separately by the visual harness.

const shellCss = readFileSync(SHELL_CSS, 'utf8');
const typoCss = readFileSync(TYPO_CSS, 'utf8');

const capRule = /\.rail-cap\s*\{([^}]*)\}/.exec(shellCss);
ok(!!capRule, '.rail-cap has a rule in shell.css');
const capFont = capRule ? (/font:\s*var\((--[\w-]+)\)/.exec(capRule[1]) || [])[1] : null;
ok(!!capFont, `.rail-cap sets its font from a token (got ${JSON.stringify(capFont)})`);
ok(capFont !== '--type-eyebrow',
  '.rail-cap does NOT take --type-eyebrow — that is the mono eyebrow rung, and taking it is exactly the defect');

// Resolve the token one level: a composed role like --type-caption ends in
// a family reference, and THAT is the thing that must be the sans one.
const roleDef = capFont ? new RegExp(`${capFont}:\\s*([^;]+);`).exec(typoCss) : null;
ok(!!roleDef, `${capFont} is defined in tokens/typography.css`);
const family = roleDef ? (/var\((--font-\w+)\)/.exec(roleDef[1]) || [])[1] : null;
eq(family, '--font-sans', `${capFont} resolves to the SANS family — a section name is prose a human reads`);
// CONTROL: the same probe must report the mono rung as mono, or the line
// above proves nothing about which family it found.
{
  const eyebrow = /--type-eyebrow:\s*([^;]+);/.exec(typoCss);
  const eyebrowFamily = eyebrow ? (/var\((--font-\w+)\)/.exec(eyebrow[1]) || [])[1] : null;
  eq(eyebrowFamily, '--font-mono',
    'CONTROL: the same resolver reads --type-eyebrow as --font-mono, so §8 distinguishes the two faces');
}
// And the rail column is a token, not four literals — the thing that made
// the caption measurable in the first place.
ok(/--app-rail-w:\s*\d+px;/.test(shellCss), 'shell.css defines --app-rail-w');
ok(!/grid-template-columns:\s*60px/.test(shellCss),
  '#app-shell no longer hardcodes the old 60px rail column');

console.log(`\n────────────────────────────────────────────────────────────`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) console.log('✅ All /next rail assertions green');
process.exit(failed > 0 ? 1 : 0);
