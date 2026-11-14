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
 *      A letter in a place no language of that table puts it (a capital mid-word,
 *      a letter glued to a digit, Windows-1252's è before a vowel where Slovene has
 *      č) counts against it; ties go to windows-1252, then windows-1250.
 *   3b. Bytes that are UTF-8 apart from a few bad ones (at least 90% of the high
 *      bytes in well-formed sequences) get the old UTF-8 read, one U+FFFD each.
 *   5. When no table reads as a language (score below MIN_PLAUSIBILITY: Cyrillic,
 *      MacRoman), nothing is claimed: the old UTF-8 read, flagged `unrecognised`.
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

/**
 * RIVALS: encodings The Curator does NOT convert, scored only to recognise them. If
 * one reads the bytes as its language better than every supported table, the file is
 * declined (the old UTF-8 read and the "not recognised" note), never decoded into wrong
 * letters (re-audit 2026-11-15: Turkish was claimed as 1252, "Şirket" → "Þirket";
 * Greek, Latvian and Estonian as 1250). The governing rule: a wrong letter silently in
 * the wiki is worse than a replacement character, so decode only on positive evidence.
 */
const RIVALS = {
  'windows-1254': { turkish: 'çğıöşüâîû' },
  'windows-1253': { greek: 'αβγδεζηθικλμνξοπρστυφχψωάέήίόύώϊϋΐΰς' },
  'windows-1257': { latvian: 'āčēģīķļņšūž', lithuanian: 'ąčęėįšųūž', estonian: 'äöõüšž' },
  'windows-1251': { cyrillic: 'абвгдеёжзийклмнопрстуфхцчшщъыьэюяіїєґўђћџљњ' },
  'macintosh': { french: 'àâæçéèêëîïôœùûüÿ', german: 'äöüß', spanish: 'áéíóúñü' },
};

const alphabetsOf = (enc) => LANGS[enc] || RIVALS[enc];

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

const isLetter = (ch) => ch !== undefined && /\p{L}/u.test(ch);
const scriptOf = (ch) => (/\p{Script=Greek}/u.test(ch) ? 'greek' : /\p{Script=Cyrillic}/u.test(ch) ? 'cyrillic' : 'latin');
const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
const isLower = (ch) => isLetter(ch) && ch === ch.toLowerCase() && ch !== ch.toUpperCase();
const isUpper = (ch) => isLetter(ch) && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
const VOWELS = new Set([...'aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýœăąęěőůű']);
const isVowel = (ch) => ch !== undefined && VOWELS.has(ch.toLowerCase());

// Symbols a Western text uses next to numbers (£250, m², ±5, ½, © 2025, 10 µm). What
// ISO-8859-2 makes of the same bytes is a letter glued to a digit (Ł250, ą5), a spacing
// diacritic (˛ ˝) or a lone capital (Š 2025), each counted against it below.
const SYMBOLS = new Set([...'£¢¥¤©®²³¹±½¼¾µªº¬¦¯']);
// Signs that never touch a letter in Western text (except m² m³, allowed above).
const GLUE_SIGNS = new Set([...'¹²³¼½¾£¥¤¢']);
// Spacing diacritics never stand on their own in text: a sign of the wrong table.
const SPACING_MARKS = new Set([...'˘˛˝ˇ˙¸´¨']);
// A letter that may stand alone as a word.
const ONE_LETTER_WORDS = new Set([...'àèéòóùäöåÀÈÉ']);

/**
 * Letters in a context no language of `enc` puts them in (2026-11-14, after an audit
 * proved that Slovene "č"-only text read as Windows-1252 "è" and Hungarian "ő" as "õ").
 * Windows-1252's è ì ò ù õ ã share bytes with Central European č ě ň ů ő ă; in French,
 * Italian and Portuguese they sit in narrow places (è before a consonant or at a word's
 * end, ì ò ù at a word's end, õ before e or s, ã before o e s n), so one in any other
 * place is evidence against 1252.
 */
function implausibleHere(ch, prev, next, enc) {
  if (SPACING_MARKS.has(ch)) return true;
  if (isLetter(ch)) {
    // A word in two scripts ("Grφίe", "Ћivljenje") is a Latin text read through a
    // Greek or Cyrillic table: what keeps those rivals from matching every Latin file.
    if ((isLetter(prev) && scriptOf(prev) !== scriptOf(ch)) || (isLetter(next) && scriptOf(next) !== scriptOf(ch))) return true;
    if (isDigit(prev) || isDigit(next)) return true;                        // Ł250, ą5
    if (isUpper(ch) && isLower(prev)) return true;                          // CafŽ (a capital mid-word)
    if (isLower(ch) && isUpper(next)) return true;                          // żDónde (a capital right after a small letter)
    if (!isLetter(prev) && !isLetter(next) && !ONE_LETTER_WORDS.has(ch)) return true; // a lone Š
  }
  if (SYMBOLS.has(ch) && isLetter(prev) && isLetter(next)) return true;     // a sign inside a word
  // A superscript, fraction or currency sign glued to a letter (Polish "zł" read as
  // 1252 "z³", "Łącznie" as "£¹cznie"); m² and m³ (and km², cm³) are the exception.
  if (GLUE_SIGNS.has(ch) && (isLetter(next) || GLUE_SIGNS.has(next) || (isLetter(prev) && !(/[²³]/.test(ch) && /m/i.test(prev))))) return true;
  if (enc === 'windows-1252') {
    const c = ch.toLowerCase();
    if (c === 'è' && (isVowel(next) || (isVowel(prev) && !isLetter(next)))) return true;
    if ((c === 'ì' || c === 'ò' || c === 'ù') && isLetter(next)) return true;
    if (c === 'õ' && !(next && /[es]/i.test(next))) return true;
    if (c === 'ã' && isLetter(next) && !/[oesn]/i.test(next)) return true;
  }
  return false;
}

/** How well `text` reads as one language of `enc`: at most 1, higher is better. */
function plausibility(text, enc) {
  const counts = new Map();
  let total = 0, bad = 0;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.codePointAt(0);
    if (code < 0x80) continue;
    if (isC1(code) || code === 0xfffd) { bad++; total++; continue; }
    if (NEUTRAL.has(ch)) continue;
    if (implausibleHere(ch, chars[i - 1], chars[i + 1], enc)) { bad++; total++; continue; }
    if (enc === 'windows-1252' && SYMBOLS.has(ch)) continue;               // a plausible Western sign
    const lower = ch.toLowerCase();
    counts.set(lower, (counts.get(lower) || 0) + 1);
    total++;
  }
  if (total === 0) return 1;
  let best = 0;
  for (const alphabet of Object.values(alphabetsOf(enc))) {
    let hit = 0;
    for (const [c, n] of counts) if (alphabet.includes(c)) hit += n;
    if (hit > best) best = hit;
  }
  return (best - 2 * bad) / total;
}

/**
 * Bytes that are UTF-8 apart from a few bad ones (a file cut mid-character, one byte
 * pasted from another program). Counted over the bytes at or above 0x80: those inside a
 * well-formed multi-byte sequence, and the rest. An audit proved that one stray byte
 * otherwise sent a whole UTF-8 file through the single-byte decoders, turning every
 * č into "ÄŤ"; the old read gave one U+FFFD.
 */
export const MOSTLY_UTF8_MIN_SHARE = 0.9;
function utf8Shape(buf) {
  let good = 0, badBytes = 0;
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let n = 0;
    if (b >= 0xc2 && b <= 0xdf) n = 1; else if (b >= 0xe0 && b <= 0xef) n = 2; else if (b >= 0xf0 && b <= 0xf4) n = 3;
    let ok = n > 0;
    for (let k = 1; ok && k <= n; k++) { const c = buf[i + k]; if (c === undefined || c < 0x80 || c > 0xbf) ok = false; }
    if (ok) { good += n + 1; i += n + 1; } else { badBytes++; i++; }
  }
  return { good, bad: badBytes };
}

/** Below this, no single-byte table read the text as a language: it is not claimed. */
export const MIN_PLAUSIBILITY = 0.5;
/** Two readings within this of each other are a tie, and a tie is declined. */
export const TIE_MARGIN = 0.05;

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
/** Test seam: the score one table gives a decoded text. */
export function __plausibilityForTest(text, enc) { return plausibility(text, enc); }

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

  // 3b. UTF-8 apart from a few bad bytes: the old read (one U+FFFD each), not a re-decode.
  const shape = utf8Shape(buf);
  if (shape.good > 0 && shape.good / (shape.good + shape.bad) >= MOSTLY_UTF8_MIN_SHARE) {
    return result(buf.toString('utf8'), 'utf-8', false);
  }

  // 4. The single-byte encoding whose letters read as one real language. A tie keeps
  // the earlier candidate (1252, then 1250, then ISO-8859-2); a tie is now rare, since a
  // letter in a place its language never puts it counts against that table.
  const scored = CANDIDATES.map((enc) => { const text = decodeAs(enc, buf); return { enc, text, score: plausibility(text, enc) }; });
  let best = scored[0];
  for (const c of scored) if (c.score > best.score) best = c;
  // Decline on a tie between two supported tables that give DIFFERENT text: no
  // positive evidence for either (two that give the same text are one answer).
  const tied = scored.some((c) => c !== best && c.text !== best.text && c.score >= best.score - TIE_MARGIN);
  // Decline when an encoding we do not convert reads it at least as well.
  const rival = Object.keys(RIVALS).some((enc) => {
    let text; try { text = new TextDecoder(enc).decode(buf); } catch { return false; }
    return text !== best.text && plausibility(text, enc) >= best.score - TIE_MARGIN;
  });
  // 5. No table reads it as a language (Cyrillic, MacRoman, ...): nothing is claimed. The
  // old UTF-8 read stands, and the caller says the encoding was not recognised.
  if (best.score < MIN_PLAUSIBILITY || tied || rival) {
    return { ...result(buf.toString('utf8'), 'utf-8', false), unrecognised: true };
  }
  return result(best.text, best.enc, true);
}

/** The line an ingest adds when a source is not UTF-8 and no known encoding fits. */
export function unrecognisedNotice(originalName) {
  return `"${originalName}" is not saved as UTF-8, and its encoding is not one The Curator recognises ` +
    `(it reads Windows-1252, Windows-1250 and ISO-8859-2), so it was read as UTF-8 and letters outside ` +
    `plain English may show as "\uFFFD". Re-save the file as UTF-8 and ingest it again.`;
}

/** The one plain line an ingest adds when a source was not UTF-8. */
export function conversionNotice(originalName, decoded) {
  return `"${originalName}" was not saved as UTF-8, so The Curator read it as ${decoded.label} and converted it ` +
    `to UTF-8 for the wiki. The file in raw/ is kept exactly as uploaded. If letters such as č, ž or é look wrong ` +
    `in the new pages, re-save the file as UTF-8 and ingest it again.`;
}
