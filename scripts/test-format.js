#!/usr/bin/env node
/**
 * test-format.js — OFFLINE. The FIGURE (kit v1, 2026-11-27): shared/format.js
 * is the one way /next writes a count, a size, a token estimate, an age or a
 * price, and no view grows a local copy.
 *
 *   §1  fmtCount / fmtPages — separators, rounding, the not-a-number answer
 *   §2  fmtSize / fmtSizeDelta — ONE divisor (1024), the unit edges (0, 1,
 *       1023, 1024, 10239, 10240, 1 MiB − 1 …), the ".0" rule, the unit
 *       carry, null for what is not a size
 *   §3  fmtTokens / fmtTokenFigure — the meter's ladder, its edges, the
 *       999,500 → "1M" carry, and a DUMB CROSS-CHECK: an independent
 *       re-implementation of the rule run over 20,000 values
 *   §4  fmtAge — the canonical ladder (shared/age.js formatAge, not a copy),
 *       ISO / ms / Date input, the clock-skew window and "dated ahead"
 *   §5  fmtUsd IS formatUsdHonest
 *   §6  THE ADOPTION SCAN — no module under src/public/next defines a local
 *       size, age or token ladder; every exception is named WITH ITS REASON,
 *       and an exception that no longer matches anything fails (the list
 *       cannot rot into a licence)
 *   §7  the migrated call sites really import format.js, and the one inline
 *       ladder that may not import (memory.js's Session start tile, a lifted
 *       body) is EXECUTED against fmtTokens over a matrix
 *   §8  self-test: the scanner flags each kind of local formatter
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fmtCount, fmtPages, fmtSize, fmtSizeDelta, fmtTokens, fmtTokenFigure, fmtAge, fmtUsd,
  SIZE_DIVISOR, FUTURE_SKEW_S, formatAge as reAge,
} from '../src/public/next/shared/format.js';
import { formatAge } from '../src/public/next/shared/age.js';
import { formatUsdHonest } from '../src/public/next/shared/format-usd.js';
import { formatTokens as bucketTokens } from '../src/public/next/shared/bucket.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = path.join(ROOT, 'src', 'public', 'next');

let passed = 0, failed = 0;
function ok(c, m, detail) {
  if (c) { passed++; console.log('  ✓ ' + m); }
  else { failed++; console.log('  ✗ ' + m + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
function eq(a, b, m) { ok(a === b, m + ' → ' + JSON.stringify(a), 'expected ' + JSON.stringify(b)); }
function section(t) { console.log('\n' + t); }

// ═══════════════════════════════════════════════════════════════════════════
section('§1  fmtCount / fmtPages');
eq(fmtCount(0), '0', 'zero');
eq(fmtCount(1), '1', 'one');
eq(fmtCount(3527), '3,527', 'separators, en-US');
eq(fmtCount(1234567), '1,234,567', 'millions');
eq(fmtCount(-1200), '-1,200', 'a negative keeps its sign (never absorbed)');
eq(fmtCount(2.6), '3', 'rounded to a whole number');
eq(fmtCount(-0.2), '0', 'no "-0"');
eq(fmtCount(NaN), null, 'NaN → null');
eq(fmtCount(null), null, 'null → null');
eq(fmtCount('12'), null, 'a numeric STRING is not a count');
eq(fmtCount(Infinity), null, 'Infinity → null');
eq(fmtPages(1), '1 page', 'one page');
eq(fmtPages(0), '0 pages', 'zero pages');
eq(fmtPages(3527), '3,527 pages', 'many pages');
eq(fmtPages(undefined), null, 'undefined → null');

// ═══════════════════════════════════════════════════════════════════════════
section('§2  fmtSize — one divisor, ' + SIZE_DIVISOR);
eq(SIZE_DIVISOR, 1024, 'the divisor is 1024');
eq(fmtSize(0), '0 bytes', '0');
eq(fmtSize(1), '1 byte', '1 (singular)');
eq(fmtSize(1023), '1,023 bytes'.replace(',', ''), '1023 stays in bytes');
eq(fmtSize(1024), '1 KB', '1024 = 1 KB, ".0" dropped');
eq(fmtSize(1843), '1.8 KB', 'one decimal under 10 KB');
eq(fmtSize(10188), '9.9 KB', 'still one decimal at 9.95 KB');
eq(fmtSize(10239), '10 KB', '10239 rounds to 10.0 → whole "10 KB" (never "10.0 KB")');
eq(fmtSize(10240), '10 KB', '10240 = 10 KB');
eq(fmtSize(63488), '62 KB', 'whole from 10 KB');
eq(fmtSize(145844), '142 KB', 'an index file (was "146 KB" by ÷1000)');
eq(fmtSize(1048575), '1 MB', '1 MiB − 1 byte carries to the next unit (never "1,024 KB")');
eq(fmtSize(1048576), '1 MB', '1 MiB');
eq(fmtSize(14.2 * 1048576), '14 MB', '14.2 MiB → whole from 10');
eq(fmtSize(2516582), '2.4 MB', 'a real PDF');
eq(fmtSize(5 * 1073741824), '5 GB', 'GB');
eq(fmtSize(1023.6), '1 KB', 'a fractional byte count rounds first');
eq(fmtSize(-1), null, 'negative → null');
eq(fmtSize(NaN), null, 'NaN → null');
eq(fmtSize(null), null, 'null → null');
eq(fmtSize('2000'), null, 'a numeric STRING → null');
eq(fmtSizeDelta(6246), '+6.1 KB', 'a growth');
eq(fmtSizeDelta(-340), '−340 bytes', 'a shrink, with a real minus sign');
eq(fmtSizeDelta(0), null, 'unchanged → null (never "+0 bytes")');
eq(fmtSizeDelta(NaN), null, 'NaN → null');

// ═══════════════════════════════════════════════════════════════════════════
section('§3  fmtTokens — the meter ladder, moved here');
eq(fmtTokens(0), '0', 'zero is exact, no "≈"');
eq(fmtTokens(30), '≈0.1k', 'a positive count under 50 never reads as nothing');
eq(fmtTokens(500), '≈0.5k', '500');
eq(fmtTokens(6800), '≈6.8k', '6,800');
eq(fmtTokens(10300), '≈10.3k', '10,300');
eq(fmtTokens(20000), '≈20k', '20,000 drops ".0"');
eq(fmtTokens(99960), '≈100k', '99,960 rounds to 100.0k → whole "100k"');
eq(fmtTokens(205000), '≈205k', '205,000');
eq(fmtTokens(999499), '≈999k', '999,499');
eq(fmtTokens(999600), '≈1M', '999,600 carries to "1M" (the old ladder wrote "1000k")');
eq(fmtTokens(1e6), '≈1M', '1,000,000');
eq(fmtTokens(1.5e6), '≈1.5M', '1,500,000');
eq(fmtTokens(-5), null, 'negative → null');
eq(fmtTokens(NaN), null, 'NaN → null');
eq(fmtTokenFigure(NaN), '0', 'the meter figure keeps its "0" for nothing measured');
eq(bucketTokens(873000), fmtTokenFigure(873000), 'shared/bucket.js formatTokens IS fmtTokenFigure');
{
  // DUMB CROSS-CHECK: the rule written plainly, from the header's words, with
  // no shared code — then both run over a sweep.
  const plain = (v) => {
    if (!(v > 0)) return '0';
    const strip = (x) => x.replace(/\.0$/, '');
    if (Math.round(v / 1000) >= 1000 || v >= 1e6) return strip((Math.round(v / 1e5) / 10).toFixed(1)) + 'M';
    if (v >= 1e5) return Math.round(v / 1000) + 'k';
    const k = Math.round(v / 100) / 10;
    if (k === 0) return '0.1k';
    if (k >= 100) return Math.round(v / 1000) + 'k';
    if (k >= 10) return (Number.isInteger(k) ? String(k) : k.toFixed(1)) + 'k';
    return k.toFixed(1) + 'k';
  };
  let bad = null;
  for (let i = 0; i < 20000 && !bad; i++) {
    const v = i < 10000 ? i * 13 : Math.round(Math.pow(1.0012, i - 10000) * 900);
    if (plain(v) !== fmtTokenFigure(v)) bad = v + ': ' + plain(v) + ' vs ' + fmtTokenFigure(v);
  }
  ok(bad === null, 'an independent re-statement agrees over 20,000 values', bad);
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4  fmtAge — the canonical ladder, with its input and its future');
const NOW = Date.parse('2026-11-27T12:00:00Z');
eq(reAge, formatAge, 'format.js re-exports age.js formatAge (one ladder, not a copy)');
eq(fmtAge(NOW - 45e3, NOW), 'just now', '45 s');
eq(fmtAge(NOW - 27 * 60e3, NOW), '27 min ago', '27 min');
eq(fmtAge(NOW - 21 * 3600e3, NOW), '21 hr ago', '21 hr');
eq(fmtAge(NOW - 30 * 3600e3, NOW), '1 day ago', '30 hr (the ladder says "1 day ago"; see the contract amendment)');
eq(fmtAge(NOW - 4 * 86400e3, NOW), '4 days ago', '4 days');
eq(fmtAge(NOW - 15 * 86400e3, NOW), '2 weeks ago', '15 days');
eq(fmtAge(NOW - 70 * 86400e3, NOW), '2 months ago', '70 days');
eq(fmtAge(new Date(NOW - 27 * 60e3).toISOString(), NOW), '27 min ago', 'an ISO string');
eq(fmtAge(new Date(NOW - 27 * 60e3), new Date(NOW)), '27 min ago', 'a Date, and a Date clock');
eq(fmtAge(NOW + 60e3, NOW), 'just now', '1 min AHEAD (another computer\'s clock) reads "just now"');
eq(fmtAge(NOW + FUTURE_SKEW_S * 1000, NOW), 'just now', 'exactly the skew window ahead');
eq(fmtAge(NOW + FUTURE_SKEW_S * 1000 + 1000, NOW), 'dated ahead', 'beyond it: "dated ahead", never rounded younger');
eq(fmtAge('not a date', NOW), null, 'an unreadable string → null');
eq(fmtAge(null, NOW), null, 'null → null');
eq(fmtAge(NaN, NOW), null, 'NaN → null');
eq(fmtAge(NOW, NaN), null, 'an unreadable clock → null');

// ═══════════════════════════════════════════════════════════════════════════
section('§5  fmtUsd');
for (const v of [0, 0.00002, 0.0042, 0.042, 12.5, NaN, -0.5]) eq(fmtUsd(v), formatUsdHonest(v), 'fmtUsd(' + v + ') is formatUsdHonest');

// ═══════════════════════════════════════════════════════════════════════════
section('§6  THE ADOPTION SCAN — no local size, age or token ladder in /next');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith('.js')) out.push(path.relative(NEXT, p).split(path.sep).join('/'));
  }
  return out;
}
/** Comments out, strings kept (a unit word is a string). */
function stripComments(src) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (q) { out += c; if (c === '\\') { out += d; i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    out += c; i++;
  }
  return out;
}

/** The kinds of local formatter, each a pattern over comment-free source.
 *  A size formatter is a division by 1000/1024 with a KB/MB unit word within
 *  a few lines of it (a units ARRAY and a loop are a formatter too). */
const DIV = /\/\s*\(?\s*(1000|1024|1048576)\b|\/\s*1e3\b/;
const UNIT = /['"`][^'"`]*\b(KB|MB|GB)\b[^'"`]*['"`]/;
const AGE = /['"`]\s*(min|hr|minutes?|hours?) ago['"`]/;
const TOK = (line) => /\/\s*(1000|100|1e5)\b/.test(line) && /\+\s*['"`]k['"`]/.test(line);

function scan(rel, src) {
  const hits = [];
  const lines = stripComments(src).split('\n');
  lines.forEach((line, i) => {
    const near = lines.slice(Math.max(0, i - 3), i + 7).join('\n');
    if (DIV.test(line) && UNIT.test(near)) hits.push({ rel, kind: 'size', line: i + 1, text: line.trim().slice(0, 120) });
    if (AGE.test(line)) hits.push({ rel, kind: 'age', line: i + 1, text: line.trim().slice(0, 120) });
    if (TOK(line)) hits.push({ rel, kind: 'tokens', line: i + 1, text: line.trim().slice(0, 120) });
  });
  return hits;
}

/** file → kind → reason. Every entry must still match (both directions). */
const ALLOWED = {
  'shared/format.js': { tokens: 'THE formatter (its size rule divides by SIZE_DIVISOR, a name, so the scan does not see it)' },
  'shared/age.js': { age: 'THE age ladder (format.js re-exports it)' },
  'views/memory.js': {
    age: 'formatAge, the BYTE-IDENTICAL pinned copy of age.js (memory.js registers a view at import, so a DOM-free module cannot import it; scripts/test-sidebar-status-rows.js holds the three copies equal)',
  },
  'shared/update-phases.js': { size: 'a DOWNLOAD PROGRESS ticker: one decimal below 100 so the figure visibly moves on a slow connection; also held by the parallel v4.2.2 update-check patch' },
  'shared/ai-run.js': { tokens: 'an ESTIMATE RANGE in whole k ("≈18k–24k"), rounded coarse on purpose so a range whose ends print alike collapses to one point; the precise figure is the meter\'s job' },
};

const FILES = walk(NEXT);
ok(FILES.length > 60, 'walked ' + FILES.length + ' modules under src/public/next');
const hits = FILES.flatMap((rel) => scan(rel, readFileSync(path.join(NEXT, rel), 'utf8')));
const offending = hits.filter((h) => !(ALLOWED[h.rel] && ALLOWED[h.rel][h.kind]));
ok(offending.length === 0, 'no module but the named exceptions writes a size, an age or a token ladder of its own',
  offending.map((h) => h.rel + ':' + h.line + ' [' + h.kind + '] ' + h.text).join(' | '));
for (const [rel, kinds] of Object.entries(ALLOWED)) {
  for (const [kind, reason] of Object.entries(kinds)) {
    ok(hits.some((h) => h.rel === rel && h.kind === kind), 'exception still real: ' + rel + ' [' + kind + '] — ' + reason.slice(0, 90));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7  the migrated call sites, and the one inline ladder, executed');
const MIGRATED = {
  'app.js': ['formatSourceBytes', 'fmtSize'],
  'views/domains.js': ['fmtKB', 'fmtSize'],
  'views/health-review.js': ['formatSize', 'fmtSize'],
  'views/ingest.js': ['formatBytesLocal', 'fmtSize'],
  'views/chat.js': ['formatBytesChat', 'fmtSize'],
  'views/memory.js': ['fndSize', 'fmtSize'],
  'views/trash-list.js': ['formatBytes', 'fmtSize'],
  'shared/foundations-init.js': ['formatBytes', 'fmtSize'],
  'shared/ingest-queue-logic.js': ['formatQueueBytes', 'fmtSize'],
  'shared/bucket.js': ['formatTokens', 'fmtTokenFigure'],
};
for (const [rel, [fn, via]] of Object.entries(MIGRATED)) {
  const src = readFileSync(path.join(NEXT, rel), 'utf8');
  const imports = new RegExp("^import \\{[^}]*\\b" + via + "\\b[^}]*\\} from '\\.{1,2}/(shared/)?format\\.js';", 'm').test(src);
  const body = new RegExp('function ' + fn + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}').exec(src);
  ok(imports && body && body[1].includes(via + '('), rel + ': ' + fn + '() writes through format.js ' + via + '()');
}
// PHASE 2 (2026-11-27): the Session start overview tile and its inline token
// ladder went with the five-step page; the Projects page's tiles write every
// token figure through fmtTokens (views/memory.js prjTiles), so the exception
// and its execution above are retired with the tile.

// ═══════════════════════════════════════════════════════════════════════════
section('§8  self-test: the scanner can fail');
ok(scan('x.js', "return (n / 1024).toFixed(1) + ' KB';").some((h) => h.kind === 'size'), 'a local ÷1024 KB formatter is flagged');
ok(scan('x.js', "const s = Math.round(b / 1000).toLocaleString() + ' KB';").some((h) => h.kind === 'size'), 'a local ÷1000 KB formatter is flagged');
ok(scan('x.js', "if (m < 60) return m + ' min ago';").some((h) => h.kind === 'age'), 'a local age phrase is flagged');
ok(scan('x.js', "return Math.round(v / 1000) + 'k';").some((h) => h.kind === 'tokens'), 'a local token ladder is flagged');
ok(scan('x.js', "// return (n / 1024).toFixed(1) + ' KB';").length === 0, 'a COMMENT is not code');
ok(scan('x.js', "const label = fmtSize(n) + ' of 64 KB';").length === 0, 'a unit word with no division is not a formatter');
ok(scan('x.js', "const units = ['KB', 'MB'];\nlet v = n / 1024;\nwhile (v >= 1024) v /= 1024;").some((h) => h.kind === 'size'), 'a units-array formatter over several lines is flagged');

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
process.exit(failed ? 1 : 0);
