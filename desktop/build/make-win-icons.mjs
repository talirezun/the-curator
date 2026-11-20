#!/usr/bin/env node
/**
 * make-win-icons.mjs — the Windows app's icons, generated from the Mac icon.
 *
 *     node desktop/build/make-win-icons.mjs           # write the four files
 *     node desktop/build/make-win-icons.mjs --check   # exit 1 if they drifted
 *
 * Writes, next to this file:
 *   icon.ico     the app icon: exe, installer, uninstaller, shortcuts, taskbar
 *                (16, 20, 24, 32, 40, 48, 64, 128, 256 px)
 *   tray.ico     the notification-area (tray) icon, in colour — Windows has no
 *                template images (16, 20, 24, 32, 40, 48 px: 100% to 300% scaling)
 *   tray.png     16 px, and
 *   tray@2x.png  32 px, for nativeImage, which picks the @2x file on a 200% screen
 *
 * Source: the largest image in images/applet.icns (the 1024 px PNG), the same
 * source scripts/windows/make-icons.py uses for the browser install's shortcuts,
 * so both installs look the same on one PC. The Mac grid's transparent margin is
 * cropped away (Windows icons fill their square), then each size is drawn by
 * AREA AVERAGING on premultiplied alpha — no ringing, no dependency, and the same
 * bytes on every machine. Same inset rule as make-icons.py: none up to 32 px,
 * then 2% a side.
 *
 * Entries up to 128 px are 32-bit BMP (with the 1-bit mask), 256 px is PNG: the
 * layout every Windows icon consumer reads, NSIS's installer icon included.
 *
 * Node builtins plus desktop/lib/rgba-png.js only. The offline suite
 * (scripts/test-desktop-win-build.js) re-runs this in memory and compares every
 * pixel with the committed files.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

import { encodeRgbaPng } from '../lib/rgba-png.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ICNS_PATH = path.resolve(HERE, '..', '..', 'images', 'applet.icns');

export const APP_ICON_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 128, 256]);
export const TRAY_ICON_SIZES = Object.freeze([16, 20, 24, 32, 40, 48]);
export const OUTPUTS = Object.freeze({
  'icon.ico': { kind: 'ico', sizes: APP_ICON_SIZES },
  'tray.ico': { kind: 'ico', sizes: TRAY_ICON_SIZES },
  'tray.png': { kind: 'png', size: 16 },
  'tray@2x.png': { kind: 'png', size: 32 },
});
/** Alpha above which a pixel counts as the tile (crops the Mac margin and shadow). */
export const TILE_ALPHA = 200;

// ── Decoding the source ─────────────────────────────────────────────────────

export function parseIcns(buf) {
  if (buf.toString('latin1', 0, 4) !== 'icns') throw new Error('not an icns file');
  const chunks = new Map();
  let p = 8;
  while (p + 8 <= buf.length) {
    const type = buf.toString('latin1', p, p + 4);
    const len = buf.readUInt32BE(p + 4);
    if (len < 8 || p + len > buf.length) throw new Error(`damaged icns chunk ${type}`);
    chunks.set(type, buf.subarray(p + 8, p + len));
    p += len;
  }
  return chunks;
}

/** Decode an 8-bit RGBA or RGB, non-interlaced PNG to {width, height, data(RGBA)}. */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  let p = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (ctype !== 6 && ctype !== 2) || interlace !== 0) {
    throw new Error(`unsupported PNG (depth ${depth}, colour type ${ctype}, interlace ${interlace})`);
  }
  const bpp = ctype === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? px[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (f !== 0) throw new Error(`bad PNG filter ${f}`);
      px[y * stride + x] = v & 0xFF;
    }
  }
  if (bpp === 4) return { width, height, data: px };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = px[i * 3]; rgba[i * 4 + 1] = px[i * 3 + 1]; rgba[i * 4 + 2] = px[i * 3 + 2]; rgba[i * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

/** The largest PNG entry of an icns (ic10 = 1024 px when present). */
export function largestIcnsImage(icnsBuf) {
  let best = null;
  for (const [type, data] of parseIcns(icnsBuf)) {
    if (data.length < 8 || data.readUInt32BE(0) !== 0x89504E47) continue;
    const img = decodePng(data);
    if (!best || img.width > best.width) best = { ...img, type };
  }
  if (!best) throw new Error('the icns holds no PNG image');
  return best;
}

// ── Geometry ────────────────────────────────────────────────────────────────

/** Crop to the bounding box of pixels whose alpha exceeds `threshold`. */
export function cropToAlpha(img, threshold = TILE_ALPHA) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('nothing above the alpha threshold');
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(out, y * w * 4, ((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x1 + 1) * 4);
  return { width: w, height: h, data: out, box: [x0, y0, x1, y1] };
}

/**
 * Area-average resample (a box filter with fractional coverage), on
 * premultiplied alpha so transparent pixels never darken an edge.
 */
export function resampleArea(img, dw, dh) {
  const sx = img.width / dw, sy = img.height / dh;
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy0 = y * sy, fy1 = (y + 1) * sy;
    for (let x = 0; x < dw; x++) {
      const fx0 = x * sx, fx1 = (x + 1) * sx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
        const wy = Math.min(fy1, yy + 1) - Math.max(fy0, yy);
        if (wy <= 0) continue;
        for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
          const wx = Math.min(fx1, xx + 1) - Math.max(fx0, xx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (yy * img.width + xx) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al * w; g += img.data[i + 1] * al * w; b += img.data[i + 2] * al * w;
          a += al * w; wsum += w;
        }
      }
      const o = (y * dw + x) * 4;
      const alpha = a / wsum;
      out[o + 3] = Math.round(alpha * 255);
      if (a > 0) {
        out[o] = Math.min(255, Math.round(r / a));
        out[o + 1] = Math.min(255, Math.round(g / a));
        out[o + 2] = Math.min(255, Math.round(b / a));
      }
      if (out[o + 3] === 0) { out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; }
    }
  }
  return { width: dw, height: dh, data: out };
}

/** Same inset rule as scripts/windows/make-icons.py. */
export function insetFor(px) {
  return px <= 32 ? 0 : Math.max(1, Math.round(px * 0.02));
}

/** One square frame of `px` pixels from the cropped tile. */
export function renderFrame(tile, px) {
  const inset = insetFor(px);
  const inner = resampleArea(tile, px - 2 * inset, px - 2 * inset);
  const out = { width: px, height: px, data: Buffer.alloc(px * px * 4) };
  for (let y = 0; y < inner.height; y++) {
    inner.data.copy(out.data, ((y + inset) * px + inset) * 4, y * inner.width * 4, (y + 1) * inner.width * 4);
  }
  return out;
}

// ── Encoding ────────────────────────────────────────────────────────────────

/** A 32-bit BMP icon entry: BITMAPINFOHEADER, BGRA bottom-up, then the AND mask. */
export function encodeBmpEntry(frame) {
  const { width: w, height: h, data } = frame;
  const maskStride = Math.ceil(w / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(w * h * 4 + maskStride * h, 20);
  const pixels = Buffer.alloc(w * h * 4);
  const mask = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = (row * w + x) * 4;
      pixels[d] = data[s + 2]; pixels[d + 1] = data[s + 1]; pixels[d + 2] = data[s]; pixels[d + 3] = data[s + 3];
      if (data[s + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

/** An .ico from frames; 256 px entries are PNG, smaller ones BMP. */
export function encodeIco(frames) {
  const dir = Buffer.alloc(6 + 16 * frames.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(frames.length, 4);
  const blobs = frames.map((f) => (f.width >= 256 ? encodeRgbaPng(f) : encodeBmpEntry(f)));
  let offset = dir.length;
  frames.forEach((f, i) => {
    const e = 6 + i * 16;
    dir[e] = f.width >= 256 ? 0 : f.width;
    dir[e + 1] = f.height >= 256 ? 0 : f.height;
    dir[e + 2] = 0; dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(blobs[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += blobs[i].length;
  });
  return Buffer.concat([dir, ...blobs]);
}

// ── The job ─────────────────────────────────────────────────────────────────

/** Build every output in memory: {name: {bytes, frames: Map(size → frame)}}. */
export function buildIcons(icnsBuf = readFileSync(ICNS_PATH)) {
  const tile = cropToAlpha(largestIcnsImage(icnsBuf));
  const cache = new Map();
  const frame = (px) => { if (!cache.has(px)) cache.set(px, renderFrame(tile, px)); return cache.get(px); };
  const out = {};
  for (const [name, spec] of Object.entries(OUTPUTS)) {
    if (spec.kind === 'ico') {
      const frames = spec.sizes.map(frame);
      out[name] = { bytes: encodeIco(frames), frames: new Map(spec.sizes.map((s) => [s, frame(s)])) };
    } else {
      const f = frame(spec.size);
      out[name] = { bytes: encodeRgbaPng(f), frames: new Map([[spec.size, f]]) };
    }
  }
  return { tile, outputs: out };
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const check = process.argv.includes('--check');
  const { outputs } = buildIcons();
  let drift = 0;
  for (const [name, { bytes }] of Object.entries(outputs)) {
    const target = path.join(HERE, name);
    if (check) {
      let cur = null;
      try { cur = readFileSync(target); } catch { /* missing */ }
      if (!cur || !cur.equals(bytes)) { drift++; console.log(`  ✗ ${name} differs from what the generator makes`); }
      else console.log(`  ✓ ${name}`);
    } else {
      writeFileSync(target, bytes);
      console.log(`  wrote ${name} (${bytes.length} bytes)`);
    }
  }
  if (drift) process.exit(1);
}
