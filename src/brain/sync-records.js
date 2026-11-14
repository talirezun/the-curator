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
 *   'log'    each `## ` heading starts one entry block, kept whole. log.md.
 *
 * The merge is a three-way SET merge over records, deterministic:
 *   result = ours, minus every record THEIRS deleted (in base, not in theirs),
 *            then every record THEIRS added (not in base, not in ours), in
 *            theirs' order.
 * So an addition on either side is never lost, and a deletion on either side
 * (an undismiss, a prune) is respected. A record both sides added identically
 * appears once. sync.js applies it only to a file BOTH sides changed since the
 * merge base, after git's own merge, and commits the result.
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

/** The three-way set merge over record keys. Items are { key, text }. */
function mergeItems(base, ours, theirs) {
  const baseKeys = new Set(base.map((i) => i.key));
  const ourKeys = new Set(ours.map((i) => i.key));
  const theirKeys = new Set(theirs.map((i) => i.key));
  const out = ours.filter((i) => !(baseKeys.has(i.key) && !theirKeys.has(i.key)));
  const seen = new Set(out.map((i) => i.key));
  for (const i of theirs) {
    if (baseKeys.has(i.key) || ourKeys.has(i.key) || seen.has(i.key)) continue;
    out.push(i);
    seen.add(i.key);
  }
  return out;
}

const lineItems = (text) => (text || '').split('\n').map((l) => l.replace(/\r$/, ''))
  .filter((l) => l.trim()).map((l) => ({ key: l, text: l }));

export function mergeLineRecords(base, ours, theirs) {
  const out = mergeItems(lineItems(base), lineItems(ours), lineItems(theirs));
  return out.length ? out.map((i) => i.text).join('\n') + '\n' : '';
}

/** A log: the text before the first `## ` heading, then one block per heading. */
function splitLog(text) {
  const lines = (text || '').split('\n');
  let preamble = [];
  const blocks = [];
  let cur = null;
  for (const l of lines) {
    if (/^## /.test(l)) { cur = [l]; blocks.push(cur); }
    else if (cur) cur.push(l);
    else preamble.push(l);
  }
  const norm = (arr) => arr.join('\n').replace(/\s+$/, '');
  return {
    preamble: norm(preamble),
    blocks: blocks.map((b) => { const t = norm(b); return { key: t, text: t }; }),
  };
}

export function mergeLogBlocks(base, ours, theirs) {
  const b = splitLog(base);
  const o = splitLog(ours);
  const t = splitLog(theirs);
  // The header (rewritten on a domain rename) is one value: keep the side that changed it.
  const preamble = o.preamble === b.preamble ? t.preamble : o.preamble;
  const blocks = mergeItems(b.blocks, o.blocks, t.blocks);
  const parts = [preamble, ...blocks.map((x) => x.text)].filter((x) => x);
  return parts.length ? parts.join('\n\n') + '\n\n' : '';
}

export function mergeRecordFile(kind, base, ours, theirs) {
  return kind === 'log' ? mergeLogBlocks(base, ours, theirs) : mergeLineRecords(base, ours, theirs);
}
