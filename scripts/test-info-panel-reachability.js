#!/usr/bin/env node
/**
 * LIVE_LOCAL — info-panel reachability. $0, no API key, no network beyond
 * localhost. Needs a BROWSER, which is the only reason it is not offline.
 *
 * ── WHAT IT PROVES, AND WHY NOTHING OFFLINE CAN ────────────────────────────
 * `renderViewHeader` puts a circled-i beside a view title; clicking it opens a
 * panel holding the one paragraph that explains the screen — on Sync, the git
 * recovery route a user needs when something has gone wrong.
 *
 * The offline guard (test-next-view-header.js) proves panel ids are UNIQUE and
 * that the `infoId` override WORKS. In v3.24.0 both stayed true while the
 * feature was broken: a sidebar header and a main header of the same view
 * derived the same panel id, `document.getElementById` returned the first in
 * document order, and clicking the MAIN mark opened the SIDEBAR's panel while
 * the main panel sat at 0x0 with `offsetParent === null`. `aria-expanded`
 * flipped to "true" on the correct button, `aria-controls` was populated, the
 * prose was in the DOM — and no user, keyboard or screen reader could reach it.
 * All 120 offline suites were green.
 *
 * Every attribute-level assertion is satisfied by that state. Only geometry
 * measured in a real browser separates "the panel opened" from "a panel
 * opened". That is the whole reason this file exists.
 *
 * ── SELF-SKIP CONTRACT ─────────────────────────────────────────────────────
 * With no Chromium-family browser installed this prints a `⊘` line and NO
 * assertion tally, then exits 0 — the shape a live suite uses for a missing
 * API key, so `npm run test:live` on a bare machine is harmless. A skip is not
 * a pass and the output says so. `scripts/run-tests.js` classifies a run as
 * skipped only when it BOTH announces a skip AND prints no `Passed:` tally, so
 * both halves here are load-bearing.
 *
 * ── TWO PRODUCERS, BOTH IN SCOPE ───────────────────────────────────────────
 * This affordance is emitted from two places, and both are driven by the one
 * delegated listener in shared/text.js:
 *   · `renderViewHeader` (shared/text.js) — id DERIVED from the view title,
 *     which is what made a collision possible.
 *   · `infoMark` (views/settings.js, a deliberate local copy) — EXPLICIT id,
 *     rendered outside any header, beside the build-lane chip.
 * The first draft of this suite modelled only the first and reported the second
 * as broken. It is named for the affordance rather than for the view or the bug
 * because the thing worth protecting is that a circled-i opens ITS panel,
 * wherever the markup came from. §3 fails if a run stops reaching either one.
 *
 * ── ENFORCED ───────────────────────────────────────────────────────────────
 *  · No duplicate DOM id anywhere in the document, in any view, in either
 *    theme. Document-wide, because `getElementById` is.
 *  · Every mark's `data-tx-info` resolves to the panel it is PAIRED with, and
 *    `aria-controls` names the same panel (mouse and AT must not diverge).
 *  · Every VIEW-HEADER mark additionally resolves inside its own header — the
 *    specific shape only that producer can get wrong, since its ids are derived
 *    from the title.
 *  · Every mark is hit-testable at its own centre — nothing on top of it.
 *  · Every panel starts hidden.
 *  · Clicking a mark makes EXACTLY ONE panel visible, it is that header's own
 *    panel, it has a non-zero rect and a non-null offsetParent, and it carries
 *    the prose authored in that header.
 *  · Exactly one button reports itself expanded.
 *  · Escape closes every panel and returns focus to the button that opened it,
 *    not to <body>.
 *  · No console error during any of it.
 *  · §1 proves each detector above FIRES, by planting the defect in the live
 *    page and removing it. §3 proves the sweep was not vacuous.
 *
 * ── NOT ENFORCED (stated rather than implied away) ─────────────────────────
 *  · PANEL COPY. Assertions compare panel IDENTITY (which element, in which
 *    header) and that its prose is non-empty and unchanged by opening. No
 *    sentence is pinned, deliberately: a hardcoded sentence fails on a copy
 *    edit and passes on a re-collision the day two panels are reworded alike.
 *    Whether the words are the RIGHT words is not a browser question.
 *  · ONLY WHAT THIS FIXTURE RENDERS. Views are enumerated from the rail, never
 *    from a hardcoded list — but a header that appears only in a state the
 *    seeded fixture never reaches (an error branch, a configured Shared Brain,
 *    a mid-ingest queue) is not visited. §3 reports what was actually swept so
 *    a shrinking sweep is visible rather than silently green.
 *  · ONE VIEWPORT, ONE SCALE. 1280x860 at deviceScaleFactor 1. Occlusion and
 *    hit-testing are viewport-dependent; a mark reachable here could be
 *    covered at 375px. The shell is documented as collapsing below ~768px
 *    (CLAUDE.md v3.16.1) and that is a separate, known gap.
 *  · LIGHT DISMISS. Escape is exercised; the click-outside path in
 *    `wireInfoToggles` is not, because a click at an arbitrary coordinate can
 *    land on a real control and change the view under the next measurement.
 *  · KEYBOARD ACTIVATION. Enter/Space on a focused mark is inherited UA
 *    behaviour, and v3.22.0 records that this repo's harness does not carry
 *    the UA default activation. Only mouse activation is proven here.
 *  · CLEANUP SURVIVES A NORMAL EXIT, NOT A HARD KILL. Teardown is in a
 *    `finally` and signals only this run's own children, never a pattern — but
 *    a run killed outright leaves a headless Chrome and two tempdirs behind.
 *    Observed while building this: piping the output through `head` closed the
 *    pipe early and orphaned one browser tree. Run it unpiped, or redirect to a
 *    file. `test-visual-regression.js` has the same exposure; it is inherent to
 *    a spawned browser, not something either suite can trap.
 */

import { startIsolatedServer } from './visual/server.js';
import { launchBrowser } from './visual/browser.js';
import { CdpConnection, CdpPage } from './visual/cdp.js';
import * as probes from './visual/probes.js';
import { setTimeout as delay } from 'timers/promises';

const VIEWPORT = { w: 1280, h: 860 };
const THEMES = ['dark', 'light'];
const VIEW_SETTLE_MS = 700;   // views fetch on entry; measure after they land

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else {
    failed++;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail).slice(0, 500)}`);
  }
}
const section = (t) => console.log(`\n${t}`);

console.log('Info-panel reachability (real browser, real server, isolated tempdirs)\n');

// ── The skip gate comes before anything that costs work ────────────────────
const browser = await launchBrowser({ headless: true });
if (!browser) {
  console.log('⊘ SKIPPED — no Chromium-family browser found on this machine.');
  console.log('  Set CURATOR_VISUAL_BROWSER to a binary to run it.');
  console.log('  Nothing was measured. This is a skip, not a pass.');
  process.exit(0);
}

const server = await startIsolatedServer();
if (String(server.port) === '3333') {          // belt and braces; server.js refuses too
  await server.close(); await browser.close();
  throw new Error('refusing to measure on port 3333 — that is the live app');
}
console.log(`  browser: ${browser.binary}`);
console.log(`  server:  ${server.origin} (ephemeral, never 3333, both isolation seams set)\n`);

let conn = null, page = null;
// Accumulated across the whole sweep so §3 can prove it was not vacuous.
const cover = { views: new Set(), viewsWithMarks: new Set(), producers: new Set(), marksClicked: 0, maxMarksInOneDoc: 0, titleCollisions: [] };

try {
  conn = await CdpConnection.connect(browser.wsUrl);
  page = await CdpPage.create(conn);
  await page.setViewport(VIEWPORT.w, VIEWPORT.h);
  await page.navigate(server.origin);

  let booted = false;
  for (let i = 0; i < 60 && !booted; i++) {
    booted = await page.evaluate(() => !!window.__curatorBooted);
    if (!booted) await delay(100);
  }
  section('§0 Boot');
  ok(booted, 'the shell booted (window.__curatorBooted is set)');
  if (!booted) throw new Error('shell never booted — nothing below would mean anything');

  // ── §1 Detector controls ─────────────────────────────────────────────────
  // A clean sweep means nothing until the detectors have been shown to fire.
  // Each defect is planted in the LIVE page and then removed, so a detector
  // that has quietly stopped working cannot be reported as "no defects found".
  section('§1 Detector controls — each defect planted in the live page, then removed');
  {
    // Sync is chosen deliberately: it is the view that renders two info marks,
    // which the cross-header control needs. §3 fails loudly if that ever stops
    // being true, so this choice cannot rot into a control that plants nothing.
    const nav = await page.evaluate(probes.gotoView, server.port, 'sync');
    ok(nav.ok && nav.active === 'sync', 'entered Sync (the two-mark view the controls are planted in)', nav);
    await delay(VIEW_SETTLE_MS);

    const survey = () => page.evaluate(probes.infoPanelSurvey, server.port);
    const plant = (k) => page.evaluate(probes.mutateForControl, server.port, k);
    const restore = () => page.evaluate(probes.mutateForControl, server.port, 'restore');
    const clean = await survey();

    const controls = [
      ['duplicate-id', 'dup-id', (s) => s.dupIds.length > 0,
        'a second element carrying an existing panel id'],
      ['cross-header', 'cross-header', (s) => s.marks.some((m) => m.resolvesToPanelInSameHeader === false || m.resolvesToExpectedPanel === false),
        "a mark's data-tx-info repointed at another header's panel — the v3.24.0 shape"],
      ['occlusion', 'occlude', (s) => s.marks.some((m) => m.topAtCentre !== 'self'),
        'a transparent overlay over a mark, so its own click would land elsewhere'],
      ['not-hidden-at-rest', 'unhide', (s) => s.panels.some((p) => !p.hidden),
        'a panel left open before anything was clicked'],
    ];

    // Restore is verified against the state BEFORE planting, not against an
    // absolute "no defects". Those differ the moment the app itself is broken:
    // with a real collision on screen the page legitimately still reports a
    // duplicate id after a clean restore, and an absolute check would blame the
    // control for the app's defect — four confusing failures on top of the real
    // one, pointing at the wrong file.
    const signature = (x) => JSON.stringify({
      dupIds: [...x.dupIds].sort(),
      marks: x.marks.map((m) => [m.btnId, m.target, m.resolvesToPanelInSameHeader, m.resolvesToExpectedPanel, m.topAtCentre]),
      panels: x.panels.map((p) => [p.id, p.hidden]),
    });
    const cleanSig = signature(clean);

    for (const [name, kind, detects, what] of controls) {
      const p = await plant(kind);
      const dirty = p.planted ? await survey() : null;
      ok(p.planted && dirty && detects(dirty) && signature(dirty) !== cleanSig,
        `${name} detector FIRES on ${what}`,
        { plant: p, dirty: dirty && { dupIds: dirty.dupIds, marks: dirty.marks.map((m) => ({ own: m.resolvesToPanelInSameHeader, top: m.topAtCentre })), hidden: dirty.panels.map((x) => x.hidden) } });
      await restore();
      const back = await survey();
      // A control that damages the page poisons every later reading, so the
      // restore is asserted, not assumed.
      ok(signature(back) === cleanSig,
        `${name} control left the page exactly as it found it`,
        { back: signature(back).slice(0, 300), clean: cleanSig.slice(0, 300) });
    }
    ok(controls.length === 4, 'all four detector controls ran');
  }

  // ── §2 The sweep ─────────────────────────────────────────────────────────
  const views = await page.evaluate(probes.railViews, server.port);
  section(`§2 Every rail view (${views.length}: ${views.join(', ')}), in both themes`);
  ok(Array.isArray(views) && views.length > 0, 'the rail offers views to sweep (enumerated from the DOM, never a hardcoded list)', views);

  for (const theme of THEMES) {
    await page.evaluate(probes.setTheme, server.port, theme);
    for (const view of views) {
      const ctx = `[${theme}/${view}]`;
      const nav = await page.evaluate(probes.gotoView, server.port, view);
      if (!nav.ok || nav.active !== view) { ok(false, `${ctx} entered the view`, nav); continue; }
      await delay(VIEW_SETTLE_MS);
      page.consoleErrors.length = 0;

      const base = await page.evaluate(probes.infoPanelSurvey, server.port);
      // Never trust a measurement that cannot prove which page it came from.
      ok(base.guard.port === String(server.port), `${ctx} measured OUR server (:${base.guard.port}), not another agent's tab`);
      cover.views.add(view);
      cover.maxMarksInOneDoc = Math.max(cover.maxMarksInOneDoc, base.marks.length);
      if (base.marks.length) cover.viewsWithMarks.add(view);
      for (const m of base.marks) cover.producers.add(m.producer);
      {
        const byTitle = {};
        for (const m of base.marks) { const t = m.title || ''; (byTitle[t] = byTitle[t] || []).push(m.region); }
        for (const [t, regions] of Object.entries(byTitle)) {
          // Recorded once per view+title, not once per theme — the same shape
          // seen twice is one fact, and listing it twice reads like two.
          const key = `${view}::${t}`;
          if (regions.length > 1 && !cover.titleCollisions.some((c) => c.key === key)) {
            cover.titleCollisions.push({ key, view, title: t, regions });
          }
        }
      }

      // ── structural invariants, whatever this view renders ────────────────
      ok(base.dupIds.length === 0, `${ctx} no duplicate DOM id anywhere in the document`, base.dupIds);
      // Producer-independent: whatever getElementById hands the click handler
      // must BE the panel this mark is paired with.
      ok(base.marks.every((m) => m.resolvesToExpectedPanel),
        `${ctx} every info mark resolves to the panel it is paired with`,
        base.marks.map((m) => ({ btnId: m.btnId, target: m.target, expected: m.expectedPanelId, resolves: m.resolvesToExpectedPanel })));
      // And the specific v3.24.0 shape, which only view-header marks can have:
      // ids derived from the title, so a sidebar and a main header of the same
      // view could collide and route one mark into the other's header.
      {
        const hdr = base.marks.filter((m) => m.producer === 'view-header');
        ok(hdr.every((m) => m.resolvesToPanelInSameHeader),
          `${ctx} every view-header mark resolves inside its OWN header (${hdr.length} of ${base.marks.length} marks are header-produced)`,
          hdr.map((m) => ({ title: m.title, region: m.region, target: m.target, own: m.resolvesToPanelInSameHeader })));
      }
      ok(base.marks.every((m) => m.followsBtnIdConvention),
        `${ctx} every mark follows the btn.id === panel.id + '-btn' pairing convention both producers rely on`,
        base.marks.map((m) => ({ btnId: m.btnId, target: m.target })));
      ok(base.marks.every((m) => m.ariaMatchesTarget),
        `${ctx} aria-controls and data-tx-info name the same panel (AT and mouse cannot diverge)`,
        base.marks.map((m) => ({ btnId: m.btnId, aria: m.ariaControls, target: m.target })));
      ok(base.panels.every((p) => p.hidden), `${ctx} every info panel starts hidden`, base.panels.map((p) => ({ id: p.id, hidden: p.hidden })));
      if (base.marks.length === 0) {
        console.log(`  · ${ctx} renders no info mark — nothing to open here`);
        ok(base.panels.length === 0, `${ctx} ...and no orphan panel without a mark to open it`, base.panels.map((p) => p.id));
        continue;
      }

      // ── one mark at a time ──────────────────────────────────────────────
      for (const mark of base.marks) {
        const who = `${ctx} ${mark.title ? `"${mark.title}" (${mark.region})` : `${mark.btnId} (standalone)`}`;
        // Re-measure AFTER scrolling: coordinates from a survey taken before a
        // reflow can put the click on whatever slid into the old position.
        const geo = await page.evaluate(probes.markGeometry, server.port, mark.btnId);
        const clickable = geo.found && geo.onScreen && geo.topAtCentre === 'self';
        ok(clickable, `${who} is hit-testable at its own centre — nothing is on top of it`, geo);
        if (!clickable) continue;

        await page.click(geo.cx, geo.cy);
        cover.marksClicked++;
        const open = await page.evaluate(probes.infoPanelSurvey, server.port);
        // Addressed by INDEX, not id: under an id collision an id lookup returns
        // the first match and silently reports the wrong panel as the right one.
        const shown = open.panels.find((p) => p.idx === mark.expectedPanelIdx);
        const baseline = base.panels.find((p) => p.idx === mark.expectedPanelIdx);

        // THE assertion. Not "a panel opened" — exactly this header's panel,
        // and it is genuinely on screen (v3.24.0 had hidden=false at 0x0).
        ok(open.visiblePanelIdxs.length === 1 && open.visiblePanelIdxs[0] === mark.expectedPanelIdx,
          `${who} opens EXACTLY its own panel, visibly (non-zero rect, real offsetParent)`,
          { visibleIdxs: open.visiblePanelIdxs, visibleIds: open.visiblePanelIds,
            expectedIdx: mark.expectedPanelIdx, expectedId: mark.expectedPanelId, shown });
        ok(!!shown && shown.text.length > 0 && !!baseline && shown.text === baseline.text,
          `${who} ...and that visible panel carries the prose authored beside it (${shown ? shown.text.length : 0} chars)`,
          { got: shown && shown.text.slice(0, 120), was: baseline && baseline.text.slice(0, 120) });
        ok(open.expandedBtnIds.length === 1 && open.expandedBtnIds[0] === mark.btnId,
          `${who} ...and it alone reports itself expanded`, open.expandedBtnIds);

        await page.pressKey('Escape');
        const shut = await page.evaluate(probes.infoPanelSurvey, server.port);
        ok(shut.visiblePanelIds.length === 0 && shut.panels.every((p) => p.hidden),
          `${who} ...Escape closes it`, shut.panels.map((p) => ({ id: p.id, hidden: p.hidden })));
        ok(shut.activeElement === mark.btnId,
          `${who} ...and focus returns to the button that opened it, not <body>`,
          { got: shut.activeElement, expected: mark.btnId });
      }

      ok(page.consoleErrors.length === 0, `${ctx} no console error during the interaction`, page.consoleErrors);
    }
  }

  // ── §3 Coverage — the sweep must not be vacuous ───────────────────────────
  section('§3 Coverage — what was actually exercised');
  console.log(`  · ${cover.views.size} view(s) visited, ${cover.viewsWithMarks.size} of them carrying an info mark: ${[...cover.viewsWithMarks].join(', ') || '(none)'}`);
  console.log(`  · ${cover.marksClicked} mark(s) clicked; most marks in one document: ${cover.maxMarksInOneDoc}`);
  console.log(`  · producers exercised: ${[...cover.producers].sort().join(', ') || '(none)'}`);
  ok(cover.producers.has('view-header') && cover.producers.has('standalone'),
    'BOTH producers of this affordance were exercised — renderViewHeader (shared/text.js, ids derived from the title) and settings.js\'s local infoMark (explicit id, rendered outside any header). A sweep that only ever reached one of them would say nothing about the other.',
    [...cover.producers]);
  ok(cover.marksClicked > 0,
    'at least one info mark was actually clicked — without this every assertion in §2 ran zero times and green means nothing');
  ok(cover.maxMarksInOneDoc >= 2,
    'some view still renders TWO info marks in one document — with only ever one on screen, "exactly its OWN panel opened" is trivially true and this suite stops discriminating',
    { maxMarksInOneDoc: cover.maxMarksInOneDoc });
  // The bug was a TITLE collision across the sidebar/main variants, and
  // renderViewHeader's fix is the `-sidebar` suffix on the derived id. If no
  // view renders that shape any more, the suffix has stopped being load-bearing
  // and the mutation that proves this suite bites no longer reddens it. That is
  // worth failing over, not worth passing quietly.
  ok(cover.titleCollisions.length > 0,
    'some view still renders two info marks under the SAME title — the exact shape renderViewHeader\'s "-sidebar" id suffix exists to disambiguate, and the shape this suite\'s mutation control depends on',
    cover.titleCollisions);
  for (const c of cover.titleCollisions) console.log(`  · title collision (expected, and handled): ${c.view} — "${c.title}" in ${c.regions.join(' + ')}`);
} finally {
  // Teardown runs even if setup threw. An aborted run that leaves a server
  // child or a browser behind is a stray listener on the maintainer's machine.
  if (page) { try { await page.close(); } catch { /* gone */ } }
  if (conn) { try { await conn.close(); } catch { /* gone */ } }
  await browser.close();
  await server.close();
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
