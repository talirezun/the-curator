/**
 * test-next-shell-rail.js — OFFLINE guard on the /next rail: its captions,
 * its order, its group divider, its logo-as-Home button, and which view a
 * launch opens.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 *
 * ── WHAT v3.64.0 CHANGED ABOUT IT ───────────────────────────────────────
 * The rail became THREE entries — chat, domains, memory — read as *ask ·
 * knowledge · context*, and the divider went with them. `ingest` and
 * `shared` are now HOSTED VIEWS: still registered, still navigable, still
 * restorable from the stored last view, and reached from a section of the
 * domain page instead of a rail button. §3b is the new section and it is
 * the point of the release: every way that change could have gone wrong is
 * a SILENT failure, so each is asserted positively rather than left to the
 * absence of an error.
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
 *   §3  Rail order, read off the rendered markup: chat, domains, memory —
 *       ask, knowledge, context (v3.64.0; it was five entries).
 *   §3b HOSTED VIEWS — `ingest` and `shared` left the RAIL in v3.64.0 and
 *       did not leave the APP. Per name: no rail button, a surviving
 *       VIEW_META entry, a restored stored last view, and a registry entry
 *       proved by RUNNING the real registerView()/navigate() pair. All
 *       three failure modes are silent, which is why they are here.
 *   §4  NO divider is rendered (v3.64.0 removed the advanced group), with
 *       a POSITIVE CONTROL in a second sandbox that re-points
 *       RAIL_DIVIDER_AFTER at a real view and proves the mechanism can
 *       still draw one — otherwise "zero dividers" would also be green for
 *       a renderRail() that had lost the code path.
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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

// The one `opts.reason` value any consumer acts on, read from the source
// rather than typed here: §9 asserts the NORMALISATION lands on it, and a
// copy in this file would assert a copy.
const newProjectReasonMatch = /export const NEW_PROJECT_REASON = '([^']+)';/.exec(appJs);
const newProjectReasonLiteral = newProjectReasonMatch ? newProjectReasonMatch[1] : null;

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
  // The opener decides how the end is found. A BARE literal (null, a number,
  // true) has no bracket to match, so it is terminated by the first `;` —
  // and it is not a hypothetical shape: RAIL_DIVIDER_AFTER became `null` in
  // v3.64.0, and without this branch the marker simply did not match, this
  // function THREW, and §1 exited 1 with "could not build the sandbox"
  // instead of testing the rail. An extractor that can only read the shapes
  // it was written against is a suite that dies the day the source changes.
  const marker = new RegExp(`(?:^|\\n)const ${name} = (\\{|\\[|'|"|[^;\\n]+;)`);
  const m = marker.exec(src);
  if (!m) throw new Error(`extractConst: "${name}" not found in next/app.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const open = m[1];
  if (open.endsWith(';')) {
    // A bare literal: the marker already consumed it up to and including
    // the terminator.
    return src.slice(start, m.index + m[0].length);
  }
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
// HOSTED_VIEWS joined NEEDED_CONSTS in v3.64.0 and ALL_VIEWS stopped being
// RETYPED here. Both matter. The old line read
// `const ALL_VIEWS = [...NAV_VIEWS, ...FOOTER_VIEWS];` — a COPY of app.js's
// definition living in the suite, which means the day app.js widened its own
// ALL_VIEWS (exactly what D-B does) this file would have gone on measuring
// the OLD program while reporting green: §6's restore cases and the set-
// equality check against VIEW_META would both have been run against a set
// that no longer existed in the app. Extracted, not retyped.
const NEEDED_CONSTS = ['NAV_VIEWS', 'HOSTED_VIEWS', 'FOOTER_VIEWS', 'ALL_VIEWS',
                       'VIEW_META', 'RAIL_DIVIDER_AFTER', 'HOME_VIEW'];
const NEEDED_FNS = ['renderRail', 'pickStartView', 'escapeHtml'];

/**
 * Build one sandbox around the real renderRail()/pickStartView().
 *
 * `dividerAfter` overrides RAIL_DIVIDER_AFTER with a literal INSTEAD of the
 * extracted line — which is what §4's positive control needs: with the
 * shipped value at `null` the only thing "no divider rendered" can prove on
 * its own is that renderRail() rendered no divider, which is also true of a
 * renderRail() that has lost the code path entirely. Re-pointing the
 * constant in a second sandbox and watching one divider appear, after the
 * named view, is what keeps §4 a measurement of a DATA-DRIVEN boundary.
 */
function buildSandbox({ dividerAfter } = {}) {
  const dividerLine = (dividerAfter === undefined)
    ? extractConst(appJs, 'RAIL_DIVIDER_AFTER')
    : `const RAIL_DIVIDER_AFTER = ${JSON.stringify(dividerAfter)};`;
  return new Function('__env', `
    const { document, icon, syncBadgeTitle, syncBadgeMarkup, renderThemeToggleIcon,
            renderRailActive, applySyncBadge, toggleTheme, navigate, state } = __env;
    let _syncPendingCount = __env.syncPending;
    ${extractConst(appJs, 'NAV_VIEWS')}
    ${extractConst(appJs, 'HOSTED_VIEWS')}
    ${extractConst(appJs, 'FOOTER_VIEWS')}
    ${extractConst(appJs, 'ALL_VIEWS')}
    ${dividerLine}
    ${extractConst(appJs, 'HOME_VIEW')}
    ${extractConst(appJs, 'VIEW_META')}
    ${NEEDED_FNS.map((n) => extractFunction(appJs, n)).join('\n\n')}
    return { renderRail, pickStartView, NAV_VIEWS, HOSTED_VIEWS, FOOTER_VIEWS, ALL_VIEWS,
             VIEW_META, RAIL_DIVIDER_AFTER, HOME_VIEW };
  `);
}

let sandbox;
try {
  sandbox = buildSandbox();
} catch (err) {
  console.log(`  ✗ FATAL: could not build the sandbox from next/app.js — ${err.message}`);
  process.exit(1);
}

/** Run the real renderRail() and hand back the markup plus the click wiring. */
function render({ theme = 'dark', syncPending = 0, box = sandbox } = {}) {
  const { rail, clicks } = makeRail();
  const navigated = [];
  const themeToggle = { addEventListener() {} };
  const api = box({
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
// 1 home + NAV_VIEWS + the two hardcoded footer buttons. Written as the
// ARITHMETIC rather than as a number, so the next change to the rail has to
// re-derive the floor instead of bumping a literal until it passes. It was
// `>= 8` for the five-entry rail; at three entries the true count is 6.
{
  const floor = 1 + R.api.NAV_VIEWS.length + R.api.FOOTER_VIEWS.length;
  ok(R.clicks.length >= floor,
    `renderRail() bound ${R.clicks.length} [data-view] click handlers (floor ${floor} = 1 home + ${R.api.NAV_VIEWS.length} nav + ${R.api.FOOTER_VIEWS.length} footer)`);
}
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
// The two shortenings are the whole reason `caption` is a separate field from
// `label` and `title`. Pin them by NAME, so shortening a third one silently is
// not possible without this line changing.
//
// T1/T2 (v3.62.0): this used to read "Agent memory abbreviates to Memory".
// Two things changed and only one of them is the rename. The VIEW is now
// "Project context" and its caption "Context" — and "Context" is NOT an
// abbreviation of "Project context", any more than "Shared" is one of "Shared
// Brain". Both are SHORTENINGS: the word that is kept is a real name for the
// thing, which is the property that lets the rail be read without the tooltip
// and the reason the field could be re-pointed at a different word at all. An
// abbreviation would have had to stay "Memory".
eq(R.api.VIEW_META.shared.caption, 'Shared', 'Shared Brain shortens to "Shared" on the rail');
eq(R.api.VIEW_META.memory.caption, 'Context', 'Project context shortens to "Context" on the rail');
ok(R.api.VIEW_META.shared.title === 'Shared Brain' && R.api.VIEW_META.memory.title === 'Project context',
  'the FULL names survive on `title` — the caption shortens the rail, not the app');
// THE VIEW ID DOES NOT MOVE (rename Tier C, refused). `memory` is the stored
// `curator-next-view` value, the onboarding agent door's target, and the
// attribute the Electron main process evaluates across a process boundary —
// three contracts a presentation rename has no business breaking.
ok(Object.prototype.hasOwnProperty.call(R.api.VIEW_META, 'memory')
  && !Object.prototype.hasOwnProperty.call(R.api.VIEW_META, 'context'),
'the VIEW ID stays `memory` — only the words a person reads changed');
for (const v of ALL) {
  const b = buttons.find((x) => x.attrs['data-view'] === v);
  eq(b.attrs['aria-label'], R.api.VIEW_META[v].title,
    `${v}'s aria-label is the full title, not the abbreviated caption`);
}
// The caption must not be announced a second time on top of aria-label.
{
  const capTags = R.tags.filter((t) => (t.attrs.class || '') === 'rail-cap');
  // +1: v3.76.0's Sidebar toggle (the narrow-window drawer) is a rail
  // button with a caption and no data-view — it opens a panel, not a view.
  // Its own behaviour is scripts/test-next-sidebar-drawer.js's.
  eq(capTags.length, ALL.length + 1, 'one .rail-cap per button (the views, plus the Sidebar toggle)');
  const toggle = R.tags.find((t) => t.attrs.id === 'rail-sidebar-toggle');
  ok(!!toggle && toggle.attrs['aria-controls'] === 'sidebar' && !toggle.attrs['data-view'],
    'the extra caption belongs to the Sidebar toggle — aria-controls="sidebar", no data-view');
  ok(capTags.every((t) => t.attrs['aria-hidden'] === 'true'),
    'every caption is aria-hidden — the button already announces the full title');
}

// ════════════════════════════════════════════════════════════════════════
section('§3  Rail order — three places: ask, knowledge, context');
// ════════════════════════════════════════════════════════════════════════

const renderedNav = buttons
  .filter((b) => R.api.NAV_VIEWS.includes(b.attrs['data-view']))
  .sort((a, b) => a.index - b.index)
  .map((b) => b.attrs['data-view']);
// ── MEMORY MOVED ABOVE SHARED (v3.61.0) ──────────────────────────────────
// v3.49.0's own reasoning for this array is that the rail is a FREQUENCY
// ORDER, not an ontology — and on that measure the last two were the wrong way
// round. Agent memory holds a project's standing brief, its handoffs and,
// since v3.59.0, its canonical documents: a screen somebody opens every
// working session. Shared Brain is opt-in and entered rarely. Both stay in the
// advanced group and the divider is unchanged, because it follows `domains` by
// NAME rather than by index.
ok(JSON.stringify(renderedNav) === JSON.stringify(['chat', 'domains', 'memory']),
  `the rendered nav order is chat, domains, memory — ask, knowledge, context (got ${renderedNav.join(', ')})`);
eq(renderedNav[1], 'domains',
  'Domains is SECOND — the rail is three PLACES now, not five tabs; Ingest was second and is a section of the domain page');
ok(JSON.stringify(renderedNav) === JSON.stringify(R.api.NAV_VIEWS),
  'the rendered order is NAV_VIEWS in NAV_VIEWS order — renderRail adds no ordering of its own');

// ════════════════════════════════════════════════════════════════════════
section('§3b  HOSTED VIEWS — off the rail, and still reachable');
// ════════════════════════════════════════════════════════════════════════
//
// THE POINT OF THE RELEASE, AND THE RISK OF IT. v3.64.0 took `ingest` and
// `shared` off the rail because their everyday home is now a section of the
// domain page. Taking a name out of NAV_VIEWS and nothing else would have
// left three separate silent failures, none of which produces an error:
//
//   • navigate('ingest') — the gate is the registry, and an unknown name
//     used to return with nothing rendered and nothing logged, so the
//     onboarding door and the tray's rail-button clicks would have done
//     NOTHING, visibly identical to a frozen app;
//   • pickStartView('ingest') — ALL_VIEWS is the restore set, so a user who
//     quit on Ingest would have been sent to Domains on the next launch and
//     never told why;
//   • VIEW_META — the mount-error card and an MCP refusal string read those
//     labels, and §6's set equality is what stops the two collections
//     drifting apart.
//
// Each of the four properties below is asserted per HOSTED_VIEWS NAME, off
// the array, so a third hosted view inherits the guard for free.

const HOSTED = R.api.HOSTED_VIEWS;
ok(Array.isArray(HOSTED) && HOSTED.length > 0,
  `HOSTED_VIEWS exists and is not empty (${JSON.stringify(HOSTED)})`);
ok(JSON.stringify([...HOSTED].sort()) === JSON.stringify(['ingest', 'shared']),
  'HOSTED_VIEWS is exactly ingest and shared — the two panels that gained a second host on the domain page');

for (const v of HOSTED) {
  // (a) NO RAIL BUTTON. The positive statement of what left — asserted
  //     against the rendered markup, not against the array it came from.
  ok(!buttons.some((b) => b.attrs['data-view'] === v),
    `${v} renders NO rail button — it is reached from the domain page, not the rail`);
  ok(!R.clicks.some((c) => c.view === v),
    `…and no click handler is bound for it either (a button-less data-view would still wire)`);
  // (b) VIEW_META KEEPS ITS ENTRY. Deleting it would red §6's set equality
  //     and, for `shared`, a model-read MCP refusal string.
  ok(Object.prototype.hasOwnProperty.call(R.api.VIEW_META, v),
    `VIEW_META still has ${v} — its caption/title/icon are read by the mount-error card`);
  // `|| {}` is not defensiveness, it is what makes the line below a RED
  // rather than a CRASH: a mutation that deletes the entry threw here on
  // `undefined.title`, and a suite that dies mid-section proves nothing
  // about the assertions it never reached (the v3.60.0 lesson, twice).
  const hostedMeta = R.api.VIEW_META[v] || {};
  ok(typeof hostedMeta.title === 'string' && hostedMeta.title.length > 0,
    `…with a real title (${JSON.stringify(hostedMeta.title)})`);
  // (c) A STORED LAST VIEW IS RESTORED, NOT SENT HOME.
  eq(R.api.pickStartView(v), v,
    `a user who quit on ${v} is returned to it — HOSTED_VIEWS is in ALL_VIEWS, which is the restore set`);
}
// CONTROL: the same three probes report a name that is genuinely gone as
// gone, so the loop above is a measurement rather than three tautologies.
ok(!Object.prototype.hasOwnProperty.call(R.api.VIEW_META, 'wiki')
   && R.api.pickStartView('wiki') === R.api.HOME_VIEW,
  'CONTROL: a view this build really does not have has no VIEW_META entry and is NOT restored');

// (d) THE REGISTRY STILL HAS THEM — the gate navigate() actually consults.
//
// EXECUTED, not scanned. The real registerView() is run against a stub
// registry, fed the names the views/*.js files really register (read off
// their own `registerView('<name>'` call sites, so a view that stopped
// registering itself is visible here), and then the real navigate() is run
// against that registry with stubbed collaborators. Risk 4 in one block.
{
  const viewsDir = path.join(ROOT, 'src/public/next/views');
  const registered = [];
  for (const f of readdirSync(viewsDir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(path.join(viewsDir, f), 'utf8');
    const re = /(?:^|\n)registerView\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) registered.push(m[1]);
  }
  // Against the DISTINCT names, so a duplicate inside ALL_VIEWS (which §6
  // catches on its own line) does not also red this one with a message
  // about the views directory, which would be a true statement about the
  // wrong thing.
  const distinctViews = new Set(R.api.ALL_VIEWS).size;
  ok(registered.length >= distinctViews,
    `the views/ directory contains ${registered.length} top-level registerView() calls, for ${distinctViews} distinct views`);

  const warns = [];
  const navigated = [];
  let box = null;
  try {
    box = new Function('__env', `
      const { state, closeReader, renderRailActive, resolvedMotionMs,
              applyViewExit, mountView, console } = __env;
      const VIEW_EXIT_TOKEN = '--dur-instant';
      let registry = null;
      let _mountedView = null;
      let _pendingNav = null;
      ${extractFunction(appJs, 'registerView')}
      ${extractFunction(appJs, 'navigate')}
      return { registerView, navigate, has: (n) => !!(registry && registry.has(n)) };
    `)({
      state: { view: null },
      closeReader() {}, renderRailActive() {}, applyViewExit() {},
      resolvedMotionMs: () => 0,
      mountView: (n) => navigated.push(n),
      console: { warn: (msg) => warns.push(String(msg)) },
    });
  } catch (err) {
    ok(false, `FATAL: could not build the registry sandbox — ${err.message}`);
  }

  if (box) {
    for (const name of registered) box.registerView(name, {});
    for (const v of R.api.ALL_VIEWS) {
      ok(box.has(v),
        `${v} is in the registry — some views/*.js file calls registerView('${v}'), so navigate() can reach it`);
    }
    // The two that left the rail are the ones this is really about.
    for (const v of HOSTED) {
      const before = navigated.length;
      box.navigate(v);
      ok(navigated.length === before + 1 && navigated[navigated.length - 1] === v,
        `navigate('${v}') really mounts it — off the rail is not off the app`);
    }
    // THE SILENT NO-OP, NOW AUDIBLE. navigate() must still refuse an
    // unknown name without throwing (it is called from a click handler),
    // but the refusal that used to be invisible now says so — the cheapest
    // possible cure for a failure whose entire cost was that nobody could
    // see it.
    const before = navigated.length;
    const warnsBefore = warns.length;
    let threw = null;
    try { box.navigate('a-view-that-does-not-exist'); } catch (err) { threw = err; }
    ok(threw === null, 'navigate() with an unknown name does NOT throw — it is wired straight to a click handler');
    eq(navigated.length, before, '…and mounts nothing');
    ok(warns.length === warnsBefore + 1,
      '…and SAYS SO exactly once, which it did not before v3.64.0 (silent no-op, Risk 4)');
    ok(/a-view-that-does-not-exist/.test(warns[warns.length - 1] || ''),
      `…naming the view it refused (got ${JSON.stringify(warns[warns.length - 1])})`);
    // CONTROL: a legitimate navigation is silent, so the line above is not
    // measuring a warning that fires on every call.
    const quietBefore = warns.length;
    box.navigate(R.api.HOME_VIEW);
    eq(warns.length, quietBefore, 'CONTROL: a navigation that WORKS logs nothing');
  }
}

// ════════════════════════════════════════════════════════════════════════
section('§4  The group divider — removed, and still data-driven');
// ════════════════════════════════════════════════════════════════════════
//
// v3.49.0 drew one line after `domains` and called what followed it
// "advanced". v3.64.0 removes it (D-C): three items need no grouping rule,
// and the group it opened contained exactly the surface the app's second
// audience lives on — marking Project context as the advanced one is not
// redundant, it is wrong.
//
// The MECHANISM is deliberately NOT deleted, and this section is why. "Zero
// dividers rendered" is equally true of a renderRail() that has lost the
// ability to draw one, so the shipped-value assertion is paired with a
// POSITIVE CONTROL in a second sandbox that re-points the constant at a real
// view and watches a divider appear after it. Without that pair, the
// data-driven property the original §4 existed to prove would be gone and
// this section would be decoration.

const dividers = R.tags.filter((t) => (t.attrs.class || '').includes('rail-divider'));
eq(dividers.length, 0, 'NO divider is rendered — the advanced group is gone (v3.64.0, D-C)');
eq(R.api.RAIL_DIVIDER_AFTER, null, 'RAIL_DIVIDER_AFTER is null, which is what asks for no divider');
// Either null, or a name the rail really has. A name that is NEITHER renders
// nothing, silently — the same failure shape as Risk 4 one layer down.
ok(R.api.RAIL_DIVIDER_AFTER === null || R.api.NAV_VIEWS.includes(R.api.RAIL_DIVIDER_AFTER),
  `RAIL_DIVIDER_AFTER (${JSON.stringify(R.api.RAIL_DIVIDER_AFTER)}) is null or names a view that is actually in the rail — anything else renders no divider at all, silently`);

// ── POSITIVE CONTROL: the boundary is still DATA ─────────────────────────
// Everything the old §4 asserted about a rendered divider lives here now,
// run against a sandbox whose RAIL_DIVIDER_AFTER is 'chat' — a view that is
// in the rail and is NOT where the old divider sat, so a boundary hardcoded
// to an index in renderRail() would put the line in the wrong place and this
// block would catch it.
{
  let ctrl = null;
  try { ctrl = render({ box: buildSandbox({ dividerAfter: 'chat' }) }); }
  catch (err) { ok(false, `CONTROL sandbox failed to build — ${err.message}`); }
  if (ctrl) {
    const cButtons = ctrl.tags.filter((t) => t.tag === 'button' && 'data-view' in t.attrs && (t.attrs.class || '').includes('rail-btn'));
    const cDividers = ctrl.tags.filter((t) => (t.attrs.class || '').includes('rail-divider'));
    eq(cDividers.length, 1, 'CONTROL: re-pointing RAIL_DIVIDER_AFTER at a real view renders exactly one divider — the mechanism is alive, the shipped value is what says "none"');
    if (cDividers.length === 1) {
      const d = cDividers[0];
      const before = cButtons.filter((b) => b.index < d.index).sort((a, b) => b.index - a.index)[0];
      const after = cButtons.filter((b) => b.index > d.index).sort((a, b) => a.index - b.index)[0];
      eq(before.attrs['data-view'], 'chat', 'CONTROL: the divider follows the NAMED view, not a hardcoded index');
      eq(after.attrs['data-view'], 'domains', 'CONTROL: and the next button follows it');
      eq(d.attrs['aria-hidden'], 'true', 'CONTROL: the divider is hidden from assistive technology');
      eq(d.attrs.role, 'presentation', 'CONTROL: it carries role="presentation" — grouping, not a landmark');
    }
  }
}
// And a name the rail does NOT have draws nothing rather than throwing —
// the documented behaviour of the constant, now that null is the shipped
// value and a typo is the realistic way a bad one arrives.
{
  let ghost = null;
  try { ghost = render({ box: buildSandbox({ dividerAfter: 'not-a-view' }) }); }
  catch (err) { ok(false, `CONTROL sandbox (ghost) failed to build — ${err.message}`); }
  if (ghost) {
    ok(ghost.tags.filter((t) => (t.attrs.class || '').includes('rail-divider')).length === 0,
      'CONTROL: a RAIL_DIVIDER_AFTER naming no real view renders no divider and does not throw');
  }
}

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
// ── THE TWO NAMED RESTORE CASES (v3.64.0) ───────────────────────────────
// The loop above covers these because they ARE in ALL_VIEWS, which is the
// whole point — but a loop over a set cannot fail when a name is removed
// from that set, it just iterates one fewer time. These two lines can.
eq(pickStartView('ingest'), 'ingest',
  'a user who quit on Ingest lands on Ingest — leaving the rail did not make it unreachable');
eq(pickStartView('shared'), 'shared',
  'a user who quit on Shared Brain lands on Shared Brain, for the same reason');
// ALL_VIEWS IS A SET, NOT A BAG. It is built by spreading three arrays now
// rather than two, and a name in two of them would be silently harmless
// here while making VIEW_META's set equality below pass for the wrong
// reason (the sorted comparison would see a duplicate and fail — so this
// line is what tells the two failures apart in the output).
{
  const dupes = ALL_VIEWS.filter((v, i) => ALL_VIEWS.indexOf(v) !== i);
  ok(dupes.length === 0,
    `ALL_VIEWS holds no name twice — NAV_VIEWS + HOSTED_VIEWS + FOOTER_VIEWS are disjoint (dupes: ${JSON.stringify(dupes)})`);
}
ok(ALL_VIEWS.length === R.api.NAV_VIEWS.length + R.api.HOSTED_VIEWS.length + R.api.FOOTER_VIEWS.length,
  `ALL_VIEWS is exactly the three arrays concatenated (${R.api.NAV_VIEWS.length} + ${R.api.HOSTED_VIEWS.length} + ${R.api.FOOTER_VIEWS.length} = ${ALL_VIEWS.length})`);

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
// ════════════════════════════════════════════════════════════════════════
section('§9  THE DOMAIN REQUEST (P1-9) — recorded once, spent once, never stored');
// ════════════════════════════════════════════════════════════════════════
//
// The shell's other cross-view handoff, and the one the Context view's "Open
// in Domains" / "Ask this domain" / "+ New project" doors all ride on. Every
// property below regresses SILENTLY: a request that is not cleared re-opens a
// domain somebody asked for once, an hour later; a request that records a
// blank slug reads to the consumer as "a domain was asked for" when none was;
// and a `reason` the shell decided to interpret would make an arrival fail on
// a word the producer chose.
//
// EXECUTED, not scanned — these are the real functions out of app.js, in a
// sandbox with no DOM, because the pair touches nothing but one module
// variable and that is exactly what makes it testable here.
{
  let reqBox;
  try {
    reqBox = new Function(`
      ${extractFunction(appJs, 'requestDomain')}
      ${extractFunction(appJs, 'consumeDomainRequest')}
      let _pendingDomainRequest = null;
      const NEW_PROJECT_REASON = ${JSON.stringify(newProjectReasonLiteral)};
      return { requestDomain, consumeDomainRequest, NEW_PROJECT_REASON,
               __peek: () => _pendingDomainRequest };
    `)();
  } catch (err) {
    ok(false, `FATAL: could not build the request sandbox — ${err.message}`);
    reqBox = null;
  }

  if (reqBox) {
    const { requestDomain, consumeDomainRequest } = reqBox;

    // ── The happy path, and the shape the consumer is promised ──────────
    ok(consumeDomainRequest() === null,
      'with nothing pending, consumeDomainRequest() is null — not an object with a null slug');
    requestDomain('articles');
    const first = consumeDomainRequest();
    eq(first && first.slug, 'articles', 'a recorded slug comes back on the first consume');
    eq(first && first.reason, null, '…with reason null when none was given');

    // ── SELF-CLEARING. The whole reason this is module state and not a
    //    localStorage key: a second read must find nothing, or every later
    //    Domains mount re-applies one old click.
    ok(consumeDomainRequest() === null,
      'the SECOND consume in a row is null — the request is spent by reading it');
    requestDomain('alpha');
    consumeDomainRequest();
    ok(reqBox.__peek() === null,
      '…and the module variable itself is cleared, not merely reported as spent');

    // ── A BLANK REQUEST IS NO REQUEST, and it also CLEARS a pending one.
    //    The consumer's contract is "a slug or nothing"; recording
    //    {slug: null} would make "nobody asked" indistinguishable from
    //    "somebody asked for nothing" at the point of use.
    requestDomain('alpha');
    requestDomain('');
    ok(consumeDomainRequest() === null, 'an empty slug clears a pending request rather than recording a blank one');
    requestDomain('alpha');
    requestDomain(null);
    ok(consumeDomainRequest() === null, '…and so does null');
    requestDomain('alpha');
    requestDomain(42);
    ok(consumeDomainRequest() === null, '…and so does a non-string, which a caller can reach through a typo');
    requestDomain('   ');
    ok(consumeDomainRequest() === null, '…and so does whitespace, which would otherwise pass a truthiness check');
    requestDomain('  beta  ');
    eq((consumeDomainRequest() || {}).slug, 'beta', 'a slug is trimmed, so a padded value still matches a real domain');

    // ── LAST WRITER WINS. Two doors pressed in one task is not a queue.
    requestDomain('alpha');
    requestDomain('beta');
    eq((consumeDomainRequest() || {}).slug, 'beta', 'a second request replaces the first — there is no queue to drain');

    // ── `reason` IS ADVISORY, and the shell attaches no meaning to it.
    requestDomain('alpha', { reason: 'anything-at-all' });
    eq((consumeDomainRequest() || {}).reason, 'anything-at-all',
      'an unrecognised reason is carried through untouched — the consumer ignores what it has not learned');
    requestDomain('alpha', { reason: '' });
    eq((consumeDomainRequest() || {}).reason, null, 'an empty reason is null, never the empty string');
    requestDomain('alpha', 'not-an-object');
    eq((consumeDomainRequest() || {}).reason, null, 'a non-object opts bag is ignored rather than thrown over');

    // ── THE ONE NORMALISATION. The design pass sketched the Context view's
    //    "+ New project" as `{openCreate: true}` while the build contract
    //    fixed the bag as `{reason?: string}`; both reach the consumer as ONE
    //    stored field, so the two packages cannot disagree at merge.
    requestDomain('alpha', { openCreate: true });
    eq((consumeDomainRequest() || {}).reason, reqBox.NEW_PROJECT_REASON,
      '{openCreate: true} normalises to the NEW_PROJECT_REASON literal');
    requestDomain('alpha', { openCreate: 'yes' });
    eq((consumeDomainRequest() || {}).reason, null,
      '…on `=== true` only, so a truthy string cannot switch a navigation into a form');
    requestDomain('alpha', { reason: 'other', openCreate: true });
    eq((consumeDomainRequest() || {}).reason, 'other',
      'an explicit reason wins over the shorthand — one field is stored, and it is `reason`');
  }

  // ── THE LITERAL IS EXPORTED, AND THE CONSUMER IMPORTS IT ──────────────
  // The producer (views/memory.js) and the consumer (views/domains.js) are
  // different packages. A string typed in both is a string that can be typed
  // differently in one, and the failure is a button that navigates correctly
  // and then silently does nothing else — no error, no warning.
  ok(/export const NEW_PROJECT_REASON = /.test(appJs),
    'NEW_PROJECT_REASON is EXPORTED from app.js, so neither side has to re-type it');
  {
    const domainsJs = readFileSync(path.join(ROOT, 'src/public/next/views/domains.js'), 'utf8');
    const importBlock = (/import \{([\s\S]*?)\} from '\.\.\/app\.js';/.exec(domainsJs) || [])[1] || '';
    ok(/\bNEW_PROJECT_REASON\b/.test(importBlock),
      'views/domains.js imports it from the shell rather than typing the string');
    ok(/\bconsumeDomainRequest\b/.test(importBlock),
      '…alongside consumeDomainRequest, the half that spends the request');
    ok(!/['"]new-project['"]/.test(domainsJs),
      '…and does not carry the literal itself anywhere');
  }
}

// ════════════════════════════════════════════════════════════════════════
section('§9b  THE DOMAIN-FOLD REQUEST (v3.64.0) — the third member of the family');
// ════════════════════════════════════════════════════════════════════════
//
// Ingest left the rail, so the onboarding panel's third step now sends
// somebody to the ADD SOURCES section of the domain page rather than to the
// full-page Ingest view. That handoff is a REQUEST, not a click, and the
// reason is specific: clicking a <summary> TOGGLES, and this fold is
// remembered per domain — so the click pattern the panel uses for a button
// (goToDomainsCreate) would SHUT the fold for exactly the users who had
// already opened it. "Open it" is idempotent; "click it" is not.
//
// Same three properties as §9, executed the same way, because the failure
// modes are the same three: a request that outlives its consume re-opens a
// section on every later Domains mount; a blank one is indistinguishable
// from nobody asking; and a literal typed on both sides can be typed
// differently on one.
{
  let foldBox = null;
  try {
    foldBox = new Function(`
      ${extractFunction(appJs, 'requestDomainFold')}
      ${extractFunction(appJs, 'consumeDomainFoldRequest')}
      let _pendingDomainFoldRequest = null;
      return { requestDomainFold, consumeDomainFoldRequest,
               __peek: () => _pendingDomainFoldRequest };
    `)();
  } catch (err) {
    ok(false, `FATAL: could not build the fold-request sandbox — ${err.message}`);
  }

  if (foldBox) {
    const { requestDomainFold, consumeDomainFoldRequest } = foldBox;
    ok(consumeDomainFoldRequest() === null, 'with nothing pending, consumeDomainFoldRequest() is null');
    requestDomainFold('add-sources');
    eq(consumeDomainFoldRequest(), 'add-sources', 'a recorded fold id comes back on the first consume');
    ok(consumeDomainFoldRequest() === null,
      'the SECOND consume in a row is null — spending it is what reading it does');
    requestDomainFold('add-sources');
    consumeDomainFoldRequest();
    ok(foldBox.__peek() === null, '…and the module variable itself is cleared, not merely reported as spent');
    requestDomainFold('add-sources');
    requestDomainFold('');
    ok(consumeDomainFoldRequest() === null, 'an empty id CLEARS a pending request rather than recording a blank one');
    requestDomainFold('add-sources');
    requestDomainFold(null);
    ok(consumeDomainFoldRequest() === null, '…and so does null');
    requestDomainFold('add-sources');
    requestDomainFold(42);
    ok(consumeDomainFoldRequest() === null, '…and so does a non-string, which a caller can reach through a typo');
    requestDomainFold('   ');
    ok(consumeDomainFoldRequest() === null, '…and so does whitespace, which would pass a truthiness check');
    eq((requestDomainFold('  add-sources  '), consumeDomainFoldRequest()), 'add-sources',
      'a padded id is trimmed at the single writer, so the consumer never has to');
    requestDomainFold('a');
    requestDomainFold('b');
    eq(consumeDomainFoldRequest(), 'b', 'a second request replaces the first — there is no queue to drain');
  }

  // THE LITERAL IS EXPORTED, for the NEW_PROJECT_REASON reason: the producer
  // (views/onboarding.js) and the consumer (views/domains.js) are different
  // packages, and the failure a twice-typed string produces is a step that
  // navigates correctly and then silently does nothing else.
  const foldLiteral = (/export const ADD_SOURCES_FOLD = '([^']+)';/.exec(appJs) || [])[1] || null;
  eq(foldLiteral, 'add-sources', 'ADD_SOURCES_FOLD is exported from app.js, and is the id both sides use');
  {
    const obSrc = readFileSync(path.join(ROOT, 'src/public/next/views/onboarding.js'), 'utf8');
    const importBlock = (/import \{([\s\S]*?)\} from '\.\.\/app\.js';/.exec(obSrc) || [])[1] || '';
    ok(/\bADD_SOURCES_FOLD\b/.test(importBlock) && /\brequestDomainFold\b/.test(importBlock),
      'views/onboarding.js imports the constant and the writer from the shell rather than typing either');
  }
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
