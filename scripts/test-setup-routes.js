#!/usr/bin/env node
/**
 * test-setup-routes.js — v3.77.0. The Setup check's HTTP surface
 * (src/routes/setup.js) on a loopback router, against a fixture: an isolated
 * user-data dir, domains dir and a FAKE home (the route's home seam), plus a
 * real git repository. The real home is never read.
 *
 * Exists to stop:
 *   §1 GET /machine listing every harness (only ones with something on this
 *      machine, or added), leaking another server's secret, or omitting the
 *      display path / the copyable entry.
 *   §2 GET /projects/… for an unknown domain or a traversal name answering 200;
 *      a project with no repository set showing red instead of "not checked".
 *   §3 PUT …/repo accepting a relative path, a missing folder or junk; the path
 *      landing anywhere but THIS machine's `.curator-config.json`; and the
 *      project check then reading the repo (marker untracked → a to-fix line;
 *      AGENTS.md without the block → a to-fix line naming it).
 *   §4 POST /reveal opening a path no check listed (and the revealer seam).
 *   §5 GET /skills/<name>.zip for an unknown name; a zip that is not a zip.
 *   §6 a GET that writes: the fake home and the repo are fingerprinted.
 *   §7 the evidence path end to end: a real save by "Antigravity" under `main`
 *      from THIS machine id shows as a wrong-scope to-fix line.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

const TMP = mkdtempSync(path.join(os.tmpdir(), 'curator-setup-routes-'));
const USER_DATA = path.join(TMP, 'userdata');
const DOMAINS = path.join(TMP, 'domains');
const HOME = path.join(TMP, 'home');
const REPO = path.join(TMP, 'ott');
for (const d of [USER_DATA, DOMAINS, HOME, REPO]) mkdirSync(d, { recursive: true });
process.env.CURATOR_TEST_USER_DATA_DIR = USER_DATA;
process.env.CURATOR_TEST_DOMAINS_DIR = DOMAINS;
const SECRET = 'sk-FAKE-route-planted-7a6b5c';
const w = (f, text) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };

const { __setDomainsDirOverride, getProjectRepo } = await import('../src/brain/config.js');
__setDomainsDirOverride(DOMAINS);
const store = await import('../src/brain/working-state.js');
const express = (await import('express')).default;
const R = await import('../src/routes/setup.js');
R.__setSetupHomeOverride(HOME);
const revealed = [];
R.__setRevealer((target, cb) => { revealed.push(target); cb(null); });

// Domain + project + saves.
const D = 'projects';
mkdirSync(path.join(DOMAINS, D, 'wiki', 'entities'), { recursive: true });
writeFileSync(path.join(DOMAINS, D, 'CLAUDE.md'), '# Domain: projects\n');
writeFileSync(path.join(DOMAINS, D, 'wiki', 'index.md'), '# Wiki Index\n');
await store.createProject(D, 'ott', { brief: '# Project brief — ott\n\n## Standing brief\n\nx\n' });
const s1 = await store.saveWorkingState(D, { project: 'ott', scope: 'main', harness: 'Antigravity', headline: 'agy on main', nowState: 'x', nextSteps: ['y'] });
if (!s1.ok) throw new Error(`fixture save: ${s1.reason}`);

// Fake home: Antigravity configured, another server with a secret.
w(path.join(HOME, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'my-curator': { command: '/bin/sh', args: [] }, zzother: { command: 'x', env: { K: SECRET } } } }));

// Repo: git, CLAUDE.md with nothing, AGENTS.md without the block, marker untracked.
const git = (...a) => execFileSync('git', a, { cwd: REPO, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
git('init', '-q');
w(path.join(REPO, 'AGENTS.md'), '# agents\n');
git('add', 'AGENTS.md'); git('commit', '-q', '-m', 'i');
w(path.join(REPO, '.curator-project'), `${D}/ott\n`);

function fingerprint(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.git') walk(p); } else out.push(`${p} ${createHash('sha256').update(readFileSync(p)).digest('hex')}`);
    }
  })(dir);
  return out.join('\n');
}

const app = express();
app.use(express.json());
app.use('/api/setup', R.default);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;
async function call(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: res.status, body: json || {}, buf, type: res.headers.get('content-type') || '' };
}

try {
  const homeBefore = fingerprint(HOME);
  const repoBefore = fingerprint(REPO);

  section('§1  GET /machine');
  {
    const r = await call('GET', '/api/setup/machine');
    ok(r.status === 200 && r.body.ok, '200 ok', r.body);
    const ids = (r.body.harnesses || []).map((h) => h.id);
    ok(ids.includes('antigravity') && !ids.includes('zed') && !ids.includes('aider'), 'only harnesses with something on this machine are listed', ids);
    ok(!JSON.stringify(r.body).includes(SECRET) && !JSON.stringify(r.body).includes('zzother'), 'no other server\'s name or secret');
    const ag = r.body.harnesses.find((h) => h.id === 'antigravity');
    const f = ag.files.find((x) => x.named);
    ok(f && f.display === '~/.gemini/config/mcp_config.json', 'files carry a ~ display path beside the absolute one', f);
    ok(typeof r.body.copyEntries?.antigravity === 'string' || r.body.copyEntries?.antigravity === undefined, 'copyEntries is a text per harness when a launch line resolves');
    ok(Array.isArray(r.body.addable) && r.body.addable.some((a) => a.id === 'opencode'), 'the rest are offered as addable');
  }

  section('§2  GET /projects/… — refusals and the no-repo state');
  {
    ok((await call('GET', '/api/setup/projects/nope/ott')).status === 404, 'unknown domain → 404');
    ok((await call('GET', '/api/setup/projects/projects/..%2Fx')).status === 400, 'a traversal project name → 400');
    const r = await call('GET', `/api/setup/projects/${D}/ott`);
    ok(r.status === 200 && r.body.ok && r.body.repo === null, 'no repository set: repo is null', r.body.repo);
    const ag = (r.body.tools || []).find((t) => t.id === 'antigravity');
    ok(ag && ag.block.state === 'not-checked', 'the block cell reads "not checked", nothing red', ag?.block);
    ok(r.body.markerLine === `${D}/ott`, 'the marker line to copy is carried');
  }

  section('§3  PUT …/repo');
  {
    ok((await call('PUT', `/api/setup/projects/${D}/ott/repo`, { path: 'relative/x' })).status === 400, 'a relative path → 400');
    ok((await call('PUT', `/api/setup/projects/${D}/ott/repo`, { path: path.join(TMP, 'missing') })).status === 409, 'a folder that is not there → 409');
    ok((await call('PUT', `/api/setup/projects/${D}/ott/repo`, { path: 42 })).status === 400, 'junk → 400');
    const r = await call('PUT', `/api/setup/projects/${D}/ott/repo`, { path: REPO });
    ok(r.status === 200 && getProjectRepo(D, 'ott') === path.resolve(REPO), 'an existing folder is stored for this machine', r.body);
    const cfg = JSON.parse(readFileSync(path.join(USER_DATA, '.curator-config.json'), 'utf8'));
    ok(cfg.projectRepos?.[`${D}/ott`] === path.resolve(REPO), '…in THIS install\'s .curator-config.json (user data, never under domains/)');
    ok(!existsSync(path.join(DOMAINS, D, 'state', 'ott', 'repo.json')) && !JSON.stringify(fingerprint(DOMAINS)).includes(REPO), 'nothing under the synced domains folder names the path');
    const p = await call('GET', `/api/setup/projects/${D}/ott`);
    const kinds = (p.body.toFix || []).map((f) => f.kind);
    ok(kinds.includes('marker-uncommitted'), 'untracked marker → "not committed" to fix', kinds);
    ok(kinds.includes('block-missing') && p.body.toFix.find((f) => f.kind === 'block-missing').file === 'AGENTS.md', 'AGENTS.md without the block → to fix, naming AGENTS.md', kinds);
    ok(p.body.repo?.display && p.body.repo.marker?.present === true, 'the repo and its marker are reported');
  }

  section('§4  POST /reveal');
  {
    ok((await call('POST', '/api/setup/reveal', { path: '/etc/passwd' })).status === 400, 'a path no check listed is refused');
    ok((await call('POST', '/api/setup/reveal', { path: 'relative' })).status === 400, 'a relative path is refused');
    const r = await call('POST', '/api/setup/reveal', { path: path.join(HOME, '.gemini', 'config', 'mcp_config.json') });
    ok(r.status === 200 && revealed.at(-1) === path.join(HOME, '.gemini', 'config', 'mcp_config.json'), 'a listed config file is revealed', r.body);
    const a = await call('POST', '/api/setup/reveal', { path: path.join(path.resolve(REPO), 'GEMINI.md') });
    ok(a.status === 200 && revealed.at(-1) === path.resolve(REPO), 'a listed instruction file that does not exist yet reveals its folder', a.body);
  }

  section('§5  GET /skills/<name>.zip');
  {
    ok((await call('GET', '/api/setup/skills/evil.zip')).status === 404, 'an unknown skill → 404');
    ok((await call('GET', '/api/setup/skills/..%2F..%2Fpackage.json')).status === 404, 'a traversal → 404');
    if (process.platform === 'darwin') {
      const z = await call('GET', '/api/setup/skills/my-curator.zip');
      ok(z.status === 200 && /zip/.test(z.type) && z.buf.slice(0, 2).toString() === 'PK', 'my-curator.zip is a zip', z.status);
    }
  }

  section('§6  the GETs wrote nothing outside the app\'s own config');
  {
    ok(fingerprint(HOME) === homeBefore, 'the fake home is byte-identical');
    ok(fingerprint(REPO) === repoBefore, 'the repository is byte-identical');
  }

  section('§7  a real save under another scope, end to end');
  {
    const r = await call('GET', `/api/setup/projects/${D}/ott`);
    const ag = r.body.tools.find((t) => t.id === 'antigravity');
    ok(ag && ag.saved.wrongScope === true && r.body.toFix.some((f) => f.kind === 'wrong-scope'), 'Antigravity\'s save under "main" is a to-fix line', ag?.saved);
    ok((r.body.computers || []).length === 1, 'one computer has saved', r.body.computers);
    // v3.77.0 (S5) — the Curator version is RECORDED by the save and read back.
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    ok(r.body.computers[0].curator === version, 'the computer row names the Curator version its newest save was made with', r.body.computers[0]);
    const cur = readFileSync(path.join(DOMAINS, D, 'state', 'ott', 'main', r.body.computers[0].machine, 'current.md'), 'utf8');
    ok(new RegExp(`^_Machine: .* · Harness: Antigravity · Curator: ${version.replace(/\./g, '\\.')}_$`, 'm').test(cur),
      'the handoff\'s provenance line ends with `Curator: X.Y.Z` (additive, last)', cur.split('\n').find((l) => l.startsWith('_Machine')));
    // The EXISTING header reader (the v3.74.0 previous-handoff summary) must
    // still read Harness and Saved off a line that now ends in Curator: —
    // a second tool's save keeps the first as previous.md and parses it.
    await store.saveWorkingState(D, { project: 'ott', scope: 'main', harness: 'Claude Code', headline: 'cc on main', nowState: 'y', nextSteps: ['z'] });
    const again = await store.readWorkingState(D, { project: 'ott', scope: 'main' });
    ok(again.ok && again.previous && again.previous.harness === 'Antigravity' && typeof again.previous.writtenAt === 'string',
      'an existing reader still parses the provenance line (Harness and Saved intact beside Curator)', again.previous);
  }

  section('§8  the Mac app ships the skills (S5)');
  {
    const yml = readFileSync(new URL('../desktop/electron-builder.yml', import.meta.url), 'utf8');
    const filter = yml.slice(yml.indexOf('files:'), yml.indexOf('extraResources:'));
    ok(/^\s+- skills\/\*\*\/\*\s*$/m.test(filter), 'desktop/electron-builder.yml copies skills/** into the app, beside src/ and mcp/', filter.slice(0, 400));
  }
} finally {
  server.close();
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${failed ? '✗' : '✓'} test-setup-routes: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
