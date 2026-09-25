#!/usr/bin/env node
/**
 * test-trash-restore.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * Guards Settings › Trash (v3.76.0): LIST what the three deletes moved into
 * The Curator's trash, RESTORE one entry to where it came from, DELETE one
 * entry forever.
 *
 * ARMS, all driving real code:
 *   §S  the REAL store (src/brain/trash-items.js) over entries made by the REAL
 *       deletes (deleteDomain, deleteProject, deleteWorkStream) — so the
 *       names and origin records it parses are the ones production mints;
 *   §L  legacy entries (no origin record, as v3.73.0–v3.75.0 left them),
 *       parsed from the name, and an ambiguous one refused as unknown origin;
 *   §R  the REAL router (src/routes/trash.js) mounted on loopback and called
 *       over HTTP — status codes, the registry 409, the confirm gate;
 *   §X  the REAL src/server.js spawned on an isolated port: the router is
 *       registered, and a foreign-Origin mutation is 403;
 *   §V  the view's DOM-free builders (views/trash-list.js), imported for real.
 *
 * ISOLATION: CURATOR_TEST_USER_DATA_DIR (the trash) and CURATOR_TEST_DOMAINS_DIR
 * + __setDomainsDirOverride (the domains tree) point into one tempdir BEFORE
 * any app module is imported, removed in `finally`.
 *
 * NOT ENFORCED: the EXDEV (other volume) path of a restore — it is trash.js's
 * __moveDirectory, whose copy fallback its own suite drives; and the race
 * between the exists-check and rename(2) on a domain restore, which needs a
 * second process timed to a syscall.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, symlinkSync, renameSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
function eq(label, actual, expected) {
  ok(label, Object.is(actual, expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

// ── Isolation, before any app import ──────────────────────────────────────
const TMP = mkdtempSync(join(tmpdir(), 'curator-trash-'));
const DOMAINS = join(TMP, 'domains');
const USER_DATA = join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
function cleanup() {
  try {
    const rel = relative(tmpdir(), TMP);
    if (rel && !rel.startsWith('..') && !rel.includes('/')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
}

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const files = await import('../src/brain/files.js');
const store = await import('../src/brain/working-state.js');
const T = await import('../src/brain/trash-items.js');
const { getTrashDir } = await import('../src/brain/paths.js');
const { acquireFileLock, registerWrite } = await import('../src/brain/write-registry.js');
const express = (await import('express')).default;
const trashRouter = (await import('../src/routes/trash.js')).default;
const V = await import('../src/public/next/views/trash-list.js');

function makeDomain(slug, extraCLAUDE) {
  mkdirSync(join(DOMAINS, slug, 'wiki', 'entities'), { recursive: true });
  mkdirSync(join(DOMAINS, slug, 'conversations'), { recursive: true });
  mkdirSync(join(DOMAINS, slug, 'raw'), { recursive: true });
  writeFileSync(join(DOMAINS, slug, 'CLAUDE.md'), (extraCLAUDE || '') + '# Domain: ' + slug + ' Display\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'index.md'), '# Wiki Index — ' + slug + ' Display\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'log.md'), '# Ingest Log — ' + slug + ' Display\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'entities', 'one.md'), '# One\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'entities', 'two.md'), '# Two\n');
  writeFileSync(join(DOMAINS, slug, 'raw', 'source.txt'), 'raw text\n');
  writeFileSync(join(DOMAINS, slug, 'conversations', 'c1.json'), JSON.stringify({ id: 'c1', domain: slug, messages: [] }));
}

/** path -> sha256 for every file under `dir`, as one comparable string. */
function fingerprint(dir) {
  if (!existsSync(dir)) return 'ABSENT';
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(relative(dir, p) + ' ' + createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  })(dir);
  return out.join('\n');
}

async function save(domain, input) {
  const r = await store.saveWorkingState(domain, { nowState: 'Now: ' + input.headline, ...input });
  if (!r || r.ok !== true) throw new Error('fixture save refused: ' + JSON.stringify(r));
}

const TR = (kind) => join(getTrashDir(), kind);
const trashIds = (kind) => (existsSync(TR(kind)) ? readdirSync(TR(kind), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
const find = async (pred) => (await T.listTrash()).entries.find(pred);

// ── Loopback router ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/trash', trashRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;
async function call(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, body: json || {} };
}

try {
  section('§0 — isolation');
  ok('the trash resolves inside the test tempdir', getTrashDir().startsWith(USER_DATA), getTrashDir());
  ok('the domains dir is the tempdir one', DOMAINS.startsWith(TMP));
  {
    const empty = await T.listTrash();
    ok('an absent trash lists as empty, not an error', empty.ok === true && empty.entries.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§S — the store, over entries made by the REAL deletes');
  // ═══════════════════════════════════════════════════════════════════════
  makeDomain('alpha');
  makeDomain('beta');
  await store.saveProjectBriefText('alpha', 'alpha', '# Brief\n\nalpha.\n');
  await save('alpha', { scope: 'main', headline: 'Main on this machine' });
  await save('alpha', { scope: 'main', machine: 'laptop-b', headline: 'Main on laptop' });
  await save('alpha', { scope: 'keep', headline: 'Kept stream' });
  const cp = await store.createProject('alpha', 'proj');
  if (!cp || cp.ok !== true) throw new Error('fixture createProject refused');
  await store.saveProjectBriefText('alpha', 'proj', '# Proj brief\n');
  await save('alpha', { project: 'proj', scope: 'feat', headline: 'Named project stream' });
  await save('alpha', { project: 'proj', scope: 'feat2', machine: 'laptop-b', headline: 'Second stream' });

  const scopeFp = fingerprint(join(DOMAINS, 'alpha', 'state', 'main'));
  const projFp = fingerprint(join(DOMAINS, 'alpha', 'state', 'proj'));
  const betaFp = fingerprint(join(DOMAINS, 'beta'));

  const dScope = await store.deleteWorkStream('alpha', 'alpha', 'main', { confirm: 'main' });
  const dProj = await store.deleteProject('alpha', 'proj', { confirm: 'proj' });
  const dDom = await files.deleteDomain('beta', { confirm: 'beta' });
  ok('SETUP: the three real deletes succeeded', dScope.ok && dProj.ok && !!dDom.trashPath);
  ok('the delete writes an origin record BESIDE the folder, never inside it',
    existsSync(dDom.trashPath + '.origin.json') && !existsSync(join(dDom.trashPath, '.origin.json'))
    && fingerprint(dDom.trashPath) === betaFp, 'trash copy differs from the deleted domain');

  const list = await T.listTrash();
  eq('the listing has all three kinds', list.entries.map((e) => e.kind).sort().join(','), 'domains,projects,scopes');
  const eS = list.entries.find((e) => e.kind === 'scopes');
  const eP = list.entries.find((e) => e.kind === 'projects');
  const eD = list.entries.find((e) => e.kind === 'domains');
  ok('a handoff: name, domain, project (the domain’s own), where it goes, from the record',
    eS.name === 'main' && eS.domain === 'alpha' && eS.project === 'alpha' && eS.isDefaultProject === true
    && eS.restoreTo === 'domains/alpha/state/main/' && eS.originFrom === 'record' && eS.status === 'ready', JSON.stringify(eS));
  eq('...and what it held: two saved copies', eS.contains.machines, 2);
  ok('a project: name, domain, restoreTo, brief and two handoffs',
    eP.name === 'proj' && eP.domain === 'alpha' && eP.restoreTo === 'domains/alpha/state/proj/'
    && eP.contains.hasBrief === true && eP.contains.scopes === 2 && eP.contains.handoffs === 2, JSON.stringify(eP));
  ok('a domain: name, display name, pages/conversations/raw counted, a size',
    eD.name === 'beta' && eD.displayName === 'beta Display' && eD.contains.pages === 2
    && eD.contains.conversations === 1 && eD.contains.rawSources === 1 && eD.bytes > 0 && eD.files >= 7, JSON.stringify(eD));
  ok('deletedAt is the folder stamp as an ISO instant', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(eD.deletedAt) &&
    Math.abs(Date.parse(eD.deletedAt) - Date.now()) < 120000, eD.deletedAt);
  {
    // Newest first: age one entry's stamp by renaming it (and its record).
    const oldId = eP.id.replace(/--\d{4}-\d{2}-\d{2}T[\d-]+Z$/, '--2020-01-01T00-00-00Z');
    renameSync(join(TR('projects'), eP.id), join(TR('projects'), oldId));
    renameSync(join(TR('projects'), eP.id) + '.origin.json', join(TR('projects'), oldId) + '.origin.json');
    const l2 = await T.listTrash();
    eq('the listing is newest first (the 2020 entry is last)', l2.entries[l2.entries.length - 1].id, oldId);
    eP.id = oldId;
  }

  // ── Round trips, byte-identical ────────────────────────────────────────
  {
    const r = await T.restoreFromTrash('scopes', eS.id);
    ok('restore a handoff → ok, back at its place', r.ok === true && r.restoredTo === 'domains/alpha/state/main/' && r.renamed === false, JSON.stringify(r));
    eq('...BYTE-IDENTICAL to what was deleted', fingerprint(join(DOMAINS, 'alpha', 'state', 'main')), scopeFp);
    ok('...the trash entry and its record are gone', !existsSync(join(TR('scopes'), eS.id)) && !existsSync(join(TR('scopes'), eS.id) + '.origin.json'));
    const back = await store.readWorkingState('alpha', { scope: 'main' });
    ok('...and the store reads it again', back && back.ok !== false && JSON.stringify(back).includes('Main on '), JSON.stringify(back).slice(0, 200));
  }
  {
    const r = await T.restoreFromTrash('projects', eP.id);
    ok('restore a project → ok', r.ok === true && r.project === 'proj', JSON.stringify(r));
    eq('...BYTE-IDENTICAL', fingerprint(join(DOMAINS, 'alpha', 'state', 'proj')), projFp);
    const lp = await store.listProjects('alpha');
    ok('...and the project list shows it again', (lp.projects || []).some((p) => p.project === 'proj'), JSON.stringify(lp).slice(0, 200));
  }
  {
    const r = await T.restoreFromTrash('domains', eD.id);
    ok('restore a domain → ok', r.ok === true && r.domain === 'beta', JSON.stringify(r));
    eq('...BYTE-IDENTICAL', fingerprint(join(DOMAINS, 'beta')), betaFp);
    ok('...and listDomains sees it again', (await files.listDomains()).includes('beta'));
    eq('...the trash is empty again', (await T.listTrash()).entries.length, 0);
  }

  // ── Collision refused, nothing touched; restore-as works ───────────────
  {
    await store.deleteWorkStream('alpha', 'alpha', 'keep', { confirm: 'keep' });
    const deletedFp = fingerprint(join(TR('scopes'), trashIds('scopes')[0]));
    await save('alpha', { scope: 'keep', headline: 'A NEW keep, saved after the delete' });
    const liveFp = fingerprint(join(DOMAINS, 'alpha', 'state', 'keep'));
    const e = await find((x) => x.kind === 'scopes' && x.name === 'keep');
    ok('the listing says the name is taken, and suggests keep-restored', e.status === 'exists' && e.suggestedName === 'keep-restored'
      && /exists there now/.test(e.message), JSON.stringify(e));
    const r = await T.restoreFromTrash('scopes', e.id);
    ok('a plain restore onto a taken name is REFUSED (exists) with the suggestion', r.ok === false && r.reason === 'exists' && r.suggestedName === 'keep-restored', JSON.stringify(r));
    eq('...the live handoff is byte-identical (never overwritten, never merged)', fingerprint(join(DOMAINS, 'alpha', 'state', 'keep')), liveFp);
    eq('...the trash entry is byte-identical', fingerprint(join(TR('scopes'), e.id)), deletedFp);
    const r2 = await T.restoreFromTrash('scopes', e.id, { as: 'keep-restored' });
    ok('restore AS keep-restored → ok, renamed', r2.ok === true && r2.renamed === true && r2.restoredTo === 'domains/alpha/state/keep-restored/', JSON.stringify(r2));
    eq('...the restored copy is byte-identical to the deleted one', fingerprint(join(DOMAINS, 'alpha', 'state', 'keep-restored')), deletedFp);
    eq('...and the live one still untouched', fingerprint(join(DOMAINS, 'alpha', 'state', 'keep')), liveFp);
    // An EMPTY folder of that name: rename(2) would silently replace it, so
    // only the explicit exists-check stands between a restore and it.
    await store.deleteWorkStream('alpha', 'alpha', 'keep-restored', { confirm: 'keep-restored' });
    const eEmpty = await find((x) => x.kind === 'scopes' && x.name === 'keep-restored');
    mkdirSync(join(DOMAINS, 'alpha', 'state', 'keep-restored'));
    const rEmpty = await T.restoreFromTrash('scopes', eEmpty.id);
    ok('an EMPTY folder at the destination is still refused (exists) — never replaced', rEmpty.ok === false && rEmpty.reason === 'exists'
      && readdirSync(join(DOMAINS, 'alpha', 'state', 'keep-restored')).length === 0 && existsSync(join(TR('scopes'), eEmpty.id)), JSON.stringify(rEmpty));
    rmSync(join(DOMAINS, 'alpha', 'state', 'keep-restored'), { recursive: true });
    ok('...and restores once the folder is gone', (await T.restoreFromTrash('scopes', eEmpty.id)).ok === true);
    const bad = await T.restoreFromTrash('scopes', 'nope', { as: '../escape' });
    eq('an unlisted id is not-found before any name is looked at', bad.reason, 'not-found');
  }
  {
    // A domain restored under a new name: conversations and headers follow.
    await files.deleteDomain('beta', { confirm: 'beta' });
    makeDomain('beta');
    const e = await find((x) => x.kind === 'domains');
    ok('a domain whose name is taken now: exists, suggest beta-restored', e.status === 'exists' && e.suggestedName === 'beta-restored', JSON.stringify(e));
    const refused = await T.restoreFromTrash('domains', e.id, { as: 'shared-beta' });
    ok('restore-as into the shared- namespace is refused (reserved)', refused.ok === false && refused.reason === 'invalid-name', JSON.stringify(refused));
    const trav = await T.restoreFromTrash('domains', e.id, { as: '../outside' });
    ok('restore-as with a path in the name is refused', trav.ok === false && trav.reason === 'invalid-name' && !existsSync(join(TMP, 'outside')), JSON.stringify(trav));
    mkdirSync(join(DOMAINS, 'beta-restored'));
    const rEmptyDom = await T.restoreFromTrash('domains', e.id, { as: 'beta-restored' });
    ok('a domain restore onto an EMPTY folder of that name is refused (exists)', rEmptyDom.ok === false && rEmptyDom.reason === 'exists'
      && readdirSync(join(DOMAINS, 'beta-restored')).length === 0, JSON.stringify(rEmptyDom));
    rmSync(join(DOMAINS, 'beta-restored'), { recursive: true });
    const r = await T.restoreFromTrash('domains', e.id, { as: 'beta-restored' });
    ok('restore AS beta-restored → ok', r.ok === true && r.domain === 'beta-restored', JSON.stringify(r));
    const conv = JSON.parse(readFileSync(join(DOMAINS, 'beta-restored', 'conversations', 'c1.json'), 'utf8'));
    eq('...its conversation now names its new folder', conv.domain, 'beta-restored');
    ok('...its display name says (restored)', readFileSync(join(DOMAINS, 'beta-restored', 'CLAUDE.md'), 'utf8').includes('# Domain: beta Display (restored)'));
    ok('...both domains are listed', ['beta', 'beta-restored'].every((d) => files.listDomains && true) &&
      (await files.listDomains()).includes('beta-restored') && (await files.listDomains()).includes('beta'));
  }

  // ── Missing parent ─────────────────────────────────────────────────────
  {
    makeDomain('gamma');
    const g = await store.createProject('gamma', 'gp');
    if (!g || g.ok !== true) throw new Error('fixture');
    await save('gamma', { project: 'gp', scope: 'gs', headline: 'Gamma stream' });
    await store.deleteWorkStream('gamma', 'gp', 'gs', { confirm: 'gs' });
    await store.deleteProject('gamma', 'gp', { confirm: 'gp' });
    const eScope = await find((x) => x.kind === 'scopes' && x.domain === 'gamma');
    ok('a handoff whose PROJECT is gone lists as no-parent, naming the project',
      eScope.status === 'no-parent' && /project "gp"/.test(eScope.message), JSON.stringify(eScope));
    const r = await T.restoreFromTrash('scopes', eScope.id);
    ok('...and its restore is refused (no-parent), nothing created', r.ok === false && r.reason === 'no-parent'
      && !existsSync(join(DOMAINS, 'gamma', 'state', 'gp')), JSON.stringify(r));
    await files.deleteDomain('gamma', { confirm: 'gamma' });
    const eProj = await find((x) => x.kind === 'projects' && x.domain === 'gamma');
    ok('a project whose DOMAIN is gone lists as no-parent, saying restore the domain first',
      eProj.status === 'no-parent' && /Restore the domain first/.test(eProj.message), JSON.stringify(eProj));
    const r2 = await T.restoreFromTrash('projects', eProj.id);
    ok('...refused, and no domain folder is conjured', r2.ok === false && r2.reason === 'no-parent' && !existsSync(join(DOMAINS, 'gamma')), JSON.stringify(r2));
    // Order matters and works: domain, then project, then handoff.
    const eDom = await find((x) => x.kind === 'domains' && x.name === 'gamma');
    ok('restoring in order — domain, project, handoff — succeeds',
      (await T.restoreFromTrash('domains', eDom.id)).ok && (await T.restoreFromTrash('projects', eProj.id)).ok
      && (await T.restoreFromTrash('scopes', eScope.id)).ok && existsSync(join(DOMAINS, 'gamma', 'state', 'gp', 'gs')));
  }

  // ── Mirror and lock ────────────────────────────────────────────────────
  {
    makeDomain('delta');
    await save('delta', { scope: 'ds', headline: 'Delta stream' });
    await store.deleteWorkStream('delta', 'delta', 'ds', { confirm: 'ds' });
    const e = await find((x) => x.kind === 'scopes' && x.domain === 'delta');
    const release = await acquireFileLock(join(DOMAINS, 'delta'), { op: 'test-holder' });
    const r = await T.restoreFromTrash('scopes', e.id);
    ok('the domain’s file lock held elsewhere → locked, nothing restored', r.ok === false && r.reason === 'locked'
      && !existsSync(join(DOMAINS, 'delta', 'state', 'ds')) && existsSync(join(TR('scopes'), e.id)), JSON.stringify(r));
    await release();
    // Turn delta into a read-only mirror.
    writeFileSync(join(DOMAINS, 'delta', 'CLAUDE.md'), '---\nreadonly: true\n---\n# Domain: delta\n');
    const m = await T.restoreFromTrash('scopes', e.id);
    ok('a read-only mirror is refused (readonly)', m.ok === false && m.reason === 'readonly', JSON.stringify(m));
    writeFileSync(join(DOMAINS, 'delta', 'CLAUDE.md'), '# Domain: delta\n');
    ok('...and with the lock released and the mirror flag gone it restores', (await T.restoreFromTrash('scopes', e.id)).ok === true);
  }

  // ── Traversal ──────────────────────────────────────────────────────────
  {
    await store.deleteWorkStream('delta', 'delta', 'ds', { confirm: 'ds' });
    const e = await find((x) => x.kind === 'scopes' && x.domain === 'delta');
    // A symlink planted in the trash pointing OUTSIDE it, named like an entry.
    const outside = join(TMP, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'do not move me');
    const linkId = 'delta--delta--evil--2026-01-01T00-00-00Z';
    symlinkSync(outside, join(TR('scopes'), linkId));
    for (const [kind, id] of [
      ['scopes', '../scopes/' + e.id], ['scopes', '..'], ['scopes', e.id + '/..'], ['scopes', '/etc'],
      ['scopes', linkId], ['../domains', e.id], ['nope', e.id], ['scopes', ''], ['scopes', null],
    ]) {
      const r = await T.restoreFromTrash(kind, id);
      ok(`restore (${JSON.stringify(kind)}, ${JSON.stringify(id)}) is refused before any path is built`,
        r.ok === false && (r.reason === 'not-found' || r.reason === 'invalid-kind'), JSON.stringify(r));
      const d = await T.emptyTrashItem(kind, id, { confirm: String(id) });
      ok('...and so is its permanent delete', d.ok === false && (d.reason === 'not-found' || d.reason === 'invalid-kind'), JSON.stringify(d));
    }
    ok('the symlink target outside the trash is untouched', readFileSync(join(outside, 'secret.txt'), 'utf8') === 'do not move me');
    ok('a planted symlink is never LISTED as an entry', !(await T.listTrash()).entries.some((x) => x.id === linkId));
    rmSync(join(TR('scopes'), linkId));
  }

  // ── Delete forever: exact typed confirm ────────────────────────────────
  {
    const e = await find((x) => x.kind === 'scopes' && x.domain === 'delta');
    const fp = fingerprint(join(TR('scopes'), e.id));
    for (const c of [undefined, '', 'DS', ' ds', 'ds ', e.id, 'd']) {
      const r = await T.emptyTrashItem('scopes', e.id, { confirm: c });
      ok(`delete-forever with confirm ${JSON.stringify(c)} is refused (confirm-required)`, r.ok === false && r.reason === 'confirm-required' && r.expected === 'ds', JSON.stringify(r));
    }
    eq('...the entry is byte-identical after every refusal', fingerprint(join(TR('scopes'), e.id)), fp);
    const r = await T.emptyTrashItem('scopes', e.id, { confirm: 'ds' });
    ok('the exact name deletes it forever, reporting files and bytes', r.ok === true && r.files >= 1 && r.bytes > 0, JSON.stringify(r));
    ok('...the folder and its origin record are gone', !existsSync(join(TR('scopes'), e.id)) && !existsSync(join(TR('scopes'), e.id) + '.origin.json'));
    ok('...and it is no longer listed', !(await T.listTrash()).entries.some((x) => x.id === e.id));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§L — legacy entries (no origin record), parsed from the name');
  // ═══════════════════════════════════════════════════════════════════════
  {
    // Unambiguous legacy: a named project's handoff deleted before v3.76.0.
    const id = 'alpha--proj--legacy-feat--2026-09-24T10-00-00Z';
    mkdirSync(join(TR('scopes'), id, 'machine-x'), { recursive: true });
    writeFileSync(join(TR('scopes'), id, 'machine-x', 'current.md'), '# legacy\n');
    const e = await find((x) => x.id === id);
    ok('an unrecorded name splits into domain/project/scope', e && e.originFrom === 'name' && e.domain === 'alpha'
      && e.project === 'proj' && e.scope === 'legacy-feat' && e.status === 'ready', JSON.stringify(e));
    const r = await T.restoreFromTrash('scopes', id);
    ok('...and restores into the named project', r.ok === true && existsSync(join(DOMAINS, 'alpha', 'state', 'proj', 'legacy-feat', 'machine-x', 'current.md')), JSON.stringify(r));

    // Ambiguous: "a--b--c--d" could be (a, b, c--d) or (a--b, c, d); neither domain exists.
    const amb = 'zz--yy--xx--ww--2026-09-24T10-00-00Z';
    mkdirSync(join(TR('scopes'), amb, 'm'), { recursive: true });
    const ea = await find((x) => x.id === amb);
    ok('an ambiguous unrecorded name is UNKNOWN ORIGIN, listed but not restorable', ea && ea.status === 'unknown-origin'
      && ea.name === null && /cannot be read/.test(ea.message), JSON.stringify(ea));
    const ra = await T.restoreFromTrash('scopes', amb);
    eq('...its restore is refused, never guessed', ra.reason, 'unknown-origin');
    // A live domain settles it.
    makeDomain('zz--yy');
    const settled = await find((x) => x.id === amb);
    ok('...until exactly one reading names a live domain', settled.status !== 'unknown-origin' && settled.domain === 'zz--yy'
      && settled.project === 'xx' && settled.scope === 'ww', JSON.stringify(settled));
    // Unknown origin: the permanent delete asks for the whole folder name.
    rmSync(join(DOMAINS, 'zz--yy'), { recursive: true, force: true });
    const d1 = await T.emptyTrashItem('scopes', amb, { confirm: 'ww' });
    eq('an unknown-origin entry’s delete-forever asks for its FULL folder name', d1.expected, amb);
    ok('...and takes it', (await T.emptyTrashItem('scopes', amb, { confirm: amb })).ok === true);

    // A record that DISAGREES with the name is not believed.
    const lie = 'alpha--liar--2026-09-24T10-00-00Z';
    mkdirSync(join(TR('projects'), lie), { recursive: true });
    writeFileSync(join(TR('projects'), lie) + '.origin.json', JSON.stringify({ domain: 'beta', project: 'other' }));
    const el = await find((x) => x.id === lie);
    ok('an origin record that disagrees with the folder name is ignored (the name wins)', el.domain === 'alpha' && el.project === 'liar' && el.originFrom === 'name', JSON.stringify(el));
    await T.emptyTrashItem('projects', lie, { confirm: 'liar' });

    // Pure: originCandidates.
    eq('originCandidates: a project name never holds "--" so a domain may', JSON.stringify(T.originCandidates('projects', 'a--b--c')),
      JSON.stringify([{ domain: 'a', project: 'b--c' }, { domain: 'a--b', project: 'c' }]));
    eq('splitStamp reads the -N suffix of a same-second second delete', T.splitStamp('x--2026-09-25T14-03-22Z-2').prefix, 'x');
    eq('splitStamp refuses a name with no stamp', T.splitStamp('plain-folder'), null);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§R — the REAL router over HTTP');
  // ═══════════════════════════════════════════════════════════════════════
  {
    await save('alpha', { scope: 'routed', headline: 'Routed' });
    await store.deleteWorkStream('alpha', 'alpha', 'routed', { confirm: 'routed' });
    const g = await call('GET', '/api/trash');
    ok('GET /api/trash → 200 with entries, trashDir and syncConfigured', g.status === 200 && Array.isArray(g.body.entries)
      && typeof g.body.trashDir === 'string' && typeof g.body.syncConfigured === 'boolean', JSON.stringify(g.body).slice(0, 200));
    const e = g.body.entries.find((x) => x.name === 'routed');
    const bad = await call('POST', '/api/trash/nope/' + encodeURIComponent(e.id) + '/restore', {});
    eq('an unknown kind → 400', bad.status, 400);
    const trav = await call('POST', '/api/trash/scopes/' + encodeURIComponent('../domains') + '/restore', {});
    eq('a traversal id → 404', trav.status, 404);
    const release = registerWrite('alpha', 'ingest');
    const busy = await call('POST', '/api/trash/scopes/' + encodeURIComponent(e.id) + '/restore', {});
    release();
    ok('a write in flight on its domain → 409 write_in_progress, nothing restored', busy.status === 409 && busy.body.conflict === 'write_in_progress'
      && !existsSync(join(DOMAINS, 'alpha', 'state', 'routed')), JSON.stringify(busy.body));
    const r = await call('POST', '/api/trash/scopes/' + encodeURIComponent(e.id) + '/restore', {});
    ok('restore → 200 restored, restoredTo named', r.status === 200 && r.body.restored === true && r.body.restoredTo === 'domains/alpha/state/routed/', JSON.stringify(r.body));
    await store.deleteWorkStream('alpha', 'alpha', 'routed', { confirm: 'routed' });
    await save('alpha', { scope: 'routed', headline: 'Routed again' });
    const e2 = (await call('GET', '/api/trash')).body.entries.find((x) => x.name === 'routed');
    const clash = await call('POST', '/api/trash/scopes/' + encodeURIComponent(e2.id) + '/restore', {});
    ok('a taken name → 409 exists with suggestedName', clash.status === 409 && clash.body.reason === 'exists' && clash.body.suggestedName === 'routed-restored', JSON.stringify(clash.body));
    const asNew = await call('POST', '/api/trash/scopes/' + encodeURIComponent(e2.id) + '/restore', { as: 'routed-restored' });
    ok('...and { as } restores it beside', asNew.status === 200 && asNew.body.renamed === true, JSON.stringify(asNew.body));

    await store.deleteWorkStream('alpha', 'alpha', 'routed', { confirm: 'routed' });
    const e3 = (await call('GET', '/api/trash')).body.entries.find((x) => x.name === 'routed');
    const noConfirm = await call('DELETE', '/api/trash/scopes/' + encodeURIComponent(e3.id), {});
    ok('DELETE with no confirm → 400 confirm_required', noConfirm.status === 400 && noConfirm.body.reason === 'confirm_required', JSON.stringify(noConfirm.body));
    const wrong = await call('DELETE', '/api/trash/scopes/' + encodeURIComponent(e3.id), { confirm: 'Routed' });
    ok('DELETE with the wrong word → 400, naming the expected word', wrong.status === 400 && wrong.body.expected === 'routed', JSON.stringify(wrong.body));
    ok('...and the entry is still there', existsSync(join(TR('scopes'), e3.id)));
    const del = await call('DELETE', '/api/trash/scopes/' + encodeURIComponent(e3.id), { confirm: 'routed' });
    ok('DELETE with the exact word → 200 deleted', del.status === 200 && del.body.deleted === true && !existsSync(join(TR('scopes'), e3.id)), JSON.stringify(del.body));
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§X — the REAL server: registered, and a foreign Origin is 403');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const freePort = await new Promise((resolve) => {
      const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const child = spawn(process.execPath, [join(ROOT, 'src/server.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(freePort), CURATOR_NO_OPEN: '1', CURATOR_TEST_USER_DATA_DIR: USER_DATA,
        CURATOR_TEST_DOMAINS_DIR: DOMAINS, CURATOR_TEST_LOG_DIR: join(USER_DATA, 'logs'),
        CURATOR_TEST_MCP_LAUNCHER_DIR: join(USER_DATA, 'bin') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    try {
      const deadline = Date.now() + 60000;
      let up = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const r = await fetch(`http://127.0.0.1:${freePort}/api/trash`);
          // JSON with an entries array, never just a 200: an unregistered
          // /api path falls through to the SPA catch-all, which answers 200 HTML.
          if (r.status) { let j = null; try { j = await r.json(); } catch { /* HTML */ } up = r.status === 200 && !!j && Array.isArray(j.entries); break; }
        } catch { /* not yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      ok('GET /api/trash answers 200 on the real server (the router is registered)', up, out.split('\n').slice(0, 6).join(' | '));
      await save('alpha', { scope: 'xo', headline: 'Cross origin' });
      await store.deleteWorkStream('alpha', 'alpha', 'xo', { confirm: 'xo' });
      const e = (await T.listTrash()).entries.find((x) => x.name === 'xo');
      const url = `http://127.0.0.1:${freePort}/api/trash/scopes/${encodeURIComponent(e.id)}`;
      const evil = await fetch(url + '/restore', { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
      eq('a foreign-Origin restore is refused 403', evil.status, 403);
      const evilDel = await fetch(url, { method: 'DELETE', headers: { 'content-type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ confirm: 'xo' }) });
      eq('a foreign-Origin delete-forever is refused 403', evilDel.status, 403);
      ok('...and the entry is untouched', existsSync(join(TR('scopes'), e.id)));
      const same = await fetch(url, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'XO' }) });
      let sameBody = null; try { sameBody = await same.json(); } catch { /* HTML */ }
      ok('...while the same request with no Origin reaches the ROUTE (400 confirm_required, as JSON)',
        same.status === 400 && sameBody && sameBody.reason === 'confirm_required', String(same.status));
    } finally {
      child.kill('SIGTERM');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§V — the view’s builders (views/trash-list.js)');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const now = Date.parse('2026-09-25T18:00:00Z');
    const empty = V.trashSectionHtml({ data: { entries: [], trashDir: '/u/.curator-trash', syncConfigured: false } }, { nowMs: now });
    ok('empty: "Nothing in the trash."', empty.includes('Nothing in the trash.'));
    ok('...and it says the trash is never synced', /never synced/.test(empty));
    ok('...without claiming a Sync when none is configured', !/next Sync/.test(empty));
    const loading = V.trashSectionHtml({ data: null }, { loadingHtml: '<i>LOADING</i>' });
    eq('not loaded: the loader, no list', loading, '<i>LOADING</i>');
    ok('a failed read says so', V.trashSectionHtml({ data: null, error: 'boom' }).includes('Could not read the trash: boom'));

    const ready = {
      kind: 'projects', id: 'alpha--proj--2026-09-25T16-00-00Z', name: 'proj', domain: 'alpha', project: 'proj',
      deletedAt: '2026-09-25T16:00:00.000Z', restoreTo: 'domains/alpha/state/proj/', status: 'ready',
      bytes: 2048, files: 3, contains: { hasBrief: true, scopes: 2, handoffs: 2 },
    };
    const exists = { ...ready, id: 'x--2026-09-25T15-00-00Z', kind: 'scopes', name: 'main', project: 'alpha', scope: 'main',
      isDefaultProject: true, status: 'exists', suggestedName: 'main-restored', message: 'A handoff named "main" exists there now.',
      contains: { machines: 2, handoffs: 2 } };
    const orphan = { ...ready, id: 'y--2026-09-25T14-00-00Z', status: 'no-parent', message: 'The domain "alpha" no longer exists. Restore the domain first, then this project.' };
    const evil = { ...ready, id: 'z--2026-09-25T13-00-00Z', name: '<img src=x onerror=1>', kind: 'domains', displayName: '<b>x</b>' };
    const data = { entries: [ready, exists, orphan, evil], trashDir: '/u/.curator-trash', syncConfigured: true };
    const html = V.trashSectionHtml({ data }, { nowMs: now, trashIconHtml: '<svg class="ic"></svg>' });
    eq('one row per entry', (html.match(/class="trash-row"/g) || []).length, 4);
    ok('a ready row: kind, name, owner, age + UTC, where, what it held', html.includes('<span class="trash-kind">project</span>')
      && html.includes('deleted 2 hr ago (2026-09-25 16:00 UTC) · from domains/alpha/state/proj/')
      && html.includes('standing brief · 2 handoffs · 2 KB in 3 files'), html.slice(0, 900));
    ok('...with a Restore button and the ONE neutral trash row-action, labelled', /data-trash-restore>Restore<\/button>/.test(html)
      && html.includes('class="row-act trash-forever" data-trash-delete aria-label="Delete proj forever"'));
    ok('a taken name: the button says "Restore as main-restored" and the reason is unfolded',
      html.includes('Restore as main-restored') && html.includes('role="note">A handoff named &quot;main&quot; exists there now.'));
    const orphanRow = html.split('<li').find((s) => s.includes('y--2026'));
    ok('no parent: NO Restore button, the reason in words', !orphanRow.includes('data-trash-restore') && orphanRow.includes('Restore the domain first'));
    ok('every name is escaped', !html.includes('<img src=x') && html.includes('&lt;img src=x onerror=1&gt;') && !html.includes('<b>x</b>'));
    ok('with Sync configured it says the next Sync carries a restore', /next Sync carries it/.test(html));
    ok('no red on the row itself (red belongs to the confirm card only)', !/btn-danger/.test(html));
    ok('the busy write gate disables Restore and says why', (() => {
      const h = V.trashRowHtml(ready, { nowMs: now, writeBusy: (d) => (d === 'alpha' ? 'Ingest' : null) });
      return /data-trash-restore disabled/.test(h) && h.includes('Ingest is running on alpha');
    })());

    // The delete-forever card and its ONE predicate.
    const act = (t) => ({ kind: ready.kind, id: ready.id, mode: 'delete', confirmText: t, busy: false, error: null });
    for (const t of ['', 'Proj', ' proj', 'proj ', 'pro']) {
      ok(`confirm ${JSON.stringify(t)} does not match`, !V.trashDeleteConfirmMatches(act(t), ready));
      ok('...and the card’s button is disabled', /id="trash-del-go" disabled/.test(V.trashRowHtml(ready, { nowMs: now, action: act(t) })));
    }
    ok('the exact name matches and enables the button', V.trashDeleteConfirmMatches(act('proj'), ready)
      && /id="trash-del-go">Delete forever/.test(V.trashRowHtml(ready, { nowMs: now, action: act('proj') })));
    const card = V.trashRowHtml(ready, { nowMs: now, action: act('') });
    ok('the card says it cannot be undone, and the size', /cannot be undone/.test(card) && card.includes('3 files, 2 KB') && card.includes('btn-danger-solid'));
    eq('the DELETE body sends the typed text', V.trashDeleteBody(act('proj')), '{"confirm":"proj"}');
    eq('an unknown-origin entry’s confirm word is its folder name', V.trashConfirmWord({ id: 'q--2026', name: null }), 'q--2026');
    eq('restore plan (ready) sends no as', V.trashRestoreBody(V.trashRestorePlan(ready)), '{}');
    eq('restore plan (taken) sends the suggested name, explicitly', V.trashRestoreBody(V.trashRestorePlan(exists)), '{"as":"main-restored"}');
    eq('restore plan (no parent) is none', V.trashRestorePlan(orphan), null);
    ok('a refused restore shows the reason on its row', V.trashRowHtml(ready, { nowMs: now, action: { kind: ready.kind, id: ready.id, mode: 'restore', error: 'nope' } }).includes('Not restored.</strong> nope'));

    eq('restore outcome, from the server’s answer', V.trashRestoreOutcomeText({ kind: 'scopes', name: 'main-restored', restoredTo: 'domains/alpha/state/main-restored/', renamed: true, syncConfigured: true }),
      'Restored handoff “main-restored” to domains/alpha/state/main-restored/. Its old name was taken, so it came back under this new one. It is back in Context. Your next Sync carries it to GitHub.');
    eq('delete-forever outcome', V.trashDeleteOutcomeText({ name: 'proj', files: 3, bytes: 2048 }), 'Deleted “proj” forever — 3 files, 2 KB.');
    ok('an outcome sits above the list with a dismiss', V.trashSectionHtml({ data, outcome: { text: 'Restored X.' } }, { nowMs: now }).startsWith('<div class="trash-outcome" role="status">Restored X.'));
  }
} catch (err) {
  failed++;
  console.log('  ✗ CRASH: ' + (err && err.stack || err));
} finally {
  server.close();
  cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
