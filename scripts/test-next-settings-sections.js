#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-settings-sections.js — the block pattern, on the sections that
 *  are not Providers & keys.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THIS PINS, AND WHY IT IS NOT ALREADY PINNED ───────────────────────
 *
 * v3.53.0 rebuilt Providers & keys onto `settingsBlock(...)`: a bold title, a
 * lede of at most twenty visible words, everything longer behind a shared ⓘ
 * fold, warnings never folded, and one rhythm (24 | hairline | 24) supplied by
 * the helper rather than by a margin somebody picked. The other three sections
 * that render a body — MCP bridge, Health & scan limits, Knowledge base — were
 * left on the old shape, and this release moves them across.
 *
 * `scripts/test-next-model-gone-ui.js` already pins the RHYTHM (the CSS rule
 * and the wrapper's markup). What nothing pinned is that these three sections
 * USE it. A renderer that goes back to a bare `.settings-section` with 73px
 * gaps, or grows a `style="margin-top:22px"` because a body needed one more
 * pixel of air, is a silent regression to exactly the shape v3.53.0 removed —
 * the page still renders, nothing throws, and no assertion anywhere notices.
 *
 * ── THE GUARDS ─────────────────────────────────────────────────────────────
 *   G1  each renderer calls settingsBlock(), and none emits .settings-section
 *   G2  settings.js carries no inline style that positions or spaces anything
 *   G3  every lede these renderers emit is ≤ 20 visible words  (EXECUTED)
 *   G4  a finding is never inside a fold: the stale note and the validation
 *       error render outside every hidden container                (EXECUTED)
 *   G5  every <details> in this view carries a `data-` hook
 *
 * ── EXECUTED, NOT SCANNED, WHERE IT MATTERS ────────────────────────────────
 * G3 and G4 run the real renderers with injected dependencies (the technique
 * scripts/test-next-mcp-wizard.js §11 uses on renderMcp) and measure the HTML
 * a user is actually served. A source regex asking "is there a lede here" is
 * the shape CLAUDE.md records as worse than no test at all: it proves a line
 * exists and says nothing about what it does. `settingsBlock` and `infoMark`
 * are lifted REAL for the same reason — a stubbed block helper would let this
 * file assert the properties of its own stub.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { docsLinkHtml } from '../src/public/next/shared/docs-links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SETTINGS_JS = path.join(ROOT, 'src/public/next/views/settings.js');
const src = readFileSync(SETTINGS_JS, 'utf8');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  [32m✓[0m ' + msg); }
  else { failed++; console.log('  [31m✗[0m ' + msg); }
}
function section(t) { console.log('\n[1m' + t + '[0m'); }

/**
 * THE RENDERER LIST, IN ONE PLACE.
 *
 * ⚠ `renderGeneral` IS DELIBERATELY ABSENT and must be added by the
 * orchestrator AFTER the parallel conversion of that function lands. It is
 * being moved onto `settingsBlock` in another worktree; adding it here before
 * that merge makes this suite red against a file that has not changed yet.
 * When it merges, add the string and nothing else — every guard below reads
 * this array.
 *
 * `renderProviders` is absent for a different reason: it does not call
 * `settingsBlock` itself, it concatenates four helpers that each do, and those
 * four are already executed by test-next-model-gone-ui.js and
 * test-next-providers-page.js.
 */
const SECTION_RENDERERS = ['renderMcp', 'renderHealthLimits', 'renderStorage'];

// ── Extraction: brace-matched, loud on desync ─────────────────────────────
// The same matcher test-next-ui-polish.js and test-next-mcp-wizard.js use. A
// lazy `[\s\S]*?\n\}` regex stops at the first column-0 closing brace inside
// the function, which truncates silently and produces a syntax error naming
// nothing.
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ${name}\\s*\\(`);
  const m = marker.exec(source);
  if (!m) throw new Error(`extractFunction: "${name}" not found in views/settings.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let p = source.indexOf('(', start);
  let parenDepth = 0;
  for (; p < source.length; p++) {
    if (source[p] === '(') parenDepth++;
    else if (source[p] === ')') { parenDepth--; if (parenDepth === 0) { p++; break; } }
  }
  let i = source.indexOf('{', p);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const extracted = source.slice(start, i).replace(/^export\s+/, '');
  if (!/\n\}$/.test(extracted)) {
    throw new Error(`extractFunction: "${name}" did not end at a top-level brace — the matcher desynced`);
  }
  return extracted;
}

/**
 * Comments stripped before any source scan.
 *
 * Proven necessary by mutation on this very file: `<details` appears in
 * THIRTY-odd comments in settings.js explaining the disclosure contract, so a
 * bare scan for it in G5 counts prose as markup and reports failures that are
 * not real. The same rule test-next-listbox.js records for `closeAllListboxes`.
 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const code = stripComments(src);
// A stripper that over-reaches deletes the thing under test and every guard
// below passes vacuously. Pin that it did not.
for (const needle of ['function renderMcp(', 'function renderStorage(', 'settings-job-lede']) {
  if (!code.includes(needle)) throw new Error(`stripComments over-reached: "${needle}" is gone`);
}

// ── The harness: the real renderers, executed ─────────────────────────────
//
// settingsBlock + infoMark are lifted REAL. They are what paint the lede and
// the fold, so stubbing them would make G3 and G4 assertions about the stub.
// deriveMcpStatus and shouldShowMcpStaleNote are lifted real too — G4's whole
// point is that the note fires from the real decision function.
const REAL = [
  extractFunction(src, 'settingsBlock'),
  extractFunction(src, 'infoMark'),
  extractFunction(src, 'deriveMcpStatus'),
  extractFunction(src, 'shouldShowMcpStaleNote'),
].join('\n');

function baseState() {
  return {
    mcpError: null,
    mcp: { mcp_server_name: 'my-curator', domains_dir: '/tmp/d', installed: true, stale: false },
    selfTest: null, selfTestLoading: false, configSnippetOpen: false, configSnippet: null,
    copyFeedback: null,
    defaultDomainInfo: { domains: ['alpha', 'beta'], defaultDomain: 'alpha' },
    defaultDomainSaving: false,
    aiHealthError: null, aiHealth: { costCeilingTokens: 50000, maxPairs: 500 },
    costCeilingInput: '50000', maxPairsInput: '500',
    scanLimitsValidationError: null, aiHealthSaving: false, aiHealthSaved: false,
    configError: null, config: { domainsPath: '/Users/x/Curator Knowledge' },
    pickingFolder: false, pathCopyFeedback: null,
  };
}

function run(name, state) {
  const deps = {
    state,
    escapeHtml: (x) => String(x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    icon: () => '<svg class="i"></svg>',
    TX_INFO_GLYPH: '<svg class="g"></svg>',
    docsLinkHtml,
    gatedLoader: () => '<LOADER/>',
    loadGate: null,
    renderSelfTestResult: () =>
      '<div class="settings-check-results"><div class="check-row check-ok">Bridge responds</div></div>',
    renderListboxHtml: () => '<LISTBOX/>',
    pendingListboxes: [],
    MCP_GUIDE_URL: 'https://example.invalid/guide',
    myMountToken: 1,
    onSaveDefaultDomain: () => {},
    crossWriteBusy: () => false,
    crossWriteTitle: (c) => 'A write is in flight — ' + c,
    renderCrossWriteBanner: () => '',
  };
  const names = Object.keys(deps);
  const fn = new Function(...names, [REAL, extractFunction(src, name), `return ${name};`].join('\n'));
  return fn(...names.map((n) => deps[n]))();
}

// ═══════════════════════════════════════════════════════════════════════════
section('G1  Each section renders as settingsBlock() calls — never .settings-section');
// ═══════════════════════════════════════════════════════════════════════════
//
// `.settings-section` is the OLD wrapper: `gap: var(--space-12)` between
// children with no card, no rule and no title — which on the real page put 73px
// between a heading and the thing under it while two related controls sat 14px
// apart. Both halves are asserted, because a renderer can adopt the helper and
// keep the old wrapper around it, which is the worst of the two (the rhythm
// then reads as 24 + 73).
for (const name of SECTION_RENDERERS) {
  const body = stripComments(extractFunction(src, name));
  const calls = (body.match(/settingsBlock\(/g) || []).length;
  ok(calls >= 1, `${name}() composes its output from settingsBlock() (${calls} call(s))`);
  ok(!/class="settings-section/.test(body) && !/settings-section"/.test(body),
    `${name}() does not wrap itself in .settings-section — the block helper owns the rhythm`);
  // …AND THE SAME THING, EXECUTED. Proven necessary by mutation: an early
  // `return '<div>' + body + '</div>'` placed ABOVE the real return leaves the
  // settingsBlock call in the source, so the scan above stayed green against a
  // section that had stopped rendering a single block. A source assertion
  // proves a line exists and says nothing about what it does.
  const html = run(name, baseState());
  ok(/class="settings-job-block settings-block/.test(html),
    `${name}() really RENDERS a block wrapper — not merely a call to the helper somewhere in its source`);
  ok(!/settings-section/.test(html),
    `${name}()'s output carries no .settings-section wrapper`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('G2  No inline style positions or spaces anything in this view');
// ═══════════════════════════════════════════════════════════════════════════
//
// `renderMcp` carried `style="margin-top:22px"` — a hand-picked number that
// existed because nothing else on the screen supplied a rhythm. An inline style
// is invisible to every CSS guard this repo has (the token check, the contrast
// ratchet, the kit audit all read stylesheets), so it is the one place a
// spacing decision can be made where nothing can see it.
//
// The `.provider-dot` sites are the legitimate exception and the only one: the
// colour is DATA, from the PROVIDER_ROWS table, and a per-provider class would
// be a second table of the same fact. Asserting the two counts are EQUAL is
// what makes this a real guard rather than a list of allowed strings — a new
// inline style anywhere fails it without anyone updating an allow-list.
{
  const allInline = (code.match(/style="/g) || []).length;
  const providerDots = (code.match(/class="provider-dot" style="background:/g) || []).length;
  ok(providerDots >= 3, `CONTROL: the provider-dot colour sites are still there (${providerDots} found)`);
  ok(allInline === providerDots,
    `every inline style in views/settings.js is a provider-dot colour: ${allInline} style=" vs ${providerDots} dots`);
  const spacing = [];
  for (const m of code.matchAll(/style="([^"]*)"/g)) {
    if (/\b(margin|padding|gap|top:|left:|right:|bottom:)/.test(m[1])) spacing.push(m[1]);
  }
  ok(spacing.length === 0,
    spacing.length
      ? `inline spacing/positioning style(s): ${spacing.join(' | ')}`
      : 'no inline style carries margin, padding, gap or an offset — spacing lives in the stylesheet');
}

// ═══════════════════════════════════════════════════════════════════════════
section('G3  Every lede is at most 20 visible words  (EXECUTED)');
// ═══════════════════════════════════════════════════════════════════════════
//
// TWENTY IS THE LINE v3.53.0 DREW and it is about reading, not about counting:
// a lede is the one sentence a user reads before deciding whether to act, and
// past roughly twenty words it stops being a sentence they read and becomes a
// paragraph they skip — which is how the 500-word block 4 that release found
// came to exist, one true sentence at a time.
//
// A WORD is a whitespace-separated token carrying at least one letter or digit,
// so a bare "→" or "·" between two clauses is punctuation rather than a word.
// Tags are stripped first: the ⓘ button lives INSIDE the <p>, and its markup
// is not something anybody reads.
function ledesOf(html) {
  const out = [];
  for (const m of html.matchAll(/<p class="settings-job-lede settings-block-lede">([\s\S]*?)<\/p>/g)) {
    out.push(m[1]);
  }
  return out;
}
function visibleWords(fragment) {
  const text = fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .trim();
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}
{
  let total = 0;
  for (const name of SECTION_RENDERERS) {
    const html = run(name, baseState());
    ok(typeof html === 'string' && html.length > 200,
      `CONTROL: ${name}() really rendered (${html.length} chars)`);
    const ledes = ledesOf(html);
    ok(ledes.length >= 1, `${name}() emits at least one .settings-block-lede (${ledes.length})`);
    for (const l of ledes) {
      const words = visibleWords(l);
      total += 1;
      ok(words.length <= 20,
        `${name}: "${words.slice(0, 6).join(' ')}…" is ${words.length} visible words (<= 20)`);
      ok(words.length >= 4,
        `${name}: …and is a sentence, not a fragment (${words.length} words, >= 4)`);
    }
  }
  ok(total >= 4, `CONTROL: ${total} ledes measured across the three sections (a collapse to 0 would pass everything)`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('G4  A finding is never inside a fold  (EXECUTED)');
// ═══════════════════════════════════════════════════════════════════════════
//
// THE RULE THIS RELEASE APPLIES EVERYWHERE: explanations fold, findings do not.
// The MCP stale note is the outcome of a self-test the user just ran and the
// one thing telling them their client is still launching the old command; the
// scan-limit validation error is why their Save did nothing. Either one behind
// a closed disclosure is information that, for practical purposes, is not there
// — the v3.16.1 finding, restated.
//
// "Not inside a fold" is checked STRUCTURALLY rather than by eye: the marker is
// located, then every `hidden` attribute and every `.settings-block-info` /
// `.tx-vh-panel` opening tag before it is paired against its closing tag, and
// the marker must not fall inside any still-open one.
function insideHiddenContainer(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return 'ABSENT';
  // Walk the div tree up to `at`, tracking the depth at which a hidden /
  // fold-panel container opened. A naive "is `hidden` anywhere before it"
  // check would report every page with a closed fold ABOVE the marker.
  let depth = 0;
  const hiddenDepths = [];
  const tag = /<(\/?)div\b([^>]*)>/g;
  let m;
  while ((m = tag.exec(html)) && m.index < at) {
    if (m[1] === '/') {
      depth--;
      while (hiddenDepths.length && hiddenDepths[hiddenDepths.length - 1] > depth) hiddenDepths.pop();
    } else {
      depth++;
      if (/\bhidden\b/.test(m[2]) || /settings-block-info|tx-vh-panel/.test(m[2])) hiddenDepths.push(depth);
    }
  }
  return hiddenDepths.length > 0;
}
{
  const stale = baseState();
  stale.mcp = { mcp_server_name: 'my-curator', domains_dir: '/tmp/d', installed: true, stale: true,
                claude_config_parse_error: false };
  stale.selfTest = { ok: true, tool_count: 22, tool_names: ['get_index'], domains: ['alpha'] };
  const html = run('renderMcp', stale);
  ok(html.includes('settings-mcp-stale-note'),
    'renderMcp: a stale saved config plus a PASSING self-test renders the reconciliation note');
  ok(html.includes('still launching the'),
    '…with the sentence that explains the contradiction, not just a class name');
  ok(insideHiddenContainer(html, 'settings-mcp-stale-note') === false,
    '…and it is NOT inside any hidden container or ⓘ fold panel');
  ok(insideHiddenContainer(html, 'ChatGPT') !== false,
    'CONTROL: the ChatGPT sentence IS inside the fold — so the detector can tell the two apart');
}
{
  const bad = baseState();
  bad.scanLimitsValidationError = 'Cost ceiling must be a whole number above 0.';
  const html = run('renderHealthLimits', bad);
  ok(html.includes('settings-inline-error'), 'renderHealthLimits: a rejected value renders .settings-inline-error');
  ok(html.includes('must be a whole number'), '…carrying the reason, verbatim');
  ok(insideHiddenContainer(html, 'settings-inline-error') === false,
    '…and it is NOT inside any hidden container or ⓘ fold panel');
}

// ═══════════════════════════════════════════════════════════════════════════
section('G5  Every <details> in this view carries a data- hook');
// ═══════════════════════════════════════════════════════════════════════════
//
// v3.53.1 fixed the Providers screen closing its own disclosures mid-test:
// `render()` now captures which are open before the DOM swap and reopens them
// after, KEYED ON THEIR `data-*` ATTRIBUTE. A `<details>` with no hook cannot
// be keyed, so it silently opts out of the fix — which is exactly what
// `.catalogue-funnel` did, and the release notes say so. That release left the
// rule written in a COMMENT. A comment is not a guard; this is.
{
  let found = 0;
  const unhooked = [];
  for (const m of code.matchAll(/<details\b/g)) {
    found++;
    // The tag ends at the `>` that closes it, which in a concatenated string is
    // `>'` or `>"`. Take a generous window and stop at the first one.
    const window = code.slice(m.index, m.index + 400);
    const endIdx = window.search(/>['"]/);
    const tag = endIdx === -1 ? window.slice(0, 200) : window.slice(0, endIdx);
    if (!/\sdata-[a-z-]+=/.test(tag)) {
      unhooked.push(code.slice(m.index, m.index + 70).replace(/\n/g, ' '));
    }
  }
  ok(found >= 7, `CONTROL: ${found} <details> emitted in views/settings.js (a collapse to 0 would pass vacuously)`);
  ok(unhooked.length === 0,
    unhooked.length
      ? `<details> with no data- hook (render() cannot restore it after a repaint):\n      ${unhooked.join('\n      ')}`
      : 'every <details> carries a data- attribute, so render()\'s capture/restore can key on it');
}

console.log('\n────────────────────────────────────────────────────────────');
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ /next Settings-section assertions FAILED'); process.exit(1); }
console.log('✅ All /next Settings-section assertions green');
