#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  test-next-bucket-kit.js — THE WINDOW METER, the segmented depth bar (v3.70.0)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * OFFLINE. No network, no DOM, no browser. EXECUTES the real renderers in
 * src/public/next/shared/bucket.js and parses their HTML strings; reads
 * tokens/color.css + tokens/layer.css to RECOMPUTE every contrast figure.
 *
 * What it stops:
 *   §1  proportions drifting from the numbers (window scale and enlargement)
 *   §2  a harness that is Not set being drawn, or ANY harness being summed
 *       into The Curator's measured figure
 *   §3  the reading-budget ROOM: empty and SAID so when nothing is read first
 *       (the reason every preset reads the same), "budget left" otherwise,
 *       nothing at Index only
 *   §4  the preview flag and the delivery line
 *   §5  the text alternative (role="img" + a full sentence per bar)
 *   §6  escaping, and a layer key interpolated into a class
 *   §7  labels: only where they fit, every layer in the legend, the narrow
 *       container query, the tiny-share floor
 *   §8  the stylesheets: tokens defined, both themes, no literals, no
 *       danger tone, no prefers-color-scheme, linked from index.html
 *   §9  contrast, recomputed: ink on every fill ≥ 4.5, neighbours ≥ 3,
 *       every text the meter prints ≥ 4.5, in both themes
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as B from '../src/public/next/shared/bucket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const NEXT = path.join(ROOT, 'src/public/next');
const read = (rel) => readFileSync(path.join(NEXT, rel), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0;
let failed = 0;
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  \x1b[32m✓\x1b[0m ' + msg); return true; }
  failed++;
  console.log('  \x1b[31m✗\x1b[0m ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 400)));
  return false;
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
function section(t) { console.log('\n\x1b[1m' + t + '\x1b[0m'); }

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
const widthOf = (t) => { const m = /width:([\d.]+)%/.exec(t.attrs.style || ''); return m ? Number(m[1]) : null; };
const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const LAYERS = (readFirst) => [
  { key: 'framing', label: 'framing', tokens: 925 },
  { key: 'brief', label: 'brief', tokens: 3500 },
  { key: 'handoff', label: 'handoff', tokens: 500 },
  { key: 'journal', label: 'journal', tokens: 1025 },
  { key: 'index', label: 'document list', tokens: 850 },
  { key: 'read', label: 'read first', tokens: readFirst },
];
const FIXED = 925 + 3500 + 500 + 1025 + 850;   // 6800
const TODAY = { windowTokens: 1e6, harnessTokens: 120000, layers: LAYERS(0), budgetTokens: 16384, onDemand: { tokens: 47900, documents: 9 } };
const TWO = { ...TODAY, layers: LAYERS(15800), delivery: { replies: 2 } };

// ═════════════════════════════════════════════════════════════════════════
section('§0  META-CONTROL');
{
  const before = failed;
  ok(false, '(planted failure — expected red, subtracted below)');
  const detected = failed === before + 1;
  failed = before;
  if (!detected) { console.log('ok() does not count a failure — every result below would be meaningless'); process.exit(1); }
  console.log('  ok() counts a planted failure; its count was restored');
}

// ═════════════════════════════════════════════════════════════════════════
section('§1  Proportions — the window to scale, and the enlargement');
{
  const g = B.bucketModel(TODAY);
  ok(near(g.harnessPct, 12), 'harness 120k of 1M is 12% of the window bar', g.harnessPct);
  ok(near(g.curatorPct, 0.68), 'The Curator 6.8k of 1M is 0.68% of the window bar', g.curatorPct);
  ok(g.free === 1e6 - 120000 - FIXED, 'free = window − harness − The Curator', g.free);
  const html = B.renderWindowBar(TODAY);
  const h = withClass(html, 'bk-harness')[0];
  const c = withClass(html, 'bk-curator')[0];
  ok(widthOf(h) === 12, 'the harness segment is drawn at width:12%', h && h.attrs.style);
  ok(near(widthOf(c), 0.68), 'the Curator segment is drawn at width:0.68%', c && c.attrs.style);
  ok(withClass(html, 'bk-free').length === 1, 'one free segment, which takes the rest (flex)');
  const ax = /<div class="bk-axis"[^>]*>(.*?)<\/div>/.exec(html);
  ok(ax && /<span>0<\/span><span>250k<\/span><span>500k<\/span><span>750k<\/span><span>1M tokens<\/span>/.test(ax[1]),
    'the token axis reads 0 · 250k · 500k · 750k · 1M tokens', ax && ax[1]);
  const ax2 = B.renderWindowBar({ ...TODAY, windowTokens: 200000 });
  ok(/<span>50k<\/span><span>100k<\/span><span>150k<\/span><span>200k tokens<\/span>/.test(ax2), 'and at 200K: 50k · 100k · 150k · 200k tokens');

  const z = B.renderEnlargement(TWO);
  const denom = FIXED + 16384;
  const brief = withClass(z, 'bk-ly-brief')[0];
  ok(near(widthOf(brief), (3500 / denom) * 100, 0.001), 'enlargement: brief is its share of (fixed layers + reading budget)', widthOf(brief));
  const rd = withClass(z, 'bk-ly-read')[0];
  ok(near(widthOf(rd), (15800 / denom) * 100, 0.001), 'enlargement: read first is its share of the same denominator', widthOf(rd));
  const room = withClass(z, 'bk-room')[0];
  ok(near(widthOf(room), ((16384 - 15800) / denom) * 100, 0.001), 'enlargement: the room is the budget not spent', widthOf(room));
  const sum = tags(z).filter((t) => t.classes.includes('bk-seg')).reduce((a, t) => a + widthOf(t), 0);
  ok(near(sum, 100, 0.01), 'the enlargement segments sum to 100%', sum);

  const zl = B.renderZoomLink(TODAY);
  ok(/M12 0 L0 22 M12\.68 0 L100 22/.test(zl), 'the zoom lines run from the Curator sliver (12 → 12.68) to the enlargement\'s two ends', zl);
  const over = B.bucketModel({ ...TODAY, harnessTokens: 999000 });
  ok(over.over === 999000 + FIXED - 1e6 && near(over.harnessPct + over.curatorPct, 100), 'an over-full window squeezes to 100% and states the over-run', over.over);
  ok(/Over the window by/.test(B.renderWindowBar({ ...TODAY, harnessTokens: 999000 })), 'and says it in words');
  ok(B.renderBucket({ ...TODAY, windowTokens: 0 }) === '' && B.bucketModel(null) === null, 'no window → nothing is drawn (never a divide by zero)');
}

// ═════════════════════════════════════════════════════════════════════════
section('§2  The harness — Not set, and never summed into a measured figure');
{
  const unset = { ...TODAY, harnessTokens: null };
  const html = B.renderWindowBar(unset);
  ok(withClass(html, 'bk-harness').length === 0, 'Not set: no harness segment in the bar');
  ok(withClass(html, 'bk-harness-unset').length === 1 && /Harness not set\./.test(html), 'Not set: the "Harness not set" note is shown');
  ok(/also use this window/.test(B.bucketText(unset).window), 'Not set: the text alternative says the harness also uses the window');
  ok(/harness — not set/.test(B.renderLegend(unset)), 'Not set: the legend says so');
  ok(/The Curator ≈6\.8k · 0\.7% of 1M/.test(html), 'Not set: the head line gives The Curator\'s share alone');
  ok(withClass(B.renderWindowBar(TODAY), 'bk-harness-unset').length === 0, 'Set: no "not set" note');
  const a = B.bucketModel(TODAY), b = B.bucketModel(unset);
  ok(a.curator === b.curator && a.curator === FIXED, 'the harness is NEVER summed into The Curator\'s measured figure', a.curator + ' vs ' + b.curator);
  ok(/your estimate/.test(B.bucketText(TODAY).window) && /your estimate/.test(B.renderLegend(TODAY)), 'Set: "your estimate" in the text alternative and the legend');
  ok(/≈127k in use · 12\.7% · of which The Curator ≈6\.8k \(0\.7%\)/.test(B.renderWindowBar(TODAY)), 'Set: the head line separates in-use from The Curator\'s part');
}

// ═════════════════════════════════════════════════════════════════════════
section('§3  The reading-budget room');
{
  const z0 = B.renderEnlargement(TODAY);
  const room = withClass(z0, 'bk-room')[0];
  ok(room && room.classes.includes('is-unused'), 'nothing read first: the room is drawn, marked is-unused');
  ok(near(widthOf(room), (16384 / (FIXED + 16384)) * 100, 0.001), 'nothing read first: the room is the whole budget', widthOf(room));
  ok(/reading budget 16\.4k — unused: nothing is read first/.test(z0), 'and it is LABELLED "unused: nothing is read first"');
  ok(withClass(z0, 'bk-ly-read').length === 0, 'no read-first segment is drawn at zero');
  ok(/read first <b>0<\/b>/.test(B.renderLegend(TODAY)), 'but the legend still lists read first at 0');
  // THE POINT: every preset sends the same when nothing is read first — only the room changes.
  const presets = [0, 8192, 16384, 32768, 65536, 131072, 204800].map((b) => B.bucketModel({ ...TODAY, budgetTokens: b }));
  ok(presets.every((p) => p.curator === FIXED), 'every preset: The Curator\'s figure is the same when nothing is read first');
  ok(presets.slice(1).every((p, i) => i === 0 || p.room > presets[i].room), 'while the empty room grows with the budget');
  const zi = B.renderEnlargement({ ...TODAY, budgetTokens: 0 });
  ok(withClass(zi, 'bk-room').length === 0 && /no reading budget \(index only\)/.test(B.bucketText({ ...TODAY, budgetTokens: 0 }).enlargement),
    'Index only: no room, and the text alternative says there is no reading budget');
  const zt = B.renderEnlargement(TWO);
  ok(/budget left 0\.6k/.test(zt) || /budget left 0\.6k/.test(B.renderLegend(TWO)), 'read first under the budget: "budget left 0.6k"');
  ok(!withClass(zt, 'bk-room')[0].classes.includes('is-unused'), 'and the room is not marked unused');
  const full = { ...TODAY, layers: LAYERS(16384) };
  ok(withClass(B.renderEnlargement(full), 'bk-room').length === 0 && /, full\./.test(B.bucketText(full).enlargement), 'budget exactly spent: no room, "full" in words');
}

// ═════════════════════════════════════════════════════════════════════════
section('§4  Preview flag and delivery line');
{
  ok(B.renderDeliveryLine(TODAY) === '', 'no delivery and not a preview → no line');
  eq('delivered', B.renderDeliveryLine(TWO), '<p class="bk-delivery">Delivered in 2 MCP replies of at most ≈20k tokens each</p>');
  ok(/Delivered in 1 MCP reply of/.test(B.renderDeliveryLine({ ...TWO, delivery: { replies: 1 } })), 'singular: "1 MCP reply"');
  const pv = { ...TWO, preview: true };
  const line = B.renderDeliveryLine(pv);
  ok(/^<p class="bk-delivery is-preview"><b>Preview, not saved<\/b> · ≈22\.6k tokens · 2\.3% of 1M · 2 MCP replies<\/p>$/.test(line), 'preview: "Preview, not saved · ≈22.6k tokens · 2.3% of 1M · 2 MCP replies"', line);
  const all = B.renderBucket(pv);
  ok(withClass(all, 'bk-preview').length === 2, 'preview: both bars carry a "preview" tag');
  ok(withClass(all, 'is-preview').length >= 3, 'preview: both bars and the line carry is-preview');
  ok(withClass(B.renderBucket(TWO), 'bk-preview').length === 0, 'not a preview: no tag');
  ok(/^Preview, not saved: /.test(B.bucketText(pv).window), 'preview: the text alternative opens with "Preview, not saved"');
  ok(B.bucketModel({ ...TODAY, preview: 'yes' }).preview === false, 'only preview === true is a preview');
}
function eq(msg, got, want) { return ok(got === want, msg, 'got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }

// ═════════════════════════════════════════════════════════════════════════
section('§5  The text alternative');
{
  const t = B.bucketText(TODAY);
  eq('window sentence', t.window, 'A 1M-token window, drawn to scale: harness about 120k (your estimate, not measured), The Curator about 6.8k tokens (measured, 0.7%), about 873k free.');
  ok(/framing 0\.9k, brief 3\.5k, handoff 0\.5k, journal 1\.0k, document list 0\.9k, read first 0; reading budget 16\.4k, unused: nothing is read first\./.test(t.enlargement), 'enlargement sentence names every layer and the room', t.enlargement);
  ok(/9 documents, about 47\.9k tokens/.test(t.onDemand) && /outside the window/.test(t.onDemand), 'on-demand sentence: outside the window, with its figure');
  const all = B.renderBucket(TODAY);
  const imgs = tags(all).filter((x) => x.attrs.role === 'img');
  ok(imgs.length === 2, 'exactly two role="img" bars', imgs.length);
  ok(imgs.length === 2 && unescape(imgs[0].attrs['aria-label']) === t.window && unescape(imgs[1].attrs['aria-label']) === t.enlargement,
    'each bar\'s aria-label IS its sentence');
  const hidden = B.renderBucketText(TWO);
  ok(/class="bk-text visually-hidden"/.test(hidden) && (hidden.match(/<li>/g) || []).length === 4, 'renderBucketText: a visually-hidden list of the four sentences');
  const deco = tags(all).filter((x) => x.classes.includes('bk-zoom') || x.classes.includes('bk-axis'));
  ok(deco.length === 2 && deco.every((x) => x.attrs['aria-hidden'] === 'true'), 'the axis and the zoom lines are aria-hidden');
}

// ═════════════════════════════════════════════════════════════════════════
section('§6  Escaping and the key allow-list');
{
  const evil = { ...TODAY, layers: [{ key: 'brief" onclick="x', label: '<img src=x onerror=alert(1)>', tokens: 90000 }] };
  const html = B.renderBucket(evil);
  ok(!/<img/.test(html) && /&lt;img src=x/.test(html), 'a label is escaped everywhere it is printed');
  ok(!/onclick/.test(html), 'an unknown key never reaches an attribute');
  ok(withClass(html, 'bk-ly-other').length >= 1, 'an unknown key draws as bk-ly-other');
  ok(B.bucketModel({ ...TODAY, harnessTokens: 'lots' }).harnessSet === false, 'a non-number harness is Not set');
  ok(B.bucketModel({ ...TODAY, layers: [{ key: 'brief', tokens: -5 }, { key: 'read', tokens: NaN }] }).curator === 0, 'negative / NaN tokens count as 0');
  eq('formatTokens', ['0', '0.5k', '6.8k', '20k', '873k', '1M', '1.5M'].join(' '),
    [0, 500, 6800, 20000, 873000, 1e6, 1.5e6].map(B.formatTokens).join(' '));
}

// ═════════════════════════════════════════════════════════════════════════
section('§7  Labels, legend, narrow width, the tiny share');
{
  const z = B.renderEnlargement(TODAY);
  ok(/<span>brief 3\.5k<\/span>/.test(z), 'a wide segment carries its name');
  ok(withClass(z, 'bk-ly-handoff').length === 1 && !/handoff 0\.5k<\/span>/.test(z), 'a segment too small for its name carries none …');
  const lg = B.renderLegend(TODAY);
  for (const l of LAYERS(0)) ok(lg.includes(l.label + ' <b>'), '… and the legend lists "' + l.label + '" with its figure');
  ok(/on demand — outside the window <b>47\.9k<\/b> · 9 documents/.test(lg) && withClass(lg, 'bk-sw-ondemand').length === 1, 'the on-demand dashed chip is in the legend');
  ok(withClass(lg, 'bk-sw-harness').length === 1 && withClass(lg, 'bk-sw-room').length === 1, 'the harness hatch and the room have legend swatches');
  const w = B.renderWindowBar(TODAY);
  ok(/<span class="bk-l-wide">harness ≈120k<\/span><span class="bk-l-short">harness<\/span>/.test(w),
    'the harness label has a long form for a wide bar and a short one for a narrow bar', w.match(/bk-harness[^]*?<\/div>/)[0]);
  // Every placed label must fit a 560px bar (its short form).
  const g = B.bucketModel(TWO);
  for (const l of g.layers) if (l.text.short) ok(l.pct / 100 * B.LABEL_MIN_BAR_PX >= l.text.short.length * 6.8 + 14, 'label "' + l.text.short + '" fits its segment at 560px');
  const css = strip(read('shared/bucket.css'));
  ok(/container-type:\s*inline-size/.test(css) && /@container bk \(max-width: 559px\)\s*\{[^}]*\.bk-seg span\s*\{\s*display:\s*none/.test(css),
    'below 560px of bar the inline names drop (container query) — the legend carries them');
  ok(/\.bk-legend\s*\{[^}]*flex-wrap:\s*wrap/.test(css), 'the legend wraps');
  ok(/\.bk-curator\s*\{[^}]*min-width:\s*3px/.test(css), 'the Curator sliver has a min-width, so 0.3% of 1M is still a visible mark');
  const tiny = B.renderWindowBar({ ...TODAY, layers: [{ key: 'brief', label: 'brief', tokens: 300 }] });
  ok(withClass(tiny, 'bk-curator').length === 1 && /0\.03%/.test(tiny), 'a 0.03% share is still drawn and stated to two decimals');
  const all = B.renderBucket(TODAY);
  ok(/<span class="bk-scale">to scale<\/span>/.test(all) && /<span class="bk-scale">enlarged<\/span>/.test(all), 'the two bars say "to scale" and "enlarged" in words');
}

// ═════════════════════════════════════════════════════════════════════════
section('§8  The stylesheets');
const LAYER_CSS = strip(read('tokens/layer.css'));
const BUCKET_CSS = strip(read('shared/bucket.css'));
{
  const idx = read('index.html');
  const pc = idx.indexOf('href="/next/tokens/color.css"'), pl = idx.indexOf('href="/next/tokens/layer.css"'), pb = idx.indexOf('href="/next/shared/bucket.css"');
  ok(pl > pc && pc > 0, 'index.html links tokens/layer.css after tokens/color.css');
  ok(pb > 0, 'index.html links shared/bucket.css');
  const lightAt = LAYER_CSS.indexOf('[data-theme="light"]');
  ok(lightAt > 0, 'layer.css has a light block');
  const names = (s) => new Set([...s.matchAll(/(--ly-[a-z-]+)\s*:/g)].map((m) => m[1]));
  const dk = names(LAYER_CSS.slice(0, lightAt)), lt = names(LAYER_CSS.slice(lightAt));
  ok(dk.size >= 20 && [...dk].every((n) => lt.has(n)) && [...lt].every((n) => dk.has(n)), 'every --ly-* name is declared in BOTH themes', [...dk].filter((n) => !lt.has(n)).join(','));
  const defined = new Set();
  for (const f of ['tokens/color.css', 'tokens/typography.css', 'tokens/space.css', 'tokens/shape.css', 'tokens/motion.css', 'tokens/material.css', 'tokens/layer.css']) {
    for (const m of strip(read(f)).matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  }
  const refs = [...new Set([...BUCKET_CSS.matchAll(/var\((--[a-zA-Z0-9-]+)/g), ...LAYER_CSS.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]))];
  ok(refs.length > 30, 'sanity: bucket.css + layer.css reference ' + refs.length + ' custom properties');
  const missing = refs.filter((r) => !defined.has(r));
  ok(missing.length === 0, 'every var(--x) in bucket.css and layer.css is defined', missing.join(', '));
  ok(!/#[0-9a-fA-F]{3,8}\b/.test(BUCKET_CSS) && !/#[0-9a-fA-F]{3,8}\b/.test(LAYER_CSS), 'no colour literal in either file — layer.css aliases primitives');
  ok(!/prefers-color-scheme/.test(BUCKET_CSS + LAYER_CSS), 'no prefers-color-scheme — theming is [data-theme] only');
  ok(!/danger/.test(BUCKET_CSS) && !/danger/.test(B.renderBucket({ ...TODAY, harnessTokens: 2e6 })), 'NEVER danger-toned, not even over the window');
  ok(!/--text-dim|--text-3\b/.test(BUCKET_CSS), 'no --text-dim, and no --text-3 (under 4.5:1) for any text the meter prints');
  ok(!/\.fresh-|\.tx-|\.cur-depth/.test(BUCKET_CSS), 'bucket.css declares no .fresh-, .tx- or .cur-depth rule');
  const sels = [...BUCKET_CSS.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].trim()).filter((s) => s && !s.startsWith('@') && !/^from|^to|^\d/.test(s));
  ok(sels.every((s) => s.split(',').every((p) => /\.bk\b|\.bk-|\.is-preview|\.is-unused/.test(p))), 'every selector is in the bk- prefix', sels.filter((s) => !/\.bk/.test(s)).join(' | '));
  ok(/prefers-reduced-motion/.test(BUCKET_CSS), 'width transitions stop under reduced motion');
}

// ═════════════════════════════════════════════════════════════════════════
section('§9  Contrast, recomputed from the token files');
{
  const color = strip(read('tokens/color.css'));
  const block = (s) => { const m = {}; for (const d of s.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) m[d[1]] = d[2].trim(); return m; };
  const cl = color.indexOf('[data-theme="light"]');
  const ll = LAYER_CSS.indexOf('[data-theme="light"]');
  const dark = { ...block(color.slice(0, cl)), ...block(LAYER_CSS.slice(0, ll)) };
  const light = { ...dark, ...block(color.slice(cl)), ...block(LAYER_CSS.slice(ll)) };
  const res = (th, n, d = 0) => { const v = th[n]; if (!v || d > 12) return null; const a = /^var\((--[a-z0-9-]+)\)$/.exec(v); return a ? res(th, a[1], d + 1) : v; };
  const rgb = (h) => { const m = /^#([0-9a-f]{6})$/i.exec(h || ''); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null; };
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const C = (th, f, b) => { const x = rgb(res(th, f)), y = rgb(res(th, b)); return x && y ? Math.round(ratio(x, y) * 100) / 100 : null; };
  ok(C(dark, '--ink-0', '--ink-1000') > 19 && C(dark, '--ink-0', '--ink-0') === 1, 'control: white/black ≈ 20, white/white = 1');
  // Planted failure: the concept mock's white on --violet-400 is 3.05 — the floor must reject it.
  ok(C(dark, '--ink-0', '--violet-400') < 4.5, 'control: white on violet-400 (the concept mock\'s brief) is under 4.5 — the floor bites', C(dark, '--ink-0', '--violet-400'));
  for (const [nm, th] of [['dark', dark], ['light', light]]) {
    for (const k of [...B.LAYER_KEYS, 'other']) {
      const r = C(th, '--ly-' + k + '-ink', '--ly-' + k);
      ok(r !== null && r >= 4.5, nm + ': the label ink on --ly-' + k + ' is ' + r + ':1 (≥ 4.5)');
    }
    for (let i = 0; i + 1 < B.LAYER_KEYS.length; i++) {
      const a = B.LAYER_KEYS[i], b = B.LAYER_KEYS[i + 1];
      const r = C(th, '--ly-' + a, '--ly-' + b);
      ok(r !== null && r >= 3, nm + ': neighbours ' + a + ' | ' + b + ' measure ' + r + ':1 (≥ 3)');
    }
    const texts = [['--ly-room-ink', '--ly-free', 'the room label'], ['--text-2', '--ly-free', 'free label'], ['--text-2', '--surface', 'axis / legend on --surface'],
      ['--text-2', '--surface-raised', 'axis / legend on --surface-raised'], ['--text', '--surface-inset', 'harness label on its pill'], ['--accent-text', '--surface', 'the preview tag']];
    for (const [f, b, what] of texts) { const r = C(th, f, b); ok(r !== null && r >= 4.5, nm + ': ' + what + ' ' + r + ':1 (≥ 4.5)'); }
    const r = C(th, '--ly-room-edge', '--ly-free');
    ok(r !== null && r >= 3, nm + ': the dashed room edge on the track ' + r + ':1 (≥ 3, non-text)');
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
