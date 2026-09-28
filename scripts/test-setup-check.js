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
 *
 * v3.78.0:
 *  §11 an empty / invalid / unopenable config file turning a WORKING tool red
 *      (measured 2026-09-28), or read as absent (EACCES); alone, it is a
 *      to-fix line naming the file with a reveal.
 *  §12 one Mac with a Mac app, a source checkout and a hostname alias shown as
 *      three computers — it is one computer, two installs, three names.
 *  §13 a repository candidate offered whose marker names another project, or
 *      that is outside home or not here.
 *  §14 DeepSeek Harness read from `cordis.yml` (rewritten on every launch) or
 *      a commented line counted; other entries leaking from the line-scan.
 *
 * v3.80.0:
 *  §17 Remove offered on a row it would not take away (a tool that SAVED, or
 *      one whose MCP settings here name us), a guide pointed at a config file
 *      that is not there as if it were, or a reveal path for a missing file.
 *  §15 a tool called ready without a save from here; a custom tool's
 *      assumed AGENTS.md raised as a to-fix line.
 *
 * v3.79.0:
 *  §16 the block-cap line firing on a long file whose block is at the top; a
 *      wrong-name save shown twice, or with a copy button when the
 *      instructions are already current; a to-fix button with no label; the
 *      marker commands not pushing; sync-incoming not naming the computer;
 *      travels and per-computer saves missing.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
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
  // v3.79.0: its block is MISSING, so the wrong save joins the block line
  // (which carries the fix) instead of a second line saying the same thing.
  ok(!r.toFix.some((f) => f.kind === 'wrong-scope' && f.tool === 'antigravity')
    && /That is why its (\d{1,2} [A-Z][a-z]{2}|last) save went under “main”\./.test(r.toFix.find((f) => f.kind === 'block-missing' && f.tool === 'antigravity')?.detail || ''),
    '…and the block line explains it (no separate wrong-name line)', r.toFix.filter((f) => f.tool === 'antigravity'));
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

section('§11 config file states (v3.78.0): empty, invalid, unopenable');
{
  const agWorking = { mcpServers: { 'my-curator': ours, ...other } };
  // (a) The measured case, 2026-09-28: an EMPTY antigravity/mcp_config.json
  // beside a WORKING config/mcp_config.json. The tool stays ok; the empty
  // file is a note, never a to-fix.
  const HA = path.join(ROOT, 'st-a');
  w(path.join(HA, '.gemini', 'config', 'mcp_config.json'), JSON.stringify(agWorking));
  w(path.join(HA, '.gemini', 'antigravity', 'mcp_config.json'), '');
  const a = row(S.collectMachineSetup({ home: HA, repo: '', skillsDir, domainsDir: DOMAINS }), 'antigravity');
  const emptyRec = a.files.find((f) => f.file.endsWith(path.join('antigravity', 'mcp_config.json')));
  ok(emptyRec && emptyRec.status === 'empty' && emptyRec.display === '~/.gemini/antigravity/mcp_config.json', 'the empty file reads status "empty", with a ~ display path', emptyRec);
  ok(a.bridge.state === 'ok', 'an empty file BESIDE a working file: the tool stays ok', a.bridge);
  ok((a.bridge.fileNotes || []).some((n) => n.status === 'empty' && /is empty/.test(n.text) && /another file names my-curator/.test(n.text)), '…and the empty file is carried as a note', a.bridge.fileNotes);
  const pa = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs: [], machine: { ids: [] }, machineRows: [a], repo: null, template: TEMPLATE, addedTools: ['antigravity'] });
  ok(!pa.toFix.some((f) => f.tool === 'antigravity' && /bridge/.test(f.kind)), '…so the project view raises no bridge to-fix for it', pa.toFix);
  const agRow = pa.tools.find((t) => t.id === 'antigravity');
  ok(agRow.evidence.some((e) => e.heading === 'MCP bridge' && e.lines.some((l) => /antigravity\/mcp_config\.json: is empty/.test(l))), 'the reader\'s evidence names the empty file', agRow.evidence);

  // (b) The same empty file ALONE: to fix, naming the file, with a reveal.
  const HB = path.join(ROOT, 'st-b');
  w(path.join(HB, '.gemini', 'antigravity', 'mcp_config.json'), '  \n');
  const b = row(S.collectMachineSetup({ home: HB, repo: '', skillsDir, domainsDir: DOMAINS }), 'antigravity');
  ok(b.bridge.state === 'fix' && b.bridge.badFile?.status === 'empty', 'an empty (whitespace-only) file alone: to fix', b.bridge);
  const pb = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs: [], machine: { ids: [] }, machineRows: [b], repo: null, template: TEMPLATE, addedTools: ['antigravity'] });
  const fb = pb.toFix.find((f) => f.tool === 'antigravity' && f.kind === 'bridge-file');
  const emptyFile = path.join(HB, '.gemini', 'antigravity', 'mcp_config.json');
  ok(fb && fb.text === 'Antigravity’s MCP settings file (~/.gemini/antigravity/mcp_config.json) is empty, so Antigravity can’t reach The Curator on this Mac.', 'the to-fix text names the file (v3.79.0 wording)', fb);
  ok(fb && /^Open Antigravity once \(it fills the file\), then Re-check\./.test(fb.detail) && /reveal it and fix or delete it/.test(fb.detail), '…the detail says what to do', fb?.detail);
  ok(fb && fb.fix.kind === 'reveal' && fb.fix.path === emptyFile && fb.fix.label === 'Reveal mcp_config.json', '…and the fix reveals that exact file', fb?.fix);
  ok(fb && fb.fixes.map((x) => x.kind).join() === 'reveal,recheck,settings' && fb.fixes.every((x) => x.label), '…then Re-check and Tools on this Mac, each labelled', fb?.fixes);
  ok(pb.tools.find((t) => t.id === 'antigravity').status === 'to-fix', 'the tool\'s one word is "to-fix"');

  // (c) invalid JSON alone: to fix; beside a working file: a note.
  const HC = path.join(ROOT, 'st-c');
  w(path.join(HC, '.gemini', 'antigravity', 'mcp_config.json'), '{ "mcpServers": ');
  const c = row(S.collectMachineSetup({ home: HC, repo: '', skillsDir, domainsDir: DOMAINS }), 'antigravity');
  ok(c.bridge.state === 'fix' && c.bridge.badFile?.status === 'invalid' && /not valid JSON/.test(c.bridge.word), 'invalid JSON alone: to fix, "not valid JSON"', c.bridge);
  w(path.join(HC, '.gemini', 'config', 'mcp_config.json'), JSON.stringify(agWorking));
  const c2 = row(S.collectMachineSetup({ home: HC, repo: '', skillsDir, domainsDir: DOMAINS }), 'antigravity');
  ok(c2.bridge.state === 'ok' && c2.bridge.fileNotes?.[0]?.status === 'invalid', 'invalid JSON beside a working file: ok, with a note', c2.bridge);

  // (d) EACCES: surfaced as "unopenable" — it used to read as absent.
  const HD = path.join(ROOT, 'st-d');
  const locked = path.join(HD, '.gemini', 'antigravity', 'mcp_config.json');
  w(locked, JSON.stringify(agWorking));
  chmodSync(locked, 0o000);
  let canRead = true;
  try { readFileSync(locked); } catch { canRead = false; }
  if (!canRead) {
    const r = S.readJsonFile(locked);
    ok(r.present === true && r.status === 'unopenable' && /EACCES|EPERM/.test(r.readError || ''), 'readJsonFile: an EACCES file is present and "unopenable", not absent', r);
    const d = row(S.collectMachineSetup({ home: HD, repo: '', skillsDir, domainsDir: DOMAINS }), 'antigravity');
    ok(d.bridge.state === 'fix' && d.bridge.badFile?.status === 'unopenable' && /could not be opened/.test(d.bridge.word), 'the only file that could carry the entry is unopenable: to fix', d.bridge);
    const pd = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs: [], machine: { ids: [] }, machineRows: [d], repo: null, template: TEMPLATE, addedTools: ['antigravity'] });
    const fd = pd.toFix.find((f) => f.kind === 'bridge-file');
    ok(fd && fd.fix.path === locked && /permission/i.test(fd.detail), '…a to-fix line with a reveal and a permissions hint', fd);
  } else {
    ok(true, 'running as a user who can read a 0000 file (root) — the EACCES arm cannot be staged here');
  }
  chmodSync(locked, 0o600);
  const all = JSON.stringify(S.collectMachineSetup({ home: HC, repo: '', skillsDir, domainsDir: DOMAINS }));
  ok(!all.includes(SECRET) && !all.includes(OTHER), 'privacy holds on every new state (no planted value, no other server name)');
}

section('§12 computers grouped by installation (v3.78.0)');
{
  // The maintainer's MacBook: a Mac app (acb035), a source checkout (17d23c),
  // and that checkout's pre-D10 hostname alias (mac-17d23c). One computer,
  // two installs, three names. And one other computer.
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60e3).toISOString();
  const pairs = [
    { scope: 'claude-code', machine: 'talis-macbook-pro-acb035', harness: 'Claude Code', writtenAt: iso(10), curator: '3.78.0' },
    { scope: 'antigravity', machine: 'talis-macbook-pro-17d23c', harness: 'Antigravity', writtenAt: iso(20) },
    { scope: 'antigravity', machine: 'mac-17d23c', harness: 'Antigravity', writtenAt: iso(600) },
    { scope: 'antigravity', machine: 'talis-mac-mini-9e9e9e', harness: 'Antigravity', writtenAt: iso(30) },
  ];
  const machine = { ids: ['talis-macbook-pro-acb035', 'talis-macbook-pro-17d23c'], installIds: ['acb035', '17d23c'], installs: [{ installId: 'acb035', kind: 'app' }, { installId: '17d23c', kind: 'source' }] };
  const r = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs, machine, machineRows: [], repo: null, template: TEMPLATE, sync: { configured: true } });
  ok(r.counts.computers === 2 && r.counts.installs === 3 && r.counts.machineNames === 4, '3 local names + 1 remote: 2 computers, 3 installs, 4 names', r.counts);
  const here = r.physical.find((p) => p.thisComputer);
  ok(here && here.installs.length === 2, 'this Mac is ONE physical group holding both installs', r.physical);
  const src = r.computers.find((c) => c.key === 'install:17d23c');
  ok(src && src.names.length === 2 && src.primary === 'talis-macbook-pro-17d23c' && src.aliases[0] === 'mac-17d23c', 'the alias joins its install\'s row; the newest-saved name is primary', src);
  ok(src.thisComputer === true && src.installKind === 'source', '…this computer, a source install', src);
  const app = r.computers.find((c) => c.key === 'install:acb035');
  ok(app && app.thisComputer && app.installKind === 'app' && app.curatorVersion === '3.78.0' && app.sync?.configured === true, 'the app install: this computer, kind app, its version, and the sync facts (this computer only)', app);
  const mini = r.computers.find((c) => c.key === 'install:9e9e9e');
  ok(mini && !mini.thisComputer && !mini.sync, 'the other computer carries no sync facts', mini);
  ok(r.tools.find((t) => t.id === 'antigravity').saved.thisMachine === true, 'Antigravity\'s newest save (the source install\'s) is this computer\'s');
  const r3 = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs: pairs.slice(2), machine, machineRows: [], repo: null, template: TEMPLATE });
  ok(r3.tools.find((t) => t.id === 'antigravity').saved.thisMachine === false, 'with only the alias and the mini, the newest is the mini\'s — not this computer (control)');
  // Only the exact ids (the v3.77.0 input): the alias still matches by install id.
  const r2 = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs: pairs.slice(0, 3), machine: { ids: ['talis-macbook-pro-17d23c'] }, machineRows: [], repo: null, template: TEMPLATE });
  ok(r2.computers.find((c) => c.key === 'install:17d23c')?.thisComputer === true && r2.computers.find((c) => c.key === 'install:acb035')?.thisComputer === false,
    'given only one machine id, its alias matches by install id and the other install does not');
  // v3.79.0 — an EXACT tie (two saves stamped in the same millisecond): the
  // name that is this Mac's current machine id is primary, in either input
  // order; with no current id, lexical order — never the input order.
  {
    const at = '2026-09-28T12:00:00.000Z';
    const a = { scope: 'antigravity', machine: 'mac-17d23c', harness: 'Antigravity', writtenAt: at };
    const b = { scope: 'antigravity', machine: 'talis-macbook-pro-17d23c', harness: 'Antigravity', writtenAt: at };
    const opts = { domain: 'projects', project: 'ott', isHere: () => true, currentIds: ['talis-macbook-pro-17d23c'] };
    const p1 = S.groupComputers([a, b], opts).rows[0];
    const p2 = S.groupComputers([b, a], opts).rows[0];
    ok(p1.primary === 'talis-macbook-pro-17d23c' && p2.primary === 'talis-macbook-pro-17d23c' && p1.aliases.join() === 'mac-17d23c',
      'an exact same-millisecond tie: the current machine id is primary, whatever the input order', { p1: p1.names, p2: p2.names });
    const n1 = S.groupComputers([b, a], { ...opts, currentIds: [] }).rows[0];
    const n2 = S.groupComputers([a, b], { ...opts, currentIds: [] }).rows[0];
    ok(n1.primary === n2.primary && n1.primary === 'mac-17d23c', '…with no current id known, lexical order — the same in either input order (control)', { n1: n1.names, n2: n2.names });
    const viaProject = S.collectProjectSetup({ domain: 'projects', project: 'ott', pairs: [a, b], machine: { ids: ['talis-macbook-pro-17d23c'] }, machineRows: [], repo: null, template: TEMPLATE });
    ok(viaProject.computers[0].primary === 'talis-macbook-pro-17d23c', '…and collectProjectSetup passes this Mac\'s machine ids through', viaProject.computers[0].names);
  }
  // A bare hostname (no install id) never matches by installation.
  const g = S.groupComputers([{ machine: 'mac', harness: 'x', writtenAt: iso(1) }, { machine: 'mac-pro', harness: 'x', writtenAt: iso(1) }], { domain: 'projects', project: 'ott', isHere: () => false });
  ok(g.rows.length === 2 && g.rows.every((x) => x.names.length === 1), 'names with no install id are one row each — never merged by hostname');
}

section('§13 repository candidates (v3.78.0)');
{
  const HOMEC = path.join(ROOT, 'cand-home');
  const good = path.join(HOMEC, 'code', 'ott');
  const otherProj = path.join(HOMEC, 'code', 'someone-else');
  const bare = path.join(HOMEC, 'code', 'ott-clone');
  const outside = path.join(ROOT, 'outside-home');
  w(path.join(good, '.curator-project'), 'projects/ott\n');
  w(path.join(otherProj, '.curator-project'), 'projects/zzz\n');
  w(path.join(bare, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/OTT.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  w(path.join(outside, '.curator-project'), 'projects/ott\n');
  const sources = [
    { path: otherProj, why: 'claude-code' }, { path: good, why: 'claude-code' }, { path: bare, why: 'claude-code' },
    { path: outside, why: 'claude-code' }, { path: path.join(HOMEC, 'gone'), why: 'hook-log' }, { path: good, why: 'hook-log' },
  ];
  const c = S.findRepoCandidates({ home: HOMEC, domain: 'projects', project: 'ott', sources, githubRepos: ['acme/ott'] });
  ok(c.length === 2 && c[0].path === good && c[0].why === 'claude-code' && c[0].display === '~/code/ott', 'the folder whose marker names this project is offered, once, with its source', c);
  ok(c[1] && c[1].path === bare && c[1].why === 'git-remote' && /GitHub repository/.test(c[1].whyText), 'a marker-less folder whose origin is the mirrored repository is offered as git-remote', c[1]);
  const s = JSON.stringify(c);
  ok(!s.includes('someone-else') && !s.includes('outside-home') && !s.includes('gone'), 'a folder naming ANOTHER project, one outside home, and one that is not here never leave');
  ok(S.findRepoCandidates({ home: HOMEC, domain: 'projects', project: 'ott', sources, githubRepos: [] }).length === 1, 'no mirrored repository: no git-remote match (control)');
  ok(S.originRepoOf(bare) === 'acme/ott' && S.originRepoOf(good) === null, 'originRepoOf reads .git/config, no subprocess');
  const many = Array.from({ length: 8 }, (_, i) => path.join(HOMEC, 'many', String(i)));
  for (const d of many) w(path.join(d, '.curator-project'), 'projects/ott\n');
  ok(S.findRepoCandidates({ home: HOMEC, domain: 'projects', project: 'ott', sources: many.map((p) => ({ path: p, why: 'claude-code' })) }).length === S.REPO_CANDIDATE_MAX, `at most ${S.REPO_CANDIDATE_MAX}`);
}

section('§14 DeepSeek Harness: cordis.patch.yml, line-scanned (v3.78.0)');
{
  const HX = path.join(ROOT, 'dsh-home');
  const { mcpEntryFor } = await import('../src/brain/harness-adapters.js');
  const entry = mcpEntryFor('dsh', { command: '/opt/node', args: ['/x/mcp/server.js', '--domains-path', DOMAINS] });
  // A profile layer carrying our entry (as the app hands it out) beside another server with a secret.
  w(path.join(HX, '.dsh', 'profiles', 'tui', 'cordis.patch.yml'), `# mine\n${entry.text}- insert:\n    - id: ${OTHER}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${OTHER}\n        env:\n          K: ${SECRET}\n`);
  w(path.join(HX, '.dsh', 'cordis.patch.yml'), '');
  const t = S.harnessTargets({ home: HX, project: '' }).find((x) => x.id === 'dsh');
  ok(t && t.mcp.some((m) => m.file === path.join(HX, '.dsh', 'cordis.patch.yml')) && t.mcp.some((m) => m.expanded && m.file.endsWith(path.join('profiles', 'tui', 'cordis.patch.yml'))),
    'the home-level layer and each profile\'s layer are read — never cordis.yml', t?.mcp);
  const d = row(S.collectMachineSetup({ home: HX, repo: '', skillsDir, domainsDir: DOMAINS }), 'dsh');
  ok(d.bridge.state === 'ok' && d.files.some((f) => f.named && f.lineScan), 'our entry, as handed out, is found by the line-scan → configured', d.bridge);
  ok((d.bridge.fileNotes || []).some((n) => n.status === 'empty'), 'the empty home-level layer is a note beside it');
  ok(!JSON.stringify(d).includes(SECRET) && !JSON.stringify(d).includes(OTHER), 'no other entry\'s name or env value leaves the line-scan');
  w(path.join(HX, '.dsh', 'profiles', 'tui', 'cordis.patch.yml'), '# serverName: my-curator\n- insert: []\n');
  ok(row(S.collectMachineSetup({ home: HX, repo: '', skillsDir, domainsDir: DOMAINS }), 'dsh').bridge.state !== 'ok', 'a commented-out line does not count (control)');
}

section('§15 per-tool status, parts and evidence; custom tools (v3.78.0)');
{
  const now = Date.now();
  const iso = (m) => new Date(now - m * 60e3).toISOString();
  const emptyHome = path.join(ROOT, 'emptyhome');
  const bare = S.collectMachineSetup({ home: emptyHome, repo: REPO, skillsDir, domainsDir: DOMAINS });
  const marker = await S.inspectMarker(REPO, { domain: 'projects', project: 'ott' });
  const pairs = [
    { scope: 'claude-code', machine: 'mac-a-111111', harness: 'Claude Code', writtenAt: iso(5) },
    { scope: 'zed', machine: 'mac-b-222222', harness: 'Zed', writtenAt: iso(9) },
    { scope: 'my-agent', machine: 'mac-a-111111', harness: 'My Agent', writtenAt: iso(7) },
  ];
  const r = S.collectProjectSetup({
    domain: 'projects', project: 'ott', pairs, machine: { ids: ['mac-a-111111'] }, machineRows: bare,
    repo: { path: REPO, source: 'set' }, marker, template: TEMPLATE, customTools: [{ id: 'fancy bot', label: 'Fancy Bot' }],
  });
  const cc = r.tools.find((t) => t.id === 'claude-code');
  ok(cc.status === 'ready', 'Claude Code: saved here under its own scope, bridge proven, block current → ready', cc);
  ok(['mcp', 'skills', 'block', 'hooks'].every((k) => cc.parts[k] && typeof cc.parts[k].state === 'string' && typeof cc.parts[k].word === 'string'), 'four parts, each {state, word}', cc.parts);
  ok(Array.isArray(cc.evidence) && ['Saved', 'MCP bridge', 'Skills', 'Instruction block', 'Hooks'].every((h) => cc.evidence.some((e) => e.heading === h && e.lines.length)), 'evidence: a heading per part, each with lines', cc.evidence.map((e) => e.heading));
  ok(cc.evidence.find((e) => e.heading === 'Instruction block').reveal === path.join(REPO, 'CLAUDE.md'), 'the block evidence reveals the instruction file');
  const zed = r.tools.find((t) => t.id === 'zed');
  ok(zed.status !== 'ready', 'a tool whose only save is from another computer is never ready', zed.status);
  const fancy = r.tools.find((t) => t.id === 'fancy bot');
  ok(fancy && fancy.custom === true && fancy.userAdded === true && fancy.label === 'Fancy Bot' && fancy.instructionFile === 'AGENTS.md', 'a custom tool gets a row: custom, AGENTS.md', fancy);
  ok(fancy.status === 'no-save' && !r.toFix.some((f) => f.tool === 'fancy bot'), 'a custom tool that never saved: "no-save", and nothing it cannot know is a to-fix line', r.toFix.filter((f) => f.tool === 'fancy bot'));
  ok(fancy.block.state === 'unmeasured' && /AGENTS\.md has no Curator block/.test(fancy.block.word), 'its block cell reads AGENTS.md, labelled as an assumption (unmeasured, not red)', fancy.block);
  const mine = r.tools.find((t) => t.id === 'my agent');
  ok(mine && mine.custom && mine.userAdded === false && mine.status === 'partly', 'an unknown tool seen only in a save: custom, saved under its own name here → partly (block not proven)', mine);
}

section('§16 to-fix lines, the block cap, travels and saves (v3.79.0)');
{
  const opts = { domain: 'projects', project: 'ott', template: TEMPLATE };
  const cur = block('projects/ott', 'ott');
  const labelled = [];   // every item this section produces, for (h)
  const run = (o) => { const r = S.collectProjectSetup({ domain: 'projects', project: 'ott', template: TEMPLATE, home: ROOT, ...o }); labelled.push(...r.toFix); return r; };

  // (a) block offsets and mtime
  {
    const f = path.join(ROOT, 'offsets.md');
    const text = `# ott\n\nIntro.\n\n## Working state\n\n${cur}\n## More\n\nOwner text.\n`;
    w(f, text);
    const r = S.inspectInstructionFile(f, opts);
    const slice = text.slice(r.blockStart, r.blockEnd);
    ok(r.current && slice.startsWith('## Working state') && slice.trimEnd().endsWith(cur.trimEnd().slice(-40)) && !slice.includes('## More'),
      'block offsets: from its "## Working state" heading to the end of the block, before the next heading', { start: r.blockStart, end: r.blockEnd, tail: slice.slice(-60) });
    ok(Number.isFinite(r.mtimeMs) && Math.abs(r.mtimeMs - statSync(f).mtimeMs) < 1, 'inspectInstructionFile returns the file\'s mtimeMs');
    const a = S.analyseInstructionText(text.replace(/\n/g, '\r\n'), opts);
    ok(a.current && a.blockStart === r.blockStart && a.blockEndBytes > r.blockEndBytes, 'CRLF: the same char offsets into the LF text; bytes counted on disk (larger)', { a: a.blockEndBytes, r: r.blockEndBytes });
    const noHead = S.analyseInstructionText(`Some text.\n\n${cur}\n# Next\n`, opts);
    ok(noHead.blockStart === 'Some text.\n\n'.length, 'with no heading above it, the block starts at its lead sentence', noHead.blockStart);
  }

  // (b) block-cap fires ONLY when the block does not fit in what the tool reads
  {
    const capRepo = path.join(ROOT, 'caprepo');
    mkdirSync(capRepo, { recursive: true });
    const filler = (n) => `${'x'.repeat(99)}\n`.repeat(Math.ceil(n / 100)).slice(0, n);
    const agRun = (agents) => {
      w(path.join(capRepo, 'AGENTS.md'), agents);
      const r = run({ pairs: [], machine: { ids: [] }, machineRows: [], repo: { path: capRepo, source: 'set' }, addedTools: ['antigravity'] });
      return { r, cap: r.toFix.find((f) => f.kind === 'block-cap'), ag: r.tools.find((t) => t.id === 'antigravity') };
    };
    const top = agRun(`## Working state\n\n${cur}\n\n## Notes\n\n${filler(30000)}`);
    ok(!top.cap && top.ag.block.state === 'ok', 'a 30 KB AGENTS.md with the block AT THE TOP: no cap line (v3.78.0 fired on overCap here)', top.r.toFix);
    const mid = agRun(`${filler(3000)}\n## Working state\n\n${cur}\n`);
    ok(!mid.cap && mid.ag.block.state === 'ok', 'a block 3 KB down (past "the top", well inside 24,000 bytes): no cap line', mid.r.toFix);
    const deep = agRun(`${filler(30000)}\n## Working state\n\n${cur}\n`);
    ok(deep.cap && deep.cap.text === 'Antigravity reads only the first 24,000 bytes of AGENTS.md, and the Curator instructions start after that.' && deep.cap.detail === 'Move them to the top, then commit and push.',
      'a block starting 30 KB down: "…start after that." / "Move them to the top…"', deep.cap);
    const straddle = agRun(`${filler(23500)}\n## Working state\n\n${cur}\n`);
    ok(straddle.cap && /run past that\.$/.test(straddle.cap.text), 'a block starting inside the cap and ending past it: "…run past that."', straddle.cap);
    ok(deep.cap.fixes.map((x) => x.kind).join() === 'reveal,copy-command', '…its buttons: Reveal AGENTS.md, the git command', deep.cap.fixes);
  }

  // (c) a wrong-name save when the instructions here are CURRENT
  const curRepo = path.join(ROOT, 'currepo');
  w(path.join(curRepo, 'AGENTS.md'), `## Working state\n\n${cur}\n`);
  const edited = Date.parse('2026-09-24T12:00:00Z');
  utimesSync(path.join(curRepo, 'AGENTS.md'), edited / 1000, edited / 1000);
  const agSave = (machine, at) => [{ scope: 'main', machine, harness: 'Antigravity', writtenAt: at }];
  {
    const r = run({ pairs: agSave('mac-b-222222', '2026-09-25T12:00:00Z'), machine: { ids: ['mac-a-111111'] }, machineRows: [], repo: { path: curRepo, source: 'set' } });
    const ws = r.toFix.find((f) => f.kind === 'wrong-scope');
    ok(ws && ws.text === 'Antigravity’s last save (25 Sep, on mac-b-222222) went under “main”, not its own name “antigravity”.', 'current block, another computer: the line names the date and the computer', ws);
    ok(ws && /^Your instructions here are already current, so this clears the next time Antigravity saves — after that computer runs git pull\.$/.test(ws.detail), '…"already current… clears the next time… git pull"', ws?.detail);
    ok(ws && ws.fixes.length === 0 && ws.fix === null && ws.at === '2026-09-25T12:00:00Z' && ws.machine === 'mac-b-222222' && ws.thisMachine === false, '…NO copy button; at / machine / thisMachine carried', ws);
    ok(!/scope/i.test(`${ws.text} ${ws.detail}`), '…and the words say "name", never "scope"');
    const unpushed = run({ pairs: agSave('mac-b-222222', '2026-09-25T12:00:00Z'), machine: { ids: ['mac-a-111111'] }, machineRows: [], repo: { path: curRepo, source: 'set' }, instructionGit: { 'AGENTS.md': { committed: false, pushed: null } } });
    const wu = unpushed.toFix.find((f) => f.kind === 'wrong-scope');
    ok(wu && /not yet committed and pushed/.test(wu.detail) && wu.fixes.length === 1 && /git push$/.test(wu.fixes[0].command), 'current here but NOT committed: say so, and offer the commit-and-push command (that computer cannot pull it yet)', wu);
    const here = run({ pairs: agSave('mac-a-111111', '2026-09-23T12:00:00Z'), machine: { ids: ['mac-a-111111'] }, machineRows: [], repo: { path: curRepo, source: 'set' } });
    const wh = here.toFix.find((f) => f.kind === 'wrong-scope');
    ok(wh && /on this Mac\)/.test(wh.text) && wh.detail === 'Your instructions here are already current, so this clears the next time Antigravity saves.' && !wh.savedAfterInstructions, 'this Mac, saved BEFORE the file last changed: "clears the next time"', wh);
    const after = run({ pairs: agSave('mac-a-111111', '2026-09-25T12:00:00Z'), machine: { ids: ['mac-a-111111'] }, machineRows: [], repo: { path: curRepo, source: 'set' } });
    const wa = after.toFix.find((f) => f.kind === 'wrong-scope');
    ok(wa && wa.savedAfterInstructions === true && /ask it to save under “antigravity”/.test(wa.detail) && /If that session started before the change/.test(wa.detail) && wa.fixes.length === 0,
      'this Mac, saved AFTER the file last changed: says so, hedged (a session reads the file when it starts), asks for its own name', wa);
  }

  // (d) an OUTDATED block: one line, the block's, which explains the save
  {
    const oldRepo = path.join(ROOT, 'oldrepo');
    w(path.join(oldRepo, 'AGENTS.md'), `## Working state\n\n${cur.replace('call `get_project_context` again before acting', 'call it again')}\n`);
    const r = run({ pairs: agSave('mac-b-222222', '2026-09-25T12:00:00Z'), machine: { ids: ['mac-a-111111'] }, machineRows: [], repo: { path: oldRepo, source: 'set' } });
    const bo = r.toFix.find((f) => f.kind === 'block-outdated');
    ok(!r.toFix.some((f) => f.kind === 'wrong-scope'), 'outdated block + wrong save: no separate wrong-name line');
    ok(bo && bo.text === `AGENTS.md in ${S.tildeUnder(ROOT, oldRepo)} has older Curator instructions, so Antigravity may not re-read on “continue” or save under its own name.`
      && /That is why its 25 Sep save went under “main”\.$/.test(bo.detail) && bo.at === '2026-09-25T12:00:00Z', '…the block line names the file and folder, and mentions the save', bo);
    ok(bo && bo.fixes.map((x) => x.kind + ':' + x.label).join(' | ') === `copy-block:Copy instructions | reveal:Reveal AGENTS.md | copy-command:Copy the git command that commits and pushes it`
      && bo.fixes[1].path === path.join(oldRepo, 'AGENTS.md') && bo.fixes[2].cwd === oldRepo && /^git add -- AGENTS\.md && git commit -m ".+" -- AGENTS\.md && git push$/.test(bo.fixes[2].command),
      '…buttons: Copy instructions · Reveal AGENTS.md · the git command (run in the folder)', bo?.fixes);
    const miss = path.join(ROOT, 'missrepo');
    mkdirSync(miss, { recursive: true });
    const m = run({ pairs: [], machine: { ids: [] }, machineRows: [], repo: { path: miss, source: 'set' }, addedTools: ['antigravity'] });
    const bm = m.toFix.find((f) => f.kind === 'block-missing');
    ok(bm && bm.text === `AGENTS.md in ${S.tildeUnder(ROOT, miss)} has no Curator instructions, so Antigravity doesn’t know this project and may overwrite another tool’s handoff.`
      && /Paste them at the very top \(create the file if it isn’t there\), then commit and push\.$/.test(bm.detail), 'block-missing: the contract\'s two lines', bm);
  }

  // (e)(f) the marker, through real git
  {
    const gRepo = path.join(ROOT, 'grepo');
    mkdirSync(gRepo, { recursive: true });
    const g = (...args) => execFileSync('git', args, { cwd: gRepo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();
    g('init', '-q');
    w(path.join(gRepo, 'README.md'), '# g\n');
    g('add', 'README.md'); g('commit', '-q', '-m', 'i');
    const other = [{ scope: 'claude-code', machine: 'mac-b-222222', harness: 'Claude Code', writtenAt: '2026-09-25T12:00:00Z' }];
    let mk = await S.inspectMarker(gRepo, { domain: 'projects', project: 'ott' });
    const withOther = run({ pairs: other, machine: { ids: ['mac-a-111111'] }, machineRows: [], repo: { path: gRepo, source: 'set' }, marker: mk });
    const mm = withOther.toFix.find((f) => f.kind === 'marker-missing');
    ok(mm && mm.text === `${S.tildeUnder(ROOT, gRepo)} has no .curator-project, so agents and hooks can’t tell which project this folder is.` && /^If it exists on another computer, run git pull here\./.test(mm.detail)
      && mm.fixes[0].command === 'git pull' && mm.fixes[0].label === 'Copy git pull' && mm.fixes[0].cwd === gRepo, 'marker missing, another computer has saved: offer git pull first', mm);
    const alone = run({ pairs: [], machine: { ids: [] }, machineRows: [], repo: { path: gRepo, source: 'set' }, marker: mk });
    const ma = alone.toFix.find((f) => f.kind === 'marker-missing');
    ok(ma && ma.detail === 'Create it, then commit and push.' && /^printf '%s\\n' projects\/ott > \.curator-project && git add -- \.curator-project && git commit -m ".+" -- \.curator-project && git push$/.test(ma.fixes[0].command),
      'marker missing, no other computer: one command that creates, commits and pushes it', ma?.fixes?.[0]);
    // Run the offered create command's FIRST half for real: it writes the marker this project reads.
    execFileSync('/bin/sh', ['-c', ma.fixes[0].command.split(' && ')[0]], { cwd: gRepo });
    mk = await S.inspectMarker(gRepo, { domain: 'projects', project: 'ott' });
    ok(mk.present && mk.namesThis, '…and that command writes a marker naming this project (run for real)', mk);
    const un = run({ pairs: [], machine: { ids: [] }, machineRows: [], repo: { path: gRepo, source: 'set' }, marker: mk });
    const mu = un.toFix.find((f) => f.kind === 'marker-uncommitted');
    ok(mu && mu.text === `${S.tildeUnder(ROOT, gRepo)}/.curator-project isn’t committed to the project’s git repository.` && mu.detail === 'Your other computers get it only after you commit and push it here, then pull there.'
      && / && git push$/.test(mu.fixes[0].command) && mu.fixes[0].label === 'Copy the git command that commits and pushes it', 'marker uncommitted: the command commits AND pushes', mu);
    w(path.join(gRepo, '.curator-project'), 'projects/zzz\n');
    mk = await S.inspectMarker(gRepo, { domain: 'projects', project: 'ott' });
    const wr = run({ pairs: [], machine: { ids: [] }, machineRows: [], repo: { path: gRepo, source: 'set' }, marker: mk });
    const mw = wr.toFix.find((f) => f.kind === 'marker-wrong');
    ok(mw && mw.text === `${S.tildeUnder(ROOT, gRepo)}/.curator-project says projects/zzz, so every agent here opens projects/zzz.` && mw.detail === 'Change it to projects/ott, then commit and push.', 'marker wrong: says what it names and what to change it to', mw);
    const gone = run({ pairs: [], machine: { ids: [] }, machineRows: [], repo: { path: path.join(ROOT, 'nope-repo'), source: 'set', exists: false } });
    ok(gone.toFix.find((f) => f.kind === 'repo-missing')?.text === `${S.tildeUnder(ROOT, path.join(ROOT, 'nope-repo'))} isn’t on this Mac.` && !gone.toFix.some((f) => /^block-/.test(f.kind)),
      'a folder not on this Mac: one line, and its files are not reported missing beside it', gone.toFix.map((f) => f.kind));
  }

  // (g) sync-incoming names the computer; (i)(j) travels and saves
  {
    const pairs = [
      { scope: 'main', machine: 'mac-b-222222', harness: 'Antigravity', writtenAt: '2026-09-25T12:00:00Z', curator: '3.78.0' },
      { scope: 'antigravity', machine: 'mac-b-222222', harness: 'Antigravity', writtenAt: '2026-09-20T12:00:00Z' },
      { scope: 'claude-code', machine: 'mac-a-111111', harness: 'Claude Code', writtenAt: '2026-09-26T12:00:00Z' },
    ];
    const r = run({ pairs, machine: { ids: ['mac-a-111111'] }, machineRows: [], repo: { path: curRepo, source: 'set' }, marker: { present: true, namesThis: true, line: 'projects/ott', git: { repo: false } },
      sync: { configured: true, incoming: ['projects/state/ott/main/mac-b-222222/current.md'] } });
    const si = r.toFix.find((f) => f.kind === 'sync-incoming');
    ok(si && si.text === 'mac-b-222222 saved a newer handoff; it’s waiting in your Personal Sync on GitHub.' && si.detail === 'Sync now before you start the agent.' && si.machine === 'mac-b-222222' && si.fix.kind === 'sync' && si.fix.label === 'Sync now',
      'sync-incoming names the computer, one line per computer', si);
    const t = r.tools.find((x) => x.id === 'claude-code');
    ok(t.parts.mcp.travels === 'this-computer' && t.parts.skills.travels === 'this-computer' && t.parts.hooks.travels === 'this-computer' && t.parts.block.travels === 'project-git', 'tool parts: mcp/skills/hooks travel nowhere (this computer), the block by the project\'s git', t.parts);
    ok(t.block.files.length && t.block.files.every((f) => f.travels === 'project-git'), 'repository file rows (block.files) carry travels: project-git');
    ok(r.repo.travels === 'project-git' && r.repo.marker.travels === 'project-git', 'the repository and its marker: project-git');
    const b = r.computers.find((c) => c.primary === 'mac-b-222222');
    ok(b.travels === 'personal-sync' && b.saves.length === 1 && b.saves[0].tool === 'antigravity' && b.saves[0].scope === 'main' && b.saves[0].at === '2026-09-25T12:00:00Z'
      && b.saves[0].ownScope === false && b.saves[0].wrongScope === true && b.saves[0].curator === '3.78.0' && b.saves[0].label === 'Antigravity' && b.saves[0].travels === 'personal-sync',
      'computers: travels personal-sync; saves = each tool\'s NEWEST save, with the name it went under', b);
    const a = r.computers.find((c) => c.thisComputer);
    ok(a.saves.length === 1 && a.saves[0].ownScope === true, '…own name flagged ownScope', a.saves);
  }

  // (h) every fix button has a label, and `fix` is always `fixes[0]`
  {
    // Add the bridge and skills kinds to what this section produced.
    const HB = path.join(ROOT, 'st-b');
    const b = row(S.collectMachineSetup({ home: HB, repo: '', skillsDir, domainsDir: DOMAINS }), 'antigravity');
    run({ pairs: [], machine: { ids: [] }, machineRows: [b], repo: null, addedTools: ['antigravity'] });
    run({ pairs: [], machine: { ids: [] }, machineRows: machine, repo: { path: REPO, source: 'set' }, addedTools: ['antigravity', 'claude-code'] });
    run({ pairs: [], machine: { ids: [] }, machineRows: machine, repo: null, addedTools: ['antigravity', 'claude-code'] });
    const kinds = new Set(labelled.map((f) => f.kind));
    const fixKinds = new Set(labelled.flatMap((f) => f.fixes.map((x) => x.kind)));
    ok(['wrong-scope', 'block-missing', 'block-outdated', 'block-cap', 'marker-missing', 'marker-uncommitted', 'marker-wrong', 'repo-missing', 'sync-incoming', 'bridge-file', 'bridge', 'skills'].every((k) => kinds.has(k)), 'this section produced every to-fix kind', [...kinds]);
    ok(['reveal', 'copy-block', 'copy-command', 'copy-marker', 'copy-snippet', 'download-skill', 'sync', 'change-repo', 'settings', 'recheck'].every((k) => fixKinds.has(k)), '…and every fix kind', [...fixKinds]);
    const unlabelled = labelled.flatMap((f) => f.fixes.filter((x) => typeof x.label !== 'string' || !x.label.trim()).map((x) => `${f.kind}/${x.kind}`));
    ok(unlabelled.length === 0, 'every fix button carries a label', unlabelled);
    ok(labelled.every((f) => f.fix === (f.fixes[0] || null)), '`fix` is always `fixes[0]` (or null)');
    ok(labelled.every((f) => typeof f.text === 'string' && f.text && typeof f.detail === 'string' && f.detail), 'every item has both lines: text and detail');
    ok(!labelled.some((f) => /\bscope\b/i.test(`${f.text} ${f.detail}`)), 'no to-fix line says "scope"', labelled.filter((f) => /\bscope\b/i.test(`${f.text} ${f.detail}`)).map((f) => f.text));
    const sk = labelled.find((f) => f.kind === 'skills' && f.tool === 'antigravity');
    ok(sk && sk.fixes.filter((x) => x.kind === 'download-skill').map((x) => x.skill).join() === 'my-curator' && /my-curator skill is older/.test(sk.text) && /\(in ~\/home\/\.gemini\/config\/plugins\/the-curator\/skills\)\.$/.test(sk.text),
      'skills: names the stale skill and its folder, and downloads ONLY that skill', sk);
    const br = labelled.find((f) => f.kind === 'bridge' && f.tool === 'antigravity');
    ok(br && /~\/\.gemini\/antigravity\/mcp_config\.json/.test(br.text) && br.fixes.map((x) => x.kind).join() === 'copy-snippet,reveal', 'bridge "not in every file": names the file; Copy MCP entry · Reveal', br);
  }
  ok(S.shq("it's") === `'it'\\''s'` && S.shq('AGENTS.md') === 'AGENTS.md' && S.shq('a b') === "'a b'", 'shell quoting: safe words bare, the rest single-quoted');
}

section('§17 what a setup guide and a Remove need (v3.80.0)');
{
  // One fixture home: Windsurf's config exists but does not name us, Antigravity
  // names us (so it is CONFIGURED here), Codex has no file at all.
  const H = path.join(ROOT, 'guidehome');
  w(path.join(H, '.codeium', 'windsurf', 'mcp_config.json'), JSON.stringify({ mcpServers: other }));
  w(path.join(H, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'my-curator': ours } }));
  const rows = S.collectMachineSetup({ home: H, repo: REPO, skillsDir, domainsDir: DOMAINS });
  const marker = await S.inspectMarker(REPO, { domain: 'projects', project: 'ott' });
  const iso = new Date(Date.now() - 60e3).toISOString();
  const r = S.collectProjectSetup({
    domain: 'projects', project: 'ott', home: H, machine: { ids: ['mac-a-111111'] }, machineRows: rows,
    pairs: [{ scope: 'claude-code', machine: 'mac-a-111111', harness: 'Claude Code', writtenAt: iso }],
    repo: { path: REPO, source: 'set' }, marker, template: TEMPLATE,
    addedTools: ['windsurf', 'codex', 'claude-code', 'antigravity'], customTools: [{ id: 'fancy bot', label: 'Fancy Bot' }],
  });
  const t = (id) => r.tools.find((x) => x.id === id);
  // removable: why each row is listed decides it.
  ok(t('windsurf').userAdded === true && t('windsurf').removable?.ok === true, 'a known tool the owner added, never saved, not configured here: removable', t('windsurf').removable);
  ok(t('claude-code').removable?.ok === false && t('claude-code').removable.why === 'saved', 'a tool that has SAVED stays (its saves are the record), even though it was also added', t('claude-code').removable);
  ok(t('antigravity').removable?.ok === false && t('antigravity').removable.why === 'configured', 'a tool whose MCP settings here name The Curator stays', t('antigravity').removable);
  ok(t('fancy bot').removable?.ok === true && t('fancy bot').userAdded === true, 'a custom tool the owner named: removable');
  const r2 = S.collectProjectSetup({ domain: 'projects', project: 'ott', home: H, machine: { ids: [] }, machineRows: rows, pairs: [], repo: null, template: TEMPLATE, addedTools: [] });
  ok(r2.tools.find((x) => x.id === 'antigravity')?.userAdded === false && r2.tools.find((x) => x.id === 'antigravity').removable.ok === false,
    'CONTROL: a configured tool nobody added is not "userAdded" and not removable');
  // reads: every row says which files it reads (a custom tool: the AGENTS.md convention).
  ok(JSON.stringify(t('windsurf').reads) === '[]' && JSON.stringify(t('codex').reads) === '["AGENTS.md"]'
    && JSON.stringify(t('antigravity').reads) === '["AGENTS.md","GEMINI.md"]' && JSON.stringify(t('fancy bot').reads) === '["AGENTS.md"]', 'reads: the files each tool reads');
  // mcpTarget: the file that names us, else the first that exists, else the first; `file` only when it exists.
  const wsT = t('windsurf').mcpTarget;
  ok(wsT && wsT.display === '~/.codeium/windsurf/mcp_config.json' && wsT.file === path.join(H, '.codeium', 'windsurf', 'mcp_config.json') && wsT.exists === true && wsT.format === 'json',
    'Windsurf: its existing config file, with the absolute path for Reveal', wsT);
  const cxT = t('codex').mcpTarget;
  ok(cxT && cxT.display === '~/.codex/config.toml' && !('file' in cxT) && cxT.exists === false && cxT.format === 'toml', 'Codex: no file yet — the display path only, never a path to reveal', cxT);
  ok(t('antigravity').mcpTarget?.display === '~/.gemini/config/mcp_config.json', 'Antigravity: the file that already names my-curator', t('antigravity').mcpTarget);
  ok(t('fancy bot').mcpTarget === null && t('fancy bot').skillsTarget === null, 'a custom tool: no target and no skills folder claimed');
  ok(t('antigravity').skillsTarget?.verified === true && /plugins/.test(t('antigravity').skillsTarget.path) && t('claude-code').skillsTarget?.accountHeld === true
    && t('windsurf').skillsTarget?.verified === false, 'skillsTarget: verified folder / account-held / not known', [t('antigravity').skillsTarget, t('claude-code').skillsTarget, t('windsurf').skillsTarget]);
  // instructionFixes: the file's own doors, where its block is not ok.
  const fx = t('codex').instructionFixes;
  ok(Array.isArray(fx) && fx.map((x) => x.kind).join() === 'copy-block,reveal,copy-command' && fx[1].path === path.join(REPO, 'AGENTS.md') && /git add -- AGENTS\.md/.test(fx[2].command),
    'a tool whose block is not current: copy, reveal and the commit-and-push command for its file', fx);
  ok(JSON.stringify(t('windsurf').instructionFixes) === '[]' && JSON.stringify(r2.tools.find((x) => x.id === 'antigravity').instructionFixes) === '[]',
    'none for a tool that reads no file, or with no repository set');
  ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(OTHER), 'privacy holds on the new fields (no other server\'s name or value)');
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
