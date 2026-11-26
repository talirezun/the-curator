#!/usr/bin/env node
/**
 * test-config-durability-ui.js — the damaged-settings-file follow-up to F2
 * (v4.1.2 integration, package F7).
 *
 * src/brain/config.js already refuses every write to a damaged
 * .curator-config.json / .sharedbrain-config.json and keeps a copy
 * (scripts/test-config-durability.js). This suite holds what a PERSON meets:
 *
 *   §1  GET /api/config/settings-files names each file's state, the reason and
 *       the kept copy, by basename only.
 *   §2  A refused write is 409 `config_unreadable`, not a 500: through a real
 *       route that answers `500 {error: err.message}` (ui-state), the two
 *       github-read-token routes, and a route that THROWS (apiErrorHandler).
 *   §3  POST /api/config/settings-files/set-aside: body exactly {file}; a good
 *       or missing file is refused and untouched; a damaged one is set aside
 *       with a verified byte-for-byte copy, and the next write starts fresh.
 *   §4  System Check's row says so and stays READ-ONLY: it writes no copy.
 *   §5  The banner (shared/settings-file-banner.js): its words, Start fresh
 *       only where it can work, escaping, persistence (no Dismiss), and the
 *       paint/clear cycle against a stub document.
 *
 * Offline; isolated (CURATOR_TEST_USER_DATA_DIR, CURATOR_TEST_DOMAINS_DIR, a
 * fake HOME, CURATOR_NO_OPEN), set BEFORE any app module is imported. The real
 * settings files are fingerprinted before and after.
 */
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_FILES = [
  path.join(ROOT, '.curator-config.json'),
  path.join(ROOT, '.sharedbrain-config.json'),
  path.join(homedir(), 'Library', 'Application Support', 'The Curator', '.curator-config.json'),
  path.join(homedir(), 'Library', 'Application Support', 'The Curator', '.sharedbrain-config.json'),
];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fingerprint = (f) => (existsSync(f) ? sha(readFileSync(f)) + ':' + statSync(f).size : 'absent');
const realBefore = REAL_FILES.map(fingerprint);

const TMP = mkdtempSync(path.join(tmpdir(), 'curator-cfgui-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const HOME = path.join(TMP, 'home');
for (const d of [USER_DATA, DOMAINS, HOME]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
process.env.HOME = HOME;
process.env.CURATOR_NO_OPEN = '1';
for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) delete process.env[k];

let passed = 0, failed = 0;
const ok = (c, m, d) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failed++; console.log('  ✗ ' + m + (d !== undefined ? '\n      ' + JSON.stringify(d).slice(0, 700) : '')); } };
const section = (t) => console.log('\n' + t);
const origError = console.error;
console.error = () => {}; // config.js reports damage on stderr; not this suite's output

const CFG = path.join(USER_DATA, '.curator-config.json');
const SB = path.join(USER_DATA, '.sharedbrain-config.json');
const listing = () => readdirSync(USER_DATA).sort().join(',');
const copiesOf = (base) => readdirSync(USER_DATA).filter((n) => n.startsWith(base + '.unreadable-'));
const clean = () => { for (const n of readdirSync(USER_DATA)) rmSync(path.join(USER_DATA, n), { recursive: true, force: true }); };

const express = (await import('express')).default;
const { userErrorBodies, apiErrorHandler } = await import('../src/brain/user-errors.js');
const configRouter = (await import('../src/routes/config.js')).default;
const C = await import('../src/brain/config.js');
const D = await import('../src/brain/diagnostics.js');

const app = express();
app.use(express.json());
app.use('/api', userErrorBodies);
app.use('/api/config', configRouter);
// A route that THROWS the refusal (no catch of its own): apiErrorHandler's path.
app.post('/api/test/throws', () => { C.setUiState({ onboardingDismissed: '1' }); });
app.use('/api', apiErrorHandler);
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const PORT = server.address().port;
async function call(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  let json = null; try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body: json || {} };
}
const DAMAGED = '{ "geminiApiKey": "AIza-not-a-real-key", oops }\n';
const DAMAGED_SB = '{"connections": "not a list"}';

try {
  section('§1 GET /api/config/settings-files');
  {
    clean();
    const r = await call('GET', '/api/config/settings-files');
    ok(r.status === 200 && r.body.ok === true && r.body.files.length === 2, 'answers both files', r.body);
    ok(r.body.files.every((f) => f.state === 'missing'), 'none saved yet: both "missing"', r.body.files);
    writeFileSync(CFG, DAMAGED);
    const r2 = await call('GET', '/api/config/settings-files');
    const f = r2.body.files.find((x) => x.file === '.curator-config.json');
    ok(f && f.state === 'damaged' && f.reason === 'parse' && /^\.curator-config\.json\.unreadable-[0-9a-f]{12}$/.test(f.backup), 'a damaged settings file: state, reason and the kept copy by basename', f);
    ok(copiesOf('.curator-config.json').length === 1 && readFileSync(path.join(USER_DATA, f.backup), 'utf8') === DAMAGED, 'the copy exists and is byte-identical');
    ok(readFileSync(CFG, 'utf8') === DAMAGED, 'the damaged file itself is untouched');
    ok(!JSON.stringify(r2.body).includes(USER_DATA) && !JSON.stringify(r2.body).includes('AIza'), 'no path and no file content in the answer');
    writeFileSync(SB, DAMAGED_SB);
    const s = (await call('GET', '/api/config/settings-files')).body.files.find((x) => x.file === '.sharedbrain-config.json');
    ok(s && s.state === 'damaged' && s.reason === 'shape', 'the Shared Brain file of the wrong shape reads damaged too', s);
  }

  section('§2 a refused write is 409 config_unreadable, not 500');
  {
    const u = await call('POST', '/api/config/ui-state', { onboardingDismissed: '1' });
    ok(u.status === 409 && u.body.code === 'config_unreadable', 'POST /ui-state (answers 500 {error: err.message} itself) → 409 config_unreadable', u);
    ok(/\.curator-config\.json\) could not be read, so nothing was saved/.test(u.body.error) && /unreadable-[0-9a-f]{12}/.test(u.body.error), '…its sentence names the file and the kept copy', u.body.error);
    ok(readFileSync(CFG, 'utf8') === DAMAGED, '…and nothing was written');
    const g = await call('PUT', '/api/config/github-read-token', { token: 'ghp_' + 'a'.repeat(36) });
    ok(g.status === 409 && g.body.code === 'config_unreadable', 'PUT /github-read-token → 409 (was an explicit 500)', g);
    const gd = await call('DELETE', '/api/config/github-read-token');
    ok(gd.status === 409 && gd.body.code === 'config_unreadable', 'DELETE /github-read-token → 409 (was an explicit 500)', gd);
    const t = await call('POST', '/api/test/throws', {});
    ok(t.status === 409 && t.body.code === 'config_unreadable' && /could not be read/.test(t.body.error), 'a route that throws the refusal → 409 through apiErrorHandler', t);
    // CONTROL: an ordinary 500 stays a 500.
    const plain = express();
    plain.use('/api', userErrorBodies);
    plain.get('/api/x', (_q, res) => res.status(500).json({ error: 'The disk said no.' }));
    const ps = await new Promise((r) => { const s = plain.listen(0, '127.0.0.1', () => r(s)); });
    const px = await fetch(`http://127.0.0.1:${ps.address().port}/api/x`);
    ok(px.status === 500, 'CONTROL: another 500 is left a 500', px.status);
    ps.close();
  }

  section('§3 POST /api/config/settings-files/set-aside');
  {
    for (const bad of [{}, { file: 'x.json' }, { file: '.curator-config.json', extra: 1 }, { file: '../.curator-config.json' }, []]) {
      const r = await call('POST', '/api/config/settings-files/set-aside', bad);
      ok(r.status === 400 && r.body.reason === 'unknown_file', `refused 400: ${JSON.stringify(bad)}`, r);
    }
    ok(readFileSync(CFG, 'utf8') === DAMAGED, '…and nothing moved');
    const before = readFileSync(CFG);
    const r = await call('POST', '/api/config/settings-files/set-aside', { file: '.curator-config.json' });
    ok(r.status === 200 && r.body.ok && /^\.curator-config\.json\.unreadable-[0-9a-f]{12}$/.test(r.body.backup), 'a damaged file is set aside, naming its copy', r);
    ok(!existsSync(CFG), 'the live file is gone');
    ok(readFileSync(path.join(USER_DATA, r.body.backup)).equals(before), 'the copy is byte-for-byte what was there');
    const again = await call('POST', '/api/config/settings-files/set-aside', { file: '.curator-config.json' });
    ok(again.status === 409 && again.body.reason === 'missing', 'a second press: 409 missing (nothing to set aside)', again);
    const u = await call('POST', '/api/config/ui-state', { onboardingDismissed: '1' });
    ok(u.status === 200 && JSON.parse(readFileSync(CFG, 'utf8')).ui?.onboardingDismissed === '1', 'the next write starts a fresh file', u);
    const good = readFileSync(CFG);
    const ng = await call('POST', '/api/config/settings-files/set-aside', { file: '.curator-config.json' });
    ok(ng.status === 409 && ng.body.reason === 'not_damaged' && readFileSync(CFG).equals(good), 'a GOOD file is refused (409 not_damaged) and untouched — a stale banner cannot remove it', ng);
    const sb = await call('POST', '/api/config/settings-files/set-aside', { file: '.sharedbrain-config.json' });
    ok(sb.status === 200 && !existsSync(SB) && readFileSync(path.join(USER_DATA, sb.body.backup), 'utf8') === DAMAGED_SB, 'the Shared Brain file is set aside the same way', sb);
    const st = (await call('GET', '/api/config/settings-files')).body.files;
    ok(st.every((f) => f.state !== 'damaged'), 'afterwards the status reads no damaged file', st);
  }

  section('§4 System Check: the row, and it writes nothing');
  {
    clean();
    const OTHER = '{"anthropicApiKey": "never-read", trailing, }';
    writeFileSync(CFG, OTHER); // a content no read has kept a copy of yet
    const before = listing();
    const row = D.checkSettingsFiles();
    ok(row.id === 'settings-files' && row.status === 'fail' && /\.curator-config\.json is damaged/.test(row.detail), 'a damaged file: the row fails and names it', row);
    ok(!/unreadable-/.test(row.detail), '…with no copy named, because none exists yet', row.detail);
    ok(listing() === before, 'READ-ONLY: the row wrote no copy (the user-data folder is unchanged)', { before, after: listing() });
    C.getConfigFileStatus(); // the app's own read keeps the copy
    const row2 = D.checkSettingsFiles();
    ok(/a copy is kept as \.curator-config\.json\.unreadable-[0-9a-f]{12}/.test(row2.detail), 'once the app has kept a copy, the row names it', row2.detail);
    clean();
    const okRow = D.checkSettingsFiles();
    ok(okRow.status === 'ok', 'CONTROL: no damaged file → ok', okRow);
    const sbRow = D.checkSettingsFiles({ curator: () => ({ file: '.curator-config.json', state: 'ok' }), sharedBrain: () => ({ file: '.sharedbrain-config.json', state: 'damaged', reason: 'read', backup: null }) });
    ok(sbRow.status === 'fail' && /could not be opened/.test(sbRow.detail), 'a file that cannot be opened is named as such', sbRow);
    const quick = await D.runQuickDiagnostics();
    ok(quick.checks.some((c) => c.id === 'settings-files'), 'runQuickDiagnostics carries the row');
  }

  section('§5 the banner');
  {
    const B = await import('../src/public/next/shared/settings-file-banner.js');
    const parse = { file: '.curator-config.json', state: 'damaged', reason: 'parse', backup: '.curator-config.json.unreadable-0123456789ab' };
    const read = { file: '.sharedbrain-config.json', state: 'damaged', reason: 'read', backup: null };
    ok(B.damagedFiles({ ok: true, files: [parse, { file: '.curator-config.json', state: 'ok' }, { file: 'evil.json', state: 'damaged' }, null] }).length === 1, 'only damaged, known files are drawn');
    ok(B.damagedFiles(null).length === 0 && B.damagedFiles({ ok: false }).length === 0, 'a failed answer draws nothing');
    const h = B.renderSettingsFileBanner([parse]);
    ok(/tx-status tx-status-danger/.test(h) && /data-settings-file-start-fresh="\.curator-config\.json"/.test(h), 'built from renderStatus (danger) and a .btn Start fresh');
    ok(h.includes('.curator-config.json.unreadable-0123456789ab') && /nothing is saved to it/.test(h), 'it names the file and the kept copy');
    ok(!/Dismiss/i.test(h), 'PERSISTENT: there is no Dismiss');
    const hr = B.renderSettingsFileBanner([read]);
    ok(!/start-fresh/.test(hr) && /permissions/.test(hr), 'a file that cannot be opened offers no Start fresh (it would be refused) and says to check permissions');
    ok(!/<img/.test(B.renderSettingsFileBanner([{ ...parse, backup: '<img src=x>' }])), 'a copy name is escaped');
    const cf = B.startFreshConfirm(parse);
    ok(cf.tone === 'danger' && cf.confirmLabel === 'Start fresh' && /knowledge folder itself is not touched/.test(cf.detail) && cf.message.includes(parse.backup), 'the confirm says what is kept, what must be set again, and is danger-toned', cf);
    ok(/joined again/.test(B.startFreshConfirm({ ...parse, file: '.sharedbrain-config.json' }).detail), 'the Shared Brain confirm says connections must be joined again');

    // Paint and clear against a stub document.
    const inserted = [];
    const mkEl = () => ({ id: '', className: '', style: {}, innerHTML: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, querySelectorAll: () => [], remove() { const i = inserted.indexOf(this); if (i >= 0) inserted.splice(i, 1); } });
    globalThis.document = {
      getElementById: (id) => (id === 'main' ? { insertBefore: (el) => inserted.push(el) } : id === 'view-root' ? {} : inserted.find((e) => e.id === id) || null),
      createElement: mkEl,
    };
    let answer = { ok: true, files: [parse] };
    globalThis.fetch = async () => ({ ok: true, json: async () => answer });
    await B.checkSettingsFiles();
    ok(inserted.length === 1 && inserted[0].id === B.BANNER_ID && inserted[0].attrs.role === 'alert' && /unreadable-0123456789ab/.test(inserted[0].innerHTML), 'boot: the banner is painted above the view');
    await B.checkSettingsFiles();
    ok(inserted.length === 1, 'a re-check repaints in place (never two banners)');
    answer = { ok: true, files: [{ file: '.curator-config.json', state: 'ok' }] };
    await B.checkSettingsFiles();
    ok(inserted.length === 0, 'fixed by hand: the next check removes it');
    globalThis.fetch = async () => { throw new Error('offline'); };
    let threw = false; try { await B.checkSettingsFiles(); } catch { threw = true; }
    ok(!threw, 'a failed fetch never throws (boot() does not await it)');
  }

  section('the real settings files');
  ok(REAL_FILES.map(fingerprint).join('|') === realBefore.join('|'), 'no real settings file was touched');
} finally {
  server.close();
  console.error = origError;
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
