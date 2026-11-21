/**
 * test-tray-popover-position.js — OFFLINE guard for desktop/lib/tray-popover-position.js,
 * the pure function that decides where the Windows tray popover opens.
 *
 * Everything is a plain object, so every case is EXECUTED: the taskbar on each of the four edges,
 * the "^" overflow flyout (icon inside the work area), an auto-hiding taskbar (work area equals the
 * display), a mixed-DPI secondary display at negative x, a work area smaller than the popover,
 * unusable tray bounds (cursor, then corner), and a seeded fuzz of junk (NaN, Infinity, zero, huge,
 * missing, wrong types) asserting the result is never NaN, always integers, and inside the work area.
 *
 * Exact coordinates are hand-derived in the comments (the 6 px gap on the taskbar's side, the 8 px
 * margin elsewhere); the fuzz is the dumb cross-check. Nothing here touches Electron or user data.
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(__dirname, '..', 'desktop', 'lib', 'tray-popover-position.js')).href);
const { computePopoverPosition: place, validTrayBounds, validDisplayArea, taskbarEdge,
  POPOVER_GAP, POPOVER_MARGIN } = mod;

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, { got: a, want: b });
const pick = (r, ...ks) => Object.fromEntries(ks.map(k => [k, r[k]]));
const inside = (r, a) => r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height;

const SIZE = { width: 360, height: 560 };
const B = { x: 0, y: 0, width: 1920, height: 1080 };
const disp = (workArea, bounds = B) => ({ bounds, workArea });
const BOTTOM = disp({ x: 0, y: 0, width: 1920, height: 1032 });
const TOP = disp({ x: 0, y: 48, width: 1920, height: 1032 });
const LEFT = disp({ x: 48, y: 0, width: 1872, height: 1080 });
const RIGHT = disp({ x: 0, y: 0, width: 1872, height: 1080 });

console.log('\n§0 positive control');
ok(POPOVER_GAP === 6 && POPOVER_MARGIN === 8, 'gap 6, margin 8');

console.log('\n§1 the taskbar on each of the four edges');
{
  // bottom: x = 1812-180 = 1632 -> clamped to 1920-8-360 = 1552; y = 1040-6-560 = 474 -> the gap
  // (not the margin) on the taskbar's side: max y = 1032-6-560 = 466.
  const r = place({ trayBounds: { x: 1800, y: 1040, width: 24, height: 32 }, display: BOTTOM, size: SIZE });
  eq(pick(r, 'x', 'y', 'width', 'height', 'edge', 'anchor'),
    { x: 1552, y: 466, width: 360, height: 560, edge: 'bottom', anchor: 'tray' }, 'bottom taskbar: above the icon, 6 px off the taskbar');
  // an icon mid-bar is centred over: x = 900-180 = 720
  const m = place({ trayBounds: { x: 888, y: 1040, width: 24, height: 32 }, display: BOTTOM, size: SIZE });
  eq(pick(m, 'x', 'y'), { x: 720, y: 466 }, 'bottom: centred over the icon');
  // top: y = max(40,48)+6 = 54
  const t = place({ trayBounds: { x: 1800, y: 8, width: 24, height: 32 }, display: TOP, size: SIZE });
  eq(pick(t, 'x', 'y', 'edge'), { x: 1552, y: 54, edge: 'top' }, 'top taskbar: below it');
  // left: x = max(36,48)+6 = 54; y = 1012-280 = 732 -> max 1080-8-560 = 512
  const l = place({ trayBounds: { x: 12, y: 1000, width: 24, height: 24 }, display: LEFT, size: SIZE });
  eq(pick(l, 'x', 'y', 'edge'), { x: 54, y: 512, edge: 'left' }, 'left taskbar: to the right of it');
  // right: x = min(1884,1872)-6-360 = 1506
  const rt = place({ trayBounds: { x: 1884, y: 1000, width: 24, height: 24 }, display: RIGHT, size: SIZE });
  eq(pick(rt, 'x', 'y', 'edge'), { x: 1506, y: 512, edge: 'right' }, 'right taskbar: to the left of it');
  for (const [name, res, d] of [['bottom', r, BOTTOM], ['top', t, TOP], ['left', l, LEFT], ['right', rt, RIGHT]]) {
    ok(inside(res, d.workArea), `${name}: inside the work area`, res);
  }
  // The popover never overlaps the taskbar.
  ok(r.y + r.height === 1026, 'bottom: its bottom edge is 6 px above the taskbar');
}

console.log('\n§2 the "^" overflow flyout (icon inside the work area) and an auto-hide taskbar');
{
  const fly = place({ trayBounds: { x: 1700, y: 980, width: 24, height: 24 }, display: BOTTOM, size: SIZE });
  eq(pick(fly, 'x', 'y', 'edge'), { x: 1532, y: 414, edge: 'bottom' }, 'overflow flyout icon: nearest display edge (bottom), opens above the icon');
  ok(inside(fly, BOTTOM.workArea), 'overflow: inside the work area', fly);
  const auto = disp(B);
  const a = place({ trayBounds: { x: 1800, y: 1050, width: 24, height: 24 }, display: auto, size: SIZE });
  eq(pick(a, 'x', 'y', 'edge'), { x: 1552, y: 484, edge: 'bottom' }, 'auto-hide (work area == display), bottom: above the icon');
  const side = place({ trayBounds: { x: 1890, y: 500, width: 24, height: 24 }, display: auto, size: SIZE });
  eq(pick(side, 'edge'), { edge: 'right' }, 'auto-hide on the right edge is found');
  ok(inside(side, B) && side.x + side.width <= 1890 - POPOVER_GAP + 0.0001, 'auto-hide right: left of the icon', side);
  const topAuto = place({ trayBounds: { x: 900, y: 2, width: 24, height: 24 }, display: auto, size: SIZE });
  eq(pick(topAuto, 'edge', 'y'), { edge: 'top', y: 32 }, 'auto-hide top: below the icon');
  eq(taskbarEdge({ x: 5, y: 500, width: 24, height: 24 }, auto), 'left', 'taskbarEdge: nearest edge left');
}

console.log('\n§3 a mixed-DPI secondary display at negative x');
{
  // 1920x1080 at 125% = 1536x864 DIPs, left of the primary, 40 px taskbar.
  const sec = disp({ x: -1536, y: 0, width: 1536, height: 824 }, { x: -1536, y: 0, width: 1536, height: 864 });
  // centre x = -50 -> -230 -> clamped to -1536+1536-8-360 = -368; y = 830-6-560 = 264 -> max 824-6-560 = 258
  const r = place({ trayBounds: { x: -60, y: 830, width: 20, height: 30 }, display: sec, size: SIZE, scaleFactor: 1.25 });
  eq(pick(r, 'x', 'y', 'edge', 'scaleFactor'), { x: -368, y: 258, edge: 'bottom', scaleFactor: 1.25 }, 'negative x: right-edge clamp keeps the margin');
  ok(inside(r, sec.workArea), 'inside the secondary work area', r);
  const far = place({ trayBounds: { x: -1530, y: 830, width: 20, height: 30 }, display: sec, size: SIZE, scaleFactor: 1.25 });
  eq(pick(far, 'x'), { x: -1528 }, 'negative x: left-edge clamp = work area x + 8');
  const noScale = place({ trayBounds: { x: -60, y: 830, width: 20, height: 30 }, display: sec, size: SIZE, scaleFactor: NaN });
  eq(noScale.scaleFactor, 1, 'a junk scale factor becomes 1');
  ok([r.x, r.y, r.width, r.height].every(Number.isInteger), 'x, y, width, height are integers are integers (setBounds-safe)');
}

console.log('\n§4 a work area smaller than the popover');
{
  const d = disp({ x: 100, y: 50, width: 300, height: 400 }, { x: 0, y: 0, width: 800, height: 600 });
  // shrinks to 284 x 384; x = 392-142 = 250 -> max 100+300-8-284 = 108; y -> max(58, 450-6-384 = 60) = 60
  const r = place({ trayBounds: { x: 380, y: 460, width: 24, height: 24 }, display: d, size: SIZE });
  eq(pick(r, 'x', 'y', 'width', 'height'), { x: 108, y: 60, width: 284, height: 384 }, 'shrunk to work area minus margins');
  ok(inside(r, d.workArea), 'still inside', r);
  const tiny = place({ trayBounds: null, display: disp({ x: 10, y: 10, width: 12, height: 9 }, { x: 0, y: 0, width: 100, height: 100 }), size: SIZE });
  ok(tiny.width >= 1 && tiny.height >= 1 && Number.isInteger(tiny.x) && Number.isInteger(tiny.y), 'a 12x9 work area still yields a positive integer rect', tiny);
}

console.log('\n§5 unusable tray bounds: the cursor, then the corner');
{
  const cur = place({ trayBounds: { x: 0, y: 0, width: 0, height: 0 }, cursor: { x: 500, y: 300 }, display: BOTTOM, size: SIZE });
  eq(pick(cur, 'anchor', 'edge', 'x', 'y'), { anchor: 'cursor', edge: 'top', x: 320, y: 306 }, 'zero bounds + cursor on the display: at the cursor');
  const corner = place({ trayBounds: null, display: BOTTOM, size: SIZE });
  eq(pick(corner, 'anchor', 'x', 'y'), { anchor: 'corner', x: 1552, y: 464 }, 'no anchor: the work-area corner by the clock (bottom right)');
  const offCursor = place({ trayBounds: null, cursor: { x: 5000, y: 5000 }, display: BOTTOM, size: SIZE });
  eq(pick(offCursor, 'anchor'), { anchor: 'corner' }, 'a cursor on another display is not used');
  const offIcon = place({ trayBounds: { x: 5000, y: 1040, width: 24, height: 24 }, display: BOTTOM, size: SIZE });
  eq(pick(offIcon, 'anchor'), { anchor: 'corner' }, 'icon bounds on another display are not trusted');
  const bigIcon = place({ trayBounds: { x: 0, y: 0, width: 5000, height: 40 }, display: BOTTOM, size: SIZE });
  eq(pick(bigIcon, 'anchor'), { anchor: 'corner' }, 'icon-sized only: a 5000 px "icon" is refused');
  ok(validTrayBounds({ x: 1, y: 2, width: 24, height: 24 }) !== null && validTrayBounds({ x: NaN, y: 0, width: 24, height: 24 }) === null, 'validTrayBounds');
  ok(validDisplayArea({ bounds: B, workArea: { x: 0, y: 0, width: 4000, height: 10 } }) === null, 'a work area outside its display is refused');
  const bad = place({ trayBounds: { x: 1, y: 1, width: 24, height: 24 }, display: null, size: SIZE });
  eq(pick(bad, 'x', 'y', 'anchor'), { x: 0, y: 0, anchor: 'none' }, 'no usable display: origin, flagged, never NaN');
  const badSize = place({ trayBounds: { x: 1800, y: 1040, width: 24, height: 32 }, display: BOTTOM, size: { width: NaN, height: -4 } });
  eq(pick(badSize, 'width', 'height'), { width: 360, height: 560 }, 'junk size falls back to the default');
  const huge = place({ trayBounds: { x: 1800, y: 1040, width: 24, height: 32 }, display: BOTTOM, size: { width: 1e9, height: 1e9 } });
  eq(pick(huge, 'width', 'height'), { width: 1904, height: 1016 }, 'a huge size is capped at work area minus margins');
  ok(inside(huge, BOTTOM.workArea), 'huge size: inside', huge);
}

console.log('\n§6 junk fuzz (seeded): never NaN, always integers, inside the work area');
{
  let s = 123456789;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const junk = [NaN, Infinity, -Infinity, 0, -1, 1e15, 1e300, -1e300, undefined, null, '5', {}, [], true];
  const num = (lo, hi) => Math.round(lo + rnd() * (hi - lo));
  const maybe = (v, p = 0.25) => (rnd() < p ? junk[Math.floor(rnd() * junk.length)] : v);
  let n = 0, checkedInside = 0, bad = 0;
  for (let i = 0; i < 6000; i++) {
    const bw = num(400, 4000), bh = num(300, 2400), bx = num(-4000, 4000), by = num(-2000, 2000);
    const wx = bx + num(0, 80), wy = by + num(0, 80);
    const ww = Math.max(1, bw - (wx - bx) - num(0, 80)), wh = Math.max(1, bh - (wy - by) - num(0, 80));
    const dispOk = { bounds: { x: bx, y: by, width: bw, height: bh }, workArea: { x: wx, y: wy, width: ww, height: wh } };
    const display = rnd() < 0.15 ? maybe(dispOk, 1) : dispOk;
    const input = rnd() < 0.05 ? maybe(null, 1) : {
      trayBounds: rnd() < 0.1 ? maybe(null, 1) : { x: maybe(num(bx - 200, bx + bw + 200)), y: maybe(num(by - 200, by + bh + 200)), width: maybe(num(0, 64)), height: maybe(num(0, 64)) },
      display,
      size: { width: maybe(num(100, 900)), height: maybe(num(100, 1400)) },
      cursor: rnd() < 0.5 ? { x: maybe(num(bx, bx + bw)), y: maybe(num(by, by + bh)) } : maybe(null, 1),
      scaleFactor: maybe(1 + rnd() * 2),
    };
    let r;
    try { r = place(input); } catch (e) { bad++; console.log('  threw', e.message, JSON.stringify(input)); continue; }
    n++;
    const nums = [r.x, r.y, r.width, r.height];
    if (!nums.every(Number.isInteger) || !(r.width >= 1 && r.height >= 1)) { bad++; console.log('  non-integer/NaN', JSON.stringify([input, r])); continue; }
    if (!['top', 'bottom', 'left', 'right'].includes(r.edge) || !['tray', 'cursor', 'corner', 'none'].includes(r.anchor)) { bad++; continue; }
    const v = validDisplayArea(input && input.display);
    if (v && r.anchor !== 'none' && v.workArea.width >= 40 && v.workArea.height >= 40) {
      checkedInside++;
      if (!inside(r, v.workArea)) { bad++; console.log('  outside', JSON.stringify([input, r])); }
    }
  }
  ok(bad === 0, `${n} junk inputs: no throw, no NaN, integers, edge/anchor valid`, bad);
  ok(checkedInside > 3000, `${checkedInside} of them checked inside the work area (not vacuous)`, checkedInside);
}

console.log('\n============================================================');
console.log(`Passed: ${passed}   Failed: ${failed}`);
console.log('============================================================');
process.exit(failed ? 1 : 0);
