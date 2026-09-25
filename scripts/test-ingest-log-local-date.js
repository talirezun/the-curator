#!/usr/bin/env node
/**
 * test-ingest-log-local-date.js — v3.72.1, truth audit (Ingest F6).
 *
 * THE DEFECT. The ingest log heading `## [YYYY-MM-DD] ingest | …` was stamped
 * with the UTC date (`new Date().toISOString().slice(0, 10)`), while its one
 * reader — shared/age.js's dayDelta, behind the sidebar's "x ago" and the
 * freshness dot — reads that date as a LOCAL calendar day. In UTC+2 an ingest
 * at 00:30 read "yesterday"; west of Greenwich an evening ingest read "dated
 * ahead" with the stalest dot. The error ran both ways for |offset| hours a day.
 *
 * THE CONVENTION PINNED HERE: the ingest log heading is the LOCAL calendar day
 * — the shape the reader assumes — so a fresh ingest ages as "today" in every
 * time zone.
 *
 * HOW IT CANNOT PASS VACUOUSLY. The process time zone is chosen at start so
 * the local date and the UTC date DIFFER right now (UTC+14 when the UTC hour is
 * 10 or later, UTC-12 before that — between them every hour of the day is
 * covered), and a CONTROL asserts they differ. Then a REAL ingestFile runs
 * against a fake provider (the documented `opts.llm` seam — offline, free) in
 * an isolated domain, and the heading it appends to log.md is read back.
 */

// Chosen BEFORE anything reads a Date. Node re-reads TZ on assignment.
const utcHour = new Date().getUTCHours();
process.env.TZ = utcHour >= 10 ? 'Etc/GMT-14' : 'Etc/GMT+12';

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-ingest-logdate-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');

try {
  const { ingestFile, localDateStamp } = await import('../src/brain/ingest.js');
  const { __setDomainsDirOverride } = await import('../src/brain/config.js');
  const { formatDayAge } = await import('../src/public/next/shared/age.js');
  __setDomainsDirOverride(DOMAINS);

  console.log(`\n§1  localDateStamp — the local calendar day (TZ=${process.env.TZ})`);
  const now = new Date();
  const utcDay = now.toISOString().slice(0, 10);
  const localDay = localDateStamp(now);
  ok(utcDay !== localDay, `CONTROL — in this zone the local day (${localDay}) and the UTC day (${utcDay}) DIFFER, so the check below can fail`);
  const p2 = (n) => String(n).padStart(2, '0');
  eq(localDay, `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
    'localDateStamp is built from LOCAL date components');
  eq(localDateStamp(new Date(2026, 0, 5, 23, 59)), '2026-01-05', 'a fixed local date round-trips, zero-padded');

  console.log('\n§2  A REAL ingest writes the local day into log.md (fake provider, isolated domain)');
  const DOMAIN = 'logdate';
  const dd = path.join(DOMAINS, DOMAIN);
  for (const d of ['wiki/entities', 'wiki/concepts', 'wiki/summaries', 'raw']) mkdirSync(path.join(dd, d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), '# Test domain schema\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n', 'utf8');
  writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n\n', 'utf8');
  const src = path.join(TMP_ROOT, 'note.md');
  writeFileSync(src, 'A short note about the Alpha Lab and its first idea. '.repeat(20), 'utf8');

  const llm = async (schema, prompt, maxTokens, format, onWait, opts) => {
    if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 10, outputTokens: 5, provider: 'fake', model: 'fake-1' });
    return JSON.stringify({
      title: 'Local Date Note',
      pages: [
        { path: 'summaries/note.md', content: '# Note\n\nTags: test\n\n- one bullet\n' },
        { path: 'entities/alpha-lab.md', content: '# Alpha Lab\n\nTags: test\n\n- a lab\n' },
      ],
    });
  };
  const realWarn = console.warn, realErr = console.error;
  console.warn = () => {}; console.error = () => {};
  let thrown = null;
  try { await ingestFile(DOMAIN, src, 'note.md', false, null, { llm }); }
  catch (e) { thrown = e; }
  finally { console.warn = realWarn; console.error = realErr; }
  ok(!thrown, 'the ingest completed under the fake provider' + (thrown ? ' — ' + thrown.message : ''));

  const log = readFileSync(path.join(dd, 'wiki', 'log.md'), 'utf8');
  const m = /^## \[(\d{4}-\d{2}-\d{2})\] ingest \| Local Date Note$/m.exec(log);
  ok(!!m, 'the ingest appended its `## [date] ingest | title` heading');
  if (m) {
    const expected = localDateStamp(new Date());
    eq(m[1], expected, '★ F6 the heading carries the LOCAL calendar day');
    ok(m[1] !== new Date().toISOString().slice(0, 10), '★ F6 …not the UTC day (the defect)');
    eq(formatDayAge(m[1]), 'today', '★ F6 and the app\'s own age reader calls a fresh ingest "today" — not "yesterday", not "dated ahead"');
  }

  // ── §3  COMPILE: the log heading is local; the SLUG's date is not moved ──
  console.log('\n§3  A REAL compile writes the local day into log.md; its summary slug keeps the UTC day');
  const files = await import('../src/brain/files.js');
  const { compileConversation, precheckCompile } = await import('../src/brain/compile.js');
  const convId = '00000000-0000-4000-8000-000000372101';
  await files.writeConversation(DOMAIN, {
    id: convId, title: 'Local date compile', createdAt: '2026-09-01T00:00:00.000Z', domain: DOMAIN,
    messages: [
      { role: 'user', content: 'Explain the Alpha Lab.' },
      { role: 'assistant', content: 'The Alpha Lab studies the first idea.' },
    ],
  });
  const pre = await precheckCompile(DOMAIN, convId);
  const utcNow = new Date().toISOString().slice(0, 10);
  ok(pre && typeof pre.summarySlug === 'string' && pre.summarySlug.includes('-' + utcNow + '-'),
    'IDEMPOTENCY — the compile summary slug still carries the UTC day it always did (a recompile after the upgrade lands on the SAME slug)');
  const cllm = async () => JSON.stringify({
    title: 'Local date compile',
    pages: [{ path: 'summaries/placeholder.md', content: '# C\n\nTags: test\n\n- one bullet', summary: 's' }],
  });
  console.warn = () => {}; console.error = () => {};
  let cres = null;
  try { cres = await compileConversation(DOMAIN, convId, () => {}, { generateText: cllm }); }
  finally { console.warn = realWarn; console.error = realErr; }
  ok(cres && cres.ok, 'the compile completed under the fake provider' + (cres && !cres.ok ? ' — ' + (cres.error || cres.reason) : ''));
  const log2 = readFileSync(path.join(dd, 'wiki', 'log.md'), 'utf8');
  const c = /^## \[(\d{4}-\d{2}-\d{2})\] compile \| /m.exec(log2);
  ok(!!c, 'the compile appended its `## [date] compile | …` heading');
  if (c) {
    eq(c[1], localDateStamp(new Date()), '★ F6 the COMPILE heading carries the LOCAL calendar day');
    eq(formatDayAge(c[1]), 'today', '★ F6 …and ages as "today"');
  }

  // ── §4  writePage: a new page's `created:` stamp is the local day ────
  console.log('\n§4  writePage stamps a new page\'s `created:` with the local day');
  await files.writePage(DOMAIN, 'concepts/local-day.md', '# Local Day\n\nTags: test\n\n- a bullet\n');
  const page = readFileSync(path.join(dd, 'wiki', 'concepts', 'local-day.md'), 'utf8');
  const cr = /^created: (\d{4}-\d{2}-\d{2})$/m.exec(page);
  ok(!!cr, 'the page carries a `created:` frontmatter stamp');
  if (cr) eq(cr[1], localDateStamp(new Date()), '★ F6 writePage\'s `created:` is the LOCAL calendar day');

  // ── §5  THE CLASS: no bare UTC calendar stamp left in these writers ──
  console.log('\n§5  Dumb cross-check — no writer in these files builds a UTC calendar stamp for the log/pages');
  const srcOf = (f) => readFileSync(new URL('../src/brain/' + f, import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  eq((srcOf('files.js').match(/toISOString\(\)\.slice\(0, *10\)/g) || []).length, 0, 'files.js: 0 UTC calendar stamps');
  const compileSrc = srcOf('compile.js');
  eq((compileSrc.match(/toISOString\(\)\.slice\(0, *10\)/g) || []).length, 1,
    'compile.js: exactly 1 left — precheckCompile\'s slug date, kept UTC on purpose for idempotency by slug');
  ok(/## \[\$\{localDateStamp\(\)\}\] compile/.test(compileSrc), 'compile.js: the log heading uses localDateStamp');
} finally {
  rmSync(TMP_ROOT, { recursive: true, force: true });
}

console.log(`\n  Passed: ${passed}   Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
