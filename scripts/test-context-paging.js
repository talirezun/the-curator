/**
 * test-context-paging.js — OFFLINE. v3.70.0 package P1: the SEVEN-PRESET token
 * ladder, the 800 KB ceiling, and PAGED delivery of `get_project_context`.
 *
 * Why paging exists (DESIGN v3.70.0 §3.2): Claude Code shows an MCP reply of
 * at most 25,000 tokens by default and SAVES a larger one to a file, handing
 * the model a file reference instead. So a bootstrap the app measured as "in
 * the window" was not — every Deep/Max start and every untouched project with
 * ≳75 KB of documents. The MCP door now sends at most CONTEXT_PAGE_BYTES
 * (80 KB ≈ 20k tokens) of SERIALISED REPLY per call, whole documents only.
 *
 * What this suite proves, by EXECUTION against the real store and the real
 * handler (never by reading source):
 *
 *   0. A reply that fits one page is BYTE-IDENTICAL to v3.69.0's handler over
 *      four untouched fixtures × six option sets (the digest is pinned; the one
 *      value this release deliberately moves, `budget.cap`, is normalised and
 *      asserted on its own).
 *   1. The ladder: seven presets, bytes = tokens × 4, cap 800 KB; a 120 KB or
 *      200 KB budget stays valid, is stored as-is, and reads as CUSTOM.
 *   2. `deliveryPlan` (pure): whole documents, order kept, the exact 80 KB
 *      edge, an oversize document alone, page 1 never oversize.
 *   3. Every preset through the handler: walk EVERY page; the union of the
 *      pages is the store's document set, each document once, in order; every
 *      multi-document page measures ≤ 80 KB; `continuation` names the right
 *      next page, the right remaining count and the right slugs.
 *   4. An oversize document alone; one over the 300 KB per-reply guard listed,
 *      not sent. Page out of range, an invalid page. `slugs` are paged too.
 *   5. THE UNTOUCHED >80 KB DECISION: such a project is paged (not spilled).
 *   6. `replyDelivery`, the one delivery shape for the session-start report.
 *   7. The tool description (<3,200 B) and both skills say to fetch every page.
 *
 * ISOLATION: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR under the
 * OS temp dir, set before the store is imported, plus the in-process
 * overrides. No network, no LLM, no credential file.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

// The handoff text carries the machine segment (hostname-derived), and its
// LENGTH reaches `current.bytes`; pin it so the digest is the same everywhere
// (the lesson test-reading-budget.js recorded from CI run 35873448897).
os.hostname = () => 'context-paging-suite-host';
syncBuiltinESMExports();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-context-paging-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-context-paging-')) {
      rmSync(TMP, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
});

let passed = 0; let failed = 0;
const failures = [];
function ok(label) { passed++; console.log(`  ✓ ${label}`); }
function bad(label, err) { failed++; failures.push({ label, err }); console.log(`  ✗ ${label}`); if (err !== undefined) console.log(`    └─ ${err}`); }
function assert(cond, label, err) { cond ? ok(label) : bad(label, err === undefined ? 'assertion failed' : err); }
function eq(a, b, label) { assert(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function section(name) { console.log(`\n── ${name} ──`); }

const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);
const WS = await import('../src/brain/working-state.js');
const tools = await import('../mcp/tools/working-state.js');

const sha = (x) => createHash('sha256').update(x).digest('hex');
const measure = (o) => Buffer.byteLength(JSON.stringify(o, null, 2), 'utf8');
function makeDomain(slug) {
  mkdirSync(path.join(DOMAINS, slug, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, slug, 'CLAUDE.md'), `# ${slug}\n`);
  writeFileSync(path.join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
}
const body = (label, kb) => `# ${label}\n\n${'Line of text https://example.com here.\n'.repeat(Math.ceil((kb * 1024) / 39))}`;
const handler = (args) => tools.getProjectContextHandler(args, null);

// ═════════════════════════════════════════════════════════════════════════
// §0 fixture — built with v3.69.0-era calls only, so the SAME code produced
// the pinned digest on main = 6e1f2b2 before this package changed anything.
// ═════════════════════════════════════════════════════════════════════════
makeDomain('fit');
await WS.saveProjectBriefText('fit', 'fit', '# fit\n\n## Goal\n\nBuild it.\n');
for (const p of ['unflag', 'flag', 'empty']) await WS.createProject('fit', p, {});
for (const p of ['fit', 'unflag', 'flag', 'empty']) {
  await WS.saveWorkingState('fit', {
    project: p === 'fit' ? undefined : p, scope: 'main', headline: `handoff ${p}`,
    nowState: 'Now.', decisions: ['d1'], nextSteps: ['n1'], harness: 'suite', model: 'none',
  });
}
for (const p of ['fit', 'unflag', 'flag']) {
  await WS.saveFoundation('fit', p, { slug: 'architecture.md', role: 'architecture', text: body('Arch', 20), readFirst: p === 'flag' ? true : undefined });
  await WS.saveFoundation('fit', p, { slug: 'roadmap.md', role: 'roadmap', text: body('Road', 30) });
  await WS.saveFoundation('fit', p, { slug: 'guide.md', role: 'guide', text: body('Guide', 5) });
}
const FIT_CASES = ['fit', 'unflag', 'flag', 'empty'];
// `{page: 1}` is in the set on purpose: an explicit first page of a reply
// that fits must be the same bytes as no `page` at all (v3.69.0 ignored it).
const FIT_OPTS = [{}, { include: 'all' }, { include: 'index' }, { max_bytes: 20000 }, { slugs: ['guide.md'] }, { page: 1 }];
const TIME_KEY = /(At|Seconds|Age|age|Ms)$|^mtime$|^updatedAt$|^savedAt$/;
async function fitDigest() {
  const all = {};
  let machine = null;
  const caps = new Set();
  let maxReply = 0;
  for (const p of FIT_CASES) {
    for (const o of FIT_OPTS) {
      const r = await handler({ domain: 'fit', project: p, ...o });
      if (!machine && r.machine) machine = r.machine;
      maxReply = Math.max(maxReply, measure(r));
      all[`${p} ${JSON.stringify(o)}`] = r;
    }
  }
  const strip = (v, parentKey) => {
    if (Array.isArray(v)) return v.map((x) => strip(x));
    if (!v || typeof v !== 'object') return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (TIME_KEY.test(k)) continue;
      // THE ONE VALUE v3.70.0 MOVES ON PURPOSE: the store ceiling 200 KB →
      // 800 KB. Normalised here, asserted separately below.
      if (parentKey === 'budget' && k === 'cap') { caps.add(x); o[k] = '<cap>'; continue; }
      o[k] = strip(x, k);
    }
    return o;
  };
  let json = JSON.stringify(strip(all), null, 2);
  if (machine) json = json.split(machine).join('<machine>');
  json = json.split(TMP).join('<tmp>');
  json = json.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
  json = json.replace(/\b\d+ (second|minute|hour)s? ago\b/g, '<ago>');
  // THE ONE SENTENCE v3.76.0 CHANGES ON PURPOSE (truth audit F1): the report
  // said "saved <the FILE's mtime>" and now says "written <the agent's own
  // time>" (plus the arrival time only when the two differ, which a fresh
  // fixture never does). Mapped back here so the rest stays pinned to
  // v3.69.0; the new wording is asserted on its own in §0.
  json = json.replace(/, written <ts>\./g, ', saved <ts>.');
  if (process.env.CP_DUMP) writeFileSync(process.env.CP_DUMP, json);
  return { digest: sha(json), bytes: json.length, caps: [...caps], maxReply };
}
// v3.69.0's handler (main = 6e1f2b2) over this exact fixture, with `budget.cap`
// normalised the same way. Derived 2026-09-24 by running this fixture on the
// unchanged worktree before any P1 edit (raw digest d320e145…, 959,887 bytes;
// the only diff against this branch's raw output was the 24 `cap` values).
const FIT_BASELINE = '11861c5c3a99df1be46560ad1c34a0444a9f31307e081d86b14decd0b4358589';

section('0. A REPLY THAT FITS ONE PAGE IS BYTE-IDENTICAL TO v3.69.0');
{
  const b = await fitDigest();
  assert(b.maxReply <= WS.CONTEXT_PAGE_BYTES, `PRECONDITION: every fixture reply fits one page (largest ${b.maxReply} B ≤ ${WS.CONTEXT_PAGE_BYTES})`);
  assert(b.maxReply > WS.CONTEXT_PAGE_BYTES - 8 * 1024, `PRECONDITION: …and the largest is within 8 KB of the edge, so the page check is exercised near its boundary (${b.maxReply} B)`);
  eq(b.digest, FIT_BASELINE, `the handler over 4 untouched fixtures × 6 option sets hashes to v3.69.0's digest (${b.bytes} normalised bytes)`);
  eq(JSON.stringify(b.caps), JSON.stringify([WS.CONTEXT_MAX_BYTES_CAP]), '…and `budget.cap` reports the new 800 KB ceiling everywhere');
  const one = await handler({ domain: 'fit', project: 'unflag' });
  assert(!('page' in one.foundations) && !('continuation' in one.foundations) && !('delivery' in one.foundations),
    'a fitting reply carries NO paging field (page / continuation / delivery)');
  assert(!/PAGED/.test(one.report), '…and no paging sentence in its report');
  // v3.76.0 (F1): the report names the handoff's WRITTEN time — the agent's
  // own clock — never the file's date as "saved".
  assert(one.current && one.current.writtenAt && one.report.includes(`, written ${one.current.writtenAt}.`)
    && !/, saved \d{4}-/.test(one.report), `the report says "written <writtenAt>" (${one.report.slice(0, 160)})`);
}

section('1. THE LADDER — seven presets in tokens, 800 KB cap, legacy values are CUSTOM');
{
  eq(WS.BYTES_PER_TOKEN, 4, 'BYTES_PER_TOKEN');
  eq(JSON.stringify(WS.READING_BUDGET_PRESETS.map((p) => [p.id, p.tokens, p.bytes])), JSON.stringify([
    ['index-only', 0, 0], ['lean', 8192, 32768], ['standard', 16384, 65536], ['deep', 32768, 131072],
    ['large', 65536, 262144], ['extra-large', 131072, 524288], ['max', 204800, 819200],
  ]), 'the seven presets, ids · tokens · bytes (DESIGN §3.1: 0 · 8k · 16k · 32k · 64k · 128k · 200k)');
  assert(WS.READING_BUDGET_PRESETS.every((p) => p.bytes === p.tokens * WS.BYTES_PER_TOKEN), 'every preset is tokens × 4 bytes');
  assert(WS.READING_BUDGET_PRESETS.every((p) => Object.isFrozen(p)) && Object.isFrozen(WS.READING_BUDGET_PRESETS), '…frozen');
  eq(WS.READING_BUDGET_RECOMMENDED, 'standard', 'Standard is still the recommendation');
  eq(WS.CONTEXT_MAX_BYTES_CAP, 800 * 1024, 'CONTEXT_MAX_BYTES_CAP is 800 KB');
  eq(WS.CONTEXT_MAX_BYTES_CAP, WS.READING_BUDGET_PRESETS[WS.READING_BUDGET_PRESETS.length - 1].bytes, '…which is exactly Max');
  eq(WS.CONTEXT_MAX_BYTES_DEFAULT, 120 * 1024, 'the untouched default is unchanged at 120 KB');
  eq(WS.CONTEXT_PAGE_BYTES, 80 * 1024, 'CONTEXT_PAGE_BYTES is 80 KB (≈20k tokens)');
  assert(WS.isValidReadingBudget(819200) && !WS.isValidReadingBudget(819201), 'isValidReadingBudget accepts 800 KB and refuses one byte more');
  for (const p of WS.READING_BUDGET_PRESETS) {
    const r = WS.readingBudgetPreset(p.bytes);
    assert(r && r.id === p.id && r.custom === false && r.tokens === p.tokens, `readingBudgetPreset(${p.bytes}) → ${p.id}`, JSON.stringify(r));
  }
  const c120 = WS.readingBudgetPreset(122880);
  eq(JSON.stringify(c120), JSON.stringify({ id: 'custom', tokens: 30720, bytes: 122880, custom: true, nearest: 'deep' }), 'v3.67.0 Deep (120 KB) reads Custom · 30k tokens, nearest Deep');
  const c200 = WS.readingBudgetPreset(204800);
  eq(JSON.stringify(c200), JSON.stringify({ id: 'custom', tokens: 51200, bytes: 204800, custom: true, nearest: 'large' }), 'v3.67.0 Max (200 KB) reads Custom · 51k tokens, nearest Large');
  eq(WS.readingBudgetPreset(null), null, 'no budget → null (unplanned)');
  eq(WS.readingBudgetPreset(100), null, 'an invalid value → null, as readProjectMeta reads it');
  eq(WS.estimateTokens(81920), 20480, 'estimateTokens(80 KB) = 20,480');

  // Stored as-is, never migrated; an owner budget of a legacy value applies.
  makeDomain('lad');
  await WS.createProject('lad', 'legacy', {});
  await WS.saveFoundation('lad', 'legacy', { slug: 'a.md', role: 'architecture', text: body('A', 4), readFirst: true });
  const metaAbs = path.join(DOMAINS, 'lad', 'state', 'legacy', 'project.json');
  for (const v of [122880, 204800]) {
    const s = await WS.setReadingBudget('lad', 'legacy', v);
    assert(s.ok === true && s.readingBudgetBytes === v, `setReadingBudget(${v}) is still accepted`);
    eq(JSON.parse(readFileSync(metaAbs, 'utf8')).readingBudgetBytes, v, `…stored as ${v}, not moved to a preset`);
    const ctx = await WS.getProjectContext('lad', 'legacy', {});
    assert(ctx.foundations.budget.maxBytes === v && ctx.foundations.budget.source === 'owner', `…and the bootstrap applies ${v} as the owner's`);
  }
  for (const p of WS.READING_BUDGET_PRESETS) {
    const s = await WS.setReadingBudget('lad', 'legacy', p.bytes);
    assert(s.ok === true, `setReadingBudget accepts preset ${p.id} (${p.bytes})`);
  }
  const over = await WS.setReadingBudget('lad', 'legacy', 819201);
  eq(over.reason, 'invalid-reading-budget', 'one byte over 800 KB is refused');
}

section('2. deliveryPlan — pure: whole documents, order kept, the exact edge, oversize alone');
{
  const P = WS.CONTEXT_PAGE_BYTES;
  const dp = WS.deliveryPlan;
  let r = dp([], { firstPageFixedBytes: 5000 });
  assert(r.replies === 1 && r.pages[0].slugs.length === 0 && r.pages[0].bytes === 5000 && r.paged === false, 'no documents → one page carrying only its fixed bytes');
  r = dp([{ slug: 'a', bytes: P - 1000 }], { firstPageFixedBytes: 1000 });
  assert(r.replies === 1 && r.pages[0].bytes === P, 'EXACT EDGE: fixed + document = 80 KB exactly → one page');
  r = dp([{ slug: 'a', bytes: P - 999 }], { firstPageFixedBytes: 1000, laterPageFixedBytes: 500 });
  assert(r.replies === 2 && r.pages[0].slugs.length === 0 && JSON.stringify(r.pages[1].slugs) === '["a"]' && r.pages[1].oversize === false,
    'one byte over → page 1 keeps the fixed layers alone and the document starts page 2 (it fits an empty later page)', JSON.stringify(r));
  r = dp([{ slug: 'a', bytes: 10 }, { slug: 'b', bytes: P + 5 }, { slug: 'c', bytes: 10 }], { firstPageFixedBytes: 100, laterPageFixedBytes: 100 });
  eq(JSON.stringify(r.pages.map((p) => [p.slugs, p.oversize])), JSON.stringify([[['a'], false], [['b'], true], [['c'], false]]),
    'an OVERSIZE document goes ALONE on its own page, flagged, and the next one starts a fresh page');
  eq(JSON.stringify(r.oversize), '["b"]', '`oversize` names it');
  r = dp([{ slug: 'big', bytes: P * 2 }], { firstPageFixedBytes: 100, laterPageFixedBytes: 100 });
  assert(r.pages[0].slugs.length === 0 && r.pages[1].oversize === true && r.replies === 2, 'page 1 NEVER carries an oversize document');
  r = dp([{ slug: 'a', bytes: 10 }], { firstPageFixedBytes: P + 10, laterPageFixedBytes: 100 });
  assert(r.replies === 2 && r.pages[0].slugs.length === 0, 'fixed layers alone over a page → page 1 carries them, documents start page 2');
  const items = Array.from({ length: 30 }, (_, i) => ({ slug: `d${i}`, bytes: 7000 + i * 311 }));
  r = dp(items, { firstPageFixedBytes: 20000, laterPageFixedBytes: 1500 });
  eq(JSON.stringify(r.pages.flatMap((p) => p.slugs)), JSON.stringify(items.map((i) => i.slug)), 'the pages concatenate to the input, in order, each once');
  assert(r.pages.every((p) => p.oversize || p.bytes <= P), 'every non-oversize page is ≤ 80 KB');
  // Greedy is tight: no page could have taken the next page's first document.
  assert(r.pages.slice(0, -1).every((p, i) => p.bytes + items.find((x) => x.slug === r.pages[i + 1].slugs[0]).bytes > P),
    '…and each page closed only because the NEXT document would not fit');
  assert(r.pages.every((p) => p.tokens === Math.round(p.bytes / 4)), '`tokens` per page is bytes ÷ 4');
}

// ═════════════════════════════════════════════════════════════════════════
// A planned project with 870 KB of read-first documents: enough to fill Max.
// ═════════════════════════════════════════════════════════════════════════
makeDomain('pg');
await WS.saveProjectBriefText('pg', 'pg', `# pg\n\n## Goal\n\n${'Brief line.\n'.repeat(400)}`);
await WS.saveWorkingState('pg', { scope: 'main', headline: 'handoff pg', nowState: 'Now '.repeat(500), decisions: ['d1'], nextSteps: ['n1'], harness: 'suite', model: 'none' });
const SIZES = [20, 20, 20, 20, 20, 40, 40, 40, 40, 40, 60, 60, 60, 90, 50, 50, 50, 50];
for (let i = 0; i < SIZES.length; i++) {
  const slug = `doc-${String(i).padStart(2, '0')}.md`;
  const s = await WS.saveFoundation('pg', 'pg', { slug, role: 'guide', text: body(`Doc ${i}`, SIZES[i]), readFirst: true });
  if (!s.ok) throw new Error(`fixture: ${slug}: ${s.message}`);
}

/** Walk every page of one bootstrap; return what the agent would hold. */
async function walk(args) {
  const first = await handler(args);
  if (!first.ok) return { first, pages: [first], of: 0 };
  const of = first.foundations.of || 1;
  const pages = [first];
  for (let n = 2; n <= of; n++) pages.push(await handler({ ...args, page: n }));
  return { first, pages, of };
}
const slugsOf = (r) => [...(r.foundations.documents || []), ...(r.foundations.requested || [])].map((d) => d.slug);

section('3. EVERY PRESET, EVERY PAGE — union = the store\'s set, each once, ≤ 80 KB per page');
for (const p of WS.READING_BUDGET_PRESETS) {
  await WS.setReadingBudget('pg', 'pg', p.bytes);
  const store = await WS.getProjectContext('pg', 'pg', {});
  const want = store.foundations.documents.map((d) => d.slug);
  eq(store.foundations.budget.maxBytes, p.bytes, `${p.id}: the store applies ${p.bytes} bytes`);
  assert(store.foundations.budget.usedBytes <= p.bytes, `${p.id}: document text used (${store.foundations.budget.usedBytes}) ≤ the preset`);
  const { pages, of } = await walk({ domain: 'pg', project: 'pg' });
  assert(pages.every((r) => r.ok === true), `${p.id}: all ${of} page(s) answer ok`);
  const got = pages.flatMap(slugsOf);
  eq(JSON.stringify(got), JSON.stringify(want), `${p.id}: the pages' union is the store's read-first selection, in reading order, each once (${want.length} docs, ${of} page${of === 1 ? '' : 's'})`);
  eq(new Set(got).size, got.length, `${p.id}: no document arrives twice`);
  const sizes = pages.map(measure);
  assert(pages.every((r, i) => slugsOf(r).length <= 1 || sizes[i] <= WS.CONTEXT_PAGE_BYTES),
    `${p.id}: every page carrying more than one document measures ≤ 80 KB (max ${Math.max(...sizes)} B)`, JSON.stringify(sizes));
  if (of > 1) {
    const d = pages[0].foundations.delivery;
    eq(d.replies, of, `${p.id}: delivery.replies = ${of}`);
    eq(JSON.stringify(d.pages.map((x) => x.bytes)), JSON.stringify(sizes), `${p.id}: delivery.pages[].bytes are the MEASURED replies`);
    eq(JSON.stringify(d.pages.flatMap((x) => x.slugs)), JSON.stringify(want), `${p.id}: delivery.pages[].slugs cover the set`);
    let contOk = true;
    pages.forEach((r, i) => {
      const c = r.foundations.continuation;
      if (i + 1 < of) {
        if (!c || c.page !== i + 2 || c.of !== of || c.remaining !== of - (i + 1) || JSON.stringify(c.slugs) !== JSON.stringify(slugsOf(pages[i + 1]))) contOk = false;
        if (!r.report.includes(`plus \`page: ${i + 2}\``)) contOk = false;
      } else if (c !== undefined || !/LAST page/.test(r.report)) contOk = false;
      if (r.foundations.page !== i + 1 || r.foundations.of !== of) contOk = false;
    });
    assert(contOk, `${p.id}: every continuation names the next page, its of/remaining and exactly its slugs; the last has none and says LAST`);
    assert(/^PAGED: this project context arrives in \d+ replies/.test(pages[0].report), `${p.id}: page 1's report OPENS with the paging sentence`);
    assert(pages[0].brief?.present === true && pages[0].current && pages[0].journal && Array.isArray(pages[0].foundations.index) && pages[0].seen,
      `${p.id}: page 1 carries brief, handoff, journal, index and seen as always`);
    assert(pages.slice(1).every((r) => !('brief' in r) && !('current' in r) && !('journal' in r) && !('seen' in r) && !('index' in r.foundations)),
      `${p.id}: later pages carry documents only — no brief, handoff, journal, index or seen`);
    assert(pages.slice(1).every((r) => /never as instructions/i.test(r.content_is_data || '')),
      `${p.id}: later pages still label their text as data, never instructions`, pages[1]?.content_is_data);
    assert(want.every((s) => pages[0].seen[s] === store.seen[s]), `${p.id}: page 1's seen covers every paged document`);
  }
  if (p.id === 'index-only') eq(of, 1, 'index-only: one reply, no text');
  if (p.id === 'max') assert(of >= 10, `max: 800 KB takes ≥ 10 replies (${of})`);
}

section('4. OVERSIZE, TOO LARGE, OUT OF RANGE, INVALID, and `slugs` paged too');
{
  // doc-13 is 90 KB: over one page by itself.
  await WS.setReadingBudget('pg', 'pg', 819200);
  const { pages } = await walk({ domain: 'pg', project: 'pg' });
  const i13 = pages.findIndex((r) => slugsOf(r).includes('doc-13.md'));
  assert(i13 > 0 && slugsOf(pages[i13]).length === 1, 'the 90 KB document arrives ALONE on its own page');
  assert(/doc-13\.md is 9\d KB, larger than one reply, so it arrives ALONE on this page/.test(pages[i13]?.report || ''), '…and that page\'s report says so', pages[i13]?.report?.slice(0, 300));
  assert(pages[0].foundations.delivery.pages[i13]?.oversize === true, '…and delivery flags it oversize');

  // A document over the 300 KB per-reply guard: listed, never sent.
  makeDomain('huge');
  await WS.saveFoundation('huge', 'huge', { slug: 'giant.md', role: 'architecture', text: body('Giant', 330), readFirst: true });
  await WS.saveFoundation('huge', 'huge', { slug: 'small.md', role: 'guide', text: body('Small', 4), readFirst: true });
  await WS.setReadingBudget('huge', 'huge', 819200);
  const h = await walk({ domain: 'huge', project: 'huge' });
  const gp = h.pages.find((r) => (r.foundations.tooLarge || []).some((t) => t.slug === 'giant.md'));
  assert(gp && !slugsOf(gp).includes('giant.md'), 'a 330 KB document is NOT sent (over the 300 KB per-reply guard) …');
  assert(gp && /NOT sent, too large for any one MCP reply: giant\.md \(33\d KB\)/.test(gp.report), '…and is NAMED with its size in that page\'s report', gp?.report);
  assert(h.pages.every((r) => measure(r) <= 300 * 1024), '…so no page exceeds the 300 KB guard');
  assert(h.pages.flatMap(slugsOf).includes('small.md'), '…and the rest still arrives');

  // Out of range and invalid.
  const fitOver = await handler({ domain: 'fit', project: 'unflag', page: 2 });
  assert(fitOver.ok === false && fitOver.reason === 'page-out-of-range' && fitOver.pages === 1 && /there is no page 2/.test(fitOver.error),
    'page 2 of a one-page context → page-out-of-range, pages: 1', JSON.stringify(fitOver));
  const of = pages[0].foundations.of;
  const past = await handler({ domain: 'pg', project: 'pg', page: of + 1 });
  assert(past.ok === false && past.reason === 'page-out-of-range' && past.pages === of && new RegExp(`from 1 to ${of}`).test(past.error),
    `page ${of + 1} of ${of} → page-out-of-range naming the range`, JSON.stringify(past));
  for (const v of [0, -1, 1.5, 'two', true]) {
    const r = await handler({ domain: 'pg', project: 'pg', page: v });
    assert(r.ok === false && r.reason === 'invalid-page', `page ${JSON.stringify(v)} → invalid-page`, JSON.stringify(r));
  }
  const str = await handler({ domain: 'pg', project: 'pg', page: '2' });
  assert(str.ok === true && str.foundations.page === 2, 'page "2" (a numeric string, as some clients send) is page 2');

  // `slugs` naming a large document on a project that otherwise fits.
  makeDomain('req');
  await WS.saveFoundation('req', 'req', { slug: 'small.md', role: 'architecture', text: body('Small', 5) });
  await WS.saveFoundation('req', 'req', { slug: 'big.md', role: 'guide', text: body('Big', 100) });
  await WS.setReadingBudget('req', 'req', 0);
  const rq = await walk({ domain: 'req', project: 'req', slugs: ['big.md'] });
  assert(rq.of === 2 && (rq.pages[1]?.foundations.requested || []).map((d) => d.slug).join() === 'big.md',
    'a named 100 KB document is paged too: it arrives WHOLE in `requested` on page 2', `of=${rq.of}`);
  assert(rq.pages[1]?.foundations.requested[0]?.truncated === false, '…whole, not cut');
}

section('5. THE UNTOUCHED >80 KB DECISION — paged, never spilled');
{
  // No budget, nothing read first: v3.61.1's row sends every body within the
  // 120 KB default on a first session. 3 × 30 KB fits the default and is over
  // one page, so v3.69.0 sent one ≈100 KB reply that Claude Code saved to a
  // file. v3.70.0 pages it: the SAME document set, in two replies.
  makeDomain('bigu');
  await WS.saveProjectBriefText('bigu', 'bigu', '# bigu\n\n## Goal\n\nBuild it.\n');
  for (const [s, r] of [['architecture.md', 'architecture'], ['decisions.md', 'decisions'], ['roadmap.md', 'roadmap']]) {
    await WS.saveFoundation('bigu', 'bigu', { slug: s, role: r, text: body(s, 30) });
  }
  const store = await WS.getProjectContext('bigu', 'bigu', {});
  assert(store.foundations.planned === false && store.foundations.bodySelection === 'all' && store.foundations.documents.length === 3,
    'PRECONDITION: untouched — unplanned, bodySelection all, all 3 documents selected by the store (unchanged)');
  const { pages, of } = await walk({ domain: 'bigu', project: 'bigu' });
  assert(of >= 2, `an untouched project whose reply would exceed 80 KB is PAGED (${of} replies), not spilled`);
  eq(JSON.stringify(pages.flatMap(slugsOf)), JSON.stringify(store.foundations.documents.map((d) => d.slug)), '…and the pages carry exactly the documents v3.69.0 sent, in order');
  assert(pages.every((r) => measure(r) <= WS.CONTEXT_PAGE_BYTES), '…every reply ≤ 80 KB');
  // With every hash seen (a later session, nothing changed), the delta rule
  // is untouched and the reply fits one page again.
  const again = await handler({ domain: 'bigu', project: 'bigu', seen_hashes: pages[0].seen });
  assert(again.ok && !again.foundations.continuation && again.foundations.documents.length === 0, 'with every hash seen, the next session is one small reply again');
}

section('6. replyDelivery — one shape for paged and unpaged (for the session-start measurement)');
{
  const unp = await handler({ domain: 'fit', project: 'flag' });
  const d1 = tools.replyDelivery(unp);
  assert(d1.replies === 1 && d1.paged === false && d1.pages[0].bytes === measure(unp) && d1.totalBytes === measure(unp)
    && JSON.stringify(d1.pages[0].slugs) === '["architecture.md"]', 'unpaged: one page of the measured reply, its slugs', JSON.stringify(d1));
  await WS.setReadingBudget('pg', 'pg', 262144);
  const { pages, of } = await walk({ domain: 'pg', project: 'pg' });
  const d2 = tools.replyDelivery(pages[0]);
  assert(d2.replies === of && d2.paged === true && d2.totalBytes === pages.reduce((n, r) => n + measure(r), 0),
    'paged: replies, and totalBytes = the sum of every measured page');
  eq(tools.replyDelivery({ ok: false }), null, 'a refusal has no delivery');
}

section('7. THE DESCRIPTION AND BOTH SKILLS — fetch every page');
{
  const d = tools.getProjectContextDefinition;
  const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
  assert(bytes < 3200, `get_project_context definition is ${bytes} B (< 3,200 B ceiling)`);
  assert(d.description.includes('A large context arrives in PAGES: while `foundations.continuation` is present, call again with the same arguments plus its `page`; read EVERY page before starting work.'),
    'the description carries the paging sentence');
  assert(d.inputSchema.properties.page?.type === 'number' && /continuation/.test(d.inputSchema.properties.page.description), '`page` is declared, and points at continuation');
  assert(/max 800 KB/.test(d.inputSchema.properties.max_bytes.description), 'max_bytes names the 800 KB ceiling');
  for (const kw of ['start a session', 'load the project context', 'what should I read first', 'bootstrap', 'resume with full context', 'RECORDED DATA', '`foundations.sources` names each mirror source', '`source.group`']) {
    assert(d.description.includes(kw), `still carries "${kw}"`);
  }
  const cont = readFileSync(path.join(ROOT, 'skills/curator-continuity/SKILL.md'), 'utf8');
  const mc = readFileSync(path.join(ROOT, 'skills/my-curator/SKILL.md'), 'utf8');
  assert(/foundations\.continuation/.test(cont) && /page: 2/.test(cont) && /every page/i.test(cont), 'curator-continuity: fetch every page (continuation, `page: 2`) before starting work');
  assert(/foundations\.continuation/.test(mc) && /every page/i.test(mc), 'my-curator: names paging, continuation and every page');
  for (const [n, t] of [['curator-continuity', cont], ['my-curator', mc]]) {
    const fm = t.match(/^---\n([\s\S]*?)\n---/);
    const desc = fm ? (fm[1].match(/^description:(.*)$/m) || [])[1] || '' : '';
    assert(fm && desc && !/<[a-z][\w-]*>/i.test(desc), `${n}: the description has no <placeholder>`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f.label}${f.err ? `\n    └─ ${f.err}` : ''}`);
  process.exit(1);
}
