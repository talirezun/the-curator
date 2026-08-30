/**
 * Minimal PNG decoder — node:zlib only, NO dependency.
 *
 * WHY: the contrast probe reads colours out of the CSSOM and composites them
 * itself. That is a MODEL of what the browser painted, and this repo has
 * shipped two contrast helpers whose model was wrong while looking right
 * (2.34 reported for an element genuinely at 7.26; a badge read at 1.90 that
 * is 13.81 once its translucent tint is composited).
 *
 * A model needs a ground truth to be checked against. `Page.captureScreenshot`
 * with a 1x1 clip returns the pixel Chrome ACTUALLY PAINTED at a point — after
 * every layer, alpha, gradient, filter and blend mode. Decoding a PNG needs
 * inflate, and Node ships inflate. So the harness can compare its composited
 * model against real paint, and report the disagreement instead of trusting
 * itself.
 *
 * SCOPE: 8-bit, non-interlaced, colour type 0/2/4/6. Chrome's screenshots are
 * type 2 or 6. Anything else throws rather than guessing.
 */

import zlib from 'zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };   // grey, rgb, grey+a, rgba

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * @param {Buffer} buf a complete PNG file
 * @returns {{width:number, height:number, channels:number, data:Buffer}}
 *          `data` is raw, un-filtered samples, row-major, `channels` per pixel.
 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error('not a PNG (bad signature)');
  }
  let off = 8;
  let ihdr = null;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;                              // len + type + data + crc

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`PNG bit depth ${ihdr.bitDepth} unsupported (need 8)`);
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG unsupported');
  const ch = CHANNELS[ihdr.colorType];
  if (!ch) throw new Error(`PNG colour type ${ihdr.colorType} unsupported`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * ch;
  const out = Buffer.alloc(stride * height);

  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const rowIn = raw.subarray(p, p + stride);
    p += stride;
    const rowOut = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? rowOut[x - ch] : 0;       // left
      const b = prev ? prev[x] : 0;                 // up
      const c = (prev && x >= ch) ? prev[x - ch] : 0; // up-left
      const v = rowIn[x];
      let val;
      switch (filter) {
        case 0: val = v; break;
        case 1: val = v + a; break;
        case 2: val = v + b; break;
        case 3: val = v + ((a + b) >> 1); break;
        case 4: val = v + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      rowOut[x] = val & 0xff;
    }
  }

  return { width, height, channels: ch, data: out };
}

/** Read one pixel as [r,g,b,a] with a in 0..1. */
export function pixelAt(img, x = 0, y = 0) {
  const { channels: ch, width, data } = img;
  const i = (y * width + x) * ch;
  if (ch === 1) return [data[i], data[i], data[i], 1];
  if (ch === 2) return [data[i], data[i], data[i], data[i + 1] / 255];
  if (ch === 3) return [data[i], data[i + 1], data[i + 2], 1];
  return [data[i], data[i + 1], data[i + 2], data[i + 3] / 255];
}
