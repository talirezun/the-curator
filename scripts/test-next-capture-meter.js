#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-capture-meter.js — Project context → step ② → the honesty meter.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * OFFLINE. No network, no API key, no LLM, no filesystem outside this repo.
 *
 * ── WHAT THIS SUITE EXISTS TO STOP ─────────────────────────────────────────
 *
 * The meter answers the one question the memory layer exists for — *did this
 * session start with the bootstrap, and did it save before it stopped?* — so
 * every way of getting it wrong is a way of LYING about the store, which is
 * worse than not asking at all. Five, each of which would ship in silence:
 *
 *   1. THE UNCOMFORTABLE NUMBER GOING MISSING. "Read and did not save" is the
 *      reading's whole point, and a ratio, a percentage or a `4/6` hides it in
 *      the flattering direction. It has to be NAMED, in words, on the page.
 *   2. AN ABSENT FIGURE PRINTED AS A ZERO. "The route did not say" and "it
 *      happened no times" are two different facts. Collapsed, the meter paints
 *      a clean `0 read and did not save` over a reading nobody took — the same
 *      fact-and-absence collapse `domainsScanned` and `lastIngestKind` are
 *      written the way they are to avoid.
 *   3. THE READING FOLDING. v3.16.1: a warning behind a click is not a
 *      warning, and an outcome behind one is not an outcome. The four numbers,
 *      the route's own `note` and the two line-classes the reading cannot
 *      count are all in the open; only the per-session LIST folds.
 *   4. A STALE FIGURE. `screenSignature` decides whether a poll repaints, so a
 *      pane it cannot see silently stops updating (memory.js says so about
 *      five other panes). On this reading a frozen figure is not cosmetic.
 *   5. THE BRIDGE PAGE'S PRIVACY SENTENCE ROTTING. It told users a line stays
 *      "under 200 bytes" and named four fields; the ceiling is
 *      `MAX_LINE_BYTES` and the line carries more. The app telling a user a
 *      number is a contract — §5 pins the sentence against the module.
 *
 * ── EXECUTED, NOT SCANNED ──────────────────────────────────────────────────
 * Every assertion runs the REAL functions lifted out of views/memory.js by
 * brace-matching and executed with `new Function`, the technique the sibling
 * memory suites use. A source regex proving a line exists proves nothing about
 * what it does.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *  · `GET /api/memory/:domain/:project/capture` itself, and the arithmetic
 *    that turns log lines into the four totals. That is the route's, and
 *    scripts/test-memory-capture-route.js owns it. This file asserts what the
 *    VIEW does with the envelope it is handed — including with envelopes the
 *    route would never send, because a view must not depend on that.
 *  · Rendering, layout and contrast. Nothing in Node measures a pixel; the
 *    browser pass (both themes, 1370 and 568, zero console errors) was run by
 *    hand and is recorded in the release row, not here.
 *  · The `client` label's allow-list. Decision I puts it in src/brain, nothing
 *    branches on it, and this suite asserts only that the view ESCAPES it and
 *    never invents one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderReadout, renderStatus, renderInfoMark } from '../src/public/next/shared/text.js';
import { docsLinkHtml } from '../src/public/next/shared/docs-links.js';
import { freshnessTier } from '../src/public/next/shared/age.js';
import { MAX_LINE_BYTES, MAX_LINE_BYTES_LABEL } from '../src/brain/mcp-usage.js';
import { renderMonitor } from '../src/public/next/shared/monitor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VIEW_JS = path.join(ROOT, 'src/public/next/views/memory.js');
const VIEW_CSS = path.join(ROOT, 'src/public/next/views/memory.css');
const SETTINGS_JS = path.join(ROOT, 'src/public/next/views/settings.js');
const viewSrc = readFileSync(VIEW_JS, 'utf8');
const viewCss = readFileSync(VIEW_CSS, 'utf8');
const settingsSrc = readFileSync(SETTINGS_JS, 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); } else {
    failed++;
    console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + detail));
  }
}
function eq(msg, got, want) { ok(got === want, msg, 'got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)); }
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

/** Brace-matched extraction. A lazy regex stops at the first `\n}` at column
 *  0, which silently truncates any function containing one and turns every
 *  assertion below into a syntax error naming nothing. */
function extractFunction(source, name) {
  const re = new RegExp('(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'g');
  const m = re.exec(source);
  if (!m) throw new Error('extractFunction: ' + name + ' not found in views/memory.js');
  const start = m.index;
  let i = source.indexOf('{', re.lastIndex);
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      // The `export` keyword is stripped: these functions run inside a
      // `new Function` body, where an export declaration is a SyntaxError that
      // names the token and nothing else.
      if (depth === 0) return source.slice(start, i + 1).replace(/^export\s+/, '');
    }
  }
  throw new Error('extractFunction: unbalanced braces in ' + name);
}

/** A numeric constant, off LIVE SOURCE. Retyped it could agree with every
 *  assertion here while the shipped view used another number. */
function numConst(name) {
  const m = new RegExp('^const ' + name + ' = (\\d+);$', 'm').exec(viewSrc);
  if (!m) throw new Error(name + ' not found in memory.js');
  return Number(m[1]);
}

const WINDOW_DAYS = numConst('CAPTURE_WINDOW_DAYS');
const SESSION_LIMIT = numConst('CAPTURE_SESSION_LIMIT');
const WS_WINDOW = numConst('WS_WINDOW');

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The three render functions, lifted, with every collaborator injected BY NAME
 * so a typo is a free identifier and therefore a crash rather than a silent
 * no-op. The shared kit components are the REAL ones — a stub would let the
 * escaping battery below run past the component that actually paints these
 * sentences.
 */
function makeMeter(stateObj) {
  const body =
    'const CAPTURE_WINDOW_DAYS = ' + WINDOW_DAYS + ';\n' +
    'const CAPTURE_SESSION_LIMIT = ' + SESSION_LIMIT + ';\n' +
    extractFunction(viewSrc, 'formatAge') + '\n' +
    extractFunction(viewSrc, 'effectiveSave') + '\n' +
    extractFunction(viewSrc, 'captureFacts') + '\n' +
    extractFunction(viewSrc, 'renderCaptureMeter') + '\n' +
    'return { captureFacts, renderCaptureMeter, formatAge, effectiveSave };';
  return new Function('state', 'escapeHtml', 'icon', 'renderReadout', 'renderStatus',
    'renderInfoMark', 'docsLinkHtml', 'freshnessTier',
    // THE REAL MONITOR (v3.65.0). The reading's BODY is one, and every
    // assertion below about where a figure or a disclosure sits is an
    // assertion about what that component emits.
    'renderMonitor', body)(
    stateObj, escapeHtml, () => '<svg></svg>', renderReadout, renderStatus,
    renderInfoMark, docsLinkHtml, freshnessTier, renderMonitor);
}

const NOW = Date.now();
const iso = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();

/** A payload of the shape the route's contract promises. */
function payload(over = {}) {
  return {
    ok: true,
    domain: 'acme',
    project: 'lumina',
    since: iso(WINDOW_DAYS * 1440),
    logPresent: true,
    lineCeiling: MAX_LINE_BYTES,
    lineCeilingLabel: MAX_LINE_BYTES_LABEL,
    totals: {
      sessions: 6,
      sessionsRead: 4,
      sessionsSaved: 4,
      sessionsReadNotSaved: 2,
      legacyLines: 0,
      selfTestLines: 0,
    },
    sessions: [
      { sid: 'a1b2c3d4e5f6', client: 'claude-code', startedAt: iso(12), endedAt: iso(3), calls: 9, read: true, saved: true },
      { sid: 'b1b2c3d4e5f6', client: 'codex', startedAt: iso(300), endedAt: iso(280), calls: 4, read: true, saved: false },
      { sid: 'c1b2c3d4e5f6', client: null, startedAt: iso(4000), endedAt: iso(3990), calls: 2, read: false, saved: false },
    ],
    sessionsShown: 3,
    sessionsTruncated: false,
    // v3.64.1's two fields, at their quiet defaults — the ORDINARY answer, so
    // every assertion above §11 keeps describing the reading it was written
    // for rather than the contradiction §11 is about.
    newestSaveAt: null,
    noSessionsButSaves: false,
    note: null,
    ...over,
  };
}

const stFor = (over = {}) => ({
  activeDomain: 'acme',
  activeProject: 'lumina',
  openFolds: {},
  capture: { domain: 'acme', project: 'lumina', data: payload(), error: null },
  ...over,
});

console.log('\n\x1b[1m\x1b[36mtest-next-capture-meter.js\x1b[0m — the honesty meter in step ②');

// ═════════════════════════════════════════════════════════════════════════
section('§1 — THE FOUR NUMBERS, AND THE ONE THAT MATTERS IS NAMED');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = makeMeter(stFor()).renderCaptureMeter();
  ok(html.includes('6 sessions in the last ' + WINDOW_DAYS + ' days'),
    'the headline figure is the session count over the window the view asks for',
    html.slice(0, 300));
  ok(html.includes('4 started with the context'),
    '...beside how many started with the bootstrap');
  ok(html.includes('4 saved before stopping'),
    '...and how many saved before stopping');
  // THE ASSERTION THIS FILE EXISTS FOR.
  ok(html.includes('2 read and did not save'),
    'THE UNCOMFORTABLE NUMBER IS NAMED IN WORDS — not a ratio, not a percentage, '
    + 'not `4/6`, all three of which hide it in the flattering direction');
  ok(!/\b67\s*%|\b4\s*\/\s*6\b/.test(html),
    '...and the reading paints no percentage and no bare fraction beside it', html.slice(0, 400));

  // THE WINDOW IS THE CONSTANT'S, NOT A TYPED NUMBER. A phrase hard-coded to
  // "7 days" beside a request for thirty is the meter lying about its own
  // scope, which is the defect class this whole surface is about.
  ok(!/last 7 days/.test(html),
    'the window in the words is DERIVED from CAPTURE_WINDOW_DAYS, never typed');

  // ── THE READING IS A ROW SUMMARY NOW, AND THE BODY IS A MONITOR ──────
  // It was a `renderReadout` inside a bespoke `.mem-capture` card, above a
  // separate fold called "Sessions" whose own summary carried the same four
  // numbers. The maintainer read that card and its fold as two things and
  // said so. One row: the headline AND the three clauses are the closed line,
  // and the instrument opens under it.
  // v3.70.0: "Capture" is "Agent sessions" on screen; `capture` stays the
  // fold key, the route and every on-disk name.
  ok(/<summary class="mem-fold-summary" id="mem-fold-capture">[\s\S]*?<span>Agent sessions<\/span>/.test(html)
    && !/>Capture</.test(html),
    'the reading is a fold row, titled Agent sessions, in the same chrome as its four siblings',
    html.slice(0, 400));
  ok(!html.includes('mem-capture-zero'),
    '...and with sessions counted there is NO zero line — it explains a zero, nothing else');
  ok(/<span class="mem-fold-meta"><span class="fresh-dot[^>]*><\/span>6 sessions in the last [0-9]+ days · 4 started with the context/
    .test(html), '...with the headline AND the three clauses as its one closed line',
  html.slice(0, 600));
  ok(html.includes('<div class="cur-mon"'),
    '...and the body is the MONITOR, the one component every live reading in the app uses');
  ok(/class="cur-mon-key">read and did not save<\/span><span class="cur-mon-value cur-mon-warn"|cur-mon-line cur-mon-warn/
    .test(html), '...which tones the uncomfortable figure when it is not zero', html.slice(html.indexOf('cur-mon'), html.indexOf('cur-mon') + 700));
  // THE WORD "Sessions" LEAVES THE SCREEN (R2). The maintainer: *"I have no
  // clue what a session is."* It survives in the ⓘ, where what a session IS
  // belongs, and as the table's own heading — never as the name of a section.
  const visible = html.replace(/<div class="tx-vh-panel"[\s\S]*?<\/div>\s*(?=<|$)/g, '')
    .replace(/class="visually-hidden">[^<]*</g, 'class="visually-hidden"><');
  ok(!/<span>Sessions<\/span>/.test(visible) && !/>Sessions</.test(visible),
    'no section on the screen is called "Sessions" any more', visible.slice(0, 400));
  // v3.65.1 (D4): the ⓘ left this reading for step ②'s own panel — a step has
  // ONE explanatory mark and a reading inside it is not a step. The WORDS are
  // unchanged and are pinned where they now live, in scripts/test-next-memory-view.js's
  // panel scan; what this control proves here is that the reading no longer
  // carries a mark of its own.
  ok(!/A <b>session<\/b> is one bridge process/.test(html)
    && !/mem-capture-info/.test(html) && !/tx-vh-panel/.test(html),
  'the reading carries NO ⓘ of its own — the definition is step ②\'s', html.slice(0, 400));
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — THE THREE STATES, TOLD APART (roadmap B12)');
// ═════════════════════════════════════════════════════════════════════════
//
// "No log on this computer", "a log, and no session ran" and "N sessions" are
// three different facts and the first two are not failures. Collapsing any two
// of them is the meter reporting something that did not happen.
{
  // ── (a) NO LOG AT ALL ──────────────────────────────────────────────────
  const noLog = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null, data: payload({
      logPresent: false,
      totals: { sessions: 0, sessionsRead: 0, sessionsSaved: 0, sessionsReadNotSaved: 0, legacyLines: 0, selfTestLines: 0 },
      sessions: [], sessionsShown: 0,
      note: 'No usage log has been written on this computer yet.',
    }) },
  })).renderCaptureMeter();
  ok(noLog.includes('no usage log on this computer yet'),
    'an absent log says so, in words');
  ok(!noLog.includes('0 read and did not save') && !noLog.includes('no agent session in'),
    '...and never as zero sessions, which is a different and false claim', noLog.slice(0, 400));
  ok(noLog.includes('fresh-dot fresh-unknown'),
    '...and the mark is the dashed UNKNOWN ring, never age zero');
  ok(noLog.includes('No usage log has been written on this computer yet.'),
    '...with the route\'s own note beside it');
  // v3.70.0: AT ZERO, one unfolded line says what is counted — the likeliest
  // reason for a zero on a busy project is sessions that never touched the
  // MCP (the hook and `my-curator context` write no usage log).
  const ZERO = 'Counts sessions where an agent used the MCP tools here; sessions started only through a hook '
    + 'or <code>my-curator context</code> are not counted.';
  ok(noLog.includes('id="mem-capture-zero">' + ZERO + '</p>'),
    '...and the ZERO line says what is counted — the hook and `my-curator context` are not', noLog);
  ok(noLog.indexOf('id="mem-capture-zero"') > noLog.indexOf('</details>') || noLog.indexOf('id="mem-capture-zero"') > noLog.indexOf('mem-save-flat'),
    '...UNFOLDED — after the row, never inside its chevron');

  // ── (b) A LOG, AND NOTHING RAN ─────────────────────────────────────────
  const idle = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null, data: payload({
      totals: { sessions: 0, sessionsRead: 0, sessionsSaved: 0, sessionsReadNotSaved: 0, legacyLines: 0, selfTestLines: 0 },
      sessions: [], sessionsShown: 0,
    }) },
  })).renderCaptureMeter();
  ok(idle.includes('no agent session in the last ' + WINDOW_DAYS + ' days'),
    'a log with nothing in the window says NO SESSION RAN — a different sentence');
  ok(!idle.includes('no usage log'),
    '...and does not claim the log is missing', idle.slice(0, 300));
  ok(idle.includes('id="mem-capture-zero"'),
    '...and carries the zero line too: zero sessions is exactly when it is needed');
  ok(idle.includes('fresh-dot fresh-unknown'),
    '...and takes the unknown ring too: there is no age to read');
  // IT IS STILL A FOLD, and the reason changed with the shape rather than
  // being abandoned: the rule is "no chevron when there is nothing to open",
  // and an idle log HAS something to open — the monitor, which states the
  // four figures as zeroes taken over a real window. What it does not have is
  // a session table, and the flat branch below proves the flat case is still
  // reachable, so this is not the rule being quietly dropped.
  ok(idle.includes('data-mem-fold="capture"'),
    '...and it is still a row, opening on the monitor even with no table under it');
  ok(!idle.includes('mem-cap-table'),
    '...with no session table in it, because there were no sessions');
  const blind = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null, data: payload({
      logPresent: false,
      totals: { sessions: null, sessionsRead: null, sessionsSaved: null,
        sessionsReadNotSaved: null, legacyLines: 0, selfTestLines: 0 },
      sessions: [], sessionsShown: 0,
    }) },
  })).renderCaptureMeter();
  ok(!blind.includes('data-mem-fold="capture"') && blind.includes('mem-fold-flat'),
    'CONTROL: a reading with NO figure at all is a FLAT row — an empty chevron '
    + 'invites a click that answers nothing (the call renderWorkStreamsFold makes)',
  blind.slice(0, 400));

  // ── (c) SESSIONS RAN ───────────────────────────────────────────────────
  const live = makeMeter(stFor()).renderCaptureMeter();
  ok(/fresh-dot fresh-(live|recent)/.test(live),
    'with sessions, the mark is an AGE on the shared ladder — the newest session, '
    + '3 minutes old here', live.slice(live.indexOf('fresh-dot'), live.indexOf('fresh-dot') + 60));
  // THE DOT IS AN AGE, NOT A RATIO, and that is a deliberate correction to the
  // design record. The shared scale is cut on formatAge's own bands; a ratio
  // painted in --fresh-* would be a second ladder wearing the first's colours.
  const dour = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null, data: payload({
      totals: { sessions: 6, sessionsRead: 6, sessionsSaved: 0, sessionsReadNotSaved: 6, legacyLines: 0, selfTestLines: 0 },
    }) },
  })).renderCaptureMeter();
  eq('a terrible ratio with a fresh newest session takes the SAME mark as a '
    + 'perfect one — the ladder reports time, never a grade',
  /fresh-dot fresh-([a-z]+)/.exec(dour)[1], /fresh-dot fresh-([a-z]+)/.exec(live)[1]);
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — THE READING NEVER FOLDS; THE SESSION LIST DOES, AND SHIPS SHUT');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = makeMeter(stFor()).renderCaptureMeter();
  ok(html.includes('<details class="mem-fold" data-mem-fold="capture">'),
    'the session list is a fold with this view\'s own hook');
  ok(!/data-mem-fold="capture"[^>]*\sopen/.test(html),
    '...and it ships CLOSED — v3.58.0 measured this page at 3,241px with its folds open');
  ok(makeMeter(stFor({ openFolds: { capture: true } })).renderCaptureMeter()
    .includes('data-mem-fold="capture" open'),
  '...and opens from its OWN key, which is what "remembered per fold" means');
  ok(!makeMeter(stFor({ openFolds: { brief: true, journal: true, streams: true, foundations: true } }))
    .renderCaptureMeter().includes('data-mem-fold="capture" open'),
  '...and no other fold\'s key opens it');

  // ── VISIBLE WHILE THE ROW IS CLOSED — the same rule, a new shape ──────
  //
  // This used to read `html.slice(0, html.indexOf('<details'))`: the four
  // numbers had to be painted BEFORE the first fold, because the reading was
  // a card ABOVE a fold called "Sessions". The reading IS the fold row now
  // (R2), so that index is 0 and the old form expresses nothing.
  //
  // THE RULE IT ENCODED IS v3.16.1 AND IT IS UNCHANGED: a user who has not
  // clicked anything can read the outcome. What satisfies it is now "in the
  // row's own <summary>, or outside every fold", which is exactly what a
  // closed page shows — so that is what is computed, and a positive control
  // below proves a claim moved into the BODY reds it.
  const summaryOf = (h, key) => {
    const at = h.indexOf('data-mem-fold="' + key + '"');
    if (at === -1) return '';
    const m = /<summary[\s\S]*?<\/summary>/.exec(h.slice(at));
    return m ? m[0] : '';
  };
  const outsideAllDetails = (h) => h.replace(/<details[\s\S]*?<\/details>/g, '');
  const closedText = summaryOf(html, 'capture') + outsideAllDetails(html);
  for (const claim of ['6 sessions in the last', '2 read and did not save']) {
    ok(closedText.includes(claim),
      '`' + claim + '…` is readable while the row is CLOSED — an outcome behind a click is not an outcome');
  }
  // THE POSITIVE CONTROL, without which the scan above passes on anything:
  // a claim that exists ONLY inside the fold body must not be found.
  // THE POSITIVE CONTROL, re-pointed in v3.65.1: the session table is deleted,
  // so its column heading is no longer the thing that exists only in the body.
  // The monitor's own lines are — they ARE the body — so one of those is the
  // control, and it proves the detector is not vacuous exactly as the heading did.
  ok(!closedText.includes('cur-mon-key') && html.includes('cur-mon-key'),
    'CONTROL: the detector really does exclude the fold BODY — the monitor\'s '
    + 'lines are on the page and NOT in the closed text');
  ok(summaryOf(html, 'capture').length > 40,
    'CONTROL: the summary was really found (the scan is not vacuous)');
  const panels = [...html.matchAll(/<div class="tx-vh-panel"[^>]*hidden>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  eq('the meter emits NO ⓘ panel of its own (v3.65.1, D4)', panels.length, 0);

  // ── THE <summary> HAZARD ──────────────────────────────────────────────
  // An interactive control inside a <summary> toggles its own section when
  // clicked (v3.0.1-beta.18). This fold's summary holds spans and an svg only.
  const summaries = [...html.matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
  eq('CONTROL: the fold\'s summary was really found', summaries.length, 1);
  ok(!/<(button|a|input|select|textarea)\b/.test(summaries[0]),
    '...and it carries NO interactive control — nothing to swallow a click');

  // ── THE TWO REGISTRIES, READ OFF LIVE SOURCE ──────────────────────────
  const keys = /const FOLD_KEYS = (\[[^\]]*\]);/.exec(viewSrc);
  ok(!!keys, 'FOLD_KEYS was found in live source (the scan is not vacuous)');
  ok(/'capture'/.test(keys[1]),
    '...and it carries `capture`, so the fold survives leaving the view and coming back', keys[1]);
  ok(/'brief'/.test(keys[1]) && /'journal'/.test(keys[1]) && /'foundations'/.test(keys[1])
    && /'streams'/.test(keys[1]), '...and still carries the other four, so this was an addition');
  const focusable = /const FOCUSABLE_IDS = \[([\s\S]*?)\n\];/.exec(viewSrc);
  ok(!!focusable, 'FOCUSABLE_IDS was found in live source');
  ok(focusable[1].includes("'mem-fold-capture'"),
    '...and knows the fold\'s summary, so the poll cannot drop a keyboard user who just toggled it');
  ok(!focusable[1].includes("'mem-capture-info-btn'"),
    '...and NOT the deleted ⓘ button — a stale id in this list is a focus target that '
    + 'resolves to nothing, which is what the control below proves it would have been');
  ok(html.includes('id="mem-fold-capture"') && !html.includes('id="mem-capture-info-btn"'),
    'CONTROL: the fold\'s id is really emitted and the ⓘ\'s really is not');
  ok(/const FOLDS_KEY = 'curator-memory-folds-v1';/.test(viewSrc),
    'and the localStorage KEY itself is unmoved — the registry test-ui-state.js holds');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — THE TABLE IS GONE, AND THE MONITOR CARRIES WHAT IT CARRIED');
// ═════════════════════════════════════════════════════════════════════════
//
// v3.65.1, D4. The maintainer, on the shipped CAPTURE body: *"two different
// designs, one row-like then table-like"* — an ⓘ alone on its own line, then
// the monitor, then a five-column table. `renderCaptureSessions` is deleted.
//
// WHAT THIS SECTION NOW PROVES is the only thing that made the deletion safe:
// every fact the table carried is still on screen. Two of its figures had
// nowhere else to live — the window's TOTAL TOOL CALLS and the NEWEST
// SESSION'S HARNESS — and both are monitor lines now. Its CAP disclosure
// ("showing the N most recent of M") moved OUTSIDE the row, beside the two
// line-class disclosures, because it says what the figures are taken over.
{
  const html = makeMeter(stFor({ openFolds: { capture: true } })).renderCaptureMeter();
  ok(!/<table/.test(html) && !/mem-cap-table/.test(html) && !/mem-cap-flag/.test(html),
    'no table, and none of its classes, anywhere in the reading', html.slice(0, 400));
  ok(!/Started<\/th>|Harness<\/th>|Calls<\/th>/.test(html),
    '...and none of its column headings survive as orphaned markup');

  // THE FIGURES THE TABLE ALONE HAD.
  // A LINE READ WHOLE, then split. `cur-mon-value` can CONTAIN a span (the
  // freshness dot rides inside it), so a lazy `[\\s\\S]*?<\\/span>` stops at the
  // dot's own close and reports an empty sub — which is a green on the wrong
  // bytes. The line's own container is the boundary instead.
  const lineOf = (h, key) => {
    const at = h.indexOf('<span class="cur-mon-key">' + key + '</span>');
    if (at === -1) return null;
    const start = h.lastIndexOf('<div class="cur-mon-line', at);
    const end = h.indexOf('</div>', h.indexOf('</span>', at));
    const block = h.slice(start, end === -1 ? h.length : end + 6);
    const v = /<span class="cur-mon-value">([\s\S]*?)<\/span>(?=<span class="cur-mon-sub"|<\/div>)/.exec(block);
    const sub = /<span class="cur-mon-sub">([\s\S]*?)<\/span>/.exec(block);
    return { value: v ? v[1] : '', sub: sub ? sub[1] : '', block };
  };
  const calls = lineOf(html, 'tool calls');
  ok(!!calls, 'the window\'s TOOL CALLS are a line — the table\'s only figure with '
    + 'nowhere else to live', html.slice(html.indexOf('cur-mon'), html.indexOf('cur-mon') + 900));
  eq('...and it is the SUM the route sent, not a count of rows',
    calls && calls.value,
    String(payload().sessions.reduce((n, r) => n + (r.calls || 0), 0)));
  const newest = lineOf(html, 'newest');
  ok(!!newest, 'the newest session is a line');
  ok(newest && newest.sub === payload().sessions[0].client,
    '...carrying that session\'s HARNESS as its clause, which is the reading the table '
    + 'was opened for', JSON.stringify(newest));
  ok(newest && /fresh-dot fresh-/.test(newest.value),
    '...and its age wears the app-wide dot, never a second mark');

  // A CLIENT THAT SENT NO NAME. The table read "not reported" and never
  // guessed; the line must do the same rather than omitting the clause, which
  // would read as "the newest session was the one below it".
  const anon = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null,
      data: payload({ sessions: payload().sessions.map((r, k) => (k ? r : { ...r, client: null })) }) },
    openFolds: { capture: true },
  })).renderCaptureMeter();
  ok(/<span class="cur-mon-key">newest<\/span>[\s\S]*?<span class="cur-mon-sub">not reported<\/span>/
    .test(anon), 'a newest session whose client sent no name reads "not reported"',
  anon.slice(anon.indexOf('newest'), anon.indexOf('newest') + 300));

  // ── THE CAP IS THE ROUTE'S ANSWER, NOT THE REQUEST, AND IT IS OUTSIDE ──
  const cut = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null,
      data: payload({ sessionsTruncated: true, sessionsShown: 3 }) },
    openFolds: { capture: true },
  })).renderCaptureMeter();
  ok(cut.includes('showing the 3 most recent of 6 sessions'),
    'a truncated list discloses BOTH numbers — what was counted and what exists',
    cut.slice(cut.indexOf('mem-capture-limits') - 20, cut.indexOf('mem-capture-limits') + 260));
  ok(cut.replace(/<details[\s\S]*?<\/details>/g, '').includes('showing the 3 most recent'),
    '...OUTSIDE the chevron, where the other two disclosures are — a reader who never '
    + 'opens the row still learns what the figures are taken over');
  ok(!cut.includes(String(SESSION_LIMIT) + ' most recent'),
    '...taken from the route\'s own `sessionsShown`, never from the limit the view asked for '
    + '(printing a cap as a measurement is the defect distinctScopeCount is counted early to avoid)');
  ok(!html.includes('most recent of'),
    'CONTROL: an untruncated list discloses nothing, so the line above is not always on');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — AN ABSENT FIGURE IS NOT A ZERO');
// ═════════════════════════════════════════════════════════════════════════
{
  // A payload from a server that answers the envelope but not every total —
  // which is what an older or a partial route looks like, and what this view
  // must not paper over.
  const partial = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null,
      data: payload({ totals: { sessions: 6, sessionsRead: 4 } }) },
  })).renderCaptureMeter();
  ok(partial.includes('6 sessions in the last'),
    'what the route DID say is painted');
  ok(partial.includes('4 started with the context'), '...clause by clause');
  // READ OFF THE PROVENANCE ELEMENT, not off the whole page: the ⓘ panel
  // explains what "saved before stopping" MEANS, so a page-wide `includes`
  // would find the definition and pass while the figure was quietly zero.
  // Found by writing it the page-wide way first and watching it fail on
  // correct output.
  // READ OFF THE ROW'S OWN CLOSED LINE, not off the whole page: the ⓘ panel
  // explains what "saved before stopping" MEANS, so a page-wide `includes`
  // would find the definition and pass while the figure was quietly zero.
  // Found by writing it the page-wide way first and watching it fail on
  // correct output. RE-POINTED in v3.65.0 from the readout's provenance slot
  // to the fold summary's meta, which is where the three clauses now read.
  const provOf = (h) => (/<span class="mem-fold-meta">([\s\S]*?)<\/span>\s*<\/summary>/.exec(h)
    || /<span class="mem-fold-meta">([\s\S]*?)<\/span>/.exec(h) || [, ''])[1];
  ok(!provOf(partial).includes('saved before stopping'),
    '...and a figure the route did not send is DROPPED from the reading, not printed as zero',
    provOf(partial));
  ok(!provOf(partial).includes('read and did not save'),
    '...including the one this reading exists for — silence beats a false all-clear',
    provOf(partial));
  ok(provOf(partial).includes('4 started with the context'),
    'CONTROL: the provenance element was really found and does carry what the route sent');

  // And the one case where zero is a real measurement rather than an absence.
  const zero = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null,
      data: payload({ totals: { sessions: 6, sessionsRead: 6, sessionsSaved: 6, sessionsReadNotSaved: 0, legacyLines: 0, selfTestLines: 0 } }) },
  })).renderCaptureMeter();
  ok(provOf(zero).includes('0 read and did not save'),
    'CONTROL: a genuine zero IS printed — the rule is about absence, not about the digit',
    provOf(zero));

  // ── THE TWO LINE CLASSES THE READING CANNOT COUNT ─────────────────────
  const dirty = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null,
      data: payload({ note: null,
        totals: { ...payload().totals, legacyLines: 412, selfTestLines: 25 } }) },
  })).renderCaptureMeter();
  ok(dirty.includes('412 earlier calls carried no session id and cannot be counted'),
    'calls from before the bridge recorded a session id are disclosed — they are real '
    + 'work this reading cannot attribute');
  ok(dirty.includes('25 self-test calls excluded'),
    '...and so is the app\'s own self-test run, the exact contamination `via` was invented to keep out');
  // OUTSIDE THE ROW, not above it: the reading IS the row now, and the two
  // disclosures sit under it where they qualify it. The claim that matters is
  // unchanged and is checked the same way §3 checks the four numbers — a user
  // who has not clicked anything must have them.
  ok(!/<details[\s\S]*carried no session id[\s\S]*<\/details>/.test(dirty)
    && dirty.includes('carried no session id'),
  '...both in the open, OUTSIDE every fold: a limit on a reading is part of the reading');
  ok(!makeMeter(stFor()).renderCaptureMeter().includes('cannot be counted'),
    'CONTROL: with neither class present the line is absent, so it is not always on');

  // ── THE LEGACY CLAUSE DEFERS TO THE ROUTE'S NOTE ──────────────────────
  // FOUND IN A BROWSER, on a real 463-line log: src/routes/memory.js emits ONE
  // note "naming whichever honest limit applies", and on a log with pre-`sid`
  // lines that note IS the legacy count — so the route's sentence and this
  // view's landed four pixels apart saying 412 in different words. No fixture
  // in this file would have shown it, because a fixture chooses whether to
  // send a note. The route owns that disclosure; the view says it only where
  // the route stayed silent, and the SELF-TEST count — which the route never
  // mentions — is always the view's.
  const withNote = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null,
      data: payload({ note: '412 lines predate session ids and are not counted',
        totals: { ...payload().totals, legacyLines: 412, selfTestLines: 25 } }) },
  })).renderCaptureMeter();
  ok(withNote.includes('412 lines predate session ids'),
    'the route\'s note is rendered as the producer wrote it');
  ok(!withNote.includes('carried no session id'),
    '...and the view does NOT repeat the same number in its own words beside it',
    withNote.slice(withNote.indexOf('mem-capture-limits') - 40, withNote.indexOf('mem-capture-limits') + 160));
  ok(withNote.includes('25 self-test calls excluded'),
    '...while the self-test count, which the route never mentions, is still said');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — LOADING, FAILING, AND NOTHING HOSTILE REACHING THE PAGE');
// ═════════════════════════════════════════════════════════════════════════
{
  const pending = makeMeter(stFor({ capture: null })).renderCaptureMeter();
  ok(pending.includes('aria-busy="true"') && pending.includes('mem-ghost'),
    'before the read lands the step RESERVES the height rather than emptying and refilling');
  ok(!pending.includes('tx-readout'),
    '...and claims no reading it does not have');
  ok(!pending.includes('mem-capture-info') && !pending.includes('tx-vh-panel'),
    '...and carries NO ⓘ of its own, in this state as in every other (v3.65.1, D4) — '
    + 'what a session IS is step ②\'s explanation now');

  const wrongProject = makeMeter(stFor({
    capture: { domain: 'acme', project: 'OTHER', error: null, data: payload() },
  })).renderCaptureMeter();
  ok(wrongProject.includes('aria-busy="true"'),
    'a payload STAMPED for another project is not painted under this one — it reads as '
    + 'not-yet-loaded, which is what it is');

  const failed_ = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', data: null, error: 'HTTP 404' },
  })).renderCaptureMeter();
  ok(failed_.includes('No agent-sessions reading for this project') && failed_.includes('HTTP 404'),
    'a failure is DISCLOSED with its reason, never a blank');
  ok(failed_.includes('tx-status-neutral'),
    '...and neutral rather than danger: on a server older than this release the route is '
    + 'legitimately absent, and dressing that as a fault claims a diagnosis nobody made');

  // ── ESCAPING ──────────────────────────────────────────────────────────
  const XSS = '<img src=x onerror=alert(1)>';
  const hostile = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null, data: payload({
      note: XSS,
      sessions: [{ sid: XSS, client: XSS, startedAt: iso(5), endedAt: iso(1), calls: 1, read: true, saved: false }],
      sessionsShown: 1,
    }) },
    openFolds: { capture: true },
  })).renderCaptureMeter();
  ok(!hostile.includes('<img src=x'),
    'a client label the CLIENT chose is escaped — Decision I makes it untrusted data');
  ok(hostile.includes('&lt;img src=x'), '...and survives as text', hostile.slice(0, 200));
  ok(!/onerror=alert/.test(hostile.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')),
    '...and the route\'s own note is escaped too, wherever it came from');

  const junk = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null, data: { ok: true, logPresent: true } },
  })).renderCaptureMeter();
  ok(junk.includes('sessions could not be counted'),
    'an envelope with no totals at all says so rather than painting zeros');
  ok(!junk.includes('<details'), '...and offers no fold over rows it does not have');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — screenSignature CAN SEE THE METER (and does not over-fire)');
// ═════════════════════════════════════════════════════════════════════════
//
// A poll re-renders only when the screen would look different, which is right.
// The failure mode is the other side of it: a pane the signature cannot see is
// a pane that silently stops updating — and on THIS reading a frozen figure is
// the app lying about the store.
{
  const SIG = ['formatAge', 'effectiveSave', 'workStreamOrder', 'wsShownCount', 'newestPair',
    'projectMetaLine', 'screenSignature'];
  const sigOf = (st) => new Function('state', 'WS_WINDOW',
    SIG.map((n) => extractFunction(viewSrc, n)).join('\n')
    + '\nreturn screenSignature();')(st, WS_WINDOW);

  const base = (over = {}) => ({
    activeDomain: 'acme',
    activeProject: 'lumina',
    staleWrite: false,
    indexError: null,
    scope: 'main',
    machine: 'boxa',
    projects: [],
    projectRead: { scopes: [{ scope: 'main', machine: 'boxa', writtenAgeSeconds: 120 }] },
    detail: { scope: 'main', machine: 'boxa', current: { present: true, writtenAgeSeconds: 120 } },
    capture: { domain: 'acme', project: 'lumina', error: null, data: payload() },
    ...over,
  });
  const cap = (over) => base({ capture: { domain: 'acme', project: 'lumina', error: null, data: payload(over) } });

  const b = sigOf(base());
  ok(sigOf(base()) === b, 'CONTROL: an identical state produces an identical signature');
  ok(sigOf(cap({ totals: { ...payload().totals, sessionsSaved: 5, sessionsReadNotSaved: 1 } })) !== b,
    'A SESSION SAVING REPAINTS — nothing else in the signature can see the meter, so '
    + 'without this mark the figure would sit unpainted in state');
  ok(sigOf(cap({ totals: { ...payload().totals, sessions: 7 } })) !== b,
    'a new session appearing repaints');
  ok(sigOf(cap({ note: 'The log began 3 days ago.' })) !== b,
    'the route\'s note appearing repaints — it is an unfolded outcome, so it is pixels');
  ok(sigOf(cap({ sessionsTruncated: true })) !== b, 'the truncation disclosure repaints');
  ok(sigOf(cap({ sessions: payload().sessions.slice().reverse() })) !== b,
    'the rows changing ORDER repaints — order is part of the paint and has no cell of its own');
  ok(sigOf(cap({ logPresent: false })) !== b, 'the log going absent repaints');
  ok(sigOf(base({ capture: { domain: 'acme', project: 'lumina', data: null, error: 'boom' } })) !== b,
    'a failure repaints, because the failure is what is on screen');
  ok(sigOf(base({ capture: null })) !== b, 'and so does the state before any read');

  // ── AND IT MUST NOT OVER-FIRE ─────────────────────────────────────────
  // A signature that moves on something invisible re-renders the pane, which
  // closes an open ⓘ and churns focus on a screen nobody touched.
  const sameBand = payload();
  sameBand.sessions = sameBand.sessions.map((r, i) => (i === 0
    ? { ...r, startedAt: iso(12.4), endedAt: iso(3.2) } : r));
  ok(sigOf(base({ capture: { domain: 'acme', project: 'lumina', error: null, data: sameBand } })) === b,
    'an age moving WITHIN one band does not repaint — the mark is cut on formatAge\'s own '
    + 'bands, so it moves exactly when the words do');
  const nextBand = payload();
  nextBand.sessions = nextBand.sessions.map((r, i) => (i === 0
    ? { ...r, startedAt: iso(200), endedAt: iso(190) } : r));
  ok(sigOf(base({ capture: { domain: 'acme', project: 'lumina', error: null, data: nextBand } })) !== b,
    'CONTROL: crossing INTO the next band does repaint, so the assertion above is not vacuous');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8 — loadCapture: the request, the cache, and the reply that came late');
// ═════════════════════════════════════════════════════════════════════════
{
  const mk = (responder, stateObj, opts = {}) => {
    const calls = { urls: [], renders: 0 };
    const body =
      'const captureCache = new Map();\n' +
      'let captureInFlight = null;\n' +
      'const CAPTURE_WINDOW_DAYS = ' + WINDOW_DAYS + ';\n' +
      'const CAPTURE_SESSION_LIMIT = ' + SESSION_LIMIT + ';\n' +
      extractFunction(viewSrc, 'keyOf') + '\n' +
      extractFunction(viewSrc, 'loadCapture') + '\n' +
      'return { loadCapture, captureCache };';
    const api = new Function('state', 'isCurrentMount', 'render', 'fetch', 'encodeURIComponent',
      'Date', body)(
      stateObj,
      () => (opts.mounted === undefined ? true : opts.mounted),
      () => { calls.renders++; },
      async (url) => { calls.urls.push(String(url)); return responder(String(url), calls.urls.length); },
      encodeURIComponent, Date);
    return { ...api, calls };
  };
  const good = () => ({ ok: true, json: async () => payload() });

  // ── THE REQUEST ───────────────────────────────────────────────────────
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    const r = mk(good, st);
    const before = Date.now();
    await r.loadCapture('acme', 'lumina', 1);
    const url = r.calls.urls[0];
    ok(url.startsWith('/api/memory/acme/lumina/capture?'),
      'the request names the PAIR — a per-project reading asked for per project', url);
    const since = Date.parse(decodeURIComponent(/since=([^&]+)/.exec(url)[1]));
    const wantMs = WINDOW_DAYS * 86400000;
    ok(Math.abs((before - since) - wantMs) < 10000,
      '...and `since` is the view\'s own window, ' + WINDOW_DAYS + ' days back',
      'off by ' + ((before - since) - wantMs) + 'ms');
    ok(url.includes('limit=' + SESSION_LIMIT),
      '...with the row limit it means to show');
    eq('the payload lands, stamped with the pair it was asked for',
      st.capture.domain + '/' + st.capture.project, 'acme/lumina');
    eq('...and it repainted once', r.calls.renders, 1);
  }

  // ── THE CACHE, AND THE IN-FLIGHT GUARD ────────────────────────────────
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    const r = mk(good, st);
    await r.loadCapture('acme', 'lumina', 1);
    st.capture = null;
    await r.loadCapture('acme', 'lumina', 1);
    eq('a second read of the same pair is served from cache — one request, not two',
      r.calls.urls.length, 1);
    ok(st.capture && st.capture.data, '...and the meter is filled in that same frame');
    eq('...without a second render, because the cache arm paints inside the caller\'s',
      r.calls.renders, 1);
    await r.loadCapture('acme', 'other', 1);
    eq('a DIFFERENT project in the same domain is a different key', r.calls.urls.length, 2);
    ok(/\/acme\/other\/capture/.test(r.calls.urls[1]),
      '...named in the URL', r.calls.urls[1]);
  }
  {
    // Two switches back and forth while the first read is still open must not
    // issue two requests.
    let release;
    const gate = new Promise((res) => { release = res; });
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    const r = mk(async () => { await gate; return good(); }, st);
    const p1 = r.loadCapture('acme', 'lumina', 1);
    const p2 = r.loadCapture('acme', 'lumina', 1);
    release();
    await Promise.all([p1, p2]);
    eq('two overlapping asks for one pair issue ONE request', r.calls.urls.length, 1);
  }

  // ── THE REPLY THAT LANDS AFTER THE USER MOVED ON ──────────────────────
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    const r = mk(async () => { st.activeProject = 'gone'; return good(); }, st);
    await r.loadCapture('acme', 'lumina', 1);
    ok(!st.capture || st.capture.data === null,
      'a reply for a project the user has LEFT is never written into state — it would '
      + 'paint one project\'s sessions under another project\'s heading',
      JSON.stringify(st.capture));
    eq('...and does not repaint', r.calls.renders, 0);
  }
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    const r = mk(good, st, { mounted: false });
    await r.loadCapture('acme', 'lumina', 1);
    eq('a reply that lands after the view unmounted repaints nothing', r.calls.renders, 0);
  }

  // ── A FAILURE IS A DISCLOSURE ─────────────────────────────────────────
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    const r = mk(async () => ({ ok: false, status: 404, json: async () => ({ ok: false }) }), st);
    await r.loadCapture('acme', 'lumina', 1);
    eq('a 404 is recorded as an error the step can say out loud', st.capture.error, 'HTTP 404');
    ok(st.capture.data === null, '...with no data beside it');
    await r.loadCapture('acme', 'lumina', 1);
    eq('...and a FAILURE IS NOT CACHED, so a server that comes back is asked again',
      r.calls.urls.length, 2);
  }
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    const r = mk(async () => { throw new Error('offline'); }, st);
    await r.loadCapture('acme', 'lumina', 1);
    eq('a thrown fetch never escapes — the step says why instead', st.capture.error, 'offline');
  }
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    const r = mk(async () => ({ ok: true, json: async () => ({ ok: false, error: 'no such project' }) }), st);
    await r.loadCapture('acme', 'lumina', 1);
    eq('a 200 carrying `ok: false` is an error too, with the route\'s own words',
      st.capture.error, 'no such project');
  }

  // ── v3.72.1 (truth audit F2): STALE-WHILE-REVALIDATE ─────────────────
  // The count used to be cached for the life of the page — an agent session
  // after the first read never reached the tile or step ② until a reload,
  // and the 30-day window stayed pinned to the first request's clock.
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    let sessions = 3;
    const r = mk(() => {
      const p = payload();
      if (p.totals) p.totals = { ...p.totals, sessions };
      p.__n = sessions;
      return { ok: true, json: async () => p };
    }, st);
    await r.loadCapture('acme', 'lumina', 1);
    eq('F2: the first read lands', st.capture.data.__n, 3);
    sessions = 5;   // two more agent sessions happen elsewhere
    await r.loadCapture('acme', 'lumina', 1, { maxAgeMs: 60000 });
    eq('F2: CONTROL — an entry younger than the TTL is served from cache, no request',
      r.calls.urls.length, 1);
    const before = Date.now();
    await r.loadCapture('acme', 'lumina', 1, { maxAgeMs: 0 });
    eq('F2: an entry at the maximum age is RE-ASKED', r.calls.urls.length, 2);
    eq('F2: ...and the newer count replaces the old one', st.capture.data.__n, 5);
    const since2 = Date.parse(decodeURIComponent(/since=([^&]+)/.exec(r.calls.urls[1])[1]));
    ok(Math.abs((before - since2) - WINDOW_DAYS * 86400000) < 10000,
      'F2: ...with `since` computed for THAT request (30 days before now, not before the first read)');
    const renders = r.calls.renders;
    await r.loadCapture('acme', 'lumina', 1, { maxAgeMs: 0 });
    eq('F2: an unchanged answer repaints nothing (a render would close an open ⓘ)',
      r.calls.renders, renders);
  }
  {
    const st = { activeDomain: 'acme', activeProject: 'lumina', capture: null };
    let fail = false;
    const r = mk(async () => {
      if (fail) throw new Error('offline');
      return good();
    }, st);
    await r.loadCapture('acme', 'lumina', 1);
    fail = true;
    await r.loadCapture('acme', 'lumina', 1, { maxAgeMs: 0 });
    ok(!!st.capture.data && !st.capture.error,
      'F2: a FAILED revalidation keeps the reading on screen rather than blanking it',
      JSON.stringify(st.capture).slice(0, 200));
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — THE BRIDGE PAGE\'S PRIVACY SENTENCE IS A CONTRACT');
// ═════════════════════════════════════════════════════════════════════════
//
// It said a line stays "under 200 bytes" and named four fields. Both stopped
// being true the moment the log grew `sid`, `project` and its session line.
// The app telling a user a number is a contract — so the sentence is pinned
// against the module that owns the number, not against a typed copy.
{
  // v3.71.1: THE SENTENCE LEFT THE APP. The Tool map ⓘ is now the
  // `settings.mcp-tool-map` explainer (no byte figure, no field list), and the
  // contract moved to the documentation the explainer's guide card and the
  // user guide's "The tool map — what your agents used" lead to:
  // docs/mcp-user-guide.md's "The usage log" paragraphs. So the pin now holds
  // THAT text to the module's number — and holds the app to stating none.
  const fn = settingsSrc.slice(settingsSrc.indexOf('function renderToolMap()'));
  const toolMapSrc = fn.slice(0, fn.indexOf('\n}\n') + 3)
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(toolMapSrc.includes("'settings.mcp-tool-map'"),
    'CONTROL: renderToolMap was really located, and its ⓘ is the settings.mcp-tool-map explainer');
  ok(!/\d+\s*bytes/.test(toolMapSrc),
    '...and the app itself states no byte figure any more (outside comments) — the number lives in the docs, pinned below');
  const ugSrc = readFileSync(path.join(ROOT, 'docs/user-guide.md'), 'utf8');
  const ugTm = ugSrc.slice(ugSrc.indexOf('### The tool map — what your agents used'));
  ok(ugTm.length > 200 && /\(mcp-user-guide\.md\)/.test(ugTm.slice(0, 1200)),
    'the user guide\'s tool-map section sends the reader to mcp-user-guide.md for the file\'s details');
  const mugSrc = readFileSync(path.join(ROOT, 'docs/mcp-user-guide.md'), 'utf8');
  const a = mugSrc.indexOf('**The usage log.**');
  const b = mugSrc.indexOf('**Where the run\'s own lines come from.**');
  const upTo = a >= 0 && b > a ? mugSrc.slice(a, b) : '';
  ok(upTo.length > 200 && upTo.includes('.mcp-usage.jsonl'),
    'CONTROL: the usage-log paragraphs of docs/mcp-user-guide.md were really located (the scan is not vacuous)');
  eq('CONTROL: MAX_LINE_BYTES is the number the module exports', MAX_LINE_BYTES, 300);
  eq('...and its label is derived from it, never typed', MAX_LINE_BYTES_LABEL, '300 bytes');
  ok(new RegExp('at\\s+most\\s+\\*\\*' + MAX_LINE_BYTES_LABEL + '\\*\\*').test(upTo),
    'the docs quote the CEILING THE MODULE ENFORCES (' + MAX_LINE_BYTES + ')');
  ok(upTo.includes('the same ' + MAX_LINE_BYTES + '-byte\nceiling') || upTo.includes('the same ' + MAX_LINE_BYTES + '-byte ceiling'),
    '...for the session line too');
  ok(!upTo.includes('under 200 bytes') && !upTo.includes('at most **200 bytes**'),
    '...and no longer the number that stopped being true in v3.63.0');
  for (const field of ['the domain it touched', '**session\nid**', '**project** name', '`client`']) {
    ok(upTo.includes(field), 'the docs name what a line actually carries: "' + field.replace('\n', ' ') + '"');
  }
  ok(/never records your prompt, the\s+tool's arguments, or what came back/.test(upTo),
    '...and keep every promise already made: never the prompt, the arguments, or the result');
  ok(upTo.includes('"via": "self-test"') && /a self-test is not a session start/.test(upTo),
    '...including the self-test field, and that a run is not a session start');
  // WHY A LITERAL AND NOT AN IMPORT, checked rather than asserted in prose:
  // src/brain/mcp-usage.js cannot be loaded in a browser.
  const usageSrc = readFileSync(path.join(ROOT, 'src/brain/mcp-usage.js'), 'utf8');
  ok(/^import .*from 'crypto';$/m.test(usageSrc) || /from 'fs\/promises'/.test(usageSrc),
    'CONTROL: mcp-usage.js imports Node built-ins, which is WHY the view cannot import '
    + 'MAX_LINE_BYTES_LABEL and this pin exists instead');
  ok(!/lineCeiling/.test(readFileSync(path.join(ROOT, 'src/routes/mcp.js'), 'utf8')),
    '...and GET /api/mcp/usage does not carry the ceiling either, which was the other '
    + 'way out. If it ever does, import it there and delete this pin');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — THE STYLESHEET KEEPS THIS FILE\'S STANDING RULES');
// ═════════════════════════════════════════════════════════════════════════
{
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const css = stripComments(viewCss);
  const capRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /\.mem-cap(ture)?[-\s{,:]/.test(m[1] + '{'));
  // v3.65.1: five `.mem-cap-*` rules went with the deleted session table, so
  // the floor drops from 8 to 4 — the reading is one head, one cells wrapper,
  // the limits line and the row it lives in. The assertion is still "the scan
  // is not blind", which is what the number is for.
  ok(capRules.length >= 4, 'CONTROL: the meter\'s rules were really found (' + capRules.length + ')');
  ok(capRules.every((m) => !/color:\s*var\(--text-3\)/.test(m[2])),
    'no rule takes --text-3 as a TEXT colour — this file measures it under 4.5:1 on every '
    + 'surface it has, and a guard holds the whole file to a count of zero');
  ok(capRules.every((m) => !/--fresh-/.test(m[2])),
    'and no rule names a --fresh-* token — the freshness scale is owned outright by '
    + 'shared/freshness.css, and a copy here would be a second ladder');
  ok(!/\.mem-cap[a-z-]*\s*\{[^}]*\.tx-/.test(css) && !/^\s*\.tx-/m.test(css),
    'and this file declares no `tx-` selector — shared/text.css owns that prefix');
  // v3.65.1 (D4): `.mem-cap-num` went with the table. The figures are monitor
  // VALUES now, and `shared/monitor.css` gives `.cur-mon-value` the tabular
  // numerals — one declaration for every live reading in the app instead of one
  // per table. Asserted against the KIT's stylesheet, because that is where the
  // property lives and a copy here would be the duplication this release removes.
  ok(!/\.mem-cap-num/.test(css) && !/\.mem-cap-table/.test(css) && !/\.mem-cap-flag/.test(css),
    'the deleted table takes its five rules with it — no orphaned selector survives it');
  ok(/font-variant-numeric:\s*var\(--numeric-tabular\)/.test(
    stripComments(readFileSync(path.join(ROOT, 'src/public/next/shared/monitor.css'), 'utf8'))),
  'and the figures still take tabular numerals, from the KIT\'s own rule, so a '
    + 'column of readings lines up wherever a monitor is drawn');
  // ── THE TABLE IS DELETED, AND SO IS THE QUESTION IT RAISED (v3.65.1) ──
  // It used to be asserted that the session table did not borrow the
  // work-stream table's classes — those rows are a CONTROL (hover, press, a
  // selected state) and these were readings, so sharing the class would have
  // promised a click that did not exist. There is no table now, so the
  // assertion is replaced by the one that keeps the reason true: the reading
  // paints NO table and NO row that could be mistaken for a control.
  {
    const rendered = makeMeter(stFor({ openFolds: { capture: true } })).renderCaptureMeter();
    ok(!/<table|<tr>|mem-ws-table|mem-ws-row|mem-ws-open/.test(rendered),
      'the reading paints no table and borrows no row class — every figure is a '
      + 'monitor line, which nothing on this page reads as pressable', rendered.slice(0, 300));
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§11 — SAVES WITH NO SESSION TO ACCOUNT FOR THEM (v3.64.1)');
// ═════════════════════════════════════════════════════════════════════════
//
// THE DEFECT, from production on the day v3.64.0 shipped. Step ②'s "Last
// saved" reading said `saved 47 min ago` and this meter, four pixels below it,
// said `no agent session in the last 30 days`. BOTH WERE TRUE: the saves came
// through a bridge process that writes no session line, so the store had the
// saves and the usage log had no session to attribute them to. The screen
// presented a contradiction and called it a reading.
//
// The route decides — it is the side that holds both the log summary and the
// project's own save clocks — and this suite asserts what the VIEW does with
// the answer: prints it, under the reading, unfolded, and keeps printing the
// disclosure the new note does NOT make.
{
  const NOTE = 'Saves in this window arrived through a bridge that logged no sessions — '
    + 'restart the app that launched it (usually Claude Desktop)';
  const contradiction = (over = {}) => stFor({
    capture: { domain: 'acme', project: 'lumina', error: null, data: payload({
      totals: { sessions: 0, sessionsRead: 0, sessionsSaved: 0, sessionsReadNotSaved: 0,
        legacyLines: 0, selfTestLines: 0 },
      sessions: [], sessionsShown: 0,
      newestSaveAt: iso(47), noSessionsButSaves: true, note: NOTE, ...over }) },
  });

  const html = makeMeter(contradiction()).renderCaptureMeter();
  ok(html.includes('no agent session in the last ' + WINDOW_DAYS + ' days'),
    'CONTROL: the headline still reports the honest zero — the note explains it, it does not '
    + 'replace it', html.slice(0, 400));
  ok(html.includes(escapeHtml(NOTE).replace(/&#39;/g, "&#39;")) || html.includes(NOTE),
    'the route\'s sentence is rendered VERBATIM — the view never authors a second copy of a '
    + 'remedy the producer owns', html.slice(0, 900));
  // POSITION: under the reading, not above it and not inside the fold.
  const atRead = html.indexOf('mem-fold-capture');
  const atNote = html.indexOf('bridge that logged no sessions');
  ok(atRead !== -1 && atNote > atRead,
    'the note is rendered UNDER the reading it qualifies', atRead + ' vs ' + atNote);
  // RE-POINTED (v3.65.0): the reading IS the fold now, so "before the fold"
  // is meaningless and "outside every fold" is the rule. v3.16.1, unmoved.
  ok(!/<details[\s\S]*bridge that logged no sessions[\s\S]*<\/details>/.test(html),
    '...and never inside the row\'s body — an outcome may not sit behind a chevron (v3.16.1)');

  // THE DISCLOSURE THE NEW NOTE DOES NOT MAKE. The legacy clause defers to the
  // route's note, because on a real log THAT note IS the legacy count — but
  // this third tenant says nothing about legacy lines, so deferring to it
  // would drop a disclosure the route still owes. Driven with a legacy count
  // present under BOTH notes, which is the only way the deference can be told
  // apart from a clause that never fires.
  const withLegacy = makeMeter(contradiction({
    totals: { sessions: 0, sessionsRead: 0, sessionsSaved: 0, sessionsReadNotSaved: 0,
      legacyLines: 412, selfTestLines: 0 },
  })).renderCaptureMeter();
  ok(withLegacy.includes('412 earlier calls carried no session id'),
    'the legacy disclosure SURVIVES the stale-bridge note, which does not make it',
    withLegacy.slice(0, 900));
  const legacyNote = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null, data: payload({
      totals: { sessions: 2, sessionsRead: 1, sessionsSaved: 1, sessionsReadNotSaved: 0,
        legacyLines: 412, selfTestLines: 0 },
      note: '412 lines predate session ids and are not counted' }) },
  })).renderCaptureMeter();
  ok(!legacyNote.includes('412 earlier calls carried no session id'),
    'CONTROL: and it still DEFERS to the log-limit note, which does make it — so the two '
    + 'sentences never land four pixels apart saying one number twice', legacyNote.slice(0, 900));

  // THE FLAG IS READ AS POSITIVE EVIDENCE, like `logPresent` beside it.
  const facts = makeMeter(stFor()).captureFacts;
  eq('an absent flag reads false, never undefined',
    facts({ ok: true, totals: {}, sessions: [] }).noSessionsButSaves, false);
  eq('...and a forged truthy value is not true', facts({ noSessionsButSaves: 1 }).noSessionsButSaves, false);
  eq('...while the route\'s real boolean is', facts({ noSessionsButSaves: true }).noSessionsButSaves, true);

  // AND IT MOVES THE SIGNATURE. The flag changes the LIMITS line under the
  // note, so a poll that could not see it would leave a stale disclosure on
  // screen — the fifth failure this suite's header names.
  const SIG_FNS = ['formatAge', 'effectiveSave', 'workStreamOrder', 'wsShownCount', 'newestPair',
    'projectMetaLine', 'screenSignature'];
  const sig = (data) => new Function('state', 'WS_WINDOW',
    SIG_FNS.map((n) => extractFunction(viewSrc, n)).join('\n')
    + '\nreturn screenSignature();')({
    activeDomain: 'acme', activeProject: 'lumina', projects: [], openFolds: {},
    capture: { domain: 'acme', project: 'lumina', error: null, data },
  }, WS_WINDOW);
  const base = payload({ totals: { sessions: 0, sessionsRead: 0, sessionsSaved: 0,
    sessionsReadNotSaved: 0, legacyLines: 412, selfTestLines: 0 }, sessions: [], sessionsShown: 0,
  note: NOTE });
  ok(sig({ ...base, noSessionsButSaves: false }) !== sig({ ...base, noSessionsButSaves: true }),
    'screenSignature moves when the stale-bridge flag does');
}

section('§12 — v3.66.0 (P3): TWO OUTCOMES AS A SHARE OF A NAMED WHOLE');
{
  // The approved channels map puts a depth bar on "saved before stopping"
  // (and, symmetrically, "started with the context"): the COUNT stays the
  // figure, the whole is printed beside it ("of 6"), and the bar is `max`,
  // never `budget` — so it can never be an over-run and never a grade.
  const html = makeMeter(stFor()).renderCaptureMeter();
  const line = (key) => {
    const at = html.indexOf('<span class="cur-mon-key">' + key + '</span>');
    const start = html.lastIndexOf('<div class="cur-mon-line', at);
    const next = html.indexOf('<div class="cur-mon-line', at);
    return at === -1 ? '' : html.slice(start, next === -1 ? undefined : next);
  };
  const saved = line('saved before stopping');
  ok(/cur-depth-bar" style="width:66\.7%"/.test(saved) && /cur-mon-sub">of 6</.test(saved),
    'saved before stopping draws 4 of 6 as a share, the whole said in words', saved);
  ok(/cur-depth-bar" style="width:66\.7%"/.test(line('started with the context')),
    '...and started with the context the same way', line('started with the context'));
  ok(!/cur-depth-danger/.test(html), 'no share is ever danger — there is no target');
  const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary>'));
  ok(!/cur-depth|%/.test(summary), 'the closed summary line carries no bar and no percentage', summary);
  ok(!/cur-depth-bar/.test(line('sessions')) && !/cur-depth-bar/.test(line('read and did not save')),
    'the whole itself and the uncomfortable number get no bar');
}

console.log('\n  ' + '─'.repeat(60));
console.log('  Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('  \x1b[31m❌ ' + failed + ' capture-meter assertion(s) failed\x1b[0m');
  process.exit(1);
}
console.log('  \x1b[32m✅ the honesty meter reports what the log can see, and says what it cannot\x1b[0m');
