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
    extractFunction(viewSrc, 'renderCaptureSessions') + '\n' +
    extractFunction(viewSrc, 'renderCaptureMeter') + '\n' +
    'return { captureFacts, renderCaptureMeter, renderCaptureSessions, formatAge, effectiveSave };';
  return new Function('state', 'escapeHtml', 'icon', 'renderReadout', 'renderStatus',
    'renderInfoMark', 'docsLinkHtml', 'freshnessTier', body)(
    stateObj, escapeHtml, () => '<svg></svg>', renderReadout, renderStatus,
    renderInfoMark, docsLinkHtml, freshnessTier);
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

  // Every figure reaches the page through the shared readout, so the label,
  // the value and the provenance take the kit's type rather than this view's.
  ok(html.includes('class="tx-readout-label">CAPTURE<'),
    'the reading is a shared readout, labelled CAPTURE');
  ok(html.includes('tx-readout-prov'),
    '...with the three clauses in the readout\'s provenance slot');
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
  ok(idle.includes('fresh-dot fresh-unknown'),
    '...and takes the unknown ring too: there is no age to read');
  ok(!idle.includes('data-mem-fold="capture"'),
    '...and there is NO FOLD, because an empty chevron invites a click that '
    + 'answers nothing (the flat-card call renderWorkStreamsFold makes)');

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

  // ── THE FOUR NUMBERS ARE OUTSIDE EVERY <details> AND EVERY ⓘ PANEL ─────
  // Asserted by POSITION over the rendered page rather than by reading the
  // source: v3.16.1 cost a release precisely because a measured finding was
  // collapsed into a disclosure on 199 of 206 rows.
  const beforeFold = html.slice(0, html.indexOf('<details'));
  for (const claim of ['6 sessions in the last', '2 read and did not save']) {
    ok(beforeFold.includes(claim),
      '`' + claim + '…` is painted BEFORE the fold opens — an outcome behind a click is not an outcome');
  }
  const panels = [...html.matchAll(/<div class="tx-vh-panel"[^>]*hidden>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  eq('CONTROL: the meter\'s one ⓘ panel was really found', panels.length, 1);
  ok(panels.every((x) => !x.includes('read and did not save')),
    '...and the reading is not inside it');
  ok(html.includes('tx-vh-panel') && / hidden>/.test(html),
    'the ⓘ ships CLOSED — the definition is read once, the reading every time');

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
  ok(focusable[1].includes("'mem-capture-info-btn'"),
    '...and the ⓘ button, for the same reason the strip\'s mark is in the list');
  ok(html.includes('id="mem-fold-capture"') && html.includes('id="mem-capture-info-btn"'),
    'CONTROL: both ids are really emitted, so the two entries are not pointing at nothing');
  ok(/const FOLDS_KEY = 'curator-memory-folds-v1';/.test(viewSrc),
    'and the localStorage KEY itself is unmoved — the registry test-ui-state.js holds');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — THE SESSION ROWS: WHAT EACH SESSION DID, AND NOTHING INVENTED');
// ═════════════════════════════════════════════════════════════════════════
{
  const html = makeMeter(stFor({ openFolds: { capture: true } })).renderCaptureMeter();
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  eq('one row per session, plus the header row', rows.length, 4);
  ok(html.indexOf('claude-code') < html.indexOf('codex'),
    'newest first — the order the route sent, not re-sorted here');
  ok(rows[1].includes('claude-code'), 'the harness label is painted as the route sent it');
  ok(rows[3].includes('not reported'),
    'a session whose client sent no name reads "not reported" — never guessed at, '
    + 'and never the previous row\'s label');
  ok(rows[1].includes('data-mem-age-at="' + escapeHtml(payload().sessions[0].startedAt) + '"'),
    'each row carries the age-clock hook, so the list ticks without a render');
  ok(rows[1].includes('class="mem-age-words"'),
    '...into the named target tickAges writes to, never the cell\'s own text');
  ok(rows[1].includes('<span class="visually-hidden"> (' + payload().sessions[0].startedAt + ')</span>'),
    'the exact stamp is visually hidden and keyboard-reachable, never a hover-only title=');
  // THE REAL RULE (test-next-header-adoption.js): a `title=` is hover-only and
  // therefore invisible to keyboard and to touch UNLESS it sits on a focusable
  // element. The kit's ⓘ button carries one legitimately; nothing this view
  // emits may. Measured the same way that suite measures it — the nearest
  // opening tag before each `title=`.
  {
    const offenders = [...html.matchAll(/\btitle="/g)].filter((mt) => {
      const before = html.slice(Math.max(0, mt.index - 400), mt.index);
      const tag = before.lastIndexOf('<');
      return !/^<(a|button|input|select|textarea|summary)\b/.test(
        tag >= 0 ? before.slice(tag, tag + 12) : '');
    });
    ok(offenders.length === 0,
      'no hover-only title= on a non-focusable element — this view\'s ceiling is one '
      + '(the journal\'s ISO stamp) and the meter does not raise it',
      String(offenders.length));
    ok(/title="/.test(html),
      'CONTROL: the scan really found a title= (the kit\'s ⓘ button, which is focusable)');
  }

  // ── THE TICK IS NOT A COLOUR ALONE ────────────────────────────────────
  ok(rows[1].includes('<span class="visually-hidden">read yes</span>')
    && rows[1].includes('<span class="visually-hidden">saved yes</span>'),
  'a session that read and saved says so in words a screen reader gets');
  ok(rows[2].includes('<span class="visually-hidden">read yes</span>')
    && rows[2].includes('<span class="visually-hidden">saved no</span>'),
  '...and the one that read and did NOT save says that, in words');
  ok(/aria-hidden="true">[✓–]</.test(rows[1]),
    '...while the glyph itself is aria-hidden, so nothing is decoded from ink alone');

  // ── THE CAP IS THE ROUTE'S ANSWER, NOT THE REQUEST ────────────────────
  const cut = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', error: null,
      data: payload({ sessionsTruncated: true, sessionsShown: 3 }) },
    openFolds: { capture: true },
  })).renderCaptureMeter();
  ok(cut.includes('Showing the 3 most recent of 6 sessions.'),
    'a truncated list discloses BOTH numbers — what is on screen and what exists');
  ok(!cut.includes(String(SESSION_LIMIT) + ' most recent'),
    '...taken from the route\'s own `sessionsShown`, never from the limit the view asked for '
    + '(printing a cap as a measurement is the defect distinctScopeCount is counted early to avoid)');
  ok(!html.includes('Showing the'),
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
  const provOf = (h) => (/<span class="tx-readout-prov">([\s\S]*?)<\/span>/.exec(h) || [, ''])[1];
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
  ok(dirty.indexOf('carried no session id') < dirty.indexOf('<details'),
    '...both in the open, above the fold: a limit on a reading is part of the reading');
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
  ok(pending.includes('mem-capture-info'),
    '...while the ⓘ stays offered, which is when its limits are most worth reading');

  const wrongProject = makeMeter(stFor({
    capture: { domain: 'acme', project: 'OTHER', error: null, data: payload() },
  })).renderCaptureMeter();
  ok(wrongProject.includes('aria-busy="true"'),
    'a payload STAMPED for another project is not painted under this one — it reads as '
    + 'not-yet-loaded, which is what it is');

  const failed_ = makeMeter(stFor({
    capture: { domain: 'acme', project: 'lumina', data: null, error: 'HTTP 404' },
  })).renderCaptureMeter();
  ok(failed_.includes('No capture reading for this project') && failed_.includes('HTTP 404'),
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
  // FROM `const info =`, NOT from the function's first line: the comment above
  // that declaration QUOTES the sentence this release replaced, so a slice that
  // included it would find "under 200 bytes" in a comment and red for a reason
  // that is not a defect. Found by writing it the other way first.
  const fn = settingsSrc.slice(settingsSrc.indexOf('function renderToolMap()'));
  const upTo = fn.slice(fn.indexOf('const info ='), fn.indexOf('return settingsBlock'));
  ok(upTo.length > 200 && upTo.includes('.mcp-usage.jsonl'),
    'CONTROL: the ⓘ string was really located (the scan is not vacuous)');
  eq('CONTROL: MAX_LINE_BYTES is the number the module exports', MAX_LINE_BYTES, 300);
  eq('...and its label is derived from it, never typed', MAX_LINE_BYTES_LABEL, '300 bytes');
  ok(upTo.includes('under ' + MAX_LINE_BYTES + ' bytes'),
    'the ⓘ quotes the CEILING THE MODULE ENFORCES (' + MAX_LINE_BYTES + ')');
  ok(!upTo.includes('under 200 bytes'),
    '...and no longer the number that stopped being true in v3.63.0');
  for (const field of ['the domain and the project it touched', 'a random id for the bridge session',
    'the harness name the client reported for itself']) {
    ok(upTo.includes(field), 'the ⓘ names what a line actually carries: "' + field + '"');
  }
  for (const claim of ['Never an argument', 'never a result', 'never a file path',
    'never an error message']) {
    ok(upTo.includes(claim), '...and keeps every promise it already made: "' + claim + '"');
  }
  ok(upTo.includes('via') && upTo.includes('self-test'),
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
  ok(capRules.length >= 8, 'CONTROL: the meter\'s rules were really found (' + capRules.length + ')');
  ok(capRules.every((m) => !/color:\s*var\(--text-3\)/.test(m[2])),
    'no rule takes --text-3 as a TEXT colour — this file measures it under 4.5:1 on every '
    + 'surface it has, and a guard holds the whole file to a count of zero');
  ok(capRules.every((m) => !/--fresh-/.test(m[2])),
    'and no rule names a --fresh-* token — the freshness scale is owned outright by '
    + 'shared/freshness.css, and a copy here would be a second ladder');
  ok(!/\.mem-cap[a-z-]*\s*\{[^}]*\.tx-/.test(css) && !/^\s*\.tx-/m.test(css),
    'and this file declares no `tx-` selector — shared/text.css owns that prefix');
  ok(/\.mem-cap-num\s*\{[^}]*font-variant-numeric:\s*var\(--numeric-tabular\)/.test(css),
    'the call count takes tabular figures, so a column of them lines up and a tick does '
    + 'not reflow the words beside it');
  // The session table is NOT the work-stream table's class, and that is a
  // decision rather than duplication: those rows are a control and these are
  // not, so sharing the class would promise a click that does not exist.
  // Asserted over the RENDERED table rather than over source: the work-stream
  // table has a Harness column of its own, so a source scan for that word
  // matches the wrong table and reds on correct output (found by writing it
  // that way first).
  {
    const rendered = makeMeter(stFor({ openFolds: { capture: true } })).renderCaptureMeter();
    const table = rendered.slice(rendered.indexOf('<table'), rendered.indexOf('</table>'));
    ok(table.includes('class="mem-cap-table"'),
      'CONTROL: the session table was really found, under its own class');
    ok(!/mem-ws-table|mem-ws-row|mem-ws-open/.test(table),
      'and it does not borrow the work-stream table\'s classes — those rows are a CONTROL '
      + '(hover, press, a selected state) and these are readings, so the class would promise '
      + 'a click that does not exist');
  }
  ok(/\.mem-cap-wrap\s*\{[^}]*overflow-x:\s*auto/.test(css),
    'and it scrolls inside its own wrapper rather than overflowing the step at 568px');
}

console.log('\n  ' + '─'.repeat(60));
console.log('  Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('  \x1b[31m❌ ' + failed + ' capture-meter assertion(s) failed\x1b[0m');
  process.exit(1);
}
console.log('  \x1b[32m✅ the honesty meter reports what the log can see, and says what it cannot\x1b[0m');
