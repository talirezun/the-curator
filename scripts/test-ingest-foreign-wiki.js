#!/usr/bin/env node
/**
 * test-ingest-foreign-wiki.js — OFFLINE. Ingest into a wiki built elsewhere, and
 * text sources that are not UTF-8 (see src/brain/ingest-preflight.js and
 * src/brain/text-decode.js).
 *
 *   §1 decodeTextBuffer: valid UTF-8 (BOM, ASCII, emoji) reads exactly as
 *      buffer.toString('utf8'); UTF-16 with a BOM decodes; ANY other bytes
 *      (Windows-1252/-1250, ISO-8859-2, Turkish, Greek, Cyrillic, a stray byte,
 *      word salad) get that same old read, never a guessed conversion, and are
 *      flagged (notUtf8 or strayBytes); binary is the old read, unflagged.
 *   §2 Ingest of such a file: the old text reaches the model, one note names the
 *      file and says to re-save it as UTF-8, it is in log.md, raw/ keeps the
 *      original bytes; a UTF-8 source has no note; a stray byte a short note.
 *   §3 The hard-data gate's text (sourceTextForGate), extractText and the MCP's
 *      readRawSourceText read the same way.
 *   §4 A wiki with no log.md and no index.md: the ingest succeeds and creates both.
 *   §5 A wiki with no entities/, concepts/ or summaries/: the ingest succeeds.
 *   §6 What cannot be written is refused BEFORE any model call (the stub counts
 *      calls): log.md or index.md a folder, a page folder a file, wiki/ read-only,
 *      log.md a link, the summary path a folder. raw/ keeps no copy.
 *   §7 After the calls: one page that cannot be saved is named and the rest are
 *      written; a link's target outside the wiki is never written through.
 *   §8 After the calls: log.md failing (made a folder mid-run) is a warning, not a
 *      lost ingest; every page failing is a plain error that says it was charged.
 *
 * Every model is a fake (`opts.llm`); no network. Domains and user data live in a
 * temp directory.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, symlinkSync, chmodSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a, b, label) { ok(a === b, label, `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
const section = (t) => console.log(`\n${t}`);

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-foreign-'));
const USER_DATA = path.join(TMP_ROOT, 'userdata');
const DOMAINS = path.join(TMP_ROOT, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.CURATOR_TEST_INSTANCE_DIR = path.join(TMP_ROOT, 'instances');
process.env.CURATOR_NO_OPEN = '1';
for (const k of ['LLM_MODEL', 'LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];
process.env.GEMINI_API_KEY = 'placeholder-not-a-real-key';

const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── Single-byte encoders, written out here so the test does not lean on the code
// under test (or on a dependency) to make its fixtures. ──────────────────────
const CP1252 = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, 'Š': 0x8a, 'š': 0x9a, 'Ž': 0x8e, 'ž': 0x9e, 'Œ': 0x8c, 'œ': 0x9c, 'Ÿ': 0x9f };
const CP1250 = { '€': 0x80, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97,
  'Š': 0x8a, 'Ś': 0x8c, 'Ť': 0x8d, 'Ž': 0x8e, 'Ź': 0x8f, 'š': 0x9a, 'ś': 0x9c, 'ť': 0x9d, 'ž': 0x9e, 'ź': 0x9f,
  'Ł': 0xa3, 'Ą': 0xa5, 'Ż': 0xaf, 'ł': 0xb3, 'ą': 0xb9, 'ż': 0xbf, 'Č': 0xc8, 'č': 0xe8, 'Ć': 0xc6, 'ć': 0xe6,
  'Đ': 0xd0, 'đ': 0xf0, 'ę': 0xea, 'ě': 0xec, 'ń': 0xf1, 'ň': 0xf2, 'ř': 0xf8, 'ů': 0xf9, 'ď': 0xef, 'á': 0xe1, 'é': 0xe9,
  'í': 0xed, 'ó': 0xf3, 'ú': 0xfa, 'ý': 0xfd, 'ö': 0xf6, 'ü': 0xfc, 'ä': 0xe4, 'Ř': 0xd8 };
const ISO2 = { 'Š': 0xa9, 'š': 0xb9, 'Ž': 0xae, 'ž': 0xbe, 'Č': 0xc8, 'č': 0xe8, 'Ć': 0xc6, 'ć': 0xe6, 'Đ': 0xd0, 'đ': 0xf0,
  'Ł': 0xa3, 'ł': 0xb3, 'ą': 0xb1, 'ż': 0xbf, 'ś': 0xb6, 'ź': 0xbc, 'ę': 0xea, 'ń': 0xf1, 'ó': 0xf3, 'é': 0xe9, 'á': 0xe1 };
function encode(text, table, latin1Rest) {
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (table[ch] !== undefined) out.push(table[ch]);
    else if (latin1Rest && c >= 0xa0 && c <= 0xff) out.push(c);
    else throw new Error(`fixture: no byte for ${ch}`);
  }
  return Buffer.from(out);
}
const enc1252 = (t) => encode(t, CP1252, true);
const enc1250 = (t) => encode(t, CP1250, false);
const encIso2 = (t) => encode(t, ISO2, false);

const SLOVENE = 'Življenje v Ljubljani je čudovito. Češnje cvetijo, šola se začne, žaba skoči v potok. ' +
  'Šolarji in učitelji se zberejo na trgu, kjer je glasba. Čeprav je zima, je vzdušje toplo in živahno. ';
const CROATIAN = 'Ćevapi su đački obrok; čaša vode, šećer i život na moru. Đuro je kupio kuću u Zagrebu, a Željko piše pjesme. ';
const CZECH = 'Příliš žluťoučký kůň úpěl ďábelské ódy. Řeka teče pod mostem a děti běží domů. ';
const POLISH = 'Zażółć gęślą jaźń. Łódź jest miastem, a źródło wody płynie przez świat. ';
const FRENCH = 'L’été à Paris était très agréable : le garçon a mangé une crème brûlée près de la fenêtre. ' +
  '« Où est-il ? » demanda-t-elle. Noël approche, le cœur léger – c’est la fête, déjà… ';
const GERMAN = 'Die Größe des Gebäudes überrascht. Füße, Äpfel, Öl und die Straße am Fluß. ';
const SPANISH = '¿Dónde está el niño? ¡Mañana iremos a la montaña con la señora Muñoz! ';

const { decodeTextBuffer } = await import('../src/brain/text-decode.js');

section('§1 decodeTextBuffer');
{
  for (const [label, text] of [
    ['ASCII', 'plain ascii text only\n'],
    ['UTF-8 Slovene', SLOVENE],
    ['UTF-8 French', FRENCH],
    ['UTF-8 emoji and CJK', 'Notes 📚 — 東京 and naïve café\n'],
    ['UTF-8 with BOM', '﻿# Heading\nčšž é\n'],
    ['empty', ''],
  ]) {
    const buf = Buffer.from(text, 'utf8');
    const r = decodeTextBuffer(buf);
    ok(r.text === buf.toString('utf8') && r.converted === false && r.encoding === 'utf-8', `${label}: read exactly as toString('utf8'), not converted`);
  }
  // Withdrawn 2026-11-15: no single-byte encoding is guessed. Every non-UTF-8 file,
  // whatever it was saved as, reads exactly as the old readFile(p, 'utf8') did.
  const cases = [
    ['Slovene, Windows-1250', SLOVENE.repeat(2), enc1250],
    ['Slovene, ISO-8859-2', SLOVENE.repeat(2), encIso2],
    ['Croatian, Windows-1250', CROATIAN.repeat(2), enc1250],
    ['Czech, Windows-1250', CZECH.repeat(2), enc1250],
    ['Polish, ISO-8859-2', POLISH.repeat(2), encIso2],
    ['French with curly quotes and œ, Windows-1252', FRENCH.repeat(2), enc1252],
    ['German, Windows-1252', GERMAN.repeat(2), enc1252],
    ['Spanish, Windows-1252', SPANISH.repeat(2), enc1252],
  ];
  for (const [label, text, encoder] of cases) {
    const buf = encoder(text);
    const r = decodeTextBuffer(buf);
    ok(r.text === buf.toString('utf8') && r.encoding === 'utf-8' && !r.converted, `${label}: the old UTF-8 read, never a guessed conversion`);
    ok(r.notUtf8 === true && !r.strayBytes, `${label}: flagged as not UTF-8`);
  }
  {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SLOVENE, 'utf16le')]);
    const r = decodeTextBuffer(le);
    ok(r.text === SLOVENE && r.encoding === 'utf-16le' && r.converted, 'UTF-16 LE with a BOM decodes');
    const be = Buffer.from(Buffer.from(SLOVENE, 'utf16le')).swap16();
    const r2 = decodeTextBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    ok(r2.text === SLOVENE && r2.encoding === 'utf-16be', 'UTF-16 BE with a BOM decodes');
  }
  {
    const bin = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xe8, 0x9e, 0xff, 0x10, 0x01, 0x80]);
    const r = decodeTextBuffer(bin);
    ok(r.text === bin.toString('utf8') && !r.converted && !r.notUtf8 && !r.strayBytes, 'binary (a NUL) is the old lossy utf8 read, not reinterpreted');
    const ctrl = Buffer.from(Array.from({ length: 400 }, (_, i) => (i % 7 === 0 ? 0x01 : i % 5 === 0 ? 0xe8 : 0x61)));
    const r2 = decodeTextBuffer(ctrl);
    ok(r2.text === ctrl.toString('utf8') && !r2.converted, 'many control bytes: the old lossy read');
  }
}

// ── A domain and a scripted fake model ─────────────────────────────────────
let seq = 0;
function makeDomain({ log = true, index = true, folders = true } = {}) {
  const name = `d${++seq}`;
  const dd = path.join(DOMAINS, name);
  mkdirSync(path.join(dd, 'wiki'), { recursive: true });
  if (folders) for (const d of ['entities', 'concepts', 'summaries']) mkdirSync(path.join(dd, 'wiki', d), { recursive: true });
  writeFileSync(path.join(dd, 'CLAUDE.md'), '# Test domain schema\n', 'utf8');
  if (index) writeFileSync(path.join(dd, 'wiki', 'index.md'), '# Index\n\n| Page | Type | Summary |\n|---|---|---|\n', 'utf8');
  if (log) writeFileSync(path.join(dd, 'wiki', 'log.md'), '# Log\n\n', 'utf8');
  return {
    name, dir: dd, wiki: path.join(dd, 'wiki'),
    has: (rel) => existsSync(path.join(dd, 'wiki', rel)),
    read: (rel) => readFileSync(path.join(dd, 'wiki', rel), 'utf8'),
    rawFiles: () => { try { return readdirSync(path.join(dd, 'raw')).filter((f) => !f.startsWith('.')); } catch { return []; } },
  };
}
function sourceBytes(name, bytes) {
  const dir = path.join(TMP_ROOT, 'src', String(++seq));
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return p;
}
const quiet = async (fn) => {
  const e = console.error, w = console.warn;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};
function script(slug, pages, during = null) {
  const fn = async (schema, prompt, maxTokens, format, onWait, opts) => {
    fn.calls.push({ prompt });
    if (opts && typeof opts.onUsage === 'function') opts.onUsage({ inputTokens: 1000, outputTokens: 200, provider: 'gemini', model: 'gemini-3.5-flash-lite' });
    if (during) await during();
    return JSON.stringify({ title: slug, pages });
  };
  fn.calls = [];
  return fn;
}
const SUMMARY = (slug) => ({ path: `summaries/${slug}.md`, content: `# ${slug}\n\nSource: ${slug}.md\n\n## Key Takeaways\n- A point.\n\n## Entities Mentioned\n- [[ljubljana]]\n\n## Concepts Introduced or Referenced\n- [[spring-blossom]]\n` });
const ENTITY = { path: 'entities/ljubljana.md', content: '# Ljubljana\n\nThe capital of Slovenia.\n', summary: 'The capital of Slovenia' };
const CONCEPT = { path: 'concepts/spring-blossom.md', content: '# Spring Blossom\n\nCherry trees flower.\n', summary: 'Cherry trees flower' };
const pagesFor = (slug) => [SUMMARY(slug), ENTITY, CONCEPT];

const { ingestFile, sourceTextForGate, extractText } = await import('../src/brain/ingest.js');
const { readRawSourceText } = await import('../src/brain/raw-store.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);

const run = (dom, name, bytes, llm) => quiet(() => ingestFile(dom.name, sourceBytes(name, bytes), name, false, null, { llm }));
const runCatch = async (dom, name, bytes, llm) => { try { return { res: await run(dom, name, bytes, llm) }; } catch (err) { return { err }; } };
const convNotes = (res) => (res.warnings || []).filter((w) => /is not saved as UTF-8/.test(w));

section('§2 Ingest of non-UTF-8 sources');
{
  for (const [label, text, encoder] of [
    ['French, Windows-1252', FRENCH.repeat(3), enc1252],
    ['Slovene, Windows-1250', SLOVENE.repeat(2), enc1250],
    ['Slovene, ISO-8859-2', SLOVENE.repeat(2), encIso2],
  ]) {
    const dom = makeDomain();
    const bytes = encoder(text);
    const slug = `enc${seq}`;
    const llm = script(slug, pagesFor(slug));
    const res = await run(dom, `${slug}.md`, bytes, llm);
    eq(llm.calls.length, 1, `${label}: one model call`);
    ok(llm.calls[0].prompt.includes(bytes.toString('utf8')), `${label}: the model saw the old UTF-8 read, not a guess`);
    const n = convNotes(res);
    eq(n.length, 1, `${label}: one note`);
    ok((n[0] || '').includes(`"${slug}.md"`) && /replaced by \uFFFD/.test(n[0] || '') && /Save it as UTF-8 and ingest it again/.test(n[0] || ''), `${label}: the note names the file, says what was replaced and how to keep it`, n[0]);
    const raw = path.join(dom.dir, 'raw', `${slug}.md`);
    ok(existsSync(raw) && sha(readFileSync(raw)) === sha(bytes), `${label}: raw/ keeps the original bytes unchanged`);
    ok(dom.read('log.md').includes('is not saved as UTF-8'), `${label}: the note is in log.md too`);
  }
  {
    const dom = makeDomain();
    const u = Buffer.from(SLOVENE.repeat(4), 'utf8');
    const stray = Buffer.concat([u.subarray(0, 200), Buffer.from([0xe8]), u.subarray(200)]);
    const res = await run(dom, 'stray.md', stray, script('stray', pagesFor('stray')));
    ok((res.warnings || []).some((w) => /"stray\.md" has 1 byte that is not valid UTF-8/.test(w)), 'UTF-8 with one stray byte: a short note');
    eq(convNotes(res).length, 0, 'UTF-8 with one stray byte: not the full note');
  }
  {
    const dom = makeDomain();
    const llm = script('utf', pagesFor('utf'));
    const bytes = Buffer.from(SLOVENE.repeat(2), 'utf8');
    const res = await run(dom, 'utf.md', bytes, llm);
    eq(convNotes(res).length, 0, 'UTF-8 source: no conversion note');
    ok(llm.calls[0].prompt.includes(SLOVENE.trim()), 'UTF-8 source: the model saw the text exactly');
    ok(sha(readFileSync(path.join(dom.dir, 'raw', 'utf.md'))) === sha(bytes), 'UTF-8 source: raw/ unchanged');
  }
}

section('§3 The gate, extractText and the MCP read decode the same way');
{
  const bytes = enc1250(SLOVENE.repeat(2));
  const p = sourceBytes('gate.txt', bytes);
  const old = bytes.toString('utf8');
  ok(await sourceTextForGate(p, 'gate.txt') === old, 'sourceTextForGate: the old UTF-8 read');
  ok(await extractText(p) === old, 'extractText: the old UTF-8 read');
  const r = await readRawSourceText(p);
  ok((r.ok && r.text === old) || (!r.ok && r.reason === 'binary'), 'readRawSourceText (get_raw_source): the old read, and its old refusal when replacement characters are dense', JSON.stringify(r).slice(0, 120));
  const u = sourceBytes('gate-utf8.md', Buffer.from(FRENCH, 'utf8'));
  ok(await sourceTextForGate(u, 'gate-utf8.md') === FRENCH, 'sourceTextForGate: UTF-8 unchanged');
  const bin = sourceBytes('bin.txt', Buffer.concat([Buffer.from([0, 1, 2, 0xff, 0xfe, 0]), Buffer.alloc(300, 0xe8)]));
  const rb = await readRawSourceText(bin);
  ok(!rb.ok && rb.reason === 'binary', 'readRawSourceText still refuses a binary file');
}

section('§4 A wiki with no log.md and no index.md');
{
  const dom = makeDomain({ log: false, index: false });
  const llm = script('nolog', pagesFor('nolog'));
  const { res, err } = await runCatch(dom, 'nolog.md', Buffer.from(SLOVENE.repeat(2), 'utf8'), llm);
  ok(!err && res, 'the ingest succeeds', err && err.message);
  ok(dom.has('log.md') && /ingest \| nolog/.test(dom.read('log.md')), 'log.md is created with this ingest in it');
  ok(dom.has('index.md') && dom.read('index.md').includes('[[ljubljana]]') && dom.read('index.md').includes('[[spring-blossom]]'), 'index.md is created with the new pages');
  ok(dom.has('entities/ljubljana.md') && dom.has('concepts/spring-blossom.md') && dom.has('summaries/nolog.md'), 'the pages are written');
  ok(!(res?.warnings || []).some((w) => /did not finish/.test(w)), 'no step after the write failed');
}

section('§5 A wiki with no page folders');
{
  const dom = makeDomain({ folders: false, log: false, index: false });
  const llm = script('nofold', pagesFor('nofold'));
  const { res, err } = await runCatch(dom, 'nofold.md', Buffer.from(SLOVENE.repeat(2), 'utf8'), llm);
  ok(!err && res && dom.has('entities/ljubljana.md') && dom.has('summaries/nofold.md'), 'the ingest succeeds and creates the folders', err && err.message);
}

section('§6 Refused before any model call');
{
  const refusals = [
    ['log.md is a folder', (d) => { unlinkSync(path.join(d.wiki, 'log.md')); mkdirSync(path.join(d.wiki, 'log.md')); }, /wiki\/log\.md" is a folder/],
    ['index.md is a folder', (d) => { unlinkSync(path.join(d.wiki, 'index.md')); mkdirSync(path.join(d.wiki, 'index.md')); }, /wiki\/index\.md" is a folder/],
    ['entities is a file', (d) => { rmSync(path.join(d.wiki, 'entities'), { recursive: true }); writeFileSync(path.join(d.wiki, 'entities'), 'x'); }, /wiki\/entities" is a file/],
    ['wiki is a file', (d) => { rmSync(d.wiki, { recursive: true }); writeFileSync(d.wiki, 'x'); }, /"wiki" is a file/],
    ['log.md is a link', (d) => { const t = path.join(TMP_ROOT, `elsewhere-${seq}.md`); writeFileSync(t, '# outside\n'); unlinkSync(path.join(d.wiki, 'log.md')); symlinkSync(t, path.join(d.wiki, 'log.md')); }, /log\.md" is a symbolic link/],
    ['the summary path is a folder', (d) => { mkdirSync(path.join(d.wiki, 'summaries', 'refuse6.md')); }, /summaries\/refuse6\.md" is a folder/],
    ['wiki/ is read-only', (d) => { chmodSync(d.wiki, 0o555); }, /"wiki" is read-only/],
    ['concepts/ is read-only', (d) => { chmodSync(path.join(d.wiki, 'concepts'), 0o555); }, /"wiki\/concepts" is read-only/],
  ];
  let i = 0;
  for (const [label, breakIt, why] of refusals) {
    i++;
    const dom = makeDomain();
    breakIt(dom);
    const slug = `refuse${i}`;
    const llm = script(slug, pagesFor(slug));
    const { err } = await runCatch(dom, `${slug}.md`, Buffer.from(SLOVENE.repeat(2), 'utf8'), llm);
    try { chmodSync(dom.wiki, 0o755); chmodSync(path.join(dom.wiki, 'concepts'), 0o755); } catch { /* not every case */ }
    eq(llm.calls.length, 0, `${label}: no model call`);
    ok(err && err.code === 'INGEST_CANNOT_WRITE' && /nothing was charged/.test(err.message) && why.test(err.message), `${label}: one plain refusal naming it`, err && err.message);
    eq(dom.rawFiles().length, 0, `${label}: raw/ keeps no copy`);
  }
}

section('§7 One page that cannot be saved does not lose the others');
{
  const dom = makeDomain();
  const outside = path.join(TMP_ROOT, 'outside-target.md');
  writeFileSync(outside, '# Not in the wiki\n');
  const before = sha(readFileSync(outside));
  symlinkSync(outside, path.join(dom.wiki, 'concepts', 'spring-blossom.md'));
  const llm = script('onebad', pagesFor('onebad'));
  const { res, err } = await runCatch(dom, 'onebad.md', Buffer.from(SLOVENE.repeat(2), 'utf8'), llm);
  ok(!err && res, 'the ingest returns', err && err.message);
  ok(res && res.pagesWritten.includes('entities/ljubljana.md') && res.pagesWritten.some((p) => p.startsWith('summaries/')), 'the other pages are written', JSON.stringify(res && res.pagesWritten));
  ok((res?.warnings || []).some((w) => /concepts\/spring-blossom\.md" could not be saved/.test(w)), 'a warning names the page that was not saved');
  eq(sha(readFileSync(outside)), before, 'the link target outside the wiki is untouched');
  ok(/ingest \| onebad/.test(dom.read('log.md')), 'log.md records the ingest');
}

section('§8 After the calls: log.md failing, and every page failing');
{
  const dom = makeDomain();
  const llm = script('logbad', pagesFor('logbad'), async () => {
    unlinkSync(path.join(dom.wiki, 'log.md'));
    mkdirSync(path.join(dom.wiki, 'log.md'));   // changed under the ingest, after the check
  });
  const { res, err } = await runCatch(dom, 'logbad.md', Buffer.from(SLOVENE.repeat(2), 'utf8'), llm);
  ok(!err && res, 'a log.md that fails after the calls does not fail the ingest', err && err.message);
  ok((res?.warnings || []).some((w) => /Adding this ingest to log\.md did not finish/.test(w)), 'a warning says log.md was not updated');
  ok(dom.has('entities/ljubljana.md') && dom.read('index.md').includes('[[ljubljana]]'), 'the pages and the index row are saved');

  const dom2 = makeDomain();
  const folders = ['entities', 'concepts', 'summaries'].map((f) => path.join(dom2.wiki, f));
  const llm2 = script('allbad', pagesFor('allbad'), async () => { for (const f of folders) chmodSync(f, 0o555); });
  const r2 = await runCatch(dom2, 'allbad.md', Buffer.from(SLOVENE.repeat(2), 'utf8'), llm2);
  for (const f of folders) chmodSync(f, 0o755);
  ok(r2.err && /not one of its 3 page\(s\) could be saved/.test(r2.err.message) && /charged/.test(r2.err.message), 'every page failing is one plain error that says it was charged', r2.err && r2.err.message);
}

// ── Done ──────────────────────────────────────────────────────────────────
try {
  for (const d of readdirSync(DOMAINS)) { try { chmodSync(path.join(DOMAINS, d, 'wiki'), 0o755); } catch { /* */ } }
  rmSync(TMP_ROOT, { recursive: true, force: true });
} catch { /* temp dir */ }
section('§9 Never a guessed letter: one bad byte, other encodings, word salad (2026-11-15)');
{
  const rev = (label) => { const d = new TextDecoder(label); const m = new Map(); for (let b = 0x80; b < 0x100; b++) { const ch = d.decode(Buffer.from([b])); if (!m.has(ch)) m.set(ch, b); } return m; };
  const byMap = (m) => (t) => Buffer.from([...t].map((ch) => { const c = ch.codePointAt(0); if (c < 0x80) return c; if (!m.has(ch)) throw new Error(`fixture: no byte for ${ch}`); return m.get(ch); }));
  const old = (label, buf, flag) => {
    const r = decodeTextBuffer(buf);
    ok(r.text === buf.toString('utf8') && !r.converted && (flag ? r[flag] : true), label, `${r.encoding}: ${JSON.stringify(r.text.slice(0, 60))}`);
  };
  const u = Buffer.from(SLOVENE.repeat(10), 'utf8');
  const stray = Buffer.concat([u.subarray(0, 500), Buffer.from([0xe8]), u.subarray(500)]);
  old('UTF-8 with one stray byte: the old read, one U+FFFD', stray, 'strayBytes');
  eq(decodeTextBuffer(stray).strayBytes, 1, 'and it counts that byte');
  ok(!decodeTextBuffer(stray).notUtf8, 'not flagged as another encoding');
  const cut = u.subarray(0, u.lastIndexOf(Buffer.from('č')) + 1);
  old('UTF-8 cut mid-character: the old read', cut, 'strayBytes');
  for (const [label, enc, text] of [
    ['Polish zł (1250)', 'windows-1250', 'Faktura nr 12/2026. Kwota: 1 200 zł netto. Łącznie 15 zł.'],
    ['Czech Kč (1250)', 'windows-1250', 'Cena 12 Kč. Účet č. 44.'],
    ['Estonian (1252)', 'windows-1252', 'Õhtul on öö ja täna üks.'],
    ['French with € (ISO-8859-15)', 'iso-8859-15', 'Le cœur de l’œuvre coûte 250 €.'.replace('’', "'")],
    ['Turkish (1254)', 'windows-1254', 'Şirket yıllık raporu: gelirler arttı.'],
    ['Greek (1253)', 'windows-1253', 'Ετήσια έκθεση: τα έσοδα αυξήθηκαν.'],
    ['Russian (1251)', 'windows-1251', 'Годовой отчёт компании за 2025 год.'],
    ['MacRoman French', 'macintosh', 'Le garçon a mangé une crème brûlée.'],
  ]) old(`${label}: the old read, flagged, never converted`, byMap(rev(enc))(text), 'notUtf8');
  // Word salad: every high byte, in every order. The read is the old one by construction.
  let wrong = 0;
  for (let seed = 1; seed <= 400; seed++) {
    let x = seed; const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const bytes = Buffer.from(Array.from({ length: 60 }, () => (rnd() < 0.25 ? 0x80 + Math.floor(rnd() * 128) : 0x61 + Math.floor(rnd() * 26))));
    const r = decodeTextBuffer(bytes);
    if (r.text !== bytes.toString('utf8') || r.converted) wrong++;
  }
  eq(wrong, 0, 'word salad (400 random files): 0 reads other than the old one');
  // The ingest's note for an unknown encoding.
  const dom = makeDomain();
  const res = await run(dom, 'cyr.md', byMap(rev('windows-1251'))('Годовой отчёт компании за 2025 год. '.repeat(8)), script('cyr', pagesFor('cyr')));
  eq(convNotes(res).length, 1, 'ingest: one plain note for a Cyrillic file too');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
