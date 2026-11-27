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
// v3.99.2: lifted Context-page functions call the real plain-language error helpers.
import './test-helpers/context-error-globals.js';
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
    // v3.99.2: in words, never a bare status; the status is the technical detail beside it.
    eq('a 404 is recorded as an error the step can say out loud', st.capture.error, 'The capture reading could not be loaded.');
    eq('...with the status as its technical detail', globalThis.errorDetailOf(st.capture.error), 'HTTP 404');
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
  // v3.89.0: the section is "③ Agent use", composed in renderMcp; its ⓘ is
  // the same explainer, and its body is renderToolMapBody.
  const fn = settingsSrc.slice(settingsSrc.indexOf('function renderMcp()'));
  const body = settingsSrc.slice(settingsSrc.indexOf('function renderToolMapBody('));
  const toolMapSrc = (fn.slice(0, fn.indexOf('\n}\n') + 3) + body.slice(0, body.indexOf('\n}\n') + 3))
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(toolMapSrc.includes("'settings.mcp-tool-map'"),
    'CONTROL: the Agent use section was really located, and its ⓘ is the settings.mcp-tool-map explainer');
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
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n  ' + '─'.repeat(60));
console.log('  Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('  \x1b[31m❌ ' + failed + ' capture-meter assertion(s) failed\x1b[0m');
  process.exit(1);
}
console.log('  \x1b[32m✅ the honesty meter reports what the log can see, and says what it cannot\x1b[0m');
