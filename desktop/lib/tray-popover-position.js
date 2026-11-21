/**
 * Where the Windows tray popover goes. PURE: plain objects in, plain object out.
 * No Electron import, so an offline suite can execute every case.
 *
 * Adapted from AgentLink's popover-position (the owner's own), Windows only.
 *
 * Inputs (all in DIPs, as Electron's Tray.getBounds() and Display report them):
 *   trayBounds  the icon's rectangle, or anything (null, NaN, zero) when unknown
 *   display     { bounds, workArea } of the display that holds the icon
 *   size        { width, height } the popover wants
 *   cursor      optional { x, y }: used when the icon's bounds are unusable
 *   scaleFactor the display's scale factor (sanitised, echoed back; it also
 *               bounds what counts as an icon: an icon is never wider than
 *               MAX_ICON_DIP)
 *
 * The taskbar's edge is where the icon sits OUTSIDE the work area (the taskbar
 * is what the work area excludes). An icon INSIDE the work area (the "^"
 * overflow flyout, an auto-hiding taskbar whose work area equals the display)
 * takes the display edge nearest to it.
 *
 * Anchor order: the icon, then the cursor (when it is on this display), then
 * the work-area corner by the clock (bottom right). The result is clamped into
 * the work area: POPOVER_MARGIN on the sides away from the taskbar, only
 * POPOVER_GAP on the taskbar's side. A work area smaller than the popover
 * shrinks it. The result is never NaN, and all four numbers are integers.
 */

/** Space between the icon (or the taskbar) and the popover. */
export const POPOVER_GAP = 6;
/** Space kept between the popover and the work area's other edges. */
export const POPOVER_MARGIN = 8;
/** Used when the caller's size is unusable. */
export const DEFAULT_SIZE = Object.freeze({ width: 360, height: 560 });
/** A tray icon is never larger than this many DIPs. */
export const MAX_ICON_DIP = 512;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

function rectOf(r, { allowZero = false } = {}) {
  if (typeof r !== 'object' || r === null) return null;
  const { x, y, width, height } = r;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) return null;
  if (allowZero ? (width < 0 || height < 0) : (width <= 0 || height <= 0)) return null;
  return { x, y, width, height };
}

/** The tray bounds when they describe a real icon; else null. */
export function validTrayBounds(bounds) {
  const r = rectOf(bounds);
  if (!r || r.width > MAX_ICON_DIP || r.height > MAX_ICON_DIP) return null;
  return r;
}

/** The display when bounds and workArea are finite, non-empty, workArea inside bounds; else null. */
export function validDisplayArea(display) {
  if (typeof display !== 'object' || display === null) return null;
  const b = rectOf(display.bounds);
  const wa = rectOf(display.workArea);
  if (!b || !wa) return null;
  if (wa.x < b.x || wa.y < b.y) return null;
  if (wa.x + wa.width > b.x + b.width || wa.y + wa.height > b.y + b.height) return null;
  return { bounds: b, workArea: wa };
}

const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

const intersects = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

const pointIn = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

/** Which edge the taskbar is on, as seen from the anchor rectangle. */
export function taskbarEdge(anchor, display) {
  const c = center(anchor);
  const wa = display.workArea;
  if (c.y < wa.y) return 'top';
  if (c.y >= wa.y + wa.height) return 'bottom';
  if (c.x < wa.x) return 'left';
  if (c.x >= wa.x + wa.width) return 'right';
  const b = display.bounds;
  // Inside the work area: the nearest display edge. Ties prefer bottom, top, right, left.
  const candidates = [
    ['bottom', b.y + b.height - c.y],
    ['top', c.y - b.y],
    ['right', b.x + b.width - c.x],
    ['left', c.x - b.x],
  ];
  let best = candidates[0];
  for (const entry of candidates) if (entry[1] < best[1]) best = entry;
  return best[0];
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

function sanitiseSize(size) {
  const w = size && finite(size.width) && size.width > 0 ? size.width : DEFAULT_SIZE.width;
  const h = size && finite(size.height) && size.height > 0 ? size.height : DEFAULT_SIZE.height;
  return { width: w, height: h };
}

/**
 * @param {{trayBounds?: object|null, display: {bounds: object, workArea: object},
 *          size: {width: number, height: number}, cursor?: {x: number, y: number}|null,
 *          scaleFactor?: number}} input
 * @returns {{x: number, y: number, width: number, height: number,
 *            edge: 'top'|'bottom'|'left'|'right',
 *            anchor: 'tray'|'cursor'|'corner'|'none', scaleFactor: number}}
 *   integers inside the display's work area (anchor 'none' only when the display itself is
 *   unusable: then {x:0, y:0} at the sanitised size, still never NaN).
 */
export function computePopoverPosition(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const scaleFactor = finite(inp.scaleFactor) && inp.scaleFactor > 0 && inp.scaleFactor <= 16
    ? inp.scaleFactor : 1;
  const size = sanitiseSize(inp.size);
  const display = validDisplayArea(inp.display);
  if (!display) {
    return {
      x: 0, y: 0, width: Math.round(size.width), height: Math.round(size.height),
      edge: 'bottom', anchor: 'none', scaleFactor,
    };
  }
  const wa = display.workArea;
  const width = Math.max(1, Math.min(size.width, wa.width - 2 * POPOVER_MARGIN));
  const height = Math.max(1, Math.min(size.height, wa.height - 2 * POPOVER_MARGIN));
  let minX = wa.x + POPOVER_MARGIN;
  let minY = wa.y + POPOVER_MARGIN;
  let maxX = wa.x + wa.width - POPOVER_MARGIN - width;
  let maxY = wa.y + wa.height - POPOVER_MARGIN - height;

  // The anchor: the icon, else the cursor, else the corner.
  let anchorRect = null;
  let anchorKind = 'corner';
  const tray = validTrayBounds(inp.trayBounds);
  if (tray && intersects(tray, display.bounds)) {
    anchorRect = tray;
    anchorKind = 'tray';
  } else if (inp.cursor && finite(inp.cursor.x) && finite(inp.cursor.y)
    && pointIn(inp.cursor, display.bounds)) {
    anchorRect = { x: inp.cursor.x, y: inp.cursor.y, width: 0, height: 0 };
    anchorKind = 'cursor';
  }

  let x;
  let y;
  let edge;
  if (!anchorRect) {
    edge = 'bottom';
    x = maxX;
    y = maxY;
  } else {
    const c = center(anchorRect);
    edge = taskbarEdge(anchorRect, display);
    // On the taskbar's side only the gap separates the popover from it, not the margin.
    switch (edge) {
      case 'top':
        x = c.x - width / 2;
        y = Math.max(anchorRect.y + anchorRect.height, wa.y) + POPOVER_GAP;
        minY = Math.min(minY, wa.y + POPOVER_GAP);
        break;
      case 'bottom':
        x = c.x - width / 2;
        y = Math.min(anchorRect.y, wa.y + wa.height) - POPOVER_GAP - height;
        maxY = Math.max(maxY, wa.y + wa.height - POPOVER_GAP - height);
        break;
      case 'left':
        x = Math.max(anchorRect.x + anchorRect.width, wa.x) + POPOVER_GAP;
        y = c.y - height / 2;
        minX = Math.min(minX, wa.x + POPOVER_GAP);
        break;
      default: // right
        x = Math.min(anchorRect.x, wa.x + wa.width) - POPOVER_GAP - width;
        y = c.y - height / 2;
        maxX = Math.max(maxX, wa.x + wa.width - POPOVER_GAP - width);
        break;
    }
  }

  // Round the size DOWN and the origin so the integer rectangle stays inside the work area.
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const rx = Math.round(clamp(x, minX, maxX));
  const ry = Math.round(clamp(y, minY, maxY));
  const waRight = wa.x + wa.width;
  const waBottom = wa.y + wa.height;
  return {
    x: Math.max(Math.ceil(wa.x), Math.min(rx, Math.floor(waRight) - w)),
    y: Math.max(Math.ceil(wa.y), Math.min(ry, Math.floor(waBottom) - h)),
    width: w,
    height: h,
    edge,
    anchor: anchorKind,
    scaleFactor,
  };
}
