#!/usr/bin/env node
/**
 * test-next-setup-step.js — v3.77.0; rebuilt v3.78.0. Context › project ›
 * step 5 "Setup", through the REAL builders in
 * src/public/next/views/setup-step.js (DOM-free, imported in plain Node), fed
 * payloads of the shape GET /api/setup/projects/:domain/:project returns —
 * BOTH the v3.78.0 shape (the backend contract) and the v3.77.0 shape, which
 * the step must keep painting without breaking.
 *
 * Exists to stop:
 *   §1  a warning behind a chevron (v3.16.1), or a summary card: every to-fix
 *       item is ONE loud note line OUTSIDE every fold with its own fix, and
 *       NOTHING shows when nothing is wrong.
 *   §2  a score: the tile says "N to fix", "repository not set" or "ready".
 *   §3  a missing repository shown as red, or its field hidden: a quiet note
 *       naming what was not checked, and one-click "Use <folder>".
 *   §4  a colour carrying a state alone, or an identity colour on a tool or a
 *       computer (rule 5).
 *   §5  unescaped payload text.
 *   §6  the fix buttons per kind, a v3.78.0 reveal carrying its own path.
 *   §7  the Tools table: status words, the four parts, the row opening the
 *       reader.
 *   §8  computers counted by INSTALL (two installs on one Mac are one row).
 *   §9  "+ Add a tool": the shared listbox's cfg, "Custom tool…" last, and
 *       the custom name rule.
 *   §10 a tool's evidence in the reader, with no BACKLINKS section.
 *   §11 the focus re-check's staleness rule (contract §7).
 *   §12 the head: when it was checked, ticking, and Re-check.
 *   §13 the explainer says what the approved design says it says.
 */
import { EXPLAINERS } from '../src/public/next/shared/explainers.js';

let passed = 0;
let failed = 0;
const ok = (cond, label, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail !== undefined ? `\n      ${String(detail).slice(0, 600)}` : ''}`); }
};
const section = (t) => console.log(`\n${t}`);

const S = await import('../src/public/next/views/setup-step.js');
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ALL_OPEN = { 'setup-tools': true, 'setup-repo': true, 'setup-computers': true };

// ── THE v3.77.0 SHAPE (an old server) ─────────────────────────────────────
const old = () => ({
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

// ── THE v3.78.0 SHAPE — the maintainer's own state (contract §2–§6): ONE
// MacBook with two installs (the Mac app and a source checkout, the latter
// also saved as mac-17d23c), repository not set, one folder found. ────────
const maint = () => ({
  ok: true, domain: 'projects', project: 'curator', checkedAt: iso(2 * 60e3),
  repo: null,
  repoCandidates: [{ path: '/Users/t/second-brain', display: '~/second-brain', why: 'claude-code', whyText: 'Claude Code has opened it · its .curator-project names curator' }],
  repoSuggestions: [{ root: '/Users/t/second-brain', rootDisplay: '~/second-brain', reachable: true, inGit: true }],
  tools: [
    { id: 'claude-code', label: 'Claude Code', status: 'partly',
      saved: { state: 'ok', at: iso(2 * 60e3), scope: 'claude-code', machine: 'talis-macbook-pro-acb035', thisMachine: true },
      parts: { mcp: { state: 'ok', word: 'configured' }, skills: { state: 'cant-check', word: 'can’t check here' },
        block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'none', word: 'not wired, optional' } },
      evidence: [{ heading: 'MCP', lines: ['~/.claude.json names my-curator for ~/second-brain'], reveal: '/Users/t/.claude.json' }] },
    { id: 'antigravity', label: 'Antigravity', status: 'no-save', saved: { state: 'none', at: null },
      parts: { mcp: { state: 'ok', word: 'configured' }, skills: { state: 'ok', word: 'current' },
        block: { state: 'not-checked', word: 'not checked' }, hooks: { state: 'unmeasured', word: 'wired, not seen working' } },
      evidence: [{ heading: 'MCP', lines: ['~/.gemini/antigravity/mcp_config.json is empty — another file names my-curator'] }] },
  ],
  computers: [
    { key: 'acb035', names: ['talis-macbook-pro-acb035'], primary: 'talis-macbook-pro-acb035', aliases: [], thisComputer: true, installKind: 'app', tools: ['Claude Code'], newestSaveAt: iso(2 * 60e3), curatorVersion: '3.78.0' },
    { key: '17d23c', names: ['talis-macbook-pro-17d23c', 'mac-17d23c'], primary: 'talis-macbook-pro-17d23c', aliases: ['mac-17d23c'], thisComputer: true, installKind: 'source', tools: ['Antigravity', 'Claude Code'], newestSaveAt: iso(21 * 864e5), curatorVersion: null },
  ],
  physical: [{ thisComputer: true, installs: [
    { key: 'acb035', names: ['talis-macbook-pro-acb035'], primary: 'talis-macbook-pro-acb035', aliases: [], thisComputer: true, installKind: 'app', tools: ['Claude Code'], newestSaveAt: iso(2 * 60e3), curatorVersion: '3.78.0' },
    { key: '17d23c', names: ['talis-macbook-pro-17d23c', 'mac-17d23c'], primary: 'talis-macbook-pro-17d23c', aliases: ['mac-17d23c'], thisComputer: true, installKind: 'source', tools: ['Antigravity', 'Claude Code'], newestSaveAt: iso(21 * 864e5), curatorVersion: null },
  ] }],
  counts: { toFix: 0, tools: 2, computers: 1, installs: 2, machineNames: 3 },
  sync: { configured: true, scope: 'all-domains', lastSync: iso(6 * 60e3), pending: 5, incoming: [], incomingCheckedAt: iso(4 * 60e3), incomingCapped: false },
  toFix: [],
  addable: [
    { id: 'claude-desktop', label: 'Claude Desktop', group: 'known', detail: 'MCP · skills', measured: true },
    { id: 'codex', label: 'Codex', group: 'known', detail: 'MCP · AGENTS.md', measured: true },
    { id: 'dsh', label: 'DeepSeek Harness', group: 'other', detail: 'MCP · AGENTS.md', measured: false },
    { id: '__custom', label: 'Custom tool…', group: 'other' },
  ],
  machine: { ids: ['talis-macbook-pro-acb035', 'talis-macbook-pro-17d23c', 'mac-17d23c'], split: true },
});

/** Every <details …>…</details> span, so position claims are about real markup. */
function folds(html) {
  const out = [];
  const re = /<details\b[^>]*>([\s\S]*?)<\/details>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}
const foldNamed = (html, key) => {
  const m = new RegExp('<details class="mem-fold" data-mem-fold="' + key + '"([^>]*)>([\\s\\S]*?)</details>').exec(html);
  return m ? { attrs: m[1], body: m[2] } : null;
};
const notes = (html) => [...html.matchAll(/<div class="tx-note mem-ss-note mem-setup-note[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]);
const textOf = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

section('§1  to-fix lines are loud notes, never folded — and nothing shows when nothing is wrong');
{
  const html = S.renderSetupBody({ data: old() }, { openFolds: {} });
  const fixNotes = [...html.matchAll(/class="tx-note mem-ss-note mem-setup-note mem-setup-fix-note" data-setup-fix="(\d+)"/g)];
  ok(fixNotes.length === 3, 'one note per to-fix item', fixNotes.length);
  const n0 = notes(html)[0] || '';
  ok(textOf(n0).includes('AGENTS.md has no Curator block.') && textOf(n0).includes('not CLAUDE.md'), '…the sentence and its reason in one line', textOf(n0));
  ok(/data-setup-act="copy-block"/.test(n0) && /mem-k-doors/.test(n0), '…with its own fix button beside it, in a door row', n0);
  const f = folds(html);
  ok(f.length === 3, 'three folds: Tools, Repository, Computers', f.length);
  ok(f.every((x) => !x.includes('mem-setup-fix-note')), 'no to-fix note is inside a fold');
  ok(html.indexOf('data-setup-fix="2"') < html.indexOf('<details'), 'every note sits ABOVE the first fold');
  ok(!/cur-mon|renderMonitor|mem-setup-monitor/.test(html), 'no summary card and no monitor (the approved design)');
  const clean = { ...old(), toFix: [] };
  const h2 = S.renderSetupBody({ data: clean }, {});
  ok(notes(h2).length === 0, 'NOTHING WRONG → no note at all', notes(h2).map(textOf));
  ok(!/Nothing to fix|nothing to fix/.test(h2), '…and no "nothing to fix" sentence standing in for one');
}

section('§2  the tile: ready / N to fix / repository not set — never a score');
{
  const t = (d) => S.setupTile(d);
  ok(t(old()).value === '3 to fix' && t(old()).warn === true, '"3 to fix", marked for the attention ink', JSON.stringify(t(old())));
  ok(t({ ...old(), toFix: [] }).value === 'ready', 'repository checked and nothing to fix: "ready"');
  ok(t({ ...old(), toFix: [], repo: null }).value === 'repository not set', 'no repository: "repository not set" — its checks never ran');
  ok(t({ ...old(), toFix: [], repo: { ...old().repo, exists: false } }).value === 'repository not set', 'a folder set but not on this computer: not "ready"');
  ok(t({ ...old(), repo: null }).value === '3 to fix', 'fixes found without a repository: the count wins');
  ok(t(null).value === 'not checked' && t({ ok: false }).value === 'not checked', 'no reading: "not checked"');
  ok(t(maint()).value === 'repository not set' && t(maint()).sub === 'Claude Code · Antigravity · 1 computer',
    'the maintainer: "repository not set", sub "Claude Code · Antigravity · 1 computer" (two installs, ONE computer)', JSON.stringify(t(maint())));
  ok(t(old()).sub === 'Claude Code · Antigravity · 2 computers', 'v3.77.0 shape: two machine names on two computers stay two', t(old()).sub);
  const all = JSON.stringify([t(old()), t({ ...old(), toFix: [] }), t(maint())]);
  ok(!/%|score|\d+\s*\/\s*\d+/i.test(all), 'no percentage, no fraction, no score');
}

section('§3  repository not set: a quiet note naming what was not checked, and one click to set it');
{
  const html = S.renderSetupBody({ data: maint() }, {});
  const rn = notes(html).find((n) => /repository folder is not set/.test(n)) || '';
  ok(textOf(rn).startsWith('The repository folder is not set on this computer, so CLAUDE.md, AGENTS.md and .curator-project were not checked.'),
    'the note names what did not get checked', textOf(rn));
  ok(/data-setup-act="use-repo" data-path="\/Users\/t\/second-brain">Use ~\/second-brain</.test(rn), 'exactly one folder found → "Use ~/second-brain", one click', rn);
  ok(!/mem-setup-fix-note/.test(rn) && !/cur-setup-st-fix/.test(html), 'it is not a to-fix, and nothing on the page is inked to fix');
  const two = { ...maint(), repoCandidates: [...maint().repoCandidates, { path: '/Users/t/code/curator', display: '~/code/curator', why: 'foundations' }] };
  const rn2 = notes(S.renderSetupBody({ data: two }, {})).find((n) => /not set/.test(n)) || '';
  ok(/data-setup-act="choose-repo">Choose a folder</.test(rn2) && !/use-repo/.test(rn2) && /2 folders were found/.test(textOf(rn2)),
    'several found → "Choose a folder", pointing at the Repository fold', textOf(rn2));
  const none = { ...maint(), repoCandidates: [] };
  ok(/data-setup-act="choose-repo">Set the folder</.test(S.renderSetupBody({ data: none }, {})), 'none found → "Set the folder"');
  const fold = foldNamed(html, 'setup-repo');
  ok(!!fold && /<span class="mem-fold-meta">not set · 1 folder found<\/span>/.test(html), 'fold meta: "not set · 1 folder found"');
  ok(/Found on this computer<\/th><th scope="col">Why<\/th>/.test(fold.body) && /Claude Code has opened it/.test(fold.body)
    && /data-setup-act="use-repo" data-path="\/Users\/t\/second-brain">Use this folder</.test(fold.body),
  'the fold: FOUND ON THIS COMPUTER · WHY · [Use this folder]');
  ok(/id="mem-setup-repo-input"/.test(fold.body) && /data-setup-act="save-repo">Use</.test(fold.body) && /data-setup-act="pick-repo">Choose…</.test(fold.body),
    '…then the typed field, Use and Choose…');
  ok(/Kept on this computer only, never synced\./.test(fold.body), '…and "Kept on this computer only, never synced."');
  ok(!/pick-repo/.test(S.renderSetupBody({ data: maint() }, { pickUnavailable: 'No picker here — type the path.' }))
    && /No picker here — type the path\./.test(S.renderSetupBody({ data: maint() }, { pickUnavailable: 'No picker here — type the path.' })),
  'no native picker: Choose… is withheld WITH its reason');
  ok(/ open>/.test(foldNamed(S.renderSetupBody({ data: maint() }, { forceRepoOpen: true }), 'setup-repo').attrs + '>'), '"Choose a folder" opens the fold (a transient)');
  const err = S.renderSetupBody({ data: maint() }, { repoError: 'There is no folder at ~/nope on this computer.' });
  ok(/role="alert">There is no folder at ~\/nope/.test(err), 'a refused path is said under the field');
  // A v3.77.0 server: the reachable suggestion stands in for a candidate.
  const o = { ...old(), repo: null, toFix: [], repoSuggestions: [
    { root: '/Users/t/code/ott', rootDisplay: '~/code/ott', reachable: true, inGit: true },
    { root: '/Users/other/ott', rootDisplay: '/Users/other/ott', reachable: false } ] };
  const oh = S.renderSetupBody({ data: o }, {});
  ok(/data-setup-act="use-repo" data-path="\/Users\/t\/code\/ott">Use ~\/code\/ott</.test(oh) && !/\/Users\/other\/ott/.test(oh),
    'v3.77.0 shape: the reachable suggestion becomes the one-click candidate; one on another computer is not offered');
}

section('§3b repository set: FILE · STATE · READ BY · [Reveal], and Change folder');
{
  const d = { ...old(), toFix: [] };
  d.repo.marker.git = { repo: true, tracked: true, uncommitted: false, unpushed: false, upstream: 'origin/main' };
  d.tools[1].block = { state: 'ok', word: 'current', files: [{ name: 'AGENTS.md', present: true, hasBlock: true, current: true, atTop: true }] };
  const html = S.renderSetupBody({ data: d }, { openFolds: ALL_OPEN });
  ok(/<span class="mem-fold-meta">~\/code\/ott · 3 files current<\/span>/.test(html), 'fold meta: "~/code/ott · 3 files current"');
  const body = foldNamed(html, 'setup-repo').body;
  ok(/File<\/th><th scope="col">State<\/th><th scope="col">Read by/.test(body), 'columns FILE · STATE · READ BY');
  ok(/\.curator-project[\s\S]*names ott · committed and pushed[\s\S]*agents and hooks/.test(body), '.curator-project: names the project, committed and pushed, read by agents and hooks');
  ok(/data-path="\/Users\/t\/code\/ott\/CLAUDE\.md"/.test(body) && /data-path="\/Users\/t\/code\/ott\/AGENTS\.md"/.test(body), 'each instruction file reveals at <repo>/<file>');
  ok(/data-path="\/Users\/t\/code\/ott" aria-label="Reveal \.curator-project in Finder"/.test(body), '.curator-project reveals its folder (a path the route lists)');
  ok(/data-setup-act="change-repo">Change folder</.test(body) && !/mem-setup-repo-input/.test(body), 'Change folder; no field until it is pressed');
  ok(/mem-setup-repo-input[^>]*value="\/Users\/t\/code\/ott"/.test(S.renderSetupBody({ data: d }, { editRepo: true })), '…and pressing it shows the field with the current folder');
  const bad = old();
  ok(/~\/code\/ott · 2 to fix/.test(S.renderSetupBody({ data: bad }, {})), 'an uncommitted marker and a missing block: "2 to fix" in the meta', foldNamed(S.renderSetupBody({ data: bad }, {}), 'setup-repo').attrs);
}

section('§4  states are words; tools and computers carry no identity colour');
{
  const html = S.renderSetupBody({ data: old() }, { openFolds: ALL_OPEN }) + S.renderSetupBody({ data: maint() }, { openFolds: ALL_OPEN });
  ok(!/style="[^"]*(color|background)/i.test(html), 'no inline colour anywhere');
  ok(!/cur-sb-dot|identity/.test(html), 'no identity dot on a tool or a computer (rule 5)');
  const marks = [...html.matchAll(/class="cur-setup-st (cur-setup-st-[a-z]+)">([^<]*)/g)];
  ok(marks.length > 20 && marks.every((m) => m[2].trim().length > 0), 'every state mark carries its word', marks.filter((m) => !m[2].trim()).length);
  ok(S.stateClass('ok') === 'cur-setup-st-ok' && S.stateClass('fix') === 'cur-setup-st-fix'
    && S.stateClass('not-checked') === 'cur-setup-st-q' && S.stateClass('bogus') === 'cur-setup-st-none', 'the class map');
  ok(/class="fresh-dot fresh-[a-z]+"/.test(html), 'the one dot on a row is the freshness dot — the TIME channel');
}

section('§5  escaping');
{
  const evil = '<img src=x onerror=alert(1)>';
  const d = old();
  d.tools[0].label = evil;
  d.tools[0].id = evil;
  d.computers[1].machine = evil;
  d.repo.display = evil;
  d.toFix[0].text = evil;
  d.toFix[0].fix = { kind: 'reveal', path: '/x/' + evil, label: evil };
  const m = maint();
  m.repoCandidates[0].display = evil;
  m.repoCandidates[0].whyText = evil;
  m.physical[0].installs[1].aliases = [evil];
  m.tools[0].evidence = [{ heading: evil, lines: [evil], reveal: '/x/' + evil }];
  const html = S.renderSetupBody({ data: d }, { openFolds: ALL_OPEN, customOpen: true, customDraft: evil, customError: evil })
    + S.renderSetupBody({ data: m }, { openFolds: ALL_OPEN, repoDraft: evil })
    + S.setupHeadHtml({ data: { ...d, checkedAt: evil } })
    + S.toolReaderContent(m, 'claude-code').bodyHtml + S.toolReaderContent(d, evil).bodyHtml;
  ok(!html.includes('<img'), 'no payload string becomes a tag');
  ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'it is present, escaped');
}

section('§6  the fix buttons');
{
  const html = S.renderSetupBody({ data: old() }, {});
  ok(/data-setup-act="copy-block"[^>]*>Copy block for AGENTS\.md</.test(html), 'block missing → Copy block for AGENTS.md');
  ok(/data-setup-act="reveal" data-path="\/Users\/t\/code\/ott\/AGENTS\.md">Reveal AGENTS\.md/.test(html), '…and Reveal, at <repo>/AGENTS.md');
  ok(html.includes('data-cmd="git add .curator-project &amp;&amp; git commit -m &quot;Add The Curator project marker&quot;"'), 'the git command rides verbatim (escaped) on Copy command');
  ok(/data-setup-act="sync"[^>]*>Sync now</.test(html), 'a waiting handoff → Sync now');
  // v3.78.0 (contract §1): a bridge file that cannot be read names the file,
  // says what to do, and reveals it at its own ABSOLUTE path.
  const bridge = { tool: 'antigravity', kind: 'bridge', text: 'Antigravity: ~/.gemini/antigravity/mcp_config.json is empty.',
    detail: 'Antigravity writes it on first launch — open Antigravity once, then Re-check.',
    fix: { kind: 'reveal', path: '/Users/t/.gemini/antigravity/mcp_config.json', label: 'Reveal mcp_config.json' } };
  const b = S.fixButtons(bridge, null);
  ok(/data-setup-act="reveal" data-path="\/Users\/t\/\.gemini\/antigravity\/mcp_config\.json">Reveal mcp_config\.json</.test(b), 'a contract reveal: its own absolute path and label, no repository needed', b);
  ok(/data-setup-act="settings">Open Tools on this Mac</.test(b), '…and "Open Tools on this Mac" beside it');
  const nh = S.toFixNotes({ toFix: [bridge], repo: null });
  ok(/<span class="mem-setup-inline-path">~\/\.gemini\/antigravity\/mcp_config\.json<\/span>/.test(nh), 'the file path in the sentence is set in mono', nh);
  ok(/href="\/api\/setup\/skills\/my-curator\.zip" download/.test(S.fixButtons({ fix: { kind: 'skills' } }, null)), 'outdated skills → Open Tools on this Mac and the two .zip downloads');
  ok(/data-setup-act="change-repo">Change folder</.test(S.fixButtons({ fix: { kind: 'change-repo' } }, null)), 'a folder not on this computer → Change folder');
  ok(/data-setup-act="copy-marker">Copy marker line</.test(S.fixButtons({ fix: { kind: 'copy-marker' } }, null)), 'a missing marker → Copy marker line');
}

section('§7  the Tools table');
{
  const html = S.renderSetupBody({ data: maint() }, { openFolds: ALL_OPEN });
  const body = foldNamed(html, 'setup-tools').body;
  ok(/Tool<\/th><th scope="col">Status<\/th><th scope="col">Last saved<\/th><th scope="col">Saved from<\/th><th scope="col">On this computer/.test(body),
    'columns TOOL · STATUS · LAST SAVED · SAVED FROM · ON THIS COMPUTER');
  ok(/class="mem-ws-table mem-setup-table"/.test(body) && /class="mem-ws-row"/.test(body) && /class="mem-ws-count"/.test(body), 'built from the Handoffs table\'s own parts');
  ok(/cur-setup-st-q">partly checked</.test(body) && /cur-setup-st-none">no save from here</.test(body), 'status words from the payload: partly checked, no save from here');
  ok(/talis-macbook-pro-acb035<\/span><span class="mem-ws-mine">this computer</.test(body), 'saved from this computer: the machine and the chip');
  ok(/data-setup-act="tool-open" data-tool="claude-code"/.test(body), 'a row opens the tool\'s evidence (in the reader)');
  ok(/<span class="cur-setup-st cur-setup-st-ok">MCP<span class="visually-hidden"> configured<\/span>/.test(body), 'a part that is fine: its name, the word only for a screen reader');
  ok(/<span class="mem-fold-meta">2 tools<\/span>/.test(html), 'fold meta with nothing to fix: "2 tools"');
  // Derived from a v3.77.0 row.
  const o = S.renderSetupBody({ data: old() }, { openFolds: ALL_OPEN });
  const ob = foldNamed(o, 'setup-tools').body;
  ok(/cur-setup-st-fix">1 to fix</.test(ob) && /cur-setup-st-q">partly checked</.test(ob), 'v3.77.0 shape: "1 to fix" for Antigravity, "partly checked" for Claude Code (skills can\'t check here)');
  ok(/cur-setup-st-fix">skills: my-curator outdated</.test(ob) && /cur-setup-st-fix">block: missing</.test(ob), 'a failing part shows its word');
  ok(/<span class="mem-fold-meta">2 tools · 1 to fix<\/span>/.test(o), 'fold meta: "2 tools · 1 to fix"');
  const st = (t, d) => S.toolStatus(t, d || { toFix: [] }).word;
  const base = { id: 'x', saved: { at: iso(1000), thisMachine: true }, bridge: { state: 'ok' }, skills: { state: 'ok' }, block: { state: 'ok' }, hooks: { state: 'none' } };
  ok(st(base) === 'ready', 'derived: all parts fine and a save from here → ready');
  ok(st({ ...base, saved: { at: iso(1000), thisMachine: false } }) === 'no save from here', 'derived: saved only elsewhere → no save from here');
  ok(st({ ...base, block: { state: 'not-checked' } }) === 'partly checked', 'derived: a part not checked → partly checked');
  ok(st(base, { toFix: [{ tool: 'x' }, { tool: 'x' }] }) === '2 to fix', 'derived: two to-fix lines name it → 2 to fix');
  ok(/No agent tool has saved/.test(S.renderSetupBody({ data: { ...maint(), tools: [] } }, { openFolds: ALL_OPEN })), 'no tools: said in words');
}

section('§8  computers are PHYSICAL — two installs on one Mac are one row');
{
  const html = S.renderSetupBody({ data: maint() }, { openFolds: ALL_OPEN });
  const body = foldNamed(html, 'setup-computers').body;
  const rows = [...body.matchAll(/<tr class="mem-ws-row">/g)];
  ok(rows.length === 1, 'the maintainer\'s MacBook: ONE row, not two', rows.length);
  ok(/<span class="mem-fold-meta">1 computer · 2 installs<\/span>/.test(html), 'fold meta: "1 computer · 2 installs"');
  ok(/talis-macbook-pro-acb035<\/span><span class="mem-ws-mine">this computer<\/span>/.test(body), 'named by its newest install, with the "this computer" chip');
  ok(/<span class="mem-setup-sub">Mac app · source checkout talis-macbook-pro-17d23c \(also saved as mac-17d23c\)<\/span>/.test(body),
    'its installs on a secondary line, with the second machine name', (body.match(/mem-setup-sub">[^<]*/) || [''])[0]);
  ok(/Computer<\/th><th scope="col">Tools that saved<\/th><th scope="col">Newest save<\/th><th scope="col">Curator<\/th><th scope="col">Sync/.test(body), 'columns COMPUTER · TOOLS THAT SAVED · NEWEST SAVE · CURATOR · SYNC');
  ok(/Antigravity, Claude Code/.test(body) && /3\.78\.0/.test(body), 'tools from every install; the newest install\'s Curator version');
  const t = textOf(body);
  ok(t.includes('Sync now pulls and pushes your whole knowledge folder — every domain.') && t.includes('5 files not on GitHub, across all domains.'),
    'the sync scope, said honestly', t.slice(-400));
  ok(/data-age-prefix="GitHub checked"/.test(body) && /nothing waiting there/.test(t), 'when GitHub was last checked, and what was waiting');
  const capped = { ...maint(), sync: { ...maint().sync, incoming: new Array(20).fill('x'), incomingCapped: true } };
  ok(/20 files waiting there \(first 20 files\)/.test(textOf(S.renderSetupBody({ data: capped }, {}))), 'a capped list says "(first 20 files)"');
  ok(/<div class="mem-k-doors mem-setup-doors"><button type="button" class="btn btn-secondary btn-xs" data-setup-act="sync">Sync now<\/button><button type="button" class="btn btn-ghost btn-xs" data-setup-act="open-sync">Open Sync<\/button><\/div>/.test(body),
    'buttons: Sync now (secondary) · Open Sync (ghost)');
  ok(/synced/.test(body) && /5 changes to send/.test(t), 'this computer\'s sync cell: when it synced and what it has to send');
  const nosync = S.renderSetupBody({ data: { ...maint(), sync: { configured: false } } }, { openFolds: ALL_OPEN });
  ok(/Personal Sync is not set up on this computer/.test(nosync) && !/data-setup-act="sync"/.test(foldNamed(nosync, 'setup-computers').body), 'no Personal Sync: said, and no Sync now');
  // v3.77.0 shape: every name of THIS computer is one group.
  const o = old();
  o.computers.unshift({ machine: 'mac-a2', thisMachine: true, tools: ['Antigravity'], newestAt: iso(9 * 864e5), curator: null, waiting: 0 });
  const g = S.physicalOf(o);
  ok(g.length === 2 && g[0].thisComputer && g[0].installs.length === 2 && g[0].name === 'mac-a' && !g[1].thisComputer,
    'v3.77.0 shape: this computer\'s two names are one group; another computer stays its own', JSON.stringify(g.map((x) => [x.name, x.installs.length])));
  const oc = foldNamed(S.renderSetupBody({ data: o }, { openFolds: ALL_OPEN }), 'setup-computers').body;
  ok(/cur-setup-st-fix">a newer handoff is waiting on GitHub</.test(oc), 'another computer with a handoff waiting: said, inked to fix');
  ok(S.computerCounts(maint()).computers === 1 && S.computerCounts(maint()).installs === 2, 'computerCounts: 1 computer, 2 installs');
}

section('§9  "+ Add a tool" — the shared listbox cfg, and custom tools');
{
  const cfg = S.setupToolPickerCfg(maint());
  ok(cfg.id === 'mem-setup-add' && cfg.triggerText === '+ Add a tool' && cfg.triggerClass === 'btn btn-secondary btn-xs', 'the trigger is an action: "+ Add a tool", step ③\'s button face');
  ok(JSON.stringify(cfg.options.map((o) => o.group)) === JSON.stringify(['Known tools', 'Known tools', 'Other', 'Other']), 'groups: Known tools, then Other', JSON.stringify(cfg.options));
  const last = cfg.options[cfg.options.length - 1];
  ok(last.value === S.CUSTOM_TOOL_VALUE && last.label === 'Custom tool…' && last.action === true && cfg.actionValues.includes(S.CUSTOM_TOOL_VALUE),
    '"Custom tool…" is the LAST row and an action row (declared in the cfg too)');
  ok(cfg.options.find((o) => o.value === 'dsh').detail === 'config location not measured', 'an adapter whose config location is not measured says so');
  ok(cfg.options.find((o) => o.value === 'codex').detail === 'MCP · AGENTS.md', 'a known tool carries its detail');
  const oc = S.setupToolPickerCfg(old());
  ok(oc.options.length === 1 && oc.options[0].group === 'Known tools' && !oc.options.some((o) => o.action) && oc.actionValues.length === 0,
    'v3.77.0 shape: one known tool, NO custom row (that server would refuse it)');
  ok(S.setupToolPickerCfg({ ...old(), addable: [] }).disabled === true, 'nothing to add: disabled');
  ok(S.setupToolPickerCfg(maint(), true).disabled === true && S.setupToolPickerCfg(maint(), true).triggerText === 'Adding…', 'while adding: disabled, "Adding…"');
  ok(S.customToolNameError('My Harness 2.0') === null && S.customToolNameError('a_b-c.d') === null, 'a good name passes');
  ok(!!S.customToolNameError('') && !!S.customToolNameError('   ') && !!S.customToolNameError('x'.repeat(41))
    && !!S.customToolNameError('bad/name') && !!S.customToolNameError('<b>'), 'empty, too long and bad characters are refused before sending');
  ok(S.CUSTOM_TOOL_RE.test('x'.repeat(40)) && !S.CUSTOM_TOOL_RE.test('x'.repeat(41)), 'the rule is 1–40 characters, the route\'s');
  const f = S.renderSetupBody({ data: maint() }, { customOpen: true, customError: 'Use letters…' });
  ok(/id="mem-setup-custom-input"/.test(f) && /data-setup-act="add-custom">Add</.test(f) && /role="alert">Use letters…</.test(f), 'the inline name field, Add, and a refusal under it');
  ok(/<div class="mem-k-pick mem-setup-pick">PICKER<\/div>/.test(S.renderSetupBody({ data: maint() }, { pickerHtml: 'PICKER' })), 'the picker sits in step ③\'s picker row');
}

section('§10 a tool\'s evidence, in the reader');
{
  const r = S.toolReaderContent(maint(), 'claude-code');
  ok(r && r.hideBacklinks === true, 'no BACKLINKS section (a tool is not a wiki page)');
  ok(r.title === 'Claude Code' && r.returnFocusTo === 'mem-setup-tool-claude-code', 'titled by the tool; focus returns to its row');
  ok(/<h3 class="mem-setup-ev-h">MCP<\/h3>/.test(r.bodyHtml) && /data-setup-act="reveal" data-path="\/Users\/t\/\.claude\.json">Reveal \.claude\.json/.test(r.bodyHtml),
    'the payload\'s evidence, with its reveal button');
  ok(/cur-setup-st-q">partly checked</.test(r.bodyHtml), 'the status word at the top');
  const o = S.toolReaderContent(old(), 'antigravity');
  ok(/AGENTS\.md has no Curator block/.test(o.bodyHtml) && /data-setup-act="copy-block"/.test(o.bodyHtml), 'v3.77.0 shape: the tool\'s own to-fix lines with their fixes');
  ok(/<h3 class="mem-setup-ev-h">Hooks<\/h3>/.test(o.bodyHtml) && /stop hook seen/.test(o.bodyHtml) && /as main — not its own name/.test(o.bodyHtml),
    '…and evidence built from its cells (the save, the hooks)');
  const custom = { ...maint(), tools: [{ id: 'my-harness', label: 'My Harness', custom: true, status: 'no-save', saved: { at: null },
    mcpSnippet: { format: 'json', text: '{"mcpServers":{"my-curator":{}}}' }, instructionFile: 'AGENTS.md' }] };
  const c = S.toolReaderContent(custom, 'my-harness').bodyHtml;
  ok(/<pre class="mem-setup-snippet"><code>\{&quot;mcpServers&quot;/.test(c) && /data-setup-act="copy-snippet" data-tool="my-harness">Copy entry</.test(c), 'a custom tool: its MCP entry to copy');
  ok(/reads AGENTS\.md/.test(c) && /Copy block for AGENTS\.md/.test(c), '…the AGENTS.md hint with Copy block');
  ok(/my-curator\.zip/.test(c) && /curator-continuity\.zip/.test(c), '…the skills .zip links');
  ok(/data-setup-act="remove-custom" data-name="My Harness">Remove My Harness</.test(c), '…and Remove');
  const dsh = { ...maint(), tools: [{ id: 'dsh', label: 'DeepSeek Harness', status: 'no-save', saved: { at: null }, mcpSnippet: { format: 'yaml', text: 'plugins:\n  - my-curator' } }] };
  ok(/Paste into ~\/\.dsh\/cordis\.patch\.yml \(merge — do not copy over the file\); never cordis\.yml\./.test(S.toolReaderContent(dsh, 'dsh').bodyHtml),
    'dsh (contract amendment A1): paste into ~/.dsh/cordis.patch.yml, merge, never cordis.yml');
  const unm = { ...maint(), tools: [{ id: 'goose', label: 'goose', measured: false, status: 'no-save', saved: { at: null }, mcpSnippet: { format: 'json', text: '{}' } }] };
  ok(/Config location not measured — copy the entry by hand/.test(S.toolReaderContent(unm, 'goose').bodyHtml), 'an unmeasured config location: "config location not measured — copy the entry by hand"');
  // Amendment A2: a known tool whose MCP is fine is not handed an entry to paste.
  const known = { ...maint(), tools: [{ ...maint().tools[0], mcpSnippet: { format: 'json', text: '{"x":1}' } }] };
  ok(!/mem-setup-snippet/.test(S.toolReaderContent(known, 'claude-code').bodyHtml), 'a known tool with MCP configured: no entry to paste');
  const savedOnly = { ...maint(), tools: [{ id: 'mystery', label: 'Mystery', custom: true, userAdded: false, status: 'partly', saved: { at: iso(1000) } }] };
  ok(!/remove-custom/.test(S.toolReaderContent(savedOnly, 'mystery').bodyHtml), 'a saved-only unknown tool (not on this computer\'s list) offers no Remove');
  const zipped = { ...custom, tools: [{ ...custom.tools[0], skillZips: [{ name: 'my-curator.zip', href: '/api/setup/skills/my-curator.zip' }, { name: 'evil', href: 'https://x.test/a.zip' }] }] };
  const zb = S.toolReaderContent(zipped, 'my-harness').bodyHtml;
  ok(/href="\/api\/setup\/skills\/my-curator\.zip"/.test(zb) && !/x\.test/.test(zb), 'skillZips from the payload, only this app\'s own /api/setup/skills/ links');
  ok(S.toolReaderContent(maint(), 'nope') === null, 'an unknown tool: nothing to open');
}

section('§11 the focus re-check (contract §7)');
{
  const now = Date.now();
  ok(S.SETUP_RECHECK_AFTER_MS === 10000, 'ten seconds');
  ok(S.setupCheckIsStale({ checkedAt: new Date(now - 11000).toISOString() }, now) === true, 'an 11-second-old reading is re-read');
  ok(S.setupCheckIsStale({ checkedAt: new Date(now - 3000).toISOString() }, now) === false, 'a 3-second-old one is not');
  ok(S.setupCheckIsStale({}, now) === true && S.setupCheckIsStale(null, now) === true, 'no stamp: re-read');
}

section('§12 the head');
{
  const h = S.setupHeadHtml({ data: maint() });
  ok(/class="mem-setup-checked" data-age-at="[^"]+" data-age-prefix="checked" data-age-text>checked 2 min ago</.test(h), '"checked 2 min ago", a ticking age', h);
  ok(/class="btn btn-ghost btn-xs" data-setup-act="check">Re-check</.test(h), 'a ghost "Re-check"');
  ok(/disabled>Checking…</.test(S.setupHeadHtml({ data: maint(), loading: true })), 'while checking: disabled, "Checking…"');
  ok(!/Add a tool/.test(h), '"+ Add a tool" is not in the head any more (it is the body\'s picker row)');
  ok(/Checking this computer…/.test(S.renderSetupBody({ loading: true }, {})) && /role="alert">Could not check this computer: boom/.test(S.renderSetupBody({ error: 'boom' }, {})),
    'first check in flight, and a first check that failed');
  ok(/The last re-check did not finish: boom/.test(S.renderSetupBody({ data: maint(), error: 'boom' }, {})), 'a failed RE-check keeps the reading and says so');
}

section('§13 the explainer');
{
  const e = EXPLAINERS['context.setup'];
  ok(!!e && e.title === 'Setup', 'context.setup is an explainer titled Setup');
  const all = [e.lead, ...(e.points || []).map((p) => p.text), e.try || '', ...((e.visual && e.visual.rows) || []).flat()].join(' ');
  ok(/\*\*Re-check\*\* reads the files; tools needn’t run/.test(all), 'Re-check reads the files again; the tools need not be running');
  ok(/code checkout, not your knowledge folder; set per computer/.test(all), 'the repository: a code checkout, separate from the knowledge folder, per computer');
  ok(/two installs on one Mac count once/.test(all), 'Computers: installs on one Mac are grouped');
  ok(/whole knowledge folder, every domain/.test(all), 'Sync now syncs the whole knowledge folder');
  ok(/\*\*Custom tool…\*\*/.test(all), 'custom tools');
  ok(JSON.stringify(e.visual.rows.map((r) => r[0])) === JSON.stringify(['ready', 'to fix', 'can’t check here', 'not checked']), 'what each state means: ready · to fix · can’t check here · not checked');
  const ov = EXPLAINERS['context.overview'];
  ok(/^Six readings/.test(ov.lead) && ov.visual.rows.some((r) => r[0] === 'SETUP'), 'the overview explainer counts SIX readings and names SETUP');
}

console.log(`\n${failed ? '✗' : '✓'} test-next-setup-step: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
