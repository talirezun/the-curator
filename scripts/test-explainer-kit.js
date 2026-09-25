#!/usr/bin/env node
/**
 * scripts/test-explainer-kit.js — OFFLINE
 *
 * The explainer KIT (v3.71.0): src/public/next/shared/explainer.js, the
 * renderer every ⓘ body goes through, and shared/explainer.css. The COPY is
 * scripts/test-explainers.js's; this suite is about what the renderer does
 * with ANY copy, and about the few things the kit promises by construction:
 *
 *   §1  the glyph table — every REUSE glyph is byte-equal to the source it
 *       names (app.js ICON_BODY, views/memory.js, shared/age.js,
 *       shared/text.js), lifted from those files, not retyped here; every
 *       glyph is stroke-only primitives in the icon() grammar
 *   §2  escape-first micro-markup — only <b> and <code> can come out
 *   §3  every entry renders to the anatomy: head · lead · (visual) · (points)
 *       · foot; exactly ONE control, the guide link, and it is safe
 *   §4  the five visuals, each with its accessible structure
 *   §5  the frame's "you are here" — default, override, and refusal
 *   §6  explainerMark = renderInfoMark with the entry's label, unchanged
 *   §7  loud failure — unknown key / icon / visual THROW
 *   §8  the stylesheet — linked after text.css, tokens only, the narrow
 *       layout is a container query
 *   §9  the keyboard contract, DRIVEN: text.js's real listener, a panel
 *       holding a real explainer, Escape pressed ON the guide link closes the
 *       panel and returns focus to the ⓘ
 *
 * Offline. Imports three import-free /next modules; §9 installs a minimal
 * document before importing text.js so its one delegated listener attaches
 * to something this suite can dispatch into.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, 'src/public/next');
const read = (rel) => readFileSync(join(NEXT, rel), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n' + t); }

// ── §9 needs text.js's listener bound to a document WE control, and text.js
// wires itself once, at import. So a minimal document goes in first; every
// other section is pure string work and does not notice it.
const listeners = {};
const byId = new Map();
class El {
  constructor(tag, attrs, parent) {
    this.tag = tag; this.attrs = { ...attrs }; this.parent = parent || null; this.children = [];
    if (parent) parent.children.push(this);
    if (this.attrs.id) byId.set(this.attrs.id, this);
    this.hidden = 'hidden' in this.attrs;
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  hasAttribute(n) { return n in this.attrs; }
  closest(sel) {
    const want = sel.match(/^\[([\w-]+)\]$/);
    for (let e = this; e; e = e.parent) if (want && e.hasAttribute(want[1])) return e;
    return null;
  }
  contains(o) { for (let e = o; e; e = e.parent) if (e === this) return true; return false; }
  focus() { globalThis.document.activeElement = this; }
}
const all = [];
globalThis.document = {
  activeElement: null,
  addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  getElementById(id) { return byId.get(id) || null; },
  querySelectorAll(sel) {
    if (sel !== '[data-tx-info][aria-expanded="true"]') throw new Error('unexpected selector ' + sel);
    return all.filter((e) => e.getAttribute('data-tx-info') && e.getAttribute('aria-expanded') === 'true');
  },
};

const { EXPLAINERS } = await import('../src/public/next/shared/explainers.js');
const { renderInfoMark } = await import('../src/public/next/shared/text.js');
const { docsUrl } = await import('../src/public/next/shared/docs-links.js');
const kit = await import('../src/public/next/shared/explainer.js');
const { GLYPHS, VISUAL_TYPES, FRAME_NODES, glyph, inline, explainerHtml, explainerMark, explainerLabel } = kit;

const keys = Object.keys(EXPLAINERS);

// A small tag walker: every tag in order, with its attributes, and a
// balance check. Enough for HTML this module builds (no comments, no
// raw-text elements, attributes always double-quoted).
function tags(html) {
  const out = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-:]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    for (const a of m[3].matchAll(/([a-zA-Z-:]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : a[2];
    out.push({ close: !!m[1], name: m[2].toLowerCase(), attrs, self: !!m[4], at: m.index });
  }
  return out;
}
const VOID_SVG = new Set(['path', 'circle', 'rect']);
function balanced(html) {
  const st = [];
  for (const t of tags(html)) {
    if (t.self || VOID_SVG.has(t.name) && t.self) continue;
    if (!t.close) st.push(t.name);
    else if (st.pop() !== t.name) return false;
  }
  return st.length === 0;
}
const visibleText = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();

// ═════════════════════════════════════════════════════════════════════════
section('§1  THE GLYPH TABLE');

{
  const appJs = read('app.js');
  const iconBody = {};
  const block = appJs.slice(appJs.indexOf('const ICON_BODY = {'), appJs.indexOf('\n};', appJs.indexOf('const ICON_BODY = {')));
  for (const m of block.matchAll(/^\s{2}(\w+): '([^']*)',/gm)) iconBody[m[1]] = m[2];
  ok(Object.keys(iconBody).length > 30, `CONTROL: ${Object.keys(iconBody).length} ICON_BODY entries lifted out of app.js`);

  const memoryJs = read('views/memory.js');
  const pencil = (memoryJs.match(/'(<path d="M4 20h4L19\.5 8\.5[^']*"\/>)<path d="M14\.5 6\.5l3 3"\/><\/svg>'/) || [])[1];
  const ageJs = read('shared/age.js');
  const clock = (ageJs.match(/aria-hidden="true">(<circle[^']*?)<\/svg>'/) || [])[1];
  const textJs = read('shared/text.js');
  const info = (textJs.match(/const INFO_GLYPH =[\s\S]*?aria-hidden="true">' \+\s*'([^']*)<\/svg>'/) || [])[1];
  const sources = {
    'views/memory.js:pencil': pencil && pencil + '<path d="M14.5 6.5l3 3"/>',
    'shared/age.js:clock': clock,
    'shared/text.js:INFO_GLYPH': info,
  };
  ok(!!sources['views/memory.js:pencil'] && !!clock && !!info, 'CONTROL: the three local glyphs were found in their files');

  const MODEL_SET = ['book', 'external', 'sparkles', 'layers', 'file', 'pencil', 'agent', 'refresh', 'grow',
    'search', 'start', 'folder', 'repo', 'clock', 'window', 'gauge', 'harness', 'computer', 'lock', 'check'];
  ok(MODEL_SET.every((n) => n in GLYPHS), 'every icon MODEL.md §4 names is in the table (20)');

  let reuse = 0;
  for (const [name, g] of Object.entries(GLYPHS)) {
    if (g.src === 'new') continue;
    reuse++;
    const src = g.src.startsWith('app.js:ICON_BODY.') ? iconBody[g.src.slice('app.js:ICON_BODY.'.length)] : sources[g.src];
    ok(typeof src === 'string' && src === g.body, `REUSE ${name} is byte-equal to ${g.src}`);
  }
  ok(reuse >= 12, `CONTROL: ${reuse} reuse glyphs were compared`);
  const dirty = Object.entries(GLYPHS).filter(([, g]) => {
    const t = tags(g.body);
    return !(t.length > 0 && t.every((x) => VOID_SVG.has(x.name) && x.self &&
      Object.keys(x.attrs).every((a) => /^(d|cx|cy|r|x|y|width|height|rx|stroke-dasharray)$/.test(a))));
  }).map(([n]) => n);
  ok(dirty.length === 0, `all ${Object.keys(GLYPHS).length} glyphs are stroke-only path/circle/rect with geometry attributes only (no fill, style, script, href)` +
    (dirty.length ? ' — not: ' + dirty.join(', ') : ''));
  const svg = glyph('book', 18);
  ok(/viewBox="0 0 24 24"/.test(svg) && /stroke="currentColor"/.test(svg) && /stroke-width="1\.7"/.test(svg) &&
     /stroke-linecap="round"/.test(svg) && /aria-hidden="true"/.test(svg) && /width="18"/.test(svg),
    'glyph() emits the icon() grammar: 24-unit viewBox, currentColor stroke 1.7, round caps, aria-hidden');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  ESCAPE-FIRST MICRO-MARKUP');

ok(inline('Press **New domain**.') === 'Press <b>New domain</b>.', '**x** → <b>x</b>');
ok(inline('See `/context` here.') === 'See <code>/context</code> here.', '`x` → <code>x</code>');
ok(inline('<img src=x onerror=alert(1)>') === '&lt;img src=x onerror=alert(1)&gt;', 'a tag in copy comes out as text');
ok(inline('**<script>alert(1)</script>**') === '<b>&lt;script&gt;alert(1)&lt;/script&gt;</b>', '…inside bold too — the escape runs FIRST');
ok(inline('`"><svg onload=x>`') === '<code>&quot;&gt;&lt;svg onload=x&gt;</code>', '…and inside code; quotes are entities, so no attribute can open');
ok(inline('Use **Documents here.') === 'Use **Documents here.', 'an unbalanced ** stays literal rather than opening a tag');
ok(inline('Tom’s & Jerry’s') === 'Tom’s &amp; Jerry’s', 'ampersands are escaped; typographic quotes pass through');
{
  const corpus = ['a **b** c', '`x` and **y**', '<b>raw</b>', '**a** **b** `c`', "it's \"quoted\"", '** **', '``'];
  const tagsOut = corpus.flatMap((s) => tags(inline(s)).map((t) => t.name));
  ok(tagsOut.every((n) => n === 'b' || n === 'code'), 'over a corpus, the only tags inline() can produce are <b> and <code>');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  EVERY ENTRY RENDERS TO THE ANATOMY, WITH ONE CONTROL');

const ALLOWED = new Set(['div', 'p', 'span', 'b', 'code', 'svg', 'path', 'circle', 'rect', 'ul', 'ol', 'li', 'a',
  'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td']);
for (const k of keys) {
  const e = EXPLAINERS[k];
  const html = explainerHtml(k);
  const t = tags(html).filter((x) => !x.close);
  const probs = [];
  const bad = t.filter((x) => !ALLOWED.has(x.name));
  if (bad.length) probs.push('disallowed <' + bad.map((x) => x.name).join('>, <') + '>');
  if (!balanced(html)) probs.push('unbalanced tags');
  const anchors = t.filter((x) => x.name === 'a');
  if (anchors.length !== 1) probs.push(anchors.length + ' links');
  if (t.some((x) => 'tabindex' in x.attrs || 'contenteditable' in x.attrs)) probs.push('a focusable non-link');
  if (t.some((x) => Object.keys(x.attrs).some((a) => /^on/i.test(a)))) probs.push('an on* handler');
  if (t.some((x) => 'style' in x.attrs)) probs.push('a style attribute');
  const a = anchors[0] || { attrs: {} };
  if (a.attrs.href !== docsUrl(e.guide.key).replace(/&/g, '&amp;')) probs.push('href is not docsUrl(guide.key)');
  if (a.attrs.target !== '_blank' || a.attrs.rel !== 'noopener noreferrer') probs.push('link is not _blank + noopener noreferrer');
  if (a.attrs['aria-label'] !== 'User guide: ' + e.guide.heading.replace(/&/g, '&amp;') + ' (opens in your browser)') probs.push('link name is not "User guide: <heading> (opens in your browser)"');
  const order = ['class="xp-head"', 'class="xp-lead"', e.visual ? 'class="xp-well' : null, e.points ? 'class="xp-pts"' : null, 'class="xp-foot']
    .filter(Boolean).map((s) => html.indexOf(s));
  if (order.some((i) => i < 0) || order.some((i, n) => n && i < order[n - 1])) probs.push('parts out of order ' + order.join(','));
  if (e.points && (html.match(/<li><span class="xp-ic">/g) || []).length !== e.points.length) probs.push('points did not each get an icon');
  if (!/<ul class="xp-pts" role="list">/.test(html) && e.points) probs.push('points list has no role=list');
  if (t.filter((x) => x.name === 'svg').some((x) => x.attrs['aria-hidden'] !== 'true')) probs.push('an svg not aria-hidden');
  if (e.try && !/<b class="xp-try-k">Try<\/b>/.test(html)) probs.push('no Try marker');
  if (!html.startsWith('<div class="xp" data-explainer="' + k + '">')) probs.push('root is not .xp[data-explainer]');
  ok(probs.length === 0, `${k}: head · lead${e.visual ? ' · ' + e.visual.type : ''}${e.points ? ' · ' + e.points.length + ' points' : ''}${e.try ? ' · try' : ''} · guide card` +
    (probs.length ? ' — ' + probs.join('; ') : ''));
}
{
  // The lead's words reach the page exactly, and nothing unescaped does.
  const html = explainerHtml('context.memory');
  ok(visibleText(html).includes('Memory is where the last session stopped, plus your standing instructions.'),
    'the lead\'s words reach the rendered text');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  THE FIVE VISUALS');

ok(VISUAL_TYPES.join(' ') === 'frame flow meter table steps', 'exactly five visual types');
{
  const h = explainerHtml('context.memory');
  ok(/<table class="xp-tbl"><caption class="xp-sr">What Memory holds<\/caption>/.test(h), 'table: a real <table> with a visually-hidden caption');
  ok((h.match(/<th scope="col">/g) || []).length === 3 && (h.match(/<th scope="row">/g) || []).length === 4,
    '…column headers scope=col, row names scope=row');
  ok(/data-col="Who writes it"/.test(h), '…each cell carries its column name for the stacked narrow layout');
  ok(/<span class="xp-who"><svg[^>]*>.*?<\/svg>you<\/span>/.test(h), '…and a cell may carry an icon beside its words');
}
{
  const h = explainerHtml('context.read-with');
  ok(/<ol class="xp-steps">(<li>[^<]+<\/li>){4}<\/ol>/.test(h), 'steps: an <ol> of four items, numbered by CSS');
}
{
  const h = explainerHtml('settings.general');
  ok(/<ol class="xp-flow">(<li>[^<]+<\/li>){3}<\/ol>/.test(h) && !/→/.test(visibleText(h.slice(h.indexOf('xp-flow')))),
    'flow: an <ol> of chips; the arrows are CSS, not text');
}
{
  const h = explainerHtml('context.session-start');
  ok(/<div class="xp-m-bar" role="img" aria-label="Schematic, not to scale:[^"]+">/.test(h), 'meter: role=img, its label spells the segments in order');
  ok(/not to scale/.test(visibleText(h)), '…and it SAYS it is a schematic — it is not this project\'s reading');
  ok(['harness', 'brief', 'handoff', 'read', 'room', 'free'].every((s) => h.includes('xp-m-' + s)), '…drawn from the layer segments (harness · brief · handoff · read first · room · free)');
  ok(/<div class="xp-m-labels" aria-hidden="true">/.test(h), '…the printed labels are hidden from the screen reader, which has the label');
}
{
  const h = explainerHtml('onboarding.frame');
  const items = h.match(/<li class="xp-node[^"]*"/g) || [];
  ok(/<ol class="xp-nodes" aria-label="How The Curator fits together">/.test(h) && items.length === 3, 'frame: an <ol> of exactly three nodes');
  const order = ['Second brain', 'Shared Brain', 'Agent memory'].map((n) => h.indexOf('>' + n + '<'));
  ok(order.every((i, n) => i > 0 && (!n || i > order[n - 1])), '…in the one order: Second brain → Shared Brain → Agent memory');
}

// ═════════════════════════════════════════════════════════════════════════
section('§5  "YOU ARE HERE"');

{
  const count = (h) => (h.match(/you are here/g) || []).length;
  const hereOf = (h) => ((h.match(/<li class="xp-node is-here" aria-current="true">[\s\S]*?class="xp-node-name">([^<]+)</) || [])[1]);
  ok(count(explainerHtml('onboarding.frame')) === 0, 'no marker where the entry names none (onboarding)');
  ok(hereOf(explainerHtml('context.page')) === 'Agent memory' && count(explainerHtml('context.page')) === 1, 'the entry\'s own `here` is the default: Context marks Agent memory, once');
  ok(hereOf(explainerHtml('domains.page')) === 'Second brain', 'Domains marks Second brain');
  ok(hereOf(explainerHtml('shared.page')) === 'Shared Brain', 'Shared Brain marks Shared Brain');
  ok(hereOf(explainerHtml('domains.page', { here: 'shared-brain' })) === 'Shared Brain', 'opts.here overrides the entry (a mirror domain page)');
  ok(hereOf(explainerHtml('onboarding.frame', { here: 'agent-memory' })) === 'Agent memory', '…and can add a marker where the entry has none');
  ok(hereOf(explainerHtml('domains.page', { here: 'nowhere' })) === 'Second brain', 'an unknown `here` is ignored, never rendered');
  ok(/<span class="xp-here">you are here<\/span>/.test(explainerHtml('context.page')), '"you are here" is real text, not colour alone');
  ok(FRAME_NODES.join(',') === 'second-brain,shared-brain,agent-memory', 'FRAME_NODES exposes the three ids');
  ok(explainerHtml('context.memory', { here: 'agent-memory' }) === explainerHtml('context.memory'), 'opts.here is inert on an entry without a frame');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  explainerMark IS renderInfoMark, WITH THE ENTRY\'S LABEL');

{
  const m = explainerMark('mem-step-memory', 'context.memory');
  const ref = renderInfoMark('mem-step-memory', 'About Memory', explainerHtml('context.memory'), { html: true });
  ok(m.btn === ref.btn && m.panel === ref.panel, 'byte-identical to renderInfoMark(id, label, explainerHtml(key), {html:true})');
  ok(/data-tx-info="mem-step-memory"/.test(m.btn) && /aria-label="About Memory"/.test(m.btn) && /id="mem-step-memory-btn"/.test(m.btn),
    '…so the ⓘ keeps its id, its data-tx-info and its accessible name — the listener needs nothing new');
  ok(/^<div class="tx-vh-panel" id="mem-step-memory" role="group" aria-label="About Memory" hidden><div class="xp"/.test(m.panel),
    '…and the panel is the same hidden, in-flow group, now holding the explainer');
  ok(explainerLabel('context.session-start') === 'About Session start', 'explainerLabel gives the ⓘ its name');
  const here = explainerMark('x', 'domains.page', { here: 'shared-brain' });
  ok(/is-here[\s\S]*?Shared Brain/.test(here.panel), 'opts pass through to the body');
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  LOUD FAILURE');

{
  const throws = (f) => { try { f(); return false; } catch (e) { return e instanceof Error; } };
  ok(throws(() => explainerHtml('context.nope')), 'an unknown key THROWS — a typo is a blank screen in development, not an empty ⓘ');
  ok(throws(() => explainerHtml('constructor')), '…including an inherited name (own-property lookup)');
  ok(throws(() => explainerMark('x', 'nope')) && throws(() => explainerLabel('nope')), '…from every entry point');
  ok(throws(() => glyph('rocket')), 'an unknown icon THROWS rather than drawing a plausible wrong glyph');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  THE STYLESHEET');

{
  const idx = read('index.html');
  const iText = idx.indexOf('<link rel="stylesheet" href="/next/shared/text.css">');
  const iXp = idx.indexOf('<link rel="stylesheet" href="/next/shared/explainer.css">');
  ok(iXp > 0 && iText > 0 && iXp > iText, 'explainer.css is linked from index.html, after text.css (it styles inside .tx-vh-panel)');
  ok(idx.split('/next/shared/explainer.css').length === 2, '…exactly once');
  const css = read('shared/explainer.css').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(css), 'no literal colour — tokens only, so both themes come from tokens/color.css');
  {
    const textCss = read('shared/text.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const panelPad = ((textCss.match(/\n\.tx-vh-panel \{[^}]*?\bpadding:\s*([^;]+);/) || [])[1] || '').trim();
    const xpMargin = ((css.match(/\n\.xp \{[^}]*?\bmargin:\s*([^;]+);/) || [])[1] || '').trim();
    const neg = panelPad.split(/\s+/).map((v) => '-' + v).join(' ');
    ok(!!panelPad && xpMargin === neg,
      `the explainer reclaims exactly the panel's padding (text.css pads ${panelPad || '?'}; .xp margin ${xpMargin || '?'}) — one fact in two files, pinned`);
    ok(!/(^|[\s,>+~])\.tx-/m.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), '…and no `tx-` selector lives here — text.css owns that prefix');
  }
  {
    // v3.72.1: the lead took a 62ch measure and broke at ~two-thirds of the
    // panel even when the sentence fit on one line. The base rule may carry
    // no `ch`/`px`/`%` cap; a measure is allowed only inside a MIN-width
    // container query (the panel itself very wide), and that measure must be
    // wide enough to hold a 20-word lead (≥ 100ch) on one line.
    const lead = (css.match(/\n\.xp-lead\s*\{([^}]*)\}/) || [])[1];
    ok(lead !== undefined && !/max-width:(?!\s*none\s*;)[^;]+;/.test(lead),
      'the lead takes the panel\'s full width at an ordinary width (no max-width measure on .xp-lead)');
    const wide = [...css.matchAll(/@container \(min-width:\s*(\d+)px\)\s*\{\s*\.xp-lead\s*\{\s*max-width:\s*(\d+)ch;\s*\}\s*\}/g)];
    ok(wide.length === 1 && Number(wide[0][1]) >= 1000 && Number(wide[0][2]) >= 100,
      `…and a readable measure returns only where the explainer is very wide (min-width ${wide[0] ? wide[0][1] : '?'}px, ${wide[0] ? wide[0][2] : '?'}ch)`);
    const leads = (css.match(/\.xp-lead[^{]*\{[^}]*\}/g) || []);
    ok(leads.length === 2, `…and nothing else re-caps it (${leads.length} .xp-lead rules; expected the base + the wide one)`);
  }
  ok(/\.xp\s*\{[^}]*container-type:\s*inline-size/.test(css), 'the explainer is a size container…');
  const narrow = (css.match(/@container \(max-width: 560px\) \{([\s\S]*)\}\s*$/) || [])[1] || '';
  ok(['.xp-nodes', '.xp-pts', '.xp-foot', '.xp-flow', '.xp-tbl'].every((s) => narrow.includes(s)),
    '…and under 560px of ITS OWN width the frame, points, foot, flow and table all re-lay (568px app check)');
  ok(/\.xp-flow li \+ li::before \{ content: "↓"/.test(narrow), '…the flow\'s arrows turn downward');
  ok(!/overflow-x:\s*(auto|scroll)/.test(css) && /overflow-wrap:\s*anywhere/.test(css), 'no horizontal scroll: nothing scrolls sideways, long words wrap');
  ok(!/@keyframes|animation:/.test(css), 'no motion inside the explainer (the panel\'s entrance stays text.css\'s)');
  {
    const eb = (css.match(/\.xp-guide-eb\s*\{([^}]*)\}/) || [])[1] || '';
    ok(/white-space:\s*nowrap/.test(eb) && /text-overflow:\s*ellipsis/.test(eb) && /overflow:\s*hidden/.test(eb),
      'the guide card\'s "User guide" label never wraps — it is a one-line eyebrow that truncates, not `.xp`\'s inherited overflow-wrap: anywhere breaking it letter by letter at a narrow width');
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  THE KEYBOARD CONTRACT, DRIVEN THROUGH text.js\'s REAL LISTENER');

{
  ok((listeners.click || []).length >= 1 && (listeners.keydown || []).length >= 1, 'CONTROL: text.js wired its click and keydown listeners onto this document');
  // Build the DOM the two fragments describe: the ⓘ, and its panel with the
  // explainer's one link inside.
  const m = explainerMark('kit-p', 'context.session-start');
  const root = new El('div', {});
  const btnAttrs = Object.fromEntries([...m.btn.matchAll(/ ([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
  const btn = new El('button', btnAttrs, root);
  const panel = new El('div', { id: 'kit-p', role: 'group', hidden: '' }, root);
  const body = new El('div', { class: 'xp' }, panel);
  const link = new El('a', { class: 'xp-guide', href: docsUrl('context.session-start') }, body);
  all.push(btn, panel, body, link);
  ok(btn.getAttribute('data-tx-info') === 'kit-p' && panel.hidden, 'CONTROL: the ⓘ names its panel, which starts hidden');

  const fire = (type, target, extra) => (listeners[type] || []).forEach((f) => f({ target, ...extra }));
  fire('click', btn);
  ok(!panel.hidden && btn.getAttribute('aria-expanded') === 'true', 'pressing the ⓘ opens the panel');
  fire('click', link);
  ok(!panel.hidden, 'clicking the guide link does not close the panel (it is inside it)');
  link.focus();
  fire('keydown', link, { key: 'Tab' });
  ok(!panel.hidden, 'a key other than Escape on the link leaves it open');
  fire('keydown', link, { key: 'Escape' });
  ok(panel.hidden && btn.getAttribute('aria-expanded') === 'false', 'Escape pressed ON the guide link closes the panel…');
  ok(document.activeElement === btn, '…and returns focus to the ⓘ, not to <body>');
  fire('click', btn);
  fire('click', root);
  ok(panel.hidden, 'CONTROL: a click outside still light-dismisses — the listener is the real one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
