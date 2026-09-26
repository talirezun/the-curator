#!/usr/bin/env node
/**
 * test-next-setup-step.js — v3.77.0. Context › project › step 5 "Setup",
 * through the REAL builders in src/public/next/views/setup-step.js (DOM-free,
 * imported in plain Node), fed payloads of the shape GET
 * /api/setup/projects/:domain/:project returns.
 *
 * Exists to stop:
 *   §1 a warning behind a chevron (v3.16.1): every "to fix" line is a LOUD
 *      monitor entry OUTSIDE every fold, with its action beside it.
 *   §2 a score: the tile says "N to fix", "nothing to fix here" or "not
 *      checked" — never a percentage, never "ready".
 *   §3 a missing repository shown as red, or its form hidden in a fold.
 *   §4 a colour carrying a state alone, or a tool/computer given a colour
 *      (rule 5 — colour is a domain's): every state is a WORD with a class.
 *   §5 unescaped payload text (a hostile tool label, machine name, path).
 *   §6 the fix buttons: the right action per fix kind, a reveal path inside
 *      the repository, the copy-command text carried verbatim.
 *   §7 evidence first: "working" with its note when a save proves it.
 */
import { EXPLAINERS } from '../src/public/next/shared/explainers.js';

let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 500)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

const S = await import('../src/public/next/views/setup-step.js');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const base = () => ({
  ok: true, domain: 'projects', project: 'ott', checkedAt: iso(5000),
  repo: { path: '/Users/t/code/ott', display: '~/code/ott', source: 'set', exists: true,
    marker: { present: true, namesThis: true, line: 'projects/ott', git: { repo: true, tracked: false, uncommitted: true, unpushed: null, upstream: null } } },
  tools: [
    { id: 'claude-code', label: 'Claude Code', saved: { state: 'ok', at: iso(40 * 60e3), scope: 'claude-code', machine: 'mac-a', thisMachine: true, ownScope: true },
      bridge: { state: 'ok', word: 'working', note: 'entry not found in the files read — a save from this computer proves it works' },
      skills: { state: 'cant-check', word: 'can’t check here', note: 'held by your Claude account' },
      block: { state: 'ok', word: 'current · at the top', note: 'CLAUDE.md', files: [{ name: 'CLAUDE.md', present: true, hasBlock: true, current: true, atTop: true }] },
      hooks: { state: 'none', word: 'not wired (optional)' } },
    { id: 'antigravity', label: 'Antigravity', saved: { state: 'fix', at: iso(2 * 3600e3), scope: 'main', machine: 'mac-b', thisMachine: false, wrongScope: true },
      bridge: { state: 'ok', word: 'configured' }, skills: { state: 'fix', word: 'my-curator outdated' },
      block: { state: 'fix', word: 'missing', note: 'AGENTS.md or GEMINI.md has no Curator block', files: [{ name: 'AGENTS.md', present: true, hasBlock: false }, { name: 'GEMINI.md', present: false, hasBlock: false }] },
      hooks: { state: 'unmeasured', word: 'wired · unmeasured', evidence: { start: { at: iso(3600e3) }, stop: { at: iso(3500e3), decision: 'none' } } } },
  ],
  computers: [
    { machine: 'mac-a', thisMachine: true, tools: ['Claude Code'], newestAt: iso(40 * 60e3), curator: '3.77.0', waiting: 0 },
    { machine: 'mac-b', thisMachine: false, tools: ['Antigravity'], newestAt: iso(2 * 3600e3), curator: null, waiting: 1 },
  ],
  sync: { configured: true, lastSync: iso(38 * 60e3), pending: 1, incoming: ['projects/state/ott/antigravity/mac-b/current.md'] },
  toFix: [
    { tool: 'antigravity', kind: 'block-missing', file: 'AGENTS.md', text: 'AGENTS.md has no Curator block.', detail: 'Antigravity reads AGENTS.md or GEMINI.md, not CLAUDE.md.', fix: { kind: 'copy-block', reveal: 'AGENTS.md' } },
    { kind: 'marker-uncommitted', text: '.curator-project is not committed.', detail: 'A clone elsewhere will not know it.', fix: { kind: 'copy-command', command: 'git add .curator-project && git commit -m "Add The Curator project marker"' } },
    { kind: 'sync-incoming', text: 'A newer handoff is waiting on GitHub.', detail: 'Sync first.', fix: { kind: 'sync' } },
  ],
  addable: [{ id: 'opencode', label: 'OpenCode' }],
  repoSuggestions: [],
  machine: { ids: ['mac-a'], split: false },
});

/** Every <details …>…</details> span, so position claims are about real markup. */
function folds(html) {
  const out = [];
  const re = /<details\b[^>]*>([\s\S]*?)<\/details>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

section('§1  the to-fix lines are loud and never folded');
{
  const html = S.renderSetupBody({ data: base() }, { openFolds: {} });
  const loud = [...html.matchAll(/class="cur-mon-loud[^"]*"[^>]*>([^<]*)/g)].map((m) => m[1]);
  ok(loud.length === 3, 'one loud monitor entry per to-fix line', loud.length);
  ok(loud[0].includes('AGENTS.md has no Curator block.') && loud[0].includes('not CLAUDE.md'), '…with the reason in the same sentence', loud[0]);
  const f = folds(html);
  ok(f.length === 3, 'three folds: Tools, Repository, Computers', f.length);
  ok(f.every((x) => !x.includes('cur-mon-loud') && !x.includes('mem-setup-fix"')), 'no loud entry and no fix row is inside a fold');
  ok(/data-setup-fix="0"[\s\S]*data-setup-act="copy-block"/.test(html) && html.indexOf('data-setup-fix="0"') < html.indexOf('<details'),
    'the fix buttons sit ABOVE the folds, beside the lines');
  const clean = { ...base(), toFix: [] };
  const ok2 = S.renderSetupBody({ data: clean }, {});
  ok(/Nothing to fix on this computer/.test(ok2) && !/cur-mon-loud/.test(ok2), 'nothing to fix: said in words, no loud entry');
}

section('§2  the tile is a count, never a score');
{
  eq('3 to fix', S.setupTile(base()).value);
  ok(S.setupTile(base()).warn === true, '…marked for the attention ink');
  eq('nothing to fix here', S.setupTile({ ...base(), toFix: [] }).value);
  eq('not checked', S.setupTile({ ...base(), toFix: [], repo: null }).value);
  eq('not checked', S.setupTile(null).value);
  ok(S.setupTile(base()).sub === 'Claude Code · Antigravity · 2 computers', 'sub-line: the tools and the computers', S.setupTile(base()).sub);
  const all = JSON.stringify([S.setupTile(base()), S.setupTile({ ...base(), toFix: [] })]);
  ok(!/%|ready|score/i.test(all), 'no percentage, no "ready", no score');
}
function eq(want, got) { ok(got === want, `tile: "${want}"`, got); }

section('§3  no repository: a question, unfolded, and nothing red');
{
  const d = { ...base(), repo: null, toFix: [], repoSuggestions: [
    { root: '/Users/t/code/ott', rootDisplay: '~/code/ott', reachable: true, inGit: true },
    { root: '/Users/other/ott', rootDisplay: '/Users/other/ott', reachable: false, inGit: false },
  ] };
  // Only the repository is unknown here: the other cells are fine, so any
  // "to fix" ink on this page could only have come from the missing folder.
  d.tools = d.tools.map((t) => ({ ...t, saved: { ...t.saved, state: 'ok', wrongScope: false, scope: t.id },
    skills: { state: 'ok', word: '2 of 2 current' },
    block: { state: 'not-checked', word: 'not checked', note: 'no repository set on this computer' } }));
  d.computers = d.computers.map((c) => ({ ...c, waiting: 0 }));
  const html = S.renderSetupBody({ data: d }, {});
  ok(/Where is <strong>ott<\/strong> checked out on this computer\?/.test(html), 'the question names the project');
  ok(html.indexOf('mem-setup-repo-form') < html.indexOf('<details'), '…and it is above the folds, not inside one');
  ok(/data-setup-act="use-repo" data-path="\/Users\/t\/code\/ott"/.test(html), 'a reachable suggestion has Use');
  ok(!/data-setup-act="use-repo" data-path="\/Users\/other\/ott"/.test(html) && /recorded on another computer/.test(html), 'one recorded on another computer is shown without Use');
  ok(/macOS ask once/.test(html), 'the macOS folder-access prompt is said BEFORE the first check');
  ok(!/cur-setup-st-fix/.test(html), 'nothing on the page is inked "to fix" while no folder is set');
  const err = S.renderSetupBody({ data: d }, { repoError: 'There is no folder at ~/nope on this computer.' });
  ok(/role="alert">There is no folder at ~\/nope/.test(err), 'a refused path is said under the field');
}

section('§4  states are words; tools and computers carry no colour');
{
  const html = S.renderSetupBody({ data: base() }, { openFolds: { 'setup-tools': true, 'setup-repo': true, 'setup-computers': true } });
  ok(!/style="[^"]*(color|background)/i.test(html), 'no inline colour anywhere');
  ok(!/cur-sb-dot|identity/.test(html), 'no identity dot on a tool or a computer (rule 5)');
  const sts = [...html.matchAll(/class="cur-setup-st (cur-setup-st-[a-z]+)"[^>]*>([^<]*)</g)];
  ok(sts.length > 8 && sts.every((m) => m[2].trim().length > 0), 'every state mark carries its word', sts.filter((m) => !m[2].trim()).length);
  ok(S.stateClass('ok') === 'cur-setup-st-ok' && S.stateClass('fix') === 'cur-setup-st-fix'
    && S.stateClass('not-checked') === 'cur-setup-st-q' && S.stateClass('bogus') === 'cur-setup-st-none', 'the class map');
  ok(/as main — not its own/.test(html), 'a save under another tool\'s name says so in words');
  ok(/its own sync time is not recorded|a newer handoff is waiting on GitHub/.test(html), 'another computer: never a claimed sync time');
  ok(/not recorded/.test(html) && /3\.77\.0/.test(html), 'Curator version: shown when recorded, "not recorded" otherwise');
}

section('§5  escaping');
{
  const evil = '<img src=x onerror=alert(1)>';
  const d = base();
  d.tools[0].label = evil;
  d.computers[1].machine = evil;
  d.repo.display = evil;
  d.toFix[0].text = evil;
  const html = S.renderSetupBody({ data: d }, { openFolds: { 'setup-tools': true, 'setup-repo': true, 'setup-computers': true } })
    + S.setupHeadHtml({ data: { ...d, addable: [{ id: 'x', label: evil }] } }, true);
  ok(!html.includes('<img'), 'no payload string becomes a tag');
  ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'it is present, escaped');
}

section('§6  the fix buttons');
{
  const html = S.renderSetupBody({ data: base() }, {});
  ok(/data-setup-act="copy-block"[^>]*>Copy block for AGENTS\.md</.test(html), 'block missing → Copy block for AGENTS.md');
  ok(/data-setup-act="reveal" data-path="\/Users\/t\/code\/ott\/AGENTS\.md">Reveal AGENTS\.md/.test(html), '…and Reveal, at <repo>/AGENTS.md');
  ok(html.includes('data-cmd="git add .curator-project &amp;&amp; git commit -m &quot;Add The Curator project marker&quot;"'), 'the git command rides verbatim (escaped) on Copy command');
  ok(/data-setup-act="sync"[^>]*>Sync now</.test(html), 'a waiting handoff → Sync now');
  const head = S.setupHeadHtml({ data: base() }, true);
  ok(/data-setup-act="check"/.test(head) && /data-setup-act="add-tool" data-tool="opencode">OpenCode</.test(head), 'head: Check again, and + Add a tool listing the addable tools');
  ok(/data-age-at="[^"]+" data-age-prefix="checked"/.test(head), '…and when it was checked, as a ticking age');
  ok(/disabled/.test(S.setupHeadHtml({ data: { ...base(), addable: [] } }, false)), '+ Add a tool is disabled when nothing is left to add');
}

section('§7  evidence first');
{
  const html = S.renderSetupBody({ data: base() }, { openFolds: { 'setup-tools': true } });
  ok(/cur-setup-st-ok">working<\/span><span class="cur-setup-sub">entry not found in the files read — a save from this computer proves it works/.test(html),
    'Claude Code: "working", with the reason');
  ok(/data-age-prefix="saved"/.test(html), 'the Saved cell is a ticking age');
}

section('§8  the explainer exists and is the one the step names');
{
  ok(!!EXPLAINERS['context.setup'] && EXPLAINERS['context.setup'].title === 'Setup', 'context.setup is an explainer titled Setup');
}

console.log(`\n${failed ? '✗' : '✓'} test-next-setup-step: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
