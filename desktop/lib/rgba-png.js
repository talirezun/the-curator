/**
 * An 8-bit RGBA PNG encoder, for menu-item artwork that is NOT a template
 * image.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY THIS FILE EXISTS AT ALL — A CONSTRAINT THAT TURNED OUT TO BE WRONG   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * `lib/tray-icon.js` emits GREYSCALE+ALPHA and pins every grey value at 0,
 * because the TRAY GLYPH is a template image: macOS takes only its alpha and
 * tints it for the current menu bar. That reasoning is correct, it still holds
 * for the glyph, and nothing here changes it.
 *
 * It was then carried over to MENU ITEM ICONS, and there it is false. A menu
 * item's `icon` is drawn by AppKit as an ordinary image unless the caller marks
 * it as a template; a full-colour RGBA icon in a menu item renders in colour.
 * The shipped v3.37.0 pulse strip was a template image sitting on a DISABLED
 * row, so macOS tinted it to the disabled-text colour, and the maintainer's
 * verdict was "barely visible, I don't know why it's in such a light colour".
 * That is the tint, not the drawing.
 *
 * So: the glyph stays greyscale+alpha and stays a template; menu-item artwork
 * is drawn HERE, in colour, and the consumer must NOT call
 * `setTemplateImage(true)` on it. Every spec this folder returns for menu
 * artwork carries `template: false` so the consumer never has to remember.
 *
 * ── GENERATED, NOT CHECKED IN ───────────────────────────────────────────────
 *
 * Same philosophy as `tray-icon.js`, quoted rather than paraphrased: "A
 * checked-in binary is unreviewable and unassertable: a suite can say a file
 * exists and hash it, and nothing more. Generated from a description, the glyph
 * becomes ordinary code — the offline suite EXECUTES this module, decodes the
 * bytes back with the same zlib the encoder used, and asserts the actual pixel
 * coverage."
 *
 * That is the whole reason `scripts/test-tray-paint.js` can say a colour is at
 * 4.29:1 against the menu background rather than that a constant was typed.
 *
 * ── THE DUPLICATED CRC32 AND CHUNK WRITER ───────────────────────────────────
 *
 * `crc32()` and `chunk()` below are a LITERAL COPY of the ones in
 * `lib/tray-icon.js`, which does not export them. Exporting them there is a
 * one-line change to a file this work does not own, so it was not made; the
 * duplication is deliberate and is recorded here rather than hidden.
 *
 * It is bounded: both are pure functions of bytes, ~10 lines each, defined by
 * RFC 2083 and by the PNG specification's own CRC table, so there is no design
 * decision to drift. The suite pins them anyway — it decodes this encoder's
 * output with `scripts/visual/png.js`, an INDEPENDENT decoder written for the
 * contrast harness, so a mistake here cannot be agreed with by a test that
 * shares its author's misunderstanding.
 *
 * `PNG_SIGNATURE` is IMPORTED from `tray-icon.js` rather than re-declared,
 * because it is exported there and one copy of a magic number is better than
 * two. The suite asserts it against the eight bytes written out by hand from
 * the specification, so the check is against the standard and not against this
 * folder's opinion of it.
 */

import { deflateSync } from 'node:zlib';
import { PNG_SIGNATURE } from './tray-icon.js';

export { PNG_SIGNATURE };

/** Colour type 6 = truecolour with alpha. Four bytes per pixel, 8 bits each. */
export const COLOR_TYPE_RGBA = 6;

// ── PNG plumbing (see the header: a literal copy of tray-icon.js's) ─────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ── A canvas ────────────────────────────────────────────────────────────────

/**
 * An RGBA canvas. Fully transparent to start — a menu icon is a MARK on the
 * menu's own background, never a tile of colour, so "nothing drawn here" must
 * mean transparent rather than white or black.
 *
 * @param {number} width   pixels
 * @param {number} height  pixels
 */
export function createCanvas(width, height) {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  if (!w || !h) throw new Error('createCanvas: empty canvas');
  return { width: w, height: h, data: Buffer.alloc(w * h * 4, 0) };
}

/**
 * Paint one pixel with a straight (non-premultiplied) RGBA value.
 *
 * REPLACES rather than composites. Nothing this folder draws overlaps itself —
 * bars are disjoint columns and a dot is one shape — so a compositing rule here
 * would be an untested code path pretending to be a feature. A caller that
 * needs blending should say so and get a tested one.
 *
 * Out-of-range coordinates are IGNORED rather than throwing: a menu item whose
 * icon factory throws while the menu is being BUILT takes the whole menu with
 * it, and a clipped pixel is not worth that.
 *
 * @param {object} canvas
 * @param {number} x
 * @param {number} y
 * @param {[number,number,number]} rgb  0..255
 * @param {number} alpha 0..255
 */
export function paintPixel(canvas, x, y, rgb, alpha) {
  const px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return;
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  if (a === 0) return;
  const p = (py * canvas.width + px) * 4;
  canvas.data[p] = clamp255(rgb[0]);
  canvas.data[p + 1] = clamp255(rgb[1]);
  canvas.data[p + 2] = clamp255(rgb[2]);
  canvas.data[p + 3] = a;
}

/** An axis-aligned opaque rectangle, in whole pixels. */
export function fillRect(canvas, x, y, w, h, rgb) {
  for (let py = Math.floor(y); py < Math.floor(y) + Math.floor(h); py++) {
    for (let px = Math.floor(x); px < Math.floor(x) + Math.floor(w); px++) {
      paintPixel(canvas, px, py, rgb, 255);
    }
  }
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)));
}

/**
 * Supersampled coverage of a predicate over one pixel, 0..255.
 *
 * `SS = 4` means each output pixel is the mean of 16 samples — the same factor
 * and the same reasoning as `tray-icon.js`: enough to make a small circle read
 * as a circle rather than as a staircase, and cheap enough to be irrelevant at
 * a few hundred microseconds per menu open.
 */
const SS = 4;
export function coverage(px, py, test) {
  let hit = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      if (test(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hit++;
    }
  }
  return (hit / (SS * SS)) * 255;
}

/**
 * Paint an antialiased shape described by a predicate over the whole canvas.
 * Every covered pixel gets the SAME rgb and an alpha equal to its coverage, so
 * the interior is exactly the shipped colour and only the rim is softened.
 *
 * That distinction is load-bearing for the contrast argument: the suite asserts
 * the ratio of the INTERIOR pixels, which are opaque, so no compositing
 * assumption enters the measurement.
 */
export function paintShape(canvas, rgb, test) {
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const a = coverage(x, y, test);
      if (a > 0) paintPixel(canvas, x, y, rgb, a);
    }
  }
}

// ── Colour ──────────────────────────────────────────────────────────────────

/**
 * `#rrggbb` to an [r,g,b] triple.
 *
 * The palettes in this folder are written as hex because that is the form the
 * contrast measurements were taken in and the form they are quoted in, and a
 * palette whose source form differs from its audited form is a palette that can
 * drift from its own audit.
 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`hexToRgb: not a #rrggbb colour: ${String(hex)}`);
  }
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * THE MENU BACKGROUND, STATED AS AN ASSUMPTION.
 *
 * A coloured image does not adapt to light and dark the way a template image
 * does, so every colour in this folder has to be checked against the surface it
 * will actually be drawn on — and that surface has never been sampled here. No
 * menu has been rendered, no screenshot has been taken, and AppKit exposes no
 * way to ask offline.
 *
 * `#ECECEC` / `#2C2C2E` are the conventional figures for a macOS menu in the
 * two appearances and are USED AND ASSUMED, not measured.
 *
 * ── WHICH IS WHY THE FLOOR IS CHECKED OVER A BAND AND NOT A POINT ──────────
 *
 * A real NSMenu is a VIBRANCY material: it samples the desktop behind it, so
 * its effective background moves with the wallpaper. A palette audited against
 * one hex value would be audited against a background that does not exist. The
 * suite therefore requires every shipped colour to clear the floor at BOTH ENDS
 * of a plausible band as well as at the nominal value, and quotes the WORST of
 * the three. The band ends are themselves assumptions; what they buy is that a
 * colour sitting one shade above the floor at the nominal background cannot
 * pass.
 *
 * The hardest background in each band is the one CLOSEST to the ink: for a
 * light menu that is the darkest end, for a dark menu the lightest.
 */
export const MENU_BG = { light: '#ECECEC', dark: '#2C2C2E' };
export const MENU_BG_BAND = {
  light: ['#F6F6F6', '#ECECEC', '#DCDCDC'],
  dark: ['#1E1E1E', '#2C2C2E', '#3A3A3C'],
};

/**
 * The floor every mark in this folder must clear against its own background.
 *
 * 3:1 is WCAG 2.2 1.4.11 (non-text contrast), which is the correct floor for an
 * indicator — 4.5:1 is the floor for TEXT and applying it here would be citing
 * the wrong rule. It is a floor and not a target: most of what ships clears it
 * by a wide margin, and the two that sit near it are the deliberately quiet
 * marks, which is where the margin belongs.
 *
 * Naive system colours do NOT automatically pass. Apple's systemGreen
 * `#34C759` measures about 1.8:1 against white and is ruled out for a light
 * menu on that number alone; every value in this folder was chosen by
 * measurement afterwards.
 */
export const CONTRAST_FLOOR_NON_TEXT = 3.0;

// ── The encoder ─────────────────────────────────────────────────────────────

/**
 * Encode a canvas as an 8-bit RGBA PNG.
 *
 * Filter byte 0 (None) on every row, for the same reason `tray-icon.js` gives:
 * it keeps the decode side trivially assertable, so a suite reading the matrix
 * back has no filter arithmetic to get wrong in a way that happens to agree
 * with a broken encoder.
 *
 * @param {{width:number, height:number, data:Buffer}} canvas
 * @returns {Buffer}
 */
export function encodeRgbaPng(canvas) {
  const { width, height, data } = canvas || {};
  if (!width || !height || !Buffer.isBuffer(data) || data.length !== width * height * 4) {
    throw new Error('encodeRgbaPng: canvas is not width*height*4 bytes');
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                  // bit depth
  ihdr[9] = COLOR_TYPE_RGBA;    // colour type
  ihdr[10] = 0;                 // compression: deflate
  ihdr[11] = 0;                 // filter: adaptive
  ihdr[12] = 0;                 // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0;  // filter None
    data.copy(raw, y * (1 + stride) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
