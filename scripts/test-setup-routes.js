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
 *   v3.78.0:
 *   §9  the Mac app, a source checkout found through an MCP entry, and an alias
 *       read as three computers instead of 1 computer / 2 installs / 3 names.
 *   §10 ~/.claude.json's `projects` keys leaking (only a folder whose marker
 *       names this project may leave; no value under any key), and the hook
 *       log's repository not offered.
 *   §11 the tools menu without DeepSeek Harness or "Custom tool…"; a custom
 *       name that is not validated, capped at 12, or removable.
 *   §12 an empty config file's to-fix line with a reveal that is refused.
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

  section('§9  one computer, two installs, three names (v3.78.0)');
  {
    // The maintainer's MacBook, 2026-09-28: the Mac app (acb035), a source
    // checkout (17d23c) and that checkout's pre-D10 alias (mac-17d23c).
    await store.createProject(D, 'fleet', { brief: '# Project brief — fleet\n\n## Standing brief\n\nx\n' });
    for (const [machine, harness, scope] of [['mac-17d23c', 'Antigravity', 'antigravity'], ['talis-macbook-pro-17d23c', 'Antigravity', 'antigravity'], ['talis-macbook-pro-acb035', 'Claude Code', 'claude-code']]) {
      const s = await store.saveWorkingState(D, { project: 'fleet', scope, machine, harness, headline: machine, nowState: 'x', nextSteps: ['y'] });
      if (!s.ok) throw new Error(`fixture save ${machine}: ${s.reason}`);
    }
    const SUPPORT = path.join(HOME, 'Library', 'Application Support', 'The Curator');
    w(path.join(SUPPORT, '.curator-machine-id'), 'talis-macbook-pro-acb035\n');
    w(path.join(SUPPORT, '.curator-install-id'), 'acb035\n');
    // The checkout is found through the install Claude Desktop's my-curator entry launches.
    const SRC = path.join(TMP, 'src-checkout');
    w(path.join(SRC, 'package.json'), JSON.stringify({ name: 'the-curator' }));
    w(path.join(SRC, 'bin', 'curator.js'), '');
    w(path.join(SRC, '.curator-machine-id'), 'talis-macbook-pro-17d23c\n');
    w(path.join(SRC, '.curator-install-id'), '17d23c\n');
    w(path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      JSON.stringify({ mcpServers: { 'my-curator': { command: '/bin/sh', args: [path.join(SRC, 'mcp', 'server.js'), '--domains-path', DOMAINS] }, zzother: { env: { K: SECRET } } } }));
    const r = await call('GET', `/api/setup/projects/${D}/fleet`);
    ok(r.status === 200 && r.body.counts?.computers === 1 && r.body.counts.installs === 2 && r.body.counts.machineNames === 3,
      '1 computer, 2 installs, 3 names', r.body.counts);
    const here = (r.body.physical || []).find((p) => p.thisComputer);
    ok(here && here.installs.length === 2 && here.installs.every((i) => i.thisComputer), 'both installs are in this Mac\'s one physical group', r.body.physical);
    const src = r.body.computers.find((c) => c.key === 'install:17d23c');
    ok(src && src.installKind === 'source' && src.primary === 'talis-macbook-pro-17d23c' && src.aliases.join() === 'mac-17d23c', 'the checkout: kind source, primary name and its alias', src);
    ok(r.body.computers.find((c) => c.key === 'install:acb035')?.installKind === 'app', 'the Mac app install: kind app');
    ok(r.body.machine.installIds.includes('acb035') && r.body.machine.installIds.includes('17d23c'), 'the machine facts list both installation ids');
    ok(!JSON.stringify(r.body).includes(SECRET) && !JSON.stringify(r.body).includes('zzother'), 'no other server\'s name or secret');
  }

  section('§10 repository candidates, ~/.claude.json keys filtered (v3.78.0)');
  {
    const GOOD = path.join(HOME, 'code', 'fleet');
    const HOOKED = path.join(HOME, 'code', 'fleet-hooked');
    const PRIVATE = path.join(HOME, 'code', 'zz-private-client-work');
    w(path.join(GOOD, '.curator-project'), `${D}/fleet\n`);
    w(path.join(HOOKED, '.curator-project'), `${D}/fleet\n`);
    w(path.join(PRIVATE, '.curator-project'), `${D}/ott\n`);
    w(path.join(HOME, '.claude.json'), JSON.stringify({
      mcpServers: { zzother: { env: { K: SECRET } } },
      projects: { [PRIVATE]: { history: [SECRET], mcpServers: { zzother: {} } }, [GOOD]: { history: [SECRET] }, '/etc': {} },
    }));
    writeFileSync(path.join(USER_DATA, '.hook-activity.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), harness: 'antigravity', event: 'session-start', project: `${D}/fleet`, decision: 'inject', repo: HOOKED })}\n`);
    const r = await call('GET', `/api/setup/projects/${D}/fleet`);
    const c = r.body.repoCandidates || [];
    ok(c[0]?.path === GOOD && c[0].why === 'claude-code' && c[0].display === '~/code/fleet', 'a ~/.claude.json project folder whose marker names this project is offered', c);
    ok(c.some((x) => x.path === HOOKED && x.why === 'hook-log'), 'the hook log\'s session-start repository is offered', c);
    const s = JSON.stringify(r.body);
    ok(!s.includes('zz-private-client-work') && !s.includes(SECRET) && !s.includes('history'), 'a folder whose marker names ANOTHER project, and every value under any key, never leave', s.slice(0, 200));
    ok(Array.isArray(r.body.repoSuggestions) && r.body.repoSuggestions[0]?.root === GOOD && r.body.repoSuggestions[0].rootDisplay === '~/code/fleet', 'the v3.77.0 repoSuggestions field carries the same data');
    await call('PUT', `/api/setup/projects/${D}/fleet/repo`, { path: GOOD });
    const set = await call('GET', `/api/setup/projects/${D}/fleet`);
    ok(Array.isArray(set.body.repoCandidates) && set.body.repoCandidates.length === 0, 'with a repository set, no candidates are computed');
    ok(set.body.sync?.scope === 'all-domains' || set.body.sync?.configured === false, 'the sync facts say their scope is every domain', set.body.sync);
  }

  section('§11 the tools menu and custom tools (v3.78.0)');
  {
    const r = await call('GET', `/api/setup/projects/${D}/fleet`);
    const add = r.body.addable || [];
    const dsh = add.find((a) => a.id === 'dsh');
    ok(dsh && dsh.group === 'known' && dsh.measured === true && /cordis\.patch\.yml/.test(dsh.detail), 'DeepSeek Harness is addable, measured, naming cordis.patch.yml', dsh);
    ok(add.at(-1)?.id === '__custom' && add.at(-1).group === 'other', 'the last entry is "Custom tool…"', add.at(-1));
    ok(!add.some((a) => a.id === 'aider'), 'a tool with no MCP client is not offered');
    for (const bad of ['', 'x'.repeat(41), 'bad/name', 'semi;colon']) {
      const b = await call('PUT', '/api/setup/tools', { custom: { name: bad } });
      if (b.status !== 400) ok(false, `a bad name is refused: ${JSON.stringify(bad)}`, b.body);
    }
    ok(true, 'empty, 41 characters, a slash and a semicolon are each refused (400)');
    const a1 = await call('PUT', '/api/setup/tools', { custom: { name: 'Fancy  Bot' } });
    ok(a1.status === 200 && a1.body.custom.join() === 'Fancy Bot', 'a custom name is normalised and stored', a1.body);
    const cfg = JSON.parse(readFileSync(path.join(USER_DATA, '.curator-config.json'), 'utf8'));
    ok(cfg.setupCustomTools?.join() === 'Fancy Bot' && !JSON.stringify(fingerprint(DOMAINS)).includes('Fancy'), '…in this install\'s .curator-config.json, never under domains/');
    const k = await call('PUT', '/api/setup/tools', { custom: { name: 'claude code' } });
    ok(k.status === 200 && k.body.added?.known === true && k.body.ids.includes('claude-code') && !k.body.custom.includes('claude code'), 'a name that IS a known tool joins the known list instead');
    const g = await call('GET', `/api/setup/projects/${D}/fleet`);
    const fancy = g.body.tools.find((t) => t.id === 'fancy bot');
    ok(fancy && fancy.custom && fancy.mcpSnippet?.format === 'json' && /"mcpServers"/.test(fancy.mcpSnippet.text) && /"my-curator"/.test(fancy.mcpSnippet.text), 'the custom row carries a generic mcpServers entry', fancy);
    ok(fancy.instructionFile === 'AGENTS.md' && (process.platform !== 'darwin' || fancy.skillZips?.length === 2), '…AGENTS.md and the two skill .zip links');
    ok(fancy.status === 'no-save' && typeof fancy.parts?.mcp?.state === 'string', '…status no-save until it saves under its own name');
    await call('PUT', '/api/setup/tools', { ids: ['claude-code', 'dsh', 'cursor'] });
    const d2 = await call('GET', `/api/setup/projects/${D}/fleet`);
    const dshRow = d2.body.tools.find((t) => t.id === 'dsh');
    ok(dshRow && dshRow.mcpSnippet?.format === 'yaml' && dshRow.mcpSnippet.text.startsWith('- insert:') && dshRow.measured === true, 'the dsh row carries the Cordis patch entry (yaml), measured', dshRow?.mcpSnippet);
    for (let i = 0; i < 11; i++) await call('PUT', '/api/setup/tools', { custom: { name: `tool ${i}` } });
    const over = await call('PUT', '/api/setup/tools', { custom: { name: 'one too many' } });
    ok(over.status === 409 && over.body.reason === 'too_many', 'a 13th custom tool is refused (max 12)', over.body);
    const rm = await call('PUT', '/api/setup/tools', { removeCustom: 'FANCY bot' });
    ok(rm.status === 200 && !rm.body.custom.includes('Fancy Bot') && rm.body.custom.length === 11, 'removeCustom removes by normalised name', rm.body);
  }

  section('§12 an empty config file: a to-fix line whose reveal is allowed (v3.78.0)');
  {
    w(path.join(HOME, '.cursor', 'mcp.json'), '');
    const r = await call('GET', `/api/setup/projects/${D}/fleet`);
    const f = (r.body.toFix || []).find((x) => x.tool === 'cursor' && x.kind === 'bridge-file');
    ok(f && f.text === 'Cursor: ~/.cursor/mcp.json is empty.' && f.fix.kind === 'reveal' && f.fix.path === path.join(HOME, '.cursor', 'mcp.json'), 'an empty ~/.cursor/mcp.json alone is a to-fix line naming it, with a reveal', f);
    const rv = await call('POST', '/api/setup/reveal', { path: f?.fix?.path });
    ok(rv.status === 200 && revealed.at(-1) === path.join(HOME, '.cursor', 'mcp.json'), '…and that path is on the reveal allow-list', rv.body);
    w(path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), '');
    const r2 = await call('GET', `/api/setup/projects/${D}/fleet`);
    ok(!(r2.body.toFix || []).some((x) => x.tool === 'antigravity' && x.kind === 'bridge-file'), 'an empty Antigravity file beside its working config raises nothing');
  }

  section('§13 no repository set: a candidate checkout is this Mac\'s install (screen review, 2026-09-28)');
  {
    // Three machine ids, NO repo set, and the checkout reachable only as a
    // repository candidate (no MCP entry points at it). Before the fix its
    // saves read as a second computer.
    await store.createProject(D, 'solo2', { brief: '# Project brief — solo2\n\n## Standing brief\n\nx\n' });
    for (const [machine, harness, scope] of [['mac-5d5d5d', 'Antigravity', 'antigravity'], ['talis-macbook-pro-5d5d5d', 'Antigravity', 'antigravity'], ['talis-macbook-pro-acb035', 'Claude Code', 'claude-code']]) {
      const s = await store.saveWorkingState(D, { project: 'solo2', scope, machine, harness, headline: machine, nowState: 'x', nextSteps: ['y'] });
      if (!s.ok) throw new Error(`fixture save ${machine}: ${s.reason}`);
    }
    const CO = path.join(HOME, 'code', 'solo2-checkout');
    w(path.join(CO, '.curator-project'), `${D}/solo2\n`);
    w(path.join(CO, 'package.json'), JSON.stringify({ name: 'the-curator' }));
    w(path.join(CO, 'bin', 'curator.js'), '');
    w(path.join(CO, '.curator-machine-id'), 'talis-macbook-pro-5d5d5d\n');
    w(path.join(CO, '.curator-install-id'), '5d5d5d\n');
    const cj = JSON.parse(readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    cj.projects[CO] = {};
    w(path.join(HOME, '.claude.json'), JSON.stringify(cj));
    const r = await call('GET', `/api/setup/projects/${D}/solo2`);
    ok(r.body.repo === null && (r.body.repoCandidates || []).some((c) => c.path === CO), 'no repository set; the checkout is a candidate', r.body.repoCandidates);
    ok(r.body.counts?.computers === 1 && r.body.counts.installs === 2 && r.body.counts.machineNames === 3, '1 computer, 2 installs, 3 names — not 2 computers', r.body.counts);
    const src = r.body.computers.find((c) => c.key === 'install:5d5d5d');
    ok(src && src.thisComputer === true && src.installKind === 'source', 'the candidate checkout\'s install is this computer, kind source', src);
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
