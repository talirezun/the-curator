#!/usr/bin/env node
/**
 * The Windows tray popover's MODEL (desktop/lib/tray-popover-model.js, v4.1.0)
 * and the additive options it needs in the tray's pure modules.
 *
 *   §0  the modules really loaded
 *   §1  `scales` on the three renderers: extra PNGs at exactly those scales,
 *       decoded; absent → no `buffers` key; the three read ONE rule
 *   §2  buildTrayModel: `imageScales` reaches every picture; absent, every
 *       renderer is called with exactly `{ dark }`
 *   §3  writtenAtText (D5): the friendly LOCAL time, on win32 only
 *   §4  THE MAC IS BYTE-IDENTICAL: model + template for five stores against
 *       goldens computed from the v4.0.1 modules (c865493), and relational
 *       checks that hold whatever a later release changes
 *   §5  THE PARITY CENSUS: every fact in flattenTrayMenu() is on a page, the
 *       pages follow the template item for item, cross-checked against
 *       renderTrayMenuText
 *   §6  the action map: every pressable row and nothing else; each id runs
 *       the template item's OWN click; Quit → 'quit', never a click
 *   §7  the generation gate: stale, malformed and unknown presses refused
 *       with no side effect — including the wrong-row race after a refresh
 *   §8  pictures: densities, CSS sizes, data URLs that decode
 *   §9  the payload is plain JSON and internally consistent; empty states
 *
 * Every name in the fixtures is INVENTED (public repository).
 *
 * NOT PROVEN HERE: that a page paints this payload (P3's suite), that main
 * passes the system theme and these options (P5, source + CI self-test), or
 * that any of it looks right on a real Windows display.
 */

// Local time is part of what §3 asserts. A zone with a half-hour offset
// catches both a UTC formatter and an hours-only conversion. Set before any
// Date is read; Node honours a runtime TZ change.
process.env.TZ = 'Asia/Kolkata';

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, '..', 'desktop', 'lib');
const BRAIN = path.join(__dirname, '..', 'src', 'brain');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  if (good) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}
function section(t) { console.log(`\n${t}`); }

let model, menu, pop, dots, bars, strip, palette;
try {
  const imp = (dir, f) => import(pathToFileURL(path.join(dir, f)).href);
  model = await imp(LIB, 'tray-model.js');
  menu = await imp(LIB, 'tray-menu.js');
  pop = await imp(LIB, 'tray-popover-model.js');
  dots = await imp(LIB, 'menu-dots.js');
  bars = await imp(LIB, 'menu-bars.js');
  strip = await imp(LIB, 'pulse-strip.js');
  palette = await imp(BRAIN, 'identity-palette.js');
} catch (err) {
  console.log(`\n  ✗ FATAL — could not import the tray modules: ${err.message}`);
  process.exit(1);
}

// ── PNG reading, independent of the encoder ─────────────────────────────────
function pngChunks(buf) {
  const out = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    out.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return out;
}
function pngSize(buf) {
  const ihdr = pngChunks(buf).find((c) => c.type === 'IHDR');
  return ihdr ? { w: ihdr.data.readUInt32BE(0), h: ihdr.data.readUInt32BE(4) } : null;
}
/** A PNG's identity as its header plus its INFLATED pixels — so a zlib build
 *  that compresses the same pixels differently does not read as a change. */
function pngIdentity(buf) {
  const ch = pngChunks(buf);
  const ihdr = ch.find((c) => c.type === 'IHDR');
  const idat = Buffer.concat(ch.filter((c) => c.type === 'IDAT').map((c) => c.data));
  return createHash('sha256').update(ihdr ? ihdr.data : Buffer.alloc(0)).update(inflateSync(idat)).digest('hex').slice(0, 16);
}
/** Canonical text of anything the model or template holds: key ORDER kept
 *  (it is part of byte-identity), Buffers as their pixel identity, functions
 *  as a marker. */
function canon(v) {
  return JSON.stringify(v, function (k, val) {
    const raw = this[k];
    if (Buffer.isBuffer(raw)) return 'png:' + raw.length + ':' + pngIdentity(raw);
    if (typeof raw === 'function') return '[fn]';
    if (raw === undefined) return '[undefined]';
    return val;
  });
}
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 20);

// ── Fixtures ────────────────────────────────────────────────────────────────
const T = new Date('2026-11-21T13:37:00Z');
const at = (s) => new Date(T.getTime() - s * 1000).toISOString();
const sc = (o) => ({
  machine: 'laptop-a1b2c3', harness: 'claude-code', model: 'opus-5-5', ageSource: 'agent',
  isThisMachine: true, isThisHost: true, harnessShared: false, ...o,
  writtenAgeSeconds: o.age, writtenAt: at(o.age),
});
const buckets = (n) => { const a = new Array(28).fill(0); a[27] = n; a[20] = 2; return a; };
function richSummary() {
  const scopes = [
    sc({ domain: 'work', project: 'alpha', scope: 'main', age: 30, headline: 'wired the tray bounds' }),
    sc({ domain: 'work', project: 'alpha', scope: 'research', age: 1200, harness: 'antigravity', headline: 'redid the section' }),
    sc({ domain: 'work', project: 'alpha', scope: 'spike', age: 2400, headline: 'a spike' }),
    sc({ domain: 'work', project: 'alpha', scope: 'docs', age: 3000, headline: 'docs pass' }),
    sc({ domain: 'work', project: 'alpha', scope: 'perf', age: 3100, headline: 'perf pass' }),
    sc({ domain: 'work', project: 'alpha', scope: 'ci', age: 3200, headline: 'ci pass' }),
    sc({ domain: 'work', project: 'alpha', scope: 'ux', age: 3300, headline: 'ux pass' }),
    sc({ domain: 'work', project: 'alpha', scope: 'sec', age: 3400, headline: 'sec pass' }),
    sc({ domain: 'work', project: 'alpha', scope: 'ops', age: 3500, headline: 'ops pass' }),
    sc({ domain: 'work', project: 'beta', scope: 'main', age: 3600, ageSource: 'file', machine: 'studio-9f8e7d',
      isThisMachine: false, isThisHost: false, headline: 'rewrote the serialiser' }),
    sc({ domain: 'work', project: 'gamma', scope: 'main', age: 7200, headline: 'g', kind: 'trimmed' }),
    sc({ domain: 'work', project: 'delta', scope: 'main', age: 9000, headline: 'd' }),
    sc({ domain: 'work', project: 'epsilon', scope: 'main', age: 10000, headline: 'e' }),
    sc({ domain: 'work', project: 'zeta', scope: 'main', age: 12000, headline: 'z' }),
    sc({ domain: 'work', project: 'eta', scope: 'main', age: 14000, headline: 'h' }),
  ];
  for (let i = 1; i <= 12; i++) scopes.push(sc({ domain: 'home', project: 'old' + i, scope: 'main', age: (2 + i * 4) * 86400 }));
  return {
    ok: true, total: scopes.length, scopes,
    warnings: [
      { code: 'harness-collision', message: 'Two agent tools are writing alpha · main.', domain: 'work', project: 'alpha',
        scope: 'main', machine: 'laptop-a1b2c3', harnesses: ['claude-code', 'antigravity'] },
      'A very long warning sentence about something the data layer noticed that is far wider than any menu can show',
      'Second warning.', 'Third warning.', 'Fourth warning.', 'Fifth warning.',
    ],
    remote: { ok: false, message: 'The check against GitHub could not finish because the network was unreachable from here' },
    pulse: {
      clock: 'agent', events: 40, harnessCount: 2, buckets: buckets(30), bucketSeconds: 21600, windowSeconds: 604800,
      coversWholeWindow: true, firstKnownBucket: 0,
      byHarness: {
        'claude-code': { label: 'Claude Code', buckets: buckets(25), events: 27, lastSeenAt: at(30) },
        antigravity: { label: 'Antigravity', buckets: buckets(5), events: 7, lastSeenAt: at(1200) },
      },
      byHarnessNote: 'Counted from journal tails.',
    },
    domains: [
      { domain: 'work', index: 0, slot: 1, pageCount: 767, entities: 400, concepts: 300, summaries: 67 },
      { domain: 'home', displayName: 'Home notes', index: 1, slot: 2, pageCount: 120 },
      { domain: 'odd', index: 2, slot: 3, pageCount: null },
    ],
    brief: null,
  };
}
/** A pulse with no per-tool lanes: the strip is then a LEAF with a tooltip. */
function plainPulseSummary() {
  const s = richSummary();
  const { byHarness, byHarnessNote, ...p } = s.pulse;
  return { ...s, pulse: p, warnings: [], remote: null };
}
const STORES = {
  rich: richSummary,
  plainPulse: plainPulseSummary,
  empty: () => ({ ok: true, scopes: [], warnings: [] }),
  unreadable: () => ({ ok: false, scopes: [], warnings: ['Could not read project context.'] }),
  garbage: () => 42,
};
const NOOPS = { onOpenScope() {}, onOpenMemory() {}, onOpenApp() {}, onOpenSettings() {}, onRowAction() {} };
const identityHex = palette.identityHex;
const macModel = (s, dark = true) => model.buildTrayModel(s, { now: T, dark, identityHex });
const macTemplate = (m) => menu.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: (x) => x });
const winModel = (s, dark = true, extra = {}) => model.buildTrayModel(s, {
  now: T, dark, identityHex, platform: 'win32', imageScales: pop.POPOVER_IMAGE_SCALES, ...extra,
});

// ═══════════════════════════════════════════════════════════════════════════
section('§0 the modules really loaded');
for (const [name, fn] of [['buildTrayPopover', pop.buildTrayPopover], ['popoverFromTemplate', pop.popoverFromTemplate],
  ['createPopoverActionGate', pop.createPopoverActionGate], ['writtenAtText', model.writtenAtText],
  ['normaliseImageScales', dots.normaliseImageScales]]) ok(typeof fn === 'function', name + ' is a function');
ok(macModel(richSummary()).rows.length >= 5, 'CONTROL — the rich store produces rows');

// ═══════════════════════════════════════════════════════════════════════════
section('§1 `scales` on the three renderers');
{
  const pulse = richSummary().pulse;
  const specs = {
    dot: (o) => dots.renderRecencyDot('recent', o),
    bar: (o) => bars.renderGutterBar({ frac: 0.5, ...o }),
    strip: (o) => strip.renderPulseStrip(pulse, o),
  };
  for (const [name, make] of Object.entries(specs)) {
    const base = make({ dark: true });
    ok(base && !Object.prototype.hasOwnProperty.call(base, 'buffers'), `${name}: no scales → no \`buffers\` key at all`);
    const s = make({ dark: true, scales: [3, 1, 6, 3] });
    eq(s && s.buffers && s.buffers.map((b) => b.scale), [1, 3, 6], `${name}: scales [3,1,6,3] → PNGs at 1, 3, 6 (deduplicated, ascending)`);
    const sizes = s.buffers.map((b) => pngSize(b.buffer));
    eq(sizes, s.buffers.map((b) => ({ w: base.widthPoints * b.scale, h: base.heightPoints * b.scale })),
      `${name}: each decodes to exactly points × scale pixels`);
    eq(pngIdentity(s.buffers[0].buffer), pngIdentity(base.buffer), `${name}: the scale-1 extra is the same pixels as the menu's own 1x`);
    const { buffers, ...rest } = s;
    eq(canon(rest), canon(base), `${name}: everything else on the spec is unchanged`);
  }
  // ONE rule, three copies (each renderer must survive its siblings missing).
  const cases = [undefined, null, [], 'x', [0], [-1], [1.5], [9], ['2'], [2, 2], [8, 1], [NaN, 4]];
  for (const c of cases) {
    const want = dots.normaliseImageScales(c);
    const got = (name) => {
      const s = specs[name]({ dark: false, scales: c });
      return s.buffers ? s.buffers.map((b) => b.scale) : null;
    };
    ok(['dot', 'bar', 'strip'].every((n) => JSON.stringify(got(n)) === JSON.stringify(want)),
      `scales ${JSON.stringify(c)} → ${JSON.stringify(want)} in all three renderers`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 buildTrayModel: `imageScales` reaches every picture, and only when asked');
{
  const seen = [];
  const rec = (kind) => (a, b) => { seen.push({ kind, o: kind === 'bar' ? a : b }); return null; };
  const hooks = { renderDot: rec('dot'), renderStrip: rec('strip'), renderBar: rec('bar') };
  model.buildTrayModel(richSummary(), { now: T, dark: true, ...hooks });
  ok(seen.length > 10 && ['dot', 'strip', 'bar'].every((k) => seen.some((s) => s.kind === k)), 'CONTROL — all three renderers were called');
  ok(seen.filter((s) => s.kind !== 'bar').every((s) => JSON.stringify(Object.keys(s.o)) === '["dark"]'),
    'no imageScales: the dot and strip renderers get exactly { dark }, as in v4.0.1');
  ok(seen.filter((s) => s.kind === 'bar').every((s) => !('scales' in s.o)), '…and the bar renderer gets no `scales`');
  seen.length = 0;
  model.buildTrayModel(richSummary(), { now: T, dark: true, imageScales: [1, 2, 3], ...hooks });
  ok(seen.every((s) => JSON.stringify(s.o.scales) === '[1,2,3]' && s.o.dark === true),
    'imageScales [1,2,3]: every renderer gets `scales: [1,2,3]` beside the theme');

  const m = winModel(richSummary());
  const pics = [...m.rows.map((r) => r.dot), m.pulse.strip, ...m.pulse.tools.map((t) => t.strip),
    ...m.domains.rows.map((d) => d.bar)].filter(Boolean);
  ok(pics.length > 10 && pics.every((p) => Array.isArray(p.buffers) && p.buffers.map((b) => b.scale).join() === '1,2,3,4,6'),
    `real renderers: all ${pics.length} pictures carry PNGs at POPOVER_IMAGE_SCALES`);
  const plain = macModel(richSummary());
  const macPics = [...plain.rows.map((r) => r.dot), plain.pulse.strip, ...plain.domains.rows.map((d) => d.bar)].filter(Boolean);
  ok(macPics.length > 10 && macPics.every((p) => !('buffers' in p)), '…and the Mac model\'s pictures carry none');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 writtenAtText (D5): a local time a person reads, on Windows only');
{
  eq(model.writtenAtText('2026-11-21T12:37:12.345Z'), '21 Nov 2026, 18:07', 'UTC 12:37 → "21 Nov 2026, 18:07" in a +05:30 zone (LOCAL, minutes included)');
  eq(model.writtenAtText('2026-01-04T20:05:00Z'), '5 Jan 2026, 01:35', 'crossing midnight moves the DATE too; one-digit day, two-digit time');
  eq(model.writtenAtText('not a date'), 'not a date', 'an unparsable stamp comes back as given — the fact is kept, only unprettified');
  eq([model.writtenAtText(''), model.writtenAtText(null), model.writtenAtText(5)], [null, null, null], 'nothing usable → null');

  const tipOf = (m) => m.rows.map((r) => r.toolTip).join('\n');
  const iso = at(30);
  const mac = tipOf(macModel(richSummary()));
  const win = tipOf(winModel(richSummary()));
  ok(mac.includes('written: ' + iso), 'Mac: the row says `written: <ISO>`, unchanged');
  ok(win.includes('written: ' + model.writtenAtText(iso)) && !win.includes(iso), 'Windows: the friendly time, and the ISO text appears nowhere');
  ok(!/written: \d{4}-\d\d-\d\dT/.test(win) && /written: \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d/.test(win),
    '…on every row that has one');
  const winNative = menu.flattenTrayMenu(menu.buildTrayMenuTemplate(winModel(richSummary()), { ...NOOPS, platform: 'win32' }));
  ok(winNative.some((i) => i.label === 'written: ' + model.writtenAtText(iso)),
    'the native Windows fallback menu shows the friendly time as its own line (it reads the same model)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 THE MAC IS BYTE-IDENTICAL');
{
  // Computed by running this suite's own canon() over the v4.0.1 modules
  // (git show c865493:desktop/lib/*.js into a scratch folder). A red here
  // means the Mac menu changed. If that was deliberate, recompute; if it
  // came from a popover or Windows option, the option leaked.
  const GOLDEN = {
    'rich/dark': '9daf2bde6b9abb85c5a4',
    'rich/light': '752b8d347332b720e26f',
    'plainPulse/dark': 'd878c4513566c754a0cb',
    'empty/dark': '8174f4ed06268fc055fe',
    'unreadable/dark': '9b6598f5fbca0f77c429',
    'garbage/dark': '8174f4ed06268fc055fe',
  };
  for (const [name, want] of Object.entries(GOLDEN)) {
    const [store, theme] = name.split('/');
    const m = macModel(STORES[store](), theme === 'dark');
    eq(sha(canon({ model: m, template: macTemplate(m) })), want, `${name}: the Mac model + template equal v4.0.1's`);
  }

  // Relational — true whatever a later release does to the Mac menu.
  const plain = macModel(richSummary());
  const scaled = model.buildTrayModel(richSummary(), { now: T, dark: true, identityHex, imageScales: [1, 2, 3] });
  const strip = (v) => JSON.parse(canon(v), (k, val) => (k === 'buffers' ? undefined : val));
  eq(strip(scaled), strip(plain), 'imageScales adds `buffers` and changes NOTHING else in the model');
  const t1 = menu.buildTrayMenuTemplate(plain, { ...NOOPS, makeIcon: (x) => x });
  const t2 = menu.buildTrayMenuTemplate(plain, { ...NOOPS, makeIcon: (x) => x, platform: 'darwin', adaptForWindows: false });
  eq(canon(t2), canon(t1), 'adaptForWindows: false has no effect off Windows');
  const w = winModel(richSummary());
  eq(canon(menu.buildTrayMenuTemplate(w, { ...NOOPS, platform: 'win32', adaptForWindows: true })),
    canon(menu.buildTrayMenuTemplate(w, { ...NOOPS, platform: 'win32' })),
    'win32: the native menu is still adapted by default (the v4.0.1 fallback is unchanged)');
  const full = menu.buildTrayMenuTemplate(w, { ...NOOPS, platform: 'win32', adaptForWindows: false });
  const fl = menu.flattenTrayMenu(full);
  ok(fl.some((i) => i.sublabel) && fl.some((i) => i.toolTip) && fl.some((i) => i.type === menu.MENU_HEADER_TYPE),
    'win32 + adaptForWindows:false: the FULL template (sublabels, tooltips, headers survive)');
  ok(fl.some((i) => i.label === 'Show current.md in File Explorer') && !fl.some((i) => /Finder/.test(i.label || '')),
    '…in the Windows words');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 THE PARITY CENSUS');
function census(storeName, summaryFn) {
  const m = winModel(summaryFn());
  const template = menu.buildTrayMenuTemplate(m, { ...NOOPS, makeIcon: (x) => x, platform: 'win32', adaptForWindows: false });
  const { payload } = pop.buildTrayPopover(m, { theme: 'dark', ...NOOPS });
  const pages = payload.pages;

  // (a) The pages follow the template ITEM FOR ITEM: one row per item, same
  // kind, same label, same sublabel; a parent's page holds its submenu.
  const problems = [];
  const walk = (items, page, inheritedDetails) => {
    const rows = page.rows;
    const list = items.filter((i) => i && typeof i === 'object');
    if (rows.length !== list.length) problems.push(`${page.id}: ${rows.length} rows for ${list.length} items`);
    list.forEach((item, i) => {
      const row = rows[i];
      if (!row) return;
      if (item.type === 'separator') { if (row.kind !== 'separator') problems.push(`${page.id}#${i} not a separator`); return; }
      if (item.type === menu.MENU_HEADER_TYPE) {
        if (row.kind !== 'header' || row.label !== item.label) problems.push(`${page.id}#${i} header`);
        return;
      }
      if (row.label !== item.label && !(row.kind === 'drill' && row.label === item.label)) problems.push(`${page.id}#${i} label ${row.label} ≠ ${item.label}`);
      const sub = typeof item.sublabel === 'string' && item.sublabel.trim() ? item.sublabel.trim() : null;
      if ((row.sublabel || null) !== sub) problems.push(`${page.id}#${i} sublabel`);
      if (!!item.icon !== !!row.img) problems.push(`${page.id}#${i} picture`);
      if (Array.isArray(item.submenu)) {
        if (row.kind !== 'drill' || !pages[row.drill]) { problems.push(`${page.id}#${i} not a drill`); return; }
        if (pages[row.drill].parent !== page.id || pages[row.drill].title !== item.label) problems.push(`${row.drill} parent/title`);
        walk(item.submenu, pages[row.drill]);
      }
    });
  };
  walk(template, pages.root);
  eq(problems, [], `${storeName}: every page follows its template level item for item (kind, label, sublabel, picture)`);

  // (b) Every FACT of flattenTrayMenu() is on a page.
  const strings = new Set();
  const details = new Set();
  for (const p of Object.values(pages)) {
    for (const r of p.rows) { if (r.label) strings.add(r.label); if (r.sublabel) strings.add(r.sublabel); }
    for (const g of p.details) for (const l of g.lines) details.add(l);
  }
  const flat = menu.flattenTrayMenu(template);
  const missing = [];
  for (const item of flat) {
    if (item.type === 'separator') continue;
    const label = item.label || '';
    if (label && !strings.has(label)) missing.push('label: ' + label);
    if (item.sublabel && !strings.has(item.sublabel.trim())) missing.push('sublabel: ' + item.sublabel);
    if (typeof item.toolTip === 'string') {
      for (const l of item.toolTip.split('\n').map((x) => x.trim()).filter(Boolean)) {
        if (l === label.trim() || l === (item.sublabel || '').trim()) continue;
        if (!details.has(l)) missing.push('detail: ' + l);
      }
    }
  }
  eq(missing, [], `${storeName}: all ${flat.length} items' labels, sublabels and tooltip lines are on the pages`);

  // (c) A dumb cross-check through a DIFFERENT reader of the same template:
  // every line renderTrayMenuText prints, stripped of its drawing marks.
  const text = menu.renderTrayMenuText(template).split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^─+$/.test(l))
    .map((l) => l.replace(/^── (.*) ──$/, '$1')
      .replace(/^[◉●◐◑○◌•▬▫]\s+|^▂▅▇\s*/u, '')
      .replace(/\s+\[[a-z]+\]$/, '').replace(/\s+›$/, '').replace(/\s+⌘Q$/, '')
      .replace(/^\((.*)\)$/, '$1').trim());
  const notShown = text.filter((l) => l && !strings.has(l));
  eq(notShown, [], `${storeName}: every one of the ${text.length} lines renderTrayMenuText prints is a label or second line on a page`);
  return { m, template, payload, flat };
}
const rich = census('rich', richSummary);
census('plainPulse', plainPulseSummary);
census('empty', STORES.empty);
census('unreadable', STORES.unreadable);
{
  const flat = rich.flat;
  ok(flat.some((i) => i.toolTip && i.toolTip.includes('written: ')), 'CONTROL — the census saw rows with tooltip facts');
  ok(flat.some((i) => i.label && /^\+\d+ more active projects$/.test(i.label)), 'CONTROL — …the overflow fold');
  ok(flat.some((i) => /more in Project Context…$/i.test(i.label || '')), 'CONTROL — …a "more in Project Context…" route');
  ok(flat.some((i) => /^…and \d+ more$/.test(i.label || '')), 'CONTROL — …hidden notices');
  ok(flat.some((i) => /^Idle · /.test(i.label || '')) && flat.some((i) => /^Knowledge · /.test(i.label || '')), 'CONTROL — …Idle and Knowledge');
  const root = rich.payload.pages.root;
  eq(root.details, [], 'root carries no Details block (D7: facts on drill pages only)');
  const clipped = root.rows.find((r) => r.kind === 'drill' && /…$/.test(r.label) && /GitHub/.test(r.label));
  ok(clipped && rich.payload.pages[clipped.drill].details[0].lines.some((l) => /network was unreachable from here$/.test(l)),
    'a CLIPPED notice is a drill whose page carries its whole sentence');
  const pulseRow = root.rows[0];
  const pulsePage = rich.payload.pages[pulseRow.drill];
  ok(pulseRow.kind === 'drill' && pulsePage.details.some((g) => g.label === null && g.lines.length)
    && pulsePage.details.some((g) => g.label && /saves/.test(g.label)),
    'the pulse page: the pulse\'s own facts (label null) and each tool\'s, under that tool\'s label');
  const project = rich.payload.pages[root.rows.find((r) => r.kind === 'drill' && /^alpha · /.test(r.label)).drill];
  ok(project.details.length === 1 && project.details[0].label === null && project.details[0].lines.includes('machine: laptop-a1b2c3'),
    'a project page: the row\'s own facts as its Details');
  ok(project.rows.some((r) => r.kind === 'drill') && JSON.stringify(project.rows.filter((r) => r.kind === 'action' && !/streams-more$/.test(r.id)).map((r) => r.id.split(':')[1])) === '["open","resume","handoff","reveal"]',
    '…its four actions, and Other work-streams as drills one level deeper');

  // The pulse with no lanes is a LEAF with facts: a small page whose action
  // is worded as the native Windows menu words it.
  const pp = pop.buildTrayPopover(winModel(plainPulseSummary()), { ...NOOPS }).payload;
  const p0 = pp.pages.root.rows[0];
  const sub = pp.pages[p0.drill];
  ok(p0.kind === 'drill' && sub && sub.id.startsWith('d:'), 'a ROOT leaf with facts (the lane-less pulse) → a drill to its own page');
  eq(sub && sub.rows.map((r) => [r.kind, r.label]), [['action', 'Open Project Context…']],
    '…whose one action reads "Open Project Context…", the native Windows menu\'s word for it');
  ok(sub && sub.details.length === 1 && sub.details[0].lines.length > 0, '…and whose Details carry the pulse\'s facts');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the action map: every pressable row, nothing else, each its own click');
{
  const calls = [];
  const H = {
    onOpenScope: (row) => calls.push(['scope', row.id || row.route]),
    onOpenMemory: () => calls.push(['memory']),
    onOpenApp: () => calls.push(['app']),
    onOpenSettings: () => calls.push(['settings']),
    onRowAction: (row, action) => calls.push(['row', row.id, action]),
  };
  const m = winModel(richSummary());
  const built = pop.buildTrayPopover(m, { theme: 'dark', ...H });
  const rows = Object.values(built.payload.pages).flatMap((p) => p.rows);
  const actionIds = rows.filter((r) => r.kind === 'action').map((r) => r.id);
  eq([...built.actions.keys()].sort(), [...actionIds].sort(), 'the map\'s keys ARE the action rows\' ids — nothing more, nothing less');
  eq(new Set(actionIds).size, actionIds.length, 'no two action rows share an id');
  ok(rows.filter((r) => r.kind !== 'action').every((r) => !('id' in r)), 'headers, statements, stamps, drills and separators carry no id');

  // Every template item that does something is exactly one action.
  const template = menu.buildTrayMenuTemplate(m, { ...H, makeIcon: (x) => x, platform: 'win32', adaptForWindows: false });
  const doers = menu.flattenTrayMenu(template).filter((i) => i.role === 'quit' || (typeof i.click === 'function' && i.enabled !== false));
  eq(actionIds.length, doers.length, `all ${doers.length} template items with an action are reachable, once each`);

  const quit = rows.find((r) => r.kind === 'action' && r.label === 'Quit The Curator');
  eq(quit && quit.id, 'tray-quit', 'Quit is an action row, id tray-quit');
  eq(built.actions.get('tray-quit'), 'quit', '…whose map entry is the string \'quit\', never a function');
  const tq = template.find((i) => i.id === 'tray-quit');
  ok(tq && tq.role === 'quit' && !('click' in tq), '…and the template item still carries role:\'quit\' and no click (the before-quit guard)');
  const rootRows = built.payload.pages.root.rows;
  eq(rootRows[rootRows.length - 1].id, 'tray-quit', 'Quit is the last row of root');

  // Each id runs ITS item's own click — the right handler with the right row.
  const gate = pop.createPopoverActionGate();
  const p = gate.publish(built);
  let quits = 0;
  const run = (id) => { calls.length = 0; const r = gate.act(p.gen, id, { quit: () => { quits++; } }); return [r, calls.slice()]; };
  const first = m.active.rows[0];
  eq(run(first.id + ':open'), [true, [['scope', first.id]]], 'tray-row-0:open → onOpenScope(that row)');
  eq(run(first.id + ':resume'), [true, [['row', first.id, 'resume']]], 'tray-row-0:resume → onRowAction(that row, resume)');
  eq(run(first.id + ':reveal'), [true, [['row', first.id, 'reveal']]], '…:reveal → onRowAction(that row, reveal)');
  eq(run('tray-open-memory'), [true, [['memory']]], 'tray-open-memory → onOpenMemory');
  eq(run('tray-open-app'), [true, [['app']]], 'tray-open-app → onOpenApp');
  eq(run('tray-settings'), [true, [['settings']]], 'tray-settings → onOpenSettings');
  eq(run(m.domains.rows[0].id), [true, [['settings']]], 'a domain row → onOpenSettings');
  eq(run('tray-quit'), [true, []], 'tray-quit → no handler at all…');
  eq(quits, 1, '…only the injected quit (main\'s () => app.quit())');
  const everyId = [...built.actions.keys()];
  let allRan = true;
  for (const id of everyId) {
    calls.length = 0; const before = quits;
    if (!gate.act(p.gen, id, { quit: () => { quits++; } }) || (calls.length + (quits - before)) !== 1) allRan = false;
  }
  ok(allRan, `each of the ${everyId.length} ids runs exactly one handler`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the generation gate');
{
  const calls = [];
  const H = { ...NOOPS, onOpenScope: (row) => calls.push(row.route) };
  const gate = pop.createPopoverActionGate();
  ok(gate.current() === null && gate.act(1, 'tray-open-app') === false, 'nothing published → every press refused');

  // THE WRONG-ROW RACE. tray-row-0 is alpha; a save in beta reorders the
  // rows; tray-row-0 is now beta. A press from the page painted before the
  // refresh must not open beta.
  const s1 = richSummary();
  const p1 = gate.publish(pop.buildTrayPopover(winModel(s1), H));
  const s2 = richSummary();
  s2.scopes.find((x) => x.project === 'beta').writtenAt = at(1);
  s2.scopes.find((x) => x.project === 'beta').writtenAgeSeconds = 1;
  const m2 = winModel(s2);
  const p2 = gate.publish(pop.buildTrayPopover(m2, H));
  ok(p2.gen === p1.gen + 1, `publish stamps gen ${p1.gen} → ${p2.gen}`);
  eq(m2.active.rows[0].route, 'work/beta', 'CONTROL — after the refresh tray-row-0 names a DIFFERENT project');
  calls.length = 0;
  eq(gate.act(p1.gen, 'tray-row-0:open'), false, 'the old page\'s press on tray-row-0 is REFUSED');
  eq(calls, [], '…and no handler ran (beta was not opened by a press aimed at alpha)');
  eq(gate.act(p2.gen, 'tray-row-0:open'), true, 'the same id with the current gen is accepted');
  eq(calls, ['work/beta'], '…and opens what the CURRENT page shows');
  ok(gate.current() === p2, 'current() is the payload to resend for a repaint');

  const bad = [[0, 'tray-open-app'], [-1, 'tray-open-app'], [p2.gen + 1, 'tray-open-app'], [String(p2.gen), 'tray-open-app'],
    [p2.gen + 0.5, 'tray-open-app'], [NaN, 'tray-open-app'], [null, 'tray-open-app'], [undefined, 'tray-open-app'],
    [p2.gen, ''], [p2.gen, 'x'.repeat(201)], [p2.gen, 42], [p2.gen, null], [p2.gen, '__proto__'], [p2.gen, 'toString'],
    [p2.gen, 'constructor'], [p2.gen, 'tray-header-active'], [p2.gen, 'tray-updated-stamp'], [p2.gen, 'tray-knowledge'], [p2.gen, 'tray-row-0']];
  for (const [g, id] of bad) {
    eq([gate.resolve(g, id), gate.act(g, id, { quit() { throw new Error('must not run'); } })], [null, false],
      `refused: gen ${JSON.stringify(g) ?? 'undefined'}, id ${JSON.stringify(id)?.slice(0, 40) ?? 'undefined'}`);
  }
  eq(gate.act(p2.gen, 'tray-quit'), false, 'Quit with no quit function injected → refused, not a silent success');
  const boom = pop.createPopoverActionGate();
  const pb = boom.publish(pop.buildTrayPopover(winModel(richSummary()), { ...NOOPS, onOpenApp: () => { throw new Error('x'); } }));
  eq(boom.act(pb.gen, 'tray-open-app'), false, 'a handler that throws → false, and the gate does not throw');
  // The length rule is the gate's OWN, not only a property of the ids it is
  // usually handed: a map holding a 201-character key still refuses it.
  const raw = pop.createPopoverActionGate();
  const longId = 'y'.repeat(201);
  let ran = 0;
  const pr = raw.publish({ payload: { v: 1, gen: 0, pages: {} }, actions: new Map([[longId, () => { ran++; }], ['ok', () => { ran++; }]]) });
  eq([raw.act(pr.gen, longId), raw.act(pr.gen, 'ok'), ran], [false, true, 1], 'a 201-character id is refused even when the map holds it (the 200 limit is the gate\'s own)');
  const { act } = gate;
  eq(act(p2.gen, 'tray-open-app'), true, 'act works detached from the gate object (no `this`)');
  let threw = false;
  try { gate.publish({ payload: {}, actions: {} }); } catch { threw = true; }
  ok(threw && gate.current() === p2, 'publish refuses something that is not a buildTrayPopover() result, and keeps the current generation');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§8 pictures');
{
  const m = winModel(richSummary());
  const { payload } = pop.buildTrayPopover(m, { theme: 'light', ...NOOPS });
  const imgs = Object.values(payload.pages).flatMap((p) => p.rows).map((r) => r.img).filter(Boolean);
  const byKind = (k) => imgs.filter((i) => i.kind === k);
  ok(byKind('dot').length > 5 && byKind('strip').length === 3 && byKind('bar').length === 2, 'CONTROL — dots, three strips and two bars reached the pages');
  ok(byKind('strip').every((i) => JSON.stringify(i.sources.map((s) => s.density)) === '[1,1.5,2,3]'),
    'strip: densities 1, 1.5, 2, 3 (scales 2, 3, 4, 6 at 2x CSS size, D6)');
  const st = m.pulse.strip;
  eq([byKind('strip')[0].w, byKind('strip')[0].h], [st.widthPoints * 2, st.heightPoints * 2], 'strip: drawn at TWICE its point size');
  ok(byKind('dot').every((i) => JSON.stringify(i.sources.map((s) => s.density)) === '[1,2,3]' && i.w === 13 && i.h === 13 && i.tier),
    'dot: 13 px, densities 1, 2, 3, its tier named');
  ok(byKind('bar').every((i) => JSON.stringify(i.sources.map((s) => s.density)) === '[1,2,3]' && i.w === 28),
    'bar: 28 px, densities 1, 2, 3');
  const s3 = byKind('strip')[0].sources.find((s) => s.density === 3);
  const decoded = Buffer.from(s3.url.replace(/^data:image\/png;base64,/, ''), 'base64');
  ok(s3.url.startsWith('data:image/png;base64,'), 'sources are PNG data URLs');
  eq(pngSize(decoded), { w: st.widthPoints * 6, h: st.heightPoints * 6 }, 'the 3x strip source decodes to points × 6 pixels (3 device px per CSS px at 2x size)');

  // Without the extra scales (a model built the Mac way): still a picture.
  const plainImg = pop.popoverImage(macModel(richSummary()).pulse.strip);
  eq(plainImg.sources.map((s) => s.density), [1], 'a strip with only the menu\'s 1x/2x → its 2x as density 1 (0.5 dropped)');
  eq(pop.popoverImage(macModel(richSummary()).rows[0].dot).sources.map((s) => s.density), [1, 2], 'a menu dot → densities 1, 2');
  eq([pop.popoverImage(null), pop.popoverImage({ widthPoints: 0, heightPoints: 1, buffer: Buffer.from([1]) }),
    pop.popoverImage({ widthPoints: 5, heightPoints: 5 })], [null, null, null], 'nothing drawable → null, never a broken picture');
  eq(payload.theme, 'light', 'theme light');
  eq(['dark', 'light', 'Dark', undefined, 1].map((t) => pop.popoverFromTemplate([], { theme: t }).payload.theme),
    ['dark', 'light', 'light', 'light', 'light'], 'theme: only the literal \'dark\' is dark');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§9 the payload is plain JSON and consistent; empty and broken stores');
for (const [name, fn] of Object.entries(STORES)) {
  const built = pop.buildTrayPopover(winModel(fn()), { theme: 'dark', ...NOOPS });
  const p = built.payload;
  const json = JSON.stringify(p);
  eq(JSON.stringify(JSON.parse(json)), json, `${name}: survives JSON (no functions, Buffers or undefined)`);
  ok(!json.includes('"[fn]"') && !/"type":"Buffer"/.test(json), `${name}: no function and no Buffer in it`);
  const pages = Object.values(p.pages);
  const rows = pages.flatMap((pg) => pg.rows);
  ok(p.v === 1 && p.root === 'root' && p.pages.root && p.pages.root.parent === null, `${name}: v1, root page present`);
  ok(rows.filter((r) => r.kind === 'drill').every((r) => p.pages[r.drill] && p.pages[r.drill].parent),
    `${name}: every drill names a page that returns somewhere`);
  ok(pages.every((pg) => pg.parent === null || p.pages[pg.parent]), `${name}: every page's parent exists`);
  eq(new Set(rows.map((r) => r.key)).size, rows.length, `${name}: row keys are unique`);
  ok(rows.every((r) => ['separator', 'header', 'statement', 'stamp', 'action', 'drill'].includes(r.kind)), `${name}: only the six kinds`);
  ok(rows.filter((r) => r.kind === 'action').every((r) => typeof r.id === 'string' && r.id.length <= 200), `${name}: ids ≤ 200 chars`);
  const labels = p.pages.root.rows.map((r) => r.label);
  ok(labels.includes('Open The Curator') && labels[labels.length - 1] === 'Quit The Curator',
    `${name}: Open The Curator present and Quit last, whatever the store`);
}
{
  const p = pop.buildTrayPopover(winModel(richSummary()), { ...NOOPS }).payload;
  ok(p.pages.root.rows.some((r) => r.kind === 'stamp' && /^Updated \d\d:\d\d$/.test(r.label)), 'the Updated stamp is a `stamp` row');
  let threw = null;
  try { pop.buildTrayPopover(winModel(richSummary()), { onOpenApp() {} }); } catch (e) { threw = e.message; }
  ok(threw && /must be a function/.test(threw), 'a missing handler throws at BUILD time, as the menu does');
  const long = 'x'.repeat(250);
  const odd = pop.popoverFromTemplate([
    { id: long, label: 'A', click() {} }, { id: 'dup', label: 'B', click() {} }, { id: 'dup', label: 'C', click() {} },
    { label: 'D', click() {} }, { id: 'e', label: 'E', enabled: false, click() {} },
  ]);
  const ids = odd.payload.pages.root.rows.map((r) => r.id || null);
  ok(ids[0] !== long && ids[0].length <= 200 && ids[1] === 'dup' && ids[2] !== 'dup' && ids[3] && ids[4] === null,
    `too-long, duplicate and missing ids are replaced; a disabled item is a statement (${JSON.stringify(ids)})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
