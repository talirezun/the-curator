/**
 * Decoding a text source (.md / .txt) whose encoding nobody told us.
 *
 * Until this module, every text source was read with `readFile(p, 'utf8')`.
 * A file saved as Windows-1252, ISO-8859-1/2 or Windows-1250 — common for
 * notes exported from older Windows tools, and for wikis built elsewhere —
 * then lost every č, ž, é, à to U+FFFD before the model ever saw it, and the
 * damage was written into the wiki.
 *
 * The order, and why:
 *   1. A BOM decides. UTF-8 with BOM is still UTF-8 and is read EXACTLY as
 *      before (the U+FEFF stays, as `toString('utf8')` always kept it);
 *      UTF-16 LE/BE with a BOM is decoded as UTF-16.
 *   2. Bytes that are valid UTF-8 are UTF-8, decoded by `buffer.toString('utf8')`
 *      — the very call the old `readFile(p, 'utf8')` made, so a UTF-8 source
 *      reads byte-identically to before. Pure ASCII lands here too.
 *   3. Anything that looks binary (a NUL byte, or a high share of control
 *      characters) is NOT reinterpreted: it gets the old lossy UTF-8 read, so
 *      every downstream binary refusal (raw-store's NUL / U+FFFD checks, the
 *      MIN_TEXT_LEN gate) sees exactly what it saw before.
 *   4. Otherwise one of three single-byte encodings is chosen: windows-1252
 *      (Western; WHATWG's 'iso-8859-1' label is this same decoder),
 *      windows-1250 (Central European) and iso-8859-2. Each is tried and
 *      scored by how much of the non-ASCII text it produces is made of the
 *      letters of ONE real language using that encoding (Slovene, French,
 *      German, Czech, …), with punctuation like “ ” – … € neutral and a C1
 *      control (what ISO-8859-x makes of bytes 0x80-0x9F) counted against it.
 *      Ties go to windows-1252, the most common.
 *
 * No dependency: Node's built-in TextDecoder (full ICU) decodes windows-1250
 * and iso-8859-2. NOT windows-1252: Node 22's TextDecoder('windows-1252')
 * (and its 'latin1' / 'iso-8859-1' aliases) decodes bytes 0x80-0x9F as C1
 * controls, i.e. as strict ISO-8859-1, so “ ” – € œ š ž would vanish. That
 * one encoding is decoded here by table (`decodeWindows1252`).
 * Never throws for a Buffer; the caller only sees `{ text, encoding, converted }`.
 */

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

/** Labels shown to people, by WHATWG encoding name. */
export const ENCODING_LABELS = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 (little-endian)',
  'utf-16be': 'UTF-16 (big-endian)',
  'windows-1252': 'Windows-1252 / ISO-8859-1 (Western European)',
  'windows-1250': 'Windows-1250 (Central European)',
  'iso-8859-2': 'ISO-8859-2 (Central European)',
};

// Lower-case letters beyond ASCII, per language. A candidate decoding scores
// by its BEST language, so a Slovene file is judged against Slovene, not
// against the union of every alphabet (which would accept anything).
const LANGS = {
  'windows-1252': {
    french: 'àâæçéèêëîïôœùûüÿ',
    german: 'äöüß',
    spanish: 'áéíóúñü',
    italian: 'àèéìíîòóùú',
    portuguese: 'áâãàçéêíóôõú',
    dutch: 'éèëïóöü',
    nordic: 'åäöæøéü',
    icelandic: 'áðéíóúýþæö',
  },
  'windows-1250': null,   // filled below — the same alphabets serve both CE encodings
  'iso-8859-2': null,
};
const CENTRAL = {
  slovene: 'čšž',
  croatian: 'čćđšž',
  czech: 'áčďéěíňóřšťúůýž',
  slovak: 'áäčďéíĺľňóôŕšťúýž',
  polish: 'ąćęłńóśźż',
  hungarian: 'áéíóöőúüű',
  romanian: 'ăâîşţ',
  german: 'äöüß',
};
LANGS['windows-1250'] = CENTRAL;
LANGS['iso-8859-2'] = CENTRAL;

// Typographic characters any language may use; they neither help nor hurt.
// Deliberately short: a sign that is rare in prose (¹ ¾ © ®) is what another
// encoding makes of a letter (ISO-8859-2's š ž Š Ž), so those must count.
const NEUTRAL = new Set([...'\u00a0€‚„…†‡‰‹›‘’“”•–—™«»°±·×÷§¿¡']);

const CANDIDATES = ['windows-1252', 'windows-1250', 'iso-8859-2'];

// windows-1252's 0x80-0x9F (WHATWG; the five undefined bytes stay C1 code points).
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

/** windows-1252 by table: every byte is one code point, 0x80-0x9F remapped. */
export function decodeWindows1252(buf) {
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    const codes = new Array(Math.min(CHUNK, buf.length - i));
    for (let j = 0; j < codes.length; j++) {
      const b = buf[i + j];
      codes[j] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

function decodeAs(enc, buf) {
  return enc === 'windows-1252' ? decodeWindows1252(buf) : new TextDecoder(enc).decode(buf);
}

function isC1(code) { return code >= 0x80 && code <= 0x9f; }

/** How well `text` reads as one language of `enc`: 0..1, higher is better. */
function plausibility(text, enc) {
  const counts = new Map();
  let total = 0, bad = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x80) continue;
    if (isC1(code) || code === 0xfffd) { bad++; total++; continue; }
    if (NEUTRAL.has(ch)) continue;
    const lower = ch.toLowerCase();
    counts.set(lower, (counts.get(lower) || 0) + 1);
    total++;
  }
  if (total === 0) return 1;
  let best = 0;
  for (const alphabet of Object.values(LANGS[enc])) {
    let hit = 0;
    for (const [c, n] of counts) if (alphabet.includes(c)) hit += n;
    if (hit > best) best = hit;
  }
  return (best - 2 * bad) / total;
}

/** A NUL, or more than 2% control characters, means this is not a text file. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 64 * 1024);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) ctrl++;
  }
  return n > 0 && ctrl / n > 0.02;
}

/**
 * @param {Buffer|Uint8Array} input
 * @returns {{ text: string, encoding: string, converted: boolean, label: string }}
 *   `converted` is true when the bytes were NOT UTF-8 and were decoded as `encoding`.
 */
export function decodeTextBuffer(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const result = (text, encoding, converted) => ({ text, encoding, converted, label: ENCODING_LABELS[encoding] || encoding });

  // 1. BOM. (UTF-8's BOM falls through to the valid-UTF-8 read below, unchanged.)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return result(new TextDecoder('utf-16le').decode(buf.subarray(2)), 'utf-16le', true);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return result(new TextDecoder('utf-16be').decode(buf.subarray(2)), 'utf-16be', true);
  }

  // 2. Valid UTF-8: the exact call the old readFile(p, 'utf8') made.
  let valid = true;
  try { UTF8_FATAL.decode(buf); } catch { valid = false; }
  if (valid) return result(buf.toString('utf8'), 'utf-8', false);

  // 3. Binary is left exactly as before, so every binary refusal downstream still fires.
  if (looksBinary(buf)) return result(buf.toString('utf8'), 'utf-8', false);

  // 4. The single-byte encoding whose letters read as one real language.
  let best = null;
  for (const enc of CANDIDATES) {
    const text = decodeAs(enc, buf);
    const score = plausibility(text, enc);
    if (!best || score > best.score) best = { enc, text, score };
  }
  return result(best.text, best.enc, true);
}

/** The one plain line an ingest adds when a source was not UTF-8. */
export function conversionNotice(originalName, decoded) {
  return `"${originalName}" was not saved as UTF-8, so The Curator read it as ${decoded.label} and converted it ` +
    `to UTF-8 for the wiki. The file in raw/ is kept exactly as uploaded. If letters such as č, ž or é look wrong ` +
    `in the new pages, re-save the file as UTF-8 and ingest it again.`;
}
