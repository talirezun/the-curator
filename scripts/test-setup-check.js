#!/usr/bin/env node
/**
 * test-setup-check.js — v3.77.0. The Setup check's derivation
 * (src/brain/setup-check.js): what it reads on a machine, what it concludes,
 * and what it must never return.
 *
 * Everything runs against a FIXTURE home and a fixture git repository under the
 * OS temp dir. The real ~/.claude.json, ~/.gemini and Claude Desktop's config
 * are never opened: `home` is a parameter of every collector, and §0 asserts
 * the fixture paths are the only ones in the results.
 *
 * What it exists to stop:
 *   §1 a JSONC reader that eats a `//` inside a string, or refuses a trailing comma.
 *   §2 the two false negatives measured on the maintainer's Mac, 2026-09-26:
 *      Claude Code's entry under `projects["<repo>"]` in ~/.claude.json, and
 *      Claude Code configured ONLY through Claude Desktop's config; and
 *      opencode's `opencode.jsonc`.
 *   §3 Antigravity configured in some of its files and not others read as fine.
 *   §4 skills: a stale copy read as current; Claude's account-held skills read
 *      as "missing" instead of "can't check here".
 *   §5 hooks: a hook file the tool does not load (Antigravity's user file,
 *      observed 2026-09-26) read as wired.
 *   §6 PRIVACY: another server's name or `env` value in any result.
 *   §7 the instruction block: current / outdated / wrong project / absent / cap.
 *   §8 the marker, through real git: untracked, committed.
 *   §9 the project view: evidence overriding an absent config entry, a save
 *      under another tool's scope flagged, a session-named scope NOT flagged,
 *      a handoff waiting on GitHub named by machine.
 *  §10 a READ that writes: every fixture file's bytes and mtime are compared.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

const S = await import('../src/brain/setup-check.js');
const { TEMPLATE } = await import('../src/public/next/shared/agent-instructions.js');

// ── Fixture ────────────────────────────────────────────────────────────────
const ROOT = mkdtempSync(path.join(os.tmpdir(), 'curator-setup-'));
const HOME = path.join(ROOT, 'home');
const HOME2 = path.join(ROOT, 'home2');
const REPO = path.join(ROOT, 'ott');
const DOMAINS = path.join(ROOT, 'domains');
const SECRET = 'sk-FAKE-planted-9f8e7d6c5b4a';
const OTHER = 'zz-other-server-name';
for (const d of [HOME, HOME2, REPO, DOMAINS]) mkdirSync(d, { recursive: true });
const w = (f, text) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
const other = { [OTHER]: { command: '/usr/bin/other', env: { API_KEY: SECRET } } };
const ours = { command: '/bin/sh', args: ['/x/mcp/server.js', '--domains-path', DOMAINS] };

// Claude Code: top level has only OTHER; our entry is under projects[REPO].
w(path.join(HOME, '.claude.json'), JSON.stringify({ mcpServers: other, projects: { [REPO]: { mcpServers: { 'my-curator': ours, ...other } } } }));
// Antigravity: named in one file, present-but-not-named in another.
w(path.join(HOME, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'my-curator': ours, ...other } }));
w(path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'), JSON.stringify({ mcpServers: other }));
// Antigravity hooks: ONLY the user file (observed not loaded).
w(path.join(HOME, '.gemini', 'config', 'hooks.json'), JSON.stringify({ 'my-curator': { PreInvocation: [{ type: 'command', command: '/usr/local/bin/my-curator hook session-start --harness antigravity' }] }, zzz: { Stop: [{ command: `echo ${SECRET}` }] } }));
// opencode: JSONC with comments, a URL in a string, a trailing comma.
w(path.join(HOME, '.config', 'opencode', 'opencode.jsonc'), `{
  // my servers
  "$schema": "https://opencode.ai/config.json", /* block */
  "mcp": {
    "my-curator": { "type": "local", "command": ["/bin/sh", "/x/mcp/server.js", "--domains-path", "${DOMAINS}"], },
    "${OTHER}": { "type": "local", "command": ["x"], "environment": { "K": "${SECRET}" } },
  },
}
`);
// Skills: Antigravity plugin install — curator-continuity exact, my-curator stale.
const pluginSkills = path.join(HOME, '.gemini', 'config', 'plugins', 'the-curator', 'skills');
cpSync(path.join(REPO_ROOT, 'skills', 'curator-continuity'), path.join(pluginSkills, 'curator-continuity'), { recursive: true });
cpSync(path.join(REPO_ROOT, 'skills', 'my-curator'), path.join(pluginSkills, 'my-curator'), { recursive: true });
writeFileSync(path.join(pluginSkills, 'my-curator', 'SKILL.md'), `${readFileSync(path.join(pluginSkills, 'my-curator', 'SKILL.md'), 'utf8')}\nold line\n`);
// HOME2: Claude Code only via Claude Desktop's config (the maintainer's case).
w(path.join(HOME2, '.claude.json'), JSON.stringify({ mcpServers: {} }));
w(path.join(HOME2, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { 'my-curator': ours, ...other } }));

// The repo: git, CLAUDE.md with the current block, AGENTS.md without one.
const block = (dp, p) => TEMPLATE.split('{{DOMAIN_PROJECT}}').join(dp).split('{{PROJECT}}').join(p);
const git = (...args) => execFileSync('git', args, { cwd: REPO, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
git('init', '-q');
w(path.join(REPO, 'CLAUDE.md'), `# ott\n\n## Working state\n\n${block('projects/ott', 'ott')}\n## More\n`);
w(path.join(REPO, 'AGENTS.md'), '# ott agents\n\nNo Curator block here.\n');
git('add', 'CLAUDE.md', 'AGENTS.md');
git('commit', '-q', '-m', 'init');
w(path.join(REPO, '.curator-project'), 'projects/ott\n');

// ── The census taken BEFORE any collector runs (§10) ──────────────────────
function census(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== '.git') walk(f); continue; }
      const st = statSync(f);
      out[f] = `${createHash('sha256').update(readFileSync(f)).digest('hex')}:${st.mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}
const before = census(ROOT);

const skillsDir = path.join(REPO_ROOT, 'skills');
const machine = S.collectMachineSetup({ home: HOME, repo: REPO, skillsDir, domainsDir: DOMAINS });
const row = (rows, id) => rows.find((r) => r.id === id);

section('§0  the fixture is the only thing read');
{
  const all = JSON.stringify(machine);
  const files = [...all.matchAll(/"file":"([^"]+)"/g)].map((m) => m[1]);
  ok(files.length > 0 && files.every((f) => f.startsWith(ROOT)), 'every file in the result is under the fixture root', files.filter((f) => !f.startsWith(ROOT)));
}

section('§1  JSONC');
{
  const t = S.stripJsonComments('{"u":"https://a//b", /* c */ "x":[1,2,], // tail\n}');
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  ok(j && j.u === 'https://a//b' && j.x.length === 2, 'a // inside a string survives; comments and trailing commas go', t);
  const r = S.readJsonFile(path.join(HOME, '.config', 'opencode', 'opencode.jsonc'));
  ok(r.present && r.jsonc === true && r.json?.mcp?.['my-curator'], 'opencode.jsonc is read, flagged jsonc');
}

section('§2  the measured false negatives');
{
  const cc = row(machine, 'claude-code');
  ok(cc.bridge.state === 'ok', 'Claude Code: an entry under projects["<repo>"] in ~/.claude.json counts as configured', cc.bridge);
  const f = cc.files.find((x) => x.file.endsWith('.claude.json'));
  ok(f && f.named && f.at === 'project', '…and the file record says it was found at project scope', f);
  const m2 = S.collectMachineSetup({ home: HOME2, repo: REPO, skillsDir, domainsDir: DOMAINS });
  const cc2 = row(m2, 'claude-code');
  ok(cc2.bridge.state === 'ok' && cc2.bridge.via === 'readAlso', 'Claude Code configured ONLY in Claude Desktop\'s config reads as configured, via that file', cc2.bridge);
  ok(/Observed 2026-09-26/.test(cc2.bridge.observation || '') && /2026-09-26/.test(cc2.bridge.note || ''), '…with the dated observation carried verbatim (and a short, dated note for the cell)');
  // A readAlso entry whose launch file is gone is "to fix", not "configured".
  const HOME3 = path.join(ROOT, 'home3');
  w(path.join(HOME3, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    JSON.stringify({ mcpServers: { 'my-curator': { command: path.join(ROOT, 'no-such-launcher'), args: [] } } }));
  const cc3 = row(S.collectMachineSetup({ home: HOME3, repo: REPO, skillsDir, domainsDir: DOMAINS }), 'claude-code');
  ok(cc3.bridge.state === 'fix' && /missing file/.test(cc3.bridge.word), 'a Claude Desktop entry pointing at a missing launcher is to fix for Claude Code too', cc3.bridge);
  const noRepo = S.collectMachineSetup({ home: HOME, repo: '', skillsDir, domainsDir: DOMAINS });
  ok(row(noRepo, 'claude-code').bridge.state !== 'ok', 'control: without the repo path the projects[] entry is not found (nothing else configures it)', row(noRepo, 'claude-code').bridge);
  const oc = row(machine, 'opencode');
  ok(oc.bridge.state === 'ok', 'opencode: configured in opencode.jsonc (command as one array)', oc.bridge);
}

section('§3  Antigravity, three files');
{
  const ag = row(machine, 'antigravity');
  ok(ag.bridge.state === 'fix' && /not in 1 of 2 files/.test(ag.bridge.word), 'named in one present file, absent from another → to fix, counted', ag.bridge);
}

section('§4  skills');
{
  const ag = row(machine, 'antigravity');
  ok(ag.skills.state === 'fix' && /my-curator outdated/.test(ag.skills.word), 'a stale my-curator is outdated, by hash', ag.skills);
  const cc = row(machine, 'claude-code');
  ok(cc.skills.state === 'cant-check' && /Claude account/.test(cc.skills.note || ''), 'Claude Code with no local skills: can\'t check here (account-held), never "missing"', cc.skills);
  const noCopy = S.collectMachineSetup({ home: HOME, repo: REPO, skillsDir: path.join(ROOT, 'nope'), domainsDir: DOMAINS });
  ok(row(noCopy, 'antigravity').skills.state === 'cant-check', 'an app with no skills/ to compare with says so rather than calling copies stale');
}

section('§5  hooks');
{
  const ag = row(machine, 'antigravity');
  // Not "to fix": the observation (2026-09-26) shows the user-file hook RAN
  // and its injection was not seen used — not that the file is ignored.
  ok(ag.hooks.state === 'unmeasured' && /user file only · not seen working/.test(ag.hooks.word) && ag.hooks.suggestScope === 'project',
    'hooks only in ~/.gemini/config/hooks.json: "wired in the user file only · not seen working", suggesting project scope — never "to fix"', ag.hooks);
  ok(ag.hooks.files.some((f) => f.observation && /2026-09-26/.test(f.observation)), '…the file carries the dated observation, verbatim');
  w(path.join(REPO, '.agents', 'hooks.json'), JSON.stringify({ 'my-curator': { PreInvocation: [{ command: '/usr/local/bin/my-curator hook session-start --harness antigravity' }] } }));
  const m3 = S.collectMachineSetup({ home: HOME, repo: REPO, skillsDir, domainsDir: DOMAINS });
  ok(row(m3, 'antigravity').hooks.state === 'unmeasured' && row(m3, 'antigravity').hooks.word === 'wired · unmeasured', 'with <repo>/.agents/hooks.json: wired · unmeasured (no suggestion)', row(m3, 'antigravity').hooks);
  rmSync(path.join(REPO, '.agents'), { recursive: true, force: true });
}

section('§6  privacy');
{
  const all = JSON.stringify(machine) + JSON.stringify(S.collectMachineSetup({ home: HOME2, repo: REPO, skillsDir }));
  ok(!all.includes(SECRET), 'no planted env value anywhere in the result');
  ok(!all.includes(OTHER), 'no other server\'s name anywhere in the result');
  ok(!all.includes('/usr/bin/other'), 'no other server\'s command');
  // The INSPECTOR itself, not only the collector that picks fields from it:
  // doctor spreads an inspector's result into its --json report.
  const direct = S.harnessTargets({ home: HOME, project: REPO })
    .flatMap((t) => [...t.mcp, ...t.mcpAlso].map((m) => S.inspectMcpFile(m, { projectsKey: t.projectsKey, repo: REPO })));
  const hooksDirect = [S.inspectHookFile('antigravity', path.join(HOME, '.gemini', 'config', 'hooks.json'))];
  const d = JSON.stringify(direct) + JSON.stringify(hooksDirect);
  ok(direct.length > 5 && !d.includes(SECRET) && !d.includes(OTHER), 'inspectMcpFile / inspectHookFile results carry no planted value or other name', d.slice(0, 300));
}

section('§7  the instruction block');
{
  const opts = { domain: 'projects', project: 'ott', template: TEMPLATE };
  const cur = S.inspectInstructionFile(path.join(REPO, 'CLAUDE.md'), opts);
  ok(cur.hasBlock && cur.current && cur.atTop && !cur.wrongProject, 'CLAUDE.md: current, at the top, this project', cur);
  const none = S.inspectInstructionFile(path.join(REPO, 'AGENTS.md'), opts);
  ok(none.present && !none.hasBlock, 'AGENTS.md: present, no block');
  const old = path.join(ROOT, 'old.md');
  w(old, block('projects/ott', 'ott').replace('call `get_project_context` again before acting', 'call it again'));
  ok(S.inspectInstructionFile(old, opts).hasBlock && !S.inspectInstructionFile(old, opts).current, 'a block one sentence off the current text is outdated');
  const wrong = path.join(ROOT, 'wrong.md');
  w(wrong, block('projects/curator', 'curator'));
  const wr = S.inspectInstructionFile(wrong, opts);
  ok(wr.wrongProject && wr.namesProject === 'projects/curator', 'a block for another project is named as such', wr);
  const deep = path.join(ROOT, 'deep.md');
  w(deep, `${'x'.repeat(30000)}\n${block('projects/ott', 'ott')}`);
  const dp = S.inspectInstructionFile(deep, { ...opts, cap: 24000 });
  ok(!dp.atTop && dp.overCap && dp.blockPastCap, 'a block 30 KB down a 24,000-byte-capped file: not at the top, past the cap', dp);
  // ── RE-WRAPPED IS CURRENT; DIFFERENT WORDS ARE NOT (v3.77.0 screen review) ──
  // The owner's paste or editor re-wraps the block. Every word identical,
  // the lines broken elsewhere: current. The orchestrator measured this on the
  // real ott-framework repo — exact substring false, whitespace-normalised true.
  const curBlock = block('projects/ott', 'ott');
  const reflow = (s, width) => {
    const words = s.split(/\s+/).filter(Boolean);
    const out = []; let line = '';
    for (const w of words) { if (line && (line + ' ' + w).length > width) { out.push(line); line = w; } else line = line ? line + ' ' + w : w; }
    if (line) out.push(line);
    return out.join('\n');
  };
  const wrapped = path.join(ROOT, 'wrapped.md');
  w(wrapped, `# ott\n\n## Working state\n\n${reflow(curBlock, 62)}\n\n  More text.\n`);
  const wr2 = S.inspectInstructionFile(wrapped, opts);
  ok(!readFileSync(wrapped, 'utf8').includes(curBlock.trimEnd()) && wr2.hasBlock && wr2.current && wr2.atTop,
    'the current block RE-WRAPPED at 62 columns (no exact substring) is current, at the top', wr2);
  const wrappedTab = path.join(ROOT, 'wrapped-tab.md');
  w(wrappedTab, reflow(curBlock, 100).replace(/ /g, (m, i) => (i % 7 === 0 ? '\t' : m)));
  ok(S.inspectInstructionFile(wrappedTab, opts).current, '…and with tabs and wider lines too');
  const oneWord = path.join(ROOT, 'one-word.md');
  w(oneWord, reflow(curBlock.replace('at least every ten tool calls', 'at least every twenty tool calls'), 62));
  const ow = S.inspectInstructionFile(oneWord, opts);
  ok(ow.hasBlock && !ow.current, 'a re-wrapped block that differs in ONE word is not current', ow);
  // The REAL older texts, verbatim from the tags (projects/ott substituted).
  const V372 = [
    "This repository's working state lives in The Curator (project `projects/ott`, see",
    '`.curator-project`). At the START of every session call the my-curator MCP tool',
    '`get_working_state` with project "ott" and scope "latest" and read the standing',
    'brief before acting. SAVE with `save_working_state` under project "ott", scope',
    '"main", after every material decision and at least every ten tool calls, and ALWAYS',
    'before you stop; a save overwrites, so send the complete state each time.',
  ].join('\n');
  const V376 = [
    "This repository's working state lives in The Curator (project `projects/ott`, see",
    '`.curator-project`). At the START of every session call the my-curator MCP tool',
    '`get_project_context` with project "ott" and read the standing brief and latest',
    'handoff before acting. SAVE with `save_working_state` under project "ott" with the',
    '`scope` argument set to your tool\'s name — "claude-code" if you are Claude Code,',
    '"antigravity" if you are Antigravity, "opencode" if you are opencode, otherwise your',
    'tool\'s own name, lowercase and hyphenated. Pass `scope` explicitly every time, and never',
    'save under another tool\'s scope. Save after every material',
    'decision, at least every ten tool calls, and ALWAYS before you stop; a save overwrites,',
    'so send the complete state each time. Pass `harness` as that same name and `model` as',
    'your exact model id if you know it (omit it otherwise — never search files for it), and',
    'record the `seen` map as `foundations_read`.',
  ].join('\n');
  for (const [name, text] of [['v3.72/v3.74 (scope "main", get_working_state)', V372], ['v3.76.0 (no "continue" sentence)', V376]]) {
    const f = path.join(ROOT, `old-${name.slice(0, 5)}.md`);
    w(f, `## Working state\n\n${text}\n`);
    const r = S.inspectInstructionFile(f, opts);
    ok(r.hasBlock && !r.current && !r.wrongProject && r.namesProject === 'projects/ott', `the real ${name} block: present, this project, OUTDATED`, r);
    const f2 = path.join(ROOT, `old-${name.slice(0, 5)}-wrapped.md`);
    w(f2, reflow(text, 70));
    ok(S.inspectInstructionFile(f2, opts).hasBlock && !S.inspectInstructionFile(f2, opts).current, `…and still OUTDATED when re-wrapped`);
  }
  const crlf = path.join(ROOT, 'crlf.md');
  w(crlf, block('projects/ott', 'ott').replace(/\n/g, '\r\n'));
  ok(S.inspectInstructionFile(crlf, opts).current, 'CRLF line endings still read as current');
}

section('§8  the marker, through git');
{
  const m = await S.inspectMarker(REPO, { domain: 'projects', project: 'ott' });
  ok(m.present && m.namesThis && m.git.repo && m.git.tracked === false && m.git.uncommitted === true, 'untracked marker: present, names this project, NOT tracked', m);
  git('add', '.curator-project'); git('commit', '-q', '-m', 'marker');
  const m2 = await S.inspectMarker(REPO, { domain: 'projects', project: 'ott' });
  ok(m2.git.tracked === true && m2.git.uncommitted === false, 'after a commit: tracked, clean', m2.git);
  ok(m2.git.upstream === null && m2.git.unpushed === null, 'no upstream: "pushed" is not claimed either way', m2.git);
  const other2 = await S.inspectMarker(REPO, { domain: 'projects', project: 'curator' });
  ok(other2.present && !other2.namesThis, 'the same marker read for another project does not name it');
  const plain = await S.inspectMarker(ROOT, { domain: 'projects', project: 'ott' });
  ok(plain.present === false && plain.git.repo === false, 'a folder outside git: no marker, not a repository');
}

section('§9  the project view');
{
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const pairs = [
    { scope: 'claude-code', machine: 'mac-a-111111', harness: 'Claude Code', writtenAt: iso(40 * 60e3) },
    { scope: 'main', machine: 'mac-b-222222', harness: 'Antigravity', writtenAt: iso(2 * 3600e3), curator: '3.76.0' },
    { scope: 'session-2026-09-26-ux', machine: 'mac-a-111111', harness: 'OpenCode', writtenAt: iso(3 * 3600e3) },
  ];
  // A machine view where Claude Code has NO config entry at all.
  const emptyHome = path.join(ROOT, 'emptyhome');
  mkdirSync(emptyHome, { recursive: true });
  const bare = S.collectMachineSetup({ home: emptyHome, repo: REPO, skillsDir, domainsDir: DOMAINS });
  const marker = await S.inspectMarker(REPO, { domain: 'projects', project: 'ott' });
  const r = S.collectProjectSetup({
    domain: 'projects', project: 'ott', pairs, machine: { ids: ['mac-a-111111'] },
    machineRows: bare, repo: { path: REPO, source: 'set' }, marker, template: TEMPLATE,
    sync: { incoming: ['projects/state/ott/antigravity/mac-b-222222/current.md', 'projects/wiki/x.md', 'other/state/ott/x/mac-c/current.md'] },
  });
  const cc = r.tools.find((t) => t.id === 'claude-code');
  ok(cc && cc.bridge.state === 'ok' && cc.bridge.word === 'working', 'Claude Code with no entry found but a save from THIS machine reads "working" — evidence first', cc?.bridge);
  const ag = r.tools.find((t) => t.id === 'antigravity');
  ok(ag && ag.saved.state === 'fix' && ag.saved.wrongScope, 'Antigravity\'s newest save under "main" is flagged', ag?.saved);
  ok(r.toFix.some((f) => f.kind === 'wrong-scope' && f.tool === 'antigravity'), '…and it is a to-fix line');
  const oc = r.tools.find((t) => t.id === 'opencode');
  ok(oc && oc.saved.state === 'ok', 'a session-named scope (the standing brief\'s own rule) is NOT flagged', oc?.saved);
  ok(ag.block.state === 'fix' && ag.block.word === 'missing', 'Antigravity reads AGENTS.md/GEMINI.md: the block is missing for it', ag.block);
  ok(cc.block.state === 'ok', 'Claude Code reads CLAUDE.md: current', cc.block);
  ok(r.toFix.some((f) => f.kind === 'block-missing' && f.file === 'AGENTS.md'), 'the fix names AGENTS.md');
  const b = r.computers.find((c) => c.machine === 'mac-b-222222');
  ok(b && b.waiting === 1 && b.curator === '3.76.0', 'the other computer: one handoff waiting on GitHub, its Curator version from its newest save', b);
  ok(r.toFix.some((f) => f.kind === 'sync-incoming'), 'a waiting handoff is a to-fix line (sync before starting)');
  ok(r.computers[0].thisMachine === true, 'this computer is listed first');
  ok(!r.toFix.some((f) => f.kind.startsWith('marker')), 'a committed marker naming this project raises nothing');
  const noRepo = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs, machine: { ids: [] }, machineRows: bare, repo: null, template: TEMPLATE });
  ok(noRepo.tools.every((t) => t.block.state === 'not-checked' || t.block.state === 'none'), 'no repository set: every block cell is "not checked", nothing red', noRepo.tools.map((t) => t.block));
  const gone = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs, machine: { ids: [] }, machineRows: bare,
    repo: { path: path.join(ROOT, 'not-here'), source: 'set', exists: false }, template: TEMPLATE });
  ok(gone.toFix.some((f) => f.kind === 'repo-missing' && f.fix.kind === 'change-repo'), 'a folder set but not on this computer is a to-fix line (its checks did not run)');
  ok(S.incomingMachine('projects/state/foundations/x/y/z.md', 'projects', 'projects') === null, 'foundations are never read as a machine');
  ok(S.incomingMachine('projects/state/main/mac-a/current.md', 'projects', 'projects') === 'mac-a', 'the domain\'s own project: <scope>/<machine>');
}

section('§10 a read writes nothing');
{
  const after = census(ROOT);
  // §5 created and removed .agents/, and §7/§9 created fixture files on purpose;
  // every file that existed BEFORE the collectors ran must be byte- and
  // mtime-identical, git's own directory excepted (the §8 commits).
  const changed = Object.keys(before).filter((f) => after[f] !== before[f] && !f.startsWith(path.join(REPO, '.curator-project')));
  ok(changed.length === 0, 'no pre-existing fixture file was modified by a collector', changed);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failed ? '✗' : '✓'} test-setup-check: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
