#!/usr/bin/env node
/**
 * test-work-stream-delete.js — OFFLINE suite. No network, no API key, no LLM.
 *
 * Guards "Delete handoff" (v3.75.0): the owner's removal of ONE work-stream —
 * `state/[<project>/]<scope>/`, every machine's saved copy in it — from the
 * Context view's Handoffs table, moved to The Curator's trash.
 *
 * THREE ARMS, all driving real code:
 *   §S  the REAL store (`deleteWorkStream`, `previewWorkStreamDelete`) over a
 *       real state tree built by the real `saveWorkingState`;
 *   §R  the REAL router's two handlers, pulled off the Express router and
 *       called with fake req/res, over the same real store;
 *   §V  the view: the DOM-free builders in views/ws-delete.js imported for
 *       real, and memory.js's row, binder and two async functions LIFTED by
 *       brace-matching and executed against a recording fetch.
 *   §M  the MCP has no tool that reaches it (agents must not delete scopes).
 *
 * ISOLATION: `CURATOR_TEST_USER_DATA_DIR` (the trash, and this install's
 * machine id) and `__setDomainsDirOverride` (the domains tree) both point
 * into one tempdir BEFORE any app module is imported. Nothing here can reach
 * the user's own data.
 *
 * NOT ENFORCED: the race with a lockless tier-2 save that lands in the same
 * instant as the move — its detection (`recreated`) is exercised only through
 * the outcome sentence, because provoking the interleaving needs a second
 * process timed to a syscall. Layout and contrast are a browser question.
 */
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
const TMP = mkdtempSync(join(tmpdir(), 'curator-wsdel-'));
const DOMAINS = join(TMP, 'domains');
const USER_DATA = join(TMP, 'userdata');
mkdirSync(DOMAINS, { recursive: true });
mkdirSync(USER_DATA, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
function cleanup() {
  try {
    const rel = relative(tmpdir(), TMP);
    if (rel && !rel.startsWith('..') && !rel.includes('/')) rmSync(TMP, { recursive: true, force: true });
  } catch { /* best effort */ }
}

const { __setDomainsDirOverride } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const store = await import('../src/brain/working-state.js');
const { getTrashDir } = await import('../src/brain/paths.js');
const { acquireFileLock, registerWrite } = await import('../src/brain/write-registry.js');
const routerMod = await import('../src/routes/memory.js');
const router = routerMod.default;

function makeDomain(slug, extraCLAUDE) {
  mkdirSync(join(DOMAINS, slug, 'wiki', 'entities'), { recursive: true });
  writeFileSync(join(DOMAINS, slug, 'CLAUDE.md'), (extraCLAUDE || '') + '# ' + slug + '\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'index.md'), '# Index\n');
  writeFileSync(join(DOMAINS, slug, 'wiki', 'log.md'), '# Log\n');
}

/** path -> sha256 for every file under `dir`, as one comparable string. */
function fingerprint(dir) {
  if (!existsSync(dir)) return 'ABSENT';
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(relative(dir, p) + ' ' + createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  })(dir);
  return files.join('\n');
}
function fileCount(fp) { return fp === 'ABSENT' || fp === '' ? 0 : fp.split('\n').length; }

async function save(domain, input) {
  const r = await store.saveWorkingState(domain, { nowState: 'Now: ' + input.headline, ...input });
  if (!r || r.ok !== true) throw new Error('fixture save refused: ' + JSON.stringify(r));
  return r;
}

const ME = store.machineId();

/** A fresh domain with a default-project scope on three machines (one of them
 *  THIS install), a second scope, a brief and a named project. */
async function seed(domain) {
  makeDomain(domain);
  await store.saveProjectBriefText(domain, domain, '# Brief\n\nStanding brief for ' + domain + '.\n');
  // `main` on this machine — saved twice by DIFFERENT tools, so a previous.md
  // is kept beside current.md.
  await save(domain, { scope: 'main', headline: 'First on this machine', harness: 'Claude Code', model: 'opus' });
  await save(domain, { scope: 'main', headline: 'Second on this machine', harness: 'Codex', model: 'gpt' });
  await save(domain, { scope: 'main', machine: 'laptop-b', headline: 'Laptop copy', harness: 'Cursor' });
  await save(domain, { scope: 'main', machine: 'studio-c', headline: 'Studio <b>copy</b>', harness: 'Claude Code' });
  await save(domain, { scope: 'other', machine: 'laptop-b', headline: 'Other stream' });
  const cp = await store.createProject(domain, 'proj');
  if (!cp || cp.ok !== true) throw new Error('fixture createProject refused: ' + JSON.stringify(cp));
  await save(domain, { project: 'proj', scope: 'feature', machine: 'laptop-b', headline: 'Named project stream' });
}

const STATE = (d) => join(DOMAINS, d, 'state');
const TRASH_SCOPES = () => join(getTrashDir(), 'scopes');

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('§0 — isolation');
  // ═══════════════════════════════════════════════════════════════════════
  ok('the trash resolves inside the test tempdir', getTrashDir().startsWith(USER_DATA), getTrashDir());
  ok('the domains dir is the tempdir one', DOMAINS.startsWith(TMP));

  // ═══════════════════════════════════════════════════════════════════════
  section('§S — the store');
  // ═══════════════════════════════════════════════════════════════════════
  await seed('alpha');
  const mainDir = join(STATE('alpha'), 'main');
  const mainFp = fingerprint(mainDir);
  ok('SETUP: main holds three machine folders', readdirSync(mainDir).sort().join(',')
    === [ME, 'laptop-b', 'studio-c'].sort().join(','), readdirSync(mainDir).join(','));
  ok('SETUP: this machine kept a previous.md (a different tool replaced its handoff)',
    existsSync(join(mainDir, ME, 'previous.md')));
  const stateBefore = fingerprint(STATE('alpha'));

  // ── preview ──
  {
    const pv = await store.previewWorkStreamDelete('alpha', 'alpha', 'main');
    ok('preview answers ok', pv && pv.ok === true, JSON.stringify(pv));
    eq('preview lists EVERY machine copy', pv.machines.length, 3);
    eq('...and says the total', pv.total, 3);
    const mine = pv.machines.find((m) => m.machine === ME);
    ok('...this machine is marked isThisMachine', mine && mine.isThisMachine === true);
    ok('...and the two others are not', pv.machines.filter((m) => !m.isThisMachine).length === 2);
    eq('...otherMachines counts them', pv.otherMachines, 2);
    eq('this machine\'s newest headline is the SECOND save', mine && mine.headline, 'Second on this machine');
    ok('...with the agent time it was written', mine && typeof mine.writtenAt === 'string' && !Number.isNaN(Date.parse(mine.writtenAt)));
    eq('...the harness label, normalised from what the agent typed', mine && mine.harnessLabel, 'OpenAI Codex CLI');
    ok('...its size in bytes', mine && Number.isInteger(mine.bytes) && mine.bytes > 0);
    eq('...and that a previous.md exists beside it', mine && mine.hasPrevious, true);
    eq('a machine with a single save has no previous.md', pv.machines.find((m) => m.machine === 'laptop-b').hasPrevious, false);
    eq('restoreTo names the folder to move it back into', pv.restoreTo, 'state/');
    eq('the preview wrote nothing', fingerprint(STATE('alpha')), stateBefore);
  }

  // ── refusals, each leaving the tree intact ──
  for (const [label, confirm] of [
    ['no confirm', undefined], ['empty confirm', ''], ['a case-folded confirm', 'Main'],
    ['a padded confirm', 'main '], ['a boolean confirm', true], ['another scope\'s name', 'other'],
  ]) {
    const r = await store.deleteWorkStream('alpha', 'alpha', 'main', confirm === undefined ? {} : { confirm });
    eq(label + ' → confirm-required', r && r.reason, 'confirm-required');
    eq('...and the state tree is byte-identical', fingerprint(STATE('alpha')), stateBefore);
  }
  for (const [label, scope, reason] of [
    ['a traversal', '../proj', 'invalid-scope'], ['dot-dot', '..', 'invalid-scope'],
    ['a nested path', 'main/' + ME, 'invalid-scope'], ['an unknown scope', 'nope', 'unknown-scope'],
    ['the documents folder', 'foundations', 'not-a-scope'],
    ['a NAMED PROJECT\'s folder on the domain\'s own project', 'proj', 'not-a-scope'],
    ['`latest` when no scope is literally called latest', 'latest', 'unknown-scope'],
  ]) {
    const r = await store.deleteWorkStream('alpha', 'alpha', scope, { confirm: scope });
    eq(label + ' → ' + reason + ' (even with the name typed)', r && r.reason, reason);
    eq('...and the state tree is byte-identical', fingerprint(STATE('alpha')), stateBefore);
  }
  {
    const r = await store.deleteWorkStream('alpha', 'nosuch', 'main', { confirm: 'main' });
    eq('an unknown project → unknown-state-project', r && r.reason, 'unknown-state-project');
  }

  // ── the lock ──
  {
    const release = await acquireFileLock(join(DOMAINS, 'alpha'), { op: 'test-holder' });
    ok('SETUP: the test holds the domain lock', typeof release === 'function');
    const r = await store.deleteWorkStream('alpha', 'alpha', 'main', { confirm: 'main' });
    eq('with the lock held elsewhere → locked', r && r.reason, 'locked');
    eq('...and the state tree is byte-identical', fingerprint(STATE('alpha')), stateBefore);
    await release();
  }

  // ── the real delete ──
  {
    const otherBefore = fingerprint(join(STATE('alpha'), 'other'));
    const projBefore = fingerprint(join(STATE('alpha'), 'proj'));
    const briefBefore = readFileSync(join(STATE('alpha'), 'project.md'), 'utf8');
    const r = await store.deleteWorkStream('alpha', 'alpha', 'main', { confirm: 'main' });
    ok('the exact name → ok', r && r.ok === true, JSON.stringify(r));
    ok('the scope folder is gone', !existsSync(mainDir));
    ok('trashPath is under <user data>/.curator-trash/scopes/', r.trashPath && r.trashPath.startsWith(TRASH_SCOPES() + '/'), r.trashPath);
    ok('...named <domain>--<project>--<scope>--<UTC stamp>',
      /\/alpha--alpha--main--\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?$/.test(r.trashPath), r.trashPath);
    eq('the trash copy is BYTE-IDENTICAL to the scope, every machine folder, journal and previous.md',
      fingerprint(r.trashPath), mainFp);
    ok('...which really did include all three machines, three journals and the previous.md',
      fileCount(mainFp) >= 7 && /\/previous\.md /.test(mainFp) && (mainFp.match(/journal\.jsonl/g) || []).length === 3, mainFp);
    eq('the result lists the machines that went', [...r.machines].sort().join(','), [ME, 'laptop-b', 'studio-c'].sort().join(','));
    eq('the OTHER scope is untouched', fingerprint(join(STATE('alpha'), 'other')), otherBefore);
    eq('the named project is untouched', fingerprint(join(STATE('alpha'), 'proj')), projBefore);
    eq('the standing brief is untouched', readFileSync(join(STATE('alpha'), 'project.md'), 'utf8'), briefBefore);
    eq('no save landed during it, so nothing was recreated', r.recreated, false);
    const idx = await store.listWorkingScopes('alpha');
    ok('the store\'s own index no longer lists it', !idx.scopes.some((s) => s.scope === 'main'),
      JSON.stringify(idx.scopes.map((s) => s.scope)));
  }

  // ── a named project's scope, and a REAL scope called latest ──
  {
    const r = await store.deleteWorkStream('alpha', 'proj', 'feature', { confirm: 'feature' });
    ok('a named project\'s scope deletes', r && r.ok === true, JSON.stringify(r));
    eq('...restoreTo names state/<project>/', r.restoreTo, 'state/proj/');
    ok('...and the project (its brief) stays', existsSync(join(STATE('alpha'), 'proj', 'project.md')));
    await save('alpha', { scope: 'latest', machine: 'laptop-b', headline: 'Literally latest' });
    await save('alpha', { scope: 'newer', machine: 'laptop-b', headline: 'Newer' });
    const r2 = await store.deleteWorkStream('alpha', 'alpha', 'latest', { confirm: 'latest' });
    ok('a REAL scope named latest is deleted by its own name', r2 && r2.ok === true && r2.scope === 'latest');
    ok('...and the newest scope (the keyword\'s meaning) is untouched', existsSync(join(STATE('alpha'), 'newer')));
  }

  // ── mirror ──
  {
    makeDomain('shared-cohort', '---\nreadonly: true\n---\n\n');
    mkdirSync(join(STATE('shared-cohort'), 'main', 'box'), { recursive: true });
    writeFileSync(join(STATE('shared-cohort'), 'main', 'box', 'current.md'), '# x\n');
    const before = fingerprint(STATE('shared-cohort'));
    const r = await store.deleteWorkStream('shared-cohort', 'shared-cohort', 'main', { confirm: 'main' });
    eq('a read-only Shared Brain mirror is refused', r && r.reason, 'readonly');
    eq('...and nothing moved', fingerprint(STATE('shared-cohort')), before);
    const pv = await store.previewWorkStreamDelete('shared-cohort', 'shared-cohort', 'main');
    eq('its preview is refused the same way', pv && pv.reason, 'readonly');
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§R — the routes');
  // ═══════════════════════════════════════════════════════════════════════
  const ROUTES = (router.stack || []).filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods)
    .map((m) => ({ method: m, path: l.route.path, handle: l.route.stack[l.route.stack.length - 1].handle })));
  const DEL = '/:domain/:project/scopes/:scope';
  const PV = '/:domain/:project/scopes/:scope/delete-preview';
  async function call(method, path, params, body) {
    const route = ROUTES.find((x) => x.method === method && x.path === path);
    if (!route) return { status: 0, body: { error: 'not registered' } };
    let status = 200; let out;
    const res = { status(c) { status = c; return res; }, json(b) { out = b; return res; } };
    await route.handle({ params, query: {}, body }, res, (e) => { throw e || new Error('next()'); });
    return { status, body: out || {} };
  }
  ok('both routes are registered', ROUTES.some((r) => r.method === 'delete' && r.path === DEL)
    && ROUTES.some((r) => r.method === 'get' && r.path === PV));

  await seed('beta');
  const bMain = join(STATE('beta'), 'main');
  const bBefore = fingerprint(STATE('beta'));
  const bMainFp = fingerprint(bMain);
  {
    const p = await call('get', PV, { domain: 'beta', project: 'beta', scope: 'main' });
    eq('preview → 200', p.status, 200);
    eq('...listing every machine copy', (p.body.machines || []).length, 3);
    const keys = ['machine', 'isThisMachine', 'harnessLabel', 'writtenAt', 'headline', 'bytes', 'hasPrevious'];
    ok('...each with machine, isThisMachine, harness label, writtenAt, headline, bytes and hasPrevious',
      (p.body.machines || []).every((m) => keys.every((k) => k in m)), JSON.stringify(p.body.machines));
    ok('...and where it will go: the trash\'s scopes folder', p.body.trashDir === join(getTrashDir(), 'scopes'), p.body.trashDir);
    eq('an unknown scope → 404', (await call('get', PV, { domain: 'beta', project: 'beta', scope: 'nope' })).status, 404);
    eq('an unknown domain → 404', (await call('get', PV, { domain: 'nodomain', project: 'x', scope: 'main' })).status, 404);
    eq('a mirror → 403', (await call('get', PV, { domain: 'shared-cohort', project: 'shared-cohort', scope: 'main' })).status, 403);
    eq('an unusable project name → 400', (await call('get', PV, { domain: 'beta', project: '../x', scope: 'main' })).status, 400);
  }
  for (const [label, body] of [['no body', undefined], ['no confirm', {}], ['a wrong confirm', { confirm: 'Main' }], ['a non-string confirm', { confirm: 1 }]]) {
    const r = await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'main' }, body);
    eq(label + ' → 400', r.status, 400);
    eq('...confirm_required', r.body.reason, 'confirm_required');
    eq('...and the folder is intact', fingerprint(STATE('beta')), bBefore);
  }
  {
    const r = await call('delete', DEL, { domain: 'shared-cohort', project: 'shared-cohort', scope: 'main' }, { confirm: 'main' });
    eq('a mirror → 403', r.status, 403);
    eq('...readonly', r.body.reason, 'readonly');
  }
  {
    const r = await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'nope' }, { confirm: 'nope' });
    eq('an unknown scope with its name typed → 404', r.status, 404);
    eq('...scope_not_found', r.body.reason, 'scope_not_found');
    const r2 = await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'proj' }, { confirm: 'proj' });
    eq('a named project\'s folder on the domain\'s own project → 400 not_a_scope', r2.status + ' ' + r2.body.reason, '400 not_a_scope');
    eq('...and nothing moved', fingerprint(STATE('beta')), bBefore);
  }
  {
    const releaseReg = registerWrite('beta', 'ingest');
    const r = await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'main' }, { confirm: 'main' });
    releaseReg();
    eq('a write in flight on the domain (the registry) → 409', r.status, 409);
    const releaseLock = await acquireFileLock(join(DOMAINS, 'beta'), { op: 'test-holder' });
    const r2 = await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'main' }, { confirm: 'main' });
    await releaseLock();
    eq('the cross-process lock held → 409', r2.status, 409);
    eq('...reason locked', r2.body.reason, 'locked');
    eq('...and the folder is intact', fingerprint(STATE('beta')), bBefore);
  }
  {
    const r = await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'main' }, { confirm: 'main' });
    eq('the exact name → 200', r.status, 200);
    ok('...deleted, with a trashPath', r.body.deleted === true && typeof r.body.trashPath === 'string', JSON.stringify(r.body));
    eq('...byte-identical in the trash', fingerprint(r.body.trashPath), bMainFp);
    eq('...the machines that went', (r.body.machines || []).length, 3);
    ok('...and the scope is gone from state/', !existsSync(bMain));
  }

  // ── THE ROUTE'S OWN GUARDS, proved by a store that records every call ──
  // Each guard below has a second layer in the store, so against the real
  // store a route whose guard was deleted would still answer the same status
  // (the store refuses too). A RECORDING store is the only way to prove the
  // route refuses BEFORE the store is reached.
  {
    const calls = [];
    routerMod.__setWorkingStateStoreForTest({
      isSafeSegment: store.isSafeSegment,
      deleteWorkStream: async (...a) => { calls.push(['delete', ...a]); return { ok: true, scope: a[2], machines: [], trashPath: '/t' }; },
      previewWorkStreamDelete: async (...a) => { calls.push(['preview', ...a]); return { ok: true, machines: [] }; },
    });
    try {
      await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'other' }, {});
      await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'other' }, { confirm: 'Other' });
      eq('ROUTE: a missing or wrong confirm never reaches the store', calls.length, 0);
      await call('delete', DEL, { domain: 'shared-cohort', project: 'shared-cohort', scope: 'main' }, { confirm: 'main' });
      await call('get', PV, { domain: 'shared-cohort', project: 'shared-cohort', scope: 'main' });
      eq('ROUTE: a mirror never reaches the store (delete or preview)', calls.length, 0);
      const rel = registerWrite('beta', 'ingest');
      await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'other' }, { confirm: 'other' });
      rel();
      eq('ROUTE: a write in flight never reaches the store', calls.length, 0);
      await call('delete', DEL, { domain: 'beta', project: 'beta', scope: 'other' }, { confirm: 'other' });
      eq('CONTROL: the exact name DOES reach it, once', calls.length, 1);
      ok('...with the confirmation passed through to the store as well',
        calls[0] && calls[0][4] && calls[0][4].confirm === 'other', JSON.stringify(calls[0]));
    } finally {
      routerMod.__setWorkingStateStoreForTest(null);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§V — the view');
  // ═══════════════════════════════════════════════════════════════════════
  const V = await import('../src/public/next/views/ws-delete.js');
  const NOW = Date.parse('2026-09-25T12:00:00Z');
  const preview = {
    ok: true, scope: 'main', restoreTo: 'state/', trashDir: '/u/.curator-trash/scopes', total: 2, otherMachines: 1,
    machines: [
      { machine: 'mine-1', isThisMachine: true, hasCurrent: true, headline: 'Mine <img src=x onerror=alert(1)>',
        writtenAt: '2026-09-25T11:00:00Z', harnessLabel: 'Claude Code', hasPrevious: true, bytes: 900 },
      { machine: 'laptop-b', isThisMachine: false, hasCurrent: true, headline: 'Theirs',
        writtenAt: '2026-09-23T12:00:00Z', harnessLabel: 'Cursor', hasPrevious: false, bytes: 400 },
    ],
  };
  const del = (over) => ({ domain: 'd', project: 'd', scope: 'main', preview, loading: false, loadError: null,
    confirmText: '', busy: false, error: null, ...over });
  const btnDisabled = (html) => /id="mem-ws-del-go" disabled/.test(html);
  {
    const html = V.wsDeleteCardHtml(del(), NOW);
    ok('the card asks "Delete handoff main?"', /Delete handoff <span class="mem-wsdel-name">main<\/span>\?/.test(html));
    ok('...lists each machine copy with its headline and age', html.includes('laptop-b') && html.includes('Theirs')
      && html.includes('saved 1 hr ago') && html.includes('saved 2 days ago'), html);
    ok('...marks this machine', html.includes('this machine'));
    ok('...escapes a hostile headline', !html.includes('<img') && html.includes('&lt;img'), html);
    ok('...warns about the other computer', html.includes('Sync will remove it on your other computers too'));
    ok('...says where it goes and how to restore it', html.includes('/u/.curator-trash/scopes/')
      && html.includes('move that folder back into <span class="mem-wsdel-path">state/</span>'));
    ok('...and the button is DISABLED with nothing typed', btnDisabled(html));
    ok('the button stays disabled for a near miss', btnDisabled(V.wsDeleteCardHtml(del({ confirmText: 'Main' }), NOW))
      && btnDisabled(V.wsDeleteCardHtml(del({ confirmText: 'main ' }), NOW)));
    ok('...and ENABLES on the exact name', !btnDisabled(V.wsDeleteCardHtml(del({ confirmText: 'main' }), NOW)));
    ok('...but not while the preview is loading', btnDisabled(V.wsDeleteCardHtml(del({ confirmText: 'main', loading: true, preview: null }), NOW)));
    ok('...nor when the preview failed', btnDisabled(V.wsDeleteCardHtml(del({ confirmText: 'main', loadError: 'x', preview: null }), NOW)));
    ok('...nor while the delete is in flight', btnDisabled(V.wsDeleteCardHtml(del({ confirmText: 'main', busy: true }), NOW)));
    const solo = V.wsDeleteCardHtml(del({ preview: { ...preview, otherMachines: 0, machines: [preview.machines[0]], total: 1 } }), NOW);
    ok('NO other-computers warning when every copy is this machine\'s', !solo.includes('other computers'), solo);
    ok('the red belongs to the confirm button only (btn-danger-solid), never a row-act',
      html.includes('btn-danger-solid') && !html.includes('row-act'));
    eq('wsDeleteBody sends the typed text as {confirm} and nothing else', V.wsDeleteBody(del({ confirmText: 'main' })), '{"confirm":"main"}');
    const out = V.wsDeleteOutcomeText({ scope: 'main', trashPath: '/t/alpha--alpha--main--x', machines: ['a', 'b'], restoreTo: 'state/', recreated: false }, 'main');
    eq('the outcome says what went, where, and how to restore it', out,
      'Deleted handoff “main” — 2 saved copies (a, b). It was moved to The Curator’s trash, at /t/alpha--alpha--main--x. '
      + 'To restore it, move that folder back into state/ and rename it main.');
    ok('...and a save that landed during the move is SAID', /exists again holding only that save/.test(
      V.wsDeleteOutcomeText({ scope: 'main', trashPath: '/t', machines: ['a'], recreated: true }, 'main')));
  }

  // ── memory.js: the row, the binder, and the two async functions ──
  const viewSrc = readFileSync(join(ROOT, 'src/public/next/views/memory.js'), 'utf8');
  function lift(name) {
    const m = new RegExp('(?:^|\\n)(?:export\\s+)?(?:async\\s+)?function ' + name + '\\s*\\(').exec(viewSrc);
    if (!m) throw new Error('lift: ' + name + ' not found');
    const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
    let p = viewSrc.indexOf('(', start); let parens = 0;
    for (; p < viewSrc.length; p++) {
      if (viewSrc[p] === '(') parens++;
      else if (viewSrc[p] === ')') { parens--; if (parens === 0) { p++; break; } }
    }
    let i = viewSrc.indexOf('{', p); let depth = 0;
    for (; i < viewSrc.length; i++) {
      if (viewSrc[i] === '{') depth++;
      else if (viewSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    const out = viewSrc.slice(start, i).replace(/^export\s+/, '');
    if (!/\n\}$/.test(out)) throw new Error('lift: ' + name + ' desynced');
    return out;
  }
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  {
    const row = new Function('escapeHtml', 'icon', 'freshnessTier', 'renderDepthCell',
      lift('formatAge') + '\n' + lift('effectiveSave') + '\n' + lift('wsRowHtml') + '\nreturn wsRowHtml;')(
      escapeHtml, (n) => '<svg data-icon="' + n + '"></svg>', () => 'fresh', () => '');
    const s = { scope: 'a"b', machine: 'm1', writtenAgeSeconds: 60, bytes: 10 };
    const w = row(s, null, null, null, null, true);
    ok('a writable row carries ONE neutral .row-act trash, with the scope escaped',
      (w.match(/class="row-act mem-ws-del"/g) || []).length === 1 && w.includes('data-ws-delete="a&quot;b"')
      && w.includes('data-icon="trash"'), w);
    ok('...labelled for the handoff, not this row\'s machine', w.includes('aria-label="Delete handoff a&quot;b…"'));
    ok('a read-only row carries NO trash at all', !/row-act|data-ws-delete/.test(row(s, null, null, null, null, false)));
  }

  function harness(fetchImpl) {
    const state = { activeDomain: 'alpha', activeProject: 'alpha', wsDelete: null, wsDeleteOutcome: null,
      scope: 'main', machine: null, detail: { scope: 'main' } };
    const calls = { render: 0, reload: 0, index: 0, fetch: [] };
    const api = new Function('state', 'render', 'isCurrentMount', 'fetch', 'reportAsyncMountFailure',
      'forgetProject', 'activeKey', 'keyOf', 'reloadActive', 'refreshIndex',
      'wsDeleteCanSubmit', 'wsDeleteConfirmMatches', 'wsDeleteBody', 'wsDeleteOutcomeText',
      'let pendingFocusId = null;\n' + lift('openWorkStreamDelete') + '\n' + lift('runWorkStreamDelete') + '\n'
      + lift('bindWorkStreamRows') + '\n'
      + 'return { openWorkStreamDelete, runWorkStreamDelete, bindWorkStreamRows };')(
      state, () => { calls.render++; }, () => true,
      async (url, init) => { calls.fetch.push({ url, init }); return fetchImpl(url, init); },
      () => {}, () => {}, () => 'alpha/alpha', (d, p) => d + '/' + p,
      async () => { calls.reload++; }, async () => { calls.index++; },
      V.wsDeleteCanSubmit, V.wsDeleteConfirmMatches, V.wsDeleteBody, V.wsDeleteOutcomeText);
    return { state, calls, api };
  }
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  {
    const h = harness(async () => json(200, preview));
    await h.api.openWorkStreamDelete('main', 1);
    eq('opening asks for the preview with ONE GET (a single argument)', h.calls.fetch.length, 1);
    eq('...at …/scopes/main/delete-preview', h.calls.fetch[0].url, '/api/memory/alpha/alpha/scopes/main/delete-preview');
    ok('...with no request init at all', h.calls.fetch[0].init === undefined);
    ok('...and the card holds the preview', h.state.wsDelete && h.state.wsDelete.preview === preview && !h.state.wsDelete.loading);
    ok('the card was painted BEFORE the answer (loading), then again with it', h.calls.render === 2);

    await h.api.runWorkStreamDelete(1);
    eq('pressing with nothing typed sends NOTHING', h.calls.fetch.length, 1);
    h.state.wsDelete.confirmText = 'Main';
    await h.api.runWorkStreamDelete(1);
    eq('...nor with a near miss', h.calls.fetch.length, 1);
  }
  {
    // A stale preview is dropped.
    let resolve; const h = harness(() => new Promise((r) => { resolve = r; }));
    const p = h.api.openWorkStreamDelete('main', 1);
    h.state.wsDelete = null; // the owner pressed Keep it / moved on
    resolve(json(200, preview)); await p;
    eq('a preview that lands after the card closed is dropped', h.state.wsDelete, null);
  }
  {
    const h = harness(async (url, init) => (init ? json(200, { ok: true, scope: 'main', trashPath: '/t/x', machines: ['a'], restoreTo: 'state/' }) : json(200, preview)));
    await h.api.openWorkStreamDelete('main', 1);
    h.state.wsDelete.confirmText = 'main';
    await h.api.runWorkStreamDelete(1);
    const sent = h.calls.fetch[1];
    eq('the exact name sends ONE DELETE', sent && sent.init && sent.init.method, 'DELETE');
    eq('...to …/scopes/main', sent && sent.url, '/api/memory/alpha/alpha/scopes/main');
    eq('...with {confirm: "main"} as its body', sent && sent.init.body, '{"confirm":"main"}');
    eq('on success the card closes', h.state.wsDelete, null);
    ok('...its outcome takes the slot, from the server\'s answer', h.state.wsDeleteOutcome
      && /at \/t\/x\./.test(h.state.wsDeleteOutcome.text) && h.state.wsDeleteOutcome.project === 'alpha');
    ok('...the open handoff, which went with it, is dropped', h.state.scope === null && h.state.detail === null);
    ok('...and the table and the rail are re-read, not patched', h.calls.reload === 1 && h.calls.index === 1);
  }
  {
    const h = harness(async (url, init) => (init ? json(409, { ok: false, reason: 'locked', error: 'Another write is in progress.' }) : json(200, preview)));
    await h.api.openWorkStreamDelete('main', 1);
    h.state.wsDelete.confirmText = 'main';
    await h.api.runWorkStreamDelete(1);
    ok('a refusal keeps the card open with the server\'s reason in it', h.state.wsDelete
      && h.state.wsDelete.error === 'Another write is in progress.' && h.state.wsDelete.busy === false);
    eq('...and re-reads nothing', h.calls.reload, 0);
  }
  {
    // The binder: the trash opens the card; typing flips the button live.
    const h = harness(async () => json(200, preview));
    const mk = (attrs) => ({ attrs, listeners: {}, disabled: true, value: '',
      getAttribute(k) { return this.attrs[k]; }, addEventListener(t, f) { this.listeners[t] = f; } });
    const trash = mk({ 'data-ws-delete': 'main' });
    const input = mk({}); const go = mk({});
    const root = {
      querySelectorAll: (sel) => (sel === '[data-ws-delete]' ? [trash] : []),
      getElementById: (id) => ({ 'mem-ws-del-input': input, 'mem-ws-del-go': go }[id] || null),
    };
    h.api.bindWorkStreamRows(root, 1);
    ok('the row trash is bound', typeof trash.listeners.click === 'function');
    trash.listeners.click();
    await new Promise((r) => setImmediate(r));
    ok('...and a press opens the card for that scope', h.state.wsDelete && h.state.wsDelete.scope === 'main');
    input.value = 'mai'; input.listeners.input();
    eq('typing a partial name keeps the button disabled', go.disabled, true);
    input.value = 'main'; input.listeners.input();
    eq('the exact name enables it, live', go.disabled, false);
    input.value = 'main!'; input.listeners.input();
    eq('...and one more character disables it again', go.disabled, true);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('§M — no agent can reach it');
  // ═══════════════════════════════════════════════════════════════════════
  {
    const mcpFiles = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory() && e.name !== 'node_modules') walk(p);
        else if (e.isFile() && p.endsWith('.js')) mcpFiles.push(p);
      }
    })(join(ROOT, 'mcp'));
    ok('SETUP: the MCP tree was read', mcpFiles.length > 5, String(mcpFiles.length));
    const hits = mcpFiles.filter((f) => /deleteWorkStream|previewWorkStreamDelete|\/scopes\/[^'"]*delete/.test(readFileSync(f, 'utf8')));
    eq('no MCP module names the work-stream delete', hits.length, 0);
    const { tools } = await import('../mcp/tools/index.js');
    const names = (tools || []).map((t) => t.name || (t.definition && t.definition.name) || '');
    ok('SETUP: the MCP tool list was read', names.length > 5, JSON.stringify(names));
    ok('no MCP tool deletes a scope, a handoff or a project',
      !names.some((n) => /delete|remove/i.test(n) && /scope|stream|handoff|state|project/i.test(n)), JSON.stringify(names));
  }
} catch (err) {
  failed++;
  console.log('  ✗ CRASH: ' + (err && err.stack || err));
} finally {
  cleanup();
}

console.log('\n' + '─'.repeat(60));
console.log('Passed: ' + passed + '   Failed: ' + failed);
if (failed) { console.log('❌ work-stream delete assertions FAILED'); process.exit(1); }
console.log('✅ work-stream delete assertions green');
