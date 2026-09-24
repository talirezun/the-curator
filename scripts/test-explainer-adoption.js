#!/usr/bin/env node
/**
 * scripts/test-explainer-adoption.js — OFFLINE
 *
 * THE APP-WIDE ADOPTION GUARD for the explainer model (v3.71.1).
 *
 * v3.71.0 moved Context onto one explainer shape and guarded that ONE view
 * (test-next-memory-view.js §26). v3.71.1 moves every other ⓘ, and removes
 * the two duplicate ⓘ implementations (views/settings.js's and
 * views/domains.js's local `infoMark`) plus chat.js's hand-rolled project
 * button. A guard that proves a mechanism exists proves nothing about
 * adoption (the v3.20.0 lesson), so this suite walks the WHOLE /next tree:
 *
 *   §1  ONE IMPLEMENTATION — the ⓘ button and panel markup are emitted by
 *       shared/text.js alone; no local `infoMark`, no glyph copy on a mark;
 *       `renderInfoMark` is called only by the kits (and one named exception)
 *   §2  EVERY ⓘ PANEL IS AN EXPLAINER — every header `info`, overview
 *       `infoText`, block ⓘ and standalone mark resolves to a key in
 *       shared/explainers.js; no ⓘ on a sidebar title
 *   §3  THE KITS, EXECUTED — explainerMark and shared/block.js render, for
 *       every key the app uses, a panel byte-equal to explainerHtml(key)
 *   §4  THE DUMB CROSS-CHECK — every entry in explainers.js is used somewhere
 *       in the app, and every key the app names is an entry
 *   §5  WHAT LEFT THE ⓘ IS ON THE PAGE — the warnings, refusals and state
 *       lines the old panels carried are rendered unfolded, and the false
 *       "never both" note is gone
 *   §6  SELF-TEST — the scanners are fed broken sources and must flag each
 *
 * THE ONE NAMED EXCEPTION. views/ingest.js's `ing-estimate-basis` mark folds
 * the SERVER's own 140–226-word account of how a spend estimate was derived.
 * It is dynamic and it is about money, so it can never be an explainer (an
 * explainer is static and may not carry a cost). The visible lede beside it
 * carries the spend caveat (v3.54.0). It is listed here by id, so a second
 * prose panel anywhere is still red. chat.js's per-message cost figure is a
 * `data-tx-info` DISCLOSURE on the figure itself, not an ⓘ, and is likewise
 * named rather than waved through.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXPLAINERS } from '../src/public/next/shared/explainers.js';
import { explainerHtml, explainerMark } from '../src/public/next/shared/explainer.js';
import { renderBlock } from '../src/public/next/shared/block.js';
import { renderInfoMark } from '../src/public/next/shared/text.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src', 'public', 'next');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

// ── helpers ──────────────────────────────────────────────────────────────
function walk(dir, out) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.js')) out.push(p);
  }
  return out;
}
const FILES = walk(NEXT, []).map((p) => ({ rel: relative(NEXT, p), src: readFileSync(p, 'utf8') }));
const byRel = Object.fromEntries(FILES.map((f) => [f.rel, f]));

/** Drop full-line comments. Code in this tree comments on its own lines. */
function code(src) {
  let inBlock = false;
  return src.split('\n').map((line) => {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; return ''; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return ''; }
    if (t.startsWith('//') || t.startsWith('*')) return '';
    return line;
  }).join('\n');
}

/** Every `name(` call → its raw argument text, balanced, strings respected. */
function calls(src, name) {
  const out = [];
  const re = new RegExp('(^|[^A-Za-z0-9_$.])' + name.replace(/[$]/g, '\\$') + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1; let i = start; let q = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
      if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
    }
    out.push({ args: src.slice(start, i - 1), at: m.index });
  }
  return out;
}
/** Split argument text on top-level commas. */
function splitTop(s) {
  const out = []; let depth = 0; let q = null; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i]; continue; } if (c === q) q = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** The value text of `prop:` at the top level of an object literal's text. */
function propValue(objText, prop) {
  const inner = objText.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const part of splitTop(inner)) {
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(part);
    if (m && m[1] === prop) return m[2].trim();
  }
  return null;
}
const LIT = /^'([a-z]+(?:\.[a-z-]+)+)'$/;
const keyOf = (s) => { const m = LIT.exec(String(s || '').trim()); return m ? m[1] : null; };

/** Module-level names bound to an explainer: `const X = explainerHtml('k')` / explainerMark(…, 'k'). */
function explainerBindings(src) {
  const names = new Set();
  const re = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*explainer(?:Html|Mark)\(/gm;
  let m; while ((m = re.exec(src))) names.add(m[1]);
  return names;
}

/** Is a header `info:` expression an explainer? Returns '' or the reason it is not. */
function infoExprProblem(expr, bindings) {
  const e = expr.trim();
  if (/^explainerHtml\(\s*'[a-z.-]+'\s*(,\s*\{[^}]*\})?\s*\)$/.test(e)) return '';
  if (/^[A-Za-z_$][\w$]*$/.test(e)) return bindings.has(e) ? '' : 'identifier ' + e + ' is not bound to an explainer';
  if (e === 'null' || e === 'undefined' || e === "''") return '';
  // `infoKey ? explainerHtml(infoKey) : null` — a key map, checked separately.
  if (/^infoKey\s*\?\s*explainerHtml\(infoKey\)\s*:\s*null$/.test(e)) return '';
  const t = /^([^?]+)\?([^:]+):(.+)$/.exec(e);
  if (t) return infoExprProblem(t[2], bindings) || infoExprProblem(t[3], bindings);
  return 'not an explainer: ' + e.slice(0, 60);
}

// ── the scanners, as functions, so §6 can feed them broken sources ─────────
const MARK_ALLOWED = new Set(['shared/text.js']);
const RENDER_INFO_MARK_ALLOWED = new Set(['shared/text.js', 'shared/explainer.js', 'shared/overview.js']);
const GLYPH_PATH = 'M12 11v5M12 8h.01';

function scanMarkup(rel, src) {
  const c = code(src);
  const problems = [];
  if (!MARK_ALLOWED.has(rel)) {
    if (/class="tx-vh-info|class="tx-vh-panel/.test(c)) problems.push('emits tx-vh-info/tx-vh-panel markup itself');
    const n = (c.match(/data-tx-info="/g) || []).length;
    // The one named disclosure that is NOT an ⓘ: chat's cost figure.
    const allowed = rel === 'views/chat.js' ? 1 : 0;
    if (n > allowed) problems.push(n + ' hand-written data-tx-info emitter(s)');
    if (rel === 'views/chat.js' && n === 1 && !/function costMarkHtml[\s\S]*?class="chat-msg-cost"[\s\S]*?data-tx-info="/.test(c)) {
      problems.push("chat.js's one data-tx-info is not the cost figure's");
    }
  }
  if (/function\s+infoMark\s*\(/.test(c)) problems.push('declares a local infoMark');
  if (/\b(TX_INFO_GLYPH|CHAT_PROJECT_INFO_GLYPH)\b/.test(c)) problems.push('carries a local ⓘ glyph copy');
  if (c.includes(GLYPH_PATH) && !['shared/text.js', 'shared/explainer.js', 'views/ingest.js'].includes(rel)) {
    problems.push('carries the circled-i glyph path');
  }
  for (const k of calls(c, 'renderInfoMark')) {
    if (RENDER_INFO_MARK_ALLOWED.has(rel)) continue;
    const id = splitTop(k.args)[0];
    if (rel === 'views/ingest.js' && id === "'ing-estimate-basis'") continue;
    problems.push('calls renderInfoMark directly (' + String(id).slice(0, 40) + ')');
  }
  return problems;
}

function scanPanels(rel, src) {
  const c = code(src);
  const binds = explainerBindings(c);
  const problems = [];
  const keys = [];
  for (const k of calls(c, 'renderViewHeader')) {
    if (rel === 'shared/text.js' || rel === 'shared/explainer.js') continue;
    const obj = k.args.trim();
    if (!obj.startsWith('{')) continue;
    const info = propValue(obj, 'info');
    const variant = propValue(obj, 'variant');
    if (variant === "'sidebar'" && info) problems.push('an ⓘ on a sidebar title');
    if (info && !['null', 'undefined'].includes(info)) {
      const p = infoExprProblem(info, binds);
      if (p) problems.push('header info ' + p);
      if (propValue(obj, 'infoHtml') !== 'true') problems.push('header info without infoHtml: true');
    }
  }
  for (const k of calls(c, 'renderOverview')) {
    if (rel === 'shared/overview.js') continue;
    const t = propValue(k.args, 'infoText');
    if (t && !/^explainerHtml\(\s*'[a-z.-]+'\s*\)$/.test(t)) problems.push('overview infoText is not an explainer');
  }
  for (const k of calls(c, 'settingsBlock')) {
    const a = splitTop(k.args);
    if (/^num\b/.test(a[0] || '')) continue; // the declaration itself
    const info = a[5];
    if (info === undefined || info === 'null') continue;
    const key = keyOf(info);
    if (!key) problems.push('settingsBlock ⓘ is not a key literal: ' + String(info).slice(0, 40));
    else keys.push(key);
  }
  for (const name of ['explainerMark', 'explainerHtml', 'explainerLabel']) {
    for (const k of calls(c, name)) {
      if (rel === 'shared/explainer.js') continue;
      const a = splitTop(k.args);
      const arg = name === 'explainerMark' ? a[1] : a[0];
      const key = keyOf(arg);
      if (key) { keys.push(key); continue; }
      const cond = /^[\w.$]+\s*\?\s*('[^']+')\s*:\s*('[^']+')$/.exec(String(arg || '').trim());
      if (cond) { keys.push(keyOf(cond[1]), keyOf(cond[2])); continue; }
      // A parameter carrying a key: settingsBlock / renderBlock / memStep / the section map.
      if (['infoKey', 'o.infoKey', 'key'].includes(String(arg).trim())) continue;
      problems.push(name + ' with a non-literal key: ' + String(arg).slice(0, 40));
    }
  }
  for (const m of c.matchAll(/infoKey:\s*('[a-z.-]+')/g)) keys.push(keyOf(m[1]));
  return { problems, keys: keys.filter(Boolean) };
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  ONE ⓘ IMPLEMENTATION IN THE WHOLE /next TREE');
ok(FILES.length > 40, 'walked ' + FILES.length + ' modules under src/public/next');
for (const f of FILES) {
  const p = scanMarkup(f.rel, f.src);
  if (p.length) ok(false, f.rel + ': ' + p.join('; '));
}
ok(FILES.every((f) => scanMarkup(f.rel, f.src).length === 0),
  'no module but shared/text.js emits the mark or its panel, declares an infoMark or copies the glyph onto a mark');
const textSrc = code(byRel['shared/text.js'].src);
ok((textSrc.match(/data-tx-info="/g) || []).length === 2,
  'shared/text.js emits the mark in exactly two places (renderViewHeader, renderInfoMark)');
ok(/export function renderInfoMark\(/.test(textSrc) && (textSrc.match(/function renderInfoMark\(/g) || []).length === 1,
  'renderInfoMark is declared once');
ok(/renderInfoMark\(id, e\.label, explainerHtml\(key, opts\), \{ html: true \}\)/.test(code(byRel['shared/explainer.js'].src)),
  'explainerMark IS renderInfoMark over the explainer body');
ok(/explainerMark\(/.test(code(byRel['shared/block.js'].src)) && !/renderInfoMark\(/.test(code(byRel['shared/block.js'].src)),
  'shared/block.js marks its block through explainerMark, never with prose');
const ingestCalls = calls(code(byRel['views/ingest.js'].src), 'renderInfoMark');
ok(ingestCalls.length === 1 && splitTop(ingestCalls[0].args)[0] === "'ing-estimate-basis'",
  'the ONE named prose panel left is ingest’s estimate basis (server-authored money account; lede visible)');
ok(/VERBATIM_INFO_GLYPH\s*\+\s*\n?\s*'<span>/.test(byRel['views/ingest.js'].src) &&
   !/<button[^>]*>'\s*\+\s*VERBATIM_INFO_GLYPH/.test(byRel['views/ingest.js'].src),
  'ingest’s VERBATIM_INFO_GLYPH is a decorative note icon, never on a button');

// ═════════════════════════════════════════════════════════════════════════
section('§2  EVERY ⓘ PANEL IN THE APP IS AN EXPLAINER');
const APP_KEYS = new Set();
for (const f of FILES) {
  const { problems, keys } = scanPanels(f.rel, f.src);
  for (const k of keys) APP_KEYS.add(k);
  if (problems.length) ok(false, f.rel + ': ' + problems.join('; '));
}
ok(FILES.every((f) => scanPanels(f.rel, f.src).problems.length === 0),
  'every header info, overview infoText, block ⓘ and standalone mark names an explainer; no sidebar-title ⓘ');
// The Settings section map: every value an entry.
const settingsCode = code(byRel['views/settings.js'].src);
const secMap = /const SECTION_INFO = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(settingsCode);
ok(!!secMap, 'Settings SECTION_INFO is a frozen map of keys');
const secKeys = secMap ? [...secMap[1].matchAll(/^\s*([a-z]+):\s*'([a-z.-]+)'/gm)] : [];
ok(secKeys.length === 5 && secKeys.every((m) => !!EXPLAINERS[m[2]]),
  'its five sections each name an entry: ' + secKeys.map((m) => m[1] + '→' + m[2]).join(', '));
for (const m of secKeys) APP_KEYS.add(m[2]);
ok(/info: infoKey \? explainerHtml\(infoKey\) : null,\s*\n\s*infoHtml: true/.test(settingsCode),
  'the Settings header renders the section’s key through explainerHtml');
// The Shared Brain section on the domain page has NO header of its own, so
// the domain page's ④ ⓘ is the only one there (the possible double ⓘ).
const sharedCode = code(byRel['views/shared.js'].src);
const sm = /function renderMain\(token\) \{([\s\S]*?)\n\}/.exec(sharedCode);
ok(!!sm && /if \(inSection\(\)\) \{\s*hostSetMain\(renderSection\(\), token\);\s*return;\s*\}/.test(sm[1]) &&
   sm[1].indexOf('return;') < sm[1].indexOf('renderViewHeader'),
  'hosted on the domain page, Shared Brain renders no header ⓘ of its own (no double ⓘ under ④)');
ok(!/renderViewHeader/.test(/function renderSection\(\)[\s\S]*?\n\}/.exec(sharedCode)[0]),
  '…and renderSection itself carries no view header');

// ═════════════════════════════════════════════════════════════════════════
section('§3  THE KITS, EXECUTED, FOR EVERY KEY THE APP USES');
const panelBody = (panel) => {
  const m = /^<div class="tx-vh-panel" id="[^"]+" role="group" aria-label="[^"]*" hidden>([\s\S]*)<\/div>$/.exec(panel);
  return m ? m[1] : null;
};
let markOk = 0; let blockOk = 0;
for (const k of APP_KEYS) {
  if (!EXPLAINERS[k]) continue;
  const mk = explainerMark('adopt-' + k.replace(/\./g, '-'), k);
  if (panelBody(mk.panel) === explainerHtml(k) && mk.btn.includes('aria-label="' + EXPLAINERS[k].label.replace(/&/g, '&amp;') + '"')) markOk++;
  else ok(false, 'explainerMark(' + k + ') panel is not explainerHtml(' + k + ')');
  const b = renderBlock({ id: 'adopt', title: 'T', ledeHtml: 'L', infoKey: k });
  const pm = /<div class="settings-block-info">(<div class="tx-vh-panel"[\s\S]*?)<\/div><div class="settings-block-body">/.exec(b);
  if (pm && panelBody(pm[1]) === explainerHtml(k)) blockOk++;
  else ok(false, 'renderBlock infoKey ' + k + ' panel is not explainerHtml');
}
ok(markOk === APP_KEYS.size, 'explainerMark renders explainerHtml(key) for all ' + APP_KEYS.size + ' keys the app names');
ok(blockOk === APP_KEYS.size, 'shared/block.js renders the same panel for every key');
ok(renderBlock({ id: 'none', title: 'T', ledeHtml: 'L' }).indexOf('data-tx-info') === -1,
  'a block with no key has no ⓘ at all');
ok(renderBlock({ id: 'p', title: 'T', ledeHtml: 'L', infoText: 'prose', infoHtml: true }).indexOf('prose') === -1,
  'shared/block.js no longer accepts prose for its ⓘ (infoText is ignored)');
// Cross-check the kit against the mechanism, independently of explainer.js.
const direct = renderInfoMark('x', EXPLAINERS['sync.page'].label, explainerHtml('sync.page'), { html: true });
const viaKit = explainerMark('x', 'sync.page');
ok(direct.btn === viaKit.btn && direct.panel === viaKit.panel, 'explainerMark is byte-identical to renderInfoMark(label, explainerHtml, html)');

// ═════════════════════════════════════════════════════════════════════════
section('§4  THE DUMB CROSS-CHECK — NO ORPHAN COPY, NO UNKNOWN KEY');
const unknown = [...APP_KEYS].filter((k) => !EXPLAINERS[k]);
ok(unknown.length === 0, 'every key the app names is an entry' + (unknown.length ? ' — unknown: ' + unknown.join(', ') : ''));
const orphans = Object.keys(EXPLAINERS).filter((k) => !APP_KEYS.has(k));
ok(orphans.length === 0, 'every entry is rendered somewhere in the app' + (orphans.length ? ' — orphans: ' + orphans.join(', ') : ''));
ok(APP_KEYS.size === Object.keys(EXPLAINERS).length,
  'the app names exactly as many keys (' + APP_KEYS.size + ') as explainers.js holds (' + Object.keys(EXPLAINERS).length + ')');
// A raw count, independent of the parser: each literal key string appears in app code.
const allCode = FILES.filter((f) => f.rel !== 'shared/explainers.js').map((f) => code(f.src)).join('\n');
ok(Object.keys(EXPLAINERS).every((k) => allCode.includes("'" + k + "'")),
  'grep agrees: each entry’s key appears as a literal in app code');

// ═════════════════════════════════════════════════════════════════════════
section('§5  WHAT LEFT THE ⓘ IS ON THE PAGE, UNFOLDED');
const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const j = src.indexOf('\n}\n', i);
  return src.slice(i, j + 2);
};
const allExplainerText = Object.keys(EXPLAINERS).map((k) => explainerHtml(k)).join('\n');
// Health: the refusal.
ok(/const SCAN_LIMIT_REFUSAL = '[^']*does not start when the estimate is over the ceiling/.test(settingsCode),
  'Health: the refusal sentence exists…');
ok(/'<p class="settings-block-footnote">' \+ escapeHtml\(SCAN_LIMIT_REFUSAL\) \+ '<\/p>'/.test(fnBody(settingsCode, 'renderHealthLimits')),
  '…and renderHealthLimits prints it in the block body');
ok(!/over the ceiling/.test(allExplainerText), '…and no explainer carries it');
// Default domain: the consequence.
ok(/const MCP_DOMAIN_CONSEQUENCE = [\s\S]{0,200}wrong domain lands in that wiki and is hard to spot/.test(settingsCode) &&
   /escapeHtml\(MCP_DOMAIN_CONSEQUENCE\)/.test(settingsCode),
  'MCP default domain: the mis-aimed-write consequence is printed under the listbox');
// Shared Brain token: expiry.
ok(/const TOKEN_EXPIRY_NOTE = 'When the token expires, Push and Pull stop working, and GitHub sends no warning\.'/.test(sharedCode) &&
   /escapeHtml\(TOKEN_EXPIRY_NOTE\)/.test(fnBody(sharedCode, 'renderSectionConnection')),
  'Shared Brain: the token-expiry consequence is printed beside Check now');
ok(/'not checked · expires without notice'/.test(sharedCode),
  '…and an unchecked token’s row says so while the row is closed');
// Wizard attribution: irreversibility.
const wizCode = code(byRel['views/shared-brain-wizard.js'].src);
ok(/const ATTRIBUTION_FIXED_NOTE = 'Fixed when you join: changing it means leaving and joining again\. ' \+\s*'It applies only to future pushes and cannot remove a name already published\.'/.test(wizCode) &&
   /escapeHtml\(ATTRIBUTION_FIXED_NOTE\)/.test(fnBody(wizCode, 'panelStep4')),
  'wizard step 4: what is irreversible about attribution is in the visible hint');
// Chat: the state line.
const chatCode = code(byRel['views/chat.js'].src);
ok(/its knowledge lives in another domain \\u2014 this chat reads only ' \+ state\.activeDomain/.test(fnBody(chatCode, 'projectKnowledgeReadout')),
  'Chat: "its knowledge lives in another domain" is in the picker’s footer reading');
ok(/parts\.push\(k\.defaulted\s*\?\s*'this chat is reading ' \+ state\.activeDomain/.test(fnBody(chatCode, 'projectKnowledgeReadout')),
  '…gated on a CHOSEN list, as the old panel note was (a defaulted project\u2019s knowledge is its own domain)');
ok(!/another domain|not on this computer/.test(fnBody(chatCode, 'projectInfoPanelHtml')),
  '…and the project ⓘ appends no state line any more');
// Domains: the false note is gone; "the brief".
const domCode = code(byRel['views/domains.js'].src);
ok(!/never both|never a mix|Set once/i.test(domCode), 'Domains: the false "Set once — never both" note is gone from the page');
ok(!/'Standing brief'|>Standing brief /.test(domCode), 'Domains: no "Standing brief" on screen (pill, form label)');
ok(/label: 'Brief written'/.test(domCode) && /for="dm-proj-brief">The brief /.test(domCode),
  '…the pill and the create form say "brief" / "The brief"');

// ═════════════════════════════════════════════════════════════════════════
section('§6  SELF-TEST — EACH SCANNER CATCHES ITS BREAK');
const bad = [
  ['a local infoMark', 'views/x.js', "function infoMark(id, l, i) { return 1; }", scanMarkup],
  ['a hand-written mark', 'views/x.js', "const b = '<button data-tx-info=\"p\">';", scanMarkup],
  ['a tx-vh-panel copy', 'views/x.js', "const p = '<div class=\"tx-vh-panel\" id=\"p\">';", scanMarkup],
  ['a glyph copy', 'views/x.js', "const G = '<path d=\"M12 11v5M12 8h.01\"/>';", scanMarkup],
  ['a direct renderInfoMark', 'views/x.js', "const m = renderInfoMark('p', 'About', 'prose');", scanMarkup],
  ['a second ingest prose panel', 'views/ingest.js', "renderInfoMark('ing-other', 'x', 'prose');", scanMarkup],
];
for (const [what, rel, src, fn] of bad) ok(fn(rel, src).length > 0, 'flags ' + what);
const badPanels = [
  ['prose in a header', "renderViewHeader({ title: 'X', info: 'Some prose.', infoHtml: true });"],
  ['an ⓘ on a sidebar title', "renderViewHeader({ variant: 'sidebar', title: 'X', info: explainerHtml('sync.page'), infoHtml: true });"],
  ['header info without infoHtml', "renderViewHeader({ title: 'X', info: explainerHtml('sync.page') });"],
  ['prose overview infoText', "renderOverview({ id: 'o', infoText: '<p>hi</p>', infoHtml: true });"],
  ['prose settingsBlock ⓘ', "settingsBlock(1, 'a', 'A', lede, body, 'Some prose here.');"],
  ['a computed mark key', "explainerMark('x', someVar);"],
  ['an unbound identifier', "renderViewHeader({ title: 'X', info: HINT, infoHtml: true });"],
];
for (const [what, src] of badPanels) ok(scanPanels('views/x.js', src).problems.length > 0, 'flags ' + what);
ok(scanPanels('views/x.js', "const A = explainerHtml('sync.page');\nrenderViewHeader({ title: 'X', info: A, infoHtml: true });").problems.length === 0,
  'accepts a module const bound to an explainer (negative control)');
ok(scanMarkup('views/x.js', "import { explainerMark } from '../shared/explainer.js';\nconst m = explainerMark('p', 'sync.page');").length === 0,
  'accepts an explainerMark call (negative control)');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
