/**
 * test-next-settings-default-section.js — OFFLINE suite, zero dependencies.
 *
 * Guards the fix for: Settings always mounted on "Providers & keys" instead
 * of "General", the first row in the sidebar. Both the macOS tray's
 * `Settings…` item and the in-app rail button resolve to the same
 * `navigate('settings')` -> `onEnter` -> `freshState()`, so there was ONE
 * cause with two symptoms: `freshState()`'s `section:` field was hardcoded to
 * `'providers'` ("matches the design prototype's default state" — a comment
 * justifying a value that had drifted from what the prototype actually
 * showed first), and `onEnter`'s mount-time prefetch
 * (`ensureSectionData('providers', mountToken)`) agreed with it. Two
 * hand-typed literals, in two places, that happened to agree with each other
 * but not with `SETTINGS_SECTIONS` — the array `renderSidebar` actually walks
 * to draw the rail in order, so General is first ON SCREEN and was never
 * first ON MOUNT.
 *
 * THE FIX is not "change 'providers' to 'general'" — a second hand-typed
 * literal is exactly how this drifted the first time, and a future reorder
 * of SETTINGS_SECTIONS would silently reopen the bug. Both sites now read
 * `SETTINGS_SECTIONS[0][0]`, so the landing section and the sidebar order
 * cannot disagree by construction.
 *
 * WHAT THIS SUITE MUST NOT DO: assert `state.section === 'general'` or
 * `argument === 'general'`. That is root cause 4 from
 * scripts/test-helpers/source-scan.js's own docblock — pinning a LITERAL that
 * happens to equal what the code currently computes proves nothing about
 * whether the code DERIVES it. Every assertion below reads
 * `SETTINGS_SECTIONS` out of the live file and compares against THAT, never
 * against a string retyped here.
 *
 * TECHNIQUE: the same brace-matched extraction + `new Function` execution
 * scripts/test-next-settings-scroll-and-scale.js and
 * scripts/test-next-loading-gate.js use, via the shared
 * scripts/test-helpers/source-scan.js helpers. `freshState()` is a pure
 * object literal (verified below — no free-variable calls in its body other
 * than the SETTINGS_SECTIONS lookup), so it is extracted and RUN for real.
 * `onEnter`'s mount-time prefetch call is scoped to `onEnter` specifically
 * (via `functionSource`, not a file-wide regex) so a same-named call
 * elsewhere in the file — `wireGlobalListeners`' section-switch handler also
 * calls `ensureSectionData(state.section, myMountToken)` — cannot stand in
 * for the mount-time one; its argument expression is then evaluated against
 * the real, extracted `SETTINGS_SECTIONS`, not retyped.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stripComments, functionSource } from './test-helpers/source-scan.js';
// The REAL docs-link builder (see §6b). Imported rather than stubbed so a
// fold's "Read more in the guide" is proved to resolve through the frozen
// table in shared/docs-links.js, whose keys scripts/test-docs-links.js
// checks against the actual markdown headings in docs/.
import { docsLinkHtml } from '../src/public/next/shared/docs-links.js';
// The REAL sidebar kit, injected into the lifted `renderSidebar` below.
import { renderSidebarHead, renderSidebarGroup, renderSidebarRow } from '../src/public/next/shared/sidebar.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${label}\x1b[0m`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

const settingsSrc = readFileSync(join(NEXT, 'views/settings.js'), 'utf8');
/** settings.js as the ENGINE reads it — every scan below reads THIS, not the
 *  raw file, so a deleted/changed line left behind as a `//` comment cannot
 *  satisfy a positive assertion (the lesson recorded at the top of
 *  test-next-settings-scroll-and-scale.js). */
const settingsCode = stripComments(settingsSrc);

// ── §0  Pull SETTINGS_SECTIONS out of the live file and execute it ────────
console.log('\n§0  SETTINGS_SECTIONS, extracted and executed (never retyped)');
const SECTIONS_SRC = /const SETTINGS_SECTIONS = \[[\s\S]*?\n\];/.exec(settingsCode);
ok(!!SECTIONS_SRC, 'SETTINGS_SECTIONS is found in views/settings.js');
const SETTINGS_SECTIONS = SECTIONS_SRC ? new Function(SECTIONS_SRC[0] + '\nreturn SETTINGS_SECTIONS;')() : null;
ok(Array.isArray(SETTINGS_SECTIONS) && SETTINGS_SECTIONS.length > 1,
  `SETTINGS_SECTIONS is a real array with more than one entry (${SETTINGS_SECTIONS ? SETTINGS_SECTIONS.length : 0} found) — a one-entry array could never expose a first-vs-default disagreement`);
eq(SETTINGS_SECTIONS[0][0], 'general',
  'sanity check on the fixture, not the fix: General really is the first row today (renderSidebar walks this same array in order to draw the rail)');

// ── §1  freshState()'s default section is DERIVED from the array ──────────
console.log("\n§1  freshState()'s mount-time default equals SETTINGS_SECTIONS[0][0]");
const freshStateSrc = functionSource(settingsCode, 'freshState');
ok(freshStateSrc !== null, 'freshState() is found in views/settings.js');
// CONTROL on the extraction itself: freshState() must be a pure object
// literal referencing only SETTINGS_SECTIONS, or "run it" below would either
// throw (safe) or silently depend on some OTHER free variable this suite
// never wires up (unsafe — a ReferenceError inside a try/catch would look
// like "it works" for the wrong reason). Scoped to freshState's own body via
// functionSource, so a call living in a sibling function cannot count.
ok(freshStateSrc !== null && !/[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(freshStateSrc.replace(/^function freshState\s*\(\)\s*\{/, '')),
  'CONTROL: freshState() calls nothing else — it is a plain object literal, so executing it exercises exactly one free variable (SETTINGS_SECTIONS) and nothing this suite has not accounted for');
let defaultSection = null;
if (freshStateSrc) {
  const freshStateFn = new Function('SETTINGS_SECTIONS', freshStateSrc + '\nreturn freshState;')(SETTINGS_SECTIONS);
  const state = freshStateFn();
  defaultSection = state.section;
}
eq(defaultSection, SETTINGS_SECTIONS[0][0],
  'EXECUTED: the real freshState(), run for real, sets state.section to SETTINGS_SECTIONS[0][0] — derived from the array, not a hand-typed literal that happens to agree with it today');

// ── §2  onEnter's mount-time prefetch targets the SAME section ────────────
console.log('\n§2  onEnter\'s mount-time prefetch agrees with the default — the two sites that disagreed');
const onEnterSrc = functionSource(settingsCode, 'onEnter');
ok(onEnterSrc !== null, 'onEnter() is found (scoped extraction — a same-named ensureSectionData(...) call in wireGlobalListeners\' section-switch handler must not be able to stand in for this one)');
const PREFETCH_RE = /ensureSectionData\(([^,]+),\s*mountToken\)/;
const prefetchMatch = onEnterSrc ? PREFETCH_RE.exec(onEnterSrc) : null;
ok(!!prefetchMatch, 'onEnter() prefetches via ensureSectionData(<something>, mountToken) — the mount-time call this whole suite exists to pin');
let prefetchSection = null;
if (prefetchMatch) {
  // EXECUTE the real argument expression against the real, extracted array —
  // never a textual comparison of the two call sites' source strings, which
  // could be satisfied by two DIFFERENT hardcoded literals that happen to
  // read the same.
  prefetchSection = new Function('SETTINGS_SECTIONS', `return (${prefetchMatch[1]});`)(SETTINGS_SECTIONS);
}
eq(prefetchSection, SETTINGS_SECTIONS[0][0],
  'EXECUTED: the prefetch argument, evaluated for real, resolves to SETTINGS_SECTIONS[0][0]');
eq(prefetchSection, defaultSection,
  'AND the two sites agree with EACH OTHER — this is the actual shape of the bug: two independently-typed literals that agreed with each other while disagreeing with the sidebar order');

// ── §3  Anti-vacuity control: prove the check above can actually fail ─────
console.log('\n§3  CONTROL — the agreement check is capable of reporting a mismatch');
// The two assertions above cannot be trusted on their own: if `checkAgreement`
// always returned true, or if SETTINGS_SECTIONS/defaultSection/prefetchSection
// were all derived from the same expression by construction, every run would
// pass regardless of what the source says. This proves the comparison itself
// can fail, using a FABRICATED sections array whose first entry differs from
// what a (simulated) hardcoded default and prefetch would produce — exactly
// the historical shape: two literals ('providers') agreeing with each other
// while disagreeing with the array's real first entry ('zzz-mutated-first').
function checkAgreement(sections, actualDefault, actualPrefetch) {
  const expected = sections[0][0];
  return {
    expected,
    defaultMatches: actualDefault === expected,
    prefetchMatches: actualPrefetch === expected,
  };
}
// Positive control: the REAL values computed above must agree via this same
// function (proves checkAgreement is not simply always-false either).
const realCheck = checkAgreement(SETTINGS_SECTIONS, defaultSection, prefetchSection);
ok(realCheck.defaultMatches && realCheck.prefetchMatches,
  'CONTROL: checkAgreement reports a MATCH on the real, unmutated values — so a false-negative in §1/§2 above is not being masked by an always-red comparator');
// Negative control: a fabricated array whose first entry does not match two
// literals that agree with each other but not with it.
const fabricatedSections = [['zzz-mutated-first', 'Mutated', ''], ...SETTINGS_SECTIONS.slice(1)];
const mismatchCheck = checkAgreement(fabricatedSections, 'providers', 'providers');
ok(mismatchCheck.defaultMatches === false,
  'CONTROL: checkAgreement reports a MISMATCH when the (simulated) default disagrees with the fabricated array\'s first entry — proving §1\'s assertion is capable of failing, not just capable of passing');
ok(mismatchCheck.prefetchMatches === false,
  'CONTROL: …and likewise for the prefetch side — proving §2\'s assertion is capable of failing');
// And a control on the control: two literals that DO agree with a fabricated
// array's first entry must still report a match, so this isn't a comparator
// that only ever says "mismatch".
const agreeingCheck = checkAgreement(fabricatedSections, 'zzz-mutated-first', 'zzz-mutated-first');
ok(agreeingCheck.defaultMatches && agreeingCheck.prefetchMatches,
  'CONTROL: …and reports a MATCH when the values genuinely agree with a different (fabricated) first entry — the comparator is not simply always-false');

// ── §4  THE ORDER OF THE ROWS (v3.49.0) ──────────────────────────────────
console.log('\n§4  THE SIDEBAR ORDER — deliberately pinned, and here is why');
// ─────────────────────────────────────────────────────────────────────────
// UNTIL v3.49.0 NOTHING PINNED THE ORDER, only that General was first. The
// rail ran General -> Providers -> MCP -> Health -> Knowledge base, which was
// the order the sections happened to be BUILT in, and a power user's report
// was that the thing he came back for most — Software update — was at the
// bottom of the screen.
//
// The order is now by how often a person returns to a section, and this
// section EXISTS TO STOP A REVERT: re-sorting this array back into build
// order is not a tidy-up, it is the defect. If a future release genuinely
// re-decides the order, this block is the place to record that decision —
// change it deliberately, with the reason, rather than deleting it to go
// green.
//
// THE ONE THING THAT IS NOT HERE: a "Software update" row. It is a BLOCK
// inside General (the first one — see renderGeneral), not a section, because
// it is a multi-state panel that shares state.version and the install-mode
// capability with the rest of General, and the sidebar footer's "Updates"
// button already lands on it. §5 pins that it is General's first block, so
// the two halves of this decision cannot drift apart.
const EXPECTED_ORDER = ['general', 'providers', 'storage', 'mcp', 'health'];
const actualOrder = SETTINGS_SECTIONS.map(([id]) => id);
ok(JSON.stringify(actualOrder) === JSON.stringify(EXPECTED_ORDER),
  `the rail is ordered by how often a section is returned to: ${EXPECTED_ORDER.join(' -> ')} (got ${actualOrder.join(' -> ')})`);
ok(actualOrder.indexOf('storage') < actualOrder.indexOf('mcp'),
  'Knowledge base is ABOVE the MCP bridge — "where does my wiki live" is asked far more often than a bridge that is set up once per client');
ok(actualOrder.indexOf('health') === actualOrder.length - 1,
  'Health & scan limits is last — cost ceilings are touched only when a scan refuses to run');

// EXECUTED, not scanned: the real renderSidebar, run against the real array,
// must emit the rows in that order. renderSidebar is what a user sees; the
// array is only its input, and a renderer that sorted or reversed it would
// leave every assertion above green.
const renderSidebarSrc = functionSource(settingsCode, 'renderSidebar');
ok(renderSidebarSrc !== null, 'renderSidebar() is found in views/settings.js');
let renderedIds = null;
if (renderSidebarSrc) {
  let captured = '';
  // `lastSidebarHtml` is the module-level string renderSidebar compares
  // against so an unchanged sidebar is not re-written (see render()'s "ONE
  // PAINT, OR NONE"). Injected as a binding it can assign to, seeded null so
  // this call is always the FIRST one and therefore always paints — an
  // undefined binding would be a ReferenceError crash here rather than a
  // failing assertion, which is the FN_NAMES shape this repo names.
  // THE KIT'S THREE FUNCTIONS ARE INJECTED, AND THEY ARE THE REAL ONES
  // (v3.65.0). `renderSidebar` now builds through shared/sidebar.js, and a
  // module-level import is NOT visible inside a body lifted by
  // `functionSource` — a free `renderSidebarRow` there is a ReferenceError,
  // i.e. a suite that CRASHES instead of asserting. They are passed through
  // the constructor rather than stubbed so what is executed below is the
  // shipped component, exactly as it is on the screen.
  const fn = new Function(
    'SETTINGS_SECTIONS', 'state', 'escapeHtml', 'setSidebar', 'lastSidebarHtml',
    'renderSidebarHead', 'renderSidebarGroup', 'renderSidebarRow',
    renderSidebarSrc + '\nreturn renderSidebar;'
  )(SETTINGS_SECTIONS, { section: 'general', version: null }, (x) => String(x), (html) => { captured = html; }, null,
    renderSidebarHead, renderSidebarGroup, renderSidebarRow);
  fn(1);
  renderedIds = [...captured.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]);
}
ok(renderedIds !== null && renderedIds.length === SETTINGS_SECTIONS.length,
  `CONTROL: the rendered rail really was parsed — ${renderedIds ? renderedIds.length : 0} rows found, ${SETTINGS_SECTIONS.length} expected (an empty parse would pass the order check below by accident)`);
ok(renderedIds !== null && JSON.stringify(renderedIds) === JSON.stringify(EXPECTED_ORDER),
  `EXECUTED: renderSidebar paints the rows in that order (got ${renderedIds ? renderedIds.join(' -> ') : 'nothing'})`);

// A REORDER MUST NOT ORPHAN A SECTION. renderMain dispatches by id with a
// final `else`, so order cannot break it — but a row whose id no arm names
// and which is not the fallback would render the fallback's body under
// someone else's title, silently.
const renderMainSrc = functionSource(settingsCode, 'renderMain');
ok(renderMainSrc !== null, 'renderMain() is found');
if (renderMainSrc) {
  const named = new Set([...renderMainSrc.matchAll(/state\.section === '([a-z]+)'/g)].map((m) => m[1]));
  const unnamed = actualOrder.filter((id) => !named.has(id));
  ok(unnamed.length === 1,
    `exactly one section id is unnamed in renderMain and therefore takes the final else (found: ${unnamed.join(', ') || 'none'}) — two would mean one section renders another's body`);
  ok(named.size + 1 === SETTINGS_SECTIONS.length,
    `CONTROL: every row has a body — ${named.size} explicit arms + 1 fallback for ${SETTINGS_SECTIONS.length} rows`);
}

// ── §5  SOFTWARE UPDATE IS GENERAL'S FIRST BLOCK (v3.49.0) ────────────────
console.log('\n§5  Software update opens the General section');
// ─────────────────────────────────────────────────────────────────────────
// The other half of §4's decision, and the half the report was actually
// about. Asserted by POSITION inside renderGeneral's own body — a substring
// check would have been green throughout the defect, because the block was
// always present, just third.
//
// The block's CONTENTS are not asserted here: its copy, its buttons and its
// phase ring are pinned by scripts/test-update-in-app.js and
// scripts/test-update-installer.js, and nothing about them changed.
const renderGeneralSrc = functionSource(settingsCode, 'renderGeneral');
ok(renderGeneralSrc !== null, 'renderGeneral() is found');
if (renderGeneralSrc) {
  const iUpdates = renderGeneralSrc.indexOf('id="block-updates"');
  const iGroup = renderGeneralSrc.indexOf('cur-group cur-group-fields');
  const iCheck = renderGeneralSrc.indexOf('btn-run-quick-check');
  const iGuide = renderGeneralSrc.indexOf('btn-show-setup-guide');
  ok(iUpdates >= 0 && iGroup >= 0 && iCheck >= 0 && iGuide >= 0,
    `CONTROL: all four of General's blocks were located (${iUpdates}/${iGroup}/${iCheck}/${iGuide}) — a missing one would make the comparisons below vacuous`);
  ok(iUpdates < iGroup, 'Software update comes BEFORE the appearance group — the reported defect');
  ok(iUpdates < iCheck, '…and before System check');
  ok(iUpdates < iGuide, '…and before the Setup guide, so it is the first thing the section shows');
  ok(renderGeneralSrc.indexOf('id="block-updates"', iUpdates + 1) === -1,
    'there is exactly one update block — it was MOVED, not copied');
}

// ── §6  GENERAL IS FOUR UNNUMBERED BLOCKS, AND THE LEDES ARE SHORT ────────
console.log('\n§6  General uses settingsBlock, and no lede runs past 13 words');
// ─────────────────────────────────────────────────────────────────────────
// §5 above pins the ORDER of the four blocks. This pins the SHAPE they now
// have, and it is driven rather than grepped: renderGeneral is lifted out of
// the live file with its own helpers and EXECUTED against a stub state, so
// "the lede is at most twenty words" is measured on the string a user is
// served, not on a source literal that a later concatenation could lengthen.
//
// WHY A WORD COUNT IS A GUARD AT ALL. The pattern this release applies is a
// bold title, a lede of at most twenty visible words, and everything longer
// behind the ⓘ or deleted. A word count is the only part of that which a
// machine can check, and it is exactly the part that rots: the four blocks
// here opened with 29, 55, 29 and 25 words respectively, none of which was
// written as a paragraph — each grew one clarifying clause at a time.
{
  /** Brace-matched function source, from the COMMENT-STRIPPED file so a
   *  deleted call left behind as `// …` cannot satisfy anything below. */
  function fnSrc(name) {
    const m = new RegExp(`(?:^|\\n)function ${name}\\s*\\(`).exec(settingsCode);
    if (!m) throw new Error(`§6: function ${name} not found`);
    const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
    let i = settingsCode.indexOf('{', settingsCode.indexOf('(', start)), depth = 0;
    for (; i < settingsCode.length; i++) {
      if (settingsCode[i] === '{') depth++;
      else if (settingsCode[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const out = settingsCode.slice(start, i);
    if (!/\n\}$/.test(out)) throw new Error(`§6: function ${name} desynced`);
    return out;
  }
  function constSrc(re, what) {
    const m = re.exec(settingsCode);
    if (!m) throw new Error(`§6: ${what} not found`);
    return m[0];
  }

  // ── 6a  THE SOURCE-LEVEL HALF ──────────────────────────────────────────
  const gsrc = functionSource(settingsCode, 'renderGeneral');
  ok(gsrc !== null, 'renderGeneral() is found');
  const nullBlocks = (gsrc.match(/settingsBlock\(null,/g) || []).length;
  ok(nullBlocks >= 4,
    `renderGeneral composes at least four settingsBlock(null, …) blocks (found ${nullBlocks}) — the same ` +
    'component Providers & keys uses, and `null` because none of General\'s four is step 1 of anything');
  ok(!/class="settings-section"/.test(gsrc),
    'and it concatenates them BARE, with no .settings-section wrapper — that wrapper is `display: flex; ' +
    'gap: 24px` and the blocks already carry a 24px margin, so keeping both would put 73px between them');
  ok(!/settingsBlock\([0-9]/.test(gsrc),
    'no block here is numbered — a numeral would claim a reading order this section does not have');

  // ── 6b  EXECUTED ───────────────────────────────────────────────────────
  // Only the four functions whose OUTPUT is being measured are lifted;
  // everything else is a stub passed in by name, so an unlisted collaborator
  // is a named ReferenceError here rather than a wrong answer in the app.
  const pieces = [
    constSrc(/const TX_INFO_GLYPH =[\s\S]*?';\n/, 'TX_INFO_GLYPH'),
    constSrc(/const UPDATE_RECOVERY_INFO =[\s\S]*?;\n/, 'UPDATE_RECOVERY_INFO'),
    constSrc(/const UPDATE_RECOVERY_INFO_INSTALLER =[\s\S]*?;\n/, 'UPDATE_RECOVERY_INFO_INSTALLER'),
    constSrc(/const BACKGROUND_MODE_LABELS = \{[\s\S]*?\n\};/, 'BACKGROUND_MODE_LABELS'),
    fnSrc('infoMark'), fnSrc('settingsBlock'), fnSrc('installUpdateStyle'),
    fnSrc('renderTextSize'), fnSrc('renderBackgroundMode'), fnSrc('renderGeneral'),
  ].join('\n\n');

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const STUBS = {
    escapeHtml: esc,
    // THE REAL ONE, imported at the top of this file — not a stub. A fold that
    // promises "Read more in the guide" and emits a dead href is the rot
    // shared/docs-links.js exists to prevent, and docsUrl() THROWS on a key
    // that is not in its table, so a typo reds this suite here.
    docsLinkHtml,
    icon: () => '<svg aria-hidden="true"></svg>',
    currentTheme: () => 'dark',
    currentFontScale: () => 'default',
    fontScaleOptions: () => [['default', 'Default', 'The default size']],
    updatesAreBusy: () => false,
    renderUpdateStatus: () => '<div class="upd-status"></div>',
    renderQuickSummary: () => '',
    renderLiveConfirm: () => '',
    renderLiveResult: () => '',
  };
  const BASE = {
    quick: null, live: null, liveConfirmOpen: false, quickLoading: false,
    updateChecking: false,
    config: { backgroundModes: ['window', 'tray', 'tray-only'], backgroundMode: 'tray' },
    version: { version: '9.9.9' },
  };
  function renderWith(state, updaterAttached) {
    const names = [...Object.keys(STUBS), 'state', 'inAppUpdate', 'updaterAttached'];
    const vals = [...Object.keys(STUBS).map((k) => STUBS[k]), state, null, updaterAttached];
    return new Function(...names, pieces + '\nreturn renderGeneral;')(...vals)();
  }

  // THE THREE INSTALL MODES. The update lede forks on them, so a count taken
  // in one mode says nothing about the other two — and the longest of the
  // three paragraphs this replaced (43 words) was the one only a packaged
  // build with no attached updater ever saw.
  const INSTALLER = { ...BASE, version: { version: '9.9.9', capabilities: { updateStyle: 'download-installer' } } };
  const MODES = [
    ['git checkout', BASE, null],
    ['packaged, updater attached', INSTALLER, true],
    ['packaged, no updater', INSTALLER, false],
  ];
  const stripTags = (h) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  let rendered = null, worst = 0, ledesSeen = 0, renderErr = null;
  for (const [label, st, attached] of MODES) {
    let html = '';
    try { html = renderWith(st, attached); } catch (e) { renderErr = `${label}: ${e && e.message}`; }
    ok(renderErr === null, `renderGeneral runs for "${label}"${renderErr ? ` — it does not: ${renderErr}` : ''}`);
    if (renderErr) break;
    if (label === 'git checkout') rendered = html;
    const ledes = [...html.matchAll(/<p class="settings-job-lede settings-block-lede">([\s\S]*?)<\/p>/g)]
      .map((m) => stripTags(m[1]));
    eq(ledes.length, 4, `"${label}" renders four ledes, one per block`);
    for (const l of ledes) {
      const n = l.split(/\s+/).filter(Boolean).length;
      ledesSeen++;
      worst = Math.max(worst, n);
      ok(n <= 13, `"${label}" lede is ${n} visible words (ceiling 13, the v3.58.0 rule): ${l}`);
    }
  }
  ok(ledesSeen === 12, `CONTROL: twelve ledes were actually measured across the three modes (got ${ledesSeen}) — ` +
    'a mode that silently rendered none would make the ceiling above vacuous');
  console.log(`      (longest lede across all three install modes: ${worst} words)`);

  // ── 6c  THE FAILURE-MODE SENTENCE IS NOT BEHIND A CLICK ────────────────
  // v3.16.1: a warning behind a click is not a warning. Three separate things
  // can eat a new menu bar icon on a modern Mac and macOS gives an app no way
  // to find out which, so the setting says so itself — VISIBLY, whenever the
  // icon is on. Everything neutral about the same control moved under the
  // Appearance block's ⓘ in this release, which is exactly the edit that could
  // take this with it by accident.
  const NEEDLE = 'If the icon does not appear';
  /** Remove every balanced <div …> subtree whose opening tag matches `startRe`. */
  function dropSubtrees(html, startRe) {
    let out = html, guard = 0, removed = 0;
    while (guard++ < 50) {
      const m = new RegExp(startRe).exec(out);
      if (!m) break;
      const scan = /<div\b|<\/div>/g;
      scan.lastIndex = m.index;
      let depth = 0, end = -1, t;
      while ((t = scan.exec(out)) !== null) {
        if (t[0] === '</div>') { depth--; if (depth === 0) { end = t.index + t[0].length; break; } }
        else depth++;
      }
      if (end === -1) break;
      out = out.slice(0, m.index) + out.slice(end);
      removed++;
    }
    return { out, removed };
  }
  if (rendered) {
    ok(rendered.includes(NEEDLE),
      'with the menu bar icon ON, the failure-mode sentence is in the rendered HTML');
    const iconOff = renderWith({ ...BASE, config: { backgroundModes: ['window', 'tray', 'tray-only'], backgroundMode: 'window' } }, null);
    ok(!iconOff.includes(NEEDLE),
      'CONTROL: and it is absent with the icon OFF, so the assertion above is about the ON state and not about the string existing');

    const folds = dropSubtrees(rendered, '<div class="settings-block-info">');
    const panels = dropSubtrees(folds.out, '<div class="tx-vh-panel"');
    ok(folds.removed + panels.removed >= 4,
      `CONTROL: the fold remover really removed something (${folds.removed} info wrappers + ${panels.removed} loose panels) — ` +
      'without this, "the sentence survived" would be satisfied by a remover that does nothing');
    ok(!/Read more in the guide/.test(panels.out),
      'CONTROL: …and what it removed was the folds — every "Read more in the guide" is gone from the remainder');
    ok(panels.out.includes(NEEDLE),
      'the failure-mode sentence SURVIVES the removal of every fold and hidden panel — it is on screen, not behind the ⓘ');
    // ANCHORED INSIDE A TAG. A bare /\shidden/ also matches the sentence's own
    // prose — "filed into a hidden section by a menu bar organiser" — so the
    // first draft of this line went red on the very string it is guarding.
    ok(!/<[^>]*\shidden[\s>]/.test(panels.out),
      'and nothing else in General is emitted with a hidden ATTRIBUTE, so there is no second place the sentence could have been parked');
    // The per-mode consequence line is the other thing the design pass was
    // told to keep visible. It is generated from BACKGROUND_MODE_LABELS, so
    // pinning the table's own second column keeps this honest.
    ok(panels.out.includes('A menu bar icon showing what your agents have just saved'),
      'and so does the ACTIVE mode\'s consequence line — the sentence that replaced a hover-only title= in v3.44.0');
  }
}

// ═════════════════════════════════════════════════════════════
console.log('\n§5  THE SIDEBAR IS THE APP’S ONE SIDEBAR (v3.65.0)');
// ═════════════════════════════════════════════════════════════
//
// EXECUTED against the REAL component, on the same lifted `renderSidebar` §4
// runs, because what the maintainer reported is a rendered thing: *"the same
// goes for the Settings sidebar: follow the Domains pattern — use the Updates
// button, put it on top in the same design as Domains ... if I select General
// I get a violet line on the left; we don\u2019t get this in Domains or Context
// ... we don\u2019t need this line."*
{
  let out = '';
  const paint = (state) => {
    let captured = '';
    new Function(
      'SETTINGS_SECTIONS', 'state', 'escapeHtml', 'setSidebar', 'lastSidebarHtml',
      'renderSidebarHead', 'renderSidebarGroup', 'renderSidebarRow',
      renderSidebarSrc + '\nreturn renderSidebar;'
    )(SETTINGS_SECTIONS, state, (x) => String(x), (html) => { captured = html; }, null,
      renderSidebarHead, renderSidebarGroup, renderSidebarRow)(1);
    return captured;
  };
  out = paint({ section: 'mcp', version: { version: '3.65.0', restartRequired: false } });

  ok(/class="btn btn-secondary cur-sb-secondary" id="settings-updates-btn"/.test(out),
    'UPDATES IS THE TOP SECONDARY \u2014 the slot Domains gives "Use existing folder", '
    + 'with the id its handler binds to unchanged');
  const upAt = out.indexOf('settings-updates-btn');
  const listAt = out.indexOf('cur-sb-list');
  const footAt = out.indexOf('settings-sidebar-footer');
  ok(upAt > 0 && listAt > upAt,
    '\u2026ON TOP: it is emitted before the row list, not after it');
  ok(footAt > listAt && upAt < footAt,
    '\u2026and it has LEFT the footer, which now holds the version label alone');
  ok(/settings-sidebar-footer"><span class="mono settings-version">The Curator v3.65.0<\/span><\/div>/.test(out),
    '\u2026exactly alone: a version string is a reading, not an action (R6)');

  ok(/class="cur-sb-row settings-nav-row active"/.test(out),
    'the selected row is the FILLED row \u2014 the kit\u2019s `active` class, and nothing else');
  ok((out.match(/class="cur-sb-row settings-nav-row active"/g) || []).length === 1,
    '\u2026exactly one of them');
  ok(!/::before|sidebar-edge|nav-edge/.test(out),
    '\u2026with no edge element of any kind in the markup (R10)');

  // THE ALIAS IS NOT DECORATION: this view’s own click binder queries
  // `.settings-nav-row`, views/onboarding.js’s "open the MCP bridge" door
  // queries `.settings-nav-row[data-section="mcp"]`, and four suites name the
  // tokens. A kit adoption that dropped them would break a door and three
  // sandboxes, silently.
  for (const token of ['cur-sb-list settings-nav-list', 'cur-sb-row settings-nav-row',
                       'cur-sb-name row-label', 'cur-sb-event row-hint']) {
    ok(out.includes(token), `both names ride the same element: \`${token}\``);
  }
  ok(/\.settings-nav-row\[data-section="mcp"\]/.test(
       readFileSync(join(NEXT, 'views/onboarding.js'), 'utf8')),
    'CONTROL: views/onboarding.js really does still query that pair \u2014 the alias is load-bearing, '
    + 'not sentiment');

  // THE OMITTED SLOTS. Settings rows are a name and a hint; passing an empty
  // figure or a missing age must render NOTHING rather than an empty 11px
  // line that opens a gap under every label.
  ok(!out.includes('cur-sb-meta') && !out.includes('cur-sb-dot')
     && !out.includes('cur-sb-figure') && !out.includes('cur-sb-age'),
    'the dot, the figure and the age line are OMITTED, not rendered empty');
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
