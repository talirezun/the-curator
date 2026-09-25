#!/usr/bin/env node
/**
 * test-domain-identity.js — OFFLINE. A DOMAIN'S COLOUR STAYS PUT (v3.76.0).
 *
 * THE DEFECT (maintainer, 2026-09-25): after deleting a domain, "Research"
 * changed from olive to blue. The identity slot was the domain's POSITION in
 * listDomains(), so deleting or adding one domain recoloured every domain
 * after it — on every screen and in the menubar widget at once.
 *
 * THE FIX: each domain RECORDS its slot once, in
 * `domains/<slug>/.curator-identity.json` (src/brain/domain-identity.js); one
 * pure rule (`resolveIdentitySlots`, shared/identity-palette.js) turns what
 * is recorded into what is painted; the routes carry it (`identity`,
 * `identitySlot`) and the widget reads the same.
 *
 *   §1 the rule, pure — order, lowest free, a clash, overflow, determinism
 *   §2 on disk — reads never write; record; ★ delete/add/rename keep colours
 *   §3 the routes — GET /api/domains, /stats, /:domain/stats, POST create,
 *      /api/config/default-domain — over a real express server
 *   §4 the widget's data layer — getTraySummary's domains[] carry the slot
 *   §5 the client loaders keep it — Ingest's fetchDomainStats, Context's
 *      loadDomainList and Settings' loadVaultDomains, lifted and driven
 *
 * Isolation: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR + the
 * in-process override, all under a fresh temp dir. Nothing real is touched.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

let passed = 0, failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label,
  `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const section = (t) => console.log('\n' + t);

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-domain-identity-'));
const DOMAINS = path.join(TMP, 'domains');
const USERDATA = path.join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USERDATA, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USERDATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const palette = await import('../src/brain/identity-palette.js');
const ident = await import('../src/brain/domain-identity.js');
const { resolveIdentitySlots, IDENTITY_SLOTS } = palette;

const mkDomain = (slug) => {
  mkdirSync(path.join(DOMAINS, slug, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, slug, 'CLAUDE.md'), '# Domain: ' + slug + '\n');
};
const fileOf = (slug) => path.join(DOMAINS, slug, ident.IDENTITY_FILE);
const recordedOf = (slug) => {
  try { return JSON.parse(readFileSync(fileOf(slug), 'utf8')).slot; } catch { return null; }
};
const slotsNow = async () => Object.fromEntries((await ident.readDomainIdentities()).slots);

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('§1 — resolveIdentitySlots, the one rule (pure)');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const m = (names, rec) => Object.fromEntries(resolveIdentitySlots(names, rec));
    eq(m(['research', 'articles', 'business'], {}), { articles: 1, business: 2, research: 3 },
      'nothing recorded: slots 1, 2, 3 in NAME order — what a sorted folder listing gave before, so most installs see no change');
    eq(m(['b', 'a', 'c'], {}), m(['c', 'b', 'a'], {}), 'the input order does not matter (two Macs list folders differently)');
    eq(m(['a', 'b', 'c'], { a: 5, b: 9, c: 1 }), { a: 5, b: 9, c: 1 }, 'recorded slots are kept as recorded');
    eq(m(['a', 'c', 'new'], { a: 1, c: 3 }), { a: 1, c: 3, new: 2 },
      '★ an unrecorded domain takes the LOWEST FREE slot — the gap a delete left — and moves nobody');
    eq(m(['a', 'b'], { a: 4, b: 4 }), { a: 4, b: 1 },
      'a CLASH (two Macs picked the same free slot): the earlier name keeps it, the later takes the lowest free');
    eq(m(['a', 'b'], { a: 0, b: 13 }), { a: 1, b: 2 }, 'an invalid recorded slot (0, 13) counts as unrecorded');
    eq(m(['a', 'b'], { a: '3', b: 2.5 }), { a: 1, b: 2 }, '…and so does a non-integer');
    const many = Array.from({ length: IDENTITY_SLOTS + 2 }, (_, i) => 'd' + String(i).padStart(2, '0'));
    const r = m(many, {});
    eq(many.slice(0, IDENTITY_SLOTS).map((n) => r[n]), Array.from({ length: IDENTITY_SLOTS }, (_, i) => i + 1),
      'the first twelve take slots 1..12');
    eq([r.d12, r.d13], [1, 2], 'with every slot taken, the next takes the least-used slot, lowest first (the old wrap, no reshuffle)');
    const counts = new Map(Object.values(r).map((v) => [v, 0]));
    Object.values(r).forEach((v) => counts.set(v, counts.get(v) + 1));
    ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1, 'overflow spreads evenly — no slot is used twice before every slot is used once');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§2 — on disk: reads never write; a delete, an add and a rename recolour nothing');
  // ═══════════════════════════════════════════════════════════════════════
  for (const d of ['articles', 'business', 'research']) mkDomain(d);
  {
    const before = await slotsNow();
    eq(before, { articles: 1, business: 2, research: 3 }, 'three unrecorded domains resolve to 1, 2, 3 by name');
    ok(['articles', 'business', 'research'].every((d) => !existsSync(fileOf(d))),
      '★ a READ writes nothing — the widget and the MCP read this too, and must not mint files');
    const written = await ident.recordDomainIdentities();
    eq(written.sort(), ['articles', 'business', 'research'], 'the first record pass (a server start) records all three');
    eq(['articles', 'business', 'research'].map(recordedOf), [1, 2, 3], '…exactly what was already being painted');
    eq(await ident.recordDomainIdentities(), [], 'a second pass writes NOTHING — idempotent');
    ok(readFileSync(fileOf('research'), 'utf8') === '{"slot":3}\n', 'the file is one small line of JSON', readFileSync(fileOf('research'), 'utf8'));

    // ★ THE 2026-09-25 DEFECT: delete "business" (slot 2).
    rmSync(path.join(DOMAINS, 'business'), { recursive: true, force: true });
    const afterDelete = await slotsNow();
    eq(afterDelete, { articles: 1, research: 3 },
      '★ DELETE: after "business" goes, "research" KEEPS slot 3 — under the old rule it slid to slot 2');
    ok(afterDelete.research !== 2, 'CONTROL: the position rule would have given research slot 2 here, and this is not that');

    // ADD: a new domain takes the gap and moves nobody.
    mkDomain('zeta');
    const afterAdd = await slotsNow();
    eq(afterAdd, { articles: 1, research: 3, zeta: 2 }, '★ ADD: a new domain takes the lowest free slot (2); articles and research do not move');
    await ident.recordDomainIdentities();
    eq(recordedOf('zeta'), 2, '…and the next record pass fixes it on disk');
    mkDomain('aaa'); // sorts FIRST by name — under the old rule every colour would shift
    const afterAdd2 = await slotsNow();
    eq([afterAdd2.articles, afterAdd2.research, afterAdd2.zeta], [1, 3, 2],
      '★ a domain whose NAME sorts first shifts nobody (the old rule shifted every domain by one)');
    eq(afterAdd2.aaa, 4, '…it takes the lowest slot still free (4)');
    await ident.recordDomainIdentities();

    // RENAME: the folder moves, and the file moves with it.
    renameSync(path.join(DOMAINS, 'research'), path.join(DOMAINS, 'studies'));
    const afterRename = await slotsNow();
    eq(afterRename.studies, 3, '★ RENAME: the folder moved and its recorded slot moved with it — same colour');

    // A synced-in clash: another Mac recorded slot 1 for "zeta" too.
    writeFileSync(fileOf('zeta'), '{"slot":1}\n');
    const clash = await slotsNow();
    eq([clash.articles, clash.zeta], [1, 2], 'a clash resolves deterministically: "articles" (earlier) keeps 1, "zeta" takes the lowest free (2)');
    const w2 = await ident.recordDomainIdentities();
    ok(w2.length === 1 && w2[0] === 'zeta' && recordedOf('zeta') === 2, 'the record pass rewrites the loser\'s file so every Mac converges', JSON.stringify(w2));

    // A corrupt file reads as unrecorded, never throws.
    writeFileSync(fileOf('aaa'), 'not json');
    ok(Number.isInteger((await slotsNow()).aaa), 'a corrupt identity file reads as unrecorded — never a throw, never NaN');

    // A ghost folder (no CLAUDE.md) is not a domain and gets no file.
    mkdirSync(path.join(DOMAINS, 'ghost', 'wiki'), { recursive: true });
    await ident.recordDomainIdentities();
    ok(!existsSync(fileOf('ghost')), 'a folder listDomains() does not count gets no identity file');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§3 — the routes carry the recorded slot, over a real express server');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const domainsRouter = (await import('../src/routes/domains.js')).default;
    const configRouter = (await import('../src/routes/config.js')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/domains', domainsRouter);
    app.use('/api/config', configRouter);
    const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (u) => { const r = await fetch(base + u); return { status: r.status, body: await r.json() }; };
    try {
      const disk = await slotsNow();
      const list = await get('/api/domains');
      eq(list.body.identity, disk, 'GET /api/domains answers `identity: {slug: slot}` — the same read as the disk');
      const stats = await get('/api/domains/stats');
      ok(stats.body.domains.every((d) => d.identitySlot === disk[d.slug]),
        'GET /api/domains/stats: every row carries its `identitySlot`', JSON.stringify(stats.body.domains.map((d) => [d.slug, d.identitySlot])));
      eq(stats.body.identity, disk, '…and the whole map as `identity`');
      const one = await get('/api/domains/studies/stats');
      eq(one.body.identitySlot, 3, 'GET /api/domains/:domain/stats carries the SAME slot, so a single-row refresh keeps the colour');
      const dd = await get('/api/config/default-domain');
      eq(dd.body.identity, disk, 'GET /api/config/default-domain carries `identity` (Settings\' Across projects dots)');

      const created = await fetch(base + '/api/domains', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: 'Brand New', template: 'generic' }) });
      const cbody = await created.json();
      ok(created.status === 201 && recordedOf(cbody.slug) !== null,
        'POST /api/domains records the new domain\'s slot at once', JSON.stringify(cbody));
      const after = await slotsNow();
      const kept = Object.keys(disk).every((k) => after[k] === disk[k]);
      ok(kept, '★ …and every existing domain keeps its slot', JSON.stringify({ disk, after }));
      const used = new Set(Object.values(disk));
      ok(!used.has(after[cbody.slug]), '…the new one takes a slot nobody else holds', String(after[cbody.slug]));
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§4 — the widget reads the same slot');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const { getTraySummary } = await import('../src/brain/tray-summary.js');
    const sum = await getTraySummary({});
    const disk = await slotsNow();
    ok(Array.isArray(sum.domains) && sum.domains.length === Object.keys(disk).length,
      'getTraySummary lists every domain', JSON.stringify(sum.domains && sum.domains.map((d) => d.domain)));
    ok(sum.domains.every((d) => d.slot === disk[d.domain]),
      '★ each domains[] row carries `slot` — the recorded one the app paints, so the Knowledge submenu bar matches the app\'s dot',
      JSON.stringify(sum.domains.map((d) => [d.domain, d.slot, d.index])));
    ok(sum.domains.some((d) => d.slot !== d.index + 1),
      'CONTROL: at least one domain\'s slot differs from its position here, so the check above can fail');
    ok(!readdirSync(path.join(DOMAINS, 'ghost')).includes(ident.IDENTITY_FILE), 'the widget read wrote nothing');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§5 — the client loaders keep the recorded slot (lifted from the real views)');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const read = (rel) => readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', rel), 'utf8');
    // Brace-matched lift of one `[async ]function name(` — strings with braces
    // in these three bodies are balanced, so a plain counter is enough; a
    // desync throws rather than lifting half a function.
    const lift = (src, name) => {
      const m = new RegExp('(?:async )?function ' + name + '\\(').exec(src);
      if (!m) throw new Error('could not find ' + name);
      let i = src.indexOf('{', m.index), depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
      }
      throw new Error('unbalanced ' + name);
    };
    const statsBody = { domains: [
      { slug: 'articles', displayName: 'Articles', pageCount: 3, identitySlot: 7 },
      { slug: 'zeta', displayName: 'Zeta', pageCount: 1, identitySlot: 2 },
      { slug: 'shared-x', displayName: 'Mirror', pageCount: 1, identitySlot: 5 },
    ], readonlyDomains: ['shared-x'], identity: { articles: 7, zeta: 2, 'shared-x': 5 } };
    const fetchStub = (body) => async () => ({ ok: true, json: async () => body });

    const ingestSrc = read('src/public/next/views/ingest.js');
    const fds = new Function('fetch', lift(ingestSrc, 'fetchDomainStats') + '\nreturn fetchDomainStats;')(fetchStub(statsBody));
    const got = await fds();
    eq(got.list.map((d) => [d.slug, d.identitySlot]), [['articles', 7], ['zeta', 2]],
      '★ Ingest\'s destination list keeps each domain\'s recorded slot (mirrors filtered out, slots NOT re-derived from the filtered position)');

    const memSrc = read('src/public/next/views/memory.js');
    const st = { domainList: null, domainIdentity: null, domainListReadonly: [] };
    const ldl = new Function('state', 'fetch', 'isCurrentMount', 'render',
      'let domainListInFlight = false;\n' + lift(memSrc, 'loadDomainList') + '\nreturn loadDomainList;')(
      st, fetchStub({ domains: ['articles', 'zeta'], readonlyDomains: [], identity: { articles: 7, zeta: 2 } }), () => true, () => {});
    await ldl(1);
    eq(st.domainIdentity, { articles: 7, zeta: 2 }, '★ Context\'s loadDomainList stores GET /api/domains\' `identity` map — the rail\'s only colour key');
    const st2 = { domainList: null, domainIdentity: null, domainListReadonly: [] };
    const ldl2 = new Function('state', 'fetch', 'isCurrentMount', 'render',
      'let domainListInFlight = false;\n' + lift(memSrc, 'loadDomainList') + '\nreturn loadDomainList;')(
      st2, fetchStub({ domains: ['a'], readonlyDomains: [], identity: ['not', 'a', 'map'] }), () => true, () => {});
    await ldl2(1);
    eq(st2.domainIdentity, null, '…and a malformed `identity` is null (no dots), never a guessed colour');

    const setSrc = read('src/public/next/views/settings.js');
    const sst = {};
    const lvd = new Function('state', 'fetch', 'isCurrentMount', lift(setSrc, 'loadVaultDomains') + '\nreturn loadVaultDomains;')(
      sst, fetchStub(statsBody), () => true);
    await lvd(1);
    eq(sst.vaultDomains.map((d) => [d.slug, d.identitySlot, d.index]), [['articles', 7, 0], ['zeta', 2, 1], ['shared-x', 5, 2]],
      '★ Settings\' Domains-in-this-folder keeps each recorded slot beside its index (the index is only a tie-break)');
  }
} finally {
  __setDomainsDirOverride(null);
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\nPassed: ${passed}   Failed: ${failed}`);
if (failed > 0) { console.log('❌ domain identity assertions failed'); process.exit(1); }
console.log('✅ All domain identity assertions green');
