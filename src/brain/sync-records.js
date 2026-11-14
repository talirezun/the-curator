/**
 * sync-records.js — how Personal Sync merges the app's RECORD files. Pure; no I/O.
 *
 * pull() merges with `-X theirs`, and that preference also decides a hunk BOTH
 * computers changed. Two computers that each append to the same file change the
 * same hunk (the end of the file), so `-X theirs` kept the other computer's line
 * and silently dropped this one's (reproduced with plain git, 2026-11-14). For
 * `.raw-manifest.jsonl` that meant a source read here was forgotten: the
 * same-model no-call rule and duplicate detection no longer knew it, and the next
 * re-ingest made a paid call.
 *
 * git's built-in `merge=union` was tried first and rejected on evidence (an
 * independent audit): union cannot express a deletion, so an undismissed Health
 * row came back; and it aligns identical lines, so two log.md entries that
 * listed the same pages collapsed into one heading with the other entry's pages
 * under it. Both are fixed by merging RECORDS rather than lines of text:
 *
 *   'lines'  each non-blank line is one record (JSONL). Manifest, Health
 *            dismissals, working-state journals.
 *   'log'    each `## ` heading outside a code fence starts one entry block,
 *            kept whole. log.md.
 *
 * THE MERGE is three-way and counts records, so a line written twice stays
 * twice. Per record, with b/o/t its count in base/ours/theirs and d = o-b, e = t-b:
 *   both added (d>0, e>0)    b + max(d, e)   an identical append on both is kept once
 *   both removed (d<0, e<0)  b + min(d, e)
 *   otherwise                b + d + e        (never below 0)
 * The result is OURS, byte for byte, with the occurrences that must go removed
 * (last first) and the ones that must be added appended in THEIRS' order. So an
 * addition on either side is never lost, a deletion on either side (an
 * undismiss, a prune) is respected, and nothing that did not change is rewritten.
 *
 * BYTES, NOT TEXT. Every input is a Buffer and is handled as latin1, which maps
 * each byte to one character and back exactly: a stray non-UTF-8 byte, a CRLF
 * line ending or trailing spaces come out as they went in. A record's identity
 * ignores a trailing CR, so the same line written LF on one computer and CRLF on
 * the other is one record.
 */

/** Which merge a synced path gets, or null. Wiki pages and index.md are never listed. */
export function recordKind(p) {
  if (typeof p !== 'string') return null;
  const s = p.split('/');
  if (s.some((x) => !x || x === '.' || x === '..')) return null;
  if (s.length === 3 && s[1] === 'wiki') {
    if (s[2] === '.raw-manifest.jsonl' || s[2] === '.health-dismissed.jsonl') return 'lines';
    if (s[2] === 'log.md') return 'log';
    return null;
  }
  if (s.length >= 4 && s[1] === 'state' && s[s.length - 1] === 'journal.jsonl') return 'lines';
  return null;
}

const asText = (b) => (b == null ? '' : Buffer.isBuffer(b) ? b.toString('latin1') : Buffer.from(String(b), 'utf8').toString('latin1'));
/** Lines WITH their terminators, so joining them gives back the input exactly. */
const rawLines = (t) => t.match(/[^\n]*\n|[^\n]+$/g) || [];
const lineKey = (raw) => raw.replace(/\n$/, '').replace(/\r$/, '');

function counts(items) {
  const m = new Map();
  for (const i of items) if (i.key !== '') m.set(i.key, (m.get(i.key) || 0) + 1);
  return m;
}
function wanted(b, o, t) {
  const d = o - b;
  const e = t - b;
  const r = d > 0 && e > 0 ? b + Math.max(d, e) : d < 0 && e < 0 ? b + Math.min(d, e) : b + d + e;
  return Math.max(0, r);
}

/**
 * Items are { key, raw }; key '' is never counted, added or removed (blank lines,
 * a preamble). Returns the items of the result, in order.
 */
function mergeItems(base, ours, theirs) {
  const cb = counts(base);
  const co = counts(ours);
  const ct = counts(theirs);
  const target = new Map();
  for (const k of new Set([...cb.keys(), ...co.keys(), ...ct.keys()])) {
    target.set(k, wanted(cb.get(k) || 0, co.get(k) || 0, ct.get(k) || 0));
  }
  // Remove surplus occurrences from ours, last first.
  const drop = new Map();
  for (const [k, n] of co) if (n > target.get(k)) drop.set(k, n - target.get(k));
  const kept = [];
  for (let i = ours.length - 1; i >= 0; i--) {
    const it = ours[i];
    if (it.key !== '' && drop.get(it.key) > 0) { drop.set(it.key, drop.get(it.key) - 1); continue; }
    kept.push(it);
  }
  kept.reverse();
  // Add missing occurrences in theirs' order.
  const add = new Map();
  for (const [k, n] of target) { const have = co.get(k) || 0; if (n > have) add.set(k, n - have); }
  for (const it of theirs) {
    if (it.key !== '' && add.get(it.key) > 0) { add.set(it.key, add.get(it.key) - 1); kept.push(it); }
  }
  return kept;
}

/** Concatenate raw pieces, giving any piece that lacks one a line ending before the next. */
function join(pieces, eol) {
  let out = '';
  for (const p of pieces) {
    if (!p) continue;
    if (out && !out.endsWith('\n')) out += eol;
    out += p;
  }
  return out;
}
const eolOf = (t) => (/\r\n/.test(t) ? '\r\n' : '\n');

export function mergeLineRecords(base, ours, theirs) {
  const items = (t) => rawLines(t).map((raw) => ({ key: lineKey(raw).trim() ? lineKey(raw) : '', raw }));
  const o = asText(ours);
  const out = mergeItems(items(asText(base)), items(o), items(asText(theirs)));
  return Buffer.from(join(out.map((i) => i.raw), eolOf(o)), 'latin1');
}

/** A log: the text before the first entry, then one block per `## ` heading outside a fence. */
function splitLog(t) {
  let fence = null;
  const pre = [];
  const blocks = [];
  let cur = null;
  for (const raw of rawLines(t)) {
    const line = lineKey(raw);
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    if (!fence && !f && /^## /.test(line)) { cur = [raw]; blocks.push(cur); continue; }
    (cur || pre).push(raw);
  }
  const keyOf = (raw) => raw.replace(/\r/g, '').replace(/\s+$/, '');
  const preRaw = pre.join('');
  return {
    pre: { key: keyOf(preRaw), raw: preRaw },
    blocks: blocks.map((b) => { const raw = b.join(''); return { key: keyOf(raw), raw }; }),
  };
}

export function mergeLogBlocks(base, ours, theirs) {
  const o0 = asText(ours);
  const b = splitLog(asText(base));
  const o = splitLog(o0);
  const t = splitLog(asText(theirs));
  // The header (rewritten on a domain rename) is one value: keep the side that changed it.
  const pre = o.pre.key === b.pre.key ? t.pre : o.pre;
  const blocks = mergeItems(b.blocks, o.blocks, t.blocks);
  return Buffer.from(join([pre.raw, ...blocks.map((x) => x.raw)], eolOf(o0)), 'latin1');
}

/** Buffers in, a Buffer out. `base` is null when the two sides share no base. */
export function mergeRecordFile(kind, base, ours, theirs) {
  return kind === 'log' ? mergeLogBlocks(base, ours, theirs) : mergeLineRecords(base, ours, theirs);
}
