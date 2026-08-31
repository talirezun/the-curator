/**
 * test-app-icon-geometry.js — OFFLINE suite that guards the macOS app icon's
 * alpha channel and its Apple-grid margin on the COMMITTED images/applet.icns.
 *
 * ── THE TWO REGRESSIONS THIS EXISTS TO CATCH ──────────────────────────────
 *
 * 1. NO ALPHA. The icns once shipped every large entry as PNG colour type 2
 *    (RGB, no alpha channel), so macOS composited an opaque WHITE square
 *    behind the icon in the Dock, Finder and Spotlight. Fixed in v3.30.0's
 *    line (commit 81fd1ec). Nothing guarded it.
 *
 * 2. FULL BLEED. The brand's app-icon tiles are drawn edge to edge, which is
 *    correct for a favicon and for iOS and WRONG for a macOS .app icon: Apple
 *    insets the rounded-rect body inside a transparent margin, so a full-bleed
 *    icon renders visibly LARGER than every neighbouring app. Reported by the
 *    maintainer as the icon having "a wide background", and confirmed by
 *    measurement — the committed 512 entry's opaque content reached all four
 *    canvas edges. Fixed by `scripts/rebuild-app-icon.py`'s grid placement.
 *
 * Both are silent: the app builds, launches and works. Only looking at the
 * Dock reveals them. Hence a guard on the shipped BINARY rather than on the
 * script that produces it — the artefact is what users see, and it is
 * committed, so it can drift from the script without anyone noticing.
 *
 * ── THE GRID ──────────────────────────────────────────────────────────────
 *
 * Margins below are MEASURED, not spec-quoted — the alpha>50% bounding box of
 * real macOS application icons on a real machine. GarageBand.app carries
 * Apple's own complete ten-entry ladder and produced every row; Notes, Mail,
 * Maps, Reminders, Finder, Podcasts and System Settings corroborate the rows
 * they carry; Brave Browser reproduces the whole ladder. The reasoning and the
 * full source list live in `scripts/rebuild-app-icon.py`'s docstring, which is
 * this table's owner — if you change one, change both.
 *
 * Note the ladder is deliberately NOT a constant ratio: Apple relaxes the
 * margin at 16 and 32 physical px (87.5% body vs 80.47%), the same
 * small-size legibility concession as this project's coarse-cut rule.
 *
 * ── WHY THE ASSERTION IS EXACT AND NOT A TOLERANCE ────────────────────────
 *
 * `place_on_grid` composites the resized tile onto a fully transparent canvas,
 * so nothing can bleed outside the body — measured, the any-alpha bbox and the
 * >50% bbox are IDENTICAL on all ten entries. A tolerance would be slack the
 * defect could hide in: at the 16px entry the margin is 1px, so a ±1px
 * tolerance would accept full bleed outright.
 *
 * Section 0 is a self-test battery: the decoders and the inset measurement are
 * run against synthetic images with known answers, including a synthetic
 * FULL-BLEED plane that MUST be rejected. Without it a broken decoder that
 * returned an all-transparent alpha plane would make every real assertion pass
 * vacuously.
 *
 * Dependency-free: node: builtins only (zlib for PNG IDAT inflation).
 * OFFLINE — reads one committed file, no network, no API key, no spend.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICNS_PATH = path.join(__dirname, '..', 'images', 'applet.icns');

// icns chunk type -> the entry's PHYSICAL pixel size. These ten are what
// `iconutil -c icns` emits from the ten-file iconset the rebuild script
// writes. `ic04`/`ic05` are raw ARGB (the 16 and 32 1x entries); the rest are
// PNG. `info`, `TOC ` and any future metadata chunk is not an image and is
// skipped by name, never by "does it start with a PNG signature" — a silent
// skip is how a missing entry would pass.
const IMAGE_CHUNKS = {
  ic04: { px: 16, format: 'argb' },
  ic05: { px: 32, format: 'argb' },
  ic11: { px: 32, format: 'png' },   // icon_16x16@2x
  ic12: { px: 64, format: 'png' },   // icon_32x32@2x
  ic07: { px: 128, format: 'png' },  // icon_128x128
  ic13: { px: 256, format: 'png' },  // icon_128x128@2x
  ic08: { px: 256, format: 'png' },  // icon_256x256
  ic14: { px: 512, format: 'png' },  // icon_256x256@2x
  ic09: { px: 512, format: 'png' },  // icon_512x512
  ic10: { px: 1024, format: 'png' }, // icon_512x512@2x
};

const NON_IMAGE_CHUNKS = new Set(['TOC ', 'info', 'name', 'icnV']);

// physical px -> transparent margin in px. See header.
const GRID_MARGIN_PX = {
  16: 1,
  32: 2,
  64: 6,
  128: 12,
  256: 25,
  512: 50,
  1024: 100,
};

// "Opaque content" threshold. 127 = above 50% alpha.
const ALPHA_THRESHOLD = 127;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// ── decoders ──────────────────────────────────────────────────────────────

/** Parse the icns container into [{type, data}] in file order. */
function parseIcns(buf) {
  if (buf.length < 8) throw new Error('file too short to be an icns');
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'icns') throw new Error(`bad magic ${JSON.stringify(magic)}, expected "icns"`);
  const declared = buf.readUInt32BE(4);
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const type = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    if (len < 8 || off + len > buf.length) {
      throw new Error(`chunk ${type} at ${off} declares length ${len}, which overruns the file`);
    }
    chunks.push({ type, data: buf.subarray(off + 8, off + len) });
    off += len;
  }
  return { declared, chunks };
}

/**
 * Decode a non-interlaced 8-bit RGBA PNG to {width, height, colourType, alpha}
 * where `alpha` is a Uint8Array of width*height. Throws on anything else —
 * an icns entry that is not 8-bit RGBA is itself the alpha-channel regression.
 */
function decodePng(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG (bad signature)');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colourType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // len + type(4) + data + crc(4)
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`PNG bit depth ${ihdr.bitDepth}, expected 8`);
  if (ihdr.colourType !== 6) {
    throw new Error(`PNG colour type ${ihdr.colourType}, expected 6 (RGBA). ` +
      `Type 2 is RGB with NO alpha — the white-box regression.`);
  }
  if (ihdr.interlace !== 0) throw new Error(`PNG is interlaced (${ihdr.interlace})`);
  if (!idat.length) throw new Error('PNG has no IDAT');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const bpp = 4;
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) {
    throw new Error(`PNG IDAT inflated to ${raw.length} bytes, expected >= ${h * (stride + 1)}`);
  }

  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[rp++];
    const line = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;      // left
      const b = prev ? prev[i] : 0;                // up
      const c = (prev && i >= bpp) ? prev[i - bpp] : 0; // upper-left
      let v;
      switch (ft) {
        case 0: v = line[i]; break;
        case 1: v = line[i] + a; break;
        case 2: v = line[i] + b; break;
        case 3: v = line[i] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = line[i] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
          break;
        }
        default: throw new Error(`unknown PNG filter type ${ft} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
  }

  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = out[i * 4 + 3];
  return { width: w, height: h, colourType: ihdr.colourType, alpha };
}

/** icns PackBits-style RLE used by the ARGB entries. */
function icnsRleDecode(buf, start, expected) {
  const out = Buffer.alloc(expected);
  let i = start, o = 0;
  while (o < expected && i < buf.length) {
    const c = buf[i++];
    if (c & 0x80) {
      const run = (c & 0x7f) + 3;
      const v = buf[i++];
      for (let k = 0; k < run && o < expected; k++) out[o++] = v;
    } else {
      const run = c + 1;
      for (let k = 0; k < run && o < expected && i < buf.length; k++) out[o++] = buf[i++];
    }
  }
  if (o !== expected) throw new Error(`ARGB RLE produced ${o} bytes, expected ${expected}`);
  return { plane: out, next: i };
}

/**
 * Decode an icns `ARGB` chunk. Layout: the ascii magic "ARGB", then four
 * RLE-compressed planes in order A, R, G, B, each width*height bytes.
 * Only the A plane is needed here — the format carries alpha by definition,
 * which is why ic04/ic05 were never part of the colour-type-2 regression, but
 * they ARE part of the full-bleed one and must be measured.
 */
function decodeArgb(buf, px) {
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'ARGB') throw new Error(`ARGB chunk magic ${JSON.stringify(magic)}`);
  const { plane } = icnsRleDecode(buf, 4, px * px);
  return { width: px, height: px, alpha: new Uint8Array(plane) };
}

// ── measurement ───────────────────────────────────────────────────────────

/**
 * The inset, on each side, of content above `threshold` alpha. Returns null
 * for a fully-transparent plane — distinguished from inset 0 deliberately, so
 * a decoder that silently produced zeros cannot read as "content everywhere".
 */
function opaqueInset(alpha, w, h, threshold = ALPHA_THRESHOLD) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, right: w - 1 - maxX, bottom: h - 1 - maxY,
           bodyW: maxX - minX + 1, bodyH: maxY - minY + 1 };
}

/** True when every pixel strictly outside the `margin` ring is fully transparent. */
function marginRingIsClear(alpha, w, h, margin) {
  for (let y = 0; y < h; y++) {
    const inRowBand = y >= margin && y < h - margin;
    for (let x = 0; x < w; x++) {
      const inside = inRowBand && x >= margin && x < w - margin;
      if (!inside && alpha[y * w + x] !== 0) return false;
    }
  }
  return true;
}

// ── §0 self-tests: the measurement must be able to FAIL ───────────────────

console.log('\n§0 self-tests (the checker must reject what it claims to reject)');
{
  const W = 16;
  const fullBleed = new Uint8Array(W * W).fill(255);
  const ins = opaqueInset(fullBleed, W, W);
  ok(ins && ins.left === 0 && ins.top === 0 && ins.right === 0 && ins.bottom === 0,
    'synthetic FULL-BLEED plane measures inset 0 on all four sides (the defect is detectable)');
  ok(ins.left !== GRID_MARGIN_PX[16],
    'synthetic full-bleed plane does NOT satisfy the 16px grid margin (assertion is not vacuous)');
  ok(!marginRingIsClear(fullBleed, W, W, GRID_MARGIN_PX[16]),
    'synthetic full-bleed plane fails the clear-margin-ring check');

  const inset1 = new Uint8Array(W * W);
  for (let y = 1; y < W - 1; y++) for (let x = 1; x < W - 1; x++) inset1[y * W + x] = 255;
  const ins2 = opaqueInset(inset1, W, W);
  ok(ins2.left === 1 && ins2.top === 1 && ins2.right === 1 && ins2.bottom === 1 && ins2.bodyW === 14,
    'synthetic 1px-inset plane measures 1/1/1/1 with body 14 (the grid value for 16px)');
  ok(marginRingIsClear(inset1, W, W, 1), 'synthetic 1px-inset plane passes the clear-margin-ring check');

  ok(opaqueInset(new Uint8Array(W * W), W, W) === null,
    'fully transparent plane returns null, never a bogus inset (guards a dead decoder)');

  // A plane opaque everywhere EXCEPT a transparent border would pass a naive
  // "is there any transparency" test. The inset check is what separates them.
  const halfAlpha = new Uint8Array(W * W).fill(100); // below threshold everywhere
  ok(opaqueInset(halfAlpha, W, W) === null,
    'sub-threshold alpha counts as no opaque content (threshold is actually applied)');

  // Round-trip the PNG decoder against a PNG this suite builds itself, so a
  // broken unfilter cannot pass by agreeing with a broken expectation.
  const pw = 8, ph = 8;
  const rawRows = [];
  for (let y = 0; y < ph; y++) {
    const row = Buffer.alloc(1 + pw * 4);
    row[0] = y % 5; // exercise all five filter types
    for (let x = 0; x < pw; x++) {
      const px = Buffer.from([x * 7, y * 11, 3, (x === 0 || y === 0 || x === pw - 1 || y === ph - 1) ? 0 : 255]);
      px.copy(row, 1 + x * 4);
    }
    rawRows.push(row);
  }
  // Re-filter row-by-row to produce genuinely filtered data (filter 0 only is
  // a weaker test, so apply Sub/Up/Average/Paeth for real).
  const stride = pw * 4;
  const flat = Buffer.concat(rawRows.map(r => r.subarray(1)));
  const filtered = [];
  for (let y = 0; y < ph; y++) {
    const ft = y % 5;
    const cur = flat.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? flat.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const out = Buffer.alloc(1 + stride);
    out[0] = ft;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0;
      let v;
      if (ft === 0) v = cur[i];
      else if (ft === 1) v = cur[i] - a;
      else if (ft === 2) v = cur[i] - b;
      else if (ft === 3) v = cur[i] - ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
             v = cur[i] - (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)); }
      out[1 + i] = v & 0xff;
    }
    filtered.push(out);
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  }
  function crc32(b) {
    let c = ~0;
    for (let i = 0; i < b.length; i++) {
      c ^= b[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pw, 0); ihdr.writeUInt32BE(ph, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(filtered))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  let decoded = null, decodeErr = null;
  try { decoded = decodePng(png); } catch (e) { decodeErr = e; }
  ok(decoded && decoded.width === pw && decoded.height === ph,
    `PNG decoder round-trips a self-built 8x8 RGBA PNG${decodeErr ? ` (${decodeErr.message})` : ''}`);
  const selfIns = decoded && opaqueInset(decoded.alpha, pw, ph);
  ok(selfIns && selfIns.left === 1 && selfIns.top === 1 && selfIns.right === 1 && selfIns.bottom === 1,
    'decoded self-built PNG measures its known 1px transparent border (unfilter is correct across all 5 filter types)');

  // The ARGB RLE decoder, against a run it encodes itself.
  const planePx = 4;
  const rle = Buffer.concat([
    Buffer.from('ARGB', 'ascii'),
    Buffer.from([0x80 + (16 - 3), 0xAB]), // A plane: 16 x 0xAB
    Buffer.from([0x80 + (16 - 3), 0x01]),
    Buffer.from([0x80 + (16 - 3), 0x02]),
    Buffer.from([0x80 + (16 - 3), 0x03]),
  ]);
  let argb = null, argbErr = null;
  try { argb = decodeArgb(rle, planePx); } catch (e) { argbErr = e; }
  ok(argb && argb.alpha.length === 16 && argb.alpha.every(v => v === 0xAB),
    `ARGB RLE decoder recovers a 16-byte run-length alpha plane${argbErr ? ` (${argbErr.message})` : ''}`);
}

// ── §1 the container ──────────────────────────────────────────────────────

console.log('\n§1 images/applet.icns container');
ok(existsSync(ICNS_PATH), 'images/applet.icns exists (electron-builder.yml references it)');
const buf = readFileSync(ICNS_PATH);
let parsed = null, parseErr = null;
try { parsed = parseIcns(buf); } catch (e) { parseErr = e; }
ok(parsed !== null, `icns parses${parseErr ? ` — ${parseErr.message}` : ''}`);
if (!parsed) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);
  console.log('❌ FAILURES');
  process.exit(1);
}
ok(parsed.declared === buf.length,
  `icns declared length ${parsed.declared} === file size ${buf.length}`);

const seen = new Map();
for (const c of parsed.chunks) {
  if (IMAGE_CHUNKS[c.type]) seen.set(c.type, c);
}
const missing = Object.keys(IMAGE_CHUNKS).filter(t => !seen.has(t));
ok(missing.length === 0,
  missing.length === 0
    ? `all ${Object.keys(IMAGE_CHUNKS).length} expected image entries present (${Object.keys(IMAGE_CHUNKS).join(', ')})`
    : `missing icns entries: ${missing.join(', ')} — an icon macOS cannot find at a size renders scaled or blank`);

const unknown = parsed.chunks
  .map(c => c.type)
  .filter(t => !IMAGE_CHUNKS[t] && !NON_IMAGE_CHUNKS.has(t));
ok(unknown.length === 0,
  unknown.length === 0
    ? 'no unrecognised icns chunk types (nothing is being skipped unmeasured)'
    : `unrecognised icns chunk type(s): ${unknown.join(', ')} — if these are images, add them to ` +
      `IMAGE_CHUNKS so they are measured; a silent skip is how a full-bleed entry would pass`);

// ── §2 alpha channel + Apple-grid margin, every entry ─────────────────────

console.log('\n§2 alpha channel and Apple-grid margin, per entry');
const measured = [];
for (const [type, spec] of Object.entries(IMAGE_CHUNKS)) {
  const c = seen.get(type);
  if (!c) continue;
  let img = null, err = null;
  try {
    img = spec.format === 'png' ? decodePng(c.data) : decodeArgb(c.data, spec.px);
  } catch (e) { err = e; }

  const label = `${type} (${spec.px}px)`;
  if (!img) { ok(false, `${label}: decode failed — ${err.message}`); continue; }

  ok(img.width === spec.px && img.height === spec.px,
    `${label}: is ${img.width}x${img.height}`);

  // Alpha channel presence. For PNG this is colour type 6 — decodePng throws
  // on type 2, so reaching here already proves it; assert it explicitly so the
  // white-box regression names itself rather than surfacing as "decode failed".
  if (spec.format === 'png') {
    ok(img.colourType === 6, `${label}: PNG colour type 6 (RGBA — has an alpha channel)`);
  } else {
    ok(img.alpha.length === spec.px * spec.px, `${label}: ARGB alpha plane decoded in full`);
  }

  const hasTransparency = img.alpha.some(v => v === 0);
  ok(hasTransparency,
    `${label}: has genuinely transparent pixels (an all-opaque plane IS the white box)`);

  const expected = GRID_MARGIN_PX[spec.px];
  const ins = opaqueInset(img.alpha, img.width, img.height);
  if (!ins) { ok(false, `${label}: no opaque content at all`); continue; }

  const exact = ins.left === expected && ins.top === expected &&
                ins.right === expected && ins.bottom === expected;
  ok(exact,
    exact
      ? `${label}: opaque content inset ${expected}px on all four sides, body ${ins.bodyW}px ` +
        `(${(100 * ins.bodyW / spec.px).toFixed(2)}% — Apple's grid)`
      : `${label}: inset L${ins.left}/T${ins.top}/R${ins.right}/B${ins.bottom}, expected ` +
        `${expected} on every side. ${ins.left === 0 ? 'FULL BLEED — this icon renders LARGER than ' +
        'every neighbouring app in the Dock. Rebuild with scripts/rebuild-app-icon.py.'
        : 'Body is the wrong size for the Apple grid.'}`);

  ok(marginRingIsClear(img.alpha, img.width, img.height, expected),
    `${label}: the ${expected}px margin ring is FULLY transparent (no resampling halo outside the body)`);

  measured.push({ type, px: spec.px, expected, inset: ins.left, body: ins.bodyW });
}

// ── §3 cross-check: the ladder is what it claims to be ────────────────────

console.log('\n§3 the ladder as a whole');
ok(measured.length === Object.keys(IMAGE_CHUNKS).length,
  `all ${Object.keys(IMAGE_CHUNKS).length} entries were measured (none skipped)`);

// Same physical size => same geometry, whichever chunk carries it. ic08/ic13
// are both 256 and ic09/ic14 are both 512; if the builder ever produced them
// from different sources they could silently disagree.
const byPx = new Map();
for (const m of measured) {
  if (!byPx.has(m.px)) byPx.set(m.px, []);
  byPx.get(m.px).push(m);
}
let dup = 0, dupBad = 0;
for (const [px, list] of byPx) {
  if (list.length < 2) continue;
  dup++;
  if (new Set(list.map(m => `${m.inset}/${m.body}`)).size !== 1) dupBad++;
}
ok(dupBad === 0,
  `entries sharing a physical size agree on geometry (${dup} size(s) carried by more than one chunk)`);

// The 16/32 entries must NOT be on the 80.47% ratio — Apple deliberately
// relaxes them, and a "tidy-up" that made the ladder a constant ratio would
// shrink the two sizes where legibility is already the binding constraint.
const small = measured.filter(m => m.px <= 32);
ok(small.length > 0 && small.every(m => m.body / m.px > 0.85),
  `the 16 and 32px entries keep Apple's relaxed 87.5% body (measured ` +
  `${small.map(m => `${m.px}:${(100 * m.body / m.px).toFixed(1)}%`).join(', ')}) — ` +
  `not the 80.47% used at 256 and above`);

const large = measured.filter(m => m.px >= 256);
ok(large.length > 0 && large.every(m => Math.abs(m.body / m.px - 0.8046875) < 0.001),
  `the 256px-and-above entries sit on Apple's 80.47% body ratio ` +
  `(${large.map(m => `${m.px}:${(100 * m.body / m.px).toFixed(2)}%`).join(', ')})`);

console.log(`\n  → ladder: ${[...byPx.keys()].sort((a, b) => a - b)
  .map(px => `${px}px margin ${GRID_MARGIN_PX[px]} body ${byPx.get(px)[0].body}`).join(' | ')}`);

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ FAILURES'); process.exit(1); }
console.log('✅ App icon has alpha on every entry and conforms to the Apple icon grid');
