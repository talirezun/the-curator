/**
 * A skill folder as a .zip, without `ditto` (v4.1.2, audit W2).
 *
 * `GET /api/setup/skills/:name.zip` made its zip with macOS's `ditto`, so on
 * Windows and Linux it answered 501 while every view still drew the download
 * link. macOS keeps `ditto` (its bytes unchanged); every other platform uses
 * this writer: a plain ZIP (PKWARE APPNOTE 6.3.x), deflate or stored, the
 * same layout `ditto -c -k --keepParent` gives — the folder itself at the
 * top, `<name>/…` inside, forward slashes.
 *
 * Read-only over the source folder. Symbolic links and anything that is not
 * a plain file or folder are skipped (never followed out of the folder).
 * Bounded: at most MAX_ENTRIES entries and MAX_BYTES of input.
 *
 * Zero dependencies: node:fs, node:path, node:zlib.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

export const MAX_ENTRIES = 2000;
export const MAX_BYTES = 50 * 1024 * 1024;

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

/** CRC-32 (IEEE 802.3), as ZIP stores it. */
export function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f),
  };
}

/** `[{name, dir, data?, mtime}]` for `root`, kept under its own folder name. */
function collect(root) {
  const top = path.basename(root);
  const out = [];
  let bytes = 0;
  const walk = (abs, rel) => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      out.push({ name: `${rel}/`, dir: true, mtime: st.mtime });
      for (const n of readdirSync(abs).sort()) {
        if (out.length >= MAX_ENTRIES) throw new Error('The skill folder has too many files to zip.');
        walk(path.join(abs, n), `${rel}/${n}`);
      }
    } else if (st.isFile()) {
      bytes += st.size;
      if (bytes > MAX_BYTES) throw new Error('The skill folder is too large to zip.');
      out.push({ name: rel, dir: false, data: readFileSync(abs), mtime: st.mtime });
    }
  };
  walk(root, top);
  return out;
}

/** The ZIP bytes of folder `root`, its own name at the top. Throws on a read error. */
export function zipFolder(root) {
  const entries = collect(root);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.dir ? Buffer.alloc(0) : e.data;
    const crc = e.dir ? 0 : crc32(raw);
    let method = 0;
    let body = raw;
    if (!e.dir && raw.length) {
      const z = deflateRawSync(raw);
      if (z.length < raw.length) { method = 8; body = z; }
    }
    const { time, date } = dosTimeDate(e.mtime);
    const flags = 0x0800; // names are UTF-8
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4); // made by: UNIX, 3.0 — so the mode below is read
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    // external attributes: unix mode in the high half, MS-DOS directory bit low
    ch.writeUInt32LE((((e.dir ? 0o040755 : 0o100644) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}
