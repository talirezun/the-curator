#!/usr/bin/env node
/**
 * OFFLINE — v3.68.1, the forward-compatible foundations reader.
 *
 * v3.69.0 introduces foundations manifest VERSION 2. The maintainer shipped
 * this reader first (contract v3.69.0 §2.4, decision D1) so a machine one
 * version behind handles a v2 manifest SAFELY:
 *
 *   §1  reads say "written by a newer version of The Curator" (code
 *       `manifest-newer`) — listFoundations, readWorkingState, getProjectContext,
 *       readFoundation, the MCP's get_project_context text;
 *   §2  EVERY write path refuses with that code, the manifest's sha256 is
 *       unchanged and no file appears in the foundations folder:
 *       saveFoundation, rewriteFoundationRouting (both setters),
 *       removeFoundation, refreshCore, refreshRemoteCore, initFoundations,
 *       setFoundationsSource, addFoundationsFromFolder, and the advisory
 *       maybeRefreshFoundations (through saveWorkingState) SKIPS;
 *   §3  no surface — store, MCP, routes, the shared doors, the view — tells
 *       the user to fix or remove the file (a user who obeyed that on a stale
 *       machine would delete the manifest, and sync would spread it);
 *   §4  a genuinely malformed manifest keeps its existing handling;
 *   §5  spec §1 rule 2 (contract §2.5): unknown top-level and per-document
 *       keys round-trip, after the known keys, in read order, capped at 32
 *       keys and 4 KB per value, every drop named in manifestNotes; a save and
 *       a refresh keep a document's unknown keys;
 *   §6  v1 BYTE IDENTITY: every real-shaped v1 fixture, run through the same
 *       operations, produces exactly the bytes the v3.68.0 writer produced
 *       (`scripts/fixtures/foundations-manifests-v1/golden.json`).
 *
 * Isolated: CURATOR_TEST_USER_DATA_DIR + CURATOR_TEST_DOMAINS_DIR are set to a
 * fresh temp tree BEFORE any store module loads, and the overrides are set too.
 *
 * Run with:  node scripts/test-manifest-forward-compat.js   (exit 0 = all green)
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const TMP = mkdtempSync(path.join(tmpdir(), 'curator-fwdcompat-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
mkdirSync(USER_DATA, { recursive: true });
mkdirSync(DOMAINS, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.on('exit', () => {
  try {
    if (path.dirname(TMP) === tmpdir() && path.basename(TMP).startsWith('curator-fwdcompat-')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
});
const { __setUserDataDirOverride } = await import('../src/brain/paths.js');
const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setUserDataDirOverride(USER_DATA);
__setDomainsDirOverride(DOMAINS);

const WS = await import('../src/brain/working-state.js');
const { getProjectContextHandler, saveFoundationHandler } = await import('../mcp/tools/working-state.js');
const { createStorageAdapter } = await import('../mcp/storage/local.js');
const { doorsFor } = await import('../src/public/next/shared/foundations-add.js');
const { CASES } = await import('./fixtures/foundations-manifests-v1/cases.mjs');
const GOLDEN = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'foundations-manifests-v1', 'golden.json'), 'utf8'));
const storage = createStorageAdapter({ domainsPath: DOMAINS });

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, err) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++; failures.push(label); console.log(`  ✗ ${label}`); if (err) console.log(`    └─ ${String(err).slice(0, 400)}`);
}
function section(name) { console.log(`\n── ${name} ──`); }
const sha = (s) => createHash('sha256').update(s).digest('hex');
const NO_REMOVE = /\bremov/i;
const NO_FIX = /\bfix\b/i;

let n = 0;
function makeProject(prefix = 'fc') {
  const dom = `${prefix}${n++}`;
  mkdirSync(path.join(DOMAINS, dom, 'wiki'), { recursive: true });
  writeFileSync(path.join(DOMAINS, dom, 'CLAUDE.md'), `# ${dom}\n`);
  const fdir = path.join(DOMAINS, dom, 'state', WS.FOUNDATIONS_DIRNAME);
  mkdirSync(fdir, { recursive: true });
  return { dom, fdir, mfp: path.join(fdir, WS.FOUNDATIONS_MANIFEST_FILENAME) };
}
const listDir = (d) => readdirSync(d).sort().join(',');

// A synthetic version-2 manifest, shaped as contract §1.4 draws it.
const V2 = `${JSON.stringify({
  version: 2,
  sources: [
    { id: 's1', root: '/srv/checkouts/lumina', remote: { owner: 'acme', repo: 'lumina', ref: null, path: null },
      lastRefreshAt: '2026-09-23T10:00:00.000Z', lastRefreshCommit: '0123456789abcdef0123456789abcdef01234567' },
    { id: 's2', root: null, remote: { owner: 'acme', repo: 'docs', ref: 'main', path: null }, lastRefreshAt: null, lastRefreshCommit: null },
  ],
  budgetBytes: 204800,
  order: ['architecture', 'decisions', 'conventions', 'roadmap', 'api', 'guide', 'other'],
  documents: [
    { slug: 'decisions-agents.md', role: 'decisions', title: 'Decisions', source: { kind: 'repo', path: 'docs/dev/decisions-agents.md', group: 's1' },
      sha256: 'a'.repeat(64), bytes: 10, updatedAt: '2026-09-23T10:00:00.000Z', commit: null, authoredBy: { kind: 'human' }, skeleton: false, readFirst: true },
    { slug: 'lumina-architecture.md', role: 'architecture', title: 'Lumina', source: { kind: 'repo', path: 'docs/architecture.md', group: 's2' },
      sha256: 'b'.repeat(64), bytes: 10, updatedAt: '2026-09-23T10:00:00.000Z', commit: null, authoredBy: { kind: 'human' }, skeleton: false, readFirst: false },
    { slug: 'notes.md', role: 'other', title: 'Notes', source: { kind: 'curator' }, copiedFrom: 'dev',
      sha256: 'c'.repeat(64), bytes: 10, updatedAt: '2026-09-23T10:00:00.000Z', commit: null, authoredBy: { kind: 'human' }, skeleton: false, readFirst: false },
  ],
}, null, 2)}\n`;

function v2Project() {
  const p = makeProject('nv');
  writeFileSync(p.mfp, V2);
  for (const s of ['decisions-agents.md', 'lumina-architecture.md', 'notes.md']) writeFileSync(path.join(p.fdir, s), '# kept\n');
  return p;
}

// A local checkout and a folder to add from (both synthetic, under TMP).
const CHECKOUT = path.join(TMP, 'checkout');
mkdirSync(path.join(CHECKOUT, 'docs'), { recursive: true });
writeFileSync(path.join(CHECKOUT, 'docs', 'architecture.md'), '# Architecture\n\nFrom the checkout.\n');
writeFileSync(path.join(CHECKOUT, 'decisions-agents.md'), '# Decisions\n\nFrom the checkout, changed.\n');
const NOTES = path.join(TMP, 'notes');
mkdirSync(NOTES, { recursive: true });
writeFileSync(path.join(NOTES, 'a.md'), '# A\n\nA note.\n');

// ═════════════════════════════════════════════════════════════════════════
section('1. Reads say "written by a newer version", never "fix or remove"');
{
  const p = v2Project();
  const before = sha(readFileSync(p.mfp));
  const idx = await WS.listFoundations(p.dom, p.dom);
  assert(idx.ok && idx.present === false && idx.manifestErrorCode === 'manifest-newer',
    'listFoundations: present:false, manifestErrorCode "manifest-newer"', JSON.stringify(idx).slice(0, 300));
  assert(/newer version of The Curator/.test(idx.manifestError) && /Update the app/.test(idx.manifestError),
    '…and the message says a newer version wrote it and to update the app', idx.manifestError);
  assert(!NO_REMOVE.test(idx.manifestError) && !NO_FIX.test(idx.manifestError), '…and never says fix or remove', idx.manifestError);
  assert(/version 2/.test(idx.manifestError), '…and names the version it found', idx.manifestError);
  assert(Array.isArray(idx.orphanFiles) && idx.orphanFiles.length === 0,
    '…and the listed files are NOT reported as orphans (the newer manifest does list them)', JSON.stringify(idx.orphanFiles));
  const rws = await WS.readWorkingState(p.dom, {});
  assert(rws.foundations && rws.foundations.manifestErrorCode === 'manifest-newer' && rws.foundations.manifestError === idx.manifestError,
    'readWorkingState: the summary carries the same code and message', JSON.stringify(rws.foundations).slice(0, 300));
  const ctx = await WS.getProjectContext(p.dom, p.dom, {});
  assert(ctx.ok !== false && ctx.foundations.manifestErrorCode === 'manifest-newer' && ctx.foundations.present === false,
    'getProjectContext: the foundations block carries the code', JSON.stringify(ctx.foundations).slice(0, 300));
  const rf = await WS.readFoundation(p.dom, p.dom, 'notes.md');
  assert(rf.ok === false && rf.code === 'manifest-newer' && !NO_REMOVE.test(rf.message), 'readFoundation refuses with the code', JSON.stringify(rf));
  const mcp = await getProjectContextHandler({ project: p.dom }, storage);
  const mcpText = JSON.stringify(mcp);
  assert(mcp.foundations && mcp.foundations.manifestErrorCode === 'manifest-newer', 'MCP get_project_context: the code rides through');
  assert(/update The Curator/.test(mcpText) && !NO_REMOVE.test(mcpText) && !/needs fixing/.test(mcpText),
    'MCP get_project_context: the report says update, never fix or remove', mcpText.slice(0, 600));
  assert(sha(readFileSync(p.mfp)) === before, 'no read rewrote the manifest (sha256 unchanged)');
  // CONTROL: an ordinary v1 project gets no code key at all — its envelopes keep their bytes.
  const c = makeProject('ctl');
  await WS.saveFoundation(c.dom, c.dom, { slug: 'a', text: '# A\n\nbody\n' });
  const cIdx = await WS.listFoundations(c.dom, c.dom);
  const cCtx = await WS.getProjectContext(c.dom, c.dom, {});
  const cRws = await WS.readWorkingState(c.dom, {});
  assert(!('manifestErrorCode' in cIdx) && !('manifestErrorCode' in cCtx.foundations) && !('manifestErrorCode' in cRws.foundations),
    'CONTROL: a v1 project carries no manifestErrorCode key anywhere');
}

// ═════════════════════════════════════════════════════════════════════════
section('2. Every write path refuses with the code, and the bytes stay put');
{
  const p = v2Project();
  const before = sha(readFileSync(p.mfp));
  const files0 = listDir(p.fdir);
  const paths = [
    ['saveFoundation', () => WS.saveFoundation(p.dom, p.dom, { slug: 'new', text: '# New\n\nbody\n' })],
    ['saveFoundation (existing slug)', () => WS.saveFoundation(p.dom, p.dom, { slug: 'notes', text: '# Notes\n\nnew body\n' })],
    ['rewriteFoundationRouting (setFoundationReadFirst)', () => WS.setFoundationReadFirst(p.dom, p.dom, 'notes.md', true)],
    ['rewriteFoundationRouting (setFoundationStartState)', () => WS.setFoundationStartState(p.dom, p.dom, 'notes.md', 'not-at-start')],
    ['removeFoundation', () => WS.removeFoundation(p.dom, p.dom, 'notes.md')],
    ['refreshCore (a local checkout)', () => WS.refreshFoundationsFromRepo(p.dom, p.dom, CHECKOUT, { source: 'local' })],
    ['refreshRemoteCore (GitHub)', () => WS.refreshFoundationsFromRepo(p.dom, p.dom, null, { source: 'remote', remote: 'acme/lumina' })],
    ['initFoundations (curator)', () => WS.initFoundations(p.dom, p.dom, { ownership: 'curator' })],
    ['initFoundations (repo)', () => WS.initFoundations(p.dom, p.dom, { ownership: 'repo', repoRoot: CHECKOUT })],
    ['setFoundationsSource', () => WS.setFoundationsSource(p.dom, p.dom, { remote: 'acme/lumina' })],
    ['addFoundationsFromFolder', () => WS.addFoundationsFromFolder(p.dom, p.dom, { root: NOTES, files: [{ path: 'a.md' }] })],
  ];
  for (const [name, fn] of paths) {
    const r = await fn();
    assert(r && r.ok === false && r.code === 'manifest-newer' && r.reason === 'manifest-unreadable',
      `${name}: refused with code "manifest-newer"`, JSON.stringify(r).slice(0, 300));
    assert(typeof r.message === 'string' && /newer version of The Curator/.test(r.message) && !NO_REMOVE.test(r.message) && !NO_FIX.test(r.message),
      `${name}: …the message says update, never fix or remove`, r && r.message);
    assert(sha(readFileSync(p.mfp)) === before && listDir(p.fdir) === files0, `${name}: …manifest sha256 and folder unchanged`);
  }
  // maybeRefreshFoundations — the advisory refresh a save runs — SKIPS, and the save still succeeds.
  writeFileSync(path.join(CHECKOUT, '.curator-project'), `${p.dom}\n`);
  const save = await WS.saveWorkingState(p.dom, { scope: 'main', machine: 'testbox', headline: 'h', nowState: 'n', repoRoot: CHECKOUT });
  const fr = save.foundationsRefresh;
  assert(save.ok && fr && fr.attempted === false && fr.code === 'manifest-newer' && /newer version/.test(fr.skipped) && !NO_REMOVE.test(fr.skipped),
    'maybeRefreshFoundations (saveWorkingState repoRoot): skipped, with the code, the save itself succeeds', JSON.stringify(fr));
  assert(sha(readFileSync(p.mfp)) === before && listDir(p.fdir) === files0, 'maybeRefreshFoundations: …manifest sha256 and folder unchanged');
  // The MCP save_foundation handler carries the code through.
  const h = await saveFoundationHandler({ project: p.dom, slug: 'x', text: '# X\n\nbody\n', commissioned_by_owner: true, harness: 'h', model: 'm' }, storage);
  assert(h.ok === false && h.code === 'manifest-newer' && !NO_REMOVE.test(JSON.stringify(h)), 'MCP save_foundation: refused with the code, no "remove"', JSON.stringify(h));
  assert(sha(readFileSync(p.mfp)) === before, 'MCP save_foundation: …manifest sha256 unchanged');
}

// ═════════════════════════════════════════════════════════════════════════
section('3. The routes and the view never say fix or remove for a newer manifest');
{
  const p = v2Project();
  const before = sha(readFileSync(p.mfp));
  const express = (await import('express')).default;
  const router = (await import('../src/routes/memory.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/memory', router);
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/memory/${p.dom}/${p.dom}`;
  const call = async (method, sub, body) => {
    const r = await fetch(base + sub, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, text: await r.text() };
  };
  try {
    const get = await call('GET', '');
    const g = JSON.parse(get.text);
    assert(get.status === 200 && g.foundations && g.foundations.manifestErrorCode === 'manifest-newer' && /newer version/.test(g.foundations.manifestError),
      'GET project: the wire index carries the code and the message', get.text.slice(0, 300));
    const writes = [
      ['PUT foundation', 'PUT', '/foundations/notes.md', { text: '# Notes\n\nnew\n', role: 'other' }],
      ['PUT new foundation', 'PUT', '/foundations/brand-new.md', { text: '# New\n\nnew\n', role: 'other' }],
      ['PATCH foundation', 'PATCH', '/foundations/notes.md', { readFirst: true }],
      ['DELETE foundation', 'DELETE', '/foundations/notes.md', { confirm: 'notes.md' }],
      ['POST init', 'POST', '/foundations/init', { ownership: 'curator' }],
      ['POST add-local', 'POST', '/foundations/add-local', { root: NOTES, files: [{ path: 'a.md' }] }],
      ['POST refresh', 'POST', '/foundations/refresh', {}],
      ['POST source', 'POST', '/foundations/source', { remote: 'acme/lumina' }],
    ];
    for (const [name, m, sub, body] of writes) {
      const r = await call(m, sub, body);
      assert(r.status >= 400 && !NO_REMOVE.test(r.text) && /newer version of The Curator/.test(r.text),
        `${name}: refused (${r.status}), says newer version, never "remove"`, r.text.slice(0, 400));
    }
  } finally { await new Promise((r) => server.close(r)); }
  assert(sha(readFileSync(p.mfp)) === before, 'routes: manifest sha256 unchanged after every write route');

  // The shared doors (pure): the newer case says update, the malformed case keeps its words.
  const dn = doorsFor({ manifestError: 'x', manifestNewer: true, present: false }, {});
  assert(dn.local.available === false && /newer version/.test(dn.local.why) && !NO_REMOVE.test(dn.local.why) && !NO_FIX.test(dn.local.why),
    'doorsFor: a newer manifest closes both doors and says update', dn.local.why);
  const dm = doorsFor({ manifestError: 'x', present: false }, {});
  assert(dm.local.available === false && /cannot be read/.test(dm.local.why), 'CONTROL doorsFor: a malformed manifest keeps its own words');

  // The view: the newer branch's own strings (the view is a browser module;
  // its newer-case copy is read from the source it ships, the ternary arm).
  const view = readFileSync(path.join(REPO, 'src', 'public', 'next', 'views', 'memory.js'), 'utf8');
  const arms = [...view.matchAll(/facts\.manifestNewer\s*\n?\s*\?\s*('(?:[^'\\]|\\.)*')/g)].map((m) => m[1]);
  assert(arms.length >= 1 && arms.every((s) => !NO_REMOVE.test(s) && !NO_FIX.test(s)) && arms.some((s) => /updated/.test(s)),
    `the view's newer-manifest description (${arms.length} arm) says update, never fix or remove`, arms.join(' | '));
  assert(/manifestNewer: !!\(f && f\.manifestErrorCode === 'manifest-newer'\)/.test(view), 'the view derives manifestNewer from the wire code');
  assert(/facts\.manifestNewer \? '' : 'This project’s documents manifest could not be read/.test(view),
    'the view\'s notice drops "could not be read… cannot be trusted" for a newer manifest');
}

// ═════════════════════════════════════════════════════════════════════════
section('4. A genuinely malformed manifest keeps its existing handling');
{
  for (const junk of ['{"version": 1.5, "documents": []}', '{"version": "2", "documents": []}', '{"version": 0, "documents": []}',
    '{"version": 1, "documents": "nope"}', 'not json']) {
    const p = makeProject('mal');
    writeFileSync(p.mfp, junk);
    const idx = await WS.listFoundations(p.dom, p.dom);
    const s = await WS.saveFoundation(p.dom, p.dom, { slug: 'n', text: '# n\n\nbody\n' });
    assert(idx.present === false && typeof idx.manifestError === 'string' && !('manifestErrorCode' in idx)
      && s.ok === false && s.reason === 'manifest-unreadable' && s.code === undefined && /Fix or remove/.test(s.message)
      && readFileSync(p.mfp, 'utf8') === junk,
    `${JSON.stringify(junk).slice(0, 36)}: malformed as before (no newer code, the old refusal text)`, JSON.stringify({ idx: idx.manifestError, s }).slice(0, 300));
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('5. Unknown keys round-trip (spec §1 rule 2), capped and disclosed');
{
  const p = makeProject('ux');
  const mf = {
    version: 1, ownership: 'curator', repo: null, budgetBytes: 204800,
    order: ['architecture', 'decisions', 'conventions', 'roadmap', 'api', 'guide', 'other'],
    documents: [
      { slug: 'a.md', role: 'other', title: 'A', futureDoc: { group: 's9' }, source: { kind: 'curator' }, sha256: 'a'.repeat(64), bytes: 5,
        updatedAt: '2026-09-20T10:00:00.000Z', commit: null, authoredBy: null, skeleton: false, readFirst: false, copiedFrom: null, zeta: 1 },
      { slug: 'b.md', role: 'other', title: 'B', source: { kind: 'curator' }, sha256: 'b'.repeat(64), bytes: 5,
        updatedAt: '2026-09-20T10:00:00.000Z', commit: null, authoredBy: null, skeleton: false, readFirst: false, copiedFrom: null },
    ],
    futureTop: ['x', 1],
    alpha: null,
  };
  writeFileSync(p.mfp, `${JSON.stringify(mf, null, 2)}\n`);
  writeFileSync(path.join(p.fdir, 'a.md'), '# A\n\nbody of a, long enough\n');
  const r1 = await WS.setFoundationReadFirst(p.dom, p.dom, 'b.md', true);
  const out = JSON.parse(readFileSync(p.mfp, 'utf8'));
  const topKeys = Object.keys(out);
  assert(r1.ok && JSON.stringify(topKeys) === JSON.stringify(['version', 'ownership', 'repo', 'budgetBytes', 'order', 'documents', 'futureTop', 'alpha']),
    'top-level unknown keys are re-emitted after the known ones, in read order', JSON.stringify(topKeys));
  assert(JSON.stringify(out.futureTop) === '["x",1]' && out.alpha === null, '…with their values intact');
  const aKeys = Object.keys(out.documents[0]);
  assert(JSON.stringify(aKeys.slice(-2)) === '["futureDoc","zeta"]' && out.documents[0].futureDoc.group === 's9' && out.documents[0].zeta === 1,
    'per-document unknown keys are re-emitted after the known ones, in read order', JSON.stringify(aKeys));
  assert(!('futureDoc' in out.documents[1]) && out.documents[1].readFirst === true, 'a document without unknown keys gains none');
  // They never leak into a read's wire shape.
  const idx = await WS.listFoundations(p.dom, p.dom);
  assert(!JSON.stringify(idx).includes('futureDoc') && !JSON.stringify(idx).includes('futureTop'), 'unknown keys never reach listFoundations output');
  // A save of new text KEEPS the document's unknown keys (it builds a fresh entry).
  const s = await WS.saveFoundation(p.dom, p.dom, { slug: 'a', text: '# A\n\nnew body of a, long enough too\n' });
  const out2 = JSON.parse(readFileSync(p.mfp, 'utf8'));
  assert(s.ok && out2.documents[0].futureDoc?.group === 's9' && out2.documents[0].zeta === 1 && JSON.stringify(out2.futureTop) === '["x",1]',
    'saveFoundation keeps the document\'s and the manifest\'s unknown keys', JSON.stringify(out2.documents[0]));
  // A remove keeps the top level's.
  await WS.removeFoundation(p.dom, p.dom, 'b.md');
  assert(JSON.stringify(JSON.parse(readFileSync(p.mfp, 'utf8')).futureTop) === '["x",1]', 'removeFoundation keeps the top-level unknown keys');

  // Caps: 33 unknown keys → 32 kept, 1 dropped and named; a > 4 KB value dropped and named; __proto__ dropped.
  const q = makeProject('cap');
  const extra = {};
  for (let i = 0; i < 33; i++) extra[`k${String(i).padStart(2, '0')}`] = i;
  const raw = `${JSON.stringify({ ...mf, documents: [mf.documents[1]], futureTop: undefined, alpha: undefined, big: 'x'.repeat(5000), ...extra }, null, 2)}`
    .replace(/\n}$/, ',\n  "__proto__": {"polluted": true}\n}\n');
  writeFileSync(q.mfp, raw);
  const qi = await WS.listFoundations(q.dom, q.dom);
  const notes = qi.manifestNotes.join(' | ');
  assert(qi.present === true && /"k32" was dropped: over the 32-field cap/.test(notes), 'the 33rd unknown key is dropped and NAMED in manifestNotes', notes);
  assert(/"big" was dropped: its value is over 4096 bytes/.test(notes), 'a value over 4 KB is dropped and named', notes);
  assert(/"__proto__" was dropped/.test(notes) && ({}).polluted === undefined, '__proto__ is dropped, and nothing is polluted', notes);
  await WS.setFoundationReadFirst(q.dom, q.dom, 'b.md', true);
  const qo = JSON.parse(readFileSync(q.mfp, 'utf8'));
  const qk = Object.keys(qo).filter((k) => /^k\d\d$/.test(k));
  assert(qk.length === 32 && qk[0] === 'k00' && qk[31] === 'k31' && !('big' in qo) && !Object.prototype.hasOwnProperty.call(qo, '__proto__'),
    'the rewrite carries exactly the 32 kept keys', JSON.stringify(Object.keys(qo)));
  // A refresh from the checkout KEEPS a mirrored document's unknown keys.
  const m = makeProject('rf');
  writeFileSync(m.mfp, `${JSON.stringify({
    version: 1, ownership: 'repo', repo: { root: CHECKOUT, remote: null, lastRefreshAt: null, lastRefreshCommit: null }, budgetBytes: 204800,
    order: mf.order, documents: [{ slug: 'decisions-agents.md', role: 'decisions', title: 'D', source: { kind: 'repo', path: 'decisions-agents.md' },
      sha256: 'd'.repeat(64), bytes: 3, updatedAt: null, commit: null, authoredBy: null, skeleton: false, readFirst: true, futureDoc: 'kept' }],
    futureTop: 7,
  }, null, 2)}\n`);
  const rr = await WS.refreshFoundationsFromRepo(m.dom, m.dom, CHECKOUT, { source: 'local' });
  const mo = JSON.parse(readFileSync(m.mfp, 'utf8'));
  assert(rr.ok && rr.refreshed.includes('decisions-agents.md') && mo.documents[0].futureDoc === 'kept' && mo.futureTop === 7 && mo.documents[0].sha256 !== 'd'.repeat(64),
    'refreshCore keeps a refreshed document\'s unknown keys and the top level\'s', JSON.stringify({ rr: rr.reason || rr.refreshed, d: mo.documents[0] }).slice(0, 300));
}

// ═════════════════════════════════════════════════════════════════════════
section('6. v1 byte identity: every real-shaped fixture, byte for byte as v3.68.0 wrote it');
{
  let i = 0;
  for (const c of CASES) {
    const p = makeProject(`fx${i++}-`);
    writeFileSync(p.mfp, c.manifest);
    // Reads never touch the bytes.
    await WS.listFoundations(p.dom, p.dom);
    await WS.getProjectContext(p.dom, p.dom, {});
    assert(readFileSync(p.mfp, 'utf8') === c.manifest, `${c.name}: reads leave the bytes alone`);
    const golden = GOLDEN[c.name];
    assert(Array.isArray(golden) && golden.length === c.ops.length, `${c.name}: a golden per operation (${c.ops.length})`);
    for (let k = 0; k < c.ops.length; k++) {
      const [op, slug, arg] = c.ops[k];
      let r;
      if (op === 'readFirst') r = await WS.setFoundationReadFirst(p.dom, p.dom, slug, arg);
      else if (op === 'atStart') r = await WS.setFoundationStartState(p.dom, p.dom, slug, arg);
      else if (op === 'remove') r = await WS.removeFoundation(p.dom, p.dom, slug);
      else if (op === 'save') r = await WS.saveFoundation(p.dom, p.dom, { slug, text: arg, authoredBy: { kind: 'human' } });
      const got = readFileSync(p.mfp, 'utf8').replace(/"updatedAt": "[^"]+"/g, '"updatedAt": "<ts>"');
      assert(r && r.ok && got === golden[k], `${c.name}: ${op} ${slug} → bytes identical to v3.68.0 (sha ${sha(got).slice(0, 12)})`,
        r && r.ok ? `got sha ${sha(got).slice(0, 12)} want ${sha(golden[k] || '').slice(0, 12)}` : JSON.stringify(r));
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
section('7. Every other surface: tile, orphan notice, session-start Markdown, chat, reading plan');
{
  const { renderContextMarkdown } = await import('../src/brain/context-markdown.js');
  const { __testing: chatT } = await import('../src/brain/chat.js');
  const { loadPlanInputs } = await import('../src/brain/reading-plan.js');
  const newer = v2Project();
  const mal = makeProject('mal7-');
  writeFileSync(mal.mfp, '{"version": 1, "documents": "nope"}');
  writeFileSync(path.join(mal.fdir, 'left.md'), '# left\n');
  const nIdx = await WS.listFoundations(newer.dom, newer.dom);
  const mIdx = await WS.listFoundations(mal.dom, mal.dom);
  assert(nIdx.orphanFiles.length === 0 && mIdx.orphanFiles.includes('left.md'),
    'orphans: none for a newer manifest; CONTROL: a malformed one still lists its stranded file', JSON.stringify([nIdx.orphanFiles, mIdx.orphanFiles]));
  const nCtx = await WS.getProjectContext(newer.dom, newer.dom, {});
  const mCtx = await WS.getProjectContext(mal.dom, mal.dom, {});
  assert(nCtx.foundations.orphanFiles.length === 0, 'getProjectContext: no orphan files for a newer manifest');
  const nMcp = JSON.stringify(await getProjectContextHandler({ project: newer.dom }, storage));
  assert(!/orphan file|no manifest entry|not in the manifest/i.test(nMcp) && JSON.parse(nMcp).foundations.orphanFiles.length === 0,
    'MCP get_project_context: no orphan files, and nothing calls the files orphans or unlisted', nMcp.slice(0, 300));

  // Session-start Markdown (the CLI and the hook).
  const nMd = renderContextMarkdown(nCtx);
  assert(/newer version of The Curator/.test(nMd) && !/could not be read/i.test(nMd) && !NO_REMOVE.test(nMd) && !/orphan file|no manifest entry/i.test(nMd),
    'context Markdown: the newer message, no "could not be read", no "remove", no orphans', nMd.slice(0, 600));
  const mMd = renderContextMarkdown({ ...mCtx, foundations: { ...mCtx.foundations, present: true, count: 1, index: [] } });
  assert(/The manifest could not be read: /.test(mMd), 'CONTROL context Markdown: a malformed manifest keeps "The manifest could not be read:"');

  // Chat's omission notes.
  const nNotes = chatT.projectOmissionNotes(nCtx, []).join(' ');
  const mNotes = chatT.projectOmissionNotes(mCtx, []).join(' ');
  assert(/newer version of The Curator/.test(nNotes) && !/could not be read/i.test(nNotes) && !NO_REMOVE.test(nNotes),
    'chat: the newer message without "could not be read"', nNotes);
  assert(/The foundations manifest could not be read: /.test(mNotes), 'CONTROL chat: a malformed manifest keeps its wording', mNotes);

  // Reading plan.
  const nPlan = await loadPlanInputs(newer.dom, newer.dom);
  const mPlan = await loadPlanInputs(mal.dom, mal.dom);
  assert(nPlan.ok === false && nPlan.code === 'manifest-newer' && /newer version/.test(nPlan.message) && !/could not be read/i.test(nPlan.message),
    'reading plan: refused with the newer message, no "could not be read"', JSON.stringify(nPlan));
  assert(mPlan.ok === false && /The documents manifest could not be read: /.test(mPlan.message), 'CONTROL reading plan: a malformed manifest keeps its wording', JSON.stringify(mPlan));

  // The view, executed: the notices, the summary words and the DOCUMENTS tile.
  const view = readFileSync(path.join(REPO, 'src', 'public', 'next', 'views', 'memory.js'), 'utf8');
  const extract = (name) => {
    const m = new RegExp('(?:^|\\n)(?:export\\s+)?function ' + name + '\\s*\\(').exec(view);
    if (!m) throw new Error(`no ${name}`);
    const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
    let p = view.indexOf('(', start), pd = 0;
    for (; p < view.length; p++) { if (view[p] === '(') pd++; else if (view[p] === ')') { pd--; if (pd === 0) { p++; break; } } }
    let i = view.indexOf('{', p), d = 0;
    for (; i < view.length; i++) { if (view[i] === '{') d++; else if (view[i] === '}') { d--; if (d === 0) { i++; break; } } }
    return view.slice(start, i);
  };
  const notices = new Function('state', 'icon', 'escapeHtml', 'foundationsFacts',
    `${extract('foundationsNotices')}\nreturn foundationsNotices;`)({}, () => '', (x) => x, (r) => r);
  const nHtml = notices({ manifestError: nIdx.manifestError, manifestNewer: true, orphanFiles: ['a.md', 'b.md'] });
  const mHtml = notices({ manifestError: 'documents is not an array', manifestNewer: false, orphanFiles: ['left.md'] });
  assert(/newer version/.test(nHtml) && !/no manifest entry|could not be read/.test(nHtml),
    'view notices (newer): the message only — no orphan-files warning, no "could not be read"', nHtml);
  assert(/no manifest entry \(left\.md\)/.test(mHtml) && /could not be read/.test(mHtml), 'CONTROL view notices (malformed): both old warnings stay', mHtml);
  const words = new Function('foundationsOwnershipWord', `${extract('foundationsWord')}\n${extract('foundationsSummaryMeta')}\nreturn { foundationsWord, foundationsSummaryMeta };`)(() => '');
  assert(words.foundationsWord({ manifestError: 'x', manifestNewer: true }) === 'newer version'
    && /newer version · update The Curator/.test(words.foundationsSummaryMeta({ manifestError: 'x', manifestNewer: true })),
  'view summary words (newer): "newer version", "update The Curator"');
  assert(words.foundationsWord({ manifestError: 'x' }) === 'manifest unreadable' && words.foundationsSummaryMeta({ manifestError: 'x' }) === 'manifest unreadable',
    'CONTROL view summary words (malformed): "manifest unreadable"');
  const strip = extract('renderLayerStrip');
  const a = strip.indexOf('if (facts.manifestError) {');
  const b = strip.indexOf('} else if (!facts.present)', a);
  const tile = new Function('facts', `let value = null; let sub = null; let tier = null;\n${strip.slice(a, b)}}\nreturn { value, sub, tier };`);
  const nt = tile({ manifestError: 'x', manifestNewer: true });
  const mt = tile({ manifestError: 'x', manifestNewer: false });
  assert(a > 0 && b > a && nt.value === 'newer version' && nt.sub === 'update The Curator', 'DOCUMENTS tile (newer): "newer version" / "update The Curator"', JSON.stringify(nt));
  assert(mt.value === 'manifest unreadable' && mt.sub === null, 'CONTROL DOCUMENTS tile (malformed): "manifest unreadable"', JSON.stringify(mt));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1); }
