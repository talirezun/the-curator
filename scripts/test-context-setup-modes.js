/**
 * Context › step 5 "Setup" in BOTH modes of the app-wide Pro switch (v4.2,
 * CONTRACT-pro-context-v1 package K). OFFLINE: the REAL builders of
 * src/public/next/views/setup-step.js (DOM-free) rendered in plain Node.
 *
 *   §1 Pro off — one row per harness: one status, at most one action, the
 *      whole row one control, the quiet "More in Pro" door last.
 *   §2 the status of each harness (Ready · N steps left · Needs a fix · Not on
 *      this computer) and its one action, over the demo payload.
 *   §3 Pro on — today's step with the audit's fixes: "Harness", whole-row
 *      targets, "Open setup steps" on a row that needs it, a harness's note
 *      leads to its steps, no door.
 *   §4 WARNING PARITY — every to-fix line Pro shows is on screen with Pro
 *      off, and every fix button Pro shows is on the simple page or one press
 *      away in that harness's reader (the same reader in both modes).
 *   §5 the page contract on both renders (kit classes, real buttons, folds,
 *      no inline style, no primary), and the vocabulary ("agent harness",
 *      never "agent app" or "tool" for a harness).
 *   §6 the harness reader: what a skill is, no maintainer notes, no raw ISO
 *      dates, "What Setup read" open only with Pro.
 *   §7 the hand cursor on the rows that open something.
 *
 * Step 4's two modes are asserted where its renderer can be executed:
 * scripts/test-next-memory-view.js, "v4.2 ④".
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPageContract, KIT_CLASSES } from './test-helpers/page-contract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = await import('../src/public/next/views/setup-step.js');
const PRO = await import('../src/public/next/shared/pro.js');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 900) : '')); }
}
const section = (t) => console.log('\n' + t);
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const textOf = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');

// ── THE DEMO PAYLOAD — two harnesses on this computer (one ready, one with
// a stale skill), one with steps left, one that saved from the other
// computer; the repository folder not set; two computers, a newer handoff
// waiting, two files not on GitHub. The v4.1 shape (`fixes[]`, `parts`). ──
const ok4 = (word) => ({ state: 'ok', word });
const demo = () => ({
  ok: true, domain: 'projects', project: 'exhibit-site', checkedAt: iso(30e3),
  repo: null,
  repoCandidates: [{ path: '/Users/t/Projects/exhibit-site', display: '~/Projects/exhibit-site', why: 'claude-code', whyText: 'Claude Code has opened it' }],
  tools: [
    { id: 'claude-code', label: 'Claude Code', status: 'ready',
      saved: { state: 'ok', at: iso(4 * 60e3), scope: 'claude-code', machine: 'mac-a', thisMachine: true, wrongScope: false },
      parts: { mcp: ok4('configured'), skills: ok4('current'), block: ok4('current · at the top'), hooks: { state: 'none', word: 'not wired, optional' } },
      reads: ['CLAUDE.md'],
      evidence: [{ heading: 'Saved', lines: ['Newest save ' + iso(4 * 60e3) + ' under “claude-code” — its own scope.'] },
        { heading: 'MCP bridge', lines: ['configured — observed working that way (2026-09-26)'], reveal: '/Users/t/.claude.json' }] },
    { id: 'antigravity', label: 'Antigravity', status: 'to-fix',
      saved: { state: 'ok', at: iso(2 * 3600e3), scope: 'antigravity', machine: 'mac-a', thisMachine: true, wrongScope: false },
      parts: { mcp: ok4('configured'), skills: { state: 'fix', word: 'my-curator outdated' }, block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'unmeasured', word: 'wired · unmeasured' } },
      reads: ['AGENTS.md', 'GEMINI.md'],
      skillsTarget: { path: '~/.gemini/config/plugins/the-curator/skills', verified: true },
      evidence: [{ heading: 'MCP bridge', lines: ['~/.gemini/antigravity/ and ~/.gemini/antigravity-ide/ each held their own mcp_config.json on the maintainer\'s Mac on 2026-09-25 (observed, three separate files).'] },
        { heading: 'Hooks', lines: ['wired — ran once (2026-09-26) but its injection was not seen used'] }] },
    { id: 'codex', label: 'Codex', status: 'no-save', saved: { state: 'none', at: null },
      parts: { mcp: { state: 'none', word: 'not found' }, skills: { state: 'none', word: 'not installed' }, block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'none', word: '—' } },
      reads: ['AGENTS.md'], userAdded: true, removable: { ok: true },
      mcpSnippet: { format: 'toml', text: '[mcp_servers.my-curator]\ncommand = "node"' },
      mcpTarget: { display: '~/.codex/config.toml', file: '/Users/t/.codex/config.toml', format: 'toml', exists: false },
      skillsTarget: { path: '~/.codex/skills', verified: true } },
    { id: 'opencode', label: 'OpenCode', status: 'no-save',
      saved: { state: 'ok', at: iso(26 * 3600e3), scope: 'opencode', machine: 'studio-mac', thisMachine: false, wrongScope: false },
      parts: { mcp: { state: 'none', word: 'not found' }, skills: { state: 'none', word: 'not installed' }, block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'none', word: '—' } },
      reads: ['AGENTS.md', 'CLAUDE.md'] },
  ],
  physical: [
    { thisComputer: true, installs: [{ primary: 'mac-a', names: ['mac-a'], thisComputer: true, installKind: 'app', tools: ['Antigravity', 'Claude Code'], newestSaveAt: iso(4 * 60e3), curatorVersion: '4.1.2', waiting: 0 }] },
    { thisComputer: false, installs: [{ primary: 'studio-mac', names: ['studio-mac'], thisComputer: false, installKind: 'app', tools: ['OpenCode'], newestSaveAt: iso(26 * 3600e3), curatorVersion: '4.1.2', waiting: 1 }] },
  ],
  computers: [],
  sync: { configured: true, lastSync: iso(3600e3), pending: 2, incoming: ['x'], incomingCheckedAt: iso(60e3) },
  toFix: [
    { tool: 'antigravity', kind: 'skills', reason: 'outdated', skills: ['my-curator'],
      text: 'Antigravity’s my-curator skill is older than the copy this app carries (in ~/.gemini/config/plugins/the-curator/skills).',
      detail: 'Download the current .zip, replace the folder with it, then start a new Antigravity session.',
      fixes: [{ kind: 'download-skill', skill: 'my-curator', href: '/api/setup/skills/my-curator.zip', label: 'Download my-curator.zip' },
        { kind: 'reveal', path: '/Users/t/.gemini/config/plugins/the-curator/skills/my-curator', label: 'Reveal the folder' }] },
    { kind: 'sync-incoming', machine: 'studio-mac', waiting: 1,
      text: 'studio-mac saved a newer handoff; it’s waiting in your Personal Sync on GitHub.', detail: 'Sync now before you start the agent.',
      fixes: [{ kind: 'sync', label: 'Sync now' }] },
  ],
  addable: [{ id: 'cursor', label: 'Cursor', group: 'known', reads: ['AGENTS.md'], configPaths: ['~/.cursor/mcp.json'] },
    { id: '__custom', label: 'Custom agent app…', group: 'other' }],
});

/** The repository set, with a project item and TWO items on one harness. */
const repoSet = () => {
  const d = demo();
  d.repo = { path: '/Users/t/Projects/exhibit-site', display: '~/Projects/exhibit-site', exists: true,
    marker: { present: true, namesThis: true, line: 'projects/exhibit-site', git: { repo: true, tracked: true, unpushed: true } } };
  d.tools[1].parts.block = { state: 'fix', word: 'missing' };
  d.tools[1].block = { files: [{ name: 'AGENTS.md', present: false, hasBlock: false }] };
  d.toFix.push(
    { tool: 'antigravity', kind: 'block-missing', file: 'AGENTS.md',
      text: 'AGENTS.md in ~/Projects/exhibit-site has no Curator instructions, so Antigravity doesn’t know this project.',
      detail: 'Paste them at the very top (create the file if it isn’t there), then commit and push.',
      fixes: [{ kind: 'copy-block', label: 'Copy instructions' }, { kind: 'reveal', path: '/Users/t/Projects/exhibit-site/AGENTS.md', label: 'Reveal AGENTS.md' },
        { kind: 'copy-command', command: 'git add -- AGENTS.md && git commit -m "Add" -- AGENTS.md && git push', label: 'Copy the git command that commits and pushes it' }] },
    { kind: 'marker-unpushed', text: '.curator-project is committed but not pushed.', detail: 'Your other computers get it only after you push it here, then pull there.',
      fixes: [{ kind: 'copy-command', command: 'git push', label: 'Copy git push', cwdDisplay: '~/Projects/exhibit-site' }] });
  return d;
};
const oneReady = () => { const d = demo(); d.tools = [d.tools[0]]; d.toFix = []; d.physical = [d.physical[0]]; d.sync.pending = 0; return d; };
const empty = () => { const d = demo(); d.tools = []; d.toFix = []; d.physical = []; return d; };

const ARMS = [['the demo (two computers, repo unset)', demo], ['repo set, two fixes on one harness', repoSet],
  ['one harness, ready', oneReady], ['an empty project', empty]];

const door = (what) => PRO.moreInProLine(what);
const simple = (d, ui = {}) => S.renderSetupBody({ data: d }, { pro: false, moreInPro: door, pickerHtml: '<button type="button" class="lb-btn btn btn-secondary btn-xs" id="mem-setup-add">+ Add an agent harness</button>', ...ui });
const pro = (d, ui = {}) => S.renderSetupBody({ data: d }, { pro: true, moreInPro: door, openFolds: { 'setup-tools': true, 'setup-repo': true, 'setup-computers': true }, pickerHtml: '<button type="button" class="lb-btn btn btn-secondary btn-xs" id="mem-setup-add">+ Add an agent harness</button>', ...ui });
const rows = (h) => [...h.matchAll(/<li class="mem-hr mem-setup-row"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => ({ all: m[0], inner: m[1] }));
const rowOf = (h, id) => rows(h).find((r) => r.all.includes('data-tool="' + id + '"')) || { all: '', inner: '' };

// ═══════════════════════════════════════════════════════════════════════════
section('§1 Pro off — one row per harness, one status, at most one action, one control');
for (const [name, mk] of ARMS) {
  const d = mk();
  const h = simple(d);
  const rs = rows(h);
  ok(rs.length === d.tools.length, name + ': one row per harness', rs.length + ' of ' + d.tools.length);
  ok(rs.every((r) => (r.all.match(/class="cur-setup-st /g) || []).length === 1), name + ': ...each with exactly ONE status word');
  ok(rs.every((r) => {
    const act = (/<span class="mem-hr-act">([\s\S]*?)<\/span><span class="mem-hr-chev"/.exec(r.all) || ['', ''])[1];
    return (act.match(/<(button|a)\b/g) || []).length <= 1;
  }), name + ': ...and at most ONE action');
  ok(rs.every((r) => {
    const id = (/data-setup-row="([^"]+)"/.exec(r.all) || [])[1];
    return id && new RegExp('<button type="button" class="mem-hr-open" id="' + id + '" data-setup-act="tool-open"').test(r.all);
  }), name + ': ...the whole row presses its ONE open button (data-setup-row names it)');
  ok(!/<details|<table/.test(h), name + ': no fold and no table with Pro off');
  ok((h.match(/data-pro-more/g) || []).length === 1 && /data-pro-more>More in Pro: [^<]+ <span aria-hidden=\"true\">›<\/span><\/button><\/p><\/div>$/.test(h), name + ': ONE "More in Pro" door, the last line of the step', h.slice(-240));
  ok(/class="mem-setup-route"/.test(h), name + ': the three travel routes, said once');
}
{
  const h = simple(empty());
  ok(/No agent harness on this project yet\. A harness is the app your agent runs in — Claude Code, Codex, Cursor, Antigravity… Add the one you use; Setup walks you through the four steps\./.test(textOf(h)),
    'empty: says what a harness is, glossed with names, and what to do');
  ok(/More in Pro: the repository files, your computers <span aria-hidden="true">›/.test(h), 'empty: the door names only what is behind it (no "every check per harness")');
  ok(/More in Pro: every check per harness, the repository files, your computers <span aria-hidden="true">›/.test(simple(demo())), 'with harnesses: the door names every check per harness too');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§2 each harness\'s status and its one action (the demo payload)');
{
  const d = demo();
  const h = simple(d);
  const status = (id) => ((/<span class="mem-hr-status"><span class="cur-setup-st [^"]*">([^<]*)</.exec(rowOf(h, id).all)) || [])[1];
  const act = (id) => (/<span class="mem-hr-act">([\s\S]*?)<\/span><span class="mem-hr-chev"/.exec(rowOf(h, id).all) || ['', ''])[1];
  ok(status('claude-code') === 'Ready' && act('claude-code') === '', 'Claude Code: Ready, no action (the row opens its steps)');
  ok(/saved <span[^>]*data-age-at=[^>]*>[^<]*<\/span> on this Mac/.test(rowOf(h, 'claude-code').all), '...its second line: saved <age> on this Mac');
  ok(status('antigravity') === 'Needs a fix', 'Antigravity (stale skill): Needs a fix');
  ok(/^<a class="btn btn-secondary btn-xs" href="\/api\/setup\/skills\/my-curator\.zip" download>Get the new my-curator skill \(\.zip\)<\/a>$/.test(act('antigravity')),
    '...its ONE action is the fix\'s first button, named by its outcome', act('antigravity'));
  ok(rowOf(h, 'antigravity').all.includes('Antigravity’s my-curator skill is older than the copy this app carries'), '...and the fix\'s sentence, IN FULL, on the row');
  ok(/^4 steps left$/.test(status('codex')) && /data-setup-act="tool-open" data-tool="codex" data-step="mcp">Continue setup</.test(act('codex')),
    'Codex (nothing done): "4 steps left" · Continue setup, at its first open step', status('codex') + ' | ' + act('codex'));
  ok(/Next: connect it to The Curator/.test(rowOf(h, 'codex').all), '...its second line names the next step');
  ok(status('opencode') === 'Not on this computer' && /data-step="mcp">Set up here</.test(act('opencode')) && /on studio-mac/.test(rowOf(h, 'opencode').all),
    'OpenCode (saved on the other computer only): Not on this computer · Set up here · saved … on studio-mac');
  ok(/studio-mac saved a newer handoff/.test(h) && /data-setup-act="sync"[^>]*>Sync now</.test(h), 'the project-wide line (a newer handoff waiting) stays a loud note, with Sync now');
  ok(!/data-setup-fix="0"/.test(h), '...and a harness\'s own fix is NOT said again as a loud line (it is its row)');
  ok(/2 files here are not on GitHub yet, across all domains\./.test(h), 'files not on GitHub: on screen with Pro off (an outcome), with Sync now');
  ok(/Where is exhibit-site’s code on this Mac\?/.test(h) && /data-setup-act="use-repo" data-path="\/Users\/t\/Projects\/exhibit-site">Use ~\/Projects\/exhibit-site</.test(h),
    'the repository folder not set: one quiet line, with Use and Choose');
  ok(/id="mem-setup-repo-input"/.test(simple(d, { forceRepoOpen: true })) && /id="mem-setup-repo-input"[^>]*value="\/Users\/t\/Projects\/exhibit-site"/.test(simple(repoSet(), { editRepo: true })),
    '"Choose another folder" / "Change folder" open the folder field on the simple page (no fold to open)');
  const m = S.harnessRowModel({ ...d.tools[1], parts: { ...d.tools[1].parts, skills: ok4('current') } }, { ...d, toFix: [] });
  ok(m.status === 'steps' && m.word === '1 step left', 'the same harness with its skill fixed: 1 step left (the folder is not set, so step 3 waits)', JSON.stringify(m.word));
  const two = simple(repoSet());
  ok(textOf(rowOf(two, 'antigravity').all).includes('AGENTS.md in ~/Projects/exhibit-site has no Curator instructions') && /the other fixes are in its steps/.test(rowOf(two, 'antigravity').all),
    'two fixes on one harness: BOTH sentences on its row, the first one\'s fix as its action, the rest in its steps');
  const unm = { ...d, tools: [{ ...d.tools[2], measured: false }] };
  ok(/The Curator hasn’t tested this harness/.test(simple(unm)), 'an unmeasured harness says so, plainly, on its row');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§3 Pro on — today\'s step, with the audit\'s fixes');
{
  const h = pro(repoSet());
  ok(/<th scope="col">Harness<\/th>/.test(h) && !/<th scope="col">Tool<\/th>/.test(h), 'the column is "Harness", never "Tool"');
  ok(/<th scope="col">Harnesses that saved<\/th>/.test(h), 'the Computers table: "Harnesses that saved"');
  ok(/<tr class="mem-ws-row mem-setup-row" data-setup-row="mem-setup-tool-antigravity">/.test(h)
    && /<tr class="mem-ws-row mem-setup-row" data-setup-row="mem-setup-file-AGENTS_md">/.test(h)
    && /<tr class="mem-ws-row mem-setup-row" data-setup-row="mem-setup-comp-0">/.test(h), 'every row that opens something is a whole-row target (harness, file, computer)');
  ok(/data-setup-act="tool-open" data-tool="codex">Open setup steps</.test(h) && !/data-tool="claude-code">Open setup steps</.test(h),
    'a harness that is not ready carries "Open setup steps" on its row; a ready one does not');
  ok(/data-setup-act="tool-open" data-tool="antigravity" data-step="skills">Show its setup steps</.test(h), 'a harness\'s loud line leads to its steps, at the right step');
  ok(!/data-pro-more/.test(h) && /data-mem-fold="setup-tools"/.test(h) && /data-mem-fold="setup-repo"/.test(h) && /data-mem-fold="setup-computers"/.test(h),
    'no door; the three folds, as today');
  ok(/MCP<span class="visually-hidden">/.test(h) && /data-setup-act="remove-tool" data-tool="codex"/.test(h), 'the part marks and the row trash, as today');
  ok(/Agent harnesses<\/span><span class="mem-fold-meta">4 agent harnesses · 1 to fix/.test(h), 'the fold: "Agent harnesses", "4 agent harnesses · 1 to fix"');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§4 WARNING PARITY — Pro only reveals; it never holds a warning or a fix');
/** Every fix control's signature in a markup: act + its data, or a download href. */
function fixSigs(h) {
  const out = new Set();
  for (const m of h.matchAll(/<button type="button" class="btn[^"]*" data-setup-act="([a-z-]+)"([^>]*)>/g)) {
    if (m[1] === 'tool-open' || m[1] === 'check' || m[1] === 'open-sync' || m[1] === 'check-github' || m[1] === 'change-repo' || m[1] === 'remove-tool') continue;
    const attrs = [...m[2].matchAll(/data-(path|tool|cmd)="([^"]*)"/g)].map((x) => x[1] + '=' + x[2]).join('&');
    out.add(m[1] + '?' + attrs);
  }
  for (const m of h.matchAll(/<a class="btn[^"]*" href="([^"]+)" download>/g)) out.add('download?' + m[1]);
  return out;
}
/** The loud notes' markup only (the to-fix lines Pro draws above its folds). */
const fixNotes = (h) => [...h.matchAll(/<div class="tx-note mem-ss-note mem-setup-note mem-setup-fix-note"[^>]*data-setup-fix="\d+">[\s\S]*?<\/div>/g)].map((m) => m[0]);
export function parityProblems(d) {
  const problems = [];
  const P = pro(d, { openFolds: {} });
  const L = simple(d);
  const visibleSimple = textOf(L.replace(/<details(?![^>]*\bopen\b)[\s\S]*?<\/details>/g, ''));
  for (const f of d.toFix || []) {
    if (!P.includes(String(f.text).replace(/&/g, '&amp;').replace(/</g, '&lt;')) && !textOf(P).includes(f.text)) continue;
    if (!visibleSimple.includes(textOf(f.text).trim())) problems.push('to-fix line missing with Pro off: ' + f.text);
  }
  const readers = (d.tools || []).map((t) => S.toolReaderContent(d, t.id, { pro: false }).bodyHtml).join('');
  const simpleSigs = fixSigs(L);
  const readerSigs = fixSigs(readers);
  for (const n of fixNotes(P)) {
    for (const sig of fixSigs(n)) {
      if (!simpleSigs.has(sig) && !readerSigs.has(sig)) problems.push('fix missing with Pro off: ' + sig);
    }
  }
  return problems;
}
for (const [name, mk] of ARMS) {
  const probs = parityProblems(mk());
  ok(probs.length === 0, name + ': every to-fix line and fix Pro shows is there with Pro off', probs.join(' | '));
}
{
  // The guard can fail: a payload whose harness is NOT on the list (so its
  // to-fix line is project-wide) proves the check reads the right markup…
  const d = demo();
  const bad = { ...d, toFix: [...d.toFix, { tool: 'ghost', kind: 'bridge', text: 'Ghost’s MCP entry is broken.', fixes: [{ kind: 'settings' }] }] };
  ok(parityProblems(bad).length === 0, 'control: a to-fix line for a harness not on the list stays a loud line with Pro off');
  // …and a simple render that drops a line is caught (the builder, mutated in place).
  const L = simple(d).replace('Antigravity’s my-curator skill is older than the copy this app carries', 'X');
  const visible = textOf(L);
  ok(!visible.includes(textOf(d.toFix[0].text).trim()), 'control: the parity reader really fails when the sentence is gone');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§5 the page contract and the vocabulary, both modes');
const CONTEXT_SETUP_CONTRACT = {
  name: 'Context › step 5',
  allow: [...KIT_CLASSES, 'mem-*', 'cur-setup-*', 'row-act', 'settings-block-num', 'pro-more', 'pro-more-btn', 'icon'],
  forbid: ['mcpi-*', 'cur-card'],
  foldClass: 'mem-fold',
  styleAllow: [],
  maxPrimary: 0,
  realButtons: { tiers: ['btn-secondary', 'btn-primary', 'btn-ghost'], exemptIn: [],
    exemptClasses: ['mem-hr-open', 'mem-ws-open', 'row-act', 'lb-btn'] },
};
for (const [name, mk] of ARMS) {
  for (const [mode, render] of [['Pro off', simple], ['Pro on', pro]]) {
    const v = checkPageContract(render(mk()), CONTEXT_SETUP_CONTRACT);
    ok(v.length === 0, name + ' · ' + mode + ': the page contract holds', v.join(' | '));
  }
}
ok(checkPageContract(simple(demo()).replace('class="mem-hr-act"', 'class="mem-hr-act" style="color:red"'), CONTEXT_SETUP_CONTRACT).length > 0,
  'control: an inline style is caught');
ok(checkPageContract(simple(demo()) + '<details class="other"></details>', CONTEXT_SETUP_CONTRACT).length > 0, 'control: a fold that is not the page\'s is caught');
for (const [name, mk] of ARMS) {
  for (const [mode, render] of [['Pro off', simple], ['Pro on', pro]]) {
    const d = mk();
    // The server's own sentences (setup-check.js, package D's) are taken out:
    // this is about the words THIS view writes.
    let t = textOf(render(d));
    for (const f of d.toFix || []) { t = t.split(textOf(f.text).trim()).join(''); if (f.detail) t = t.split(textOf(f.detail).trim()).join(''); }
    const bad = [];
    if (/agent apps?\b/i.test(t)) bad.push('"agent app"');
    if (/\b(?:Custom tool|Tools? that saved|Your tool|tool’s share|the tool’s)\b/i.test(t)) bad.push('"tool" for a harness');
    ok(bad.length === 0, name + ' · ' + mode + ': the vocabulary — agent harness, never agent app or tool', bad.join(', ') + ' in ' + t.slice(0, 300));
  }
}
{
  const cfg = S.setupToolPickerCfg(demo());
  ok(cfg.triggerText === '+ Add an agent harness' && cfg.options.some((o) => o.group === 'Known harnesses')
    && cfg.options[cfg.options.length - 1].label === 'Another harness…', 'the picker: "+ Add an agent harness", Known harnesses, Another harness…');
  ok(/Adds it to this list so Setup can guide you through it on this computer\. Claude Code, Antigravity, Codex and OpenCode are already on the list\./.test(cfg.footHtml),
    '...its foot says what adding does, and who is already listed (not "you connect it yourself")');
  ok(/An agent harness is the app your agent runs in — Claude Code, Codex, Cursor, Antigravity…/.test(simple(demo())) && /An agent harness is the app your agent runs in/.test(pro(demo())),
    '"agent harness" is glossed with names where the step first says it, in both modes');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§6 the harness reader');
{
  const d = demo();
  const r = S.toolReaderContent(d, 'antigravity', { pro: false });
  ok(r.typeLabel === 'agent harness' && r.returnFocusTo === 'mem-setup-tool-antigravity', 'typed "agent harness"; focus returns to its row');
  ok(/id="mem-setup-tool-antigravity"/.test(simple(d)) && /id="mem-setup-tool-antigravity"/.test(pro(d)), '...a row that exists in BOTH modes (focus never falls to <body>)');
  ok(/Skills are short instruction packs a harness loads when a task calls for them/.test(r.bodyHtml)
    && /A skill never updates itself, so an old copy can miss a rule added since\./.test(r.bodyHtml), 'step 2 says what a skill is, and why an old copy matters');
  ok(/Skills are short instruction packs/.test(pro(d)), '...and so does the Pro loud line about the stale skill');
  ok(!/maintainer/i.test(r.bodyHtml) && !/\d{4}-\d{2}-\d{2}/.test(textOf(r.bodyHtml)), 'no maintainer notes and no raw dates in the reader', textOf(r.bodyHtml).match(/.{40}(maintainer|\d{4}-\d{2}-\d{2}).{40}/));
  const cc = S.toolReaderContent(d, 'claude-code', { pro: false }).bodyHtml;
  ok(!/\d{4}-\d{2}-\d{2}T/.test(textOf(cc)) && /Newest save \d+ (?:min|minutes?|s|sec) ago/.test(textOf(cc)), 'a save\'s ISO time reads as its age', textOf(cc).match(/Newest save.{30}/));
  ok(/<details class="mem-fold mem-setup-evfold">/.test(cc) && /<details class="mem-fold mem-setup-evfold" open>/.test(S.toolReaderContent(d, 'claude-code', { pro: true }).bodyHtml),
    '"What Setup read" is closed with Pro off and open with Pro on — the readers\' one difference');
  ok(/mem-setup-guide/.test(cc) && /Connect it to The Curator/.test(cc) && /once per computer, for every project/.test(cc), 'a ready harness opens on the same four steps, each with how often it is done');
  ok(S.plainEvidenceLine('configured — observed working that way (2026-09-26)') === 'configured — observed working that way', 'plainEvidenceLine: a bare measurement date goes');
  ok(S.plainEvidenceLine('each held their own file on the maintainer\'s Mac on 2026-09-25 (observed, three separate files).')
    === 'each held their own file when The Curator was tested (observed, three separate files).', 'plainEvidenceLine: the maintainer\'s Mac becomes "when The Curator was tested"',
  S.plainEvidenceLine('each held their own file on the maintainer\'s Mac on 2026-09-25 (observed, three separate files).'));
  ok(/^Newest save 2 (?:hr|hours?) ago under/.test(S.plainEvidenceLine('Newest save ' + new Date(Date.now() - 2 * 3600e3).toISOString() + ' under “x”.')), 'plainEvidenceLine: an ISO time becomes its age',
    S.plainEvidenceLine('Newest save ' + new Date(Date.now() - 2 * 3600e3).toISOString() + ' under “x”.'));
  const ro = S.toolReaderContent(d, 'codex', { pro: false }).bodyHtml;
  ok(/data-setup-act="remove-tool" data-tool="codex">Remove from this list</.test(ro), 'Remove is in the reader with Pro off (never Pro-only)');
  ok(/id="mem-setup-gstep-mcp"/.test(ro), 'each step carries the id "Continue setup" scrolls to');
}

// ═══════════════════════════════════════════════════════════════════════════
section('§7 the hand cursor on what opens something');
{
  const css = readFileSync(join(ROOT, 'src/public/next/views/memory.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => (new RegExp('(?:^|})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm').exec(css) || [])[1] || '';
  ok(/cursor:\s*pointer/.test(rule('.mem-hr')) && /cursor:\s*pointer/.test(rule('.mem-hr-open')), 'a harness row and its button show the hand');
  ok(/cursor:\s*pointer/.test(rule('.mem-setup-row')), 'a Pro row that opens something shows the hand');
  ok(/background:\s*var\(--mat-row-hover\)/.test(rule('.mem-hr:hover')), '...and lights with the rail\'s overlay (visible in both themes, not --surface-hover)');
}

console.log('\n' + (fail ? '✗' : '✓') + ' test-context-setup-modes: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
