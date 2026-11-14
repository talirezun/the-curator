/**
 * Decoding a text source (.md / .txt).
 *
 * Every text source used to be read with `readFile(p, 'utf8')`, so a file saved in
 * another encoding lost its č, ž, é to U+FFFD without a word. This module keeps that
 * read EXACTLY and says so; it does not guess another encoding.
 *
 * WHY NO GUESSING (orchestrator decision, 2026-11-15). An earlier version scored
 * Windows-1252, Windows-1250 and ISO-8859-2 against the letters of real languages and
 * converted the bytes. Three audits measured it: every round of rules fixed the cases
 * found and left others, and the last fuzz still made 2,559 wrong claims in 43,742
 * (Czech "Kč" as "Kè", Estonian as "Őhtul", ISO-8859-15 € as "¤"). The rule is that a
 * wrong letter silently entering a wiki is worse than a replacement character, and
 * statistical single-byte detection cannot meet it. So:
 *
 *   1. A UTF-16 BOM decides (unambiguous): UTF-16 LE/BE is decoded.
 *   2. Bytes that are valid UTF-8 (a UTF-8 BOM included) are returned by
 *      `buffer.toString('utf8')`, the call the old read made: byte-identical.
 *   3. Anything else gets that same old read (U+FFFD for each bad byte) and is
 *      flagged, so ingest tells the user, naming the file:
 *        - `strayBytes`: the file is UTF-8 apart from a few bad bytes (a file cut
 *          mid-character, one byte pasted from another program): a short note;
 *        - `notUtf8`: otherwise (saved in another encoding): the full note, which
 *          says how to keep the letters (re-save as UTF-8).
 *      Binary-looking bytes (a NUL, or over 2% control bytes) are not flagged: the
 *      downstream binary refusals see exactly what they saw before.
 *
 * Never throws for a Buffer.
 */

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

export const ENCODING_LABELS = {
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 (little-endian)',
  'utf-16be': 'UTF-16 (big-endian)',
};

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
 * The share of high bytes inside well-formed UTF-8 sequences. A file that is UTF-8
 * apart from a few bad bytes is at or above MOSTLY_UTF8_MIN_SHARE.
 */
export const MOSTLY_UTF8_MIN_SHARE = 0.9;
function utf8Shape(buf) {
  let good = 0, bad = 0;
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let n = 0;
    if (b >= 0xc2 && b <= 0xdf) n = 1; else if (b >= 0xe0 && b <= 0xef) n = 2; else if (b >= 0xf0 && b <= 0xf4) n = 3;
    let ok = n > 0;
    for (let k = 1; ok && k <= n; k++) { const c = buf[i + k]; if (c === undefined || c < 0x80 || c > 0xbf) ok = false; }
    if (ok) { good += n + 1; i += n + 1; } else { bad++; i++; }
  }
  return { good, bad };
}

/**
 * @param {Buffer|Uint8Array} input
 * @returns {{ text: string, encoding: string, converted: boolean, label: string,
 *   notUtf8?: true, strayBytes?: number }}
 *   `converted` is true only for a UTF-16 file decoded by its BOM.
 */
export function decodeTextBuffer(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const result = (text, encoding, converted, extra = {}) => ({ text, encoding, converted, label: ENCODING_LABELS[encoding] || encoding, ...extra });

  // 1. A UTF-16 BOM. (A UTF-8 BOM is valid UTF-8 and falls to 2, unchanged.)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return result(new TextDecoder('utf-16le').decode(buf.subarray(2)), 'utf-16le', true);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return result(new TextDecoder('utf-16be').decode(buf.subarray(2)), 'utf-16be', true);
  }

  // 2. Valid UTF-8: the exact call the old readFile(p, 'utf8') made.
  const old = buf.toString('utf8');
  let valid = true;
  try { UTF8_FATAL.decode(buf); } catch { valid = false; }
  if (valid) return result(old, 'utf-8', false);

  // 3. Not UTF-8: the old read, never a guess. Binary is left unflagged.
  if (looksBinary(buf)) return result(old, 'utf-8', false);
  const shape = utf8Shape(buf);
  if (shape.good > 0 && shape.good / (shape.good + shape.bad) >= MOSTLY_UTF8_MIN_SHARE) {
    return result(old, 'utf-8', false, { strayBytes: shape.bad });
  }
  return result(old, 'utf-8', false, { notUtf8: true });
}

/** The note an ingest adds for a file that is not saved as UTF-8. */
export function notUtf8Notice(originalName) {
  return `"${originalName}" is not saved as UTF-8, so some characters (such as č, ž, é) were replaced by \u{FFFD}. ` +
    `Save it as UTF-8 and ingest it again to keep them.`;
}

/** The short note for a UTF-8 file with a few bytes that are not valid UTF-8. */
export function strayBytesNotice(originalName, n) {
  return `"${originalName}" has ${n} byte${n === 1 ? '' : 's'} that ${n === 1 ? 'is' : 'are'} not valid UTF-8; ` +
    `${n === 1 ? 'it was' : 'they were'} replaced by \u{FFFD}. The rest of the file was read as written.`;
}
