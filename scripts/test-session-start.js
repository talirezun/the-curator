/**
 * test-session-start.js — OFFLINE. v3.70.0 package P2: THE ONE MEASUREMENT of
 * what an agent receives at session start, and its three consumers.
 *
 * What this suite proves, each by EXECUTION against the REAL store and the
 * REAL `get_project_context` handler (never a fake):
 *
 *   1. The install-wide window and harness estimate (src/brain/config.js):
 *      defaults, the allowed set + custom bounds, harness ≤ window, a lowered
 *      window refused while a larger estimate stands, clears, an unknown
 *      field refused, an unparseable settings file NEVER replaced, 0600,
 *      other keys preserved.
 *   2. Their route, in process (§6) and through the REAL server's cross-origin
 *      guard (§8: a foreign-Origin PUT is 403 and writes nothing).
 *   3. The report: layers in drawing order that ADD UP to the measured MCP
 *      total; every token figure is estimateTokens(bytes); budget preset /
 *      custom / nearest (a v3.67.0 120 KB and 200 KB read as custom); window
 *      and harness from config; the bucket kit's model `meter`.
 *   4. The per-preset table: all seven from the STORE's ladder; equal, and
 *      SAID to be equal, when nothing is read first; different when the
 *      budget binds.
 *   5. PAGED delivery: the total is every page's measured reply (checked
 *      against an independent walk of the pages), and page 2's documents
 *      count as read first — not "on request".
 *  5b. v3.70.1: the document layer's per-document `entries` (and the kit's
 *      `parts`) — delivery order, the reply each arrives in, adding up to
 *      the layer, in a preview too.
 *   6. The routes: GET and preview carry the new fields; a Large/XL/Max
 *      budget is now accepted (the 200 KB route copy refused it); the preview
 *      writes nothing — no state file, no usage-log line, no config.
 *   7. The tray: getTraySummary().sessionStart is the route's reading,
 *      projected — no widget-only fact — and its graph reaches no network.
 *
 * ISOLATION: a throwaway domains folder and user-data folder, set through
 * BOTH env seams before anything is imported, plus the in-process overrides.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

os.hostname = () => 'session-start-suite-host';
syncBuiltinESMExports();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-session-start-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-session-start-')) {
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

const paths = await import('../src/brain/paths.js');
const CFG = await import('../src/brain/config.js');
paths.__setUserDataDirOverride(USER_DATA);
CFG.__setDomainsDirOverride(DOMAINS);
const WS = await import('../src/brain/working-state.js');
const tools = await import('../mcp/tools/working-state.js');
const SS = await import('../src/brain/session-start.js');

const sha = (x) => createHash('sha256').update(x).digest('hex');
const measure = (o) => Buffer.byteLength(JSON.stringify(o, null, 2), 'utf8');
const cfgPath = () => paths.getCuratorConfigFile();
const cfgRaw = () => (existsSync(cfgPath()) ? readFileSync(cfgPath(), 'utf8') : null);
function makeDomain(slug) {
  mkdirSync(path.join(DOMAINS, slug, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, slug, 'CLAUDE.md'), `# ${slug}\n`);
  writeFileSync(path.join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
}
const body = (label, kb) => `# ${label}\n\n${'Line of text https://example.com here.\n'.repeat(Math.ceil((kb * 1024) / 39))}`;

// ═════════════════════════════════════════════════════════════════════════
section('1. The window and the harness estimate — install-wide config');
// ═════════════════════════════════════════════════════════════════════════
{
  const d = CFG.getContextWindowSettings();
  assert(d.contextWindowTokens === 200000 && d.contextWindowSet === false && d.harnessEstimateTokens === null,
    'no config: the window reads 200K as a DEFAULT (set:false) and the harness is Not set (null, never 0)', JSON.stringify(d));
  eq(JSON.stringify(d.choices), JSON.stringify([200000, 400000, 1000000]), 'the allowed set is 200K · 400K · 1M');
  writeFileSync(cfgPath(), JSON.stringify({ defaultDomain: 'alpha', sharedBrainEnabled: false }, null, 2) + '\n');
  let r = CFG.setContextWindowSettings({ contextWindowTokens: 1000000 });
  assert(r.ok && r.settings.contextWindowTokens === 1000000 && r.settings.contextWindowSet === true && r.settings.contextWindowCustom === false,
    '1M is recorded, set, not custom', JSON.stringify(r));
  const onDisk = JSON.parse(cfgRaw());
  assert(onDisk.contextWindowTokens === 1000000 && onDisk.defaultDomain === 'alpha' && onDisk.sharedBrainEnabled === false,
    'stored as `contextWindowTokens` in .curator-config.json — every other key preserved', JSON.stringify(onDisk));
  eq((statSync(cfgPath()).mode & 0o777).toString(8), '600', 'the settings file stays 0600 after the write');
  r = CFG.setContextWindowSettings({ contextWindowTokens: 300000 });
  assert(r.ok && r.settings.contextWindowCustom === true, 'a custom 300K is accepted and reads custom');
  for (const bad of [7999, 10000001, 1.5, '1000000', true, -1, {}]) {
    const before = cfgRaw();
    const x = CFG.setContextWindowSettings({ contextWindowTokens: bad });
    assert(!x.ok && x.reason === 'invalid_context_window' && cfgRaw() === before,
      `window ${JSON.stringify(bad)} is refused invalid_context_window and the file is byte-identical`);
  }
  r = CFG.setContextWindowSettings({ harnessEstimateTokens: 50000 });
  assert(r.ok && r.settings.harnessEstimateTokens === 50000, 'a harness estimate of 50k is recorded');
  r = CFG.setContextWindowSettings({ harnessEstimateTokens: 0 });
  assert(r.ok && r.settings.harnessEstimateTokens === 0, '0 is a real answer, kept as 0 (not Not set)');
  r = CFG.setContextWindowSettings({ harnessEstimateTokens: 300001 });
  assert(!r.ok && r.reason === 'invalid_harness_estimate' && r.settings.harnessEstimateTokens === 0,
    'an estimate above the window is refused, and the reply carries the value still in force', JSON.stringify(r));
  CFG.setContextWindowSettings({ harnessEstimateTokens: 250000 });
  const beforeLower = cfgRaw();
  r = CFG.setContextWindowSettings({ contextWindowTokens: 200000 });
  assert(!r.ok && r.reason === 'harness_exceeds_window' && cfgRaw() === beforeLower,
    'lowering the window below a standing estimate is REFUSED (never a silent clear), file unchanged', JSON.stringify(r));
  r = CFG.setContextWindowSettings({ contextWindowTokens: 200000, harnessEstimateTokens: 120000 });
  assert(r.ok && r.settings.contextWindowTokens === 200000 && r.settings.harnessEstimateTokens === 120000, '…but both in ONE patch is fine');
  r = CFG.setContextWindowSettings({ harnessEstimateTokens: null });
  assert(r.ok && r.settings.harnessEstimateTokens === null && !('harnessEstimateTokens' in JSON.parse(cfgRaw())), 'null clears the estimate — the key leaves the file');
  r = CFG.setContextWindowSettings({ contextWindowTokens: null });
  assert(r.ok && r.settings.contextWindowSet === false && !('contextWindowTokens' in JSON.parse(cfgRaw())), 'null puts the window back to the default');
  r = CFG.setContextWindowSettings({ contextWindowTokens: 1000000, theme: 'dark' });
  assert(!r.ok && r.reason === 'unexpected_fields' && r.fields.includes('theme') && !('contextWindowTokens' in JSON.parse(cfgRaw())),
    'an unknown field refuses the WHOLE patch');
  eq(CFG.setContextWindowSettings({}).reason, 'nothing_to_change', 'an empty patch is nothing_to_change');
  // AN UNPARSEABLE SETTINGS FILE IS NEVER REPLACED — readRaw() reads it as {}
  // and a write-back would wipe every key in it.
  writeFileSync(cfgPath(), '{"defaultDomain": "alpha", "sharedBr');
  const broken = cfgRaw();
  r = CFG.setContextWindowSettings({ contextWindowTokens: 1000000 });
  assert(!r.ok && r.reason === 'config_unreadable' && cfgRaw() === broken, 'an unparseable settings file is REFUSED, byte-identical — never overwritten');
  writeFileSync(cfgPath(), '[1,2]');
  r = CFG.setContextWindowSettings({ contextWindowTokens: 1000000 });
  assert(!r.ok && r.reason === 'config_unreadable' && cfgRaw() === '[1,2]', '…and so is a file that is not a settings object');
  // Junk ON DISK reads as the default / Not set, never as a trusted value.
  writeFileSync(cfgPath(), JSON.stringify({ contextWindowTokens: 'lots', harnessEstimateTokens: 5000000 }));
  const junk = CFG.getContextWindowSettings();
  assert(junk.contextWindowTokens === 200000 && junk.contextWindowSet === false && junk.harnessEstimateTokens === null,
    'junk on disk reads as default window and Not set harness', JSON.stringify(junk));
  writeFileSync(cfgPath(), JSON.stringify({ contextWindowTokens: 200000, harnessEstimateTokens: 250000 }));
  eq(CFG.getContextWindowSettings().harnessEstimateTokens, null, 'a stored estimate larger than the stored window reads as Not set');
  rmSync(cfgPath());
}

// ═════════════════════════════════════════════════════════════════════════
// Fixture: one domain, projects built with the real store.
// ═════════════════════════════════════════════════════════════════════════
makeDomain('alpha');
await WS.saveProjectBriefText('alpha', 'alpha', '# alpha\n\n## Goal\n\nBuild it.\n');
for (const p of ['none', 'two', 'paged', 'legacy', 'free']) await WS.createProject('alpha', p, {});
for (const p of ['alpha', 'none', 'two', 'paged', 'legacy', 'free']) {
  await WS.saveWorkingState('alpha', {
    project: p === 'alpha' ? undefined : p, scope: 'main', headline: `handoff ${p}`,
    nowState: 'Now.', decisions: ['d1'], nextSteps: ['n1'], harness: 'suite', model: 'none',
  });
}
// none: three documents, nothing read first, a Standard budget.
for (const [s, kb] of [['architecture.md', 20], ['roadmap.md', 30], ['guide.md', 5]]) {
  await WS.saveFoundation('alpha', 'none', { slug: s, role: s.replace('.md', ''), text: body(s, kb) });
}
await WS.setReadingBudget('alpha', 'none', 65536);
// two: two read first (≈20 KB + ≈24 KB), one on request, one not at start.
await WS.saveFoundation('alpha', 'two', { slug: 'architecture.md', role: 'architecture', text: body('arch', 20), readFirst: true });
await WS.saveFoundation('alpha', 'two', { slug: 'decisions.md', role: 'decisions', text: body('dec', 24), readFirst: true });
await WS.saveFoundation('alpha', 'two', { slug: 'roadmap.md', role: 'roadmap', text: body('road', 10) });
await WS.saveFoundation('alpha', 'two', { slug: 'old.md', role: 'other', text: body('old', 6) });
await WS.setFoundationStartState('alpha', 'two', 'old.md', 'not-at-start');
await WS.setReadingBudget('alpha', 'two', 65536);
// paged: three read-first documents of ≈40 KB under Deep (128 KB) — over one 80 KB reply.
for (const s of ['a.md', 'b.md', 'c.md']) {
  await WS.saveFoundation('alpha', 'paged', { slug: s, role: 'other', text: body(s, 40), readFirst: true });
}
await WS.setReadingBudget('alpha', 'paged', 131072);
// legacy: a v3.67.0 Deep (120 KB) still stored.
await WS.saveFoundation('alpha', 'legacy', { slug: 'x.md', role: 'other', text: body('x', 4), readFirst: true });
await WS.setReadingBudget('alpha', 'legacy', 122880);
// free: no budget at all — unplanned.
await WS.saveFoundation('alpha', 'free', { slug: 'x.md', role: 'other', text: body('x', 4) });

const sumLayers = (r) => r.layers.reduce((n, l) => n + l.bytes, 0);

// ═════════════════════════════════════════════════════════════════════════
section('3. The report — layers, tokens, budget, window, harness, meter');
// ═════════════════════════════════════════════════════════════════════════
CFG.setContextWindowSettings({ contextWindowTokens: 1000000, harnessEstimateTokens: 50000 });
{
  const r = await SS.sessionStartReport('alpha', 'two');
  assert(r.ok === true, 'the report answers for a real project');
  eq(JSON.stringify(r.layers.map((l) => l.key)), JSON.stringify(['framing', 'brief', 'handoff', 'journal', 'index', 'readFirst']),
    'layers: framing · brief · handoff · journal · index · readFirst, in drawing order');
  eq(sumLayers(r), r.bytes.mcp, 'the layers ADD UP to the measured MCP total (framing is the remainder, never negative)');
  const real = await tools.getProjectContextHandler({ domain: 'alpha', project: 'two' }, null);
  eq(r.bytes.mcp, measure(real), 'DUMB CROSS-CHECK: an unpaged total is the real handler reply\'s serialised size');
  assert(r.layers.every((l) => l.tokens === WS.estimateTokens(l.bytes)), 'every layer\'s tokens is the store\'s estimateTokens(bytes)');
  eq(r.tokens.mcp, Math.round(r.bytes.mcp / 4), '…and the total is bytes ÷ 4, rounded (the one estimate)');
  const rf = r.layers.find((l) => l.key === 'readFirst');
  assert(rf.documents === 2 && rf.label === 'read first' && rf.bytes === r.tiers.readFirst.bytes && rf.bytes > 40000,
    'the readFirst layer is the two flagged documents\' text, labelled "read first"', JSON.stringify(rf));
  const brief = r.layers.find((l) => l.key === 'brief');
  eq(brief.bytes, r.tiers.brief.bytes, 'the brief layer is tiers.brief (the v3.67.0 field, unchanged)');
  assert(r.budget.bytes === 65536 && r.budget.tokens === 16384 && r.budget.preset === 'standard' && r.budget.custom === false && r.budget.nearest === null && r.budget.source === 'owner',
    'budget: 64 KB = ≈16k tokens, preset "standard", not custom', JSON.stringify(r.budget));
  assert(r.onDemand.documents === 1 && r.onDemand.tokens === WS.estimateTokens(r.tiers.onRequest.bytes) && r.onDemand.notAtStart === 1,
    'onDemand: the one on-request document (the not-at-start one is counted apart)', JSON.stringify(r.onDemand));
  assert(r.window.tokens === 1000000 && r.window.set === true && r.harness.tokens === 50000 && r.harness.set === true && r.harness.estimate === true,
    'window and harness come from the install config, the harness marked an estimate', JSON.stringify({ w: r.window, h: r.harness }));
  eq(r.bytes.mcp + 0, r.layers.reduce((n, l) => n + l.bytes, 0), 'the harness is NEVER added to a measured figure (the sum is the layers alone)');
  // THE KIT'S MODEL — ready to pass to renderBucket.
  const m = r.meter;
  assert(m.windowTokens === 1000000 && m.harnessTokens === 50000 && m.budgetTokens === 16384 && m.preview === false,
    'meter: window, harness, budget in tokens, not a preview', JSON.stringify(m).slice(0, 200));
  eq(JSON.stringify(m.layers.map((l) => l.key)), JSON.stringify(['framing', 'brief', 'handoff', 'journal', 'index', 'read']),
    'meter.layers uses the kit\'s own keys (`read` for readFirst)');
  assert(m.layers.every((l, i) => l.tokens === r.layers[i].tokens && l.label === r.layers[i].label), '…with the report\'s own tokens and labels');
  assert(m.onDemand.tokens === r.onDemand.tokens && m.onDemand.documents === 1 && m.delivery.replies === 1 && m.delivery.replyTokens === 20480,
    'meter.onDemand and meter.delivery (1 reply of ≈20k)', JSON.stringify({ o: m.onDemand, d: m.delivery }));
  const bucket = await import('../src/public/next/shared/bucket.js');
  const html = bucket.renderBucket(m);
  assert(typeof html === 'string' && html.length > 200 && /1M/.test(html), 'the kit\'s renderBucket(meter) draws it as-is');
  // Not set: harness null reaches the meter as null.
  CFG.setContextWindowSettings({ harnessEstimateTokens: null });
  const r2 = await SS.sessionStartReport('alpha', 'two', null, { presets: false, hook: false });
  assert(r2.harness.tokens === null && r2.harness.set === false && r2.meter.harnessTokens === null, 'harness Not set → null everywhere, never 0');
  assert(r2.presets.length === 0 && r2.bytes.hook === null && r2.tokens.hook === null, 'presets:false / hook:false skip both (the tray\'s call)');
  CFG.setContextWindowSettings({ harnessEstimateTokens: 50000 });

  // Legacy and unplanned budgets.
  const lg = await SS.sessionStartReport('alpha', 'legacy', null, { presets: false });
  assert(lg.budget.preset === 'custom' && lg.budget.custom === true && lg.budget.nearest === 'deep' && lg.budget.tokens === 30720,
    'a stored v3.67.0 Deep (120 KB) reads Custom · ≈30.7k, nearest Deep — no migration', JSON.stringify(lg.budget));
  const fr = await SS.sessionStartReport('alpha', 'free', null, { presets: false });
  assert(fr.budget.source === 'default' && fr.budget.preset === null && fr.budget.custom === false && fr.planned === false,
    'an UNPLANNED project has no preset (the default is not a budget the owner chose)', JSON.stringify(fr.budget));
  const frDoc = fr.layers.find((l) => l.key === 'readFirst');
  assert(frDoc.label === 'documents sent at start' && frDoc.documents === 1, 'unplanned text is labelled "documents sent at start", never "read first"', JSON.stringify(frDoc));
  eq(SS.budgetPresetOf(204800, 'owner').nearest, 'large', 'a stored v3.67.0 Max (200 KB) is custom, nearest Large');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. The seven presets — true differences, and plain equality');
// ═════════════════════════════════════════════════════════════════════════
{
  const n = await SS.sessionStartReport('alpha', 'none');
  eq(JSON.stringify(n.presets.map((p) => [p.id, p.bytes, p.tokens])), JSON.stringify(WS.READING_BUDGET_PRESETS.map((p) => [p.id, p.bytes, p.tokens])),
    'presets: the STORE\'s seven, ids · bytes · tokens, in order');
  assert(n.presets.every((p) => p.documents === 0 && p.documentBytes === 0) && n.presets.slice(1).every((p) => p.sameAsPrevious),
    'nothing read first: every preset hands over the same (no) documents, and each row says so');
  assert(n.presets.every((p) => Math.abs(p.mcpBytes - n.presets[0].mcpBytes) < 64), '…their totals differ only by the report\'s own words (< 64 B)', JSON.stringify(n.presets.map((p) => p.mcpBytes)));
  assert(n.presetsSummary.allEqual === true && n.presetsSummary.reason === 'nothing-read-first' && n.presetsSummary.readFirstDocuments === 0,
    '…and the report SAYS why: nothing-read-first', JSON.stringify(n.presetsSummary));
  eq(n.presets.filter((p) => p.current).map((p) => p.id).join(), 'standard', 'the preset in force is marked current');
  const t = await SS.sessionStartReport('alpha', 'two');
  const by = Object.fromEntries(t.presets.map((p) => [p.id, p]));
  assert(by['index-only'].documents === 0 && by.lean.documents === 1 && by.standard.documents === 2,
    'with 2 read first (≈44 KB): Index only sends 0, Lean (32 KB) 1, Standard 2', JSON.stringify(t.presets.map((p) => [p.id, p.documents])));
  assert(by['index-only'].mcpBytes < by.lean.mcpBytes && by.lean.mcpBytes < by.standard.mcpBytes, '…so their measured totals differ, in order');
  assert(by.lean.omitted === 1 && by.standard.omitted === 0, 'Lean names the document its budget left out');
  assert(by.deep.sameAsPrevious && by.large.sameAsPrevious && by['extra-large'].sameAsPrevious && by.max.sameAsPrevious && !by.standard.sameAsPrevious,
    'from Standard up nothing changes, and each row says so (sameAsPrevious)');
  assert(t.presetsSummary.allEqual === false && t.presetsSummary.reason === null && t.presetsSummary.readFirstDocuments === 2, 'presetsSummary: not all equal');
  const std = await tools.getProjectContextHandler({ domain: 'alpha', project: 'two' }, null, { whatIf: { ownerBudgetBytes: 65536 } });
  eq(by.standard.mcpBytes, measure(std), 'DUMB CROSS-CHECK: Standard\'s figure is the handler run with that what-if');
  assert(t.presets.every((p) => p.mcpTokens === WS.estimateTokens(p.mcpBytes) && p.documentTokens === WS.estimateTokens(p.documentBytes)), 'preset tokens are the one estimator too');
}

// ═════════════════════════════════════════════════════════════════════════
section('5. Paged delivery — every page counted, page 2 is not "on request"');
// ═════════════════════════════════════════════════════════════════════════
{
  const r = await SS.sessionStartReport('alpha', 'paged', null, { presets: false });
  assert(r.delivery.replies >= 2 && r.delivery.paged === true, `3 × 40 KB read first under Deep is PAGED (${r.delivery.replies} replies)`);
  // An INDEPENDENT walk: every page through the real handler, sizes summed.
  const p1 = await tools.getProjectContextHandler({ domain: 'alpha', project: 'paged' }, null);
  let total = measure(p1);
  const docs = [...p1.foundations.documents.map((d) => d.slug)];
  for (let pg = 2; pg <= p1.foundations.of; pg++) {
    const rp = await tools.getProjectContextHandler({ domain: 'alpha', project: 'paged', page: pg }, null);
    total += measure(rp);
    docs.push(...rp.foundations.documents.map((d) => d.slug));
  }
  eq(r.bytes.mcp, total, 'DUMB CROSS-CHECK: the total is the sum of every page\'s real serialised reply');
  eq(r.delivery.totalBytes, r.bytes.mcp, 'delivery.totalBytes is the same number');
  eq(r.delivery.pages.reduce((n, p) => n + p.bytes, 0), r.bytes.mcp, 'the pages add up to it');
  assert(r.delivery.pages.every((p) => p.bytes <= r.delivery.pageBytes), 'each page is within the 80 KB reply', JSON.stringify(r.delivery.pages.map((p) => p.bytes)));
  eq(docs.sort().join(), 'a.md,b.md,c.md', 'PRECONDITION: the three documents arrive across the pages');
  const rf = r.layers.find((l) => l.key === 'readFirst');
  assert(rf.documents === 3 && r.tiers.readFirst.count === 3 && r.onDemand.documents === 0,
    'all three count as read first — a page-2 document is NOT "on request"', JSON.stringify({ rf, od: r.onDemand }));
  eq(sumLayers(r), r.bytes.mcp, 'the layers still add up to the paged total (later envelopes are framing)');
  assert(r.meter.delivery.replies === r.delivery.replies, 'meter.delivery.replies is the page count');
  assert(r.delivery.pages.flatMap((p) => p.slugs).sort().join() === 'a.md,b.md,c.md', 'delivery.pages names every document once');
}

// ═════════════════════════════════════════════════════════════════════════
section('5b. v3.70.1 — the document layer, one entry per document, in delivery order');
// ═════════════════════════════════════════════════════════════════════════
{
  const layerOf = (r) => r.layers.find((l) => l.key === 'readFirst');
  const t = await SS.sessionStartReport('alpha', 'two', null, { presets: false });
  const rf = layerOf(t);
  eq(typeof rf.documents, 'number', 'the v3.70.0 `documents` COUNT is unchanged (entries are additive)');
  const real = await tools.getProjectContextHandler({ domain: 'alpha', project: 'two' }, null);
  eq(JSON.stringify(rf.entries.map((e) => e.slug)), JSON.stringify(real.foundations.documents.map((d) => d.slug)),
    'DUMB CROSS-CHECK: the entries are the real reply\'s documents, in the order it hands them over');
  eq(rf.entries.length, rf.documents, '…one entry per counted document');
  eq(rf.entries.reduce((n, e) => n + e.bytes, 0), rf.bytes, 'the entries ADD UP to the layer (each is the text it is handed)');
  assert(rf.entries.every((e) => e.tokens === WS.estimateTokens(e.bytes) && e.page === 1 && e.readFirst === true),
    'each entry\'s tokens is the one estimator; one reply, so every page is 1; each flagged read first', JSON.stringify(rf.entries));
  const idx = new Map(real.foundations.index.map((r) => [r.slug, r.title]));
  assert(rf.entries.every((e) => e.title === idx.get(e.slug) && typeof e.title === 'string' && e.title.length > 0),
    'each entry\'s title is the index row\'s title', JSON.stringify(rf.entries.map((e) => [e.slug, e.title])));
  eq(JSON.stringify(Object.keys(rf.entries[0]).sort()), JSON.stringify(['bytes', 'page', 'readFirst', 'slug', 'title', 'tokens']),
    'an entry is exactly {slug, title, bytes, tokens, page, readFirst}');
  const kit = t.meter.layers.find((l) => l.key === 'read');
  eq(JSON.stringify(kit.parts), JSON.stringify(rf.entries.map((e) => ({ label: e.slug.replace(/\.md$/, ''), title: e.title, tokens: e.tokens, page: e.page }))),
    'meter: the kit\'s read layer carries `parts` — the slug without .md, the title, the tokens, the reply');
  assert(t.meter.layers.filter((l) => l.key !== 'read').every((l) => !('parts' in l)), '…and no other layer does');

  const n = await SS.sessionStartReport('alpha', 'none', null, { presets: false });
  assert(Array.isArray(layerOf(n).entries) && layerOf(n).entries.length === 0 && !('parts' in n.meter.layers.find((l) => l.key === 'read')),
    'nothing read first: entries [] and the meter layer has NO parts (the kit draws it as v3.70.0 did)');

  // PAGED: each entry's page is the delivery plan's, checked against an independent walk.
  const p = await SS.sessionStartReport('alpha', 'paged', null, { presets: false });
  const pe = layerOf(p).entries;
  const walk = [];
  const p1 = await tools.getProjectContextHandler({ domain: 'alpha', project: 'paged' }, null);
  walk.push(...p1.foundations.documents.map((d) => [d.slug, 1]));
  for (let pg = 2; pg <= p1.foundations.of; pg++) {
    const rp = await tools.getProjectContextHandler({ domain: 'alpha', project: 'paged', page: pg }, null);
    walk.push(...rp.foundations.documents.map((d) => [d.slug, pg]));
  }
  eq(JSON.stringify(pe.map((e) => [e.slug, e.page])), JSON.stringify(walk),
    'DUMB CROSS-CHECK: paged entries are in delivery order, each with the reply it ACTUALLY arrives in');
  assert(new Set(pe.map((e) => e.page)).size >= 2, `PRECONDITION: the documents span ${new Set(pe.map((e) => e.page)).size} replies`);
  const planPage = new Map(p.delivery.pages.flatMap((pg) => pg.slugs.map((sl) => [sl, pg.page])));
  assert(pe.every((e) => planPage.get(e.slug) === e.page), '…and each page agrees with delivery.pages (P1\'s deliveryPlan)', JSON.stringify([...planPage]));
  eq(pe.reduce((s, e) => s + e.bytes, 0), layerOf(p).bytes, 'paged entries still add up to the layer');
  eq(JSON.stringify(p.meter.layers.find((l) => l.key === 'read').parts.map((x) => x.page)), JSON.stringify(pe.map((e) => e.page)),
    'the meter\'s parts carry the same pages, so the kit can mark where reply 2 begins');

  // UNPLANNED: text the owner did not flag is still one entry each, marked not read first.
  const f = await SS.sessionStartReport('alpha', 'free', null, { presets: false });
  assert(layerOf(f).entries.length === 1 && layerOf(f).entries[0].readFirst === false,
    'an unplanned project\'s document text is an entry too, marked readFirst:false', JSON.stringify(layerOf(f).entries));

  // THE PREVIEW: a plan's what-if carries its own entries.
  const w = await SS.sessionStartReport('alpha', 'two', { startStates: { 'roadmap.md': 'read-first', 'architecture.md': 'on-request' } }, { presets: false, hook: false });
  const we = layerOf(w).entries.map((e) => e.slug).sort().join();
  eq(we, 'decisions.md,roadmap.md', 'a preview with a plan carries the PLANNED documents\' entries (roadmap in, architecture out)');
  assert(w.meter.preview === true && w.meter.layers.find((l) => l.key === 'read').parts.length === 2, '…and its meter is a preview with two parts');
  const again = await SS.sessionStartReport('alpha', 'two', null, { presets: false });
  eq(layerOf(again).entries.map((e) => e.slug).join(), rf.entries.map((e) => e.slug).join(), 'the preview wrote nothing: the saved plan is unchanged');
}

// ═════════════════════════════════════════════════════════════════════════
section('6. The routes');
// ═════════════════════════════════════════════════════════════════════════
const express = (await import('express')).default;
const memRouter = (await import('../src/routes/memory.js')).default;
const cfgRouter = (await import('../src/routes/config.js')).default;
const app = express();
app.use(express.json());
app.use('/api/memory', memRouter);
app.use('/api/config', cfgRouter);
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const req = async (method, url, b, headers = {}) => {
  const res = await fetch(BASE + url, {
    method, headers: { ...(b === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(b === undefined ? {} : { body: JSON.stringify(b) }),
  });
  let parsed = {};
  try { parsed = await res.json(); } catch { parsed = {}; }
  return { status: res.status, body: parsed || {} };
};
try {
  let r = await req('GET', '/api/config/context-window');
  assert(r.status === 200 && r.body.settings.contextWindowTokens === 1000000 && r.body.settings.harnessEstimateTokens === 50000, 'GET /api/config/context-window');
  r = await req('PUT', '/api/config/context-window', { contextWindowTokens: 400000 });
  assert(r.status === 200 && r.body.settings.contextWindowTokens === 400000, 'PUT sets the window');
  r = await req('PUT', '/api/config/context-window', { contextWindowTokens: 5 });
  assert(r.status === 400 && r.body.reason === 'invalid_context_window' && r.body.settings.contextWindowTokens === 400000, 'PUT a bad window is 400 with the value in force');
  r = await req('PUT', '/api/config/context-window', { harnessEstimateTokens: 450000 });
  eq(r.status, 400, 'PUT an estimate above the window is 400');
  CFG.setContextWindowSettings({ harnessEstimateTokens: 300000 });
  r = await req('PUT', '/api/config/context-window', { contextWindowTokens: 200000 });
  assert(r.status === 409 && r.body.reason === 'harness_exceeds_window', 'lowering the window under the estimate is 409 harness_exceeds_window');
  r = await req('PUT', '/api/config/context-window', { contextWindowTokens: 1000000, harnessEstimateTokens: 50000, apiKey: 'x' });
  assert(r.status === 400 && r.body.reason === 'unexpected_fields', 'an unknown field is 400');
  r = await req('PUT', '/api/config/context-window', { contextWindowTokens: 1000000, harnessEstimateTokens: 50000 });
  eq(r.status, 200, 'both at once');

  r = await req('GET', '/api/memory/alpha/two/session-start');
  const g = r.body;
  assert(r.status === 200 && g.ok === true, 'GET session-start answers');
  for (const k of ['ok', 'domain', 'project', 'budget', 'planned', 'presets', 'tiers', 'bytes', 'costLine', 'notes']) assert(k in g, `v3.69.0 field \`${k}\` is still there`);
  for (const k of ['layers', 'onDemand', 'delivery', 'window', 'harness', 'tokens', 'presetsSummary', 'meter']) assert(k in g, `v3.70.0 field \`${k}\` is there`);
  eq(g.presets.length, 7, 'GET carries all seven presets');
  assert(g.window.tokens === 1000000 && g.harness.tokens === 50000, 'the route reads the config the PUT wrote');
  // PREVIEW: a Large budget, which v3.69.0's route refused at 200 KB.
  const logPath = paths.getMcpUsageLogPath();
  const fingerprint = () => {
    const files = [];
    const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else files.push(`${f}:${sha(readFileSync(f))}`); } };
    walk(path.join(DOMAINS, 'alpha', 'state'));
    return files.sort().join('|') + `|log:${existsSync(logPath) ? sha(readFileSync(logPath)) : 'absent'}|cfg:${sha(cfgRaw() || '')}`;
  };
  const fp = fingerprint();
  r = await req('POST', '/api/memory/alpha/two/session-start/preview', { budgetBytes: 262144, plan: { 'roadmap.md': 'read-first' } });
  assert(r.status === 200 && r.body.budget.preset === 'large' && r.body.budget.source === 'whatif' && r.body.meter.preview === true
    && r.body.layers.find((l) => l.key === 'readFirst').documents === 3,
    'POST preview: Large (256 KB) is ACCEPTED, previewed with a plan, meter.preview true', JSON.stringify(r.body.budget));
  r = await req('POST', '/api/memory/alpha/two/session-start/preview', { budgetBytes: WS.CONTEXT_MAX_BYTES_CAP });
  assert(r.status === 200 && r.body.budget.preset === 'max', 'Max (800 KB) is accepted');
  r = await req('POST', '/api/memory/alpha/two/session-start/preview', { budgetBytes: WS.CONTEXT_MAX_BYTES_CAP + 1 });
  assert(r.status === 400 && r.body.reason === 'invalid_reading_budget' && /819200/.test(r.body.error), 'one byte over the store cap is 400, naming the cap');
  eq(fingerprint(), fp, 'the previews wrote NOTHING — no state file, no manifest, no usage-log line, no config');
  r = await req('PATCH', '/api/memory/alpha/two/reading/budget', { readingBudgetBytes: 524288 });
  assert(r.status === 200 && r.body.readingBudgetBytes === 524288, 'PATCH reading/budget accepts Extra large (512 KB) — the route derives from the store');
  r = await req('GET', '/api/memory/alpha/two/session-start');
  assert(r.body.budget.preset === 'extra-large' && r.body.presets.find((p) => p.id === 'extra-large').current === true, '…and the report reads it back as the current preset');
  await WS.setReadingBudget('alpha', 'two', 65536);
  const routeSrc = readFileSync(path.join(ROOT, 'src/routes/memory.js'), 'utf8');
  assert(!/\b204800\b/.test(routeSrc) && !/PRESET_BYTES/.test(routeSrc), 'the route holds no second copy of the ladder or the old cap');

  // ═══════════════════════════════════════════════════════════════════════
  section('7. The tray — the app\'s reading, projected; no network');
  // ═══════════════════════════════════════════════════════════════════════
  // Make `two` the newest save so it is the tray's open project.
  await WS.saveWorkingState('alpha', { project: 'two', scope: 'main', headline: 'newest', nowState: 'Now.', harness: 'suite', model: 'none' });
  const { getTraySummary } = await import('../src/brain/tray-summary.js');
  const tray = await getTraySummary({ limit: 8 });
  const st = tray.sessionStart;
  assert(st && st.domain === 'alpha' && st.project === 'two' && tray.lastSave.project === 'two', 'sessionStart is for the open project (lastSave\'s)', JSON.stringify(st && { d: st.domain, p: st.project }));
  r = await req('GET', '/api/memory/alpha/two/session-start');
  const app2 = r.body;
  eq(st.tokens, app2.tokens.mcp, 'its total is the app\'s total');
  eq(JSON.stringify(st.layers.map((l) => [l.key, l.label, l.bytes, l.tokens])), JSON.stringify(app2.layers.map((l) => [l.key, l.label, l.bytes, l.tokens])), 'its layers are the app\'s layers, figure for figure');
  assert(st.delivery.replies === app2.delivery.replies && st.window.tokens === app2.window.tokens && st.harness.tokens === app2.harness.tokens
    && st.onDemand.tokens === app2.onDemand.tokens && st.budget.preset === app2.budget.preset,
    'replies, window, harness, on-demand and preset agree with the app');
  eq(JSON.stringify(st.meter), JSON.stringify(app2.meter), 'the widget\'s meter model IS the app\'s');
  // NO WIDGET-ONLY FACT: every leaf of the brief is a value the app's report carries.
  const brief = SS.sessionStartBrief(app2);
  eq(JSON.stringify(st), JSON.stringify(brief), 'sessionStart is exactly sessionStartBrief(the route\'s reply) — nothing the app does not show');
  eq((await getTraySummary({ limit: 8, sessionStart: false })).sessionStart, null, 'the test switch turns it off (null, not a zero)');

  // The graph: session-start.js statically, AND the handler it imports lazily.
  const graph = (entries) => {
    const seen = new Set(); const ext = new Set(); const stack = [...entries];
    while (stack.length) {
      const f = stack.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      let src; try { src = readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
      for (const mm of src.matchAll(/^\s*import[^;]*?from\s*['"]([^'"]+)['"]/gm)) {
        const s = mm[1];
        if (s.startsWith('.')) stack.push(path.normalize(path.join(path.dirname(f), s)));
        else ext.add(s.replace(/^node:/, ''));
      }
    }
    return { seen, ext };
  };
  const ssSrc = readFileSync(path.join(ROOT, 'src/brain/session-start.js'), 'utf8');
  const lazy = [...ssSrc.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m2) => path.normalize(path.join('src/brain', m2[1])));
  eq(JSON.stringify(lazy), JSON.stringify(['mcp/tools/working-state.js']), 'session-start.js imports exactly ONE module lazily: the handler it measures');
  const gr = graph(['src/brain/tray-summary.js', ...lazy]);
  assert(gr.seen.has('src/brain/session-start.js') && gr.seen.has('mcp/tools/working-state.js'), 'the walk includes session-start.js and the handler');
  assert(!gr.seen.has('src/brain/sync.js') && !gr.ext.has('child_process') && !gr.ext.has('https') && !gr.ext.has('http'),
    'the tray + the measured handler reach no sync.js, no child_process, no http(s)', JSON.stringify([...gr.ext]));
  const ctl = graph(['src/brain/tray-summary.js', ...lazy, 'src/brain/sync.js']);
  assert(ctl.seen.has('src/brain/sync.js'), '(control) the walker does find an injected sync.js');
} finally {
  server.close();
}

// ═════════════════════════════════════════════════════════════════════════
section('8. The REAL server: a foreign-Origin PUT is 403 and writes nothing');
// ═════════════════════════════════════════════════════════════════════════
{
  const freePort = await new Promise((resolve) => {
    const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(freePort), CURATOR_NO_OPEN: '1', CURATOR_TEST_USER_DATA_DIR: USER_DATA,
      CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_LOG_DIR: path.join(USER_DATA, 'logs'),
      CURATOR_TEST_MCP_LAUNCHER_DIR: path.join(USER_DATA, 'bin') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  try {
    const deadline = Date.now() + 60000;
    let up = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { const r = await fetch(`http://127.0.0.1:${freePort}/api/config/context-window`); if (r.status) { up = true; break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    ok(up ? 'the real src/server.js started on an isolated port' : 'server did not start');
    if (!up) bad('real server', out.split('\n').slice(0, 8).join(' | '));
    if (up) {
      const url = `http://127.0.0.1:${freePort}/api/config/context-window`;
      const before = cfgRaw();
      const evil = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ contextWindowTokens: 200000, harnessEstimateTokens: null }) });
      eq(evil.status, 403, 'a foreign-Origin PUT is refused 403 by the cross-origin guard');
      eq(cfgRaw(), before, '…and the settings file is byte-identical');
      const same = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ harnessEstimateTokens: 20000 }) });
      const sb = await same.json();
      assert(same.status === 200 && sb.settings.harnessEstimateTokens === 20000, 'the same PUT with no Origin reaches the route', JSON.stringify(sb));
      const g = await (await fetch(`http://127.0.0.1:${freePort}/api/memory/alpha/two/session-start`)).json();
      assert(g.ok === true && g.harness.tokens === 20000 && g.layers.length === 6, 'the real server\'s session-start carries the config and the layers');
    }
  } finally {
    child.kill('SIGTERM');
  }
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`Passed: ${passed}   Failed: ${failed}`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.label}${f.err !== undefined ? `\n    └─ ${f.err}` : ''}`);
  process.exit(1);
}
