#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-monitor-kit.js — ONE live-state reading, everywhere in the app.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * OFFLINE. No network, no API key, no LLM, no filesystem outside this repo.
 *
 * ── WHAT THIS SUITE EXISTS TO STOP ─────────────────────────────────────────
 *
 * The maintainer, with three screenshots of three different-looking blocks
 * that all say the same KIND of thing: *"these active-state cards ... show
 * specific data, the data that is changing, and my idea was to make this
 * similar to a CLI, a terminal kind of data input or output, so it has a
 * distinguished design so people can immediately see what's going on ... it's
 * really hard to understand that this is like a monitor into the specific data
 * and changing state ... we are looking for a unified design AND a
 * distinguished design."*
 *
 * Five ways that could quietly stop being true:
 *
 *   1. A FOURTH TREATMENT. §1 pins the anatomy elementwise — the block, the
 *      state word, the line list, one key/value pair per fact — so a host
 *      cannot get "nearly" a monitor.
 *   2. A WARNING BEHIND A CHEVRON, or swept in among the readings. v3.16.1:
 *      a warning, a cost or an outcome is never collapsible. §4 drives a
 *      fixture carrying BOTH and requires every loud text to fall OUTSIDE the
 *      line list, requires the component to emit no `<details>` for any
 *      input, and requires there to be no field on a LINE that can make one
 *      loud. The mutation that appends `loud` onto `lines` reds it.
 *   3. A CALLER-SUPPLIED STRING REACHING THE PAGE UNESCAPED. §3 drives the
 *      XSS corpus through every field. `markHtml` is the ONE trusted field
 *      and the suite pins that it is the only one — including `tone`, which
 *      is looked up in a frozen table rather than interpolated, so an unknown
 *      word yields NO class rather than a caller-composed attribute.
 *   4. THE INSTRUMENT LOOKING LIKE A CARD. §5 requires the recessed surface,
 *      the 1px border and the mono face to be declared, and requires the
 *      block NOT to take the accent wash a `.tx-vh-panel` uses — an
 *      explanation and a reading must not look alike.
 *   5. THE TWO PREFIXES IT MAY NOT TOUCH. §5 requires NO `.fresh-` rule
 *      (shared/freshness.css owns the app's one freshness scale, and
 *      test-freshness-scale.js §4 forbids a view or kit sheet declaring one)
 *      and NO `.tx-` rule (shared/text.css owns that prefix, proved by
 *      test-next-text-system.js §8 against a planted real file).
 *
 * ── WHY THE MONITOR DOES NOT CALL renderReadout ────────────────────────────
 * The v3.65.0 contract recommended it. Two measured obstacles, either one
 * sufficient, and §6 asserts both so the decision is re-checkable rather than
 * remembered: `.tx-readout` is a COLUMN (label ABOVE value) while the
 * monitor's binding anatomy is key LEFT / value RIGHT, and a container cannot
 * re-lay-out that child from shared/monitor.css because the `tx-` prefix
 * guard forbids the selector. Changing `renderReadout`'s own markup is
 * forbidden this release, and rightly: changing the container and the line in
 * one release is how a shared kit change becomes unreviewable.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *  · Any host's adoption. No view adopts the monitor in this package; the
 *    catalogue (contract §2(7), M1-M18) is each view package's work.
 *  · Rendering, layout and contrast. Nothing in Node measures a pixel; the
 *    browser figures are in the package report.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  renderMonitor, renderDepthCell, TONES, TONE_WORDS, normalizeTone,
} from '../src/public/next/shared/monitor.js';
import * as DEPTH from '../src/public/next/shared/depth-bar.js';
import { identityDotClass, identitySlotClass } from '../src/public/next/shared/sidebar.js';
import { IDENTITY_SLOTS } from '../src/public/next/shared/identity-palette.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const KIT_JS = readFileSync(path.join(NEXT, 'shared/monitor.js'), 'utf8');
const KIT_CSS = readFileSync(path.join(NEXT, 'shared/monitor.css'), 'utf8');
const OVERVIEW_JS = readFileSync(path.join(NEXT, 'shared/overview.js'), 'utf8');
const TEXT_CSS = readFileSync(path.join(NEXT, 'shared/text.css'), 'utf8');
const INDEX_HTML = readFileSync(path.join(NEXT, 'index.html'), 'utf8');
const BARE_CSS = KIT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const BARE_JS = KIT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 500)));
  return false;
}
function eq(msg, got, want) {
  return ok(got === want, msg, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want));
}
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

function extractFunction(src, name, file) {
  const at = src.indexOf('function ' + name + '(');
  if (at === -1) throw new Error('no function ' + name + ' in ' + file);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  throw new Error('unbalanced ' + name + ' in ' + file);
}

function tags(html) {
  const out = [];
  const re = /<(\w+)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const are = /([\w:-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = are.exec(m[2]))) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    out.push({ tag: m[1].toUpperCase(), attrs, classes: (attrs.class || '').split(/\s+/).filter(Boolean) });
  }
  return out;
}
const withClass = (html, c) => tags(html).filter((t) => t.classes.includes(c));
const shapeOf = (html) => tags(html)
  .filter((t) => t.classes.some((c) => c.startsWith('cur-mon')))
  .map((t) => t.tag + '.' + t.classes.filter((c) => c.startsWith('cur-mon'))[0])
  .join(' > ');

/** The slice of `html` that is NOT inside the line list. */
function outsideLines(html) {
  const open = html.indexOf('<div class="cur-mon-lines">');
  if (open === -1) return html;
  // The line list has no nested `</div>`-free structure to worry about here:
  // it is built in one place and its children are flat, so the matching close
  // is found by depth-counting from the open tag.
  let i = open;
  let depth = 0;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = open;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] !== '/') depth++; else depth--;
    if (depth === 0) { i = m.index + m[0].length; break; }
  }
  return html.slice(0, open) + html.slice(i);
}

// ═════════════════════════════════════════════════════════════════════════
//  THE FIXTURES — three real surfaces from the catalogue, by shape
// ═════════════════════════════════════════════════════════════════════════
// M7, the MCP bridge's "Connected · Claude Desktop → my-curator → <path>"
// strip, which views/settings.js and views/sync.js each write by hand today.
const BRIDGE = {
  id: 'mcp-monitor',
  head: { stateWord: 'Connected', tone: 'ok' },
  lines: [
    { key: 'client', value: 'Claude Desktop' },
    { key: 'server', value: 'my-curator' },
    { key: 'domains', value: '/Users/x/Knowledge' },
    { key: 'tools', value: 24 },
  ],
  loud: [{ tone: 'warn',
    text: 'A bridge started 2 days ago is serving older code.',
    strongText: 'Restart the app that launched it — usually Claude Desktop.' }],
  note: '25 self-test calls excluded.',
};
// M1, Context ② "Last saved" — a time-based reading with its mark.
const SAVED = {
  head: { stateWord: 'stale', tone: 'warn' },
  lines: [
    { key: 'last saved', value: '15 hr ago',
      markHtml: '<span class="fresh-dot fresh-week" aria-hidden="true"></span>',
      sub: 'session-2026-09-20-v3.64.0-kickoff · claude-code' },
    { key: 'work-streams', value: 18 },
  ],
};
// M6, Domains ⑤ Wiki health's five figures plus the scan stamp.
const HEALTH = {
  lines: [
    { key: 'broken links', value: 12, tone: 'warn' },
    { key: 'orphans', value: 3 },
    { key: 'dismissed', value: 0, tone: 'quiet' },
    { key: 'scanned', value: '10 s ago',
      markHtml: '<span class="fresh-dot fresh-live" aria-hidden="true"></span>' },
  ],
};

// ═════════════════════════════════════════════════════════════════════════
section('§1 — ONE ANATOMY, WHATEVER THE SURFACE');
// ═════════════════════════════════════════════════════════════════════════
const B = renderMonitor(BRIDGE);
const S = renderMonitor(SAVED);
const H = renderMonitor(HEALTH);
{
  ok(B.length > 200 && S.length > 100 && H.length > 100,
    'CONTROL — three different surfaces each produced a monitor',
    [B.length, S.length, H.length].join('/'));
  ok(/^<div class="cur-mon" id="mcp-monitor">/.test(B),
    'the block is one `<div class="cur-mon">`, with the host\'s patch id when asked',
    B.slice(0, 80));
  ok(/^<div class="cur-mon">/.test(H), '...and without one when not');

  eq('the bridge strip: state word, then one line per fact', shapeOf(B),
    'DIV.cur-mon > DIV.cur-mon-head > SPAN.cur-mon-state > SPAN.cur-mon-state-dot > '
    + 'DIV.cur-mon-lines > DIV.cur-mon-line > SPAN.cur-mon-key > SPAN.cur-mon-value > '
    + 'DIV.cur-mon-line > SPAN.cur-mon-key > SPAN.cur-mon-value > '
    + 'DIV.cur-mon-line > SPAN.cur-mon-key > SPAN.cur-mon-value > '
    + 'DIV.cur-mon-line > SPAN.cur-mon-key > SPAN.cur-mon-value > '
    + 'DIV.cur-mon-loud > DIV.cur-mon-note');
  eq('a monitor with no state word opens straight into its lines',
    shapeOf(H).startsWith('DIV.cur-mon > DIV.cur-mon-lines'), true);
  eq('four facts in, four lines out', withClass(B, 'cur-mon-line').length, 4);
  ok(/<span class="cur-mon-key">client<\/span><span class="cur-mon-value">Claude Desktop<\/span>/.test(B),
    'each line is KEY then VALUE, in that order — the eye runs down the right-hand edge');
  eq('a NUMBER is rendered, not dropped', /<span class="cur-mon-value">24<\/span>/.test(B), true);

  // THE QUALIFYING CLAUSE.
  ok(/<span class="cur-mon-sub">session-2026-09-20-v3\.64\.0-kickoff · claude-code<\/span>/.test(S),
    'a qualifying clause sits under its own value');
  ok(!/cur-mon-sub/.test(H), '...and a line with none paints no empty one');

  // NO READING, NO INSTRUMENT.
  eq('a monitor with nothing in it renders NOTHING — an empty bordered box '
    + 'captioned as an instrument says "this broke"', renderMonitor({ lines: [] }), '');
  eq('...including one with only a state word, which is a pill and not a monitor',
    renderMonitor({ head: { stateWord: 'Connected' }, lines: [] }), '');
  ok(renderMonitor({ loud: [{ text: 'over budget' }] }).includes('over budget'),
    '...but a warning ALONE is still rendered, because v3.16.1 outranks tidiness');
  ok(renderMonitor({ note: 'a sentence' }).includes('a sentence'),
    '...and so is a note alone');
  eq('a line with no key is dropped', withClass(renderMonitor({
    lines: [{ value: '1' }, { key: 'k', value: '2' }] }), 'cur-mon-line').length, 1);
  eq('...and so is a line with no value', withClass(renderMonitor({
    lines: [{ key: 'k' }, { key: 'k2', value: '2' }] }), 'cur-mon-line').length, 1);
  for (const junk of [{ a: 1 }, ['x'], () => {}, NaN, Infinity]) {
    eq('a ' + (typeof junk) + ' value is DROPPED rather than stringified into the page',
      withClass(renderMonitor({ lines: [{ key: 'k', value: junk }] }), 'cur-mon-line').length, 0);
  }
  eq('CONTROL: a zero is a reading and is kept',
    /<span class="cur-mon-value">0<\/span>/.test(H), true);
}

// ═════════════════════════════════════════════════════════════════════════
section('§2 — THE FRESHNESS MARK IS THE APP\'S, AND IT NEVER READS ALONE');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(/<span class="cur-mon-value"><span class="fresh-dot fresh-week" aria-hidden="true"><\/span>15 hr ago<\/span>/.test(S),
    'the mark rides INSIDE the value, before the figure — the placement renderReadout '
    + 'already uses, so the dot sits beside the reading it qualifies');
  for (const mark of [...S.matchAll(/<span class="fresh-dot[^"]*"([^>]*)>/g)]) {
    ok(/aria-hidden="true"/.test(mark[1]),
      'every mark is aria-hidden — the words beside it say the same thing');
  }
  // NEVER A DOT ALONE. Every time-based reading in the fixtures carries a
  // word; a mark with an EMPTY value cannot render at all, because the value
  // is what makes a line.
  eq('a mark with no value renders no line — a dot alone is a colour a reader '
    + 'has to decode', withClass(renderMonitor({ lines: [{ key: 'k',
      markHtml: '<span class="fresh-dot fresh-live"></span>' }] }), 'cur-mon-line').length, 0);
  ok(!/\.fresh-/.test(BARE_CSS),
    'and shared/monitor.css declares NO `.fresh-` rule — shared/freshness.css owns the '
    + 'app\'s one scale, and test-freshness-scale.js §4 forbids a second declaration');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3 — EVERY CALLER STRING IS ESCAPED, AND ONE NAMED FIELD IS NOT');
// ═════════════════════════════════════════════════════════════════════════
const XSS = '<img src=x onerror=alert(1)>';
const ATTR = '" onmouseover="alert(1)';
{
  const hostile = renderMonitor({
    id: 'i' + ATTR,
    label: 'L' + ATTR,
    head: { stateWord: 'W' + XSS, tone: 'ok" onclick="x' },
    lines: [{ key: 'K' + XSS, value: 'V' + XSS, sub: 'S' + XSS, tone: 'warn' + ATTR }],
    loud: [{ text: 'T' + XSS, strongText: 'R' + XSS, tone: 'danger' + ATTR }],
    note: 'N' + XSS,
  });
  ok(!hostile.includes('<img'), 'no caller string reaches the page as a tag');
  {
    const handlers = tags(hostile).flatMap((t) => Object.keys(t.attrs))
      .filter((k) => /^on[a-z]/i.test(k));
    eq('...and not one parsed attribute is an event handler', handlers.join(','), '');
    eq('CONTROL: the detector finds a real one',
      tags('<b onclick="x">').flatMap((t) => Object.keys(t.attrs))
        .filter((k) => /^on[a-z]/i.test(k)).join(','), 'onclick');
  }
  for (const m of hostile.matchAll(/class="([^"]*)"/g)) {
    ok(/^[A-Za-z0-9_ -]*$/.test(m[1]),
      'a class attribute holds only class-alphabet characters: "' + m[1] + '"');
  }
  // TONE IS A LOOKUP, NOT AN INTERPOLATION. An unknown word yields NO class,
  // so a caller cannot compose one.
  // SCOPED TO THE LINE AND THE STATE WORD. A raw scan for `cur-mon-warn"`
  // also matches the LOUD entry, which correctly DEFAULTS to `warn` when its
  // own tone is unrecognised — the assertion would have been reading the
  // default as the defect.
  ok(/class="cur-mon-line"/.test(hostile),
    'an unrecognised `tone` on a line yields NO ink class rather than a composed '
    + 'attribute, and the line still renders in the default ink', hostile);
  ok(/class="cur-mon-state"/.test(hostile),
    '...and the same on a state word');
  ok(/class="cur-mon-loud cur-mon-warn"/.test(hostile),
    'CONTROL: a loud entry with an unrecognised tone falls back to `warn`, because '
    + 'a loud entry is never ordinary text');
  for (const [tone, cls] of [['ok', 'cur-mon-ok'], ['warn', 'cur-mon-warn'],
    ['danger', 'cur-mon-danger'], ['quiet', 'cur-mon-quiet']]) {
    ok(renderMonitor({ lines: [{ key: 'k', value: 'v', tone }] })
      .includes('class="cur-mon-line ' + cls + '"'),
    'CONTROL: `' + tone + '` resolves to `' + cls + '`');
  }
  ok(!renderMonitor({ lines: [{ key: 'k', value: 'v', tone: '__proto__' }] })
    .includes('cur-mon-line '),
  'a prototype key is not a tone — the lookup is an own-property check, not a '
    + 'truthiness one');

  // THE ONE TRUSTED FIELD, NAMED.
  ok(renderMonitor({ lines: [{ key: 'k', value: 'v',
    markHtml: '<span class="fresh-dot fresh-live"></span>' }] })
    .includes('<span class="fresh-dot fresh-live"></span>'),
  '`markHtml` is TRUSTED, pre-rendered markup — the contract renderReadout carries');
  eq('...and it is the ONLY field the module passes through untouched',
    [...new Set([...BARE_JS.matchAll(/trusted\((?:l|w|opts)\.(\w+)\)/g)].map((m) => m[1]))]
      .sort().join(','), 'markHtml');
  // `strongText` is NOT trusted: its one producer is a ROUTE PAYLOAD.
  ok(/<strong>R&lt;img/.test(hostile),
    '`strongText` is ESCAPED and wrapped by the kit — its one producer is a route '
    + 'payload, and a payload is data');
  for (const junk of [{ a: 1 }, ['<b>'], 7, true]) {
    ok(!/\[object|<b>|>7<|true</.test(renderMonitor({
      lines: [{ key: 'k', value: 'v', markHtml: junk }] })),
    'a ' + typeof junk + ' in `markHtml` is dropped, not stringified');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§4 — v3.16.1: A WARNING IS NEVER BEHIND A CHEVRON, NOR AMONG THE READINGS');
// ═════════════════════════════════════════════════════════════════════════
{
  // THE FIXTURE CARRIES BOTH, which is the half that matters: a fixture with
  // nothing loud in it makes the mutation inert, and v3.64.2 recorded exactly
  // that green-first.
  ok(withClass(B, 'cur-mon-line').length >= 2 && withClass(B, 'cur-mon-loud').length === 1,
    'CONTROL — the fixture carries BOTH ordinary lines and a loud one, so a '
    + 'mutation that confuses them cannot be inert', B);
  const outside = outsideLines(B);
  ok(outside.includes('A bridge started 2 days ago is serving older code.'),
    'the loud text falls OUTSIDE the line list');
  ok(outside.includes('Restart the app that launched it'),
    '...and so does its remedy');
  ok(!outside.includes('Claude Desktop</span>'),
    'CONTROL — the slicer really does remove the line list (an ordinary reading is '
    + 'NOT in the outside slice)', outside);
  ok(outside.includes('25 self-test calls excluded.'),
    '...and the producer\'s own note is outside it too');

  // NO CHEVRON ANYWHERE, for any input.
  for (const [name, html] of [['bridge', B], ['saved', S], ['health', H]]) {
    ok(!/<details|<summary/.test(html),
      name + ': the component emits no `<details>` — there is nothing here to collapse');
  }
  ok(!/details|summary/.test(BARE_JS),
    '...and the module names neither, so no option can add one');

  // NO FIELD ON A LINE CAN MAKE ONE LOUD. The separation is structural: a
  // different array, a different container, no shared path.
  const asLine = renderMonitor({ lines: [{ key: 'k', value: 'v', tone: 'danger',
    loud: true, text: 'danger text' }] });
  ok(!asLine.includes('cur-mon-loud') && !asLine.includes('danger text'),
    'a `loud: true` on a LINE does nothing — a loud entry comes from its own array');
  // ORDER: the loud block is after the lines and before the note.
  ok(B.indexOf('cur-mon-lines') < B.indexOf('cur-mon-loud')
    && B.indexOf('cur-mon-loud') < B.indexOf('cur-mon-note'),
  'the loud block sits between the readings and the note');
  // A LOUD ENTRY IS ANNOUNCED; the readings are not.
  ok(/<div class="cur-mon-loud cur-mon-warn" role="status">/.test(B),
    'the loud block carries `role="status"` — a warning appearing IS what a screen '
    + 'reader user needs told');
  ok(!/cur-mon-lines" role|cur-mon" role="status"/.test(B),
    '...and the readings do NOT, because announcing every repaint makes a screen '
    + 'unusable');
  eq('a loud entry with no tone still defaults to `warn` — it is not ordinary text',
    /<div class="cur-mon-loud cur-mon-warn" role="status">plain<\/div>/
      .test(renderMonitor({ loud: [{ text: 'plain' }] })), true);
  eq('a loud entry with no text is dropped rather than rendered empty',
    withClass(renderMonitor({ loud: [{ text: '' }, { text: 'real' }] }),
      'cur-mon-loud').length, 1);
  // THE LOUD LINE WRAPS. A warning that ellipsised would be a warning you
  // cannot read.
  ok(!/\.cur-mon-loud\s*\{[^}]*text-overflow/.test(BARE_CSS)
    && /\.cur-mon-loud\s*\{[^}]*overflow-wrap:\s*anywhere/.test(BARE_CSS),
  'and the stylesheet lets it WRAP rather than ellipsise');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5 — THE STYLESHEET: DISTINGUISHED, AND OUT OF TWO PREFIXES');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(INDEX_HTML.includes('href="/next/shared/monitor.css"'),
    'the stylesheet is LINKED — an unlinked one is unstyled AND invisible to test-css-tokens.js §5');
  const linkAt = INDEX_HTML.indexOf('/next/shared/monitor.css');
  const firstView = INDEX_HTML.indexOf('/next/views/');
  ok(linkAt !== -1 && firstView !== -1 && linkAt < firstView,
    '...ABOVE the view sheets, so a host may still place it', linkAt + ' vs ' + firstView);

  const emitted = new Set();
  for (const m of KIT_JS.matchAll(/class="(cur-mon[\w-]*)/g)) emitted.add(m[1]);
  for (const m of KIT_JS.matchAll(/'(cur-mon-(?:ok|warn|danger|quiet))'/g)) emitted.add(m[1]);
  ok(emitted.size >= 8, 'CONTROL — the component emits ' + emitted.size + ' kit classes',
    [...emitted].join(','));
  for (const c of emitted) {
    ok(new RegExp('\\.' + c + '\\b').test(BARE_CSS),
      '`.' + c + '` resolves a rule in the kit stylesheet');
  }

  // ── DISTINGUISHED FROM A CARD AND FROM A FOLD ROW ─────────────────────
  const monRule = /\.cur-mon\s*\{([^}]*)\}/.exec(BARE_CSS);
  ok(!!monRule, 'CONTROL — the block rule is found');
  ok(/background:\s*var\(--surface-inset\)/.test(monRule[1]),
    'the block sits on --surface-inset — the app\'s own "set INTO the page" token, '
    + 'darker than the canvas in dark and lighter than a raised card in light');
  ok(/border:\s*1px solid var\(--border\)/.test(monRule[1]),
    '...behind a 1px --border');
  ok(/font:\s*var\(--type-mono\)/.test(monRule[1]),
    '...in the mono face, set ONCE on the container and inherited');
  // NOT the accent wash an explanation takes. An explanation and a reading
  // must not look alike.
  ok(!/--accent-tint|--accent\b/.test(monRule[1]),
    'and NOT the accent wash a `.tx-vh-panel` uses — that wash means "an explanation"');
  ok(/background-image:\s*linear-gradient\(var\(--accent-tint\)/.test(TEXT_CSS),
    'CONTROL: the explanation panel really does take it');

  // MONO COMES FROM CSS, NOT FROM THE `mono` UTILITY. That utility is
  // budgeted per view file by test-next-views-kit.js §7, and a component that
  // made every adopter emit four more `mono` spans would spend a budget that
  // exists to stop screens reading as build logs.
  ok(!/class="[^"]*\bmono\b/.test(BARE_JS),
    'the component emits NO `class="mono"` span — the face is the block\'s, so an '
    + 'adopting view\'s mono census FALLS rather than rises');

  ok(/font-variant-numeric:\s*var\(--numeric-tabular\)/.test(BARE_CSS),
    'the values take tabular figures, so a column of counts lines up digit for digit');

  // ── THE TONE RIDES ON A MARK OR A RULE, NEVER ON A WORD ───────────────
  // FOUND BY LOOKING, in the light theme, and this is the guard that stops
  // it coming back. Measured on this block's own surface (#F7F7FA):
  // --danger-text 5.06 PASSES the 4.5:1 text floor, --success-text 3.79 and
  // --attention-text 3.35 FAIL, and there is no darker rung in either family
  // (--teal-700 and --summary-700 both resolve to --text). Dark passes
  // everywhere, so the defect was light-only and invisible from one theme.
  // The app's own recorded rule — views/domains.js's renderStatus note,
  // settings.css's `.status-pill-ok` — is that the state rides on a rail or
  // a mark, where the floor is 3:1 and all three clear it, and the WORDS
  // stay at --text / --text-2.
  {
    const TONE_TOKENS = ['--success-text', '--attention-text', '--danger-text'];
    const offenders = [];
    for (const m of BARE_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const d of m[2].split(';')) {
        const t = d.trim();
        if (!/^color\s*:/.test(t)) continue;
        if (TONE_TOKENS.some((tok) => t.includes(tok))) offenders.push(m[1].trim() + ' { ' + t + ' }');
      }
    }
    ok(offenders.length === 0,
      'no `color:` in the stylesheet names a tone token — a WORD in --attention-text '
        + 'measures 3.35:1 on this surface in light and there is no darker rung',
      offenders.join(' | '));
    // …and they ARE used, on the properties whose floor is 3:1.
    const asMark = TONE_TOKENS.filter((tok) => new RegExp(
      '(?:background|border-left-color)\\s*:\\s*var\\(' + tok + '\\)').test(BARE_CSS));
    eq('CONTROL: …and all three are used as a MARK or a RULE instead',
      asMark.length, TONE_TOKENS.length);
    // Every tone the module can emit resolves a rule, so a tone is never a
    // class with no paint.
    for (const tone of ['ok', 'warn', 'danger', 'quiet']) {
      ok(new RegExp('\\.cur-mon-' + tone + '\\b').test(BARE_CSS),
        '`cur-mon-' + tone + '` resolves a rule');
    }
    // THE GUTTER IS LAID OUT ON EVERY LINE at zero width, so a toned line
    // does not shift its neighbours sideways when it appears.
    ok(/\.cur-mon-line\s*\{[^}]*border-left:\s*2px solid transparent/.test(BARE_CSS),
      'the severity gutter is reserved on every line, not added to a toned one');
  }
  ok(!/\.fresh-/.test(BARE_CSS), 'NO `.fresh-` rule');
  ok(!/\.tx-/.test(BARE_CSS), 'NO `.tx-` rule');
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(BARE_CSS), 'NO colour literal — every colour is a token');
  ok(!/font-size:\s*\d+px/.test(BARE_CSS),
    'NO px font-size — the --font-scale control would not reach it');
  // THE NARROW CASE. At 568 the rail (72) plus a view sidebar (272) leave
  // 224px of column, and a two-column line has nowhere to put a long value.
  ok(/@media \(max-width: 640px\)[\s\S]*cur-mon-line\s*\{\s*grid-template-columns:\s*1fr/.test(BARE_CSS),
    'below the rail-plus-sidebar squeeze the pair STACKS rather than overflowing');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6 — WHY IT IS NOT A renderReadout, RE-CHECKED RATHER THAN REMEMBERED');
// ═════════════════════════════════════════════════════════════════════════
{
  // Obstacle 1: the readout is a COLUMN and the monitor is a ROW.
  const ro = /\.tx-readout\s*\{([^}]*)\}/.exec(TEXT_CSS.replace(/\/\*[\s\S]*?\*\//g, ''));
  ok(!!ro && /flex-direction:\s*column/.test(ro[1]),
    '`.tx-readout` lays its label ABOVE its value, and the monitor\'s anatomy is '
    + 'key LEFT / value RIGHT', ro && ro[1]);
  ok(/\.cur-mon-line\s*\{[^}]*grid-template-columns:\s*auto 1fr/.test(BARE_CSS),
    '...which is what the monitor\'s own line declares');
  // Obstacle 2: a container here cannot re-lay-out that child.
  ok(!/\.tx-/.test(BARE_CSS),
    '...and shared/monitor.css may not reach it: test-next-text-system.js §8 fails any '
    + '/next stylesheet but shared/text.css that declares a `.tx-` rule, and proves '
    + 'that guard against a planted REAL FILE');
  // And the line renderReadout owns is untouched by this release.
  ok(/<span class="tx-readout-value">/.test(readFileSync(path.join(NEXT, 'shared/text.js'), 'utf8')),
    'CONTROL: renderReadout keeps its name, its contract and its markup this release');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7 — THE COPIED HELPER, PINNED RATHER THAN TRUSTED');
// ═════════════════════════════════════════════════════════════════════════
{
  const grab = (src) => extractFunction(src, 'escapeHtml', 'kit').replace(/\s+/g, ' ').trim();
  eq('shared/monitor.js\'s escapeHtml is byte-identical to shared/overview.js\'s '
    + '(modulo whitespace)', grab(KIT_JS), grab(OVERVIEW_JS));
  eq('CONTROL — and it escapes all five characters',
    new Function(extractFunction(KIT_JS, 'escapeHtml', 'kit') + '\nreturn escapeHtml;')()('<&>"\''),
    '&lt;&amp;&gt;&quot;&#39;');
  const imports = [...KIT_JS.matchAll(/^import .*from '([^']+)';$/gm)].map((m) => m[1]);
  eq('the kit imports NOTHING — it is the leaf of the kit graph', imports.join(','), '');
  ok(!/document|window/.test(BARE_JS),
    '...and touches no DOM, so an offline suite can import it');
}


// ═════════════════════════════════════════════════════════════════════════
section('§8 — THE DEPTH BAR: a length is a measurement, not a decoration');
// ═════════════════════════════════════════════════════════════════════════
//
// v3.65.1. The app's THIRD visual channel — the freshness dot answers HOW OLD,
// the identity dot answers WHOSE, and this answers HOW MUCH, OF WHAT. The
// whole value of a third channel is in never being confused with the two it
// joins, so what is asserted here is the arithmetic (a length that is not
// value/denominator is a lie drawn to scale), the clamp, the ONE automatic
// tone and the places a bar may never appear.
{
  const pctOf = (h) => {
    const m = /style="width:([\d.]+)%"/.exec(h);
    return m ? Number(m[1]) : null;
  };

  // ── THE ARITHMETIC ───────────────────────────────────────────────────
  eq('a bar is value ÷ max, to one decimal',
    pctOf(renderDepthCell({ value: '161', amount: 161, max: 767 })), 21);
  eq('...and value ÷ BUDGET when there is one, which REPLACES max',
    pctOf(renderDepthCell({ value: '62 KB', amount: 63488, budget: 204800, max: 9 })), 31);
  eq('...rounded to one decimal, because a category at 6.9% of a domain and one '
    + 'at 7.4% are different readings',
  pctOf(renderDepthCell({ value: '53', amount: 53, max: 767 })), 6.9);

  // ── THE CLAMP ────────────────────────────────────────────────────────
  // A value over its budget FILLS the cell rather than overflowing it: a bar
  // 105% wide is a bar drawn outside the figure it qualifies.
  eq('a value over its budget fills the cell and does not overflow it',
    pctOf(renderDepthCell({ value: '210 KB', amount: 215042, budget: 204800 })), 100);
  eq('...and a negative amount draws nothing rather than a reversed bar',
    pctOf(renderDepthCell({ value: '-1', amount: -1, max: 10 })), null);

  // ── NO DENOMINATOR, NO BAR ───────────────────────────────────────────
  // A bar drawn against nothing is decoration, and a zero-width one reads as
  // "none of it" rather than as "unknown".
  for (const [what, o] of [
    ['no denominator at all', { value: '5', amount: 5 }],
    ['a zero denominator', { value: '5', amount: 5, max: 0 }],
    ['a non-finite denominator', { value: '5', amount: 5, max: Infinity }],
    ['an amount that is not a number', { value: 'many', max: 10 }],
  ]) {
    const h = renderDepthCell(o);
    ok(
      !/cur-depth-bar/.test(h) && /cur-depth-value/.test(h),'with ' + what + ' the FIGURE is printed and NO bar is drawn', h);
  }

  // ── THE ONE AUTOMATIC TONE, AND ONLY AGAINST A BUDGET ────────────────
  // Being the largest of a set of visible rows is not a fault; colouring it as
  // one would make a bar an alarm every time somebody sorted a table. An
  // over-run against a STATED budget is a fact.
  ok(
    /cur-depth-bar cur-depth-danger/.test(
      renderDepthCell({ value: '210 KB', amount: 215042, budget: 204800 })),'a value over its BUDGET takes the danger tone by itself');
  ok(!/cur-depth-danger/.test(renderDepthCell({ value: '999', amount: 999, max: 999 })),
    '...and a value that is merely the LARGEST of a set does NOT',
    renderDepthCell({ value: '999', amount: 999, max: 999 }));
  // AND A VALUE THAT EXCEEDS ITS `max` STILL DOES NOT — which is the case a
  // mutation reaches by swapping the condition to `amount > max`. A `max` is a
  // COMPARISON ("the largest of the rows you can see"), and being larger than
  // one is what happens when the denominator is stale or the set is filtered;
  // colouring that red would make a bar an alarm every time somebody sorted a
  // table. Only a stated BUDGET can be over-run.
  ok(!/cur-depth-danger/.test(renderDepthCell({ value: '1200', amount: 1200, max: 999 })),
    '...nor does one that EXCEEDS its max — a max is a comparison, not a limit, '
    + 'and only a stated budget can be over-run',
  renderDepthCell({ value: '1200', amount: 1200, max: 999 }));
  ok(
    !/cur-depth-danger/.test(renderDepthCell({ value: '200 KB', amount: 204800, budget: 204800 })),'...and exactly ON the budget is not over it');

  // ── A TONE IS A CLASS NAME, FILTERED — NEVER ESCAPED AND HOPED ───────
  // shared/overview.js's rule: an escaped class attribute is still an
  // attribute the caller composed.
  const hostile = renderDepthCell({ value: '1', amount: 1, max: 2,
    toneClass: 'x" onload="alert(1)' });
  ok(
    !/onload/.test(hostile) && !/alert/.test(hostile),'a tone carrying quotes is DROPPED, not escaped into the attribute', hostile);
  ok(
    /cur-depth-bar cur-depth-quiet/.test(
      renderDepthCell({ value: '1', amount: 1, max: 2, toneClass: 'cur-depth-quiet' })),'CONTROL: a legitimate tone name survives');

  // ── THE FIGURE AND THE LABEL ARE ESCAPED ─────────────────────────────
  const xss = renderDepthCell({ value: '<img src=x onerror=alert(1)>', amount: 1, max: 2,
    label: '<b>of</b> 2' });
  ok( !/<img/.test(xss) && /&lt;img/.test(xss),'the printed figure is escaped', xss);
  ok(
    !/<b>/.test(xss) && /&lt;b&gt;/.test(xss),'...and so is the denominator sentence — it is DATA, never markup', xss);
  ok(
  /<span class="visually-hidden"> of a 200 KB budget<\/span>/.test(
    renderDepthCell({ value: '62 KB', amount: 63488, budget: 204800, label: 'of a 200 KB budget' })),'the denominator rides as a visually-hidden sentence, because a bar whose '
    + 'denominator the reader cannot name is decoration');
  ok(
    /class="cur-depth-bar"[^>]*aria-hidden="true"/.test(
      renderDepthCell({ value: '1', amount: 1, max: 2 })),'and the bar itself is aria-hidden — the figure ON it is the reading');

  // ── A NON-SCALAR IS DROPPED, NOT STRINGIFIED ────────────────────
  // The same rule `renderMonitor`'s own `value` follows: an object, an array or
  // a function is DROPPED rather than turned into "[object Object]" on the
  // page. A cell that prints a figure is a cell whose figure is a figure.
  eq('an object value renders NOTHING rather than "[object Object]"',
    renderDepthCell({ value: { a: 1 }, amount: 1, max: 2 }), '');
  eq('...and so does an array', renderDepthCell({ value: [1, 2], amount: 1, max: 2 }), '');
  eq('...and a missing value', renderDepthCell({ amount: 1, max: 2 }), '');
  ok(/cur-depth-value">0</.test(renderDepthCell({ value: 0, amount: 0, max: 2 })),
    'CONTROL: a legitimate ZERO is still printed — dropping it would be the '
    + '"an absent figure is not a zero" defect read backwards',
  renderDepthCell({ value: 0, amount: 0, max: 2 }));

  // A `depth` THAT IS NOT AN OBJECT IS IGNORED, not spread. A string spreads
  // into its characters, which would hand `renderDepthCell` a `0`, `1`, `2`…
  // map and a `value` it never asked for.
  ok(!/cur-depth/.test(renderMonitor({ lines: [{ key: 'k', value: 1, depth: 'max: 10' }] })),
    'a depth that is not an object draws no bar rather than being spread',
    renderMonitor({ lines: [{ key: 'k', value: 1, depth: 'max: 10' }] }));
  ok(/cur-mon-value">1</.test(renderMonitor({ lines: [{ key: 'k', value: 1, depth: 'max: 10' }] })),
    '...and the figure is still printed, escaped, as an ordinary line');

  // ── A MONITOR LINE DECLARES `depth` AS DATA, NEVER AS MARKUP ─────────
  // The component draws the bar. A caller that could hand over markup for the
  // VALUE would be a caller that could hand over anything, and `markHtml` is
  // the whole of what this component's escaping discipline has to reason about.
  const mon = renderMonitor({ lines: [
    { key: 'entities', value: 161, depth: { amount: 161, max: 767, label: 'of 767 pages' } },
    { key: 'pages', value: 767 },
  ] });
  ok( /cur-depth-bar/.test(mon),'a line carrying `depth` is drawn WITH a bar', mon);
  eq('...at the length its own numbers give it', pctOf(mon), 21);
  ok(
  (mon.match(/cur-depth-bar/g) || []).length === 1,'...and a line WITHOUT `depth` gets none — the denominator line is not a '
    + 'reading about itself', mon);
  const forged = renderMonitor({ lines: [
    { key: 'k', value: '<img src=x>', depth: { amount: 1, max: 2 } }] });
  ok(
    !/<img/.test(forged) && /&lt;img/.test(forged),'a figure inside a depth cell is still escaped by the component', forged);

  // ── AND THE COMPONENT EMITS NO <details>, SO NO BAR CAN FOLD ─────────
  ok(
    !/<details/.test(mon) && !/<summary/.test(mon),'nothing this component draws can put a bar behind a chevron', mon);

  // ── THE STYLESHEET ───────────────────────────────────────────────────
  {
    const css = readFileSync(path.join(NEXT, 'shared/depth-bar.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    ok(
    !/\.fresh-/.test(css),'shared/depth-bar.css declares NO `.fresh-` rule — the freshness scale is '
      + 'owned outright by shared/freshness.css, and a bar never encodes time', (css.match(/.{0,60}\.fresh-.{0,60}/) || [''])[0]);
    ok(
      !/\.tx-/.test(css),'...and no `tx-` rule either — shared/text.css owns that prefix', (css.match(/.{0,60}\.tx-.{0,60}/) || [''])[0]);
    ok(
      [...css.matchAll(/(^|\})\s*([^{}]+)\{/g)].map((m) => m[2].trim())
        .every((sel) => sel.split(',').every((x) => /\.cur-depth/.test(x))),'...and every selector it declares is under its own `cur-depth` prefix',
      [...css.matchAll(/(^|\})\s*([^{}]+)\{/g)].map((m) => m[2].trim()).join(' | '));
    ok(
    /\.cur-depth\[hidden\]\s*\{[^}]*display:\s*none/.test(css),'the `[hidden]` counter-rule is present — `[hidden]` loses to an author '
      + '`display:` at any specificity, which is v3.62.0\'s measured defect', css.slice(0, 200));
    ok(
    /\.cur-depth-bar\s*\{[^}]*right:\s*0/.test(css),'the bar is anchored at the RIGHT — that is what makes a column of them '
      + 'comparable at a glance', css.slice(0, 200));
    ok(
      /\.cur-depth-bar\s*\{[^}]*position:\s*absolute/.test(css),'...and it is positioned, so it sits BEHIND the figure rather than beside it');
    ok(
      /<link[^>]*href="\/next\/shared\/depth-bar\.css"/.test(
        readFileSync(path.join(NEXT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')),
    'and the stylesheet is LINKED — checked with the HTML COMMENTS STRIPPED, '
      + 'because a commented-out <link> still matches a bare filename scan and '
      + 'that mutation was green');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§9 — TONE: ONE ALPHABET, AND A LINE CARRIES A MARK OR A TONE, NEVER BOTH (v3.66.0)');
// ═════════════════════════════════════════════════════════════════════════
{
  eq('the alphabet is exactly ok · warn · danger · quiet', TONE_WORDS.join(','), 'ok,warn,danger,quiet');
  eq('TONES is exported and keyed by exactly those words', Object.keys(TONES).join(','), TONE_WORDS.join(','));
  ok(Object.isFrozen(TONES) && Object.isFrozen(TONE_WORDS), '...and neither table can be mutated by a caller');
  for (const w of TONE_WORDS) eq(`normalizeTone("${w}") is itself`, normalizeTone(w), w);
  for (const [legacy, w] of [['success', 'ok'], ['attention', 'warn'], ['error', 'danger'],
    ['neutral', 'quiet'], ['info', 'quiet'], ['default', 'quiet']]) {
    eq(`the older spelling "${legacy}" normalises to "${w}"`, normalizeTone(legacy), w);
  }
  for (const not of ['busy', 'accent', 'red', '', '__proto__', 'constructor', 'toString']) {
    eq(`"${not}" is NOT an outcome — null, never a guess`, normalizeTone(not), null);
  }
  eq('a non-string is not a tone', normalizeTone({ tone: 'ok' }), null);

  // THE RENDERER STAYS STRICT: an older spelling passed straight to a line is
  // NOT honoured (the caller normalises first), so one table decides.
  const legacy = renderMonitor({ lines: [{ key: 'k', value: 'v', tone: 'success' }] });
  ok(!/cur-mon-ok/.test(legacy), 'renderMonitor does not silently accept "success" — callers pass normalizeTone(...)', legacy);

  // MARK OR TONE, NEVER BOTH. Tone and time share inks (ok = fresh-hot's
  // teal, warn = fresh-mid's amber) and are told apart by POSITION alone.
  const dot = '<span class="fresh-dot fresh-recent" aria-hidden="true"></span>';
  const both = renderMonitor({ lines: [{ key: 'saved', value: '12 min ago', markHtml: dot, tone: 'warn' }] });
  ok(both.includes('fresh-dot'), 'a line given both keeps its freshness mark', both);
  ok(!/cur-mon-line[^"]*cur-mon-warn/.test(both), '...and DROPS the tone, so no teal dot sits beside a teal rule', both);
  const toneOnly = renderMonitor({ lines: [{ key: 'open issues', value: 4, tone: 'warn' }] });
  ok(/class="cur-mon-line cur-mon-warn"/.test(toneOnly), 'CONTROL — a line with a tone and no mark keeps its gutter rule', toneOnly);
  const emptyMark = renderMonitor({ lines: [{ key: 'k', value: 1, markHtml: '', tone: 'danger' }] });
  ok(/cur-mon-danger/.test(emptyMark), 'CONTROL — an EMPTY markHtml is no mark, so the tone survives', emptyMark);
  // A loud entry is a rule by construction and may carry any tone.
  const loud = renderMonitor({ lines: [{ key: 'k', value: 1, markHtml: dot }], loud: [{ tone: 'danger', text: 'over budget' }] });
  ok(/cur-mon-loud cur-mon-danger/.test(loud), 'a loud entry keeps its tone beside a marked line', loud);

  // THE STYLESHEET: the tone is a MARK (dot or rule) and never a word's ink.
  const toneColourOnText = [...BARE_CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter((m) => /(^|[;\s])color\s*:\s*var\(--(success|attention|danger)(-text)?\)/.test(m[2]))
    .map((m) => m[1].trim());
  eq('monitor.css colours NO text with a tone ink', toneColourOnText.join(' | '), '');
}

// ═════════════════════════════════════════════════════════════════════════
section('§10 — shared/depth-bar.js IS THE BAR\'S ADDRESS, AND ITS IDENTITY TONE IS THE ONE PALETTE (v3.66.0)');
// ═════════════════════════════════════════════════════════════════════════
{
  ok(DEPTH.renderDepthCell === renderDepthCell,
    'depth-bar.js re-exports THE SAME function object — one implementation, two addresses');
  eq('depth-bar.js exports exactly the cell and the identity tone (index arithmetic + the recorded-slot form views use, v3.76.0)',
    Object.keys(DEPTH).sort().join(','), 'depthIdentityClass,depthIdentitySlotClass,renderDepthCell');
  let slotAgree = true;
  for (let slot = 1; slot <= 12; slot++) {
    if (DEPTH.depthIdentitySlotClass(slot).replace('cur-depth-id-', '') !== identitySlotClass(slot).replace('cur-sb-dot-', '')) slotAgree = false;
  }
  ok(slotAgree, 'depthIdentitySlotClass(slot) names the SAME slot as identitySlotClass(slot), 1..12');
  ok([0, 13, -1, 2.5, null, undefined, '3'].every((v) => DEPTH.depthIdentitySlotClass(v) === '' && identitySlotClass(v) === ''),
    'an invalid slot is NO tone and NO dot — never a guessed one');
  // The identity tone and the dot are ONE mapping.
  let agree = true;
  for (let i = 0; i < 40; i++) {
    if (DEPTH.depthIdentityClass(i).replace('cur-depth-id-', '') !== identityDotClass(i).replace('cur-sb-dot-', '')) agree = false;
  }
  ok(agree, 'depthIdentityClass(i) names the SAME slot as identityDotClass(i) for 40 indices, wrap included');
  eq('index 0 is id-1', DEPTH.depthIdentityClass(0), 'cur-depth-id-1');
  eq('a non-number is id-1, never NaN', DEPTH.depthIdentityClass(undefined), 'cur-depth-id-1');
  // The class it returns survives renderDepthCell's class filter and REPLACES
  // the neutral fill rather than adding danger.
  const cell = renderDepthCell({ value: 687, amount: 687, max: 900, toneClass: DEPTH.depthIdentityClass(2) });
  ok(/class="cur-depth-bar cur-depth-id-3"/.test(cell), 'the identity tone reaches the bar', cell);
  // CSS: one rule per slot, each reading ITS OWN token — no second palette.
  const depthCss = readFileSync(path.join(NEXT, 'shared/depth-bar.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const idRules = [...depthCss.matchAll(/\.cur-depth-id-(\d+)\s*\{([^}]*)\}/g)];
  eq('depth-bar.css declares one identity tone per palette slot', idRules.length, 12);
  ok(idRules.every((m) => new RegExp('var\\(--id-' + m[1] + '\\)').test(m[2])),
    '...and each reads its OWN --id-N, so the bar and the dot cannot drift', idRules.map((m) => m[0]).join(' '));
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(depthCss), '...with no colour literal anywhere in the file');
  ok(IDENTITY_SLOTS <= idRules.length, 'the slot count never exceeds the declared tones (lowering it to 8 stays valid)');
  // depth-bar.js takes ONLY the palette and the monitor — both DOM-free.
  const djs = readFileSync(path.join(NEXT, 'shared/depth-bar.js'), 'utf8');
  const froms = [...djs.matchAll(/^(?:import|export)\s[^\n]*from '([^']+)';$/gm)].map((m) => m[1]).sort();
  eq('depth-bar.js reaches exactly ./identity-palette.js and ./monitor.js', froms.join(','), './identity-palette.js,./monitor.js');
}

console.log('\n  ' + '─'.repeat(60));
console.log('  Passed: ' + passed + '   Failed: ' + failed);
if (failed) {
  console.log('  \x1b[31m❌ ' + failed + ' monitor-kit assertion(s) failed\x1b[0m');
  process.exit(1);
}
console.log('  \x1b[32m✅ one monitor, every live reading\x1b[0m');
