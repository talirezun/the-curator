#!/usr/bin/env node
/**
 * test-next-reader-backlinks.js — v3.78.0. The shell reader's ONE additive
 * option, `hideBacklinks`, executed through the REAL `renderReader` lifted
 * from src/public/next/app.js (app.js touches `document` at import, so it is
 * lifted by brace-matching and run against a recording stub DOM).
 *
 * Exists to stop:
 *   §1 a caller that is not a wiki page (Context step 5's tool evidence)
 *      printing "BACKLINKS · 0" under its page;
 *   §2 the option leaking to every other caller: absent (or anything but
 *      `true`) the section prints exactly as before, count and rows.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = readFileSync(path.join(ROOT, 'src/public/next/app.js'), 'utf8');

let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 400)}` : ''}`); }
};

/** Brace-matched extraction (the helper test-next-memory-view.js uses). */
function extractFunction(src, name) {
  const m = new RegExp(`(?:^|\\n)(?:export\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`${name} not found in app.js`);
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const out = src.slice(start, i);
  if (!/\n\}$/.test(out)) throw new Error(`${name} desynced`);
  return out;
}

/** Run the real renderReader once, first-open path, and return the markup it wrote. */
function render(reader) {
  const root = { innerHTML: '', querySelector: () => null };
  const scrim = { classList: { add() {} }, addEventListener() {} };
  const document = {
    getElementById: (id) => (id === 'reader-root' ? root : id === 'reader-scrim' ? scrim
      : id === 'reader-close-btn' ? { addEventListener() {} } : null),
  };
  const fn = new Function('state', 'document', 'escapeHtml', 'icon', 'READER_TYPE_CLASS', 'READER_TYPE_DOT',
    'liveReaderScrim', 'loadReaderSource', 'getComputedStyle', 'readerEpoch', 'dismissReader',
    extractFunction(APP, 'renderReader') + '\nreturn renderReader;')(
    { reader }, document, (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    () => '<svg></svg>', {}, {}, () => null, () => {}, () => ({ opacity: 1 }), 1, () => {});
  fn();
  return root.innerHTML;
}

console.log('\n§1  hideBacklinks: true omits the section');
{
  const html = render({ slug: 'Setup › Claude Code', title: 'Claude Code', bodyHtml: '<p>evidence</p>', hideBacklinks: true });
  ok(html.includes('<p>evidence</p>'), 'the page body is painted');
  ok(!/BACKLINKS/.test(html) && !/reader-backlinks/.test(html), 'no BACKLINKS head and no backlinks list', html.slice(-300));
}

console.log('\n§2  every other caller is unchanged');
{
  const plain = render({ slug: 'entities/x.md', title: 'X', bodyHtml: '<p>x</p>' });
  ok(/<div class="reader-backlinks-head">BACKLINKS · 0<\/div>/.test(plain) && /No other page links here yet\./.test(plain),
    'absent: "BACKLINKS · 0" and the empty note, as before');
  const two = render({ slug: 'entities/x.md', title: 'X', backlinks: [{ path: 'a.md', title: 'A' }, { path: 'b.md', title: 'B' }] });
  ok(/BACKLINKS · 2/.test(two) && (two.match(/reader-backlink-row/g) || []).length === 2, 'absent, with backlinks: the count and the rows');
  ok(/BACKLINKS · 0/.test(render({ slug: 'x', hideBacklinks: 'yes' })), 'only a literal `true` hides it — a truthy string does not');
}

console.log(`\n${failed ? '✗' : '✓'} test-next-reader-backlinks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
