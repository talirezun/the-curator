/**
 * The menubar glyph, generated rather than shipped.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  WHY A GENERATOR AND NOT A .png IN THE REPO                               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * A checked-in binary is unreviewable and unassertable: a suite can say a file
 * exists and hash it, and nothing more. Generated from a description, the glyph
 * becomes ordinary code — the offline suite EXECUTES this module, decodes the
 * bytes back with the same zlib the encoder used, and asserts the actual pixel
 * coverage. That is the difference between "a file is present" and "the live
 * state really does differ from the idle state, in the middle of the mark, and
 * every pixel of it is black with only alpha varying".
 *
 * It also costs nothing at runtime: two 18px and two 36px images, built once at
 * tray creation, a few hundred microseconds.
 *
 * ── IT IS A TEMPLATE IMAGE, WHICH IS A HARD CONSTRAINT ─────────────────────
 *
 * macOS renders a template image by taking ONLY its alpha channel and tinting
 * it for the current menu bar — light, dark, tinted wallpaper, and the inverted
 * state while the menu is open. That is the only thing guaranteed to look right
 * everywhere, and it is why this encoder emits 8-bit GREYSCALE+ALPHA with every
 * grey value pinned at 0. A coloured glyph would render as a coloured smear on
 * half of those backgrounds, and there is no way to carry colour in a template
 * image at all — Electron's own tray guidance says so, and the open Electron PR
 * that would allow a layered coloured dot has not landed.
 *
 * main.js must still call `image.setTemplateImage(true)`; the pixels being
 * correct is necessary and not sufficient. The suite asserts that call by
 * source scan and says so in its NOT ENFORCED block.
 *
 * ── THE ONE BIT THE GLYPH CARRIES ──────────────────────────────────────────
 *
 * A ring, always. A filled centre when an agent has written on THIS machine
 * within the live window. That is the whole vocabulary:
 *
 *   idle   ○   The Curator is running
 *   live   ●   an agent is writing right now
 *
 * Deliberately NOT a badge count (a count of what?) and deliberately NOT an
 * animation (an animated glyph in a menu bar is the thing people uninstall apps
 * over). The third candidate state — "unseen since you last looked" — is a real
 * idea and is left alone: it is an open question the maintainer owns, and
 * inventing an answer to it here would put a behaviour in the bar that nobody
 * asked for.
 *
 * The glyph is also a LOCAL instrument. It never reflects whether another
 * machine has pushed something, because that question needs the network and
 * putting it in the bar would mean a background network timer for one bit.
 */

import { deflateSync } from 'node:zlib';

/** Logical size in POINTS. 18pt is the conventional menu bar extra size; the
 *  bar itself is 22pt, so this leaves the standard breathing room above and
 *  below without the mark looking timid. */
export const ICON_POINTS = 18;

/** Supersampling factor for coverage. 4 means each output pixel is the mean of
 *  16 samples, which is enough to make an 18px circle read as a circle rather
 *  than as a staircase, and cheap enough to be irrelevant. */
const SS = 4;

// ── PNG encoding ────────────────────────────────────────────────────────────

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

/** PNG signature, as its own export so the suite can assert against the
 *  specification's bytes rather than against this module's own opinion. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** Colour type 4 = greyscale + alpha, 8 bits each. Two bytes per pixel. */
const COLOR_TYPE_GRAY_ALPHA = 4;

/**
 * Encode an alpha matrix as an 8-bit greyscale+alpha PNG with every grey value
 * at 0 — i.e. pure black shape, all information in alpha.
 *
 * @param {number[][]} alpha  rows of 0..255
 */
export function encodeAlphaPng(alpha) {
  const height = alpha.length;
  const width = height ? alpha[0].length : 0;
  if (!width || !height) throw new Error('encodeAlphaPng: empty matrix');

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                       // bit depth
  ihdr[9] = COLOR_TYPE_GRAY_ALPHA;   // colour type
  ihdr[10] = 0;                      // compression: deflate
  ihdr[11] = 0;                      // filter: adaptive
  ihdr[12] = 0;                      // interlace: none

  // One filter byte (0 = None) then two bytes per pixel. Filter None keeps the
  // decode side trivially assertable: the suite inflates and reads the matrix
  // straight back out, with no filter reconstruction to get wrong in the test
  // and therefore no way for the test to agree with a broken encoder.
  const raw = Buffer.alloc(height * (1 + width * 2));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      raw[p++] = 0;                                  // grey: black
      raw[p++] = Math.max(0, Math.min(255, Math.round(alpha[y][x])));
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── The mark ────────────────────────────────────────────────────────────────

function coverage(px, py, size, test) {
  let hit = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const x = px + (sx + 0.5) / SS;
      const y = py + (sy + 0.5) / SS;
      if (test(x, y, size)) hit++;
    }
  }
  return (hit / (SS * SS)) * 255;
}

/**
 * The alpha matrix for one state at one pixel size.
 *
 * Everything is expressed as a FRACTION of the canvas so the 1x and 2x
 * representations are the same drawing at two resolutions rather than two
 * drawings that happen to look similar — which is the failure mode that makes
 * a retina icon subtly not match its own low-resolution twin.
 *
 * @param {number} size    pixels
 * @param {'idle'|'live'} state
 */
export function glyphMatrix(size, state) {
  const c = size / 2;
  const outer = size * 0.42;          // ring outer radius
  const inner = size * 0.42 - size * 0.115;  // ring inner radius (thickness ~11.5%)
  const dot = size * 0.19;            // filled centre, live only
  const filled = state === 'live';

  const test = (x, y) => {
    const dx = x - c, dy = y - c;
    const r2 = dx * dx + dy * dy;
    if (r2 <= outer * outer && r2 >= inner * inner) return true;   // the ring
    if (filled && r2 <= dot * dot) return true;                    // the centre
    return false;
  };

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push(coverage(x, y, size, test));
    rows.push(row);
  }
  return rows;
}

/**
 * Both scale representations of one glyph state.
 *
 * TWO representations, not one: a 1x-only image is soft on every Mac sold in
 * the last decade, and a 2x-only image handed to a 1x display is downsampled by
 * the OS rather than drawn. main.js builds the nativeImage from `scale1` and
 * adds `scale2` as a second representation.
 *
 * @returns {{points:number, scale1:Buffer, scale2:Buffer}}
 */
export function trayIconPngs(state) {
  const s = state === 'live' ? 'live' : 'idle';
  return {
    points: ICON_POINTS,
    state: s,
    scale1: encodeAlphaPng(glyphMatrix(ICON_POINTS, s)),
    scale2: encodeAlphaPng(glyphMatrix(ICON_POINTS * 2, s)),
  };
}
